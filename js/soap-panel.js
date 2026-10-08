import { db, auth } from "./firebase-config.js";
import { doc, getDoc, updateDoc, collection, query, where, getDocs, addDoc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { SECTIONS, parseSoap, assembleSoap, transcriptHtml } from "./soap.js";
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
  minimise: svg('<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>'),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const STORE_KEY = "soapPanel"; // { id, mode }, per browser tab

let staff = null;
let panel = null;
let tab = null;
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
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
  if (tab) tab.hidden = true;
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

export async function showSoapPanel(recordId, { mode: wanted = "open" } = {}) {
  if (!recordId) return;
  ensureDom();
  if (current && current.id !== recordId && current.dirty &&
      !confirm("You have unsaved changes to the notes that are open. Discard them?")) return;

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
  document.body.appendChild(panel);

  tab = document.createElement("button");
  tab.type = "button";
  tab.className = "sp-tab";
  tab.hidden = true;
  document.body.appendChild(tab);

  tab.addEventListener("click", () => setMode("open"));
  panel.addEventListener("click", onClick);
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
  ta.style.height = `${Math.max(ta.scrollHeight, 72)}px`;
}

function autosizeAll() {
  if (panel) panel.querySelectorAll("textarea").forEach(autosize);
}

/* ===================== Loading ===================== */

async function load(id) {
  current = { id, data: null };
  updateTab();
  panel.innerHTML = `<div class="sp-loading"><div class="spinner"></div><p>Loading notes…</p></div>`;

  try {
    const snap = await getDoc(doc(db, "appointment_transcripts", id));
    if (!current || current.id !== id) return;
    if (!snap.exists()) throw new Error("This record no longer exists.");

    const data = snap.data();
    const parsed = parseSoap(data["Gemini SOAP"]);
    const original = {};
    SECTIONS.forEach((s) => { original[s.key] = parsed.sections[s.key] || ""; });

    current = { id, data, parsed, original, extras: parsed.extras.map((x) => ({ ...x })), dirty: false };
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ id, mode })); } catch { /* ignore */ }
    render();
    loadPersonalNotes();
  } catch (err) {
    if (!current || current.id !== id) return;
    console.error("Loading notes failed:", err);
    panel.innerHTML = `
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

  panel.innerHTML = `
    <div class="sp-head">
      <div class="sp-head-main">
        <p class="sp-eyebrow">Consultation notes</p>
        <h3>${escapeHtml(d["Patient Name"] || "Patient")}</h3>
        <p class="sp-meta">${escapeHtml(d["Record Date and Time"] || "")}${d["Staff Name"] ? ` · ${escapeHtml(d["Staff Name"])}` : ""}</p>
      </div>
      <span class="sp-status ${reviewed ? "is-reviewed" : "is-draft"}">${escapeHtml(reviewed ? "Reviewed" : status)}</span>
      <div class="sp-head-actions">
        <button type="button" class="sp-icon-btn" data-sp="max" title="${mode === "max" ? "Restore" : "Maximise"}" aria-label="Maximise">${mode === "max" ? ICONS.restore : ICONS.max}</button>
        <button type="button" class="sp-icon-btn" data-sp="min" title="Minimise" aria-label="Minimise">${ICONS.minimise}</button>
        <button type="button" class="sp-icon-btn" data-sp="close" title="Close" aria-label="Close">${ICONS.close}</button>
      </div>
    </div>

    <div class="sp-body">
      ${reviewed && d["Reviewed By"] ? `<p class="sp-banner ok">Reviewed by ${escapeHtml(d["Reviewed By"])}${d["Reviewed At"] ? ` on ${escapeHtml(stamp(new Date(d["Reviewed At"])))}` : ""}.</p>` : ""}
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
      <span class="sp-save-state">${saveStateText()}</span>
      <button type="button" class="btn-ghost" data-sp="save-draft">Save as Draft</button>
      <button type="button" class="btn-primary" data-sp="save-reviewed">Save as Reviewed</button>
    </div>`;

  if (!panel.hidden) requestAnimationFrame(autosizeAll);
}

function sectionHtml(s, value) {
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
  const soon = e.target.closest("[data-soon]");
  if (soon) { showToast(`${soon.dataset.soon}: coming soon`); return; }

  const btn = e.target.closest("[data-sp]");
  if (!btn) return;
  const action = btn.dataset.sp;

  if (action === "max") { setMode(mode === "max" ? "open" : "max"); if (current && current.data) refreshHeaderIcon(); }
  else if (action === "min") setMode("min");
  else if (action === "close") {
    if (hasUnsavedNotes() && !confirm("Close without saving your changes?")) return;
    closeSoapPanel();
  }
  else if (action === "save-draft") save("Draft", btn);
  else if (action === "save-reviewed") save("Reviewed", btn);
  else if (action === "save-note") saveNote(btn);
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

  // If the plan or email text changed, the recorder's structured sidecar would be out of date: drop it
  const changed = (k) => String(values[k] || "").trim() !== String(current.original[k] || "").trim();
  const keepSidecar = !changed("plan") && !changed("email");
  const soap = assembleSoap(current.parsed, values, extras, { keepSidecar });

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
    SECTIONS.forEach((s) => { current.original[s.key] = current.parsed.sections[s.key] || ""; });
    current.extras = current.parsed.extras.map((x) => ({ ...x }));
    current.dirty = false;
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
    const notes = snap.docs.map((x) => x.data())
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