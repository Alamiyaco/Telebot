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

// ===== Telegram =====
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

function isLikelyPhone(s = "") {
  const x = normalizeInline(s);
  return /(?:\+?\d[\d\s\-]{7,}\d)/.test(x);
}

function isLikelyEmail(s = "") {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(normalizeInline(s));
}

function smartContact(raw = "") {
  const phones = raw.match(/\+?\d[\d\s\-]{7,}\d/g) || [];
  const emails = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  const list = [...new Set([...phones, ...emails])].map(x => normalizeInline(x));
  return list.length ? list.join(" | ") : "غير مذكور";
}

function isGoodEnoughJob(job = {}) {
  const title = normalizeInline(job.title || "");
  const company = normalizeInline(job.company || "");
  const contact = normalizeInline(job.contact || "");
  const salary = normalizeInline(job.salary || "");

  // الأساسيات: عنوان + تواصل
  if (!title || title === "غير مذكور") return false;
  if (!contact || contact === "غير مذكور") return false;

  // اسم شركة غير إجباري 100% لكنه يفضّل
  // الراتب غير إجباري 100%
  // لكن إذا title أو company عبارة عن رقم أو واتساب فهو سيء
  if (isLikelyPhone(title) || isLikelyEmail(title)) return false;
  if (/^(واتساب|whatsapp|وظيفة|فرصة عمل|مطلوب|مطلوبة)$/i.test(title)) return false;

  if (company && company !== "غير مذكور" && (isLikelyPhone(company) || isLikelyEmail(company))) {
    job.company = "غير مذكور";
  }

  if (salary && salary !== "غير مذكور" && isLikelyPhone(salary)) {
    job.salary = "غير مذكور";
  }

  return true;
}

function cleanupAIJob(job = {}, rawText = "") {
  const cleaned = {
    title: normalizeInline(job.title || "غير مذكور"),
    company: normalizeInline(job.company || "غير مذكور"),
    salary: normalizeInline(job.salary || "غير مذكور"),
    contact: normalizeInline(job.contact || "غير مذكور"),
    category: normalizeInline(job.category || "غير مذكور"),
    location: normalizeInline(job.location || "غير مذكور"),
    shift: normalizeInline(job.shift || "غير مذكور"),
    notes: normalizeInline(job.notes || "غير مذكور"),
  };

  if (!cleaned.contact || cleaned.contact === "غير مذكور") {
    cleaned.contact = smartContact(rawText);
  }

  if (cleaned.salary && cleaned.salary !== "غير مذكور" && isLikelyPhone(cleaned.salary)) {
    cleaned.salary = "غير مذكور";
  }

  if (cleaned.company && cleaned.company !== "غير مذكور" && isLikelyPhone(cleaned.company)) {
    cleaned.company = "غير مذكور";
  }

  if (cleaned.title && cleaned.title !== "غير مذكور" && isLikelyPhone(cleaned.title)) {
    cleaned.title = "غير مذكور";
  }

  if (!cleaned.contact || cleaned.contact === "غير مذكور") {
    cleaned.contact = smartContact(rawText);
  }

  return cleaned;
}

function buildPublishedText(job, rawText) {
  const parts = [
    "📌 فرصة عمل",
    "",
    `المسمى الوظيفي: ${job.title || "غير مذكور"}`,
    `اسم الشركة: ${job.company || "غير مذكور"}`,
    `الراتب: ${job.salary || "غير مذكور"}`,
    `طريقة التواصل: ${job.contact || "غير مذكور"}`
  ];

  if (job.location && job.location !== "غير مذكور") {
    parts.push(`الموقع: ${job.location}`);
  }

  if (job.shift && job.shift !== "غير مذكور") {
    parts.push(`الدوام/الشفت: ${job.shift}`);
  }

  if (job.category && job.category !== "غير مذكور") {
    parts.push(`التصنيف: ${job.category}`);
  }

  if (job.notes && job.notes !== "غير مذكور") {
    parts.push(`ملاحظات: ${job.notes}`);
  }

  parts.push("", "──────────────", "", "التفاصيل:", rawText);
  return parts.join("\n");
}

function buildReviewText(rawText, reason, aiJobs = []) {
  let jobsPreview = "";

  if (Array.isArray(aiJobs) && aiJobs.length) {
    const previewLines = aiJobs.slice(0, 5).map((job, i) => {
      return `${i + 1}- العنوان: ${job.title || "غير مذكور"} | الشركة: ${job.company || "غير مذكور"} | التواصل: ${job.contact || "غير مذكور"}`;
    });
    jobsPreview = `\n\nنتيجة AI الأولية:\n${previewLines.join("\n")}`;
  }

  return `📋 إعلان بحاجة مراجعة

سبب التحويل إلى كروب المراجعة:
${reason}${jobsPreview}

──────────────

نص الإعلان:
${rawText}`;
}

function summarizeReviewReason(jobs = []) {
  if (!jobs.length) return "لم يتمكن الذكاء الاصطناعي من استخراج وظائف صالحة";

  const first = jobs[0] || {};
  const missing = [];

  if (!first.title || first.title === "غير مذكور") missing.push("المسمى الوظيفي غير واضح أو غير موجود");
  if (!first.company || first.company === "غير مذكور") missing.push("اسم الشركة غير واضح أو غير موجود");
  if (!first.contact || first.contact === "غير مذكور") missing.push("معلومات التواصل غير موجودة");

  if (!missing.length) return "النتيجة المستخرجة غير موثوقة وتحتاج مراجعة";
  return missing.map(x => `- ${x}`).join("\n");
}

// ===== AI extraction =====
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
أنت خبير جدًا في تحليل إعلانات الوظائف العربية، خاصة الإعلانات العراقية غير المرتبة.

مهمتك:
- اقرأ الإعلان كاملًا
- استخرج جميع الوظائف الموجودة داخله، وليس وظيفة واحدة فقط
- إذا كان الإعلان يحتوي أكثر من وظيفة، أرجعها كلها داخل jobs

أرجع JSON فقط بهذا الشكل:
{
  "jobs": [
    {
      "title": "اسم الوظيفة فقط",
      "company": "اسم الجهة أو الشركة",
      "salary": "الراتب أو غير مذكور",
      "contact": "رقم الهاتف أو الإيميل أو غير مذكور",
      "category": "تصنيف عام مثل مبيعات / خدمة عملاء / إداري / فني / سائق / تجميل / مطعم / غير مذكور",
      "location": "الموقع أو غير مذكور",
      "shift": "الدوام أو الشفت أو غير مذكور",
      "notes": "أي ملاحظات مهمة قصيرة أو غير مذكور"
    }
  ]
}

قواعد دقيقة:
1) title يجب أن يكون اسم الوظيفة فقط، وليس جملة كاملة.
2) لا تجعل اسم المكان أو المعهد أو الشركة جزءًا من title إلا إذا كان جزءًا من اسم الوظيفة فعلًا.
3) إذا الإعلان يحتوي عدة وظائف، استخرجها كلها.
4) إذا كانت هناك شركة أو جهة واضحة مثل:
شركة / وكالة / معهد / مطعم / مؤسسة / مكتب / مكتبة / مركز / Market / Agency / Group
فضعها في company.
5) إذا لم يكن الراتب واضحًا فلا تخمّن، اكتب "غير مذكور".
6) لا تضع رقم الهاتف مكان الراتب.
7) إذا لم توجد معلومات تواصل صريحة، اكتب "غير مذكور".
8) لا تكتب أي شرح خارج JSON.
9) لا تُرجع markdown أو code fence.
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
            name: "job_ads_extraction",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                jobs: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      title: { type: "string" },
                      company: { type: "string" },
                      salary: { type: "string" },
                      contact: { type: "string" },
                      category: { type: "string" },
                      location: { type: "string" },
                      shift: { type: "string" },
                      notes: { type: "string" }
                    },
                    required: ["title", "company", "salary", "contact", "category", "location", "shift", "notes"]
                  }
                }
              },
              required: ["jobs"]
            },
            strict: true
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.log("OpenAI API error:", data);
      return { jobs: [] };
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
      return { jobs: [] };
    }

    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.jobs)) return { jobs: [] };

    return parsed;
  } catch (err) {
    console.log("AI extract error:", err);
    return { jobs: [] };
  }
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

    const insertRaw = db.prepare(`
      INSERT INTO ads_raw (hash, raw_text, source_chat_id, source_message_id)
      VALUES (?, ?, ?, ?)
    `);

    const rawInsertResult = insertRaw.run(
      hash,
      rawText,
      String(chatId),
      String(msg.message_id || "")
    );

    const rawAdId = rawInsertResult.lastInsertRowid;

    console.log("CONFIG:", { INBOX_CHAT_ID, REVIEW_CHAT_ID, QUDRAT_CHAT_ID, MODEL_NAME });
    console.log("✅ /webhook HIT", new Date().toISOString());
    console.log("✅ msg:", { chatId, preview: normalizeInline(rawText).slice(0, 120) });

    const aiResult = await extractWithAI(rawText);
    const rawJobs = Array.isArray(aiResult.jobs) ? aiResult.jobs : [];
    const cleanedJobs = rawJobs.map(job => cleanupAIJob(job, rawText));

    console.log("AI RESULT:", aiResult);
    console.log("CLEANED JOBS:", cleanedJobs);

    const validJobs = cleanedJobs.filter(job => isGoodEnoughJob(job));

    if (!validJobs.length) {
      const reviewReason = summarizeReviewReason(cleanedJobs);

      db.prepare(`
        INSERT INTO ads_review (raw_ad_id, hash, raw_text, ai_output_json, review_reason)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        rawAdId,
        hash,
        rawText,
        JSON.stringify(aiResult),
        reviewReason
      );

      const finalText = buildReviewText(rawText, reviewReason, cleanedJobs);

      const tgRes = await tg("sendMessage", {
        chat_id: REVIEW_CHAT_ID,
        text: finalText,
      });

      console.log("SEND RESULT REVIEW:", JSON.stringify(tgRes, null, 2));
      return;
    }

    for (const job of validJobs) {
      const finalText = buildPublishedText(job, rawText);

      const tgRes = await tg("sendMessage", {
        chat_id: QUDRAT_CHAT_ID,
        text: finalText,
      });

      console.log("SEND RESULT QUDRAT:", JSON.stringify(tgRes, null, 2));

      db.prepare(`
        INSERT INTO ads_published (
          raw_ad_id, hash, title, category, company, salary, contact,
          raw_text, qudrat_chat_id, qudrat_message_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawAdId,
        hash,
        job.title || "غير مذكور",
        job.category || "غير مذكور",
        job.company || "غير مذكور",
        job.salary || "غير مذكور",
        job.contact || "غير مذكور",
        rawText,
        String(QUDRAT_CHAT_ID),
        String(tgRes?.result?.message_id || "")
      );
    }

    db.prepare(`
      UPDATE ads_raw
      SET ai_output_json = ?, extract_status = 'done'
      WHERE id = ?
    `).run(JSON.stringify(aiResult), rawAdId);

  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

// ✅ Render لازم يسمع على PORT
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log("Server running on port", PORT));
