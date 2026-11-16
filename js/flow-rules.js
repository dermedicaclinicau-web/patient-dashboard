// Email flows: the rule builder. Used for "Only start for patients who…", daily checks, If / else rules and "Also stop when…".
// The field keys here must match FLOW_FIELD_TYPE_ in Code.gs, which works them out for each patient.

import { db } from "./firebase-config.js";
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";

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
export const SPEND_TIERS = [["platinum", "Platinum"], ["gold", "Gold"], ["silver", "Silver"], ["none", "No tier"]];
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

  // Task flows only (task: true): the task that started the flow
  { key: "task.answer", group: "This task", label: "An answer on the task", type: "answer", task: true },
  { key: "task.replied", group: "This task", label: "They replied to the task email", type: "bool", task: true },
  { key: "task.tx_booked", group: "This task", label: "Treatments in the email have an upcoming appointment", type: "txbooked", task: true,
    ops: [["none", "none of them"], ["notall", "not all of them"], ["all", "all of them"]],
    note: "Checked against their bookings in the appointment book at the moment the flow reaches this rule. Reviews and follow-ups don't count as booked." },

  { key: "hist.bought", group: "Purchase history", label: "Has ever bought", type: "products" },

  { key: "pkg.has", group: "Packages", label: "Has a package with visits left", type: "bool" },
  { key: "pkg.name", group: "Packages", label: "A package with visits left", type: "text", hint: "e.g. DermaGlow" },
  { key: "pkg.left", group: "Packages", label: "Visits left on their packages", type: "number" },
  { key: "pkg.expiry_days", group: "Packages", label: "Time until a package expires", type: "number", unit: "days",
    note: "Their soonest-expiring package with visits left. Packages with no expiry date don't count." },
  { key: "pkg.value", group: "Packages", label: "Value of visits left ($)", type: "number" },

  { key: "sent.txinfo", group: "Emails sent", label: "Was sent Treatment Info", type: "txsent",
    ops: [["yes", "was sent it"], ["no", "wasn't sent it"]],
    note: "Treatment Info emails sent after a consultation recording, and To Patient tasks with a Treatments field. Leave the treatments empty for any." },
  { key: "sent.tx_booked", group: "Emails sent", label: "Treatments in their last Treatment Info have an upcoming appointment", type: "txbooked",
    ops: [["none", "none of them"], ["notall", "not all of them"], ["all", "all of them"]],
    note: "Never matches if they've never been sent Treatment Info. Reviews and follow-ups don't count as booked." },
  { key: "sent.task", group: "Emails sent", label: "Was sent a Task Manager email", type: "tasksent",
    ops: [["yes", "was sent one"], ["no", "wasn't sent one"]] },
  { key: "hist.bought_between", group: "Purchase history", label: "Purchases between two dates", type: "prange",
    ops: [["last", "last bought between"], ["any", "bought between"], ["none", "didn't buy between"]] },
  { key: "hist.bought_days", group: "Purchase history", label: "Bought … days ago", type: "pdays",
    ops: [["exact", "bought exactly"], ["within", "bought in the last"], ["over", "last bought more than"], ["not_within", "didn't buy in the last"]] },
  { key: "hist.times", group: "Purchase history", label: "Times they've bought this product", type: "number" },
  { key: "hist.days_since", group: "Purchase history", label: "Time since their previous purchase", type: "number", unit: "days" },

  { key: "appt.has_future", group: "Appointments", label: "Has a future appointment booked", type: "bool" },
  { key: "appt.next_days", group: "Appointments", label: "Time until their next appointment", type: "number", unit: "days" },
  { key: "appt.last_days", group: "Appointments", label: "Time since their last visit", type: "number", unit: "days" },
  { key: "appt.visits", group: "Appointments", label: "Number of past visits", type: "number" },
  // legacy: replaced by the service picker rules below; only shown on rules that already use them
  { key: "appt.future_service", group: "Appointments", label: "A future booking's service", type: "text", hint: "e.g. Laser", legacy: true },
  { key: "appt.past_service", group: "Appointments", label: "A past visit's service", type: "text", hint: "e.g. Wrinkle Relaxer", legacy: true },
  { key: "appt.svc_lapsed", group: "Appointments", label: "Had one of these services", type: "svcs",
    ops: [["norebook", "and none of them is booked"], ["noappt", "and has no appointment booked at all"], ["any", "booked or not"]],
    note: "Search the services (e.g. Genesis), then tick them or press Select all. Checked against their recent visits and upcoming bookings." },
  { key: "appt.past_svcs", group: "Appointments", label: "Past visits included", type: "svcs",
    ops: [["any", "any of these"], ["none", "none of these"]] },
  { key: "appt.future_svcs", group: "Appointments", label: "Upcoming bookings include", type: "svcs",
    ops: [["any", "any of these"], ["none", "none of these"]] },
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
  { key: "pt.spend_tier", group: "Patient", label: "Spend tier (last 12 months)", type: "choice", options: SPEND_TIERS },
  { key: "pt.tag", group: "Patient", label: "Patient tag", type: "names" },
];
const FIELD = Object.fromEntries(RULE_FIELDS.map((f) => [f.key, f]));
// What the Recall flow offers: this recall, plus everything about the patient (not "this purchase" or "this visit")
export const RECALL_RULE_KEYS = RULE_FIELDS
  .filter((f) => f.recall || (!f.task && !["This purchase", "This visit"].includes(f.group) && f.key !== "hist.times"))
  .map((f) => f.key);
// What a "A task is sent" flow offers: this task, plus everything about the patient
export const TASK_RULE_KEYS = RULE_FIELDS
  .filter((f) => !f.recall && !["This purchase", "This visit"].includes(f.group) && f.key !== "hist.times")
  .map((f) => f.key);

const OPS = {
  bool: [["yes", "Yes"], ["no", "No"]],
  number: [["gt", "more than"], ["lt", "less than"], ["eq", "exactly"]],
  text: [["contains", "contains"], ["not_contains", "doesn't contain"]],
  products: [["any", "any of"], ["none", "none of"]],
  names: [["any", "is one of"], ["none", "is not one of"]],
  choice: [["is", "is"], ["not", "is not"]],
  form: [["has", "has one named"], ["none", "has none named"]],
  answer: [["is", "is"], ["contains", "contains"], ["not_contains", "doesn't contain"], ["filled", "has an answer"], ["empty", "is empty"]],
};
const opsFor = (f) => f.ops || OPS[f.type] || OPS.bool;
function defaults(f) {
  const list = f.type === "products" || f.type === "names" || f.type === "prange" || f.type === "pdays" || f.type === "txsent" || f.type === "svcs";
  return { op: opsFor(f)[0][0], value: list ? [] : f.type === "choice" ? f.options[0][0] : "", days: "",
    ...(f.type === "svcs" ? { when: "any" } : {}),
    ...(f.type === "txsent" ? { src: "any" } : {}),
    ...(f.type === "range" || f.type === "prange" ? { from: "", to: "" } : {}),
    ...(f.type === "year" ? { value2: "" } : {}),
    ...(f.type === "answer" ? { fieldId: "", fieldLabel: "" } : {}) };
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
  if (f.type === "products" || f.type === "names" || f.type === "prange" || f.type === "pdays" || f.type === "txsent" || f.type === "svcs") value = (Array.isArray(value) ? value : []).map(String).filter(Boolean).slice(0, 40);
  else if (f.type === "number" || f.type === "birthday" || f.type === "year") value = value === "" || value === null || value === undefined ? "" : Number(value);
  else if (f.type === "choice") value = f.options.some((o) => o[0] === value) ? value : d.value;
  else if (f.type === "bool") value = "";
  else value = String(value ?? "");
  const days = ["form", "pdays", "txbooked", "txsent", "tasksent", "svcs"].includes(f.type) && r.days !== "" && r.days !== null && r.days !== undefined ? Number(r.days) : "";
  const out = { id: String(r.id || rid()), field: f.key, op, value, days };
  if (f.type === "txsent") out.src = ["rec", "task"].includes(r.src) ? r.src : "any";
  if (f.type === "svcs") {
    out.when = ["over", "within"].includes(r.when) ? r.when : "any";
    if (out.when === "any") out.days = "";
  }
  if (f.type === "range" || f.type === "prange") { out.from = isIso(r.from) ? r.from : ""; out.to = isIso(r.to) ? r.to : ""; }
  if (f.type === "year") out.value2 = r.value2 === "" || r.value2 === null || r.value2 === undefined ? "" : Number(r.value2);
  if (f.type === "answer") {
    out.fieldId = String(r.fieldId || "").slice(0, 40);
    out.fieldLabel = String(r.fieldLabel || "").slice(0, 120);
  }
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
  if (f.type === "answer") {
    if (!r.fieldId) return 'Choose which answer to check in "An answer on the task"';
    if (!["empty", "filled"].includes(r.op) && !String(r.value || "").trim()) return `Fill in what "${r.fieldLabel || "the answer"}" should be`;
  }
  if (f.type === "svcs") {
    if (!(Array.isArray(r.value) && r.value.length)) return `Choose at least one service for "${f.label}"`;
    if (r.when === "over" || r.when === "within") {
      const n = Number(r.days);
      if (r.days === "" || !Number.isInteger(n) || n < 1 || n > 1095) return `Choose 1 to 1095 days for "${f.label}"`;
    }
  }
  if ((f.type === "txsent" || f.type === "tasksent") && r.days !== "" && r.days !== null && r.days !== undefined) {
    const n = Number(r.days);
    if (!Number.isInteger(n) || n < 1 || n > 730) return `Choose 1 to 730 days for "${f.label}", or leave it empty for any time`;
  }
  if (f.type === "txbooked" && r.days !== "" && r.days !== null && r.days !== undefined) {
    const n = Number(r.days);
    if (!Number.isInteger(n) || n < 1 || n > 730) return "Choose 1 to 730 days for how far ahead to look, or leave it empty for any time";
  }
  if (f.type === "pdays") {
    const n = Number(r.days);
    const min = r.op === "exact" ? 0 : 1;   // "exactly 0 days ago" = today
    if (r.days === "" || !Number.isInteger(n) || n < min || n > 730) return `Choose ${min} to 730 days for "Bought … days ago"`;
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
  if (f.type === "txbooked") {
    const when = r.days ? `in the next ${r.days} day${Number(r.days) === 1 ? "" : "s"}` : "any time from today";
    const src = r.field === "sent.tx_booked" ? "their last Treatment Info" : "the email";
    const what = r.op === "all" ? `Every treatment in ${src} is booked`
      : r.op === "notall" ? `At least one treatment in ${src} isn't booked`
      : `None of the treatments in ${src} are booked`;
    return `${what} (${when})`;
  }
  if (f.type === "svcs") {
    const list = Array.isArray(r.value) ? r.value : [];
    const what = list.length ? (list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ")) : "…";
    const when = r.when === "over" && r.days ? `, last one more than ${r.days} days ago`
      : r.when === "within" && r.days ? `, last one in the last ${r.days} days` : "";
    if (r.field === "appt.future_svcs") return `Upcoming bookings include ${r.op === "none" ? "none" : "any"} of ${what}`;
    if (r.field === "appt.past_svcs") return `Past visits included ${r.op === "none" ? "none" : "any"} of ${what}${when}`;
    return `Had ${what}${when}${r.op === "norebook" ? ", none of them booked" : r.op === "noappt" ? ", no appointment booked" : ""}`;
  }
  if (f.type === "txsent") {
    const list = Array.isArray(r.value) ? r.value : [];
    const about = list.length ? ` about ${list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ")}` : "";
    const src = r.src === "rec" ? " after a recording" : r.src === "task" ? " from Task Manager" : "";
    const when = r.days ? ` in the last ${r.days} day${Number(r.days) === 1 ? "" : "s"}` : "";
    return `${r.op === "no" ? "Wasn't sent" : "Was sent"} Treatment Info${about}${src}${when}`;
  }
  if (f.type === "tasksent") {
    const when = r.days ? ` in the last ${r.days} day${Number(r.days) === 1 ? "" : "s"}` : "";
    return `${r.op === "no" ? "Wasn't sent" : "Was sent"} ${r.value ? `the task “${r.value}”` : "a Task Manager email"}${when}`;
  }
  if (f.type === "bool") return `${f.label}: ${op}`;
  if (f.type === "prange") {
    const list = Array.isArray(r.value) ? r.value : [];
    const what = list.length ? (list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ")) : "any product";
    const verb = r.op === "last" ? "Last bought" : r.op === "none" ? "Didn't buy" : "Bought";
    return `${verb} ${what} between ${niceDay(r.from)} and ${niceDay(r.to)}`;
  }
  if (f.type === "pdays") {
    const list = Array.isArray(r.value) ? r.value : [];
    const what = list.length ? (list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ")) : "any product";
    const n = r.days === "" ? "…" : r.days;
    const d = `${n} day${Number(n) === 1 ? "" : "s"}`;
    if (r.op === "within") return `Bought ${what} in the last ${d}`;
    if (r.op === "over") return `Last bought ${what} more than ${d} ago`;
    if (r.op === "not_within") return `Didn't buy ${what} in the last ${d}`;
    return Number(n) === 0 ? `Bought ${what} today` : `Bought ${what} exactly ${d} ago`;
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
  if (f.type === "answer") {
    const who = `Answer to "${r.fieldLabel || "…"}"`;
    return r.op === "empty" || r.op === "filled" ? `${who} ${op}` : `${who} ${op} "${r.value || "…"}"`;
  }
  if (f.type === "form") return `${f.label} ${op} "${r.value || "…"}"${r.days ? ` in the last ${r.days} days` : ""}`;
  return `${f.label} ${op} "${r.value || "…"}"`;
}
function describeItem(x, full = false) {
  if (!isGroup(x)) return describeRule(x);
  if (!x.rules.length) return "(an empty group)";
  const j = x.match === "any" ? " or " : " and ";
  const list = full ? x.rules : x.rules.slice(0, 2);
  return `(${list.map(describeRule).join(j)}${!full && x.rules.length > 2 ? `${j}…` : ""})`;
}
// Short: up to 3 items, then "and 2 more"
export function describeGroup(g) {
  const rules = (g && g.rules) || [];
  if (!rules.length) return "No rules yet";
  const j = g.match === "any" ? " or " : " and ";
  const shown = rules.slice(0, 3).map((x) => describeItem(x)).join(j);
  return rules.length > 3 ? `${shown}${j}${rules.length - 3} more` : shown;
}
// Everything, with groups in brackets
export function describeAll(g) {
  const rules = (g && g.rules) || [];
  const j = g && g.match === "any" ? " or " : " and ";
  return rules.map((x) => describeItem(x, true)).join(j);
}

// Rules that can never all be true together, or that do nothing. Shown under the rules; they don't stop saving.
export function groupWarnings(g, { email = false } = {}) {
  const out = new Set();
  const rules = (g && g.rules) || [];
  const label = (k) => (FIELD[k] ? FIELD[k].label : k);
  const check = (items, match) => {
    const list = items.filter((x) => x && !isGroup(x) && FIELD[x.field]);
    const seen = new Set();
    list.forEach((r) => {
      const k = JSON.stringify([r.field, r.op, r.value, r.value2, r.days, r.from, r.to, r.when, r.src]);
      if (seen.has(k)) out.add(`“${describeRule(r)}” is in there twice.`);
      seen.add(k);
    });
    const has = (k, op) => list.some((r) => r.field === k && (!op || r.op === op));
    if (email && match === "any" && has("pt.email", "yes") && items.length > 1)
      out.add("With “any”, “Has an email address: Yes” matches nearly everyone on its own. Did you mean “all”?");
    if (match !== "all") return;
    if (email && has("pt.email", "no"))
      out.add("“Has an email address: No” means nobody gets this: patients with no email address are always left out of email campaigns.");
    ["appt.has_future", "pkg.has", "ssp.active", "pt.email", "pt.mobile", "plan.due", "plan.overdue"].forEach((k) => {
      if (has(k, "yes") && has(k, "no")) out.add(`“${label(k)}” is set to both Yes and No, so nobody can match.`);
    });
    if (has("appt.has_future", "no") && (has("appt.next_days") || has("appt.future_svcs", "any")))
      out.add("“Has a future appointment booked: No” can't go with a rule about their next booking.");
    if (has("appt.has_future", "yes") && has("appt.svc_lapsed", "noappt"))
      out.add("“Has a future appointment booked: Yes” can't go with “…and has no appointment booked at all”.");
    if (has("pkg.has", "no") && (has("pkg.left") || has("pkg.expiry_days") || has("pkg.value") || has("pkg.name", "contains")))
      out.add("“Has a package with visits left: No” can't go with another package rule (only “doesn't contain” works with it).");
    if (list.some((r) => r.field === "plan.status" && r.op === "is" && r.value === "none") && (has("plan.due", "yes") || has("plan.overdue", "yes")))
      out.add("“No treatment plan” can't go with a treatment being due.");
    if (list.some((r) => r.field === "appt.visits" && ((r.op === "eq" && Number(r.value) === 0) || (r.op === "lt" && Number(r.value) <= 1)))
      && (has("appt.last_days") || has("appt.past_svcs", "any") || has("appt.svc_lapsed")))
      out.add("“No past visits” can't go with a rule about their past visits.");
    // The same number pulled two ways, e.g. more than 90 and less than 30
    const nums = {};
    list.forEach((r) => {
      if (FIELD[r.field].type !== "number" || r.value === "" || !Number.isFinite(Number(r.value))) return;
      const n = Number(r.value);
      const x = nums[r.field] || (nums[r.field] = { lo: -Infinity, hi: Infinity, eq: [] });
      if (r.op === "gt") x.lo = Math.max(x.lo, n);
      else if (r.op === "lt") x.hi = Math.min(x.hi, n);
      else x.eq.push(n);
    });
    Object.entries(nums).forEach(([k, x]) => {
      const eqBad = new Set(x.eq).size > 1 || x.eq.some((n) => n <= x.lo || n >= x.hi);
      if (eqBad || x.lo >= x.hi) out.add(`The “${label(k)}” rules can't all be true at once, so nobody can match.`);
    });
  };
  check(rules, g && g.match);
  rules.filter(isGroup).forEach((x) => check(x.rules, x.match));
  return [...out];
}

// Common audiences: added as normal rules that can be changed afterwards
export const PRESETS = [
  { name: "Haven't been back in 6+ months", rules: [{ field: "appt.last_days", op: "gt", value: 180 }, { field: "appt.has_future", op: "no" }] },
  { name: "Came once and didn't come back", rules: [{ field: "appt.visits", op: "eq", value: 1 }, { field: "appt.last_days", op: "gt", value: 60 }, { field: "appt.has_future", op: "no" }] },
  { name: "Birthday this month", rules: [{ field: "pt.birthday", op: "month" }] },
  { name: "Package expiring in the next 30 days", rules: [{ field: "pkg.expiry_days", op: "lt", value: 31 }] },
  { name: "Has a package, no visit in 90+ days", rules: [{ field: "pkg.has", op: "yes" }, { field: "appt.last_days", op: "gt", value: 90 }, { field: "appt.has_future", op: "no" }] },
  { name: "Sent Treatment Info, nothing booked", rules: [{ field: "sent.txinfo", op: "yes", days: 90 }, { field: "sent.tx_booked", op: "none" }] },
  { name: "Skin Script expiring in the next 30 days", rules: [{ field: "ssp.active", op: "yes" }, { field: "ssp.expiry_days", op: "lt", value: 31 }] },
  { name: "Treatment overdue, not booked", rules: [{ field: "plan.overdue", op: "yes" }, { field: "appt.has_future", op: "no" }] },
  { name: "Top spenders (Gold or Platinum)", rules: [{ type: "group", match: "any", rules: [
    { field: "pt.spend_tier", op: "is", value: "platinum" }, { field: "pt.spend_tier", op: "is", value: "gold" }] }] },
];
const presetKeys = (rs) => rs.flatMap((x) => (x.type === "group" ? presetKeys(x.rules) : [x.field]));
const fromPreset = (x) => (x.type === "group"
  ? { id: rid(), type: "group", match: x.match === "any" ? "any" : "all", rules: x.rules.map(fromPreset) }
  : cleanRule({ ...newRule(x.field), ...x, id: rid() }));

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
// The clinic's patient tags, by name (ui_settings/patient_tags), for the "Patient tag" rule
const STARTER_TAG_NAMES = ["Doesn't live in Perth", "Prefers text", "Prefers email", "Call after 3pm", "VIP"];
let tagNamesCache = null;
export async function loadTagNames() {
  if (tagNamesCache) return tagNamesCache;
  try {
    const d = await getDoc(doc(db, "ui_settings", "patient_tags"));
    const list = d.exists() && Array.isArray(d.data().tags) ? d.data().tags : null;
    tagNamesCache = list ? list.map((t) => String((t && t.label) || "").trim()).filter(Boolean) : STARTER_TAG_NAMES.slice();
  } catch (err) {
    console.warn("Patient tags not loaded:", err);
    tagNamesCache = [];
  }
  return tagNamesCache;
}
// Treatment names (TREATMENT-CONFIGURATIONS), for the "Was sent Treatment Info" rule
let txNamesCache = null;
export async function loadTxNames() {
  if (txNamesCache) return txNamesCache;
  try {
    const snap = await getDocs(collection(db, "TREATMENT-CONFIGURATIONS"));
    const out = new Map();
    snap.forEach((d) => {
      const n = String((d.data() || {})["Treatment Name"] || "").replace(/\s+/g, " ").trim();
      if (n) out.set(n.toLowerCase(), n);
    });
    txNamesCache = [...out.values()].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.warn("Treatment names not loaded:", err);
    txNamesCache = [];
  }
  return txNamesCache;
}
// Every service in the appointment book, most used first: [{ service, n }]
let bookSvcCache = null;
export async function loadBookServices() {
  if (bookSvcCache) return bookSvcCache;
  for (const action of ["marketing", "emailFlow"]) {
    try {
      const res = await callApi({ action, op: "services" });
      if (res && Array.isArray(res.services)) { bookSvcCache = res.services; return bookSvcCache; }
    } catch (err) { /* no access, or an older Apps Script: try the next */ }
  }
  bookSvcCache = (await loadServiceNames()).map((s) => ({ service: s, n: 0 }));
  return bookSvcCache;
}

// Chosen services as chips, a search box, and a tick list with "Select all". arr is changed in place.
// A typed word (e.g. "genesis") matches every service containing it.
export function mountServicePicker(host, arr, { onChange = () => {} } = {}) {
  const MAXN = 40;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let q = "";
  let all = bookSvcCache;
  host.innerHTML = `<div class="fr-chips" data-sp-chips></div>
    <input class="fe-input fr-sp-q" data-sp-q maxlength="80" placeholder="Search services, e.g. Genesis" aria-label="Search services" />
    <div data-sp-body></div>`;
  const chipsEl = host.querySelector("[data-sp-chips]");
  const body = host.querySelector("[data-sp-body]");
  const has = (s) => arr.some((x) => x.toLowerCase() === String(s).toLowerCase());
  const add = (s) => { if (!has(s) && arr.length < MAXN) { arr.push(s); return true; } return false; };
  const drawChips = () => {
    chipsEl.innerHTML = arr.length ? arr.map((n, i) => `<span class="fr-chip">${esc(n)}
      <button type="button" data-sp-x="${i}" aria-label="Remove ${esc(n)}" title="Remove">×</button></span>`).join("")
      : '<span class="fr-none">No services chosen yet</span>';
  };
  const drawBody = () => {
    if (!all) { body.innerHTML = '<p class="fr-note">Loading services…</p>'; return; }
    const nq = norm(q);
    const shown = all.filter((s) => !nq || norm(s.service).includes(nq));
    const notYet = shown.filter((s) => !has(s.service));
    const word = q.trim();
    body.innerHTML = `
      <div class="fr-sp-acts">
        ${nq && notYet.length ? `<button type="button" class="lh-btn" data-sp-all>Select all ${notYet.length} shown</button>` : ""}
        ${nq && !has(word) ? `<button type="button" class="lh-btn is-quiet" data-sp-word>Any service containing “${esc(word)}”</button>` : ""}
      </div>
      <div class="fr-sp-list">${shown.slice(0, 60).map((s) => `<label class="fr-sp-row">
          <input type="checkbox" data-sp-c="${esc(s.service)}"${has(s.service) ? " checked" : ""} />
          <span>${esc(s.service)}</span>${s.n ? `<small>${Number(s.n).toLocaleString("en-AU")}</small>` : ""}</label>`).join("")
        || '<p class="fr-note">No services match. Use "Any service containing" to keep the word.</p>'}</div>
      ${shown.length > 60 ? `<p class="fr-note">${shown.length - 60} more. Type more to narrow it down, or use Select all.</p>` : ""}
      ${arr.length >= MAXN ? `<p class="fr-note">Up to ${MAXN} can be chosen. Use "Any service containing" to cover many at once.</p>` : ""}`;
  };
  const changed = () => { drawChips(); drawBody(); onChange(); };
  host.addEventListener("input", (e) => { if (e.target.matches("[data-sp-q]")) { q = e.target.value; drawBody(); } });
  host.addEventListener("keydown", (e) => { if (e.target.matches("[data-sp-q]") && e.key === "Enter") e.preventDefault(); });
  host.addEventListener("change", (e) => {
    const c = e.target.closest("[data-sp-c]");
    if (!c) return;
    const s = c.dataset.spC;
    if (c.checked) add(s);
    else { const i = arr.findIndex((x) => x.toLowerCase() === s.toLowerCase()); if (i >= 0) arr.splice(i, 1); }
    changed();
  });
  host.addEventListener("click", (e) => {
    const x = e.target.closest("[data-sp-x]");
    if (x) { arr.splice(Number(x.dataset.spX), 1); changed(); return; }
    if (e.target.closest("[data-sp-all]")) {
      const nq = norm(q);
      all.filter((s) => norm(s.service).includes(nq)).forEach((s) => add(s.service));
      changed();
      return;
    }
    if (e.target.closest("[data-sp-word]")) { add(q.trim().slice(0, 80)); changed(); }
  });
  drawChips();
  drawBody();
  if (!all) loadBookServices().then((l) => { all = l; if (host.isConnected) drawBody(); });
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
// presets: offer "Start from a common audience". email: warn about rules that mean nobody gets an email.
export function mountRuleBuilder(host, group, { onChange = () => {}, names = [], empty = "", only = null, lists = {}, presets = false, email = false } = {}) {
  const fields = Array.isArray(only) ? RULE_FIELDS.filter((f) => only.includes(f.key)) : RULE_FIELDS.filter((f) => !f.recall && !f.task);
  const GROUP_ORDER = ["This recall", "This purchase", "This visit", "This task", "Patient", "Appointments", "Packages",
    "Purchase history", "Skin Script", "Treatment plan", "Emails sent", "Saved forms"];
  const gi = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? 99 : i; };
  const groups = [...new Set(fields.map((f) => f.group))].sort((a, b) => gi(a) - gi(b));
  const keySet = new Set(fields.map((f) => f.key));
  const presetList = presets ? PRESETS.filter((p) => presetKeys(p.rules).every((k) => keySet.has(k))) : [];
  // Every change also refreshes the summary and warnings
  const notify = onChange;
  onChange = () => { drawInfo(); notify(); };
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
      `<optgroup label="${esc(g)}">${fields.filter((x) => x.group === g && (!x.legacy || x.key === r.field)).map((x) =>
        `<option value="${x.key}"${x.key === r.field ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</optgroup>`).join("")}</select>`;
    const opSel = `<select class="fb-select fr-op" data-ro="${p}" aria-label="How to compare">${opsFor(f).map(([v, l]) =>
      `<option value="${v}"${v === r.op ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    let val = "";
    let quick = "";
    let pre = "";
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
    } else if (f.type === "answer") {
      // lists["task.answer"]: the task's fields, [{ id, label, options: ["…"] }]
      const fl = lists[r.field] || [];
      const cur = fl.find((x) => x.id === r.fieldId);
      pre = `<select class="fb-select fr-field" data-rk="${p}" aria-label="Which answer">
        <option value="">Choose a field…</option>
        ${fl.map((x) => `<option value="${esc(x.id)}"${x.id === r.fieldId ? " selected" : ""}>${esc(x.label)}</option>`).join("")}
        ${r.fieldId && !cur ? `<option value="${esc(r.fieldId)}" selected>${esc(r.fieldLabel || "A field that's been removed")} (removed)</option>` : ""}
      </select>`;
      if (r.op !== "empty" && r.op !== "filled") {
        const dl = cur && Array.isArray(cur.options) && cur.options.length ? `fa_${rid()}` : "";
        val = `<input class="fe-input fr-val" data-rv="${p}" maxlength="120" placeholder="e.g. Yes" value="${esc(r.value)}" aria-label="Answer"${dl ? ` list="${dl}"` : ""} />
          ${dl ? `<datalist id="${dl}">${cur.options.map((o) => `<option value="${esc(o)}"></option>`).join("")}</datalist>` : ""}`;
      }
    } else if (f.type === "form") {
      val = `<input class="fe-input fr-val" data-rv="${p}" maxlength="80" placeholder="e.g. Consent" value="${esc(r.value)}" aria-label="Form name" />
        <span class="fr-unit">in the last</span>
        <input class="fe-input fr-num" type="number" min="0" step="1" data-rd="${p}" value="${esc(r.days)}" placeholder="any" aria-label="Days" />
        <span class="fr-unit">days</span>`;
    } else if (f.type === "svcs") {
      if (r.field !== "appt.future_svcs") {
        const w = r.when || "any";
        val = `<span class="fr-unit">last one</span>
          <select class="fb-select fr-val" data-rw="${p}" aria-label="When">
            <option value="any"${w === "any" ? " selected" : ""}>any time</option>
            <option value="over"${w === "over" ? " selected" : ""}>more than</option>
            <option value="within"${w === "within" ? " selected" : ""}>in the last</option></select>
          ${w !== "any" ? `<input class="fe-input fr-num" type="number" min="1" max="1095" step="1" inputmode="numeric" data-rd="${p}" value="${esc(r.days)}" placeholder="90" aria-label="Days" />
          <span class="fr-unit">${w === "over" ? "days ago" : "days"}</span>` : ""}`;
      }
    } else if (f.type === "txsent") {
      val = `<select class="fb-select fr-val" data-rs="${p}" aria-label="Sent from">
          <option value="any"${r.src !== "rec" && r.src !== "task" ? " selected" : ""}>either way</option>
          <option value="rec"${r.src === "rec" ? " selected" : ""}>after a recording</option>
          <option value="task"${r.src === "task" ? " selected" : ""}>from Task Manager</option></select>
        <span class="fr-unit">in the last</span>
        <input class="fe-input fr-num" type="number" min="1" max="730" step="1" inputmode="numeric" data-rd="${p}" value="${esc(r.days)}" placeholder="any" aria-label="Days" />
        <span class="fr-unit">days</span>`;
    } else if (f.type === "tasksent") {
      val = `<input class="fe-input fr-val" data-rv="${p}" maxlength="80" placeholder="Task name, or empty for any" value="${esc(r.value)}" aria-label="Task name" />
        <span class="fr-unit">in the last</span>
        <input class="fe-input fr-num" type="number" min="1" max="730" step="1" inputmode="numeric" data-rd="${p}" value="${esc(r.days)}" placeholder="any" aria-label="Days" />
        <span class="fr-unit">days</span>`;
    } else if (f.type === "txbooked") {
      val = `<span class="fr-unit">booked in the next</span>
        <input class="fe-input fr-num" type="number" min="1" max="730" step="1" inputmode="numeric" data-rd="${p}" value="${esc(r.days)}" placeholder="any" aria-label="Days ahead" />
        <span class="fr-unit">days</span>`;
    } else if (f.type === "pdays") {
      val = `<input class="fe-input fr-num" type="number" min="0" max="730" step="1" inputmode="numeric" data-rd="${p}" value="${esc(r.days)}" placeholder="14" aria-label="Days" />
        <span class="fr-unit">day${Number(r.days) === 1 ? "" : "s"}${r.op === "exact" || r.op === "over" ? " ago" : ""}</span>`;
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
      ${join ? `<button type="button" class="fr-join" data-jt="${p}" title="Switch between and / or">${join}</button>` : ""}
      <div class="fr-row">${fieldSel}</div>
      ${pre ? `<div class="fr-row">${pre}</div>` : ""}
      <div class="fr-row">${opSel}${val}
        <button type="button" class="fr-x" data-rx="${p}" aria-label="Remove this rule" title="Remove">×</button></div>
      ${f.note ? `<p class="fr-note">${esc(f.note)}</p>` : ""}
      ${quick}
      ${f.type === "products" || f.type === "names" || f.type === "prange" || f.type === "pdays" || f.type === "txsent" || f.type === "svcs" ? `<div class="fr-pp" data-pp-host="${p}"></div>` : ""}
    </div>`;
  }

  function groupHtml(g, i, join, canAdd) {
    const inner = g.match === "any" ? "or" : "and";
    return `<div class="fr-rule fr-group-wrap">
      ${join ? `<button type="button" class="fr-join" data-jt="${i}" title="Switch between and / or">${join}</button>` : ""}
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
      ${group.rules.length > 1 ? `<label class="fr-match">Match ${matchSel('data-rm aria-label="Match all or any"', group.match)} of these
        <small class="fr-hint">${group.match === "any" ? "at least one must be true" : "every one must be true"}</small></label>` : ""}
      ${group.rules.length ? `<div class="fr-rules">${group.rules.map((x, i) => (isGroup(x)
        ? groupHtml(x, i, i ? join : "", canAdd)
        : ruleHtml(x, String(i), i ? join : ""))).join("")}</div>` : (empty ? `<p class="fr-empty">${esc(empty)}</p>` : "")}
      <div data-fr-info></div>
      ${room ? `<div class="fr-adds">
        <button type="button" class="fr-add" data-radd>+ Add a rule</button>
        <button type="button" class="fr-add" data-gnew>+ Add a group</button>
        ${presetList.length ? `<select class="fb-select fr-preset" data-preset aria-label="Common audiences">
          <option value="">${group.rules.length ? "+ Add a common audience…" : "Start from a common audience…"}</option>
          ${presetList.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("")}</select>` : ""}
      </div>` : ""}
    </div>`;
    drawInfo();
    host.querySelectorAll("[data-pp-host]").forEach((el) => {
      const r = ruleAt(el.dataset.ppHost);
      if (!r) return;
      if (!Array.isArray(r.value)) r.value = [];
      const f = FIELD[r.field];
      if (f && f.type === "names") {
        mountProductPicker(el, r.value, { onChange, names: lists[r.field] || (r.field === "pt.tag" ? tagNamesCache || [] : []),
          placeholder: "Choose or type one", none: "None chosen yet" });
      } else if (f && f.type === "svcs") {
        mountServicePicker(el, r.value, { onChange });
      } else if (f && f.type === "txsent") {
        mountProductPicker(el, r.value, { onChange, names: txNamesCache || [],
          placeholder: "Type a treatment, or leave empty for any", none: "Any treatment" });
      } else if (f && (f.type === "prange" || f.type === "pdays")) {
        mountProductPicker(el, r.value, { onChange, names, placeholder: "Type a product, or leave empty for any", none: "Any product" });
      } else {
        mountProductPicker(el, r.value, { onChange, names });
      }
    });
  }

  // The full logic in words, and anything that can't work
  function drawInfo() {
    const box = host.querySelector("[data-fr-info]");
    if (!box) return;
    const warns = groupWarnings(group, { email });
    box.innerHTML = (ruleCount(group) > 1 ? `<p class="fr-summary"><strong>Who matches:</strong> ${esc(describeAll(group))}</p>` : "") +
      (warns.length ? `<div class="fr-warn" role="status">${warns.map((w) => `<p>⚠ ${esc(w)}</p>`).join("")}</div>` : "");
  }
  // "All" rules: added alongside. "Any" rules: added as one group, so the audience stays together.
  function addPreset(p) {
    if (!p) return;
    const items = p.rules.map(fromPreset);
    const n = items.reduce((t, x) => t + (isGroup(x) ? x.rules.length : 1), 0);
    if (ruleCount(group) + n > TOTAL || group.rules.length + items.length > MAX) { render(); return; }
    if (!group.rules.length) { group.match = "all"; group.rules.push(...items); }
    else if (group.match === "all") group.rules.push(...items);
    else if (items.some(isGroup)) items.forEach((x) => (isGroup(x) ? group.rules.push(...x.rules) : group.rules.push(x)));
    else group.rules.push(items.length === 1 ? items[0] : { id: rid(), type: "group", match: "all", rules: items });
    render();
    onChange();
  }

  host.addEventListener("input", (e) => {
    const el = e.target;
    const d = el.dataset;
    if (d.preset !== undefined) { if (el.value !== "") addPreset(presetList[Number(el.value)]); return; }
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
    if (d.rw !== undefined) {
      const r = ruleAt(d.rw);
      if (!r) return;
      r.when = ["over", "within"].includes(el.value) ? el.value : "any";
      if (r.when === "any") r.days = "";
      else if (r.days === "") r.days = 90;
      render();
      onChange();
      return;
    }
    if (d.rs !== undefined) {
      const r = ruleAt(d.rs);
      if (!r) return;
      r.src = ["rec", "task"].includes(el.value) ? el.value : "any";
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
    if (d.rk !== undefined) {
      const r = ruleAt(d.rk);
      if (!r) return;
      r.fieldId = el.value;
      r.fieldLabel = el.value ? String(el.selectedOptions[0].textContent || "").replace(/\s*\(removed\)$/, "").trim() : "";
      render();
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
      if (ft === "answer") render(); // "has an answer" / "is empty" have no value box
      if (ft === "pdays") render();  // "days ago" or "days"
    }
    else if (d.rd !== undefined) r.days = el.value === "" ? "" : Number(el.value);
    else r.value = ft === "number" || ft === "birthday" || ft === "year" ? (el.value === "" ? "" : Number(el.value)) : el.value;
    onChange();
  });

  host.addEventListener("click", (e) => {
    const jt = e.target.closest("[data-jt]");
    if (jt) {
      const [a, b] = String(jt.dataset.jt).split(".").map(Number);
      const g = b === undefined || Number.isNaN(b) ? group : group.rules[a];
      if (g) { g.match = g.match === "any" ? "all" : "any"; render(); onChange(); }
      return;
    }
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
  // The treatment names arrive a moment later; the picker is redrawn with them
  if (!txNamesCache && fields.some((f) => f.type === "txsent")) {
    loadTxNames().then(() => { if (host.isConnected) render(); });
  }
  if (!tagNamesCache && fields.some((f) => f.key === "pt.tag")) {
    loadTagNames().then(() => { if (host.isConnected) render(); });
  }
}