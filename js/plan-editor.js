import { escapeHtml } from "./utils.js";
import { parsePlan, parseTimeline } from "./transcripts.js";

/* ===================== Constants ===================== */

// The recorder's 9 canonical concern categories (must match exactly)
export const CATEGORIES = [
  "Expression Lines / Muscle Movement",
  "Volume Loss / Contours",
  "Skin Texture",
  "Skin Laxity",
  "Pigmentation",
  "Redness / Sensitive Skin",
  "Collagen Replenishment",
  "Body Contouring",
  "Active Acne",
];

export const catKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

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

// Sidecar plan -> editable model { intent, discussion_notes, concerns: [], timeline: [], booking_comments }
export function planFromSidecar(sc) {
  const p = sc && sc.plan;
  if (!p || typeof p !== "object") return null;

  const concerns = Object.keys(p.concerns || {}).sort()
    .map((k) => p.concerns[k])
    .filter((c) => c && (str(c.treatment) || str(c.description)))
    .map((c) => ({
      description: str(c.description), concern_category: str(c.concern_category), area: str(c.area),
      treatment: str(c.treatment), frequency_interval: str(c.frequency_interval),
      quote: str(c.quote), comments: str(c.comments),
    }));

  const timeline = (Array.isArray(p.timeline) ? p.timeline : [])
    .map((t) => ({ date: str(t && t.date), treatment: str(t && t.treatment), pretreatment_instructions: str(t && t.pretreatment_instructions) }))
    .filter((t) => t.date || t.treatment);

  let intent = str(p.intent).toLowerCase();
  if (!INTENTS[intent]) intent = concerns.length ? "new_plan" : "none";

  return { intent, discussion_notes: str(p.discussion_notes), concerns, timeline, booking_comments: str(p.booking_comments) };
}

// Model -> sidecar plan (same shape as the recorder's schema: concern_a..concern_f)
export function planToSidecarPlan(plan) {
  const concerns = {};
  "abcdef".split("").forEach((l, i) => {
    const c = plan.concerns[i] || {};
    concerns[`concern_${l}`] = {
      description: str(c.description), concern_category: str(c.concern_category), area: str(c.area),
      treatment: str(c.treatment), frequency_interval: str(c.frequency_interval),
      quote: str(c.quote), comments: str(c.comments),
    };
  });
  return {
    intent: plan.intent,
    discussion_notes: plan.intent === "reviewing_existing" ? str(plan.discussion_notes) : "",
    concerns,
    timeline: plan.intent === "reviewing_existing" ? [] : plan.timeline.map((t) => ({
      date: str(t.date), treatment: str(t.treatment), pretreatment_instructions: str(t.pretreatment_instructions),
    })),
    booking_comments: str(plan.booking_comments),
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

// Categories this record already planned for (used for NEW vs UPDATE)
export function priorCategories(soap) {
  const sc = readSidecar(soap);
  if (sc && sc.plan && str(sc.plan.intent).toLowerCase() !== "reviewing_existing") {
    const cats = Object.values(sc.plan.concerns || {})
      .filter((c) => c && (str(c.treatment) || str(c.description)))
      .map((c) => str(c.concern_category))
      .filter(Boolean);
    if (cats.length) return cats;
  }
  const out = [];
  const re = /^CONCERN\s+[A-F]\s*:\s*(.+?)(?:\s+[—–-]\s+.*)?$/gim;
  let m;
  while ((m = re.exec(String(soap || "")))) out.push(m[1].trim());
  return out;
}

/* ===================== Reading / writing one field ===================== */

// ref = { pf: field name, ci?: concern index, ti?: timeline index } (values come from data-* attributes)
export function getPlanValue(plan, ref) {
  if (ref.ci !== undefined) return (plan.concerns[Number(ref.ci)] || {})[ref.pf] || "";
  if (ref.ti !== undefined) return (plan.timeline[Number(ref.ti)] || {})[ref.pf] || "";
  return plan[ref.pf] || "";
}

export function setPlanValue(plan, ref, value) {
  if (ref.ci !== undefined) { if (plan.concerns[Number(ref.ci)]) plan.concerns[Number(ref.ci)][ref.pf] = value; }
  else if (ref.ti !== undefined) { if (plan.timeline[Number(ref.ti)]) plan.timeline[Number(ref.ti)][ref.pf] = value; }
  else plan[ref.pf] = value;
}

export const refFrom = (el) => ({ pf: el.dataset.pf, ci: el.dataset.ci, ti: el.dataset.ti });

/* ===================== Rendering ===================== */

const FIELD_META = {
  description: { cls: "pe-desc", ph: "Add a description…" },
  area: { cls: "pe-area", ph: "Add area" },
  treatment: { cls: "pe-strong", ph: "Add treatment…" },
  frequency_interval: { ph: "Add frequency…" },
  quote: { cls: "pe-quote", ph: "Add quote…", view: quoteHtml },
  comments: { cls: "pe-italic", ph: "Add comments…" },
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
      <div class="pe-rows">
        ${row(I.syringe, "Treatment", fieldHtml({ pf: "treatment", ci: i }, c.treatment))}
        ${row(I.repeat, "Frequency", fieldHtml({ pf: "frequency_interval", ci: i }, c.frequency_interval))}
        ${row(I.tag, "Quote", fieldHtml({ pf: "quote", ci: i }, c.quote))}
        ${row(I.chat, "Comments", fieldHtml({ pf: "comments", ci: i }, c.comments))}
      </div>
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
        <button type="button" class="pe-btn solid" data-soon="Create Treatment Plan">${I.filePlus}Create Treatment Plan</button>
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
    const cat = CATEGORIES.find((x) => catKey(x) === catKey(c.title)) || "";
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