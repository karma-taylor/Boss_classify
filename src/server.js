import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBrowserStatus } from "./browser.js";
import {
  buildUserProfile,
  getDailyRecommendationRemaining,
  incrementReadMetric,
  incrementRecommendedMetric,
  normalizeCandidateReport
} from "./candidate.js";
import {
  analyzeJobFilters,
  buildBossSearchTasks,
  buildBossSearchUrls,
  diagnoseBossTabs,
  readCurrentBossPage
} from "./boss.js";
import {
  buildMessageHash,
  cleanupOldJobs,
  ensureSupplementApplication,
  finishHistorySyncRun,
  getCollectionFilterLogs,
  getHistoryCoverage,
  getHistoryDailySummary,
  getHistorySummary,
  getReplyBoard,
  insertMessageIfNew,
  listHistorySyncRuns,
  markReplyHandled,
  normalizeStoredJobs,
  openDb,
  refreshDailyMetrics,
  recordCollectionFilterLogs,
  setApplicationStatus,
  startHistorySyncRun,
  upsertJob
} from "./db.js";
import { syncHistoryConversations } from "./historySync.js";
import { evaluateLocally, generateGreetingsLocally } from "./localWorker.js";
import { REPLY_INTENTS, getReplyBucket } from "./intents.js";
import { analyzeMessages, evaluateJob, generateGreetings } from "./workerClient.js";
import { applyMessageAnalysis, buildTomorrowPlan, getPlan, overrideReplyIntent } from "./strategy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadLocalWorkbenchEnv(path.join(__dirname, "..", ".env"));
const port = Number(process.env.PORT || 8788);
const WORKBENCH_TOKEN_HEADER = "x-workbench-token";
const workbenchApiToken = requireWorkbenchApiToken();
const trustedExtensionOrigins = new Set(readExtensionIds().map((id) => `chrome-extension://${id}`));
const trustedUiOrigins = new Set([`http://127.0.0.1:${port}`]);
const app = express();
const db = openDb();
const appVersion = "2026-07-28-reply-events";
const HANDOFF_SCHEMA = "resumatch-tailor-package/v1";
const TAILOR_MANIFEST_SCHEMA = "resume-tailor-manifest/v1";
const RESUME_TAILOR_OUTPUT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "..", "resume-tailor", "outputs");

cleanupOldJobs(db, Number(process.env.RETENTION_DAYS || 30));
normalizeStoredJobs(db);

app.use("/api", (req, res, next) => {
  const origin = req.get("Origin");
  if (origin && !isTrustedApiOrigin(origin)) {
    return res.status(403).json({ error: "forbidden_origin" });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Workbench-Token");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!tokensMatch(req.get(WORKBENCH_TOKEN_HEADER), workbenchApiToken)) {
    return res.status(403).json({ error: "forbidden_token" });
  }
  return next();
});

app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));
app.get("/favicon.ico", (_req, res) => res.status(204).end());

app.get("/api/system/browser-status", async (_req, res) => {
  res.json(await getBrowserStatus());
});

app.get("/api/system/version", (_req, res) => {
  res.json({ version: appVersion });
});

app.post("/api/boss/search-urls", (req, res) => {
  try {
    const items = buildBossSearchUrls(req.body || {});
    if (!items.length) return res.status(400).json({ error: "请先提供岗位名称或 JD 关键词。" });
    res.json({ items });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/boss/search-tasks", (req, res) => {
  try {
    const tasks = buildBossSearchTasks(req.body || {});
    if (!tasks.items.length) return res.status(400).json({ error: "请先填写岗位名称或 JD 关键词。" });
    res.json(tasks);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/boss/read-current", async (req, res) => {
  try {
    const result = await readCurrentBossPage(db, req.body || {});
    incrementReadMetric(db, result.saved || 0);
    const evaluated = await evaluateJobsForQueue(result.jobs || [], req.body || {});
    res.json({ ...result, evaluated });
  } catch (error) {
    res.status(400).json({ error: error.message, browserStatus: error.browserStatus || null });
  }
});

app.post("/api/jobs/import", async (req, res) => {
  const items = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
  if (!items.length) return res.status(400).json({ error: "请先传入岗位 JSON 数组。" });
  try {
    const saved = [];
    const evaluationTargets = [];
    const recheckExisting = Boolean(req.body?.recheck_existing);
    let existingCount = 0;
    let filteredOut = 0;
    let deduped = 0;
    const filteredReasonCounts = {};
    const softFlagCounts = {};
    const importFilters = normalizeImportFilters(req.body || {});
    const searchBatchId = String(req.body?.search_batch_id || "").trim().slice(0, 120);
    const serverFilterLogs = [];

    for (const item of items.slice(0, 500)) {
      const sourceUrl = String(item?.source_url || "").trim();
      const title = String(item?.title || "").trim();
      if (!sourceUrl || !title || !isUsableJobTitle(title)) {
        filteredOut += 1;
        addCounts(filteredReasonCounts, ["invalid_job"]);
        serverFilterLogs.push({ source_url: sourceUrl, title, salary: item?.salary, location: item?.location, reasons: ["invalid_job"] });
        continue;
      }

      const filterResult = analyzeJobFilters(item, importFilters);
      addCounts(softFlagCounts, filterResult.soft_flags);
      if (!filterResult.passed) {
        filteredOut += 1;
        addCounts(filteredReasonCounts, filterResult.reasons);
        serverFilterLogs.push({ source_url: sourceUrl, title, salary: item?.salary, location: item?.location, reasons: filterResult.reasons, reason_details: filterResult.details });
        continue;
      }

      const existing = db.prepare(`
        SELECT j.id, a.status AS application_status
        FROM jobs j
        JOIN applications a ON a.job_id = j.id
        WHERE j.source_url = ?
      `).get(sourceUrl);
      const job = upsertJob(db, {
        source_url: sourceUrl,
        title,
        company: String(item.company || "").trim(),
        salary: String(item.salary || "").trim(),
        location: String(item.location || "").trim(),
        company_size: String(item.company_size || "").trim(),
        company_kind: String(item.company_kind || "unknown").trim(),
        company_size_source: String(item.company_size_source || "unverified").trim(),
        jd_text: String(item.jd_text || "").trim().slice(0, 3000)
      });
      tagApplicationSearchBatch(db, job.id, searchBatchId);

      if (existing) {
        deduped += 1;
        existingCount += 1;
        if (recheckExisting && ["queued", "paused"].includes(existing.application_status)) {
          evaluationTargets.push(job);
          saveCandidateReport(job.id, buildPendingReport(job, req.body || {}));
        }
        continue;
      }

      saved.push(job);
      evaluationTargets.push(job);
      saveCandidateReport(job.id, buildPendingReport(job, req.body || {}));
    }

    incrementReadMetric(db, saved.length);
    const filterLogResult = recordCollectionFilterLogs(db, { searchBatchId, items: serverFilterLogs });
    const evaluated = await evaluateJobsForQueue(evaluationTargets, req.body || {});
    const evaluationSummary = summarizeEvaluationResults(evaluated);
    res.json({
      saved: saved.length,
      existing_count: existingCount,
      filtered_out: filteredOut,
      deduped,
      queued_for_evaluation: evaluated.length,
      queued_candidates: evaluationSummary.queued_candidates,
      candidate_job_ids: evaluationSummary.candidate_job_ids,
      search_batch_id: searchBatchId,
      recommended_count: evaluationSummary.recommended_count,
      needs_review_count: evaluationSummary.needs_review_count,
      not_recommended_count: evaluationSummary.not_recommended_count,
      top_reject_reasons: evaluationSummary.top_reject_reasons,
      filtered_reason_counts: filteredReasonCounts,
      filter_log_recorded: filterLogResult.recorded,
      soft_flag_counts: softFlagCounts,
      company_size_missing_count: softFlagCounts.company_size_missing || 0,
      evaluation_mode: "completed"
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/collection/filter-logs", (req, res) => {
  const searchBatchId = String(req.body?.search_batch_id || "").trim().slice(0, 120);
  if (!searchBatchId) return res.status(400).json({ error: "search_batch_id_required" });
  try {
    res.json(recordCollectionFilterLogs(db, {
      searchBatchId,
      items: Array.isArray(req.body?.items) ? req.body.items.slice(0, 300) : []
    }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/collection/filter-logs", (req, res) => {
  res.json(getCollectionFilterLogs(db, req.query?.batch_id, req.query?.limit));
});

app.get("/api/boss/diagnose-tabs", async (_req, res) => {
  try {
    res.json(await diagnoseBossTabs());
  } catch (error) {
    res.status(400).json({ error: error.message, browserStatus: error.browserStatus || null });
  }
});

app.get("/api/jobs", (_req, res) => {
  res.json(
    db.prepare(`
      SELECT j.*, a.id AS application_id, a.status AS application_status, a.feedback_intent, a.source_kind
      FROM jobs j
      JOIN applications a ON a.job_id = j.id
      ORDER BY j.updated_at DESC
      LIMIT 100
    `).all()
  );
});

app.get("/api/candidates", (req, res) => {
  const searchBatchId = String(req.query.batch_id || "").trim().slice(0, 120);
  const batchClause = searchBatchId ? "AND a.search_batch_id = ?" : "";
  const rows = db.prepare(`
    SELECT j.*, a.id AS application_id, a.status AS application_status, a.feedback_intent, a.source_kind
    FROM jobs j
    JOIN applications a ON a.job_id = j.id
    WHERE j.match_report_json IS NOT NULL
      AND a.status IN ('queued', 'paused')
      ${batchClause}
      AND json_extract(j.match_report_json, '$.queue_status') IN ('recommended', 'needs_review')
    ORDER BY
      CASE json_extract(j.match_report_json, '$.queue_status')
        WHEN 'recommended' THEN 1
        WHEN 'needs_review' THEN 2
        ELSE 3
      END,
      j.match_score DESC,
      j.updated_at DESC
    ${searchBatchId ? "" : "LIMIT 100"}
  `).all(...(searchBatchId ? [searchBatchId] : [])).map(withCandidateFields);
  res.json(rows);
});

app.post("/api/jobs", (req, res) => {
  const body = req.body || {};
  if (!body.source_url || !body.title) return res.status(400).json({ error: "source_url 和 title 必填。" });
  if (!isUsableJobTitle(body.title)) return res.status(400).json({ error: "这个岗位标题看起来像无效详情页,已跳过。" });
  res.json(upsertJob(db, body));
});

app.post("/api/jobs/:id/evaluate", async (req, res) => {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
  if (!job) return res.status(404).json({ error: "岗位不存在。" });
  try {
    const report = await evaluateAndSaveJob(job, req.body || {});
    res.json(report);
  } catch (error) {
    const fallback = buildFallbackReport(job, req.body || {}, error);
    saveCandidateReport(job.id, fallback);
    res.json(fallback);
  }
});

app.post("/api/jobs/evaluate-batch", async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.body?.limit || 20), 50));
  const jobs = db.prepare(`
    SELECT j.*
    FROM jobs j
    JOIN applications a ON a.job_id = j.id
    WHERE a.status IN ('queued', 'paused')
    ORDER BY j.updated_at DESC
    LIMIT ?
  `).all(limit);
  const evaluated = await evaluateJobsForQueue(jobs, req.body || {});
  res.json({ evaluated });
});

app.post("/api/messages/analyze", async (req, res) => {
  const conversation = Array.isArray(req.body?.conversation) ? req.body.conversation : [];
  const applicationId = req.body?.application_id ? Number(req.body.application_id) : null;
  try {
    const analysis = await analyzeMessages(conversation.slice(-12));
    analysis.last_message_at = conversation[conversation.length - 1]?.sent_at || new Date().toISOString();
    analysis.last_message_text = conversation[conversation.length - 1]?.text || "";
    if (applicationId) {
      applyMessageAnalysis(db, applicationId, analysis);
      for (const item of conversation.slice(-12)) {
        insertMessageIfNew(db, {
          application_id: applicationId,
          sender: item.sender || "hr",
          text: item.text || "",
          sent_at: item.sent_at || new Date().toISOString(),
          analyzed_at: new Date().toISOString(),
          analysis_json: JSON.stringify(analysis),
          conversation_key: `manual-${applicationId}`,
          message_key: `${item.sender || "hr"}-${item.sent_at || ""}-${String(item.text || "").slice(0, 24)}`,
          message_hash: buildMessageHash({ conversation_key: `manual-${applicationId}`, ...item })
        });
      }
    }
    res.json(analysis);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/boss/messages/sync", async (req, res) => {
  try {
    const result = await syncHistoryConversations(db, Array.isArray(req.body?.conversations) ? req.body.conversations : [], {
      analyzeMessages
    });
    refreshDashboardMetrics();
    res.json({ ...result, summary: buildReplySummary() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/boss/messages/history-sync", async (req, res) => {
  const conversations = Array.isArray(req.body?.conversations) ? req.body.conversations : [];
  const rangeStart = req.body?.range_start || null;
  const rangeEnd = req.body?.range_end || null;
  if (conversations.length > 200) {
    return res.status(400).json({ error: "history_conversation_limit_exceeded" });
  }
  const runId = startHistorySyncRun(db, rangeStart, rangeEnd);
  const abortReason = String(req.body?.abort_reason || "").trim();
  if (["login_required", "captcha_required", "risk_page"].includes(abortReason)) {
    finishHistorySyncRun(db, runId, { status: "failed", stopped_reason: abortReason });
    return res.status(409).json({ error: `history_scan_aborted:${abortReason}`, run_id: runId });
  }

  try {
    const result = await syncHistoryConversations(db, conversations, {
      syncRunId: runId,
      analyzeMessages
    });
    refreshDashboardMetrics();

    finishHistorySyncRun(db, runId, {
      status: "completed",
      scanned_conversations: result.discovered,
      new_messages: result.messages_persisted,
      matched_count: result.matched_applications,
      supplemented_count: 0,
      classified_count: result.events_created,
      stopped_reason: String(req.body?.stopped_reason || (result.failed ? "partial_failures" : ""))
    });

    res.json({
      ...result,
      run_id: runId,
      summary: buildReplySummary(),
      history_summary: getHistorySummary(db, { start: rangeStart, end: rangeEnd })
    });
  } catch (error) {
    finishHistorySyncRun(db, runId, {
      status: "failed",
      stopped_reason: error.message
    });
    res.status(400).json({ error: error.message, run_id: runId });
  }
});

app.get("/api/replies", (req, res) => {
  res.json(getReplyBoard(db, { limit: req.query.limit }));
});

app.get("/api/replies/board", (req, res) => {
  res.json(getReplyBoard(db, { limit: req.query.limit }));
});

app.get("/api/replies/summary", (_req, res) => {
  res.json(buildReplySummary());
});

app.get("/api/replies/history-summary", (req, res) => {
  res.json(getHistorySummary(db, {
    range: req.query.range,
    start: req.query.start,
    end: req.query.end,
    include_supplement: String(req.query.include_supplement || "") === "1"
  }));
});

app.get("/api/replies/history-daily", (req, res) => {
  res.json(getHistoryDailySummary(db, {
    range: req.query.range,
    start: req.query.start,
    end: req.query.end,
    include_supplement: String(req.query.include_supplement || "") === "1"
  }));
});

app.get("/api/replies/history-runs", (req, res) => {
  res.json(listHistorySyncRuns(db, Number(req.query.limit || 20)));
});

app.get("/api/replies/history-coverage", (req, res) => {
  res.json(getHistoryCoverage(db, {
    range: req.query.range,
    start: req.query.start,
    end: req.query.end
  }));
});
app.post("/api/applications/:id/mark-reply-handled", (req, res) => {
  const appRow = findApplication(req.params.id);
  if (!appRow) return res.status(404).json({ error: "投递记录不存在。" });
  res.json(markReplyHandled(db, appRow.job_id));
});

app.post("/api/applications/:id/reclassify", (req, res) => {
  const appRow = findApplication(req.params.id);
  const intent = String(req.body?.intent || "").trim();
  if (!appRow) return res.status(404).json({ error: "投递记录不存在。" });
  if (!intent) return res.status(400).json({ error: "intent 必填。" });
  try {
    res.json(overrideReplyIntent(db, appRow.id, intent, "manual override"));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/applications/:id/mark-applied", (req, res) => {
  const appRow = findApplication(req.params.id);
  if (!appRow) return res.status(404).json({ error: "投递记录不存在。" });
  res.json(setApplicationStatus(db, appRow.job_id, "applied", { notes: req.body?.notes || "" }));
});

app.post("/api/applications/:id/ignore", (req, res) => {
  const appRow = findApplication(req.params.id);
  if (!appRow) return res.status(404).json({ error: "投递记录不存在。" });
  res.json(setApplicationStatus(db, appRow.job_id, "ignored", { notes: req.body?.notes || "" }));
});

app.post("/api/applications/:id/later", (req, res) => {
  const appRow = findApplication(req.params.id);
  if (!appRow) return res.status(404).json({ error: "投递记录不存在。" });
  res.json(setApplicationStatus(db, appRow.job_id, "paused", { notes: req.body?.notes || "" }));
});

app.get("/api/metrics/daily", (_req, res) => {
  const rows = db.prepare(`
    SELECT *,
      CASE
        WHEN (
          SELECT SUM(applied_count) FROM daily_metrics dm2
          WHERE dm2.metric_date <= daily_metrics.metric_date
            AND dm2.metric_date > date(daily_metrics.metric_date, '-30 days')
        ) = 0 THEN NULL
        ELSE ROUND(
          1.0 * (
            SELECT SUM(interview_count) FROM daily_metrics dm3
            WHERE dm3.metric_date <= daily_metrics.metric_date
              AND dm3.metric_date > date(daily_metrics.metric_date, '-30 days')
          ) / (
            SELECT SUM(applied_count) FROM daily_metrics dm4
            WHERE dm4.metric_date <= daily_metrics.metric_date
              AND dm4.metric_date > date(daily_metrics.metric_date, '-30 days')
          ),
          4
        )
      END AS interview_rate,
      CASE WHEN applied_count = 0 THEN NULL ELSE ROUND(1.0 * positive_count / applied_count, 4) END AS positive_rate
    FROM daily_metrics
    ORDER BY metric_date DESC
    LIMIT 30
  `).all();
  res.json(rows.reverse());
});

app.post("/api/plans/tomorrow", (req, res) => {
  res.json(buildTomorrowPlan(db, req.body || {}));
});

app.get("/api/plans/tomorrow", (_req, res) => {
  res.json(getPlan(db));
});

app.get("/api/automation-runs", (_req, res) => {
  res.json(db.prepare("SELECT * FROM automation_runs ORDER BY id DESC LIMIT 20").all());
});

app.post("/api/applications/:id/handoffs", (req, res) => {
  const appRow = findApplication(req.params.id);
  if (!appRow) return res.status(404).json({ error: "投递记录不存在。" });
  try {
    const handoff = validateHandoffPackage(req.body?.package);
    const packageHash = crypto.createHash("sha256").update(JSON.stringify(handoff)).digest("hex");
    const result = db.prepare(`
      INSERT OR IGNORE INTO application_handoffs
        (application_id, schema_version, package_hash, job_description, assessment_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(appRow.id, HANDOFF_SCHEMA, packageHash, handoff.job_description, JSON.stringify(handoff.assessment));
    res.status(result.changes ? 201 : 200).json({
      imported: Boolean(result.changes),
      package_hash: packageHash,
      message: result.changes ? "评估交接包已绑定到该岗位。" : "该评估交接包已经绑定过。"
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/applications/:id/artifacts", (req, res) => {
  const appRow = findApplication(req.params.id);
  if (!appRow) return res.status(404).json({ error: "投递记录不存在。" });
  try {
    const manifest = validateTailorManifest(req.body?.manifest);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO application_artifacts (application_id, artifact_kind, label, local_path)
      VALUES (?, ?, ?, ?)
    `);
    let attached = 0;
    for (const artifact of manifest.artifacts) {
      const result = insert.run(appRow.id, artifact.kind, artifact.label, artifact.path);
      attached += Number(result.changes || 0);
    }
    res.status(201).json({ attached, message: attached ? "简历产物已绑定到该岗位。" : "这些简历产物已经绑定过。" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/applications/:id/dossier", (req, res) => {
  const appRow = findApplication(req.params.id);
  if (!appRow) return res.status(404).json({ error: "投递记录不存在。" });
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(appRow.job_id);
  const handoffs = db.prepare(`
    SELECT id, schema_version, package_hash, job_description, assessment_json, created_at
    FROM application_handoffs WHERE application_id = ? ORDER BY id DESC
  `).all(appRow.id).map((row) => ({ ...row, assessment: parseStoredJson(row.assessment_json) }));
  const artifacts = db.prepare(`
    SELECT id, artifact_kind, label, local_path, created_at
    FROM application_artifacts WHERE application_id = ? ORDER BY id DESC
  `).all(appRow.id);
  res.json({ application: appRow, job, handoffs, artifacts });
});

app.get("/api/export/portable", (req, res) => {
  if (!isTrustedUiOrigin(req.get("Origin"))) {
    return res.status(403).json({ error: "数据导出仅允许从本地工作台访问。" });
  }
  const applications = db.prepare(`
    SELECT a.*, j.source_url, j.title, j.company, j.location, j.salary, j.jd_text, j.match_score, j.job_tier
    FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY a.updated_at DESC
  `).all();
  const handoffs = db.prepare("SELECT * FROM application_handoffs ORDER BY id DESC").all();
  const artifacts = db.prepare("SELECT * FROM application_artifacts ORDER BY id DESC").all();
  res.setHeader("Content-Disposition", `attachment; filename=\"resumatch-workbench-${new Date().toISOString().slice(0, 10)}.json\"`);
  res.json({ schema_version: "resumatch-workbench-export/v1", exported_at: new Date().toISOString(), applications, handoffs, artifacts });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`ResuMatch local workbench ${appVersion}: http://127.0.0.1:${port}`);
});

function findApplication(id) {
  return (
    db.prepare("SELECT * FROM applications WHERE id = ?").get(Number(id)) ||
    db.prepare("SELECT * FROM applications WHERE job_id = ?").get(Number(id))
  );
}

function parseStoredJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function isTrustedUiOrigin(origin) {
  if (!origin) return true;
  if (trustedUiOrigins.has(origin)) return true;
  return false;
}

function isTrustedApiOrigin(origin) {
  if (trustedExtensionOrigins.has(origin)) return true;
  if (trustedUiOrigins.has(origin)) return true;
  if (!origin) return true;
  return false;
}

function readExtensionIds() {
  const ids = String(process.env.WORKBENCH_EXTENSION_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length || ids.some((id) => !/^[a-p]{32}$/.test(id))) {
    throw new Error("Fatal Error: WORKBENCH_EXTENSION_IDS must contain one or more Chrome extension IDs.");
  }
  return [...new Set(ids)];
}

function loadLocalWorkbenchEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (value) process.env[match[1]] = value;
  }
}

function requireWorkbenchApiToken() {
  const token = String(process.env.WORKBENCH_API_TOKEN || "");
  if (token.length < 32) {
    throw new Error("Fatal Error: WORKBENCH_API_TOKEN must be at least 32 characters.");
  }
  return token;
}

function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function validateHandoffPackage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请导入 ResuMatch 交接包 JSON。" );
  }
  if (value.schema_version !== HANDOFF_SCHEMA || typeof value.job_description !== "string" || !value.job_description.trim()) {
    throw new Error("不支持的 ResuMatch 交接包版本或内容。" );
  }
  if (value.job_description.length > 20_000 || !value.assessment || typeof value.assessment !== "object" || Array.isArray(value.assessment)) {
    throw new Error("ResuMatch 交接包内容无效。" );
  }
  for (const key of ["matched_points", "risk_points", "improvement_path", "interview_focus"]) {
    const items = value.assessment[key] ?? [];
    if (!Array.isArray(items) || items.length > 50) throw new Error(`交接包字段 ${key} 无效。`);
  }
  return { job_description: value.job_description.trim(), assessment: value.assessment };
}

function validateTailorManifest(value) {
  if (!value || typeof value !== "object" || value.schema_version !== TAILOR_MANIFEST_SCHEMA || !Array.isArray(value.artifacts)) {
    throw new Error("不支持的 Resume Tailor 产物清单。" );
  }
  if (!value.artifacts.length || value.artifacts.length > 3) throw new Error("产物清单为空或数量异常。" );
  const rootPrefix = `${RESUME_TAILOR_OUTPUT_DIR}${path.sep}`.toLowerCase();
  const artifacts = value.artifacts.map((item) => {
    const candidatePath = path.resolve(String(item?.path || ""));
    if (!candidatePath.toLowerCase().startsWith(rootPrefix) || !fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
      throw new Error("产物路径不在 Resume Tailor outputs 目录中或文件不存在。" );
    }
    const kind = String(item?.kind || "").trim();
    if (!new Set(["resume_docx", "verification_brief"]).has(kind)) throw new Error("产物类型无效。" );
    return { kind, path: candidatePath, label: String(item?.label || path.basename(candidatePath)).trim().slice(0, 160) };
  });
  return { artifacts };
}

async function evaluateJobsForQueue(jobs, options = {}) {
  const dailyLimit = Number(options.daily_recommendation_limit || 20);
  const remaining = getDailyRecommendationRemaining(db, dailyLimit);
  const evaluated = [];
  let recommendedAdded = 0;

  for (const job of jobs) {
    let report;
    try {
      report = await evaluateAndSaveJob(job, options);
    } catch (error) {
      report = buildFallbackReport(job, options, error);
      saveCandidateReport(job.id, report);
      evaluated.push({
        job_id: job.id,
        title: job.title,
        queue_status: report.queue_status,
        should_apply: report.should_apply,
        reject_reasons: report.reject_reasons || [],
        risk_flags: report.risk_flags || [],
        error: error.message
      });
      continue;
    }

    if (report.queue_status === "recommended" && recommendedAdded < remaining) {
      recommendedAdded += 1;
    } else if (report.queue_status === "recommended") {
      report.queue_status = "needs_review";
      report.risk_flags = [...new Set([...(report.risk_flags || []), "daily_recommendation_limit_reached"])];
      report.should_apply = false;
      saveCandidateReport(job.id, report);
    }

    evaluated.push({
      job_id: job.id,
      title: job.title,
      queue_status: report.queue_status,
      should_apply: report.should_apply,
      reject_reasons: report.reject_reasons || [],
      risk_flags: report.risk_flags || []
    });
  }

  if (recommendedAdded) incrementRecommendedMetric(db, recommendedAdded);
  return evaluated;
}

async function evaluateAndSaveJob(job, options = {}) {
  const userProfile = buildUserProfile(options);
  const aiReport = await evaluateJob(job, userProfile);
  const localGreetingResult = generateGreetingsLocally(job, aiReport, userProfile);
  let greetingResult = localGreetingResult;
  const preliminary = normalizeCandidateReport(job, aiReport, greetingResult, options);
  if (preliminary.queue_status !== "not_recommended") {
    const remoteGreetingResult = await generateGreetings(job, aiReport, userProfile).catch(() => ({}));
    greetingResult = chooseBetterGreeting(job, remoteGreetingResult, localGreetingResult);
  }
  const report = normalizeCandidateReport(job, aiReport, greetingResult, options);
  saveCandidateReport(job.id, report);
  return report;
}

function chooseBetterGreeting(job, remoteGreetingResult = {}, localGreetingResult = {}) {
  const remoteGreeting = String(remoteGreetingResult?.greetings?.find(Boolean) || "").trim();
  const localGreeting = String(localGreetingResult?.greetings?.find(Boolean) || "").trim();
  if (!remoteGreeting) return localGreetingResult;
  if (!localGreeting) return remoteGreetingResult;
  if (isGenericGreeting(remoteGreeting, job)) return localGreetingResult;
  if (extractReferencedJdTerms(localGreeting, job).length > extractReferencedJdTerms(remoteGreeting, job).length) {
    return localGreetingResult;
  }
  return remoteGreetingResult;
}

function isGenericGreeting(greeting, job) {
  const text = String(greeting || "").trim();
  if (!text) return true;
  const jdTerms = extractReferencedJdTerms(text, job);
  if (!jdTerms.length) return true;
  const genericPatterns = [
    /方向比较贴近/,
    /岗位方向比较贴近/,
    /想进一步了解这个岗位当前最看重的业务目标/,
    /团队希望我优先补位的部分/,
    /如果方便的话/
  ];
  return genericPatterns.filter((pattern) => pattern.test(text)).length >= 2 && jdTerms.length <= 1;
}

function extractReferencedJdTerms(greeting, job) {
  const source = `${job?.title || ""} ${job?.jd_text || ""}`;
  const candidates = [
    "AI Agent",
    "智能体",
    "工作流",
    "需求拆解",
    "跨团队推进",
    "数据分析",
    "指标体系",
    "企业服务",
    "B端",
    "SaaS",
    "降本增效",
    "AI解决方案",
    "业务场景",
    "大模型",
    "LLM",
    "RAG",
    "产品规划",
    "项目落地",
    "流程梳理"
  ];
  return candidates.filter((term) => source.includes(term) && String(greeting || "").includes(term));
}
function buildFallbackReport(job, options = {}, error) {
  const localReport = normalizeCandidateReport(job, evaluateLocally(job, options), {}, options);
  return {
    ...localReport,
    risk_flags: [...new Set([...(localReport.risk_flags || []), "worker_unavailable"])],
    tier_reason: error?.message
      ? `AI 评估暂时不可用:${error.message}`
      : "AI 评估暂时不可用,先按本地规则排队。"
  };
}

function buildPendingReport(job, options = {}) {
  const localReport = normalizeCandidateReport(job, evaluateLocally(job, options), {}, options);
  return {
    ...localReport,
    tier_reason: "已导入,等待 AI 评估补全。"
  };
}

function saveCandidateReport(jobId, report) {
  db.prepare(`
    UPDATE jobs
    SET match_report_json = ?, match_score = ?, job_tier = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(report), Number(report.match_score || 0), String(report.job_tier || ""), jobId);
}

function tagApplicationSearchBatch(db, jobId, searchBatchId) {
  if (!searchBatchId) return;
  db.prepare(`
    UPDATE applications
    SET search_batch_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND status IN ('queued', 'paused')
  `).run(searchBatchId, jobId);
}

function withCandidateFields(row) {
  let report = {};
  try {
    report = JSON.parse(row.match_report_json || "{}");
  } catch {}
  return {
    ...row,
    should_apply: Boolean(report.should_apply),
    queue_status: report.queue_status || "needs_review",
    reject_reasons: report.reject_reasons || [],
    risk_flags: report.risk_flags || [],
    greeting_draft: report.greeting_draft || "",
    tier_reason: report.tier_reason || report.summary || ""
  };
}

function withReplyFields(row) {
  return {
    ...row,
    reply_bucket: getReplyBucket(row.feedback_intent),
    is_reply_handled: Boolean(row.reply_handled_at)
  };
}

function matchApplicationForConversation(item) {
  const sourceUrl = String(item?.source_url || "").trim();
  if (sourceUrl) {
    const byUrl = db.prepare(`
      SELECT a.*, j.id AS job_id, j.source_url, j.title, j.company
      FROM applications a
      JOIN jobs j ON j.id = a.job_id
      WHERE j.source_url = ?
      LIMIT 1
    `).get(sourceUrl);
    if (byUrl) return byUrl;
  }

  const title = String(item?.title || "").trim();
  const company = String(item?.company || "").trim();
  if (!title && !company) return null;

  return db.prepare(`
    SELECT a.*, j.id AS job_id, j.source_url, j.title, j.company
    FROM applications a
    JOIN jobs j ON j.id = a.job_id
    WHERE (? = '' OR j.title LIKE '%' || ? || '%')
      AND (? = '' OR j.company LIKE '%' || ? || '%')
    ORDER BY j.updated_at DESC
    LIMIT 1
  `).get(title, title, company, company);
}

async function syncConversations(conversations, options = {}) {
  const result = {
    synced_conversations: 0,
    matched_applications: 0,
    supplemented_count: 0,
    unmatched_count: 0,
    new_reply_count: 0,
    resume_request_count: 0,
    interview_count: 0,
    needs_review_count: 0,
    rejected_count: 0,
    new_message_count: 0,
    classified_count: 0,
    stopped_reason: "",
    items: []
  };

  const conversationLimit = Math.max(1, Math.min(Number(options.limit || 200), 200));
  for (const item of conversations.slice(0, conversationLimit)) {
    const conversation = Array.isArray(item?.conversation) ? item.conversation.filter((entry) => entry?.text) : [];
    if (!conversation.length) continue;
    result.synced_conversations += 1;
    let appRow = matchApplicationForConversation(item);
    let supplemented = false;

    if (!appRow && options.allowSupplement && hasSupplementPayload(item)) {
      appRow = ensureSupplementApplication(db, buildSupplementJob(item));
      supplemented = true;
      result.supplemented_count += 1;
    }

    if (!appRow) {
      result.unmatched_count += 1;
      continue;
    }

    const conversationKey = String(item.conversation_key || `job-${appRow.job_id}-${String(item.company || "").trim()}-${String(item.title || "").trim()}`).trim();
    const messageRows = conversation.slice(-12);
    let insertedCount = 0;
    let insertedInboundCount = 0;

    for (const message of messageRows) {
      const payload = {
        application_id: appRow.id,
        conversation_key: conversationKey,
        message_key: String(message.message_key || message.id || "").trim(),
        message_hash: buildMessageHash({
          conversation_key: conversationKey,
          company: item.company,
          title: item.title,
          sent_at: message.sent_at,
          sender: message.sender,
          text: message.text
        }),
        sync_run_id: options.syncRunId ?? null,
        direction: message.direction || (String(message.sender || "").toLowerCase() === "me" ? "outbound" : "inbound"),
        sender: message.sender || "hr",
        text: message.text || "",
        source_url: item.source_url || ""
      };
      const inserted = insertMessageIfNew(db, payload);
      if (inserted.inserted) {
        insertedCount += 1;
        if (payload.direction !== "outbound") insertedInboundCount += 1;
      }
      if (inserted.updated && payload.direction !== "outbound") {
        insertedInboundCount += 1;
      }
    }

    result.new_message_count += insertedCount;
    const shouldReanalyzeExisting = Boolean(options.reanalyzeExisting);
    if (insertedCount === 0 && insertedInboundCount === 0 && !shouldReanalyzeExisting) {
      continue;
    }

    const analysis = await analyzeMessages(messageRows);
    analysis.last_message_at = item.last_message_at || messageRows[messageRows.length - 1]?.sent_at || new Date().toISOString();
    analysis.last_message_text =
      [...messageRows].reverse().find((entry) => String(entry?.sender || "").toLowerCase() !== "me")?.text ||
      messageRows[messageRows.length - 1]?.text ||
      "";
    analysis.clear_reply_handled = insertedInboundCount > 0;
    applyMessageAnalysis(db, appRow.id, analysis);

    result.matched_applications += 1;
    result.classified_count += 1;
    if (insertedCount > 0 || !appRow.last_replied_at) {
      result.new_reply_count += 1;
    }

    switch (analysis.intent) {
      case REPLY_INTENTS.INTERVIEW:
        result.interview_count += 1;
        break;
      case REPLY_INTENTS.RESUME_REQUEST:
        result.resume_request_count += 1;
        break;
      case REPLY_INTENTS.REJECT_EXPERIENCE:
      case REPLY_INTENTS.REJECT_DIRECTION:
      case REPLY_INTENTS.REJECT_LOCATION:
        result.rejected_count += 1;
        break;
      default:
        result.needs_review_count += 1;
        break;
    }

    const refreshed = findApplication(appRow.id);
    result.items.push({
      application_id: refreshed.id,
      job_id: refreshed.job_id,
      title: item.title || "",
      company: item.company || "",
      source_kind: refreshed.source_kind,
      supplemented,
      intent: analysis.intent,
      status: refreshed.status,
      last_message_at: analysis.last_message_at,
      last_message_text: analysis.last_message_text
    });
  }

  refreshDashboardMetrics();
  return result;
}

function buildReplySummary() {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN reply_handled_at IS NULL AND last_replied_at IS NOT NULL THEN 1 ELSE 0 END) AS new_reply_count,
      SUM(CASE WHEN reply_handled_at IS NULL AND feedback_intent = ? THEN 1 ELSE 0 END) AS resume_request_count,
      SUM(CASE WHEN reply_handled_at IS NULL AND feedback_intent = ? THEN 1 ELSE 0 END) AS interview_count,
      SUM(
        CASE
          WHEN reply_handled_at IS NULL
           AND last_replied_at IS NOT NULL
           AND (feedback_intent IS NULL OR feedback_intent IN (?, ?, ?))
          THEN 1 ELSE 0
        END
      ) AS needs_review_count,
      SUM(CASE WHEN reply_handled_at IS NULL AND source_kind = 'auto_supplement' THEN 1 ELSE 0 END) AS supplement_count
    FROM applications
  `).get(
    REPLY_INTENTS.RESUME_REQUEST,
    REPLY_INTENTS.INTERVIEW,
    REPLY_INTENTS.WECHAT,
    REPLY_INTENTS.GREETING,
    REPLY_INTENTS.NO_EFFECTIVE_FEEDBACK
  );

  return {
    new_reply_count: Number(row?.new_reply_count || 0),
    resume_request_count: Number(row?.resume_request_count || 0),
    interview_count: Number(row?.interview_count || 0),
    needs_review_count: Number(row?.needs_review_count || 0),
    supplement_count: Number(row?.supplement_count || 0)
  };
}

function refreshDashboardMetrics() {
  refreshDailyMetrics(db);
}

function summarizeEvaluationResults(evaluated) {
  const summary = {
    queued_candidates: 0,
    recommended_count: 0,
    needs_review_count: 0,
    not_recommended_count: 0,
    candidate_job_ids: [],
    top_reject_reasons: []
  };
  const reasonCounts = new Map();

  for (const item of evaluated || []) {
    if (item.queue_status === "recommended") {
      summary.recommended_count += 1;
      summary.queued_candidates += 1;
      summary.candidate_job_ids.push(Number(item.job_id));
    } else if (item.queue_status === "needs_review") {
      summary.needs_review_count += 1;
      summary.queued_candidates += 1;
      summary.candidate_job_ids.push(Number(item.job_id));
    } else {
      summary.not_recommended_count += 1;
    }

    for (const reason of item.reject_reasons || []) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  }

  summary.top_reject_reasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));
  summary.candidate_job_ids = [...new Set(summary.candidate_job_ids.filter(Number.isFinite))];

  return summary;
}

function normalizeImportFilters(options = {}) {
  return {
    job_titles: arrayFrom(options.job_titles || options.titles || options.title),
    jd_keywords: arrayFrom(options.jd_keywords || options.keywords),
    salary_min: toNumberOrNull(options.salary_min),
    salary_max: toNumberOrNull(options.salary_max),
    company_size_min: toNumberOrNull(options.company_size_min),
    company_size_max: toNumberOrNull(options.company_size_max)
  };
}

function addCounts(target, keys = []) {
  for (const key of keys || []) {
    target[key] = (target[key] || 0) + 1;
  }
}

function arrayFrom(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[,,、\s\n\r\t]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumberOrNull(value) {
  const number = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isUsableJobTitle(value) {
  const title = String(value || "").trim();
  return Boolean(title && !["查看更多信息", "职位搜索"].includes(title));
}

function hasSupplementPayload(item) {
  return Boolean(
    String(item?.conversation_key || "").trim() ||
      String(item?.source_url || "").trim() ||
      String(item?.title || "").trim() ||
      String(item?.company || "").trim()
  );
}

function buildSupplementUrl(item) {
  const key = String(item?.conversation_key || item?.source_url || `${item?.title || "unknown"}:${item?.company || "unknown"}`).trim();
  return `boss://supplement/${encodeURIComponent(key)}`;
}

function buildSupplementJob(item) {
  const contact = [String(item?.title || "").trim(), String(item?.company || "").trim()].filter(Boolean).join(" ");
  return {
    source_url: buildSupplementUrl(item),
    title: "历史会话补录（岗位待确认）",
    company: "",
    location: "",
    salary: "",
    company_size: "",
    jd_text: `来源于历史聊天补录。联系人：${contact || "未知"}。岗位信息待确认。`
  };
}
