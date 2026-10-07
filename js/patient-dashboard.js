import { getPatient, updatePatient } from "./patients.js";
import { fetchDayAppointments } from "./appointments.js";
import {
  escapeHtml, getInitials, hueFromString, formatDobLong, calcAge,
  formatMobile, toTelHref, toDateKey, showToast,
} from "./utils.js";

/* ===================== Config ===================== */

const CLINICAL_ACTIONS = [
  ["Create Consent Records", "doc"],
  ["Create Tx Record", "doc"],
  ["Create Rx Record", "doc"],
  ["Create SSP", "doc"],
  ["Create Summary", "doc"],
  ["Add General Notes", "note"],
  ["Add Personal Notes", "note"],
];

// key, title, empty message, open by default
const PRECONSULT_SECTIONS = [
  { key: "reminders", title: "Reminders", empty: "No reminders yet.", open: true },
  { key: "today", title: "Today's Appointment", open: true },
  { key: "personal-notes", title: "Personal Notes", empty: "No personal notes yet.", open: true },
  { key: "social-history", title: "Social History", empty: "No social history recorded." },
  { key: "past-appts", title: "Past Appointments", empty: "No past appointments to show." },
  { key: "recent-visits", title: "Recent Visits by Category" },
  { key: "future-visits", title: "Future Visits", empty: "No future visits to show." },
  { key: "packages", title: "Customer Packages", empty: "No packages to show." },
  { key: "skin-script", title: "Skin Script Protocol", empty: "No protocol recorded." },
  { key: "treatment-plan", title: "Treatment Plan", empty: "No treatment plan recorded." },
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
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
  back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  phone: svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  mail: svg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  sms: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  bell: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  doc: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>'),
  note: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
  chev: svg('<polyline points="6 9 12 15 18 9"/>', "sum-chev"),
};

/* ===================== Remember open/closed sections ===================== */

const OPEN_KEY = "pd-open-sections"; // stores layout preferences only, no patient data

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
  // and the late result is safely ignored.
  const root = document.createElement("section");
  root.className = "page wide patient-page";
  root.innerHTML = `<div class="patient-bar"><div class="skeleton sm" style="flex:1"></div></div>`;
  container.replaceChildren(root);

  let patient = null;
  let dialog, form, formError, saveBtn;

  // One click handler for the whole page
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

    <div class="action-groups">
      <div class="action-group">
        <h3 class="ag-title">Communication</h3>
        <div class="ag-buttons comm-buttons"></div>
      </div>
      <div class="action-group">
        <h3 class="ag-title">Clinical Documentation</h3>
        <div class="ag-buttons">
          ${CLINICAL_ACTIONS.map(([label, icon]) =>
            `<button type="button" class="action-btn" data-soon="${escapeHtml(label)}">${ICONS[icon]}<span>${escapeHtml(label)}</span></button>`
          ).join("")}
        </div>
      </div>
    </div>

    ${preConsultHtml()}

    ${dialogHtml()}`;

  const bar = root.querySelector(".patient-bar");
  const comm = root.querySelector(".comm-buttons");
  dialog = root.querySelector(".patient-dialog");
  form = dialog.querySelector("form");
  formError = dialog.querySelector(".form-error");
  saveBtn = dialog.querySelector("[type='submit']");

  function renderTop() {
    bar.innerHTML = barHtml(patient);
    comm.innerHTML = commHtml(patient);
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
  loadTodayAppt(root.querySelector(".today-slot"), patient);
}

/* ===================== Templates ===================== */

function show(value, display) {
  return value ? (display ?? escapeHtml(value)) : `<span class="missing">Not provided</span>`;
}

function barHtml(p) {
  const dobText = formatDobLong(p.dobKey) || p.dob;
  const age = calcAge(p.dobKey);
  const dobHtml = dobText
    ? `${escapeHtml(dobText)}${age !== null ? ` <span class="pb-age">(${age} yrs)</span>` : ""}`
    : "";

  return `
    <button type="button" class="icon-btn back-btn" aria-label="Back" title="Back">${ICONS.back}</button>
    <div class="pb-identity">
      <span class="p-avatar lg" style="--h:${hueFromString(p.name)}">${escapeHtml(getInitials(p.name))}</span>
      <div>
        <h2 class="pb-name">${escapeHtml(p.name)}</h2>
        ${p.pttId ? `<span class="pb-id">ID ${escapeHtml(p.pttId)}</span>` : ""}
      </div>
    </div>
    <dl class="pb-details">
      <div><dt>DOB</dt><dd>${show(dobText, dobHtml)}</dd></div>
      <div><dt>Address</dt><dd>${show(p.address)}</dd></div>
      <div><dt>Email</dt><dd>${show(p.email)}</dd></div>
      <div><dt>Mobile</dt><dd>${show(p.mobile, escapeHtml(formatMobile(p.mobile)))}</dd></div>
    </dl>
    <button type="button" class="btn-ghost sm pb-edit">${ICONS.edit}<span>Edit</span></button>`;
}

function commHtml(p) {
  const tel = toTelHref(p.mobile);
  const link = (href, icon, label, missingMsg) => href
    ? `<a class="action-btn" href="${escapeHtml(href)}">${ICONS[icon]}<span>${label}</span></a>`
    : `<span class="action-btn is-disabled" aria-disabled="true" title="${missingMsg}">${ICONS[icon]}<span>${label}</span></span>`;

  return link(tel && `tel:${tel}`, "phone", "Call", "No mobile number on file")
    + link(p.email && `mailto:${p.email}`, "mail", "Email", "No email address on file")
    + link(tel && `sms:${tel}`, "sms", "SMS", "No mobile number on file")
    + `<button type="button" class="action-btn" data-soon="Add Reminder">${ICONS.bell}<span>Add Reminder</span></button>`;
}

function subCard(key, title, body, { soon = false, open = false, extraClass = "" } = {}) {
  return `
    <details class="sub-card ${extraClass}" data-key="${escapeHtml(key)}" ${isOpen(key, open) ? "open" : ""}>
      <summary>
        <span class="sum-title">${escapeHtml(title)}${soon ? `<span class="tag">Coming soon</span>` : ""}</span>
        ${ICONS.chev}
      </summary>
      <div class="sub-body">${body}</div>
    </details>`;
}

function preConsultHtml() {
  const blocks = PRECONSULT_SECTIONS.map((s) => {
    if (s.key === "today") {
      return subCard(s.key, s.title, `<div class="today-slot"><div class="skeleton sm"></div></div>`, { open: s.open });
    }
    if (s.key === "recent-visits") {
      return subCard(s.key, s.title, visitGridHtml(), { soon: true, open: s.open });
    }
    return subCard(s.key, s.title, `<p class="empty-note">${escapeHtml(s.empty)}</p>`, { soon: true, open: s.open });
  }).join("");

  return `
    <details class="section-card" data-key="preconsult" ${isOpen("preconsult", true) ? "open" : ""}>
      <summary><span class="sum-title">Pre-Consultation Information</span>${ICONS.chev}</summary>
      <div class="section-body">${blocks}</div>
    </details>`;
}

function visitGridHtml() {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const cards = VISIT_CATEGORIES.flatMap((row) =>
    row.map((cat) =>
      subCard(`visit-${slug(cat)}`, cat, `<p class="empty-note">No recent visits in this category.</p>`, {
        extraClass: row.length === 1 ? "full" : "",
      })
    )
  ).join("");
  return `<div class="visit-grid">${cards}</div>`;
}

function dialogHtml() {
  return `
    <dialog class="dialog wide-dialog patient-dialog">
      <form class="dialog-body">
        <h2>Edit patient details</h2>
        <div class="field-grid">
          <label class="field"><span>First name</span><input name="firstName" required maxlength="60" /></label>
          <label class="field"><span>Last name</span><input name="lastName" required maxlength="60" /></label>
          <label class="field"><span>Date of birth</span><input name="dobKey" type="date" /></label>
          <label class="field"><span>Mobile</span><input name="mobile" type="tel" maxlength="20" /></label>
          <label class="field full"><span>Email</span><input name="email" type="email" maxlength="120" /></label>
          <label class="field full"><span>Address</span><input name="address" maxlength="200" /></label>
          <label class="field full"><span>Patient ID (cannot be changed)</span><input name="pttId" disabled /></label>
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

/* ===================== Today's appointment ===================== */

async function loadTodayAppt(slot, patient) {
  try {
    const data = await fetchDayAppointments(toDateKey());
    if (!slot.isConnected) return;

    const ids = [patient.pttId, patient.id].filter(Boolean).map((s) => s.toLowerCase());
    const name = patient.name.toLowerCase();

    const mine = (data.appointments || [])
      .filter((a) => a.patientId
        ? ids.includes(a.patientId.toLowerCase())
        : (a.patientName || "").toLowerCase() === name) // fallback only when the row has no ID
      .sort((a, b) => a.sortMinutes - b.sortMinutes);

    slot.innerHTML = mine.length
      ? mine.map(todayCard).join("")
      : `<p class="empty-note">No scheduled appointments today.</p>`;
  } catch (err) {
    if (!slot.isConnected) return;
    console.error("Today's appointment failed:", err);
    slot.innerHTML = `<p class="empty-note error">${
      err.code === "UNAUTHORIZED"
        ? "Session expired. Log out and back in to see today's appointments."
        : "Couldn't load today's appointments."
    }</p>`;
  }
}

function todayCard(a) {
  const services = (a.services || []).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  return `
    <div class="today-appt">
      <div class="ta-time">${escapeHtml(a.timeRange || a.time || "")}</div>
      <div class="ta-info">
        <strong>${escapeHtml(a.staff || "")}</strong>
        ${services ? `<ul>${services}</ul>` : ""}
      </div>
    </div>`;
}