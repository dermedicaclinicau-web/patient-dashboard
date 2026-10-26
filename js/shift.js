// A staff member's working day: their work schedule (Staff → Edit), their last appointment, or the clinic finish time.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi, fetchDayAppointments } from "./appointments.js";

const DOW = ["su", "mo", "tu", "we", "th", "fr", "sa"];
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const CANCELLED = /cancel|no.?show|\bdna\b|did not/i;

export const hhmmToMin = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
// "5:15 pm" → 1035
export function clockToMin(t) {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(String(t || ""));
  if (!m) return null;
  let h = +m[1];
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return h * 60 + +m[2];
}
export const minToText = (min) => new Date(2000, 0, 1, Math.floor(min / 60), min % 60)
  .toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });

let cached = null;   // { uid, at, schedule }, kept 10 minutes
export async function mySchedule(staff, { force = false } = {}) {
  if (!staff) return null;
  if (!force && cached && cached.uid === staff.uid && Date.now() - cached.at < 10 * 60000) return cached.schedule;
  const res = await callApi({ action: "staff", op: "mySchedule" });
  cached = { uid: staff.uid, at: Date.now(), schedule: res.schedule || null };
  return cached.schedule;
}

// A day in the schedule: { set, working, start, end (minutes), leave }
export function scheduleOn(schedule, d = new Date()) {
  const week = (schedule && schedule.week) || {};
  const set = Object.values(week).some((x) => x && x.on);
  const key = keyOf(d);
  const leave = ((schedule && schedule.leave) || []).find((l) => l.from <= key && key <= l.to) || null;
  const day = week[DOW[d.getDay()]] || {};
  return { set, leave, working: set && !leave && day.on === true, start: hhmmToMin(day.start), end: hhmmToMin(day.end) };
}

// When this person's last appointment today ends (minutes), or null.
// Matched on their "Name in the appointment book"; without one, on their full name (or first name for one-word bookings).
async function lastApptEnd(staff, schedule, key) {
  const list = (await fetchDayAppointments(key)).appointments;   // the Day Sheet plus bookings added on the calendar
  const want = norm(schedule && schedule.apptName);
  const me = norm(staff.name);
  const mine = (a) => {
    const s = norm(a.staff);
    if (!s) return false;
    if (want) return s === want;
    return s === me || (!s.includes(" ") && s === me.split(" ")[0]);
  };
  let last = null;
  list.forEach((a) => {
    if (!mine(a) || CANCELLED.test(String(a.status || ""))) return;
    const end = clockToMin(String(a.timeRange || "").split("-")[1]);
    if (end !== null && (last === null || end > last)) last = end;
  });
  return last;
}

// Today's finish (minutes after midnight) and where it came from: "roster", "appointments" or "clinic"
export async function myFinish(staff, cfg) {
  const now = new Date();
  const schedule = await mySchedule(staff).catch(() => null);
  const appt = await lastApptEnd(staff, schedule, keyOf(now)).catch(() => null);
  const today = scheduleOn(schedule, now);
  const clinic = hhmmToMin(cfg && cfg.finishTime) ?? 17 * 60 + 30;
  const base = today.working && today.end !== null ? today.end : clinic;
  const late = appt !== null && appt > base;
  return { finish: late ? appt : base, source: late ? "appointments" : today.working ? "roster" : "clinic", today };
}