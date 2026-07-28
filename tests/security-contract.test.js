import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const server = fs.readFileSync(path.join(process.cwd(), "src", "server.js"), "utf8");
const background = fs.readFileSync(path.join(process.cwd(), "browser-extension", "background.js"), "utf8");
const contentScript = fs.readFileSync(path.join(process.cwd(), "browser-extension", "content-script.js"), "utf8");
const page = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");

test("API requires explicit extension IDs and a capability token", () => {
  assert.match(server, /WORKBENCH_EXTENSION_IDS/);
  assert.match(server, /WORKBENCH_API_TOKEN/);
  assert.match(server, /x-workbench-token/);
  assert.match(server, /timingSafeEqual/);
  assert.doesNotMatch(server, /\^chrome-extension:\\\/\\\[a-p\]/);
});

test("workbench and extension send the capability token", () => {
  assert.match(page, /X-Workbench-Token/);
  assert.match(page, /WORKBENCH_API_TOKEN/);
  assert.match(background, /X-Workbench-Token/);
  assert.match(background, /workbench_token_missing/);
});

test("workbench uses local vendor assets and content-script errors are structured", () => {
  assert.match(page, /\/vendor\/vue\.js/);
  assert.match(page, /\/vendor\/tailwind\.css/);
  assert.doesNotMatch(page, /cdn\.tailwindcss\.com|unpkg\.com\/vue/);
  assert.match(contentScript, /function normalizeContentError/);
  assert.doesNotMatch(contentScript, /throw new Error\(`boss_standard_chat_required url=/);
});
