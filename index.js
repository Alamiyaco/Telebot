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
`);

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const INBOX_CHAT_ID = Number(process.env.INBOX_CHAT_ID || 0);
const REVIEW_CHAT_ID = Number(process.env.REVIEW_CHAT_ID || 0);
const QUDRAT_CHAT_ID = Number(process.env.QUDRAT_CHAT_ID || 0);
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const MODEL_NAME = (process.env.MODEL_NAME || "gpt-4o-mini").trim();

function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

mustEnv("BOT_TOKEN", BOT_TOKEN);
mustEnv("INBOX_CHAT_ID", INBOX_CHAT_ID);
mustEnv("REVIEW_CHAT_ID", REVIEW_CHAT_ID);
mustEnv("QUDRAT_CHAT_ID", QUDRAT_CHAT_ID);
mustEnv("OPENAI_API_KEY", OPENAI_API_KEY);

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
function normalizeText(s = "") {
  return String(s || "")
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
  return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
}

function hasContact(text) {
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const phone = /(?:\+?\d[\d\s\-]{7,}\d)/;
  const link = /(https?:\/\/\S+|t\.me\/\S+)/i;
  return email.test(text) || phone.test(text) || link.test(text);
}

function hasSalary(text) {
  const salaryWord = /(راتب|Salary|أجر|الاجر|الأجر)/i;
  const number = /(\d{1,3}(?:[,\.\s]\d{3})+|\d{5,})/;
  return salaryWord.test(text) && number.test(text);
}

function extractCompany(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n").map(x => x.trim()).filter(Boolean);

  let m = normalized.match(/(?:تعلن|يعلن)\s+(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب)\s+([^\n]{2,60})/i);
  if (m) {
    let c = `${m[1]} ${m[2]}`.trim();
    c = c.replace(/(عن حاجتها|بحاجتها|لتعيين|لتوظيف|تطلب|المطلوب|الراتب|التواصل).*$/i, "").trim();
    if (c.length <= 70) return c;
  }

  for (const line of lines.slice(0, 8)) {
    m = line.match(/^(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب)\s+([^\n]{2,60})/i);
    if (m) {
      let c = `${m[1]} ${m[2]}`.trim();
      c = c.replace(/(عن حاجتها|بحاجتها|لتعيين|لتوظيف|تطلب|المطلوب|الراتب|التواصل).*$/i, "").trim();
      if (c.length <= 70) return c;
    }
  }

  m = normalized.match(/\b([A-Z][A-Za-z0-9&.\- ]{1,50}\s(?:Agency|Group|Company|Co|Ltd|Institute|Center))\b/);
  if (m) return m[1].trim();

  for (const line of lines.slice(0, 12)) {
    m = line.match(/^(?:اسم الشركة|الشركة)\s*[:：]\s*(.+)$/i);
    if (m && m[1]) {
      let c = m[1].trim();
      c = c.replace(/(الراتب|طريقة التواصل|التواصل|الدوام|الموقع|العنوان|التفاصيل).*$/i, "").trim();
      c = c.replace(/[|]/g, " ").trim();
      if (c && c.length <= 70) return c;
    }
  }

  return null;
}

function extractJobTitle(text) {
  const lines = normalizeText(text)
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 12)) {
    let m = line.match(/^(?:عنوان\s*الوظيف(?:ة|ي)|المسمى الوظيفي|العنوان الوظيفي)\s*[:：]\s*(.+)$/i);
    if (m && m[1]) return m[1].trim();

    m = line.match(/^(?:مطلوب|مطلوبة|فرصة عمل|وظيفة شاغرة|نبحث عن|بحاجة الى|بحاجة إلى|Hiring|Position|Job Title)\s*[:：\-–—]?\s*(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }

  return null;
}

function isBadGenericTitle(x = "") {
  const t = normalizeInline(x).toLowerCase();
  return [
    "غير مذكور",
    "مطلوب",
    "مطلوبة",
    "موظف",
    "موظفة",
    "موظفين",
    "موظفات",
    "فرصة عمل",
    "وظيفة",
    "whatsapp",
    "واتساب"
  ].includes(t);
}

function isGoodTitle(t = "") {
  if (!t) return false;

  const x = normalizeInline(t).toLowerCase();

  if (isBadGenericTitle(x)) return false;
  if (x.length < 2 || x.length > 60) return false;
  if (/(واتساب|whatsapp|للتواصل|اتصال|هاتف|رقم|ايميل|email)/i.test(x)) return false;
  if (/(راتب|الراتب|الدوام|الموقع|العنوان|الشركة|تفاصيل|التقديم)/i.test(x)) return false;
  if (/(تعلن|يعلن|شركة|مطعم|معهد|وكالة|مؤسسة)/i.test(x) && x.length > 28) return false;

  return true;
}

function cleanJobTitle(s = "") {
  let x = normalizeInline(s);

  x = stripEmojis(x);
  x = x.replace(/^(مطلوب|مطلوبة|نبحث عن|فرصة عمل|وظيفة شاغرة|بحاجة الى|بحاجة إلى)\s+/i, "").trim();

  // لا نحذف موظفين/موظفات لأن أحيانًا تكون صحيحة مثل "موظفين مبيعات"
  x = x.replace(/\b(ذكور|إناث|للجنسين)\b/gi, "").trim();

  x = x.replace(/\s+(?:في|للعمل في|للعمل لدى|داخل|ضمن)\s+(شركة|مطعم|معهد|وكالة|مؤسسة|مكتب|معمل|مصنع).*/i, "").trim();
  x = x.replace(/\s+(?:براتب|راتب|الراتب|الدوام|الموقع|العنوان|التواصل|واتساب|تفاصيل|الشروط)\b.*$/i, "").trim();
  x = x.replace(/[|:\-–—].*$/i, "").trim();
  x = x.replace(/\s{2,}/g, " ").trim();

  if (isBadGenericTitle(x)) return "غير مذكور";
  return x || "غير مذكور";
}

function smartTitleFromText(raw = "") {
  const lines = normalizeText(raw)
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const knownRoles = [
    "موظفين مبيعات",
    "موظف مبيعات",
    "موظفة مبيعات",
    "مروجة مبيعات",
    "مندوب مبيعات",
    "مندوبة مبيعات",
    "كاتب محتوى",
    "كاتبة محتوى",
    "Call Center",
    "خدمة عملاء",
    "محاسب",
    "محاسبة",
    "حسابات",
    "كاشير",
    "استقبال",
    "موظف استقبال",
    "موظفة استقبال",
    "فني صيانة",
    "مهندس مدني",
    "مهندس زراعي",
    "مهندس كهرباء",
    "صناعات غذائية",
    "علوم بايلوجي",
    "عامل",
    "عامل مطبخ",
    "مدير صفحات",
    "سوشيال ميديا"
  ];

  const full = normalizeText(raw);
  for (const role of knownRoles) {
    if (full.includes(role)) return role;
  }

  for (const line of lines.slice(0, 12)) {
    let m = line.match(/^(?:مطلوب|مطلوبة|نبحث عن|بحاجة الى|بحاجة إلى)\s+(.+)$/i);
    if (m && m[1]) {
      const t = cleanJobTitle(m[1]);
      if (isGoodTitle(t)) return t;
    }

    m = line.match(/^(?:المسمى الوظيفي|عنوان الوظيفة|العنوان الوظيفي)\s*[:：]\s*(.+)$/i);
    if (m && m[1]) {
      const t = cleanJobTitle(m[1]);
      if (isGoodTitle(t)) return t;
    }
  }

  return "غير مذكور";
}

function smartSalary(raw = "") {
  const lines = normalizeText(raw)
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(/(?:الراتب|راتب|الأجر|الاجر|الأجر الأساسي|الراتب الأساسي)\s*[:：\-–—]?\s*([^\n\r]{2,100})/i);
    if (m && m[1]) return normalizeInline(m[1]);
  }

  // fallback: رقم واضح داخل الإعلان
  const m2 = normalizeText(raw).match(/(\d{1,3}(?:[,\.\s]\d{3})+|\d{5,})/);
  if (m2 && m2[1]) return normalizeInline(m2[1]);

  return "غير مذكور";
}

function smartContact(raw = "") {
  const phones = raw.match(/\+?\d[\d\s\-]{7,}\d/g) || [];
  const emails = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];

  const list = [...new Set([...phones, ...emails])].map(x => normalizeInline(x));
  return list.length ? list.join(" | ") : "غير مذكور";
}

function translateReviewReason(reason = "") {
  const map = {
    company: "اسم الشركة غير واضح أو غير موجود",
    job_title: "المسمى الوظيفي غير واضح أو غير موجود",
    contact: "معلومات التواصل غير موجودة",
    salary: "الراتب غير موجود أو غير واضح"
  };

  if (!reason.startsWith("missing:")) return reason;

  const fields = reason
    .replace("missing:", "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  return fields.map(f => `- ${map[f] || f}`).join("\n");
}

function decideStrict(text, aiData = null) {
  const safeAI = aiData && typeof aiData === "object" ? aiData : {};

  const company =
    safeAI.company && safeAI.company !== "غير مذكور"
      ? safeAI.company
      : extractCompany(text);

  const title =
    safeAI.title && safeAI.title !== "غير مذكور"
      ? safeAI.title
      : smartTitleFromText(text);

  const contact =
    safeAI.contact && safeAI.contact !== "غير مذكور"
      ? safeAI.contact
      : (hasContact(text) ? "موجود" : "");

  const salary =
    safeAI.salary && safeAI.salary !== "غير مذكور"
      ? safeAI.salary
      : (hasSalary(text) ? "موجود" : "");

  const missing = [];

  if (!company || company === "غير مذكور") missing.push("company");
  if (!title || title === "غير مذكور" || !isGoodTitle(title)) missing.push("job_title");
  if (!contact) missing.push("contact");

  // الراتب أقل تشددًا
  if (!salary) missing.push("salary");

  // اسمح بمرور الإعلان إذا كان ينقصه الراتب فقط
  if (missing.length === 0) {
    return { bucket: "QUDRAT", reason: "ai_ok" };
  }

  if (missing.length === 1 && missing[0] === "salary") {
    return { bucket: "QUDRAT", reason: "salary_missing_but_ok" };
  }

  return { bucket: "REVIEW", reason: "missing: " + missing.join(", ") };
}

async function extractWithAI(text) {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: `
أنت خبير في تحليل إعلانات الوظائف العربية، خاصة الإعلانات العراقية غير المرتبة.

استخرج فقط الحقول التالية بصيغة JSON:
title
company
salary
contact
category

تعليمات دقيقة جدًا:
1) title يجب أن يكون اسم الوظيفة فقط، وليس جملة طويلة.
2) إذا كان النص مثل:
"مطلوب موظفين مبيعات"
فالعنوان يجب أن يكون:
"موظفين مبيعات"
3) إذا كان النص مثل:
"مطلوب موظفات في معهد..."
فلا تجعل اسم المكان جزءًا من title.
4) إذا كان النص مثل:
"تعلن شركة البيت العراقي عن حاجتها الى موظفين مبيعات"
فالشركة:
"شركة البيت العراقي"
والعنوان:
"موظفين مبيعات"
5) إذا كان النص يحتوي جهة مثل:
معهد / وكالة / شركة / مطعم / مؤسسة / مكتب
فحاول استخراجها كـ company.
6) إذا لم تجد قيمة واضحة اكتب:
"غير مذكور"
7) لا ترجع أي شرح. فقط JSON مطابق للمخطط.
                `.trim()
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "job_ad_extraction",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                company: { type: "string" },
                salary: { type: "string" },
                contact: { type: "string" },
                category: { type: "string" }
              },
              required: ["title", "company", "salary", "contact", "category"]
            },
            strict: true
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

const BAD_TITLES = [
  "whatsapp",
  "واتساب",
  "تحدث",
  "كتابة",
  "تحدث وكتابة",
  "فرصة عمل",
  "وظيفة",
  "مطلوب",
  "مطلوبة",
  "مطلوب موظف",
  "مطلوب موظفة",
  "مطلوب موظفين",
  "مطلوب موظفات",
  "موظف",
  "موظفة",
  "موظفين",
  "موظفات",
  "للتواصل",
  "ايميل",
  "البريد",
  "الرقم"
];

function cleanAIResult(aiData, rawText = "") {
  if (!aiData || typeof aiData !== "object") return null;

  let title = normalizeInline(String(aiData.title || "").trim());
  let company = normalizeInline(String(aiData.company || "").trim());
  let salary = normalizeInline(String(aiData.salary || "").trim());
  let contact = normalizeInline(String(aiData.contact || "").trim());
  let category = normalizeInline(String(aiData.category || "").trim());

  const lowerTitle = title.toLowerCase();

  if (
    !title ||
    BAD_TITLES.includes(lowerTitle) ||
    /^(whatsapp|واتساب|تحدث|كتابة|تحدث وكتابة|فرصة عمل|وظيفة|مطلوب|مطلوبة|موظف|موظفة|موظفين|موظفات)$/i.test(title)
  ) {
    title = "غير مذكور";
  }

  // هنا لا نكسر ناتج OpenAI بقسوة
  if (title !== "غير مذكور") {
    title = normalizeInline(stripEmojis(title));
  }

  if (!isGoodTitle(title)) {
    const fallback = smartTitleFromText(rawText);
    title = isGoodTitle(fallback) ? fallback : "غير مذكور";
  }

  if (
    !company ||
    /(واتساب|whatsapp|للتواصل|الاتصال|الرقم|ايميل|email|\d{7,})/i.test(company) ||
    company.length > 70
  ) {
    company = extractCompany(rawText) || "غير مذكور";
  }

  if (!contact || contact === "غير مذكور") {
    contact = smartContact(rawText);
  }

  if (!salary || salary === "غير مذكور") {
    salary = smartSalary(rawText);
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
    const rawText = normalizeText(msg.text || msg.caption || "");

    if (!rawText) return;
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

    const text = rawText;

    console.log("CONFIG:", { INBOX_CHAT_ID, REVIEW_CHAT_ID, QUDRAT_CHAT_ID, MODEL_NAME });
    console.log("✅ /webhook HIT", new Date().toISOString());
    console.log("✅ msg:", { chatId, preview: normalizeInline(text).slice(0, 120) });

    const aiData = await extractWithAI(rawText);
    const cleanedAI = cleanAIResult(aiData, rawText);

    console.log("CLEANED AI:", cleanedAI);
    console.log("AI DATA:", aiData);

    const decision = decideStrict(text, cleanedAI);
    const targetChatId = decision.bucket === "QUDRAT"
      ? QUDRAT_CHAT_ID
      : REVIEW_CHAT_ID;

    console.log("decision:", decision, "target:", targetChatId);

    let finalText = text;

    if (decision.bucket === "QUDRAT") {
      let title = "غير مذكور";
      if (cleanedAI?.title && cleanedAI.title !== "غير مذكور") {
        title = normalizeInline(cleanedAI.title);
      } else {
        title = smartTitleFromText(rawText);
      }

      if (!title || title === "غير مذكور" || !isGoodTitle(title)) {
        title = smartTitleFromText(rawText);
      }

      let company = "غير مذكور";
      if (cleanedAI?.company && cleanedAI.company !== "غير مذكور") {
        company = normalizeInline(cleanedAI.company);
      } else {
        company = extractCompany(rawText) || "غير مذكور";
      }

      const salary =
        cleanedAI?.salary && cleanedAI.salary !== "غير مذكور"
          ? normalizeInline(cleanedAI.salary)
          : smartSalary(rawText);

      const contact =
        cleanedAI?.contact && cleanedAI.contact !== "غير مذكور"
          ? normalizeInline(cleanedAI.contact)
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
      finalText = `📋 إعلان بحاجة مراجعة

سبب التحويل إلى كروب المراجعة:
${translateReviewReason(decision.reason)}

──────────────

نص الإعلان:
${rawText}`;
    }

    const tgRes = await tg("sendMessage", {
      chat_id: targetChatId,
      text: finalText,
    });

    console.log("SEND RESULT:", JSON.stringify(tgRes, null, 2));
  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

// ✅ Render لازم يسمع على PORT
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log("Server running on port", PORT));
