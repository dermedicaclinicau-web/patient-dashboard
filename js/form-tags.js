// Merge tags: {Patient name}, {Today}, {Specialist name}… plus one for every answer on the form ({Date Received}).
// Filled in live as the form is filled in, and frozen into the saved form (answers.__tags) for the saved copy and PDF.
import { esc, fieldTagName, fieldTagKey, tagKeyOf } from "./form-fields.js";
import { formatDobLong, formatMobile } from "./utils.js";

// [tag, what it is, group]
export const FORM_TAGS = [
  ["{Patient name}", "The patient's full name", "patient"],
  ["{First name}", "The patient's first name", "patient"],
  ["{Last name}", "The patient's last name", "patient"],
  ["{Date of birth}", "The patient's date of birth", "patient"],
  ["{Patient age}", "The patient's age on the form's Record date", "patient"],
  ["{Patient address}", "The patient's address", "patient"],
  ["{Patient mobile}", "The patient's mobile number", "patient"],
  ["{Patient email}", "The patient's email address", "patient"],
  ["{Patient ID}", "The patient's ID", "patient"],
  ["{Medicare number}", "The patient's Medicare number", "patient"],
  ["{Medicare reference number}", "The patient's reference number on the Medicare card", "patient"],
  ["{Medicare expiry}", "When the patient's Medicare card expires", "patient"],
  ["{Today}", "The date the form is filled in", "visit"],
  ["{Record date}", "The form's Record date", "visit"],
  ["{My name}", "The staff member filling it in", "visit"],
  ["{Specialist name}", "The specialist chosen on this form", "specialist"],
  ["{Specialist speciality}", "Their speciality", "specialist"],
  ["{Specialist practice}", "Their practice or clinic", "specialist"],
  ["{Specialist address}", "Their address", "specialist"],
  ["{Specialist phone}", "Their phone number", "specialist"],
  ["{Specialist email}", "Their email address", "specialist"],
];
const GROUPS = [["patient", "Patient"], ["visit", "Visit and staff"], ["specialist", "Specialist chosen on this form"]];

// What Preview shows
export const SAMPLE_TAGS = {
  "patient name": "Jane Citizen", "first name": "Jane", "last name": "Citizen", "date of birth": "3 March 1985",
  "patient age": "41", "patient address": "1 Sample St, Perth WA 6000", "patient mobile": "0412 345 678",
  "patient email": "jane@example.com",
  "patient id": "PAT-1234567890123", "medicare number": "2123 45670 1", "medicare reference number": "1", "medicare expiry": "03/2028",
  "today": longDate(dayKey()), "record date": longDate(dayKey()), "my name": "Dr Teh",
  "specialist name": "Dr Sarah Lee", "specialist": "Dr Sarah Lee", "specialist speciality": "Dermatologist",
  "specialist practice": "Perth Skin Specialists", "specialist address": "12 Example St, Perth WA 6000",
  "specialist phone": "08 9000 0000", "specialist email": "reception@example.com",
};

const TAG_RE = /\{\s*([A-Za-z][A-Za-z0-9 /-]*?)\s*\}/g;
export const hasTags = (s) => /\{\s*[A-Za-z][A-Za-z0-9 /-]*\}/.test(String(s || ""));

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function longDate(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "";
}
// "2123456701" -> "2123 45670 1"
function medicareText(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 4)} ${d.slice(4, 9)} ${d.slice(9)}` : String(s || "");
}
// Age in whole years on a given day ("YYYY-MM-DD" both), or "" if either date is missing
export function ageOn(dobKey, onKey) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobKey || "");
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(onKey || "");
  if (!a || !b) return "";
  let y = +b[1] - +a[1];
  if (+b[2] < +a[2] || (+b[2] === +a[2] && +b[3] < +a[3])) y--;
  return y >= 0 && y < 130 ? String(y) : "";
}

// The values for one form. today: "YYYY-MM-DD" (defaults to now)
export function tagValues({ patient = null, staff = null, specialist = null, recordDate = "", today = "" } = {}) {
  const p = patient || {};
  const name = String(p.name || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const s = specialist && typeof specialist === "object" ? specialist : {};
  const day = today || dayKey();
  return {
    "patient name": name,
    "first name": p.firstName || parts[0] || "",
    "last name": p.lastName || (parts.length > 1 ? parts[parts.length - 1] : ""),
    "date of birth": (p.dobKey && formatDobLong(p.dobKey)) || p.dob || "",
    "patient age": ageOn(p.dobKey, recordDate || day),
    "patient address": String(p.address || "").trim(),
    "patient mobile": p.mobile ? formatMobile(p.mobile) : "",
    "patient email": String(p.email || "").trim(),
    "patient id": p.pttId || p.id || "",
    "medicare number": medicareText(p.medicareNo),
    "medicare reference number": String(p.medicareIrn || ""),
    "medicare expiry": /^\d{4}-\d{2}$/.test(p.medicareExp || "") ? `${p.medicareExp.slice(5)}/${p.medicareExp.slice(0, 4)}` : "",
    "today": longDate(day),
    "record date": longDate(recordDate),
    "my name": (staff && staff.name) || "",
    "specialist name": s.name || "",
    "specialist": s.name || "",
    "specialist speciality": s.speciality || "",
    "specialist practice": s.practice || "",
    "specialist address": s.address || "",
    "specialist phone": s.phone || "",
    "specialist email": s.email || "",
  };
}
// Built-in tags always win over an answer with the same name
export const BUILTIN_TAG_KEYS = Object.keys(tagValues({}));

// The answers that have a tag: [{ f, name, key }]. The first question with a name owns it.
export function formFieldTags(fields) {
  const seen = new Set(BUILTIN_TAG_KEYS);
  const out = [];
  (fields || []).forEach((f) => {
    const key = fieldTagKey(f);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ f, name: fieldTagName(f), key });
  });
  return out;
}

// Where a tag is used on a form
const TEXT_KEYS = ["label", "help", "text", "html", "prefill", "starter"];
export function tagRefRe(name, flags = "gi") {
  const src = String(name || "").trim().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\{\\s*${src}\\s*\\}`, flags);
}
export function tagUsedBy(fields, name, exceptId = "") {
  if (!name) return [];
  const re = tagRefRe(name, "i");
  return (fields || []).filter((f) => f.id !== exceptId && TEXT_KEYS.some((k) => typeof f[k] === "string" && re.test(f[k])));
}
// A question was renamed: everywhere that used its tag follows
export function renameTagRefs(fields, from, to) {
  const re = tagRefRe(from);
  (fields || []).forEach((f) => TEXT_KEYS.forEach((k) => {
    if (typeof f[k] === "string") f[k] = f[k].replace(re, `{${to}}`);
  }));
}

// Plain text. missing: what an empty tag becomes ("" by default; null keeps the tag as typed). Unknown tags are left alone.
export function fillTags(text, vals, missing = "") {
  return String(text ?? "").replace(TAG_RE, (m, k) => {
    const kk = tagKeyOf(k);
    if (!(kk in vals)) return m;
    return vals[kk] ? vals[kk] : missing === null ? m : missing;
  });
}

// HTML (Text blocks): the values are escaped
export function fillTagsHtml(html, vals, missing = "") {
  return String(html ?? "").replace(TAG_RE, (m, k) => {
    const kk = tagKeyOf(k);
    if (!(kk in vals)) return m;
    return vals[kk] ? esc(vals[kk]).replace(/\n/g, "<br>") : missing === null ? m : missing;
  });
}

// Text on a page that has tags in it, kept with its original wording so it can be filled again as answers change.
// Answer boxes and the add-on panels (specialist, aftercare, products) are left alone.
export function collectTagNodes(root) {
  const out = [];
  if (!root) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest("textarea, script, style, [data-sp-host], [data-ac-host], [data-cs-host], [data-ph-host], [data-rt-host]")) return NodeFilter.FILTER_REJECT;
      return hasTags(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) out.push({ node: walker.currentNode, tpl: walker.currentNode.nodeValue });
  return out;
}

export function applyTagNodes(list, vals, missing = "") {
  list.forEach(({ node, tpl }) => {
    const v = fillTags(tpl, vals, missing);
    if (node.nodeValue !== v) node.nodeValue = v;
  });
}

// The builder's "Insert a tag" list: this form's answers first, then the built-in tags
export function tagPickerHtml({ fields = [], current = null } = {}) {
  const pos = new Map(fields.map((f, i) => [f.id, i]));
  const here = current ? pos.get(current.id) : -1;
  const own = formFieldTags(fields).filter((t) => !current || t.f.id !== current.id);
  const chip = (tag, help, cls = "") =>
    `<button type="button" class="fe-ins${cls}" data-taginsert="${esc(tag)}" title="${esc(help)}">${esc(tag)}</button>`;
  const sec = (title, body) => `<div class="fe-tagsec"><span class="fe-tagsec-h">${esc(title)}</span>${body}</div>`;
  const answers = own.length
    ? `<div class="fe-chiprow">${own.map((t) => chip(`{${t.name}}`,
        `The answer to “${t.f.label || t.name}”${here >= 0 && pos.get(t.f.id) > here ? " (a later question: fills in once it's answered)" : ""}`,
        " is-field")).join("")}</div>`
    : '<small class="fe-note">Every question you add gets a tag here, named after the question.</small>';
  const hasSp = fields.some((f) => f.type === "specialist");
  return `<details class="fe-insp-field fe-tagbox">
    <summary>Insert a tag <small class="muted">answers, patient, dates…</small></summary>
    ${sec("Answers on this form", answers)}
    ${GROUPS.filter(([g]) => g !== "specialist" || hasSp).map(([g, title]) =>
      sec(title, `<div class="fe-chiprow">${FORM_TAGS.filter((t) => t[2] === g).map(([t, h]) => chip(t, h)).join("")}</div>`)).join("")}
    <small class="fe-note">Click in the question, help text, pre-fill or a text block, then click a tag. On the form it becomes the answer or detail,
      and it's kept on the saved copy and PDF.</small>
  </details>`;
}