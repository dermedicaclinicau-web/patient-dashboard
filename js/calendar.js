import { fetchDayAppointments } from "./appointments.js";
import { fetchDayBadges } from "./calendar-badges.js";
import { logout } from "./auth.js";
import { openEndOfDay, endOfDayStatus } from "./end-of-day.js";
import { minToText } from "./shift.js";
import {
  escapeHtml, hueFromString, toDateKey, parseDateKey, addDays,
  formatLongDate, formatShortDate, formatUpdated, showToast,
} from "./utils.js";
import { can } from "./perms.js";
import { confirmDialog } from "./dialog.js";
import { openBookingDialog } from "./booking-dialog.js";
import { removeManualAppt } from "./manual-appts.js";

// Column order, left to right. Each entry matches any staff name that CONTAINS it as whole words
// (capitals, dots and spaces don't matter): "Teh" matches "Dr Joanna Teh" and "Dr. Teh".
// Staff not listed come next, A–Z. "Unassigned" is always last.
const STAFF_ORDER = ["Teh", "Jacquie", "Allie", "Dermedica Clinician", "Park Room"];

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
  const badgeCache = new Map(); // dateKey -> badgesFor(), for this visit only
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
          ${can("calendar.book") ? '<button type="button" class="btn-primary cal-addbook" data-addbook>+ Add booking</button>' : ""}
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
  let shown = [];   // the day's appointments on the board (to find a booking to edit)

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
    if (force) badgeCache.delete(dateKey);
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
    shown = appts;
    if (!appts.length) {
      board.innerHTML = `<div class="state"><strong>No appointments</strong>Nothing is scheduled for this day.</div>`;
      return;
    }

    appts.forEach((a, i) => { a._i = i; }); // lets badges find their card later
    const byStaff = new Map();
    for (const a of appts) {
      if (!byStaff.has(a.staff)) byStaff.set(a.staff, []);
      byStaff.get(a.staff).push(a);
    }

    board.innerHTML = `<div class="cal-columns">${
      sortStaff([...byStaff.keys()]).map((name) => staffColumn(name, byStaff.get(name))).join("")
    }</div>`;

    paintEod();
    loadBadges(appts);
  }

  // The red End of Day button under the logged-in clinician's column (today only)
  function paintEod() {
    if (!board.isConnected) return;
    const slots = [...board.querySelectorAll(".cal-eod-slot")];
    slots.forEach((el) => { el.innerHTML = ""; });
    const s = endOfDayStatus();
    if (!s.show || !s.name || dateKey !== toDateKey()) return;
    const slot = slots.find((el) => isMyColumn(el.dataset.eodCol, s.name, s.apptName));
    if (slot) slot.innerHTML = eodButtonHtml(s);
  }

  // Follows the day as it goes: red → flashing → Day ended (checked every minute, and straight after saving)
  const onEodStatus = () => {
    if (!board.isConnected) { window.removeEventListener("eod:status", onEodStatus); return; }
    paintEod();
  };
  window.addEventListener("eod:status", onEodStatus);

    // Badges load after the schedule is shown, so they never slow it down
  async function loadBadges(appts) {
    const key = dateKey;
    const mySeq = seq;
    try {
      let badgesFor = badgeCache.get(key);
      if (!badgesFor) {
        badgesFor = await fetchDayBadges(key, appts);
        badgeCache.set(key, badgesFor);
      }
      if (mySeq !== seq || !board.isConnected) return; // user moved to another day

      board.querySelectorAll(".appt[data-i]").forEach((card) => {
        const a = appts[Number(card.dataset.i)];
        const slot = card.querySelector(".appt-badges");
        if (a && slot) slot.innerHTML = badgesFor(a).map(badgeHtml).join("");
      });
    } catch (err) {
      console.warn("Calendar badges failed:", err);
    }
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

  /* ---------- Bookings added here ---------- */
  // Names and services from the days already looked at, for the suggestions
  function known(pick) {
    const out = new Set();
    cache.forEach((d) => (d.appointments || []).forEach((a) => pick(a).forEach((v) => { if (v) out.add(v); })));
    return [...out];
  }
  function bookingChanged(key) {
    cache.delete(key);
    badgeCache.delete(key);
    window.dispatchEvent(new Event("appts:changed"));   // End of Day works out the finish time again
  }
  async function openBooking(defaults = {}, existing = null) {
    const res = await openBookingDialog({
      dateKey,
      defaultStaff: defaults.staff || "",
      staffNames: known((a) => [a.staff]).filter((s) => !/^unassigned$/i.test(s)),
      services: known((a) => a.services || []),
      existing,
    });
    if (!res) return;
    bookingChanged(res.dateKey);
    if (existing && existing.dateKey !== res.dateKey) bookingChanged(existing.dateKey);
    if (res.dateKey === dateKey) {
      load(true);
      showToast(existing ? "Booking updated" : "Booking added. Remember to book it in Timely too.");
    } else {
      load(true);
      showToast(`Booking saved for ${formatShortDate(parseDateKey(res.dateKey))}.`);
    }
  }
  async function removeBooking(a) {
    const ok = await confirmDialog({
      title: "Remove this booking?",
      message: `${a.patientName} at ${a.time} with ${a.staff}. This only removes it from the portal calendar, not from Timely.`,
      confirmLabel: "Remove", tone: "warning",
    });
    if (!ok) return;
    try {
      await removeManualAppt(a.manualId);
      bookingChanged(dateKey);
      load(true);
      showToast("Booking removed");
    } catch (err) {
      console.error("Remove booking failed:", err);
      showToast(err && err.code === "permission-denied"
        ? "Not allowed. Check your “Add bookings” access." : "Couldn't remove it. Try again.");
    }
  }
  const addBtn = q("[data-addbook]");
  if (addBtn) addBtn.addEventListener("click", () => openBooking());

  board.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "retry") load(true);
    if (btn.dataset.action === "relogin") logout();
    if (btn.dataset.action === "eod") openEndOfDay();
    if (btn.dataset.action === "mappt-add") openBooking({ staff: btn.dataset.staff || "" });
    if (btn.dataset.action === "mappt-edit" || btn.dataset.action === "mappt-remove") {
      e.preventDefault();
      const a = shown.find((x) => x.manualId === btn.dataset.id);
      if (!a) return;
      if (btn.dataset.action === "mappt-edit") openBooking({}, a);
      else removeBooking(a);
    }
  });

  load();
}

/* ---------- helpers & templates ---------- */

const UNLISTED = 1000;   // staff not in STAFF_ORDER
const LAST = 2000;       // "Unassigned"
const normName = (s) => ` ${String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

function staffRank(name) {
  const n = normName(name);
  if (n.trim() === "unassigned") return LAST;
  const i = STAFF_ORDER.findIndex((s) => n.includes(normName(s)));
  return i === -1 ? UNLISTED : i;
}

function sortStaff(names) {
  return names.sort((a, b) => staffRank(a) - staffRank(b) || a.localeCompare(b));
}

// Same staff = same colour every day
function coloursFor(name) {
  const rank = staffRank(name);
  const i = rank < STAFF_ORDER.length ? rank : hueFromString(name);
  return COLUMN_COLOURS[i % COLUMN_COLOURS.length];
}

function staffColumn(name, appts) {
  const [bg, line] = coloursFor(name);
  appts.sort((a, b) => a.sortMinutes - b.sortMinutes || a.patientName.localeCompare(b.patientName));
  return `
    <div class="cal-col" style="--col-bg:${bg};--col-line:${line}">
      <div class="cal-col-head">${escapeHtml(name)}${can("calendar.book") && !/^unassigned$/i.test(name)
        ? `<button type="button" class="cal-col-add" data-action="mappt-add" data-staff="${escapeHtml(name)}"
            aria-label="Add a booking with ${escapeHtml(name)}" title="Add a booking with ${escapeHtml(name)}">+</button>` : ""}</div>
      <div class="cal-col-body">${groupVisits(appts).map((g) => (g.length > 1 ? visitCard(g) : apptCard(g[0]))).join("")}<div class="cal-eod-slot" data-eod-col="${escapeHtml(name)}"></div></div>
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
/* ---------- One card per visit ---------- */

// A later booking for the same patient in the same column joins their visit
// if it starts within this many minutes of their previous booking
const VISIT_GAP_MIN = 90;

// Who a booking is for. Portal bookings ("") always get their own card, for Edit and Remove.
function visitKey(a) {
  if (a.manual) return "";
  const id = String(a.patientId || "").trim();
  if (id) return "id:" + id;
  const n = String(a.patientName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return n && n !== "unknown patient" ? "n:" + n : "";
}

// appts are already in time order. Returns [[a], [a, a, a], …] in order of each visit's first booking.
function groupVisits(appts) {
  const out = [];
  const open = new Map();   // patient → their latest visit
  for (const a of appts) {
    const k = visitKey(a);
    const g = k ? open.get(k) : null;
    if (g && a.sortMinutes - g[g.length - 1].sortMinutes <= VISIT_GAP_MIN) { g.push(a); continue; }
    const visit = [a];
    out.push(visit);
    if (k) open.set(k, visit);
  }
  return out;
}

// "1:00 pm - 1:15 pm" → "1:15 pm" (falls back to the start time)
function endTime(a) {
  const m = String(a.timeRange || "").match(/[-–]\s*([0-9].*)$/);
  return m ? m[1].trim() : (a.time || "");
}

// Several bookings in a row: one card, each treatment with its own time
function visitCard(group) {
  const first = group[0];
  const last = group[group.length - 1];
  const lineCls = group.map((a) => statusClass(a.status));
  const cls = lineCls.every((c) => c === "is-cancelled") ? "is-cancelled"
    : lineCls.every((c) => c === "is-done") ? "is-done" : "";

  const statuses = [...new Set(group.map((a) => String(a.status || "").trim()).filter(Boolean))];
  const perLine = statuses.length > 1;   // different statuses: show each one on its line

  const lines = group.map((a, i) => {
    const svc = (a.services || []).join(", ") || "Appointment";
    const off = lineCls[i] === "is-cancelled";
    const st = perLine && a.status
      ? ` <em class="appt-sstat ${lineCls[i]}">${escapeHtml(a.status)}</em>` : "";
    return `<span class="appt-service is-timed${off ? " is-off" : ""}"><b>${escapeHtml(a.time || "—")}</b><span>${escapeHtml(svc)}${st}</span></span>`;
  }).join("");

  const balance = Math.max(0, ...group.map((a) => parseBalance(a.balance)));   // the balance repeats on each booking
  const extras = [
    !perLine && statuses.length ? `<span class="appt-status ${cls}">${escapeHtml(statuses[0])}</span>` : "",
    balance > 0 ? `<span class="appt-balance">$${balance.toFixed(2)} owing</span>` : "",
  ].join("");

  const inner = `
    <span class="appt-time">${escapeHtml(first.time || "—")} – ${escapeHtml(endTime(last))}<span class="appt-count">${group.length} bookings</span></span>
    <span class="appt-name">${escapeHtml(first.patientName || "Unknown patient")}</span>
    <span class="appt-badges"></span>
    <span class="appt-services is-visit">${lines}</span>
    ${extras ? `<span class="appt-extras">${extras}</span>` : ""}`;

  const title = escapeHtml(group.map((a) =>
    [a.timeRange || a.time, (a.services || []).join(", "), a.resources].filter(Boolean).join(" · ")).join("\n"));
  const classes = `appt is-visit ${cls}`.trim();
  const idx = Number.isInteger(first._i) ? ` data-i="${first._i}"` : "";   // badges: same patient for every booking

  return first.patientId
    ? `<a class="${classes}"${idx} href="#/patient/${encodeURIComponent(first.patientId)}" title="${title}">${inner}</a>`
    : `<div class="${classes}"${idx} title="${title}">${inner}</div>`;
}
const BADGES = {
  plan: ["Plan", "cb-plan"],
  summary: ["Summary", "cb-summary"],
  tx: ["TxR", "cb-tx"],
  consent: ["ConsentR", "cb-consent"],
  rx: ["Prex", "cb-rx"],
};

function badgeHtml(type) {
  const [label, cls] = BADGES[type];
  return `<span class="cb ${cls}">${label}</span>`;
}

// A booking added in the portal: tagged, with Edit and Remove
function manualCard(a) {
  const services = (a.services || []).map((s) => `<span class="appt-service">${escapeHtml(s)}</span>`).join("");
  const name = escapeHtml(a.patientName || "Unknown patient");
  const idx = Number.isInteger(a._i) ? ` data-i="${a._i}"` : "";
  const id = escapeHtml(a.manualId);
  return `<div class="appt is-manual${a.notInTimely ? " is-missing" : ""}"${idx} title="${escapeHtml([a.timeRange, a.note].filter(Boolean).join(" · "))}">
    <span class="appt-time">${escapeHtml(a.time || "—")}</span>
    ${a.patientId ? `<a class="appt-name" href="#/patient/${encodeURIComponent(a.patientId)}">${name}</a>` : `<span class="appt-name">${name}</span>`}
    <span class="appt-badges"></span>
    ${services ? `<span class="appt-services">${services}</span>` : ""}
    ${a.note ? `<span class="appt-note">${escapeHtml(a.note)}</span>` : ""}
    <span class="appt-manual-tag">${a.notInTimely ? "Not in Timely yet" : "Added in portal"}${a.createdBy ? ` · ${escapeHtml(a.createdBy)}` : ""}</span>
    ${can("calendar.book") ? `<span class="appt-manual-acts">
      <button type="button" data-action="mappt-edit" data-id="${id}">Edit</button>
      <button type="button" data-action="mappt-remove" data-id="${id}">Remove</button></span>` : ""}
  </div>`;
}

function apptCard(a) {
  if (a.manual) return manualCard(a);
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
    <span class="appt-badges"></span>
    ${services ? `<span class="appt-services">${services}</span>` : ""}
    ${extras ? `<span class="appt-extras">${extras}</span>` : ""}`;

  const title = escapeHtml([a.timeRange || a.time, a.resources].filter(Boolean).join(" · "));
  const classes = `appt ${cls}`.trim();
  const idx = Number.isInteger(a._i) ? ` data-i="${a._i}"` : "";

  return a.patientId
    ? `<a class="${classes}"${idx} href="#/patient/${encodeURIComponent(a.patientId)}" title="${title}">${inner}</a>`
    : `<div class="${classes}"${idx} title="${title}">${inner}</div>`;
}

/* ---------- End of Day button ---------- */

const NAME_TITLES = new Set(["dr", "doctor", "prof", "mr", "mrs", "ms", "miss", "nurse"]);
const nameWords = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  .split(" ").filter((w) => w && !NAME_TITLES.has(w));

// "Dr Teh" is Dr Joanna Teh's column: every word of the column (ignoring titles) is in her name.
// A short form also counts ("Jess" for Jessica). Rooms and Unassigned are never anyone's.
function isMyColumn(column, myName, apptName = "") {
  // Set in Staff → Edit → Work schedule: that column exactly (capitals, dots and spaces don't matter)
  if (apptName) return normName(column) === normName(apptName);
  const c = nameWords(column);
  const m = nameWords(myName);
  if (!c.length || !m.length) return false;
  if (c.join(" ") === "unassigned" || c.includes("room") || c.includes("clinician")) return false;
  return c.every((w) => m.some((x) => x === w || (w.length >= 3 && x.startsWith(w))));
}

const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const ICON_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function eodButtonHtml(s) {
  if (s.ended) {
    const at = s.endedAt instanceof Date && !isNaN(s.endedAt)
      ? ` ${s.endedAt.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}` : "";
    return `<button type="button" class="cal-eod is-done" data-action="eod" title="See what you entered today">${ICON_TICK}<span>Day ended${escapeHtml(at)}</span></button>`;
  }
  const n = new Date();
  const left = s.finish - (n.getHours() * 60 + n.getMinutes());
  const sub = s.urgent
    ? (left > 0 ? `Finish in ${left} min` : "Time to end your day")
    : `You finish at ${minToText(s.finish)}`;
  return `<button type="button" class="cal-eod${s.urgent ? " is-urgent" : ""}" data-action="eod">${ICON_MOON}
    <span>End of Day</span><small>${escapeHtml(sub)}</small></button>`;
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