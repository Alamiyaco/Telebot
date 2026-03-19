// ============================================================
// index.js — نقطة الدخول الرئيسية، الـ Webhook فقط
// ============================================================

import express from "express";
import { INBOX_CHAT_ID, QUDRAT_CHAT_ID, CATEGORY_TOPICS, MODEL_NAME } from "./config.js";
import { db } from "./db.js";
import { normalizeText, normalizeInline, sha256, cleanTelegramAd } from "./helpers.js";
import { extractWithAI, cleanAIResult } from "./classifier.js";
import { validateResult, decideStrict } from "./validator.js";
import { buildPublishedText } from "./formatter.js";
import { tg, sendToReview } from "./telegram.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// =========================
// Webhook
// =========================
app.post("/webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body || {};
    const msg = update.message || update.channel_post;
    if (!msg) { console.log("No message in update"); return; }

    const chatId  = Number(msg.chat?.id || 0);
    const rawText = normalizeText(msg.text || msg.caption || "");

    if (!rawText) return;
    if (chatId !== INBOX_CHAT_ID) return;

    // تنظيف ومنع التكرار
    const cleanText = cleanTelegramAd(rawText);
    const hash      = sha256(cleanText);

    const exists = db.prepare(`
      SELECT id FROM ads_raw WHERE hash = ? AND created_at >= datetime('now', '-7 days') LIMIT 1
    `).get(hash);
    if (exists) { console.log("Duplicate ad skipped"); return; }

    // حفظ الإعلان الخام
    const { lastInsertRowid: rawAdId } = db.prepare(`
      INSERT INTO ads_raw (hash, raw_text, clean_text, source_chat_id, source_message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash, rawText, cleanText, String(chatId), String(msg.message_id || ""));

    console.log("CONFIG:", { INBOX_CHAT_ID, QUDRAT_CHAT_ID, MODEL_NAME });
    console.log("STEP 1 RAW SAVED:", { rawAdId, preview: normalizeInline(cleanText).slice(0, 160) });

    // تحليل AI
    const aiData     = await extractWithAI(rawText, cleanText);
    const finalResult = cleanAIResult(aiData, rawText, cleanText);
    console.log("STEP 2 AI:", aiData);
    console.log("STEP 3 RESULT:", finalResult);

    // تحديث قاعدة البيانات
    db.prepare(`
      UPDATE ads_raw SET ai_output_json = ?, final_output_json = ?, extract_status = ? WHERE id = ?
    `).run(
      JSON.stringify(aiData || null),
      JSON.stringify(finalResult || null),
      finalResult ? "done" : "failed",
      rawAdId
    );

    // فشل التحليل → مراجعة
    if (!finalResult) {
      await sendToReview({ rawAdId, hash, rawText, cleanText, aiData,
        finalResult: null, reviewReason: "ai_failed", validation: { score: 0, issues: ["ai_failed"] } });
      return;
    }

    // التقييم والقرار
    const validation = validateResult(finalResult, rawText, cleanText);
    const decision   = decideStrict(validation);
    console.log("STEP 4 VALIDATION:", validation);
    console.log("STEP 5 DECISION:", decision);

    if (decision.bucket === "QUDRAT") {
      // إرسال للموضوع الصحيح حسب المجال
      const topicId   = CATEGORY_TOPICS[finalResult.category] || CATEGORY_TOPICS["Other"] || 0;
      const finalText = buildPublishedText(finalResult, rawText);

      const tgRes = await tg("sendMessage", {
        chat_id: QUDRAT_CHAT_ID,
        text: finalText,
        ...(topicId ? { message_thread_id: topicId } : {})
      });

      console.log("PUBLISH TG RESPONSE:", JSON.stringify(tgRes, null, 2));
      console.log("TOPIC USED:", { category: finalResult.category, topicId });

      if (!tgRes?.ok) {
        await sendToReview({ rawAdId, hash, rawText, cleanText, aiData, finalResult,
          reviewReason: `publish_send_failed:${tgRes?.description || "unknown"}`, validation });
        return;
      }

      // حفظ في ads_published
      db.prepare(`
        INSERT INTO ads_published (
          raw_ad_id, hash, title, category, company, location, salary,
          contact, application_method, confidence, raw_text, clean_text,
          qudrat_chat_id, qudrat_message_id, topic_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawAdId, hash,
        finalResult.title              || "غير مذكور",
        finalResult.category           || "Other",
        finalResult.company            || "غير مذكور",
        finalResult.location           || "غير مذكور",
        finalResult.salary             || "غير مذكور",
        finalResult.contact            || "غير مذكور",
        finalResult.application_method || "غير مذكور",
        Number(finalResult.confidence  || 0),
        rawText, cleanText,
        String(QUDRAT_CHAT_ID),
        String(tgRes?.result?.message_id || ""),
        String(topicId || "")
      );

      console.log("PUBLISHED OK:", { rawAdId, topicId, messageId: tgRes?.result?.message_id });

    } else {
      await sendToReview({ rawAdId, hash, rawText, cleanText, aiData, finalResult,
        reviewReason: decision.reason || "needs_review", validation });
    }

  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

// =========================
// Health Check
// =========================
app.get("/", (_req, res) => res.status(200).send("✅ Bot is running"));

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
