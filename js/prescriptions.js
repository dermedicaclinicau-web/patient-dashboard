// Prescriptions: typed onto the clinic's pre-printed script paper. Only the typed text is printed;
// the paper already has the boxes, lines and clinic details.
// Routes: #/prescriptions/new[/<patientId>]  write one (patient chosen, or found by search)
//         #/prescriptions/layout             set up where each detail prints (paper, margins, positions)
// The layout is shared by the clinic (Firestore rx_settings/layout; the blank-form picture in rx_settings/background).
// Each computer keeps its own small nudge (localStorage), because printers feed paper slightly differently.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { getPatient } from "./patients.js";
import { escapeHtml as esc, showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";
import { can } from "./perms.js";
import { rxProductList, addRxProducts } from "./rx-products.js";

const PX = 96 / 25.4;                       // screen px per mm
const PAPERS = { A4: [210, 297], A5: [148, 210], Letter: [216, 279] };
const FONTS = ["Arial", "Helvetica", "Verdana", "Courier New", "Times New Roman"];
const NUDGE_KEY = "dm.rx.nudge";
const TESTED_KEY = "dm.rx.tested";
const MEDS_KEY = "dm.rx.meds";
const BGSHOW_KEY = "dm.rx.showbg";
const MAX_ITEMS = 4;

// Everything that can print. x / y: mm from the paper's left / top edge to the box's top-left corner.
const FIELDS = [
  { key: "medicare", label: "Medicare number", type: "boxes", count: 10,
    def: { x: 24, y: 38, pitch: 5.6, groups: "4,5,1", gap: 2.4, size: 12 } },
  { key: "ref", label: "Medicare Ref no.", type: "boxes", count: 1, def: { x: 92, y: 38, pitch: 5.6, size: 12 } },
  { key: "name", label: "Patient's full name", type: "text", def: { x: 24, y: 50, w: 125, size: 12 } },
  { key: "address1", label: "Address, line 1", type: "text", def: { x: 24, y: 58, w: 125 } },
  { key: "address2", label: "Address, line 2", type: "text", def: { x: 24, y: 65, w: 95 } },
  { key: "postcode", label: "Postcode", type: "boxes", count: 4, def: { x: 124, y: 65, pitch: 5.6 } },
  { key: "entitlement", label: "Entitlement no.", type: "text", def: { x: 24, y: 73, w: 60 } },
  { key: "safetyNet", label: "PBS Safety Net", type: "tick", def: { x: 112, y: 73, box: 4.5 } },
  { key: "concession", label: "Concessional / dependant", type: "tick", def: { x: 140, y: 73, box: 4.5 } },
  { key: "pbs", label: "PBS", type: "tick", def: { x: 24, y: 82, box: 4.5 } },
  { key: "rpbs", label: "RPBS", type: "tick", def: { x: 44, y: 82, box: 4.5 } },
  { key: "brand", label: "Brand substitution not permitted", type: "tick", def: { x: 70, y: 82, box: 4.5 } },
  { key: "items", label: "Medicines", type: "area", def: { x: 24, y: 92, w: 160, h: 70 } },
  { key: "date", label: "Date", type: "text", def: { x: 150, y: 180, w: 35 } },
];
const DEF = Object.fromEntries(FIELDS.map((d) => [d.key, d]));
const TICKS = FIELDS.filter((d) => d.type === "tick");

const SAMPLE = {
  medicare: "2123456701", ref: "1", name: "Jane Citizen", address1: "12 Example Street", address2: "Scarborough WA",
  postcode: "6019", entitlement: "E12345678", safetyNet: true, concession: true, pbs: true, rpbs: true, brand: true,
  items: "Soolantra 1% cream 30 g\nApply a thin layer at night\nQty: 1    Repeats: 2", date: "01/10/26",
};

/* ===================== Small helpers ===================== */

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const r05 = (n) => Math.round(n * 2) / 2;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const lineH = (pt) => pt * 0.3528 * 1.25;
const fontCss = (f) => `"${String(f || "Arial").replace(/"/g, "")}", Arial, sans-serif`;
const mm = (n) => `${Math.round(num(n) * 10) / 10}`;
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fmtDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : ""; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const getNudge = () => { const n = store.get(NUDGE_KEY, {}); return { x: num(n.x), y: num(n.y) }; };

function defaultLayout() {
  const fields = {};
  FIELDS.forEach((d) => { fields[d.key] = { on: true, size: 11, align: "left", bold: false, ...d.def }; });
  return { paper: { preset: "A4", w: 210, h: 297 }, offset: { x: 0, y: 0 }, font: "Arial",
    bg: { x: 0, y: 0, w: 210, opacity: 0.5 }, fields };
}
function mergeLayout(s) {
  const d = defaultLayout();
  if (!s || typeof s !== "object") return d;
  const out = { ...d, font: s.font || d.font, paper: { ...d.paper, ...(s.paper || {}) },
    offset: { ...d.offset, ...(s.offset || {}) }, bg: { ...d.bg, ...(s.bg || {}) }, fields: {} };
  FIELDS.forEach((f) => { out.fields[f.key] = { ...d.fields[f.key], ...((s.fields || {})[f.key] || {}) }; });
  return out;
}

let layoutMemo = null;
let bgMemo;   // undefined = not read yet, null = none
async function loadLayout(fresh) {
  if (layoutMemo && !fresh) return layoutMemo;
  const snap = await getDoc(doc(db, "rx_settings", "layout"));
  layoutMemo = { L: mergeLayout(snap.exists() ? snap.data() : null), saved: snap.exists(),
    by: snap.exists() ? String(snap.data().updatedBy || "") : "", at: snap.exists() ? String(snap.data().updatedAt || "") : "" };
  return layoutMemo;
}
async function loadBg(fresh) {
  if (bgMemo !== undefined && !fresh) return bgMemo;
  try {
    const snap = await getDoc(doc(db, "rx_settings", "background"));
    bgMemo = snap.exists() && snap.data().data ? snap.data() : null;
  } catch (err) { console.warn("Script paper picture not read:", err); bgMemo = null; }
  return bgMemo;
}

/* ===================== Drawing a field (the same for the preview, the editor and the print) ===================== */

function boxXs(d, f) {
  const ends = [];
  let s = 0;
  String(f.groups || "").split(/[^\d]+/).map(Number).filter((n) => n > 0).forEach((g) => { s += g; ends.push(s); });
  const xs = [];
  let extra = 0;
  for (let i = 0; i < d.count; i++) {
    if (i && ends.includes(i)) extra += num(f.gap);
    xs.push(i * num(f.pitch, 5) + extra);
  }
  return xs;
}
function geom(d, f) {
  const size = num(f.size, 11);
  if (d.type === "tick") { const b = num(f.box, 4.5); return { w: b, h: b, size }; }
  if (d.type === "boxes") { const xs = boxXs(d, f); return { w: xs[xs.length - 1] + num(f.pitch, 5), h: lineH(size), size, xs }; }
  if (d.type === "area") return { w: num(f.w, 100), h: num(f.h, 40), size };
  return { w: num(f.w, 60), h: lineH(size), size };
}
function fieldInner(d, f, g, val) {
  if (d.type === "tick") {
    return val ? '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-weight:700;line-height:1">X</div>' : "";
  }
  if (d.type === "boxes") {
    return String(val || "").replace(/\s+/g, "").slice(0, d.count).split("").map((c, i) =>
      `<span style="position:absolute;left:${g.xs[i]}mm;top:0;width:${num(f.pitch, 5)}mm;text-align:center;line-height:${g.h}mm">${esc(c)}</span>`).join("");
  }
  if (d.type === "area") return `<div class="rx-area-in" style="white-space:pre-wrap;line-height:1.3">${esc(val || "")}</div>`;
  return `<span class="rx-line-in" style="display:block;white-space:nowrap;line-height:${g.h}mm;text-align:${f.align || "left"}">${esc(val || "")}</span>`;
}
function fieldStyle(d, f, L, dx = 0, dy = 0) {
  const g = geom(d, f);
  return `position:absolute;left:${num(f.x) + num(L.offset.x) + dx}mm;top:${num(f.y) + num(L.offset.y) + dy}mm;` +
    `width:${g.w}mm;height:${g.h}mm;font-size:${g.size}pt;${f.bold ? "font-weight:700;" : ""}`;
}
const empty = (v) => v === undefined || v === null || v === "" || v === false;

// The text of the sheet. o: { dx, dy, outlines, labels }
function sheetHtml(L, vals, o = {}) {
  return FIELDS.map((d) => {
    const f = L.fields[d.key];
    if (!f || !f.on) return "";
    const v = vals[d.key];
    if (!o.outlines && empty(v)) return "";
    const g = geom(d, f);
    const label = o.labels ? `<div style="position:absolute;left:${num(f.x) + num(L.offset.x) + num(o.dx)}mm;` +
      `top:${num(f.y) + num(L.offset.y) + num(o.dy) - 2.6}mm;font-size:5.5pt;color:#6b7280;white-space:nowrap">${esc(d.label)}</div>` : "";
    return `${label}<div data-key="${d.key}" style="${fieldStyle(d, f, L, num(o.dx), num(o.dy))}overflow:hidden;` +
      `${o.outlines ? "outline:0.2mm dashed #9ca3af;" : ""}">${fieldInner(d, f, g, v)}</div>`;
  }).join("");
}

function gridHtml(L) {
  const { w, h } = L.paper;
  let s = "";
  for (let x = 10; x < w; x += 10) {
    s += `<div style="position:absolute;left:${x}mm;top:0;bottom:0;border-left:0.15mm solid ${x % 50 ? "#eef0f3" : "#d1d5db"}"></div>` +
      `<div style="position:absolute;left:${x + 0.6}mm;top:1mm;font-size:5.5pt;color:#9ca3af">${x}</div>`;
  }
  for (let y = 10; y < h; y += 10) {
    s += `<div style="position:absolute;top:${y}mm;left:0;right:0;border-top:0.15mm solid ${y % 50 ? "#eef0f3" : "#d1d5db"}"></div>` +
      `<div style="position:absolute;top:${y + 0.4}mm;left:1mm;font-size:5.5pt;color:#9ca3af">${y}</div>`;
  }
  return s;
}

function printSheet(L, inner, title) {
  const { w, h } = L.paper;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const d = frame.contentDocument;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title || "Prescription")}</title><style>` +
    `@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0;padding:0;background:#fff}` +
    `body{position:relative;width:${w}mm;height:${h}mm;overflow:hidden;font-family:${fontCss(L.font)};color:#000;` +
    `-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>${inner}</body></html>`);
  d.close();
  const win = frame.contentWindow;
  win.addEventListener("afterprint", () => setTimeout(() => frame.remove(), 500));
  setTimeout(() => { win.focus(); win.print(); }, 250);
  setTimeout(() => { if (frame.isConnected) frame.remove(); }, 120000);
}

function printTest(L) {
  const n = getNudge();
  printSheet(L, gridHtml(L) + sheetHtml(L, SAMPLE, { dx: n.x, dy: n.y, outlines: true, labels: true }), "Script paper test page");
  store.set(TESTED_KEY, true);
}

/* ===================== This computer's nudge (shared by both screens) ===================== */

function nudgeText() {
  const n = getNudge();
  const p = [];
  if (n.x) p.push(`${n.x > 0 ? "Right" : "Left"} ${Math.abs(n.x).toFixed(1)} mm`);
  if (n.y) p.push(`${n.y > 0 ? "Down" : "Up"} ${Math.abs(n.y).toFixed(1)} mm`);
  return p.length ? p.join(" · ") : "Not moved";
}
function nudgeHtml() {
  const b = (v, label, txt) => `<button type="button" class="rx-nb" data-nudge="${v}" aria-label="${label}" title="${label}">${txt}</button>`;
  return `<div class="rx-nudge-wrap">
    <div class="rx-nudge">
      <span></span>${b("0,-0.5", "Move up 0.5 mm", "↑")}<span></span>
      ${b("-0.5,0", "Move left 0.5 mm", "←")}${b("reset", "Back to no adjustment", "⟲")}${b("0.5,0", "Move right 0.5 mm", "→")}
      <span></span>${b("0,0.5", "Move down 0.5 mm", "↓")}<span></span>
    </div>
    <div class="rx-nudge-txt"><strong>This computer only</strong>
      <span class="rx-nudge-read" data-role="nudge-read">${esc(nudgeText())}</span>
      <small>If everything prints a little off on this computer, move it here. Each press is 0.5 mm.</small></div>
  </div>`;
}
function handleNudge(btn, root) {
  const v = btn.dataset.nudge;
  if (v === "reset") store.set(NUDGE_KEY, { x: 0, y: 0 });
  else {
    const [dx, dy] = v.split(",").map(Number);
    const n = getNudge();
    store.set(NUDGE_KEY, { x: clamp(r05(n.x + dx), -20, 20), y: clamp(r05(n.y + dy), -20, 20) });
  }
  root.querySelectorAll('[data-role="nudge-read"]').forEach((el) => { el.textContent = nudgeText(); });
}

/* ===================== Entry ===================== */

export async function mountPrescriptions(container, { param = "", staff = null } = {}) {
  injectStyles();
  if (!can("rx.write")) {
    container.innerHTML = `<section class="page"><div class="state"><strong>No access</strong>Ask an Admin to tick "Write prescriptions" for you.</div></section>`;
    return;
  }
  const parts = String(param || "").split("/").filter(Boolean);
  if (parts[0] === "layout") return mountLayout(container, { staff });
  if (parts[0] === "view" && parts[1]) return mountWriter(container, { recordId: parts[1], staff });
  return mountWriter(container, { patientId: parts[0] === "new" ? (parts[1] || "") : "", staff });
}

/* ===================== Write a prescription ===================== */
// Each prescription is saved to the patient's Product Prescriptions: the same records as scanned scripts
// (scans/{id}, kind "rx", source "written"), saved through Apps Script (Rx.gs). Printing saves it first;
// printing again without changes doesn't save a second copy, and changes update the same record.
// The medicines come from the clinic's prescription product list (the same list the Scanner uses).

const TYPE_IT = "__type";   // "Not on the list: type the name"
const SHEET_KEYS = ["name", "address1", "address2", "postcode", "medicare", "ref", "entitlement",
  "safetyNet", "concession", "pbs", "rpbs", "brand"];
const LAST_KEY = "dm.rx.last";   // per product: what was written last time on this computer
const DIRS_KEY = "dm.rx.dirs";   // directions used recently on this computer
const DIR_PICKS = ["Apply a thin layer once daily", "Apply a thin layer at night", "Apply twice daily", "Use as directed"];
const FIELD_LABELS = { medicare: "Medicare number", ref: "Ref no.", name: "Patient's name", address1: "Address",
  address2: "Suburb and state", postcode: "Postcode", entitlement: "Entitlement no.", items: "Medicines", date: "Date" };
const blankItem = (custom = false) => ({ product: "", custom, customName: "", addList: true,
  strength: "", directions: "", qty: "", repeats: "0", filled: false });
const itemName = (i) => String(i.custom ? i.customName : i.product).trim();
const itemLine = (i) => [itemName(i), String(i.strength || "").trim()].filter(Boolean).join(" ");
function itemsText(items) {
  return items.filter((i) => itemName(i)).map((i) => [
    itemLine(i), String(i.directions || "").trim(),
    [String(i.qty || "").trim() && `Qty: ${String(i.qty).trim()}`,
      String(i.repeats ?? "").trim() !== "" && `Repeats: ${String(i.repeats).trim()}`].filter(Boolean).join("    "),
  ].filter(Boolean).join("\n")).join("\n\n");
}
function splitAddress(a) {
  let s = String(a || "").replace(/\s+/g, " ").trim();
  const pc = (/\b(\d{4})\s*$/.exec(s) || [])[1] || "";
  if (pc) s = s.replace(/[,\s]*\b\d{4}\s*$/, "").trim();
  const i = s.lastIndexOf(",");
  return { line1: i > 0 ? s.slice(0, i).trim() : s, line2: i > 0 ? s.slice(i + 1).trim() : "", postcode: pc };
}
const cleanName = (n) => String(n || "").replace(/\s*#\d+\s*$/, "").trim();
const initials = (n) => cleanName(n).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const fmtLong = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); };
const nv = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const wsvg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  search: wsvg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  gear: wsvg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  info: wsvg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  check: wsvg('<polyline points="20 6 9 17 4 12"/>'),
  trash: wsvg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  print: wsvg('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  clock: wsvg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
};

// The prescription product list (rx-products.js may still be loading it when the page opens)
async function loadRxNames() {
  for (let i = 0; i < 8; i++) {
    try {
      let list = rxProductList();
      if (list && typeof list.then === "function") list = await list;
      if (Array.isArray(list) && list.length) {
        return [...new Set(list.map((x) => String(x && x.name ? x.name : x).trim()).filter(Boolean))];
      }
    } catch (err) { console.warn("Prescription product list:", err); }
    await new Promise((r) => setTimeout(r, 400));
  }
  return [];
}

function injectWriterStyles() {
  if (document.getElementById("rxw-styles")) return;
  const s = document.createElement("style");
  s.id = "rxw-styles";
  s.textContent = `
.rxw{--t:#0f766e;--t2:#14b8a6;--tl:#f0fdfa;--ink:#0f172a;--mut:#64748b;--line:#e2e8f0}
.rxw svg{width:16px;height:16px;flex:none}
.rxw .rxw-wrap{max-width:1320px;margin:0 auto;padding:4px 4px 48px}
.rxw-back{display:inline-flex;gap:6px;color:var(--mut);font-size:13px;text-decoration:none;margin-bottom:12px}
.rxw-back:hover{color:var(--t)}
.rxw-head{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.rxw-logo{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;flex:none;background:linear-gradient(135deg,var(--t2),var(--t));color:#fff;font:700 22px/1 Georgia,serif;box-shadow:0 6px 16px rgba(15,118,110,.25)}
.rxw-head-main{flex:1;min-width:0}
.rxw-head h2{margin:0;font-size:22px;color:var(--ink)}
.rxw-head p{margin:2px 0 0;color:var(--mut);font-size:13.5px}
.rxw-ghost{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap}
.rxw-ghost:hover{border-color:var(--t2);color:var(--t)}
.rxw-steps{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0 0 16px;padding:0}
.rxw-steps button{display:inline-flex;align-items:center;gap:8px;padding:5px 14px 5px 5px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--mut);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:.15s}
.rxw-steps button span{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:#f1f5f9;font-size:12px}
.rxw-steps .is-on button{border-color:var(--t2);color:var(--t);box-shadow:0 0 0 3px rgba(20,184,166,.12)}
.rxw-steps .is-on button span{background:var(--t);color:#fff}
.rxw-steps .is-done button{color:var(--t);background:var(--tl);border-color:#99f6e4}
.rxw-steps .is-done button span{background:var(--t2);color:#fff}
.rxw-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:13.5px;margin-bottom:16px}
.rxw-banner a{margin-left:auto;font-weight:700;color:#92400e;white-space:nowrap}
.rxw-grid{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:20px;align-items:start}
.rxw-main{display:grid;gap:16px;min-width:0}
.rxw-card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 20px;box-shadow:0 1px 2px rgba(15,23,42,.04);scroll-margin-top:12px}
.rxw-card-h{display:flex;gap:12px;align-items:flex-start;margin-bottom:14px}
.rxw-card-h h3{margin:0;font-size:16px;color:var(--ink)}
.rxw-card-h p{margin:2px 0 0;font-size:12.5px;color:var(--mut)}
.rxw-n{width:28px;height:28px;border-radius:9px;background:var(--tl);color:var(--t);font-weight:700;font-size:13px;display:grid;place-items:center;flex:none}
.rxw-fields{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.rxw-fields>.c1{grid-column:span 1}.rxw-fields>.c2{grid-column:span 2}.rxw-fields>.c3{grid-column:span 3}
.rxw-fields>.c4{grid-column:span 4}.rxw-fields>.c6{grid-column:span 6}
.rxw-f{display:flex;flex-direction:column;gap:5px;min-width:0}
.rxw-f>span{font-size:12px;font-weight:600;color:#475569}
.rxw-f input,.rxw-sel select,.rxw-in{width:100%;box-sizing:border-box;height:40px;padding:0 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;font-family:inherit;font-size:14px;color:var(--ink);transition:border-color .15s,box-shadow .15s}
.rxw-f input:focus,.rxw-sel select:focus,.rxw-in:focus{outline:none;border-color:var(--t2);box-shadow:0 0 0 3px rgba(20,184,166,.15)}
.rxw-f input::placeholder,.rxw-in::placeholder{color:#94a3b8}
.rxw-fh{font-size:12px;color:var(--mut);min-height:15px}
.rxw-fh.is-ok{color:var(--t);font-weight:600}.rxw-fh.is-warn{color:#b45309}
.rxw-group+.rxw-group{margin-top:16px;padding-top:16px;border-top:1px dashed var(--line)}
.rxw-group-h{font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;margin-bottom:10px}
.rxw-soft{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#f8fafc;color:var(--mut);font-size:13px}
.rxw-ticks{display:flex;flex-wrap:wrap;gap:8px}
.rxw-tick{position:relative;display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:#334155;font-size:13.5px;cursor:pointer;user-select:none;transition:.15s}
.rxw-tick input{position:absolute;opacity:0;pointer-events:none}
.rxw-tick-box{width:18px;height:18px;border-radius:5px;border:1.5px solid #cbd5e1;display:grid;place-items:center;color:transparent}
.rxw-tick-box svg{width:12px;height:12px}
.rxw-tick:hover{border-color:#99f6e4}
.rxw-tick.is-on{border-color:var(--t2);background:var(--tl);color:var(--t)}
.rxw-tick.is-on .rxw-tick-box{background:var(--t);border-color:var(--t);color:#fff}
.rxw-tick:focus-within{box-shadow:0 0 0 3px rgba(20,184,166,.2)}
.rxw-search{display:flex;align-items:center;gap:10px;height:50px;padding:0 14px;border:1.5px solid #cbd5e1;border-radius:12px;background:#fff;transition:.15s}
.rxw-search:focus-within{border-color:var(--t2);box-shadow:0 0 0 3px rgba(20,184,166,.15)}
.rxw-search svg{width:18px;height:18px;color:#94a3b8}
.rxw-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;font-family:inherit;font-size:15px}
.rxw-results{display:grid;gap:6px;margin-top:10px;max-height:340px;overflow:auto}
.rxw-res{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#fff;text-align:left;font-family:inherit;cursor:pointer;transition:.12s}
.rxw-res:hover,.rxw-res:focus-visible{border-color:var(--t2);background:var(--tl);outline:none}
.rxw-res-main{flex:1;min-width:0;display:flex;flex-direction:column}
.rxw-res strong{color:var(--ink);font-size:14px}
.rxw-res small{color:var(--mut);font-size:12px}
.rxw-av{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none;background:linear-gradient(135deg,#ccfbf1,#99f6e4);color:var(--t);font-weight:700}
.rxw-av.sm{width:32px;height:32px;font-size:12px}
.rxw-pt{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:var(--tl);border:1px solid #99f6e4}
.rxw-pt-main{flex:1;min-width:0;display:flex;flex-direction:column}
.rxw-pt strong{font-size:15px;color:var(--ink)}
.rxw-pt small{font-size:12.5px;color:var(--mut)}
.rxw-link{font-size:13px;font-weight:600;color:var(--t);text-decoration:none;white-space:nowrap}
.rxw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}
.rxw-btn:hover{border-color:var(--t2);color:var(--t)}
.rxw-btn.sm{height:32px;padding:0 12px}
.rxw-loading{display:flex;align-items:center;gap:10px;padding:12px 0;color:var(--mut);font-size:13.5px}
.rxw-spin{width:16px;height:16px;border:2px solid #ccfbf1;border-top-color:var(--t);border-radius:50%;animation:rxwspin .8s linear infinite}
@keyframes rxwspin{to{transform:rotate(360deg)}}
.rxw-med{border:1px solid var(--line);border-radius:14px;padding:14px;background:linear-gradient(#fff,#fbfdfd)}
.rxw-med+.rxw-med{margin-top:12px}
.rxw-med-h{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.rxw-med-n{width:26px;height:26px;border-radius:50%;background:var(--t);color:#fff;font-size:12px;font-weight:700;display:grid;place-items:center;flex:none}
.rxw-sel{flex:1;min-width:0}
.rxw-sel select{height:44px;font-size:15px;font-weight:600;cursor:pointer}
.rxw-med-h .rxw-in{flex:1;height:44px;font-size:15px;font-weight:600}
.rxw-x{width:36px;height:36px;border-radius:10px;border:0;background:transparent;color:#94a3b8;display:grid;place-items:center;cursor:pointer;flex:none}
.rxw-x:hover{background:#fef2f2;color:#dc2626}
.rxw-med .rxw-fields+.rxw-fields{margin-top:12px}
.rxw-med>.rxw-fields:first-of-type{margin-bottom:12px}
.rxw-filled{display:flex;align-items:center;gap:6px;margin:0 0 12px;padding:7px 10px;border-radius:8px;background:#f0f9ff;color:#0369a1;font-size:12.5px}
.rxw-step{display:flex;height:40px;border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;background:#fff}
.rxw-step:focus-within{border-color:var(--t2);box-shadow:0 0 0 3px rgba(20,184,166,.15)}
.rxw-step button{width:38px;flex:none;border:0;background:#f8fafc;color:var(--t);font-size:18px;cursor:pointer}
.rxw-step button:hover{background:var(--tl)}
.rxw .rxw-step input{flex:1;min-width:0;height:100%;border:0;border-radius:0;padding:0;text-align:center;box-shadow:none}
.rxw-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.rxw-chip{max-width:100%;padding:5px 10px;border-radius:999px;border:1px dashed #cbd5e1;background:#fff;color:#475569;font-family:inherit;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.rxw-chip:hover{border-style:solid;border-color:var(--t2);background:var(--tl);color:var(--t)}
.rxw-add{width:100%;height:46px;margin-top:12px;border:1.5px dashed #99f6e4;border-radius:12px;background:var(--tl);color:var(--t);font-family:inherit;font-size:14px;font-weight:700;cursor:pointer}
.rxw-add:hover{border-color:var(--t2)}
.rxw-switch{position:relative;display:flex;align-items:center;gap:10px;font-size:13px;color:#334155;cursor:pointer}
.rxw-switch input{position:absolute;opacity:0;pointer-events:none}
.rxw-sw{position:relative;width:34px;height:20px;border-radius:999px;background:#cbd5e1;flex:none;transition:.15s}
.rxw-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:.15s}
.rxw-switch input:checked+.rxw-sw{background:var(--t2)}
.rxw-switch input:checked+.rxw-sw::after{left:16px}
.rxw-switch input:focus-visible+.rxw-sw{box-shadow:0 0 0 3px rgba(20,184,166,.25)}
.rxw-aside{position:sticky;top:12px;display:grid;gap:16px;max-height:calc(100vh - 24px);overflow:auto;scrollbar-width:thin}
.rxw-pv-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.rxw-pv-h h3{margin:0;font-size:16px;color:var(--ink)}
.rxw-pv{padding:12px;border-radius:12px;background:#e8edf3}
.rxw-hold{position:relative;overflow:hidden;background:#fff;border-radius:2px;box-shadow:0 1px 2px rgba(15,23,42,.08),0 8px 24px rgba(15,23,42,.12)}
.rxw .rxw-hold>.rx-paper{position:absolute;left:0;top:0;margin:0;transform-origin:0 0;box-shadow:none}
.rxw .rxw-empty{background:rgba(20,184,166,.10);outline:1px dashed rgba(15,118,110,.4);outline-offset:-1px}
.rxw .rxw-focus{background:rgba(245,158,11,.22)!important;outline:1.5px solid #f59e0b!important;outline-offset:-1px}
.rxw-legend{display:flex;align-items:center;gap:6px;margin:8px 0 0;font-size:12px;color:var(--mut)}
.rxw-legend i{width:12px;height:12px;border-radius:3px;background:rgba(20,184,166,.15);border:1px dashed rgba(15,118,110,.5)}
.rxw-legend i.is-f{background:rgba(245,158,11,.25);border:1px solid #f59e0b;margin-left:8px}
.rxw-warn{margin-top:10px;padding:10px 12px;border-radius:10px;background:#fef2f2;color:#991b1b;font-size:13px}
.rxw-sum{display:grid;gap:8px;margin:14px 0;padding:12px;border-radius:12px;background:#f8fafc}
.rxw-sum-row{display:flex;gap:12px;font-size:13px}
.rxw-sum-row>span{width:78px;flex:none;color:var(--mut)}
.rxw-sum-row strong{min-width:0;color:var(--ink);font-weight:600;overflow-wrap:anywhere}
.rxw-sum-row em{color:#94a3b8;font-style:normal;font-weight:500}
.rxw-pill{display:inline-flex;align-items:center;gap:6px;margin-bottom:10px;padding:6px 10px;border-radius:999px;background:#fff7ed;color:#9a3412;font-size:12.5px;font-weight:600}
.rxw-pill.is-ok{background:#ecfdf5;color:#047857}
.rxw-print{width:100%;height:52px;display:flex;align-items:center;justify-content:center;gap:10px;border:0;border-radius:14px;background:linear-gradient(135deg,var(--t2),var(--t));color:#fff;font-family:inherit;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 8px 20px rgba(15,118,110,.28);transition:transform .1s,box-shadow .15s}
.rxw-print:hover{box-shadow:0 10px 26px rgba(15,118,110,.38)}
.rxw-print:active{transform:translateY(1px)}
.rxw-print:disabled{opacity:.7;cursor:progress}
.rxw-print svg{width:20px;height:20px}
.rxw-hint{margin:10px 0 0;font-size:12px;line-height:1.5;color:var(--mut)}
.rxw-hint kbd{padding:1px 5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;background:#fff;font-size:11px}
.rxw-tip{display:flex;gap:10px;margin-top:12px;padding:12px;border-radius:12px;background:#f0f9ff;color:#075985;font-size:13px;line-height:1.45}
.rxw-tip svg{margin-top:2px}
.rxw-link-btn{display:block;margin-top:6px;padding:0;border:0;background:none;color:#0369a1;font-family:inherit;font-size:13px;font-weight:700;text-decoration:underline;cursor:pointer}
.rxw-more{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.rxw-more summary{display:flex;align-items:center;gap:6px;list-style:none;cursor:pointer;font-size:13px;font-weight:600;color:#475569}
.rxw-more summary::-webkit-details-marker{display:none}
.rxw-more summary::before{content:"▸";transition:transform .15s}
.rxw-more[open] summary::before{transform:rotate(90deg)}
.rxw-more-in{display:grid;gap:12px;margin-top:12px}
.rxw-date input{height:44px;font-weight:600}
@media (max-width:1100px){.rxw-grid{grid-template-columns:1fr}.rxw-aside{position:static;max-height:none;overflow:visible}}
@media (max-width:640px){.rxw-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.rxw-fields>*{grid-column:span 2!important}
  .rxw-head{flex-wrap:wrap}.rxw-ghost span{display:none}.rxw input,.rxw select{font-size:16px!important}.rxw-card{padding:16px}}`;
  document.head.appendChild(s);
}

async function mountWriter(container, { patientId = "", recordId = "", staff }) {
  injectWriterStyles();
  const root = document.createElement("section");
  root.className = "page wide rx rxw";
  root.innerHTML = '<div class="rxw-wrap"><div class="skeleton sm"></div></div>';
  container.replaceChildren(root);

  let info, bg, products, rec = null;
  try {
    [info, bg, products] = await Promise.all([loadLayout(true), loadBg(), loadRxNames()]);
    if (recordId) {
      const res = await callApi({ action: "rx", op: "get", id: recordId });
      if (res.problem) throw Object.assign(new Error(res.problem), { friendly: true });
      rec = res.record;
    }
  } catch (err) {
    console.error("Prescription page failed:", err);
    if (root.isConnected) root.innerHTML = `<div class="state error"><strong>Couldn't open the prescription</strong>${esc(
      err && err.friendly ? err.message
        : err && err.code === "permission-denied" ? "The Firestore rules don't allow it yet. Ask an Admin."
        : "Check your connection and try again.")}</div>`;
    return;
  }
  if (!root.isConnected) return;
  const L = info.L;
  const st = {
    patient: null, loadingPt: !!(patientId && !rec),
    v: { name: "", address1: "", address2: "", postcode: "", medicare: "", ref: "", entitlement: "",
      safetyNet: false, concession: false, pbs: false, rpbs: false, brand: false },
    items: [blankItem(!products.length)],
    date: todayKey(),
    savedId: "", savedSig: "", okTyped: new Set(), busy: false, focusKey: "",
  };
  if (rec) {   // opened from Product Prescriptions: the saved prescription, ready to print again
    st.patient = { id: rec.patientId, name: rec.patientName, pttId: rec.patientPttId, dobKey: "" };
    SHEET_KEYS.forEach((k) => { if (rec.sheet && k in rec.sheet) st.v[k] = rec.sheet[k]; });
    if (!st.v.name) st.v.name = cleanName(rec.patientName);
    if (rec.items.length) {
      st.items = rec.items.map((it) => {
        const onList = products.includes(it.product);
        if (!onList) st.okTyped.add(it.product);
        return { ...blankItem(), product: onList ? it.product : "", custom: !onList, customName: onList ? "" : it.product,
          addList: false, strength: it.strengths || "", directions: it.directions || "", qty: it.quantity || "", repeats: it.repeats ?? "" };
      });
    }
    if (rec.recordDate) st.date = rec.recordDate;
    st.savedId = rec.id;
  }
  const on = (k) => !!(L.fields[k] && L.fields[k].on);
  const values = () => ({ ...st.v, items: itemsText(st.items), date: fmtDate(st.date) });
  const payload = () => ({
    patientId: st.patient ? st.patient.id : "", date: st.date,
    items: st.items.filter((i) => itemName(i)).map((i) => ({
      product: itemName(i), custom: !!i.custom, medicine: itemLine(i), strengths: String(i.strength || "").trim(),
      quantity: String(i.qty || "").trim(), directions: String(i.directions || "").trim(), repeats: String(i.repeats ?? "").trim(),
    })),
    sheet: Object.fromEntries(SHEET_KEYS.map((k) => [k, st.v[k]])),
  });
  const sig = () => JSON.stringify(payload());
  if (rec) st.savedSig = sig();
  const back = rec ? `#/patient/${encodeURIComponent(rec.patientId)}`
    : patientId ? `#/patient/${encodeURIComponent(patientId)}` : "#/tasks/new";
  const showBg = () => !!bg && store.get(BGSHOW_KEY, true);

  root.innerHTML = `<div class="rxw-wrap">
    <a class="rxw-back" href="${back}">← ${rec || patientId ? "Back to the patient" : "Back to Task Manager"}</a>
    <header class="rxw-head">
      <span class="rxw-logo" aria-hidden="true">℞</span>
      <div class="rxw-head-main"><h2>${rec ? "Prescription" : "New prescription"}</h2>
        <p>${rec ? `Saved ${esc(fmtLong(rec.at))}${rec.by ? ` by ${esc(rec.by)}` : ""}${rec.updatedBy ? ` · last changed by ${esc(rec.updatedBy)}` : ""}. Printing it again doesn't make a copy.`
          : "Typed onto the clinic's script paper, and saved to the patient's Product Prescriptions."}</p></div>
      <a class="rxw-ghost" href="#/prescriptions/layout">${IC.gear}<span>Set up the paper</span></a>
    </header>
    <ol class="rxw-steps" data-role="steps" aria-label="Progress"></ol>
    ${info.saved ? "" : `<div class="rxw-banner">${IC.info}<span><strong>The paper isn't set up yet.</strong> Things may print a little out of place until it is.</span>
      <a href="#/prescriptions/layout">Set it up</a></div>`}
    <div class="rxw-grid">
      <div class="rxw-main">
        <section class="rxw-card" data-step="patient">
          <div class="rxw-card-h"><span class="rxw-n">1</span><div><h3>Patient</h3><p>Who the prescription is for. It's saved to their Product Prescriptions.</p></div></div>
          <div data-role="pt"></div></section>
        <section class="rxw-card" data-step="details">
          <div class="rxw-card-h"><span class="rxw-n">2</span><div><h3>Details on the script</h3><p>Filled in from the patient's record. Change anything before printing.</p></div></div>
          <div data-role="details"></div></section>
        <section class="rxw-card" data-step="meds">
          <div class="rxw-card-h"><span class="rxw-n">3</span><div><h3>Medicines</h3><p>Up to ${MAX_ITEMS} on one script.</p></div></div>
          <div data-role="items"></div></section>
      </div>
      <aside class="rxw-aside" data-step="print">
        <section class="rxw-card">
          <div class="rxw-pv-h"><h3>Preview</h3>
            ${bg ? `<label class="rxw-switch"><input type="checkbox" data-role="showbg" ${showBg() ? "checked" : ""}><span class="rxw-sw"></span>Show the form</label>` : ""}</div>
          <div class="rxw-pv" data-role="pv"><div class="rxw-hold" data-role="hold">
            <div class="rx-paper" data-role="paper" style="width:${L.paper.w}mm;height:${L.paper.h}mm;font-family:${fontCss(L.font)}"></div></div></div>
          <p class="rxw-legend"><i></i>Still empty <i class="is-f"></i>The box you're typing in</p>
          <div data-role="warn"></div>
        </section>
        <section class="rxw-card">
          <div class="rxw-card-h"><span class="rxw-n">4</span><div><h3>Save and print</h3></div></div>
          <label class="rxw-f rxw-date"><span>Date on the script</span><input type="date" data-role="date" value="${esc(st.date)}" max="${todayKey()}"></label>
          <div class="rxw-sum" data-role="sum"></div>
          <div data-role="saved"></div>
          <button type="button" class="rxw-print" data-act="print" data-role="printbtn">${IC.print}<span>Save and print</span></button>
          <p class="rxw-hint"><kbd>Ctrl</kbd> + <kbd>P</kbd> also saves and prints. In the print window choose <strong>Actual size (100%)</strong>, not "Fit to page", and turn off headers and footers.</p>
          <div data-role="first"></div>
          <details class="rxw-more"><summary>Printing a little off on this computer?</summary>
            <div class="rxw-more-in">${nudgeHtml()}<button type="button" class="rxw-btn" data-act="test">Print a test page</button></div></details>
        </section>
      </aside>
    </div></div>`;

  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const pv = $("pv"), hold = $("hold"), paper = $("paper");

  /* ---- Progress ---- */
  function renderSteps() {
    const s = [
      ["patient", "Patient", !!st.patient],
      ["details", "Details", !!(st.v.name.trim() && (!on("address1") || st.v.address1.trim()))],
      ["meds", "Medicines", st.items.some((i) => itemName(i))],
      ["print", "Saved and printed", !!st.savedId && sig() === st.savedSig],
    ];
    const cur = s.findIndex((x) => !x[2]);
    $("steps").innerHTML = s.map(([k, label, done], i) => `<li class="${done ? "is-done" : i === cur ? "is-on" : ""}">
      <button type="button" data-goto="${k}"><span>${done ? "✓" : i + 1}</span>${label}</button></li>`).join("");
  }

  /* ---- Patient ---- */
  function renderPt() {
    const p = st.patient;
    if (st.loadingPt) { $("pt").innerHTML = '<div class="rxw-loading"><span class="rxw-spin"></span>Loading the patient…</div>'; return; }
    if (p) {
      const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.dobKey || "");
      $("pt").innerHTML = `<div class="rxw-pt"><span class="rxw-av">${esc(initials(p.name))}</span>
        <div class="rxw-pt-main"><strong>${esc(cleanName(p.name))}</strong>
          <small>${[p.pttId && `ID ${esc(p.pttId)}`, dob && `Born ${dob[3]}/${dob[2]}/${dob[1]}`].filter(Boolean).join(" · ") || "&nbsp;"}</small></div>
        <a class="rxw-link" href="#/patient/${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Patient page ↗</a>
        <button type="button" class="rxw-btn sm" data-act="change-pt">Change</button></div>`;
      return;
    }
    $("pt").innerHTML = `<div class="rxw-search">${IC.search}<input type="search" data-role="search"
        placeholder="Search by name, mobile or date of birth" autocomplete="off" data-lpignore="true" data-1p-ignore aria-label="Search patients"></div>
      <div data-role="results"></div>`;
    if (window.matchMedia("(pointer: fine)").matches) $("search").focus();
  }
  function fillFrom(p) {
    const a = splitAddress(p.address);
    st.patient = p;
    st.loadingPt = false;
    Object.assign(st.v, { name: cleanName(p.name), address1: a.line1, address2: a.line2, postcode: a.postcode,
      medicare: String(p.medicare || "").replace(/\D/g, "").slice(0, 10), ref: String(p.irn || "").replace(/\D/g, "").slice(0, 1) });
    renderPt(); renderDetails(); draw();
  }
  async function pick(id) {
    const box = $("results");
    if (box) box.innerHTML = '<div class="rxw-loading"><span class="rxw-spin"></span>Loading…</div>';
    try {
      const res = await callApi({ action: "rx", op: "patient", id });
      if (!root.isConnected) return;
      if (res.problem) { showToast(res.problem); st.loadingPt = false; if (!st.patient) renderPt(); return; }
      fillFrom(res.patient);
    } catch (err) {
      console.error("Patient not loaded:", err);
      showToast("Couldn't load the patient. Try again.");
      st.loadingPt = false;
      if (root.isConnected && !st.patient) renderPt();
    }
  }
  let searchT = 0, searchSeq = 0;
  async function search(q) {
    const box = $("results");
    if (!box) return;
    if (q.trim().length < 2) { box.innerHTML = ""; return; }
    const seq = ++searchSeq;
    box.innerHTML = '<div class="rxw-loading"><span class="rxw-spin"></span>Searching…</div>';
    try {
      const res = await callApi({ action: "rx", op: "search", q });
      if (seq !== searchSeq || !box.isConnected) return;
      const list = res.results || [];
      box.innerHTML = list.length ? `<div class="rxw-results">${list.map((r) => {
        const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.dob || "");
        return `<button type="button" class="rxw-res" data-pick="${esc(r.id)}"><span class="rxw-av sm">${esc(initials(r.name))}</span>
          <span class="rxw-res-main"><strong>${esc(cleanName(r.name))}</strong>${r.also && r.also.length ? `<small>also ${esc(r.also.join(", "))}</small>` : ""}</span>
          <small>${[dob && `${dob[3]}/${dob[2]}/${dob[1]}`, r.mobile].filter(Boolean).map(esc).join(" · ")}</small></button>`;
      }).join("")}</div>` : '<p class="rxw-soft" style="margin-top:10px">No patients found. Try part of the first or last name.</p>';
    } catch (err) {
      console.error("Patient search failed:", err);
      if (seq === searchSeq && box.isConnected) box.innerHTML = '<p class="rxw-soft" style="margin-top:10px">Search didn\'t work. Check your connection.</p>';
    }
  }

  /* ---- Details ---- */
  const noFill = 'autocomplete="off" data-lpignore="true" data-1p-ignore';
  function medHint() {
    const el = $("medhint");
    if (!el) return;
    const d = String(st.v.medicare || "").replace(/\D/g, "");
    el.className = `rxw-fh${d.length === 10 ? " is-ok" : d.length ? " is-warn" : ""}`;
    el.textContent = !d ? "" : d.length === 10 ? `✓ ${d.slice(0, 4)} ${d.slice(4, 9)} ${d.slice(9)}` : `${d.length} of 10 digits`;
  }
  function renderDetails() {
    const inp = (k, label, cls, attrs = "") => on(k)
      ? `<label class="rxw-f ${cls}"><span>${label}</span><input data-v="${k}" value="${esc(st.v[k])}" ${noFill} ${attrs}></label>` : "";
    const ticks = TICKS.filter((d) => on(d.key));
    const med = on("medicare") || on("ref") || on("entitlement");
    $("details").innerHTML = `
      ${st.patient ? "" : '<p class="rxw-soft">Choose the patient above and these fill in by themselves.</p>'}
      <div class="rxw-group"><div class="rxw-group-h">Name and address</div><div class="rxw-fields">
        ${inp("name", "Full name", "c6")}
        ${inp("address1", "Street address", "c6")}
        ${inp("address2", "Suburb and state", "c4")}
        ${inp("postcode", "Postcode", "c2", 'inputmode="numeric" maxlength="4"')}
      </div></div>
      ${med ? `<div class="rxw-group"><div class="rxw-group-h">Medicare</div><div class="rxw-fields">
        ${on("medicare") ? `<label class="rxw-f c3"><span>Medicare number</span><input data-v="medicare" value="${esc(st.v.medicare)}" ${noFill}
            inputmode="numeric" maxlength="14" placeholder="10 digits"><small data-role="medhint" class="rxw-fh"></small></label>` : ""}
        ${inp("ref", "Ref no.", "c1", 'inputmode="numeric" maxlength="1"')}
        ${inp("entitlement", "Entitlement no.", "c2")}
      </div></div>` : ""}
      ${ticks.length ? `<div class="rxw-group"><div class="rxw-group-h">Tick on the script</div><div class="rxw-ticks">${ticks.map((d) =>
        `<label class="rxw-tick${st.v[d.key] ? " is-on" : ""}"><input type="checkbox" data-v="${d.key}" ${st.v[d.key] ? "checked" : ""}>
          <span class="rxw-tick-box">${IC.check}</span>${esc(d.label)}</label>`).join("")}</div></div>` : ""}`;
    medHint();
  }

  /* ---- Medicines ---- */
  const recentDirs = () => readJson(DIRS_KEY, []).filter((x) => typeof x === "string");
  const dirPicks = () => [...new Set([...recentDirs(), ...DIR_PICKS])].slice(0, 4);
  function renderItems() {
    const prodSel = (it, i) => `<select data-item="${i}" data-f="product" aria-label="Product for medicine ${i + 1}">
        <option value="">Choose the product…</option>
        ${products.map((n) => `<option${!it.custom && n === it.product ? " selected" : ""}>${esc(n)}</option>`).join("")}
        <option disabled>──────────</option>
        <option value="${TYPE_IT}"${it.custom ? " selected" : ""}>Not on the list: type the name…</option></select>`;
    const picks = dirPicks();
    $("items").innerHTML = (products.length ? "" : '<div class="rxw-warn" style="margin:0 0 12px">The prescription product list didn\'t load, so type each name. Refresh to try again.</div>') +
      st.items.map((it, i) => `
      <div class="rxw-med" data-row="${i}">
        <div class="rxw-med-h"><span class="rxw-med-n">${i + 1}</span>
          ${products.length ? `<div class="rxw-sel">${prodSel(it, i)}</div>`
            : `<input class="rxw-in" data-item="${i}" data-f="customName" value="${esc(it.customName)}" maxlength="150" placeholder="Product name" ${noFill}>`}
          ${st.items.length > 1 ? `<button type="button" class="rxw-x" data-act="del-item" data-i="${i}" aria-label="Remove medicine ${i + 1}" title="Remove">${IC.trash}</button>` : ""}
        </div>
        ${it.custom && products.length ? `<div class="rxw-fields">
          <label class="rxw-f c6"><span>Product name</span><input data-item="${i}" data-f="customName" value="${esc(it.customName)}" maxlength="150" placeholder="e.g. Minomycin" ${noFill}></label>
          <label class="rxw-switch c6"><input type="checkbox" data-item="${i}" data-f="addList" ${it.addList ? "checked" : ""}><span class="rxw-sw"></span>Add it to the prescription product list for next time</label>
        </div>` : ""}
        ${it.filled ? `<p class="rxw-filled">${IC.clock}Filled in from the last time it was prescribed on this computer. Check it.</p>` : ""}
        <div class="rxw-fields">
          <label class="rxw-f c4"><span>Strength and form</span><input data-item="${i}" data-f="strength" value="${esc(it.strength)}" placeholder="e.g. 1% cream 30 g" ${noFill}></label>
          <label class="rxw-f c2"><span>Quantity</span><input data-item="${i}" data-f="qty" value="${esc(it.qty)}" placeholder="e.g. 1" ${noFill}></label>
        </div>
        <div class="rxw-fields">
          <label class="rxw-f c4"><span>Directions</span><input data-item="${i}" data-f="directions" value="${esc(it.directions)}" list="rxw-dirs" placeholder="e.g. Apply a thin layer at night" ${noFill}></label>
          <div class="rxw-f c2"><span>Repeats</span><div class="rxw-step">
            <button type="button" data-act="rep" data-i="${i}" data-d="-1" aria-label="One fewer repeat">−</button>
            <input data-item="${i}" data-f="repeats" value="${esc(it.repeats)}" inputmode="numeric" maxlength="2" aria-label="Repeats" ${noFill}>
            <button type="button" data-act="rep" data-i="${i}" data-d="1" aria-label="One more repeat">+</button></div></div>
        </div>
        <div class="rxw-chips">${picks.map((t) => `<button type="button" class="rxw-chip" data-act="dir" data-i="${i}" data-t="${esc(t)}" title="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      </div>`).join("") +
      (st.items.length < MAX_ITEMS ? '<button type="button" class="rxw-add" data-act="add-item">+ Add another medicine</button>' : "") +
      `<datalist id="rxw-dirs">${recentDirs().map((d) => `<option value="${esc(d)}">`).join("")}</datalist>`;
  }
  // Remembered on this computer after saving: what each product was written as, and recent directions
  function remember(named) {
    const last = readJson(LAST_KEY, {});
    named.forEach((i) => {
      const k = itemName(i);
      delete last[k];
      last[k] = { strength: i.strength, directions: i.directions, qty: i.qty, repeats: i.repeats };
    });
    const keys = Object.keys(last);
    keys.slice(0, Math.max(0, keys.length - 80)).forEach((k) => delete last[k]);
    writeJson(LAST_KEY, last);
    writeJson(DIRS_KEY, [...new Set(named.map((i) => String(i.directions || "").trim()).filter(Boolean).concat(recentDirs()))].slice(0, 30));
  }

  /* ---- Preview, summary, saved ---- */
  function fit() {
    if (!pv.isConnected) return;
    const w = pv.clientWidth - 24;
    if (w <= 0) return;
    const k = w / (L.paper.w * PX);
    paper.style.transform = `scale(${k})`;
    hold.style.width = `${w}px`;
    hold.style.height = `${L.paper.h * PX * k}px`;
  }
  function markFocus() {
    paper.querySelectorAll("[data-key]").forEach((el) => el.classList.toggle("rxw-focus", !!st.focusKey && el.dataset.key === st.focusKey));
  }
  function renderSum() {
    const named = st.items.filter((i) => itemName(i));
    $("sum").innerHTML = `
      <div class="rxw-sum-row"><span>Patient</span>${st.patient ? `<strong>${esc(cleanName(st.v.name || st.patient.name))}</strong>` : "<em>Not chosen yet</em>"}</div>
      <div class="rxw-sum-row"><span>Medicines</span>${named.length ? `<strong>${named.map((i) => esc(itemLine(i))).join("<br>")}</strong>` : "<em>None yet</em>"}</div>`;
  }
  function renderSaved() {
    const box = $("saved"), btn = $("printbtn");
    if (!box || !btn || st.busy) return;
    const label = btn.querySelector("span");
    if (!st.savedId) { box.innerHTML = ""; label.textContent = "Save and print"; }
    else if (sig() === st.savedSig) {
      box.innerHTML = `<span class="rxw-pill is-ok">${IC.check}Saved to Product Prescriptions</span>`;
      label.textContent = "Print again";
    } else {
      box.innerHTML = '<span class="rxw-pill">Changed since it was saved. Printing saves the changes.</span>';
      label.textContent = "Save changes and print";
    }
  }
  function draw() {
    const B = L.bg || {};
    paper.innerHTML = (showBg() ? `<img class="rx-bg" alt="" src="${bg.data}" style="left:${nv(B.x)}mm;top:${nv(B.y)}mm;width:${nv(B.w, L.paper.w)}mm;opacity:${nv(B.opacity, 0.5)}">` : "") +
      sheetHtml(L, values());
    const tight = [];
    paper.querySelectorAll("[data-key]").forEach((el) => {
      el.classList.toggle("rxw-empty", !el.textContent.trim());
      const inner = el.querySelector(".rx-area-in, .rx-line-in");
      if (!inner) return;
      const over = inner.classList.contains("rx-area-in") ? inner.offsetHeight > el.clientHeight + 1 : inner.scrollWidth > el.clientWidth + 1;
      if (over) tight.push(FIELD_LABELS[el.dataset.key] || "A box");
    });
    markFocus();
    $("warn").innerHTML = tight.length ? `<div class="rxw-warn">⚠ Too long to fit: <strong>${tight.map(esc).join(", ")}</strong>.
      Shorten it, or make the space bigger in <a href="#/prescriptions/layout">Set up the paper</a>.</div>` : "";
    $("first").innerHTML = store.get(TESTED_KEY, false) ? "" : `<div class="rxw-tip">${IC.info}<div><strong>First time printing on this computer?</strong>
      Print a test page on plain paper and hold it over a script against the light to check it lines up.
      <button type="button" class="rxw-link-btn" data-act="test">Print a test page</button></div></div>`;
    renderSum(); renderSaved(); renderSteps();
  }

  /* ---- Save, then print ---- */
  async function doPrint(btn) {
    if (st.busy || !btn) return;
    if (!st.patient) {
      showToast("Choose the patient first, so it's saved to their Product Prescriptions.");
      root.querySelector('[data-step="patient"]').scrollIntoView({ behavior: "smooth", block: "start" });
      $("search")?.focus();
      return;
    }
    if (!st.v.name.trim()) { showToast("Add the patient's name."); return; }
    const named = st.items.filter((i) => itemName(i));
    if (!named.length) { showToast("Choose at least one medicine."); return; }
    if (st.items.some((i) => !itemName(i) && (i.strength + i.directions + i.qty).trim())) {
      showToast("Choose the product for every medicine, or remove it.");
      return;
    }
    if (!st.date || st.date > todayKey()) { showToast("Choose the date (it can't be in the future)."); return; }

    if (sig() !== st.savedSig) {
      const typed = named.filter((i) => i.custom).map(itemName).filter((n) => !st.okTyped.has(n));
      if (typed.length) {
        const { confirmDialog: ask } = await import("./dialog.js");
        const ok = await ask({
          title: typed.length === 1 ? "Not on the product list" : `${typed.length} items not on the product list`,
          message: `${typed.map((n) => `“${n}”`).join(", ")} ${typed.length === 1 ? "isn't" : "aren't"} on the prescription product list. Check the spelling before it's saved to the patient.`,
          confirmLabel: "Save as typed", tone: "warning",
        });
        if (!ok) return;
        typed.forEach((n) => st.okTyped.add(n));
      }
      st.busy = true;
      btn.disabled = true;
      btn.querySelector("span").textContent = "Saving…";
      const sending = sig();
      try {
        const res = await callApi({ action: "rx", op: "save", id: st.savedId, ...payload() });
        if (res.problem) { showToast(res.problem); return; }
        const first = !st.savedId;
        st.savedId = res.id;
        st.savedSig = sending;
        remember(named);
        const add = named.filter((i) => i.custom && i.addList).map(itemName);
        if (add.length) {
          addRxProducts(add, staff).then((added) => {
            if (!added || !added.length || !root.isConnected) return;
            products.push(...added.filter((n) => !products.includes(n)));
            st.items.forEach((i) => { if (i.custom && products.includes(i.customName)) Object.assign(i, { custom: false, product: i.customName, customName: "" }); });
            st.savedSig = sig();
            renderItems(); draw();
          }).catch((err) => console.warn("Not added to the prescription list:", err));
        }
        showToast(first ? `Saved to ${cleanName(st.patient.name)}'s Product Prescriptions` : "Changes saved");
      } catch (err) {
        console.error("Prescription not saved:", err);
        showToast("Couldn't save it, so it wasn't printed. Check your connection and try again.");
        return;
      } finally {
        st.busy = false;
        btn.disabled = false;
        draw();
      }
      if (sig() !== st.savedSig) return;   // changed while saving: press Print again
    }
    const n = store.get("dm.rx.nudge", { x: 0, y: 0 }) || {};
    printSheet(L, sheetHtml(L, values(), { dx: nv(n.x), dy: nv(n.y) }), `Prescription ${st.v.name}`);
  }

  /* ---- Typing, taps and keys ---- */
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.role === "search") { clearTimeout(searchT); searchT = setTimeout(() => search(t.value), 300); return; }
    if (t.dataset.role === "date") { st.date = t.value; draw(); return; }
    if (t.dataset.v) {
      const k = t.dataset.v;
      if (t.type === "checkbox") { st.v[k] = t.checked; t.closest(".rxw-tick")?.classList.toggle("is-on", t.checked); }
      else st.v[k] = ["medicare", "postcode", "ref"].includes(k) ? t.value.replace(/\D/g, "") : t.value;
      if (k === "medicare") medHint();
      draw();
      return;
    }
    if (t.dataset.item !== undefined && t.dataset.f !== "product") {
      const it = st.items[Number(t.dataset.item)];
      if (!it) return;
      it[t.dataset.f] = t.type === "checkbox" ? t.checked : t.value;
      if (t.dataset.f === "repeats") it.repeats = t.value.replace(/\D/g, "");
      if (it.filled && t.dataset.f !== "addList") { it.filled = false; t.closest(".rxw-med")?.querySelector(".rxw-filled")?.remove(); }
      draw();
    }
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.role === "showbg") { store.set(BGSHOW_KEY, t.checked); draw(); return; }
    if (t.dataset.f === "product") {
      const i = Number(t.dataset.item);
      const it = st.items[i];
      if (t.value === TYPE_IT) Object.assign(it, { custom: true, product: "", filled: false });
      else {
        Object.assign(it, { custom: false, product: t.value, filled: false });
        const last = t.value && readJson(LAST_KEY, {})[t.value];
        if (last && !it.strength.trim() && !it.directions.trim() && !it.qty.trim()) {
          Object.assign(it, { strength: last.strength || "", directions: last.directions || "", qty: last.qty || "",
            repeats: last.repeats ?? it.repeats, filled: true });
        }
      }
      renderItems(); draw();
      if (it.custom) root.querySelector(`[data-item="${i}"][data-f="customName"]`)?.focus();
    }
  });
  root.addEventListener("focusin", (e) => {
    const t = e.target;
    st.focusKey = t.dataset.v || (t.dataset.item !== undefined ? "items" : t.dataset.role === "date" ? "date" : "");
    markFocus();
  });
  root.addEventListener("focusout", () => { st.focusKey = ""; markFocus(); });
  root.addEventListener("click", (e) => {
    const t = e.target;
    const nb = t.closest("[data-nudge]");
    if (nb) { handleNudge(nb, root); return; }
    const pk = t.closest("[data-pick]");
    if (pk) { pick(pk.dataset.pick); return; }
    const go = t.closest("[data-goto]");
    if (go) { root.querySelector(`[data-step="${go.dataset.goto}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const a = t.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "change-pt") { st.patient = null; renderPt(); renderDetails(); draw(); }
    else if (act === "add-item") {
      st.items.push(blankItem(!products.length));
      renderItems(); draw();
      root.querySelector(`[data-row="${st.items.length - 1}"] select, [data-row="${st.items.length - 1}"] input`)?.focus();
    }
    else if (act === "del-item") { st.items.splice(Number(a.dataset.i), 1); renderItems(); draw(); }
    else if (act === "rep") {
      const i = Number(a.dataset.i);
      const it = st.items[i];
      it.repeats = String(Math.max(0, Math.min(12, (parseInt(it.repeats, 10) || 0) + Number(a.dataset.d))));
      const inp = root.querySelector(`[data-item="${i}"][data-f="repeats"]`);
      if (inp) inp.value = it.repeats;
      draw();
    }
    else if (act === "dir") {
      const i = Number(a.dataset.i);
      st.items[i].directions = a.dataset.t;
      const inp = root.querySelector(`[data-item="${i}"][data-f="directions"]`);
      if (inp) inp.value = a.dataset.t;
      draw();
    }
    else if (act === "print") doPrint(a);
    else if (act === "test") { printTest(L); draw(); }
  });
  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      doPrint($("printbtn"));
    }
  };
  document.addEventListener("keydown", onKey);

  renderPt(); renderDetails(); renderItems();
  new ResizeObserver(fit).observe(pv);
  fit(); draw();
  if (patientId && !rec) pick(patientId);   // from the patient's page: filled in straight away
}

/* ===================== Set up the paper ===================== */

async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.8, data;
    do { data = c.toDataURL("image/jpeg", q); q -= 0.1; } while (data.length > 850000 && q > 0.3);
    return { data, w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

async function mountLayout(container, { staff }) {
  const root = document.createElement("section");
  root.className = "page wide rx";
  root.innerHTML = '<div class="skeleton sm"></div>';
  container.replaceChildren(root);

  let info, bg;
  try { [info, bg] = await Promise.all([loadLayout(true), loadBg(true)]); }
  catch (err) {
    console.error("Prescription layout failed:", err);
    if (root.isConnected) root.innerHTML = `<div class="state error"><strong>Couldn't open the paper setup</strong>${
      err && err.code === "permission-denied" ? "The Firestore rules don't allow it yet. Ask an Admin." : "Check your connection and try again."}</div>`;
    return;
  }
  if (!root.isConnected) return;

  let L = JSON.parse(JSON.stringify(info.L));
  let sel = "";
  let zoom = "fit";
  let showBg = true;
  let showGrid = true;
  let dirty = false;
  const undo = [];
  let lastPush = 0;

  root.innerHTML = `
    <a class="rx-back" href="#/prescriptions/new" data-role="back">← Back to the prescription</a>
    <div class="rx-top">
      <div><h2>Set up the script paper</h2>
        <p class="muted">Put each box where it belongs on the paper. Everyone in the clinic uses this layout.${
          info.saved && info.by ? ` Last saved by ${esc(info.by)}.` : ""}</p></div>
      <div class="rx-head-acts">
        <span class="rx-pill" data-role="state"></span>
        <button type="button" class="rx-btn sm" data-act="undo" title="Undo (Ctrl+Z)">↶ Undo</button>
        <button type="button" class="rx-btn is-primary" data-act="save">Save layout</button>
      </div>
    </div>
    <div class="rx-ed">
      <div class="rx-stage">
        <div class="rx-bar">
          <label class="rx-switch"><input type="checkbox" data-ui="grid" checked><span>Grid (10 mm)</span></label>
          <label class="rx-switch" data-role="bgtoggle"><input type="checkbox" data-ui="bg" checked><span>Picture of the form</span></label>
          <span class="rx-bar-sp"></span>
          <label class="rx-mini-sel">Zoom <select data-ui="zoom">
            <option value="fit">Fit</option><option value="0.75">75%</option><option value="1">100%</option>
            <option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option></select></label>
        </div>
        <div class="rx-scroll" data-role="scroll"><div class="rx-zoom" data-role="zoom">
          <div class="rx-paper rx-ed-paper" data-role="paper"></div></div></div>
        <p class="rx-hint">Drag a box to move it. Drag its corner to make it wider. Arrow keys move the chosen box 0.5 mm (hold Shift for 2 mm).</p>
      </div>
      <aside class="rx-panel" data-role="panel"></aside>
    </div>`;

  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const paper = $("paper");
  const zoomEl = $("zoom");
  const scroll = $("scroll");
  const panel = $("panel");

  const z = () => (zoom === "fit" ? Math.max(0.2, (scroll.clientWidth - 28) / (L.paper.w * PX)) : Number(zoom));
  function setDirty(v) {
    dirty = v;
    $("state").textContent = v ? "Not saved yet" : info.saved ? "Saved" : "Starting layout, not saved";
    $("state").className = `rx-pill${v ? "" : " is-ok"}`;
    root.querySelector('[data-act="save"]').disabled = !v && info.saved;
    root.querySelector('[data-act="undo"]').disabled = !undo.length;
  }
  function pushUndo(snap) { undo.push(snap || JSON.stringify(L)); if (undo.length > 60) undo.shift(); lastPush = Date.now(); }
  function change(fn, soft) { if (!soft || Date.now() - lastPush > 700) pushUndo(); fn(); setDirty(true); }

  /* ---- The page ---- */
  function applyZoom() {
    const k = z();
    paper.style.cssText = `width:${L.paper.w}mm;height:${L.paper.h}mm;transform:scale(${k});--z:${k};font-family:${fontCss(L.font)}`;
    zoomEl.style.width = `${L.paper.w * PX * k + 28}px`;
    zoomEl.style.height = `${L.paper.h * PX * k + 28}px`;
  }
  function fldHtml(d) {
    const f = L.fields[d.key];
    const g = geom(d, f);
    const resizable = d.type === "text" || d.type === "area";
    return `<div class="rx-fld${f.on ? "" : " is-off"}${sel === d.key ? " is-sel" : ""}" data-key="${d.key}" style="${fieldStyle(d, f, L)}">
      <span class="rx-tag">${esc(d.label)}</span><div class="rx-c">${fieldInner(d, f, g, SAMPLE[d.key])}</div>
      ${resizable ? '<span class="rx-h" title="Drag to resize"></span>' : ""}</div>`;
  }
  function drawPaper() {
    applyZoom();
    paper.innerHTML = (bg && showBg ? `<img class="rx-bg" alt="" src="${bg.data}" style="left:${num(L.bg.x)}mm;top:${num(L.bg.y)}mm;width:${num(L.bg.w, L.paper.w)}mm;opacity:${num(L.bg.opacity, 0.5)}">` : "") +
      (showGrid ? `<div class="rx-grid-lines"></div>${gridHtml(L).replace(/#eef0f3|#d1d5db/g, "transparent")}` : "") +
      FIELDS.map(fldHtml).join("");
    $("bgtoggle").hidden = !bg;
  }
  function place(key) {
    const el = paper.querySelector(`.rx-fld[data-key="${key}"]`);
    if (!el) return;
    const d = DEF[key], f = L.fields[key];
    el.style.cssText = fieldStyle(d, f, L);
    el.classList.toggle("is-off", !f.on);
    el.querySelector(".rx-c").innerHTML = fieldInner(d, f, geom(d, f), SAMPLE[key]);
  }
  function select(key) {
    sel = key || "";
    paper.querySelectorAll(".rx-fld").forEach((el) => el.classList.toggle("is-sel", el.dataset.key === sel));
    drawPanel();
    if (sel) paper.querySelector(`.rx-fld[data-key="${sel}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /* ---- The panel ---- */
  const mmIn = (attr, val, step = 0.5, unit = "mm", min = "") =>
    `<div class="rx-in"><input type="number" ${attr} step="${step}" ${min !== "" ? `min="${min}"` : ""} value="${esc(String(val))}"><em>${unit}</em></div>`;
  function inspHtml() {
    if (!sel) return '<p class="rx-note">Choose a box above (or click one on the page) to move it, size it or change its text.</p>';
    const d = DEF[sel], f = L.fields[sel];
    const row = (label, html, cls = "") => `<label class="rx-f ${cls}"><span>${label}</span>${html}</label>`;
    let size = "";
    if (d.type === "text") size = row("Width", mmIn('data-p="w"', f.w, 0.5, "mm", 5));
    if (d.type === "area") size = row("Width", mmIn('data-p="w"', f.w, 0.5, "mm", 5)) + row("Height", mmIn('data-p="h"', f.h, 0.5, "mm", 4));
    if (d.type === "tick") size = row("Box size", mmIn('data-p="box"', f.box, 0.5, "mm", 2));
    if (d.type === "boxes") {
      size = row("Width of each box", mmIn('data-p="pitch"', f.pitch, 0.1, "mm", 2)) +
        (d.count > 1 ? row("Digits in each group", `<div class="rx-in"><input data-p="groups" value="${esc(f.groups || "")}" placeholder="e.g. 4,5,1"></div>`) +
          row("Extra gap between groups", mmIn('data-p="gap"', f.gap || 0, 0.1, "mm", 0)) : "");
    }
    const mv = (v, label, txt) => `<button type="button" class="rx-nb" data-move="${v}" aria-label="${label}" title="${label}">${txt}</button>`;
    return `<div class="rx-insp">
      <div class="rx-insp-head"><strong>${esc(d.label)}</strong>
        <label class="rx-switch"><input type="checkbox" data-p="on" ${f.on ? "checked" : ""}><span>Print it</span></label></div>
      <div class="rx-insp-pos">
        <div class="rx-mini">${row("From the left edge", mmIn('data-p="x"', f.x))}${row("From the top edge", mmIn('data-p="y"', f.y))}</div>
        <div class="rx-nudge">${["", mv("0,-0.5", "Up 0.5 mm", "↑"), "", mv("-0.5,0", "Left 0.5 mm", "←"), "", mv("0.5,0", "Right 0.5 mm", "→"), "", mv("0,0.5", "Down 0.5 mm", "↓"), ""]
          .map((x) => x || "<span></span>").join("")}</div>
      </div>
      <div class="rx-mini">${size}</div>
      <div class="rx-mini">
        ${d.type !== "tick" ? row("Text size", mmIn('data-p="size"', f.size, 0.5, "pt", 6)) : row("Mark size", mmIn('data-p="size"', f.size, 0.5, "pt", 6))}
        ${d.type === "text" ? row("Line up", `<select data-p="align"><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select>`) : ""}
      </div>
      ${d.type !== "tick" ? `<label class="rx-check"><input type="checkbox" data-p="bold" ${f.bold ? "checked" : ""}> Bold</label>` : ""}
    </div>`;
  }
  function drawPanel() {
    const preset = L.paper.preset in PAPERS ? L.paper.preset : "custom";
    panel.innerHTML = `
      <div class="rx-card"><h3><span class="rx-step">1</span>Paper</h3>
        <div class="rx-mini">
          <label class="rx-f"><span>Size</span><select data-paper="preset">
            ${Object.keys(PAPERS).map((k) => `<option value="${k}" ${preset === k ? "selected" : ""}>${k} (${PAPERS[k][0]} × ${PAPERS[k][1]} mm)</option>`).join("")}
            <option value="custom" ${preset === "custom" ? "selected" : ""}>Custom size</option></select></label>
          <label class="rx-f"><span>Font</span><select data-paper="font">${FONTS.map((f) => `<option ${L.font === f ? "selected" : ""}>${f}</option>`).join("")}</select></label>
          <label class="rx-f"><span>Width</span>${mmIn('data-paper="w"', L.paper.w, 1, "mm", 50)}</label>
          <label class="rx-f"><span>Height</span>${mmIn('data-paper="h"', L.paper.h, 1, "mm", 50)}</label>
        </div>
      </div>
      <div class="rx-card"><h3><span class="rx-step">2</span>Picture of the blank form <small class="rx-opt">optional</small></h3>
        ${bg ? `<div class="rx-bgrow"><img src="${bg.data}" alt="Blank form"><div>
            <button type="button" class="rx-btn sm" data-act="bg-pick">Replace</button>
            <button type="button" class="rx-btn sm is-quiet" data-act="bg-del">Remove</button></div></div>
          <label class="rx-f"><span>How strong it shows</span><input type="range" min="0.1" max="1" step="0.05" data-bg="opacity" value="${num(L.bg.opacity, 0.5)}"></label>
          <div class="rx-mini">
            <label class="rx-f"><span>Picture from the left</span>${mmIn('data-bg="x"', L.bg.x)}</label>
            <label class="rx-f"><span>Picture from the top</span>${mmIn('data-bg="y"', L.bg.y)}</label>
            <label class="rx-f"><span>Picture width</span>${mmIn('data-bg="w"', L.bg.w, 0.5, "mm", 20)}</label>
            <label class="rx-f rx-f-btn"><span>&nbsp;</span><button type="button" class="rx-btn sm" data-act="bg-fit">Fit to the page</button></label>
          </div>`
        : `<button type="button" class="rx-drop" data-act="bg-pick"><strong>Upload a scan or photo</strong>
            <small>A flat scan of the whole blank sheet works best. The boxes are then easy to line up by eye.</small></button>`}
        <input type="file" accept="image/*" data-role="bgfile" hidden>
      </div>
      <div class="rx-card"><h3><span class="rx-step">3</span>Line up the boxes</h3>
        <div class="rx-list">${FIELDS.map((d) => `<div class="rx-li${sel === d.key ? " is-sel" : ""}" data-sel="${d.key}">
          <input type="checkbox" data-on="${d.key}" ${L.fields[d.key].on ? "checked" : ""} title="Print it" aria-label="Print ${esc(d.label)}">
          <span>${esc(d.label)}</span><em>${mm(L.fields[d.key].x)}, ${mm(L.fields[d.key].y)}</em></div>`).join("")}</div>
        <div data-role="insp">${inspHtml()}</div>
      </div>
      <div class="rx-card"><h3><span class="rx-step">4</span>Margins</h3>
        <p class="rx-note">Moves every box at once. Use this when everything is off by the same amount on every computer.</p>
        <div class="rx-mini">
          <label class="rx-f"><span>Move right by</span>${mmIn('data-off="x"', L.offset.x)}</label>
          <label class="rx-f"><span>Move down by</span>${mmIn('data-off="y"', L.offset.y)}</label>
        </div>
      </div>
      <div class="rx-card"><h3><span class="rx-step">5</span>Check it</h3>
        <p class="rx-note">Print a test page on plain paper. It shows a mm grid, each box's outline and sample text. Hold it over a script against the light.</p>
        <button type="button" class="rx-btn" data-act="test">🖨 Print a test page</button>
        <div class="rx-sep"></div>
        ${nudgeHtml()}
      </div>
      <button type="button" class="rx-link" data-act="reset">Start again from the starting layout</button>`;
    const al = panel.querySelector('[data-p="align"]');
    if (al) al.value = L.fields[sel].align || "left";
  }
  function syncInspector() {
    if (!sel) return;
    panel.querySelectorAll('[data-role="insp"] [data-p]').forEach((i) => {
      if (document.activeElement === i || i.type === "checkbox" || i.tagName === "SELECT") return;
      const v = L.fields[sel][i.dataset.p];
      if (v !== undefined) i.value = v;
    });
    const li = panel.querySelector(`.rx-li[data-sel="${sel}"] em`);
    if (li) li.textContent = `${mm(L.fields[sel].x)}, ${mm(L.fields[sel].y)}`;
  }
  function redrawAll() { drawPaper(); drawPanel(); }

  /* ---- Dragging ---- */
  paper.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".rx-fld");
    if (!el) { select(""); return; }
    e.preventDefault();
    const key = el.dataset.key;
    if (sel !== key) select(key);
    const f = L.fields[key];
    const resize = !!e.target.closest(".rx-h");
    const s = { x: num(f.x), y: num(f.y), w: num(f.w), h: num(f.h), px: e.clientX, py: e.clientY };
    const before = JSON.stringify(L);
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const k = PX * z();
      const dx = (ev.clientX - s.px) / k, dy = (ev.clientY - s.py) / k;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 0.4) return;
      moved = true;
      if (resize) {
        f.w = clamp(r05(s.w + dx), 5, L.paper.w);
        if (DEF[key].type === "area") f.h = clamp(r05(s.h + dy), 4, L.paper.h);
      } else {
        f.x = clamp(r05(s.x + dx), 0, L.paper.w - 2);
        f.y = clamp(r05(s.y + dy), 0, L.paper.h - 2);
      }
      place(key); syncInspector();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      if (moved) { pushUndo(before); setDirty(true); }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
    el.addEventListener("pointercancel", up, { once: true });
  });

  /* ---- Panel and toolbar ---- */
  function moveSel(dx, dy) {
    if (!sel) return;
    change(() => {
      const f = L.fields[sel];
      f.x = clamp(r05(num(f.x) + dx), 0, L.paper.w - 2);
      f.y = clamp(r05(num(f.y) + dy), 0, L.paper.h - 2);
    }, true);
    place(sel); syncInspector();
  }
  root.addEventListener("input", (e) => {
    const t = e.target;
    const val = t.type === "checkbox" ? t.checked : t.type === "number" || t.type === "range" ? Number(t.value) : t.value;
    if (t.type === "number" && !Number.isFinite(val)) return;
    if (t.dataset.p && sel) { change(() => { L.fields[sel][t.dataset.p] = val; }, true); place(sel); syncInspector(); return; }
    if (t.dataset.on) {
      change(() => { L.fields[t.dataset.on].on = t.checked; });
      place(t.dataset.on);
      if (sel === t.dataset.on) { const c = panel.querySelector('[data-p="on"]'); if (c) c.checked = t.checked; }
      return;
    }
    if (t.dataset.off) { change(() => { L.offset[t.dataset.off] = val; }, true); drawPaper(); return; }
    if (t.dataset.bg) { change(() => { L.bg[t.dataset.bg] = val; }, true); drawPaper(); return; }
    if (t.dataset.paper === "w" || t.dataset.paper === "h") {
      if (val < 50) return;
      change(() => { L.paper[t.dataset.paper] = val; L.paper.preset = "custom"; }, true);
      drawPaper();
      const p = panel.querySelector('[data-paper="preset"]'); if (p) p.value = "custom";
    }
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.paper === "preset") {
      if (t.value === "custom") { change(() => { L.paper.preset = "custom"; }); return; }
      change(() => { const [w, h] = PAPERS[t.value]; L.paper = { preset: t.value, w, h }; });
      redrawAll();
    } else if (t.dataset.paper === "font") { change(() => { L.font = t.value; }); drawPaper(); }
    else if (t.dataset.ui === "grid") { showGrid = t.checked; drawPaper(); }
    else if (t.dataset.ui === "bg") { showBg = t.checked; drawPaper(); }
    else if (t.dataset.ui === "zoom") { zoom = t.value; applyZoom(); }
    else if (t.dataset.role === "bgfile" && t.files && t.files[0]) uploadBg(t.files[0], t);
  });
  root.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest('[data-role="back"]') && dirty) {
      e.preventDefault();
      if (await confirmDialog({ title: "Leave without saving?", message: "Your changes to the paper layout haven't been saved.",
        confirmLabel: "Leave", tone: "warning" })) { dirty = false; location.hash = "#/prescriptions/new"; }
      return;
    }
    const nb = t.closest("[data-nudge]");
    if (nb) { handleNudge(nb, root); return; }
    const mv = t.closest("[data-move]");
    if (mv) { const [dx, dy] = mv.dataset.move.split(",").map(Number); moveSel(dx, dy); return; }
    const li = t.closest("[data-sel]");
    if (li && !t.closest("input")) { select(li.dataset.sel); return; }
    const a = t.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "save") save();
    else if (act === "undo") doUndo();
    else if (act === "test") { printTest(L); }
    else if (act === "bg-pick") panel.querySelector('[data-role="bgfile"]').click();
    else if (act === "bg-fit") { change(() => { L.bg = { ...L.bg, x: 0, y: 0, w: L.paper.w }; }); redrawAll(); }
    else if (act === "bg-del") removeBg();
    else if (act === "reset") {
      if (!(await confirmDialog({ title: "Start again?", message: "Every box goes back to the starting layout. You can still undo it, and nothing is saved until you press Save layout.",
        confirmLabel: "Start again", tone: "warning" }))) return;
      change(() => { L = defaultLayout(); });
      sel = ""; redrawAll();
    }
  });

  function doUndo() {
    if (!undo.length) return;
    L = JSON.parse(undo.pop());
    if (sel && !L.fields[sel]) sel = "";
    redrawAll();
    setDirty(true);
  }

  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (e.target.closest && e.target.closest("input, select, textarea")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); return; }
    if (!sel) return;
    const step = e.shiftKey ? 2 : 0.5;
    const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (map[e.key]) { e.preventDefault(); moveSel(...map[e.key]); }
    else if (e.key === "Escape") select("");
  };
  document.addEventListener("keydown", onKey);
  const onUnload = (e) => {
    if (!root.isConnected) { window.removeEventListener("beforeunload", onUnload); return; }
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  };
  window.addEventListener("beforeunload", onUnload);
  new ResizeObserver(() => { if (zoom === "fit") applyZoom(); }).observe(scroll);

  /* ---- Saving ---- */
  async function save() {
    const btn = root.querySelector('[data-act="save"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const data = JSON.parse(JSON.stringify(L));
      data.updatedAt = new Date().toISOString();
      data.updatedBy = String((staff && staff.name) || "");
      await setDoc(doc(db, "rx_settings", "layout"), data);
      info = { L: mergeLayout(data), saved: true, by: data.updatedBy, at: data.updatedAt };
      layoutMemo = info;
      setDirty(false);
      showToast("Layout saved");
    } catch (err) {
      console.error("Layout not saved:", err);
      showToast(err && err.code === "permission-denied" ? "You can't save the layout. Ask an Admin." : "Couldn't save. Try again.");
      setDirty(true);
    } finally { btn.textContent = "Save layout"; }
  }
  async function uploadBg(file, input) {
    input.value = "";
    if (!/^image\//.test(file.type) || /heic|heif/i.test(file.type)) { showToast("Choose a JPG or PNG picture. For a PDF, take a screenshot of it."); return; }
    showToast("Adding the picture…");
    try {
      const img = await compressImage(file);
      const data = { data: img.data, w: img.w, h: img.h, at: new Date().toISOString(), by: String((staff && staff.name) || "") };
      await setDoc(doc(db, "rx_settings", "background"), data);
      bg = data; bgMemo = data;
      change(() => { L.bg = { ...L.bg, x: 0, y: 0, w: L.paper.w }; });
      showBg = true;
      const tb = root.querySelector('[data-ui="bg"]'); if (tb) tb.checked = true;
      redrawAll();
      showToast("Picture added. Now drag each box onto its place.");
    } catch (err) {
      console.error("Picture not added:", err);
      showToast(err && err.code === "permission-denied" ? "You can't change the picture. Ask an Admin." : "That picture couldn't be added. Try a JPG or PNG.");
    }
  }
  async function removeBg() {
    if (!(await confirmDialog({ title: "Remove the picture?", message: "The box positions stay as they are.", confirmLabel: "Remove", tone: "warning" }))) return;
    try {
      await deleteDoc(doc(db, "rx_settings", "background"));
      bg = null; bgMemo = null;
      redrawAll();
    } catch (err) { console.error("Picture not removed:", err); showToast("Couldn't remove it. Try again."); }
  }

  redrawAll();
  setDirty(false);
  if (!info.saved) setDirty(true);
}

/* ===================== Styles ===================== */

function injectStyles() {
  if (document.getElementById("rx-styles")) return;
  const s = document.createElement("style");
  s.id = "rx-styles";
  s.textContent = `
.rx{--acc:#0f766e;--acc2:#14b8a6;--line:#e5e7eb;--soft:#f8fafc;--ink:#0f172a;--mut:#64748b}
.rx-back{display:inline-flex;align-items:center;gap:6px;color:var(--mut);text-decoration:none;font-size:13px;margin-bottom:4px}
.rx-back:hover{color:var(--acc)}
.rx-top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:4px 0 18px}
.rx-top h2{margin:0 0 2px}.rx-top p{margin:0}
.rx-head-acts{display:flex;align-items:center;gap:8px}
.rx-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,460px);gap:20px;align-items:start}
.rx-ed{display:grid;grid-template-columns:minmax(0,1fr) 370px;gap:20px;align-items:start}
@media (max-width:1100px){.rx-grid,.rx-ed{grid-template-columns:1fr}}
.rx-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.rx-card h3{margin:0 0 12px;font-size:15px;display:flex;align-items:center;gap:8px;color:var(--ink)}
.rx-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.rx-card-head h3{margin:0}
.rx-step{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#ccfbf1;color:var(--acc);font-size:12px;font-weight:700;flex:none}
.rx-opt{font-weight:400;color:var(--mut);font-size:12px}
.rx-fields{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px 12px}
.rx-fields .c1{grid-column:span 1}.rx-fields .c2{grid-column:span 2}.rx-fields .c3{grid-column:span 3}.rx-fields .c4{grid-column:span 4}.rx-fields .c6{grid-column:span 6}
@media (max-width:640px){.rx-fields .c1,.rx-fields .c2,.rx-fields .c3,.rx-fields .c4{grid-column:span 3}}
.rx-f{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--mut);min-width:0}
.rx-f input:not([type=checkbox]):not([type=range]),.rx-f select,.rx-mini-sel select{font:inherit;font-size:14px;color:var(--ink);border:1px solid #d1d5db;border-radius:9px;padding:8px 10px;background:#fff;width:100%;box-sizing:border-box;min-width:0}
.rx-f input:focus,.rx-f select:focus,.rx-search input:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(20,184,166,.18)}
.rx-f-btn{justify-content:flex-end}
.rx-in{display:flex;align-items:center;border:1px solid #d1d5db;border-radius:9px;background:#fff;overflow:hidden}
.rx-in:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px rgba(20,184,166,.18)}
.rx-in input{border:0!important;box-shadow:none!important;border-radius:0!important;padding:7px 8px!important}
.rx-in em{font-style:normal;font-size:12px;color:var(--mut);padding:0 9px 0 2px}
.rx-sub{font-size:12px;font-weight:600;color:var(--mut);margin:14px 0 8px;text-transform:uppercase;letter-spacing:.04em}
.rx-ticks{display:flex;flex-wrap:wrap;gap:8px}
.rx-tick{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid #d1d5db;border-radius:999px;font-size:13px;cursor:pointer;user-select:none;background:#fff}
.rx-tick:has(input:checked){background:#f0fdfa;border-color:var(--acc);color:var(--acc);font-weight:600}
.rx-tick input{accent-color:var(--acc);margin:0}
.rx-item{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--soft);margin-bottom:10px;position:relative}
.rx-item-n{font-size:11px;font-weight:700;color:var(--acc);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.rx-del{position:absolute;top:8px;right:8px;width:28px;height:28px;border-radius:8px;border:0;background:transparent;color:var(--mut);cursor:pointer}
.rx-del:hover{background:#fee2e2;color:#b91c1c}
.rx-add{width:100%;padding:11px;border:1.5px dashed #99f6e4;border-radius:12px;background:#f0fdfa;color:var(--acc);font:inherit;font-weight:600;cursor:pointer}
.rx-add:hover{background:#ccfbf1}
.rx-search{display:flex;align-items:center;gap:8px;border:1px solid #d1d5db;border-radius:10px;padding:0 10px;background:#fff}
.rx-search input{flex:1;border:0;padding:10px 2px;font:inherit;font-size:14px;outline:none;background:transparent}
.rx-results{border:1px solid var(--line);border-radius:10px;margin-top:8px;max-height:300px;overflow:auto}
.rx-res{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;padding:10px 12px;border:0;border-bottom:1px solid #f1f5f9;background:#fff;text-align:left;cursor:pointer;font:inherit;font-size:14px}
.rx-res:last-child{border-bottom:0}.rx-res:hover{background:#f0fdfa}
.rx-res small{color:var(--mut);font-size:12px}.rx-res span small{display:block}
.rx-pt{display:flex;align-items:center;gap:12px}
.rx-av{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:#ccfbf1;color:var(--acc);font-weight:700;flex:none}
.rx-pt-main{flex:1;min-width:0}.rx-pt-main strong{display:block;font-size:15px}.rx-pt-main small{color:var(--mut)}
.rx-side{position:sticky;top:76px}
.rx-pv{position:relative;overflow:hidden;border-radius:8px;background:#e2e8f0}
.rx-paper{position:absolute;top:0;left:0;background:#fff;transform-origin:0 0;box-shadow:0 6px 24px rgba(15,23,42,.14);color:#000;overflow:hidden}
.rx-bg{position:absolute;pointer-events:none;user-select:none;max-width:none}
.rx-warn{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:10px;padding:9px 12px;font-size:13px;margin-top:10px}
.rx-banner{background:#f0fdfa;border:1px solid #99f6e4;color:#134e4a;border-radius:12px;padding:11px 14px;font-size:13.5px;margin-bottom:16px}
.rx-banner.is-soft{margin-bottom:12px}
.rx-note{color:var(--mut);font-size:12.5px;margin:8px 0 0;line-height:1.5}
.rx-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.rx-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 14px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font:inherit;font-size:14px;font-weight:500;cursor:pointer;color:var(--ink);text-decoration:none;white-space:nowrap}
.rx-btn:hover{border-color:var(--acc);color:var(--acc)}
.rx-btn.is-primary{background:var(--acc);border-color:var(--acc);color:#fff}
.rx-btn.is-primary:hover{background:#115e59;color:#fff}
.rx-btn.is-quiet{border-color:transparent;color:var(--mut)}
.rx-btn:disabled{opacity:.45;cursor:default}
.rx-btn.sm{padding:6px 11px;font-size:13px}
.rx-link{border:0;background:none;color:var(--mut);font:inherit;font-size:13px;text-decoration:underline;cursor:pointer;padding:4px 2px}
.rx-pill{font-size:12px;padding:4px 10px;border-radius:999px;background:#fef3c7;color:#92400e;white-space:nowrap}
.rx-pill.is-ok{background:#dcfce7;color:#166534}
.rx-switch{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--ink);cursor:pointer;user-select:none}
.rx-switch input{appearance:none;width:32px;height:18px;border-radius:999px;background:#cbd5e1;position:relative;cursor:pointer;margin:0;transition:background .15s;flex:none}
.rx-switch input::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.rx-switch input:checked{background:var(--acc)}.rx-switch input:checked::after{left:16px}
.rx-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;margin-top:10px;cursor:pointer}
.rx-check input{accent-color:var(--acc)}
.rx-nudge-wrap{display:flex;gap:14px;align-items:center}
.rx-nudge{display:grid;grid-template-columns:repeat(3,34px);grid-auto-rows:34px;gap:4px;flex:none}
.rx-nb{width:34px;height:34px;border-radius:9px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:15px;color:var(--ink)}
.rx-nb:hover{border-color:var(--acc);color:var(--acc);background:#f0fdfa}
.rx-nudge-txt{display:flex;flex-direction:column;gap:3px;font-size:13px}
.rx-nudge-txt small{color:var(--mut);font-size:12px;line-height:1.45}
.rx-nudge-read{color:var(--acc);font-weight:600}
.rx-sep{height:1px;background:var(--line);margin:14px 0}
.rx-stage{background:#e2e8f0;border-radius:14px;padding:12px}
.rx-bar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:2px 4px 10px;font-size:13px}
.rx-bar-sp{flex:1}
.rx-mini-sel{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--mut)}
.rx-mini-sel select{width:auto;padding:5px 8px}
.rx-scroll{overflow:auto;max-height:calc(100vh - 230px);border-radius:10px;background:#cbd5e1}
.rx-zoom{position:relative;padding:14px;box-sizing:border-box}
.rx-ed-paper{position:relative;top:auto;left:auto}
.rx-zoom .rx-ed-paper{position:absolute;top:14px;left:14px}
.rx-grid-lines{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(to right,rgba(15,118,110,.14) .2mm,transparent .2mm),linear-gradient(to bottom,rgba(15,118,110,.14) .2mm,transparent .2mm);background-size:10mm 10mm}
.rx-hint{font-size:12.5px;color:#475569;margin:10px 4px 2px}
.rx-fld{position:absolute;box-sizing:border-box;border:calc(1px / var(--z,1)) dashed rgba(15,118,110,.75);background:rgba(20,184,166,.10);cursor:move;touch-action:none;border-radius:calc(2px / var(--z,1));overflow:visible}
.rx-fld:hover{background:rgba(20,184,166,.18)}
.rx-fld.is-off{opacity:.25;border-style:dotted}
.rx-fld.is-sel{border:calc(2px / var(--z,1)) solid var(--acc);background:rgba(20,184,166,.2);box-shadow:0 0 0 calc(3px / var(--z,1)) rgba(20,184,166,.28);z-index:2}
.rx-fld .rx-c{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.rx-tag{position:absolute;left:calc(-1px / var(--z,1));bottom:100%;font:600 calc(11px / var(--z,1))/1.5 system-ui,sans-serif;background:var(--acc);color:#fff;padding:0 .5em;border-radius:.35em .35em 0 0;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .1s}
.rx-fld:hover .rx-tag,.rx-fld.is-sel .rx-tag{opacity:.92}
.rx-h{position:absolute;right:calc(-6px / var(--z,1));bottom:calc(-6px / var(--z,1));width:calc(12px / var(--z,1));height:calc(12px / var(--z,1));background:#fff;border:calc(2px / var(--z,1)) solid var(--acc);border-radius:calc(3px / var(--z,1));cursor:nwse-resize;box-sizing:border-box}
.rx-fld:not(.is-sel) .rx-h{display:none}
.rx-panel .rx-card{margin-bottom:14px}
.rx-mini{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.rx-list{display:flex;flex-direction:column;gap:2px;max-height:250px;overflow:auto;margin:-2px -4px 12px;padding:2px 4px}
.rx-li{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:9px;cursor:pointer;font-size:13.5px}
.rx-li:hover{background:#f1f5f9}
.rx-li.is-sel{background:#ccfbf1;color:var(--acc);font-weight:600}
.rx-li input{accent-color:var(--acc);margin:0}
.rx-li span{flex:1}.rx-li em{font-style:normal;font-size:11.5px;color:var(--mut);font-variant-numeric:tabular-nums}
.rx-insp{border-top:1px solid var(--line);padding-top:12px;display:flex;flex-direction:column;gap:10px}
.rx-insp-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rx-insp-pos{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}
.rx-drop{width:100%;display:flex;flex-direction:column;gap:4px;align-items:center;text-align:center;padding:18px 14px;border:1.5px dashed #99f6e4;border-radius:12px;background:#f0fdfa;color:var(--acc);font:inherit;cursor:pointer}
.rx-drop small{color:var(--mut);font-size:12px}
.rx-drop:hover{background:#ccfbf1}
.rx-bgrow{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.rx-bgrow img{width:64px;height:86px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}
.rx-bgrow div{display:flex;gap:6px;flex-wrap:wrap}
.rx input[type=range]{accent-color:var(--acc);width:100%}
`;
  document.head.appendChild(s);
}