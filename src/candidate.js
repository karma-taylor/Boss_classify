const OUTSOURCING_PATTERNS = [
  /外包/,
  /驻场/,
  /派遣/,
  /人力外包/,
  /项目外派/,
  /劳务/,
  /第三方/,
  /outsourc/i
];

const DEFAULT_DIRECTION_KEYWORDS = ["AI", "LLM", "大模型", "智能体", "产品", "Python", "Java"];

export function buildUserProfile(options = {}) {
  return {
    target_roles: arrayFrom(options.job_titles || options.target_roles),
    required_keywords: arrayFrom(options.jd_keywords || options.required_keywords),
    preferred_locations: arrayFrom(options.locations || options.preferred_locations),
    salary_min: toPositiveNumber(options.salary_min),
    salary_max: toPositiveNumber(options.salary_max),
    company_size_min: toPositiveNumber(options.company_size_min),
    company_size_max: toPositiveNumber(options.company_size_max)
  };
}

export function normalizeCandidateReport(job, aiReport = {}, greetingResult = {}, options = {}) {
  const profile = buildUserProfile(options);
  const hard = hardFilterJob(job, profile);
  const score = clamp(Number(aiReport.match_score || 0), 0, 100);
  const tier = String(aiReport.job_tier || "").toUpperCase();
  const aiRejectReasons = unique([
    ...arrayFrom(aiReport.reject_reasons),
    ...arrayFrom(aiReport.hard_flaws)
  ]);
  const rejectReasons = unique([
    ...hard.reject_reasons,
    ...aiRejectReasons
  ]).filter((reason) => !isExperienceReason(reason));
  const riskFlags = unique([
    ...hard.risk_flags,
    ...arrayFrom(aiReport.risk_flags),
    ...arrayFrom(aiReport.blocked_by_preferences)
  ]).filter((flag) => flag !== "experience_over_limit");

  const aiShouldApply =
    typeof aiReport.should_apply === "boolean"
      ? aiReport.should_apply || aiRejectReasons.length > 0 && aiRejectReasons.every(isExperienceReason)
      : score >= 70 && tier !== "C";

  const shouldApply = hard.should_apply && aiShouldApply;
  const queueStatus = classifyCandidate({ shouldApply, rejectReasons, riskFlags, score, tier });
  const greetingDraft = refineGreetingDraft(
    job,
    selectGreetingDraft(job, greetingResult, String(aiReport.greeting_draft || ""))
  );

  return {
    ...aiReport,
    match_score: score,
    should_apply: shouldApply,
    queue_status: queueStatus,
    reject_reasons: rejectReasons,
    risk_flags: riskFlags,
    greeting_draft: greetingDraft,
    local_rules: hard
  };
}

export function hardFilterJob(job, profile = buildUserProfile()) {
  const text = `${job?.title || ""} ${job?.company || ""} ${job?.company_size || ""} ${job?.salary || ""} ${job?.location || ""} ${job?.jd_text || ""}`;
  const rejectReasons = [];
  const riskFlags = [];

  if (OUTSOURCING_PATTERNS.some((pattern) => pattern.test(text))) {
    rejectReasons.push("疑似外包、驻场或派遣岗位");
    riskFlags.push("outsourcing_risk");
  }

  const broadDirectionKeywords = profile.target_roles.length
    ? unique([...profile.target_roles, ...DEFAULT_DIRECTION_KEYWORDS])
    : DEFAULT_DIRECTION_KEYWORDS;
  const profileKeywordMatched = profile.required_keywords.length
    ? profile.required_keywords.some((keyword) => containsLoose(text, keyword))
    : true;
  const broadDirectionMatched = broadDirectionKeywords.some((keyword) => containsLoose(text, keyword));

  if (!broadDirectionMatched) {
    rejectReasons.push("JD 未命中目标方向关键词");
    riskFlags.push("direction_mismatch");
  } else if (!profileKeywordMatched) {
    riskFlags.push("direction_mismatch");
  }

  const salaryRange = extractSalaryRange(text);
  if (salaryRange && profile.salary_min && salaryRange.max < profile.salary_min) {
    rejectReasons.push(`薪资上限 ${salaryRange.max}K 低于期望下限 ${profile.salary_min}K`);
    riskFlags.push("salary_below_minimum");
  }
  if (salaryRange && profile.salary_max && salaryRange.min > profile.salary_max) {
    rejectReasons.push(`薪资下限 ${salaryRange.min}K 高于期望上限 ${profile.salary_max}K`);
    riskFlags.push("salary_above_maximum");
  }

  const companySize = extractCompanySize(text);
  if (!companySize && (profile.company_size_min || profile.company_size_max)) {
    riskFlags.push("company_size_missing");
  }
  if (companySize && profile.company_size_min && companySize.max < profile.company_size_min) {
    riskFlags.push("company_size_below_minimum");
  }
  if (companySize && profile.company_size_max && companySize.min > profile.company_size_max) {
    riskFlags.push("company_size_above_maximum");
  }

  if (profile.preferred_locations.length) {
    const locationText = String(job?.location || text);
    if (!profile.preferred_locations.some((item) => containsLoose(locationText, item))) {
      riskFlags.push("location_not_preferred");
    }
  }

  return {
    should_apply: rejectReasons.length === 0,
    reject_reasons: rejectReasons,
    risk_flags: riskFlags
  };
}

export function classifyCandidate({ shouldApply, rejectReasons = [], riskFlags = [], score = 0 }) {
  if (!shouldApply || rejectReasons.length) return "not_recommended";
  const visibleRiskFlags = riskFlags.filter((flag) => !["remote_worker_unavailable", "worker_unavailable"].includes(flag));
  if (Number(score || 0) >= 75 && !visibleRiskFlags.length) return "recommended";
  return "needs_review";
}

export function hasDailyRecommendationCapacity(db, limit = 20) {
  return getDailyRecommendationRemaining(db, limit) > 0;
}

export function getDailyRecommendationRemaining(db, limit = 20) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT recommended_count, applied_count FROM daily_metrics WHERE metric_date = ?").get(today);
  const used = Number(row?.recommended_count || 0) + Number(row?.applied_count || 0);
  return Math.max(0, Math.max(1, Number(limit || 20)) - used);
}

export function incrementReadMetric(db, count) {
  incrementMetric(db, { read_count: Number(count || 0) });
}

export function incrementRecommendedMetric(db, count) {
  incrementMetric(db, { recommended_count: Number(count || 0) });
}

export function extractSalaryRange(text) {
  const match = String(text || "").match(/(\d{1,2})(?:\.\d+)?\s*-\s*(\d{1,2})(?:\.\d+)?\s*K/i);
  if (!match) return null;
  return { min: Number(match[1]), max: Number(match[2]) };
}

export function extractCompanySize(text) {
  const source = String(text || "");
  const range = source.match(/(\d+)\s*[-~到至]\s*(\d+)\s*人/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };

  const plus = source.match(/(\d+)\s*人(?:以上|\+)/);
  if (plus) return { min: Number(plus[1]), max: Infinity };

  const below = source.match(/(?:少于\s*(\d+)\s*人|(\d+)\s*人以下)/);
  if (below) return { min: 0, max: Number(below[1] || below[2]) };

  const single = source.match(/(\d+)\s*人/);
  if (single) {
    const value = Number(single[1]);
    return { min: value, max: value };
  }

  return null;
}

function incrementMetric(db, fields) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_metrics (metric_date, read_count, recommended_count, updated_at)
    VALUES (?, 0, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(metric_date) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run(today);

  if (fields.read_count) {
    db.prepare("UPDATE daily_metrics SET read_count = read_count + ?, updated_at = CURRENT_TIMESTAMP WHERE metric_date = ?").run(fields.read_count, today);
  }
  if (fields.recommended_count) {
    db.prepare("UPDATE daily_metrics SET recommended_count = recommended_count + ?, updated_at = CURRENT_TIMESTAMP WHERE metric_date = ?").run(fields.recommended_count, today);
  }
}

function selectGreetingDraft(job, greetingResult, fallbackGreeting) {
  const chosen = chooseGreetingVariant(job, greetingResult?.greetings || []);
  return chosen || String(fallbackGreeting || "").trim();
}

function chooseGreetingVariant(job, greetings) {
  const variants = Array.isArray(greetings) ? greetings.map((item) => String(item || "").trim()).filter(Boolean) : [];
  if (!variants.length) return "";

  return variants
    .map((greeting, index) => ({
      greeting,
      score: scoreGreetingAgainstJob(job, greeting) * 10 + stableGreetingBonus(job, index, variants.length)
    }))
    .sort((left, right) => right.score - left.score)[0]?.greeting || "";
}

function scoreGreetingAgainstJob(job, greeting) {
  const source = `${job?.title || ""} ${job?.jd_text || ""}`;
  const text = String(greeting || "");
  const keywords = [
    "AI产品",
    "产品经理",
    "智能体",
    "Agent",
    "工作流",
    "提效",
    "降本增效",
    "业务场景",
    "需求拆解",
    "跨团队",
    "项目落地",
    "数据分析",
    "指标",
    "SQL",
    "Python",
    "企业服务",
    "SaaS",
    "大模型",
    "LLM",
    "RAG"
  ];
  return keywords.filter((keyword) => source.includes(keyword) && text.includes(keyword)).length;
}

function stableGreetingBonus(job, index, total) {
  const seed = `${job?.source_url || ""}|${job?.title || ""}|${job?.company || ""}`;
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 33 + char.charCodeAt(0)) % 1000003;
  }
  return total > 0 && hash % total === index ? 3 : 0;
}

function refineGreetingDraft(job, rawGreeting) {
  const greeting = String(rawGreeting || "").trim();
  if (!greeting) return "";

  let cleaned = greeting
    .replace(/\b\d{1,2}\s*-\s*\d{1,2}\s*K\b/gi, "")
    .replace(/\b\d{1,2}\s*K\b/gi, "")
    .replace(/\d+薪/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const tooGeneric =
    /AI产品规划/.test(cleaned) &&
    /需求拆解/.test(cleaned) &&
    /跨团队推进/.test(cleaned) &&
    /项目落地/.test(cleaned);
  const lacksSelfPositioning = !/我这边|我之前|我做过|我比较能补位/.test(cleaned);

  if (tooGeneric || lacksSelfPositioning) {
    const roleName = String(job?.title || "这个岗位").trim();
    cleaned =
      `您好,我认真看了 ${roleName} 这个岗位,方向和我最近在持续投入的内容比较贴近。` +
      `我这边更能补位的是复杂需求拆解、跨团队推进和产品方案落地,也想进一步了解这个岗位当前最看重的业务场景和推进重点。`;
  }

  return cleaned;
}

function containsLoose(text, keyword) {
  const source = normalizeText(text).toLowerCase();
  const target = normalizeText(keyword).toLowerCase();
  if (!source || !target) return false;
  if (source.includes(target)) return true;
  const compact = target.replace(/\s+/g, "");
  return compact.length >= 2 && source.includes(compact);
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function arrayFrom(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[,,、\s\n\r\t]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toPositiveNumber(value) {
  const number = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function unique(items) {
  return [...new Set((items || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function formatCompanySize(value) {
  return value === Infinity ? "无限" : `${value} 人`;
}

function isExperienceReason(reason) {
  return /experience|年限|经验/i.test(String(reason || ""));
}
