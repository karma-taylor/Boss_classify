import { chromium } from "playwright";
import fs from "node:fs";

const executablePath = [
  process.env.PLAYWRIGHT_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
].find((item) => item && fs.existsSync(item));
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
const missing = [];
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (response.status() === 404) missing.push(response.url());
});

await page.goto("http://127.0.0.1:8788", { waitUntil: "networkidle" });
await page.screenshot({ path: "visual-smoke.png", fullPage: true });

const title = await page.locator("h1").innerText();
const panels = await page.locator(".panel").count();
await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(250);
await page.screenshot({ path: "visual-smoke-mobile.png", fullPage: true });
await browser.close();

if (!title.includes("投递控制台")) {
  throw new Error(`Unexpected title: ${title}`);
}
if (panels < 4) {
  throw new Error(`Expected dashboard panels, got ${panels}`);
}
if (errors.length) {
  throw new Error(`Browser errors:\n${errors.join("\n")}`);
}

console.log(`visual smoke ok: ${title}, panels=${panels}, 404=${missing.join(",") || "none"}`);
