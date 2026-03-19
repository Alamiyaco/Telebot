// ============================================================
// config.js — المتغيرات البيئية وإعدادات الكروبات
// ============================================================

function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

export const BOT_TOKEN        = (process.env.BOT_TOKEN        || "").trim();
export const INBOX_CHAT_ID    = Number(process.env.INBOX_CHAT_ID    || 0);
export const REVIEW_CHAT_ID   = Number(process.env.REVIEW_CHAT_ID   || 0);
export const QUDRAT_CHAT_ID   = Number(process.env.QUDRAT_CHAT_ID   || 0);
export const OPENAI_API_KEY   = (process.env.OPENAI_API_KEY   || "").trim();

export const MODEL_NAME            = (process.env.MODEL_NAME || "gpt-4.1").trim();
export const AUTO_PUBLISH_MIN_SCORE = Number(process.env.AUTO_PUBLISH_MIN_SCORE || 85);
export const REVIEW_MIN_SCORE       = Number(process.env.REVIEW_MIN_SCORE       || 65);

// معرفات المواضيع داخل كروب قدرات
// أنشئ Topic لكل مجال ثم ضع الـ ID في متغيرات Render
export const CATEGORY_TOPICS = {
  "HR":               Number(process.env.TOPIC_HR               || 0),
  "Admin":            Number(process.env.TOPIC_ADMIN            || 0),
  "Sales":            Number(process.env.TOPIC_SALES            || 0),
  "Customer Service": Number(process.env.TOPIC_CUSTOMER_SERVICE || 0),
  "Accounting":       Number(process.env.TOPIC_ACCOUNTING       || 0),
  "Finance":          Number(process.env.TOPIC_FINANCE          || 0),
  "Engineering":      Number(process.env.TOPIC_ENGINEERING      || 0),
  "IT":               Number(process.env.TOPIC_IT               || 0),
  "Design":           Number(process.env.TOPIC_DESIGN           || 0),
  "Marketing":        Number(process.env.TOPIC_MARKETING        || 0),
  "Logistics":        Number(process.env.TOPIC_LOGISTICS        || 0),
  "Procurement":      Number(process.env.TOPIC_PROCUREMENT      || 0),
  "Legal":            Number(process.env.TOPIC_LEGAL            || 0),
  "Medical":          Number(process.env.TOPIC_MEDICAL          || 0),
  "Education":        Number(process.env.TOPIC_EDUCATION        || 0),
  "Operations":       Number(process.env.TOPIC_OPERATIONS       || 0),
  "Management":       Number(process.env.TOPIC_MANAGEMENT       || 0),
  "Hospitality":      Number(process.env.TOPIC_HOSPITALITY      || 0),
  "Security":         Number(process.env.TOPIC_SECURITY         || 0),
  "Other":            Number(process.env.TOPIC_OTHER            || 0),
};

mustEnv("BOT_TOKEN",      BOT_TOKEN);
mustEnv("INBOX_CHAT_ID",  INBOX_CHAT_ID);
mustEnv("REVIEW_CHAT_ID", REVIEW_CHAT_ID);
mustEnv("QUDRAT_CHAT_ID", QUDRAT_CHAT_ID);
mustEnv("OPENAI_API_KEY", OPENAI_API_KEY);
