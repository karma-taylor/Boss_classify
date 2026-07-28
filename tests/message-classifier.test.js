import assert from "node:assert/strict";
import test from "node:test";
import { REPLY_INTENTS } from "../src/intents.js";
import { classifyInboundMessage } from "../src/messageClassifier.js";

test("review wording is process progress and never an interview", () => {
  const result = classifyInboundMessage({ sender: "hr", text: "\u6211\u4eec\u5148\u5ba1\u6838\u7b80\u5386\uff0c\u8bc4\u4f30\u540e\u518d\u786e\u5b9a\u662f\u5426\u9762\u8bd5" });
  assert.equal(result.intent, REPLY_INTENTS.PROCESS_PROGRESS);
  assert.equal(result.event_type, "process_progress");
});

test("an interview needs an interview word plus an actionable arrangement", () => {
  const result = classifyInboundMessage({ sender: "hr", text: "\u60a8\u597d\uff0c\u60f3\u7ea6\u60a8\u5468\u4e09\u4e0b\u5348\u89c6\u9891\u9762\u8bd5" });
  assert.equal(result.intent, REPLY_INTENTS.INTERVIEW);
  assert.equal(result.event_type, "interview");
});

test("candidate outbound text is never classified as an HR event", () => {
  assert.equal(classifyInboundMessage({ sender: "me", text: "\u6211\u53ef\u4ee5\u53c2\u52a0\u9762\u8bd5" }), null);
});
