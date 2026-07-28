import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, setManualApplicationStatus, upsertJob } from "../src/db.js";
import { syncHistoryConversations } from "../src/historySync.js";
import { REPLY_INTENTS } from "../src/intents.js";

test("history pipeline accounts for every one of 200 received conversations", async () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/batch", title: "product", jd_text: "agent" });
  const conversations = Array.from({ length: 200 }, (_, index) => ({
    conversation_key: `batch-${index}`,
    source_url: job.source_url,
    conversation: [{ sender: "hr", text: `message ${index}`, sent_at: "2026-07-01T09:00:00.000Z", message_order: 0 }]
  }));
  const result = await syncHistoryConversations(db, conversations, { analyzeMessages: async () => ({ intent: "" }) });
  assert.equal(result.discovered, 200);
  assert.equal(result.processed + result.skipped + result.failed, 200);
  assert.equal(result.processed, 200);
  assert.equal(result.switch_succeeded, 200);
  db.close();
});

test("history pipeline records first resume and interview events but maps review wording to process progress", async () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/events", title: "product", jd_text: "agent" });
  const result = await syncHistoryConversations(db, [{
    conversation_key: "events-1",
    source_url: job.source_url,
    conversation: [
      { sender: "hr", text: "send resume", sent_at: "2026-07-01T09:00:00.000Z", message_order: 0 },
      { sender: "hr", text: "we will review before deciding", sent_at: "2026-07-02T09:00:00.000Z", message_order: 1 },
      { sender: "hr", text: "meet tomorrow", sent_at: "2026-07-03T09:00:00.000Z", message_order: 2 }
    ]
  }], {
    analyzeMessages: async (context) => {
      const text = context.at(-1).text;
      if (text === "send resume") return { intent: REPLY_INTENTS.RESUME_REQUEST, reason: "resume" };
      if (text === "meet tomorrow") return { intent: REPLY_INTENTS.INTERVIEW, reason: "interview" };
      return { intent: "", reason: "review" };
    }
  });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);
  const types = db.prepare("SELECT event_type FROM reply_events WHERE application_id = ? ORDER BY event_type").all(app.id).map((row) => row.event_type);
  assert.deepEqual(types, ["interview", "process_progress", "resume_request"]);
  assert.equal(app.status, "interview");
  assert.equal(app.contact_anchor_at, "2026-07-01T09:00:00.000Z");
  assert.equal(result.events_created, 3);
  db.close();
});

test("unlinked conversations never create auto supplement applications", async () => {
  const db = openDb(tempDb());
  const result = await syncHistoryConversations(db, [{
    conversation_key: "unlinked-1",
    title: "similar name",
    company: "similar company",
    conversation: [{ sender: "hr", text: "hello", sent_at: "2026-07-01T09:00:00.000Z" }]
  }], { analyzeMessages: async () => ({ intent: "" }) });
  assert.equal(result.unlinked_conversations, 1);
  assert.equal(result.skipped, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM applications").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM unlinked_conversations").get().count, 1);
  db.close();
});

test("manual status overrides are not changed by automatic history sync", async () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/manual-history", title: "product", jd_text: "agent" });
  setManualApplicationStatus(db, job.id, "applied", { manual_override_reason: "reviewed" });
  await syncHistoryConversations(db, [{
    conversation_key: "manual-1",
    source_url: job.source_url,
    conversation: [{ sender: "hr", text: "meet tomorrow", sent_at: "2026-07-01T09:00:00.000Z" }]
  }], { analyzeMessages: async () => ({ intent: REPLY_INTENTS.INTERVIEW, reason: "interview" }) });
  const app = db.prepare("SELECT status, manual_status_override FROM applications WHERE job_id = ?").get(job.id);
  assert.equal(app.status, "applied");
  assert.equal(app.manual_status_override, 1);
  db.close();
});

test("history pipeline fails individual bad conversations and rejects batches over 200", async () => {
  const db = openDb(tempDb());
  const result = await syncHistoryConversations(db, [
    { conversation_key: "bad-switch", switch_succeeded: false },
    { conversation_key: "bad-messages", conversation: [] }
  ], { analyzeMessages: async () => ({ intent: "" }) });
  assert.equal(result.failed, 2);
  assert.equal(result.failure_reasons.conversation_switch_failed, 1);
  assert.equal(result.failure_reasons.message_parse_failed, 1);
  await assert.rejects(
    syncHistoryConversations(db, Array.from({ length: 201 }, () => ({})), { analyzeMessages: async () => ({ intent: "" }) }),
    /history_conversation_limit_exceeded/
  );
  await assert.rejects(
    syncHistoryConversations(db, [{ abort_reason: "captcha_required" }], { analyzeMessages: async () => ({ intent: "" }) }),
    /history_scan_aborted:captcha_required/
  );
  db.close();
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resumatch-history-sync-"));
  return path.join(dir, "test.db");
}
