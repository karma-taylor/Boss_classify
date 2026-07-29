import { connectRealChrome } from "./browser.js";
import { hashText, upsertJob } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOSS_SEARCH_URL = "https://www.zhipin.com/web/geek/jobs";
const MAX_SEARCH_COMBINATIONS = 30;
const MIN_SEARCH_PAGES = 3;
const JOB_LINK_SELECTOR = "a[href*='job_detail']";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIAGNOSTICS_DIR = path.join(__dirname, "..", "diagnostics");

const BOSS_CITY_CODES = new Map([
  ["北京", "101010100"],
  ["上海", "101020100"],
  ["天津", "101030100"],
  ["重庆", "101040100"],
  ["广州", "101280100"],
  ["深圳", "101280600"],
  ["杭州", "101210100"],
  ["成都", "101270100"],
  ["南京", "101190100"],
  ["武汉", "101200100"],
  ["西安", "101110100"],
  ["苏州", "101190400"],
  ["保定", "101090200"],
  ["郑州", "101180100"],
  ["合肥", "101220100"],
  ["长沙", "101250100"],
  ["厦门", "101230201"],
  ["福州", "101230101"],
  ["青岛", "101120200"],
  ["济南", "101120100"],
  ["宁波", "101210400"],
  ["无锡", "101190200"],
  ["东莞", "101281600"],
  ["佛山", "101280800"]
]);

export async function readCurrentBossPage(db, options = {}) {
  const searchItems = buildSearchItems(options);
  if (!searchItems.length) throw new Error("请先填写岗位名称或 JD 关键词。");

  const browser = await connectRealChrome();
  const runId = startRun(db, "boss_read_current");
  const savedJobs = [];

  try {
    const page = findBossSearchPage(browser);
    if (!page) {
      throw new Error('没有找到已打开的 Boss 搜索结果页。请先在 Chrome 中打开 Boss 职位搜索页，再点“读取当前页”。');
    }

    const item = searchItems[0];
    await waitForSearchResults(page);
    await assertSafeBossPage(page);
    const jobs = (await extractVisibleJobs(page, item)).filter((job) => passesFilters(job, item.filters));
    for (const job of jobs) {
      savedJobs.push(upsertJob(db, job));
    }

    const diagnostic = savedJobs.length ? null : await captureDiagnostics(page, "boss-current-zero");
    const message = savedJobs.length
      ? `从当前 Boss 页面保存 ${savedJobs.length} 个岗位。`
      : `当前 Boss 页面没有识别到岗位卡片。诊断截图:${diagnostic?.screenshot || "无"}`;
    finishRun(db, runId, "completed", message);
    return { status: "completed", saved: savedJobs.length, jobs: savedJobs, diagnostic, message };
  } catch (error) {
    finishRun(db, runId, "paused", error.message);
    return { status: "paused", error: error.message, jobs: savedJobs };
  }
}

export async function diagnoseBossTabs() {
  const browser = await connectRealChrome();
  const pages = browser.contexts().flatMap((context, contextIndex) =>
    context.pages().map((page, pageIndex) => ({ contextIndex, pageIndex, page }))
  );
  const tabs = [];
  for (const item of pages) {
    const frames = item.page.frames();
    const frameSummaries = [];
    for (const frame of frames) {
      frameSummaries.push({
        url: frame.url(),
        job_link_count: await frame.locator(JOB_LINK_SELECTOR).count().catch(() => 0)
      });
    }
    tabs.push({
      context_index: item.contextIndex,
      page_index: item.pageIndex,
      url: item.page.url(),
      title: await item.page.title().catch(() => ""),
      is_boss_search_page: isBossSearchUrl(item.page.url()),
      frame_count: frames.length,
      job_link_count: frameSummaries.reduce((sum, frame) => sum + frame.job_link_count, 0),
      frames: frameSummaries
    });
  }
  return {
    selected_page_index: tabs.find((tab) => tab.is_boss_search_page)?.page_index ?? null,
    tabs
  };
}

export function buildBossSearchTasks(options = {}) {
  const pageLimit = Math.max(MIN_SEARCH_PAGES, Math.min(Number(options.pages || MIN_SEARCH_PAGES), 10));
  const items = buildBossSearchUrls(options);
  const searchTerms = splitTerms(options.search_terms || options.search_queries || options.job_titles || options.titles || options.title || options.jd_keywords || options.keywords);
  const locations = splitTerms(options.locations || options.preferred_locations || options.location);
  const requestedTaskCount = searchTerms.length * Math.max(locations.length, 1);
  return {
    page_limit: pageLimit,
    items,
    requested_task_count: requestedTaskCount,
    truncated_task_count: Math.max(0, requestedTaskCount - items.length),
    filters: normalizeFilters(options, splitTerms(options.jd_keywords || options.keywords))
  };
}

export function buildSearchItems(options = {}) {
  const searchTerms = splitTerms(options.search_terms || options.search_queries || options.job_titles || options.titles || options.title || options.jd_keywords || options.keywords || options.keyword);
  const keywords = splitTerms(options.jd_keywords || options.keywords);
  const locations = splitTerms(options.locations || options.preferred_locations || options.location);
  const normalizedLocations = rotateLocations(locations.length ? locations : [""], options.task_offset);
  const filters = normalizeFilters(options, keywords);
  const items = [];

  for (const searchTerm of searchTerms) {
    for (const location of normalizedLocations) {
      const cityCode = getBossCityCode(location);
      const query = cityCode ? searchTerm : [location, searchTerm].filter(Boolean).join(" ");
      items.push({ title: searchTerm, keywords, location, city_code: cityCode, query, filters });
    }
  }

  return items.slice(0, MAX_SEARCH_COMBINATIONS);
}

export function getBossCityCode(location) {
  const normalized = String(location || "")
    .replace(/\s+/g, "")
    .replace(/市$/, "");
  return BOSS_CITY_CODES.get(normalized) || null;
}

export function buildBossSearchUrl(item = {}) {
  const url = new URL(BOSS_SEARCH_URL);
  url.searchParams.set("query", item.query || item.title || "");
  if (item.city_code) url.searchParams.set("city", item.city_code);
  return url.toString();
}

export function buildBossSearchUrls(options = {}) {
  return buildSearchItems(options).map((item) => ({
    ...item,
    url: buildBossSearchUrl(item)
  }));
}

export function analyzeJobFilters(job, filters = {}) {
  const text = `${job.title || ""} ${job.jd_text || ""}`.toLowerCase();
  const reasons = [];
  const softFlags = [];
  const hasTitleFilters = Boolean(filters.job_titles?.length);
  const hasKeywordFilters = Boolean(filters.jd_keywords?.length);
  const titleOk = !hasTitleFilters || filters.job_titles.some((title) => {
    const normalized = title.toLowerCase();
    if (text.includes(normalized)) return true;
    const tokens = tokenizeTitle(normalized);
    if (!tokens.length) return false;
    return tokens.every((token) => text.includes(token));
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

  softFlags.push(...analyzeCompanySizePreference(job, filters));
  return { passed: intentOk && salaryOk, reasons, soft_flags: softFlags };
}

export function passesFilters(job, filters = {}) {
  return analyzeJobFilters(job, filters).passed;
}

export function analyzeCompanySizePreference(job, filters = {}) {
  if (filters.company_size_min == null && filters.company_size_max == null) return [];
  const companySize = parseCompanySizeRange(`${job.company_size || ""} ${job.jd_text || ""}`);
  if (!companySize) return ["company_size_missing"];
  const flags = [];
  if (filters.company_size_min && companySize.max < filters.company_size_min) {
    flags.push("company_size_below_minimum");
  }
  if (filters.company_size_max && companySize.min > filters.company_size_max) {
    flags.push("company_size_above_maximum");
  }
  return flags;
}

export function parseSalaryRange(value) {
  const text = String(value || "").toLowerCase();
  const match = text.match(/(\d+(?:\.\d+)?)\s*[-~到至]\s*(\d+(?:\.\d+)?)\s*k?/i) || text.match(/(\d+(?:\.\d+)?)\s*k/i);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2] || match[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

export function parseCompanySizeRange(value) {
  const text = String(value || "");
  const rangeMatch = text.match(/(\d+)\s*[-~到至]\s*(\d+)\s*人/);
  if (rangeMatch) return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  const plusMatch = text.match(/(\d+)\s*人以上/);
  if (plusMatch) return { min: Number(plusMatch[1]), max: Infinity };
  const belowMatch = text.match(/少于\s*(\d+)\s*人|(\d+)\s*人以下/);
  if (belowMatch) {
    const max = Number(belowMatch[1] || belowMatch[2]);
    return { min: 0, max };
  }
  return null;
}

async function extractVisibleJobs(page, searchItem = {}) {
  const frame = await frameWithMostJobLinks(page);
  return frame.locator(JOB_LINK_SELECTOR).evaluateAll((links) =>
    links.slice(0, 40).map((link) => {
      const card =
        link.closest(".job-card-wrapper") ||
        link.closest(".job-card-body") ||
        link.closest(".job-primary") ||
        link.closest("li") ||
        link.parentElement;
      const title =
        card?.querySelector(".job-name, .job-title, [class*=job-name], [class*=job-title]")?.textContent ||
        link.textContent ||
        "";
      const company =
        card?.querySelector(".company-name, [class*=company-name], [class*=company]")?.textContent || "";
      const salary = card?.querySelector(".salary, [class*=salary]")?.textContent || "";
      const location = card?.querySelector(".job-area, [class*=area], [class*=location]")?.textContent || "";
      const companySize =
        card?.querySelector(".company-tag-list, [class*=company-tag], [class*=scale]")?.textContent || "";
      const jd = card?.textContent || link.textContent || "";
      return {
        source_url: link.href,
        title: title.replace(/\s+/g, " ").trim(),
        company: company.replace(/\s+/g, " ").trim(),
        salary: salary.replace(/\s+/g, " ").trim(),
        location: location.replace(/\s+/g, " ").trim(),
        company_size: companySize.replace(/\s+/g, " ").trim(),
        jd_text: jd.replace(/\s+/g, " ").trim().slice(0, 3000)
      };
    }).filter((job, index, items) =>
      job.source_url &&
      job.title &&
      items.findIndex((item) => item.source_url === job.source_url) === index
    )
  ).then((jobs) =>
    jobs.map((job) => ({
      ...job,
      location: job.location || searchItem.location || "",
      jd_text: [
        job.jd_text,
        job.company_size ? `公司规模:${job.company_size}` : ""
      ].filter(Boolean).join(" ").slice(0, 3000),
      jd_hash: hashText(job.jd_text || job.source_url)
    }))
  );
}

function splitTerms(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,，、;；\n\r\t]+/);
  return items.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 10);
}

function rotateLocations(locations, offset) {
  if (locations.length < 2) return locations;
  const normalizedOffset = Math.abs(Number(offset) || 0) % locations.length;
  return locations.slice(normalizedOffset).concat(locations.slice(0, normalizedOffset));
}

function normalizeFilters(options, keywords) {
  return {
    job_titles: splitTerms(options.job_titles || options.titles || options.title),
    jd_keywords: keywords,
    salary_min: toNumberOrNull(options.salary_min),
    salary_max: toNumberOrNull(options.salary_max),
    company_size_min: toNumberOrNull(options.company_size_min),
    company_size_max: toNumberOrNull(options.company_size_max)
  };
}

function toNumberOrNull(value) {
  const number = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function tokenizeTitle(value) {
  return String(value || "")
    .replace(/经理|主管|专员|高级|资深|专家|负责人/g, "")
    .split(/[\s/、,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function tokenizeKeyword(value) {
  return String(value || "")
    .split(/[\s/、,;;|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function rangeIntersects(actual, expectedMin, expectedMax) {
  if (expectedMin == null && expectedMax == null) return true;
  if (!actual) return true;
  const min = expectedMin ?? 0;
  const max = expectedMax ?? Infinity;
  return actual.max >= min && actual.min <= max;
}

function findBossSearchPage(browser) {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => isBossSearchUrl(page.url()));
}

function isBossSearchUrl(url) {
  return /zhipin\.com\/web\/geek\/jobs?/.test(String(url || ""));
}

async function waitForSearchResults(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await assertSafeBossPage(page);
    const links = await countJobLinks(page);
    if (links > 0) {
      await page.mouse.wheel(0, 700).catch(() => {});
      await page.waitForTimeout(1200);
      return;
    }
    const body = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    if (/暂无|没有找到|无相关|换个关键词/.test(body)) return;
    await page.waitForTimeout(1000);
  }
}

async function countJobLinks(page) {
  const counts = await Promise.all(page.frames().map((frame) => frame.locator(JOB_LINK_SELECTOR).count().catch(() => 0)));
  return counts.reduce((sum, count) => sum + count, 0);
}

async function frameWithMostJobLinks(page) {
  const frames = page.frames();
  const rows = await Promise.all(frames.map(async (frame) => ({
    frame,
    count: await frame.locator(JOB_LINK_SELECTOR).count().catch(() => 0)
  })));
  return rows.sort((left, right) => right.count - left.count)[0]?.frame || page.mainFrame();
}

async function captureDiagnostics(page, prefix) {
  fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshot = path.join(DIAGNOSTICS_DIR, `${prefix}-${stamp}.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    text_sample: bodyText.replace(/\s+/g, " ").trim().slice(0, 500),
    screenshot
  };
}

async function assertSafeBossPage(page) {
  const url = page.url();
  const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 1000);
  if (/login|passport/i.test(url) || /登录|扫码|验证码|安全验证|异常|访问受限|滑动验证/.test(body)) {
    throw new Error("检测到登录、验证码或风控页面,已暂停自动化。");
  }
}

function startRun(db, runType) {
  return db.prepare("INSERT INTO automation_runs (run_type, status) VALUES (?, 'running')").run(runType).lastInsertRowid;
}

function finishRun(db, runId, status, message) {
  db.prepare("UPDATE automation_runs SET status = ?, message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, message, runId);
}
