import { db, auth } from "./firebase-config.js";
import { doc, getDoc, updateDoc, collection, query, where, getDocs, addDoc }
from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { SECTIONS, parseSoap, assembleSoap, transcriptHtml, cleanPlaceholders } from "./soap.js";
import {
  readSidecar, buildSidecar, planFromSidecar, planToSidecarPlan, planToText, priorCategories,
  planCardHtml, fieldHtml, getPlanValue, setPlanValue, refFrom, catKey, planFromText,
} from "./plan-editor.js";
import { fetchTranscriptRecords, parseRecordDate } from "./transcripts.js";
import {
  emailItemsFrom, emailCardHtml, openEmailComposer, emailItemsToText, emailItemsToSidecar,
} from "./email-composer.js";

import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { escapeHtml, showToast, toDateKey } from "./utils.js";

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
  lines: svg('<line x1="21" y1="6" x2="3" y2="6"/><line x1="15" y1="12" x2="3" y2="12"/><line x1="17" y1="18" x2="3" y2="18"/>'),
  chev: svg('<polyline points="9 18 15 12 9 6"/>'),
  max: svg('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  restore: svg('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  popout: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  dock: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>'),
  minimise: svg('<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>'),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  regen: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const STORE_KEY = "soapPanel"; // { id, mode }, per browser tab

let staff = null;
let panel = null;
let tab = null;
let content = null; // the panel's re-rendered area (resize handles live outside it)
let mode = "min";
let current = null; // { id, data, parsed, original, extras, dirty }

/* ===================== Public API ===================== */

export function initSoapPanel(currentStaff) {
  staff = currentStaff;
  ensureDom();
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
    if (saved && saved.id) showSoapPanel(saved.id, { mode: "min" });
  } catch { /* ignore */ }
}

export function hasUnsavedNotes() {
  return !!(current && current.dirty);
}

// On logout: close without asking
export function closeSoapPanel() {
  current = null;
  if (panel) { panel.hidden = true; content.innerHTML = ""; }
  if (tab) tab.hidden = true;
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

export async function showSoapPanel(recordId, { mode: wanted = "open" } = {}) {
  if (!recordId) return;
  ensureDom();
  if (current && current.id !== recordId && current.dirty && !(await confirmDialog({
    title: "Discard unsaved changes?",
    message: "You have unsaved changes to the notes that are open. Opening other notes will discard them.",
    confirmLabel: "Discard changes",
    tone: "warning",
  }))) return;

  if (!current || current.id !== recordId) {
    setMode(wanted);
    await load(recordId);
  } else {
    setMode(wanted);
  }
}

/* ===================== Layout ===================== */

function ensureDom() {
  if (panel) return;
  panel = document.createElement("aside");
  panel.className = "sp";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Consultation notes");
  content = document.createElement("div");
  content.className = "sp-content";
  panel.appendChild(content);
  panel.insertAdjacentHTML("beforeend", ["l", "r", "t", "b", "tl", "tr", "bl", "br"]
    .map((d) => `<div class="sp-rz sp-rz-${d}" data-rz="${d}" aria-hidden="true"></div>`).join(""));
  document.body.appendChild(panel);

  tab = document.createElement("button");
  tab.type = "button";
  tab.className = "sp-tab";
  tab.hidden = true;
  document.body.appendChild(tab);

  tab.addEventListener("click", () => setMode("open"));
  panel.addEventListener("click", onClick);
  // Move + resize
  panel.addEventListener("pointerdown", onPointerDown);
  panel.addEventListener("pointermove", onPointerMove);
  panel.addEventListener("pointerup", onPointerUp);
  panel.addEventListener("pointercancel", onPointerUp);
  panel.addEventListener("dblclick", (e) => {
    if (e.target.closest(".sp-head") && !e.target.closest("button, a, input, select, textarea")) toggleDock();
  });
  window.addEventListener("resize", () => applyLayout());

    // Treatment Plan card: finish an inline edit, category drop-down, keyboard
  panel.addEventListener("focusout", (e) => {
    if (e.target.matches && e.target.matches("textarea.pe-input")) commitPlanEdit(e.target);
  });
  // Enable "Draft Email" only when at least one treatment is ticked
  panel.addEventListener("change", (e) => {
    if (!e.target.matches("[data-em-check]")) return;
    const btn = panel.querySelector(".em-draft");
    if (btn) btn.disabled = !panel.querySelector("[data-em-check]:checked");
  });

  panel.addEventListener("change", (e) => {
    if (!e.target.matches("select.pe-cat") || !current || !current.plan) return;
    const c = current.plan.concerns[Number(e.target.dataset.ci)];
    if (c) { c.concern_category = e.target.value; markDirty(); rerenderPlan(); }
  });
  panel.addEventListener("keydown", (e) => {
    if (e.target.matches && e.target.matches("textarea.pe-input") && e.key === "Escape") {
      e.target.value = getPlanValue(current.plan, refFrom(e.target)); // cancel
      e.target.blur();
      return;
    }
    const field = e.target.closest && e.target.closest(".pe-field");
    if (field && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); startPlanEdit(field); }
  });

  panel.addEventListener("input", (e) => {
    if (e.target.matches("textarea")) autosize(e.target);
    if (e.target.matches("textarea[data-key], textarea[data-extra]")) markDirty();
  });

  window.addEventListener("beforeunload", (e) => {
    if (hasUnsavedNotes()) { e.preventDefault(); e.returnValue = ""; }
  });
}

function setMode(next) {
  mode = next;
  panel.hidden = mode === "min";
  panel.classList.toggle("is-max", mode === "max");
  applyLayout();
  updateTab();
  if (!panel.hidden) requestAnimationFrame(autosizeAll);
  try {
    if (current && current.id) sessionStorage.setItem(STORE_KEY, JSON.stringify({ id: current.id, mode }));
  } catch { /* ignore */ }
}

function updateTab() {
  if (!tab) return;
  const show = mode === "min" && !!current;
  tab.hidden = !show;
  if (!show) return;
  const status = current.data ? String(current.data.Status || "Draft") : "Loading";
  const label = /^reviewed$/i.test(status) ? "Reviewed" : current.data ? "Draft" : "…";
  tab.innerHTML = `${ICONS.note}<span>Notes</span><em>${escapeHtml(label)}${current.dirty ? " •" : ""}</em>`;
  tab.classList.remove("pulse");
  void tab.offsetWidth;
  tab.classList.add("pulse");
}

function autosize(ta) {
  ta.style.height = "auto";
  const min = ta.classList.contains("pe-input") ? 0 : 72; // inline plan fields stay compact
  ta.style.height = `${Math.max(ta.scrollHeight, min)}px`;
}

function autosizeAll() {
  if (panel) panel.querySelectorAll("textarea").forEach(autosize);
}

/* ===================== Loading ===================== */

async function load(id) {
  current = { id, data: null };
  updateTab();
  content.innerHTML = `<div class="sp-loading"><div class="spinner"></div><p>Loading notes…</p></div>`;

  try {
    const snap = await getDoc(doc(db, "appointment_transcripts", id));
    if (!current || current.id !== id) return;
    if (!snap.exists()) throw new Error("This record no longer exists.");

    const data = snap.data();
    const parsed = parseSoap(data["Gemini SOAP"]);
    const original = {};
    SECTIONS.forEach((s) => { original[s.key] = cleanPlaceholders(parsed.sections[s.key]); });

    const sidecarObj = readSidecar(data["Gemini SOAP"]);
    // Prefer the recorder's sidecar; for older records, read the plan text instead
    const plan = planFromSidecar(sidecarObj) || planFromText(parsed.sections.plan);
    current = {
      id, data, parsed, original, extras: parsed.extras.map((x) => ({ ...x })), dirty: false,
      sidecarObj, plan, planSnapshot: JSON.stringify(plan), priorCats: null,
    };
     current.emailItems = emailItemsFrom(sidecarObj, parsed.sections.email);
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ id, mode })); } catch { /* ignore */ }
    render();
    loadPersonalNotes();
    loadPriorCategories();
  } catch (err) {
    if (!current || current.id !== id) return;
    console.error("Loading notes failed:", err);
    content.innerHTML = `
      <div class="sp-loading">
        <p>${escapeHtml(err.code === "permission-denied" ? "You don't have permission to view these notes." : err.message || "Couldn't load the notes.")}</p>
        <button type="button" class="btn-ghost sm" data-sp="close">Close</button>
      </div>`;
  }
  updateTab();
}

/* ===================== Rendering ===================== */

function render() {
  const d = current.data;
  const status = String(d.Status || "Draft");
  const reviewed = /^reviewed$/i.test(status);
  const hasSoap = !!String(d["Gemini SOAP"] || "").trim();
  const keepPn = panel.querySelector("[data-pn]") ? panel.querySelector("[data-pn]").value : null;
  const suggestions = Array.isArray(d["Suggested Personal Notes"]) ? d["Suggested Personal Notes"] : [];

  content.innerHTML = `
    <div class="sp-head">
      <div class="sp-head-main">
        <p class="sp-eyebrow">Consultation notes</p>
        <h3>${escapeHtml(d["Patient Name"] || "Patient")}</h3>
        <p class="sp-meta">${escapeHtml(d["Record Date and Time"] || "")}${d["Staff Name"] ? ` · ${escapeHtml(d["Staff Name"])}` : ""}</p>
      </div>
      <span class="sp-status ${reviewed ? "is-reviewed" : "is-draft"}">${escapeHtml(reviewed ? "Reviewed" : status)}</span>
      <div class="sp-head-actions">
        <button type="button" class="sp-icon-btn" data-sp="float" title="${layout.docked ? "Pop out (move anywhere)" : "Dock to the right"}" aria-label="Pop out or dock">${layout.docked ? ICONS.popout : ICONS.dock}</button>
        <button type="button" class="sp-icon-btn" data-sp="max" title="${mode === "max" ? "Restore" : "Maximise"}" aria-label="Maximise">${mode === "max" ? ICONS.restore : ICONS.max}</button>
        <button type="button" class="sp-icon-btn" data-sp="min" title="Minimise" aria-label="Minimise">${ICONS.minimise}</button>
        <button type="button" class="sp-icon-btn" data-sp="close" title="Close" aria-label="Close">${ICONS.close}</button>
      </div>
    </div>

    <div class="sp-body">
      ${reviewed && d["Reviewed By"] ? `<p class="sp-banner ok">Reviewed by ${escapeHtml(d["Reviewed By"])}${d["Reviewed At"] ? ` on ${escapeHtml(stamp(new Date(d["Reviewed At"])))}` : ""}.</p>` : ""}
      ${!reviewed && d["Last Regenerated"] && d["Previous Gemini SOAP"] && d["Previous Gemini SOAP"] !== d["Gemini SOAP"]
        ? `<p class="sp-banner info">Notes regenerated ${escapeHtml(d["Last Regenerated"])}${d["Regenerated By"] ? ` by ${escapeHtml(d["Regenerated By"])}` : ""}.
             <button type="button" class="sp-link" data-sp="undo-regen">Restore previous version</button></p>`
        : ""}
      ${!hasSoap ? `<p class="sp-banner warn">Clinical notes haven't been generated for this record yet. You can still type notes below.</p>` : ""}

      <details class="sp-raw">
        <summary>${ICONS.chev}${ICONS.lines}<span>Raw transcript</span></summary>
        <div class="sp-raw-body">${transcriptHtml(d["Full Raw Transcript"], escapeHtml)}</div>
      </details>

      <div class="sp-grid">
        ${SECTIONS.map((s) => sectionHtml(s, current.original[s.key])).join("")}
        ${current.extras.map((x, i) => `
          <section class="sp-card sp-tone-slate full">
            <header>${ICONS.note}<span>${escapeHtml(x.heading)}</span></header>
            <textarea data-extra="${i}" placeholder="Nothing recorded.">${escapeHtml(x.text)}</textarea>
          </section>`).join("")}

        <section class="sp-card sp-tone-pink full sp-pn">
          <header>${ICONS.note}<span>Personal Notes</span>
            <button type="button" class="sp-mini" data-sp="save-note">Save Note</button></header>
          <textarea data-pn placeholder="Add a personal note for future visits…">${escapeHtml(keepPn !== null ? keepPn : suggestions.join("\n"))}</textarea>
          ${suggestions.length && keepPn === null ? `<p class="sp-hint">Suggested from this consultation. Edit before saving.</p>` : ""}
          <div class="sp-prev">
            <p class="sp-prev-title">Previous notes</p>
            <div class="sp-prev-list"><p class="sp-empty">Loading…</p></div>
          </div>
        </section>
      </div>
    </div>

    <div class="sp-foot">
      ${reviewed ? "" : `<button type="button" class="sp-del" data-sp="delete" title="Delete this recording">${ICONS.trash}Delete</button>`}
      ${reviewed ? "" : `<button type="button" class="sp-regen" data-sp="regenerate" title="Write the notes again from the transcript">${ICONS.regen}Regenerate</button>`}
      <span class="sp-save-state">${saveStateText()}</span>
      <button type="button" class="btn-ghost" data-sp="save-draft">Save as Draft</button>
      <button type="button" class="btn-primary" data-sp="save-reviewed">Save as Reviewed</button>
    </div>`;

  if (!panel.hidden) requestAnimationFrame(autosizeAll);
}

function sectionHtml(s, value) {
  // Structured Treatment Plan card when the record has the recorder's sidecar
  if (s.key === "plan" && current && current.plan) {
    return `<section class="sp-card sp-tone-green full" data-plan-card>${planCardHtml(current.plan, current.priorCats)}</section>`;
  }
    // Treatment Info to Email: checklist + composer
  if (s.key === "email" && current && current.emailItems && current.emailItems.length) {
    return `<section class="sp-card sp-tone-indigo" data-email-card>${emailCardHtml(current.emailItems, current.data["Treatment Emails Sent"])}</section>`;
  }
  const planActions = s.key === "plan" ? `
    <span class="sp-card-actions">
      <button type="button" class="sp-mini" data-soon="Update email from plan">Update email from plan</button>
      <button type="button" class="sp-mini solid" data-soon="Create Treatment Plan">Create Treatment Plan</button>
    </span>` : "";
  return `
    <section class="sp-card sp-tone-${s.tone} ${s.full ? "full" : ""}">
      <header>${ICONS[s.icon]}<span>${escapeHtml(s.title)}</span>${planActions}</header>
      <textarea data-key="${s.key}" placeholder="Nothing recorded.">${escapeHtml(value || "")}</textarea>
    </section>`;
}

function saveStateText() {
  if (current.dirty) return "Unsaved changes";
  const d = current.data;
  return d["Last Saved"] ? `Last saved ${escapeHtml(d["Last Saved"])}${d["Last Saved By"] ? ` by ${escapeHtml(d["Last Saved By"])}` : ""}` : "";
}

function markDirty() {
  if (!current || current.dirty) return;
  current.dirty = true;
  const el = panel.querySelector(".sp-save-state");
  if (el) { el.textContent = "Unsaved changes"; el.classList.add("dirty"); }
}

/* ===================== Actions ===================== */

async function onClick(e) {
  // Treatment Plan card: click a line to edit, or add/remove items
  if (current && current.plan) {
    const field = e.target.closest(".pe-field");
    if (field) { startPlanEdit(field); return; }
    const pe = e.target.closest("[data-pe]");
    if (pe) { planAction(pe); return; }
  }
  const soon = e.target.closest("[data-soon]");
  if (soon) { showToast(`${soon.dataset.soon}: coming soon`); return; }

  const btn = e.target.closest("[data-sp]");
  if (!btn) return;
  const action = btn.dataset.sp;

  if (action === "max") { setMode(mode === "max" ? "open" : "max"); if (current && current.data) refreshHeaderIcon(); }
  else if (action === "min") setMode("min");
  else if (action === "float") toggleDock();
  else if (action === "close") {
    if (hasUnsavedNotes() && !(await confirmDialog({
      title: "Close without saving?",
      message: "Your changes to these notes haven't been saved yet.",
      confirmLabel: "Close without saving",
      tone: "warning",
    }))) return;
    closeSoapPanel();
  }
  else if (action === "save-draft") save("Draft", btn);
  else if (action === "save-reviewed") save("Reviewed", btn);
  else if (action === "save-note") saveNote(btn);
  else if (action === "regenerate") regenerate();
  else if (action === "undo-regen") undoRegenerate();
  else if (action === "email-draft") draftEmail();
  else if (action === "email-from-plan") emailFromPlan(btn);
  else if (action === "delete") showDeleteConfirm();
  else if (action === "delete-cancel") hideDeleteConfirm();
  else if (action === "delete-confirm") doDelete(btn);
}

function refreshHeaderIcon() {
  const b = panel.querySelector('[data-sp="max"]');
  if (b) b.innerHTML = mode === "max" ? ICONS.restore : ICONS.max;
}

function stamp(d) {
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? "AM" : "PM";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

async function save(status, btn) {
  if (!current || !current.data) return;
  const user = auth.currentUser;
  if (!user || !staff) { showToast("Please log in again to save."); return; }

  const values = {};
  panel.querySelectorAll("textarea[data-key]").forEach((ta) => { values[ta.dataset.key] = ta.value; });
  const extras = current.extras.map((x, i) => {
    const ta = panel.querySelector(`textarea[data-extra="${i}"]`);
    return { heading: x.heading, text: ta ? ta.value : x.text };
  });
  // The email card isn't a text box: use the rebuilt list, or keep the text as it was
  if (current.emailEdited) values.email = emailItemsToText(current.emailItems);
  else if (current.emailItems && current.emailItems.length) values.email = current.original.email;
  const changed = (k) => String(values[k] || "").trim() !== String(current.original[k] || "").trim();
  let sidecar = "";
  let keepSidecar = false;

  if (current.plan) panel.querySelectorAll("textarea.pe-input").forEach(commitPlanEdit);

  if (current.plan && current.plan.fromText && JSON.stringify(current.plan) === current.planSnapshot) {
    // Older record whose plan wasn't touched: keep its original text exactly
    values.plan = current.parsed.sections.plan || "";
    keepSidecar = !changed("email");
  } else if (current.plan) {
    // Structured plan: rebuild BOTH the plan text and a matching sidecar
    values.plan = planToText(current.plan);
    const sc = { plan: planToSidecarPlan(current.plan) };
    const oldEmail = current.sidecarObj && Array.isArray(current.sidecarObj.email) ? current.sidecarObj.email : null;
    // Keep the recorder's email items only if the email text wasn't edited (otherwise they'd be out of date)
    const emailForSidecar = current.emailEdited
      ? emailItemsToSidecar(current.emailItems)         // rebuilt from the plan
      : (oldEmail && !changed("email") ? oldEmail : null);
    sidecar = buildSidecar(emailForSidecar ? { email: emailForSidecar, plan: sc.plan } : sc);
  } else {
    // Plain-text plan: if the plan or email text changed, the old sidecar would be out of date, so drop it
    keepSidecar = !changed("plan") && !changed("email");
  }

  const soap = assembleSoap(current.parsed, values, extras, { keepSidecar, sidecar });

  const now = new Date();
  const update = {
    "Gemini SOAP": soap,
    "Status": status,
    "Last Saved": stamp(now),
    "Last Saved By": staff.name,
    "Last Saved By Uid": user.uid,
  };
  if (status === "Reviewed") {
    Object.assign(update, { "Reviewed By": staff.name, "Reviewed By Uid": user.uid, "Reviewed At": now.toISOString() });
  }

  const buttons = panel.querySelectorAll(".sp-foot button");
  buttons.forEach((b) => { b.disabled = true; });
  const label = btn.textContent;
  btn.textContent = "Saving…";

  try {
    await updateDoc(doc(db, "appointment_transcripts", current.id), update);
    Object.assign(current.data, update);
    current.parsed = parseSoap(soap);
    SECTIONS.forEach((s) => { current.original[s.key] = cleanPlaceholders(current.parsed.sections[s.key]); });
    current.extras = current.parsed.extras.map((x) => ({ ...x }));
    current.dirty = false;
    current.sidecarObj = readSidecar(soap);
    current.plan = planFromSidecar(current.sidecarObj) || planFromText(current.parsed.sections.plan);
    current.planSnapshot = JSON.stringify(current.plan);
    current.emailItems = emailItemsFrom(current.sidecarObj, current.parsed.sections.email);
    current.emailEdited = false;
    render();
    loadPersonalNotes();
    updateTab();
    showToast(status === "Reviewed" ? "Notes saved as Reviewed" : "Draft saved");
  } catch (err) {
    console.error("Saving notes failed:", err);
    showToast(err.code === "permission-denied"
      ? "You don't have permission to save these notes."
      : "Couldn't save. Check your connection and try again.");
    buttons.forEach((b) => { b.disabled = false; });
    btn.textContent = label;
  }
}

/* ===================== Personal notes ===================== */

async function loadPersonalNotes() {
  if (!current || !current.data) return;
  const id = current.id;
  const box = panel.querySelector(".sp-prev-list");
  if (!box) return;

  const d = current.data;
  const ids = [...new Set([d["Patient ID"], d["Patient Doc ID"]].map((s) => String(s || "").trim()).filter(Boolean))];
  if (!ids.length) { box.innerHTML = `<p class="sp-empty">No previous notes.</p>`; return; }

  try {
    const snap = await getDocs(query(collection(db, "patient_personal_notes"), where("patientId", "in", ids)));
    if (!current || current.id !== id) return;
    const notes = snap.docs.map((x) => x.data()).filter((n) => !n.deleted)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    box.innerHTML = notes.length
      ? notes.map((n) => {
          const when = n.createdAt ? stamp(new Date(n.createdAt)) : (n.noteDate || "");
          return `<div class="sp-note"><p>${escapeHtml(n.note || "")}</p><span>${escapeHtml(when)}${n.createdBy ? ` · ${escapeHtml(n.createdBy)}` : ""}</span></div>`;
        }).join("")
      : `<p class="sp-empty">No previous notes.</p>`;
  } catch (err) {
    console.warn("Personal notes failed:", err);
    if (current && current.id === id) box.innerHTML = `<p class="sp-empty">Couldn't load previous notes.</p>`;
  }
}

async function saveNote(btn) {
  const ta = panel.querySelector("[data-pn]");
  const note = ta ? ta.value.trim() : "";
  if (!note) { showToast("Write a note first"); return; }
  const user = auth.currentUser;
  if (!user || !staff) { showToast("Please log in again to save."); return; }

  const d = current.data;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await addDoc(collection(db, "patient_personal_notes"), {
      createdAt: new Date().toISOString(),
      createdBy: staff.name,
      createdByUid: user.uid,
      note,
      noteDate: toDateKey(),
      patientId: String(d["Patient ID"] || "").trim(),
      patientName: String(d["Patient Name"] || "").trim(),
      recordId: current.id,
      updatedAt: "",
      updatedBy: "",
    });
    ta.value = "";
    const hint = panel.querySelector(".sp-hint");
    if (hint) hint.remove();
    autosize(ta);
    showToast("Personal note saved");
    loadPersonalNotes();
  } catch (err) {
    console.error("Saving personal note failed:", err);
    showToast(err.code === "permission-denied" ? "You don't have permission to save notes." : "Couldn't save the note.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Note";
  }
}

/* ===================== Delete ===================== */

function showDeleteConfirm() {
  const foot = panel.querySelector(".sp-foot");
  if (!foot || foot.classList.contains("is-confirm")) return;
  foot.dataset.prev = foot.innerHTML; // restore on Cancel, keeping any unsaved edits above intact
  foot.classList.add("is-confirm");
  foot.innerHTML = `
    <div class="sp-del-confirm">
      <p><strong>Delete this recording?</strong> The notes, transcript and audio will be permanently removed.
        This can't be undone. A record of who deleted it, when and why is kept.</p>
      <input type="text" class="sp-del-reason" maxlength="300"
             placeholder="Reason, e.g. wrong patient or test recording" aria-label="Reason for deleting" />
      <div class="sp-del-actions">
        <button type="button" class="btn-ghost" data-sp="delete-cancel">Cancel</button>
        <button type="button" class="sp-del solid" data-sp="delete-confirm">${ICONS.trash}Delete permanently</button>
      </div>
    </div>`;
  foot.querySelector(".sp-del-reason").focus();
}

function hideDeleteConfirm() {
  const foot = panel.querySelector(".sp-foot");
  if (!foot || !foot.classList.contains("is-confirm")) return;
  foot.classList.remove("is-confirm");
  foot.innerHTML = foot.dataset.prev || "";
}

async function doDelete(btn) {
  if (!current || !current.id) return;
  const reasonEl = panel.querySelector(".sp-del-reason");
  const reason = reasonEl ? reasonEl.value.trim() : "";
  if (reason.length < 3) {
    showToast("Please give a short reason");
    if (reasonEl) reasonEl.focus();
    return;
  }

  const id = current.id;
  btn.disabled = true;
  btn.innerHTML = "Deleting…";

  try {
    await callApi({ action: "deleteRecording", recordId: id, reason });
    current.dirty = false;
    closeSoapPanel();
    showToast("Recording deleted");
    window.dispatchEvent(new CustomEvent("recording-deleted", { detail: { id } }));
    // Refresh the patient page so the deleted notes disappear from its sections
    if (location.hash.startsWith("#/patient/")) window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch (err) {
    console.error("Delete failed:", err);
    const messages = {
      FORBIDDEN: "Only the clinician who recorded this, or an Admin, can delete it.",
      REVIEWED: "Reviewed notes can't be deleted.",
      NOT_FOUND: "This recording has already been deleted.",
      REASON_REQUIRED: "Please give a short reason.",
      UNAUTHORIZED: "Your session has expired. Please log in again.",
    };
    showToast(messages[err.code] || "Couldn't delete. Please try again.");
    btn.disabled = false;
    btn.innerHTML = `${ICONS.trash}Delete permanently`;
  }
}

/* ===================== Treatment Plan card ===================== */

function rerenderPlan() {
  const card = panel.querySelector("[data-plan-card]");
  if (card && current && current.plan) card.innerHTML = planCardHtml(current.plan, current.priorCats);
}

function startPlanEdit(field) {
  if (!current || !current.plan) return;
  const ref = refFrom(field);
  const ta = document.createElement("textarea");
  ta.className = "pe-input";
  ta.dataset.pf = ref.pf;
  if (ref.ci !== undefined) ta.dataset.ci = ref.ci;
  if (ref.ti !== undefined) ta.dataset.ti = ref.ti;
  ta.placeholder = field.dataset.ph || "";
  ta.value = getPlanValue(current.plan, ref);
  field.replaceWith(ta);
  autosize(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function commitPlanEdit(ta) {
  if (!current || !current.plan || ta.dataset.done) return;
  ta.dataset.done = "1";
  const ref = refFrom(ta);
  const before = String(getPlanValue(current.plan, ref)).trim();
  const after = ta.value.trim();
  if (after !== before) { setPlanValue(current.plan, ref, after); markDirty(); }
  const tpl = document.createElement("template");
  tpl.innerHTML = fieldHtml(ref, after).trim();
  if (ta.isConnected) ta.replaceWith(tpl.content.firstElementChild);
}

async function planAction(btn) {
  const plan = current.plan;
  const open = panel.querySelector("textarea.pe-input");
  if (open) commitPlanEdit(open);
  const action = btn.dataset.pe;

  if (action === "remove-concern") {
    const i = Number(btn.dataset.ci);
    const c = plan.concerns[i];
    const name = `concern ${String.fromCharCode(65 + i)}${c && c.concern_category ? ` (${c.concern_category})` : ""}`;
    if (!(await confirmDialog({
      title: `Remove ${name}?`,
      message: "It will be taken out of the treatment plan. Nothing is saved until you click Save.",
      confirmLabel: "Remove",
      tone: "danger",
    }))) return;
    plan.concerns.splice(i, 1);
  } else if (action === "add-concern") {
    plan.concerns.push({ description: "", concern_category: "", area: "", treatment: "", frequency_interval: "", quote: "", comments: "" });
    if (plan.intent !== "new_plan") plan.intent = "new_plan";
  } else if (action === "remove-step") {
    plan.timeline.splice(Number(btn.dataset.ti), 1);
  } else if (action === "add-step") {
    plan.timeline.push({ date: "", treatment: "", pretreatment_instructions: "" });
  } else {
    return;
  }

  markDirty();
  rerenderPlan();

  // Jump straight into editing the new item
  if (action === "add-concern") {
    const f = panel.querySelector(`.pe-field[data-pf="description"][data-ci="${plan.concerns.length - 1}"]`);
    if (f) startPlanEdit(f);
  }
  if (action === "add-step") {
    const f = panel.querySelector(`.pe-field[data-pf="date"][data-ti="${plan.timeline.length - 1}"]`);
    if (f) startPlanEdit(f);
  }
}

// NEW vs UPDATE: categories this patient already had a plan for in EARLIER consultations
async function loadPriorCategories() {
  if (!current || !current.plan) return;
  const id = current.id;
  const d = current.data;
  const thisDate = parseRecordDate(d["Record Date and Time"]);

  try {
    const records = await fetchTranscriptRecords({
      id: String(d["Patient Doc ID"] || ""), pttId: String(d["Patient ID"] || ""),
      name: String(d["Patient Name"] || ""), firstName: "", lastName: "",
    });
    if (!current || current.id !== id) return;

    const cats = new Set();
    records.forEach((r) => {
      if (r.id === id) return;
      if (thisDate && r.date && r.date >= thisDate) return; // only consultations before this one
      priorCategories(r.soap).forEach((c) => cats.add(catKey(c)));
    });
    current.priorCats = cats;
    rerenderPlan();
  } catch (err) {
    console.warn("Couldn't work out NEW / UPDATE badges:", err);
  }
}

/* ===================== Treatment Info to Email ===================== */

function rerenderEmail() {
  const card = panel.querySelector("[data-email-card]");
  if (card && current && current.emailItems) {
    card.innerHTML = emailCardHtml(current.emailItems, current.data["Treatment Emails Sent"]);
  }
}

function draftEmail() {
  if (!current || !current.emailItems) return;
  const picked = [...panel.querySelectorAll("[data-em-check]:checked")]
    .map((cb) => current.emailItems[Number(cb.dataset.emCheck)])
    .filter(Boolean);
  if (!picked.length) { showToast("Tick at least one treatment"); return; }

  const id = current.id;
  openEmailComposer({
    items: picked,
    recordId: id,
    record: current.data,
    staff,
    onSent: (entry) => {
      if (!current || current.id !== id) return;
      const log = Array.isArray(current.data["Treatment Emails Sent"]) ? current.data["Treatment Emails Sent"] : [];
      current.data["Treatment Emails Sent"] = [...log, entry];
      rerenderEmail();
    },
  });
}

/* ===================== Regenerate notes ===================== */

function showBusy(title, detail) {
  hideBusy();
  panel.insertAdjacentHTML("beforeend", `
    <div class="sp-busy" role="status">
      <div class="spinner"></div>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail || "")}</span>
    </div>`);
}

function hideBusy() {
  const el = panel.querySelector(".sp-busy");
  if (el) el.remove();
}

async function regenerate() {
  if (!current || !current.data) return;
  const ok = await confirmDialog({
    title: "Regenerate the notes?",
    message: "Gemini will write the notes again from the transcript and replace them with a new Draft.\n\n" +
      "The current version is kept, so you can restore it if you prefer it." +
      (hasUnsavedNotes() ? "\n\nYour unsaved edits will be lost." : ""),
    confirmLabel: "Regenerate",
    tone: hasUnsavedNotes() ? "warning" : "info",
  });
  if (!ok) return;

  const id = current.id;
  showBusy("Regenerating the notes…", "This can take a minute or two. You can minimise this panel and keep working.");

  try {
    await callApi({ action: "regenerateSoap", recordId: id });
    if (!current || current.id !== id) return;
    current.dirty = false;
    await load(id); // reload the fresh notes (this also clears the overlay)
    updateTab();
    showToast("Notes regenerated");
  } catch (err) {
    console.error("Regenerate failed:", err.code || "(no code)", err);
    if (current && current.id === id) hideBusy();
    const messages = {
      REVIEWED: "Reviewed notes can't be regenerated. Save as Draft first if you really need to.",
      NO_TRANSCRIPT: "There's no transcript saved for this record, so it can't be regenerated.",
      BUSY: "These notes are already being regenerated. Please wait a moment.",
      GEMINI_FAILED: "Gemini couldn't write the notes just now. Please try again in a minute.",
      NOT_FOUND: "This record no longer exists.",
      UNAUTHORIZED: "Your session has expired. Please log in again.",
    };
    showToast(messages[err.code] || "Couldn't regenerate the notes. Please try again.");
  }
}

async function undoRegenerate() {
  if (!current || !current.data) return;
  const prev = current.data["Previous Gemini SOAP"];
  if (!prev) return;
  if (!(await confirmDialog({
    title: "Restore the previous version?",
    message: "The regenerated notes will be replaced by the version from before you regenerated.",
    confirmLabel: "Restore",
    tone: "info",
  }))) return;

  const user = auth.currentUser;
  if (!user || !staff) { showToast("Please log in again."); return; }

  const id = current.id;
  try {
    await updateDoc(doc(db, "appointment_transcripts", id), {
      "Gemini SOAP": prev,
      "Status": "Draft",
      "Last Saved": stamp(new Date()),
      "Last Saved By": staff.name,
      "Last Saved By Uid": user.uid,
    });
    current.dirty = false;
    await load(id);
    showToast("Previous version restored");
  } catch (err) {
    console.error("Restore failed:", err);
    showToast(err.code === "permission-denied"
      ? "You don't have permission to change these notes."
      : "Couldn't restore. Please try again.");
  }
}

/* ===================== Update email from plan ===================== */

async function emailFromPlan(btn) {
  if (!current || !current.plan) return;
  panel.querySelectorAll("textarea.pe-input").forEach(commitPlanEdit); // include an edit still in progress

  const concerns = current.plan.concerns.filter((c) => String(c.treatment || "").trim());
  if (!concerns.length) { showToast("Add a treatment to the plan first"); return; }

  if (current.emailItems && current.emailItems.length && !(await confirmDialog({
    title: "Update the email list from the plan?",
    message: "The Treatment Info to Email list will be rebuilt from the treatment plan, including any quotes or treatments you've changed.\n\n" +
      "Nothing is saved until you click Save.",
    confirmLabel: "Update list",
    tone: "info",
  }))) return;

  const id = current.id;
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Updating…";

  try {
    const res = await callApi({
      action: "emailFromPlan",
      plan: concerns.map((c) => ({
        category: c.concern_category, area: c.area, treatment: c.treatment,
        frequency: c.frequency_interval, quote: c.quote, comments: c.comments,
      })),
      current: current.emailItems || [],
    });
    if (!current || current.id !== id) return;

    const items = emailItemsFrom({ email: res.items || [] }, "");
    if (!items.length) { showToast("No treatments could be matched from the plan."); return; }

    current.emailItems = items;
    current.emailEdited = true;
    markDirty();

    // Replace just the email card (other unsaved edits stay as they are)
    const html = `<section class="sp-card sp-tone-indigo em-flash" data-email-card>${emailCardHtml(items, current.data["Treatment Emails Sent"])}</section>`;
    const existing = panel.querySelector("[data-email-card]") ||
      (panel.querySelector('textarea[data-key="email"]') || {}).closest?.(".sp-card");
    if (existing) existing.outerHTML = html;
    const card = panel.querySelector("[data-email-card]");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });

    showToast("Treatment Info to Email updated. Review it, then Save.");
  } catch (err) {
    console.error("Update email from plan failed:", err.code || "(no code)", err);
    const messages = {
      GEMINI_FAILED: "Gemini couldn't update the list just now. Please try again.",
      UNAUTHORIZED: "Your session has expired. Please log in again.",
    };
    showToast(messages[err.code] || "Couldn't update the email list. Please try again.");
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.innerHTML = label; }
  }
}

/* ===================== Move & resize ===================== */

const LAYOUT_KEY = "sp-layout"; // size/position only, never patient data
const MIN_W = 380;
const MIN_H = 320;
const DEFAULT_LAYOUT = { docked: true, width: 560, x: 80, y: 90, w: 560, h: 640 };
let layout = loadLayout();
let drag = null;

function loadLayout() {
  try { return { ...DEFAULT_LAYOUT, ...(JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}) }; }
  catch { return { ...DEFAULT_LAYOUT }; }
}

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}

const isSmall = () => window.innerWidth < 860;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// Keeps the panel usable when the browser window changes size
function fitToViewport() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  layout.width = clamp(layout.width, MIN_W, vw - 80);
  layout.w = clamp(layout.w, MIN_W, vw - 16);
  layout.h = clamp(layout.h, MIN_H, vh - 16);
  layout.x = clamp(layout.x, 120 - layout.w, vw - 120); // at least 120px stays on screen
  layout.y = clamp(layout.y, 8, vh - 56);               // the header is always reachable
}

function applyLayout() {
  if (!panel) return;
  const floating = !layout.docked && mode !== "max" && !isSmall();
  panel.classList.toggle("is-floating", floating);

  const s = panel.style;
  s.left = s.top = s.width = s.height = s.right = s.bottom = "";
  if (mode !== "max" && !isSmall()) {
    fitToViewport();
    if (floating) {
      Object.assign(s, {
        left: `${layout.x}px`, top: `${layout.y}px`, width: `${layout.w}px`, height: `${layout.h}px`,
        right: "auto", bottom: "auto",
      });
    } else {
      s.width = `${layout.width}px`;
    }
  }

  const btn = panel.querySelector('[data-sp="float"]');
  if (btn) {
    btn.innerHTML = layout.docked ? ICONS.popout : ICONS.dock;
    btn.title = layout.docked ? "Pop out (move anywhere)" : "Dock to the right";
  }
}

function toggleDock() {
  if (isSmall()) return;
  if (mode === "max") setMode("open");
  layout.docked = !layout.docked;
  applyLayout();
  saveLayout();
}

function onPointerDown(e) {
  if (e.button !== 0 || isSmall() || mode === "max") return;
  const handle = e.target.closest(".sp-rz");
  const head = !handle && e.target.closest(".sp-head");
  if (!handle && !head) return;
  if (head && e.target.closest("button, a, input, select, textarea")) return;
  e.preventDefault();

  // Pulling the header of the docked panel pops it out right where it is
  if (head && layout.docked) {
    const r = panel.getBoundingClientRect();
    Object.assign(layout, {
      docked: false, x: r.left, y: r.top, w: r.width, h: Math.min(r.height, window.innerHeight - 40),
    });
    applyLayout();
  }

  drag = { kind: handle ? handle.dataset.rz : "move", sx: e.clientX, sy: e.clientY, start: { ...layout }, pid: e.pointerId };
  panel.setPointerCapture(e.pointerId);
  document.body.classList.add("sp-dragging");
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  const st = drag.start;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (drag.kind === "move") {
    layout.x = st.x + dx;
    layout.y = st.y + dy;
    panel.classList.toggle("sp-snap", e.clientX > vw - 24); // hint: drop here to dock
  } else if (layout.docked) {
    layout.width = clamp(vw - e.clientX, MIN_W, vw - 80); // docked: only the left edge resizes
  } else {
    const k = drag.kind;
    if (k.includes("r")) layout.w = clamp(st.w + dx, MIN_W, vw - st.x - 8);
    if (k.includes("b")) layout.h = clamp(st.h + dy, MIN_H, vh - st.y - 8);
    if (k.includes("l")) { const w = clamp(st.w - dx, MIN_W, st.x + st.w - 8); layout.x = st.x + st.w - w; layout.w = w; }
    if (k.includes("t")) { const h = clamp(st.h - dy, MIN_H, st.y + st.h - 8); layout.y = st.y + st.h - h; layout.h = h; }
  }
  applyLayout();
}

function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  if (drag.kind === "move" && e.clientX > window.innerWidth - 24) layout.docked = true; // dropped on the right edge
  panel.classList.remove("sp-snap");
  try { panel.releasePointerCapture(drag.pid); } catch { /* already released */ }
  drag = null;
  document.body.classList.remove("sp-dragging");
  applyLayout();
  saveLayout();
}