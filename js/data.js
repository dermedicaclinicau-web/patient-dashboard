// ===== Data layer =====
// Keep these function signatures stable. Later, replace the bodies with Firestore calls.

function daysFromNow(days, hour = 9, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const MOCK_PATIENT = { id: "p_001", name: "Jane Doe", email: "jane@example.com" };

const MOCK_APPOINTMENTS = [
  { id: "a1", patientId: "p_001", dateTime: daysFromNow(-90, 10, 0),  doctor: "Dr. Amir Khan",   department: "General Practice", status: "completed", notes: "Annual check-up. Blood pressure normal." },
  { id: "a2", patientId: "p_001", dateTime: daysFromNow(-45, 14, 30), doctor: "Dr. Sarah Lim",   department: "Dermatology",      status: "completed", notes: "Prescribed topical cream, review in 3 months." },
  { id: "a3", patientId: "p_001", dateTime: daysFromNow(-10, 9, 15),  doctor: "Dr. Amir Khan",   department: "General Practice", status: "cancelled", notes: "" },
  { id: "a4", patientId: "p_001", dateTime: daysFromNow(5, 11, 0),    doctor: "Dr. Priya Nair",  department: "Cardiology",       status: "scheduled", notes: "Bring previous ECG results." },
  { id: "a5", patientId: "p_001", dateTime: daysFromNow(30, 15, 45),  doctor: "Dr. Sarah Lim",   department: "Dermatology",      status: "scheduled", notes: "Follow-up review." },
];

// Simulates network latency so loading states behave like the real thing
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getCurrentPatient() {
  await delay(300);
  return MOCK_PATIENT;
}

export async function getAppointments(patientId) {
  await delay(400);
  // Return copies with real Date objects. Firestore Timestamps will need .toDate() here later.
  return MOCK_APPOINTMENTS
    .filter((a) => a.patientId === patientId)
    .map((a) => ({ ...a, dateTime: new Date(a.dateTime) }));
}