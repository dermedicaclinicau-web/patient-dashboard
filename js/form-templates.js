import { db, auth } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, addDoc, updateDoc, doc, query, where, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { cleanField } from "./form-fields.js";
import { normaliseLetterhead, DEFAULT_LETTERHEAD } from "./form-letterhead.js";

// Keys MUST match the list in the Firestore rules (validFormTemplate).
export const FORM_CATEGORIES = [
  { key: "consent",      label: "Consent forms" },
  { key: "treatment",    label: "Treatment records" },
  { key: "prescription", label: "Prescriptions" },
  { key: "printable",    label: "Printables" },
  { key: "email",        label: "Email templates" },
  { key: "admin",        label: "Admin forms" },
];
const CATEGORY_KEYS = FORM_CATEGORIES.map((c) => c.key);
const COLLECTION = "form_templates";
const CACHE_MS = 60 * 1000;

let cache = null; // { isAdmin, at, list }

export function categoryLabel(key) {
  const c = FORM_CATEGORIES.find((x) => x.key === key);
  return c ? c.label : "Other";
}

function toDate(v) {
  return v && typeof v.toDate === "function" ? v.toDate() : null;
}

function normalise(snap) {
  const d = snap.data() || {};
  return {
    id: snap.id,
    name: d.name || "Untitled form",
    category: CATEGORY_KEYS.includes(d.category) ? d.category : "admin",
    status: d.status || "draft",
    fields: Array.isArray(d.fields) ? d.fields : [],
    fieldCount: Array.isArray(d.fields) ? d.fields.length : 0,
    version: Number(d.version || 0),
    updatedAt: toDate(d.updatedAt) || toDate(d.createdAt),
    updatedBy: d.updatedBy || "",
  };
}

// Admins get everything except archived forms. Other staff only get live ones.
// The live-only filter is required: the rules reject a query that could return drafts.
export async function listFormTemplates({ isAdmin = false, force = false } = {}) {
  if (!force && cache && cache.isAdmin === isAdmin && Date.now() - cache.at < CACHE_MS) {
    return cache.list;
  }
  const ref = collection(db, COLLECTION);
  const snap = await getDocs(isAdmin ? ref : query(ref, where("status", "==", "live")));
  const list = snap.docs
    .map(normalise)
    .filter((t) => t.status !== "archived")
    .sort((a, b) => (b.updatedAt ? b.updatedAt.getTime() : 0) - (a.updatedAt ? a.updatedAt.getTime() : 0));
  cache = { isAdmin, at: Date.now(), list };
  return list;
}

export async function getFormTemplate(id) {
  const snap = await getDoc(doc(db, COLLECTION, id));
  return snap.exists() ? normalise(snap) : null;
}

export async function createFormTemplate({ name, category }, staff) {
  const cleanName = String(name || "").trim().replace(/\s+/g, " ");
  if (!cleanName) throw new Error("Give the form a name.");
  if (cleanName.length > 120) throw new Error("Keep the name under 120 characters.");
  if (!CATEGORY_KEYS.includes(category)) throw new Error("Choose a category.");

  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const staffName = (staff && staff.name) || "";

  const ref = await addDoc(collection(db, COLLECTION), {
    name: cleanName,
    category,
    status: "draft",
    fields: [],
    settings: { letterhead: true, showTitle: true },
    version: 0,
    createdAt: serverTimestamp(),
    createdBy: staffName,
    createdByUid: uid,
    updatedAt: serverTimestamp(),
    updatedBy: staffName,
    updatedByUid: uid,
  });
  cache = null; // the list must show the new form straight away
  return ref.id;
}

// ---------- Saving the editor's work ----------



export async function saveFormTemplate(id, { name, fields, settings }, staff) {
  const cleanName = String(name || "").trim().replace(/\s+/g, " ");
  if (!cleanName) throw new Error("Give the form a name.");
  if (cleanName.length > 120) throw new Error("Keep the name under 120 characters.");

  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");

  const clean = (Array.isArray(fields) ? fields : []).map(cleanField).filter(Boolean);
  if (clean.length > 300) throw new Error("A form can have up to 300 questions.");

  await updateDoc(doc(db, COLLECTION, id), {
    name: cleanName,
    fields: clean,
    updatedAt: serverTimestamp(),
    updatedBy: (staff && staff.name) || "",
    updatedByUid: uid,
    settings: { showLetterhead: !(settings && settings.showLetterhead === false) },
  });
  cache = null;
}

/* ===================== Shared letterhead ===================== */

let letterheadCache = null;

export async function getLetterhead({ force = false } = {}) {
  if (letterheadCache && !force) return letterheadCache;
  const snap = await getDoc(doc(db, "form_settings", "letterhead"));
  letterheadCache = normaliseLetterhead(snap.exists() ? snap.data() : DEFAULT_LETTERHEAD);
  return letterheadCache;
}

export async function saveLetterhead(letterhead, staff) {
  const clean = normaliseLetterhead(letterhead);
  await setDoc(doc(db, "form_settings", "letterhead"), {
    ...clean,
    updatedAt: serverTimestamp(),
    updatedBy: String((staff && (staff.name || staff.email)) || "").slice(0, 120),
  });
  letterheadCache = clean;
  return clean;
}