import { db, auth } from "./firebase-config.js";
import { formatDobLong, toDateKeyLoose } from "./utils.js";
import {
  collection, query, where, orderBy, limit, startAfter, getDocs,
  doc, getDoc, setDoc, updateDoc, serverTimestamp, getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COLLECTION = "patient_list";
export const PAGE_SIZE = 20;

/**
 * Fetch one page of patients.
 * mode: "name" (searches NameKey) | "email" (searches EmailKey)
 * term: search text ("" = browse everyone)
 * cursor: last document from the previous page (null for page 1)
 */
export async function fetchPatients({ mode = "name", term = "", cursor = null } = {}) {
  const field = mode === "email" ? "EmailKey" : "NameKey";
  const t = normalise(term, mode);

  const result = await runQuery(field, t, cursor);

  // NameKey is "surname firstname". If "johnny cooney" finds nothing, retry as "cooney johnny".
  if (mode === "name" && !cursor && result.patients.length === 0 && t.includes(" ")) {
    const reversed = reverseName(t);
    const retry = await runQuery(field, reversed, null);
    if (retry.patients.length) return { ...retry, term: reversed };
  }

  return { ...result, term: t };
}

async function runQuery(field, term, cursor) {
  const constraints = [];
  if (term) {
    // "starts with" search: Firestore has no "contains" search
    constraints.push(where(field, ">=", term), where(field, "<=", term + "\uf8ff"));
  }
  constraints.push(orderBy(field));
  if (cursor) constraints.push(startAfter(cursor));
  constraints.push(limit(PAGE_SIZE + 1)); // fetch 1 extra to know if there's a next page

  const snap = await getDocs(query(collection(db, COLLECTION), ...constraints));
  const docs = snap.docs.slice(0, PAGE_SIZE);

  return {
    patients: docs.map(toPatient),
    cursor: docs.length ? docs[docs.length - 1] : null,
    hasMore: snap.docs.length > PAGE_SIZE,
  };
}

function normalise(term, mode) {
  const t = String(term || "").toLowerCase().trim();
  return mode === "email" ? t.replace(/\s+/g, "") : t.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

function reverseName(t) {
  const parts = t.split(" ");
  return [parts[parts.length - 1], ...parts.slice(0, -1)].join(" ");
}

function toPatient(snap) {
  const d = snap.data();
  return {
    id: snap.id,
    pttId: d.PttID || "",
    firstName: d["First Name"] || "",
    lastName: d["Last Name"] || "",
    name: d["Patient Name"] || [d["First Name"], d["Last Name"]].filter(Boolean).join(" ") || "Unnamed patient",
    nameKey: d.NameKey || "",
    email: d.Email || "",
    mobile: d.Mobile || "",
    address: d.Address || "",
    // Use DobKey if it's readable, otherwise work it out from DOB (any common format)
    dobKey: toDateKeyLoose(d.DobKey) || toDateKeyLoose(d.DOB),
    dob: typeof d.DOB === "string" ? d.DOB : "",
  };
}

// Load one patient. Accepts the Firestore doc ID (from the patient list)
// OR the PttID (from calendar cards, which use the sheet's Patient ID).
export async function getPatient(id) {
  if (!id) return null;

  if (!id.includes("/")) {
    const snap = await getDoc(doc(db, COLLECTION, id));
    if (snap.exists()) return toPatient(snap);
  }

  const res = await getDocs(query(collection(db, COLLECTION), where("PttID", "==", id), limit(1)));
  return res.empty ? null : toPatient(res.docs[0]);
}

// Save edits. Only changed fields are written, and the search keys
// (NameKey, EmailKey, etc.) are kept in sync so search keeps working.
export async function updatePatient(current, input, staff) {
  const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
  const first = clean(input.firstName);
  const last = clean(input.lastName);
  const email = clean(input.email).replace(/\s/g, "");
  const mobile = String(input.mobile ?? "").replace(/\D/g, "");
  const address = clean(input.address);
  const dobKey = clean(input.dobKey);

  if (!first || !last) throw new Error("First and last name are required.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Please enter a valid email address.");
  if (dobKey && !/^\d{4}-\d{2}-\d{2}$/.test(dobKey)) throw new Error("Please enter a valid date of birth.");

  const updates = {};
  const nameChanged = first !== current.firstName || last !== current.lastName;
  const dobChanged = dobKey !== current.dobKey;
  let nameKey = current.nameKey;

  if (nameChanged) {
    nameKey = `${last} ${first}`.toLowerCase();
    Object.assign(updates, {
      "First Name": first,
      "Last Name": last,
      "Patient Name": `${first} ${last}`,
      NameKey: nameKey,
    });
  }
  if (dobChanged) {
    Object.assign(updates, { DobKey: dobKey, DOB: dobKey ? formatDobLong(dobKey) : "" });
  }
  if (nameChanged || dobChanged) {
    updates.IdentityKey = dobKey ? `${nameKey}|${dobKey}` : nameKey;
  }
  if (email !== current.email) {
    Object.assign(updates, { Email: email, EmailKey: email.toLowerCase() });
  }
  if (mobile !== String(current.mobile).replace(/\D/g, "")) {
    Object.assign(updates, { Mobile: mobile, PhoneKey: mobile });
  }
  if (address !== current.address) updates.Address = address;

  if (!Object.keys(updates).length) return { changed: false };

  Object.assign(updates, {
    UpdatedAt: serverTimestamp(),
    UpdatedBy: (staff && staff.name) || "",
    UpdatedByUid: auth.currentUser ? auth.currentUser.uid : "",
  });

  await updateDoc(doc(db, COLLECTION, current.id), updates);
  // Lets the Patient List refresh its in-memory copy (new name / email shows up in search)
  window.dispatchEvent(new CustomEvent("patient-updated", { detail: { id: current.id } }));
  return { changed: true };
}

/* ===================== Patient list helpers ===================== */

// Total number of patients (a cheap aggregation, not a full read)
export async function countPatients() {
  const snap = await getCountFromServer(collection(db, COLLECTION));
  return snap.data().count;
}

// Exact ID match: PttID (as typed or upper-case) or the Firestore document ID
export async function findPatientsById(term) {
  const t = String(term || "").trim();
  if (!t || /\s/.test(t) || t.length > 64) return [];

  const variants = [...new Set([t, t.toUpperCase()])];
  const [byPtt, byDoc] = await Promise.all([
    getDocs(query(collection(db, COLLECTION), where("PttID", "in", variants), limit(10))),
    /^[\w-]+$/.test(t) ? getDoc(doc(db, COLLECTION, t)) : null,
  ]);

  const out = new Map();
  byPtt.forEach((d) => out.set(d.id, toPatient(d)));
  if (byDoc && byDoc.exists()) out.set(byDoc.id, toPatient(byDoc));
  return [...out.values()];
}

// "+61 417 153 855" / "0417153855" / "417153855" -> "417153855"
export function phoneCore(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("61")) d = d.slice(2);
  else if (d.startsWith("0")) d = d.slice(1);
  return d;
}

// Phone search that copes with numbers stored as 61…, 0… or without the leading 0
export async function searchPatientsByPhone(term) {
  const core = phoneCore(term);
  if (core.length < 3) return [];

  const variants = [core, `0${core}`, `61${core}`];
  const snaps = await Promise.all(variants.map((v) =>
    getDocs(query(collection(db, COLLECTION),
      where("PhoneKey", ">=", v), where("PhoneKey", "<=", v + "\uf8ff"),
      orderBy("PhoneKey"), limit(20)))
  ));

  const out = new Map();
  snaps.forEach((s) => s.forEach((d) => out.set(d.id, toPatient(d))));
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Every patient (only used by Duplicates / Birthday / Age filters, then kept in memory)
export async function fetchAllPatients() {
  const snap = await getDocs(collection(db, COLLECTION));
  return snap.docs
    .map(toPatient)
    .sort((a, b) => (a.nameKey || a.name.toLowerCase()).localeCompare(b.nameKey || b.name.toLowerCase()));
}

/* ===================== New patients ===================== */

// "PAT-" + milliseconds, the same format as existing system-generated IDs
async function newPatientId() {
  for (let i = 0; i < 5; i++) {
    const id = `PAT-${Date.now() + i}`;
    const snap = await getDoc(doc(db, COLLECTION, id));
    if (!snap.exists()) return id;
  }
  throw new Error("Couldn't create a patient ID. Please try again.");
}

// Exact-match check straight from Firestore (catches patients added since the list was loaded)
export async function findPossibleDuplicates({ nameKey, email, mobile }) {
  const col = collection(db, COLLECTION);
  const checks = [];
  if (nameKey) checks.push(getDocs(query(col, where("NameKey", "==", nameKey), limit(10))));
  if (email) checks.push(getDocs(query(col, where("EmailKey", "==", email.toLowerCase()), limit(10))));
  const core = phoneCore(mobile);
  if (core.length >= 8) {
    checks.push(getDocs(query(col, where("PhoneKey", "in", [core, `0${core}`, `61${core}`]), limit(10))));
  }

  const out = new Map();
  (await Promise.all(checks)).forEach((snap) => snap.forEach((d) => out.set(d.id, toPatient(d))));
  return [...out.values()];
}

// Creates a patient with the same fields (and search keys) as existing records
export async function createPatient(input) {
  const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
  const first = clean(input.firstName);
  const last = clean(input.lastName);
  const email = clean(input.email).replace(/\s/g, "");
  const mobile = String(input.mobile ?? "").replace(/\D/g, "");
  const address = clean(input.address);
  const dobKey = clean(input.dobKey);

  if (!first || !last) throw new Error("First and last name are required.");
  if (phoneCore(mobile).length < 8) throw new Error("Please enter a valid mobile number.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Please enter a valid email address.");
  if (dobKey && !/^\d{4}-\d{2}-\d{2}$/.test(dobKey)) throw new Error("Please enter a valid date of birth.");

  const user = auth.currentUser;
  if (!user) throw new Error("Please log in again.");
  let staffName = "";
  try { staffName = (await user.getIdTokenResult()).claims.staffName || ""; } catch { /* optional */ }

  const pttId = await newPatientId();
  const nameKey = `${last} ${first}`.toLowerCase();

  await setDoc(doc(db, COLLECTION, pttId), {
    PttID: pttId,
    "First Name": first,
    "Last Name": last,
    "Patient Name": `${first} ${last}`,
    NameKey: nameKey,
    Email: email,
    EmailKey: email.toLowerCase(),
    Mobile: mobile,
    PhoneKey: mobile,
    Address: address,
    DobKey: dobKey,
    DOB: dobKey ? formatDobLong(dobKey) : "",
    IdentityKey: dobKey ? `${nameKey}|${dobKey}` : nameKey,
    CreatedAt: serverTimestamp(),
    CreatedBy: staffName,
    CreatedByUid: user.uid,
    Source: "Staff dashboard",
  });

  window.dispatchEvent(new CustomEvent("patient-updated", { detail: { id: pttId } }));
  return { id: pttId, pttId, name: `${first} ${last}` };
}