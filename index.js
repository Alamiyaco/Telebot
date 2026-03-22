import express from "express";
import Database from "better-sqlite3";

import {
  BOT_TOKEN, INBOX_CHAT_ID, REVIEW_CHAT_ID, QUDRAT_CHAT_ID,
  REVIEW_TOPIC_ID, QUDRAT_TOPIC_MAP, QUEUE_DELAY_MS,
  MODEL_NAME, AUTO_PUBLISH_MIN_SCORE, REVIEW_MIN_SCORE
} from "./config.js";

import {
  normalizeText, normalizeInline, cleanTelegramAd, sha256, isNotJobAd
} from "./helpers.js";

import {
  extractWithAI, cleanAIResult, validateResult, decideStrict,
  buildPublishedText, buildReviewText
} from "./ai.js";

// =========================
// Database
// =========================
const db = new Database("jobs_v4.db");

db.exec(`
CREATE TABLE IF NOT EXISTS ads_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT,
  raw_text TEXT NOT NULL,
  clean_text TEXT,
  source_chat_id TEXT,
  source_message_id TEXT,
  ai_output_json TEXT,
  final_output_json TEXT,
  extract_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ads_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_ad_id INTEGER,
  hash TEXT,
  raw_text TEXT NOT NULL,
  clean_text TEXT,
  ai_output_json TEXT,
  final_output_json TEXT,
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
  location TEXT,
  salary TEXT,
  contact TEXT,
  application_method TEXT,
  confidence REAL,
  raw_text TEXT NOT NULL,
  clean_text TEXT,
  qudrat_chat_id TEXT,
  qudrat_message_id TEXT,
  website_status TEXT DEFAULT 'pending',
  published_at TEXT DEFAULT (datetime('now'))
);
`);

const app = express();
app.use(express.json({ limit: "2mb" }));

// =========================
// Telegram (with retry for 429)
// =========================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function tg(method, payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {})
      });

      const json = await res.json().catch(() => ({}));

      if (json.ok) return json;

      if (json.error_code === 429 && attempt < retries) {
        const waitSec = json.parameters?.retry_after || 5;
        console.log(`TG 429 rate limit, waiting ${waitSec}s (attempt ${attempt}/${retries})`);
        await sleep(waitSec * 1000);
        continue;
      }

      console.log("TG error:", json);
      return json;
    } catch (err) {
      console.log(`TG fetch error (attempt ${attempt}/${retries}):`, err);
      if (attempt < retries) {
        await sleep(2000 * attempt);
        continue;
      }
      return { ok: false, description: String(err) };
    }
  }
}

// Send message with auto topic routing by category
async function tgSend(chatId, text, category) {
  const payload = { chat_id: chatId, text };

  if (chatId === QUDRAT_CHAT_ID) {
    const topicId = (category && QUDRAT_TOPIC_MAP[category]) || 1;
    payload.message_thread_id = topicId;
  } else if (chatId === REVIEW_CHAT_ID && REVIEW_TOPIC_ID) {
    payload.message_thread_id = REVIEW_TOPIC_ID;
  }

  return tg("sendMessage", payload);
}

// =========================
// DB Helpers
// =========================
function insertReviewRow(rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason) {
  db.prepare(`
    INSERT INTO ads_review (
      raw_ad_id, hash, raw_text, clean_text, ai_output_json, final_output_json, review_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    rawAdId, hash, rawText, cleanText,
    JSON.stringify(aiData || null),
    JSON.stringify(finalResult || null),
    reviewReason
  );
}

async function sendToReview({ rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason, validation }) {
  const finalText = buildReviewText(reviewReason, rawText, cleanText, finalResult || aiData || null, validation || { score: 0, issues: [] });

  const tgRes = await tgSend(REVIEW_CHAT_ID, finalText);
  console.log("REVIEW TG:", tgRes?.ok ? "ok" : tgRes?.description);

  insertReviewRow(rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason);

  if (!tgRes?.ok) {
    console.log("Review send failed:", tgRes);
  }

  return tgRes;
}

// =========================
// Processing Queue
// =========================
const processingQueue = [];
let isProcessing = false;

function enqueue(job) {
  processingQueue.push(job);
  console.log(`QUEUE: added job, queue size = ${processingQueue.length}`);
  processNext();
}

async function processNext() {
  if (isProcessing) return;
  if (processingQueue.length === 0) return;

  isProcessing = true;
  const job = processingQueue.shift();

  try {
    await processAd(job);
  } catch (e) {
    console.log("Queue process error:", e?.stack || String(e));
  }

  console.log(`QUEUE: done, remaining = ${processingQueue.length}`);

  if (processingQueue.length > 0) {
    await sleep(QUEUE_DELAY_MS);
  }

  isProcessing = false;
  processNext();
}

// =========================
// Ad Processing
// =========================
async function processAd({ rawAdId, rawText, cleanText, hash }) {
  console.log("PROCESSING:", { rawAdId, preview: normalizeInline(cleanText).slice(0, 160) });

  const aiData = await extractWithAI(rawText, cleanText);
  console.log("STEP 2 AI DATA:", aiData?.__ai_failed__ ? "FAILED" : "ok");

  const finalResult = cleanAIResult(aiData, rawText, cleanText);
  console.log("STEP 3 RESULT:", finalResult ? `${finalResult.title} [${finalResult.category}]` : "null");

  db.prepare(`
    UPDATE ads_raw
    SET ai_output_json = ?, final_output_json = ?, extract_status = ?
    WHERE id = ?
  `).run(
    JSON.stringify(aiData || null),
    JSON.stringify(finalResult || null),
    finalResult ? "done" : "failed",
    rawAdId
  );

  if (!finalResult) {
    await sendToReview({
      rawAdId, hash, rawText, cleanText, aiData,
      finalResult: null,
      reviewReason: "ai_failed",
      validation: { score: 0, issues: ["ai_failed"] }
    });
    return;
  }

  const validation = validateResult(finalResult, rawText, cleanText);
  console.log("STEP 4 VALIDATION:", validation);

  const decision = decideStrict(validation);
  console.log("STEP 5 DECISION:", decision);

  const targetChatId = decision.bucket === "QUDRAT" ? QUDRAT_CHAT_ID : REVIEW_CHAT_ID;

  if (decision.bucket === "QUDRAT") {
    const finalText = buildPublishedText(finalResult, rawText);

    const tgRes = await tgSend(targetChatId, finalText, finalResult.category);

    console.log("PUBLISH TG:", tgRes?.ok ? "ok" : tgRes?.description);

    if (!tgRes?.ok) {
      const failReason = `publish_send_failed:${tgRes?.description || "unknown_telegram_error"}`;

      await sendToReview({
        rawAdId, hash, rawText, cleanText, aiData, finalResult,
        reviewReason: failReason,
        validation
      });
      return;
    }

    db.prepare(`
      INSERT INTO ads_published (
        raw_ad_id, hash, title, category, company, location, salary, contact,
        application_method, confidence, raw_text, clean_text,
        qudrat_chat_id, qudrat_message_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rawAdId, hash,
      finalResult.title || "غير مذكور",
      finalResult.category || "Other",
      finalResult.company || "غير مذكور",
      finalResult.location || "غير مذكور",
      finalResult.salary || "غير مذكور",
      finalResult.contact || "غير مذكور",
      finalResult.application_method || "غير مذكور",
      Number(finalResult.confidence || 0),
      rawText, cleanText,
      String(QUDRAT_CHAT_ID),
      String(tgRes?.result?.message_id || "")
    );

    console.log("PUBLISHED OK:", { rawAdId, messageId: tgRes?.result?.message_id || null });
  } else {
    await sendToReview({
      rawAdId, hash, rawText, cleanText, aiData, finalResult,
      reviewReason: decision.reason || "needs_review",
      validation
    });
  }
}

// =========================
// Webhook
// =========================
app.post("/webhook", async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body || {};
    const msg = update.message || update.channel_post;
    if (!msg) return;

    const chatId = Number(msg.chat?.id || 0);
    const rawText = normalizeText(msg.text || msg.caption || "");

    if (!rawText) return;
    if (chatId !== INBOX_CHAT_ID) return;

    if (isNotJobAd(rawText)) {
      console.log("SKIPPED: not a job ad");
      return;
    }

    const cleanText = cleanTelegramAd(rawText);
    const hash = sha256(cleanText);

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

    const insertRawResult = db.prepare(`
      INSERT INTO ads_raw (hash, raw_text, clean_text, source_chat_id, source_message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash, rawText, cleanText, String(chatId), String(msg.message_id || ""));

    const rawAdId = insertRawResult.lastInsertRowid;

    console.log("STEP 1 RAW SAVED:", { rawAdId, queueSize: processingQueue.length });

    enqueue({ rawAdId, rawText, cleanText, hash });

  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

// =========================
// Endpoints
// =========================
app.get("/", (_req, res) => {
  res.status(200).send("Bot is running");
});

app.get("/queue", (_req, res) => {
  res.json({
    queue_size: processingQueue.length,
    is_processing: isProcessing
  });
});

// Test: /test-publish?category=Sales
app.get("/test-publish", async (req, res) => {
  const category = req.query.category || "Other";
  const topicId = QUDRAT_TOPIC_MAP[category] || 1;
  const testText = `🧪 رسالة اختبار [${category}] - ${new Date().toISOString()}\nTopic ID: ${topicId}`;

  const tgRes = await tgSend(QUDRAT_CHAT_ID, testText, category);

  res.json({
    target_chat_id: QUDRAT_CHAT_ID,
    category,
    topic_id: topicId,
    available_categories: Object.keys(QUDRAT_TOPIC_MAP),
    telegram_response: tgRes,
    success: tgRes?.ok || false
  });
});

app.get("/test-review", async (_req, res) => {
  const testText = `🧪 رسالة اختبار مراجعة - ${new Date().toISOString()}\nهذه رسالة تجريبية.`;

  const tgRes = await tgSend(REVIEW_CHAT_ID, testText);

  res.json({
    target_chat_id: REVIEW_CHAT_ID,
    topic_id: REVIEW_TOPIC_ID,
    telegram_response: tgRes,
    success: tgRes?.ok || false
  });
});

app.get("/debug-config", (_req, res) => {
  res.json({
    INBOX_CHAT_ID,
    REVIEW_CHAT_ID,
    REVIEW_TOPIC_ID,
    QUDRAT_CHAT_ID,
    QUDRAT_TOPIC_MAP,
    MODEL_NAME,
    AUTO_PUBLISH_MIN_SCORE,
    REVIEW_MIN_SCORE,
    QUEUE_DELAY_MS,
    queue_size: processingQueue.length,
    is_processing: isProcessing
  });
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log("Server running on port", PORT));
