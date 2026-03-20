// ============================================================
// formatter.js — تنسيق رسائل التيليكرام + أزرار التعديل
// ============================================================

import { translateReviewReason } from "./validator.js";

// الحقول القابلة للتعديل
export const EDIT_FIELDS = {
  title:    { label: "المسمى الوظيفي", dbCol: "title" },
  company:  { label: "الشركة",         dbCol: "company" },
  category: { label: "المجال",         dbCol: "category" },
  location: { label: "الموقع",         dbCol: "location" },
  salary:   { label: "الراتب",         dbCol: "salary" },
  contact:  { label: "التواصل",        dbCol: "contact" },
  method:   { label: "طريقة التقديم",  dbCol: "application_method" },
};

// أزرار التعديل تحت الإعلان
export function buildEditKeyboard(pubId) {
  return {
    inline_keyboard: [
      [
        { text: "✏️ المسمى", callback_data: `ed:title:${pubId}` },
        { text: "✏️ الشركة", callback_data: `ed:company:${pubId}` },
        { text: "✏️ المجال", callback_data: `ed:category:${pubId}` },
      ],
      [
        { text: "✏️ الموقع", callback_data: `ed:location:${pubId}` },
        { text: "✏️ الراتب", callback_data: `ed:salary:${pubId}` },
        { text: "✏️ التواصل", callback_data: `ed:contact:${pubId}` },
      ],
      [
        { text: "✏️ طريقة التقديم", callback_data: `ed:method:${pubId}` },
      ],
    ]
  };
}

// رسالة النشر في كروب قدرات
export function buildPublishedText(result, rawText) {
  return `📌 فرصة عمل

🔹 المسمى الوظيفي: ${result.title}
🔹 المجال: ${result.category}
🔹 اسم الشركة: ${result.company}
🔹 الموقع: ${result.location}
🔹 نوع العمل: ${result.employment_type}
🔹 الخبرة المطلوبة: ${result.experience}
🔹 الراتب: ${result.salary}
🔹 طريقة التقديم: ${result.application_method}
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
