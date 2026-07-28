import { trackDailyLaunch, trackEvent } from "./telemetry.js";

const IMPORT_URL = "http://127.0.0.1:8788/api/jobs/import";
const MESSAGE_SYNC_URL = "http://127.0.0.1:8788/api/boss/messages/sync";
const MESSAGE_HISTORY_SYNC_URL = "http://127.0.0.1:8788/api/boss/messages/history-sync";
const REPLY_SUMMARY_URL = "http://127.0.0.1:8788/api/replies/summary";
const HISTORY_SUMMARY_URL = "http://127.0.0.1:8788/api/replies/history-summary";
const MAX_HISTORY_CONVERSATIONS = 200;
const MAX_COMPANY_SIZE_DETAIL_TABS = 20;
const WORKBENCH_TOKEN_STORAGE_KEY = "workbench_api_token";

let activeSearchRun = null;
let activeHistoryRun = null;
const companySizeDetailLinks = new Map();

void trackDailyLaunch();

chrome.runtime.onConnect.addListener((port) => {
  try {
    const portName = safePortName(port);

    if (portName === "resumatch-popup-history") {
      port.onMessage.addListener((message) => {
        try {
          if (message?.type !== "runReplyHistorySync") return;
          startReplyHistoryRun(message.requestId || "popup", port, message.payload || {});
        } catch (error) {
          notifyWorkbench(port, "reply-history-error", message?.requestId || "popup", {
            error: error?.message || "\u5386\u53f2\u68c0\u7d22\u5165\u53e3\u5f02\u5e38"
          });
        }
      });
      return;
    }

    if (!portName.startsWith("resumatch-workbench-")) return;
    port.onMessage.addListener((message) => {
      try {
        if (message?.type === "runBossSearch") {
          if (activeSearchRun) {
            port.postMessage({
              type: "boss-search-error",
              requestId: message.requestId,
              payload: { error: "\u5df2\u7ecf\u6709\u4e00\u4e2a\u641c\u7d22\u4efb\u52a1\u5728\u6267\u884c\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002" }
            });
            return;
          }
          activeSearchRun = { requestId: message.requestId };
          runBossSearchBatch(message.requestId, port, message.payload || {})
            .catch((error) => {
              port.postMessage({
                type: "boss-search-error",
                requestId: message.requestId,
                payload: { error: error.message || "\u641c\u7d22\u5931\u8d25" }
              });
            })
            .finally(() => {
              activeSearchRun = null;
            });
          return;
        }

        if (message?.type === "runReplyHistorySync") {
          startReplyHistoryRun(message.requestId, port, message.payload || {});
        }
      } catch (error) {
        try {
          port.postMessage({
            type: message?.type === "runReplyHistorySync" ? "reply-history-error" : "boss-search-error",
            requestId: message?.requestId || "",
            payload: { error: error?.message || "\u540e\u53f0\u5165\u53e3\u5f02\u5e38" }
          });
        } catch {}
      }
    });
  } catch {}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message?.type === "syncCurrentBossPage") {
      syncCurrentBossPage(sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "sync failed" }));
      return true;
    }

    if (message?.type === "syncBossMessages") {
      syncBossMessages(sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "message sync failed" }));
      return true;
    }

    if (message?.type === "syncBossReplyHistory") {
      syncBossReplyHistory(sender, message.payload || {})
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "history sync failed" }));
      return true;
    }

    if (message?.type === "getReplySummary") {
      getReplySummary()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "summary failed" }));
      return true;
    }

    if (message?.type === "getHistoryReplySummary") {
      getHistoryReplySummary(message.payload || {})
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "history summary failed" }));
      return true;
    }

    if (message?.type === "getExtensionHealth") {
      getExtensionHealth(sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || "health check failed" }));
      return true;
    }

    if (message?.type === "companySizeDetailLink") {
      const payload = message.payload || {};
      const key = `${payload.run_id || ""}:${payload.job_key || ""}`;
      if (payload.detail_url && payload.job_key) companySizeDetailLinks.set(key, payload.detail_url);
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "replyHistoryProgress") {
      if (activeHistoryRun?.requestId === message.requestId) {
        notifyHistoryRun(activeHistoryRun, "reply-history-progress", message.requestId, message.payload || {});
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "telemetry_event") {
      // Content scripts may only request an event. The background remains the
      // sole network boundary and telemetry.js drops every unapproved field.
      if (sender.id === chrome.runtime.id) {
        void trackEvent(message.event, message.properties || {});
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  } catch (error) {
    try {
      sendResponse({ ok: false, error: error?.message || "background message handler failed" });
    } catch {}
    return false;
  }
});

function startReplyHistoryRun(requestId, port, payload) {
  if (activeHistoryRun) {
    notifyWorkbench(port, "reply-history-error", requestId, {
      error: "\u5df2\u7ecf\u6709\u4e00\u4e2a\u5386\u53f2\u68c0\u7d22\u4efb\u52a1\u5728\u6267\u884c\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002"
    });
    return;
  }

  const run = { requestId, subscribers: new Set() };
  activeHistoryRun = run;
  addHistorySubscriber(run, port);
  runReplyHistorySync(requestId, run, payload)
    .catch((error) => {
      notifyHistoryRun(run, "reply-history-error", requestId, {
        error: error?.message || "\u5386\u53f2\u68c0\u7d22\u5931\u8d25"
      });
    })
    .finally(() => {
      if (activeHistoryRun === run) activeHistoryRun = null;
    });
}

function addHistorySubscriber(run, port) {
  if (!port || !run) return;
  run.subscribers.add(port);
  port.onDisconnect.addListener(() => run.subscribers.delete(port));
}

function notifyHistoryRun(run, type, requestId, payload) {
  for (const port of run?.subscribers || []) {
    try {
      notifyWorkbench(port, type, requestId, payload);
    } catch {}
  }
}

async function syncCurrentBossPage(sender) {
  const tab = await resolveActiveBossTab(sender);
  await ensureContentScript(tab.id);
  const result = await sendTabMessage(tab.id, { type: "collectBossJobs" });
  if (!result?.ok) throw new Error(result?.error || "\u5f53\u524d\u9875\u9762\u6ca1\u6709\u53ef\u91c7\u96c6\u7684\u5c97\u4f4d\u3002");
  if (!Array.isArray(result.jobs) || !result.jobs.length) {
    throw new Error("\u5f53\u524d\u9875\u6ca1\u6709\u8bc6\u522b\u5230\u5c97\u4f4d\u5361\u7247\u6216\u5c97\u4f4d\u8be6\u60c5\u3002");
  }

  await enrichAcceptedJobCompanySizes(tab.id, result.jobs, `current-page-${Date.now()}`);

  const response = await importJobs(result.jobs, { recheck_existing: true });
  return {
    saved: response.saved || 0,
    existing_count: response.existing_count || 0,
    deduped: response.deduped || 0,
    queued_for_evaluation: response.queued_for_evaluation || 0,
    queued_candidates: response.queued_candidates || 0,
    not_recommended_count: response.not_recommended_count || 0
  };
}

async function syncBossMessages(sender) {
  const tab = await resolveActiveBossTab(sender);
  await ensureContentScript(tab.id);
  const result = await sendTabMessage(tab.id, { type: "collectBossReplies" });
  if (!result?.ok) throw new Error(result?.error || "\u5f53\u524d\u9875\u9762\u6ca1\u6709\u53ef\u540c\u6b65\u7684\u804a\u5929\u4f1a\u8bdd\u3002");
  if (!Array.isArray(result.conversations) || !result.conversations.length) {
    throw new Error("\u5f53\u524d\u804a\u5929\u9875\u6ca1\u6709\u8bc6\u522b\u5230\u53ef\u89c1\u4f1a\u8bdd\u6216\u6700\u8fd1\u6d88\u606f\u3002");
  }

  return await fetchJson(MESSAGE_SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversations: result.conversations })
  });
}

async function syncBossReplyHistory(sender, payload = {}) {
  const tab = await resolveActiveBossTab(sender);
  await ensureContentScript(tab.id);
  const rangeStart = payload.range_start || payload.start || null;
  const rangeEnd = payload.range_end || payload.end || null;
  const limit = normalizeHistoryLimit(payload.limit);
  const collected = await collectReplyHistoryViaPort(tab.id, `direct-history-${Date.now()}`, {
    limit,
    range_start: rangeStart,
    range_end: rangeEnd
  });
  if (!Array.isArray(collected.conversations) || !collected.conversations.length) {
    throw new Error("\u6ca1\u6709\u8bc6\u522b\u5230\u5386\u53f2\u4f1a\u8bdd\u3002");
  }

  return await fetchJson(MESSAGE_HISTORY_SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversations: collected.conversations,
      range_start: rangeStart,
      range_end: rangeEnd,
      stopped_reason: collected.stopped_reason || ""
    })
  });
}

async function runReplyHistorySync(requestId, run, payload = {}) {
  const tab = await resolveActiveBossTab({});
  const rangeStart = payload.range_start || payload.start || null;
  const rangeEnd = payload.range_end || payload.end || null;
  const limit = normalizeHistoryLimit(payload.limit);
  notifyHistoryRun(run, "reply-history-progress", requestId, {
    phase: "prepare",
    message: `\u51c6\u5907\u626b\u63cf\u5386\u53f2\u804a\u5929\uff0c\u6700\u591a ${limit} \u4e2a\u4f1a\u8bdd\uff0c\u4f1a\u4f4e\u9891\u5207\u6362\u5e76\u5206\u6bb5\u51b7\u5374\u3002`
  });

  await ensureContentScript(tab.id);
  const collected = await collectReplyHistoryViaPort(tab.id, requestId, {
    limit,
    range_start: rangeStart,
    range_end: rangeEnd
  }, (progress) => {
    notifyHistoryRun(run, "reply-history-progress", requestId, progress);
  });

  notifyHistoryRun(run, "reply-history-progress", requestId, {
    phase: "sync",
    message: `\u5df2\u626b\u63cf ${Number(collected.scanned_conversations || 0)} / ${limit} \u4e2a\u4f1a\u8bdd\uff0c\u51c6\u5907\u5165\u5e93\u548c\u5206\u7c7b\u3002`,
    scanned_conversations: Number(collected.scanned_conversations || 0)
  });

  const response = await fetchJson(MESSAGE_HISTORY_SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversations: collected.conversations || [],
      range_start: rangeStart,
      range_end: rangeEnd,
      stopped_reason: collected.stopped_reason || ""
    })
  });

  const skippedCount = (collected.conversations || []).filter((conversation) => conversation.failure_reason).length;
  void trackEvent("task_completed", {
    requested_count: limit,
    success_count: Math.max(0, Number(collected.scanned_conversations || 0) - skippedCount),
    skipped_count: skippedCount,
    type: "history_sync"
  });

  notifyHistoryRun(run, "reply-history-result", requestId, response);
}

function collectReplyHistoryViaPort(tabId, requestId, payload, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      try {
        port?.disconnect();
      } catch {}
      callback(value);
    };

    try {
      port = chrome.tabs.connect(tabId, { name: `resumatch-history-${requestId}` });
    } catch (error) {
      reject(error);
      return;
    }

    port.onMessage.addListener((message) => {
      if (message?.requestId !== requestId) return;
      if (message.type === "history-collection-progress") {
        onProgress?.(message.payload || {});
        return;
      }
      if (message.type === "history-collection-result") {
        finish(resolve, message.payload || {});
        return;
      }
      if (message.type === "history-collection-error") {
        finish(reject, new Error(message.payload?.error || "history_collection_failed"));
      }
    });

    port.onDisconnect.addListener(() => {
      if (!settled) finish(reject, new Error(chrome.runtime.lastError?.message || "history_content_port_disconnected"));
    });

    try {
      port.postMessage({ type: "startReplyHistoryCollection", requestId, payload });
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function runBossSearchBatch(requestId, port, payload) {
  const tasks = Array.isArray(payload.items) ? payload.items : [];
  const options = payload.options || {};
  const pageLimit = Math.max(1, Math.min(Number(payload.page_limit || options.pages || 3), 10));
  if (!tasks.length) throw new Error("\u6ca1\u6709\u53ef\u6267\u884c\u7684 Boss \u641c\u7d22\u4efb\u52a1\u3002");

  notifyWorkbench(port, "boss-search-progress", requestId, {
    phase: "prepare",
    message: `\u5df2\u751f\u6210 ${tasks.length} \u7ec4\u641c\u7d22\u4efb\u52a1\uff0c\u51c6\u5907\u5f00\u59cb\u6293\u53d6\u3002`
  });

  const collectedJobs = [];
  const seen = new Set();
  let filteredOut = 0;
  let deduped = 0;
  let pagesScanned = 0;
  let queuedCandidates = 0;
  const candidateJobIds = new Set();
  let existingCount = 0;
  let notRecommendedCount = 0;
  const filteredReasonCounts = {};
  const softFlagCounts = {};
  const companySizeEnrichment = createCompanySizeEnrichmentSummary();
  const citySummary = createCitySummary(tasks);

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const tab = await chrome.tabs.create({ url: task.url, active: false });
    try {
      await waitForTabComplete(tab.id);
      await ensureContentScript(tab.id);
      notifyWorkbench(port, "boss-search-progress", requestId, {
        phase: "collect",
        message: `\u6b63\u5728\u6293\u53d6\u7b2c ${index + 1}/${tasks.length} \u7ec4\uff1a${task.query}`,
        task_index: index + 1,
        task_total: tasks.length
      });

      for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex += 1) {
        await sleep(1800);
        const pageData = await sendTabMessage(tab.id, { type: "collectBossJobs" });
        if (!pageData?.ok) {
          throw new Error(pageData?.error || `\u7b2c ${pageIndex} \u9875\u91c7\u96c6\u5931\u8d25`);
        }

        pagesScanned += 1;
        const pageJobs = Array.isArray(pageData.jobs) ? pageData.jobs : [];
        const acceptedPageJobs = [];
        for (const job of pageJobs) {
          updateCitySummary(citySummary, task.location, job.location);
          const filterResult = analyzeJobFilters(job, task.filters || {}, { includeCompanySize: false });
          if (!filterResult.passed) {
            addCounts(filteredReasonCounts, filterResult.reasons);
            filteredOut += 1;
            continue;
          }
          acceptedPageJobs.push(job);
        }

        const enrichment = await enrichAcceptedJobCompanySizes(
          tab.id,
          acceptedPageJobs,
          `${requestId}:${index}:${pageIndex}`
        );
        mergeCompanySizeEnrichmentSummary(companySizeEnrichment, enrichment);

        for (const job of acceptedPageJobs) {
          addCounts(softFlagCounts, analyzeCompanySizePreference(job, task.filters || {}));
          if (seen.has(job.source_url)) {
            deduped += 1;
            continue;
          }
          seen.add(job.source_url);
          collectedJobs.push(job);
        }

        notifyWorkbench(port, "boss-search-progress", requestId, {
          phase: "collect",
          message: `\u7b2c ${index + 1}/${tasks.length} \u7ec4\u5df2\u626b\u63cf\u5230\u7b2c ${pageIndex} \u9875\uff0c\u7d2f\u8ba1\u4fdd\u7559 ${collectedJobs.length} \u4e2a\u5c97\u4f4d\u3002`,
          pages_scanned: pagesScanned,
          kept: collectedJobs.length,
          filtered_out: filteredOut,
          deduped,
          filtered_reason_counts: filteredReasonCounts,
          soft_flag_counts: softFlagCounts,
          company_size_missing_count: softFlagCounts.company_size_missing || 0,
          company_size_enrichment: companySizeEnrichment
        });

        const hasNext = pageData.page?.hasNext && !pageData.page?.nextDisabled;
        if (pageIndex >= pageLimit || !hasNext) break;

        const next = await sendTabMessage(tab.id, { type: "goBossNextPage" });
        if (!next?.ok || !next.hasNext) break;
      }
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  notifyWorkbench(port, "boss-search-progress", requestId, {
    phase: "import",
    message: `\u6293\u53d6\u5b8c\u6210\uff0c\u51c6\u5907\u5bfc\u5165 ${collectedJobs.length} \u4e2a\u5c97\u4f4d\u5e76\u542f\u52a8\u540e\u53f0\u8bc4\u4f30\u3002`,
    pages_scanned: pagesScanned,
    kept: collectedJobs.length,
    filtered_out: filteredOut,
    deduped,
    filtered_reason_counts: filteredReasonCounts,
    soft_flag_counts: softFlagCounts,
    company_size_missing_count: softFlagCounts.company_size_missing || 0,
    company_size_enrichment: companySizeEnrichment
  });

  let saved = 0;
  let queued = 0;
  for (const chunk of chunkArray(collectedJobs, 100)) {
    const imported = await importJobs(chunk, {
      ...options,
      recheck_existing: true,
      search_batch_id: requestId
    });
    saved += Number(imported.saved || 0);
    existingCount += Number(imported.existing_count || 0);
    filteredOut += Number(imported.filtered_out || 0);
    addMapCounts(filteredReasonCounts, imported.filtered_reason_counts);
    queued += Number(imported.queued_for_evaluation || 0);
    queuedCandidates += Number(imported.queued_candidates || 0);
    for (const jobId of imported.candidate_job_ids || []) {
      candidateJobIds.add(Number(jobId));
    }
    notRecommendedCount += Number(imported.not_recommended_count || 0);
  }

  notifyWorkbench(port, "boss-search-result", requestId, {
    saved,
    existing_count: existingCount,
    filtered_out: filteredOut,
    deduped,
    queued_for_evaluation: queued,
    queued_candidates: queuedCandidates,
    candidate_job_ids: [...candidateJobIds].filter(Number.isFinite),
    search_batch_id: requestId,
    not_recommended_count: notRecommendedCount,
    pages_scanned: pagesScanned,
    tasks_run: tasks.length,
    filtered_reason_counts: filteredReasonCounts,
    soft_flag_counts: softFlagCounts,
    company_size_missing_count: softFlagCounts.company_size_missing || 0,
    company_size_enrichment: companySizeEnrichment,
    city_summary: serializeCitySummary(citySummary)
  });

  void trackEvent("task_completed", {
    requested_count: tasks.length * pageLimit,
    success_count: saved,
    skipped_count: filteredOut + deduped,
    type: "boss_search"
  });
}

async function getReplySummary() {
  return await fetchJson(REPLY_SUMMARY_URL);
}

async function getHistoryReplySummary(payload = {}) {
  const url = new URL(HISTORY_SUMMARY_URL);
  if (payload.range) url.searchParams.set("range", payload.range);
  if (payload.start) url.searchParams.set("start", payload.start);
  if (payload.end) url.searchParams.set("end", payload.end);
  if (payload.include_supplement) url.searchParams.set("include_supplement", "1");
  return await fetchJson(url.toString());
}

async function getExtensionHealth(sender) {
  const tab = await resolveCurrentTab(sender);
  const url = tab?.url || "";
  const isBossPage = /zhipin\.com/.test(url);
  const isWorkbenchPage = /^http:\/\/127\.0\.0\.1:8788/.test(url);

  if (!tab?.id) {
    return {
      background_ok: true,
      active_tab_found: false,
      active_tab_url: "",
      active_tab_title: "",
      page_type: "no-tab",
      content_script_ready: false
    };
  }

  let contentScriptReady = false;
  let pageType = "unsupported";
  let healthError = "";

  if (isBossPage || isWorkbenchPage) {
    contentScriptReady = await pingContentScript(tab.id);
    if (!contentScriptReady) {
      await ensureContentScript(tab.id).catch((error) => {
        healthError = error.message || "content script unavailable";
      });
      contentScriptReady = await pingContentScript(tab.id);
    }

    if (contentScriptReady) {
      try {
        if (isBossPage) {
          const detected = await sendTabMessage(tab.id, { type: "detectBossPageType" });
          pageType = detected?.page_type || "boss";
        } else if (isWorkbenchPage) {
          pageType = "workbench";
        }
      } catch (error) {
        healthError = error.message || healthError;
      }
    }
  }

  return {
    background_ok: true,
    active_tab_found: true,
    active_tab_url: url,
    active_tab_title: tab.title || "",
    page_type: pageType,
    content_script_ready: contentScriptReady,
    supported_page: isBossPage || isWorkbenchPage,
    health_error: healthError
  };
}

function notifyWorkbench(port, type, requestId, payload) {
  if (!port) return;
  try {
    port.postMessage({ type, requestId, payload });
  } catch {}
}

function normalizeHistoryLimit(value) {
  return Math.max(1, Math.min(Number(value || MAX_HISTORY_CONVERSATIONS), MAX_HISTORY_CONVERSATIONS));
}

async function resolveActiveBossTab(sender) {
  const senderTabId = getSenderTabId(sender);
  const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = currentTabs[0] || (senderTabId ? await chrome.tabs.get(senderTabId).catch(() => null) : null);
  const bossTabs = (await chrome.tabs.query({ currentWindow: true })).filter((item) => item.url?.includes("zhipin.com"));
  const chatTab = await findBestBossChatTab(bossTabs);
  const fallbackBossTab = chatTab || (activeTab?.url?.includes("zhipin.com") ? activeTab : bossTabs[0] || null);
  const tab = fallbackBossTab || activeTab;
  if (!tab?.id) throw new Error("\u6ca1\u6709\u53ef\u540c\u6b65\u7684 Boss \u6807\u7b7e\u9875\u3002");
  if (!tab?.url?.includes("zhipin.com")) {
    throw new Error("请先在当前窗口打开 Boss 页面后再操作。");
  }
  return tab;
}

async function resolveCurrentTab(sender) {
  const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const senderTabId = getSenderTabId(sender);
  return currentTabs[0] || (senderTabId ? await chrome.tabs.get(senderTabId).catch(() => null) : null);
}

async function findBestBossChatTab(tabs) {
  for (const tab of tabs) {
    if (!tab?.id) continue;
    try {
      await ensureContentScript(tab.id);
      const detected = await sendTabMessage(tab.id, { type: "detectBossPageType" });
      if (detected?.ok && detected.page_type === "chat") {
        return tab;
      }
    } catch {}
  }
  return null;
}

async function importJobs(jobs, options) {
  return await fetchJson(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobs, ...options })
  });
}

async function ensureContentScript(tabId) {
  const existing = await pingContentScript(tabId);
  if (existing) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });
  } catch (error) {
    const message = error?.message || "";
    if (
      !message.includes("Cannot access") &&
      !message.includes("The extensions gallery cannot be scripted") &&
      !message.includes("Frame with ID 0 was removed")
    ) {
      throw error;
    }
  }

  const injected = await pingContentScript(tabId);
  if (!injected) {
    throw new Error("内容脚本注入后仍未响应,请刷新 Boss 页面后重试。");
  }
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "pingResuMatchContentScript" });
    return Boolean(response?.ok && response?.ready);
  } catch {
    return false;
  }
}

async function sendTabMessage(tabId, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          const errorMessage = chrome.runtime.lastError?.message || "";
          if (errorMessage) {
            reject(new Error(normalizeChannelError(errorMessage)));
            return;
          }
          resolve(response);
        });
      });
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError || new Error("无法与 Boss 页面通信。");
}

function normalizeChannelError(message) {
  if (
    message.includes("message channel closed") ||
    message.includes("Receiving end does not exist") ||
    message.includes("The message port closed before a response was received")
  ) {
    return "Boss 页面通信中断,通常是页面刷新、跳转或内容脚本失效导致的,请重试。";
  }
  return message;
}

async function waitForTabComplete(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    await sleep(700);
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Boss 页面加载超时。"));
    }, 20000);

    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });

  await sleep(700);
}

function analyzeJobFilters(job, filters = {}, options = {}) {
  const text = `${job.title || ""} ${job.jd_text || ""}`.toLowerCase();
  const reasons = [];
  const softFlags = [];
  const hasTitleFilters = Boolean(filters.job_titles?.length);
  const hasKeywordFilters = Boolean(filters.jd_keywords?.length);
  const titleOk = !hasTitleFilters || filters.job_titles.some((title) => {
    const normalized = String(title || "").toLowerCase();
    if (text.includes(normalized)) return true;
    const tokens = normalizeTitleTokens(normalized);
    return tokens.length > 0 && tokens.every((token) => text.includes(token));
  });
  const keywordOk = !hasKeywordFilters || filters.jd_keywords.some((keyword) => {
    const normalized = String(keyword || "").toLowerCase().trim();
    if (!normalized) return false;
    if (text.includes(normalized)) return true;
    const tokens = tokenizeKeyword(normalized);
    return tokens.length > 0 && tokens.some((token) => text.includes(token));
  });
  const salaryRange = parseSalaryRange(job.salary);
  const salaryOk = rangeIntersects(salaryRange, filters.salary_min, filters.salary_max);
  const intentOk = hasTitleFilters && hasKeywordFilters ? titleOk || keywordOk : titleOk && keywordOk;
  if (!intentOk) reasons.push("title_or_keyword_miss");
  if (!salaryOk) {
    if (salaryRange && filters.salary_min && salaryRange.max < filters.salary_min) {
      reasons.push("salary_below_minimum");
    } else if (salaryRange && filters.salary_max && salaryRange.min > filters.salary_max) {
      reasons.push("salary_above_maximum");
    } else {
      reasons.push("salary_out_of_range");
    }
  }
  if (options.includeCompanySize !== false) {
    softFlags.push(...analyzeCompanySizePreference(job, filters));
  }
  return { passed: intentOk && salaryOk, reasons, soft_flags: softFlags };
}

async function enrichAcceptedJobCompanySizes(tabId, jobs, runId) {
  const pending = jobs.filter((job) => !job.company_size && job.source_url);
  if (!pending.length) return createCompanySizeEnrichmentSummary();

  const response = await sendTabMessage(tabId, {
    type: "enrichBossJobCompanySizes",
    payload: {
      run_id: runId,
      jobs: pending,
      company_size_enrichment_limit: MAX_COMPANY_SIZE_DETAIL_TABS
    }
  }).catch(() => ({ ok: false, results: [], skipped_count: pending.length }));

  const summary = createCompanySizeEnrichmentSummary();
  summary.requested = Math.min(pending.length, MAX_COMPANY_SIZE_DETAIL_TABS);
  summary.skipped = Number(response?.skipped_count || 0);
  if (!response?.ok) {
    for (let index = 0; index < summary.requested; index += 1) {
      addCompanySizeFailure(summary, "page_load_failed");
    }
    return summary;
  }
  const jobsByKey = new Map(pending.map((job) => [job.source_url, job]));
  const detailRequests = [];

  for (const result of Array.isArray(response?.results) ? response.results : []) {
    const job = jobsByKey.get(result.job_key);
    if (!job) continue;
    if (result.status === "enriched" && result.company_size) {
      job.company_size = result.company_size;
      job.company_kind = result.company_kind || "company";
      job.company_size_source = result.company_size_source || "company_basic_info";
      summary.enriched += 1;
      continue;
    }
    if (result.status === "hunter") {
      job.company_size = "";
      job.company_kind = "hunter";
      job.company_size_source = "no_company_basic_info";
      summary.hunter += 1;
      continue;
    }
    if (result.status === "detail_link") {
      const detailLinkKey = `${runId}:${result.job_key}`;
      const detailUrl = companySizeDetailLinks.get(detailLinkKey) || result.detail_url;
      companySizeDetailLinks.delete(detailLinkKey);
      if (detailUrl) detailRequests.push({ job, detail_url: detailUrl });
      else addCompanySizeFailure(summary, "page_load_failed");
      continue;
    }
    addCompanySizeFailure(summary, result.reason || "page_load_failed");
  }

  await hydrateCompanySizesFromDetailTabs(detailRequests, summary);
  return summary;
}

async function hydrateCompanySizesFromDetailTabs(detailRequests, summary) {
  for (const request of detailRequests) {
    let detailTab = null;
    try {
      if (!/^https:\/\/www\.zhipin\.com\//.test(request.detail_url)) {
        throw new Error("invalid detail url");
      }
      detailTab = await chrome.tabs.create({ url: request.detail_url, active: false });
      await waitForTabComplete(detailTab.id);
      await ensureContentScript(detailTab.id);
      const detail = await sendTabMessage(detailTab.id, { type: "collectBossJobs" });
      const detailJob = Array.isArray(detail?.jobs) ? detail.jobs[0] : null;
      if (detailJob?.company_size) {
        request.job.company_size = detailJob.company_size;
        request.job.company_kind = detailJob.company_kind || "company";
        request.job.company_size_source = detailJob.company_size_source || "company_basic_info";
        summary.enriched += 1;
      } else if (detailJob?.company_kind === "hunter") {
        request.job.company_size = "";
        request.job.company_kind = "hunter";
        request.job.company_size_source = "no_company_basic_info";
        summary.hunter += 1;
      } else {
        addCompanySizeFailure(summary, "page_load_failed");
      }
    } catch {
      addCompanySizeFailure(summary, "page_load_failed");
    } finally {
      if (detailTab?.id) await chrome.tabs.remove(detailTab.id).catch(() => {});
    }
  }
}

function createCompanySizeEnrichmentSummary() {
  return { requested: 0, enriched: 0, hunter: 0, skipped: 0, failed: 0, failure_reasons: {} };
}

function addCompanySizeFailure(summary, reason) {
  summary.failed += 1;
  summary.failure_reasons[reason] = Number(summary.failure_reasons[reason] || 0) + 1;
}

function mergeCompanySizeEnrichmentSummary(target, source) {
  for (const key of ["requested", "enriched", "skipped", "failed"]) {
    target[key] += Number(source?.[key] || 0);
  }
  for (const [reason, count] of Object.entries(source?.failure_reasons || {})) {
    target.failure_reasons[reason] = Number(target.failure_reasons[reason] || 0) + Number(count || 0);
  }
}

function analyzeCompanySizePreference(job, filters = {}) {
  if (filters.company_size_min == null && filters.company_size_max == null) return [];
  if (job.company_kind === "hunter") return ["hunter_role"];
  const companySize = parseCompanySizeRange(`${job.company_size || ""} ${job.jd_text || ""}`);
  if (!companySize) return ["company_size_missing"];
  const flags = [];
  if (filters.company_size_min && companySize.max < filters.company_size_min) flags.push("company_size_below_minimum");
  if (filters.company_size_max && companySize.min > filters.company_size_max) flags.push("company_size_above_maximum");
  return flags;
}

function normalizeTitleTokens(value) {
  return String(value || "")
    .replace(/经理|主管|专员|高级|资深|专家|负责人/g, "")
    .split(/[\s/、,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function tokenizeKeyword(value) {
  return String(value || "")
    .split(/[\s/、,,|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function parseSalaryRange(value) {
  const text = String(value || "").toLowerCase();
  const match = text.match(/(\d+(?:\.\d+)?)\s*[-~到至]\s*(\d+(?:\.\d+)?)\s*k?/i) || text.match(/(\d+(?:\.\d+)?)\s*k/i);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2] || match[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

function parseCompanySizeRange(value) {
  const text = String(value || "");
  const rangeMatch = text.match(/(\d+)\s*[-~到至]\s*(\d+)\s*人/);
  if (rangeMatch) return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  const plusMatch = text.match(/(\d+)\s*人以上/);
  if (plusMatch) return { min: Number(plusMatch[1]), max: Infinity };
  const belowMatch = text.match(/少于\s*(\d+)\s*人|(\d+)\s*人以下/);
  if (belowMatch) return { min: 0, max: Number(belowMatch[1] || belowMatch[2]) };
  return null;
}

function rangeIntersects(actual, expectedMin, expectedMax, options = {}) {
  if (expectedMin == null && expectedMax == null) return true;
  if (!actual) return !options.requireActual;
  const min = expectedMin == null ? 0 : Number(expectedMin);
  const max = expectedMax == null ? Infinity : Number(expectedMax);
  return actual.max >= min && actual.min <= max;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function addCounts(target, keys = []) {
  for (const key of keys || []) {
    target[key] = (target[key] || 0) + 1;
  }
}

function addMapCounts(target, source = {}) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + Number(value || 0);
  }
}

function createCitySummary(tasks) {
  const summary = new Map();
  for (const task of tasks) {
    const location = normalizeCityName(task?.location);
    if (location && !summary.has(location)) {
      summary.set(location, { location, returned: 0, matched: 0, mismatched: 0, unknown: 0 });
    }
  }
  return summary;
}

function updateCitySummary(summary, requestedLocation, actualLocation) {
  const requested = normalizeCityName(requestedLocation);
  const item = requested ? summary.get(requested) : null;
  if (!item) return;
  item.returned += 1;
  const actual = normalizeCityName(actualLocation);
  if (!actual) item.unknown += 1;
  else if (actual === requested) item.matched += 1;
  else item.mismatched += 1;
}

function serializeCitySummary(summary) {
  return [...summary.values()].map((item) => ({ ...item }));
}

function normalizeCityName(value) {
  const text = String(value || "").replace(/\s+/g, "");
  const match = text.match(/北京|上海|天津|重庆|广州|深圳|杭州|成都|南京|武汉|西安|苏州|保定|郑州|合肥|长沙|厦门|福州|青岛|济南|宁波|无锡|东莞|佛山/);
  return match?.[0] || "";
}

async function fetchJson(url, options) {
  const { [WORKBENCH_TOKEN_STORAGE_KEY]: token } = await chrome.storage.local.get(WORKBENCH_TOKEN_STORAGE_KEY);
  if (!token) throw new Error("workbench_token_missing");
  const headers = new Headers(options?.headers || {});
  headers.set("X-Workbench-Token", token);
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePortName(port) {
  return typeof port?.name === "string" ? port.name : "";
}

function getSenderTabId(sender) {
  if (!sender || typeof sender !== "object") return 0;
  return Number(sender.tab?.id || 0);
}

