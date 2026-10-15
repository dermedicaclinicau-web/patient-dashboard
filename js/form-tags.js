// Merge tags in question titles, help text, Text blocks and the form title: {Patient name}, {Specialist name}…
// Filled in live as the form is filled in, and frozen into the saved form (answers.__tags) for the saved copy and PDF.
import { esc } from "./form-fields.js";
import { formatDobLong } from "./utils.js";

export const FORM_TAGS = [
  ["{Patient name}", "The patient's full name"],
  ["{First name}", "The patient's first name"],
  ["{Last name}", "The patient's last name"],
  ["{Date of birth}", "The patient's date of birth"],
  ["{Patient ID}", "The patient's ID"],
  ["{Today}", "The date the form is filled in"],
  ["{Record date}", "The form's Record date"],
  ["{My name}", "The staff member filling it in"],
  ["{Specialist name}", "The specialist chosen on this form"],
  ["{Specialist speciality}", "Their speciality"],
  ["{Specialist practice}", "Their practice or clinic"],
  ["{Specialist address}", "Their address"],
  ["{Specialist phone}", "Their phone number"],
  ["{Specialist email}", "Their email address"],
];

// What Preview shows
export const SAMPLE_TAGS = {
  "patient name": "Jane Citizen", "first name": "Jane", "last name": "Citizen", "date of birth": "3 March 1985",
  "patient id": "PAT-1234567890123", "today": longDate(dayKey()), "record date": longDate(dayKey()), "my name": "Dr Teh",
  "specialist name": "Dr Sarah Lee", "specialist": "Dr Sarah Lee", "specialist speciality": "Dermatologist",
  "specialist practice": "Perth Skin Specialists", "specialist address": "12 Example St, Perth WA 6000",
  "specialist phone": "08 9000 0000", "specialist email": "reception@example.com",
};

const TAG_RE = /\{\s*([A-Za-z][A-Za-z ]*?)\s*\}/g;
const keyOf = (k) => k.toLowerCase().replace(/\s+/g, " ");
export const hasTags = (s) => /\{\s*[A-Za-z][A-Za-z ]*\}/.test(String(s || ""));

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function longDate(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "";
}

// The values for one form. today: "YYYY-MM-DD" (defaults to now)
export function tagValues({ patient = null, staff = null, specialist = null, recordDate = "", today = "" } = {}) {
  const p = patient || {};
  const name = String(p.name || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const s = specialist && typeof specialist === "object" ? specialist : {};
  return {
    "patient name": name,
    "first name": p.firstName || parts[0] || "",
    "last name": p.lastName || (parts.length > 1 ? parts[parts.length - 1] : ""),
    "date of birth": (p.dobKey && formatDobLong(p.dobKey)) || p.dob || "",
    "patient id": p.pttId || p.id || "",
    "today": longDate(today || dayKey()),
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

// Plain text. missing: what an empty tag becomes ("" by default; null keeps the tag as typed). Unknown tags are left alone.
export function fillTags(text, vals, missing = "") {
  return String(text ?? "").replace(TAG_RE, (m, k) => {
    const kk = keyOf(k);
    if (!(kk in vals)) return m;
    return vals[kk] ? vals[kk] : missing === null ? m : missing;
  });
}

// HTML (Text blocks): the values are escaped
export function fillTagsHtml(html, vals, missing = "") {
  return String(html ?? "").replace(TAG_RE, (m, k) => {
    const kk = keyOf(k);
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

// The builder's "Insert a tag" list
export function tagPickerHtml() {
  return `<details class="fe-insp-field fe-tagbox">
    <summary>Insert a tag <small class="muted">{Patient name}, {Specialist name}…</small></summary>
    <div class="fe-chiprow">${FORM_TAGS.map(([t, help]) =>
      `<button type="button" class="fe-ins" data-taginsert="${esc(t)}" title="${esc(help)}">${esc(t)}</button>`).join("")}</div>
    <small class="fe-note">Goes into the question or help text, whichever you were last typing in. Filled in on the form, the saved copy and the PDF.
      In a Text block, type the tag straight into the text. Specialist tags fill in once a specialist is chosen on the form.</small>
  </details>`;
}