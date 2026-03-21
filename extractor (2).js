// ============================================================
// extractor.js — استخراج بيانات الإعلان (تواصل، راتب، موقع، مسمى، شركة)
// ============================================================

import { normalizeText, normalizeInline, stripEmojis, unique, linesOf } from "./helpers.js";

// =========================
// التواصل
// =========================
export function extractPhones(text = "") {
  const matches = normalizeText(text).match(/\+?\d[\d\s\-()]{7,}\d/g) || [];
  return unique(
    matches.map(x => normalizeInline(x).replace(/[()]/g, ""))
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

export function hasAnyContact(text = "") {
  return extractPhones(text).length > 0
    || extractEmails(text).length > 0
    || extractLinks(text).length > 0;
}

export function smartContact(text = "") {
  const list = unique([...extractPhones(text), ...extractEmails(text), ...extractLinks(text)]);
  return list.length ? list.join(" | ") : "غير مذكور";
}

export function isLikelyPhone(s = "") {
  return /^(?:\+?\d[\d\s\-]{7,}\d)$/.test(normalizeInline(s));
}

export function isLikelyEmail(s = "") {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(normalizeInline(s));
}

// =========================
// الراتب
// =========================
export function isLikelySalaryValue(s = "") {
  const x = normalizeInline(s);
  if (!x || x === "غير مذكور") return false;
  if (isLikelyPhone(x) || isLikelyEmail(x)) return false;
  if (/(واتساب|whatsapp|gmail|yahoo|outlook|cv|@|telegram|t\.me)/i.test(x)) return false;
  return /(\d{1,3}(?:[,\.\s]\d{3})+|\d{5,})/.test(x)
    || (/\d/.test(x) && x.length < 80 && /(دينار|دولار|\$|IQD|USD|شهري|يومي|نسبة)/i.test(x))
    || /\d{2,4}\s*(الف|ألف|آلاف|الاف|الف دينار|ألف دينار)/i.test(x)
    || /\d{2,4}\s*(مع\s*نسب)/i.test(x)
    || /^\d{3,4}(?:\s*[-–—]\s*\d{3,4})?\b/.test(x.trim())
    || (/\d/.test(x) && /(قابل للزيادة|قابل للتفاوض)/i.test(x));
}

// تحديد العملة للرواتب القصيرة (3-4 أرقام)
function addCurrency(salaryStr, fullText = "") {
  const s = normalizeInline(salaryStr);
  if (!s || s === "غير مذكور") return s;

  // إذا العملة مذكورة أصلاً بالراتب — لا تضيف شي
  if (/(دينار|ألف|الف|IQD|\$|دولار|USD|نسبة|نسب|شهري|شهريا)/i.test(s)) return s;

  // إذا الرقم 5+ خانات أو بفواصل (500,000) — واضح ما يحتاج عملة
  if (/\d{5,}/.test(s.replace(/[,\.\s]/g, ""))) return s;
  if (/\d{1,3}(?:[,\.\s]\d{3})+/.test(s)) return s;

  // إذا الرقم 3-4 خانات — نشوف السياق
  const hasShortNum = /^\d{3,4}\b/.test(s.trim());
  if (!hasShortNum) return s;

  // نبحث بالنص الكامل عن علامات الدولار
  if (/(\$|دولار|dollar|USD)/i.test(fullText)) return s + "$";

  // الافتراضي: دينار عراقي
  return s + " ألف دينار";
}

export function smartSalary(text = "") {
  const lines = linesOf(text);
  // المسح الأول: الراتب والقيمة بنفس السطر
  for (const line of lines) {
    const m = line.match(/(?:الراتب الشهري|الراتب|راتب|الأجر|الاجر|salary)\s*[:：\-–—]?\s*([^\n\r]{2,120})/i);
    if (m?.[1]) {
      const value = normalizeInline(m[1]);
      if (isLikelySalaryValue(value)) return addCurrency(value, text);
    }
  }
  // المسح الثاني: كلمة "راتب" بسطر والقيمة بالسطر التالي
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^(?:الراتب الشهري|الراتب|راتب|الأجر|الاجر|salary)\s*[:：\-–—]?\s*$/i.test(lines[i])) {
      const nextLine = normalizeInline(lines[i + 1]);
      // استخراج أرقام من السطر التالي (مثل "كابتن 600/650")
      const nm = nextLine.match(/(\d{3,4}(?:\s*[\/\-–—]\s*\d{3,4})?)/);
      if (nm?.[1]) return addCurrency(normalizeInline(nm[1].replace(/\//g, " – ")), text);
      if (isLikelySalaryValue(nextLine)) return addCurrency(nextLine, text);
    }
  }
  // المسح الثالث: أرقام قصيرة بعد كلمة الراتب مع السياق (600 وقابل للزيادة)
  for (const line of lines) {
    const m = line.match(/(?:الراتب الشهري|الراتب|راتب|الأجر|الاجر|salary)\s*[:：\-–—]?\s*(?:(?:ابتداء|يبدأ|من)\s*(?:من)?\s*\(?\s*)?(\d{3,4}(?:\s*[-–—\/]\s*\d{3,4})?)(?:\)?\s*(وقابل للزيادة|قابل للزيادة|قابل للتفاوض|وقابل للتفاوض))?/i);
    if (m?.[1]) {
      let val = normalizeInline(m[1]);
      if (m[2]) val += " " + normalizeInline(m[2]);
      return addCurrency(val, text);
    }
  }
  for (const line of lines) {
    if (/(دينار|دولار|\$|IQD|USD|نسبة|الف|ألف)/i.test(line) && isLikelySalaryValue(line))
      return normalizeInline(line);
  }
  return "غير مذكور";
}

// =========================
// الموقع
// =========================
const IRAQ_CITIES = [
  "بغداد","البصرة","أربيل","اربيل","دهوك","السليمانية","النجف","كربلاء","الناصرية",
  "الموصل","كركوك","الأنبار","الانبار","الحلة","واسط","الديوانية","ديالى","ميسان",
  "ذي قار","تكريت","صلاح الدين","السماوة","بابل"
];

const BAGHDAD_AREAS = [
  "الكرادة","المنصور","الجادرية","الزيونة","العامرية","الدورة","الكاظمية","الأعظمية",
  "الاعظمية","اليرموك","الشعب","الغدير","المنطقة الخضراء","ساحة عدن","البنوك","السيدية",
  "الحارثية","العدل","حي الجامعة","بغداد الجديدة","البياع","البكرية"
];

export function extractLocation(text = "") {
  const x = normalizeText(text);
  const lines = linesOf(text);
  for (const line of lines.slice(0, 15)) {
    const m = line.match(/(?:الموقع|العنوان|مكان العمل|موقع العمل|location)\s*[:：\-–—]?\s*(.+)$/i);
    if (m?.[1]) return normalizeInline(m[1]);
  }
  for (const city of IRAQ_CITIES) { if (x.includes(city)) return city; }
  for (const area of BAGHDAD_AREAS) { if (x.includes(area)) return area; }
  const m = x.match(/(?:في|داخل|ضمن|منطقة)\s+(بغداد|البصرة|أربيل|اربيل|دهوك|السليمانية|النجف|كربلاء|الموصل|كركوك|الكرادة|المنصور|الجادرية|الزيونة|اليرموك|السيدية|البياع|البكرية)/i);
  if (m?.[1]) return normalizeInline(m[1]);
  return "غير مذكور";
}

// =========================
// الشركة
// =========================
export function cleanupCompanyName(s = "") {
  let x = normalizeInline(s);
  x = stripEmojis(x)
    .replace(/^(?:اسم الشركة|الشركة)\s*[:：]\s*/i, "")
    .replace(/^(?:تعلن|يعلن)\s+/i, "")
    .replace(/(عن حاجتها|بحاجتها|لتعيين|لتوظيف|تطلب|المطلوب|الراتب|التواصل|واتساب|طريقة التواصل|الدوام|الموقع).*$/i, "")
    .replace(/[|]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!x) return "غير مذكور";
  if (isLikelyPhone(x) || isLikelyEmail(x)) return "غير مذكور";
  if (x.length > 80) return "غير مذكور";
  if (/^(مطلوب|مطلوبة|موظف|موظفة|محاسب|كاشير|مندوب|مسؤول|موظفين)$/i.test(x)) return "غير مذكور";
  return x;
}

export function extractCompany(text = "") {
  const normalized = normalizeText(text);
  const lines = linesOf(text);
  let m = normalized.match(/(?:تعلن|يعلن)\s+(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون)\s+([^\n]{2,80})/i);
  if (m) { const c = cleanupCompanyName(`${m[1]} ${m[2]}`); if (c !== "غير مذكور") return c; }
  for (const line of lines.slice(0, 12)) {
    m = line.match(/^(شركة|مؤسسة|مجموعة|مطعم|مقهى|معمل|مصنع|معهد|وكالة|مكتب|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون)\s+([^\n]{2,80})/i);
    if (m) { const c = cleanupCompanyName(`${m[1]} ${m[2]}`); if (c !== "غير مذكور") return c; }
    m = line.match(/^(?:اسم الشركة|الشركة|اسم الصالون|اسم المركز)\s*[:：]\s*(.+)$/i);
    if (m?.[1]) { const c = cleanupCompanyName(m[1]); if (c !== "غير مذكور") return c; }
  }
  return "غير مذكور";
}

// =========================
// المسمى الوظيفي
// =========================
const BAD_TITLES = [
  "غير مذكور","مطلوب","مطلوبة","موظف","موظفة","موظفين","موظفات",
  "فرصة عمل","وظيفة","واتساب","whatsapp","للتواصل","الرقم","الشركة","اسم الشركة"
];

export function isBadGenericTitle(x = "") {
  return BAD_TITLES.includes(normalizeInline(x).toLowerCase());
}

export function cleanJobTitle(s = "") {
  let x = normalizeInline(s);
  x = stripEmojis(x)
    .replace(/^(مطلوب|مطلوبة|نبحث عن|فرصة عمل|وظيفة شاغرة|بحاجة الى|بحاجة إلى|Hiring|Position)\s+/i, "")
    .replace(/^(?:تعلن شركة|يعلن مكتب|تعلن مؤسسة)\s+/i, "")
    .replace(/\b(ذكور|إناث|للجنسين|للذكور|للاناث|للإناث|أنثى|ذكر)\b/gi, "")
    .replace(/\s+(?:في|للعمل في|للعمل لدى|داخل|ضمن)\s+(شركة|مطعم|معهد|وكالة|مؤسسة|مكتب|معمل|مصنع|مكتبة|مركز|أسواق|مستشفى|عيادة|صالون).*/i, "")
    .replace(/\s+(?:براتب|راتب|الراتب|الدوام|الموقع|العنوان|التواصل|واتساب|تفاصيل|الشروط|للتقديم)\b.*$/i, "")
    .replace(/[|:\-–—].*$/i, "")
    .replace(/\s{2,}/g, " ").trim();
  if (!x || isBadGenericTitle(x)) return "غير مذكور";
  if (x.length > 60) return "غير مذكور";
  return x;
}

export function isGoodTitle(t = "") {
  const x = normalizeInline(t).toLowerCase();
  if (!x || isBadGenericTitle(x)) return false;
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

// =========================
// معلومات إضافية
// =========================
export function extractEmploymentType(text = "") {
  const x = normalizeText(text);
  if (/(دوام جزئي|part time)/i.test(x))           return "دوام جزئي";
  if (/(دوام كامل|full time)/i.test(x))            return "دوام كامل";
  if (/(شفت مسائي|مسائي)/i.test(x))               return "شفت مسائي";
  if (/(شفت صباحي|صباحي)/i.test(x))               return "شفت صباحي";
  if (/(فريلانس|عن بعد|remote|اونلاين|من البيت)/i.test(x)) return "عن بعد / مرن";
  return "غير مذكور";
}

export function extractExperience(text = "") {
  const lines = linesOf(text);
  for (const line of lines) {
    const m = line.match(/(?:خبرة|الخبرة|سنوات الخبرة|experience)\s*[:：\-–—]?\s*([^\n\r]{2,80})/i);
    if (m?.[1]) return normalizeInline(m[1]);
  }
  const m = normalizeText(text).match(/(\d+\s*(?:سنة|سنوات|year|years))/i);
  if (m?.[1]) return normalizeInline(m[1]);
  return "غير مذكور";
}

export function inferApplicationMethod(text = "", contact = "") {
  const full = `${text}\n${contact}`;
  if (/واتساب|whatsapp/i.test(full))                                           return "واتساب";
  if (/t\.me|telegram|تيليجرام/i.test(full))                                   return "تيليجرام";
  if (/email|e-mail|gmail|outlook|yahoo|إرسال\s*CV|السيرة الذاتية|cv/i.test(full)) return "إيميل / إرسال CV";
  if (extractPhones(full).length > 0)                                          return "هاتف / رقم مباشر";
  if (extractEmails(full).length > 0)                                          return "إيميل";
  return "غير مذكور";
}

export function fallbackCategory(text = "", title = "") {
  const s = normalizeInline(`${title} ${text}`).toLowerCase();
  if (/(hr|human resources|موارد بشرية|توظيف|recruit)/i.test(s))              return "HR";
  if (/(admin|إداري|اداري|استقبال|رسبشن|سكرتير|office)/i.test(s))             return "Admin";
  if (/(sales|مبيعات|مندوب|كاشير|cashier|موظفه مبيعات)/i.test(s))             return "Sales";
  if (/(customer service|خدمة عملاء|call center)/i.test(s))                   return "Customer Service";
  if (/(account|محاسب|محاسبة|حسابات|finance|مالي)/i.test(s))                  return "Accounting";
  if (/(engineer|مهندس|فني صيانة|maintenance)/i.test(s))                      return "Engineering";
  if (/(developer|programmer|it support|شبكات|تقنية|برمجة)/i.test(s))         return "IT";
  if (/(designer|تصميم|مصمم|جرافيك|مونتاج|سوشيال ميديا)/i.test(s))           return "Design";
  if (/(marketing|تسويق|مروج)/i.test(s))                                       return "Marketing";
  if (/(driver|سائق|توصيل|لوجست|مخزن|warehouse)/i.test(s))                    return "Logistics";
  if (/(مشتريات|procurement|buyer)/i.test(s))                                  return "Procurement";
  if (/(قانوني|محامي|legal)/i.test(s))                                         return "Legal";
  if (/(طبي|صيدل|تمريض|مختبر|عيادة|مستشفى|صالون)/i.test(s))                  return "Medical";
  if (/(مدرس|تدريس|معهد|teacher|education)/i.test(s))                         return "Education";
  if (/(operations|تشغيل|مشرف عمليات)/i.test(s))                              return "Operations";
  if (/(manager|مدير|management|supervisor|مشرف)/i.test(s))                    return "Management";
  if (/(hotel|مطعم|مقهى|barista|chef|hospitality|طباخ)/i.test(s))             return "Hospitality";
  if (/(security|حارس|أمن)/i.test(s))                                          return "Security";
  return "Other";
}
