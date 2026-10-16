// System configuration → Email flows: automatic emails to patients and staff, built from cards.
// A flow starts with a trigger (a product is purchased) and runs its cards top to bottom.
// Apps Script (runEmailFlows_) sends them. While a flow is testing, every email goes to the person who turned it on.

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, serverTimestamp, query, where, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { searchPatients } from "./task-runner.js";

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
  ["ssp_created", "A Skin Script is created", true],
  ["ssp_expiring", "A Skin Script is about to expire", true],
];
const SCOPES = [["any", "Any product"], ["catalogue", "Only Skin Script catalogue products"]];
const CONDS = [
  ["in_ssp", "The product is in their Skin Script"],
  ["has_ssp", "They have an active Skin Script"],
  ["marketing", "They agreed to marketing emails"],
  ["first_buy", "It's the first time they've bought this product"],
  ["booked", "They have an upcoming appointment"],
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
  { title: "Their Skin Script", tokens: ["SSP step", "AM instructions", "PM instructions", "When to use", "SSP clinician"], smart: true },
  { title: "Clinic", tokens: ["Clinic phone", "Clinic email", "Clinic address"] },
];
const STAFF_TOKENS = [
  { title: "Patient", tokens: ["Patient name", "Patient mobile", "Patient email"] },
  { title: "This purchase", tokens: ["Product name", "Purchase date", "Sold by"] },
  { title: "Their Skin Script", tokens: ["SSP clinician", "SSP date"], smart: true },
];
const SAMPLE = {
  "first name": "Jane", "full name": "Jane Citizen", "patient name": "Jane Citizen",
  "patient mobile": "0412 345 678", "patient email": "jane@example.com",
  "product name": "Hydrating Serum", "purchase date": "16 October 2026", "sold by": "Reception",
  "how to use": "Apply 2 pumps to clean skin, morning and night.",
  "ssp step": "Step B", "am instructions": "Apply 2 pumps after cleansing.",
  "pm instructions": "Apply 2 pumps before your moisturiser.", "when to use": "Every day",
  "ssp clinician": "Dr Teh", "ssp date": "2 September 2026",
};
const UNSUB = '<p style="margin:18px 0 0;font-size:12px;color:#64748b">You\'re getting this because you agreed to emails from Dermedica. <a href="#">Unsubscribe</a></p>';

/* ===================== Cards ===================== */

const newId = () => "s_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

function blank(type) {
  const cfg = type === "email" ? { subject: "", body: "", promo: false }
    : type === "wait" ? { num: 1, unit: "weeks" }
    : type === "branch" ? { cond: "in_ssp", yes: [], no: [] }
    : type === "staff" ? { to: "ssp_creator", roles: [], staffIds: [], subject: "", message: "" }
    : {};
  return { id: newId(), type, cfg };
}

function cleanSteps(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && TYPES[s.type]).map((s) => {
    const b = blank(s.type);
    const cfg = { ...b.cfg, ...(s.cfg || {}) };
    if (s.type === "branch") { cfg.yes = cleanSteps(cfg.yes); cfg.no = cleanSteps(cfg.no); }
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
const label = (pairs, v) => (pairs.find((p) => p[0] === v) || [])[1] || "";
const unitWord = (num, unit) => (Number(num) === 1 ? unit.replace(/s$/, "") : unit);
const triggerLabel = (t) => label(TRIGGERS, (t && t.event) || "purchase") || "A product is purchased";

function summary(s) {
  const c = s.cfg;
  if (s.type === "email") return c.subject.trim() || "No subject yet";
  if (s.type === "wait") return `${Number(c.num) || 0} ${unitWord(c.num, c.unit)}`;
  if (s.type === "branch") return label(CONDS, c.cond);
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
    if (!plainText(c.body)) out.push("Write the message");
  } else if (s.type === "wait") {
    const max = (UNITS.find((u) => u[0] === c.unit) || UNITS[0])[2];
    const n = Number(c.num);
    if (!Number.isInteger(n) || n < 1 || n > max) out.push(`Choose 1 to ${max} ${c.unit}`);
  } else if (s.type === "staff") {
    if (c.to === "roles" && !c.roles.length) out.push("Choose at least one role");
    if (c.to === "staff" && !c.staffIds.length) out.push("Choose at least one staff member");
    if (!c.subject.trim()) out.push("Add a subject");
    if (!c.message.trim()) out.push("Write the message");
  } else if (s.type === "branch" && depth > MAX_DEPTH) {
    out.push(`If / else can only go ${MAX_DEPTH} deep`);
  }
  return out;
}

function flowProblems(flow) {
  const out = [];
  if (!flow.name.trim()) out.push("Give the flow a name.");
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

function snapshot(d = {}) {
  return {
    name: String(d.name || ""),
    description: String(d.description || ""),
    trigger: { event: "purchase", scope: "any", ...(d.trigger || {}) },
    steps: cleanSteps(d.steps),
    stop: { rebuy: true, booking: false, gapDays: 3, ...(d.stop || {}) },
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
      s.cfg.html = emailShell(fillTemplateHtml(s.cfg.body || "", vals), style, { clinic: c, hasLogo: !!lh.logo });
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
        <p class="muted tm-sub">Automatic emails to patients and staff when something happens, like a product being purchased.
          Each flow is a set of cards that run from top to bottom.</p>
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
      return `<a class="tm-task" href="${BASE}/${encodeURIComponent(f.id)}">
        <span class="tm-task-icon">${I.flow}</span>
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
        <span class="ef-ico is-trigger">${I.cart}</span>
        <span class="ef-card-main"><small>When this happens</small>
          <strong>${esc(triggerLabel(flow.trigger))}${flow.trigger.scope === "catalogue" ? " (Skin Script catalogue)" : ""}</strong></span>
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

  function flowSettingsHtml() {
    const t = flow.trigger, st = flow.stop, s = flow.style;
    const sw = (key, list) => `<div class="tb-swatches">${list.map((c) => `
      <label class="tb-sw" title="${c}"><input type="radio" name="ef-${key}" data-style="${key}" value="${c}"${s[key] === c ? " checked" : ""} />
        <span style="background:${c}"></span></label>`).join("")}</div>`;
    const gaps = [[0, "No limit"], ...[1, 2, 3, 5, 7].map((d) => [d, `${d} day${d === 1 ? "" : "s"}`])];
    return `
      <div class="ef-side-head"><span class="ef-ico is-trigger">${I.cart}</span>
        <div><strong>Flow settings</strong><small>Click a card on the left to set it up</small></div></div>
      <section class="ef-sec" data-role="runs"></section>
      <section class="ef-sec"><h4>About this flow</h4>
        <label class="tb-field"><span>Name</span><input class="fe-input" data-f="name" maxlength="120" value="${esc(flow.name)}" /></label>
        <label class="tb-field"><span>Description <small>(optional)</small></span>
          <textarea class="fe-input" data-f="description" rows="2" maxlength="300">${esc(flow.description)}</textarea></label>
      </section>
      <section class="ef-sec"><h4>When this happens</h4>
        <div class="ef-radios">${TRIGGERS.map(([v, l, soon]) => `
          <label class="fe-check${soon ? " is-soon" : ""}"><input type="radio" name="ef-trig" data-f="trigger.event" value="${v}"${t.event === v ? " checked" : ""}${soon ? " disabled" : ""} />
            ${esc(l)}${soon ? ' <small class="muted">· coming soon</small>' : ""}</label>`).join("")}</div>
        <label class="tb-field"><span>Which products</span>
          <select class="fb-select" data-f="trigger.scope">${opt(SCOPES, t.scope)}</select></label>
        <p class="tb-info">Purchases come from the invoice sync (the INVOICE RECORD sheet), checked each time it updates. Each purchase starts the flow once for that patient and product. Scanner billing sheets and sales will be added next.</p>
      </section>
      <section class="ef-sec"><h4>Stop rules <small>(checked before every email)</small></h4>
        <label class="fe-check"><input type="checkbox" checked disabled /> They unsubscribe <small class="muted">(always on)</small></label>
        <label class="fe-check"><input type="checkbox" checked disabled /> They have no email address <small class="muted">(always on)</small></label>
        <label class="fe-check"><input type="checkbox" data-f="stop.rebuy"${st.rebuy ? " checked" : ""} /> They buy the same product again <small class="muted">(the flow starts over)</small></label>
        <label class="fe-check"><input type="checkbox" data-f="stop.booking"${st.booking ? " checked" : ""} /> They book an appointment</label>
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

  function stepBodyHtml(s) {
    const c = s.cfg;
    if (s.type === "email") {
      return `
        <section class="ef-sec">
          <label class="tb-field"><span>Subject</span>
            <input class="fe-input" data-k="subject" data-tokens maxlength="200" value="${esc(c.subject)}" /></label>
          <div class="tb-field"><span>Message</span><div data-role="editor"></div></div>
          ${chipsHtml(PATIENT_TOKENS)}
          <small class="muted">Tap a blank to add it where your cursor is. Blanks fill in with each patient's details when it's sent.</small>
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
          <label class="tb-field"><span>Check</span><select class="fb-select" data-k="cond">${opt(CONDS, c.cond)}</select></label>
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
    if (!r) { if (sel !== "trigger") sel = null; side.innerHTML = flowSettingsHtml(); renderRuns(); return; }
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
    if (s.type === "email") {
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
    box.innerHTML = `
      <div class="tb-mail">
        <div class="tb-mail-row"><span>To</span><span>Jane Citizen &lt;jane@example.com&gt;</span></div>
        <div class="tb-mail-row"><span>Subject</span><strong>${subjectHtml(fillTemplate(s.cfg.subject, vals)) || "<em>No subject yet</em>"}</strong></div>
        <div class="tb-mail-body tb-mail-shell" data-role="shell">${emailShell(fillTemplateHtml(s.cfg.body || "", vals) + (s.cfg.promo ? UNSUB : ""),
          flow.style, { clinic: clinicDetails(letterhead), hasLogo: !!(letterhead && letterhead.logo) })}</div>
      </div>`;
    hydrateRichImages(box.querySelector('[data-role="shell"]'), { logo: (letterhead && letterhead.logo) || "" });
  }

  function loadStaff() {
    if (staffList !== null || staffError) return;
    fetchStaffList()
      .then((list) => { staffList = list; })
      .catch((err) => { console.warn("Staff list failed:", err); staffError = true; })
      .finally(() => { if (root.isConnected && !editor) renderSide(); });
  }

  function setFlowValue(path, el) {
    const v = el.type === "checkbox" ? el.checked : el.value;
    if (path === "name" || path === "description") { flow[path] = v; return; }
    const [a, b] = path.split(".");
    flow[a][b] = path === "stop.gapDays" ? Number(v) : v;
  }

  side.addEventListener("focusin", (e) => { if (e.target.matches("[data-tokens]")) lastText = e.target; });
  side.addEventListener("mousedown", (e) => { if (e.target.closest("[data-token]")) e.preventDefault(); });

  side.addEventListener("input", (e) => {
    const el = e.target;
    if (el.closest(".re")) return; // the message editor reports its own changes
    if (el.dataset.f !== undefined) { setFlowValue(el.dataset.f, el); renderCanvas(); changed(); return; }
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
    else if (s.type === "email") renderPreview();
  });

  side.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="runs-refresh"]')) { runs = null; renderRuns(); return; }
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
    const tok = e.target.closest("[data-token]");
    if (tok) {
      const name = tok.dataset.token;
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

  function runHtml(r) {
    const [lbl, cls] = RUN_ST[r.status] || [r.status || "", ""];
    const testing = r.mode === "test" && r.status === "active";
    const at = r.status === "active" && r.next ? find(flow.steps, r.next) : null;
    const step = at ? at.list[at.i] : null;
    const next = step ? `Next: ${TYPES[step.type].short}${step.type === "email" && step.cfg.subject ? ` · ${step.cfg.subject}` : ""}${
      Number(r.dueAt) > Date.now() ? ` · ${runWhen(r.dueAt)}` : ""}` : "";
    return `<div class="ef-run">
      <div class="ef-run-top"><strong>${esc(r.patientName || "Unknown patient")}</strong>
        <span class="ef-st ${testing ? "is-test" : cls}">${testing ? "Testing" : esc(lbl)}</span></div>
      <small>${esc([r.product, r.purchaseDate && `bought ${r.purchaseDate}`, `${Number(r.sent) || 0} sent`].filter(Boolean).join(" · "))}</small>
      ${next ? `<small>${esc(next)}</small>` : ""}
      ${r.reason && r.status !== "active" ? `<small>${esc(r.reason)}</small>` : ""}
      ${r.status === "active" ? `<button type="button" class="lh-btn is-quiet" data-stoprun="${esc(r.id)}">Stop for this patient</button>` : ""}
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
    box.innerHTML = `
      <div class="ef-runs-head"><h4>Patients in this flow</h4>
        <button type="button" class="lh-btn is-quiet" data-act="runs-refresh">Refresh</button></div>
      ${runsErr ? `<p class="tb-none tb-bad">${runsErr === "blocked" ? "Blocked. Check the email_flow_runs Firestore rule." : "Couldn't load. Press Refresh."}</p>` : ""}
      ${!runs.length && !runsErr ? `<p class="tb-none">${status === "live"
        ? "Nobody yet. Patients start the flow when the invoice sync brings in a matching purchase."
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
        <label class="lh-field"><span class="lh-label">Product they bought</span>
          <input type="text" name="product" maxlength="150" placeholder="e.g. Hydrating Serum" /></label>
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
      if (h) { chosen = found[Number(h.dataset.hit)] || null; showPick(); form.elements.product.focus(); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const product = form.elements.product.value.trim();
      const problem = !chosen ? "Choose a patient." : !product ? "Type the product they bought." : flowProblems(flow)[0] || "";
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      runBtn.disabled = true;
      runBtn.textContent = "Running…";
      out.innerHTML = '<p class="tb-none">Running the flow. This can take up to a minute…</p>';
      try {
        await settle();
        const res = await callApi({ action: "emailFlow", op: "test", flowId: id, patientId: chosen.id, product });
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
      if (!(await confirmDialog({
        title: `Turn on “${flow.name.trim()}”?`,
        message: mode === "real"
          ? "Patients who buy a matching product from today start the flow and get the emails."
          : "Patients who buy a matching product from today start the flow, but every email comes to you, marked [Test], until you press Send to patients.\n\nUse Test with a patient to try the whole flow straight away.",
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
}