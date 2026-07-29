import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { normalizeBossJob } from "./bossText.js";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "workbench.db");
const CONTACT_ANCHOR_SQL = "COALESCE(applied_at, first_replied_at)";

export function openDb(dbPath = process.env.WORKBENCH_DB || DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'boss',
      source_url TEXT NOT NULL UNIQUE,
      company TEXT NOT NULL DEFAULT '',
      company_size TEXT NOT NULL DEFAULT '',
      company_kind TEXT NOT NULL DEFAULT 'unknown',
      company_size_source TEXT NOT NULL DEFAULT 'unverified',
      title TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      salary TEXT NOT NULL DEFAULT '',
      jd_text TEXT NOT NULL DEFAULT '',
      jd_hash TEXT NOT NULL DEFAULT '',
      match_report_json TEXT,
      match_score REAL DEFAULT 0,
      job_tier TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      source_kind TEXT NOT NULL DEFAULT 'manual_apply',
      search_batch_id TEXT NOT NULL DEFAULT '',
      supplement_reason TEXT NOT NULL DEFAULT '',
      reply_rate_eligible INTEGER NOT NULL DEFAULT 1,
      contact_anchor_at TEXT,
      manual_status_override INTEGER NOT NULL DEFAULT 0,
      manual_override_at TEXT,
      manual_override_reason TEXT NOT NULL DEFAULT '',
      history_data_state TEXT NOT NULL DEFAULT 'current',
      applied_at TEXT,
      first_seen_at TEXT,
      first_replied_at TEXT,
      last_replied_at TEXT,
      interested_at TEXT,
      resume_request_at TEXT,
      interview_at TEXT,
      rejected_at TEXT,
      reply_handled_at TEXT,
      feedback_intent TEXT,
      feedback_reason TEXT,
      last_message_text TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(job_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
      conversation_key TEXT NOT NULL DEFAULT '',
      message_key TEXT NOT NULL DEFAULT '',
      message_hash TEXT NOT NULL DEFAULT '',
      native_message_id TEXT NOT NULL DEFAULT '',
      message_order INTEGER,
      time_precision TEXT NOT NULL DEFAULT 'unknown',
      dedupe_key TEXT NOT NULL DEFAULT '',
      sync_run_id INTEGER REFERENCES history_sync_runs(id) ON DELETE SET NULL,
      direction TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      sent_at TEXT,
      analyzed_at TEXT,
      analysis_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS feedback_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
      signal_type TEXT NOT NULL,
      signal_key TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0,
      source_intent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_date TEXT NOT NULL,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      plan_type TEXT NOT NULL,
      base_score REAL NOT NULL,
      dynamic_adjustment REAL NOT NULL,
      final_score REAL NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(plan_date, job_id)
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS collection_filter_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_batch_id TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      salary TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      reason_details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(search_batch_id, entry_key)
    );
    CREATE INDEX IF NOT EXISTS idx_collection_filter_logs_batch
      ON collection_filter_logs(search_batch_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS history_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      range_start TEXT,
      range_end TEXT,
      scanned_conversations INTEGER NOT NULL DEFAULT 0,
      new_messages INTEGER NOT NULL DEFAULT 0,
      matched_count INTEGER NOT NULL DEFAULT 0,
      supplemented_count INTEGER NOT NULL DEFAULT 0,
      classified_count INTEGER NOT NULL DEFAULT 0,
      stopped_reason TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS daily_metrics (
      metric_date TEXT PRIMARY KEY,
      read_count INTEGER NOT NULL DEFAULT 0,
      recommended_count INTEGER NOT NULL DEFAULT 0,
      applied_count INTEGER NOT NULL DEFAULT 0,
      reply_count INTEGER NOT NULL DEFAULT 0,
      resume_request_count INTEGER NOT NULL DEFAULT 0,
      interview_count INTEGER NOT NULL DEFAULT 0,
      positive_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS application_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      schema_version TEXT NOT NULL,
      package_hash TEXT NOT NULL,
      job_description TEXT NOT NULL,
      assessment_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, package_hash)
    );

    CREATE TABLE IF NOT EXISTS application_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      artifact_kind TEXT NOT NULL,
      label TEXT NOT NULL,
      local_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, artifact_kind, local_path)
    );

    CREATE TABLE IF NOT EXISTS reply_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('resume_request', 'process_progress', 'wechat_contact', 'interview', 'rejected')),
      occurred_at TEXT,
      contact_anchor_at TEXT,
      time_precision TEXT NOT NULL DEFAULT 'unknown' CHECK(time_precision IN ('exact', 'unknown')),
      classification_basis TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, event_type)
    );

    CREATE TABLE IF NOT EXISTS conversation_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL UNIQUE,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL DEFAULT '',
      binding_kind TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS unlinked_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL UNIQUE,
      source_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      last_message_text TEXT NOT NULL DEFAULT '',
      first_observed_at TEXT,
      last_observed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS history_cleanup_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      candidate_delete_count INTEGER NOT NULL DEFAULT 0,
      deleted_count INTEGER NOT NULL DEFAULT 0,
      isolated_count INTEGER NOT NULL DEFAULT 0,
      preserved_manual_count INTEGER NOT NULL DEFAULT 0,
      foreign_key_violations INTEGER NOT NULL DEFAULT 0,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

  `);

  addColumnIfMissing(db, "jobs", "company_size", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "collection_filter_logs", "reason_details_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "jobs", "company_kind", "TEXT NOT NULL DEFAULT 'unknown'");
  addColumnIfMissing(db, "jobs", "company_size_source", "TEXT NOT NULL DEFAULT 'unverified'");
  // Legacy list-card extraction cannot distinguish job text from company data.
  db.prepare("UPDATE jobs SET company_size = '' WHERE company_size_source = 'unverified'").run();
  addColumnIfMissing(db, "applications", "source_kind", "TEXT NOT NULL DEFAULT 'manual_apply'");
  addColumnIfMissing(db, "applications", "search_batch_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "applications", "supplement_reason", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "applications", "reply_rate_eligible", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "applications", "contact_anchor_at", "TEXT");
  addColumnIfMissing(db, "applications", "manual_status_override", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "applications", "manual_override_at", "TEXT");
  addColumnIfMissing(db, "applications", "manual_override_reason", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "applications", "history_data_state", "TEXT NOT NULL DEFAULT 'current'");
  addColumnIfMissing(db, "applications", "first_seen_at", "TEXT");
  addColumnIfMissing(db, "applications", "first_replied_at", "TEXT");
  addColumnIfMissing(db, "applications", "last_replied_at", "TEXT");
  addColumnIfMissing(db, "applications", "interested_at", "TEXT");
  addColumnIfMissing(db, "applications", "resume_request_at", "TEXT");
  addColumnIfMissing(db, "applications", "interview_at", "TEXT");
  addColumnIfMissing(db, "applications", "rejected_at", "TEXT");
  addColumnIfMissing(db, "applications", "reply_handled_at", "TEXT");
  addColumnIfMissing(db, "applications", "last_message_text", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "messages", "conversation_key", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "messages", "message_key", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "messages", "message_hash", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "messages", "native_message_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "messages", "message_order", "INTEGER");
  addColumnIfMissing(db, "messages", "time_precision", "TEXT NOT NULL DEFAULT 'unknown'");
  addColumnIfMissing(db, "messages", "dedupe_key", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "messages", "sync_run_id", "INTEGER");
  addColumnIfMissing(db, "messages", "direction", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "messages", "source_url", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "daily_metrics", "read_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "daily_metrics", "recommended_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "daily_metrics", "reply_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "daily_metrics", "resume_request_count", "INTEGER NOT NULL DEFAULT 0");
  rebuildMessagesForNullableTimestamp(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_hash ON jobs(jd_hash);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_applications_source_kind ON applications(source_kind);
    CREATE INDEX IF NOT EXISTS idx_applications_search_batch_id ON applications(search_batch_id);
    CREATE INDEX IF NOT EXISTS idx_applications_reply_rate_eligible ON applications(reply_rate_eligible);
    CREATE INDEX IF NOT EXISTS idx_applications_contact_anchor_at ON applications(contact_anchor_at);
    CREATE INDEX IF NOT EXISTS idx_applications_history_data_state ON applications(history_data_state);
    CREATE INDEX IF NOT EXISTS idx_applications_applied_at ON applications(applied_at);
    CREATE INDEX IF NOT EXISTS idx_applications_first_replied_at ON applications(first_replied_at);
    CREATE INDEX IF NOT EXISTS idx_applications_last_replied_at ON applications(last_replied_at);
    CREATE INDEX IF NOT EXISTS idx_applications_resume_request_at ON applications(resume_request_at);
    CREATE INDEX IF NOT EXISTS idx_applications_interview_at ON applications(interview_at);
    CREATE INDEX IF NOT EXISTS idx_applications_interested_at ON applications(interested_at);
    CREATE INDEX IF NOT EXISTS idx_applications_first_seen_at ON applications(first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_applications_applied_eligible ON applications(applied_at, reply_rate_eligible);
    CREATE INDEX IF NOT EXISTS idx_applications_first_reply_source_kind ON applications(first_replied_at, source_kind);
    CREATE INDEX IF NOT EXISTS idx_applications_reply_source_kind ON applications(last_replied_at, source_kind);
    CREATE INDEX IF NOT EXISTS idx_messages_application_id ON messages(application_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_key ON messages(conversation_key);
    CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(message_hash);
    CREATE INDEX IF NOT EXISTS idx_messages_native_id ON messages(conversation_key, native_message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_dedupe_key ON messages(dedupe_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_native_id_unique
      ON messages(conversation_key, native_message_id)
      WHERE native_message_id <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe_key_unique
      ON messages(dedupe_key)
      WHERE dedupe_key <> '';
    CREATE INDEX IF NOT EXISTS idx_reply_events_application ON reply_events(application_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_reply_events_occurred_at ON reply_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_bindings_application ON conversation_bindings(application_id);
    CREATE INDEX IF NOT EXISTS idx_unlinked_conversations_status ON unlinked_conversations(status);
    CREATE INDEX IF NOT EXISTS idx_daily_plans_date ON daily_plans(plan_date);
    CREATE INDEX IF NOT EXISTS idx_history_runs_started_at ON history_sync_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_handoffs_application_id ON application_handoffs(application_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_application_id ON application_artifacts(application_id);
  `);

  db.exec(`
    DELETE FROM feedback_signals
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM feedback_signals
      GROUP BY application_id, signal_type, signal_key, source_intent
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_signals_unique
      ON feedback_signals(application_id, signal_type, signal_key, source_intent);
  `);

  db.prepare(`
    UPDATE applications
    SET source_kind = CASE
      WHEN source_kind IS NULL OR source_kind = '' THEN 'manual_apply'
      ELSE source_kind
    END,
    reply_rate_eligible = CASE
      WHEN source_kind = 'auto_supplement' THEN 0
      WHEN reply_rate_eligible IS NULL THEN 1
      ELSE reply_rate_eligible
    END,
    first_seen_at = COALESCE(first_seen_at, created_at)
  `).run();

  db.prepare(`
    UPDATE applications
    SET contact_anchor_at = COALESCE(contact_anchor_at, applied_at, first_replied_at),
        history_data_state = CASE
          WHEN history_data_state IS NULL OR history_data_state = '' THEN 'current'
          ELSE history_data_state
        END,
        manual_status_override = COALESCE(manual_status_override, 0)
  `).run();

  db.prepare(`
    UPDATE applications
    SET first_replied_at = COALESCE(first_replied_at, last_replied_at)
    WHERE first_replied_at IS NULL
      AND last_replied_at IS NOT NULL
  `).run();
}

export function upsertJob(db, job, options = {}) {
  const normalized = normalizeBossJob(job);
  const row = {
    source_url: normalized.source_url,
    company: normalized.company || "",
    company_size: normalized.company_size || "",
    company_kind: normalized.company_kind === "hunter" ? "hunter" : normalized.company_kind === "company" ? "company" : "unknown",
    company_size_source: normalized.company_size_source || "unverified",
    title: normalized.title || "",
    location: normalized.location || "",
    salary: normalized.salary || "",
    jd_text: normalized.jd_text || "",
    jd_hash: normalized.jd_hash || hashText(normalized.jd_text || normalized.source_url)
  };
  db.prepare(`
    INSERT INTO jobs (source_url, company, company_size, company_kind, company_size_source, title, location, salary, jd_text, jd_hash)
    VALUES (@source_url, @company, @company_size, @company_kind, @company_size_source, @title, @location, @salary, @jd_text, @jd_hash)
    ON CONFLICT(source_url) DO UPDATE SET
      company = excluded.company,
      company_size = excluded.company_size,
      company_kind = excluded.company_kind,
      company_size_source = excluded.company_size_source,
      title = excluded.title,
      location = excluded.location,
      salary = excluded.salary,
      jd_text = excluded.jd_text,
      jd_hash = excluded.jd_hash,
      updated_at = CURRENT_TIMESTAMP
  `).run(row);
  const saved = db.prepare("SELECT * FROM jobs WHERE source_url = ?").get(row.source_url);
  if (options.ensureApplication !== false) ensureApplication(db, saved.id);
  return saved;
}

export function normalizeStoredJobs(db) {
  const rows = db.prepare("SELECT * FROM jobs").all();
  const update = db.prepare(`
    UPDATE jobs
    SET company = @company,
        company_size = @company_size,
        company_kind = @company_kind,
        company_size_source = @company_size_source,
        title = @title,
        location = @location,
        salary = @salary,
        jd_text = @jd_text,
        jd_hash = @jd_hash,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  for (const row of rows) {
    const normalized = normalizeBossJob(row);
    update.run({
      id: row.id,
      company: normalized.company || "",
      company_size: normalized.company_size || "",
      company_kind: normalized.company_kind === "hunter" ? "hunter" : normalized.company_kind === "company" ? "company" : "unknown",
      company_size_source: normalized.company_size_source || "unverified",
      title: normalized.title || "",
      location: normalized.location || "",
      salary: normalized.salary || "",
      jd_text: normalized.jd_text || "",
      jd_hash: hashText(normalized.jd_text || normalized.source_url)
    });
  }
}

export function recordCollectionFilterLogs(db, { searchBatchId, items = [] } = {}) {
  const batchId = String(searchBatchId || "").trim().slice(0, 120);
  if (!batchId || !Array.isArray(items) || !items.length) return { recorded: 0 };
  const insert = db.prepare(`
    INSERT OR IGNORE INTO collection_filter_logs (
      search_batch_id, entry_key, source_url, title, salary, location, reason_codes_json, reason_details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let recorded = 0;
  db.exec("BEGIN");
  try {
    for (const item of items) {
      const reasons = [...new Set((Array.isArray(item?.reasons) ? item.reasons : [])
        .map((reason) => String(reason || "").trim().slice(0, 80))
        .filter(Boolean))].slice(0, 8);
      if (!reasons.length) continue;
      const sourceUrl = String(item?.source_url || "").trim().slice(0, 1000);
      const title = String(item?.title || "").trim().slice(0, 240);
      const salary = String(item?.salary || "").trim().slice(0, 120);
      const location = String(item?.location || "").trim().slice(0, 120);
      const details = normalizeFilterLogDetails(item?.reason_details);
      const entryKey = sourceUrl || `${title}|${salary}|${location}|${reasons.join(",")}`;
      if (!entryKey) continue;
      recorded += Number(insert.run(batchId, entryKey, sourceUrl, title, salary, location, JSON.stringify(reasons), JSON.stringify(details)).changes || 0);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { recorded };
}

export function getCollectionFilterLogs(db, searchBatchId, limit = 200) {
  const batchId = String(searchBatchId || "").trim().slice(0, 120);
  if (!batchId) return { search_batch_id: "", total: 0, reason_counts: {}, entries: [] };
  const rows = db.prepare(`
    SELECT source_url, title, salary, location, reason_codes_json, reason_details_json, created_at
    FROM collection_filter_logs
    WHERE search_batch_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(batchId, Math.max(1, Math.min(Number(limit) || 200, 500)));
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM collection_filter_logs WHERE search_batch_id = ?").get(batchId).count || 0);
  const reasonCounts = {};
  const entries = rows.map((row) => {
    let reasons = [];
    let reasonDetails = {};
    try { reasons = JSON.parse(row.reason_codes_json || "[]"); } catch {}
    try { reasonDetails = JSON.parse(row.reason_details_json || "{}"); } catch {}
    for (const reason of Array.isArray(reasons) ? reasons : []) {
      reasonCounts[reason] = Number(reasonCounts[reason] || 0) + 1;
    }
    return { ...row, reasons: Array.isArray(reasons) ? reasons : [], reason_details: reasonDetails && typeof reasonDetails === "object" ? reasonDetails : {} };
  });
  return { search_batch_id: batchId, total, reason_counts: reasonCounts, entries };
}

function normalizeFilterLogDetails(value) {
  const details = value && typeof value === "object" ? value : {};
  const safeTerms = (items) => Array.isArray(items)
    ? items.map((item) => String(item || "").trim().slice(0, 80)).filter(Boolean).slice(0, 10)
    : [];
  const numeric = (item) => Number.isFinite(Number(item)) ? Number(item) : null;
  const parsedSalary = details.parsed_salary && typeof details.parsed_salary === "object"
    ? { min: numeric(details.parsed_salary.min), max: numeric(details.parsed_salary.max) }
    : null;
  return {
    title_match: details.title_match === true,
    keyword_match: details.keyword_match === true,
    salary_match: details.salary_match === true,
    job_salary: String(details.job_salary || "").trim().slice(0, 120),
    parsed_salary: parsedSalary,
    required_salary_min: numeric(details.required_salary_min),
    required_salary_max: numeric(details.required_salary_max),
    target_directions: safeTerms(details.target_directions),
    jd_keywords: safeTerms(details.jd_keywords)
  };
}

export function ensureApplication(db, jobId) {
  db.prepare(`
    INSERT OR IGNORE INTO applications (
      job_id, source_kind, reply_rate_eligible, history_data_state, first_seen_at
    ) VALUES (?, 'manual_apply', 1, 'current', CURRENT_TIMESTAMP)
  `).run(jobId);
  return db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId);
}

export function ensureSupplementApplication(db, job) {
  const savedJob = upsertJob(db, job, { ensureApplication: false });
  const existing = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(savedJob.id);
  if (existing && existing.source_kind === "auto_supplement") return existing;
  if (existing) {
    return existing;
  }

  db.prepare(`
    INSERT INTO applications (
      job_id,
      status,
      source_kind,
      supplement_reason,
      reply_rate_eligible,
      first_seen_at
    ) VALUES (?, 'supplement', 'auto_supplement', 'history_message_sync', 0, CURRENT_TIMESTAMP)
  `).run(savedJob.id);

  return db.prepare("SELECT * FROM applications WHERE job_id = ?").get(savedJob.id);
}

export function cleanupInvalidSupplementApplications(db) {
  const result = db.prepare(`
    DELETE FROM jobs
    WHERE source_url LIKE 'boss://supplement/%'
      AND id IN (
        SELECT j.id
        FROM jobs j
        JOIN applications a ON a.job_id = j.id
        WHERE j.source_url LIKE 'boss://supplement/%'
          AND a.source_kind <> 'auto_supplement'
      )
  `).run();
  refreshDailyMetrics(db);
  return Number(result.changes || 0);
}

export function setApplicationStatus(db, jobId, status, fields = {}) {
  ensureApplication(db, jobId);
  const current = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId);
  const now = new Date().toISOString();
  const nextStatus = status || current.status;
  const appliedAt = nextStatus === "applied" ? fields.applied_at || current.applied_at || now : fields.applied_at || null;
  const interestedAt =
    nextStatus === "interested"
      ? fields.interested_at || fields.last_replied_at || current.interested_at || now
      : fields.interested_at || null;
  const interviewAt =
    nextStatus === "interview"
      ? fields.interview_at || fields.last_replied_at || current.interview_at || now
      : fields.interview_at || null;
  const rejectedAt =
    nextStatus === "rejected"
      ? fields.rejected_at || fields.last_replied_at || current.rejected_at || now
      : fields.rejected_at || null;

  db.prepare(`
    UPDATE applications
    SET status = @status,
        source_kind = COALESCE(@source_kind, source_kind),
        supplement_reason = COALESCE(@supplement_reason, supplement_reason),
        reply_rate_eligible = COALESCE(@reply_rate_eligible, reply_rate_eligible),
        contact_anchor_at = COALESCE(@contact_anchor_at, contact_anchor_at),
        manual_status_override = COALESCE(@manual_status_override, manual_status_override),
        manual_override_at = COALESCE(@manual_override_at, manual_override_at),
        manual_override_reason = COALESCE(@manual_override_reason, manual_override_reason),
        history_data_state = COALESCE(@history_data_state, history_data_state),
        applied_at = COALESCE(@applied_at, applied_at),
        first_seen_at = COALESCE(@first_seen_at, first_seen_at, created_at),
        first_replied_at = COALESCE(@first_replied_at, first_replied_at),
        last_replied_at = COALESCE(@last_replied_at, last_replied_at),
        interested_at = COALESCE(@interested_at, interested_at),
        resume_request_at = COALESCE(@resume_request_at, resume_request_at),
        interview_at = COALESCE(@interview_at, interview_at),
        rejected_at = COALESCE(@rejected_at, rejected_at),
        reply_handled_at = CASE
          WHEN @clear_reply_handled = 1 THEN NULL
          ELSE COALESCE(@reply_handled_at, reply_handled_at)
        END,
        feedback_intent = COALESCE(@feedback_intent, feedback_intent),
        feedback_reason = COALESCE(@feedback_reason, feedback_reason),
        last_message_text = COALESCE(@last_message_text, last_message_text),
        notes = COALESCE(@notes, notes),
        updated_at = CURRENT_TIMESTAMP
    WHERE job_id = @job_id
  `).run({
    job_id: jobId,
    status: nextStatus,
    source_kind: fields.source_kind || null,
    supplement_reason: fields.supplement_reason || null,
    reply_rate_eligible: fields.reply_rate_eligible ?? null,
    contact_anchor_at: fields.contact_anchor_at || (nextStatus === "applied" ? appliedAt : null),
    manual_status_override: fields.manual_status_override ?? null,
    manual_override_at: fields.manual_override_at || null,
    manual_override_reason: fields.manual_override_reason ?? null,
    history_data_state: fields.history_data_state || null,
    applied_at: appliedAt,
    first_seen_at: fields.first_seen_at || null,
    first_replied_at: fields.first_replied_at || null,
    last_replied_at: fields.last_replied_at || null,
    interested_at: interestedAt,
    resume_request_at: fields.resume_request_at || null,
    interview_at: interviewAt,
    rejected_at: rejectedAt,
    reply_handled_at: fields.reply_handled_at || null,
    clear_reply_handled: fields.clear_reply_handled ? 1 : 0,
    feedback_intent: fields.feedback_intent || null,
    feedback_reason: fields.feedback_reason || null,
    last_message_text: fields.last_message_text || null,
    notes: fields.notes ?? null
  });

  db.prepare("UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(nextStatus, jobId);
  refreshDailyMetrics(db);
  return db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId);
}

const STATUS_RANK = new Map([
  ["queued", 0],
  ["paused", 0],
  ["applied", 1],
  ["interested", 2],
  ["interview", 3]
]);

export function advanceApplicationStatus(db, jobId, targetStatus, fields = {}) {
  ensureApplication(db, jobId);
  const current = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId);
  if (Number(current.manual_status_override || 0) === 1) return current;

  const currentRank = STATUS_RANK.get(current.status) ?? 0;
  const targetRank = STATUS_RANK.get(targetStatus) ?? currentRank;
  const nextStatus = targetRank > currentRank ? targetStatus : current.status;
  const exactReplyTime = fields.time_precision === "exact" ? fields.last_replied_at || fields.first_replied_at : null;
  const contactAnchorAt = current.contact_anchor_at || current.applied_at || exactReplyTime || null;

  return setApplicationStatus(db, jobId, nextStatus, {
    ...fields,
    contact_anchor_at: contactAnchorAt,
    first_replied_at: exactReplyTime ? current.first_replied_at || exactReplyTime : fields.first_replied_at || null,
    last_replied_at: exactReplyTime || fields.last_replied_at || null,
    interested_at: targetStatus === "interested" || targetStatus === "interview"
      ? fields.interested_at || exactReplyTime || null
      : fields.interested_at || null,
    interview_at: targetStatus === "interview" ? fields.interview_at || exactReplyTime || null : fields.interview_at || null
  });
}

export function setManualApplicationStatus(db, jobId, status, fields = {}) {
  const now = new Date().toISOString();
  return setApplicationStatus(db, jobId, status, {
    ...fields,
    manual_status_override: 1,
    manual_override_at: fields.manual_override_at || now,
    manual_override_reason: fields.manual_override_reason || "manual_status_change"
  });
}

export function insertMessageIfNew(db, message) {
  const conversationKey = String(message.conversation_key || "").trim();
  const nativeMessageId = String(message.native_message_id || message.message_key || "").trim();
  const messageOrder = normalizeMessageOrder(message.message_order ?? message.message_key);
  const messageKey = String(message.message_key || "").trim();
  const messageHash = String(message.message_hash || buildMessageHash(message)).trim();
  const timePrecision = message.time_precision === "exact" && message.sent_at ? "exact" : "unknown";
  const sentAt = timePrecision === "exact" ? String(message.sent_at) : null;
  const dedupeKey = nativeMessageId
    ? `native:${conversationKey}:${nativeMessageId}`
    : buildMessageDedupeKey({
      conversation_key: conversationKey,
      sender: message.sender,
      text: message.text,
      message_order: messageOrder
    });

  if (nativeMessageId) {
    const existingByKey = db.prepare(`
      SELECT * FROM messages
      WHERE conversation_key = ? AND native_message_id = ?
      LIMIT 1
    `).get(conversationKey, nativeMessageId);
    if (existingByKey) {
      const nextDirection = message.direction || inferDirection(message.sender);
      if (existingByKey.direction === "outbound" && nextDirection === "inbound") {
        db.prepare(`
          UPDATE messages
          SET direction = ?, sender = ?, text = ?, message_hash = ?, source_url = ?, sent_at = ?,
              time_precision = ?, dedupe_key = ?
          WHERE id = ?
        `).run(
          nextDirection,
          message.sender || "hr",
          message.text || existingByKey.text,
          messageHash,
          message.source_url || existingByKey.source_url,
          sentAt || existingByKey.sent_at,
          timePrecision,
          dedupeKey,
          existingByKey.id
        );
        return {
          inserted: false,
          updated: true,
          row: db.prepare("SELECT * FROM messages WHERE id = ?").get(existingByKey.id)
        };
      }
      return { inserted: false, row: existingByKey };
    }
  }

  const existingByDedupe = db.prepare(`
    SELECT * FROM messages
    WHERE dedupe_key = ?
    LIMIT 1
  `).get(dedupeKey);
  if (existingByDedupe) return { inserted: false, row: existingByDedupe };

  const result = db.prepare(`
    INSERT INTO messages (
      application_id,
      conversation_key,
      message_key,
      message_hash,
      native_message_id,
      message_order,
      time_precision,
      dedupe_key,
      sync_run_id,
      direction,
      sender,
      text,
      source_url,
      sent_at,
      analyzed_at,
      analysis_json
    ) VALUES (
      @application_id,
      @conversation_key,
      @message_key,
      @message_hash,
      @native_message_id,
      @message_order,
      @time_precision,
      @dedupe_key,
      @sync_run_id,
      @direction,
      @sender,
      @text,
      @source_url,
      @sent_at,
      @analyzed_at,
      @analysis_json
    )
  `).run({
    application_id: message.application_id ?? null,
    conversation_key: conversationKey,
    message_key: messageKey,
    message_hash: messageHash,
    native_message_id: nativeMessageId,
    message_order: messageOrder,
    time_precision: timePrecision,
    dedupe_key: dedupeKey,
    sync_run_id: message.sync_run_id ?? null,
    direction: message.direction || inferDirection(message.sender),
    sender: message.sender || "hr",
    text: message.text || "",
    source_url: message.source_url || "",
    sent_at: sentAt,
    analyzed_at: message.analyzed_at || null,
    analysis_json: message.analysis_json || null
  });

  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(result.lastInsertRowid);
  return { inserted: true, row };
}

export function refreshDailyMetrics(db) {
  const dates = db.prepare(`
    SELECT metric_date
    FROM (
      SELECT substr(applied_at, 1, 10) AS metric_date FROM applications WHERE applied_at IS NOT NULL AND reply_rate_eligible = 1
      UNION
      SELECT substr(${CONTACT_ANCHOR_SQL}, 1, 10) AS metric_date FROM applications WHERE ${CONTACT_ANCHOR_SQL} IS NOT NULL
    )
    WHERE metric_date IS NOT NULL
    ORDER BY metric_date
  `).all();

  const upsert = db.prepare(`
    INSERT INTO daily_metrics (
      metric_date,
      read_count,
      recommended_count,
      applied_count,
      reply_count,
      resume_request_count,
      interview_count,
      positive_count,
      updated_at
    ) VALUES (
      @metric_date,
      COALESCE((SELECT read_count FROM daily_metrics WHERE metric_date = @metric_date), 0),
      COALESCE((SELECT recommended_count FROM daily_metrics WHERE metric_date = @metric_date), 0),
      @applied_count,
      @reply_count,
      @resume_request_count,
      @interview_count,
      @positive_count,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(metric_date) DO UPDATE SET
      applied_count = excluded.applied_count,
      reply_count = excluded.reply_count,
      resume_request_count = excluded.resume_request_count,
      interview_count = excluded.interview_count,
      positive_count = excluded.positive_count,
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const { metric_date: date } of dates) {
    if (!date) continue;
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN substr(applied_at, 1, 10) = ? AND reply_rate_eligible = 1 THEN 1 ELSE 0 END) AS applied_count,
        SUM(CASE WHEN substr(${CONTACT_ANCHOR_SQL}, 1, 10) = ? AND first_replied_at IS NOT NULL THEN 1 ELSE 0 END) AS reply_count,
        SUM(CASE WHEN substr(${CONTACT_ANCHOR_SQL}, 1, 10) = ? AND resume_request_at IS NOT NULL THEN 1 ELSE 0 END) AS resume_request_count,
        SUM(CASE WHEN substr(${CONTACT_ANCHOR_SQL}, 1, 10) = ? AND interview_at IS NOT NULL THEN 1 ELSE 0 END) AS interview_count,
        SUM(
          CASE
            WHEN substr(${CONTACT_ANCHOR_SQL}, 1, 10) = ?
             AND (interested_at IS NOT NULL OR interview_at IS NOT NULL)
            THEN 1 ELSE 0
          END
        ) AS positive_count
      FROM applications
    `).get(date, date, date, date, date);
    upsert.run({ metric_date: date, ...counts });
  }

  db.prepare(`
    DELETE FROM daily_metrics
    WHERE metric_date NOT IN (
      SELECT substr(applied_at, 1, 10) FROM applications WHERE applied_at IS NOT NULL AND reply_rate_eligible = 1
      UNION
      SELECT substr(${CONTACT_ANCHOR_SQL}, 1, 10) FROM applications WHERE ${CONTACT_ANCHOR_SQL} IS NOT NULL
    )
      AND read_count = 0
      AND recommended_count = 0
  `).run();
}

export function markReplyHandled(db, jobId) {
  ensureApplication(db, jobId);
  db.prepare(`
    UPDATE applications
    SET reply_handled_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ?
  `).run(jobId);
  return db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId);
}

export function cleanupOldJobs(db, retentionDays = 30) {
  db.prepare(`
    DELETE FROM jobs
    WHERE datetime(created_at) < datetime('now', ?)
      AND id NOT IN (
        SELECT job_id FROM applications
        WHERE status IN ('applied', 'interested', 'interview', 'supplement')
           OR notes <> ''
           OR source_kind = 'auto_supplement'
      )
  `).run(`-${retentionDays} days`);
}

export function startHistorySyncRun(db, rangeStart, rangeEnd) {
  const result = db.prepare(`
    INSERT INTO history_sync_runs (range_start, range_end, status)
    VALUES (?, ?, 'running')
  `).run(rangeStart || null, rangeEnd || null);
  return Number(result.lastInsertRowid);
}

export function finishHistorySyncRun(db, runId, fields = {}) {
  db.prepare(`
    UPDATE history_sync_runs
    SET status = @status,
        finished_at = CURRENT_TIMESTAMP,
        scanned_conversations = COALESCE(@scanned_conversations, scanned_conversations),
        new_messages = COALESCE(@new_messages, new_messages),
        matched_count = COALESCE(@matched_count, matched_count),
        supplemented_count = COALESCE(@supplemented_count, supplemented_count),
        classified_count = COALESCE(@classified_count, classified_count),
        stopped_reason = COALESCE(@stopped_reason, stopped_reason)
    WHERE id = @id
  `).run({
    id: runId,
    status: fields.status || "completed",
    scanned_conversations: fields.scanned_conversations ?? null,
    new_messages: fields.new_messages ?? null,
    matched_count: fields.matched_count ?? null,
    supplemented_count: fields.supplemented_count ?? null,
    classified_count: fields.classified_count ?? null,
    stopped_reason: fields.stopped_reason ?? null
  });
}

export function listHistorySyncRuns(db, limit = 20) {
  return db.prepare(`
    SELECT *
    FROM history_sync_runs
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit || 20), 100)));
}

export function getHistorySummary(db, options = {}) {
  const range = normalizeRange(options);
  const includeSupplement = Boolean(options.include_supplement);
  const appliedCount = countCurrentApplicationsByAppliedAt(db, range);
  const replyCount = countEventApplications(db, range, includeSupplement, ["resume_request", "process_progress", "wechat_contact", "interview"]);
  const resumeRequestCount = countEventApplications(db, range, includeSupplement, ["resume_request"]);
  const interviewCount = countEventApplications(db, range, includeSupplement, ["interview"]);
  const supplementCount = countSupplementApplications(db, range);
  const supplementReplyCount = countEventApplications(db, range, true, ["resume_request", "process_progress", "wechat_contact", "interview"], "a.source_kind = 'auto_supplement'");

  return {
    range_start: range.start,
    range_end: range.end,
    include_supplement: includeSupplement,
    applied_count: appliedCount,
    reply_count: replyCount,
    resume_request_count: resumeRequestCount,
    interview_count: interviewCount,
    supplement_count: supplementCount,
    supplement_reply_count: supplementReplyCount,
    reply_rate: appliedCount ? roundRate(replyCount / appliedCount) : null,
    resume_request_rate: appliedCount ? roundRate(resumeRequestCount / appliedCount) : null,
    interview_rate: appliedCount ? roundRate(interviewCount / appliedCount) : null
  };
}

export function getHistoryDailySummary(db, options = {}) {
  const range = normalizeRange(options);
  const includeSupplement = Boolean(options.include_supplement);
  const rowsByDate = new Map();

  mergeDailyCounts(rowsByDate, aggregateCurrentApplicationsByDay(db, range));
  mergeDailyCounts(rowsByDate, aggregateEventsByAnchorDay(db, range, includeSupplement, ["resume_request", "process_progress", "wechat_contact", "interview"], "reply_count"));
  mergeDailyCounts(rowsByDate, aggregateEventsByAnchorDay(db, range, includeSupplement, ["resume_request"], "resume_request_count"));
  mergeDailyCounts(rowsByDate, aggregateEventsByAnchorDay(db, range, includeSupplement, ["interview"], "interview_count"));
  mergeDailyCounts(rowsByDate, aggregateSupplementApplicationsByDay(db, range));

  return [...rowsByDate.values()]
    .sort((left, right) => right.metric_date.localeCompare(left.metric_date))
    .map((row) => ({
      metric_date: row.metric_date,
      applied_count: Number(row.applied_count || 0),
      reply_count: Number(row.reply_count || 0),
      resume_request_count: Number(row.resume_request_count || 0),
      interview_count: Number(row.interview_count || 0),
      supplement_count: Number(row.supplement_count || 0)
    }));
}

export function getReplyBoard(db, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 200), 200));
  const rows = db.prepare(`
    SELECT
      e.id AS event_id,
      e.event_type,
      e.occurred_at,
      e.contact_anchor_at,
      e.time_precision,
      e.classification_basis,
      a.id AS application_id,
      a.status AS application_status,
      a.source_kind,
      a.reply_handled_at,
      j.source_url,
      j.title,
      j.company,
      j.location,
      j.salary,
      m.text AS message_text,
      m.sent_at AS message_sent_at,
      m.conversation_key
    FROM reply_events e
    JOIN applications a ON a.id = e.application_id
    JOIN jobs j ON j.id = a.job_id
    LEFT JOIN messages m ON m.id = e.message_id
    WHERE a.history_data_state = 'current'
      AND a.reply_handled_at IS NULL
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ?
  `).all(limit);
  return rows.map((row) => ({
    ...row,
    event_label: replyEventLabel(row.event_type),
    reply_bucket: replyEventBucket(row.event_type),
    feedback_intent: replyEventLabel(row.event_type),
    feedback_reason: row.classification_basis,
    last_replied_at: row.occurred_at || row.message_sent_at,
    last_message_text: row.message_text,
    is_reply_handled: false
  }));
}

export function getHistoryCoverage(db, options = {}) {
  const range = normalizeRange(options);
  const run = db.prepare(`
    SELECT * FROM history_sync_runs
    WHERE status = 'completed'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  const earliest = run
    ? db.prepare(`
      SELECT MIN(sent_at) AS earliest_covered_at
      FROM messages
      WHERE sync_run_id = ? AND time_precision = 'exact' AND sent_at IS NOT NULL
    `).get(run.id)?.earliest_covered_at || null
    : null;
  const complete = Boolean(
    run &&
    run.stopped_reason === 'no_more_visible_conversations' &&
    earliest &&
    new Date(earliest).getTime() <= new Date(range.start).getTime()
  );
  return {
    status: complete ? 'complete' : 'partial',
    range_start: range.start,
    range_end: range.end,
    earliest_covered_at: earliest,
    last_run_id: run?.id || null,
    stopped_reason: run?.stopped_reason || null
  };
}

function replyEventLabel(eventType) {
  return {
    resume_request: '\u7d22\u8981\u7b80\u5386',
    process_progress: '\u6d41\u7a0b\u63a8\u8fdb',
    wechat_contact: '\u52a0\u5fae\u4fe1/\u7ea6\u6c9f\u901a',
    interview: '\u660e\u786e\u9080\u9762',
    rejected: '\u5a49\u62d2'
  }[eventType] || '\u5f85\u4eba\u5de5\u5224\u65ad';
}

function replyEventBucket(eventType) {
  return {
    resume_request: 'resume_request',
    process_progress: 'process_progress',
    wechat_contact: 'wechat',
    interview: 'interview',
    rejected: 'rejected'
  }[eventType] || 'needs_review';
}

function countCurrentApplicationsByAppliedAt(db, range) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM applications a
    WHERE a.reply_rate_eligible = 1
      AND a.history_data_state = 'current'
      AND a.applied_at IS NOT NULL
      AND datetime(a.applied_at) >= datetime(@start)
      AND datetime(a.applied_at) <= datetime(@end)
  `).get(range).count || 0);
}

function countEventApplications(db, range, includeSupplement, eventTypes, extraWhere = "1 = 1") {
  const placeholders = eventTypes.map(() => "?").join(", ");
  const eligible = includeSupplement ? "1 = 1" : "a.reply_rate_eligible = 1";
  const row = db.prepare(`
    SELECT COUNT(DISTINCT e.application_id) AS count
    FROM reply_events e
    JOIN applications a ON a.id = e.application_id
    WHERE e.time_precision = 'exact'
      AND e.contact_anchor_at IS NOT NULL
      AND a.history_data_state = 'current'
      AND ${eligible}
      AND ${extraWhere}
      AND e.event_type IN (${placeholders})
      AND datetime(e.contact_anchor_at) >= datetime(?)
      AND datetime(e.contact_anchor_at) <= datetime(?)
  `).get(...eventTypes, range.start, range.end);
  return Number(row?.count || 0);
}

function countSupplementApplications(db, range) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM applications a
    WHERE a.source_kind = 'auto_supplement'
      AND a.history_data_state = 'current'
      AND a.contact_anchor_at IS NOT NULL
      AND datetime(a.contact_anchor_at) >= datetime(@start)
      AND datetime(a.contact_anchor_at) <= datetime(@end)
  `).get(range).count || 0);
}

function aggregateCurrentApplicationsByDay(db, range) {
  return db.prepare(`
    SELECT date(a.applied_at) AS metric_date, COUNT(*) AS applied_count
    FROM applications a
    WHERE a.reply_rate_eligible = 1
      AND a.history_data_state = 'current'
      AND a.applied_at IS NOT NULL
      AND datetime(a.applied_at) >= datetime(@start)
      AND datetime(a.applied_at) <= datetime(@end)
    GROUP BY date(a.applied_at)
  `).all(range);
}

function aggregateEventsByAnchorDay(db, range, includeSupplement, eventTypes, alias) {
  const placeholders = eventTypes.map(() => "?").join(", ");
  const eligible = includeSupplement ? "1 = 1" : "a.reply_rate_eligible = 1";
  return db.prepare(`
    SELECT date(e.contact_anchor_at) AS metric_date, COUNT(DISTINCT e.application_id) AS ${alias}
    FROM reply_events e
    JOIN applications a ON a.id = e.application_id
    WHERE e.time_precision = 'exact'
      AND e.contact_anchor_at IS NOT NULL
      AND a.history_data_state = 'current'
      AND ${eligible}
      AND e.event_type IN (${placeholders})
      AND datetime(e.contact_anchor_at) >= datetime(?)
      AND datetime(e.contact_anchor_at) <= datetime(?)
    GROUP BY date(e.contact_anchor_at)
  `).all(...eventTypes, range.start, range.end);
}

function aggregateSupplementApplicationsByDay(db, range) {
  return db.prepare(`
    SELECT date(a.contact_anchor_at) AS metric_date, COUNT(*) AS supplement_count
    FROM applications a
    WHERE a.source_kind = 'auto_supplement'
      AND a.history_data_state = 'current'
      AND a.contact_anchor_at IS NOT NULL
      AND datetime(a.contact_anchor_at) >= datetime(@start)
      AND datetime(a.contact_anchor_at) <= datetime(@end)
    GROUP BY date(a.contact_anchor_at)
  `).all(range);
}

export function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function buildMessageHash(message) {
  return hashText([
    message.conversation_key || "",
    message.company || "",
    message.title || "",
    message.sent_at || "",
    message.sender || "",
    message.text || ""
  ].join("::"));
}

export function buildMessageDedupeKey(message) {
  const conversationKey = String(message.conversation_key || "").trim();
  const sender = String(message.sender || "").trim().toLowerCase();
  const textHash = hashText(String(message.text || ""));
  const order = normalizeMessageOrder(message.message_order);
  return `fallback:${conversationKey}:${sender}:${textHash}:${order === null ? "unknown" : order}`;
}

export function insertReplyEventIfFirst(db, event) {
  const application = db.prepare("SELECT * FROM applications WHERE id = ?").get(event.application_id);
  if (!application) throw new Error("application_not_found");
  const eventType = String(event.event_type || "");
  const allowed = new Set(["resume_request", "process_progress", "wechat_contact", "interview", "rejected"]);
  if (!allowed.has(eventType)) throw new Error("invalid_reply_event_type");

  const exactTime = event.time_precision === "exact" && event.occurred_at ? String(event.occurred_at) : null;
  const anchor = application.contact_anchor_at || application.applied_at || exactTime || null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO reply_events (
      application_id, message_id, event_type, occurred_at, contact_anchor_at, time_precision, classification_basis
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    application.id,
    event.message_id ?? null,
    eventType,
    exactTime,
    anchor,
    exactTime ? "exact" : "unknown",
    String(event.classification_basis || "")
  );

  if (anchor && !application.contact_anchor_at) {
    db.prepare("UPDATE applications SET contact_anchor_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(anchor, application.id);
  }
  return {
    inserted: Number(result.changes || 0) === 1,
    row: db.prepare("SELECT * FROM reply_events WHERE application_id = ? AND event_type = ?").get(application.id, eventType)
  };
}

export function bindConversation(db, binding) {
  const conversationKey = String(binding.conversation_key || "").trim();
  if (!conversationKey) throw new Error("conversation_key_required");
  const application = db.prepare("SELECT id FROM applications WHERE id = ?").get(binding.application_id);
  if (!application) throw new Error("application_not_found");
  db.prepare(`
    INSERT INTO conversation_bindings (conversation_key, application_id, source_url, binding_kind)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_key) DO UPDATE SET
      application_id = excluded.application_id,
      source_url = excluded.source_url,
      binding_kind = excluded.binding_kind,
      updated_at = CURRENT_TIMESTAMP
  `).run(conversationKey, application.id, String(binding.source_url || ""), String(binding.binding_kind || "manual"));
  return db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(conversationKey);
}

export function upsertUnlinkedConversation(db, conversation) {
  const conversationKey = String(conversation.conversation_key || "").trim();
  if (!conversationKey) throw new Error("conversation_key_required");
  const observedAt = conversation.observed_at || null;
  db.prepare(`
    INSERT INTO unlinked_conversations (
      conversation_key, source_url, title, company, last_message_text, first_observed_at, last_observed_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_key) DO UPDATE SET
      source_url = excluded.source_url,
      title = excluded.title,
      company = excluded.company,
      last_message_text = excluded.last_message_text,
      first_observed_at = COALESCE(unlinked_conversations.first_observed_at, excluded.first_observed_at),
      last_observed_at = COALESCE(excluded.last_observed_at, unlinked_conversations.last_observed_at),
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    conversationKey,
    String(conversation.source_url || ""),
    String(conversation.title || ""),
    String(conversation.company || ""),
    String(conversation.last_message_text || ""),
    observedAt,
    observedAt,
    String(conversation.status || "pending")
  );
  return db.prepare("SELECT * FROM unlinked_conversations WHERE conversation_key = ?").get(conversationKey);
}

export function cleanupLegacyAutoSupplementData(db, { apply = false } = {}) {
  const manualEvidence = `
    (a.reply_handled_at IS NOT NULL
      OR TRIM(a.notes) <> ''
      OR a.manual_status_override = 1
      OR COALESCE(a.feedback_reason, '') LIKE '%manual override%'
      OR EXISTS (SELECT 1 FROM application_artifacts aa WHERE aa.application_id = a.id)
      OR EXISTS (SELECT 1 FROM application_handoffs ah WHERE ah.application_id = a.id))
  `;
  const baseWhere = `a.source_kind = 'auto_supplement'`;
  const candidateDelete = db.prepare(`
    SELECT a.id, a.job_id
    FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE ${baseWhere} AND NOT ${manualEvidence}
      AND a.status IN ('supplement', 'queued', 'paused')
  `).all();
  const isolate = db.prepare(`
    SELECT a.id
    FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE ${baseWhere} AND NOT ${manualEvidence}
      AND a.status NOT IN ('supplement', 'queued', 'paused')
      AND a.history_data_state <> 'legacy_review'
  `).all();
  const preservedManual = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE ${baseWhere} AND ${manualEvidence}
  `).get().count || 0);

  const report = {
    mode: apply ? "apply" : "dry_run",
    candidate_delete_count: candidateDelete.length,
    deleted_count: 0,
    isolated_count: isolate.length,
    preserved_manual_count: preservedManual,
    foreign_key_violations: 0
  };
  if (!apply) return report;

  db.exec("BEGIN");
  try {
    if (isolate.length) {
      const update = db.prepare("UPDATE applications SET history_data_state = 'legacy_review', reply_rate_eligible = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      for (const row of isolate) update.run(row.id);
    }
    const removeApplication = db.prepare("DELETE FROM applications WHERE id = ?");
    const removeJob = db.prepare("DELETE FROM jobs WHERE id = ? AND source_url LIKE 'boss://supplement/%'");
    for (const row of candidateDelete) {
      removeApplication.run(row.id);
      removeJob.run(row.job_id);
    }
    report.deleted_count = candidateDelete.length;
    report.foreign_key_violations = db.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get().count;
    db.prepare(`
      INSERT INTO history_cleanup_audits (
        mode, candidate_delete_count, deleted_count, isolated_count, preserved_manual_count, foreign_key_violations, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.mode,
      report.candidate_delete_count,
      report.deleted_count,
      report.isolated_count,
      report.preserved_manual_count,
      report.foreign_key_violations,
      JSON.stringify({ deleted_application_ids: candidateDelete.map((row) => row.id), isolated_application_ids: isolate.map((row) => row.id) })
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  refreshDailyMetrics(db);
  return report;
}

function normalizeRange(options = {}) {
  const end = options.range_end || options.end || new Date().toISOString();
  if (options.range_start || options.start) {
    return {
      start: options.range_start || options.start,
      end
    };
  }

  const days = Number(String(options.range || options.days || "30").replace(/[^\d]/g, "")) || 30;
  const startDate = new Date(end);
  startDate.setDate(startDate.getDate() - Math.max(1, days) + 1);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(end);
  endDate.setHours(23, 59, 59, 999);

  return {
    start: startDate.toISOString(),
    end: endDate.toISOString()
  };
}

function countApplicationsInRange(db, { field, eventField = "", where = "1 = 1", start, end }) {
  const eventCondition = eventField ? `AND ${eventField} IS NOT NULL AND ${eventField} <= ?` : "";
  const values = eventField ? [start, end, end] : [start, end];
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM applications
    WHERE ${field} IS NOT NULL
      AND ${where}
      AND ${field} >= ?
      AND ${field} <= ?
      ${eventCondition}
  `).get(...values)?.count || 0);
}

function aggregateApplicationsByDay(db, { field, eventField = "", where = "1 = 1", start, end, alias }) {
  const eventCondition = eventField ? `AND ${eventField} IS NOT NULL AND ${eventField} <= ?` : "";
  const values = eventField ? [start, end, end] : [start, end];
  return db.prepare(`
    SELECT
      substr(${field}, 1, 10) AS metric_date,
      COUNT(*) AS ${alias}
    FROM applications
    WHERE ${field} IS NOT NULL
      AND ${where}
      AND ${field} >= ?
      AND ${field} <= ?
      ${eventCondition}
    GROUP BY substr(${field}, 1, 10)
    ORDER BY metric_date DESC
  `).all(...values);
}

function mergeDailyCounts(target, rows) {
  for (const row of rows || []) {
    const metricDate = String(row.metric_date || "").trim();
    if (!metricDate) continue;
    const current = target.get(metricDate) || {
      metric_date: metricDate,
      applied_count: 0,
      reply_count: 0,
      resume_request_count: 0,
      interview_count: 0,
      supplement_count: 0
    };
    for (const [key, value] of Object.entries(row)) {
      if (key === "metric_date") continue;
      current[key] = Number(value || 0);
    }
    target.set(metricDate, current);
  }
}

function roundRate(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function inferDirection(sender) {
  return String(sender || "").toLowerCase() === "me" ? "outbound" : "inbound";
}

function normalizeMessageOrder(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function rebuildMessagesForNullableTimestamp(db) {
  const sentAt = db.prepare("PRAGMA table_info(messages)").all().find((column) => column.name === "sent_at");
  if (!sentAt || Number(sentAt.notnull || 0) === 0) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE messages_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
        conversation_key TEXT NOT NULL DEFAULT '',
        message_key TEXT NOT NULL DEFAULT '',
        message_hash TEXT NOT NULL DEFAULT '',
        native_message_id TEXT NOT NULL DEFAULT '',
        message_order INTEGER,
        time_precision TEXT NOT NULL DEFAULT 'unknown',
        dedupe_key TEXT NOT NULL DEFAULT '',
        sync_run_id INTEGER REFERENCES history_sync_runs(id) ON DELETE SET NULL,
        direction TEXT NOT NULL DEFAULT '',
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        sent_at TEXT,
        analyzed_at TEXT,
        analysis_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO messages_rebuilt (
        id, application_id, conversation_key, message_key, message_hash, native_message_id,
        message_order, time_precision, dedupe_key, sync_run_id, direction, sender, text,
        source_url, sent_at, analyzed_at, analysis_json, created_at
      )
      SELECT
        id, application_id, conversation_key, message_key, message_hash, native_message_id,
        message_order,
        CASE WHEN sent_at IS NULL OR TRIM(sent_at) = '' THEN 'unknown' ELSE 'exact' END,
        dedupe_key, sync_run_id, direction, sender, text, source_url, sent_at, analyzed_at,
        analysis_json, created_at
      FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_rebuilt RENAME TO messages;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
