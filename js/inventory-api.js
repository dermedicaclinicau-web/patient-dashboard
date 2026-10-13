// Inventory: suppliers, products, stock batches and the stock movement log (Firestore).
// Stock is kept as batches ("lots") per storage; each product also keeps a running total per storage.
// Every stock change updates the batch, the total and the activity log together, in one transaction.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, getDoc, addDoc, setDoc, updateDoc, query, where, orderBy, limit, runTransaction,
  serverTimestamp, arrayUnion, arrayRemove, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { pingNotify, queueNotify } from "./notify-api.js";

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
  "kit-take": "Taken into kit", "kit-open": "Vial opened", "kit-return": "Returned from kit",
  "kit-discard": "Discarded from kit", "kit-use": "Used in treatment", release: "Released from JT storage",
  "kit-borrow": "Borrowed from a colleague", "kit-count": "Kit count adjusted",
  "use-correct": "Usage corrected", "kit-correct": "Kit usage corrected",
  investigation: "Investigation closed",  "shared-open": "Opened for sharing", "shared-finish": "Opened one finished",
  baseline: "Starting stock set",  
};
export const EXPIRY_SOON_DAYS = 60;

export const catLabel = (k) => (INV_CATEGORIES.find((c) => c.key === k) || { label: "Other" }).label;
export const locLabel = (k) => (k === "kit" ? "Kit" : (LOCATIONS.find((l) => l.key === k) || { label: k }).label);

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
const toDate = (v) => {
  if (v && typeof v.toDate === "function") return v.toDate();
  if (typeof v === "string" && v) { const d = new Date(v); return isNaN(d) ? null : d; }
  return null;
};

// One event for Notifications, written in the same transaction as the change that caused it
const outboxDoc = (event, data, byUid) => ({ event, data, status: "new", createdAt: serverTimestamp(), createdByUid: byUid });

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

// Dose in each counted item (e.g. 100 units in a vial of Xeomin), or null
const dosePerOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

// "3 vials (300 units)"
export function qtyText(p, n) {
  const dose = p.dosePer && p.doseUnit ? ` (${+(n * p.dosePer).toFixed(2)} ${p.doseUnit})` : "";
  return `${plural(n, p.stockUnit)}${dose}`;
}

// How it's ordered: "Ordered by the vial, 100 units each" or "Box of 5 vials, 100 units each"
export function packText(p) {
  const dose = p.dosePer && p.doseUnit ? `, ${p.dosePer} ${p.doseUnit} each` : "";
  const same = p.packSize === 1 && String(p.orderUnit).toLowerCase() === String(p.stockUnit).toLowerCase();
  const pack = same ? `Ordered by the ${p.stockUnit}` : `${p.orderUnit} of ${plural(p.packSize, p.stockUnit)}`;
  return pack.charAt(0).toUpperCase() + pack.slice(1) + dose;
}

// What the packaging calls a batch: "Batch", "Lot", "LOT"…
export const batchName = (p) => (p && p.batchLabel) || "Batch";
export const batchText = (p, batch) => (batch ? `${batchName(p)} ${batch}` : "");

// Every supplier a product can be ordered from, main first, each with its own code, price and pack
export function productSuppliers(p) {
  if (!p) return [];
  const main = p.supplierId ? [{
    supplierId: p.supplierId, supplierCode: p.supplierCode || "", cost: p.cost ?? null,
    orderUnit: p.orderUnit, packSize: p.packSize, main: true,
  }] : [];
  return main.concat((p.altSuppliers || []).map((a) => ({
    supplierId: a.supplierId, supplierCode: a.supplierCode || "", cost: a.cost ?? null,
    orderUnit: a.orderUnit || p.orderUnit, packSize: a.packSize || p.packSize, main: false,
  })));
}
export const supplierTerms = (p, sid) => productSuppliers(p).find((s) => s.supplierId === sid) || null;
export const suppliesProduct = (p, sid) => !!sid && !!supplierTerms(p, sid);

// Suggested order to bring a storage up to about twice its reorder level, in one supplier's units
export function suggestOrderFor(p, loc, sid) {
  const t = supplierTerms(p, sid);
  const r = Number(p.reorder[loc]) || 0;
  const need = Math.max(1, Math.max(r * 2, r + 1) - (Number(p.stock[loc]) || 0));
  return Math.max(1, Math.ceil(need / Math.max(1, (t && t.packSize) || p.packSize)));
}

// Other suppliers a product can be ordered from. Their own code, price and pack are optional
// (blank = the same as the main supplier). The main supplier is never repeated here.
function cleanAltSuppliers(list, mainId) {
  const seen = new Set([mainId]);
  return (Array.isArray(list) ? list : []).map((a) => {
    const pack = intOrNull(a && a.packSize);
    return {
      supplierId: clip(a && a.supplierId, 60),
      supplierCode: clip(a && a.supplierCode, 60),
      cost: moneyOrNull(a && a.cost),
      orderUnit: clip(a && a.orderUnit, 30),
      packSize: pack && pack >= 1 ? pack : null,
    };
  }).filter((a) => a.supplierId && !seen.has(a.supplierId) && seen.add(a.supplierId)).slice(0, 10);
}

export function cleanProduct(p = {}) {
  const r = p.reorder || {};
  const dosePer = dosePerOf(p.dosePer);
  return {
    name: clip(p.name, 150),
    category: INV_CATEGORIES.some((c) => c.key === p.category) ? p.category : "general",
    brand: clip(p.brand, 80),
    supplierId: clip(p.supplierId, 60),
    supplierCode: clip(p.supplierCode, 60),
    altSuppliers: cleanAltSuppliers(p.altSuppliers, clip(p.supplierId, 60)),
    barcode: clip(p.barcode, 60),
    stockUnit: clip(p.stockUnit, 30) || "item",
    orderUnit: clip(p.orderUnit, 30) || "box",
    dosePer,
    doseUnit: dosePer ? (clip(p.doseUnit, 20) || "units") : "",
    usage: ["kit", "shared"].includes(p.usage) ? p.usage : "storage",
    perUse: p.usage === "shared" ? dosePerOf(p.perUse) : null,
    openDays: p.usage === "shared" && intOrNull(p.openDays) ? Math.min(3650, intOrNull(p.openDays)) : null,    
    packSize: Math.max(1, intOrNull(p.packSize) || 1),
    cost: moneyOrNull(p.cost),
    price: moneyOrNull(p.price),
    tracked: p.tracked === true,
    batchLabel: clip(p.batchLabel, 20) || "Batch",
    countFreq: ["daily", "weekly", "monthly"].includes(p.countFreq) ? p.countFreq : "never",
    countDay: p.countFreq === "weekly" ? Math.min(6, Math.max(0, parseInt(p.countDay, 10) || 0))
      : p.countFreq === "monthly" ? (p.countDay === "last" ? "last" : Math.min(28, Math.max(1, parseInt(p.countDay, 10) || 1)))
      : null,
    countWhere: ["shelf", "jt"].includes(p.countWhere) ? p.countWhere : "both",
    investigate: ["always", "over", "never"].includes(p.investigate) ? p.investigate : "",
    investigateOver: moneyOrNull(p.investigateOver),
    reorder: { shelf: intOrNull(r.shelf), jt: intOrNull(r.jt) },
    notes: clip(p.notes, 1000),
    shelfPos: clip(p.shelfPos, 30),
    jtPos: clip(p.jtPos, 30),
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
  if (clean.usage === "kit" && !clean.dosePer) {
    throw new Error(`Fill in how much is in each ${clean.stockUnit}, e.g. 100 units in each vial. Kit products are used per unit across patients.`);
  }
  if (clean.usage === "shared" && clean.perUse && !clean.dosePer) {
    throw new Error(`Fill in how much is in each ${clean.stockUnit} (e.g. 10 mL), so the amount per use makes sense.`);
  }
  if (clean.usage === "shared" && clean.perUse && clean.dosePer && clean.perUse > clean.dosePer) {
    throw new Error(`The amount per use is more than a whole ${clean.stockUnit} holds.`);
  }
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
    throw new Error(`This product needs a ${batchName(product).toLowerCase()} number and an expiry date.`);
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
        throw new Error(`Not enough in ${locLabel(line.loc)}${line.batch ? ` (${batchText(product, line.batch)})` : ""}: there ${
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

/* ===================== Order requests ===================== */

export const REQ_STATUS = { open: "Open", ordered: "Ordered", received: "Received", declined: "Declined", cancelled: "Cancelled" };
export const reqNumber = (r) => `R-${String((r && r.id) || "").slice(0, 6).toUpperCase()}`;
export const myUid = () => (auth.currentUser && auth.currentUser.uid) || "";

// Low = at or below the reorder level for that storage
export const lowAt = (p, loc) => p.reorder[loc] !== null && p.reorder[loc] !== undefined && p.stock[loc] <= p.reorder[loc];

// Order units to bring a storage up to about twice its reorder level
export function suggestOrder(p, loc) {
  const r = Number(p.reorder[loc]) || 0;
  const need = Math.max(1, Math.max(r * 2, r + 1) - (Number(p.stock[loc]) || 0));
  return Math.max(1, Math.ceil(need / Math.max(1, p.packSize)));
}

function normaliseRequest(d) {
  const x = d.data() || {};
  return {
    id: d.id, ...x,
    items: Array.isArray(x.items) ? x.items : [],
    events: Array.isArray(x.events) ? x.events : [],
    poIds: Array.isArray(x.poIds) ? x.poIds : [],
    status: REQ_STATUS[x.status] ? x.status : "open",
    loc: LOCATIONS.some((l) => l.key === x.loc) ? x.loc : "shelf",
    createdAt: toDate(x.createdAt),
    handledAt: toDate(x.handledAt),
  };
}

export async function createRequest({ items, loc, urgency, note }, staff) {
  const clean = (Array.isArray(items) ? items : []).map((it) => ({
    productId: clip(it.productId, 60),
    name: clip(it.name, 150),
    supplierId: clip(it.supplierId, 60),
    qty: Math.min(999, Math.max(1, parseInt(it.qty, 10) || 1)),
    unitKind: it.unitKind === "stock" ? "stock" : "order",
    unit: clip(it.unit, 30) || "unit",
    stockQty: Math.max(0, parseInt(it.stockQty, 10) || 0),
  })).filter((it) => it.name).slice(0, 30);
  if (!clean.length) throw new Error("Add at least one item.");
  const by = String((staff && staff.name) || "").slice(0, 120);
  const ref = await addDoc(collection(db, "inv_requests"), {
    items: clean,
    loc: LOCATIONS.some((l) => l.key === loc) ? loc : "shelf",
    urgency: urgency === "urgent" ? "urgent" : "normal",
    note: clip(note, 1000),
    status: "open",
    requestedBy: by,
    requestedByUid: uid(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    events: [{ at: new Date().toISOString(), by, action: "Requested", note: "" }],
  });
  return ref.id;
}

// mine: only this person's requests. Otherwise the most recent requests from everyone.
export async function listRequests({ mine = false, max = 300 } = {}) {
  const col = collection(db, "inv_requests");
  const snap = await getDocs(mine
    ? query(col, where("requestedByUid", "==", uid()))
    : query(col, orderBy("createdAt", "desc"), limit(max)));
  return snap.docs.map(normaliseRequest)
    .sort((a, b) => (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0));
}

// The ordering team: "ordered" or "declined"
export async function setRequestStatus(id, status, note, staff) {
  if (!["ordered", "declined"].includes(status)) throw new Error("Unknown status.");
  const by = String((staff && staff.name) || "").slice(0, 120);
  await updateDoc(doc(db, "inv_requests", id), {
    status, response: clip(note, 1000),
    handledBy: by, handledByUid: uid(), handledAt: serverTimestamp(), updatedAt: serverTimestamp(),
    events: arrayUnion({ at: new Date().toISOString(), by, action: REQ_STATUS[status], note: clip(note, 1000) }),
  });
}

// The person who asked, while it's still open
export async function cancelRequest(id, staff) {
  const by = String((staff && staff.name) || "").slice(0, 120);
  await updateDoc(doc(db, "inv_requests", id), {
    status: "cancelled", updatedAt: serverTimestamp(),
    events: arrayUnion({ at: new Date().toISOString(), by, action: "Cancelled", note: "" }),
  });
}

// Who is emailed about new requests
export async function getRequestSettings() {
  const snap = await getDoc(doc(db, "inv_settings", "requests"));
  const d = snap.exists() ? snap.data() : {};
  return { notifyIds: Array.isArray(d.notifyIds) ? d.notifyIds.map(String) : [], urgentOnly: d.urgentOnly === true };
}
export async function saveRequestSettings({ notifyIds, urgentOnly }, staff) {
  await setDoc(doc(db, "inv_settings", "requests"), {
    notifyIds: (Array.isArray(notifyIds) ? notifyIds : []).map(String).slice(0, 30),
    urgentOnly: urgentOnly === true,
    ...stamp(staff),
  });
}

/* ===================== Purchase orders ===================== */

export const PO_STATUS = { draft: "Draft", sent: "Sent", part: "Part received", received: "Received", cancelled: "Cancelled" };
const PO_LIVE = ["sent", "part", "received"];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function supplierSnapshot(s = {}) {
  return {
    name: clip(s.name, 120), contactName: clip(s.contactName, 120), email: clip(s.email, 254), ccEmail: clip(s.ccEmail, 254),
    phone: clip(s.phone, 40), accountNo: clip(s.accountNo, 60), address: clip(s.address, 300),
  };
}

// One line on a PO. qty is in the supplier's order units. sources = the request items it covers.
export function cleanPoLine(l = {}) {
  return {
    key: clip(l.key, 40) || Math.random().toString(36).slice(2, 10),
    productId: clip(l.productId, 60),
    name: clip(l.name, 150),
    supplierCode: clip(l.supplierCode, 60),
    qty: Math.min(9999, Math.max(1, parseInt(l.qty, 10) || 1)),
    orderUnit: clip(l.orderUnit, 30) || "unit",
    packSize: Math.max(1, parseInt(l.packSize, 10) || 1),
    stockUnit: clip(l.stockUnit, 30) || "unit",
    dosePer: dosePerOf(l.dosePer),
    doseUnit: dosePerOf(l.dosePer) ? (clip(l.doseUnit, 20) || "units") : "",
    unitCost: moneyOrNull(l.unitCost),
    loc: LOCATIONS.some((x) => x.key === l.loc) ? l.loc : "shelf",
    received: Math.max(0, parseInt(l.received, 10) || 0),
    sources: (Array.isArray(l.sources) ? l.sources : [])
      .map((s) => ({ r: clip(s && s.r, 40), i: Math.max(0, parseInt(s && s.i, 10) || 0) }))
      .filter((s) => s.r).slice(0, 30),
  };
}

// A PO line for a product, using the chosen supplier's code, price and pack (the main supplier's if none is given)
export function lineFromProduct(p, qty, loc, sources = [], supplierId = "") {
  const t = supplierTerms(p, supplierId || p.supplierId) || {};
  return cleanPoLine({
    productId: p.id, name: p.name, supplierCode: t.supplierCode ?? p.supplierCode, qty,
    orderUnit: t.orderUnit || p.orderUnit, packSize: t.packSize || p.packSize, stockUnit: p.stockUnit,
    dosePer: p.dosePer, doseUnit: p.doseUnit, unitCost: t.cost !== undefined ? t.cost : p.cost, loc, sources,
  });
}

export function poTotals(po) {
  const lines = (po && po.lines) || [];
  const subtotal = round2(lines.reduce((s, l) => s + (l.unitCost || 0) * (l.qty || 0), 0));
  const gst = po && po.gst ? round2(subtotal * 0.1) : 0;
  return { subtotal, gst, total: round2(subtotal + gst), missing: lines.some((l) => l.unitCost === null || l.unitCost === undefined) };
}

function normalisePo(d) {
  const x = d.data() || {};
  return {
    id: d.id,
    number: String(x.number || ""),
    supplierId: String(x.supplierId || ""),
    supplier: supplierSnapshot(x.supplier || {}),
    status: PO_STATUS[x.status] ? x.status : "draft",
    lines: (Array.isArray(x.lines) ? x.lines : []).map(cleanPoLine),
    requestIds: Array.isArray(x.requestIds) ? x.requestIds : [],
    expectedDate: String(x.expectedDate || ""),
    notesToSupplier: String(x.notesToSupplier || ""),
    internalNote: String(x.internalNote || ""),
    gst: x.gst === true,
    createdBy: String(x.createdBy || ""),
    sentBy: String(x.sentBy || ""),
    sentVia: String(x.sentVia || ""),
    sentTo: String(x.sentTo || ""),
    cancelReason: String(x.cancelReason || ""),
    events: Array.isArray(x.events) ? x.events : [],
    createdAt: toDate(x.createdAt),
    sentAt: toDate(x.sentAt),
    updatedAt: toDate(x.updatedAt),
  };
}

export async function listPos() {
  const snap = await getDocs(collection(db, "inv_pos"));
  return snap.docs.map(normalisePo)
    .sort((a, b) => (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0));
}

export async function getPo(id) {
  const snap = await getDoc(doc(db, "inv_pos", id));
  return snap.exists() ? normalisePo(snap) : null;
}

// The PO (not cancelled; optionally only certain statuses) that covers one item of a request
export function itemOnPo(requestId, index, pos, statuses = null) {
  return (pos || []).find((po) => po.status !== "cancelled" && (!statuses || statuses.includes(po.status))
    && po.lines.some((l) => l.sources.some((s) => s.r === requestId && s.i === index))) || null;
}
// Every item of the request is on a sent (or received) PO
export const requestFullyOrdered = (r, pos) => r.items.length > 0 && r.items.every((_, i) => !!itemOnPo(r.id, i, pos, PO_LIVE));

// A new draft PO with the next number. The requests it covers are linked to it.
export async function createPo({ supplier, lines = [] }, staff) {
  if (!supplier || !supplier.id) throw new Error("Choose a supplier.");
  const clean = lines.map(cleanPoLine);
  const requestIds = [...new Set(clean.flatMap((l) => l.sources.map((s) => s.r)))].slice(0, 50);
  const by = String((staff && staff.name) || "").slice(0, 120);
  const byUid = uid();
  const at = new Date().toISOString();
  const cRef = doc(db, "inv_settings", "counters");
  const poRef = doc(collection(db, "inv_pos"));
  await runTransaction(db, async (tx) => {
    const c = await tx.get(cRef);
    const n = (c.exists() ? Number(c.data().po) || 0 : 0) + 1;
    const number = `PO-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`;
    tx.set(cRef, { po: n });
    tx.set(poRef, {
      number, supplierId: supplier.id, supplier: supplierSnapshot(supplier), status: "draft",
      lines: clean, requestIds, expectedDate: "", notesToSupplier: "", internalNote: "", gst: false,
      total: poTotals({ lines: clean }).total,
      createdBy: by, createdByUid: byUid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: by,
      events: [{ at, by, action: "Created", note: requestIds.length ? `From ${requestIds.length} request${requestIds.length === 1 ? "" : "s"}` : "" }],
    });
    requestIds.forEach((rid) => tx.update(doc(db, "inv_requests", rid), {
      poIds: arrayUnion(poRef.id), poNumbers: arrayUnion(number), updatedAt: serverTimestamp(),
      events: arrayUnion({ at, by, action: "Added to purchase order", note: number }),
    }));
  });
  return poRef.id;
}

// A draft's editable parts (empty rows are dropped)
export async function savePo(id, po, staff) {
  const lines = (po.lines || []).filter((l) => l.productId || String(l.name || "").trim()).map(cleanPoLine);
  await updateDoc(doc(db, "inv_pos", id), {
    supplierId: clip(po.supplierId, 60),
    supplier: supplierSnapshot(po.supplier || {}),
    lines,
    expectedDate: KEY_RE.test(po.expectedDate || "") ? po.expectedDate : "",
    notesToSupplier: clip(po.notesToSupplier, 2000),
    internalNote: clip(po.internalNote, 1000),
    gst: po.gst === true,
    total: poTotals({ lines, gst: po.gst === true }).total,
    ...stamp(staff),
  });
}

// Ordered another way (phone, website). Returns the request ids that became "Ordered".
export async function markPoSent(po, { via = "", note = "" }, staff) {
  const by = String((staff && staff.name) || "").slice(0, 120);
  const at = new Date().toISOString();
  const all = (await listPos()).map((x) => (x.id === po.id ? { ...x, status: "sent" } : x));
  const reqSnaps = await Promise.all(po.requestIds.map((rid) => getDoc(doc(db, "inv_requests", rid))));
  const batch = writeBatch(db);
  batch.update(doc(db, "inv_pos", po.id), {
    status: "sent", sentAt: serverTimestamp(), sentBy: by, sentVia: clip(via, 40), updatedAt: serverTimestamp(), updatedBy: by,
    events: arrayUnion({ at, by, action: "Marked as sent", note: [via, note].filter(Boolean).join(" · ").slice(0, 300) }),
  });
  const done = [];
  reqSnaps.forEach((s) => {
    if (!s.exists()) return;
    const r = normaliseRequest(s);
    if (r.status !== "open" || !requestFullyOrdered(r, all)) return;
    batch.update(s.ref, {
      status: "ordered", response: `On purchase order ${po.number}`, handledBy: by, handledByUid: uid(),
      handledAt: serverTimestamp(), updatedAt: serverTimestamp(),
      events: arrayUnion({ at, by, action: "Ordered", note: `Purchase order ${po.number}` }),
    });
    done.push(r.id);
  });
  await batch.commit();
  return done;
}

// Cancel a draft, or a sent order where nothing has arrived. Its requests go back to Open.
export async function cancelPo(po, reason, staff) {
  if (po.lines.some((l) => l.received > 0)) throw new Error("Stock has already been received on this order, so it can't be cancelled.");
  const by = String((staff && staff.name) || "").slice(0, 120);
  const at = new Date().toISOString();
  const reqSnaps = await Promise.all(po.requestIds.map((rid) => getDoc(doc(db, "inv_requests", rid))));
  const batch = writeBatch(db);
  batch.update(doc(db, "inv_pos", po.id), {
    status: "cancelled", cancelReason: clip(reason, 500), updatedAt: serverTimestamp(), updatedBy: by,
    events: arrayUnion({ at, by, action: "Cancelled", note: clip(reason, 300) }),
  });
  reqSnaps.forEach((s) => {
    if (!s.exists()) return;
    const was = s.data().status;
    batch.update(s.ref, {
      poIds: arrayRemove(po.id), poNumbers: arrayRemove(po.number), updatedAt: serverTimestamp(),
      ...(was === "ordered" ? { status: "open", response: "" } : {}),
      events: arrayUnion({ at, by, action: "Purchase order cancelled", note: po.number }),
    });
  });
  await batch.commit();
}

/* ===================== Receiving deliveries ===================== */

// Shrink a photo before upload (iPad photos are 3–5 MB). PDFs, and anything the browser can't decode, go up as they are.
async function shrinkImage(file, max = 2000, quality = 0.82) {
  if (!/^image\//.test(file.type)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), "image/jpeg", quality));
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadDocket(poId, file) {
  if (!file) return null;
  if (file.size > 25 * 1024 * 1024) throw new Error("That file is too big. Take a photo instead.");
  const blob = await shrinkImage(file);
  const type = blob.type || file.type || "image/jpeg";
  const isPdf = type === "application/pdf";
  const ext = isPdf ? "pdf" : type === "image/png" ? "png" : "jpg";
  const path = `inv_dockets/${poId}/${Date.now()}.${ext}`;
  const r = sRef(getStorage(), path);
  await uploadBytes(r, blob, { contentType: type });
  return { path, url: await getDownloadURL(r), type: isPdf ? "pdf" : "image" };
}

export async function listReceipts(poId) {
  const snap = await getDocs(query(collection(db, "inv_receipts"), where("poId", "==", poId)));
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, at: toDate(x.at) }; })
    .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
}

// receipt = { docketNo, note, docket: {path,url,type} | null, close,
//   lines: [{ key, arrived (supplier's order units), splits: [{ loc, batch, expiry, qty (stock units) }] }] }
// One transaction: batches, product totals, activity log, PO lines + status, and the delivery record.
export async function receivePo(poId, receipt, staff) {
  const byUid = uid();
  const by = String((staff && staff.name) || "").slice(0, 120);
  const at = new Date().toISOString();
  const poRef = doc(db, "inv_pos", poId);
  const recRef = doc(collection(db, "inv_receipts"));
  const docketNo = clip(receipt.docketNo, 60);
  const docket = receipt.docket && receipt.docket.url
    ? { path: clip(receipt.docket.path, 300), url: String(receipt.docket.url).slice(0, 2000), type: receipt.docket.type === "pdf" ? "pdf" : "image" }
    : null;
  let result = null;

  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const poSnap = await tx.get(poRef);
    if (!poSnap.exists()) throw new Error("This purchase order no longer exists.");
    const po = normalisePo(poSnap);
    if (!["sent", "part"].includes(po.status)) {
      throw new Error(`This order is ${PO_STATUS[po.status].toLowerCase()}, so stock can't be received on it.`);
    }

    const work = [];
    for (const r of receipt.lines || []) {
      const line = po.lines.find((l) => l.key === r.key);
      if (!line) throw new Error("This order has been changed by someone else. Reload and try again.");
      const arrived = Math.min(9999, Math.max(0, parseInt(r.arrived, 10) || 0));
      if (!arrived) continue;
      const splits = (Array.isArray(r.splits) ? r.splits : [])
        .map((s) => ({
          loc: LOCATIONS.some((x) => x.key === s.loc) ? s.loc : line.loc,
          batch: clip(s.batch, 40),
          expiry: KEY_RE.test(s.expiry || "") ? s.expiry : "",
          qty: Math.max(0, parseInt(s.qty, 10) || 0),
        }))
        .filter((s) => s.qty);
      if (line.productId) {
        const need = arrived * line.packSize;
        const put = splits.reduce((a, s) => a + s.qty, 0);
        if (put !== need) throw new Error(`${line.name}: ${plural(need, line.stockUnit)} arrived but ${put} have been put away.`);
      }
      work.push({ line, arrived, splits });
    }
    if (!work.length && !receipt.close) throw new Error("Enter what arrived.");

    const pids = [...new Set(work.filter((w) => w.line.productId).map((w) => w.line.productId))];
    const prod = new Map();
    for (const id of pids) {
      const s = await tx.get(doc(db, "inv_products", id));
      if (!s.exists()) throw new Error("A product on this order no longer exists.");
      prod.set(id, normaliseProduct(s));
    }
    work.forEach((w) => {
      const p = prod.get(w.line.productId);
      if (!p) { w.splits = []; return; }                       // free-text line: ticked off, no stock
      w.splits = w.splits.map((s) => ({ ...s, batch: p.tracked ? s.batch : "", expiry: p.tracked ? s.expiry : "" }));
      if (p.tracked && w.splits.some((s) => !s.batch || !s.expiry)) {
        throw new Error(`${p.name} needs a ${batchName(p).toLowerCase()} number and expiry date.`);
      }
    });

    const lots = new Map();
    for (const w of work) {
      for (const s of w.splits) {
        const id = lotId(w.line.productId, s.loc, s.batch, s.expiry);
        if (!lots.has(id)) {
          const ref = doc(db, "inv_lots", id);
          const snap = await tx.get(ref);
          lots.set(id, {
            ref, exists: snap.exists(), have: snap.exists() ? Number(snap.data().qty) || 0 : 0,
            productId: w.line.productId, loc: s.loc, batch: s.batch, expiry: s.expiry, delta: 0,
          });
        }
        lots.get(id).delta += s.qty;
      }
    }

    // ---- Writes ----
    lots.forEach((l) => tx.set(l.ref, {
      productId: l.productId, loc: l.loc, batch: l.batch, expiry: l.expiry, qty: l.have + l.delta,
      updatedAt: serverTimestamp(), ...(l.exists ? {} : { createdAt: serverTimestamp() }),
    }, { merge: true }));

    prod.forEach((p, id) => {
      const stock = { ...p.stock };
      work.filter((w) => w.line.productId === id).forEach((w) => w.splits.forEach((s) => { stock[s.loc] += s.qty; }));
      tx.update(doc(db, "inv_products", id), { stock, stockAt: serverTimestamp() });
    });

    work.forEach((w) => {
      const p = prod.get(w.line.productId);
      if (!p || !w.splits.length) return;
      tx.set(doc(collection(db, "inv_moves")), {
        type: "receive", productId: p.id, productName: p.name, unit: p.stockUnit,
        lines: w.splits.map((s) => ({ loc: s.loc, batch: s.batch, expiry: s.expiry, delta: s.qty })),
        reason: "Delivery", note: docketNo ? `Docket ${docketNo}` : "", ref: po.number, poId,
        by, byUid, at: serverTimestamp(),
      });
    });

    const lines = po.lines.map((l) => {
      const w = work.find((x) => x.line.key === l.key);
      return w ? { ...l, received: l.received + w.arrived } : l;
    });
    const allIn = lines.every((l) => l.received >= l.qty);
    const status = allIn || receipt.close ? "received" : "part";
    const summary = work.map((w) => `${w.arrived} × ${w.line.name}`).join(", ");
    tx.update(poRef, {
      lines, status, receiptIds: arrayUnion(recRef.id),
      lastReceivedAt: serverTimestamp(), ...(status === "received" ? { receivedAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp(), updatedBy: by,
      events: arrayUnion({
        at, by,
        action: status === "part" ? "Part received" : allIn ? "Received" : "Closed short",
        note: [docketNo && `Docket ${docketNo}`, summary].filter(Boolean).join(" · ").slice(0, 300),
      }),
    });

    tx.set(recRef, {
      poId, poNumber: po.number, supplierId: po.supplierId, supplierName: po.supplier.name,
      docketNo, note: clip(receipt.note, 1000), docket, closed: !!receipt.close && !allIn,
      lines: work.map((w) => ({
        key: w.line.key, productId: w.line.productId, name: w.line.name, arrived: w.arrived,
        orderUnit: w.line.orderUnit, packSize: w.line.packSize, stockUnit: w.line.stockUnit, splits: w.splits,
      })),
      by, byUid, at: serverTimestamp(),
    });

    tx.set(doc(collection(db, "notify_outbox")), outboxDoc("stock.arrived", { receiptId: recRef.id, poId }, byUid));
    result = { status, number: po.number, requestIds: po.requestIds };
  });
  pingNotify();
  return result;
}

// After a delivery: requests whose every item has fully arrived become "Received"
export async function syncReceivedRequests(requestIds, staff) {
  const ids = [...new Set(requestIds || [])];
  if (!ids.length) return [];
  const [pos, snaps] = await Promise.all([
    listPos(),
    Promise.all(ids.map((id) => getDoc(doc(db, "inv_requests", id)))),
  ]);
  const arrived = (rid, i) => pos.some((po) => po.status !== "cancelled"
    && po.lines.some((l) => l.received >= l.qty && l.sources.some((s) => s.r === rid && s.i === i)));
  const by = String((staff && staff.name) || "").slice(0, 120);
  const at = new Date().toISOString();
  const batch = writeBatch(db);
  const done = [];
  snaps.forEach((s) => {
    if (!s.exists()) return;
    const r = normaliseRequest(s);
    if (!["open", "ordered"].includes(r.status)) return;
    if (!r.items.length || !r.items.every((_, i) => arrived(r.id, i))) return;
    batch.update(s.ref, {
      status: "received", updatedAt: serverTimestamp(),
      events: arrayUnion({ at, by, action: "Received", note: "Stock has arrived" }),
    });
    done.push(r.id);
  });
  if (done.length) await batch.commit();
  return done;
}

/* ===================== Injector kits (e.g. Xeomin) ===================== */
// The Shelf and JT storage count whole vials. Each injector's kit holds, per batch,
// unopened vials ("sealed") plus the units left in their opened vial ("open").

export const isKitProduct = (p) => !!p && p.usage === "kit" && !!p.dosePer;
export const kitUnits = (k) => (k.sealed || 0) * (k.dosePer || 0) + (k.open || 0);
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const who = (staff) => String((staff && staff.name) || "").slice(0, 120);

export function kitId(staffUid, productId, batch, expiry) {
  return [staffUid, productId, slug(batch) || "-", KEY_RE.test(expiry || "") ? expiry : "-"].join("__");
}

function logMove(tx, staff, data) {
  tx.set(doc(collection(db, "inv_moves")), {
    reason: "", note: "", ref: "", lines: [], ...data, by: who(staff), byUid: uid(), at: serverTimestamp(),
  });
}

function normaliseKit(d) {
  const x = d.data() || {};
  return {
    id: d.id, staffUid: String(x.staffUid || ""), staffName: String(x.staffName || ""),
    productId: String(x.productId || ""), productName: String(x.productName || ""),
    batch: String(x.batch || ""), expiry: String(x.expiry || ""),
    dosePer: Number(x.dosePer) || 0, doseUnit: String(x.doseUnit || "units"),
    sealed: Math.max(0, parseInt(x.sealed, 10) || 0), open: Math.max(0, round1(x.open)),
    updatedAt: toDate(x.updatedAt),
  };
}

// mine: only my kit. Otherwise everyone's (for Admin and JT approvers).
export async function listKits({ mine = false } = {}) {
  const col = collection(db, "inv_kits");
  const snap = await getDocs(mine ? query(col, where("staffUid", "==", uid())) : col);
  return snap.docs.map(normaliseKit)
    .filter((k) => k.sealed > 0 || k.open > 0)
    .sort((a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999"));
}

export async function listMyKitMoves(max = 30) {
  const snap = await getDocs(query(collection(db, "inv_moves"), where("byUid", "==", uid())));
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, at: toDate(x.at) }; })
    .filter((m) => /^kit-/.test(m.type) || m.type === "release")
    .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0))
    .slice(0, max);
}

// Unopened vials from one Shelf batch into my kit
export async function kitTake(product, lot, vials, staff) {
  const n = Math.max(1, parseInt(vials, 10) || 0);
  if (!isKitProduct(product)) throw new Error("This product isn't carried in kits.");
  if (!lot || lot.loc !== "shelf") throw new Error("Choose a batch on the Shelf.");
  const me = uid();
  const pRef = doc(db, "inv_products", product.id);
  const lRef = doc(db, "inv_lots", lot.id);
  const kRef = doc(db, "inv_kits", kitId(me, product.id, lot.batch, lot.expiry));
  await runTransaction(db, async (tx) => {
    const pSnap = await tx.get(pRef);
    const lSnap = await tx.get(lRef);
    const kSnap = await tx.get(kRef);
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    const have = lSnap.exists() ? Number(lSnap.data().qty) || 0 : 0;
    if (have < n) throw new Error(`There ${have === 1 ? "is" : "are"} only ${plural(have, product.stockUnit)} of that batch on the Shelf.`);
    const s = pSnap.data().stock || {};
    const k = kSnap.exists() ? kSnap.data() : null;
    tx.update(lRef, { qty: have - n, updatedAt: serverTimestamp() });
    tx.update(pRef, { stock: { shelf: Math.max(0, (Number(s.shelf) || 0) - n), jt: Number(s.jt) || 0 }, stockAt: serverTimestamp() });
    tx.set(kRef, {
      staffUid: me, staffName: who(staff), productId: product.id, productName: product.name,
      batch: lot.batch, expiry: lot.expiry, dosePer: product.dosePer, doseUnit: product.doseUnit || "units",
      sealed: (k ? parseInt(k.sealed, 10) || 0 : 0) + n, open: k ? round1(k.open) : 0,
      updatedAt: serverTimestamp(), ...(k ? {} : { createdAt: serverTimestamp() }),
    });
    logMove(tx, staff, {
      type: "kit-take", productId: product.id, productName: product.name, unit: product.stockUnit,
      lines: [{ loc: "shelf", batch: lot.batch, expiry: lot.expiry, delta: -n }, { loc: "kit", batch: lot.batch, expiry: lot.expiry, delta: n }],
      note: `${n * product.dosePer} ${product.doseUnit} into ${who(staff)}'s kit`,
    });
  });
}

// Reconstitute one unopened vial
export async function kitOpen(kit, staff) {
  const kRef = doc(db, "inv_kits", kit.id);
  await runTransaction(db, async (tx) => {
    const kSnap = await tx.get(kRef);
    if (!kSnap.exists()) throw new Error("This kit item no longer exists.");
    const k = kSnap.data();
    const sealed = parseInt(k.sealed, 10) || 0;
    if (sealed < 1) throw new Error("There are no unopened vials left in this batch.");
    tx.update(kRef, { sealed: sealed - 1, open: round1((Number(k.open) || 0) + kit.dosePer), openedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    logMove(tx, staff, {
      type: "kit-open", productId: kit.productId, productName: kit.productName, unit: kit.doseUnit,
      note: `Batch ${kit.batch || "-"}: ${kit.dosePer} ${kit.doseUnit} ready to use`,
    });
  });
}

// Unopened vials back onto the Shelf
export async function kitReturn(product, kit, vials, staff) {
  const n = Math.max(1, parseInt(vials, 10) || 0);
  const kRef = doc(db, "inv_kits", kit.id);
  const pRef = doc(db, "inv_products", product.id);
  const lRef = doc(db, "inv_lots", lotId(product.id, "shelf", kit.batch, kit.expiry));
  await runTransaction(db, async (tx) => {
    const kSnap = await tx.get(kRef);
    const pSnap = await tx.get(pRef);
    const lSnap = await tx.get(lRef);
    if (!kSnap.exists() || !pSnap.exists()) throw new Error("This kit item no longer exists. Reload and try again.");
    const sealed = parseInt(kSnap.data().sealed, 10) || 0;
    if (sealed < n) throw new Error(`There ${sealed === 1 ? "is" : "are"} only ${plural(sealed, product.stockUnit)} unopened in this batch.`);
    const s = pSnap.data().stock || {};
    tx.update(kRef, { sealed: sealed - n, updatedAt: serverTimestamp() });
    tx.set(lRef, {
      productId: product.id, loc: "shelf", batch: kit.batch, expiry: kit.expiry,
      qty: (lSnap.exists() ? Number(lSnap.data().qty) || 0 : 0) + n,
      updatedAt: serverTimestamp(), ...(lSnap.exists() ? {} : { createdAt: serverTimestamp() }),
    }, { merge: true });
    tx.update(pRef, { stock: { shelf: (Number(s.shelf) || 0) + n, jt: Number(s.jt) || 0 }, stockAt: serverTimestamp() });
    logMove(tx, staff, {
      type: "kit-return", productId: product.id, productName: product.name, unit: product.stockUnit,
      lines: [{ loc: "kit", batch: kit.batch, expiry: kit.expiry, delta: -n }, { loc: "shelf", batch: kit.batch, expiry: kit.expiry, delta: n }],
    });
  });
}

// Units from the opened vial and/or unopened vials that can't be used
export async function kitDiscard(kit, { units = 0, vials = 0, reason = "", note = "" }, staff) {
  const u = round1(Math.max(0, Number(units) || 0));
  const v = Math.max(0, parseInt(vials, 10) || 0);
  if (!u && !v) throw new Error("Enter what's being discarded.");
  const kRef = doc(db, "inv_kits", kit.id);
  await runTransaction(db, async (tx) => {
    const kSnap = await tx.get(kRef);
    if (!kSnap.exists()) throw new Error("This kit item no longer exists.");
    const k = kSnap.data();
    const sealed = parseInt(k.sealed, 10) || 0;
    const open = round1(k.open);
    if (v > sealed) throw new Error(`There ${sealed === 1 ? "is" : "are"} only ${sealed} unopened in this batch.`);
    if (u > open + 0.01) throw new Error(`The opened vial only has ${open} ${kit.doseUnit} left.`);
    tx.update(kRef, { sealed: sealed - v, open: Math.max(0, round1(open - u)), updatedAt: serverTimestamp() });
    logMove(tx, staff, {
      type: "kit-discard", productId: kit.productId, productName: kit.productName, unit: kit.doseUnit,
      discardUnits: round1(v * (Number(k.dosePer) || kit.dosePer || 0) + u), // total units lost, for Reporting
      lines: v ? [{ loc: "kit", batch: kit.batch, expiry: kit.expiry, delta: -v }] : [],
      reason: clip(reason, 60),
      note: [u && `${u} ${kit.doseUnit} from the opened vial`, clip(note, 400)].filter(Boolean).join(" · "),
    });
  });
}

/* ---------- JT storage releases: an injector asks, Dr Teh approves, it moves JT → Shelf ---------- */

export const REL_STATUS = { pending: "Waiting", approved: "On the Shelf", declined: "Declined", cancelled: "Cancelled" };

function normaliseRelease(d) {
  const x = d.data() || {};
  return {
    id: d.id, productId: String(x.productId || ""), productName: String(x.productName || ""), unit: String(x.unit || "unit"),
    qty: Math.max(1, parseInt(x.qty, 10) || 1), note: String(x.note || ""), response: String(x.response || ""),
    status: REL_STATUS[x.status] ? x.status : "pending",
    requestedBy: String(x.requestedBy || ""), requestedByUid: String(x.requestedByUid || ""),
    handledBy: String(x.handledBy || ""), batch: String(x.batch || ""), expiry: String(x.expiry || ""),
    createdAt: toDate(x.createdAt), handledAt: toDate(x.handledAt),
  };
}

export async function listReleases(max = 100) {
  const snap = await getDocs(query(collection(db, "inv_releases"), orderBy("createdAt", "desc"), limit(max)));
  return snap.docs.map(normaliseRelease);
}

export async function requestRelease(product, qty, note, staff) {
  const ref = await addDoc(collection(db, "inv_releases"), {
    productId: product.id, productName: product.name, unit: product.stockUnit,
    qty: Math.min(10, Math.max(1, parseInt(qty, 10) || 1)), note: clip(note, 500), status: "pending",
    requestedBy: who(staff), requestedByUid: uid(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return ref.id;
}

// Moves the vials from one JT batch to the Shelf, in one transaction
export async function approveRelease(rel, lot, staff) {
  if (!lot || lot.loc !== "jt") throw new Error("Choose a batch in JT storage.");
  const rRef = doc(db, "inv_releases", rel.id);
  const pRef = doc(db, "inv_products", rel.productId);
  const jtRef = doc(db, "inv_lots", lot.id);
  const shelfRef = doc(db, "inv_lots", lotId(rel.productId, "shelf", lot.batch, lot.expiry));
  await runTransaction(db, async (tx) => {
    const rSnap = await tx.get(rRef);
    const pSnap = await tx.get(pRef);
    const jSnap = await tx.get(jtRef);
    const sSnap = await tx.get(shelfRef);
    if (!rSnap.exists() || rSnap.data().status !== "pending") throw new Error("This request has already been handled.");
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    const q = Math.max(1, parseInt(rSnap.data().qty, 10) || 1);
    const have = jSnap.exists() ? Number(jSnap.data().qty) || 0 : 0;
    if (have < q) throw new Error(`That batch only has ${have} in JT storage. Choose another batch.`);
    const p = pSnap.data();
    const s = p.stock || {};
    tx.update(jtRef, { qty: have - q, updatedAt: serverTimestamp() });
    tx.set(shelfRef, {
      productId: rel.productId, loc: "shelf", batch: lot.batch, expiry: lot.expiry,
      qty: (sSnap.exists() ? Number(sSnap.data().qty) || 0 : 0) + q,
      updatedAt: serverTimestamp(), ...(sSnap.exists() ? {} : { createdAt: serverTimestamp() }),
    }, { merge: true });
    tx.update(pRef, { stock: { shelf: (Number(s.shelf) || 0) + q, jt: Math.max(0, (Number(s.jt) || 0) - q) }, stockAt: serverTimestamp() });
    tx.update(rRef, {
      status: "approved", batch: lot.batch, expiry: lot.expiry,
      handledBy: who(staff), handledByUid: uid(), handledAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    logMove(tx, staff, {
      type: "release", productId: rel.productId, productName: String(p.name || rel.productName), unit: String(p.stockUnit || rel.unit),
      lines: [{ loc: "jt", batch: lot.batch, expiry: lot.expiry, delta: -q }, { loc: "shelf", batch: lot.batch, expiry: lot.expiry, delta: q }],
      reason: `For ${rel.requestedBy}`.slice(0, 60),
    });
  });
}

export async function declineRelease(rel, reason, staff) {
  await updateDoc(doc(db, "inv_releases", rel.id), {
    status: "declined", response: clip(reason, 500),
    handledBy: who(staff), handledByUid: uid(), handledAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}

export async function cancelRelease(rel) {
  await updateDoc(doc(db, "inv_releases", rel.id), { status: "cancelled", updatedAt: serverTimestamp() });
}

/* ---------- Borrowing units from a colleague's opened vial (happens straight away) ---------- */

export const LOAN_STATUS = { unconfirmed: "Waiting for confirmation", confirmed: "Confirmed", disputed: "Disputed" };

export async function kitBorrow(fromKit, units, staff) {
  const u = round1(units);
  if (!(u > 0)) throw new Error("Enter how many units you're taking.");
  const me = uid();
  if (fromKit.staffUid === me) throw new Error("That's your own kit.");
  const fromRef = doc(db, "inv_kits", fromKit.id);
  const toRef = doc(db, "inv_kits", kitId(me, fromKit.productId, fromKit.batch, fromKit.expiry));
  const loanRef = doc(collection(db, "inv_loans"));
  await runTransaction(db, async (tx) => {
    const fSnap = await tx.get(fromRef);
    const tSnap = await tx.get(toRef);
    if (!fSnap.exists()) throw new Error("That kit item no longer exists.");
    const open = round1(fSnap.data().open);
    if (u > open + 0.01) throw new Error(`${fromKit.staffName} only has ${open} ${fromKit.doseUnit} left in that vial.`);
    const t = tSnap.exists() ? tSnap.data() : null;
    tx.update(fromRef, { open: Math.max(0, round1(open - u)), updatedAt: serverTimestamp() });
    tx.set(toRef, {
      staffUid: me, staffName: who(staff), productId: fromKit.productId, productName: fromKit.productName,
      batch: fromKit.batch, expiry: fromKit.expiry, dosePer: fromKit.dosePer, doseUnit: fromKit.doseUnit,
      sealed: t ? parseInt(t.sealed, 10) || 0 : 0, open: round1((t ? Number(t.open) || 0 : 0) + u),
      updatedAt: serverTimestamp(), ...(t ? {} : { createdAt: serverTimestamp() }),
    });
    tx.set(loanRef, {
      fromUid: fromKit.staffUid, fromName: fromKit.staffName, toUid: me, toName: who(staff),
      productId: fromKit.productId, productName: fromKit.productName, batch: fromKit.batch, expiry: fromKit.expiry,
      units: u, doseUnit: fromKit.doseUnit, status: "unconfirmed", createdAt: serverTimestamp(),
    });
    logMove(tx, staff, {
      type: "kit-borrow", productId: fromKit.productId, productName: fromKit.productName, unit: fromKit.doseUnit,
      note: `${u} ${fromKit.doseUnit} from ${fromKit.staffName}'s opened vial (batch ${fromKit.batch || "-"})`, ref: loanRef.id,
    });
  });
  return loanRef.id;
}

export async function listLoans(max = 100) {
  const snap = await getDocs(query(collection(db, "inv_loans"), orderBy("createdAt", "desc"), limit(max)));
  return snap.docs.map((d) => {
    const x = d.data() || {};
    return { id: d.id, ...x, units: Number(x.units) || 0, status: LOAN_STATUS[x.status] ? x.status : "unconfirmed",
      createdAt: toDate(x.createdAt), respondedAt: toDate(x.respondedAt) };
  });
}

// The lender (or an Admin) confirms or disputes
export async function answerLoan(loan, ok, note, staff) {
  await updateDoc(doc(db, "inv_loans", loan.id), {
    status: ok ? "confirmed" : "disputed", response: clip(note, 500),
    respondedBy: who(staff), respondedAt: serverTimestamp(),
  });
  if (!ok) queueNotify("loan.disputed", { loanId: loan.id });
}
/* ===================== Products used in treatments ===================== */
// lines: [{ fid, productId, name, kind: "kit"|"storage", unit, loc, block, rows: [{ ref, batch, expiry, amount }] }]
// Runs inside the transaction that saves the treatment record (reads first, then writes).
// Stock never goes below zero: anything missing is saved as "short" so the team can sort it out.
// The record always keeps the amount given to the patient.
export async function consumeInTx(tx, { submissionId, lines, patientId, patientName, formName, recordDate, staff }) {
  const me = uid();
  const kitSnaps = new Map(), lotSnaps = new Map(), prodSnaps = new Map(), openSnaps = new Map();
  const getOnce = async (map, col, id) => { if (id && !map.has(id)) map.set(id, await tx.get(doc(db, col, id))); };
  for (const l of lines) {
    for (const r of l.rows) {
      if (l.kind === "kit") await getOnce(kitSnaps, "inv_kits", r.ref);
      else if (l.kind === "shared") { if (r.ref) await getOnce(openSnaps, "inv_open", r.ref); else await getOnce(lotSnaps, "inv_lots", r.lot); }
      else await getOnce(lotSnaps, "inv_lots", r.ref);
    }
    if (l.kind !== "kit") await getOnce(prodSnaps, "inv_products", l.productId);
  }

  const kits = new Map(), lots = new Map(), opens = new Map(), newOpens = [];
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // Shared products: one use of an opened container, or opening a new one from a batch
  function sharedRow(l, r) {
    const dose = r2(Math.max(0, Number(r.dose) || 0));
    const finish = r.finish === true;
    if (r.ref) {
      const snap = openSnaps.get(r.ref);
      if (!snap || !snap.exists() || snap.data().status !== "open") {
        throw new Error(`${l.name}: that opened ${l.unit} has just been marked finished. Choose another, or open a new one.`);
      }
      const d = snap.data();
      const s = opens.get(r.ref) || { uses: parseInt(d.uses, 10) || 0, used: Number(d.used) || 0, finish: false };
      s.uses += 1;
      s.used = r2(s.used + dose);
      s.finish = s.finish || finish;
      opens.set(r.ref, s);
      return { openId: r.ref, batch: String(d.batch || ""), expiry: String(d.expiry || ""), amount: 1, taken: 1,
        from: "open", dose, waste: 0, opened: false, finished: finish };
    }
    const snap = r.lot ? lotSnaps.get(r.lot) : null;
    if (snap && snap.exists()) {
      const d = snap.data();
      const s = lots.get(r.lot) || { qty: Number(d.qty) || 0, loc: d.loc === "jt" ? "jt" : "shelf" };
      if (s.qty >= 1) {
        s.qty -= 1;
        lots.set(r.lot, s);
        const ref = doc(collection(db, "inv_open"));
        const batch = String(d.batch || ""), expiry = String(d.expiry || "");
        newOpens.push({ ref, productId: l.productId, name: l.name, batch, expiry, loc: s.loc, dose, finish });
        return { openId: ref.id, batch, expiry, amount: 1, taken: 1, from: s.loc, dose, waste: 0, opened: true, finished: finish };
      }
    }
    return { openId: "", batch: clip(r.batch, 40), expiry: KEY_RE.test(r.expiry || "") ? r.expiry : "", amount: 1, taken: 0,
      from: l.loc === "jt" ? "jt" : "shelf", dose, waste: 0, opened: false, finished: false };
  }

  const out = lines.map((l) => {
    const rows = l.rows.map((r) => {
      if (l.kind === "shared") return sharedRow(l, r);
      const want = l.kind === "kit" ? round1(r.amount) : Math.max(0, Math.round(Number(r.amount) || 0));
      let taken = 0, from = l.kind === "kit" ? "kit" : (l.loc === "jt" ? "jt" : "shelf");
      if (l.kind === "kit") {
        const snap = r.ref ? kitSnaps.get(r.ref) : null;
        if (snap && snap.exists() && snap.data().staffUid === me) {
          const d = snap.data();
          const s = kits.get(r.ref) || { sealed: parseInt(d.sealed, 10) || 0, open: round1(d.open), dosePer: Number(d.dosePer) || 0, opened: 0 };
          while (want > s.open + 0.001 && s.sealed > 0 && s.dosePer > 0) { s.sealed -= 1; s.open = round1(s.open + s.dosePer); s.opened += 1; }
          taken = round1(Math.min(want, s.open));
          s.open = round1(s.open - taken);
          kits.set(r.ref, s);
        }
      } else {
        const snap = r.ref ? lotSnaps.get(r.ref) : null;
        if (snap && snap.exists()) {
          const d = snap.data();
          const s = lots.get(r.ref) || { qty: Number(d.qty) || 0, loc: d.loc === "jt" ? "jt" : "shelf" };
          taken = Math.min(want, s.qty);
          s.qty -= taken;
          from = s.loc;
          lots.set(r.ref, s);
        }
      }
      const dose = l.kind === "kit" ? want : r2(Math.max(0, Number(r.dose) || 0));
      // One syringe per patient: whatever is left in the syringes opened is wastage
      const per = Number(l.dosePer) || 0;
      const waste = l.kind !== "kit" && per && dose ? Math.max(0, r2(want * per - dose)) : 0;
      return { ref: r.ref || "", batch: clip(r.batch, 40), expiry: KEY_RE.test(r.expiry || "") ? r.expiry : "", amount: want, taken, from, dose, waste };
    });
    const total = round1(rows.reduce((a, r) => a + r.amount, 0));
    const short = round1(rows.reduce((a, r) => a + (r.amount - r.taken), 0));
    return { fid: l.fid, productId: clip(l.productId, 60), name: clip(l.name, 150),
      kind: ["kit", "shared"].includes(l.kind) ? l.kind : "storage",
      unit: clip(l.unit, 30), batchLabel: clip(l.batchLabel || "", 20), doseUnit: clip(l.doseUnit || "", 20),
      doseTotal: r2(rows.reduce((a, r) => a + r.dose, 0)), waste: r2(rows.reduce((a, r) => a + r.waste, 0)),
      total, short, rows, block: l.block === true };
  });

  const blocked = out.find((l) => l.block && l.short > 0);
  if (blocked) throw new Error(`${blocked.name}: not enough in stock (short by ${blocked.short} ${blocked.unit}). This form can't be saved until it's restocked.`);

  // ---- Writes ----
  kits.forEach((s, ref) => tx.update(doc(db, "inv_kits", ref), {
    sealed: s.sealed, open: s.open, updatedAt: serverTimestamp(), ...(s.opened ? { openedAt: serverTimestamp() } : {}),
  }));
  lots.forEach((s, ref) => tx.update(doc(db, "inv_lots", ref), { qty: s.qty, updatedAt: serverTimestamp() }));
  prodSnaps.forEach((snap, pid) => {
    if (!snap.exists()) return;
    const st = snap.data().stock || {};
    const stock = { shelf: Number(st.shelf) || 0, jt: Number(st.jt) || 0 };
    let touched = false;
    out.filter((l) => l.kind !== "kit" && l.productId === pid).forEach((l) => l.rows.forEach((r) => {
      const n = l.kind === "shared" ? (r.opened ? 1 : 0) : r.taken;   // shared: only a newly opened one leaves stock
      if (!n) return;
      stock[r.from] = Math.max(0, stock[r.from] - n);
      touched = true;
    }));
    if (touched) tx.update(snap.ref, { stock, stockAt: serverTimestamp() });
  });
  opens.forEach((s, id) => tx.update(doc(db, "inv_open", id), {
    uses: s.uses, used: s.used, lastUsedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    ...(s.finish ? finishedFields("Empty", staff) : {}),
  }));
  newOpens.forEach((n) => {
    const snap = prodSnaps.get(n.productId);
    tx.set(n.ref, openDocData(n.productId, snap && snap.exists() ? snap.data() : { name: n.name }, n, staff, {
      uses: 1, used: n.dose, lastUsedAt: serverTimestamp(), ...(n.finish ? finishedFields("Empty", staff) : {}),
    }));
  });
  out.forEach((l) => {
    if (l.kind === "shared") {
      const opened = l.rows.filter((r) => r.opened);
      if (opened.length) {
        logMove(tx, staff, {
          type: "shared-open", productId: l.productId, productName: l.name, unit: l.unit,
          lines: opened.map((r) => ({ loc: r.from, batch: r.batch, expiry: r.expiry, delta: -1 })),
          reason: "Treatment", note: `Opened for ${patientName} · ${formName}`.slice(0, 500),
        });
      }
      return;
    }
    const moved = l.rows.filter((r) => r.taken);
    if (!moved.length) return;
    logMove(tx, staff, {
      type: l.kind === "kit" ? "kit-use" : "use", productId: l.productId, productName: l.name, unit: l.unit,
      lines: moved.map((r) => ({ loc: r.from, batch: r.batch, expiry: r.expiry, delta: -r.taken })),
      reason: "Treatment", note: [`${patientName} · ${formName}`,
        l.doseUnit && l.kind !== "kit" ? `${l.doseTotal} ${l.doseUnit} given` : "",
        l.waste ? `${l.waste} ${l.doseUnit} discarded` : ""].filter(Boolean).join(" · ").slice(0, 500),
    });
  });

  const saved = out.map(({ fid, block, ...l }) => ({ ...l, rows: l.rows.map(({ ref, ...r }) => r) }));
  const uRef = doc(collection(db, "inv_usage"));
  const isShort = saved.some((l) => l.short > 0);
  tx.set(uRef, {
    submissionId, patientId: clip(patientId, 150), patientName: clip(patientName, 150), formName: clip(formName, 150),
    recordDate: KEY_RE.test(recordDate || "") ? recordDate : "", lines: saved, short: isShort,
    by: who(staff), byUid: me, at: serverTimestamp(),
  });
  if (isShort) tx.set(doc(collection(db, "notify_outbox")), outboxDoc("usage.short", { usageId: uRef.id }, me));

  const answers = {};
  out.forEach(({ fid }, i) => { (answers[fid] = answers[fid] || { lines: [] }).lines.push(saved[i]); });
  return { answers };
}


// Treatment records saved without enough stock (last 30 days) that haven't been resolved yet
export async function listShortUsage() {
  const snap = await getDocs(query(collection(db, "inv_usage"), where("short", "==", true)));
  const since = Date.now() - 30 * 864e5;
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) }; })
    .filter((u) => u.at && u.at.getTime() > since && u.resolved !== true)
    .sort((a, b) => b.at - a.at);
}

// My treatment usage (default: the last 31 days), newest first
export async function listMyUsage(days = 31) {
  const snap = await getDocs(query(collection(db, "inv_usage"), where("byUid", "==", uid())));
  const since = Date.now() - days * 864e5;
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) }; })
    .filter((u) => u.at && u.at.getTime() > since)
    .sort((a, b) => b.at - a.at);
}

/* ===================== Opening counts and kit checks ===================== */

export const COUNT_FREQ = { never: "Not counted", daily: "Every day", weekly: "Once a week", monthly: "Once a month" };
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Is this product due to be counted on this day?
export function countDue(p, d = new Date()) {
  if (!p || !p.active) return false;
  if (p.countFreq === "daily") return true;
  if (p.countFreq === "weekly") return d.getDay() === Number(p.countDay);
  if (p.countFreq === "monthly") {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const want = p.countDay === "last" ? last : Math.min(Number(p.countDay) || 1, last);
    return d.getDate() === want;
  }
  return false;
}
export const countLocs = (p) => (p.countWhere === "shelf" ? ["shelf"] : p.countWhere === "jt" ? ["jt"] : ["shelf", "jt"]);

// When the opening count should be done by (inv_settings/counting)
export const COUNT_DUE_DEFAULT = "10:00";
export async function getCountSettings() {
  const s = await getDoc(doc(db, "inv_settings", "counting"));
  const d = s.exists() ? s.data() : {};
  return { dueBy: /^\d{2}:\d{2}$/.test(d.dueBy || "") ? d.dueBy : COUNT_DUE_DEFAULT };
}
export async function saveCountSettings({ dueBy }, staff) {
  if (!/^\d{2}:\d{2}$/.test(dueBy || "")) throw new Error("Choose a time.");
  await setDoc(doc(db, "inv_settings", "counting"), { dueBy, ...stamp(staff) }, { merge: true });
}

export async function listCountsOn(key = dayKey()) {
  const snap = await getDocs(query(collection(db, "inv_counts"), where("dateKey", "==", key)));
  return snap.docs.map((d) => {
    const x = d.data() || {};
    return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) };
  });
}



// One counted kit lot: unopened + units left in the opened one, against the system's numbers right now
async function countKitLine(l, ownOnly) {
  const snap = await getDoc(doc(db, "inv_kits", String(l.ref || "")));
  const k = snap.exists() ? normaliseKit(snap) : null;
  if (!k || (ownOnly && k.staffUid !== uid())) return null;
  const sealed = Math.max(0, parseInt(l.sealed, 10) || 0);
  const open = round1(Math.max(0, Number(l.open) || 0));
  const system = round1(kitUnits(k));
  const counted = round1(sealed * k.dosePer + open);
  return {
    productId: k.productId, productName: k.productName, loc: "kit", ref: k.id, batch: k.batch, expiry: k.expiry,
    staffUid: k.staffUid, staffName: k.staffName, unit: k.doseUnit, system, counted, variance: round1(counted - system),
    detail: { sealed, open, systemSealed: k.sealed, systemOpen: k.open },
    status: Math.abs(counted - system) > 0.001 ? "open" : "ok", note: "",
  };
}

// Saves a count. The system's numbers are read fresh at the moment of saving (never shown beforehand).
// Nothing changes stock. Differences either open an investigation (per the product's setting)
// or are saved as "open" for Reporting → Count differences.
// opening: lines [{ productId, loc, batch, expiry, counted }] and/or kit lines [{ kit: true, ref, sealed, open }]
// kit (an injector's own check): lines [{ ref, sealed, open }]
export async function saveCount({ kind, lines, note = "" }, staff) {
  const me = uid();
  const by = who(staff);
  const out = [];
  const isKitCheck = kind === "kit";
  const products = new Map();
  for (const l of lines.filter((x) => isKitCheck || x.kit)) {
    const line = await countKitLine(l, isKitCheck);
    if (line) out.push(line);
  }
  const shelfLines = isKitCheck ? [] : lines.filter((x) => !x.kit);
  if (shelfLines.length) {
    const [list, lots] = await Promise.all([listProducts(), listAllLots()]);
    list.forEach((p) => products.set(p.id, p));
    const lotById = new Map(lots.map((l) => [l.id, l]));
    const agg = new Map();
    const latest = Date.now() + 60000;
    shelfLines.forEach((l) => {
      const p = products.get(l.productId);
      if (!p) return;
      const loc = l.loc === "jt" ? "jt" : "shelf";
      const batch = p.tracked ? clip(l.batch, 40) : "";
      const expiry = p.tracked && KEY_RE.test(l.expiry || "") ? l.expiry : "";
      const ref = lotId(p.id, loc, batch, expiry);
      const t = Number(l.countedAt) || 0;
      const a = agg.get(ref) || { p, loc, batch, expiry, counted: 0, countedAt: 0, note: "" };
      a.counted += Math.max(0, parseInt(l.counted, 10) || 0);
      a.countedAt = Math.max(a.countedAt, t > 0 && t <= latest ? t : 0);
      if (!a.note && l.note) a.note = clip(l.note, 300);
      agg.set(ref, a);
    });

    // Stock that moved after a line was counted (e.g. a treatment saved while counting) is taken back out,
    // so each line is compared with digital as it was at the moment it was counted
    const times = [...agg.values()].map((a) => a.countedAt).filter(Boolean);
    const moves = times.length
      ? await listMovesBetween(new Date(Math.min(...times) - 1000), new Date(latest)).catch(() => [])
      : [];
    const movedSince = (a) => (!a.countedAt ? 0 : moves
      .filter((m) => m.productId === a.p.id && m.at && m.at.getTime() > a.countedAt)
      .reduce((s, m) => s + (m.lines || [])
        .filter((x) => x.loc === a.loc && (!a.p.tracked || ((x.batch || "") === a.batch && (x.expiry || "") === a.expiry)))
        .reduce((t, x) => t + (Number(x.delta) || 0), 0), 0));

    agg.forEach((a, ref) => {
      const now = a.p.tracked ? ((lotById.get(ref) || {}).qty || 0) : (a.p.stock[a.loc] || 0);
      const moved = movedSince(a);
      const system = Math.max(0, now - moved);
      const variance = a.counted - system;
      out.push({
        productId: a.p.id, productName: a.p.name, loc: a.loc, ref, batch: a.batch, expiry: a.expiry,
        batchLabel: a.p.batchLabel || "Batch", unit: a.p.stockUnit, system, counted: a.counted, variance,
        systemNow: now, movedSince: moved, countedAt: a.countedAt ? new Date(a.countedAt).toISOString() : "",
        status: !variance ? "ok" : needsInvestigation(a.p, variance) ? "investigating" : "open", note: "", countNote: a.note,
      });
    });
  }
  
  if (!out.length) throw new Error("Nothing was counted.");

  // One write: the count, an investigation for each difference that needs one, and its notification
  const cRef = doc(collection(db, "inv_counts"));
  const batch = writeBatch(db);
  const at = new Date().toISOString();
  const opened = [];
  out.forEach((l, i) => {
    if (l.status !== "investigating") return;
    const iRef = doc(collection(db, "inv_investigations"));
    l.investigationId = iRef.id;
    opened.push(iRef.id);
    batch.set(iRef, {
      countId: cRef.id, line: i, productId: l.productId, productName: l.productName, loc: l.loc, ref: l.ref,
      batch: l.batch, expiry: l.expiry, batchLabel: l.batchLabel || "Batch", unit: l.unit,
      digital: l.system, counted: l.counted, variance: l.variance, countNote: l.countNote || "", dateKey: dayKey(),
      status: "recount", aloneApproved: false,
      openedBy: by, openedByUid: me, openedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      events: [{ at, by, action: "Opened from the opening count", note: `Counted ${l.counted}, digital ${l.system}` }],
    });
  });
  const openCount = out.filter((l) => l.status === "open").length;
  batch.set(cRef, {
    kind: isKitCheck ? "kit" : "opening", dateKey: dayKey(), lines: out, openCount,
    note: clip(note, 500), by, byUid: me, at: serverTimestamp(),
  });
  if (opened.length) {
    batch.set(doc(collection(db, "notify_outbox")), outboxDoc("investigation.opened", { ids: opened.slice(0, 40), countId: cRef.id }, me));
  }
  await batch.commit();
  if (openCount) queueNotify("count.difference", { countId: cRef.id });
  if (opened.length) pingNotify();
  return { id: cRef.id, lines: out, openCount, investigations: opened.length };
}

/* ===================== Reporting: count differences ===================== */

export const COUNT_STATUS = { open: "To review", ok: "Matched", accepted: "Accepted", explained: "Explained", investigating: "Investigating",
  baseline: "Starting stock" };
// Counts with a difference still to review, or every count from a date on (dateKey "YYYY-MM-DD")
export async function listCounts({ from = "", openOnly = false } = {}) {
  const col = collection(db, "inv_counts");
  const snap = await getDocs(openOnly ? query(col, where("openCount", ">", 0)) : query(col, where("dateKey", ">=", from || "0000")));
  return snap.docs.map((d) => {
    const x = d.data() || {};
    return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], openCount: Number(x.openCount) || 0, at: toDate(x.at) };
  }).sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
}

// Accept: applies the difference to today's stock (not "set to the counted number": stock may have moved since).
// Explain: a note only. Either way the line is closed once, inside one transaction.
export async function resolveCountLine(countId, index, { action, note = "" }, staff) {
  const accept = action === "accept";
  const text = clip(note, 500);
  if (!accept && !text) throw new Error("Add a note explaining the difference.");
  const by = who(staff);
  const cRef = doc(db, "inv_counts", countId);
  await runTransaction(db, async (tx) => {
    const cSnap = await tx.get(cRef);
    if (!cSnap.exists()) throw new Error("This count no longer exists.");
    const lines = (Array.isArray(cSnap.data().lines) ? cSnap.data().lines : []).map((l) => ({ ...l }));
    const l = lines[index];
    if (!l) throw new Error("This line no longer exists. Reload and try again.");
    if (l.status !== "open") throw new Error("Someone has already reviewed this difference. Reload to see it.");
    const diff = Number(l.variance) || 0;

    if (accept && diff) {
      if (l.loc === "kit") {
        // Kits: unopened and opened-vial differences are applied separately
        const kRef = doc(db, "inv_kits", String(l.ref || ""));
        const kSnap = await tx.get(kRef);
        if (!kSnap.exists()) throw new Error("This kit item no longer exists.");
        const k = kSnap.data();
        const d = l.detail || {};
        const dS = (parseInt(d.sealed, 10) || 0) - (parseInt(d.systemSealed, 10) || 0);
        const dO = round1((Number(d.open) || 0) - (Number(d.systemOpen) || 0));
        const sealed = (parseInt(k.sealed, 10) || 0) + dS;
        const open = round1((Number(k.open) || 0) + dO);
        if (sealed < 0 || open < 0) {
          throw new Error(`${l.staffName || "The injector"}'s kit has changed since this count. Ask them to do a kit check, then review that one instead.`);
        }
        tx.update(kRef, { sealed, open, updatedAt: serverTimestamp() });
        logMove(tx, staff, {
          type: "kit-count", productId: l.productId, productName: l.productName, unit: l.unit,
          staffUid: l.staffUid || "", deltaUnits: diff,   // whose kit, and by how much (for Kit reconciliation)
          lines: dS ? [{ loc: "kit", batch: l.batch || "", expiry: l.expiry || "", delta: dS }] : [],
          reason: "Count difference accepted", ref: countId,
          note: [`${l.staffName || "Injector"}'s kit`, `${diff > 0 ? "+" : ""}${diff} ${l.unit}`, text].filter(Boolean).join(" · "),
        });
      } else {
        const loc = l.loc === "jt" ? "jt" : "shelf";
        const pRef = doc(db, "inv_products", l.productId);
        const lRef = doc(db, "inv_lots", String(l.ref || ""));
        const pSnap = await tx.get(pRef);
        const lSnap = await tx.get(lRef);
        if (!pSnap.exists()) throw new Error("This product no longer exists.");
        const p = pSnap.data();
        const s = p.stock || {};
        const stock = { shelf: Number(s.shelf) || 0, jt: Number(s.jt) || 0 };
        const lotHave = lSnap.exists() ? Number(lSnap.data().qty) || 0 : 0;
        const have = p.tracked === true ? lotHave : stock[loc];
        if (have + diff < 0) {
          throw new Error(`Stock has been used since this count: only ${have} left in ${locLabel(loc)}, so ${-diff} can't be removed. Do a fresh count instead.`);
        }
        stock[loc] = Math.max(0, stock[loc] + diff);
        tx.set(lRef, {
          productId: l.productId, loc, batch: l.batch || "", expiry: l.expiry || "", qty: Math.max(0, lotHave + diff),
          updatedAt: serverTimestamp(), ...(lSnap.exists() ? {} : { createdAt: serverTimestamp() }),
        }, { merge: true });
        tx.update(pRef, { stock, stockAt: serverTimestamp() });
        logMove(tx, staff, {
          type: "count", productId: l.productId, productName: l.productName, unit: l.unit,
          lines: [{ loc, batch: l.batch || "", expiry: l.expiry || "", delta: diff }],
          reason: "Count difference accepted", note: text, ref: countId,
        });
      }
    }

    const at = new Date().toISOString();
    lines[index] = { ...l, status: accept ? "accepted" : "explained", note: text, resolvedBy: by, resolvedByUid: uid(), resolvedAt: at };
    tx.update(cRef, {
      lines, openCount: lines.filter((x) => x.status === "open").length, updatedAt: serverTimestamp(), updatedBy: by,
      events: arrayUnion({ at, by, action: accept ? "Accepted" : "Explained", note: `${l.productName} · ${locLabel(l.loc)}${text ? ` · ${text}` : ""}`.slice(0, 300) }),
    });
  });
}


/* ===================== Starting stock: make digital match a day's opening count ===================== */
// From then on every count difference is a real one. For each product + place + batch the latest count
// that day wins, and its difference is applied to stock now (like Accept: stock may have moved since).
// Kits aren't touched: they keep their own history (Kit reconciliation).
// Safe to run again: each count line has a fixed activity id, so it's never applied twice.

const baselineMoveId = (countId, index) => `baseline__${countId}__${index}`;

export async function getBaseline() {
  const s = await getDoc(doc(db, "inv_settings", "counting"));
  const b = s.exists() ? s.data().baseline : null;
  return b && KEY_RE.test(b.dateKey || "")
    ? { dateKey: b.dateKey, by: String(b.by || ""), at: toDate(b.at), changed: Number(b.changed) || 0 } : null;
}

// What setting the starting stock would do. Nothing is changed.
export async function baselinePlan(key = dayKey()) {
  const [today, products, openCounts, openInvs] = await Promise.all([
    listCountsOn(key), listProducts(), listCounts({ openOnly: true }), listInvestigations({ open: true }),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const invById = new Map(openInvs.map((x) => [x.id, x])); // only open ones: a closed one has been dealt with

  // The latest count of each spot today; earlier counts of the same spot are set aside
  const latest = new Map();
  const earlier = [];
  today.filter((c) => c.kind === "opening")
    .sort((a, b) => (a.at ? a.at.getTime() : 0) - (b.at ? b.at.getTime() : 0))
    .forEach((c) => c.lines.forEach((line, index) => {
      if (line.loc === "kit" || !byId.has(line.productId)) return;
      const prev = latest.get(line.ref);
      if (prev) earlier.push(prev);
      latest.set(line.ref, { countId: c.id, index, line, product: byId.get(line.productId) });
    }));

  const items = [...latest.values()].map((x) => {
    const l = x.line;
    const inv = l.status === "investigating" ? invById.get(l.investigationId) || null : null;
    let diff = 0;
    if (l.status === "open" || l.status === "explained") diff = Number(l.variance) || 0;
    else if (inv) diff = Number(inv.recount ? inv.recount.variance : l.variance) || 0; // a recount is fresher
    return {
      ...x, loc: l.loc === "jt" ? "jt" : "shelf", diff, invId: inv ? inv.id : "",
      state: diff ? "change" : l.status === "ok" ? "match" : "done",
    };
  });

  const earlierOpen = earlier.filter((x) => x.line.status === "open"
    || (x.line.status === "investigating" && invById.has(x.line.investigationId)));
  const olderLines = openCounts.filter((c) => (c.dateKey || "") < key)
    .flatMap((c) => c.lines.map((line, index) => ({ countId: c.id, index, line })).filter((x) => x.line.status === "open"));
  const todayInv = new Set([...items, ...earlierOpen].map((x) => x.line.investigationId).filter(Boolean));
  const olderInvs = openInvs.filter((x) => !todayInv.has(x.id) && (x.dateKey || "") < key);
  const counted = new Set(items.map((x) => x.product.id));
  const notCounted = products.filter((p) => p.active && !counted.has(p.id) && (p.stock.shelf > 0 || p.stock.jt > 0));
  return { key, items, earlier: earlierOpen, olderLines, olderInvs, notCounted };
}

// One product's changes in one transaction: batches, the product total and the activity log together
async function baselineProduct(list, key, staff, applied) {
  const p = list[0].product;
  const pRef = doc(db, "inv_products", p.id);
  const by = who(staff);
  const me = uid();
  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists()) return;
    const reads = [];
    for (const x of list) {
      const mRef = doc(db, "inv_moves", baselineMoveId(x.countId, x.index));
      const lRef = doc(db, "inv_lots", String(x.line.ref || ""));
      reads.push({ x, mRef, lRef, m: await tx.get(mRef), l: await tx.get(lRef) });
    }

    // ---- Writes ----
    const pd = pSnap.data();
    const s = pd.stock || {};
    const stock = { shelf: Number(s.shelf) || 0, jt: Number(s.jt) || 0 };
    let touched = false;
    reads.forEach(({ x, mRef, lRef, m, l }) => {
      const k = `${x.countId}:${x.index}`;
      if (m.exists()) { applied.set(k, Number(m.data().applied) || 0); return; } // done on an earlier run
      const lotHave = l.exists() ? Number(l.data().qty) || 0 : 0;
      const have = pd.tracked === true ? lotHave : stock[x.loc];
      const delta = Math.max(-have, x.diff); // never below zero
      stock[x.loc] = Math.max(0, stock[x.loc] + delta);
      tx.set(lRef, {
        productId: p.id, loc: x.loc, batch: x.line.batch || "", expiry: x.line.expiry || "", qty: Math.max(0, lotHave + delta),
        updatedAt: serverTimestamp(), ...(l.exists() ? {} : { createdAt: serverTimestamp() }),
      }, { merge: true });
      tx.set(mRef, {
        type: "baseline", productId: p.id, productName: String(pd.name || p.name), unit: String(pd.stockUnit || p.stockUnit),
        lines: [{ loc: x.loc, batch: x.line.batch || "", expiry: x.line.expiry || "", delta }],
        reason: "Starting stock set", ref: x.countId, applied: delta,
        note: [`Counted ${x.line.counted} on ${key}`, delta !== x.diff ? `only ${-delta} could be taken off` : ""].filter(Boolean).join(" · "),
        by, byUid: me, at: serverTimestamp(),
      });
      applied.set(k, delta);
      touched = true;
    });
    if (touched) tx.update(pRef, { stock, stockAt: serverTimestamp() });
  });
}

// Runs a plan from baselinePlan. closeOlder: also close differences and investigations from before that day.
export async function setBaseline(plan, { closeOlder = true } = {}, staff, onProgress = () => {}) {
  const by = who(staff);
  const me = uid();
  const at = new Date().toISOString();
  const changes = plan.items.filter((x) => x.state === "change");
  const applied = new Map(); // "countId:index" → what was actually applied

  // 1. Stock: one transaction per product, a few at a time
  const byProduct = new Map();
  changes.forEach((x) => byProduct.set(x.product.id, [...(byProduct.get(x.product.id) || []), x]));
  const groups = [...byProduct.values()];
  for (let i = 0; i < groups.length; i += 4) {
    onProgress(`Updating stock… ${i} of ${groups.length}`);
    await Promise.all(groups.slice(i, i + 4).map((g) => baselineProduct(g, plan.key, staff, applied)));
  }

  // 2. Investigations
  const inv = new Map();
  changes.filter((x) => x.invId).forEach((x) => inv.set(x.invId, {
    applied: applied.get(`${x.countId}:${x.index}`) || 0, note: "Starting stock set from this count.",
  }));
  plan.earlier.forEach((x) => {
    const id = x.line.investigationId;
    if (id && !inv.has(id)) inv.set(id, { applied: 0, note: "A later count that day was used for the starting stock." });
  });
  if (closeOlder) plan.olderInvs.forEach((x) => {
    if (!inv.has(x.id)) inv.set(x.id, { applied: 0, note: "Closed when the starting stock was set. Stock wasn't changed." });
  });
  onProgress("Closing investigations…");
  const invIds = [...inv.keys()];
  for (let i = 0; i < invIds.length; i += 400) {
    const b = writeBatch(db);
    invIds.slice(i, i + 400).forEach((id) => {
      const v = inv.get(id);
      b.update(doc(db, "inv_investigations", id), {
        status: "closed", outcome: "baseline", outcomeNote: v.note, applied: v.applied,
        closedAt: serverTimestamp(), closedBy: by, closedByUid: me, updatedAt: serverTimestamp(),
        events: arrayUnion({ at, by, action: "Closed: starting stock set",
          note: v.applied ? `Adjusted by ${v.applied > 0 ? "+" : ""}${v.applied}` : "Stock not changed" }),
      });
    });
    await b.commit();
  }

  // 3. The count lines
  const marks = new Map(); // countId → Map(index → { applied, note })
  const mark = (x, n, note) => {
    const m = marks.get(x.countId) || new Map();
    m.set(x.index, { applied: n, note });
    marks.set(x.countId, m);
  };
  changes.forEach((x) => mark(x, applied.get(`${x.countId}:${x.index}`) || 0, "Starting stock set"));
  plan.earlier.forEach((x) => mark(x, 0, "A later count that day was used"));
  if (closeOlder) plan.olderLines.forEach((x) => mark(x, 0, "Before the starting stock"));
  onProgress("Updating the counts…");
  const entries = [...marks];
  for (let i = 0; i < entries.length; i += 5) {
    await Promise.all(entries.slice(i, i + 5).map(([countId, m]) => runTransaction(db, async (tx) => {
      const ref = doc(db, "inv_counts", countId);
      const s = await tx.get(ref);
      if (!s.exists()) return;
      const lines = (Array.isArray(s.data().lines) ? s.data().lines : []).map((l) => ({ ...l }));
      m.forEach((v, idx) => {
        const l = lines[idx];
        if (!l || ["ok", "accepted", "baseline"].includes(l.status)) return;
        lines[idx] = { ...l, status: "baseline", applied: v.applied, note: v.note, resolvedBy: by, resolvedByUid: me, resolvedAt: at };
      });
      tx.update(ref, {
        lines, openCount: lines.filter((l) => l.status === "open").length, updatedAt: serverTimestamp(), updatedBy: by,
        events: arrayUnion({ at, by, action: "Starting stock set", note: plan.key }),
      });
    })));
  }

  // 4. The "counting from" date
  await setDoc(doc(db, "inv_settings", "counting"), {
    baseline: { dateKey: plan.key, at: serverTimestamp(), by, byUid: me, changed: changes.length },
  }, { merge: true });

  return { changed: changes.length, investigations: inv.size };
}

/* ---------- Starting stock typed in (products not in the opening count) ---------- */
// Sets each place / batch to what's physically there now. targets: [{ loc, batch, expiry, qty }].
// The difference is worked out inside the transaction, so stock that moved a moment ago is respected.
// Logged as "Starting stock set". Returns how many places changed.
export async function setStartingStock(product, targets, staff, { type = "baseline", reason = "Starting stock set", note = "Typed in" } = {}) {
  const byUid = uid();
  const want = new Map();
  (targets || []).forEach((t) => {
    const qty = parseInt(t.qty, 10);
    if (!(qty >= 0)) return;
    const loc = t.loc === "jt" ? "jt" : "shelf";
    const batch = product.tracked ? clip(t.batch, 40) : "";
    const expiry = product.tracked && KEY_RE.test(t.expiry || "") ? t.expiry : "";
    if (product.tracked && (!batch || !expiry)) {
      throw new Error(`${product.name}: each ${batchName(product).toLowerCase()} needs its number and expiry date.`);
    }
    want.set(lotId(product.id, loc, batch, expiry), { loc, batch, expiry, qty });
  });
  if (!want.size) return 0;

  const pRef = doc(db, "inv_products", product.id);
  let changed = 0;
  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists()) throw new Error(`${product.name} no longer exists.`);
    const snaps = new Map();
    for (const id of want.keys()) snaps.set(id, await tx.get(doc(db, "inv_lots", id)));

    // ---- Writes ----
    const pd = pSnap.data();
    const s = pd.stock || {};
    const stock = { shelf: Number(s.shelf) || 0, jt: Number(s.jt) || 0 };
    const tracked = pd.tracked === true;
    const lines = [];
    want.forEach((w, id) => {
      const snap = snaps.get(id);
      const lotHave = snap.exists() ? Number(snap.data().qty) || 0 : 0;
      const have = tracked ? lotHave : stock[w.loc];
      const delta = w.qty - have;
      if (!delta) return;
      stock[w.loc] = Math.max(0, stock[w.loc] + delta);
      tx.set(snap.ref, {
        productId: product.id, loc: w.loc, batch: w.batch, expiry: w.expiry, qty: w.qty,
        updatedAt: serverTimestamp(), ...(snap.exists() ? {} : { createdAt: serverTimestamp() }),
      }, { merge: true });
      lines.push({ loc: w.loc, batch: w.batch, expiry: w.expiry, delta });
    });
    changed = lines.length;
    if (!lines.length) return;
    tx.update(pRef, { stock, stockAt: serverTimestamp() });
    tx.set(doc(collection(db, "inv_moves")), {
      type: type === "count" ? "count" : "baseline", productId: product.id, productName: String(pd.name || product.name),
      unit: String(pd.stockUnit || product.stockUnit), lines, reason: clip(reason, 60), note: clip(note, 500), ref: "",
      by: who(staff), byUid, at: serverTimestamp(),
    });
  });
  return changed;
}


/* ===================== Reporting: usage and wastage over a date range ===================== */

// Treatment usage between two dates (from inclusive, to exclusive), newest first
export async function listUsageBetween(from, to) {
  const snap = await getDocs(query(collection(db, "inv_usage"), where("at", ">=", from), where("at", "<", to)));
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) }; })
    .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
}

// Activity between two dates, optionally only some types (e.g. ["kit-discard", "writeoff"])
export async function listMovesBetween(from, to, types = null) {
  const snap = await getDocs(query(collection(db, "inv_moves"), where("at", ">=", from), where("at", "<", to)));
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) }; })
    .filter((m) => !types || types.includes(m.type))
    .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
}

/* ===================== Reporting: kit reconciliation and saved short ===================== */

export const KIT_MOVE_TYPES = ["kit-take", "kit-return", "kit-discard", "kit-use", "kit-count", "kit-correct"];

// Every kit movement ever (oldest first). Borrowing comes from inv_loans instead.
export async function listKitMoves() {
  const snap = await getDocs(query(collection(db, "inv_moves"), where("type", "in", KIT_MOVE_TYPES)));
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) }; })
    .sort((a, b) => (a.at ? a.at.getTime() : 0) - (b.at ? b.at.getTime() : 0));
}

// Every borrow between injectors
export async function listAllLoans() {
  const snap = await getDocs(collection(db, "inv_loans"));
  return snap.docs.map((d) => {
    const x = d.data() || {};
    return { id: d.id, ...x, units: Number(x.units) || 0, status: LOAN_STATUS[x.status] ? x.status : "unconfirmed",
      createdAt: toDate(x.createdAt) };
  });
}

// Every treatment record saved short (newest first), resolved or not
export async function listShortAll() {
  const snap = await getDocs(query(collection(db, "inv_usage"), where("short", "==", true)));
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [],
      at: toDate(x.at), resolvedAt: toDate(x.resolvedAt), resolved: x.resolved === true }; })
    .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
}

// Marks a saved-short record as sorted out, with a note. Only once.
export async function resolveShort(id, note, staff) {
  const text = clip(note, 500);
  if (!text) throw new Error("Add a note saying how it was sorted out.");
  const ref = doc(db, "inv_usage", id);
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error("This record no longer exists.");
    if (s.data().resolved === true) throw new Error("Someone has already resolved this. Reload to see it.");
    tx.update(ref, { resolved: true, resolvedNote: text, resolvedBy: who(staff), resolvedByUid: uid(), resolvedAt: serverTimestamp() });
  });
}

/* ===================== Correcting a treatment's usage ===================== */

export async function getUsage(id) {
  const s = await getDoc(doc(db, "inv_usage", id));
  if (!s.exists()) return null;
  const x = s.data() || {};
  return { id: s.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at),
    corrections: Array.isArray(x.corrections) ? x.corrections : [] };
}

// What a correction does to one row. diff = new amount − recorded amount.
// Less used: anything still short is cleared first, the rest goes back to stock.
// More used: all of it comes from stock (what was short stays short).
// Returns move: + taken from stock now, − given back.
export function correctionMove(row, newAmount, kit) {
  const amount = Number(row.amount) || 0;
  const taken = Number(row.taken) || 0;
  const diff = kit ? round1(newAmount - amount) : Math.round(newAmount - amount);
  if (diff >= 0) return { move: diff, clearsShort: 0 };
  const clearsShort = Math.min(Math.max(0, amount - taken), -diff);
  const back = -diff - clearsShort;
  return { move: kit ? -round1(back) : -Math.round(back), clearsShort: kit ? round1(clearsShort) : clearsShort };
}

// changes: [{ li, ri, amount, dose }] (line and row index on the usage record)
// One transaction: kit / batch / product totals, the activity log, and the usage record (original kept).
export async function correctUsage(id, changes, reason, staff) {
  const why = clip(reason, 300);
  if (!why) throw new Error("Add a reason for the correction.");
  const me = uid();
  const by = who(staff);
  const uRef = doc(db, "inv_usage", id);

  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const uSnap = await tx.get(uRef);
    if (!uSnap.exists()) throw new Error("This record no longer exists.");
    const u = uSnap.data();
    const owner = String(u.byUid || "");
    const ownerName = String(u.by || "the injector");
    const lines = (Array.isArray(u.lines) ? u.lines : []).map((l) => ({ ...l, rows: (l.rows || []).map((r) => ({ ...r })) }));

    const work = [];
    for (const c of changes || []) {
      const l = lines[c.li];
      const r = l && l.rows[c.ri];
      if (!r) throw new Error("This record has changed. Reload and try again.");
      if (l.kind === "shared") throw new Error(`${l.name} is shared across patients, so its uses can't be corrected here.`);
      const kit = l.kind === "kit";
      const amount = kit ? round1(Math.max(0, Number(c.amount) || 0)) : Math.max(0, Math.round(Number(c.amount) || 0));
      const dose = kit ? amount : l.doseUnit ? Math.round(Math.max(0, Number(c.dose) || 0) * 100) / 100 : 0;
      const same = amount === (Number(r.amount) || 0) && (kit || !l.doseUnit || dose === (Number(r.dose) || 0));
      if (!same) work.push({ l, r, kit, amount, dose, ...correctionMove(r, amount, kit) });
    }
    if (!work.length) throw new Error("Nothing has changed.");

    const prodSnaps = new Map(), kitSnaps = new Map(), lotSnaps = new Map();
    for (const w of work) {
      const pid = w.l.productId;
      if (pid && !prodSnaps.has(pid)) prodSnaps.set(pid, await tx.get(doc(db, "inv_products", pid)));
      if (!w.move) continue;
      if (w.kit) {
        w.ref = kitId(owner, pid, w.r.batch, w.r.expiry);
        if (!kitSnaps.has(w.ref)) kitSnaps.set(w.ref, await tx.get(doc(db, "inv_kits", w.ref)));
      } else {
        w.loc = w.r.from === "jt" ? "jt" : "shelf";
        w.ref = lotId(pid, w.loc, w.r.batch, w.r.expiry);
        if (!lotSnaps.has(w.ref)) lotSnaps.set(w.ref, await tx.get(doc(db, "inv_lots", w.ref)));
      }
    }

    // ---- Work out the stock changes ----
    const kits = new Map(), lots = new Map(), stockDelta = new Map();
    work.forEach((w) => {
      const pid = w.l.productId;
      const where = w.r.batch ? ` (${w.l.batchLabel || "Batch"} ${w.r.batch})` : "";
      if (w.move && w.kit) {
        const snap = kitSnaps.get(w.ref);
        if (!snap || !snap.exists()) throw new Error(`${w.l.name}: this batch isn't in ${ownerName}'s kit any more. Do a kit check instead.`);
        const d = snap.data();
        const s = kits.get(w.ref) || { sealed: parseInt(d.sealed, 10) || 0, open: round1(d.open), dosePer: Number(d.dosePer) || 0 };
        if (w.move > 0) {
          while (w.move > s.open + 0.001 && s.sealed > 0 && s.dosePer > 0) { s.sealed -= 1; s.open = round1(s.open + s.dosePer); }
          if (w.move > s.open + 0.001) {
            throw new Error(`${w.l.name}: ${ownerName}'s kit only has ${round1(s.sealed * s.dosePer + s.open)} ${w.l.unit} left${where}. Do a kit check first.`);
          }
        }
        s.open = round1(s.open - w.move); // a negative move puts units back in the opened vial
        kits.set(w.ref, s);
      } else if (w.move) {
        const snap = lotSnaps.get(w.ref);
        const s = lots.get(w.ref) || { qty: snap && snap.exists() ? Number(snap.data().qty) || 0 : 0, exists: !!(snap && snap.exists()),
          productId: pid, loc: w.loc, batch: w.r.batch || "", expiry: w.r.expiry || "" };
        if (w.move > s.qty) {
          throw new Error(`${w.l.name}: only ${plural(s.qty, w.l.unit)} left in ${locLabel(w.loc)}${where}. Do a count first.`);
        }
        s.qty -= w.move;
        lots.set(w.ref, s);
        const sd = stockDelta.get(pid) || { shelf: 0, jt: 0 };
        sd[w.loc] -= w.move;
        stockDelta.set(pid, sd);
      }

      // The row itself
      const p = prodSnaps.get(pid);
      const per = p && p.exists() ? Number(p.data().dosePer) || 0 : 0;
      w.before = { amount: Number(w.r.amount) || 0, dose: Number(w.r.dose) || 0 };
      w.r.amount = w.amount;
      w.r.taken = w.kit ? round1((Number(w.r.taken) || 0) + w.move) : (Number(w.r.taken) || 0) + w.move;
      w.r.dose = w.dose;
      w.r.waste = !w.kit && per && w.dose ? Math.max(0, Math.round((w.amount * per - w.dose) * 100) / 100) : 0;
    });

    // Line totals, the same way the treatment form works them out
    new Set(work.map((w) => w.l)).forEach((l) => {
      l.total = round1(l.rows.reduce((a, r) => a + (Number(r.amount) || 0), 0));
      l.short = round1(l.rows.reduce((a, r) => a + Math.max(0, (Number(r.amount) || 0) - (Number(r.taken) || 0)), 0));
      l.doseTotal = Math.round(l.rows.reduce((a, r) => a + (Number(r.dose) || 0), 0) * 100) / 100;
      l.waste = Math.round(l.rows.reduce((a, r) => a + (Number(r.waste) || 0), 0) * 100) / 100;
    });

    // ---- Writes ----
    kits.forEach((s, ref) => tx.update(doc(db, "inv_kits", ref), { sealed: s.sealed, open: s.open, updatedAt: serverTimestamp() }));
    lots.forEach((s, ref) => tx.set(doc(db, "inv_lots", ref), {
      productId: s.productId, loc: s.loc, batch: s.batch, expiry: s.expiry, qty: s.qty,
      updatedAt: serverTimestamp(), ...(s.exists ? {} : { createdAt: serverTimestamp() }),
    }, { merge: true }));
    stockDelta.forEach((sd, pid) => {
      const snap = prodSnaps.get(pid);
      if (!snap || !snap.exists()) return;
      const st = snap.data().stock || {};
      tx.update(snap.ref, {
        stock: { shelf: Math.max(0, (Number(st.shelf) || 0) + sd.shelf), jt: Math.max(0, (Number(st.jt) || 0) + sd.jt) },
        stockAt: serverTimestamp(),
      });
    });

    const amtText = (w, n) => (w.kit ? `${n} ${w.l.unit}` : plural(n, w.l.unit));
    const changeText = (w) => [
      w.before.amount !== w.amount ? `${amtText(w, w.before.amount)} → ${amtText(w, w.amount)}` : "",
      !w.kit && w.l.doseUnit && w.before.dose !== w.dose ? `${w.before.dose} → ${w.dose} ${w.l.doseUnit} given` : "",
    ].filter(Boolean).join(", ");

    work.filter((w) => w.move).forEach((w) => logMove(tx, staff, {
      type: w.kit ? "kit-correct" : "use-correct", productId: w.l.productId, productName: w.l.name, unit: w.l.unit,
      ...(w.kit ? { staffUid: owner } : {}),
      lines: [{ loc: w.kit ? "kit" : w.loc, batch: w.r.batch || "", expiry: w.r.expiry || "", delta: -w.move }],
      reason: "Usage corrected", ref: id,
      note: [`${u.patientName || ""} · ${u.formName || ""}`, changeText(w), w.kit ? `${ownerName}'s kit` : "", why]
        .filter(Boolean).join(" · ").slice(0, 500),
    }));

    tx.update(uRef, {
      lines,
      short: lines.some((l) => (Number(l.short) || 0) > 0),
      ...(u.original ? {} : { original: u.lines }),
      corrected: true, correctedAt: serverTimestamp(), correctedBy: by, correctedByUid: me,
      corrections: arrayUnion({
        at: new Date().toISOString(), by, byUid: me, reason: why,
        changes: work.map((w) => `${w.l.name}: ${changeText(w)}`),
      }),
    });
  });
}

/* ===================== Investigations: when a count doesn't match the digital count ===================== */
// Step 1: the portal checks its own records. Step 2: someone else recounts, blind.
// Step 3: an admin reviews and closes it. Only outcomes that need it change digital, and every change is logged.

// What happens to a count difference, by default, for each category (each product can override it)
export const INVESTIGATE_DEFAULT = { injectable: "always", treatment: "over", retail: "over", general: "never" };
export const INVESTIGATE_OVER_DEFAULT = 20;

export function investigateRule(p) {
  const mode = ["always", "over", "never"].includes(p && p.investigate) ? p.investigate : (INVESTIGATE_DEFAULT[p && p.category] || "over");
  const over = p && p.investigateOver !== null && p.investigateOver !== undefined ? Number(p.investigateOver) : INVESTIGATE_OVER_DEFAULT;
  return { mode, over };
}

// "over": the difference is worth more than $X at cost. No cost on file: investigated, to be safe.
export function needsInvestigation(p, variance) {
  if (!variance || !p) return false;
  const { mode, over } = investigateRule(p);
  if (mode === "always") return true;
  if (mode === "never") return false;
  const each = p.cost !== null && p.cost !== undefined ? p.cost / Math.max(1, p.packSize) : null;
  return each === null ? true : Math.abs(variance) * each > over;
}

export const INV_STATUS = { recount: "Waiting for a recount", review: "Waiting for admin review", closed: "Closed" };

// adjust: changes digital by the confirmed difference. sign: only offered for a shortage (−1) or extra (+1).
export const INV_OUTCOMES = {
  "count-error": { label: "Count error", adjust: false,
    help: "The stock is there; it was counted wrong. Nothing changes." },
  found: { label: "Found / misplaced", adjust: false,
    help: "It turned up (e.g. put away in the wrong place). Nothing changes." },
  "fixed-record": { label: "Used: fixed on the treatment record", adjust: false,
    help: "Correct the patient's record first (Reporting → Usage → Correct). That already updates digital." },
  "not-recorded": { label: "Used: no treatment record", adjust: true, sign: -1,
    help: "Used but never checked out, and there's no record to correct. Name the patient or treatment in the note." },
  missing: { label: "Missing / loss", adjust: true, sign: -1,
    help: "Can't be found or explained. Written off." },
  receiving: { label: "Receiving error", adjust: true,
    help: "A delivery was put away or entered wrongly. Name the purchase order in the note." },
  extra: { label: "Extra stock found", adjust: true, sign: 1,
    help: "More is there than digital shows. Added to stock." },
  baseline: { label: "Starting stock set", adjust: false, system: true,
    help: "Closed when the starting stock was set from an opening count." },
};

function normaliseInvestigation(d) {
  const x = d.data() || {};
  return {
    id: d.id, ...x,
    digital: Number(x.digital) || 0, counted: Number(x.counted) || 0, variance: Number(x.variance) || 0,
    events: Array.isArray(x.events) ? x.events : [],
    openedAt: toDate(x.openedAt), closedAt: toDate(x.closedAt), updatedAt: toDate(x.updatedAt),
  };
}

// open: only the ones still waiting for a recount or a review. Newest first.
export async function listInvestigations({ open = false } = {}) {
  const col = collection(db, "inv_investigations");
  const snap = await getDocs(open ? query(col, where("status", "in", ["recount", "review"])) : col);
  return snap.docs.map(normaliseInvestigation)
    .sort((a, b) => (b.openedAt ? b.openedAt.getTime() : 0) - (a.openedAt ? a.openedAt.getTime() : 0));
}

export async function getInvestigation(id) {
  const s = await getDoc(doc(db, "inv_investigations", id));
  return s.exists() ? normaliseInvestigation(s) : null;
}

// Step 1: everything since the last count where this spot matched digital (or the last 30 days)
export async function investigationEvidence(x) {
  const countAt = x.openedAt instanceof Date ? x.openedAt : new Date();
  const [counts, moves, shorts, pos, rels, pSnap] = await Promise.all([
    listCounts({ from: dayKey(new Date(countAt.getTime() - 120 * 864e5)) }).catch(() => []),
    listMoves({ productId: x.productId, max: 1000 }).catch(() => []),
    listShortAll().catch(() => []),
    listPos().catch(() => []),
    listReleases(200).catch(() => []),
    getDoc(doc(db, "inv_products", x.productId)).catch(() => null),
  ]);
  const sameSpot = (l) => l.productId === x.productId && l.loc === x.loc
    && (!x.batch || (l.batch === x.batch && (l.expiry || "") === (x.expiry || "")));
  const last = counts.filter((c) => c.id !== x.countId && c.at && c.at < countAt)
    .find((c) => c.lines.some((l) => sameSpot(l) && ["ok", "accepted"].includes(l.status)));
  const since = last ? last.at : new Date(countAt.getTime() - 30 * 864e5);
  const inWindow = (d) => !!d && d > since && d <= countAt;

  const ledger = moves.filter((m) => inWindow(m.at)
    && (x.loc !== "kit" || !x.staffUid || m.byUid === x.staffUid || m.staffUid === x.staffUid)).map((m) => ({
    at: m.at, type: m.type, by: m.by || "", ref: m.ref || "",
    delta: (m.lines || []).filter((l) => l.loc === x.loc && (!x.batch || l.batch === x.batch))
      .reduce((a, l) => a + (Number(l.delta) || 0), 0),
    note: [m.reason, m.note].filter(Boolean).join(" · "),
  })).filter((e) => e.delta).sort((a, b) => a.at - b.at);

  // Bookings for this product's services before the count day, with no treatment record using it.
  // Kit products are skipped: what injectors use comes out of their kit, not the Shelf.
  const isKit = !!(pSnap && pSnap.exists() && pSnap.data().usage === "kit");
  const booked = isKit ? { configured: true, items: [], kit: true }
    : await listUnrecordedTreatments({
      fromKey: dayKey(since), toKey: dayKey(new Date(countAt.getTime() - 864e5)), productId: x.productId,
    }).catch((err) => { console.warn("Booking check failed:", err); return { configured: true, items: [], failed: true }; });

  return {
    since, sinceCount: last || null, countAt, ledger, booked,
    digitalAtSince: x.digital - ledger.reduce((a, e) => a + e.delta, 0),
    short: shorts.filter((u) => inWindow(u.at) && u.lines.some((l) => l.productId === x.productId && Number(l.short) > 0)),
    pos: pos.filter((po) => ["sent", "part"].includes(po.status) && po.lines.some((l) => l.productId === x.productId)),
    rels: rels.filter((r) => r.status === "pending" && r.productId === x.productId),
    people: [...new Set(ledger.map((e) => e.by).filter(Boolean))],
  };
}

// Step 2: the blind recount, by someone other than the first counter (unless an admin allowed it).
// It's compared with digital at the moment of saving. A match closes it as a count error.
export async function saveRecount(id, counted, staff) {
  const n = parseInt(counted, 10);
  if (!(n >= 0)) throw new Error("Enter how many you counted (0 if there are none).");
  const me = uid();
  const by = who(staff);
  const iRef = doc(db, "inv_investigations", id);
  let result = null;
  await runTransaction(db, async (tx) => {
    const s = await tx.get(iRef);
    if (!s.exists()) throw new Error("This investigation no longer exists.");
    const x = s.data();
    if (x.loc === "kit") throw new Error("Kit differences don't have a recount. An admin reviews them.");
    if (x.status !== "recount") throw new Error("The recount has already been done. Reload to see it.");
    if (x.openedByUid === me && x.aloneApproved !== true) {
      throw new Error("Someone else needs to do the recount. If you're the only one on site, ask an admin to allow it.");
    }
    const pSnap = await tx.get(doc(db, "inv_products", x.productId));
    const lSnap = await tx.get(doc(db, "inv_lots", String(x.ref || "")));
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    const p = pSnap.data();
    const digital = p.tracked === true
      ? (lSnap.exists() ? Number(lSnap.data().qty) || 0 : 0)
      : Number((p.stock || {})[x.loc]) || 0;
    const diff = n - digital;
    const at = new Date().toISOString();
    const matched = diff === 0;
    tx.update(iRef, {
      status: matched ? "closed" : "review",
      recount: { counted: n, digital, variance: diff, by, byUid: me, at },
      ...(matched ? {
        outcome: "count-error",
        outcomeNote: "The recount matched the digital count, so the first count was wrong. Stock wasn't changed.",
        closedAt: serverTimestamp(), closedBy: by, closedByUid: me,
      } : {}),
      updatedAt: serverTimestamp(),
      events: arrayUnion({ at, by, action: matched ? "Recount matched digital: closed as a count error" : "Recount confirmed the difference",
        note: `Recounted ${n}, digital ${digital}` }),
    });
    if (!matched) tx.set(doc(collection(db, "notify_outbox")), outboxDoc("investigation.confirmed", { id }, me));
    result = { matched, digital, diff };
  });
  if (!result.matched) pingNotify();
  return result;
}

// Only one person on site: an admin lets the first counter do the recount
export async function allowAloneRecount(id, staff) {
  const by = who(staff);
  await updateDoc(doc(db, "inv_investigations", id), {
    aloneApproved: true, aloneApprovedBy: by, aloneApprovedByUid: uid(), updatedAt: serverTimestamp(),
    events: arrayUnion({ at: new Date().toISOString(), by, action: "Allowed the first counter to recount", note: "Only one person on site" }),
  });
}

// Step 3: an admin closes it. Outcomes that adjust apply the confirmed difference to today's stock
// (like Accept: not "set to the counted number", as stock may have moved since).
export async function closeInvestigation(id, { outcome, note = "", cctvChecked = false, cctvNote = "" }, staff) {
  const o = INV_OUTCOMES[outcome];
  if (!o || o.system) throw new Error("Choose what happened.");
  const text = clip(note, 500);
  if (!text) throw new Error("Add a note saying what you found.");
  const me = uid();
  const by = who(staff);
  const iRef = doc(db, "inv_investigations", id);
  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const s = await tx.get(iRef);
    if (!s.exists()) throw new Error("This investigation no longer exists.");
    const x = s.data();
    if (x.status === "closed") throw new Error("This investigation has already been closed. Reload to see it.");
    const diff = Number(x.recount ? x.recount.variance : x.variance) || 0;
    if (o.sign && Math.sign(diff) !== o.sign) throw new Error(`"${o.label}" doesn't fit a difference of ${diff > 0 ? "+" : ""}${diff}.`);
    const loc = x.loc === "jt" ? "jt" : "shelf";
    let pSnap = null;
    let lSnap = null;
    if (o.adjust && diff && x.loc !== "kit") {   // kits are fixed from Count differences, not here
      pSnap = await tx.get(doc(db, "inv_products", x.productId));
      lSnap = await tx.get(doc(db, "inv_lots", String(x.ref || "")));
      if (!pSnap.exists()) throw new Error("This product no longer exists.");
    }

    // ---- Writes ----
    let applied = 0;
    if (pSnap) {
      const p = pSnap.data();
      const st = p.stock || {};
      const stock = { shelf: Number(st.shelf) || 0, jt: Number(st.jt) || 0 };
      const lotHave = lSnap.exists() ? Number(lSnap.data().qty) || 0 : 0;
      const have = p.tracked === true ? lotHave : stock[loc];
      if (have + diff < 0) {
        throw new Error(`Only ${have} left in ${locLabel(loc)} now, so ${-diff} can't be removed. Do a fresh count, then close this as found or a count error.`);
      }
      stock[loc] = Math.max(0, stock[loc] + diff);
      tx.set(lSnap.ref, {
        productId: x.productId, loc, batch: x.batch || "", expiry: x.expiry || "", qty: Math.max(0, lotHave + diff),
        updatedAt: serverTimestamp(), ...(lSnap.exists() ? {} : { createdAt: serverTimestamp() }),
      }, { merge: true });
      tx.update(pSnap.ref, { stock, stockAt: serverTimestamp() });
      logMove(tx, staff, {
        type: "investigation", productId: x.productId, productName: x.productName, unit: x.unit,
        lines: [{ loc, batch: x.batch || "", expiry: x.expiry || "", delta: diff }],
        reason: o.label.slice(0, 60), note: text, ref: id,
      });
      applied = diff;
    }
    tx.update(iRef, {
      status: "closed", outcome, outcomeNote: text, applied,
      cctv: { checked: cctvChecked === true, note: clip(cctvNote, 500) },
      closedAt: serverTimestamp(), closedBy: by, closedByUid: me, updatedAt: serverTimestamp(),
      events: arrayUnion({ at: new Date().toISOString(), by, action: `Closed: ${o.label}`,
        note: applied ? `${locLabel(loc)} adjusted by ${applied > 0 ? "+" : ""}${applied}` : "Stock not changed" }),
    });
  });
}

/* ===================== Services ⇄ products: "booked, but nothing recorded" ===================== */
// Inventory → Service links says which products each appointment service uses (any one of them counts).
// A booking for a linked service is flagged when no treatment record for that patient uses one of those
// products on the day or within 3 days after. Cancelled, no-show and rescheduled bookings are skipped.

const normSvc = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normPerson = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const keyDate = (k) => { const [y, m, d] = String(k).split("-").map(Number); return new Date(y, m - 1, d); };
const addDaysKey = (k, n) => { const d = keyDate(k); d.setDate(d.getDate() + n); return dayKey(d); };
const NOT_SEEN_RE = /cancel|no.?show|did not (attend|arrive)|\bdna\b|resched/i;
export const serviceKey = normSvc;

export async function getServiceLinks() {
  const s = await getDoc(doc(db, "inv_settings", "service_links"));
  const list = s.exists() && Array.isArray(s.data().links) ? s.data().links : [];
  return list.map((l) => ({
    service: clip(l && l.service, 150),
    productIds: (Array.isArray(l && l.productIds) ? l.productIds : []).map(String).filter(Boolean).slice(0, 40),
  })).filter((l) => l.service && l.productIds.length);
}

export async function saveServiceLinks(links, staff) {
  const seen = new Set();
  const clean = (Array.isArray(links) ? links : []).map((l) => ({
    service: clip(l && l.service, 150),
    productIds: [...new Set((Array.isArray(l && l.productIds) ? l.productIds : []).map((x) => clip(x, 60)).filter(Boolean))].slice(0, 40),
  })).filter((l) => l.service && l.productIds.length && !seen.has(normSvc(l.service)) && seen.add(normSvc(l.service))).slice(0, 400);
  await setDoc(doc(db, "inv_settings", "service_links"), { links: clean, ...stamp(staff) });
}

// Every appointment between two days (inclusive), each with its dateKey
export async function appointmentsBetween(fromKey, toKey) {
  const snap = await getDocs(query(collection(db, "appts_by_day"), where("date", ">=", fromKey), where("date", "<=", toKey)));
  return snap.docs.flatMap((d) => {
    const x = d.data() || {};
    const k = String(x.date || d.id);
    return (Array.isArray(x.appointments) ? x.appointments : []).map((a) => ({ ...a, dateKey: k }));
  });
}

// Services seen in appointments recently, busiest first (for Inventory → Service links)
export async function listServicesSeen(days = 90) {
  const appts = await appointmentsBetween(dayKey(new Date(Date.now() - days * 864e5)), dayKey());
  const m = new Map();
  appts.forEach((a) => (a.services || []).forEach((s) => {
    const k = normSvc(s);
    if (!k) return;
    const c = m.get(k) || { service: String(s).trim(), n: 0 };
    c.n++;
    m.set(k, c);
  }));
  return [...m.values()].sort((a, b) => b.n - a.n);
}

// Bookings with a linked service but no treatment record using one of its products.
// productId: only bookings whose services use this product. Returns { configured, items }.
export async function listUnrecordedTreatments({ fromKey, toKey, productId = "" } = {}) {
  if (!KEY_RE.test(fromKey || "") || !KEY_RE.test(toKey || "") || toKey < fromKey) return { configured: true, items: [] };
  const links = await getServiceLinks();
  if (!links.length) return { configured: false, items: [] };
  const byService = new Map(links.map((l) => [normSvc(l.service), l]));
  const [appts, usage] = await Promise.all([
    appointmentsBetween(fromKey, toKey),
    listUsageBetween(keyDate(fromKey), keyDate(addDaysKey(toKey, 4))),
  ]);
  const items = [];
  appts.forEach((a) => {
    if (NOT_SEEN_RE.test(String(a.status || ""))) return;
    const linked = [...new Set((a.services || []).map((s) => byService.get(normSvc(s))).filter(Boolean))];
    if (!linked.length) return;
    const pids = new Set(linked.flatMap((l) => l.productIds));
    if (productId && !pids.has(productId)) return;
    const aid = String(a.patientId || "").trim().toLowerCase();
    const an = normPerson(a.patientName);
    const lastKey = addDaysKey(a.dateKey, 3);
    const recorded = usage.some((u) => {
      const same = (aid && String(u.patientId || "").trim().toLowerCase() === aid) || (!!an && normPerson(u.patientName) === an);
      if (!same) return false;
      const uk = KEY_RE.test(u.recordDate || "") ? u.recordDate : u.at ? dayKey(u.at) : "";
      return uk >= a.dateKey && uk <= lastKey && u.lines.some((l) => pids.has(l.productId));
    });
    if (!recorded) {
      items.push({
        dateKey: a.dateKey, time: a.time || "", sortMinutes: Number(a.sortMinutes) || 0,
        patientName: a.patientName || "", patientId: a.patientId || "", staff: a.staff || "",
        services: linked.map((l) => l.service), productIds: [...pids],
      });
    }
  });
  items.sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.sortMinutes - b.sortMinutes);
  return { configured: true, items };
}

/* ===================== Shared products: opened once, used across patients (e.g. numbing cream) ===================== */
// Stock counts sealed containers only. Opening one takes it off stock and starts an open container (inv_open).
// Each treatment record logs a use against it until someone marks it finished.

export const isSharedProduct = (p) => !!p && p.usage === "shared";
export const FINISH_REASONS = ["Empty", "Past its use-by date", "Expired", "Contaminated or dropped", "Missing at the opening count", "Other"];

function normaliseOpen(d) {
  const x = d.data() || {};
  return {
    id: d.id, productId: String(x.productId || ""), productName: String(x.productName || ""), unit: String(x.unit || "item"),
    size: Number(x.size) || 0, doseUnit: String(x.doseUnit || ""), perUse: Number(x.perUse) || 0,
    batch: String(x.batch || ""), expiry: String(x.expiry || ""), from: x.from === "jt" ? "jt" : "shelf",
    status: x.status === "finished" ? "finished" : "open",
    uses: Math.max(0, parseInt(x.uses, 10) || 0), used: Number(x.used) || 0,
    useBy: KEY_RE.test(x.useBy || "") ? x.useBy : "",
    openedBy: String(x.openedBy || ""), openedAt: toDate(x.openedAt), lastUsedAt: toDate(x.lastUsedAt),
    finishedBy: String(x.finishedBy || ""), finishedAt: toDate(x.finishedAt), finishReason: String(x.finishReason || ""),
    finishNote: String(x.finishNote || ""),
  };
}

// Open containers, oldest opened first
export async function listOpenContainers({ productId = "" } = {}) {
  const snap = await getDocs(query(collection(db, "inv_open"), where("status", "==", "open")));
  return snap.docs.map(normaliseOpen)
    .filter((c) => !productId || c.productId === productId)
    .sort((a, b) => (a.openedAt ? a.openedAt.getTime() : 0) - (b.openedAt ? b.openedAt.getTime() : 0));
}

// Every container opened in a date range (still open or finished), newest first
export async function listContainersBetween(from, to) {
  const snap = await getDocs(query(collection(db, "inv_open"), where("openedAt", ">=", from), where("openedAt", "<", to)));
  return snap.docs.map(normaliseOpen)
    .sort((a, b) => (b.openedAt ? b.openedAt.getTime() : 0) - (a.openedAt ? a.openedAt.getTime() : 0));
}

// About how many uses a container should give (10 mL ÷ 2 mL = 5), or null
export const expectedUses = (c) => (c && c.size > 0 && c.perUse > 0 ? Math.max(1, Math.round(c.size / c.perUse)) : null);

// "" (fine), "soon" (use-by within 3 days) or "overdue"
export function openState(c) {
  if (!c || !KEY_RE.test(c.useBy || "")) return "";
  const today = dayKey();
  if (c.useBy < today) return "overdue";
  return c.useBy <= addDaysKey(today, 3) ? "soon" : "";
}

function openDocData(productId, pd, { batch = "", expiry = "", loc = "shelf" }, staff, extra = {}) {
  const size = dosePerOf(pd.dosePer) || 0;
  const days = parseInt(pd.openDays, 10) || 0;
  let useBy = days > 0 ? addDaysKey(dayKey(), days) : "";
  if (KEY_RE.test(expiry || "") && (!useBy || expiry < useBy)) useBy = expiry; // never past the batch expiry
  return {
    productId, productName: String(pd.name || ""), unit: String(pd.stockUnit || "item"),
    size, doseUnit: size ? String(pd.doseUnit || "") : "", perUse: dosePerOf(pd.perUse) || 0,
    batch: clip(batch, 40), expiry: KEY_RE.test(expiry || "") ? expiry : "", from: loc === "jt" ? "jt" : "shelf",
    status: "open", uses: 0, used: 0, useBy,
    openedBy: who(staff), openedByUid: uid(), openedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    ...extra,
  };
}

function finishedFields(reason, staff, note = "") {
  return {
    status: "finished", finishReason: clip(reason, 60), finishNote: clip(note, 300),
    finishedAt: serverTimestamp(), finishedBy: who(staff), finishedByUid: uid(), updatedAt: serverTimestamp(),
  };
}

// Open one now (from the product's stock window): 1 comes off that batch
export async function openContainer(product, lot, staff) {
  if (!isSharedProduct(product)) throw new Error("This product isn't set up as shared across patients.");
  if (!lot || !["shelf", "jt"].includes(lot.loc)) throw new Error("Choose which one to open.");
  const pRef = doc(db, "inv_products", product.id);
  const lRef = doc(db, "inv_lots", lot.id);
  const oRef = doc(collection(db, "inv_open"));
  await runTransaction(db, async (tx) => {
    const pSnap = await tx.get(pRef);
    const lSnap = await tx.get(lRef);
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    const have = lSnap.exists() ? Number(lSnap.data().qty) || 0 : 0;
    if (have < 1) throw new Error(`There are none of that one left in ${locLabel(lot.loc)}. Reload and try again.`);
    const pd = pSnap.data();
    const s = pd.stock || {};
    const stock = { shelf: Number(s.shelf) || 0, jt: Number(s.jt) || 0 };
    stock[lot.loc] = Math.max(0, stock[lot.loc] - 1);
    tx.update(lRef, { qty: have - 1, updatedAt: serverTimestamp() });
    tx.update(pRef, { stock, stockAt: serverTimestamp() });
    tx.set(oRef, openDocData(product.id, pd, lot, staff));
    logMove(tx, staff, {
      type: "shared-open", productId: product.id, productName: product.name, unit: product.stockUnit,
      lines: [{ loc: lot.loc, batch: lot.batch || "", expiry: lot.expiry || "", delta: -1 }],
      reason: "Opened for sharing", ref: oRef.id,
    });
  });
  return oRef.id;
}

// Mark an open container finished (empty, past its use-by…). Stock doesn't change: it left stock when it was opened.
export async function finishContainer(c, { reason = "Empty", note = "" }, staff) {
  const why = FINISH_REASONS.includes(reason) ? reason : "Other";
  const text = clip(note, 300);
  if (why === "Other" && !text) throw new Error("Add a note saying why.");
  const ref = doc(db, "inv_open", c.id);
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error("This no longer exists.");
    if (s.data().status !== "open") throw new Error("Someone has already marked this one finished. Reload to see it.");
    const x = normaliseOpen(s);
    const exp = expectedUses(x);
    tx.update(ref, finishedFields(why, staff, text));
    logMove(tx, staff, {
      type: "shared-finish", productId: x.productId, productName: x.productName, unit: x.unit,
      reason: why.slice(0, 60), ref: c.id, uses: x.uses, expectedUses: exp,
      note: [x.batch && `Batch ${x.batch}`, `${x.uses} use${x.uses === 1 ? "" : "s"}${exp ? ` (expected about ${exp})` : ""}`,
        x.used && x.doseUnit ? `${x.used} ${x.doseUnit} recorded` : "", text].filter(Boolean).join(" · ").slice(0, 500),
    });
  });
}

/* ===================== Kit days: Start of Day (and later End of Day) per injector ===================== */
// One document per injector per day: inv_kitdays/<uid>__<YYYY-MM-DD>.
// start: the vial in use and a blind count of the kit (also saved as a kit check, so differences reach Count differences).
// end: added by End of Day later.

export const kitDayId = (staffUid, key) => `${staffUid}__${key}`;

function normaliseKitDay(d) {
  const x = d.data() || {};
  return {
    id: d.id, staffUid: String(x.staffUid || ""), staffName: String(x.staffName || ""), dateKey: String(x.dateKey || ""),
    start: x.start ? { ...x.start, at: toDate(x.start.at), items: Array.isArray(x.start.items) ? x.start.items : [] } : null,
    end: x.end ? { ...x.end, at: toDate(x.end.at), items: Array.isArray(x.end.items) ? x.end.items : [],
      answers: Array.isArray(x.end.answers) ? x.end.answers : [] } : null,
  };
}
// Today's record for the person logged in, or null
export async function getMyKitDay(key = dayKey()) {
  const s = await getDoc(doc(db, "inv_kitdays", kitDayId(uid(), key)));
  return s.exists() ? normaliseKitDay(s) : null;
}

// Batch numbers compared loosely: "a-123 " and "A123" are the same batch
const normBatch = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

// The latest End of Day with kit counts before today (looks back up to 7 days), or null
async function lastKitEnd(me) {
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const s = await getDoc(doc(db, "inv_kitdays", kitDayId(me, dayKey(d))));
    if (!s.exists()) continue;
    const day = normaliseKitDay(s);
    if (day.end && day.end.at && day.end.items.length) return day;
  }
  return null;
}

// Units that physically went in (+) or out (−) of my kit since a moment, per product:
// taken / returned, used on treatment records, discarded, borrowed / lent.
// Admin adjustments (accepted differences, usage corrections) don't move anything physically, so they're left out.
async function kitFlowSince(since, productsById) {
  const me = uid();
  const [moves, loans] = await Promise.all([listMyKitMoves(500), listLoans(200).catch(() => [])]);
  const per = (pid) => Number((productsById.get(pid) || {}).dosePer) || 0;
  const flow = new Map();
  const add = (pid, n) => flow.set(pid, round1((flow.get(pid) || 0) + n));
  const after = (d) => !!d && d > since;
  moves.filter((m) => after(m.at)).forEach((m) => {
    const kitDelta = (m.lines || []).filter((l) => l.loc === "kit").reduce((a, l) => a + (Number(l.delta) || 0), 0);
    if (m.type === "kit-take" || m.type === "kit-return") add(m.productId, kitDelta * per(m.productId)); // vials → units
    else if (m.type === "kit-use") add(m.productId, kitDelta);                                           // already units
    else if (m.type === "kit-discard") {
      let u = Number(m.discardUnits);
      if (!Number.isFinite(u)) u = Math.abs(kitDelta) * per(m.productId);
      add(m.productId, -u);
    }
  });
  loans.filter((l) => after(l.createdAt)).forEach((l) => {
    if (l.toUid === me) add(l.productId, Number(l.units) || 0);
    if (l.fromUid === me) add(l.productId, -(Number(l.units) || 0));
  });
  return flow;
}

// Start of Day: a blind count. The clinician types each batch from the label (nothing is shown to choose from).
// items: [{ productId, rows: [{ batch, expiry, sealed, open, inUse }] }]
// 1. Typed batches are matched to the kit records; any batch in the records that wasn't typed counts as 0.
//    Saved as a kit check, so differences reach Count differences.
// 2. Batches that aren't in the kit records are kept and flagged.
// 3. Overnight: last End of Day + what was recorded since should equal this morning. If not, an investigation opens.
export async function saveKitDayStart({ notInjecting = false, items = [] }, staff) {
  const me = uid();
  const by = who(staff);
  const key = dayKey();
  const ref = doc(db, "inv_kitdays", kitDayId(me, key));

  if (notInjecting) {
    await setDoc(ref, {
      staffUid: me, staffName: by, dateKey: key,
      start: { at: serverTimestamp(), notInjecting: true, items: [], countId: "", differences: 0, overnight: 0 },
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return { notInjecting: true, differences: 0, overnight: 0, unknown: 0 };
  }

  const [products, kits] = await Promise.all([listProducts(), listKits({ mine: true })]);
  const byPid = new Map(products.map((p) => [p.id, p]));
  const lines = [];
  const work = [];

  for (const it of items) {
    const p = byPid.get(it.productId);
    if (!p) continue;
    const lots = kits.filter((k) => k.productId === p.id);
    const tally = new Map(lots.map((k) => [k.id, { k, sealed: 0, open: 0 }]));
    const unknown = [];
    const rows = (Array.isArray(it.rows) ? it.rows : []).map((r) => ({
      batch: clip(r.batch, 40), expiry: KEY_RE.test(r.expiry || "") ? r.expiry : "",
      sealed: Math.max(0, parseInt(r.sealed, 10) || 0), open: round1(Math.max(0, Number(r.open) || 0)),
      inUse: r.inUse === true, ref: "", expiryMismatch: false,
    }));
    rows.forEach((r) => {
      const nb = normBatch(r.batch);
      const same = lots.filter((k) => normBatch(k.batch) === nb);
      const k = same.find((c) => (c.expiry || "") === r.expiry) || same[0] || null;
      if (!k) { unknown.push(r); return; }
      const t = tally.get(k.id);
      t.sealed += r.sealed;
      t.open = round1(t.open + r.open);
      r.ref = k.id;
      r.expiryMismatch = !!r.expiry && !!k.expiry && r.expiry !== k.expiry;
    });
    tally.forEach((t) => lines.push({ ref: t.k.id, sealed: t.sealed, open: t.open }));
    work.push({ p, rows, unknown, lots });
  }
  if (!work.length) throw new Error("Count your kit, or tick “I'm not injecting today”.");

  // 1. Against the kit records
  const count = lines.length ? await saveCount({ kind: "kit", lines, note: "Start of day (blind)" }, staff) : null;
  const byRef = new Map(((count && count.lines) || []).map((l) => [l.ref, l]));

  // 3. Overnight: since the last End of Day
  const lastEnd = await lastKitEnd(me).catch(() => null);
  const flow = lastEnd ? await kitFlowSince(lastEnd.end.at, byPid).catch(() => null) : null;

  const at = new Date().toISOString();
  const batch = writeBatch(db);
  const opened = [];
  const out = work.map(({ p, rows, unknown, lots }) => {
    const unitsOf = (r) => round1(r.sealed * p.dosePer + r.open);
    const lotOut = lots.map((k) => {
      const c = byRef.get(k.id) || {};
      const typed = rows.some((r) => r.ref === k.id);
      return { ref: k.id, batch: k.batch, expiry: k.expiry, typed,
        counted: round1(c.counted), system: round1(c.system), variance: round1(c.variance) };
    });
    const unknownUnits = round1(unknown.reduce((a, r) => a + unitsOf(r), 0));
    const counted = round1(lotOut.reduce((a, l) => a + l.counted, 0) + unknownUnits);
    const system = round1(lotOut.reduce((a, l) => a + l.system, 0));
    const use = rows.find((r) => r.inUse) || null;

    const e = lastEnd ? lastEnd.end.items.find((x) => x.productId === p.id) : null;
    let overnight = { compared: false,
      reason: !lastEnd ? "No End of Day count in the last 7 days" : !e ? "Not counted at the last End of Day" : !flow ? "Couldn't load kit activity" : "" };
    if (lastEnd && e && flow) {
      const endCounted = round1(e.counted);
      const moved = round1(flow.get(p.id) || 0);
      const expected = round1(endCounted + moved);
      const gap = round1(counted - expected);
      overnight = { compared: true, fromDateKey: lastEnd.dateKey, endCounted, moved, expected, gap, investigationId: "" };
      if (Math.abs(gap) >= 0.05) {
        const iRef = doc(collection(db, "inv_investigations"));
        overnight.investigationId = iRef.id;
        opened.push(iRef.id);
        const u = p.doseUnit || "units";
        batch.set(iRef, {
          kind: "kit-overnight", countId: count ? count.id : "", line: -1,
          productId: p.id, productName: p.name, loc: "kit", ref: "", staffUid: me, staffName: by,
          batch: "", expiry: "", batchLabel: p.batchLabel || "Batch", unit: u,
          digital: expected, counted, variance: gap, countNote: "", dateKey: key,
          status: "review", aloneApproved: true,
          overnight: { fromDateKey: lastEnd.dateKey, endCounted, moved, expected },
          openedBy: by, openedByUid: me, openedAt: serverTimestamp(), updatedAt: serverTimestamp(),
          events: [{ at, by, action: "Opened: overnight kit difference",
            note: `End of day ${lastEnd.dateKey}: ${endCounted} ${u}. Recorded since: ${moved >= 0 ? "+" : ""}${moved}. `
              + `Expected ${expected}, counted ${counted} this morning (${gap > 0 ? "+" : ""}${gap}).` }],
        });
      }
    }

    return {
      productId: p.id, productName: p.name, doseUnit: p.doseUnit || "units",
      rows: rows.map(({ batch: b, expiry, sealed, open, inUse, ref: r, expiryMismatch }) =>
        ({ batch: b, expiry, sealed, open, inUse, ref: r, expiryMismatch, units: unitsOf({ sealed, open }) })),
      inUse: use ? { batch: use.batch, expiry: use.expiry, ref: use.ref } : null,
      lots: lotOut, unknown: unknown.map((r) => ({ batch: r.batch, expiry: r.expiry, units: unitsOf(r) })),
      counted, system, variance: round1(counted - system), overnight,
    };
  });

  if (opened.length) {
    batch.set(doc(collection(db, "notify_outbox")), outboxDoc("investigation.opened", { ids: opened, countId: count ? count.id : "" }, me));
  }
  batch.set(ref, {
    staffUid: me, staffName: by, dateKey: key,
    start: { at: serverTimestamp(), notInjecting: false, blind: true, items: out, countId: count ? count.id : "",
      differences: count ? count.lines.filter((l) => l.status !== "ok").length : 0, overnight: opened.length },
    updatedAt: serverTimestamp(),
  }, { merge: true });
  await batch.commit();
  if (opened.length) pingNotify();

  return {
    notInjecting: false,
    differences: count ? count.lines.filter((l) => l.status !== "ok").length : 0,
    overnight: opened.length,
    unknown: out.reduce((a, o) => a + o.unknown.length, 0),
  };
}

// Start of Day with no kit to count (everyone who isn't counting a kit): just the time they started. Once per day.
export async function saveDayStart(staff) {
  const me = uid();
  const key = dayKey();
  const ref = doc(db, "inv_kitdays", kitDayId(me, key));
  const s = await getDoc(ref);
  if (s.exists() && s.data().start) return false;   // already started today
  await setDoc(ref, {
    staffUid: me, staffName: who(staff), dateKey: key,
    start: { at: serverTimestamp(), kit: false, notInjecting: false, items: [], countId: "", differences: 0, overnight: 0 },
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return true;
}

// End of Day: a blind kit count (injectors) and the answers to the admin's questions. Once per day.
// items: [{ productId, productName, doseUnit, usedToday, lots: [{ ref, batch, expiry, sealed, open }] }]
// answers: [{ id, label, type, value, text }]
export async function saveKitDayEnd({ items = [], answers = [] }, staff) {
  const me = uid();
  const by = who(staff);
  const key = dayKey();
  const ref = doc(db, "inv_kitdays", kitDayId(me, key));
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().end) throw new Error("You've already ended today. Reload to see it.");

  const lines = items.flatMap((it) => it.lots.map((l) => ({ ref: l.ref, sealed: l.sealed, open: l.open })));
  const count = lines.length ? await saveCount({ kind: "kit", lines, note: "End of day" }, staff) : null;
  const byRef = new Map(((count && count.lines) || []).map((l) => [l.ref, l]));

  const out = items.map((it) => {
    const lots = it.lots.map((l) => {
      const c = byRef.get(l.ref) || {};
      return {
        ref: l.ref, batch: String(c.batch || l.batch || ""), expiry: String(c.expiry || l.expiry || ""),
        sealed: Math.max(0, parseInt(l.sealed, 10) || 0), open: round1(Math.max(0, Number(l.open) || 0)),
        counted: round1(c.counted), system: round1(c.system), variance: round1(c.variance),
      };
    });
    const sum = (k) => round1(lots.reduce((a, l) => a + (Number(l[k]) || 0), 0));
    return {
      productId: clip(it.productId, 60), productName: clip(it.productName, 150), doseUnit: clip(it.doseUnit, 20) || "units",
      usedToday: round1(it.usedToday), counted: sum("counted"), system: sum("system"), variance: sum("variance"), lots,
    };
  });
  const cleanAnswers = (Array.isArray(answers) ? answers : []).slice(0, 40).map((a) => ({
    id: clip(a.id, 40), label: clip(a.label, 200), type: clip(a.type, 20),
    value: typeof a.value === "number" && Number.isFinite(a.value) ? a.value : clip(a.value, 2000),
    text: clip(a.text, 2000),
  }));
  const differences = count ? count.lines.filter((l) => l.status !== "ok").length : 0;

  await setDoc(ref, {
    staffUid: me, staffName: by, dateKey: key,
    end: { at: serverTimestamp(), items: out, answers: cleanAnswers, countId: count ? count.id : "", differences },
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return { differences, items: out };
}

// Every kit day between two dates (from inclusive, to exclusive), newest first. Admin / Reporting.
export async function listKitDays(from, to) {
  const snap = await getDocs(query(collection(db, "inv_kitdays"),
    where("dateKey", ">=", dayKey(from)), where("dateKey", "<", dayKey(to))));
  return snap.docs.map(normaliseKitDay).sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.staffName.localeCompare(b.staffName));
}