import { loginWithPin, logout, watchAuth, updateStaffName, warmUpLogin } from "./auth.js";
import { mountPatientList, clearPatientCache } from "./patient-list.js";
import { mountCalendar } from "./calendar.js";
import { mountPatientDashboard } from "./patient-dashboard.js";
import { escapeHtml, getInitials, showToast } from "./utils.js";
import { maybeShowStartOfDay, closeStartOfDay } from "./start-of-day.js";
import { initRecordingBar, setRecordingPatient } from "./recording-bar.js";
import { isRecorderBusy, suspendRecorder } from "./recorder.js";
import { initSoapPanel, closeSoapPanel, hasUnsavedNotes } from "./soap-panel.js";
import { confirmDialog } from "./dialog.js";
import { mountFormBuilder } from "./form-builder.js";
import { mountFormFill, mountFormRecord } from "./form-fill.js";
import { initFormPicker, closeFormPicker } from "./form-picker.js";
import { mountImageBank } from "./image-bank.js";
import { mountTaskManager } from "./task-manager.js";
import { mountAftercareBank } from "./aftercare-bank.js";
import { mountSspProductsPage } from "./ssp-products.js";
import { mountSspBuilder } from "./ssp-builder.js";
import { mountStaffManager } from "./staff-manager.js";
import { mountInventory } from "./inventory.js";
import { setPerms, can, isAdmin as isAdminNow, refreshAccess } from "./perms.js";
import { initUpdateCheck } from "./updates.js";
import { mountMyDashboard } from "./my-dashboard.js";

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

let currentStaff = null;
initFormPicker(els.content, { getStaff: () => currentStaff });

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
  if (isRecorderBusy() && !(await confirmDialog({
    title: "A recording is in progress",
    message: "Log out anyway? The recording stays saved on this computer and can be uploaded at your next login.",
    confirmLabel: "Log out",
    tone: "warning",
  }))) return;
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

const PAGES = {
  home: (el) => mountMyDashboard(el, { staff: currentStaff }),
  patients: (el) => mountPatientList(el),
  calendar: (el, param) => mountCalendar(el, param),
  forms: (el, param) => mountFormBuilder(el, { isAdmin: can("forms.build"), staff: currentStaff, templateId: param }),
  patient: (el, id) => mountPatientDashboard(el, id, { staff: currentStaff, onBack: goBack }),
  fill: (el, param) => mountFormFill(el, param, { staff: currentStaff }),
  "form-record": (el, id) => mountFormRecord(el, id, { staff: currentStaff }),
  "image-bank": (el) => mountImageBank(el, { isAdmin: can("forms.build") }),
  "aftercare-bank": (el) => mountAftercareBank(el, { isAdmin: can("forms.build"), staff: currentStaff }),
  "ssp-products": (el) => mountSspProductsPage(el, { isAdmin: can("ssp.config"), staff: currentStaff }),
  ssp: (el, param) => {
    const [, pid = ""] = String(param || "").split("/"); // #/ssp/new/<patientId>
    mountSspBuilder(el, { patientId: pid, staff: currentStaff, isAdmin: can("ssp.config") });
  },
  tasks: (el, param) => mountTaskManager(el, { param, isAdmin: can("tasks.build"), staff: currentStaff }),
  inventory: (el, param) => mountInventory(el, { param, staff: currentStaff }),
  staff: (el) => mountStaffManager(el, { staff: currentStaff }),
};

// Which permission each page needs ("admin" = Admins only)
const PAGE_PERM = {
  patients: "menu.patients", patient: "menu.patients", fill: "menu.patients", "form-record": "menu.patients",
  ssp: "ssp.create", calendar: "menu.calendar", forms: "menu.forms",
  "image-bank": "forms.build", "aftercare-bank": "forms.build", "ssp-products": "ssp.config",
  tasks: "menu.tasks", inventory: "menu.inventory", staff: "admin",
};
const pageAllowed = (p) => {
  const need = PAGE_PERM[p];
  if (!need) return true;
  return need === "admin" ? isAdminNow() : can(need);
};
const firstAllowedPage = () => ["calendar", "patients", "tasks", "inventory", "forms", "staff"].find(pageAllowed) || "";
const currentPage = () => location.hash.split("/")[1] || "";

function applyNav() {
  els.navItems.forEach((a) => { a.hidden = !pageAllowed(a.dataset.page); });
}

function router() {
  if (!currentStaff) return;

  const [, page = "", ...rest] = location.hash.split("/");
  if (!PAGES[page] || !pageAllowed(page)) {
    const first = firstAllowedPage();
    if (first && first !== page) { location.replace(`#/${first}`); return; } // fires hashchange → router runs again
    els.navItems.forEach((a) => a.classList.remove("active"));
    els.content.innerHTML = `<section class="page"><div class="state"><strong>No access</strong>
      Your account doesn't have access to any pages yet. Please ask an Admin.</div></section>`;
    return;
  }

  let param = "";
  try { param = decodeURIComponent(rest.join("/")); } catch { /* malformed URL, ignore */ }

  const navKey = ["patient", "fill", "form-record", "ssp"].includes(page) ? "patients"
    : ["image-bank", "aftercare-bank", "ssp-products"].includes(page) ? "forms" : page;
    els.navItems.forEach((a) => {
    const active = a.dataset.page === navKey;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  window.scrollTo(0, 0);
  if (page !== "patient") setRecordingPatient(null); // "Ready to record" only shows on a patient page
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

// Picks up access changes made by an Admin (every 5 minutes, and when returning to the tab)
async function checkAccess() {
  if (!currentStaff || Date.now() - lastAccessCheck < 60000) return;
  lastAccessCheck = Date.now();
  try {
    const res = await refreshAccess();
    if (!res.changed || !currentStaff) return;
    currentStaff = { ...currentStaff, role: res.role, perms: res.perms };
    setPerms(currentStaff);
    renderStaff(currentStaff);
    applyNav();
    if (!pageAllowed(currentPage())) router();
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
      // A refreshed login token (access changed): keep the current page unless it's no longer allowed
      if (!pageAllowed(currentPage())) router();
      return;
    }
    showView("dashboard");
    initRecordingBar(staff);
    initSoapPanel(staff);
    router();
    maybeShowStartOfDay(staff);
    clearInterval(accessTimer);
    accessTimer = setInterval(checkAccess, 5 * 60 * 1000);
    lastAccessCheck = 0;
    setTimeout(checkAccess, 3000);
  } else {
    clearInterval(accessTimer);
    currentStaff = null;
    els.content.innerHTML = ""; // remove patient data from the page on logout
    clearPatientCache();
    closeStartOfDay();
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