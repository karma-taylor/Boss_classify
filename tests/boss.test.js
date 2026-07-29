import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeJobFilters,
  buildBossSearchTasks,
  buildBossSearchUrl,
  buildSearchItems,
  getBossCityCode,
  parseCompanySizeRange,
  parseSalaryRange,
  passesFilters
} from "../src/boss.js";

test("buildSearchItems combines locations and job titles with a safe cap", () => {
  const items = buildSearchItems({
    job_titles: ["AI 产品经理", "B 端产品经理"],
    jd_keywords: ["AI 产品经理", "B 端产品"],
    locations: ["上海", "杭州"]
  });
  assert.deepEqual(items.map((item) => item.query), [
    "AI 产品经理",
    "AI 产品经理",
    "B 端产品经理",
    "B 端产品经理"
  ]);
  assert.deepEqual(items.map((item) => item.city_code), [
    "101020100",
    "101210100",
    "101020100",
    "101210100"
  ]);
});

test("buildSearchItems accepts comma separated text and caps combinations at thirty", () => {
  const items = buildSearchItems({
    job_titles: "AI产品,数据产品,CRM,SaaS,效率工具",
    jd_keywords: "AI,数据,CRM,SaaS,效率",
    locations: "上海,杭州,北京"
  });
  assert.equal(items.length, 15);
  assert.equal(items[0].query, "AI产品");
  assert.equal(items[0].city_code, "101020100");
});

test("buildBossSearchTasks keeps page limit within range", () => {
  const tasks = buildBossSearchTasks({
    job_titles: "AI 产品经理",
    locations: "上海",
    pages: 12
  });
  assert.equal(tasks.page_limit, 10);
  assert.equal(tasks.items.length, 1);
});

test("buildBossSearchTasks keeps at least three pages per city and reports task truncation", () => {
  const tasks = buildBossSearchTasks({
    search_terms: ["产品经理", "企业服务产品经理", "SaaS 产品经理", "AI 产品经理", "数据产品经理"],
    job_titles: ["B端产品经理"],
    locations: ["深圳", "上海", "北京", "广州", "杭州", "苏州", "成都"],
    pages: 1
  });
  assert.equal(tasks.page_limit, 3);
  assert.equal(tasks.items.length, 30);
  assert.equal(tasks.requested_task_count, 35);
  assert.equal(tasks.truncated_task_count, 5);
  assert.deepEqual(tasks.filters.job_titles, ["B端产品经理"]);
});

test("Boss search URL uses city code when the location is known", () => {
  const item = buildSearchItems({
    job_titles: "AI产品经理",
    locations: "上海"
  })[0];
  const url = new URL(buildBossSearchUrl(item));
  assert.equal(url.pathname, "/web/geek/jobs");
  assert.equal(url.searchParams.get("query"), "AI产品经理");
  assert.equal(url.searchParams.get("city"), "101020100");
  assert.equal(getBossCityCode("上海市"), "101020100");
  assert.equal(getBossCityCode("深圳"), "101280600");
});

test("unknown locations still fall back to query text", () => {
  const item = buildSearchItems({
    job_titles: "AI产品经理",
    locations: "远程"
  })[0];
  const url = new URL(buildBossSearchUrl(item));
  assert.equal(item.city_code, null);
  assert.equal(url.searchParams.get("query"), "远程 AI产品经理");
  assert.equal(url.searchParams.has("city"), false);
});

test("passesFilters keeps similar product manager title when JD mentions AI", () => {
  const job = {
    title: "产品经理",
    salary: "25-35K",
    company_size: "100-499人",
    jd_text: "负责 AI 智能体产品规划和企业流程提效"
  };
  assert.equal(passesFilters(job, {
    job_titles: ["AI 产品经理"],
    jd_keywords: ["智能体"],
    salary_min: 20,
    salary_max: 40,
    company_size_min: 50,
    company_size_max: 1000
  }), true);
});

test("salary and company size parsers handle Boss-style ranges", () => {
  assert.deepEqual(parseSalaryRange("25-40K·14薪"), { min: 25, max: 40 });
  assert.deepEqual(parseCompanySizeRange("100-499人"), { min: 100, max: 499 });
  assert.deepEqual(parseCompanySizeRange("10000人以上"), { min: 10000, max: Infinity });
});

test("passesFilters rejects out-of-range salary but keeps company size as soft preference", () => {
  const job = {
    title: "AI 产品经理",
    salary: "12-18K",
    company_size: "20-49人",
    jd_text: "AI 产品"
  };
  assert.equal(passesFilters(job, { salary_min: 20, salary_max: 40 }), false);
  assert.equal(passesFilters(job, { company_size_min: 100, company_size_max: 1000 }), true);
  const result = analyzeJobFilters(job, { company_size_min: 100, company_size_max: 1000 });
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.soft_flags, ["company_size_below_minimum"]);
});

test("buildSearchItems recognizes Chinese separators and rotates city task priority", () => {
  const items = buildSearchItems({
    job_titles: "AI产品经理，数据产品经理",
    locations: "深圳；上海、北京",
    task_offset: 1
  });
  assert.deepEqual(items.slice(0, 3).map((item) => item.location), ["上海", "北京", "深圳"]);
  assert.deepEqual(items.slice(0, 3).map((item) => item.city_code), [
    "101020100",
    "101010100",
    "101280600"
  ]);
});

test("filter analysis keeps jobs with missing company size and reports soft flag", () => {
  const job = {
    title: "AI 产品经理",
    salary: "20-30K",
    company_size: "",
    jd_text: "AI 产品规划"
  };
  const result = analyzeJobFilters(job, { company_size_min: 100, company_size_max: 1000 });
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.soft_flags, ["company_size_missing"]);
});

test("filter analysis separates hard reasons from soft flags", () => {
  const job = {
    title: "销售经理",
    salary: "12-18K",
    company_size: "",
    jd_text: "电话销售"
  };
  const result = analyzeJobFilters(job, {
    job_titles: ["AI 产品经理"],
    salary_min: 20,
    company_size_min: 100
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("title_or_keyword_miss"));
  assert.ok(result.reasons.includes("salary_below_minimum"));
  assert.deepEqual(result.soft_flags, ["company_size_missing"]);
});

test("passesFilters keeps jobs when title matches even if list page keywords are sparse", () => {
  const job = {
    title: "AI产品经理",
    salary: "20-30K",
    company_size: "100-499人",
    jd_text: "AI产品经理 20-30K 1-3年 本科 深圳"
  };
  assert.equal(passesFilters(job, {
    job_titles: ["AI 产品经理"],
    jd_keywords: ["企业效率", "提效", "核心业务场景", "AI赋能业务"],
    salary_min: 15,
    salary_max: 40,
    company_size_min: 100,
    company_size_max: 1000
  }), true);
});
