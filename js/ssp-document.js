// The Skin Script Protocol as an A4 portrait document (preview, PDF, print, email attachment).
// Its look comes from Skin Script design (settings.pdf).
import { SSP_STEPS } from "./ssp-products-api.js";
import { SSP_DEFAULTS, PDF_DEFAULTS, FONTS } from "./ssp-defaults.js";
import { cleanRichHtml, richText } from "./rich-html.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LOGO_RE = /^data:image\/(png|jpeg);base64,/;
const COLOR = /^#[0-9a-f]{6}$/i;
const col = (v, d) => (COLOR.test(v || "") ? v : d);

export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "";
}

function tokens(rec) {
  const first = String(rec.patientName || "").split(" ")[0] || "";
  return [
    [/\{\s*valid until\s*\}/gi, longDate(rec.validUntil)],
    [/\{\s*record date\s*\}/gi, longDate(rec.recordDate)],
    [/\{\s*first name\s*\}/gi, first],
    [/\{\s*(patient name|full name)\s*\}/gi, rec.patientName || ""],
  ];
}
export function fillSspText(text, rec) {
  return tokens(rec).reduce((s, [re, v]) => s.replace(re, v), String(text || ""));
}
function fillSspHtml(html, rec) {
  return tokens(rec).reduce((s, [re, v]) => s.replace(re, esc(v)), String(html || ""));
}

const linkify = (h) => h.replace(/((?:https?:\/\/|www\.)[^\s<]+)/g, (u) =>
  `<a href="${u.startsWith("http") ? u : "https://" + u}">${u}</a>`);

function cssFor(P) {
  const fs = P.fontSize;
  return `
  .pdfdoc { width: 703px; font-family: ${FONTS[P.font] || FONTS.Arial}; font-size: ${fs}pt; color: #1e293b; background: #fff; }
  .pdfdoc * { box-sizing: border-box; }
  .pdfdoc table.sd-top { width: 100%; border-collapse: collapse; }
  .pdfdoc .sd-title { font-size: ${P.titleSize}pt; font-weight: bold; color: ${P.titleColor}; }
  .pdfdoc .sd-meta { margin: 8px 0 14px; padding-bottom: 12px; border-bottom: 2px solid ${P.accent}; font-size: ${fs - 0.5}pt; color: #334155; }
  .pdfdoc .sd-meta b { color: #64748b; font-weight: normal; }
  .pdfdoc table.sd { width: 100%; border-collapse: collapse; }
  .pdfdoc table.sd th { padding: 8px 10px; background: ${P.headerBg}; font-size: ${fs - 1.5}pt; font-weight: bold; letter-spacing: .06em;
    text-align: left; text-transform: uppercase; color: #334155; }
  .pdfdoc table.sd td { padding: 9px 10px; border-bottom: 1px solid #ece9e2; font-size: ${fs - 0.5}pt; line-height: 1.45; vertical-align: top; }
  .pdfdoc td.sd-step { width: 70px; }
  .pdfdoc td.sd-step b { display: block; font-size: ${fs - 0.5}pt; }
  .pdfdoc td.sd-step small { display: block; margin-top: 2px; font-size: ${fs - 2}pt; }
  .pdfdoc td.sd-empty { background: #faf9f6; }
  .pdfdoc .sd-name { margin-bottom: 3px; font-weight: bold; color: #0f172a; }
  .pdfdoc .sd-size { font-weight: normal; color: #64748b; }
  .pdfdoc .sd-when { margin-top: 4px; font-size: ${fs - 1.5}pt; color: #64748b; }
  .pdfdoc .sd-foot { margin-top: 18px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: ${fs - 0.5}pt; line-height: 1.6; }
  .pdfdoc .sd-foot p { margin: 0 0 8px; }
  .pdfdoc .sd-foot ul, .pdfdoc .sd-foot ol { margin: 0 0 8px; padding-left: 20px; }
  .pdfdoc .sd-foot h1, .pdfdoc .sd-foot h2, .pdfdoc .sd-foot h3 { margin: 6px 0; }
  .pdfdoc .sd-foot a { color: ${P.accent}; }
  .pdfdoc .sd-sign { margin-top: 14px; }
  .pdfdoc .sd-footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: ${fs - 2}pt; color: #64748b; text-align: center; }
`;
}

function cell(it, which, P) {
  if (!it) return "";
  const text = which === "am" ? it.amText : it.pmText;
  const when = P.showWhen ? [(it.days || []).join(", "), it.notes].filter(Boolean).join(" · ") : "";
  return `<div class="sd-name">${esc(it.name)}${P.showSize && it.size ? ` <span class="sd-size">(${esc(it.size)})</span>` : ""}</div>${
    text ? `<div>${esc(text).replace(/\n/g, "<br>")}</div>` : ""}${when ? `<div class="sd-when">${esc(when)}</div>` : ""}`;
}

// record: { patientName, recordDate, validUntil, items: [...] }
export function buildSspDocument({ record, letterhead = null, settings = null }) {
  const s = { ...SSP_DEFAULTS, ...(settings || {}) };
  const raw = { ...PDF_DEFAULTS, ...(s.pdf || {}) };
  const P = {
    ...raw,
    titleColor: col(raw.titleColor, PDF_DEFAULTS.titleColor),
    accent: col(raw.accent, PDF_DEFAULTS.accent),
    headerBg: col(raw.headerBg, PDF_DEFAULTS.headerBg),
    titleSize: Number(raw.titleSize) || PDF_DEFAULTS.titleSize,
    fontSize: Number(raw.fontSize) || PDF_DEFAULTS.fontSize,
    logoSize: Number(raw.logoSize) || PDF_DEFAULTS.logoSize,
    steps: raw.steps || {},
  };
  const items = Array.isArray(record.items) ? record.items : [];

  const rows = SSP_STEPS.map((step) => {
    const inStep = items.filter((i) => i.step === step.key);
    const am = inStep.filter((i) => i.am);
    const pm = inStep.filter((i) => i.pm);
    const n = Math.max(am.length, pm.length);
    if (!n) return "";
    const o = P.steps[step.key] || {};
    const label = o.label || step.label;
    const sub = o.sub ?? step.sub;
    const tone = P.stepColours ? col(o.tone, step.tone) : "#ffffff";
    const ink = P.stepColours ? col(o.ink, step.ink) : "#334155";
    let h = "";
    for (let i = 0; i < n; i++) {
      h += `<tr>${i === 0 ? `<td class="sd-step" rowspan="${n}" style="background:${tone};">
          <b style="color:${ink};">${esc(label)}</b>${sub ? `<small style="color:${ink};">${esc(sub)}</small>` : ""}</td>` : ""}
        <td class="${am[i] ? "" : "sd-empty"}" style="width:315px;">${cell(am[i], "am", P)}</td>
        <td class="${pm[i] ? "" : "sd-empty"}" style="width:315px;">${cell(pm[i], "pm", P)}</td></tr>`;
    }
    return h;
  }).join("");

  const logo = P.logo !== "none" && letterhead && LOGO_RE.test(letterhead.logo || "")
    ? `<img src="${letterhead.logo}" alt="" style="height:${P.logoSize}px;width:auto;max-width:240px;display:inline-block !important;">` : "";
  const title = `<div class="sd-title">${esc(P.title || PDF_DEFAULTS.title)}</div>`;
  const top = P.logo === "left"
    ? `<td style="vertical-align:middle;width:1%;padding-right:14px;">${logo}</td><td style="vertical-align:middle;text-align:right !important;">${title}</td>`
    : `<td style="vertical-align:middle;">${title}</td><td style="text-align:right !important;vertical-align:middle;">${logo}</td>`;

  const meta = [
    P.showPatient ? `<b>Patient name:</b> ${esc(record.patientName || "—")}` : "",
    P.showRecordDate ? `<b>Record date:</b> ${esc(longDate(record.recordDate))}` : "",
    P.showValidUntil ? `<b>Valid until:</b> ${esc(longDate(record.validUntil))}` : "",
  ].filter(Boolean).join(" &nbsp;&nbsp;|&nbsp;&nbsp; ");

  const closing = s.closingHtml && richText(s.closingHtml)
    ? cleanRichHtml(fillSspHtml(s.closingHtml, record))
    : fillSspText(s.closing, record).split(/\n+/).map((l) => l.trim()).filter(Boolean)
        .map((l) => `<p>${linkify(esc(l))}</p>`).join("");
  const signLines = String(s.signature || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const sign = signLines.map((l, i) => (i === signLines.length - 1 ? `<b>${esc(l)}</b>` : esc(l))).join("<br>");

  const inner = `
    <table class="sd-top"><tr>${top}</tr></table>
    ${meta ? `<div class="sd-meta">${meta}</div>` : `<div class="sd-meta" style="padding-bottom:0;"></div>`}
    <table class="sd">
      <tr><th style="width:70px;">Step</th><th>${P.icons ? "☀ " : ""}${esc(P.morning || "Morning")}</th><th>${P.icons ? "✨ " : ""}${esc(P.evening || "Evening")}</th></tr>
      ${rows || '<tr><td colspan="3">No products on this protocol.</td></tr>'}
    </table>
    <div class="sd-foot">${closing}${sign ? `<div class="sd-sign">${sign}</div>` : ""}</div>
    ${P.footer ? `<div class="sd-footer">${esc(P.footer)}</div>` : ""}`;

  const fileName = `${P.title || "Skin Script Protocol"} - ${record.patientName || "Patient"} - ${longDate(record.recordDate)}.pdf`
    .replace(/[\\/:*?"<>|]+/g, "-");
  return { inner, css: cssFor(P), fileName };
}