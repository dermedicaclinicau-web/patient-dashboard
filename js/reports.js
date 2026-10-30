import {
  listProducts, listCounts, resolveCountLine, listUsageBetween, listMovesBetween,
  listKits, listKitMoves, listAllLoans, listShortAll, resolveShort, kitUnits,
  getUsage, correctUsage, correctionMove, changeUsageProduct, deleteUsage, listAllLots, isKitProduct, fefo,
  batchName, plural, unitPlural, dayKey, COUNT_STATUS,listInvestigations, INV_OUTCOMES, INV_STATUS,
  listUnrecordedTreatments, listContainersBetween, expectedUses,
  getBaseline, baselinePlan, setBaseline, listCountsOn, listKitDays,
} from "./inventory-api.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";
import { renderPlanReports } from "./plan-reports.js";
import { MOODS } from "./end-of-day-api.js";
import { mountPatientReport, PATIENT_TABS } from "./patient-reports.js";
import { mountRetention } from "./retention-report.js";
import { callApi } from "./appointments.js";
import { mountKitReconciliation } from "./kit-ledger.js";

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
const TABS = [["variance", "Count differences"], ["investigations", "Investigations"], ["check", "Treatment check"], ["notrecorded", "Not recorded"], ["wastage", "Wastage"],
  ["kits", "Kit reconciliation"], ["usage", "Usage"], ["opened", "Opened containers"], ["short", "Saved short"], ["plans", "Treatment plans"],
  ["retention", "Retention"]];
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

// The tabs in two labelled rows, so none are hidden off the right-hand edge
const TAB_GROUPS = [
  ["Stock & kits", ["variance", "investigations", "check", "notrecorded", "wastage", "kits", "usage", "opened", "short"]],
  ["Patients", ["plans", "retention"]],   // every other tab (the patient reports) joins this row
];
function tabGroupsHtml(tabs, cur) {
  const placed = new Set(TAB_GROUPS.flatMap(([, keys]) => keys));
  const link = ([k, l]) => `<a href="#/reports/${k}"${k === cur ? ' class="active" aria-current="page"' : ""}>${esc(l)}</a>`;
  return `<div class="rp-tabgroups">${TAB_GROUPS.map(([name, keys], i) => {
    const list = tabs.filter(([k]) => keys.includes(k) || (i === TAB_GROUPS.length - 1 && !placed.has(k)));
    return list.length ? `<div class="rp-tabgroup"><small>${esc(name)}</small>
      <nav class="pt-tabs inv-tabs rp-tabs" aria-label="Reporting: ${esc(name)}">${list.map(link).join("")}</nav></div>` : "";
  }).join("")}</div>`;
}

export function mountReports(container, { param = "", staff = null } = {}) {
  const first = String(param || "").split("/")[0];
  const tabs = can("reports.patients") ? TABS.concat(PATIENT_TABS) : TABS;
  const tab = tabs.some(([k]) => k === first) ? first : "variance";
  const root = document.createElement("section");
  root.className = "page wide";
  container.replaceChildren(root);
  if (!can("menu.reports")) {
    root.innerHTML = '<div class="state"><strong>No access</strong>Ask an Admin to give you Reporting access in Staff.</div>';
    return;
  }
  root.innerHTML = `
    <div class="fb-head"><div><h2>Reporting</h2><p class="muted">Count differences, wastage, kits and usage.</p></div></div>
    ${tabGroupsHtml(tabs, tab)}
    <div data-role="body">${SKELETON}</div>`;
  const body = root.querySelector('[data-role="body"]');
  if (tab === "variance") mountVariance(body, staff);
  else if (tab === "investigations") mountInvestigationReport(body);
  else if (tab === "check") mountTreatmentCheck(body, staff);
  else if (tab === "notrecorded") mountNotRecorded(body);
  else if (tab === "wastage") mountWastage(body);
  else if (tab === "usage") mountUsage(body, staff);
  else if (tab === "opened") mountOpened(body);
  else if (tab === "kits") mountKitRecon(body, staff);
  else if (tab === "plans") renderPlanReports(body, { staff });
  else if (PATIENT_TABS.some(([k]) => k === tab)) mountPatientReport(body, tab, staff);
  else if (tab === "retention") mountRetention(body);
  else mountShort(body, staff);
}

/* ===================== Count differences ===================== */

function mountVariance(body, staff) {
  const st = { view: "open", from: daysAgoKey(30), counts: [], products: new Map(), base: null, todayCounted: false };
  const canBase = can("inventory.manage");

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
      const [counts, products, base, today] = await Promise.all([
        st.view === "open" ? listCounts({ openOnly: true }) : listCounts({ from: st.from }),
        listProducts(),
        getBaseline().catch(() => null),
        canBase ? listCountsOn(dayKey()).catch(() => []) : Promise.resolve([]),
      ]);
      st.counts = counts;
      st.products = new Map(products.map((p) => [p.id, p]));
      st.base = base;
      st.todayCounted = today.some((c) => c.kind === "opening");
      if (body.isConnected) draw();
    } catch (err) {
      console.error("Count differences failed:", err);
      if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the counts. Try again."))}</div>`;
    }
  }

  // "Counting from…" and the button to set the starting stock
  function baseHtml() {
    const b = st.base;
    const again = b && b.dateKey === dayKey();
    const btn = canBase && st.todayCounted
      ? `<button type="button" class="ff-btn${b ? "" : " is-primary"}" data-act="baseline">${again
        ? "Update the starting stock from today's count" : "Set the starting stock from today's count"}</button>`
      : canBase ? '<small class="muted">Do today\'s opening count first, then set it as the starting stock here.</small>' : "";
    return `<div class="rp-base${b ? "" : " is-none"}">
      <div>${b
        ? `<strong>Counting from ${esc(niceDate(b.dateKey))}</strong>
           <small>Starting stock set${b.by ? ` by ${esc(b.by)}` : ""}${b.at ? ` at ${esc(timeOf(b.at))}` : ""}. Differences are compared with stock from then on.</small>`
        : `<strong>No starting stock set yet</strong>
           <small>${canBase ? "Once an opening count is finished, set it as the starting stock so every difference after that is a real one."
             : "An admin can set it from an opening count."}</small>`}</div>
      ${btn}</div>`;
  }

  function rowHtml(c, l, i) {
    const diff = Number(l.variance) || 0;
    const v = valueOf(l);
    const cls = (n) => (n < 0 ? "rp-neg" : "rp-pos");
    const status = l.status === "open" && c.superseded
      ? '<div class="rp-done"><span class="rq-status is-cancelled">Replaced</span><small>Recounted by the injector</small></div>'
      : l.status === "open"
      ? `<div class="rp-acts"><button type="button" class="lh-btn is-primary" data-act="accept">Accept</button>
          <button type="button" class="lh-btn" data-act="explain">Explain</button></div>`
      : l.status === "investigating"
        ? `<div class="rp-done"><a class="rq-status is-open" href="#/inventory/investigations/${encodeURIComponent(l.investigationId || "")}">Investigation →</a></div>`
        : `<div class="rp-done"><span class="rq-status is-${esc(l.status)}">${esc(COUNT_STATUS[l.status] || l.status)}</span>
          ${l.note ? `<small>${esc(l.note)}</small>` : ""}${l.resolvedBy ? `<small>${esc(l.resolvedBy)}</small>` : ""}</div>`;
    return `<tr class="${l.status === "open" ? "is-diff" : ""}" data-c="${esc(c.id)}" data-i="${i}">
      <td>${esc(l.productName)}${l.countNote ? `<br><small class="muted">“${esc(l.countNote)}”</small>` : ""}</td><td>${esc(whereOf(l))}</td>
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
        ${c.superseded ? '<span class="inv-flag is-info">Replaced by a corrected count</span>'
          : c.openCount ? `<span class="inv-flag is-warn">${c.openCount} to review</span>` : '<span class="inv-flag is-info">All reviewed</span>'}</div>
      <table class="inv-table rp-table"><thead><tr><th>Product</th><th>Where</th><th>Batch / Lot</th><th>Counted</th><th>System</th>
        <th>Difference</th><th>Value</th><th></th></tr></thead>
        <tbody>${rows.map(([l, i]) => rowHtml(c, l, i)).join("")}</tbody></table></section>`;
  }

  function draw() {
    const open = st.counts.flatMap((c) => c.lines).filter((l) => l.status === "open");
    const sum = (pred) => open.reduce((a, l) => { const v = valueOf(l); return a + (v !== null && pred(v) ? v : 0); }, 0);
    const groups = st.counts.map(groupHtml).join("");
    body.innerHTML = `
      ${baseHtml()}
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

  async function openBaseline() {
    const dlg = openDialog(`<div class="lh-form rp-bl"><div class="lh-dialog-head"><h3>Set the starting stock</h3>
      <p>Checking today's count…</p></div>${SKELETON}</div>`);
    let plan;
    try {
      plan = await baselinePlan();
    } catch (err) {
      console.error("Starting stock check failed:", err);
      if (dlg.open) dlg.querySelector(".lh-form").innerHTML = `<div class="lh-dialog-head"><h3>Set the starting stock</h3></div>
        <p class="lh-error">${esc(errText(err, "Couldn't check today's count. Try again."))}</p>
        <div class="lh-actions"><button type="button" class="lh-btn" data-act="cancel">Close</button></div>`;
      dlg.querySelector('[data-act="cancel"]')?.addEventListener("click", () => dlg.close());
      return;
    }
    if (!dlg.open) return;

    const ch = plan.items.filter((x) => x.state === "change");
    const match = plan.items.filter((x) => x.state === "match").length;
    const done = plan.items.filter((x) => x.state === "done").length;
    const olderBits = [plan.olderLines.length && plural(plan.olderLines.length, "difference"),
      plan.olderInvs.length && plural(plan.olderInvs.length, "investigation")].filter(Boolean);
    const where = (x) => `${LOC[x.loc] || x.loc}${x.line.batch ? ` · ${x.line.batchLabel || "Batch"} ${x.line.batch}` : ""}`;

    dlg.innerHTML = `<form class="lh-form rp-bl" novalidate>
      <div class="lh-dialog-head"><h3>Set the starting stock</h3>
        <p>Digital is set to match today's opening count (${plural(plan.items.length, "product and place")} counted).
          Every change is logged in Activity as “Starting stock set”. Injectors' kits aren't changed.</p></div>
      ${ch.length ? `<div class="rp-bl-scroll"><table class="inv-table rp-table">
        <thead><tr><th>Product</th><th>Where</th><th>Counted</th><th>Digital</th><th>Change</th></tr></thead>
        <tbody>${ch.map((x) => `<tr><td>${esc(x.product.name)}${x.invId ? ' <span class="inv-flag is-warn">Closes its investigation</span>' : ""}</td>
          <td>${esc(where(x))}</td><td>${esc(fmt(x.line.counted))}</td><td>${esc(fmt(x.line.system))}</td>
          <td class="${x.diff < 0 ? "rp-neg" : "rp-pos"}"><strong>${x.diff > 0 ? "+" : ""}${esc(fmt(x.diff))}</strong></td></tr>`).join("")}</tbody>
        </table></div>`
        : '<p class="tb-info">Everything counted today already matches digital, so stock won\'t change. Today is still saved as the starting point.</p>'}
      <ul class="rp-bl-sum">
        ${match ? `<li>${match} already match: no change</li>` : ""}
        ${done ? `<li>${done} already reviewed today (accepted, or investigation closed): left as they are</li>` : ""}
        ${plan.earlier.length ? `<li>${plural(plan.earlier.length, "earlier count")} of the same spot today: closed, the latest count is used</li>` : ""}
      </ul>
      ${plan.notCounted.length ? `<details class="rp-bl-miss"><summary>${plural(plan.notCounted.length, "product")} with stock weren't counted today: not changed</summary>
        <p>${esc(plan.notCounted.slice(0, 40).map((p) => p.name).join(", "))}${plan.notCounted.length > 40 ? "…" : ""}</p></details>` : ""}
      ${olderBits.length ? `<label class="fe-check"><input type="checkbox" name="older" checked />
        Also close ${esc(olderBits.join(" and "))} from before today <small class="muted">(stock isn't changed for these)</small></label>` : ""}
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">${ch.length ? `Set starting stock (${plural(ch.length, "change")})` : "Set starting stock"}</button>
      </div></form>`;

    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      const cancel = form.querySelector('[data-act="cancel"]');
      btn.disabled = true;
      cancel.disabled = true;
      err.hidden = true;
      try {
        const r = await setBaseline(plan, { closeOlder: !!(form.elements.older && form.elements.older.checked) }, staff,
          (t) => { btn.textContent = t; });
        dlg.close();
        showToast(r.changed ? `Starting stock set. ${plural(r.changed, "change")} made.` : "Starting stock set. Nothing needed changing.");
        load();
      } catch (ex) {
        console.error("Starting stock failed:", ex);
        err.textContent = `${errText(ex, "Couldn't finish.")} It's safe to try again: nothing is applied twice.`;
        err.hidden = false;
        btn.disabled = false;
        cancel.disabled = false;
        btn.textContent = "Try again";
      }
    });
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
      "Unit", "Value ($)", "Status", "Counter's comment", "Note", "Reviewed by"]];
    st.counts.forEach((c) => c.lines.forEach((l) => {
      if (!shown(l)) return;
      const v = valueOf(l);
      rows.push([c.dateKey || "", c.kind === "kit" ? "Kit check" : "Opening count", c.by || "", l.productName || "", whereOf(l),
        l.batch || "", l.expiry || "", Number(l.counted) || 0, Number(l.system) || 0, Number(l.variance) || 0, l.unit || "",
        v === null ? "" : v, COUNT_STATUS[l.status] || l.status || "", l.countNote || "", l.note || "", l.resolvedBy || ""]);
    }));
    if (rows.length === 1) { showToast("Nothing to export."); return; }
    downloadCsv(`count-differences-${dayKey()}.csv`, rows);
  }

  body.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "csv") { exportCsv(); return; }
    if (a.dataset.act === "baseline") { openBaseline(); return; }
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
    if (cfg.onClick && cfg.onClick(e, load)) return;
    if (!e.target.closest('[data-act="csv"]')) return;
    const ev = visible();
    if (!ev.length) { showToast("Nothing to export."); return; }
    downloadCsv(`${cfg.file}-${fileDates(st.r)}.csv`, [cfg.csvHead, ...ev.map(cfg.csvRow)]);
  });

  drawTools();
  load();
}

/* ===================== Investigations ===================== */

function mountInvestigationReport(body) {
  mountRangeReport(body, {
    name: "Investigations", file: "investigations",
    groups: [["type", "Outcome"], ["product", "Product"], ["month", "Month"], ["clinician", "Counted by"]],
    findPlaceholder: "Filter: product, outcome or staff",
    empty: "No investigations opened in these dates. 👍",
    async load(r) {
      const [products, list] = await Promise.all([listProducts(), listInvestigations()]);
      const byId = new Map(products.map((p) => [p.id, p]));
      return list.filter((x) => x.openedAt && x.openedAt >= r.from && x.openedAt < r.to).map((x) => {
        const diff = Number(x.recount ? x.recount.variance : x.variance) || 0;
        return {
          id: x.id, at: x.openedAt, productId: x.productId, productName: x.productName, by: x.openedBy || "",
          typeLabel: x.status === "closed" ? ((INV_OUTCOMES[x.outcome] || {}).label || "Closed") : (INV_STATUS[x.status] || x.status),
          open: x.status !== "closed", where: LOC[x.loc] || x.loc, batch: x.batch || "", diff, unit: x.unit || "item",
          applied: Number(x.applied) || 0, recountBy: x.recount ? x.recount.by || "" : "", closedBy: x.closedBy || "",
          note: x.outcomeNote || "", cctv: x.cctv && x.cctv.checked ? "Yes" : "",
          days: x.closedAt ? Math.max(0, Math.round((x.closedAt - x.openedAt) / 864e5)) : null,
          value: mul(perItem(byId.get(x.productId)), diff),
        };
      });
    },
    searchText: (e) => [e.productName, e.typeLabel, e.by, e.recountBy, e.closedBy, e.note, e.where].join(" "),
    statsHtml(ev) {
      const open = ev.filter((e) => e.open).length;
      const closed = ev.filter((e) => !e.open && e.days !== null);
      const down = ev.filter((e) => e.applied < 0 && e.value !== null).reduce((a, e) => a + e.value, 0);
      return `<div class="inv-stats">
        <div class="inv-stat ${open ? "is-warn" : ""}"><strong>${open}</strong><span>Still open</span></div>
        <div class="inv-stat"><strong>${ev.filter((e) => e.typeLabel === INV_OUTCOMES["count-error"].label).length}</strong><span>Count errors</span></div>
        <div class="inv-stat is-bad"><strong>${esc(money(Math.round(down * 100) / 100))}</strong><span>Taken off digital (at cost)</span></div>
        <div class="inv-stat"><strong>${closed.length ? fmt(closed.reduce((a, e) => a + e.days, 0) / closed.length) : "—"}</strong><span>Days to close (average)</span></div>
      </div>`;
    },
    summaryHead: (label) => `<thead><tr><th>${esc(label)}</th><th>Investigations</th><th>Still open</th><th>Value of differences</th></tr></thead>`,
    summaryRow: (g) => `<tr><td><strong>${esc(g.label)}</strong></td><td>${g.events.length}</td>
      <td>${g.events.filter((e) => e.open).length || "—"}</td><td>${esc(moneyOrDash(g.value))}</td></tr>`,
    summaryFoot: (ev) => `<tr><th>Total</th><th>${ev.length}</th><th>${ev.filter((e) => e.open).length}</th><th>${esc(moneyOrDash(sumValue(ev)))}</th></tr>`,
    detailHead: "<thead><tr><th>Opened</th><th>Product</th><th>Where</th><th>Difference</th><th>Outcome</th><th>Counted by</th><th>Recount by</th><th>Closed by</th><th>Value</th></tr></thead>",
    detailRow: (e) => `<tr><td>${esc(shortDate(e.at))}</td>
      <td><a href="#/inventory/investigations/${encodeURIComponent(e.id)}">${esc(e.productName)}</a></td>
      <td>${esc(e.where)}${e.batch ? ` · ${esc(e.batch)}` : ""}</td>
      <td class="${e.diff < 0 ? "rp-neg" : "rp-pos"}">${e.diff > 0 ? "+" : ""}${esc(fmt(e.diff))}</td>
      <td><span class="inv-flag ${e.open ? "is-warn" : "is-info"}">${esc(e.typeLabel)}</span></td>
      <td>${esc(e.by || "—")}</td><td>${esc(e.recountBy || "—")}</td><td>${esc(e.closedBy || "—")}</td><td>${esc(moneyOrDash(e.value))}</td></tr>`,
    csvHead: ["Opened", "Product", "Where", "Batch / Lot", "Difference", "Unit", "Outcome", "Counted by", "Recount by", "Closed by",
      "CCTV checked", "Days to close", "Note", "Value ($)"],
    csvRow: (e) => [e.at ? dayKey(e.at) : "", e.productName, e.where, e.batch, e.diff, e.unit, e.typeLabel, e.by, e.recountBy, e.closedBy,
      e.cctv, e.days === null ? "" : e.days, e.note, e.value === null ? "" : e.value],
  });
}

/* ===================== Booked, but nothing recorded ===================== */

function mountNotRecorded(body) {
  mountRangeReport(body, {
    name: "Not recorded", file: "booked-not-recorded",
    groups: [["clinician", "Clinician"], ["type", "Service"], ["patient", "Patient"], ["month", "Month"]],
    findPlaceholder: "Filter: patient, clinician or service",
    empty: "Every booking with a linked service has a treatment record. 👍",
    async load(r) {
      // Up to yesterday: today's treatments may not be written up yet
      const yesterday = new Date();
      yesterday.setHours(0, 0, 0, 0);
      yesterday.setDate(yesterday.getDate() - 1);
      const last = lastDay(r) < yesterday ? lastDay(r) : yesterday;
      const [products, res] = await Promise.all([
        listProducts(), listUnrecordedTreatments({ fromKey: dayKey(r.from), toKey: dayKey(last) }),
      ]);
      if (!res.configured) throw new Error("No services are linked to products yet. An admin can link them in Inventory → Service links.");
      const names = new Map(products.map((p) => [p.id, p.name]));
      return res.items.map((b) => ({
        at: parseKey(b.dateKey), time: b.time, by: b.staff || "Unassigned", patient: b.patientName || "", patientId: b.patientId || "",
        typeLabel: b.services.join(", "), productId: b.services.join(", "), productName: b.services.join(", "),
        expected: b.productIds.map((id) => names.get(id)).filter(Boolean).join(" / "), value: 0,
      }));
    },
    searchText: (e) => [e.patient, e.by, e.typeLabel, e.expected].join(" "),
    statsHtml: (ev) => `<div class="inv-stats">
      <div class="inv-stat is-warn"><strong>${ev.length}</strong><span>Bookings with nothing recorded</span></div>
      <div class="inv-stat"><strong>${new Set(ev.map((e) => e.by)).size}</strong><span>Clinicians</span></div>
      <div class="inv-stat"><strong>${new Set(ev.map((e) => e.patientId || e.patient)).size}</strong><span>Patients</span></div>
      <div class="inv-stat"><strong>${new Set(ev.map((e) => e.typeLabel)).size}</strong><span>Services</span></div>
    </div>`,
    summaryHead: (label) => `<thead><tr><th>${esc(label)}</th><th>Bookings</th></tr></thead>`,
    summaryRow: (g) => `<tr><td><strong>${esc(g.label)}</strong></td><td>${g.events.length}</td></tr>`,
    summaryFoot: (ev) => `<tr><th>Total</th><th>${ev.length}</th></tr>`,
    detailHead: "<thead><tr><th>Date</th><th>Patient</th><th>Service</th><th>Clinician</th><th>Expected one of</th></tr></thead>",
    detailRow: (e) => `<tr><td>${esc(shortDate(e.at))}${e.time ? ` <small class="muted">${esc(e.time)}</small>` : ""}</td>
      <td>${e.patientId ? `<a href="#/patient/${encodeURIComponent(e.patientId)}">${esc(e.patient || "Patient")}</a>` : esc(e.patient || "—")}</td>
      <td>${esc(e.typeLabel)}</td><td>${esc(e.by)}</td><td>${esc(e.expected || "—")}</td></tr>`,
    csvHead: ["Date", "Time", "Patient", "Patient ID", "Service", "Clinician", "Expected one of"],
    csvRow: (e) => [e.at ? dayKey(e.at) : "", e.time, e.patient, e.patientId, e.typeLabel, e.by, e.expected],
  });
}

/* ===================== Treatment check (booking → record → products → stock) ===================== */

const TC_STATUS = {
  none: ["No record", "is-bad"], noneed: ["No record needed", "is-info"], noproduct: ["Record, no product", "is-warn"],
  notstock: ["Not taken off stock", "is-warn"], before: ["Before stock started", "is-info"], ok: ["Accounted for", "is-ok"],
};
const tcLabel = (s) => (TC_STATUS[s] || ["Unknown", ""])[0];
const tcPill = (s) => `<span class="inv-flag ${(TC_STATUS[s] || ["", ""])[1]}">${esc(tcLabel(s))}</span>`;

function mountTreatmentCheck(body, staff) {
  let products = [];
  let rowsByKey = new Map();
  const canAlias = can("inventory.manage");
  const nameOf = (pid) => ((products.find((p) => p.id === pid) || {}).name || "product");
  const recordHtml = (e) => (e.records.length ? e.records.map((r) => (r.link
    ? `<a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.label)}</a>`
    : esc(r.label)) + (r.noCons ? ' <small class="muted">no products read</small>' : "")).join("<br>") : '<span class="muted">—</span>');
  const productsHtml = (e) => {
    const lines = e.products.map((p) => `<div>${esc(p.name)} × ${esc(fmt(p.amount))}${p.unit ? ` ${esc(p.unit)}` : ""}${
      p.batch ? `<small class="muted">Batch ${esc(p.batch)}${p.expiry ? ` · Exp ${esc(p.expiry)}` : ""}</small>` : '<small class="rp-neg">No batch</small>'}${
      p.short > 0 ? `<small class="rp-neg">saved short · ${esc(fmt(p.short))}</small>` : ""}${
      p.src === "scan" ? '<small class="muted">read from the scan</small>' : p.src === "legacy" ? '<small class="muted">logged from the scan</small>'
      : p.src === "usage" && p.usageId && canAlias ? ` <button type="button" class="kr-link" data-correct="${esc(p.usageId)}">Correct</button>` : ""}</div>`);
    e.unmatched.forEach((n) => lines.push(`<div class="muted">${esc(n)}${canAlias ? ` <button type="button" class="kr-link" data-alias="${esc(n)}">Match to product</button>` : ""}</div>`));
    return lines.join("") || '<span class="muted">—</span>';
  };
  const actionHtml = (e) => {
    const scan = e.records.find((r) => r.kind === "scan");
    const out = [];
    if (e.status === "none") out.push(`<a href="#/paper" target="_blank" rel="noopener">Enter from paper</a>`,
      `<button type="button" class="kr-link" data-noneed="${esc(e.key)}">No record needed</button>`);
    if (scan && (e.status === "noproduct" || e.products.some((p) => p.src !== "usage" && !p.batch))) {
      out.push(`<button type="button" class="kr-link" data-logbatch="${esc(scan.id)}">${scan.logged ? "Edit logged batch" : "Log batch"}</button>`);
    }
    if ((e.status === "none" || e.status === "noproduct") && e.patientId) {
      e.expects.filter((pid) => !["kit", "shared"].includes((products.find((p) => p.id === pid) || {}).usage)).slice(0, 3)
        .forEach((pid) => out.push(`<button type="button" class="kr-link" data-use="${esc(pid)}">Record ${esc(nameOf(pid))}</button>`));
    }
    if (e.status === "notstock" && e.products.some((p) => p.short > 0)) out.push('<a href="#/reports/short">Open Saved short</a>');
    if (e.different) out.push(`<small class="muted">Booked for ${esc(e.expectsNames.join(" / "))}</small>`);
    if (e.unbooked) out.push('<small class="muted">Not in the appointment book</small>');
    return out.join(" · ");
  };

  mountRangeReport(body, {
    name: "Treatment check", file: "treatment-check",
    groups: [["type", "Status"], ["product", "Product"], ["clinician", "Clinician"], ["patient", "Patient"], ["month", "Month"]],
    findPlaceholder: "Filter: patient, product, batch or status",
    empty: "No bookings of a linked service in these dates.",
    async load(r) {
      const res = await callApi({ action: "inventory", op: "treatmentCheck", from: dayKey(r.from), to: dayKey(lastDay(r)) });
      if (!res || res.problem) throw new Error((res && res.problem) || "The check couldn't be run.");
      products = res.products || [];
      rowsByKey = new Map((res.rows || []).map((row) => [row.key, row]));
      return (res.rows || []).map((row) => {
        const first = row.products[0] || null;
        const pname = (first && first.name) || row.expectsNames[0] || row.booked[0] || "Unlinked";
        return { ...row, at: parseKey(row.date), by: row.staff || "Unassigned", patient: row.patientName || "",
          typeLabel: tcLabel(row.status), productId: (first && first.productId) || row.expects[0] || pname, productName: pname, value: 0 };
      });
    },
    searchText: (e) => [e.patientName, e.by, e.booked.join(" "), e.typeLabel, e.productName,
      e.products.map((p) => `${p.name} ${p.batch}`).join(" "), e.unmatched.join(" ")].join(" "),
    statsHtml(ev) {
      const n = (s) => ev.filter((e) => e.status === s).length;
      return `<div class="inv-stats">
        <div class="inv-stat"><strong>${n("ok")}</strong><span>Accounted for</span></div>
        <div class="inv-stat ${n("none") ? "is-bad" : ""}"><strong>${n("none")}</strong><span>No record</span></div>
        <div class="inv-stat ${n("noproduct") ? "is-warn" : ""}"><strong>${n("noproduct")}</strong><span>Record, no product</span></div>
        <div class="inv-stat ${n("notstock") ? "is-warn" : ""}"><strong>${n("notstock")}</strong><span>Not taken off stock</span></div>
        <div class="inv-stat"><strong>${n("before") + n("noneed")}</strong><span>Before stock started · no record needed</span></div>
      </div>`;
    },
    summaryHead: (label) => `<thead><tr><th>${esc(label)}</th><th>Visits</th><th>Accounted for</th><th>No record</th><th>Record, no product</th><th>Not taken off stock</th></tr></thead>`,
    summaryRow: (g) => {
      const n = (s) => g.events.filter((e) => e.status === s).length;
      return `<tr><td><strong>${esc(g.label)}</strong></td><td>${g.events.length}</td><td>${n("ok") || "—"}</td>
        <td>${n("none") ? `<span class="rp-neg">${n("none")}</span>` : "—"}</td><td>${n("noproduct") || "—"}</td><td>${n("notstock") || "—"}</td></tr>`;
    },
    summaryFoot: (ev) => {
      const n = (s) => ev.filter((e) => e.status === s).length;
      return `<tr><th>Total</th><th>${ev.length}</th><th>${n("ok")}</th><th>${n("none")}</th><th>${n("noproduct")}</th><th>${n("notstock")}</th></tr>`;
    },
    detailHead: "<thead><tr><th>Date</th><th>Patient</th><th>Clinician</th><th>Booked</th><th>Record</th><th>Product on record</th><th>Status</th></tr></thead>",
    detailRow: (e) => `<tr class="${e.status === "none" || e.status === "notstock" || e.status === "noproduct" ? "is-diff" : ""}" data-key="${esc(e.key)}">
      <td>${esc(shortDate(e.at))}${e.time ? ` <small class="muted">${esc(e.time)}</small>` : ""}</td>
      <td>${e.patientId ? `<a href="#/patient/${encodeURIComponent(e.patientId)}" target="_blank" rel="noopener">${esc(e.patient || "Patient")}</a>` : esc(e.patient || "—")}</td>
      <td>${esc(e.by)}</td>
      <td>${esc(e.booked.join(", ") || "—")}${e.expectsNames.length ? `<small class="muted">expects ${esc(e.expectsNames.join(" / "))}</small>` : ""}</td>
      <td>${recordHtml(e)}</td><td>${productsHtml(e)}</td>
      <td>${tcPill(e.status)}${e.res && e.res.note ? `<small class="muted">${esc(e.res.note)}</small>` : ""}<small>${actionHtml(e)}</small></td></tr>`,
    csvHead: ["Date", "Time", "Patient", "Patient ID", "Clinician", "Booked", "Expected product", "Record", "Products", "Batches", "Status", "Note"],
    csvRow: (e) => [e.date, e.time, e.patient, e.patientId, e.by, e.booked.join("; "), e.expectsNames.join("; "),
      e.records.map((r) => r.label).join("; "), e.products.map((p) => `${p.name} x${fmt(p.amount)} ${p.unit}`.trim()).join("; "),
      e.products.map((p) => p.batch).filter(Boolean).join("; "), e.typeLabel, e.res ? e.res.note : ""],
    onClick(ev, reload) {
      const nn = ev.target.closest("[data-noneed]");
      if (nn) {
        const note = window.prompt("Why is no record needed? (e.g. review only, no injection given)");
        if (note && note.trim()) {
          callApi({ action: "paper", op: "resolve", key: nn.dataset.noneed, status: "none", note: note.trim() })
            .then((r) => { if (r && r.problem) showToast(r.problem); else reload(); })
            .catch(() => showToast("Couldn't save it. You need Paper records access to mark a visit as needing no record."));
        }
        return true;
      }
      const use = ev.target.closest("[data-use]");
      if (use) {
        const tr = use.closest("tr[data-key]");
        const row = tr ? rowsByKey.get(tr.dataset.key) : null;
        if (!row) return true;
        const rec = row.records.find((r) => r.kind === "portal") || null;
        import("./inventory.js")
          .then((m) => m.openPaperUse({ productId: use.dataset.use, patientId: row.patientId, patientName: row.patientName,
            date: row.date, submissionId: rec ? rec.id : "", formName: rec ? rec.label : "", staff }))
          .then((saved) => { if (saved) reload(); })
          .catch((e) => showToast((e && e.message) || "Couldn't open it. Try again."));
        return true;
      }

      const cu = ev.target.closest("[data-correct]");
      if (cu) { openCorrection(cu.dataset.correct, staff, reload); return true; }
      const al = ev.target.closest("[data-alias]");
      if (al) { tcAliasDialog(al.dataset.alias, products, reload); return true; }
      const lb = ev.target.closest("[data-logbatch]");
      if (lb) {
        const tr = lb.closest("tr[data-key]");
        tcLogDialog(lb.dataset.logbatch, tr ? tr.dataset.key : "", products, reload);
        return true;
      }
      return false;
    },
  });
}

function tcAliasDialog(name, products, onDone) {
  const dlg = openDialog(`<form class="lh-form" novalidate>
    <div class="lh-dialog-head"><h3>Match to product</h3><p>The old app wrote <strong>${esc(name)}</strong>. Which product is it? Every record with that name will use it.</p></div>
    <label class="lh-field"><span class="lh-label">Product</span><select class="fb-select" name="productId">
      <option value="">Not a stocked product (leave as text)</option>
      ${products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
    <p class="lh-error" role="alert" hidden></p>
    <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
      <button type="submit" class="lh-btn is-primary">Save</button></div></form>`);
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const r = await callApi({ action: "inventory", op: "legacyAlias", name, productId: form.elements.productId.value });
      if (r && r.problem) throw new Error(r.problem);
      dlg.close();
      showToast("Saved");
      onDone();
    } catch (ex) {
      err.textContent = (ex && ex.message) || "Couldn't save. Try again.";
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

function tcLogDialog(recordId, key, products, onDone) {
  const opts = products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  const line = () => `<div class="rp-cin tc-line">
    <select class="fb-select" data-k="productId"><option value="">Product…</option>${opts}</select>
    <input class="fe-in" type="number" min="0" step="0.1" data-k="amount" value="1" style="width:5em" aria-label="Amount" />
    <input class="fe-in" data-k="batch" placeholder="Batch / lot" aria-label="Batch" />
    <input class="fe-in" data-k="expiry" placeholder="Exp YYYY-MM" aria-label="Expiry" style="width:8em" /></div>`;
  const dlg = openDialog(`<form class="lh-form" novalidate>
    <div class="lh-dialog-head"><h3>Log batch from the scan</h3>
      <p>Open the PDF beside this, and type what's on the paper. It's kept against the record for Batch lookup and this check. Stock isn't changed.</p></div>
    <div data-role="lines">${line()}</div>
    <button type="button" class="lh-btn" data-act="more">+ Another product</button>
    <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="300" placeholder="e.g. lot read from the sticker on page 2" /></label>
    <p class="lh-error" role="alert" hidden></p>
    <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
      <button type="submit" class="lh-btn is-primary">Save</button></div></form>`);
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  dlg.querySelector('[data-act="more"]').addEventListener("click", () => form.querySelector('[data-role="lines"]').insertAdjacentHTML("beforeend", line()));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const lines = [...form.querySelectorAll(".tc-line")].map((el) => ({
      productId: el.querySelector('[data-k="productId"]').value, amount: Number(el.querySelector('[data-k="amount"]').value) || 1,
      batch: el.querySelector('[data-k="batch"]').value.trim(), expiry: el.querySelector('[data-k="expiry"]').value.trim(),
    })).filter((l) => l.productId);
    if (!lines.length) { err.textContent = "Choose at least one product."; err.hidden = false; return; }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const r = await callApi({ action: "inventory", op: "legacyLog", recordId, lines, note: form.elements.note.value });
      if (r && r.problem) throw new Error(r.problem);
      dlg.close();
      showToast("Logged");
      onDone();
    } catch (ex) {
      err.textContent = (ex && ex.message) || "Couldn't save. Try again.";
      err.hidden = false;
      btn.disabled = false;
    }
  });
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
    } else if (m.type === "shared-finish" && m.reason && m.reason !== "Empty") {
      // An opened container thrown away before it was used up: what was left of it
      const exp = Number(m.expectedUses) || 0;
      const uses = Number(m.uses) || 0;
      const left = exp ? Math.max(0, 1 - uses / exp) : 1;
      if (!(left > 0)) return;
      out.push({
        at: m.at, type: "opened", typeLabel: "Opened one discarded", productId: m.productId, productName: m.productName,
        amount: Math.round(left * 100) / 100, unit: (p && p.stockUnit) || m.unit || "item", plain: false, by: m.by || "",
        patient: "", patientId: "", batch,
        detail: [m.reason, `${plural(uses, "use")}${exp ? ` of about ${exp}` : ""}`].join(" · "),
        value: mul(perItem(p), left),
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
        listProducts(), listUsageBetween(r.from, r.to), listMovesBetween(r.from, r.to, ["kit-discard", "writeoff", "shared-finish"]),
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
    if (l.kind === "shared") {
      const rows = l.rows || [];
      const opened = rows.filter((r) => r.opened).length;
      out.push({
        at: u.at, productId: l.productId, productName: l.name, kit: false, dosed: false, shared: true,
        amount: rows.length, unit: "use", plain: true, dose: Number(l.doseTotal) || 0, doseUnit: l.doseUnit || "",
        items: opened, itemUnit: l.unit, opened, waste: 0, wasteUnit: "", short: Number(l.short) || 0,
        by: u.by || "", patient: u.patientName || "", patientId: u.patientId || "",
        detail: u.formName || "", submissionId: u.submissionId || "", usageId: u.id, corrected: u.corrected === true,
        batch: [...new Set(rows.map((r) => r.batch).filter(Boolean))].join(", "),
        value: mul(perItem(p), opened),   // the cost lands when a container is opened
      });
      return;
    }
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
      usageId: u.id, corrected: u.corrected === true,
      batch: [...new Set((l.rows || []).map((r) => r.batch).filter(Boolean))].join(", "),
      value: kit ? mul(perDose(p), items) : mul(perItem(p), items),
    });
  }));
  return out;
}
const useAmount = (e) => (e.shared
  ? `${plural(e.amount, "use")}${e.dose ? ` (${fmt(e.dose)} ${e.doseUnit})` : ""}${e.opened ? ` · opened ${plural(e.opened, e.itemUnit)}` : ""}`
  : e.dosed ? `${amt(e.amount, e.unit, false)} (${plural(+fmt(e.items), e.itemUnit)})` : amt(e.amount, e.unit, e.plain));
const treatments = (ev) => new Set(ev.map((e) => e.submissionId || `${e.patientId}|${e.at && e.at.getTime()}`)).size;

function mountUsage(body, staff) {
  const canCorrect = can("inventory.manage");
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
    detailHead: `<thead><tr><th>Date</th><th>Product</th><th>Amount</th><th>Batch / Lot</th><th>Staff</th><th>Patient</th><th>Value</th>${
      canCorrect ? "<th></th>" : ""}</tr></thead>`,
    detailRow: (e) => `<tr>
      <td>${esc(shortDate(e.at))}</td>
      <td>${esc(e.productName)}${e.short > 0 ? ' <span class="inv-flag is-bad">Saved short</span>' : ""}${
        e.corrected ? ' <span class="inv-flag is-info">Corrected</span>' : ""}</td>
      <td>${esc(useAmount(e))}${e.waste > 0 ? ` <small class="muted">· ${esc(fmt(e.waste))} ${esc(e.wasteUnit)} discarded</small>` : ""}</td>
      <td>${esc(e.batch || "—")}</td><td>${esc(e.by || "—")}</td>
      <td>${e.submissionId ? `<a href="#/form-record/${encodeURIComponent(e.submissionId)}">${esc(e.patient || "Treatment record")}</a>` : esc(e.patient || "—")}</td>
      <td>${esc(moneyOrDash(e.value))}</td>
      ${canCorrect ? `<td>${e.shared ? "" : `<button type="button" class="lh-btn" data-correct="${esc(e.usageId)}">Correct</button>`}</td>` : ""}</tr>`,
    csvHead: ["Date", "Product", "Amount", "Unit", "Syringes / items", "Discarded", "Batch / Lot", "Staff", "Patient", "Form", "Saved short",
      "Corrected", "Value ($)"],
    csvRow: (e) => [e.at ? dayKey(e.at) : "", e.productName, +fmt(e.amount), e.unit, e.kit ? "" : +fmt(e.items),
      e.waste ? `${fmt(e.waste)} ${e.wasteUnit}` : "", e.batch, e.by, e.patient, e.detail, e.short ? +fmt(e.short) : "",
      e.corrected ? "Yes" : "", e.value === null ? "" : e.value],
    onClick(e, reload) {
      const b = e.target.closest("[data-correct]");
      if (!b) return false;
      openCorrection(b.dataset.correct, staff, reload);
      return true;
    },
  });
}

/* ===================== Opened containers (shared products) ===================== */

function mountOpened(body) {
  const usesText = (e) => `${e.uses}${e.expected ? ` of about ${e.expected}` : ""}`;
  mountRangeReport(body, {
    name: "Opened containers", file: "opened-containers",
    groups: [["product", "Product"], ["type", "Status"], ["month", "Month"], ["clinician", "Opened by"]],
    findPlaceholder: "Filter: product, batch or staff",
    empty: "No shared products were opened in these dates.",
    async load(r) {
      const [products, list] = await Promise.all([listProducts(), listContainersBetween(r.from, r.to)]);
      const byId = new Map(products.map((p) => [p.id, p]));
      return list.map((c) => {
        const exp = expectedUses(c);
        const open = c.status === "open";
        return {
          id: c.id, at: c.openedAt, productId: c.productId, productName: c.productName, by: c.openedBy || "",
          typeLabel: open ? "Still open" : (c.finishReason || "Finished"), open, uses: c.uses, expected: exp,
          used: c.used, doseUnit: c.doseUnit, batch: c.batch, unit: c.unit,
          low: !open && !!exp && c.uses < exp * 0.7,
          finishedAt: c.finishedAt, finishedBy: c.finishedBy || "", note: c.finishNote || "",
          days: c.finishedAt && c.openedAt ? Math.max(0, Math.round((c.finishedAt - c.openedAt) / 864e5)) : null,
          value: perItem(byId.get(c.productId)),
        };
      });
    },
    searchText: (e) => [e.productName, e.batch, e.by, e.finishedBy, e.typeLabel, e.note].join(" "),
    statsHtml(ev) {
      const done = ev.filter((e) => !e.open && e.expected);
      const avg = done.length ? Math.round(done.reduce((a, e) => a + e.uses / e.expected, 0) / done.length * 100) : null;
      const low = ev.filter((e) => e.low).length;
      return `<div class="inv-stats">
        <div class="inv-stat"><strong>${ev.length}</strong><span>Opened</span></div>
        <div class="inv-stat"><strong>${ev.filter((e) => e.open).length}</strong><span>Still open</span></div>
        <div class="inv-stat ${low ? "is-warn" : ""}"><strong>${low}</strong><span>Fewer uses than expected</span></div>
        <div class="inv-stat"><strong>${avg === null ? "—" : `${avg}%`}</strong><span>Uses vs expected (average)</span></div>
      </div>`;
    },
    summaryHead: (label) => `<thead><tr><th>${esc(label)}</th><th>Opened</th><th>Uses</th><th>Uses each (average)</th><th>Fewer than expected</th><th>Value</th></tr></thead>`,
    summaryRow: (g) => {
      const uses = g.events.reduce((a, e) => a + e.uses, 0);
      const low = g.events.filter((e) => e.low).length;
      return `<tr><td><strong>${esc(g.label)}</strong></td><td>${g.events.length}</td><td>${uses}</td>
        <td>${esc(fmt(uses / g.events.length))}</td><td>${low ? `<span class="rp-neg">${low}</span>` : "—"}</td><td>${esc(moneyOrDash(g.value))}</td></tr>`;
    },
    summaryFoot: (ev) => `<tr><th>Total</th><th>${ev.length}</th><th>${ev.reduce((a, e) => a + e.uses, 0)}</th><th></th>
      <th>${ev.filter((e) => e.low).length}</th><th>${esc(moneyOrDash(sumValue(ev)))}</th></tr>`,
    detailHead: "<thead><tr><th>Opened</th><th>Product</th><th>Batch / Lot</th><th>Opened by</th><th>Uses</th><th>Status</th><th>Finished</th><th>Value</th></tr></thead>",
    detailRow: (e) => `<tr class="${e.low ? "is-diff" : ""}">
      <td>${esc(shortDate(e.at))}</td><td>${esc(e.productName)}</td><td>${esc(e.batch || "—")}</td><td>${esc(e.by || "—")}</td>
      <td>${esc(usesText(e))}${e.used && e.doseUnit ? ` <small class="muted">· ${esc(fmt(e.used))} ${esc(e.doseUnit)}</small>` : ""}${
        e.low ? ' <span class="inv-flag is-warn">Fewer than expected</span>' : ""}</td>
      <td><span class="inv-flag ${e.open ? "is-info" : e.typeLabel === "Empty" ? "is-ok" : "is-warn"}">${esc(e.typeLabel)}</span></td>
      <td>${e.finishedAt ? `${esc(shortDate(e.finishedAt))}${e.days !== null ? ` <small class="muted">(${e.days} day${e.days === 1 ? "" : "s"})</small>` : ""}${
        e.finishedBy ? `<br><small class="muted">${esc(e.finishedBy)}</small>` : ""}` : "—"}</td>
      <td>${esc(moneyOrDash(e.value))}</td></tr>`,
    csvHead: ["Opened", "Product", "Batch / Lot", "Opened by", "Uses", "Expected uses", "Amount recorded", "Status", "Finished",
      "Days open", "Finished by", "Note", "Value ($)"],
    csvRow: (e) => [e.at ? dayKey(e.at) : "", e.productName, e.batch, e.by, e.uses, e.expected || "",
      e.used ? `${fmt(e.used)} ${e.doseUnit}` : "", e.typeLabel, e.finishedAt ? dayKey(e.finishedAt) : "",
      e.days === null ? "" : e.days, e.finishedBy, e.note, e.value === null ? "" : e.value],
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
    } else if (m.type === "kit-correct") {
      const units = -kitDelta; // + more was used, − units given back
      if (!m.staffUid || !units) return;
      const r = rowFor(m.staffUid, m.productId, "");
      r.used += units;
      log(r, m.at, units > 0 ? "Usage corrected (more used)" : "Usage corrected (units back)", -units, m.note || "");
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

// The old app's kits (StartOfDayLog + Wrinkle Relaxer records), in the same shape as the portal's rows.
// Counts = their first start count; In kit now = their last start count.
function oldKitRows(list, products) {
  const p = products.find((x) => x.usage === "kit" && /xeomin/i.test(x.name)) || products.find((x) => x.usage === "kit") || null;
  const per = perDose(p);
  return (list || []).map((o) => {
    const has = o.hasKit === true && o.shouldHave !== null && o.shouldHave !== undefined;
    const gap = has ? round1(o.gap) : 0;
    return {
      key: `old|${o.staffUid || o.staffName}`, uid: o.staffUid || `old:${o.staffName}`, old: true, hasKit: has,
      staffName: o.staffName || "Unknown", oldNames: Array.isArray(o.oldNames) ? o.oldNames : [],
      productId: p ? p.id : "", productName: p ? p.name : "Xeomin", unit: (p && p.doseUnit) || "units",
      taken: round1(o.taken), borrowedIn: round1(o.borrowedIn), lentOut: round1(o.lentOut), used: round1(o.used),
      discarded: 0, returned: 0, adjusted: has ? round1(o.opening) : 0,
      expected: has ? round1(o.shouldHave) : null, now: has ? round1(o.closing) : null, gap,
      ok: !has || Math.abs(gap) < 0.05, gapValue: has && per !== null ? Math.round(per * gap * 100) / 100 : null,
      openingDate: o.openingDate || "", closingDate: o.closingDate || "", firstDate: o.firstDate || "", lastDate: o.lastDate || "",
      segments: Array.isArray(o.segments) ? o.segments : [], after: o.after || null, disputed: 0, events: [],
    };
  });
}

function mountKitRecon(body, staff) {
  mountKitReconciliation(body, { csv: downloadCsv, staff });
}
/* ===================== Start & end of day ===================== */

export function mountDayReport(body) {
  const dayOf = (e) => `${e.by}|${e.at ? dayKey(e.at) : ""}`;
  const face = (v) => { const m = MOODS.find(([n]) => n === Math.round(v)); return m ? m[1] : ""; };
  const off = (n) => Math.abs(Number(n) || 0) > 0.001;
  const signed = (n) => `${n > 0 ? "+" : ""}${fmt(n)}`;
  const diffText = (e) => [off(e.night) && `Overnight ${signed(e.night)}`, off(e.startDiff) && `Start ${signed(e.startDiff)}`,
    off(e.endDiff) && `End ${signed(e.endDiff)}`].filter(Boolean).join(" · ");
  const isDiff = (e) => e.typeLabel === "Difference" || e.typeLabel === "Overnight difference";
  const moods = (ev) => ev.filter((e) => e.first && e.mood !== null).map((e) => e.mood);
  const avg = (list) => (list.length ? list.reduce((a, n) => a + n, 0) / list.length : null);
  const avgText = (list) => { const a = avg(list); return a === null ? "—" : `${face(a)} ${fmt(a)}`; };

  mountRangeReport(body, {
    name: "Start & end of day", file: "start-end-of-day",
    groups: [["clinician", "Staff member"], ["type", "Result"], ["product", "Product"], ["month", "Month"]],
    findPlaceholder: "Filter: staff, product, batch or answer",
    empty: "No Start or End of Day entries in these dates.",
    async load(r) {
      const days = await listKitDays(r.from, r.to);
      return days.flatMap((d) => {
        const s = d.start, en = d.end;
        const answers = en ? en.answers : [];
        const moodA = answers.find((a) => a.type === "mood" && Number(a.value));
        const base = {
          at: parseKey(d.dateKey), by: d.staffName || "—", value: 0, startAt: s ? s.at : null, endAt: en ? en.at : null,
          mood: moodA ? Number(moodA.value) : null, first: true, corrected: !!(s && s.correctedAt),
          answers: answers.filter((a) => a.type !== "mood" && String(a.text || "").trim()).map((a) => `${a.label}: ${a.text}`).join(" · "),
        };
        const sItems = new Map(((s && !s.notInjecting && s.items) || []).map((it) => [it.productId, it]));
        const eItems = new Map(((en && en.items) || []).map((it) => [it.productId, it]));
        const pids = [...new Set([...sItems.keys(), ...eItems.keys()])];
        if (!pids.length) {
          return [{ ...base, productId: "-", productName: "—", unit: "", inUse: "", start: null, used: null, end: null,
            startDiff: 0, endDiff: 0, night: 0, unknown: 0, nightNote: "",
            typeLabel: s && s.notInjecting ? "Not injecting" : !en ? "Day not ended" : "Ended" }];
        }
        return pids.map((pid, i) => {
          const si = sItems.get(pid), ei = eItems.get(pid), it = si || ei;
          const startDiff = si ? Number(si.variance) || 0 : 0, endDiff = ei ? Number(ei.variance) || 0 : 0;
          const ov = si && si.overnight;
          const night = ov && ov.compared ? Number(ov.gap) || 0 : 0;
          return {
            ...base, first: i === 0, productId: pid, productName: it.productName || "Product", unit: it.doseUnit || "units",
            inUse: !si ? "" : si.inUse
              ? [si.inUse.batch ? `Batch ${si.inUse.batch}` : "No batch number", si.inUse.expiry ? `Exp ${shortDate(parseKey(si.inUse.expiry))}` : ""].filter(Boolean).join(" · ")
              : "Not using today",
            start: si ? Number(si.counted) || 0 : null, used: ei ? Number(ei.usedToday) || 0 : null, end: ei ? Number(ei.counted) || 0 : null,
            startDiff, endDiff, night, unknown: si && Array.isArray(si.unknown) ? si.unknown.length : 0,
            nightNote: ov ? (ov.compared ? `Expected ${fmt(ov.expected)} (end of day ${ov.fromDateKey}: ${fmt(ov.endCounted)}, since: ${signed(ov.moved)})` : ov.reason || "") : "",
            investigationId: ov && ov.investigationId ? ov.investigationId : "",
            typeLabel: off(night) ? "Overnight difference" : off(startDiff) || off(endDiff) ? "Difference"
              : !en ? "Day not ended" : !s ? "No start count" : "Matched",
          };
        });
      });
    },
    searchText: (e) => [e.by, e.productName, e.inUse, e.typeLabel, e.answers].join(" "),
    statsHtml(ev) {
      const night = ev.filter((e) => e.typeLabel === "Overnight difference").length;
      const diffs = ev.filter(isDiff).length;
      const notEnded = new Set(ev.filter((e) => e.typeLabel === "Day not ended").map(dayOf)).size;
      return `<div class="inv-stats">
        <div class="inv-stat"><strong>${new Set(ev.map(dayOf)).size}</strong><span>Staff days logged</span></div>
        <div class="inv-stat"><strong>${esc(avgText(moods(ev)))}</strong><span>How the day went (average of 5)</span></div>
        <div class="inv-stat ${night ? "is-bad" : ""}"><strong>${night}</strong><span>Overnight differences</span></div>
        <div class="inv-stat ${diffs || notEnded ? "is-warn" : ""}"><strong>${diffs} · ${notEnded}</strong><span>Kit differences · days not ended</span></div>
      </div>`;
    },
    summaryHead: (label) => `<thead><tr><th>${esc(label)}</th><th>Days</th><th>How the day went</th><th>Overnight</th><th>Kit differences</th><th>Not ended</th></tr></thead>`,
    summaryRow: (g) => `<tr><td><strong>${esc(g.label)}</strong></td><td>${new Set(g.events.map(dayOf)).size}</td>
      <td>${esc(avgText(moods(g.events)))}</td>
      <td>${g.events.filter((e) => e.typeLabel === "Overnight difference").length || "—"}</td>
      <td>${g.events.filter(isDiff).length || "—"}</td>
      <td>${new Set(g.events.filter((e) => e.typeLabel === "Day not ended").map(dayOf)).size || "—"}</td></tr>`,
    summaryFoot: (ev) => `<tr><th>Total</th><th>${new Set(ev.map(dayOf)).size}</th><th>${esc(avgText(moods(ev)))}</th>
      <th>${ev.filter((e) => e.typeLabel === "Overnight difference").length}</th><th>${ev.filter(isDiff).length}</th>
      <th>${new Set(ev.filter((e) => e.typeLabel === "Day not ended").map(dayOf)).size}</th></tr>`,
    detailHead: "<thead><tr><th>Date</th><th>Staff</th><th>Product</th><th>Vial in use</th><th>Start</th><th>Used on records</th><th>End</th><th>Difference</th><th>Day</th><th>Notes</th></tr></thead>",
    detailRow: (e) => {
      const n = (v) => (v === null ? "—" : `${esc(fmt(v))} ${esc(e.unit)}`);
      const d = diffText(e);
      return `<tr class="${isDiff(e) ? "is-diff" : ""}">
        <td>${esc(shortDate(e.at))}<br><small class="muted">${esc([e.startAt && `In ${timeOf(e.startAt)}`, e.endAt && `Out ${timeOf(e.endAt)}`].filter(Boolean).join(" · "))}</small>${
          e.first && e.corrected ? '<br><span class="inv-flag is-info">Start corrected</span>' : ""}</td>
        <td>${esc(e.by)}</td><td>${esc(e.productName)}</td>
        <td>${e.typeLabel === "Not injecting" ? '<span class="inv-flag is-info">Not injecting</span>' : esc(e.inUse || "—")}${
          e.unknown ? `<br><span class="inv-flag is-warn">${e.unknown} batch${e.unknown === 1 ? "" : "es"} not in kit</span>` : ""}</td>
        <td>${n(e.start)}${e.nightNote ? `<br><small class="muted">${esc(e.nightNote)}</small>` : ""}</td>
        <td>${n(e.used)}</td><td>${n(e.end)}</td>
        <td>${d ? `<strong class="rp-neg">${esc(d)}</strong>` : e.start !== null || e.end !== null ? "✓" : "—"}${
          e.investigationId ? `<br><a href="#/inventory/investigations/${encodeURIComponent(e.investigationId)}">Investigation →</a>` : ""}${
          e.typeLabel === "Day not ended" ? '<br><span class="inv-flag is-warn">Not ended</span>' : ""}</td>
        <td class="rp-mood">${e.first && e.mood !== null ? `<span title="${e.mood} of 5">${face(e.mood)}</span>` : ""}</td>
        <td>${e.first && e.answers ? `<small>${esc(e.answers)}</small>` : ""}</td></tr>`;
    },
    csvHead: ["Date", "Staff", "Product", "Vial in use", "Start count", "Used on records", "End count", "Unit", "Overnight difference",
      "Start difference", "End difference", "Batches not in kit", "Result", "Day (1-5)", "Answers", "Started at", "Start corrected", "Ended at"],
    csvRow: (e) => [e.at ? dayKey(e.at) : "", e.by, e.productName, e.inUse, e.start ?? "", e.used ?? "", e.end ?? "", e.unit,
      e.night || "", e.start === null ? "" : e.startDiff, e.end === null ? "" : e.endDiff, e.unknown || "", e.typeLabel,
      e.first && e.mood !== null ? e.mood : "", e.first ? e.answers : "", e.startAt ? timeOf(e.startAt) : "",
      e.first && e.corrected ? "Yes" : "", e.endAt ? timeOf(e.endAt) : ""],
  });
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
            : `<div class="rp-acts"><button type="button" class="lh-btn is-primary" data-act="resolve">Resolve</button>${
              can("inventory.manage") ? `<button type="button" class="lh-btn" data-correct="${esc(u.id)}">Correct</button>` : ""}</div>`}</td>
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
    const cb = e.target.closest("[data-correct]");
    if (cb) { openCorrection(cb.dataset.correct, staff, load); return; }
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

/* ===================== Correct usage (Manage inventory) ===================== */

export async function openCorrection(id, staff, onDone) {
  let u;
  try { u = await getUsage(id); } catch (err) { console.error(err); showToast(errText(err, "Couldn't open this record.")); return; }
  if (!u) { showToast("This record no longer exists."); return; }
  if (u.deleted) { showToast(`This usage was removed${u.deletedBy ? ` by ${u.deletedBy}` : ""}${u.deleteReason ? `: ${u.deleteReason}` : ""}.`); return; }

  const items = u.lines.flatMap((l, li) => (l.kind === "shared" ? [] : (l.rows || []).map((r, ri) => ({ l, r, li, ri, kit: l.kind === "kit", dosed: l.kind !== "kit" && !!l.doseUnit }))));
  if (!items.length) { showToast("There's nothing to correct on this record."); return; }
  const whereTxt = (x) => (x.kit ? `${u.by || "Injector"}'s kit` : LOC[x.r.from] || x.r.from || "Shelf");
  const amtTxt = (x, n) => (x.kit ? `${fmt(n)} ${x.l.unit}` : plural(+fmt(n), x.l.unit));

  const dlg = openDialog(`
    <form class="lh-form rp-correct" novalidate>
      <div class="lh-dialog-head"><h3>Correct usage</h3>
        <p><strong>${esc(u.patientName || "Patient")}</strong> · ${esc(u.formName || "")} · ${esc(shortDate(u.at))} · by ${esc(u.by || "—")}</p>
        <p class="muted">Enter what was actually used. The difference goes back to, or comes from, the same batch. The original amounts are kept.</p></div>
      <div class="rp-scroll"><table class="inv-table rp-ctable">
        <thead><tr><th>Product</th><th>Recorded</th><th>Correct amount</th></tr></thead>
        <tbody>${items.map((x, i) => {
          const short = (Number(x.r.amount) || 0) - (Number(x.r.taken) || 0);
          return `<tr data-i="${i}">
            <td><strong>${esc(x.l.name)}</strong>${x.l.replaced ? ` <small class="muted">(was ${esc(x.l.replaced.name)})</small>` : ""}<br><small class="muted">${esc([x.r.batch ? `${x.l.batchLabel || "Batch"} ${x.r.batch}` : "", whereTxt(x)].filter(Boolean).join(" · "))}</small>${
              x.ri === 0 && (x.l.kind === "kit" || x.l.kind === "storage") ? `<br><button type="button" class="kr-link" data-swap="${x.li}">Wrong product? Change it…</button>` : ""}</td>
            <td>${esc(amtTxt(x, x.r.amount))}${x.dosed ? `<br><small class="muted">${esc(fmt(x.r.dose))} ${esc(x.l.doseUnit)} given</small>` : ""}${
              short > 0.001 ? `<br><small class="rp-neg">${esc(fmt(short))} short</small>` : ""}</td>
            <td><label class="rp-cin"><input class="fe-in" type="number" min="0" step="${x.kit ? "0.1" : "1"}" data-k="amount" value="${esc(fmt(x.r.amount))}" />
                ${esc(x.kit ? x.l.unit : unitPlural(x.l.unit))}</label>
              ${x.dosed ? `<label class="rp-cin"><input class="fe-in" type="number" min="0" step="0.01" data-k="dose" value="${esc(fmt(x.r.dose))}" />
                ${esc(x.l.doseUnit)} given</label>` : ""}
              <small class="rp-effect" data-role="effect"></small></td></tr>`;
        }).join("")}</tbody></table></div>
      <label class="lh-field"><span class="lh-label">Reason</span>
        <textarea name="reason" rows="2" maxlength="300" placeholder="e.g. Entered 40 units instead of 30"></textarea></label>
      ${u.corrections.length ? `<div class="rp-chist"><strong>Earlier corrections</strong><ul>${u.corrections.map((c) =>
        `<li>${esc(shortDate(toDateSafe(c.at)))} · ${esc(c.by || "")}: ${esc((c.changes || []).join("; "))}${c.reason ? ` · <em>${esc(c.reason)}</em>` : ""}</li>`).join("")}</ul></div>` : ""}
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet st-danger" data-act="delete" title="It shouldn't be here at all: stock goes back and it leaves the reports">Remove usage…</button>
        <span class="inv-spacer"></span>
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save correction</button>
      </div>
    </form>`);

  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  const valOf = (tr, k) => { const el = tr.querySelector(`[data-k="${k}"]`); return el ? Number(el.value) : null; };

  // Live "what will happen" under each product
  const preview = () => form.querySelectorAll("tr[data-i]").forEach((tr) => {
    const x = items[Number(tr.dataset.i)];
    const out = tr.querySelector('[data-role="effect"]');
    const n = valOf(tr, "amount");
    if (!Number.isFinite(n) || n < 0) { out.textContent = "Enter an amount."; out.className = "rp-effect rp-neg"; return; }
    const { move, clearsShort } = correctionMove(x.r, n, x.kit);
    const parts = [];
    if (clearsShort > 0) parts.push(`Clears ${amtTxt(x, clearsShort)} of the short`);
    if (move > 0) parts.push(`Takes ${amtTxt(x, move)} more from ${whereTxt(x)}`);
    if (move < 0) parts.push(`Returns ${amtTxt(x, -move)} to ${whereTxt(x)}`);
    out.textContent = parts.join(" · ");
    out.className = `rp-effect ${move > 0 ? "rp-neg" : "rp-pos"}`;
  });
  form.addEventListener("input", preview);
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", async (e) => {
    const sw = e.target.closest("[data-swap]");
    if (sw) {
      const x = items.find((it) => it.li === Number(sw.dataset.swap) && it.ri === 0);
      if (x && await swapProductDialog(u, x, staff)) { dlg.close(); if (onDone) onDone(); }
      return;
    }
    if (e.target.closest('[data-act="delete"]') && await deleteUsageDialog(u, staff)) { dlg.close(); if (onDone) onDone(); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const changes = [];
    for (const tr of form.querySelectorAll("tr[data-i]")) {
      const x = items[Number(tr.dataset.i)];
      const amount = valOf(tr, "amount");
      const dose = x.dosed ? valOf(tr, "dose") : null;
      if (!Number.isFinite(amount) || amount < 0 || (x.dosed && (!Number.isFinite(dose) || dose < 0))) {
        err.textContent = `${x.l.name}: enter a number of 0 or more.`; err.hidden = false; return;
      }
      if (amount !== (Number(x.r.amount) || 0) || (x.dosed && dose !== (Number(x.r.dose) || 0))) {
        changes.push({ li: x.li, ri: x.ri, amount, dose });
      }
    }
    if (!changes.length) { err.textContent = "Nothing has changed."; err.hidden = false; return; }
    const reason = form.elements.reason.value.trim();
    if (!reason) { err.textContent = "Add a reason for the correction."; err.hidden = false; return; }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await correctUsage(u.id, changes, reason, staff);
      dlg.close();
      showToast("Usage corrected. Stock updated.");
      if (onDone) onDone();
    } catch (ex) {
      console.error("Correction failed:", ex);
      err.textContent = errText(ex, "Couldn't save the correction. Try again.");
      err.hidden = false;
      btn.disabled = false;
    }
  });
}
// The wrong product was recorded on a line. Every batch on that line goes back; the right product comes off the batch chosen.
async function swapProductDialog(u, x, staff) {
  let products, lots, kits;
  try { [products, lots, kits] = await Promise.all([listProducts(), listAllLots(), listKits().catch(() => [])]); }
  catch (err) { showToast(errText(err, "Couldn't load the products.")); return false; }
  const owner = x.l.kitUid || u.byUid || "";
  const choices = products.filter((p) => p.active && p.usage !== "shared" && p.id !== x.l.productId);
  const byExpiry = (a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999");
  const srcOptions = (p) => (isKitProduct(p)
    ? kits.filter((k) => k.productId === p.id && k.staffUid === owner && kitUnits(k) > 0).sort(byExpiry).map((k) => ({
        ref: k.id, label: `${k.batch || "No number"} · Exp ${niceDate(k.expiry)} · ${fmt(kitUnits(k))} ${k.doseUnit} in ${k.staffName || "their"}'s kit` }))
    : lots.filter((l) => l.productId === p.id).sort(fefo).map((l) => ({
        ref: l.id, label: `${LOC[l.loc]} · ${l.batch || "No number"} · Exp ${niceDate(l.expiry)} · ${plural(l.qty, p.stockUnit)}` })));
  const was = x.kit ? `${fmt(x.r.amount)} ${x.l.unit}` : plural(+fmt(x.r.amount), x.l.unit);
  return new Promise((resolve) => {
    let saved = false;
    const dlg = openDialog(`<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Change product</h3>
        <p><strong>${esc(x.l.name)}</strong> (${esc(was)}) on ${esc(u.patientName || "this record")} · ${esc(u.formName || "")}. It goes back where it came from,
          and the product that was really used comes off the batch you choose. Both changes are logged.</p></div>
      <label class="lh-field"><span class="lh-label">Product actually used</span>
        <select class="fb-select" name="productId"><option value="">Choose…</option>${choices.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
      <label class="lh-field"><span class="lh-label">From</span><select class="fb-select" name="ref"><option value="">Choose the product first</option></select></label>
      <div class="inv-two">
        <label class="lh-field"><span class="lh-label" data-role="amtlbl">Amount</span><input class="fe-in" name="amount" type="number" min="0" step="any" value="${esc(fmt(x.r.amount))}" /></label>
        <label class="lh-field" data-role="doserow" hidden><span class="lh-label" data-role="doselbl">Given</span><input class="fe-in" name="dose" type="number" min="0" step="any" value="${esc(fmt(x.r.dose || 0))}" /></label>
      </div>
      <label class="lh-field"><span class="lh-label">Reason</span>
        <textarea name="reason" rows="2" maxlength="300" placeholder="e.g. Belotero was used, not Radiesse (checked the box in the sharps bin)"></textarea></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Change product</button></div></form>`);
    const form = dlg.querySelector("form");
    const f = form.elements;
    const err = dlg.querySelector(".lh-error");
    const sync = () => {
      const p = choices.find((c) => c.id === f.productId.value);
      const opts = p ? srcOptions(p) : [];
      f.ref.innerHTML = opts.length ? opts.map((o) => `<option value="${esc(o.ref)}">${esc(o.label)}</option>`).join("")
        : `<option value="">${!p ? "Choose the product first" : isKitProduct(p) ? "Nothing of this in the clinician's kit" : "None in stock"}</option>`;
      dlg.querySelector('[data-role="amtlbl"]').textContent = p ? `Amount (${isKitProduct(p) ? p.doseUnit : unitPlural(p.stockUnit)})` : "Amount";
      dlg.querySelector('[data-role="doserow"]').hidden = !(p && !isKitProduct(p) && p.doseUnit);
      if (p && p.doseUnit) dlg.querySelector('[data-role="doselbl"]').textContent = `${p.doseUnit} given`;
    };
    f.productId.addEventListener("change", sync);
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        await changeUsageProduct(u.id, x.li, { productId: f.productId.value, ref: f.ref.value, amount: f.amount.value, dose: f.dose.value }, f.reason.value, staff);
        saved = true;
        dlg.close();
        showToast("Product changed. Stock updated both ways.");
      } catch (ex) {
        console.error("Change product failed:", ex);
        err.textContent = errText(ex, "Couldn't change it. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.addEventListener("close", () => resolve(saved));
  });
}

// A usage that shouldn't exist: stock back, record kept and marked removed
function deleteUsageDialog(u, staff) {
  return new Promise((resolve) => {
    let saved = false;
    const dlg = openDialog(`<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Remove this usage?</h3>
        <p><strong>${esc(u.patientName || "Patient")}</strong> · ${esc(u.formName || "")} · ${esc(shortDate(u.at))}. Everything on it goes back into stock
          (kit units into the opened vial, items into their batch) and it leaves the Usage report and Treatment check. The record itself stays, marked removed.
          ${u.submissionId ? "The treatment form isn't changed: delete that from the patient's page if it's wrong too." : ""}</p></div>
      <label class="lh-field"><span class="lh-label">Reason</span>
        <textarea name="reason" rows="2" maxlength="300" placeholder="e.g. Recorded on the wrong patient; entered again on the right one"></textarea></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-danger">Remove usage</button></div></form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const r = await deleteUsage(u.id, form.elements.reason.value, staff);
        saved = true;
        dlg.close();
        showToast(r.skipped.length ? `Removed. Stock put back, except ${r.skipped.join(", ")} (used from an opened container).` : "Removed. Stock put back.");
      } catch (ex) {
        console.error("Remove usage failed:", ex);
        err.textContent = errText(ex, "Couldn't remove it. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.addEventListener("close", () => resolve(saved));
  });
}
const toDateSafe = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; };