import { fetchDayAppointments } from "./appointments.js";
import { escapeHtml, getInitials, toDateKey } from "./utils.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const SUN = svg('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>');
const MOON = svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');

let current = null;

// "Bethany" -> "Bethany", "Dr Joanna Teh" -> "Dr Teh"
function friendlyName(name) {
  const n = String(name || "").trim();
  const m = /^(dr|prof)\.?\s+(.+)$/i.exec(n);
  if (m) {
    const parts = m[2].trim().split(/\s+/);
    const title = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return `${title} ${parts[parts.length - 1]}`;
  }
  return n.split(/\s+/)[0] || "there";
}

function seenKey(staff) {
  return `sod:${staff.uid}:${toDateKey()}`;
}

// Shows the welcome once per staff member per day
export function maybeShowStartOfDay(staff) {
  if (!staff) return;
  try {
    if (localStorage.getItem(seenKey(staff))) return;
  } catch { /* storage blocked: just show it */ }
  showStartOfDay(staff);
}

export function closeStartOfDay() {
  if (!current) return;
  if (current.open) current.close();
  current.remove();
  current = null;
}

export function showStartOfDay(staff) {
  closeStartOfDay();

  const now = new Date();
  const hour = now.getHours();
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const dateText = `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  const name = friendlyName(staff.name);

  const dlg = document.createElement("dialog");
  dlg.className = "sod";
  dlg.setAttribute("aria-labelledby", "sod-title");
  dlg.innerHTML = `
    <div class="sod-card">
      <div class="sod-hero ${part === "evening" ? "evening" : ""}">
        <span class="sod-sky">${part === "evening" ? MOON : SUN}</span>
      </div>

      <div class="sod-avatar">
        <span>${escapeHtml(getInitials(staff.name))}</span>
        ${staff.photo ? `<img src="${escapeHtml(staff.photo)}" alt="" referrerpolicy="no-referrer" />` : ""}
      </div>

      <p class="sod-eyebrow">Good ${part} · ${escapeHtml(dateText)}</p>
      <h2 id="sod-title" class="sod-title serif">Welcome, ${escapeHtml(name)}</h2>
      <p class="sod-sub">Have a great day today!</p>

      <div class="sod-stats">
        <div class="sod-stat"><strong data-stat="appts">–</strong><span>appointments today</span></div>
        <div class="sod-stat"><strong data-stat="staff">–</strong><span>clinicians on</span></div>
      </div>

      <button type="button" class="sod-btn">Start my day</button>
    </div>`;

  document.body.appendChild(dlg);
  current = dlg;

  const img = dlg.querySelector(".sod-avatar img");
  if (img) img.addEventListener("error", () => img.remove());

  const close = () => {
    if (dlg.classList.contains("closing")) return;
    dlg.classList.add("closing");
    setTimeout(() => { if (current === dlg) closeStartOfDay(); }, 180);
  };
  dlg.querySelector(".sod-btn").addEventListener("click", close);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });     // Esc key
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });    // click outside

  dlg.showModal();
  setTimeout(() => dlg.querySelector(".sod-btn").focus(), 50);

  // Remember it's been shown today (and tidy up older days for this staff member)
  try {
    const prefix = `sod:${staff.uid}:`;
    Object.keys(localStorage)
      .filter((k) => k.startsWith(prefix) && k !== seenKey(staff))
      .forEach((k) => localStorage.removeItem(k));
    localStorage.setItem(seenKey(staff), "1");
  } catch { /* ignore */ }

  loadStats(dlg);
}

async function loadStats(dlg) {
  const wrap = dlg.querySelector(".sod-stats");
  try {
    const data = await fetchDayAppointments(toDateKey());
    if (!dlg.isConnected) return;

    const appts = data.appointments || [];
    if (!appts.length) {
      wrap.innerHTML = `<p class="sod-note">No appointments are scheduled today.</p>`;
      return;
    }
    const clinicians = new Set(appts.map((a) => a.staff).filter(Boolean)).size;
    wrap.querySelector('[data-stat="appts"]').textContent = appts.length;
    wrap.querySelector('[data-stat="staff"]').textContent = clinicians;
  } catch (err) {
    console.warn("Start of Day stats failed:", err);
    if (dlg.isConnected) wrap.hidden = true;
  }
}