// Reporting → Kit reconciliation: one row per injector per day, from the old app and the portal as one record.
// Product · Injector · Date · Batch · Expiry · Start count · End count · Total usage · Restock · History (usage per patient).
// For each day one source is used: the portal if it has records that day, otherwise the old app,
// so a treatment saved in both is never counted twice.
import {
  listProducts, listKits, listKitMoves, listAllLoans, listUsageByStaff, listKitDaysFor, dayKey, plural,
} from "./inventory-api.js";
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const fmt = (n) => String(r1(n));
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const niceDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : k; };
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

/* ---------- Entries (one per thing that happened) ---------- */

function portalEntries({ uid, product, moves, loans, usage, days }) {
  const pid = product.id;
  const per = Number(product.dosePer) || 0;
  const out = [];
  const add = (e) => { if (e.date) out.push({ src: "portal", ord: 1, counts: true, ...e }); };

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
    } else if (m.type === "kit-correct" && m.staffUid === uid && kd) {
      add({ ...base, kind: "move", sub: "fix", units: kd });
    }
  });

  loans.forEach((l) => {
    if (l.productId !== pid) return;
    const u = r1(l.units);
    if (!u) return;
    const base = { ms: msOf(l.createdAt), date: keyOf(l.createdAt), batch: l.batch || "", expiry: l.expiry || "" };
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
    add({
      ms: keyOf(u.at) === date ? msOf(u.at) : null, date, kind: "move", sub: "use", units: -total, counts: l.kind === "kit",
      patientName: u.patientName || "", patientId: u.patientId || "", submissionId: u.submissionId || "",
      type: /touch/i.test(form) ? "Touch up" : "Treatment", paper: /paper/i.test(u.source || ""), areas: "",
      batch: uniqJoin(rows.map((r) => r.batch)), expiry: uniqJoin(rows.map((r) => r.expiry), expMY),
      from: l.kind === "vial" ? ((rows[0] || {}).from === "shelf" ? "the Shelf" : "JT storage") : "",
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
      add({ ...base, kind: "move", sub: "borrow", units: r.count, who: r.note || "a colleague" });
    } else if (r.kind === "BORROW-OUT") {
      add({ ...base, kind: "move", sub: "lend", units: -r.count, who: r.note || "a colleague" });
    }
  });
  Object.values(counts).forEach((c) => {
    const list = Object.values(c.by);
    const sod = c.kind === "SOD";
    add({ ms: c.ms, date: c.date, kind: "count", cat: sod ? "start" : "end", ord: sod ? 0 : 2,
      value: r1(list.reduce((a, x) => a + (Number(x.units) || 0), 0)), batches: list });
  });
  (data.records || []).forEach((w) => {
    const lines = w.lines || [];
    add({ ms: atTime(w.date, w.time), date: w.date, kind: "move", sub: "use", units: -r1(w.units),
      patientName: w.patientName || "", type: uniqJoin(lines.map((d) => d.type)) || "Treatment",
      areas: lines.map((d) => `${d.area || "Area"} ${fmt(d.units)}`).join(" · "),
      batch: uniqJoin(lines.map((d) => d.batch)), expiry: uniqJoin(lines.map((d) => d.expiry), expMY) });
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
  entries.forEach((e) => {
    if (e.kind === "count") {
      e.expected = bal;
      bal = e.value;
    } else if (e.kind === "move" && e.counts !== false && bal !== null) {
      bal = r1(bal + e.units);
    }
  });
  return entries;
}

// The portal on the days it has records, the old app on every other day
function mergeSources(portal, old) {
  const pDays = new Set(portal.map((e) => e.date));
  return buildLedger(portal.concat(old.filter((e) => !pDays.has(e.date))));
}

function groupDays(entries) {
  const m = new Map();
  entries.forEach((e) => { const d = m.get(e.date) || { date: e.date, list: [] }; d.list.push(e); m.set(e.date, d); });
  return [...m.values()].map(({ date, list }) => {
    const uses = list.filter((e) => e.sub === "use");
    return {
      date, uses,
      start: list.find((e) => e.kind === "count" && e.cat === "start") || null,
      end: [...list].reverse().find((e) => e.kind === "count" && e.cat === "end") || null,
      used: r1(-uses.reduce((a, e) => a + e.units, 0)),
      restocks: list.filter((e) => e.sub === "restock"),
      colleagues: list.filter((e) => e.sub === "borrow" || e.sub === "lend"),
    };
  });
}

/* ---------- Reporting → Kit reconciliation ---------- */
export function mountKitReconciliation(body, { csv = null } = {}) {
  const st = { staff: "", product: "", from: "", to: "", limit: 100, open: new Set(), people: [], products: [], problem: "" };

  async function load() {
    body.innerHTML = SKEL;
    try {
      const [products, kits, moves, loans, staffRes, old] = await Promise.all([
        listProducts(), listKits(), listKitMoves(), listAllLoans(),
        callApi({ action: "staffList" }).catch(() => ({ staff: [] })),
        callApi({ action: "inventory", op: "oldKitLedgerAll" }).catch((e) => ({ problem: (e && e.message) || "couldn't be read." })),
      ]);
      const kitPs = products.filter((p) => p.usage === "kit" && p.dosePer);
      if (!kitPs.length) { body.innerHTML = '<div class="tm-empty">No products are carried in kits yet.</div>'; return; }
      const oldProduct = kitPs.find((p) => /xeomin/i.test(p.name)) || kitPs[0];   // the old app only had Xeomin
      const kitIds = new Set(kitPs.map((p) => p.id));
      st.products = kitPs;
      if (!st.product) st.product = oldProduct.id;
      st.problem = old && old.problem ? `Old app records: ${old.problem}` : "";

      const staff = staffRes && Array.isArray(staffRes.staff) ? staffRes.staff : [];
      const byId = new Map(staff.map((s) => [s.id, s]));
      const oldBy = new Map(((old && old.people) || []).map((p) => [p.key, p]));
      const uids = new Set(staff.filter((s) => s.injector).map((s) => s.id));
      kits.forEach((k) => { if (kitIds.has(k.productId) && k.staffUid) uids.add(k.staffUid); });
      moves.forEach((m) => {
        if (!kitIds.has(m.productId)) return;
        if (["kit-take", "kit-return", "kit-discard", "kit-use"].includes(m.type) && m.byUid) uids.add(m.byUid);
        if (m.staffUid) uids.add(m.staffUid);
      });
      loans.forEach((l) => { if (kitIds.has(l.productId)) { if (l.toUid) uids.add(l.toUid); if (l.fromUid) uids.add(l.fromUid); } });
      oldBy.forEach((p) => { if (p.staffUid) uids.add(p.staffUid); });

      const data = await Promise.all([...uids].map(async (uid) => {
        let usage = [], days = [];
        try { [usage, days] = await Promise.all([listUsageByStaff(uid), listKitDaysFor(uid)]); }
        catch (e) { console.error("Kit records failed for", uid, e); st.problem = "Some portal records couldn't be loaded."; }
        const o = oldBy.get(uid);
        const kitName = (kits.find((k) => k.staffUid === uid) || {}).staffName;
        return { uid, usage, days, o, name: (byId.get(uid) || {}).name || (o && o.staffName) || kitName || "Unknown" };
      }));

      const people = [];
      kitPs.forEach((product) => {
        data.forEach((x) => {
          const pe = portalEntries({ uid: x.uid, product, moves, loans, usage: x.usage, days: x.days });
          const oe = product === oldProduct && x.o ? oldEntries(x.o) : [];
          if (pe.length || oe.length) people.push({ uid: x.uid, name: x.name, product, L: mergeSources(pe, oe) });
        });
        if (product === oldProduct) {
          oldBy.forEach((o, k) => { if (!o.staffUid) people.push({ uid: k, name: o.staffName, product, L: mergeSources([], oldEntries(o)) }); });
        }
      });
      st.people = people;
      if (body.isConnected) draw();
    } catch (err) {
      console.error("Kit reconciliation failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="tm-empty is-error">${esc(err && err.code === "permission-denied"
          ? "You don't have access to these records." : "Couldn't load the kits. Try again.")}</div>`;
      }
    }
  }

  function rows() {
    const a = st.from || "0000-00-00", b = st.to || "9999-99-99";
    const out = [];
    st.people.forEach((p) => {
      if ((st.product && p.product.id !== st.product) || (st.staff && p.uid !== st.staff)) return;
      groupDays(p.L.filter((e) => e.date >= a && e.date <= b)).forEach((d) => {
        if (!d.start && !d.end && !d.uses.length && !d.restocks.length && !d.colleagues.length) return;
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

  function toolsHtml() {
    const staff = new Map();
    st.people.filter((p) => !st.product || p.product.id === st.product).forEach((p) => staff.set(p.uid, p.name));
    return `<div class="inv-tools kr-tools">
        <label class="rp-from">Staff <select class="fb-select" data-f="staff"><option value="">All staff</option>
          ${[...staff].sort((a, b) => a[1].localeCompare(b[1], "en-AU")).map(([uid, name]) =>
            `<option value="${esc(uid)}"${st.staff === uid ? " selected" : ""}>${esc(name)}</option>`).join("")}</select></label>
        <label class="rp-from">From <input class="fe-in" type="date" data-f="from" value="${esc(st.from)}" /></label>
        <label class="rp-from">To <input class="fe-in" type="date" data-f="to" value="${esc(st.to)}" /></label>
        <label class="rp-from">Product <select class="fb-select" data-f="product"><option value="">All products</option>
          ${st.products.map((p) => `<option value="${esc(p.id)}"${st.product === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        <span class="inv-spacer"></span>
        ${csv ? '<button type="button" class="ff-btn" data-act="kr-csv">Export CSV</button>' : ""}
      </div>
      ${st.problem ? `<p class="tb-bad rp-note">${esc(st.problem)}</p>` : ""}`;
  }

  function historyHtml(d) {
    if (!d.uses.length) return '<p class="muted rp-note">No treatments recorded this day.</p>';
    const unit = d.p.product.doseUnit || "units";
    return `<table class="inv-table kr-hist"><thead><tr><th>Time</th><th>Patient Name</th><th>Type of Record</th><th>Area</th>
        <th class="n">Total Units</th></tr></thead><tbody>${d.uses.map((e) => {
      const who = e.patientId
        ? `<a href="#/patient/${encodeURIComponent(e.patientId)}" target="_blank" rel="noopener">${esc(e.patientName || "Patient")}</a>`
        : esc(e.patientName || "—");
      const type = esc(e.type || "Treatment") + (e.paper ? " (paper)" : "");
      const notes = [e.from ? `From ${e.from}` : "", e.batch ? `Batch ${e.batch}` : ""].filter(Boolean).join(" · ");
      return `<tr><td>${e.ms && dayKey(new Date(e.ms)) === e.date ? esc(timeOf(e.ms)) : "—"}</td>
        <td>${who}</td>
        <td>${e.submissionId ? `<a href="#/form-record/${encodeURIComponent(e.submissionId)}" target="_blank" rel="noopener">${type}</a>` : type}</td>
        <td>${esc(e.areas || "—")}${notes ? `<small>${esc(notes)}</small>` : ""}</td>
        <td class="n"><strong>${fmt(-e.units)}</strong> ${esc(unit)}</td></tr>`;
    }).join("")}</tbody><tfoot><tr><td colspan="4">Total · ${plural(d.uses.length, "record")}</td>
        <td class="n"><strong>${fmt(d.used)}</strong> ${esc(unit)}</td></tr></tfoot></table>`;
  }

  function rowHtml(d) {
    const open = st.open.has(d.id);
    const b = batchesOf(d);
    const start = !d.start ? "—" : `<strong>${fmt(d.start.value)}</strong>${
      d.start.expected !== null && d.start.expected !== undefined && Math.abs(d.start.value - d.start.expected) >= 0.05
        ? `<small class="kr-bad">expected ${fmt(d.start.expected)}</small>` : ""}`;
    const restock = d.restocks.map((e) => `<div>+${fmt(e.units)}${e.batch ? ` · ${esc(e.batch)}` : ""}${e.expiry ? ` · Exp ${esc(expMY(e.expiry))}` : ""}</div>`).join("")
      + d.colleagues.map((e) => `<small>${e.units > 0 ? `From ${esc(e.who)} +${fmt(e.units)}` : `To ${esc(e.who)} −${fmt(-e.units)}`}</small>`).join("");
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
        <td><button type="button" class="lh-btn" data-hist="${esc(d.id)}">${open ? "Hide" : "History"}</button></td></tr>
      ${open ? `<tr class="rp-sub"><td colspan="10">${historyHtml(d)}</td></tr>` : ""}`;
  }

  function draw() {
    const list = rows();
    const more = list.length - st.limit;
    body.innerHTML = `${toolsHtml()}
      ${list.length ? `<p class="muted rp-range">${list.length} day${list.length === 1 ? "" : "s"} recorded${
        st.from || st.to ? " in these dates" : ", newest first"}${more > 0 ? `. Showing ${st.limit}: press "Show more" at the bottom for the rest` : ""}.</p>`
        : ""}
      ${list.length ? `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table kr-table">
        <thead><tr><th>Product</th><th>Injector Name</th><th>Date</th><th>Batch Number</th><th>Exp Date</th>
          <th class="n">Start Count</th><th class="n">End of Count</th><th class="n">Total Usage</th><th>Restock Record</th><th></th></tr></thead>
        <tbody>${list.slice(0, st.limit).map(rowHtml).join("")}</tbody></table></div>
        ${more > 0 ? `<button type="button" class="ff-btn kr-more" data-act="kr-more">Show ${Math.min(100, more)} more (${more} left)</button>` : ""}
        </section>` : '<div class="tm-empty">Nothing recorded for these filters.</div>'}`;
  }

  function exportCsv() {
    const list = rows();
    if (!list.length || !csv) return;
    const out = [["Product", "Injector", "Date", "Batch Number", "Exp Date", "Start Count", "End of Count", "Total Usage", "Restock Record",
      "Time", "Patient", "Type of Record", "Area", "Units"]];
    list.forEach((d) => {
      const b = batchesOf(d);
      const day = [d.p.product.name, d.p.name, d.date, b.map((x) => x.batch).join(", "), b.map((x) => expMY(x.expiry)).join(", "),
        d.start ? d.start.value : "", d.end ? d.end.value : "", d.used || "",
        d.restocks.map((e) => `+${fmt(e.units)} ${e.batch} ${expMY(e.expiry)}`.trim()).join("; ")];
      if (!d.uses.length) { out.push(day.concat(["", "", "", "", ""])); return; }
      d.uses.forEach((e) => out.push(day.concat([e.ms && dayKey(new Date(e.ms)) === e.date ? timeOf(e.ms) : "",
        e.patientName || "", e.type || "Treatment", e.areas || "", r1(-e.units)])));
    });
    csv(`kit-reconciliation-${st.from || "all"}-to-${st.to || dayKey()}.csv`, out);
  }

  body.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    const h = ev.target.closest("[data-hist]");
    if (h) {
      const id = h.dataset.hist;
      if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
      draw();
      return;
    }
    if (ev.target.closest('[data-act="kr-more"]')) { st.limit += 100; draw(); return; }
    if (ev.target.closest('[data-act="kr-csv"]')) exportCsv();
  });
  body.addEventListener("change", (ev) => {
    const f = ev.target.dataset.f;
    if (!["staff", "from", "to", "product"].includes(f)) return;
    st[f] = ev.target.value;
    if (f === "product") st.staff = "";
    st.limit = 100;
    draw();
  });

  load();
}