// Inventory: suppliers, products, stock batches and the stock movement log (Firestore).
// Stock is kept as batches ("lots") per storage; each product also keeps a running total per storage.
// Every stock change updates the batch, the total and the activity log together, in one transaction.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, addDoc, updateDoc, query, where, orderBy, limit, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const INV_CATEGORIES = [
  { key: "retail", label: "Retail" },
  { key: "general", label: "General consumables" },
  { key: "injectable", label: "Injectables" },
  { key: "treatment", label: "Treatment consumables" },
];
export const LOCATIONS = [
  { key: "shelf", label: "Shelf" },
  { key: "jt", label: "JT storage" },
];
export const WRITEOFF_REASONS = ["Expired", "Damaged", "Lost", "Other"];
export const ADD_REASONS = ["Opening balance", "Found stock", "Returned to stock", "Other"];
export const MOVE_TYPES = {
  add: "Stock added", count: "Stock count", move: "Moved", writeoff: "Written off", receive: "Received", use: "Used",
};
export const EXPIRY_SOON_DAYS = 60;

export const catLabel = (k) => (INV_CATEGORIES.find((c) => c.key === k) || { label: "Other" }).label;
export const locLabel = (k) => (LOCATIONS.find((l) => l.key === k) || { label: k }).label;

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const intOrNull = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const moneyOrNull = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);

function uid() {
  const u = auth.currentUser && auth.currentUser.uid;
  if (!u) throw new Error("Your session has ended. Log in again.");
  return u;
}
function stamp(staff, created = false) {
  const name = String((staff && staff.name) || "").slice(0, 120);
  return {
    ...(created ? { createdAt: serverTimestamp(), createdBy: name, createdByUid: uid() } : {}),
    updatedAt: serverTimestamp(), updatedBy: name, updatedByUid: uid(),
  };
}

// "1 vial", "3 vials", "2 boxes"
export function unitPlural(unit) {
  const u = String(unit || "unit");
  return /(s|x|ch|sh)$/i.test(u) ? `${u}es` : `${u}s`;
}
export const plural = (n, unit) => `${n} ${Math.abs(n) === 1 ? String(unit || "unit") : unitPlural(unit)}`;

// "" (fine or no expiry), "soon" (within 60 days) or "expired"
export function expiryState(key) {
  if (!KEY_RE.test(key || "")) return "";
  const [y, m, d] = key.split("-").map(Number);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((Date.UTC(y, m - 1, d) - today) / 86400000);
  if (days < 0) return "expired";
  return days <= EXPIRY_SOON_DAYS ? "soon" : "";
}

/* ===================== Suppliers ===================== */

export function cleanSupplier(s = {}) {
  return {
    name: clip(s.name, 120),
    contactName: clip(s.contactName, 120),
    email: clip(s.email, 254),
    ccEmail: clip(s.ccEmail, 254),
    phone: clip(s.phone, 40),
    accountNo: clip(s.accountNo, 60),
    website: clip(s.website, 300),
    address: clip(s.address, 300),
    orderNotes: clip(s.orderNotes, 1000),
    active: s.active !== false,
  };
}

export async function listSuppliers() {
  const snap = await getDocs(collection(db, "inv_suppliers"));
  return snap.docs.map((d) => ({ id: d.id, ...cleanSupplier(d.data()) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
}

export async function saveSupplier(id, data, staff) {
  const clean = cleanSupplier(data);
  if (!clean.name) throw new Error("Give the supplier a name.");
  if (clean.email && !EMAIL_RE.test(clean.email)) throw new Error("Check the order email address.");
  if (clean.ccEmail && !EMAIL_RE.test(clean.ccEmail)) throw new Error("Check the CC email address.");
  if (clean.website && !/^https?:\/\//i.test(clean.website)) clean.website = `https://${clean.website}`;
  if (id) {
    await updateDoc(doc(db, "inv_suppliers", id), { ...clean, ...stamp(staff) });
    return id;
  }
  const ref = await addDoc(collection(db, "inv_suppliers"), { ...clean, ...stamp(staff, true) });
  return ref.id;
}

/* ===================== Products ===================== */

export function cleanProduct(p = {}) {
  const r = p.reorder || {};
  return {
    name: clip(p.name, 150),
    category: INV_CATEGORIES.some((c) => c.key === p.category) ? p.category : "general",
    brand: clip(p.brand, 80),
    supplierId: clip(p.supplierId, 60),
    supplierCode: clip(p.supplierCode, 60),
    barcode: clip(p.barcode, 60),
    stockUnit: clip(p.stockUnit, 30) || "unit",
    orderUnit: clip(p.orderUnit, 30) || "box",
    packSize: Math.max(1, intOrNull(p.packSize) || 1),
    cost: moneyOrNull(p.cost),
    price: moneyOrNull(p.price),
    tracked: p.tracked === true,
    reorder: { shelf: intOrNull(r.shelf), jt: intOrNull(r.jt) },
    notes: clip(p.notes, 1000),
    active: p.active !== false,
  };
}

function normaliseProduct(d) {
  const x = d.data() || {};
  const s = x.stock || {};
  return {
    id: d.id, ...cleanProduct(x),
    stock: { shelf: Number(s.shelf) || 0, jt: Number(s.jt) || 0 },
    updatedAt: toDate(x.updatedAt),
  };
}

export async function listProducts() {
  const snap = await getDocs(collection(db, "inv_products"));
  return snap.docs.map(normaliseProduct).sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
}

// Never changes stock: stock only changes through applyStock (so it's always logged)
export async function saveProduct(id, data, staff) {
  const clean = cleanProduct(data);
  if (!clean.name) throw new Error("Give the product a name.");
  if (id) {
    await updateDoc(doc(db, "inv_products", id), { ...clean, ...stamp(staff) });
    return id;
  }
  const ref = await addDoc(collection(db, "inv_products"), { ...clean, stock: { shelf: 0, jt: 0 }, ...stamp(staff, true) });
  return ref.id;
}

/* ===================== Batches (lots) ===================== */

const slug = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "_").slice(0, 40);

// One document per product + storage + batch + expiry (untracked products: one per storage)
export function lotId(productId, loc, batch, expiry) {
  return [productId, loc, slug(batch) || "-", KEY_RE.test(expiry || "") ? expiry : "-"].join("__");
}

function normaliseLot(d) {
  const x = d.data() || {};
  return {
    id: d.id, productId: String(x.productId || ""), loc: String(x.loc || "shelf"),
    batch: String(x.batch || ""), expiry: String(x.expiry || ""), qty: Number(x.qty) || 0,
  };
}

// Oldest expiry first (no expiry last), then Shelf before JT storage
export const fefo = (a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999") || a.loc.localeCompare(b.loc);

export async function listAllLots() {
  const snap = await getDocs(collection(db, "inv_lots"));
  return snap.docs.map(normaliseLot).filter((l) => l.qty > 0);
}

/* ===================== Activity ===================== */

export async function listMoves({ productId = "", max = 150 } = {}) {
  const col = collection(db, "inv_moves");
  const snap = await getDocs(productId
    ? query(col, where("productId", "==", productId))
    : query(col, orderBy("at", "desc"), limit(max)));
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, at: toDate(x.at) }; })
    .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0))
    .slice(0, max);
}

/* ===================== Changing stock ===================== */

// ops: [{ loc, batch, expiry, delta }], all applied together.
// type: add | count | move | writeoff (receive and use come in later phases)
export async function applyStock(product, { type, ops, reason = "", note = "" }, staff) {
  const byUid = uid();
  const lines = (ops || [])
    .map((o) => ({
      loc: LOCATIONS.some((l) => l.key === o.loc) ? o.loc : "shelf",
      batch: product.tracked ? clip(o.batch, 40) : "",
      expiry: product.tracked && KEY_RE.test(o.expiry || "") ? o.expiry : "",
      delta: Math.round(Number(o.delta)) || 0,
    }))
    .filter((l) => l.delta);
  if (!lines.length) throw new Error("Nothing has changed.");
  if (product.tracked && lines.some((l) => !l.batch || !l.expiry)) {
    throw new Error("This product needs a batch number and an expiry date.");
  }

  const pRef = doc(db, "inv_products", product.id);
  const refs = lines.map((l) => doc(db, "inv_lots", lotId(product.id, l.loc, l.batch, l.expiry)));

  await runTransaction(db, async (tx) => {
    // All reads first
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    const snaps = [];
    for (const r of refs) snaps.push(await tx.get(r));

    // Lines that hit the same batch are combined
    const byLot = new Map();
    lines.forEach((l, i) => {
      const cur = byLot.get(refs[i].id) || { ref: refs[i], snap: snaps[i], line: l, delta: 0 };
      cur.delta += l.delta;
      byLot.set(refs[i].id, cur);
    });

    const s = pSnap.data().stock || {};
    const stock = { shelf: Number(s.shelf) || 0, jt: Number(s.jt) || 0 };
    byLot.forEach(({ ref, snap, line, delta }) => {
      const have = snap.exists() ? Number(snap.data().qty) || 0 : 0;
      const next = have + delta;
      if (next < 0) {
        throw new Error(`Not enough in ${locLabel(line.loc)}${line.batch ? ` (batch ${line.batch})` : ""}: there ${
          have === 1 ? "is" : "are"} only ${plural(have, product.stockUnit)}.`);
      }
      stock[line.loc] = Math.max(0, stock[line.loc] + delta);
      tx.set(ref, {
        productId: product.id, loc: line.loc, batch: line.batch, expiry: line.expiry, qty: next,
        updatedAt: serverTimestamp(), ...(snap.exists() ? {} : { createdAt: serverTimestamp() }),
      }, { merge: true });
    });

    tx.update(pRef, { stock, stockAt: serverTimestamp() });
    tx.set(doc(collection(db, "inv_moves")), {
      type, productId: product.id, productName: product.name, unit: product.stockUnit,
      lines, reason: clip(reason, 60), note: clip(note, 500), ref: "",
      by: String((staff && staff.name) || "").slice(0, 120), byUid, at: serverTimestamp(),
    });
  });
}