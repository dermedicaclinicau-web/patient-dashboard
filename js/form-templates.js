import { db, auth } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, addDoc, updateDoc, setDoc, doc, query, where, serverTimestamp, writeBatch,
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

let cache = null;          // Form Builder list: { isAdmin, at, list }
let publishedCache = null; // Patient dashboard dropdowns: { at, list }

export function categoryLabel(key) {
  const c = FORM_CATEGORIES.find((x) => x.key === key);
  return c ? c.label : "Other";
}

function toDate(v) {
  return v && typeof v.toDate === "function" ? v.toDate() : null;
}

function currentUid() {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  return uid;
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
    settings: d.settings && typeof d.settings === "object" ? d.settings : {},
    version: Number(d.version || 0),
    publishedAt: toDate(d.publishedAt),
    publishedBy: d.publishedBy || "",
    updatedAt: toDate(d.updatedAt) || toDate(d.createdAt),
    updatedBy: d.updatedBy || "",
  };
}

// The exact shape that gets saved and published. Also used to tell whether
// a live form has changes that haven't been published yet.
export function formSnapshot({ name, fields, settings }) {
  return {
    name: String(name || "").trim().replace(/\s+/g, " ").slice(0, 120) || "Untitled form",
    fields: (Array.isArray(fields) ? fields : []).map(cleanField).filter(Boolean),
    settings: { showLetterhead: !(settings && settings.showLetterhead === false) },
  };
}

function checkForm({ name, fields }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Give the form a name.");
  if (cleanName.length > 120) throw new Error("Keep the name under 120 characters.");
  if (Array.isArray(fields) && fields.length > 300) throw new Error("A form can have up to 300 questions.");
}

/* ===================== Form Builder list ===================== */

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

// Published forms for the patient dashboard, A to Z. Same for every role.
export async function listPublishedForms({ force = false } = {}) {
  if (!force && publishedCache && Date.now() - publishedCache.at < CACHE_MS) return publishedCache.list;
  const snap = await getDocs(query(collection(db, COLLECTION), where("status", "==", "live")));
  const list = snap.docs
    .map(normalise)
    .filter((t) => t.version > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
  publishedCache = { at: Date.now(), list };
  return list;
}

export async function getFormTemplate(id) {
  const snap = await getDoc(doc(db, COLLECTION, id));
  return snap.exists() ? normalise(snap) : null;
}

export async function getFormVersion(id, version) {
  const snap = await getDoc(doc(db, COLLECTION, id, "versions", String(version)));
  if (!snap.exists()) return null;
  const d = snap.data() || {};
  return {
    version: Number(d.version || version),
    name: d.name || "Untitled form",
    category: d.category || "",
    fields: Array.isArray(d.fields) ? d.fields : [],
    settings: d.settings && typeof d.settings === "object" ? d.settings : {},
    publishedAt: toDate(d.publishedAt),
    publishedBy: d.publishedBy || "",
  };
}

export async function createFormTemplate({ name, category }, staff) {
  const cleanName = String(name || "").trim().replace(/\s+/g, " ");
  if (!cleanName) throw new Error("Give the form a name.");
  if (cleanName.length > 120) throw new Error("Keep the name under 120 characters.");
  if (!CATEGORY_KEYS.includes(category)) throw new Error("Choose a category.");

  const uid = currentUid();
  const staffName = (staff && staff.name) || "";

  const ref = await addDoc(collection(db, COLLECTION), {
    name: cleanName,
    category,
    status: "draft",
    fields: [],
    settings: { showLetterhead: true },
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

/* ===================== Saving the editor's work ===================== */

// status: leave out for a normal save, "draft" to unpublish, "archived" to delete.
export async function saveFormTemplate(id, { name, fields, settings, status }, staff) {
  checkForm({ name, fields });
  const uid = currentUid();
  await updateDoc(doc(db, COLLECTION, id), {
    ...formSnapshot({ name, fields, settings }),
    ...(status === "archived" || status === "draft" ? { status } : {}),
    updatedAt: serverTimestamp(),
    updatedBy: (staff && staff.name) || "",
    updatedByUid: uid,
  });
  cache = null;
  if (status) publishedCache = null;
}

/* ===================== Publishing ===================== */

// Saves a frozen copy as versions/{n+1} and makes the form live, in one step.
// fromVersion is the version the editor loaded; if someone else has published
// since, this stops instead of overwriting their work.
export async function publishFormTemplate(id, { name, fields, settings }, staff, fromVersion) {
  checkForm({ name, fields });
  const uid = currentUid();
  const staffName = (staff && staff.name) || "";
  const ref = doc(db, COLLECTION, id);

  const now = await getDoc(ref);
  if (!now.exists()) throw new Error("This form no longer exists.");
  const current = Number(now.data().version || 0);
  if (current !== Number(fromVersion || 0)) {
    const err = new Error("Someone else published this form while you were editing. Reload the page to see their version.");
    err.code = "conflict";
    throw err;
  }

  const next = current + 1;
  const snap = formSnapshot({ name, fields, settings });
  const batch = writeBatch(db);
  batch.set(doc(db, COLLECTION, id, "versions", String(next)), {
    version: next,
    name: snap.name,
    category: now.data().category,
    fields: snap.fields,
    settings: snap.settings,
    publishedAt: serverTimestamp(),
    publishedBy: staffName,
    publishedByUid: uid,
  });
  batch.update(ref, {
    ...snap,
    status: "live",
    version: next,
    publishedAt: serverTimestamp(),
    publishedBy: staffName,
    updatedAt: serverTimestamp(),
    updatedBy: staffName,
    updatedByUid: uid,
  });
  try {
    await batch.commit();
  } catch (err) {
    // The version already exists: someone published at the same moment
    if (err && err.code === "permission-denied") {
      const after = await getDoc(ref).catch(() => null);
      if (after && Number(after.data().version || 0) !== current) {
        const e = new Error("Someone else published this form at the same time. Reload the page to see their version.");
        e.code = "conflict";
        throw e;
      }
    }
    throw err;
  }
  cache = null;
  publishedCache = null;
  return next;
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