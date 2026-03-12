import express from "express";

import Database from "better-sqlite3";
import crypto from "crypto";
const db = new Database("jobs.db");
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 hash TEXT UNIQUE,
 raw_text TEXT,
 created_at TEXT DEFAULT (datetime('now'))
);
`);

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const INBOX_CHAT_ID = Number(process.env.INBOX_CHAT_ID || 0);
const REVIEW_CHAT_ID = Number(process.env.REVIEW_CHAT_ID || 0);
const QUDRAT_CHAT_ID = Number(process.env.QUDRAT_CHAT_ID || 0);

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
  t = t.replace(/(في|لدى|ضمن|بـ|على)\s+.*$/i, ""); // يوقف عند أول امتداد طويل
  t = t.replace(/[|،\-–—].*$/i, "");              // يقص بعد الفواصل
  return t.trim() || "غير مذكور";
}

function firstLine(text = "") {
  return normalizeText(text).split("\n")[0] || normalizeText(text);
}

function smartTitleFromText(raw = "") {
  const clean = (s) => cleanJobTitle(s);

  // نظف نصوص الواتساب/التاريخ وغيرها
  const r = (raw || "")
    .replace(/\[\d{1,2}\/\d{1,2}\/\d{4}[^\]]*\]/g, "") // [3/2/2026 13:44]
    .replace(/Jobs4us\|?/gi, "")
    .trim();

  const lines = r.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  // 0) عنوان داخل أول سطر بعد ":" مثل "لنا: مطلوب ... – بغداد | Field Sales Representative"
  {
    const first = lines[0] || "";
    const m = first.match(/:\s*(.+)$/);
    if (m && m[1]) {
      const candidate = m[1]
        .replace(/–.*$/g, "")     // قص بعد –
        .replace(/\|.*$/g, "")    // قص بعد |
        .trim();
      const t = clean(candidate);
      if (isGoodTitle(t)) return t;
    }
  }

  // 1) العنوان الوظيفي داخل قوس "(محاسب)" أو "(كاشير استقبال كابتن)"
  {
    const m = r.match(/العنوان\s*الوظيفي\s*\(([^)]+)\)/i) || r.match(/\(([^)]+)\)/);
    if (m && m[1]) {
      const t = clean(m[1].replace(/[،,]/g, " / ").replace(/\s+/g, " "));
      if (isGoodTitle(t)) return t;
    }
  }

  // 2) "مطلوب XXX" (ويكون XXX هو المسمى مباشرة)
  for (const line of lines.slice(0, 12)) {
    const m = line.match(/^(?:🚹|🚺|🛑|🔥|📌|\s)*\s*(?:مطلوب|مطلوبة|نبحث عن)\s+(.+)$/i);
    if (m && m[1]) {
      const t = clean(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  // 3) "بصفة وظيفية XXX"
  {
    const m = r.match(/بصفة\s+وظيفية\s+([^\n\r]{2,80})/i);
    if (m && m[1]) {
      const t = clean(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  // 4) "عن حاجته/بحاجتها إلى XXX"
  {
    const m = r.match(/(?:عن حاجت(?:ه|ها)\s*إلى|بحاجت(?:ه|ها)\s*إلى)\s+(.+)/i);
    if (m && m[1]) {
      const t = clean(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  // 5) إذا يوجد سطر عنوان مستقل قصير (مثل: "مهندس تنفيذ جسور" أو "مطلوب قصّاب")
  for (const line of lines.slice(0, 10)) {
    // تجاهل أسطر الشركة/الموقع/الراتب
    if (/(شركة|يعلن|تعلن|الموقع|العنوان|الراتب|الدوام|التقديم|للتواصل|واتساب|CV|ايميل)/i.test(line)) continue;

    const t = clean(line);
    if (isGoodTitle(t) && t.length <= 40) return t;
  }

  // 6) قائمة وظائف داخل الإعلان (منسق بضائع/عامل/كاشير)
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

  // 7) fallback: قاموس مسميات شائع (عربي + انكليزي)
  const roles = [
    "Field Sales Representative","Sales Representative","Account Manager","Customer Service",
    "مندوب مبيعات ميداني","مندوب مبيعات","محاسب","حسابات","كاشير","استقبال","كابتن",
    "سوشيال ميديا","كول سنتر","مدير صفحات","تسويق محتوى","مهندس تنفيذ جسور","مهندس مدني","قصّاب",
    "منسق بضائع","عامل","بريسيل"
  ];

  for (const rr of roles) {
    if (new RegExp(rr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(r)) {
      // توحيد بعض الكلمات
      if (/حسابات/i.test(rr)) return "حسابات";
      return rr;
    }
  }

  return "غير مذكور";
}

function isGoodTitle(t = "") {
  if (!t) return false;
  // ممنوع يكون بس جنس/موظف عام
  if (/^(?:غير مذكور|موظف|موظفة|موظفين|موظفات|ذكور|إناث|للجنسين)$/i.test(t)) return false;
  // ممنوع يكون جملة إعلان
  if (/(تعلن|يعلن|شركة|مصنع|مطعم|معرض|عن توفر|فرصة عمل)/i.test(t) && t.length > 35) return false;
  return true;
}

function cleanJobTitle(s = "") {
  let x = normalizeText(s);

  // شيل ايموجي وجنس/جمع
  x = x.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
  x = x.replace(/\b(موظفين|موظفات|موظف|موظفة|ذكور|إناث|للجنسين)\b/gi, "").trim();

  // قص عند بداية تفاصيل
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

const hash = crypto
  .createHash("sha256")
  .update(rawText)
  .digest("hex");

const exists = db.prepare(
  "SELECT id FROM jobs WHERE hash=?"
).get(hash);

if (exists) {
  console.log("Duplicate ad skipped");
  return;
}

db.prepare(`
INSERT INTO jobs (hash, raw_text)
VALUES (?, ?)
`).run(hash, rawText);

const text = normalizeText(rawText); // فقط للتحليل/الفلترة;

    console.log("CONFIG:", { INBOX_CHAT_ID, REVIEW_CHAT_ID, QUDRAT_CHAT_ID });
    console.log("✅ /webhook HIT", new Date().toISOString());
    console.log("✅ msg:", { chatId, preview: text.slice(0, 120) });

    // ✅ نشتغل فقط على كروب الـIndex
    if (chatId !== INBOX_CHAT_ID) return;

    const decision = decideStrict(text);
    const targetChatId = decision.bucket === "QUDRAT"
      ? QUDRAT_CHAT_ID
      : REVIEW_CHAT_ID;

    console.log("decision:", decision, "target:", targetChatId);

    // ✅ ارسال مرة واحدة فقط
// ✅ ارسال مرة واحدة فقط
let finalText = text;

if (decision.bucket === "QUDRAT") {
  const title = smartTitleFromText(rawText);
  const company = (extractCompany(rawText) || "غير مذكور").replace(/[|،\-–—].*$/i, "").trim();
  const salary = smartSalary(rawText);
  const contact = smartContact(rawText);

  finalText = `📌 فرصة عمل

المسمى الوظيفي: ${title}
اسم الشركة: ${company}
الراتب: ${salary}
طريقة التواصل: ${contact}

──────────────

التفاصيل:
${rawText}`;
} else {
  // REVIEW يبقى مثل ما تحب (نفس النص بدون تنسيق)
  finalText = rawText;
}

// ✅ إرسال فعلي (مرة واحدة) لكل الحالات
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
