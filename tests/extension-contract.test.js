import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const contentScript = fs.readFileSync(path.join(process.cwd(), "browser-extension", "content-script.js"), "utf8");
const backgroundScript = fs.readFileSync(path.join(process.cwd(), "browser-extension", "background.js"), "utf8");
const popupScript = fs.readFileSync(path.join(process.cwd(), "browser-extension", "popup.js"), "utf8");
const telemetryScript = fs.readFileSync(path.join(process.cwd(), "browser-extension", "telemetry.js"), "utf8");

test("telemetry is disabled by default and only accepts allowlisted anonymous properties", () => {
  assert.match(telemetryScript, /const EVENT_PROPERTIES/);
  assert.match(telemetryScript, /export const TELEMETRY_ENDPOINT = ""/);
  assert.match(telemetryScript, /return enabled === true && isValidTelemetryEndpoint/);
  assert.match(telemetryScript, /crypto\.randomUUID\(\)/);
  assert.match(telemetryScript, /method: "POST"/);
  assert.match(telemetryScript, /keys\.some\(\(key\) => !allowedProperties\.includes\(key\)\)/);
  assert.doesNotMatch(telemetryScript, /window\.location|document\.|conversation|chat_content|hr_name/);
  assert.match(popupScript, /telemetry_enabled/);
});

test("extension keeps Boss attachment resume cards as inbound HR messages", () => {
  assert.match(contentScript, /function isInboundResumeCardText/);
  assert.match(contentScript, /sender = isInboundResumeCardText\(text\) \? "hr"/);
  assert.doesNotMatch(contentScript, /my\|self\|right\|geek\|resume\|me\|item-myself/);
});

test("extension preserves twelve recent messages for history classification", () => {
  assert.match(contentScript, /conversation: messages\.slice\(-12\)/);
});

test("history scanner uses the shared 200-item limit and a paced cooldown", () => {
  assert.match(contentScript, /const MAX_HISTORY_CONVERSATIONS = 200/);
  assert.match(contentScript, /const HISTORY_COOLDOWN_EVERY = 40/);
  assert.match(contentScript, /randomInt\(30, 60\)/);
  assert.match(contentScript, /randomDelay\(2000, 5000\)/);
  assert.match(contentScript, /assertNoBlockingChatState\(\)/);
  assert.match(backgroundScript, /const MAX_HISTORY_CONVERSATIONS = 200/);
});

test("history scanner preserves per-conversation failures and never fabricates message time", () => {
  assert.match(contentScript, /failure_reason = "conversation_switch_failed"/);
  assert.match(contentScript, /failure_reason = "message_parse_failed"/);
  assert.match(contentScript, /time_precision: timestamp\.time_precision/);
  assert.match(contentScript, /return \{ sent_at: null, time_precision: "unknown" \}/);
  assert.match(contentScript, /native_message_id: nativeMessageId \|\| null/);
  assert.match(contentScript, /message_order: messageOrder/);
});

test("long history scanning uses a tab Port instead of a single long-lived response", () => {
  assert.match(contentScript, /resumatch-history-/);
  assert.match(contentScript, /startReplyHistoryCollection/);
  assert.match(backgroundScript, /chrome\.tabs\.connect\(tabId, \{ name: `resumatch-history-\$\{requestId\}` \}\)/);
  assert.match(backgroundScript, /history-collection-progress/);
  assert.match(backgroundScript, /history-collection-result/);
  assert.match(contentScript, /error: "history_scan_requires_port"/);
});

test("history popup reports the server funnel instead of obsolete supplement counters", () => {
  assert.match(popupScript, /response\.messages_persisted/);
  assert.match(popupScript, /response\.events_created/);
  assert.match(popupScript, /response\.failed/);
  assert.doesNotMatch(popupScript, /response\.synced_conversations/);
});

test("company size enrichment validates the preview before reading it", () => {
  assert.match(contentScript, /case "enrichBossJobCompanySizes"/);
  assert.match(contentScript, /function waitForPreviewPanel/);
  assert.match(contentScript, /function previewMatchesJob/);
  assert.match(contentScript, /function waitForElement/);
  assert.match(contentScript, /function waitForCompanySize/);
  assert.match(contentScript, /findMoreCompanyInfoButton\(preview\)/);
  assert.match(contentScript, /status: "failed", reason, job_key: jobKey/);
});

test("background filters before enrichment and uses the reported detail link", () => {
  assert.match(backgroundScript, /analyzeJobFilters\(job, task\.filters \|\| \{\}, \{ includeCompanySize: false \}\)/);
  assert.match(backgroundScript, /await enrichAcceptedJobCompanySizes\(/);
  assert.match(backgroundScript, /companySizeDetailLinks\.get\(detailLinkKey\) \|\| result\.detail_url/);
  assert.match(backgroundScript, /await chrome\.tabs\.create\(\{ url: request\.detail_url, active: false \}\)/);
  assert.match(backgroundScript, /await chrome\.tabs\.remove\(detailTab\.id\)/);
});

test("company size uses the company basic information card and identifies hunters", () => {
  assert.doesNotMatch(contentScript, /company_size: extractCompanySizeText\(card/);
  assert.match(contentScript, /function findCompanyBasicInfoCard/);
  assert.match(contentScript, /function extractCompanySizeFromBasicInfoCard/);
  assert.match(contentScript, /company_size_source: "company_basic_info"/);
  assert.match(contentScript, /status: "hunter"/);
  assert.match(backgroundScript, /result\.status === "hunter"/);
});
