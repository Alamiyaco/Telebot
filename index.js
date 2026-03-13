import express from "express";

import Database from "better-sqlite3";
import crypto from "crypto";
const db = new Database("jobs_v3.db");

db.exec(`
CREATE TABLE IF NOT EXISTS ads_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT,
  raw_text TEXT NOT NULL,
  source_chat_id TEXT,
  source_message_id TEXT,
  ai_output_json TEXT,
  extract_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ads_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_ad_id INTEGER,
  hash TEXT,
  raw_text TEXT NOT NULL,
  ai_output_json TEXT,
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
  salary TEXT,
  contact TEXT,
  raw_text TEXT NOT NULL,
  qudrat_chat_id TEXT,
  qudrat_message_id TEXT,
  website_status TEXT DEFAULT 'pending',
  published_at TEXT DEFAULT (datetime('now'))
);
`);;

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const INBOX_CHAT_ID = Number(process.env.INBOX_CHAT_ID || 0);
const REVIEW_CHAT_ID = Number(process.env.REVIEW_CHAT_ID || 0);
const QUDRAT_CHAT_ID = Number(process.env.QUDRAT_CHAT_ID || 0);
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL_NAME = (process.env.MODEL_NAME || "deepseek/deepseek-chat-v3-0324:free").trim();
function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

mustEnv("BOT_TOKEN", BOT_TOKEN);
mustEnv("INBOX_CHAT_ID", INBOX_CHAT_ID);
mustEnv("REVIEW_CHAT_ID", REVIEW_CHAT_ID);
mustEnv("QUDRAT_CHAT_ID", QUDRAT_CHAT_ID);

// ===== Telegram caller =====
async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });

  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.log("TG error:", json);
  return json;
}

// ===== Helpers =====

// تصنيف بسيط مؤقت (بعدها نطوره)
// - إذا بيه ايميل/واتساب/هاتف => نعتبره واضح ويروح QUDRAT
// - غير واضح => REVIEW
function classifyJob(text) {
  const t = text.toLowerCase();

  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
  const hasPhone = /(\+?\d[\d\s\-()]{7,}\d)/.test(text);
  const hasWhats = t.includes("whatsapp") || t.includes("واتساب");

  if (hasEmail || hasPhone || hasWhats) return { bucket: "QUDRAT", reason: "has contact" };
  return { bucket: "REVIEW", reason: "missing contact" };
}

function formatForSend(originalText, decision) {
  return `🔎 Auto Sort: ${decision.bucket} (${decision.reason})\n\n${originalText}`;
}

// ===== Health check =====
app.get("/", (req, res) => res.status(200).send("ok"));
// ===== Strict Validation Logic =====

// normalizeText
function normalizeText(s = "") {
  return (s || "")
    .replace(/\u200f|\u200e|\u202a|\u202b|\u202c/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCompany(text) {
  const t = normalizeText(text);
  const re = /(?:^|\n|\s)(?:شركة|شركه|مجموعة شركات|مجموعة|مؤسسة|مصنع|معمل|مجمع|مكتب)\s+([^\n\-–—|]{3,60})/i;
  const m = t.match(re);
  if (!m) return null;
  return (m[1] || "").trim();
}

function extractJobTitle(text) {
  const t = normalizeText(text);

  const re1 = /(?:عنوان\s*الوظيف(?:ة|ي)\s*[:：]\s*)([^\n\-–—|]{3,80})/i;
  const m1 = t.match(re1);
  if (m1) return m1[1].trim();

  const re2 = /(?:مطلوب|فرصة عمل|وظيفة شاغرة|نبحث عن|Hiring|Position|Job Title)\s*[:：\-–—]?\s*([^\n]{3,80})/i;
  const m2 = t.match(re2);
  if (m2) return m2[1].trim();

  return null;
}

function hasContact(text) {
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const phone = /(?:\+?\d[\d\s\-]{7,}\d)/;
  const link  = /(https?:\/\/\S+|t\.me\/\S+)/i;
  return email.test(text) || phone.test(text) || link.test(text);
}

function hasSalary(text) {
  const salaryWord = /(راتب|Salary|أجر)/i;
  const number = /(\d{1,3}(?:[,\.\s]\d{3})+|\d{5,})/;
  return salaryWord.test(text) && number.test(text);
}

function decideStrict(text) {
  const company = extractCompany(text);
  const title =
  (normalizeText(text).match(/مطلوب\s+([^\n]{3,80})/i)?.[1]?.trim()) ||
  (normalizeText(text).match(/مطلوبة\s+([^\n]{3,80})/i)?.[1]?.trim()) ||
  (normalizeText(text).match(/نبحث عن\s+([^\n]{3,80})/i)?.[1]?.trim()) ||
  extractJobTitle(text) ||
  "غير مذكور";
  const contact = hasContact(text);
  const salary  = hasSalary(text);

  const missing = [];
  if (!company) missing.push("company");
  if (!title)   missing.push("job_title");
  if (!contact) missing.push("contact");
  if (!salary)  missing.push("salary");

  if (missing.length === 0) {
    return { bucket: "QUDRAT", reason: "all_4_ok" };
  }

  return { bucket: "REVIEW", reason: "missing: " + missing.join(", ") };
}
function stripEmojis(s = "") {
  return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
}

function cleanTitle(raw = "") {
  let t = stripEmojis(normalizeText(raw));
  t = t.replace(/^(مطلوب|مطلوبة|فرصة عمل|وظيفة شاغرة|نبحث عن|تعلن)\s*/i, "");
  t = t.replace(/(في|لدى|ضمن|بـ|على)\s+.*$/i, "");
  t = t.replace(/[|،\-–—].*$/i, "");
  return t.trim() || "غير مذكور";
}

function firstLine(text = "") {
  return normalizeText(text).split("\n")[0] || normalizeText(text);
}

function smartTitleFromText(raw = "") {
  const clean = (s) => cleanJobTitle(s);

  const r = (raw || "")
    .replace(/\[\d{1,2}\/\d{1,2}\/\d{4}[^\]]*\]/g, "")
    .replace(/Jobs4us\|?/gi, "")
    .trim();

  const lines = r.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  {
    const first = lines[0] || "";
    const m = first.match(/:\s*(.+)$/);
    if (m && m[1]) {
      const candidate = m[1]
        .replace(/–.*$/g, "")
        .replace(/\|.*$/g, "")
        .trim();
      const t = clean(candidate);
      if (isGoodTitle(t)) return t;
    }
  }

  {
    const m = r.match(/العنوان\s*الوظيفي\s*\(([^)]+)\)/i) || r.match(/\(([^)]+)\)/);
    if (m && m[1]) {
      const t = clean(m[1].replace(/[،,]/g, " / ").replace(/\s+/g, " "));
      if (isGoodTitle(t)) return t;
    }
  }

  for (const line of lines.slice(0, 12)) {
    const m = line.match(/^(?:🚹|🚺|🛑|🔥|📌|\s)*\s*(?:مطلوب|مطلوبة|نبحث عن)\s+(.+)$/i);
    if (m && m[1]) {
      const t = clean(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  {
    const m = r.match(/بصفة\s+وظيفية\s+([^\n\r]{2,80})/i);
    if (m && m[1]) {
      const t = clean(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  {
    const m = r.match(/(?:عن حاجت(?:ه|ها)\s*إلى|بحاجت(?:ه|ها)\s*إلى)\s+(.+)/i);
    if (m && m[1]) {
      const t = clean(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  for (const line of lines.slice(0, 10)) {
    if (/(شركة|يعلن|تعلن|الموقع|العنوان|الراتب|الدوام|التقديم|للتواصل|واتساب|CV|ايميل)/i.test(line)) continue;

    const t = clean(line);
    if (isGoodTitle(t) && t.length <= 40) return t;
  }

  {
    const picks = [];
    for (const line of lines) {
      const mm = line.match(/^([^\d]{2,40})\s+(?:راتب|الراتب)\s*\d+/i);
      if (mm && mm[1]) {
        const t = clean(mm[1]);
        if (isGoodTitle(t)) picks.push(t);
      }
    }
    if (picks.length) return [...new Set(picks)].join(" / ");
  }

  const roles = [
    "Field Sales Representative","Sales Representative","Account Manager","Customer Service",
    "مندوب مبيعات ميداني","مندوب مبيعات","محاسب","حسابات","كاشير","استقبال","كابتن",
    "سوشيال ميديا","كول سنتر","مدير صفحات","تسويق محتوى","مهندس تنفيذ جسور","مهندس مدني","قصّاب",
    "منسق بضائع","عامل","بريسيل"
  ];

  for (const rr of roles) {
    if (new RegExp(rr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(r)) {
      if (/حسابات/i.test(rr)) return "حسابات";
      return rr;
    }
  }

  return "غير مذكور";
}

function isGoodTitle(t = "") {
  if (!t) return false;
  if (/^(?:غير مذكور|موظف|موظفة|موظفين|موظفات|ذكور|إناث|للجنسين)$/i.test(t)) return false;
  if (/(تعلن|يعلن|شركة|مصنع|مطعم|معرض|عن توفر|فرصة عمل)/i.test(t) && t.length > 35) return false;
  return true;
}

function cleanJobTitle(s = "") {
  let x = normalizeText(s);

  x = x.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
  x = x.replace(/\b(موظفين|موظفات|موظف|موظفة|ذكور|إناث|للجنسين)\b/gi, "").trim();

  x = x.replace(/\s+(?:تعلن|شركة|مصنع|معرض|الراتب|الدوام|الموقع|العنوان|التواصل|واتساب|تفاصيل|الشروط)\b.*$/i, "");
  x = x.replace(/[|،\-–—].*$/i, "").trim();

  return x || "غير مذكور";
}

function smartSalary(raw = "") {
  const m = raw.match(/(?:الراتب|راتب)\s*[:：\-–—]?\s*([^\n\r]{2,80})/i);
  return m ? normalizeText(m[1]) : "غير مذكور";
}

function smartContact(raw = "") {
  const phones = raw.match(/\+?\d[\d\s\-]{7,}\d/g) || [];
  const emails = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];

  const list = [...new Set([...phones, ...emails])].map(x => normalizeText(x));
  return list.length ? list.join(" | ") : "غير مذكور";
}


async function extractWithAI(text) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          {
            role: "system",
            content: `
انت نظام متخصص في تحليل إعلانات الوظائف.

المطلوب استخراج المعلومات التالية فقط:
- title
- company
- salary
- contact
- category

قواعد مهمة:
1- المسمى الوظيفي يجب أن يكون وظيفة حقيقية مثل:
مندوب مبيعات
محاسب
موظف استقبال
فني صيانة
موظفة مبيعات

2- لا تعتبر الكلمات التالية مسمى وظيفي:
الوظائف التالية
فرصة عمل
وظيفة
مطلوب
WhatsApp
واتساب
تحدث
كتابة

3- إذا كان الإعلان يحتوي عدة وظائف اختر أول وظيفة مذكورة.
4- إذا لم تجد مسمى وظيفي واضح ضع "غير مذكور".
5- إذا لم تجد أي قيمة لأي حقل ضع "غير مذكور".

أرجع النتيجة بصيغة JSON فقط وبدون أي شرح إضافي.
`
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.1
      })
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "{}";

    return JSON.parse(content);
  } catch (err) {
    console.log("AI extract error:", err);
    return null;
  }
}
const BAD_TITLES = [
  "whatsapp",
  "واتساب",
  "تحدث",
  "كتابة",
  "تحدث وكتابة",
  "فرصة عمل",
  "وظيفة",
  "للتواصل",
  "ايميل",
  "البريد",
  "الرقم"
];

function cleanAIResult(aiData, rawText = "") {
  if (!aiData || typeof aiData !== "object") return null;

  let title = String(aiData.title || "").trim();
  let company = String(aiData.company || "").trim();
  let salary = String(aiData.salary || "").trim();
  let contact = String(aiData.contact || "").trim();
  let category = String(aiData.category || "").trim();

  const lowerTitle = title.toLowerCase();

  if (
    !title ||
    BAD_TITLES.includes(lowerTitle) ||
    /^(whatsapp|واتساب|تحدث|كتابة|تحدث وكتابة|فرصة عمل|وظيفة)$/i.test(title)
  ) {
    title = "غير مذكور";
  }

  if (/(واتساب|whatsapp|للتواصل|الاتصال|الرقم|ايميل|email)/i.test(company)) {
    company = "غير مذكور";
  }

  if (!contact || contact === "غير مذكور") {
    contact = smartContact(rawText);
  }

  if (!salary) {
    salary = "غير مذكور";
  }

  if (!category) {
    category = "غير مذكور";
  }

  return { title, company, salary, contact, category };
}
// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body || {};
    const msg = update.message || update.channel_post;
    if (!msg) {
      console.log("ℹ️ No message in update");
      return;
    }

const chatId = msg.chat?.id;
const rawText = (msg.text || msg.caption || "").trim();

if (!rawText) return;

// ✅ نشتغل فقط على كروب الـIndex
if (chatId !== INBOX_CHAT_ID) return;

const hash = crypto
  .createHash("sha256")
  .update(rawText)
  .digest("hex");

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

db.prepare(`
  INSERT INTO ads_raw (hash, raw_text, source_chat_id, source_message_id)
  VALUES (?, ?, ?, ?)
`).run(hash, rawText, String(chatId), String(msg.message_id || ""));

    const text = normalizeText(rawText);

    console.log("CONFIG:", { INBOX_CHAT_ID, REVIEW_CHAT_ID, QUDRAT_CHAT_ID });
    console.log("✅ /webhook HIT", new Date().toISOString());
    console.log("✅ msg:", { chatId, preview: text.slice(0, 120) });

    if (chatId !== INBOX_CHAT_ID) return;
    const aiData = await extractWithAI(rawText);
    const cleanedAI = cleanAIResult(aiData, rawText);
    console.log("CLEANED AI:", cleanedAI);
    console.log("AI DATA:", aiData);
    const decision = decideStrict(text);
    const targetChatId = decision.bucket === "QUDRAT"
      ? QUDRAT_CHAT_ID
      : REVIEW_CHAT_ID;

    console.log("decision:", decision, "target:", targetChatId);

    let finalText = text;

    if (decision.bucket === "QUDRAT") {

const company = cleanedAI?.company && cleanedAI.company !== "غير مذكور"
  ? cleanedAI.company
  : ((extractCompany(rawText) || "غير مذكور").replace(/[|،\-–—].*$/i, "").trim());

const salary = cleanedAI?.salary && cleanedAI.salary !== "غير مذكور"
  ? cleanedAI.salary
  : smartSalary(rawText);

const contact = cleanedAI?.contact && cleanedAI.contact !== "غير مذكور"
  ? cleanedAI.contact
  : smartContact(rawText);

      finalText = `📌 فرصة عمل

المسمى الوظيفي: ${title}
اسم الشركة: ${company}
الراتب: ${salary}
طريقة التواصل: ${contact}

──────────────

التفاصيل:
${rawText}`;
    } else {
      finalText = rawText;
    }

    await tg("sendMessage", {
      chat_id: targetChatId,
      text: finalText,
    });
  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

// ✅ Render لازم يسمع على PORT
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log("Server running on port", PORT));
