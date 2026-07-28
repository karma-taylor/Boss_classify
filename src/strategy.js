import { advanceApplicationStatus, ensureApplication, insertReplyEventIfFirst, setApplicationStatus, setManualApplicationStatus } from "./db.js";
import { REPLY_INTENTS } from "./intents.js";
import { eventTypeForReplyIntent } from "./messageClassifier.js";

const POSITIVE_INTENTS = new Map([
  [REPLY_INTENTS.INTERVIEW, { status: "interview", weight: 0.1 }],
  [REPLY_INTENTS.RESUME_REQUEST, { status: "interested", weight: 0.07 }],
  [REPLY_INTENTS.WECHAT, { status: "interested", weight: 0.05 }]
]);

const NEGATIVE_INTENTS = new Map([
  [REPLY_INTENTS.REJECT_EXPERIENCE, -0.08],
  [REPLY_INTENTS.REJECT_DIRECTION, -0.08],
  [REPLY_INTENTS.REJECT_LOCATION, -0.06]
]);

export function buildTomorrowPlan(db, options = {}) {
  markStaleNoResponses(db, Number(options.noResponseDays || 5));
  const planDate = options.planDate || tomorrowKey();
  const limit = Math.max(1, Number(options.limit || 20));
  const preferences = normalizePreferences(options);
  const explorationCount = Math.max(1, Math.round(limit * 0.2));
  const exploitationCount = Math.max(0, limit - explorationCount);

  const candidates = db.prepare(`
    SELECT j.*, a.status AS application_status
    FROM jobs j
    JOIN applications a ON a.job_id = j.id
    WHERE a.status IN ('queued', 'paused')
      AND j.status NOT IN ('ignored', 'applied', 'interview', 'interested', 'rejected')
      AND j.job_tier <> 'C'
    ORDER BY j.updated_at DESC
    LIMIT 200
  `).all();

  const scored = candidates.map((job) => scoreJob(db, job, preferences));
  const exploitation = scored
    .filter((item) => item.dynamic_adjustment > 0)
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, exploitationCount);
  const used = new Set(exploitation.map((item) => item.id));
  const exploration = scored
    .filter((item) => !used.has(item.id))
    .sort((a, b) => b.base_score - a.base_score)
    .slice(0, explorationCount);
  const plan = [...exploitation, ...exploration]
    .slice(0, limit)
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      plan_type: used.has(item.id) ? "exploitation" : "exploration"
    }));

  const insert = db.prepare(`
    INSERT INTO daily_plans (plan_date, job_id, rank, plan_type, base_score, dynamic_adjustment, final_score, reason)
    VALUES (@plan_date, @job_id, @rank, @plan_type, @base_score, @dynamic_adjustment, @final_score, @reason)
    ON CONFLICT(plan_date, job_id) DO UPDATE SET
      rank = excluded.rank,
      plan_type = excluded.plan_type,
      base_score = excluded.base_score,
      dynamic_adjustment = excluded.dynamic_adjustment,
      final_score = excluded.final_score,
      reason = excluded.reason
  `);
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM daily_plans WHERE plan_date = ?").run(planDate);
    for (const item of plan) {
      insert.run({
        plan_date: planDate,
        job_id: item.id,
        rank: item.rank,
        plan_type: item.plan_type,
        base_score: item.base_score,
        dynamic_adjustment: item.dynamic_adjustment,
        final_score: item.final_score,
        reason: item.reason
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getPlan(db, planDate);
}

export function getPlan(db, planDate = tomorrowKey()) {
  return db.prepare(`
    SELECT p.*, j.title, j.company, j.salary, j.location, j.source_url, j.match_score, j.job_tier
    FROM daily_plans p
    JOIN jobs j ON j.id = p.job_id
    WHERE p.plan_date = ?
    ORDER BY p.rank ASC
  `).all(planDate);
}

export function applyMessageAnalysis(db, applicationId, analysis) {
  const app = db.prepare("SELECT * FROM applications WHERE id = ?").get(applicationId);
  if (Number(app?.manual_status_override || 0) === 1) return app;
  if (!app) throw new Error("投递记录不存在。");

  const intent = String(analysis.intent || REPLY_INTENTS.NO_EFFECTIVE_FEEDBACK);
  const positive = POSITIVE_INTENTS.get(intent);
  const negative = NEGATIVE_INTENTS.get(intent);
  let status = app.status;
  if (positive) status = positive.status;
  if (negative) status = "rejected";

  const replyTime = analysis.last_message_at || null;
  const timePrecision = replyTime ? "exact" : "unknown";
  const updateFields = {
    feedback_intent: intent,
    feedback_reason: analysis.reason || "",
    first_replied_at: replyTime ? app.first_replied_at || replyTime : null,
    last_replied_at: replyTime,
    last_message_text: analysis.last_message_text || "",
    clear_reply_handled: Boolean(analysis.clear_reply_handled ?? true)
  };

  if (intent === REPLY_INTENTS.RESUME_REQUEST) {
    updateFields.resume_request_at = app.resume_request_at || replyTime;
    updateFields.interested_at = app.interested_at || replyTime;
  } else if (intent === REPLY_INTENTS.WECHAT) {
    updateFields.interested_at = app.interested_at || replyTime;
  } else if (intent === REPLY_INTENTS.INTERVIEW) {
    updateFields.interview_at = app.interview_at || replyTime;
    updateFields.interested_at = app.interested_at || replyTime;
  } else if (negative) {
    updateFields.rejected_at = app.rejected_at || replyTime;
  }

  if (positive) {
    advanceApplicationStatus(db, app.job_id, status, { ...updateFields, time_precision: timePrecision });
  } else if (negative && !["interested", "interview"].includes(app.status)) {
    setApplicationStatus(db, app.job_id, status, updateFields);
  } else {
    setApplicationStatus(db, app.job_id, app.status, updateFields);
  }

  if (positive || negative) {
    const weight = positive ? positive.weight : negative;
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(app.job_id);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO feedback_signals (application_id, signal_type, signal_key, weight, source_intent)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run(applicationId, "intent", intent, clampDynamic(weight), intent);
    for (const keyword of extractKeywords(job).slice(0, 8)) {
      insert.run(applicationId, keyword.type, keyword.value, clampDynamic(weight / 2), intent);
    }
  }

  return db.prepare("SELECT * FROM applications WHERE id = ?").get(applicationId);
}

export function overrideReplyIntent(db, applicationId, intent, reason = "manual override") {
  const app = db.prepare("SELECT * FROM applications WHERE id = ?").get(applicationId);
  if (!app) throw new Error("application_not_found");
  const now = new Date().toISOString();
  const positive = POSITIVE_INTENTS.get(intent);
  const negative = NEGATIVE_INTENTS.get(intent);
  const status = positive?.status || (negative ? "rejected" : app.status);
  const updated = setManualApplicationStatus(db, app.job_id, status, {
    feedback_intent: intent,
    feedback_reason: reason,
    last_replied_at: now,
    interested_at: status === "interested" || status === "interview" ? now : null,
    interview_at: status === "interview" ? now : null,
    rejected_at: status === "rejected" ? now : null,
    manual_override_reason: reason
  });
  const eventType = eventTypeForReplyIntent(intent);
  if (eventType) {
    insertReplyEventIfFirst(db, {
      application_id: app.id,
      event_type: eventType,
      occurred_at: now,
      time_precision: "exact",
      classification_basis: reason
    });
  }
  return updated;
}

export function markStaleNoResponses(db, noResponseDays = 5) {
  db.prepare(`
    UPDATE applications
    SET status = 'no_response', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'applied'
      AND applied_at IS NOT NULL
      AND datetime(applied_at) <= datetime('now', ?)
  `).run(`-${noResponseDays} days`);
}

export function scoreJob(db, job, preferences = {}) {
  const locationFit = getLocationFit(job, preferences.preferred_locations || []);
  const baseScore = normalizeBaseScore(job, locationFit);
  const adjustment = clampDynamic(dynamicAdjustment(db, job));
  const finalScore = Math.round(baseScore * (1 + adjustment));
  const reasonParts = [];
  if (locationFit > 0) reasonParts.push("命中倾向工作地点");
  if (locationFit < 0) reasonParts.push("未命中倾向工作地点");
  if (adjustment > 0) reasonParts.push("与近期正反馈方向相近");
  if (adjustment < 0) reasonParts.push("命中过往负反馈信号");
  if (!reasonParts.length) reasonParts.push("作为探索型岗位保留");
  return {
    id: job.id,
    job_id: job.id,
    base_score: baseScore,
    dynamic_adjustment: adjustment,
    final_score: Math.max(0, Math.min(100, finalScore)),
    reason: reasonParts.join(";")
  };
}

function normalizeBaseScore(job, locationFit = 0) {
  const score = Number(job.match_score || 0);
  let base = 60;
  if (Number.isFinite(score) && score > 0) base = Math.round(score);
  else if (job.job_tier === "A") base = 82;
  else if (job.job_tier === "B") base = 68;
  return Math.max(0, Math.min(100, base + locationFit));
}

function dynamicAdjustment(db, job) {
  const signals = db.prepare(`
    SELECT signal_key, weight FROM feedback_signals
    WHERE created_at >= datetime('now', '-30 days')
  `).all();
  const text = `${job.title} ${job.company} ${job.jd_text}`.toLowerCase();
  return signals.reduce((sum, signal) => {
    const key = String(signal.signal_key || "").toLowerCase();
    if (!key) return sum;
    return text.includes(key) ? sum + Number(signal.weight || 0) : sum;
  }, 0);
}

function clampDynamic(value) {
  return Math.max(-0.1, Math.min(0.1, Number(value || 0)));
}

function extractKeywords(job) {
  const parts = [];
  for (const value of [job?.title, job?.company]) {
    for (const token of String(value || "")
      .split(/[\s/、,·]+/)
      .map((item) => item.trim())
      .filter(Boolean)) {
      if (token.length >= 2) parts.push({ type: "keyword", value: token });
    }
  }
  return parts;
}

function normalizePreferences(options) {
  const locations = Array.isArray(options.preferred_locations)
    ? options.preferred_locations
    : String(options.preferred_locations || "").split(/[,,、\s]+/);
  return {
    preferred_locations: locations
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 10)
  };
}

function getLocationFit(job, preferredLocations) {
  if (!preferredLocations.length) return 0;
  const text = `${job.location || ""} ${job.jd_text || ""}`.toLowerCase();
  const matched = preferredLocations.some((location) => text.includes(location.toLowerCase()));
  return matched ? 5 : -3;
}

function tomorrowKey() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

export { ensureApplication };
