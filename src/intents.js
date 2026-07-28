export const REPLY_INTENTS = Object.freeze({
  INTERVIEW: "\u660e\u786e\u9080\u9762",
  RESUME_REQUEST: "\u7d22\u8981\u7b80\u5386",
  WECHAT: "\u52a0\u5fae\u4fe1/\u7ea6\u6c9f\u901a",
  PROCESS_PROGRESS: "\u6d41\u7a0b\u63a8\u8fdb",
  REJECT_EXPERIENCE: "\u5a49\u62d2-\u7ecf\u9a8c\u4e0d\u7b26",
  REJECT_DIRECTION: "\u5a49\u62d2-\u65b9\u5411\u4e0d\u7b26",
  REJECT_LOCATION: "\u85aa\u8d44/\u5730\u70b9\u4e0d\u7b26",
  GREETING: "\u7eaf\u6253\u62db\u547c",
  NO_EFFECTIVE_FEEDBACK: "\u65e0\u6709\u6548\u53cd\u9988"
});

export const POSITIVE_REPLY_INTENTS = Object.freeze([
  REPLY_INTENTS.INTERVIEW,
  REPLY_INTENTS.RESUME_REQUEST,
  REPLY_INTENTS.WECHAT,
  REPLY_INTENTS.PROCESS_PROGRESS
]);

export const NEGATIVE_REPLY_INTENTS = Object.freeze([
  REPLY_INTENTS.REJECT_EXPERIENCE,
  REPLY_INTENTS.REJECT_DIRECTION,
  REPLY_INTENTS.REJECT_LOCATION
]);

export function isPositiveReplyIntent(intent) {
  return POSITIVE_REPLY_INTENTS.includes(String(intent || ""));
}

export function isNegativeReplyIntent(intent) {
  return NEGATIVE_REPLY_INTENTS.includes(String(intent || ""));
}

export function getReplyBucket(intent) {
  switch (String(intent || "")) {
    case REPLY_INTENTS.INTERVIEW:
      return "interview";
    case REPLY_INTENTS.RESUME_REQUEST:
      return "resume_request";
    case REPLY_INTENTS.WECHAT:
      return "wechat";
    case REPLY_INTENTS.PROCESS_PROGRESS:
      return "process_progress";
    case REPLY_INTENTS.REJECT_EXPERIENCE:
    case REPLY_INTENTS.REJECT_DIRECTION:
    case REPLY_INTENTS.REJECT_LOCATION:
      return "rejected";
    default:
      return "needs_review";
  }
}
