// Each kind of tab gets its own small icon and title, so open tabs can be told apart at a glance.
// While a page has its own title or icon, they're held: anything else that changes them is put back.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const KINDS = {
  notes: { bg: "#16a34a", dot: true },        // consultation notes: a green dot
  recording: { bg: "#dc2626", dot: true },    // recording right now: a red dot
  tx: { bg: "#2563eb", text: "TxR", label: "TxR" },
  consent: { bg: "#7c3aed", text: "C", label: "Consent" },
  rx: { bg: "#db2777", text: "Rx", label: "Rx" },
};

let originals = null;    // the portal's own icon links, put back on other pages
let shown = "";          // the icon kind showing now
let wanted = "";         // the title this page asked for ("" = leave the title alone)
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
  g.fillStyle = k.bg;
  g.fill();
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  if (k.text) {
    const size = k.text.length >= 3 ? 27 : k.text.length === 2 ? 36 : 46;
    g.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(k.text, 32, 35);
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
  if (shown === kind) return;
  try {
    shown = kind;
    putIcon(drawIcon(kind));
    keep();
  } catch (err) {
    shown = "";
    console.warn("Tab icon not set:", err);
  }
}

export function resetTabIcon() {
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

// #/form-record/<id>: TxR, C or Rx icon, and "TxR · Jane Smith" as the title
export async function labelFormRecordTab(id) {
  const hash = location.hash;
  try {
    const snap = await getDoc(doc(db, "form_submissions", id));
    if (location.hash !== hash || !snap.exists()) return;   // moved on, or not found
    const s = snap.data();
    const kind = formTabKind(s.category, s.templateName);
    if (!kind) return;
    setTabIcon(kind);
    setTabTitle(`${KINDS[kind].label} · ${s.patientName || "Patient"}`);
  } catch (err) {
    console.warn("Record tab not labelled:", err);
  }
}