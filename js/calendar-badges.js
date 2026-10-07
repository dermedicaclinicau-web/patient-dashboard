import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, getDoc, doc, FieldPath }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { parseDateKey } from "./utils.js";
import { extractSection } from "./transcripts.js";

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORDER = ["plan", "summary", "tx", "consent", "rx"];

// "Jan BRAY", "Jan Bray #1" -> "jan bray"
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();

// Every way a date might be written in your collections
function dateVariants(dateKey) {
  const d = parseDateKey(dateKey);
  if (!d) return [];
  const day = d.getDate();
  const dd = String(day).padStart(2, "0");
  const m = d.getMonth();
  const mm = String(m + 1).padStart(2, "0");
  const y = d.getFullYear();
  return [...new Set([
    dateKey,                                  // 2026-10-07
    `${MONTHS_LONG[m]} ${day}, ${y}`,         // October 7, 2026
    `${MONTHS_LONG[m]} ${dd}, ${y}`,          // October 07, 2026
    `${MONTHS_SHORT[m]} ${day}, ${y}`,        // Oct 7, 2026
    `${day} ${MONTHS_LONG[m]} ${y}`,          // 7 October 2026
    `${dd}/${mm}/${y}`,                       // 07/10/2026
    `${day}/${m + 1}/${y}`,                   // 7/10/2026
  ])];
}

async function byExactDate(col, field, variants) {
  const snap = await getDocs(query(collection(db, col), where(new FieldPath(field), "in", variants)));
  return snap.docs.map((d) => d.data());
}

// Transcript dates may include a time ("October 7, 2026 10:30 AM"), so match by prefix
async function transcriptsOn(dateKey) {
  const d = parseDateKey(dateKey);
  const day = d.getDate();
  const dd = String(day).padStart(2, "0");
  const m = d.getMonth();
  const y = d.getFullYear();
  const prefixes = [...new Set([
    `${MONTHS_LONG[m]} ${day}, ${y}`,
    `${MONTHS_LONG[m]} ${dd}, ${y}`,
    dateKey,
    `${dd}/${String(m + 1).padStart(2, "0")}/${y}`,
  ])];

  const field = new FieldPath("Record Date and Time");
  const snaps = await Promise.all(prefixes.map((p) =>
    getDocs(query(collection(db, "appointment_transcripts"), where(field, ">=", p), where(field, "<=", p + "\uf8ff")))
  ));

  const out = new Map();
  snaps.forEach((s) => s.forEach((docSnap) => out.set(docSnap.id, docSnap.data())));
  return [...out.values()];
}

/**
 * Loads every record for one day and returns badgesFor(appointment) -> ["plan","summary",...]
 */
export async function fetchDayBadges(dateKey, appts) {
  const variants = dateVariants(dateKey);
  if (!variants.length) return () => [];

  const results = await Promise.allSettled([
    byExactDate("treatment_records", "Record Date", variants),
    byExactDate("consent_records", "Record Date", variants),
    byExactDate("prescription_record", "Record Date", variants),
    transcriptsOn(dateKey),
  ]);
  const ok = (r, label) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`Calendar badges: ${label} failed`, r.reason);
    return [];
  };
  const [tx, consent, rx, transcripts] = [
    ok(results[0], "treatment records"), ok(results[1], "consents"),
    ok(results[2], "prescriptions"), ok(results[3], "transcripts"),
  ];

  const records = [];
  tx.forEach((r) => records.push({ type: "tx", id: r["Patient ID"], name: r["Patient Name"] }));
  consent.forEach((r) => records.push({ type: "consent", id: r["Patient ID"], name: "" }));
  rx.forEach((r) => records.push({ type: "rx", id: r["Patient ID"], name: "" }));
  transcripts.forEach((r) => {
    records.push({ type: "summary", id: r["Patient ID"], name: r["Patient Name"] });
    if (extractSection(r["Gemini SOAP"], "TREATMENT PLAN")) {
      records.push({ type: "plan", id: r["Patient ID"], name: r["Patient Name"] });
    }
  });
  records.forEach((r) => { r.id = String(r.id || "").trim(); r.name = norm(r.name); });

  // Record IDs that aren't schedule IDs (e.g. Firestore doc IDs) -> look up their clinic ID + name
  const apptIds = new Set(appts.map((a) => String(a.patientId || "").trim()).filter(Boolean));
  const unknown = [...new Set(records.map((r) => r.id)
    .filter((id) => id && !apptIds.has(id) && /^[\w-]{1,128}$/.test(id)))].slice(0, 60);

  const alias = new Map();
  const snaps = await Promise.allSettled(unknown.map((id) => getDoc(doc(db, "patient_list", id))));
  snaps.forEach((s, i) => {
    if (s.status === "fulfilled" && s.value.exists()) {
      const d = s.value.data();
      alias.set(unknown[i], { pttId: String(d.PttID || "").trim(), name: norm(d["Patient Name"]) });
    }
  });

  return function badgesFor(appt) {
    const pid = String(appt.patientId || "").trim();
    const pname = norm(appt.patientName);
    const types = new Set();

    records.forEach((r) => {
      const a = alias.get(r.id);
      // Which appointment ID (if any) this record clearly belongs to
      const resolved = apptIds.has(r.id) ? r.id : (a && apptIds.has(a.pttId) ? a.pttId : "");
      if (resolved) {
        if (resolved === pid) types.add(r.type);
        return; // ID-matched records never fall back to name
      }
      const rName = r.name || (a && a.name) || "";
      if (rName && rName === pname) types.add(r.type);
    });

    return ORDER.filter((t) => types.has(t));
  };
}