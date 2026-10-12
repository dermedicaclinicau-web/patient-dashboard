// Treatment plan settings: concern colours/names, and which concerns each appointment service treats (+ downtime).
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CATEGORIES, canonicalCategory } from "./plan-editor.js";
import { serviceKey } from "./inventory-api.js";
import { callApi } from "./appointments.js";

// Default colour per concern (matches the mockups)
export const CONCERN_COLOURS = {
  "Expression Lines & Wrinkles": "#7F77DD",
  "Volume Loss": "#378ADD",
  "Skin Laxity": "#D4537E",
  "Skin Texture & Quality": "#1D9E75",
  "Pigmentation": "#BA7517",
  "Redness & Vascular Concerns": "#E24B4A",
  "Collagen Replenishment": "#D85A30",
  "Body Contouring": "#888780",
  "Acne & Acne Scarring": "#639922",
};

const HEX = /^#[0-9a-f]{6}$/i;
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const intIn = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };

function stamp(staff) {
  const u = auth.currentUser && auth.currentUser.uid;
  if (!u) throw new Error("Your session has ended. Log in again.");
  return { updatedAt: serverTimestamp(), updatedBy: clip(staff && staff.name, 120), updatedByUid: u };
}

// One service's set-up
export function cleanServiceRow(r = {}) {
  const concerns = [...new Set((Array.isArray(r.concerns) ? r.concerns : []).map(canonicalCategory).filter(Boolean))];
  return {
    service: clip(r.service, 150),
    concerns,
    notTreatment: r.notTreatment === true && !concerns.length,
    downtimeDays: intIn(r.downtimeDays, 0, 60),
    downtimeNote: clip(r.downtimeNote, 80),
    source: r.source === "ai" ? "ai" : "staff",
  };
}

// { concerns: [{ name, label, colour }] (always the 9, in order), services: [...] }
export async function getPlanSettings() {
  const [c, s] = await Promise.all([
    getDoc(doc(db, "plan_settings", "concerns")),
    getDoc(doc(db, "plan_settings", "services")),
  ]);
  const saved = c.exists() && Array.isArray(c.data().concerns) ? c.data().concerns : [];
  const concerns = CATEGORIES.map((name) => {
    const x = saved.find((y) => canonicalCategory(y && y.name) === name) || {};
    return { name, label: clip(x.label, 60) || name, colour: HEX.test(x.colour || "") ? x.colour : CONCERN_COLOURS[name] };
  });
  const services = (s.exists() && Array.isArray(s.data().services) ? s.data().services : [])
    .map(cleanServiceRow).filter((r) => r.service);
  return { concerns, services };
}

export async function savePlanConcerns(concerns, staff) {
  const clean = CATEGORIES.map((name) => {
    const x = (concerns || []).find((y) => y.name === name) || {};
    return { name, label: clip(x.label, 60) || name, colour: HEX.test(x.colour || "") ? x.colour : CONCERN_COLOURS[name] };
  });
  await setDoc(doc(db, "plan_settings", "concerns"), { concerns: clean, ...stamp(staff) });
}

// Only services that have been set up are saved (concerns, "not a treatment", or a downtime)
export async function saveServiceConcerns(rows, staff) {
  const seen = new Set();
  const clean = (rows || []).map(cleanServiceRow)
    .filter((r) => r.service && (r.concerns.length || r.notTreatment || r.downtimeDays))
    .filter((r) => !seen.has(serviceKey(r.service)) && seen.add(serviceKey(r.service)))
    .slice(0, 600);
  await setDoc(doc(db, "plan_settings", "services"), { services: clean, ...stamp(staff) });
}

// Gemini suggestions for service names (Admins only). [{ service, concerns, notTreatment, downtimeDays }]
export async function suggestServiceConcerns(names) {
  const res = await callApi({ action: "plan", op: "suggestServices", services: (names || []).slice(0, 120) });
  return (Array.isArray(res.items) ? res.items : []).map((it) => cleanServiceRow({ ...it, source: "ai" }));
}

// Look-up used by the master plan: the set-up for one appointment service name, or null
export function serviceSetup(services, name) {
  const k = serviceKey(name);
  return (services || []).find((r) => serviceKey(r.service) === k) || null;
}

/* ---------- Patient copy: design settings (plan_settings/document) ---------- */

export const PLAN_DOC_DEFAULTS = {
  title: "Your treatment plan",
  colour: "#0F766E",
  welcome: "Hi {First name},\n\nThank you for coming in to see us. Here is the treatment plan we talked about, organised by the concerns you'd like to work on.",
  closing: "If you have any questions about your plan, or you'd like to book your next treatment, give us a call or reply to this email.",
  disclaimer: "Prices are a guide only and may change. Your clinician will confirm the details at each visit.",
  showPrices: true,
  emailSubject: "Your treatment plan - Dermedica",
  emailMessage: "Hi {First name},\n\nYour treatment plan is attached. If you have any questions, or you'd like to book, reply to this email or give us a call.\n\nKind regards,\nDermedica",
};

function cleanDocSettings(x = {}) {
  const d = PLAN_DOC_DEFAULTS;
  const text = (v, n, fb) => (typeof v === "string" ? String(v).slice(0, n) : fb);
  return {
    title: clip(x.title, 80) || d.title,
    colour: HEX.test(x.colour || "") ? x.colour : d.colour,
    welcome: text(x.welcome, 2000, d.welcome),
    closing: text(x.closing, 2000, d.closing),
    disclaimer: text(x.disclaimer, 1000, d.disclaimer),
    showPrices: x.showPrices === undefined ? d.showPrices : x.showPrices === true,
    emailSubject: clip(x.emailSubject, 200) || d.emailSubject,
    emailMessage: text(x.emailMessage, 3000, d.emailMessage),
  };
}

export async function getPlanDocSettings() {
  const s = await getDoc(doc(db, "plan_settings", "document"));
  return cleanDocSettings(s.exists() ? s.data() : {});
}

export async function savePlanDocSettings(x, staff) {
  await setDoc(doc(db, "plan_settings", "document"), { ...cleanDocSettings(x), ...stamp(staff) });
}

// The PDF → the clinic printer, or emailed to the patient (Apps Script checks access and logs it)
export async function deliverPlanDoc(payload) {
  return callApi({ action: "plan", op: "deliver", ...payload });
}