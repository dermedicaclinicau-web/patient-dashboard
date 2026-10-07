import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, FieldPath }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COLLECTION = "appointment_transcripts";

// Spellings to try for the name match ("Ashley Hanna #1", "Ashley Hanna", "Jan BRAY"...)
function nameVariants(patient) {
  const clean = (s) => String(s || "").replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  const title = (s) => s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());

  const full = clean(patient.name);
  const first = clean(patient.firstName);
  const last = clean(patient.lastName);

  const v = new Set([String(patient.name || "").trim(), full, title(full)]);
  if (first && last) {
    v.add(`${first} ${last}`);
    v.add(`${title(first)} ${title(last)}`);
    v.add(`${title(first)} ${last.toUpperCase()}`);
  }
  return [...v].filter(Boolean).slice(0, 30); // Firestore "in" allows up to 30 values
}

// Text after "!!TREATMENT PLAN:" up to the next "!!HEADING" (or the end)
export function extractSection(soap, heading) {
  const text = String(soap || "");
  const re = new RegExp(`!!\\s*${heading.replace(/\s+/g, "\\s+")}\\s*:?`, "i");
  const m = re.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/!!\s*[A-Z][A-Z &/()-]{2,}:?/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

// "January 16, 2026" / "January 16, 2026 10:30 AM" / "16/01/2026"
function parseRecordDate(s) {
  const str = String(s || "").trim();
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str); // Australian day/month/year
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const t = Date.parse(str.replace(/\s+at\s+/i, " "));
  return isNaN(t) ? null : new Date(t);
}

// All of a patient's transcript records (matched by ID, then name), newest first.
// Fetched ONCE per patient page and shared by Treatment plan + Social history.
export async function fetchTranscriptRecords(patient) {
  const ids = [...new Set([patient.pttId, patient.id].filter(Boolean))];
  const names = nameVariants(patient);
  const col = collection(db, COLLECTION);

  const [idSnap, nameSnap] = await Promise.all([
    ids.length ? getDocs(query(col, where(new FieldPath("Patient ID"), "in", ids))) : null,
    names.length ? getDocs(query(col, where(new FieldPath("Patient Name"), "in", names))) : null,
  ]);

  const docs = new Map();
  if (idSnap) idSnap.forEach((d) => docs.set(d.id, { d, byId: true }));
  if (nameSnap) nameSnap.forEach((d) => { if (!docs.has(d.id)) docs.set(d.id, { d, byId: false }); });

  const records = [];
  for (const { d, byId } of docs.values()) {
    const data = d.data();

    // Name matched but the record has a DIFFERENT patient ID, so it belongs to someone else
    const pid = String(data["Patient ID"] || "").trim();
    if (!byId && pid && !ids.includes(pid)) continue;

    records.push({
      id: d.id,
      soap: String(data["Gemini SOAP"] || ""),
      date: parseRecordDate(data["Record Date and Time"]),
      dateText: String(data["Record Date and Time"] || ""),
      staff: String(data["Staff Name"] || ""),
      recordId: String(data["Record ID"] || ""),
      matchedByName: !byId,
    });
  }

  records.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
  return records;
}

// Most recent record that has a "!!TREATMENT PLAN" section
export function latestTreatmentPlan(records) {
  for (const r of records) {
    const plan = extractSection(r.soap, "TREATMENT PLAN");
    if (plan) return { ...r, plan };
  }
  return null;
}

// Every record with a "!!SOCIAL HISTORY" section, newest first
export function socialHistoryEntries(records) {
  return records
    .map((r) => ({ ...r, text: extractSection(r.soap, "SOCIAL HISTORY") }))
    .filter((r) => r.text);
}

// Splits notes into bullet points:
//  - one item per line
//  - inline items like "…today. - Smoker: no. - Alcohol: socially"
// Ordinary hyphens ("Filler - Lips") are NOT split.
export function toBullets(text) {
  return String(text || "")
    .split(/\n|(?<=[.!?:;])\s+[-•*]\s+/)
    .map((s) => s.replace(/^\s*[-•*]\s+/, "").trim())
    .filter(Boolean);
}

// Every record with a "!!TREATMENT PLAN", newest first, with the plan parsed into concerns
export function allTreatmentPlans(records) {
  return records
    .map((r) => ({ ...r, plan: extractSection(r.soap, "TREATMENT PLAN") }))
    .filter((r) => r.plan)
    .map((r) => ({ ...r, parsed: parsePlan(r.plan) }));
}

const CONCERN_RE = /^CONCERN\s+([A-Z0-9]{1,3})\s*[:.)\-–—]\s*(.*)$/i;
const LABEL_RE = /^(AREAS?|TREATMENTS?|FREQUENCY\s*\/\s*INTERVAL|FREQUENCY|INTERVAL|QUOTE|COSTS?|PRICING|COMMENTS?|NOTES?|SUGGESTED\s+TIMELINE|TIMELINE)\s*:\s*(.*)$/i;

function labelKey(label) {
  const l = label.toUpperCase().replace(/\s+/g, " ");
  if (l.startsWith("AREA")) return "area";
  if (l.startsWith("TREATMENT")) return "treatment";
  if (l.startsWith("FREQUENCY") || l === "INTERVAL") return "frequency";
  if (l === "QUOTE" || l.startsWith("COST") || l === "PRICING") return "quote";
  if (l.includes("TIMELINE")) return "timeline";
  return "comments";
}

// "Redness / Sensitive Skin — Facial redness and flushing" -> title + description
function newConcern(letter, heading) {
  const m = /^(.*?)\s+[—–-]\s+(.*)$/.exec(heading || "");
  return {
    letter,
    title: (m ? m[1] : heading || "").trim(),
    description: m ? [m[2].trim()] : [],
    area: [], treatment: [], frequency: [], quote: [], comments: [],
  };
}

// Turns the plan text into { intro: [], concerns: [...], timeline: [] }
export function parsePlan(text) {
  const plan = { intro: [], concerns: [], timeline: [] };
  let current = null;
  let field = null;

  String(text || "").split(/\r?\n/).forEach((raw) => {
    const line = raw.trim().replace(/^[-•*]\s+/, "");
    if (!line) return;
    let m;

    if ((m = CONCERN_RE.exec(line))) {
      current = newConcern(m[1].toUpperCase(), m[2]);
      plan.concerns.push(current);
      field = null;
      return;
    }

    if ((m = LABEL_RE.exec(line))) {
      const key = labelKey(m[1]);
      if (key === "timeline") {
        field = "timeline";
        if (m[2]) plan.timeline.push(m[2].trim());
        return;
      }
      if (!current) { // a field with no "CONCERN X:" heading before it
        current = newConcern("", "");
        plan.concerns.push(current);
      }
      field = key;
      if (m[2]) current[field].push(m[2].trim());
      return;
    }

    // Continuation lines belong to whatever came before
    if (field === "timeline") plan.timeline.push(line);
    else if (current) current[field || "description"].push(line);
    else plan.intro.push(line);
  });

  return plan;
}

/* ===================== Suggested timeline parsing ===================== */

const MONTH_NAMES = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// "August 2026", "Aug 2026:", "August 2026 - Wrinkle Relaxer"
const MONTH_HEAD_RE = new RegExp(`^((?:${MONTH_NAMES})\\.?\\s+\\d{4})\\s*(?:[:\\-–—]\\s*(.*))?$`, "i");
// "Week 2", "Month 3", "Visit 1: Genesis Glow", "Weeks 2-4"
const PERIOD_HEAD_RE = /^((?:weeks?|months?|days?|visit|session)\s*\d+(?:\s*[-–]\s*\d+)?)\s*(?::\s*(.*))?$/i;
const INSTR_RE = /^special\s+instructions?\b/i;

// "Collagen Activator (1 of 3)" -> { name: "Collagen Activator", detail: "1 of 3" }
function addTimelineItem(visit, text) {
  const m = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(text);
  const detail = m ? m[2].trim() : "";
  visit.items.push({
    name: (m ? m[1] : text).trim(),
    detail: detail ? detail[0].toUpperCase() + detail.slice(1) : "",
  });
}

// Turns timeline lines into visits + de-duplicated special instructions
export function parseTimeline(lines) {
  const visits = [];
  const notes = []; // { label, text, visits: [visit numbers] }
  let current = null;

  const ensureVisit = () => {
    if (!current) {
      current = { label: "", items: [], notes: [] };
      visits.push(current);
    }
    return current;
  };

  (lines || []).forEach((raw) => {
    const line = String(raw).trim();
    if (!line) return;

    const head = MONTH_HEAD_RE.exec(line) || PERIOD_HEAD_RE.exec(line);
    if (head) {
      current = { label: head[1].trim(), items: [], notes: [] };
      visits.push(current);
      if (head[2]) addTimelineItem(current, head[2].trim());
      return;
    }

    if (INSTR_RE.test(line)) {
      const visit = ensureVisit();
      const idx = line.indexOf(":");
      const label = idx > -1 ? line.slice(0, idx).trim() : "Special instructions";
      const text = idx > -1 ? line.slice(idx + 1).trim() : line;

      let note = notes.find((n) => n.label.toLowerCase() === label.toLowerCase() && n.text === text);
      if (!note) {
        note = { label, text, visits: [] };
        notes.push(note);
      }
      const visitNo = visits.indexOf(visit) + 1;
      if (!note.visits.includes(visitNo)) note.visits.push(visitNo);
      if (!visit.notes.includes(note)) visit.notes.push(note);
      return;
    }

    addTimelineItem(ensureVisit(), line);
  });

  return { visits, notes };
}