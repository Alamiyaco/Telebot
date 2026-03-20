// ============================================================
// index.js — نقطة الدخول الرئيسية، الـ Webhook فقط
// ============================================================

import express from "express";
import { INBOX_CHAT_ID, QUDRAT_CHAT_ID, CATEGORY_TOPICS, MODEL_NAME } from "./config.js";
import { db } from "./db.js";
import { normalizeText, normalizeInline, sha256, cleanTelegramAd } from "./helpers.js";
import { extractWithAI, cleanAIResult } from "./classifier.js";
import { validateResult, decideStrict } from "./validator.js";
import { buildPublishedText, buildEditKeyboard, EDIT_FIELDS } from "./formatter.js";
import { tg, sendToReview } from "./telegram.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// طلبات التعديل المعلقة (في الذاكرة)
const pendingFieldSelect = new Map(); // editBtnMsgId → { pubId, originalMsgId, chatId, topicId }
const pendingEdits = new Map();       // promptMsgId → { pubId, field, originalMsgId, chatId, topicId }

// === التحقق من صلاحية الأدمن ===
async function isAdmin(chatId, userId) {
  try {
    const member = await tg("getChatMember", { chat_id: chatId, user_id: userId });
    return ["creator", "administrator"].includes(member?.result?.status);
  } catch (e) { return false; }
}

// === معالجة أمر /edit ===
async function handleEditCommand(msg) {
  const chatId = Number(msg.chat?.id || 0);
  const userId = msg.from?.id;
  const repliedMsg = msg.reply_to_message;
  const topicId = msg.message_thread_id || 0;

  // التحقق من الأدمن
  if (!await isAdmin(chatId, userId)) {
    await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    return;
  }

  // البحث عن الإعلان بالـ message_id
  const pub = db.prepare(
    "SELECT id FROM ads_published WHERE qudrat_message_id = ? AND qudrat_chat_id = ? LIMIT 1"
  ).get(String(repliedMsg.message_id), String(chatId));

  if (!pub) {
    const notice = await tg("sendMessage", {
      chat_id: chatId,
      text: "⚠️ هذه الرسالة ليست إعلان منشور أو غير موجودة في قاعدة البيانات.",
      ...(topicId ? { message_thread_id: topicId } : {}),
    });
    setTimeout(async () => {
      await tg("deleteMessage", { chat_id: chatId, message_id: notice?.result?.message_id }).catch(() => {});
      await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    }, 4000);
    return;
  }

  // حذف رسالة /edit
  await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});

  // إرسال أزرار اختيار الحقل
  const btnMsg = await tg("sendMessage", {
    chat_id: chatId,
    text: "✏️ اختر الحقل المراد تعديله:",
    reply_markup: buildEditKeyboard(pub.id),
    ...(topicId ? { message_thread_id: topicId } : {}),
  });

  if (btnMsg?.ok) {
    pendingFieldSelect.set(btnMsg.result.message_id, {
      pubId: pub.id,
      originalMsgId: repliedMsg.message_id,
      chatId,
      topicId,
    });
    // تنظيف تلقائي بعد دقيقتين
    setTimeout(async () => {
      if (pendingFieldSelect.has(btnMsg.result.message_id)) {
        pendingFieldSelect.delete(btnMsg.result.message_id);
        await tg("deleteMessage", { chat_id: chatId, message_id: btnMsg.result.message_id }).catch(() => {});
      }
    }, 2 * 60 * 1000);
  }
}

// === معالجة ضغط زر اختيار الحقل ===
async function handleEditCallback(cbq) {
  const [, field, pubIdStr] = (cbq.data || "").split(":");
  const pubId = Number(pubIdStr);
  const fieldInfo = EDIT_FIELDS[field];

  if (!fieldInfo || !pubId) {
    await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: "⚠️ حقل غير معروف" });
    return;
  }

  const chatId = cbq.message?.chat?.id;
  const userId = cbq.from?.id;

  // التحقق من الأدمن
  if (!await isAdmin(chatId, userId)) {
    await tg("answerCallbackQuery", {
      callback_query_id: cbq.id, text: "⛔ فقط الأدمن يقدر يعدل", show_alert: true
    });
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: cbq.id });

  const editBtnMsgId = cbq.message?.message_id;
  const selectInfo = pendingFieldSelect.get(editBtnMsgId);
  const originalMsgId = selectInfo?.originalMsgId || 0;
  const topicId = selectInfo?.topicId || cbq.message?.message_thread_id || 0;

  // حذف رسالة الأزرار
  pendingFieldSelect.delete(editBtnMsgId);
  await tg("deleteMessage", { chat_id: chatId, message_id: editBtnMsgId }).catch(() => {});

  // إرسال رسالة تطلب القيمة الجديدة
  const prompt = await tg("sendMessage", {
    chat_id: chatId,
    text: `✏️ أرسل القيمة الجديدة لحقل "${fieldInfo.label}":\n\nرد على هذه الرسالة بالقيمة الجديدة.`,
    reply_markup: { force_reply: true, selective: true },
    ...(topicId ? { message_thread_id: topicId } : {}),
  });

  if (prompt?.ok) {
    pendingEdits.set(prompt.result.message_id, {
      pubId, field, originalMsgId, chatId, topicId
    });
    // تنظيف تلقائي بعد 5 دقائق
    setTimeout(async () => {
      if (pendingEdits.has(prompt.result.message_id)) {
        pendingEdits.delete(prompt.result.message_id);
        await tg("deleteMessage", { chat_id: chatId, message_id: prompt.result.message_id }).catch(() => {});
      }
    }, 5 * 60 * 1000);
  }
}

// === معالجة رد الأدمن بالقيمة الجديدة ===
async function handleEditReply(msg) {
  const promptMsgId = msg.reply_to_message.message_id;
  const editInfo = pendingEdits.get(promptMsgId);
  if (!editInfo) return;
  pendingEdits.delete(promptMsgId);

  const newValue = normalizeText(msg.text || "").trim();
  if (!newValue) return;

  const { pubId, field, originalMsgId, chatId } = editInfo;
  const fieldInfo = EDIT_FIELDS[field];
  if (!fieldInfo) return;

  // تحديث قاعدة البيانات
  try {
    db.prepare(`UPDATE ads_published SET ${fieldInfo.dbCol} = ? WHERE id = ?`).run(newValue, pubId);
  } catch (e) { console.log("Edit DB error:", e); return; }

  // قراءة السجل المحدث وإعادة بناء الرسالة
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

  const newText = buildPublishedText(result, pub.raw_text);

  // تعديل الرسالة الأصلية
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: originalMsgId,
    text: newText,
  });

  // حذف رسالة السؤال ورسالة الرد (تنظيف)
  await tg("deleteMessage", { chat_id: chatId, message_id: promptMsgId }).catch(() => {});
  await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});

  console.log("EDIT OK:", { pubId, field, newValue });
}

// =========================
// Webhook
// =========================
app.post("/webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body || {};

    // === معالجة أزرار اختيار الحقل ===
    const cbq = update.callback_query;
    if (cbq?.data?.startsWith("ed:")) {
      await handleEditCallback(cbq);
      return;
    }

    const msg = update.message || update.channel_post;
    if (!msg) { console.log("No message in update"); return; }

    const chatId  = Number(msg.chat?.id || 0);
    const rawText = normalizeText(msg.text || msg.caption || "");

    // === معالجة /edit في كروب قدرات ===
    if (rawText.startsWith("/edit") && msg.reply_to_message && chatId === QUDRAT_CHAT_ID) {
      await handleEditCommand(msg);
      return;
    }

    // === معالجة ردود التعديل ===
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

      db.prepare(`
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
