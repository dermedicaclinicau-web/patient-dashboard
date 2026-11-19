// Wrinkle Relaxer treatment record: was an area treated (not touched up) in the 6 weeks before this record?
// Looks at portal records and the old app's records (wr_treatment_record, read the same way as Copy and create new).
import { listSubmissionsForPatient } from "./form-submissions.js";
import { getFormVersion } from "./form-templates.js";
import { fetchPatientRecords } from "./records.js";
import { patientIds } from "./patients.js";
import { iqHasOptions } from "./form-fields.js";
import { oldWrPoints, readOldWr, wrPictureFor } from "./wr-copy.js";

export const WR_RECHECK_DAYS = 42;   // 6 weeks
const WR_RE = /wrinkle|relaxer|anti[\s-]?wrinkle|toxin|botox|xeomin|dysport|letybo/i;
const key = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");   // "Touch-up" = "touchup"
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayNo = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(k || ""));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null;
};

// The face-chart pictures staff place unit marks on
export const wrPics = (fields) => (fields || []).filter((f) => f && f.type === "image" && f.source !== "staff"
  && f.annotate && f.markMode === "marks");

// The area's "Treatment or touch-up?" question (a choice with both), or null
export const tagQuestion = (f) => (f && f.questions || []).find((q) => iqHasOptions(q)
  && (q.options || []).some((o) => key(o) === "treatment") && (q.options || []).some((o) => key(o) === "touchup")) || null;

// Was a saved area a Treatment? Its answer first, then the tags on its marks.
// Marks with no Treatment / Touch-up at all count as a treatment.
function savedTreated(f, v) {
  if (!v || typeof v !== "object") return false;
  const q = tagQuestion(f);
  const qs = Array.isArray(v.questions) ? v.questions : [];
  const qa = q ? qs.find((x) => x.id === q.id) : qs.find((x) => ["treatment", "touchup"].includes(key(x.value)));
  if (qa && qa.value) return key(qa.value) === "treatment";
  const marks = Array.isArray(v.marks) ? v.marks : [];
  if (marks.some((m) => m.tag)) return marks.some((m) => key(m.tag) === "treatment");
  return marks.length > 0;
}

// fieldId (this form's pictures) -> [{ day, date, by, form }] of earlier treatments, newest first
export async function loadRecentWr(patient, fields, { templateId = "", excludeId = "" } = {}) {
  const pics = wrPics(fields);
  const out = new Map();
  if (!pics.length) return out;
  const add = (f, e) => { if (f && e.day !== null) { if (!out.has(f.id)) out.set(f.id, []); out.get(f.id).push(e); } };
  const since = dayNo(isoOf(new Date())) - 120;   // older records can't be within 6 weeks of today's or a recent record

  const [subs, recs] = await Promise.all([
    listSubmissionsForPatient([patient.id, ...patientIds(patient)]).catch(() => []),
    fetchPatientRecords(patient).catch(() => null),
  ]);

  // Portal records: each picture matched by the same question (same form), or by its name
  const vers = new Map();
  const wrSubs = subs.filter((s) => s.category === "treatment" && s.id !== excludeId
    && (s.group === "wr" || WR_RE.test(s.templateName)) && dayNo(s.recordDate) >= since);
  await Promise.all(wrSubs.map(async (s) => {
    const k = `${s.templateId}|${s.version}`;
    if (!vers.has(k)) vers.set(k, getFormVersion(s.templateId, s.version).catch(() => null));
    const ver = await vers.get(k);
    wrPics(ver ? ver.fields : []).forEach((of) => {
      if (!savedTreated(of, s.answers[of.id])) return;
      const f = (s.templateId === templateId && pics.find((x) => x.id === of.id)) || wrPictureFor(of.label || of.fileName, pics);
      add(f, { day: dayNo(s.recordDate), date: s.recordDate, by: s.createdBy || "", form: s.templateName });
    });
  }));

  // The old app's records: each area matched by name (and the other names in wr-copy.js)
  const legacy = recs ? recs.treatments.filter((t) => !t.portalId && t.category === "wr" && t.recordId
    && t.date && dayNo(isoOf(t.date)) >= since) : [];
  await Promise.all(legacy.map(async (t) => {
    const d = await readOldWr(t.recordId).catch(() => null);
    if (!d) return;
    const date = isoOf(t.date);
    const done = new Set();
    oldWrPoints(d).forEach((p) => {
      if (p.type && key(p.type) !== "treatment") return;
      const f = wrPictureFor(p.area, pics);
      if (!f || done.has(f.id)) return;
      done.add(f.id);
      add(f, { day: dayNo(date), date, by: t.staff || "", form: `${t.title} (old app)` });
    });
  }));

  out.forEach((list) => list.sort((a, b) => b.day - a.day));
  return out;
}

// The latest treatment of the area in the 6 weeks up to the record date (same day included), or null
export function recentTreatment(list, recordDate) {
  const d = dayNo(recordDate);
  if (d === null) return null;
  const hit = (list || []).find((e) => d - e.day >= 0 && d - e.day < WR_RECHECK_DAYS);
  return hit ? { ...hit, days: d - hit.day } : null;
}

// "earlier the same day", "5 days ago", "3 weeks ago"
export function wrAgo(days) {
  if (days <= 0) return "earlier the same day";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const w = Math.floor(days / 7);
  return `${w} weeks ago`;
}