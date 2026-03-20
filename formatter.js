// ============================================================
// formatter.js — تنسيق رسائل التيليكرام
// ============================================================

import { translateReviewReason } from "./validator.js";

// رسالة النشر في كروب قدرات
export function buildPublishedText(result, rawText) {
  return `📌 فرصة عمل

🔹 المسمى الوظيفي: ${result.title}
🔹 المجال: ${result.category}
🔹 اسم الشركة/المؤسسة: ${result.company}
🔹 موقع العمل: ${result.location}
🔹 الخبرة المطلوبة: ${result.experience}
🔹 الراتب: ${result.salary}
🔹 التواصل: ${result.contact}

──────────────
📝 ملخص:
${result.summary}

──────────────
📄 النص الأصلي:
${rawText}`;
}

// رسالة المراجعة في كروب Review
export function buildReviewText(reason, rawText, cleanText, aiResult, validation) {
  return `📋 إعلان بحاجة مراجعة

سبب التحويل:
${translateReviewReason(reason)}

──────────────
📊 Score: ${validation?.score ?? 0}/100
⚠️ Issues: ${validation?.issues?.join(" | ") || "لا يوجد"}

──────────────
🤖 نتيجة التحليل:
${JSON.stringify(aiResult, null, 2)}

──────────────
🧹 النص بعد التنظيف:
${cleanText}

──────────────
📄 النص الأصلي:
${rawText}`;
}
