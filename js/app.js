import { loginWithPin, logout, watchAuth, updateStaffName } from "./auth.js";
import { mountPatientList } from "./patient-list.js";
import { escapeHtml, getInitials } from "./utils.js";

const PIN_LENGTH = 4; // change to 6 if you move to 6-digit PINs

const $ = (id) => document.getElementById(id);

const views = {
  boot: $("boot-view"),
  login: $("login-view"),
  dashboard: $("dashboard-view"),
};

const els = {
  // login
  pinDots: $("pin-dots"),
  loginError: $("login-error"),
  keypad: $("keypad"),
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

let pin = "";
let busy = false;

function renderDots(state = "") {
  els.pinDots.className = `pin-dots ${state}`.trim();
  els.pinDots.innerHTML = Array.from({ length: PIN_LENGTH }, (_, i) =>
    `<span class="dot${i < pin.length ? " filled" : ""}"></span>`
  ).join("");
}

function setBusy(value) {
  busy = value;
  els.keypad.querySelectorAll("button").forEach((b) => (b.disabled = value));
}

function handleKey(key) {
  if (busy) return;
  if (key === "back") pin = pin.slice(0, -1);
  else if (key === "clear") pin = "";
  else if (/^\d$/.test(key) && pin.length < PIN_LENGTH) pin += key;
  els.loginError.textContent = "";
  renderDots();
  if (pin.length === PIN_LENGTH) submitPin();
}

async function submitPin() {
  setBusy(true);
  renderDots("checking");
  try {
    await loginWithPin(pin);
    pin = "";
  } catch (err) {
    pin = "";
    els.loginError.textContent = err.message;
    renderDots("error");
  } finally {
    setBusy(false);
  }
}

els.keypad.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-key]");
  if (btn) handleKey(btn.dataset.key);
});

document.addEventListener("keydown", (e) => {
  if (views.login.hidden) return;
  if (/^\d$/.test(e.key)) handleKey(e.key);
  else if (e.key === "Backspace") handleKey("back");
  else if (e.key === "Escape") handleKey("clear");
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
  calendar: (el) => {
    el.innerHTML = placeholderPage("Calendar", "The appointments calendar will live here.");
  },
  patient: (el, id) => {
    el.innerHTML = placeholderPage(
      "Patient profile",
      `The dashboard for record ${id} is the next thing we'll build.`,
      `<a class="back-link" href="#/patients">← Back to patient list</a>`
    );
  },
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

window.addEventListener("hashchange", router);

/* ===================== START ===================== */

renderDots();

watchAuth((staff) => {
  if (staff) {
    currentStaff = staff;
    renderStaff(staff);
    showView("dashboard");
    router();
  } else {
    currentStaff = null;
    els.content.innerHTML = ""; // remove patient data from the page on logout
    if (els.profileDialog.open) els.profileDialog.close();
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    pin = "";
    renderDots();
    els.loginError.textContent = "";
    showView("login");
  }
});