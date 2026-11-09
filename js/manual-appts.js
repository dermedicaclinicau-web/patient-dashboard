// Bookings added on the calendar (manual_appts), shown until the next Day Sheet upload has them.
import { db, auth } from "./firebase-config.js";
import { collection, doc, query, where, getDocs, addDoc, updateDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COL = "manual_appts";
const pad = (n) => String(n).padStart(2, "0");
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const norm = (s) => words(s).join(" ");
const CANCELLED = /cancel|no.?show|\bdna\b|did not/i;

export const hhmmToMin = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
// 615 → "10:15 am" (the same style as the Day Sheet)
export function minToClock(min) {
  const h = Math.floor(min / 60) % 24;
  return `${h % 12 || 12}:${pad(min % 60)} ${h < 12 ? "am" : "pm"}`;
}

export async function listManualAppts(dateKey) {
  const snap = await getDocs(query(collection(db, COL), where("dateKey", "==", dateKey)));
  const when = (t) => (t && t.toDate ? t.toDate() : null);
  return snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, ...x, createdAt: when(x.createdAt), updatedAt: when(x.updatedAt) };
  }).filter((x) => x.status === "active");
}

async function whoAmI() {
  const user = auth.currentUser;
  if (!user) throw new Error("Your session has ended. Log in again.");
  let name = "";
  try { name = String((await user.getIdTokenResult()).claims.staffName || ""); } catch { /* optional */ }
  return { uid: user.uid, name };
}

// input: { dateKey, staff, patientId, patientName, start: "HH:MM", durationMin, services: [], note }. Returns the id.
export async function saveManualAppt(input, id = "") {
  const me = await whoAmI();
  const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const start = hhmmToMin(input.start);
  const dur = Math.round(Number(input.durationMin));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateKey || "")) throw new Error("Choose the date.");
  if (start === null) throw new Error("Choose the start time.");
  if (!(dur > 0 && dur <= 480)) throw new Error("Choose how long it is.");
  const end = Math.min(start + dur, 24 * 60 - 1);
  const data = {
    dateKey: input.dateKey,
    staff: clean(input.staff, 80),
    patientId: clean(input.patientId, 80),
    patientName: clean(input.patientName, 120),
    start: input.start,
    time: minToClock(start),
    timeRange: `${minToClock(start)} - ${minToClock(end)}`,
    sortMinutes: start,
    durationMin: dur,
    services: (input.services || []).map((s) => clean(s, 120)).filter(Boolean).slice(0, 10),
    note: String(input.note || "").trim().slice(0, 500),
    status: "active",
    updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid,
  };
  if (!data.staff) throw new Error("Who is it with?");
  if (!data.patientName) throw new Error("Choose the patient.");
  if (id) { await updateDoc(doc(db, COL, id), data); return id; }
  const ref = await addDoc(collection(db, COL), { ...data, createdAt: serverTimestamp(), createdBy: me.name, createdByUid: me.uid });
  return ref.id;
}

export async function removeManualAppt(id) {
  const me = await whoAmI();
  await updateDoc(doc(db, COL, id), {
    status: "removed", updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid,
  });
}

/* ===================== Changes to Day Sheet bookings ===================== */
// A booking from the Day Sheet (Timely) moved, given to someone else, cancelled or noted in the portal.
// Shown until the next upload agrees. The Day Sheet has no booking ID, so a change finds its bookings
// by patient + clinician + their original start times that day.

// input: { dateKey, patientId, patientName, staff, fromMins: [original start minutes], toMin, toStaff, cancel, note }
export async function saveApptChange(input, id = "") {
  const me = await whoAmI();
  const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const fromMins = [...new Set((input.fromMins || []).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 0 && n < 1440).sort((a, b) => a - b).slice(0, 12);
  const toMin = Number(input.toMin);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateKey || "")) throw new Error("This booking has no date.");
  if (!fromMins.length) throw new Error("This booking's time couldn't be read.");
  if (!Number.isInteger(toMin) || toMin < 0 || toMin >= 1440) throw new Error("Choose the new start time.");
  const shiftMin = toMin - fromMins[0];
  if (fromMins[fromMins.length - 1] + shiftMin >= 1440) throw new Error("That moves part of the visit past midnight.");
  const data = {
    kind: "change",
    dateKey: input.dateKey,
    patientId: clean(input.patientId, 80),
    patientName: clean(input.patientName, 120),
    staff: clean(input.staff, 80),
    toStaff: clean(input.toStaff || input.staff, 80),
    fromMins, fromTime: minToClock(fromMins[0]),
    toMin, toTime: minToClock(toMin), shiftMin,
    cancel: ["cancelled", "no-show"].includes(input.cancel) ? input.cancel : "",
    note: String(input.note || "").trim().slice(0, 500),
    status: "active",
    updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid,
  };
  if (!data.staff || !data.patientName) throw new Error("This booking couldn't be read.");
  if (id) { await updateDoc(doc(db, COL, id), data); return id; }
  const ref = await addDoc(collection(db, COL), { ...data, createdAt: serverTimestamp(), createdBy: me.name, createdByUid: me.uid });
  return ref.id;
}

// Undo: the booking goes back to what the Day Sheet says
export const removeApptChange = (id) => removeManualAppt(id);

// "11:00 am - 11:30 am" moved by 15 minutes → "11:15 am - 11:45 am"
const CLOCK = /(\d{1,2}):(\d{2})\s*(am|pm)/gi;
const clockToMin = (h, m, ap) => ((+h % 12) + (/p/i.test(ap) ? 12 : 0)) * 60 + +m;
const shiftClocks = (text, by) => String(text || "")
  .replace(CLOCK, (_, h, m, ap) => minToClock(Math.max(0, Math.min(1439, clockToMin(h, m, ap) + by))));

// Same patient: the same Patient ID, or (when either has none) the same name
function samePatient(a, m) {
  const pid = norm(m.patientId), aid = norm(a.patientId);
  return pid && aid ? aid === pid : !!norm(m.patientName) && norm(a.patientName) === norm(m.patientName);
}

// Same clinician: the same words, or one name inside the other ("Dr Teh" / "Dr Joanna Teh")
function sameStaff(a, b) {
  const x = words(a).filter((w) => w !== "dr"), y = words(b).filter((w) => w !== "dr");
  if (!x.length || !y.length) return false;
  return x.every((w) => y.includes(w)) || y.every((w) => x.includes(w));
}

// Changes on top of the Day Sheet. Each changed booking keeps what the Day Sheet said in "orig",
// and gets "portalChange" so the calendar can tag it.
function applyChanges(rows, changes, upAt) {
  if (!changes.length) return rows;
  const out = rows.map((r) => ({ ...r }));
  changes.forEach((ch) => {
    const mins = (ch.fromMins || []).map(Number);
    const by = Number(ch.shiftMin) || 0;
    const seen = (ch.updatedAt || ch.createdAt) ? (ch.updatedAt || ch.createdAt).getTime() : 0;
    const meta = {
      id: ch.id, fromTime: ch.fromTime || "", toTime: ch.toTime || "", fromStaff: ch.staff || "", toStaff: ch.toStaff || ch.staff || "",
      fromMins: mins, cancel: ch.cancel || "", note: ch.note || "", by: ch.updatedBy || ch.createdBy || "",
    };

    // Still where it was: show it moved
    const hits = out.filter((r) => !r.portalChange && samePatient(r, ch) && sameStaff(r.staff, ch.staff)
      && mins.includes(Number(r.sortMinutes)));
    if (hits.length) {
      hits.forEach((r) => {
        const orig = { staff: r.staff, sortMinutes: r.sortMinutes, time: r.time, timeRange: r.timeRange, status: r.status };
        const needsTimely = by !== 0 || !sameStaff(meta.fromStaff, meta.toStaff)
          || (!!meta.cancel && !CANCELLED.test(String(orig.status || "")));
        r.orig = orig;
        if (by) {
          r.sortMinutes = Number(r.sortMinutes) + by;
          r.time = minToClock(r.sortMinutes);
          r.timeRange = shiftClocks(r.timeRange, by);
        }
        r.staff = meta.toStaff || r.staff;
        if (meta.cancel) r.status = meta.cancel === "no-show" ? "No show" : "Cancelled";
        // A Day Sheet uploaded since the change, still with the old booking
        r.portalChange = { ...meta, pending: needsTimely && !!upAt && !!seen && upAt > seen + 60000 };
      });
      return;
    }

    // Not where it was. Gone from Timely, or Timely has the change: nothing to show.
    const target = mins.map((m) => m + by);
    const mine = out.filter((r) => !r.portalChange && samePatient(r, ch)
      && (sameStaff(r.staff, ch.staff) || sameStaff(r.staff, meta.toStaff)));
    if (!mine.length) return;
    if (mine.some((r) => sameStaff(r.staff, meta.toStaff) && target.includes(Number(r.sortMinutes)))) return;
    // Timely says something else: flag it so someone checks
    mine.forEach((r) => { r.portalChange = { ...meta, conflict: true }; });
  });
  return out;
}

// The Day Sheet's appointments (with any portal changes), plus the portal bookings it doesn't have yet.
// A booking is hidden once the Day Sheet has the same patient that day with the same clinician, or within an hour of it.
export function mergeDay(sheet, manual, sheetUpdatedAt) {
  const upAt = Date.parse(sheetUpdatedAt || "") || 0;
  const all = manual || [];
  const list = applyChanges(Array.isArray(sheet) ? sheet : [], all.filter((m) => m.kind === "change"), upAt);
  const live = list.filter((a) => !CANCELLED.test(String(a.status || "")));
  const extra = [];
  all.filter((m) => m.kind !== "change").forEach((m) => {
    const inSheet = live.some((a) => samePatient(a, m)
      && (sameStaff(a.staff, m.staff) || Math.abs((Number(a.sortMinutes) || 0) - m.sortMinutes) <= 60));
    if (inSheet) return;
    const made = m.createdAt ? m.createdAt.getTime() : 0;
    extra.push({
      staff: m.staff, patientName: m.patientName, patientId: m.patientId || "",
      time: m.time, timeRange: m.timeRange, sortMinutes: m.sortMinutes, services: m.services || [],
      status: "", resources: "",
      manual: true, manualId: m.id, dateKey: m.dateKey, start: m.start, durationMin: m.durationMin,
      note: m.note || "", createdBy: m.createdBy || "",
      notInTimely: !!upAt && !!made && upAt > made + 60000,   // a Day Sheet uploaded since, without it
    });
  });
  return list.concat(extra);
}