// ============================================================
// classifier.js — التحليل بالذكاء الاصطناعي ومعالجة النتائج
// ============================================================

import { OPENAI_API_KEY, MODEL_NAME } from "./config.js";
import { normalizeInline, toNullableString } from "./helpers.js";
import {
  extractJobTitle, cleanJobTitle, isGoodTitle,
  extractCompany, cleanupCompanyName,
  extractLocation, extractEmploymentType, extractExperience,
  smartSalary, smartContact, isLikelySalaryValue, hasAnyContact,
  inferApplicationMethod, fallbackCategory
} from "./extractor.js";

// =========================
// التلميحات الأولية قبل AI
// =========================
export function buildHeuristicHints(rawText = "", cleanText = "") {
  const text = cleanText || rawText;
  const contact = smartContact(text);
  return {
    title_hint:              extractJobTitle(text),
    company_hint:            extractCompany(text),
    location_hint:           extractLocation(text),
    employment_type_hint:    extractEmploymentType(text),
    experience_hint:         extractExperience(text),
    salary_hint:             smartSalary(text),
    contact_hint:            contact,
    application_method_hint: inferApplicationMethod(text, contact),
    category_hint:           fallbackCategory(text, extractJobTitle(text))
  };
}

// =========================
// استدعاء OpenAI
// =========================
export async function extractWithAI(rawText, cleanText) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title:              { type: "string" },
      category: {
        type: "string",
        enum: ["HR","Admin","Sales","Customer Service","Accounting","Finance",
          "Engineering","IT","Design","Marketing","Logistics","Procurement",
          "Legal","Medical","Education","Operations","Management","Hospitality","Security","Other"]
      },
      company:            { type: "string" },
      location:           { type: "string" },
      employment_type:    { type: "string" },
      experience:         { type: "string" },
      salary:             { type: "string" },
      contact:            { type: "string" },
      application_method: { type: "string" },
      is_multi_role:      { type: "boolean" },
      confidence:         { type: "number" },
      summary:            { type: "string" }
    },
    required: ["title","category","company","location","employment_type","experience",
      "salary","contact","application_method","is_multi_role","confidence","summary"]
  };

  const hints = buildHeuristicHints(rawText, cleanText);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL_NAME,
        temperature: 0,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: `
أنت نظام احترافي لاستخراج بيانات إعلانات الوظائف العربية، خصوصاً إعلانات تيليجرام العراقية.
قواعد صارمة:
1) لا تخترع أي معلومة. اكتب "غير مذكور" إذا لم تجد المعلومة.
2) title = اسم الوظيفة فقط. company = اسم الجهة فقط.
3) salary لا تستنتجه من رقم هاتف أو رقم عشوائي.
4) is_multi_role = true إذا الإعلان يحتوي أكثر من وظيفة.
5) confidence رقم من 0 إلى 1.
6) summary مختصر جداً سطر واحد.
7) أعد JSON فقط.`.trim() }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: `
RAW AD:\n"""\n${rawText}\n"""
CLEAN AD:\n"""\n${cleanText}\n"""
HEURISTIC HINTS:\n${JSON.stringify(hints, null, 2)}`.trim() }]
          }
        ],
        text: { format: { type: "json_schema", name: "job_ad_extraction_v4", strict: true, schema } }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.log("OpenAI error:", { status: response.status, data });
      return { __ai_failed__: true, __error__: JSON.stringify({ status: response.status, data }).slice(0, 1500) };
    }

    let content = data.output_text || "";
    if (!content && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === "output_text" && c.text) { content = c.text; break; }
          }
        }
        if (content) break;
      }
    }

    if (!content) return { __ai_failed__: true, __error__: "empty_output" };
    return JSON.parse(content);
  } catch (err) {
    console.log("AI extract error:", err);
    return { __ai_failed__: true, __error__: String(err) };
  }
}

// =========================
// تنظيف نتيجة الـ AI وتصحيحها
// =========================
export function cleanAIResult(aiData, rawText = "", cleanText = "") {
  if (!aiData || typeof aiData !== "object") return null;
  if (aiData.__ai_failed__) return null;

  const hints = buildHeuristicHints(rawText, cleanText);

  let title              = cleanJobTitle(aiData.title || "");
  let company            = cleanupCompanyName(aiData.company || "");
  let location           = toNullableString(aiData.location);
  let employment_type    = toNullableString(aiData.employment_type);
  let experience         = toNullableString(aiData.experience);
  let salary             = toNullableString(aiData.salary);
  let contact            = toNullableString(aiData.contact);
  let application_method = toNullableString(aiData.application_method);
  let category           = toNullableString(aiData.category);
  let summary            = toNullableString(aiData.summary);
  let is_multi_role      = Boolean(aiData.is_multi_role);
  let confidence         = Number(aiData.confidence);

  // تصحيح بالتلميحات إذا كانت نتيجة الـ AI ناقصة
  if (!isGoodTitle(title))    title    = isGoodTitle(hints.title_hint) ? hints.title_hint : "غير مذكور";
  if (company === "غير مذكور") company  = hints.company_hint;
  if (location === "غير مذكور") location = hints.location_hint;
  if (employment_type === "غير مذكور") employment_type = hints.employment_type_hint;
  if (experience === "غير مذكور") experience = hints.experience_hint;
  if (contact === "غير مذكور" || !hasAnyContact(contact)) contact = hints.contact_hint;
  if (salary === "غير مذكور" || !isLikelySalaryValue(salary))
    salary = isLikelySalaryValue(hints.salary_hint) ? hints.salary_hint : "غير مذكور";
  if (application_method === "غير مذكور") application_method = hints.application_method_hint;
  if (!category || category === "غير مذكور") category = hints.category_hint;

  // تصحيح: إذا title = company خطأ
  if (title !== "غير مذكور" && company !== "غير مذكور") {
    const t = normalizeInline(title).toLowerCase();
    const c = normalizeInline(company).toLowerCase();
    if (t === c) {
      if (isGoodTitle(hints.title_hint) && normalizeInline(hints.title_hint).toLowerCase() !== c)
        title = hints.title_hint;
      else company = "غير مذكور";
    }
  }

  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  if (summary === "غير مذكور" || summary.length > 220) {
    summary = `إعلان لوظيفة ${title !== "غير مذكور" ? title : "غير محددة"}${company !== "غير مذكور" ? ` لدى ${company}` : ""}${location !== "غير مذكور" ? ` في ${location}` : ""}.`;
  }

  return { title, category, company, location, employment_type, experience,
    salary, contact, application_method, is_multi_role, confidence, summary };
}
