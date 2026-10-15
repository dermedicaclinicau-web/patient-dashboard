import { runCalc, calcRefs, formatCalc } from "./form-calc.js";
import { letterheadHtml } from "./form-letterhead.js";
import { cleanCondition } from "./form-conditions.js";
import { cleanRichHtml, richText } from "./rich-html.js";
import { valueSvg } from "./marking-sets.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

const CAL = '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>';

export const ICONS = {
  patient: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M15 9h2M15 13h2M7 16h10"/>',
  short_text: '<path d="M4 7V4h16v3"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  long_text: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="3" y2="12"/><line x1="15" y1="18" x2="3" y2="18"/>',
  email: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  number: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  date: CAL,
  record_date: CAL + '<polyline points="9 16 11 18 15 14"/>',
  single_choice: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  checkboxes: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  checkbox_notes: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  sub_checks: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="12" y1="12" x2="21" y2="12"/><line x1="12" y1="18" x2="21" y2="18"/><polyline points="3 6 4 7 6 5"/><polyline points="7 12 8 13 10 11"/><polyline points="7 18 8 19 10 17"/>',
  dropdown: '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="9 11 12 14 15 11"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>',
  calculation: '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="11" x2="8" y2="11.01"/><line x1="12" y1="11" x2="12" y2="11.01"/><line x1="16" y1="11" x2="16" y2="11.01"/><line x1="8" y1="15" x2="8" y2="15.01"/><line x1="12" y1="15" x2="12" y2="15.01"/><line x1="16" y1="15" x2="16" y2="18"/><line x1="8" y1="18" x2="12" y2="18"/>',
  signature: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  photo: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  consent_status: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  prescription_status: '<path d="M10.5 20.5 3.5 13.5a4.95 4.95 0 1 1 7-7l7 7a4.95 4.95 0 1 1-7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>',
  text_block: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  letterhead: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="7" y1="6" x2="11" y2="6"/>',
  watermark: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  space: '<line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  consumables: '<path d="m18 2 4 4"/><path d="m17 7 3-3"/><path d="M19 9 8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5"/><path d="m9 11 4 4"/><path d="m5 19-3 3"/>',
  specialist: '<path d="M4 3v6a5 5 0 0 0 10 0V3"/><path d="M9 14v2a5 5 0 0 0 10 0v-3"/><circle cx="19" cy="11" r="2"/>',
  clinician: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2.5"/><path d="M14 10h5M14 14h4"/>',
};

// `was` = the name in the old Apps Script builder (tooltip + search).
export const FIELD_TYPES = {
  patient:        { name: "Patient details", was: "Patient Details", label: "Patient details" },
  clinician:      { name: "Clinician details", was: "Provider number Prescriber AHPRA Doctor", label: "Clinician" },
  short_text:     { name: "Short answer", was: "Short Text", label: "Untitled question" },
  long_text:      { name: "Long answer", was: "Long Text", label: "Untitled question" },
  email:          { name: "Email", was: "Email", label: "Email address" },
  number:         { name: "Number", was: "Number", label: "Untitled question" },
  date:           { name: "Date", was: "Date", label: "Date" },
  record_date:    { name: "Record date", was: "Record Date", label: "Record date" },
  single_choice:  { name: "Single choice", was: "1 Choice", label: "Untitled question" },
  checkboxes:     { name: "Checkboxes", was: "Multi-Checkbox", label: "Untitled question" },
  checkbox_notes: { name: "Checkboxes + notes", was: "Multi-Check+Comments", label: "Untitled question" },
  sub_checks:     { name: "Checkboxes + sub-options", was: "Sub-Checks", label: "Untitled question" },
  dropdown:       { name: "Dropdown", was: "Dropdown", label: "Untitled question" },
  table:          { name: "Table", was: "Table", label: "Untitled table" },
  calculation:    { name: "Calculation", was: "Calculation", label: "Total" },
  signature:      { name: "Signature", was: "Signature", label: "Patient signature" },
  image:          { name: "Image", was: "Image Photo Capture picture", label: "" },
  aftercare:      { name: "Aftercare", was: "Aftercare instructions", label: "Aftercare instructions" },
  consent_status: { name: "Consent check", was: "Consent Status", label: "Consent on file" },
  prescription_status: { name: "Prescription check", was: "Prescription Status", label: "Prescription on file" },
  text_block:     { name: "Text block", was: "Paragraph", label: "Information" },
  letterhead:     { name: "Letterhead", was: "Letterhead", label: "" },
  watermark:      { name: "Watermark", was: "Watermark", label: "" },
  space:          { name: "Space", was: "Space", label: "" },
  consumables:    { name: "Consumables", was: "Products used stock inventory", label: "Products used" },
  specialist:     { name: "Referral specialist", was: "Specialist referral doctor letter", label: "Referred to" },
};

export const FIELD_GROUPS = [
  ["Patient and visit", ["patient", "clinician", "record_date", "date"]],
  ["Answers", ["short_text", "long_text", "number", "email"]],
  ["Choices", ["single_choice", "dropdown", "checkboxes", "checkbox_notes", "sub_checks"]],
  ["Clinical", ["signature", "consent_status", "prescription_status", "image", "aftercare", "consumables", "specialist"]],
  ["Tables and maths", ["table", "calculation"]],
  ["Page layout", ["text_block", "space", "watermark"]],
];

export const CHOICE_TYPES = ["single_choice", "checkboxes", "checkbox_notes", "dropdown"];
// Choice fields that can have an "Other" choice and/or details boxes
// Details boxes: these types. "Other" choice: these plus the two checkbox variants.
export const EXTRA_TYPES = ["single_choice", "checkboxes", "dropdown"];
export const OTHER_TYPES = ["single_choice", "checkboxes", "dropdown", "checkbox_notes", "sub_checks"];
export const otherLabel = (f) => String((f && f.otherLabel) || "").trim() || "Other";
export const hasExtras = (f) => !!f && EXTRA_TYPES.includes(f.type) && (f.allowOther === true || (f.commentOn || []).length > 0);
// The choices as shown on the form: the typed choices, plus "Other" at the end
// (sub-option questions add "Other" as their own row instead)
export function choiceList(f) {
  const opts = Array.isArray(f.options) && f.options.length ? f.options : ["Option 1"];
  return f.allowOther && OTHER_TYPES.includes(f.type) && f.type !== "sub_checks" ? [...opts, otherLabel(f)] : [...opts];
}
// Checkboxes + sub-options: each sub-option can have a comment box (off / optional / required) and a note under it.
// Stored on the group as extras: [{ sub, box, hint, note }], matched by the sub-option's name.
export const SUB_BOX = ["off", "optional", "required"];
export function subExtra(g, s) {
  const x = (Array.isArray(g && g.extras) ? g.extras : []).find((e) => e && e.sub === s) || {};
  return { box: SUB_BOX.includes(x.box) ? x.box : "off", hint: String(x.hint || ""), note: String(x.note || "") };
}
function setSubExtra(g, s, x) {
  const rest = (Array.isArray(g.extras) ? g.extras : []).filter((e) => e && e.sub !== s);
  g.extras = x.box !== "off" || x.note.trim() || x.hint.trim() ? [...rest, { sub: s, ...x }] : rest;
}

// The builder's "Comment boxes and notes" list for one option's sub-options
export function subExtrasHtml(g, i) {
  const subs = (g && Array.isArray(g.subs) ? g.subs : []).filter((s) => String(s).trim());
  if (!subs.length) return "";
  const set = subs.filter((s) => { const x = subExtra(g, s); return x.box !== "off" || x.note.trim(); }).length;
  return `<details class="fe-subx"${set ? " open" : ""}>
    <summary>Comment boxes and notes${set ? ` (${set})` : ""}</summary>
    ${subs.map((s) => {
      const x = subExtra(g, s);
      const a = `data-grp="${i}" data-sx="${esc(s)}"`;
      return `<div class="fe-subx-row">
        <strong>${esc(s)}</strong>
        <select class="fb-select" ${a} data-sxk="box" data-rerender="" aria-label="Comment box for ${esc(s)}">
          ${[["off", "No comment box"], ["optional", "Comment box (optional)"], ["required", "Comment box (required)"]].map(([v, l]) =>
            `<option value="${v}"${x.box === v ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        ${x.box !== "off" ? `<input class="fe-input" ${a} data-sxk="hint" maxlength="100" placeholder="Hint in the box, e.g. Which side?" value="${esc(x.hint)}" />` : ""}
        <input class="fe-input" ${a} data-sxk="note" maxlength="200" placeholder="Note under it (optional), e.g. Use for dynamic lines only" value="${esc(x.note)}" />
      </div>`;
    }).join("")}
    <small class="fe-note">The comment box opens when staff tick that sub-option. The note is a guide for staff and isn't saved.</small>
  </details>`;
}

/* ---------- Tables: column types, adding rows, and column totals for Calculations ---------- */
export const TABLE_COL_TYPES = [["text", "Text"], ["number", "Number"], ["check", "Tick box"], ["date", "Date"], ["dropdown", "Dropdown"]];
const TCOL_KEYS = TABLE_COL_TYPES.map(([k]) => k);
const COL_ID = /^[A-Za-z0-9_-]{1,20}$/;
const newColId = () => "c" + Math.random().toString(36).slice(2, 8);

// A table's columns, tidied (older columns get a position-based id)
export function tableCols(f) {
  const list = Array.isArray(f && f.columns) && f.columns.length ? f.columns : [{ label: "Column 1", type: "text" }];
  return list.map((c, i) => ({
    id: COL_ID.test((c && c.id) || "") ? c.id : `c${i + 1}`,
    label: String((c && c.label) || ""),
    type: TCOL_KEYS.includes(c && c.type) ? c.type : "text",
    unit: String((c && c.unit) || ""),
    options: (Array.isArray(c && c.options) ? c.options : []).map(String).filter((o) => o.trim()),
  }));
}
// The most rows a table can have on the live form
export function tableMax(f) {
  const rows = int(f.rows, 1, 30, 3);
  return f.addRows === true ? int(f.maxRows, rows, 50, Math.max(rows, 10)) : rows;
}
// One row of a table. removable: a row staff added (gets a remove button)
export function tableRowHtml(f, live = true, removable = false) {
  const inert = live ? "" : ' tabindex="-1"';
  const cells = tableCols(f).map((c, ci) => {
    const a = ` data-c="${ci}"${inert}`;
    switch (c.type) {
      case "check": return `<td class="is-check"><input type="checkbox"${a} /></td>`;
      case "number": return `<td class="is-num"><input class="fe-tcell" type="number" step="any" inputmode="decimal"${a} /></td>`;
      case "date": return `<td><input class="fe-tcell" type="date"${a} /></td>`;
      case "dropdown": return `<td><select class="fe-tcell"${a}><option value=""></option>${
        c.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select></td>`;
      default: return `<td><input class="fe-tcell" type="text" maxlength="500"${a} /></td>`;
    }
  }).join("");
  const rm = live && f.addRows === true
    ? `<td class="fe-trm">${removable ? `<button type="button" class="hx-x" data-trm aria-label="Remove this row" title="Remove this row">${svg(ICONS.x)}</button>` : ""}</td>`
    : "";
  return `<tr>${cells}${rm}</tr>`;
}
// The "+ Add a row" button follows the limit
export function syncTableRows(f, w) {
  const b = w && w.querySelector("[data-tadd]");
  if (!b) return;
  const max = tableMax(f);
  const full = w.querySelectorAll("tbody tr").length >= max;
  b.disabled = full;
  b.textContent = full ? `Most rows reached (${max})` : "+ Add a row";
}
// Add / remove row buttons on a live form. Returns true if it handled the click.
export function tableClick(target, fields) {
  const add = target.closest("[data-tadd]");
  const rm = target.closest("[data-trm]");
  if (!add && !rm) return false;
  const w = target.closest("[data-fid]");
  const f = w && fields.find((x) => x.id === w.dataset.fid);
  const tbody = w && w.querySelector("tbody");
  if (!f || f.type !== "table" || !tbody) return false;
  if (add) {
    if (tbody.rows.length >= tableMax(f)) return true;
    tbody.insertAdjacentHTML("beforeend", tableRowHtml(f, true, true));
    const first = tbody.lastElementChild.querySelector("[data-c]");
    if (first) first.focus();
  } else {
    rm.closest("tr").remove();
  }
  syncTableRows(f, w);
  return true;
}
// The total of a Number column on a live form (null if every cell is empty)
export function tableTotal(f, w, colId) {
  const ci = tableCols(f).findIndex((c) => c.id === colId);
  if (ci < 0 || !w) return null;
  let sum = 0, any = false;
  w.querySelectorAll(`tbody [data-c="${ci}"]`).forEach((el) => {
    if (el.value === "") return;
    const n = Number(el.value);
    if (Number.isFinite(n)) { sum += n; any = true; }
  });
  return any ? Math.round(sum * 1e6) / 1e6 : null;
}
// How a table's column heading lines up: the table's setting, or automatic (numbers right, the rest left)
export const TABLE_HEAD_ALIGNS = ["auto", "left", "center", "right"];
export function tableHeadAlign(f, c) {
  const a = TABLE_HEAD_ALIGNS.includes(f && f.headAlign) ? f.headAlign : "auto";
  return a !== "auto" ? a : c && c.type === "number" ? "right" : "left";
}
const LAYOUT_TYPES = ["single_choice", "checkboxes", "checkbox_notes"];
const PLACEHOLDER_TYPES = ["short_text", "long_text", "email", "number", "dropdown"];
export const INLINE_TYPES = ["short_text", "email", "number", "date", "record_date", "dropdown", "single_choice", "checkboxes", "calculation"];
// Fields that get the Layout settings
const ANSWER_TYPES = ["patient", "clinician", "short_text", "long_text", "email", "number", "date", "record_date", "single_choice",
  "checkboxes", "checkbox_notes", "sub_checks", "dropdown", "table", "calculation", "signature", "image", "consent_status", "prescription_status",
  "specialist"];
const BOX_TYPES = ["short_text", "email", "number", "date", "record_date", "dropdown"];
const DRIVE_ID = /^[A-Za-z0-9_-]{10,80}$/;
const opt = (v, list, dflt) => (list.includes(v) ? v : dflt);
const fmtN = (n) => String(+Number(n || 0).toFixed(2));
// Pre-fill: the answer a question starts with when the form opens (staff can change it)
export const PREFILL_TYPES = ["short_text", "long_text", "email", "number", "single_choice", "dropdown", "checkboxes", "checkbox_notes"];
const PREFILL_NOTE = "Staff can change it before saving. It applies to forms filled in after you publish.";
const textPrefill = (f) => (!f.fill && typeof f.prefill === "string" ? f.prefill : "");
const numPrefill = (f) => (f.prefill !== null && f.prefill !== undefined && f.prefill !== "" && Number.isFinite(Number(f.prefill))
  ? Number(f.prefill) : null);
const isPrefilled = (f, o) => (f.type === "single_choice" || f.type === "dropdown"
  ? f.prefill === o : Array.isArray(f.prefill) && f.prefill.includes(o));

// "Pre-filled: Yes, No" for the builder chip ("" if nothing)
export function prefillSummary(f) {
  if (!f || !PREFILL_TYPES.includes(f.type)) return "";
  let s = "";
  if (Array.isArray(f.prefill)) s = f.prefill.join(", ");
  else if (f.type === "number") s = numPrefill(f) === null ? "" : String(numPrefill(f));
  else if (f.type === "single_choice" || f.type === "dropdown") s = f.prefill || "";
  else s = textPrefill(f).replace(/\s+/g, " ");
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

// A choice renamed in the builder keeps its pre-fill
export function renameInPrefill(f, from, to) {
  if (f.prefill === from) f.prefill = to;
  else if (Array.isArray(f.prefill)) f.prefill = f.prefill.map((x) => (x === from ? to : x));
}
// A choice removed in the builder is taken out of the pre-fill
export function tidyPrefill(f) {
  const opts = f.options || [];
  if (Array.isArray(f.prefill)) f.prefill = f.prefill.filter((x) => opts.includes(x));
  else if ((f.type === "single_choice" || f.type === "dropdown") && f.prefill && !opts.includes(f.prefill)) f.prefill = "";
}
// Pictures staff place unit marks on: their total can be used in a Calculation
export const isMarkImage = (x) => !!x && x.type === "image" && x.source !== "staff" && x.annotate === true && x.markMode === "marks";
export const calcSource = (x) => !!x && (["number", "calculation"].includes(x.type) || isMarkImage(x));

// The marking sets a picture uses (older forms saved just one, as markSetId)
export function markSetIdsOf(f) {
  const ids = Array.isArray(f && f.markSetIds) ? f.markSetIds.filter(Boolean) : [];
  return ids.length ? ids : f && f.markSetId ? [f.markSetId] : [];
}

// An Image field's size: width as a % of the page, and an optional maximum height in px.
// Pictures staff can draw on always keep their natural shape (so markings line up).
export function imageSizing(f) {
  const presets = { small: 30, medium: 50, large: 75, full: 100 };
  const pct = f.size === "custom"
    ? Math.max(10, Math.min(100, parseInt(f.widthPct, 10) || 50))
    : (presets[f.size] || 50);
  const raw = f.heightPx;
  const maxH = f.annotate || raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw))
    ? null
    : Math.max(40, Math.min(1200, Math.round(Number(raw))));
  return { pct, maxH };
}

// A field's layout settings, with defaults. The older "inline" tick counts as "beside".
export function fieldStyle(f) {
  const s = (f && f.style) || {};
  const beside = s.pos ? s.pos === "beside" : !!(f && f.inline);
  return {
    pos: beside && f && INLINE_TYPES.includes(f.type) ? "beside" : "below",
    qWidth: opt(s.qWidth, ["auto", "narrow", "medium", "wide"], "medium"),
    gap: opt(s.gap, ["tight", "normal", "wide"], "normal"),
    align: opt(s.align, ["left", "center", "right"], "left"),
    width: opt(s.width, ["full", "half", "third"], "full"),
    space: opt(s.space, ["normal", "more", "most"], "normal"),
    hideLabel: s.hideLabel === true,
    textSize: opt(s.textSize, ["small", "normal", "large"], "normal"),
  };
}

// Which patient details the Patient details block can show
export const PATIENT_PARTS = [
  ["name", "Full name"],
  ["dob", "Date of birth"],
  ["mobile", "Mobile"],
  ["email", "Email"],
  ["address", "Address"],
  ["pttId", "Patient ID"],
];
const PART_KEYS = PATIENT_PARTS.map((p) => p[0]);
const DEFAULT_PARTS = ["name", "dob", "address"];
export function patientParts(f) {
  const keys = Array.isArray(f.parts) && f.parts.length ? f.parts : DEFAULT_PARTS;
  return PATIENT_PARTS.filter(([k]) => keys.includes(k));
}

// Which staff details the Clinician details block can show (from Staff → Edit → Registration)
export const CLINICIAN_PARTS = [
  ["name", "Name"],
  ["quals", "Title and qualifications"],
  ["providerNo", "Provider number"],
  ["prescriberNo", "Prescriber number"],
  ["ahpraNo", "AHPRA registration"],
];
const CLIN_KEYS = CLINICIAN_PARTS.map((p) => p[0]);
const DEFAULT_CLIN = ["name", "providerNo"];
export function clinicianParts(f) {
  const keys = Array.isArray(f.parts) && f.parts.length ? f.parts : DEFAULT_CLIN;
  return CLINICIAN_PARTS.filter(([k]) => keys.includes(k));
}
// Short answers that fill in from the staff member's registration details
export const STAFF_FILLS = ["staff.providerNo", "staff.prescriberNo", "staff.ahpraNo", "staff.quals"];
// Referral specialist: the details it can show (the name is always shown)
export const SPECIALIST_PARTS = [
  ["speciality", "Speciality"], ["practice", "Practice"], ["address", "Address"], ["phone", "Phone"], ["email", "Email"],
];
const SP_KEYS = SPECIALIST_PARTS.map((p) => p[0]);
export function specialistParts(f) {
  const keys = Array.isArray(f && f.parts) ? f.parts : SP_KEYS;
  return SPECIALIST_PARTS.filter(([k]) => keys.includes(k));
}
// A chosen specialist as an address block (for letters) or a table. Used on the form, the saved form and the PDF.
export function specialistBlockHtml(f, v) {
  if (!v || !v.name) return "";
  const on = specialistParts(f).map(([k]) => k);
  const val = (k) => String(v[k] || "").trim();
  const br = (s) => esc(s).replace(/\n/g, "<br>");
  if (f.show === "table") {
    return `<table class="kv sp-kv"><tr><td class="k">Name</td><td><strong>${esc(v.name)}</strong></td></tr>${
      specialistParts(f).filter(([k]) => val(k)).map(([k, l]) => `<tr><td class="k">${esc(l)}</td><td>${br(val(k))}</td></tr>`).join("")}</table>`;
  }
  const contact = [on.includes("phone") && val("phone") && `Phone ${esc(val("phone"))}`,
    on.includes("email") && val("email") && esc(val("email"))].filter(Boolean).join(" · ");
  const lines = [`<strong>${esc(v.name)}</strong>`,
    ...["speciality", "practice", "address"].filter((k) => on.includes(k) && val(k)).map((k) => br(val(k))), contact].filter(Boolean);
  return `<div class="sp-letter" style="line-height:1.5">${lines.join("<br>")}</div>`;
}

export const SIGNERS = {
  patient: "Patient",
  practitioner: "Practitioner",
  guardian: "Parent or guardian",
  witness: "Witness",
};

export const FILLS = {
  "": "Nothing, staff type it",
  "patient.name": "Patient full name",
  "patient.firstName": "Patient first name",
  "patient.lastName": "Patient last name",
  "patient.dob": "Date of birth",
  "patient.email": "Patient email",
  "patient.mobile": "Patient mobile",
  "patient.address": "Patient address",
  "today": "Today's date",
  "staff.name": "Staff member filling it in",
  "staff.providerNo": "Provider number (staff filling it in)",
  "staff.prescriberNo": "Prescriber number (staff filling it in)",
  "staff.ahpraNo": "AHPRA registration (staff filling it in)",
  "staff.quals": "Title and qualifications (staff filling it in)",
};
export const FILLS_FOR = {
  short_text: ["", "patient.name", "patient.firstName", "patient.lastName", "patient.email", "patient.mobile", "patient.address", "staff.name",
    "staff.providerNo", "staff.prescriberNo", "staff.ahpraNo", "staff.quals"],
  long_text: ["", "patient.address"],
  email: ["", "patient.email"],
  date: ["", "today", "patient.dob"],
};

const NO_LABEL = ["space", "letterhead", "watermark"];
const NO_HELP = ["patient", "text_block", "space", "letterhead", "watermark"];
const NO_REQUIRED = ["text_block", "space", "letterhead", "watermark", "calculation", "consent_status", "prescription_status", "image", "aftercare", "consumables"];
export const hasLabel = (t) => !NO_LABEL.includes(t);
export const hasHelp = (t) => !NO_HELP.includes(t);
export const canRequire = (t) => !NO_REQUIRED.includes(t);

const LETTERHEAD = [
  "Unit 4/91 Scarborough Beach Rd, Scarborough WA 6019, Australia",
  "info@dermedica.com.au  |  Tel: 9205 1995",
];

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ===================== Creating and loading ===================== */

export function createField(type, id) {
  const f = { id, type, label: FIELD_TYPES[type].label, help: "", required: false };
  if (CHOICE_TYPES.includes(type)) f.options = ["Option 1", "Option 2"];
  if (OTHER_TYPES.includes(type)) { f.allowOther = false; f.otherLabel = "Other"; }
  if (EXTRA_TYPES.includes(type)) { f.commentOn = []; f.commentHint = "Please give details"; f.commentRequired = false; }
  if (LAYOUT_TYPES.includes(type)) f.layout = "list";
  if (PLACEHOLDER_TYPES.includes(type)) f.placeholder = type === "dropdown" ? "Choose one" : "";
  if (["patient", "signature", "record_date"].includes(type)) f.required = true;

  switch (type) {
    case "patient": f.parts = [...DEFAULT_PARTS]; break;
    case "clinician": f.parts = [...DEFAULT_CLIN]; f.who = "me"; break;
    case "long_text": f.size = "medium"; break;
    case "date": f.range = "any"; break;
    case "signature": f.signer = "patient"; f.showNameDate = true; break;
    case "text_block": f.text = ""; f.html = ""; break;
    case "space": f.size = "medium"; break;
    case "number": f.min = null; f.max = null; f.unit = ""; break;
    case "sub_checks":
      f.groups = [{ label: "Option A", subs: ["Sub-option 1", "Sub-option 2"] }];
      f.subCols = 1; f.subLayout = "list";
      break;
    case "table":
      f.columns = [{ id: "c1", label: "Column 1", type: "text" }, { id: "c2", label: "Column 2", type: "text" }];
      f.rows = 3; f.addRows = false; f.maxRows = 10; f.headAlign = "auto";
      break;
    case "calculation": f.formula = ""; f.decimals = 2; f.prefix = ""; f.suffix = ""; f.blank = "zero"; break;
    case "image":
      f.source = "bank"; f.fileId = ""; f.fileName = ""; f.size = "medium"; f.caption = ""; f.alt = ""; f.max = 1;
      f.annotate = false; f.widthPct = 50; f.heightPx = null; f.allowBank = true;
      f.photoLayout = "grid"; f.perRow = 2;
      f.markMode = "draw"; f.markSetId = ""; f.markSetIds = []; f.questions = [];
      break;
    case "watermark": f.source = "text"; f.text = "DRAFT"; f.opacity = 10; f.angle = -30; f.size = "large"; break;
    case "letterhead": f.line1 = LETTERHEAD[0]; f.line2 = LETTERHEAD[1]; break;
    case "consent_status": f.consentFormId = ""; f.months = 12; f.block = false; break;
    case "prescription_status": f.consentFormId = ""; f.months = 6; f.block = false; break;
    case "aftercare": f.mode = "fixed"; f.items = []; f.preselect = true; f.emailTemplate = ""; f.confirm = "each"; break;
    case "consumables": f.items = []; f.allowExtra = true; f.ifShort = "flag"; break;
    case "specialist": f.parts = [...SP_KEYS]; f.speciality = ""; f.allowAdd = true; f.allowEdit = true; f.show = "letter"; break;
  }
  return f;
}

// Fills in anything a saved field is missing, so older forms keep working
// as new settings are added. Unknown types are dropped.
export function normaliseField(f) {
  if (f && f.type === "photo") f = { ...f, type: "image", source: "staff" }; // the old Photo field
  if (!f || !FIELD_TYPES[f.type]) return null;
  const out = { ...createField(f.type, f.id), ...f };
  if (CHOICE_TYPES.includes(out.type) && !(Array.isArray(out.options) && out.options.length)) out.options = ["Option 1"];
  if (out.type === "sub_checks" && !(Array.isArray(out.groups) && out.groups.length)) out.groups = [{ label: "Option A", subs: [] }];
  if (out.type === "table" && !(Array.isArray(out.columns) && out.columns.length)) out.columns = [{ label: "Column 1", type: "text" }];
  if (out.type === "table") out.columns = out.columns.map((c, i) => ({ ...c, id: COL_ID.test((c && c.id) || "") ? c.id : `c${i + 1}` }));
  if (out.type === "patient" && !(Array.isArray(out.parts) && out.parts.length)) out.parts = [...DEFAULT_PARTS];
  if (out.type === "clinician" && !(Array.isArray(out.parts) && out.parts.length)) out.parts = [...DEFAULT_CLIN];
  return out;
}

/* ===================== Saving ===================== */

const clip = (v, max) => String(v ?? "").slice(0, max);
const int = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const numOrNull = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

// Only known keys are stored, and never `undefined` (Firestore rejects it).
export function cleanField(f) {
  if (f && f.type === "photo") f = { ...f, type: "image", source: "staff" };
  if (!f || !FIELD_TYPES[f.type]) return null;
  const out = {
    id: clip(f.id, 40),
    type: f.type,
    label: clip(f.label, 300),
    help: clip(f.help, 500),
    required: f.required === true,
  };
  if (CHOICE_TYPES.includes(f.type)) {
    out.options = (Array.isArray(f.options) ? f.options : []).map((o) => clip(o, 200)).slice(0, 50);
  }
  if (OTHER_TYPES.includes(f.type)) {
    out.allowOther = f.allowOther === true;
    out.otherLabel = clip(f.otherLabel, 60).trim() || "Other";
  }
  if (EXTRA_TYPES.includes(f.type)) {
    out.commentOn = (Array.isArray(f.commentOn) ? f.commentOn : [])
      .map(String).filter((o) => out.options.includes(o)).slice(0, 50);
    out.commentHint = clip(f.commentHint, 100);
    out.commentRequired = f.commentRequired === true;
  }
  if (LAYOUT_TYPES.includes(f.type)) out.layout = pick(f.layout, ["list", "columns", "inline"], "list");
  if (PLACEHOLDER_TYPES.includes(f.type)) out.placeholder = clip(f.placeholder, 100);
  if (ANSWER_TYPES.includes(f.type) || f.type === "text_block") out.style = fieldStyle(f);
  if (FILLS_FOR[f.type] && f.fill && FILLS_FOR[f.type].includes(f.fill)) out.fill = f.fill;

  switch (f.type) {
    case "patient": {
      const parts = (Array.isArray(f.parts) ? f.parts : []).filter((k) => PART_KEYS.includes(k));
      out.parts = parts.length ? PART_KEYS.filter((k) => parts.includes(k)) : ["name"];
      break;
    }
    case "clinician": {
      const parts = (Array.isArray(f.parts) ? f.parts : []).filter((k) => CLIN_KEYS.includes(k));
      out.parts = parts.length ? CLIN_KEYS.filter((k) => parts.includes(k)) : ["name"];
      out.who = f.who === "choose" ? "choose" : "me";
      break;
    }
    case "long_text": out.size = pick(f.size, ["small", "medium", "large"], "medium"); break;
    case "date": out.range = pick(f.range, ["any", "past", "future"], "any"); break;
    case "signature":
      out.signer = pick(f.signer, Object.keys(SIGNERS), "patient");
      out.showNameDate = f.showNameDate !== false;
      break;
    case "text_block":
      out.text = clip(f.text, 5000);
      out.html = f.html ? cleanRichHtml(f.html).slice(0, 30000) : "";
      break;
    case "space": out.size = pick(f.size, ["small", "medium", "large"], "medium"); break;
    case "number": out.min = numOrNull(f.min); out.max = numOrNull(f.max); out.unit = clip(f.unit, 20); break;
    case "sub_checks":
      out.groups = (Array.isArray(f.groups) ? f.groups : []).slice(0, 30).map((g) => {
        const subs = (Array.isArray(g && g.subs) ? g.subs : []).map((s) => clip(s, 200)).slice(0, 30);
        const extras = (Array.isArray(g && g.extras) ? g.extras : [])
          .filter((e) => e && subs.includes(String(e.sub)))
          .map((e) => ({ sub: String(e.sub), box: pick(e.box, SUB_BOX, "off"), hint: clip(e.hint, 100), note: clip(e.note, 200) }))
          .filter((e, k, a) => (e.box !== "off" || e.note.trim()) && a.findIndex((y) => y.sub === e.sub) === k);
        return {
          label: clip(g && g.label, 200),
          subs,
          other: !!(g && g.other === true),
          ...(extras.length ? { extras } : {}),
        };
      });
      out.subCols = int(f.subCols, 1, 4, 1);
      out.subLayout = pick(f.subLayout, ["list", "inline"], "list");
      break;
    case "table": {
      const seen = new Set();
      out.columns = tableCols(f).slice(0, 12).map((c, i) => {
        const id = seen.has(c.id) ? `${c.id}_${i}` : c.id;
        seen.add(id);
        return {
          id, label: clip(c.label, 100), type: c.type,
          ...(c.type === "number" ? { unit: clip(c.unit, 20) } : {}),
          ...(c.type === "dropdown" ? { options: c.options.map((o) => clip(o, 100)).slice(0, 30) } : {}),
        };
      });
      out.rows = int(f.rows, 1, 30, 3);
      out.addRows = f.addRows === true;
      out.maxRows = int(f.maxRows, out.rows, 50, Math.max(out.rows, 10));
      out.headAlign = pick(f.headAlign, TABLE_HEAD_ALIGNS, "auto");
      break;
    }
    case "calculation":
      out.formula = clip(f.formula, 500);
      out.decimals = int(f.decimals, 0, 4, 2);
      out.prefix = clip(f.prefix, 10);
      out.suffix = clip(f.suffix, 20);
      out.blank = pick(f.blank, ["zero", "wait"], "zero");
      break;
    case "image":
      out.source = pick(f.source, ["bank", "staff"], "bank");
      out.fileId = DRIVE_ID.test(f.fileId || "") ? f.fileId : "";
      out.fileName = clip(f.fileName, 120);
      out.size = pick(f.size, ["small", "medium", "large", "full", "custom"], "medium");
      out.widthPct = int(f.widthPct, 10, 100, 50);
      out.heightPx = numOrNull(f.heightPx) === null ? null : int(f.heightPx, 40, 1200, 300);
      out.caption = clip(f.caption, 200);
      out.alt = clip(f.alt, 200);
      out.max = int(f.max, 1, 10, 1);
      out.annotate = f.annotate === true;
      out.allowBank = f.allowBank !== false;
      out.photoLayout = pick(f.photoLayout, ["grid", "stack"], "grid");
      out.perRow = int(f.perRow, 2, 4, 2);
      out.markMode = out.annotate && f.markMode === "marks" ? "marks" : "draw";
      out.markSetIds = markSetIdsOf(f).filter((id) => /^[A-Za-z0-9_-]{1,40}$/.test(id)).slice(0, 6);
      out.markSetId = out.markSetIds[0] || ""; // for older pages
      out.questions = (Array.isArray(f.questions) ? f.questions : []).slice(0, 5).map((q, i) => ({
        id: /^[A-Za-z0-9_-]{1,20}$/.test((q && q.id) || "") ? q.id : `q${i + 1}`,
        label: clip(q && q.label, 200),
        type: iqType(q),
        options: (Array.isArray(q && q.options) ? q.options : []).map((o) => clip(o, 100)).filter((o) => o.trim()).slice(0, 10),
        required: !!(q && q.required === true),
      }));
      break;
    case "watermark":
      out.source = pick(f.source, ["text", "logo"], "text");
      out.text = clip(f.text, 40);
      out.opacity = int(f.opacity, 5, 40, 10);
      out.angle = int(f.angle, -60, 60, -30);
      out.size = pick(f.size, ["small", "medium", "large"], "large");
      break;
    case "letterhead": out.line1 = clip(f.line1, 150); out.line2 = clip(f.line2, 150); break;
    case "consent_status":
    case "prescription_status":
      out.consentFormId = clip(f.consentFormId, 40);
      out.months = int(f.months, 1, 60, f.type === "prescription_status" ? 6 : 12);
      out.block = f.block === true;
      break;
    case "aftercare":
      out.mode = pick(f.mode, ["fixed", "choose"], "fixed");
      out.items = (Array.isArray(f.items) ? f.items : [])
        .map(String).filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 20);
      out.preselect = f.preselect !== false;
      out.emailTemplate = /^[A-Za-z0-9]{10,40}$/.test(f.emailTemplate || "") ? f.emailTemplate : "";
      out.confirm = pick(f.confirm, ["each", "all", "off"], "each");
      break;
    case "consumables":
      out.items = (Array.isArray(f.items) ? f.items : [])
        .filter((it) => it && typeof it === "object" && /^[A-Za-z0-9_-]{1,80}$/.test(it.productId || ""))
        .slice(0, 25)
        .map((it) => ({
          productId: it.productId, name: clip(it.name, 150), unit: clip(it.unit, 30),
          kind: it.kind === "kit" ? "kit" : "storage",
          required: it.required === true,
          amount: Number(it.amount) > 0 ? Number(it.amount) : null,
          max: Number(it.max) > 0 ? Number(it.max) : null,
          from: /^[A-Za-z0-9_-]{1,40}$/.test(it.from || "") ? it.from : "",
        }));
      out.allowExtra = f.allowExtra !== false;
      out.ifShort = pick(f.ifShort, ["flag", "block"], "flag");
      break;
    case "specialist": {
      const parts = (Array.isArray(f.parts) ? f.parts : []).filter((k) => SP_KEYS.includes(k));
      out.parts = SP_KEYS.filter((k) => parts.includes(k));
      out.speciality = clip(f.speciality, 80).trim();
      out.allowAdd = f.allowAdd !== false;
      out.allowEdit = f.allowEdit !== false;
      out.show = pick(f.show, ["letter", "table"], "letter");
      break;
    }
}

  const sw = cleanCondition(f);
  if (PREFILL_TYPES.includes(f.type)) {
    const v = f.prefill;
    if (f.type === "single_choice" || f.type === "dropdown") {
      const s = clip(v, 200);
      if (s && out.options.includes(s)) out.prefill = s;
    } else if (f.type === "checkboxes" || f.type === "checkbox_notes") {
      const a = [...new Set((Array.isArray(v) ? v : []).map(String))].filter((o) => out.options.includes(o));
      if (a.length) out.prefill = a;
    } else if (f.type === "number") {
      const n = numOrNull(v);
      if (n !== null) out.prefill = n;
    } else if (!out.fill) {
      const s = clip(v, f.type === "long_text" ? 2000 : 500);
      if (s.trim()) out.prefill = s;
    }
  }
  if (sw) out.showWhen = sw;
  if (f.pdfHide === true && !["watermark", "letterhead"].includes(f.type)) out.pdfHide = true;
  return out;
}

/* ===================== Calculations: checking ===================== */

export function prettyFormula(src, byId) {
  return String(src || "")
    .replace(/\{([^}]*)\}/g, (_, raw) => {
      const id = raw.trim();
      const dot = id.indexOf(".");
      if (dot > 0) {
        const t = byId.get(id.slice(0, dot));
        const c = t && t.type === "table" ? tableCols(t).find((x) => x.id === id.slice(dot + 1)) : null;
        return c ? `[${t.label || "Table"} · ${c.label || "Column"} total]` : "[removed column]";
      }
      const f = byId.get(id);
      return f ? `[${f.type === "image" ? `${f.label || f.fileName || "Picture"} total` : f.label || "Untitled"}]` : "[removed question]";
    })
    .replace(/\*/g, "×")
    .replace(/\//g, "÷");
}

function refersToItself(startId, byId) {
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const f = byId.get(stack.pop());
    if (!f || f.type !== "calculation") continue;
    for (const ref of calcRefs(f.formula)) {
      if (ref === startId) return true;
      if (!seen.has(ref)) { seen.add(ref); stack.push(ref); }
    }
  }
  return false;
}

export function checkFormula(f, fields) {
  const src = String(f.formula || "").trim();
  if (!src) return { ok: false, error: "Add a formula. Tap a question below to start." };
  const byId = new Map(fields.map((x) => [x.id, x]));
  for (const id of calcRefs(src)) {
    const dot = id.indexOf(".");
    if (dot > 0) { // a table column total
      const t = byId.get(id.slice(0, dot));
      const col = t && t.type === "table" ? tableCols(t).find((c) => c.id === id.slice(dot + 1)) : null;
      if (!col) return { ok: false, error: "The formula uses a table column that has been removed." };
      if (col.type !== "number") return { ok: false, error: `“${col.label || "Column"}” in “${t.label || "Table"}” isn't a Number column any more.` };
      continue;
    }
    const r = byId.get(id);
    if (!r) return { ok: false, error: "The formula uses a question that has been removed." };
    if (!calcSource(r)) {
      return { ok: false, error: r.type === "image"
        ? `“${r.label || r.fileName || "Picture"}” doesn't have unit marks any more.`
        : `“${r.label || "Untitled"}” isn't a number question.` };
    }
  }
  if (refersToItself(f.id, byId)) return { ok: false, error: "The formula depends on its own result." };
  const r = runCalc(src, () => 1);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, reads: prettyFormula(src, byId) };
}

export function calcStatusHtml(f, fields) {
  const c = checkFormula(f, fields);
  return c.ok
    ? `<span class="fe-ok">The formula works</span><span class="fe-reads">Reads as: ${esc(c.reads)}</span>`
    : `<span class="fe-bad">${esc(c.error)}</span>`;
}

/* ===================== Drawing a field on the page ===================== */

// A Text block's content: rich text if it has some, otherwise the older plain text
export function textBlockHtml(f) {
  if (f.html && richText(f.html)) return `<div class="fe-rich">${cleanRichHtml(f.html)}</div>`;
  return f.text ? `<p>${esc(f.text).replace(/\n/g, "<br>")}</p>` : "";
}

// ctx: { live, fields, consentForms, letterhead, calcValues }
export function renderField(f, ctx = {}) {
  const live = !!ctx.live;
  const inert = live ? "" : ' tabindex="-1"';
  const id = esc(f.id);
  const q = hasLabel(f.type) && f.type !== "text_block" && !(f.type === "image" && !String(f.label || "").trim())
    ? `<div class="fe-q">${esc(f.label || FIELD_TYPES[f.type].label || "Untitled question")}${
        f.required ? '<span class="fe-req" aria-label="required">*</span>' : ""}</div>`
    : "";
  const help = f.help && hasHelp(f.type) ? `<div class="fe-help">${esc(f.help)}</div>` : "";
  // Layout settings (answer below or beside, gap, alignment, width, spacing) wrap the field
  if (!ctx.raw && (ANSWER_TYPES.includes(f.type) || f.type === "text_block")) return layoutField(f, ctx, q, help);
  const head = ctx.noHead ? "" : q + help;
  const opts = Array.isArray(f.options) && f.options.length ? f.options : ["Option 1"];
  const box = (type) => `<input type="${type}"${inert} />`;
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : "";
  const optsClass = `fe-opts is-${esc(f.layout || "list")}`;

  switch (f.type) {
    case "short_text": return head + `<input class="fe-in" type="text"${ph}${textPrefill(f) ? ` value="${esc(textPrefill(f))}"` : ""}${inert} />`;
    case "email": return head + `<input class="fe-in" type="email" autocomplete="off"${ph}${textPrefill(f) ? ` value="${esc(textPrefill(f))}"` : ""}${inert} />`;
    case "long_text": {
      const rows = { small: 2, medium: 4, large: 8 }[f.size] || 4;
      return head + `<textarea class="fe-in" rows="${rows}"${ph}${inert}>${esc(textPrefill(f))}</textarea>`;
    }
    case "date": {
      const t = todayIso();
      const limit = f.range === "past" ? ` max="${t}"` : f.range === "future" ? ` min="${t}"` : "";
      return head + `<input class="fe-in fe-in-date" type="date"${limit}${inert} />`;
    }
    case "record_date":
      return head + `<input class="fe-in fe-in-date" type="date" value="${todayIso()}"${inert} />` +
        (live ? "" : '<div class="fe-help fe-help-after">Starts as today\'s date. Staff can change it.</div>');
    case "number":
      return head + `<div class="fe-num"><input class="fe-in" type="number" data-in="${id}"${ph}${
        f.min !== null && f.min !== undefined ? ` min="${Number(f.min)}"` : ""}${
        f.max !== null && f.max !== undefined ? ` max="${Number(f.max)}"` : ""}${
        numPrefill(f) !== null ? ` value="${numPrefill(f)}"` : ""}${inert} />${
        f.unit ? `<span>${esc(f.unit)}</span>` : ""}</div>`;
    case "dropdown": {
      const list = choiceList(f);
      const cmt = (f.commentOn || []).filter((o) => list.includes(o));
      return head + `<select class="fe-in"${inert}><option value="">${esc(f.placeholder || "Choose one")}</option>${
        list.map((o) => `<option value="${esc(o)}"${!(f.allowOther && o === list[list.length - 1] && o === otherLabel(f)) && isPrefilled(f, o) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>` +
        (f.allowOther ? `<input class="fe-in fe-xin" type="text" data-other maxlength="500" placeholder="Type the ${esc(otherLabel(f).toLowerCase())} answer"${live ? " hidden" : ""}${inert} />` : "") +
        (cmt.length ? (live
          ? `<input class="fe-in fe-xin" type="text" data-cmt="dd" maxlength="1000" placeholder="${esc(f.commentHint || "Please give details")}" hidden />`
          : `<div class="fe-help fe-help-after">Asks for details when: ${esc(cmt.join(", "))}</div>`) : "");
    }
    case "single_choice":
    case "checkboxes": {
      const t = f.type === "single_choice" ? "radio" : "checkbox";
      const list = choiceList(f);
      const cmt = new Set(f.commentOn || []);
      return head + `<div class="${optsClass}">${list.map((o, i) => {
        const isOther = f.allowOther && i === list.length - 1;
        const on = !isOther && isPrefilled(f, o);
        const box = `<label class="fe-opt"><input type="${t}" name="${id}"${on ? " checked" : ""}${inert} /><span>${esc(o)}</span>${
          !live && !isOther && cmt.has(o) ? '<em class="fe-xtag">+ details</em>' : ""}</label>`;
        if (isOther) {
          return `<span class="fe-optx">${box}<input class="fe-in fe-xin" type="text" data-other maxlength="500" placeholder="Please specify"${live ? " hidden" : ""}${inert} /></span>`;
        }
        if (live && cmt.has(o)) {
          return `<span class="fe-optx">${box}<input class="fe-in fe-xin" type="text" data-cmt="${i}" maxlength="1000" placeholder="${esc(f.commentHint || "Please give details")}" hidden /></span>`;
        }
        return box;
      }).join("")}</div>`;
    }
    
    case "checkbox_notes": {
      const list = choiceList(f);
      return head + `<div class="${optsClass}">${list.map((o, i) => {
        const isOther = f.allowOther && i === list.length - 1;
        return `
        <div class="fe-optnote${isOther ? " is-other" : ""}">
          <label class="fe-opt"><input type="checkbox"${!isOther && isPrefilled(f, o) ? " checked" : ""}${inert} /><span>${esc(o)}</span></label>
          <input class="fe-in fe-note-in" type="text" placeholder="${isOther ? "Please specify" : "Add a note"}"${inert} />
        </div>`;
      }).join("")}</div>`;
    }
   case "sub_checks":
      return head + `<div class="fe-opts fe-subgrid cols-${int(f.subCols, 1, 4, 1)} sub-${f.subLayout === "inline" ? "inline" : "list"}">${(f.groups || []).map((g) => `
        <div class="fe-sub">
          <label class="fe-opt">${box("checkbox")}<span>${esc(g.label)}</span></label>
          ${(g.subs && g.subs.length) || g.other ? `<div class="fe-sub-opts">${(g.subs || []).map((s, j) => {
            const x = subExtra(g, s);
            const lab = `<label class="fe-opt">${box("checkbox")}<span>${esc(s)}${
              x.note.trim() ? `<small class="fe-subnote">${esc(x.note)}</small>` : ""}</span>${
              !live && x.box !== "off" ? `<em class="fe-xtag">+ comment${x.box === "required" ? " (required)" : ""}</em>` : ""}</label>`;
            if (!live || x.box === "off") return lab;
            return `<span class="fe-optx">${lab}<input class="fe-in fe-xin" type="text" data-subcmt="${j}"${
              x.box === "required" ? " data-req" : ""} maxlength="300" placeholder="${esc(x.hint.trim() || "Add a comment")}" hidden /></span>`;
          }).join("")}${g.other ? `
            <span class="fe-optx"><label class="fe-opt">${box("checkbox")}<span>${esc(otherLabel(f))}</span></label>
              <input class="fe-in fe-xin" type="text" data-subother maxlength="300" placeholder="Please specify"${live ? " hidden" : ""}${inert} /></span>` : ""}</div>` : ""}
        </div>`).join("")}${f.allowOther ? `
        <div class="fe-sub is-other"><span class="fe-optx">
          <label class="fe-opt">${box("checkbox")}<span>${esc(otherLabel(f))}</span></label>
          <input class="fe-in fe-xin" type="text" data-other maxlength="500" placeholder="Please specify"${live ? " hidden" : ""}${inert} />
        </span></div>` : ""}</div>`;
    case "table": {
      const cols = tableCols(f);
      const rows = int(f.rows, 1, 30, 3);
      const canAdd = live && f.addRows === true;
      let body = "";
      for (let r = 0; r < rows; r++) body += tableRowHtml(f, live, false);
      return head + `<div class="fe-table-wrap"><table class="fe-table"><thead><tr>${
        cols.map((c, i) => `<th${c.type === "number" ? ' class="is-num"' : ""} style="text-align:${tableHeadAlign(f, c)}">${esc(c.label || `Column ${i + 1}`)}${
          c.type === "number" && c.unit.trim() ? ` <small>(${esc(c.unit)})</small>` : ""}</th>`).join("")}${
        canAdd ? '<th class="fe-trm"></th>' : ""}</tr></thead><tbody>${body}</tbody></table></div>` +
        (canAdd ? '<button type="button" class="hx-add fe-tadd" data-tadd>+ Add a row</button>' : "") +
        (!live && f.addRows ? `<div class="fe-help fe-help-after">Staff can add rows, up to ${tableMax(f)}.</div>` : "");
    }
    case "calculation": {
      const v = ctx.calcValues ? ctx.calcValues[f.id] : null;
      const reads = f.formula ? prettyFormula(f.formula, new Map((ctx.fields || []).map((x) => [x.id, x]))) : "";
      return head + `<div class="fe-calc"><span class="fe-calc-v" data-calc="${id}">${esc(formatCalc(v, f) || "—")}</span>` +
        '<span class="fe-calc-tag">Calculated</span></div>' +
        (live ? "" : `<div class="fe-help fe-help-after">${reads ? "= " + esc(reads) : "No formula yet"}</div>`);
    }
    case "signature": {
      const who = SIGNERS[f.signer] || SIGNERS.patient;
      return head + `<div class="fe-sig"><span>${esc(who)} signs here</span></div>` +
        (!live && f.showNameDate !== false ? '<div class="fe-sig-preview"><span>Name</span><span>Date</span></div>' : "");
    }
    case "image": {
      const cap = f.caption ? `<figcaption>${esc(f.caption)}</figcaption>` : "";
       if (f.source === "staff") {
        const max = Math.max(1, Math.min(10, parseInt(f.max, 10) || 1));
        if (live) return `<div class="ph-host" data-ph-host></div>${cap}`;
        const how = f.photoLayout === "stack" ? "one under another" : `side by side, ${Math.max(2, Math.min(4, parseInt(f.perRow, 10) || 2))} per row`;
        return `<div class="fe-img-staff">${svg(ICONS.photo)}<span>Staff take or upload ${
          max > 1 ? `up to ${max} photos` : "a photo"} while filling in · ${how}${f.annotate ? " · staff can draw on them" : ""}</span></div>${cap}`;
      }
      if (!f.fileId) {
        return live ? "" : `<div class="fe-img-empty">${svg(ICONS.image)}<span>Choose a picture in the settings panel</span></div>`;
      }
      // When filling in, a drawable picture is set up by form-annotate.js instead
      const hook = f.annotate && live
        ? `data-annot-img="${id}"`
        : `data-bank-img="${esc(f.fileId)}" data-alt="${esc(f.alt || "")}"`;
      const { pct, maxH } = imageSizing(f);
      return `<figure class="fe-img${maxH ? " has-max-h" : ""}${f.annotate ? " can-draw" : ""}">` +
        `<span class="fe-img-box" style="width:${pct}%;${maxH ? `--img-max-h:${maxH}px;` : ""}" ${hook}><span class="fe-img-loading">${svg(ICONS.image)}</span></span>` +
        (!live && f.annotate ? `<span class="fe-img-draw-tag">${svg(ICONS.signature)}${
          f.markMode === "marks" ? "Staff place unit marks on this" : "Staff can draw on this"}</span>` : "") +
        `${cap}</figure>` + imageQsHtml(f, live);
    }
    case "aftercare": {
      if (live) return head + '<div class="ac-host" data-ac-host><p class="fe-help">Loading aftercare…</p></div>';
      const map = ctx.aftercare;
      const titles = (f.items || []).map((id) => (map && map.get(id) ? map.get(id).title : map ? "Missing aftercare" : "Aftercare"));
      const list = titles.length
        ? `<div class="ac-list">${titles.map((t) => `<div class="ac-item is-demo"><div class="ac-head"><span class="ac-toggle"><span class="ac-title">${esc(t)}</span></span></div></div>`).join("")}</div>`
        : "";
      if (f.mode === "choose") {
        return head + `<div class="ac-builder">${svg(ICONS.aftercare)}<span>Staff choose aftercare while filling in${titles.length ? ", starting with these:" : "."}</span></div>${list}`;
      }
      return head + (list || `<div class="fe-img-empty">${svg(ICONS.aftercare)}<span>Choose aftercare in the settings panel</span></div>`);
    }
    case "consent_status":
    case "prescription_status": {
      const rx = f.type === "prescription_status";
      const icon = svg(ICONS[f.type]);
      if (live) return head + `<div class="fe-consent">${icon}Checked automatically when this form is filled in for a patient.</div>`;
      const list = (rx ? ctx.prescriptionForms : ctx.consentForms) || [];
      const form = list.find((c) => c.id === f.consentFormId);
      const months = Number(f.months) || (rx ? 6 : 12);
      return head + (form
        ? `<div class="fe-consent">${icon}Looks for ${rx ? "a" : "a signed"} “${esc(form.name)}” from the last ${months} months${
            f.block ? ", and stops the form being saved if there isn't one" : ""}.</div>`
        : `<div class="fe-consent is-warn">${icon}Choose which ${rx ? "prescription" : "consent"} form to check.</div>`);
    }
    case "clinician": {
      const pick = f.who === "choose";
      return head + `<div class="fe-patient fe-clin">${pick
        ? `<label class="is-wide"><small>Clinician</small><select class="fe-in" data-clin-pick${inert}><option value="">Choose a clinician</option></select></label>` : ""}${
        clinicianParts(f).map(([k, l]) =>
          `<label${k === "quals" ? ' class="is-wide"' : ""}><small>${l}</small><input class="fe-in" type="text" data-cpart="${k}" maxlength="150"${inert} /></label>`).join("")}</div>` +
        (live ? "" : `<div class="fe-help fe-help-after">${pick
          ? "Staff choose the clinician; it starts with whoever is filling it in."
          : "Filled in for whoever is filling in the form."} From their details in Staff; they can still change them.</div>`);
    }
    case "patient":
      return head + `<div class="fe-patient">${patientParts(f).map(([k, l]) =>
        `<label${k === "address" ? ' class="is-wide"' : ""}><small>${l}</small><input class="fe-in" type="text" data-part="${k}"${inert} /></label>`).join("")}</div>` +
        (live ? "" : '<div class="fe-help fe-help-after">Filled in from the patient\'s record.</div>');
    case "text_block": {
      const body = textBlockHtml(f);
      return `<div class="fe-block">${f.label ? `<div class="fe-block-h">${esc(f.label)}</div>` : ""}${
        body || (live ? "" : '<p class="fe-ph">Click to write the information patients need to read.</p>')}</div>`;
    }
    case "consumables": {
      if (live) return head + '<div class="cs-host" data-cs-host><p class="fe-help">Loading stock…</p></div>';
      const items = f.items || [];
      return head + (items.length
        ? `<div class="cs-build">${items.map((it) => `<div class="cs-build-row"><span>${esc(it.name || "Product")}${
            it.required ? '<span class="fe-req">*</span>' : ""}</span><small>${it.kind === "kit" ? "From the clinician's kit" : "From the Shelf"}${
            it.from ? ` · amount from ${esc(((ctx.fields || []).find((x) => x.id === it.from) || {}).label
              || ((ctx.fields || []).find((x) => x.id === it.from) || {}).fileName || "the form")}`
              : it.amount ? ` · ${esc(it.amount)} ${esc(it.unit)} by default` : ""}${it.max ? ` · up to ${esc(it.max)}` : ""}</small></div>`).join("")}</div>`
        : `<div class="fe-img-empty">${svg(ICONS.consumables)}<span>Choose products in the settings panel</span></div>`) +
        (f.allowExtra !== false ? '<div class="fe-help fe-help-after">Staff can add other products while filling in.</div>' : "");
    }
    case "specialist": {
      if (live) return head + '<div class="sp-host" data-sp-host><p class="fe-help">Loading specialists…</p></div>';
      const sample = { name: "Dr Jane Smith", speciality: f.speciality || "Dermatologist", practice: "Example Skin Specialists",
        address: "12 Example St, Perth WA 6000", phone: "08 9000 0000", email: "reception@example.com" };
      return head + `<div class="sp-build-pick">${svg(ICONS.specialist)}<span>Staff choose from the Specialist Bank${
        f.speciality ? ` (${esc(f.speciality)})` : ""}${f.allowAdd !== false ? ", or add a new one" : ""}. Example:</span></div>` +
        `<div class="sp-card is-sample">${specialistBlockHtml(f, sample)}</div>`;
    }
    case "letterhead":
      return letterheadHtml(ctx.letterhead);
    case "watermark": {
      if (live) return "";
      const hasLogo = !!(ctx.letterhead && ctx.letterhead.logo);
      const what = f.source === "logo"
        ? (hasLogo ? "The clinic logo" : "The clinic logo (add one to the letterhead first)")
        : `“${esc(f.text || "")}”`;
      return `<div class="fe-wm-marker">${svg(ICONS.watermark)}${what} sits faded behind the whole page</div>`;
    }
    case "space":
      return `<div class="fe-space is-${esc(f.size || "medium")}"></div>`;
    }
    
  return "";
}

/* ===================== Settings panel (type-specific part) ===================== */

const setting = (label, control, note = "") =>
  `<label class="fe-insp-field"><span class="fe-insp-label">${label}</span>${control}${
    note ? `<small class="fe-note">${note}</small>` : ""}</label>`;

const choose = (key, items, current, numeric = false, rerender = false) =>
  `<select class="fb-select" data-k="${key}"${numeric ? ' data-num=""' : ""}${rerender ? ' data-rerender=""' : ""}>${items.map(([v, l]) =>
    `<option value="${esc(v)}"${String(current) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

const placeholderSetting = (f, example) =>
  setting("Hint inside the box", `<input class="fe-input" data-k="placeholder" maxlength="100" placeholder="${esc(example)}" value="${esc(f.placeholder || "")}" />`,
    "Grey example text that disappears when staff start typing.");

const layoutSetting = (f) =>
  setting("Layout", choose("layout", [["list", "One per line"], ["columns", "Two columns"], ["inline", "Side by side"]], f.layout || "list"),
    "Side by side suits short choices like Yes / No.");

// details = false: only the "Other" setting (the checkbox variants already have notes / sub-options)
function extrasSettings(f, details = true) {
  const cmt = new Set(f.commentOn || []);
  const opts = (f.options || []).filter((o) => String(o).trim());
  return `<div class="fe-insp-field fe-extras"><span class="fe-insp-label">Extra answers</span>
    <label class="fe-check"><input type="checkbox" data-k="allowOther" data-rerender=""${f.allowOther ? " checked" : ""} />
      Add an “Other” choice where staff type their own answer</label>
    ${f.allowOther ? `<label class="fe-insp-sub"><small>Label for it</small>
      <input class="fe-input" data-k="otherLabel" maxlength="60" placeholder="Other" value="${esc(f.otherLabel || "Other")}" /></label>` : ""}
    ${details ? `
      <span class="fe-insp-sub"><small>Ask for details when one of these is chosen</small></span>
      <div class="fe-parts">${opts.map((o) => `<label class="fe-check"><input type="checkbox" data-cmton="${esc(o)}" data-rerender=""${
        cmt.has(o) ? " checked" : ""} /> ${esc(o)}</label>`).join("") || '<small class="fe-note">Add answer choices first.</small>'}</div>
      ${cmt.size ? `
        <label class="fe-insp-sub"><small>Hint in the details box</small>
          <input class="fe-input" data-k="commentHint" maxlength="100" placeholder="Please give details" value="${esc(f.commentHint || "")}" /></label>
        <label class="fe-check"><input type="checkbox" data-k="commentRequired"${f.commentRequired ? " checked" : ""} /> Details must be filled in</label>` : ""}` : ""}
  </div>`;
}

function typeSettings(f, ctx = {}) {
  switch (f.type) {
    case "patient": {
      const on = patientParts(f).map(([k]) => k);
      return `<div class="fe-insp-field"><span class="fe-insp-label">Details to show</span>
        <div class="fe-parts">${PATIENT_PARTS.map(([k, l]) =>
          `<label class="fe-check"><input type="checkbox" data-part="${k}" data-rerender=""${on.includes(k) ? " checked" : ""} /> ${esc(l)}</label>`).join("")}</div>
        <small class="fe-note">Filled in from the patient's record. At least one detail is always shown.</small></div>`;
    }

    case "clinician": {
      const on = clinicianParts(f).map(([k]) => k);
      return setting("Whose details", choose("who", [["me", "Whoever is filling in the form"], ["choose", "Staff choose a clinician"]], f.who || "me"),
          "Choose a clinician suits Reception completing a form for a doctor. It starts with whoever is filling it in.") +
        `<div class="fe-insp-field"><span class="fe-insp-label">Details to show</span>
          <div class="fe-parts">${CLINICIAN_PARTS.map(([k, l]) =>
            `<label class="fe-check"><input type="checkbox" data-clinpart="${k}" data-rerender=""${on.includes(k) ? " checked" : ""} /> ${esc(l)}</label>`).join("")}</div>
          <small class="fe-note">From each person's Registration in Staff. They can still change them on the form, for example a provider number for another location.</small></div>`;
    }

    case "short_text":
      return placeholderSetting(f, "e.g. Dr Smith");

    case "email":
      return placeholderSetting(f, "e.g. name@example.com");

    case "long_text":
      return placeholderSetting(f, "e.g. Describe any reactions") +
        setting("Box size", choose("size", [["small", "Small (2 lines)"], ["medium", "Medium (4 lines)"], ["large", "Large (8 lines)"]], f.size || "medium"));

    case "date":
      return setting("Allowed dates", choose("range", [["any", "Any date"], ["past", "Today or earlier"], ["future", "Today or later"]], f.range || "any"),
        "For example, today or earlier for a date of birth.");

    case "dropdown":
      return setting("Text before a choice is made", `<input class="fe-input" data-k="placeholder" maxlength="100" value="${esc(f.placeholder || "")}" />`) +
        extrasSettings(f);

    case "single_choice":
    case "checkboxes":
    case "checkbox_notes":
      return layoutSetting(f) + extrasSettings(f, EXTRA_TYPES.includes(f.type));
    case "signature":
      return setting("Who signs", choose("signer", Object.entries(SIGNERS), f.signer || "patient")) +
        `<label class="fe-check"><input type="checkbox" data-k="showNameDate"${f.showNameDate !== false ? " checked" : ""} /> Show name and date under the signature</label>` +
        '<small class="fe-note fe-pad">The name fills in for the patient or the practitioner. For a guardian or witness, staff type it in.</small>';

    case "image": {
      const staff = f.source === "staff";
      let h = setting("Where the image comes from", choose("source", [
        ["bank", "A set picture, the same on every form"],
        ["staff", "Photos staff add while filling in"],
      ], staff ? "staff" : "bank", false, true));
      const caption = setting("Caption", `<input class="fe-input" data-k="caption" maxlength="200" value="${esc(f.caption || "")}" />`,
        "Optional. Shown under the picture.");
      if (!staff) {
        h += `<div class="fe-insp-field"><span class="fe-insp-label">Picture</span>
          ${f.fileId ? `<div class="fe-img-pick"><span class="fe-img-thumb" data-bank-img="${esc(f.fileId)}"></span>
            <span class="fe-img-name" title="${esc(f.fileName || "")}">${esc(f.fileName || "Chosen picture")}</span></div>` : ""}
          <div class="fe-img-btns">
            <button type="button" class="lh-btn" data-act="img-pick">${f.fileId ? "Change" : "Choose from Image Bank"}</button>
            <label class="lh-btn">Upload from computer<input type="file" data-img-upload accept="image/png,image/jpeg,image/webp,image/gif" hidden /></label>
            ${f.fileId ? '<button type="button" class="lh-btn is-quiet" data-act="img-clear">Remove</button>' : ""}
          </div>
          <small class="fe-note">Uploads are saved into the Image Bank so you can reuse them.</small></div>` +
          setting("Size", choose("size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["full", "Full width"], ["custom", "Custom size"]],
            f.size || "medium", false, true)) +
          (f.size === "custom"
            ? setting("Width", `<div class="fe-num"><input class="fe-input" type="number" min="10" max="100" step="5" data-k="widthPct" data-num="" value="${Number(f.widthPct) || 50}" /><span>% of the page width</span></div>`)
            : "") +
          (f.annotate
            ? '<small class="fe-note fe-pad">The height follows the picture\'s shape when staff can draw on it, so the markings always line up.</small>'
            : setting("Maximum height", `<div class="fe-num"><input class="fe-input" type="number" min="40" max="1200" step="10" data-k="heightPx" data-num="optional" placeholder="Automatic" value="${f.heightPx ?? ""}" /><span>pixels</span></div>`,
                "Leave empty to keep the picture's natural shape. Pictures are never stretched.")) +
          setting("While filling in, staff can", `<select class="fb-select" data-imgmode="" data-rerender="">${[
            ["none", "Only look at it"], ["draw", "Draw on it"], ["marks", "Place unit marks on it (and draw)"],
          ].map(([v, l]) => `<option value="${v}"${imgMode(f) === v ? " selected" : ""}>${l}</option>`).join("")}</select>`,
            "For face charts and injection points. Markings are saved with the patient's form; the picture in the Image Bank never changes.") +
          (imgMode(f) === "marks" ? markSetSettings(f, ctx) : "") +
          imageQuestionsSettings(f) +
          caption +
          setting("Description", `<input class="fe-input" data-k="alt" maxlength="200" value="${esc(f.alt || "")}" />`,
            "Optional. Read aloud by screen readers; not shown on the form.");
      } else {
        const stack = f.photoLayout === "stack";
        h += setting("Photos allowed", choose("max", Array.from({ length: 10 }, (_, i) => [i + 1, String(i + 1)]), f.max || 1, true)) +
          setting("Layout", choose("photoLayout", [["grid", "Side by side"], ["stack", "One under another"]], stack ? "stack" : "grid", false, true)) +
          (stack
            ? setting("Size", choose("size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["full", "Full width"], ["custom", "Custom size"]],
                f.size || "medium", false, true)) +
              (f.size === "custom"
                ? setting("Width", `<div class="fe-num"><input class="fe-input" type="number" min="10" max="100" step="5" data-k="widthPct" data-num="" value="${Number(f.widthPct) || 50}" /><span>% of the page width</span></div>`)
                : "")
            : setting("Photos per row", choose("perRow", [[2, "2"], [3, "3"], [4, "4"]], f.perRow || 2, true))) +
          `<label class="fe-check"><input type="checkbox" data-k="annotate" data-rerender=""${f.annotate ? " checked" : ""} /> Staff can draw on the photos</label>` +
          caption +
          `<label class="fe-check"><input type="checkbox" data-k="allowBank"${f.allowBank !== false ? " checked" : ""} /> Allow choosing from the Image Bank</label>` +
          '<p class="fe-note fe-pad">On phones and tablets, Take photo opens the camera. Photos are stored privately with the patient\'s saved form; markings are saved on top, so the original photo is never changed.</p>';
      }
      return h;
    }

    case "text_block":
      return `<div class="fe-insp-field"><span class="fe-insp-label">Text</span><div data-role="tb-editor"></div>
        <small class="fe-note">Use the toolbar for headings, sizes, colours and lists.</small></div>`;

    case "space":
      return setting("Height", choose("size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]], f.size || "medium"));

    case "number":
      return placeholderSetting(f, "e.g. 20") +
        setting("Unit", `<input class="fe-input" data-k="unit" maxlength="20" placeholder="units" value="${esc(f.unit || "")}" />`,
          "Shown after the box, for example units or mL.") +
        `<div class="fe-two">${
          setting("Lowest allowed", `<input class="fe-input" type="number" data-k="min" data-num="optional" value="${f.min ?? ""}" />`)}${
          setting("Highest allowed", `<input class="fe-input" type="number" data-k="max" data-num="optional" value="${f.max ?? ""}" />`)}</div>`;

    case "record_date":
      return '<p class="fe-note fe-pad">Starts as today\'s date. Staff can change it to backdate a record, and it becomes the date on the saved record.</p>';

    case "sub_checks":
      return `<div class="fe-two">${
        setting("Groups per row", choose("subCols", [[1, "1"], [2, "2"], [3, "3"], [4, "4"]], f.subCols || 1, true))}${
        setting("Sub-options", choose("subLayout", [["list", "One per line"], ["inline", "Side by side"]], f.subLayout || "list"))}</div>` +
        `<small class="fe-note fe-pad">1 per row puts each option beside its sub-options. 2 or more shows each group as a card.</small>` +
        `<div class="fe-insp-field"><span class="fe-insp-label">Options and their sub-options</span>${
        f.groups.map((g, i) => `
          <div class="fe-grp">
            <div class="fe-grp-head">
              <input class="fe-input" data-grp="${i}" data-grpk="label" maxlength="200" value="${esc(g.label)}" aria-label="Option ${i + 1}" />
              <button type="button" class="hx-x" data-grpdel="${i}" aria-label="Remove option ${i + 1}">${svg(ICONS.x)}</button>
            </div>
            <textarea class="fe-input" data-grp="${i}" data-grpk="subs" rows="3" placeholder="One sub-option per line">${esc((g.subs || []).join("\n"))}</textarea>
            <label class="fe-check fe-grp-other"><input type="checkbox" data-grp="${i}" data-grpk="other"${g.other ? " checked" : ""} />
              Add “${esc(otherLabel(f))}” to these sub-options</label>
            <div data-subx="${i}">${subExtrasHtml(g, i)}</div>
            </div>`).join("")}
        <button type="button" class="hx-add" data-act="grpadd">+ Add an option</button>
        <small class="fe-note">Sub-options appear when their option is ticked.</small></div>` + extrasSettings(f, false);

    case "table": {
      const cols = tableCols(f);
      const rows = int(f.rows, 1, 30, 3);
      return `<div class="fe-insp-field"><span class="fe-insp-label">Columns</span>${cols.map((c, i) => `
          <div class="fe-tcol">
            <div class="fe-col">
              <input class="fe-input" data-col="${i}" data-colk="label" maxlength="100" value="${esc(c.label)}" aria-label="Column ${i + 1} name" />
              <select class="fb-select" data-col="${i}" data-colk="type" data-rerender="" aria-label="Column ${i + 1} type">
                ${TABLE_COL_TYPES.map(([v, l]) => `<option value="${v}"${c.type === v ? " selected" : ""}>${l}</option>`).join("")}
              </select>
              <button type="button" class="hx-x" data-coldel="${i}" aria-label="Remove column ${i + 1}">${svg(ICONS.x)}</button>
            </div>
            ${c.type === "number" ? `<input class="fe-input fe-col-sub" data-col="${i}" data-colk="unit" maxlength="20" placeholder="Unit (optional), e.g. units or mL" value="${esc(c.unit)}" />` : ""}
            ${c.type === "dropdown" ? `<textarea class="fe-input fe-col-sub" data-col="${i}" data-colk="options" rows="3" placeholder="One choice per line">${esc(c.options.join("\n"))}</textarea>` : ""}
          </div>`).join("")}
        ${cols.length < 12 ? '<button type="button" class="hx-add" data-act="coladd">+ Add a column</button>' : ""}
        <small class="fe-note">Number columns can be added up in a Calculation: their totals appear under “Insert a question”.</small></div>` +
        setting("Column headings", choose("headAlign", [["auto", "Automatic (numbers on the right)"], ["left", "Left"], ["center", "Centre"], ["right", "Right"]],
          TABLE_HEAD_ALIGNS.includes(f.headAlign) ? f.headAlign : "auto")) +
        setting(f.addRows ? "Starting rows" : "Rows", `<input class="fe-input" type="number" min="1" max="30" data-k="rows" data-num="" value="${rows}" />`) +
        `<label class="fe-check"><input type="checkbox" data-k="addRows" data-rerender=""${f.addRows ? " checked" : ""} /> Staff can add rows while filling in</label>` +
        (f.addRows ? setting("Most rows", `<input class="fe-input" type="number" min="${rows}" max="50" data-k="maxRows" data-num="" value="${tableMax(f)}" />`,
          "Staff can remove the rows they add. The starting rows always stay.") : "");
    }
    case "calculation": {
      const others = (ctx.fields || []).filter((x) => x.id !== f.id && calcSource(x));
      const colTotals = (ctx.fields || []).filter((x) => x.type === "table").flatMap((t) =>
        tableCols(t).filter((c) => c.type === "number").map((c) => ({
          tok: `{${t.id}.${c.id}}`, name: `${t.label || "Table"} · ${c.label || "Column"} (total)`,
        })));
      const ops = [["+", "+"], ["-", "−"], ["*", "×"], ["/", "÷"], ["(", "("], [")", ")"],
        ["ROUND(", "Round"], ["MIN(", "Lowest of"], ["MAX(", "Highest of"], [",", ","]];
      return `
        <div class="fe-insp-field"><span class="fe-insp-label">Formula</span>
          <textarea class="fe-input fe-formula" data-k="formula" rows="3" maxlength="500" spellcheck="false" placeholder="Tap a question below, then an operator">${esc(f.formula || "")}</textarea>
          <div class="fe-calc-status" data-role="calc-status">${calcStatusHtml(f, ctx.fields || [])}</div>
        </div>
        <div class="fe-insp-field"><span class="fe-insp-label">Insert a question</span>${
          others.length || colTotals.length
            ? `<div class="fe-chiprow">${others.map((x) =>
                `<button type="button" class="fe-ins is-field" data-calcins="{${esc(x.id)}}">${esc(x.type === "image"
                  ? `${x.label || x.fileName || "Picture"} (total)` : x.label || "Untitled")}</button>`).join("")}${
                colTotals.map((t) => `<button type="button" class="fe-ins is-field" data-calcins="${esc(t.tok)}">${esc(t.name)}</button>`).join("")}</div>`
            : '<small class="fe-note">Add a Number question, a table with a Number column, or a picture with unit marks, to use it here.</small>'}</div>
        <div class="fe-insp-field"><span class="fe-insp-label">Insert</span>
          <div class="fe-chiprow">${ops.map(([v, l]) => `<button type="button" class="fe-ins" data-calcins="${esc(v)}">${esc(l)}</button>`).join("")}</div>
        </div>
        <div class="fe-two">${
          setting("Decimal places", choose("decimals", [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [4, "4"]], f.decimals ?? 2, true))}${
          setting("If a value is missing", choose("blank", [["zero", "Count it as 0"], ["wait", "Show nothing"]], f.blank || "zero"))}</div>
        <div class="fe-two">${
          setting("Before the result", `<input class="fe-input" data-k="prefix" maxlength="10" placeholder="$" value="${esc(f.prefix || "")}" />`)}${
          setting("After the result", `<input class="fe-input" data-k="suffix" maxlength="20" placeholder=" units" value="${esc(f.suffix || "")}" />`)}</div>`;
    }
    case "specialist": {
      const on = specialistParts(f).map(([k]) => k);
      return setting("Speciality to list", `<input class="fe-input" data-k="speciality" maxlength="80" list="sp-spec-list" placeholder="Any speciality" value="${esc(f.speciality || "")}" />
          <datalist id="sp-spec-list">${(ctx.specialities || []).map((s) => `<option value="${esc(s)}"></option>`).join("")}</datalist>`,
          "Optional. Only these specialists are listed; staff can tick to see everyone.") +
        setting("Show as", choose("show", [["letter", "Address block (for letters)"], ["table", "Table"]], f.show || "letter")) +
        `<div class="fe-insp-field"><span class="fe-insp-label">Details to show</span>
          <div class="fe-parts">${SPECIALIST_PARTS.map(([k, l]) =>
            `<label class="fe-check"><input type="checkbox" data-sppart="${k}"${on.includes(k) ? " checked" : ""} /> ${esc(l)}</label>`).join("")}</div>
          <small class="fe-note">The name is always shown. Notes for staff are never printed.</small></div>` +
        `<label class="fe-check"><input type="checkbox" data-k="allowAdd"${f.allowAdd !== false ? " checked" : ""} /> Staff can add a new specialist while filling in</label>` +
        `<label class="fe-check"><input type="checkbox" data-k="allowEdit"${f.allowEdit !== false ? " checked" : ""} /> Staff can correct a specialist's details while filling in</label>` +
        '<p class="fe-note fe-pad">New and corrected specialists are saved to the Specialist Bank for everyone. A saved letter keeps the details it was saved with.</p>' +
        '<button type="button" class="lh-btn" data-act="sp-bank">Manage the Specialist Bank</button>';
    }
    case "watermark": {
      const logo = f.source === "logo";
      const hasLogo = !!(ctx.letterhead && ctx.letterhead.logo);
      return setting("Show", choose("source", [["text", "Text"], ["logo", "Clinic logo"]], f.source || "text", false, true)) +
        (logo
          ? (hasLogo ? "" : '<p class="fe-note fe-pad">There\'s no logo yet. Click the letterhead at the top of the page, then Edit letterhead and logo.</p>')
          : setting("Text", `<input class="fe-input" data-k="text" maxlength="40" value="${esc(f.text || "")}" />`)) +
        setting("Size", choose("size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]], f.size || "large")) +
        setting("Strength", `<input class="fe-range" type="range" min="5" max="40" step="1" data-k="opacity" data-num="" value="${Number(f.opacity) || 10}" />`) +
        setting("Angle", `<input class="fe-range" type="range" min="-60" max="60" step="5" data-k="angle" data-num="" value="${Number(f.angle) || 0}" />`);
    }

    case "letterhead":
      return '<p class="fe-note fe-pad">The letterhead now sits at the top of every form, so you can remove this. To change it, click the letterhead at the top of the page.</p>';

    case "consent_status":
    case "prescription_status": {
      const rx = f.type === "prescription_status";
      const forms = (rx ? ctx.prescriptionForms : ctx.consentForms) || [];
      const noun = rx ? "prescription" : "consent";
      return (forms.length
          ? setting(`${rx ? "Prescription" : "Consent"} form to look for`, choose("consentFormId",
              [["", `Choose a ${noun} form`], ...forms.map((c) => [c.id, c.name + (c.status === "live" ? "" : " (draft)")])],
              f.consentFormId || ""))
          : `<p class="fe-note fe-pad">Create a form in ${rx ? "Prescriptions" : "Consent forms"} first, then choose it here.</p>`) +
        setting("Valid for", `<div class="fe-num"><input class="fe-input" type="number" min="1" max="60" data-k="months" data-num="" value="${
          Number(f.months) || (rx ? 6 : 12)}" /><span>months</span></div>`) +
        `<label class="fe-check"><input type="checkbox" data-k="block"${f.block ? " checked" : ""} /> Stop the form being saved if there's no valid ${noun}</label>` +
        `<small class="fe-note fe-pad">If there isn't one, staff get a “Fill in ${noun} now” button that brings them back to this form afterwards.</small>`;
    }
     case "aftercare": {
      const map = ctx.aftercare;
      const items = (f.items || []).map((id) => ({
        id, title: map && map.get(id) ? map.get(id).title : map ? "Missing aftercare (removed from the list?)" : "Loading…",
      }));
      return setting("How it's chosen", choose("mode", [["fixed", "These aftercare instructions"], ["choose", "Staff choose while filling in"]], f.mode || "fixed", false, true)) +
        setting("Email template", `<select class="fb-select" data-k="emailTemplate">
          <option value="">Standard aftercare email</option>
          ${(ctx.emailTemplates || []).map((t) => `<option value="${esc(t.id)}"${f.emailTemplate === t.id ? " selected" : ""}>${esc(t.name)}${
            t.status === "live" ? "" : " (draft: publish it in Task Manager)"}</option>`).join("")}
        </select>`, "Used by the Email aftercare button. Make templates in Task Manager → Task types (To Patient) with the {Aftercare} blank.") +
        `<div class="fe-insp-field"><span class="fe-insp-label">${f.mode === "choose" ? "Start with (optional)" : "Aftercare"}</span>
          ${items.length ? `<ul class="ac-chosen">${items.map((it, i) => `<li><span>${esc(it.title)}</span>
            <button type="button" class="hx-x" data-acdel="${i}" aria-label="Remove ${esc(it.title)}">${svg(ICONS.x)}</button></li>`).join("")}</ul>`
            : '<small class="fe-note">None chosen yet.</small>'}
          <button type="button" class="lh-btn" data-act="ac-pick">Choose from Aftercare Bank</button>
        </div>` +
        setting("Discussed with the patient", choose("confirm", [
          ["each", "A tick for each aftercare"], ["all", "One tick for all the aftercare"], ["off", "No tick needed"],
        ], f.confirm || "each"), "Staff must tick it before the form can be saved. Shown on the saved form and PDF with their name and the date.") +
        `<label class="fe-check"><input type="checkbox" data-k="preselect"${f.preselect !== false ? " checked" : ""} /> Ticked to send and print by default</label>` +
        '<p class="fe-note fe-pad">Staff can expand each aftercare to read it, and untick any they don\'t want included in the emailed or printed form.</p>';
    }
    case "consumables": {
      const items = f.items || [];
      const linkable = (ctx.fields || []).filter((x) => isMarkImage(x) || ["calculation", "number"].includes(x.type));
      const linkName = (x) => (x.type === "image" ? `${x.label || x.fileName || "Picture"} (marks total)`
        : `${x.label || "Untitled"} (${x.type === "number" ? "number" : "calculation"})`);
      return `<div class="fe-insp-field"><span class="fe-insp-label">Products</span>
        ${items.length ? items.map((it, i) => `<div class="cs-set">
          <div class="cs-set-head"><strong>${esc(it.name)}</strong><small>${it.kind === "kit" ? "Kit · in " + esc(it.unit) : "Shelf · in " + esc(it.unit)}</small>
            <button type="button" class="hx-x" data-cidel="${i}" aria-label="Remove ${esc(it.name)}">${svg(ICONS.x)}</button></div>
          <label class="fe-insp-sub"><small>Amount comes from</small>
            <select class="fb-select" data-ci="${i}" data-cik="from">
              <option value="">Staff type it</option>
              ${linkable.map((x) => `<option value="${esc(x.id)}"${it.from === x.id ? " selected" : ""}>${esc(linkName(x))}</option>`).join("")}
            </select></label>
          <label class="fe-check"><input type="checkbox" data-ci="${i}" data-cik="required"${it.required ? " checked" : ""} /> Must be filled in</label>
          <div class="fe-two">
            <label class="fe-insp-sub"><small>Default amount</small><div class="fe-num"><input class="fe-input" type="number" min="0" step="any" data-ci="${i}" data-cik="amount" value="${it.amount ?? ""}" placeholder="None" /><span>${esc(it.unit)}</span></div></label>
            <label class="fe-insp-sub"><small>Most allowed</small><div class="fe-num"><input class="fe-input" type="number" min="0" step="any" data-ci="${i}" data-cik="max" value="${it.max ?? ""}" placeholder="No limit" /><span>${esc(it.unit)}</span></div></label>
          </div></div>`).join("") : '<small class="fe-note">None chosen yet.</small>'}
        <button type="button" class="lh-btn" data-act="cs-pick">Choose products</button></div>` +
        '<small class="fe-note fe-pad">Amount comes from: fills the product in from a face chart, Calculation or Number on this form. Use one in the same unit as the product (units for kit products, mL for fillers). Staff can still change it.</small>' +
        setting("If there isn't enough in stock", choose("ifShort", [
          ["flag", "Save, and flag it for the ordering team"], ["block", "Don't allow saving"],
        ], f.ifShort || "flag"), "Flagging is safest for clinical records: the treatment is always recorded.") +
        `<label class="fe-check"><input type="checkbox" data-k="allowExtra"${f.allowExtra !== false ? " checked" : ""} /> Staff can add other products while filling in</label>` +
        '<p class="fe-note fe-pad">Stock comes off when the form is saved: kit products (e.g. Xeomin) from the clinician\'s own kit in units, everything else from the Shelf (JT storage for Dr Teh). The batches are saved on the record.</p>';
    }
  }
  return "";
}

/* ===================== Pictures: unit marks and questions under the picture ===================== */

const imgMode = (f) => (!f.annotate ? "none" : f.markMode === "marks" ? "marks" : "draw");
// Answer types for questions under a picture ("choice" is the older name for "radio")
export const IQ_TYPES = [
  ["radio", "Choose one (round buttons)"],
  ["checks", "Choose any (tick boxes)"],
  ["dropdown", "Dropdown"],
  ["text", "Short answer"],
  ["long", "Comment box"],
];
export const iqType = (q) => (IQ_TYPES.some(([k]) => k === (q && q.type)) ? q.type : "radio");
export const iqHasOptions = (q) => ["radio", "checks", "dropdown"].includes(iqType(q));

function markSetSettings(f, ctx) {
  const sets = ctx.markSets;
  if (!sets) return '<small class="fe-note fe-pad">Loading marking sets…</small>';
  const ids = markSetIdsOf(f);
  const firstNum = ids.map((id) => sets.find((s) => s.id === id)).filter(Boolean).find((s) => s.type !== "label") || null;
  const sw = (s) => s.values.slice(0, 4).map((x) => valueSvg(s, x, 20)).join("");
  return `<div class="fe-insp-field"><span class="fe-insp-label">Marking sets</span>
      <div class="fe-ms-picks">${sets.length ? sets.map((s) => `
        <label class="fe-check"><input type="checkbox" data-msid="${esc(s.id)}" data-rerender=""${ids.includes(s.id) ? " checked" : ""} />
          <span class="fe-ms-sw">${sw(s)}</span><span>${esc(s.name)} <small class="muted">${s.type === "label" ? "labels" : "numbers"}${
            firstNum && firstNum.id === s.id ? " · total used in Calculations" : ""}</small></span></label>`).join("")
        : '<small class="fe-note">No marking sets yet. Make one with Manage marking sets.</small>'}</div>
      <small class="fe-note">Tick every set staff can use on this picture. Each set is placed on its own: staff choose a value from any set, then tap the picture.
        The first numbers set ticked is the total used by Calculations and Consumables.</small>
    </div>` +
    '<button type="button" class="lh-btn fe-ms-manage" data-act="ms-manage">Manage marking sets</button>' +
    (firstNum ? '<small class="fe-note fe-pad">To show the total in another place, add a Calculation question and choose this picture under “Insert a question”.</small>' : "");
}
function imageQuestionsSettings(f) {
  const qs = Array.isArray(f.questions) ? f.questions : [];
  return `<div class="fe-insp-field"><span class="fe-insp-label">Questions under the picture</span>
    ${qs.map((q, i) => `
      <div class="fe-grp">
        <div class="fe-grp-head">
          <input class="fe-input" data-iq="${i}" data-iqk="label" maxlength="200" placeholder="e.g. Treatment or touch-up?" value="${esc(q.label)}" aria-label="Question ${i + 1}" />
          <button type="button" class="hx-x" data-iqdel="${i}" aria-label="Remove question ${i + 1}">${svg(ICONS.x)}</button>
        </div>
        <div class="fe-two">
          <select class="fb-select" data-iq="${i}" data-iqk="type" data-rerender="" aria-label="Answer type">
            ${IQ_TYPES.map(([v, l]) => `<option value="${v}"${iqType(q) === v ? " selected" : ""}>${l}</option>`).join("")}
          </select>
          <label class="fe-check"><input type="checkbox" data-iq="${i}" data-iqk="required"${q.required ? " checked" : ""} /> Required</label>
        </div>
        ${iqHasOptions(q) ? `<textarea class="fe-input" data-iq="${i}" data-iqk="options" rows="2" placeholder="One choice per line">${esc((q.options || []).join("\n"))}</textarea>` : ""}
      </div>`).join("")}
    ${qs.length < 5 ? '<button type="button" class="hx-add" data-act="iqadd">+ Add a question</button>' : ""}
    <small class="fe-note">Shown right under the picture, for example Treatment or Touch-up, or a comment about the areas.</small></div>`;
}

export function imageQsHtml(f, live) {
  const qs = (Array.isArray(f.questions) ? f.questions : []).filter((q) => String(q.label || "").trim());
  if (!qs.length) return "";
  const inert = live ? "" : ' tabindex="-1"';
  return `<div class="fe-imgq">${qs.map((q) => {
    const t = iqType(q);
    const opts = Array.isArray(q.options) ? q.options : [];
    const name = `iq-${esc(f.id)}-${esc(q.id)}`;
    let ctrl;
    if (t === "text") ctrl = `<input class="fe-in" type="text" maxlength="300"${inert} />`;
    else if (t === "long") ctrl = `<textarea class="fe-in" rows="3" maxlength="1000"${inert}></textarea>`;
    else if (t === "dropdown") {
      ctrl = `<select class="fe-in"${inert}><option value="">Choose one</option>${
        opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>`;
    } else {
      ctrl = `<span class="fe-imgq-opts">${opts.map((o) =>
        `<label class="fe-opt"><input type="${t === "checks" ? "checkbox" : "radio"}" name="${name}" value="${esc(o)}"${inert} /><span>${esc(o)}</span></label>`).join("")}</span>`;
    }
    return `<div class="fe-imgq-row${t === "long" ? " is-long" : ""}" data-imgq="${esc(q.id)}">
      <span class="fe-imgq-l">${esc(q.label)}${q.required ? '<span class="fe-req" aria-label="required">*</span>' : ""}</span>${ctrl}</div>`;
  }).join("")}</div>`;
}

// [{ id, label, value, values? }] for the questions that have an answer ("values" only for Choose any)
export function readImageQs(f, w) {
  return (Array.isArray(f.questions) ? f.questions : []).map((q) => {
    const row = w && w.querySelector(`[data-imgq="${CSS.escape(q.id)}"]`);
    if (!row) return null;
    const t = iqType(q);
    let value = "";
    let values = null;
    if (t === "text" || t === "long") {
      const i = row.querySelector("input, textarea");
      value = i ? i.value.trim().slice(0, t === "long" ? 1000 : 300) : "";
    } else if (t === "dropdown") {
      const s = row.querySelector("select");
      value = s ? s.value : "";
    } else if (t === "checks") {
      values = [...row.querySelectorAll("input:checked")].map((x) => x.value);
      value = values.join(", ");
    } else {
      const r = row.querySelector("input:checked");
      value = r ? r.value : "";
    }
    return value ? { id: q.id, label: q.label, value, ...(values ? { values } : {}) } : null;
  }).filter(Boolean);
}

export function writeImageQs(f, w, list) {
  const m = new Map((Array.isArray(list) ? list : []).map((x) => [x.id, x]));
  (Array.isArray(f.questions) ? f.questions : []).forEach((q) => {
    const row = w && w.querySelector(`[data-imgq="${CSS.escape(q.id)}"]`);
    if (!row) return;
    const x = m.get(q.id);
    const v = x ? String(x.value || "") : "";
    const t = iqType(q);
    if (t === "text" || t === "long") { const i = row.querySelector("input, textarea"); if (i) i.value = v; }
    else if (t === "dropdown") { const s = row.querySelector("select"); if (s) s.value = v; }
    else if (t === "checks") {
      const on = new Set(x && Array.isArray(x.values) ? x.values : v ? v.split(", ") : []);
      row.querySelectorAll("input").forEach((r) => { r.checked = on.has(r.value); });
    } else row.querySelectorAll("input").forEach((r) => { r.checked = r.value === v; });
  });
}

export function fieldSettings(f, ctx = {}) {
  return typeSettings(f, ctx) + layoutSettings(f);
}

/* ===================== Layout ===================== */

// Draws the question and its answer according to the field's Layout settings
function layoutField(f, ctx, q, help) {
  const s = fieldStyle(f);
  const cls = `fe-lay al-${s.align} gap-${s.gap} sp-${s.space}${BOX_TYPES.includes(f.type) ? ` w-${s.width}` : ""}`;
  if (f.type === "text_block") {
    return `<div class="${cls} ts-${s.textSize}">${renderField(f, { ...ctx, raw: true })}</div>`;
  }
  const control = renderField(f, { ...ctx, raw: true, noHead: true });
  const label = s.hideLabel ? "" : q;
  if (s.pos === "beside") {
    return `<div class="${cls} is-beside qw-${s.qWidth}"><div class="fe-lay-q">${label}${help}</div>` +
      `<div class="fe-lay-a">${control}</div></div>`;
  }
  const top = label + help;
  return `<div class="${cls}">${top ? `<div class="fe-lay-q">${top}</div>` : ""}<div class="fe-lay-a">${control}</div></div>`;
}

function layoutSettings(f) {
  if (!ANSWER_TYPES.includes(f.type) && f.type !== "text_block") return "";
  const s = fieldStyle(f);
  const seg = (key, items, cur, rerender = false) =>
    `<div class="fe-seg" role="radiogroup">${items.map(([v, l]) =>
      `<label class="fe-seg-btn"><input type="radio" name="st-${key}-${esc(f.id)}" data-st="${key}" value="${v}"${
        cur === v ? " checked" : ""}${rerender ? ' data-rerender=""' : ""} /><span>${l}</span></label>`).join("")}</div>`;
  const row = (label, control) => `<div class="fe-lay-row"><span class="fe-lay-lbl">${label}</span>${control}</div>`;
  const isText = f.type === "text_block";
  const isImage = f.type === "image";

  return `<div class="fe-insp-field fe-layout">
    <span class="fe-insp-label">Layout</span>
    ${!isText && hasLabel(f.type)
      ? `<label class="fe-check"><input type="checkbox" data-st="showLabel"${s.hideLabel ? "" : " checked"} /> Show the question</label>` : ""}
    ${INLINE_TYPES.includes(f.type)
      ? row("Answer", seg("pos", [["below", "Under the question"], ["beside", "Beside the question"]], s.pos, true)) : ""}
    ${s.pos === "beside"
      ? row("Question width", seg("qWidth", [["auto", "Fit"], ["narrow", "Narrow"], ["medium", "Medium"], ["wide", "Wide"]], s.qWidth)) : ""}
    ${!isText ? row("Gap", seg("gap", [["tight", "Tight"], ["normal", "Normal"], ["wide", "Wide"]], s.gap)) : ""}
    ${row("Align", seg("align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]], s.align))}
    ${BOX_TYPES.includes(f.type)
      ? row("Answer box width", seg("width", [["full", "Full"], ["half", "Half"], ["third", "Third"]], s.width)) : ""}
    ${isText ? row("Text size", seg("textSize", [["small", "Small"], ["normal", "Normal"], ["large", "Large"]], s.textSize)) : ""}
    ${row("Space below", seg("space", [["normal", "Normal"], ["more", "More"], ["most", "Extra"]], s.space))}
    ${s.pos === "beside" && s.qWidth === "auto"
      ? '<small class="fe-note">Fit puts the answer straight after the question. Best for short questions.</small>' : ""}
  </div>`;
}

/* ===================== Pre-fill setting ===================== */

export function prefillSettings(f) {
  if (!PREFILL_TYPES.includes(f.type)) return "";
  const opts = (f.options || []).filter((o) => String(o).trim());
  if (f.type === "single_choice" || f.type === "dropdown") {
    return setting("Pre-fill", `<select class="fb-select" data-k="prefill" data-rerender="">${
      [["", "Nothing chosen"], ...opts.map((o) => [o, o])].map(([v, l]) =>
        `<option value="${esc(v)}"${(f.prefill || "") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`,
      `The answer that starts selected. ${PREFILL_NOTE}`);
  }
  if (f.type === "checkboxes" || f.type === "checkbox_notes") {
    const on = new Set(Array.isArray(f.prefill) ? f.prefill : []);
    return `<div class="fe-insp-field"><span class="fe-insp-label">Pre-fill</span>
      <div class="fe-parts">${opts.map((o) => `<label class="fe-check"><input type="checkbox" data-prefill="${esc(o)}" data-rerender=""${
        on.has(o) ? " checked" : ""} /> ${esc(o)}</label>`).join("") || '<small class="fe-note">Add answer choices first.</small>'}</div>
      <small class="fe-note">Ticked when the form opens. ${PREFILL_NOTE}</small></div>`;
  }
  if (f.type === "number") {
    return setting("Pre-fill", `<input class="fe-input" type="number" step="any" data-k="prefill" data-num="optional" placeholder="Empty" value="${numPrefill(f) ?? ""}" />`,
      `The number the box starts with. ${PREFILL_NOTE}`);
  }
  if (f.fill) return ""; // "Fill in automatically" is used instead
  const control = f.type === "long_text"
    ? `<textarea class="fe-input" data-k="prefill" rows="3" maxlength="2000" placeholder="Empty">${esc(f.prefill || "")}</textarea>`
    : `<input class="fe-input" data-k="prefill" maxlength="500" placeholder="Empty" value="${esc(f.prefill || "")}" />`;
  return setting("Pre-fill", control,
    `Text the box starts with. You can use {Patient name}, {First name}, {Last name}, {Date of birth}, {Patient ID}, {Today} and {My name}. ${PREFILL_NOTE}`);
}

/* ===================== Settings that edit lists inside a field ===================== */


// Typing in table columns, sub-option groups, patient detail ticks and layout buttons.
// Returns true if it changed something.
export function applyInput(f, el) {
  if (el.dataset.sppart !== undefined) {
    const on = new Set(specialistParts(f).map(([k]) => k));
    if (el.checked) on.add(el.dataset.sppart); else on.delete(el.dataset.sppart);
    f.parts = SP_KEYS.filter((k) => on.has(k));
    return true;
  }
  if (el.dataset.prefill !== undefined) {
    const s = new Set(Array.isArray(f.prefill) ? f.prefill : []);
    if (el.checked) s.add(el.dataset.prefill); else s.delete(el.dataset.prefill);
    f.prefill = (f.options || []).filter((o) => s.has(o));
    return true;
  }
  if (el.dataset.msid !== undefined) {
    const on = new Set(markSetIdsOf(f));
    if (el.checked) on.add(el.dataset.msid); else on.delete(el.dataset.msid);
    f.markSetIds = [...on].slice(0, 6);
    f.markSetId = f.markSetIds[0] || "";
    return true;
  }
  if (el.dataset.clinpart !== undefined) {
    const on = new Set(clinicianParts(f).map(([k]) => k));
    if (el.checked) on.add(el.dataset.clinpart);
    else if (on.size > 1) on.delete(el.dataset.clinpart); // always keep at least one
    f.parts = CLIN_KEYS.filter((k) => on.has(k));
    return true;
  }
  if (el.dataset.imgmode !== undefined) {
    f.annotate = el.value !== "none";
    f.markMode = el.value === "marks" ? "marks" : "draw";
    return true;
  }
  if (el.dataset.iq !== undefined) {
    const q = f.questions && f.questions[Number(el.dataset.iq)];
    if (!q) return false;
    const k = el.dataset.iqk;
    if (k === "required") q.required = el.checked;
    else if (k === "options") q.options = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    else q[k] = el.value;
    return true;
  }
  if (el.dataset.ci !== undefined) {
    const it = f.items && f.items[Number(el.dataset.ci)];
    if (!it) return false;
    if (el.dataset.cik === "from") { it.from = el.value; return true; }
    if (el.dataset.cik === "required") it.required = el.checked;
    else { const n = Number(el.value); it[el.dataset.cik] = el.value === "" || !(n > 0) ? null : n; }
    return true;
  }
  if (el.dataset.cmton !== undefined) {
    const s = new Set(f.commentOn || []);
    if (el.checked) s.add(el.dataset.cmton); else s.delete(el.dataset.cmton);
    f.commentOn = (f.options || []).filter((o) => s.has(o));
    return true;
  }
  if (el.dataset.st !== undefined) {
    const s = fieldStyle(f);
    if (el.dataset.st === "showLabel") s.hideLabel = !el.checked;
    else s[el.dataset.st] = el.value;
    f.style = s;
    delete f.inline; // replaced by style.pos
    return true;
  }
  if (el.dataset.part !== undefined) {
    const on = new Set(patientParts(f).map(([k]) => k));
    if (el.checked) on.add(el.dataset.part);
    else if (on.size > 1) on.delete(el.dataset.part); // always keep at least one
    f.parts = PART_KEYS.filter((k) => on.has(k));
    return true;
  }
  if (el.dataset.col !== undefined) {
    const c = f.columns && f.columns[Number(el.dataset.col)];
    if (!c) return false;
    const k = el.dataset.colk;
    if (k === "options") c.options = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    else c[k] = el.value;
    return true;
  }
  if (el.dataset.grp !== undefined) {
    const g = f.groups && f.groups[Number(el.dataset.grp)];
    if (!g) return false;
    if (el.dataset.sx !== undefined) {
      const x = subExtra(g, el.dataset.sx);
      const k = el.dataset.sxk;
      if (k === "box") x.box = SUB_BOX.includes(el.value) ? el.value : "off";
      else if (k === "hint" || k === "note") x[k] = el.value;
      else return false;
      setSubExtra(g, el.dataset.sx, x);
      return true;
    }
    if (el.dataset.grpk === "subs") g.subs = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    else if (el.dataset.grpk === "other") g.other = el.checked;
    else g.label = el.value;
    return true;
  }
  return false;
}



// Add / remove buttons for table columns and sub-option groups.
export function applyClick(f, target) {
  if (target.closest('[data-act="iqadd"]')) {
    f.questions = [...(Array.isArray(f.questions) ? f.questions : []), {
      id: `q${Date.now().toString(36).slice(-6)}`, label: "Treatment or touch-up?", type: "radio",
      options: ["Treatment", "Touch-up"], required: false,
    }];
    return true;
  }
  const iqd = target.closest("[data-iqdel]");
  if (iqd) {
    if (Array.isArray(f.questions)) f.questions.splice(Number(iqd.dataset.iqdel), 1);
    return true;
  }
  const cd = target.closest("[data-cidel]");
  if (cd) {
    if (Array.isArray(f.items)) f.items.splice(Number(cd.dataset.cidel), 1);
    return true;
  }
  const acd = target.closest("[data-acdel]");
  if (acd) {
    if (Array.isArray(f.items)) f.items.splice(Number(acd.dataset.acdel), 1);
    return true;
  }
  const btn = target.closest('[data-act="coladd"], [data-coldel], [data-act="grpadd"], [data-grpdel]');
  if (!btn) return false;
  if (btn.dataset.act === "coladd") {
    if (f.columns.length < 12) f.columns.push({ id: newColId(), label: `Column ${f.columns.length + 1}`, type: "text" });
    return true;
  }
  if (btn.dataset.coldel !== undefined) {
    if (f.columns.length > 1) f.columns.splice(Number(btn.dataset.coldel), 1);
    return true;
  }
  if (btn.dataset.act === "grpadd") {
    if (f.groups.length < 30) f.groups.push({ label: `Option ${String.fromCharCode(65 + (f.groups.length % 26))}`, subs: [] });
    return true;
  }
  if (btn.dataset.grpdel !== undefined) {
    if (f.groups.length > 1) f.groups.splice(Number(btn.dataset.grpdel), 1);
    return true;
  }
  return false;
}

/* ===================== Watermark behind the page ===================== */

export function watermarkHtml(fields, letterhead) {
  const wm = (fields || []).find((f) => f.type === "watermark");
  if (!wm) return "";
  const size = esc(wm.size || "large");
  const style = `opacity:${(Number(wm.opacity) || 10) / 100};transform:rotate(${Number(wm.angle) || 0}deg)`;
  let inner = "";
  if (wm.source === "logo") {
    if (letterhead && letterhead.logo) inner = `<img class="is-${size}" src="${esc(letterhead.logo)}" alt="" style="${style}" />`;
  } else if (String(wm.text || "").trim()) {
    inner = `<span class="is-${size}" style="${style}">${esc(wm.text)}</span>`;
  }
  return inner ? `<div class="fe-wm" aria-hidden="true">${inner}</div>` : "";
}

/* ===================== Form title ===================== */

// The title at the top of a form, following its Form settings.
// In the builder it's clickable (opens Form settings), and a hidden title shows a placeholder.
export function formTitleHtml(name, s = {}, { build = false, selected = false } = {}) {
  const align = ["left", "center", "right"].includes(s.titleAlign) ? s.titleAlign : "left";
  const size = ["small", "medium", "large"].includes(s.titleSize) ? s.titleSize : "medium";
  if (s.showTitle === false) {
    return build
      ? `<button type="button" class="fe-lh-off${selected ? " is-selected" : ""}" data-role="title">The form title is hidden. Click to change.</button>`
      : "";
  }
  return `<h3 class="fe-title is-${align} is-${size}${build ? " is-clickable" : ""}${build && selected ? " is-selected" : ""}"${
    build ? ' data-role="title" tabindex="0" role="button" aria-label="Form title. Open form settings"' : ""}>${esc(name)}</h3>`;
}

/* ===================== "Other" and details boxes on a live form ===================== */

const showBox = (el, on) => {
  if (!el) return;
  if (!on && !el.disabled) el.value = ""; // unticked: nothing stray gets saved
  el.hidden = !on;
};

// Shows a box only while its choice is picked
export function syncChoiceExtras(f, w) {
  if (!w || !OTHER_TYPES.includes(f.type)) return;
  if (f.type === "dropdown") {
    const v = (w.querySelector("select") || {}).value || "";
    showBox(w.querySelector("[data-other]"), !!f.allowOther && v === otherLabel(f));
    showBox(w.querySelector('[data-cmt="dd"]'), (f.commentOn || []).includes(v));
    return;
  }
  w.querySelectorAll(".fe-optx").forEach((row) => {
    const box = row.querySelector('input[type="radio"], input[type="checkbox"]');
    showBox(row.querySelector("[data-other], [data-cmt], [data-subother], [data-subcmt]"), !!(box && box.checked));
  });
  // Sub-options: when the option above them is unticked, their boxes close too
  if (f.type === "sub_checks") {
    w.querySelectorAll(".fe-sub").forEach((row) => {
      const main = row.querySelector(':scope > .fe-opt input[type="checkbox"]');
      if (main && !main.checked) row.querySelectorAll("[data-subcmt], [data-subother]").forEach((el) => showBox(el, false));
    });
  }
}

// { other: "typed answer", notes: { "Yes": "details" } }, or null
export function readExtras(f, w) {
  if (!hasExtras(f) || !w) return null;
  const list = choiceList(f);
  const out = { other: "", notes: {} };
  const o = w.querySelector("[data-other]");
  if (o && !o.hidden) out.other = o.value.trim().slice(0, 500);
  w.querySelectorAll("[data-cmt]").forEach((c) => {
    if (c.hidden || !c.value.trim()) return;
    const label = c.dataset.cmt === "dd" ? (w.querySelector("select") || {}).value : list[Number(c.dataset.cmt)];
    if (label) out.notes[label] = c.value.trim().slice(0, 1000);
  });
  return out.other || Object.keys(out.notes).length ? out : null;
}

export function writeExtras(f, w, x) {
  if (!hasExtras(f) || !w) return;
  const list = choiceList(f);
  const o = w.querySelector("[data-other]");
  if (o) o.value = (x && x.other) || "";
  w.querySelectorAll("[data-cmt]").forEach((c) => {
    const label = c.dataset.cmt === "dd" ? (w.querySelector("select") || {}).value : list[Number(c.dataset.cmt)];
    c.value = (x && x.notes && x.notes[label]) || "";
  });
  syncChoiceExtras(f, w);
}