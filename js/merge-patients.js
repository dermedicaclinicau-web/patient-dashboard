import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, query, where, writeBatch, serverTimestamp, deleteField,
  getCountFromServer, FieldPath,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { patientIds, patientNames } from "./patients.js";
import { formatDobLong } from "./utils.js";

// Collections whose records are linked to a patient by ID
export const LINKED = [
  ["appointment_transcripts", "Patient ID", "consultation note", "consultation notes"],
  ["treatment_records", "Patient ID", "treatment record", "treatment records"],
  ["consent_records", "Patient ID", "consent record", "consent records"],
  ["prescription_record", "Patient ID", "prescription", "prescriptions"],
  ["scanned_file_log", "PatientID", "scanned file", "scanned files"],
  ["staff-task-list", "patientId", "reminder", "reminders"],
  ["patient_personal_notes", "patientId", "personal note", "personal notes"],
];

const PATIENT_FIELDS = [
  "First Name", "Last Name", "Patient Name", "NameKey", "DOB", "DobKey", "IdentityKey",
  "Email", "EmailKey", "Mobile", "PhoneKey", "Address", "MergedIds", "MergedNames",
];
const SECTIONS = ["social", "meds", "conditions", "allergies"];
const normItem = (s) => String(s || "").replace(/^\s*[-•*]\s*/, "").toLowerCase()
  .replace(/\s+/g, " ").trim().replace(/[.;,\s]+$/, "");

/* ===================== Who's doing it ===================== */

async function claims() {
  const user = auth.currentUser;
  if (!user) throw new Error("Please log in again.");
  const c = (await user.getIdTokenResult()).claims;
  return { uid: user.uid, name: String(c.staffName || ""), isAdmin: /^admin$/i.test(String(c.staffRole || "")) };
}

export async function isAdminUser() {
  try { return (await claims()).isAdmin; } catch { return false; }
}

/* ===================== Counting linked records ===================== */

export async function countLinkedRecords(patient) {
  const ids = patientIds(patient);
  const counts = {};
  await Promise.all(LINKED.map(async ([col, field]) => {
    try {
      const snap = await getCountFromServer(query(collection(db, col), where(new FieldPath(field), "in", ids)));
      counts[col] = snap.data().count;
    } catch (err) {
      console.warn(`Counting ${col} failed:`, err);
      counts[col] = null;
    }
  }));
  counts.total = LINKED.reduce((n, [col]) => n + (counts[col] || 0), 0);
  return counts;
}

/* ===================== Merge ===================== */

function detailFields(d) {
  const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
  const first = clean(d.firstName);
  const last = clean(d.lastName);
  if (!first || !last) throw new Error("The kept record needs a first and last name.");
  const email = clean(d.email).replace(/\s/g, "");
  const mobile = String(d.mobile ?? "").replace(/\D/g, "");
  const dobKey = clean(d.dobKey);
  const nameKey = `${last} ${first}`.toLowerCase();
  return {
    "First Name": first, "Last Name": last, "Patient Name": `${first} ${last}`, NameKey: nameKey,
    DobKey: dobKey, DOB: dobKey ? formatDobLong(dobKey) : "",
    IdentityKey: dobKey ? `${nameKey}|${dobKey}` : nameKey,
    Email: email, EmailKey: email.toLowerCase(), Mobile: mobile, PhoneKey: mobile,
    Address: clean(d.address),
  };
}

// Joins two versions of a clinical list without duplicates
function combineSection(base, extra, by, at) {
  if (!extra || !Array.isArray(extra.items)) return base || null;
  if (!base || !Array.isArray(base.items)) {
    return { ...extra, log: [...(extra.log || []), { at, by, action: "merged from duplicate record" }].slice(-100) };
  }
  const have = new Set(base.items.map((i) => normItem(i.text)));
  const added = extra.items.filter((i) => !have.has(normItem(i.text)));
  return {
    ...base,
    items: [...base.items, ...added],
    dismissed: [...new Set([...(base.dismissed || []), ...(extra.dismissed || [])])],
    syncedThrough: Math.min(Number(base.syncedThrough || 0), Number(extra.syncedThrough || 0)),
    log: [...(base.log || []), ...added.map((i) => ({ at, by, action: "merged from duplicate record", text: i.text }))].slice(-100),
  };
}

export async function mergePatients({ survivor, duplicates, details }) {
  const me = await claims();
  if (!me.isAdmin) throw Object.assign(new Error("Only Admins can merge patients."), { code: "not-admin" });
  if (!duplicates.length) throw new Error("Choose at least one record to merge.");

  const at = new Date().toISOString();
  const survRef = doc(db, "patient_list", survivor.id);
  const survSnap = await getDoc(survRef);
  if (!survSnap.exists()) throw new Error("The record to keep no longer exists.");

  // Snapshot for Undo
  const cur = survSnap.data();
  const beforePatient = {};
  PATIENT_FIELDS.forEach((k) => { beforePatient[k] = k in cur ? cur[k] : null; });

  const fields = detailFields(details);
  const own = new Set([survivor.pttId, survivor.id].filter(Boolean));
  const mergedIds = [...new Set([...(survivor.mergedIds || []), ...duplicates.flatMap(patientIds)])]
    .filter((id) => !own.has(id)).slice(0, 28);
  const keptName = fields["Patient Name"].toLowerCase();
  const mergedNames = [...new Set([...(survivor.mergedNames || []), ...duplicates.flatMap(patientNames)])]
    .filter((n) => n && n.toLowerCase() !== keptName).slice(0, 10);

  const batch = writeBatch(db);
  batch.update(survRef, {
    ...fields, MergedIds: mergedIds, MergedNames: mergedNames,
    UpdatedAt: serverTimestamp(), UpdatedBy: me.name, UpdatedByUid: me.uid,
  });
  duplicates.forEach((d) => batch.update(doc(db, "patient_list", d.id), {
    MergedInto: survivor.id, MergedAt: at, MergedBy: me.name, MergedByUid: me.uid,
  }));

  // Combine the clinical lists into the kept patient's profile
  const profSnaps = await Promise.all([survivor, ...duplicates]
    .map((p) => getDoc(doc(db, "patient_clinical_profile", p.id))));
  const [survProf, ...dupProfs] = profSnaps.map((s) => (s.exists() ? s.data() : null));
  let profileChanged = false;
  const combined = {};
  SECTIONS.forEach((k) => {
    let sec = survProf ? survProf[k] || null : null;
    dupProfs.forEach((dp) => {
      if (dp && dp[k]) { sec = combineSection(sec, dp[k], me.name, at); profileChanged = true; }
    });
    if (sec) combined[k] = sec;
  });
  if (profileChanged) {
    batch.set(doc(db, "patient_clinical_profile", survivor.id), {
      ...combined,
      patientId: String(survivor.pttId || survivor.id), patientName: fields["Patient Name"],
      updatedAt: at, updatedBy: me.name, updatedByUid: me.uid,
    }, { merge: true });
  }

  const mergeRef = doc(collection(db, "patient_merges"));
  batch.set(mergeRef, {
    survivorId: survivor.id, survivorPttId: survivor.pttId || "", survivorName: fields["Patient Name"],
    duplicates: duplicates.map((d) => ({ id: d.id, pttId: d.pttId || "", name: d.name })),
    before: { patient: beforePatient, profile: survProf, profileChanged },
    mergedAt: at, mergedBy: me.name, mergedByUid: me.uid, undone: false,
  });

  await batch.commit(); // all or nothing
  window.dispatchEvent(new CustomEvent("patient-updated", { detail: { id: survivor.id } }));
  return { mergeId: mergeRef.id };
}

/* ===================== Undo ===================== */

export async function latestMerge(survivorId) {
  const snap = await getDocs(query(collection(db, "patient_merges"), where("survivorId", "==", survivorId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => !m.undone)
    .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))[0] || null;
}

export async function undoMerge(merge) {
  const me = await claims();
  if (!me.isAdmin) throw Object.assign(new Error("Only Admins can undo a merge."), { code: "not-admin" });
  const at = new Date().toISOString();
  const batch = writeBatch(db);

  const restore = {};
  Object.entries((merge.before && merge.before.patient) || {}).forEach(([k, v]) => {
    restore[k] = v === null ? deleteField() : v;
  });
  batch.update(doc(db, "patient_list", merge.survivorId), {
    ...restore, UpdatedAt: serverTimestamp(), UpdatedBy: me.name, UpdatedByUid: me.uid,
  });

  (merge.duplicates || []).forEach((d) => batch.update(doc(db, "patient_list", d.id), {
    MergedInto: deleteField(), MergedAt: deleteField(), MergedBy: deleteField(), MergedByUid: deleteField(),
  }));

  if (merge.before && merge.before.profileChanged) {
    const prof = merge.before.profile || {};
    const sections = {};
    SECTIONS.forEach((k) => { if (prof[k]) sections[k] = prof[k]; });
    batch.set(doc(db, "patient_clinical_profile", merge.survivorId), {
      ...sections,
      patientId: String(merge.survivorPttId || merge.survivorId), patientName: merge.survivorName || "",
      updatedAt: at, updatedBy: me.name, updatedByUid: me.uid,
    }); // full replace = exactly as before the merge
  }

  batch.update(doc(db, "patient_merges", merge.id), {
    undone: true, undoneAt: at, undoneBy: me.name, undoneByUid: me.uid,
  });

  await batch.commit();
  window.dispatchEvent(new CustomEvent("patient-updated", { detail: { id: merge.survivorId } }));
}