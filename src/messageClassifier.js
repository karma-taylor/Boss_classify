import { REPLY_INTENTS } from "./intents.js";

const EVENT_TYPES = Object.freeze({
  [REPLY_INTENTS.RESUME_REQUEST]: "resume_request",
  [REPLY_INTENTS.PROCESS_PROGRESS]: "process_progress",
  [REPLY_INTENTS.WECHAT]: "wechat_contact",
  [REPLY_INTENTS.INTERVIEW]: "interview",
  [REPLY_INTENTS.REJECT_EXPERIENCE]: "rejected",
  [REPLY_INTENTS.REJECT_DIRECTION]: "rejected",
  [REPLY_INTENTS.REJECT_LOCATION]: "rejected"
});

export function classifyInboundMessage(message, context = []) {
  if (isOutbound(message)) return null;
  const text = normalizeText(message?.text);
  if (!text) return null;

  if (hasProcessProgress(text) && !hasExplicitInterview(text)) {
    return result(REPLY_INTENTS.PROCESS_PROGRESS, "\u8be5\u6d88\u606f\u8868\u793a\u5ba1\u6838\u6216\u6d41\u7a0b\u63a8\u8fdb\uff0c\u672a\u51fa\u73b0\u660e\u786e\u7ea6\u9762\u52a8\u4f5c\u3002");
  }
  if (hasExplicitInterview(text)) {
    return result(REPLY_INTENTS.INTERVIEW, "\u6d88\u606f\u5305\u542b\u7ea6\u65f6\u95f4\u3001\u5b89\u6392\u9762\u8bd5\u6216\u8fdb\u5165\u9762\u8bd5\u7b49\u660e\u786e\u52a8\u4f5c\u3002");
  }
  if (hasResumeRequest(text)) {
    return result(REPLY_INTENTS.RESUME_REQUEST, "\u6d88\u606f\u660e\u786e\u7d22\u53d6\u7b80\u5386\u3001\u5728\u7ebf\u7b80\u5386\u6216\u4f5c\u54c1\u96c6\u3002");
  }
  if (hasWechatOrCallRequest(text)) {
    return result(REPLY_INTENTS.WECHAT, "\u6d88\u606f\u660e\u786e\u8981\u6c42\u4ea4\u6362\u5fae\u4fe1\u3001\u7535\u8bdd\u6216\u5b89\u6392\u6c9f\u901a\u3002");
  }
  if (hasExperienceRejection(text)) return result(REPLY_INTENTS.REJECT_EXPERIENCE, "\u6d88\u606f\u660e\u786e\u63d0\u53ca\u7ecf\u9a8c\u6216\u5e74\u9650\u4e0d\u7b26\u3002");
  if (hasDirectionRejection(text)) return result(REPLY_INTENTS.REJECT_DIRECTION, "\u6d88\u606f\u660e\u786e\u63d0\u53ca\u5c97\u4f4d\u65b9\u5411\u4e0d\u5339\u914d\u3002");
  if (hasLocationRejection(text)) return result(REPLY_INTENTS.REJECT_LOCATION, "\u6d88\u606f\u660e\u786e\u63d0\u53ca\u5730\u70b9\u6216\u85aa\u8d44\u4e0d\u7b26\u3002");
  return null;
}

export function eventTypeForReplyIntent(intent) {
  return EVENT_TYPES[String(intent || "")] || "";
}

export function isExplicitInterviewIntent(intent, text = "") {
  return String(intent || "") === REPLY_INTENTS.INTERVIEW && hasExplicitInterview(normalizeText(text));
}

function result(intent, reason) {
  return { intent, event_type: EVENT_TYPES[intent] || "", reason };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isOutbound(message) {
  return String(message?.direction || "").toLowerCase() === "outbound" || String(message?.sender || "").toLowerCase() === "me";
}

function hasExplicitInterview(text) {
  const interviewWord = /\u9762\u8bd5|\u590d\u8bd5|\u521d\u8bd5|\u7535\u8bdd\u9762|\u89c6\u9891\u9762|\u7ebf\u4e0b\u9762|\u5230\u573a\u9762/;
  const action = /\u7ea6|\u5b89\u6392|\u9080\u8bf7|\u901a\u77e5|\u8fdb\u5165|\u53c2\u52a0|\u53d1\u9001.*\u4f1a\u8bae|\u786e\u5b9a.{0,8}(\u65f6\u95f4|\u65e5\u671f|\u5b89\u6392)|\u4e0b\u5468[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5]?/;
  return interviewWord.test(text) && action.test(text);
}

function hasProcessProgress(text) {
  return /\u5ba1\u6838|\u8bc4\u4f30|\u6d41\u7a0b|\u518d\u786e\u5b9a|\u540e\u7eed\u8054\u7cfb|\u7b49\u5f85\u901a\u77e5|\u5185\u90e8\u8ba8\u8bba|\u7b80\u5386\u7b5b\u9009|review|assess/i.test(text);
}

function hasResumeRequest(text) {
  return /\u53d1.{0,8}(\u7b80\u5386|\u5728\u7ebf\u7b80\u5386|\u4f5c\u54c1\u96c6)|\u63d0\u4f9b.{0,8}(\u7b80\u5386|\u4f5c\u54c1\u96c6)|\u60f3\u8981.{0,10}(\u7b80\u5386|\u4f5c\u54c1\u96c6)|\u9644\u4ef6\u7b80\u5386|\u6700\u65b0\u7b80\u5386|\u5728\u7ebf\u7b80\u5386|\u4f5c\u54c1\u96c6/.test(text);
}

function hasWechatOrCallRequest(text) {
  return /\u52a0\u5fae\u4fe1|\u5fae\u4fe1\u53f7|\u6362\u5fae\u4fe1|\u7535\u8bdd\u53f7\u7801|\u7ea6\u4e2a\u7535\u8bdd|\u65b9\u4fbf\u6c9f\u901a|\u7ea6\u6c9f\u901a/.test(text);
}

function hasExperienceRejection(text) {
  return /\u7ecf\u9a8c.{0,8}(\u4e0d\u7b26|\u4e0d\u8db3|\u4e0d\u5339\u914d)|\u5e74\u9650.{0,8}\u4e0d\u7b26|\u66f4\u5e0c\u671b.{0,8}\u7ecf\u9a8c/.test(text);
}

function hasDirectionRejection(text) {
  return /\u65b9\u5411.{0,8}(\u4e0d\u7b26|\u4e0d\u5339\u914d)|\u5c97\u4f4d.{0,8}\u4e0d\u9002\u5408|\u4e0d\u592a\u7b26\u5408/.test(text);
}

function hasLocationRejection(text) {
  return /\u85aa\u8d44.{0,8}\u4e0d\u7b26|\u5730\u70b9.{0,8}\u4e0d\u7b26|\u901a\u52e4.{0,8}\u4e0d\u4fbf|\u57ce\u5e02.{0,8}\u4e0d\u7b26/.test(text);
}
