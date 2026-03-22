import { OPENAI_API_KEY, MODEL_NAME, CATEGORY_ENUM, AUTO_PUBLISH_MIN_SCORE, REVIEW_MIN_SCORE, TG_MAX_LENGTH } from "./config.js";
import {
  buildHeuristicHints, cleanJobTitle, cleanupCompanyName, toNullableString,
  isGoodTitle, isLikelySalaryValue, cleanSalaryValue, isLikelyPhone,
  hasAnyContact, containsPhoneNumber, normalizeInline
} from "./helpers.js";

export async function extractWithAI(rawText, cleanText) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      category: {
        type: "string",
        enum: [
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
          "Security",
          "Other"
        ]
      },
      company: { type: "string" },
      location: { type: "string" },
      employment_type: { type: "string" },
      experience: { type: "string" },
      salary: { type: "string" },
      contact: { type: "string" },
      application_method: { type: "string" },
      is_multi_role: { type: "boolean" },
      confidence: { type: "number" },
      summary: { type: "string" }
    },
    required: [
      "title",
      "category",
      "company",
      "location",
      "employment_type",
      "experience",
      "salary",
      "contact",
      "application_method",
      "is_multi_role",
      "confidence",
      "summary"
    ]
  };

  const hints = buildHeuristicHints(rawText, cleanText);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        temperature: 0,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: `
أنت نظام احترافي لاستخراج بيانات إعلانات الوظائف العربية، خصوصاً إعلانات تيليجرام العراقية.

مهمتك:
قراءة النص الخام + النص المنظف + التلميحات الأولية الناتجة من القواعد، ثم إخراج JSON دقيق جداً.

قواعد صارمة جداً:
1) لا تخترع أي معلومة غير موجودة بوضوح.
2) إذا كانت المعلومة غير موجودة اكتب "غير مذكور".
3) title = اسم الوظيفة فقط، وليس جملة طويلة أو اسم شركة أو وصف.
4) company = اسم الجهة فقط، وليس المسمى الوظيفي.
5) إذا كنت متردداً بين title و company فلا تخلط بينهما.
6) contact يجب أن يحتوي وسائل التواصل الواضحة فقط.
7) application_method يجب أن يكون واحداً من: واتساب / إيميل / هاتف / تيليجرام / إيميل / إرسال CV / غير مذكور.
8) location لا تُخترع. إذا ذُكرت منطقة مثل الكرادة فاكتبها كما هي.
9) salary لا تستنتجه من رقم هاتف أو رقم عشوائي. أرقام الهواتف العراقية تبدأ بـ +964 أو 077 أو 078 وتتكون من 9 أرقام أو أكثر. الراتب لا يتجاوز 7 أرقام. إذا كان حقل الراتب يحتوي رقم هاتف مدمج فأزل رقم الهاتف واترك الراتب فقط.
10) location يجب أن يكون اسم مدينة أو منطقة فقط، وليس وصف طويل. الحد الأقصى 100 حرف.
11) إذا الإعلان يحتوي أكثر من وظيفة واضحة ضع is_multi_role = true.
12) confidence رقم من 0 إلى 1.
13) summary مختصر جداً، سطر واحد فقط، دون اختراع أي معلومة.
14) إذا كانت التلميحات الأولية صحيحة فاستخدمها، وإذا كانت خاطئة تجاهلها. التلميحات ليست حقائق ملزمة.
15) contact يجب أن يشمل أيضاً حسابات تيليجرام مثل @username إذا وجدت.
16) أعد JSON فقط.

قواعد التصنيف (category) المهمة جداً:
- لا يوجد تصنيف "Design". كل وظائف التصميم والجرافيك والمونتاج والمصور وكاتب المحتوى وصناعة المحتوى وسوشيال ميديا = "Marketing".
- مدخل بيانات / مدخلة بيانات / Data Entry / إدخال بيانات = "Admin" وليس "IT".
- وظائف السياحة والسفر والفنادق وتطوير الأعمال السياحية وOTA = "Hospitality".
- وظائف الألعاب والكيمنك والبلي ستيشن والترفيه = "Hospitality" وليس "IT".
- "IT" فقط للبرمجة والشبكات والدعم التقني الحقيقي.
                `.trim()
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `
RAW AD:
"""
${rawText}
"""

CLEAN AD:
"""
${cleanText}
"""

HEURISTIC HINTS:
${JSON.stringify(hints, null, 2)}
                `.trim()
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "job_ad_extraction_v4",
            strict: true,
            schema
          }
        }
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.log("OpenAI API error:", {
        status: response.status,
        model: MODEL_NAME,
        data
      });
      return {
        __ai_failed__: true,
        __error__: JSON.stringify({
          status: response.status,
          model: MODEL_NAME,
          data
        }).slice(0, 1500)
      };
    }

    let content = data.output_text || "";

    if (!content && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === "output_text" && c.text) {
              content = c.text;
              break;
            }
          }
        }
        if (content) break;
      }
    }

    if (!content) {
      console.log("OpenAI empty output:", data);
      return {
        __ai_failed__: true,
        __error__: "empty_output"
      };
    }

    return JSON.parse(content);
  } catch (err) {
    console.log("AI extract error:", err);
    return {
      __ai_failed__: true,
      __error__: String(err)
    };
  }
}

// =========================

export function cleanAIResult(aiData, rawText = "", cleanText = "") {
  if (!aiData || typeof aiData !== "object") return null;
  if (aiData.__ai_failed__) return null;

  const hints = buildHeuristicHints(rawText, cleanText);

  let title = cleanJobTitle(aiData.title || "");
  let company = cleanupCompanyName(aiData.company || "");
  let location = toNullableString(aiData.location);
  let employment_type = toNullableString(aiData.employment_type);
  let experience = toNullableString(aiData.experience);
  let salary = toNullableString(aiData.salary);
  let contact = toNullableString(aiData.contact);
  let application_method = toNullableString(aiData.application_method);
  let category = toNullableString(aiData.category);
  // Remap removed categories
  if (category === "Design") category = "Marketing";
  let summary = toNullableString(aiData.summary);
  let is_multi_role = Boolean(aiData.is_multi_role);
  let confidence = Number(aiData.confidence);

  if (!isGoodTitle(title)) {
    title = isGoodTitle(hints.title_hint) ? hints.title_hint : "غير مذكور";
  }

  if (company === "غير مذكور") {
    company = hints.company_hint;
  }

  if (location === "غير مذكور") {
    location = hints.location_hint;
  }

  if (employment_type === "غير مذكور") {
    employment_type = hints.employment_type_hint;
  }

  if (experience === "غير مذكور") {
    experience = hints.experience_hint;
  }

  if (contact === "غير مذكور" || !hasAnyContact(contact)) {
    contact = hints.contact_hint;
  }

  if (salary === "غير مذكور" || !isLikelySalaryValue(salary)) {
    salary = isLikelySalaryValue(hints.salary_hint) ? hints.salary_hint : "غير مذكور";
  }

  // Clean phone numbers and contact info from salary
  if (salary !== "غير مذكور") {
    salary = cleanSalaryValue(salary);
    // After cleaning, re-validate
    if (!salary || salary === "غير مذكور" || isLikelyPhone(salary)) {
      salary = "غير مذكور";
    }
  }

  // Truncate location if it's way too long (overflow from AI)
  if (location.length > 120) {
    location = hints.location_hint || "غير مذكور";
  }

  if (application_method === "غير مذكور") {
    application_method = hints.application_method_hint;
  }

  if (!category || category === "غير مذكور") {
    category = hints.category_hint;
  }

  if (title !== "غير مذكور" && company !== "غير مذكور") {
    const t = normalizeInline(title).toLowerCase();
    const c = normalizeInline(company).toLowerCase();

    if (t === c) {
      if (isGoodTitle(hints.title_hint) && normalizeInline(hints.title_hint).toLowerCase() !== c) {
        title = hints.title_hint;
      } else {
        company = "غير مذكور";
      }
    }
  }

  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  if (summary === "غير مذكور" || summary.length > 220) {
    summary = `إعلان لوظيفة ${title !== "غير مذكور" ? title : "غير محددة"}${company !== "غير مذكور" ? ` لدى ${company}` : ""}${location !== "غير مذكور" ? ` في ${location}` : ""}.`;
  }

  return {
    title,
    category,
    company,
    location,
    employment_type,
    experience,
    salary,
    contact,
    application_method,
    is_multi_role,
    confidence,
    summary
  };
}

export function validateResult(result, rawText = "", cleanText = "") {
  const issues = [];
  let score = 0;

  const text = cleanText || rawText;

  if (result?.title && result.title !== "غير مذكور" && isGoodTitle(result.title)) {
    score += 25;
  } else {
    issues.push("missing_title");
  }

  if (result?.category && result.category !== "غير مذكور") {
    score += 15;
  } else {
    issues.push("missing_category");
  }

  if (result?.contact && result.contact !== "غير مذكور") {
    score += 20;
  } else {
    issues.push("missing_contact");
  }

  if (result?.application_method && result.application_method !== "غير مذكور") {
    score += 10;
  } else {
    issues.push("missing_application_method");
  }

  if (result?.company && result.company !== "غير مذكور") {
    score += 10;
  }

  if (result?.location && result.location !== "غير مذكور") {
    score += 5;
  }

  if (result?.salary && result.salary !== "غير مذكور") {
    if (isLikelySalaryValue(result.salary)) {
      score += 5;
    } else {
      issues.push("bad_salary");
      score -= 10;
    }
  }

  if (typeof result?.confidence === "number") {
    if (result.confidence >= 0.9) score += 15;
    else if (result.confidence >= 0.8) score += 12;
    else if (result.confidence >= 0.7) score += 9;
    else if (result.confidence >= 0.6) score += 6;
    else if (result.confidence >= 0.5) score += 3;
    else issues.push("low_confidence");
  } else {
    issues.push("missing_confidence");
  }

  if (result?.is_multi_role) {
    issues.push("multi_role");
    score -= 20;
  }

  if (result?.title && result?.company && result.title !== "غير مذكور" && result.company !== "غير مذكور") {
    if (normalizeInline(result.title).toLowerCase() === normalizeInline(result.company).toLowerCase()) {
      issues.push("title_equals_company");
      score -= 15;
    }
  }

  if (result?.contact === "غير مذكور" && hasAnyContact(text)) {
    issues.push("contact_extraction_missed");
    score -= 15;
  }

  if (result?.salary !== "غير مذكور" && containsPhoneNumber(result.salary)) {
    issues.push("salary_looks_like_phone");
    score -= 20;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    is_valid: score >= REVIEW_MIN_SCORE,
    score,
    issues
  };
}

export function decideStrict(validated) {
  const { score, issues } = validated;

  const hardBlocks = [
    "multi_role",
    "title_equals_company",
    "salary_looks_like_phone"
  ];

  if (
    score >= AUTO_PUBLISH_MIN_SCORE &&
    !issues.some(x => hardBlocks.includes(x))
  ) {
    return {
      bucket: "QUDRAT",
      reason: "high_confidence"
    };
  }

  return {
    bucket: "REVIEW",
    reason: issues.length ? issues.join(",") : "needs_review"
  };
}


export function translateReviewReason(reason = "") {
  const map = {
    missing_title: "المسمى الوظيفي غير واضح أو غير موجود",
    missing_category: "التصنيف غير واضح",
    missing_contact: "معلومات التواصل غير موجودة",
    missing_application_method: "طريقة التقديم غير واضحة",
    low_confidence: "درجة الثقة منخفضة",
    multi_role: "الإعلان يحتوي أكثر من وظيفة",
    title_equals_company: "المسمى الوظيفي يبدو مطابقًا لاسم الشركة بشكل غير صحيح",
    contact_extraction_missed: "يوجد تواصل في النص لكن لم يتم استخراجه بشكل صحيح",
    bad_salary: "حقل الراتب غير واضح أو غير صحيح",
    salary_looks_like_phone: "قيمة الراتب تبدو كأنها رقم هاتف",
    ai_failed: "فشل التحليل الآلي",
    publish_send_failed: "فشل إرسال الإعلان إلى كروب النشر",
    review_send_failed: "فشل إرسال الإعلان إلى كروب المراجعة"
  };

  return reason
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => {
      // Show actual Telegram error alongside translation
      if (x.startsWith("publish_send_failed:")) {
        const tgError = x.replace("publish_send_failed:", "").trim();
        return `- ${map["publish_send_failed"]}\n  ⚡ TG Error: ${tgError}`;
      }
      if (x.startsWith("review_send_failed:")) {
        const tgError = x.replace("review_send_failed:", "").trim();
        return `- ${map["review_send_failed"]}\n  ⚡ TG Error: ${tgError}`;
      }
      const key = x;
      return `- ${map[key] || x}`;
    })
    .join("\n");
}


export function buildPublishedText(result, rawText) {
  const header = `📌 فرصة عمل

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
`;

  const maxRaw = TG_MAX_LENGTH - header.length - 20;
  const truncatedRaw = rawText.length > maxRaw
    ? rawText.slice(0, maxRaw) + "\n... (تم اقتطاع النص)"
    : rawText;

  return header + truncatedRaw;
}

export function buildReviewText(reason, rawText, cleanText, aiResult, validation) {
  const base = `📋 إعلان بحاجة مراجعة

سبب التحويل:
${translateReviewReason(reason)}

──────────────
📊 Score: ${validation?.score ?? 0}/100
⚠️ Issues: ${validation?.issues?.join(" | ") || "لا يوجد"}

──────────────
🤖 نتيجة التحليل:
${JSON.stringify(aiResult, null, 2)}

──────────────
📄 النص الأصلي:
`;

  const maxRaw = TG_MAX_LENGTH - base.length - 20;
  const truncatedRaw = rawText.length > maxRaw
    ? rawText.slice(0, maxRaw) + "\n... (تم اقتطاع النص)"
    : rawText;

  return base + truncatedRaw;
}

