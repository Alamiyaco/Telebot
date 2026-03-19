// ============================================================
// telegram.js — التواصل مع Telegram API
// ============================================================

import { BOT_TOKEN, REVIEW_CHAT_ID } from "./config.js";
import { db } from "./db.js";
import { buildReviewText } from "./formatter.js";

export async function tg(method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) console.log("TG error:", json);
    return json;
  } catch (err) {
    console.log("TG fetch error:", err);
    return { ok: false, description: String(err) };
  }
}

function insertReviewRow(rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason) {
  db.prepare(`
    INSERT INTO ads_review (raw_ad_id, hash, raw_text, clean_text, ai_output_json, final_output_json, review_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(rawAdId, hash, rawText, cleanText,
    JSON.stringify(aiData || null), JSON.stringify(finalResult || null), reviewReason);
}

export async function sendToReview({ rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason, validation }) {
  const text = buildReviewText(
    reviewReason, rawText, cleanText,
    finalResult || aiData || null,
    validation || { score: 0, issues: [] }
  );
  const tgRes = await tg("sendMessage", { chat_id: REVIEW_CHAT_ID, text });
  console.log("REVIEW TG RESPONSE:", JSON.stringify(tgRes, null, 2));
  insertReviewRow(rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason);
  if (!tgRes?.ok) console.log("Review send failed:", tgRes);
  return tgRes;
}
