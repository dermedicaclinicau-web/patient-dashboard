// System configuration → Email flows: automatic emails to patients and staff, built from cards.
// A flow starts with a trigger (a purchase, a visit, or a daily check) and runs its cards top to bottom.
// Apps Script (runEmailFlows_) sends them. While a flow is testing, every email goes to the person who turned it on.

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, serverTimestamp, query, where, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { searchPatients } from "./task-runner.js";
import {
  blankGroup, cleanGroup, groupProblem, describeGroup, ruleCount, loadProductNames, loadServiceNames,
  mountRuleBuilder, mountProductPicker,
} from "./flow-rules.js";

import { createRichEditor } from "./rich-editor.js";
import { hydrateRichImages } from "./rich-html.js";
import { openImagePicker } from "./image-bank.js";
import { getLetterhead } from "./form-templates.js";
import {
  fillTemplate, fillTemplateHtml, emailShell, clinicDetails, subjectHtml, EMAIL_BACKGROUNDS, EMAIL_ACCENTS,
} from "./task-tokens.js";
import { fetchStaffList } from "./task-types.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { settingsHeaderHtml } from "./settings.js";
import { fillDateTokens, dateInsertHtml, dateInsertName } from "./date-tokens.js";

const COL = "email_flows";
const BASE = "#/settings/flows";
const MAX_STEPS = 40;
const MAX_DEPTH = 3; // If / else inside If / else, at most 3 deep

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  mail: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
  branch: ic('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10"/><path d="M18 11c0 4-6 3-12 6"/>'),
  bell: ic('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  stop: ic('<circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>'),
  cart: ic('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M3 4h2l2.5 11h11L21 7H7"/>'),
  cal: ic('<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>'),
  sun: ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  flow: ic('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M8 5h6a4 4 0 0 1 0 8H10a4 4 0 0 0 0 8h6"/>'),
  plus: ic('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  trash: ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  copy: ic('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  up: ic('<polyline points="18 15 12 9 6 15"/>'),
  down: ic('<polyline points="6 9 12 15 18 9"/>'),
  chev: ic('<polyline points="9 18 15 12 9 6"/>'),
};

const TYPES = {
  email: { label: "Send email to patient", short: "Send email", icon: "mail", tone: "is-patient" },
  wait: { label: "Wait", short: "Wait", icon: "clock", tone: "" },
  branch: { label: "If / else", short: "If / else", icon: "branch", tone: "is-branch" },
  staff: { label: "Notify staff", short: "Notify staff", icon: "bell", tone: "is-staff" },
  stop: { label: "End flow", short: "End flow", icon: "stop", tone: "" },
};
const ADDABLE = ["email", "wait", "branch", "staff", "stop"];
const TRIGGERS = [
  ["purchase", "A product is purchased", false],
  ["visit", "A patient has been in for a visit", false],
  ["daily", "A daily check finds patients who match", false],
  ["ssp_created", "A Skin Script is created", true],
];
const TRIG_ICON = { purchase: "cart", visit: "cal", daily: "sun" };
const SCOPES = [["any", "Any product"], ["catalogue", "Only Skin Script catalogue products"], ["list", "Only these products"]];
const VISIT_SCOPES = [["any", "Any visit"], ["some", "Only visits for these services"]];
const REPEATS = [[0, "Once only"], [30, "Again after 30 days"], [60, "Again after 60 days"], [90, "Again after 90 days"],
  [180, "Again after 180 days"], [365, "Again after a year"]];
const DAILY_MAX = [[10, "10"], [25, "25"], [50, "50"], [100, "100"], [200, "200"]];
const CONDS = [
  ["in_ssp", "The product is in their Skin Script"],
  ["has_ssp", "They have an active Skin Script"],
  ["marketing", "They agreed to marketing emails"],
  ["first_buy", "It's the first time they've bought this product"],
  ["booked", "They have an upcoming appointment"],
  ["rules", "Build my own rules…"],
];
const UNITS = [["days", "days", 365], ["weeks", "weeks", 52], ["months", "months", 12]];
const STAFF_TO = [
  ["ssp_creator", "The clinician who made their Skin Script"],
  ["sold_by", "Whoever sold the product"],
  ["roles", "Everyone in a role"],
  ["staff", "Chosen staff"],
];
const STAFF_SHORT = { ssp_creator: "SSP clinician", sold_by: "Who sold it", roles: "A role", staff: "Chosen staff" };
// Blanks for messages, filled in for each patient when the email is sent
const PATIENT_TOKENS = [
  { title: "Patient", tokens: ["First name", "Full name"] },
  { title: "This purchase", tokens: ["Product name", "Purchase date", "How to use"] },
  { title: "This visit", tokens: ["Visit date", "Visit services"] },
  { title: "Their Skin Script", tokens: ["Skin Script table", "SSP date", "SSP expiry date", "SSP step", "AM instructions", "PM instructions", "When to use", "SSP clinician"], smart: true },
  { title: "Clinic", tokens: ["Clinic phone", "Clinic email", "Clinic address"] },
];
const STAFF_TOKENS = [
  { title: "Patient", tokens: ["Patient name", "Patient mobile", "Patient email"] },
  { title: "This purchase", tokens: ["Product name", "Purchase date", "Sold by"] },
  { title: "This visit", tokens: ["Visit date", "Visit services", "Visit staff"] },
  { title: "Their Skin Script", tokens: ["SSP clinician", "SSP date"], smart: true },
];
const SAMPLE = {
  "first name": "Jane", "full name": "Jane Citizen", "patient name": "Jane Citizen",
  "patient mobile": "0412 345 678", "patient email": "jane@example.com",
  "product name": "Hydrating Serum", "purchase date": "16 October 2026", "sold by": "Reception",
  "visit date": "15 October 2026", "visit services": "DermaGlow Peel", "visit staff": "Dr Teh",
  "how to use": "Apply 2 pumps to clean skin, morning and night.",
  "ssp step": "Step B", "am instructions": "Apply 2 pumps after cleansing.",
  "pm instructions": "Apply 2 pumps before your moisturiser.", "when to use": "Every day",
  "ssp clinician": "Dr Teh", "ssp date": "2 September 2026", "ssp expiry date": "2 September 2027",
};
// "Start from a basic layout" for HTML code
const STARTER_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;color:#1e293b">
  <tr><td style="padding:24px 0 8px;font-size:22px;font-weight:700">Happy birthday, {First name}!</td></tr>
  <tr><td style="padding:8px 0;font-size:15px;line-height:1.6">
    As a thank you for being part of the Dermedica family, here's a little gift from us.</td></tr>
  <tr><td style="padding:16px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:2px dashed #5fae96;border-radius:12px">
      <tr><td align="center" style="padding:20px">
        <div style="font-size:28px;font-weight:700;color:#5fae96">15% OFF</div>
        <div style="font-size:14px;color:#475569;margin-top:4px">any treatment · valid until {Today + 30 days}</div>
      </td></tr></table></td></tr>
  <tr><td align="center" style="padding:8px 0 24px">
    <a href="tel:{Clinic phone}" style="display:inline-block;padding:12px 28px;background:#5fae96;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700">Call to book</a>
  </td></tr>
  <tr><td style="font-size:14px;line-height:1.6">Kind regards,<br>The Dermedica team</td></tr>
</table>`;
const UNSUB = '<p style="margin:18px 0 0;font-size:12px;color:#64748b">You\'re getting this because you agreed to emails from Dermedica. <a href="#">Unsubscribe</a></p>';

// {Skin Script table}: an example for the preview. The real one is built for each patient when the email is sent (Code.gs).
const SSP_SUB = { "Step A": "Preparing your skin", "Step B": "Prevent & Correct", "Step C": "Hydrating", "Step E": "Sunscreen" };
function sampleSspTable(accent) {
  const acc = /^#[0-9a-f]{3,8}$/i.test(String(accent || "")) ? accent : "#5fae96";
  const groups = [
    ["Step A", [["Dermedica Essential Cleanser", "AM & PM", true]]],
    ["Boost", [["ZO Complexion Renewal Pads", "PM", true]]],
    ["Step B", [["ZO Illuminating AOX Serum", "AM", true], ["ZO Wrinkle and Texture Serum", "PM", true]]],
    ["Step C", [["Dermedica Pro B Plus", "AM & PM", false]]],
    ["Step E", [["Dermedica Sunscreen", "AM", false]]],
  ];
  const cell = "padding:14px 16px;border-top:1px solid #e5e7eb;vertical-align:top;";
  const rows = groups.map(([step, items]) => items.map(([name, proto, link], j) => `<tr>
    ${j === 0 ? `<td rowspan="${items.length}" style="${cell}width:30%"><strong style="font-size:14px;color:#0f172a">${step}</strong>
      ${SSP_SUB[step] ? `<div style="margin-top:3px;font-size:12px;color:#64748b">${SSP_SUB[step]}</div>` : ""}</td>` : ""}
    <td style="${cell}"><span style="color:${acc}">&#8226;</span>&nbsp;&nbsp;${link
      ? `<a href="#" style="color:#1e293b;text-decoration:underline">${name}</a>` : name}</td>
    <td style="${cell}white-space:nowrap;width:22%">${proto}</td></tr>`).join("")).join("");
  return `<div style="margin:18px 0;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1e293b">
    <tr style="background:${acc}"><th align="left" style="padding:12px 16px;color:#fff;font-size:13px;font-weight:700">Step</th>
      <th align="left" style="padding:12px 16px;color:#fff;font-size:13px;font-weight:700">Product Name</th>
      <th align="left" style="padding:12px 16px;color:#fff;font-size:13px;font-weight:700">Protocol</th></tr>${rows}</table></div>`;
}
// A blank on its own line: the whole paragraph becomes the table
function insertSspTable(html, table) {
  const wrap = "(?:\\s|&nbsp;|<br\\s*\\/?>|<\\/?(?:span|strong|b|em|i|mark|u)\\b[^>]*>)*";
  const block = new RegExp(`<p\\b[^>]*>${wrap}\\{\\s*skin script table\\s*\\}${wrap}<\\/p>`, "gi");
  return String(html || "").replace(block, () => table).replace(/\{\s*skin script table\s*\}/gi, () => table);
}

/* ===================== Cards ===================== */

const newId = () => "s_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

function blank(type) {
  const cfg = type === "email" ? { subject: "", body: "", promo: false, mode: "rich", code: "", bare: false }
    : type === "wait" ? { num: 1, unit: "weeks" }
    : type === "branch" ? { cond: "in_ssp", rules: blankGroup(), yes: [], no: [] }
    : type === "staff" ? { to: "ssp_creator", roles: [], staffIds: [], subject: "", message: "" }
    : {};
  return { id: newId(), type, cfg };
}

function cleanSteps(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && TYPES[s.type]).map((s) => {
    const b = blank(s.type);
    const cfg = { ...b.cfg, ...(s.cfg || {}) };
    if (s.type === "branch") { cfg.yes = cleanSteps(cfg.yes); cfg.no = cleanSteps(cfg.no); cfg.rules = cleanGroup(cfg.rules); }
    if (s.type === "staff") {
      cfg.roles = Array.isArray(cfg.roles) ? cfg.roles.map(String) : [];
      cfg.staffIds = Array.isArray(cfg.staffIds) ? cfg.staffIds.map(String) : [];
    }
    return { id: String(s.id || b.id), type: s.type, cfg };
  });
}

// Where a card is: { list, i, depth }
function find(list, id, depth = 1) {
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.id === id) return { list, i, depth };
    if (s.type === "branch") {
      const r = find(s.cfg.yes, id, depth + 1) || find(s.cfg.no, id, depth + 1);
      if (r) return r;
    }
  }
  return null;
}
function walk(list, fn, depth = 1) {
  list.forEach((s) => {
    fn(s, depth);
    if (s.type === "branch") { walk(s.cfg.yes, fn, depth + 1); walk(s.cfg.no, fn, depth + 1); }
  });
}
function count(list) { let n = 0; walk(list || [], () => n++); return n; }

const plainText = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();
const label = (pairs, v) => (pairs.find((p) => String(p[0]) === String(v)) || [])[1] || "";
const unitWord = (num, unit) => (Number(num) === 1 ? unit.replace(/s$/, "") : unit);
const triggerLabel = (t) => label(TRIGGERS, (t && t.event) || "purchase") || "A product is purchased";

function summary(s) {
  const c = s.cfg;
  if (s.type === "email") return c.subject.trim() || "No subject yet";
  if (s.type === "wait") return `${Number(c.num) || 0} ${unitWord(c.num, c.unit)}`;
  if (s.type === "branch") return c.cond === "rules" ? describeGroup(c.rules) : label(CONDS, c.cond);
  if (s.type === "staff") {
    const to = c.to === "roles" && c.roles.length ? c.roles.join(", ") : STAFF_SHORT[c.to] || "Staff";
    return c.subject.trim() ? `To ${to} · ${c.subject.trim()}` : `To ${to}`;
  }
  return "No more cards on this path";
}

function stepProblems(s, depth) {
  const c = s.cfg;
  const out = [];
  if (s.type === "email") {
    if (!c.subject.trim()) out.push("Add a subject");
    if (c.mode === "html" ? !String(c.code || "").trim() : !plainText(c.body)) out.push("Write the message");
  } else if (s.type === "wait") {
    const max = (UNITS.find((u) => u[0] === c.unit) || UNITS[0])[2];
    const n = Number(c.num);
    if (!Number.isInteger(n) || n < 1 || n > max) out.push(`Choose 1 to ${max} ${c.unit}`);
  } else if (s.type === "staff") {
    if (c.to === "roles" && !c.roles.length) out.push("Choose at least one role");
    if (c.to === "staff" && !c.staffIds.length) out.push("Choose at least one staff member");
    if (!c.subject.trim()) out.push("Add a subject");
    if (!c.message.trim()) out.push("Write the message");
  } else if (s.type === "branch") {
    if (depth > MAX_DEPTH) out.push(`If / else can only go ${MAX_DEPTH} deep`);
    if (c.cond === "rules") { const p = groupProblem(c.rules, true); if (p) out.push(p); }
  }
  return out;
}

function flowProblems(flow) {
  const out = [];
  const t = flow.trigger;
  if (!flow.name.trim()) out.push("Give the flow a name.");
  if (t.event === "purchase" && t.scope === "list" && !t.products.length) out.push("Choose at least one product for the trigger, or pick Any product.");
  if (t.event === "visit" && t.serviceScope === "some" && !t.services.length) out.push("Choose at least one service for the trigger, or pick Any visit.");
  const tp = groupProblem(t.rules, t.event === "daily");
  if (tp) out.push(t.event === "daily" ? `Daily check: ${tp}.` : `Start rules: ${tp}.`);
  const sp = groupProblem(flow.stop.rules, false);
  if (sp) out.push(`Stop rules: ${sp}.`);
  if (!flow.steps.length) out.push("Add at least one card under the trigger.");
  if (count(flow.steps) > MAX_STEPS) out.push(`A flow can have up to ${MAX_STEPS} cards.`);
  let n = 0;
  walk(flow.steps, (s, depth) => {
    n++;
    const p = stepProblems(s, depth);
    if (p.length) out.push(`Card ${n} (${TYPES[s.type].short}): ${p[0]}.`);
  });
  return out;
}

/* ===================== Saving ===================== */

const cleanNames = (list) => (Array.isArray(list) ? list : []).map(String).filter(Boolean).slice(0, 40);
function snapshot(d = {}) {
  const t = d.trigger || {}, st = d.stop || {};
  return {
    name: String(d.name || ""),
    description: String(d.description || ""),
    trigger: {
      event: "purchase", scope: "any", serviceScope: "any", repeatDays: 0, dailyMax: 25, existing: false, ...t,
      products: cleanNames(t.products), services: cleanNames(t.services), rules: cleanGroup(t.rules),
    },
    steps: cleanSteps(d.steps),
    stop: { rebuy: true, booking: false, gapDays: 3, ...st, rules: cleanGroup(st.rules) },
    style: { background: EMAIL_BACKGROUNDS[0], accent: EMAIL_ACCENTS[0], width: 600, logo: true, footer: true, ...(d.style || {}) },
  };
}
// Each patient email is finished here (design, logo and clinic details), so Apps Script only fills in the patient's blanks
function rendered(steps, style, lh) {
  const copy = JSON.parse(JSON.stringify(steps));
  if (!lh) return copy; // keeps what was saved before
  const c = clinicDetails(lh);
  const vals = new Map([["clinic phone", c.phone || ""], ["clinic email", c.email || ""], ["clinic address", c.address || ""]]);
  walk(copy, (s) => {
    if (s.type === "email") {
      if (s.cfg.mode === "html") {
        const code = fillTemplateHtml(String(s.cfg.code || ""), vals);
        s.cfg.html = s.cfg.bare ? code : emailShell(code, style, { clinic: c, hasLogo: !!lh.logo });
      } else {
        s.cfg.html = emailShell(fillTemplateHtml(s.cfg.body || "", vals), style, { clinic: c, hasLogo: !!lh.logo });
      }
    }
  });
  return copy;
}
const toDoc = (f, lh) => JSON.parse(JSON.stringify({
  name: f.name.trim().slice(0, 120) || "Untitled flow",
  description: f.description.trim().slice(0, 300),
  trigger: f.trigger, steps: rendered(f.steps, f.style, lh), stop: f.stop, style: f.style,
}));
const by = (staff) => ({ updatedBy: String((staff && staff.name) || ""), updatedByUid: String((staff && staff.uid) || "") });

async function listFlows() {
  const snap = await getDocs(collection(db, COL));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((f) => f.status !== "archived")
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
async function getFlow(id) {
  const d = await getDoc(doc(db, COL, id));
  return d.exists() ? { id: d.id, ...d.data() } : null;
}
async function createFlow(data, staff) {
  const ref = await addDoc(collection(db, COL), {
    ...toDoc(snapshot(data)), status: "draft",
    createdAt: serverTimestamp(), createdBy: String((staff && staff.name) || ""), createdByUid: String((staff && staff.uid) || ""),
    updatedAt: serverTimestamp(), ...by(staff),
  });
  return ref.id;
}
async function saveFlow(id, flow, staff, status, lh, extra = {}) {
  const patch = { ...toDoc(flow, lh), ...extra, updatedAt: serverTimestamp(), ...by(staff) };
  if (status) patch.status = status;
  await updateDoc(doc(db, COL, id), patch);
}

function editedAgo(v) {
  const date = v && v.toDate ? v.toDate() : v instanceof Date ? v : null;
  if (!date) return "";
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "Edited just now";
  if (mins < 60) return `Edited ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Edited ${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return "Edited " + date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/* ===================== Starter flow ===================== */

function starterFlow() {
  const p = (...lines) => lines.map((l) => `<p>${l}</p>`).join("");
  const sign = "Kind regards,<br>The Dermedica team";
  const card = (type, cfg) => ({ id: newId(), type, cfg: { ...blank(type).cfg, ...cfg } });
  const email = (subject, body, promo = false) => card("email", { subject, body, promo });
  const wait = (num, unit) => card("wait", { num, unit });
  const branch = (cond, yes, no) => card("branch", { cond, yes, no });

  const inSsp = [
    email("How to use your {Product name}", p(
      "Hi {First name},",
      "Thank you for picking up your {Product name}. It's part of your Skin Script, so here's where it fits in your routine:",
      "<strong>{SSP step}</strong>",
      "Morning: {AM instructions}<br>Evening: {PM instructions}",
      "When to use it: {When to use}",
      "Any questions, just reply to this email or call us on {Clinic phone}.", sign)),
    wait(2, "weeks"),
    email("How are you finding your {Product name}?", p(
      "Hi {First name},",
      "It's been two weeks since you started your {Product name}. How is your skin feeling?",
      "If anything feels too strong, or you're not sure you're using it right, reply to this email and {SSP clinician} will help.", sign)),
    wait(6, "weeks"),
    email("Running low on {Product name}?", p(
      "Hi {First name},",
      "Your {Product name} is probably getting low. Staying consistent is what gets results, so you may like to pick up your next one.",
      "Reply to this email or call us on {Clinic phone} and we'll have it ready for you.", sign), true),
  ];
  const notInSsp = [
    card("staff", {
      to: "ssp_creator",
      subject: "{Patient name} bought a product outside their Skin Script",
      message: "{Patient name} bought {Product name} on {Purchase date}. It isn't in their Skin Script.\n\nPlease check it suits their routine and update their Skin Script if needed.",
    }),
    wait(1, "days"),
    email("About your {Product name}", p(
      "Hi {First name},",
      "Thank you for picking up your {Product name}. {SSP clinician} will check how it fits with your Skin Script and let you know if anything in your routine should change.",
      "Until then, here's how to use it: {How to use}", sign)),
  ];
  const noSsp = [
    email("How to use your {Product name}", p(
      "Hi {First name},",
      "Thank you for picking up your {Product name}. Here's how to use it: {How to use}",
      "Any questions, just reply to this email or call us on {Clinic phone}.", sign)),
    wait(2, "weeks"),
    email("How are you finding your {Product name}?", p(
      "Hi {First name},",
      "It's been two weeks since you started your {Product name}. How is your skin feeling? Reply any time if you have questions.", sign)),
    wait(4, "weeks"),
    email("A skincare routine made for your skin", p(
      "Hi {First name},",
      "Did you know we can build a Skin Script for you: a step-by-step routine with the right products for your skin, and how and when to use each one?",
      "Call us on {Clinic phone} or reply to this email to book a skin consultation.", sign), true),
  ];
  return {
    name: "Skin Script purchase follow-up",
    description: "Emails after a product purchase, depending on whether it's part of the patient's Skin Script.",
    trigger: { event: "purchase", scope: "any" },
    steps: [branch("has_ssp", [branch("in_ssp", inSsp, notInSsp)], noSsp)],
  };
}

/* ===================== Entry ===================== */

export async function mountEmailFlows(container, { param = "", staff } = {}) {
  const id = String(param).split("/")[1] || "";
  return id ? mountFlowEditor(container, { id, staff }) : mountFlowList(container, { staff });
}

/* ===================== Flows list ===================== */

async function mountFlowList(container, { staff }) {
  const admin = /^admin$/i.test(String((staff && staff.role) || ""));
  const root = document.createElement("section");
  root.className = "page wide ef-page";
  root.innerHTML = `
    ${admin ? settingsHeaderHtml("flows") : ""}
    <div class="tb-head">
      <div>
        <h3 class="tm-h">Email flows</h3>
        <p class="muted tm-sub">Automatic emails to patients and staff when something happens: a purchase, a visit, or a daily check
          that finds patients who match your rules. Each flow is a set of cards that run from top to bottom.</p>
      </div>
      <div class="ff-bar-actions">
        <button type="button" class="ff-btn" data-act="starter">Add Skin Script starter</button>
        <button type="button" class="ff-btn is-primary" data-act="new">${I.plus}<span>New flow</span></button>
      </div>
    </div>
    <div class="tm-tasks" data-role="list"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>`;
  container.replaceChildren(root);
  const list = root.querySelector('[data-role="list"]');

  async function load() {
    let flows;
    try { flows = await listFlows(); }
    catch (err) {
      console.error("Email flows load failed:", err);
      if (list.isConnected) list.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
        ? "Email flows are blocked. Check the email_flows Firestore rules have been published, then log out and in again."
        : "Couldn't load email flows. Check your connection and try again."}</div>`;
      return;
    }
    if (!list.isConnected) return;
    if (!flows.length) {
      list.innerHTML = `<div class="tm-empty"><strong>No email flows yet.</strong><br>
        Start with the Skin Script follow-up (emails after a purchase, depending on the patient's Skin Script), or build your own.
        <div class="tm-empty-act">
          <button type="button" class="ff-btn is-primary" data-act="starter">Add Skin Script starter</button>
          <button type="button" class="ff-btn" data-act="new">New flow</button>
        </div></div>`;
      return;
    }
    list.innerHTML = flows.map((f) => {
      const n = count(f.steps);
      const live = f.status === "live";
      const testing = live && f.sendMode !== "real";
      const ev = (f.trigger && f.trigger.event) || "purchase";
      return `<a class="tm-task" href="${BASE}/${encodeURIComponent(f.id)}">
        <span class="tm-task-icon">${I[TRIG_ICON[ev] || "flow"]}</span>
        <span class="tm-task-main"><strong>${esc(f.name)}</strong>
          <small>${esc([triggerLabel(f.trigger), `${n} card${n === 1 ? "" : "s"}`, editedAgo(f.updatedAt)].filter(Boolean).join(" · "))}</small></span>
        <span class="tb-pill ${live && !testing ? "is-live" : "is-draft"}">${live ? (testing ? "Live · testing" : "Live") : "Draft"}</span>
        <span class="tm-task-go">${I.chev}</span>
      </a>`;
    }).join("");
  }

  root.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="new"]')) { newFlowDialog(staff); return; }
    const s = e.target.closest('[data-act="starter"]');
    if (!s) return;
    s.disabled = true;
    try {
      const id = await createFlow(starterFlow(), staff);
      showToast("Starter flow added as a draft. Check the wording, then turn it on.");
      location.hash = `${BASE}/${encodeURIComponent(id)}`;
    } catch (err) {
      console.error("Starter flow failed:", err);
      showToast(err.code === "permission-denied" ? "You don't have Build email flows access." : "Couldn't add the starter flow. Try again.");
      if (s.isConnected) s.disabled = false;
    }
  });

  load();
}

function newFlowDialog(staff) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog fe-confirm";
  dlg.innerHTML = `
    <form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>New email flow</h3><p>You can change the name later.</p></div>
      <label class="lh-field"><span class="lh-label">Name</span>
        <input type="text" name="name" maxlength="120" placeholder="e.g. After a peel" /></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Create flow</button>
      </div>
    </form>`;
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) { err.textContent = "Give the flow a name."; err.hidden = false; return; }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const id = await createFlow({ name }, staff);
      dlg.close();
      location.hash = `${BASE}/${encodeURIComponent(id)}`;
    } catch (ex) {
      console.error("Create flow failed:", ex);
      err.textContent = ex.code === "permission-denied" ? "You don't have Build email flows access." : "Couldn't create the flow. Try again.";
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = "Create flow";
    }
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  form.elements.name.focus();
}

/* ===================== Flow builder ===================== */

async function mountFlowEditor(container, { id, staff }) {
  const back = `<a class="back-link" href="${BASE}">← Email flows</a>`;
  const root = document.createElement("section");
  root.className = "page wide ef-page";
  root.innerHTML = back + '<div class="skeleton" style="height:420px;border-radius:14px"></div>';
  container.replaceChildren(root);

  let loaded;
  try { loaded = await getFlow(id); }
  catch (err) {
    console.error("Flow load failed:", err);
    if (root.isConnected) root.innerHTML = back + '<div class="state error"><strong>Couldn\'t open this flow</strong>Check your connection and try again.</div>';
    return;
  }
  if (!root.isConnected) return;
  if (!loaded || loaded.status === "archived") {
    root.innerHTML = back + '<div class="state"><strong>This flow has been deleted</strong>Go back to Email flows to choose another.</div>';
    return;
  }

  const flow = snapshot(loaded);
  let status = loaded.status;
  let sel = null;          // a card id, "trigger", or null (flow settings)
  let menuAt = null;       // which + menu is open
  let letterhead = null, staffList = null, staffError = false;
  let mode = loaded.sendMode === "real" ? "real" : "test"; // testing: every email goes to the person who turned it on
  let runs = null, runsErr = "", runsLoading = false;
  let productNames = [], serviceNames = [];
  let matchData = null;    // the last "See who's next" answer
  let buyData = null, buyDays = 14;   // the last "See recent purchases" answer
  let holds = null, holdsErr = false, holdsLoading = false;
  const lhReady = getLetterhead().then((lh) => { letterhead = lh || {}; }).catch(() => { letterhead = {}; });
  let editor = null, lastText = null;
  let dirty = false, saving = false, saveTimer = null;

  root.innerHTML = `
    <div class="ff-wrap tb-wrap ef-wrap">
      <div class="ff-bar" role="region" aria-label="Flow actions">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${BASE}" aria-label="Back to Email flows" title="Back to Email flows">${I.back}</a>
          <div class="ff-bar-title">
            <strong data-role="title"></strong>
            <span><span data-role="sub"></span> · <span data-role="state">All changes saved</span></span>
          </div>
          <span class="tb-pill" data-role="pill"></span>
          <div class="ff-bar-actions">
            <button type="button" class="ff-btn is-quiet" data-act="delete">${I.trash}<span>Delete</span></button>
            <button type="button" class="ff-btn" data-act="duplicate">${I.copy}<span>Duplicate</span></button>
            <button type="button" class="ff-btn" data-act="test">${I.mail}<span>Test with a patient</span></button>
            <button type="button" class="ff-btn" data-act="mode" hidden><span>Send to patients</span></button>
            <button type="button" class="ff-btn is-primary" data-act="live"><span>Turn on</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      <div class="ef-grid">
        <div class="ef-stage">
          <div class="ef-pal" role="group" aria-label="Add a card">
            <span>Add after the selected card</span>
            ${ADDABLE.map((t) => `<button type="button" class="ef-pal-btn" data-pal="${t}">${I[TYPES[t].icon]}<span>${esc(TYPES[t].short)}</span></button>`).join("")}
          </div>
          <div class="ef-vp" data-role="canvas" aria-label="Flow canvas">
            <div class="ef-world" data-role="world"></div>
            <div class="ef-zoom" role="group" aria-label="Zoom">
              <button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
              <button type="button" data-zoom="100" data-role="zoom" title="Back to 100%">100%</button>
              <button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
              <button type="button" data-zoom="fit" title="Fit the whole flow">Fit</button>
            </div>
            <p class="ef-hint">Drag the background to move around · Ctrl + scroll or pinch to zoom</p>
          </div>
        </div>
        <aside class="ef-side" data-role="side" aria-label="Card settings"></aside>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const canvas = $('[data-role="canvas"]');
  const side = $('[data-role="side"]');
  const stateEl = $('[data-role="state"]');
  const msgEl = $('[data-role="msg"]');
  const liveBtn = $('[data-act="live"]');

  /* ---------- Saving ---------- */
  function setState(s) {
    stateEl.textContent = s === "saving" ? "Saving…" : s === "dirty" ? "Unsaved changes" : s === "error" ? "Couldn't save. Retrying…" : "All changes saved";
  }
  function changed() {
    dirty = true;
    setState("dirty");
    msgEl.textContent = "";
    renderBar();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 800);
  }
  const ruleChange = () => { changed(); renderCanvas(); };
  async function flush() {
    clearTimeout(saveTimer);
    if (!dirty || saving) return;
    saving = true;
    dirty = false;
    setState("saving");
    let failed = false;
    try {
      await lhReady;
      await saveFlow(id, flow, staff, null, letterhead);
      setState(dirty ? "dirty" : "saved");
    } catch (err) {
      console.error("Flow save failed:", err);
      failed = true;
      dirty = true;
      setState("error");
    } finally {
      saving = false;
      if (dirty) saveTimer = setTimeout(flush, failed ? 4000 : 400);
    }
  }
  async function settle() {
    if (dirty) await flush();
    while (saving) await new Promise((r) => setTimeout(r, 100));
  }
  const onBeforeUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ""; } };
  const onHashChange = () => {
    if (root.isConnected) return;
    flush();
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("hashchange", onHashChange);

  /* ---------- Top bar ---------- */
  function renderBar() {
    const live = status === "live";
    const n = count(flow.steps);
    $('[data-role="title"]').textContent = flow.name.trim() || "Untitled flow";
    $('[data-role="sub"]').textContent = `${triggerLabel(flow.trigger)} · ${n} card${n === 1 ? "" : "s"}`;
    const pill = $('[data-role="pill"]');
    pill.className = "tb-pill " + (live && mode === "real" ? "is-live" : "is-draft");
    pill.textContent = live ? (mode === "real" ? "Live" : "Live · testing") : "Draft";
    liveBtn.querySelector("span").textContent = live ? "Turn off" : "Turn on";
    liveBtn.classList.toggle("is-primary", !live);
    const modeBtn = $('[data-act="mode"]');
    modeBtn.hidden = !live;
    modeBtn.querySelector("span").textContent = mode === "real" ? "Back to testing" : "Send to patients";
    modeBtn.classList.toggle("is-primary", live && mode !== "real");
  }

  /* ---------- The canvas: a tree of cards you can drag around and zoom ---------- */
  const CW = 260, CH = 88;          // every card is this size
  const GAP = 64;                   // space between cards (the + sits in the middle)
  const HG = 48;                    // space between the Yes and No paths
  const SPLIT = 24, LBL = 64, PAD = 60;
  const world = $('[data-role="world"]');
  const zoomLbl = $('[data-role="zoom"]');
  const view = { x: 0, y: 0, z: 1, ready: false };
  let pos = new Map();              // card id → its place in the last layout

  // How wide a path needs to be (an If / else needs room for both of its paths)
  function measure(list) {
    let w = CW;
    for (const s of list) if (s.type === "branch") w = Math.max(w, measure(s.cfg.yes) + HG + measure(s.cfg.no));
    return w;
  }

  function layout() {
    const L = { cards: [], plus: [], labels: [], d: "" };
    const line = (d) => { L.d += d; };
    const opensEnd = (list) => !list.length || list[list.length - 1].type !== "stop";

    // Lays out one path, centred on cx, starting under yIn. Returns the bottom of the path.
    function place(items, cx, yIn, key, depth) {
      let prev = yIn;
      for (let i = 0; ; i++) {
        const s = items[i];
        const py = prev + GAP / 2;
        L.plus.push({ key, x: cx, y: py });
        if (!s) { line(`M${cx} ${prev}V${py}`); return py + 14; }
        const top = prev + GAP, bot = top + CH;
        line(`M${cx} ${prev}V${top}`);
        L.cards.push({ s, depth, x: cx - CW / 2, y: top });
        if (s.type === "stop") return bot;
        if (s.type !== "branch") { prev = bot; key = "after:" + s.id; continue; }

        const wy = measure(s.cfg.yes), wn = measure(s.cfg.no), total = wy + HG + wn;
        const lx = cx - total / 2 + wy / 2, rx = cx + total / 2 - wn / 2;
        const sy = bot + SPLIT, cy = bot + LBL;
        line(`M${cx} ${bot}V${sy}M${lx} ${sy}H${rx}M${lx} ${sy}V${cy}M${rx} ${sy}V${cy}`);
        L.labels.push({ yes: true, x: lx, y: (sy + cy) / 2 }, { yes: false, x: rx, y: (sy + cy) / 2 });
        const ey = place(s.cfg.yes, lx, cy, `start:${s.id}:yes`, depth + 1);
        const en = place(s.cfg.no, rx, cy, `start:${s.id}:no`, depth + 1);
        if (i === items.length - 1) return Math.max(ey, en);

        // Cards after an If / else: the two paths join again
        const my = Math.max(ey, en) + SPLIT;
        if (opensEnd(s.cfg.yes)) line(`M${lx} ${ey}V${my}`);
        if (opensEnd(s.cfg.no)) line(`M${rx} ${en}V${my}`);
        line(`M${lx} ${my}H${rx}`);
        prev = my;
        key = "after:" + s.id;
      }
    }

    const inner = measure(flow.steps);
    const cx = PAD + inner / 2;
    L.trigger = { x: cx - CW / 2, y: PAD };
    L.h = place(flow.steps, cx, PAD + CH, "start:root", 1) + PAD;
    L.w = inner + PAD * 2;
    return L;
  }

  function triggerText() {
    const t = flow.trigger;
    const r = ruleCount(t.rules);
    const rules = r ? ` · ${r} rule${r === 1 ? "" : "s"}` : "";
    if (t.event === "visit") {
      const n = t.services.length;
      return "A patient has been in" + (t.serviceScope === "some" ? ` (${n} service${n === 1 ? "" : "s"})` : "") + rules;
    }
    if (t.event === "daily") return "Daily check" + (r ? rules : " · no rules yet");
    const n = t.products.length;
    const what = t.scope === "catalogue" ? " (Skin Script catalogue)" : t.scope === "list" ? ` (${n} product${n === 1 ? "" : "s"})` : "";
    return triggerLabel(t) + what + rules;
  }

  function cardHtml(s, depth, x, y) {
    const t = TYPES[s.type];
    const probs = stepProblems(s, depth);
    const on = sel === s.id;
    const full = summary(s);
    return `<div class="ef-card is-t-${s.type}${on ? " is-sel" : ""}${probs.length ? " is-bad" : ""}"
      style="left:${x}px;top:${y}px;width:${CW}px;height:${CH}px"
      data-pick="${esc(s.id)}" tabindex="0" role="button" aria-pressed="${on}" title="${esc(full)}">
      <span class="ef-ico ${t.tone}">${I[t.icon]}</span>
      <span class="ef-card-main">
        <small>${esc(t.label)}${s.type === "email" && s.cfg.promo ? " · <em>Promotional</em>" : ""}</small>
        <strong>${esc(full)}</strong>
        ${probs.length ? `<em class="ef-card-warn">${esc(probs[0])}</em>` : ""}
      </span>
    </div>`;
  }

  function renderCanvas() {
    const L = layout();
    pos = new Map(L.cards.map((c) => [c.s.id, c]));
    const on = sel === "trigger";
    const menu = menuAt && L.plus.find((p) => p.key === menuAt);
    world.style.width = L.w + "px";
    world.style.height = L.h + "px";
    world.innerHTML = `
      <svg class="ef-lines" width="${L.w}" height="${L.h}" aria-hidden="true"><path d="${L.d}"/></svg>
      <div class="ef-card is-t-trigger${on ? " is-sel" : ""}" style="left:${L.trigger.x}px;top:${L.trigger.y}px;width:${CW}px;height:${CH}px"
        data-pick="trigger" tabindex="0" role="button" aria-pressed="${on}">
        <span class="ef-ico is-trigger">${I[TRIG_ICON[flow.trigger.event] || "cart"]}</span>
        <span class="ef-card-main"><small>When this happens</small>
          <strong>${esc(triggerText())}</strong></span>
      </div>
      ${L.cards.map((c) => cardHtml(c.s, c.depth, c.x, c.y)).join("")}
      ${L.labels.map((b) => `<span class="ef-bl${b.yes ? " is-yes" : ""}" style="left:${b.x}px;top:${b.y}px">${b.yes ? "Yes" : "No"}</span>`).join("")}
      ${L.plus.map((p) => `<button type="button" class="ef-plus${p.key === menuAt ? " is-open" : ""}" style="left:${p.x}px;top:${p.y}px"
        data-add="${esc(p.key)}" aria-label="Add a card here" aria-expanded="${p.key === menuAt}">${I.plus}</button>`).join("")}
      ${menu ? `<div class="ef-menu" style="left:${menu.x}px;top:${menu.y + 22}px">${ADDABLE.map((t) =>
        `<button type="button" data-ins="${esc(menu.key)}" data-type="${t}">${I[TYPES[t].icon]}<span>${esc(TYPES[t].short)}</span></button>`).join("")}</div>` : ""}`;
    if (!view.ready && canvas.clientWidth) { fit(true); view.ready = true; }
    applyView();
  }

  /* ---------- Moving and zooming ---------- */
  const clampZ = (z) => Math.min(1.6, Math.max(0.3, z));
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    const g = 20 * view.z;
    canvas.style.backgroundSize = `${g}px ${g}px`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
    zoomLbl.textContent = Math.round(view.z * 100) + "%";
  }
  function zoomAt(f, px, py) {
    const z = clampZ(view.z * f);
    view.x = px - (px - view.x) * (z / view.z);
    view.y = py - (py - view.y) * (z / view.z);
    view.z = z;
    applyView();
  }
  // Fit the flow: to the width only when the page opens, or the whole flow from the Fit button
  function fit(widthOnly) {
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const w = parseFloat(world.style.width) || 1, h = parseFloat(world.style.height) || 1;
    view.z = clampZ(Math.min(1, (vw - 24) / w, widthOnly ? 1 : (vh - 24) / h));
    view.x = (vw - w * view.z) / 2;
    view.y = widthOnly ? 0 : (vh - h * view.z) / 2;
    applyView();
  }
  // Brings a card into view if it's off the screen (after adding it)
  function reveal(cardId) {
    const c = pos.get(cardId);
    if (!c) return;
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const sx = view.x + c.x * view.z, sy = view.y + c.y * view.z;
    if (sx >= 0 && sy >= 0 && sx + CW * view.z <= vw && sy + CH * view.z <= vh) return;
    view.x = vw / 2 - (c.x + CW / 2) * view.z;
    view.y = vh / 2 - (c.y + CH / 2) * view.z;
    applyView();
  }

  const ptrs = new Map();
  let dragDist = 0;
  const spread = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || e.target.closest("[data-pick], [data-add], [data-ins], [data-zoom], .ef-menu")) return;
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) dragDist = 0;
    canvas.classList.add("is-panning");
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size === 2) {                                   // pinch to zoom
      const before = spread();
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...ptrs.values()];
      const r = canvas.getBoundingClientRect();
      zoomAt(spread() / before, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    } else {                                                 // drag to move
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      view.x += dx; view.y += dy;
      dragDist += Math.abs(dx) + Math.abs(dy);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      applyView();
    }
  });
  const endPtr = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) canvas.classList.remove("is-panning"); };
  canvas.addEventListener("pointerup", endPtr);
  canvas.addEventListener("pointercancel", endPtr);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {                            // Ctrl + scroll, and trackpad pinch
      const r = canvas.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    } else {
      view.x -= e.deltaX; view.y -= e.deltaY;
      applyView();
    }
  }, { passive: false });

  /* ---------- Adding cards ---------- */
  function insertAt(key, type) {
    if (count(flow.steps) >= MAX_STEPS) { showToast(`A flow can have up to ${MAX_STEPS} cards.`); return; }
    let list, idx, depth;
    if (key === "start:root") { list = flow.steps; idx = 0; depth = 1; }
    else if (key.startsWith("after:")) {
      const r = find(flow.steps, key.slice(6));
      if (!r) return;
      list = r.list; idx = r.i + 1; depth = r.depth;
    } else {
      const [, bid, sideKey] = key.split(":");
      const r = find(flow.steps, bid);
      if (!r) return;
      list = r.list[r.i].cfg[sideKey]; idx = 0; depth = r.depth + 1;
    }
    if (type === "branch" && depth > MAX_DEPTH) { showToast(`If / else can only go ${MAX_DEPTH} deep.`); return; }
    if (type === "stop" && idx < list.length) { showToast("End flow goes at the bottom of a path. Add it after the last card."); return; }
    const s = blank(type);
    list.splice(idx, 0, s);
    menuAt = null;
    sel = s.id;
    changed();
    renderCanvas();
    renderSide();
    reveal(s.id);
  }

  function palAdd(type) {
    if (!sel || sel === "trigger") {
      const last = flow.steps[flow.steps.length - 1];
      if (last && (last.type === "stop" || last.type === "branch")) {
        showToast(last.type === "branch" ? "Click a card inside Yes or No first, then add." : "The flow already ends here. Click a card first, then add.");
        return;
      }
      insertAt(last ? "after:" + last.id : "start:root", type);
      return;
    }
    const r = find(flow.steps, sel);
    if (!r) return;
    const cur = r.list[r.i];
    if (cur.type === "branch") { insertAt(`start:${cur.id}:yes`, type); return; }
    if (cur.type === "stop") { showToast("Nothing can go after End flow."); return; }
    insertAt("after:" + cur.id, type);
  }

  function pick(cardId) {
    sel = sel === cardId ? null : cardId;
    menuAt = null;
    renderCanvas();
    renderSide();
    if (sel && window.matchMedia("(max-width: 1100px)").matches) side.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  canvas.addEventListener("click", (e) => {
    const zb = e.target.closest("[data-zoom]");
    if (zb) {
      const k = zb.dataset.zoom, cw = canvas.clientWidth / 2, ch = canvas.clientHeight / 2;
      if (k === "fit") fit(false);
      else if (k === "100") zoomAt(1 / view.z, cw, ch);
      else zoomAt(k === "in" ? 1.2 : 1 / 1.2, cw, ch);
      return;
    }
    const ins = e.target.closest("[data-ins]");
    if (ins) { insertAt(ins.dataset.ins, ins.dataset.type); return; }
    const add = e.target.closest("[data-add]");
    if (add) { menuAt = menuAt === add.dataset.add ? null : add.dataset.add; renderCanvas(); return; }
    const card = e.target.closest("[data-pick]");
    if (card) { pick(card.dataset.pick); return; }
    // A click on the empty background (not the end of a drag) closes the + menu
    if (menuAt && dragDist < 4 && !e.target.closest(".ef-menu")) { menuAt = null; renderCanvas(); }
  });
  canvas.addEventListener("keydown", (e) => {
    const card = e.target.closest("[data-pick]");
    if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(card.dataset.pick); }
    if (e.key === "Escape" && menuAt) { menuAt = null; renderCanvas(); }
  });
  root.querySelector(".ef-pal").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pal]");
    if (b) palAdd(b.dataset.pal);
  });

  /* ---------- Settings panel ---------- */
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("");
  const chipsHtml = (groups) => `<div class="tb-chips">${groups.map((g) => `
    <div class="tb-chipgroup"><span>${esc(g.title)}</span>
      <div class="fe-chiprow">${g.tokens.map((t) => `<button type="button" class="fe-ins${g.smart ? " is-smart" : ""}" data-token="${esc(t)}">{${esc(t)}}</button>`).join("")}</div>
    </div>`).join("")}</div>`;
  const editorGroups = () => PATIENT_TOKENS.map((g) => ({ title: g.title, tokens: g.tokens.map((name) => ({ name, kind: g.smart ? "smart" : "", hint: "" })) }));

  function triggerHtml() {
    const t = flow.trigger;
    if (t.event === "visit") {
      return `
        <label class="tb-field"><span>Which visits</span>
          <select class="fb-select" data-f="trigger.serviceScope">${opt(VISIT_SCOPES, t.serviceScope)}</select></label>
        ${t.serviceScope === "some" ? `<div class="tb-field"><span>Services</span><div class="fr-pp" data-role="trig-services"></div>
          <small class="muted">A visit matches if any of its services contains one of these, so "Peel" matches "DermaGlow Peel".</small></div>` : ""}
        <div class="tb-field"><span>Only start for patients who… <small>(optional)</small></span><div data-role="trig-rules"></div></div>
        <p class="tb-info">Checked each morning after the appointment sync, for the day before. Cancelled and DNA appointments don't count.
          Each visit starts the flow once.</p>`;
    }
    if (t.event === "daily") {
      return `
        <p class="tb-info">Every morning, every patient is checked against these rules. Patients who match start the flow.</p>
        <div class="tb-field"><span>Patients who…</span><div data-role="trig-rules"></div></div>
        <label class="tb-field"><span>Each patient can start this flow</span>
          <select class="fb-select" data-f="trigger.repeatDays">${opt(REPEATS, t.repeatDays)}</select></label>
        <label class="tb-field"><span>Start at most this many patients a day</span>
          <select class="fb-select" data-f="trigger.dailyMax">${opt(DAILY_MAX, t.dailyMax)}</select>
          <small class="muted">Anyone over the limit starts the next day.</small></label>
        <label class="fe-check"><input type="checkbox" data-f="trigger.existing"${t.existing ? " checked" : ""} />
          Also start patients who already match when it's turned on</label>
        <small class="muted">Off: the first morning only notes who already matches. From then on, patients start as they newly match.</small>
        <div class="ef-match">
          <button type="button" class="lh-btn" data-act="preview-match">See who's next</button>
          <small class="muted">Everyone who matches today, and whether they'll start. Start or hold anyone before the next check.</small>
          <div data-role="match-out">${matchData ? matchHtml(matchData) : ""}</div>
        </div>`;
    }
    return `
      <label class="tb-field"><span>Which products</span>
        <select class="fb-select" data-f="trigger.scope">${opt(SCOPES, t.scope)}</select></label>
      ${t.scope === "list" ? `<div class="tb-field"><span>Products</span><div class="fr-pp" data-role="trig-products"></div>
        <small class="muted">Sizes count as the same product, so "Hydrating Serum" also matches "Hydrating Serum 30ml".</small></div>` : ""}
      <div class="tb-field"><span>Only start for patients who… <small>(optional)</small></span><div data-role="trig-rules"></div></div>
      <p class="tb-info">Purchases come from the invoice sync (the INVOICE RECORD sheet), checked each time it updates. Each purchase starts the flow once for that patient and product. Scanner billing sheets and sales will be added next.</p>
      <div class="ef-match">
        <label class="tb-field"><span>Purchases in the last</span>
          <select class="fb-select" data-role="pwin">${[7, 14, 30, 60, 90].map((d) =>
            `<option value="${d}"${d === buyDays ? " selected" : ""}>${d} days</option>`).join("")}</select></label>
        <button type="button" class="lh-btn" data-act="preview-buys">See recent purchases</button>
        <small class="muted">Everyone who bought a matching product, and whether the flow starts for them. Start anyone it missed.</small>
        <div data-role="buys-out">${buyData ? buyHtml(buyData) : ""}</div>
      </div>`;
  }

  function flowSettingsHtml() {
    const t = flow.trigger, st = flow.stop, s = flow.style;
    const sw = (key, list) => `<div class="tb-swatches">${list.map((c) => `
      <label class="tb-sw" title="${c}"><input type="radio" name="ef-${key}" data-style="${key}" value="${c}"${s[key] === c ? " checked" : ""} />
        <span style="background:${c}"></span></label>`).join("")}</div>`;
    const gaps = [[0, "No limit"], ...[1, 2, 3, 5, 7].map((d) => [d, `${d} day${d === 1 ? "" : "s"}`])];
    const again = t.event === "purchase" ? "They buy the same product again" : t.event === "visit" ? "They come in again" : "";
    return `
      <div class="ef-side-head"><span class="ef-ico is-trigger">${I[TRIG_ICON[t.event] || "cart"]}</span>
        <div><strong>Flow settings</strong><small>Click a card on the left to set it up</small></div></div>
      <section class="ef-sec" data-role="runs"></section>
      <section class="ef-sec" data-role="holds"></section>
      <section class="ef-sec"><h4>About this flow</h4>
        <label class="tb-field"><span>Name</span><input class="fe-input" data-f="name" maxlength="120" value="${esc(flow.name)}" /></label>
        <label class="tb-field"><span>Description <small>(optional)</small></span>
          <textarea class="fe-input" data-f="description" rows="2" maxlength="300">${esc(flow.description)}</textarea></label>
      </section>
      <section class="ef-sec"><h4>When this happens</h4>
        <div class="ef-radios">${TRIGGERS.map(([v, l, soon]) => `
          <label class="fe-check${soon ? " is-soon" : ""}"><input type="radio" name="ef-trig" data-f="trigger.event" value="${v}"${t.event === v ? " checked" : ""}${soon ? " disabled" : ""} />
            ${esc(l)}${soon ? ' <small class="muted">· coming soon</small>' : ""}</label>`).join("")}</div>
        ${triggerHtml()}
      </section>
      <section class="ef-sec"><h4>Stop rules <small>(checked before every email)</small></h4>
        <label class="fe-check"><input type="checkbox" checked disabled /> They unsubscribe <small class="muted">(always on)</small></label>
        <label class="fe-check"><input type="checkbox" checked disabled /> They have no email address <small class="muted">(always on)</small></label>
        ${again ? `<label class="fe-check"><input type="checkbox" data-f="stop.rebuy"${st.rebuy ? " checked" : ""} /> ${again} <small class="muted">(the flow starts over)</small></label>` : ""}
        <label class="fe-check"><input type="checkbox" data-f="stop.booking"${st.booking ? " checked" : ""} /> They book an appointment</label>
        <div class="tb-field"><span>Also stop when…</span><div data-role="stop-rules"></div></div>
        <label class="tb-field"><span>At most one automatic email to a patient every</span>
          <select class="fb-select" data-f="stop.gapDays">${opt(gaps, st.gapDays)}</select>
          <small class="muted">Across all flows. An email that comes due too soon waits until it's allowed.</small></label>
      </section>
      <section class="ef-sec"><h4>Email design</h4>
        <div class="tb-field"><span>Background</span>${sw("background", EMAIL_BACKGROUNDS)}</div>
        <div class="tb-field"><span>Accent <small>(headings, links and buttons)</small></span>${sw("accent", EMAIL_ACCENTS)}</div>
        <label class="fe-check"><input type="checkbox" data-style="logo"${s.logo ? " checked" : ""} /> Clinic logo at the top</label>
        <label class="fe-check"><input type="checkbox" data-style="footer"${s.footer ? " checked" : ""} /> Clinic details at the bottom</label>
      </section>`;
  }

  function mountSettingsRules() {
    const tp = side.querySelector('[data-role="trig-products"]');
    if (tp) mountProductPicker(tp, flow.trigger.products, { onChange: ruleChange, names: productNames });
    const ts = side.querySelector('[data-role="trig-services"]');
    if (ts) mountProductPicker(ts, flow.trigger.services, { onChange: ruleChange, names: serviceNames,
      placeholder: "Type a service or a word like Peel", none: "No services chosen yet" });
    const tr = side.querySelector('[data-role="trig-rules"]');
    if (tr) mountRuleBuilder(tr, flow.trigger.rules, { onChange: ruleChange, names: productNames,
      empty: flow.trigger.event === "daily" ? "Add at least one rule, e.g. Has a future appointment booked: No."
        : flow.trigger.event === "visit" ? "Anyone who comes in starts the flow." : "Anyone who makes a matching purchase starts the flow." });
    const sr = side.querySelector('[data-role="stop-rules"]');
    if (sr) mountRuleBuilder(sr, flow.stop.rules, { onChange: ruleChange, names: productNames, empty: "No extra stop rules." });
  }

  function stepBodyHtml(s) {
    const c = s.cfg;
    if (s.type === "email") {
      return `
        <section class="ef-sec">
          <label class="tb-field"><span>Subject</span>
            <input class="fe-input" data-k="subject" data-tokens maxlength="200" value="${esc(c.subject)}" /></label>
          <div class="tb-field"><span class="ef-msg-head">Message
              <span class="ef-mode" role="group" aria-label="How to write the message">
                <button type="button" data-mode="rich" class="${c.mode !== "html" ? "is-on" : ""}" aria-pressed="${c.mode !== "html"}">Editor</button>
                <button type="button" data-mode="html" class="${c.mode === "html" ? "is-on" : ""}" aria-pressed="${c.mode === "html"}">HTML code</button>
              </span></span>
            ${c.mode === "html" ? `
              <textarea class="fe-input ef-code" data-k="code" data-tokens rows="16" maxlength="100000" spellcheck="false"
                placeholder="&lt;table width=&quot;100%&quot; …&gt;">${esc(c.code)}</textarea>
              ${String(c.code || "").trim() ? "" : '<button type="button" class="lh-btn is-quiet" data-act="code-starter">Start from a basic layout</button>'}
              <label class="fe-check"><input type="checkbox" data-k="bare"${c.bare ? " checked" : ""} />
                Use my own full design <small class="muted">(no clinic logo, background or footer around it)</small></label>
              <small class="muted">Use inline styles (style="…") and tables for layout: that's what email apps show reliably.
                Scripts and forms are removed when it's sent.</small>`
            : '<div data-role="editor"></div>'}
          </div>
          ${chipsHtml(PATIENT_TOKENS)}
          ${dateInsertHtml()}
          <small class="muted">Tap a blank to add it where your cursor is. Blanks fill in with each patient's details when it's sent.
            Dates like {Today + 30 days} are worked out on the day it goes out.</small>
          <label class="fe-check"><input type="checkbox" data-k="promo" data-rerender${c.promo ? " checked" : ""} />
            This is promotional <small class="muted">(an offer, a reorder reminder or a booking invitation)</small></label>
          ${c.promo ? '<p class="tb-info">Promotional emails only go to patients who agreed to marketing emails, and always end with an unsubscribe link.</p>' : ""}
        </section>
        <section class="ef-sec"><h4>Preview <small>(with example details)</small></h4><div data-role="prev"></div></section>`;
    }
    if (s.type === "wait") {
      return `
        <section class="ef-sec">
          <div class="tb-field"><span>Wait for</span>
            <div class="fe-num ef-wait">
              <input class="fe-input" type="number" min="1" max="365" step="1" data-k="num" value="${esc(c.num)}" />
              <select class="fb-select" data-k="unit">${opt(UNITS, c.unit)}</select>
            </div></div>
          <p class="tb-info">Counted from the card before. Emails are sent between 9 am and 6 pm Perth time, so one that comes due overnight goes out the next morning.</p>
        </section>`;
    }
    if (s.type === "branch") {
      return `
        <section class="ef-sec">
          <label class="tb-field"><span>Check</span><select class="fb-select" data-k="cond" data-rerender>${opt(CONDS, c.cond)}</select></label>
          ${c.cond === "rules" ? '<div data-role="branch-rules"></div>' : ""}
          <p class="tb-info">Patients who match carry on down <strong>Yes</strong>. Everyone else goes down <strong>No</strong>.</p>
        </section>`;
    }
    if (s.type === "staff") {
      let who = "";
      if (c.to === "roles" || c.to === "staff") {
        if (staffList === null) who = `<p class="tb-none">${staffError ? "Couldn't load the staff list. Refresh to try again." : "Loading staff…"}</p>`;
        else if (c.to === "roles") {
          const roles = [...new Set(["Admin", ...staffList.map((x) => x.role).filter(Boolean)])];
          who = `<div class="ef-checks">${roles.map((r) => `<label class="fe-check"><input type="checkbox" data-rolecheck="${esc(r)}"${c.roles.includes(r) ? " checked" : ""} /> ${esc(r)}</label>`).join("")}</div>`;
        } else {
          who = `<div class="ef-checks">${staffList.map((x) => `<label class="fe-check"><input type="checkbox" data-staffcheck="${esc(x.id)}"${c.staffIds.includes(x.id) ? " checked" : ""}${x.hasEmail ? "" : " disabled"} />
            ${esc(x.name)} <small class="muted">${esc(x.role || "")}${x.hasEmail ? "" : " · no email on file"}</small></label>`).join("")}</div>`;
        }
      }
      return `
        <section class="ef-sec">
          <label class="tb-field"><span>Send to</span><select class="fb-select" data-k="to" data-rerender>${opt(STAFF_TO, c.to)}</select></label>
          ${who}
          ${c.to === "ssp_creator" ? '<small class="muted">If the patient has no Skin Script, this goes to the Admins instead.</small>' : ""}
          <label class="tb-field"><span>Subject</span><input class="fe-input" data-k="subject" data-tokens maxlength="200" value="${esc(c.subject)}" /></label>
          <label class="tb-field"><span>Message</span>
            <textarea class="fe-input" data-k="message" data-tokens rows="6" maxlength="3000">${esc(c.message)}</textarea></label>
          ${chipsHtml(STAFF_TOKENS)}
          <small class="muted">Staff emails include a button that opens the patient's page.</small>
        </section>`;
    }
    return '<section class="ef-sec"><p class="tb-info">This path stops here. Paths without End flow also stop after their last card.</p></section>';
  }

  function selStep() {
    if (!sel || sel === "trigger") return null;
    const r = find(flow.steps, sel);
    return r ? r.list[r.i] : null;
  }

  function renderSide() {
    editor = null;
    lastText = null;
    const r = sel && sel !== "trigger" ? find(flow.steps, sel) : null;
    if (!r) {
      if (sel !== "trigger") sel = null;
      side.innerHTML = flowSettingsHtml();
      mountSettingsRules();
      renderRuns();
      renderHolds();
      return;
    }
    const s = r.list[r.i];
    const t = TYPES[s.type];
    side.innerHTML = `
      <div class="ef-side-head"><span class="ef-ico ${t.tone}">${I[t.icon]}</span>
        <div><strong>${esc(t.label)}</strong><small>Card ${r.i + 1} of ${r.list.length} on this path</small></div>
        <button type="button" class="ef-x" data-act="close" aria-label="Close and show flow settings">×</button></div>
      <div class="ef-side-tools">
        <button type="button" class="ib-tool" data-move="-1"${r.i === 0 ? " disabled" : ""} aria-label="Move up" title="Move up">${I.up}</button>
        <button type="button" class="ib-tool" data-move="1"${r.i === r.list.length - 1 ? " disabled" : ""} aria-label="Move down" title="Move down">${I.down}</button>
        <button type="button" class="ib-tool is-danger" data-act="remove" aria-label="Remove card" title="Remove">${I.trash}</button>
      </div>
      ${stepBodyHtml(s)}`;
    if (s.type === "email" && s.cfg.mode === "html") renderPreview();
    if (s.type === "email" && s.cfg.mode !== "html") {
      editor = createRichEditor(side.querySelector('[data-role="editor"]'), {
        onInput: () => { s.cfg.body = editor.getHtml(); changed(); renderCanvas(); renderPreview(); },
        onFocus: () => { lastText = null; },
        pickImage: () => openImagePicker({ isAdmin: true }),
        accent: () => flow.style.accent,
        logo: () => (letterhead && letterhead.logo) || "",
        tokens: editorGroups,
      });
      editor.setHtml(s.cfg.body || "");
      renderPreview();
    }
    if (s.type === "branch" && s.cfg.cond === "rules") {
      mountRuleBuilder(side.querySelector('[data-role="branch-rules"]'), s.cfg.rules, {
        onChange: ruleChange, names: productNames, empty: "Add a rule to decide who goes down Yes.",
      });
    }
    if (s.type === "staff" && (s.cfg.to === "roles" || s.cfg.to === "staff")) loadStaff();
  }

  function sampleVals() {
    const c = clinicDetails(letterhead);
    const m = new Map(Object.entries(SAMPLE));
    m.set("clinic phone", c.phone || "");
    m.set("clinic email", c.email || "");
    m.set("clinic address", c.address || "");
    return m;
  }
  function renderPreview() {
    const box = side.querySelector('[data-role="prev"]');
    const s = selStep();
    if (!box || !s || s.type !== "email") return;
    const vals = sampleVals();
    const lh = letterhead || {};
    const head = `
      <div class="tb-mail-row"><span>To</span><span>Jane Citizen &lt;jane@example.com&gt;</span></div>
      <div class="tb-mail-row"><span>Subject</span><strong>${subjectHtml(fillTemplate(fillDateTokens(s.cfg.subject), vals)) || "<em>No subject yet</em>"}</strong></div>`;
    const fill = (html) => insertSspTable(fillTemplateHtml(fillDateTokens(html || ""), vals), sampleSspTable(flow.style.accent)) + (s.cfg.promo ? UNSUB : "");
    const shell = (inner) => emailShell(inner, flow.style, { clinic: clinicDetails(lh), hasLogo: !!lh.logo });

    if (s.cfg.mode === "html") {
      // Your own HTML: shown in a frame of its own, so its styles can't affect the portal
      const inner = fill(s.cfg.code);
      const html = s.cfg.bare ? inner : shell(inner);
      box.innerHTML = `<div class="tb-mail">${head}<iframe class="ef-codeprev" sandbox="allow-same-origin allow-popups" title="Email preview"></iframe></div>`;
      const fr = box.querySelector("iframe");
      fr.addEventListener("load", () => {
        try {
          const d = fr.contentDocument;
          hydrateRichImages(d.body, { logo: lh.logo || "" });
          const fit = () => { fr.style.height = Math.min(1600, Math.max(240, d.documentElement.scrollHeight + 4)) + "px"; };
          fit();
          d.querySelectorAll("img").forEach((img) => img.addEventListener("load", fit));
        } catch (err) { console.warn("Preview frame:", err); }
      });
      fr.srcdoc = /<html[\s>]/i.test(html) ? html
        : `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:0">${html}</body></html>`;
      return;
    }
    box.innerHTML = `<div class="tb-mail">${head}
      <div class="tb-mail-body tb-mail-shell" data-role="shell">${shell(fill(s.cfg.body))}</div></div>`;
    hydrateRichImages(box.querySelector('[data-role="shell"]'), { logo: lh.logo || "" });
  }
  // While typing HTML: update the preview when you pause, not on every key
  let prevTimer = 0;
  const previewSoon = () => { clearTimeout(prevTimer); prevTimer = setTimeout(renderPreview, 350); };

  function loadStaff() {
    if (staffList !== null || staffError) return;
    fetchStaffList()
      .then((list) => { staffList = list; })
      .catch((err) => { console.warn("Staff list failed:", err); staffError = true; })
      .finally(() => { if (root.isConnected && !editor) renderSide(); });
  }

  const NUM_PATHS = ["stop.gapDays", "trigger.repeatDays", "trigger.dailyMax"];
  const RERENDER_PATHS = ["trigger.event", "trigger.scope", "trigger.serviceScope"];
  function setFlowValue(path, el) {
    const v = el.type === "checkbox" ? el.checked : el.value;
    if (path === "name" || path === "description") { flow[path] = v; return; }
    const [a, b] = path.split(".");
    flow[a][b] = NUM_PATHS.includes(path) ? Number(v) : v;
  }

  side.addEventListener("focusin", (e) => { if (e.target.matches("[data-tokens]")) lastText = e.target; });
  side.addEventListener("mousedown", (e) => { if (e.target.closest('[data-token], [data-act="date-ins"]')) e.preventDefault(); });

  side.addEventListener("input", (e) => {
    const el = e.target;
    if (el.closest(".re")) return; // the message editor reports its own changes
    if (el.dataset.role === "pwin") { buyDays = Number(el.value) || 14; return; }
    if (el.dataset.f !== undefined) {
      setFlowValue(el.dataset.f, el);
      if (el.dataset.f === "trigger.event") { matchData = null; buyData = null; }
      renderCanvas();
      changed();
      if (RERENDER_PATHS.includes(el.dataset.f)) renderSide();
      return;
    }
    if (el.dataset.style !== undefined) {
      flow.style[el.dataset.style] = el.type === "checkbox" ? el.checked : el.value;
      changed();
      return;
    }
    const s = selStep();
    if (!s) return;
    if (el.dataset.k) {
      const k = el.dataset.k;
      s.cfg[k] = el.type === "checkbox" ? el.checked : k === "num" ? Number(el.value) : el.value;
    } else if (el.dataset.rolecheck !== undefined) {
      const set = new Set(s.cfg.roles);
      if (el.checked) set.add(el.dataset.rolecheck); else set.delete(el.dataset.rolecheck);
      s.cfg.roles = [...set];
    } else if (el.dataset.staffcheck !== undefined) {
      const set = new Set(s.cfg.staffIds);
      if (el.checked) set.add(el.dataset.staffcheck); else set.delete(el.dataset.staffcheck);
      s.cfg.staffIds = [...set];
    } else {
      return;
    }
    changed();
    renderCanvas();
    if (el.dataset.rerender !== undefined) renderSide();
    else if (s.type === "email") previewSoon();
  });

  // "Who matches today?" for a daily check
  /* ---------- See who's next, Start now, Hold and Start again ---------- */
  const MATCH_ST = {
    will: ["Starts at the next check", "is-active"],
    later: ["Starts the day after (daily limit)", "is-active"],
    baseline: ["Matched before it was turned on", ""],
    active: ["Already in this flow", "is-test"],
    done: ["Already been through it", ""],
    noemail: ["No email address", "is-failed"],
    held: ["Held", "is-failed"],
    nopatient: ["Not in the Patient List", "is-failed"],
    released: ["Released: check again", ""],
  };
  const actError = (ex) => ({
    UNAUTHORIZED: "Your login has timed out. Log out and back in, then try again. Your flow is saved.",
    NOT_LIVE: "Turn the flow on first.",
    HELD: "This patient is held. Release them first.",
    ALREADY: "They're already in this flow.",
    NOT_FINISHED: "They're still in this flow.",
    BUSY: "The flows are running right now. Try again in a minute.",
    NO_PATIENT: "That patient couldn't be found.",
    FORBIDDEN: "You need Build email flows access.",
    RATE_LIMITED: "You've checked a lot in the last hour. Try again later.",
  }[ex && ex.code] || (ex && ex.detail) || "Couldn't do that. Try again.");

  function matchRow(r) {
    const [lbl, cls] = MATCH_ST[r.state] || [r.state, ""];
    const live = status === "live";
    const acts = [
      live && r.id && !["held", "active", "nopatient"].includes(r.state)
        ? `<button type="button" class="lh-btn is-quiet" data-startnow="${esc(r.id)}">Start now</button>` : "",
      r.id && !["held", "nopatient"].includes(r.state)
        ? `<button type="button" class="lh-btn is-quiet" data-hold="${esc(r.id)}" data-name="${esc(r.name || "")}">Hold</button>` : "",
      r.state === "held" ? `<button type="button" class="lh-btn is-quiet" data-release="${esc(r.id)}">Release</button>` : "",
    ].filter(Boolean).join("");
    const nm = `<strong>${esc(r.name || "Unknown")}</strong>`;
    return `<div class="ef-run">
      <div class="ef-run-top">${r.id ? `<a href="#/patient/${encodeURIComponent(r.id)}">${nm}</a>` : nm}
        <span class="ef-st ${cls}">${esc(lbl)}</span></div>
      ${r.note ? `<small>${esc(r.note)}</small>` : ""}
      ${acts ? `<div class="ef-run-acts">${acts}</div>` : ""}
    </div>`;
  }
  function matchHtml(d) {
    if (d.error) return `<p class="tb-none tb-bad">${esc(d.error)}</p>`;
    const rows = d.rows || [];
    const inState = (...ks) => rows.filter((r) => ks.includes(r.state));
    const next = inState("will", "later");
    const before = inState("baseline");
    const rest = inState("active", "done", "noemail", "held", "nopatient", "released");
    const live = status === "live";
    const startBtn = (act, list) => live && list.length
      ? `<button type="button" class="lh-btn" data-act="${act}">Start ${list.length > 50 ? "the first 50" : `all ${list.length}`} now</button>` : "";
    const group = (title, list, btn, open) => list.length
      ? `<details class="ef-mgroup"${open ? " open" : ""}><summary>${esc(title)} (${list.length})</summary>${btn}${list.map(matchRow).join("")}</details>` : "";
    return `
      <p class="tb-ready">${d.count} patient${d.count === 1 ? "" : "s"} match${d.count === 1 ? "es" : ""} today
        ${d.partial ? `(checked ${d.checked} of ${d.total}, so there may be more)` : `(out of ${d.total})`}</p>
      ${!live ? '<p class="tb-info">The flow is off. Turn it on to start anyone.</p>'
        : mode !== "real" ? '<p class="tb-info">The flow is testing, so anyone you start sends their emails to you, marked [Test].</p>' : ""}
      ${group("Will start at the next check", next, startBtn("start-all", next), true)}
      ${group("Matched before it was turned on", before, startBtn("start-before", before), !next.length)}
      ${group("Won't start", rest, "", false)}
      ${d.more ? `<small class="muted">${d.more} more not shown.</small>` : ""}
      ${!rows.length ? '<p class="tb-none">Nobody matches today.</p>' : ""}`;
  }
  const drawMatch = () => {
    const o = side.querySelector('[data-role="match-out"]');
    if (o) o.innerHTML = matchData ? matchHtml(matchData) : "";
  };
  const setRowState = (ids, state) => {
    const s = new Set(ids.filter(Boolean));
    [matchData, buyData].forEach((d) => {
      if (d && d.rows) d.rows.forEach((r) => { if (s.has(r.id)) { r.state = state; r.note = ""; } });
    });
    drawMatch();
    drawBuys();
  };

  async function previewMatches(btn) {
    const p = groupProblem(flow.trigger.rules, true);
    if (p) { matchData = { error: `${p}.` }; drawMatch(); return; }
    btn.disabled = true;
    btn.textContent = "Checking every patient…";
    const out = side.querySelector('[data-role="match-out"]');
    if (out) out.innerHTML = '<p class="tb-none">This can take a minute or two.</p>';
    try {
      await settle();
      matchData = await callApi({ action: "emailFlow", op: "preview", flowId: id });
    } catch (ex) {
      console.error("Preview failed:", ex);
      matchData = { error: actError(ex) };
    } finally {
      drawMatch();
      if (btn.isConnected) { btn.disabled = false; btn.textContent = "See who's next"; }
    }
  }

  /* ---------- See recent purchases (purchase flows) ---------- */
  const BUY_ST = {
    will: ["Starts at the next check", "is-active"], old: ["Won't start by itself", ""],
    off: ["Would start (the flow is off)", ""], noemail: ["No email address", "is-failed"],
    unchecked: ["Rules not checked", ""], active: ["In this flow now", "is-test"], ran: ["Been through it", ""],
    norules: ["Doesn't match the start rules", ""], held: ["Held", "is-failed"],
    noid: ["No Patient ID on the invoice", "is-failed"], nopatient: ["Not in the Patient List", "is-failed"],
    released: ["Released: check again", ""],
  };
  const CAN_START = ["will", "old", "noemail", "unchecked"];
  const niceKey = (k) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
  };
  function buyRow(r, i) {
    const [lbl, cls] = BUY_ST[r.state] || [r.state, ""];
    const live = status === "live";
    const acts = [
      live && CAN_START.includes(r.state) ? `<button type="button" class="lh-btn is-quiet" data-pstart="${i}">Start now</button>` : "",
      live && r.state === "ran" && r.runId
        ? `<button type="button" class="lh-btn is-quiet" data-restart="${esc(r.runId)}" data-name="${esc(r.name || "")}">Start again</button>` : "",
      r.id && !["held", "nopatient", "noid"].includes(r.state)
        ? `<button type="button" class="lh-btn is-quiet" data-hold="${esc(r.id)}" data-name="${esc(r.name || "")}">Hold</button>` : "",
      r.state === "held" ? `<button type="button" class="lh-btn is-quiet" data-release="${esc(r.id)}">Release</button>` : "",
    ].filter(Boolean).join("");
    const nm = `<strong>${esc(r.name || "Unknown")}</strong>`;
    return `<div class="ef-run">
      <div class="ef-run-top">${r.id ? `<a href="#/patient/${encodeURIComponent(r.id)}">${nm}</a>` : nm}
        <span class="ef-st ${cls}">${esc(lbl)}</span></div>
      <small>${esc(r.product)} · bought ${esc(niceKey(r.date))}</small>
      ${r.note ? `<small>${esc(r.note)}</small>` : ""}
      ${acts ? `<div class="ef-run-acts">${acts}</div>` : ""}
    </div>`;
  }
  function buyHtml(d) {
    if (d.error) return `<p class="tb-none tb-bad">${esc(d.error)}</p>`;
    const rows = d.rows || [];
    const pick = (...ks) => rows.map((r, i) => [r, i]).filter(([r]) => ks.includes(r.state));
    const will = pick("will");
    const can = pick("old", "noemail", "unchecked", "off");
    const rest = pick("active", "ran", "norules", "held", "noid", "nopatient", "released");
    const live = status === "live";
    const startable = (list) => list.filter(([r]) => CAN_START.includes(r.state)).length;
    const btn = (grp, list) => (live && startable(list)
      ? `<button type="button" class="lh-btn" data-act="buys-start" data-grp="${grp}">Start ${startable(list) > 50 ? "the first 50" : `all ${startable(list)}`} now</button>` : "");
    const group = (title, list, b, open) => (list.length
      ? `<details class="ef-mgroup"${open ? " open" : ""}><summary>${esc(title)} (${list.length})</summary>${b}${list.map(([r, i]) => buyRow(r, i)).join("")}</details>` : "");
    return `
      <p class="tb-ready">${d.total} matching purchase${d.total === 1 ? "" : "s"} in the last ${d.days} days</p>
      ${!live ? '<p class="tb-info">The flow is off. Turn it on to start anyone.</p>'
        : mode !== "real" ? '<p class="tb-info">The flow is testing, so anyone you start sends their emails to you, marked [Test].</p>' : ""}
      ${group("Starts at the next check", will, btn("will", will), true)}
      ${group("Won't start by itself", can, btn("can", can), !will.length)}
      ${group("Already in it, or can't start", rest, "", false)}
      ${d.more ? `<small class="muted">${d.more} more not shown. Choose a shorter time to see them all.</small>` : ""}
      ${!rows.length ? '<p class="tb-none">No matching purchases in that time.</p>' : ""}`;
  }
  function drawBuys() {
    const o = side.querySelector('[data-role="buys-out"]');
    if (o) o.innerHTML = buyData ? buyHtml(buyData) : "";
  }
  async function previewBuys(btn) {
    btn.disabled = true;
    btn.textContent = "Checking purchases…";
    const out = side.querySelector('[data-role="buys-out"]');
    if (out) out.innerHTML = '<p class="tb-none">This can take a minute.</p>';
    try {
      await settle();
      buyData = await callApi({ action: "emailFlow", op: "purchasePreview", flowId: id, days: buyDays });
    } catch (ex) {
      console.error("Purchase preview failed:", ex);
      buyData = { error: actError(ex) };
    } finally {
      drawBuys();
      if (btn.isConnected) { btn.disabled = false; btn.textContent = "See recent purchases"; }
    }
  }
  async function startBuys(idxs, btn) {
    const items = idxs.map((i) => ((buyData && buyData.rows) || [])[i]).filter(Boolean);
    if (!items.length) return;
    if (!(await confirmDialog({
      title: items.length > 1 ? `Start the flow for ${items.length} purchases now?` : `Start the flow for ${items[0].name || "this patient"} now?`,
      message: mode !== "real"
        ? "The flow is testing, so the emails come to you, marked [Test]."
        : "Their first email goes now (or at 9 am if it's after hours), then the rest follow the flow.",
      confirmLabel: "Start now", tone: "info",
    }))) return;
    btn.disabled = true;
    try {
      await settle();
      const r = await callApi({ action: "emailFlow", op: "startPurchase", flowId: id,
        items: items.map((x) => ({ key: x.key, invoiceId: x.invoiceId, product: x.product, date: x.date, name: x.name })) });
      const sk = r.skipped || [];
      const bad = new Set(sk.map((x) => x.i));
      items.forEach((x, n) => { if (!bad.has(n)) { x.state = "active"; x.note = ""; } });
      drawBuys();
      showToast(`${r.started} started${sk.length ? `. ${sk.length} skipped: ${sk.slice(0, 3).map((x) => `${x.name || "a patient"} (${x.why})`).join(", ")}` : "."}`);
      runs = null;
      renderRuns();
    } catch (ex) {
      console.error("Start purchases failed:", ex);
      showToast(actError(ex));
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function startNow(ids, btn) {
    const many = ids.length > 1;
    if (!(await confirmDialog({
      title: many ? `Start the flow for ${ids.length} patients now?` : "Start the flow for this patient now?",
      message: mode !== "real"
        ? "The flow is testing, so the emails come to you, marked [Test]."
        : "Their first email goes now (or at 9 am if it's after hours), then the rest follow the flow.",
      confirmLabel: "Start now", tone: "info",
    }))) return;
    btn.disabled = true;
    try {
      await settle();
      const r = await callApi({ action: "emailFlow", op: "startNow", flowId: id, patientIds: ids });
      const sk = r.skipped || [];
      showToast(`${r.started} started${sk.length ? `. ${sk.length} skipped: ${sk.slice(0, 3).map((x) => `${x.name || "a patient"} (${x.why})`).join(", ")}` : "."}`);
      const skipped = new Set(sk.map((x) => x.id));
      setRowState(ids.filter((x) => !skipped.has(x)), "active");
      runs = null;
      renderRuns();
    } catch (ex) {
      console.error("Start now failed:", ex);
      showToast(actError(ex));
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function holdPatient(pid, name, btn) {
    if (!(await confirmDialog({
      title: `Hold ${name || "this patient"}?`,
      message: "They won't start this flow, and if they're in it now, it stops for them. You can release them any time under Held patients.",
      confirmLabel: "Hold", tone: "danger",
    }))) return;
    btn.disabled = true;
    try {
      const r = await callApi({ action: "emailFlow", op: "hold", flowId: id, patientId: pid });
      showToast(r.stopped ? "Held, and the flow stopped for them." : "Held. They won't start this flow.");
      setRowState([pid, r.patientId], "held");
      holds = null;
      renderHolds();
      runs = null;
      renderRuns();
    } catch (ex) {
      console.error("Hold failed:", ex);
      showToast(actError(ex));
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function releasePatient(pid, btn) {
    btn.disabled = true;
    try {
      await callApi({ action: "emailFlow", op: "release", flowId: id, patientId: pid });
      showToast("Released. They can start this flow again.");
      setRowState([pid], "released");
      holds = null;
      renderHolds();
      runs = null;
      renderRuns();
    } catch (ex) {
      console.error("Release failed:", ex);
      showToast(actError(ex));
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function restartRun(runId, name, btn) {
    if (!(await confirmDialog({
      title: `Start the flow again for ${name || "this patient"}?`,
      message: mode !== "real" ? "It starts from the first card. The flow is testing, so the emails come to you."
        : "It starts from the first card, and their first email goes now (or at 9 am).",
      confirmLabel: "Start again", tone: "info",
    }))) return;
    btn.disabled = true;
    try {
      await settle();
      await callApi({ action: "emailFlow", op: "restart", runId });
      showToast("Started again.");
      runs = null;
      renderRuns();
    } catch (ex) {
      console.error("Start again failed:", ex);
      showToast(actError(ex));
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function loadHolds() {
    if (holdsLoading) return;
    holdsLoading = true;
    try {
      const r = await callApi({ action: "emailFlow", op: "holds", flowId: id });
      holds = r.holds || [];
      holdsErr = false;
    } catch (ex) {
      console.warn("Holds failed:", ex);
      holds = [];
      holdsErr = true;
    } finally {
      holdsLoading = false;
    }
    if (root.isConnected) { renderHolds(); renderRuns(); }
  }
  function renderHolds() {
    const box = side.querySelector('[data-role="holds"]');
    if (!box) return;
    if (holds === null) {
      box.innerHTML = '<h4>Held patients</h4><p class="tb-none">Loading…</p>';
      loadHolds();
      return;
    }
    box.innerHTML = `<h4>Held patients</h4>
      ${holdsErr ? '<p class="tb-none tb-bad">Couldn\'t load. Press Refresh above.</p>' : ""}
      ${!holds.length && !holdsErr ? '<p class="tb-none">Nobody is held. Hold someone from See who\'s next, or from Patients in this flow.</p>' : ""}
      ${holds.map((h) => `<div class="ef-run">
        <div class="ef-run-top"><a href="#/patient/${encodeURIComponent(h.patientId)}"><strong>${esc(h.patientName || "Unknown")}</strong></a>
          <button type="button" class="lh-btn is-quiet" data-release="${esc(h.patientId)}">Release</button></div>
        <small>Held by ${esc(h.by || "staff")}${h.at ? ` · ${esc(new Date(h.at).toLocaleDateString("en-AU", { day: "numeric", month: "short" }))}` : ""}</small>
      </div>`).join("")}`;
  }

  side.addEventListener("click", async (e) => {
    const pm = e.target.closest('[data-act="preview-match"]');
    if (pm) { previewMatches(pm); return; }
    const pb = e.target.closest('[data-act="preview-buys"]');
    if (pb) { previewBuys(pb); return; }
    const ps = e.target.closest("[data-pstart]");
    if (ps) { startBuys([Number(ps.dataset.pstart)], ps); return; }
    const bs = e.target.closest('[data-act="buys-start"]');
    if (bs) {
      const want = bs.dataset.grp === "will" ? ["will"] : ["old", "noemail", "unchecked"];
      const idxs = ((buyData && buyData.rows) || []).map((r, i) => (want.includes(r.state) ? i : -1)).filter((i) => i >= 0).slice(0, 50);
      if (idxs.length) startBuys(idxs, bs);
      return;
    }
    if (e.target.closest('[data-act="runs-refresh"]')) { runs = null; holds = null; renderRuns(); renderHolds(); return; }
    const sn = e.target.closest("[data-startnow]");
    if (sn) { startNow([sn.dataset.startnow], sn); return; }
    const sa = e.target.closest('[data-act="start-all"], [data-act="start-before"]');
    if (sa) {
      const want = sa.dataset.act === "start-all" ? ["will", "later"] : ["baseline"];
      const ids = ((matchData && matchData.rows) || []).filter((r) => want.includes(r.state) && r.id).map((r) => r.id).slice(0, 50);
      if (ids.length) startNow(ids, sa);
      return;
    }
    const hd = e.target.closest("[data-hold]");
    if (hd) { holdPatient(hd.dataset.hold, hd.dataset.name, hd); return; }
    const rl = e.target.closest("[data-release]");
    if (rl) { releasePatient(rl.dataset.release, rl); return; }
    const rs = e.target.closest("[data-restart]");
    if (rs) { restartRun(rs.dataset.restart, rs.dataset.name, rs); return; }
    const stopRun = e.target.closest("[data-stoprun]");
    if (stopRun) {
      if (!(await confirmDialog({
        title: "Stop the flow for this patient?", message: "They won't get any more emails from this flow.",
        confirmLabel: "Stop", cancelLabel: "Keep going", tone: "danger",
      }))) return;
      stopRun.disabled = true;
      try {
        await callApi({ action: "emailFlow", op: "stopRun", id: stopRun.dataset.stoprun });
        showToast("Stopped. No more emails from this flow for them.");
        runs = null;
        renderRuns();
      } catch (ex) {
        console.error("Stop run failed:", ex);
        showToast(ex && ex.code === "NOT_ACTIVE" ? "It has already finished." : "Couldn't stop it. Try again.");
        if (stopRun.isConnected) stopRun.disabled = false;
      }
      return;
    }
    const di = e.target.closest('[data-act="date-ins"]');
    const tok = di || e.target.closest("[data-token]");
    if (tok) {
      const name = di ? dateInsertName(di.closest(".ef-dateins")) : tok.dataset.token;
      if (lastText && lastText.isConnected) {
        const el = lastText;
        const ins = `{${name}}`;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        el.value = el.value.slice(0, start) + ins + el.value.slice(end);
        el.focus();
        el.setSelectionRange(start + ins.length, start + ins.length);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (editor) {
        editor.insertToken(name);
      } else {
        showToast("Click in the subject or message first.");
      }
      return;
    }
    const md = e.target.closest("[data-mode]");
    if (md) {
      const s = selStep();
      if (!s || s.type !== "email" || s.cfg.mode === md.dataset.mode) return;
      if (md.dataset.mode === "html") {
        if (!String(s.cfg.code || "").trim()) s.cfg.code = editor ? editor.getHtml() : s.cfg.body || "";
        s.cfg.mode = "html";
      } else {
        if (!(await confirmDialog({
          title: "Go back to the editor?",
          message: "The editor only keeps simple formatting, so custom layout, tables and styles may not show there. Your HTML code is kept, so you can switch back to it any time.",
          confirmLabel: "Use the editor", tone: "warning",
        }))) return;
        s.cfg.mode = "rich";
        if (!plainText(s.cfg.body)) s.cfg.body = s.cfg.code || "";
      }
      changed(); renderCanvas(); renderSide();
      return;
    }
    if (e.target.closest('[data-act="code-starter"]')) {
      const s = selStep();
      if (!s || s.type !== "email") return;
      s.cfg.code = STARTER_HTML;
      changed(); renderCanvas(); renderSide();
      return;
    }
    if (e.target.closest('[data-act="close"]')) { sel = null; renderCanvas(); renderSide(); return; }

    const mv = e.target.closest("[data-move]");
    if (mv && sel) {
      const r = find(flow.steps, sel);
      if (!r) return;
      const j = r.i + Number(mv.dataset.move);
      if (j < 0 || j >= r.list.length) return;
      if (r.list[r.i].type === "stop" || r.list[j].type === "stop") { showToast("End flow always stays at the bottom of its path."); return; }
      [r.list[r.i], r.list[j]] = [r.list[j], r.list[r.i]];
      changed();
      renderCanvas();
      renderSide();
      return;
    }

    if (e.target.closest('[data-act="remove"]') && sel) {
      const r = find(flow.steps, sel);
      if (!r) return;
      const s = r.list[r.i];
      const inside = s.type === "branch" ? count(s.cfg.yes) + count(s.cfg.no) : 0;
      if (inside && !(await confirmDialog({
        title: "Remove this If / else?",
        message: `The ${inside} card${inside === 1 ? "" : "s"} inside Yes and No will be removed too.`,
        confirmLabel: "Remove", tone: "danger",
      }))) return;
      r.list.splice(r.i, 1);
      sel = null;
      changed();
      renderCanvas();
      renderSide();
    }
  });

  /* ---------- Patients in this flow ---------- */
  const RUN_ST = {
    active: ["In progress", "is-active"], done: ["Finished", "is-done"], stopped: ["Stopped", ""],
    failed: ["Not sent", "is-failed"], skipped: ["Skipped", ""],
  };
  const runWhen = (ms) => (ms ? new Date(Number(ms)).toLocaleString("en-AU",
    { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

  async function loadRuns() {
    if (runsLoading) return;
    runsLoading = true;
    try {
      const snap = await getDocs(query(collection(db, "email_flow_runs"), where("flowId", "==", id), limit(200)));
      runs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
      runsErr = "";
    } catch (err) {
      console.warn("Flow runs failed:", err);
      runs = [];
      runsErr = err && err.code === "permission-denied" ? "blocked" : "error";
    } finally {
      runsLoading = false;
    }
    if (root.isConnected) renderRuns();
  }

  function runWhat(r) {
    if (r.kind === "visit") return [`Visit on ${r.visitDate || r.purchaseDate || ""}`, (r.visitServices || []).join(", ")];
    if (r.kind === "daily") return [`Daily check · started ${String(r.startedAt || "").slice(0, 10)}`];
    return [r.product, r.purchaseDate && `bought ${r.purchaseDate}`];
  }
  function runHtml(r) {
    const [lbl, cls] = RUN_ST[r.status] || [r.status || "", ""];
    const testing = r.mode === "test" && r.status === "active";
    const at = r.status === "active" && r.next ? find(flow.steps, r.next) : null;
    const step = at ? at.list[at.i] : null;
    const next = step ? `Next: ${TYPES[step.type].short}${step.type === "email" && step.cfg.subject ? ` · ${step.cfg.subject}` : ""}${
      Number(r.dueAt) > Date.now() ? ` · ${runWhen(r.dueAt)}` : ""}` : "";
    const held = !!r.patientId && (holds || []).some((h) => h.patientId === r.patientId);
    const acts = [
      r.status === "active" ? `<button type="button" class="lh-btn is-quiet" data-stoprun="${esc(r.id)}">Stop for this patient</button>` : "",
      r.status !== "active" && r.patientId && status === "live" && !held
        ? `<button type="button" class="lh-btn is-quiet" data-restart="${esc(r.id)}" data-name="${esc(r.patientName || "")}">Start again</button>` : "",
      r.patientId && !held ? `<button type="button" class="lh-btn is-quiet" data-hold="${esc(r.patientId)}" data-name="${esc(r.patientName || "")}">Hold</button>` : "",
      held ? '<span class="ef-st is-failed">Held</span>' : "",
    ].filter(Boolean).join("");
    return `<div class="ef-run">
      <div class="ef-run-top"><strong>${esc(r.patientName || "Unknown patient")}</strong>
        <span class="ef-st ${testing ? "is-test" : cls}">${testing ? "Testing" : esc(lbl)}</span></div>
      <small>${esc([...runWhat(r), `${Number(r.sent) || 0} sent`].filter(Boolean).join(" · "))}</small>
      ${next ? `<small>${esc(next)}</small>` : ""}
      ${r.reason && r.status !== "active" ? `<small>${esc(r.reason)}</small>` : ""}
      ${acts ? `<div class="ef-run-acts">${acts}</div>` : ""}
    </div>`;
  }
  
  function renderRuns() {
    const box = side.querySelector('[data-role="runs"]');
    if (!box) return;
    if (runs === null) {
      box.innerHTML = '<h4>Patients in this flow</h4><p class="tb-none">Loading…</p>';
      loadRuns();
      return;
    }
    const n = (k) => runs.filter((r) => r.status === k).length;
    const list = runs.slice(0, 12);
    const ev = flow.trigger.event;
    const waiting = ev === "visit" ? "Patients start the flow the morning after a matching visit."
      : ev === "daily" ? "Patients start the flow when the morning check finds them."
      : "Patients start the flow when the invoice sync brings in a matching purchase.";
    box.innerHTML = `
      <div class="ef-runs-head"><h4>Patients in this flow</h4>
        <button type="button" class="lh-btn is-quiet" data-act="runs-refresh">Refresh</button></div>
      ${runsErr ? `<p class="tb-none tb-bad">${runsErr === "blocked" ? "Blocked. Check the email_flow_runs Firestore rule." : "Couldn't load. Press Refresh."}</p>` : ""}
      ${!runs.length && !runsErr ? `<p class="tb-none">${status === "live" ? `Nobody yet. ${waiting}`
        : "Nobody yet. Turn the flow on to start it, or use Test with a patient."}</p>` : ""}
      ${runs.length ? `<div class="ef-runs-n">${["active", "done", "stopped", "failed", "skipped"].filter((k) => n(k))
        .map((k) => `<span class="ef-st ${RUN_ST[k][1]}">${n(k)} ${RUN_ST[k][0].toLowerCase()}</span>`).join("")}</div>` : ""}
      ${list.map(runHtml).join("")}
      ${runs.length > list.length ? `<small class="muted">Showing the latest ${list.length} of ${runs.length}.</small>` : ""}`;
  }

  /* ---------- Test with a patient ---------- */
  const testError = (ex) => ({
    NO_PATIENT: "That patient couldn't be found.",
    NO_EMAIL: "Add your email address in Staff first, so the test emails can reach you.",
    NO_PRODUCT: "Type the product they bought.",
    QUOTA: "The clinic's email limit for today is nearly used up. Try again tomorrow.",
    RATE_LIMITED: "You've run a lot of tests in the last hour. Try again a little later.",
    FORBIDDEN: "You need Build email flows access.",
    NOT_FOUND: "This flow has been deleted.",
    UNAUTHORIZED: "Your session has expired. Log out and back in.",
  }[ex && ex.code] || (ex && ex.detail) || "The test couldn't run. Check Apps Script → Executions.");

  function testDialog() {
    const ev = flow.trigger.event;
    const extra = ev === "purchase" ? `
        <label class="lh-field"><span class="lh-label">Product they bought</span>
          <input type="text" name="extra" maxlength="150" list="ef-test-list" placeholder="e.g. Hydrating Serum" /></label>
        <datalist id="ef-test-list">${productNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>`
      : ev === "visit" ? `
        <label class="lh-field"><span class="lh-label">Services at the visit <small>(optional, separate with commas)</small></span>
          <input type="text" name="extra" maxlength="300" list="ef-test-list" placeholder="e.g. DermaGlow Peel" /></label>
        <datalist id="ef-test-list">${serviceNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>`
      : '<p class="tb-info">The patient is checked against the daily rules now, then the whole flow runs.</p>';
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ef-test-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Test with a patient</h3>
          <p>Runs the whole flow now for a patient you choose. Every email comes to you, marked [Test]. Waits are skipped. Nothing goes to the patient.</p></div>
        <label class="lh-field" data-role="find"><span class="lh-label">Patient</span>
          <input type="search" name="q" placeholder="Search by name" autocomplete="off" /></label>
        <div class="ef-test-hits" data-role="hits"></div>
        <div data-role="pick"></div>
        ${extra}
        <div data-role="out"></div>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Close</button>
          <button type="submit" class="lh-btn is-primary">Run test</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    const hits = dlg.querySelector('[data-role="hits"]');
    const pickBox = dlg.querySelector('[data-role="pick"]');
    const findBox = dlg.querySelector('[data-role="find"]');
    const out = dlg.querySelector('[data-role="out"]');
    const err = dlg.querySelector(".lh-error");
    const runBtn = form.querySelector('[type="submit"]');
    let chosen = null, found = [], timer = null, seq = 0;

    const showPick = () => {
      pickBox.innerHTML = chosen ? `<div class="ef-chosen"><span><strong>${esc(chosen.name)}</strong><br>
        <small class="muted">${esc(chosen.email || "No email on file")}</small></span>
        <button type="button" class="lh-btn is-quiet" data-act="unpick">Change</button></div>` : "";
      findBox.hidden = !!chosen;
      if (chosen) hits.innerHTML = "";
    };
    form.elements.q.addEventListener("input", () => {
      clearTimeout(timer);
      const q = form.elements.q.value;
      if (q.trim().length < 2) { hits.innerHTML = ""; return; }
      const my = ++seq;
      timer = setTimeout(async () => {
        try { found = await searchPatients(q); } catch (ex) { console.warn(ex); found = []; }
        if (my !== seq || !dlg.open) return;
        hits.innerHTML = found.length ? found.map((p, i) => `<button type="button" class="ef-hit" data-hit="${i}">
          <strong>${esc(p.name)}</strong><small>${esc([p.dob && `DOB ${p.dob}`, p.email || "No email on file"].filter(Boolean).join(" · "))}</small>
        </button>`).join("") : '<p class="tb-none">No patients found. Try their last name.</p>';
      }, 250);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]')) { dlg.close(); return; }
      if (e.target.closest('[data-act="unpick"]')) { chosen = null; showPick(); form.elements.q.focus(); return; }
      const h = e.target.closest("[data-hit]");
      if (h) {
        chosen = found[Number(h.dataset.hit)] || null;
        showPick();
        if (form.elements.extra) form.elements.extra.focus();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const extraVal = form.elements.extra ? form.elements.extra.value.trim() : "";
      const problem = !chosen ? "Choose a patient."
        : ev === "purchase" && !extraVal ? "Type the product they bought." : flowProblems(flow)[0] || "";
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      runBtn.disabled = true;
      runBtn.textContent = "Running…";
      out.innerHTML = '<p class="tb-none">Running the flow. This can take up to a minute…</p>';
      try {
        await settle();
        const res = await callApi({ action: "emailFlow", op: "test", flowId: id, patientId: chosen.id,
          product: ev === "purchase" ? extraVal : "", services: ev === "visit" ? extraVal : "" });
        out.innerHTML = `<div class="tb-ready">${res.sent} test email${res.sent === 1 ? "" : "s"} sent to ${esc(res.to)}</div>
          <ol class="ef-steps">${(res.steps || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
      } catch (ex) {
        console.error("Flow test failed:", ex);
        out.innerHTML = "";
        err.textContent = testError(ex);
        err.hidden = false;
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = "Run test again";
      }
    });
    dlg.addEventListener("close", () => { clearTimeout(timer); dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    form.elements.q.focus();
  }

  /* ---------- Top bar actions ---------- */
  root.querySelector(".ff-bar").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;

    if (act.dataset.act === "test") { testDialog(); return; }

    if (act.dataset.act === "mode") {
      const toReal = mode !== "real";
      if (!(await confirmDialog(toReal ? {
        title: "Start sending to patients?",
        message: "From now on, patients who start this flow get the emails themselves.\n\nPatients who started it while you were testing keep sending to you.",
        confirmLabel: "Send to patients", cancelLabel: "Keep testing", tone: "warning",
      } : {
        title: "Go back to testing?",
        message: "Patients who start the flow from now on are emailed to you instead, marked [Test].",
        confirmLabel: "Back to testing", tone: "info",
      }))) return;
      await settle();
      try {
        await saveFlow(id, flow, staff, null, letterhead, { sendMode: toReal ? "real" : "test" });
        mode = toReal ? "real" : "test";
        renderBar();
        showToast(toReal ? "Now sending to patients." : "Back to testing. Emails come to you.");
      } catch (err) { console.error(err); showToast("Couldn't change it. Try again."); }
      return;
    }

    if (act.dataset.act === "live") {
      if (status === "live") {
        await settle();
        try {
          await saveFlow(id, flow, staff, "draft", letterhead);
          status = "draft";
          renderBar();
          showToast("Turned off. Nothing more is sent until it's turned on again.");
        } catch (err) { console.error(err); showToast("Couldn't turn it off. Try again."); }
        return;
      }
      const problems = flowProblems(flow);
      if (problems.length) {
        msgEl.textContent = problems[0] + (problems.length > 1 ? ` (and ${problems.length - 1} more: look for the orange cards)` : "");
        return;
      }
      const ev = flow.trigger.event;
      const who = ev === "visit" ? "Patients who come in from today start the flow the next morning"
        : ev === "daily" ? (flow.trigger.existing
          ? `From the next morning check, patients who match start the flow (up to ${flow.trigger.dailyMax} a day)`
          : "The first morning check only notes who already matches. From the day after, patients who newly match start the flow")
        : "Patients who buy a matching product from today start the flow";
      if (!(await confirmDialog({
        title: `Turn on “${flow.name.trim()}”?`,
        message: mode === "real"
          ? `${who}, and get the emails.`
          : `${who}, but every email comes to you, marked [Test], until you press Send to patients.\n\nUse Test with a patient to try the whole flow straight away.`,
        confirmLabel: "Turn on", tone: "info",
      }))) return;
      await settle();
      try {
        await saveFlow(id, flow, staff, "live", letterhead, {
          liveAt: new Date().toISOString(), sendMode: mode,
          testUid: String((staff && staff.uid) || ""), testName: String((staff && staff.name) || ""),
        });
        status = "live";
        renderBar();
        if (!sel) renderSide();
        showToast(mode === "real" ? "Turned on." : "Turned on for testing. Emails come to you.");
      } catch (err) {
        console.error("Turn on failed:", err);
        showToast(err.code === "permission-denied" ? "You don't have Build email flows access." : "Couldn't turn it on. Try again.");
      }
      return;
    }

    if (act.dataset.act === "duplicate") {
      await settle();
      try {
        const copy = await createFlow({ ...flow, name: `${flow.name} (copy)`.slice(0, 120) }, staff);
        showToast("Copy made as a draft. You're now editing the copy.");
        location.hash = `${BASE}/${encodeURIComponent(copy)}`;
      } catch (err) { console.error(err); showToast("Couldn't make a copy. Try again."); }
      return;
    }

    if (act.dataset.act === "delete") {
      if (!(await confirmDialog({
        title: `Delete “${flow.name.trim() || "Untitled flow"}”?`,
        message: "It's removed from Email flows, and patients in it get no more emails.",
        confirmLabel: "Delete flow", tone: "danger",
      }))) return;
      await settle();
      try {
        await saveFlow(id, flow, staff, "archived", letterhead);
        location.hash = BASE;
      } catch (err) { console.error(err); showToast("Couldn't delete. Try again."); }
    }
  });

  /* ---------- Start ---------- */
  renderBar();
  renderCanvas();
  renderSide();
  lhReady.finally(() => { if (root.isConnected) renderPreview(); });
  Promise.all([loadProductNames(), loadServiceNames()]).then(([p, s]) => {
    productNames = p;
    serviceNames = s;
    // The suggestions appear once the names have loaded
    if (root.isConnected && !editor && side.querySelector("[data-pp-in]")) renderSide();
  }).catch(() => {});
}