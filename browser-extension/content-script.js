(() => {
  if (globalThis.__RESUMATCH_CONTENT_SCRIPT_INSTALLED__) {
    return;
  }
  globalThis.__RESUMATCH_CONTENT_SCRIPT_INSTALLED__ = true;
  const pageUrl = window.location.href;
  const isBossPage = /zhipin\.com/.test(pageUrl);
  const isWorkbenchPage = /^http:\/\/127\.0\.0\.1:8788/.test(pageUrl);
  const MAX_HISTORY_CONVERSATIONS = 200;
  const HISTORY_COOLDOWN_EVERY = 40;
  let activeHistoryCollection = null;
  const telemetryErrorsReported = new Set();

  if (isBossPage) ensureBridgeBadge();
  if (isWorkbenchPage) installWorkbenchBridge();

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isBossPage) return false;
      handleBossMessage(message)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ ok: false, error: normalizeContentError(error) });
        });
      return true;
    });
  } catch {}

  try {
    chrome.runtime.onConnect.addListener((port) => {
      if (!isBossPage || !String(port?.name || "").startsWith("resumatch-history-")) return;
      port.onMessage.addListener(async (message) => {
        if (message?.type !== "startReplyHistoryCollection") return;
        if (activeHistoryCollection) {
          postHistoryPortMessage(port, "history-collection-error", message.requestId, {
            error: "history_scan_in_progress"
          });
          return;
        }

        const requestId = String(message.requestId || "").trim();
        activeHistoryCollection = { requestId, port };
        try {
          const result = await collectReplyHistory(message.payload || {}, (payload) => {
            postHistoryPortMessage(port, "history-collection-progress", requestId, payload);
          });
          postHistoryPortMessage(port, "history-collection-result", requestId, result);
        } catch (error) {
          postHistoryPortMessage(port, "history-collection-error", requestId, {
            error: normalizeContentError(error)
          });
        } finally {
          activeHistoryCollection = null;
          try {
            port.disconnect();
          } catch {}
        }
      });
    });
  } catch {}

  function postHistoryPortMessage(port, type, requestId, payload) {
    try {
      port.postMessage({ type, requestId, payload });
    } catch {}
  }

  async function handleBossMessage(message) {
    switch (message?.type) {
      case "pingResuMatchContentScript":
        return { ok: true, ready: true };
      case "detectBossPageType":
        return { ok: true, page_type: detectBossPageType() };
      case "diagnoseBossChatPage":
        return { ok: true, diagnosis: diagnoseBossChatPage() };
      case "collectBossJobs": {
        const jobs = collectListJobs();
        const fallback = jobs.length ? jobs : collectDetailJob();
        if (!fallback.length) reportTelemetryError("dom_mismatch");
        return {
          ok: true,
          url: window.location.href,
          title: document.title,
          jobs: fallback,
          page: getPageInfo(fallback)
        };
      }
      case "enrichBossJobCompanySizes": {
        const result = await enrichBossJobCompanySizes(message.payload || {});
        return {
          ok: true,
          results: result.results,
          skipped_count: result.skipped_count
        };
      }
      case "collectBossReplies": {
        const conversations = await collectVisibleReplyConversations();
        return { ok: true, url: window.location.href, title: document.title, conversations };
      }
      case "collectBossReplyHistory": {
        return { ok: false, error: "history_scan_requires_port" };
      }
      case "goBossNextPage":
        return await goBossNextPage();
      default:
        return { ok: false, error: "unknown boss action" };
    }
  }

  function ensureBridgeBadge() {
    if (document.getElementById("resumatch-extension-badge")) return;
    const badge = document.createElement("div");
    badge.id = "resumatch-extension-badge";
    badge.textContent = "ResuMatch \u5df2\u8fde\u63a5";
    Object.assign(badge.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      padding: "8px 12px",
      borderRadius: "999px",
      background: "rgba(15, 23, 42, 0.92)",
      color: "#fff",
      fontSize: "12px",
      fontWeight: "700",
      boxShadow: "0 12px 24px rgba(15, 23, 42, 0.18)",
      pointerEvents: "none"
    });
    document.documentElement.appendChild(badge);
    window.setTimeout(() => {
      badge.style.opacity = "0.4";
    }, 4000);
  }

  function installWorkbenchBridge() {
    const activePorts = new Map();

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.source !== "resumatch-workbench") return;

      if (data.type === "runBossSearch" || data.type === "runReplyHistorySync") {
        const requestId = data.requestId;
        if (!canUseExtensionRuntime()) {
          postWorkbenchEvent(`${data.type === "runBossSearch" ? "boss-search" : "reply-history"}-error`, requestId, {
            error: "\u6269\u5c55\u4e0a\u4e0b\u6587\u5df2\u5931\u6548\uff0c\u8bf7\u5148\u5728 chrome://extensions \u5237\u65b0 ResuMatch \u6269\u5c55\uff0c\u518d\u5237\u65b0\u5de5\u4f5c\u53f0\u3002"
          });
          return;
        }

        let port;
        try {
          port = chrome.runtime.connect({ name: `resumatch-workbench-${requestId}` });
        } catch (error) {
          postWorkbenchEvent(`${data.type === "runBossSearch" ? "boss-search" : "reply-history"}-error`, requestId, {
            error: error?.message || "\u6269\u5c55\u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u5237\u65b0\u6269\u5c55\u548c\u5de5\u4f5c\u53f0\u540e\u91cd\u8bd5\u3002"
          });
          return;
        }

        activePorts.set(requestId, port);
        port.onMessage.addListener((message) => {
          postWorkbenchEvent(message.type, message.requestId || requestId, message.payload || {});
          if (["boss-search-result", "boss-search-error", "reply-history-result", "reply-history-error"].includes(message.type)) {
            activePorts.delete(requestId);
            port.disconnect();
          }
        });

        port.onDisconnect.addListener(() => {
          if (!activePorts.has(requestId)) return;
          activePorts.delete(requestId);
          if (chrome.runtime.lastError?.message) {
            postWorkbenchEvent(`${data.type === "runBossSearch" ? "boss-search" : "reply-history"}-error`, requestId, {
              error: chrome.runtime.lastError.message
            });
          }
        });

        port.postMessage({
          type: data.type,
          requestId,
          payload: data.payload || {}
        });
        postWorkbenchEvent(`${data.type === "runBossSearch" ? "boss-search" : "reply-history"}-accepted`, requestId, { ok: true });
      }
    });

    postWorkbenchEvent("extension-ready", "bootstrap", { ok: true });
  }

  function postWorkbenchEvent(type, requestId, payload) {
    window.postMessage({ source: "resumatch-extension", type, requestId, payload }, "*");
  }

  function canUseExtensionRuntime() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function pickText(root, selector) {
    return cleanText(root?.querySelector(selector)?.textContent || "");
  }

  function normalizeJob(job) {
    return {
      ...job,
      title: cleanText(job.title || ""),
      company: cleanText(job.company || ""),
      location: cleanText(job.location || ""),
      salary: cleanText(job.salary || ""),
      company_size: cleanText(job.company_size || ""),
      company_kind: cleanText(job.company_kind || "unknown") || "unknown",
      company_size_source: cleanText(job.company_size_source || "unverified") || "unverified",
      jd_text: cleanText(job.jd_text || "")
    };
  }

  function extractCompanySizeText(root, fallbackText = "") {
    const scope = root || document;
    const candidates = [
      ".company-tag-list",
      "[class*=company-tag]",
      "[class*=scale]",
      "[class*=company-info]",
      "[class*=companyInfo]",
      "[class*=company-card]",
      "[class*=companyCard]",
      "[class*=sider-company]",
      "[class*=job-company]",
      "[class*=base-info]",
      "[class*=basic-info]"
    ];

    for (const selector of candidates) {
      const nodes = [...scope.querySelectorAll(selector)];
      for (const node of nodes) {
        const text = cleanText(node.textContent || "");
        const matched = matchCompanySizeText(text);
        if (matched) {
          return matched;
        }
      }
    }

    return matchCompanySizeText(fallbackText || cleanText(scope.textContent || "")) || "";
  }

  function matchCompanySizeText(text) {
    const source = cleanText(text);
    if (!source) return "";

    const rangeMatch = source.match(/(\d{1,6})\s*[-~\u5230\u81f3]\s*(\d{1,6})\s*\u4eba?/);
    if (rangeMatch) {
      return `${rangeMatch[1]}-${rangeMatch[2]}\u4eba`;
    }

    const plusMatch = source.match(/(\d{1,6})\s*\u4eba(?:\u4ee5\u4e0a|\+)/);
    if (plusMatch) {
      return `${plusMatch[1]}\u4eba\u4ee5\u4e0a`;
    }

    const belowMatch = source.match(/(?:\u5c11\u4e8e\s*(\d{1,6})\s*\u4eba|(\d{1,6})\s*\u4eba\u4ee5\u4e0b)/);
    if (belowMatch) {
      return `${belowMatch[1] || belowMatch[2]}\u4eba\u4ee5\u4e0b`;
    }

    return "";
  }

  function dedupeJobs(jobs) {
    return jobs.filter((job, index, items) =>
      job.source_url &&
      job.title &&
      !["\u67e5\u770b\u66f4\u591a\u4fe1\u606f", "\u804c\u4f4d\u641c\u7d22"].includes(job.title) &&
      items.findIndex((item) => item.source_url === job.source_url) === index
    );
  }

  function collectListJobs() {
    const links = [...document.querySelectorAll("a[href*='job_detail']")];
    return dedupeJobs(
      links.slice(0, 100).map((link) => {
        const card =
          link.closest(".job-card-wrapper") ||
          link.closest(".job-card-body") ||
          link.closest(".job-primary") ||
          link.closest("li") ||
          link.parentElement;
        return normalizeJob({
          source_url: link.href,
          title:
            pickText(card, ".job-name, .job-title, [class*=job-name], [class*=job-title]") ||
            cleanText(link.textContent || ""),
          company: pickText(card, ".company-name, [class*=company-name], [class*=company]"),
          salary: pickText(card, ".salary, [class*=salary]"),
          location: pickText(card, ".job-area, [class*=area], [class*=location]"),
          company_size: "",
          company_kind: "unknown",
          company_size_source: "unverified",
          jd_text: cleanText(card?.textContent || "").slice(0, 3000)
        });
      })
    );
  }

  async function enrichBossJobCompanySizes(options = {}) {
    const requestedJobs = Array.isArray(options.jobs) ? options.jobs : [];
    const runId = cleanText(options.run_id || "");
    const limit = Math.max(0, Math.min(Number(options.company_size_enrichment_limit || 20), 40));
    const pending = requestedJobs.filter((job) => job?.source_url && job.company_size_source !== "company_basic_info" && job.company_kind !== "hunter");
    const selected = pending.slice(0, limit);
    const results = [];

    for (const job of selected) {
      results.push(await enrichCompanySizeFromPreview(job, runId));
      await sleep(250);
    }

    return { results, skipped_count: Math.max(0, pending.length - selected.length) };
  }

  async function enrichCompanySizeFromPreview(job, runId) {
    const jobKey = companySizeJobKey(job);
    const link = findJobLink(job.source_url);
    const card = link && findJobCard(link);
    if (!card || !clickPreviewTrigger(card, link)) {
      reportTelemetryError("dom_mismatch");
      return companySizeFailure(jobKey, "dom_mismatch");
    }

    const preview = await waitForPreviewPanel(job);
    if (!preview) {
      reportTelemetryError("timeout");
      return companySizeFailure(jobKey, "dom_mismatch");
    }

    const moreButton = await waitForElement(() => findMoreCompanyInfoButton(preview), 3000);
    if (!moreButton) {
      reportTelemetryError("timeout");
      return companySizeFailure(jobKey, "timeout_no_button");
    }

    if (isNavigationLink(moreButton)) {
      const detailUrl = moreButton.href;
      reportCompanySizeDetailLink({ run_id: runId, job_key: jobKey, detail_url: detailUrl });
      return { status: "detail_link", job_key: jobKey, detail_url: detailUrl };
    }

    moreButton.click();
    const companyCard = await waitForCompanyBasicInfoCard();
    if (!companyCard) {
      return {
        status: "hunter",
        job_key: jobKey,
        company_size: "",
        company_kind: "hunter",
        company_size_source: "no_company_basic_info"
      };
    }

    const companySize = extractCompanySizeFromBasicInfoCard(companyCard);
    if (!companySize) return companySizeFailure(jobKey, "company_size_missing");
    return {
      status: "enriched",
      job_key: jobKey,
      company_size: companySize,
      company_kind: "company",
      company_size_source: "company_basic_info"
    };
  }

  function companySizeJobKey(job) {
    return cleanText(job?.source_url || "");
  }

  function companySizeFailure(jobKey, reason) {
    return { status: "failed", reason, job_key: jobKey, company_size: "" };
  }

  function reportCompanySizeDetailLink(payload) {
    try {
      chrome.runtime.sendMessage({ type: "companySizeDetailLink", payload }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
  }

  function findJobLink(sourceUrl) {
    const normalizedUrl = String(sourceUrl || "").split("#")[0];
    return [...document.querySelectorAll("a[href*='job_detail']")].find((link) => {
      return String(link.href || "").split("#")[0] === normalizedUrl;
    }) || null;
  }

  function findJobCard(link) {
    return link?.closest(".job-card-wrapper") ||
      link?.closest(".job-card-body") ||
      link?.closest(".job-primary") ||
      link?.closest("li") ||
      link?.parentElement ||
      null;
  }

  function clickPreviewTrigger(card, link) {
    const trigger = [card, ...card.querySelectorAll("[role=button], button, [class*=job-card], [class*=job-primary]")]
      .find((node) => node !== link && node.tagName !== "A" && isVisible(node));
    if (!trigger) return false;
    trigger.click();
    return true;
  }

  function findMoreCompanyInfoButton(preview) {
    const candidates = [...preview.querySelectorAll("button, a, [role=button], div")];
    return candidates.find((node) => {
      const text = cleanText(node.textContent || "");
      return text === "\u67e5\u770b\u66f4\u591a\u4fe1\u606f" && isVisible(node);
    }) || null;
  }

  function isNavigationLink(node) {
    return node?.tagName === "A" && Boolean(node.href) && node.getAttribute("href") !== "#";
  }

  function isVisible(node) {
    const style = window.getComputedStyle(node);
    return Boolean(node?.getClientRects?.().length) && style.display !== "none" && style.visibility !== "hidden";
  }

  function waitForCompanySize(readSize, timeoutMs = 4500) {
    return new Promise((resolve) => {
      const immediate = readSize();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observer = new MutationObserver(() => {
        const value = readSize();
        if (!value) return;
        cleanup();
        resolve(value);
      });
      const timer = window.setTimeout(() => {
        cleanup();
        resolve("");
      }, timeoutMs);
      const cleanup = () => {
        window.clearTimeout(timer);
        observer.disconnect();
      };
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    });
  }

  function findCompanyBasicInfoCard(scope = document) {
    const heading = [...scope.querySelectorAll("h1, h2, h3, h4, strong, span, div, p")]
      .find((node) => cleanText(node.textContent || "") === "\u516c\u53f8\u57fa\u672c\u4fe1\u606f" && isVisible(node));
    if (!heading) return null;

    const candidates = [
      heading.closest("[class*=company], [class*=basic], [class*=info]"),
      heading.parentElement,
      heading.parentElement?.parentElement,
      heading.parentElement?.parentElement?.parentElement
    ].filter(Boolean);
    return candidates.find((node) => isVisible(node)) || null;
  }

  function extractCompanySizeFromBasicInfoCard(card) {
    return card ? matchCompanySizeText(cleanText(card.textContent || "")) : "";
  }

  function waitForCompanyBasicInfoCard(timeoutMs = 5000) {
    return waitForElement(() => findCompanyBasicInfoCard(document), timeoutMs);
  }

  function waitForElement(readElement, timeoutMs = 4500) {
    return new Promise((resolve) => {
      const immediate = readElement();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observer = new MutationObserver(() => {
        const value = readElement();
        if (!value) return;
        cleanup();
        resolve(value);
      });
      const timer = window.setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        window.clearTimeout(timer);
        observer.disconnect();
      };
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    });
  }

  async function waitForPreviewPanel(job, timeoutMs = 3500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const panel = findPreviewPanel(job);
      if (panel) return panel;
      await sleep(200);
    }
    return null;
  }

  function findPreviewPanel(job) {
    return previewPanels().find((panel) => previewMatchesJob(panel, job)) || null;
  }

  function previewPanels() {
    return [...document.querySelectorAll("[role=dialog], [class*=drawer], [class*=preview], [class*=detail], [class*=panel]")]
      .filter((node) => isVisible(node));
  }

  function previewMatchesJob(panel, job) {
    const expectedTitle = normalizePreviewIdentity(job?.title);
    const expectedCompany = normalizePreviewIdentity(job?.company);
    const actualTitle = normalizePreviewIdentity(pickText(panel, ".job-name, .job-title, [class*=job-name], [class*=job-title], h1, h2"));
    const actualCompany = normalizePreviewIdentity(pickText(panel, ".company-name, [class*=company-name], [class*=brand]"));
    const titleMatches = expectedTitle && actualTitle && (actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle));
    const companyMatches = expectedCompany && actualCompany && (actualCompany.includes(expectedCompany) || expectedCompany.includes(actualCompany));
    return Boolean(titleMatches || companyMatches);
  }

  function normalizePreviewIdentity(value) {
    return cleanText(value).toLowerCase().replace(/[\s\-()\[\]{}]/g, "");
  }

  function collectDetailJob() {
    const url = window.location.href;
    if (!/job_detail|job-detail|job\/\w+/i.test(url)) return [];
    const title = pickText(document, ".job-name, .job-title, [class*=job-name], [class*=job-title], h1");
    if (!title) return [];
    const companyCard = findCompanyBasicInfoCard(document);
    const companySize = extractCompanySizeFromBasicInfoCard(companyCard);
    return [
      normalizeJob({
        source_url: url,
        title,
        company: pickText(document, ".company-name, [class*=company-name], [class*=brand], [class*=company]"),
        salary: pickText(document, ".salary, [class*=salary]"),
        location: pickText(document, ".job-area, [class*=area], [class*=location]"),
        company_size: companySize,
        company_kind: companyCard ? "company" : "hunter",
        company_size_source: companyCard ? (companySize ? "company_basic_info" : "company_size_missing") : "no_company_basic_info",
        jd_text: cleanText(document.body?.innerText || "").slice(0, 3000)
      })
    ];
  }

  function getPageInfo(jobs = []) {
    const nextButton = findNextPageButton();
    return {
      currentPage: getCurrentPageNumber(),
      hasNext: Boolean(nextButton),
      nextDisabled: isDisabled(nextButton),
      firstJobUrl: jobs[0]?.source_url || firstJobUrl()
    };
  }

  async function collectVisibleReplyConversations() {
    assertChatPage();
    const cards = getVisibleConversationCards().slice(0, 12);
    const conversations = [];

    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const meta = extractConversationMeta(card, index, 0);
      if (!meta.title) continue;
      const before = currentConversationSnapshot();
      if (isActiveConversationCard(card, before, meta)) continue;
      clickConversationCard(card);
      const switched = await waitForConversationSwitch(before, meta);
      if (!switched.ok) continue;
      const messages = collectCurrentConversationMessages(findConversationPane());
      if (!messages.length) continue;
      conversations.push({
        ...meta,
        conversation: messages.slice(-12),
        last_message_at: messages[messages.length - 1]?.sent_at || null
      });
    }

    return conversations;
  }

  async function collectReplyHistory(options = {}, onProgress) {
    assertChatPage();
    const listContainer = findConversationSidebarStrict();
    if (!listContainer) {
      throw new Error("DOM_NODE_NOT_FOUND");
    }

    const limit = Math.max(1, Math.min(Number(options.limit || MAX_HISTORY_CONVERSATIONS), MAX_HISTORY_CONVERSATIONS));
    const requestId = String(options.request_id || "").trim();
    const scannedKeys = new Set();
    const conversations = [];
    const failureReasons = {};
    let stagnantRounds = 0;
    let windowIndex = 0;

    while (conversations.length < limit && stagnantRounds < 4) {
      assertNoBlockingChatState();
      await emitHistoryProgress(requestId, {
        phase: "scan",
        scanned_conversations: conversations.length,
        limit,
        message: `\u626b\u63cf\u7b2c ${Math.min(conversations.length + 1, limit)} \u4e2a\u4f1a\u8bdd\uff0c\u5df2\u5b8c\u6210 ${conversations.length} / ${limit}\u3002`
      }, onProgress);
      const visibleCards = getVisibleConversationCards();
      if (!visibleCards.length) {
        throw new Error("DOM_NODE_NOT_FOUND");
      }

      const freshCards = [];
      visibleCards.forEach((card, index) => {
        const meta = extractConversationMeta(card, index, windowIndex);
        if (!meta.conversation_key || scannedKeys.has(meta.conversation_key)) return;
        freshCards.push({ card, meta });
      });

      if (!freshCards.length) {
        stagnantRounds += 1;
        scrollConversationList(listContainer);
        await sleep(900);
        windowIndex += 1;
        continue;
      }

      stagnantRounds = 0;

      for (const { card, meta } of freshCards) {
        if (conversations.length >= limit) break;
        assertNoBlockingChatState();
        const item = {
          ...meta,
          conversation: [],
          switch_attempted: true,
          switch_succeeded: false,
          scan_started_at: new Date().toISOString(),
          scan_finished_at: null
        };
        await randomDelay(2000, 5000);
        const before = currentConversationSnapshot();
        let switched = { ok: true, after: before };
        if (!isActiveConversationCard(card, before, meta)) {
          clickConversationCard(card);
          switched = await waitForConversationSwitch(before, meta);
        }
        if (!switched.ok) {
          await randomDelay(2200, 4200);
          clickConversationCard(card);
          switched = await waitForConversationSwitch(before, meta);
        }
        if (!switched.ok) {
          reportTelemetryError("timeout");
          item.failure_reason = "conversation_switch_failed";
          item.scan_finished_at = new Date().toISOString();
          conversations.push(item);
          scannedKeys.add(meta.conversation_key);
          failureReasons[item.failure_reason] = (failureReasons[item.failure_reason] || 0) + 1;
          continue;
        }

        const messages = await readConversationMessagesWithRetry();
        if (!messages.length) {
          reportTelemetryError("dom_mismatch");
          item.failure_reason = "message_parse_failed";
          item.scan_finished_at = new Date().toISOString();
          conversations.push(item);
          scannedKeys.add(meta.conversation_key);
          failureReasons[item.failure_reason] = (failureReasons[item.failure_reason] || 0) + 1;
          continue;
        }

        item.switch_succeeded = true;
        item.conversation = messages.slice(-12);
        item.last_message_at = messages[messages.length - 1]?.sent_at || null;
        item.scan_started_at = before.captured_at;
        item.scan_finished_at = new Date().toISOString();
        conversations.push(item);
        scannedKeys.add(meta.conversation_key);

        await emitHistoryProgress(requestId, {
          phase: "scan",
          scanned_conversations: conversations.length,
          limit,
          message: `\u5df2\u5b8c\u6210 ${conversations.length} / ${limit} \u4e2a\u4f1a\u8bdd\u3002`
        }, onProgress);

        if (conversations.length < limit && conversations.length % HISTORY_COOLDOWN_EVERY === 0) {
          await runHistoryCooldown(requestId, conversations.length, limit, onProgress);
        }
      }

      scrollConversationList(listContainer);
      await sleep(1000);
      windowIndex += 1;
    }

    return {
      url: window.location.href,
      title: document.title,
      conversations,
      scanned_conversations: conversations.length,
      failure_reasons: failureReasons,
      stopped_reason: conversations.length >= limit ? "limit_reached" : stagnantRounds >= 4 ? "no_more_visible_conversations" : ""
    };
  }

  function assertChatPage() {
    const bodyText = cleanText(document.body?.innerText || "");
    if (/\u767b\u5f55|\u626b\u7801|\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u8bbf\u95ee\u53d7\u9650/.test(bodyText)) {
      reportTelemetryError(blockingPageErrorType(bodyText));
      throw new Error("boss_auth_or_risk_page");
    }
    if (!isStandardChatRoute()) {
      throw new Error("AUTH_TIMEOUT");
    }
    if (window.innerWidth < 1200) {
      throw new Error("VIEWPORT_UNSUPPORTED");
    }
    const pageType = detectBossPageType();
    if (pageType !== "chat") {
      throw new Error("boss_chat_page_required");
    }
  }

  function detectBossPageType() {
    const url = window.location.href;
    const bodyText = cleanText(document.body?.innerText || "");
    const sidebar = findConversationSidebarStrict();
    const pane = findConversationPane();
    const cards = getVisibleConversationCards();
    const hasMessageNodes = collectCurrentConversationMessages(pane).length >= 1;
    const hasChatSignals =
      /\/web\/geek\/chat(?:[/?#]|$)/i.test(url) ||
      /\u804a\u5929|\u6d88\u606f/.test(document.title || "") ||
      (Boolean(sidebar) && Boolean(pane)) ||
      (cards.length >= 2 && Boolean(pane)) ||
      hasMessageNodes;

    if (hasChatSignals) return "chat";
    if (/job_detail|job-detail|job\/\w+/i.test(url)) return "detail";
    if (document.querySelectorAll("a[href*='job_detail']").length > 0) return "list";
    if (/web\/geek\/jobs/i.test(url)) return "list";
    if (/登录|扫码|验证码|安全验证|访问受限/.test(bodyText)) return "auth";
    return "unknown";
  }

  function isStandardChatRoute() {
    return /\/web\/geek\/chat(?:[/?#]|$)/i.test(window.location.href);
  }

  function findChatListContainer() {
    return findConversationSidebarStrict();
  }

  function findConversationSidebarStrict() {
    const directContainer =
      document.querySelector(".chat-user-panel .user-list-content") ||
      document.querySelector('.chat-user-panel div[class*="list-content"]') ||
      document.querySelector(".chat-user-panel");
    if (directContainer instanceof HTMLElement) {
      return directContainer;
    }

    const directCards = findGlobalConversationCardCandidates();
    const derivedContainer = deriveSidebarFromCards(directCards);
    if (derivedContainer) {
      return derivedContainer;
    }

    const leftInputs = [...document.querySelectorAll("input")].filter((element) => {
      if (!(element instanceof HTMLInputElement)) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < window.innerWidth * 0.28 && rect.top < window.innerHeight * 0.2 && rect.width >= 160;
    });

    for (const input of leftInputs) {
      let current = input.parentElement;
      while (current) {
        const rect = current.getBoundingClientRect();
        const avatarCount = current.querySelectorAll("img, [class*='avatar'], [style*='background-image']").length;
        if (
          rect.left < window.innerWidth * 0.22 &&
          rect.width >= 220 &&
          rect.width <= Math.min(520, window.innerWidth * 0.38) &&
          rect.height >= Math.max(360, window.innerHeight * 0.5) &&
          avatarCount >= 3
        ) {
          return current;
        }
        current = current.parentElement;
      }
    }

    const candidates = [...document.querySelectorAll("div, aside, section, ul, ol")].filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.26) return false;
      if (rect.width < 200 || rect.width > Math.min(560, window.innerWidth * 0.4)) return false;
      if (rect.height < Math.max(320, window.innerHeight * 0.45)) return false;
      return true;
    });

    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const rowCount = countSidebarRowCandidates(element, rect);
      const avatarCount = element.querySelectorAll("img, [class*='avatar'], [style*='background-image']").length;
      const inputCount = element.querySelectorAll("input").length;
      const score = rowCount * 24 + Math.min(avatarCount, 12) * 10 + inputCount * 18 - rect.left;
      if (rowCount >= 2 && avatarCount >= 3 && score > bestScore) {
        bestScore = score;
        best = element;
      }
    }

    return best;
  }

  function findGlobalConversationCardCandidates() {
    return [...document.querySelectorAll(".user-list-item, div, li, a, section, article")]
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.left > window.innerWidth * 0.4) return false;
        if (rect.width < 180 || rect.width > Math.min(520, window.innerWidth * 0.42)) return false;
        if (rect.height < 44 || rect.height > 170) return false;
        return isStandaloneConversationCard(element);
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function deriveSidebarFromCards(cards) {
    if (!Array.isArray(cards) || cards.length < 2) return null;
    let best = null;
    let bestScore = -Infinity;

    for (const card of cards.slice(0, 12)) {
      let current = card.parentElement;
      let hops = 0;
      while (current && hops < 8) {
        if (!(current instanceof HTMLElement)) break;
        const rect = current.getBoundingClientRect();
        const rowCount = countSidebarRowCandidates(current, rect);
        const avatarCount = current.querySelectorAll("img, [class*='avatar'], [style*='background-image']").length;
        const score = rowCount * 30 + Math.min(avatarCount, 12) * 8 - hops * 6;
        if (
          rect.left < window.innerWidth * 0.32 &&
          rect.width >= 220 &&
          rect.width <= Math.min(560, window.innerWidth * 0.42) &&
          rect.height >= Math.max(320, window.innerHeight * 0.45) &&
          rowCount >= 2 &&
          score > bestScore
        ) {
          best = current;
          bestScore = score;
        }
        current = current.parentElement;
        hops += 1;
      }
    }

    return best;
  }

  function countSidebarRowCandidates(container, sidebarRect = container?.getBoundingClientRect()) {
    if (!(container instanceof HTMLElement) || !sidebarRect) return 0;
    return [...container.querySelectorAll("div, li, a, section, article")].filter((child) =>
      isSidebarConversationCard(child, sidebarRect)
    ).length;
  }

  function scrollConversationList(container) {
    const delta = Math.max(240, (container?.clientHeight || window.innerHeight || 600) * 0.85);
    if (container && typeof container.scrollTop === "number") {
      container.scrollTop += delta;
      return;
    }
    window.scrollBy({ top: delta, behavior: "auto" });
  }

  function getVisibleConversationCards() {
    const sidebar = findConversationSidebarStrict();
    if (!sidebar) return dedupeConversationCards(findGlobalConversationCardCandidates());
    const sidebarRect = sidebar.getBoundingClientRect();
    const preferredCards = [...sidebar.querySelectorAll(".friend-content-warp, .friend-content, .user-list-item, [class*='friend-content']")]
      .map((element) => normalizeConversationCardElement(element))
      .filter((element) => isSidebarConversationCard(element, sidebarRect));
    const directCards = (preferredCards.length ? preferredCards : [...sidebar.querySelectorAll(".user-list-item")]).filter((element) =>
      isSidebarConversationCard(element, sidebarRect)
    );
    const raw = (directCards.length ? directCards : [...sidebar.querySelectorAll("div, li, a, section, article")])
      .map((element) => normalizeConversationCardElement(element))
      .filter((element) => isSidebarConversationCard(element, sidebarRect))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    return dedupeConversationCards(raw);
  }

  function normalizeConversationCardElement(element) {
    if (!(element instanceof HTMLElement)) return element;
    return (
      element.closest(".friend-content-warp") ||
      element.closest(".friend-content") ||
      element.closest(".user-list-item") ||
      element
    );
  }

  function dedupeConversationCards(cards) {
    const deduped = [];
    for (const element of cards) {
      if (!(element instanceof HTMLElement)) continue;
      if (/\btext\b/.test(element.className || "")) continue;
      if (deduped.some((existing) => existing.contains(element) || element.contains(existing))) continue;
      deduped.push(element);
    }
    return deduped;
  }

  function isSidebarConversationCard(element, sidebarRect = element?.parentElement?.getBoundingClientRect()) {
    if (!(element instanceof HTMLElement) || !sidebarRect) return false;
    const rect = element.getBoundingClientRect();
    const rawText = String(element.innerText || "");
    const text = cleanText(rawText);
    if (rect.width < sidebarRect.width * 0.6 || rect.width > sidebarRect.width + 12) return false;
    if (rect.left < sidebarRect.left - 8 || rect.right > sidebarRect.right + 8) return false;
    if (rect.top < sidebarRect.top || rect.bottom > sidebarRect.bottom + 4) return false;
    if (rect.height < 44 || rect.height > 170) return false;
    if (!text || text.length < 6 || text.length > 220) return false;
    if (rect.left > window.innerWidth * 0.32) return false;
    return isStandaloneConversationCard(element, rawText, text);
  }

  function isStandaloneConversationCard(element, rawText = String(element?.innerText || ""), text = cleanText(rawText)) {
    if (!(element instanceof HTMLElement)) return false;
    const lines = rawText.split(/\n+/).map((item) => cleanText(item)).filter(Boolean);
    if (!lines.length) return false;

    const hasAvatar = Boolean(element.querySelector("img, [class*='avatar'], [style*='background-image']"));
    const hasTime = looksLikeChatTime(text);
    const hasPreview = lines.slice(1).some((line) => line.length >= 4) || text.length >= 10;
    const badText = /发送简历|换电话|换微信|电话号码|微信号|查看职位|Boss已开启AI自动沟通|附件简历|同意|拒绝|搜索30天内的联系人/.test(text);
    if (badText) return false;

    return (hasAvatar || hasTime) && hasPreview;
  }

  function looksLikeChatTime(text) {
    const value = cleanText(text);
    if (!value) return false;
    return (
      /\d{1,2}:\d{2}/.test(value) ||
      /昨天|前天|刚刚/.test(value) ||
      /\d{2}月\d{2}日/.test(value) ||
      /\d{2}\/\d{2}/.test(value)
    );
  }

  function stripLeadingChatTime(text) {
    return cleanText(String(text || "").replace(/^(昨天|前天|刚刚)\s*/, "").replace(/^\d{1,2}:\d{2}\s*/, ""));
  }

  function isIgnoredConversationText(text) {
    const value = cleanText(text);
    if (!value) return true;
    return /你与该职位竞争者PK情况|查看详细分析|Boss已开启AI自动沟通|AI生成回复|查看职位|与您进行过沟通的 Boss 都会在左侧列表中显示|共人投递|优秀竞争者会|建议你/.test(value);
  }

  function assertNoBlockingChatState() {
    const bodyText = cleanText(document.body?.innerText || "");
    if (/\u767b\u5f55|\u626b\u7801|\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u8bbf\u95ee\u53d7\u9650|captcha|risk control/i.test(bodyText)) {
      reportTelemetryError(blockingPageErrorType(bodyText));
      throw new Error("boss_auth_or_risk_page");
    }
  }

  function blockingPageErrorType(bodyText) {
    return /\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u8bbf\u95ee\u53d7\u9650|captcha|risk control/i.test(bodyText)
      ? "captcha_blocked"
      : "login_redirect";
  }

  function reportTelemetryError(errorType) {
    if (telemetryErrorsReported.has(errorType)) return;
    telemetryErrorsReported.add(errorType);
    try {
      chrome.runtime.sendMessage({
        type: "telemetry_event",
        event: "error_triggered",
        properties: {
          error_type: errorType,
          source: "content_script"
        }
      });
    } catch {}
  }

  function normalizeContentError(error) {
    const message = String(error?.message || "");
    if (["DOM_NODE_NOT_FOUND", "AUTH_TIMEOUT", "VIEWPORT_UNSUPPORTED", "boss_auth_or_risk_page", "boss_chat_page_required"].includes(message)) {
      return message;
    }
    return "DOM_PARSE_ERROR";
  }

  function isUsefulConversationMessage(text) {
    const value = cleanText(text);
    if (!value) return false;
    if (value.length < 2 || value.length > 500) return false;
    if (isIgnoredConversationText(value)) return false;
    if (/^(送达|已读|未读|已发送|发送简历|换电话|换微信|电话号码|微信号|查看|更多)$/.test(value)) return false;
    return true;
  }

  function isInboundResumeCardText(text) {
    const value = cleanText(text);
    return /(?:我想要一份|请(?:您)?(?:发|提供|发送)|麻烦(?:您)?(?:发|提供)|方便(?:发|提供)).{0,24}(?:附件|最新|在线)?(?:简历|履历|作品集)|(?:附件|在线|最新)简历.{0,32}(?:是否同意|同意|拒绝)/u.test(value);
  }

  function extractConversationMeta(card, index, windowIndex) {
    const rawLines = String(card.innerText || "")
      .split(/\n+/)
      .map((item) => cleanText(item))
      .filter(Boolean);
    const text = cleanText(card.textContent || "");
    const nonTimeLines = rawLines.filter((line) => !looksLikeChatTime(line));
    const nameText = stripLeadingChatTime(
      card.querySelector(".name, .user-name, [class*='name'], [class*='title']")?.textContent ||
      nonTimeLines[0] ||
      rawLines[0] ||
      ""
    );
    const subText = stripLeadingChatTime(
      card.querySelector(".company-name, .company, [class*='company-name'], [class*='company'], [class*='brand']")?.textContent ||
      nonTimeLines.find((line, lineIndex) => lineIndex > 0 && line !== nameText) ||
      ""
    );
    const timeText = cleanText(
      card.querySelector("time, [class*='time']")?.textContent ||
      rawLines.find((line) => looksLikeChatTime(line)) ||
      ""
    );
    const sourceUrl = card.querySelector("a[href*='job_detail']")?.href || "";
    const dataKey =
      card.getAttribute("data-id") ||
      card.getAttribute("data-key") ||
      card.dataset?.id ||
      card.dataset?.key ||
      "";
    const conversationKey = cleanText(dataKey || `${nameText}::${subText}::${timeText}::${windowIndex}-${index}`);
    const previewText = nonTimeLines
      .map((line) => stripLeadingChatTime(line))
      .filter((line) => line && line !== nameText && line !== subText && !isIgnoredConversationText(line))
      .join(" ")
      .slice(0, 120);

    return {
      source_url: sourceUrl,
      title: nameText,
      company: subText && subText !== nameText ? subText : "",
      conversation_key: conversationKey,
      preview_text: previewText,
      raw_text: text
    };
  }

  function getSelectedConversationMeta() {
    const cards = getVisibleConversationCards();
    for (const [index, card] of cards.entries()) {
      if (!isMarkedAsActiveCard(card)) continue;
      return extractConversationMeta(card, index, 0);
    }
    return null;
  }

  function clickConversationCard(card) {
    const normalizedCard = normalizeConversationCardElement(card);
    const clickable =
      normalizedCard.querySelector(".friend-content") ||
      normalizedCard.querySelector(".friend-content-warp") ||
      normalizedCard.querySelector("a[href]") ||
      normalizedCard.querySelector("button") ||
      normalizedCard.querySelector("[role='button']") ||
      normalizedCard;
    clickable.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = clickable.getBoundingClientRect();
    const x = rect.left + Math.min(Math.max(rect.width * 0.35, 18), Math.max(rect.width - 18, 18));
    const y = rect.top + rect.height / 2;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      clickable.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y
        })
      );
    }
    if (typeof clickable.click === "function") {
      clickable.click();
    }
  }

  function isActiveConversationCard(card, snapshot, meta) {
    const classText = `${card.className || ""} ${card.getAttribute("aria-current") || ""} ${card.getAttribute("aria-selected") || ""}`.toLowerCase();
    const text = cleanText(card.textContent || "");
    const selectedByClass = isMarkedAsActiveCard(card) || /active|selected|current|focus|checked/.test(classText);
    const sameTitle = meta?.title && snapshot?.selected_title && text.includes(meta.title) && snapshot.selected_title.includes(meta.title);
    const sameSelectedKey = meta?.conversation_key && snapshot?.selected_conversation_key && meta.conversation_key === snapshot.selected_conversation_key;
    return selectedByClass || sameSelectedKey || sameTitle;
  }

  function isMarkedAsActiveCard(card) {
    if (!(card instanceof HTMLElement)) return false;
    const normalizedCard = normalizeConversationCardElement(card);
    const selectedNode =
      normalizedCard.matches?.(".selected, [class*='selected'], .active, [class*='active']") ? normalizedCard :
      normalizedCard.querySelector?.(".selected, [class*='selected'], .active, [class*='active']") ||
      normalizedCard.closest?.(".selected, [class*='selected'], .active, [class*='active']");
    const classText = `${normalizedCard.className || ""} ${normalizedCard.getAttribute("aria-current") || ""} ${normalizedCard.getAttribute("aria-selected") || ""}`.toLowerCase();
    if (/active|selected|current|focus|checked/.test(classText)) return true;
    if (selectedNode) return true;
    const style = window.getComputedStyle(normalizedCard);
    const bg = `${style.backgroundColor || ""} ${style.backgroundImage || ""}`.toLowerCase();
    return /rgb\(247,\s*249,\s*252\)|rgba\(247,\s*249,\s*252|linear-gradient/.test(bg);
  }

  function findConversationPane() {
    const sidebar = findConversationSidebarStrict();
    const sidebarRect = sidebar?.getBoundingClientRect() || null;
    const directSelectors = [
      ".message-content",
      ".chat-content",
      ".chat-record",
      ".conversation-content",
      ".dialogue-content",
      ".chat-content-main",
      "[class*='message-content']",
      "[class*='chat-content']",
      "[class*='conversation-content']"
    ];

    for (const selector of directSelectors) {
      const direct = document.querySelector(selector);
      if (!(direct instanceof HTMLElement)) continue;
      const rect = direct.getBoundingClientRect();
      if (rect.width < window.innerWidth * 0.28 || rect.height < window.innerHeight * 0.35) continue;
      if (sidebarRect && rect.left <= sidebarRect.right - 8) continue;
      return direct;
    }

    const candidates = [...document.querySelectorAll("div, section, main, article")]
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width < window.innerWidth * 0.25 || rect.height < window.innerHeight * 0.3) return false;
        if (sidebarRect) {
          if (rect.left <= sidebarRect.right - 8) return false;
        } else if (rect.left < window.innerWidth * 0.3) {
          return false;
        }
        return true;
      });

    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const text = cleanText(element.innerText || "");
      const messageHits = element.querySelectorAll(
        "[class*='message'], [class*='bubble'], [class*='dialogue'], [class*='im-message'], [class*='item-friend'], [class*='item-myself']"
      ).length;
      const headerHits = element.querySelectorAll("[class*='title'], [class*='company'], [class*='position'], [class*='job']").length;
      const actionHits = /\u53d1\u7b80\u5386|\u6362\u7535\u8bdd|\u6362\u5fae\u4fe1|\u67e5\u770b\u804c\u4f4d|\u5df2\u8bfb/.test(text) ? 1 : 0;
      const score =
        messageHits * 25 +
        headerHits * 8 +
        actionHits * 18 +
        Math.min(text.length, 1600) / 24 -
        Math.abs(rect.left + rect.width / 2 - window.innerWidth * 0.64) / 8;
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }

    if (best) {
      return best;
    }

    const messageAnchors = [...document.querySelectorAll("div, section, article, p, span")].filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const text = cleanText(element.innerText || "");
      if (!text) return false;
      if (!/\u53d1\u7b80\u5386|\u6362\u7535\u8bdd|\u6362\u5fae\u4fe1|\u67e5\u770b\u804c\u4f4d|\u5df2\u8bfb|\u9001\u8fbe/.test(text)) return false;
      const rect = element.getBoundingClientRect();
      if (sidebarRect && rect.left <= sidebarRect.right - 8) return false;
      return rect.left > window.innerWidth * 0.28;
    });

    for (const anchor of messageAnchors) {
      let current = anchor.parentElement;
      let hops = 0;
      while (current && hops < 8) {
        if (!(current instanceof HTMLElement)) break;
        const rect = current.getBoundingClientRect();
        if (
          rect.left > window.innerWidth * 0.25 &&
          rect.width >= window.innerWidth * 0.3 &&
          rect.height >= window.innerHeight * 0.3
        ) {
          return current;
        }
        current = current.parentElement;
        hops += 1;
      }
    }

    return best;
  }

  function collectCurrentConversationMessages(root = findConversationPane()) {
    const selectors = [
      ".message-item",
      ".chat-message-item",
      ".item-friend",
      ".item-myself",
      ".item",
      ".chat-item",
      ".message",
      "[class*='message']",
      "[class*='msg']",
      "[class*='item-friend']",
      "[class*='item-myself']",
      "[class*='chat-item']",
      "[class*='dialogue'] [class*='item']",
      "[class*='im-message']"
    ];

    let nodes = [];
    const scope = root || document;
    const rootRect = root?.getBoundingClientRect?.() || null;
    for (const selector of selectors) {
      const found = [...scope.querySelectorAll(selector)].filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const text = cleanText(element.textContent || "");
        if (!isUsefulConversationMessage(text)) return false;
        const rect = element.getBoundingClientRect();
        if (rootRect) {
          if (rect.top < rootRect.top || rect.bottom > rootRect.bottom + 8) return false;
          if (rect.left < rootRect.left - 8 || rect.right > rootRect.right + 8) return false;
          if (rect.width > rootRect.width * 0.98 && text.length < 16) return false;
        }
        if (rect.height < 18) return false;
        return true;
      });
      if (found.length >= 1) {
        nodes = found.slice(-12);
        break;
      }
    }

    if (nodes.length < 1 && root instanceof HTMLElement) {
      const fallbackNodes = [...root.querySelectorAll("div, p, li, section, article")]
        .filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const text = cleanText(element.textContent || "");
          if (!isUsefulConversationMessage(text)) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          if (rootRect) {
            if (rect.left < rootRect.left - 8 || rect.right > rootRect.right + 8) return false;
            if (rect.top < rootRect.top || rect.bottom > rootRect.bottom + 8) return false;
          }
          if (rect.height < 20 || rect.width < 60) return false;
          if (rect.width > (rootRect?.width || window.innerWidth) * 0.9 && text.length < 24) return false;
          const classText = `${element.className || ""} ${element.parentElement?.className || ""}`.toLowerCase();
          const bubbleLike =
            /item|message|msg|bubble|text|content|friend|myself|chat/.test(classText) ||
            rect.width < (rootRect?.width || window.innerWidth) * 0.78;
          return bubbleLike;
        })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

      nodes = fallbackNodes.slice(-12);
    }

    const resumeCardNodes = root instanceof HTMLElement
      ? [...root.querySelectorAll("[class*='resume'], [class*='attachment']")].filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          return (!rootRect || (rect.top >= rootRect.top && rect.bottom <= rootRect.bottom + 8)) && isInboundResumeCardText(element.textContent || "");
        })
      : [];
    nodes = [...new Set([...nodes, ...resumeCardNodes])]
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      .slice(-12);

    const seen = new Set();
    return nodes
      .map((element, index) => {
        const text = cleanText(
          element.querySelector("[class*='text'], [class*='content'], [class*='bubble']")?.textContent || element.textContent || ""
        );
        const timeText = cleanText(element.querySelector("time, [class*='time']")?.textContent || "");
        const classText = `${element.className || ""} ${element.parentElement?.className || ""}`.toLowerCase();
        const rect = element.getBoundingClientRect();
        const senderByClass = /(?:^|[\s_-])(?:myself|self|outbound|outgoing|geek)(?:$|[\s_-])/.test(classText)
          ? "me"
          : /(?:^|[\s_-])(?:friend|inbound|incoming|boss|hr)(?:$|[\s_-])/.test(classText)
            ? "hr"
            : "";
        const senderByPosition =
          rootRect && rect.left > rootRect.left + rootRect.width * 0.52 ? "me" : "hr";
        const sender = isInboundResumeCardText(text) ? "hr" : senderByClass || senderByPosition;
        const timestamp = normalizeChatTimestamp(timeText);
        const nativeMessageId = element.getAttribute("data-id") || element.dataset?.id || element.getAttribute("data-message-id") || "";
        const messageOrder = index;
        const messageKey = nativeMessageId || `${sender}-${timestamp.sent_at || "unknown"}-${messageOrder}`;
        return {
          sender,
          direction: sender === "me" ? "outbound" : "inbound",
          text,
          sent_at: timestamp.sent_at,
          time_precision: timestamp.time_precision,
          native_message_id: nativeMessageId || null,
          message_order: messageOrder,
          message_key: messageKey
        };
      })
      .filter((item) => {
        if (!isUsefulConversationMessage(item.text)) return false;
        const key = `${item.message_key}::${item.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  async function readConversationMessagesWithRetry() {
    let lastMessages = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pane = findConversationPane();
      const snapshot = currentConversationSnapshot();
      const messages = collectCurrentConversationMessages(pane);
      if (messages.length) {
        return messages;
      }
      lastMessages = messages;
      if (hasConversationContent(snapshot)) {
        await sleep(500);
        continue;
      }
      await sleep(400);
    }
    return lastMessages;
  }

  function extractConversationHeader(root) {
    if (!root) return { title: "", company: "" };
    const topLimit = root.getBoundingClientRect().top + 140;
    const texts = [...root.querySelectorAll("h1, h2, h3, div, span, p")]
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.bottom < root.getBoundingClientRect().top || rect.top > topLimit) return false;
        const text = cleanText(element.textContent || "");
        if (!text || text.length < 2 || text.length > 40) return false;
        if (/^\d{1,2}:\d{2}$/.test(text)) return false;
        if (/查看职位|更多|发送简历|换电话|换微信|电话号码|微信号/.test(text)) return false;
        if (isIgnoredConversationText(text)) return false;
        return true;
      })
      .map((element) => stripLeadingChatTime(element.textContent || ""));

    const unique = [...new Set(texts)];
    return {
      title: unique[0] || "",
      company: unique[1] || ""
    };
  }

  function currentConversationSnapshot() {
    const pane = findConversationPane();
    const header = extractConversationHeader(pane);
    const messages = collectCurrentConversationMessages(pane);
    const lastMessage = messages[messages.length - 1] || null;
    const selectedMeta = getSelectedConversationMeta();
    const paneSignature = cleanText(pane?.innerText || "").replace(/\s+/g, " ").slice(0, 260);
    const placeholderText = /与您进行过沟通的 Boss 都会在左侧列表中显示/.test(paneSignature);
    return {
      title: placeholderText ? "" : header.title,
      company: header.company,
      last_text: lastMessage?.text || "",
      last_time: lastMessage?.sent_at || "",
      root_key: pane?.getAttribute("data-id") || pane?.className || "",
      pane_signature: placeholderText ? "" : paneSignature,
      selected_conversation_key: selectedMeta?.conversation_key || "",
      selected_title: selectedMeta?.title || "",
      selected_company: selectedMeta?.company || "",
      captured_at: new Date().toISOString()
    };
  }

  async function waitForConversationSwitch(before, targetMeta) {
    const deadline = Date.now() + 7000;
    let lastAfter = null;
    while (Date.now() < deadline) {
      const after = currentConversationSnapshot();
      lastAfter = after;
      const changeCount = countConversationChanges(before, after, targetMeta);
      const targetMatched = matchesTargetConversation(after, targetMeta);
      const hasContent = hasConversationContent(after);
      if ((changeCount >= 2 && hasContent) || (changeCount >= 1 && targetMatched && hasContent)) {
        return { ok: true, after };
      }
      await sleep(300);
    }
    return { ok: false, after: lastAfter };
  }

  function hasConversationContent(snapshot) {
    if (!snapshot) return false;
    return Boolean(
      cleanText(snapshot.title || "") ||
      cleanText(snapshot.company || "") ||
      cleanText(snapshot.last_text || "") ||
      cleanText(snapshot.pane_signature || "")
    );
  }

  function countConversationChanges(before, after, targetMeta) {
    let count = 0;
    if ((before.last_text || "") !== (after.last_text || "") && cleanText(after.last_text || "")) count += 1;
    if ((before.last_time || "") !== (after.last_time || "") && cleanText(after.last_time || "")) count += 1;
    if ((before.pane_signature || "") !== (after.pane_signature || "") && cleanText(after.pane_signature || "")) count += 2;
    if ((before.selected_conversation_key || "") !== (after.selected_conversation_key || "") && cleanText(after.selected_conversation_key || "")) count += 2;
    if ((before.selected_title || "") !== (after.selected_title || "") && cleanText(after.selected_title || "")) count += 1;
    if (targetMeta?.conversation_key && after.selected_conversation_key && targetMeta.conversation_key === after.selected_conversation_key) count += 2;
    if (targetMeta?.title && after.selected_title && after.selected_title.includes(targetMeta.title)) count += 1;
    if (targetMeta?.preview_text && after.last_text && cleanText(after.last_text).includes(cleanText(targetMeta.preview_text).slice(0, 20))) count += 1;
    return count;
  }

  function matchesTargetConversation(snapshot, targetMeta) {
    if (!snapshot || !targetMeta) return false;
    const selectedKeyMatched = targetMeta.conversation_key && snapshot.selected_conversation_key && targetMeta.conversation_key === snapshot.selected_conversation_key;
    const selectedTitleMatched = targetMeta.title && snapshot.selected_title && snapshot.selected_title.includes(targetMeta.title);
    const previewMatched =
      targetMeta.preview_text &&
      snapshot.last_text &&
      cleanText(snapshot.last_text).includes(cleanText(targetMeta.preview_text).slice(0, 20));
    return Boolean(selectedKeyMatched || selectedTitleMatched || previewMatched);
  }

  function normalizeChatTimestamp(value) {
    const text = cleanText(value);
    const now = new Date();

    let match = text.match(/(\d{4})[-/.\u5e74](\d{1,2})[-/.\u6708](\d{1,2})[\u65e5\s]+(\d{1,2}):(\d{2})/);
    if (match) {
      return { sent_at: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0).toISOString(), time_precision: "exact" };
    }

    match = text.match(/(\d{1,2})\u6708(\d{1,2})\u65e5?\s*(\d{1,2}):(\d{2})/);
    if (match) {
      return { sent_at: new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4]), 0, 0).toISOString(), time_precision: "exact" };
    }

    match = text.match(/\u6628\u5929\s*(\d{1,2}):(\d{2})/);
    if (match) {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      date.setHours(Number(match[1]), Number(match[2]), 0, 0);
      return { sent_at: date.toISOString(), time_precision: "exact" };
    }

    match = text.match(/(\d{1,2}):(\d{2})/);
    if (match) {
      const date = new Date();
      date.setHours(Number(match[1]), Number(match[2]), 0, 0);
      return { sent_at: date.toISOString(), time_precision: "exact" };
    }

    return { sent_at: null, time_precision: "unknown" };
  }

  function diagnoseBossChatPage() {
    const sidebar = findConversationSidebarStrict();
    const pane = findConversationPane();
    return {
      route_ok: isStandardChatRoute(),
      sidebar_found: Boolean(sidebar),
      pane_found: Boolean(pane),
      card_count: getVisibleConversationCards().length,
      message_count: collectCurrentConversationMessages(pane).length
    };
  }

  function getCurrentPageNumber() {
    const active =
      document.querySelector(".options-pages .active") ||
      document.querySelector("[class*=pagination] .active") ||
      document.querySelector(".page-tag.active");
    const page = Number(cleanText(active?.textContent || ""));
    return Number.isFinite(page) && page > 0 ? page : null;
  }

  async function goBossNextPage() {
    const nextButton = findNextPageButton();
    if (!nextButton || isDisabled(nextButton)) {
      return { ok: true, hasNext: false, currentPage: getCurrentPageNumber() };
    }

    const previousPage = getCurrentPageNumber();
    const previousFirstJob = firstJobUrl();
    nextButton.click();
    await waitForPageAdvance(previousPage, previousFirstJob);
    return {
      ok: true,
      hasNext: true,
      currentPage: getCurrentPageNumber(),
      firstJobUrl: firstJobUrl()
    };
  }

  function findNextPageButton() {
    const selectors = [
      "[ka='search_list_next']",
      ".options-pages .next",
      ".page-next",
      "button[aria-label*='\u4e0b\u4e00']",
      "a[aria-label*='\u4e0b\u4e00']",
      ".ui-icon-arrow-right"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }

    const currentPage = getCurrentPageNumber();
    const numberedPage = [...document.querySelectorAll("[class*=page] a, [class*=page] button, [class*=pagination] a, [class*=pagination] button")]
      .find((item) => cleanText(item.textContent || "") === String((currentPage || 1) + 1) && !isDisabled(item));
    if (numberedPage) return numberedPage;

    const candidates = [...document.querySelectorAll("button, a, span, i")];
    return candidates.find((item) => /\u4e0b\u4e00\u9875?|next/i.test(cleanText(item.textContent || "")) && isVisible(item)) || null;
  }

  function isDisabled(element) {
    if (!element) return true;
    return (
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      /\bdisabled\b/.test(element.className || "") ||
      element.closest(".disabled")
    );
  }

  function firstJobUrl() {
    return document.querySelector("a[href*='job_detail']")?.href || "";
  }

  async function waitForPageAdvance(previousPage, previousFirstJob) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const currentPage = getCurrentPageNumber();
      const currentFirstJob = firstJobUrl();
      const linkCount = document.querySelectorAll("a[href*='job_detail']").length;
      if ((currentPage && previousPage && currentPage !== previousPage) || (currentFirstJob && currentFirstJob !== previousFirstJob && linkCount > 0)) {
        return;
      }
      await sleep(350);
    }
  }

  function randomDelay(min, max) {
    const value = Math.floor(min + Math.random() * (max - min));
    return sleep(value);
  }

  async function runHistoryCooldown(requestId, scannedConversations, limit, onProgress) {
    const cooldownSeconds = randomInt(30, 60);
    for (let remaining = cooldownSeconds; remaining >= 1; remaining -= 1) {
      assertNoBlockingChatState();
      await emitHistoryProgress(requestId, {
        phase: "cooldown",
        scanned_conversations: scannedConversations,
        limit,
        cooldown_seconds: remaining,
        message: `\u5b89\u5168\u51b7\u5374\u4e2d... ${remaining}s \u540e\u7ee7\u7eed\u3002\u5f53\u524d\u662f\u98ce\u63a7\u4fdd\u62a4\u673a\u5236\uff0c\u7a0b\u5e8f\u6ca1\u6709\u5361\u6b7b\uff0c\u8bf7\u4e0d\u8981\u5237\u65b0\u9875\u9762\u6216\u5173\u95ed\u5f39\u7a97\u3002`
      }, onProgress);
      await sleep(1000);
    }
  }

  function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  async function emitHistoryProgress(requestId, payload, onProgress) {
    if (typeof onProgress === "function") onProgress(payload);
    if (!requestId || !canUseExtensionRuntime()) return;
    try {
      await chrome.runtime.sendMessage({
        type: "replyHistoryProgress",
        requestId,
        payload
      });
    } catch {}
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();


