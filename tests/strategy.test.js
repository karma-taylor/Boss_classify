import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, markReplyHandled, setApplicationStatus, upsertJob } from "../src/db.js";
import { REPLY_INTENTS } from "../src/intents.js";
import { applyMessageAnalysis, buildTomorrowPlan, markStaleNoResponses, overrideReplyIntent, scoreJob } from "../src/strategy.js";

test("feedback adjustment is capped at plus or minus 10 percent", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/1", title: "AI 产品经理", jd_text: "AI 产品经理 企业流程" });
  db.prepare("UPDATE jobs SET match_score = 80, job_tier = 'A' WHERE id = ?").run(job.id);
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);

  applyMessageAnalysis(db, app.id, { intent: REPLY_INTENTS.INTERVIEW, reason: "约面试", confidence: 0.9 });
  const scored = scoreJob(db, db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id));
  assert.ok(scored.dynamic_adjustment <= 0.1);
  assert.equal(scored.final_score, 88);
  db.close();
});

test("message analysis updates status and timestamps for resume requests", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/rr", title: "AI 产品经理", jd_text: "AI 产品经理 JD" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);

  applyMessageAnalysis(db, app.id, {
    intent: REPLY_INTENTS.RESUME_REQUEST,
    reason: "请发一份最新简历",
    last_message_at: "2026-07-03T09:00:00.000Z",
    last_message_text: "请发一份最新简历"
  });

  const updated = db.prepare("SELECT status, interested_at, resume_request_at, last_replied_at, feedback_intent FROM applications WHERE id = ?").get(app.id);
  assert.equal(updated.status, "interested");
  assert.equal(updated.feedback_intent, REPLY_INTENTS.RESUME_REQUEST);
  assert.equal(updated.last_replied_at, "2026-07-03T09:00:00.000Z");
  assert.equal(updated.resume_request_at, "2026-07-03T09:00:00.000Z");
  assert.equal(updated.interested_at, "2026-07-03T09:00:00.000Z");
  db.close();
});

test("reply handled can be cleared by a new HR reply", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/handled", title: "AI 产品经理", jd_text: "AI 产品经理 JD" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);

  markReplyHandled(db, job.id);
  applyMessageAnalysis(db, app.id, {
    intent: REPLY_INTENTS.WECHAT,
    reason: "加微信继续聊",
    last_message_at: "2026-07-03T12:00:00.000Z",
    last_message_text: "加微信继续聊"
  });

  const updated = db.prepare("SELECT reply_handled_at, status FROM applications WHERE id = ?").get(app.id);
  assert.equal(updated.reply_handled_at, null);
  assert.equal(updated.status, "interested");
  db.close();
});

test("duplicate analysis does not reopen handled replies or duplicate feedback signals", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/idempotent", title: "AI 产品经理", jd_text: "AI 产品经理 JD" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);
  const analysis = {
    intent: REPLY_INTENTS.INTERVIEW,
    reason: "约面试",
    last_message_at: "2026-07-03T12:00:00.000Z",
    last_message_text: "约面试"
  };

  applyMessageAnalysis(db, app.id, analysis);
  const firstCount = db.prepare("SELECT COUNT(*) AS count FROM feedback_signals WHERE application_id = ?").get(app.id).count;
  markReplyHandled(db, job.id);
  applyMessageAnalysis(db, app.id, { ...analysis, clear_reply_handled: false });
  const updated = db.prepare("SELECT reply_handled_at FROM applications WHERE id = ?").get(app.id);
  const secondCount = db.prepare("SELECT COUNT(*) AS count FROM feedback_signals WHERE application_id = ?").get(app.id).count;

  assert.ok(updated.reply_handled_at);
  assert.equal(secondCount, firstCount);
  db.close();
});

test("manual override can promote a reply to interview", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/manual", title: "AI 产品经理", jd_text: "AI 产品经理 JD" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);

  overrideReplyIntent(db, app.id, REPLY_INTENTS.INTERVIEW);
  const updated = db.prepare("SELECT status, interview_at, feedback_intent FROM applications WHERE id = ?").get(app.id);
  assert.equal(updated.status, "interview");
  assert.equal(updated.feedback_intent, REPLY_INTENTS.INTERVIEW);
  assert.ok(updated.interview_at);
  db.close();
});

test("tomorrow plan keeps about 20 percent exploration", () => {
  const db = openDb(tempDb());
  const positive = upsertJob(db, { source_url: "https://example.com/p", title: "AI 产品经理", jd_text: "AI 产品经理" });
  db.prepare("UPDATE jobs SET match_score = 80, job_tier = 'A' WHERE id = ?").run(positive.id);
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(positive.id);
  applyMessageAnalysis(db, app.id, { intent: REPLY_INTENTS.INTERVIEW, reason: "约面试" });

  for (let i = 0; i < 10; i += 1) {
    const job = upsertJob(db, { source_url: `https://example.com/${i}`, title: i < 5 ? "AI 产品经理" : "B端产品经理", jd_text: "企业工具 JD" });
    db.prepare("UPDATE jobs SET match_score = ?, job_tier = 'B' WHERE id = ?").run(65 + i, job.id);
  }

  const plan = buildTomorrowPlan(db, { limit: 10, planDate: "2026-07-03" });
  const exploration = plan.filter((item) => item.plan_type === "exploration");
  assert.ok(exploration.length >= 1);
  assert.ok(exploration.length <= 3);
  db.close();
});

test("no-response window does not downgrade before configured days", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/n", title: "产品经理", jd_text: "产品经理 JD" });
  setApplicationStatus(db, job.id, "applied");
  db.prepare("UPDATE applications SET applied_at = datetime('now', '-2 days') WHERE job_id = ?").run(job.id);
  markStaleNoResponses(db, 5);
  assert.equal(db.prepare("SELECT status FROM applications WHERE job_id = ?").get(job.id).status, "applied");
  db.prepare("UPDATE applications SET applied_at = datetime('now', '-6 days') WHERE job_id = ?").run(job.id);
  markStaleNoResponses(db, 5);
  assert.equal(db.prepare("SELECT status FROM applications WHERE job_id = ?").get(job.id).status, "no_response");
  db.close();
});

test("preferred locations adjust base score without blocking jobs", () => {
  const db = openDb(tempDb());
  const shanghai = upsertJob(db, { source_url: "https://example.com/sh", title: "AI 产品经理", location: "上海", jd_text: "AI 产品经理 JD" });
  const beijing = upsertJob(db, { source_url: "https://example.com/bj", title: "AI 产品经理", location: "北京", jd_text: "AI 产品经理 JD" });
  db.prepare("UPDATE jobs SET match_score = 70, job_tier = 'B' WHERE id IN (?, ?)").run(shanghai.id, beijing.id);

  const preferred = { preferred_locations: ["上海"] };
  const shanghaiScore = scoreJob(db, db.prepare("SELECT * FROM jobs WHERE id = ?").get(shanghai.id), preferred);
  const beijingScore = scoreJob(db, db.prepare("SELECT * FROM jobs WHERE id = ?").get(beijing.id), preferred);

  assert.equal(shanghaiScore.base_score, 75);
  assert.equal(beijingScore.base_score, 67);
  assert.match(shanghaiScore.reason, /倾向工作地点/);
  assert.match(beijingScore.reason, /未命中倾向工作地点/);
  db.close();
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resumatch-"));
  return path.join(dir, "test.db");
}
