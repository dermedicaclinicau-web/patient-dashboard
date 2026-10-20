import { getPatient, updatePatient, patientIds, formatMedicare, formatMedicareExpiry, medicareExpired } from "./patients.js";
import { fetchDayAppointments, fetchPreconsult } from "./appointments.js";
import { fetchOpenReminders, completeReminder } from "./reminders.js";
import { openReminderDialog } from "./reminder-dialog.js";
import { mountPersonalNotes } from "./personal-notes-view.js";
import { skincareSectionHtml, mountSkincare } from "./skincare-view.js";
import { recordsSectionHtml, mountRecords } from "./records-view.js";
import { formRecordsSectionHtml, mountFormRecords } from "./form-records.js";
import { setRecordingPatient } from "./recording-bar.js";
import { historySectionHtml, mountHistory } from "./history-view.js";
import { latestMerge, undoMerge } from "./merge-patients.js";
import { confirmDialog, alertDialog } from "./dialog.js";
import {
  billingRxSectionHtml, mountBillingRx, injectableReferralSectionHtml, interestsCommsSectionHtml, fetchBillingAndRx,
} from "./billing-rx-view.js";
import {
  clinicalHistorySectionHtml, mountClinicalHistory, renderClinicalHistory, renderClinicalHistoryError,
} from "./clinical-history-view.js";
import { patientTasksSectionHtml, mountPatientTasks } from "./patient-tasks.js";
import {
  fetchTranscriptRecords, socialHistoryEntries, toBullets, allTreatmentPlans,
  parseTimeline, extractSection,
} from "./transcripts.js";
import { readSidecar, planFromSidecar, planFromText } from "./plan-editor.js";
import { createPlanOverview } from "./plan-overview.js";
import { openPlanReview } from "./master-plan-review.js";
import {
  escapeHtml, getInitials, hueFromString, formatDobLong, calcAge,
  formatMobile, toTelHref, toDateKey, showToast, formatUpdated,
  parseDateKey, formatShortDate,
} from "./utils.js";
import { listSubmissionsForPatient } from "./form-submissions.js";
import { showSoapPanel } from "./soap-panel.js";
import { fetchPatientRecords } from "./records.js";
import { openTaskPanel, statusPillHtml } from "./task-panel.js";
import { myUid } from "./inventory-api.js";

/* ===================== Config ===================== */

const DOC_ACTIONS = [
  ["Consent record", "consent"],
  ["Treatment record", "treatment"],
  ["Prescription", "rx"],
  ["Skin script (SSP)", "ssp", "create-ssp"],
  ["Summary", "summary"],
  ["General note", "note"],
  ["Personal note", "lock", "add-note"],
];

// Order and look of the Pre-Consultation section.
// field = pcn_results column | unit = pill wording ("one|many", or "value" to show the value itself)
// tone = colour style | action = [button label, "coming soon" name]
const PRECONSULT_SECTIONS = [
  { key: "reminders", title: "Reminders", icon: "bell", custom: true,
    action: ["+ Add", "Add reminder", "add-reminder"] },
  { key: "today", today: true },
  { key: "personal-notes", title: "Personal notes", icon: "pin", custom: true,
    action: ["+ Add", "Add personal note", "add-note"] },
  { key: "social-history", title: "Social history", icon: "user", custom: true,
    remember: false }, // always starts collapsed
  { key: "past-appts", title: "Past appointments", icon: "clock", field: "other", unit: "visit|visits", tone: "green" },
  { key: "recent-visits", visits: true },
  { key: "future-visits", title: "Future visits", icon: "calendar", field: "futureVisits", unit: "visit|visits", tone: "purple" },
  //{ key: "overdue", title: "Overdue treatments", icon: "alert", field: "overdue", unit: "overdue|overdue", tone: "red" },
  { key: "packages", title: "Customer packages", icon: "box", field: "packages", unit: "active|active" },

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

/* ===================== Past appointments ===================== */

const PA_SHOW = 8; // visits shown before "Show older visits"
const PA_SHOW_CATEGORY = 4; // category cards are half-width, so show fewer before "Show older"

// Tags on the end of service names that mean nothing to staff, e.g. "Face[prg]", "Application prk"
const PA_TRIM = /\s*\[?\b(?:prg|prk)\b\]?\s*$/i;

// The same service on different areas becomes one line with area tags.
// The first ( ) in "re" is the area.
const PA_GROUPS = [
  { name: "Wrinkle Relaxer", re: /^(?:WR|Wrinkle Relaxer)\s+(.+?)(?:\s*-\s*Wrinkle Relaxer)?$/i },
];

// Colour dot for each service (first match wins; anything else is "skin")
const PA_KINDS = [
  ["rev", /^review\b/i],
  ["inj", /wrinkle relaxer|\bfiller\b|radiesse|belotero|juvederm|profhilo|sculptra|skin ?booster|hydra repair|collagen growth|xeomin|botox|dysport/i],
];
const PA_KIND_LABEL = { inj: "Injectables", skin: "Skin", rev: "Review" };

// Record badges on each visit day, in this order
const PA_BADGES = {
  tx: { short: "Tx Record", full: "Treatment record" },
  cons: { short: "Cons Record", full: "Consent record" },
  rx: { short: "Rx", full: "Prescription" },
  summary: { short: "Summary", full: "Summary" },
};
// "No Tx Record" warning on injectables visits from this date (YYYY-MM-DD). Visits before the portal had
// treatment records aren't checked. Set to "" to turn the warning off.
const PA_TX_CHECK_FROM = "2026-07-01";

// Which badge a completed form gets ("" = no badge)
function paFormKind(s) {
  const c = String(s.category || "").toLowerCase();
  if (c === "treatment") return "tx";
  if (c === "consent") return "cons";
  if (c === "rx" || c === "prescription" || /prescription/i.test(s.templateName || "")) return "rx";
  if (c === "summary") return "summary";
  return "";
}
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
  refresh: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  chevRight: svg('<polyline points="9 18 15 12 9 6"/>'),
  tick: svg('<polyline points="20 6 9 17 4 12"/>'),
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
  let notesView = null;
  let tasksView = null;
  let dialog, form, formError, saveBtn;
  let pastForms = [];          // badge records from completed forms
  let pastSummaries = [];      // badge records from recorded consultations
  let pastFormsLoaded = false;
  let transcriptRecords = [];  // consultations, newest first (for the master plan)
  let planView = null;         // the Treatment Plan overview

  root.addEventListener("click", (e) => {
    const t = e.target;
    // Buttons inside a section header must not also open/close that section
    if (t.closest("summary button")) e.preventDefault();
    const refreshBtn = t.closest("[data-action='refresh-pc']");
    if (refreshBtn) { refreshAll(refreshBtn); return; }
    if (t.closest("[data-action='merge-info']")) { mergeInfo(); return; }
    if (t.closest("[data-action='add-reminder']")) { addReminderFlow(); return; }
    if (t.closest("[data-action='create-ssp']")) { location.hash = `#/ssp/new/${encodeURIComponent(patient.id)}`; return; }
    const openT = t.closest("[data-action='task-open']");
    if (openT && !t.closest("a")) { openTask(openT.dataset.id); return; }
    const doneBtn = t.closest("[data-action='task-done']");
    if (doneBtn) { completeTask(doneBtn); return; }
    if (t.closest(".back-btn, [data-action='back']")) { if (onBack) onBack(); return; }
    const paMore = t.closest("[data-action='pa-more']");
    if (paMore) {
      const card = paMore.closest("details.sub-card");
      if (card && card._pa) { card._pa.all = !card._pa.all; renderPastAppts(card); }
      return;
    }
    const mpApply = t.closest("[data-action='mp-apply']");
    if (mpApply) { applyFromRecord(transcriptRecords.find((r) => r.id === mpApply.dataset.rid)); return; }
    const sumBtn = t.closest("[data-pa-summary]");
    if (sumBtn) {
      const menu = sumBtn.closest(".pa-bdg-menu");
      if (menu) menu.open = false;
      showSoapPanel(sumBtn.dataset.paSummary); // the Consultation notes panel
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
    if (!d.matches || !d.matches("details[data-key]")) return;
    saveOpen(d.dataset.key, d.open);
    // Category cards side by side open and close together
    if (d.dataset.pair !== undefined) {
      root.querySelectorAll(`details[data-pair="${CSS.escape(d.dataset.pair)}"]`).forEach((o) => {
        if (o !== d && o.open !== d.open) o.open = d.open;
      });
    }
  }, true);

  root.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-action='task-open']")) {
      e.preventDefault();
      openTask(e.target.dataset.id);
    }
  });

  // Close any open record-badge menu (e.g. "Tx Record ×2") when clicking elsewhere
  const closeBadgeMenus = (e) => {
    if (!root.isConnected) { document.removeEventListener("click", closeBadgeMenus); return; } // left this patient
    root.querySelectorAll(".pa-bdg-menu[open]").forEach((m) => { if (!m.contains(e.target)) m.open = false; });
  };
  // The notes panel can update the master plan too: refresh the bar when it does
  const onPlanUpdated = (e) => {
    if (!root.isConnected) { window.removeEventListener("master-plan-updated", onPlanUpdated); return; }
    if (patient && e.detail && [patient.id, ...patientIds(patient)].includes(e.detail.patientId)) loadMasterPlan();
  };
  window.addEventListener("master-plan-updated", onPlanUpdated);

  document.addEventListener("click", closeBadgeMenus);

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
        ${DOC_ACTIONS.map(([label, icon, action]) =>
          `<button type="button" class="doc-tile" ${action ? `data-action="${action}"` : `data-soon="${escapeHtml(label)}"`}>${ICONS[icon]}<span>${escapeHtml(label)}</span></button>`
        ).join("")}
      </div>
    </div>

    ${preConsultHtml()}

    ${treatmentPlansSectionHtml()}
    
    ${skincareSectionHtml()}
    
    ${recordsSectionHtml()}

    ${formRecordsSectionHtml()}

    ${patientTasksSectionHtml()}
    
    ${historySectionHtml()}
    
    ${billingRxSectionHtml()}
    
    ${clinicalHistorySectionHtml()}
    
    ${injectableReferralSectionHtml()}

    ${interestsCommsSectionHtml()}

    ${dialogHtml()}`;

  const bar = root.querySelector(".patient-bar");
  const todaySlot = root.querySelector(".today-slot");
  dialog = root.querySelector(".patient-dialog");
  form = dialog.querySelector("form");
  formError = dialog.querySelector(".form-error");
  saveBtn = dialog.querySelector("[type='submit']");
  planView = createPlanOverview(root.querySelector('[data-role="mpbar"]'), {
    patient, staff,
    pre: () => preData,
    today: () => todayAppts,
    consults: () => transcriptRecords,
    recordsOn: (key) => [...pastForms, ...pastSummaries].filter((r) => r.dateKey === key),
    latestConsult: () => latestConsultRecord(),
    applyLatest: () => applyFromRecord(latestConsultRecord()),
    onReminder: () => { loadReminders(); if (tasksView) tasksView.reload(); },
  });

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
    f.medicareNo.value = formatMedicare(patient.medicareNo);
    f.medicareIrn.value = patient.medicareIrn || "";
    f.medicareExp.value = formatMedicareExpiry(patient.medicareExp);
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
        medicareNo: f.medicareNo.value,
        medicareIrn: f.medicareIrn.value,
        medicareExp: f.medicareExp.value,
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
  setRecordingPatient(patient); // shows "Ready to record" for this patient
  loadPreconsultData();
  loadPastForms();
  loadReminders();
  notesView = mountPersonalNotes(root, patient, staff);
  loadTranscriptSections();
  mountSkincare(root, patient, staff);
  mountRecords(root, patient);
  mountFormRecords(root, patient);
  mountHistory(root, patient);  
  tasksView = mountPatientTasks(root, patient);
  mountBillingRx(root, patient);
  mountClinicalHistory(root, patient, staff);

  // Treatment plan + Social history, both from appointment_transcripts (fetched once)
  async function loadTranscriptSections() {
    const socialCard = root.querySelector('details[data-key="social-history"]');
    const cards = [socialCard].filter(Boolean);
    try {
      const records = await fetchTranscriptRecords(patient);
      if (!root.isConnected) return;
      transcriptRecords = records;

      // Summary badges on the Past appointments day cards
      pastSummaries = records.filter((r) => r.date && r.soap.trim()).map((r) => ({
        dateKey: toDateKey(r.date), kind: "summary", summaryId: r.id,
        label: `Consultation${r.staff ? ` · ${r.staff}` : ""}`,
      }));
      pushPastRecords();

      if (socialCard) {
        const entries = socialHistoryEntries(records);
        fillCard(socialCard,
          entries.length ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}` : "None recorded",
          entries.length ? socialHistoryHtml(entries) : `<p class="empty-note">No social history recorded.</p>`,
          !entries.length);
      }

      renderTreatmentPlans(root, records);
      renderClinicalHistory(root, records);
    } catch (err) {
      if (!root.isConnected) return;
      console.error("Transcript sections failed:", err);
      const tpBody = root.querySelector(".tp-body");
      if (tpBody) tpBody.innerHTML = `<p class="empty-note error">Couldn't load treatment plans.</p>`;
      renderClinicalHistoryError(root);
      const msg = err.code === "permission-denied"
        ? "Consultation records aren't accessible. Check the Firestore rules."
        : "Couldn't load consultation records.";
      cards.forEach((c) => fillCard(c, "—", `<p class="empty-note error">${msg}</p>`, false));
    }
    loadMasterPlan(); // once, whether the consultations loaded or not
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
    await Promise.allSettled([
      loadToday(), loadPreconsultData(), loadReminders(), loadTranscriptSections(), loadPastForms(),
      notesView ? notesView.reload() : null,
      tasksView ? tasksView.reload() : null,
    ]);
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

  // Record badges on the Past appointments day cards
  function pushPastRecords() {
    setPastApptRecords(root, [...pastForms, ...pastSummaries], pastFormsLoaded);
  }

  async function loadPastForms() {
    const [recs, subs, scripts] = await Promise.allSettled([
      fetchPatientRecords(patient),                                      // Treatment + Consent Records (old and portal)
      listSubmissionsForPatient([patient.id, ...patientIds(patient)]),   // other portal forms (Rx, Summary)
      fetchBillingAndRx(patient),                                        // Prescription + Injectable Prescription Records
    ]);
    if (!root.isConnected) return;

    const list = [];
    const label = (r) => [r.title, r.staff && `by ${r.staff}`].filter(Boolean).join(" · ");
    const hrefOf = (r) => (r.portalId ? `#/form-record/${encodeURIComponent(r.portalId)}`
      : /^https:\/\//i.test(r.link || "") ? r.link : "");

    if (recs.status === "fulfilled") {
      const add = (kind) => (r) => {
        if (!(r.date instanceof Date) || isNaN(r.date)) return;
        list.push({ dateKey: toDateKey(r.date), kind, href: hrefOf(r), label: label(r) });
      };
      (recs.value.treatments || []).forEach(add("tx"));
      (recs.value.consents || []).forEach(add("cons"));
    } else {
      console.warn("Record badges: treatment/consent records failed:", recs.reason);
    }

    if (subs.status === "fulfilled") {
      subs.value.forEach((s) => {
        const kind = paFormKind(s);
        if ((kind === "rx" || kind === "summary") && s.recordDate) {
          list.push({ dateKey: s.recordDate, kind, href: `#/form-record/${encodeURIComponent(s.id)}`,
            label: [s.templateName, s.createdBy && `by ${s.createdBy}`].filter(Boolean).join(" · ") });
        }
      });
    } else {
      console.warn("Record badges: forms failed:", subs.reason);
    }
    if (scripts.status === "fulfilled") {
      [...(scripts.value.rx || []), ...(scripts.value.injectables || [])].filter((r) => !r.portalId).forEach((r) => {
        if (!(r.date instanceof Date) || isNaN(r.date)) return;
        list.push({
          dateKey: toDateKey(r.date), kind: "rx",
          href: /^https:\/\//i.test(r.link || "") ? r.link : "",
          label: [r.title, r.staff && `by ${r.staff}`].filter(Boolean).join(" · "),
        });
      });
    } else {
      console.warn("Record badges: prescriptions failed:", scripts.reason);
    }
    pastForms = list;
    pastFormsLoaded = recs.status === "fulfilled"; // "No Tx Record" only when treatment records actually loaded
    pushPastRecords();
  }

  // The newest consultation with a new treatment plan
  function latestConsultRecord() {
    return transcriptRecords.find((r) => { const c = consultPlanOf(r); return c && c.intent !== "reviewing_existing" && c.concerns.length; }) || null;
  }

  function applyFromRecord(r) {
    const consult = r ? consultPlanOf(r) : null;
    if (!consult) { showToast("This consultation's plan couldn't be read as concerns, so it can't be added automatically."); return; }
    openPlanReview({
      patient: { id: patient.id, pttId: patient.pttId || "", name: patient.name },
      consult, recordId: r.id, recordDate: r.date, staff, onDone: loadMasterPlan,
    });
  }

  function loadMasterPlan() {
    if (planView) planView.load();
  }
  async function mergeInfo() {
    const ids = patient.mergedIds.join(", ");
    const admin = /^admin$/i.test(String((staff && staff.role) || ""));
    let m = null;
    try { m = await latestMerge(patient.id); } catch (err) { console.warn("Merge lookup failed:", err); }

    if (!admin || !m) {
      await alertDialog({
        title: "Merged record",
        message: `This patient also includes records stored under: ${ids}.` +
          (admin ? "" : "\n\nOnly an Admin can undo a merge."),
      });
      return;
    }

    const when = m.mergedAt ? new Date(m.mergedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
    const names = (m.duplicates || []).map((d) => `${d.name} (${d.pttId || d.id})`).join(", ");
    const ok = await confirmDialog({
      title: "Undo the latest merge?",
      message: `Merged${when ? ` on ${when}` : ""}${m.mergedBy ? ` by ${m.mergedBy}` : ""}: ${names}.\n\n` +
        "Undoing makes them separate patients again, and puts this patient's details and clinical lists back as they were " +
        "before the merge. Edits made to those since the merge will be lost.",
      confirmLabel: "Undo merge",
      tone: "danger",
    });
    if (!ok) return;

    try {
      await undoMerge(m);
      showToast("Merge undone");
      window.dispatchEvent(new HashChangeEvent("hashchange")); // reload this page
    } catch (err) {
      console.error("Undo merge failed:", err);
      showToast(err.code === "not-admin" || err.code === "permission-denied"
        ? "Only Admins can undo a merge."
        : "Couldn't undo the merge. Please try again.");
    }
  }
  async function addReminderFlow() {
    const saved = await openReminderDialog({ patient, staff });
    if (!saved || !root.isConnected) return;
    showToast("Reminder added");
    const pc = root.querySelector('details[data-key="preconsult"]');
    if (pc) pc.open = true;
    await loadReminders(); // opens the Reminders card when it has tasks
    if (tasksView) tasksView.reload();
  }

  async function completeTask(btn) {
    const id = btn.dataset.id;
    if (!id || btn.disabled) return;
    // The same task can be in Reminders and in Tasks: both change straight away
    const btns = [...root.querySelectorAll(`[data-action='task-done'][data-id="${CSS.escape(id)}"]`)];
    btns.forEach((b) => { b.disabled = true; b.closest("li")?.classList.add("is-leaving"); });
    showToast("Reminder marked as done");
    try {
      await completeReminder(id, staff);
      loadReminders();
      if (tasksView) tasksView.reload();
    } catch (err) {
      console.error("Completing reminder failed:", err);
      btns.forEach((b) => { b.disabled = false; b.closest("li")?.classList.remove("is-leaving"); });
      showToast(err.code === "FORBIDDEN" || err.code === "permission-denied"
        ? "You don't have permission to update this reminder."
        : err.code === "UNAUTHORIZED" ? "Your session has expired. Log out and back in."
        : "Couldn't update the reminder.");
    }
  }
  
  function openTask(id) {
    let changed = false;
    const dlg = openTaskPanel(id, {
      staff: { uid: myUid(), name: staff && staff.name, role: staff && staff.role },
      onChange: () => { changed = true; },
    });
    dlg.addEventListener("close", () => {
      if (!changed || !root.isConnected) return;
      loadReminders();
      if (tasksView) tasksView.reload();
    });
  }
  // Today's appointment: fills the highlight block AND the "Appt today" chip
  async function loadToday() {
    try {
      todayAppts = await loadTodayAppts(patient);
      if (!root.isConnected) return;
      todaySlot.innerHTML = todayHtml(todayAppts);
      renderTop();
      if (planView) planView.redraw();
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
      if (planView) planView.redraw();
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
    pre && pre.overdue && overdueChipHtml(pre.overdue),
    p.mergedIds && p.mergedIds.length &&
      `<button type="button" class="chip chip-merged" data-action="merge-info">Merged · ${p.mergedIds.length} other ID${p.mergedIds.length > 1 ? "s" : ""}</button>`,
    p.redirectedFrom && `<span class="chip">Opened from merged record ${escapeHtml(p.redirectedFrom)}</span>`,
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
        <button type="button" class="round-btn" data-task-picker="patient" data-email="${escapeHtml(p.email || "")}" aria-label="Email" title="Email">${ICONS.mail}</button>
        <button type="button" class="round-btn" data-action="add-reminder" aria-label="Add reminder" title="Add reminder">${ICONS.bell}</button>
        <button type="button" class="btn-ghost sm pb-edit">${ICONS.edit}<span>Edit</span></button>
      </div>
    </div>
    <dl class="pb-details">
      <div><dt>Date of birth</dt><dd>${show(dobText, `${escapeHtml(dobText)}${age !== null ? ` <span class="pb-age">(${age} yrs)</span>` : ""}`)}</dd></div>
      <div><dt>Mobile</dt><dd>${show(p.mobile, escapeHtml(formatMobile(p.mobile)))}</dd></div>
      <div><dt>Email</dt><dd>${show(p.email)}</dd></div>
      <div><dt>Address</dt><dd>${show(p.address)}</dd></div>
      <div><dt>Medicare</dt><dd>${show(p.medicareNo, `${escapeHtml(formatMedicare(p.medicareNo))}${
        p.medicareIrn ? ` <span class="pb-age">· Ref ${escapeHtml(p.medicareIrn)}</span>` : ""}${
        p.medicareExp ? ` <span class="pb-age">· Exp ${escapeHtml(formatMedicareExpiry(p.medicareExp))}</span>${
          medicareExpired(p.medicareExp) ? ' <span class="missing">expired</span>' : ""}` : ""}`)}</dd></div>
    </dl>`;
}

// "Overdue treatments" chip with a bubble listing what's due (hover on desktop, tap on iPad)
function overdueChipHtml(value) {
  const lines = toLines(value);
  if (!lines.length) return "";
  return `
    <span class="od-wrap">
      <button type="button" class="chip chip-alert od-chip" aria-describedby="od-tip">
        ${ICONS.alert}<span>Overdue treatments</span><em>${lines.length}</em>
      </button>
      <span class="od-tip" id="od-tip" role="tooltip">
        <strong>Overdue treatments</strong>
        <ul>${lines.map((l) => `<li>${overdueLineHtml(l)}</li>`).join("")}</ul>
      </span>
    </span>`;
}

// "Wrinkle Relaxer - last visit 21/4/2026" → bold name, detail underneath
function overdueLineHtml(line) {
  const m = /^(.+?)\s*(?:\s[-–—]\s|:\s)\s*(.+)$/.exec(line);
  return m
    ? `<b>${escapeHtml(m[1])}</b><small>${escapeHtml(m[2])}</small>`
    : `<b>${escapeHtml(line)}</b>`;
}

function subCard({ key, title, icon = "", body = "", pill = "", tone = "", action = null,
                   field = "", unit = "", extraClass = "", open = false, remember = true, pair = "" }) {
  return `
    <details class="sub-card ${tone ? `tone-${tone}` : ""} ${extraClass}" data-key="${escapeHtml(key)}"${
      pair !== "" ? ` data-pair="${escapeHtml(String(pair))}"` : ""}${
      field ? ` data-field="${escapeHtml(field)}"` : ""}${unit ? ` data-unit="${escapeHtml(unit)}"` : ""} ${
      (remember ? isOpen(key, open) : open) ? "open" : ""}>
      <summary>
        <span class="sum-left">
          ${icon ? `<span class="sum-icon">${ICONS[icon]}</span>` : ""}
          <span class="sum-label">${escapeHtml(title)}</span>
          <span class="hint"${pill ? "" : " hidden"}>${escapeHtml(pill)}</span>
        </span>
        <span class="sum-right">
          ${action ? `<button type="button" class="sum-action" ${action[2]
            ? `data-action="${escapeHtml(action[2])}"`
            : `data-soon="${escapeHtml(action[1])}"`}>${escapeHtml(action[0])}</button>` : ""}
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
  const cards = VISIT_CATEGORIES.flatMap((row, ri) => {
    // Both cards in a row start the same way: open or closed as the row was last left
    const open = isOpen(`visit-${slug(row[0].title)}`, false);
    return row.map((c) => subCard({
      key: `visit-${slug(c.title)}`, title: c.title, tone: c.color,
      field: c.field, unit: "visit|visits", extraClass: "visit-card",
      remember: false, open, pair: ri,
      body: `<div class="skeleton xs"></div>`,
    }));
  }).join("");

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
          <label class="field"><span>Medicare number</span><input name="medicareNo" inputmode="numeric" maxlength="14" placeholder="2123 45670 1" autocomplete="off" /></label>
          <label class="field"><span>Medicare reference no.</span><input name="medicareIrn" inputmode="numeric" maxlength="1" placeholder="1–9" autocomplete="off" /></label>
          <label class="field"><span>Medicare expiry</span><input name="medicareExp" maxlength="7" placeholder="MM/YYYY" autocomplete="off" /></label>
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
  const ids = patientIds(patient).map((s) => s.toLowerCase());
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
    d.classList.toggle("is-empty", !lines.length);

    // Past appointments and the category cards: day cards
    if (d.dataset.key === "past-appts" || d.classList.contains("visit-card")) {
      const prev = d._pa;
      d._pa = { ...paParse(lines), all: prev ? prev.all : false, records: prev ? prev.records : new Map(), formsLoaded: prev ? prev.formsLoaded : false };
      if (d._pa.visits.length) {
        const n = d._pa.visits.length;
        hint.textContent = `${n} ${n === 1 ? "visit" : "visits"}`;
        renderPastAppts(d);
        return;
      }
    }

    d.querySelector(".sub-body").innerHTML = lines.length
      ? valueHtml(lines)
      : `<p class="empty-note">${data ? "Nothing recorded." : "No pre-consultation record found for this patient."}</p>`;
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

/* ===================== Past appointments: day cards ===================== */

const paKind = (name) => (PA_KINDS.find(([, re]) => re.test(name)) || ["skin"])[0];

// "DermaGlow Standard Neck" under "DermaGlow Standard Face" → "Neck"
function paAddLabel(parent, name) {
  const a = parent.toLowerCase().split(/\s+/);
  const b = name.split(/\s+/);
  let n = 0;
  while (n < b.length - 1 && a[n] === b[n].toLowerCase()) n++;
  return n >= 2 ? b.slice(n).join(" ") : name;
}

// "2/9/2026 - Peel (Clinician), [StimPeel] Add on Peel 2 areas (Dr Teh)" → one visit, newest first
function paParse(lines) {
  const byDay = new Map();
  const other = [];
  lines.forEach((line) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(.+)$/.exec(line);
    const date = m && new Date(+m[3], +m[2] - 1, +m[1]);
    if (!date || isNaN(date)) { other.push(line); return; }
    const key = toDateKey(date);
    const v = byDay.get(key) || { key, date, items: [] };
    byDay.set(key, v);
    const items = v.items;

    // Split on "), " so names with their own brackets, e.g. "Review 15(post treatment)", stay whole
    const parts = m[4].split(/\)\s*,\s*/);
    parts.forEach((raw, i) => {
      const txt = (i < parts.length - 1 ? `${raw})` : raw).trim();
      if (!txt) return;
      const w = /^(.*\S)\s+\(([^()]*)\)$/.exec(txt);   // last "(Clinician)"
      let name = (w ? w[1] : txt).replace(/^\*+/, "").trim();
      const who = w ? w[2].trim() : "";
      const add = /^\[[^\]]*\]\s*add[\s-]*on\s+/i.exec(name);
      if (add) name = name.slice(add[0].length);
      name = name.replace(PA_TRIM, "").trim();
      if (!name) return;

      const grp = !add && PA_GROUPS.map((g) => [g, g.re.exec(name)]).find(([, x]) => x);
      if (grp) {
        const [g, x] = grp;
        const area = x[1].trim();
        const prev = items.find((it) => it.group === g.name && it.who === who);
        if (prev) { if (!prev.areas.includes(area)) prev.areas.push(area); return; }
        items.push({ name: g.name, group: g.name, areas: [area], adds: [], who, kind: paKind(g.name) });
        return;
      }
      if (add) {
        const parent = [...items].reverse().find((it) => !it.group);
        if (parent) { parent.adds.push(paAddLabel(parent.name, name)); return; }
      }
      items.push({ name, group: "", areas: [], adds: [], who, kind: paKind(name) });
    });
  });
  const visits = [...byDay.values()].filter((v) => v.items.length).sort((a, b) => b.date - a.date);
  return { visits, other };
}

function paAgo(d) {
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days < 1) return "Today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 63) return `${Math.round(days / 7)} wks ago`;
  if (days < 365) return `${Math.max(2, Math.round(days / 30.4))} mths ago`;
  const y = Math.floor(days / 365);
  return `${y} yr${y === 1 ? "" : "s"} ago`;
}

// A badge (or a line in its menu): summaries open the notes panel, records open their form or file
function paRecHtml(r, cls, text) {
  const title = escapeHtml(r.label || "");
  if (r.summaryId) {
    return `<button type="button" class="${cls}" data-pa-summary="${escapeHtml(r.summaryId)}" title="${title}">${text}</button>`;
  }
  if (!r.href) return `<span class="${cls}" title="${title} (no file attached)">${text}</span>`;
  const external = /^https?:\/\//i.test(r.href) ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a class="${cls}" href="${escapeHtml(r.href)}"${external} title="${title}">${text}</a>`;
}

function paBadgesHtml(recs, missing) {
  const by = new Map();
  (recs || []).forEach((r) => {
    if (!PA_BADGES[r.kind]) return;
    if (!by.has(r.kind)) by.set(r.kind, []);
    by.get(r.kind).push(r);
  });
  const html = Object.keys(PA_BADGES).filter((k) => by.has(k)).map((k) => {
    const b = PA_BADGES[k];
    const list = by.get(k);
    if (list.length === 1) return paRecHtml(list[0], `pa-bdg is-${k}`, escapeHtml(b.short));
    return `<details class="pa-bdg-menu"><summary class="pa-bdg is-${k}">${escapeHtml(b.short)} ×${list.length}</summary>
      <div class="pa-bdg-pop">${list.map((r) => paRecHtml(r, "pa-pop-item", escapeHtml(r.label || b.full))).join("")}</div></details>`;
  }).join("") + (missing ? '<span class="pa-bdg is-missing" title="Injectables were booked but there\'s no treatment record for this day">No Tx Record</span>' : "");
  return html ? `<div class="pa-badges">${html}</div>` : "";
}


function paCardHtml(v, recs, formsLoaded) {
  const day = v.date.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  const missing = formsLoaded && !!PA_TX_CHECK_FROM && v.key >= PA_TX_CHECK_FROM && v.key < toDateKey()
    && v.items.some((it) => it.kind === "inj") && !(recs || []).some((r) => r.kind === "tx");
  return `
    <article class="pa-card${missing ? " is-missing" : ""}">
      <div class="pa-date"><b>${escapeHtml(day)}</b><span>${escapeHtml(paAgo(v.date))}</span></div>
      <ul class="pa-items">${v.items.map((it) => `
        <li class="pa-item"><i class="pa-dot is-${it.kind}" aria-hidden="true"></i>
          <div>${escapeHtml(it.name)}${it.areas.map((a) => ` <span class="pa-area">${escapeHtml(a)}</span>`).join("")}${
            it.who ? ` <span class="pa-who">· ${escapeHtml(it.who)}</span>` : ""}${
            it.adds.length ? `<div class="pa-adds">${it.adds.map((a) => `+ ${escapeHtml(a)}`).join(" · ")}</div>` : ""}</div></li>`).join("")}
      </ul>
      ${paBadgesHtml(recs, missing)}
    </article>`;
}

function renderPastAppts(card) {
  const st = card._pa;
  if (!st) return;
  const limit = card.classList.contains("visit-card") ? PA_SHOW_CATEGORY : PA_SHOW;
  const shown = st.all ? st.visits : st.visits.slice(0, limit);
  const kinds = new Set(shown.flatMap((v) => v.items.map((it) => it.kind)));

  // The colour legend only helps when there's more than one kind to tell apart
  let html = kinds.size > 1 ? `<div class="pa-legend">${Object.keys(PA_KIND_LABEL).filter((k) => kinds.has(k)).map((k) =>
    `<span><i class="pa-dot is-${k}" aria-hidden="true"></i>${PA_KIND_LABEL[k]}</span>`).join("")}</div>` : "";
  let year = null;
  shown.forEach((v) => {
    const y = v.date.getFullYear();
    if (y !== year) {
      if (year !== null) html += "</div>";
      html += `<p class="pa-year">${y}</p><div class="pa-grid">`;
      year = y;
    }
    html += paCardHtml(v, st.records.get(v.key), st.formsLoaded);
    });
  if (year !== null) html += "</div>";

  const more = st.visits.length - shown.length;
  if (more > 0) {
    const newest = st.visits[limit].date.getFullYear();
    const oldest = st.visits[st.visits.length - 1].date.getFullYear();
    html += `<button type="button" class="pa-more" data-action="pa-more">Show ${more} older visit${more === 1 ? "" : "s"} (${
      oldest === newest ? oldest : `${oldest} to ${newest}`})</button>`;
  } else if (st.all && st.visits.length > limit) {
    html += `<button type="button" class="pa-more" data-action="pa-more">Show fewer</button>`;
  }
  if (st.other.length) html += `<ul class="pc-list pa-other">${st.other.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
  card.querySelector(".sub-body").innerHTML = html;
}

// list: [{ dateKey, kind, href | summaryId, label }]. formsLoaded: records were read, so "No Tx Record" is trustworthy.
// Goes to Past appointments AND every category card.
function setPastApptRecords(root, list, formsLoaded) {
  const map = new Map();
  (list || []).forEach((r) => {
    if (!r.dateKey || !r.kind) return;
    if (!map.has(r.dateKey)) map.set(r.dateKey, []);
    map.get(r.dateKey).push(r);
  });
  root.querySelectorAll('details[data-key="past-appts"], details.visit-card').forEach((card) => {
    if (!card._pa) { card._pa = { visits: [], other: [], all: false, records: map, formsLoaded }; return; }
    card._pa.records = map;
    card._pa.formsLoaded = formsLoaded;
    if (card._pa.visits.length) renderPastAppts(card);
  });
}

/* ===================== Reminders ===================== */

function remindersHtml(tasks) {
  const today = toDateKey();

  return `<ul class="task-list">${tasks.map((t) => {
    const dueKey = String(t.dueDate || "").trim();
    const due = parseDateKey(dueKey);
    const overdue = !!due && dueKey < today;
    const status = String(t.status || "Open").trim();
    const comments = Array.isArray(t.notes) ? t.notes.length : 0;

    const meta = [
      due ? `Due ${formatShortDate(due)}` : (dueKey ? `Due ${dueKey}` : "No due date"),
      t.assignedToName ? `For ${t.assignedToName}` : "For anyone",
      t.createdBy ? `Added by ${t.createdBy}` : "",
      comments ? `${comments} comment${comments === 1 ? "" : "s"}` : "",
    ].filter(Boolean).map(escapeHtml).join(" · ");

    const flags =
      (overdue ? `<span class="task-flag">Overdue</span>` : "") +
      (status.toLowerCase() !== "open" ? statusPillHtml(t) : "");

    return `
      <li class="task has-action${overdue ? " is-overdue" : ""}">
        <div class="task-main is-clickable" data-action="task-open" data-id="${escapeHtml(t.id)}" role="button" tabindex="0"
          title="Open this task">
          <span class="task-text">${escapeHtml(t.taskText || "Untitled reminder")}</span>
          <span class="task-meta">${meta}${flags}</span>
        </div>
        <button type="button" class="task-done" data-action="task-done" data-id="${escapeHtml(t.id)}" title="Mark as done">${ICONS.tick}Done</button>
      </li>`;
  }).join("")}</ul>`;
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

/* ===================== Master plan ===================== */

// A consultation's plan as the editable model (structured sidecar, or the plan text), or null
function consultPlanOf(r) {
  if (!r || !r.soap) return null;
  return planFromSidecar(readSidecar(r.soap)) || planFromText(extractSection(r.soap, "TREATMENT PLAN"));
}

/* ===================== Treatment Plan section ===================== */

function treatmentPlansSectionHtml() {
  return `
    <details class="section-card tp-card" data-key="tp-section" ${isOpen("tp-section", true) ? "open" : ""}>
      <summary>
        <span class="pc-head">${ICONS.chev}<span class="pc-title">Treatment Plan</span><span class="hint tp-count">…</span></span>
      </summary>
      <div class="mp-wrap" data-role="mpbar"><div class="skeleton sm"></div></div>
      <details class="tp-history" data-key="tp-history" ${isOpen("tp-history", false) ? "open" : ""}>
        <summary>
          <span class="tp-hist-title">Consultation plans</span>
          <span class="hint tp-hist-count">…</span>
          ${ICONS.chev}
        </summary>
        <div class="section-body tp-body"><div class="skeleton sm"></div></div>
      </details>
    </details>`;
}

function renderTreatmentPlans(root, records) {
  const section = root.querySelector('details[data-key="tp-section"]');
  if (!section) return;

  const plans = allTreatmentPlans(records);
  const dates = new Set(plans.map((p) => (p.date ? toDateKey(p.date) : p.dateText)));
  const newest = plans.find((p) => p.date);
  section.querySelector(".tp-hist-count").textContent = plans.length
    ? `${dates.size} consultation${dates.size === 1 ? "" : "s"}${newest ? ` · latest ${formatShortDate(newest.date)}` : ""}`
    : "None yet";

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
        <span class="tp-sum-right">
          ${group.some((p) => { const c = consultPlanOf(p); return c && c.intent !== "reviewing_existing" && c.concerns.length; })
            ? `<button type="button" class="tp-apply" data-action="mp-apply" data-rid="${escapeHtml((group.find((p) => {
                const c = consultPlanOf(p); return c && c.concerns.length; }) || first).id)}">Apply to master plan</button>` : ""}
          ${ICONS.chev}
        </span>
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