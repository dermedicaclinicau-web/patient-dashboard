// Each kind of tab gets its own small icon and title, so open tabs can be told apart at a glance.
// While a page has its own title or icon, they're held: anything else that changes them is put back.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const KINDS = {
  notes: { bg: "#16a34a", dot: true },        // consultation notes: a green dot (Reviewed)
  notesDraft: { bg: "#eab308", dot: true },   // consultation notes still a Draft: a yellow dot
  recording: { bg: "#dc2626", dot: true },    // recording right now: a red dot
  recPaused: { bg: "#d97706", dot: true },    // recording paused: an amber dot
  tx: { bg: "#f97316", bg2: "#c2410c", text: "TxR", label: "TxR" },   // orange, like the Treatment Records cards
  consent: { bg: "#7c3aed", text: "C", label: "Consent" },
  rx: { bg: "#db2777", text: "Rx", label: "Rx" },
  calendar: { bg: "#ff1212", icon: "calendar", label: "Calendar" },   // teal, with a white calendar
  ssp: { bg: "#e11d48", icon: "drop", label: "Skin Script" },          // rose, with a white drop (like the Skin Script section)
};

let originals = null;    // the portal's own icon links, put back on other pages
let shown = "";          // the icon kind showing now
let wanted = "";         // the title this page asked for ("" = leave the title alone)
let asked = "";          // the icon the page asked for ("notes" can show as green or yellow)

// Notes: yellow while the tab's name starts with "Draft", green otherwise
const notesKind = () => (/^\s*draft\b/i.test(wanted || document.title) ? "notesDraft" : "notes");
const urls = new Map();  // kind → the drawn icon

/* ---------- Drawing ---------- */

// A 64×64 rounded square: white letters, or a white microphone
function drawIcon(kind) {
  if (urls.has(kind)) return urls.get(kind);
  const k = KINDS[kind];
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");

  // A dot: a soft halo with a solid dot inside, so it's still clear at 16px
  if (k.dot) {
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
  const r = 14;
  g.beginPath();
  g.moveTo(r, 0); g.lineTo(64 - r, 0); g.quadraticCurveTo(64, 0, 64, r);
  g.lineTo(64, 64 - r); g.quadraticCurveTo(64, 64, 64 - r, 64);
  g.lineTo(r, 64); g.quadraticCurveTo(0, 64, 0, 64 - r);
  g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0);
  g.closePath();
  if (k.bg2) {   // a top-left to bottom-right gradient
    const grad = g.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, k.bg);
    grad.addColorStop(1, k.bg2);
    g.fillStyle = grad;
  } else {
    g.fillStyle = k.bg;
  }
  g.fill();
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  if (k.text) {
    const size = k.text.length >= 3 ? 27 : k.text.length === 2 ? 36 : 46;
    g.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(k.text, 32, 35);
  } else if (k.icon === "calendar") {
    // A white calendar: outline, top band, two rings and the days (bold shapes, so it's clear at 16px)
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
  } else if (k.icon === "drop") {
    // A solid white drop: the same shape as the Skin Script section's icon, drawn large so it's clear at 16px
    g.save();
    g.translate(5.6, 4.5);
    g.scale(2.2, 2.2);
    g.fill(new Path2D("M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"));
    g.restore();
  } else {
    g.save();
    g.translate(8, 6);
    g.scale(2, 2);   // a 24px microphone drawn at 48px
    g.lineWidth = 2.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.fill(new Path2D("M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"));
    g.stroke(new Path2D("M19 10v2a7 7 0 0 1-14 0v-2"));
    g.stroke(new Path2D("M12 19v4"));
    g.restore();
  }
  const url = c.toDataURL("image/png");
  urls.set(kind, url);
  return url;
}

/* ---------- Menu pages: the sidebar's own icon ---------- */
// The sidebar icon's shapes are redrawn white on a teal rounded square. It's drawn straight away, with no waiting
// for an image to load, so a page that sets its own icon a moment later always wins.

function roundSquare(g, fill) {
  const r = 14;
  g.beginPath();
  g.moveTo(r, 0); g.lineTo(64 - r, 0); g.quadraticCurveTo(64, 0, 64, r);
  g.lineTo(64, 64 - r); g.quadraticCurveTo(64, 64, 64 - r, 64);
  g.lineTo(r, 64); g.quadraticCurveTo(0, 64, 0, 64 - r);
  g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
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

function drawSvgIcon(svg) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  roundSquare(g, "#0F766E");

  let vb = String(svg.getAttribute("viewBox") || "0 0 24 24").trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) vb = [0, 0, 24, 24];
  const [vx, vy, vw, vh] = vb;
  const s = 38 / Math.max(vw, vh);            // the icon fills about 60% of the square
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
  return c.toDataURL("image/png");
}

// A menu page's tab: the sidebar icon, and the menu name as the title
export function setMenuTab(key, svg, label) {
  if (label) setTabTitle(label);
  if (!key || !svg) return;
  const kind = `menu:${key}`;
  try {
    if (!urls.has(kind)) urls.set(kind, drawSvgIcon(svg));
    asked = "";
    if (shown === kind) return;
    shown = kind;
    putIcon(urls.get(kind));
    keep();
  } catch (err) {
    shown = "";
    console.warn("Menu tab icon not set:", err);
  }
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
        if (!mine || links.some((l) => !l.dataset.tabIcon)) putIcon(drawIcon(shown));
      }
    } catch (err) { console.warn("Tab title or icon not kept:", err); }
    fixing = false;
  });
  keeper.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
}

export function setTabIcon(kind) {
  if (!KINDS[kind]) { resetTabIcon(); return; }
  asked = kind;
  const real = kind === "notes" ? notesKind() : kind;
  if (shown === real) return;
  try {
    shown = real;
    putIcon(drawIcon(real));
    keep();
  } catch (err) {
    shown = "";
    console.warn("Tab icon not set:", err);
  }
}

export function resetTabIcon() {
  asked = "";
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

// A form's tab: TxR, C or Rx icon, and "TxR · Jane Smith" as the title. false = an ordinary form.
export function setFormTab(category, templateName, patientName) {
  const kind = formTabKind(category, templateName);
  if (!kind) return false;
  setTabIcon(kind);
  setTabTitle(`${KINDS[kind].label} · ${patientName || "Patient"}`);
  return true;
}
// The Skin Script builder's tab: the rose drop, and "Skin Script · Jane Smith" as the title
export function setSspTab(patientName) {
  setTabIcon("ssp");
  setTabTitle(`${KINDS.ssp.label} · ${patientName || "Patient"}`);
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