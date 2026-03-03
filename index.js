import express from "express";

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
  const title   = extractJobTitle(text);
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
    const text = normalizeText(msg.text || msg.caption || "");
    if (!text) return;

    console.log("CONFIG:", { INBOX_CHAT_ID, REVIEW_CHAT_ID, QUDRAT_CHAT_ID });
    console.log("✅ /webhook HIT", new Date().toISOString());
    console.log("✅ msg:", { chatId, preview: text.slice(0, 120) });

    // ✅ نشتغل فقط على كروب الـIndex
    if (chatId !== INBOX_CHAT_ID) return;

    const decision = decideStrict(text);
const targetChatId = decision.bucket === "QUDRAT"
  ? QUDRAT_CHAT_ID
  : REVIEW_CHAT_ID;

console.log("decision:", decision);

await tg("sendMessage", {
  chat_id: targetChatId,
  text: `📌 Auto Sort: ${decision.bucket}
🧩 Reason: ${decision.reason}

${text}`
});
    

    console.log("decision:", decision, "target:", targetChatId);

    await tg("sendMessage", {
      chat_id: targetChatId,
      text: formatForSend(text, decision),
    });
  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

// ✅ Render لازم يسمع على PORT
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log("Server running on port", PORT));
