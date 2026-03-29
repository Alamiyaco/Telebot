import express from "express";
import Database from "better-sqlite3";
import crypto from "crypto";

const db = new Database("jobs_v4.db");

// =========================
// DB
// =========================
db.exec(`
CREATE TABLE IF NOT EXISTS ads_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT,
  raw_text TEXT NOT NULL,
  clean_text TEXT,
  source_chat_id TEXT,
  source_message_id TEXT,
  ai_output_json TEXT,
  final_output_json TEXT,
  extract_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ads_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_ad_id INTEGER,
  hash TEXT,
  raw_text TEXT NOT NULL,
  clean_text TEXT,
  ai_output_json TEXT,
  final_output_json TEXT,
  review_reason TEXT,
  review_status TEXT DEFAULT 'pending',
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ads_published (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT UNIQUE,
  raw_ad_id INTEGER,
  hash TEXT,
  title TEXT,
  category TEXT,
  company TEXT,
  location TEXT,
  salary TEXT,
  contact TEXT,
  application_method TEXT,
  confidence REAL,
  raw_text TEXT NOT NULL,
  clean_text TEXT,
  qudrat_chat_id TEXT,
  qudrat_message_id TEXT,
  website_status TEXT DEFAULT 'pending',
  published_at TEXT DEFAULT (datetime('now'))
);
`);

const app = express();
app.use(express.json({ limit: "2mb" }));

// =========================
// ENV
// =========================
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const INBOX_CHAT_ID = Number(process.env.INBOX_CHAT_ID || 0);
const REVIEW_CHAT_ID = Number(process.env.REVIEW_CHAT_ID || 0);
const QUDRAT_CHAT_ID = Number(process.env.QUDRAT_CHAT_ID || 0);
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

const MODEL_NAME = (process.env.MODEL_NAME || "gpt-4.1").trim();
const AUTO_PUBLISH_MIN_SCORE = Number(process.env.AUTO_PUBLISH_MIN_SCORE || 85);
const REVIEW_MIN_SCORE = Number(process.env.REVIEW_MIN_SCORE || 65);

function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

mustEnv("BOT_TOKEN", BOT_TOKEN);
mustEnv("INBOX_CHAT_ID", INBOX_CHAT_ID);
mustEnv("REVIEW_CHAT_ID", REVIEW_CHAT_ID);
mustEnv("QUDRAT_CHAT_ID", QUDRAT_CHAT_ID);
mustEnv("OPENAI_API_KEY", OPENAI_API_KEY);

// =========================
// Telegram
// =========================
async function tg(method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    });

    const json = await res.json().catch(() => ({}));
    if (!json.ok) console.log("TG error:", json);
    return json;
  } catch (err) {
    console.log("TG fetch error:", err);
    return { ok: false, description: String(err) };
  }
}

// =========================
// Helpers
// =========================
function normalizeArabicDigits(s = "") {
  const ar = "٠١٢٣٤٥٦٧٨٩";
  const en = "0123456789";
  return String(s).replace(/[٠-٩]/g, d => en[ar.indexOf(d)] ?? d);
}

function normalizeText(s = "") {
  return normalizeArabicDigits(String(s || ""))
    .replace(/\u200f|\u200e|\u202a|\u202b|\u202c/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInline(s = "") {
  return normalizeText(s).replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function stripEmojis(s = "") {
  return String(s).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
}

function sha256(s = "") {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function generateJobId() {
  const row = db.prepare(`
    SELECT job_id FROM ads_published
    ORDER BY id DESC LIMIT 1
  `).get();

  let nextNum = 1;
  if (row?.job_id) {
    const match = row.job_id.match(/QUD-(\d+)/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }

  return `QUD-${String(nextNum).padStart(4, "0")}`;
}

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

function linesOf(text = "") {
  return normalizeText(text)
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);
}

function cleanTelegramAd(raw = "") {
  let x = normalizeText(raw);
  x = stripEmojis(x);

  x = x
    .replace(/[•●▪■◆◇★☆✅☑✔✳✴❇❗❕❗️]+/g, " ")
    .replace(/[═─—–]{2,}/g, "\n")
    .replace(/[📌📍📢📣💼🔥⭐🟢🔹🔸🟡🟣🧾📝📞☎️☎]+/gu, " ")
    .replace(/#{2,}/g, "#")
    .replace(/_{2,}/g, " ")
    .replace(/\*{2,}/g, " ")
    .replace(/~{2,}/g, " ");

  x = x
    .replace(/\bواتس(?:اب)?\b/gi, "واتساب")
    .replace(/\bwhats\s*app\b/gi, "WhatsApp")
    .replace(/\bhr\b/gi, "HR")
    .replace(/\bcv\b/gi, "CV");

  x = x
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+\n/g, "\n\n");

  return x.trim();
}

// =========================
// Contact Extraction
// =========================
function extractPhones(text = "") {
  const matches = normalizeText(text).match(/\+?\d[\d\s\-()]{7,}\d/g) || [];
  return unique(
    matches
      .map(x => normalizeInline(x).replace(/[()]/g, ""))
      .filter(x => x.replace(/[^\d]/g, "").length >= 8)
  );
}

function extractEmails(text = "") {
  const matches = normalizeText(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  return unique(matches.map(x => normalizeInline(x)));
}

function extractLinks(text = "") {
  const matches = normalizeText(text).match(/https?:\/\/\S+|t\.me\/\S+|telegram\.me\/\S+/ig) || [];
  return unique(matches.map(x => normalizeInline(x)));
}

function hasAnyContact(text = "") {
  return extractPhones(text).length > 0 || extractEmails(text).length > 0 || extractLinks(text).length > 0;
}

function smartContact(text = "") {
  const phones = extractPhones(text);
  const emails = extractEmails(text);
  const links = extractLinks(text);
  const list = unique([...phones, ...emails, ...links]);
  return list.length ? list.join(" | ") : "غير مذكور";
}

function isLikelyPhone(s = "") {
  const x = normalizeInline(s);
  return /^(?:\+?\d[\d\s\-]{7,}\d)$/.test(x);
}

function isLikelyEmail(s = "") {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(normalizeInline(s));
}

// =========================
// Salary / Location
// =========================
function isLikelySalaryValue(s = "") {
  const x = normalizeInline(s);
  if (!x || x === "غير مذكور") return false;
  if (isLikelyPhone(x) || isLikelyEmail(x)) return false;
  if (/(واتساب|whatsapp|gmail|yahoo|outlook|cv|@|telegram|t\.me)/i.test(x)) return false;
  return /(\d{1,3}(?:[,\.\s]\d{3})+|\d{5,})/.test(x) || /(دينار|دولار|\$|IQD|USD|شهري|يومي|نسبة)/i.test(x);
}

function smartSalary(text = "") {
  const lines = linesOf(text);

  for (const line of lines) {
    const m = line.match(/(?:الراتب|راتب|الأجر|الاجر|salary)\s*[:：\-–—]?\s*([^\n\r]{2,120})/i);
    if (m?.[1]) {
      const value = normalizeInline(m[1]);
      if (isLikelySalaryValue(value)) return value;
    }
  }

  for (const line of lines) {
    if (/(دينار|دولار|\$|IQD|USD|نسبة)/i.test(line) && isLikelySalaryValue(line)) {
      return normalizeInline(line);
    }
  }

  return "غير مذكور";
}

const IRAQ_CITIES = [
  "بغداد", "البصرة", "أربيل", "اربيل", "دهوك", "السليمانية", "النجف", "كربلاء", "الناصرية",
  "الموصل", "كركوك", "الأنبار", "الانبار", "الحلة", "واسط", "الديوانية", "ديالى", "ميسان",
  "ذي قار", "تكريت", "صلاح الدين", "السماوة", "بابل"
];

const BAGHDAD_AREAS = [
  "الكرادة", "المنصور", "الجادرية", "الزيونة", "العامرية", "الدورة", "الكاظمية", "الأعظمية",
  "الاعظمية", "اليرموك", "الشعب", "الغدير", "المنطقة الخضراء", "ساحة عدن", "البنوك", "السيدية",
  "الحارثية", "العدل", "حي الجامعة", "بغداد الجديدة", "البياع", "البكرية"
];

function extractLocation(text = "") {
  const x = normalizeText(text);
  const lines = linesOf(text);

  for (const line of lines.slice(0, 15)) {
    const m = line.match(/(?:الموقع|العنوان|مكان العمل|موقع العمل|location|مكان العمل)\s*[:：\-–—]?\s*(.+)$/i);
    if (m?.[1]) return normalizeInline(m[1]);
  }

  for (const city of IRAQ_CITIES) {
    if (x.includes(city)) return city;
  }

  for (const area of BAGHDAD_AREAS) {
    if (x.includes(area)) return area;
  }

  const m = x.match(/(?:في|داخل|ضمن|منطقة)\s+(بغداد|البصرة|أربيل|اربيل|دهوك|السليمانية|النجف|كربلاء|الموصل|كركوك|الكرادة|المنصور|الجادرية|الزيونة|اليرموك|السيدية|البياع|البكرية)/i);
  if (m?.[1]) return normalizeInline(m[1]);

  return "غير مذكور";
}

// =========================
// Company / Title
// =========================
function cleanupCompanyName(s = "") {
  let x = normalizeInline(s);
  x = stripEmojis(x);
  x = x.replace(/^(?:اسم الشركة|الشركة)\s*[:：]\s*/i, "").trim();
  x = x.replace(/^(?:تعلن|يعلن)\s+/i, "").trim();
  x = x.replace(/(عن حاجتها|بحاجتها|لتعيين|لتوظيف|تطلب|المطلوب|الراتب|التواصل|واتساب|طريقة التواصل|الدوام|الموقع).*$/i, "").trim();
  x = x.replace(/[|]/g, " ").trim();
  x = x.replace(/\s{2,}/g, " ").trim();

  if (!x) return "غير مذكور";
  if (isLikelyPhone(x) || isLikelyEmail(x)) return "غير مذكور";
  if (x.length > 80) return "غير مذكور";
  if (/^(مطلوب|مطلوبة|موظف|موظفة|محاسب|كاشير|مندوب|مسؤول|موظفين)$/i.test(x)) return "غير مذكور";

  return x;
}

function extractCompany(text = "") {
  const normalized = normalizeText(text);
  const lines = linesOf(text);

  let m = normalized.match(/(?:تعلن|يعلن)\s+(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون|وكالة)\s+([^\n]{2,80})/i);
  if (m) {
    const c = cleanupCompanyName(`${m[1]} ${m[2]}`);
    if (c !== "غير مذكور") return c;
  }

  for (const line of lines.slice(0, 12)) {
    m = line.match(/^(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون)\s+([^\n]{2,80})/i);
    if (m) {
      const c = cleanupCompanyName(`${m[1]} ${m[2]}`);
      if (c !== "غير مذكور") return c;
    }
  }

  for (const line of lines.slice(0, 12)) {
    m = line.match(/^(?:اسم الشركة|الشركة|اسم الصالون|اسم المركز)\s*[:：]\s*(.+)$/i);
    if (m?.[1]) {
      const c = cleanupCompanyName(m[1]);
      if (c !== "غير مذكور") return c;
    }
  }

  return "غير مذكور";
}

const BAD_TITLES = [
  "غير مذكور",
  "مطلوب",
  "مطلوبة",
  "موظف",
  "موظفة",
  "موظفين",
  "موظفات",
  "فرصة عمل",
  "وظيفة",
  "واتساب",
  "whatsapp",
  "للتواصل",
  "الرقم",
  "الشركة",
  "اسم الشركة"
];

function isBadGenericTitle(x = "") {
  return BAD_TITLES.includes(normalizeInline(x).toLowerCase());
}

function cleanJobTitle(s = "") {
  let x = normalizeInline(s);
  x = stripEmojis(x);

  x = x
    .replace(/^(مطلوب|مطلوبة|نبحث عن|فرصة عمل|وظيفة شاغرة|بحاجة الى|بحاجة إلى|Hiring|Position)\s+/i, "")
    .replace(/^(?:تعلن شركة|يعلن مكتب|تعلن مؤسسة)\s+/i, "")
    .replace(/\b(ذكور|إناث|للجنسين|للذكور|للاناث|للإناث|أنثى|ذكر)\b/gi, "")
    .replace(/\s+(?:في|للعمل في|للعمل لدى|داخل|ضمن)\s+(شركة|مطعم|معهد|وكالة|مؤسسة|مكتب|معمل|مصنع|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون).*/i, "")
    .replace(/\s+(?:براتب|راتب|الراتب|الدوام|الموقع|العنوان|التواصل|واتساب|تفاصيل|الشروط|للتقديم)\b.*$/i, "")
    .replace(/[|:\-–—].*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!x || isBadGenericTitle(x)) return "غير مذكور";
  if (x.length > 60) return "غير مذكور";
  return x;
}

function isGoodTitle(t = "") {
  const x = normalizeInline(t).toLowerCase();
  if (!x) return false;
  if (isBadGenericTitle(x)) return false;
  if (x.length < 2 || x.length > 60) return false;
  if (/(واتساب|whatsapp|للتواصل|اتصال|هاتف|رقم|ايميل|email)/i.test(x)) return false;
  if (/(راتب|الراتب|الدوام|الموقع|العنوان|الشركة|تفاصيل|التقديم|cv)/i.test(x)) return false;
  return true;
}

function extractJobTitle(text = "") {
  const lines = linesOf(text);

  for (const line of lines.slice(0, 12)) {
    let m = line.match(/^(?:عنوان\s*الوظيف(?:ة|ي)|المسمى الوظيفي|العنوان الوظيفي|Job Title)\s*[:：]\s*(.+)$/i);
    if (m?.[1]) {
      const t = cleanJobTitle(m[1]);
      if (isGoodTitle(t)) return t;
    }

    m = line.match(/^(?:مطلوب|مطلوبة|فرصة عمل|وظيفة شاغرة|نبحث عن|بحاجة الى|بحاجة إلى|Hiring|Position)\s*[:：\-–—]?\s*(.+)$/i);
    if (m?.[1]) {
      const t = cleanJobTitle(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  for (const line of lines.slice(0, 8)) {
    const t = cleanJobTitle(line);
    if (isGoodTitle(t)) return t;
  }

  return "غير مذكور";
}

function extractEmploymentType(text = "") {
  const x = normalizeText(text);

  if (/(دوام جزئي|part time)/i.test(x)) return "دوام جزئي";
  if (/(دوام كامل|full time)/i.test(x)) return "دوام كامل";
  if (/(شفت مسائي|مسائي)/i.test(x)) return "شفت مسائي";
  if (/(شفت صباحي|صباحي)/i.test(x)) return "شفت صباحي";
  if (/(فريلانس|عن بعد|remote|اونلاين|أونلاين|من البيت)/i.test(x)) return "عن بعد / مرن";

  return "غير مذكور";
}

function extractExperience(text = "") {
  const lines = linesOf(text);

  for (const line of lines) {
    const m = line.match(/(?:خبرة|الخبرة|سنوات الخبرة|experience)\s*[:：\-–—]?\s*([^\n\r]{2,80})/i);
    if (m?.[1]) return normalizeInline(m[1]);
  }

  const x = normalizeText(text);
  const m = x.match(/(\d+\s*(?:سنة|سنوات|year|years))/i);
  if (m?.[1]) return normalizeInline(m[1]);

  return "غير مذكور";
}

function inferApplicationMethod(text = "", contact = "") {
  const full = `${text}\n${contact}`;

  if (/واتساب|whatsapp/i.test(full)) return "واتساب";
  if (/t\.me|telegram|تيليجرام/i.test(full)) return "تيليجرام";
  if (/email|e-mail|gmail|outlook|yahoo|ارس(?:ال)?\s*CV|إرسال\s*CV|السيرة الذاتية|cv/i.test(full)) {
    return "إيميل / إرسال CV";
  }
  if (extractPhones(full).length > 0) return "هاتف / رقم مباشر";
  if (extractEmails(full).length > 0) return "إيميل";

  return "غير مذكور";
}

function fallbackCategory(text = "", title = "") {
  const s = normalizeInline(`${title} ${text}`).toLowerCase();

  if (/(hr|human resources|موارد بشرية|توظيف|recruit)/i.test(s)) return "HR";
  if (/(admin|إداري|اداري|استقبال|رسبشن|سكرتير|سكرتارية|office)/i.test(s)) return "Admin";
  if (/(sales|مبيعات|مندوب|مندوبة|كاشير|cashier|مستشارة مبيعات|موظفه مبيعات|موظفة مبيعات)/i.test(s)) return "Sales";
  if (/(customer service|خدمة عملاء|call center)/i.test(s)) return "Customer Service";
  if (/(account|محاسب|محاسبة|حسابات|finance|مالي|محاسبه)/i.test(s)) return "Accounting";
  if (/(engineer|مهندس|فني صيانة|maintenance)/i.test(s)) return "Engineering";
  if (/(developer|programmer|it support|it|شبكات|تقنية|برمجة|technical support)/i.test(s)) return "IT";
  if (/(designer|تصميم|مصمم|جرافيك|مونتاج|سوشيال ميديا)/i.test(s)) return "Design";
  if (/(marketing|تسويق|مروج|مروجة)/i.test(s)) return "Marketing";
  if (/(driver|سائق|توصيل|لوجست|مخزن|warehouse|storekeeper)/i.test(s)) return "Logistics";
  if (/(مشتريات|procurement|buyer)/i.test(s)) return "Procurement";
  if (/(قانوني|محامي|legal)/i.test(s)) return "Legal";
  if (/(طبي|صيدل|تمريض|مختبر|عيادة|مركز طبي|مستشفى|تنظيف البشرة|كوافيرة|صالون)/i.test(s)) return "Medical";
  if (/(مدرس|تدريس|معهد|teacher|education)/i.test(s)) return "Education";
  if (/(operations|تشغيل|مشرف عمليات)/i.test(s)) return "Operations";
  if (/(manager|مدير|management|supervisor|مشرف)/i.test(s)) return "Management";
  if (/(hotel|مطعم|مقهى|barista|chef|hospitality|ضيافة|طباخ)/i.test(s)) return "Hospitality";
  if (/(security|حارس|أمن)/i.test(s)) return "Security";

  return "Other";
}

function toNullableString(v) {
  if (v === null || v === undefined) return "غير مذكور";
  const x = normalizeInline(String(v));
  return x || "غير مذكور";
}

// =========================
// Heuristic hints before AI
// =========================
function buildHeuristicHints(rawText = "", cleanText = "") {
  const text = cleanText || rawText;

  return {
    title_hint: extractJobTitle(text),
    company_hint: extractCompany(text),
    location_hint: extractLocation(text),
    employment_type_hint: extractEmploymentType(text),
    experience_hint: extractExperience(text),
    salary_hint: smartSalary(text),
    contact_hint: smartContact(text),
    application_method_hint: inferApplicationMethod(text, smartContact(text)),
    category_hint: fallbackCategory(text, extractJobTitle(text))
  };
}

// =========================
// AI Extraction
// =========================
async function extractWithAI(rawText, cleanText) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      category: {
        type: "string",
        enum: [
          "HR",
          "Admin",
          "Sales",
          "Customer Service",
          "Accounting",
          "Finance",
          "Engineering",
          "IT",
          "Design",
          "Marketing",
          "Logistics",
          "Procurement",
          "Legal",
          "Medical",
          "Education",
          "Operations",
          "Management",
          "Hospitality",
          "Security",
          "Other"
        ]
      },
      company: { type: "string" },
      location: { type: "string" },
      employment_type: { type: "string" },
      experience: { type: "string" },
      salary: { type: "string" },
      contact: { type: "string" },
      application_method: { type: "string" },
      is_multi_role: { type: "boolean" },
      confidence: { type: "number" },
      summary: { type: "string" }
    },
    required: [
      "title",
      "category",
      "company",
      "location",
      "employment_type",
      "experience",
      "salary",
      "contact",
      "application_method",
      "is_multi_role",
      "confidence",
      "summary"
    ]
  };

  const hints = buildHeuristicHints(rawText, cleanText);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        temperature: 0,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: `
أنت نظام احترافي لاستخراج بيانات إعلانات الوظائف العربية، خصوصاً إعلانات تيليجرام العراقية.

مهمتك:
قراءة النص الخام + النص المنظف + التلميحات الأولية الناتجة من القواعد، ثم إخراج JSON دقيق جداً.

قواعد صارمة جداً:
1) لا تخترع أي معلومة غير موجودة بوضوح.
2) إذا كانت المعلومة غير موجودة اكتب "غير مذكور".
3) title = اسم الوظيفة فقط، وليس جملة طويلة أو اسم شركة أو وصف.
4) company = اسم الجهة فقط، وليس المسمى الوظيفي.
5) إذا كنت متردداً بين title و company فلا تخلط بينهما.
6) contact يجب أن يحتوي وسائل التواصل الواضحة فقط.
7) application_method يجب أن يكون واحداً من: واتساب / إيميل / هاتف / تيليجرام / إيميل / إرسال CV / غير مذكور.
8) location لا تُخترع. إذا ذُكرت منطقة مثل الكرادة فاكتبها كما هي.
9) salary لا تستنتجه من رقم هاتف أو رقم عشوائي.
10) إذا الإعلان يحتوي أكثر من وظيفة واضحة ضع is_multi_role = true.
11) confidence رقم من 0 إلى 1.
12) summary مختصر جداً، سطر واحد فقط، دون اختراع أي معلومة.
13) إذا كانت التلميحات الأولية صحيحة فاستخدمها، وإذا كانت خاطئة تجاهلها. التلميحات ليست حقائق ملزمة.
14) أعد JSON فقط.
                `.trim()
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `
RAW AD:
"""
${rawText}
"""

CLEAN AD:
"""
${cleanText}
"""

HEURISTIC HINTS:
${JSON.stringify(hints, null, 2)}
                `.trim()
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "job_ad_extraction_v4",
            strict: true,
            schema
          }
        }
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.log("OpenAI API error:", {
        status: response.status,
        model: MODEL_NAME,
        data
      });
      return {
        __ai_failed__: true,
        __error__: JSON.stringify({
          status: response.status,
          model: MODEL_NAME,
          data
        }).slice(0, 1500)
      };
    }

    let content = data.output_text || "";

    if (!content && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === "output_text" && c.text) {
              content = c.text;
              break;
            }
          }
        }
        if (content) break;
      }
    }

    if (!content) {
      console.log("OpenAI empty output:", data);
      return {
        __ai_failed__: true,
        __error__: "empty_output"
      };
    }

    return JSON.parse(content);
  } catch (err) {
    console.log("AI extract error:", err);
    return {
      __ai_failed__: true,
      __error__: String(err)
    };
  }
}

// =========================
// Post-processing
// =========================
function cleanAIResult(aiData, rawText = "", cleanText = "") {
  if (!aiData || typeof aiData !== "object") return null;
  if (aiData.__ai_failed__) return null;

  const hints = buildHeuristicHints(rawText, cleanText);

  let title = cleanJobTitle(aiData.title || "");
  let company = cleanupCompanyName(aiData.company || "");
  let location = toNullableString(aiData.location);
  let employment_type = toNullableString(aiData.employment_type);
  let experience = toNullableString(aiData.experience);
  let salary = toNullableString(aiData.salary);
  let contact = toNullableString(aiData.contact);
  let application_method = toNullableString(aiData.application_method);
  let category = toNullableString(aiData.category);
  let summary = toNullableString(aiData.summary);
  let is_multi_role = Boolean(aiData.is_multi_role);
  let confidence = Number(aiData.confidence);

  if (!isGoodTitle(title)) {
    title = isGoodTitle(hints.title_hint) ? hints.title_hint : "غير مذكور";
  }

  if (company === "غير مذكور") {
    company = hints.company_hint;
  }

  if (location === "غير مذكور") {
    location = hints.location_hint;
  }

  if (employment_type === "غير مذكور") {
    employment_type = hints.employment_type_hint;
  }

  if (experience === "غير مذكور") {
    experience = hints.experience_hint;
  }

  if (contact === "غير مذكور" || !hasAnyContact(contact)) {
    contact = hints.contact_hint;
  }

  if (salary === "غير مذكور" || !isLikelySalaryValue(salary)) {
    salary = isLikelySalaryValue(hints.salary_hint) ? hints.salary_hint : "غير مذكور";
  }

  if (application_method === "غير مذكور") {
    application_method = hints.application_method_hint;
  }

  if (!category || category === "غير مذكور") {
    category = hints.category_hint;
  }

  if (title !== "غير مذكور" && company !== "غير مذكور") {
    const t = normalizeInline(title).toLowerCase();
    const c = normalizeInline(company).toLowerCase();

    if (t === c) {
      if (isGoodTitle(hints.title_hint) && normalizeInline(hints.title_hint).toLowerCase() !== c) {
        title = hints.title_hint;
      } else {
        company = "غير مذكور";
      }
    }
  }

  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  if (summary === "غير مذكور" || summary.length > 220) {
    summary = `إعلان لوظيفة ${title !== "غير مذكور" ? title : "غير محددة"}${company !== "غير مذكور" ? ` لدى ${company}` : ""}${location !== "غير مذكور" ? ` في ${location}` : ""}.`;
  }

  return {
    title,
    category,
    company,
    location,
    employment_type,
    experience,
    salary,
    contact,
    application_method,
    is_multi_role,
    confidence,
    summary
  };
}

function validateResult(result, rawText = "", cleanText = "") {
  const issues = [];
  let score = 0;

  const text = cleanText || rawText;

  if (result?.title && result.title !== "غير مذكور" && isGoodTitle(result.title)) {
    score += 25;
  } else {
    issues.push("missing_title");
  }

  if (result?.category && result.category !== "غير مذكور") {
    score += 15;
  } else {
    issues.push("missing_category");
  }

  if (result?.contact && result.contact !== "غير مذكور") {
    score += 20;
  } else {
    issues.push("missing_contact");
  }

  if (result?.application_method && result.application_method !== "غير مذكور") {
    score += 10;
  } else {
    issues.push("missing_application_method");
  }

  if (result?.company && result.company !== "غير مذكور") {
    score += 10;
  }

  if (result?.location && result.location !== "غير مذكور") {
    score += 5;
  }

  if (result?.salary && result.salary !== "غير مذكور") {
    if (isLikelySalaryValue(result.salary)) {
      score += 5;
    } else {
      issues.push("bad_salary");
      score -= 10;
    }
  }

  if (typeof result?.confidence === "number") {
    if (result.confidence >= 0.9) score += 15;
    else if (result.confidence >= 0.8) score += 12;
    else if (result.confidence >= 0.7) score += 9;
    else if (result.confidence >= 0.6) score += 6;
    else if (result.confidence >= 0.5) score += 3;
    else issues.push("low_confidence");
  } else {
    issues.push("missing_confidence");
  }

  if (result?.is_multi_role) {
    issues.push("multi_role");
    score -= 20;
  }

  if (result?.title && result?.company && result.title !== "غير مذكور" && result.company !== "غير مذكور") {
    if (normalizeInline(result.title).toLowerCase() === normalizeInline(result.company).toLowerCase()) {
      issues.push("title_equals_company");
      score -= 15;
    }
  }

  if (result?.contact === "غير مذكور" && hasAnyContact(text)) {
    issues.push("contact_extraction_missed");
    score -= 15;
  }

  if (result?.salary !== "غير مذكور" && extractPhones(result.salary).length > 0) {
    issues.push("salary_looks_like_phone");
    score -= 20;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    is_valid: score >= REVIEW_MIN_SCORE,
    score,
    issues
  };
}

function decideStrict(validated) {
  const { score, issues } = validated;

  const hardBlocks = [
    "multi_role",
    "title_equals_company",
    "salary_looks_like_phone"
  ];

  if (
    score >= AUTO_PUBLISH_MIN_SCORE &&
    !issues.some(x => hardBlocks.includes(x))
  ) {
    return {
      bucket: "QUDRAT",
      reason: "high_confidence"
    };
  }

  return {
    bucket: "REVIEW",
    reason: issues.length ? issues.join(",") : "needs_review"
  };
}

function translateReviewReason(reason = "") {
  const map = {
    missing_title: "المسمى الوظيفي غير واضح أو غير موجود",
    missing_category: "التصنيف غير واضح",
    missing_contact: "معلومات التواصل غير موجودة",
    missing_application_method: "طريقة التقديم غير واضحة",
    low_confidence: "درجة الثقة منخفضة",
    multi_role: "الإعلان يحتوي أكثر من وظيفة",
    title_equals_company: "المسمى الوظيفي يبدو مطابقًا لاسم الشركة بشكل غير صحيح",
    contact_extraction_missed: "يوجد تواصل في النص لكن لم يتم استخراجه بشكل صحيح",
    bad_salary: "حقل الراتب غير واضح أو غير صحيح",
    salary_looks_like_phone: "قيمة الراتب تبدو كأنها رقم هاتف",
    ai_failed: "فشل التحليل الآلي",
    publish_send_failed: "فشل إرسال الإعلان إلى كروب النشر",
    review_send_failed: "فشل إرسال الإعلان إلى كروب المراجعة"
  };

  return reason
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => {
      const key = x.startsWith("publish_send_failed") ? "publish_send_failed"
        : x.startsWith("review_send_failed") ? "review_send_failed"
        : x;
      return `- ${map[key] || x}`;
    })
    .join("\n");
}

function buildPublishedText(result, rawText, jobId) {
  return `📌 فرصة عمل  |  🆔 ${jobId}

🔹 المسمى الوظيفي: ${result.title}
🔹 المجال: ${result.category}
🔹 اسم الشركة: ${result.company}
🔹 الموقع: ${result.location}
🔹 نوع العمل: ${result.employment_type}
🔹 الخبرة المطلوبة: ${result.experience}
🔹 الراتب: ${result.salary}
🔹 طريقة التقديم: ${result.application_method}
🔹 التواصل: ${result.contact}

──────────────
📝 ملخص:
${result.summary}

──────────────
📄 النص الأصلي:
${rawText}`;
}

function buildReviewText(reason, rawText, cleanText, aiResult, validation) {
  return `📋 إعلان بحاجة مراجعة

سبب التحويل:
${translateReviewReason(reason)}

──────────────
📊 Score: ${validation?.score ?? 0}/100
⚠️ Issues: ${validation?.issues?.join(" | ") || "لا يوجد"}

──────────────
🤖 نتيجة التحليل:
${JSON.stringify(aiResult, null, 2)}

──────────────
🧹 النص بعد التنظيف:
${cleanText}

──────────────
📄 النص الأصلي:
${rawText}`;
}

// =========================
// Routing helpers
// =========================
function insertReviewRow(rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason) {
  db.prepare(`
    INSERT INTO ads_review (
      raw_ad_id, hash, raw_text, clean_text, ai_output_json, final_output_json, review_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    rawAdId,
    hash,
    rawText,
    cleanText,
    JSON.stringify(aiData || null),
    JSON.stringify(finalResult || null),
    reviewReason
  );
}

async function sendToReview({
  rawAdId,
  hash,
  rawText,
  cleanText,
  aiData,
  finalResult,
  reviewReason,
  validation
}) {
  const finalText = buildReviewText(reviewReason, rawText, cleanText, finalResult || aiData || null, validation || { score: 0, issues: [] });

  const tgRes = await tg("sendMessage", {
    chat_id: REVIEW_CHAT_ID,
    text: finalText
  });

  console.log("REVIEW TG RESPONSE:", JSON.stringify(tgRes, null, 2));

  insertReviewRow(rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason);

  if (!tgRes?.ok) {
    console.log("Review send failed:", tgRes);
  }

  return tgRes;
}

// =========================
// Webhook
// =========================
app.post("/webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body || {};
    const msg = update.message || update.channel_post;
    if (!msg) {
      console.log("No message in update");
      return;
    }

    const chatId = Number(msg.chat?.id || 0);
    const rawText = normalizeText(msg.text || msg.caption || "");

    if (!rawText) return;
    if (chatId !== INBOX_CHAT_ID) return;

    const cleanText = cleanTelegramAd(rawText);
    const hash = sha256(cleanText);

    const exists = db.prepare(`
      SELECT id FROM ads_raw
      WHERE hash = ?
        AND created_at >= datetime('now', '-7 days')
      LIMIT 1
    `).get(hash);

    if (exists) {
      console.log("Duplicate ad skipped");
      return;
    }

    const insertRawResult = db.prepare(`
      INSERT INTO ads_raw (hash, raw_text, clean_text, source_chat_id, source_message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash, rawText, cleanText, String(chatId), String(msg.message_id || ""));

    const rawAdId = insertRawResult.lastInsertRowid;

    console.log("CONFIG:", { INBOX_CHAT_ID, REVIEW_CHAT_ID, QUDRAT_CHAT_ID, MODEL_NAME });
    console.log("/webhook HIT", new Date().toISOString());
    console.log("STEP 1 RAW SAVED:", { rawAdId, preview: normalizeInline(cleanText).slice(0, 160) });

    const aiData = await extractWithAI(rawText, cleanText);
    console.log("STEP 2 AI DATA:", aiData);

    const finalResult = cleanAIResult(aiData, rawText, cleanText);
    console.log("STEP 3 FINAL RESULT:", finalResult);

    db.prepare(`
      UPDATE ads_raw
      SET ai_output_json = ?, final_output_json = ?, extract_status = ?
      WHERE id = ?
    `).run(
      JSON.stringify(aiData || null),
      JSON.stringify(finalResult || null),
      finalResult ? "done" : "failed",
      rawAdId
    );

    if (!finalResult) {
      await sendToReview({
        rawAdId,
        hash,
        rawText,
        cleanText,
        aiData,
        finalResult: null,
        reviewReason: "ai_failed",
        validation: { score: 0, issues: ["ai_failed"] }
      });
      return;
    }

    const validation = validateResult(finalResult, rawText, cleanText);
    console.log("STEP 4 VALIDATION:", validation);

    const decision = decideStrict(validation);
    console.log("STEP 5 DECISION:", decision);

    const targetChatId = decision.bucket === "QUDRAT" ? QUDRAT_CHAT_ID : REVIEW_CHAT_ID;

    if (decision.bucket === "QUDRAT") {
      const jobId = generateJobId();
      const finalText = buildPublishedText(finalResult, rawText, jobId);

      const tgRes = await tg("sendMessage", {
        chat_id: targetChatId,
        text: finalText
      });

      console.log("PUBLISH TG RESPONSE:", JSON.stringify(tgRes, null, 2));

      if (!tgRes?.ok) {
        const failReason = `publish_send_failed:${tgRes?.description || "unknown_telegram_error"}`;

        await sendToReview({
          rawAdId,
          hash,
          rawText,
          cleanText,
          aiData,
          finalResult,
          reviewReason: failReason,
          validation
        });
        return;
      }

      db.prepare(`
        INSERT INTO ads_published (
          job_id, raw_ad_id, hash, title, category, company, location, salary, contact,
          application_method, confidence, raw_text, clean_text,
          qudrat_chat_id, qudrat_message_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        rawAdId,
        hash,
        finalResult.title || "غير مذكور",
        finalResult.category || "Other",
        finalResult.company || "غير مذكور",
        finalResult.location || "غير مذكور",
        finalResult.salary || "غير مذكور",
        finalResult.contact || "غير مذكور",
        finalResult.application_method || "غير مذكور",
        Number(finalResult.confidence || 0),
        rawText,
        cleanText,
        String(QUDRAT_CHAT_ID),
        String(tgRes?.result?.message_id || "")
      );

      console.log("PUBLISHED OK:", { rawAdId, jobId, messageId: tgRes?.result?.message_id || null });
    } else {
      await sendToReview({
        rawAdId,
        hash,
        rawText,
        cleanText,
        aiData,
        finalResult,
        reviewReason: decision.reason || "needs_review",
        validation
      });
    }
  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

// =========================
// Health
// =========================
app.get("/", (_req, res) => {
  res.status(200).send("Bot is running");
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log("Server running on port", PORT));
