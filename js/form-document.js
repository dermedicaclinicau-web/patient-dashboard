// The PDF version of a saved form: questions with written answers, tables,
// signatures and the letterhead. The browser turns this into the PDF, so it
// looks exactly like the preview. (Simple tables are used so the server's
// backup PDF converter can render it too.)
import { formatCalc } from "./form-calc.js";
import { visibleIds } from "./form-conditions.js";
import { esc, normaliseField, patientParts, INLINE_TYPES, fieldStyle, imageSizing, textBlockHtml } from "./form-fields.js";
import { cleanRichHtml } from "./rich-html.js";

const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

export function niceDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return key || "";
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

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
  .pdfdoc .q { padding: 9px 0; border-bottom: 1px solid #e2e8f0; page-break-inside: avoid; }
  .pdfdoc .ql { font-size: 9.5pt; font-weight: bold; color: #475569; margin-bottom: 4px; }
  .pdfdoc .qa { font-size: 11pt; line-height: 1.45; }
  .pdfdoc table.qi { width: 100%; border-collapse: collapse; }
  .pdfdoc table.qi td { padding: 0; vertical-align: top; }
  .pdfdoc table.qi td.ql { width: 40%; padding: 2px 14px 0 0; margin: 0; }
  .pdfdoc .none { color: #94a3b8; font-style: italic; }
  .pdfdoc .note { color: #475569; }
  .pdfdoc ul { margin: 2px 0; padding-left: 18px; }
  .pdfdoc table.grid { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  .pdfdoc table.grid th, .pdfdoc table.grid td { border: 1px solid #cbd5e1; padding: 5px 7px; text-align: left; }
  .pdfdoc table.grid th { background: #f1f5f9; }
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

function answer(f, v, sig, inline, x) {
  const none = '<span class="none">Not answered</span>';
  switch (f.type) {
    case "short_text": case "long_text": case "email":
      return v ? esc(v).replace(/\n/g, "<br>") : none;
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
            const subs = (r.subs || []).map((s) => (s === oLbl && r.subOther ? `${esc(s)}: ${esc(r.subOther)}` : esc(s)));
            return `<li>${esc(r.option)}${subs.length ? `: ${subs.join(", ")}` : ""}</li>`;
          }).join("")}</ul>`
        : '<span class="none">None ticked</span>';
    }
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
    case "consent_status":
      return v && v.found
        ? `Signed ${v.name ? `“${esc(v.name)}” ` : ""}on ${esc(niceDate(v.date))}`
        : '<span class="none">No signed consent found</span>';
  }
  return none;
}

// Returns:
//   inner       the document itself (inside <div class="pdfdoc">)
//   css         its styling (all scoped to .pdfdoc)
//   previewHtml a full page that looks like a sheet of paper (for Preview)
//   printHtml   a plain page, used only if the browser can't make the PDF
//   fileName
export function buildFormDocument({ sub, ver, letterhead: lh, images = {} }) {
  const fields = (ver.fields || []).map(normaliseField).filter(Boolean);
  const showLh = !(ver.settings && ver.settings.showLetterhead === false);
  const shown = visibleIds(fields, sub.answers);

    const body = fields.map((f) => {
    if (!shown.has(f.id)) return "";
    if (f.type === "watermark" || f.type === "photo") return "";
    if (f.type === "space") return `<div style="height:${{ small: 8, medium: 20, large: 40 }[f.size] || 20}px"></div>`;
    if (f.type === "letterhead") return letterhead(lh);

    const st = fieldStyle(f);
    const after = { normal: 0, more: 12, most: 24 }[st.space] || 0;
    const box = `text-align:${st.align} !important;${after ? `margin-bottom:${after}px;` : ""}`;

    if (f.type === "text_block") {
      const fs = { small: 9, normal: 10, large: 11.5 }[st.textSize] || 10;
      const content = textBlockHtml(f);
      return `<div class="block" style="${box}">${f.label ? `<h2>${esc(f.label)}</h2>` : ""}${
        content ? `<div style="font-size:${fs}pt;line-height:1.55;">${content}</div>` : ""}</div>`;
    }

    const v = sub.answers[f.id];
    const sig = sub.signatures[f.id];
    const label = st.hideLabel ? "" : esc(f.label || "");
    const gap = { tight: 2, normal: 4, wide: 10 }[st.gap] || 4;
    if (f.type === "aftercare") {
      const items = v && Array.isArray(v.items) ? v.items : [];
      if (!items.length) return "";
      return `<div style="${box}">${label ? `<div class="ql" style="margin:10px 0 ${gap}px;">${label}</div>` : ""}${
        items.map((it) => `<div class="ac-pdf" style="margin:0 0 12px;">
          <h2 style="font-size:12.5pt;margin:8px 0 6px;color:#0f766e;">${esc(it.title || "Aftercare")}</h2>
          <div class="fe-rich" style="font-size:10pt;line-height:1.55;">${cleanRichHtml(it.html || "")}</div></div>`).join("")}</div>`;
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
      return `<div class="block" style="${box}">${label ? `<div class="ql" style="margin-bottom:${gap}px;">${label}</div>` : ""}${pic}${
        f.caption ? `<div style="font-size:9pt;color:#64748b;margin-top:4px;">${esc(f.caption)}</div>` : ""}</div>`;
    }

    if (st.pos === "beside" && INLINE_TYPES.includes(f.type)) {
      const qw = { narrow: "25%", medium: "40%", wide: "55%" }[st.qWidth]; // "Fit" = as wide as the question
      return `<div class="q" style="${box}"><table class="qi"><tr>` +
        `<td class="ql" style="${qw ? `width:${qw};` : "width:1%;white-space:nowrap;"}padding-right:${gap * 4}px;text-align:${st.align} !important;">${label}</td>` +
        `<td class="qa" style="text-align:${st.align} !important;">${answer(f, v, sig, true, sub.answers[`${f.id}__x`])}</td></tr></table></div>`;
    }
    return `<div class="q" style="${box}">${label ? `<div class="ql" style="margin-bottom:${gap}px;">${label}</div>` : ""}` +
      `<div class="qa">${answer(f, v, sig, false, sub.answers[`${f.id}__x`])}</div></div>`;
  }).join("");

  const fileName = `${sub.templateName} - ${sub.patientName} - ${niceDate(sub.recordDate)}.pdf`
    .replace(/[\\/:*?"<>|]+/g, "-");

  const s = ver.settings || {};
  const align = ["left", "center", "right"].includes(s.titleAlign) ? s.titleAlign : "left";
  const pt = { small: 15, medium: 19, large: 24 }[s.titleSize] || 19;
  const inner = `
    ${showLh ? letterhead(lh) : ""}
    ${s.showTitle !== false
      ? `<h1 style="text-align:${align} !important;font-size:${pt}pt;">${esc(ver.name)}</h1>` : ""}
    ${s.showMeta !== false
      ? `<p class="meta" style="text-align:${align} !important;">${esc(sub.patientName)}${
          sub.recordDate ? ` · ${esc(niceDate(sub.recordDate))}` : ""}</p>` : ""}
    ${body}`;

  const previewHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(fileName)}</title><style>
    body { margin: 0; background: #e2e8f0; }
    .page { width: 703px; margin: 24px auto; padding: 45px; background: #fff; box-shadow: 0 4px 24px rgba(15, 23, 42, .15); }
    ${CSS}
  </style></head><body><div class="page"><div class="pdfdoc">${inner}</div></div></body></html>`;

  const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(fileName)}</title><style>
    body { margin: 0; }
    ${CSS}
  </style></head><body><div class="pdfdoc">${inner}</div></body></html>`;

  return { inner, css: CSS, previewHtml, printHtml, fileName };
}