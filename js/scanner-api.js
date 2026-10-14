// Scanner: a photo is read by Gemini through Apps Script (the API key never reaches the browser),
// matched to the product list here, and saved to Firestore (scans) with the photo in Storage.
import { db, auth } from "./firebase-config.js";
import { collection, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { callApi } from "./appointments.js";
import { dayKey } from "./inventory-api.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : r2(v));
const conf = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 1 : Number(v));
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
export async function preparePhoto(blob, max = 2000, quality = 0.85) {
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
export async function readBillingSheet(base64, products) {
  let res;
  try {
    res = await callApi({
      action: "scanner", op: "billing", mime: "image/jpeg", image: base64,
      products: products.map((p) => ({ id: p.id, name: p.name, brand: p.brand || "" })),
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
// One line per product: what's written on the sheet and what's in the photo. Ids not on the list are dropped.
export function startReview(result, products) {
  const known = new Set(products.map((p) => p.id));
  const id = (v) => (known.has(String(v || "")) ? String(v) : "");
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
  return lines;
}

// Flags each line and checks the total. Run again after someone changes a match.
export function reviewBilling(lines, result, products) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const merged = [];
  lines.forEach((l) => {
    const m = l.productId ? merged.find((x) => x.productId === l.productId) : null;
    if (m) {
      m.written.push(...l.written); m.seen += l.seen; m.seenText.push(...l.seenText);
      m.conf = Math.min(m.conf, l.conf); m.fixed = m.fixed || l.fixed;
    } else {
      merged.push({ productId: l.productId, written: [...l.written], seen: l.seen, seenText: [...l.seenText], conf: l.conf, fixed: !!l.fixed });
    }
  });
  const out = merged.map((l) => {
    const p = byId.get(l.productId) || null;
    const qty = l.written.reduce((a, w) => a + w.qty, 0);
    const fee = l.written.some((w) => w.fee !== null) ? r2(l.written.reduce((a, w) => a + (w.fee || 0), 0)) : null;
    const flags = [];
    if (!p) flags.push(["bad", qty ? "Not matched to a product" : "Couldn't tell which product this is"]);
    if (qty && !l.seen) flags.push(["bad", "Written, but not in the photo"]);
    if (!qty && l.seen) flags.push(["bad", "In the photo, but not written on the sheet"]);
    if (qty && l.seen && qty !== l.seen) flags.push(["warn", `${qty} written, ${l.seen} in the photo`]);
    if (qty && fee === null) flags.push(["warn", "No fee written"]);
    else if (qty && p && p.price !== null && p.price !== undefined && Math.abs(fee - p.price * qty) > 0.5) {
      flags.push(["warn", `Fee ${money(fee)}, retail price ${money(r2(p.price * qty))}`]);
    }
    if (p && !l.fixed && l.conf < 0.6) flags.push(["warn", "Check this is the right product"]);
    return { ...l, product: p, qty, fee, flags };
  });

  const services = (result.services || []).map((s) => ({ text: String(s.text || "").slice(0, 150), fee: num(s.fee) }));
  const productsTotal = r2(out.reduce((a, l) => a + (l.fee || 0), 0));
  const servicesTotal = r2(services.reduce((a, s) => a + (s.fee || 0), 0));
  const sum = r2(productsTotal + servicesTotal);
  const credit = num(result.credit) || 0;
  const written = [num(result.grandTotal), num(result.totalToPay)].filter((t) => t !== null);
  const fits = (t) => [sum, r2(sum - credit)].some((s) => Math.abs(t - s) <= 1);
  const totalFlag = written.length && !written.some(fits)
    ? `The fees on the sheet add up to ${money(sum)}, but the total written is ${money(written[0])}.` : "";
  return {
    lines: out, services, productsTotal, servicesTotal, sum, credit,
    writtenTotal: written.length ? written[0] : null, totalFlag,
    flagCount: out.filter((l) => l.flags.length).length + (totalFlag ? 1 : 0),
    patientName: String(result.patientName || "").slice(0, 150),
    apptDate: /^\d{4}-\d{2}-\d{2}$/.test(result.date || "") ? result.date : "",
    apptTime: String(result.time || "").slice(0, 20),
    provider: String(result.provider || "").slice(0, 80),
  };
}

/* ---------- Keeping a record ---------- */
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
  await setDoc(ref, {
    kind: "billing", dateKey: key, status: review.flagCount ? "flagged" : "ok", flagCount: review.flagCount,
    note: String(note || "").trim().slice(0, 1000),
    patientName: review.patientName, apptDate: review.apptDate, apptTime: review.apptTime, provider: review.provider,
    lines: review.lines.map((l) => ({
      productId: l.productId, productName: l.product ? l.product.name : "",
      written: l.written.map((w) => w.text).join(" / "), qty: l.qty, fee: l.fee, seen: l.seen,
      seenAs: l.seenText.join(" / ").slice(0, 300), fixed: !!l.fixed, flags: l.flags.map((f) => f[1]),
    })),
    services: review.services, productsTotal: review.productsTotal, servicesTotal: review.servicesTotal,
    sum: review.sum, credit: review.credit, writtenTotal: review.writtenTotal, totalFlag: review.totalFlag,
    photo: file, raw: JSON.stringify(result).slice(0, 20000),
    by: String((staff && staff.name) || "").slice(0, 120), byUid: uid, at: serverTimestamp(),
  });
  return ref.id;
}