// Marking sets: what staff can place on a picture.
//   Numbers: values that add up to a total (e.g. wrinkle relaxer units 0.5, 1, 2…).
//   Labels: short codes that are counted (e.g. depth of placement SD, PO).
// A picture can use several sets; each is placed on its own (staff pick a value from any set, then tap).
// Every value has its own shape, shape colour, filled or see-through, text colour and text size.
// One list in form_settings/marking_sets, shared by every form. Saved forms keep their own copy of each mark.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const MARK_COLOURS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#db2777", "#0891b2", "#4b5563"];
export const MARK_SHAPES = [["circle", "Circle"], ["target", "Circle with dot"], ["square", "Square"], ["diamond", "Diamond"],
  ["triangle", "Triangle"], ["hexagon", "Hexagon"], ["star", "Star"]];
// Shapes that show no text (the dot is the mark; the code is still counted)
const NO_TEXT = new Set(["target"]);
export const shapeHasText = (shape) => !NO_TEXT.has(shape);
export const TEXT_SIZES = [["s", "Small text"], ["m", "Medium text"], ["l", "Large text"]];
const SHAPE_KEYS = MARK_SHAPES.map(([k]) => k);
const TSIZE = { s: 0.75, m: 1, l: 1.3 };
const HEX = /^#[0-9a-f]{6}$/i;
export const fmtMark = (n) => String(+Number(n || 0).toFixed(2));

// Where the text sits in each shape (dy × radius) and how big it is (fs × radius)
export const SHAPE_TEXT = {
  circle: { dy: 0.06, fs: 1 }, square: { dy: 0.06, fs: 1 }, hexagon: { dy: 0.06, fs: 0.95 },
  diamond: { dy: 0.06, fs: 0.8 }, triangle: { dy: 0.35, fs: 0.7 }, star: { dy: 0.1, fs: 0.6 },
  target: { dy: 0, fs: 0 },
};
export const textSize = (text, shape, tsize = "m") => {
  if (!shapeHasText(shape)) return 0;
  const t = String(text || "");
  return (t.length > 3 ? 0.62 : t.length > 2 ? 0.78 : 1) * (SHAPE_TEXT[shape] || SHAPE_TEXT.circle).fs * (TSIZE[tsize] || 1);
};

// A label below the shape: how far each shape reaches below its centre (× radius), so the label starts just under it
const SHAPE_BOTTOM = { circle: 1, target: 1, square: 0.88, diamond: 1.18, triangle: 0.85, hexagon: 0.92, star: 1.05 };
export const shapeBottom = (shape) => SHAPE_BOTTOM[shape] ?? 1;
export const showsText = (shape, tpos) => tpos === "below" || shapeHasText(shape);
export const belowSize = (text, tsize = "m") => (String(text || "").length > 3 ? 0.72 : 0.9) * (TSIZE[tsize] || 1);
// White text would vanish on the picture, so a label below uses the shape's colour unless another colour was chosen
export const belowColour = (textColour, colour) =>
  (!textColour || String(textColour).toLowerCase() === "#ffffff" ? colour : textColour);

// A value's look, with defaults (white text on a filled shape; shape-coloured text when see-through)
function styleOf(x, j) {
  const colour = HEX.test((x && x.colour) || "") ? x.colour.toLowerCase() : MARK_COLOURS[j % MARK_COLOURS.length];
  const fill = x && x.fill === "none" ? "none" : "solid";
  return {
    colour,
    shape: SHAPE_KEYS.includes(x && x.shape) ? x.shape : "circle",
    fill,
    text: HEX.test((x && x.text) || "") ? x.text.toLowerCase() : (fill === "none" ? colour : "#ffffff"),
    tsize: ["s", "m", "l"].includes(x && x.tsize) ? x.tsize : "m",
    tpos: x && x.tpos === "below" ? "below" : "in",   // the code inside the shape, or below it
  };
}
const newStyle = (colour) => ({ colour, shape: "circle", fill: "solid", text: "#ffffff", tsize: "m", tpos: "in" });

const DEFAULT_SETS = [{
  id: "wr_units", name: "Wrinkle relaxer units", type: "number", unit: "units",
  values: [0.5, 1, 2, 3, 4, 5, 10].map((v, i) => ({ v, ...newStyle(MARK_COLOURS[i % MARK_COLOURS.length]) })),
  tagMarks: false, tags: ["Treatment", "Touch-up"],
}];

// Values staff can put on an arrow or line (Dot / Line), e.g. 0.1, 0.2, 0.3 mL
export function cleanArrowValues(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[,\s]+/);
  const out = [];
  list.forEach((x) => {
    const v = Math.round(Number(x) * 100) / 100;
    if (Number.isFinite(v) && v > 0 && v <= 1000 && !out.includes(v)) out.push(v);
  });
  return out.sort((a, b) => a - b).slice(0, 12);
}

export function cleanSet(s = {}, i = 0) {
  const type = s.type === "label" ? "label" : "number";
  const seen = new Set();
  const raw = Array.isArray(s.values) ? s.values : [];
  const values = type === "label"
    ? raw.map((x, j) => ({
        code: String((x && x.code) || "").trim().slice(0, 5),
        name: String((x && x.name) || "").trim().slice(0, 40),
        ...styleOf(x, j),
      }))
      .filter((x) => x.code && !seen.has(x.code.toLowerCase()) && seen.add(x.code.toLowerCase()))
      .slice(0, 12)
    : raw.map((x, j) => ({ v: Math.round(Number(x && x.v) * 100) / 100, ...styleOf(x, j) }))
      .filter((x) => Number.isFinite(x.v) && x.v > 0 && x.v <= 1000 && !seen.has(x.v) && seen.add(x.v))
      .sort((a, b) => a.v - b.v)
      .slice(0, 20);
  const tags = (Array.isArray(s.tags) ? s.tags : [])
    .map((t) => String(t || "").trim().slice(0, 30)).filter(Boolean).slice(0, 4);
  const av = type === "label" ? [] : cleanArrowValues(s.arrowValues);
  return {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(s.id || "") ? s.id : `ms_${i}`,
    name: String(s.name || "").trim().slice(0, 60),
    type,
    unit: type === "label" ? "" : String(s.unit || "").trim().slice(0, 20),
    totalLabel: type === "label" ? "" : String(s.totalLabel || "").trim().slice(0, 40),   // e.g. "Bolus injected"
    values,
    arrowValues: av,                                                      // values on arrows and lines
    arrowDefault: av.includes(Number(s.arrowDefault)) ? Number(s.arrowDefault) : null,   // pre-selected (null: none)
    arrowOther: type === "number" && s.arrowOther === true,               // staff can type another value
    labelOn: s.labelOn === true,                                           // a label beside each mark
    labelText: String(s.labelText || "").replace(/\s+/g, " ").trim().slice(0, 40),   // "" = the set's name
    labelValue: s.labelValue === true,                                     // "Volume injected 0.1 mL"
    tagMarks: type === "number" && s.tagMarks === true,
    tags: tags.length ? tags : ["Treatment", "Touch-up"],
  };
}

/* ---------- Shapes: drawn on the picture (canvas) and shown in buttons (SVG) ---------- */

export function traceShape(g, shape, x, y, r) {
  g.beginPath();
  const poly = (pts) => { pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); };
  const ring = (n, rot, rr, dy = 0) => Array.from({ length: n }, (_, i) => {
    const a = rot + i * 2 * Math.PI / n;
    return [x + rr * Math.cos(a), y + dy + rr * Math.sin(a)];
  });
  switch (shape) {
    case "square": {
      const s = r * 0.88;
      if (g.roundRect) g.roundRect(x - s, y - s, 2 * s, 2 * s, r * 0.2); else g.rect(x - s, y - s, 2 * s, 2 * s);
      break;
    }
    case "target":
      g.arc(x, y, r, 0, Math.PI * 2);
      g.moveTo(x + r * 0.3, y);
      g.arc(x, y, r * 0.3, 0, Math.PI * 2);   // the centre dot (same direction, so a filled mark stays filled)
      break;
    case "diamond": poly(ring(4, -Math.PI / 2, r * 1.18)); break;
    case "triangle": poly(ring(3, -Math.PI / 2, r * 1.3, r * 0.2)); break;
    case "hexagon": poly(ring(6, 0, r * 1.06)); break;
    case "star": poly(Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const rr = i % 2 ? r * 0.62 : r * 1.3;
      return [x + rr * Math.cos(a), y + rr * Math.sin(a)];
    })); break;
    default: g.arc(x, y, r, 0, Math.PI * 2);
  }
}

// opts: { size, fill: "solid"|"none", textColour, tsize: "s"|"m"|"l" }
export function shapeSvg(shape, colour, text = "", { size = 30, fill = "solid", textColour = "", tsize = "m", tpos = "in" } = {}) {
  const r = 12, c = 20;
  const col = HEX.test(colour || "") ? colour : "#4b5563";
  const see = fill === "none";
  const tc = HEX.test(textColour || "") ? textColour : (see ? col : "#ffffff");
  const pts = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const ring = (n, rot, rr, dy = 0) => Array.from({ length: n }, (_, i) => {
    const a = rot + i * 2 * Math.PI / n;
    return [c + rr * Math.cos(a), c + dy + rr * Math.sin(a)];
  });
  let el;
  switch (shape) {
    case "square": el = `<rect x="${c - r * 0.88}" y="${c - r * 0.88}" width="${r * 1.76}" height="${r * 1.76}" rx="${r * 0.2}"/>`; break;
    case "target": el = `<circle cx="${c}" cy="${c}" r="${r}"/>`; break;
    case "diamond": el = `<polygon points="${pts(ring(4, -Math.PI / 2, r * 1.18))}"/>`; break;
    case "triangle": el = `<polygon points="${pts(ring(3, -Math.PI / 2, r * 1.3, r * 0.2))}"/>`; break;
    case "hexagon": el = `<polygon points="${pts(ring(6, 0, r * 1.06))}"/>`; break;
    case "star": el = `<polygon points="${pts(Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const rr = i % 2 ? r * 0.62 : r * 1.3;
      return [c + rr * Math.cos(a), c + rr * Math.sin(a)];
    }))}"/>`; break;
    default: el = `<circle cx="${c}" cy="${c}" r="${r}"/>`;
  }
  const bt = tpos === "below" ? String(text || "") : "";   // a label below the shape
  const t = !bt && shapeHasText(shape) ? String(text || "") : "";
  const st = SHAPE_TEXT[shape] || SHAPE_TEXT.circle;
  const vh = bt ? 54 : 40;   // taller, to make room for the label
  return `<svg class="ms-shape" viewBox="0 0 40 ${vh}" width="${size}" height="${Math.round(size * vh / 40)}" aria-hidden="true">` +
    `<g fill="${see ? "none" : col}" stroke="${see ? col : "#fff"}" stroke-width="${see ? 2.6 : 2}" stroke-linejoin="round">${el}</g>` +
    (shape === "target" ? `<circle cx="${c}" cy="${c}" r="${(r * 0.3).toFixed(1)}" fill="${see ? col : "#fff"}"/>` : "") +
    (t ? `<text x="${c}" y="${(c + r * st.dy).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif"` +
      ` font-weight="700" font-size="${(r * textSize(t, shape, tsize)).toFixed(1)}" fill="${tc}"${
        see ? ' stroke="#fff" stroke-width="2" paint-order="stroke"' : ""}>${esc(t)}</text>` : "") +
    (bt ? `<text x="${c}" y="${(c + r * (shapeBottom(shape) + 0.2)).toFixed(1)}" text-anchor="middle" dominant-baseline="hanging"` +
      ` font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${(r * belowSize(bt, tsize)).toFixed(1)}"` +
      ` fill="${belowColour(tc, col)}" stroke="#fff" stroke-width="2" paint-order="stroke">${esc(bt)}</text>` : "") +
    "</svg>";
}

// A marking set value as a little picture: its shape, colours and its number or code
export const valueText = (s, x) => (s.type === "label" ? x.code || ""
  : x.v === "" || x.v === null || x.v === undefined ? "" : fmtMark(x.v));
export const valueSvg = (s, x, size = 30) =>
  shapeSvg(x.shape || "circle", x.colour, valueText(s, x), { size, fill: x.fill, textColour: x.text, tsize: x.tsize, tpos: x.tpos });

/* ---------- Loading and saving ---------- */

let cache = null;
export async function listMarkingSets({ force = false } = {}) {
  if (cache && !force) return cache;
  const snap = await getDoc(doc(db, "form_settings", "marking_sets"));
  const raw = snap.exists() && Array.isArray(snap.data().sets) ? snap.data().sets : DEFAULT_SETS;
  cache = raw.map(cleanSet);
  return cache;
}

export async function saveMarkingSets(sets, staff) {
  const clean = sets.map(cleanSet);
  await setDoc(doc(db, "form_settings", "marking_sets"), {
    sets: clean, updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120),
  });
  cache = clean;
  return clean;
}

// "Units: 23.5 units (9 marks), Treatment 20 · Depth: SD × 5, PO × 4" (or "" when there are no marks)
export function markSummary(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.marks)
    || !(v.marks.length || (Array.isArray(v.arrows) && v.arrows.length))) return "";
  if (Array.isArray(v.sets) && v.sets.length) {
    return v.sets.filter((s) => Number(s.n) > 0 || Number(s.arrows) > 0).map((s) => {
      if (s.type === "label") {
        return `${s.name}: ${(s.counts || []).filter((c) => Number(c.n) > 0).map((c) => `${c.code} × ${c.n}`).join(", ")}`;
      }
      const tags = s.byTag && typeof s.byTag === "object"
        ? Object.entries(s.byTag).filter(([, x]) => Number(x) > 0).map(([t, x]) => `${t} ${fmtMark(x)}`) : [];
      return `${s.name}: ${s.totalLabel ? `${s.totalLabel} ` : ""}${fmtMark(s.total)}${s.unit ? ` ${s.unit}` : ""} (${[s.n ? `${s.n} mark${s.n === 1 ? "" : "s"}` : "", s.arrows ? `${s.arrows} arrow${s.arrows === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")})${tags.length ? `, ${tags.join(", ")}` : ""}`;
    }).join(" · ");
  }
  // Records saved before marking sets could be used separately
  const n = v.marks.length;
  const hasTotal = typeof v.total === "number";
  const parts = [];
  if (hasTotal) parts.push(`Total ${fmtMark(v.total)}${v.unit ? ` ${v.unit}` : ""}`);
  parts.push(`${n} mark${n === 1 ? "" : "s"}`);
  const tags = v.byTag && typeof v.byTag === "object" ? Object.entries(v.byTag).filter(([, x]) => Number(x) > 0) : [];
  tags.forEach(([t, x]) => parts.push(`${t} ${fmtMark(x)}`));
  (Array.isArray(v.labelSets) ? v.labelSets : []).forEach((ls) => {
    const counts = (Array.isArray(ls.counts) ? ls.counts : []).filter((c) => Number(c.n) > 0);
    if (counts.length) parts.push(`${ls.name}: ${counts.map((c) => `${c.code} × ${c.n}`).join(", ")}`);
  });
  return parts.join(" · ");
}

/* ---------- Managing the sets (Form Builder) ---------- */

/* The window's own icons */
const msi = (p) => `<svg class="msx-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const MSI = {
  x: msi('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  plus: msi('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  hash: msi('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
  tag: msi('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  eye: msi('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  dots: msi('<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/>'),
  sum: msi('<path d="M18 4H6l6 8-6 8h12"/>'),
  arrow: msi('<line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/>'),
  label: msi('<rect x="3" y="7" width="18" height="10" rx="5"/><line x1="7" y1="12" x2="17" y2="12"/>'),
  trash: msi('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  copy: msi('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
};
const ARROW_SVG = '<svg viewBox="0 0 80 30" aria-hidden="true"><line x1="72" y1="23" x2="16" y2="9" stroke="#dc2626" stroke-width="3" stroke-linecap="round"/>' +
  '<polygon points="8,7 21,4 18,15" fill="#dc2626"/><circle cx="72" cy="23" r="4.5" fill="#dc2626"/></svg>';
const SIZE_SHORT = [["s", "Small"], ["m", "Medium"], ["l", "Large"]];
const VAL_MAX = { number: 20, label: 12 };

// Resolves with the saved sets, or null if cancelled
export async function openMarkingSetsDialog({ staff } = {}) {
  let sets;
  try {
    sets = JSON.parse(JSON.stringify(await listMarkingSets({ force: true })));
  } catch (err) {
    console.error("Marking sets failed:", err);
    showToast("Couldn't load the marking sets. Try again.");
    return null;
  }
  return new Promise((resolve) => {
    let result = null;
    let busy = false;
    let dirty = false;
    let cur = 0;   // the set open on the right
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ms-dlg msx";
    dlg.setAttribute("aria-label", "Marking sets");
    dlg.innerHTML = `
      <form class="msx-form" novalidate>
        <header class="msx-head">
          <div><h3>Marking sets</h3>
            <p>What staff tap onto a picture. Shared by every form; forms already saved keep their own marks.</p></div>
          <button type="button" class="msx-x" data-act="cancel" aria-label="Close">${MSI.x}</button>
        </header>
        <div class="msx-body">
          <aside class="msx-rail">
            <div class="msx-rail-list" data-role="rail" aria-label="Marking sets"></div>
            <button type="button" class="msx-new" data-act="ms-new">${MSI.plus}New marking set</button>
          </aside>
          <div class="msx-main" data-role="main"></div>
        </div>
        <footer class="msx-foot">
          <p class="lh-error" role="alert" hidden></p>
          <span class="msx-state" data-role="state"></span>
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save</button>
        </footer>
      </form>`;
    const q = (s) => dlg.querySelector(s);
    const rail = q('[data-role="rail"]');
    const main = q('[data-role="main"]');
    const err = q(".lh-error");
    const stateEl = q('[data-role="state"]');

    const isLabel = (s) => s.type === "label";
    const unitText = (s) => (s.unit ? ` ${s.unit}` : "");
    const problemOf = (s) => { const c = cleanSet(s); return !c.name || !c.values.length; };
    // The label beside a mark, as it will read
    const lblText = (s, x) => [s.labelText || s.name || "Volume injected",
      s.labelValue && x ? (isLabel(s) ? (x.code || "SD") : `${fmtMark(x.v)}${unitText(s)}`) : ""].filter(Boolean).join(" ");
    const sel = (key, items, val, label) => `<select class="fb-select msx-sel" data-vk="${key}" aria-label="${label}" title="${label}">${items.map(([k, l]) =>
      `<option value="${k}"${k === val ? " selected" : ""}>${l}</option>`).join("")}</select>`;
    const sw = (key, value, label) => `<label class="msx-sw" title="${label}"><input type="color" data-vk="${key}" value="${esc(value)}" aria-label="${label}"></label>`;
    const switchHtml = (key, on, title, sub) => `<label class="msx-switch"><input type="checkbox" data-sk="${key}"${on ? " checked" : ""}>
      <span class="msx-switch-ui" aria-hidden="true"></span><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</span></label>`;
    const card = (icon, title, sub, body) => `<section class="msx-card"><header class="msx-ch"><span class="msx-ch-ic">${icon}</span>
      <div><h4>${title}</h4>${sub ? `<p>${sub}</p>` : ""}</div></header>${body}</section>`;
    const arrowDefaultOptions = (s) => `<option value="">None (staff choose each time)</option>${(s.arrowValues || []).map((v) =>
      `<option value="${v}"${Number(s.arrowDefault) === v ? " selected" : ""}>${fmtMark(v)}${s.unit ? ` ${esc(s.unit)}` : ""}</option>`).join("")}`;

    /* ---- The list on the left ---- */
    const railHtml = (s, i) => {
      const c = cleanSet(s, i);
      const extras = [c.labelOn && "label", c.arrowValues.length && "arrows", c.tagMarks && "tags"].filter(Boolean);
      return `<button type="button" class="msx-ri${i === cur ? " is-on" : ""}${problemOf(s) ? " is-bad" : ""}" data-pick-set="${i}"${i === cur ? ' aria-current="true"' : ""}>
        <span class="msx-ri-top"><strong>${esc(c.name || "Untitled set")}</strong>
          <em class="msx-type${isLabel(c) ? " is-label" : ""}">${isLabel(c) ? "Labels" : esc(c.unit || "Numbers")}</em></span>
        <span class="msx-ri-vals">${c.values.slice(0, 7).map((x) => valueSvg(c, x, 22)).join("")}${
          c.values.length > 7 ? `<small>+${c.values.length - 7}</small>` : ""}${c.values.length ? "" : "<small>No values yet</small>"}</span>
        ${extras.length ? `<small class="msx-ri-meta">With ${extras.join(", ")}</small>` : ""}
      </button>`;
    };

    /* ---- How it looks on the form ---- */
    function previewHtml(s) {
      const c = cleanSet(s, cur);
      const vals = c.values;
      const lbl = isLabel(c);
      const x0 = vals[0];
      const fig = !vals.length ? "" : lbl ? (vals.length === 1 ? "× 2" : `${vals[0].code} 2`)
        : `${c.totalLabel ? `${c.totalLabel}: ` : ""}${fmtMark(vals.slice(0, 2).reduce((a, x) => a + x.v, 0))}${unitText(c)}`;
      const av = c.arrowDefault ?? c.arrowValues[0];
      return `<div class="msx-pv-strip">
          <span class="msx-pv-name">${esc(c.name || "Untitled set")}${!lbl && c.unit ? ` <small>${esc(c.unit)}</small>` : ""}${fig ? `<b>${esc(fig)}</b>` : ""}</span>
          <span class="msx-pv-picks">${vals.length ? vals.map((x, i) => `<span class="msx-pv-pick${i ? "" : " is-on"}">${valueSvg(c, x, 36)}</span>`).join("")
            : "<em>Add a value below</em>"}</span>
        </div>
        <div class="msx-pv-pic">
          ${x0 ? `<span class="msx-pv-mark">${valueSvg(c, x0, 44)}${c.labelOn
            ? `<span class="msx-pv-pill" style="border-color:${esc(x0.colour)}">${esc(lblText(c, x0))}</span>` : ""}</span>` : ""}
          ${!lbl && av != null ? `<span class="msx-pv-arrow">${ARROW_SVG}<span class="msx-pv-pill is-arrow">${esc(`${fmtMark(av)}${unitText(c)}`)}</span></span>` : ""}
        </div>`;
    }

    /* ---- The chosen set ---- */
    const typeBtn = (s, type, icon, title, sub) => `<button type="button" class="msx-tb${s.type === type ? " is-on" : ""}" data-type="${type}"
      role="radio" aria-checked="${s.type === type}"><span class="msx-tb-ic">${icon}</span><span><b>${title}</b><small>${sub}</small></span></button>`;
    const valRow = (s, x, j) => {
      const lbl = isLabel(s);
      const noText = !showsText(x.shape, x.tpos);
      return `<div class="msx-v" data-v="${j}">
        <span class="msx-v-pv">${valueSvg(s, x, 34)}</span>
        ${lbl ? `<input class="fe-input msx-code" data-vk="code" maxlength="5" placeholder="SD" value="${esc(x.code || "")}" aria-label="Code">
                 <input class="fe-input" data-vk="name" maxlength="40" placeholder="Meaning (optional)" value="${esc(x.name || "")}" aria-label="Meaning">`
          : `<input class="fe-input msx-num" type="number" min="0" step="any" inputmode="decimal" data-vk="v" placeholder="0.1" value="${esc(x.v ?? "")}" aria-label="Value">`}
        ${sel("shape", MARK_SHAPES, x.shape || "circle", "Shape")}
        ${sw("colour", x.colour, "Shape colour")}
        ${sel("fill", [["solid", "Filled"], ["none", "Outline"]], x.fill || "solid", "Fill")}
        ${sel("tpos", shapeHasText(x.shape) ? [["in", "Inside"], ["below", "Below"]] : [["in", "None"], ["below", "Below"]], x.tpos || "in", "Text")}
        ${noText ? '<span class="msx-na"></span><span class="msx-na"></span>'
          : `${sw("text", x.text || "#ffffff", "Text colour")}${sel("tsize", SIZE_SHORT, x.tsize || "m", "Text size")}`}
        <button type="button" class="msx-ib is-danger" data-vdel aria-label="Remove this ${lbl ? "label" : "value"}" title="Remove">${MSI.trash}</button>
      </div>`;
    };
    function mainHtml() {
      const s = sets[cur];
      if (!s) {
        return `<div class="msx-empty"><span class="msx-ch-ic">${MSI.dots}</span><strong>No marking sets yet</strong>
          <p>Add one, then choose it on a picture in Form Builder.</p>
          <button type="button" class="lh-btn is-primary" data-act="ms-new">${MSI.plus}New marking set</button></div>`;
      }
      const lbl = isLabel(s);
      const max = VAL_MAX[lbl ? "label" : "number"];
      const heads = lbl ? ["", "Code", "Meaning", "Shape", "Colour", "Fill", "Text", "Text colour", "Size", ""]
        : ["", "Value", "Shape", "Colour", "Fill", "Text", "Text colour", "Size", ""];
      return `
        <section class="msx-card">
          <div class="msx-row">
            <label class="msx-f msx-grow"><span>Name</span><input class="fe-input" data-sk="name" maxlength="60"
              placeholder="${lbl ? "e.g. Depth of placement" : "e.g. Bolus volume"}" value="${esc(s.name)}"></label>
            ${lbl ? "" : `<label class="msx-f msx-unit"><span>Unit</span><input class="fe-input" data-sk="unit" maxlength="20" placeholder="mL" value="${esc(s.unit)}"></label>`}
          </div>
          <div class="msx-types" role="radiogroup" aria-label="Kind of set">
            ${typeBtn(s, "number", MSI.hash, "Numbers", "Add up to a total, e.g. 0.1 mL or 2 units")}
            ${typeBtn(s, "label", MSI.tag, "Labels", "Codes that are counted, e.g. SD, PO")}
          </div>
        </section>
        <section class="msx-card msx-pv"><header class="msx-ch"><span class="msx-ch-ic">${MSI.eye}</span>
          <div><h4>On the form</h4><p>How staff see this set while marking a picture.</p></div></header>
          <div data-role="pv">${previewHtml(s)}</div></section>
        ${card(MSI.dots, lbl ? "Labels" : "Values", lbl ? "Each code staff can place. Up to 12." : "Each amount staff can place. Up to 20; they're sorted when saved.",
          `<div class="msx-vals${lbl ? " is-label" : ""}">
            <div class="msx-vhead" aria-hidden="true">${heads.map((h) => `<span>${h}</span>`).join("")}</div>
            ${s.values.map((x, j) => valRow(s, x, j)).join("")}
          </div>
          <button type="button" class="msx-add" data-vadd${s.values.length >= max ? " disabled" : ""}>${MSI.plus}Add a ${lbl ? "label" : "value"}</button>`)}
        ${lbl ? "" : card(MSI.sum, "Total", "", `
          <label class="msx-f"><span>Name for the total <small>shown beside the set while marking</small></span>
            <input class="fe-input" data-sk="totalLabel" maxlength="40" placeholder="Leave empty for just the number, or e.g. Bolus injected" value="${esc(s.totalLabel || "")}"></label>
          ${switchHtml("tagMarks", s.tagMarks, "Tag each mark", "e.g. Treatment or Touch-up. Later tags are drawn dashed.")}
          ${s.tagMarks ? `<label class="msx-f"><span>Tags, separated by commas <small>the first is the default</small></span>
            <input class="fe-input" data-sk="tags" maxlength="120" placeholder="Treatment, Touch-up" value="${esc((s.tags || []).join(", "))}"></label>` : ""}`)}
        ${lbl ? "" : card(MSI.arrow, "Values on arrows and lines",
          "When staff use Dot (arrow) or Line, they can add one of these. It's written beside the arrow and adds to the total.", `
          <label class="msx-f"><span>Values, separated by commas</span>
            <input class="fe-input" data-sk="arrowValues" inputmode="decimal" maxlength="120" placeholder="e.g. 0.1, 0.2, 0.3, 0.5"
              value="${esc(s.arrowText ?? (s.arrowValues || []).join(", "))}"></label>
          <div class="msx-row">
            <label class="msx-f msx-grow"><span>Pre-selected</span><select class="fb-select" data-sk="arrowDefault">${arrowDefaultOptions(s)}</select></label>
            ${switchHtml("arrowOther", s.arrowOther, "Let staff type another value", "Adds an Other button")}
          </div>`)}
        ${card(MSI.label, "Label beside each mark", "A small pill next to every mark on the picture. Staff can change it on one mark by tapping it.", `
          ${switchHtml("labelOn", s.labelOn, "Show a label beside each mark", "")}
          ${s.labelOn ? `<div class="msx-row">
            <label class="msx-f msx-grow"><span>Label</span><input class="fe-input" data-sk="labelText" maxlength="40"
              placeholder="${esc(s.name || "e.g. Volume injected")}" value="${esc(s.labelText || "")}"></label>
            ${switchHtml("labelValue", s.labelValue, "Include the value", lbl ? "e.g. Depth SD" : "e.g. Volume injected 0.1 mL")}
          </div>` : ""}`)}
        <div class="msx-setacts">
          <button type="button" class="lh-btn" data-setdup>${MSI.copy}Duplicate this set</button>
          <button type="button" class="lh-btn msx-del" data-setdel>${MSI.trash}Delete this set</button>
        </div>`;
    }

    /* ---- Drawing ---- */
    function paintRail() {
      rail.innerHTML = sets.length ? sets.map(railHtml).join("") : '<p class="msx-ri-meta">No marking sets yet.</p>';
    }
    function paintPreview() {
      const pv = main.querySelector('[data-role="pv"]');
      if (pv && sets[cur]) pv.innerHTML = previewHtml(sets[cur]);
    }
    function paintState() { stateEl.textContent = dirty ? "Unsaved changes" : ""; }
    function draw() { paintRail(); main.innerHTML = mainHtml(); paintState(); }
    const touched = () => { dirty = true; paintPreview(); paintRail(); paintState(); };

    async function tryClose() {
      if (busy) return;
      if (dirty && !(await confirmDialog({ title: "Close without saving?", message: "Your changes to the marking sets haven't been saved.",
        confirmLabel: "Close without saving", tone: "warning" }))) return;
      dlg.close();
    }

    /* ---- Typing ---- */
    dlg.addEventListener("input", (e) => {
      const t = e.target;
      const s = sets[cur];
      if (!s || !main.contains(t)) return;
      err.hidden = true;
      const k = t.dataset.sk;
      if (k) {
        if (k === "tagMarks" || k === "labelOn") { s[k] = t.checked; dirty = true; draw(); return; }
        if (k === "arrowOther" || k === "labelValue") s[k] = t.checked;
        else if (k === "tags") s.tags = t.value.split(",").map((x) => x.trim()).filter(Boolean);
        else if (k === "arrowValues") {
          s.arrowText = t.value;   // kept as typed while editing (not saved)
          s.arrowValues = cleanArrowValues(t.value);
          if (!s.arrowValues.includes(Number(s.arrowDefault))) s.arrowDefault = null;
          const ds = main.querySelector('[data-sk="arrowDefault"]');
          if (ds) ds.innerHTML = arrowDefaultOptions(s);
        } else if (k === "arrowDefault") s.arrowDefault = t.value === "" ? null : Number(t.value);
        else s[k] = t.value;
        touched();
        return;
      }
      const vb = t.closest("[data-v]");
      if (!vb || !t.dataset.vk) return;
      const x = s.values[Number(vb.dataset.v)];
      x[t.dataset.vk] = t.value;
      // Circle with dot: outline (a ring and a dot, like it's drawn by hand)
      if (t.dataset.vk === "shape" || t.dataset.vk === "tpos") {
        if (t.dataset.vk === "shape" && !shapeHasText(t.value) && x.fill !== "none") { x.fill = "none"; x.text = x.colour; }
        dirty = true;
        draw();
        return;
      }
      // The text stays readable when switching between filled and outline
      if (t.dataset.vk === "fill") {
        if (t.value === "none" && String(x.text).toLowerCase() === "#ffffff") x.text = x.colour;
        if (t.value === "solid" && String(x.text).toLowerCase() === String(x.colour).toLowerCase()) x.text = "#ffffff";
        const tx = vb.querySelector('[data-vk="text"]');
        if (tx) tx.value = x.text;
      }
      const pv = vb.querySelector(".msx-v-pv");
      if (pv) pv.innerHTML = valueSvg(s, x, 34);
      touched();
    });

    /* ---- Buttons ---- */
    dlg.addEventListener("click", async (e) => {
      const t = e.target;
      if (t.closest('[data-act="cancel"]')) { tryClose(); return; }
      if (t.closest('[data-act="ms-new"]')) {
        sets.push({ id: `ms_${Date.now().toString(36)}`, name: "", type: "number", unit: "mL",
          values: [{ v: 0.1, ...newStyle(MARK_COLOURS[0]) }], tagMarks: false, tags: ["Treatment", "Touch-up"] });
        cur = sets.length - 1;
        dirty = true;
        draw();
        main.scrollTop = 0;
        main.querySelector('[data-sk="name"]')?.focus();
        return;
      }
      const ps = t.closest("[data-pick-set]");
      if (ps) { cur = Number(ps.dataset.pickSet); draw(); main.scrollTop = 0; return; }
      const s = sets[cur];
      if (!s) return;
      const ty = t.closest("[data-type]");
      if (ty) {
        const to = ty.dataset.type;
        if (to === s.type) return;
        const has = s.values.some((x) => String(isLabel(s) ? x.code || "" : x.v ?? "").trim() !== "");
        if (has && !(await confirmDialog({ title: `Change “${s.name || "this set"}” to ${to === "label" ? "Labels" : "Numbers"}?`,
          message: "Its values are cleared, because numbers and labels are set up differently.", confirmLabel: "Change it", tone: "warning" }))) return;
        s.type = to;
        s.tagMarks = false;
        s.values = to === "label" ? [{ code: "", name: "", ...newStyle(MARK_COLOURS[0]) }] : [{ v: 0.1, ...newStyle(MARK_COLOURS[0]) }];
        dirty = true;
        draw();
        return;
      }
      if (t.closest("[data-setdup]")) {
        const copy = JSON.parse(JSON.stringify(s));
        copy.id = `ms_${Date.now().toString(36)}`;
        copy.name = `${s.name || "Marking set"} (copy)`.slice(0, 60);
        sets.splice(cur + 1, 0, copy);
        cur += 1;
        dirty = true;
        draw();
        main.scrollTop = 0;
        main.querySelector('[data-sk="name"]')?.select();
        return;
      }
      if (t.closest("[data-setdel]")) {
        if (!(await confirmDialog({ title: `Delete “${s.name || "this set"}”?`,
          message: "Pictures that use it can only draw until another set is chosen in Form Builder. Forms already saved keep their marks.",
          confirmLabel: "Delete", tone: "danger" }))) return;
        sets.splice(cur, 1);
        cur = Math.max(0, Math.min(cur, sets.length - 1));
        dirty = true;
        draw();
        return;
      }
      if (t.closest("[data-vadd]")) {
        const st = newStyle(MARK_COLOURS[s.values.length % MARK_COLOURS.length]);
        s.values.push(isLabel(s) ? { code: "", name: "", ...st } : { v: "", ...st });
        dirty = true;
        draw();
        const ins = main.querySelectorAll(`[data-vk="${isLabel(s) ? "code" : "v"}"]`);
        const last = ins[ins.length - 1];
        if (last) { last.scrollIntoView({ block: "nearest" }); last.focus(); }
        return;
      }
      const vd = t.closest("[data-vdel]");
      if (vd) { s.values.splice(Number(vd.closest("[data-v]").dataset.v), 1); dirty = true; draw(); }
    });

    // Enter in a box doesn't save by accident; Ctrl + S does
    dlg.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); dlg.querySelector("form").requestSubmit(); return; }
      if (e.key === "Enter" && e.target.matches("input:not([type=checkbox])")) e.preventDefault();
    });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); tryClose(); });

    /* ---- Saving ---- */
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const clean = sets.map(cleanSet);
      const badAt = clean.findIndex((s) => !s.name || !s.values.length);
      if (badAt >= 0) {   // straight to the set that needs fixing
        const b = clean[badAt];
        cur = badAt;
        draw();
        err.textContent = !b.name ? "Give every marking set a name."
          : b.type === "label" ? `“${b.name}” needs at least one label code (e.g. SD).` : `“${b.name}” needs at least one value above 0.`;
        err.hidden = false;
        main.querySelector(!b.name ? '[data-sk="name"]' : "[data-vk]")?.focus();
        return;
      }
      err.hidden = true;
      busy = true;
      const btn = dlg.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        result = await saveMarkingSets(clean, staff);
        busy = false;
        dirty = false;
        dlg.close();
        showToast("Marking sets saved");
      } catch (ex) {
        console.error("Save marking sets failed:", ex);
        busy = false;
        err.textContent = ex && ex.code === "permission-denied"
          ? "You don't have access. Check the marking_sets Firestore rule has been published."
          : "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Save";
      }
    });

    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    draw();
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}