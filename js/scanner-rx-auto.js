// Scanner, tap and go: prescriptions and billing sheets are saved without anyone waiting.
// Sure → saved. Not sure → saved as "Needs checking", with a task for whoever checks scans
// (app_settings/scanner.reviewerUid, else the one active staff member called Bethany).
// Prescriptions that need checking stay off the patient's record until they're checked.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { reviewRx, findRxPatient, rxScanExists, saveRxScan, staffList,
  startReview, reviewBilling, findBooking, earlierScans, saveBillingScan } from "./scanner-api.js";
import { rxProductList } from "./rx-products.js";
import { dayKey } from "./inventory-api.js";

const addDays = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// Who checks scans: looked up once per page load
let reviewerP = null;
export function scanReviewer() {
  if (!reviewerP) {
    reviewerP = (async () => {
      const snap = await getDoc(doc(db, "app_settings", "scanner")).catch(() => null);
      const set = snap && snap.exists() ? snap.data() : {};
      const people = await staffList().catch(() => []);
      if (set.reviewerUid) {
        const p = people.find((x) => x.id === set.reviewerUid);
        if (p) return p;
        if (!people.length) return { id: String(set.reviewerUid), name: String(set.reviewerName || "the reviewer") };
      }
      const named = people.filter((x) => /^bethany\b/i.test(String(x.name || "")));
      return named.length === 1 ? named[0] : null;
    })().catch(() => null);
  }
  return reviewerP;
}

const checkText = (what, name, reasons) =>
  `Check a scanned ${what}${name ? ` for “${name}”` : ""}: ${reasons.join("; ")}. Open the Scanner → To check.`;

async function makeTask({ reviewer, patientId = "", patientName = "", text, staff }) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) return "";
  const by = String((staff && staff.name) || "Scanner").slice(0, 120);
  const ref = doc(collection(db, "staff-task-list"));
  await setDoc(ref, {
    patientId: String(patientId || ""), patientName: String(patientName || ""),
    taskText: String(text || "").slice(0, 500), dueDate: dayKey(), status: "Open",
    assignedToId: reviewer ? String(reviewer.id) : "", assignedToName: reviewer ? String(reviewer.name || "") : "",
    createdAt: serverTimestamp(), createdBy: by, createdByUid: uid,
    notes: [], history: [{ at: new Date().toISOString(), by, what: reviewer ? `Assigned to ${reviewer.name}` : "Added" }],
  });
  return ref.id;
}
const taskOrNothing = (p) => p.catch((err) => { console.warn("Check task not made:", err); return ""; });

/* ---------- Prescriptions ---------- */
// → { saved: true, id, patient, review }  or  { saved: false, id, reasons, reviewer, guess, review }
export async function autoRx({ photo, result, staff }) {
  const review = reviewRx(result, rxProductList());
  const today = dayKey();
  const reviewerLater = scanReviewer();
  const [pm, dup] = await Promise.all([
    findRxPatient(review).catch(() => ({ match: null, sure: false, candidates: [] })),
    rxScanExists(review.scriptNumber).catch(() => null),
  ]);

  const reasons = [];
  if (!review.patientName) reasons.push("Patient's name not read");
  else if (!pm.match) reasons.push((pm.candidates || []).length ? "Not sure which patient" : "Patient not found");
  else if (!pm.sure) reasons.push(`Probably ${pm.match.name}, but check`);
  const items = review.items;
  if (!items.length) reasons.push("Nothing prescribed was read");
  else if (items.some((it) => !it.product)) reasons.push("An item isn't on the prescription product list");
  else if (items.some((it) => it.conf < 0.6)) reasons.push("An item was hard to read");
  if (!review.date) reasons.push("Date not read");
  else if (review.date > today) reasons.push("Date is in the future");
  else if (review.date < addDays(today, -365)) reasons.push("Date is more than a year ago");
  if (dup) reasons.push(`Script ${review.scriptNumber} was already saved for ${dup.patientName || "a patient"}`);

  const rxItems = items.map((it) => ({ ...it, custom: false }));
  if (!reasons.length) {
    const saved = await saveRxScan({ photo, result, review, patient: pm.match, date: review.date, items: rxItems, auto: true }, staff);
    return { saved: true, id: saved.id, patient: pm.match, review };
  }
  const reviewer = await reviewerLater;
  const guess = pm.match || (pm.candidates || [])[0] || null;
  const taskId = await taskOrNothing(makeTask({ reviewer, staff,
    patientId: pm.match ? String(pm.match.id || "") : "",   // only when the patient is probably right
    patientName: pm.match ? pm.match.name : review.patientName,
    text: checkText("prescription", review.patientName, reasons) }));
  const saved = await saveRxScan({ photo, result, review, patient: null, date: review.date, items: rxItems,
    check: { reasons, guess, taskId, reviewer } }, staff);
  return { saved: false, id: saved.id, reasons, reviewer, guess, review };
}

/* ---------- Billing sheets ---------- */
// Always saved to the patient (billing sheets never change stock). Anything not clean is marked Needs checking.
// → { saved: true, id, name, review }  or  { saved: false, id, name, reasons, reviewer, review }
export async function autoBilling({ photo, result, products, staff }) {
  const review = reviewBilling(startReview(result, products), result, products);
  const reviewerLater = scanReviewer();
  const booking = await findBooking(review).catch(() => null);
  const a = booking && booking.match;
  const patient = a ? { id: String(a.patientId || ""), name: a.patientName || "", time: a.time || "", staff: a.staff || "" } : null;
  const name = (patient && patient.name) || review.patientName;
  const given = review.lines.filter((l) => l.product && l.take > 0);
  const dup = given.length && name ? await earlierScans(name, given.map((l) => l.productId)).catch(() => []) : [];

  const reasons = [];
  if (!review.lines.length) reasons.push("No products were read");
  if (!patient) reasons.push(review.patientName ? "Not matched to a booking" : "Patient's name not read");
  const flags = [...new Set(review.lines.flatMap((l) => l.flags.map(([, m]) => `${l.product ? l.product.name : "A product"}: ${m}`)))];
  reasons.push(...flags.slice(0, 4));
  if (flags.length > 4) reasons.push(`and ${flags.length - 4} more`);
  if (dup.length) reasons.push("This patient's sheet was already scanned today");

  if (!reasons.length) {
    const saved = await saveBillingScan({ photo, result, review, patient, auto: true }, staff);
    return { saved: true, id: saved.id, name, review };
  }
  const reviewer = await reviewerLater;
  const taskId = await taskOrNothing(makeTask({ reviewer, staff, patientName: name,
    text: checkText("billing sheet", name, reasons) }));
  const saved = await saveBillingScan({ photo, result, review, patient, check: { reasons, taskId, reviewer } }, staff);
  return { saved: false, id: saved.id, name, reasons, reviewer, review };
}