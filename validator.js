// ============================================================
// validator.js — التقييم والتحقق وقرار التوجيه
// ============================================================

import { AUTO_PUBLISH_MIN_SCORE, REVIEW_MIN_SCORE } from "./config.js";
import { normalizeInline, linesOf } from "./helpers.js";
import { isGoodTitle, isLikelySalaryValue, hasAnyContact, extractPhones } from "./extractor.js";

// =========================
// تقييم النتيجة (0–100)
// =========================
export function validateResult(result, rawText = "", cleanText = "") {
  const issues = [];
  let score = 0;
  const text = cleanText || rawText;

  if (result?.title && result.title !== "غير مذكور" && isGoodTitle(result.title))
    score += 25; else issues.push("missing_title");

  if (result?.category && result.category !== "غير مذكور")
    score += 15; else issues.push("missing_category");

  if (result?.contact && result.contact !== "غير مذكور")
    score += 20; else issues.push("missing_contact");

  if (result?.application_method && result.application_method !== "غير مذكور")
    score += 10; else issues.push("missing_application_method");

  if (result?.company  && result.company  !== "غير مذكور") score += 10;
  if (result?.location && result.location !== "غير مذكور") score += 5;

  if (result?.salary && result.salary !== "غير مذكور") {
    if (isLikelySalaryValue(result.salary)) score += 5;
    else { issues.push("bad_salary"); score -= 10; }
  }

  if (typeof result?.confidence === "number") {
    if      (result.confidence >= 0.9) score += 15;
    else if (result.confidence >= 0.8) score += 12;
    else if (result.confidence >= 0.7) score += 9;
    else if (result.confidence >= 0.6) score += 6;
    else if (result.confidence >= 0.5) score += 3;
    else issues.push("low_confidence");
  } else issues.push("missing_confidence");

  if (result?.is_multi_role) { issues.push("multi_role"); score -= 20; }

  if (result?.title && result?.company
    && result.title !== "غير مذكور" && result.company !== "غير مذكور"
    && normalizeInline(result.title).toLowerCase() === normalizeInline(result.company).toLowerCase()) {
    issues.push("title_equals_company"); score -= 15;
  }

  if (result?.contact === "غير مذكور" && hasAnyContact(text)) {
    issues.push("contact_extraction_missed"); score -= 15;
  }

  if (result?.salary !== "غير مذكور" && extractPhones(result.salary).length > 0) {
    issues.push("salary_looks_like_phone"); score -= 20;
  }

  score = Math.max(0, Math.min(100, score));
  return { is_valid: score >= REVIEW_MIN_SCORE, score, issues };
}

// =========================
// قرار التوجيه: قدرات أم مراجعة؟
// =========================
export function decideStrict(validated) {
  const { score, issues } = validated;
  const hardBlocks = ["title_equals_company", "salary_looks_like_phone"];
  if (score >= AUTO_PUBLISH_MIN_SCORE && !issues.some(x => hardBlocks.includes(x)))
    return { bucket: "QUDRAT", reason: "high_confidence" };
  return { bucket: "REVIEW", reason: issues.length ? issues.join(",") : "needs_review" };
}

// =========================
// ترجمة أسباب المراجعة للعربية
// =========================
export function translateReviewReason(reason = "") {
  const map = {
    missing_title:              "المسمى الوظيفي غير واضح أو غير موجود",
    missing_category:           "التصنيف غير واضح",
    missing_contact:            "معلومات التواصل غير موجودة",
    missing_application_method: "طريقة التقديم غير واضحة",
    low_confidence:             "درجة الثقة منخفضة",
    multi_role:                 "الإعلان يحتوي أكثر من وظيفة",
    title_equals_company:       "المسمى الوظيفي مطابق لاسم الشركة",
    contact_extraction_missed:  "يوجد تواصل في النص لكن لم يُستخرج",
    bad_salary:                 "حقل الراتب غير واضح",
    salary_looks_like_phone:    "قيمة الراتب تبدو كرقم هاتف",
    ai_failed:                  "فشل التحليل الآلي",
    publish_send_failed:        "فشل إرسال الإعلان إلى كروب النشر",
    review_send_failed:         "فشل إرسال الإعلان إلى كروب المراجعة"
  };
  return reason.split(",").map(x => x.trim()).filter(Boolean)
    .map(x => {
      const key = x.startsWith("publish_send_failed") ? "publish_send_failed"
        : x.startsWith("review_send_failed") ? "review_send_failed" : x;
      return `- ${map[key] || x}`;
    }).join("\n");
}
