import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getBrowserStatus } from "../src/browser.js";
import {
  cleanupInvalidSupplementApplications,
  ensureSupplementApplication,
  getHistoryDailySummary,
  getHistorySummary,
  getCollectionFilterLogs,
  insertMessageIfNew,
  insertReplyEventIfFirst,
  openDb,
  refreshDailyMetrics,
  recordCollectionFilterLogs,
  setApplicationStatus,
  upsertJob
} from "../src/db.js";

test("SQLite enables WAL and busy timeout", () => {
  const file = tempDb();
  const db = openDb(file);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  db.close();
});

test("WAL allows a reader while another connection writes", () => {
  const file = tempDb();
  const writer = openDb(file);
  const reader = new DatabaseSync(file, { readOnly: true });

  const insert = writer.prepare("INSERT INTO jobs (source_url, title, jd_hash) VALUES (?, ?, ?)");
  writer.exec("BEGIN");
  try {
    for (let i = 0; i < 50; i += 1) insert.run(`https://example.com/${i}`, `岗位 ${i}`, String(i));
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }

  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 50);
  reader.close();
  writer.close();
});

test("upsertJob stores verified company size metadata", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, {
    source_url: "https://example.com/a",
    title: "AI 产品经理",
    company: "测试公司",
    company_size: "100-499人",
    company_kind: "company",
    company_size_source: "company_basic_info",
    jd_text: "AI 产品经理 JD"
  });
  const saved = db.prepare("SELECT company_size, company_kind, company_size_source FROM jobs WHERE id = ?").get(job.id);
  assert.equal(saved.company_size, "100-499人");
  assert.equal(saved.company_kind, "company");
  assert.equal(saved.company_size_source, "company_basic_info");
  db.close();
});

test("collection filter logs persist local reasons without JD text", () => {
  const db = openDb(tempDb());
  const result = recordCollectionFilterLogs(db, {
    searchBatchId: "batch-filter-log",
    items: [
      { source_url: "https://example.com/a", title: "产品经理", salary: "10-14K", location: "上海", reasons: ["salary_below_minimum"] },
      { source_url: "https://example.com/b", title: "运营", salary: "20-30K", location: "深圳", reasons: ["title_or_keyword_miss"] }
    ]
  });
  const logs = getCollectionFilterLogs(db, "batch-filter-log");
  assert.equal(result.recorded, 2);
  assert.equal(logs.total, 2);
  assert.equal(logs.reason_counts.salary_below_minimum, 1);
  assert.equal(logs.entries[0].jd_text, undefined);
  db.close();
});

test("daily metrics anchor later reply stages to the initial contact day", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/reply", title: "AI 产品经理", jd_text: "AI 产品经理 JD" });
  setApplicationStatus(db, job.id, "applied", { applied_at: "2026-07-01T10:00:00.000Z" });
  setApplicationStatus(db, job.id, "interested", {
    first_replied_at: "2026-07-02T09:00:00.000Z",
    last_replied_at: "2026-07-02T09:00:00.000Z",
    resume_request_at: "2026-07-02T09:00:00.000Z"
  });
  setApplicationStatus(db, job.id, "interview", {
    first_replied_at: "2026-07-02T09:00:00.000Z",
    last_replied_at: "2026-07-03T11:00:00.000Z",
    interview_at: "2026-07-03T11:00:00.000Z"
  });
  refreshDailyMetrics(db);

  const appliedDay = db.prepare("SELECT applied_count, reply_count, resume_request_count, interview_count FROM daily_metrics WHERE metric_date = ?").get("2026-07-01");
  const laterDay = db.prepare("SELECT applied_count, reply_count, interview_count FROM daily_metrics WHERE metric_date = ?").get("2026-07-02");

  assert.equal(appliedDay.applied_count, 1);
  assert.equal(appliedDay.reply_count, 1);
  assert.equal(appliedDay.resume_request_count, 1);
  assert.equal(appliedDay.interview_count, 1);
  assert.equal(laterDay, undefined);
  db.close();
});

test("daily metrics fall back to the first HR reply when no application date exists", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/hr-first", title: "AI 产品经理", jd_text: "AI 产品经理 JD" });
  setApplicationStatus(db, job.id, "interview", {
    first_replied_at: "2026-07-02T09:00:00.000Z",
    last_replied_at: "2026-07-03T10:00:00.000Z",
    interview_at: "2026-07-03T10:00:00.000Z"
  });
  refreshDailyMetrics(db);

  const firstReplyDay = db.prepare("SELECT applied_count, reply_count, interview_count FROM daily_metrics WHERE metric_date = ?").get("2026-07-02");
  const interviewDay = db.prepare("SELECT metric_date FROM daily_metrics WHERE metric_date = ?").get("2026-07-03");

  assert.equal(firstReplyDay.applied_count, 0);
  assert.equal(firstReplyDay.reply_count, 1);
  assert.equal(firstReplyDay.interview_count, 1);
  assert.equal(interviewDay, undefined);
  db.close();
});

test("supplement applications are excluded from main reply denominator by default", () => {
  const db = openDb(tempDb());
  const manual = upsertJob(db, { source_url: "https://example.com/manual", title: "AI 产品经理", jd_text: "AI JD" });
  setApplicationStatus(db, manual.id, "applied", { applied_at: "2026-07-01T10:00:00.000Z" });
  setApplicationStatus(db, manual.id, "interview", {
    first_replied_at: "2026-07-02T10:00:00.000Z",
    last_replied_at: "2026-07-02T10:00:00.000Z",
    interview_at: "2026-07-02T10:00:00.000Z"
  });
  const manualApplication = db.prepare("SELECT id FROM applications WHERE job_id = ?").get(manual.id);
  insertReplyEventIfFirst(db, { application_id: manualApplication.id, event_type: "interview", occurred_at: "2026-07-02T10:00:00.000Z", time_precision: "exact" });

  const supplement = ensureSupplementApplication(db, {
    source_url: "boss://supplement/unknown/1",
    title: "AI 产品经理",
    company: "陌生公司",
    jd_text: "来源于历史聊天补录"
  });
  assert.equal(supplement.status, "supplement");
  assert.equal(supplement.source_kind, "auto_supplement");
  assert.equal(supplement.reply_rate_eligible, 0);
  setApplicationStatus(db, supplement.job_id, "interview", {
    first_seen_at: "2026-07-02T09:00:00.000Z",
    first_replied_at: "2026-07-02T11:00:00.000Z",
    last_replied_at: "2026-07-02T11:00:00.000Z",
    interview_at: "2026-07-02T11:00:00.000Z"
  });
  insertReplyEventIfFirst(db, { application_id: supplement.id, event_type: "interview", occurred_at: "2026-07-02T11:00:00.000Z", time_precision: "exact" });

  const summary = getHistorySummary(db, {
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-03T23:59:59.000Z"
  });

  assert.equal(summary.applied_count, 1);
  assert.equal(summary.reply_count, 1);
  assert.equal(summary.interview_count, 1);
  assert.equal(summary.supplement_count, 1);
  assert.equal(summary.supplement_reply_count, 1);
  db.close();
});

test("repair removes legacy manual supplement records but preserves real supplements", () => {
  const db = openDb(tempDb());
  const legacy = upsertJob(db, {
    source_url: "boss://supplement/legacy",
    title: "招聘联系人",
    jd_text: "错误补录"
  });
  const real = ensureSupplementApplication(db, {
    source_url: "boss://supplement/real",
    title: "历史会话补录（岗位待确认）",
    jd_text: "来源于历史聊天补录"
  });

  assert.equal(cleanupInvalidSupplementApplications(db), 1);
  assert.equal(db.prepare("SELECT id FROM jobs WHERE id = ?").get(legacy.id), undefined);
  assert.ok(db.prepare("SELECT id FROM jobs WHERE id = ?").get(real.job_id));
  db.close();
});

test("history daily summary returns absolute counts by first contact day and stays aligned with summary totals", () => {
  const db = openDb(tempDb());

  const manual = upsertJob(db, {
    source_url: "https://example.com/history-daily-manual",
    title: "AI 产品经理",
    company: "测试公司",
    jd_text: "AI 产品经理 JD"
  });
  setApplicationStatus(db, manual.id, "applied", {
    applied_at: "2026-07-01T10:00:00.000Z"
  });
  setApplicationStatus(db, manual.id, "interested", {
    first_replied_at: "2026-07-03T11:00:00.000Z",
    last_replied_at: "2026-07-03T11:00:00.000Z",
    interested_at: "2026-07-03T11:00:00.000Z",
    resume_request_at: "2026-07-03T11:00:00.000Z"
  });
  setApplicationStatus(db, manual.id, "interview", {
    first_replied_at: "2026-07-03T11:00:00.000Z",
    last_replied_at: "2026-07-04T12:00:00.000Z",
    interested_at: "2026-07-03T11:00:00.000Z",
    resume_request_at: "2026-07-03T11:00:00.000Z",
    interview_at: "2026-07-04T12:00:00.000Z"
  });
  const manualApplication = db.prepare("SELECT id FROM applications WHERE job_id = ?").get(manual.id);
  insertReplyEventIfFirst(db, { application_id: manualApplication.id, event_type: "resume_request", occurred_at: "2026-07-03T11:00:00.000Z", time_precision: "exact" });
  insertReplyEventIfFirst(db, { application_id: manualApplication.id, event_type: "interview", occurred_at: "2026-07-04T12:00:00.000Z", time_precision: "exact" });

  const supplement = ensureSupplementApplication(db, {
    source_url: "boss://supplement/history-daily/1",
    title: "AI 产品经理",
    company: "补录公司",
    jd_text: "补录来源"
  });
  setApplicationStatus(db, supplement.job_id, "interview", {
    source_kind: "auto_supplement",
    reply_rate_eligible: 0,
    first_seen_at: "2026-07-04T08:00:00.000Z",
    first_replied_at: "2026-07-04T09:00:00.000Z",
    last_replied_at: "2026-07-04T09:00:00.000Z",
    interested_at: "2026-07-04T09:00:00.000Z",
    resume_request_at: "2026-07-04T09:00:00.000Z",
    interview_at: "2026-07-04T09:00:00.000Z"
  });
  insertReplyEventIfFirst(db, { application_id: supplement.id, event_type: "resume_request", occurred_at: "2026-07-04T09:00:00.000Z", time_precision: "exact" });
  insertReplyEventIfFirst(db, { application_id: supplement.id, event_type: "interview", occurred_at: "2026-07-04T09:00:00.000Z", time_precision: "exact" });

  const range = {
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-05T23:59:59.000Z"
  };

  const dailyDefault = getHistoryDailySummary(db, range);
  const dailyWithSupplement = getHistoryDailySummary(db, { ...range, include_supplement: true });
  const summaryDefault = getHistorySummary(db, range);
  const summaryWithSupplement = getHistorySummary(db, { ...range, include_supplement: true });

  const byDateDefault = Object.fromEntries(dailyDefault.map((row) => [row.metric_date, row]));
  const byDateWithSupplement = Object.fromEntries(dailyWithSupplement.map((row) => [row.metric_date, row]));

  assert.equal(byDateDefault["2026-07-01"].applied_count, 1);
  assert.equal(byDateDefault["2026-07-01"].reply_count, 1);
  assert.equal(byDateDefault["2026-07-01"].resume_request_count, 1);
  assert.equal(byDateDefault["2026-07-01"].interview_count, 1);
  assert.equal(byDateDefault["2026-07-04"].supplement_count, 1);
  assert.equal(byDateDefault["2026-07-04"].reply_count, 0);

  assert.equal(byDateWithSupplement["2026-07-04"].reply_count, 1);
  assert.equal(byDateWithSupplement["2026-07-04"].resume_request_count, 1);
  assert.equal(byDateWithSupplement["2026-07-04"].interview_count, 1);
  assert.equal(byDateWithSupplement["2026-07-04"].supplement_count, 1);

  assert.deepEqual(
    Object.keys(dailyDefault[0]).sort(),
    ["applied_count", "interview_count", "metric_date", "reply_count", "resume_request_count", "supplement_count"].sort()
  );

  const sumRows = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

  assert.equal(sumRows(dailyDefault, "applied_count"), summaryDefault.applied_count);
  assert.equal(sumRows(dailyDefault, "reply_count"), summaryDefault.reply_count);
  assert.equal(sumRows(dailyDefault, "resume_request_count"), summaryDefault.resume_request_count);
  assert.equal(sumRows(dailyDefault, "interview_count"), summaryDefault.interview_count);
  assert.equal(sumRows(dailyDefault, "supplement_count"), summaryDefault.supplement_count);

  assert.equal(sumRows(dailyWithSupplement, "applied_count"), summaryWithSupplement.applied_count);
  assert.equal(sumRows(dailyWithSupplement, "reply_count"), summaryWithSupplement.reply_count);
  assert.equal(sumRows(dailyWithSupplement, "resume_request_count"), summaryWithSupplement.resume_request_count);
  assert.equal(sumRows(dailyWithSupplement, "interview_count"), summaryWithSupplement.interview_count);
  assert.equal(sumRows(dailyWithSupplement, "supplement_count"), summaryWithSupplement.supplement_count);

  const laterOnly = getHistoryDailySummary(db, {
    start: "2026-07-03T00:00:00.000Z",
    end: "2026-07-05T23:59:59.000Z"
  });
  assert.equal(laterOnly.some((row) => row.metric_date === "2026-07-03"), false);

  db.close();
});

test("message dedupe prefers conversation key and message key", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/msg", title: "AI 产品经理", jd_text: "AI JD" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);

  const first = insertMessageIfNew(db, {
    application_id: app.id,
    conversation_key: "conv-1",
    message_key: "msg-1",
    sender: "hr",
    text: "您好",
    sent_at: "2026-07-03T10:00:00.000Z"
  });
  const duplicate = insertMessageIfNew(db, {
    application_id: app.id,
    conversation_key: "conv-1",
    message_key: "msg-1",
    sender: "hr",
    text: "您好",
    sent_at: "2026-07-03T10:00:00.000Z"
  });

  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 1);
  db.close();
});

test("message dedupe corrects an old outbound label when the same Boss message is re-read as inbound", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/resume-card", title: "AI 产品经理", jd_text: "AI JD" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);
  insertMessageIfNew(db, {
    application_id: app.id,
    conversation_key: "conv-resume",
    message_key: "msg-resume",
    sender: "me",
    direction: "outbound",
    text: "我想要一份您的附件简历，您是否同意",
    sent_at: "2026-07-03T10:00:00.000Z"
  });
  const corrected = insertMessageIfNew(db, {
    application_id: app.id,
    conversation_key: "conv-resume",
    message_key: "msg-resume",
    sender: "hr",
    direction: "inbound",
    text: "我想要一份您的附件简历，您是否同意",
    sent_at: "2026-07-03T10:00:00.000Z"
  });

  assert.equal(corrected.inserted, false);
  assert.equal(corrected.updated, true);
  assert.equal(corrected.row.direction, "inbound");
  assert.equal(corrected.row.sender, "hr");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 1);
  db.close();
});

test("browser status degrades without throwing when CDP is unavailable", async () => {
  const status = await getBrowserStatus();
  assert.equal(typeof status.ok, "boolean");
  assert.ok(status.command.includes("--remote-debugging-port=9222"));
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resumatch-"));
  return path.join(dir, "test.db");
}
