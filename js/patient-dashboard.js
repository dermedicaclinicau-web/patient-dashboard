import { getPatient, updatePatient } from "./patients.js";
import { fetchDayAppointments, fetchPreconsult } from "./appointments.js";
import { fetchOpenReminders } from "./reminders.js";
import { skincareSectionHtml, mountSkincare } from "./skincare-view.js";
import { recordsSectionHtml, mountRecords } from "./records-view.js";
import {
  fetchTranscriptRecords, latestTreatmentPlan, socialHistoryEntries, toBullets, allTreatmentPlans,
  parseTimeline,
} from "./transcripts.js";
import {
  escapeHtml, getInitials, hueFromString, formatDobLong, calcAge,
  formatMobile, toTelHref, toDateKey, showToast, formatUpdated,
  parseDateKey, formatShortDate,
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

// Order and look of the Pre-Consultation section.
// field = pcn_results column | unit = pill wording ("one|many", or "value" to show the value itself)
// tone = colour style | action = [button label, "coming soon" name]
const PRECONSULT_SECTIONS = [
  { key: "reminders", title: "Reminders", icon: "bell", custom: true },
  { key: "today", today: true },
  { key: "personal-notes", title: "Personal notes", icon: "pin", pill: "No record",
    empty: "No personal notes on record.", action: ["+ Add", "Add personal note"] },
  { key: "social-history", title: "Social history", icon: "user", custom: true,
    remember: false }, // always starts collapsed
  { key: "past-appts", title: "Past appointments", icon: "clock", field: "other", unit: "visit|visits", tone: "green" },
  { key: "recent-visits", visits: true },
  { key: "future-visits", title: "Future visits", icon: "calendar", field: "futureVisits", unit: "visit|visits", tone: "purple" },
  //{ key: "overdue", title: "Overdue treatments", icon: "alert", field: "overdue", unit: "overdue|overdue", tone: "red" },
  { key: "packages", title: "Customer packages", icon: "box", field: "packages", unit: "active|active" },
  { key: "skin-script", title: "Skin script protocol", icon: "file", field: "skinScriptDate", unit: "value",
    action: ["Create new SSP", "Create new SSP"] },
  { key: "treatment-plan", title: "Treatment plan", icon: "check", custom: true, tone: "purple",
    remember: false }, // always starts collapsed
];

// Each inner array is one row; two items sit side by side
const VISIT_CATEGORIES = [
  [{ title: "Wrinkle Relaxer", field: "wrinkleRelaxer", color: "mint" },
   { title: "Filler / Radiesse", field: "fillerRadiesse", color: "blue" }],
  [{ title: "Hydra Repair / Skin Remodelling / Collagen Growth", field: "hydraRepair", color: "pink" },
   { title: "Other Injectables", field: "otherInjectables", color: "grey" }],
  [{ title: "RestoraGlow / RF / DermaGlow / Skin Needling", field: "restoraGlow", color: "lavender" },
   { title: "Collagen Activator", field: "collagenActivator", color: "cream" }],
  [{ title: "Laser / OPL / Peel", field: "laserOplPeel", color: "peach" },
   { title: "Firm / Ulthera / eST", field: "firmUlthera", color: "tan" }],
  [{ title: "Body Sculpting", field: "bodySculpting", color: "rose" }],
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
  pin: svg('<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>'),
  user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
  alert: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  box: svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>'),
  file: svg(FILE + '<line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  check: svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  refresh: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  chevRight: svg('<polyline points="9 18 15 12 9 6"/>'),
  route: svg('<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>'),
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
  let preData = null;
  let dialog, form, formError, saveBtn;

  root.addEventListener("click", (e) => {
    const t = e.target;
    // Buttons inside a section header must not also open/close that section
    if (t.closest("summary button")) e.preventDefault();
    const refreshBtn = t.closest("[data-action='refresh-pc']");
    if (refreshBtn) { refreshAll(refreshBtn); return; }
    if (t.closest(".back-btn, [data-action='back']")) { if (onBack) onBack(); return; }
    const planToggle = t.closest("[data-action='toggle-plan']");
    if (planToggle) {
      const block = planToggle.closest(".plan-block");
      const expanded = block.classList.toggle("expanded");
      planToggle.querySelector("span").textContent = expanded ? "Show less" : "View full plan";
      return;
    }
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

    ${treatmentPlansSectionHtml()}
    
    ${skincareSectionHtml()}
    
    ${recordsSectionHtml()}

    ${dialogHtml()}`;

  const bar = root.querySelector(".patient-bar");
  const todaySlot = root.querySelector(".today-slot");
  dialog = root.querySelector(".patient-dialog");
  form = dialog.querySelector("form");
  formError = dialog.querySelector(".form-error");
  saveBtn = dialog.querySelector("[type='submit']");

  function renderTop() {
    bar.innerHTML = barHtml(patient, todayAppts, preData);
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

  // Load everything in parallel
  loadToday();
  loadPreconsultData();
  loadReminders();
  loadTranscriptSections();
  mountSkincare(root, patient);
  mountRecords(root, patient);

  // Treatment plan + Social history, both from appointment_transcripts (fetched once)
  async function loadTranscriptSections() {
    const planCard = root.querySelector('details[data-key="treatment-plan"]');
    const socialCard = root.querySelector('details[data-key="social-history"]');
    const cards = [planCard, socialCard].filter(Boolean);
    if (!cards.length) return;

    try {
      const records = await fetchTranscriptRecords(patient);
      if (!root.isConnected) return;

      if (planCard) {
        const latest = latestTreatmentPlan(records);
        fillCard(planCard,
          latest ? "On file" : "No record",
          latest ? treatmentPlanHtml(latest) : `<p class="empty-note">No treatment plan on record.</p>`,
          !latest);
      }

      if (socialCard) {
        const entries = socialHistoryEntries(records);
        fillCard(socialCard,
          entries.length ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}` : "None recorded",
          entries.length ? socialHistoryHtml(entries) : `<p class="empty-note">No social history recorded.</p>`,
          !entries.length);
      }

      renderTreatmentPlans(root, records);
    } catch (err) {
      if (!root.isConnected) return;
      console.error("Transcript sections failed:", err);
      const tpBody = root.querySelector(".tp-body");
      if (tpBody) tpBody.innerHTML = `<p class="empty-note error">Couldn't load treatment plans.</p>`;
      const msg = err.code === "permission-denied"
        ? "Consultation records aren't accessible. Check the Firestore rules."
        : "Couldn't load consultation records.";
      cards.forEach((c) => fillCard(c, "—", `<p class="empty-note error">${msg}</p>`, false));
    }
  }

  function fillCard(card, pill, html, isEmpty) {
    card.querySelector(".hint").textContent = pill;
    card.querySelector(".sub-body").innerHTML = html;
    card.classList.toggle("is-empty", isEmpty);
  }

  // Refresh button: reload all pre-consultation data in place
  async function refreshAll(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("is-loading");
    await Promise.allSettled([loadToday(), loadPreconsultData(), loadReminders(), loadTranscriptSections()]);
    if (btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }

  // Reminders from Firestore 'staff-task-list' (open/not completed only)
  async function loadReminders() {
    const card = root.querySelector('details[data-key="reminders"]');
    if (!card) return;
    const hint = card.querySelector(".hint");
    const body = card.querySelector(".sub-body");

    try {
      const tasks = await fetchOpenReminders(patient);
      if (!root.isConnected) return;

      hint.textContent = `${tasks.length} pending`;
      body.innerHTML = tasks.length
        ? remindersHtml(tasks)
        : `<p class="empty-note">No pending reminders for this patient.</p>`;
      card.classList.toggle("is-empty", !tasks.length);
      card.open = tasks.length > 0; // open when there's something to see, collapsed when empty
    } catch (err) {
      if (!root.isConnected) return;
      console.error("Reminders failed:", err);
      hint.textContent = "—";
      body.innerHTML = `<p class="empty-note error">${
        err.code === "permission-denied"
          ? "Reminders aren't accessible. Check the Firestore rules."
          : "Couldn't load reminders."
      }</p>`;
    }
  }

  // Today's appointment: fills the highlight block AND the "Appt today" chip
  async function loadToday() {
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
      todaySlot.innerHTML = todayHtml([], msg);
    }
  }

  // Pre-consultation data from pcn_results
  async function loadPreconsultData() {
    try {
      const res = await fetchPreconsult(patient);
      if (!root.isConnected) return;
      preData = res.found ? res.data : null;
      fillPreconsult(root, preData, res.lastUpdated);
      renderTop();
    } catch (err) {
      if (!root.isConnected) return;
      console.error("Pre-consultation load failed:", err);
      fillPreconsultError(root, err);
    }
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

function barHtml(p, today = [], pre = null) {
  const age = calcAge(p.dobKey);
  const dobText = formatDobLong(p.dobKey) || p.dob;
  const tel = toTelHref(p.mobile);

  const chips = [
    p.pttId && `<span class="chip">ID ${escapeHtml(p.pttId)}</span>`,
    today.length && `<span class="chip chip-today">Appt today ${escapeHtml(today[0].time || "")}</span>`,
    pre && pre.overdue && `<span class="chip chip-alert">Overdue treatments</span>`,
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
      <div><dt>Date of birth</dt><dd>${show(dobText, `${escapeHtml(dobText)}${age !== null ? ` <span class="pb-age">(${age} yrs)</span>` : ""}`)}</dd></div>
      <div><dt>Mobile</dt><dd>${show(p.mobile, escapeHtml(formatMobile(p.mobile)))}</dd></div>
      <div><dt>Email</dt><dd>${show(p.email)}</dd></div>
      <div><dt>Address</dt><dd>${show(p.address)}</dd></div>
    </dl>`;
}

function subCard({ key, title, icon = "", body = "", pill = "", tone = "", action = null,
                   field = "", unit = "", extraClass = "", open = false, remember = true }) {
  return `
    <details class="sub-card ${tone ? `tone-${tone}` : ""} ${extraClass}" data-key="${escapeHtml(key)}"${
      field ? ` data-field="${escapeHtml(field)}"` : ""}${unit ? ` data-unit="${escapeHtml(unit)}"` : ""} ${
      (remember ? isOpen(key, open) : open) ? "open" : ""}>
      <summary>
        <span class="sum-left">
          ${icon ? `<span class="sum-icon">${ICONS[icon]}</span>` : ""}
          <span class="sum-label">${escapeHtml(title)}</span>
          <span class="hint"${pill ? "" : " hidden"}>${escapeHtml(pill)}</span>
        </span>
        <span class="sum-right">
          ${action ? `<button type="button" class="sum-action" data-soon="${escapeHtml(action[1])}">${escapeHtml(action[0])}</button>` : ""}
          ${ICONS.chev}
        </span>
      </summary>
      <div class="sub-body">${body}</div>
    </details>`;
}

function preConsultHtml() {
  const loading = `<div class="skeleton xs"></div>`;

  const blocks = PRECONSULT_SECTIONS.map((s) => {
    if (s.today) return `<div class="today-slot">${todayHtml(null)}</div>`;
    if (s.visits) return visitsHtml();
    const loads = s.field || s.custom;
    return subCard({
      key: s.key, title: s.title, icon: s.icon, tone: s.tone, action: s.action,
      field: s.field, unit: s.unit, remember: s.remember !== false,
      pill: loads ? "…" : s.pill,
      body: loads ? loading : `<p class="empty-note">${escapeHtml(s.empty)}</p>`,
    });
  }).join("");

  return `
    <details class="section-card pc-card" data-key="preconsult" ${isOpen("preconsult", true) ? "open" : ""}>
      <summary>
        <span class="pc-head">${ICONS.chev}<span class="pc-title">Pre-Consultation Information</span><span class="pc-updated"></span></span>
        <button type="button" class="pc-refresh" data-action="refresh-pc">${ICONS.refresh}<span>Refresh</span></button>
      </summary>
      <div class="section-body pc-body">${blocks}</div>
    </details>`;
}

function visitsHtml() {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const cards = VISIT_CATEGORIES.flatMap((row) =>
    row.map((c) => subCard({
      key: `visit-${slug(c.title)}`, title: c.title, tone: c.color,
      field: c.field, unit: "visit|visits", extraClass: "visit-card",
      body: `<div class="skeleton xs"></div>`,
    }))
  ).join("");

  return `
    <div class="visits-block">
      <p class="visits-label">${ICONS.layers}<span>Recent visits by category</span></p>
      <div class="pc-grid pairs">${cards}</div>
    </div>`;
}

// list: null = loading, [] = none, [..] = appointments. errorMsg shows an error state.
function todayHtml(list, errorMsg = "") {
  let text;
  if (errorMsg) text = escapeHtml(errorMsg);
  else if (list === null) text = "Loading…";
  else if (!list.length) text = "No scheduled appointments today";
  else {
    text = list.map((a) =>
      [a.time, a.staff, (a.services || []).join(", ")].filter(Boolean).map(escapeHtml).join(" · ")
    ).join("<br>");
  }

  return `
    <div class="today-card${errorMsg ? " error" : ""}">
      <span class="today-icon">${ICONS.calendar}</span>
      <div>
        <p class="today-label">Today's appointment</p>
        <p class="today-text">${text}</p>
      </div>
    </div>`;
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

/* ===================== Pre-consultation data ===================== */

// A cell with several entries on separate lines becomes a list
function toLines(value) {
  return String(value || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Pill wording per section: "3 visits", "0 overdue", "1 active", or the value itself
function pillText(lines, unit) {
  if (unit === "value") {
    if (!lines.length) return "No record";
    return lines.length === 1 && lines[0].length <= 22 ? lines[0] : `${lines.length} records`;
  }
  const [one, many] = (unit || "entry|entries").split("|");
  return `${lines.length} ${lines.length === 1 ? one : many}`;
}

function valueHtml(lines) {
  if (lines.length === 1) return `<p class="pc-value">${escapeHtml(lines[0])}</p>`;
  return `<ul class="pc-list">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
}

function fillPreconsult(root, data, lastUpdated) {
  const updated = root.querySelector(".pc-updated");
  if (updated) updated.textContent = lastUpdated ? `Updated ${formatUpdated(new Date(lastUpdated))}` : "";

  root.querySelectorAll("details[data-field]").forEach((d) => {
    const lines = toLines(data ? data[d.dataset.field] : "");
    const hint = d.querySelector(".hint");
    hint.textContent = pillText(lines, d.dataset.unit);
    // Category bars only show a count when there's something in them
    hint.hidden = d.classList.contains("visit-card") && !lines.length;

    d.querySelector(".sub-body").innerHTML = lines.length
      ? valueHtml(lines)
      : `<p class="empty-note">${data ? "Nothing recorded." : "No pre-consultation record found for this patient."}</p>`;
    d.classList.toggle("is-empty", !lines.length);
  });
}

function fillPreconsultError(root, err) {
  const msg = err.code === "UNAUTHORIZED"
    ? "Session expired. Log out and back in to load this."
    : "Couldn't load pre-consultation data.";
  root.querySelectorAll("details[data-field]").forEach((d) => {
    const hint = d.querySelector(".hint");
    hint.textContent = "—";
    hint.hidden = false;
    d.querySelector(".sub-body").innerHTML = `<p class="empty-note error">${msg}</p>`;
  });
}

/* ===================== Reminders ===================== */

function remindersHtml(tasks) {
  const today = toDateKey();

  return `<ul class="task-list">${tasks.map((t) => {
    const dueKey = String(t.dueDate || "").trim();
    const due = parseDateKey(dueKey);
    const overdue = !!due && dueKey < today;
    const status = String(t.status || "").trim();

    const meta = [
      due ? `Due ${formatShortDate(due)}` : (dueKey ? `Due ${dueKey}` : "No due date"),
      t.createdBy ? `Added by ${t.createdBy}` : "",
    ].filter(Boolean).map(escapeHtml).join(" · ");

    const flags =
      (overdue ? `<span class="task-flag">Overdue</span>` : "") +
      (status && status.toLowerCase() !== "open" ? `<span class="task-flag neutral">${escapeHtml(status)}</span>` : "");

    return `
      <li class="task${overdue ? " is-overdue" : ""}">
        <span class="task-text">${escapeHtml(t.taskText || "Untitled reminder")}</span>
        <span class="task-meta">${meta}${flags}</span>
      </li>`;
  }).join("")}</ul>`;
}

/* ===================== Treatment plan ===================== */

function treatmentPlanHtml(p) {
  const dateText = p.date
    ? `${p.date.getDate()} ${p.date.toLocaleString("en-AU", { month: "long" })} ${p.date.getFullYear()}`
    : p.dateText;
  const isLong = p.plan.length > 450 || p.plan.split(/\n/).length > 6;

  return `
    <div class="plan-block">
      <div class="plan-head">
        <span class="plan-date">Most recent${dateText ? ` — ${escapeHtml(dateText)}` : ""}</span>
        ${isLong ? `<button type="button" class="plan-toggle" data-action="toggle-plan">${ICONS.chevRight}<span>View full plan</span></button>` : ""}
      </div>
      <div class="plan-text"><div class="plan-clamp">${escapeHtml(p.plan)}</div></div>
      <div class="plan-meta">
        ${p.staff ? `<span>By ${escapeHtml(p.staff)}</span>` : ""}
        ${p.matchedByName ? `<span class="task-flag neutral">Matched by name</span>` : ""}
      </div>
    </div>`;
}

/* ===================== Social history ===================== */

// "Aug 13, 2026"
function shortDate(r) {
  if (!r.date) return r.dateText || "Undated";
  return `${r.date.toLocaleString("en-US", { month: "short" })} ${r.date.getDate()}, ${r.date.getFullYear()}`;
}

function socialHistoryHtml(entries) {
  return `<div class="sh-list">${entries.map((e) => {
    const bullets = toBullets(e.text);
    return `
      <div class="sh-entry">
        <p class="sh-head">
          <span class="sh-date">${escapeHtml(shortDate(e))}</span>
          <span class="sh-sep">—</span>
          <span>Social history</span>
          ${e.staff ? `<span class="sh-staff">· ${escapeHtml(e.staff)}</span>` : ""}
          ${e.matchedByName ? `<span class="task-flag neutral">Matched by name</span>` : ""}
        </p>
        <ul class="pc-list">${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
      </div>`;
  }).join("")}</div>`;
}

/* ===================== Treatment Plan section ===================== */

function treatmentPlansSectionHtml() {
  return `
    <details class="section-card tp-card" data-key="tp-section" ${isOpen("tp-section", true) ? "open" : ""}>
      <summary>
        <span class="pc-head">${ICONS.chev}<span class="pc-title">Treatment Plan</span><span class="hint tp-count">…</span></span>
      </summary>
      <div class="section-body tp-body"><div class="skeleton sm"></div></div>
    </details>`;
}

function renderTreatmentPlans(root, records) {
  const section = root.querySelector('details[data-key="tp-section"]');
  if (!section) return;

  const plans = allTreatmentPlans(records);
  section.querySelector(".tp-count").textContent = plans.length
    ? `${plans.length} ${plans.length === 1 ? "plan" : "plans"}`
    : "No record";

  const body = section.querySelector(".tp-body");
  if (!plans.length) {
    body.innerHTML = `<p class="empty-note">No treatment plans on record.</p>`;
    return;
  }

  // Group by record date (records are already newest first)
  const groups = new Map();
  plans.forEach((p) => {
    const key = p.date ? toDateKey(p.date) : `undated-${p.dateText}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  body.innerHTML = [...groups.values()].map((g, i) => planGroupHtml(g, i === 0)).join("");
}

function planGroupHtml(group, isLatest) {
  const first = group[0];
  const dateText = first.date ? formatShortDate(first.date) : (first.dateText || "Undated");
  const staff = [...new Set(group.map((p) => p.staff).filter(Boolean))].join(", ");
  const concerns = group.reduce((n, p) => n + p.parsed.concerns.length, 0);
  const pill = concerns ? `${concerns} ${concerns === 1 ? "concern" : "concerns"}` : "Review";

  return `
    <details class="tp-record" ${isLatest ? "open" : ""}>
      <summary>
        <span class="sum-left">
          <span class="tp-date">${escapeHtml(dateText)}</span>
          ${staff ? `<span class="tp-by">${escapeHtml(staff)}</span>` : ""}
          <span class="hint">${pill}</span>
          ${isLatest ? `<span class="tp-latest">Latest</span>` : ""}
          ${group.some((p) => p.matchedByName) ? `<span class="task-flag neutral">Matched by name</span>` : ""}
        </span>
        ${ICONS.chev}
      </summary>
      <div class="tp-record-body">${group.map(planBodyHtml).join("")}</div>
    </details>`;
}

function planBodyHtml(p) {
  const { intro, concerns, timeline } = p.parsed;

  // Unstructured plans (e.g. "REVIEW OF EXISTING PLAN") show as a clean note
  if (!concerns.length && !timeline.length) {
    return `<div class="tp-note">${escapeHtml(p.plan)}</div>`;
  }

  return `
    ${intro.length ? `<div class="tp-note">${intro.map(escapeHtml).join("<br>")}</div>` : ""}
    ${concerns.map(concernHtml).join("")}
    ${timeline.length ? timelineHtml(timeline) : ""}`;
}

function fieldHtml(lines) {
  if (!lines.length) return `<span class="missing">—</span>`;
  if (lines.length === 1) return escapeHtml(lines[0]);
  return `<ul class="pc-list">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
}

function concernHtml(c) {
  return `
    <article class="concern">
      <header class="concern-head">
        ${c.letter ? `<span class="concern-badge">${escapeHtml(c.letter)}</span>` : ""}
        <div class="concern-titles">
          <h4>${escapeHtml(c.title || "Concern")}</h4>
          ${c.description.length ? `<p>${c.description.map(escapeHtml).join(" ")}</p>` : ""}
        </div>
        ${c.area.length ? `<span class="concern-area">${escapeHtml(c.area.join(", "))}</span>` : ""}
      </header>
      <dl class="concern-grid">
        <div><dt>Treatment</dt><dd>${fieldHtml(c.treatment)}</dd></div>
        <div><dt>Frequency / interval</dt><dd>${fieldHtml(c.frequency)}</dd></div>
        <div><dt>Quote</dt><dd>${fieldHtml(c.quote)}</dd></div>
        <div class="full"><dt>Comments</dt><dd>${fieldHtml(c.comments)}</dd></div>
      </dl>
    </article>`;
}

// "August 2026" -> "Aug 2026" (other labels unchanged)
function shortMonth(label) {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(label || "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}` : (label || "");
}

// [1] -> "visit 1", [1, 4] -> "visits 1 and 4", [1, 2, 4] -> "visits 1, 2 and 4"
function visitList(nums) {
  if (nums.length === 1) return `visit ${nums[0]}`;
  return `visits ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]}`;
}

function timelineHtml(lines) {
  const { visits, notes } = parseTimeline(lines);
  if (!visits.length) return "";

  const labelled = visits.filter((v) => v.label);
  const span = labelled.length > 1
    ? `${shortMonth(labelled[0].label)} to ${shortMonth(labelled[labelled.length - 1].label)}`
    : "";
  const summary = `${visits.length} ${visits.length === 1 ? "visit" : "visits"}${span ? ` · ${span}` : ""}`;

  const notesHtml = notes.map((n) => `
    <div class="tl-note">
      ${ICONS.alert}
      <div>
        <strong>${escapeHtml(n.label)}</strong>
        <span class="tl-applies">(${visitList(n.visits)})</span>
        <div>${escapeHtml(n.text)}</div>
      </div>
    </div>`).join("");

  const stepsHtml = visits.map((v, i) => `
    <div class="tl-step">
      <span class="tl-num">${i + 1}</span>
      <span class="tl-mon">${escapeHtml(shortMonth(v.label) || "Planned")}</span>
      <div class="tl-card">
        ${v.items.map((it) => `
          <div class="tl-tx">
            <b>${escapeHtml(it.name)}</b>
            ${it.detail ? `<span>${escapeHtml(it.detail)}</span>` : ""}
          </div>`).join("")}
        ${v.notes.length ? `<span class="tl-warn">${ICONS.alert}Instructions</span>` : ""}
      </div>
    </div>`).join("");

  return `
    <div class="tp-timeline">
      <div class="tl-top">
        <p class="tp-label">${ICONS.route}<span>Suggested timeline</span></p>
        <span class="tl-count">${escapeHtml(summary)}</span>
      </div>
      ${notesHtml}
      <div class="tl-scroll">
        <div class="tl-steps" style="--steps:${visits.length}">${stepsHtml}</div>
      </div>
    </div>`;
}