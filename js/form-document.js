// The print / PDF version of a saved form: questions with written answers,
// tables, signatures, the letterhead and a footer. Simple tables and
// inline-friendly CSS, so the Apps Script PDF converter renders it reliably.
import { esc, normaliseField, patientParts } from "./form-fields.js";
import { formatCalc } from "./form-calc.js";

const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

export function niceDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return key || "";
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function letterhead(lh) {
  if (!lh) return "";
  const h = { small: 36, medium: 56, large: 80 }[lh.logoSize] || 56;
  const logo = LOGO_RE.test(lh.logo || "") ? `<img src="${lh.logo}" height="${h}" alt="" style="vertical-align:middle">` : "";
  const name = lh.showName !== false && lh.name ? `<span class="lh-name">${esc(lh.name)}</span>` : "";
  const lines = [lh.line1, lh.line2].filter(Boolean).map(esc).join("<br>");
  if (lh.layout === "centre") {
    return `<table class="lh" width="100%"><tr><td align="center">${logo}${logo && name ? "<br>" : ""}${name}${
      lines ? `<div class="lh-lines">${lines}</div>` : ""}</td></tr></table>`;
  }
  return `<table class="lh" width="100%"><tr><td>${logo}${logo && name ? "&nbsp;&nbsp;" : ""}${name}</td>` +
    `<td align="right" class="lh-lines">${lines}</td></tr></table>`;
}

function answer(f, v, sig) {
  const none = '<span class="none">Not answered</span>';
  switch (f.type) {
    case "short_text": case "long_text": case "email": case "dropdown": case "single_choice":
      return v ? esc(v).replace(/\n/g, "<br>") : none;
    case "date": case "record_date":
      return v ? esc(niceDate(v)) : none;
    case "number":
      return v === null || v === undefined || v === "" ? none : esc(`${v}${f.unit ? " " + f.unit : ""}`);
    case "checkboxes":
      return Array.isArray(v) && v.length
        ? `<ul>${v.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : '<span class="none">None ticked</span>';
    case "checkbox_notes":
      return Array.isArray(v) && v.length
        ? `<ul>${v.map((r) => `<li>${esc(r.option)}${r.note ? ` <span class="note">(${esc(r.note)})</span>` : ""}</li>`).join("")}</ul>`
        : '<span class="none">None ticked</span>';
    case "sub_checks":
      return Array.isArray(v) && v.length
        ? `<ul>${v.map((r) => `<li>${esc(r.option)}${r.subs && r.subs.length ? `: ${r.subs.map(esc).join(", ")}` : ""}</li>`).join("")}</ul>`
        : '<span class="none">None ticked</span>';
    case "table": {
      const cols = f.columns || [];
      const rows = (Array.isArray(v) ? v : [])
        .filter((r) => r && Array.isArray(r.cells) && r.cells.some((c) => c !== "" && c !== false));
      if (!rows.length) return none;
      return `<table class="grid"><tr>${cols.map((c, i) => `<th>${esc(c.label || `Column ${i + 1}`)}</th>`).join("")}</tr>${
        rows.map((r) => `<tr>${cols.map((c, i) => {
          const x = r.cells[i];
          return `<td>${c.type === "check" ? (x === true ? "Yes" : "") : esc(typeof x === "string" ? x : "")}</td>`;
        }).join("")}</tr>`).join("")}</table>`;
    }
    case "calculation":
      return esc(formatCalc(v, f) || "—");
    case "signature": {
      if (!(typeof sig === "string" && PNG_RE.test(sig))) return '<span class="none">Not signed</span>';
      const meta = v && typeof v === "object"
        ? [v.name && `Signed by ${esc(v.name)}`, v.date && `on ${esc(niceDate(v.date))}`].filter(Boolean).join(" ")
        : "";
      return `<div class="sig"><img src="${sig}" height="70" alt="Signature"></div>${meta ? `<div class="sigmeta">${meta}</div>` : ""}`;
    }
    case "patient": {
      const d = v || {};
      return `<table class="kv">${patientParts(f).map(([k, l]) =>
        `<tr><td class="k">${esc(l)}</td><td>${d[k] ? esc(d[k]) : '<span class="none">—</span>'}</td></tr>`).join("")}</table>`;
    }
    case "consent_status":
      return v && v.found
        ? `Signed ${v.name ? `“${esc(v.name)}” ` : ""}on ${esc(niceDate(v.date))}`
        : '<span class="none">No signed consent found</span>';
  }
  return none;
}

export function buildFormDocument({ sub, ver, letterhead: lh }) {
  const fields = (ver.fields || []).map(normaliseField).filter(Boolean);
  const showLh = !(ver.settings && ver.settings.showLetterhead === false);

  const body = fields.map((f) => {
    if (f.type === "watermark" || f.type === "photo") return "";
    if (f.type === "space") return `<div style="height:${{ small: 8, medium: 20, large: 40 }[f.size] || 20}px"></div>`;
    if (f.type === "letterhead") return letterhead(lh);
    if (f.type === "text_block") {
      return `<div class="block">${f.label ? `<h2>${esc(f.label)}</h2>` : ""}${
        f.text ? `<p>${esc(f.text).replace(/\n/g, "<br>")}</p>` : ""}</div>`;
    }
    return `<div class="q"><div class="ql">${esc(f.label || "")}</div>` +
      `<div class="qa">${answer(f, sub.answers[f.id], sub.signatures[f.id])}</div></div>`;
  }).join("");

  const fileName = `${sub.templateName} - ${sub.patientName} - ${niceDate(sub.recordDate)}.pdf`
    .replace(/[\\/:*?"<>|]+/g, "-");

  const footer = [
    sub.patientName && `Patient: ${esc(sub.patientName)}`,
    sub.recordDate && `Record date: ${esc(niceDate(sub.recordDate))}`,
    sub.createdBy && `Completed by ${esc(sub.createdBy)}`,
    `Form version ${sub.version}`,
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(fileName)}</title><style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1e293b; margin: 0; }
    .lh { border-collapse: collapse; border-bottom: 2px solid #0f766e; margin-bottom: 14px; }
    .lh td { padding: 0 0 8px 0; vertical-align: middle; }
    .lh-name { font-family: Georgia, serif; font-size: 16pt; color: #0f172a; vertical-align: middle; }
    .lh-lines { font-size: 8.5pt; color: #64748b; line-height: 1.5; }
    h1 { font-family: Georgia, serif; font-size: 18pt; font-weight: normal; margin: 6px 0 4px; }
    .meta { font-size: 9pt; color: #64748b; margin: 0 0 12px; }
    .q { padding: 8px 0; border-bottom: 1px solid #e2e8f0; page-break-inside: avoid; }
    .ql { font-size: 9pt; font-weight: bold; color: #475569; margin-bottom: 3px; }
    .qa { font-size: 11pt; line-height: 1.45; }
    .none { color: #94a3b8; font-style: italic; }
    .note { color: #475569; }
    ul { margin: 2px 0; padding-left: 18px; }
    table.grid { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
    table.grid th, table.grid td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; }
    table.grid th { background: #f1f5f9; }
    table.kv { border-collapse: collapse; font-size: 10.5pt; }
    table.kv td { padding: 2px 16px 2px 0; vertical-align: top; }
    table.kv td.k { color: #64748b; font-size: 9pt; }
    .block { padding: 10px 0; page-break-inside: avoid; }
    .block h2 { font-size: 11.5pt; margin: 0 0 4px; }
    .block p { margin: 0; font-size: 10pt; line-height: 1.5; }
    .sigmeta { font-size: 9pt; color: #475569; margin-top: 2px; }
    .foot { margin-top: 22px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 8pt; color: #94a3b8; }
  </style></head><body>
    ${showLh ? letterhead(lh) : ""}
    <h1>${esc(ver.name)}</h1>
    <p class="meta">${esc(sub.patientName)}${sub.recordDate ? ` · ${esc(niceDate(sub.recordDate))}` : ""}</p>
    ${body}
    <div class="foot">${footer}</div>
  </body></html>`;

  return { html, fileName };
}