import assert from "node:assert/strict";
import test from "node:test";
import { REPLY_INTENTS } from "../src/intents.js";
import { analyzeMessagesLocally, evaluateLocally, generateGreetingsLocally } from "../src/localWorker.js";

test("local greeting uses sincere jd-aware wording without salary dumping", () => {
  const result = generateGreetingsLocally(
    {
      title: "AI 产品经理",
      company: "测试公司",
      salary: "30-50K",
      jd_text: "负责 AI Agent 工作流、需求拆解、数据分析和跨团队推进"
    },
    {
      matched_points: [{ jd_requirement: "AI Agent 工作流" }, { jd_requirement: "跨团队推进" }]
    },
    {
      job_titles: ["AI 产品经理"],
      jd_keywords: ["AI", "Agent", "工作流"]
    }
  );

  assert.ok(Array.isArray(result.greetings));
  assert.match(result.greetings[0], /认真看了/);
  assert.match(result.greetings[0], /AI Agent|工作流|跨团队推进/);
  assert.match(result.greetings[0], /AI 产品规划和需求拆解|数据分析与问题定位|跨团队推进和项目落地/);
  assert.doesNotMatch(result.greetings[0], /30-50K|JD 里比较吸引我的是/);
});

test("local greeting changes with different jd signals", () => {
  const agentGreeting = generateGreetingsLocally(
    {
      title: "AI 产品经理",
      company: "甲公司",
      jd_text: "负责 AI Agent 工作流、需求拆解和跨团队推进"
    },
    {},
    { job_titles: ["AI 产品经理"], jd_keywords: ["AI", "Agent", "工作流"] }
  ).greetings[0];

  const dataGreeting = generateGreetingsLocally(
    {
      title: "数据产品经理",
      company: "乙公司",
      jd_text: "负责指标体系、数据分析、业务场景梳理和企业服务产品设计"
    },
    {},
    { job_titles: ["数据产品经理"], jd_keywords: ["数据分析", "指标体系", "企业服务"] }
  ).greetings[0];

  assert.notEqual(agentGreeting, dataGreeting);
  assert.match(agentGreeting, /AI Agent|工作流/);
  assert.match(dataGreeting, /指标体系|数据分析|企业服务/);
});

test("local evaluation does not reject jobs because of experience years or missing company size", () => {
  const report = evaluateLocally(
    {
      title: "AI 产品经理",
      company: "测试公司",
      location: "深圳",
      salary: "20-30K",
      company_size: "",
      jd_text: "AI 产品经理 5 年以上经验,负责 AI 产品规划、需求拆解和项目落地"
    },
    {
      job_titles: ["AI 产品经理"],
      jd_keywords: ["AI", "产品规划", "需求拆解"],
      locations: ["深圳"],
      salary_min: 15,
      salary_max: 40,
      company_size_min: 100,
      max_experience_years: 1
    }
  );

  assert.equal(report.reject_reasons.some((reason) => /年限|经验/.test(reason)), false);
  assert.ok(report.risk_flags.includes("company_size_missing"));
  assert.equal(report.should_apply, true);
});

test("local message analysis recognizes interview intent from recent rounds", () => {
  const result = analyzeMessagesLocally([
    { sender: "hr", text: "您好,方便明天下午面试吗?" },
    { sender: "me", text: "可以的,我这边能配合。" }
  ]);
  assert.equal(result.intent, REPLY_INTENTS.INTERVIEW);
});

test("local message analysis recognizes resume request intent", () => {
  const result = analyzeMessagesLocally([
    { sender: "hr", text: "方便发一份最新的附件简历给我吗?" },
    { sender: "me", text: "可以,我这就发您。" }
  ]);
  assert.equal(result.intent, REPLY_INTENTS.RESUME_REQUEST);
});

test("local message analysis recognizes the Boss attachment resume card", () => {
  const result = analyzeMessagesLocally([
    { sender: "hr", text: "我想要一份您的附件简历，您是否同意" },
    { sender: "me", text: "我已投递简历" }
  ]);
  assert.equal(result.intent, REPLY_INTENTS.RESUME_REQUEST);
});

test("local message analysis ignores interview wording sent only by the candidate", () => {
  const result = analyzeMessagesLocally([
    { sender: "hr", text: "您好，感谢关注，后续会按流程评估。" },
    { sender: "me", text: "请问什么时候可以安排面试？" }
  ]);
  assert.notEqual(result.intent, REPLY_INTENTS.INTERVIEW);
});
