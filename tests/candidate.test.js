import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUserProfile,
  classifyCandidate,
  extractCompanySize,
  hardFilterJob,
  normalizeCandidateReport
} from "../src/candidate.js";

test("hard filter ignores experience year text", () => {
  const profile = buildUserProfile({ max_experience_years: 1, jd_keywords: ["AI"] });
  const result = hardFilterJob(
    {
      title: "AI 产品经理",
      company: "正常公司",
      jd_text: "要求 3 年以上经验,负责 AI 产品规划"
    },
    profile
  );
  assert.equal(result.should_apply, true);
  assert.equal(result.risk_flags.includes("experience_over_limit"), false);
});

test("hard filter rejects outsourcing jobs", () => {
  const result = hardFilterJob(
    {
      title: "产品经理",
      company: "某人力资源公司",
      jd_text: "驻场客户现场,负责 AI 产品需求"
    },
    buildUserProfile({ jd_keywords: ["AI"] })
  );
  assert.equal(result.should_apply, false);
  assert.ok(result.risk_flags.includes("outsourcing_risk"));
});

test("hard filter treats company size range as a soft risk", () => {
  const result = hardFilterJob(
    {
      title: "AI 产品经理",
      company_size: "20-99人",
      jd_text: "负责 AI 产品规划"
    },
    buildUserProfile({ jd_keywords: ["AI"], company_size_min: 100 })
  );
  assert.equal(result.should_apply, true);
  assert.ok(result.risk_flags.includes("company_size_below_minimum"));
  assert.deepEqual(result.reject_reasons, []);
});

test("hard filter keeps jobs when company size is missing", () => {
  const result = hardFilterJob(
    {
      title: "AI 产品经理",
      company_size: "",
      jd_text: "负责 AI 产品规划"
    },
    buildUserProfile({ jd_keywords: ["AI"], company_size_min: 100 })
  );
  assert.equal(result.should_apply, true);
  assert.ok(result.risk_flags.includes("company_size_missing"));
  assert.deepEqual(result.reject_reasons, []);
});

test("hard filter does not hard reject matching AI product roles just because custom jd keywords are sparse", () => {
  const result = hardFilterJob(
    {
      title: "AI产品经理",
      location: "深圳",
      salary: "20-40K",
      jd_text: "AI产品经理 深圳 20-40K 1-3年 本科"
    },
    buildUserProfile({
      job_titles: ["AI 产品经理"],
      jd_keywords: ["企业效率", "核心业务场景", "AI赋能业务"],
      locations: ["深圳"],
      salary_min: 15,
      salary_max: 40
    })
  );
  assert.equal(result.should_apply, true);
  assert.ok(result.risk_flags.includes("direction_mismatch"));
});

test("candidate report normalizes should_apply and greeting draft", () => {
  const report = normalizeCandidateReport(
    { title: "AI 产品经理", company: "正常公司", jd_text: "AI 产品规划" },
    { match_score: 82, job_tier: "A", should_apply: true },
    { greetings: ["您好,我认真看了这个岗位,岗位描述里我比较关注的是 AI 产品规划,我做过需求拆解和项目推进。"] },
    { jd_keywords: ["AI"], max_experience_years: 1 }
  );
  assert.equal(report.should_apply, true);
  assert.equal(report.queue_status, "recommended");
  assert.match(report.greeting_draft, /AI/);
});

test("candidate report ignores worker experience-only rejection", () => {
  const report = normalizeCandidateReport(
    { title: "AI 产品经理", company: "正常公司", jd_text: "AI 产品规划 5 年以上经验" },
    { match_score: 82, job_tier: "A", should_apply: false, reject_reasons: ["年限要求不符"] },
    { greetings: ["您好,我认真看了这个岗位,想进一步了解业务重点。"] },
    { jd_keywords: ["AI"], max_experience_years: 1 }
  );
  assert.equal(report.should_apply, true);
  assert.equal(report.queue_status, "recommended");
  assert.deepEqual(report.reject_reasons, []);
});

test("candidate report strips salary-heavy greeting wording", () => {
  const report = normalizeCandidateReport(
    { title: "AI 产品经理", company: "测试公司", jd_text: "AI 产品规划" },
    { match_score: 82, job_tier: "A", should_apply: true },
    { greetings: ["您好,我看到贵司的 AI 产品经理,JD 里比较吸引我的是 AI、30-50K,想进一步确认这个岗位是否还在推进中。"] },
    { jd_keywords: ["AI"], max_experience_years: 1 }
  );

  assert.doesNotMatch(report.greeting_draft, /30-50K/);
  assert.doesNotMatch(report.greeting_draft, /JD 里比较吸引我的是/);
  assert.match(report.greeting_draft, /推进重点|业务场景|业务目标/);
});

test("candidate classification hides worker-only risk from recommendation decision", () => {
  assert.equal(classifyCandidate({ shouldApply: false, rejectReasons: ["年限不符"], score: 90 }), "not_recommended");
  assert.equal(classifyCandidate({ shouldApply: true, rejectReasons: [], riskFlags: ["remote_worker_unavailable"], score: 81 }), "recommended");
  assert.equal(classifyCandidate({ shouldApply: true, rejectReasons: [], riskFlags: ["location_not_preferred"], score: 81 }), "needs_review");
});

test("extract company size parses ranges", () => {
  assert.deepEqual(extractCompanySize("100-499人"), { min: 100, max: 499 });
  assert.deepEqual(extractCompanySize("1000人以上"), { min: 1000, max: Infinity });
});
