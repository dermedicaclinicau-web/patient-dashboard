// Reporting → Kit reconciliation. The old app and the portal as one record, one row per injector per day.
// Three views: Days (with a summary per injector and checks on each day), Batch lookup (every patient treated with
// a batch, all dates) and Dosing (average units per injector and area). For each day one source is used: the portal
// if it has records that day, otherwise the old app, so a treatment saved in both is never counted twice.
import {
  listProducts, listKits, listKitMoves, listAllLoans, listUsageByStaff, listKitDaysFor, dayKey, plural,
} from "./inventory-api.js";
import { callApi } from "./appointments.js";
import { loadChecks, checkOf, checkToolsHtml, bindKitChecks } from "./kit-recon-checks.js";
import { showToast } from "./utils.js";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const fmt = (n) => String(r1(n));
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const niceDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : k; };
const shortDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit" }) : k; };
const timeOf = (ms) => new Date(ms).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const msOf = (d) => (d instanceof Date && !isNaN(d) ? d.getTime() : null);
const keyOf = (d) => (d instanceof Date && !isNaN(d) ? dayKey(d) : "");
const normB = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const expMY = (s) => { const m = /^(\d{4})-(\d{2})/.exec(s || ""); return m ? `${m[2]}/${m[1]}` : String(s || ""); };
const atTime = (key, hhmm) => {
  const d = keyDate(key);
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!d || !m) return null;
  d.setHours(+m[1], +m[2], 0, 0);
  return d.getTime();
};
const uniqJoin = (list, map = (x) => x) => [...new Set(list.filter(Boolean).map(map))].join(", ");
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return dayKey(d); };
const SKEL = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
const TOL = 0.05;
const bad = (n) => n !== null && n !== undefined && Math.abs(n) >= TOL;

// The last day a batch can be used: "10/2027" → "2027-10-31", "2027-10" → "2027-10-31", "2027-10-15" stays
const expEnd = (s) => {
  s = String(s || "").trim();
  const last = (y, mo) => dayKey(new Date(y, mo, 0));
  let m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return last(+m[2], +m[1]);
  m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s);
  if (m) return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : last(+m[1], +m[2]);
  return "";
};
const isExpired = (exp, date) => String(exp || "").split(",").some((x) => { const k = expEnd(x); return !!k && k < date; });

/* ---------- Entries (one per thing that happened) ---------- */
// Is this kit-use move one of the injector's own usage records? (Those are counted from the usage itself.)
const ImmutableOwn = (ownUse, m) => ownUse.has(String(m.ref || ""));
function portalEntries({ uid, product, moves, loans, usage, days }) {
  const pid = product.id;
  const per = Number(product.dosePer) || 0;
  const out = [];
  const add = (e) => { if (e.date) out.push({ src: "portal", ord: 1, counts: true, ...e }); };
  const ownUse = new Set(usage.map((u) => u.id));   // their own records (counted from the usage below)

  moves.forEach((m) => {
    if (m.productId !== pid || (m.byUid !== uid && m.staffUid !== uid)) return;
    const kl = (m.lines || []).filter((l) => l.loc === "kit");
    const kd = kl.reduce((a, l) => a + (Number(l.delta) || 0), 0);
    const b = kl[0] || {};
    const base = { ms: msOf(m.at), date: m.effectiveDate || keyOf(m.at), batch: b.batch || "", expiry: b.expiry || "" };
    if (m.type === "kit-take" && m.byUid === uid) add({ ...base, kind: "move", sub: "restock", units: Math.abs(kd) * per });
    else if (m.type === "kit-return" && m.byUid === uid) add({ ...base, kind: "move", sub: "return", units: -Math.abs(kd) * per });
    else if (m.type === "kit-discard" && m.byUid === uid) {
      const du = Number(m.discardUnits);
      const units = Number.isFinite(du) ? du : Math.abs(kd) * per;
      if (units) add({ ...base, kind: "move", sub: "discard", units: -units });
    } else if (m.type === "kit-count" && m.staffUid === uid) {
      const after = Number((/→\s*([\d.]+)/.exec(m.note || "") || [])[1]);
      if (/Kit set by admin/i.test(m.reason || "") && Number.isFinite(after)) add({ ...base, kind: "count", cat: "start", ord: 0, value: r1(after) });
    } else if (m.type === "kit-use" && m.staffUid === uid && !ImmutableOwn(ownUse, m)) {
      // Entered by someone else from this kit: a paper record for a colleague, or one not moved over to them yet
      const [patientName = ""] = String(m.note || "").split(" · ");
      add({ ...base, kind: "move", sub: "use", units: kd, patientName, type: "Treatment", paper: true, areas: "" });
    } else if (m.type === "kit-correct" && m.staffUid === uid && kd && !ImmutableOwn(ownUse, m)) {
      add({ ...base, kind: "move", sub: "fix", units: kd });
    }
  });

  loans.forEach((l) => {
    if (l.productId !== pid) return;
    const u = r1(l.units);
    if (!u) return;
    const base = { ms: msOf(l.createdAt), date: keyOf(l.createdAt), batch: l.batch || "", expiry: l.expiry || "", status: l.status || "" };
    if (l.toUid === uid) add({ ...base, kind: "move", sub: "borrow", units: u, who: l.fromName || "a colleague" });
    if (l.fromUid === uid) add({ ...base, kind: "move", sub: "lend", units: -u, who: l.toName || "a colleague" });
  });

  usage.forEach((u) => (u.lines || []).forEach((l) => {
    if (l.productId !== pid || (l.kind !== "kit" && l.kind !== "vial")) return;
    const total = r1(l.total);
    if (!total) return;
    const rows = l.rows || [];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(u.recordDate || "") ? u.recordDate : keyOf(u.at);
    const form = String(u.formName || "");
    const otherKit = l.kind === "kit" && !!l.kitUid && l.kitUid !== uid;   // a paper record, from a colleague's kit
    add({
      ms: keyOf(u.at) === date ? msOf(u.at) : null, date, kind: "move", sub: "use", units: -total,
      counts: l.kind === "kit" && !otherKit,
      patientName: u.patientName || "", patientId: u.patientId || "", submissionId: u.submissionId || "",
      type: /touch/i.test(form) ? "Touch up" : "Treatment", paper: /paper/i.test(u.source || ""), areas: "",
      batch: uniqJoin(rows.map((r) => r.batch)), expiry: uniqJoin(rows.map((r) => r.expiry), expMY),
      from: l.kind === "vial" ? ((rows[0] || {}).from === "shelf" ? "the Shelf" : "JT storage")
        : otherKit ? "a colleague's kit" : "",
    });
  }));

  days.forEach((d) => {
    const s = d.start, e = d.end;
    const si = s && !s.notInjecting ? (s.items || []).find((it) => it.productId === pid) : null;
    if (si) {
      add({ ms: msOf(s.at), date: d.dateKey, kind: "count", cat: "start", ord: 0, value: r1(si.counted),
        batches: (si.rows || []).map((r) => ({ batch: r.batch, expiry: r.expiry, inUse: r.inUse })) });
    }
    const ei = e ? (e.items || []).find((it) => it.productId === pid) : null;
    if (ei) add({ ms: msOf(e.at), date: d.dateKey, kind: "count", cat: "end", ord: 2, value: r1(ei.counted) });
  });
  return out;
}

function oldEntries(data) {
  const out = [];
  const add = (e) => { if (e.date) out.push({ src: "old", ord: 1, counts: true, ...e }); };
  const clean = (s) => (s && s !== "N/A" ? String(s) : "");
  const counts = {};
  (data.rows || []).forEach((r) => {
    const base = { ms: r.at || null, date: r.date, batch: clean(r.batch), expiry: clean(r.expiry) };
    if (r.kind === "SOD" || r.kind === "EOD") {
      // One count per day: a batch counted twice keeps the later count, different batches add up
      const c = counts[`${r.date}|${r.kind}`] || (counts[`${r.date}|${r.kind}`] = { date: r.date, kind: r.kind, ms: null, by: {} });
      const bk = normB(base.batch) || `row${Object.keys(c.by).length}`;
      const prev = c.by[bk];
      if (!prev || (r.at || 0) >= prev.at) c.by[bk] = { batch: base.batch, expiry: base.expiry, units: r.count, at: r.at || 0 };
      if (r.at && (!c.ms || r.at < c.ms)) c.ms = r.at;
    } else if (r.kind === "RESTOCK" && !r.voided) {
      add({ ...base, kind: "move", sub: "restock", units: r.count });
    } else if (r.kind === "BORROW-IN") {
      add({ ...base, kind: "move", sub: "borrow", units: r.count, who: String(r.note || "").replace(/^from\s+/i, "") || "a colleague" });
    } else if (r.kind === "BORROW-OUT") {
      add({ ...base, kind: "move", sub: "lend", units: -r.count, who: String(r.note || "").replace(/^to\s+/i, "") || "a colleague" });
    }
  });
  Object.values(counts).forEach((c) => {
    const list = Object.values(c.by);
    const sod = c.kind === "SOD";
    add({ ms: c.ms, date: c.date, kind: "count", cat: sod ? "start" : "end", ord: sod ? 0 : 2,
      value: r1(list.reduce((a, x) => a + (Number(x.units) || 0), 0)), batches: list });
  });
  (data.records || []).forEach((w) => {
    add({ ms: atTime(w.date, w.time), date: w.date, kind: "move", sub: "use", units: -r1(w.units),
      patientName: w.patientName || "", patientId: w.patientId || "", type: w.type || "Treatment", areas: w.areas || "",
      batch: w.batch || "", expiry: w.expiry || "", pdf: w.pdf || "" });
  });
  return out;
}

// In order, with the running balance (each count resets it), so a start count that doesn't match can be shown
function buildLedger(entries) {
  const tOf = (e) => {
    if (e.ms !== null && e.ms !== undefined && dayKey(new Date(e.ms)) === e.date) return e.ms;
    const d = keyDate(e.date);
    return (d ? d.getTime() : 0) + (e.ord === 0 ? 0 : e.ord === 2 ? 86399000 : 43200000);
  };
  entries.forEach((e) => { e.t = tOf(e); });
  entries.sort((a, b) => a.t - b.t || a.ord - b.ord);
  let bal = null;
  let lastCount = null;
  entries.forEach((e) => {
    if (e.kind === "count") {
      e.expected = bal;
      e.prevDate = lastCount ? lastCount.date : "";   // the count it's compared with (for Explain)
      bal = e.value;
      lastCount = e;
    } else if (e.kind === "move" && e.counts !== false && bal !== null) {
      bal = r1(bal + e.units);
    }
  });
  return entries;
}

// Both apps together. A treatment saved in both (same patient, same day) is counted once, from the portal.
// Counts and restocks: the portal's on the days it has them, otherwise the old app's.
function mergeSources(portal, old) {
  const pUses = portal.filter((e) => e.sub === "use");
  const pDays = new Set(portal.filter((e) => !e.paper && e.sub !== "use").map((e) => e.date));
  return buildLedger(portal.concat(old.filter((e) => {
    if (e.sub === "use") return !pUses.some((u) => u.date === e.date && samePt(u, e));
    return !pDays.has(e.date);
  })));
}

// One day, and the checks on it
function groupDays(entries) {
  const m = new Map();
  entries.forEach((e) => { const d = m.get(e.date) || { date: e.date, list: [] }; d.list.push(e); m.set(e.date, d); });
  return [...m.values()].map(({ date, list }) => {
    const uses = list.filter((e) => e.sub === "use");
    const start = list.find((e) => e.kind === "count" && e.cat === "start") || null;
    const end = [...list].reverse().find((e) => e.kind === "count" && e.cat === "end") || null;
    const sumU = (l) => r1(l.reduce((a, e) => a + e.units, 0));
    const kitUsed = r1(-sumU(uses.filter((e) => e.counts !== false)));
    const other = sumU(list.filter((e) => e.kind === "move" && e.sub !== "use" && e.counts !== false));
    // Negative: fewer at the end of the day than start + restocks − patients (units gone with no record)
    const gap = start && end ? r1(end.value - (start.value + other - kitUsed)) : null;
    const startDiff = start && start.expected !== null && start.expected !== undefined ? r1(start.value - start.expected) : null;
    const colleagues = list.filter((e) => e.sub === "borrow" || e.sub === "lend");
    const loansOpen = colleagues.filter((e) => e.status === "unconfirmed" || e.status === "disputed");
    const expired = uses.filter((e) => isExpired(e.expiry, e.date));
    const uncounted = uses.length > 0 && !start;
    return {
      date, uses, start, end, kitUsed, other, gap, startDiff, colleagues, loansOpen, expired, uncounted,
      used: r1(-sumU(uses)),
      restocks: list.filter((e) => e.sub === "restock"),
      check: bad(startDiff) || bad(gap) || expired.length > 0 || uncounted || loansOpen.length > 0,
    };
  });
}

// A start count that didn't match: one difference, from the count before it up to this one
function segOf(p, d) {
  if (!bad(d.startDiff) || !d.start || !d.start.prevDate) return null;
  const from = d.start.prevDate, to = d.date;
  return {
    staffKey: `${p.uid}_${p.product.id}`, staffName: p.name, oldNames: p.oldNames || [], from, to, gap: d.startDiff,
    noExplain: d.start.src !== "old" || !(to > from),   // Explain reads the old app's records only
  };
}

// Booked for the kit product that day, matched to the records by patient (ID, otherwise name),
// on the same day or within 3 days (a record saved on the wrong date)
const nameKey = (s) => String(s || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const samePt = (a, b) => (a.patientId && b.patientId ? a.patientId === b.patientId
  : !!nameKey(a.patientName) && nameKey(a.patientName) === nameKey(b.patientName));
const daysApart = (a, b) => Math.abs((keyDate(a) - keyDate(b)) / 864e5);
const emptyDay = (date) => ({ date, uses: [], start: null, end: null, kitUsed: 0, other: 0, gap: null, startDiff: null,
  colleagues: [], loansOpen: [], expired: [], uncounted: false, used: 0, restocks: [], check: false });

function bookingsOf(p, d, booked) {
  if (!booked) return [];
  const uses = p.L.filter((e) => e.sub === "use");
  d.uses.forEach((e) => { e.unbooked = !booked.some((b) => samePt(e, b)); });
  return booked.filter((b) => !d.uses.some((e) => samePt(e, b))).map((b) => {
    const other = uses.find((e) => e.date !== d.date && daysApart(e.date, d.date) <= 3 && samePt(e, b));
    return { ...b, other: other ? other.date : "" };
  });
}

// Marked as checked, and not changed since: it no longer needs checking. bk: the appointment book, per injector and day
function withChecks(p, list, bk) {
  const days = new Map(list.map((d) => [d.date, d]));
  if (bk) bk.days(p.uid).forEach((date) => { if (!days.has(date)) days.set(date, emptyDay(date)); });
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const seg = segOf(p, d);
    const c = seg ? checkOf(seg) : null;
    const done = !!(c && c.status === "checked" && r1(c.gap) === r1(seg.gap));
    const noRecord = bookingsOf(p, d, bk ? bk.on(p.uid, d.date) : null);
    const missing = noRecord.filter((b) => !b.other && !(b.res && b.res.status));
    const check = (bad(d.startDiff) && !done) || bad(d.gap) || d.expired.length > 0 || d.uncounted || d.loansOpen.length > 0 || missing.length > 0;
    return { ...d, seg, done, noRecord, missing, check };
  });
}
function checkList(d) {
  const out = [];
  if (d.uncounted) out.push({ t: "Not counted", bad: false });
  if (d.missing && d.missing.length) out.push({ t: `${d.missing.length} booked, no record`, bad: true });
  if (bad(d.gap)) out.push(d.gap < 0 ? { t: `${fmt(-d.gap)} not on a patient`, bad: true } : { t: `${fmt(d.gap)} more than expected`, bad: false });
  if (bad(d.startDiff)) out.push({ t: `Start ${d.startDiff > 0 ? "+" : "−"}${fmt(Math.abs(d.startDiff))}${d.done ? " · checked ✓" : ""}`,
    bad: d.startDiff < 0 && !d.done });
  if (d.expired.length) out.push({ t: `Expired batch used${d.expired.length > 1 ? ` ×${d.expired.length}` : ""}`, bad: true });
  d.loansOpen.forEach((e) => out.push(e.status === "disputed" ? { t: "Handover disputed", bad: true } : { t: "Handover not confirmed", bad: false }));
  return out;
}
const flagHtml = (f) => `<span class="kr-flag${f.bad ? " is-bad" : ""}">${esc(f.t)}</span>`;

/* ---------- How to use this (the guide) ---------- */
const HELP_SECTIONS = [
  ["What this report is", `
    <p>Kit reconciliation shows everything that happened to each injector's kit, day by day: what they started with,
    what came in, what was used on patients and what they finished with. If the numbers don't add up, it tells you where.</p>
    <p>It brings together the <strong>old app</strong> (start-of-day counts and Wrinkle Relaxer records, February to October 2026)
    and the <strong>portal</strong> (from October 2026) as one record. A treatment saved in both for the same patient on the
    same day is counted once, from the portal.</p>`],

  ["The filters", `
    <ul>
      <li><strong>Staff</strong>: tick one or more injectors, or leave it on <em>All injectors</em>. Only staff with
        <strong>Injector</strong> ticked in Staff management appear. If someone is missing, tick Injector on their staff record.</li>
      <li><strong>From / To</strong>: the dates shown. It opens on the last 90 days. Clear both to see everything.</li>
      <li><strong>Product</strong>: the kit product. The old app only recorded Xeomin.</li>
      <li><strong>Only days that need checking</strong>: hides every day that adds up, so you only see the problems.</li>
    </ul>`],

  ["The summary (one line per injector)", `
    <p>Above the table, one line for each injector covering the dates you've chosen.</p>
    <ul>
      <li><strong>Opening</strong>: their first start count in these dates.</li>
      <li><strong>Restocked</strong>: units taken into their kit. Returns, discards and corrections are shown underneath.</li>
      <li><strong>Colleagues</strong>: units received from (+) or given to (−) other injectors.</li>
      <li><strong>Used on patients</strong>: units recorded on treatment records, and how many records.</li>
      <li><strong>Closing</strong>: their last start count in these dates.</li>
      <li><strong>Not accounted for</strong>: the opening count plus everything in and out, compared with the closing count.
        <em>Adds up</em> is what you want. <em>4 missing</em> means 4 units left the kit with no record.
        <em>2 extra</em> means there were more than there should have been (usually a restock that wasn't recorded).
        It needs at least two start counts in the dates chosen.</li>
      <li><strong>Needs checking</strong>: how many days have something to look at. Click it to see just those days.
        It also shows expired batches used, days not counted, handovers not confirmed and batches in their kit expiring
        within 60 days.</li>
    </ul>
    <p>Click an injector's name to see only their days.</p>`],

  ["The days table", `
    <ul>
      <li><strong>Batch Number / Exp Date</strong>: the batch in their kit that day, from their start count
        (or from their treatments if they didn't count).</li>
      <li><strong>Start Count</strong>: what they counted at the start of the day. A red <em>expected</em> figure underneath
        means it didn't match what they should have had from the day before.</li>
      <li><strong>End of Count</strong>: their end-of-day count, if they did one. The old app rarely recorded these.</li>
      <li><strong>Total Usage</strong>: units recorded on patients that day.</li>
      <li><strong>Restock Record</strong>: units taken into the kit, with batch and expiry, and anything from or to a colleague.</li>
      <li><strong>History</strong>: every patient treated that day, with the time, type of record, area and units.
        Click a patient's name to open their page, or the type of record to open the record itself.</li>
    </ul>`],

  ["What the checks mean", `
    <ul>
      <li><span class="kr-flag">Not counted</span> Treatments were recorded, but there was no start count that day,
        so nobody can say what was in the kit.</li>
      <li><span class="kr-flag is-bad">5 not on a patient</span> The start count plus restocks, minus the patients, should have
        left more than the end count. Those units left the kit without a patient record. Needs an end count that day.</li>
      <li><span class="kr-flag">2 more than expected</span> There were more units at the end of the day than there should have been.
        Usually a restock that wasn't recorded.</li>
      <li><span class="kr-flag is-bad">Start −3</span> The start count was lower than what they had the day before (minus anything
        used since). A plus sign means higher.</li>
      <li><span class="kr-flag is-bad">Expired batch used</span> A patient was treated after the batch's expiry date.
        Check the record straight away.</li>
      <li><span class="kr-flag">Handover not confirmed</span> Units were taken from a colleague, but the colleague hasn't confirmed
        it in the portal. <em>Disputed</em> means they said the amount was wrong.</li>
    </ul>`],

  ["When something doesn't add up", `
    <ol>
      <li>Tick <strong>Only days that need checking</strong>, or click <em>days to check</em> in the summary.</li>
      <li>Start with the oldest day, because one wrong count makes the next day look wrong too.</li>
      <li>Open <strong>History</strong> and compare the patients with the appointment book for that day.
        A missing patient is the most common cause.</li>
      <li>Check for a restock or handover that wasn't recorded (the <em>extra</em> checks), and a count that was
        typed wrongly (a difference one day that is reversed the next).</li>
      <li>If it's still unexplained, talk to the injector and note what happened.</li>
    </ol>`],

  ["Batch lookup", `
    <p>Type a batch number and press <strong>Find</strong> to see every patient treated with that batch, and every time it came
    into or left a kit. It covers the old app and the portal, all dates and all staff, whatever the other filters are set to.</p>
    <p>Use it if a supplier or the TGA recalls a batch: you get the patient list in seconds. <strong>Export CSV</strong> gives you
    the full list, with Patient IDs, to contact them. Treatments after the expiry date are marked.</p>
    <p>Part of a batch number works too, as long as you type at least 4 characters.</p>`],

  ["Dosing", `
    <p>Average units for each injector, compared with the whole clinic, for the dates and staff chosen.</p>
    <ul>
      <li><strong>Units per treatment</strong>: treatments and touch ups are kept separate, because touch ups are much smaller.</li>
      <li><strong>Units per area</strong>: averages for each area (forehead, frown, crow's feet…).
        <span class="kr-hi">&nbsp;Amber&nbsp;</span> is 25% or more above the clinic's average;
        <span class="kr-lo">&nbsp;blue&nbsp;</span> is 25% or more below. Only shown where someone has 3 or more treatments for that area.</li>
    </ul>
    <p>A difference isn't wrong in itself (some injectors see patients needing more), but it's useful for training and consistency.
    Areas come from the old app's records for now, because portal records don't save the area yet.</p>`],

  ["Exporting", `
    <ul>
      <li><strong>Days</strong>: <em>Export CSV</em> gives one line per patient for the days shown, with the day's counts and checks.
        Use the filters first to export just what you need.</li>
      <li><strong>Batch lookup</strong>: <em>Export CSV</em> gives every treatment and movement for that batch.</li>
    </ul>`],

  ["Good to know", `
    <ul>
      <li><strong>Dr Teh's old app days</strong> often show large differences. Her old app counts look like JT storage rather than
        a kit, so those differences aren't missing stock.</li>
      <li><strong>The old app's records</strong> are refreshed every hour. The portal's are always up to date.</li>
      <li>Days where someone only logged a start count of 0 and nothing else are hidden, because they weren't carrying any.</li>
      <li><strong>Treatments from the Shelf or JT storage</strong> (not the kit) appear in History and in Total Usage, but don't
        count against the kit.</li>
    </ul>`],
];

function helpHtml() {
  return `<section class="tb-card kr-help">
      <div class="kr-help-head">
        <h3>How to use Kit reconciliation</h3>
        <button type="button" class="lh-btn" data-act="kr-help">Close</button>
      </div>
      ${HELP_SECTIONS.map(([title, html], i) => `<details class="kr-help-sec"${i === 0 ? " open" : ""}>
          <summary>${title}</summary><div class="kr-help-body">${html}</div></details>`).join("")}
    </section>`;
}

/* ---------- Reporting → Kit reconciliation ---------- */
export function mountKitReconciliation(body, { csv = null, staff = null } = {}) {
  const st = {
    view: "days", staff: new Set(), staffOpen: false, product: "", from: daysAgo(89), to: "", onlyCheck: false, limit: 100,
    help: false,
    open: new Set(), people: [], products: [], problem: "", oldProblem: "", loadingOld: false, base: null, old: {}, seq: 0,
    q: "", allPeople: null, loadingAll: false, allProblem: "", checksProblem: "",
    q: "", allPeople: null, loadingAll: false, allProblem: "", checksProblem: "", book: {}, bookProblem: "",
  };

  // Explain, Mark as checked and History on each difference (one listener for the whole page)
  bindKitChecks(body, { staff, onChange: () => draw() });

  // Portal records: read once
  async function load() {
    body.innerHTML = SKEL;
    try {
      const [products, kits, moves, loans, staffRes] = await Promise.all([
        listProducts(), listKits(), listKitMoves(), listAllLoans(),
        callApi({ action: "staffList" }).catch(() => ({ staff: [] })),
        loadChecks(true).catch((e) => {
          console.warn("Kit checks not loaded:", e);
          st.checksProblem = "Saved checks couldn't be loaded, so every difference shows as unchecked.";
          return null;
        }),
      ]);
      const kitPs = products.filter((p) => p.usage === "kit" && p.dosePer);
      if (!kitPs.length) { body.innerHTML = '<div class="tm-empty">No products are carried in kits yet.</div>'; return; }
      const oldProduct = kitPs.find((p) => /xeomin/i.test(p.name)) || kitPs[0];   // the old app only had Xeomin
      const kitIds = new Set(kitPs.map((p) => p.id));
      st.products = kitPs;
      if (!st.product) st.product = oldProduct.id;

      const staff = staffRes && Array.isArray(staffRes.staff) ? staffRes.staff : [];
      const byId = new Map(staff.map((s) => [s.id, s]));
      const uids = new Set(staff.filter((s) => s.injector).map((s) => s.id));
      kits.forEach((k) => { if (kitIds.has(k.productId) && k.staffUid) uids.add(k.staffUid); });
      moves.forEach((m) => {
        if (!kitIds.has(m.productId)) return;
        if (["kit-take", "kit-return", "kit-discard", "kit-use"].includes(m.type) && m.byUid) uids.add(m.byUid);
        if (m.staffUid) uids.add(m.staffUid);
      });
      loans.forEach((l) => { if (kitIds.has(l.productId)) { if (l.toUid) uids.add(l.toUid); if (l.fromUid) uids.add(l.fromUid); } });

      st.problem = "";
      const data = await Promise.all([...uids].map(async (uid) => {
        let usage = [], days = [];
        try { [usage, days] = await Promise.all([listUsageByStaff(uid), listKitDaysFor(uid)]); }
        catch (e) { console.error("Kit records failed for", uid, e); st.problem = "Some portal records couldn't be loaded."; }
        const kitName = (kits.find((k) => k.staffUid === uid) || {}).staffName;
        return { uid, usage, days, name: (byId.get(uid) || {}).name || kitName || "Unknown" };
      }));
      st.base = { kitPs, oldProduct, moves, loans, byId, data };
      await loadOld(false);
    } catch (err) {
      console.error("Kit reconciliation failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="tm-empty is-error">${esc(err && err.code === "permission-denied"
          ? "You don't have access to these records." : "Couldn't load the kits. Try again.")}</div>`;
      }
    }
  }

  // The old app's records for the chosen dates (asked for again when the dates change, remembered per range)
  async function loadOld(fresh) {
    const k = `${st.from || ""}|${st.to || ""}`;
    if (!(k in st.old) || fresh) {
      const my = ++st.seq;
      st.loadingOld = true;
      if (st.people.length) draw(); else body.innerHTML = SKEL;
      let people = null;
      try {
        const r = await callApi({ action: "inventory", op: "oldKitLedgerAll", from: st.from || "", to: st.to || "", fresh: fresh === true });
        if (r && r.problem) throw new Error(r.problem);
        people = (r && r.people) || [];
        st.oldProblem = "";
      } catch (e) {
        st.oldProblem = `Old app records: ${(e && e.message) || "couldn't be read."} Try a shorter date range.`;
      }
      if (!(k in st.book) || fresh) {
        try {
          const rb = await callApi({ action: "inventory", op: "kitBookings", from: st.from || "", to: st.to || "" });
          if (rb && rb.problem) throw new Error(rb.problem);
          if (rb && rb.days) st.book[k] = rb;
          st.bookProblem = "";
        } catch (e) {
          st.bookProblem = `Appointment book: ${(e && e.message) || "couldn't be read."} Bookings with no record aren't shown.`;
        }
      }
      if (my !== st.seq) return;
      st.loadingOld = false;
      if (people) st.old[k] = people;
    }
    st.people = makePeople(st.old[k] || []);
    if (body.isConnected) draw();
  }

  // Every date, for Batch lookup (asked for once)
  async function loadAll() {
    if (st.allPeople || st.loadingAll || !st.base) return;
    st.loadingAll = true;
    draw();
    try {
      const k = "|";
      if (!(k in st.old)) {
        const r = await callApi({ action: "inventory", op: "oldKitLedgerAll", from: "", to: "" });
        if (r && r.problem) throw new Error(r.problem);
        st.old[k] = (r && r.people) || [];
      }
      st.allPeople = makePeople(st.old[k]);
      st.allProblem = "";
    } catch (e) {
      st.allProblem = `The old app's records couldn't be read: ${(e && e.message) || "try again."}`;
    }
    st.loadingAll = false;
    if (body.isConnected) draw();
  }

  // Portal and old app together, one ledger per injector and product
  function makePeople(oldPeople) {
    const b = st.base;
    if (!b) return [];
    const oldBy = new Map(oldPeople.map((p) => [p.key, p]));
    const have = new Set(b.data.map((x) => x.uid));
    const people = [];
    b.kitPs.forEach((product) => {
      b.data.forEach((x) => {
        const o = oldBy.get(x.uid);
        const pe = portalEntries({ uid: x.uid, product, moves: b.moves, loans: b.loans, usage: x.usage, days: x.days });
        const oe = product === b.oldProduct && o ? oldEntries(o) : [];
        if (pe.length || oe.length) people.push({ uid: x.uid, name: x.name, product, oldNames: (o && o.oldNames) || [], L: mergeSources(pe, oe) });
      });
      if (product === b.oldProduct) {
        oldBy.forEach((o, key) => {
          if (have.has(key)) return;
          people.push({ uid: key, name: (b.byId.get(key) || {}).name || o.staffName, product, oldNames: o.oldNames || [],
            L: mergeSources([], oldEntries(o)) });
        });
      }
    });
    // Only staff ticked as an Injector in Staff management are shown (Batch lookup shows everyone)
    people.forEach((p) => {
      const s = b.byId.get(p.uid);
      p.injector = !!(s && s.injector);
      p.role = (s && s.role) || "";
    });
    return people;
  }

  const range = () => [st.from || "0000-00-00", st.to || "9999-99-99"];
  const unitOf = (p) => (p && p.product && p.product.doseUnit) || "units";
  const bookKey = () => `${st.from || ""}|${st.to || ""}`;
  const bk = {
    days: (uid) => { const b = st.book[bookKey()]; return b ? Object.keys(b.days).filter((dk) => b.days[dk].some((x) => x.staffUid === uid)) : []; },
    on: (uid, date) => { const b = st.book[bookKey()]; return b && date >= b.from && date <= b.to ? (b.days[date] || []).filter((x) => x.staffUid === uid) : null; },
  };
  function visible() {
    return st.people.filter((p) => p.injector && (!st.product || p.product.id === st.product) && (!st.staff.size || st.staff.has(p.uid)));
  }

  function rows() {
    const [a, b] = range();
    const out = [];
    const empty = (c) => !c || (!c.value && !(c.batches || []).some((x) => x.batch));
    visible().forEach((p) => {
      withChecks(p, groupDays(p.L.filter((e) => e.date >= a && e.date <= b)), bk).forEach((d) => {
        if (empty(d.start) && empty(d.end) && !d.uses.length && !d.restocks.length && !d.colleagues.length && !d.noRecord.length) return;
        if (st.onlyCheck && !d.check) return;
        out.push({ ...d, p, id: `${p.product.id}|${p.uid}|${d.date}` });
      });
    });
    return out.sort((x, y) => y.date.localeCompare(x.date) || x.p.name.localeCompare(y.p.name, "en-AU")
      || x.p.product.name.localeCompare(y.p.product.name, "en-AU"));
  }

  // The batches in use that day: from the start count, otherwise from the treatments
  function batchesOf(d) {
    const b = ((d.start && d.start.batches) || []).filter((x) => x.batch);
    const inUse = b.filter((x) => x.inUse);
    if (b.length) return inUse.length ? inUse : b;
    const seen = new Map();
    d.uses.forEach((e) => String(e.batch || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((batch, i) => {
      if (!seen.has(normB(batch))) seen.set(normB(batch), { batch, expiry: String(e.expiry || "").split(",")[i] || "" });
    }));
    return [...seen.values()];
  }

  /* ---------- Summary per injector ---------- */

  function summaryOf(p) {
    const [a, b] = range();
    const L = p.L.filter((e) => e.date >= a && e.date <= b);
    const tot = (f) => r1(L.filter(f).reduce((x, e) => x + e.units, 0));
    const starts = L.filter((e) => e.kind === "count" && e.cat === "start");
    const first = starts[0] || null;
    const last = starts[starts.length - 1] || null;
    let expected = null, gap = null;
    if (first && last && first !== last) {
      expected = r1(first.value + L.filter((e) => e.t >= first.t && e.t < last.t && e.kind === "move" && e.counts !== false)
        .reduce((x, e) => x + e.units, 0));
      gap = r1(last.value - expected);
    }
    const days = withChecks(p, groupDays(L), bk);

    // What's in their kit now (their latest start count, any date), and what expires within 60 days
    const allStarts = p.L.filter((e) => e.kind === "count" && e.cat === "start");
    const now = allStarts[allStarts.length - 1] || null;
    const soon = dayKey(new Date(Date.now() + 60 * 864e5));
    const today = dayKey();
    const expiring = now && now.value > 0 ? (now.batches || [])
      .filter((x) => x.batch && (x.units === undefined || Number(x.units) > 0))
      .map((x) => ({ batch: x.batch, expiry: x.expiry, end: expEnd(x.expiry) }))
      .filter((x) => x.end && x.end <= soon) : [];

    return {
      first, last, expected, gap, today, expiring,
      restock: tot((e) => e.sub === "restock"),
      fromCol: tot((e) => e.sub === "borrow"),
      toCol: r1(-tot((e) => e.sub === "lend")),
      other: tot((e) => ["return", "discard", "fix"].includes(e.sub)),
      used: r1(-tot((e) => e.sub === "use")),
      patients: L.filter((e) => e.sub === "use").length,
      checkDays: days.filter((d) => d.check).length,
      uncounted: days.filter((d) => d.uncounted).length,
      expired: days.reduce((x, d) => x + d.expired.length, 0),
      loansOpen: days.reduce((x, d) => x + d.loansOpen.length, 0),
      noRecord: days.reduce((x, d) => x + d.missing.length, 0),
    };
  }

  function summaryHtml() {
    const list = visible().map((p) => ({ p, s: summaryOf(p) }))
      .filter(({ s }) => s.first || s.patients || s.restock || s.fromCol || s.toCol)
      .sort((x, y) => x.p.name.localeCompare(y.p.name, "en-AU") || x.p.product.name.localeCompare(y.p.product.name, "en-AU"));
    if (!list.length) return "";
    const cnt = (c) => (c ? `<strong>${fmt(c.value)}</strong><small>${esc(shortDay(c.date))}</small>` : "—");
    return `<h3 class="kr-sec">Summary for these dates</h3>
      <section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table kr-table kr-sum">
      <thead><tr><th>Injector</th><th class="n">Opening</th><th class="n">Restocked</th><th class="n">Colleagues</th>
        <th class="n">Used on patients</th><th class="n">Closing</th><th class="n">Not accounted for</th><th>Needs checking</th></tr></thead>
      <tbody>${list.map(({ p, s }) => {
        const unit = unitOf(p);
        let acc = '—<small>needs two start counts</small>';
        if (s.gap !== null) {
          acc = !bad(s.gap) ? '<span class="kr-ok">Adds up</span>'
            : s.gap < 0 ? `<strong class="kr-bad">${fmt(-s.gap)} missing</strong><small>expected ${fmt(s.expected)}</small>`
            : `<strong class="kr-warn">${fmt(s.gap)} extra</strong><small>expected ${fmt(s.expected)}</small>`;
        }
        const flags = [];
        if (s.checkDays) flags.push(`<button type="button" class="kr-link" data-check="${esc(p.uid)}">${plural(s.checkDays, "day")} to check</button>`);
        if (s.expired) flags.push(flagHtml({ t: `Expired batch used ×${s.expired}`, bad: true }));
        if (s.uncounted) flags.push(flagHtml({ t: `${plural(s.uncounted, "day")} not counted`, bad: false }));
        if (s.loansOpen) flags.push(flagHtml({ t: `${plural(s.loansOpen, "handover")} not confirmed`, bad: false }));
        if (s.noRecord) flags.push(flagHtml({ t: `${plural(s.noRecord, "booking")} with no record`, bad: true }));
        s.expiring.forEach((x) => flags.push(flagHtml({
          t: `${x.batch} ${x.end < s.today ? "expired" : "expires"} ${expMY(x.expiry) || x.end}`, bad: x.end < s.today })));
        return `<tr>
          <td><button type="button" class="kr-link" data-only="${esc(p.uid)}">${esc(p.name)}</button>
            ${st.product ? "" : `<small>${esc(p.product.name)}</small>`}</td>
          <td class="n">${cnt(s.first)}</td>
          <td class="n">${s.restock ? `+${fmt(s.restock)}` : "—"}${s.other ? `<small>${s.other > 0 ? "+" : "−"}${fmt(Math.abs(s.other))} returned or fixed</small>` : ""}</td>
          <td class="n">${s.fromCol || s.toCol ? `${s.fromCol ? `+${fmt(s.fromCol)}` : ""}${s.fromCol && s.toCol ? " / " : ""}${s.toCol ? `−${fmt(s.toCol)}` : ""}` : "—"}</td>
          <td class="n">${s.used ? `<strong>${fmt(s.used)}</strong> ${esc(unit)}<small>${plural(s.patients, "record")}</small>` : "—"}</td>
          <td class="n">${s.last && s.last !== s.first ? cnt(s.last) : "—"}</td>
          <td class="n">${acc}</td>
          <td>${flags.join(" ") || '<span class="kr-ok">Nothing to check</span>'}</td></tr>`;
      }).join("")}</tbody></table></div></section>
      <p class="muted rp-note">Not accounted for compares their first and last start count in these dates with everything in between.
        Negative means units left the kit without a record.</p>`;
  }

  /* ---------- Toolbar and views ---------- */

  function tabsHtml() {
    return `<div class="kr-views">${[["days", "Days"], ["batch", "Batch lookup"], ["dosing", "Dosing"]].map(([v, l]) =>
      `<button type="button" class="kr-view${st.view === v ? " is-on" : ""}" data-view="${v}">${l}</button>`).join("")}
      <button type="button" class="kr-view kr-help-btn${st.help ? " is-on" : ""}" data-act="kr-help">${st.help ? "Hide the guide" : "How to use this"}</button>
    </div>`;
  }

  function toolsHtml() {
    const staff = new Map();
    st.people.filter((p) => p.injector).forEach((p) => staff.set(p.uid, { name: p.name, role: p.role }));
    const list = [...staff].sort((a, b) => a[1].name.localeCompare(b[1].name, "en-AU"));
    const dup = {};
    list.forEach(([, s]) => { dup[s.name] = (dup[s.name] || 0) + 1; });
    const label = (s) => esc(s.name) + (dup[s.name] > 1 && s.role ? ` <small>(${esc(s.role)})</small>` : "");
    const picked = list.filter(([uid]) => st.staff.has(uid));
    const summary = !picked.length ? "All injectors"
      : picked.length <= 2 ? picked.map(([, s]) => s.name).join(", ") : `${picked.length} injectors`;

    return `<div class="inv-tools kr-tools">
        <div class="rp-from">Staff
          <details class="kr-staff"${st.staffOpen ? " open" : ""}>
            <summary class="fb-select">${esc(summary)}</summary>
            <div class="kr-staff-panel">
              <div class="kr-staff-acts">
                <button type="button" class="lh-btn" data-act="kr-staff-all">All</button>
                <button type="button" class="lh-btn" data-act="kr-staff-none">Clear</button>
              </div>
              ${list.length ? list.map(([uid, s]) => `<label class="kr-staff-opt">
                  <input type="checkbox" data-staff="${esc(uid)}"${st.staff.has(uid) ? " checked" : ""} /> ${label(s)}
                </label>`).join("") : '<p class="muted">No staff are ticked as an Injector yet.</p>'}
            </div>
          </details>
        </div>
        <label class="rp-from">From <input class="fe-in" type="date" data-f="from" value="${esc(st.from)}" /></label>
        <label class="rp-from">To <input class="fe-in" type="date" data-f="to" value="${esc(st.to)}" /></label>
        <label class="rp-from">Product <select class="fb-select" data-f="product"><option value="">All products</option>
          ${st.products.map((p) => `<option value="${esc(p.id)}"${st.product === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        ${st.view === "days" ? `<label class="kr-tick"><input type="checkbox" data-f="onlyCheck"${st.onlyCheck ? " checked" : ""} /> Only days that need checking</label>` : ""}
        <span class="inv-spacer"></span>
        ${csv && st.view === "days" ? '<button type="button" class="ff-btn" data-act="kr-csv">Export CSV</button>' : ""}
      </div>
      ${st.problem ? `<p class="tb-bad rp-note">${esc(st.problem)}</p>` : ""}
      ${st.oldProblem ? `<p class="tb-bad rp-note">${esc(st.oldProblem)}</p>` : ""}
      ${st.checksProblem ? `<p class="tb-bad rp-note">${esc(st.checksProblem)}</p>` : ""}
      ${st.bookProblem ? `<p class="tb-bad rp-note">${esc(st.bookProblem)}</p>` : ""}
      ${st.loadingOld ? `<p class="muted rp-note">Loading the old app's records for these dates…</p>` : ""}`;
  }

  function historyHtml(d) {
    const unit = unitOf(d.p);
    const who = (e) => (e.patientId
      ? `<a href="#/patient/${encodeURIComponent(e.patientId)}" target="_blank" rel="noopener">${esc(e.patientName || "Patient")}</a>`
      : esc(e.patientName || "—"));
    // The record itself: a portal form, a filed paper scan in Drive, or the old app's PDF
    const recLink = (e) => (e.submissionId
      ? (/^paper_/.test(e.submissionId)
        ? `https://drive.google.com/file/d/${encodeURIComponent(e.submissionId.slice(6))}/view`
        : `#/form-record/${encodeURIComponent(e.submissionId)}`)
      : e.pdf || "");
    const useRows = d.uses.map((e) => {
      const type = esc(e.type || "Treatment") + (e.paper ? " (paper)" : e.src === "old" ? " (old app)" : "");
      const link = recLink(e);
      const notes = [e.from ? `From ${e.from}` : "", e.batch ? `Batch ${e.batch}` : "", e.expiry ? `Exp ${e.expiry}` : ""].filter(Boolean).join(" · ");
      const expired = isExpired(e.expiry, e.date);
      return `<tr><td>${e.ms && dayKey(new Date(e.ms)) === e.date ? esc(timeOf(e.ms)) : "—"}</td>
        <td>${who(e)}</td>
        <td>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${type}</a>` : type}${
          e.unbooked ? '<small class="kr-warn">Not in the appointment book</small>' : ""}</td>
        <td>${esc(e.areas || "—")}${notes ? `<small>${esc(notes)}</small>` : ""}${expired ? '<small class="kr-bad">Expired batch</small>' : ""}</td>
        <td class="n"><strong>${fmt(-e.units)}</strong> ${esc(unit)}</td></tr>`;
    });
    const bookRows = (d.noRecord || []).map((b) => {
      const state = b.res && b.res.status
        ? `<span class="kr-flag">No record needed</span><small>${esc([b.res.note, b.res.by].filter(Boolean).join(" · "))}</small>`
        : b.other ? `<span class="kr-flag">Recorded on ${esc(shortDay(b.other))}</span><small>Check the date on the record</small>`
        : `<span class="kr-flag is-bad">No record</span>
           <small><a href="#/paper" target="_blank" rel="noopener">Enter from paper</a> ·
           <button type="button" class="kr-link" data-noneed="${esc(b.key)}">No record needed</button></small>`;
      return `<tr class="kr-booked"><td>${esc(b.time || "—")}</td><td>${who(b)}</td><td>${state}</td>
        <td>${esc(b.services.join(", "))}<small>Booked${b.touchUp ? " · touch up" : ""}</small></td><td class="n">—</td></tr>`;
    });
    if (!useRows.length && !bookRows.length) return '<p class="muted rp-note">No treatments recorded this day.</p>';
    return `<table class="inv-table kr-hist"><thead><tr><th>Time</th><th>Patient Name</th><th>Type of Record</th><th>Area</th>
        <th class="n">Total Units</th></tr></thead><tbody>${useRows.join("")}${bookRows.join("")}</tbody>
      <tfoot><tr><td colspan="4">Total · ${plural(d.uses.length, "record")}${
        d.missing && d.missing.length ? ` · <span class="kr-bad">${plural(d.missing.length, "booking")} with no record</span>` : ""}</td>
        <td class="n"><strong>${fmt(d.used)}</strong> ${esc(unit)}</td></tr></tfoot></table>`;
  }

  function rowHtml(d) {
    const open = st.open.has(d.id);
    const b = batchesOf(d);
    const start = !d.start ? "—" : `<strong>${fmt(d.start.value)}</strong>${
      bad(d.startDiff) ? `<small class="kr-bad">expected ${fmt(d.start.expected)}</small>` : ""}`;
    const restock = d.restocks.map((e) => `<div>+${fmt(e.units)}${e.batch ? ` · ${esc(e.batch)}` : ""}${e.expiry ? ` · Exp ${esc(expMY(e.expiry))}` : ""}</div>`).join("")
      + d.colleagues.map((e) => {
        const st2 = e.status === "disputed" ? " (disputed)" : e.status === "unconfirmed" ? " (not confirmed)" : "";
        return `<small>${e.units > 0 ? `From ${esc(e.who)} +${fmt(e.units)}` : `To ${esc(e.who)} −${fmt(-e.units)}`}${st2}</small>`;
      }).join("");
    const checks = checkList(d);
    return `<tr class="kr-row${open ? " is-open" : ""}">
        <td>${esc(d.p.product.name)}</td>
        <td><strong>${esc(d.p.name)}</strong></td>
        <td>${esc(niceDay(d.date))}</td>
        <td>${b.length ? b.map((x) => `<div>${esc(x.batch)}</div>`).join("") : "—"}</td>
        <td>${b.length ? b.map((x) => `<div>${esc(expMY(x.expiry) || "—")}</div>`).join("") : "—"}</td>
        <td class="n">${start}</td>
        <td class="n">${d.end ? `<strong>${fmt(d.end.value)}</strong>` : "—"}</td>
        <td class="n">${d.used ? `<strong>${fmt(d.used)}</strong><small>${plural(d.uses.length, "patient")}</small>` : "—"}</td>
        <td>${restock || "—"}</td>
        <td>${checks.length ? checks.map(flagHtml).join(" ") : '<span class="kr-ok">✓</span>'}</td>
        <td><button type="button" class="lh-btn" data-hist="${esc(d.id)}">${open ? "Hide" : "History"}</button></td></tr>
      ${d.seg ? `<tr class="kr-chk"><td colspan="11">${checkToolsHtml(d.seg)}</td></tr>` : ""}
      ${open ? `<tr class="rp-sub"><td colspan="11">${historyHtml(d)}</td></tr>` : ""}`;
  }

  function daysHtml() {
    const list = rows();
    const more = list.length - st.limit;
    return `${summaryHtml()}
      ${list.length ? `<p class="muted rp-range">${list.length} day${list.length === 1 ? "" : "s"}${st.onlyCheck ? " to check" : " recorded"}${
        st.from || st.to ? " in these dates" : ", newest first"}${more > 0 ? `. Showing ${st.limit}: press "Show more" at the bottom for the rest` : ""}.</p>`
        : ""}
      ${list.length ? `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table kr-table">
        <thead><tr><th>Product</th><th>Injector Name</th><th>Date</th><th>Batch Number</th><th>Exp Date</th>
          <th class="n">Start Count</th><th class="n">End of Count</th><th class="n">Total Usage</th><th>Restock Record</th><th>Checks</th><th></th></tr></thead>
        <tbody>${list.slice(0, st.limit).map(rowHtml).join("")}</tbody></table></div>
        ${more > 0 ? `<button type="button" class="ff-btn kr-more" data-act="kr-more">Show ${Math.min(100, more)} more (${more} left)</button>` : ""}
        </section>` : `<div class="tm-empty">${st.onlyCheck ? "Nothing needs checking for these filters. 👍" : "Nothing recorded for these filters."}</div>`}`;
  }

  /* ---------- Batch lookup ---------- */

  function batchHits() {
    const q = normB(st.q);
    if (!q) return [];
    const match = (b) => String(b || "").split(",").some((x) => { const n = normB(x); return !!n && (n === q || (q.length >= 4 && n.includes(q))); });
    const out = [];
    (st.allPeople || []).forEach((p) => p.L.forEach((e) => { if (e.kind === "move" && match(e.batch)) out.push({ p, e }); }));
    return out.sort((a, b) => b.e.t - a.e.t);
  }

  function whatOf(e) {
    if (e.sub === "use") {
      return e.patientId
        ? `<a href="#/patient/${encodeURIComponent(e.patientId)}" target="_blank" rel="noopener">${esc(e.patientName || "Patient")}</a>`
        : esc(e.patientName || "Patient");
    }
    return esc({ restock: "Into their kit (restock)", borrow: `From ${e.who || "a colleague"}`, lend: `To ${e.who || "a colleague"}`,
      return: "Returned", discard: "Discarded", fix: "Correction" }[e.sub] || e.sub);
  }

  function batchHtml() {
    const hits = st.q && st.allPeople ? batchHits() : [];
    const form = `<form class="inv-tools kr-batch" data-form="batch">
        <label class="rp-from">Batch number <input class="fe-in" name="q" value="${esc(st.q)}" placeholder="e.g. 544469" autocomplete="off" /></label>
        <button type="submit" class="ff-btn">Find</button>
        <span class="inv-spacer"></span>
        ${csv && hits.length ? '<button type="button" class="ff-btn" data-act="kr-batch-csv">Export CSV</button>' : ""}
      </form>`;
    if (st.allProblem) return `${form}<p class="tb-bad rp-note">${esc(st.allProblem)}</p>`;
    if (st.loadingAll) return `${form}<p class="muted rp-note">Loading every record, old app and portal…</p>${SKEL}`;
    if (!st.q) {
      return `${form}<p class="muted rp-note">Type a batch number to see every patient treated with it and where it came into the kits.
        It covers the old app and the portal, all dates and all staff, whatever the filters on the other tabs.</p>`;
    }
    if (!hits.length) return `${form}<div class="tm-empty">Nothing found for batch ${esc(st.q)}.</div>`;

    const uses = hits.filter((h) => h.e.sub === "use");
    const pts = new Set(uses.map((h) => h.e.patientId || String(h.e.patientName || "").toLowerCase()));
    const units = r1(-uses.reduce((a, h) => a + h.e.units, 0));
    const who = uniqJoin(hits.map((h) => h.p.name));
    const exps = uniqJoin(hits.map((h) => h.e.expiry), expMY);
    const days = uses.map((h) => h.e.date).sort();
    const expired = uses.filter((h) => isExpired(h.e.expiry, h.e.date)).length;
    return `${form}
      <div class="kr-stats">
        <div class="kr-stat"><strong>${pts.size}</strong><span>patients</span></div>
        <div class="kr-stat"><strong>${fmt(units)}</strong><span>units used on patients</span></div>
        <div class="kr-stat"><strong>${days.length ? esc(shortDay(days[0])) : "—"}</strong><span>first used</span></div>
        <div class="kr-stat"><strong>${days.length ? esc(shortDay(days[days.length - 1])) : "—"}</strong><span>last used</span></div>
        <div class="kr-stat"><strong>${esc(exps || "—")}</strong><span>expiry</span></div>
      </div>
      <p class="muted rp-note">Injectors: ${esc(who)}${expired ? ` · <span class="kr-bad">${plural(expired, "treatment")} after the expiry date</span>` : ""}</p>
      <section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table kr-table">
        <thead><tr><th>Date</th><th>Time</th><th>Injector</th><th>Patient or movement</th><th>Type</th><th class="n">Units</th>
          <th>Batch</th><th>Exp Date</th></tr></thead>
        <tbody>${hits.slice(0, 500).map(({ p, e }) => `<tr>
          <td>${esc(niceDay(e.date))}</td>
          <td>${e.ms && dayKey(new Date(e.ms)) === e.date ? esc(timeOf(e.ms)) : "—"}</td>
          <td>${esc(p.name)}</td>
          <td>${whatOf(e)}</td>
          <td>${e.sub === "use" ? esc(e.type || "Treatment") : "—"}</td>
          <td class="n">${e.units > 0 ? "+" : "−"}${fmt(Math.abs(e.units))}</td>
          <td>${esc(e.batch || "—")}</td>
          <td>${esc(expMY(e.expiry) || "—")}${e.sub === "use" && isExpired(e.expiry, e.date) ? '<small class="kr-bad">expired</small>' : ""}</td></tr>`).join("")}
        </tbody></table></div>
        ${hits.length > 500 ? `<p class="muted rp-note">Showing the newest 500 of ${hits.length}. Export CSV has them all.</p>` : ""}</section>`;
  }

  /* ---------- Dosing ---------- */

  function dosingHtml() {
    const [a, b] = range();
    const groups = new Map();
    const clinic = { tx: [], tu: [], areas: {} };
    const addArea = (bag, name, u) => { const x = bag[name] || (bag[name] = { units: 0, n: 0 }); x.units += u; x.n++; };
    visible().forEach((p) => {
      const k = `${p.uid}|${p.product.id}`;
      const g = groups.get(k) || { p, tx: [], tu: [], areas: {} };
      groups.set(k, g);
      p.L.forEach((e) => {
        if (e.sub !== "use" || e.date < a || e.date > b) return;
        const u = r1(-e.units);
        const touch = /touch/i.test(e.type || "");
        (touch ? g.tu : g.tx).push(u);
        (touch ? clinic.tu : clinic.tx).push(u);
        if (touch || !e.areas) return;
        const per = {};
        String(e.areas).split(" · ").forEach((part) => {
          const m = /^(.*?)\s+([\d.]+)$/.exec(part.trim());
          if (m) per[m[1]] = (per[m[1]] || 0) + Number(m[2]);
        });
        Object.keys(per).forEach((n) => { addArea(g.areas, n, per[n]); addArea(clinic.areas, n, per[n]); });
      });
    });
    const list = [...groups.values()].filter((g) => g.tx.length || g.tu.length)
      .sort((x, y) => x.p.name.localeCompare(y.p.name, "en-AU"));
    if (!list.length) return '<div class="tm-empty">No treatments for these filters.</div>';
    const avg = (l) => (l.length ? r1(l.reduce((x, y) => x + y, 0) / l.length) : null);
    const nameOf = (g) => esc(g.p.name) + (st.product ? "" : ` <small>${esc(g.p.product.name)}</small>`);
    const cls = (v, base, n) => (v === null || base === null || n < 3 ? "" : v >= base * 1.25 ? "kr-hi" : v <= base * 0.75 ? "kr-lo" : "");
    const cTx = avg(clinic.tx), cTu = avg(clinic.tu);

    const top = `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table kr-table">
      <thead><tr><th>Injector</th><th class="n">Treatments</th><th class="n">Average units</th><th class="n">Touch ups</th><th class="n">Average touch up</th></tr></thead>
      <tbody><tr class="kr-clinic"><td><strong>Whole clinic</strong></td><td class="n">${clinic.tx.length}</td><td class="n"><strong>${cTx === null ? "—" : fmt(cTx)}</strong></td>
        <td class="n">${clinic.tu.length}</td><td class="n">${cTu === null ? "—" : fmt(cTu)}</td></tr>
      ${list.map((g) => {
        const t = avg(g.tx), u = avg(g.tu);
        return `<tr><td>${nameOf(g)}</td><td class="n">${g.tx.length}</td>
          <td class="n ${cls(t, cTx, g.tx.length)}"><strong>${t === null ? "—" : fmt(t)}</strong></td>
          <td class="n">${g.tu.length}</td><td class="n ${cls(u, cTu, g.tu.length)}">${u === null ? "—" : fmt(u)}</td></tr>`;
      }).join("")}</tbody></table></div></section>`;

    const areaNames = Object.keys(clinic.areas).filter((n) => clinic.areas[n].n >= 3)
      .sort((x, y) => clinic.areas[y].n - clinic.areas[x].n);
    const withAreas = list.filter((g) => Object.keys(g.areas).length);
    const areas = !areaNames.length ? '<p class="muted rp-note">No areas recorded for these dates.</p>'
      : `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table kr-table">
        <thead><tr><th>Area</th><th class="n">Whole clinic</th>${withAreas.map((g) => `<th class="n">${nameOf(g)}</th>`).join("")}</tr></thead>
        <tbody>${areaNames.map((n) => {
          const c = clinic.areas[n];
          const base = c.units / c.n;
          return `<tr><td>${esc(n)}</td><td class="n"><strong>${fmt(base)}</strong><small>${plural(c.n, "treatment")}</small></td>
            ${withAreas.map((g) => {
              const x = g.areas[n];
              if (!x) return '<td class="n">—</td>';
              const v = x.units / x.n;
              return `<td class="n ${cls(v, base, x.n)}">${fmt(v)}<small>${x.n}</small></td>`;
            }).join("")}</tr>`;
        }).join("")}</tbody></table></div></section>`;

    return `<h3 class="kr-sec">Units per treatment</h3>${top}
      <h3 class="kr-sec">Units per area (treatments, not touch ups)</h3>${areas}
      <p class="muted rp-note">Amber: 25% or more above the clinic's average. Blue: 25% or more below. Only shown where someone has 3 or more.
        Areas come from the old app's records; portal records don't save the area yet.</p>`;
  }

  /* ---------- Drawing and exports ---------- */

  function draw() {
    const view = st.view === "batch" ? batchHtml() : st.view === "dosing" ? toolsHtml() + dosingHtml() : toolsHtml() + daysHtml();
    body.innerHTML = tabsHtml() + (st.help ? helpHtml() : "") + view;
  }

  function exportCsv() {
    const list = rows();
    if (!list.length || !csv) return;
    const out = [["Product", "Injector", "Date", "Batch Number", "Exp Date", "Start Count", "Expected Start", "End of Count", "Total Usage",
      "Restock Record", "Checks", "Time", "Patient", "Type of Record", "Area", "Units"]];
    list.forEach((d) => {
      const b = batchesOf(d);
      const day = [d.p.product.name, d.p.name, d.date, b.map((x) => x.batch).join(", "), b.map((x) => expMY(x.expiry)).join(", "),
        d.start ? d.start.value : "", d.start && d.start.expected !== null && d.start.expected !== undefined ? d.start.expected : "",
        d.end ? d.end.value : "", d.used || "",
        d.restocks.map((e) => `+${fmt(e.units)} ${e.batch} ${expMY(e.expiry)}`.trim()).join("; "),
        checkList(d).map((f) => f.t).join("; ")];
      (d.missing || []).forEach((b) => out.push(day.concat([b.time || "", b.patientName || "", "Booked, no record", b.services.join(", "), ""])));
      if (!d.uses.length) { if (!(d.missing || []).length) out.push(day.concat(["", "", "", "", ""])); return; }
      d.uses.forEach((e) => out.push(day.concat([e.ms && dayKey(new Date(e.ms)) === e.date ? timeOf(e.ms) : "",
        e.patientName || "", e.type || "Treatment", e.areas || "", r1(-e.units)])));
    });
    csv(`kit-reconciliation-${st.from || "all"}-to-${st.to || dayKey()}.csv`, out);
  }

  function exportBatchCsv() {
    const hits = batchHits();
    if (!hits.length || !csv) return;
    const out = [["Date", "Time", "Injector", "Product", "Patient or movement", "Patient ID", "Type", "Units", "Batch", "Exp Date", "Used after expiry"]];
    hits.forEach(({ p, e }) => out.push([
      e.date, e.ms && dayKey(new Date(e.ms)) === e.date ? timeOf(e.ms) : "", p.name, p.product.name,
      e.sub === "use" ? (e.patientName || "") : whatOf(e).replace(/<[^>]+>/g, ""), e.patientId || "",
      e.sub === "use" ? (e.type || "Treatment") : "", r1(e.units), e.batch || "", expMY(e.expiry),
      e.sub === "use" && isExpired(e.expiry, e.date) ? "Yes" : "",
    ]));
    csv(`batch-${normB(st.q)}-${dayKey()}.csv`, out);
  }

  /* ---------- Events ---------- */

  body.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    if (ev.target.closest('[data-act="kr-help"]')) { st.help = !st.help; draw(); return; }
    const dd = body.querySelector(".kr-staff");
    if (dd && dd.open && !ev.target.closest(".kr-staff")) { dd.open = false; st.staffOpen = false; }

    const v = ev.target.closest("[data-view]");
    if (v) {
      st.view = v.dataset.view;
      st.staffOpen = false;
      if (st.view === "batch") loadAll();
      draw();
      return;
    }
    const only = ev.target.closest("[data-only]");
    if (only) { st.staff = new Set([only.dataset.only]); st.onlyCheck = false; st.limit = 100; draw(); return; }
    const chk = ev.target.closest("[data-check]");
    if (chk) { st.staff = new Set([chk.dataset.check]); st.onlyCheck = true; st.limit = 100; draw(); return; }

    const nn = ev.target.closest("[data-noneed]");
    if (nn) {
      const note = window.prompt("Why is no record needed? (e.g. review only, no injection given)");
      if (!note || !note.trim()) return;
      callApi({ action: "paper", op: "resolve", key: nn.dataset.noneed, status: "none", note: note.trim() })
        .then((r) => {
          if (r && r.problem) { showToast(r.problem); return; }
          delete st.book[bookKey()];
          loadOld(false);
        })
        .catch(() => showToast("Couldn't save it. You need Paper records access to mark a visit as needing no record."));
      return;
    }
    const h = ev.target.closest("[data-hist]");
    if (h) {
      const id = h.dataset.hist;
      if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
      draw();
      return;
    }
    if (ev.target.closest('[data-act="kr-staff-all"]')) {
      st.people.filter((p) => p.injector).forEach((p) => st.staff.add(p.uid));
      st.limit = 100;
      draw();
      return;
    }
    if (ev.target.closest('[data-act="kr-staff-none"]')) { st.staff.clear(); st.limit = 100; draw(); return; }
    if (ev.target.closest('[data-act="kr-more"]')) { st.limit += 100; draw(); return; }
    if (ev.target.closest('[data-act="kr-csv"]')) { exportCsv(); return; }
    if (ev.target.closest('[data-act="kr-batch-csv"]')) exportBatchCsv();
  });

  body.addEventListener("toggle", (ev) => {
    if (ev.target.classList && ev.target.classList.contains("kr-staff")) st.staffOpen = ev.target.open;
  }, true);

  body.addEventListener("submit", (ev) => {
    const form = ev.target.closest('[data-form="batch"]');
    if (!form) return;
    ev.preventDefault();
    st.q = String(form.elements.q.value || "").trim();
    if (!st.allPeople) loadAll(); else draw();
  });

  body.addEventListener("change", (ev) => {
    const uid = ev.target.dataset.staff;
    if (uid !== undefined) {
      if (ev.target.checked) st.staff.add(uid); else st.staff.delete(uid);
      st.limit = 100;
      draw();
      return;
    }
    const f = ev.target.dataset.f;
    if (f === "onlyCheck") { st.onlyCheck = ev.target.checked; st.limit = 100; draw(); return; }
    if (!["from", "to", "product"].includes(f)) return;
    st[f] = ev.target.value;
    st.limit = 100;
    if (f === "from" || f === "to") loadOld(false); else draw();
  });

  load();
}