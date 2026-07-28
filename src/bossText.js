const PRIVATE_DIGIT_MAP = new Map([
  ["\uE031", "0"],
  ["\uE032", "1"],
  ["\uE033", "2"],
  ["\uE034", "3"],
  ["\uE035", "4"],
  ["\uE036", "5"],
  ["\uE037", "6"],
  ["\uE038", "7"],
  ["\uE039", "8"],
  ["\uE03A", "9"]
]);

const SALARY_PATTERN = /(\d{1,2}(?:\.\d+)?-\d{1,2}(?:\.\d+)?K(?:·\d{1,2}薪)?)/i;

export function decodeBossDigits(value) {
  return String(value || "").replace(/[\uE031-\uE03A]/g, (char) => PRIVATE_DIGIT_MAP.get(char) || char);
}

export function cleanBossText(value) {
  return decodeBossDigits(value)
    .replace(/[A-Za-z0-9_]+\{[^}]+\}/g, " ")
    .replace(/BOSS直聘/g, " ")
    .replace(/boss直聘/gi, " ")
    .replace(/去App与BOSS随时沟通/gi, " ")
    .replace(/前往App与BOSS随时沟通/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSalary(value) {
  const match = cleanBossText(value).match(SALARY_PATTERN);
  return match ? match[1] : "";
}

export function normalizeBossJob(job = {}) {
  const titleRaw = cleanBossText(job.title || "");
  const company = cleanBossText(job.company || "");
  const location = cleanBossText(job.location || "");
  const companySize = cleanBossText(job.company_size || "");
  const jdText = cleanBossText(job.jd_text || "");
  const merged = [titleRaw, job.salary || "", jdText].map(cleanBossText).join(" ");
  const salary = extractSalary(job.salary || merged);
  const title = titleRaw.replace(SALARY_PATTERN, "").replace(/\s+/g, " ").trim() || titleRaw;

  return {
    ...job,
    title,
    company,
    location,
    salary,
    company_size: companySize,
    jd_text: jdText
  };
}
