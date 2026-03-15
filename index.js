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

// اجعل الافتراضي gpt-4.2 بدل gpt-4o-mini
const MODEL_NAME = (process.env.MODEL_NAME || "gpt-4.2").trim();

// حدود القرار
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
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });

  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.log("TG error:", json);
  return json;
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInline(s = "") {
  return normalizeText(s).replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function stripEmojis(s = "") {
  return String(s).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
}

function cleanTelegramAd(raw = "") {
  let x = normalizeText(raw);

  x = stripEmojis(x);

  // إزالة زخارف شائعة
  x = x
    .replace(/[•●▪■◆◇★☆✅☑✔✳✴❇❗❕❗️]+/g, " ")
    .replace(/[═─—–]{2,}/g, "\n")
    .replace(/[📌📍📢📣💼🔥⭐]+/gu, " ");

  // توحيد بعض العبارات
  x = x
    .replace(/\bواتس(?:اب)?\b/gi, "واتساب")
    .replace(/\bwhats\s*app\b/gi, "WhatsApp")
    .replace(/\bhr\b/gi, "HR")
    .replace(/\bcv\b/gi, "CV");

  // حذف تكرارات مزعجة
  x = x
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+\n/g, "\n\n");

  return x.trim();
}

function sha256(s = "") {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

function extractPhones(text = "") {
  const matches = normalizeText(text).match(/\+?\d[\d\s\-]{7,}\d/g) || [];
  return unique(matches.map(x => normalizeInline(x)));
}

function extractEmails(text = "") {
  const matches = normalizeText(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  return unique(matches.map(x => normalizeInline(x)));
}

function extractLinks(text = "") {
  const matches = normalizeText(text).match(/https?:\/\/\S+|t\.me\/\S+/ig) || [];
  return unique(matches.map(x => normalizeInline(x)));
}

function hasAnyContact(text = "") {
  return extractPhones(text).length > 0 || extractEmails(text).length > 0 || extractLinks(text).length > 0;
}

function isLikelyPhone(s = "") {
  const x = normalizeInline(s);
  return /^(?:\+?\d[\d\s\-]{7,}\d)$/.test(x);
}

function isLikelyEmail(s = "") {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(normalizeInline(s));
}

function isLikelySalaryValue(s = "") {
  const x = normalizeInline(s);
  if (!x || x === "غير مذكور") return false;
  if (isLikelyPhone(x) || isLikelyEmail(x)) return false;
  if (/(واتساب|whatsapp|gmail|yahoo|outlook|cv|@|telegram|t\.me)/i.test(x)) return false;
  return /(\d{1,3}(?:[,\.\s]\d{3})+|\d{5,})/.test(x) || /(دينار|دولار|\$|IQD|USD)/i.test(x);
}

function cleanupCompanyName(s = "") {
  let x = normalizeInline(s);
  x = stripEmojis(x);
  x = x.replace(/^(?:اسم الشركة|الشركة)\s*[:：]\s*/i, "").trim();
  x = x.replace(/^(?:تعلن|يعلن)\s+/i, "").trim();
  x = x.replace(/(عن حاجتها|بحاجتها|لتعيين|لتوظيف|تطلب|المطلوب|الراتب|التواصل|واتساب|طريقة التواصل).*$/i, "").trim();
  x = x.replace(/[|]/g, " ").trim();
  x = x.replace(/\s{2,}/g, " ").trim();

  if (!x) return "غير مذكور";
  if (isLikelyPhone(x) || isLikelyEmail(x)) return "غير مذكور";
  if (x.length > 80) return "غير مذكور";
  return x;
}

function extractCompany(text = "") {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n").map(x => x.trim()).filter(Boolean);

  let m = normalized.match(/(?:تعلن|يعلن)\s+(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب|مكتبة|مركز|أسواق)\s+([^\n]{2,80})/i);
  if (m) {
    const c = cleanupCompanyName(`${m[1]} ${m[2]}`);
    if (c !== "غير مذكور") return c;
  }

  for (const line of lines.slice(0, 10)) {
    m = line.match(/^(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب|مكتبة|مركز|أسواق)\s+([^\n]{2,80})/i);
    if (m) {
      const c = cleanupCompanyName(`${m[1]} ${m[2]}`);
      if (c !== "غير مذكور") return c;
    }
  }

  for (const line of lines.slice(0, 12)) {
    m = line.match(/^(?:اسم الشركة|الشركة)\s*[:：]\s*(.+)$/i);
    if (m && m[1]) {
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
  "الرقم"
];

function isBadGenericTitle(x = "") {
  return BAD_TITLES.includes(normalizeInline(x).toLowerCase());
}

function cleanJobTitle(s = "") {
  let x = normalizeInline(s);
  x = stripEmojis(x);
  x = x.replace(/^(مطلوب|مطلوبة|نبحث عن|فرصة عمل|وظيفة شاغرة|بحاجة الى|بحاجة إلى|Hiring|Position)\s+/i, "").trim();
  x = x.replace(/\b(ذكور|إناث|للجنسين)\b/gi, "").trim();
  x = x.replace(/\s+(?:في|للعمل في|للعمل لدى|داخل|ضمن)\s+(شركة|مطعم|معهد|وكالة|مؤسسة|مكتب|معمل|مصنع|مكتبة|مركز|أسواق).*/i, "").trim();
  x = x.replace(/\s+(?:براتب|راتب|الراتب|الدوام|الموقع|العنوان|التواصل|واتساب|تفاصيل|الشروط)\b.*$/i, "").trim();
  x = x.replace(/[|:\-–—].*$/i, "").trim();
  x = x.replace(/\s{2,}/g, " ").trim();

  if (!x || isBadGenericTitle(x)) return "غير مذكور";
  return x;
}

function isGoodTitle(t = "") {
  const x = normalizeInline(t).toLowerCase();
  if (!x) return false;
  if (isBadGenericTitle(x)) return false;
  if (x.length < 2 || x.length > 60) return false;
  if (/(واتساب|whatsapp|للتواصل|اتصال|هاتف|رقم|ايميل|email)/i.test(x)) return false;
  if (/(راتب|الراتب|الدوام|الموقع|العنوان|الشركة|تفاصيل|التقديم)/i.test(x)) return false;
  return true;
}

function extractJobTitle(text = "") {
  const lines = normalizeText(text).split("\n").map(x => x.trim()).filter(Boolean);

  for (const line of lines.slice(0, 12)) {
    let m = line.match(/^(?:عنوان\s*الوظيف(?:ة|ي)|المسمى الوظيفي|العنوان الوظيفي|Job Title)\s*[:：]\s*(.+)$/i);
    if (m && m[1]) return cleanJobTitle(m[1]);

    m = line.match(/^(?:مطلوب|مطلوبة|فرصة عمل|وظيفة شاغرة|نبحث عن|بحاجة الى|بحاجة إلى|Hiring|Position)\s*[:：\-–—]?\s*(.+)$/i);
    if (m && m[1]) {
      const t = cleanJobTitle(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  return "غير مذكور";
}

function smartContact(text = "") {
  const phones = extractPhones(text);
  const emails = extractEmails(text);
  const links = extractLinks(text);
  const list = unique([...phones, ...emails, ...links]);
  return list.length ? list.join(" | ") : "غير مذكور";
}

function smartSalary(text = "") {
  const lines = normalizeText(text).split("\n").map(x => x.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/(?:الراتب|راتب|الأجر|الاجر|salary)\s*[:：\-–—]?\s*([^\n\r]{2,100})/i);
    if (m?.[1]) {
      const value = normalizeInline(m[1]);
      if (isLikelySalaryValue(value)) return value;
    }
  }

  return "غير مذكور";
}

function inferApplicationMethod(text = "", contact = "") {
  const full = `${text}\n${contact}`;
  if (/واتساب|whatsapp/i.test(full)) return "واتساب";
  if (/email|e-mail|gmail|outlook|yahoo|ارس(?:ال)?\s*CV|إرسال\s*CV/i.test(full)) return "إيميل / إرسال CV";
  if (/t\.me|telegram/i.test(full)) return "تيليجرام";
  if (extractPhones(full).length > 0) return "هاتف / رقم مباشر";
  if (extractEmails(full).length > 0) return "إيميل";
  return "غير مذكور";
}

function fallbackCategory(text = "", title = "") {
  const s = normalizeInline(`${title} ${text}`).toLowerCase();

  if (/(hr|human resources|موارد بشرية|توظيف|recruit)/i.test(s)) return "HR";
  if (/(admin|إداري|اداري|استقبال|سكرتير|سكرتارية|office)/i.test(s)) return "Admin";
  if (/(sales|مبيعات|مندوب|مندوبة|كاشير|cashier)/i.test(s)) return "Sales";
  if (/(customer service|خدمة عملاء|call center)/i.test(s)) return "Customer Service";
  if (/(account|محاسب|محاسبة|حسابات|finance|مالي)/i.test(s)) return "Accounting";
  if (/(engineer|مهندس|فني صيانة|maintenance)/i.test(s)) return "Engineering";
  if (/(developer|programmer|it|support|شبكات|تقنية|برمجة)/i.test(s)) return "IT";
  if (/(designer|تصميم|مصمم|جرافيك|مونتاج|سوشيال ميديا)/i.test(s)) return "Design";
  if (/(marketing|تسويق|مروج|مروجة)/i.test(s)) return "Marketing";
  if (/(driver|سائق|توصيل|لوجست)/i.test(s)) return "Logistics";
  if (/(طبي|صيدل|تمريض|مختبر|عيادة|مركز طبي)/i.test(s)) return "Medical";
  if (/(مدرس|تدريس|معهد|teacher|education)/i.test(s)) return "Education";

  return "Other";
}

function toNullableString(v) {
  if (v === null || v === undefined) return "غير مذكور";
  const x = normalizeInline(String(v));
  return x || "غير مذكور";
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

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        temperature: 0.1,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: `
أنت نظام احترافي لتحليل إعلانات الوظائف العربية غير المرتبة، خصوصاً إعلانات تيليجرام والسوق العراقي.

مهمتك:
قراءة الإعلان الخام والإعلان بعد التنظيف، ثم استخراج معلومات وظيفية دقيقة.

قواعد صارمة:
1) لا تخترع أي معلومة غير موجودة.
2) إذا كانت المعلومة غير موجودة اكتب "غير مذكور".
3) العنوان title يجب أن يكون اسم الوظيفة فقط، وليس جملة طويلة.
4) لا تضع اسم الشركة داخل title إلا إذا كان فعلاً هو اسم الوظيفة.
5) category يجب أن يكون من القائمة المسموحة فقط.
6) contact يجب أن يتضمن كل وسائل التواصل الموجودة بوضوح.
7) application_method يجب أن يكون مثل: واتساب / إيميل / هاتف / تيليجرام / غير مذكور.
8) إذا الإعلان يحتوي أكثر من وظيفة واضحة ضع is_multi_role = true.
9) confidence رقم من 0 إلى 1.
10) أعد JSON فقط.

أمثلة:

Example 1 input:
شركة بحاجة الى محاسب في بغداد خبرة سنتين للتقديم واتساب 07701234567

Example 1 output:
{
  "title": "محاسب",
  "category": "Accounting",
  "company": "غير مذكور",
  "location": "بغداد",
  "employment_type": "غير مذكور",
  "experience": "سنتين",
  "salary": "غير مذكور",
  "contact": "07701234567",
  "application_method": "واتساب",
  "is_multi_role": false,
  "confidence": 0.94,
  "summary": "وظيفة محاسب في بغداد بخبرة سنتين والتقديم عبر واتساب."
}

Example 2 input:
مطلوب موظفة استقبال في مركز طبي في الكرادة

Example 2 output:
{
  "title": "موظفة استقبال",
  "category": "Admin",
  "company": "مركز طبي",
  "location": "الكرادة",
  "employment_type": "غير مذكور",
  "experience": "غير مذكور",
  "salary": "غير مذكور",
  "contact": "غير مذكور",
  "application_method": "غير مذكور",
  "is_multi_role": false,
  "confidence": 0.86,
  "summary": "إعلان لوظيفة موظفة استقبال في مركز طبي في الكرادة."
}
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
                `.trim()
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "job_ad_extraction_v2",
            strict: true,
            schema
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.log("OpenAI API error:", data);
      return null;
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
      return null;
    }

    return JSON.parse(content);
  } catch (err) {
    console.log("AI extract error:", err);
    return null;
  }
}

// =========================
// Post-processing
// =========================
function cleanAIResult(aiData, rawText = "", cleanText = "") {
  if (!aiData || typeof aiData !== "object") return null;

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
    const fallbackTitle = extractJobTitle(cleanText) || extractJobTitle(rawText);
    title = isGoodTitle(fallbackTitle) ? fallbackTitle : "غير مذكور";
  }

  if (company === "غير مذكور") {
    company = extractCompany(cleanText || rawText);
  }

  if (contact === "غير مذكور" || !hasAnyContact(contact)) {
    contact = smartContact(cleanText || rawText);
  }

  if (salary === "غير مذكور" || !isLikelySalaryValue(salary)) {
    const fallbackSalary = smartSalary(cleanText || rawText);
    salary = isLikelySalaryValue(fallbackSalary) ? fallbackSalary : "غير مذكور";
  }

  if (application_method === "غير مذكور") {
    application_method = inferApplicationMethod(cleanText || rawText, contact);
  }

  if (!category || category === "غير مذكور") {
    category = fallbackCategory(cleanText || rawText, title);
  }

  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  if (summary === "غير مذكور") {
    summary = `إعلان لوظيفة ${title !== "غير مذكور" ? title : "غير محددة"}${company !== "غير مذكور" ? ` لدى ${company}` : ""}.`;
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

  score = Math.max(0, Math.min(100, score));

  return {
    is_valid: score >= REVIEW_MIN_SCORE,
    score,
    issues
  };
}

function decideStrict(validated) {
  const { score, issues } = validated;

  if (score >= AUTO_PUBLISH_MIN_SCORE && !issues.includes("multi_role") && !issues.includes("title_equals_company")) {
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
    contact_extraction_missed: "يوجد تواصل في النص لكن لم يتم استخراجه بشكل صحيح"
  };

  return reason
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => `- ${map[x] || x}`)
    .join("\n");
}

function buildPublishedText(result, rawText) {
  return `📌 فرصة عمل

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
📊 Score: ${validation.score}/100
⚠️ Issues: ${validation.issues.join(" | ") || "لا يوجد"}

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
    console.log("msg preview:", normalizeInline(cleanText).slice(0, 160));

    const aiData = await extractWithAI(rawText, cleanText);
    const finalResult = cleanAIResult(aiData, rawText, cleanText);

    console.log("AI DATA:", aiData);
    console.log("FINAL RESULT:", finalResult);

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
      const tgRes = await tg("sendMessage", {
        chat_id: REVIEW_CHAT_ID,
        text: `📋 إعلان بحاجة مراجعة\n\nسبب التحويل:\n- فشل التحليل الآلي\n\n──────────────\n${rawText}`
      });

      db.prepare(`
        INSERT INTO ads_review (raw_ad_id, hash, raw_text, clean_text, ai_output_json, final_output_json, review_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawAdId,
        hash,
        rawText,
        cleanText,
        JSON.stringify(aiData || null),
        JSON.stringify(finalResult || null),
        "AI failed"
      );

      console.log("SEND RESULT:", JSON.stringify(tgRes, null, 2));
      return;
    }

    const validation = validateResult(finalResult, rawText, cleanText);
    const decision = decideStrict(validation);
    const targetChatId = decision.bucket === "QUDRAT" ? QUDRAT_CHAT_ID : REVIEW_CHAT_ID;

    console.log("VALIDATION:", validation);
    console.log("DECISION:", decision);

    if (decision.bucket === "QUDRAT") {
      const finalText = buildPublishedText(finalResult, rawText);

      const tgRes = await tg("sendMessage", {
        chat_id: targetChatId,
        text: finalText
      });

      db.prepare(`
        INSERT INTO ads_published (
          raw_ad_id, hash, title, category, company, location, salary, contact,
          application_method, confidence, raw_text, clean_text,
          qudrat_chat_id, qudrat_message_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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

      console.log("PUBLISHED SEND RESULT:", JSON.stringify(tgRes, null, 2));
    } else {
      const reviewReason = decision.reason || "needs_review";
      const finalText = buildReviewText(reviewReason, rawText, cleanText, finalResult, validation);

      const tgRes = await tg("sendMessage", {
        chat_id: targetChatId,
        text: finalText
      });

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

      console.log("REVIEW SEND RESULT:", JSON.stringify(tgRes, null, 2));
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
