// Skin Script Protocols: editing a saved one (with history), and opening the builder
// from a saved protocol ("Edit" or "Duplicate").
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Hand-over from the patient page to the builder ---------- */
// localStorage, so it reaches the builder's new tab. Taken once, and only within 10 minutes.
const KEY = "dm.sspIntent";
const TAB = "dm-ssp";   // the builder's tab name, when the patient page opened it

// { mode: "edit" | "copy", patientId, recordId?, items?, fromDate? }
export function setSspIntent(x) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...x, at: Date.now() })); } catch { /* private mode */ }
}
export function takeSspIntent(patientId) {
  let x = null;
  try { x = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
  if (!x || x.patientId !== patientId) return null;   // another patient's: left for its own tab
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return Date.now() - Number(x.at || 0) < 10 * 60000 ? x : null;
}

// Opens the builder in a new tab (Edit, Duplicate or New SSP). Pop-ups blocked: in this tab instead.
// Call it straight from the click, so the browser allows the tab.
export function openSspBuilder(patientId, intent = null) {
  if (intent) setSspIntent({ ...intent, patientId });
  else { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }   // New SSP: nothing left over from an earlier Edit
  const hash = `#/ssp/new/${encodeURIComponent(patientId)}`;
  const w = window.open(location.href.split("#")[0] + hash, `${TAB}:${Date.now()}`);
  if (w) { try { w.focus(); } catch { /* ignore */ } return true; }
  location.hash = hash;
  return false;
}
// For a click that has to save something first: the tab opens straight away (so the browser allows it)
// and goes to the builder once the protocol is saved. → { go(intent), cancel() }
export function reserveSspTab(patientId) {
  const hash = `#/ssp/new/${encodeURIComponent(patientId)}`;
  const w = window.open("", `${TAB}:${Date.now()}`);
  if (w) { try { w.document.title = "Opening…"; w.document.body.textContent = "Opening the Skin Script…"; } catch { /* ignore */ } }
  return {
    go(intent) {
      setSspIntent({ ...intent, patientId });
      if (w && !w.closed) { w.location.href = location.href.split("#")[0] + hash; try { w.focus(); } catch { /* ignore */ } }
      else location.hash = hash;   // pop-ups blocked: this tab
    },
    cancel() { if (w && !w.closed) w.close(); },
  };
}
export const inSspTab = () => String(window.name || "").startsWith(`${TAB}:`);

// Saved in the builder: the patient page (in another tab) loads its protocols again
const CH = "dm-ssp";
export function announceSspSaved(patientId) {
  try { const bc = new BroadcastChannel(CH); bc.postMessage({ type: "ssp-saved", patientId }); bc.close(); } catch { /* not supported */ }
}
export function onSspSaved(fn) {
  let bc = null;
  try {
    bc = new BroadcastChannel(CH);
    bc.onmessage = (e) => { if (e.data && e.data.type === "ssp-saved") fn(e.data); };
  } catch { bc = null; }
  return () => { if (bc) bc.close(); };
}

/* ---------- What changed ---------- */
const keyOf = (it) => `${it.step}:${it.productId}`;
const sigOf = (it) => JSON.stringify([!!it.am, !!it.pm, !!it.maint, it.amText || "", it.pmText || "", it.days || [], it.notes || ""]);

// "added X; changed Y; removed Z; valid until → 2027-01-12", or "" if nothing changed
export function describeSspChanges(oldRec, items, meta) {
  const before = new Map((oldRec.items || []).map((it) => [keyOf(it), it]));
  const after = new Map(items.map((it) => [keyOf(it), it]));
  const added = items.filter((it) => !before.has(keyOf(it))).map((it) => it.name);
  const removed = (oldRec.items || []).filter((it) => !after.has(keyOf(it))).map((it) => it.name);
  const changed = items.filter((it) => before.has(keyOf(it)) && sigOf(before.get(keyOf(it))) !== sigOf(it)).map((it) => it.name);
  const parts = [];
  if (meta.recordDate !== oldRec.recordDate) parts.push(`record date ${oldRec.recordDate || "—"} → ${meta.recordDate}`);
  if (meta.validUntil !== oldRec.validUntil) parts.push(`valid until ${oldRec.validUntil || "—"} → ${meta.validUntil}`);
  if (added.length) parts.push(`added ${added.join(", ")}`);
  if (changed.length) parts.push(`changed ${changed.join(", ")}`);
  if (removed.length) parts.push(`removed ${removed.join(", ")}`);
  return parts.join("; ").slice(0, 600);
}

/* ---------- Saving an edit ---------- */
// Keeps the previous version (dates and products) in the history, last 10 edits
export async function updateSspRecord(id, { recordDate, validUntil, items }, staff, summary) {
  const ref = doc(db, "ssp_records", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("This protocol no longer exists.");
  const old = snap.data() || {};
  const who = String((staff && staff.name) || "").slice(0, 120);
  const uid = auth.currentUser ? auth.currentUser.uid : "";
  const entry = {
    at: new Date().toISOString(), by: who, byUid: uid, summary: String(summary || "").slice(0, 600),
    previous: { recordDate: old.recordDate || "", validUntil: old.validUntil || "", items: Array.isArray(old.items) ? old.items : [] },
  };
  await updateDoc(ref, {
    recordDate, validUntil, items,
    editedAt: serverTimestamp(), editedBy: who, editedByUid: uid,
    editCount: Number(old.editCount || 0) + 1,
    history: [...(Array.isArray(old.history) ? old.history : []), entry].slice(-10),
  });
}