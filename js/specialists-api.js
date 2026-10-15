// Specialist Bank: specialists for referral letters (Firestore "specialists").
// Anyone logged in can add and correct them; archiving needs Form Builder access.
import { db, auth } from "./firebase-config.js";
import {
  collection, getDocs, doc, addDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COL = "specialists";
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const keyOf = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
let cache = null;

export function cleanSpecialist(s = {}) {
  return {
    name: clip(s.name, 120).replace(/\s+/g, " "),
    speciality: clip(s.speciality, 80).replace(/\s+/g, " "),
    practice: clip(s.practice, 150),
    phone: clip(s.phone, 40),
    email: clip(s.email, 254),
    address: String(s.address ?? "").replace(/\r\n/g, "\n").trim().slice(0, 300),
    notes: String(s.notes ?? "").replace(/\r\n/g, "\n").trim().slice(0, 1000),
  };
}

function normalise(d) {
  const x = d.data() || {};
  return { id: d.id, ...cleanSpecialist(x), active: x.active !== false, updatedBy: String(x.updatedBy || ""), updatedAt: toDate(x.updatedAt) };
}

// Active specialists A to Z (includeInactive: archived ones too). Cached for a minute.
export async function listSpecialists({ force = false, includeInactive = false } = {}) {
  if (force || !cache || Date.now() - cache.at > 60000) {
    const snap = await getDocs(collection(db, COL));
    cache = { at: Date.now(), list: snap.docs.map(normalise).sort((a, b) => a.name.localeCompare(b.name, "en-AU")) };
  }
  return includeInactive ? cache.list : cache.list.filter((s) => s.active);
}
export const invalidateSpecialists = () => { cache = null; };

export const specialitiesOf = (list) =>
  [...new Set((list || []).map((s) => s.speciality).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en-AU"));

// Same name and speciality as another specialist (archived ones included), or null
export function findDuplicate(list, data, exceptId = "") {
  return (list || []).find((s) => s.id !== exceptId && keyOf(s.name) === keyOf(data.name)
    && keyOf(s.speciality) === keyOf(data.speciality)) || null;
}

function who(staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  return { uid, name: String((staff && staff.name) || "").slice(0, 120) };
}

export async function saveSpecialist(id, data, staff) {
  const clean = cleanSpecialist(data);
  if (!clean.name) throw new Error("Add the specialist's name.");
  if (clean.email && !EMAIL_RE.test(clean.email)) throw new Error("Check the email address.");
  if (!clean.phone && !clean.email && !clean.address) throw new Error("Add a phone number, email or address, so the letter can reach them.");
  const me = who(staff);
  const stampU = { updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid };
  if (id) {
    await updateDoc(doc(db, COL, id), { ...clean, nameKey: keyOf(clean.name), ...stampU });
  } else {
    const ref = await addDoc(collection(db, COL), {
      ...clean, nameKey: keyOf(clean.name), active: true,
      createdAt: serverTimestamp(), createdBy: me.name, createdByUid: me.uid, ...stampU,
    });
    id = ref.id;
  }
  cache = null;
  return id;
}

export async function setSpecialistActive(id, active, staff) {
  const me = who(staff);
  await updateDoc(doc(db, COL, id), { active: active === true, updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid });
  cache = null;
}