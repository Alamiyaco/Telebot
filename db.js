// ============================================================
// db.js — قاعدة البيانات والجداول
// ============================================================

import Database from "better-sqlite3";

export const db = new Database("jobs_v4.db");

db.exec(`
CREATE TABLE IF NOT EXISTS ads_raw (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  hash              TEXT,
  raw_text          TEXT NOT NULL,
  clean_text        TEXT,
  source_chat_id    TEXT,
  source_message_id TEXT,
  ai_output_json    TEXT,
  final_output_json TEXT,
  extract_status    TEXT DEFAULT 'pending',
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ads_review (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_ad_id         INTEGER,
  hash              TEXT,
  raw_text          TEXT NOT NULL,
  clean_text        TEXT,
  ai_output_json    TEXT,
  final_output_json TEXT,
  review_reason     TEXT,
  review_status     TEXT DEFAULT 'pending',
  reviewed_at       TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ads_published (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_ad_id          INTEGER,
  hash               TEXT,
  title              TEXT,
  category           TEXT,
  company            TEXT,
  location           TEXT,
  salary             TEXT,
  contact            TEXT,
  application_method TEXT,
  confidence         REAL,
  raw_text           TEXT NOT NULL,
  clean_text         TEXT,
  qudrat_chat_id     TEXT,
  qudrat_message_id  TEXT,
  topic_id           TEXT,
  website_status     TEXT DEFAULT 'pending',
  published_at       TEXT DEFAULT (datetime('now'))
);
`);

// إضافة أعمدة جديدة (آمن - لا يفشل إذا موجودة)
for (const sql of [
  "ALTER TABLE ads_published ADD COLUMN employment_type TEXT DEFAULT 'غير مذكور'",
  "ALTER TABLE ads_published ADD COLUMN experience TEXT DEFAULT 'غير مذكور'",
  "ALTER TABLE ads_published ADD COLUMN summary TEXT DEFAULT ''",
]) { try { db.exec(sql); } catch (e) { /* العمود موجود مسبقاً */ } }
