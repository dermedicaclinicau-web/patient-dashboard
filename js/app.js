import { getCurrentPatient, getAppointments } from "./data.js";

const $ = (id) => document.getElementById(id);

const els = {
  patientName: $("patient-name"),
  upcomingList: $("upcoming-list"),
  pastList: $("past-list"),
  upcomingCount: $("upcoming-count"),
  pastCount: $("past-count"),
  nextAppt: $("next-appointment"),
  errorBanner: $("error-banner"),
  tabs: document.querySelectorAll(".tab"),
};

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });

// Always escape data before injecting into HTML. This matters once data comes from Firestore.
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function splitAppointments(appts, now = new Date()) {
  const upcoming = appts
    .filter((a) => a.dateTime >= now && a.status === "scheduled")
    .sort((a, b) => a.dateTime - b.dateTime);          // soonest first

  const past = appts
    .filter((a) => !(a.dateTime >= now && a.status === "scheduled"))
    .sort((a, b) => b.dateTime - a.dateTime);          // most recent first

  return { upcoming, past };
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

async function init() {
  setupTabs();
  try {
    const patient = await getCurrentPatient();
    els.patientName.textContent = patient.name;

    const appts = await getAppointments(patient.id);
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
    els.errorBanner.hidden = false;
  }
}

init(); // module scripts are deferred, so the DOM is already parsed here