// Email flows: the rule builder. Used for "Only start for patients who…", If / else rules and "Also stop when…".
// The field keys here must match FLOW_FIELD_TYPE_ in Code.gs, which works them out for each patient.

import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rid = () => "r_" + Math.random().toString(36).slice(2, 9);

export const PLAN_STATUSES = [
  ["none", "No treatment plan"], ["proposed", "Proposed"], ["sent", "Sent"], ["accepted", "Accepted"],
  ["in_progress", "In progress"], ["completed", "Completed"], ["closed", "Closed"],
];

export const RULE_FIELDS = [
  { key: "buy.product", group: "This purchase", label: "Product bought", type: "products" },
  { key: "buy.first", group: "This purchase", label: "It's the first time they've bought it", type: "bool" },
  { key: "buy.in_ssp", group: "This purchase", label: "It's in their Skin Script", type: "bool" },
  { key: "buy.sold_by", group: "This purchase", label: "Sold by", type: "text", hint: "Staff name" },

  { key: "hist.bought", group: "Purchase history", label: "Has ever bought", type: "products" },
  { key: "hist.times", group: "Purchase history", label: "Times they've bought this product", type: "number" },
  { key: "hist.days_since", group: "Purchase history", label: "Time since their previous purchase", type: "number", unit: "days" },

  { key: "appt.has_future", group: "Appointments", label: "Has a future appointment booked", type: "bool" },
  { key: "appt.next_days", group: "Appointments", label: "Time until their next appointment", type: "number", unit: "days" },
  { key: "appt.last_days", group: "Appointments", label: "Time since their last visit", type: "number", unit: "days" },
  { key: "appt.visits", group: "Appointments", label: "Number of past visits", type: "number" },
  { key: "appt.future_service", group: "Appointments", label: "A future booking's service", type: "text", hint: "e.g. Laser" },
  { key: "appt.past_service", group: "Appointments", label: "A past visit's service", type: "text", hint: "e.g. Wrinkle Relaxer" },

  { key: "ssp.active", group: "Skin Script", label: "Has an active Skin Script", type: "bool" },
  { key: "ssp.age_days", group: "Skin Script", label: "Time since their Skin Script was made", type: "number", unit: "days" },
  { key: "ssp.expiry_days", group: "Skin Script", label: "Time until their Skin Script expires", type: "number", unit: "days" },

  { key: "plan.status", group: "Treatment plan", label: "Treatment plan status", type: "choice", options: PLAN_STATUSES },
  { key: "plan.due", group: "Treatment plan", label: "A treatment is due or overdue", type: "bool" },
  { key: "plan.overdue", group: "Treatment plan", label: "A treatment is overdue", type: "bool" },

  { key: "form.saved", group: "Saved forms", label: "Saved forms", type: "form" },

  { key: "pt.age", group: "Patient", label: "Age", type: "number", unit: "years" },
  { key: "pt.email", group: "Patient", label: "Has an email address", type: "bool" },
  { key: "pt.mobile", group: "Patient", label: "Has a mobile number", type: "bool" },
  { key: "pt.marketing", group: "Patient", label: "Agreed to marketing emails", type: "bool" },
];
const FIELD = Object.fromEntries(RULE_FIELDS.map((f) => [f.key, f]));

const OPS = {
  bool: [["yes", "Yes"], ["no", "No"]],
  number: [["gt", "more than"], ["lt", "less than"], ["eq", "exactly"]],
  text: [["contains", "contains"], ["not_contains", "doesn't contain"]],
  products: [["any", "any of"], ["none", "none of"]],
  choice: [["is", "is"], ["not", "is not"]],
  form: [["has", "has one named"], ["none", "has none named"]],
};
const opsFor = (f) => OPS[f.type] || OPS.bool;
function defaults(f) {
  return { op: opsFor(f)[0][0], value: f.type === "products" ? [] : f.type === "choice" ? f.options[0][0] : "", days: "" };
}

export const blankGroup = () => ({ match: "all", rules: [] });
export const ruleCount = (g) => (g && Array.isArray(g.rules) ? g.rules.length : 0);
export function newRule(field = "appt.has_future") {
  const f = FIELD[field] || RULE_FIELDS[0];
  return { id: rid(), field: f.key, ...defaults(f) };
}

export function cleanGroup(g) {
  const src = g && typeof g === "object" ? g : {};
  return {
    match: src.match === "any" ? "any" : "all",
    rules: (Array.isArray(src.rules) ? src.rules : []).filter((r) => r && FIELD[r.field]).slice(0, 20).map((r) => {
      const f = FIELD[r.field];
      const d = defaults(f);
      const op = opsFor(f).some((o) => o[0] === r.op) ? r.op : d.op;
      let value = r.value;
      if (f.type === "products") value = (Array.isArray(value) ? value : []).map(String).filter(Boolean).slice(0, 40);
      else if (f.type === "number") value = value === "" || value === null || value === undefined ? "" : Number(value);
      else if (f.type === "choice") value = f.options.some((o) => o[0] === value) ? value : d.value;
      else if (f.type === "bool") value = "";
      else value = String(value ?? "");
      const days = f.type === "form" && r.days !== "" && r.days !== null && r.days !== undefined ? Number(r.days) : "";
      return { id: String(r.id || rid()), field: f.key, op, value, days };
    }),
  };
}

// The first thing wrong with a set of rules, or ""
export function groupProblem(g, required) {
  const rules = (g && g.rules) || [];
  if (required && !rules.length) return "Add at least one rule";
  for (const r of rules) {
    const f = FIELD[r.field];
    if (!f) return "A rule uses something that no longer exists";
    if (f.type === "number" && !(r.value !== "" && Number.isFinite(Number(r.value)) && Number(r.value) >= 0)) return `Add a number to "${f.label}"`;
    if ((f.type === "text" || f.type === "form") && !String(r.value || "").trim()) return `Fill in "${f.label}"`;
    if (f.type === "products" && !(Array.isArray(r.value) && r.value.length)) return `Choose a product for "${f.label}"`;
  }
  return "";
}

export function describeRule(r) {
  const f = FIELD[r.field];
  if (!f) return "Unknown rule";
  const op = (opsFor(f).find((o) => o[0] === r.op) || opsFor(f)[0])[1];
  if (f.type === "bool") return `${f.label}: ${op}`;
  if (f.type === "number") return `${f.label} ${op} ${r.value === "" ? "…" : r.value}${f.unit ? " " + f.unit : ""}`;
  if (f.type === "choice") return `${f.label} ${op} ${((f.options.find((o) => o[0] === r.value) || [])[1] || "…").toLowerCase()}`;
  if (f.type === "products") {
    const list = Array.isArray(r.value) ? r.value : [];
    return `${f.label} ${op} ${list.length ? (list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ")) : "…"}`;
  }
  if (f.type === "form") return `${f.label} ${op} "${r.value || "…"}"${r.days ? ` in the last ${r.days} days` : ""}`;
  return `${f.label} ${op} "${r.value || "…"}"`;
}
export function describeGroup(g) {
  const rules = (g && g.rules) || [];
  if (!rules.length) return "No rules yet";
  const first = describeRule(rules[0]);
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

// A list of product names (chips) with a box to add more. arr is changed in place.
export function mountProductPicker(host, arr, { onChange = () => {}, names = [] } = {}) {
  const listId = "pp_" + Math.random().toString(36).slice(2, 8);
  const known = new Map(names.map((n) => [n.toLowerCase(), n]));
  function render() {
    host.innerHTML = `
      <div class="fr-chips">${arr.length ? arr.map((n, i) => `<span class="fr-chip">${esc(n)}
        <button type="button" data-pp-x="${i}" aria-label="Remove ${esc(n)}" title="Remove">×</button></span>`).join("")
        : '<span class="fr-none">No products chosen yet</span>'}</div>
      <div class="fr-pp-add">
        <input class="fe-input" list="${listId}" data-pp-in maxlength="150" placeholder="Type a product name" />
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
export function mountRuleBuilder(host, group, { onChange = () => {}, names = [], empty = "" } = {}) {
  const groups = [...new Set(RULE_FIELDS.map((f) => f.group))];

  function ruleHtml(r, i) {
    const f = FIELD[r.field];
    const fieldSel = `<select class="fb-select fr-field" data-rf="${i}" aria-label="What to check">${groups.map((g) =>
      `<optgroup label="${esc(g)}">${RULE_FIELDS.filter((x) => x.group === g).map((x) =>
        `<option value="${x.key}"${x.key === r.field ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</optgroup>`).join("")}</select>`;
    const opSel = `<select class="fb-select fr-op" data-ro="${i}" aria-label="How to compare">${opsFor(f).map(([v, l]) =>
      `<option value="${v}"${v === r.op ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    let val = "";
    if (f.type === "number") {
      val = `<input class="fe-input fr-num" type="number" min="0" step="1" inputmode="numeric" data-rv="${i}" value="${esc(r.value)}" aria-label="Number" />
        ${f.unit ? `<span class="fr-unit">${esc(f.unit)}</span>` : ""}`;
    } else if (f.type === "text") {
      val = `<input class="fe-input fr-val" data-rv="${i}" maxlength="80" placeholder="${esc(f.hint || "")}" value="${esc(r.value)}" aria-label="Text" />`;
    } else if (f.type === "choice") {
      val = `<select class="fb-select fr-val" data-rv="${i}" aria-label="Value">${f.options.map(([v, l]) =>
        `<option value="${v}"${v === r.value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    } else if (f.type === "form") {
      val = `<input class="fe-input fr-val" data-rv="${i}" maxlength="80" placeholder="e.g. Consent" value="${esc(r.value)}" aria-label="Form name" />
        <span class="fr-unit">in the last</span>
        <input class="fe-input fr-num" type="number" min="0" step="1" data-rd="${i}" value="${esc(r.days)}" placeholder="any" aria-label="Days" />
        <span class="fr-unit">days</span>`;
    }
    return `<div class="fr-rule">
      ${i ? `<span class="fr-join">${group.match === "any" ? "or" : "and"}</span>` : ""}
      <div class="fr-row">${fieldSel}</div>
      <div class="fr-row">${opSel}${val}
        <button type="button" class="fr-x" data-rx="${i}" aria-label="Remove this rule" title="Remove">×</button></div>
      ${f.type === "products" ? `<div class="fr-pp" data-pp-host="${i}"></div>` : ""}
    </div>`;
  }

  function render() {
    host.innerHTML = `<div class="fr">
      ${group.rules.length > 1 ? `<label class="fr-match">Match
        <select class="fb-select" data-rm><option value="all"${group.match !== "any" ? " selected" : ""}>all</option>
          <option value="any"${group.match === "any" ? " selected" : ""}>any</option></select> of these rules</label>` : ""}
      ${group.rules.length ? `<div class="fr-rules">${group.rules.map(ruleHtml).join("")}</div>` : (empty ? `<p class="fr-empty">${esc(empty)}</p>` : "")}
      ${group.rules.length < 20 ? '<button type="button" class="fr-add" data-radd>+ Add a rule</button>' : ""}
    </div>`;
    host.querySelectorAll("[data-pp-host]").forEach((el) => {
      const r = group.rules[Number(el.dataset.ppHost)];
      if (!Array.isArray(r.value)) r.value = [];
      mountProductPicker(el, r.value, { onChange, names });
    });
  }

  host.addEventListener("input", (e) => {
    const el = e.target;
    const d = el.dataset;
    if (d.rm !== undefined) { group.match = el.value === "any" ? "any" : "all"; render(); onChange(); return; }
    if (d.rf !== undefined) {
      const r = group.rules[Number(d.rf)];
      const f = FIELD[el.value];
      if (!r || !f) return;
      Object.assign(r, { field: f.key }, defaults(f));
      render();
      onChange();
      return;
    }
    const idx = d.ro ?? d.rv ?? d.rd;
    if (idx === undefined) return;
    const r = group.rules[Number(idx)];
    if (!r) return;
    if (d.ro !== undefined) r.op = el.value;
    else if (d.rd !== undefined) r.days = el.value === "" ? "" : Number(el.value);
    else r.value = FIELD[r.field].type === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
    onChange();
  });
  host.addEventListener("click", (e) => {
    if (e.target.closest("[data-radd]")) { group.rules.push(newRule()); render(); onChange(); return; }
    const x = e.target.closest("[data-rx]");
    if (x) { group.rules.splice(Number(x.dataset.rx), 1); render(); onChange(); }
  });
  render();
}