import crypto from "crypto";

// =========================
// Text Normalization
// =========================
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
  return normalizeText(text)
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);
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
    .replace(/~{2,}/g, " ");

  x = x
    .replace(/\bواتس(?:اب)?\b/gi, "واتساب")
    .replace(/\bwhats\s*app\b/gi, "WhatsApp")
    .replace(/\bhr\b/gi, "HR")
    .replace(/\bcv\b/gi, "CV");

  x = x
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+\n/g, "\n\n");

  return x.trim();
}

// =========================
// Contact Extraction
// =========================
export function extractPhones(text = "") {
  const matches = normalizeText(text).match(/\+?\d[\d\s\-()]{7,}\d/g) || [];
  return unique(
    matches
      .map(x => normalizeInline(x).replace(/[()]/g, ""))
      .filter(x => x.replace(/[^\d]/g, "").length >= 8)
  );
}

export function extractEmails(text = "") {
  const matches = normalizeText(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  return unique(matches.map(x => normalizeInline(x)));
}

export function extractLinks(text = "") {
  const matches = normalizeText(text).match(/https?:\/\/\S+|t\.me\/\S+|telegram\.me\/\S+/ig) || [];
  return unique(matches.map(x => normalizeInline(x)));
}

export function extractTelegramHandles(text = "") {
  const matches = normalizeText(text).match(/@[A-Za-z][A-Za-z0-9_]{3,}/g) || [];
  return unique(matches.filter(x => !/@(gmail|yahoo|outlook|hotmail|company|email)\b/i.test(x)));
}

export function hasAnyContact(text = "") {
  return extractPhones(text).length > 0 || extractEmails(text).length > 0 || extractLinks(text).length > 0 || extractTelegramHandles(text).length > 0;
}

export function smartContact(text = "") {
  const phones = extractPhones(text);
  const emails = extractEmails(text);
  const links = extractLinks(text);
  const handles = extractTelegramHandles(text);
  const list = unique([...phones, ...emails, ...links, ...handles]);
  return list.length ? list.join(" | ") : "غير مذكور";
}

export function isLikelyPhone(s = "") {
  const x = normalizeInline(s).replace(/[\s\-()]/g, "");
  const digits = x.replace(/[^\d]/g, "");
  if (digits.length >= 9 && /^(\+?964|077|078|079|076|075|07[0-9])/.test(x)) return true;
  if (digits.length >= 9) return true;
  return false;
}

export function containsPhoneNumber(s = "") {
  const x = normalizeInline(s);
  return /(?:\+?964|07[0-9])\s*\d[\d\s\-]{6,}\d/.test(x);
}

export function isLikelyEmail(s = "") {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(normalizeInline(s));
}

// =========================
// Salary
// =========================
export function isLikelySalaryValue(s = "") {
  const x = normalizeInline(s);
  if (!x || x === "غير مذكور") return false;
  if (isLikelyEmail(x)) return false;
  if (/(واتساب|whatsapp|gmail|yahoo|outlook|cv|@|telegram|t\.me)/i.test(x)) return false;
  if (isLikelyPhone(x)) return false;
  const hasSalaryPattern = /(\d{1,3}(?:[,\.\s]\d{3})+|\d{3,7})/.test(x) || /(دينار|دولار|\$|IQD|USD|شهري|يومي|نسبة|الف|ألف)/i.test(x);
  if (!hasSalaryPattern) return false;
  return true;
}

export function cleanSalaryValue(s = "") {
  let x = normalizeInline(s);
  x = x.replace(/(?:\+?964|07[0-9])\s*\d[\d\s\-]{6,}\d/g, "").trim();
  x = x.replace(/\b\d{9,}\b/g, "").trim();
  x = x.replace(/\s*(للتواصل|للتقديم|واتساب|واتساپ|whatsapp|ارسال|إرسال|على الرقم|التواصل|cv|السيرة الذاتية).*/i, "").trim();
  x = x.replace(/[:\-–—|]+$/, "").trim();
  return x || "غير مذكور";
}

export function smartSalary(text = "") {
  const lines = linesOf(text);

  for (const line of lines) {
    const m = line.match(/(?:الراتب|راتب|الأجر|الاجر|salary)\s*[:：\-–—]?\s*([^\n\r]{2,120})/i);
    if (m?.[1]) {
      const value = normalizeInline(m[1]);
      if (isLikelySalaryValue(value)) return value;
    }
  }

  for (const line of lines) {
    if (/(دينار|دولار|\$|IQD|USD|نسبة)/i.test(line) && isLikelySalaryValue(line)) {
      return normalizeInline(line);
    }
  }

  return "غير مذكور";
}

// =========================
// Location
// =========================
const IRAQ_CITIES = [
  "بغداد", "البصرة", "أربيل", "اربيل", "دهوك", "السليمانية", "النجف", "كربلاء", "الناصرية",
  "الموصل", "كركوك", "الأنبار", "الانبار", "الحلة", "واسط", "الديوانية", "ديالى", "ميسان",
  "ذي قار", "تكريت", "صلاح الدين", "السماوة", "بابل"
];

const BAGHDAD_AREAS = [
  "الكرادة", "المنصور", "الجادرية", "الزيونة", "العامرية", "الدورة", "الكاظمية", "الأعظمية",
  "الاعظمية", "اليرموك", "الشعب", "الغدير", "المنطقة الخضراء", "ساحة عدن", "البنوك", "السيدية",
  "الحارثية", "العدل", "حي الجامعة", "بغداد الجديدة", "البياع", "البكرية"
];

export function extractLocation(text = "") {
  const x = normalizeText(text);
  const lines = linesOf(text);

  for (const line of lines.slice(0, 15)) {
    const m = line.match(/(?:الموقع|العنوان|مكان العمل|موقع العمل|location|مكان العمل)\s*[:：\-–—]?\s*(.+)$/i);
    if (m?.[1]) return normalizeInline(m[1]);
  }

  for (const city of IRAQ_CITIES) { if (x.includes(city)) return city; }
  for (const area of BAGHDAD_AREAS) { if (x.includes(area)) return area; }

  const m = x.match(/(?:في|داخل|ضمن|منطقة)\s+(بغداد|البصرة|أربيل|اربيل|دهوك|السليمانية|النجف|كربلاء|الموصل|كركوك|الكرادة|المنصور|الجادرية|الزيونة|اليرموك|السيدية|البياع|البكرية)/i);
  if (m?.[1]) return normalizeInline(m[1]);

  return "غير مذكور";
}

// =========================
// Company / Title
// =========================
export function cleanupCompanyName(s = "") {
  let x = normalizeInline(s);
  x = stripEmojis(x);
  x = x.replace(/^(?:اسم الشركة|الشركة)\s*[:：]\s*/i, "").trim();
  x = x.replace(/^(?:تعلن|يعلن)\s+/i, "").trim();
  x = x.replace(/(عن حاجتها|بحاجتها|لتعيين|لتوظيف|تطلب|المطلوب|الراتب|التواصل|واتساب|طريقة التواصل|الدوام|الموقع).*$/i, "").trim();
  x = x.replace(/[|]/g, " ").trim();
  x = x.replace(/\s{2,}/g, " ").trim();

  if (!x) return "غير مذكور";
  if (isLikelyPhone(x) || isLikelyEmail(x)) return "غير مذكور";
  if (x.length > 80) return "غير مذكور";
  if (/^(مطلوب|مطلوبة|موظف|موظفة|محاسب|كاشير|مندوب|مسؤول|موظفين)$/i.test(x)) return "غير مذكور";

  return x;
}

export function extractCompany(text = "") {
  const normalized = normalizeText(text);
  const lines = linesOf(text);

  let m = normalized.match(/(?:تعلن|يعلن)\s+(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون|وكالة)\s+([^\n]{2,80})/i);
  if (m) {
    const c = cleanupCompanyName(`${m[1]} ${m[2]}`);
    if (c !== "غير مذكور") return c;
  }

  for (const line of lines.slice(0, 12)) {
    m = line.match(/^(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون)\s+([^\n]{2,80})/i);
    if (m) {
      const c = cleanupCompanyName(`${m[1]} ${m[2]}`);
      if (c !== "غير مذكور") return c;
    }
  }

  for (const line of lines.slice(0, 12)) {
    m = line.match(/^(?:اسم الشركة|الشركة|اسم الصالون|اسم المركز)\s*[:：]\s*(.+)$/i);
    if (m?.[1]) {
      const c = cleanupCompanyName(m[1]);
      if (c !== "غير مذكور") return c;
    }
  }

  return "غير مذكور";
}

const BAD_TITLES = [
  "غير مذكور", "مطلوب", "مطلوبة", "موظف", "موظفة", "موظفين", "موظفات",
  "فرصة عمل", "وظيفة", "وظيفة شاغرة",
  "اعلان وظائف جديد", "اعلان وظائف", "اعلان توظيف", "إعلان وظيفة",
  "مطلوب موظف", "مطلوب موظفة", "مطلوب موظفين", "مطلوب موظفات",
  "واتساب", "whatsapp", "للتواصل", "الرقم", "الشركة", "اسم الشركة"
];

export function isBadGenericTitle(x = "") {
  return BAD_TITLES.includes(normalizeInline(x).toLowerCase());
}

export function cleanJobTitle(s = "") {
  let x = normalizeInline(s);
  x = stripEmojis(x);
  x = x
    .replace(/^(مطلوب|مطلوبة|نبحث عن|فرصة عمل|وظيفة شاغرة|بحاجة الى|بحاجة إلى|Hiring|Position)\s+/i, "")
    .replace(/^(?:تعلن شركة|يعلن مكتب|تعلن مؤسسة)\s+/i, "")
    .replace(/\b(ذكور|إناث|للجنسين|للذكور|للاناث|للإناث|أنثى|ذكر)\b/gi, "")
    .replace(/\s+(?:في|للعمل في|للعمل لدى|داخل|ضمن)\s+(شركة|مطعم|معهد|وكالة|مؤسسة|مكتب|معمل|مصنع|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون).*/i, "")
    .replace(/\s+(?:براتب|راتب|الراتب|الدوام|الموقع|العنوان|التواصل|واتساب|تفاصيل|الشروط|للتقديم)\b.*$/i, "")
    .replace(/[|:\-–—].*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!x || isBadGenericTitle(x)) return "غير مذكور";
  if (x.length > 60) return "غير مذكور";
  return x;
}

export function isGoodTitle(t = "") {
  const x = normalizeInline(t).toLowerCase();
  if (!x) return false;
  if (isBadGenericTitle(x)) return false;
  if (x.length < 2 || x.length > 60) return false;
  if (/(واتساب|whatsapp|للتواصل|اتصال|هاتف|رقم|ايميل|email)/i.test(x)) return false;
  if (/(راتب|الراتب|الدوام|الموقع|العنوان|الشركة|تفاصيل|التقديم|cv)/i.test(x)) return false;
  return true;
}

export function extractJobTitle(text = "") {
  const lines = linesOf(text);

  for (const line of lines.slice(0, 12)) {
    let m = line.match(/^(?:عنوان\s*الوظيف(?:ة|ي)|المسمى الوظيفي|العنوان الوظيفي|Job Title)\s*[:：]\s*(.+)$/i);
    if (m?.[1]) { const t = cleanJobTitle(m[1]); if (isGoodTitle(t)) return t; }

    m = line.match(/^(?:مطلوب|مطلوبة|فرصة عمل|وظيفة شاغرة|نبحث عن|بحاجة الى|بحاجة إلى|Hiring|Position)\s*[:：\-–—]?\s*(.+)$/i);
    if (m?.[1]) { const t = cleanJobTitle(m[1]); if (isGoodTitle(t)) return t; }
  }

  for (const line of lines.slice(0, 8)) {
    const t = cleanJobTitle(line);
    if (isGoodTitle(t)) return t;
  }

  return "غير مذكور";
}

export function extractExperience(text = "") {
  const lines = linesOf(text);
  for (const line of lines) {
    const m = line.match(/(?:خبرة|الخبرة|سنوات الخبرة|experience)\s*[:：\-–—]?\s*([^\n\r]{2,80})/i);
    if (m?.[1]) return normalizeInline(m[1]);
  }
  const x = normalizeText(text);
  const m = x.match(/(\d+\s*(?:سنة|سنوات|year|years))/i);
  if (m?.[1]) return normalizeInline(m[1]);
  return "غير مذكور";
}

export function fallbackCategory(text = "", title = "") {
  const s = normalizeInline(`${title} ${text}`).toLowerCase();

  if (/(hr|human resources|موارد بشرية|توظيف|recruit)/i.test(s)) return "HR";
  if (/(admin|إداري|اداري|استقبال|رسبشن|سكرتير|سكرتارية|office|مدخل بيانات|مدخلة بيانات|data entry|إدخال بيانات|ادخال بيانات|مراقب كاميرات|كاميرات|cctv|حارس|حراسة|أمن|امن|security|guard)/i.test(s)) return "Admin";
  if (/(hotel|مطعم|مقهى|barista|chef|hospitality|ضيافة|طباخ|سياحة|سياحي|سياحية|سفر|travel|tourism|فندق|فندقي|فندقية|OTA|كيمنك|gaming|بلي بنت|بلي ستيشن|playstation|ألعاب|العاب|صالة ألعاب|صالة العاب|نادي|ترفيه|entertainment|مجهز طلبات|مجهزة طلبات|ويتر|waiter|شيف|فحام|باريستا|مضيف|مضيفة|مشرف صالة|كابتن صالة)/i.test(s)) return "Hospitality";
  if (/(sales|مبيعات|مندوب|مندوبة|كاشير|cashier|مستشارة مبيعات|موظفه مبيعات|موظفة مبيعات)/i.test(s)) return "Sales";
  if (/(customer service|خدمة عملاء|call center)/i.test(s)) return "Customer Service";
  if (/(account|محاسب|محاسبة|حسابات|finance|مالي|محاسبه)/i.test(s)) return "Accounting";
  if (/(engineer|مهندس|فني صيانة|maintenance)/i.test(s)) return "Engineering";
  if (/(developer|programmer|it support|it|شبكات|تقنية|برمجة|technical support)/i.test(s)) return "IT";
  if (/(marketing|تسويق|مروج|مروجة|designer|تصميم|مصمم|جرافيك|مونتاج|مونتير|مصور|مصورة|كاتب محتوى|كاتبة محتوى|صناعة محتوى|صانع محتوى|content|سوشيال ميديا|social media|ميديا|مدير سوشيال|مدير محتوى|مدير تسويق)/i.test(s)) return "Marketing";
  if (/(manager|management|مدير فرع|مدير عام|مدير مشتريات|مدير مالي|مدير إداري|مدير اداري|مدير عمليات|مدير موارد|مدير انتاج|مدير إنتاج|مدير مبيعات|مدير تشغيل|مشرف|supervisor|ceo|cfo|coo|cto)/i.test(s)) return "Management";
  if (/(driver|سائق|توصيل|لوجست|مخزن|warehouse|storekeeper)/i.test(s)) return "Logistics";
  if (/(مشتريات|procurement|buyer)/i.test(s)) return "Procurement";
  if (/(قانوني|محامي|legal)/i.test(s)) return "Legal";
  if (/(طبي|صيدل|تمريض|مختبر|عيادة|مركز طبي|مستشفى|تنظيف البشرة|كوافيرة|صالون)/i.test(s)) return "Medical";
  if (/(مدرس|تدريس|معهد|teacher|education)/i.test(s)) return "Education";
  if (/(operations|تشغيل|مشرف عمليات)/i.test(s)) return "Operations";

  return "Other";
}

export function toNullableString(v) {
  if (v === null || v === undefined) return "غير مذكور";
  const x = normalizeInline(String(v));
  return x || "غير مذكور";
}

export function buildHeuristicHints(rawText = "", cleanText = "") {
  const text = cleanText || rawText;
  return {
    title_hint: extractJobTitle(text),
    company_hint: extractCompany(text),
    location_hint: extractLocation(text),
    experience_hint: extractExperience(text),
    salary_hint: smartSalary(text),
    contact_hint: smartContact(text),
    category_hint: fallbackCategory(text, extractJobTitle(text))
  };
}

export function isNotJobAd(text = "") {
  const x = normalizeText(text).toLowerCase();
  if (/(نستقبل الإعلانات التجارية|إعلانات تجارية|الإعلانات التجارية متاحة)/i.test(x)) return true;
  if (/(تنويه مهم|ملاحظة إدارية|بيان من الإدارة)/i.test(x) && !/(مطلوب|وظيفة|توظيف|فرصة عمل)/i.test(x)) return true;
  if (x.length < 30) return true;
  return false;
}
