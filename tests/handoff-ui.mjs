import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
});
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8791", { waitUntil: "networkidle" });
await assert.equal(await page.getByRole("button", { name: "导出数据" }).isVisible(), true);
await assert.equal(await page.getByText("今日投递候选队列").isVisible(), true);
await browser.close();
console.log("handoff UI smoke checks passed");
