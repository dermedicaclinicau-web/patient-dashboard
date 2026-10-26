// Reporting → Kit reconciliation → Day by day: every injector's kit, one row per day, like a ledger.
// Each row: the start count and batch in use, what came in, what was used and on how many patients, what went out,
// the end count, and any difference with its likely cause. Details opens the day: every entry, who each unit was used on.
// Each count resets the running balance; the difference is the count minus the balance just before it.
// Portal: Start / End of Day, kit activity, units taken between colleagues, treatment records.
// Old app: StartOfDayLog and its Wrinkle Relaxer records (Apps Script: op "oldKitLedgerAll").
import { listUsageByStaff, listKitDaysFor, dayKey, plural } from "./inventory-api.js";
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const fmt = (n) => String(r1(n));
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const niceDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : k; };
const shortDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : k; };
const timeOf = (ms) => new Date(ms).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const msOf = (d) => (d instanceof Date && !isNaN(d) ? d.getTime() : null);
const keyOf = (d) => (d instanceof Date && !isNaN(d) ? dayKey(d) : "");
const normB = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const expMY = (s) => { const m = /^(\d{4})-(\d{2})/.exec(s || ""); return m ? `${m[2]}/${m[1]}` : String(s || ""); };
const daysBetween = (a, b) => { const x = keyDate(a), y = keyDate(b); return x && y ? Math.round((y - x) / 864e5) : 0; };
const atTime = (key, hhmm) => {
  const d = keyDate(key);
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!d || !m) return null;
  d.setHours(+m[1], +m[2], 0, 0);
  return d.getTime();
};
const uniqJoin = (list, map = (x) => x) => [...new Set(list.filter(Boolean).map(map))].join(", ");
const SKEL = '<div class="skeleton" style="height:240px;border-radius:14px"></div>';
const RANGES = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["all", "All dates"], ["custom", "Choose dates"]];

/* ---------- Entries ----------
   { src, date, ms, ord (0 counts at the start of a day, 1 activity, 2 end of day), kind: count | move | info,
     cat: start | end | set | in | out | use, units (moves: + in, − out), value (counts), counts (false: not the kit),
     voided, label, batch, expiry, batches (counts), patientName, patientId, submissionId, formName, recordId,
     areas, type, note, status, short, corrected, paper, from } */

function portalEntries({ uid, product, moves, loans, usage, days }) {
  const pid = product.id;
  const per = Number(product.dosePer) || 0;
  const vial = product.stockUnit || "vial";
  const out = [];
  const add = (e) => { if (e.date) out.push({ src: "portal", ord: 1, counts: true, ...e }); };

  moves.forEach((m) => {
    if (m.productId !== pid || (m.byUid !== uid && m.staffUid !== uid)) return;
    const kl = (m.lines || []).filter((l) => l.loc === "kit");
    const kd = kl.reduce((a, l) => a + (Number(l.delta) || 0), 0);
    const b = kl[0] || {};
    const base = { ms: msOf(m.at), date: m.effectiveDate || keyOf(m.at), batch: b.batch || "", expiry: b.expiry || "" };
    if (m.type === "kit-take" && m.byUid === uid) {
      add({ ...base, kind: "move", cat: "in", units: Math.abs(kd) * per, label: `Restock: taken from the Shelf (${plural(Math.abs(kd), vial)})` });
    } else if (m.type === "kit-return" && m.byUid === uid) {
      add({ ...base, kind: "move", cat: "out", units: -Math.abs(kd) * per, label: `Returned to the Shelf (${plural(Math.abs(kd), vial)})` });
    } else if (m.type === "kit-discard" && m.byUid === uid) {
      const du = Number(m.discardUnits);
      const units = Number.isFinite(du) ? du : Math.abs(kd) * per;
      if (units) add({ ...base, kind: "move", cat: "out", units: -units, label: `Thrown away${m.reason ? `: ${m.reason}` : ""}`, note: m.note || "" });
    } else if (m.type === "kit-count" && m.staffUid === uid) {
      const after = Number((/→\s*([\d.]+)/.exec(m.note || "") || [])[1]);
      if (/Kit set by admin/i.test(m.reason || "") && Number.isFinite(after)) {
        add({ ...base, kind: "count", cat: "set", ord: 0, value: r1(after), label: `Kit set by ${m.by || "an admin"}`, note: m.note || "" });
      } else {
        add({ ...base, kind: "info", label: `Count difference accepted by ${m.by || "an admin"}`,
          note: `The system was adjusted by ${signed(Number(m.deltaUnits) || 0)} units to match a count. It isn't counted again here.` });
      }
    } else if (m.type === "kit-correct" && m.staffUid === uid && kd) {
      add({ ...base, kind: "move", cat: kd < 0 ? "use" : "in", units: kd, label: `Usage corrected by ${m.by || "an admin"}`, note: m.note || "" });
    }
  });

  loans.forEach((l) => {
    if (l.productId !== pid) return;
    const u = r1(l.units);
    if (!u) return;
    const base = { ms: msOf(l.createdAt), date: keyOf(l.createdAt), batch: l.batch || "", expiry: l.expiry || "",
      status: l.status === "disputed" ? "Disputed" : l.status === "unconfirmed" ? "Waiting for confirmation" : "" };
    if (l.toUid === uid) add({ ...base, kind: "move", cat: "in", units: u, label: `Taken from ${l.fromName || "a colleague"}'s opened vial` });
    if (l.fromUid === uid) add({ ...base, kind: "move", cat: "out", units: -u, label: `Taken by ${l.toName || "a colleague"}` });
  });

  usage.forEach((u) => (u.lines || []).forEach((l) => {
    if (l.productId !== pid || (l.kind !== "kit" && l.kind !== "vial")) return;
    const total = r1(l.total);
    if (!total) return;
    const rows = l.rows || [];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(u.recordDate || "") ? u.recordDate : keyOf(u.at);
    add({
      ms: keyOf(u.at) === date ? msOf(u.at) : null, date, kind: "move", cat: "use", units: -total, counts: l.kind === "kit",
      patientName: u.patientName || "", patientId: u.patientId || "", submissionId: u.submissionId || "",
      formName: u.formName || "", paper: /paper/i.test(u.source || ""), corrected: u.corrected === true, short: r1(l.short),
      batch: uniqJoin(rows.map((r) => r.batch)), expiry: uniqJoin(rows.map((r) => r.expiry), expMY),
      from: l.kind === "vial" ? ((rows[0] || {}).from === "shelf" ? "the Shelf" : "JT storage") : "",
    });
  }));

  days.forEach((d) => {
    const s = d.start, e = d.end;
    if (s && s.notInjecting) add({ ms: msOf(s.at), date: d.dateKey, kind: "info", label: "Start of day: not injecting today" });
    const si = s && !s.notInjecting ? (s.items || []).find((it) => it.productId === pid) : null;
    if (si) {
      add({ ms: msOf(s.at), date: d.dateKey, kind: "count", cat: "start", ord: 0, value: r1(si.counted),
        label: s.correctedAt ? "Start of day count (corrected)" : "Start of day count",
        batches: (si.rows || []).map((r) => ({ batch: r.batch, expiry: r.expiry, units: r.units, inUse: r.inUse })),
        note: (si.unknown || []).length ? `${plural(si.unknown.length, "batch")} counted that weren't in the kit records` : "" });
    }
    const ei = e ? (e.items || []).find((it) => it.productId === pid) : null;
    if (ei) {
      add({ ms: msOf(e.at), date: d.dateKey, kind: "count", cat: "end", ord: 2, value: r1(ei.counted), label: "End of day count",
        batches: (ei.rows || []).map((r) => ({ batch: r.batch, expiry: r.expiry, units: r.units })) });
    }
  });
  return out;
}

function oldEntries(data) {
  const out = [];
  const add = (e) => { if (e.date) out.push({ src: "old", ord: 1, counts: true, ...e }); };
  const clean = (s) => (s && s !== "N/A" ? String(s) : "");
  const counts = {};
  (data.rows || []).forEach((r) => {
    const base = { ms: r.at || null, date: r.date, batch: clean(r.batch), expiry: clean(r.expiry), note: r.note || "" };
    if (r.kind === "SOD" || r.kind === "EOD") {
      // One count per day: a batch counted twice keeps the later count, different batches add up
      const c = counts[`${r.date}|${r.kind}`] || (counts[`${r.date}|${r.kind}`] = { date: r.date, kind: r.kind, ms: null, by: {} });
      const bk = normB(base.batch) || `row${Object.keys(c.by).length}`;
      const prev = c.by[bk];
      if (!prev || (r.at || 0) >= prev.at) c.by[bk] = { batch: base.batch, expiry: base.expiry, units: r.count, at: r.at || 0 };
      if (r.at && (!c.ms || r.at < c.ms)) c.ms = r.at;
    } else if (r.kind === "RESTOCK") {
      add({ ...base, kind: "move", cat: "in", units: r.count, voided: r.voided === true,
        label: r.voided ? "Restock (voided, not counted)" : "Restock: new vial" });
    } else if (r.kind === "BORROW-IN") {
      add({ ...base, kind: "move", cat: "in", units: r.count, label: "Taken from a colleague" });
    } else if (r.kind === "BORROW-OUT") {
      add({ ...base, kind: "move", cat: "out", units: -r.count, label: "Taken by a colleague" });
    } else if (r.kind === "VOID") {
      add({ ...base, kind: "info", label: "Voided an earlier entry" });
    }
  });
  Object.values(counts).forEach((c) => {
    const list = Object.values(c.by);
    const sod = c.kind === "SOD";
    add({ ms: c.ms, date: c.date, kind: "count", cat: sod ? "start" : "end", ord: sod ? 0 : 2,
      value: r1(list.reduce((a, x) => a + (Number(x.units) || 0), 0)),
      label: sod ? "Start of day count" : "End of day count", batches: list });
  });
  (data.records || []).forEach((w) => {
    const lines = w.lines || [];
    add({ ms: atTime(w.date, w.time), date: w.date, kind: "move", cat: "use", units: -r1(w.units),
      patientName: w.patientName || "", recordId: w.recordId || "", formName: "Wrinkle Relaxer record",
      areas: lines.map((d) => `${d.area || "Area"} ${fmt(d.units)}`).join(" · "),
      type: uniqJoin(lines.map((d) => d.type)),
      batch: uniqJoin(lines.map((d) => d.batch)), expiry: uniqJoin(lines.map((d) => d.expiry), expMY) });
  });
  return out;
}

// Puts the entries in order and runs the balance. Each count resets it.
function buildLedger(entries) {
  const tOf = (e) => {
    if (e.ms !== null && e.ms !== undefined && dayKey(new Date(e.ms)) === e.date) return e.ms;
    const d = keyDate(e.date);
    return (d ? d.getTime() : 0) + (e.ord === 0 ? 0 : e.ord === 2 ? 86399000 : 43200000);
  };
  entries.forEach((e) => { e.t = tOf(e); });
  entries.sort((a, b) => a.t - b.t || a.ord - b.ord);
  let bal = null, prev = null, since = [];
  entries.forEach((e) => {
    if (e.kind === "count") {
      e.expected = bal;
      e.diff = bal === null ? null : r1(e.value - bal);
      e.prev = prev;
      e.period = since;
      bal = e.value;
      prev = e;
      since = [];
    } else {
      since.push(e);
      if (e.kind === "move" && e.counts !== false && !e.voided && bal !== null) bal = r1(bal + e.units);
    }
    e.balance = bal;
  });
  return entries;
}

const isDiff = (e) => e.kind === "count" && e.diff !== null && Math.abs(e.diff) >= 0.05;
const inKit = (e) => e.kind === "move" && e.counts !== false && !e.voided;

function groupDays(entries) {
  const m = new Map();
  entries.forEach((e) => { const d = m.get(e.date) || { date: e.date, list: [] }; d.list.push(e); m.set(e.date, d); });
  return [...m.values()].map((d) => {
    const L = d.list;
    const uses = L.filter((e) => inKit(e) && e.cat === "use");
    const diffs = L.filter(isDiff);
    return {
      ...d,
      start: L.find((e) => e.kind === "count" && e.cat !== "end") || null,
      end: [...L].reverse().find((e) => e.cat === "end") || null,
      inn: r1(L.filter((e) => inKit(e) && e.units > 0).reduce((a, e) => a + e.units, 0)),
      out: r1(-L.filter((e) => inKit(e) && e.units < 0 && e.cat !== "use").reduce((a, e) => a + e.units, 0)),
      used: r1(-uses.reduce((a, e) => a + e.units, 0)),
      patients: new Set(uses.filter((e) => e.patientName).map((e) => e.patientName.toLowerCase().trim())).size,
      counted: L.some((e) => e.kind === "count" && e.diff !== null),
      hasDiff: diffs.length > 0, diff: r1(diffs.reduce((a, e) => a + e.diff, 0)),
      close: L[L.length - 1].balance,
    };
  });
}

// The likely reasons for a difference at a count. P: { unit, per }
function causes(e, P) {
  const { unit, per } = P;
  const diff = e.diff;
  const abs = Math.abs(diff);
  const near = (a, b) => Math.abs(a - b) < 0.6;
  const period = e.period || [];
  const moved = period.filter(inKit);
  const uses = moved.filter((x) => x.cat === "use" && !x.label);
  const out = [];
  const vials = per ? Math.round(abs / per) : 0;
  if (vials >= 1 && near(abs, vials * per)) {
    out.push(diff < 0
      ? `Exactly ${plural(vials, "vial")} less (${fmt(vials * per)} ${unit}): a vial returned, thrown away or taken by a colleague may not have been logged.`
      : `Exactly ${plural(vials, "vial")} more (${fmt(vials * per)} ${unit}): a restock, or a vial from a colleague, may not have been logged.`);
  }
  const same = uses.find((x) => near(-x.units, abs));
  if (same) {
    out.push(diff > 0
      ? `Same as ${same.patientName || "a patient"}'s treatment on ${shortDay(same.date)} (${fmt(-same.units)} ${unit}): that record may be under the wrong injector or date, saved twice, or have the wrong amount.`
      : `About one treatment's worth (like ${same.patientName || "a patient"}'s ${fmt(-same.units)} ${unit}): a treatment may not have been recorded.`);
  }
  if (diff < 0 && !uses.length) {
    out.push("Units went down but there are no treatment records since the last count: a treatment may not have been recorded, or was recorded under another injector.");
  }
  const fromStore = period.filter((x) => x.cat === "use" && x.counts === false);
  if (diff < 0 && fromStore.length) {
    out.push(`${plural(fromStore.length, "treatment")} in this time came from an opened vial in storage, not the kit. If the units really came from the kit, that explains it.`);
  }
  if (e.prev && (e.batches || []).length && (e.prev.batches || []).length) {
    const had = new Set(e.prev.batches.map((b) => normB(b.batch)).filter(Boolean));
    const cameIn = new Set(moved.filter((x) => x.units > 0).flatMap((x) => String(x.batch || "").split(",").map(normB)).filter(Boolean));
    const fresh = e.batches.map((b) => b.batch).filter((b) => normB(b) && !had.has(normB(b)) && !cameIn.has(normB(b)));
    if (fresh.length) out.push(`Batch ${fresh.join(", ")} was counted, but it wasn't in the last count and no restock of it was logged.`);
  }
  if (!out.length) {
    out.push(diff < 0
      ? "Less than expected: look for a treatment not recorded, units thrown away, or units a colleague took without logging it."
      : "More than expected: units came in without being logged (a restock or a colleague's units), or a treatment record has more units than were used.");
  }
  const gap = e.prev ? daysBetween(e.prev.date, e.date) : 0;
  if (gap > 1) out.push(`${gap} days since the last count (${shortDay(e.prev.date)}): the difference could be from any day in between.`);
  return out;
}

// One entry in a day's details
function entryHtml(e, P) {
  const { unit } = P;
  const t = e.ms && dayKey(new Date(e.ms)) === e.date ? timeOf(e.ms) : "";
  const bex = [e.batch, e.expiry ? `Exp ${expMY(e.expiry)}` : ""].filter(Boolean).join(" · ");
  if (e.kind === "count") {
    const bad = isDiff(e);
    const batches = (e.batches || []).filter((b) => b.batch || b.units).map((b) => [b.batch || "No number",
      b.expiry ? `Exp ${expMY(b.expiry)}` : "", b.units !== undefined && b.units !== null ? `${fmt(b.units)} ${unit}` : "",
      b.inUse ? "in use" : ""].filter(Boolean).join(" · "));
    const check = e.diff === null ? "<small>The ledger starts from this count.</small>"
      : `<small class="${bad ? "kl-bad" : "kl-ok"}">Expected ${fmt(e.expected)} · ${bad ? `difference ${signed(e.diff)} ${esc(unit)}` : "matches ✓"}${
        e.prev ? ` · since ${esc(shortDay(e.prev.date))}` : ""}</small>`;
    return `<tr class="is-count${bad ? " is-bad" : ""}"><td>${esc(t)}</td>
        <td><strong>${esc(e.label)}</strong>${check}${e.note ? `<small>${esc(e.note)}</small>` : ""}</td>
        <td>${batches.length ? batches.map((x) => `<small>${esc(x)}</small>`).join("") : "—"}</td>
        <td class="n"></td><td class="n"></td><td class="n"><strong>${fmt(e.value)}</strong></td></tr>
      ${bad ? `<tr class="kl-why"><td></td><td colspan="5"><strong>Possible causes</strong><ul>${causes(e, P).map((c) => `<li>${esc(c)}</li>`).join("")}</ul></td></tr>` : ""}`;
  }
  const off = e.kind === "info" || e.counts === false || e.voided;
  let what;
  if (e.cat === "use" && !e.label) {
    const who = e.patientId
      ? `<a href="#/patient/${encodeURIComponent(e.patientId)}" target="_blank" rel="noopener">${esc(e.patientName || "a patient")}</a>`
      : `<strong>${esc(e.patientName || "a patient")}</strong>`;
    const form = e.submissionId
      ? `<a href="#/form-record/${encodeURIComponent(e.submissionId)}" target="_blank" rel="noopener">${esc(e.formName || "Treatment record")}</a>`
      : esc(e.formName || "");
    const details = [esc(e.areas || ""), esc(e.type || ""), form, esc(e.recordId || "")].filter(Boolean).join(" · ");
    const flags = [e.paper ? "From a paper record" : "", e.corrected ? "Corrected" : "",
      e.short > 0 ? `Saved short by ${fmt(e.short)}` : "", e.from ? `From ${e.from}'s opened vial, not the kit` : ""].filter(Boolean);
    what = `Used on ${who}${details ? `<small>${details}</small>` : ""}${flags.length ? `<small class="kl-flag">${esc(flags.join(" · "))}</small>` : ""}`;
  } else {
    what = `${esc(e.label || "")}${e.status ? `<small class="kl-flag">${esc(e.status)}</small>` : ""}${e.note ? `<small>${esc(e.note)}</small>` : ""}`;
  }
  const mv = e.kind === "move";
  return `<tr class="${off ? "is-muted" : ""}"><td>${esc(t)}</td><td>${what}</td><td>${esc(bex || "—")}</td>
    <td class="n">${mv && e.units > 0 ? `+${fmt(e.units)}` : ""}</td>
    <td class="n">${mv && e.units < 0 ? fmt(-e.units) : ""}</td>
    <td class="n">${off || e.balance === null ? "" : fmt(e.balance)}</td></tr>`;
}

/* ---------- The Day by day view ----------
   injectors: [{ uid, name, portal: row | null, old: row | null }] (rows from the Kit reconciliation table)
   source: "portal" | "old" | "both". cache: kept by the caller, so switching views doesn't load it again
   ({ fresh: true } reloads the old app). onFocus(uid): the injector chosen here. */
export function mountKitDays(host, { injectors = [], products = [], moves = [], loans = [], source = "both", focus = "",
  cache = {}, csv = null, onFocus = null } = {}) {
  const srcs = source === "both" ? ["portal", "old"] : [source];
  const st = { focus: injectors.some((x) => x.uid === focus) ? focus : "", range: focus ? "all" : "30", from: "", to: "",
    diffOnly: false, limit: 60, open: new Set(), seq: 0, problem: "" };
  const row0 = injectors.map((x) => x.portal || x.old).find(Boolean);
  const product = (row0 && products.find((p) => p.id === row0.productId)) || products.find((p) => p.usage === "kit")
    || { id: "", name: "Xeomin", doseUnit: "units", dosePer: 100, stockUnit: "vial" };
  const P = { unit: product.doseUnit || "units", per: Number(product.dosePer) || 0 };
  const ck = (src, uid) => `${src === "old" ? "o" : "p"}:${uid}`;

  host.innerHTML = '<div class="inv-tools kd2-tools" data-role="tools"></div><div data-role="out"></div>';
  const tools = host.querySelector('[data-role="tools"]');
  const out = host.querySelector('[data-role="out"]');

  const bounds = () => {
    const today = dayKey();
    if (["7", "30", "90"].includes(st.range)) {
      const d = new Date();
      d.setDate(d.getDate() - Number(st.range) + 1);
      return [dayKey(d), today];
    }
    if (st.range === "custom") return [st.from || "0000-00-00", st.to || today];
    return ["0000-00-00", "9999-99-99"];
  };
  const inRange = (e) => { const [a, b] = bounds(); return e.date >= a && e.date <= b; };

  function drawTools() {
    tools.innerHTML = `
      <select class="fb-select" data-f="who" aria-label="Injector">
        <option value="">All injectors</option>
        ${injectors.map((x) => `<option value="${esc(x.uid)}"${st.focus === x.uid ? " selected" : ""}>${esc(x.name)}</option>`).join("")}
      </select>
      <select class="fb-select" data-f="range" aria-label="Dates">${RANGES.map(([v, l]) =>
        `<option value="${v}"${st.range === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      ${st.range === "custom" ? `<label class="rp-from">From <input class="fe-in" type="date" data-f="from" value="${esc(st.from)}" /></label>
        <label class="rp-from">To <input class="fe-in" type="date" data-f="to" value="${esc(st.to)}" /></label>` : ""}
      <label class="fe-check"><input type="checkbox" data-f="diff"${st.diffOnly ? " checked" : ""} /> Only days with a difference</label>
      <span class="inv-spacer"></span>
      ${csv ? '<button type="button" class="ff-btn" data-kd="csv">Export CSV</button>' : ""}`;
  }

  async function load() {
    const my = ++st.seq;
    out.innerHTML = SKEL;
    st.problem = "";
    const fresh = cache.fresh === true;
    delete cache.fresh;
    const jobs = [];
    if (srcs.includes("old") && !cache.old) {
      jobs.push(callApi({ action: "inventory", op: "oldKitLedgerAll", fresh })
        .then((r) => {
          if (r && r.problem) throw new Error(r.problem);
          cache.old = new Map(((r && r.people) || []).map((p) => [p.key, p]));
        })
        .catch((e) => { st.problem = `Old app: ${(e && e.message) || "couldn't be read."}`; }));
    }
    if (srcs.includes("portal")) {
      injectors.filter((x) => x.portal && !cache[ck("portal", x.uid)]).forEach((x) => {
        jobs.push(Promise.all([listUsageByStaff(x.uid), listKitDaysFor(x.uid)])
          .then(([usage, days]) => {
            cache[ck("portal", x.uid)] = buildLedger(portalEntries({ uid: x.uid, product, moves, loans, usage, days }));
          })
          .catch((e) => {
            console.error("Kit days failed for", x.name, e);
            st.problem = `Couldn't load ${x.name}'s portal records${e && e.code === "permission-denied" ? " (no access)" : ""}.`;
          }));
      });
    }
    await Promise.all(jobs);
    if (cache.old) {
      injectors.forEach((x) => {
        const k = ck("old", x.uid);
        if (x.old && !cache[k]) { const p = cache.old.get(x.uid); cache[k] = p ? buildLedger(oldEntries(p)) : []; }
      });
    }
    if (my === st.seq && host.isConnected) draw();
  }

  function allDays() {
    const list = [];
    injectors.forEach((x) => {
      if (st.focus && x.uid !== st.focus) return;
      srcs.forEach((src) => {
        if (!x[src]) return;
        const L = cache[ck(src, x.uid)];
        if (!L) return;
        groupDays(L.filter(inRange)).forEach((d) => list.push({ ...d, uid: x.uid, name: x.name, src, id: `${src}|${x.uid}|${d.date}` }));
      });
    });
    return list.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, "en-AU")
      || Number(a.src === "old") - Number(b.src === "old"));
  }

  function rowHtml(d) {
    const open = st.open.has(d.id);
    const cnt = (c) => (!c ? "—" : `<strong>${fmt(c.value)}</strong>${isDiff(c)
      ? `<small class="kl-bad">expected ${fmt(c.expected)} · ${signed(c.diff)}</small>`
      : c.diff === null ? "<small>first count</small>" : '<small class="kl-ok">matches</small>'}`);
    const b = (d.start && d.start.batches) || [];
    const used = b.filter((x) => x.inUse);
    const list = (used.length ? used : b).filter((x) => x.batch);
    const batch = list.length
      ? list.slice(0, 2).map((x) => `<div>${esc(x.batch)}${x.expiry ? ` <small>Exp ${esc(expMY(x.expiry))}</small>` : ""}</div>`).join("")
        + (list.length > 2 ? `<small>+${list.length - 2} more</small>` : "")
      : "—";
    const bad = d.list.find(isDiff);
    const why = bad ? causes(bad, P)[0] : "";
    const end = d.end ? cnt(d.end)
      : d.close !== null && d.close !== undefined ? `<span class="muted">${fmt(d.close)}</span><small>balance, not counted</small>` : "—";
    return `<tr class="kd2-row${d.hasDiff ? " is-diff" : ""}${open ? " is-open" : ""}" data-day="${esc(d.id)}">
        <td><strong>${esc(niceDay(d.date))}</strong></td>
        <td>${esc(d.name)} <span class="inv-flag ${d.src === "old" ? "is-info" : "is-ok"}">${d.src === "old" ? "Old app" : "Portal"}</span></td>
        <td>${batch}</td>
        <td>${cnt(d.start)}</td>
        <td class="n">${d.inn ? `+${fmt(d.inn)}` : "—"}</td>
        <td class="n">${d.used ? `<strong>${fmt(d.used)}</strong><small>${plural(d.patients, "patient")}</small>` : "—"}</td>
        <td class="n">${d.out ? fmt(d.out) : "—"}</td>
        <td>${end}</td>
        <td>${d.hasDiff ? `<strong class="rp-neg">${signed(d.diff)}</strong>` : d.counted ? '<span class="rp-ok">✓</span>' : "—"}</td>
        <td class="kd2-why">${why ? `<small>${esc(why)}</small>` : ""}</td>
        <td><button type="button" class="lh-btn" data-open="${esc(d.id)}">${open ? "Hide" : "Details"}</button></td></tr>
      ${open ? `<tr class="rp-sub"><td colspan="11"><div class="kd2-detail"><table class="inv-table kl-table">
        <thead><tr><th class="kl-t">Time</th><th>What happened</th><th>Batch / expiry</th><th class="n">In</th><th class="n">Out</th><th class="n">Balance</th></tr></thead>
        <tbody>${d.list.map((e) => entryHtml(e, P)).join("")}</tbody></table></div></td></tr>` : ""}`;
  }

  function draw() {
    const days = allDays();
    const shown = st.diffOnly ? days.filter((d) => d.hasDiff) : days;
    const bad = days.filter((d) => d.hasDiff);
    const net = r1(bad.reduce((a, d) => a + d.diff, 0));
    const left = shown.length - st.limit;
    out.innerHTML = `
      ${st.problem ? `<p class="tb-bad rp-note">${esc(st.problem)}</p>` : ""}
      <div class="inv-stats">
        <div class="inv-stat"><strong>${days.length}</strong><span>Injector days</span></div>
        <div class="inv-stat"><strong>${days.filter((d) => d.counted).length}</strong><span>Days with a count</span></div>
        <div class="inv-stat ${bad.length ? "is-bad" : ""}"><strong>${bad.length}</strong><span>With a difference${bad.length ? ` (${signed(net)} ${esc(P.unit)})` : ""}</span></div>
        <div class="inv-stat"><strong>${fmt(days.reduce((a, d) => a + d.used, 0))}</strong><span>${esc(P.unit)} used on records</span></div>
      </div>
      ${shown.length ? `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table kd2-table">
        <thead><tr><th>Date</th><th>Injector</th><th>Batch in use</th><th>Start</th><th class="n">In</th><th class="n">Used</th>
          <th class="n">Out</th><th>End</th><th>Difference</th><th>Likely cause</th><th></th></tr></thead>
        <tbody>${shown.slice(0, st.limit).map(rowHtml).join("")}</tbody></table></div>
        ${left > 0 ? `<button type="button" class="ff-btn kl-more" data-kd="more">Show ${Math.min(60, left)} more days (${left} left)</button>` : ""}
        </section>`
        : `<div class="tm-empty">${st.diffOnly ? "No days with a difference in these dates. 👍" : "Nothing recorded in these dates."}</div>`}`;
  }

  function exportCsv() {
    const days = allDays().filter((d) => !st.diffOnly || d.hasDiff);
    if (!days.length || !csv) return;
    const v = (c, k) => (c && c[k] !== null && c[k] !== undefined ? c[k] : "");
    csv(`kit-day-by-day-${dayKey()}.csv`, [
      ["Date", "Injector", "Source", "Batch in use", "Start count", "Start expected", "Start difference", "In", "Used", "Patients",
        "Out", "End count", "End expected", "End difference", "Difference", "Likely cause"],
      ...days.map((d) => {
        const b = ((d.start && d.start.batches) || []).filter((x) => x.batch);
        const bad = d.list.find(isDiff);
        return [d.date, d.name, d.src === "old" ? "Old app" : "Portal",
          b.map((x) => `${x.batch}${x.expiry ? ` (${expMY(x.expiry)})` : ""}`).join(", "),
          v(d.start, "value"), v(d.start, "expected"), v(d.start, "diff"), d.inn || "", d.used || "", d.patients || "",
          d.out || "", v(d.end, "value"), v(d.end, "expected"), v(d.end, "diff"), d.hasDiff ? d.diff : "",
          bad ? causes(bad, P).join(" ") : ""];
      }),
    ]);
  }

  host.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    const k = ev.target.closest("[data-kd]");
    if (k) {
      if (k.dataset.kd === "more") { st.limit += 60; draw(); }
      else if (k.dataset.kd === "csv") exportCsv();
      return;
    }
    const row = ev.target.closest("[data-open], tr.kd2-row");
    if (!row) return;
    const id = row.dataset.open || row.dataset.day;
    if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
    draw();
  });
  host.addEventListener("change", (ev) => {
    const f = ev.target.dataset.f;
    if (f === "who") { st.focus = ev.target.value; st.limit = 60; if (onFocus) onFocus(st.focus); draw(); }
    else if (f === "range") { st.range = ev.target.value; st.limit = 60; drawTools(); draw(); }
    else if (f === "from" || f === "to") { st[f] = ev.target.value; draw(); }
    else if (f === "diff") { st.diffOnly = ev.target.checked; st.limit = 60; draw(); }
  });

  drawTools();
  load();
}