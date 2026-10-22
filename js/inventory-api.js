// Inventory: suppliers, products, stock batches and the stock movement log (Firestore).
// Stock is kept as batches ("lots") per storage; each product also keeps a running total per storage.
// Every stock change updates the batch, the total and the activity log together, in one transaction.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc, query, where, orderBy, limit, runTransaction,
  serverTimestamp, arrayUnion, arrayRemove, writeBatch, Timestamp,
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
  "vial-open": "Vial opened (storage)",
  baseline: "Starting stock set",
  sale: "Sold",
  tracking: "Batch & expiry changed",
  undo: "Undone",
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
    // Purchase order email template (Supplier → Purchase order email). Empty = the standard wording.
    emailSubject: clip(s.emailSubject, 200),
    emailBody: String(s.emailBody ?? "").replace(/\r\n/g, "\n").trim().slice(0, 5000),
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

/* ---------- Turning batch & expiry on or off for a product that already has stock ---------- */
// The totals never change. On: the plain amount in each place becomes the batches typed in (they must add up).
// Off: every batch in each place is added together into one plain amount. One transaction, logged in Activity.
// splits (on only): [{ loc, batch, expiry, qty }]
export async function setTracking(product, on, splits, staff) {
  const by = who(staff);
  const byUid = uid();
  const pRef = doc(db, "inv_products", product.id);
  const plainId = (loc) => lotId(product.id, loc, "", "");
  const label = batchName(product).toLowerCase();

  const want = new Map();
  let ids;
  if (on) {
    (Array.isArray(splits) ? splits : []).forEach((s) => {
      const loc = s.loc === "jt" ? "jt" : "shelf";
      const batch = clip(s.batch, 40);
      const expiry = KEY_RE.test(s.expiry || "") ? s.expiry : "";
      const qty = parseInt(s.qty, 10);
      if (!batch || !expiry) throw new Error(`Each ${label} needs its number and expiry date.`);
      if (!(qty >= 1)) throw new Error(`Each ${label} needs how many (1 or more).`);
      const id = lotId(product.id, loc, batch, expiry);
      const w = want.get(id) || { loc, batch, expiry, qty: 0 };
      w.qty += qty;
      want.set(id, w);
    });
    if (!want.size) throw new Error(`Enter at least one ${label}.`);
    ids = [...new Set([plainId("shelf"), plainId("jt"), ...want.keys()])];
  } else {
    const snap = await getDocs(query(collection(db, "inv_lots"), where("productId", "==", product.id)));
    ids = [...new Set([plainId("shelf"), plainId("jt"), ...snap.docs.map((d) => d.id)])];
  }

  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    const snaps = new Map();
    for (const id of ids) snaps.set(id, await tx.get(doc(db, "inv_lots", id)));
    const pd = pSnap.data();
    if ((pd.tracked === true) === on) throw new Error("Someone has just changed this. Reload and try again.");
    const s = pd.stock || {};
    const stock = { shelf: Number(s.shelf) || 0, jt: Number(s.jt) || 0 };
    const unit = String(pd.stockUnit || product.stockUnit || "item");

    // ---- Writes ----
    const lines = [];
    const put = (id, d, qty) => {
      const sn = snaps.get(id);
      tx.set(doc(db, "inv_lots", id), {
        productId: product.id, loc: d.loc, batch: d.batch, expiry: d.expiry, qty,
        updatedAt: serverTimestamp(), ...(sn && sn.exists() ? {} : { createdAt: serverTimestamp() }),
      }, { merge: true });
    };

    if (on) {
      LOCATIONS.forEach(({ key }) => {
        const typed = [...want.values()].filter((w) => w.loc === key).reduce((a, w) => a + w.qty, 0);
        if (typed !== stock[key]) {
          throw new Error(`${locLabel(key)} has ${plural(stock[key], unit)}, but ${typed} have been entered. They need to add up. ` +
            "If stock has just been used, close this, reload and try again.");
        }
      });
      LOCATIONS.forEach(({ key }) => {
        const sn = snaps.get(plainId(key));
        if (sn.exists() && Number(sn.data().qty)) tx.update(sn.ref, { qty: 0, updatedAt: serverTimestamp() });
        if (stock[key]) lines.push({ loc: key, batch: "", expiry: "", delta: -stock[key] });
      });
      want.forEach((w, id) => {
        const sn = snaps.get(id);
        put(id, w, (sn.exists() ? Number(sn.data().qty) || 0 : 0) + w.qty);
        lines.push({ loc: w.loc, batch: w.batch, expiry: w.expiry, delta: w.qty });
      });
    } else {
      snaps.forEach((sn, id) => {
        if (!sn.exists() || id === plainId("shelf") || id === plainId("jt")) return;
        const d = sn.data();
        const q = Number(d.qty) || 0;
        if (!q) return;
        tx.update(sn.ref, { qty: 0, updatedAt: serverTimestamp() });
        lines.push({ loc: d.loc === "jt" ? "jt" : "shelf", batch: String(d.batch || ""), expiry: String(d.expiry || ""), delta: -q });
      });
      LOCATIONS.forEach(({ key }) => {
        if (stock[key] || snaps.get(plainId(key)).exists()) put(plainId(key), { loc: key, batch: "", expiry: "" }, stock[key]);
        if (stock[key]) lines.push({ loc: key, batch: "", expiry: "", delta: stock[key] });
      });
    }

    tx.update(pRef, { tracked: on, updatedAt: serverTimestamp(), updatedBy: by, updatedByUid: byUid });
    tx.set(doc(collection(db, "inv_moves")), {
      type: "tracking", productId: product.id, productName: String(pd.name || product.name), unit,
      lines, reason: on ? "Batch & expiry turned on" : "Batch & expiry turned off", note: "Totals unchanged", ref: "",
      by, byUid, at: serverTimestamp(),
    });
  });
}


// Corrects a batch's number and/or expiry (a typo, a wrong date). The quantity doesn't change.
// both: also correct the same batch in the other place. A batch that already exists with the new details is added to.
export async function correctLot(product, lot, { batch, expiry, both = true }, staff) {
  const nb = clip(batch, 40);
  const ne = KEY_RE.test(expiry || "") ? expiry : "";
  if (!nb) throw new Error(`Enter the ${batchName(product).toLowerCase()} number.`);
  if (!ne) throw new Error("Enter the expiry date.");
  if (nb === lot.batch && ne === lot.expiry) throw new Error("Nothing has changed.");
  const by = who(staff);
  const byUid = uid();
  const pRef = doc(db, "inv_products", product.id);
  const pairs = (both ? ["shelf", "jt"] : [lot.loc]).map((loc) => ({
    loc,
    fromRef: doc(db, "inv_lots", lotId(product.id, loc, lot.batch, lot.expiry)),
    toRef: doc(db, "inv_lots", lotId(product.id, loc, nb, ne)),
  }));

  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    if (pSnap.data().tracked !== true) throw new Error("This product doesn't track batch and expiry.");
    for (const x of pairs) {
      x.from = await tx.get(x.fromRef);
      x.to = x.toRef.id === x.fromRef.id ? x.from : await tx.get(x.toRef);
    }

    // ---- Writes ----
    const lines = [];
    pairs.forEach((x) => {
      const q = x.from.exists() ? Number(x.from.data().qty) || 0 : 0;
      if (q <= 0) return;
      if (x.toRef.id === x.fromRef.id) {
        // Only capitals or spacing changed: the same document, new wording
        tx.update(x.fromRef, { batch: nb, expiry: ne, updatedAt: serverTimestamp() });
      } else {
        const have = x.to.exists() ? Number(x.to.data().qty) || 0 : 0;
        tx.set(x.toRef, {
          productId: product.id, loc: x.loc, batch: nb, expiry: ne, qty: have + q,
          updatedAt: serverTimestamp(), ...(x.to.exists() ? {} : { createdAt: serverTimestamp() }),
        }, { merge: true });
        tx.update(x.fromRef, { qty: 0, updatedAt: serverTimestamp() });
      }
      lines.push({ loc: x.loc, batch: lot.batch, expiry: lot.expiry, delta: -q }, { loc: x.loc, batch: nb, expiry: ne, delta: q });
    });
    if (!lines.length) throw new Error("That batch has no stock left. Reload and try again.");
    tx.set(doc(collection(db, "inv_moves")), {
      type: "tracking", productId: product.id, productName: String(pSnap.data().name || product.name),
      unit: String(pSnap.data().stockUnit || product.stockUnit || "item"), lines,
      reason: "Batch details corrected",
      note: `${lot.batch || "-"} (exp ${lot.expiry || "-"}) → ${nb} (exp ${ne}) · totals unchanged`.slice(0, 500),
      ref: "", by, byUid, at: serverTimestamp(),
    });
  });
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
  const list = snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, at: toDate(x.at) }; })
    .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
  // Write-offs that have since been undone are marked, so they show as Undone
  const undone = new Set(list.filter((m) => m.type === "undo").map((m) => String(m.undoOf || "")));
  return list.map((m) => (undone.has(m.id) ? { ...m, undone: true } : m)).slice(0, max);
}

// Every write-off that has been undone (their ids)
export async function undoneWriteoffs() {
  const snap = await getDocs(query(collection(db, "inv_moves"), where("type", "==", "undo")));
  return new Set(snap.docs.map((d) => String(d.data().undoOf || "")).filter(Boolean));
}

// Activity between two dates, optionally only some types (e.g. ["kit-discard", "writeoff"]).
// Asking for write-offs (wastage): ones that were undone are left out.
export async function listMovesBetween(from, to, types = null) {
  const snap = await getDocs(query(collection(db, "inv_moves"), where("at", ">=", from), where("at", "<", to)));
  let list = snap.docs
    .map((d) => { const x = d.data() || {}; return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) }; })
    .filter((m) => !types || types.includes(m.type))
    .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
  if (types && types.includes("writeoff")) {
    const undone = await undoneWriteoffs();
    list = list.filter((m) => !(m.type === "writeoff" && undone.has(m.id)));
  }
  return list;
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
    // The date the order was placed (can be backdated). Older orders: the day they were created.
    orderDate: KEY_RE.test(x.orderDate || "") ? x.orderDate : (toDate(x.createdAt) ? dayKey(toDate(x.createdAt)) : ""),
    backdated: x.backdated === true,
    sentDate: KEY_RE.test(x.sentDate || "") ? x.sentDate : "",   // set when "Mark as sent" was backdated
    historical: x.historical === true,   // received before the portal: recorded only, stock never changed
    receivedDate: KEY_RE.test(x.receivedDate || "") ? x.receivedDate : "",
    extras: Array.isArray(x.extras) ? x.extras : [],   // came in a delivery but weren't ordered
  };
}

export async function listPos() {
  const snap = await getDocs(collection(db, "inv_pos"));
  return snap.docs.map(normalisePo)
    .sort((a, b) => (b.orderDate || "").localeCompare(a.orderDate || "")
      || (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0));
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

// "PO-DHL-10142026": the supplier's first 3 letters + the date created (MMDDYYYY)
export function poNumberBase(supplierName, d = new Date()) {
  const code = (String(supplierName || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "SUP").padEnd(3, "X");
  const p2 = (n) => String(n).padStart(2, "0");
  return `PO-${code}-${p2(d.getMonth() + 1)}${p2(d.getDate())}${d.getFullYear()}`;
}
// The next free number for a base: the first is the base itself, then -2, -3…
function nextPoNumber(countersSnap, base) {
  const seq = countersSnap.exists() && countersSnap.data().poSeq ? Number(countersSnap.data().poSeq[base]) || 0 : 0;
  const n = seq + 1;
  return { n, number: n > 1 ? `${base}-${n}` : base };
}

// A new draft PO with the next number. The requests it covers are linked to it.
// orderDate (YYYY-MM-DD, optional): when the order was placed, for orders brought over from the old app.
// Today or earlier; the number is built from it. createdAt always stays the real moment it was entered.
export async function createPo({ supplier, lines = [], orderDate = "" }, staff) {
  if (!supplier || !supplier.id) throw new Error("Choose a supplier.");
  const today = dayKey();
  const dated = orderDate ? String(orderDate) : today;
  if (!KEY_RE.test(dated)) throw new Error("Check the order date.");
  if (dated > today) throw new Error("The order date can't be in the future.");
  const backdated = dated < today;
  const clean = lines.map(cleanPoLine);
  const requestIds = [...new Set(clean.flatMap((l) => l.sources.map((s) => s.r)))].slice(0, 50);
  const by = String((staff && staff.name) || "").slice(0, 120);
  const byUid = uid();
  const at = new Date().toISOString();
  const cRef = doc(db, "inv_settings", "counters");
  const poRef = doc(collection(db, "inv_pos"));
  await runTransaction(db, async (tx) => {
    const c = await tx.get(cRef);
    const base = poNumberBase(supplier.name, keyDate(dated));
    const { n, number } = nextPoNumber(c, base);
    tx.set(cRef, { poSeq: { [base]: n } }, { merge: true });
    tx.set(poRef, {
      number, supplierId: supplier.id, supplier: supplierSnapshot(supplier), status: "draft",
      lines: clean, requestIds, expectedDate: "", notesToSupplier: "", internalNote: "", gst: false,
      total: poTotals({ lines: clean }).total, orderDate: dated, backdated,
      createdBy: by, createdByUid: byUid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: by,
      events: [{ at, by, action: "Created", note: [
        backdated ? `Dated ${dated} (entered ${today})` : "",
        requestIds.length ? `From ${requestIds.length} request${requestIds.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" · ") }],
    });
    requestIds.forEach((rid) => tx.update(doc(db, "inv_requests", rid), {
      poIds: arrayUnion(poRef.id), poNumbers: arrayUnion(number), updatedAt: serverTimestamp(),
      events: arrayUnion({ at, by, action: "Added to purchase order", note: number }),
    }));
  });
  return poRef.id;
}

// A draft's editable parts (empty rows are dropped). po.orderDate (optional) changes the order date;
// call renumberPo afterwards so the number follows it.
export async function savePo(id, po, staff) {
  const lines = (po.lines || []).filter((l) => l.productId || String(l.name || "").trim()).map(cleanPoLine);
  const data = {
    supplierId: clip(po.supplierId, 60),
    supplier: supplierSnapshot(po.supplier || {}),
    lines,
    expectedDate: KEY_RE.test(po.expectedDate || "") ? po.expectedDate : "",
    notesToSupplier: clip(po.notesToSupplier, 2000),
    internalNote: clip(po.internalNote, 1000),
    gst: po.gst === true,
    total: poTotals({ lines, gst: po.gst === true }).total,
    ...stamp(staff),
  };
  if (po.orderDate !== undefined && po.orderDate !== "") {
    const today = dayKey();
    if (!KEY_RE.test(po.orderDate) || po.orderDate > today) throw new Error("Check the order date: it can't be in the future.");
    // Backdated = earlier than the day it was entered (not just "before today")
    const made = po.createdAt instanceof Date && !isNaN(po.createdAt) ? dayKey(po.createdAt) : today;
    data.orderDate = po.orderDate;
    data.backdated = po.orderDate < made;
  }
  await updateDoc(doc(db, "inv_pos", id), data);
}

// A draft whose supplier changed gets a number for the new supplier (same creation date).
// Sent orders never change number. The requests on it are updated too. Returns the number.
export async function renumberPo(id, staff) {
  const pRef = doc(db, "inv_pos", id);
  const cRef = doc(db, "inv_settings", "counters");
  const by = who(staff);
  let number = "";
  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const s = await tx.get(pRef);
    if (!s.exists()) throw new Error("This purchase order no longer exists.");
    const po = normalisePo(s);
    number = po.number;
    if (po.status !== "draft") return;
    const base = poNumberBase(po.supplier.name, po.orderDate ? keyDate(po.orderDate) : (po.createdAt || new Date()));
    if (po.number === base || po.number.startsWith(`${base}-`)) return;   // already right
    const c = await tx.get(cRef);
    const reqSnaps = [];
    for (const rid of po.requestIds) reqSnaps.push(await tx.get(doc(db, "inv_requests", rid)));

    // ---- Writes ----
    const next = nextPoNumber(c, base);
    const old = po.number;
    number = next.number;
    tx.set(cRef, { poSeq: { [base]: next.n } }, { merge: true });
    tx.update(pRef, {
      number, updatedAt: serverTimestamp(), updatedBy: by,
      events: arrayUnion({ at: new Date().toISOString(), by, action: "Renumbered", note: `${old} → ${number} (supplier or date changed)` }),
    });
    reqSnaps.forEach((r) => {
      if (!r.exists()) return;
      const list = Array.isArray(r.data().poNumbers) ? r.data().poNumbers : [];
      tx.update(r.ref, { poNumbers: list.map((x) => (x === old ? number : x)), updatedAt: serverTimestamp() });
    });
  });
  return number;
}

// Ordered another way (phone, website). Returns the request ids that became "Ordered".
// sentDate (YYYY-MM-DD, optional): when it was really sent, for orders brought over from the old app
export async function markPoSent(po, { via = "", note = "", sentDate = "" }, staff) {
  const by = String((staff && staff.name) || "").slice(0, 120);
  const at = new Date().toISOString();
  const today = dayKey();
  if (sentDate && (!KEY_RE.test(sentDate) || sentDate > today)) throw new Error("Check the date it was sent: it can't be in the future.");
  if (sentDate && po.orderDate && sentDate < po.orderDate) throw new Error("It can't have been sent before its order date.");
  const earlier = !!sentDate && sentDate < today;
  const all = (await listPos()).map((x) => (x.id === po.id ? { ...x, status: "sent" } : x));
  const reqSnaps = await Promise.all(po.requestIds.map((rid) => getDoc(doc(db, "inv_requests", rid))));
  const batch = writeBatch(db);
  batch.update(doc(db, "inv_pos", po.id), {
    status: "sent", sentBy: by, sentVia: clip(via, 40), updatedAt: serverTimestamp(), updatedBy: by,
    // Midday that day, so the date never shifts with time zones
    sentAt: earlier ? Timestamp.fromDate(new Date(`${sentDate}T12:00:00`)) : serverTimestamp(),
    sentDate: earlier ? sentDate : "",
    events: arrayUnion({ at, by, action: "Marked as sent", note: [
      earlier ? `Sent ${sentDate} (recorded ${today})` : "", via, note,
    ].filter(Boolean).join(" · ").slice(0, 300) }),
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

// Changing an order after it was sent (wrong item or quantity). One transaction: the order, its history and its requests.
// Lines with stock received can't be removed, go below what arrived, or change product / pack.
// "received" always comes from the order itself, never from the browser. The number and supplier never change.
export async function amendPo(poId, { lines, expectedDate, notesToSupplier, internalNote, gst, reason }, staff) {
  const why = clip(reason, 300);
  if (!why) throw new Error("Add a reason for the change, e.g. Wrong quantity entered.");
  const by = who(staff);
  const poRef = doc(db, "inv_pos", poId);
  let result = null;

  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const s = await tx.get(poRef);
    if (!s.exists()) throw new Error("This purchase order no longer exists.");
    const po = normalisePo(s);
    if (!["sent", "part"].includes(po.status)) {
      throw new Error(`This order is ${PO_STATUS[po.status].toLowerCase()}, so it can't be changed here.`);
    }
    if (po.historical) throw new Error("This order was recorded from before the portal, so it can't be changed.");
    const reqSnaps = [];
    for (const rid of po.requestIds) reqSnaps.push(await tx.get(doc(db, "inv_requests", rid)));

    // ---- Check the new lines against the order ----
    const next = (Array.isArray(lines) ? lines : [])
      .filter((l) => l.productId || String(l.name || "").trim()).map(cleanPoLine);
    if (!next.length) throw new Error("An order needs at least one item. To call it off, cancel the order instead.");
    const keys = new Set();
    next.forEach((l) => { while (keys.has(l.key)) l.key = Math.random().toString(36).slice(2, 10); keys.add(l.key); });
    const oldBy = new Map(po.lines.map((l) => [l.key, l]));
    const amt = (l, n) => plural(n, l.orderUnit);

    po.lines.forEach((o) => {
      if (o.received > 0 && !keys.has(o.key)) {
        throw new Error(`${o.name}: ${amt(o, o.received)} already arrived, so it can't be removed.`);
      }
    });
    next.forEach((l) => {
      const o = oldBy.get(l.key);
      l.received = o ? o.received : 0;
      if (!o || !o.received) return;
      if (l.qty < o.received) throw new Error(`${o.name}: ${amt(o, o.received)} already arrived, so it can't be less than that.`);
      if (l.productId !== o.productId || l.packSize !== o.packSize) {
        throw new Error(`${o.name}: some has already arrived, so its product and pack can't change. Change the quantity, or add a new line.`);
      }
    });

    // ---- What changed (for the history) ----
    const money = (n) => (n === null || n === undefined ? "no price" : `$${Number(n).toFixed(2)}`);
    const changes = [];
    po.lines.forEach((o) => {
      const l = next.find((x) => x.key === o.key);
      if (!l) { changes.push(`Removed ${o.name} (${amt(o, o.qty)})`); return; }
      if (l.productId !== o.productId || l.name !== o.name) changes.push(`${o.name} → ${l.name}`);
      if (l.qty !== o.qty) changes.push(`${l.name}: ${o.qty} → ${l.qty}`);
      if ((l.unitCost ?? null) !== (o.unitCost ?? null)) changes.push(`${l.name}: ${money(o.unitCost)} → ${money(l.unitCost)}`);
      if (l.loc !== o.loc) changes.push(`${l.name}: for ${locLabel(o.loc)} → ${locLabel(l.loc)}`);
    });
    next.forEach((l) => { if (!oldBy.has(l.key)) changes.push(`Added ${l.name} (${amt(l, l.qty)})`); });
    const exp = KEY_RE.test(expectedDate || "") ? expectedDate : "";
    const nts = clip(notesToSupplier, 2000), inn = clip(internalNote, 1000), g = gst === true;
    if (exp !== po.expectedDate) changes.push(`Needed by: ${po.expectedDate || "none"} → ${exp || "none"}`);
    if (nts !== po.notesToSupplier) changes.push("Notes to supplier changed");
    if (inn !== po.internalNote) changes.push("Internal note changed");
    if (g !== po.gst) changes.push(g ? "GST added" : "GST removed");
    if (!changes.length) throw new Error("Nothing has changed.");

    // ---- Requests: items taken off this order ----
    const had = new Set(po.lines.flatMap((l) => l.sources.map((x) => `${x.r}:${x.i}`)));
    const has = new Set(next.flatMap((l) => l.sources.map((x) => `${x.r}:${x.i}`)));
    const lost = new Set([...had].filter((k) => !has.has(k)).map((k) => k.split(":")[0]));
    const stillIds = [...new Set(next.flatMap((l) => l.sources.map((x) => x.r)))];

    const allIn = next.every((l) => l.received >= l.qty);
    const status = allIn ? "received" : po.status;
    const at = new Date().toISOString();

    // ---- Writes ----
    tx.update(poRef, {
      lines: next, status, requestIds: stillIds, expectedDate: exp, notesToSupplier: nts, internalNote: inn, gst: g,
      total: poTotals({ lines: next, gst: g }).total,
      ...(status === "received" ? { receivedAt: serverTimestamp() } : {}),
      amendedAt: serverTimestamp(), amendedBy: by, amendCount: (Number(s.data().amendCount) || 0) + 1,
      updatedAt: serverTimestamp(), updatedBy: by,
      events: arrayUnion({ at, by, action: status === "received" ? "Changed (now fully received)" : "Changed after sending",
        note: `${why} · ${changes.join(" · ")}`.slice(0, 300) }),
    });

    const reopened = [];
    reqSnaps.forEach((r) => {
      if (!r.exists() || !lost.has(r.id)) return;
      const gone = !stillIds.includes(r.id);
      const back = r.data().status === "ordered";
      if (back) reopened.push(r.id);
      tx.update(r.ref, {
        ...(gone ? { poIds: arrayRemove(poId), poNumbers: arrayRemove(po.number) } : {}),
        ...(back ? { status: "open", response: "" } : {}),
        updatedAt: serverTimestamp(),
        events: arrayUnion({ at, by, action: back ? "Back to open: taken off the purchase order" : "Item taken off the purchase order",
          note: `${po.number} · ${why}`.slice(0, 300) }),
      });
    });

    result = { status, changes, number: po.number, requestIds: stillIds, reopened };
  });
  return result;
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

// Admin: an order sent and received before the portal, recorded for history only.
// Every line is marked fully received. No stock, activity log or notifications: the stock is already in the counts.
// Drafts need the date they were sent; sent orders keep theirs. Returns { number, requestIds }.
export async function recordPastReceipt(poId, { sentDate = "", receivedDate, receivedBy = "", docketNo = "", note = "" }, staff) {
  const today = dayKey();
  if (!KEY_RE.test(receivedDate || "") || receivedDate > today) throw new Error("Check the date it was received: it can't be in the future.");
  const by = who(staff);
  const byUid = uid();
  const poRef = doc(db, "inv_pos", poId);
  const recRef = doc(collection(db, "inv_receipts"));
  const noon = (k) => Timestamp.fromDate(new Date(`${k}T12:00:00`));   // midday, so the date never shifts with time zones
  let result = null;

  await runTransaction(db, async (tx) => {
    const s = await tx.get(poRef);
    if (!s.exists()) throw new Error("This purchase order no longer exists.");
    const po = normalisePo(s);
    const draft = po.status === "draft";
    if (!draft && po.status !== "sent") throw new Error(`This order is ${PO_STATUS[po.status].toLowerCase()}, so it can't be recorded this way.`);
    if (po.lines.some((l) => l.received > 0)) throw new Error("Stock has already been received on this order. Use Receive stock instead.");
    if (!po.lines.length) throw new Error("Add the items first.");

    const sent = draft ? sentDate : (po.sentDate || (po.sentAt ? dayKey(po.sentAt) : ""));
    if (draft) {
      if (!KEY_RE.test(sent || "") || sent > today) throw new Error("Check the date it was sent.");
      if (po.orderDate && sent < po.orderDate) throw new Error("It can't have been sent before its order date.");
    }
    if (receivedDate < (sent || po.orderDate || "")) throw new Error("It can't have been received before it was sent.");

    const at = new Date().toISOString();
    const lines = po.lines.map((l) => ({ ...l, received: l.qty }));
    tx.update(poRef, {
      lines, status: "received", historical: true, receivedDate,
      receivedAt: noon(receivedDate), lastReceivedAt: noon(receivedDate), receiptIds: arrayUnion(recRef.id),
      ...(draft ? { sentAt: noon(sent), sentDate: sent, sentBy: by, sentVia: "Before the portal" } : {}),
      updatedAt: serverTimestamp(), updatedBy: by,
      events: arrayUnion({ at, by, action: "Recorded as received before the portal", note: [
        draft ? `Sent ${sent}` : "", `Received ${receivedDate}`, clip(receivedBy, 120) && `by ${clip(receivedBy, 120)}`,
        clip(docketNo, 60) && `Docket ${clip(docketNo, 60)}`, "Stock not changed",
      ].filter(Boolean).join(" · ").slice(0, 300) }),
    });
    tx.set(recRef, {
      poId, poNumber: po.number, supplierId: po.supplierId, supplierName: po.supplier.name,
      docketNo: clip(docketNo, 60), note: clip(note, 1000), docket: null, closed: false, historical: true,
      scanId: "", receivedBy: clip(receivedBy, 120), receivedByUid: "", receivedAt: `${receivedDate}T12:00:00`,
      lines: po.lines.map((l) => ({
        key: l.key, productId: l.productId, name: l.name, arrived: l.qty,
        orderUnit: l.orderUnit, packSize: l.packSize, stockUnit: l.stockUnit, splits: [],
      })),
      by, byUid, at: serverTimestamp(),
    });
    result = { number: po.number, requestIds: po.requestIds };
  });
  return result;
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
//   lines: [{ key, arrived (supplier's order units), splits: [{ loc, batch, expiry, qty (stock units) }] }],
//   extras: [{ productId, qty (stock units), text, splits }] }   ← on the docket but not on the order
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
  const cleanSplits = (list, fallback) => (Array.isArray(list) ? list : [])
    .map((s) => ({
      loc: LOCATIONS.some((x) => x.key === s.loc) ? s.loc : fallback,
      batch: clip(s.batch, 40),
      expiry: KEY_RE.test(s.expiry || "") ? s.expiry : "",
      qty: Math.max(0, parseInt(s.qty, 10) || 0),
    }))
    .filter((s) => s.qty);
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
      const splits = cleanSplits(r.splits, line.loc);
      if (line.productId) {
        const need = arrived * line.packSize;
        const put = splits.reduce((a, s) => a + s.qty, 0);
        if (put !== need) throw new Error(`${line.name}: ${plural(need, line.stockUnit)} arrived but ${put} have been put away.`);
      }
      work.push({ line, arrived, splits });
    }

    // Extra items: on the docket but not on the order (qty in stock units). They never count towards
    // what's still to come, so the order's own lines, and whether it's complete, aren't changed by them.
    const extraWork = [];
    for (const x of (Array.isArray(receipt.extras) ? receipt.extras : []).slice(0, 40)) {
      const productId = clip(x.productId, 60);
      const qty = Math.min(99999, Math.max(0, parseInt(x.qty, 10) || 0));
      if (!productId || !qty) continue;
      extraWork.push({ productId, qty, text: clip(x.text, 150), splits: cleanSplits(x.splits, "shelf") });
    }
    if (!work.length && !extraWork.length && !receipt.close) throw new Error("Enter what arrived.");

    const pids = [...new Set([
      ...work.filter((w) => w.line.productId).map((w) => w.line.productId),
      ...extraWork.map((x) => x.productId),
    ])];
    const prod = new Map();
    for (const id of pids) {
      const s = await tx.get(doc(db, "inv_products", id));
      if (!s.exists()) throw new Error("A product in this delivery no longer exists.");
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
    extraWork.forEach((x) => {
      const p = prod.get(x.productId);
      x.name = p.name;
      x.unit = p.stockUnit;
      x.splits = x.splits.map((s) => ({ ...s, batch: p.tracked ? s.batch : "", expiry: p.tracked ? s.expiry : "" }));
      const put = x.splits.reduce((a, s) => a + s.qty, 0);
      if (put !== x.qty) throw new Error(`${p.name} (extra item): ${plural(x.qty, p.stockUnit)} arrived but ${put} have been put away.`);
      if (p.tracked && x.splits.some((s) => !s.batch || !s.expiry)) {
        throw new Error(`${p.name} (extra item) needs a ${batchName(p).toLowerCase()} number and expiry date.`);
      }
    });

    // Everything being put away: the order's lines and the extras
    const puts = [
      ...work.filter((w) => prod.has(w.line.productId)).map((w) => ({ productId: w.line.productId, splits: w.splits })),
      ...extraWork.map((x) => ({ productId: x.productId, splits: x.splits })),
    ];
    const lots = new Map();
    for (const w of puts) {
      for (const s of w.splits) {
        const id = lotId(w.productId, s.loc, s.batch, s.expiry);
        if (!lots.has(id)) {
          const ref = doc(db, "inv_lots", id);
          const snap = await tx.get(ref);
          lots.set(id, {
            ref, exists: snap.exists(), have: snap.exists() ? Number(snap.data().qty) || 0 : 0,
            productId: w.productId, loc: s.loc, batch: s.batch, expiry: s.expiry, delta: 0,
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
      puts.filter((w) => w.productId === id).forEach((w) => w.splits.forEach((s) => { stock[s.loc] += s.qty; }));
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
    extraWork.forEach((x) => {
      tx.set(doc(collection(db, "inv_moves")), {
        type: "receive", productId: x.productId, productName: x.name, unit: x.unit,
        lines: x.splits.map((s) => ({ loc: s.loc, batch: s.batch, expiry: s.expiry, delta: s.qty })),
        reason: "Delivery: extra, not ordered",
        note: [docketNo && `Docket ${docketNo}`, x.text && `Docket line: ${x.text}`].filter(Boolean).join(" · ").slice(0, 500),
        ref: po.number, poId, extra: true, by, byUid, at: serverTimestamp(),
      });
    });

    const lines = po.lines.map((l) => {
      const w = work.find((x) => x.line.key === l.key);
      return w ? { ...l, received: l.received + w.arrived } : l;
    });
    const allIn = lines.every((l) => l.received >= l.qty);
    // Only extras arrived: the order's status stays as it was
    const status = allIn || receipt.close ? "received" : work.length ? "part" : po.status;
    const summary = [
      ...work.map((w) => `${w.arrived} × ${w.line.name}`),
      ...extraWork.map((x) => `${x.qty} × ${x.name} (extra)`),
    ].join(", ");
    tx.update(poRef, {
      lines, status, receiptIds: arrayUnion(recRef.id),
      ...(extraWork.length ? { extras: arrayUnion(...extraWork.map((x) => ({
        productId: x.productId, name: x.name, qty: x.qty, unit: x.unit, receiptId: recRef.id, at, by,
      }))) } : {}),
      lastReceivedAt: serverTimestamp(), ...(status === "received" ? { receivedAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp(), updatedBy: by,
      events: arrayUnion({
        at, by,
        action: !work.length && !receipt.close ? "Extra items received"
          : status === "part" ? "Part received" : allIn ? "Received" : "Closed short",
        note: [docketNo && `Docket ${docketNo}`, summary].filter(Boolean).join(" · ").slice(0, 300),
      }),
    });

    tx.set(recRef, {
      poId, poNumber: po.number, supplierId: po.supplierId, supplierName: po.supplier.name,
      docketNo, note: clip(receipt.note, 1000), docket, closed: !!receipt.close && !allIn,
      scanId: clip(receipt.scanId, 40),
      receivedBy: clip(receipt.receivedBy, 120), receivedByUid: clip(receipt.receivedByUid, 60),
      receivedAt: typeof receipt.receivedAt === "string" ? receipt.receivedAt.slice(0, 30) : "",
      lines: [
        ...work.map((w) => ({
          key: w.line.key, productId: w.line.productId, name: w.line.name, arrived: w.arrived,
          orderUnit: w.line.orderUnit, packSize: w.line.packSize, stockUnit: w.line.stockUnit, splits: w.splits,
        })),
        ...extraWork.map((x) => ({
          key: "", productId: x.productId, name: x.name, arrived: x.qty, extra: true, text: x.text,
          orderUnit: x.unit, packSize: 1, stockUnit: x.unit, splits: x.splits,
        })),
      ],
      by, byUid, at: serverTimestamp(),
    });

    tx.set(doc(collection(db, "notify_outbox")), outboxDoc("stock.arrived", { receiptId: recRef.id, poId }, byUid));
    result = { receiptId: recRef.id, status, number: po.number, requestIds: po.requestIds, extras: extraWork.length };
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

// Admin: set an injector's kit to what they physically have (e.g. moving over from the old app).
// rows: [{ batch, expiry, sealed, open }] for one product. Their other batches of that product go to 0.
// Logged as "kit-count" with staffUid and deltaUnits, so Kit reconciliation stays right.
export async function setKitBalance({ staffUid, staffName, product, rows, note = "" }, staff) {
  if (!isKitProduct(product)) throw new Error("This product isn't carried in kits.");
  const target = clip(staffUid, 128);
  if (!target) throw new Error("Choose the injector.");
  const why = clip(note, 300);
  if (!why) throw new Error("Add a note, e.g. Moved over from the old app.");
  const per = Number(product.dosePer) || 0;
  const unit = product.doseUnit || "units";

  const want = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    const batch = clip(r.batch, 40);
    const expiry = KEY_RE.test(r.expiry || "") ? r.expiry : "";
    const sealed = Math.max(0, parseInt(r.sealed, 10) || 0);
    const open = round1(Math.max(0, Number(r.open) || 0));
    if (!sealed && !open) return;
    if (product.tracked && (!batch || !expiry)) {
      throw new Error(`Each ${batchName(product).toLowerCase()} needs its number and expiry date.`);
    }
    if (per && open > per) throw new Error(`The opened ${product.stockUnit} can't hold more than ${per} ${unit}.`);
    const id = kitId(target, product.id, batch, expiry);
    const w = want.get(id) || { batch, expiry, sealed: 0, open: 0 };
    w.sealed += sealed;
    w.open = round1(w.open + open);
    want.set(id, w);
  });

  // Their current batches of this product (any not entered go to 0)
  const snap = await getDocs(query(collection(db, "inv_kits"), where("staffUid", "==", target)));
  const ids = [...new Set([
    ...snap.docs.filter((d) => d.data().productId === product.id).map((d) => d.id),
    ...want.keys(),
  ])];

  let result = null;
  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const snaps = new Map();
    for (const id of ids) snaps.set(id, await tx.get(doc(db, "inv_kits", id)));

    // ---- Writes ----
    const lines = [];
    let before = 0, after = 0, changed = false;
    snaps.forEach((s, id) => {
      const old = s.exists() ? normaliseKit(s) : null;
      const w = want.get(id) || { batch: old ? old.batch : "", expiry: old ? old.expiry : "", sealed: 0, open: 0 };
      const oS = old ? old.sealed : 0;
      const oO = old ? old.open : 0;
      before += oS * per + oO;
      after += w.sealed * per + w.open;
      if (oS === w.sealed && Math.abs(oO - w.open) < 0.01) return;
      changed = true;
      tx.set(doc(db, "inv_kits", id), {
        staffUid: target, staffName: clip(staffName, 120) || (old ? old.staffName : ""),
        productId: product.id, productName: product.name, batch: w.batch, expiry: w.expiry,
        dosePer: per, doseUnit: unit, sealed: w.sealed, open: w.open,
        updatedAt: serverTimestamp(), ...(old ? {} : { createdAt: serverTimestamp() }),
      }, { merge: true });
      if (w.sealed !== oS) lines.push({ loc: "kit", batch: w.batch, expiry: w.expiry, delta: w.sealed - oS });
    });
    if (!changed) throw new Error("Nothing has changed.");
    before = round1(before);
    after = round1(after);
    logMove(tx, staff, {
      type: "kit-count", productId: product.id, productName: product.name, unit,
      staffUid: target, deltaUnits: round1(after - before), lines,
      reason: "Kit set by admin",
      note: `${clip(staffName, 120) || "Injector"}'s kit: ${before} → ${after} ${unit} · ${why}`.slice(0, 500),
    });
    result = { before, after, unit };
  });
  return result;
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
      else if (l.kind === "vial") {
        for (const id of r.openIds || []) await getOnce(openSnaps, "inv_open", id);
        for (const id of r.lots || []) await getOnce(lotSnaps, "inv_lots", id);
      }
      else await getOnce(lotSnaps, "inv_lots", r.ref);
    }
    if (l.kind !== "kit") await getOnce(prodSnaps, "inv_products", l.productId);
  }

  const kits = new Map(), lots = new Map(), opens = new Map(), newOpens = [];
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    // Kit products in JT storage / on the Shelf (e.g. Xeomin): units come out of that place's opened vial.
  // When it runs out, the next vial (oldest expiry first) is opened automatically. Nothing is thrown away.
  function vialLine(l) {
    const r0 = l.rows[0] || {};
    const loc = l.loc === "jt" ? "jt" : "shelf";
    const size = Number(l.dosePer) || 0;
    let left = round1(Math.max(0, Number(r0.amount) || 0));
    const rows = [];
    for (const id of r0.openIds || []) {
      if (left <= 0.001) break;
      const snap = openSnaps.get(id);
      if (!snap || !snap.exists() || snap.data().status !== "open") continue;
      const d = snap.data();
      const cap = Number(d.size) || size;
      const s = opens.get(id) || { uses: parseInt(d.uses, 10) || 0, used: Number(d.used) || 0, finish: false };
      const take = round1(Math.min(left, Math.max(0, cap - s.used)));
      if (take <= 0) { s.finish = true; opens.set(id, s); continue; }
      s.uses += 1;
      s.used = round1(s.used + take);
      if (s.used >= cap - 0.05) s.finish = true;   // used up
      opens.set(id, s);
      rows.push({ openId: id, batch: String(d.batch || ""), expiry: String(d.expiry || ""), amount: take, taken: take,
        from: loc, dose: take, waste: 0, opened: false, finished: s.finish });
      left = round1(left - take);
    }
    for (const id of r0.lots || []) {
      if (left <= 0.001 || !size) break;
      const snap = lotSnaps.get(id);
      if (!snap || !snap.exists()) continue;
      const d = snap.data();
      const s = lots.get(id) || { qty: Number(d.qty) || 0, loc: d.loc === "jt" ? "jt" : "shelf" };
      const batch = String(d.batch || ""), expiry = String(d.expiry || "");
      while (left > 0.001 && s.qty >= 1) {
        s.qty -= 1;
        const take = round1(Math.min(left, size));
        const finish = take >= size - 0.05;
        const ref = doc(collection(db, "inv_open"));
        newOpens.push({ ref, productId: l.productId, name: l.name, batch, expiry, loc: s.loc, dose: take, finish, kind: "vial" });
        rows.push({ openId: ref.id, batch, expiry, amount: take, taken: take, from: s.loc, dose: take, waste: 0, opened: true, finished: finish });
        left = round1(left - take);
      }
      lots.set(id, s);
    }
    if (left > 0.001) {   // not enough in stock: saved short, like every other product
      rows.push({ openId: "", batch: "", expiry: "", amount: left, taken: 0, from: loc, dose: left, waste: 0, opened: false, finished: false });
    }
    return rows;
  }

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
    const rows = l.kind === "vial" ? vialLine(l) : l.rows.map((r) => {
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
      kind: ["kit", "shared", "vial"].includes(l.kind) ? l.kind : "storage",
      stockUnit: clip(l.stockUnit || "", 30),
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
      const n = l.kind === "shared" || l.kind === "vial" ? (r.opened ? 1 : 0) : r.taken;   // only a newly opened one leaves stock
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
      uses: 1, used: n.dose, lastUsedAt: serverTimestamp(), ...(n.kind ? { kind: n.kind } : {}),
      ...(n.finish ? finishedFields("Empty", staff) : {}),
    }));
  });
  out.forEach((l) => {
    if (l.kind === "vial") {
      const opened = l.rows.filter((r) => r.opened);
      logMove(tx, staff, {
        type: "use", productId: l.productId, productName: l.name, unit: l.stockUnit || "vial",
        lines: opened.map((r) => ({ loc: r.from, batch: r.batch, expiry: r.expiry, delta: -1 })),
        reason: "Treatment",
        note: [`${patientName} · ${formName}`, `${l.total} ${l.unit} from the opened ${l.stockUnit || "vial"}`,
          opened.length ? `${opened.length} new ${l.stockUnit || "vial"} opened` : ""].filter(Boolean).join(" · ").slice(0, 500),
      });
      return;
    }
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

/* ===================== Opening count: walking order and saved progress ===================== */
// The order products sit in on the Shelf and in JT storage, with headings ("Fridge", "Cabinet A – top shelf").
// One order for the whole clinic: inv_settings/count_order → { shelf: [{ s: "Fridge" } | { p: productId }], jt: [...] }
function cleanOrderList(list) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((e) => {
    if (e && typeof e.s === "string") { const s = clip(e.s, 60); if (s) out.push({ s }); }
    else if (e && e.p) { const p = clip(e.p, 60); if (p && !seen.has(p)) { seen.add(p); out.push({ p }); } }
  });
  return out.slice(0, 800);
}

// Category orders: cats["shelf__retail"] = [...] (used when that category is picked at the count)
const ORDER_CAT_RE = /^(shelf|jt)__[a-z]+$/;

export async function getCountOrder() {
  const s = await getDoc(doc(db, "inv_settings", "count_order"));
  const d = s.exists() ? s.data() : {};
  const cats = {};
  Object.entries(d.cats && typeof d.cats === "object" ? d.cats : {}).forEach(([k, v]) => {
    if (ORDER_CAT_RE.test(k)) cats[k] = cleanOrderList(v);
  });
  return { shelf: cleanOrderList(d.shelf), jt: cleanOrderList(d.jt), cats, by: String(d.updatedBy || ""), at: toDate(d.updatedAt) };
}

// cat: save it as that category's own order (an empty list goes back to the place's order)
export async function saveCountOrder(loc, list, staff, cat = "") {
  if (!["shelf", "jt"].includes(loc)) throw new Error("Choose the Shelf or JT storage.");
  if (cat && !INV_CATEGORIES.some((c) => c.key === cat)) throw new Error("Unknown category.");
  const data = cat ? { cats: { [`${loc}__${cat}`]: cleanOrderList(list) } } : { [loc]: cleanOrderList(list) };
  await setDoc(doc(db, "inv_settings", "count_order"), { ...data, ...stamp(staff) }, { merge: true });
}
// An opening count in progress ("Save and finish later"): one per day, anyone who counts can carry it on
const draftRef = (key) => doc(db, "inv_count_drafts", `opening__${key}`);

export async function getCountDraft(key = dayKey()) {
  const s = await getDoc(draftRef(key));
  if (!s.exists()) return null;
  const x = s.data() || {};
  return { ...x, savedAt: Number(x.savedAt) || 0, updatedAt: toDate(x.updatedAt) };
}

export async function saveCountDraft(draft, staff, key = dayKey()) {
  if (JSON.stringify(draft).length > 900000) throw new Error("This count is too big to save for later. Press Save count instead.");
  await setDoc(draftRef(key), {
    ...draft, kind: "opening", dateKey: key, by: who(staff), byUid: uid(), savedAt: Date.now(), updatedAt: serverTimestamp(),
  });
}

export async function deleteCountDraft(key = dayKey()) {
  await deleteDoc(draftRef(key));
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
    // Invoice sales dated before today were really sold before the count, whenever they were uploaded
    const movedSince = (a) => (!a.countedAt ? 0 : moves
      .filter((m) => m.productId === a.p.id && m.at && m.at.getTime() > a.countedAt
        && !(m.effectiveDate && m.effectiveDate < dayKey()))
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
      if (l.kind === "vial") throw new Error(`${l.name} came from an opened vial in storage, so it can't be corrected here yet.`);
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
  "late-invoice": { label: "Sold before the count", adjust: false, system: true,
    help: "Sold before the count, but its invoice was uploaded after it. Closed automatically when the invoices were uploaded." },
  "late-record": { label: "Used before the count", adjust: false, system: true,
    help: "Used on a patient before the count, but recorded afterwards (from a paper record). Closed automatically when it was recorded." },
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
      return uk >= a.dateKey && uk <= lastKey && u.lines.some((l) => pids.has(l.productId) && (Number(l.total) || 0) > 0);
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
    kind: x.kind === "vial" ? "vial" : "shared",   // "vial": a kit product's opened vial in JT storage / on the Shelf
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
// Shared products: opened to use across patients. Kit products (e.g. Xeomin) in JT storage / on the Shelf:
// Restock opens the next vial, and its units are used until it's empty.
export async function openContainer(product, lot, staff) {
  const vialKind = isKitProduct(product);
  if (!isSharedProduct(product) && !vialKind) throw new Error("This product isn't set up as shared across patients.");
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
    tx.set(oRef, openDocData(product.id, pd, lot, staff, vialKind ? { kind: "vial" } : {}));
    logMove(tx, staff, {
      type: vialKind ? "vial-open" : "shared-open", productId: product.id, productName: product.name, unit: product.stockUnit,
      lines: [{ loc: lot.loc, batch: lot.batch || "", expiry: lot.expiry || "", delta: -1 }],
      reason: vialKind ? "Vial opened (restock)" : "Opened for sharing", ref: oRef.id,
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

// What a kit activity line is called on the investigation page
export const KIT_FLOW_LABELS = {
  "kit-take": "Taken from the Shelf", "kit-return": "Returned to the Shelf", "kit-use": "Used in treatment",
  "kit-discard": "Discarded", "kit-in": "Borrowed from a colleague", "kit-out": "Lent to a colleague",
};

// One line per thing that physically went in (+) or out (−) of an injector's kit, in units, oldest first:
// taken / returned, used on treatment records, discarded, borrowed / lent.
// Admin adjustments (accepted differences, usage corrections) don't move anything physically, so they're left out.
function kitFlowEvents(moves, loans, staffUid, productsById, since, until = null, productId = "") {
  const per = (pid) => Number((productsById.get(pid) || {}).dosePer) || 0;
  const inWin = (d) => !!d && d > since && (!until || d <= until);
  const out = [];
  moves.forEach((m) => {
    if (m.byUid !== staffUid || !inWin(m.at) || (productId && m.productId !== productId)) return;
    const kitDelta = (m.lines || []).filter((l) => l.loc === "kit").reduce((a, l) => a + (Number(l.delta) || 0), 0);
    let units;
    if (m.type === "kit-take" || m.type === "kit-return") units = kitDelta * per(m.productId);   // vials → units
    else if (m.type === "kit-use") units = kitDelta;                                             // already units
    else if (m.type === "kit-discard") {
      const d = Number(m.discardUnits);
      units = -(Number.isFinite(d) ? d : Math.abs(kitDelta) * per(m.productId));
    } else return;
    if (!units) return;
    out.push({ at: m.at, type: m.type, productId: m.productId, units: round1(units), by: m.by || "",
      note: [m.reason, m.note].filter(Boolean).join(" · ") });
  });
  loans.forEach((l) => {
    if (!inWin(l.createdAt) || (productId && l.productId !== productId)) return;
    const u = round1(l.units);
    if (!u) return;
    if (l.toUid === staffUid) out.push({ at: l.createdAt, type: "kit-in", productId: l.productId, units: u, by: l.toName || "",
      note: `From ${l.fromName || "a colleague"}'s opened vial`, status: l.status });
    if (l.fromUid === staffUid) out.push({ at: l.createdAt, type: "kit-out", productId: l.productId, units: -u, by: l.toName || "",
      note: `To ${l.toName || "a colleague"}`, status: l.status });
  });
  return out.sort((a, b) => a.at - b.at);
}

// Units in (+) or out (−) of my kit since a moment, per product
async function kitFlowSince(since, productsById) {
  const me = uid();
  const [moves, loans] = await Promise.all([listMyKitMoves(500), listLoans(200).catch(() => [])]);
  const flow = new Map();
  kitFlowEvents(moves, loans, me, productsById, since).forEach((e) => {
    flow.set(e.productId, round1((flow.get(e.productId) || 0) + e.units));
  });
  return flow;
}

// The investigation page for an overnight kit difference: everything that went in or out of that
// injector's kit for that product between their End of Day count and the Start of Day count that opened it
export async function kitOvernightEvidence(x) {
  const o = x.overnight || {};
  const staffUid = String(x.staffUid || "");
  const countAt = x.openedAt instanceof Date ? x.openedAt : new Date();
  const readDay = (key) => (KEY_RE.test(key || "") && staffUid
    ? getDoc(doc(db, "inv_kitdays", kitDayId(staffUid, key))).then((s) => (s.exists() ? normaliseKitDay(s) : null)).catch(() => null)
    : Promise.resolve(null));
  const [products, moves, loans, endDay, startDay] = await Promise.all([
    listProducts(), listMoves({ productId: x.productId, max: 2000 }), listAllLoans().catch(() => []),
    readDay(o.fromDateKey), readDay(x.dateKey),
  ]);
  const endAt = toDate(o.endAt) || (endDay && endDay.end && endDay.end.at) || null;
  const since = endAt || (KEY_RE.test(o.fromDateKey || "") ? keyDate(o.fromDateKey) : new Date(countAt.getTime() - 864e5));
  const events = kitFlowEvents(moves, loans, staffUid, new Map(products.map((p) => [p.id, p])), since, countAt, x.productId);
  const start = startDay && startDay.start;
  return {
    since, exactSince: !!endAt, countAt, events,
    total: round1(events.reduce((a, e) => a + e.units, 0)),
    endItem: endDay && endDay.end ? endDay.end.items.find((it) => it.productId === x.productId) || null : null,
    startItem: start ? (start.items || []).find((it) => it.productId === x.productId) || null : null,
    correctedAt: start ? toDate(start.correctedAt) : null,
    people: [...new Set([x.staffName, ...events.map((e) => e.by)].filter(Boolean))],
  };
}

// Typed rows (read off the labels) matched to the kit records. A record that wasn't typed counts as 0;
// a typed batch the records don't have is kept as "unknown" (counted, and flagged for an admin).
function matchKitRows(p, rowsIn, lots) {
  const tally = new Map(lots.map((k) => [k.id, { k, sealed: 0, open: 0 }]));
  const unknown = [];
  // A row is either just "units remaining" (Start / End of Day), or unopened + opened (older records)
  const rows = (Array.isArray(rowsIn) ? rowsIn : []).map((r) => {
    const units = r.units !== undefined && r.units !== null ? round1(Math.max(0, Number(r.units) || 0)) : null;
    return {
      batch: clip(r.batch, 40), expiry: KEY_RE.test(r.expiry || "") ? r.expiry : "",
      sealed: units === null ? Math.max(0, parseInt(r.sealed, 10) || 0) : 0,
      open: units === null ? round1(Math.max(0, Number(r.open) || 0)) : units,
      inUse: r.inUse === true, ref: "", expiryMismatch: false,
    };
  });
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
  return { rows, unknown, tally, lines: [...tally.values()].map((t) => ({ ref: t.k.id, sealed: t.sealed, open: t.open })) };
}

// One product's totals once the kit check is saved (byRef: the saved count's lines, by kit record)
function kitCountSummary(p, m, lots, byRef) {
  const unitsOf = (r) => round1(r.sealed * (Number(p.dosePer) || 0) + r.open);
  const lotOut = lots.map((k) => {
    const c = byRef.get(k.id) || {};
    const t = m.tally.get(k.id) || { sealed: 0, open: 0 };
    return { ref: k.id, batch: k.batch, expiry: k.expiry, typed: m.rows.some((r) => r.ref === k.id),
      sealed: t.sealed, open: t.open, counted: round1(c.counted), system: round1(c.system), variance: round1(c.variance) };
  });
  const unknownUnits = round1(m.unknown.reduce((a, r) => a + unitsOf(r), 0));
  const counted = round1(lotOut.reduce((a, l) => a + l.counted, 0) + unknownUnits);
  const system = round1(lotOut.reduce((a, l) => a + l.system, 0));
  return {
    lots: lotOut, counted, system, variance: round1(counted - system),
    rows: m.rows.map(({ batch, expiry, sealed, open, inUse, ref, expiryMismatch }) =>
      ({ batch, expiry, sealed, open, inUse, ref, expiryMismatch, units: unitsOf({ sealed, open }) })),
    unknown: m.unknown.map((r) => ({ batch: r.batch, expiry: r.expiry, units: unitsOf(r) })),
  };
}
// Start of Day: a blind count. The clinician types each batch from the label (nothing is shown to choose from).
// items: [{ productId, rows: [{ batch, expiry, sealed, open, inUse }] }]   (rows: [] = "None in my kit")
// 1. Typed batches are matched to the kit records; any batch in the records that wasn't typed counts as 0.
//    Saved as a kit check, so differences reach Count differences.
// 2. Batches that aren't in the kit records are kept and flagged.
// 3. Overnight: last End of Day + what was recorded since should equal what's counted now. If not, an investigation opens.
// Saving again the same day (before End of Day) corrects it: the start time stays, the earlier count is kept in
// start.previous and its kit check is marked as replaced. An investigation already opened stays with the admin.
export async function saveKitDayStart({ notInjecting = false, items = [] }, staff) {
  const me = uid();
  const by = who(staff);
  const key = dayKey();
  const ref = doc(db, "inv_kitdays", kitDayId(me, key));

  const prevSnap = await getDoc(ref);
  const prevDay = prevSnap.exists() ? normaliseKitDay(prevSnap) : null;
  if (prevDay && prevDay.end) throw new Error("You've already ended today, so your start of day can't be changed.");
  const before = prevDay && prevDay.start ? prevDay.start : null;
  const startAt = before && before.at ? before.at : serverTimestamp();
  const editFields = before ? {
    correctedAt: serverTimestamp(),
    previous: [...(Array.isArray(before.previous) ? before.previous : []), {
      replacedAt: new Date().toISOString(), countId: before.countId || "", notInjecting: !!before.notInjecting,
      items: (before.items || []).map((it) => ({
        productId: String(it.productId || ""), productName: String(it.productName || ""),
        counted: Number(it.counted) || 0, inUse: it.inUse && it.inUse.batch ? String(it.inUse.batch) : "",
      })),
    }].slice(-5),
  } : {};
  const earlierInv = (pid) => {
    const it = before && (before.items || []).find((x) => x.productId === pid);
    return (it && it.overnight && it.overnight.investigationId) || "";
  };
  // The earlier kit check leaves Count differences (it stays on record, marked as replaced)
  const retire = async (newCountId) => {
    if (!before || !before.countId) return;
    await updateDoc(doc(db, "inv_counts", before.countId), {
      superseded: true, supersededBy: newCountId || "", supersededAt: serverTimestamp(), openCount: 0,
    }).catch((err) => console.warn("Couldn't mark the earlier kit check as replaced:", err));
  };

  if (notInjecting) {
    await setDoc(ref, {
      staffUid: me, staffName: by, dateKey: key,
      start: { at: startAt, notInjecting: true, items: [], countId: "", differences: 0, overnight: 0, ...editFields },
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await retire("");
    return { notInjecting: true, differences: 0, overnight: 0, unknown: 0, edited: !!before };
  }

  const [products, kits] = await Promise.all([listProducts(), listKits({ mine: true })]);
  const byPid = new Map(products.map((p) => [p.id, p]));
  const lines = [];
  const work = [];
  for (const it of items) {
    const p = byPid.get(it.productId);
    if (!p) continue;
    const lots = kits.filter((k) => k.productId === p.id);
    const m = matchKitRows(p, it.rows, lots);
    lines.push(...m.lines);
    work.push({ p, lots, m });
  }
  if (!work.length) throw new Error("Count your kit, or tick “I'm not injecting today”.");

  // 1. Against the kit records
  const count = lines.length
    ? await saveCount({ kind: "kit", lines, note: before ? "Start of day (corrected)" : "Start of day (blind)" }, staff)
    : null;
  const byRef = new Map(((count && count.lines) || []).map((l) => [l.ref, l]));

  // 3. Overnight: since the last End of Day
  const lastEnd = await lastKitEnd(me).catch(() => null);
  const flow = lastEnd ? await kitFlowSince(lastEnd.end.at, byPid).catch(() => null) : null;

  const at = new Date().toISOString();
  const batch = writeBatch(db);
  const opened = [];
  const out = work.map(({ p, lots, m }) => {
    const s = kitCountSummary(p, m, lots, byRef);
    const use = m.rows.find((r) => r.inUse) || null;
    const e = lastEnd ? lastEnd.end.items.find((x) => x.productId === p.id) : null;
    let overnight = { compared: false,
      reason: !lastEnd ? "No End of Day count in the last 7 days" : !e ? "Not counted at the last End of Day" : !flow ? "Couldn't load kit activity" : "" };
    if (lastEnd && e && flow) {
      const endCounted = round1(e.counted);
      const moved = round1(flow.get(p.id) || 0);
      const expected = round1(endCounted + moved);
      const gap = round1(s.counted - expected);
      overnight = { compared: true, fromDateKey: lastEnd.dateKey, endCounted, moved, expected, gap, investigationId: earlierInv(p.id) };
      if (Math.abs(gap) >= 0.05 && !overnight.investigationId) {   // one investigation per product per day
        const iRef = doc(collection(db, "inv_investigations"));
        overnight.investigationId = iRef.id;
        opened.push(iRef.id);
        const u = p.doseUnit || "units";
        batch.set(iRef, {
          kind: "kit-overnight", countId: count ? count.id : "", line: -1,
          productId: p.id, productName: p.name, loc: "kit", ref: "", staffUid: me, staffName: by,
          batch: "", expiry: "", batchLabel: p.batchLabel || "Batch", unit: u,
          digital: expected, counted: s.counted, variance: gap, countNote: "", dateKey: key,
          status: "review", aloneApproved: true,
          overnight: { fromDateKey: lastEnd.dateKey, endCounted, moved, expected, endAt: lastEnd.end.at },
          openedBy: by, openedByUid: me, openedAt: serverTimestamp(), updatedAt: serverTimestamp(),
          events: [{ at, by, action: "Opened: overnight kit difference",
            note: `End of day ${lastEnd.dateKey}: ${endCounted} ${u}. Recorded since: ${moved >= 0 ? "+" : ""}${moved}. `
              + `Expected ${expected}, counted ${s.counted}${before ? " (corrected count)" : " this morning"} (${gap > 0 ? "+" : ""}${gap}).` }],
        });
      }
    }
    return {
      productId: p.id, productName: p.name, doseUnit: p.doseUnit || "units",
      rows: s.rows, inUse: use ? { batch: use.batch, expiry: use.expiry, ref: use.ref } : null,
      lots: s.lots, unknown: s.unknown, counted: s.counted, system: s.system, variance: s.variance, overnight,
    };
  });

  if (opened.length) {
    batch.set(doc(collection(db, "notify_outbox")), outboxDoc("investigation.opened", { ids: opened, countId: count ? count.id : "" }, me));
  }
  const differences = count ? count.lines.filter((l) => l.status !== "ok").length : 0;
  batch.set(ref, {
    staffUid: me, staffName: by, dateKey: key,
    start: { at: startAt, notInjecting: false, blind: true, items: out, countId: count ? count.id : "",
      differences, overnight: opened.length, ...editFields },
    updatedAt: serverTimestamp(),
  }, { merge: true });
  await batch.commit();
  await retire(count ? count.id : "");
  if (opened.length) pingNotify();

  return {
    notInjecting: false, differences, overnight: opened.length, edited: !!before,
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
// End of Day: a blind kit count typed from the labels (injectors) and the answers to the admin's questions. Once per day.
// items: [{ productId, productName, doseUnit, usedToday, rows: [{ batch, expiry, sealed, open }] }]   (rows: [] = "None in my kit")
// answers: [{ id, label, type, value, text }]
export async function saveKitDayEnd({ items = [], answers = [] }, staff) {
  const me = uid();
  const by = who(staff);
  const key = dayKey();
  const ref = doc(db, "inv_kitdays", kitDayId(me, key));
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().end) throw new Error("You've already ended today. Reload to see it.");

  const lines = [];
  const work = [];
  if (items.length) {
    const [products, kits] = await Promise.all([listProducts(), listKits({ mine: true })]);
    const byPid = new Map(products.map((p) => [p.id, p]));
    items.forEach((it) => {
      const p = byPid.get(it.productId);
      if (!p) return;
      const lots = kits.filter((k) => k.productId === p.id);
      const m = matchKitRows(p, it.rows, lots);
      lines.push(...m.lines);
      work.push({ p, it, lots, m });
    });
  }
  const count = lines.length ? await saveCount({ kind: "kit", lines, note: "End of day" }, staff) : null;
  const byRef = new Map(((count && count.lines) || []).map((l) => [l.ref, l]));

  const out = work.map(({ p, it, lots, m }) => {
    const s = kitCountSummary(p, m, lots, byRef);
    return {
      productId: p.id, productName: p.name, doseUnit: p.doseUnit || "units", usedToday: round1(it.usedToday),
      counted: s.counted, system: s.system, variance: s.variance, lots: s.lots, rows: s.rows, unknown: s.unknown,
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

/* ===================== Sales: products checked out to patients (the Scanner now, the checkout later) ===================== */
// Every sale comes off the Shelf, oldest expiry first, in one transaction with the activity log and the sale record.
// A sale never fails for lack of stock: whatever the system didn't have is saved as short, to count and sort out.

export async function listSalesOn(key = dayKey()) {
  const snap = await getDocs(query(collection(db, "inv_sales"), where("dateKey", "==", key)));
  return snap.docs.map((d) => {
    const x = d.data() || {};
    return { id: d.id, ...x, lines: Array.isArray(x.lines) ? x.lines : [], at: toDate(x.at) };
  });
}

// sale = { source: "scan" | "pos" | "invoice", scanId, invoiceId, patientName, apptDate, provider, note, lines: [{ productId, qty, fee }] }
// saleId (optional): a fixed record id, so the same sale is never recorded twice. The second time returns { already: true }.
// deduct: false saves the record without changing stock (a billing sheet kept as evidence).
// also(tx, saleId): extra writes in the same transaction (e.g. the scan record). Returns { id, lines, short, already }.
export async function recordSale(sale, staff, { also = null, saleId = "", deduct = true } = {}) {
  const me = uid();
  const by = who(staff);
  const source = ["pos", "invoice", "manual"].includes(sale.source) ? sale.source : "scan";
  const want = new Map();
  (sale.lines || []).forEach((l) => {
    const pid = clip(l.productId, 60);
    const q = Math.min(99, Math.max(0, parseInt(l.qty, 10) || 0));
    if (!pid || !q) return;
    const cur = want.get(pid) || { productId: pid, qty: 0, fee: 0, hasFee: false };
    cur.qty += q;
    if (l.fee !== null && l.fee !== undefined && l.fee !== "" && Number.isFinite(Number(l.fee))) {
      cur.fee = round2(cur.fee + Number(l.fee));
      cur.hasFee = true;
    }
    want.set(pid, cur);
  });
  const items = [...want.values()].slice(0, 40);
  if (!items.length) throw new Error("Nothing to take off the Shelf.");

  // Each product's Shelf batches, oldest expiry first. Their quantities are read again inside the transaction.
  const lotIds = new Map();
  if (deduct) {
    await Promise.all(items.map(async (it) => {
      const snap = await getDocs(query(collection(db, "inv_lots"), where("productId", "==", it.productId)));
      lotIds.set(it.productId, snap.docs.map(normaliseLot).filter((l) => l.loc === "shelf" && l.qty > 0).sort(fefo).map((l) => l.id));
    }));
  }

  const saleRef = saleId ? doc(db, "inv_sales", clip(saleId, 140)) : doc(collection(db, "inv_sales"));
  let result = null;
  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    if (saleId) {
      const was = await tx.get(saleRef);
      if (was.exists()) { result = { id: saleRef.id, lines: [], short: false, already: true }; return; }
    }
    const prods = new Map();
    const lots = new Map();
    for (const it of items) {
      const ps = await tx.get(doc(db, "inv_products", it.productId));
      if (!ps.exists()) throw new Error("A product on this sale no longer exists.");
      prods.set(it.productId, ps);
      for (const id of lotIds.get(it.productId) || []) lots.set(id, await tx.get(doc(db, "inv_lots", id)));
    }

    // ---- Writes ----
    const reason = source === "pos" ? "Checkout" : source === "invoice" ? "Timely invoice"
      : source === "manual" ? "Recorded by hand" : "Billing sheet scan";
    // Invoice and hand-recorded sales count as sold on their date, whenever they're entered
    const effective = (source === "invoice" || source === "manual") && KEY_RE.test(sale.apptDate || "") ? sale.apptDate : "";
    const who2 = [sale.invoiceId && `Invoice ${sale.invoiceId}`, sale.patientName, sale.provider,
      source === "manual" && sale.note].filter(Boolean).join(" · ");
    const out = items.map((it) => {
      const ps = prods.get(it.productId);
      const pd = ps.data();
      let left = it.qty;
      const rows = [];
      if (deduct) {
        for (const id of lotIds.get(it.productId) || []) {
          if (!left) break;
          const s = lots.get(id);
          if (!s || !s.exists()) continue;
          const d = s.data();
          const have = Number(d.qty) || 0;
          if (have <= 0) continue;
          const n = Math.min(have, left);
          tx.update(s.ref, { qty: have - n, updatedAt: serverTimestamp() });
          rows.push({ batch: String(d.batch || ""), expiry: String(d.expiry || ""), taken: n });
          left -= n;
        }
      }
      const taken = it.qty - left;
      if (deduct && taken) {
        const st = pd.stock || {};
        tx.update(ps.ref, { stock: { shelf: Math.max(0, (Number(st.shelf) || 0) - taken), jt: Number(st.jt) || 0 }, stockAt: serverTimestamp() });
        logMove(tx, staff, {
          type: "sale", productId: it.productId, productName: String(pd.name || ""), unit: String(pd.stockUnit || "item"),
          lines: rows.map((r) => ({ loc: "shelf", batch: r.batch, expiry: r.expiry, delta: -r.taken })),
          reason, note: [effective && `Sold ${effective}`, who2].filter(Boolean).join(" · ").slice(0, 500), ref: saleRef.id,
          effectiveDate: effective,
        });
      }
      return {
        productId: it.productId, name: String(pd.name || ""), unit: String(pd.stockUnit || "item"),
        qty: it.qty, fee: it.hasFee ? it.fee : null, taken: deduct ? taken : 0, short: deduct ? it.qty - taken : 0, rows,
      };
    });
    const short = out.some((l) => l.short > 0);
    tx.set(saleRef, {
      source, scanId: clip(sale.scanId, 40), invoiceId: clip(sale.invoiceId, 60),
      patientName: clip(sale.patientName, 150), apptDate: KEY_RE.test(sale.apptDate || "") ? sale.apptDate : "",
      provider: clip(sale.provider, 80), note: clip(sale.note, 500),
      lines: out, short, deducted: deduct, total: round2(out.reduce((a, l) => a + (l.fee || 0), 0)),
      voided: false, dateKey: dayKey(), by, byUid: me, at: serverTimestamp(),
    });
    if (also) also(tx, saleRef.id, out);
    result = { id: saleRef.id, lines: out, short, already: false };
  });
  return result;
}

// Purchase order email templates (Supplier → Purchase order email). Placeholders → [tag, what it fills in with]
export const PO_EMAIL_TAGS = [
  ["{Contact first name}", "The supplier's contact first name"],
  ["{Contact name}", "The supplier's contact full name"],
  ["{Supplier}", "The supplier's company name"],
  ["{PO number}", "The purchase order number"],
  ["{Order date}", "The date the order was placed"],
  ["{Account number}", "Our account number with them"],
  ["{Item count}", "How many lines are on the order"],
  ["{My name}", "The staff member sending it"],
  ["{Order table}", "Where the order's items go. Without it, they go after the message"],
];
// Finds {Order table} (any spacing or capitals). fillPoTemplate leaves it alone; it's swapped for the table when sending.
export const PO_ORDER_TAG_RE = /\{\s*order\s+table\s*\}/i;
// Fills a subject or message from the supplier's template. Unknown {tags} are left as typed.
export function fillPoTemplate(text, { po, supplier, staff }) {
  const s = supplier || {};
  const contact = String(s.contactName || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((po && po.orderDate) || "");
  const orderDate = m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "";
  const n = po && Array.isArray(po.lines) ? po.lines.length : 0;
  const vals = {
    "contact first name": contact.split(/\s+/)[0] || "there",
    "contact name": contact || "there",
    "supplier": s.name || (po && po.supplier && po.supplier.name) || "",
    "po number": (po && po.number) || "",
    "order date": orderDate,
    "account number": s.accountNo || "",
    "item count": `${n} item${n === 1 ? "" : "s"}`,
    "my name": String((staff && staff.name) || "").trim(),
  };
  return String(text || "").replace(/\{\s*([^{}]+?)\s*\}/g, (all, k) => {
    const v = vals[k.toLowerCase().replace(/\s+/g, " ")];
    return v === undefined ? all : v;
  });
}

/* ===================== Timely invoices: what was sold comes off the Shelf ===================== */
// Invoices are the source of truth for retail. Each invoice line whose product name links to a stock product
// comes off the Shelf (oldest expiry first). One record per invoice + product, so uploading the same invoice again,
// or linking a name later and applying again, never takes anything off twice.
// Nothing dated before the start date is applied. No start date = nothing is applied at all.

export const INVOICE_NOT_STOCK = "-";
export const invoiceNameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function getInvoiceSettings() {
  const s = await getDoc(doc(db, "inv_settings", "invoices"));
  const d = s.exists() ? s.data() : {};
  return {
    startDate: KEY_RE.test(d.startDate || "") ? d.startDate : "",
    links: (Array.isArray(d.links) ? d.links : [])
      .map((l) => ({ name: clip(l && l.name, 150), productId: clip(l && l.productId, 60) }))
      .filter((l) => l.name && l.productId),
    by: String(d.updatedBy || ""), at: toDate(d.updatedAt),
  };
}

export async function saveInvoiceSettings({ startDate = "", links = [] }, staff) {
  if (startDate && (!KEY_RE.test(startDate) || startDate > dayKey())) throw new Error("Check the start date: it can't be in the future.");
  const seen = new Set();
  const clean = (Array.isArray(links) ? links : [])
    .map((l) => ({ name: clip(l && l.name, 150), productId: clip(l && l.productId, 60) }))
    .filter((l) => l.name && l.productId && !seen.has(invoiceNameKey(l.name)) && seen.add(invoiceNameKey(l.name)))
    .slice(0, 1000);
  await setDoc(doc(db, "inv_settings", "invoices"), { startDate: startDate || "", links: clean, ...stamp(staff) });
}

// rows: [{ invoiceId, date: "YYYY-MM-DD", patientName, staffName, product, qty }]  (qty optional: 1 when missing)
export async function applyInvoiceSales(rows, staff, onProgress = () => {}) {
  const [cfg, products] = await Promise.all([getInvoiceSettings(), listProducts()]);
  const res = { started: !!cfg.startDate, startDate: cfg.startDate, applied: 0, already: 0, before: 0,
    short: [], unlinked: [], refunds: [], failed: [] };
  if (!cfg.startDate) return res;

  const live = new Map(products.filter((p) => p.active).map((p) => [p.id, p]));
  const link = new Map([...live.values()].map((p) => [invoiceNameKey(p.name), p.id]));   // exact name matches link by themselves
  cfg.links.forEach((l) => link.set(invoiceNameKey(l.name), l.productId));                // saved links win

  const sales = new Map();
  const unlinked = new Map();
  (rows || []).forEach((r) => {
    const invoiceId = clip(r.invoiceId, 60);
    const date = KEY_RE.test(r.date || "") ? r.date : "";
    const name = clip(r.product, 150);
    if (!invoiceId || !date || !name) return;
    if (date < cfg.startDate) { res.before++; return; }
    const key = invoiceNameKey(name);
    const pid = link.get(key);
    if (pid === INVOICE_NOT_STOCK) return;
    const q = r.qty === undefined || r.qty === null || r.qty === "" ? 1 : Number(r.qty);
    if (!Number.isFinite(q) || q === 0) return;
    if (q < 0) {   // refunds are listed for staff, not put back automatically
      res.refunds.push({ invoiceId, date, patientName: clip(r.patientName, 150), product: name, qty: -q });
      return;
    }
    if (!pid || !live.has(pid)) {
      const u = unlinked.get(key) || { name, lines: 0, last: "" };
      u.lines++;
      if (date > u.last) u.last = date;
      unlinked.set(key, u);
      return;
    }
    const id = `invoice__${slug(invoiceId)}__${pid}`;
    const s = sales.get(id) || { id, invoiceId, date, patientName: clip(r.patientName, 150), staffName: clip(r.staffName, 80), productId: pid, qty: 0 };
    s.qty += Math.max(1, Math.round(q));
    sales.set(id, s);
  });
  res.unlinked = [...unlinked.values()].sort((a, b) => b.lines - a.lines);

  const applied = [];   // sold this time: used to correct counts done before the upload
  const queue = [...sales.values()];
  const total = queue.length;
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const r = await recordSale({
          source: "invoice", invoiceId: s.invoiceId, patientName: s.patientName, apptDate: s.date, provider: s.staffName,
          lines: [{ productId: s.productId, qty: s.qty }],
        }, staff, { saleId: s.id });
        if (r.already) res.already++;
        else {
          res.applied++;
          const l = r.lines[0];
          if (l) applied.push({ saleId: r.id, productId: s.productId, date: s.date, rows: l.rows || [] });
          if (l && l.short > 0) res.short.push({ invoiceId: s.invoiceId, patientName: s.patientName, name: l.name, short: l.short, unit: l.unit });
        }
      } catch (err) {
        console.error("Invoice sale failed:", s.invoiceId, err);
        res.failed.push({ invoiceId: s.invoiceId, name: (live.get(s.productId) || {}).name || "",
          msg: err && err.code === "permission-denied" ? "No access to Inventory" : (err && err.message) || "Couldn't save" });
      }
      onProgress(++done, total);
    }
  }));
  res.backdated = await backdateCounts(applied, staff)
    .catch((err) => { console.warn("Counts not corrected:", err); return { lines: 0, closed: 0, skipped: [], failed: 1 }; });
  return res;
}

// An opening count done after the day stock left, but before it was entered, compared against digital that still
// included it. Each affected line gets its digital and difference corrected. A difference that becomes 0 is matched;
// an investigation that becomes 0 closes by itself. Accepted, explained or starting-stock lines are never changed
// (stock was already adjusted for them): they're listed instead.
// applied: [{ saleId, productId, date, loc ("shelf" if missing), rows: [{ batch, expiry, taken }] }]
// kind: "sale" (Timely invoices, sales recorded by hand) or "use" (treatments recorded from paper)
// before: only counts saved before this moment (e.g. a write-off that already took the stock off digital)
async function backdateCounts(applied, staff, { kind = "sale", before = null } = {}) {
  const out = { lines: 0, closed: 0, skipped: [], failed: 0 };
  const list = applied.filter((a) => (a.rows || []).some((r) => Number(r.taken) > 0));
  if (!list.length) return out;
  const T = kind === "use" ? {
    outcome: "late-record", line: "Used before the count; recorded later",
    inv: "Used on a patient before the count; recorded afterwards. Stock wasn't changed.",
    fixed: "Corrected: used before the count, recorded later", closed: "Closed: used before the count, recorded later",
    what: "used on patients before the count", count: "Corrected for treatments recorded after the count",
  } : {
    outcome: "late-invoice", line: "Sold before the count; invoice uploaded later",
    inv: "Sold before the count; the invoice was uploaded after it. Stock wasn't changed.",
    fixed: "Corrected: sold before the count, invoice uploaded later", closed: "Closed: sold before the count, invoice uploaded later",
    what: "sold on invoices dated before the count", count: "Corrected for invoices uploaded after the count",
  };
  const from = addDaysKey(list.map((a) => a.date).sort()[0], 1);
  const counts = (await listCounts({ from }))
    .filter((c) => c.kind === "opening" && !c.superseded && (!before || (c.at && c.at < before)));
  const by = who(staff);
  const me = uid();

  for (const c of counts) {
    // What each line should also have had taken off
    const adds = new Map();
    c.lines.forEach((l, i) => {
      if (l.loc === "kit") return;
      let n = 0;
      const ids = [];
      list.forEach((a) => {
        if (a.productId !== l.productId || (a.loc || "shelf") !== l.loc) return;
        if (a.date >= c.dateKey) return;                                   // on or after the count day: not affected
        if ((l.lateSaleIds || []).includes(a.saleId)) return;              // already corrected
        const t = a.rows.filter((r) => (r.batch || "") === (l.batch || "") && (r.expiry || "") === (l.expiry || ""))
          .reduce((s, r) => s + (Number(r.taken) || 0), 0);
        if (t) { n += t; ids.push(a.saleId); }
      });
      if (n) adds.set(i, { n, ids });
    });
    if (!adds.size) continue;

    try {
      let changed = 0, closed = 0;
      const skipped = [];
      await runTransaction(db, async (tx) => {
        changed = 0; closed = 0; skipped.length = 0;
        // ---- Reads ----
        const cRef = doc(db, "inv_counts", c.id);
        const s = await tx.get(cRef);
        if (!s.exists()) return;
        const lines = (Array.isArray(s.data().lines) ? s.data().lines : []).map((l) => ({ ...l }));
        const invs = new Map();
        for (const [i] of adds) {
          const l = lines[i];
          if (l && l.status === "investigating" && l.investigationId && !invs.has(l.investigationId)) {
            invs.set(l.investigationId, await tx.get(doc(db, "inv_investigations", l.investigationId)));
          }
        }

        // ---- Writes ----
        const at = new Date().toISOString();
        adds.forEach(({ n, ids }, i) => {
          const l = lines[i];
          if (!l) return;
          if (["accepted", "explained", "baseline"].includes(l.status)) { skipped.push(`${l.productName} (${c.dateKey})`); return; }
          l.system = Math.max(0, (Number(l.system) || 0) - n);
          l.variance = (Number(l.counted) || 0) - l.system;
          l.lateSales = (Number(l.lateSales) || 0) + n;
          l.lateSaleIds = [...(l.lateSaleIds || []), ...ids].slice(-50);
          changed++;
          if (l.status !== "investigating") { l.status = l.variance ? "open" : "ok"; return; }

          const iSnap = invs.get(l.investigationId);
          if (!iSnap || !iSnap.exists() || iSnap.data().status === "closed") return;
          const x = iSnap.data();
          const digital = Math.max(0, (Number(x.digital) || 0) - n);
          const upd = { digital, variance: (Number(x.counted) || 0) - digital, updatedAt: serverTimestamp() };
          if (x.recount) {   // the recount was also before it was entered
            const rd = Math.max(0, (Number(x.recount.digital) || 0) - n);
            upd.recount = { ...x.recount, digital: rd, variance: (Number(x.recount.counted) || 0) - rd };
          }
          const left = upd.recount ? upd.recount.variance : upd.variance;
          if (!left) {
            Object.assign(upd, {
              status: "closed", outcome: T.outcome, applied: 0, outcomeNote: T.inv,
              closedAt: serverTimestamp(), closedBy: by, closedByUid: me,
            });
            l.status = "explained";
            l.note = T.line;
            closed++;
          }
          upd.events = arrayUnion({ at, by, action: left ? T.fixed : T.closed,
            note: `${n} ${T.what}. Difference now ${left > 0 ? "+" : ""}${left}` });
          tx.update(iSnap.ref, upd);
        });
        if (!changed) return;
        tx.update(cRef, {
          lines, openCount: lines.filter((l) => l.status === "open").length, updatedAt: serverTimestamp(), updatedBy: by,
          events: arrayUnion({ at, by, action: T.count, note: `${changed} line${changed === 1 ? "" : "s"}` }),
        });
      });
      out.lines += changed;
      out.closed += closed;
      out.skipped.push(...skipped);
    } catch (err) {
      console.warn("Count not corrected:", c.id, err);
      out.failed++;
    }
  }
  return out;
}

/* ---------- A sale recorded by hand (not on a Timely invoice), dated when it happened ---------- */
// E.g. a sample, a staff purchase, or a sale from before invoices started taking stock off.
// Comes off the Shelf (oldest expiry first). Opening counts done after that date are corrected, like a late invoice.
export async function recordManualSale(product, { date, qty, patientName = "", note = "" }, staff) {
  if (!KEY_RE.test(date || "") || date > dayKey()) throw new Error("Choose the date it was sold. It can't be in the future.");
  const n = parseInt(qty, 10);
  if (!(n >= 1 && n <= 99)) throw new Error("Enter how many (1 to 99).");
  const why = clip(note, 300);
  if (!why) throw new Error("Add a note saying why it's recorded here, e.g. Sold before invoices took stock off.");
  const r = await recordSale({
    source: "manual", patientName: clip(patientName, 150), apptDate: date, note: why,
    lines: [{ productId: product.id, qty: n }],
  }, staff);
  const l = r.lines[0];
  const backdated = date < dayKey() && l
    ? await backdateCounts([{ saleId: r.id, productId: product.id, date, rows: l.rows || [] }], staff)
      .catch((err) => { console.warn("Counts not corrected:", err); return { lines: 0, closed: 0, skipped: [], failed: 1 }; })
    : { lines: 0, closed: 0, skipped: [], failed: 0 };
  return { ...r, backdated };
}/* ===================== Undoing a write-off, and treatments recorded from paper ===================== */

// Undoes a write-off, or a "Used on a patient" paper record. Stock goes back into the same batches, the entry
// stays in the activity marked Undone, and a fixed id means it can only ever be undone once.
// A paper record's usage is cleared on the patient's record (the original is kept, with the reason), so it no
// longer counts as usage. Write-offs that were undone are left out of wastage.
export async function undoMove(move, reason, staff) {
  const paper = !!move && move.type === "use" && move.paper === true && !!move.ref;
  if (!move || (move.type !== "writeoff" && !paper)) throw new Error("Only write-offs and paper records can be undone here.");
  const why = clip(reason, 300);
  if (!why) throw new Error(paper ? "Add a reason, e.g. Recorded on the wrong patient." : "Add a reason, e.g. Written off by mistake.");
  const lines = (move.lines || [])
    .map((l) => ({ loc: l.loc === "jt" ? "jt" : "shelf", batch: String(l.batch || ""), expiry: String(l.expiry || ""), delta: -(Number(l.delta) || 0) }))
    .filter((l) => l.delta > 0);
  if (!lines.length) throw new Error("There's nothing to put back.");
  const me = uid();
  const by = who(staff);
  const pRef = doc(db, "inv_products", move.productId);
  const refs = lines.map((l) => doc(db, "inv_lots", lotId(move.productId, l.loc, l.batch, l.expiry)));
  const undoRef = doc(db, "inv_moves", `undo__${move.id}`);
  const uRef = paper ? doc(db, "inv_usage", String(move.ref)) : null;

  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    if ((await tx.get(undoRef)).exists()) throw new Error("This has already been undone. Reload to see it.");
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    const uSnap = uRef ? await tx.get(uRef) : null;
    if (uRef && !uSnap.exists()) throw new Error("The patient's usage record for this can't be found.");
    const snaps = [];
    for (const r of refs) snaps.push(await tx.get(r));

    // ---- Writes ----
    const pd = pSnap.data();
    const st = pd.stock || {};
    const stock = { shelf: Number(st.shelf) || 0, jt: Number(st.jt) || 0 };
    lines.forEach((l, i) => {
      const s = snaps[i];
      const have = s.exists() ? Number(s.data().qty) || 0 : 0;
      tx.set(refs[i], {
        productId: move.productId, loc: l.loc, batch: l.batch, expiry: l.expiry, qty: have + l.delta,
        updatedAt: serverTimestamp(), ...(s.exists() ? {} : { createdAt: serverTimestamp() }),
      }, { merge: true });
      stock[l.loc] += l.delta;
    });
    tx.update(pRef, { stock, stockAt: serverTimestamp() });

    if (uSnap) {
      // The patient's usage: nothing used now. The first version is kept in "original".
      const u = uSnap.data();
      const cleared = (Array.isArray(u.lines) ? u.lines : []).map((l) => ({
        ...l, total: 0, short: 0, doseTotal: 0, waste: 0,
        rows: (Array.isArray(l.rows) ? l.rows : []).map((r) => ({ ...r, amount: 0, taken: 0, dose: 0, waste: 0 })),
      }));
      tx.update(uRef, {
        lines: cleared, short: false,
        ...(u.original ? {} : { original: u.lines }),
        corrected: true, correctedAt: serverTimestamp(), correctedBy: by, correctedByUid: me,
        corrections: arrayUnion({
          at: new Date().toISOString(), by, byUid: me, reason: `Undone: ${why}`.slice(0, 300),
          changes: ["Paper record undone: nothing used, stock put back"],
        }),
      });
    }

    tx.set(undoRef, {
      type: "undo", undoOf: move.id, productId: move.productId, productName: String(pd.name || move.productName || ""),
      unit: String(pd.stockUnit || move.unit || "item"), lines,
      reason: paper ? "Paper record undone" : "Write-off undone", note: why, ref: paper ? String(move.ref) : "",
      by, byUid: me, at: serverTimestamp(),
    });
  });
}

// Stock used on a patient but recorded on paper (or a form outside the portal), dated when it happened.
// It's saved as that patient's treatment usage on that date: it counts as usage (not waste), clears
// "booked but nothing recorded", and opening counts done since are corrected.
// fromMove: an accidental write-off of that same stock. It's undone instead, so stock doesn't change twice.
export async function recordPaperUse(product, {
  patientId, patientName, date, loc = "shelf", batch = "", expiry = "", qty = 1, dose = "", note = "", fromMove = null,
}, staff) {
  if (isKitProduct(product) || isSharedProduct(product)) {
    throw new Error("Kit and shared products are recorded on a treatment record, so they can't be added this way yet.");
  }
  if (!KEY_RE.test(date || "") || date > dayKey()) throw new Error("Choose the date it was used. It can't be in the future.");
  const pid = clip(patientId, 150);
  const pname = clip(patientName, 150);
  if (!pid || !pname) throw new Error("Choose the patient.");
  const why = clip(note, 300);
  const me = uid();
  const by = who(staff);

  let lines;
  if (fromMove) {
    if (fromMove.type !== "writeoff" || fromMove.productId !== product.id) throw new Error("That isn't a write-off of this product.");
    lines = (fromMove.lines || []).filter((l) => Number(l.delta) < 0).map((l) => ({
      loc: l.loc === "jt" ? "jt" : "shelf", batch: String(l.batch || ""), expiry: String(l.expiry || ""), n: -Number(l.delta),
    }));
  } else {
    const n = parseInt(qty, 10);
    if (!(n >= 1 && n <= 99)) throw new Error("Enter how many (1 to 99).");
    if (product.tracked && (!clip(batch, 40) || !KEY_RE.test(expiry || ""))) throw new Error("Choose which batch it came from.");
    lines = [{ loc: loc === "jt" ? "jt" : "shelf", batch: product.tracked ? clip(batch, 40) : "", expiry: product.tracked ? expiry : "", n }];
  }
  if (!lines.length) throw new Error("There's nothing to record.");

  const total = lines.reduce((a, l) => a + l.n, 0);
  const per = Number(product.dosePer) || 0;
  const given = product.doseUnit && dose !== "" && dose !== null ? Math.round(Math.max(0, Number(dose) || 0) * 100) / 100 : 0;
  const r2 = (n) => Math.round(n * 100) / 100;

  const pRef = doc(db, "inv_products", product.id);
  const refs = lines.map((l) => doc(db, "inv_lots", lotId(product.id, l.loc, l.batch, l.expiry)));
  const undoRef = fromMove ? doc(db, "inv_moves", `undo__${fromMove.id}`) : null;
  const uRef = doc(collection(db, "inv_usage"));

  await runTransaction(db, async (tx) => {
    // ---- Reads ----
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists()) throw new Error("This product no longer exists.");
    if (undoRef && (await tx.get(undoRef)).exists()) throw new Error("This write-off has already been undone. Reload to see it.");
    const snaps = [];
    if (!fromMove) for (const r of refs) snaps.push(await tx.get(r));

    // ---- Writes ----
    const pd = pSnap.data();
    const unit = String(pd.stockUnit || product.stockUnit || "item");
    if (!fromMove) {
      const st = pd.stock || {};
      const stock = { shelf: Number(st.shelf) || 0, jt: Number(st.jt) || 0 };
      lines.forEach((l, i) => {
        const have = snaps[i].exists() ? Number(snaps[i].data().qty) || 0 : 0;
        if (have < l.n) {
          throw new Error(`Only ${plural(have, unit)} in ${locLabel(l.loc)}${l.batch ? ` (${batchText(product, l.batch)})` : ""}.`);
        }
        tx.update(refs[i], { qty: have - l.n, updatedAt: serverTimestamp() });
        stock[l.loc] = Math.max(0, stock[l.loc] - l.n);
      });
      tx.update(pRef, { stock, stockAt: serverTimestamp() });
    } else {
      // The write-off already took it off stock: it's undone, and the same stock becomes this patient's usage
      tx.set(undoRef, {
        type: "undo", undoOf: fromMove.id, productId: product.id, productName: String(pd.name || product.name), unit,
        lines: lines.map((l) => ({ loc: l.loc, batch: l.batch, expiry: l.expiry, delta: l.n })),
        reason: "Write-off undone", note: `Used on ${pname} on ${date} instead${why ? ` · ${why}` : ""}`.slice(0, 500),
        ref: uRef.id, by, byUid: me, at: serverTimestamp(),
      });
    }
    tx.set(doc(collection(db, "inv_moves")), {
      type: "use", productId: product.id, productName: String(pd.name || product.name), unit,
      lines: lines.map((l) => ({ loc: l.loc, batch: l.batch, expiry: l.expiry, delta: -l.n })),
      reason: "Treatment (paper record)",
      note: [`${pname} · used ${date}`, given ? `${given} ${product.doseUnit} given` : "", why].filter(Boolean).join(" · ").slice(0, 500),
      ref: uRef.id, effectiveDate: date, paper: true, by, byUid: me, at: serverTimestamp(),
    });

    // The usage record, dated when it was used (like a treatment record saved that day)
    const rows = lines.map((l) => {
      const d = given ? r2(given * (l.n / total)) : 0;
      return { batch: l.batch, expiry: l.expiry, amount: l.n, taken: l.n, from: l.loc, dose: d,
        waste: per && d ? Math.max(0, r2(l.n * per - d)) : 0 };
    });
    tx.set(uRef, {
      submissionId: "", source: "paper", patientId: pid, patientName: pname, formName: "Paper record",
      recordDate: date, short: false, note: why, fromWriteoff: fromMove ? fromMove.id : "",
      lines: [{
        productId: product.id, name: String(pd.name || product.name), kind: "storage", stockUnit: unit, unit,
        batchLabel: String(pd.batchLabel || "Batch"), doseUnit: String(pd.doseUnit || ""),
        doseTotal: r2(rows.reduce((a, r) => a + r.dose, 0)), waste: r2(rows.reduce((a, r) => a + r.waste, 0)),
        total, short: 0, rows,
      }],
      by, byUid: me, at: Timestamp.fromDate(new Date(`${date}T12:00:00`)), enteredAt: serverTimestamp(),
    });
  });

  // Opening counts since that day are corrected. A write-off already took it off digital,
  // so only counts done before the write-off need it.
  const backdated = date < dayKey()
    ? await backdateCounts(
      lines.map((l, i) => ({ saleId: `${uRef.id}:${i}`, productId: product.id, date, loc: l.loc,
        rows: [{ batch: l.batch, expiry: l.expiry, taken: l.n }] })),
      staff, { kind: "use", before: fromMove && fromMove.at instanceof Date ? fromMove.at : null },
    ).catch((err) => { console.warn("Counts not corrected:", err); return { lines: 0, closed: 0, skipped: [], failed: 1 }; })
    : { lines: 0, closed: 0, skipped: [], failed: 0 };
  return { usageId: uRef.id, backdated };
}