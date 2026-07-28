import { chromium } from "playwright";

export const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
export const CHROME_HINT =
  '关闭所有 Chrome 窗口后，双击“启动投递工作台.bat”，它会用你的日常 Chrome profile 启动 --remote-debugging-port=9222。';

export async function getBrowserStatus() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return {
      ok: true,
      cdpAvailable: true,
      preferredMode: "cdp",
      cdpUrl: CDP_URL,
      browser: data.Browser || "Chrome",
      webSocketDebuggerUrl: data.webSocketDebuggerUrl || "",
      command: CHROME_HINT
    };
  } catch (error) {
    return {
      ok: false,
      cdpAvailable: false,
      preferredMode: "extension",
      cdpUrl: CDP_URL,
      error: error.message,
      message: "9222 没开也可以,当前建议直接用扩展同步或无 9222 导入。",
      command: CHROME_HINT
    };
  }
}

export async function connectRealChrome() {
  const status = await getBrowserStatus();
  if (!status.ok) {
    const error = new Error("Chrome 调试端口未开启。");
    error.browserStatus = status;
    throw error;
  }
  return chromium.connectOverCDP(CDP_URL);
}

export function isAllowedAutomationWindow(now = new Date()) {
  const startHour = Number(process.env.AUTOMATION_START_HOUR || 9);
  const endHour = Number(process.env.AUTOMATION_END_HOUR || 18);
  const hour = now.getHours();
  return hour >= startHour && hour < endHour;
}

export async function humanDelay(minMs = 3000, maxMs = 15000) {
  const delay = Math.floor(minMs + Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, delay));
}
