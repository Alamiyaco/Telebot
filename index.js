import express from "express";
import crypto from "crypto";

import {
  BOT_TOKEN,
  INBOX_CHAT_ID,
  REVIEW_CHAT_ID,
  QUDRAT_CHAT_ID
} from "./config.js";

import { db } from "./db.js";
import { classifyAd } from "./classifier.js";
import { formatTelegramMessage } from "./formatter.js";
import { validateAd } from "./validator.js";
import {
  sendMessage,
  sendMessageToTopic,
  handleEditCallback
} from "./telegram.js";

const app = express();

/* ================================
   🔥 DEBUG لكل الطلبات
================================ */
app.use((req, _res, next) => {
  console.log("REQ:", req.method, req.url);
  next();
});

app.use(express.json({ limit: "2mb" }));

/* ================================
   🟢 Health Check
================================ */
app.get("/", (_req, res) => {
  res.status(200).send("✅ Bot is running");
});

/* ================================
   🧪 اختبار webhook
================================ */
app.get("/webhook", (_req, res) => {
  res.status(200).send("Webhook endpoint is alive");
});

/* ================================
   🤖 Telegram Webhook
================================ */
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  console.log("BODY:", JSON.stringify(req.body || {}));

  res.status(200).send("ok");

  try {
    const update = req.body || {};

    /* ================================
       🎯 CALLBACK (زر تعديل)
    ================================= */
    const cbq = update.callback_query;
    if (cbq?.data?.startsWith("ed:")) {
      await handleEditCallback(cbq);
      return;
    }

    /* ================================
       📩 الرسالة
    ================================= */
    const msg = update.message || update.channel_post;
    if (!msg) {
      console.log("No message in update");
      return;
    }

    const text = (msg.text || msg.caption || "").trim();
    if (!text) {
      console.log("Empty text");
      return;
    }

    const chatId = msg.chat?.id;

    /* ================================
       ⚠️ فلترة الكروب
    ================================= */
    if (chatId !== INBOX_CHAT_ID) {
      console.log("Ignored chat:", chatId);
      return;
    }

    /* ================================
       🔐 Hash
    ================================= */
    const hash = crypto.createHash("sha1").update(text).digest("hex");

    /* ================================
       💾 حفظ الإعلان
    ================================= */
    const insert = db
      .prepare(`
        INSERT INTO ads_raw (hash, raw_text, source_chat_id, source_message_id)
        VALUES (?, ?, ?, ?)
      `)
      .run(hash, text, String(chatId), String(msg.message_id));

    const rawAdId = insert.lastInsertRowid;

    console.log("Saved raw ad:", rawAdId);

    /* ================================
       🧠 AI تحليل
    ================================= */
    let ai;
    try {
      ai = await classifyAd(text);
    } catch (e) {
      console.log("AI error:", e);
      return;
    }

    console.log("AI RESULT:", ai);

    /* ================================
       🔎 Validation
    ================================= */
    const validation = validateAd(ai);

    console.log("VALIDATION:", validation);

    if (!validation.ok) {
      console.log("❌ Rejected:", validation.reason);

      db.prepare(`
        INSERT INTO ads_review (raw_ad_id, hash, raw_text, ai_output_json, review_reason)
        VALUES (?, ?, ?, ?, ?)
      `).run(rawAdId, hash, text, JSON.stringify(ai), validation.reason);

      await sendMessage(
        REVIEW_CHAT_ID,
        `🚫 إعلان مرفوض:\n\n${text}\n\nالسبب: ${validation.reason}`
      );

      return;
    }

    /* ================================
       📝 تنسيق
    ================================= */
    const formatted = formatTelegramMessage(ai);

    console.log("FORMATTED:", formatted);

    /* ================================
       📤 إرسال
    ================================= */
    try {
      await sendMessageToTopic(QUDRAT_CHAT_ID, formatted);
      console.log("✅ Sent to channel");
    } catch (e) {
      console.log("Send error:", e);
      return;
    }

    /* ================================
       📦 نشر
    ================================= */
    db.prepare(`
      INSERT INTO ads_published (raw_ad_id, hash, raw_text, ai_output_json)
      VALUES (?, ?, ?, ?)
    `).run(rawAdId, hash, text, JSON.stringify(ai));

    console.log("🎉 Published");
  } catch (err) {
    console.log("Webhook handler error:", err?.stack || err);
  }
});

/* ================================
   ❌ 404 لأي مسار
================================ */
app.use((req, res) => {
  res.status(404).send(`Not found: ${req.method} ${req.url}`);
});

/* ================================
   🚀 تشغيل السيرفر
================================ */
const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
