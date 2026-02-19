const HANDOFF_MESSAGE_TR =
  "Bu konu kapsamımın dışında görünüyor. Çağrınızı insan çağrı merkezine aktarıyorum.";
const HANDOFF_MESSAGE_EN =
  "This topic is outside my available information. I will transfer your call to a human call center agent.";

const MEDICAL_ADVICE_PATTERN =
  /\b(tedavi|ila[cç]|doz|re[cç]ete|tan[ıi]|te[sş]his|ameliyat|yan etki|treatment|medicine|medication|dosage|prescription|diagnosis|drug|side effects?)\b/i;

function isLikelyTurkish(text) {
  if (!text) return false;
  return /[çğıöşüÇĞİÖŞÜ]|\b(merhaba|randevu|hastane|doktor|hangi|nas[ıi]l|neden|lütfen|için|m[ıi]|mi)\b/i.test(text);
}

function handoffMessageFor(text) {
  return isLikelyTurkish(text) ? HANDOFF_MESSAGE_TR : HANDOFF_MESSAGE_EN;
}

function sanitizeUserText(text, maxChars) {
  const normalized = String(text ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(0, maxChars);
}

function stripQueryNoiseTokens(text) {
  const value = String(text ?? "");
  const cleaned = value
    .replace(/\bnonce=\d+\b/gi, " ")
    .replace(/\bsession=[A-Za-z0-9_-]{3,}\b/gi, " ")
    .replace(/\b(?:ts|timestamp|time)=\d{10,16}\b/gi, " ")
    .replace(
      /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
      " "
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, " ")
    .replace(/\[(?:[A-Za-z0-9:_=-]{2,80})\]/g, " ")
    .replace(/\{(?:[A-Za-z0-9:_=-]{2,80})\}/g, " ")
    .replace(/\((?:[A-Za-z0-9:_=-]{2,80})\)/g, " ")
    .replace(/<(?:[A-Za-z0-9:_=-]{2,80})>/g, " ");

  return cleaned.replace(/\s+/g, " ").trim();
}

module.exports = {
  HANDOFF_MESSAGE_TR,
  HANDOFF_MESSAGE_EN,
  MEDICAL_ADVICE_PATTERN,
  handoffMessageFor,
  isLikelyTurkish,
  sanitizeUserText,
  stripQueryNoiseTokens
};
