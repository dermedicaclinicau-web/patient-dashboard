// Inventory: suppliers, products, stock batches and the stock movement log (Firestore).
// Stock is kept as batches ("lots") per storage; each product also keeps a running total per storage.
// Every stock change updates the batch, the total and the activity log together, in one transaction.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, getDoc, addDoc, setDoc, updateDoc, query, where, orderBy, limit, runTransaction,
  serverTimestamp, arrayUnion, arrayRemove, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

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
  "kit-borrow": "Borrowed from a colleague",
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

export function cleanProduct(p = {}) {
  const r = p.reorder || {};
  const dosePer = dosePerOf(p.dosePer);
  return {
    name: clip(p.name, 150),
    category: INV_CATEGORIES.some((c) => c.key === p.category) ? p.category : "general",
    brand: clip(p.brand, 80),
    supplierId: clip(p.supplierId, 60),
    supplierCode: clip(p.supplierCode, 60),
    barcode: clip(p.barcode, 60),
    stockUnit: clip(p.stockUnit, 30) || "item",
    orderUnit: clip(p.orderUnit, 30) || "box",
    dosePer,
    doseUnit: dosePer ? (clip(p.doseUnit, 20) || "units") : "",
    usage: p.usage === "kit" ? "kit" : "storage",
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
  if (clean.usage === "kit" && !clean.dosePer) throw new Error("Kit products need a dose, e.g. 100 units in each vial.");
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

export function lineFromProduct(p, qty, loc, sources = []) {
  return cleanPoLine({
    productId: p.id, name: p.name, supplierCode: p.supplierCode, qty, orderUnit: p.orderUnit,
    packSize: p.packSize, stockUnit: p.stockUnit, dosePer: p.dosePer, doseUnit: p.doseUnit,
    unitCost: p.cost, loc, sources,
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
        throw new Error(`${p.name} needs a batch number and expiry date for each batch.`);
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

    result = { status, number: po.number, requestIds: po.requestIds };
  });
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
}

/* ===================== Products used in treatments ===================== */
// lines: [{ fid, productId, name, kind: "kit"|"storage", unit, loc, block, rows: [{ ref, batch, expiry, amount }] }]
// Runs inside the transaction that saves the treatment record (reads first, then writes).
// Stock never goes below zero: anything missing is saved as "short" so the team can sort it out.
// The record always keeps the amount given to the patient.
export async function consumeInTx(tx, { submissionId, lines, patientId, patientName, formName, recordDate, staff }) {
  const me = uid();
  const kitSnaps = new Map(), lotSnaps = new Map(), prodSnaps = new Map();
  for (const l of lines) {
    for (const r of l.rows) {
      if (!r.ref) continue;
      if (l.kind === "kit") { if (!kitSnaps.has(r.ref)) kitSnaps.set(r.ref, await tx.get(doc(db, "inv_kits", r.ref))); }
      else if (!lotSnaps.has(r.ref)) lotSnaps.set(r.ref, await tx.get(doc(db, "inv_lots", r.ref)));
    }
    if (l.kind !== "kit" && !prodSnaps.has(l.productId)) prodSnaps.set(l.productId, await tx.get(doc(db, "inv_products", l.productId)));
  }

  const kits = new Map(), lots = new Map();
  const out = lines.map((l) => {
    const rows = l.rows.map((r) => {
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
      const dose = l.kind === "kit" ? want : Math.round(Math.max(0, Number(r.dose) || 0) * 100) / 100;
      return { ref: r.ref || "", batch: clip(r.batch, 40), expiry: KEY_RE.test(r.expiry || "") ? r.expiry : "", amount: want, taken, from, dose };
    });
    const total = round1(rows.reduce((a, r) => a + r.amount, 0));
    const short = round1(rows.reduce((a, r) => a + (r.amount - r.taken), 0));
    return { fid: l.fid, productId: clip(l.productId, 60), name: clip(l.name, 150), kind: l.kind === "kit" ? "kit" : "storage",
      unit: clip(l.unit, 30), doseUnit: clip(l.doseUnit || "", 20), doseTotal: Math.round(rows.reduce((a, r) => a + r.dose, 0) * 100) / 100,
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
      if (!r.taken) return;
      stock[r.from] = Math.max(0, stock[r.from] - r.taken);
      touched = true;
    }));
    if (touched) tx.update(snap.ref, { stock, stockAt: serverTimestamp() });
  });
  out.forEach((l) => {
    const moved = l.rows.filter((r) => r.taken);
    if (!moved.length) return;
    logMove(tx, staff, {
      type: l.kind === "kit" ? "kit-use" : "use", productId: l.productId, productName: l.name, unit: l.unit,
      lines: moved.map((r) => ({ loc: r.from, batch: r.batch, expiry: r.expiry, delta: -r.taken })),
      reason: "Treatment", note: `${patientName} · ${formName}`.slice(0, 500), ref: submissionId,
    });
  });

  const saved = out.map(({ fid, block, ...l }) => ({ ...l, rows: l.rows.map(({ ref, ...r }) => r) }));
  tx.set(doc(collection(db, "inv_usage")), {
    submissionId, patientId: clip(patientId, 150), patientName: clip(patientName, 150), formName: clip(formName, 150),
    recordDate: KEY_RE.test(recordDate || "") ? recordDate : "", lines: saved, short: saved.some((l) => l.short > 0),
    by: who(staff), byUid: me, at: serverTimestamp(),
  });

  const answers = {};
  out.forEach(({ fid }, i) => { (answers[fid] = answers[fid] || { lines: [] }).lines.push(saved[i]); });
  return { answers };
}

// Treatment records saved without enough stock (last 30 days)
export async function listShortUsage() {
  const snap = await getDocs(query(collection(db, "inv_usage"), where("short", "==", true)));
  const since = Date.now() - 30 * 864e5;
  return snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) }; })
    .filter((u) => u.at && u.at.getTime() > since)
    .sort((a, b) => b.at - a.at);
}