import { db, auth } from "./firebase-config.js";
import { collection, query, where, getDocs, addDoc, updateDoc, doc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { toDateKey } from "./utils.js";

const COL = "patient_personal_notes";

// When a note was written (ISO text, Firestore Timestamp, or a "YYYY-MM-DD" noteDate)
export function noteDate(n) {
  const v = n.createdAt || n.noteDate;
  if (v && typeof v.toDate === "function") return v.toDate();
  const t = Date.parse(String(v || ""));
  return isNaN(t) ? null : new Date(t);
}

// All visible notes for a patient, newest first
export async function fetchPersonalNotes(patient) {
  const ids = [...new Set([patient.pttId, patient.id].filter(Boolean).map(String))];
  if (!ids.length) return [];
  const snap = await getDocs(query(collection(db, COL), where("patientId", "in", ids)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((n) => !n.deleted && String(n.note || "").trim())
    .sort((a, b) => (noteDate(b) || 0) - (noteDate(a) || 0));
}

export function addPersonalNote(patient, text, staff) {
  return addDoc(collection(db, COL), {
    createdAt: new Date().toISOString(),
    createdBy: (staff && staff.name) || "",
    createdByUid: auth.currentUser.uid,
    note: String(text).trim(),
    noteDate: toDateKey(),
    patientId: String(patient.pttId || patient.id),
    patientName: patient.name || "",
    updatedAt: "",
    updatedBy: "",
  });
}

export function updatePersonalNote(id, text, staff) {
  return updateDoc(doc(db, COL, id), {
    note: String(text).trim(),
    updatedAt: new Date().toISOString(),
    updatedBy: (staff && staff.name) || "",
    updatedByUid: auth.currentUser.uid,
  });
}

// "Remove" hides the note but keeps it (and who removed it) on record
export function hidePersonalNote(id, staff) {
  return updateDoc(doc(db, COL, id), {
    deleted: true,
    deletedAt: new Date().toISOString(),
    deletedBy: (staff && staff.name) || "",
    deletedByUid: auth.currentUser.uid,
  });
}

export function canEditNote(n, staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) return false;
  return n.createdByUid === uid || /^admin$/i.test(String((staff && staff.role) || ""));
}