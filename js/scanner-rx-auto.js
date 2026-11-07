// Scanner → Prescription, tap and go. Saved straight to the patient when the scanner is sure.
// Otherwise kept as "Needs checking" (on no patient's record), with a task for whoever checks scans
// (app_settings/scanner.reviewerUid, else the one active staff member called Bethany).
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { reviewRx, findRxPatient, rxScanExists, saveRxScan, staffList } from "./scanner-api.js";
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

async function makeTask({ reviewer, match, review, reasons, staff }) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) return "";
  const by = String((staff && staff.name) || "Scanner").slice(0, 120);
  const ref = doc(collection(db, "staff-task-list"));
  await setDoc(ref, {
    patientId: match ? String(match.id || "") : "",          // only when the patient is probably right
    patientName: match ? String(match.name || "") : String(review.patientName || ""),
    taskText: (`Check a scanned prescription${review.patientName ? ` for “${review.patientName}”` : ""}: `
      + `${reasons.join("; ")}. Open the Scanner → To check.`).slice(0, 500),
    dueDate: dayKey(), status: "Open",
    assignedToId: reviewer ? String(reviewer.id) : "", assignedToName: reviewer ? String(reviewer.name || "") : "",
    createdAt: serverTimestamp(), createdBy: by, createdByUid: uid,
    notes: [], history: [{ at: new Date().toISOString(), by, what: reviewer ? `Assigned to ${reviewer.name}` : "Added" }],
  });
  return ref.id;
}

// → { saved: true, id, patient, review }  or  { saved: false, id, reasons, reviewer, guess, review }
export async function autoRx({ photo, result, staff }) {
  const review = reviewRx(result, rxProductList());
  const today = dayKey();
  const reviewerLater = scanReviewer();   // started now, only waited for if it needs checking
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
  const taskId = await makeTask({ reviewer, match: pm.match, review, reasons, staff })
    .catch((err) => { console.warn("Check task not made:", err); return ""; });
  const saved = await saveRxScan({ photo, result, review, patient: null, date: review.date, items: rxItems,
    check: { reasons, guess, taskId, reviewer } }, staff);
  return { saved: false, id: saved.id, reasons, reviewer, guess, review };
}