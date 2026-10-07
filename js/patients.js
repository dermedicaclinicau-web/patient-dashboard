import { db } from "./firebase-config.js";
import {
  collection, query, where, orderBy, limit, startAfter, getDocs,
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
    name: d["Patient Name"] || [d["First Name"], d["Last Name"]].filter(Boolean).join(" ") || "Unnamed patient",
    email: d.Email || "",
    dobKey: d.DobKey || "",
    dob: d.DOB || "",
  };
}