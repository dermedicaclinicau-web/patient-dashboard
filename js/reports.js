import {
  listProducts, listCounts, resolveCountLine, listUsageBetween, listMovesBetween,
  listKits, listKitMoves, listAllLoans, listShortAll, resolveShort, kitUnits,
  batchName, plural, unitPlural, dayKey, COUNT_STATUS,
} from "./inventory-api.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(+Number(n || 0).toFixed(2));
const money = (n) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const LOC = { shelf: "Shelf", jt: "JT storage" };
const whereOf = (l) => (l.loc === "kit" ? `${l.staffName || "Injector"}'s kit` : LOC[l.loc] || l.loc);
const parseKey = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
const niceDate = (key) => {
  const d = parseKey(key);
  return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "";
};
const shortDate = (d) => (d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const monthLabel = (k) => { const [y, m] = k.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-AU", { month: "long", year: "numeric" }); };
const daysAgoKey = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return dayKey(d); };
const SKELETON = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
const TABS = [["variance", "Count differences"], ["wastage", "Wastage"], ["kits", "Kit reconciliation"], ["usage", "Usage"], ["short", "Saved short"]];
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to do this. Check the Firestore rules have been published, and your Reporting access in Staff."
  : err && err.message && !err.code ? err.message : fallback);

// Cost at the clinic's price: per item on the Shelf, and per unit / mL inside it
const perItem = (p) => (p && p.cost !== null && p.cost !== undefined ? p.cost / Math.max(1, p.packSize) : null);
const perDose = (p) => { const c = perItem(p); return c !== null && p.dosePer ? c / p.dosePer : null; };
const mul = (c, n) => (c === null ? null : Math.round(c * n * 100) / 100);
const amt = (n, unit, plain) => (plain ? plural(+fmt(n), unit) : `${fmt(n)} ${unit}`);
const sumValue = (ev) => (ev.some((e) => e.value !== null) ? Math.round(ev.reduce((a, e) => a + (e.value || 0), 0) * 100) / 100 : null);
const moneyOrDash = (v) => (v === null ? "—" : money(v));

// CSV that opens cleanly in Excel. Text starting with = + - @ is made safe so it can't run as a formula.
export function downloadCsv(name, rows) {
  const cell = (v) => {
    if (typeof v === "number") return String(v);
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function openDialog(html) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg";
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

export function mountReports(container, { param = "", staff = null } = {}) {
  const first = String(param || "").split("/")[0];
  const tab = TABS.some(([k]) => k === first) ? first : "variance";
  const root = document.createElement("section");
  root.className = "page wide";
  container.replaceChildren(root);
  if (!can("menu.reports")) {
    root.innerHTML = '<div class="state"><strong>No access</strong>Ask an Admin to give you Reporting access in Staff.</div>';
    return;
  }
  root.innerHTML = `
    <div class="fb-head"><div><h2>Reporting</h2><p class="muted">Count differences, wastage, kits and usage.</p></div></div>
    <nav class="pt-tabs inv-tabs" aria-label="Reporting">${TABS.map(([k, l]) =>
      `<a href="#/reports/${k}"${k === tab ? ' class="active" aria-current="page"' : ""}>${esc(l)}</a>`).join("")}</nav>
    <div data-role="body">${SKELETON}</div>`;
  const body = root.querySelector('[data-role="body"]');
  if (tab === "variance") mountVariance(body, staff);
  else if (tab === "wastage") mountWastage(body);
  else if (tab === "usage") mountUsage(body);
  else if (tab === "kits") mountKitRecon(body);
  else mountShort(body, staff);
}

/* ===================== Count differences ===================== */

function mountVariance(body, staff) {
  const st = { view: "open", from: daysAgoKey(30), counts: [], products: new Map() };

  // Cost per counted item (cost is per supplier unit). Kits: per unit (e.g. per unit of Xeomin).
  const unitCost = (l) => {
    const p = st.products.get(l.productId);
    if (!p || p.cost === null || p.cost === undefined) return null;
    const pi = p.cost / Math.max(1, p.packSize);
    return l.loc === "kit" ? (p.dosePer ? pi / p.dosePer : null) : pi;
  };
  const valueOf = (l) => { const c = unitCost(l); return c === null ? null : Math.round(c * (Number(l.variance) || 0) * 100) / 100; };
  const amtOf = (l, n) => (l.loc === "kit" ? `${fmt(n)} ${l.unit}` : plural(+fmt(n), l.unit));
  const shown = (l) => st.view === "all" || l.status === "open";

  async function load() {
    body.innerHTML = SKELETON;
    try {
      const [counts, products] = await Promise.all([
        st.view === "open" ? listCounts({ openOnly: true }) : listCounts({ from: st.from }),
        listProducts(),
      ]);
      st.counts = counts;
      st.products = new Map(products.map((p) => [p.id, p]));
      if (body.isConnected) draw();
    } catch (err) {
      console.error("Count differences failed:", err);
      if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the counts. Try again."))}</div>`;
    }
  }

  function rowHtml(c, l, i) {
    const diff = Number(l.variance) || 0;
    const v = valueOf(l);
    const cls = (n) => (n < 0 ? "rp-neg" : "rp-pos");
    const status = l.status === "open"
      ? `<div class="rp-acts"><button type="button" class="lh-btn is-primary" data-act="accept">Accept</button>
          <button type="button" class="lh-btn" data-act="explain">Explain</button></div>`
      : `<div class="rp-done"><span class="rq-status is-${esc(l.status)}">${esc(COUNT_STATUS[l.status] || l.status)}</span>
          ${l.note ? `<small>${esc(l.note)}</small>` : ""}${l.resolvedBy ? `<small>${esc(l.resolvedBy)}</small>` : ""}</div>`;
    return `<tr class="${l.status === "open" ? "is-diff" : ""}" data-c="${esc(c.id)}" data-i="${i}">
      <td>${esc(l.productName)}</td><td>${esc(whereOf(l))}</td>
      <td>${esc(l.batch ? `${l.batchLabel || batchName(st.products.get(l.productId))} ${l.batch}` : "—")}</td>
      <td>${esc(amtOf(l, l.counted))}</td><td>${esc(amtOf(l, l.system))}</td>
      <td>${l.status === "ok" ? "✓" : `<strong class="${cls(diff)}">${diff > 0 ? "+" : ""}${esc(fmt(diff))}</strong>`}</td>
      <td>${v === null || l.status === "ok" ? "—" : `<span class="${cls(v)}">${esc(money(v))}</span>`}</td>
      <td>${status}</td></tr>`;
  }

  function groupHtml(c) {
    const rows = c.lines.map((l, i) => [l, i]).filter(([l]) => shown(l));
    if (!rows.length) return "";
    return `<section class="tb-card rp-count">
      <div class="rp-count-head"><strong>${c.kind === "kit" ? "Kit check" : "Opening count"}</strong>
        <span>${esc(niceDate(c.dateKey))}${c.at ? ` · ${esc(timeOf(c.at))}` : ""} · by ${esc(c.by || "—")}</span>
        ${c.openCount ? `<span class="inv-flag is-warn">${c.openCount} to review</span>` : '<span class="inv-flag is-info">All reviewed</span>'}</div>
      <table class="inv-table rp-table"><thead><tr><th>Product</th><th>Where</th><th>Batch / Lot</th><th>Counted</th><th>System</th>
        <th>Difference</th><th>Value</th><th></th></tr></thead>
        <tbody>${rows.map(([l, i]) => rowHtml(c, l, i)).join("")}</tbody></table></section>`;
  }

  function draw() {
    const open = st.counts.flatMap((c) => c.lines).filter((l) => l.status === "open");
    const sum = (pred) => open.reduce((a, l) => { const v = valueOf(l); return a + (v !== null && pred(v) ? v : 0); }, 0);
    const groups = st.counts.map(groupHtml).join("");
    body.innerHTML = `
      <div class="inv-tools">
        <div class="fe-seg">${[["open", `To review (${st.view === "open" ? open.length : "…"})`], ["all", "All counts"]].map(([v, l]) =>
          `<label class="fe-seg-btn"><input type="radio" name="rp-view" data-f="view" value="${v}"${st.view === v ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>
        ${st.view === "all" ? `<label class="rp-from">From <input class="fe-in" type="date" data-f="from" value="${esc(st.from)}" /></label>` : ""}
        <span class="inv-spacer"></span>
        <button type="button" class="ff-btn" data-act="csv">Export CSV</button>
      </div>
      ${st.view === "open" && open.length ? `<div class="inv-stats">
        <div class="inv-stat is-warn"><strong>${open.length}</strong><span>Differences to review</span></div>
        <div class="inv-stat is-bad"><strong>${esc(money(sum((v) => v < 0)))}</strong><span>Missing (at cost)</span></div>
        <div class="inv-stat"><strong>${esc(money(sum((v) => v > 0)))}</strong><span>Extra found (at cost)</span></div>
      </div>` : ""}
      ${groups || `<div class="tm-empty">${st.view === "open" ? "No count differences to review. 👍" : "No counts in this period."}</div>`}`;
  }

  function review(c, i, l, act) {
    const accept = act === "accept";
    const diff = Number(l.variance) || 0;
    const unit = l.loc === "kit" ? l.unit : unitPlural(l.unit);
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${accept ? "Accept" : "Explain"}: ${esc(l.productName)}</h3>
          <p>${accept
            ? `${esc(whereOf(l))} will be adjusted by <strong>${diff > 0 ? "+" : ""}${esc(fmt(diff))} ${esc(unit)}</strong> to match the count. The change is logged in Activity.`
            : "Stock isn't changed. Your note is kept with the count."}</p></div>
        <label class="lh-field"><span class="lh-label">${accept ? "Note (optional)" : "What happened?"}</span>
          <textarea name="note" rows="3" maxlength="500" placeholder="${accept
            ? "e.g. Broken vial that wasn't written off" : "e.g. Counted before the delivery was put away"}"></textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${accept ? "Accept and adjust stock" : "Save explanation"}</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const note = form.elements.note.value.trim();
      if (!accept && !note) { err.textContent = "Add a short note explaining the difference."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await resolveCountLine(c.id, i, { action: act, note }, staff);
        dlg.close();
        showToast(accept ? "Accepted. Stock adjusted." : "Explanation saved");
        load();
      } catch (ex) {
        console.error("Review failed:", ex);
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.elements.note.focus();
  }

  function exportCsv() {
    const rows = [["Date", "Type", "Counted by", "Product", "Where", "Batch / Lot", "Expiry", "Counted", "System", "Difference",
      "Unit", "Value ($)", "Status", "Note", "Reviewed by"]];
    st.counts.forEach((c) => c.lines.forEach((l) => {
      if (!shown(l)) return;
      const v = valueOf(l);
      rows.push([c.dateKey || "", c.kind === "kit" ? "Kit check" : "Opening count", c.by || "", l.productName || "", whereOf(l),
        l.batch || "", l.expiry || "", Number(l.counted) || 0, Number(l.system) || 0, Number(l.variance) || 0, l.unit || "",
        v === null ? "" : v, COUNT_STATUS[l.status] || l.status || "", l.note || "", l.resolvedBy || ""]);
    }));
    if (rows.length === 1) { showToast("Nothing to export."); return; }
    downloadCsv(`count-differences-${dayKey()}.csv`, rows);
  }

  body.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "csv") { exportCsv(); return; }
    const tr = a.closest("tr[data-c]");
    const c = tr && st.counts.find((x) => x.id === tr.dataset.c);
    const i = tr ? Number(tr.dataset.i) : -1;
    if (c && c.lines[i]) review(c, i, c.lines[i], a.dataset.act);
  });
  body.addEventListener("change", (e) => {
    const f = e.target.dataset.f;
    if (f === "view") { st.view = e.target.value; load(); }
    else if (f === "from") { st.from = e.target.value || daysAgoKey(30); load(); }
  });
  load();
}

/* ===================== Date-range reports (shared) ===================== */

const RANGES = [["month", "This month"], ["last-month", "Last month"], ["30", "Last 30 days"], ["90", "Last 90 days"],
  ["year", "This year"], ["custom", "Choose dates"]];

// { from, to }: from is the first day at midnight, to is midnight after the last day
function rangeOf(st) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const back = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
  switch (st.range) {
    case "last-month": return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) };
    case "30": return { from: back(29), to: tomorrow };
    case "90": return { from: back(89), to: tomorrow };
    case "year": return { from: new Date(now.getFullYear(), 0, 1), to: tomorrow };
    case "custom": {
      let a = parseKey(st.from) || back(29);
      let b = parseKey(st.to) || today;
      if (b < a) [a, b] = [b, a];
      const to = new Date(b); to.setDate(b.getDate() + 1);
      return { from: a, to };
    }
    default: return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow };
  }
}
const lastDay = (r) => { const d = new Date(r.to); d.setDate(d.getDate() - 1); return d; };
const rangeText = (r) => `${shortDate(r.from)} – ${shortDate(lastDay(r))}`;
const fileDates = (r) => `${dayKey(r.from)}-to-${dayKey(lastDay(r))}`;

// How entries can be grouped
const KEY = {
  product: { of: (e) => e.productId || e.productName, label: (e) => e.productName || "Unknown product" },
  clinician: { of: (e) => e.by || "—", label: (e) => e.by || "Unknown" },
  patient: { of: (e) => e.patientId || e.patient || "—", label: (e) => e.patient || "No patient" },
  month: { of: (e) => (e.at ? dayKey(e.at).slice(0, 7) : "—"), label: (e, k) => (k === "—" ? "No date" : monthLabel(k)),
    sort: (a, b) => b.key.localeCompare(a.key) },
  type: { of: (e) => e.typeLabel, label: (e) => e.typeLabel },
};

// "Belotero 1.2 mL · Xeomin 40 units" (names left out when every entry is the same product)
function amountsText(ev, withNames, pick = (e) => ({ n: e.amount, unit: e.unit, plain: e.plain })) {
  const m = new Map();
  ev.forEach((e) => {
    const x = pick(e);
    if (!x || !(x.n > 0)) return;
    const k = `${e.productId || e.productName}|${x.unit}`;
    const a = m.get(k) || { name: e.productName, unit: x.unit, plain: x.plain, n: 0 };
    a.n += x.n;
    m.set(k, a);
  });
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "en-AU"))
    .map((a) => (withNames ? `${a.name} ` : "") + amt(a.n, a.unit, a.plain)).join(" · ");
}

// A report over a date range: toolbar, totals, a table by group, and every entry
function mountRangeReport(body, cfg) {
  const st = { range: "month", from: daysAgoKey(29), to: dayKey(), group: cfg.groups[0][0], q: "", events: [], r: null };
  body.innerHTML = `<div data-role="tools"></div><div data-role="out">${SKELETON}</div>`;
  const toolsEl = body.querySelector('[data-role="tools"]');
  const out = body.querySelector('[data-role="out"]');
  const groupName = () => (cfg.groups.find(([v]) => v === st.group) || cfg.groups[0])[1];

  function drawTools() {
    toolsEl.innerHTML = `<div class="inv-tools rp-tools">
      <select class="fb-select" data-f="range" aria-label="Dates">${RANGES.map(([v, l]) =>
        `<option value="${v}"${st.range === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
      ${st.range === "custom" ? `
        <label class="rp-from">From <input class="fe-in" type="date" data-f="from" value="${esc(st.from)}" /></label>
        <label class="rp-from">To <input class="fe-in" type="date" data-f="to" value="${esc(st.to)}" /></label>` : ""}
      <label class="rp-from">Group by <select class="fb-select" data-f="group">${cfg.groups.map(([v, l]) =>
        `<option value="${v}"${st.group === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <input type="search" class="fe-input rp-find" data-f="q" placeholder="${esc(cfg.findPlaceholder)}" value="${esc(st.q)}" aria-label="Filter" />
      <span class="inv-spacer"></span>
      <button type="button" class="ff-btn" data-act="csv">Export CSV</button>
    </div>`;
  }

  const visible = () => {
    const q = st.q.trim().toLowerCase();
    return q ? st.events.filter((e) => cfg.searchText(e).toLowerCase().includes(q)) : st.events;
  };

  async function load() {
    out.innerHTML = SKELETON;
    st.r = rangeOf(st);
    try {
      const ev = await cfg.load(st.r);
      if (!out.isConnected) return;
      st.events = ev;
      draw();
    } catch (err) {
      console.error(`${cfg.name} report failed:`, err);
      if (out.isConnected) out.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the report. Try again."))}</div>`;
    }
  }

  function draw() {
    const ev = visible();
    const key = KEY[st.group];
    const map = new Map();
    ev.forEach((e) => {
      const k = key.of(e);
      const g = map.get(k) || { key: k, label: key.label(e, k), events: [] };
      g.events.push(e);
      map.set(k, g);
    });
    const rows = [...map.values()].map((g) => ({ ...g, value: sumValue(g.events) }))
      .sort(key.sort || ((a, b) => (b.value || 0) - (a.value || 0) || a.label.localeCompare(b.label, "en-AU")));
    const missingCost = ev.some((e) => e.value === null);
    out.innerHTML = `
      <p class="muted rp-range">${esc(rangeText(st.r))} · ${ev.length} entr${ev.length === 1 ? "y" : "ies"}${st.q.trim() ? ` matching “${esc(st.q.trim())}”` : ""}</p>
      ${ev.length ? `${cfg.statsHtml(ev)}
        <section class="tb-card">
          <h4>By ${esc(groupName().toLowerCase())}</h4>
          <div class="rp-scroll"><table class="inv-table rp-table">
            ${cfg.summaryHead(groupName())}
            <tbody>${rows.map((g) => cfg.summaryRow(g, st.group)).join("")}</tbody>
            <tfoot>${cfg.summaryFoot(ev)}</tfoot>
          </table></div>
          ${missingCost ? '<p class="muted rp-note">Value leaves out products with no cost. Add costs in Inventory → Products.</p>' : ""}
        </section>
        <details class="tb-card rp-detail"><summary>Every entry (${ev.length})</summary>
          <div class="rp-scroll"><table class="inv-table rp-table">${cfg.detailHead}
            <tbody>${ev.slice(0, 500).map(cfg.detailRow).join("")}</tbody></table></div>
          ${ev.length > 500 ? `<p class="muted rp-note">Showing the latest 500. Export CSV for all ${ev.length}.</p>` : ""}
        </details>`
      : `<div class="tm-empty">${esc(cfg.empty)}</div>`}`;
  }

  body.addEventListener("change", (e) => {
    const f = e.target.dataset.f;
    if (f === "range") {
      st.range = e.target.value;
      if (st.range === "custom" && !st.from) { st.from = daysAgoKey(29); st.to = dayKey(); }
      drawTools();
      load();
    } else if (f === "from" || f === "to") {
      st[f] = e.target.value;
      if (parseKey(st.from) && parseKey(st.to)) load();
    } else if (f === "group") {
      st.group = e.target.value;
      if (st.r) draw();
    }
  });
  let qTimer = null;
  body.addEventListener("input", (e) => {
    if (e.target.dataset.f !== "q") return;
    st.q = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { if (st.r) draw(); }, 200);
  });
  body.addEventListener("click", (e) => {
    if (!e.target.closest('[data-act="csv"]')) return;
    const ev = visible();
    if (!ev.length) { showToast("Nothing to export."); return; }
    downloadCsv(`${cfg.file}-${fileDates(st.r)}.csv`, [cfg.csvHead, ...ev.map(cfg.csvRow)]);
  });

  drawTools();
  load();
}

/* ===================== Wastage ===================== */

// One entry per thing thrown away: filler left in syringes, kit discards and write-offs
function wasteEvents(usage, moves, byId) {
  const out = [];
  usage.forEach((u) => u.lines.forEach((l) => {
    const w = Number(l.waste) || 0;
    if (!(w > 0) || l.kind === "kit") return;
    const p = byId.get(l.productId);
    out.push({
      at: u.at, type: "filler", typeLabel: "Leftover discarded", productId: l.productId, productName: l.name,
      amount: w, unit: l.doseUnit || "mL", plain: false, by: u.by || "", patient: u.patientName || "",
      patientId: u.patientId || "", detail: u.formName || "", submissionId: u.submissionId || "",
      batch: [...new Set((l.rows || []).map((r) => r.batch).filter(Boolean))].join(", "),
      value: mul(perDose(p), w),
    });
  }));
  moves.forEach((m) => {
    const p = byId.get(m.productId);
    const gone = (m.lines || []).reduce((a, l) => a + Math.max(0, -(Number(l.delta) || 0)), 0);
    const batch = [...new Set((m.lines || []).map((l) => l.batch).filter(Boolean))].join(", ");
    if (m.type === "kit-discard") {
      let units = Number(m.discardUnits);
      if (!Number.isFinite(units)) { // older entries: read the units from the note
        const open = Number((/([\d.]+)\s+\S+\s+from the opened vial/.exec(m.note || "") || [])[1]) || 0;
        units = open + gone * ((p && p.dosePer) || 0);
      }
      if (!(units > 0)) return;
      out.push({
        at: m.at, type: "kit", typeLabel: "Discarded from kit", productId: m.productId, productName: m.productName,
        amount: units, unit: (p && p.doseUnit) || m.unit || "units", plain: false, by: m.by || "", patient: "", patientId: "",
        detail: [m.reason, m.note].filter(Boolean).join(" · "), batch, value: mul(perDose(p), units),
      });
    } else if (m.type === "writeoff" && gone > 0) {
      out.push({
        at: m.at, type: "writeoff", typeLabel: "Written off", productId: m.productId, productName: m.productName,
        amount: gone, unit: (p && p.stockUnit) || m.unit || "item", plain: true, by: m.by || "", patient: "", patientId: "",
        detail: [m.reason, m.note].filter(Boolean).join(" · "), batch, value: mul(perItem(p), gone),
      });
    }
  });
  return out.sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
}

function mountWastage(body) {
  mountRangeReport(body, {
    name: "Wastage", file: "wastage",
    groups: [["product", "Product"], ["clinician", "Staff member"], ["month", "Month"], ["type", "Type"]],
    findPlaceholder: "Filter: product, staff, patient or reason",
    empty: "No wastage recorded in these dates. 👍",
    async load(r) {
      const [products, usage, moves] = await Promise.all([
        listProducts(), listUsageBetween(r.from, r.to), listMovesBetween(r.from, r.to, ["kit-discard", "writeoff"]),
      ]);
      return wasteEvents(usage, moves, new Map(products.map((p) => [p.id, p])));
    },
    searchText: (e) => [e.productName, e.by, e.patient, e.detail, e.typeLabel, e.batch].join(" "),
    statsHtml(ev) {
      const n = (t) => ev.filter((e) => e.type === t).length;
      return `<div class="inv-stats">
        <div class="inv-stat is-bad"><strong>${esc(moneyOrDash(sumValue(ev)))}</strong><span>Wasted (at cost)</span></div>
        <div class="inv-stat"><strong>${n("filler")}</strong><span>Leftover filler discarded</span></div>
        <div class="inv-stat"><strong>${n("kit")}</strong><span>Kit discards</span></div>
        <div class="inv-stat is-warn"><strong>${n("writeoff")}</strong><span>Write-offs</span></div>
      </div>`;
    },
    summaryHead: (label) => `<thead><tr><th>${esc(label)}</th><th>Entries</th><th>Amount</th><th>Value</th></tr></thead>`,
    summaryRow: (g, group) => `<tr><td><strong>${esc(g.label)}</strong></td><td>${g.events.length}</td>
      <td>${esc(amountsText(g.events, group !== "product"))}</td><td>${esc(moneyOrDash(g.value))}</td></tr>`,
    summaryFoot: (ev) => `<tr><th>Total</th><th>${ev.length}</th><th></th><th>${esc(moneyOrDash(sumValue(ev)))}</th></tr>`,
    detailHead: "<thead><tr><th>Date</th><th>Type</th><th>Product</th><th>Amount</th><th>Batch / Lot</th><th>Staff</th><th>Patient / reason</th><th>Value</th></tr></thead>",
    detailRow: (e) => `<tr>
      <td>${esc(shortDate(e.at))}</td>
      <td><span class="inv-flag ${e.type === "writeoff" ? "is-warn" : "is-info"}">${esc(e.typeLabel)}</span></td>
      <td>${esc(e.productName)}</td><td>${esc(amt(e.amount, e.unit, e.plain))}</td><td>${esc(e.batch || "—")}</td>
      <td>${esc(e.by || "—")}</td>
      <td>${e.submissionId ? `<a href="#/form-record/${encodeURIComponent(e.submissionId)}">${esc(e.patient || "Treatment record")}</a>` : esc(e.detail || "—")}</td>
      <td>${esc(moneyOrDash(e.value))}</td></tr>`,
    csvHead: ["Date", "Type", "Product", "Amount", "Unit", "Batch / Lot", "Staff", "Patient", "Form / reason", "Value ($)"],
    csvRow: (e) => [e.at ? dayKey(e.at) : "", e.typeLabel, e.productName, +fmt(e.amount), e.unit, e.batch, e.by, e.patient, e.detail,
      e.value === null ? "" : e.value],
  });
}

/* ===================== Usage ===================== */

// One entry per product recorded on a treatment form
function useEvents(usage, byId) {
  const out = [];
  usage.forEach((u) => u.lines.forEach((l) => {
    const p = byId.get(l.productId);
    const kit = l.kind === "kit";
    const items = Number(l.total) || 0;                       // kit: units; otherwise syringes / items taken
    const dosedLine = !kit && !!l.doseUnit && Number(l.doseTotal) > 0;
    out.push({
      at: u.at, productId: l.productId, productName: l.name, kit, dosed: dosedLine,
      amount: kit ? items : dosedLine ? Number(l.doseTotal) : items,
      unit: kit ? l.unit : dosedLine ? l.doseUnit : l.unit, plain: !kit && !dosedLine,
      items, itemUnit: l.unit, waste: Number(l.waste) || 0, wasteUnit: l.doseUnit || "",
      short: Number(l.short) || 0,
      by: u.by || "", patient: u.patientName || "", patientId: u.patientId || "",
      detail: u.formName || "", submissionId: u.submissionId || "",
      batch: [...new Set((l.rows || []).map((r) => r.batch).filter(Boolean))].join(", "),
      value: kit ? mul(perDose(p), items) : mul(perItem(p), items),
    });
  }));
  return out;
}
const useAmount = (e) => (e.dosed ? `${amt(e.amount, e.unit, false)} (${plural(+fmt(e.items), e.itemUnit)})` : amt(e.amount, e.unit, e.plain));
const treatments = (ev) => new Set(ev.map((e) => e.submissionId || `${e.patientId}|${e.at && e.at.getTime()}`)).size;

function mountUsage(body) {
  mountRangeReport(body, {
    name: "Usage", file: "usage",
    groups: [["product", "Product"], ["clinician", "Staff member"], ["patient", "Patient"], ["month", "Month"]],
    findPlaceholder: "Filter: product, staff or patient",
    empty: "No products recorded on treatment forms in these dates.",
    async load(r) {
      const [products, usage] = await Promise.all([listProducts(), listUsageBetween(r.from, r.to)]);
      return useEvents(usage, new Map(products.map((p) => [p.id, p])))
        .sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0));
    },
    searchText: (e) => [e.productName, e.by, e.patient, e.detail, e.batch].join(" "),
    statsHtml(ev) {
      const short = ev.filter((e) => e.short > 0).length;
      return `<div class="inv-stats">
        <div class="inv-stat"><strong>${treatments(ev)}</strong><span>Treatment records</span></div>
        <div class="inv-stat"><strong>${new Set(ev.map((e) => e.productId || e.productName)).size}</strong><span>Products used</span></div>
        <div class="inv-stat"><strong>${esc(moneyOrDash(sumValue(ev)))}</strong><span>Stock used (at cost)</span></div>
        <div class="inv-stat ${short ? "is-bad" : ""}"><strong>${short}</strong><span>Saved short</span></div>
      </div>`;
    },
    summaryHead: (label) => `<thead><tr><th>${esc(label)}</th><th>Treatments</th><th>Amount</th><th>Discarded</th><th>Value</th></tr></thead>`,
    summaryRow: (g, group) => {
      const waste = amountsText(g.events, group !== "product", (e) => (e.waste > 0 ? { n: e.waste, unit: e.wasteUnit, plain: false } : null));
      const label = group === "patient" && g.events[0].patientId
        ? `<a href="#/patient/${encodeURIComponent(g.events[0].patientId)}">${esc(g.label)}</a>` : esc(g.label);
      return `<tr><td><strong>${label}</strong></td><td>${treatments(g.events)}</td>
        <td>${esc(amountsText(g.events, group !== "product"))}</td><td>${esc(waste || "—")}</td><td>${esc(moneyOrDash(g.value))}</td></tr>`;
    },
    summaryFoot: (ev) => `<tr><th>Total</th><th>${treatments(ev)}</th><th></th><th></th><th>${esc(moneyOrDash(sumValue(ev)))}</th></tr>`,
    detailHead: "<thead><tr><th>Date</th><th>Product</th><th>Amount</th><th>Batch / Lot</th><th>Staff</th><th>Patient</th><th>Value</th></tr></thead>",
    detailRow: (e) => `<tr>
      <td>${esc(shortDate(e.at))}</td>
      <td>${esc(e.productName)}${e.short > 0 ? ' <span class="inv-flag is-bad">Saved short</span>' : ""}</td>
      <td>${esc(useAmount(e))}${e.waste > 0 ? ` <small class="muted">· ${esc(fmt(e.waste))} ${esc(e.wasteUnit)} discarded</small>` : ""}</td>
      <td>${esc(e.batch || "—")}</td><td>${esc(e.by || "—")}</td>
      <td>${e.submissionId ? `<a href="#/form-record/${encodeURIComponent(e.submissionId)}">${esc(e.patient || "Treatment record")}</a>` : esc(e.patient || "—")}</td>
      <td>${esc(moneyOrDash(e.value))}</td></tr>`,
    csvHead: ["Date", "Product", "Amount", "Unit", "Syringes / items", "Discarded", "Batch / Lot", "Staff", "Patient", "Form", "Saved short", "Value ($)"],
    csvRow: (e) => [e.at ? dayKey(e.at) : "", e.productName, +fmt(e.amount), e.unit, e.kit ? "" : +fmt(e.items),
      e.waste ? `${fmt(e.waste)} ${e.wasteUnit}` : "", e.batch, e.by, e.patient, e.detail, e.short ? +fmt(e.short) : "",
      e.value === null ? "" : e.value],
  });
}
/* ===================== Kit reconciliation ===================== */

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

// One row per injector + kit product, from every movement since the kit started
function reconcileKits(byId, kits, moves, loans) {
  const rows = new Map();
  const names = new Map();
  kits.forEach((k) => { if (k.staffUid) names.set(k.staffUid, k.staffName); });
  moves.forEach((m) => { if (m.byUid && m.by && !names.has(m.byUid)) names.set(m.byUid, m.by); });
  loans.forEach((l) => {
    if (l.toUid && !names.has(l.toUid)) names.set(l.toUid, l.toName);
    if (l.fromUid && !names.has(l.fromUid)) names.set(l.fromUid, l.fromName);
  });
  const uidByName = new Map([...names].map(([u, n]) => [String(n || "").trim().toLowerCase(), u]));

  const rowFor = (uid, pid, fallbackName) => {
    const key = `${uid}|${pid}`;
    let r = rows.get(key);
    if (!r) {
      const p = byId.get(pid);
      r = {
        key, uid, productId: pid, staffName: names.get(uid) || fallbackName || "Unknown",
        productName: (p && p.name) || "Unknown product", unit: (p && p.doseUnit) || "units", perUnit: perDose(p),
        taken: 0, borrowedIn: 0, lentOut: 0, used: 0, discarded: 0, returned: 0, adjusted: 0, now: 0, disputed: 0, events: [],
      };
      rows.set(key, r);
    }
    return r;
  };
  const log = (r, at, what, change, note = "") => r.events.push({ at, what, change: round1(change), note });

  moves.forEach((m) => {
    const p = byId.get(m.productId);
    const per = Number((p && p.dosePer) || 0);
    const vialUnit = (p && p.stockUnit) || "vial";
    const kitDelta = (m.lines || []).filter((l) => l.loc === "kit").reduce((a, l) => a + (Number(l.delta) || 0), 0);
    if (m.type === "kit-take" || m.type === "kit-return") {
      const units = Math.abs(kitDelta) * per;
      if (!(units > 0) || !m.byUid) return;
      const r = rowFor(m.byUid, m.productId, m.by);
      if (m.type === "kit-take") { r.taken += units; log(r, m.at, `Taken from the Shelf (${plural(Math.abs(kitDelta), vialUnit)})`, units); }
      else { r.returned += units; log(r, m.at, `Returned to the Shelf (${plural(Math.abs(kitDelta), vialUnit)})`, -units); }
    } else if (m.type === "kit-use") {
      const units = -kitDelta; // kit lines on treatment records are already in units
      if (!(units > 0) || !m.byUid) return;
      const r = rowFor(m.byUid, m.productId, m.by);
      r.used += units;
      log(r, m.at, "Used in treatment", -units, m.note || "");
    } else if (m.type === "kit-discard") {
      let units = Number(m.discardUnits);
      if (!Number.isFinite(units)) {
        const open = Number((/([\d.]+)\s+\S+\s+from the opened vial/.exec(m.note || "") || [])[1]) || 0;
        units = open + Math.abs(kitDelta) * per;
      }
      if (!(units > 0) || !m.byUid) return;
      const r = rowFor(m.byUid, m.productId, m.by);
      r.discarded += units;
      log(r, m.at, "Discarded", -units, [m.reason, m.note].filter(Boolean).join(" · "));
    } else if (m.type === "kit-count") {
      const owner = m.staffUid || uidByName.get(String(m.note || "").split("'s kit")[0].trim().toLowerCase());
      let units = Number(m.deltaUnits);
      if (!Number.isFinite(units)) units = Number((/(?:^|·\s)([+-]?\d+(?:\.\d+)?)\s+\S+/.exec(m.note || "") || [])[1]) || 0;
      if (!owner || !units) return;
      const r = rowFor(owner, m.productId, "");
      r.adjusted += units;
      log(r, m.at, "Count difference accepted", units, m.by ? `by ${m.by}` : "");
    }
  });

  loans.forEach((l) => {
    const u = Number(l.units) || 0;
    if (!(u > 0)) return;
    const note = l.status === "disputed" ? "Disputed" : l.status === "unconfirmed" ? "Not confirmed yet" : "";
    if (l.toUid) {
      const r = rowFor(l.toUid, l.productId, l.toName);
      r.borrowedIn += u;
      if (l.status === "disputed") r.disputed++;
      log(r, l.createdAt, `Borrowed from ${l.fromName || "a colleague"}`, u, note);
    }
    if (l.fromUid) {
      const r = rowFor(l.fromUid, l.productId, l.fromName);
      r.lentOut += u;
      if (l.status === "disputed") r.disputed++;
      log(r, l.createdAt, `Lent to ${l.toName || "a colleague"}`, -u, note);
    }
  });

  kits.forEach((k) => { const r = rowFor(k.staffUid, k.productId, k.staffName); r.now = round1(r.now + kitUnits(k)); });

  return [...rows.values()].map((r) => {
    const expected = round1(r.taken + r.borrowedIn - r.lentOut - r.used - r.discarded - r.returned + r.adjusted);
    const gap = round1(r.now - expected);
    r.events.sort((a, b) => (a.at ? a.at.getTime() : 0) - (b.at ? b.at.getTime() : 0));
    let bal = 0;
    r.events.forEach((e) => { bal = round1(bal + e.change); e.balance = bal; });
    return { ...r, expected, gap, ok: Math.abs(gap) < 0.05,
      gapValue: r.perUnit === null ? null : Math.round(r.perUnit * gap * 100) / 100 };
  }).sort((a, b) => Number(a.ok) - Number(b.ok)
    || a.staffName.localeCompare(b.staffName, "en-AU") || a.productName.localeCompare(b.productName, "en-AU"));
}

function mountKitRecon(body) {
  const st = { rows: [], gapsOnly: false };
  const n = (v) => (v ? fmt(v) : "—");

  async function load() {
    body.innerHTML = SKELETON;
    try {
      const [products, kits, moves, loans] = await Promise.all([listProducts(), listKits(), listKitMoves(), listAllLoans()]);
      st.rows = reconcileKits(new Map(products.map((p) => [p.id, p])), kits, moves, loans);
      if (body.isConnected) draw();
    } catch (err) {
      console.error("Kit reconciliation failed:", err);
      if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the kits. Try again."))}</div>`;
    }
  }

  function histHtml(r) {
    const ev = r.events.slice().reverse().slice(0, 200);
    return `<div class="rp-hist"><table class="inv-table">
      <thead><tr><th>Date</th><th>What happened</th><th>Change</th><th>Balance</th><th>Details</th></tr></thead>
      <tbody>${ev.map((e) => `<tr><td>${esc(shortDate(e.at))}</td><td>${esc(e.what)}</td>
        <td class="${e.change < 0 ? "rp-neg" : "rp-pos"}">${e.change > 0 ? "+" : ""}${esc(fmt(e.change))}</td>
        <td>${esc(fmt(e.balance))}</td><td>${esc(e.note || "")}</td></tr>`).join("")}</tbody></table>
      ${r.events.length > 200 ? `<p class="muted rp-note">Showing the latest 200 of ${r.events.length}.</p>` : ""}
      ${r.ok ? "" : `<p class="rp-note"><strong>To fix:</strong> ask ${esc(r.staffName)} to do a kit check (Task Manager → Opening count → My kit),
        then Accept the difference in Count differences.</p>`}</div>`;
  }

  function rowHtml(r) {
    return `<tr class="${r.ok ? "" : "is-diff"}">
      <td><strong>${esc(r.staffName)}</strong>${r.disputed ? ' <span class="inv-flag is-bad">Disputed borrow</span>' : ""}</td>
      <td>${esc(r.productName)} <small class="muted">(${esc(r.unit)})</small></td>
      <td>${n(r.taken)}</td><td>${n(r.borrowedIn)}</td><td>${n(r.lentOut)}</td><td>${n(r.used)}</td>
      <td>${n(r.discarded)}</td><td>${n(r.returned)}</td>
      <td>${r.adjusted ? `${r.adjusted > 0 ? "+" : ""}${fmt(r.adjusted)}` : "—"}</td>
      <td>${esc(fmt(r.expected))}</td><td><strong>${esc(fmt(r.now))}</strong></td>
      <td>${r.ok ? '<span class="rp-ok">✓</span>' : `<strong class="${r.gap < 0 ? "rp-neg" : "rp-pos"}">${r.gap > 0 ? "+" : ""}${esc(fmt(r.gap))}</strong>${
        r.gapValue !== null ? ` <small class="muted">${esc(money(r.gapValue))}</small>` : ""}`}</td>
      <td><button type="button" class="lh-btn" data-hist="${esc(r.key)}">History</button></td></tr>
      <tr class="rp-sub" data-histrow="${esc(r.key)}" hidden><td colspan="13">${histHtml(r)}</td></tr>`;
  }

  function draw() {
    const gaps = st.rows.filter((r) => !r.ok);
    const rows = st.gapsOnly ? gaps : st.rows;
    const gapValue = gaps.reduce((a, r) => a + Math.abs(r.gapValue || 0), 0);
    body.innerHTML = `
      <div class="inv-tools">
        <label class="fe-check"><input type="checkbox" data-f="gaps"${st.gapsOnly ? " checked" : ""} /> Only show gaps</label>
        <span class="inv-spacer"></span>
        <button type="button" class="ff-btn" data-act="refresh">Refresh</button>
        <button type="button" class="ff-btn" data-act="csv">Export CSV</button>
      </div>
      <p class="muted rp-range">Since each kit started: <strong>taken + borrowed in − lent out − used − discarded − returned ± counts accepted</strong>
        should equal what's in the kit now. A gap means something wasn't recorded.</p>
      <div class="inv-stats">
        <div class="inv-stat"><strong>${new Set(st.rows.map((r) => r.uid)).size}</strong><span>Injectors</span></div>
        <div class="inv-stat"><strong>${st.rows.length - gaps.length}</strong><span>Kits that add up</span></div>
        <div class="inv-stat ${gaps.length ? "is-bad" : ""}"><strong>${gaps.length}</strong><span>With a gap</span></div>
        <div class="inv-stat ${gaps.length ? "is-bad" : ""}"><strong>${esc(money(gapValue))}</strong><span>Gaps (at cost)</span></div>
      </div>
      ${rows.length ? `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table rp-recon">
        <thead><tr><th>Injector</th><th>Product</th><th>Taken</th><th>Borrowed in</th><th>Lent out</th><th>Used</th>
          <th>Discarded</th><th>Returned</th><th>Counts</th><th>Should have</th><th>In kit now</th><th>Gap</th><th></th></tr></thead>
        <tbody>${rows.map(rowHtml).join("")}</tbody></table></div></section>`
        : `<div class="tm-empty">${st.gapsOnly ? "No gaps. Every kit adds up. 👍" : "No kit activity yet."}</div>`}`;
  }

  function exportCsv() {
    if (!st.rows.length) { showToast("Nothing to export."); return; }
    downloadCsv(`kit-reconciliation-${dayKey()}.csv`, [
      ["Injector", "Product", "Unit", "Taken", "Borrowed in", "Lent out", "Used", "Discarded", "Returned", "Counts accepted",
        "Should have", "In kit now", "Gap", "Gap value ($)", "Disputed borrows"],
      ...st.rows.map((r) => [r.staffName, r.productName, r.unit, r.taken, r.borrowedIn, r.lentOut, r.used, r.discarded, r.returned,
        r.adjusted, r.expected, r.now, r.gap, r.gapValue === null ? "" : r.gapValue, r.disputed]),
    ]);
  }

  body.addEventListener("click", (e) => {
    const h = e.target.closest("[data-hist]");
    if (h) {
      const row = body.querySelector(`[data-histrow="${CSS.escape(h.dataset.hist)}"]`);
      if (row) { row.hidden = !row.hidden; h.textContent = row.hidden ? "History" : "Hide"; }
      return;
    }
    if (e.target.closest('[data-act="refresh"]')) { load(); return; }
    if (e.target.closest('[data-act="csv"]')) exportCsv();
  });
  body.addEventListener("change", (e) => {
    if (e.target.dataset.f === "gaps") { st.gapsOnly = e.target.checked; draw(); }
  });
  load();
}

/* ===================== Saved short ===================== */

function mountShort(body, staff) {
  const st = { view: "open", list: [] };
  const shortText = (u) => u.lines.filter((l) => Number(l.short) > 0)
    .map((l) => `${l.name} by ${fmt(l.short)} ${l.kind === "kit" ? l.unit : unitPlural(l.unit)}`).join(", ");

  async function load() {
    body.innerHTML = SKELETON;
    try {
      st.list = await listShortAll();
      if (body.isConnected) draw();
    } catch (err) {
      console.error("Saved short failed:", err);
      if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the records. Try again."))}</div>`;
    }
  }

  function draw() {
    const open = st.list.filter((u) => !u.resolved);
    const rows = st.view === "open" ? open : st.view === "resolved" ? st.list.filter((u) => u.resolved) : st.list;
    body.innerHTML = `
      <div class="inv-tools">
        <div class="fe-seg">${[["open", `Open (${open.length})`], ["resolved", "Resolved"], ["all", "All"]].map(([v, l]) =>
          `<label class="fe-seg-btn"><input type="radio" name="rp-short" data-f="view" value="${v}"${st.view === v ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>
        <span class="inv-spacer"></span>
        <button type="button" class="ff-btn" data-act="csv">Export CSV</button>
      </div>
      <p class="muted rp-range">Treatment records saved when the system showed less stock than was used. The patient's record is right;
        the stock numbers were behind. Usually a count fixes it: count the product, Accept the difference in Count differences, then resolve it here.</p>
      ${rows.length ? `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table">
        <thead><tr><th>Date</th><th>Patient</th><th>Form</th><th>Staff</th><th>What was short</th><th></th></tr></thead>
        <tbody>${rows.map((u) => `<tr class="${u.resolved ? "" : "is-diff"}" data-id="${esc(u.id)}">
          <td>${esc(shortDate(u.at))}</td>
          <td>${u.submissionId ? `<a href="#/form-record/${encodeURIComponent(u.submissionId)}">${esc(u.patientName || "Treatment record")}</a>` : esc(u.patientName || "—")}</td>
          <td>${esc(u.formName || "—")}</td><td>${esc(u.by || "—")}</td>
          <td><strong class="rp-neg">${esc(shortText(u))}</strong></td>
          <td>${u.resolved
            ? `<div class="rp-done"><span class="rq-status is-accepted">Resolved</span><small>${esc(u.resolvedNote || "")}</small>
                <small>${esc([u.resolvedBy, shortDate(u.resolvedAt)].filter(Boolean).join(" · "))}</small></div>`
            : '<div class="rp-acts"><button type="button" class="lh-btn is-primary" data-act="resolve">Resolve</button></div>'}</td>
        </tr>`).join("")}</tbody></table></div></section>`
        : `<div class="tm-empty">${st.view === "open" ? "Nothing saved short to sort out. 👍" : "Nothing here yet."}</div>`}`;
  }

  function resolve(u) {
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Resolve: ${esc(u.patientName || "treatment record")}</h3>
          <p>Short: <strong>${esc(shortText(u))}</strong>. Stock isn't changed here. Fix the numbers with a count first if needed.</p></div>
        <label class="lh-field"><span class="lh-label">How was it sorted out?</span>
          <textarea name="note" rows="3" maxlength="500" placeholder="e.g. Counted on 12 Oct, difference accepted"></textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Mark as resolved</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const note = form.elements.note.value.trim();
      if (!note) { err.textContent = "Add a short note saying how it was sorted out."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await resolveShort(u.id, note, staff);
        dlg.close();
        showToast("Resolved");
        load();
      } catch (ex) {
        console.error("Resolve failed:", ex);
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.elements.note.focus();
  }

  body.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="csv"]')) {
      if (!st.list.length) { showToast("Nothing to export."); return; }
      downloadCsv(`saved-short-${dayKey()}.csv`, [
        ["Date", "Patient", "Form", "Staff", "What was short", "Status", "Note", "Resolved by", "Resolved on"],
        ...st.list.map((u) => [u.at ? dayKey(u.at) : "", u.patientName || "", u.formName || "", u.by || "", shortText(u),
          u.resolved ? "Resolved" : "Open", u.resolvedNote || "", u.resolvedBy || "", u.resolvedAt ? dayKey(u.resolvedAt) : ""]),
      ]);
      return;
    }
    if (e.target.closest('[data-act="resolve"]')) {
      const tr = e.target.closest("tr[data-id]");
      const u = tr && st.list.find((x) => x.id === tr.dataset.id);
      if (u) resolve(u);
    }
  });
  body.addEventListener("change", (e) => {
    if (e.target.dataset.f === "view") { st.view = e.target.value; draw(); }
  });
  load();
}