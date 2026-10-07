import { fetchDayAppointments } from "./appointments.js";
import { logout } from "./auth.js";
import {
  escapeHtml, hueFromString, toDateKey, parseDateKey, addDays,
  formatLongDate, formatShortDate, formatUpdated,
} from "./utils.js";

// Column order. Names must match Column I EXACTLY. Unlisted staff appear after, A–Z.
const STAFF_ORDER = ["Dr Joanna Teh", "Jacquie", "Allie", "Dermedica Clinician", "Park Room"];

// [header background, header underline]
const COLUMN_COLOURS = [
  ["#f8f0cf", "#e9d98f"], ["#ecf6d6", "#cfe6a1"], ["#ecdcf7", "#c9a6e8"],
  ["#d9f4ef", "#9fded3"], ["#d9f5dc", "#a3e0aa"], ["#fde4d9", "#f3b79d"], ["#dde8fb", "#a9c3f0"],
];

const ICON_CAL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const ICON_REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;

export function mountCalendar(container, param) {
  let dateKey = parseDateKey(param) ? param : toDateKey();
  const cache = new Map(); // dateKey -> data, for this visit only
  let seq = 0;

  container.innerHTML = `
    <section class="page wide">
      <div class="page-head"><h2>Daily Schedule</h2></div>

      <div class="cal-toolbar">
        <div class="cal-nav">
          <button type="button" class="btn-ghost icon-only" data-nav="prev" aria-label="Previous day">‹</button>
          <button type="button" class="btn-ghost" data-nav="today">Today</button>
          <button type="button" class="btn-ghost icon-only" data-nav="next" aria-label="Next day">›</button>
          <div class="date-picker" role="button" tabindex="0" aria-label="Choose a date">
            ${ICON_CAL}<span class="date-label"></span>
            <input type="date" class="date-input" tabindex="-1" aria-hidden="true" />
          </div>
        </div>

        <div class="cal-title">
          <h3 class="cal-heading"></h3>
          <p class="cal-updated"></p>
        </div>

        <div class="cal-actions">
          <button type="button" class="btn-ghost cal-refresh">${ICON_REFRESH}<span>Refresh</span></button>
        </div>
      </div>

      <div class="cal-board"></div>
    </section>`;

  const q = (sel) => container.querySelector(sel);
  const heading = q(".cal-heading");
  const updated = q(".cal-updated");
  const dateLabel = q(".date-label");
  const dateInput = q(".date-input");
  const datePicker = q(".date-picker");
  const todayBtn = q("[data-nav='today']");
  const refreshBtn = q(".cal-refresh");
  const board = q(".cal-board");

  function renderHeader() {
    const d = parseDateKey(dateKey);
    heading.textContent = formatLongDate(d);
    dateLabel.textContent = formatShortDate(d);
    dateInput.value = dateKey;
    todayBtn.classList.toggle("is-today", dateKey === toDateKey());
    // Update the URL without re-running the router
    history.replaceState(null, "", `#/calendar/${dateKey}`);
  }

  async function load(force = false) {
    const mySeq = ++seq;
    renderHeader();

    if (!force && cache.has(dateKey)) {
      refreshBtn.disabled = false;
      renderBoard(cache.get(dateKey));
      return;
    }

    board.innerHTML = skeletonBoard();
    updated.textContent = "Loading…";
    refreshBtn.disabled = true;

    try {
      const data = await fetchDayAppointments(dateKey);
      if (mySeq !== seq) return; // user already moved to another day
      cache.set(dateKey, data);
      renderBoard(data);
    } catch (err) {
      if (mySeq !== seq) return;
      console.error("Calendar load failed:", err);
      updated.textContent = "";
      board.innerHTML = errorState(err);
    } finally {
      if (mySeq === seq) refreshBtn.disabled = false;
    }
  }

  function renderBoard(data) {
    updated.textContent = data.lastUpdated
      ? `Data last uploaded: ${formatUpdated(new Date(data.lastUpdated))}`
      : "";

    const appts = data.appointments || [];
    if (!appts.length) {
      board.innerHTML = `<div class="state"><strong>No appointments</strong>Nothing is scheduled for this day.</div>`;
      return;
    }

    const byStaff = new Map();
    for (const a of appts) {
      if (!byStaff.has(a.staff)) byStaff.set(a.staff, []);
      byStaff.get(a.staff).push(a);
    }

    board.innerHTML = `<div class="cal-columns">${
      sortStaff([...byStaff.keys()]).map((name) => staffColumn(name, byStaff.get(name))).join("")
    }</div>`;
  }

  // Navigation
  container.querySelectorAll("[data-nav]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const nav = btn.dataset.nav;
      dateKey = nav === "today" ? toDateKey() : addDays(dateKey, nav === "next" ? 1 : -1);
      load();
    })
  );

  // Date picker: open the native calendar popup
  const openPicker = () => {
    try { dateInput.showPicker(); } catch { dateInput.focus(); }
  };
  datePicker.addEventListener("click", openPicker);
  datePicker.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
  });
  dateInput.addEventListener("change", () => {
    if (parseDateKey(dateInput.value)) {
      dateKey = dateInput.value;
      load();
    }
  });

  refreshBtn.addEventListener("click", () => load(true));

  board.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "retry") load(true);
    if (btn.dataset.action === "relogin") logout();
  });

  load();
}

/* ---------- helpers & templates ---------- */

function staffRank(name) {
  const i = STAFF_ORDER.findIndex((s) => s.toLowerCase() === name.toLowerCase());
  return i === -1 ? Infinity : i;
}

function sortStaff(names) {
  return names.sort((a, b) => staffRank(a) - staffRank(b) || a.localeCompare(b));
}

// Same staff = same colour every day
function coloursFor(name) {
  const rank = staffRank(name);
  const i = rank === Infinity ? hueFromString(name) : rank;
  return COLUMN_COLOURS[i % COLUMN_COLOURS.length];
}

function staffColumn(name, appts) {
  const [bg, line] = coloursFor(name);
  appts.sort((a, b) => a.sortMinutes - b.sortMinutes || a.patientName.localeCompare(b.patientName));
  return `
    <div class="cal-col" style="--col-bg:${bg};--col-line:${line}">
      <div class="cal-col-head">${escapeHtml(name)}</div>
      <div class="cal-col-body">${appts.map(apptCard).join("")}</div>
    </div>`;
}

// Cancelled / no-show = greyed out; completed / arrived = green
function statusClass(s) {
  const v = String(s || "").toLowerCase();
  if (/cancel|no.?show|\bdna\b|did not attend/.test(v)) return "is-cancelled";
  if (/complete|arrived|checked|attended|paid/.test(v)) return "is-done";
  return "";
}

function parseBalance(b) {
  const n = Number(String(b || "").replace(/[^0-9.-]/g, ""));
  return isFinite(n) ? n : 0;
}

function apptCard(a) {
  const services = (a.services || [])
    .map((s) => `<span class="appt-service">${escapeHtml(s)}</span>`)
    .join("");

  const cls = statusClass(a.status);
  const balance = parseBalance(a.balance);
  const extras = [
    a.status ? `<span class="appt-status ${cls}">${escapeHtml(a.status)}</span>` : "",
    balance > 0 ? `<span class="appt-balance">$${balance.toFixed(2)} owing</span>` : "",
  ].join("");

  const inner = `
    <span class="appt-time">${escapeHtml(a.time || "—")}</span>
    <span class="appt-name">${escapeHtml(a.patientName || "Unknown patient")}</span>
    ${services ? `<span class="appt-services">${services}</span>` : ""}
    ${extras ? `<span class="appt-extras">${extras}</span>` : ""}`;

  const title = escapeHtml([a.timeRange || a.time, a.resources].filter(Boolean).join(" · "));
  const classes = `appt ${cls}`.trim();

  return a.patientId
    ? `<a class="${classes}" href="#/patient/${encodeURIComponent(a.patientId)}" title="${title}">${inner}</a>`
    : `<div class="${classes}" title="${title}">${inner}</div>`;
}

function skeletonBoard() {
  const col = `<div class="skel-col"><div class="skeleton head"></div>${
    `<div class="skeleton"></div>`.repeat(4)
  }</div>`;
  return `<div class="cal-columns">${col.repeat(4)}</div>`;
}

function errorState(err) {
  if (err && err.code === "UNAUTHORIZED") {
    return `<div class="state error"><strong>Session expired</strong>${escapeHtml(err.message)}<br>
      <button type="button" class="btn-ghost sm retry" data-action="relogin">Log in again</button></div>`;
  }
  return `<div class="state error"><strong>Couldn't load the schedule</strong>${escapeHtml(err.message)}<br>
    <button type="button" class="btn-ghost sm retry" data-action="retry">Try again</button></div>`;
}