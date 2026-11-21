import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, getDoc, doc, FieldPath }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { parseDateKey, toDateKey } from "./utils.js";
import { extractSection, parseRecordDate } from "./transcripts.js";
import { categorize, portalCategory, CATEGORIES, OTHER_CATEGORY, categoryFixes, fixedCat } from "./records.js";
import { listPublishedForms, getFormTemplate, getFormVersion, formGroup } from "./form-templates.js";

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORDER = ["plan", "summary", "tx", "consent", "rx"];

// The short code after Tx / Cons ("Tx WR"). "Other" has no code.
export const CAT_CODES = { wr: "WR", filler: "FL", cc: "CC", mn: "MN", firm: "FM", peel: "PL", body: "BS" };
const ALL_CATS = [...CATEGORIES, OTHER_CATEGORY];
const CAT_RANK = new Map(ALL_CATS.map((c, i) => [c.key, i]));
const CAT_TITLE = new Map(ALL_CATS.map((c) => [c.key, c.title]));

// "Jan BRAY", "Jan Bray #1" -> "jan bray"
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();

/* ---------- Consent on file for today's treatments ---------- */

const CANCELLED = /cancel|no.?show|\bdna\b|did not attend/i;
const NO_CONSENT_SVC = /\breview|consult|follow.?up|check.?up/i;   // these services never need a consent
const isoKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function monthsBefore(dateKey, n) {
  const d = parseDateKey(dateKey);
  d.setMonth(d.getMonth() - n);
  return isoKey(d);
}

// Which treatment groups need a consent, and for how many months: from the published treatment records
// that have a Consent check. → Map(group → months). Remembered for 10 minutes.
let rulesMemo = null;
function consentRules() {
  if (rulesMemo && Date.now() - rulesMemo.at < 600000) return rulesMemo.p;
  const p = (async () => {
    const forms = (await listPublishedForms()).filter((t) => t.category === "treatment");
    const vers = await Promise.allSettled(forms.map(async (t) => {
      const v = t.version || ((await getFormTemplate(t.id)) || {}).version;
      return v ? getFormVersion(t.id, v) : null;
    }));
    const out = new Map();
    vers.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value) return;
      const g = formGroup(forms[i]);
      if (!g || g === "other") return;
      (r.value.fields || []).forEach((f) => {
        if (!f || f.type !== "consent_status") return;
        const m = Number(f.months) || 12;
        out.set(g, Math.min(out.get(g) || m, m));   // two forms disagree: the shorter one
      });
    });
    return out;
  })();
  rulesMemo = { at: Date.now(), p };
  p.catch(() => { rulesMemo = null; });
  return p;
}

// Portal consents for some patients, from a date onwards (only consents recent enough to matter are read,
// as they carry signatures). Needs a Firestore index the first time; until then it reads them all.
async function portalConsents(field, ids, fromKey) {
  const col = collection(db, "form_submissions");
  try {
    return await getDocs(query(col, where("category", "==", "consent"), where(field, "in", ids), where("recordDate", ">=", fromKey)));
  } catch (err) {
    if (err && err.code !== "failed-precondition") throw err;
    console.warn(`Calendar consent check: create the Firestore index from this link to make it quicker. ${err.message}`);
    return getDocs(query(col, where("category", "==", "consent"), where(field, "in", ids)));
  }
}

// Every consent for the day's patients → Map(patient ID on the schedule → [{ cat, date, title }])
async function consentsOf(ids, fromKey) {
  const out = new Map();
  const add = (id, c) => { if (!id) return; if (!out.has(id)) out.set(id, []); out.get(id).push(c); };
  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  const legacy = [];
  await Promise.all(chunks.map(async (c) => {
    const [old, byPtt, byDoc] = await Promise.all([
      getDocs(query(collection(db, "consent_records"), where(new FieldPath("Patient ID"), "in", c))),
      portalConsents("patientPttId", c, fromKey),
      portalConsents("patientId", c, fromKey),
    ]);
    old.forEach((d) => {
      const x = d.data();
      if (x.deleted === true) return;
      legacy.push({ docId: d.id, pid: String(x["Patient ID"] || "").trim(), title: String(x["Consent Type"] || "Consent"), raw: x["Record Date"] });
    });
    const seen = new Set();
    [...byPtt.docs, ...byDoc.docs].forEach((d) => {
      if (seen.has(d.id)) return;
      seen.add(d.id);
      const s = { id: d.id, ...d.data() };
      if (s.deleted === true) return;
      const pid = c.includes(String(s.patientPttId || "")) ? String(s.patientPttId) : String(s.patientId || "");
      add(pid, { cat: portalCategory(s), date: String(s.recordDate || ""), title: s.templateName || "Consent" });
    });
  }));
  const fixes = await categoryFixes(legacy.map((r) => r.docId));   // categories staff corrected
  legacy.forEach((r) => {
    const raw = String(r.raw || "");
    let date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
    if (!date) { const d = parseRecordDate(r.raw); date = d && !isNaN(d) ? isoKey(d) : ""; }
    add(r.pid, { cat: fixedCat(fixes, "consent", r.docId, r.title).category, date, title: r.title });
  });
  return out;
}

/* ---------- Records on the day ---------- */

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

// Forms filled in on the portal that day (recordDate is always YYYY-MM-DD)
async function portalFormsOn(dateKey) {
  const snap = await getDocs(query(collection(db, "form_submissions"), where("recordDate", "==", dateKey)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
 * Loads every record for one day and returns badgesFor(appointment) ->
 * [{ type, cat, code, catTitle, titles }] in display order.
 * badgesFor.consentFor(bookings) -> the treatments on a card with no valid consent.
 */
export async function fetchDayBadges(dateKey, appts) {
  const variants = dateVariants(dateKey);
  if (!variants.length) return Object.assign(() => [], { consentFor: () => [] });

  const apptIds = new Set(appts.map((a) => String(a.patientId || "").trim()).filter(Boolean));
  const checkConsent = dateKey >= toDateKey();   // today and later: past visits are already done

  // Consents: who needs one, then what's on file (a problem here only means no warnings)
  const consentJob = checkConsent ? (async () => {
    const rules = await consentRules();
    if (!rules.size) return { rules, consents: new Map() };
    const longest = Math.max(...rules.values());
    return { rules, consents: await consentsOf([...apptIds], monthsBefore(dateKey, longest)) };
  })().catch((err) => { console.warn("Calendar consent check failed:", err); return null; }) : Promise.resolve(null);

  const results = await Promise.allSettled([
    byExactDate("treatment_records", "Record Date", variants),
    byExactDate("consent_records", "Record Date", variants),
    byExactDate("prescription_record", "Record Date", variants),
    transcriptsOn(dateKey),
    portalFormsOn(dateKey),
  ]);
  const ok = (r, label) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`Calendar badges: ${label} failed`, r.reason);
    return [];
  };
  const [tx, consent, rx, transcripts, portal] = [
    ok(results[0], "treatment records"), ok(results[1], "consents"),
    ok(results[2], "prescriptions"), ok(results[3], "transcripts"), ok(results[4], "portal forms"),
  ];

  const records = [];
  const add = (type, id, name, title = "", cat = "", status = "") =>
    records.push({ type, id, name, title: String(title || ""), cat, status });

  // Old app
  tx.forEach((r) => {
    const title = r["Treatment Record Type"] || "Treatment record";
    add("tx", r["Patient ID"], r["Patient Name"], title, categorize(title));
  });
  consent.forEach((r) => {
    const title = r["Consent Type"] || "Consent";
    add("consent", r["Patient ID"], r["Patient Name"], title, categorize(title));
  });
  rx.forEach((r) => add("rx", r["Patient ID"], r["Patient Name"], r["Prescription Type"] || r["Prescription"] || "Prescription"));
  transcripts.forEach((r) => {
    if (r["Merged Into"] || r.mergedInto) return;   // a recording merged into another: its notes are the other one's
    const status = /^reviewed$/i.test(String(r.Status || "")) ? "reviewed" : "draft";
    add("summary", r["Patient ID"], r["Patient Name"], "Consultation notes", "", status);
    if (extractSection(r["Gemini SOAP"], "TREATMENT PLAN")) add("plan", r["Patient ID"], r["Patient Name"], "Treatment plan");
  });

  // Portal forms: the same category as the Records cards (a Type & category correction wins)
  portal.forEach((s) => {
    if (s.deleted === true) return;
    const c = String(s.category || "").toLowerCase();
    const id = s.patientPttId || s.patientId;
    if (c === "treatment") add("tx", id, s.patientName, s.templateName, portalCategory(s));
    else if (c === "consent") add("consent", id, s.patientName, s.templateName, portalCategory(s));
    else if (c === "rx" || c === "prescription" || /prescription/i.test(s.templateName || "")) {
      add("rx", id, s.patientName, s.templateName);
    }
  });
  records.forEach((r) => { r.id = String(r.id || "").trim(); r.name = norm(r.name); });

  // Record IDs that aren't schedule IDs (e.g. Firestore doc IDs) -> look up their clinic ID + name
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

  const cons = await consentJob;

  function badgesFor(appt) {
    const pid = String(appt.patientId || "").trim();
    const pname = norm(appt.patientName);
    const found = new Map();   // "tx|wr" -> badge

    const take = (r) => {
      const cat = r.type === "tx" || r.type === "consent" ? (r.cat || "other") : "";
      const key = `${r.type}|${cat}`;
      if (!found.has(key)) {
        found.set(key, { type: r.type, cat, code: CAT_CODES[cat] || "", catTitle: cat ? CAT_TITLE.get(cat) || "" : "",
          titles: [], status: "", drafts: 0, reviewed: 0 });
      }
      const b = found.get(key);
      if (r.title && !b.titles.includes(r.title)) b.titles.push(r.title);
      // Summaries: Draft if any of the day's notes still needs reviewing
      if (r.type === "summary") {
        if (r.status === "reviewed") b.reviewed++; else b.drafts++;
        b.status = b.drafts ? "draft" : "reviewed";
      }
    };

    records.forEach((r) => {
      const a = alias.get(r.id);
      // Which appointment ID (if any) this record clearly belongs to
      const resolved = apptIds.has(r.id) ? r.id : (a && apptIds.has(a.pttId) ? a.pttId : "");
      if (resolved) {
        if (resolved === pid) take(r);
        return; // ID-matched records never fall back to name
      }
      const rName = r.name || (a && a.name) || "";
      if (rName && rName === pname) take(r);
    });

    return [...found.values()].sort((x, y) =>
      ORDER.indexOf(x.type) - ORDER.indexOf(y.type)
      || (CAT_RANK.get(x.cat) ?? 99) - (CAT_RANK.get(y.cat) ?? 99));
  }

  // A card's bookings (one, or a whole visit) → [{ cat, code, catTitle, months, services, last, beforeVisit }]
  badgesFor.consentFor = (rows) => {
    if (!cons || !cons.rules.size) return [];
    const live = (rows || []).filter((a) => a && !CANCELLED.test(String(a.status || "")));
    const pid = live.length ? String(live[0].patientId || "").trim() : "";
    if (!pid) return [];   // no Patient ID: can't be checked, so no warning
    const need = new Map();   // group → the services that need it
    live.forEach((a) => (a.services || []).forEach((s) => {
      s = String(s || "").trim();
      if (!s || NO_CONSENT_SVC.test(s)) return;
      const c = categorize(s);
      if (!cons.rules.has(c)) return;
      if (!need.has(c)) need.set(c, []);
      if (!need.get(c).includes(s)) need.get(c).push(s);
    }));
    const mine = (cons.consents.get(pid) || []).slice().sort((a, b) => b.date.localeCompare(a.date));
    const today = toDateKey();
    const out = [];
    need.forEach((services, cat) => {
      const months = cons.rules.get(cat);
      const list = mine.filter((c) => c.cat === cat && c.date && c.date <= dateKey);
      if (list.some((c) => c.date >= monthsBefore(dateKey, months))) return;   // valid on the visit day
      const last = list[0] || null;
      out.push({
        type: "nocons", cat, code: CAT_CODES[cat] || "", catTitle: CAT_TITLE.get(cat) || "", months, services, last,
        beforeVisit: !!last && dateKey > today && last.date >= monthsBefore(today, months),   // valid now, not by then
      });
    });
    return out.sort((x, y) => (CAT_RANK.get(x.cat) ?? 99) - (CAT_RANK.get(y.cat) ?? 99));
  };

  return badgesFor;
}