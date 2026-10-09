// Skin Script Protocols: saving and loading (Firestore ssp_records), and the SSP_NEW sheet copy.
import { db, auth } from "./firebase-config.js";
import {
  collection, addDoc, getDocs, query, where, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";

const COL = "ssp_records";
const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);

export async function createSspRecord(data, staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const ref = await addDoc(collection(db, COL), {
    ...data,
    createdAt: serverTimestamp(),
    createdBy: (staff && staff.name) || "",
    createdByUid: uid,
  });
  return ref.id;
}

// The patient's protocols, newest first
export async function listSspRecords(ids) {
  const list = [...new Set((ids || []).filter(Boolean))].slice(0, 10);
  if (!list.length) return [];
  const snap = await getDocs(query(collection(db, COL), where("patientId", "in", list)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data(), createdMs: toMs(d.data().createdAt) }))
    .sort((a, b) => b.createdMs - a.createdMs);
}

// Appends the protocol to the SSP_NEW sheet (written once only)
export function syncSspToSheet(id) {
  return callApi({ action: "ssp", op: "appendRecord", recordId: id });
}