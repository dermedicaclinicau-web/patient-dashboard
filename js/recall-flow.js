// Recall settings → Flow (#/settings/recall/flow): what happens to a recall card, card by card.
// Saved in recall_settings/flow. Apps Script (Code.gs → recallFlowRun_) runs it every hour.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { searchPatients } from "./task-runner.js";
import {
  blankGroup, cleanGroup, groupProblem, describeGroup, ruleCount, newRule, mountRuleBuilder, loadProductNames, RECALL_RULE_KEYS,
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
import { normRecallSettings, recallTabsHtml } from "./recall-settings.js";
import { loadRecallEmailTemplates } from "./recall-emails.js";
import { fillDateTokens } from "./date-tokens.js";

const MAX_STEPS = 40;
let WHO_CACHE = null;   // the last "Who's in the flow" answer, so reopening it is instant
const MAX_DEPTH = 3;
const STOP_LINE = "Reply STOP to opt out.";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  sms: ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  mail: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
  branch: ic('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10"/><path d="M18 11c0 4-6 3-12 6"/>'),
  phone: ic('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  repeat: ic('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  stop: ic('<circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>'),
  bolt: ic('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  users: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>'),
  plus: ic('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  trash: ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  up: ic('<polyline points="18 15 12 9 6 15"/>'),
  down: ic('<polyline points="6 9 12 15 18 9"/>'),
};

const TYPES = {
  text: { label: "Send a text", short: "Text", icon: "sms", tone: "is-patient" },
  email: { label: "Send an email", short: "Email", icon: "mail", tone: "is-patient" },
  wait: { label: "Wait", short: "Wait", icon: "clock", tone: "" },
  branch: { label: "If / else", short: "If / else", icon: "branch", tone: "is-branch" },
  team: { label: "Give to the recall team", short: "Recall team", icon: "phone", tone: "is-staff" },
  cycle: { label: "Try again later", short: "Try again", icon: "repeat", tone: "" },
  end: { label: "End recall", short: "End", icon: "stop", tone: "" },
};
const ADDABLE = Object.keys(TYPES);
const TERMINAL = new Set(["cycle", "end"]);   // nothing comes after these
const WAIT_UNITS = [["days", "days", 365], ["weeks", "weeks", 52], ["months", "months", 12]];
const CYCLE_UNITS = [["weeks", "weeks", 52], ["months", "months", 24]];
const WHO = [["turn", "Shared in turn (the recall team)"], ["last", "The clinician they last saw"], ["person", "A chosen person"]];
const TRIES = [[0, "Never: until it's booked or stopped"], [1, "After 1 call without a booking"], [2, "After 2 calls"],
  [3, "After 3 calls"], [4, "After 4 calls"], [5, "After 5 calls"]];
const TEAM_DAYS = [[0, "No time limit"], [3, "After 3 days"], [7, "After 7 days"], [14, "After 14 days"], [21, "After 21 days"], [30, "After 30 days"]];
const WITHIN = [[7, "Became due in the last 7 days"], [14, "Became due in the last 14 days"], [30, "Became due in the last 30 days"],
  [90, "Became due in the last 90 days"], [0, "Everyone waiting, most recently due first"]];
const DAILY = [[10, "10"], [25, "25"], [50, "50"], [100, "100"], [200, "200"]];
const MAXES = [[1, "1 time"], [2, "2 times"], [3, "3 times"], [4, "4 times"], [5, "5 times"]];
const TOKENS = ["First name", "Full name", "Treatment", "Main treatment", "Months", "Due date", "Last visit", "Last seen with", "Clinic phone"];
const QUIET = [[0, "None"], [7, "7 days"], [14, "14 days"], [30, "30 days"], [60, "60 days"]];
// Every treatment, in priority order: the saved order first, then any new ones in Treatments order
const cleanPriority = (list, set) => {
  const keys = ((set && set.categories) || []).map((c) => c.key);
  const out = (Array.isArray(list) ? list : []).map(String).filter((k, i, a) => keys.includes(k) && a.indexOf(k) === i);
  keys.forEach((k) => { if (!out.includes(k)) out.push(k); });
  return out;
};

/* ===================== Cards ===================== */

const newId = () => "s_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
function blank(type) {
  const cfg = type === "text" ? { message: "" }
    : type === "email" ? { subject: "", body: "" }
    : type === "wait" ? { num: 7, unit: "days", reply: true }
    : type === "branch" ? { rules: blankGroup(), yes: [], no: [] }
    : type === "team" ? { who: "turn", personId: "", tries: 3, days: 14 }
    : type === "cycle" ? { num: 3, unit: "months", max: 2, reason: "No response" }
    : { reason: "No response" };
  return { id: newId(), type, cfg };
}
function cleanSteps(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && TYPES[s.type]).map((s) => {
    const b = blank(s.type);
    const cfg = { ...b.cfg, ...(s.cfg || {}) };
    if (s.type === "branch") { cfg.yes = cleanSteps(cfg.yes); cfg.no = cleanSteps(cfg.no); cfg.rules = cleanGroup(cfg.rules); }
    delete cfg.html;   // made again on every save
    return { id: String(s.id || b.id), type: s.type, cfg };
  });
}
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
const count = (list) => { let n = 0; walk(list || [], () => n++); return n; };
const label = (pairs, v) => (pairs.find((p) => String(p[0]) === String(v)) || [])[1] || "";
const unitWord = (num, unit) => (Number(num) === 1 ? unit.replace(/s$/, "") : unit);
const plainText = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();

function summary(s) {
  const c = s.cfg;
  if (s.type === "text") return c.message.trim() ? c.message.trim().slice(0, 70) : "No message yet";
  if (s.type === "email") return c.subject.trim() || "No subject yet";
  if (s.type === "wait") return `${Number(c.num) || 0} ${unitWord(c.num, c.unit)}${c.reply ? ", or until they reply" : ""}`;
  if (s.type === "branch") return describeGroup(c.rules);
  if (s.type === "team") {
    const on = [Number(c.tries) ? `${c.tries} call${Number(c.tries) === 1 ? "" : "s"}` : "", Number(c.days) ? `${c.days} days` : ""].filter(Boolean);
    return `${c.who === "last" ? "Clinician they last saw" : c.who === "person" ? "A chosen person" : "Shared in turn"}${on.length ? ` · moves on after ${on.join(" or ")}` : ""}`;
  }
  if (s.type === "cycle") return `In ${Number(c.num) || 0} ${unitWord(c.num, c.unit)}, up to ${c.max} time${Number(c.max) === 1 ? "" : "s"}`;
  return `Closes it: ${c.reason || "No response"}`;
}
function stepProblems(s, depth) {
  const c = s.cfg;
  const out = [];
  if (s.type === "text" && !c.message.trim()) out.push("Write the message");
  if (s.type === "email") {
    if (!c.subject.trim()) out.push("Add a subject");
    if (!plainText(c.body)) out.push("Write the message");
  }
  if (s.type === "wait") {
    const max = (WAIT_UNITS.find((u) => u[0] === c.unit) || WAIT_UNITS[0])[2];
    const n = Number(c.num);
    if (!Number.isInteger(n) || n < 1 || n > max) out.push(`Choose 1 to ${max} ${c.unit}`);
  }
  if (s.type === "branch") {
    if (depth > MAX_DEPTH) out.push(`If / else can only go ${MAX_DEPTH} deep`);
    const p = groupProblem(c.rules, true);
    if (p) out.push(p);
  }
  if (s.type === "team" && c.who === "person" && !c.personId) out.push("Choose the person");
  if (s.type === "cycle") {
    const max = (CYCLE_UNITS.find((u) => u[0] === c.unit) || CYCLE_UNITS[1])[2];
    const n = Number(c.num);
    if (!Number.isInteger(n) || n < 1 || n > max) out.push(`Choose 1 to ${max} ${c.unit}`);
  }
  if ((s.type === "cycle" || s.type === "end") && !String(c.reason || "").trim()) out.push("Add the reason it closes with");
  return out;
}
function flowProblems(flow) {
  const out = [];
  const tp = groupProblem(flow.trigger.rules, false);
  if (tp) out.push(`Start rules: ${tp}.`);
  const sp = groupProblem(flow.stop.rules, false);
  if (sp) out.push(`Stop rules: ${sp}.`);
  if (!flow.steps.length) out.push("Add at least one card under the trigger.");
  if (count(flow.steps) > MAX_STEPS) out.push(`The flow can have up to ${MAX_STEPS} cards.`);
  let n = 0;
  walk(flow.steps, (s, depth) => {
    n++;
    const p = stepProblems(s, depth);
    if (p.length) out.push(`Card ${n} (${TYPES[s.type].short}): ${p[0]}.`);
  });
  return out;
}

/* ===================== The default flow ===================== */

function defaultFlow(set) {
  const card = (type, cfg) => ({ id: newId(), type, cfg: { ...blank(type).cfg, ...cfg } });
  const p = (...lines) => lines.map((l) => `<p>${l}</p>`).join("");
  const replied = () => ({ match: "all", rules: [newRule("rc.replied")] });
  return {
    on: false,
    trigger: { rules: blankGroup(), withinDays: 7, dailyMax: 25, quietDays: 14, priority: cleanPriority([], set) },
    stop: { rules: blankGroup() },
    style: { background: EMAIL_BACKGROUNDS[0], accent: EMAIL_ACCENTS[0], width: 600, logo: true, footer: true },
    steps: [
      card("text", { message: (set && set.sms && set.sms.template) || "Hi {First name}, it's Dermedica. It's been about {Months} months since your {Treatment}, so you're due for your next one. Reply YES and we'll call you to book." }),
      card("wait", { num: 7, unit: "days", reply: true }),
      card("branch", {
        rules: replied(),
        yes: [card("team", { who: "turn", tries: 0, days: 0 })],
        no: [
          card("email", { subject: "Time for your next {Treatment}?", body: p(
            "Hi {First name},",
            "It's been about {Months} months since your last {Treatment} with {Last seen with}, so you're due for your next one.",
            "To book, reply to this email or call us on {Clinic phone}. We'd love to see you again.",
            "Kind regards,<br>The Dermedica team") }),
          card("wait", { num: 7, unit: "days", reply: true }),
          card("team", { who: "turn", tries: 3, days: 14 }),
          card("cycle", { num: 3, unit: "months", max: 2, reason: "No response" }),
        ],
      }),
    ],
  };
}

function snapshot(d, set) {
  const base = defaultFlow(set);
  if (!d) return base;
  const t = d.trigger || {}, st = d.stop || {};
  return {
    on: d.on === true,
    trigger: { withinDays: 7, dailyMax: 25, quietDays: 14, ...t, rules: cleanGroup(t.rules), priority: cleanPriority(t.priority, set) },
    stop: { rules: cleanGroup(st.rules) },
    style: { ...base.style, ...(d.style || {}) },
    steps: cleanSteps(d.steps),
  };
}
function toDoc(f, lh) {
  const steps = JSON.parse(JSON.stringify(f.steps));
  if (lh) {
    const c = clinicDetails(lh);
    const vals = new Map([["clinic email", c.email || ""], ["clinic address", c.address || ""]]);
    walk(steps, (s) => {
      if (s.type === "email") s.cfg.html = emailShell(fillTemplateHtml(s.cfg.body || "", vals), f.style, { clinic: c, hasLogo: !!lh.logo });
    });
  }
  return JSON.parse(JSON.stringify({ on: !!f.on, trigger: f.trigger, stop: f.stop, steps, style: f.style }));
}

/* ===================== Page ===================== */

export async function mountRecallFlow(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide ef-page";
  root.innerHTML = `<a class="back-link" href="#/recall">← Recall</a>${recallTabsHtml("flow")}
    <div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);

  let settings, flow;
  try {
    const [a, b] = await Promise.all([getDoc(doc(db, "recall_settings", "config")), getDoc(doc(db, "recall_settings", "flow"))]);
    settings = normRecallSettings(a.exists() ? a.data() : {});
    flow = snapshot(b.exists() ? b.data() : null, settings);
  } catch (err) {
    console.error("Recall flow load failed:", err);
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="#/recall">← Recall</a>${recallTabsHtml("flow")}
      <div class="state error"><strong>Couldn't open the recall flow</strong>${err && err.code === "permission-denied"
        ? "Check Recall settings access in Staff, and that the Firestore rules are published." : "Check your connection and try again."}</div>`;
    return;
  }
  if (!root.isConnected) return;

  const categoryNames = settings.categories.map((c) => c.key);
  let sel = null, menuAt = null;
  let letterhead = null, staffList = null, staffError = false, productNames = [];
  let editor = null, lastText = null;
  let dirty = false, saving = false, saveTimer = null;
  const lhReady = getLetterhead().then((lh) => { letterhead = lh || {}; }).catch(() => { letterhead = {}; });
  let emailTpls = [];
  loadRecallEmailTemplates().then((x) => { emailTpls = x.templates; }).catch((err) => console.warn("Email templates not loaded:", err));

  root.innerHTML = `
    <a class="back-link" href="#/recall">← Recall</a>
    ${recallTabsHtml("flow")}
    <div class="ff-wrap tb-wrap ef-wrap">
      <div class="ff-bar" role="region" aria-label="Flow actions">
        <div class="ff-bar-inner">
          <div class="ff-bar-title"><strong>Recall flow</strong>
            <span><span data-role="sub"></span> · <span data-role="state">All changes saved</span></span></div>
          <span class="tb-pill" data-role="pill"></span>
          <div class="ff-bar-actions">
            <button type="button" class="ff-btn" data-act="who">${I.users}<span>Who's in the flow</span></button>
            <button type="button" class="ff-btn" data-act="test">${I.mail}<span>Test with a patient</span></button>
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
  const world = $('[data-role="world"]');
  const zoomLbl = $('[data-role="zoom"]');
  const stateEl = $('[data-role="state"]');
  const msgEl = $('[data-role="msg"]');
  const liveBtn = $('[data-act="live"]');

  /* ---------- Saving ---------- */
  function setState(s) {
    stateEl.textContent = s === "saving" ? "Saving…" : s === "dirty" ? "Unsaved changes" : s === "error" ? "Couldn't save. Retrying…" : "All changes saved";
  }
  async function write(extra = {}) {
    await lhReady;
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) throw new Error("Your session has ended. Log in again.");
    await setDoc(doc(db, "recall_settings", "flow"), {
      ...toDoc(flow, letterhead), ...extra,
      updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120), updatedByUid: uid,
    });
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
      await write();
      setState(dirty ? "dirty" : "saved");
    } catch (err) {
      console.error("Recall flow save failed:", err);
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

  function renderBar() {
    const n = count(flow.steps);
    $('[data-role="sub"]').textContent = `Starts when a recall card becomes due · ${n} card${n === 1 ? "" : "s"}`;
    const pill = $('[data-role="pill"]');
    pill.className = "tb-pill " + (flow.on ? "is-live" : "is-draft");
    pill.textContent = flow.on ? "On" : "Off";
    liveBtn.querySelector("span").textContent = flow.on ? "Turn off" : "Turn on";
    liveBtn.classList.toggle("is-primary", !flow.on);
  }

  /* ---------- The canvas (the same layout as Email flows) ---------- */
  const CW = 260, CH = 88, GAP = 64, HG = 48, SPLIT = 24, LBL = 64, PAD = 60;
  const view = { x: 0, y: 0, z: 1, ready: false };
  let pos = new Map();
  function measure(list) {
    let w = CW;
    for (const s of list) if (s.type === "branch") w = Math.max(w, measure(s.cfg.yes) + HG + measure(s.cfg.no));
    return w;
  }
  function layout() {
    const L = { cards: [], plus: [], labels: [], d: "" };
    const line = (d) => { L.d += d; };
    const opensEnd = (list) => !list.length || !TERMINAL.has(list[list.length - 1].type);
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
        if (TERMINAL.has(s.type)) { L.plus.pop(); L.plus.push({ key, x: cx, y: py }); return bot; }
        if (s.type !== "branch") { prev = bot; key = "after:" + s.id; continue; }
        const wy = measure(s.cfg.yes), wn = measure(s.cfg.no), total = wy + HG + wn;
        const lx = cx - total / 2 + wy / 2, rx = cx + total / 2 - wn / 2;
        const sy = bot + SPLIT, cy = bot + LBL;
        line(`M${cx} ${bot}V${sy}M${lx} ${sy}H${rx}M${lx} ${sy}V${cy}M${rx} ${sy}V${cy}`);
        L.labels.push({ yes: true, x: lx, y: (sy + cy) / 2 }, { yes: false, x: rx, y: (sy + cy) / 2 });
        const ey = place(s.cfg.yes, lx, cy, `start:${s.id}:yes`, depth + 1);
        const en = place(s.cfg.no, rx, cy, `start:${s.id}:no`, depth + 1);
        if (i === items.length - 1) return Math.max(ey, en);
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
    const when = Number(t.withinDays) ? `due in the last ${t.withinDays} days` : "everyone waiting";
    return `A recall card becomes due (${when}, ${t.dailyMax} a day)${r ? ` · ${r} rule${r === 1 ? "" : "s"}` : ""}`;
  }
  function cardHtml(s, depth, x, y) {
    const t = TYPES[s.type];
    const probs = stepProblems(s, depth);
    const on = sel === s.id;
    const full = summary(s);
    return `<div class="ef-card is-t-${s.type}${on ? " is-sel" : ""}${probs.length ? " is-bad" : ""}"
      style="left:${x}px;top:${y}px;width:${CW}px;height:${CH}px" data-pick="${esc(s.id)}" tabindex="0" role="button" aria-pressed="${on}" title="${esc(full)}">
      <span class="ef-ico ${t.tone}">${I[t.icon]}</span>
      <span class="ef-card-main"><small>${esc(t.label)}</small><strong>${esc(full)}</strong>
        ${probs.length ? `<em class="ef-card-warn">${esc(probs[0])}</em>` : ""}</span></div>`;
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
        <span class="ef-ico is-trigger">${I.bolt}</span>
        <span class="ef-card-main"><small>When this happens</small><strong>${esc(triggerText())}</strong></span></div>
      ${L.cards.map((c) => cardHtml(c.s, c.depth, c.x, c.y)).join("")}
      ${L.labels.map((b) => `<span class="ef-bl${b.yes ? " is-yes" : ""}" style="left:${b.x}px;top:${b.y}px">${b.yes ? "Yes" : "No"}</span>`).join("")}
      ${L.plus.map((p) => `<button type="button" class="ef-plus${p.key === menuAt ? " is-open" : ""}" style="left:${p.x}px;top:${p.y}px"
        data-add="${esc(p.key)}" aria-label="Add a card here" aria-expanded="${p.key === menuAt}">${I.plus}</button>`).join("")}
      ${menu ? `<div class="ef-menu" style="left:${menu.x}px;top:${menu.y + 22}px">${ADDABLE.map((t) =>
        `<button type="button" data-ins="${esc(menu.key)}" data-type="${t}">${I[TYPES[t].icon]}<span>${esc(TYPES[t].short)}</span></button>`).join("")}</div>` : ""}`;
    if (!view.ready && canvas.clientWidth) { fit(true); view.ready = true; }
    applyView();
  }

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
  function fit(widthOnly) {
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const w = parseFloat(world.style.width) || 1, h = parseFloat(world.style.height) || 1;
    view.z = clampZ(Math.min(1, (vw - 24) / w, widthOnly ? 1 : (vh - 24) / h));
    view.x = (vw - w * view.z) / 2;
    view.y = widthOnly ? 0 : (vh - h * view.z) / 2;
    applyView();
  }
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
    if (ptrs.size === 2) {
      const before = spread();
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...ptrs.values()];
      const r = canvas.getBoundingClientRect();
      zoomAt(spread() / before, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    } else {
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
    if (e.ctrlKey || e.metaKey) {
      const r = canvas.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    } else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
  }, { passive: false });

  /* ---------- Adding cards ---------- */
  function insertAt(key, type) {
    if (count(flow.steps) >= MAX_STEPS) { showToast(`The flow can have up to ${MAX_STEPS} cards.`); return; }
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
    if (TERMINAL.has(type) && idx < list.length) { showToast(`${TYPES[type].short} goes at the bottom of a path. Add it after the last card.`); return; }
    const s = blank(type);
    if (type === "text") s.cfg.message = settings.sms.template || "";
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
      if (last && (TERMINAL.has(last.type) || last.type === "branch")) {
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
    if (TERMINAL.has(cur.type)) { showToast(`Nothing can go after ${TYPES[cur.type].short}.`); return; }
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
  const chips = () => `<div class="fe-chiprow">${TOKENS.map((t) => `<button type="button" class="fe-ins" data-token="${esc(t)}">{${esc(t)}}</button>`).join("")}</div>`;
  const editorGroups = () => [{ title: "Recall", tokens: TOKENS.map((name) => ({ name, kind: "", hint: "" })) }];
  const ruleOpts = (empty) => ({ onChange: ruleChange, names: productNames, only: RECALL_RULE_KEYS, lists: { "rc.category": categoryNames }, empty });

  function sampleVals() {
    const cat = settings.categories.find((c) => c.on) || settings.categories[0];
    const c = clinicDetails(letterhead);
    return new Map([
      ["first name", "Sarah"], ["full name", "Sarah Citizen"], ["treatment", (cat && cat.smsName) || "treatment"],
      ["main treatment", (cat && cat.smsName) || "treatment"],
      ["months", String((cat && cat.months) || 4)], ["due date", "14 October 2026"], ["last visit", "14 June 2026"],
      ["last seen with", "Dr Teh"], ["clinic phone", settings.sms.phone || c.phone || ""],
      ["clinic email", c.email || ""], ["clinic address", c.address || ""],
    ]);
  }
  function smsPreview(text) {
    let t = fillTemplate(fillDateTokens(String(text || "")), sampleVals()).replace(/\s+/g, " ").trim();
    if (!/reply\s+stop/i.test(t)) t += `${t ? " " : ""}${STOP_LINE}`;
    const parts = t.length <= 160 ? 1 : Math.ceil(t.length / 153);
    return `<strong>Preview:</strong> ${esc(t)}<br><small>${t.length} characters · ${parts} text${parts === 1 ? "" : "s"} each</small>`;
  }

  function flowSettingsHtml() {
    const t = flow.trigger, s = flow.style;
    const sw = (key, list) => `<div class="tb-swatches">${list.map((c) => `
      <label class="tb-sw" title="${c}"><input type="radio" name="rf-${key}" data-style="${key}" value="${c}"${s[key] === c ? " checked" : ""} />
        <span style="background:${c}"></span></label>`).join("")}</div>`;
    return `
      <div class="ef-side-head"><span class="ef-ico is-trigger">${I.bolt}</span>
        <div><strong>Flow settings</strong><small>Click a card on the left to set it up</small></div></div>
      <section class="ef-sec"><h4>Who starts the flow</h4>
        <p class="tb-info">Checked every hour. A recall card starts the flow when it becomes due, if nobody has picked it up yet.</p>
        <label class="tb-field"><span>Which cards</span><select class="fb-select" data-f="trigger.withinDays">${opt(WITHIN, t.withinDays)}</select></label>
        <label class="tb-field"><span>Start at most this many a day</span><select class="fb-select" data-f="trigger.dailyMax">${opt(DAILY, t.dailyMax)}</select>
          <small class="muted">The rest start the next day, before anyone newer.</small></label>
        <div class="tb-field"><span>Only start for… <small>(optional)</small></span><div data-role="trig-rules"></div></div>
      </section>
      <section class="ef-sec"><h4>Due for more than one treatment</h4>
        <p class="tb-info">They get one flow, for the treatment highest on this list. Their other treatments join it: {Treatment} names
          them all (e.g. "wrinkle relaxer and skin treatment"), and nobody calls about them separately. If the main one is booked, the
          others wait. If the flow closes it, or they reply STOP, the others close too. Otherwise they start the flow after the quiet time.</p>
        <ol class="rf-pri">${t.priority.map((k, i) => `<li>
          <span class="rf-pri-n">${i + 1}</span><span class="rf-pri-name">${esc(k)}</span>
          <button type="button" class="ib-tool" data-pri="${i}:-1"${i === 0 ? " disabled" : ""} aria-label="Move ${esc(k)} up" title="Move up">${I.up}</button>
          <button type="button" class="ib-tool" data-pri="${i}:1"${i === t.priority.length - 1 ? " disabled" : ""} aria-label="Move ${esc(k)} down" title="Move down">${I.down}</button>
        </li>`).join("")}</ol>
        <label class="tb-field"><span>Quiet time between recall messages to the same patient</span>
          <select class="fb-select" data-f="trigger.quietDays">${opt(QUIET, t.quietDays)}</select>
          <small class="muted">Counts texts and emails from any recall, including ones staff send from a card.</small></label>
      </section>
      <section class="ef-sec"><h4>Calls already given out</h4>
        <p class="tb-info">Cards shared out before the flow was turned on stay in people's My calls, and the flow doesn't touch them.
          Move them into the flow and they start it before newly due patients, within the daily limit.</p>
        <label class="fe-check"><input type="checkbox" data-role="adoptAll" /> Also move cards that already have a call logged</label>
        <button type="button" class="lh-btn" data-act="adopt">Move calls into the flow…</button>
      </section>
      <section class="ef-sec"><h4>Always</h4>
        <p class="tb-info">Booked, came in, or replied STOP: the flow stops. If someone picks up the card or logs a call, they take over and the flow stops.
          Texts and emails go between 9 am and 6 pm, and never to anyone on the do-not-contact list. When the flow finishes, the card goes to the recall team as usual.</p>
      </section>
      <section class="ef-sec"><h4>Stop the flow when… <small>(checked before every text and email)</small></h4>
        <div data-role="stop-rules"></div>
        <small class="muted">The card then goes to the recall team as usual.</small>
      </section>
      <section class="ef-sec"><h4>Email design</h4>
        <div class="tb-field"><span>Background</span>${sw("background", EMAIL_BACKGROUNDS)}</div>
        <div class="tb-field"><span>Accent</span>${sw("accent", EMAIL_ACCENTS)}</div>
        <label class="fe-check"><input type="checkbox" data-style="logo"${s.logo ? " checked" : ""} /> Clinic logo at the top</label>
        <label class="fe-check"><input type="checkbox" data-style="footer"${s.footer ? " checked" : ""} /> Clinic details at the bottom</label>
      </section>`;
  }

  function stepBodyHtml(s) {
    const c = s.cfg;
    if (s.type === "text") {
      return `<section class="ef-sec">
        <label class="tb-field"><span>Message</span><textarea class="fe-input" data-k="message" data-tokens rows="5" maxlength="560">${esc(c.message)}</textarea></label>
        ${chips()}
        <p class="tb-info" data-role="smsprev">${smsPreview(c.message)}</p>
        <small class="muted">"${STOP_LINE}" is always added. Skipped if they have no mobile. Replies go onto the card.</small>
      </section>`;
    }
    if (s.type === "email") {
      return `<section class="ef-sec">
          ${emailTpls.length ? `<label class="tb-field"><span>Start from a template</span>
            <select class="fb-select" data-role="tpl"><option value="">Choose a template…</option>${emailTpls.map((t) =>
              `<option value="${esc(t.id)}">${t.isDefault ? "★ " : ""}${esc(t.name)}</option>`).join("")}</select></label>` : ""}
          <label class="tb-field"><span>Subject</span><input class="fe-input" data-k="subject" data-tokens maxlength="200" value="${esc(c.subject)}" /></label>
          <div class="tb-field"><span>Message</span><div data-role="editor"></div></div>
          ${chips()}
          <small class="muted">Skipped if they have no email address. An unsubscribe link is always added at the bottom.</small>
        </section>
        <section class="ef-sec"><h4>Preview <small>(with example details)</small></h4><div data-role="prev"></div></section>`;
    }
    if (s.type === "wait") {
      return `<section class="ef-sec">
        <div class="tb-field"><span>Wait for</span><div class="fe-num ef-wait">
          <input class="fe-input" type="number" min="1" max="365" step="1" data-k="num" value="${esc(c.num)}" />
          <select class="fb-select" data-k="unit">${opt(WAIT_UNITS, c.unit)}</select></div></div>
        <label class="fe-check"><input type="checkbox" data-k="reply"${c.reply ? " checked" : ""} /> Move on early if they reply to a text</label>
        <p class="tb-info">A reply moves the card on at the next hourly check. Booking always ends the flow.</p>
      </section>`;
    }
    if (s.type === "branch") {
      return `<section class="ef-sec"><div class="tb-field"><span>Check</span><div data-role="branch-rules"></div></div>
        <p class="tb-info">Cards that match go down <strong>Yes</strong>. Everything else goes down <strong>No</strong>.</p></section>`;
    }
    if (s.type === "team") {
      const people = staffList === null ? `<p class="tb-none">${staffError ? "Couldn't load the staff list." : "Loading staff…"}</p>`
        : `<select class="fb-select" data-k="personId"><option value="">Choose a person</option>${staffList.map((x) =>
          `<option value="${esc(x.id)}"${x.id === c.personId ? " selected" : ""}>${esc(x.name)}${x.role ? ` (${esc(x.role)})` : ""}</option>`).join("")}</select>`;
      return `<section class="ef-sec">
        <label class="tb-field"><span>Give it to</span><select class="fb-select" data-k="who" data-rerender>${opt(WHO, c.who)}</select></label>
        ${c.who === "person" ? `<div class="tb-field"><span>Person</span>${people}</div>` : ""}
        ${c.who === "last" ? '<small class="muted">Matched by name. If nobody matches, it\'s shared in turn.</small>' : ""}
        <label class="tb-field"><span>Move on to the next card</span><select class="fb-select" data-k="tries">${opt(TRIES, c.tries)}</select></label>
        <label class="tb-field"><span>…or after this long with the team</span><select class="fb-select" data-k="days">${opt(TEAM_DAYS, c.days)}</select></label>
        <p class="tb-info">It goes to their My calls. Booking or stopping it ends the flow. A call-back date pauses the clock until then.</p>
      </section>`;
    }
    if (s.type === "cycle") {
      return `<section class="ef-sec">
        <div class="tb-field"><span>Start the flow again in</span><div class="fe-num ef-wait">
          <input class="fe-input" type="number" min="1" max="24" step="1" data-k="num" value="${esc(c.num)}" />
          <select class="fb-select" data-k="unit">${opt(CYCLE_UNITS, c.unit)}</select></div></div>
        <label class="tb-field"><span>Up to</span><select class="fb-select" data-k="max">${opt(MAXES, c.max)}</select></label>
        <label class="tb-field"><span>Then close it as</span><input class="fe-input" data-k="reason" maxlength="60" value="${esc(c.reason)}" /></label>
        <p class="tb-info">Meanwhile the card waits in Call back. Use "Round of the flow" in an If / else to do something different the second time round.</p>
      </section>`;
    }
    return `<section class="ef-sec">
      <label class="tb-field"><span>Close it as</span><input class="fe-input" data-k="reason" maxlength="60" value="${esc(c.reason)}" /></label>
      <p class="tb-info">They're recalled again from their next treatment visit.</p></section>`;
  }

  const selStep = () => {
    if (!sel || sel === "trigger") return null;
    const r = find(flow.steps, sel);
    return r ? r.list[r.i] : null;
  };

  function renderSide() {
    editor = null;
    lastText = null;
    const r = sel && sel !== "trigger" ? find(flow.steps, sel) : null;
    if (!r) {
      if (sel !== "trigger") sel = null;
      side.innerHTML = flowSettingsHtml();
      mountRuleBuilder(side.querySelector('[data-role="trig-rules"]'), flow.trigger.rules, ruleOpts("Every card that becomes due starts the flow."));
      mountRuleBuilder(side.querySelector('[data-role="stop-rules"]'), flow.stop.rules, ruleOpts("No extra stop rules."));
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
    if (s.type === "branch") {
      mountRuleBuilder(side.querySelector('[data-role="branch-rules"]'), s.cfg.rules, ruleOpts("Add a rule to decide who goes down Yes."));
    }
    if (s.type === "team" && s.cfg.who === "person") loadStaff();
  }
  function renderPreview() {
    const box = side.querySelector('[data-role="prev"]');
    const s = selStep();
    if (!box || !s || s.type !== "email") return;
    const vals = sampleVals();
    box.innerHTML = `<div class="tb-mail">
        <div class="tb-mail-row"><span>To</span><span>Sarah Citizen &lt;sarah@example.com&gt;</span></div>
        <div class="tb-mail-row"><span>Subject</span><strong>${subjectHtml(fillTemplate(fillDateTokens(s.cfg.subject), vals)) || "<em>No subject yet</em>"}</strong></div>
        <div class="tb-mail-body tb-mail-shell" data-role="shell">${emailShell(fillTemplateHtml(fillDateTokens(s.cfg.body || ""), vals), flow.style,
          { clinic: clinicDetails(letterhead), hasLogo: !!(letterhead && letterhead.logo) })}</div></div>`;
    hydrateRichImages(box.querySelector('[data-role="shell"]'), { logo: (letterhead && letterhead.logo) || "" });
  }
  function loadStaff() {
    if (staffList !== null || staffError) return;
    fetchStaffList()
      .then((list) => { staffList = list; })
      .catch((err) => { console.warn("Staff list failed:", err); staffError = true; })
      .finally(() => { if (root.isConnected && !editor) renderSide(); });
  }

  const NUM_K = ["num", "tries", "days", "max"];
  side.addEventListener("focusin", (e) => { if (e.target.matches("[data-tokens]")) lastText = e.target; });
  side.addEventListener("mousedown", (e) => { if (e.target.closest("[data-token]")) e.preventDefault(); });
  side.addEventListener("input", (e) => {
    const el = e.target;
    if (el.closest(".re") || el.closest(".fr")) return;   // the editor and rule builders report their own changes
    if (el.dataset.f) {
      const [a, b] = el.dataset.f.split(".");
      flow[a][b] = Number(el.value);
      changed();
      renderCanvas();
      return;
    }
    if (el.dataset.style !== undefined) {
      flow.style[el.dataset.style] = el.type === "checkbox" ? el.checked : el.value;
      changed();
      return;
    }
    const s = selStep();
    if (s && s.type === "email" && el.dataset.role === "tpl" && el.value) {
      const t = emailTpls.find((x) => x.id === el.value);
      if (!t) return;
      s.cfg.subject = t.subject;
      s.cfg.body = t.body;
      changed(); renderCanvas(); renderSide();
      return;
    }
    if (!s || !el.dataset.k) return;
    const k = el.dataset.k;
    s.cfg[k] = el.type === "checkbox" ? el.checked : NUM_K.includes(k) ? Number(el.value) : el.value;
    changed();
    renderCanvas();
    if (el.dataset.rerender !== undefined) renderSide();
    else if (s.type === "text") { const p = side.querySelector('[data-role="smsprev"]'); if (p) p.innerHTML = smsPreview(s.cfg.message); }
    else if (s.type === "email") renderPreview();
  });

  side.addEventListener("click", async (e) => {
    const ad = e.target.closest('[data-act="adopt"]');
    if (ad) { adoptCalls(ad); return; }
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
      } else if (editor) editor.insertToken(name);
      else showToast("Click in the message first.");
      return;
    }
    const pr = e.target.closest("[data-pri]");
    if (pr) {
      const [i, dir] = pr.dataset.pri.split(":").map(Number);
      const p = flow.trigger.priority;
      const j = i + dir;
      if (j < 0 || j >= p.length) return;
      [p[i], p[j]] = [p[j], p[i]];
      changed();
      renderSide();
      const again = side.querySelector(`[data-pri="${j}:${dir}"]`) || side.querySelector(`[data-pri="${j}:${-dir}"]`);
      if (again) again.focus();
      return;
    }
    if (e.target.closest('[data-act="close"]')) { sel = null; renderCanvas(); renderSide(); return; }
    const mv = e.target.closest("[data-move]");
    if (mv && sel) {
      const r = find(flow.steps, sel);
      if (!r) return;
      const j = r.i + Number(mv.dataset.move);
      if (j < 0 || j >= r.list.length) return;
      if (TERMINAL.has(r.list[r.i].type) || TERMINAL.has(r.list[j].type)) { showToast("Try again and End always stay at the bottom of their path."); return; }
      [r.list[r.i], r.list[j]] = [r.list[j], r.list[r.i]];
      changed(); renderCanvas(); renderSide();
      return;
    }
    if (e.target.closest('[data-act="remove"]') && sel) {
      const r = find(flow.steps, sel);
      if (!r) return;
      const s = r.list[r.i];
      const inside = s.type === "branch" ? count(s.cfg.yes) + count(s.cfg.no) : 0;
      if (inside && !(await confirmDialog({ title: "Remove this If / else?",
        message: `The ${inside} card${inside === 1 ? "" : "s"} inside Yes and No will be removed too.`, confirmLabel: "Remove", tone: "danger" }))) return;
      r.list.splice(r.i, 1);
      sel = null;
      changed(); renderCanvas(); renderSide();
    }
  });

  /* ---------- Test with a patient ---------- */
  function testDialog() {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ef-test-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Test with a patient</h3>
          <p>Runs the whole flow now with a patient's recall card. Waits are skipped. Emails come to you and texts to the mobile below, marked [Test]. Nothing goes to the patient and their card isn't changed.</p></div>
        <label class="lh-field" data-role="find"><span class="lh-label">Patient</span><input type="search" name="q" placeholder="Search by name" autocomplete="off" /></label>
        <div class="ef-test-hits" data-role="hits"></div>
        <div data-role="pick"></div>
        <label class="lh-field"><span class="lh-label">Treatment</span>
          <select class="fb-select" name="cat"><option value="">Their most recent recall</option>${settings.categories.filter((c) => c.on).map((c) =>
            `<option value="${esc(c.key)}">${esc(c.key)}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Your mobile, for the test texts <small>(optional)</small></span>
          <input type="tel" name="mobile" maxlength="20" placeholder="04…" /></label>
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
      if (h) { chosen = found[Number(h.dataset.hit)] || null; showPick(); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const problem = !chosen ? "Choose a patient." : flowProblems(flow)[0] || "";
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      runBtn.disabled = true;
      runBtn.textContent = "Running…";
      out.innerHTML = '<p class="tb-none">Running the flow. This can take up to a minute…</p>';
      try {
        await settle();
        const res = await callApi({ action: "recall", op: "flowTest", patientId: chosen.id,
          category: form.elements.cat.value, mobile: form.elements.mobile.value.trim() });
        if (res.problem) { out.innerHTML = ""; err.textContent = res.problem; err.hidden = false; }
        else {
          out.innerHTML = `<div class="tb-ready">${res.sent} test message${res.sent === 1 ? "" : "s"} sent (emails to ${esc(res.to)})</div>
            <ol class="ef-steps">${(res.steps || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
        }
      } catch (ex) {
        console.error("Recall flow test failed:", ex);
        out.innerHTML = "";
        err.textContent = (ex && ex.detail) || "The test couldn't run. Check Apps Script → Executions.";
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

  /* ---------- Move calls given out before the flow into it ---------- */
  async function adoptCalls(btn) {
    const box = side.querySelector('[data-role="adoptAll"]');
    const all = !!(box && box.checked);
    const mode = all ? "all" : "untouched";
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Counting…";
    try {
      await settle();
      const d = await callApi({ action: "recall", op: "flowAdopt", mode, dryRun: true });
      if (d.problem) { showToast(d.problem); return; }
      if (!d.count) {
        showToast(d.withCalls
          ? `Nothing to move. ${d.withCalls} given-out card${d.withCalls === 1 ? " has" : "s have"} a call logged: tick the box to move ${d.withCalls === 1 ? "it" : "those"} too.`
          : "Nothing to move: no calls are given out.");
        return;
      }
      const per = Number(flow.trigger.dailyMax) || 25;
      const days = Math.ceil(d.count / per);
      const ok = await confirmDialog({
        title: `Move ${d.count} call${d.count === 1 ? "" : "s"} into the flow?`,
        message: `${d.byPerson.map((p) => `${p.name}: ${p.n}`).join("\n")}\n\n` +
          `They leave My calls now, and start the flow before newly due patients, up to ${per} a day` +
          `${days > 1 ? `, so all of them have started in about ${days} days` : ""}.` +
          `${!all && d.withCalls ? `\n\n${d.withCalls} with a call already logged stay where they are.` : ""}`,
        confirmLabel: "Move them", tone: "warning",
      });
      if (!ok) return;
      btn.textContent = "Moving…";
      const r = await callApi({ action: "recall", op: "flowAdopt", mode, dryRun: false });
      if (r.problem) { showToast(r.problem); return; }
      showToast(`${r.moved} moved into the flow. They start at the next hourly check.`);
    } catch (err) {
      console.error("Move calls into the flow failed:", err);
      showToast(err && err.code === "UNAUTHORIZED" ? "Your login has timed out. Log out and back in, then try again." : "Couldn't move them. Try again.");
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
    }
  }

  /* ---------- Who's in the flow ---------- */
  function whoDialog() {
    const kd = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
    const day = (k) => { const d = kd(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : ""; };
    const at = (ms) => (ms ? new Date(ms).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
    const age = (iso) => {
      const m = Math.round((Date.now() - new Date(iso || 0).getTime()) / 60000);
      return m < 1 ? "Checked just now" : m < 60 ? `Checked ${m} min ago` : `Checked ${Math.round(m / 60)} h ago`;
    };
    const TABS = [["next", "Starting next"], ["later", "Coming up"], ["inFlow", "In the flow now"],
      ["quiet", "Quiet time"], ["along", "Riding along"], ["nomatch", "Not starting"]];
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog rf-who";
    dlg.innerHTML = `
      <div class="rf-who-head">
        <div><h3>Who's in the flow</h3><p class="muted" data-role="sum">Checking the waiting cards…</p></div>
        <button type="button" class="lh-btn is-quiet" data-act="refresh">Refresh</button>
        <button type="button" class="lh-btn is-quiet" data-act="x" aria-label="Close">×</button>
      </div>
      <div class="rc-tabs rf-who-tabs" data-role="tabs" role="tablist"></div>
      <input type="search" class="fe-input rf-who-q" data-role="q" placeholder="Find a patient by name" aria-label="Find a patient" />
      <div class="rf-who-list" data-role="list"><div class="skeleton" style="height:220px;border-radius:12px"></div></div>`;
    const $d = (r) => dlg.querySelector(`[data-role="${r}"]`);
    let data = WHO_CACHE, tab = "next", q = "", loading = false;

    const what = (r) => `${esc(r.category)}${r.alsoDue && r.alsoDue.length ? ` + ${esc(r.alsoDue.join(", "))}` : ""}`;
    function line(r) {
      if (tab === "next") return `${what(r)} · due ${esc(day(r.dueDate))}${r.waited ? " · waiting since an earlier day" : ""}`;
      if (tab === "later") return `${what(r)} · due ${esc(day(r.dueDate))} · starts around <strong>${esc(day(r.day))}</strong>` +
        (r.unsure ? ' <span class="muted">(start rules checked on the day)</span>' : "");
      if (tab === "quiet") return `${what(r)} · can start from <strong>${esc(day(r.until))}</strong>`;
      if (tab === "along") return `${esc(r.category)} · ${r.already ? "with" : "joins"} their ${esc(r.joinedCat || "other")} recall`;
      if (tab === "nomatch") return `${what(r)} · doesn't match the start rules, so the recall team calls them as usual`;
      const sent = [r.texts ? `${r.texts} text${r.texts === 1 ? "" : "s"}` : "", r.emails ? `${r.emails} email${r.emails === 1 ? "" : "s"}` : ""]
        .filter(Boolean).join(", ");
      const st = r.state === "wait" ? `Waiting until ${at(r.at)}${r.next ? ` · then ${r.next}` : ""}`
        : r.state === "run" ? `${r.next || "Next card"} · ${r.at > Date.now() ? at(r.at) : "at the next check"}`
        : r.state === "team" ? `With ${r.with || "the recall team"}${r.next ? ` · then ${r.next}` : ""}`
        : `Trying again on ${day(r.on)} (round ${r.round + 1})`;
      return `${what(r)} · ${esc(st)}${sent ? ` · ${esc(sent)} sent` : ""}${r.replied ? ' <span class="rc-tag is-yes">Replied</span>' : ""}`;
    }
    function drawTabs() {
      $d("tabs").innerHTML = TABS.map(([k, l]) => {
        const n = data ? data[`${k}Count`] : null;
        return `<button type="button" class="rc-tab${tab === k ? " is-on" : ""}" data-tab="${k}" role="tab" aria-selected="${tab === k}">${esc(l)}${
          n != null ? ` <em>${Number(n).toLocaleString()}</em>` : ""}</button>`;
      }).join("");
    }
    function drawList() {
      if (!data) return;
      const all = data[tab] || [];
      const rows = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
      const total = data[`${tab}Count`] || 0;
      const empty = { next: "Nobody starts at the next check.", later: "Nobody else is waiting to start.",
        inFlow: "Nobody is in the flow yet.", quiet: "Nobody is waiting for quiet time.",
        along: "Nobody has a second treatment riding along.", nomatch: "Everyone checked matches the start rules." }[tab];
      $d("list").innerHTML = rows.length ? rows.map((r) => `<div class="rf-who-row">
          <span class="rc-av" aria-hidden="true">${esc((r.name.match(/\b[A-Za-z]/g) || ["?"]).slice(0, 2).join("").toUpperCase())}</span>
          <span class="rf-who-main">${r.patientId ? `<a href="#/patient/${encodeURIComponent(r.patientId)}">${esc(r.name || "Unknown patient")}</a>`
            : `<strong>${esc(r.name || "Unknown patient")}</strong>`}<small>${line({ ...r, next: r.next || "", with: r.with || "" })}</small></span>
          ${tab === "nomatch" || tab === "along" ? "" : `<button type="button" class="lh-btn is-quiet" data-skip="${esc(r.id)}" data-name="${esc(r.name)}">${
            tab === "inFlow" ? "Take out" : "Keep out"}</button>`}
        </div>`).join("") + (total > all.length ? `<p class="muted rf-who-more">Showing the first ${all.length} of ${total.toLocaleString()}.</p>` : "")
        : `<p class="rc-empty">${esc(q ? "Nobody here by that name." : empty)}</p>`;
    }
    function drawSum() {
      if (!data) return;
      const d = data;
      const parts = [];
      if (!d.on) parts.push("The flow is off, so nobody starts until you turn it on. This is who would.");
      parts.push(`${d.nextCount.toLocaleString()} start${d.nextCount === 1 ? "s" : ""} at the next check (${d.left} of ${d.cap} left today).`);
      if (d.laterCount) parts.push(`${d.laterCount.toLocaleString()} more after that, about ${d.cap} a day: the last around ${day(d.lastDay)}.`);
      parts.push(`${d.inFlowCount.toLocaleString()} in the flow now.`);
      parts.push(loading ? `${age(d.checkedAt)} · updating…` : `${age(d.checkedAt)}.`);
      $d("sum").textContent = parts.join(" ");
    }
    const drawAll = () => { drawSum(); drawTabs(); drawList(); };

    async function load() {
      if (loading) return;
      loading = true;
      const btn = dlg.querySelector('[data-act="refresh"]');
      btn.disabled = true;
      if (data) drawSum();
      else $d("list").innerHTML = '<div class="skeleton" style="height:220px;border-radius:12px"></div>';
      try {
        await settle();
        const res = await callApi({ action: "recall", op: "flowPreview" });
        if (res.problem) { $d("sum").textContent = res.problem; $d("list").innerHTML = ""; return; }
        data = WHO_CACHE = res;
        if (!data[`${tab}Count`]) tab = data.nextCount ? "next" : data.inFlowCount ? "inFlow" : data.laterCount ? "later" : tab;
      } catch (err) {
        console.error("Who's in the flow failed:", err);
        if (!data) $d("list").innerHTML = "";
        $d("sum").textContent = err && err.code === "UNAUTHORIZED" ? "Your login has timed out. Log out and back in, then try again."
          : "Couldn't check. Press Refresh to try again.";
        return;
      } finally {
        loading = false;
        if (btn.isConnected) btn.disabled = false;
      }
      if (dlg.open) drawAll();
    }

    dlg.addEventListener("input", (e) => { if (e.target.dataset.role === "q") { q = e.target.value.trim().toLowerCase(); drawList(); } });
    dlg.addEventListener("click", async (e) => {
      if (e.target.closest('[data-act="x"]') || e.target.closest('a[href^="#/patient/"]')) { dlg.close(); return; }
      if (e.target.closest('[data-act="refresh"]')) { load(); return; }
      const tb = e.target.closest("[data-tab]");
      if (tb) { tab = tb.dataset.tab; drawTabs(); drawList(); return; }
      const sk = e.target.closest("[data-skip]");
      if (!sk) return;
      const inNow = tab === "inFlow";
      if (!(await confirmDialog({
        title: `${inNow ? "Take" : "Keep"} ${sk.dataset.name || "this patient"} out of the flow?`,
        message: inNow ? "No more automatic texts or emails for this recall. Their card goes to the recall team as usual."
          : "They won't get automatic texts or emails for this recall. Their card goes to the recall team as usual.",
        confirmLabel: inNow ? "Take out" : "Keep out", tone: "warning",
      }))) return;
      sk.disabled = true;
      try {
        const r = await callApi({ action: "recall", op: "flowSkip", id: sk.dataset.skip });
        if (r.problem) { showToast(r.problem); sk.disabled = false; return; }
        data[tab] = data[tab].filter((x) => x.id !== sk.dataset.skip);
        data[`${tab}Count`] = Math.max(0, data[`${tab}Count`] - 1);
        drawAll();
        showToast(inNow ? "Taken out of the flow." : "Kept out of the flow.");
      } catch (err) {
        console.error("Keep out failed:", err);
        showToast("Couldn't do that. Try again.");
        sk.disabled = false;
      }
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();

    // Show the last answer straight away; check again if it's more than 2 minutes old
    if (data) {
      if (!data[`${tab}Count`]) tab = data.nextCount ? "next" : data.inFlowCount ? "inFlow" : tab;
      drawAll();
    }
    if (!data || Date.now() - new Date(data.checkedAt || 0).getTime() > 120000) load();
  }
  
  /* ---------- Top bar ---------- */
  root.querySelector(".ff-bar").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "test") { testDialog(); return; }
    if (act.dataset.act === "who") { whoDialog(); return; }
    if (act.dataset.act !== "live") return;
    if (flow.on) {
      if (!(await confirmDialog({ title: "Turn the recall flow off?",
        message: "No more automatic texts or emails. Cards in the flow go to the recall team at the next hourly check.",
        confirmLabel: "Turn off", tone: "warning" }))) return;
      await settle();
      flow.on = false;
      try { await write(); renderBar(); showToast("Turned off."); }
      catch (err) { console.error(err); flow.on = true; showToast("Couldn't turn it off. Try again."); }
      return;
    }
    const problems = flowProblems(flow);
    if (problems.length) {
      msgEl.textContent = problems[0] + (problems.length > 1 ? ` (and ${problems.length - 1} more: look for the orange cards)` : "");
      return;
    }
    const t = flow.trigger;
    if (!(await confirmDialog({
      title: "Turn the recall flow on?",
      message: `From the next hourly check, recall cards that ${Number(t.withinDays) ? `became due in the last ${t.withinDays} days` : "are waiting"} start the flow, up to ${t.dailyMax} a day. ` +
        "Real texts and emails go to patients between 9 am and 6 pm.\n\nUse Test with a patient first if you haven't yet.",
      confirmLabel: "Turn on", tone: "info",
    }))) return;
    await settle();
    flow.on = true;
    try { await write({ onAt: new Date().toISOString(), onBy: String((staff && staff.name) || "") }); renderBar(); showToast("Turned on."); }
    catch (err) {
      console.error("Turn on failed:", err);
      flow.on = false;
      showToast(err.code === "permission-denied" ? "You need Recall settings access." : "Couldn't turn it on. Try again.");
    }
  });

  /* ---------- Start ---------- */
  renderBar();
  renderCanvas();
  renderSide();
  lhReady.finally(() => { if (root.isConnected) renderPreview(); });
  loadProductNames().then((p) => { productNames = p; if (root.isConnected && !editor) renderSide(); }).catch(() => {});
}