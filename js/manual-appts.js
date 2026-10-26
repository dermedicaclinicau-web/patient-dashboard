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
  return snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, ...x, createdAt: x.createdAt && x.createdAt.toDate ? x.createdAt.toDate() : null };
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

// Same clinician: the same words, or one name inside the other ("Dr Teh" / "Dr Joanna Teh")
function sameStaff(a, b) {
  const x = words(a).filter((w) => w !== "dr"), y = words(b).filter((w) => w !== "dr");
  if (!x.length || !y.length) return false;
  return x.every((w) => y.includes(w)) || y.every((w) => x.includes(w));
}

// The Day Sheet's appointments plus the portal bookings it doesn't have yet.
// A booking is hidden once the Day Sheet has the same patient that day with the same clinician, or within an hour of it.
export function mergeDay(sheet, manual, sheetUpdatedAt) {
  const list = Array.isArray(sheet) ? sheet : [];
  const live = list.filter((a) => !CANCELLED.test(String(a.status || "")));
  const upAt = Date.parse(sheetUpdatedAt || "") || 0;
  const extra = [];
  (manual || []).forEach((m) => {
    const pid = norm(m.patientId), pname = norm(m.patientName);
    const inSheet = live.some((a) => {
      const aid = norm(a.patientId);
      const same = pid && aid ? aid === pid : !!pname && norm(a.patientName) === pname;
      if (!same) return false;
      return sameStaff(a.staff, m.staff) || Math.abs((Number(a.sortMinutes) || 0) - m.sortMinutes) <= 60;
    });
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