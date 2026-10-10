// Completed forms: one document per form filled in for a patient.
// They're never edited or deleted once saved (enforced by the Firestore rules).
import { db, auth } from "./firebase-config.js";
import {
  collection, addDoc, getDoc, getDocs, doc, query, where, serverTimestamp, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COL = "form_submissions";

function toDate(v) {
  return v && typeof v.toDate === "function" ? v.toDate() : null;
}

function normalise(snap) {
  const d = snap.data() || {};
  return {
    id: snap.id,
    templateId: d.templateId || "",
    templateName: d.templateName || "Untitled form",
    category: d.category || "",
    group: d.group || "",
    version: Number(d.version || 0),
    patientId: d.patientId || "",
    patientPttId: d.patientPttId || "",
    patientName: d.patientName || "",
    recordDate: d.recordDate || "",
    answers: d.answers && typeof d.answers === "object" ? d.answers : {},
    signatures: d.signatures && typeof d.signatures === "object" ? d.signatures : {},
    deliveries: Array.isArray(d.deliveries) ? d.deliveries : [],
    createdAt: toDate(d.createdAt),
    createdBy: d.createdBy || "",
  };
}

// consume(tx, submissionId): optional. Takes stock off in the SAME transaction as the record,
// so a record is never saved without its stock, or the other way round.
export async function saveSubmission(data, staff, { consume } = {}) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  if (JSON.stringify(data).length > 900000) {
    throw new Error("This form is too large to save. Try clearing the signatures and signing again.");
  }
  const base = { createdAt: serverTimestamp(), createdBy: (staff && staff.name) || "", createdByUid: uid };
  if (!consume) {
    const ref = await addDoc(collection(db, COL), { ...data, ...base });
    return ref.id;
  }
  const ref = doc(collection(db, COL));
  await runTransaction(db, async (tx) => {
    const res = await consume(tx, ref.id);
    tx.set(ref, { ...data, answers: { ...data.answers, ...((res && res.answers) || {}) }, ...base });
  });
  return ref.id;
}
export async function getSubmission(id) {
  const snap = await getDoc(doc(db, COL, id));
  return snap.exists() ? normalise(snap) : null;
}

// Every completed form for a patient (including merged records), newest first
export async function listSubmissionsForPatient(ids) {
  const clean = [...new Set((ids || []).filter(Boolean).map(String))].slice(0, 30);
  if (!clean.length) return [];
  const snap = await getDocs(query(collection(db, COL), where("patientId", "in", clean)));
  return snap.docs.map(normalise).sort((a, b) =>
    b.recordDate.localeCompare(a.recordDate) ||
    ((b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0)));
}

// Forms I saved (default: the last 31 days), newest first
export async function listMySubmissions(days = 31) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) return [];
  const snap = await getDocs(query(collection(db, COL), where("createdByUid", "==", uid)));
  const since = Date.now() - days * 864e5;
  return snap.docs.map(normalise)
    .filter((s) => s.createdAt && s.createdAt.getTime() > since)
    .sort((a, b) => b.createdAt - a.createdAt);
}