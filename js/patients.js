import { db, auth } from "./firebase-config.js";
import { formatDobLong, toDateKeyLoose } from "./utils.js";
import {
  collection, query, where, orderBy, limit, startAfter, getDocs,
  doc, getDoc, updateDoc, serverTimestamp,
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
  return { changed: true };
}