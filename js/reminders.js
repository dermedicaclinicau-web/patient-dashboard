import { db, auth } from "./firebase-config.js";
import { collection, query, where, getDocs, addDoc, updateDoc, doc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Open (not completed) reminders for one patient, soonest due first.
// Matches on the patient's Firestore doc ID OR their PttID.
export async function fetchOpenReminders(patient) {
  const ids = [...new Set([patient.id, patient.pttId].filter(Boolean))];
  if (!ids.length) return [];

  const snap = await getDocs(
    query(collection(db, "staff-task-list"), where("patientId", "in", ids))
  );

  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => String(t.status || "").trim().toLowerCase() !== "completed")
    .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
}
// Same fields and formats as the existing staff-task-list documents
export function addReminder(patient, { taskText, dueDate }, staff) {
  return addDoc(collection(db, "staff-task-list"), {
    patientId: String(patient.pttId || patient.id),
    patientName: patient.name || "",
    taskText: String(taskText).trim(),
    dueDate,                                 // "YYYY-MM-DD"
    status: "Open",
    createdAt: new Date().toISOString(),
    createdBy: (staff && staff.name) || "",
    createdByUid: auth.currentUser.uid,
  });
}

export function completeReminder(id, staff) {
  return updateDoc(doc(db, "staff-task-list", id), {
    status: "Completed",
    completedAt: new Date().toISOString(),
    completedBy: (staff && staff.name) || "",
    completedByUid: auth.currentUser.uid,
  });
}