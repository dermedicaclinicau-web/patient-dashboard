// Each kind of tab gets its own small icon and title, so open tabs can be told apart at a glance.
// Admins set the icon, colour and name of each kind in System configuration → Browser tabs (ui_settings/tabs).
// While a page has its own title or icon, they're held: anything else that changes them is put back.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ===================== What Settings → Browser tabs can change ===================== */

const S = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// Ready-made icons. calendar, drop and mic are drawn extra bold (they're the ones the portal already used).
export const TAB_PRESETS = {
  calendar: { label: "Calendar" },
  drop: { label: "Drop" },
  mic: { label: "Microphone" },
  user: { label: "Person", svg: S('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>') },
  users: { label: "People", svg: S('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>') },
  file: { label: "Document", svg: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>') },
  clipboard: { label: "Clipboard", svg: S('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>') },
  check: { label: "Tick", svg: S('<polyline points="20 6 9 17 4 12"/>') },
  heart: { label: "Heart", svg: S('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>') },
  star: { label: "Star", svg: S('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>') },
  sparkle: { label: "Sparkle", svg: S('<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>') },
  syringe: { label: "Syringe", svg: S('<path d="m18 2 4 4"/><path d="m17 7 3-3"/><path d="M19 9 8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5"/><path d="m9 11 4 4"/><path d="m5 19-3 3"/><path d="m14 4 6 6"/>') },
  box: { label: "Box", svg: S('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>') },
  chart: { label: "Chart", svg: S('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>') },
  mail: { label: "Email", svg: S('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>') },
  money: { label: "Money", svg: S('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>') },
  search: { label: "Search", svg: S('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>') },
  home: { label: "Home", svg: S('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>') },
  bell: { label: "Bell", svg: S('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>') },
  phone: { label: "Phone", svg: S('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>') },
  camera: { label: "Camera", svg: S('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>') },
  book: { label: "Book", svg: S('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>') },
  megaphone: { label: "Megaphone", svg: S('<path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6"/><path d="M19 6a7 7 0 0 1 0 12"/>') },
  gear: { label: "Settings", svg: S('<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>') },
  moon: { label: "Moon", svg: S('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>') },
  sun: { label: "Sun", svg: S('<circle cx="12" cy="12" r="5"/><path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>') },
};

export const TAB_COLOURS = ["#0F766E", "#0891B2", "#2563EB", "#4F46E5", "#7C3AED", "#C026D3", "#DB2777", "#E11D48",
  "#DC2626", "#EA580C", "#F97316", "#D97706", "#65A30D", "#16A34A", "#475569", "#111827"];

// Tabs that aren't menu pages. The standard look is what the portal has always used.
export const TAB_RECORD_KINDS = [
  { key: "patient", label: "Patient page", desc: "A patient's dashboard", vars: ["Patient"], menuIcon: "patients",
    sample: { patient: "Jane Smith" }, def: { icon: "menu", text: "", bg: "#0F766E", bg2: "", title: "{Patient}" } },
  { key: "tx", label: "Treatment record", desc: "A treatment record opened in its own tab", vars: ["Patient", "Form"],
    sample: { patient: "Jane Smith", form: "Anti-wrinkle treatment" }, def: { icon: "letters", text: "TxR", bg: "#F97316", bg2: "#C2410C", title: "TxR · {Patient}" } },
  { key: "consent", label: "Consent", desc: "A consent form opened in its own tab", vars: ["Patient", "Form"],
    sample: { patient: "Jane Smith", form: "Filler consent" }, def: { icon: "letters", text: "C", bg: "#7C3AED", bg2: "", title: "Consent · {Patient}" } },
  { key: "rx", label: "Prescription form", desc: "A prescription form (Form Builder) opened in its own tab", vars: ["Patient", "Form"],
    sample: { patient: "Jane Smith", form: "Prescription" }, def: { icon: "letters", text: "Rx", bg: "#DB2777", bg2: "", title: "Rx · {Patient}" } },
  { key: "rxWrite", label: "Product prescription", desc: "Writing a prescription, or a saved one opened to print again", vars: ["Patient"],
    sample: { patient: "Jane Smith" }, def: { icon: "letters", text: "Rx", bg: "#14B8A6", bg2: "#0F766E", title: "Rx · {Patient}" } },
  { key: "ssp", label: "Skin Script", desc: "The Skin Script builder", vars: ["Patient"],
    sample: { patient: "Jane Smith" }, def: { icon: "drop", text: "", bg: "#E11D48", bg2: "", title: "Skin Script · {Patient}" } },
  // The Consultation tab, and notes opened in their own tab (the standard: the dots and names the portal has always used)
  { key: "consult", group: "consult", label: "Consultation", desc: "The Consultation tab, before recording starts", vars: ["Patient"],
    sample: { patient: "Jane Smith" }, def: { icon: "dot", text: "", bg: "#16A34A", bg2: "", title: "Consultation · {Patient}" } },
  { key: "rec", group: "consult", label: "Recording", desc: "While an appointment is being recorded", vars: ["Patient", "Time"],
    sample: { patient: "Jane Smith", time: "12:34" }, def: { icon: "dot", text: "", bg: "#DC2626", bg2: "", title: "● {Time} · {Patient}" } },
  { key: "recPaused", group: "consult", label: "Recording paused", desc: "A recording on pause", vars: ["Patient", "Time"],
    sample: { patient: "Jane Smith", time: "12:34" }, def: { icon: "dot", text: "", bg: "#D97706", bg2: "", title: "⏸ {Time} · {Patient}" } },
  { key: "writing", group: "consult", label: "Writing notes", desc: "After Complete appointment, while the notes are written", vars: ["Patient"],
    sample: { patient: "Jane Smith" }, def: { icon: "dot", text: "", bg: "#16A34A", bg2: "", title: "Writing notes… · {Patient}" } },
  { key: "attention", group: "consult", label: "Needs attention", desc: "The upload or the notes didn't work", vars: ["Patient"],
    sample: { patient: "Jane Smith" }, def: { icon: "dot", text: "", bg: "#16A34A", bg2: "", title: "⚠ Needs attention · {Patient}" } },
  { key: "ready", group: "consult", label: "Notes ready", desc: "The notes are written, in the Consultation tab", vars: ["Patient"],
    sample: { patient: "Jane Smith" }, def: { icon: "dot", text: "", bg: "#16A34A", bg2: "", title: "✓ Notes ready · {Patient}" } },
  { key: "notesDraft", group: "consult", label: "Notes: draft", desc: "Notes in their own tab, not reviewed yet", vars: ["Patient"],
    sample: { patient: "Jane Smith" }, def: { icon: "dot", text: "", bg: "#EAB308", bg2: "", title: "Draft · {Patient}" } },
  { key: "notesReviewed", group: "consult", label: "Notes: reviewed", desc: "Notes in their own tab, saved as Reviewed", vars: ["Patient"],
    sample: { patient: "Jane Smith" }, def: { icon: "dot", text: "", bg: "#16A34A", bg2: "", title: "✓ Reviewed · {Patient}" } },
];
const REC_LABEL = { tx: "TxR", consent: "Consent", rx: "Rx", ssp: "Skin Script" };

// Menu pages with their own standard colour (the rest are teal)
const MENU_BG = { calendar: "#DC2626" };
const TEAL = "#0F766E";
const HEX = /^#[0-9a-f]{6}$/i;
const KEY_OK = /^(menu:[a-z0-9-]{1,40}|patient|tx|consent|rx|rxWrite|ssp|consult|rec|recPaused|writing|attention|ready|notesDraft|notesReviewed)$/;

// The standard look of a kind of tab
export function tabDefault(key) {
  const rec = TAB_RECORD_KINDS.find((k) => k.key === key);
  if (rec) return { ...rec.def };
  const page = String(key).replace(/^menu:/, "");
  return { icon: "menu", text: "", bg: MENU_BG[page] || TEAL, bg2: "", title: "{Page}" };
}

function cleanSpec(s, def) {
  s = s && typeof s === "object" ? s : {};
  const icon = ["menu", "letters", "dot"].includes(s.icon) || TAB_PRESETS[s.icon] ? s.icon : def.icon;
  return {
    icon,
    text: String(s.text ?? def.text ?? "").replace(/\s+/g, "").slice(0, 3),
    bg: HEX.test(s.bg || "") ? s.bg.toUpperCase() : def.bg,
    bg2: s.bg2 === "" ? "" : HEX.test(s.bg2 || "") ? s.bg2.toUpperCase() : (def.bg2 || ""),
    title: typeof s.title === "string" ? s.title.replace(/\s+/g, " ").slice(0, 80) : def.title,
  };
}

export function cleanTabKinds(kinds) {
  const out = {};
  Object.entries(kinds && typeof kinds === "object" ? kinds : {}).slice(0, 80).forEach(([k, v]) => {
    if (KEY_OK.test(k)) out[k] = cleanSpec(v, tabDefault(k));
  });
  return out;
}

// Remembered on each computer, so tabs look right the moment the portal opens
const CACHE_KEY = "dm.tabSettings";
let cfg = (() => { try { return cleanTabKinds(JSON.parse(localStorage.getItem(CACHE_KEY) || "{}")); } catch { return {}; } })();
export const getTabSettings = () => cfg;
export const tabSpecOf = (key, kinds = cfg) => cleanSpec((kinds || {})[key], tabDefault(key));

// "TxR · {Patient}" → "TxR · Jane Smith". A separator left at either end (an empty name) is tidied away.
export function fillTabTitle(tpl, vals = {}, fallback = "") {
  const t = String(tpl || "")
    .replace(/\{\s*([a-z ]+?)\s*\}/gi, (all, k) => { const v = vals[k.toLowerCase()]; return v === undefined ? all : String(v || ""); })
    .replace(/\s+/g, " ")
    .replace(/^[\s·|:–—-]+|[\s·|:–—-]+$/g, "")
    .trim();
  return t || fallback;
}

let lastCall = null;   // the page's own tab request, run again when the settings change

// After login (and every few minutes): the settings saved in System configuration → Browser tabs
export async function loadTabSettings() {
  try {
    const s = await getDoc(doc(db, "ui_settings", "tabs"));
    applyTabSettings(s.exists() ? s.data().kinds : {});
  } catch (err) { console.warn("Tab settings not loaded:", err); }
}
export function applyTabSettings(kinds) {
  const next = cleanTabKinds(kinds);
  const changed = JSON.stringify(next) !== JSON.stringify(cfg);
  cfg = next;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cfg)); } catch { /* private mode */ }
  if (changed && lastCall) { shown = ""; lastCall(); }
}

/* ===================== Built-in kinds (not in Settings): the notes and recording dots ===================== */

const KINDS = {
  notes: { bg: "#16a34a", dot: true },        // consultation notes: a green dot (Reviewed)
  notesDraft: { bg: "#eab308", dot: true },   // consultation notes still a Draft: a yellow dot
  recording: { bg: "#dc2626", dot: true },    // recording right now: a red dot
  recPaused: { bg: "#d97706", dot: true },    // recording paused: an amber dot
  calendar: { bg: "#DC2626", icon: "calendar" },
};
const RECORD_KEYS = ["tx", "consent", "rx", "ssp"];

let originals = null;    // the portal's own icon links, put back on other pages
let shown = "";          // the icon showing now (its key in urls)
let wanted = "";         // the title this page asked for ("" = leave the title alone)
let asked = "";          // the icon the page asked for ("notes" can show as green or yellow)

// Notes: yellow while the tab's name starts with "Draft", green otherwise
const notesKind = () => (/^\s*draft\b/i.test(wanted || document.title) ? "notesDraft" : "notes");
const urls = new Map();  // key → the drawn icon

/* ---------- Drawing ---------- */

function square(g, bg, bg2) {
  const r = 14;
  g.beginPath();
  g.moveTo(r, 0); g.lineTo(64 - r, 0); g.quadraticCurveTo(64, 0, 64, r);
  g.lineTo(64, 64 - r); g.quadraticCurveTo(64, 64, 64 - r, 64);
  g.lineTo(r, 64); g.quadraticCurveTo(0, 64, 0, 64 - r);
  g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0);
  g.closePath();
  if (bg2) {   // a top-left to bottom-right blend
    const grad = g.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, bg2);
    g.fillStyle = grad;
  } else g.fillStyle = bg;
  g.fill();
}

function letters(g, text) {
  const size = text.length >= 3 ? 27 : text.length === 2 ? 36 : 46;
  g.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 32, 35);
}

// A soft halo with a solid dot inside (the notes and recording tabs), so it's still clear at 16px
function dot(g, colour) {
  g.save();
  g.fillStyle = colour;
  g.globalAlpha = 0.25;
  g.beginPath(); g.arc(32, 32, 31, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 1;
  g.beginPath(); g.arc(32, 32, 22, 0, Math.PI * 2); g.fill();
  g.fillStyle = "rgba(255, 255, 255, .35)";        // a small highlight
  g.beginPath(); g.arc(25, 25, 7, 0, Math.PI * 2); g.fill();
  g.restore();
}

// The bold built-in icons
function special(g, name) {
  if (name === "calendar") {
    const box = new Path2D();
    if (box.roundRect) box.roundRect(12, 15, 40, 37, 6); else box.rect(12, 15, 40, 37);
    g.lineWidth = 5;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.stroke(box);
    g.fillRect(12, 15, 40, 11);
    g.beginPath();
    g.moveTo(23, 9); g.lineTo(23, 19);
    g.moveTo(41, 9); g.lineTo(41, 19);
    g.stroke();
    [[22, 37], [32, 37], [42, 37], [22, 46], [32, 46]].forEach(([x, y]) => g.fillRect(x - 3, y - 3, 6, 6));
    return true;
  }
  if (name === "drop") {
    g.save();
    g.translate(5.6, 4.5);
    g.scale(2.2, 2.2);
    g.fill(new Path2D("M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"));
    g.restore();
    return true;
  }
  if (name === "mic") {
    g.save();
    g.translate(8, 6);
    g.scale(2, 2);
    g.lineWidth = 2.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.fill(new Path2D("M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"));
    g.stroke(new Path2D("M19 10v2a7 7 0 0 1-14 0v-2"));
    g.stroke(new Path2D("M12 19v4"));
    g.restore();
    return true;
  }
  return false;
}

// An attribute set on the shape itself or on anything around it inside the icon (fill="none" is usually on the <svg>)
function attrUp(el, svg, name) {
  for (let n = el; n; n = n.parentElement) {
    const v = n.getAttribute(name);
    if (v != null) return v;
    if (n === svg) break;
  }
  return null;
}

// An SVG icon's shapes, redrawn white in the middle of the square (fills about 60% of it)
function svgShapes(g, svg) {
  let vb = String(svg.getAttribute("viewBox") || "0 0 24 24").trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) vb = [0, 0, 24, 24];
  const [vx, vy, vw, vh] = vb;
  const s = 38 / Math.max(vw, vh);
  g.save();
  g.translate((64 - vw * s) / 2 - vx * s, (64 - vh * s) / 2 - vy * s);
  g.scale(s, s);
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  g.lineCap = "round";
  g.lineJoin = "round";
  const num = (el, k) => parseFloat(el.getAttribute(k)) || 0;
  svg.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon").forEach((el) => {
    const t = el.tagName.toLowerCase();
    let p;
    if (t === "path") {
      const d = el.getAttribute("d");
      if (!d) return;
      p = new Path2D(d);
    } else {
      p = new Path2D();
      if (t === "rect") {
        const r = num(el, "rx") || num(el, "ry");
        if (r && p.roundRect) p.roundRect(num(el, "x"), num(el, "y"), num(el, "width"), num(el, "height"), r);
        else p.rect(num(el, "x"), num(el, "y"), num(el, "width"), num(el, "height"));
      } else if (t === "circle") {
        p.arc(num(el, "cx"), num(el, "cy"), num(el, "r"), 0, Math.PI * 2);
      } else if (t === "ellipse") {
        p.ellipse(num(el, "cx"), num(el, "cy"), num(el, "rx"), num(el, "ry"), 0, 0, Math.PI * 2);
      } else if (t === "line") {
        p.moveTo(num(el, "x1"), num(el, "y1"));
        p.lineTo(num(el, "x2"), num(el, "y2"));
      } else {
        const pts = String(el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
        for (let i = 0; i + 1 < pts.length; i += 2) {
          if (i === 0) p.moveTo(pts[i], pts[i + 1]); else p.lineTo(pts[i], pts[i + 1]);
        }
        if (t === "polygon") p.closePath();
      }
    }
    const fill = attrUp(el, svg, "fill");
    const stroke = attrUp(el, svg, "stroke");
    if (fill == null || fill !== "none") g.fill(p);   // SVG fills by default unless told "none"
    if (stroke && stroke !== "none") {
      // A touch bolder than the sidebar, so the icon is still clear at 16px
      g.lineWidth = Math.max(parseFloat(attrUp(el, svg, "stroke-width")) || 2, 2.25);
      g.stroke(p);
    }
  });
  g.restore();
}

function svgFrom(str) {
  const t = document.createElement("template");
  t.innerHTML = String(str).trim();
  return t.content.firstElementChild;
}

// The icon for a look (icon, letters, colours), as a picture. Drawn once and kept.
export const tabIconKey = (s, menuKey = "") => ["spec", s.icon, s.text, s.bg, s.bg2, s.icon === "menu" ? menuKey : ""].join("|");
export function tabIconUrl(s, menuSvg = null, menuKey = "") {
  const key = tabIconKey(s, menuKey);
  if (urls.has(key)) return urls.get(key);
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (s.icon === "dot") dot(g, s.bg || TEAL);
  else square(g, s.bg || TEAL, s.bg2 || "");
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  if (s.icon === "dot") { /* nothing on top */ }
  else if (s.icon === "letters") letters(g, s.text || "?");
  else if (s.icon === "menu") { if (menuSvg) svgShapes(g, menuSvg); else letters(g, "?"); }
  else if (!special(g, s.icon)) {
    const p = TAB_PRESETS[s.icon];
    if (p && p.svg) svgShapes(g, svgFrom(p.svg));
  }
  const url = c.toDataURL("image/png");
  urls.set(key, url);
  return url;
}

// The built-in kinds: a dot (notes, recording) or the bold calendar
function drawIcon(kind) {
  if (urls.has(kind)) return urls.get(kind);
  const k = KINDS[kind];
  if (!k.dot) {
    const url = tabIconUrl({ icon: k.icon, text: "", bg: k.bg, bg2: "" });
    urls.set(kind, url);
    return url;
  }
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  // A soft halo with a solid dot inside, so it's still clear at 16px
  g.fillStyle = k.bg;
  g.globalAlpha = 0.25;
  g.beginPath(); g.arc(32, 32, 31, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 1;
  g.beginPath(); g.arc(32, 32, 22, 0, Math.PI * 2); g.fill();
  g.fillStyle = "rgba(255, 255, 255, .35)";        // a small highlight
  g.beginPath(); g.arc(25, 25, 7, 0, Math.PI * 2); g.fill();
  const url = c.toDataURL("image/png");
  urls.set(kind, url);
  return url;
}

/* ---------- Putting the icon in ---------- */

const iconLinks = () => [...document.querySelectorAll('link[rel~="icon"]')];

// Chrome only notices a new icon reliably when the other icon links are gone and a new one is added
function putIcon(href) {
  const links = iconLinks();
  if (originals === null) originals = links.filter((l) => !l.dataset.tabIcon).map((l) => l.cloneNode());
  links.forEach((l) => l.remove());
  if (href) {
    const l = document.createElement("link");
    l.rel = "icon";
    l.type = "image/png";
    l.href = href;
    l.dataset.tabIcon = "1";
    document.head.appendChild(l);
  } else {
    (originals || []).forEach((l) => document.head.appendChild(l.cloneNode()));
  }
}

function show(key, url) {
  if (shown === key) return;
  shown = key;
  urls.set(key, url);
  putIcon(url);
  keep();
}

/* ---------- Holding them ---------- */

let keeper = null;
let fixing = false;
function keep() {
  if (keeper) return;
  keeper = new MutationObserver(() => {
    if (fixing) return;
    fixing = true;
    try {
      if (wanted && document.title !== wanted) document.title = wanted;
      if (shown) {
        const links = iconLinks();
        const mine = links.some((l) => l.dataset.tabIcon);
        if (!mine || links.some((l) => !l.dataset.tabIcon)) putIcon(urls.get(shown) || "");
      }
    } catch (err) { console.warn("Tab title or icon not kept:", err); }
    fixing = false;
  });
  keeper.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
}

/* ---------- Menu pages and the patient page ---------- */

// A menu page's tab: as set in Settings (standard: the sidebar icon on teal, and the menu name)
export function setMenuTab(key, svg, label) {
  lastCall = () => setMenuTab(key, svg, label);
  asked = "";
  const s = tabSpecOf(`menu:${key}`);
  if (label) setTabTitle(fillTabTitle(s.title, { page: label }, label));
  if (!key || (s.icon === "menu" && !svg)) return;
  try { show(tabIconKey(s, key), tabIconUrl(s, svg, key)); }
  catch (err) { shown = ""; console.warn("Menu tab icon not set:", err); }
}

// A patient's dashboard. name "" while it's loading.
export function setPatientTab(svg, name = "") {
  lastCall = () => setPatientTab(svg, name);
  asked = "";
  const s = tabSpecOf("patient");
  const who = name || "Patient";
  setTabTitle(fillTabTitle(s.title, { patient: who, page: "Patient" }, who));
  if (s.icon === "menu" && !svg) return;
  try { show(tabIconKey(s, "patient"), tabIconUrl(s, svg, "patient")); }
  catch (err) { shown = ""; console.warn("Patient tab icon not set:", err); }
}

/* ---------- The Consultation tab, and notes in their own tab ---------- */

const STATE_KEYS = ["consult", "rec", "recPaused", "writing", "attention", "ready", "notesDraft", "notesReviewed"];
// The names other files use for these dots, and the kind in Settings each one now follows
const STATE_OF = { recording: "rec", recPaused: "recPaused", notesDraft: "notesDraft", notes: "notesReviewed" };
let noteState = "";   // the notes' real status ("notesDraft" or "notes"), so the colour never depends on the tab's name

// kind: one of STATE_KEYS. vals: { patient, time }
export function setStateTab(kind, vals = {}) {
  if (!STATE_KEYS.includes(kind)) return;
  lastCall = () => setStateTab(kind, vals);
  if (kind === "notesDraft") noteState = "notesDraft";
  else if (kind === "notesReviewed") noteState = "notes";
  asked = "";
  const s = tabSpecOf(kind);
  const label = (TAB_RECORD_KINDS.find((k) => k.key === kind) || {}).label || "";
  setTabTitle(fillTabTitle(s.title, vals, vals.patient ? `${label} · ${vals.patient}` : label));
  try { show(tabIconKey(s), tabIconUrl(s)); }
  catch (err) { shown = ""; console.warn("Tab icon not set:", err); }
}

/* ---------- Other pages ---------- */

export function setTabIcon(kind) {
  const rec = RECORD_KEYS.includes(kind);
  if (!KINDS[kind] && !rec) { resetTabIcon(); return; }
  asked = kind;
  const real = kind === "notes" ? (noteState || notesKind()) : kind;
  const key = rec ? real : STATE_OF[real] || "";
  try {
    if (key) { const s = tabSpecOf(key); show(tabIconKey(s), tabIconUrl(s)); }
    else show(real, drawIcon(real));
  } catch (err) {
    shown = "";
    console.warn("Tab icon not set:", err);
  }
}

export function resetTabIcon() {
  asked = "";
  lastCall = null;
  noteState = "";
  if (!shown) return;
  shown = "";
  putIcon("");
}

// This page's tab title, held until the next page change
export function setTabTitle(text) {
  wanted = String(text || "");
  if (!wanted) return;
  if (document.title !== wanted) document.title = wanted;
  keep();
  if (asked === "notes") setTabIcon("notes");   // Draft → Reviewed: the dot changes colour with the name
}

// Page change: stop holding, and go back to the usual title
export function clearTabTitle(base) {
  wanted = "";
  if (base != null) document.title = base;
}

/* ---------- Records ---------- */

// A saved form's kind of tab ("" = the usual icon)
export function formTabKind(category, templateName = "") {
  const c = String(category || "").toLowerCase();
  if (c === "treatment") return "tx";
  if (c === "consent") return "consent";
  if (c === "rx" || c === "prescription" || /prescription/i.test(templateName)) return "rx";
  return "";
}

// A form's tab, as set in Settings (standard: TxR, C or Rx, and "TxR · Jane Smith"). false = an ordinary form.
export function setFormTab(category, templateName, patientName) {
  const kind = formTabKind(category, templateName);
  if (!kind) return false;
  setTabIcon(kind);
  const who = patientName || "Patient";
  const s = tabSpecOf(kind);
  setTabTitle(fillTabTitle(s.title, { patient: who, form: templateName || REC_LABEL[kind] }, `${REC_LABEL[kind]} · ${who}`));
  lastCall = () => setFormTab(category, templateName, patientName);
  return true;
}
// The Skin Script builder's tab, as set in Settings (standard: the rose drop, and "Skin Script · Jane Smith")
export function setSspTab(patientName) {
  setTabIcon("ssp");
  const who = patientName || "Patient";
  setTabTitle(fillTabTitle(tabSpecOf("ssp").title, { patient: who }, `Skin Script · ${who}`));
  lastCall = () => setSspTab(patientName);
}
// The Prescription page, as set in Settings (standard: Rx on teal, and "Rx · Jane Smith").
// who: the patient ("New prescription" before one is chosen). page: a name of its own (Set up the paper).
export function setRxTab(who = "", page = "") {
  lastCall = () => setRxTab(who, page);
  asked = "";
  const s = tabSpecOf("rxWrite");
  setTabTitle(page || fillTabTitle(s.title, { patient: who }, who || "Prescription"));
  try { show(tabIconKey(s), tabIconUrl(s)); }
  catch (err) { shown = ""; console.warn("Prescription tab icon not set:", err); }
}
// #/form-record/<id>: the saved record's tab
export async function labelFormRecordTab(id) {
  const hash = location.hash;
  try {
    const snap = await getDoc(doc(db, "form_submissions", id));
    if (location.hash !== hash || !snap.exists()) return;   // moved on, or not found
    const s = snap.data();
    setFormTab(s.category, s.templateName, s.patientName);
  } catch (err) {
    console.warn("Record tab not labelled:", err);
  }
}