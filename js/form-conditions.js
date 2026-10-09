// "Show this question only when…"
// A field can have showWhen = { match: "all" | "any", rules: [{ q, op, value }] }.
// Rules can only use questions ABOVE the field, so a form is worked out top to bottom in one pass.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (v, n) => String(v ?? "").slice(0, n);
const short = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const OPS = {
  choice: [["is", "is"], ["is_not", "is not"], ["answered", "is answered"], ["empty", "isn't answered"]],
  multi: [["has", "includes"], ["not_has", "doesn't include"], ["answered", "has something ticked"], ["empty", "has nothing ticked"]],
  number: [["eq", "equals"], ["ne", "doesn't equal"], ["gt", "is more than"], ["lt", "is less than"],
           ["gte", "is at least"], ["lte", "is at most"], ["answered", "is answered"], ["empty", "isn't answered"]],
  text: [["answered", "is answered"], ["empty", "isn't answered"], ["contains", "contains"]],
  date: [["answered", "is answered"], ["empty", "isn't answered"]],
  signature: [["answered", "is signed"], ["empty", "isn't signed"]],
  consent: [["found", "has a valid consent"], ["not_found", "has no valid consent"]],
};
const KIND = {
  single_choice: "choice", dropdown: "choice",
  checkboxes: "multi", checkbox_notes: "multi", sub_checks: "multi",
  number: "number", calculation: "number",
  short_text: "text", long_text: "text", email: "text",
  date: "date", record_date: "date",
  signature: "signature", consent_status: "consent",
};
const VALUE_OPS = ["is", "is_not", "has", "not_has", "eq", "ne", "gt", "lt", "gte", "lte", "contains"];
const ALL_OPS = [...new Set(Object.values(OPS).flat().map((o) => o[0]))];
export const NO_CONDITION = ["watermark", "letterhead"];

const kindOf = (f) => (f ? KIND[f.type] || null : null);
const needsValue = (op) => VALUE_OPS.includes(op);
const hasRules = (f) => !!(f && f.showWhen && Array.isArray(f.showWhen.rules) && f.showWhen.rules.length);
const opLabel = (kind, op) => {
  const o = (OPS[kind] || []).find((x) => x[0] === op);
  return o ? o[1] : op;
};

function choicesOf(f) {
  if (!f) return null;
  const other = f.allowOther ? [String(f.otherLabel || "").trim() || "Other"] : [];
  if (f.type === "sub_checks") {
    return [...(f.groups || []).map((g) => g.label).filter((s) => String(s).trim()), ...other];
  }
  if (["single_choice", "dropdown", "checkboxes", "checkbox_notes"].includes(f.type)) {
    return [...(f.options || []).filter((o) => String(o).trim()), ...other];
  }
  return null;
}

function sourcesFor(f, fields) {
  const idx = fields.findIndex((x) => x.id === f.id);
  return fields.slice(0, Math.max(0, idx)).filter((x) => kindOf(x));
}

function defaultRule(src) {
  const op = OPS[kindOf(src)][0][0];
  const choices = choicesOf(src);
  return { q: src.id, op, value: needsValue(op) ? (choices && choices[0]) || "" : "" };
}

/* ===================== Working out what's shown ===================== */

function blank(v) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}
function ticked(src, v) {
  if (!Array.isArray(v)) return [];
  return src.type === "checkboxes" ? v : v.map((r) => r && r.option);
}

function test(rule, src, v) {
  switch (rule.op) {
    case "answered": return !blank(v);
    case "empty": return blank(v);
    case "is": return v === rule.value;
    case "is_not": return !blank(v) && v !== rule.value;
    case "has": return ticked(src, v).includes(rule.value);
    case "not_has": return !ticked(src, v).includes(rule.value);
    case "contains":
      return typeof v === "string" && !!rule.value && v.toLowerCase().includes(String(rule.value).toLowerCase());
    case "found": return !!(v && v.found);
    case "not_found": return !(v && v.found);
  }
  const n = typeof v === "number" ? v : null;
  const t = Number(rule.value);
  if (n === null || rule.value === "" || !Number.isFinite(t)) return false;
  switch (rule.op) {
    case "eq": return n === t;
    case "ne": return n !== t;
    case "gt": return n > t;
    case "lt": return n < t;
    case "gte": return n >= t;
    case "lte": return n <= t;
  }
  return false;
}

// answers: saved-answer shapes, for questions above f. shown: ids already worked out as visible.
export function conditionPasses(f, answers, byId, shown) {
  if (!hasRules(f)) return true;
  const results = f.showWhen.rules.map((r) => {
    const src = byId.get(r.q);
    if (!src) return false;
    return test(r, src, shown.has(r.q) ? answers[r.q] : undefined); // a hidden question counts as unanswered
  });
  return f.showWhen.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

// Which fields show, given a full set of saved answers (saved forms, PDFs)
export function visibleIds(fields, answers) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const shown = new Set();
  fields.forEach((f) => { if (conditionPasses(f, answers || {}, byId, shown)) shown.add(f.id); });
  return shown;
}

/* ===================== Describing and checking ===================== */

export function conditionSummary(f, fields) {
  if (!hasRules(f)) return "";
  const byId = new Map(fields.map((x) => [x.id, x]));
  const join = f.showWhen.match === "any" ? " or " : " and ";
  return "Shown when " + f.showWhen.rules.map((r) => {
    const src = byId.get(r.q);
    if (!src) return "[removed question]";
    const kind = kindOf(src);
    const val = needsValue(r.op) ? ` ${kind === "number" ? r.value : `“${r.value}”`}` : "";
    return `“${short(src.label || "Untitled question")}” ${opLabel(kind, r.op)}${val}`;
  }).join(join);
}

// What's wrong with a field's conditions, or ""
export function conditionProblem(f, fields) {
  if (!hasRules(f)) return "";
  const idx = fields.findIndex((x) => x.id === f.id);
  for (const r of f.showWhen.rules) {
    const si = fields.findIndex((x) => x.id === r.q);
    if (si < 0) return "A condition uses a question that has been removed.";
    const src = fields[si];
    const name = short(src.label || "Untitled question");
    if (si >= idx) return `A condition uses “${name}”, which is now below this one. Move it above, or change the condition.`;
    const kind = kindOf(src);
    if (!kind || !OPS[kind].some((o) => o[0] === r.op)) return `The condition on “${name}” needs updating.`;
    if (needsValue(r.op)) {
      const choices = choicesOf(src);
      if (choices && !choices.includes(r.value)) return `A condition looks for “${r.value}”, which isn't an answer to “${name}” any more.`;
      if (kind === "number" && (r.value === "" || !Number.isFinite(Number(r.value)))) return `The condition on “${name}” needs a number.`;
      if (r.op === "contains" && !String(r.value).trim()) return `The condition on “${name}” needs some text to look for.`;
    }
  }
  return "";
}

/* ===================== Saving ===================== */

export function cleanCondition(f) {
  if (!hasRules(f) || NO_CONDITION.includes(f.type)) return null;
  return {
    match: f.showWhen.match === "any" ? "any" : "all",
    rules: f.showWhen.rules.slice(0, 10).map((r) => ({
      q: clip(r && r.q, 40),
      op: ALL_OPS.includes(r && r.op) ? r.op : "answered",
      value: clip(r && r.value, 200),
    })),
  };
}

/* ===================== Settings panel ===================== */

function ruleHtml(r, i, sw, byId, sources) {
  const src = byId.get(r.q);
  const kind = kindOf(src);
  const inList = sources.some((s) => s.id === r.q);
  const stale = inList ? "" : `<option value="${esc(r.q)}" selected>${
    src ? `${esc(short(src.label || "Untitled question"))} (now below)` : "Removed question"}</option>`;

  const qSel = `<select class="fb-select" data-rule="${i}" data-rk="q" data-rerender="" aria-label="Condition ${i + 1}: question">${stale}${
    sources.map((s) => `<option value="${esc(s.id)}"${s.id === r.q ? " selected" : ""}>${esc(short(s.label || "Untitled question", 48))}</option>`).join("")}</select>`;

  const opSel = kind
    ? `<select class="fb-select" data-rule="${i}" data-rk="op" data-rerender="" aria-label="Condition ${i + 1}: test">${
        OPS[kind].map(([v, l]) => `<option value="${v}"${v === r.op ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`
    : "";

  let val = "";
  if (kind && needsValue(r.op)) {
    const choices = choicesOf(src);
    if (choices) {
      const gone = r.value && !choices.includes(r.value)
        ? `<option value="${esc(r.value)}" selected>${esc(r.value)} (removed)</option>` : "";
      val = `<select class="fb-select" data-rule="${i}" data-rk="value" data-rerender="" aria-label="Condition ${i + 1}: answer">${gone}${
        choices.map((c) => `<option value="${esc(c)}"${c === r.value ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`;
    } else if (kind === "number") {
      val = `<input class="fe-input" type="number" data-rule="${i}" data-rk="value" value="${esc(r.value)}" placeholder="0" aria-label="Condition ${i + 1}: number" />`;
    } else {
      val = `<input class="fe-input" type="text" maxlength="200" data-rule="${i}" data-rk="value" value="${esc(r.value)}" placeholder="Text to look for" aria-label="Condition ${i + 1}: text" />`;
    }
  }

  return `
    ${i > 0 ? `<div class="fe-rule-join">${sw.match === "any" ? "or" : "and"}</div>` : ""}
    <div class="fe-rule">
      <div class="fe-rule-row">${qSel}<button type="button" class="hx-x" data-ruledel="${i}" aria-label="Remove condition ${i + 1}">${X}</button></div>
      <div class="fe-rule-row">${opSel}${val}</div>
    </div>`;
}

export function conditionSettingsHtml(f, fields) {
  if (NO_CONDITION.includes(f.type)) return "";
  const sources = sourcesFor(f, fields);
  const on = hasRules(f);
  const noun = ["text_block", "space"].includes(f.type) ? "block" : "question";

  if (!sources.length && !on) {
    return `<div class="fe-insp-field fe-cond"><span class="fe-insp-label">Show this ${noun}</span>
      <small class="fe-note">Always shown. To show it only for certain answers, add a question above it first.</small></div>`;
  }

  let h = `<div class="fe-insp-field fe-cond"><span class="fe-insp-label">Show this ${noun}</span>
    <select class="fb-select" data-cond="mode" data-rerender="">
      <option value="always"${on ? "" : " selected"}>Always</option>
      <option value="when"${on ? " selected" : ""}>Only when…</option>
    </select>`;

  if (on) {
    const sw = f.showWhen;
    const byId = new Map(fields.map((x) => [x.id, x]));
    if (sw.rules.length > 1) {
      h += `<select class="fb-select" data-cond="match" data-rerender="" aria-label="How conditions combine">
        <option value="all"${sw.match !== "any" ? " selected" : ""}>All of these are true (and)</option>
        <option value="any"${sw.match === "any" ? " selected" : ""}>Any of these is true (or)</option>
      </select>`;
    }
    h += sw.rules.map((r, i) => ruleHtml(r, i, sw, byId, sources)).join("");
    if (sw.rules.length < 10 && sources.length) {
      h += '<button type="button" class="hx-add" data-act="rule-add">+ Add another condition</button>';
    }
    const problem = conditionProblem(f, fields);
    if (problem) h += `<small class="fe-bad">${esc(problem)}</small>`;
  }
  return h + "</div>";
}

// Changes from the condition controls. Returns true if something changed.
export function applyConditionInput(f, el, fields) {
  if (el.dataset.cond === "mode") {
    if (el.value === "when") {
      if (!hasRules(f)) {
        const src = sourcesFor(f, fields).slice(-1)[0]; // the nearest question above
        if (!src) return false;
        f.showWhen = { match: "all", rules: [defaultRule(src)] };
      }
    } else {
      f.showWhen = null;
    }
    return true;
  }
  if (el.dataset.cond === "match") {
    if (hasRules(f)) f.showWhen.match = el.value === "any" ? "any" : "all";
    return true;
  }
  if (el.dataset.rule !== undefined && hasRules(f)) {
    const r = f.showWhen.rules[Number(el.dataset.rule)];
    if (!r) return false;
    const k = el.dataset.rk;
    if (k === "q") {
      const src = fields.find((x) => x.id === el.value);
      if (src && kindOf(src)) Object.assign(r, defaultRule(src)); // new question: its first answer is pre-chosen
      return true;
    }
    if (k === "op") {
      r.op = el.value;
      if (!needsValue(r.op)) r.value = "";
      else {
        const choices = choicesOf(fields.find((x) => x.id === r.q));
        if (choices && !choices.includes(r.value)) r.value = choices[0] || "";
      }
      return true;
    }
    if (k === "value") { r.value = clip(el.value, 200); return true; }
  }
  return false;
}

export function applyConditionClick(f, target, fields) {
  if (target.closest('[data-act="rule-add"]')) {
    const src = sourcesFor(f, fields).slice(-1)[0];
    if (src && hasRules(f) && f.showWhen.rules.length < 10) f.showWhen.rules.push(defaultRule(src));
    return true;
  }
  const del = target.closest("[data-ruledel]");
  if (del && hasRules(f)) {
    f.showWhen.rules.splice(Number(del.dataset.ruledel), 1);
    if (!f.showWhen.rules.length) f.showWhen = null;
    return true;
  }
  return false;
}