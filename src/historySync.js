import {
  advanceApplicationStatus,
  bindConversation,
  buildMessageHash,
  insertMessageIfNew,
  insertReplyEventIfFirst,
  setApplicationStatus,
  upsertUnlinkedConversation
} from "./db.js";
import { REPLY_INTENTS } from "./intents.js";
import { classifyInboundMessage, eventTypeForReplyIntent } from "./messageClassifier.js";

const MAX_HISTORY_CONVERSATIONS = 200;
const PROCESS_PROGRESS = REPLY_INTENTS.PROCESS_PROGRESS;

export async function syncHistoryConversations(db, conversations, options = {}) {
  if (!Array.isArray(conversations)) throw new Error("conversations_must_be_an_array");
  if (conversations.length > MAX_HISTORY_CONVERSATIONS) throw new Error("history_conversation_limit_exceeded");
  if (typeof options.analyzeMessages !== "function") throw new Error("message_analyzer_required");

  const result = createFunnel(conversations.length);
  for (const item of conversations) {
    if (isBlockingPage(item?.abort_reason || item?.page_state)) {
      throw new Error(`history_scan_aborted:${String(item.abort_reason || item.page_state)}`);
    }
    await syncOneConversation(db, item, options, result);
  }
  assertFunnel(result);
  return result;
}

async function syncOneConversation(db, item, options, result) {
  const switchAttempted = item?.switch_attempted !== false;
  if (switchAttempted) result.switch_attempted += 1;
  if (item?.switch_succeeded === false) {
    return recordFailure(result, item, "conversation_switch_failed");
  }
  if (switchAttempted) result.switch_succeeded += 1;

  const conversationKey = String(item?.conversation_key || "").trim();
  if (!conversationKey) return recordFailure(result, item, "conversation_key_missing");

  const messages = Array.isArray(item?.conversation)
    ? item.conversation.filter((message) => String(message?.text || "").trim())
    : [];
  if (!messages.length) return recordFailure(result, item, "message_parse_failed");

  result.messages_parsed += messages.length;
  let application = findBoundApplication(db, conversationKey, item);
  if (!application) {
    upsertUnlinkedConversation(db, {
      conversation_key: conversationKey,
      source_url: item?.source_url || item?.job_source_url || "",
      title: item?.title || "",
      company: item?.company || "",
      last_message_text: messages[messages.length - 1]?.text || "",
      observed_at: firstExactTime(messages) || null
    });
    result.skipped += 1;
    result.unlinked_conversations += 1;
    result.items.push({ conversation_key: conversationKey, outcome: "unlinked" });
    return;
  }

  if (!hasBinding(db, conversationKey)) {
    bindConversation(db, {
      conversation_key: conversationKey,
      application_id: application.id,
      source_url: item?.source_url || item?.job_source_url || "",
      binding_kind: "job_link"
    });
  }

  result.matched_applications += 1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const payload = buildMessagePayload(application.id, conversationKey, item, message, index, options.syncRunId);
    const persisted = insertMessageIfNew(db, payload);
    if (persisted.inserted || persisted.updated) result.messages_persisted += 1;
    else result.messages_deduped += 1;
    if (!isInbound(payload)) continue;

    const context = messages.slice(Math.max(0, index - 2), index + 1);
    const analysis = await options.analyzeMessages(context);
    const strict = classifyInboundMessage(message, context);
    const intent = strict?.intent || normalizeIntent(analysis?.intent, payload.text);
    const event = strict?.event_type || eventTypeForReplyIntent(intent);
    if (!event) continue;

    const eventResult = insertReplyEventIfFirst(db, {
      application_id: application.id,
      message_id: persisted.row.id,
      event_type: event,
      occurred_at: payload.sent_at,
      time_precision: payload.time_precision,
      classification_basis: String(strict?.reason || analysis?.reason || "")
    });
    if (eventResult.inserted) result.events_created += 1;
    application = applyEventStatus(db, application, intent, payload, { ...analysis, reason: strict?.reason || analysis?.reason || "" });
  }

  result.processed += 1;
  result.items.push({
    conversation_key: conversationKey,
    application_id: application.id,
    outcome: "processed"
  });
}

function findBoundApplication(db, conversationKey, item) {
  const binding = db.prepare(`
    SELECT a.*, j.source_url
    FROM conversation_bindings b
    JOIN applications a ON a.id = b.application_id
    JOIN jobs j ON j.id = a.job_id
    WHERE b.conversation_key = ?
  `).get(conversationKey);
  if (binding) return binding;

  const sourceUrl = String(item?.source_url || item?.job_source_url || "").trim();
  if (!sourceUrl) return null;
  return db.prepare(`
    SELECT a.*, j.source_url
    FROM applications a
    JOIN jobs j ON j.id = a.job_id
    WHERE j.source_url = ?
    LIMIT 1
  `).get(sourceUrl) || null;
}

function hasBinding(db, conversationKey) {
  return Boolean(db.prepare("SELECT id FROM conversation_bindings WHERE conversation_key = ?").get(conversationKey));
}

function buildMessagePayload(applicationId, conversationKey, item, message, index, syncRunId) {
  const sentAt = String(message?.sent_at || "").trim();
  const timePrecision = message?.time_precision === "unknown" || !sentAt ? "unknown" : "exact";
  const sender = String(message?.sender || "hr").trim() || "hr";
  return {
    application_id: applicationId,
    conversation_key: conversationKey,
    native_message_id: String(message?.native_message_id || message?.message_id || message?.id || "").trim(),
    message_key: String(message?.message_key || "").trim(),
    message_order: Number.isInteger(Number(message?.message_order)) ? Number(message.message_order) : index,
    message_hash: buildMessageHash({ conversation_key: conversationKey, sender, text: message?.text || "", sent_at: sentAt }),
    sync_run_id: syncRunId ?? null,
    direction: String(message?.direction || "").trim() || (sender.toLowerCase() === "me" ? "outbound" : "inbound"),
    sender,
    text: String(message?.text || ""),
    source_url: String(item?.source_url || item?.job_source_url || ""),
    sent_at: timePrecision === "exact" ? sentAt : null,
    time_precision: timePrecision
  };
}

function applyEventStatus(db, application, intent, message, analysis) {
  if (Number(application.manual_status_override || 0) === 1) return application;
  const fields = {
    feedback_intent: intent,
    feedback_reason: String(analysis?.reason || ""),
    last_message_text: message.text,
    first_replied_at: message.time_precision === "exact" ? message.sent_at : null,
    last_replied_at: message.time_precision === "exact" ? message.sent_at : null,
    clear_reply_handled: true,
    time_precision: message.time_precision
  };
  if (intent === REPLY_INTENTS.INTERVIEW) {
    advanceApplicationStatus(db, application.job_id, "interview", { ...fields, interview_at: message.sent_at, interested_at: message.sent_at });
  } else if (intent === REPLY_INTENTS.RESUME_REQUEST || intent === REPLY_INTENTS.WECHAT) {
    advanceApplicationStatus(db, application.job_id, "interested", { ...fields, interested_at: message.sent_at, resume_request_at: intent === REPLY_INTENTS.RESUME_REQUEST ? message.sent_at : null });
  } else if (isRejectedIntent(intent) && Number(application.manual_status_override || 0) !== 1 && !["interested", "interview"].includes(application.status)) {
    setApplicationStatus(db, application.job_id, "rejected", { ...fields, rejected_at: message.sent_at });
  } else {
    setApplicationStatus(db, application.job_id, application.status, fields);
  }
  return db.prepare("SELECT * FROM applications WHERE id = ?").get(application.id);
}

function normalizeIntent(intent, text) {
  const value = String(intent || "");
  if (isExplicitIntent(value)) return value;
  if (/\u5ba1\u6838|\u8bc4\u4f30|\u6d41\u7a0b|\u540e\u7eed\u8054\u7cfb|\u518d\u786e\u5b9a|review|assess|follow up/i.test(String(text || ""))) {
    return PROCESS_PROGRESS;
  }
  return value || REPLY_INTENTS.NO_EFFECTIVE_FEEDBACK;
}

function isExplicitIntent(intent) {
  return [
    REPLY_INTENTS.INTERVIEW,
    REPLY_INTENTS.RESUME_REQUEST,
    REPLY_INTENTS.WECHAT,
    REPLY_INTENTS.PROCESS_PROGRESS,
    REPLY_INTENTS.REJECT_EXPERIENCE,
    REPLY_INTENTS.REJECT_DIRECTION,
    REPLY_INTENTS.REJECT_LOCATION
  ].includes(intent);
}

function isRejectedIntent(intent) {
  return [REPLY_INTENTS.REJECT_EXPERIENCE, REPLY_INTENTS.REJECT_DIRECTION, REPLY_INTENTS.REJECT_LOCATION].includes(intent);
}

function isInbound(message) {
  return message.direction !== "outbound" && String(message.sender || "").toLowerCase() !== "me";
}

function firstExactTime(messages) {
  return messages.find((message) => String(message?.sent_at || "").trim())?.sent_at || null;
}

function isBlockingPage(value) {
  return ["login_required", "captcha_required", "risk_page"].includes(String(value || "").trim());
}

function recordFailure(result, item, reason) {
  result.failed += 1;
  result.failure_reasons[reason] = (result.failure_reasons[reason] || 0) + 1;
  result.items.push({ conversation_key: String(item?.conversation_key || ""), outcome: "failed", reason });
}

function createFunnel(discovered) {
  return {
    discovered,
    switch_attempted: 0,
    switch_succeeded: 0,
    messages_parsed: 0,
    messages_persisted: 0,
    messages_deduped: 0,
    events_created: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    unlinked_conversations: 0,
    matched_applications: 0,
    failure_reasons: {},
    items: []
  };
}

function assertFunnel(result) {
  if (result.processed + result.skipped + result.failed !== result.discovered) {
    throw new Error("history_funnel_invariant_failed");
  }
}

export { MAX_HISTORY_CONVERSATIONS, PROCESS_PROGRESS };
