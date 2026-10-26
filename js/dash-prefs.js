// My dashboard: each person's layout (order, columns, colours, hidden and collapsed cards).
// Kept on this device so the dashboard draws straight away, and in Firestore staff_prefs/{uid}
// so it follows them to any iPad or computer. The newer of the two wins.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Red and amber are left out on purpose: they mean "needs attention" on the dashboard
export const DASH_COLORS = [
  ["teal", "Teal"], ["sky", "Sky"], ["blue", "Blue"], ["violet", "Violet"],
  ["pink", "Pink"], ["sage", "Sage"], ["slate", "Slate"],
];
const COLOR_KEYS = DASH_COLORS.map(([k]) => k);
const lsKey = (uid) => `dm.dash.prefs.${uid}`;
const keyOk = (k) => typeof k === "string" && /^[a-z]{2,20}$/.test(k);
const keys = (a) => (Array.isArray(a) ? [...new Set(a.filter(keyOk))].slice(0, 40) : []);

function clean(p) {
  p = p && typeof p === "object" ? p : {};
  const cols = {};
  const colors = {};
  Object.entries(p.cols || {}).forEach(([k, v]) => { if (keyOk(k) && (v === "main" || v === "side")) cols[k] = v; });
  Object.entries(p.colors || {}).forEach(([k, v]) => { if (keyOk(k) && COLOR_KEYS.includes(v)) colors[k] = v; });
  return { order: keys(p.order), hidden: keys(p.hidden), folded: keys(p.folded), cols, colors, at: Number(p.at) || 0 };
}
const same = (a, b) => JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });

// Layouts saved before this (three separate keys on this device only)
function legacy(uid) {
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
  return clean({ order: read(`dm.dash.order.${uid}`), hidden: read(`dm.dash.hidden.${uid}`), folded: read(`dm.dash.collapsed.${uid}`) });
}

const mem = new Map();
const keep = (uid, p) => {
  mem.set(uid, p);
  try { localStorage.setItem(lsKey(uid), JSON.stringify(p)); } catch { /* private mode */ }
};

export function getDashPrefs(uid) {
  if (!uid) return clean({});
  if (mem.has(uid)) return mem.get(uid);
  let p = null;
  try { const raw = localStorage.getItem(lsKey(uid)); if (raw) p = clean(JSON.parse(raw)); } catch { /* private mode */ }
  p = p || legacy(uid);
  mem.set(uid, p);
  return p;
}

// Saved to their login a moment after the last change (dragging, folding and so on can come in quick bursts)
let timer = 0;
let warned = false;
function push(uid) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    setDoc(doc(db, "staff_prefs", uid), { dash: getDashPrefs(uid), updatedAt: serverTimestamp() },
      { mergeFields: ["dash", "updatedAt"] })
      .catch((err) => {
        if (warned) return;
        warned = true;
        console.warn("Dashboard layout saved on this device only (not to your login):", err);
      });
  }, 800);
}

export function saveDashPrefs(uid, patch) {
  if (!uid) return null;
  const p = clean({ ...getDashPrefs(uid), ...patch, at: Date.now() });
  keep(uid, p);
  push(uid);
  return p;
}

// Once per visit. Returns true if the layout saved to their login replaced this device's.
export async function syncDashPrefs(uid) {
  if (!uid) return false;
  const local = getDashPrefs(uid);
  let remote = null;
  try {
    const snap = await getDoc(doc(db, "staff_prefs", uid));
    remote = snap.exists() && snap.data().dash ? clean(snap.data().dash) : null;
  } catch (err) {
    console.warn("Dashboard layout not read from your login:", err);
    return false;
  }
  if (remote && remote.at > local.at) {
    keep(uid, remote);
    return !same(remote, local);
  }
  const hasLocal = local.order.length || local.hidden.length || local.folded.length
    || Object.keys(local.cols).length || Object.keys(local.colors).length;
  if (hasLocal && (!remote || local.at > remote.at || !same(local, remote))) push(uid);
  return false;
}