// Repeating staff tasks: schedule settings, the next send times, wording, and clinic closed days.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, collection, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERTH = 8 * 3600000; // Perth is UTC+8 all year (no daylight saving)

export const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
export const WEEK_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export const DAY_NAMES = { Mo: "Mon", Tu: "Tue", We: "Wed", Th: "Thu", Fr: "Fri", Sa: "Sat", Su: "Sun" };
const LONG_DAY = { Mo: "Monday", Tu: "Tuesday", We: "Wednesday", Th: "Thursday", Fr: "Friday", Sa: "Saturday", Su: "Sunday" };
export const FREQS = [
  ["once", "Once"], ["daily", "Every day"], ["weekdays", "Every weekday (Mon–Fri)"],
  ["weekly", "Every week on…"], ["monthlyDate", "Every month on a date"],
  ["monthlyNth", "Every month on a weekday"], ["everyN", "Every few days"],
];

const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
const fromNum = (n) => { const t = new Date(n * 86400000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() }; };
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const slotMs = (p, time) => { const [h, mi] = String(time || "08:00").split(":").map(Number); return Date.UTC(p.y, p.m - 1, p.d, h, mi) - PERTH; };

export function perthToday() {
  const t = new Date(Date.now() + PERTH);
  return keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
const ordinal = (n) => { const x = Number(n); const s = ["th", "st", "nd", "rd"], v = x % 100; return x + (s[(v - 20) % 10] || s[v] || s[0]); };
export const fmtTime = (t) => { const [h, m] = String(t || "08:00").split(":").map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "am" : "pm"}`; };
export const fmtDate = (key) => {
  if (!KEY_RE.test(key || "")) return "";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
};
export const fmtSlot = (ms) => new Date(ms).toLocaleString("en-AU", {
  timeZone: "Australia/Perth", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
});

export function defaultSchedule() {
  return {
    enabled: false, paused: false, freq: "weekdays", time: "08:00", date: perthToday(),
    days: ["Mo"], everyWeeks: 1, monthDay: "1", nth: "1", nthDay: "Mo", everyN: 2,
    end: "never", endDate: "", endCount: 10,
    skipWeekends: false, skipClosed: true, onlyApptDays: false, onSkip: "skip",
    renderedHtml: "", renderedSubject: "", patientId: "", patientName: "",
  };
}

export function cleanSchedule(s) {
  const d = defaultSchedule();
  const x = s || {};
  return {
    enabled: x.enabled === true,
    paused: x.paused === true,
    freq: FREQS.some(([k]) => k === x.freq) ? x.freq : d.freq,
    time: /^([01]\d|2[0-3]):(00|15|30|45)$/.test(x.time || "") ? x.time : d.time,
    date: KEY_RE.test(x.date || "") ? x.date : d.date,
    days: Array.isArray(x.days) ? WEEK_ORDER.filter((k) => x.days.includes(k)) : d.days,
    everyWeeks: Number(x.everyWeeks) === 2 ? 2 : 1,
    monthDay: x.monthDay === "last" ? "last" : String(Math.min(31, Math.max(1, parseInt(x.monthDay, 10) || 1))),
    nth: ["1", "2", "3", "4", "last"].includes(String(x.nth)) ? String(x.nth) : "1",
    nthDay: WEEK_ORDER.includes(x.nthDay) ? x.nthDay : "Mo",
    everyN: Math.min(60, Math.max(2, parseInt(x.everyN, 10) || 2)),
    end: ["never", "date", "count"].includes(x.end) ? x.end : "never",
    endDate: KEY_RE.test(x.endDate || "") ? x.endDate : "",
    endCount: Math.min(999, Math.max(1, parseInt(x.endCount, 10) || 10)),
    skipWeekends: x.skipWeekends === true,
    skipClosed: x.skipClosed !== false,
    onlyApptDays: x.onlyApptDays === true,
    onSkip: x.onSkip === "next" ? "next" : "skip",
    renderedHtml: String(x.renderedHtml || "").slice(0, 150000),
    renderedSubject: String(x.renderedSubject || "").slice(0, 200),
    patientId: /^[A-Za-z0-9_-]{1,80}$/.test(String(x.patientId || "")) ? String(x.patientId) : "",
    patientName: String(x.patientName || "").slice(0, 120),
   };
}

function matches(s, p) {
  const [sy, sm, sd] = s.date.split("-").map(Number);
  const startN = dayNum(sy, sm, sd);
  const n = dayNum(p.y, p.m, p.d);
  const diff = n - startN;
  if (diff < 0) return false;
  const code = DOW[p.dow];
  switch (s.freq) {
    case "once": return diff === 0;
    case "daily": return true;
    case "weekdays": return p.dow >= 1 && p.dow <= 5;
    case "weekly": {
      if (!s.days.includes(code)) return false;
      if (s.everyWeeks !== 2) return true;
      const mon = (x) => x - ((fromNum(x).dow + 6) % 7);
      return Math.round((mon(n) - mon(startN)) / 7) % 2 === 0;
    }
    case "monthlyDate": { const dim = daysIn(p.y, p.m); return p.d === (s.monthDay === "last" ? dim : Math.min(Number(s.monthDay), dim)); }
    case "monthlyNth": {
      if (code !== s.nthDay) return false;
      return s.nth === "last" ? p.d + 7 > daysIn(p.y, p.m) : Math.ceil(p.d / 7) === Number(s.nth);
    }
    case "everyN": return diff % s.everyN === 0;
  }
  return false;
}
const blocked = (s, p, closed) => (s.skipWeekends && (p.dow === 0 || p.dow === 6)) || (s.skipClosed && closed.has(keyOf(p.y, p.m, p.d)));

// The next send times after `after` (ms). The same rules run in Apps Script.
export function nextSlots(sched, { after = Date.now(), count = 5, closed = [] } = {}) {
  const s = cleanSchedule(sched);
  const out = [];
  if (!s.enabled) return out;
  const closedSet = new Set(closed);
  const seen = new Set();
  const a = new Date(after + PERTH);
  let n = dayNum(a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate()) - 31;
  for (let i = 0; i < 800 && out.length < count; i++, n++) {
    let p = fromNum(n);
    if (!matches(s, p)) continue;
    let moved = false;
    if (blocked(s, p, closedSet)) {
      if (s.onSkip !== "next") continue;
      let q = null;
      for (let k = 1; k <= 14; k++) { const c = fromNum(n + k); if (!blocked(s, c, closedSet)) { q = c; break; } }
      if (!q) continue;
      p = q;
      moved = true;
    }
    const key = keyOf(p.y, p.m, p.d);
    if (s.end === "date" && s.endDate && key > s.endDate) break;
    if (seen.has(key)) continue;
    seen.add(key);
    const ms = slotMs(p, s.time);
    if (ms <= after) continue;
    out.push({ ms, key, moved });
  }
  return out.sort((x, y) => x.ms - y.ms);
}

export function describeSchedule(sched) {
  const s = cleanSchedule(sched);
  if (!s.enabled) return "Only sent when someone runs it";
  const t = fmtTime(s.time);
  const what = {
    once: `Once, on ${fmtDate(s.date)} at ${t}`,
    daily: `Every day at ${t}`,
    weekdays: `Every weekday at ${t}`,
    weekly: `${s.everyWeeks === 2 ? "Every 2 weeks" : "Every week"} on ${s.days.map((k) => DAY_NAMES[k]).join(", ") || "…"} at ${t}`,
    monthlyDate: `Every month on the ${s.monthDay === "last" ? "last day" : ordinal(s.monthDay)} at ${t}`,
    monthlyNth: `Every month on the ${s.nth === "last" ? "last" : ordinal(s.nth)} ${LONG_DAY[s.nthDay]} at ${t}`,
    everyN: `Every ${s.everyN} days at ${t}`,
  }[s.freq];
  const bits = [what];
  if (s.freq !== "once") bits.push(`from ${fmtDate(s.date)}`);
  if (s.freq !== "once" && s.end === "date" && s.endDate) bits.push(`until ${fmtDate(s.endDate)}`);
  if (s.freq !== "once" && s.end === "count") bits.push(`for ${s.endCount} send${s.endCount === 1 ? "" : "s"}`);
  const cond = [];
  if (s.skipWeekends) cond.push("skips weekends");
  if (s.skipClosed) cond.push("skips clinic closed days");
  if (s.onlyApptDays) cond.push("only on days with appointments");
  return bits.join(", ") + (cond.length ? ` · ${cond.join(", ")}` : "") + (s.paused ? " · Paused" : "");
}


// Reasons a scheduled task can't be published yet
const SMART_RE = /\{\s*(upcoming appointments|treatment plan|treatment info|aftercare)\s*\}/i;

// Reasons a scheduled task can't be published yet
export function scheduleProblems(task) {
  const s = task.schedule;
  if (task.category !== "staff" || !s || !s.enabled) return [];
  const out = [];
  if (task.recipients.mode !== "fixed") out.push("Scheduled tasks need “Always these staff” in Who it goes to.");
  else if (!task.recipients.staffIds.length) out.push("Choose who the scheduled task goes to.");
  if (task.recipients.aboutPatient && !s.patientId) out.push("Choose the patient for automatic sends in Schedule (step 7).");
  if (SMART_RE.test(`${task.subject} ${task.body}`)) {
    out.push("Automatic sends can't include {Upcoming appointments}, {Treatment plan}, {Treatment info} or {Aftercare}. Remove them, or set Schedule to “Only when someone runs it”.");
  }
  if (task.attachments.length) out.push("Scheduled tasks can't include attachments yet. Remove them in Attachments.");
  task.fields.filter((f) => f.required && !String(f.default || "").trim())
    .forEach((f) => out.push(`Give “${f.label || "Untitled field"}” an answer for automatic sends.`));
  if (s.freq === "weekly" && !s.days.length) out.push("Choose at least one day of the week.");
  if (s.freq === "once") {
    const [y, m, d] = s.date.split("-").map(Number);
    if (slotMs({ y, m, d }, s.time) <= Date.now()) out.push("The send time has already passed. Choose a later date or time.");
  }
  if (s.end === "date" && s.endDate && s.endDate < s.date) out.push("The stop date is before the start date.");
  return out;
}


/* ---------- Clinic closed days (shared by every scheduled task) ---------- */

export async function getClosedDays() {
  const snap = await getDoc(doc(db, "task_settings", "closed"));
  const d = snap.exists() ? snap.data() : {};
  return Array.isArray(d.dates) ? d.dates.filter((k) => KEY_RE.test(k)).sort() : [];
}

async function saveClosedDays(dates, staff) {
  if (!auth.currentUser) throw new Error("Your session has ended. Log in again.");
  const clean = [...new Set(dates)].filter((k) => KEY_RE.test(k)).sort().slice(0, 500);
  await setDoc(doc(db, "task_settings", "closed"), {
    dates: clean, updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120),
  });
  return clean;
}

// Each scheduled task's running state (written by Apps Script): Map taskId -> { count, lastSentAt, next, lastError }
export async function listScheduleStates() {
  try {
    const snap = await getDocs(collection(db, "task_schedules"));
    return new Map(snap.docs.map((d) => [d.id, d.data()]));
  } catch (err) {
    console.warn("Schedule states unavailable:", err);
    return new Map();
  }
}

// Resolves with the saved list, or null if cancelled
export async function openClosedDaysDialog(staff) {
  let dates = [];
  try { dates = await getClosedDays(); } catch (err) { console.warn("Closed days failed:", err); }
  return new Promise((resolve) => {
    let saved = null;
    const today = perthToday();
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Clinic closed days</h3>
          <p>Public holidays, Christmas break and other days the clinic is closed. Scheduled tasks that skip closed days won't send on these.</p></div>
        <div class="tb-closed-add">
          <input type="date" class="fe-input" name="day" min="${today}" aria-label="Closed day" />
          <button type="button" class="lh-btn" data-act="add">Add day</button>
        </div>
        <div class="tb-closed" data-role="list"></div>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    const list = dlg.querySelector('[data-role="list"]');
    const err = dlg.querySelector(".lh-error");
    const render = () => {
      const upcoming = dates.filter((k) => k >= today);
      list.innerHTML = upcoming.length ? upcoming.map((k) => `
        <span class="tb-closed-chip">${esc(fmtDate(k))}<button type="button" data-del="${k}" aria-label="Remove ${esc(fmtDate(k))}">×</button></span>`).join("")
        : '<p class="tb-none">No closed days added yet.</p>';
    };
    render();
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]')) { dlg.close(); return; }
      if (e.target.closest('[data-act="add"]')) {
        const v = form.elements.day.value;
        if (KEY_RE.test(v) && !dates.includes(v)) { dates = [...dates, v].sort(); render(); }
        form.elements.day.value = "";
        return;
      }
      const del = e.target.closest("[data-del]");
      if (del) { dates = dates.filter((k) => k !== del.dataset.del); render(); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        saved = await saveClosedDays(dates.filter((k) => k >= perthToday()), staff);
        dlg.close();
        showToast("Clinic closed days saved");
      } catch (ex) {
        console.error("Save closed days failed:", ex);
        err.textContent = ex.code === "permission-denied" ? "Only staff who build task types can change this." : "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(saved); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}