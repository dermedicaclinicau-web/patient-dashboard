import { loginWithPin, logout, watchAuth, updateStaffName, warmUpLogin } from "./auth.js";
import { mountPatientList, clearPatientCache } from "./patient-list.js";
import { mountCalendar } from "./calendar.js";
import { mountPatientDashboard } from "./patient-dashboard.js";
import { escapeHtml, getInitials } from "./utils.js";

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
}

els.staffPhoto.addEventListener("error", () => { els.staffPhoto.hidden = true; });
els.logoutBtn.addEventListener("click", () => logout());

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
  patients: (el) => mountPatientList(el),
  calendar: (el, param) => mountCalendar(el, param),
  patient: (el, id) => mountPatientDashboard(el, id, { staff: currentStaff, onBack: goBack }),
};

function router() {
  if (!currentStaff) return;

  const [, page = "", ...rest] = location.hash.split("/");
  if (!PAGES[page]) {
    location.replace("#/patients"); // fires hashchange → router runs again
    return;
  }

  let param = "";
  try { param = decodeURIComponent(rest.join("/")); } catch { /* malformed URL, ignore */ }

  const navKey = page === "patient" ? "patients" : page;
  els.navItems.forEach((a) => {
    const active = a.dataset.page === navKey;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  window.scrollTo(0, 0);
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

watchAuth((staff) => {
  if (staff) {
    currentStaff = staff;
    renderStaff(staff);
    showView("dashboard");
    router();
  } else {
    currentStaff = null;
    els.content.innerHTML = ""; // remove patient data from the page on logout
    clearPatientCache();
    if (els.profileDialog.open) els.profileDialog.close();
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    resetLogin();
    showView("login");
    warmUpLogin(); // start Apps Script while the PIN is being typed
    setTimeout(() => els.pinInput.focus(), 50); // ready to type
  }
});