// Product prescriptions the Scanner can match to. The names are kept in Firestore (rx_products/list) and grow as staff
// add names the scanner didn't know. A copy is kept on the device, so the list is ready straight away.
// "Fading Cream" is always on the list, and is used for compounds with HQ, kojic acid, ascorbic acid or dexamethasone.
import { db, auth } from "./firebase-config.js";
import { doc, onSnapshot, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

export const RX_PRODUCTS = ["Fading Cream"];   // always on the list

const CACHE_KEY = "dm.rxProducts";
const MAX = 500;
const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 150);
const readCache = () => { try { const v = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeCache = (v) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* private mode */ } };

// No duplicates: capitals, spaces and dots ignored ("Epiduo" = "EPIDUO" = "Epi-duo")
function mergeNames(...lists) {
  const out = [], seen = new Set();
  lists.flat().forEach((n) => {
    const s = clean(n), k = nameKey(s);
    if (!s || !k || seen.has(k)) return;
    seen.add(k);
    out.push(s);
  });
  return out;
}

let saved = readCache();
export const rxProductList = () => mergeNames(RX_PRODUCTS, saved);

// Kept up to date while signed in (a name added on one iPad is known on the others straight away)
const listRef = () => doc(db, "rx_products", "list");
let stopLive = null;
onAuthStateChanged(auth, (user) => {
  if (stopLive) { stopLive(); stopLive = null; }
  if (!user) return;
  stopLive = onSnapshot(listRef(), (snap) => {
    const names = snap.exists() && Array.isArray(snap.data().names) ? snap.data().names : [];
    saved = mergeNames(names);
    writeCache(saved);
  }, (err) => console.warn("The prescription list didn't load:", err));
});

// Adds names that aren't on the list yet. → the names actually added
export async function addRxProducts(names, staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const want = mergeNames(names).filter((n) => nameKey(n).length >= 2);
  if (!want.length) return [];
  let added = [];
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(listRef());
    const cur = snap.exists() && Array.isArray(snap.data().names) ? snap.data().names : [];
    const have = new Set([...RX_PRODUCTS, ...cur].map(nameKey));
    added = want.filter((n) => !have.has(nameKey(n)));
    if (!added.length) return;
    if (cur.length + added.length > MAX) throw new Error("The prescription list is full. Ask an Admin to tidy it.");
    tx.set(listRef(), {
      names: [...cur, ...added], updatedAt: serverTimestamp(),
      updatedBy: String((staff && staff.name) || "").slice(0, 120), updatedByUid: uid,
    });
  });
  if (added.length) { saved = mergeNames(saved, added); writeCache(saved); }
  return added;
}