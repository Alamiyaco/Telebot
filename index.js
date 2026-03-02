import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

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

// Health check
app.get("/", (req, res) => res.status(200).send("ok"));

// ---- Simple rule-based classifier ----
function normalizeText(s) {
  return (s || "")
    .replace(/\u200f|\u200e/g, "")
    .replace(/[^\S\r\n]+/g, " ")
    .trim();
}

function hasAny(text, arr) {
  const t = text.toLowerCase();
  return arr.some((k) => t.includes(k));
}

/**
 * Decision:
 * - If spam => ignore
 * - If has enough job info => QUDRAT
 * - else => REVIEW
 */
function classifyJob(textRaw) {
  const text = normalizeText(textRaw);

  // 1) Spam / not a job
  const spamKeywords = [
    "اعلان ممول",
    "اشترك",
    "subscribe",
    "تحميل",
    "download",
    "vpn",
    "تداول",
    "forex",
    "crypto",
    "عملات",
    "ربح يومي",
    "قروض",
  ];
  if (hasAny(text, spamKeywords)) return { bucket: "IGNORE", reason: "spam_keywords" };

  // 2) Job-likeness signals
  const jobKeywords = [
    "فرصة عمل",
    "وظيفة",
    "مطلوب",
    "تعلن",
    "招聘", // just in case
    "hiring",
    "job",
    "vacancy",
    "position",
  ];
  const looksLikeJob = hasAny(text, jobKeywords) || text.includes("CV") || text.includes("السيرة");

  // 3) Completeness checks (simple heuristics)
  const hasTitle = looksLikeJob || text.length > 40;
  const hasLocation = hasAny(text, ["بغداد", "البصرة", "اربيل", "أربيل", "نينوى", "النجف", "كربلاء", "الموصل", "المنصور", "الكرادة", "location", "in iraq"]);
  const hasCompany = hasAny(text, ["شركة", "مجموعة", "factory", "company", "co."]) || /شركة\s+\S+/.test(text);
  const hasApply = hasAny(text, ["للتقديم", "ارسال", "إرسال", "apply", "send", "واتساب", "whatsapp", "@gmail", "@yahoo", "t.me/"]) || /\b07\d{9}\b/.test(text);

  // Score
  let score = 0;
  if (hasTitle) score += 1;
  if (hasLocation) score += 1;
  if (hasCompany) score += 1;
  if (hasApply) score += 1;

  // Decision rule
  if (score >= 3) return { bucket: "QUDRAT", reason: `score_${score}` };
  return { bucket: "REVIEW", reason: `score_${score}` };
}

// Telegram webhook endpoint
app.post("/webhook", async (req, res) => {
  // لازم رد سريع
  res.status(200).send("ok");

  try {
    const update = req.body || {};
    const msg = update.message || update.channel_post;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const text = normalizeText(msg.text || msg.caption || "");
    if (!text) return;

    // Logs للتأكد
    console.log("✅ /webhook HIT", new Date().toISOString());
    console.log("msg:", { chatId, preview: text.slice(0, 120) });

    // فقط من كروب Index
    if (chatId !== INBOX_CHAT_ID) return;

    const decision = classifyJob(text);
    console.log("decision:", decision);

    if (decision.bucket === "IGNORE") return;

    const targetChatId = decision.bucket === "QUDRAT" ? QUDRAT_CHAT_ID : REVIEW_CHAT_ID;

    // صياغة مخرجات موحدة
    const header =
      decision.bucket === "QUDRAT"
        ? "✅ (Auto) إعلان مناسب → Qudrat"
        : "🟡 (Auto) يحتاج مراجعة → Review";

    await tg("sendMessage", {
      chat_id: targetChatId,
      text: `${header}\nReason: ${decision.reason}\n\n${text.slice(0, 3500)}`,
    });
  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
