// A patient's bookings from now onwards, read straight from the appointment book (appts_by_day).
// Used by the {Upcoming appointments} blank in tasks.
import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, documentId } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const CANCELLED = /cancel|no.?show|\bdna\b|did not attend/i;     // the same rule the Calendar uses to grey a booking out
const NOT_A_PERSON = /^unassigned$|\broom\b|^dermedica clinician$/i;

export function niceDay(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return key || "";
  return new Date(+m[1], +m[2] - 1, +m[3])
    .toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(",", "");
}
export const apptWhen = (x) => `${niceDay(x.dateKey)}${x.time ? `, ${x.time}` : ""}`;
export function apptDetail(x, { services = true, staff = true } = {}) {
  const who = x.staff.length < 3 ? x.staff.join(" and ") : `${x.staff.slice(0, -1).join(", ")} and ${x.staff[x.staff.length - 1]}`;
  return [services && x.services.join(", "), staff && who && `with ${who}`].filter(Boolean).join(" ");
}

// { items: [{ dateKey, time, sortMinutes, services: [], staff: [] }], daysFound, lastKey, toKey }
export async function upcomingAppointments(patient, { months = 6 } = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setMonth(end.getMonth() + months);
  const fromKey = keyOf(today);
  const toKey = keyOf(end);
  const snap = await getDocs(query(collection(db, "appts_by_day"),
    where(documentId(), ">=", fromKey), where(documentId(), "<=", toKey)));

  const ids = new Set([patient.id, patient.pttId, patient.patientId, patient.pid]
    .filter(Boolean).map((x) => String(x).trim().toLowerCase()));
  const name = norm(patient.name);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const byTime = new Map();
  let daysFound = 0;
  let lastKey = "";

  snap.forEach((d) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.id)) return;
    daysFound++;
    if (d.id > lastKey) lastKey = d.id;
    const list = Array.isArray(d.data().appointments) ? d.data().appointments : [];
    list.forEach((a) => {
      const aid = String(a.patientId || "").trim().toLowerCase();
      // Match on the patient's ID. Only fall back to the name when the booking has no ID (so two Jane Smiths never mix).
      const mine = aid ? ids.has(aid) : !!name && norm(a.patientName) === name;
      if (!mine || CANCELLED.test(String(a.status || ""))) return;
      const mins = Number(a.sortMinutes);
      if (d.id === fromKey && Number.isFinite(mins) && mins < nowMin) return;   // earlier today: already happened
      // One visit can be several lines (one per service or staff member): merge them
      const k = `${d.id}|${String(a.time || "").trim()}`;
      const row = byTime.get(k) || { dateKey: d.id, time: String(a.time || "").trim(), sortMinutes: Number.isFinite(mins) ? mins : 0, services: [], staff: [] };
      (a.services || []).forEach((s) => { const v = String(s || "").trim(); if (v && !row.services.includes(v)) row.services.push(v); });
      const who = String(a.staff || "").trim();
      if (who && !NOT_A_PERSON.test(who) && !row.staff.includes(who)) row.staff.push(who);
      byTime.set(k, row);
    });
  });

  const items = [...byTime.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.sortMinutes - b.sortMinutes);
  return { items, daysFound, lastKey, toKey };
}

// The blank's value: bold date and time, then the details. { text } for the subject, { html } for the message.
export function formatUpcoming(items, opts = {}) {
  const rows = items.map((x) => ({ when: apptWhen(x), detail: apptDetail(x, opts) }));
  return {
    text: rows.map((r) => `• ${r.when}${r.detail ? `: ${r.detail}` : ""}`).join("\n"),
    html: rows.map((r) => `• <strong>${esc(r.when)}</strong>${r.detail ? `: ${esc(r.detail)}` : ""}`).join("<br>"),
  };
}