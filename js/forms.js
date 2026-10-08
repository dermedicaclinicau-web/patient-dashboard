import { db, FORM_BUILDER_URL } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Built-ins mirror BUILTIN_CATEGORIES in the Form Builder's Code.gs.
// The key MUST match the stored formType string exactly.
export const BUILTIN_CATEGORIES = [
  { key: "Consent Form",        label: "Consent forms",     icon: "📋" },
  { key: "Treatment Record",    label: "Treatment records", icon: "🩺" },
  { key: "Prescription Record", label: "Prescriptions",     icon: "💊" },
  { key: "Printables",          label: "Printables",        icon: "🖨️" },
  { key: "Email Templates",     label: "Email templates",   icon: "✉️" }
];
const UNCATEGORISED = { key: "Uncategorised", label: "Uncategorised", icon: "📁" };

const TTL_MS = 5 * 60 * 1000;
let _forms = null, _formsAt = 0, _formsPending = null;
let _cats  = null, _catsAt  = 0;

// Several fields are stored as JSON strings by the Apps Script builder.
export function parseJsonField(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function normaliseForm(snap) {
  const d = snap.data() || {};
  const fields = parseJsonField(d.fields, []);
  return {
    id:              d.formId || snap.id,     // formId is the canonical key everywhere else
    docId:           snap.id,
    name:            d.name || d.title || "Untitled",
    title:           d.title || "",
    category:        d.formType || "Uncategorised",
    live:            d.status === "live",
    alsoPrintable:   d.alsoPrintable === true,
    layoutMode:      d.layoutMode === "canvas" ? "canvas" : "flow",
    pageCount:       Math.max(1, parseInt(d.pageCount, 10) || 1),
    fieldCount:      Array.isArray(fields)
                       ? fields.filter(f => f && !["paragraph", "spacer", "letterhead", "watermark"].includes(f.type)).length
                       : 0,
    linkedFormId:    d.linkedFormId || "",
    printablePdfUrl: d.printablePdfUrl || "",
    createdAt:       d.createdDate || "",
    updatedAt:       d.updatedAt || d.createdDate || ""
  };
}

// One read of the whole collection, cached. Concurrent callers share the same promise.
export async function fetchFormTemplates({ force = false } = {}) {
  if (!force && _forms && Date.now() - _formsAt < TTL_MS) return _forms;
  if (_formsPending) return _formsPending;

  _formsPending = (async () => {
    const snap = await getDocs(collection(db, "forms"));
    const seen = new Set();
    const out = [];
    snap.forEach(s => {
      const f = normaliseForm(s);
      // fsSet's fallback path can leave two docs with the same formId; keep the newest
      if (seen.has(f.id)) {
        const i = out.findIndex(x => x.id === f.id);
        if (i > -1 && f.updatedAt > out[i].updatedAt) out[i] = f;
        return;
      }
      seen.add(f.id);
      out.push(f);
    });
    out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    _forms = out;
    _formsAt = Date.now();
    return out;
  })();

  try { return await _formsPending; }
  finally { _formsPending = null; }
}

export async function fetchFormCategories({ force = false } = {}) {
  if (!force && _cats && Date.now() - _catsAt < TTL_MS) return _cats;
  let custom = [];
  try {
    const snap = await getDocs(collection(db, "form_categories"));
    snap.forEach(s => {
      const d = s.data() || {};
      if (d.name) custom.push({ key: d.name, label: d.name, icon: d.icon || "📂", custom: true });
    });
    custom.sort((a, b) => a.label.localeCompare(b.label));
  } catch (e) {
    console.warn("form_categories unreadable — showing built-ins only", e);
  }
  _cats = [...BUILTIN_CATEGORIES, ...custom, UNCATEGORISED];
  _catsAt = Date.now();
  return _cats;
}

export function clearFormCache() { _forms = null; _cats = null; }

// Generic link to a published form. Patient prefill is deliberately NOT done
// via URL params — that is the next step, done server-side from the patient ID.
export function liveFormUrl(formId) {
  return `${FORM_BUILDER_URL}?view=form&id=${encodeURIComponent(formId)}`;
}

export function builderUrl() { return FORM_BUILDER_URL; }