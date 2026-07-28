import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  advanceApplicationStatus,
  bindConversation,
  cleanupLegacyAutoSupplementData,
  ensureSupplementApplication,
  insertMessageIfNew,
  insertReplyEventIfFirst,
  openDb,
  setManualApplicationStatus,
  upsertJob,
  upsertUnlinkedConversation
} from "../src/db.js";

test("reply events keep only the first event of each type", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/events", title: "product", jd_text: "agent" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);
  const resume = insertMessageIfNew(db, {
    application_id: app.id,
    conversation_key: "c-1",
    sender: "hr",
    text: "send resume",
    message_order: 1,
    sent_at: "2026-07-01T09:00:00.000Z",
    time_precision: "exact"
  });
  const interview = insertMessageIfNew(db, {
    application_id: app.id,
    conversation_key: "c-1",
    sender: "hr",
    text: "meet tomorrow",
    message_order: 2,
    sent_at: "2026-07-03T09:00:00.000Z",
    time_precision: "exact"
  });

  assert.equal(insertReplyEventIfFirst(db, {
    application_id: app.id, message_id: resume.row.id, event_type: "resume_request",
    occurred_at: resume.row.sent_at, time_precision: "exact"
  }).inserted, true);
  assert.equal(insertReplyEventIfFirst(db, {
    application_id: app.id, message_id: interview.row.id, event_type: "interview",
    occurred_at: interview.row.sent_at, time_precision: "exact"
  }).inserted, true);
  assert.equal(insertReplyEventIfFirst(db, {
    application_id: app.id, message_id: interview.row.id, event_type: "interview",
    occurred_at: interview.row.sent_at, time_precision: "exact"
  }).inserted, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reply_events WHERE application_id = ?").get(app.id).count, 2);
  db.close();
});

test("process progress is a separate event and never creates an interview event", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/progress", title: "product", jd_text: "agent" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);
  const message = insertMessageIfNew(db, {
    application_id: app.id,
    conversation_key: "c-progress",
    sender: "hr",
    text: "we will review before deciding on an interview",
    message_order: 1,
    sent_at: "2026-07-02T09:00:00.000Z",
    time_precision: "exact"
  });
  insertReplyEventIfFirst(db, {
    application_id: app.id,
    message_id: message.row.id,
    event_type: "process_progress",
    occurred_at: message.row.sent_at,
    time_precision: "exact",
    classification_basis: "review before decision"
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reply_events WHERE application_id = ? AND event_type = 'process_progress'").get(app.id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reply_events WHERE application_id = ? AND event_type = 'interview'").get(app.id).count, 0);
  db.close();
});

test("unknown time is preserved as unknown and cannot create a duplicate", () => {
  const db = openDb(tempDb());
  const message = {
    conversation_key: "c-unknown", sender: "hr", text: "same words", message_order: 4
  };
  const first = insertMessageIfNew(db, message);
  const second = insertMessageIfNew(db, message);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(first.row.sent_at, null);
  assert.equal(first.row.time_precision, "unknown");
  db.close();
});

test("identical text with different DOM order remains distinct without a native id", () => {
  const db = openDb(tempDb());
  const base = { conversation_key: "c-repeat", sender: "hr", text: "please send a resume" };
  assert.equal(insertMessageIfNew(db, { ...base, message_order: 1 }).inserted, true);
  assert.equal(insertMessageIfNew(db, { ...base, message_order: 2 }).inserted, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_key = ?").get("c-repeat").count, 2);
  db.close();
});

test("conversation bindings require an application and unlinked conversations stay separate", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/binding", title: "product", jd_text: "agent" });
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id);
  assert.throws(() => bindConversation(db, { conversation_key: "c-bind", application_id: 999999 }), /application_not_found/);
  bindConversation(db, { conversation_key: "c-bind", application_id: app.id, binding_kind: "job_link" });
  upsertUnlinkedConversation(db, { conversation_key: "c-unlinked", title: "similar name", observed_at: "2026-07-01T10:00:00.000Z" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversation_bindings").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM unlinked_conversations").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM applications").get().count, 1);
  db.close();
});

test("automatic state updates only advance and cannot override a manual status", () => {
  const db = openDb(tempDb());
  const job = upsertJob(db, { source_url: "https://example.com/state", title: "product", jd_text: "agent" });
  advanceApplicationStatus(db, job.id, "interview", { last_replied_at: "2026-07-02T10:00:00.000Z", time_precision: "exact" });
  advanceApplicationStatus(db, job.id, "interested", { last_replied_at: "2026-07-03T10:00:00.000Z", time_precision: "exact" });
  assert.equal(db.prepare("SELECT status FROM applications WHERE job_id = ?").get(job.id).status, "interview");
  setManualApplicationStatus(db, job.id, "applied", { manual_override_reason: "reviewed" });
  advanceApplicationStatus(db, job.id, "interview", { last_replied_at: "2026-07-04T10:00:00.000Z", time_precision: "exact" });
  const finalApp = db.prepare("SELECT status, manual_status_override FROM applications WHERE job_id = ?").get(job.id);
  assert.equal(finalApp.status, "applied");
  assert.equal(finalApp.manual_status_override, 1);
  db.close();
});

test("legacy cleanup previews safely, deletes only disposable supplements, and isolates advanced rows", () => {
  const db = openDb(tempDb());
  const disposable = ensureSupplementApplication(db, { source_url: "boss://supplement/disposable", title: "discard", jd_text: "" });
  const advanced = ensureSupplementApplication(db, { source_url: "boss://supplement/advanced", title: "review", jd_text: "" });
  const preserved = ensureSupplementApplication(db, { source_url: "boss://supplement/preserved", title: "keep", jd_text: "" });
  db.prepare("UPDATE applications SET status = 'interview' WHERE id = ?").run(advanced.id);
  db.prepare("UPDATE applications SET notes = 'reviewed by user' WHERE id = ?").run(preserved.id);

  const preview = cleanupLegacyAutoSupplementData(db);
  assert.equal(preview.candidate_delete_count, 1);
  assert.equal(preview.isolated_count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM applications").get().count, 3);

  const applied = cleanupLegacyAutoSupplementData(db, { apply: true });
  assert.equal(applied.deleted_count, 1);
  assert.equal(db.prepare("SELECT id FROM applications WHERE id = ?").get(disposable.id), undefined);
  const isolated = db.prepare("SELECT history_data_state, reply_rate_eligible FROM applications WHERE id = ?").get(advanced.id);
  assert.equal(isolated.history_data_state, "legacy_review");
  assert.equal(isolated.reply_rate_eligible, 0);
  assert.ok(db.prepare("SELECT id FROM applications WHERE id = ?").get(preserved.id));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get().count, 0);
  db.close();
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resumatch-history-"));
  return path.join(dir, "test.db");
}
