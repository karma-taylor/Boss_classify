import { analyzeMessagesLocally, evaluateLocally, generateGreetingsLocally } from "./localWorker.js";
import { REPLY_INTENTS } from "./intents.js";
import { classifyInboundMessage } from "./messageClassifier.js";

const DEFAULT_ENDPOINT = "https://resumatch-gateway.hamhome-680ce447.workers.dev";
const DEFAULT_ORIGIN = "https://resumatch-7cv.pages.dev";
let remoteWorkerUnavailableUntil = 0;

export async function evaluateJob(job, userProfile = {}) {
  return callWorker(
    {
      action: "evaluate",
      resume_text: process.env.DEFAULT_RESUME_TEXT || placeholderResume(),
      jd_text: job.jd_text,
      user_profile: userProfile
    },
    { job, userProfile }
  );
}

export async function analyzeMessages(conversation) {
  const result = await callWorker(
    {
      action: "message_analyze",
      conversation
    },
    { conversation }
  );
  return refineMessageAnalysis(result, conversation);
}

export async function generateGreetings(job, reportContext = {}, userProfile = {}) {
  return callWorker(
    {
      action: "greeting",
      resume_text: process.env.DEFAULT_RESUME_TEXT || placeholderResume(),
      jd_text: job.jd_text,
      user_profile: userProfile,
      report_context: reportContext
    },
    { job, reportContext, userProfile }
  );
}

export async function callWorker(payload, context = {}) {
  if (Date.now() < remoteWorkerUnavailableUntil) {
    return runLocalFallback(payload, context, new Error("remote worker temporarily disabled"));
  }

  const endpoint = process.env.RESUMATCH_ENDPOINT || DEFAULT_ENDPOINT;
  const headers = {
    Origin: process.env.RESUMATCH_ORIGIN || DEFAULT_ORIGIN,
    "Content-Type": "application/json"
  };
  if (process.env.ADMIN_BYPASS_TOKEN) {
    headers["X-Admin-Bypass"] = process.env.ADMIN_BYPASS_TOKEN;
  }

  const timeoutMs = Number(process.env.WORKER_TIMEOUT_MS || 2500);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(raw || `Worker HTTP ${response.status}`);
    }
    return JSON.parse(stripJsonFence(raw));
  } catch (error) {
    remoteWorkerUnavailableUntil = Date.now() + 5 * 60 * 1000;
    return runLocalFallback(payload, context, error);
  }
}

function runLocalFallback(payload, context, error) {
  const action = String(payload?.action || "evaluate").toLowerCase();
  if (action === "greeting") {
    return generateGreetingsLocally(
      context.job || {},
      context.reportContext || {},
      context.userProfile || payload.user_profile || {}
    );
  }
  if (action === "message_analyze") {
    return analyzeMessagesLocally(context.conversation || payload.conversation || []);
  }

  const report = evaluateLocally(
    context.job || { jd_text: payload.jd_text || "" },
    context.userProfile || payload.user_profile || {}
  );

  report.risk_flags = [...new Set([...(report.risk_flags || []), "remote_worker_unavailable"])];
  report.summary = `${report.summary} 当前已切换到本地评估兜底。`;
  if (!String(report.tier_reason || "").includes("本地")) {
    report.tier_reason = `${report.tier_reason}(本地兜底评分)`;
  }

  if (error?.message) {
    report.risk_points = [
      ...(report.risk_points || []),
      {
        risk_id: "remote_worker_unavailable",
        requirement_id: "worker_connectivity",
        risk: "远端 Worker 当前不可用",
        risk_type: "preference_conflict",
        reason: error.message,
        resume_evidence: "",
        transferable_evidence: "",
        interview_response: "先按本地规则判断,后续再补 AI 细评。",
        evidence_to_prepare: "等待 AI Worker 恢复后重新评估。",
        risk_level: 1
      }
    ];
  }

  return report;
}

function refineMessageAnalysis(analysis, conversation) {
  const remote = analysis && typeof analysis === "object" ? { ...analysis } : {};
  const local = analyzeMessagesLocally(conversation || []);
  const latestInbound = [...(conversation || [])].reverse().find((item) => String(item?.sender || "").toLowerCase() !== "me" && String(item?.direction || "").toLowerCase() !== "outbound");
  const strict = classifyInboundMessage(latestInbound, conversation || []);
  if (strict) {
    return {
      ...remote,
      intent: strict.intent,
      confidence: 0.92,
      reason: strict.reason,
      positive_signal: [REPLY_INTENTS.INTERVIEW, REPLY_INTENTS.RESUME_REQUEST, REPLY_INTENTS.WECHAT, REPLY_INTENTS.PROCESS_PROGRESS].includes(strict.intent),
      negative_signal: [REPLY_INTENTS.REJECT_EXPERIENCE, REPLY_INTENTS.REJECT_DIRECTION, REPLY_INTENTS.REJECT_LOCATION].includes(strict.intent),
      next_action: strict.intent === REPLY_INTENTS.INTERVIEW ? "\u53ca\u65f6\u786e\u8ba4\u9762\u8bd5\u65f6\u95f4\u4e0e\u5f62\u5f0f\u3002" : remote.next_action || "\u6839\u636e HR \u6d88\u606f\u8ddf\u8fdb\u3002"
    };
  }
  const remoteRank = rankMessageIntent(remote.intent);
  const localRank = rankMessageIntent(local.intent);

  if (!remote.intent) {
    return local;
  }

  if (localRank > remoteRank) {
    return {
      ...remote,
      intent: local.intent,
      confidence: Math.max(Number(remote.confidence || 0), Number(local.confidence || 0.84)),
      reason: local.reason || remote.reason || "",
      positive_signal: local.positive_signal,
      negative_signal: local.negative_signal,
      next_action: local.next_action || remote.next_action || ""
    };
  }

  return remote;
}

function rankMessageIntent(intent) {
  switch (String(intent || "")) {
    case REPLY_INTENTS.INTERVIEW:
      return 6;
    case REPLY_INTENTS.RESUME_REQUEST:
      return 5;
    case REPLY_INTENTS.WECHAT:
      return 4;
    case REPLY_INTENTS.REJECT_EXPERIENCE:
    case REPLY_INTENTS.REJECT_DIRECTION:
    case REPLY_INTENTS.REJECT_LOCATION:
      return 3;
    case REPLY_INTENTS.GREETING:
      return 2;
    case REPLY_INTENTS.NO_EFFECTIVE_FEEDBACK:
      return 1;
    default:
      return 0;
  }
}

function stripJsonFence(value) {
  return String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function placeholderResume() {
  return process.env.DEFAULT_RESUME_TEXT || [
    "候选人主要关注 AI 产品、B 端产品和流程数字化岗位。",
    "做过需求调研、流程梳理、原型设计、数据分析、项目推进、上线验收和复盘。",
    "有跨团队协作经验,能拆解需求、确认字段规则、补齐异常场景,并推动试点上线。",
    "会用 SQL、Excel、Python 做基础数据处理和异常清单整理。"
  ].join("");
}
