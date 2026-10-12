// The master treatment plan: one per patient, built from consultations and tracked over time.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, getDocs, collection, query, orderBy, limit, runTransaction, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CATEGORIES, canonicalCategory, PATTERNS } from "./plan-editor.js";

export const PLAN_STATUS = {
  proposed: "Proposed", sent: "Sent to patient", accepted: "Accepted",
  in_progress: "In progress", completed: "Completed", closed: "Closed",
};
export const CONCERN_STATUS = { active: "Active", maintenance: "Maintenance", resolved: "Resolved", not_pursuing: "Not pursuing" };

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const whole = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 520) : 0; };
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const MONTH_RE = /^\d{4}-\d{2}$/;
export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
// "Skin Needling (Session 1 of 3)" and "skin needling" compare as the same treatment
export const normTx = (s) => String(s || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/* ---------- Months ---------- */

const MONTH_IX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "March 2027", "Mar 2027" or "2027-03" → "2027-03" ("" if it isn't a month)
export function monthKey(s) {
  const t = String(s || "").trim();
  let m = /^(\d{4})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(t);
  const mo = m && MONTH_IX[m[1].toLowerCase()];
  return mo ? `${m[2]}-${String(mo).padStart(2, "0")}` : "";
}
export function monthLabel(k) {
  const m = /^(\d{4})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "numeric" }) : "";
}

// "Course of 3, every 4 weeks" · "Every 3 months" · "Once"
export function patternText(l) {
  const wk = (w) => (!w ? "" : w % 52 === 0 ? (w === 52 ? "year" : `${w / 52} years`)
    : w >= 9 ? `${Math.round(w / 4.345)} months` : w === 1 ? "week" : `${w} weeks`);
  if (l.pattern === "course") return [l.sessions ? `Course of ${l.sessions}` : "Course", l.intervalWeeks ? `every ${wk(l.intervalWeeks)}` : ""].filter(Boolean).join(", ");
  if (l.pattern === "maintenance") return l.intervalWeeks ? `Every ${wk(l.intervalWeeks)}` : "Ongoing";
  if (l.pattern === "once") return "Once";
  return l.frequency || "";
}

/* ---------- Clean shapes ---------- */

export function cleanLine(l = {}) {
  return {
    id: clip(l.id, 24) || newId(),
    treatment: clip(l.treatment, 300),
    frequency: clip(l.frequency, 200),
    pattern: PATTERNS.includes(l.pattern) ? l.pattern : "unknown",
    sessions: whole(l.sessions),
    intervalWeeks: whole(l.intervalWeeks),
    startMonth: MONTH_RE.test(l.startMonth || "") ? l.startMonth : "",
    countFrom: /^\d{4}-\d{2}-\d{2}$/.test(l.countFrom || "") ? l.countFrom : "",
    services: [...new Set((Array.isArray(l.services) ? l.services : []).map((s) => clip(s, 150)).filter(Boolean))].slice(0, 20),
    overrides: l.overrides && typeof l.overrides === "object" && !Array.isArray(l.overrides) ? l.overrides : {},
  };
}
export function cleanConcern(c = {}) {
  return {
    key: canonicalCategory(c.key),
    status: CONCERN_STATUS[c.status] ? c.status : "active",
    description: clip(c.description, 600),
    area: clip(c.area, 200),
    quote: clip(c.quote, 1500),
    comments: clip(c.comments, 1500),
    lines: (Array.isArray(c.lines) ? c.lines : []).map(cleanLine).filter((l) => l.treatment).slice(0, 10),
    sourceRecordId: clip(c.sourceRecordId, 80),
  };
}
export function cleanEvent(e = {}) {
  return {
    id: clip(e.id, 24) || newId(),
    name: clip(e.name, 100),
    month: monthKey(e.month),
    avoidDowntime: e.avoidDowntime === true,
    source: e.source === "consult" ? "consult" : "staff",
  };
}

function normalisePlan(id, x = {}) {
  return {
    patientId: id,
    patientPttId: String(x.patientPttId || ""),
    patientName: String(x.patientName || ""),
    status: PLAN_STATUS[x.status] ? x.status : "proposed",
    concerns: (Array.isArray(x.concerns) ? x.concerns : []).map(cleanConcern).filter((c) => c.key)
      .sort((a, b) => CATEGORIES.indexOf(a.key) - CATEGORIES.indexOf(b.key)),
    events: (Array.isArray(x.events) ? x.events : []).map(cleanEvent).filter((e) => e.name),
    sources: Array.isArray(x.sources) ? x.sources.map(String) : [],
    version: Number(x.version) || 0,
    createdBy: String(x.createdBy || ""), createdAt: toDate(x.createdAt),
    updatedBy: String(x.updatedBy || ""), updatedAt: toDate(x.updatedAt),
  };
}

/* ---------- Reading ---------- */

export async function getMasterPlan(patientId) {
  if (!patientId) return null;
  const s = await getDoc(doc(db, "treatment_plans", patientId));
  return s.exists() ? normalisePlan(s.id, s.data()) : null;
}

export async function listPlanHistory(patientId, max = 30) {
  const snap = await getDocs(query(collection(db, "treatment_plans", patientId, "history"), orderBy("version", "desc"), limit(max)));
  return snap.docs.map((d) => { const x = d.data() || {}; return { id: d.id, ...x, at: toDate(x.at) }; });
}

/* ---------- Linking plan lines to appointment services (plan_settings/services) ---------- */

const STOP = new Set(["and", "the", "for", "with", "per", "session", "sessions", "treatment", "treatments", "area", "areas",
  "full", "face", "left", "right", "add", "standard", "series", "course", "one", "two", "three"]);
const words = (s) => normTx(String(s || "").replace(/\bWR\b/g, "wrinkle relaxer")).split(" ").filter((w) => w.length > 2 && !STOP.has(w));

// Services set up for this concern whose name shares a real word with the treatment
export function matchServices(treatment, concern, services) {
  const tw = words(treatment);
  if (!tw.length || !concern) return [];
  return (services || [])
    .filter((r) => (r.concerns || []).includes(concern))
    .filter((r) => { const sw = words(r.service); return tw.some((w) => sw.includes(w)); })
    .map((r) => r.service).slice(0, 20);
}

// Do a treatment and a service name share a real word? ("Skin Needling full face" ~ "Skin Needling Face")
export function sharesWord(a, b) {
  const x = words(a);
  const y = words(b);
  return x.some((w) => y.includes(w));
}

/* ---------- What a consultation would change ---------- */

function linesFrom(c, startMonth, key, services, countFrom) {
  const texts = String(c.treatment || "").split(/\n+/).map((s) => s.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
  const freqs = String(c.frequency_interval || "").split(/\n+/).map((s) => s.trim());
  return (texts.length ? texts : [c.description || "Treatment"]).map((t, i) => cleanLine({
    treatment: t,
    frequency: freqs[i] && freqs[i] !== "—" ? freqs[i] : "",
    pattern: i === 0 ? c.pattern : "unknown",       // the recorder's schedule fields describe the first treatment line
    sessions: i === 0 ? c.sessions : 0,
    intervalWeeks: i === 0 ? c.interval_weeks : 0,
    startMonth,
    countFrom,
    services: matchServices(t, key, services),
  }));
}
// consult = the editable plan model (planFromSidecar / planFromText)
// → { items: [{ kind: new | changed | same | uncategorised, key, before, after }], events: [new events] }
export function planChanges(master, consult, { recordId = "", services = [], fromKey = "" } = {}) {
  const cur = master ? master.concerns : [];
  const tl = consult.timeline || [];
  const sig = (x) => [x.lines.map((l) => `${normTx(l.treatment)}/${l.pattern}/${l.sessions}/${l.intervalWeeks}`).join("|"), normTx(x.quote)].join("#");
  const items = (consult.concerns || []).map((c) => {
    const key = canonicalCategory(c.concern_category);
    const start = tl.filter((t) => t.concern && t.concern === c.key).map((t) => monthKey(t.date)).filter(Boolean).sort()[0] || "";
    const after = cleanConcern({
      key: key || CATEGORIES[0], description: c.description, area: c.area, quote: c.quote, comments: c.comments,
      lines: linesFrom(c, start, key, services, fromKey), sourceRecordId: recordId,
    });
    if (!key) return { kind: "uncategorised", key: "", before: null, after: { ...after, key: "" } };
    const before = cur.find((x) => x.key === key) || null;
    if (!before) return { kind: "new", key, before, after };
    return { kind: sig(before) === sig(after) ? "same" : "changed", key, before, after };
  });
  const have = new Set((master ? master.events : []).map((e) => `${normTx(e.name)}|${e.month}`));
  const events = (consult.patient_events || [])
    .map((e) => cleanEvent({ name: e.name, month: e.month, avoidDowntime: e.avoid_downtime === true, source: "consult" }))
    .filter((e) => e.name && e.month && !have.has(`${normTx(e.name)}|${e.month}`));
  return { items, events };
}

// The plan after applying the ticked items and events
export function applyChanges(master, picks, events) {
  const concerns = (master ? master.concerns : []).map((c) => ({ ...c, lines: c.lines.map((l) => ({ ...l })) }));
  picks.forEach(({ key, after }) => {
    const i = concerns.findIndex((c) => c.key === key);
    if (i === -1) { concerns.push({ ...after, key }); return; }
    const old = concerns[i];
    const lines = after.lines.map((l) => {
      const prev = old.lines.find((o) => normTx(o.treatment) === normTx(l.treatment));
      return prev ? { ...l, id: prev.id, overrides: prev.overrides, countFrom: prev.countFrom || l.countFrom,
        services: l.services.length ? l.services : prev.services, startMonth: l.startMonth || prev.startMonth } : l;
    });
    // A line that has been tracked (done, moved…) is kept even if the new consultation doesn't mention it
    old.lines.forEach((o) => {
      if (Object.keys(o.overrides || {}).length && !lines.some((l) => l.id === o.id)) lines.push(o);
    });
    concerns[i] = { ...old, ...after, key, lines,
      status: ["resolved", "not_pursuing"].includes(old.status) ? "active" : old.status };
  });
  concerns.sort((a, b) => CATEGORIES.indexOf(a.key) - CATEGORIES.indexOf(b.key));
  return { status: master ? master.status : "proposed", concerns, events: [...(master ? master.events : []), ...events] };
}

/* ---------- Saving (one numbered version at a time, with history) ---------- */

// meta = { action, summary, recordId, expectedVersion } (expectedVersion 0 = creating it)
export async function saveMasterPlan(patient, next, meta, staff) {
  const me = auth.currentUser && auth.currentUser.uid;
  if (!me) throw new Error("Your session has ended. Log in again.");
  const by = clip(staff && staff.name, 120);
  const ref = doc(db, "treatment_plans", patient.id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists() ? snap.data() : null;
    const curV = cur ? Number(cur.version) || 0 : 0;
    if (meta.expectedVersion !== undefined && meta.expectedVersion !== curV) {
      throw new Error("Someone else has just changed this plan. Close this and open it again to see their changes.");
    }
    const v = curV + 1;
    tx.set(ref, {
      patientId: patient.id,
      patientPttId: clip(patient.pttId, 80),
      patientName: clip(patient.name, 150),
      status: PLAN_STATUS[next.status] ? next.status : "proposed",
      concerns: (next.concerns || []).map(cleanConcern).filter((c) => c.key),
      events: (next.events || []).map(cleanEvent).filter((e) => e.name),
      sources: [...new Set([...((cur && cur.sources) || []), meta.recordId].filter(Boolean))].slice(-100),
      version: v,
      createdAt: (cur && cur.createdAt) || serverTimestamp(),
      createdBy: cur ? cur.createdBy || "" : by,
      createdByUid: cur ? cur.createdByUid || "" : me,
      updatedAt: serverTimestamp(), updatedBy: by, updatedByUid: me,
    });
    tx.set(doc(db, "treatment_plans", patient.id, "history", String(v)), {
      version: v, action: clip(meta.action, 120), summary: clip(meta.summary, 500), recordId: clip(meta.recordId, 80),
      before: cur ? JSON.stringify({ status: cur.status, concerns: cur.concerns, events: cur.events }).slice(0, 300000) : "",
      at: serverTimestamp(), by, byUid: me,
    });
    return v;
  });
}