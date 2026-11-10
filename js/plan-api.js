// Treatment plan settings: concern colours/names, and which concerns each appointment service treats (+ downtime).
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { BUILT_IN_CATEGORIES, PATTERNS, canonicalCategory, setCategories, catKey } from "./plan-editor.js";
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

const EXTRA_COLOURS = ["#0F766E", "#9333EA", "#DB2777", "#0891B2", "#CA8A04", "#4F46E5"];

// Saved rows → the full list: the clinic's order, the built-in 9 always present, no duplicates.
// hidden: removed in settings (kept so older plans still show its name and colour). custom: added by the clinic.
function concernList(saved) {
  const seen = new Set();
  const out = [];
  const add = (x, builtIn) => {
    const name = builtIn || clip(x && x.name, 60).replace(/\s+/g, " ");
    const k = catKey(name);
    if (!k || seen.has(k) || (!builtIn && out.length >= 40)) return;
    seen.add(k);
    out.push({
      name,
      label: clip(x && x.label, 60) || name,
      colour: HEX.test((x && x.colour) || "") ? x.colour
        : CONCERN_COLOURS[name] || EXTRA_COLOURS[out.length % EXTRA_COLOURS.length],
      hidden: !!(x && x.hidden === true),
      custom: !BUILT_IN_CATEGORIES.includes(name),
    });
  };
  (Array.isArray(saved) ? saved : []).forEach((x) =>
    add(x, BUILT_IN_CATEGORIES.find((b) => catKey(b) === catKey(x && x.name)) || ""));
  BUILT_IN_CATEGORIES.forEach((b) => add({}, b));   // a built-in that hasn't been saved yet
  return out;
}
const registerConcerns = (list) =>
  setCategories(list.filter((x) => !x.hidden).map((x) => x.name), list.map((x) => x.name));

// One treatment in a concern's list (System configuration → Treatment plans)
export function cleanTreatment(t = {}) {
  const list = (v, n, max) => [...new Set((Array.isArray(v) ? v : []).map((s) => clip(s, n)).filter(Boolean))].slice(0, max);
  const pattern = PATTERNS.includes(t.pattern) ? t.pattern : "unknown";
  return {
    id: /^[a-z0-9]{6,24}$/.test(String(t.id || "")) ? t.id
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
    concern: canonicalCategory(t.concern),
    name: clip(t.name, 120),
    services: list(t.services, 150, 20),   // appointment services that count as this treatment
    areas: list(t.areas, 60, 12),          // the areas it's offered for
    quote: clip(t.quote, 200),             // e.g. "$899 per session"
    description: clip(t.description, 300), // what it does, in the patient's words (shown on their copy)
    pattern,
    sessions: pattern === "course" ? intIn(t.sessions, 1, 52) : 0,
    intervalWeeks: pattern === "once" ? 0 : intIn(t.intervalWeeks, 0, 520),
    intervalUnit: pattern !== "once" && (t.intervalUnit === "m" || t.intervalUnit === "w") ? t.intervalUnit : "",
    hidden: t.hidden === true,
  };
}

// { concerns: [{ name, label, colour, hidden, custom }], services: [...], treatments: [...] }
export async function getPlanSettings() {
  const [c, s, t] = await Promise.all([
    getDoc(doc(db, "plan_settings", "concerns")),
    getDoc(doc(db, "plan_settings", "services")),
    getDoc(doc(db, "plan_settings", "treatments")).catch(() => null),
  ]);
  const concerns = concernList(c.exists() ? c.data().concerns : []);
  registerConcerns(concerns);   // before the services and treatments are read: they name concerns
  const services = (s.exists() && Array.isArray(s.data().services) ? s.data().services : [])
    .map(cleanServiceRow).filter((r) => r.service);
  const treatments = (t && t.exists() && Array.isArray(t.data().treatments) ? t.data().treatments : [])
    .map(cleanTreatment).filter((x) => x.name && x.concern);
  return { concerns, services, treatments };
}

async function writeConcerns(list, staff) {
  const clean = concernList(list).map(({ name, label, colour, hidden }) => ({ name, label, colour, hidden }));
  await setDoc(doc(db, "plan_settings", "concerns"), { concerns: clean, ...stamp(staff) });
  registerConcerns(concernList(clean));
}

// The whole list exactly as given: order, hidden ones and the clinic's own (the Concerns and treatments card)
export function savePlanConcernList(concerns, staff) {
  return writeConcerns(concerns, staff);
}

// Names and colours only (the older Concerns card). The order, hidden concerns and the clinic's own stay as saved.
export async function savePlanConcerns(concerns, staff) {
  const snap = await getDoc(doc(db, "plan_settings", "concerns"));
  const saved = concernList(snap.exists() ? snap.data().concerns : []);
  const by = new Map((concerns || []).map((x) => [catKey(x && x.name), x]));
  await writeConcerns(saved.map((c) => {
    const x = by.get(catKey(c.name));
    return x ? { ...c, label: x.label, colour: x.colour } : c;
  }), staff);
}

export async function savePlanTreatments(rows, staff) {
  const clean = (rows || []).map(cleanTreatment).filter((t) => t.name && t.concern).slice(0, 300);
  await setDoc(doc(db, "plan_settings", "treatments"), { treatments: clean, ...stamp(staff) });
  return clean;
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
  welcome: "Hi {First name},\n\nThank you for coming in to see us. Here is the treatment plan we talked about, in the order we suggest.",
  closing: "If you have any questions about your plan, or you'd like to book your next treatment, give us a call or reply to this email.",
  disclaimer: "Prices are a guide only and may change. Your clinician will confirm the details at each visit.",
  showPrices: true,
  showConcerns: true,    // the "What we're working on" list
  showTimeline: true,    // "Your next 12 months"
  emailSubject: "Your treatment plan - Dermedica",
  emailMessage: "Hi {First name},\n\nYour treatment plan is attached. If you have any questions, or you'd like to book, reply to this email or give us a call.\n\nKind regards,\nDermedica",
};

export const DOC_FONTS = {
  arial: ["Arial", "Arial,Helvetica,sans-serif"],
  verdana: ["Verdana", "Verdana,Geneva,sans-serif"],
  trebuchet: ["Trebuchet", "'Trebuchet MS',Arial,sans-serif"],
  georgia: ["Georgia (serif)", "Georgia,'Times New Roman',serif"],
};
const DOC_BLOCKS = ["title", "text", "message", "concerns", "treatments", "timeline", "divider", "space", "sign"];
const DOC_MANY = ["text", "divider", "space", "sign"];   // these can be added any number of times
const docBlockId = () => Math.random().toString(36).slice(2, 10);

// The copy's blocks, top to bottom. "text" can be added any number of times; the others once each.
// Nothing saved yet: built from the older title / welcome / closing / small print boxes.
function cleanDocBlocks(list, old) {
  const seen = new Set();
  const out = (Array.isArray(list) ? list : []).map((b) => ({
    id: /^[a-z0-9]{4,16}$/.test(String((b && b.id) || "")) ? b.id : docBlockId(),
    type: DOC_BLOCKS.includes(b && b.type) ? b.type : "",
    text: typeof (b && b.text) === "string" ? b.text.slice(0, 2000) : "",
    html: typeof (b && b.html) === "string" ? b.html.slice(0, 20000) : "",   // rich text (cleaned when it's shown)
    size: ["s", "m", "l", "xl"].includes(b && b.size) ? b.size : "m",
    bold: !!(b && b.bold === true),
    tint: !!(b && b.tint === true),                       // in the design colour
    align: b && b.align === "center" ? "center" : "left",
  })).filter((b) => b.type && (DOC_MANY.includes(b.type) || (!seen.has(b.type) && seen.add(b.type)))).slice(0, 40);
  if (out.length) return out;
  const mk = (type, extra = {}) => ({ id: docBlockId(), type, text: "", size: "m", bold: false, tint: false, align: "left", ...extra });
  return [
    mk("title", { text: old.title }), mk("text", { text: old.welcome }), mk("message"),
    ...(old.showConcerns ? [mk("concerns")] : []), mk("treatments"), ...(old.showTimeline ? [mk("timeline")] : []),
    mk("text", { text: old.closing }), mk("text", { text: old.disclaimer, size: "s" }),
  ].filter((b) => b.type !== "text" || b.text.trim());
}

function cleanDocSettings(x = {}) {
  const d = PLAN_DOC_DEFAULTS;
  const text = (v, n, fb) => (typeof v === "string" ? String(v).slice(0, n) : fb);
  const old = {
    title: clip(x.title, 80) || d.title,
    colour: HEX.test(x.colour || "") ? x.colour : d.colour,
    welcome: text(x.welcome, 2000, d.welcome),
    closing: text(x.closing, 2000, d.closing),
    disclaimer: text(x.disclaimer, 1000, d.disclaimer),
    showPrices: x.showPrices === undefined ? d.showPrices : x.showPrices === true,
    showConcerns: x.showConcerns === undefined ? d.showConcerns : x.showConcerns === true,
    showTimeline: x.showTimeline === undefined ? d.showTimeline : x.showTimeline === true,
    emailSubject: clip(x.emailSubject, 200) || d.emailSubject,
    emailMessage: text(x.emailMessage, 3000, d.emailMessage),
  };
  return {
    ...old,
    formId: /^[A-Za-z0-9_-]{1,40}$/.test(String(x.formId || "")) ? x.formId : "",   // a Form Builder form used as the design ("" = standard)
    font: DOC_FONTS[x.font] ? x.font : "arial",
    fontSize: intIn(x.fontSize === undefined ? 13 : x.fontSize, 11, 16),
    blocks: cleanDocBlocks(x.blocks, old),
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

/* ---------- Treatment plan workflow (plan_settings/workflow) ---------- */

export const PLAN_WORKFLOW_DEFAULTS = {
  phases: [
    { id: "p1", name: "Priority 1 · Now", note: "What we're starting with", colour: "#0F766E", tracked: true },
    { id: "p2", name: "Priority 2 · Next", note: "When you're ready, once the first stage is under way", colour: "#378ADD", tracked: false },
    { id: "p3", name: "Priority 3 · Later", note: "For the future, when the timing and budget suit you", colour: "#888780", tracked: false },
  ],
  newPlanPhase: "p1",
  addPhase: "p2",
  promote: "suggest",
  promoteStart: "ask",
  remindFrom: "accepted",
  waitingKeepsOpen: true,
  docShowWaiting: true,
  docPhaseTotals: true,
  moved: {},
};
const PHASE_ID = /^[a-z0-9]{2,24}$/;

export function cleanWorkflow(x = {}) {
  const d = PLAN_WORKFLOW_DEFAULTS;
  const seen = new Set();
  let phases = (Array.isArray(x.phases) ? x.phases : []).map((p) => ({
    id: PHASE_ID.test(String((p && p.id) || "")) ? p.id : "",
    name: clip(p && p.name, 40),
    note: clip(p && p.note, 200),
    colour: HEX.test((p && p.colour) || "") ? p.colour : "#888780",
    tracked: !!(p && p.tracked === true),
  })).filter((p) => p.id && p.name && !seen.has(p.id) && seen.add(p.id)).slice(0, 5);
  if (!phases.length) phases = d.phases.map((p) => ({ ...p }));
  if (!phases.some((p) => p.tracked)) phases[0].tracked = true;
  const ids = phases.map((p) => p.id);
  const oneOf = (v, list, fb) => (list.includes(v) ? v : fb);
  const moved = {};
  Object.entries(x.moved && typeof x.moved === "object" ? x.moved : {}).forEach(([k, v]) => {
    if (PHASE_ID.test(k) && !ids.includes(k) && typeof v === "string" && PHASE_ID.test(v)) moved[k] = v;
  });
  return {
    phases,
    newPlanPhase: oneOf(x.newPlanPhase, ids, ids[0]),
    addPhase: oneOf(x.addPhase, ids, ids[1] || ids[0]),
    promote: oneOf(x.promote, ["suggest", "off"], d.promote),
    promoteStart: oneOf(x.promoteStart, ["ask", "this", "next"], d.promoteStart),
    remindFrom: oneOf(x.remindFrom, ["accepted", "proposed"], d.remindFrom),
    waitingKeepsOpen: x.waitingKeepsOpen === undefined ? d.waitingKeepsOpen : x.waitingKeepsOpen === true,
    docShowWaiting: x.docShowWaiting === undefined ? d.docShowWaiting : x.docShowWaiting === true,
    docPhaseTotals: x.docPhaseTotals === undefined ? d.docPhaseTotals : x.docPhaseTotals === true,
    moved,
  };
}

// The phase a concern sits in. No priority yet, or a removed phase: follows the workflow (first phase by default).
export function phaseOf(wf, id) {
  let k = id;
  for (let i = 0; i < 6 && k && !wf.phases.some((p) => p.id === k); i++) k = wf.moved[k];
  return wf.phases.find((p) => p.id === k) || wf.phases[0];
}

export async function getPlanWorkflow() {
  const s = await getDoc(doc(db, "plan_settings", "workflow"));
  return cleanWorkflow(s.exists() ? s.data() : {});
}

export async function savePlanWorkflow(x, staff) {
  await setDoc(doc(db, "plan_settings", "workflow"), { ...cleanWorkflow(x), ...stamp(staff) });
}