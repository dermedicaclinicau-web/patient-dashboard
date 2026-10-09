import { runCalc, calcRefs, formatCalc } from "./form-calc.js";
import { letterheadHtml } from "./form-letterhead.js";
import { cleanCondition } from "./form-conditions.js";
import { cleanRichHtml, richText } from "./rich-html.js";

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
  text_block: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  letterhead: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="7" y1="6" x2="11" y2="6"/>',
  watermark: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  space: '<line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

// `was` = the name in the old Apps Script builder (tooltip + search).
export const FIELD_TYPES = {
  patient:        { name: "Patient details", was: "Patient Details", label: "Patient details" },
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
  text_block:     { name: "Text block", was: "Paragraph", label: "Information" },
  letterhead:     { name: "Letterhead", was: "Letterhead", label: "" },
  watermark:      { name: "Watermark", was: "Watermark", label: "" },
  space:          { name: "Space", was: "Space", label: "" },
};

export const FIELD_GROUPS = [
  ["Patient and visit", ["patient", "record_date", "date"]],
  ["Answers", ["short_text", "long_text", "number", "email"]],
  ["Choices", ["single_choice", "dropdown", "checkboxes", "checkbox_notes", "sub_checks"]],
  ["Clinical", ["signature", "consent_status", "image", "aftercare"]],
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
const LAYOUT_TYPES = ["single_choice", "checkboxes", "checkbox_notes"];
const PLACEHOLDER_TYPES = ["short_text", "long_text", "email", "number", "dropdown"];
export const INLINE_TYPES = ["short_text", "email", "number", "date", "record_date", "dropdown", "single_choice", "checkboxes", "calculation"];
// Fields that get the Layout settings
const ANSWER_TYPES = ["patient", "short_text", "long_text", "email", "number", "date", "record_date", "single_choice",
  "checkboxes", "checkbox_notes", "sub_checks", "dropdown", "table", "calculation", "signature", "image", "consent_status"];
const BOX_TYPES = ["short_text", "email", "number", "date", "record_date", "dropdown"];
const DRIVE_ID = /^[A-Za-z0-9_-]{10,80}$/;
const opt = (v, list, dflt) => (list.includes(v) ? v : dflt);
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
};
export const FILLS_FOR = {
  short_text: ["", "patient.name", "patient.firstName", "patient.lastName", "patient.email", "patient.mobile", "patient.address", "staff.name"],
  long_text: ["", "patient.address"],
  email: ["", "patient.email"],
  date: ["", "today", "patient.dob"],
};

const NO_LABEL = ["space", "letterhead", "watermark"];
const NO_HELP = ["patient", "text_block", "space", "letterhead", "watermark"];
const NO_REQUIRED = ["text_block", "space", "letterhead", "watermark", "calculation", "consent_status", "image", "aftercare"];
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
    case "table": f.columns = [{ label: "Column 1", type: "text" }, { label: "Column 2", type: "text" }]; f.rows = 3; break;
    case "calculation": f.formula = ""; f.decimals = 2; f.prefix = ""; f.suffix = ""; f.blank = "zero"; break;
    case "image":
      f.source = "bank"; f.fileId = ""; f.fileName = ""; f.size = "medium"; f.caption = ""; f.alt = ""; f.max = 1;
      f.annotate = false; f.widthPct = 50; f.heightPx = null; f.allowBank = true;
      f.photoLayout = "grid"; f.perRow = 2;
      break;
    case "watermark": f.source = "text"; f.text = "DRAFT"; f.opacity = 10; f.angle = -30; f.size = "large"; break;
    case "letterhead": f.line1 = LETTERHEAD[0]; f.line2 = LETTERHEAD[1]; break;
    case "consent_status": f.consentFormId = ""; f.months = 12; f.block = false; break;
    case "aftercare": f.mode = "fixed"; f.items = []; f.preselect = true; f.emailTemplate = ""; break;
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
  if (out.type === "patient" && !(Array.isArray(out.parts) && out.parts.length)) out.parts = [...DEFAULT_PARTS];
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
      out.groups = (Array.isArray(f.groups) ? f.groups : []).slice(0, 30).map((g) => ({
        label: clip(g && g.label, 200),
        subs: (Array.isArray(g && g.subs) ? g.subs : []).map((s) => clip(s, 200)).slice(0, 30),
        other: !!(g && g.other === true),
      }));
      out.subCols = int(f.subCols, 1, 4, 1);
      out.subLayout = pick(f.subLayout, ["list", "inline"], "list");
      break;
    case "table":
      out.columns = (Array.isArray(f.columns) ? f.columns : []).slice(0, 12).map((c) => ({
        label: clip(c && c.label, 100),
        type: pick(c && c.type, ["text", "check"], "text"),
      }));
      out.rows = int(f.rows, 1, 30, 3);
      break;
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
      out.consentFormId = clip(f.consentFormId, 40);
      out.months = int(f.months, 1, 60, 12);
      out.block = f.block === true;
      break;
    case "aftercare":
      out.mode = pick(f.mode, ["fixed", "choose"], "fixed");
      out.items = (Array.isArray(f.items) ? f.items : [])
        .map(String).filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 20);
      out.preselect = f.preselect !== false;
      out.emailTemplate = /^[A-Za-z0-9]{10,40}$/.test(f.emailTemplate || "") ? f.emailTemplate : "";
      break;
}
  const sw = cleanCondition(f);
  if (sw) out.showWhen = sw;
  return out;
}

/* ===================== Calculations: checking ===================== */

export function prettyFormula(src, byId) {
  return String(src || "")
    .replace(/\{([^}]*)\}/g, (_, id) => {
      const f = byId.get(id.trim());
      return f ? `[${f.label || "Untitled"}]` : "[removed question]";
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
    const r = byId.get(id);
    if (!r) return { ok: false, error: "The formula uses a question that has been removed." };
    if (!["number", "calculation"].includes(r.type)) {
      return { ok: false, error: `“${r.label || "Untitled"}” isn't a number question.` };
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
    case "short_text": return head + `<input class="fe-in" type="text"${ph}${inert} />`;
    case "email": return head + `<input class="fe-in" type="email" autocomplete="off"${ph}${inert} />`;
    case "long_text": {
      const rows = { small: 2, medium: 4, large: 8 }[f.size] || 4;
      return head + `<textarea class="fe-in" rows="${rows}"${ph}${inert}></textarea>`;
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
        f.max !== null && f.max !== undefined ? ` max="${Number(f.max)}"` : ""}${inert} />${
        f.unit ? `<span>${esc(f.unit)}</span>` : ""}</div>`;
    case "dropdown": {
      const list = choiceList(f);
      const cmt = (f.commentOn || []).filter((o) => list.includes(o));
      return head + `<select class="fe-in"${inert}><option value="">${esc(f.placeholder || "Choose one")}</option>${
        list.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>` +
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
        const box = `<label class="fe-opt"><input type="${t}" name="${id}"${inert} /><span>${esc(o)}</span>${
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
          <label class="fe-opt">${box("checkbox")}<span>${esc(o)}</span></label>
          <input class="fe-in fe-note-in" type="text" placeholder="${isOther ? "Please specify" : "Add a note"}"${inert} />
        </div>`;
      }).join("")}</div>`;
    }
    case "sub_checks":
      return head + `<div class="fe-opts fe-subgrid cols-${int(f.subCols, 1, 4, 1)} sub-${f.subLayout === "inline" ? "inline" : "list"}">${(f.groups || []).map((g) => `
        <div class="fe-sub">
          <label class="fe-opt">${box("checkbox")}<span>${esc(g.label)}</span></label>
          ${(g.subs && g.subs.length) || g.other ? `<div class="fe-sub-opts">${(g.subs || []).map((s) =>
            `<label class="fe-opt">${box("checkbox")}<span>${esc(s)}</span></label>`).join("")}${g.other ? `
            <span class="fe-optx"><label class="fe-opt">${box("checkbox")}<span>${esc(otherLabel(f))}</span></label>
              <input class="fe-in fe-xin" type="text" data-subother maxlength="300" placeholder="Please specify"${live ? " hidden" : ""}${inert} /></span>` : ""}</div>` : ""}
        </div>`).join("")}${f.allowOther ? `
        <div class="fe-sub is-other"><span class="fe-optx">
          <label class="fe-opt">${box("checkbox")}<span>${esc(otherLabel(f))}</span></label>
          <input class="fe-in fe-xin" type="text" data-other maxlength="500" placeholder="Please specify"${live ? " hidden" : ""}${inert} />
        </span></div>` : ""}</div>`;
    case "table": {
      const cols = f.columns && f.columns.length ? f.columns : [{ label: "Column 1", type: "text" }];
      const rows = Math.max(1, Math.min(30, parseInt(f.rows, 10) || 3));
      let body = "";
      for (let r = 0; r < rows; r++) {
        body += `<tr>${cols.map((c) => c.type === "check"
          ? `<td class="is-check">${box("checkbox")}</td>`
          : `<td>${box("text")}</td>`).join("")}</tr>`;
      }
      return head + `<div class="fe-table-wrap"><table class="fe-table"><thead><tr>${
        cols.map((c, i) => `<th>${esc(c.label || `Column ${i + 1}`)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
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
        (!live && f.annotate ? `<span class="fe-img-draw-tag">${svg(ICONS.signature)}Staff can draw on this</span>` : "") +
        `${cap}</figure>`;
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
    case "consent_status": {
      if (live) return head + `<div class="fe-consent">${svg(ICONS.consent_status)}Checked automatically when this form is filled in for a patient.</div>`;
      const form = (ctx.consentForms || []).find((c) => c.id === f.consentFormId);
      return head + (form
        ? `<div class="fe-consent">${svg(ICONS.consent_status)}Looks for a signed “${esc(form.name)}” from the last ${Number(f.months) || 12} months${
            f.block ? ", and stops the form being saved if there isn't one" : ""}.</div>`
        : `<div class="fe-consent is-warn">${svg(ICONS.consent_status)}Choose which consent form to check.</div>`);
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
          `<label class="fe-check"><input type="checkbox" data-k="annotate" data-rerender=""${f.annotate ? " checked" : ""} /> Staff can draw on it while filling in</label>` +
          '<small class="fe-note fe-pad">For face charts and injection points. The markings are saved with the patient\'s form; the picture in the Image Bank never changes.</small>' +
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
            </div>`).join("")}
        <button type="button" class="hx-add" data-act="grpadd">+ Add an option</button>
        <small class="fe-note">Sub-options appear when their option is ticked.</small></div>` + extrasSettings(f, false);

    case "table":
      return `<div class="fe-insp-field"><span class="fe-insp-label">Columns</span>${
        f.columns.map((c, i) => `
          <div class="fe-col">
            <input class="fe-input" data-col="${i}" data-colk="label" maxlength="100" value="${esc(c.label)}" aria-label="Column ${i + 1} name" />
            <select class="fb-select" data-col="${i}" data-colk="type" aria-label="Column ${i + 1} type">
              <option value="text"${c.type !== "check" ? " selected" : ""}>Text</option>
              <option value="check"${c.type === "check" ? " selected" : ""}>Tick box</option>
            </select>
            <button type="button" class="hx-x" data-coldel="${i}" aria-label="Remove column ${i + 1}">${svg(ICONS.x)}</button>
          </div>`).join("")}
        ${f.columns.length < 12 ? '<button type="button" class="hx-add" data-act="coladd">+ Add a column</button>' : ""}</div>` +
        setting("Rows", `<input class="fe-input" type="number" min="1" max="30" data-k="rows" data-num="" value="${Number(f.rows) || 3}" />`);

    case "calculation": {
      const others = (ctx.fields || []).filter((x) => x.id !== f.id && ["number", "calculation"].includes(x.type));
      const ops = [["+", "+"], ["-", "−"], ["*", "×"], ["/", "÷"], ["(", "("], [")", ")"],
        ["ROUND(", "Round"], ["MIN(", "Lowest of"], ["MAX(", "Highest of"], [",", ","]];
      return `
        <div class="fe-insp-field"><span class="fe-insp-label">Formula</span>
          <textarea class="fe-input fe-formula" data-k="formula" rows="3" maxlength="500" spellcheck="false" placeholder="Tap a question below, then an operator">${esc(f.formula || "")}</textarea>
          <div class="fe-calc-status" data-role="calc-status">${calcStatusHtml(f, ctx.fields || [])}</div>
        </div>
        <div class="fe-insp-field"><span class="fe-insp-label">Insert a question</span>${
          others.length
            ? `<div class="fe-chiprow">${others.map((x) =>
                `<button type="button" class="fe-ins is-field" data-calcins="{${esc(x.id)}}">${esc(x.label || "Untitled")}</button>`).join("")}</div>`
            : '<small class="fe-note">Add a Number question to use it here.</small>'}</div>
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

    case "consent_status": {
      const forms = ctx.consentForms || [];
      return (forms.length
          ? setting("Consent form to look for", choose("consentFormId",
              [["", "Choose a consent form"], ...forms.map((c) => [c.id, c.name + (c.status === "live" ? "" : " (draft)")])],
              f.consentFormId || ""))
          : '<p class="fe-note fe-pad">Create a form in Consent forms first, then choose it here.</p>') +
        setting("Valid for", `<div class="fe-num"><input class="fe-input" type="number" min="1" max="60" data-k="months" data-num="" value="${Number(f.months) || 12}" /><span>months</span></div>`) +
        `<label class="fe-check"><input type="checkbox" data-k="block"${f.block ? " checked" : ""} /> Stop the form being saved if there's no valid consent</label>`;
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
        `<label class="fe-check"><input type="checkbox" data-k="preselect"${f.preselect !== false ? " checked" : ""} /> Ticked to send and print by default</label>` +
        '<p class="fe-note fe-pad">Staff can expand each aftercare to read it, and untick any they don\'t want included in the emailed or printed form.</p>';
    }
  }
  return "";
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

/* ===================== Settings that edit lists inside a field ===================== */

// Typing in table columns, sub-option groups, patient detail ticks and layout buttons.
// Returns true if it changed something.
export function applyInput(f, el) {
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
    c[el.dataset.colk] = el.value;
    return true;
  }
  if (el.dataset.grp !== undefined) {
    const g = f.groups && f.groups[Number(el.dataset.grp)];
    if (!g) return false;
    if (el.dataset.grpk === "subs") g.subs = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    else if (el.dataset.grpk === "other") g.other = el.checked;
    else g.label = el.value;
    return true;
  }
  return false;
}

// Add / remove buttons for table columns and sub-option groups.
export function applyClick(f, target) {
  const acd = target.closest("[data-acdel]");
  if (acd) {
    if (Array.isArray(f.items)) f.items.splice(Number(acd.dataset.acdel), 1);
    return true;
  }
  const btn = target.closest('[data-act="coladd"], [data-coldel], [data-act="grpadd"], [data-grpdel]');
  if (!btn) return false;
  if (btn.dataset.act === "coladd") {
    if (f.columns.length < 12) f.columns.push({ label: `Column ${f.columns.length + 1}`, type: "text" });
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
    showBox(row.querySelector("[data-other], [data-cmt], [data-subother]"), !!(box && box.checked));
  });
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