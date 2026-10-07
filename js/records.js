import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, FieldPath }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { nameVariants, parseRecordDate } from "./transcripts.js";

// Order = display order. First match wins, so more specific patterns come first.
export const CATEGORIES = [
  { key: "wr", title: "Wrinkle Relaxer", color: "#f59e0b",
    match: /wrinkle|relaxer|\bwr\b|anti[\s-]?wrinkle|hyperhidrosis|dysport|botox/i },
  { key: "filler", title: "Filler / Radiesse / Other Injectables", color: "#06b6d4",
    match: /filler|radiesse|hyaluronic|injectable|rejuran|profhilo|skin\s?booster|hyalase|sculptra|fat\s?dissolv|polynucleotide/i },
  { key: "cc", title: "Clear Complexion / OPL", color: "#ec4899",
    match: /clear\s?complexion|\bopl\b|\bipl\b|genesis|laser/i },
  { key: "mn", title: "Refresh Microneedling / RestoraGlow / DermaGlow", color: "#10b981",
    match: /microneedl|restora\s?glow|derma\s?glow|skin\s?needling|\brf\b|radio\s?frequency/i },
  { key: "firm", title: "Ultherapy / Firm / eSkin Tightening", color: "#8b5cf6",
    match: /ulthera|\bfirm\b|exilis|tightening|e\s?skin|\best\b/i },
  { key: "peel", title: "Peel / Vibro", color: "#f97316",
    match: /peel|vibro/i },
  { key: "body", title: "Body Sculpting", color: "#6366f1",
    match: /body|sculpt/i },
];
export const OTHER_CATEGORY = { key: "other", title: "Other", color: "#94a3b8" };

export function categorize(text) {
  const cat = CATEGORIES.find((c) => c.match.test(String(text || "")));
  return cat ? cat.key : "other";
}

// Records for a patient: by Patient ID (doc ID or PttID), optionally by name.
// Name matches that carry a DIFFERENT Patient ID are skipped (another patient's record).
async function byPatient(colName, patient, nameField) {
  const ids = [...new Set([patient.pttId, patient.id].filter(Boolean))];
  const names = nameField ? nameVariants(patient) : [];
  const col = collection(db, colName);

  const [idSnap, nameSnap] = await Promise.all([
    ids.length ? getDocs(query(col, where(new FieldPath("Patient ID"), "in", ids))) : null,
    names.length ? getDocs(query(col, where(new FieldPath(nameField), "in", names))) : null,
  ]);

  const out = new Map();
  if (idSnap) idSnap.forEach((d) => out.set(d.id, { id: d.id, data: d.data(), byName: false }));
  if (nameSnap) nameSnap.forEach((d) => {
    if (out.has(d.id)) return;
    const pid = String(d.data()["Patient ID"] || "").trim();
    if (pid && !ids.includes(pid)) return;
    out.set(d.id, { id: d.id, data: d.data(), byName: true });
  });
  return [...out.values()];
}

const byDateDesc = (a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);

export async function fetchPatientRecords(patient) {
  const [txDocs, consentDocs] = await Promise.all([
    byPatient("treatment_records", patient, "Patient Name"),
    byPatient("consent_records", patient, null),
  ]);

  const consents = consentDocs.map(({ id, data, byName }) => {
    const title = String(data["Consent Type"] || "Consent");
    return {
      id, title,
      category: categorize(title),
      date: parseRecordDate(data["Record Date"]),
      dateText: String(data["Record Date"] || ""),
      staff: String(data.Staff || ""),
      link: String(data["PDF Link"] || ""),
      recordId: String(data["Record ID"] || ""),
      matchedByName: byName,
    };
  }).sort(byDateDesc);

  const treatments = txDocs.map(({ id, data, byName }) => {
    const title = String(data["Treatment Record Type"] || "Treatment record");
    return {
      id, title,
      category: categorize(title),
      date: parseRecordDate(data["Record Date"]),
      dateText: String(data["Record Date"] || ""),
      staff: String(data.Staff || ""),
      link: String(data["File PDF Link"] || ""),
      recordId: String(data["Record ID"] || ""),
      matchedByName: byName,
    };
  }).sort(byDateDesc);

  // Consent on file = most recent consent in the SAME category dated on/before the treatment day
  treatments.forEach((t) => {
    if (!t.date) { t.consent = undefined; return; } // unknown
    const endOfDay = new Date(t.date.getFullYear(), t.date.getMonth(), t.date.getDate(), 23, 59, 59).getTime();
    t.consent = consents.find((c) => c.category === t.category && c.date && c.date.getTime() <= endOfDay) || null;
  });

  return { treatments, consents };
}