// Skin Script Protocols: editing a saved one (with history), and opening the builder
// from a saved protocol ("Edit" or "Duplicate").
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Hand-over from the patient page to the builder ---------- */
const KEY = "dm.sspIntent";

// { mode: "edit" | "copy", patientId, recordId?, items?, fromDate? }
export function setSspIntent(x) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...x, at: Date.now() })); } catch { /* private mode */ }
}
export function takeSspIntent(patientId) {
  let x = null;
  try { x = JSON.parse(sessionStorage.getItem(KEY) || "null"); sessionStorage.removeItem(KEY); } catch { return null; }
  return x && x.patientId === patientId && Date.now() - Number(x.at || 0) < 10 * 60000 ? x : null;
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