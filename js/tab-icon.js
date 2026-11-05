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

let originals = null;    // the portal's own icon links, put back on other pages
let shown = "";          // the kind showing now (so it isn't redrawn every second)
const urls = new Map();  // kind → the drawn icon

const iconLinks = () => [...document.querySelectorAll('link[rel~="icon"]')];

// Chrome only notices a new icon reliably when the old icon links are gone and a new one is added
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

export function setTabIcon(kind) {
  if (!KINDS[kind]) { resetTabIcon(); return; }
  if (shown === kind) return;
  try {
    putIcon(drawIcon(kind));
    shown = kind;
  } catch (err) { console.warn("Tab icon not set:", err); }
}

export function resetTabIcon() {
  if (!shown) return;
  putIcon("");
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