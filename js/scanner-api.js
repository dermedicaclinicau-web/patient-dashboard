// Scanner: a photo is read by Gemini through Apps Script (the API key never reaches the browser),
// matched to the product list here, then saved: the scan (Firestore: scans, photo in Storage) and,
// in the same transaction, the sale that takes the products off the Shelf.
import { db, auth } from "./firebase-config.js";
import { collection, doc, setDoc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { callApi } from "./appointments.js";
import { dayKey, recordSale, listSalesOn, listPos } from "./inventory-api.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : r2(v));
const conf = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 1 : Number(v));
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
export const money = (n) => (n === null || n === undefined ? "" : `$${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)}`);

/* ---------- The photo ---------- */
// Drawn through an <img> so iPhone photos come out the right way up
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That photo couldn't be opened. Try another.")); };
    img.src = url;
  });
}
const toBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
  fr.onerror = () => reject(new Error("That photo couldn't be read."));
  fr.readAsDataURL(blob);
});

// At most 2000px on the long side (plenty for handwriting), as JPEG
export async function preparePhoto(blob, max = 1600, quality = 0.8) {
  const img = await loadImage(blob);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const out = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
  if (!out) throw new Error("That photo couldn't be prepared. Try again.");
  return { blob: out, base64: await toBase64(out) };
}

/* ---------- Gemini (through Apps Script) ---------- */
// Only what can be handed to a patient: Retail, plus anything with a retail price. Everything if that leaves nothing.
const sellable = (products) => {
  const list = products.filter((p) => p.category === "retail" || (p.price !== null && p.price !== undefined && p.price !== ""));
  return list.length ? list : products;
};

export async function readBillingSheet(base64, products) {
  let res;
  try {
    res = await callApi({
      action: "scanner", op: "billing", mime: "image/jpeg", image: base64,
      products: sellable(products).map((p) => ({ id: p.id, name: p.name, brand: p.brand || "" })),
    });
  } catch (err) {
    if (err && err.code === "UNAUTHORIZED") throw err;   // "Your session has expired…"
    console.error("Scanner call failed:", err);
    throw new Error(err && err.message && !err.code ? err.message : "The scanner couldn't be reached. Try again.");
  }
  if (res.problem) throw new Error(res.problem);
  if (!res.result) throw new Error("The scanner couldn't read that photo. Try again.");
  return res.result;
}

/* ---------- Matching and checking ---------- */
// Words that tell products apart. Brand words don't count, so "ZO DPD" never pairs with "ZO Rozatrol" just for being ZO.
const BRAND_WORDS = new Set(["dermedica", "zo", "skin", "health", "zein", "obagi", "by", "md", "the", "and", "of", "with", "ml"]);
const ABBR = { d: "dermedica", derm: "dermedica", dpd: "daily power defense", spf: "sunscreen", sunscreen: "sunscreen" };
const keyWords = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
  .filter(Boolean).flatMap((w) => (ABBR[w] || w).split(" ")).filter((w) => !BRAND_WORDS.has(w)));

// One line per product: what's written on the sheet and what's in the photo. Ids not on the list are dropped.
export function startReview(result, products) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const id = (v) => (byId.has(String(v || "")) ? String(v) : "");
  const pName = (pid) => { const p = byId.get(pid); return p ? `${p.brand || ""} ${p.name}` : ""; };
  const lines = [];
  const lineFor = (pid) => {
    let l = pid ? lines.find((x) => x.productId === pid) : null;
    if (!l) { l = { productId: pid, written: [], seen: 0, seenText: [], conf: 1, fixed: false }; lines.push(l); }
    return l;
  };
  (result.written || []).forEach((w) => {
    const l = lineFor(id(w.productId));
    l.written.push({ text: String(w.text || "").slice(0, 150), qty: Math.max(1, parseInt(w.qty, 10) || 1), fee: num(w.fee) });
    l.conf = Math.min(l.conf, conf(w.confidence));
  });
  (result.seen || []).forEach((s) => {
    const l = lineFor(id(s.productId));
    l.seen += Math.max(1, parseInt(s.count, 10) || 1);
    l.seenText.push(String(s.description || "").slice(0, 150));
    l.conf = Math.min(l.conf, conf(s.confidence));
  });

  // A written line with nothing in the photo + a product in the photo that isn't written, sharing a word
  // ("Derm Pro B" and Pro B Plus): the same product. Joined, keeping the photo's product (labels beat handwriting).
  lines.filter((l) => l.written.length && !l.seen).forEach((w) => {
    const wk = keyWords(`${w.written.map((x) => x.text).join(" ")} ${pName(w.productId)}`);
    let best = null, bestScore = 0;
    lines.forEach((s) => {
      if (s === w || s.written.length || !s.seen) return;
      const sk = keyWords(`${s.seenText.join(" ")} ${pName(s.productId)}`);
      let score = 0;
      wk.forEach((x) => { if (sk.has(x)) score++; });
      if (score > bestScore) { best = s; bestScore = score; }
    });
    if (!best) return;
    best.written = w.written;
    best.conf = Math.min(best.conf, w.conf);
    if (!best.productId) best.productId = w.productId;
    lines.splice(lines.indexOf(w), 1);
  });
  return lines;
}
// Flags each line, works out the fee and how many come off the Shelf. Run again after any change.
// take: left undefined, it's filled in: written and seen → the written quantity; seen but not written → the number seen;
// written but not seen → 0 until someone confirms.
// fee: what staff typed (feeEdit) → what's written on the sheet → the retail price × quantity.
export function reviewBilling(lines, result, products) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const merged = [];
  lines.forEach((l) => {
    const m = l.productId ? merged.find((x) => x.productId === l.productId) : null;
    if (m) {
      m.written.push(...l.written); m.seen += l.seen; m.seenText.push(...l.seenText);
      m.conf = Math.min(m.conf, l.conf); m.fixed = m.fixed || l.fixed;
      if (l.take !== undefined) m.take = (m.take || 0) + l.take;
      if (l.feeEdit !== undefined) m.feeEdit = r2((m.feeEdit || 0) + (l.feeEdit || 0));
    } else {
      merged.push({ productId: l.productId, written: [...l.written], seen: l.seen, seenText: [...l.seenText],
        conf: l.conf, fixed: !!l.fixed, take: l.take, feeEdit: l.feeEdit });
    }
  });
  const out = merged.map((l) => {
    const p = byId.get(l.productId) || null;
    const qty = l.written.reduce((a, w) => a + w.qty, 0);
    const writtenFee = l.written.some((w) => w.fee !== null) ? r2(l.written.reduce((a, w) => a + (w.fee || 0), 0)) : null;
    const price = p ? num(p.price) : null;
    let fee = null, feeFrom = "";
    if (l.feeEdit !== undefined) { fee = l.feeEdit; feeFrom = "edited"; }
    else if (writtenFee !== null) { fee = writtenFee; feeFrom = "written"; }
    else if (qty && price !== null) { fee = r2(price * qty); feeFrom = "price"; }
    const take = !p ? 0 : l.take !== undefined ? l.take : qty && l.seen ? qty : !qty && l.seen ? l.seen : 0;
    const shelf = p ? Number((p.stock || {}).shelf) || 0 : 0;
    const flags = [];
    if (!p) flags.push(["bad", qty ? "Not matched to a product" : "Couldn't tell which product this is"]);
    if (qty && !l.seen) flags.push(["bad", "Written, but not in the photo"]);
    if (!qty && l.seen) flags.push(["bad", "In the photo, but not written on the sheet"]);
    if (qty && l.seen && qty !== l.seen) flags.push(["warn", `${qty} written, ${l.seen} in the photo`]);
    if (qty && fee === null) flags.push(["warn", "No fee written, and no retail price saved"]);
    else if (feeFrom === "written" && price !== null && Math.abs(fee - price * qty) > 0.5) {
      flags.push(["warn", `Fee ${money(fee)}, retail price ${money(r2(price * qty))}`]);
    }
    if (p && !l.fixed && l.conf < 0.6) flags.push(["warn", "Check this is the right product"]);
    if (p && take > shelf) flags.push(["warn", `The Shelf shows ${shelf} in the system`]);
    return { ...l, product: p, qty, fee, feeFrom, take, flags };
  });

  const productsTotal = r2(out.reduce((a, l) => a + (l.fee || 0), 0));
  return {
    lines: out, productsTotal,
    flagCount: out.filter((l) => l.flags.length).length,
    patientName: String(result.patientName || "").slice(0, 150),
    apptDate: /^\d{4}-\d{2}-\d{2}$/.test(result.date || "") ? result.date : "",
    apptTime: String(result.time || "").slice(0, 20),
    provider: String(result.provider || "").slice(0, 80),
  };
}

/* ---------- Already checked out today? ---------- */
// The same patient's sales today that include any of these products: [{ name, qty, by }]
export async function earlierSales(review, productIds) {
  const name = normName(review.patientName);
  if (!name) return [];
  const want = new Set(productIds);
  return (await listSalesOn(dayKey()))
    .filter((s) => !s.voided && normName(s.patientName) === name)
    .flatMap((s) => s.lines.filter((l) => want.has(l.productId)).map((l) => ({ name: l.name, qty: l.qty, by: s.by })));
}


/* ---------- The patient: matched to that day's booking ---------- */
// "2:15PM" / "2:15 pm" → 855
const minutesOf = (t) => {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(String(t || ""));
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  return h * 60 + Number(m[2]);
};
const nameWords = (s) => normName(s).split(" ").filter((w) => w.length > 1);
// 1 = every word the same, 0.5 = half of them (e.g. a missing middle name)
const nameScore = (a, b) => {
  const A = nameWords(a), B = nameWords(b);
  if (!A.length || !B.length) return 0;
  return A.filter((w) => B.includes(w)).length / Math.max(A.length, B.length);
};

// The day's bookings (one per patient + time + staff), sorted by time
export async function bookingsOn(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "")) return [];
  const snap = await getDoc(doc(db, "appts_by_day", dateKey));
  const list = snap.exists() ? (snap.data().appointments || []) : [];
  return list.filter((a) => a.patientName || a.patientId).sort((a, b) => (a.sortMinutes || 0) - (b.sortMinutes || 0));
}

// The booking this sheet belongs to: name ×3, same start time +1, same provider +0.5. Needs 2 or more.
export async function findBooking(review) {
  const date = review.apptDate || dayKey();
  const list = await bookingsOn(date);
  const t = minutesOf(review.apptTime);
  const prov = nameWords(review.provider).filter((w) => w !== "dr").pop() || "";
  let best = null, bestScore = 0;
  list.forEach((a) => {
    let s = nameScore(review.patientName, a.patientName) * 3;
    if (t !== null && minutesOf(a.time) === t) s += 1;
    if (prov && nameWords(a.staff).includes(prov)) s += 0.5;
    if (s > bestScore) { best = a; bestScore = s; }
  });
  return { date, list, match: bestScore >= 2 ? best : null };
}

/* ---------- Saving: the scan, and the sale that takes the products off the Shelf ---------- */
// Returns { id, sale } (sale is null when nothing came off the Shelf)
// Returns { id, sale } (sale is null when nothing came off the Shelf)
// patient: the booking this sheet was matched to { id (Patient ID), name, time, staff }, or null
export async function saveBillingScan({ photo, result, review, note = "", patient = null }, staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const ref = doc(collection(db, "scans"));
  const key = dayKey();
  let file = null;
  if (photo) {
    try {
      const path = `scans/billing/${key}/${ref.id}.jpg`;
      const r = sRef(getStorage(), path);
      await uploadBytes(r, photo, { contentType: "image/jpeg" });
      file = { path, url: await getDownloadURL(r) };
    } catch (err) { console.warn("The scan photo wasn't saved:", err); }
  }
  const cleanNote = String(note || "").trim().slice(0, 1000);
  const patientName = patient && patient.name ? patient.name : review.patientName;
  const sell = review.lines.filter((l) => l.product && l.take > 0)
    .map((l) => ({ productId: l.productId, qty: l.take, fee: l.fee }));
  const data = {
    kind: "billing", dateKey: key, status: review.flagCount ? "flagged" : "ok", flagCount: review.flagCount, note: cleanNote,
    // The patient: from the booking when matched (shown on their dashboard), and the name exactly as read from the sheet
    patientName, readName: review.patientName,
    patientPttId: patient ? String(patient.id || "") : "",
    bookedWith: patient ? String(patient.staff || "") : "",
    bookedAt: patient ? String(patient.time || "") : "",
    apptDate: review.apptDate, apptTime: review.apptTime, provider: review.provider,
    lines: review.lines.map((l) => ({
      productId: l.productId, productName: l.product ? l.product.name : "",
      written: l.written.map((w) => w.text).join(" / "), qty: l.qty, fee: l.fee, feeFrom: l.feeFrom || "",
      seen: l.seen, take: l.take || 0,
      seenAs: l.seenText.join(" / ").slice(0, 300), fixed: !!l.fixed, flags: l.flags.map((f) => f[1]),
    })),
    productsTotal: review.productsTotal,
    photo: file, raw: JSON.stringify(result).slice(0, 20000), saleId: "",
    by: String((staff && staff.name) || "").slice(0, 120), byUid: uid, at: serverTimestamp(),
  };
  if (!sell.length) {
    await setDoc(ref, data);
    return { id: ref.id, sale: null };
  }
  const sale = await recordSale({
    source: "scan", scanId: ref.id, patientName, apptDate: review.apptDate,
    provider: review.provider, note: cleanNote, lines: sell,
  }, staff, { also: (tx, saleId) => tx.set(ref, { ...data, saleId }) });
  return { id: ref.id, sale };
}
/* ---------- Delivery dockets ---------- */
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const expiryOf = (v) => { const s = String(v || "").trim(); return /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? s : ""; };
// "PO-0042", "po 42", "42" → "42"
const poKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^PO/, "").replace(/^0+/, "");
// Words that tell suppliers apart ("Pty Ltd", "Australia" don't)
const SUPPLIER_FILLER = new Set(["pty", "ltd", "limited", "australia", "aust", "au", "inc", "co", "company", "group", "the", "and", "of"]);
const supplierWords = (s) => new Set(normName(s).split(" ").filter((w) => w.length > 1 && !SUPPLIER_FILLER.has(w)));

export const poSupplier = (po) => String((po && po.supplier && po.supplier.name) || (po && po.supplierName) || "");

// The docket read by Gemini (all products are sent: dockets aren't only Retail)
export async function readDocket(base64, products) {
  let res;
  try {
    res = await callApi({
      action: "scanner", op: "docket", mime: "image/jpeg", image: base64,
      products: products.map((p) => ({ id: p.id, name: p.name, brand: p.brand || "" })),
    });
  } catch (err) {
    if (err && err.code === "UNAUTHORIZED") throw err;
    console.error("Docket scanner call failed:", err);
    throw new Error(err && err.message && !err.code ? err.message : "The scanner couldn't be reached. Try again.");
  }
  if (res.problem) throw new Error(res.problem);
  if (!res.result) throw new Error("The scanner couldn't read that docket. Try again.");
  return res.result;
}

// Cleans what Gemini read. Product ids not on the list are dropped.
export function reviewDocket(result, products) {
  const known = new Set(products.map((p) => p.id));
  return {
    supplier: String(result.supplier || "").slice(0, 150),
    docketNumber: String(result.docketNumber || "").slice(0, 60),
    docketDate: ymd(result.docketDate),
    poNumber: String(result.poNumber || "").slice(0, 60),
    receivedByText: String(result.receivedBy || "").slice(0, 120),
    receivedDate: ymd(result.receivedDate),
    receivedTime: /^\d{2}:\d{2}$/.test(String(result.receivedTime || "")) ? result.receivedTime : "",
    lines: (result.lines || []).slice(0, 60).map((l) => ({
      productId: known.has(String(l.productId || "")) ? String(l.productId) : "",
      text: String(l.text || "").slice(0, 150), code: String(l.code || "").slice(0, 60),
      qty: Math.max(0, parseInt(l.qty, 10) || 0), unit: String(l.unit || "").slice(0, 30),
      batch: String(l.batch || "").slice(0, 60), expiry: expiryOf(l.expiry),
      conf: conf(l.confidence), fixed: false,
    })),
  };
}

// Purchase orders still waiting for stock
export async function listOpenPos() {
  return (await listPos()).filter((p) => ["sent", "part"].includes(p.status));
}

// Best first: the PO number printed on the docket (100), the same supplier (10), then each docket product on the order (1)
export function rankPos(review, pos) {
  const want = poKey(review.poNumber);
  const sw = supplierWords(review.supplier);
  const ids = new Set(review.lines.map((l) => l.productId).filter(Boolean));
  return pos.map((po) => {
    const onPo = new Set((po.lines || []).map((l) => l.productId).filter(Boolean));
    const hits = [...ids].filter((id) => onPo.has(id)).length;
    const numberMatch = !!want && poKey(po.number) === want;
    const supplierMatch = [...supplierWords(poSupplier(po))].some((w) => sw.has(w));
    return { po, hits, numberMatch, supplierMatch, score: (numberMatch ? 100 : 0) + (supplierMatch ? 10 : 0) + hits };
  }).sort((a, b) => b.score - a.score || String(b.po.number || "").localeCompare(String(a.po.number || "")));
}

// Active staff (names only), for "Received by"
export async function staffList() {
  const res = await callApi({ action: "staffList" });
  return (res && res.staff) || [];
}

// The staff member a handwritten name belongs to (first name alone is enough), or null
export function matchStaff(text, people) {
  if (!normName(text)) return null;
  let best = null, score = 0;
  people.forEach((p) => { const v = nameScore(text, p.name); if (v > score) { best = p; score = v; } });
  return score >= 0.5 ? best : null;
}

// Saves the docket and its photo. lines: [{ productId, productName, text, code, qty, unit, batch, expiry }]
export async function saveDocketScan({ photo, result, review, lines, po, receivedBy, receivedByUid, receivedAt, note = "" }, staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const ref = doc(collection(db, "scans"));
  const key = dayKey();
  let file = null;
  if (photo) {
    try {
      const path = `scans/docket/${key}/${ref.id}.jpg`;
      const r = sRef(getStorage(), path);
      await uploadBytes(r, photo, { contentType: "image/jpeg" });
      file = { path, url: await getDownloadURL(r) };
    } catch (err) { console.warn("The docket photo wasn't saved:", err); }
  }
  await setDoc(ref, {
    kind: "docket", dateKey: key, status: po ? "linked" : "unlinked",
    supplierName: po ? poSupplier(po) || review.supplier : review.supplier, supplierRead: review.supplier,
    docketNumber: review.docketNumber, docketDate: review.docketDate, poNumberRead: review.poNumber,
    poId: po ? po.id : "", poNumber: po ? String(po.number || "") : "",
    receivedBy: String(receivedBy || "").slice(0, 120), receivedByUid: String(receivedByUid || ""),
    receivedAt: receivedAt.toISOString(),
    lines, note: String(note || "").trim().slice(0, 1000), photo: file,
    raw: JSON.stringify(result).slice(0, 20000), receiptId: "",
    by: String((staff && staff.name) || "").slice(0, 120), byUid: uid, at: serverTimestamp(),
  });
  return { id: ref.id, photoUrl: file ? file.url : "", photoPath: file ? file.path : "" };
}

// After the delivery is received: the docket scan points to its delivery record
export async function linkDocketReceipt(scanId, receiptId) {
  if (!scanId) return;
  await updateDoc(doc(db, "scans", scanId), { status: "received", receiptId: String(receiptId || ""), linkedAt: serverTimestamp() });
}