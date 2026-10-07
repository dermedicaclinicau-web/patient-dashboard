import { getCurrentPatient, getAppointments } from "./data.js";
import { loginWithPin, logout, watchAuth } from "./auth.js";

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
  // header
  staffName: $("staff-name"),
  staffRole: $("staff-role"),
  staffPhoto: $("staff-photo"),
  staffInitials: $("staff-initials"),
  logoutBtn: $("logout-btn"),
  // dashboard
  patientName: $("patient-name"),
  upcomingList: $("upcoming-list"),
  pastList: $("past-list"),
  upcomingCount: $("upcoming-count"),
  pastCount: $("past-count"),
  nextAppt: $("next-appointment"),
  errorBanner: $("error-banner"),
  tabs: document.querySelectorAll(".tab"),
};

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
    pin = ""; // watchAuth switches to the dashboard
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

/* ===================== STAFF HEADER ===================== */

function getInitials(name) {
  return name.trim().split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}

function renderStaff(staff) {
  els.staffName.textContent = staff.name;
  els.staffRole.textContent = staff.role;
  els.staffInitials.textContent = getInitials(staff.name);
  if (staff.photo) {
    els.staffPhoto.hidden = false;
    els.staffPhoto.src = staff.photo;
  } else {
    els.staffPhoto.hidden = true;
  }
}

// If the photo URL is broken, fall back to initials
els.staffPhoto.addEventListener("error", () => { els.staffPhoto.hidden = true; });

els.logoutBtn.addEventListener("click", () => logout());

/* ===================== DASHBOARD ===================== */

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function splitAppointments(appts, now = new Date()) {
  const isUpcoming = (a) => a.dateTime >= now && a.status === "scheduled";
  return {
    upcoming: appts.filter(isUpcoming).sort((a, b) => a.dateTime - b.dateTime),
    past: appts.filter((a) => !isUpcoming(a)).sort((a, b) => b.dateTime - a.dateTime),
  };
}

function appointmentCard(a) {
  return `
    <li class="appt-card">
      <div class="appt-date">
        <span class="day">${a.dateTime.getDate()}</span>
        <span class="month">${monthFmt.format(a.dateTime)}</span>
      </div>
      <div class="appt-body">
        <h3>${escapeHtml(a.department)}</h3>
        <p>${escapeHtml(a.doctor)} · ${timeFmt.format(a.dateTime)}</p>
        ${a.notes ? `<p class="notes">${escapeHtml(a.notes)}</p>` : ""}
      </div>
      <span class="status status-${escapeHtml(a.status)}">${escapeHtml(a.status)}</span>
    </li>`;
}

function renderList(listEl, appts, emptyMsg) {
  listEl.innerHTML = appts.length
    ? appts.map(appointmentCard).join("")
    : `<li class="empty">${emptyMsg}</li>`;
}

function setupTabs() {
  els.tabs.forEach((tab) =>
    tab.addEventListener("click", () => {
      els.tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
        $(t.dataset.target).hidden = !active;
      });
    })
  );
}

// Guards against a slow load finishing AFTER logout and re-filling the page
let loadSeq = 0;

function resetDashboard() {
  loadSeq++;
  els.patientName.textContent = "…";
  els.upcomingCount.textContent = els.pastCount.textContent = els.nextAppt.textContent = "–";
  els.upcomingList.innerHTML = els.pastList.innerHTML = '<li class="empty">Loading…</li>';
  els.errorBanner.hidden = true;
}

async function loadDashboard() {
  const seq = ++loadSeq;
  try {
    const patient = await getCurrentPatient();
    if (seq !== loadSeq) return;
    els.patientName.textContent = patient.name;

    const appts = await getAppointments(patient.id);
    if (seq !== loadSeq) return;

    const { upcoming, past } = splitAppointments(appts);
    els.upcomingCount.textContent = upcoming.length;
    els.pastCount.textContent = past.length;
    els.nextAppt.textContent = upcoming[0]
      ? `${dateFmt.format(upcoming[0].dateTime)}, ${timeFmt.format(upcoming[0].dateTime)}`
      : "None scheduled";

    renderList(els.upcomingList, upcoming, "No upcoming appointments.");
    renderList(els.pastList, past, "No past appointments yet.");
  } catch (err) {
    console.error("Dashboard load failed:", err);
    if (seq === loadSeq) els.errorBanner.hidden = false;
  }
}

/* ===================== START ===================== */

setupTabs();
renderDots();

watchAuth((staff) => {
  if (staff) {
    renderStaff(staff);
    showView("dashboard");
    loadDashboard();
  } else {
    resetDashboard(); // clear data from the page on logout
    pin = "";
    renderDots();
    els.loginError.textContent = "";
    showView("login");
  }
});