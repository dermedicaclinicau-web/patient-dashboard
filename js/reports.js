// Reporting (#/reports/<tab>): count differences, wastage, kit reconciliation, usage and saved short.
import {
  listProducts, listCounts, resolveCountLine, batchName, plural, unitPlural, dayKey, COUNT_STATUS,
} from "./inventory-api.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(+Number(n || 0).toFixed(2));
const money = (n) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const LOC = { shelf: "Shelf", jt: "JT storage" };
const whereOf = (l) => (l.loc === "kit" ? `${l.staffName || "Injector"}'s kit` : LOC[l.loc] || l.loc);
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "";
};
const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const daysAgoKey = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return dayKey(d); };
const SKELETON = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
const TABS = [["variance", "Count differences"], ["wastage", "Wastage"], ["kits", "Kit reconciliation"], ["usage", "Usage"], ["short", "Saved short"]];
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to do this. Check the Firestore rules have been published, and your Reporting access in Staff."
  : err && err.message && !err.code ? err.message : fallback);

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
  else body.innerHTML = '<div class="state"><strong>Coming next</strong>This report is being built.</div>';
}

/* ===================== Count differences ===================== */

function mountVariance(body, staff) {
  const st = { view: "open", from: daysAgoKey(30), counts: [], products: new Map() };

  // Cost per counted item (cost is per supplier unit). Kits: per unit (e.g. per unit of Xeomin).
  const unitCost = (l) => {
    const p = st.products.get(l.productId);
    if (!p || p.cost === null || p.cost === undefined) return null;
    const perItem = p.cost / Math.max(1, p.packSize);
    return l.loc === "kit" ? (p.dosePer ? perItem / p.dosePer : null) : perItem;
  };
  const valueOf = (l) => { const c = unitCost(l); return c === null ? null : Math.round(c * (Number(l.variance) || 0) * 100) / 100; };
  const amt = (l, n) => (l.loc === "kit" ? `${fmt(n)} ${l.unit}` : plural(+fmt(n), l.unit));
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
      <td>${esc(amt(l, l.counted))}</td><td>${esc(amt(l, l.system))}</td>
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