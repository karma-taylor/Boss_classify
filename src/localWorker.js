import { buildUserProfile, extractSalaryRange, hardFilterJob } from "./candidate.js";
import { REPLY_INTENTS } from "./intents.js";

const INTENT_RULES = [
  { label: REPLY_INTENTS.INTERVIEW, patterns: [/面试/, /电话沟通/, /约聊/, /约个时间/, /明天.*聊/, /视频面试/, /到公司/] },
  { label: REPLY_INTENTS.RESUME_REQUEST, patterns: [/发.*简历/, /附件简历/, /在线简历/, /简历看下/, /补充材料/, /作品集/] },
  { label: REPLY_INTENTS.WECHAT, patterns: [/加微信/, /微信聊/, /电话聊/, /进一步沟通/, /联系方式/] },
  { label: REPLY_INTENTS.REJECT_EXPERIENCE, patterns: [/经验不太匹配/, /年限不符/, /经验不足/, /更偏向有经验/] },
  { label: REPLY_INTENTS.REJECT_DIRECTION, patterns: [/方向不太匹配/, /岗位不太合适/, /不太符合/, /偏差比较大/] },
  { label: REPLY_INTENTS.REJECT_LOCATION, patterns: [/薪资.*不符/, /地点.*不符/, /通勤.*不便/, /城市.*不符/] },
  { label: REPLY_INTENTS.GREETING, patterns: [/您好/, /在吗/, /对我们岗位感兴趣吗/, /方便沟通吗/] }
];

const DEFAULT_TARGET_ROLES = ["AI产品经理", "AI 产品经理", "产品经理"];
const DEFAULT_DIRECTION_KEYWORDS = ["AI", "大模型", "LLM", "智能体", "Agent", "产品"];

const JD_RULES = [
  { label: "AI产品经理", patterns: [/AI产品/i, /AI 产品/i, /产品经理/] },
  { label: "大模型", patterns: [/大模型/, /\bLLM\b/i, /\bRAG\b/i] },
  { label: "AI Agent", patterns: [/智能体/, /\bAgent\b/i] },
  { label: "工作流", patterns: [/工作流/, /workflow/i, /流程编排/, /自动化流程/] },
  { label: "需求拆解", patterns: [/需求拆解/, /需求分析/, /\bPRD\b/i, /原型设计/] },
  { label: "跨团队推进", patterns: [/跨团队/, /跨部门/, /协同推进/, /项目推进/, /推动落地/] },
  { label: "数据分析", patterns: [/数据分析/, /指标体系/, /数据驱动/, /\bSQL\b/i, /埋点/, /分析模型/] },
  { label: "企业服务", patterns: [/企业服务/, /B端/, /B 端/, /\bSaaS\b/i, /中台/] },
  { label: "降本增效", patterns: [/降本增效/, /提效/, /效率提升/, /核心业务场景/] },
  { label: "解决方案", patterns: [/解决方案/, /行业方案/, /方案设计/] },
  { label: "业务场景", patterns: [/业务场景/, /落地场景/, /场景设计/, /场景落地/] }
];

const STRENGTH_RULES = [
  { when: [/AI|大模型|LLM|智能体|Agent/i], value: "AI 产品规划和需求拆解" },
  { when: [/工作流|流程|提效|效率/], value: "流程梳理和提效场景落地" },
  { when: [/数据|分析|指标|SQL|Python/i], value: "数据分析与问题定位" },
  { when: [/跨团队|跨部门|协同|项目|推进/], value: "跨团队推进和项目落地" },
  { when: [/原型|PRD|需求/], value: "需求澄清与方案设计" },
  { when: [/企业服务|B端|SaaS/i], value: "复杂业务抽象和产品化表达" }
];

export function evaluateLocally(job, userProfileInput = {}) {
  const userProfile = buildUserProfile(userProfileInput);
  const text = normalizeText(`${job.title || ""} ${job.company || ""} ${job.location || ""} ${job.salary || ""} ${job.jd_text || ""}`);
  const title = normalizeText(job.title || "");
  const hard = hardFilterJob(job, userProfile);
  const targetRoles = userProfile.target_roles.length ? userProfile.target_roles : DEFAULT_TARGET_ROLES;
  const requiredKeywords = userProfile.required_keywords.length ? userProfile.required_keywords : DEFAULT_DIRECTION_KEYWORDS;

  const matchedPreferences = [];
  const rejectReasons = [...hard.reject_reasons];
  const riskFlags = [...hard.risk_flags];
  const matchedPoints = [];
  const riskPoints = [];

  let score = 35;

  const roleHit = targetRoles.find((role) => containsLoose(title, role));
  if (roleHit) {
    score += 22;
    matchedPreferences.push(`岗位名称命中:${roleHit}`);
    matchedPoints.push(makePoint("role_match", `岗位标题与目标角色接近:${roleHit}`, roleHit, job.title || "", "strong"));
  } else if (/产品/.test(title)) {
    score += 10;
    matchedPoints.push(makePoint("role_partial_match", "岗位仍属于产品方向", "产品岗位", job.title || "", "medium"));
  } else {
    riskPoints.push(makeRisk("role_gap", "role_match", "岗位标题与目标角色存在偏差", "capability_gap", "标题没有明显命中目标角色"));
  }

  const keywordHits = requiredKeywords.filter((keyword) => containsLoose(text, keyword));
  if (keywordHits.length) {
    score += Math.min(28, keywordHits.length * 6);
    matchedPreferences.push(...keywordHits.map((keyword) => `关键词命中:${keyword}`));
    matchedPoints.push(
      makePoint(
        "keyword_match",
        `JD 命中关键词:${keywordHits.join("、")}`,
        keywordHits.join("、"),
        excerpt(text, keywordHits[0]),
        keywordHits.length >= 3 ? "strong" : "medium"
      )
    );
  } else {
    riskFlags.push("keyword_mismatch");
    riskPoints.push(makeRisk("keyword_gap", "keyword_match", "JD 没有命中你的核心关键词", "preference_conflict", "正文里未识别到目标关键词"));
  }

  if (userProfile.preferred_locations.length) {
    const locationHit = userProfile.preferred_locations.find((item) => containsLoose(job.location || text, item));
    if (locationHit) {
      score += 12;
      matchedPreferences.push(`地点命中:${locationHit}`);
      matchedPoints.push(makePoint("location_match", `地点符合偏好:${locationHit}`, locationHit, job.location || "", "strong"));
    } else {
      score -= 8;
      riskPoints.push(makeRisk("location_gap", "location_match", "地点不在偏好列表里", "preference_conflict", `当前地点:${job.location || "未标注"}`));
    }
  }

  const salaryRange = extractSalaryRange(text);
  if (salaryRange) {
    if (userProfile.salary_min && salaryRange.max < userProfile.salary_min) {
      score -= 18;
      riskPoints.push(makeRisk("salary_gap", "salary_range", `薪资上限 ${salaryRange.max}K 低于期望下限`, "preference_conflict", job.salary || ""));
    } else {
      score += 8;
      matchedPoints.push(makePoint("salary_range", "薪资范围可接受", `${salaryRange.min}-${salaryRange.max}K`, job.salary || "", "medium"));
    }
  }

  const shouldApply = hard.should_apply && score >= 52;
  const tier = shouldApply && score >= 80 ? "A" : shouldApply && score >= 64 ? "B" : "C";

  if (!shouldApply && !rejectReasons.length && score < 52) {
    rejectReasons.push("综合匹配度偏低,建议人工复核后再投");
  }

  const greetings = shouldApply
    ? generateGreetingsLocally(job, { matched_points: matchedPoints }, userProfile).greetings
    : [];

  return {
    decision: tier === "A" ? "推荐投" : tier === "B" ? "可以尝试" : hard.should_apply ? "需人工判断" : "不建议投",
    job_tier: tier,
    tier_label: tier === "A" ? "优先投递" : tier === "B" ? "可以尝试" : "暂不建议",
    tier_reason:
      tier === "A"
        ? "岗位方向、地点和关键词整体贴近,可优先处理。"
        : tier === "B"
          ? "基本方向正确,但还存在地点、关键词或规模信息上的不确定项。"
          : "相关性还不够强,建议先人工复核。",
    should_apply: shouldApply,
    reject_reasons: unique(rejectReasons),
    risk_flags: unique(riskFlags),
    greeting_draft: greetings[0] || "",
    matched_preferences: unique(matchedPreferences),
    blocked_by_preferences: unique(hard.risk_flags),
    match_score: clamp(score, 0, 100),
    summary: buildSummary(score, keywordHits, hard),
    hard_flaws: unique(rejectReasons),
    matched_points: matchedPoints,
    risk_points: riskPoints,
    improvement_path: buildImprovementPath(riskPoints),
    interview_focus: buildInterviewFocus(keywordHits)
  };
}

export function generateGreetingsLocally(job, reportContext = {}, userProfileInput = {}) {
  const userProfile = buildUserProfile(userProfileInput);
  const jdSignals = selectJdSignals(job, reportContext, userProfile);
  const strengthSignals = selectStrengthSignals(job, userProfile);
  const roleName = String(job.title || "这个岗位").trim();
  const companyName = String(job.company || "").trim();
  const opener = companyName ? `您好,我认真看了贵司的 ${roleName}` : `您好,我认真看了 ${roleName} 这个岗位`;
  const focusSignals = jdSignals.slice(0, 3);
  const topStrengths = strengthSignals.slice(0, 3);

  const templates = [
    `${opener},JD 里让我比较有共鸣的是 ${joinSignals(focusSignals, 2, "、")}。我这边比较能补位的是 ${joinSignals(topStrengths, 2, "、")},也想进一步了解这个岗位当前最看重的业务场景和推进重点。`,
    `${opener},我尤其留意到岗位里提到的 ${joinSignals(focusSignals, 2, "和")}。我过去更习惯从 ${joinSignals(topStrengths, 2, "、")} 这类事情切进去,把复杂需求拆成可执行方案,想和您确认下这个岗位现在最核心的目标。`,
    `${opener},岗位描述里提到的 ${joinSignals(focusSignals, 2, "、")} 和我最近持续投入的方向比较贴近。我这边能提供的价值更偏向 ${joinSignals(topStrengths, 2, "、")},如果方便的话,想进一步了解团队希望这个岗位优先补位的部分。`,
    `${opener},我看下来这不是泛产品岗,而是更强调 ${joinSignals(focusSignals, 2, "、")}。我这边做事的方式会更偏 ${joinSignals(topStrengths, 2, "、")},也期待了解一下这个岗位在当前阶段最关键的一两个业务问题。`
  ];

  const rotated = rotateGreetings(job, templates.map(cleanGreeting).filter(Boolean));
  return { greetings: unique(rotated) };
}

export function analyzeMessagesLocally(conversation = []) {
  const heuristicIntent = detectIntentFromConversation(conversation);
  if (heuristicIntent) {
    return {
      intent: heuristicIntent,
      confidence: 0.84,
      reason: reasonForHeuristicIntent(heuristicIntent),
      positive_signal: [REPLY_INTENTS.INTERVIEW, REPLY_INTENTS.RESUME_REQUEST, REPLY_INTENTS.WECHAT].includes(heuristicIntent),
      negative_signal: [REPLY_INTENTS.REJECT_EXPERIENCE, REPLY_INTENTS.REJECT_DIRECTION, REPLY_INTENTS.REJECT_LOCATION].includes(heuristicIntent),
      next_action: nextActionFor(heuristicIntent)
    };
  }

  const recentItems = conversation.slice(-12);
  const inboundItems = recentItems.filter((item) => String(item?.sender || "").toLowerCase() !== "me");
  const recent = (inboundItems.length ? inboundItems : recentItems)
    .map((item) => `${item.sender || "hr"}:${item.text || ""}`)
    .join("\n");

  for (const intent of INTENT_RULES) {
    if (intent.patterns.some((pattern) => pattern.test(recent))) {
      return {
        intent: intent.label,
        confidence: 0.72,
        reason: `近期对话命中 ${intent.label} 相关表达`,
        positive_signal: [REPLY_INTENTS.INTERVIEW, REPLY_INTENTS.RESUME_REQUEST, REPLY_INTENTS.WECHAT].includes(intent.label),
        negative_signal: [REPLY_INTENTS.REJECT_EXPERIENCE, REPLY_INTENTS.REJECT_DIRECTION, REPLY_INTENTS.REJECT_LOCATION].includes(intent.label),
        next_action: nextActionFor(intent.label)
      };
    }
  }

  return {
    intent: REPLY_INTENTS.NO_EFFECTIVE_FEEDBACK,
    confidence: 0.45,
    reason: "最近对话里没有足够的推进信号",
    positive_signal: false,
    negative_signal: false,
    next_action: "先保留该岗位,等待更多消息后再判断。"
  };
}

const HEURISTIC_INTENT_PATTERNS = [
  {
    intent: REPLY_INTENTS.INTERVIEW,
    patterns: [
      /面试/u,
      /约.*面/u,
      /约.*时间/u,
      /安排.*(?:面试|沟通)/u,
      /邀.*(?:面|聊)/u,
      /初试/u,
      /复试/u,
      /面谈/u,
      /电话沟通/u,
      /电话聊/u,
      /视频(?:面试|沟通)/u,
      /到公司/u,
      /来公司/u
    ]
  },
  {
    intent: REPLY_INTENTS.RESUME_REQUEST,
    patterns: [
      /附件简历/u,
      /最新简历/u,
      /在线简历/u,
      /发(?:一份|份)?(?:最新|完整|在线|附件)?简历/u,
      /发我.*简历/u,
      /简历.*发我/u,
      /简历.*看(?:看|下)/u,
      /方便.*简历/u,
      /(?:请|麻烦).{0,12}(?:发|提供|发送).{0,12}(?:简历|履历|作品集)/u,
      /我想要一份.{0,16}(?:简历|履历|作品集)/u,
      /需要.{0,12}(?:简历|履历|作品集)/u,
      /投递.*简历/u,
      /发送.*简历/u,
      /想要.*简历/u,
      /补充.*简历/u,
      /作品集/u
    ]
  },
  {
    intent: REPLY_INTENTS.WECHAT,
    patterns: [/微信/u, /加(?:一下)?微/u, /加(?:一下)?联系方式/u, /电话号码/u, /联系方式/u, /进一步沟通/u]
  },
  {
    intent: REPLY_INTENTS.REJECT_EXPERIENCE,
    patterns: [/经验.*不匹配/u, /年限.*不符/u, /经验.*不足/u, /更偏向.*有经验/u]
  },
  {
    intent: REPLY_INTENTS.REJECT_DIRECTION,
    patterns: [/方向.*不匹配/u, /岗位.*不合适/u, /不太符合/u, /偏差.*大/u]
  },
  {
    intent: REPLY_INTENTS.REJECT_LOCATION,
    patterns: [/薪资.*不符/u, /地点.*不符/u, /通勤.*不便/u, /城市.*不符/u]
  }
];

function detectIntentFromConversation(conversation = []) {
  const recentItems = conversation.slice(-6);
  const inboundText = recentItems
    .filter((item) => String(item?.sender || "").toLowerCase() !== "me")
    .map((item) => normalizeConversationText(item?.text || ""))
    .filter(Boolean)
    .join("\n");
  const allText = recentItems
    .map((item) => normalizeConversationText(item?.text || ""))
    .filter(Boolean)
    .join("\n");
  // Strong feedback must come from HR whenever direction is available. Falling
  // back to all messages only supports older records that lack direction.
  const searchableText = inboundText || allText;
  if (!searchableText) return "";

  for (const rule of HEURISTIC_INTENT_PATTERNS) {
    if (rule.patterns.some((pattern) => pattern.test(searchableText))) {
      return rule.intent;
    }
  }

  return "";
}

function normalizeConversationText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\[\((【].{0,8}[\]\))】]\s*/u, "")
    .replace(/^(?:送达|已读|未读|已发送)\s*/u, "")
    .trim();
}

function reasonForHeuristicIntent(intent) {
  if (intent === REPLY_INTENTS.RESUME_REQUEST) {
    return "近期对话里出现了索要简历、附件简历或补充材料等明确表达。";
  }
  if (intent === REPLY_INTENTS.INTERVIEW) {
    return "近期对话里出现了面试、电话沟通或约时间等明确表达。";
  }
  if (intent === REPLY_INTENTS.WECHAT) {
    return "近期对话里出现了微信、电话或联系方式交换等表达。";
  }
  if ([REPLY_INTENTS.REJECT_EXPERIENCE, REPLY_INTENTS.REJECT_DIRECTION, REPLY_INTENTS.REJECT_LOCATION].includes(intent)) {
    return "近期对话里出现了明确的拒绝或条件不符表达。";
  }
  return "近期对话里出现了可直接判定的关键信号。";
}

function buildSummary(score, keywordHits, hard) {
  if (!hard.should_apply) return "命中了硬性过滤项,建议先跳过。";
  if (score >= 80) {
    return `方向比较贴合,关键词命中 ${keywordHits.slice(0, 3).join("、") || "较多"},可以优先进入今日候选队列。`;
  }
  if (score >= 68) return "基础方向没有问题,但还需要人工确认地点、薪资或规模信息。";
  return "方向相关,但证据还不够强,建议谨慎判断后再投。";
}

function buildImprovementPath(riskPoints) {
  return riskPoints.slice(0, 3).map((item, index) => ({
    priority: index + 1,
    action: item.evidence_to_prepare || `补充与"${item.risk}"相关的真实项目证据`,
    impact_area: item.requirement_id || item.risk_id,
    requires_real_evidence: true
  }));
}

function buildInterviewFocus(keywordHits) {
  const items = ["你在过去项目里具体怎么拆需求和推动落地?"];
  if (keywordHits.some((item) => ["AI", "大模型", "LLM", "智能体", "Agent"].includes(item))) {
    items.push("你做过哪些 AI / 大模型相关场景,业务目标和结果分别是什么?");
  }
  return items;
}

function makePoint(requirementId, point, jdRequirement, resumeEvidence, evidenceStrength) {
  return {
    requirement_id: requirementId,
    point,
    resume_evidence: resumeEvidence || "",
    jd_requirement: jdRequirement || "",
    evidence_strength: evidenceStrength,
    evidence_gap: ""
  };
}

function makeRisk(riskId, requirementId, risk, riskType, reason) {
  return {
    risk_id: riskId,
    requirement_id: requirementId,
    risk,
    risk_type: riskType,
    reason,
    resume_evidence: "",
    transferable_evidence: "",
    interview_response: "如果被追问,建议只说明真实做过的部分和可迁移能力。",
    evidence_to_prepare: "补充真实案例或量化结果",
    risk_level: 2
  };
}

function selectJdSignals(job, reportContext, userProfile) {
  const text = normalizeText(`${job.title || ""} ${job.jd_text || ""}`);
  const matchedPoints = Array.isArray(reportContext?.matched_points) ? reportContext.matched_points : [];
  const signals = [];

  for (const item of matchedPoints) {
    if (item?.jd_requirement) {
      signals.push(...String(item.jd_requirement).split(/[、,,]/));
    }
  }

  for (const rule of JD_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      signals.push(rule.label);
    }
  }

  const preferredKeywords = userProfile.required_keywords.length ? userProfile.required_keywords : DEFAULT_DIRECTION_KEYWORDS;
  for (const keyword of preferredKeywords) {
    if (containsLoose(text, keyword)) {
      signals.push(keyword);
    }
  }

  return unique(signals)
    .map(cleanSignal)
    .filter((item) => item && !looksLikeSalary(item) && item.length <= 20)
    .slice(0, 4);
}

function selectStrengthSignals(job, userProfile) {
  const text = normalizeText(`${job.title || ""} ${job.jd_text || ""}`);
  const strengths = [];

  for (const rule of STRENGTH_RULES) {
    if (rule.when.some((pattern) => pattern.test(text))) {
      strengths.push(rule.value);
    }
  }

  if (!strengths.length && userProfile.target_roles.some((item) => containsLoose(item, "产品"))) {
    strengths.push("需求分析和产品推进");
  }

  strengths.push("把复杂需求拆成可执行方案");
  return unique(strengths).slice(0, 4);
}

function rotateGreetings(job, greetings) {
  if (!greetings.length) return [];
  const offset = stableHash(`${job?.source_url || ""}|${job?.title || ""}|${job?.company || ""}`) % greetings.length;
  return greetings.slice(offset).concat(greetings.slice(0, offset));
}

function stableHash(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000003;
  }
  return hash;
}

function cleanGreeting(value) {
  return String(value || "")
    .replace(/\b\d{1,2}\s*-\s*\d{1,2}\s*K\b/gi, "")
    .replace(/\b\d{1,2}\s*K\b/gi, "")
    .replace(/\d+薪/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function joinSignals(items, limit = 2, separator = "、") {
  const picked = unique(items).slice(0, limit).filter(Boolean);
  if (!picked.length) return "岗位当前最核心的业务方向";
  if (picked.length === 1) return picked[0];
  if (picked.length === 2 && separator === "和") return `${picked[0]}和${picked[1]}`;
  return picked.join(separator);
}

function cleanSignal(value) {
  return String(value || "")
    .replace(/[,。;;]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeSalary(text) {
  return /(?:\d{1,2}\s*-\s*\d{1,2}\s*K|\d{1,2}\s*K|\d+薪)/i.test(String(text || ""));
}

function containsLoose(text, keyword) {
  const source = normalizeText(text).toLowerCase();
  const target = normalizeText(keyword).toLowerCase();
  if (!source || !target) return false;
  if (source.includes(target)) return true;
  const compact = target.replace(/\s+/g, "");
  return compact.length >= 2 && source.includes(compact);
}

function excerpt(text, keyword) {
  const source = String(text || "");
  if (!keyword) return source.slice(0, 80);
  const index = source.toLowerCase().indexOf(String(keyword).toLowerCase());
  if (index < 0) return source.slice(0, 80);
  return source.slice(Math.max(0, index - 20), index + 60).trim();
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function unique(items) {
  return [...new Set((items || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function nextActionFor(intent) {
  switch (intent) {
    case REPLY_INTENTS.INTERVIEW:
      return "尽快确认可面试时间,并准备针对 JD 的案例说明。";
    case REPLY_INTENTS.RESUME_REQUEST:
      return "发送最新版简历,并补一句与岗位最相关的经历。";
    case REPLY_INTENTS.WECHAT:
      return "可以继续沟通,但先确认岗位方向和面试流程。";
    case REPLY_INTENTS.REJECT_EXPERIENCE:
    case REPLY_INTENTS.REJECT_DIRECTION:
    case REPLY_INTENTS.REJECT_LOCATION:
      return "将该岗位降权,转而关注更贴近的 JD。";
    case REPLY_INTENTS.GREETING:
      return "可以先回复一句简洁介绍,再观察对方是否继续推进。";
    default:
      return "先保留该岗位,等待更多消息后再判断。";
  }
}
