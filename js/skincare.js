import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { parseDateKey } from "./utils.js";

// Must match docId_() in Apps Script
const toDocId = (s) => String(s || "").trim().replace(/\//g, "_");

export const normProduct = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Protocols + purchases for a patient (by Patient ID; rows without an ID by name)
export async function fetchSkincare(patient) {
  const ids = [...new Set([patient.pttId, patient.id].map(toDocId).filter(Boolean))];
  const nameKey = normProduct(patient.name); // same normalisation as the sync
  const nameDoc = nameKey ? toDocId(`name__${nameKey}`) : "";

  const keys = [...ids, nameDoc].filter(Boolean);
  const snaps = await Promise.all(keys.map((k) => getDoc(doc(db, "skincare", k))));

  const protocols = new Map();
  const purchases = [];
  let matchedByName = false;

  snaps.forEach((snap, i) => {
    if (!snap.exists()) return;
    const d = snap.data();
    if (keys[i] === nameDoc && ((d.protocols || []).length || (d.purchases || []).length)) matchedByName = true;

    (d.protocols || []).forEach((p) => {
      if (protocols.has(p.recordId)) protocols.get(p.recordId).items.push(...(p.items || []));
      else protocols.set(p.recordId, { ...p, items: [...(p.items || [])] });
    });
    purchases.push(...(d.purchases || []));
  });

  return {
    protocols: [...protocols.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))),
    purchases: purchases.sort((a, b) => String(b.date).localeCompare(String(a.date))),
    matchedByName,
  };
}

// product -> most recent purchase date ("yyyy-mm-dd")
export function lastPurchaseMap(purchases) {
  const map = new Map();
  purchases.forEach((p) => {
    const key = normProduct(p.product);
    if (p.date && (!map.has(key) || p.date > map.get(key))) map.set(key, p.date);
  });
  return map;
}

// Whole months between a date and today
export function monthsSince(dateKey, today = new Date()) {
  const d = parseDateKey(dateKey);
  if (!d) return null;
  let m = (today.getFullYear() - d.getFullYear()) * 12 + (today.getMonth() - d.getMonth());
  if (today.getDate() < d.getDate()) m--;
  return m;
}

// green: within 6 months | yellow: over 6 | red: over 12 | none: never purchased
export function purchaseStatus(dateKey) {
  const m = monthsSince(dateKey);
  if (m === null) return "none";
  if (m > 12) return "red";
  if (m > 6) return "yellow";
  return "green";
}