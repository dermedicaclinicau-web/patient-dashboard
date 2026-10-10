// Inventory: suppliers, products, stock batches and the stock movement log (Firestore).
// Stock is kept as batches ("lots") per storage; each product also keeps a running total per storage.
// Every stock change updates the batch, the total and the activity log together, in one transaction.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, getDoc, addDoc, setDoc, updateDoc, query, where, orderBy, limit, runTransaction,
  serverTimestamp, arrayUnion, arrayRemove, writeBatch,
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
  return {
    name: clip(p.name, 150),
    category: INV_CATEGORIES.some((c) => c.key === p.category) ? p.category : "general",
    brand: clip(p.brand, 80),
    supplierId: clip(p.supplierId, 60),
    supplierCode: clip(p.supplierCode, 60),
    barcode: clip(p.barcode, 60),
    stockUnit: clip(l.stockUnit, 30) || "unit",
    dosePer: dosePerOf(l.dosePer),
    doseUnit: dosePerOf(l.dosePer) ? (clip(l.doseUnit, 20) || "units") : "",    
    orderUnit: clip(p.orderUnit, 30) || "box",
    dosePer: dosePerOf(p.dosePer),
    doseUnit: dosePerOf(p.dosePer) ? (clip(p.doseUnit, 20) || "units") : "",
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

/* ===================== Order requests ===================== */

export const REQ_STATUS = { open: "Open", ordered: "Ordered", declined: "Declined", cancelled: "Cancelled" };
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
    packSize: p.packSize, stockUnit: p.stockUnit, unitCost: p.cost, loc, sources,
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