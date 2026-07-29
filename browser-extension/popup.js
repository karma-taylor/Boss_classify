const statusEl = document.getElementById("status");
const syncButton = document.getElementById("sync");
const openWorkbenchButton = document.getElementById("open-workbench");
const telemetryEnabledEl = document.getElementById("telemetry-enabled");
const workbenchTokenEl = document.getElementById("workbench-token");

const healthStatusEl = document.getElementById("health-status");
const refreshHealthButton = document.getElementById("refresh-health");
const openExtensionsButton = document.getElementById("open-extensions");
const healthBackgroundEl = document.getElementById("health-background");
const healthContentScriptEl = document.getElementById("health-content-script");
const healthPageTypeEl = document.getElementById("health-page-type");
const healthTabUrlEl = document.getElementById("health-tab-url");

const historyStatusEl = document.getElementById("history-status");
const historySyncButton = document.getElementById("sync-history");
const refreshHistorySummaryButton = document.getElementById("refresh-history-summary");
const historyRangeEl = document.getElementById("history-range");
const historyLimitEl = document.getElementById("history-limit");
const historyStartEl = document.getElementById("history-start");
const historyEndEl = document.getElementById("history-end");
const historyReplyCountEl = document.getElementById("history-reply-count");
const historyResumeCountEl = document.getElementById("history-resume-count");
const historyInterviewCountEl = document.getElementById("history-interview-count");
const historySupplementCountEl = document.getElementById("history-supplement-count");

const TEXT = {
  readingPage: "正在读取当前 Boss 页面...",
  syncFailed: "同步失败。",
  syncSummary(saved, existing, queued, candidates, rejected) {
    return (
      `新增 ${saved} 个岗位，已存在 ${existing} 个。\n` +
      `评估 ${queued} 个，进入候选 ${candidates} 个，不建议投 ${rejected} 个。`
    );
  },
  openWorkbenchFailed: "打开工作台失败。",
  reloadGuide:
    "如果 Chrome 扩展页里显示 Service Worker “无效”，先看这两个信号：\n" +
    "1. 点“刷新自检”，如果后台和内容脚本都正常，通常只是 Chrome 的空闲休眠，不等于报错。\n" +
    "2. 如果扩展卡片上出现“错误”按钮，再进去看第一条红色报错。\n\n" +
    "需要手工重载时：打开 chrome://extensions → 找到 ResuMatch 投递同步 → 点右下角刷新图标 → 再回来点“刷新自检”。",
  historyPreparing: "准备开始历史检索...",
  historyFailed: "历史检索失败。",
  historySummary(scanned, messages, matched, failed, events) {
    return (
      `已扫描 ${scanned} 个会话。\n` +
      `入库消息 ${messages} 条，匹配岗位 ${matched} 个，新增事件 ${events} 个，失败 ${failed} 个。`
    );
  },
  refreshHistoryFailed: "刷新历史统计失败。",
  historyRefreshed: "历史统计已刷新。",
  checkingExtension: "正在检查扩展状态...",
  healthFailed: "扩展自检失败。",
  healthReady: "后台和内容脚本都已就绪。",
  healthReadyIdleHint:
    "后台和内容脚本都已就绪。Chrome 扩展页里的 Service Worker “无效”很多时候只是空闲休眠，不代表扩展真的坏了。",
  healthScriptMissing: "后台已就绪，但当前页面的内容脚本还没准备好。",
  healthUnsupported: "后台已就绪，但当前标签页不是支持的页面。",
  unknown: "未知",
  ok: "正常",
  error: "异常",
  connected: "已连接",
  notReady: "未就绪",
  notNeeded: "不需要",
  noActiveTab: "当前没有检测到活动标签页。",
  waitingHealth: "等待自检。",
  waitingHistory: "等待历史检索。",
  waitingSync: "等待同步。",
  channelClosed: "扩展消息通道已关闭，请刷新扩展或页面后重试。",
  historyChannelClosed: "历史检索连接已关闭，请重试。",
  storageUnavailable: "扩展存储不可用。请到 chrome://extensions 刷新 ResuMatch 扩展后重试。"
};

const PAGE_TYPE_MAP = {
  chat: "Boss 聊天页",
  list: "Boss 列表页",
  detail: "Boss 详情页",
  workbench: "本地工作台",
  unsupported: "不支持的页面",
  "no-tab": "没有活动标签页",
  unknown: "未知页面"
};

syncButton.addEventListener("click", async () => {
  setStatus(statusEl, TEXT.readingPage, "warn");
  syncButton.disabled = true;

  try {
    const response = await sendRuntimeMessage({ type: "syncCurrentBossPage" });
    if (!response?.ok) {
      throw new Error(response?.error || TEXT.syncFailed);
    }

    setStatus(
      statusEl,
      TEXT.syncSummary(
        Number(response.saved || 0),
        Number(response.existing_count || 0),
        Number(response.queued_for_evaluation || 0),
        Number(response.queued_candidates || 0),
        Number(response.not_recommended_count || 0)
      ),
      "success"
    );
    await refreshHealth();
  } catch (error) {
    setStatus(statusEl, error.message || TEXT.syncFailed, "error");
  } finally {
    syncButton.disabled = false;
  }
});

openWorkbenchButton.addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("workbench-launcher.html") });
  } catch (error) {
    setStatus(statusEl, error.message || TEXT.openWorkbenchFailed, "error");
  }
});

refreshHealthButton.addEventListener("click", async () => {
  refreshHealthButton.disabled = true;
  try {
    await refreshHealth();
  } finally {
    refreshHealthButton.disabled = false;
  }
});

openExtensionsButton.addEventListener("click", async () => {
  setStatus(healthStatusEl, TEXT.reloadGuide, "warn");
});

historySyncButton.addEventListener("click", async () => {
  historySyncButton.disabled = true;
  setStatus(historyStatusEl, TEXT.historyPreparing, "warn");

  try {
    const response = await runHistorySyncViaPort(buildHistoryPayload());
    if (!response?.ok) {
      throw new Error(response?.error || TEXT.historyFailed);
    }

    applyHistorySummary(response.history_summary || response);
    setStatus(
      historyStatusEl,
      TEXT.historySummary(
        Number(response.discovered || 0),
        Number(response.messages_persisted || 0),
        Number(response.matched_applications || 0),
        Number(response.failed || 0),
        Number(response.events_created || 0)
      ),
      "success"
    );
    await refreshHealth();
  } catch (error) {
    setStatus(historyStatusEl, error.message || TEXT.historyFailed, "error");
  } finally {
    historySyncButton.disabled = false;
  }
});

refreshHistorySummaryButton.addEventListener("click", async () => {
  refreshHistorySummaryButton.disabled = true;
  try {
    const response = await sendRuntimeMessage({
      type: "getHistoryReplySummary",
      payload: buildHistoryPayload()
    });
    if (!response?.ok) {
      throw new Error(response?.error || TEXT.refreshHistoryFailed);
    }
    applyHistorySummary(response);
    setStatus(historyStatusEl, TEXT.historyRefreshed, "success");
  } catch (error) {
    setStatus(historyStatusEl, error.message || TEXT.refreshHistoryFailed, "error");
  } finally {
    refreshHistorySummaryButton.disabled = false;
  }
});

historyRangeEl.addEventListener("change", toggleCustomRange);
telemetryEnabledEl.addEventListener("change", async () => {
  await saveStorageValue({ telemetry_enabled: telemetryEnabledEl.checked });
});
workbenchTokenEl.addEventListener("change", async () => {
  await saveStorageValue({ workbench_api_token: workbenchTokenEl.value.trim() });
});

void initialize();

async function initialize() {
  const storage = getLocalStorage();
  const stored = storage ? await storage.get([
    "telemetry_enabled",
    "workbench_api_token"
  ]) : {};
  const { telemetry_enabled: telemetryEnabled, workbench_api_token: workbenchToken } = stored;
  telemetryEnabledEl.checked = telemetryEnabled === true;
  workbenchTokenEl.value = workbenchToken || "";
  toggleCustomRange();
  setStatus(statusEl, storage ? TEXT.waitingSync : TEXT.storageUnavailable, storage ? "" : "error");
  setStatus(healthStatusEl, TEXT.waitingHealth, "");
  setStatus(historyStatusEl, TEXT.waitingHistory, "");
  await Promise.allSettled([loadHistorySummary(), refreshHealth()]);
}

function getLocalStorage() {
  return globalThis.chrome?.storage?.local || null;
}

async function saveStorageValue(value) {
  const storage = getLocalStorage();
  if (!storage) {
    setStatus(statusEl, TEXT.storageUnavailable, "error");
    return false;
  }
  await storage.set(value);
  return true;
}

async function loadHistorySummary() {
  try {
    const response = await sendRuntimeMessage({
      type: "getHistoryReplySummary",
      payload: buildHistoryPayload()
    });
    if (response?.ok) {
      applyHistorySummary(response);
    }
  } catch {}
}

async function refreshHealth() {
  setStatus(healthStatusEl, TEXT.checkingExtension, "warn");

  try {
    const response = await sendRuntimeMessage({ type: "getExtensionHealth" });
    if (!response?.ok) {
      throw new Error(response?.error || TEXT.healthFailed);
    }

    renderHealth(response);
    const statusText = response.content_script_ready
      ? TEXT.healthReadyIdleHint
      : response.supported_page
        ? TEXT.healthScriptMissing
        : TEXT.healthUnsupported;
    setStatus(healthStatusEl, statusText, response.content_script_ready ? "success" : "warn");
  } catch (error) {
    renderHealth(null);
    setStatus(healthStatusEl, error.message || TEXT.healthFailed, "error");
  }
}

function renderHealth(health) {
  if (!health) {
    healthBackgroundEl.innerHTML = buildPill(TEXT.unknown, "error");
    healthContentScriptEl.innerHTML = buildPill(TEXT.unknown, "error");
    healthPageTypeEl.textContent = TEXT.unknown;
    healthTabUrlEl.textContent = TEXT.unknown;
    return;
  }

  healthBackgroundEl.innerHTML = buildPill(
    health.background_ok ? TEXT.ok : TEXT.error,
    health.background_ok ? "ok" : "error"
  );

  healthContentScriptEl.innerHTML = buildPill(
    health.content_script_ready ? TEXT.connected : health.supported_page ? TEXT.notReady : TEXT.notNeeded,
    health.content_script_ready ? "ok" : "warn"
  );

  const pageTypeText = PAGE_TYPE_MAP[health.page_type] || health.page_type || TEXT.unknown;
  healthPageTypeEl.textContent = health.health_error ? `${pageTypeText} | ${health.health_error}` : pageTypeText;
  healthTabUrlEl.textContent = health.active_tab_url || TEXT.noActiveTab;
}

function buildPill(text, kind) {
  return `<span class="pill ${kind}">${escapeHtml(text)}</span>`;
}

function applyHistorySummary(summary) {
  historyReplyCountEl.textContent = String(Number(summary.reply_count || 0));
  historyResumeCountEl.textContent = String(Number(summary.resume_request_count || 0));
  historyInterviewCountEl.textContent = String(Number(summary.interview_count || 0));
  historySupplementCountEl.textContent = String(Number(summary.supplement_count || 0));
}

function buildHistoryPayload() {
  const range = historyRangeEl.value;
  const payload = {
    limit: Math.max(1, Math.min(Number(historyLimitEl.value || 200), 200))
  };

  if (range === "custom") {
    if (historyStartEl.value) {
      payload.start = new Date(historyStartEl.value).toISOString();
    }
    if (historyEndEl.value) {
      payload.end = new Date(historyEndEl.value).toISOString();
    }
  } else {
    payload.range = range;
  }

  return payload;
}

function toggleCustomRange() {
  const custom = historyRangeEl.value === "custom";
  historyStartEl.disabled = !custom;
  historyEndEl.disabled = !custom;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError?.message || "";
        if (runtimeError) {
          reject(new Error(isClosedChannelMessage(runtimeError) ? TEXT.channelClosed : runtimeError));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function isClosedChannelMessage(message) {
  return (
    message.includes("message channel closed") ||
    message.includes("Receiving end does not exist") ||
    message.includes("The message port closed before a response was received")
  );
}

function setStatus(element, text, kind) {
  element.textContent = text;
  element.className = `status${kind ? ` ${kind}` : ""}`;
}

function runHistorySyncViaPort(payload) {
  return new Promise((resolve, reject) => {
    const requestId = `popup-history-${Date.now()}`;
    const port = chrome.runtime.connect({ name: "resumatch-popup-history" });
    let settled = false;

    const cleanup = () => {
      try {
        port.disconnect();
      } catch {}
    };

    port.onMessage.addListener((message) => {
      if (message?.requestId !== requestId) {
        return;
      }

      if (message.type === "reply-history-progress") {
        if (message.payload?.message) {
          setStatus(historyStatusEl, message.payload.message, "warn");
        }
        return;
      }

      if (message.type === "reply-history-result") {
        settled = true;
        cleanup();
        resolve({ ok: true, ...message.payload });
        return;
      }

      if (message.type === "reply-history-error") {
        settled = true;
        cleanup();
        reject(new Error(message.payload?.error || TEXT.historyFailed));
      }
    });

    port.onDisconnect.addListener(() => {
      if (!settled) {
        reject(new Error(TEXT.historyChannelClosed));
      }
    });

    port.postMessage({
      type: "runReplyHistorySync",
      requestId,
      payload
    });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
