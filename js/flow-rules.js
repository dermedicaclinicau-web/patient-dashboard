// Email flows: the rule builder. Used for "Only start for patients who…", daily checks, If / else rules and "Also stop when…".
// The field keys here must match FLOW_FIELD_TYPE_ in Code.gs, which works them out for each patient.

import { db } from "./firebase-config.js";
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rid = () => "r_" + Math.random().toString(36).slice(2, 9);
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const niceDay = (k) => {
  if (!isIso(k)) return "…";
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};
// [from, to] for a quick pick: "month:0" this month, "month:-1" last month, "ym:2025-03" a month, "year:2024" a year
function quickRange(v) {
  const now = new Date();
  let m = /^month:(-?\d+)$/.exec(v);
  if (m) {
    const a = new Date(now.getFullYear(), now.getMonth() + Number(m[1]), 1);
    return [isoOf(a), isoOf(new Date(a.getFullYear(), a.getMonth() + 1, 0))];
  }
  m = /^ym:(\d{4})-(\d{2})$/.exec(v);
  if (m) return [isoOf(new Date(+m[1], +m[2] - 1, 1)), isoOf(new Date(+m[1], +m[2], 0))];
  m = /^year:(\d{4})$/.exec(v);
  if (m) return [`${m[1]}-01-01`, `${m[1]}-12-31`];
  return null;
}

export const PLAN_STATUSES = [
  ["none", "No treatment plan"], ["proposed", "Proposed"], ["sent", "Sent"], ["accepted", "Accepted"],
  ["in_progress", "In progress"], ["completed", "Completed"], ["closed", "Closed"],
];

export const RECALL_OUTCOMES = [["none", "No calls yet"], ["no_answer", "No answer"], ["voicemail", "Left voicemail"],
  ["spoke", "Spoke to them"], ["texted", "Sent a text"]];

export const RULE_FIELDS = [
  // Recall flow only (recall: true): about this recall card
  { key: "rc.category", group: "This recall", label: "Treatment category", type: "names", recall: true },
  { key: "rc.service", group: "This recall", label: "Last treatment's service", type: "text", hint: "e.g. Lip", recall: true },
  { key: "rc.staff", group: "This recall", label: "Last seen with", type: "text", hint: "Staff name", recall: true },
  { key: "rc.months", group: "This recall", label: "Time since their last treatment", type: "number", unit: "months", recall: true },
  { key: "rc.overdue", group: "This recall", label: "Time overdue", type: "number", unit: "days", recall: true },
  { key: "rc.due_between", group: "This recall", label: "Due date", type: "range", recall: true,
    ops: [["yes", "was between"], ["no", "wasn't between"]] },
  { key: "rc.cycle", group: "This recall", label: "Round of the flow (1 = the first time)", type: "number", recall: true },
  { key: "rc.tries", group: "This recall", label: "Calls tried so far", type: "number", recall: true },
  { key: "rc.texts", group: "This recall", label: "Texts sent so far", type: "number", recall: true },
  { key: "rc.emails", group: "This recall", label: "Recall emails sent so far", type: "number", recall: true },
  { key: "rc.last_out", group: "This recall", label: "Last call outcome", type: "choice", options: RECALL_OUTCOMES, recall: true },
  { key: "rc.replied", group: "This recall", label: "They replied to a text", type: "bool", recall: true },
  { key: "rc.replied_yes", group: "This recall", label: "They replied YES", type: "bool", recall: true },
  { key: "rc.reply_text", group: "This recall", label: "Their reply", type: "text", hint: "e.g. busy", recall: true },
  { key: "rc.assigned", group: "This recall", label: "Given to someone", type: "bool", recall: true },
  { key: "rc.assigned_to", group: "This recall", label: "Given to", type: "text", hint: "Staff name", recall: true },
  { key: "rc.other_due", group: "This recall", label: "Has another treatment due too", type: "bool", recall: true },

  { key: "buy.product", group: "This purchase", label: "Product bought", type: "products" },
  { key: "buy.first", group: "This purchase", label: "It's the first time they've bought it", type: "bool" },
  { key: "buy.in_ssp", group: "This purchase", label: "It's in their Skin Script", type: "bool" },
  { key: "buy.sold_by", group: "This purchase", label: "Sold by", type: "text", hint: "Staff name" },

  { key: "visit.service", group: "This visit", label: "A service at this visit", type: "text", hint: "e.g. Peel" },
  { key: "visit.staff", group: "This visit", label: "Seen by", type: "text", hint: "Staff name" },

  { key: "hist.bought", group: "Purchase history", label: "Has ever bought", type: "products" },
  { key: "hist.bought_between", group: "Purchase history", label: "Purchases between two dates", type: "prange",
    ops: [["last", "last bought between"], ["any", "bought between"], ["none", "didn't buy between"]] },
  { key: "hist.times", group: "Purchase history", label: "Times they've bought this product", type: "number" },
  { key: "hist.days_since", group: "Purchase history", label: "Time since their previous purchase", type: "number", unit: "days" },

  { key: "appt.has_future", group: "Appointments", label: "Has a future appointment booked", type: "bool" },
  { key: "appt.next_days", group: "Appointments", label: "Time until their next appointment", type: "number", unit: "days" },
  { key: "appt.last_days", group: "Appointments", label: "Time since their last visit", type: "number", unit: "days" },
  { key: "appt.visits", group: "Appointments", label: "Number of past visits", type: "number" },
  { key: "appt.future_service", group: "Appointments", label: "A future booking's service", type: "text", hint: "e.g. Laser" },
  { key: "appt.past_service", group: "Appointments", label: "A past visit's service", type: "text", hint: "e.g. Wrinkle Relaxer" },
  { key: "appt.visit_between", group: "Appointments", label: "Visits between two dates", type: "range",
    ops: [["yes", "had a visit"], ["no", "had no visit"]] },
  { key: "appt.last_between", group: "Appointments", label: "Last visit date", type: "range",
    ops: [["yes", "was between"], ["no", "wasn't between"]] },

  { key: "ssp.active", group: "Skin Script", label: "Has an active Skin Script", type: "bool" },
  { key: "ssp.age_days", group: "Skin Script", label: "Time since their Skin Script was made", type: "number", unit: "days" },
  { key: "ssp.expiry_days", group: "Skin Script", label: "Time until their Skin Script expires", type: "number", unit: "days" },

  { key: "plan.status", group: "Treatment plan", label: "Treatment plan status", type: "choice", options: PLAN_STATUSES },
  { key: "plan.due", group: "Treatment plan", label: "A treatment is due or overdue", type: "bool" },
  { key: "plan.overdue", group: "Treatment plan", label: "A treatment is overdue", type: "bool" },

  { key: "form.saved", group: "Saved forms", label: "Saved forms", type: "form" },

  { key: "pt.age", group: "Patient", label: "Age", type: "number", unit: "years" },
  { key: "pt.birthday", group: "Patient", label: "Birthday", type: "birthday",
    ops: [["today", "is today"], ["next", "is in the next"], ["last", "was in the past"], ["month", "is this month"]] },
  { key: "pt.birth_year", group: "Patient", label: "Year of birth", type: "year",
    ops: [["eq", "is"], ["lt", "is before"], ["gt", "is after"], ["between", "is between"]] },
  { key: "pt.email", group: "Patient", label: "Has an email address", type: "bool" },
  { key: "pt.mobile", group: "Patient", label: "Has a mobile number", type: "bool" },
  { key: "pt.marketing", group: "Patient", label: "Agreed to marketing emails", type: "bool" },
];
const FIELD = Object.fromEntries(RULE_FIELDS.map((f) => [f.key, f]));
// What the Recall flow offers: this recall, plus everything about the patient (not "this purchase" or "this visit")
export const RECALL_RULE_KEYS = RULE_FIELDS
  .filter((f) => f.recall || (!["This purchase", "This visit"].includes(f.group) && f.key !== "hist.times"))
  .map((f) => f.key);

const OPS = {
  bool: [["yes", "Yes"], ["no", "No"]],
  number: [["gt", "more than"], ["lt", "less than"], ["eq", "exactly"]],
  text: [["contains", "contains"], ["not_contains", "doesn't contain"]],
  products: [["any", "any of"], ["none", "none of"]],
  names: [["any", "is one of"], ["none", "is not one of"]],
  choice: [["is", "is"], ["not", "is not"]],
  form: [["has", "has one named"], ["none", "has none named"]],
};
const opsFor = (f) => f.ops || OPS[f.type] || OPS.bool;
function defaults(f) {
  const list = f.type === "products" || f.type === "names" || f.type === "prange";
  return { op: opsFor(f)[0][0], value: list ? [] : f.type === "choice" ? f.options[0][0] : "", days: "",
    ...(f.type === "range" || f.type === "prange" ? { from: "", to: "" } : {}),
    ...(f.type === "year" ? { value2: "" } : {}) };
}
export const blankGroup = () => ({ match: "all", rules: [] });
// Groups: { id, type: "group", match, rules: [rules] } inside a set of rules (one level deep)
const isGroup = (x) => !!x && Array.isArray(x.rules);
// How many rules, counting the ones inside groups
export const ruleCount = (g) => (g && Array.isArray(g.rules)
  ? g.rules.reduce((n, x) => n + (isGroup(x) ? x.rules.length : 1), 0) : 0);
export function newRule(field = "appt.has_future") {
  const f = FIELD[field] || RULE_FIELDS[0];
  return { id: rid(), field: f.key, ...defaults(f) };
}

function cleanRule(r) {
  const f = FIELD[r.field];
  const d = defaults(f);
  const op = opsFor(f).some((o) => o[0] === r.op) ? r.op : d.op;
  let value = r.value;
  if (f.type === "products" || f.type === "names" || f.type === "prange") value = (Array.isArray(value) ? value : []).map(String).filter(Boolean).slice(0, 40);
  else if (f.type === "number" || f.type === "birthday" || f.type === "year") value = value === "" || value === null || value === undefined ? "" : Number(value);
  else if (f.type === "choice") value = f.options.some((o) => o[0] === value) ? value : d.value;
  else if (f.type === "bool") value = "";
  else value = String(value ?? "");
  const days = f.type === "form" && r.days !== "" && r.days !== null && r.days !== undefined ? Number(r.days) : "";
  const out = { id: String(r.id || rid()), field: f.key, op, value, days };
  if (f.type === "range" || f.type === "prange") { out.from = isIso(r.from) ? r.from : ""; out.to = isIso(r.to) ? r.to : ""; }
  if (f.type === "year") out.value2 = r.value2 === "" || r.value2 === null || r.value2 === undefined ? "" : Number(r.value2);
  return out;
}

export function cleanGroup(g) {
  const src = g && typeof g === "object" ? g : {};
  return {
    match: src.match === "any" ? "any" : "all",
    rules: (Array.isArray(src.rules) ? src.rules : []).map((x) => {
      if (isGroup(x)) {
        return { id: String(x.id || rid()), type: "group", match: x.match === "any" ? "any" : "all",
          rules: x.rules.filter((r) => r && !isGroup(r) && FIELD[r.field]).slice(0, 20).map(cleanRule) };
      }
      return x && FIELD[x.field] ? cleanRule(x) : null;
    }).filter(Boolean).slice(0, 20),
  };
}

// What's wrong with one rule, or ""
function ruleProblem(r) {
  const f = FIELD[r.field];
  if (!f) return "A rule uses something that no longer exists";
  if (f.type === "number" && !(r.value !== "" && Number.isFinite(Number(r.value)) && Number(r.value) >= 0)) return `Add a number to "${f.label}"`;
  if (f.type === "birthday" && (r.op === "next" || r.op === "last")
    && !(r.value !== "" && Number.isInteger(Number(r.value)) && Number(r.value) >= 1 && Number(r.value) <= 60)) return 'Choose 1 to 60 days for "Birthday"';
  if (f.type === "year") {
    const now = new Date().getFullYear();
    const ok = (v) => v !== "" && Number.isInteger(Number(v)) && Number(v) >= 1900 && Number(v) <= now;
    if (!ok(r.value) || (r.op === "between" && !ok(r.value2))) return `Type a year, like 1985, for "${f.label}"`;
  }
  if ((f.type === "text" || f.type === "form") && !String(r.value || "").trim()) return `Fill in "${f.label}"`;
  if (f.type === "products" && !(Array.isArray(r.value) && r.value.length)) return `Choose a product for "${f.label}"`;
  if (f.type === "names" && !(Array.isArray(r.value) && r.value.length)) return `Choose at least one for "${f.label}"`;
  if (f.type === "range" || f.type === "prange") {
    if (!isIso(r.from) || !isIso(r.to)) return `Choose both dates for "${f.label}"`;
    if (r.to < r.from) return `"${f.label}": the second date is before the first`;
  }
  return "";
}

// The first thing wrong with a set of rules, or ""
export function groupProblem(g, required) {
  const rules = (g && g.rules) || [];
  if (required && !ruleCount(g)) return "Add at least one rule";
  for (const x of rules) {
    if (isGroup(x)) {
      if (!x.rules.length) return "A group has no rules yet. Add one, or remove the group";
      for (const r of x.rules) { const p = ruleProblem(r); if (p) return p; }
    } else {
      const p = ruleProblem(x);
      if (p) return p;
    }
  }
  return "";
}

export function describeRule(r) {
  const f = FIELD[r.field];
  if (!f) return "Unknown rule";
  const op = (opsFor(f).find((o) => o[0] === r.op) || opsFor(f)[0])[1];
  if (f.type === "bool") return `${f.label}: ${op}`;
  if (f.type === "prange") {
    const list = Array.isArray(r.value) ? r.value : [];
    const what = list.length ? (list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ")) : "any product";
    const verb = r.op === "last" ? "Last bought" : r.op === "none" ? "Didn't buy" : "Bought";
    return `${verb} ${what} between ${niceDay(r.from)} and ${niceDay(r.to)}`;
  }
  if (f.type === "range") {
    const span = `${niceDay(r.from)} and ${niceDay(r.to)}`;
    if (r.field === "appt.last_between") return `Last visit ${r.op === "no" ? "not between" : "between"} ${span}`;
    if (r.field === "rc.due_between") return `Due date ${r.op === "no" ? "not between" : "between"} ${span}`;
    return `${r.op === "no" ? "No visit" : "Visited"} between ${span}`;
  }
  if (f.type === "birthday") {
    if (r.op === "today" || r.op === "month") return `Birthday ${op}`;
    const n = r.value === "" ? "…" : r.value;
    return `Birthday ${op} ${n} day${Number(n) === 1 ? "" : "s"}`;
  }
  if (f.type === "year") {
    const a = r.value === "" ? "…" : r.value;
    if (r.op === "between") return `Born between ${a} and ${r.value2 === "" || r.value2 === undefined ? "…" : r.value2}`;
    return `Born ${r.op === "lt" ? "before" : r.op === "gt" ? "after" : "in"} ${a}`;
  }
  if (f.type === "number") return `${f.label} ${op} ${r.value === "" ? "…" : r.value}${f.unit ? " " + f.unit : ""}`;
  if (f.type === "choice") return `${f.label} ${op} ${((f.options.find((o) => o[0] === r.value) || [])[1] || "…").toLowerCase()}`;
  if (f.type === "products" || f.type === "names") {
    const list = Array.isArray(r.value) ? r.value : [];
    return `${f.label} ${op} ${list.length ? (list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ")) : "…"}`;
  }
  if (f.type === "form") return `${f.label} ${op} "${r.value || "…"}"${r.days ? ` in the last ${r.days} days` : ""}`;
  return `${f.label} ${op} "${r.value || "…"}"`;
}
function describeItem(x) {
  if (!isGroup(x)) return describeRule(x);
  if (!x.rules.length) return "(an empty group)";
  const j = x.match === "any" ? " or " : " and ";
  return `(${x.rules.slice(0, 2).map(describeRule).join(j)}${x.rules.length > 2 ? `${j}…` : ""})`;
}
export function describeGroup(g) {
  const rules = (g && g.rules) || [];
  if (!rules.length) return "No rules yet";
  const first = describeItem(rules[0]);
  return rules.length > 1 ? `${first} · ${g.match === "any" ? "or" : "and"} ${rules.length - 1} more` : first;
}

// Product names for the pickers: the Skin Script catalogue and Inventory products
let namesCache = null;
export async function loadProductNames() {
  if (namesCache) return namesCache;
  const out = new Map();
  const read = async (col) => {
    try {
      const snap = await getDocs(collection(db, col));
      snap.forEach((d) => {
        const x = d.data() || {};
        const n = String(x.name || "").replace(/\s+/g, " ").trim();
        if (n && x.published !== false && x.active !== false) out.set(n.toLowerCase(), n);
      });
    } catch (err) { console.warn(`Product names from ${col} not loaded:`, err); }
  };
  await Promise.all([read("ssp_products"), read("inv_products")]);
  namesCache = [...out.values()].sort((a, b) => a.localeCompare(b));
  return namesCache;
}

// Appointment service names (System configuration → Treatment plans → services)
let servicesCache = null;
export async function loadServiceNames() {
  if (servicesCache) return servicesCache;
  try {
    const d = await getDoc(doc(db, "plan_settings", "services"));
    const list = d.exists() && Array.isArray(d.data().services) ? d.data().services : [];
    const out = new Map();
    list.forEach((r) => {
      const n = String((r && r.service) || "").replace(/\s+/g, " ").trim();
      if (n && !(r && r.notTreatment)) out.set(n.toLowerCase(), n);
    });
    servicesCache = [...out.values()].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.warn("Service names not loaded:", err);
    servicesCache = [];
  }
  return servicesCache;
}

// A list of names (chips) with a box to add more. arr is changed in place.
export function mountProductPicker(host, arr, { onChange = () => {}, names = [], placeholder = "Type a product name", none = "No products chosen yet" } = {}) {
  const listId = "pp_" + Math.random().toString(36).slice(2, 8);
  const known = new Map(names.map((n) => [n.toLowerCase(), n]));
  function render() {
    host.innerHTML = `
      <div class="fr-chips">${arr.length ? arr.map((n, i) => `<span class="fr-chip">${esc(n)}
        <button type="button" data-pp-x="${i}" aria-label="Remove ${esc(n)}" title="Remove">×</button></span>`).join("")
        : `<span class="fr-none">${esc(none)}</span>`}</div>
      <div class="fr-pp-add">
        <input class="fe-input" list="${listId}" data-pp-in maxlength="150" placeholder="${esc(placeholder)}" />
        <button type="button" class="lh-btn" data-pp-add>Add</button>
      </div>
      <datalist id="${listId}">${names.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>`;
  }
  function add(refocus) {
    const inp = host.querySelector("[data-pp-in]");
    const raw = String((inp && inp.value) || "").replace(/\s+/g, " ").trim().slice(0, 150);
    if (!raw) return;
    const v = known.get(raw.toLowerCase()) || raw;
    if (!arr.some((x) => x.toLowerCase() === v.toLowerCase()) && arr.length < 40) { arr.push(v); onChange(); }
    render();
    if (refocus) host.querySelector("[data-pp-in]").focus();
  }
  host.addEventListener("click", (e) => {
    const x = e.target.closest("[data-pp-x]");
    if (x) { arr.splice(Number(x.dataset.ppX), 1); onChange(); render(); return; }
    if (e.target.closest("[data-pp-add]")) add(true);
  });
  host.addEventListener("keydown", (e) => {
    if (e.target.matches("[data-pp-in]") && e.key === "Enter") { e.preventDefault(); add(true); }
  });
  // Picking a name from the suggestions adds it straight away
  host.addEventListener("input", (e) => {
    if (!e.target.matches("[data-pp-in]")) return;
    if ((e.inputType === "insertReplacementText" || !e.inputType) && known.has(String(e.target.value).trim().toLowerCase())) add(true);
  });
  render();
}

// The rule builder. group ({ match, rules }) is changed in place; onChange is called after every change.
// A rule list can hold groups (one level): { type: "group", match, rules }.
// only: the field keys to offer. lists: the choices for "names" rules, e.g. { "rc.category": [...] }
export function mountRuleBuilder(host, group, { onChange = () => {}, names = [], empty = "", only = null, lists = {} } = {}) {
  const fields = Array.isArray(only) ? RULE_FIELDS.filter((f) => only.includes(f.key)) : RULE_FIELDS.filter((f) => !f.recall);
  const groups = [...new Set(fields.map((f) => f.group))];
  const firstKey = fields.some((f) => f.key === "appt.has_future") ? "appt.has_future" : fields[0].key;
  const MAX = 20, TOTAL = 40;

  // "3" is the 4th item; "3.1" is the 2nd rule in the group at item 3
  const at = (path) => {
    const [a, b] = String(path).split(".").map(Number);
    if (b === undefined || Number.isNaN(b)) return { list: group.rules, i: a };
    const g = group.rules[a];
    return isGroup(g) ? { list: g.rules, i: b } : null;
  };
  const ruleAt = (path) => { const l = at(path); return l ? l.list[l.i] : null; };
  const matchSel = (attr, cur) => `<select class="fb-select" ${attr}>
    <option value="all"${cur !== "any" ? " selected" : ""}>all</option>
    <option value="any"${cur === "any" ? " selected" : ""}>any</option></select>`;

  function ruleHtml(r, p, join) {
    const f = FIELD[r.field];
    const fieldSel = `<select class="fb-select fr-field" data-rf="${p}" aria-label="What to check">${groups.map((g) =>
      `<optgroup label="${esc(g)}">${fields.filter((x) => x.group === g).map((x) =>
        `<option value="${x.key}"${x.key === r.field ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</optgroup>`).join("")}</select>`;
    const opSel = `<select class="fb-select fr-op" data-ro="${p}" aria-label="How to compare">${opsFor(f).map(([v, l]) =>
      `<option value="${v}"${v === r.op ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    let val = "";
    let quick = "";
    if (f.type === "number") {
      val = `<input class="fe-input fr-num" type="number" min="0" step="1" inputmode="numeric" data-rv="${p}" value="${esc(r.value)}" aria-label="Number" />
        ${f.unit ? `<span class="fr-unit">${esc(f.unit)}</span>` : ""}`;
    } else if (f.type === "birthday") {
      if (r.op === "next" || r.op === "last") {
        val = `<input class="fe-input fr-num" type="number" min="1" max="60" step="1" inputmode="numeric" data-rv="${p}" value="${esc(r.value)}" aria-label="Days" />
          <span class="fr-unit">days</span>`;
      }
    } else if (f.type === "year") {
      const max = new Date().getFullYear();
      val = `<input class="fe-input fr-num" type="number" min="1900" max="${max}" step="1" inputmode="numeric" data-rv="${p}" value="${esc(r.value)}" placeholder="1985" aria-label="Year" />
        ${r.op === "between" ? `<span class="fr-unit">and</span>
        <input class="fe-input fr-num" type="number" min="1900" max="${max}" step="1" inputmode="numeric" data-rv2="${p}" value="${esc(r.value2 ?? "")}" placeholder="1989" aria-label="Second year" />` : ""}`;
    } else if (f.type === "text") {
      val = `<input class="fe-input fr-val" data-rv="${p}" maxlength="80" placeholder="${esc(f.hint || "")}" value="${esc(r.value)}" aria-label="Text" />`;
    } else if (f.type === "choice") {
      val = `<select class="fb-select fr-val" data-rv="${p}" aria-label="Value">${f.options.map(([v, l]) =>
        `<option value="${v}"${v === r.value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    } else if (f.type === "form") {
      val = `<input class="fe-input fr-val" data-rv="${p}" maxlength="80" placeholder="e.g. Consent" value="${esc(r.value)}" aria-label="Form name" />
        <span class="fr-unit">in the last</span>
        <input class="fe-input fr-num" type="number" min="0" step="1" data-rd="${p}" value="${esc(r.days)}" placeholder="any" aria-label="Days" />
        <span class="fr-unit">days</span>`;
    } else if (f.type === "range" || f.type === "prange") {
      const y = new Date().getFullYear();
      val = `<input class="fe-input fr-date" type="date" data-rfrom="${p}" value="${esc(r.from || "")}" aria-label="From" />
        <span class="fr-unit">and</span>
        <input class="fe-input fr-date" type="date" data-rto="${p}" value="${esc(r.to || "")}" aria-label="To" />`;
      quick = `<div class="fr-row fr-quick">
        <select class="fb-select" data-rq="${p}" aria-label="Quick pick">
          <option value="">Quick pick…</option>
          <option value="month:0">This month</option>
          <option value="month:-1">Last month</option>
          <option value="year:${y}">This year</option>
          <option value="year:${y - 1}">Last year</option>
          <optgroup label="A whole year">${Array.from({ length: 8 }, (_, k) => y - k)
            .map((n) => `<option value="year:${n}">${n}</option>`).join("")}</optgroup>
        </select>
        <span class="fr-unit">or a whole month</span>
        <input class="fe-input fr-date" type="month" data-rmonth="${p}" aria-label="A whole month" />
      </div>`;
    }
    return `<div class="fr-rule">
      ${join ? `<span class="fr-join">${join}</span>` : ""}
      <div class="fr-row">${fieldSel}</div>
      <div class="fr-row">${opSel}${val}
        <button type="button" class="fr-x" data-rx="${p}" aria-label="Remove this rule" title="Remove">×</button></div>
      ${quick}
      ${f.type === "products" || f.type === "names" || f.type === "prange" ? `<div class="fr-pp" data-pp-host="${p}"></div>` : ""}
    </div>`;
  }

  function groupHtml(g, i, join, canAdd) {
    const inner = g.match === "any" ? "or" : "and";
    return `<div class="fr-rule fr-group-wrap">
      ${join ? `<span class="fr-join">${join}</span>` : ""}
      <div class="fr-group">
        <div class="fr-group-head">
          <label class="fr-match">Match ${matchSel(`data-gm="${i}" aria-label="Match all or any in this group"`, g.match)} of these</label>
          <button type="button" class="fr-x" data-gx="${i}" aria-label="Remove this group" title="Remove group">×</button>
        </div>
        ${g.rules.length ? `<div class="fr-rules">${g.rules.map((r, j) => ruleHtml(r, `${i}.${j}`, j ? inner : "")).join("")}</div>`
          : '<p class="fr-empty">Add a rule to this group, or remove it.</p>'}
        ${canAdd && g.rules.length < MAX ? `<button type="button" class="fr-add" data-gadd="${i}">+ Add a rule to this group</button>` : ""}
      </div>
    </div>`;
  }

  function render() {
    const join = group.match === "any" ? "or" : "and";
    const canAdd = ruleCount(group) < TOTAL;
    const room = group.rules.length < MAX && canAdd;
    host.innerHTML = `<div class="fr">
      ${group.rules.length > 1 ? `<label class="fr-match">Match ${matchSel('data-rm aria-label="Match all or any"', group.match)} of these</label>` : ""}
      ${group.rules.length ? `<div class="fr-rules">${group.rules.map((x, i) => (isGroup(x)
        ? groupHtml(x, i, i ? join : "", canAdd)
        : ruleHtml(x, String(i), i ? join : ""))).join("")}</div>` : (empty ? `<p class="fr-empty">${esc(empty)}</p>` : "")}
      ${room ? `<div class="fr-adds">
        <button type="button" class="fr-add" data-radd>+ Add a rule</button>
        <button type="button" class="fr-add" data-gnew>+ Add a group</button>
      </div>` : ""}
    </div>`;
    host.querySelectorAll("[data-pp-host]").forEach((el) => {
      const r = ruleAt(el.dataset.ppHost);
      if (!r) return;
      if (!Array.isArray(r.value)) r.value = [];
      const f = FIELD[r.field];
      if (f && f.type === "names") {
        mountProductPicker(el, r.value, { onChange, names: lists[r.field] || [], placeholder: "Choose or type one", none: "None chosen yet" });
      } else if (f && f.type === "prange") {
        mountProductPicker(el, r.value, { onChange, names, placeholder: "Type a product, or leave empty for any", none: "Any product" });
      } else {
        mountProductPicker(el, r.value, { onChange, names });
      }
    });
  }

  host.addEventListener("input", (e) => {
    const el = e.target;
    const d = el.dataset;
    if (d.rm !== undefined) { group.match = el.value === "any" ? "any" : "all"; render(); onChange(); return; }
    if (d.gm !== undefined) {
      const g = group.rules[Number(d.gm)];
      if (isGroup(g)) { g.match = el.value === "any" ? "any" : "all"; render(); onChange(); }
      return;
    }
    if (d.rf !== undefined) {
      const r = ruleAt(d.rf);
      const f = FIELD[el.value];
      if (!r || !f) return;
      Object.assign(r, { field: f.key }, defaults(f));
      render();
      onChange();
      return;
    }
    if (d.rfrom !== undefined || d.rto !== undefined) {
      const r = ruleAt(d.rfrom ?? d.rto);
      if (!r) return;
      if (d.rfrom !== undefined) r.from = el.value; else r.to = el.value;
      onChange();
      return;
    }
    if (d.rq !== undefined || d.rmonth !== undefined) {
      const r = ruleAt(d.rq ?? d.rmonth);
      const span = quickRange(d.rq !== undefined ? el.value : `ym:${el.value}`);
      if (!r || !span) return;
      [r.from, r.to] = span;
      render();
      onChange();
      return;
    }
    if (d.rv2 !== undefined) {
      const r = ruleAt(d.rv2);
      if (!r) return;
      r.value2 = el.value === "" ? "" : Number(el.value);
      onChange();
      return;
    }
    const p = d.ro ?? d.rv ?? d.rd;
    if (p === undefined) return;
    const r = ruleAt(p);
    if (!r) return;
    const ft = FIELD[r.field].type;
    if (d.ro !== undefined) {
      r.op = el.value;
      // Birthday: the days box only shows for "in the next" and "in the past"
      if (ft === "birthday") { if ((r.op === "next" || r.op === "last") && r.value === "") r.value = 7; render(); }
      if (ft === "year") render();   // shows or hides the second year box
    }
    else if (d.rd !== undefined) r.days = el.value === "" ? "" : Number(el.value);
    else r.value = ft === "number" || ft === "birthday" || ft === "year" ? (el.value === "" ? "" : Number(el.value)) : el.value;
    onChange();
  });

  host.addEventListener("click", (e) => {
    if (e.target.closest("[data-radd]")) {
      group.rules.push(newRule(firstKey));
      render(); onChange(); return;
    }
    if (e.target.closest("[data-gnew]")) {
      group.rules.push({ id: rid(), type: "group", match: "any", rules: [newRule(firstKey)] });
      render(); onChange(); return;
    }
    const ga = e.target.closest("[data-gadd]");
    if (ga) {
      const g = group.rules[Number(ga.dataset.gadd)];
      if (isGroup(g) && g.rules.length < MAX && ruleCount(group) < TOTAL) { g.rules.push(newRule(firstKey)); render(); onChange(); }
      return;
    }
    const gx = e.target.closest("[data-gx]");
    if (gx) { group.rules.splice(Number(gx.dataset.gx), 1); render(); onChange(); return; }
    const x = e.target.closest("[data-rx]");
    if (x) {
      const l = at(x.dataset.rx);
      if (l) { l.list.splice(l.i, 1); render(); onChange(); }
    }
  });
  render();
}