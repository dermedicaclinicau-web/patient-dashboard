// The Skin Script Protocol as an A4 portrait document (preview, PDF, print, email attachment).
import { SSP_STEPS } from "./ssp-products-api.js";
import { SSP_DEFAULTS } from "./ssp-settings.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LOGO_RE = /^data:image\/(png|jpeg);base64,/;

export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "";
}

export function fillSspText(text, rec) {
  const first = String(rec.patientName || "").split(" ")[0] || "";
  return String(text || "")
    .replace(/\{\s*valid until\s*\}/gi, longDate(rec.validUntil))
    .replace(/\{\s*record date\s*\}/gi, longDate(rec.recordDate))
    .replace(/\{\s*first name\s*\}/gi, first)
    .replace(/\{\s*(patient name|full name)\s*\}/gi, rec.patientName || "");
}

const linkify = (h) => h.replace(/((?:https?:\/\/|www\.)[^\s<]+)/g, (u) =>
  `<a href="${u.startsWith("http") ? u : "https://" + u}">${u}</a>`);

const CSS = `
  .pdfdoc { width: 703px; font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #1e293b; background: #fff; }
  .pdfdoc * { box-sizing: border-box; }
  .pdfdoc table.sd-top { width: 100%; border-collapse: collapse; }
  .pdfdoc .sd-title { font-size: 17pt; font-weight: bold; color: #0f172a; }
  .pdfdoc .sd-meta { margin: 8px 0 14px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; font-size: 9.5pt; color: #334155; }
  .pdfdoc .sd-meta b { color: #64748b; font-weight: normal; }
  .pdfdoc table.sd { width: 100%; border-collapse: collapse; }
  .pdfdoc table.sd th { padding: 8px 10px; background: #f4f2ed; font-size: 8.5pt; font-weight: bold; letter-spacing: .06em;
    text-align: left; text-transform: uppercase; color: #334155; }
  .pdfdoc table.sd td { padding: 9px 10px; border-bottom: 1px solid #ece9e2; font-size: 9.5pt; line-height: 1.45; vertical-align: top; }
  .pdfdoc td.sd-step { width: 70px; }
  .pdfdoc td.sd-step b { display: block; font-size: 9.5pt; }
  .pdfdoc td.sd-step small { display: block; margin-top: 2px; font-size: 8pt; }
  .pdfdoc td.sd-empty { background: #faf9f6; }
  .pdfdoc .sd-name { margin-bottom: 3px; font-weight: bold; color: #0f172a; }
  .pdfdoc .sd-when { margin-top: 4px; font-size: 8.5pt; color: #64748b; }
  .pdfdoc .sd-foot { margin-top: 18px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 9.5pt; line-height: 1.6; }
  .pdfdoc .sd-foot p { margin: 0 0 8px; }
  .pdfdoc .sd-foot a { color: #0f766e; }
  .pdfdoc .sd-sign { margin-top: 14px; }
`;

function cell(it, which) {
  if (!it) return "";
  const text = which === "am" ? it.amText : it.pmText;
  const when = [(it.days || []).join(", "), it.notes].filter(Boolean).join(" · ");
  return `<div class="sd-name">${esc(it.name)}</div>${text ? `<div>${esc(text).replace(/\n/g, "<br>")}</div>` : ""}${
    when ? `<div class="sd-when">${esc(when)}</div>` : ""}`;
}

// record: { patientName, recordDate, validUntil, items: [...] }
export function buildSspDocument({ record, letterhead = null, settings = null }) {
  const s = { ...SSP_DEFAULTS, ...(settings || {}) };
  const items = Array.isArray(record.items) ? record.items : [];

  const rows = SSP_STEPS.map((step) => {
    const inStep = items.filter((i) => i.step === step.key);
    const am = inStep.filter((i) => i.am);
    const pm = inStep.filter((i) => i.pm);
    const n = Math.max(am.length, pm.length);
    if (!n) return "";
    let h = "";
    for (let i = 0; i < n; i++) {
      h += `<tr>${i === 0 ? `<td class="sd-step" rowspan="${n}" style="background:${step.tone};">
          <b style="color:${step.ink};">${esc(step.label)}</b>${step.sub ? `<small style="color:${step.ink};">${esc(step.sub)}</small>` : ""}</td>` : ""}
        <td class="${am[i] ? "" : "sd-empty"}" style="width:315px;">${cell(am[i], "am")}</td>
        <td class="${pm[i] ? "" : "sd-empty"}" style="width:315px;">${cell(pm[i], "pm")}</td></tr>`;
    }
    return h;
  }).join("");

  const logo = letterhead && LOGO_RE.test(letterhead.logo || "")
    ? `<img src="${letterhead.logo}" alt="" style="height:40px;width:auto;max-width:220px;display:inline-block !important;">` : "";
  const closing = fillSspText(s.closing, record).split(/\n+/).map((l) => l.trim()).filter(Boolean)
    .map((l) => `<p>${linkify(esc(l))}</p>`).join("");
  const signLines = String(s.signature || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const sign = signLines.map((l, i) => (i === signLines.length - 1 ? `<b>${esc(l)}</b>` : esc(l))).join("<br>");

  const inner = `
    <table class="sd-top"><tr>
      <td style="vertical-align:middle;"><div class="sd-title">Skin Script Protocol</div></td>
      <td style="text-align:right !important;vertical-align:middle;">${logo}</td>
    </tr></table>
    <div class="sd-meta"><b>Patient name:</b> ${esc(record.patientName || "—")}
      &nbsp;&nbsp;&nbsp; <b>Record date:</b> ${esc(longDate(record.recordDate))}
      &nbsp;|&nbsp; <b>Valid until:</b> ${esc(longDate(record.validUntil))}</div>
    <table class="sd">
      <tr><th style="width:70px;">Step</th><th>☀ Morning</th><th>✨ Evening</th></tr>
      ${rows || '<tr><td colspan="3">No products on this protocol.</td></tr>'}
    </table>
    <div class="sd-foot">${closing}${sign ? `<div class="sd-sign">${sign}</div>` : ""}</div>`;

  const fileName = `Skin Script Protocol - ${record.patientName || "Patient"} - ${longDate(record.recordDate)}.pdf`
    .replace(/[\\/:*?"<>|]+/g, "-");
  return { inner, css: CSS, fileName };
}