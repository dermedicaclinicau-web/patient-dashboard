import { db } from "./firebase-config.js";
import { collection, query, where, getDocs }
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