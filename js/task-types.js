// Task types (Task Manager): saving, loading and tidying.
import { db, auth } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, addDoc, updateDoc, doc, query, where, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { cleanRichHtml, textToRichHtml } from "./rich-html.js";

const COL = "task_types";
const CACHE_MS = 60 * 1000;
let cache = null; // { isAdmin, at, list }

export const TASK_CATEGORIES = [
  { key: "patient", label: "To Patient" },
  { key: "staff", label: "To Staff" },
];
export const TASK_FIELD_TYPES = {
  short_text: "Short answer",
  long_text: "Long answer",
  number: "Number",
  date: "Date",
  dropdown: "Dropdown",
  single_choice: "Single choice",
  checkboxes: "Checkboxes",
};
export const TASK_CHOICE_TYPES = ["dropdown", "single_choice", "checkboxes"];
export const CHOICE_DISPLAYS = {
  inline: "In a sentence (A, B and C)",
  bullets: "As a list",
  links: "As a list with links",
};
const SOURCE_KEYS = ["list", "treatments", "staff", "printables"];

export const EMAIL_STYLE_DEFAULT = { background: "#f1f5f9", width: 600, logo: true, footer: true, accent: "#0f766e" };
function cleanEmailStyle(s) {
  const x = s || {};
  const hex = /^#[0-9a-fA-F]{6}$/;
  return {
    background: hex.test(x.background) ? x.background : EMAIL_STYLE_DEFAULT.background,
    width: Number(x.width) === 700 ? 700 : 600,
    logo: x.logo !== false,
    footer: x.footer !== false,
    accent: hex.test(x.accent) ? x.accent : EMAIL_STYLE_DEFAULT.accent,
  };
}

const clip = (v, n) => String(v ?? "").slice(0, n);
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);

export function cleanTaskField(f) {
  if (!f) return null;
  // The earlier "Treatments" field is now Checkboxes connected to Treatment information
  if (f.type === "treatments") f = { ...f, type: "checkboxes", source: "treatments", display: "links" };
  if (!TASK_FIELD_TYPES[f.type]) return null;
  const out = {
    id: clip(f.id, 40),
    type: f.type,
    label: clip(f.label, 120),
    required: f.required === true,
    help: clip(f.help, 300),
    placeholder: clip(f.placeholder, 100),
  };
  if (TASK_CHOICE_TYPES.includes(f.type)) {
    out.source = SOURCE_KEYS.includes(f.source) ? f.source : "list";
    out.display = Object.keys(CHOICE_DISPLAYS).includes(f.display)
      ? f.display : (f.type === "checkboxes" ? "bullets" : "inline");
    out.options = (Array.isArray(f.options) ? f.options : [])
      .map((o) => (typeof o === "string" ? { label: o, link: "" } : { label: o && o.label, link: o && o.link }))
      .map((o) => ({ label: clip(o.label, 120).trim(), link: clip(o.link, 500).trim() }))
      .filter((o) => o.label || o.link)
      .slice(0, 60);
  }
  return out;
}


// The saved shape of a task type (everything except status and the who/when stamps)
export function taskSnapshot(t = {}) {
  const category = t.category === "staff" ? "staff" : "patient";
  const r = t.recipients || {};
  return {
    name: clip(t.name, 120).trim() || "Untitled task",
    description: clip(t.description, 300),
    category,
    channel: t.channel === "sms" ? "sms" : "email",
    fields: (Array.isArray(t.fields) ? t.fields : []).map(cleanTaskField).filter(Boolean).slice(0, 40),
    recipients: {
      mode: category === "staff" ? (r.mode === "fixed" ? "fixed" : "choose") : "patient",
      staffIds: (Array.isArray(r.staffIds) ? r.staffIds : []).map((s) => clip(s, 80)).filter(Boolean).slice(0, 30),
      cc: clip(r.cc, 254).trim(),
      aboutPatient: category === "staff" && r.aboutPatient === true,
    },
    subject: clip(t.subject, 200),
    format: "rich",
    body: (t.format === "rich" ? cleanRichHtml(t.body) : textToRichHtml(t.body)).slice(0, 60000),
    style: cleanEmailStyle(t.style),
    attachments: (Array.isArray(t.attachments) ? t.attachments : [])
      .map(String).filter((id) => /^[A-Za-z0-9]{10,40}$/.test(id)).slice(0, 3),
  };
}

function normalise(snap) {
  const d = snap.data() || {};
  return {
    id: snap.id,
    ...taskSnapshot(d),
    status: d.status || "draft",
    updatedAt: toDate(d.updatedAt) || toDate(d.createdAt),
    updatedBy: d.updatedBy || "",
  };
}

function currentUid() {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  return uid;
}

// Admins get every task type except deleted ones; staff only get live ones
export async function listTaskTypes({ isAdmin = false, force = false } = {}) {
  if (!force && cache && cache.isAdmin === isAdmin && Date.now() - cache.at < CACHE_MS) return cache.list;
  const ref = collection(db, COL);
  const snap = await getDocs(isAdmin ? ref : query(ref, where("status", "==", "live")));
  const list = snap.docs.map(normalise)
    .filter((t) => t.status !== "archived")
    .sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
  cache = { isAdmin, at: Date.now(), list };
  return list;
}

export async function getTaskType(id) {
  const snap = await getDoc(doc(db, COL, id));
  return snap.exists() ? normalise(snap) : null;
}

export async function createTaskType(data, staff) {
  const uid = currentUid();
  const who = (staff && staff.name) || "";
  const ref = await addDoc(collection(db, COL), {
    ...taskSnapshot(data),
    status: "draft",
    createdAt: serverTimestamp(), createdBy: who, createdByUid: uid,
    updatedAt: serverTimestamp(), updatedBy: who, updatedByUid: uid,
  });
  cache = null;
  return ref.id;
}

// status: leave out for a normal save, or "live" / "draft" / "archived"
export async function saveTaskType(id, data, staff, status) {
  const uid = currentUid();
  await updateDoc(doc(db, COL, id), {
    ...taskSnapshot(data),
    ...(["draft", "live", "archived"].includes(status) ? { status } : {}),
    updatedAt: serverTimestamp(),
    updatedBy: (staff && staff.name) || "",
    updatedByUid: uid,
  });
  cache = null;
}

// Staff names and roles (emails stay in Apps Script)
let staffJob = null;
export function fetchStaffList() {
  if (!staffJob) {
    staffJob = callApi({ action: "staffList" })
      .then((r) => r.staff || [])
      .catch((err) => { staffJob = null; throw err; });
  }
  return staffJob;
}