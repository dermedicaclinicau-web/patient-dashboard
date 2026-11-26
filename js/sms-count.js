// Text message counter, shared by Recall, Recall settings and the Flow.
// Tidies the text the way Code.gs does before sending (smsClean_ / SMS_FIX_), then counts the parts the way Textmagic does.
// Sets window.smsClean(text) and window.smsInfo(text) → { text, chars, parts, unicode, odd, fixed }.

// iPad and Word punctuation that would force a text into 70-character parts, swapped for plain versions
const FIX = [
  [/[\u2018\u2019\u201A\u201B\u2032\u00B4]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-"],
  [/\u2026/g, "..."],
  [/\u2022/g, "-"],
  [/[\u00A0\u2002\u2003\u2007\u2009\u200A\u202F]/g, " "],
  [/[\u200B\u200C\u200D\u2060\uFEFF]/g, ""],
];

// The characters a normal text can hold (GSM-7). The second set counts as 2 each.
const GSM = new Set(Array.from(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const GSM_EXT = new Set(Array.from("^{}\\[~]|€\f"));

function clean(text) {
  let out = String(text ?? "");
  let fixed = 0;
  FIX.forEach(([re, to]) => { out = out.replace(re, () => { fixed++; return to; }); });
  return { text: out, fixed };
}

function info(text) {
  const c = clean(text);
  const chars = Array.from(c.text);
  const odd = [];
  let ext = 0;
  chars.forEach((ch) => {
    if (GSM.has(ch)) return;
    if (GSM_EXT.has(ch)) { ext++; return; }
    if (!odd.includes(ch) && odd.length < 5) odd.push(ch);
  });
  const unicode = chars.some((ch) => !GSM.has(ch) && !GSM_EXT.has(ch));
  const n = unicode ? c.text.length : chars.length + ext;   // emoji count as 2 in a unicode text
  const parts = !n ? 0 : unicode ? (n <= 70 ? 1 : Math.ceil(n / 67)) : (n <= 160 ? 1 : Math.ceil(n / 153));
  return { text: c.text, chars: n, parts, unicode, odd, fixed: c.fixed };
}

window.smsClean = (text) => clean(text).text;
window.smsInfo = info;