// Each kind of tab gets its own small icon and title, so open tabs can be told apart at a glance
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const KINDS = {
  notes: { bg: "#0f766e", mic: true },        // consultation notes
  recording: { bg: "#dc2626", mic: true },    // recording right now
  tx: { bg: "#2563eb", text: "TxR", label: "TxR" },
  consent: { bg: "#7c3aed", text: "C", label: "Consent" },
  rx: { bg: "#db2777", text: "Rx", label: "Rx" },
};

let original = null;     // the portal's own icon, put back on other pages
let shown = "";          // the kind showing now (so it isn't redrawn every second)
const urls = new Map();  // kind → the drawn icon

function iconLink() {
  let link = document.querySelector('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  if (original === null) original = { href: link.getAttribute("href") || "", type: link.getAttribute("type") || "" };
  return link;
}

// A 64×64 rounded square: white letters, or a white microphone
function drawIcon(kind) {
  if (urls.has(kind)) return urls.get(kind);
  const k = KINDS[kind];
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
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

export function setTabIcon(kind) {
  if (!KINDS[kind]) { resetTabIcon(); return; }
  if (shown === kind) return;
  try {
    const link = iconLink();
    link.type = "image/png";
    link.href = drawIcon(kind);
    shown = kind;
  } catch (err) { console.warn("Tab icon not set:", err); }
}

export function resetTabIcon() {
  if (!shown) return;
  const link = iconLink();
  if (original.href) link.setAttribute("href", original.href); else link.removeAttribute("href");
  if (original.type) link.setAttribute("type", original.type); else link.removeAttribute("type");
  shown = "";
}

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
    document.title = `${KINDS[kind].label} · ${s.patientName || "Patient"}`;
  } catch (err) {
    console.warn("Record tab not labelled:", err);
  }
}