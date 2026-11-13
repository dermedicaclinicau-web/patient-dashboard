import { escapeHtml } from "./utils.js";
import { parsePlan, parseTimeline } from "./transcripts.js";
import { scheduleText, parseFreq } from "./plan-frequency.js";

/* ===================== Constants ===================== */

// The recorder's 9 canonical concern categories (must match exactly)
// The master plan's 9 concerns. Must match PLAN_CONCERNS in Soap.gs exactly.
export const BUILT_IN_CATEGORIES = [
  "Expression Lines & Wrinkles",
  "Volume Loss",
  "Skin Laxity",
  "Skin Texture & Quality",
  "Pigmentation",
  "Redness & Vascular Concerns",
  "Collagen Replenishment",
  "Body Contouring",
  "Acne & Acne Scarring",
];

// The concerns plans can use right now, in the clinic's order. Starts as the built-in 9;
// setCategories() (called by plan-api.js) adds the clinic's own and takes out hidden ones.
export const CATEGORIES = [...BUILT_IN_CATEGORIES];

export const catKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Names older consultations used → today's names
const LEGACY_CATEGORIES = {
  "Expression Lines / Muscle Movement": "Expression Lines & Wrinkles",
  "Volume Loss / Contours": "Volume Loss",
  "Skin Texture": "Skin Texture & Quality",
  "Redness / Sensitive Skin": "Redness & Vascular Concerns",
  "Active Acne": "Acne & Acne Scarring",
};
const CAT_LOOKUP = new Map();
// known: the concerns on the list. moved: [{ from, to }] concerns deleted in settings and moved into another,
// so the old name reads as the new one everywhere (consultations, plans, the AI's answers). Follows a chain of moves.
function rebuildLookup(known, moved = []) {
  CAT_LOOKUP.clear();
  known.forEach((c) => CAT_LOOKUP.set(catKey(c), c));
  const next = new Map(moved.map((m) => [catKey(m.from), m.to]));
  moved.forEach((m) => {
    if (CAT_LOOKUP.has(catKey(m.from))) return;   // it's on the list again
    let to = m.to;
    for (let i = 0; i < 6 && to && !CAT_LOOKUP.has(catKey(to)); i++) to = next.get(catKey(to));
    if (to && CAT_LOOKUP.has(catKey(to))) CAT_LOOKUP.set(catKey(m.from), CAT_LOOKUP.get(catKey(to)));
  });
  // Older recorder names follow their concern, wherever it is now
  Object.entries(LEGACY_CATEGORIES).forEach(([old, now]) => {
    if (!CAT_LOOKUP.has(catKey(old)) && CAT_LOOKUP.has(catKey(now))) CAT_LOOKUP.set(catKey(old), CAT_LOOKUP.get(catKey(now)));
  });
}
rebuildLookup(BUILT_IN_CATEGORIES);

// active: shown in pickers, in order. known: every concern on the list (hidden ones too), so older plans still read.
// moved / removed: concerns deleted in settings (a built-in one that's deleted isn't added back).
export function setCategories(active, known = active, moved = [], removed = []) {
  CATEGORIES.splice(0, CATEGORIES.length, ...active);
  const gone = new Set([...moved.map((m) => catKey(m.from)), ...removed.map(catKey)]);
  rebuildLookup([...new Set([...BUILT_IN_CATEGORIES.filter((b) => !gone.has(catKey(b))), ...known])], moved);
}

// Any spelling, old or new → today's name ("" if it isn't one of the 9)
export const canonicalCategory = (s) => CAT_LOOKUP.get(catKey(s)) || "";

export const PATTERNS = ["course", "maintenance", "once", "unknown"];
const whole = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 520) : 0;
};

const INTENTS = {
  new_plan: { label: "New plan", cls: "new" },
  reviewing_existing: { label: "Reviewing existing plan", cls: "review" },
  none: { label: "No plan", cls: "none" },
};

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  clipboard: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
  pin: svg('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  syringe: svg('<path d="m18 2 4 4"/><path d="m17 7 3-3"/><path d="M19 9 8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5"/><path d="m9 11 4 4"/><path d="m5 19-3 3"/><path d="m14 4 6 6"/>'),
  repeat: svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  tag: svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  refresh: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  filePlus: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>'),
};

const str = (v) => String(v == null ? "" : v).trim();

/* ===================== How often: one schedule per treatment line ===================== */

// A concern's treatments, one per line
export const treatmentLines = (c) => String((c && c.treatment) || "").split(/\n+/).map((s) => s.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
const freqLines = (c) => String((c && c.frequency_interval) || "").split(/\n+/).map((s) => s.trim()).map((s) => (s === "—" ? "" : s));
const cleanSched = (s = {}) => ({
  pattern: PATTERNS.includes(str(s.pattern)) ? str(s.pattern) : "unknown",
  sessions: whole(s.sessions),
  interval_weeks: whole(s.interval_weeks),
  interval_unit: /^[wm]$/.test(str(s.interval_unit)) ? str(s.interval_unit) : "",
  note: str(s.note).slice(0, 200),
  after_n: whole(s.after_n),                                              // starts this long after…
  after_unit: /^[wm]$/.test(str(s.after_unit)) ? str(s.after_unit) : "",
  after_service: str(s.after_service).slice(0, 150),                      // …the patient's last of this service
});

// "starts 6 months after the last Ulthera" ("" when it starts as planned)
export const afterText = (n, unit, svc) => (n && svc
  ? `starts ${n} ${unit === "w" ? (n === 1 ? "week" : "weeks") : (n === 1 ? "month" : "months")} after the last ${svc}` : "");
export const AFTER_RE = /^starts \d+ (?:weeks?|months?) after the last /i;
const schedText = (s) => [scheduleText({ pattern: s.pattern, sessions: s.sessions, intervalWeeks: s.interval_weeks, intervalUnit: s.interval_unit }),
  afterText(s.after_n, s.after_unit, s.after_service), s.note].filter(Boolean).join(" · ");

// One schedule per treatment line (always at least one). Set in the notes → as saved.
// Otherwise from the recorder's fields (first treatment) or read from the Frequency wording.
export function schedulesOf(c) {
  const freqs = freqLines(c);
  const saved = Array.isArray(c.schedules) ? c.schedules : [];
  return Array.from({ length: Math.max(1, treatmentLines(c).length) }, (_, i) => {
    if (saved[i]) return cleanSched(saved[i]);
    const text = freqs[i] || "";
    // "1 every 2 weeks · Neck to be trialled first": the schedule, then the comment
    const [head, ...rest] = text.split(/\s+·\s+/);
    const note = rest.filter((p) => !AFTER_RE.test(p)).join(" · ");
    if (i === 0 && !saved.length && ((c.pattern && c.pattern !== "unknown") || whole(c.interval_weeks))) {
      return cleanSched({ pattern: c.pattern, sessions: c.sessions, interval_weeks: c.interval_weeks,
        interval_unit: c.interval_unit || (/month|mth/i.test(text) ? "m" : /week|wk/i.test(text) ? "w" : ""), note });
    }
    const p = parseFreq(head);
    return p ? cleanSched({ pattern: p.pattern, sessions: p.sessions, interval_weeks: p.intervalWeeks, interval_unit: p.intervalUnit, note })
      : cleanSched({ note: text });
  });
}

// What each treatment's Frequency button says ("" = not set). Until one is changed here, the recorded wording is kept.
export function scheduleLabels(c) {
  const freqs = freqLines(c);
  const saved = Array.isArray(c.schedules) ? c.schedules : [];
  return schedulesOf(c).map((s, i) => (saved[i] ? schedText(s) : freqs[i] || schedText(s)));
}

// Sets one treatment's schedule, and rewrites the Frequency text and the first treatment's fields to match
export function setSchedule(c, i, s) {
  const freqs = freqLines(c);
  const saved = Array.isArray(c.schedules) ? c.schedules : [];
  const all = schedulesOf(c);
  // Anything not given stays as it was (the comment, and when it starts)
  const keep = { ...s };
  ["note", "after_n", "after_unit", "after_service"].forEach((k) => { if (keep[k] === undefined) keep[k] = all[i] ? all[i][k] : ""; });
  c.schedules = all.map((x, k) => (k === i ? cleanSched(keep) : saved[k] ? cleanSched(saved[k]) : null));
  const lines = all.map((x, k) => (c.schedules[k] ? schedText(c.schedules[k]) : freqs[k] || ""));
  c.frequency_interval = lines.some(Boolean) ? lines.map((l) => l || "—").join("\n") : "";
  const first = c.schedules[0] || all[0];
  Object.assign(c, { pattern: first.pattern, sessions: first.sessions, interval_weeks: first.interval_weeks, interval_unit: first.interval_unit });
}

/* ===================== One row per treatment: its quote and comment ===================== */

const Q_STOP = new Set(["and", "the", "for", "with", "per", "session", "sessions", "treatment", "treatments", "area", "areas", "add"]);
const allWords = (s) => String(s || "").toLowerCase().replace(/\bwr\b/g, "wrinkle relaxer").split(/[^a-z0-9]+/).filter(Boolean);
const keyWords = (s) => allWords(s).filter((w) => w.length > 2 && !Q_STOP.has(w));
const shared = (a, b) => { const y = new Set(keyWords(b)); return keyWords(a).filter((w) => y.has(w)).length; };
const schedLabel = (s) => scheduleText({ pattern: s.pattern, sessions: s.sessions, intervalWeeks: s.interval_weeks, intervalUnit: s.interval_unit });

// The concern's quote, one entry per treatment. Each quote line goes to the treatment it names best;
// lines that name none go under the first treatment, so nothing is ever lost.
export function quoteRows(c) {
  const names = treatmentLines(c);
  const lines = String((c && c.quote) || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return [];
  const rows = names.map(() => []);
  const pairs = [];
  lines.forEach((q, qi) => names.forEach((t, ti) => { const n = shared(q, t); if (n) pairs.push({ qi, ti, n }); }));
  pairs.sort((a, b) => b.n - a.n);
  const usedQ = new Set();
  const usedT = new Set();
  pairs.forEach((p) => {
    if (usedQ.has(p.qi) || usedT.has(p.ti)) return;
    usedQ.add(p.qi); usedT.add(p.ti);
    rows[p.ti].push(lines[p.qi]);
  });
  lines.forEach((q, qi) => { if (!usedQ.has(qi)) rows[0].push(q); });
  return rows.map((r) => r.join("\n"));
}

// "Add on Collagen Activator $198" beside "Add on Collagen activator Face" shows as "$198"
function quoteShown(q, name) {
  const tw = new Set(allWords(name));
  return String(q || "").split("\n").map((line) => {
    const m = /^(.*?)\s*[-–—:]?\s*(\$.*)$/.exec(line);
    if (!m || !m[1].trim()) return line;
    const pw = allWords(m[1]);
    return pw.length && pw.every((w) => tw.has(w)) ? m[2] : line;
  }).join("\n");
}
// Saved with the treatment's name, so the Master Plan and the patient copy find it
const composeQuote = (name, v) => (v.includes("\n") || shared(v, name) ? v : `${name} - ${v}`);

const ROW_FIELDS = ["row_treatment", "row_quote", "row_note"];

function rowValue(c, pf, i) {
  const names = treatmentLines(c);
  if (pf === "row_treatment") return names[i] || "";
  if (i >= names.length) return "";
  if (pf === "row_quote") return quoteShown(quoteRows(c)[i] || "", names[i]);
  return (schedulesOf(c)[i] || {}).note || "";
}

// Takes one treatment out, with its schedule and quote
function removeRow(c, i) {
  const names = treatmentLines(c);
  const rows = quoteRows(c);
  const freqs = freqLines(c);
  const gone = names[i];
  const stray = String(rows[i] || "").split("\n").filter((l) => l && !shared(l, gone));   // lines that weren't really its
  names.splice(i, 1); rows.splice(i, 1); freqs.splice(i, 1);
  if (stray.length && rows.length) rows[0] = [rows[0], ...stray].filter(Boolean).join("\n");
  c.treatment = names.join("\n");
  c.quote = rows.filter(Boolean).join("\n");
  c.frequency_interval = freqs.some(Boolean) ? freqs.map((l) => l || "—").join("\n") : "";
  if (Array.isArray(c.schedules)) {
    const s = [...c.schedules];
    s.splice(i, 1);
    c.schedules = s;
  }
  const first = schedulesOf(c)[0];
  if (first) Object.assign(c, { pattern: first.pattern, sessions: first.sessions, interval_weeks: first.interval_weeks, interval_unit: first.interval_unit });
}

function setRowValue(c, pf, i, value) {
  const v = str(value);
  const names = treatmentLines(c);
  if (pf === "row_treatment") {
    const name = v.replace(/\s*\n+\s*/g, " ");
    if (!name) { if (i < names.length) removeRow(c, i); return; }   // emptied: the treatment is removed
    if (i >= names.length) {                                        // the "+ Add treatment" row
      names.push(name);
      c.treatment = names.join("\n");
      if (Array.isArray(c.schedules)) c.schedules = [...c.schedules, null];
      return;
    }
    const rows = quoteRows(c);
    const old = names[i];
    names[i] = name;
    c.treatment = names.join("\n");
    // Its quote follows the new name
    if (rows[i] && !shared(rows[i], name)) {
      rows[i] = composeQuote(name, quoteShown(rows[i], old));
      c.quote = rows.filter(Boolean).join("\n");
    }
    return;
  }
  if (i >= names.length) return;
  if (pf === "row_quote") {
    const rows = quoteRows(c);
    rows[i] = v ? composeQuote(names[i], v) : "";
    c.quote = rows.filter(Boolean).join("\n");
    return;
  }
  setSchedule(c, i, { ...schedulesOf(c)[i], note: v.replace(/\s*\n+\s*/g, " ") });   // row_note: the treatment's comment
}

// Treatment | Frequency | Quote | Comment, one row each (stacked as small cards when the card is narrow)
function txTableHtml(c, ci) {
  const names = treatmentLines(c);
  const sch = schedulesOf(c);
  const quotes = quoteRows(c);
  const rows = names.map((name, k) => {
    const s = sch[k] || {};
    const label = [schedLabel(s), afterText(s.after_n, s.after_unit, s.after_service)].filter(Boolean).join(" · ");
    return `<div class="pe-tx-row">
      <div class="pe-tx-c" data-lbl="Treatment">${fieldHtml({ pf: "row_treatment", ci, si: k }, name)}</div>
      <div class="pe-tx-c" data-lbl="Frequency"><button type="button" class="pe-freq${label ? "" : " is-empty"}" data-pe="freq" data-ci="${ci}" data-si="${k}" title="Set how often">
        <span class="pe-freq-v">${label ? escapeHtml(label) : "Set how often"}</span></button></div>
      <div class="pe-tx-c" data-lbl="Quote">${fieldHtml({ pf: "row_quote", ci, si: k }, quoteShown(quotes[k] || "", name))}</div>
      <div class="pe-tx-c is-note" data-lbl="Comment">${fieldHtml({ pf: "row_note", ci, si: k }, s.note)}</div>
    </div>`;
  }).join("");
  return `<div class="pe-tx">
    ${names.length ? `<div class="pe-tx-head" aria-hidden="true"><span>${I.syringe}Treatment</span><span>${I.repeat}Frequency</span>
      <span>${I.tag}Quote</span><span>${I.chat}Comment</span></div>` : ""}
    ${rows}
    <div class="pe-tx-row is-add">${fieldHtml({ pf: "row_treatment", ci, si: names.length }, "")}</div>
  </div>`;
}

function freqRowHtml(c, ci) {
  const names = treatmentLines(c);
  return `<div class="pe-freqs">${scheduleLabels(c).map((label, k) => `
    <button type="button" class="pe-freq${label ? "" : " is-empty"}" data-pe="freq" data-ci="${ci}" data-si="${k}" title="Set how often">
      ${names.length > 1 ? `<span class="pe-freq-tx">${escapeHtml(names[k])}</span>` : ""}
      <span class="pe-freq-v">${label ? escapeHtml(label) : "Set how often"}</span>
    </button>`).join("")}</div>`;
}

/* ===================== Structured sidecar (same encoding as the recorder) ===================== */

const SIDECAR_RE = /<!--STRUCTURED_SIDECAR:([^-]+)-->/;

export function readSidecar(soap) {
  const m = SIDECAR_RE.exec(String(soap || ""));
  if (!m) return null;
  try {
    const bin = atob(m[1].trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function buildSidecar(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `<!--STRUCTURED_SIDECAR:${btoa(bin)}-->`;
}

/* ===================== Plan model ===================== */

// Sidecar plan -> editable model { intent, discussion_notes, concerns: [], timeline: [], booking_comments, patient_events }
export function planFromSidecar(sc) {
  const p = sc && sc.plan;
  if (!p || typeof p !== "object") return null;

  const concerns = Object.keys(p.concerns || {}).sort()
    .map((k) => ({ k, c: p.concerns[k] }))
    .filter(({ c }) => c && (str(c.treatment) || str(c.description)))
    .map(({ k, c }) => {
      const raw = str(c.concern_category);
      return {
        key: k.replace(/^concern_/, ""),           // the letter the timeline points at
        description: str(c.description),
        concern_category: canonicalCategory(raw) || (/^none$/i.test(raw) ? "" : raw),
        area: str(c.area),
        treatment: str(c.treatment),
        frequency_interval: str(c.frequency_interval),
        quote: str(c.quote),
        comments: str(c.comments),
        pattern: PATTERNS.includes(str(c.pattern)) ? str(c.pattern) : "unknown",
        sessions: whole(c.sessions),
        interval_weeks: whole(c.interval_weeks),
        interval_unit: /^[wm]$/.test(str(c.interval_unit)) ? str(c.interval_unit) : "",
        ...(Array.isArray(c.schedules) ? { schedules: c.schedules.map((s) => (s ? cleanSched(s) : null)) } : {}),
      };
    });

  const timeline = (Array.isArray(p.timeline) ? p.timeline : [])
    .map((t) => ({
      date: str(t && t.date),
      treatment: str(t && t.treatment),
      pretreatment_instructions: str(t && t.pretreatment_instructions),
      concern: str(t && t.concern).toLowerCase().replace(/^concern_/, "").replace(/^none$/, ""),
    }))
    .filter((t) => t.date || t.treatment);

  const patient_events = (Array.isArray(p.patient_events) ? p.patient_events : [])
    .map((e) => ({ name: str(e && e.name), month: str(e && e.month), avoid_downtime: !!(e && e.avoid_downtime === true) }))
    .filter((e) => e.name);

  let intent = str(p.intent).toLowerCase();
  if (!INTENTS[intent]) intent = concerns.length ? "new_plan" : "none";

  return { intent, discussion_notes: str(p.discussion_notes), concerns, timeline, booking_comments: str(p.booking_comments), patient_events };
}

// Model -> sidecar plan (same shape as the recorder's schema: concern_a..concern_f)
export function planToSidecarPlan(plan) {
  const concerns = {};
  const letterOf = {}; // a concern's old letter -> its letter after edits (concerns can be removed or reordered)
  "abcdef".split("").forEach((l, i) => {
    const c = plan.concerns[i] || {};
    if (c.key) letterOf[c.key] = l;
    concerns[`concern_${l}`] = {
      description: str(c.description), concern_category: str(c.concern_category), area: str(c.area),
      treatment: str(c.treatment), frequency_interval: str(c.frequency_interval),
      quote: str(c.quote), comments: str(c.comments),
      pattern: PATTERNS.includes(str(c.pattern)) ? str(c.pattern) : "unknown",
      sessions: whole(c.sessions), interval_weeks: whole(c.interval_weeks),
      interval_unit: /^[wm]$/.test(str(c.interval_unit)) ? str(c.interval_unit) : "",
      ...(Array.isArray(c.schedules) ? { schedules: c.schedules } : {}),
    };
  });
  return {
    intent: plan.intent,
    discussion_notes: plan.intent === "reviewing_existing" ? str(plan.discussion_notes) : "",
    concerns,
    timeline: plan.intent === "reviewing_existing" ? [] : plan.timeline.map((t) => ({
      date: str(t.date), treatment: str(t.treatment), pretreatment_instructions: str(t.pretreatment_instructions),
      concern: letterOf[str(t.concern)] || "",
    })),
    booking_comments: str(plan.booking_comments),
    patient_events: (plan.patient_events || []).map((e) => ({
      name: str(e.name), month: str(e.month), avoid_downtime: e.avoid_downtime === true,
    })),
  };
}

// Model -> "!!TREATMENT PLAN" text, mirroring the recorder's formatSoapFromJSON
export function planToText(plan) {
  if (plan.intent === "reviewing_existing") {
    const notes = str(plan.discussion_notes);
    return "REVIEW OF EXISTING PLAN (no new plan generated)" + (notes ? "\n" + notes : "");
  }

  let t = "";
  plan.concerns.forEach((c, i) => {
    const cat = str(c.concern_category);
    const desc = str(c.description);
    const treat = str(c.treatment);
    if (!treat && !desc) return;
    const heading = cat && desc ? `${cat} — ${desc}` : (cat || desc);
    t += `CONCERN ${String.fromCharCode(65 + i)}: ${heading}\n`;
    if (str(c.area)) t += `AREA: ${str(c.area)}\n`;
    if (treat) t += `TREATMENT:\n${treat}\n`;
    if (str(c.frequency_interval)) t += `FREQUENCY/INTERVAL:\n${str(c.frequency_interval)}\n`;
    if (str(c.quote)) t += `QUOTE:\n${str(c.quote)}\n`;
    if (str(c.comments)) t += `Comments:\n${str(c.comments)}\n`;
    t += "\n";
  });

  const steps = plan.timeline.filter((s) => str(s.date) || str(s.treatment));
  if (steps.length) {
    t += "SUGGESTED TIMELINE:\n";
    steps.forEach((s) => {
      t += `${str(s.date)}\n- ${str(s.treatment)}\n`;
      if (str(s.pretreatment_instructions)) t += `${str(s.pretreatment_instructions)}\n`;
      t += "\n";
    });
  }
  return t.trim();
}

// Categories this record already planned for (used for NEW vs UPDATE). Old names count as today's names.
export function priorCategories(soap) {
  const sc = readSidecar(soap);
  if (sc && sc.plan && str(sc.plan.intent).toLowerCase() !== "reviewing_existing") {
    const cats = Object.values(sc.plan.concerns || {})
      .filter((c) => c && (str(c.treatment) || str(c.description)))
      .map((c) => canonicalCategory(c.concern_category) || str(c.concern_category))
      .filter((c) => c && !/^none$/i.test(c));
    if (cats.length) return cats;
  }
  const out = [];
  const re = /^CONCERN\s+[A-F]\s*:\s*(.+?)(?:\s+[—–-]\s+.*)?$/gim;
  let m;
  while ((m = re.exec(String(soap || "")))) {
    const t = m[1].trim();
    out.push(canonicalCategory(t) || t);
  }
  return out;
}

/* ===================== Reading / writing one field ===================== */

// ref = { pf: field name, ci?: concern index, ti?: timeline index } (values come from data-* attributes)
export function getPlanValue(plan, ref) {
  if (ROW_FIELDS.includes(ref.pf)) {
    const c = plan.concerns[Number(ref.ci)];
    return c ? rowValue(c, ref.pf, Number(ref.si)) : "";
  }
  if (ref.ci !== undefined) return (plan.concerns[Number(ref.ci)] || {})[ref.pf] || "";
  if (ref.ti !== undefined) return (plan.timeline[Number(ref.ti)] || {})[ref.pf] || "";
  return plan[ref.pf] || "";
}

export function setPlanValue(plan, ref, value) {
  if (ROW_FIELDS.includes(ref.pf)) {
    const c = plan.concerns[Number(ref.ci)];
    if (c) setRowValue(c, ref.pf, Number(ref.si), value);
    return;
  }
  if (ref.ci !== undefined) { if (plan.concerns[Number(ref.ci)]) plan.concerns[Number(ref.ci)][ref.pf] = value; }
  else if (ref.ti !== undefined) { if (plan.timeline[Number(ref.ti)]) plan.timeline[Number(ref.ti)][ref.pf] = value; }
  else plan[ref.pf] = value;
}

export const refFrom = (el) => ({ pf: el.dataset.pf, ci: el.dataset.ci, ti: el.dataset.ti, si: el.dataset.si });

/* ===================== Rendering ===================== */

const FIELD_META = {
  description: { cls: "pe-desc", ph: "Add a description…" },
  area: { cls: "pe-area", ph: "Add area" },
  treatment: { cls: "pe-strong", ph: "Add treatment…" },
  frequency_interval: { ph: "Add frequency…" },
  quote: { cls: "pe-quote", ph: "Add quote…", view: quoteHtml },
  comments: { cls: "pe-italic", ph: "Note for this concern…" },
  row_treatment: { cls: "pe-strong", ph: "+ Add treatment" },
  row_quote: { cls: "pe-quote", ph: "Add quote", view: quoteHtml },
  row_note: { cls: "pe-italic", ph: "Add comment" },
  discussion_notes: { ph: "Summary of the review…" },
  tl_date: { cls: "pe-tl-date", ph: "Month Year" },
  tl_treatment: { cls: "pe-strong", ph: "Treatment…" },
  tl_pretreatment_instructions: { cls: "pe-tl-note", ph: "Pre-treatment instructions…" },
};

function linesHtml(v) {
  return escapeHtml(v).replace(/\n/g, "<br>");
}

// "Laser treatment for spot — $295" -> "Laser treatment for spot - <green>$295</green>"
function quoteHtml(v) {
  return v.split("\n")
    .map((line) => escapeHtml(line.replace(/\s+[—–]\s+/g, " - "))
      .replace(/\$[\d,]+(?:\.\d{2})?/g, (m) => `<strong class="pe-price">${m}</strong>`))
    .join("<br>");
}

// One click-to-edit field
export function fieldHtml(ref, value) {
  const metaKey = ref.ti !== undefined ? `tl_${ref.pf}` : ref.pf;
  const meta = FIELD_META[metaKey] || {};
  const attrs = `data-pf="${ref.pf}"` +
    (ref.ci !== undefined ? ` data-ci="${ref.ci}"` : "") +
    (ref.ti !== undefined ? ` data-ti="${ref.ti}"` : "") +
    (ref.si !== undefined ? ` data-si="${ref.si}"` : "") +
    ` data-ph="${escapeHtml(meta.ph || "")}"`;
  const v = str(value);
  const inner = v
    ? (meta.view ? meta.view(v) : linesHtml(v))
    : `<span class="pe-ph">${escapeHtml(meta.ph || "Add…")}</span>`;
  return `<div class="pe-field ${meta.cls || ""}" ${attrs} tabindex="0" role="button" title="Click to edit">${inner}</div>`;
}

const row = (icon, label, field) =>
  `<div class="pe-row"><span class="pe-label">${icon}${label}</span>${field}</div>`;

function concernHtml(c, i, priorCats, showBadges) {
  const letter = String.fromCharCode(65 + i);
  const cat = c.concern_category;
  const options = !cat || CATEGORIES.includes(cat) ? CATEGORIES : [cat, ...CATEGORIES];

  let badge = "";
  if (showBadges && priorCats && cat) {
    badge = priorCats.has(catKey(cat))
      ? `<span class="pe-badge upd">${I.refresh}Update</span>`
      : `<span class="pe-badge new">+ New</span>`;
  }

  return `
    <article class="pe-concern">
      <div class="pe-c-head">
        <span class="pe-letter">${letter}</span>
        <select class="pe-cat" data-ci="${i}" aria-label="Concern ${letter} category">
          ${cat ? "" : `<option value="" selected>Choose category…</option>`}
          ${options.map((o) => `<option${o === cat ? " selected" : ""}>${escapeHtml(o)}</option>`).join("")}
        </select>
        <span class="pe-c-tags">
          ${badge}
          <span class="pe-chip">${I.pin}${fieldHtml({ pf: "area", ci: i }, c.area)}</span>
          <button type="button" class="pe-x" data-pe="remove-concern" data-ci="${i}" title="Remove this concern" aria-label="Remove concern ${letter}">${I.x}</button>
        </span>
      </div>
      ${fieldHtml({ pf: "description", ci: i }, c.description)}
      ${treatmentLines(c).length || !(str(c.quote) || str(c.frequency_interval)) ? `
        ${txTableHtml(c, i)}
        <div class="pe-cnote">${I.chat}${fieldHtml({ pf: "comments", ci: i }, c.comments)}</div>`
      : `<div class="pe-rows">
        ${row(I.syringe, "Treatment", fieldHtml({ pf: "treatment", ci: i }, c.treatment))}
        ${row(I.repeat, "Frequency", freqRowHtml(c, i))}
        ${row(I.tag, "Quote", fieldHtml({ pf: "quote", ci: i }, c.quote))}
        ${row(I.chat, "Comments", fieldHtml({ pf: "comments", ci: i }, c.comments))}
      </div>`}
    </article>`;
}

function timelineHtml(timeline) {
  const items = timeline.map((t, i) => `
    <li class="pe-tl-item">
      <span class="pe-tl-dot"></span>
      <div class="pe-tl-main">
        ${fieldHtml({ pf: "date", ti: i }, t.date)}
        ${fieldHtml({ pf: "treatment", ti: i }, t.treatment)}
        ${t.pretreatment_instructions ? fieldHtml({ pf: "pretreatment_instructions", ti: i }, t.pretreatment_instructions) : ""}
      </div>
      <button type="button" class="pe-x" data-pe="remove-step" data-ti="${i}" title="Remove this step" aria-label="Remove step">${I.x}</button>
    </li>`).join("");

  return `
    <div class="pe-tl">
      <p class="pe-tl-title">${I.calendar}Suggested timeline</p>
      ${timeline.length ? `<ol class="pe-tl-list">${items}</ol>` : `<p class="pe-empty">No timeline.</p>`}
      <button type="button" class="pe-add" data-pe="add-step">+ Add step</button>
    </div>`;
}

// The whole card's inner HTML (goes inside <section class="sp-card ...">)
export function planCardHtml(plan, priorCats) {
  const intent = INTENTS[plan.intent] || INTENTS.none;
  const reviewing = plan.intent === "reviewing_existing";

  const body = reviewing
    ? `<div class="pe-review">
         <p class="pe-review-title">Review of existing plan</p>
         ${fieldHtml({ pf: "discussion_notes" }, plan.discussion_notes)}
       </div>`
    : (plan.concerns.length
        ? plan.concerns.map((c, i) => concernHtml(c, i, priorCats, true)).join("")
        : `<p class="pe-empty">No concerns recorded.</p>`) +
      (plan.concerns.length < 6 ? `<button type="button" class="pe-add" data-pe="add-concern">+ Add concern</button>` : "");

  return `
    <header>${I.clipboard}<span>Treatment Plan (In-Clinic)</span><span class="pe-intent ${intent.cls}">${intent.label}</span></header>
    <div class="pe-body">
      ${body}
      ${reviewing ? "" : timelineHtml(plan.timeline)}
      <div class="pe-actions">
        <button type="button" class="pe-btn" data-sp="email-from-plan">${I.refresh}Update email from plan</button>
        <button type="button" class="pe-btn solid" data-sp="to-master">${I.filePlus}Add to master plan</button>
      </div>
    </div>`;
}

/* ===================== Older records (no sidecar): read the plan text ===================== */

// "!!TREATMENT PLAN" text -> editable model, or null if it can't be structured safely
export function planFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const parsed = parsePlan(raw);
  const intro = parsed.intro.map(str).filter(Boolean);

  // "REVIEW OF EXISTING PLAN (no new plan generated)" + notes
  if (intro.length && /^REVIEW OF EXISTING PLAN/i.test(intro[0]) && !parsed.concerns.length) {
    return {
      intent: "reviewing_existing", discussion_notes: intro.slice(1).join("\n"),
      concerns: [], timeline: [], booking_comments: "", fromText: true,
    };
  }

  // Anything we can't place cleanly -> keep the plain text box (nothing lost)
  if (intro.length || (!parsed.concerns.length && !parsed.timeline.length)) return null;

  const concerns = parsed.concerns.map((c) => {
    // Newer text starts with an official category ("Skin Laxity — …"); older text doesn't
    const cat = canonicalCategory(c.title);
    const description = cat ? c.description.join(" ") : [c.title, ...c.description].filter(Boolean).join(" ");
    return {
      description: str(description),
      concern_category: cat,
      area: c.area.join(", "),
      treatment: c.treatment.join("\n"),
      frequency_interval: c.frequency.join("\n"),
      quote: c.quote.join("\n"),
      comments: c.comments.join("\n"),
    };
  });

  const { visits } = parseTimeline(parsed.timeline);
  const timeline = visits.map((v) => ({
    date: v.label,
    treatment: v.items.map((it) => (it.detail ? `${it.name} (${it.detail})` : it.name)).join("\n"),
    pretreatment_instructions: v.notes.map((n) => `${n.label}: ${n.text}`).join("\n"),
  })).filter((t) => t.date || t.treatment);

  return {
    intent: concerns.length ? "new_plan" : "none",
    discussion_notes: "", concerns, timeline, booking_comments: "", fromText: true,
  };
}