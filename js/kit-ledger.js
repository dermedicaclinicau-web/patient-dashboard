// Reporting → Kit reconciliation → History: one injector's kit, day by day, like a ledger.
// Every count (start and end of day), everything that came in or went out, and who each unit was used on.
// The running balance is checked at every count; a difference shows with its likely causes.
// Portal: Start / End of Day, kit activity, units taken between colleagues, treatment records.
// Old app: StartOfDayLog and its Wrinkle Relaxer records (read by Apps Script: op "oldKitLedger").
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
const RANGES = [["all", "All dates"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["custom", "Choose dates"]];

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

// Puts the entries in order and runs the balance. Each count resets it; the difference is the count minus the balance.
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
  }).reverse();
}

/* ---------- The dialog ---------- */
// rows: [{ src: "portal" | "old", row }] for one injector (rows from the Kit reconciliation table)
export function openKitLedger({ rows, start = "portal", products = [], moves = [], loans = [], csv = null }) {
  if (!rows || !rows.length) return;
  const pick = (src) => (rows.find((x) => x.src === src) || rows[0]).row;
  const st = { src: rows.some((x) => x.src === start) ? start : rows[0].src, range: "all", from: "", to: "",
    diffOnly: false, limit: 30, data: {}, seq: 0 };
  const first = pick(st.src);
  const product = products.find((p) => p.id === first.productId)
    || { id: first.productId || "", name: first.productName || "Xeomin", doseUnit: first.unit || "units", dosePer: 100, stockUnit: "vial" };
  const unit = product.doseUnit || "units";
  const per = Number(product.dosePer) || 0;

  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog kl-dlg";
  dlg.innerHTML = `<div class="kl-wrap">
    <div class="kl-head"><div><h3>${esc(first.staffName)} · ${esc(product.name)}</h3>
      <p class="muted">Day by day: every count, everything in and out, and who each unit was used on.</p></div>
      <span class="inv-spacer"></span><button type="button" class="hx-x" data-act="close" aria-label="Close">×</button></div>
    <div class="kl-tools" data-role="tools"></div>
    <div class="kl-body" data-role="body"><div class="skeleton sm"></div></div></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  const tools = dlg.querySelector('[data-role="tools"]');
  const body = dlg.querySelector('[data-role="body"]');

  const bounds = () => {
    const today = dayKey();
    if (st.range === "30" || st.range === "90") {
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
      ${rows.length > 1 ? `<div class="fe-seg">${rows.map((x) => `<label class="fe-seg-btn"><input type="radio" name="kl-src" data-f="src"
        value="${x.src}"${st.src === x.src ? " checked" : ""} /><span>${x.src === "old" ? "Old app" : "Portal"}</span></label>`).join("")}</div>` : ""}
      <select class="fb-select" data-f="range" aria-label="Dates">${RANGES.map(([v, l]) =>
        `<option value="${v}"${st.range === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      ${st.range === "custom" ? `<label class="rp-from">From <input class="fe-in" type="date" data-f="from" value="${esc(st.from)}" /></label>
        <label class="rp-from">To <input class="fe-in" type="date" data-f="to" value="${esc(st.to)}" /></label>` : ""}
      <label class="fe-check"><input type="checkbox" data-f="diff"${st.diffOnly ? " checked" : ""} /> Only days with a difference</label>
      <span class="inv-spacer"></span>
      ${csv ? '<button type="button" class="ff-btn" data-act="csv">Export CSV</button>' : ""}`;
  }

  async function load() {
    const my = ++st.seq;
    const src = st.src;
    if (!st.data[src]) {
      body.innerHTML = '<div class="skeleton sm"></div>';
      try {
        const row = pick(src);
        let entries;
        if (src === "old") {
          const r = await callApi({ action: "inventory", op: "oldKitLedger",
            names: row.oldNames && row.oldNames.length ? row.oldNames : [row.staffName] });
          if (r && r.problem) throw new Error(r.problem);
          entries = oldEntries(r || {});
        } else {
          const [usage, days] = await Promise.all([listUsageByStaff(row.uid), listKitDaysFor(row.uid)]);
          entries = portalEntries({ uid: row.uid, product, moves, loans, usage, days });
        }
        st.data[src] = buildLedger(entries);
      } catch (err) {
        console.error("Kit ledger failed:", err);
        if (my === st.seq && dlg.isConnected) {
          body.innerHTML = `<div class="tm-empty is-error">${esc(err && err.code === "permission-denied"
            ? "You don't have access to these records." : (err && err.message) || "Couldn't load the ledger. Try again.")}</div>`;
        }
        return;
      }
    }
    if (my === st.seq && dlg.isConnected) draw();
  }

  function summary(list) {
    const counts = list.filter((e) => e.kind === "count");
    const diffs = counts.filter(isDiff);
    const uses = list.filter((e) => inKit(e) && e.cat === "use" && !e.label);
    return {
      counts: counts.length, diffs: diffs.length, net: r1(diffs.reduce((x, e) => x + e.diff, 0)),
      inn: r1(list.filter((e) => inKit(e) && e.units > 0).reduce((x, e) => x + e.units, 0)),
      out: r1(-list.filter((e) => inKit(e) && e.units < 0 && e.cat !== "use").reduce((x, e) => x + e.units, 0)),
      used: r1(-list.filter((e) => inKit(e) && e.cat === "use").reduce((x, e) => x + e.units, 0)),
      records: uses.length, patients: new Set(uses.filter((e) => e.patientName).map((e) => e.patientName.toLowerCase().trim())).size,
      notKit: r1(-list.filter((e) => e.cat === "use" && e.counts === false).reduce((x, e) => x + e.units, 0)),
    };
  }

  const statsHtml = (s) => `<div class="inv-stats">
      <div class="inv-stat"><strong>${s.counts}</strong><span>Counts</span></div>
      <div class="inv-stat ${s.diffs ? "is-bad" : ""}"><strong>${s.diffs}</strong><span>With a difference${s.diffs ? ` (${signed(s.net)} ${esc(unit)})` : ""}</span></div>
      <div class="inv-stat"><strong>+${fmt(s.inn)}</strong><span>In (restocks, from colleagues)${s.out ? ` · out ${fmt(s.out)}` : ""}</span></div>
      <div class="inv-stat"><strong>${fmt(s.used)}</strong><span>${esc(unit)} used · ${plural(s.records, "record")}, ${plural(s.patients, "patient")}</span></div>
    </div>
    ${s.notKit ? `<p class="muted rp-note">Also ${fmt(s.notKit)} ${esc(unit)} from opened vials in storage (not the kit). They're shown greyed and don't change the kit balance.</p>` : ""}`;

  // The likely reasons for a difference at a count
  function causes(e) {
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

  function entryHtml(e) {
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
        ${bad ? `<tr class="kl-why"><td></td><td colspan="5"><strong>Possible causes</strong><ul>${causes(e).map((c) => `<li>${esc(c)}</li>`).join("")}</ul></td></tr>` : ""}`;
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

  function dayHtml(d) {
    const chip = (t, cls = "") => `<span class="kl-chip ${cls}">${t}</span>`;
    const chips = [
      d.start ? chip(`Start <b>${fmt(d.start.value)}</b>`) : "",
      d.inn ? chip(`In <b>+${fmt(d.inn)}</b>`) : "",
      d.used ? chip(`Used <b>${fmt(d.used)}</b> on ${plural(d.patients, "patient")}`) : "",
      d.out ? chip(`Out <b>${fmt(d.out)}</b>`) : "",
      d.end ? chip(`End <b>${fmt(d.end.value)}</b>`) : d.close !== null && d.close !== undefined ? chip(`Balance <b>${fmt(d.close)}</b>`) : "",
      d.hasDiff ? chip(`Difference ${signed(d.diff)} ${esc(unit)}`, "is-bad") : d.counted ? chip("Adds up ✓", "is-ok") : "",
    ].join("");
    return `<section class="kl-day${d.hasDiff ? " is-diff" : ""}">
      <div class="kl-day-head"><strong>${esc(niceDay(d.date))}</strong><span class="kl-chips">${chips}</span></div>
      <div class="rp-scroll"><table class="inv-table kl-table"><thead><tr><th class="kl-t">Time</th><th>What happened</th><th>Batch / expiry</th>
        <th class="n">In</th><th class="n">Out</th><th class="n">Balance</th></tr></thead>
        <tbody>${d.list.map(entryHtml).join("")}</tbody></table></div></section>`;
  }

  function draw() {
    const list = (st.data[st.src] || []).filter(inRange);
    let days = groupDays(list);
    if (st.diffOnly) days = days.filter((d) => d.hasDiff);
    const left = days.length - st.limit;
    body.innerHTML = !list.length ? '<div class="tm-empty">Nothing recorded in these dates.</div>'
      : `${statsHtml(summary(list))}
        ${days.slice(0, st.limit).map(dayHtml).join("") || '<div class="tm-empty">No days with a difference in these dates. 👍</div>'}
        ${left > 0 ? `<button type="button" class="ff-btn kl-more" data-act="more">Show ${Math.min(30, left)} more days (${left} left)</button>` : ""}`;
  }

  function exportCsv() {
    const list = (st.data[st.src] || []).filter(inRange);
    if (!list.length || !csv) return;
    const name = String(first.staffName || "injector").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    csv(`kit-ledger-${name}-${st.src === "old" ? "old-app" : "portal"}-${dayKey()}.csv`, [
      ["Date", "Time", "What", "Patient", "Details", "Batch / Lot", "Expiry", "In", "Out", "Counted", "Expected", "Difference",
        "Balance", "Counts in the kit", "Source"],
      ...list.map((e) => {
        const c = e.kind === "count";
        return [e.date, e.ms && dayKey(new Date(e.ms)) === e.date ? timeOf(e.ms) : "",
          e.label || (e.cat === "use" ? "Used in treatment" : ""), e.patientName || "",
          [e.areas, e.type, e.formName, e.recordId, e.status, e.note].filter(Boolean).join(" · "),
          c ? (e.batches || []).map((b) => b.batch).filter(Boolean).join(", ") : e.batch || "",
          c ? (e.batches || []).map((b) => expMY(b.expiry)).filter(Boolean).join(", ") : e.expiry || "",
          e.kind === "move" && e.units > 0 ? r1(e.units) : "", e.kind === "move" && e.units < 0 ? r1(-e.units) : "",
          c ? e.value : "", c && e.expected !== null ? e.expected : "", c && e.diff !== null ? e.diff : "",
          e.balance === null ? "" : e.balance, e.kind === "info" || e.counts === false || e.voided ? "No" : "Yes",
          e.src === "old" ? "Old app" : "Portal"];
      }),
    ]);
  }

  dlg.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "close") dlg.close();
    else if (a.dataset.act === "more") { st.limit += 30; draw(); }
    else if (a.dataset.act === "csv") exportCsv();
  });
  dlg.addEventListener("change", (ev) => {
    const f = ev.target.dataset.f;
    if (f === "src") { st.src = ev.target.value; st.limit = 30; load(); }
    else if (f === "range") { st.range = ev.target.value; st.limit = 30; drawTools(); if (st.data[st.src]) draw(); }
    else if (f === "from" || f === "to") { st[f] = ev.target.value; if (st.data[st.src]) draw(); }
    else if (f === "diff") { st.diffOnly = ev.target.checked; st.limit = 30; if (st.data[st.src]) draw(); }
  });

  drawTools();
  load();
}