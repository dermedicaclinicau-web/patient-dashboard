import { db, auth } from "./firebase-config.js";
import { collection, query, where, getDocs, addDoc, updateDoc, doc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { patientIds } from "./patients.js";
import { callApi } from "./appointments.js";

// Open (not completed) reminders for one patient, soonest due first.
// Matches on the patient's Firestore doc ID OR their PttID.
export async function fetchOpenReminders(patient) {
  const ids = patientIds(patient);
  if (!ids.length) return [];

  const snap = await getDocs(
    query(collection(db, "staff-task-list"), where("patientId", "in", ids))
  );

  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => String(t.status || "").trim().toLowerCase() !== "completed")
    .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
}
// Same fields and formats as the existing staff-task-list documents.
// assignedToId / assignedToName: a staff member, or "" for anyone.
export function addReminder(patient, { taskText, dueDate, assignedToId = "", assignedToName = "" }, staff) {
  return addDoc(collection(db, "staff-task-list"), {
    patientId: String(patient.pttId || patient.id),
    patientName: patient.name || "",
    taskText: String(taskText).trim(),
    dueDate,                                 // "YYYY-MM-DD"
    status: "Open",
    assignedToId: String(assignedToId || ""),
    assignedToName: String(assignedToName || ""),
    createdAt: new Date().toISOString(),
    createdBy: (staff && staff.name) || "",
    createdByUid: auth.currentUser.uid,
    notes: [],
    history: [{ at: new Date().toISOString(), by: (staff && staff.name) || "", what: "Added" }],
  });
}

// Through Apps Script, like the dashboard: it's added to the activity trail and whoever assigned it is told
export function completeReminder(id, staff, note = "") {
  return callApi({ action: "staffTask", op: "status", id, status: "Completed", note });
}