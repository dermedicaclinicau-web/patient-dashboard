// Treatment plan tracking: the patient's appointments → each plan line's sessions (done, booked, due…)
import { serviceKey } from "./inventory-api.js";
import { serviceSetup } from "./plan-api.js";
import { sharesWord, monthKey } from "./master-plan-api.js";

const pad = (n) => String(n).padStart(2, "0");
export const dateKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthOfDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const thisMonth = () => monthOfDate(new Date());

// "2026-09-14" or "2026-09" + 4 weeks → "2026-10" ("" without an interval)
export function addWeeks(key, w) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(key || "");
  if (!m || !w) return "";
  const d = new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 15);
  d.setDate(d.getDate() + w * 7);
  return monthOfDate(d);
}

// "2026-11" + 2 → "2027-01"
export function addMonths(key, n) {
  const m = /^(\d{4})-(\d{2})/.exec(key || "");
  return m ? monthOfDate(new Date(+m[1], +m[2] - 1 + n, 1)) : "";
}

// Months from a to b ("2026-11" → "2027-01" = 2)
export function monthDiff(a, b) {
  const x = /^(\d{4})-(\d{2})/.exec(a || "");
  const y = /^(\d{4})-(\d{2})/.exec(b || "");
  return x && y ? (+y[1] - +x[1]) * 12 + (+y[2] - +x[2]) : 0;
}

export function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
}

/* ---------- Appointments from the pre-consultation data ---------- */

// Every pcn_results column that lists past visits ("2/9/2026 - Service (Clinician), …"). Duplicates are merged.
const PAST_FIELDS = ["other", "wrinkleRelaxer", "fillerRadiesse", "restoraGlow", "laserOplPeel", "firmUlthera",
  "otherInjectables", "bodySculpting", "hydraRepair", "collagenActivator"];
const FUTURE_FIELDS = ["futureVisits"];
const LINE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(.+)$/;

// "Peel (Clinician), [StimPeel] Add on Peel 2 areas (Dr Teh)" → the raw service names
function serviceNames(text) {
  const parts = text.split(/\)\s*,\s*/);
  return parts.map((raw, i) => (i < parts.length - 1 ? `${raw})` : raw).trim())
    .map((t) => t.replace(/\s+\([^()]*\)$/, "").replace(/^\*+/, "").trim())
    .filter(Boolean);
}

// → [{ dateKey, services: [raw names], future }] oldest first. today = today's appointments ({ services })
export function visitsFrom(pre, today = []) {
  const todayKey = dateKeyOf(new Date());
  const days = new Map();
  const add = (key, names, future) => {
    const v = days.get(key) || { dateKey: key, services: [], future: false };
    v.future = v.future || future;
    names.forEach((n) => { if (!v.services.some((s) => serviceKey(s) === serviceKey(n))) v.services.push(n); });
    days.set(key, v);
  };
  // Anything dated today or later is booked; anything earlier has happened (even if it came from the future-visits list)
  const read = (fields) => fields.forEach((f) => String((pre && pre[f]) || "").split(/\r?\n/).forEach((line) => {
    const m = LINE_RE.exec(line.trim());
    if (!m) return;
    const key = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    add(key, serviceNames(m[4]), key >= todayKey);
  }));
  read(PAST_FIELDS);
  read(FUTURE_FIELDS);
  
  const todays = (today || []).flatMap((a) => a.services || []);
  if (todays.length) add(todayKey, todays, true);
  return [...days.values()].filter((v) => v.services.length).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/* ---------- One line's sessions ---------- */

// past/future: sorted date keys of visits that count for this line.
// overrides[n]: { status: "done" | "skipped", date, month (moved), asked: { at, by } }
function trackLine(line, past, future, waiting = false) {
  const ov = line.overrides || {};
  const iv = line.intervalWeeks || 0;
  const total = line.pattern === "course" ? Math.max(1, line.sessions || 1) : line.pattern === "once" ? 1 : 0; // 0 = ongoing
  const P = past.slice();
  const F = future.slice();
  const cur = thisMonth();
  const slots = [];
  let prev = null;
  for (let n = 1; n <= 60 && (!total || n <= total); n++) {
    const o = ov[String(n)] || {};
    // No start month set? Use a month written in the frequency ("Next treatment planned for June 2027")
    const start = line.startMonth || monthKey(line.frequency);
    const expected = o.month || (n === 1 ? start : prev ? addWeeks(prev.date || prev.month, iv) : "") || "";
    let s;
    if (o.status === "done") s = { state: "done", date: o.date || "", manual: true };
    else if (o.status === "skipped") s = { state: "skipped" };
    else if (P.length) s = { state: "done", date: P.shift() };
    else if (F.length) s = { state: "booked", date: F.shift() };
    else if (!total && line.pattern === "unknown" && !iv && slots.some((x) => x.state === "done")) break; // no schedule to follow
    else s = { state: !expected ? "unscheduled" : expected < cur ? "overdue" : expected === cur ? "due" : "planned" };
    // A concern in a waiting priority: nothing is due until it's moved up
    if (waiting && !["done", "booked", "skipped"].includes(s.state)) s = { state: "waiting" };
    s.n = n;
    s.month = s.date ? s.date.slice(0, 7) : s.state === "waiting" ? "" : expected;
    s.moved = !!o.month && !s.date;
    s.asked = o.asked || null;
    slots.push(s);
    prev = s;
    if (!total && !["done", "booked", "skipped"].includes(s.state)) break; // ongoing: the history, then the next one
  }
  const done = slots.filter((s) => s.state === "done").length;
  const next = slots.find((s) => !["done", "skipped"].includes(s.state)) || null;
  return { slots, total, done, next, complete: !!total && !next, extra: total ? P.length : 0 };
}

/* ---------- The whole plan ---------- */

// fromOf(concern, line) → date key from which visits count for that line ("" = all)
// → Map(concernKey → { lines: Map(lineId → track), unmatched })
export function trackPlan(master, { visits, services, fromOf, waiting = () => false }) {
  const out = new Map();
  master.concerns.forEach((c) => {
    const hits = new Map(c.lines.map((l) => [l.id, { past: new Set(), future: new Set() }]));
    let unmatched = 0;
    visits.forEach((v) => {
      const ids = new Set();
      let miss = false;
      v.services.forEach((s) => {
        const k = serviceKey(s);
        // 1) A service linked to a line counts for it  2) else a service set up for this concern, matched by name
        let line = c.lines.find((l) => l.services.some((x) => serviceKey(x) === k));
        if (!line) {
          const set = serviceSetup(services, s);
          if (!set || set.notTreatment || !set.concerns.includes(c.key)) return;
          line = c.lines.find((l) => sharesWord(l.treatment, s)) || (c.lines.length === 1 ? c.lines[0] : null);
          if (!line) { miss = true; return; }
        }
        ids.add(line.id);
      });
      ids.forEach((id) => {
        const l = c.lines.find((x) => x.id === id);
        if (v.dateKey >= (fromOf(c, l) || "")) hits.get(id)[v.future ? "future" : "past"].add(v.dateKey);
      });
      if (miss && !ids.size && v.dateKey >= (fromOf(c, null) || "")) unmatched++;
    });
    out.set(c.key, {
      unmatched,
      lines: new Map(c.lines.map((l) => [l.id,
        trackLine(l, [...hits.get(l.id).past].sort(), [...hits.get(l.id).future].sort())])),
    });
  });
  return out;
}