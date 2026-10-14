// Scanner: a photo is read by Gemini through Apps Script (the API key never reaches the browser),
// matched to the product list here, then saved: the scan (Firestore: scans, photo in Storage) and,
// in the same transaction, the sale that takes the products off the Shelf.
import { db, auth } from "./firebase-config.js";
import { collection, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { callApi } from "./appointments.js";
import { dayKey, recordSale, listSalesOn } from "./inventory-api.js";

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

/* ---------- Saving: the scan, and the sale that takes the products off the Shelf ---------- */
// Returns { id, sale } (sale is null when nothing came off the Shelf)
export async function saveBillingScan({ photo, result, review, note = "" }, staff) {
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
  const sell = review.lines.filter((l) => l.product && l.take > 0)
    .map((l) => ({ productId: l.productId, qty: l.take, fee: l.fee }));
  const data = {
    kind: "billing", dateKey: key, status: review.flagCount ? "flagged" : "ok", flagCount: review.flagCount, note: cleanNote,
    patientName: review.patientName, apptDate: review.apptDate, apptTime: review.apptTime, provider: review.provider,
    lines: review.lines.map((l) => ({
      productId: l.productId, productName: l.product ? l.product.name : "",
      written: l.written.map((w) => w.text).join(" / "), qty: l.qty, fee: l.fee, feeFrom: l.feeFrom || "", seen: l.seen, take: l.take || 0,
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
    source: "scan", scanId: ref.id, patientName: review.patientName, apptDate: review.apptDate,
    provider: review.provider, note: cleanNote, lines: sell,
  }, staff, { also: (tx, saleId) => tx.set(ref, { ...data, saleId }) });
  return { id: ref.id, sale };
}