// ============================================================
// index.js — نقطة الدخول الرئيسية، الـ Webhook فقط
// ============================================================

import express from "express";
import { INBOX_CHAT_ID, QUDRAT_CHAT_ID, CATEGORY_TOPICS, MODEL_NAME, ADMIN_USER_IDS } from "./config.js";
import { db } from "./db.js";
import { normalizeText, normalizeInline, sha256, cleanTelegramAd } from "./helpers.js";
import { extractWithAI, cleanAIResult } from "./classifier.js";
import { validateResult, decideStrict } from "./validator.js";
import { buildPublishedText, buildEditKeyboard, EDIT_FIELDS } from "./formatter.js";
import { tg, sendToReview } from "./telegram.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// طلبات التعديل المعلقة (في الذاكرة)
// promptMsgId → { pubId, field, adminChatId }
const pendingEdits = new Map();

// === إرسال رسالة تعديل بالخاص لكل أدمن ===
async function notifyAdminsForEdit(pubId, result) {
  if (!ADMIN_USER_IDS.length) return;

  const summary = `📝 إعلان جديد منشور:\n\n` +
    `▫️ ${result.title}\n` +
    `▫️ ${result.company}\n` +
    `▫️ ${result.location}\n` +
    `▫️ الراتب: ${result.salary}`;

  for (const adminId of ADMIN_USER_IDS) {
    try {
      await tg("sendMessage", {
        chat_id: adminId,
        text: summary,
        reply_markup: buildEditKeyboard(pubId),
      });
    } catch (e) {
      console.log(`DM to admin ${adminId} failed:`, e.message || e);
    }
  }
}

// === معالجة ضغط زر التعديل (بالخاص) ===
async function handleEditCallback(cbq) {
  const [, field, pubIdStr] = (cbq.data || "").split(":");
  const pubId = Number(pubIdStr);
  const fieldInfo = EDIT_FIELDS[field];
  const adminChatId = cbq.message?.chat?.id;

  if (!fieldInfo || !pubId) {
    await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: "⚠️ حقل غير معروف" });
    return;
  }

  // التحقق من إن هذا أدمن مسجل
  if (!ADMIN_USER_IDS.includes(cbq.from?.id)) {
    await tg("answerCallbackQuery", {
      callback_query_id: cbq.id, text: "⛔ غير مصرح لك بالتعديل", show_alert: true
    });
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: cbq.id });

  // حذف رسالة الأزرار
  await tg("deleteMessage", { chat_id: adminChatId, message_id: cbq.message.message_id }).catch(() => {});

  // إرسال طلب القيمة الجديدة
  const prompt = await tg("sendMessage", {
    chat_id: adminChatId,
    text: `✏️ أرسل القيمة الجديدة لحقل "${fieldInfo.label}":\n\nرد على هذه الرسالة بالقيمة الجديدة.`,
    reply_markup: { force_reply: true },
  });

  if (prompt?.ok) {
    pendingEdits.set(prompt.result.message_id, { pubId, field, adminChatId });
    // تنظيف تلقائي بعد 5 دقائق
    setTimeout(async () => {
      if (pendingEdits.has(prompt.result.message_id)) {
        pendingEdits.delete(prompt.result.message_id);
        await tg("deleteMessage", { chat_id: adminChatId, message_id: prompt.result.message_id }).catch(() => {});
      }
    }, 5 * 60 * 1000);
  }
}

// === معالجة رد الأدمن بالقيمة الجديدة (بالخاص) ===
async function handleEditReply(msg) {
  const promptMsgId = msg.reply_to_message.message_id;
  const editInfo = pendingEdits.get(promptMsgId);
  if (!editInfo) return;
  pendingEdits.delete(promptMsgId);

  const newValue = normalizeText(msg.text || "").trim();
  if (!newValue) return;

  const { pubId, field, adminChatId } = editInfo;
  const fieldInfo = EDIT_FIELDS[field];
  if (!fieldInfo) return;

  // تحديث قاعدة البيانات
  try {
    db.prepare(`UPDATE ads_published SET ${fieldInfo.dbCol} = ? WHERE id = ?`).run(newValue, pubId);
  } catch (e) {
    console.log("Edit DB error:", e);
    await tg("sendMessage", { chat_id: adminChatId, text: "❌ فشل تحديث قاعدة البيانات." });
    return;
  }

  // قراءة السجل المحدث
  const pub = db.prepare("SELECT * FROM ads_published WHERE id = ?").get(pubId);
  if (!pub) return;

  const result = {
    title:              pub.title              || "غير مذكور",
    category:           pub.category           || "Other",
    company:            pub.company            || "غير مذكور",
    location:           pub.location           || "غير مذكور",
    employment_type:    pub.employment_type    || "غير مذكور",
    experience:         pub.experience         || "غير مذكور",
    salary:             pub.salary             || "غير مذكور",
    application_method: pub.application_method || "غير مذكور",
    contact:            pub.contact            || "غير مذكور",
    summary:            pub.summary            || "",
  };

  // تعديل الرسالة بكروب قدرات
  const editRes = await tg("editMessageText", {
    chat_id: pub.qudrat_chat_id,
    message_id: pub.qudrat_message_id,
    text: buildPublishedText(result, pub.raw_text),
  });

  // حذف رسائل التعديل بالخاص
  await tg("deleteMessage", { chat_id: adminChatId, message_id: promptMsgId }).catch(() => {});
  await tg("deleteMessage", { chat_id: adminChatId, message_id: msg.message_id }).catch(() => {});

  // تأكيد + أزرار لتعديلات إضافية
  if (editRes?.ok) {
    await tg("sendMessage", {
      chat_id: adminChatId,
      text: `✅ تم تعديل "${fieldInfo.label}" بنجاح.\n\nتبي تعدل حقل ثاني؟`,
      reply_markup: buildEditKeyboard(pubId),
    });
  } else {
    await tg("sendMessage", {
      chat_id: adminChatId,
      text: `⚠️ تم تحديث قاعدة البيانات لكن فشل تعديل الرسالة بالكروب.`,
    });
  }

  console.log("EDIT OK:", { pubId, field, newValue });
}

// =========================
// Webhook
// =========================
app.post("/webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body || {};

    // === معالجة أزرار التعديل بالخاص ===
    const cbq = update.callback_query;
    if (cbq?.data?.startsWith("ed:")) {
      await handleEditCallback(cbq);
      return;
    }

    const msg = update.message || update.channel_post;
    if (!msg) { console.log("No message in update"); return; }

    const chatId  = Number(msg.chat?.id || 0);
    const rawText = normalizeText(msg.text || msg.caption || "");

    // === معالجة ردود التعديل بالخاص ===
    if (msg.reply_to_message && pendingEdits.has(msg.reply_to_message.message_id)) {
      await handleEditReply(msg);
      return;
    }

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

      const { lastInsertRowid: pubId } = db.prepare(`
        INSERT INTO ads_published (
          raw_ad_id, hash, title, category, company, location, salary,
          contact, application_method, confidence, raw_text, clean_text,
          qudrat_chat_id, qudrat_message_id, topic_id,
          employment_type, experience, summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        String(topicId || ""),
        finalResult.employment_type    || "غير مذكور",
        finalResult.experience         || "غير مذكور",
        finalResult.summary            || ""
      );

      console.log("PUBLISHED OK:", { rawAdId, pubId, topicId, messageId: tgRes?.result?.message_id });

      // إرسال أزرار التعديل بالخاص للأدمنز
      await notifyAdminsForEdit(pubId, finalResult);

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
