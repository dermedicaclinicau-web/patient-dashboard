import { getPatient, updatePatient } from "./patients.js";
import { fetchDayAppointments } from "./appointments.js";
import {
  escapeHtml, getInitials, hueFromString, formatDobLong, calcAge,
  formatMobile, toTelHref, toDateKey, showToast,
} from "./utils.js";

/* ===================== Config ===================== */

const DOC_ACTIONS = [
  ["Consent record", "consent"],
  ["Treatment record", "treatment"],
  ["Prescription", "rx"],
  ["Skin script (SSP)", "ssp"],
  ["Summary", "summary"],
  ["General note", "note"],
  ["Personal note", "lock"],
];

const PRECONSULT_SECTIONS = [
  { key: "reminders", title: "Reminders", empty: "No reminders yet." },
  { key: "personal-notes", title: "Personal notes", empty: "No personal notes yet." },
  { key: "social-history", title: "Social history", empty: "No social history recorded." },
  { key: "past-appts", title: "Past appointments", empty: "No past appointments to show." },
  { key: "future-visits", title: "Future visits", empty: "No future visits to show." },
  { key: "packages", title: "Customer packages", empty: "No packages to show." },
  { key: "skin-script", title: "Skin script protocol", empty: "No protocol recorded." },
  { key: "treatment-plan", title: "Treatment plan", empty: "No treatment plan recorded." },
];

// Each inner array is one row; two items sit side by side
const VISIT_CATEGORIES = [
  ["Wrinkle Relaxer", "Filler / Radiesse"],
  ["HydraRepair / Skin Remodelling / Collagen Growth", "Other Injectables"],
  ["RestoraGlow / RF / DermaGlow / Skin Needling", "Collagen Activator"],
  ["Laser / OPL / Peel", "Firm / Ulthera / eST"],
  ["Body Sculpting"],
];

/* ===================== Icons ===================== */

const svg = (paths, cls = "") =>
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const FILE = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';

const ICONS = {
  back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  phone: svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  mail: svg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  sms: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  bell: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  consent: svg(FILE + '<polyline points="9 15 11 17 15 13"/>'),
  treatment: svg(FILE + '<line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>'),
  rx: svg('<path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>'),
  ssp: svg('<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>'),
  summary: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>'),
  note: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
  lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  chev: svg('<polyline points="6 9 12 15 18 9"/>', "sum-chev"),
};

/* ===================== Remember open/closed sections ===================== */

const OPEN_KEY = "pd-open-sections"; // layout preferences only, no patient data

function openState() {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY)) || {}; } catch { return {}; }
}
function isOpen(key, fallback) {
  const s = openState();
  return key in s ? s[key] : fallback;
}
function saveOpen(key, open) {
  const s = openState();
  s[key] = open;
  localStorage.setItem(OPEN_KEY, JSON.stringify(s));
}

/* ===================== Page ===================== */

export async function mountPatientDashboard(container, patientId, { staff, onBack } = {}) {
  // Own root element: if the user navigates away mid-load, root is detached
  // and late results are safely ignored.
  const root = document.createElement("section");
  root.className = "page wide patient-page";
  root.innerHTML = `<div class="patient-bar"><div class="skeleton sm"></div></div>`;
  container.replaceChildren(root);

  let patient = null;
  let todayAppts = [];
  let dialog, form, formError, saveBtn;

  root.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest(".back-btn, [data-action='back']")) { if (onBack) onBack(); return; }
    const soon = t.closest("[data-soon]");
    if (soon) { showToast(`${soon.dataset.soon}: coming soon`); return; }
    if (t.closest(".pb-edit")) { openEdit(); return; }
    if (t.closest("[data-close]")) { dialog.close(); }
  });

  // <details> "toggle" doesn't bubble, so listen in the capture phase
  root.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.matches && d.matches("details[data-key]")) saveOpen(d.dataset.key, d.open);
  }, true);

  try {
    patient = await getPatient(patientId);
  } catch (err) {
    console.error("Load patient failed:", err);
    if (root.isConnected) {
      root.innerHTML = stateHtml(
        "Couldn't load this patient",
        err.code === "permission-denied"
          ? "You don't have permission to view this patient."
          : "Check your connection and try again."
      );
    }
    return;
  }

  if (!root.isConnected) return;
  if (!patient) {
    root.innerHTML = stateHtml("Patient not found", "This patient record doesn't exist or may have been removed.");
    return;
  }

  root.innerHTML = `
    <div class="patient-bar"></div>

    <div>
      <p class="eyebrow">Clinical documentation</p>
      <div class="doc-tiles">
        ${DOC_ACTIONS.map(([label, icon]) =>
          `<button type="button" class="doc-tile" data-soon="${escapeHtml(label)}">${ICONS[icon]}<span>${escapeHtml(label)}</span></button>`
        ).join("")}
      </div>
    </div>

    ${preConsultHtml()}

    ${dialogHtml()}`;

  const bar = root.querySelector(".patient-bar");
  const todaySlot = root.querySelector(".today-slot");
  dialog = root.querySelector(".patient-dialog");
  form = dialog.querySelector("form");
  formError = dialog.querySelector(".form-error");
  saveBtn = dialog.querySelector("[type='submit']");

  function renderTop() {
    bar.innerHTML = barHtml(patient, todayAppts);
  }

  function openEdit() {
    const f = form.elements;
    form.reset();
    f.firstName.value = patient.firstName;
    f.lastName.value = patient.lastName;
    f.dobKey.value = patient.dobKey;
    f.dobKey.max = toDateKey();
    f.mobile.value = patient.mobile;
    f.email.value = patient.email;
    f.address.value = patient.address;
    f.pttId.value = patient.pttId || patient.id;
    formError.textContent = "";
    dialog.showModal();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form.elements;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    formError.textContent = "";
    try {
      const { changed } = await updatePatient(patient, {
        firstName: f.firstName.value,
        lastName: f.lastName.value,
        dobKey: f.dobKey.value,
        mobile: f.mobile.value,
        email: f.email.value,
        address: f.address.value,
      }, staff);

      if (changed) {
        patient = (await getPatient(patient.id)) || patient;
        renderTop();
        showToast("Patient details updated");
      } else {
        showToast("No changes to save");
      }
      dialog.close();
    } catch (err) {
      console.error("Update patient failed:", err);
      formError.textContent = err.code === "permission-denied"
        ? "You don't have permission to make this change."
        : err.code ? "Couldn't save changes. Please try again." : err.message;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save changes";
    }
  });

  renderTop();

  // Today's appointment: fills the highlight block AND the "Appt today" chip
  try {
    todayAppts = await loadTodayAppts(patient);
    if (!root.isConnected) return;
    todaySlot.innerHTML = todayHtml(todayAppts);
    renderTop();
  } catch (err) {
    if (!root.isConnected) return;
    console.error("Today's appointment failed:", err);
    const msg = err.code === "UNAUTHORIZED"
      ? "Session expired. Log out and back in to see today's appointments."
      : "Couldn't load today's appointments.";
    todaySlot.innerHTML = `<div class="today-empty error">${ICONS.calendar}<span>${msg}</span></div>`;
  }
}

/* ===================== Templates ===================== */

function show(value, display) {
  return value ? (display ?? escapeHtml(value)) : `<span class="missing">Not provided</span>`;
}

function roundLink(href, icon, label, missingMsg) {
  return href
    ? `<a class="round-btn" href="${escapeHtml(href)}" aria-label="${label}" title="${label}">${ICONS[icon]}</a>`
    : `<span class="round-btn is-disabled" aria-disabled="true" title="${missingMsg}">${ICONS[icon]}</span>`;
}

function barHtml(p, today = []) {
  const age = calcAge(p.dobKey);
  const dobText = formatDobLong(p.dobKey) || p.dob;
  const tel = toTelHref(p.mobile);

  const chips = [
    p.pttId && `<span class="chip">ID ${escapeHtml(p.pttId)}</span>`,
    age !== null && `<span class="chip">${age} yrs</span>`,
    today.length && `<span class="chip chip-today">Appt today ${escapeHtml(today[0].time || "")}</span>`,
  ].filter(Boolean).join("");

  return `
    <div class="pb-top">
      <button type="button" class="icon-btn back-btn" aria-label="Back" title="Back">${ICONS.back}</button>
      <span class="pb-avatar" style="--h:${hueFromString(p.name)}">${escapeHtml(getInitials(p.name))}</span>
      <div class="pb-main">
        <h2 class="pb-name serif">${escapeHtml(p.name)}</h2>
        ${chips ? `<div class="pb-chips">${chips}</div>` : ""}
      </div>
      <div class="pb-actions">
        ${roundLink(tel && `tel:${tel}`, "phone", "Call", "No mobile number on file")}
        ${roundLink(tel && `sms:${tel}`, "sms", "SMS", "No mobile number on file")}
        ${roundLink(p.email && `mailto:${p.email}`, "mail", "Email", "No email address on file")}
        <button type="button" class="round-btn" data-soon="Add reminder" aria-label="Add reminder" title="Add reminder">${ICONS.bell}</button>
        <button type="button" class="btn-ghost sm pb-edit">${ICONS.edit}<span>Edit</span></button>
      </div>
    </div>
    <dl class="pb-details">
      <div><dt>Date of birth</dt><dd>${show(dobText)}</dd></div>
      <div><dt>Mobile</dt><dd>${show(p.mobile, escapeHtml(formatMobile(p.mobile)))}</dd></div>
      <div><dt>Email</dt><dd>${show(p.email)}</dd></div>
      <div><dt>Address</dt><dd>${show(p.address)}</dd></div>
    </dl>`;
}

function subCard(key, title, body, { hint = "", open = false, extraClass = "" } = {}) {
  return `
    <details class="sub-card ${extraClass}" data-key="${escapeHtml(key)}" ${isOpen(key, open) ? "open" : ""}>
      <summary>
        <span>${escapeHtml(title)}</span>
        <span class="sum-right">${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ""}${ICONS.chev}</span>
      </summary>
      <div class="sub-body">${body}</div>
    </details>`;
}

function preConsultHtml() {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const sections = PRECONSULT_SECTIONS.map((s) =>
    subCard(s.key, s.title, `<p class="empty-note">${escapeHtml(s.empty)}</p>`, { hint: "Soon" })
  ).join("");

  const visits = VISIT_CATEGORIES.flatMap((row) =>
    row.map((cat) =>
      subCard(`visit-${slug(cat)}`, cat, `<p class="empty-note">No recent visits in this category.</p>`, {
        hint: "Soon",
        extraClass: row.length === 1 ? "full" : "",
      })
    )
  ).join("");

  return `
    <details class="section-card" data-key="preconsult" ${isOpen("preconsult", true) ? "open" : ""}>
      <summary><span class="section-title serif">Pre-consultation</span>${ICONS.chev}</summary>
      <div class="section-body">
        <div class="today-slot"><div class="skeleton sm"></div></div>
        <div class="pc-grid">${sections}</div>
        <p class="eyebrow pc-sub">Recent visits by category</p>
        <div class="pc-grid pairs">${visits}</div>
      </div>
    </details>`;
}

function todayHtml(list) {
  if (!list.length) {
    return `<div class="today-empty">${ICONS.calendar}<span>Today's appointment: no scheduled appointments today</span></div>`;
  }
  return list.map((a) => {
    const services = (a.services || []).map(escapeHtml).join(", ");
    return `
      <div class="today-appt">
        <div class="ta-time">Today · ${escapeHtml(a.time || "")}</div>
        <div class="ta-info"><strong>${escapeHtml(a.staff || "")}</strong>${services ? ` · ${services}` : ""}</div>
      </div>`;
  }).join("");
}

function dialogHtml() {
  return `
    <dialog class="dialog wide-dialog patient-dialog">
      <form class="dialog-body">
        <h2 class="serif">Edit patient details</h2>
        <div class="field-grid">
          <label class="field"><span>First name</span><input name="firstName" required maxlength="60" /></label>
          <label class="field"><span>Last name</span><input name="lastName" required maxlength="60" /></label>
          <label class="field"><span>Date of birth</span><input name="dobKey" type="date" /></label>
          <label class="field"><span>Mobile</span><input name="mobile" type="tel" maxlength="20" /></label>
          <label class="field full"><span>Email</span><input name="email" type="email" maxlength="120" /></label>
          <label class="field full"><span>Address</span><input name="address" maxlength="200" /></label>
          <label class="field full"><span>Patient ID (can't be changed)</span><input name="pttId" disabled /></label>
        </div>
        <p class="form-error" role="alert"></p>
        <div class="dialog-actions">
          <button type="button" class="btn-ghost" data-close>Cancel</button>
          <button type="submit" class="btn-primary">Save changes</button>
        </div>
      </form>
    </dialog>`;
}

function stateHtml(title, msg) {
  return `<div class="state"><strong>${escapeHtml(title)}</strong>${escapeHtml(msg)}<br>
    <button type="button" class="btn-ghost sm retry" data-action="back">Go back</button></div>`;
}

/* ===================== Data ===================== */

async function loadTodayAppts(patient) {
  const data = await fetchDayAppointments(toDateKey());
  const ids = [patient.pttId, patient.id].filter(Boolean).map((s) => s.toLowerCase());
  const name = patient.name.toLowerCase();

  return (data.appointments || [])
    .filter((a) => a.patientId
      ? ids.includes(a.patientId.toLowerCase())
      : (a.patientName || "").toLowerCase() === name) // name fallback only when the row has no ID
    .sort((a, b) => a.sortMinutes - b.sortMinutes);
}