// The PDF version of a saved form: questions with written answers, tables,
// signatures and the letterhead. The browser turns this into the PDF, so it
// looks exactly like the preview. (Simple tables are used so the server's
// backup PDF converter can render it too.)
import { formatCalc } from "./form-calc.js";
import { visibleIds } from "./form-conditions.js";
import { esc, normaliseField, patientParts, INLINE_TYPES, fieldStyle, imageSizing, textBlockHtml, clinicianParts, tableCols, tableHeadAlign,
specialistParts, specialistBlockHtml, spanUnits, tableColWidths, tableSums, fmtCol, fmtInv, isNumCol, tableInvoice, buttonHref,
 } from "./form-fields.js";
import { cleanRichHtml, richText } from "./rich-html.js";
import { markSummary } from "./marking-sets.js";
import { tagValues, fillTags, fillTagsHtml, formFieldTags } from "./form-tags.js";


const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

export function niceDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return key || "";
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

const fmtIso = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};
const discussedLine = (by, at) =>
  `<div style="font-size:9pt;color:#047857;margin:0 0 5px;">✓ Discussed with the patient${by ? ` by ${esc(by)}` : ""}${at ? ` on ${esc(fmtIso(at))}` : ""}</div>`;

// A4 width minus 12 mm margins on each side, at 96 dpi
const CSS = `
  .pdfdoc { width: 703px; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1e293b; background: #fff; }
  .pdfdoc * { box-sizing: border-box; }
  .pdfdoc .lh { width: 100%; border-collapse: collapse; border-bottom: 2px solid #0f766e; margin-bottom: 16px; }
  .pdfdoc .lh td { padding: 0 0 10px 0; vertical-align: middle; }
  .pdfdoc .lh img { vertical-align: middle; }
  .pdfdoc .lh-name { font-family: Georgia, serif; font-size: 16pt; color: #0f172a; vertical-align: middle; }
  .pdfdoc .lh-lines { font-size: 8.5pt; color: #64748b; line-height: 1.5; }
  .pdfdoc h1 { font-family: Georgia, serif; font-size: 19pt; font-weight: normal; color: #0f172a; margin: 4px 0 4px; }
  .pdfdoc .meta { font-size: 9.5pt; color: #64748b; margin: 0 0 14px; }
  .pdfdoc .q { padding: 9px 0; border-bottom: 1px solid #d9d9d9; page-break-inside: avoid; }
  .pdfdoc .ql { font-size: 9.5pt; font-weight: bold; color: #1a1a1a; margin-bottom: 4px; }
  .pdfdoc .qa { font-size: 11pt; line-height: 1.45; }
  .pdfdoc table.qi { width: 100%; border-collapse: collapse; }
  .pdfdoc table.qi td { padding: 0; vertical-align: top; }
  .pdfdoc table.qi td.ql { width: 40%; padding: 2px 14px 0 0; margin: 0; }
  .pdfdoc .none { color: #94a3b8; font-style: italic; }
  .pdfdoc .note { color: #475569; }
  .pdfdoc ul { margin: 2px 0; padding-left: 18px; }
  .pdfdoc table.grid { width: 100%; border-collapse: collapse; font-size: 10pt; }
  .pdfdoc table.grid th, .pdfdoc table.grid td { border: 1px solid #dde3ea; padding: 6px 8px; text-align: left; color: #0f172a; }
  .pdfdoc table.grid th { background: #f8fafb; font-weight: 600; }
  .pdfdoc table.kv { border-collapse: collapse; font-size: 10.5pt; }
  .pdfdoc table.kv td { padding: 3px 18px 3px 0; vertical-align: top; }
  .pdfdoc table.kv td.k { color: #64748b; font-size: 9.5pt; }
  .pdfdoc .block { padding: 10px 0; page-break-inside: avoid; }
  .pdfdoc .block h2 { font-size: 11.5pt; margin: 0 0 5px; }
  .pdfdoc .block p { margin: 0; font-size: 10pt; line-height: 1.55; }
  .pdfdoc .sig img { height: 70px; }
  .pdfdoc .sigmeta { font-size: 9pt; color: #475569; margin-top: 2px; }
  .pdfdoc .fe-rich p { margin: 0 0 6px; font-size: inherit; line-height: 1.55; }
  .pdfdoc .fe-rich p:last-child { margin-bottom: 0; }
  .pdfdoc .fe-rich h1 { font-family: Arial, Helvetica, sans-serif; font-size: 15pt; font-weight: bold; color: #0f172a; margin: 0 0 6px; }
  .pdfdoc .fe-rich h2 { font-size: 12.5pt; margin: 8px 0 4px; }
  .pdfdoc .fe-rich h3 { font-size: 11pt; margin: 6px 0 3px; }
  .pdfdoc .fe-rich ul, .pdfdoc .fe-rich ol { margin: 0 0 6px; padding-left: 20px; }
  .pdfdoc .fe-rich li { margin: 0 0 2px; }
  .pdfdoc .fe-rich hr { border: none; border-top: 1px solid #cbd5e1; margin: 10px 0; }
  .pdfdoc .fe-rich a { color: #0f766e; }
  .pdfdoc .bl { height: 24px; border-bottom: 1px solid #333; }
  .pdfdoc .bl-in { display: inline-block; width: 180px; height: 16px; border-bottom: 1px solid #333; vertical-align: bottom; }
  .pdfdoc .bo-wrap { line-height: 1.9; }
  .pdfdoc .bo { display: inline-block; margin: 0 20px 0 0; white-space: nowrap; }
  .pdfdoc .bo-row { padding: 3px 0; }
  .pdfdoc .bo-subs { margin: 2px 0 0 20px; line-height: 1.9; font-size: 10pt; }
  .pdfdoc .box { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border: 1.3px solid #1a1a1a; vertical-align: -1px; }
  .pdfdoc .box.round { border-radius: 50%; }
  .pdfdoc .sig-box { height: 64px; border-bottom: 1px solid #1a1a1a; }
`;

// Alignment is set directly on each element so the portal's own page styles
// (which are present while the PDF is drawn) can't move anything.
function letterhead(lh) {
  if (!lh) return "";
  const h = { small: 36, medium: 56, large: 80 }[lh.logoSize] || 56;
  const img = LOGO_RE.test(lh.logo || "")
    ? `<img src="${lh.logo}" alt="" style="display:inline-block !important;height:${h}px !important;width:auto !important;max-width:none !important;margin:0 !important;vertical-align:middle">`
    : "";
  const name = lh.showName !== false && lh.name
    ? `<span class="lh-name" style="vertical-align:middle">${esc(lh.name)}</span>` : "";
  const lines = [lh.line1, lh.line2].filter(Boolean).map(esc).join("<br>");
  const rule = "border-bottom:2px solid #0f766e;margin:0 0 16px 0;";

  if (lh.layout === "centre") {
    return `<div class="lh-c" style="${rule}padding:0 0 12px 0;text-align:center !important;">
      <div style="text-align:center !important;">${img}${img && name ? "<br>" : ""}${name}</div>
      ${lines ? `<div class="lh-lines" style="text-align:center !important;margin-top:6px;">${lines}</div>` : ""}
    </div>`;
  }
  return `<table style="width:100% !important;border-collapse:collapse;${rule}"><tr>
    <td style="text-align:left !important;vertical-align:middle;padding:0 0 12px 0;">${img}${img && name ? "&nbsp;&nbsp;" : ""}${name}</td>
    <td class="lh-lines" style="text-align:right !important;vertical-align:middle;padding:0 0 12px 0;">${lines}</td>
  </tr></table>`;
}


// A chosen answer, with its "Other" text or details
function choiceText(f, label, x) {
  const xx = x || {};
  const isOther = f.allowOther && label === (String(f.otherLabel || "").trim() || "Other");
  const main = isOther && xx.other ? `${esc(label)}: ${esc(xx.other)}` : esc(label);
  const note = xx.notes && xx.notes[label];
  return note ? `${main} <span class="note">(${esc(note)})</span>` : main;
}

/* ---------- Blank forms (Task Manager → To Print) ---------- */
const optLabel = (o) => String(o && typeof o === "object" ? (o.label ?? o.option ?? o.name ?? "") : (o ?? "")).trim();
const optSubs = (o) => (o && typeof o === "object"
  ? (Array.isArray(o.subs) ? o.subs : Array.isArray(o.options) ? o.options : []) : []);

function isUnanswered(f, v, sig) {
  switch (f.type) {
    case "signature": return !(typeof sig === "string" && PNG_RE.test(sig));
    case "patient": return !v || !Object.values(v).some((x) => String(x ?? "").trim());
    case "clinician": return !v || typeof v !== "object" || !Object.entries(v).some(([k, x]) => k !== "staffId" && String(x ?? "").trim());
    case "table": return !Array.isArray(v) || !v.some((r) => r && Array.isArray(r.cells) && r.cells.some((c) => c !== "" && c !== false && c != null));
    case "calculation": case "consent_status": case "prescription_status": return true;
    default: return v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  }
}

const tableMaxRows = (f) => Math.max(parseInt(f.rows, 10) || 3, parseInt(f.maxRows, 10) || 10);
// A table's opening tag and heading row, with its column widths. Widths go on the headings so the server's PDF backup understands them too.
const PDF_ROW = { compact: 20, normal: 26, tall: 38, xl: 54 };
function gridStart(f, cols) {
  const ws = tableColWidths(f);
  const fixed = ws.some((w) => w !== null);
  return {
    open: `<table class="grid"${fixed ? ' style="table-layout:fixed"' : ""}>`,
    head: `<tr>${cols.map((c, i) => `<th style="text-align:${tableHeadAlign(f, c)};${ws[i] !== null ? `width:${ws[i]}%;` : ""}">${
      esc(c.label || `Column ${i + 1}`)}${c.type === "number" && c.unit ? ` (${esc(c.unit)})` : ""}</th>`).join("")}</tr>`,
    h: PDF_ROW[f.rowHeight] || 26,
  };
}

// The Total row inside a table, and Subtotal / GST / Total under it. s = null: empty lines (blank printable)
function pdfTotalRow(f, cols, s) {
  if (!cols.some((c) => c.total && isNumCol(c))) return "";
  const cell = "font-weight:bold;background:#f8fafb;";
  return `<tr>${cols.map((c, i) => (c.total && isNumCol(c)
    ? `<td style="${cell}text-align:right;">${s ? esc(fmtCol(c, s.sums[c.id])) : ""}</td>`
    : `<td style="${cell}">${i === 0 ? "Total" : ""}</td>`)).join("")}</tr>`;
}
function pdfInv(f, s) {
  const inv = tableInvoice(f);
  if (!inv) return "";
  const v = (k) => {
    if (!s) return '<span class="bl-in" style="width:90px"></span>';
    if (k === "disc") return s.disc > 0 ? `−${esc(fmtInv(inv.col, s.disc))}` : "—";
    if (k === "due" && s.due < 0) return `${esc(fmtInv(inv.col, -s.due))} credit`;
    return esc(fmtInv(inv.col, s[k]));
  };
  // Same look as the form: light rows, a dark line above Total and Amount due, the amount due in amber
  const L = "padding:4px 16px 4px 8px;";
  const R = "padding:4px 8px;text-align:right;white-space:nowrap;";
  const r = (l, k, big = false, due = false) => {
    const b = big ? "font-weight:bold;font-size:11pt;border-top:2px solid #0f172a;" : "";
    return `<tr><td style="${L}${b}">${esc(l)}</td><td style="${R}${b}${due && s && s.due > 0 ? "color:#b45309;" : ""}">${v(k)}</td></tr>`;
  };
  const hasD = inv.disc !== "none";
  const dl = `Discount${inv.disc === "percent" && s && s.discIn ? ` (${+s.discIn}%)` : ""}`;
  const top = hasD ? r("Subtotal", "base") + r(dl, "disc") : "";
  let rows = inv.gst === "add" ? (hasD ? top : r("Subtotal", "sub")) + r("GST (10%)", "gst") + r("Total", "total", true)
    : inv.gst === "incl" ? top + r("Total", "total", true) + r("Includes GST of", "gst")
    : top + r("Total", "total", true);
  if (inv.pay) {
    const pays = s && Array.isArray(s.pays) ? s.pays : [];
    const dash = "border-top:1px dashed #dde3ea;";
    rows += s
      ? pays.map((p, i) => `<tr><td style="${L}${i ? "" : dash}">Paid${p.method ? ` · ${esc(p.method)}` : ""}</td>` +
          `<td style="${R}${i ? "" : dash}">${esc(fmtInv(inv.col, p.amount))}</td></tr>`).join("")
      : `<tr><td style="${L}${dash}">Paid by <span class="bl-in" style="width:110px"></span></td>` +
          `<td style="${R}${dash}"><span class="bl-in" style="width:90px"></span></td></tr>`;
    rows += r("Amount due", "due", true, true);
  }
  return `<table style="width:320px;max-width:100%;margin:8px 0 0 auto;border-collapse:collapse;font-size:10.5pt;color:#0f172a;">${rows}</table>`;
}

// Empty lines, tick-boxes and a signature box, for filling in by hand
function blankAnswer(f) {
  const line = '<div class="bl"></div>';
  const opts = Array.isArray(f.options) ? f.options : [];
  const otherLbl = esc(String(f.otherLabel || "").trim() || "Other");
  const tick = (label, round) => `<span class="bo"><span class="box${round ? " round" : ""}"></span>${label}</span>`;
  switch (f.type) {
    case "long_text": case "rich_text":
      return line.repeat({ small: 3, medium: 5, large: f.type === "rich_text" ? 12 : 8 }[f.size] || 5);
    case "number":
      return `<span class="bl-in" style="width:120px"></span>${f.unit ? ` ${esc(f.unit)}` : ""}`;
    case "date": case "record_date":
      return '<span class="bl-in" style="width:44px"></span> / <span class="bl-in" style="width:44px"></span> / <span class="bl-in" style="width:70px"></span>';
    case "dropdown": case "single_choice": case "checkboxes": {
      const round = f.type !== "checkboxes";
      const items = opts.map(optLabel).filter(Boolean);
      if (!items.length) return line;
      return `<div class="bo-wrap">${items.map((o) => tick(esc(o), round)).join("")}${
        f.allowOther ? tick(`${otherLbl}: <span class="bl-in"></span>`, round) : ""}</div>`;
    }
    case "checkbox_notes": {
      const rows = opts.map(optLabel).filter(Boolean)
        .map((o) => `<div class="bo-row"><span class="box"></span>${esc(o)} <span class="bl-in" style="width:260px"></span></div>`).join("");
      const other = f.allowOther ? `<div class="bo-row"><span class="box"></span>${otherLbl}: <span class="bl-in" style="width:260px"></span></div>` : "";
      return rows + other || line;
    }
    case "sub_checks": {
      const rows = (Array.isArray(f.groups) && f.groups.length ? f.groups : opts).map((o) => {
        const subs = optSubs(o).map(optLabel).filter(Boolean);
        return `<div class="bo-row"><span class="box"></span><b>${esc(optLabel(o))}</b>${
          subs.length ? `<div class="bo-subs">${subs.map((s) => tick(esc(s), false)).join("")}</div>` : ""}</div>`;
      }).join("");
      return rows || line;
    }
    case "table": {
      const cols = tableCols(f);
      if (!cols.length) return line;
      const n = Math.min(12, Math.max(3, f.addRows ? Math.min(tableMaxRows(f), 12) : parseInt(f.rows ?? f.rowCount, 10) || 4));
      const g = gridStart(f, cols);
      const row = `<tr>${cols.map((c) => `<td style="height:${g.h}px">${c.type === "check" ? '<span class="box"></span>' : ""}</td>`).join("")}</tr>`;
      return `${g.open}${g.head}${row.repeat(n)}${pdfTotalRow(f, cols, null)}</table>${pdfInv(f, null)}`;
    }
    case "signature":
      return '<div class="sig-box"></div><div class="sigmeta">Name: <span class="bl-in" style="width:220px"></span> &nbsp;&nbsp; Date: <span class="bl-in" style="width:110px"></span></div>';
    case "patient":
      return `<table class="kv">${patientParts(f).map(([, l]) =>
        `<tr><td class="k">${esc(l)}</td><td><span class="bl-in" style="width:320px"></span></td></tr>`).join("")}</table>`;
    case "clinician":
      return `<table class="kv">${clinicianParts(f).map(([, l]) =>
        `<tr><td class="k">${esc(l)}</td><td><span class="bl-in" style="width:320px"></span></td></tr>`).join("")}</table>`;
    case "consent_status": case "prescription_status":
      return "";
    case "calculation":
      return '<span class="bl-in" style="width:140px"></span>';
    case "specialist":
      return `<table class="kv"><tr><td class="k">Name</td><td><span class="bl-in" style="width:320px"></span></td></tr>${
        specialistParts(f).map(([, l]) => `<tr><td class="k">${esc(l)}</td><td><span class="bl-in" style="width:320px"></span></td></tr>`).join("")}</table>`;
    default:
      return line;
  }
}

function answer(f, v, sig, inline, x, blank = false) {
  if (blank && isUnanswered(f, v, sig)) return blankAnswer(f);
  const none = '<span class="none">Not answered</span>';
  switch (f.type) {
    case "short_text": case "long_text": case "email":
      return v ? esc(v).replace(/\n/g, "<br>") : none;
    case "rich_text":
      return typeof v === "string" && richText(v) ? `<div class="fe-rich">${cleanRichHtml(v)}</div>` : none;
    case "dropdown": case "single_choice":
      return v ? choiceText(f, v, x) : none;
    case "date": case "record_date":
      return v ? esc(niceDate(v)) : none;
    case "number":
      return v === null || v === undefined || v === "" ? none : esc(`${v}${f.unit ? " " + f.unit : ""}`);
    case "checkboxes":
      if (!Array.isArray(v) || !v.length) return '<span class="none">None ticked</span>';
      return inline
        ? v.map((o) => choiceText(f, o, x)).join(", ")
        : `<ul>${v.map((o) => `<li>${choiceText(f, o, x)}</li>`).join("")}</ul>`;
    case "checkbox_notes": {
      const oLbl = String(f.otherLabel || "").trim() || "Other";
      return Array.isArray(v) && v.length
        ? `<ul>${v.map((r) => `<li>${f.allowOther && r.option === oLbl && r.note
            ? `${esc(r.option)}: ${esc(r.note)}`
            : `${esc(r.option)}${r.note ? ` <span class="note">(${esc(r.note)})</span>` : ""}`}</li>`).join("")}</ul>`
        : '<span class="none">None ticked</span>';
    }
    case "sub_checks": {
      const oLbl = String(f.otherLabel || "").trim() || "Other";
      return Array.isArray(v) && v.length
        ? `<ul>${v.map((r) => {
            if (r.other) return `<li>${esc(r.option)}: ${esc(r.other)}</li>`;
            const notes = new Map((Array.isArray(r.subNotes) ? r.subNotes : []).map((n) => [n.sub, n.note]));
            const subs = (r.subs || []).map((s) => (s === oLbl && r.subOther
              ? `${esc(s)}: ${esc(r.subOther)}`
              : `${esc(s)}${notes.get(s) ? ` <span class="note">(${esc(notes.get(s))})</span>` : ""}`));
            return `<li>${esc(r.option)}${subs.length ? `: ${subs.join(", ")}` : ""}</li>`;
          }).join("")}</ul>`
        : '<span class="none">None ticked</span>';
    }
    case "table": {
      const cols = tableCols(f);
      const filled = (c) => c !== "" && c !== false && c !== null && c !== undefined;
      const rows = (Array.isArray(v) ? v : []).filter((r) => r && Array.isArray(r.cells) && r.cells.some(filled));
      if (!rows.length) return none;
      const cellText = (c, x) => {
        if (c.type === "check") return x === true ? "Yes" : "";
        if (x === null || x === undefined || x === false || x === "") return "";
        if (c.type === "date") return esc(niceDate(String(x)));
        if (c.type === "calc") return esc(fmtCol(c, x));
        if (c.type === "number") {
          return esc(c.prefix || c.decimals ? fmtCol(c, x) : typeof x === "number" ? String(+x.toFixed(4)) : String(x));
        }
        return esc(String(x));
      };
      const g = gridStart(f, cols);
      const sums = tableSums(f, rows.map((r) => r.cells), x && x.disc, x && x.pays);
      return `${g.open}${g.head}${rows.map((r) => `<tr>${cols.map((c, i) => `<td style="height:${g.h}px;${
        isNumCol(c) ? "text-align:right;" : ""}">${cellText(c, r.cells[i])}</td>`).join("")}</tr>`).join("")}${
        pdfTotalRow(f, cols, sums)}</table>${pdfInv(f, sums)}`;
    }
    case "calculation":
      return esc(formatCalc(v, f) || "—");
    case "signature": {
      if (!(typeof sig === "string" && PNG_RE.test(sig))) return '<span class="none">Not signed</span>';
      const meta = v && typeof v === "object" && (v.name || v.date)
        ? `Signed${v.name ? ` by ${esc(v.name)}` : ""}${v.date ? ` on ${esc(niceDate(v.date))}` : ""}`
        : "";
      return `<div class="sig"><img src="${sig}" height="70" alt="Signature"></div>${meta ? `<div class="sigmeta">${meta}</div>` : ""}`;
    }
    case "patient": {
      const d = v || {};
      return `<table class="kv">${patientParts(f).map(([k, l]) =>
        `<tr><td class="k">${esc(l)}</td><td>${d[k] ? esc(d[k]) : '<span class="none">—</span>'}</td></tr>`).join("")}</table>`;
    }
    case "clinician": {
      const d = v && typeof v === "object" ? v : {};
      return `<table class="kv">${clinicianParts(f).map(([k, l]) =>
        `<tr><td class="k">${esc(l)}</td><td>${d[k] ? esc(d[k]) : '<span class="none">—</span>'}</td></tr>`).join("")}</table>`;
    }
    case "specialist":
      return v && typeof v === "object" && v.name ? specialistBlockHtml(f, v) : none;
    case "consent_status":
    case "prescription_status": {
      const rx = f.type === "prescription_status";
      return v && v.found
        ? `${rx ? "Prescription" : "Signed"} ${v.name ? `“${esc(v.name)}” ` : ""}on ${esc(niceDate(v.date))}`
        : `<span class="none">No ${rx ? "valid prescription" : "signed consent"} found</span>`;
    }
  }
  return none;
}

// Questions side by side: consecutive part-width questions share a row (a simple table, so the server's PDF backup can draw it too)
function pdfRows(fields, parts) {
  let out = "";
  let row = [];
  let used = 0;
  const flush = () => {
    if (!row.length) return;
    const pct = (u) => ((u / 6) * 100).toFixed(3);
    out += `<table style="width:100%;border-collapse:collapse;table-layout:fixed;margin:0;"><tr>${
      row.map((c, i) => `<td style="width:${pct(c.u)}%;vertical-align:top;padding:0 ${
        i < row.length - 1 || used < 6 ? 14 : 0}px 0 0;">${c.html}</td>`).join("")}${
      used < 6 ? `<td style="width:${pct(6 - used)}%"></td>` : ""}</tr></table>`;
    row = [];
    used = 0;
  };
  fields.forEach((f, i) => {
    const html = parts[i];
    if (!html) return;                         // hidden, or left out of the PDF
    const u = spanUnits(f);
    if (u >= 6) { flush(); out += html; return; }
    if (used + u > 6) flush();
    row.push({ u, html });
    used += u;
  });
  flush();
  return out;
}

// Returns:
//   inner       the document itself (inside <div class="pdfdoc">)
//   css         its styling (all scoped to .pdfdoc)
//   previewHtml a full page that looks like a sheet of paper (for Preview)
//   printHtml   a plain page, used only if the browser can't make the PDF
//   fileName
// blank: unanswered questions print as empty lines and boxes, and every question shows (Task Manager → To Print)
export function buildFormDocument({ sub, ver, letterhead: lh, images = {}, blank = false }) {
  // Merge tags, as saved with the form. A blank printable gets a line to write on instead.
  const tags = {
    ...tagValues({ patient: { name: sub.patientName }, staff: { name: sub.createdBy }, recordDate: sub.recordDate, today: sub.recordDate }),
    ...((sub.answers && sub.answers.__tags) || {}),
  };
  // Answers' tags: a line to write on in a blank print; empty on forms saved before answers had tags
  formFieldTags((ver.fields || []).map(normaliseField).filter(Boolean)).forEach((t) => { if (!(t.key in tags)) tags[t.key] = ""; });
  const missing = blank ? "____________" : "";
  const fields = (ver.fields || []).map(normaliseField).filter(Boolean).map((f) => ({
    ...f,
    label: fillTags(f.label, tags, missing),
    help: fillTags(f.help, tags, missing),
    text: fillTags(f.text, tags, missing),
    html: f.html ? fillTagsHtml(f.html, tags, missing) : f.html,
  }));
  const showLh = !(ver.settings && ver.settings.showLetterhead === false);
  const shown = blank ? new Set(fields.map((f) => f.id)) : visibleIds(fields, sub.answers);

    const parts = fields.map((f) => {
    if (!shown.has(f.id)) return "";
    if (f.liveHide ? !f.liveHideShow : f.pdfHide) return ""; // hidden from staff (unless kept for the PDF), or live form only
    if (f.type === "watermark" || f.type === "photo") return "";
    if (f.type === "space") return `<div style="height:${{ small: 8, medium: 20, large: 40 }[f.size] || 20}px"></div>`;
    if (f.type === "letterhead") return letterhead(lh);

    const st = fieldStyle(f);
    const after = { normal: 0, more: 12, most: 24 }[st.space] || 0;
    const box = `text-align:${st.align} !important;${after ? `margin-bottom:${after}px;` : ""}`;

    if (f.type === "button") { // a PDF can't be clicked: the text, with the link written underneath
      const href = buttonHref(f, tags);
      if (!href || href.startsWith("#")) return ""; // portal pages mean nothing on paper
      const shown = href.replace(/^(mailto|tel):/i, "");
      // Real links, so the button and the address can be clicked in the PDF (the address stays for printed copies)
      return `<div class="block" style="${box}">` +
        `<a href="${esc(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:6px 14px;border:1.5px solid #0f766e;border-radius:8px;color:#0f766e;font-weight:bold;font-size:10pt;text-decoration:none;">${esc(f.label || "Link")}</a>` +
        `<div style="font-size:8.5pt;color:#475569;margin-top:4px;word-break:break-all;"><a href="${esc(href)}" target="_blank" rel="noopener" style="color:#475569;text-decoration:none;">${esc(shown)}</a></div></div>`;
    }
    if (f.type === "text_block") {
      const fs = { small: 9, normal: 10, large: 11.5 }[st.textSize] || 10;
      const content = textBlockHtml(f);
      return `<div class="block" style="${box}">${f.label ? `<h2>${esc(f.label)}</h2>` : ""}${
        content ? `<div style="font-size:${fs}pt;line-height:1.55;">${content}</div>` : ""}</div>`;
    }

    const raw = sub.answers[f.id];
    const v = f.type === "rich_text" && typeof raw === "string" ? fillTagsHtml(raw, tags, missing) : raw; // tags left empty when it was saved
    const sig = sub.signatures[f.id];
    const label = st.hideLabel ? "" : esc(f.label || "");
    const gap = { tight: 2, normal: 4, wide: 10 }[st.gap] || 4;
    if (f.type === "aftercare") {
      const items = v && Array.isArray(v.items) ? v.items : [];
      if (!items.length) return "";
      return `<div style="${box}">${label ? `<div class="ql" style="margin:10px 0 ${gap}px;">${label}</div>` : ""}${
        items.map((it) => `<div class="ac-pdf" style="margin:0 0 12px;">
          <h2 style="font-size:12.5pt;margin:8px 0 4px;color:#0f766e;">${esc(it.title || "Aftercare")}</h2>
          ${it.discussed ? discussedLine(it.discussedBy, it.discussedAt) : ""}
          <div class="fe-rich" style="font-size:10pt;line-height:1.55;">${cleanRichHtml(it.html || "")}</div></div>`).join("")}${
        v.discussed ? discussedLine(v.discussed.by, v.discussed.at) : ""}</div>`;
    }
    if (f.type === "consumables") {
      const lines = v && Array.isArray(v.lines) ? v.lines : [];
      const items = f.items || [];
      if (!lines.length && !(blank && items.length)) return "";
      const rows = lines.length
        ? lines.map((l) => (l.rows && l.rows.length ? l.rows : [{ amount: l.total }]).map((r, i) => `<tr>
            <td>${i ? "" : esc(l.name)}</td><td>${esc(l.kind !== "kit" && l.doseUnit && r.dose
              ? `${+Number(r.dose).toFixed(2)} ${l.doseUnit}` : `${+Number(r.amount || 0).toFixed(1)} ${l.unit || ""}`)}</td>
                        <td>${esc(r.batch ? `${l.batchLabel || "Batch"} ${r.batch}` : "")}</td><td>${esc(r.expiry ? niceDate(r.expiry) : "")}</td></tr>`).join("")).join("")
        : items.map((it) => `<tr><td>${esc(it.name)}</td><td style="height:24px"></td><td></td><td></td></tr>`).join("");
      return `<div class="q" style="${box}">${label ? `<div class="ql" style="margin-bottom:${gap}px;">${label}</div>` : ""}` +
        `<table class="grid"><tr><th>Product</th><th>Amount</th><th>Batch / Lot</th><th>Expiry</th></tr>${rows}</table></div>`;
    }
    if (f.type === "image") {
      if (f.source === "staff") {
        const photos = (v && Array.isArray(v.photos) ? v.photos : []).filter((p) => images[p.path ? p.path : `bank:${p.bankId}`]);
        if (!photos.length) return "";
        const stack = f.photoLayout === "stack";
        const perRow = Math.max(2, Math.min(4, parseInt(f.perRow, 10) || 2));
        const width = stack ? `${imageSizing({ ...f, annotate: true }).pct}%` : `${(100 / perRow) - 2}%`;
        const one = (p) => {
          const base = images[p.path ? p.path : `bank:${p.bankId}`];
          const over = p.drawingPath && images[p.drawingPath];
          return `<span style="position:relative;display:inline-block !important;width:${width};max-width:100%;margin:0 1% 8px;vertical-align:top;">` +
            `<img src="${base}" alt="" style="display:block !important;width:100%;height:auto;border-radius:4px;">` +
            (over ? `<img src="${over}" alt="" style="position:absolute;left:0;top:0;width:100%;height:100%;">` : "") + "</span>";
        };
        return `<div class="block" style="${box}">${label ? `<div class="ql" style="margin-bottom:${gap}px;">${label}</div>` : ""}${
          photos.map(one).join(stack ? "<br>" : "")}${
          f.caption ? `<div style="font-size:9pt;color:#64748b;margin-top:2px;">${esc(f.caption)}</div>` : ""}</div>`;
      }
      if (!f.fileId || !images[f.fileId]) return "";
      const { pct, maxH } = imageSizing(f);
      const drawing = f.annotate && v && typeof v === "object" && PNG_RE.test(v.drawing || "") ? v.drawing : "";
      const pic = drawing
        ? `<span style="position:relative;display:inline-block !important;width:${pct}%;max-width:100%;">` +
            `<img src="${images[f.fileId]}" alt="" style="display:block !important;width:100%;height:auto;">` +
            `<img src="${drawing}" alt="" style="position:absolute;left:0;top:0;width:100%;height:100%;"></span>`
        : maxH
          ? `<span style="display:inline-block !important;width:${pct}%;max-width:100%;">` +
              `<img src="${images[f.fileId]}" alt="" style="display:inline-block !important;width:auto;height:auto;max-width:100%;max-height:${maxH}px;"></span>`
          : `<img src="${images[f.fileId]}" alt="" style="display:inline-block !important;width:${pct}%;max-width:100%;height:auto;">`;
      const sumTxt = markSummary(v);
      const answeredQs = v && typeof v === "object" && Array.isArray(v.questions) ? v.questions : [];
      const extras = (sumTxt ? `<div style="font-size:10pt;font-weight:bold;margin-top:5px;">${esc(sumTxt)}</div>` : "") +
        (answeredQs.length
          ? answeredQs.map((q) => `<div style="font-size:10pt;margin-top:3px;"><span style="color:#475569;">${esc(q.label)}</span> ${esc(q.value)}</div>`).join("")
          : blank ? (f.questions || []).filter((q) => String(q.label || "").trim()).map((q) => {
              const t = q.type === "choice" || !q.type ? "radio" : q.type;
              const ctrl = t === "text" ? '<span class="bl-in" style="width:260px"></span>'
                : t === "long" ? '<div class="bl"></div><div class="bl"></div>'
                : (q.options || []).map((o) => `<span class="bo"><span class="box${t === "checks" ? "" : " round"}"></span>${esc(o)}</span>`).join("");
              return `<div style="font-size:10pt;margin-top:5px;"><span style="color:#475569;">${esc(q.label)}</span> ${ctrl}</div>`;
            }).join("") : "");
      return `<div class="block" style="${box}">${label ? `<div class="ql" style="margin-bottom:${gap}px;">${label}</div>` : ""}${pic}${extras}${
        f.caption ? `<div style="font-size:9pt;color:#64748b;margin-top:4px;">${esc(f.caption)}</div>` : ""}</div>`;
    }

    const xx = f.type === "table" // tables: the discount and payments
      ? { disc: sub.answers[`${f.id}__d`], pays: sub.answers[`${f.id}__p`] }
      : sub.answers[`${f.id}__x`];
    if (st.pos === "beside" && INLINE_TYPES.includes(f.type)) {
      const qw = { narrow: "25%", medium: "40%", wide: "55%" }[st.qWidth]; // "Fit" = as wide as the question
      return `<div class="q" style="${box}"><table class="qi"><tr>` +
        `<td class="ql" style="${qw ? `width:${qw};` : "width:1%;white-space:nowrap;"}padding-right:${gap * 4}px;text-align:${st.align} !important;">${label}</td>` +
                `<td class="qa" style="text-align:${st.align} !important;">${answer(f, v, sig, true, xx, blank)}</td></tr></table></div>`;
    }
    return `<div class="q" style="${box}">${label ? `<div class="ql" style="margin-bottom:${gap}px;">${label}</div>` : ""}` +
           `<div class="qa">${answer(f, v, sig, false, xx, blank)}</div></div>`;
  });
  const body = pdfRows(fields, parts);

  const fileName = `${[sub.templateName, sub.patientName || (blank ? "Blank" : ""), niceDate(sub.recordDate)]
    .filter(Boolean).join(" - ")}.pdf`.replace(/[\\/:*?"<>|]+/g, "-");

  const s = ver.settings || {};
  const align = ["left", "center", "right"].includes(s.titleAlign) ? s.titleAlign : "left";
  const pt = { small: 15, medium: 19, large: 24 }[s.titleSize] || 19;
  const inner = `
    ${showLh ? letterhead(lh) : ""}
    ${s.showTitle !== false
      ? `<h1 style="text-align:${align} !important;font-size:${pt}pt;">${esc(fillTags(ver.name, tags, missing))}</h1>` : ""}
    ${s.showMeta !== false
      ? `<p class="meta" style="text-align:${align} !important;">${sub.patientName || !blank
          ? `${esc(sub.patientName)}${sub.recordDate ? ` · ${esc(niceDate(sub.recordDate))}` : ""}`
          : 'Patient: <span class="bl-in" style="width:240px"></span> &nbsp;&nbsp; Date: <span class="bl-in" style="width:120px"></span>'}</p>` : ""}
    ${body}
    ${Array.isArray(sub.moves) && sub.moves.length
      ? `<p style="margin:16px 0 0;font-size:8.5pt;color:#64748b;">Patient details corrected on ${esc(fmtIso(sub.moves[sub.moves.length - 1].at))}.</p>` : ""}`;

  const previewHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(fileName)}</title><style>
    body { margin: 0; background: #e2e8f0; overflow-x: hidden; }
    .page { width: 703px; margin: 24px auto; padding: 45px; background: #fff; box-shadow: 0 4px 24px rgba(15, 23, 42, .15); }
    ${CSS}
  </style></head><body><div class="page"><div class="pdfdoc">${inner}</div></div></body></html>`;

  const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(fileName)}</title><style>
    body { margin: 0; }
    ${CSS}
  </style></head><body><div class="pdfdoc">${inner}</div></body></html>`;

  return { inner, css: CSS, previewHtml, printHtml, fileName };
}