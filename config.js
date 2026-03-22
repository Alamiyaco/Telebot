// =========================
// Environment Variables
// =========================
export const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
export const INBOX_CHAT_ID = Number(process.env.INBOX_CHAT_ID || 0);
export const REVIEW_CHAT_ID = Number(process.env.REVIEW_CHAT_ID || 0);
export const QUDRAT_CHAT_ID = Number(process.env.QUDRAT_CHAT_ID || 0);
export const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
export const MODEL_NAME = (process.env.MODEL_NAME || "gpt-4.1").trim();

export const AUTO_PUBLISH_MIN_SCORE = Number(process.env.AUTO_PUBLISH_MIN_SCORE || 85);
export const REVIEW_MIN_SCORE = Number(process.env.REVIEW_MIN_SCORE || 65);
export const QUEUE_DELAY_MS = Number(process.env.QUEUE_DELAY_MS || 3000);
export const TG_MAX_LENGTH = 4096;

// Topic ID for Review group (optional)
export const REVIEW_TOPIC_ID = process.env.REVIEW_TOPIC_ID ? Number(process.env.REVIEW_TOPIC_ID) : null;

// =========================
// Qudrat Topic Routing
// =========================
// كل تصنيف يروح للـ Topic المناسب بكروب قدرات
// Topic ID = 1 يعني General
// لإضافة topic جديد: أضف التصنيف والـ ID هنا
export const QUDRAT_TOPIC_MAP = {
  "Sales": 1340,
  "HR": 1341,
  "Accounting": 1342,
  "Finance": 1342,
  "Hospitality": 1343,
  "Admin": 1344,
  "Customer Service": 1344,
  "IT": 1346,
  "Engineering": 1347,
  "Logistics": 1348,
  "Management": 1411,
  "Marketing": null,
  "Operations": null,
  "Medical": null,
  "Education": null,
  "Legal": null,
  "Procurement": null,
  "Other": null
};

// =========================
// Category Enum (used in AI schema)
// =========================
export const CATEGORY_ENUM = [
  "HR",
  "Admin",
  "Sales",
  "Customer Service",
  "Accounting",
  "Finance",
  "Engineering",
  "IT",
  "Marketing",
  "Logistics",
  "Procurement",
  "Legal",
  "Medical",
  "Education",
  "Operations",
  "Management",
  "Hospitality",
  "Other"
];

// =========================
// Validation
// =========================
function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

mustEnv("BOT_TOKEN", BOT_TOKEN);
mustEnv("INBOX_CHAT_ID", INBOX_CHAT_ID);
mustEnv("REVIEW_CHAT_ID", REVIEW_CHAT_ID);
mustEnv("QUDRAT_CHAT_ID", QUDRAT_CHAT_ID);
mustEnv("OPENAI_API_KEY", OPENAI_API_KEY);
