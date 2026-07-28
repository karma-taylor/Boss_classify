import assert from "node:assert/strict";
import test from "node:test";
import { evaluateJob, generateGreetings } from "../src/workerClient.js";

test("worker client stays local unless cloud AI is explicitly enabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnabled = process.env.ENABLE_CLOUD_AI;
  const originalEndpoint = process.env.RESUMATCH_ENDPOINT;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not be used in local mode");
  };
  delete process.env.ENABLE_CLOUD_AI;
  delete process.env.RESUMATCH_ENDPOINT;

  try {
    const job = { title: "AI Product Manager", jd_text: "负责 AI Agent 产品规划和跨团队落地。" };
    const report = await evaluateJob(job, {});
    const greetings = await generateGreetings(job, report, {});
    assert.equal(fetchCalls, 0);
    assert.ok(Array.isArray(greetings.greetings));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnabled === undefined) delete process.env.ENABLE_CLOUD_AI;
    else process.env.ENABLE_CLOUD_AI = originalEnabled;
    if (originalEndpoint === undefined) delete process.env.RESUMATCH_ENDPOINT;
    else process.env.RESUMATCH_ENDPOINT = originalEndpoint;
  }
});
