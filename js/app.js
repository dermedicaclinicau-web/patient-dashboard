import { loginWithPin, logout, watchAuth, updateStaffName, warmUpLogin } from "./auth.js";
//import { mountPatientList, clearPatientCache } from "./patient-list.js";
//import { mountCalendar } from "./calendar.js";
//import { mountPatientDashboard } from "./patient-dashboard.js";
import { escapeHtml, getInitials, showToast } from "./utils.js";
import { maybeShowStartOfDay, closeStartOfDay, refreshStartOfDayButton, hideStartOfDayButton } from "./start-of-day.js";
import { initRecordingBar, setRecordingPatient } from "./recording-bar.js";
import { isRecorderBusy, hasPendingUploads, suspendRecorder } from "./recorder.js";
import { initSoapPanel, closeSoapPanel, hasUnsavedNotes } from "./soap-panel.js";
import { confirmDialog } from "./dialog.js";
//import { mountFormBuilder } from "./form-builder.js";
//import { mountFormFill, mountFormRecord } from "./form-fill.js";
import { initFormPicker, closeFormPicker } from "./form-picker.js";
//import { mountImageBank } from "./image-bank.js";
//import { mountTaskManager } from "./task-manager.js";
////import { mountAftercareBank } from "./aftercare-bank.js";
//import { mountSpecialistBank } from "./specialist-bank.js";
//import { mountSspProductsPage } from "./ssp-products.js";
//import { mountSspBuilder } from "./ssp-builder.js";
//import { mountStaffManager } from "./staff-manager.js";
//import { mountInventory } from "./inventory.js";
import { setPerms, can, isAdmin as isAdminNow, refreshAccess, refreshLoginToken } from "./perms.js";
import { initUpdateCheck } from "./updates.js";
//import { mountMyDashboard } from "./my-dashboard.js";
//import { mountReports } from "./reports.js";
//import { mountSettings } from "./settings.js";
import { initEndOfDay, teardownEndOfDay, endOfDayPending, askEndBeforeLogout, openEndOfDay } from "./end-of-day.js";
//import { mountStaffDays } from "./staff-days.js";
import { initTopbar, closeTopbarMenu } from "./topbar.js";
import { initChat, teardownChat } from "./chat.js";
import { openMyPhoto } from "./my-photo.js";
//import { mountKnowledge } from "./knowledge.js";
//import { mountScanner } from "./scanner.js";
//import { mountRecall } from "./recall.js";
//import { mountRecallSettings } from "./recall-settings.js";
import "./menu-search.js";
import "./mobile-nav.js";
import "./force-refresh.js";   // first, so it can see recordings start
import { freshReload } from "./fresh-reload.js";

// Remember every file the portal loads (the default list stops at 250), so "Get latest version" can refresh them all
try { performance.setResourceTimingBufferSize(2000); } catch { /* older browsers */ }

// iPad: menu links can't be lifted and dragged (works even if the menu is added later)
document.addEventListener("dragstart", (e) => {
  if (e.target.closest && e.target.closest(".nav-item")) e.preventDefault();
});

const $ = (id) => document.getElementById(id);

const views = {
  boot: $("boot-view"),
  login: $("login-view"),
  dashboard: $("dashboard-view"),
};

const els = {
  // login
  loginCard: document.querySelector(".login-card"),
  loginForm: $("login-form"),
  pinInput: $("pin-input"),
  pinToggle: $("pin-toggle"),
  loginBtn: $("login-btn"),
  loginError: $("login-error"),
  // top bar
  staffName: $("staff-name"),
  staffRole: $("staff-role"),
  staffPhoto: $("staff-photo"),
  staffInitials: $("staff-initials"),
  logoutBtn: $("logout-btn"),
  editProfileBtn: $("edit-profile-btn"),
  // layout
  content: $("content"),
  navItems: document.querySelectorAll(".nav-item"),
  // profile dialog
  profileDialog: $("profile-dialog"),
  profileForm: $("profile-form"),
  profileName: $("profile-name"),
  profileError: $("profile-error"),
  profileCancel: $("profile-cancel"),
  profileSave: $("profile-save"),
};

// Raise this each time paper-records.js changes, so browsers don't keep using an old copy
const PAPER_V = 12;
// Raise this each time prospects.js changes, so browsers don't keep using an old copy
const PROSPECTS_V = 7;
let currentStaff = null;
initFormPicker(els.content, { getStaff: () => currentStaff });
initTopbar();

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

/* ===================== PIN LOGIN ===================== */

const PIN_MIN = 4;
const PIN_MAX = 8; // must match the Apps Script check (/^\d{4,8}$/)
let busy = false;

function setBusy(value) {
  busy = value;
  els.pinInput.disabled = value;
  els.loginBtn.disabled = value;
  els.loginBtn.textContent = value ? "Checking…" : "Login";
}

function showLoginError(msg) {
  els.loginError.textContent = msg;
  els.loginCard.classList.remove("shake");
  void els.loginCard.offsetWidth; // restarts the shake animation
  els.loginCard.classList.add("shake");
}

function resetLogin() {
  els.pinInput.value = "";
  els.pinInput.type = "password";
  els.pinToggle.classList.remove("is-on");
  els.pinToggle.setAttribute("aria-label", "Show PIN");
  els.loginError.textContent = "";
  els.loginCard.classList.remove("shake");
  setBusy(false);
}

// Digits only, max 8
els.pinInput.addEventListener("input", () => {
  const clean = els.pinInput.value.replace(/\D/g, "").slice(0, PIN_MAX);
  if (clean !== els.pinInput.value) els.pinInput.value = clean;
  els.loginError.textContent = "";
});

// Show / hide PIN
els.pinToggle.addEventListener("click", () => {
  const show = els.pinInput.type === "password";
  els.pinInput.type = show ? "text" : "password";
  els.pinToggle.classList.toggle("is-on", show);
  els.pinToggle.setAttribute("aria-label", show ? "Hide PIN" : "Show PIN");
  els.pinInput.focus();
});

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;

  const pin = els.pinInput.value.trim();
  if (pin.length < PIN_MIN) {
    showLoginError(`Enter your ${PIN_MIN}–${PIN_MAX} digit PIN.`);
    els.pinInput.focus();
    return;
  }

  setBusy(true);
  try {
    await loginWithPin(pin);
    els.pinInput.value = ""; // watchAuth switches to the dashboard
  } catch (err) {
    els.pinInput.value = "";
    showLoginError(err.message);
  } finally {
    setBusy(false);
    if (!views.login.hidden) els.pinInput.focus();
  }
});

/* ===================== TOP BAR ===================== */

function renderStaff(staff) {
  els.staffName.textContent = staff.name;
  els.staffRole.textContent = staff.role;
  els.staffInitials.textContent = getInitials(staff.name);
  els.staffPhoto.hidden = !staff.photo;
  if (staff.photo) els.staffPhoto.src = staff.photo;
  document.querySelectorAll("[data-admin-only]").forEach((el) => { el.hidden = !/^admin$/i.test(String(staff.role || "")); });
}

els.staffPhoto.addEventListener("error", () => { els.staffPhoto.hidden = true; });
els.logoutBtn.addEventListener("click", async () => {
  const recording = isRecorderBusy();
  if ((recording || hasPendingUploads()) && !(await confirmDialog({
    title: recording ? "A recording is in progress" : "A recording is still uploading",
    message: recording
      ? "Log out anyway? The recording stays saved on this computer and uploads at your next login."
      : "Log out anyway? The upload stops, but the recording stays saved on this computer and finishes uploading at your next login.",
    confirmLabel: "Log out",
    tone: "warning",
  }))) return;
  if (endOfDayPending()) {
    const v = await askEndBeforeLogout();
    if (v === "stay") return;
    if (v === "end") { openEndOfDay(); return; }   // its "Save and log out" comes back here, with the day ended
  }
  if (hasUnsavedNotes() && !(await confirmDialog({
    title: "Unsaved clinical notes",
    message: "You have unsaved changes to clinical notes. Logging out will discard them.",
    confirmLabel: "Log out and discard",
    tone: "warning",
  }))) return;
  logout();
});

/* ===================== EDIT PROFILE ===================== */

els.editProfileBtn.addEventListener("click", () => {
  els.profileName.value = currentStaff ? currentStaff.name : "";
  els.profileError.textContent = "";
  els.profileDialog.showModal();
  els.profileName.select();
});

// My photo: upload, take or remove your own photo
const myPhotoBtn = $("my-photo-btn");
if (myPhotoBtn) myPhotoBtn.addEventListener("click", () => {
  if (!currentStaff) return;
  closeTopbarMenu();
  openMyPhoto({ ...currentStaff }, async (url) => {
    currentStaff = { ...currentStaff, photo: url };
    renderStaff(currentStaff);
    try { await refreshLoginToken(); }            // so the new photo is still there after a refresh
    catch (err) { console.warn("Login token not refreshed:", err); }
  });
});
// Get latest version: fresh copies of every file, then reload.
// Not while recording or with unsaved notes, so nothing is lost.
const meRefresh = $("me-refresh");
if (meRefresh) meRefresh.addEventListener("click", async () => {
  closeTopbarMenu();
  if (isRecorderBusy() || hasPendingUploads()) {
    showToast("Wait until the recording has finished uploading, then try again.");
    return;
  }
  if (hasUnsavedNotes()) {
    showToast("Save your clinical notes first, then try again.");
    return;
  }
  meRefresh.disabled = true;
  showToast("Getting the latest version…");
  await freshReload();
});
els.profileCancel.addEventListener("click", () => els.profileDialog.close());

els.profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.profileSave.disabled = true;
  els.profileSave.textContent = "Saving…";
  els.profileError.textContent = "";
  try {
    const name = await updateStaffName(els.profileName.value);
    currentStaff = { ...currentStaff, name };
    renderStaff(currentStaff);
    els.profileDialog.close();
  } catch (err) {
    console.error("Profile update failed:", err);
    // Firestore errors have a .code; our own validation errors have a friendly message
    els.profileError.textContent = err.code ? "Couldn't save your name. Please try again." : err.message;
  } finally {
    els.profileSave.disabled = false;
    els.profileSave.textContent = "Save";
  }
});

/* ===================== ROUTER ===================== */

function placeholderPage(title, message, backLink = "") {
  return `
    <section class="page">
      ${backLink}
      <div class="page-head"><h2>${escapeHtml(title)}</h2></div>
      <div class="state"><strong>Coming soon</strong>${escapeHtml(message)}</div>
    </section>`;
}

/* ===================== Pages load when they're first opened ===================== */
// A new tab only downloads the page it shows. Pages already opened in this tab open instantly.
const loadedPages = new Map();   // path → the loaded page
let routeSeq = 0;                // goes up on every page change, so a slow page never replaces a newer one

function lazyPage(path, label, run) {
  return (el, param) => {
    const seq = routeSeq;
    const ready = loadedPages.get(path);
    if (ready) return run(ready, el, param);
    // Only show "loading" if it takes long enough to notice
    const slow = setTimeout(() => {
      if (seq === routeSeq) el.innerHTML = '<section class="page"><div class="skeleton sm"></div></section>';
    }, 150);
    return import(path)
      .then((m) => {
        clearTimeout(slow);
        loadedPages.set(path, m);
        if (seq === routeSeq) return run(m, el, param);
      })
      .catch((err) => {
        clearTimeout(slow);
        console.error(`${label} failed to load:`, err);
        if (seq === routeSeq) {
          el.innerHTML = `<section class="page"><div class="state error"><strong>${escapeHtml(label)} couldn't load</strong>
            ${escapeHtml(err && err.message ? err.message : "Refresh and try again.")}</div></section>`;
        }
      });
  };
}

// The pages most people use, loaded quietly once the portal is open (so moving around stays instant)
function warmPages() {
  const go = () => ["./patient-dashboard.js", "./my-dashboard.js", "./patient-list.js", "./calendar.js"].forEach((p) => {
    if (!loadedPages.has(p)) import(p).then((m) => loadedPages.set(p, m)).catch(() => {});
  });
  if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 5000 });
  else setTimeout(go, 3000);
}

const recallPage = lazyPage("./recall.js", "Recall", (m, el) => m.mountRecall(el, { staff: currentStaff }));
const recallSettingsPage = lazyPage("./recall-settings.js", "Recall settings",
  (m, el) => m.mountRecallSettings(el, { staff: currentStaff }));
const settingsPage = lazyPage("./settings.js", "System configuration",
  (m, el, param) => m.mountSettings(el, { param, staff: currentStaff }));

const PAGES = {
  home: (el, param) => (String(param || "").split("/")[0] === "days"
    ? lazyPage("./staff-days.js", "Start & end of day", (m, e) => m.mountStaffDays(e))(el, param)
    : lazyPage("./my-dashboard.js", "My dashboard", (m, e) => m.mountMyDashboard(e, { staff: currentStaff }))(el, param)),
  patients: lazyPage("./patient-list.js", "The Patient List", (m, el) => m.mountPatientList(el)),
  calendar: lazyPage("./calendar.js", "The Calendar", (m, el, param) => m.mountCalendar(el, param)),
  forms: lazyPage("./form-builder.js", "Form Builder",
    (m, el, param) => m.mountFormBuilder(el, { isAdmin: can("forms.build"), staff: currentStaff, templateId: param })),
  patient: lazyPage("./patient-dashboard.js", "The patient page",
    (m, el, id) => m.mountPatientDashboard(el, id, { staff: currentStaff, onBack: goBack })),
  fill: lazyPage("./form-fill.js", "The form", (m, el, param) => m.mountFormFill(el, param, { staff: currentStaff })),
  "form-record": lazyPage("./form-fill.js", "The record", (m, el, id) => m.mountFormRecord(el, id, { staff: currentStaff })),
  "image-bank": lazyPage("./image-bank.js", "The Image Bank", (m, el) => m.mountImageBank(el, { isAdmin: can("forms.build") })),
  "aftercare-bank": lazyPage("./aftercare-bank.js", "The Aftercare Bank",
    (m, el) => m.mountAftercareBank(el, { isAdmin: can("forms.build"), staff: currentStaff })),
  "specialist-bank": lazyPage("./specialist-bank.js", "The Specialist Bank",
    (m, el) => m.mountSpecialistBank(el, { staff: currentStaff })),
  "ssp-products": lazyPage("./ssp-products.js", "Skin Script products",
    (m, el) => m.mountSspProductsPage(el, { isAdmin: can("ssp.config"), staff: currentStaff })),
  ssp: lazyPage("./ssp-builder.js", "The Skin Script builder", (m, el, param) => {
    const [, pid = ""] = String(param || "").split("/"); // #/ssp/new/<patientId>
    m.mountSspBuilder(el, { patientId: pid, staff: currentStaff, isAdmin: can("ssp.config") });
  }),
  tasks: lazyPage("./task-manager.js", "Task Manager",
    (m, el, param) => m.mountTaskManager(el, { param, isAdmin: can("tasks.build"), staff: currentStaff })),
  inventory: lazyPage("./inventory.js", "Inventory", (m, el, param) => m.mountInventory(el, { param, staff: currentStaff })),
  reports: lazyPage("./reports.js", "Reporting", (m, el, param) => m.mountReports(el, { param, staff: currentStaff })),
  staff: lazyPage("./staff-manager.js", "Staff", (m, el) => m.mountStaffManager(el, { staff: currentStaff })),
  recall: (el, param) => {
    const sub = String(param || "").split("/")[0];
    if (sub === "messages") return lazyPage("./recall-messages.js", "Texts & emails",
      (m, e) => m.mountRecallMessages(e, { staff: currentStaff }))(el, param);
    if (sub === "results") return lazyPage("./recall-results.js", "Recall results",
      (m, e) => m.mountRecallResults(e, { staff: currentStaff }))(el, param);
    return recallPage(el, param);
  },
  prospects: lazyPage(`./prospects.js?v=${PROSPECTS_V}`, "The Prospect Dashboard",
    (m, el, param) => m.mountProspects(el, { param, staff: currentStaff })),
  settings: (el, param) => {
    const [top, sub = ""] = String(param || "").split("/");
    if (top === "recall") {
      if (sub === "flow") return lazyPage("./recall-flow.js", "The recall flow",
        (m, e) => m.mountRecallFlow(e, { staff: currentStaff }))(el, param);
      if (sub === "emails") return lazyPage("./recall-emails.js", "The email templates",
        (m, e) => m.mountRecallEmails(e, { staff: currentStaff }))(el, param);
      return recallSettingsPage(el, param);
    }
    if (top === "flows") return lazyPage("./email-flows.js", "Email flows",
      (m, e, p) => m.mountEmailFlows(e, { param: p, staff: currentStaff }))(el, param);
    return settingsPage(el, param);
  },
  help: lazyPage("./knowledge.js", "Help & how-to", (m, el, param) => m.mountKnowledge(el, { param, staff: currentStaff })),
  scanner: lazyPage("./scanner.js", "The Scanner", (m, el) => m.mountScanner(el, { staff: currentStaff })),
  paper: lazyPage(`./paper-records.js?v=${PAPER_V}`, "Paper records",
    (m, el) => m.mountPaperRecords(el, { staff: currentStaff })),
  seo: lazyPage("./seo.js", "SEO", (m, el, param) => m.mountSeo(el, { param, staff: currentStaff, can: (k) => can(k) })),
};
// Which permission each page needs ("admin" = Admins only)
const PAGE_PERM = {
  patients: "menu.patients", patient: "menu.patients", fill: "menu.patients", "form-record": "menu.patients",
  ssp: "ssp.create", calendar: "menu.calendar", forms: "menu.forms",
  "image-bank": "forms.build", "aftercare-bank": "forms.build", "specialist-bank": "menu.forms", "ssp-products": "ssp.config",
  tasks: "menu.tasks", inventory: "menu.inventory", reports: "menu.reports", staff: "admin", settings: "admin",
  scanner: "menu.scanner", paper: "paper.enter", seo: "menu.seo", prospects: "menu.prospects",
};

// Email flow builders who aren't Admins can open System configuration, but only its Email flows
const pageAllowed = (p, param = "") => {
  if (p === "recall") return can("recall.work") || can("recall.manage");
  if (p === "settings" && String(param).split("/")[0] === "recall") return can("recall.manage");
  if (p === "settings" && can("flows.build") && (!param || String(param).split("/")[0] === "flows")) return true;
  const need = PAGE_PERM[p];
  if (!need) return true;
  return need === "admin" ? isAdminNow() : can(need);
};
const firstAllowedPage = () => ["calendar", "patients", "tasks", "recall", "prospects", "inventory", "scanner", "reports", "seo", "forms", "staff", "help"].find(pageAllowed) || "";
const currentPage = () => location.hash.split("/")[1] || "";
const currentParam = () => { try { return decodeURIComponent(location.hash.split("/").slice(2).join("/")); } catch { return ""; } };

function applyNav() {
  els.navItems.forEach((a) => { a.hidden = !pageAllowed(a.dataset.page); });
}

function router() {
  if (!currentStaff) return;

  const [, page = "", ...rest] = location.hash.split("/");
  let param = "";
  try { param = decodeURIComponent(rest.join("/")); } catch { /* malformed URL, ignore */ }

  if (!PAGES[page] || !pageAllowed(page, param)) {
    const first = firstAllowedPage();
    if (first && first !== page) { location.replace(`#/${first}`); return; } // fires hashchange → router runs again
    els.navItems.forEach((a) => a.classList.remove("active"));
    els.content.innerHTML = `<section class="page"><div class="state"><strong>No access</strong>
      Your account doesn't have access to any pages yet. Please ask an Admin.</div></section>`;
    return;
  }
  // Not an Admin: System configuration only shows Email flows
  if (page === "settings" && !isAdminNow() && !["flows", "recall"].includes(param.split("/")[0])) {
    location.replace("#/settings/flows");
    return;
  }

  const navKey = ["patient", "fill", "form-record", "ssp"].includes(page) ? "patients"
    : ["image-bank", "aftercare-bank", "ssp-products", "specialist-bank"].includes(page) ? "forms"
    : page === "settings" && param.split("/")[0] === "recall" ? "recall" : page;
    els.navItems.forEach((a) => {
    const active = a.dataset.page === navKey;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  window.scrollTo(0, 0);
  if (page !== "patient") setRecordingPatient(null); // "Ready to record" only shows on a patient page
  routeSeq++;
  PAGES[page](els.content, param);
}

// Count in-app page changes so "Back" returns to wherever you came from
// (patient list or the calendar day). If the page was opened directly, go to the list.
let inAppNavs = 0;
window.addEventListener("hashchange", () => { inAppNavs++; router(); });

function goBack() {
  if (inAppNavs > 0) history.back();
  else location.hash = "#/patients";
}

/* ===================== START ===================== */

let accessTimer = null;
let lastAccessCheck = 0;

// What counts as "your access": role, injector, and the permissions as a set (order doesn't matter)
const accessSig = (s) => JSON.stringify([
  String((s && s.role) || "").toLowerCase(),
  !!(s && s.injector === true),
  [...((s && Array.isArray(s.perms)) ? s.perms : [])].sort(),
]);

// Picks up access changes made by an Admin (every 5 minutes, and when returning to the tab)
async function checkAccess() {
  if (!currentStaff || Date.now() - lastAccessCheck < 60000) return;
  lastAccessCheck = Date.now();
  const before = currentStaff;                    // access as it was before this check
  try {
    const res = await refreshAccess();
    if (!res || !res.changed || !currentStaff) return;
    const next = {
      ...currentStaff,
      role: res.role || currentStaff.role,
      perms: Array.isArray(res.perms) ? res.perms : currentStaff.perms,
      injector: typeof res.injector === "boolean" ? res.injector : currentStaff.injector,
    };
    if (accessSig(next) === accessSig(before)) return; // nothing that matters changed: stay quiet
    const had = new Set(before.perms || []);
    const has = new Set(next.perms || []);
    console.info("Access changed:", {
      role: before.role !== next.role ? `${before.role} → ${next.role}` : "same",
      added: [...has].filter((p) => !had.has(p)),
      removed: [...had].filter((p) => !has.has(p)),
    });
    currentStaff = next;
    setPerms(currentStaff);
    renderStaff(currentStaff);
    applyNav();
    initEndOfDay(currentStaff);
    refreshStartOfDayButton(currentStaff);
    if (!pageAllowed(currentPage(), currentParam())) router();
    showToast("Your access has been updated");
  } catch (err) {
    console.warn("Access check failed:", err);
  }
}
window.addEventListener("focus", checkAccess);

watchAuth((staff) => {
  if (staff) {
    const sameUser = currentStaff && currentStaff.uid === staff.uid;
    currentStaff = staff;
    setPerms(staff);
    renderStaff(staff);
    applyNav();
    if (sameUser) {
      initEndOfDay(staff); // access may have changed (e.g. made an injector)
      refreshStartOfDayButton(staff);
      initChat(staff);   // picks up a change to Admin access
      // A refreshed login token (access changed): keep the current page unless it's no longer allowed
      if (!pageAllowed(currentPage())) router();
      return;
    }
    showView("dashboard");
    initRecordingBar(staff);
    initSoapPanel(staff);
    router();
    warmPages();
    maybeShowStartOfDay(staff);
    initEndOfDay(staff, { onLogout: () => els.logoutBtn.click() }); // runs the usual "recording in progress" checks
    initChat(staff);
    clearInterval(accessTimer);
    accessTimer = setInterval(checkAccess, 5 * 60 * 1000);
    lastAccessCheck = 0;
    setTimeout(checkAccess, 3000);
  } else {
    clearInterval(accessTimer);
    currentStaff = null;
    els.content.innerHTML = ""; // remove patient data from the page on logout
    import("./patient-list.js").then((m) => m.clearPatientCache()).catch(() => {});
    closeStartOfDay();
    teardownEndOfDay();
    teardownChat();
    hideStartOfDayButton();
    closeTopbarMenu();
    suspendRecorder(); // stops the mic; any audio stays on this device for upload at next login
    closeSoapPanel();
    closeFormPicker();
    if (els.profileDialog.open) els.profileDialog.close();
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    resetLogin();
    showView("login");
    warmUpLogin(); // start Apps Script while the PIN is being typed
    setTimeout(() => els.pinInput.focus(), 50); // ready to type
  }
  // New version deployed? Logged-in staff get a "Refresh" bar; the login screen refreshes itself.
  initUpdateCheck({ canAutoReload: () => !currentStaff });
});