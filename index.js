import express from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";

import {
  BOT_TOKEN, INBOX_CHAT_ID, REVIEW_CHAT_ID, QUDRAT_CHAT_ID,
  REVIEW_TOPIC_ID, QUDRAT_TOPIC_MAP, QUEUE_DELAY_MS,
  MODEL_NAME, AUTO_PUBLISH_MIN_SCORE, REVIEW_MIN_SCORE,
  ADMIN_PASSWORD, CATEGORY_ENUM, CATEGORY_AR
} from "./config.js";

import {
  normalizeText, normalizeInline, cleanTelegramAd, sha256, isNotJobAd
} from "./helpers.js";

import {
  extractWithAI, cleanAIResult, validateResult, decideStrict,
  buildPublishedText, buildReviewText
} from "./ai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  experience TEXT,
  summary TEXT,
  confidence REAL,
  raw_text TEXT NOT NULL,
  clean_text TEXT,
  qudrat_chat_id TEXT,
  qudrat_message_id TEXT,
  website_status TEXT DEFAULT 'pending_approval',
  published_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Migrate: add new columns if missing (for existing DBs)
try { db.exec("ALTER TABLE ads_published ADD COLUMN experience TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE ads_published ADD COLUMN summary TEXT"); } catch(e) {}

// Migrate: old 'pending' status → 'published' (existing data was auto-published)
db.exec("UPDATE ads_published SET website_status = 'published' WHERE website_status = 'pending'");

// =========================
// Settings helpers
// =========================
function getSetting(key, defaultVal) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : defaultVal;
}
function setSetting(key, val) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(val));
}

// Initialize default settings
if (!getSetting("require_approval", null)) {
  setSetting("require_approval", "true");
}

// =========================
// Express
// =========================
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// =========================
// Admin Auth
// =========================
const adminTokens = new Set();

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  next();
}

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
        console.log(`TG 429, waiting ${waitSec}s (attempt ${attempt}/${retries})`);
        await sleep(waitSec * 1000);
        continue;
      }
      console.log("TG error:", json);
      return json;
    } catch (err) {
      console.log(`TG fetch error (attempt ${attempt}/${retries}):`, err);
      if (attempt < retries) { await sleep(2000 * attempt); continue; }
      return { ok: false, description: String(err) };
    }
  }
}

async function tgSend(chatId, text, category) {
  const payload = { chat_id: chatId, text };
  if (chatId === QUDRAT_CHAT_ID) {
    const topicId = category ? QUDRAT_TOPIC_MAP[category] : null;
    if (topicId) payload.message_thread_id = topicId;
  } else if (chatId === REVIEW_CHAT_ID && REVIEW_TOPIC_ID) {
    payload.message_thread_id = REVIEW_TOPIC_ID;
  }
  return tg("sendMessage", payload);
}

async function tgEdit(chatId, messageId, text, category) {
  const payload = { chat_id: chatId, message_id: Number(messageId), text };
  return tg("editMessageText", payload);
}

async function tgDelete(chatId, messageId) {
  return tg("deleteMessage", { chat_id: chatId, message_id: Number(messageId) });
}

// =========================
// DB Helpers
// =========================
function insertReviewRow(rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason) {
  db.prepare(`
    INSERT INTO ads_review (raw_ad_id, hash, raw_text, clean_text, ai_output_json, final_output_json, review_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(rawAdId, hash, rawText, cleanText, JSON.stringify(aiData || null), JSON.stringify(finalResult || null), reviewReason);
}

async function sendToReview({ rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason, validation }) {
  const finalText = buildReviewText(reviewReason, rawText, cleanText, finalResult || aiData || null, validation || { score: 0, issues: [] });
  const tgRes = await tgSend(REVIEW_CHAT_ID, finalText);
  console.log("REVIEW TG:", tgRes?.ok ? "ok" : tgRes?.description);
  insertReviewRow(rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason);
  return tgRes;
}

function insertPublishedRow(ad, rawAdId, hash, rawText, cleanText, messageId) {
  return db.prepare(`
    INSERT INTO ads_published (
      raw_ad_id, hash, title, category, company, location, salary, contact,
      experience, summary, confidence, raw_text, clean_text,
      qudrat_chat_id, qudrat_message_id, website_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rawAdId, hash,
    ad.title || "غير مذكور",
    ad.category || "Other",
    ad.company || "غير مذكور",
    ad.location || "غير مذكور",
    ad.salary || "غير مذكور",
    ad.contact || "غير مذكور",
    ad.experience || "غير مذكور",
    ad.summary || "",
    Number(ad.confidence || 0),
    rawText, cleanText,
    String(QUDRAT_CHAT_ID),
    messageId || "",
    messageId ? "published" : "pending_approval"
  );
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
  if (isProcessing || processingQueue.length === 0) return;
  isProcessing = true;
  const job = processingQueue.shift();
  try { await processAd(job); }
  catch (e) { console.log("Queue process error:", e?.stack || String(e)); }
  console.log(`QUEUE: done, remaining = ${processingQueue.length}`);
  if (processingQueue.length > 0) await sleep(QUEUE_DELAY_MS);
  isProcessing = false;
  processNext();
}

// =========================
// Ad Processing (with approval support)
// =========================
async function processAd({ rawAdId, rawText, cleanText, hash }) {
  console.log("PROCESSING:", { rawAdId, preview: normalizeInline(cleanText).slice(0, 160) });

  const aiData = await extractWithAI(rawText, cleanText);
  console.log("STEP 2 AI DATA:", aiData?.__ai_failed__ ? "FAILED" : "ok");

  const finalResult = cleanAIResult(aiData, rawText, cleanText);
  console.log("STEP 3 RESULT:", finalResult ? `${finalResult.title} [${finalResult.category}]` : "null");

  db.prepare("UPDATE ads_raw SET ai_output_json = ?, final_output_json = ?, extract_status = ? WHERE id = ?")
    .run(JSON.stringify(aiData || null), JSON.stringify(finalResult || null), finalResult ? "done" : "failed", rawAdId);

  if (!finalResult) {
    await sendToReview({ rawAdId, hash, rawText, cleanText, aiData, finalResult: null, reviewReason: "ai_failed", validation: { score: 0, issues: ["ai_failed"] } });
    return;
  }

  const validation = validateResult(finalResult, rawText, cleanText);
  console.log("STEP 4 VALIDATION:", validation);

  const decision = decideStrict(validation);
  console.log("STEP 5 DECISION:", decision);

  if (decision.bucket === "QUDRAT") {
    const requireApproval = getSetting("require_approval", "true") === "true";

    let adsToPublish = [];
    if (finalResult.is_multi_role && finalResult.roles && finalResult.roles.length > 0) {
      for (const role of finalResult.roles) {
        adsToPublish.push({
          ...finalResult,
          title: role.title,
          category: role.category || finalResult.category,
          salary: role.salary || finalResult.salary,
          experience: role.experience || finalResult.experience,
          location: role.location || finalResult.location,
          summary: `${role.title}${finalResult.company !== "غير مذكور" ? ` لدى ${finalResult.company}` : ""}${(role.location || finalResult.location) !== "غير مذكور" ? ` في ${role.location || finalResult.location}` : ""}.`
        });
      }
      console.log(`MULTI_ROLE: split into ${adsToPublish.length} ads`);
    } else {
      adsToPublish.push(finalResult);
    }

    for (const ad of adsToPublish) {
      if (requireApproval) {
        // Save as pending — don't send to Telegram yet
        insertPublishedRow(ad, rawAdId, hash, rawText, cleanText, "");
        console.log(`PENDING APPROVAL: "${ad.title}" [${ad.category}]`);
      } else {
        // Auto-publish directly to Telegram
        const finalText = buildPublishedText(ad, rawText);
        const tgRes = await tgSend(QUDRAT_CHAT_ID, finalText, ad.category);
        console.log(`PUBLISH [${ad.category}] "${ad.title}":`, tgRes?.ok ? "ok" : tgRes?.description);

        if (!tgRes?.ok) {
          await sendToReview({ rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason: `publish_send_failed:${tgRes?.description || "unknown"}`, validation });
          continue;
        }

        insertPublishedRow(ad, rawAdId, hash, rawText, cleanText, String(tgRes?.result?.message_id || ""));
        console.log("PUBLISHED OK:", { rawAdId, title: ad.title, category: ad.category });
      }

      if (adsToPublish.length > 1) await sleep(1500);
    }
  } else {
    await sendToReview({ rawAdId, hash, rawText, cleanText, aiData, finalResult, reviewReason: decision.reason || "needs_review", validation });
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
    if (!rawText || chatId !== INBOX_CHAT_ID) return;

    if (isNotJobAd(rawText)) { console.log("SKIPPED: not a job ad"); return; }

    const cleanText = cleanTelegramAd(rawText);
    const hash = sha256(cleanText);

    const exists = db.prepare("SELECT id FROM ads_raw WHERE hash = ? AND created_at >= datetime('now', '-7 days') LIMIT 1").get(hash);
    if (exists) { console.log("Duplicate ad skipped"); return; }

    const insertRawResult = db.prepare("INSERT INTO ads_raw (hash, raw_text, clean_text, source_chat_id, source_message_id) VALUES (?, ?, ?, ?, ?)")
      .run(hash, rawText, cleanText, String(chatId), String(msg.message_id || ""));

    const rawAdId = insertRawResult.lastInsertRowid;
    console.log("STEP 1 RAW SAVED:", { rawAdId, queueSize: processingQueue.length });
    enqueue({ rawAdId, rawText, cleanText, hash });
  } catch (e) {
    console.log("Webhook handler error:", e?.stack || String(e));
  }
});

// ================================================================
//  PUBLIC API — الموقع العام
// ================================================================

// Get all published jobs (with search & filters)
app.get("/api/jobs", (req, res) => {
  try {
    const { category, location, search, page = 1, limit = 24 } = req.query;
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

    let where = ["website_status = 'published'"];
    let params = [];

    if (category) {
      where.push("category = ?");
      params.push(category);
    }
    if (location) {
      where.push("location LIKE ?");
      params.push(`%${location}%`);
    }
    if (search) {
      where.push("(title LIKE ? OR company LIKE ? OR summary LIKE ? OR raw_text LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereSQL = where.join(" AND ");

    const total = db.prepare(`SELECT COUNT(*) as count FROM ads_published WHERE ${whereSQL}`).get(...params).count;
    const jobs = db.prepare(`
      SELECT id, title, category, company, location, salary, contact, experience, summary, confidence, published_at
      FROM ads_published WHERE ${whereSQL}
      ORDER BY published_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), offset);

    res.json({
      jobs,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit))
    });
  } catch (e) {
    console.log("API /api/jobs error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// Get single job
app.get("/api/jobs/:id", (req, res) => {
  try {
    const job = db.prepare(`
      SELECT id, title, category, company, location, salary, contact, experience, summary, confidence, raw_text, published_at
      FROM ads_published WHERE id = ? AND website_status = 'published'
    `).get(req.params.id);

    if (!job) return res.status(404).json({ error: "not_found" });
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Get categories with counts
app.get("/api/categories", (req, res) => {
  try {
    const cats = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM ads_published WHERE website_status = 'published'
      GROUP BY category ORDER BY count DESC
    `).all();

    const result = cats.map(c => ({
      key: c.category,
      name_ar: CATEGORY_AR[c.category] || c.category,
      count: c.count
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Get stats
app.get("/api/stats", (req, res) => {
  try {
    const published = db.prepare("SELECT COUNT(*) as c FROM ads_published WHERE website_status = 'published'").get().c;
    const pending = db.prepare("SELECT COUNT(*) as c FROM ads_published WHERE website_status = 'pending_approval'").get().c;
    const categories = db.prepare("SELECT COUNT(DISTINCT category) as c FROM ads_published WHERE website_status = 'published'").get().c;
    const locations = db.prepare("SELECT DISTINCT location FROM ads_published WHERE website_status = 'published' AND location != 'غير مذكور'").all().map(r => r.location);

    res.json({ published, pending, categories, locations });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// ================================================================
//  ADMIN API — لوحة التحكم
// ================================================================

// Login
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  adminTokens.add(token);
  // Clean old tokens (keep max 10)
  if (adminTokens.size > 10) {
    const first = adminTokens.values().next().value;
    adminTokens.delete(first);
  }
  res.json({ token });
});

// Admin stats
app.get("/api/admin/stats", adminAuth, (req, res) => {
  try {
    const pending = db.prepare("SELECT COUNT(*) as c FROM ads_published WHERE website_status = 'pending_approval'").get().c;
    const published = db.prepare("SELECT COUNT(*) as c FROM ads_published WHERE website_status = 'published'").get().c;
    const rejected = db.prepare("SELECT COUNT(*) as c FROM ads_published WHERE website_status = 'rejected'").get().c;
    const review = db.prepare("SELECT COUNT(*) as c FROM ads_review WHERE review_status = 'pending'").get().c;
    const requireApproval = getSetting("require_approval", "true");

    res.json({ pending, published, rejected, review, require_approval: requireApproval === "true" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Get settings
app.get("/api/admin/settings", adminAuth, (req, res) => {
  res.json({
    require_approval: getSetting("require_approval", "true") === "true"
  });
});

// Update settings
app.put("/api/admin/settings", adminAuth, (req, res) => {
  const { require_approval } = req.body || {};
  if (typeof require_approval === "boolean") {
    setSetting("require_approval", require_approval ? "true" : "false");
  }
  res.json({ ok: true, require_approval: getSetting("require_approval", "true") === "true" });
});

// List jobs by status
app.get("/api/admin/jobs", adminAuth, (req, res) => {
  try {
    const { status = "pending_approval", page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

    const total = db.prepare("SELECT COUNT(*) as c FROM ads_published WHERE website_status = ?").get(status).c;
    const jobs = db.prepare(`
      SELECT id, title, category, company, location, salary, contact, experience, summary,
             confidence, raw_text, qudrat_message_id, website_status, published_at
      FROM ads_published WHERE website_status = ?
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(status, Number(limit), offset);

    res.json({ jobs, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Get single job (admin — any status)
app.get("/api/admin/jobs/:id", adminAuth, (req, res) => {
  try {
    const job = db.prepare("SELECT * FROM ads_published WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "not_found" });
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Approve job (publish to Telegram + website)
app.post("/api/admin/approve/:id", adminAuth, async (req, res) => {
  try {
    const job = db.prepare("SELECT * FROM ads_published WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "not_found" });
    if (job.website_status === "published") return res.json({ ok: true, message: "already_published" });

    // Build the published text
    const adResult = {
      title: job.title,
      category: job.category,
      company: job.company,
      location: job.location,
      experience: job.experience || "غير مذكور",
      salary: job.salary,
      contact: job.contact,
      summary: job.summary || ""
    };

    const finalText = buildPublishedText(adResult, job.raw_text);
    const tgRes = await tgSend(QUDRAT_CHAT_ID, finalText, job.category);

    if (!tgRes?.ok) {
      return res.status(500).json({ error: "telegram_failed", details: tgRes?.description });
    }

    db.prepare("UPDATE ads_published SET website_status = 'published', qudrat_message_id = ?, published_at = datetime('now') WHERE id = ?")
      .run(String(tgRes?.result?.message_id || ""), job.id);

    console.log("ADMIN APPROVED:", { id: job.id, title: job.title });
    res.json({ ok: true, message_id: tgRes?.result?.message_id });
  } catch (e) {
    console.log("Approve error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// Reject job
app.post("/api/admin/reject/:id", adminAuth, (req, res) => {
  try {
    const job = db.prepare("SELECT * FROM ads_published WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "not_found" });

    db.prepare("UPDATE ads_published SET website_status = 'rejected' WHERE id = ?").run(job.id);

    console.log("ADMIN REJECTED:", { id: job.id, title: job.title });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Edit job
app.put("/api/admin/jobs/:id", adminAuth, async (req, res) => {
  try {
    const job = db.prepare("SELECT * FROM ads_published WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "not_found" });

    const { title, category, company, location, salary, contact, experience, summary } = req.body || {};

    db.prepare(`
      UPDATE ads_published
      SET title = ?, category = ?, company = ?, location = ?, salary = ?, contact = ?, experience = ?, summary = ?
      WHERE id = ?
    `).run(
      title || job.title,
      category || job.category,
      company || job.company,
      location || job.location,
      salary || job.salary,
      contact || job.contact,
      experience || job.experience,
      summary || job.summary,
      job.id
    );

    // If published and has Telegram message, update it too
    if (job.website_status === "published" && job.qudrat_message_id) {
      const updatedJob = db.prepare("SELECT * FROM ads_published WHERE id = ?").get(job.id);
      const adResult = {
        title: updatedJob.title,
        category: updatedJob.category,
        company: updatedJob.company,
        location: updatedJob.location,
        experience: updatedJob.experience || "غير مذكور",
        salary: updatedJob.salary,
        contact: updatedJob.contact,
        summary: updatedJob.summary || ""
      };
      const finalText = buildPublishedText(adResult, updatedJob.raw_text);
      await tgEdit(QUDRAT_CHAT_ID, updatedJob.qudrat_message_id, finalText, updatedJob.category);
    }

    console.log("ADMIN EDITED:", { id: job.id, title: title || job.title });
    res.json({ ok: true });
  } catch (e) {
    console.log("Edit error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// Delete job
app.delete("/api/admin/jobs/:id", adminAuth, async (req, res) => {
  try {
    const job = db.prepare("SELECT * FROM ads_published WHERE id = ?").get(req.params.id);
    if (!job) return res.status(404).json({ error: "not_found" });

    // Delete from Telegram if published
    if (job.qudrat_message_id && job.website_status === "published") {
      await tgDelete(QUDRAT_CHAT_ID, job.qudrat_message_id);
    }

    db.prepare("DELETE FROM ads_published WHERE id = ?").run(job.id);

    console.log("ADMIN DELETED:", { id: job.id, title: job.title });
    res.json({ ok: true });
  } catch (e) {
    console.log("Delete error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// Bulk approve
app.post("/api/admin/approve-all", adminAuth, async (req, res) => {
  try {
    const pending = db.prepare("SELECT * FROM ads_published WHERE website_status = 'pending_approval' ORDER BY id").all();
    let approved = 0;
    let failed = 0;

    for (const job of pending) {
      const adResult = {
        title: job.title, category: job.category, company: job.company,
        location: job.location, experience: job.experience || "غير مذكور",
        salary: job.salary, contact: job.contact, summary: job.summary || ""
      };
      const finalText = buildPublishedText(adResult, job.raw_text);
      const tgRes = await tgSend(QUDRAT_CHAT_ID, finalText, job.category);

      if (tgRes?.ok) {
        db.prepare("UPDATE ads_published SET website_status = 'published', qudrat_message_id = ?, published_at = datetime('now') WHERE id = ?")
          .run(String(tgRes?.result?.message_id || ""), job.id);
        approved++;
      } else {
        failed++;
      }
      await sleep(1500);
    }

    res.json({ ok: true, approved, failed, total: pending.length });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// ================================================================
//  EXISTING TEST/DEBUG ENDPOINTS
// ================================================================
app.get("/queue", (_req, res) => {
  res.json({ queue_size: processingQueue.length, is_processing: isProcessing });
});

app.get("/test-publish", async (req, res) => {
  const category = req.query.category || "Other";
  const topicId = QUDRAT_TOPIC_MAP[category] || 1;
  const testText = `🧪 رسالة اختبار [${category}] - ${new Date().toISOString()}\nTopic ID: ${topicId}`;
  const tgRes = await tgSend(QUDRAT_CHAT_ID, testText, category);
  res.json({ target_chat_id: QUDRAT_CHAT_ID, category, topic_id: topicId, available_categories: Object.keys(QUDRAT_TOPIC_MAP), telegram_response: tgRes, success: tgRes?.ok || false });
});

app.get("/test-review", async (_req, res) => {
  const testText = `🧪 رسالة اختبار مراجعة - ${new Date().toISOString()}`;
  const tgRes = await tgSend(REVIEW_CHAT_ID, testText);
  res.json({ target_chat_id: REVIEW_CHAT_ID, topic_id: REVIEW_TOPIC_ID, telegram_response: tgRes, success: tgRes?.ok || false });
});

app.get("/debug-config", (_req, res) => {
  res.json({
    INBOX_CHAT_ID, REVIEW_CHAT_ID, REVIEW_TOPIC_ID, QUDRAT_CHAT_ID, QUDRAT_TOPIC_MAP,
    MODEL_NAME, AUTO_PUBLISH_MIN_SCORE, REVIEW_MIN_SCORE, QUEUE_DELAY_MS,
    require_approval: getSetting("require_approval", "true"),
    queue_size: processingQueue.length, is_processing: isProcessing
  });
});

// Fallback: serve index.html for SPA routes
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/webhook")) return res.status(404).json({ error: "not_found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log("Server running on port", PORT));
