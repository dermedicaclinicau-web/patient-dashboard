// Paste consultation notes (from Heidi, or written anywhere) → saved exactly like a recording's notes.
// Left: the pasted text. Right: the sections it goes into, editable. Split is instant and keeps the wording;
// "Write SOAP with AI" uses the Recorder's note-writer (Apps Script action "pasteNotes"). Nothing saves until a Save button.
// A date at the top of the notes becomes the consultation date (a backdated record), unless staff set the date themselves.
import { SECTIONS, parseSoap, assembleSoap } from "./soap.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { escapeHtml, showToast, toDateKey, getInitials, hueFromString } from "./utils.js";
import { listStaffDetails } from "./staff-details.js";
import { myUid } from "./inventory-api.js";

const MAX_CHARS = 200000;

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  steth: svg('<path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/>'),
  users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  brain: svg('<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04Z"/>'),
  pill: svg('<path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>'),
  heart: svg('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
  clipboard: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
  alert: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  mail: svg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  note: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
  paste: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>'),
  split: svg('<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/>'),
  sparkle: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  undo: svg('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>'),
  chev: svg('<polyline points="6 9 12 15 18 9"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
};

/* ===================== Finding the headings ===================== */

// Heidi's headings (any template) → the portal's sections. Matched ignoring capitals and punctuation.
const ALIASES = {
  clinical: ["clinical notes", "subjective", "history", "history of presenting complaint", "history of presenting illness", "hpi",
    "presenting complaint", "chief complaint", "reason for visit", "reason for consultation", "consultation notes", "consult notes",
    "notes", "objective", "examination", "exam", "on examination", "findings", "assessment", "impression", "clinical impression",
    "skin assessment", "skin analysis", "skin type", "concerns", "patient concerns", "discussion", "summary", "consultation summary",
    "treatment performed", "treatment today", "procedure", "procedure notes"],
  social: ["social history", "social", "lifestyle", "occupation", "family and social history"],
  personality: ["personality", "rapport", "patient preferences", "preferences"],
  medication: ["medication", "medications", "current medications", "meds", "current meds", "supplements"],
  conditions: ["medical history", "past medical history", "pmh", "medical conditions", "medical condition", "conditions",
    "relevant medical history", "past history", "comorbidities"],
  allergies: ["allergies", "allergy", "adverse reactions", "drug allergies"],
  plan: ["plan", "treatment plan", "treatment", "treatments", "management", "management plan", "recommendations",
    "recommended treatments", "treatment recommendations", "assessment and plan", "a and p", "a p", "treatment options",
    "options discussed", "quote", "quotes"],
  email: ["treatment information to email", "treatment info to email", "patient education", "information provided", "handouts",
    "information to send"],
  booking: ["book next appointment", "next appointment", "follow up", "followup", "review", "next steps", "next visit"],
};
const norm = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const ALIAS = new Map();
Object.entries(ALIASES).forEach(([k, list]) => list.forEach((a) => ALIAS.set(norm(a), k)));
SECTIONS.forEach((s) => { ALIAS.set(norm(s.title), s.key); s.aliases.forEach((a) => ALIAS.set(norm(a), s.key)); });
const keyFor = (name) => ALIAS.get(norm(name)) || "";
const SEC = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

const BULLET_RE = /^\s*(?:[-•*‣◦–]|\d+[.)])\s+/;

// { heading, key, rest } if the line is a heading, otherwise null.
// Known headings: plain, "Heading:", "**Heading**", "## Heading", "HEADING", or "Medications: Nil" on one line.
// Unknown headings only when clearly marked (markdown, bold or capitals), so "Discussed options:" stays in its section.
function headingInfo(line) {
  const raw = line.trim();
  if (!raw || raw.length > 100) return null;
  const inline = /^(?:#{1,6}\s*|!!\s*)?(?:\*\*|__)?([A-Za-z][A-Za-z0-9 &/()'’-]{1,48}?)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(\S.*)$/.exec(raw);
  if (inline) {
    const key = keyFor(inline[1]);
    if (key) return { heading: inline[1].trim(), key, rest: inline[2].replace(/^(\*\*|__)/, "").replace(/\*\*|__/g, "").trim() };
  }
  const name = raw.replace(/^#{1,6}\s*/, "").replace(/^!!\s*/, "").replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*|__/g, "").replace(/\s*[:–—-]\s*$/, "").trim();
  if (!name || name.length > 60 || /[.?!,;]$/.test(name)) return null;
  const words = name.split(/\s+/).length;
  const key = keyFor(name);
  if (BULLET_RE.test(raw) && !key) return null;
  if (key && words <= 7) return { heading: name, key, rest: "" };
  const marked = /^#{1,6}\s/.test(raw) || /^!!/.test(raw) || /^(\*\*|__)[^*_]+(\*\*|__):?$/.test(raw);
  const caps = name === name.toUpperCase() && /[A-Z]{3}/.test(name);
  if ((marked || caps) && words <= 6 && !/\d{3,}/.test(name)) return { heading: name, key: "extra", rest: "" };
  return null;
}

/* ===================== The record date at the top of the notes ===================== */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, "0");
// Dates that aren't the consultation (date of birth, expiry, next visit…) are never used
const NOT_VISIT_DATE_RE = /\b(dob|d\.o\.b|date of birth|birth|born|expir\w*|exp|next|review|follow|due|valid|until|booked for)\b/i;
const DATE_LABEL_RE = /^(?:(?:consultation|consult|session|record|visit|appointment|appt|treatment|clinic)\s+)?(?:date(?:\s+of\s+(?:consultation|visit|service|treatment))?|dated|on)\s*[:\-–]?\s*/i;
const monthOf = (w) => MONTHS[String(w || "").slice(0, 3).toLowerCase()] || 0;

// "14:30" from "2:30 pm", "2.30pm", "10am" or "14:30" (or "")
function timeIn(s) {
  let x = /\b(\d{1,2})[:.](\d{2})\s*([ap])\.?\s*m\.?(?![a-z])/i.exec(s);
  if (x && +x[1] >= 1 && +x[1] <= 12 && +x[2] < 60) return `${pad2((+x[1] % 12) + (/p/i.test(x[3]) ? 12 : 0))}:${x[2]}`;
  x = /\b(\d{1,2})\s*([ap])\.?\s*m\.?(?![a-z])/i.exec(s);
  if (x && +x[1] >= 1 && +x[1] <= 12) return `${pad2((+x[1] % 12) + (/p/i.test(x[2]) ? 12 : 0))}:00`;
  x = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s);
  return x ? `${pad2(+x[1])}:${x[2]}` : "";
}

// { dateKey, time } for a real date in the text, from 2000 to today (Australian day first), or null
function dateIn(s) {
  let y = 0, m = 0, d = 0, x;
  if ((x = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(s))) { d = +x[1]; m = +x[2]; y = +x[3]; if (y < 100) y += 2000; }
  else if ((x = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(s)) && monthOf(x[2])) { d = +x[1]; m = monthOf(x[2]); y = +x[3]; }
  else if ((x = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s)) && monthOf(x[1])) { m = monthOf(x[1]); d = +x[2]; y = +x[3]; }
  else return null;
  const dt = new Date(y, m - 1, d);
  if (y < 2000 || dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  const dateKey = `${y}-${pad2(m)}-${pad2(d)}`;
  if (dateKey > toDateKey()) return null;
  return { dateKey, time: timeIn(s.slice(x.index + x[0].length)) || timeIn(s) };
}

const plainLine = (l) => String(l || "").replace(/\*\*|__/g, "").replace(/^#{1,6}\s*/, "").trim();

// The first visit date in the first 8 lines of the notes
function findNoteDate(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(plainLine).filter(Boolean).slice(0, 8);
  for (const line of lines) {
    if (NOT_VISIT_DATE_RE.test(line)) continue;
    const found = dateIn(line);
    if (found) return found;
  }
  return null;
}

// A line that's only a date ("Date: 03/11/2026", "Tuesday 3 November 2026, 10:30 am")
function isDateOnlyLine(line) {
  const s = plainLine(line);
  if (!s || NOT_VISIT_DATE_RE.test(s) || !dateIn(s)) return false;
  const left = s.replace(DATE_LABEL_RE, "")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, " ")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi, " ")
    .replace(/\b\d{1,2}[:.]\d{2}\b|\b(?:at|of|am|pm|a\.m|p\.m)\b|\b\d{1,4}(?:st|nd|rd|th)?\b/gi, " ")
    .replace(/[^a-z]/gi, "");
  return left.length <= 2;
}

const longDate = (key) => (/^\d{4}-\d{2}-\d{2}$/.test(key || "")
  ? new Date(`${key}T12:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
  : "");

/* ===================== Splitting ===================== */

const tidyLine = (l) => l.replace(/\u00a0/g, " ").replace(/\*\*|__/g, "").replace(/^(\s*)[•‣◦]\s*/, "$1- ").replace(/\s+$/, "");

function splitText(text, nid) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  let cur = { heading: "", key: "clinical", lines: [] };
  let found = 0;
  let seen = 0;
  const push = () => {
    const t = cur.lines.map(tidyLine).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (t) out.push({ id: nid(), heading: cur.heading, key: cur.key, text: t, orig: t, open: false });
  };
  lines.forEach((line) => {
    if (line.trim()) seen++;
    if (seen <= 8 && isDateOnlyLine(line)) return;   // the date is saved as the record date
    const h = headingInfo(line);
    if (h) { push(); found++; cur = { heading: h.heading, key: h.key, lines: h.rest ? [h.rest] : [] }; return; }
    cur.lines.push(line);
  });
  push();
  return { blocks: out, found };
}

// Speaker-labelled lines and no headings: a transcript, not notes
function looksLikeTranscript(text, found) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4 || found > 1) return false;
  const re = /^(speaker\s*\d+|doctor|dr\.?\s*\w*|clinician|nurse|practitioner|patient|pt|client|staff|[A-Z][a-z]{1,15})\s*[:\-–]\s+\S/;
  return lines.filter((l) => re.test(l)).length / lines.length > 0.35;
}

const headingText = (h) => (String(h || "").toUpperCase().replace(/[^A-Z0-9 &/()'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "OTHER NOTES");
const snippet = (t, n = 140) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 2)}…` : s; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.max(ta.scrollHeight, 60)}px`;
}

/* ===================== The overlay ===================== */

export function openPasteNotes({ patient, staff, onSaved } = {}) {
  if (!patient) return;
  const st = {
    text: "", mode: "split", blocks: [], found: 0, transcript: false,
    sidecar: "", aiOrig: null, notes: [],
    busy: false, token: 0, saving: false, rightEdited: false, leftChanged: false,
    autoDate: null,       // { prevDate, prevTime, dateKey, time } while the date came from the notes
    dateTouched: false,   // staff changed the date or time themselves: the notes never override it
  };
  let seq = 0;
  const nid = () => `b${++seq}`;
  let splitTimer = 0;
  let busyTimer = 0;

  const dlg = document.createElement("dialog");
  dlg.className = "pn";
  dlg.innerHTML = shellHtml(patient, staff);
  document.body.appendChild(dlg);
  const $ = (s) => dlg.querySelector(s);
  const src = $(".pn-src");
  const drop = $(".pn-drop");
  const dateEl = $('[data-f="date"]');
  const timeEl = $('[data-f="time"]');
  const R = (name) => $(`[data-r="${name}"]`);

  /* ---------- The record date ---------- */

  function applyNoteDate() {
    if (st.dateTouched) return;
    const found = findNoteDate(st.text);
    if (found) {
      if (!st.autoDate) st.autoDate = { prevDate: dateEl.value, prevTime: timeEl.value };
      const changed = st.autoDate.dateKey !== found.dateKey;
      dateEl.value = found.dateKey;
      timeEl.value = found.time || st.autoDate.prevTime;
      Object.assign(st.autoDate, found);
      if (changed && found.dateKey < toDateKey()) {
        showToast(`The notes are dated ${longDate(found.dateKey)}, so that's the consultation date now.`);
      }
    } else if (st.autoDate) {
      dateEl.value = st.autoDate.prevDate;
      timeEl.value = st.autoDate.prevTime;
      st.autoDate = null;
    }
    renderDateNote();
  }

  function renderDateNote() {
    const a = st.autoDate;
    const back = !!a && dateEl.value < toDateKey();
    dateEl.classList.toggle("is-auto", !!a && !back);
    dateEl.classList.toggle("is-back", back);
    timeEl.classList.toggle("is-auto", !!(a && a.time));
    const note = R("datenote");
    note.hidden = !a;
    note.className = `pn-auto${back ? " is-back" : ""}`;
    note.innerHTML = !a ? "" : back
      ? `Backdated · from the notes · <button type="button" data-a="undo-date">Use today</button>`
      : "From the notes";
  }

  function undoNoteDate() {
    if (st.autoDate) { dateEl.value = st.autoDate.prevDate; timeEl.value = st.autoDate.prevTime; }
    st.autoDate = null;
    st.dateTouched = true;
    renderDateNote();
    renderFoot();
  }

  /* ---------- Rendering ---------- */

  const live = () => st.blocks.filter((b) => b.key !== "skip" && b.text.trim());

  function render() { renderLeft(); renderRight(); renderFoot(); }

  function renderLeft() {
    const words = (st.text.match(/\S+/g) || []).length;
    R("stats").innerHTML = st.text.trim()
      ? `<span>${plural(words, "word")}</span><span>${plural(st.found, "heading")} found</span>${
          st.transcript ? '<span class="is-warn">Looks like a transcript</span>' : ""}`
      : "<span>You can also drop a .txt file onto the box.</span>";
    const suggest = st.mode === "split" && st.transcript && !st.busy;
    R("modes").innerHTML = `
      <button type="button" class="pn-mode${st.mode === "split" ? " is-on" : ""}" data-a="split">
        ${ICONS.split}<strong>Split into sections</strong><small>Instant. Keeps the wording exactly.</small></button>
      <button type="button" class="pn-mode is-ai${st.mode === "ai" ? " is-on" : ""}${suggest ? " is-suggest" : ""}" data-a="ai"${st.busy ? " disabled" : ""}>
        ${ICONS.sparkle}<strong>${st.mode === "ai" && !st.busy ? "Write it again with AI" : "Write SOAP with AI"}</strong>
        <small>For a transcript or rough notes. About half a minute.</small></button>`;
    drop.classList.toggle("has-text", !!st.text.trim());
  }

  function renderRight() {
    const n = new Set(live().map((b) => b.key)).size;
    R("badge").textContent = st.busy ? "Writing…" : n ? `${plural(n, "section")} found` : "";
    R("chips").innerHTML = st.busy || !st.text.trim() ? "" : SECTIONS.map((s) => {
      const on = live().some((b) => b.key === s.key);
      return `<button type="button" class="pn-chip pn-tone-${s.tone}${on ? " is-on" : ""}" data-chip="${s.key}"
        title="${on ? "Show this section" : "Add this section"}">${on ? "<i></i>" : ICONS.plus}${escapeHtml(s.title.replace(/\s*\(In-Clinic\)/, ""))}</button>`;
    }).join("");
    R("hint").innerHTML = hintFor();

    const cards = R("cards");
    if (st.busy) cards.innerHTML = busyHtml();
    else if (!st.text.trim()) cards.innerHTML = emptyHtml();
    else {
      cards.innerHTML = st.blocks.map((b, i) => cardHtml(b, i)).join("") + notesHtml();
      cards.querySelectorAll(".pn-card.is-open textarea.pn-ta").forEach(autosize);
    }
    updateExpandBtn();
  }

  function updateExpandBtn() {
    const btn = R("expand");
    const shown = st.blocks.filter((b) => b.key !== "skip");
    btn.hidden = st.busy || !st.text.trim() || !shown.length;
    btn.textContent = shown.length && shown.every((b) => b.open) ? "Collapse all" : "Expand all";
  }

  function renderFoot() {
    const n = new Set(live().map((b) => b.key)).size;
    const d = dateEl.value;
    const when = d && d !== toDateKey() ? ` · for ${longDate(d)}` : "";
    R("state").innerHTML = st.saving ? "Saving…" : st.busy ? "Waiting for the AI…"
      : n ? `${ICONS.check}<span>${plural(n, "section")} ready to save${st.mode === "ai" ? " · written by AI" : ""}${escapeHtml(when)}</span>`
      : "Paste the notes to start";
    dlg.querySelectorAll('[data-a="draft"], [data-a="reviewed"]').forEach((b) => { b.disabled = !n || st.busy || st.saving; });
  }

  function hintFor() {
    if (st.busy || !st.text.trim()) return "";
    if (st.mode === "ai" && st.leftChanged) {
      return hintHtml("You changed the pasted text after the AI wrote these notes.", [["ai", "Write again"], ["split", "Split it instead"]]);
    }
    if (st.mode === "split" && st.leftChanged) {
      return hintHtml("The pasted text changed after you edited the sections.", [["resplit", "Split again"]],
        "Your edits on the right will be replaced.");
    }
    if (st.mode === "split" && st.transcript) {
      return hintHtml("This looks like a conversation, not written notes.", [["ai", "Write SOAP with AI"]],
        "AI turns a transcript into the clinic's SOAP format, with a structured treatment plan.");
    }
    if (st.mode === "split" && !st.found && st.text.trim().length > 200) {
      return hintHtml("No headings were found, so everything went into Clinical notes.", [["ai", "Write SOAP with AI instead"]],
        "Or move it with the drop-down on the card.");
    }
    return "";
  }

  function hintHtml(title, actions, sub = "") {
    return `<div class="pn-hint">${ICONS.info}<div class="pn-hint-text"><strong>${escapeHtml(title)}</strong>${
      sub ? `<span>${escapeHtml(sub)}</span>` : ""}</div><div class="pn-hint-acts">${actions.map(([a, l], i) =>
      `<button type="button" class="pn-btn sm${i === 0 ? " is-primary" : ""}" data-a="${a}">${escapeHtml(l)}</button>`).join("")}</div></div>`;
  }

  function selectHtml(b) {
    const opts = SECTIONS.map((s) => `<option value="${s.key}"${b.key === s.key ? " selected" : ""}>${escapeHtml(s.title)}</option>`).join("");
    const own = b.heading ? `Its own heading: ${b.heading}` : "Its own heading";
    return `<select class="pn-sel" data-sel="${b.id}" aria-label="Which section this goes into">${opts}
      <optgroup label="Other"><option value="extra"${b.key === "extra" ? " selected" : ""}>${escapeHtml(own)}</option>
      <option value="skip">Leave it out</option></optgroup></select>`;
  }

  const peekHtml = (b) => (b.text.trim()
    ? `${escapeHtml(snippet(b.text))} <span>· ${plural((b.text.match(/\S+/g) || []).length, "word")}</span>`
    : "<span>Empty. Open it to type.</span>");

  function cardHtml(b, i) {
    if (b.key === "skip") {
      return `<article class="pn-card is-skip" data-id="${b.id}" style="--i:${i}">
        <span class="pn-skip-label">Left out${b.heading ? `: “${escapeHtml(b.heading)}”` : ""}</span>
        <em>${escapeHtml(snippet(b.text, 90))}</em>
        <button type="button" class="pn-link" data-undo="${b.id}">${ICONS.undo}<span>Put it back</span></button></article>`;
    }
    const s = SEC[b.key];
    const from = b.key !== "extra" && b.heading && s && norm(b.heading) !== norm(s.title)
      && !s.aliases.some((a) => norm(a) === norm(b.heading));
    return `<article class="pn-card pn-tone-${s ? s.tone : "gray"}${b.open ? " is-open" : ""}" data-id="${b.id}" style="--i:${i}">
      <header class="pn-card-head" data-toggle="${b.id}">
        <span class="pn-ic">${ICONS[s ? s.icon : "note"]}</span>
        <span class="pn-sel-wrap">${selectHtml(b)}${ICONS.chev}</span>
        ${from ? `<span class="pn-from" title="The heading in the pasted notes">from “${escapeHtml(b.heading)}”</span>` : ""}
        <button type="button" class="pn-icbtn" data-drop="${b.id}" title="Leave this part out" aria-label="Leave this part out">${ICONS.x}</button>
        <button type="button" class="pn-fold" data-toggle="${b.id}" aria-expanded="${b.open}" aria-label="Open or close this section">${ICONS.chev}</button>
      </header>
      <p class="pn-peek" data-toggle="${b.id}">${peekHtml(b)}</p>
      <textarea class="pn-ta" data-t="${b.id}" placeholder="Nothing here yet. Type here, or leave it empty.">${escapeHtml(b.text)}</textarea>
    </article>`;
  }

  // Opens or closes one card without redrawing the others
  function toggleCard(id, open) {
    const b = st.blocks.find((x) => x.id === id);
    if (!b) return;
    b.open = open === undefined ? !b.open : open;
    const card = dlg.querySelector(`.pn-card[data-id="${id}"]`);
    if (card) {
      card.classList.toggle("is-open", b.open);
      const fold = card.querySelector(".pn-fold");
      if (fold) fold.setAttribute("aria-expanded", String(b.open));
      const peek = card.querySelector(".pn-peek");
      if (peek) peek.innerHTML = peekHtml(b);
      const ta = card.querySelector("textarea");
      if (ta && b.open) autosize(ta);
    }
    updateExpandBtn();
  }

  function notesHtml() {
    if (!st.notes.length) return "";
    return `<section class="pn-pnotes">
      <header>${ICONS.note}<strong>Suggested personal notes</strong><small>Ticked ones are offered on the notes page to save.</small></header>
      ${st.notes.map((n, i) => `<label class="pn-pnote"><input type="checkbox" data-note="${i}"${n.on ? " checked" : ""} /><span>${escapeHtml(n.text)}</span></label>`).join("")}
    </section>`;
  }

  const emptyHtml = () => `<div class="pn-empty">
      <div class="pn-empty-art">${ICONS.paste}</div>
      <strong>Paste the notes on the left</strong>
      <p>They're sorted into the clinic's sections here as you paste. Check each part, move anything that landed in the wrong place, then save.</p>
    </div>`;

  const busyHtml = () => `<div class="pn-busy">
      <div class="pn-orb">${ICONS.sparkle}</div>
      <strong>Writing the notes…</strong>
      <span class="pn-secs" data-r="secs">0 s</span>
      <p>Usually 20 to 40 seconds. You can check the date and clinician above while you wait.</p>
      <button type="button" class="pn-btn sm is-ghost" data-a="cancel-ai">Use the split instead</button>
      <div class="pn-skel"><i></i><i></i><i></i></div>
    </div>`;

  /* ---------- Splitting and AI ---------- */

  function resplit(force) {
    applyNoteDate();
    if (!force && st.rightEdited) { st.leftChanged = true; renderRight(); renderFoot(); return; }
    const r = splitText(st.text, nid);
    Object.assign(st, {
      blocks: r.blocks, found: r.found, transcript: looksLikeTranscript(st.text, r.found),
      rightEdited: false, leftChanged: false, sidecar: "", aiOrig: null, notes: [],
    });
    render();
  }

  function setText(t) {
    src.value = String(t || "").slice(0, MAX_CHARS);
    st.text = src.value;
    st.mode = "split";
    resplit(true);
  }

  async function writeWithAI() {
    if (st.text.trim().length < 40) { showToast("Paste the notes or transcript first."); src.focus(); return; }
    if (st.rightEdited && !(await confirmDialog({
      title: "Replace your edits?",
      message: "The AI writes the notes again from the pasted text, so the changes you made on the right will be replaced.",
      confirmLabel: "Write with AI", tone: "warning",
    }))) return;
    const token = ++st.token;
    st.busy = true;
    st.mode = "ai";
    render();
    const t0 = Date.now();
    clearInterval(busyTimer);
    busyTimer = setInterval(() => { const el = R("secs"); if (el) el.textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
    try {
      const res = await callApi({ action: "pasteNotes", op: "generate", text: st.text, date: field("date"), time: field("time") });
      if (token !== st.token || !dlg.open) return;
      if (res.problem) { showToast(res.problem); st.mode = "split"; st.busy = false; resplit(true); return; }
      const parsed = parseSoap(res.soap);
      const blocks = SECTIONS.filter((s) => String(parsed.sections[s.key] || "").trim())
        .map((s) => ({ id: nid(), heading: s.title, key: s.key, text: parsed.sections[s.key], orig: parsed.sections[s.key], open: false }))
        .concat(parsed.extras.filter((x) => x.text.trim())
          .map((x) => ({ id: nid(), heading: x.heading, key: "extra", text: x.text, orig: x.text, open: false })));
      Object.assign(st, {
        blocks, sidecar: parsed.sidecar, rightEdited: false, leftChanged: false, transcript: false,
        aiOrig: { plan: String(parsed.sections.plan || "").trim(), email: String(parsed.sections.email || "").trim() },
        notes: (res.personalNotes || []).map((text) => ({ text, on: true })),
      });
      showToast("Notes written. Check them, then save.");
    } catch (err) {
      if (token !== st.token) return;
      console.error("Write with AI failed:", err);
      showToast(apiMessage(err, "Couldn't write the notes. Try again, or use Split into sections."));
      st.mode = "split";
      st.busy = false;
      resplit(true);
      return;
    } finally {
      if (token === st.token) { clearInterval(busyTimer); st.busy = false; render(); }
    }
  }

  /* ---------- Saving ---------- */

  function buildSoap() {
    const blocks = live();
    const values = {};
    SECTIONS.forEach((s) => {
      const list = blocks.filter((b) => b.key === s.key);
      values[s.key] = list.map((b) => {
        const label = list.length > 1 && b.heading && norm(b.heading) !== norm(s.title) && norm(b.heading) !== norm(s.heading);
        return label ? `${b.heading}:\n${b.text.trim()}` : b.text.trim();
      }).join("\n\n");
    });
    const extras = blocks.filter((b) => b.key === "extra").map((b) => ({ heading: headingText(b.heading), text: b.text.trim() }));
    // The AI's structured plan copy is kept only while its plan and email text are unchanged
    const keep = st.mode === "ai" && st.sidecar && st.aiOrig
      && values.plan.trim() === st.aiOrig.plan && values.email.trim() === st.aiOrig.email;
    return assembleSoap({ preamble: "", headings: {} }, values, extras, { keepSidecar: false, sidecar: keep ? st.sidecar : "" });
  }

  async function save(status, force = false) {
    if (st.saving || st.busy) return;
    const soap = buildSoap();
    if (!soap) { showToast("There's nothing to save yet."); return; }
    if (!field("date")) { showToast("Choose the consultation date."); dateEl.focus(); return; }
    st.saving = true;
    renderFoot();
    try {
      const res = await callApi({
        action: "pasteNotes", op: "save", patientId: patient.id, date: field("date"), time: field("time"),
        staffId: field("staff"), status, soap, text: st.text, mode: st.mode,
        personalNotes: st.notes.filter((n) => n.on).map((n) => n.text), force,
      });
      if (res.problem) { showToast(res.problem); return; }
      if (res.needsForce) {
        const list = (res.existing || []).map((x) => `${x.pasted ? "pasted" : "recorded"}${x.staff ? ` by ${x.staff}` : ""}, ${x.status || "Draft"}`);
        st.saving = false;
        const ok = await confirmDialog({
          title: "Save another set of notes for this day?",
          message: `${patient.name} already has ${plural(list.length, "consultation note")} on ${longDate(field("date"))} (${list.join("; ")}).\n\n` +
            "These notes are saved separately. They aren't merged.",
          confirmLabel: "Save anyway", tone: "warning",
        });
        if (ok) return save(status, true);
        return;
      }
      st.text = "";
      try {
        const ch = new BroadcastChannel("dm-notes");
        ch.postMessage({ type: "notes-saved", id: res.id, status: status === "Reviewed" ? "reviewed" : "draft" });
        ch.close();
      } catch { /* older browsers */ }
      dlg.close();
      showToast(`${status === "Reviewed" ? "Notes saved as Reviewed" : "Notes saved as a Draft"}${
        field("date") !== toDateKey() ? ` for ${longDate(field("date"))}` : ""}`);
      if (onSaved) onSaved(res.id, status);
    } catch (err) {
      console.error("Saving pasted notes failed:", err);
      showToast(apiMessage(err, "Couldn't save the notes. Check your connection and try again."));
    } finally {
      st.saving = false;
      if (dlg.open) renderFoot();
    }
  }

  function apiMessage(err, fallback) {
    if (err && err.code === "FORBIDDEN") return "You don't have access to add consultation notes.";
    if (err && err.code === "UNAUTHORIZED") return "Your session has expired. Please log in again.";
    return fallback;
  }

  const field = (name) => { const el = $(`[data-f="${name}"]`); return el ? el.value : ""; };

  /* ---------- Closing ---------- */

  async function tryClose() {
    if (st.saving) return;
    if (st.text.trim() && !(await confirmDialog({
      title: "Close without saving?",
      message: "The pasted notes haven't been saved to the patient's record.",
      confirmLabel: "Close without saving", tone: "warning",
    }))) return;
    st.token++;
    dlg.close();
  }

  /* ---------- Events ---------- */

  src.addEventListener("input", () => {
    st.text = src.value;
    clearTimeout(splitTimer);
    if (st.mode === "split") splitTimer = setTimeout(() => resplit(false), 220);
    else { st.leftChanged = true; applyNoteDate(); renderRight(); renderFoot(); }
    renderLeft();
  });

  // Staff set the date or time themselves: the notes don't change it again
  [dateEl, timeEl].forEach((el) => el.addEventListener("input", () => {
    st.dateTouched = true;
    st.autoDate = null;
    renderDateNote();
    renderFoot();
  }));

  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("is-over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (e) => {
    drop.classList.remove("is-over");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (!/^text\//.test(f.type) && !/\.(txt|md|text)$/i.test(f.name)) { showToast("Drop a .txt file, or copy and paste the text."); return; }
    f.text().then(setText).catch(() => showToast("That file couldn't be read."));
  });

  dlg.addEventListener("input", (e) => {
    const ta = e.target.closest("textarea[data-t]");
    if (!ta) return;
    const b = st.blocks.find((x) => x.id === ta.dataset.t);
    if (!b) return;
    b.text = ta.value;
    st.rightEdited = true;
    autosize(ta);
    R("chips").querySelectorAll(".pn-chip").forEach((c) => c.classList.toggle("is-on", live().some((x) => x.key === c.dataset.chip)));
    renderFoot();
  });

  dlg.addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-sel]");
    if (sel) {
      const b = st.blocks.find((x) => x.id === sel.dataset.sel);
      if (!b) return;
      if (sel.value === "skip") b.prev = b.key;
      b.key = sel.value;
      st.rightEdited = true;
      renderRight();
      renderFoot();
      return;
    }
    const nb = e.target.closest("input[data-note]");
    if (nb && st.notes[Number(nb.dataset.note)]) st.notes[Number(nb.dataset.note)].on = nb.checked;
  });

  dlg.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("select")) return;   // the section drop-down never opens or closes the card
    const chip = t.closest("[data-chip]");
    if (chip) {
      const key = chip.dataset.chip;
      let b = st.blocks.find((x) => x.key === key);
      if (!b) { b = { id: nid(), heading: "", key, text: "", orig: "", open: true }; st.blocks.push(b); st.rightEdited = true; }
      b.open = true;
      renderRight();
      renderFoot();
      const card = dlg.querySelector(`.pn-card[data-id="${b.id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.remove("is-flash"); void card.offsetWidth; card.classList.add("is-flash");
        const ta = card.querySelector("textarea");
        if (ta && !b.text) ta.focus();
      }
      return;
    }
    const dropBtn = t.closest("[data-drop]");
    if (dropBtn) {
      const b = st.blocks.find((x) => x.id === dropBtn.dataset.drop);
      if (b) { b.prev = b.key; b.key = "skip"; st.rightEdited = true; renderRight(); renderFoot(); }
      return;
    }
    const undo = t.closest("[data-undo]");
    if (undo) {
      const b = st.blocks.find((x) => x.id === undo.dataset.undo);
      if (b) { b.key = b.prev || "clinical"; renderRight(); renderFoot(); }
      return;
    }
    const tog = t.closest("[data-toggle]");
    if (tog) { toggleCard(tog.dataset.toggle); return; }

    const a = t.closest("[data-a]");
    if (!a || a.disabled) return;
    const act = a.dataset.a;
    if (act === "close") tryClose();
    else if (act === "draft") save("Draft");
    else if (act === "reviewed") save("Reviewed");
    else if (act === "ai") writeWithAI();
    else if (act === "resplit") resplit(true);
    else if (act === "undo-date") undoNoteDate();
    else if (act === "expand") {
      const shown = st.blocks.filter((b) => b.key !== "skip");
      const open = !shown.every((b) => b.open);
      shown.forEach((b) => toggleCard(b.id, open));
    } else if (act === "cancel-ai") { st.token++; clearInterval(busyTimer); st.busy = false; st.mode = "split"; resplit(true); }
    else if (act === "split") {
      if (st.mode === "split") return;
      if ((st.blocks.length || st.rightEdited) && !(await confirmDialog({
        title: "Replace the AI notes?", message: "The sections on the right will be made again straight from the pasted text.",
        confirmLabel: "Split it", tone: "warning",
      }))) return;
      st.mode = "split";
      resplit(true);
    } else if (act === "clip") {
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) { showToast("The clipboard is empty."); return; }
        setText(text);
      } catch {
        src.focus();
        showToast("Press Ctrl+V (or ⌘V on a Mac) to paste.");
      }
    } else if (act === "clear") {
      if (st.text.trim() && !(await confirmDialog({ title: "Clear the pasted notes?", message: "Everything on both sides is cleared.",
        confirmLabel: "Clear", tone: "warning" }))) return;
      st.token++;
      st.busy = false;
      st.dateTouched = false;   // the next notes can set the date again
      setText("");
      src.focus();
    }
  });

  dlg.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save("Draft"); }
  });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); tryClose(); });
  dlg.addEventListener("close", () => { clearInterval(busyTimer); clearTimeout(splitTimer); dlg.remove(); });

  // The clinicians to choose from (the person logged in is first)
  listStaffDetails().then((list) => {
    if (!dlg.isConnected) return;
    const sel = $('[data-f="staff"]');
    const me = myUid();
    (list || []).filter((s) => s && s.id && s.id !== me && s.active !== false)
      .sort((x, y) => String(x.name).localeCompare(String(y.name)))
      .forEach((s) => sel.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`));
  }).catch(() => { /* just "me" */ });

  render();
  renderDateNote();
  dlg.showModal();
  src.focus();
}

function shellHtml(patient, staff) {
  const now = new Date();
  const today = toDateKey();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return `
    <header class="pn-head">
      <span class="pn-av" style="--h:${hueFromString(patient.name)}">${escapeHtml(getInitials(patient.name))}</span>
      <div class="pn-title">
        <h2>Paste consultation notes</h2>
        <p>${escapeHtml(patient.name)}${patient.pttId ? ` <span>· ID ${escapeHtml(patient.pttId)}</span>` : ""}</p>
      </div>
      <div class="pn-meta">
        <label class="pn-field"><span>Consultation date</span><input type="date" data-f="date" value="${today}" max="${today}" />
          <em class="pn-auto" data-r="datenote" hidden></em></label>
        <label class="pn-field"><span>Time</span><input type="time" data-f="time" value="${time}" /></label>
        <label class="pn-field"><span>Clinician</span><select data-f="staff"><option value="">${escapeHtml((staff && staff.name) || "Me")} (you)</option></select></label>
      </div>
      <button type="button" class="pn-x" data-a="close" aria-label="Close">${ICONS.x}</button>
    </header>
    <div class="pn-body">
      <section class="pn-pane pn-left">
        <div class="pn-pane-head">
          <span class="pn-step">1</span><h3>Paste the notes</h3>
          <div class="pn-tools">
            <button type="button" class="pn-tool" data-a="clip">${ICONS.paste}<span>Paste</span></button>
            <button type="button" class="pn-tool" data-a="clear">${ICONS.trash}<span>Clear</span></button>
          </div>
        </div>
        <div class="pn-drop">
          <textarea class="pn-src" spellcheck="false" maxlength="${MAX_CHARS}" aria-label="Pasted notes"
            data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false"
            placeholder="Copy the notes from Heidi and paste them here.&#10;&#10;Headings like Subjective, Medications or Plan are found automatically. A date at the top becomes the consultation date. A transcript works too: choose Write SOAP with AI."></textarea>
        </div>
        <div class="pn-stats" data-r="stats"></div>
        <div class="pn-modes" data-r="modes"></div>
      </section>
      <section class="pn-pane pn-right">
        <div class="pn-pane-head">
          <span class="pn-step">2</span><h3>Check where each part goes</h3>
          <span class="pn-badge" data-r="badge"></span>
          <button type="button" class="pn-tool" data-a="expand" data-r="expand" hidden>Expand all</button>
        </div>
        <div class="pn-chips" data-r="chips"></div>
        <div data-r="hint"></div>
        <div class="pn-cards" data-r="cards"></div>
      </section>
    </div>
    <footer class="pn-foot">
      <span class="pn-state" data-r="state"></span>
      <span class="pn-kbd"><kbd>Ctrl</kbd><kbd>S</kbd> saves a draft</span>
      <button type="button" class="pn-btn is-ghost" data-a="close">Cancel</button>
      <button type="button" class="pn-btn" data-a="draft">Save as draft</button>
      <button type="button" class="pn-btn is-primary" data-a="reviewed">${ICONS.check}<span>Save as reviewed</span></button>
    </footer>`;
}