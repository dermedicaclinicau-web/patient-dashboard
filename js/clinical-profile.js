import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COL = "patient_clinical_profile";

// { social?, meds?, conditions?, allergies? }: each { items: [...], updatedAt, updatedBy, syncedThrough, dismissed, log }
export async function fetchClinicalProfile(patient) {
  const snap = await getDoc(doc(db, COL, patient.id));
  return snap.exists() ? snap.data() : {};
}

// Saves ONE section (the other sections are left untouched)
export async function saveClinicalSection(patient, key, section, staff) {
  const uid = auth.currentUser.uid;
  const now = new Date().toISOString();
  const name = (staff && staff.name) || "";
  section.updatedAt = now;
  section.updatedBy = name;
  section.updatedByUid = uid;

  await setDoc(doc(db, COL, patient.id), {
    [key]: section,
    patientId: String(patient.pttId || patient.id),
    patientName: patient.name || "",
    updatedAt: now,
    updatedBy: name,
    updatedByUid: uid,
  }, { merge: true });

  return section;
}