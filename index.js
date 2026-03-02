import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const INBOX_CHAT_ID = Number(process.env.INBOX_CHAT_ID || 0);
const REVIEW_CHAT_ID = Number(process.env.REVIEW_CHAT_ID || 0);
//const DEST_FORUM_CHAT_ID = Number(process.env.DEST_FORUM_CHAT_ID || 0);

function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

mustEnv("BOT_TOKEN", BOT_TOKEN);
mustEnv("INBOX_CHAT_ID", INBOX_CHAT_ID);
// REVIEW و DEST ممكن نخليهم اختيارياً مؤقتاً إلى أن تنشئهم:
 // mustEnv("REVIEW_CHAT_ID", REVIEW_CHAT_ID);
 // mustEnv("DEST_FORUM_CHAT_ID", DEST_FORUM_CHAT_ID);

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

// Telegram webhook endpoint
app.post("/webhook", async (req, res) => {
  res.status(200).send("ok");

  // ✅ Logs للتأكد أن تيليجرام يضرب endpoint
  console.log("✅ /webhook HIT", new Date().toISOString());
  console.log("update keys:", Object.keys(req.body || {}));

  try {
    const update = req.body || {};
    const msg = update.message || update.channel_post;
    if (!msg) {
      console.log("ℹ️ No message in update");
      return;
    }

    const chatId = msg.chat?.id;
    const text = (msg.text || msg.caption || "").trim();

    console.log("✅ msg:", { chatId, text: text.slice(0, 80) });

    // لا تتعامل إلا مع رسائل كروب INBOX
    if (chatId !== INBOX_CHAT_ID) return;

    // أرسلها إلى REVIEW للموافقة
    await tg("sendMessage", {
     chat_id: REVIEW_CHAT_ID,
    text: `📥 إعلان جديد بانتظار المراجعة:\n\n${text}`
});

    // (بعد ما نتأكد، نرجع لمنطق الفرز)
  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
