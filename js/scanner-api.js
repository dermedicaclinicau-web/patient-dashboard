// Scanner: a photo is read by Gemini through Apps Script (the API key never reaches the browser),
// matched to the product list here, then saved: the scan (Firestore: scans, photo in Storage) and,
// in the same transaction, the sale that takes the products off the Shelf.
import { db, auth } from "./firebase-config.js";
import { collection, doc, setDoc, getDoc, getDocs, query, where, updateDoc, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { callApi } from "./appointments.js";
import { dayKey, listPos } from "./inventory-api.js";
import { fetchPatients, findPatientsById, patientIds } from "./patients.js";


const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : r2(v));
const conf = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 1 : Number(v));
const intOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : parseInt(v, 10));
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
// Same order every time: the list is part of the cached prompt in Apps Script, and any change in order misses the cache
const stableList = (list) => list.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
const stableNames = (list) => (Array.isArray(list) ? list.slice().sort() : list);
export const money = (n) => (n === null || n === undefined ? "" : `$${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)}`);

/* ---------- Testing: which AI reads the photo ---------- */
// scan.html?ai=claude or ?ai=gemini picks it on this device (remembered). ?ai=off goes back to the default.
const SCAN_AI_KEY = "dm.scanAi";
(() => {
  try {
    const q = new URLSearchParams(location.search).get("ai");
    if (q === "off") localStorage.removeItem(SCAN_AI_KEY);
    else if (q === "claude" || q === "gemini") localStorage.setItem(SCAN_AI_KEY, q);
  } catch { /* private mode */ }
})();
const scanAi = () => { try { return localStorage.getItem(SCAN_AI_KEY) || ""; } catch { return ""; } };

// Every scanner request goes through here: adds the AI choice, and logs how long each step took
async function scanCall(body) {
  const ai = scanAi();
  const extra = {};
  if (ai) extra.ai = ai;
  if (scanJob && !String(body.op || "").startsWith("job")) extra.jobId = scanJob;   // Finish later: this read's ID
  const res = await callApi({ ...body, ...extra });
  if (res && res.timing) {
    const t = res.timing;
    console.log(`Scanner timing (${t.ai}): ` +
      (t.steps || []).map((s) => `${s.step} ${s.ms} ms (${s.ai}, ${s.model})`).join(" + ") + ` = ${t.ms} ms`);
  }
  return res;
}

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

// At most `max` px on the long side, as JPEG. thumbMax: also a small copy (Auto-detect), made from the same decode.
export async function preparePhoto(blob, max = 1600, quality = 0.8, thumbMax = 0) {
  const img = await loadImage(blob);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const enc = (cv, q) => new Promise((res) => cv.toBlob(res, "image/jpeg", q));
  const out = await enc(c, quality);
  if (!out) throw new Error("That photo couldn't be prepared. Try again.");
  let thumbBlob = null;
  if (thumbMax) {
    const t = Math.min(1, thumbMax / Math.max(c.width, c.height));
    const tc = document.createElement("canvas");
    tc.width = Math.round(c.width * t);
    tc.height = Math.round(c.height * t);
    tc.getContext("2d").drawImage(c, 0, 0, tc.width, tc.height);
    thumbBlob = await enc(tc, 0.7);
  }
  const [base64, thumb] = await Promise.all([toBase64(out), thumbBlob ? toBase64(thumbBlob) : ""]);
  return { blob: out, base64, thumb };
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
    res = await scanCall({
      action: "scanner", op: "billing", mime: "image/jpeg", image: base64,
      products: stableList(sellable(products)).map((p) => ({ id: p.id, name: p.name, brand: p.brand || "" })),
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

// A small copy, for working out what the photo is (quicker than the full one)
export async function smallCopy(blob) {
  return (await preparePhoto(blob, 768, 0.7)).base64;
}

// Auto: Apps Script works out whether it's a billing sheet, docket or prescription, then reads it, in one request.
// → { auto: { kind, guess, confidence, looksLike, notAllowed? }, result, problem }
export async function readAuto(base64, thumb, products, rxProducts) {
  const sell = new Set(sellable(products).map((p) => p.id));
  let res;
  try {
    res = await scanCall({
      action: "scanner", op: "auto", mime: "image/jpeg", image: base64, thumb,
      products: stableList(products).map((p) => ({ id: p.id, name: p.name, brand: p.brand || "", sell: sell.has(p.id) })),
      rxProducts: stableNames(rxProducts),
    });
  } catch (err) {
    if (err && err.code === "UNAUTHORIZED") throw err;
    console.error("Scanner call failed:", err);
    throw new Error(err && err.message && !err.code ? err.message : "The scanner couldn't be reached. Try again.");
  }
  return { auto: res.auto || null, result: res.result || null, problem: res.problem || "" };
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

/* ---------- Already scanned today? ---------- */
// The same patient's billing sheets scanned today that include any of these products: [{ name, qty, by }]
export async function earlierScans(patientName, productIds) {
  const name = normName(patientName);
  if (!name) return [];
  const want = new Set(productIds);
  const snap = await getDocs(query(collection(db, "scans"), where("dateKey", "==", dayKey())));
  return snap.docs.map((d) => d.data())
    .filter((s) => s.kind === "billing" && s.status !== "deleted" && normName(s.patientName) === name)
    .flatMap((s) => (s.lines || []).filter((l) => want.has(l.productId) && (Number(l.take) || 0) > 0)
      .map((l) => ({ name: l.productName || "a product", qty: Number(l.take) || 0, by: s.by || "" })));
}


/* ---------- Today's scans (the strip under the camera) ---------- */
// Every scan saved today on any device, newest first
export async function todaysScans() {
  const snap = await getDocs(query(collection(db, "scans"), where("dateKey", "==", dayKey())));
  const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => s.status !== "deleted")
    .sort((a, b) => ms(b.at) - ms(a.at));
}

/* ---------- A saved scan: review, correct or delete (Scanner → Today) ---------- */
// Only the scan record changes: billing sheets and prescriptions never took stock off.
const SCAN_EDIT_KEYS = {
  billing: ["patientName", "patientPttId", "bookedWith", "bookedAt", "apptDate", "apptTime", "provider",
    "lines", "productsTotal", "flagCount", "status", "note"],
  rx: ["patientId", "patientPttId", "patientIds", "patientName", "recordDate", "prescriber", "scriptNumber", "items", "note", "status"],
};

export async function getScan(id) {
  const s = await getDoc(doc(db, "scans", String(id || "")));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

// changes: only the fields that changed. summary: ["Patient: A → B", …] for the history.
// remove: mark it deleted instead. One transaction; the first version is kept in "original".
export async function updateScan(id, changes, { reason, summary = [], remove = false }, staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const why = String(reason || "").trim().slice(0, 300);
  if (!why) throw new Error(remove ? "Add why it's being deleted." : "Add why it's being changed.");
  const by = String((staff && staff.name) || "").slice(0, 120);
  const ref = doc(db, "scans", id);
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error("This scan no longer exists.");
    const d = s.data();
    if (d.status === "deleted") throw new Error("This scan has already been deleted.");
    const keys = SCAN_EDIT_KEYS[d.kind];
    if (!keys) throw new Error("This kind of scan can't be changed here.");
    const patch = {};
    if (remove) Object.assign(patch, { status: "deleted", deleteReason: why, deletedAt: serverTimestamp(), deletedBy: by });
    else Object.keys(changes || {}).forEach((k) => { if (keys.includes(k)) patch[k] = changes[k]; });
    if (!Object.keys(patch).length) throw new Error("Nothing has changed.");
    if (!d.original) {
      const o = {};
      keys.forEach((k) => { if (d[k] !== undefined) o[k] = d[k]; });
      patch.original = o;
    }
    patch.edits = [...(Array.isArray(d.edits) ? d.edits : []), {
      at: new Date().toISOString(), by, byUid: uid, reason: why, deleted: !!remove,
      changes: summary.slice(0, 20).map((x) => String(x).slice(0, 300)),
    }].slice(-30);
    patch.editCount = (Number(d.editCount) || 0) + 1;
    Object.assign(patch, { editedAt: serverTimestamp(), editedBy: by, editedByUid: uid });
    tx.update(ref, patch);
  });
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

/* ---------- Saving: the billing sheet, kept as a record of what was given ---------- */
// auto: saved by the scanner with nobody checking. check: { reasons, taskId, reviewer } → saved to the patient,
// marked Needs checking (Scanner → To check) until someone checks it.
export async function saveBillingScan({ photo, result, review, note = "", patient = null, auto = false, check = null }, staff) {
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
  const data = {
    kind: "billing", dateKey: key, status: check ? "check" : review.flagCount ? "flagged" : "ok",
    flagCount: review.flagCount, note: cleanNote,
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
    stockChanged: false,
    photo: file, raw: JSON.stringify(result).slice(0, 20000), saleId: "",
    by: String((staff && staff.name) || "").slice(0, 120), byUid: uid, at: serverTimestamp(),
  };
  if (auto) data.autoSaved = true;
  if (check) {
    Object.assign(data, {
      checkReasons: (check.reasons || []).map(String).slice(0, 8),
      checkTaskId: String(check.taskId || ""),
      checkWith: check.reviewer ? String(check.reviewer.name || "") : "",
    });
  }
  await setDoc(ref, data);
  return { id: ref.id };
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
    res = await scanCall({
      action: "scanner", op: "docket", mime: "image/jpeg", image: base64,
      products: stableList(products).map((p) => ({ id: p.id, name: p.name, brand: p.brand || "" })),
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
    formType: result.formType === "dermedica" ? "dermedica" : "supplier",
    transferType: ["delivery", "transfer"].includes(result.transferType) ? result.transferType : "",
    lines: joinDocketLines((result.lines || []).slice(0, 60).map((l) => ({
      productId: known.has(String(l.productId || "")) ? String(l.productId) : "",
      text: String(l.text || "").slice(0, 150), code: String(l.code || "").slice(0, 60),
      qty: Math.max(0, parseInt(l.qty, 10) || 0), unit: String(l.unit || "").slice(0, 30),
      batch: String(l.batch || "").slice(0, 60), expiry: expiryOf(l.expiry),
      conf: conf(l.confidence), fixed: false, count: 1,
      formQty: intOrNull(l.formQty), toShelf: intOrNull(l.toShelf), toJt: intOrNull(l.toJt),
    }))),
  };
}

// The same product, batch and expiry printed on several lines → one line (quantities added).
// Different batches stay separate: each is received on its own row.
function joinDocketLines(lines) {
  const out = [];
  lines.forEach((l) => {
    const same = l.productId && out.find((x) => x.productId === l.productId && x.batch === l.batch && x.expiry === l.expiry);
    if (!same) { out.push(l); return; }
    same.qty += l.qty;
    same.count += 1;
    same.conf = Math.min(same.conf, l.conf);
  });
  return out;
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
let staffCache = null;   // once per page load: the docket screen no longer waits on Apps Script for it
export function staffList() {
  if (!staffCache) {
    staffCache = callApi({ action: "staffList" }).then((res) => (res && res.staff) || [])
      .catch((err) => { staffCache = null; throw err; });
  }
  return staffCache;
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
  // A readable name: date_PO_Docket_Supplier__id.jpg (Storage can't rename a file later, so it's named now)
  const part = (s, n = 40) => String(s || "").trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, n);
  const supplierName = po ? poSupplier(po) || review.supplier : review.supplier;
  const base = [
    key,
    po ? part(po.number) : "No-PO",
    review.docketNumber ? `Docket-${part(review.docketNumber, 30)}` : "",
    part(supplierName, 30),
  ].filter(Boolean).join("_");
  const fileName = `${base}__${ref.id.slice(0, 6)}.jpg`;

  let file = null;
  if (photo) {
    try {
      const path = `scans/docket/${key}/${fileName}`;
      const r = sRef(getStorage(), path);
      await uploadBytes(r, photo, {
        contentType: "image/jpeg",
        contentDisposition: `inline; filename="${fileName}"`,   // downloads keep the readable name
      });
      file = { path, url: await getDownloadURL(r), name: fileName };
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

// After an internal transfer (Delivery Docket Form → JT storage to the Shelf): the scan records what moved
export async function markDocketTransferred(scanId, { moved = [], releases = [] } = {}) {
  if (!scanId) return;
  await updateDoc(doc(db, "scans", scanId), {
    status: "transferred", transferType: "transfer",
    moved: moved.map((m) => ({ productId: m.productId, name: m.name, qty: m.qty, unit: m.unit })).slice(0, 60),
    releaseIds: releases.map((r) => r.id).slice(0, 40),
    linkedAt: serverTimestamp(),
  });
}


/* ---------- Product prescriptions ---------- */
export async function readPrescription(base64, rxProducts) {
  let res;
  try {
    res = await scanCall({ action: "scanner", op: "rx", mime: "image/jpeg", image: base64, rxProducts: stableNames(rxProducts) });
  } catch (err) {
    if (err && err.code === "UNAUTHORIZED") throw err;
    console.error("Prescription scanner call failed:", err);
    throw new Error(err && err.message && !err.code ? err.message : "The scanner couldn't be reached. Try again.");
  }
  if (res.problem) throw new Error(res.problem);
  if (!res.result) throw new Error("The scanner couldn't read that prescription. Try again.");
  return res.result;
}

// Only exact names from the list are kept. Fading Cream is decided here too (any of its ingredients).
const FADING_RE = /\b(hq|hydroquinone|kojic|ascorbic|dexameth\w*|dexa)\b/i;
export function reviewRx(result, rxProducts) {
  const byLower = new Map(rxProducts.map((n) => [n.toLowerCase(), n]));
  const fading = byLower.get("fading cream") || "";
  const items = (result.items || []).slice(0, 20).map((it) => {
    const text = String(it.text || "").slice(0, 500);
    const strengths = String(it.strengths || "").slice(0, 300);
    let product = byLower.get(String(it.product || "").trim().toLowerCase()) || "";
    if (fading && FADING_RE.test(`${text} ${strengths}`)) product = fading;
    return {
      text, product, strengths, medicine: String(it.medicine || "").replace(/\s+/g, " ").trim().slice(0, 200),
      quantity: String(it.quantity || "").slice(0, 60),
      directions: String(it.directions || "").slice(0, 300), repeats: String(it.repeats || "").slice(0, 20),
      conf: conf(it.confidence), fixed: false,
    };
  }).filter((it) => it.text || it.product);
  return {
    patientName: String(result.patientName || "").slice(0, 150),
    address: String(result.address || "").slice(0, 300),
    postcode: String(result.postcode || "").replace(/\D/g, "").slice(0, 4),
    date: ymd(result.date),
    scriptNumber: String(result.scriptNumber || "").trim().toUpperCase().slice(0, 40),
    prescriber: String(result.prescriber || "").slice(0, 120),
    items,
  };
}
/* ---------- Finding patients: any order, part of a name, small typos, mobile or ID ---------- */
// Searched in the Patient List index (patient_index, rebuilt every morning), kept in memory for 30 minutes.
// The plain search still runs alongside, so patients added since this morning are found too.
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// "O'Brien-Smith" → ["obrien", "smith"]
const searchWords = (s) => fold(s).replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const phoneKey = (s) => String(s ?? "").replace(/\D/g, "").replace(/^61(?=4)/, "0");

let ptIndex = null, ptIndexAt = 0;

function ptEntry(id, f) {
  const first = String(f["First Name"] || "").trim();
  const last = String(f["Last Name"] || "").trim();
  const name = String(f["Patient Name"] || `${first} ${last}`).trim();
  const mergedIds = Array.isArray(f.MergedIds) ? f.MergedIds.map(String) : [];
  const mergedNames = Array.isArray(f.MergedNames) ? f.MergedNames.map(String) : [];
  const pttId = String(f.PttID ?? id);
  return {
    words: [...new Set([name, `${first} ${last}`, ...mergedNames].flatMap(searchWords))],
    ids: [id, pttId, ...mergedIds].map((x) => fold(x).trim()).filter(Boolean),
    phone: phoneKey(f.Mobile),
    p: { ...f, id, pttId, name, firstName: first, lastName: last, dob: String(f.DOB || ""), dobKey: String(f.DobKey || ""),
      address: String(f.Address || ""), email: String(f.Email || ""), mobile: String(f.Mobile || ""),
      mergedIds, mergedNames, mergedInto: "" },
  };
}

function loadPtIndex() {
  if (ptIndex && Date.now() - ptIndexAt < 30 * 60000) return ptIndex;
  ptIndexAt = Date.now();
  ptIndex = (async () => {
    const meta = await getDoc(doc(db, "patient_index", "meta"));
    const m = meta.exists() ? meta.data() : null;
    const n = m ? Number(m.parts) || 0 : 0;
    if (!n) throw new Error("No patient index yet");
    const parts = await Promise.all(Array.from({ length: n }, (_, i) => getDoc(doc(db, "patient_index", `p${i}`))));
    const rows = [];
    parts.forEach((s) => {
      if (!s.exists() || s.data().build !== m.build) throw new Error("The patient index is being rebuilt");
      JSON.parse(s.data().data || "[]").forEach(([id, f]) => { if (f && !f.MergedInto) rows.push(ptEntry(String(id), f)); });
    });
    return rows;
  })().catch((err) => {
    console.warn("Patient search index not loaded, using the plain search:", err);
    ptIndexAt = Date.now() - 25 * 60000;   // tried again in 5 minutes
    return null;
  });
  return ptIndex;
}
// Starts loading the index early (e.g. when the patient picker opens), so the first search is quick
export function warmPatientSearch() { loadPtIndex(); }

// Letters different between two words (swapped letters count as one), giving up past max
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let pp = null, p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      c[j] = v;
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
    pp = p; p = c;
  }
  return p[b.length];
}

// 4 the same · 3 the start of it · 2 a small typo · 1 a typo in the start · 0 no match
function wordScore(q, w) {
  if (w === q) return 4;
  if (w.startsWith(q)) return 3;
  if (q.length < 4 || q[0] !== w[0]) return 0;   // typos only for 4+ letters, with the first letter right
  const max = q.length >= 7 ? 2 : 1;
  if (editDist(q, w, max) <= max) return 2;
  if (w.length > q.length && editDist(q, w.slice(0, q.length), max) <= max) return 1;
  return 0;
}

// all: every typed word must match part of the name (the search box). Otherwise any word (finding a prescription's patient).
function rankIndex(idx, text, { max = 12, all = true } = {}) {
  const qs = searchWords(text);
  if (!idx || !qs.length) return [];
  const digits = phoneKey(text);
  const isId = qs.length === 1 && /\d/.test(qs[0]);
  const out = [];
  for (const e of idx) {
    let score = 0;
    if (isId && e.ids.includes(qs[0])) score = 100;
    else if (digits.length >= 6 && e.phone && e.phone.includes(digits)) score = 50;
    else {
      let hit = 0, total = 0;
      for (const q of qs) {
        let best = 0;
        for (const w of e.words) { const s = wordScore(q, w); if (s > best) best = s; if (best === 4) break; }
        if (best) hit++;
        total += best;
      }
      if (all ? hit === qs.length : hit > 0) score = total;
    }
    if (score) out.push({ e, score });
  }
  out.sort((a, b) => b.score - a.score || a.e.p.name.localeCompare(b.e.p.name));
  return out.slice(0, max).map((x) => x.e.p);
}

// The patient this prescription is for, from every patient (not just today's bookings).
// Picked automatically only when one patient is clearly the best (the same strict rule as before).
// The list to choose from also has misspelt names and names in a different order.
export async function findRxPatient(review) {
  const read = String(review.patientName || "");
  const name = normName(read);
  if (!name) return { match: null, sure: false, candidates: [] };
  const words = name.split(" ").filter((w) => w.length > 1);
  const terms = [...new Set([name, words[words.length - 1], words[0]].filter(Boolean))];
  const [idx, ...results] = await Promise.all([loadPtIndex(),
    ...terms.map((t) => fetchPatients({ mode: "name", term: t }).catch(() => ({ patients: [] })))]);
  const found = new Map();
  results.forEach((r) => (r.patients || []).forEach((p) => { if (!p.mergedInto) found.set(p.id, p); }));
  const fuzzy = rankIndex(idx, read, { max: 20, all: false });
  fuzzy.forEach((p) => { if (!found.has(p.id)) found.set(p.id, p); });
  const rankOf = new Map(fuzzy.map((p, i) => [p.id, i]));
  const pc = review.postcode;
  const scored = [...found.values()].map((p) => {
    const n = nameScore(read, p.name);
    const pcHit = !!pc && String(p.address || "").includes(pc);
    return { p, n, pcHit, s: n + (pcHit ? 0.3 : 0), r: rankOf.has(p.id) ? rankOf.get(p.id) : 999 };
  }).filter((x) => x.s >= 0.5 || x.r < 999);
  const best = scored.slice().sort((a, b) => b.s - a.s);
  const top = best[0];
  const clear = !!top && top.s >= 0.8 && (!best[1] || best[1].s <= top.s - 0.3);
  // Sure enough to save with nobody checking: the whole name matches, or most of it and the postcode
  const sure = clear && (top.n >= 0.99 || (top.n >= 0.66 && top.pcHit));
  scored.sort((a, b) => a.r - b.r || b.s - a.s);   // the list: best name match first
  return { match: clear ? top.p : null, sure, candidates: scored.slice(0, 8).map((x) => x.p) };
}

// The search box: name (any order, part of it, small typos), mobile or patient ID
export async function searchPatientsQuick(term) {
  const t = String(term || "").trim();
  if (t.length < 2) return [];
  const [idx, byId, byName] = await Promise.all([
    loadPtIndex(),
    findPatientsById(t).catch(() => []),
    fetchPatients({ mode: "name", term: normName(t) }).then((r) => r.patients || []).catch(() => []),
  ]);
  const full = new Map();
  [...byId, ...byName].forEach((p) => { if (p && !p.mergedInto) full.set(p.id, p); });
  const out = new Map();
  byId.forEach((p) => { if (p && !p.mergedInto) out.set(p.id, p); });   // an exact patient ID first
  rankIndex(idx, t).forEach((p) => { if (!out.has(p.id)) out.set(p.id, full.get(p.id) || p); });
  byName.forEach((p) => { if (p && !p.mergedInto && !out.has(p.id)) out.set(p.id, p); });   // added since this morning
  return [...out.values()].slice(0, 12);
}

// A prescription with this script number that's already been saved, or null
export async function rxScanExists(scriptNumber) {
  const n = String(scriptNumber || "").trim().toUpperCase();
  if (!n) return null;
  const snap = await getDocs(query(collection(db, "scans"), where("scriptNumber", "==", n)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((x) => x.kind === "rx" && x.status !== "deleted") || null;
}

// Saves the prescription and its photo, shown on the patient's Product Prescriptions card.
// auto: saved by the scanner with nobody checking. check: { reasons, guess, taskId, reviewer } → kept as
// "Needs checking" on no patient's record until someone checks it (Scanner → To check).
export async function saveRxScan({ photo, result, review, patient = null, date, items, note = "", auto = false, check = null }, staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  if (!patient && !check) throw new Error("Choose the patient first.");
  const ref = doc(collection(db, "scans"));
  const key = dayKey();
  const part = (s, n = 40) => String(s || "").trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, n);
  const guess = check && check.guess ? check.guess : null;
  const who = patient ? patient.name : `To-check-${(guess && guess.name) || review.patientName || "patient"}`;
  const fileName = `${date || key}_${part(who, 50)}${review.scriptNumber ? `_${part(review.scriptNumber, 20)}` : ""}__${ref.id.slice(0, 6)}.jpg`;
  let file = null;
  if (photo) {
    try {
      const path = `scans/rx/${key}/${fileName}`;
      const r = sRef(getStorage(), path);
      await uploadBytes(r, photo, { contentType: "image/jpeg", contentDisposition: `inline; filename="${fileName}"` });
      file = { path, url: await getDownloadURL(r), name: fileName };
    } catch (err) { console.warn("The prescription photo wasn't saved:", err); }
  }
  const data = {
    kind: "rx", dateKey: key, status: check ? "check" : "saved",
    patientId: patient ? patient.id : "", patientPttId: patient ? String(patient.pttId || "") : "",
    patientIds: patient ? patientIds(patient) : [], patientName: patient ? patient.name : "", readName: review.patientName,
    recordDate: date || "", scriptNumber: review.scriptNumber, prescriber: review.prescriber,
    items: items.map((it) => ({
      product: it.product, text: it.text, medicine: String(it.medicine || "").trim().slice(0, 200), custom: it.custom === true,
      strengths: String(it.strengths || "").trim().slice(0, 300),
      quantity: String(it.quantity || "").trim().slice(0, 60), directions: String(it.directions || "").trim().slice(0, 300),
      repeats: String(it.repeats || "").trim().slice(0, 20), fixed: !!it.fixed,
    })),
    note: String(note || "").trim().slice(0, 1000), photo: file, raw: JSON.stringify(result).slice(0, 20000),
    by: String((staff && staff.name) || "").slice(0, 120), byUid: uid, at: serverTimestamp(),
  };
  if (auto) data.autoSaved = true;
  if (check) {
    Object.assign(data, {
      checkReasons: (check.reasons || []).map(String).slice(0, 8),
      checkTaskId: String(check.taskId || ""),
      checkWith: check.reviewer ? String(check.reviewer.name || "") : "",
      suggested: guess ? { id: String(guess.id || ""), pttId: String(guess.pttId || ""), name: String(guess.name || ""),
        ids: patientIds(guess) } : null,
    });
  }
  await setDoc(ref, data);
  return { id: ref.id };
}

// Prescriptions and billing sheets waiting to be checked, oldest first
export async function scansToCheck() {
  const snap = await getDocs(query(collection(db, "scans"), where("status", "==", "check")));
  const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.kind === "rx" || s.kind === "billing")
    .sort((a, b) => ms(a.at) - ms(b.at));
}
/* ---------- Finish later (scan_jobs) ---------- */
let scanJob = "";
// Sets the job ID sent with the next read. Clearing with ("", id) only clears it if it's still that read's.
export function setScanJob(id, ifWas) { if (ifWas === undefined || scanJob === ifWas) scanJob = id || ""; }
export function newScanJobId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return "sj_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// The Finish later requests. A "problem" from Apps Script becomes an error, so the Scanner can show it.
async function jobCall(op, fields) {
  const r = await scanCall({ action: "scanner", op, ...fields });
  if (r && r.problem) throw new Error(r.problem);
  return r;
}
export const parkScan = (jobId, base64, kind, readAs) =>
  jobCall("jobPark", { jobId, image: base64, mime: "image/jpeg", kind, readAs });
export const scanJobs = () => jobCall("jobList", {}).then((r) => (r && r.jobs) || []);
export const openScanJob = (jobId) => jobCall("jobOpen", { jobId });
export const finishScanJob = (jobId) => jobCall("jobDone", { jobId }).catch(() => {});