// Safe formula engine: no eval(). Formulas are split into tokens, converted to
// reverse Polish notation, then worked out step by step.
// Supports + - * / ( ) , numbers, {fieldId} references,
// comparisons > < >= <= = <> and ROUND FLOOR CEIL ABS SUM MIN MAX AVG IF.

const round = (fn) => (a) => {
  const p = 10 ** (a.length > 1 ? Math.round(a[1]) : 0);
  return fn(a[0] * p) / p;
};
const FNS = {
  ROUND: round(Math.round),
  FLOOR: round(Math.floor),
  CEIL: round(Math.ceil),
  ABS: (a) => Math.abs(a[0]),
  SUM: (a) => a.reduce((x, y) => x + y, 0),
  MIN: (a) => Math.min(...a),
  MAX: (a) => Math.max(...a),
  AVG: (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0),
  IF: (a) => (a[0] ? a[1] : a.length > 2 ? a[2] : 0),
};
const OPS = {
  "+": [1, (a, b) => a + b],
  "-": [1, (a, b) => a - b],
  "*": [2, (a, b) => a * b],
  "/": [2, (a, b) => (b === 0 ? NaN : a / b)],
  ">": [0, (a, b) => (a > b ? 1 : 0)],
  "<": [0, (a, b) => (a < b ? 1 : 0)],
  ">=": [0, (a, b) => (a >= b ? 1 : 0)],
  "<=": [0, (a, b) => (a <= b ? 1 : 0)],
  "=": [0, (a, b) => (a === b ? 1 : 0)],
  "<>": [0, (a, b) => (a !== b ? 1 : 0)],
};

function tokenize(src) {
  const s = String(src || "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "{") {
      const end = s.indexOf("}", i);
      if (end < 0) throw new Error("A question reference is missing its closing }.");
      out.push({ t: "ref", v: s.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (num) { out.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const word = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (word) { out.push({ t: "fn", v: word[0].toUpperCase() }); i += word[0].length; continue; }
    const two = s.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "<>") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/(),<>=".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`"${c}" can't be used in a formula.`);
  }
  return out;
}

function toRpn(tokens) {
  const out = [], stack = [], argc = [];
  const top = () => stack[stack.length - 1];
  tokens.forEach((tk, i) => {
    const prev = tokens[i - 1];
    if (tk.t === "num" || tk.t === "ref") { out.push(tk); return; }
    if (tk.t === "fn") {
      if (!FNS[tk.v]) throw new Error(`${tk.v} isn't a function the formula understands.`);
      stack.push(tk);
      argc.push(0);
      return;
    }
    if (tk.v === ",") {
      while (stack.length && top().v !== "(") out.push(stack.pop());
      if (!stack.length || !argc.length) throw new Error("A comma is in the wrong place.");
      argc[argc.length - 1]++;
      return;
    }
    if (tk.v === "(") { stack.push(tk); return; }
    if (tk.v === ")") {
      while (stack.length && top().v !== "(") out.push(stack.pop());
      if (!stack.length) throw new Error("The brackets don't match.");
      stack.pop();
      if (stack.length && top().t === "fn") {
        const fn = stack.pop();
        let n = argc.pop() + 1;
        if (prev && prev.v === "(") n = 0;
        out.push({ t: "call", v: fn.v, n });
      }
      return;
    }
    const unary = !prev || (prev.t === "op" && prev.v !== ")") || prev.t === "fn";
    if (unary && (tk.v === "-" || tk.v === "+")) {
      if (tk.v === "-") stack.push({ t: "op", v: "neg" });
      return;
    }
    if (!OPS[tk.v]) throw new Error(`"${tk.v}" is in the wrong place.`);
    while (stack.length) {
      const t = top();
      if (t.v === "neg" || (OPS[t.v] && OPS[t.v][0] >= OPS[tk.v][0])) { out.push(stack.pop()); continue; }
      break;
    }
    stack.push(tk);
  });
  while (stack.length) {
    const t = stack.pop();
    if (t.v === "(") throw new Error("The brackets don't match.");
    out.push(t);
  }
  return out;
}

function evalRpn(rpn, resolve) {
  const st = [];
  let blank = false;
  for (const tk of rpn) {
    if (tk.t === "num") st.push(tk.v);
    else if (tk.t === "ref") {
      let v = resolve(tk.v);
      if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) { blank = true; v = 0; }
      st.push(Number(v));
    } else if (tk.t === "call") {
      if (st.length < tk.n) throw new Error(`${tk.v} is missing values.`);
      st.push(FNS[tk.v](tk.n ? st.splice(st.length - tk.n, tk.n) : []));
    } else if (tk.v === "neg") {
      if (!st.length) throw new Error("The formula ends too early.");
      st.push(-st.pop());
    } else {
      if (st.length < 2) throw new Error("The formula ends too early.");
      const b = st.pop(), a = st.pop();
      st.push(OPS[tk.v][1](a, b));
    }
  }
  if (st.length !== 1) throw new Error("The formula isn't complete.");
  return { value: Number.isFinite(st[0]) ? st[0] : null, blank };
}

// Never throws. Returns { ok, value, error }.
export function runCalc(formula, resolve, { blankAsZero = true } = {}) {
  try {
    if (!String(formula || "").trim()) return { ok: true, value: null };
    const r = evalRpn(toRpn(tokenize(formula)), resolve);
    return { ok: true, value: !blankAsZero && r.blank ? null : r.value };
  } catch (e) {
    return { ok: false, value: null, error: e.message };
  }
}

export function calcRefs(formula) {
  const out = [];
  String(formula || "").replace(/\{([^}]*)\}/g, (_, id) => {
    const k = id.trim();
    if (k && !out.includes(k)) out.push(k);
    return "";
  });
  return out;
}

// Works out every calculation on the form. A calculation can use another
// calculation; a circular chain resolves to "no value" instead of hanging.
export function evaluateCalcs(fields, getValue) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const memo = new Map(), visiting = new Set();
  function valueOf(id) {
    const f = byId.get(id);
    if (!f) return null;
    if (f.type !== "calculation") {
      const n = parseFloat(getValue(f));
      return Number.isFinite(n) ? n : null;
    }
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return null;
    visiting.add(id);
    const r = runCalc(f.formula, valueOf, { blankAsZero: f.blank !== "wait" });
    visiting.delete(id);
    memo.set(id, r.value);
    return r.value;
  }
  const out = {};
  fields.forEach((f) => { if (f.type === "calculation") out[f.id] = valueOf(f.id); });
  return out;
}

export function formatCalc(value, f = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const dp = Math.max(0, Math.min(4, parseInt(f.decimals, 10) || 0));
  const s = value.toLocaleString("en-AU", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${f.prefix || ""}${s}${f.suffix || ""}`;
}