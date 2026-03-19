// ============================================================
// helpers.js — أدوات تنظيف النصوص
// ============================================================

import crypto from "crypto";

export function normalizeArabicDigits(s = "") {
  const ar = "٠١٢٣٤٥٦٧٨٩";
  const en = "0123456789";
  return String(s).replace(/[٠-٩]/g, d => en[ar.indexOf(d)] ?? d);
}

export function normalizeText(s = "") {
  return normalizeArabicDigits(String(s || ""))
    .replace(/\u200f|\u200e|\u202a|\u202b|\u202c/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeInline(s = "") {
  return normalizeText(s).replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function stripEmojis(s = "") {
  return String(s).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
}

export function sha256(s = "") {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

export function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

export function linesOf(text = "") {
  return normalizeText(text).split("\n").map(x => x.trim()).filter(Boolean);
}

export function toNullableString(v) {
  if (v === null || v === undefined) return "غير مذكور";
  const x = normalizeInline(String(v));
  return x || "غير مذكور";
}

export function cleanTelegramAd(raw = "") {
  let x = normalizeText(raw);
  x = stripEmojis(x);
  x = x
    .replace(/[•●▪■◆◇★☆✅☑✔✳✴❇❗❕❗️]+/g, " ")
    .replace(/[═─—–]{2,}/g, "\n")
    .replace(/[📌📍📢📣💼🔥⭐🟢🔹🔸🟡🟣🧾📝📞☎️☎]+/gu, " ")
    .replace(/#{2,}/g, "#")
    .replace(/_{2,}/g, " ")
    .replace(/\*{2,}/g, " ")
    .replace(/~{2,}/g, " ")
    .replace(/\bواتس(?:اب)?\b/gi, "واتساب")
    .replace(/\bwhats\s*app\b/gi, "WhatsApp")
    .replace(/\bhr\b/gi, "HR")
    .replace(/\bcv\b/gi, "CV")
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+\n/g, "\n\n");
  return x.trim();
}
