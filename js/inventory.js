// Inventory (#/inventory/<tab>): stock on the Shelf and in JT storage, products, suppliers and the activity log.
import {
  INV_CATEGORIES, LOCATIONS, qtyText, packText, batchName, batchText, WEEKDAYS, WRITEOFF_REASONS, ADD_REASONS, MOVE_TYPES, REQ_STATUS, PO_STATUS, catLabel, locLabel, plural, unitPlural,
  expiryState, fefo, reqNumber, myUid, suggestOrder, listProducts, saveProduct, listSuppliers, saveSupplier, listAllLots, listMoves,
  applyStock, listRequests, setRequestStatus, cancelRequest, getRequestSettings, saveRequestSettings,
  listPos, createPo, poTotals, itemOnPo, lineFromProduct, cleanPoLine,
  productSuppliers, supplierTerms, suppliesProduct, suggestOrderFor,
  listCounts, listInvestigations, dayKey, 
  isSharedProduct, listOpenContainers, openContainer, finishContainer, openState, expectedUses, FINISH_REASONS,
  setStartingStock,
} from "./inventory-api.js";
import { renderInvestigations, mountInvestigation } from "./investigations.js";
import { mountPurchaseOrder } from "./purchase-order.js";
import { fetchStaffList } from "./task-types.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { can, isInjector } from "./perms.js";
import { showToast } from "./utils.js";
import { mountReceivePo } from "./receive-po.js";
import { renderKits } from "./inventory-kits.js";
import { openProductImport, exportProductsCsv } from "./inventory-import.js";
import { renderNotifications } from "./notifications.js";
import { renderServiceLinks } from "./service-links.js";
import { enableUiText } from "./ui-text.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const TABS = [["stock", "Stock"], ["kits", "Kits"], ["investigations", "Investigations"], ["requests", "Requests"],
  ["receive", "Receive delivery"], ["orders", "Purchase orders"], ["products", "Products"], ["services", "Service links"],
  ["suppliers", "Suppliers"], ["activity", "Activity"], ["notifications", "Notifications"]];
const niceDate = (key) => {
const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const when = (d) => (d ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const money = (n) => (n === null || n === undefined ? "" : `$${Number(n).toFixed(2)}`);
const fmtN = (n) => String(+Number(n || 0).toFixed(2));
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to do this. Ask an Admin to check your Inventory access in Staff."
  : err && err.message && !err.code ? err.message : fallback);
// items: [value, label] or [value, label, count] (the count shows as a small badge)
const seg = (name, items, cur) => `<div class="fe-seg">${items.map(([v, l, n]) =>
  `<label class="fe-seg-btn"><input type="radio" name="${name}" value="${v}"${v === cur ? " checked" : ""} /><span>${esc(l)}${
    n === undefined ? "" : `<em class="seg-n${n ? "" : " is-zero"}">${n}</em>`}</span></label>`).join("")}</div>`;
const lowAt = (p, loc) => p.reorder[loc] !== null && p.reorder[loc] !== undefined && p.stock[loc] <= p.reorder[loc];

// Who is using Inventory, for admin-editable wording in its windows
let uiStaff = null;
const isAdminStaff = (s) => /^admin$/i.test(String((s && s.role) || ""));

// editWording: show "✎ Edit wording" to Admins in this window. Edited wording is shown to everyone everywhere.
function openDialog(cls, html, { editWording = false } = {}) {
  const dlg = document.createElement("dialog");
  dlg.className = `lh-dialog ${cls}`;
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  enableUiText(dlg, { scope: "inv", admin: editWording && isAdminStaff(uiStaff), staff: uiStaff });
  return dlg;
}

function linesText(m, label = "Batch") {
  return (m.lines || []).map((l) => `${locLabel(l.loc)} ${l.delta > 0 ? "+" : "−"}${Math.abs(l.delta)}${
    l.batch ? ` (${label} ${l.batch})` : ""}`).join(" · ");
}
function movesHtml(moves, showProduct = true, labelOf = () => "Batch") {
  if (!moves.length) return '<p class="tb-none">No stock changes yet.</p>';
  return `<ul class="inv-moves">${moves.map((m) => `
    <li>
      <span class="inv-m-when">${esc(when(m.at))}</span>
      <span class="inv-m-main"><strong>${esc(MOVE_TYPES[m.type] || m.type)}</strong>${showProduct ? ` · ${esc(m.productName || "")}` : ""}
        <small>${esc(linesText(m, labelOf(m.productId)))}${m.reason ? ` · ${esc(m.reason)}` : ""}${m.note ? ` · ${esc(m.note)}` : ""}</small></span>
      <span class="inv-m-by">${esc(m.by || "")}</span>
    </li>`).join("")}</ul>`;
}

export function mountInventory(container, { param = "", staff = null } = {}) {
  uiStaff = staff;
  const parts = String(param || "").split("/");
  if (parts[0] === "plans") { location.replace("#/settings/plans"); return; } // moved to System configuration

  // Who can see what. Every tab follows the permission behind it.
  const canManage = can("inventory.manage");
  const canMove = canManage || can("inventory.order");
  const canReceive = canMove || can("inventory.receive");
  const canView = canMove || can("inventory.view") || can("inventory.count");
  const canRequest = can("inventory.request");
  const canKit = isInjector();
  const canJt = can("inventory.jt");
  const showKits = canKit || canJt || canManage;
  const showInv = canMove || can("inventory.count") || can("menu.reports");
  const TAB_OK = {
    stock: canView, kits: showKits, investigations: showInv, requests: canRequest || canMove, receive: canReceive,
    orders: canMove, products: canView, services: canManage, suppliers: canView, activity: canView, notifications: canManage,
  };
  const tabs = TABS.filter(([k]) => TAB_OK[k]);
  const noAccess = () => {
    container.innerHTML = '<section class="page wide"><div class="state"><strong>No access</strong>Ask an Admin to give you Inventory access in Staff.</div></section>';
  };

  if (parts[0] === "po" && parts[1]) { mountPurchaseOrder(container, { id: parts[1], staff }); return; }
  if (parts[0] === "investigations" && parts[1]) { mountInvestigation(container, { id: decodeURIComponent(parts[1]), staff }); return; }
  if (parts[0] === "receive" && parts[1]) {          // receiving one purchase order: its own page
    if (!canReceive) { noAccess(); return; }
    const page = document.createElement("section");
    page.className = "page wide";
    container.replaceChildren(page);
    mountReceivePo(page, decodeURIComponent(parts[1]), staff);
    return;
  }
  if (!tabs.length) { noAccess(); return; }
  const first = parts[0];
  if (first && !tabs.some(([k]) => k === first)) { location.replace(`#/inventory/${tabs[0][0]}`); return; }
  const tab = first || tabs[0][0];
  const sub = canView ? "Stock on the Shelf and in JT storage, products and suppliers." : "Order requests and deliveries.";

  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <div class="fb-head">
      <div><h2>Inventory</h2><p class="muted">${sub}</p></div>
      ${(canReceive && tab !== "receive") || canManage ? `<div class="fb-head-actions">
        ${canReceive && tab !== "receive" ? '<a class="btn-ghost inv-head-link" href="#/inventory/receive">Receive delivery</a>' : ""}
        ${canManage ? `<button type="button" class="btn-ghost" data-act="new-supplier">+ New supplier</button>
        <button type="button" class="btn-primary" data-act="new-product">+ New product</button>` : ""}
      </div>` : ""}
    </div>
    <nav class="pt-tabs inv-tabs" aria-label="Inventory">${tabs.map(([k, l]) =>
        `<a href="#/inventory/${k}"${k === tab ? ' class="active" aria-current="page"' : ""}>${l}${
        k === "requests" ? ' <em class="inv-tabcount" data-role="reqcount" hidden></em>' : ""}${
        k === "investigations" ? ' <em class="inv-tabcount" data-role="ivxcount" hidden></em>' : ""}</a>`).join("")}</nav>
    <div data-role="body"><div class="skeleton" style="height:320px;border-radius:14px"></div></div>`;

  container.replaceChildren(root);
  const body = root.querySelector('[data-role="body"]');

  const st = {
    products: [], suppliers: [], lots: [], requests: [], q: "", cat: "", view: "all", flagged: false, showInactive: false,
    reqFilter: "open", reqView: "list", pos: [], poFilter: "draft", lineSup: {},
    sel: new Set(), pq: "", pcat: "", psup: "",  pcount: "",
    counts: [], invs: [], lastCounts: new Map(), open: [],
    quick: false, qv: new Map(),   // Stock → Update digital count: on/off, and what's been typed ("productId|loc" → "12")
  };
  const supplierOf = (id) => st.suppliers.find((s) => s.id === id) || null;
  // "Merz Aesthetics / Medical Supplies Co" (main first)
  const suppliersText = (p) => productSuppliers(p).map((t) => (supplierOf(t.supplierId) || {}).name).filter(Boolean).join(" / ");
  const lotsOf = (pid) => st.lots.filter((l) => l.productId === pid).sort(fefo);
  const labelOf = (pid) => batchName(st.products.find((p) => p.id === pid));
  function flags(p) {
    const out = [];
    if (st.invs.some((v) => v.productId === p.id)) out.push(["bad", "Investigating"]);
    if (lowAt(p, "shelf")) out.push(["warn", "Low on Shelf"]);
    if (lowAt(p, "jt")) out.push(["warn", "Low in JT storage"]);
    const ex = lotsOf(p.id).map((l) => expiryState(l.expiry));
    if (ex.includes("expired")) out.push(["bad", "Expired stock"]);
    else if (ex.includes("soon")) out.push(["warn", "Expires soon"]);
    const opened = st.open.filter((c) => c.productId === p.id);
    if (opened.some((c) => openState(c) === "overdue")) out.push(["bad", "Opened one past its use-by"]);
    else if (opened.some((c) => openState(c) === "soon")) out.push(["warn", "Opened one due to be discarded"]);
    return out;
  }

  // The latest opening count of each product + storage (batches added together)
  function lastCountsOf(counts) {
    const m = new Map();
    counts.filter((c) => c.kind === "opening").forEach((c) => {     // newest first
      const per = new Map();
      c.lines.filter((l) => l.loc !== "kit").forEach((l) => {
        const k = `${l.productId}|${l.loc}`;
        const a = per.get(k) || { counted: 0, system: 0, statuses: [], invIds: [], dateKey: c.dateKey, by: c.by };
        a.counted += Number(l.counted) || 0;
        a.system += Number(l.system) || 0;
        a.statuses.push(l.status);
        if (l.investigationId) a.invIds.push(l.investigationId);
        per.set(k, a);
      });
      per.forEach((a, k) => { if (!m.has(k)) m.set(k, a); });
    });
    return m;
  }

  async function load() {
    try {
      [st.products, st.suppliers, st.lots, st.requests, st.pos, st.counts, st.invs, st.open] = await Promise.all([
        listProducts(), listSuppliers(), listAllLots(), listRequests({ max: 300 }).catch(() => []), listPos().catch(() => []),
        listCounts({ from: dayKey(new Date(Date.now() - 120 * 864e5)) }).catch(() => []),
        listInvestigations({ open: true }).catch(() => []),
        listOpenContainers().catch(() => []),
      ]);
      if (!root.isConnected) return;
      st.lastCounts = lastCountsOf(st.counts);
      const open = st.requests.filter((r) => r.status === "open").length;
      const badge = root.querySelector('[data-role="reqcount"]');
      if (badge) { badge.textContent = open; badge.hidden = !open; }
      const ib = root.querySelector('[data-role="ivxcount"]');
      if (ib) { ib.textContent = st.invs.length; ib.hidden = !st.invs.length; }
      render();
    } catch (err) {
      console.error("Inventory load failed:", err);
      if (root.isConnected) body.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
        ? "Inventory is blocked. Check the Inventory Firestore rules have been published, and your Inventory access in Staff."
        : "Couldn't load the inventory. Check your connection and try again."}</div>`;
    }
  }

    function render() {
    if (tab === "stock") renderStock();
    else if (tab === "receive") mountReceivePo(body, "", staff);
    else if (tab === "kits") renderKits(body, { staff, products: st.products, lots: st.lots, canKit, canJt, canManage, reload: load });
    else if (tab === "investigations") renderInvestigations(body, { staff });
    else if (tab === "services") {
      if (canManage) renderServiceLinks(body, { staff, products: st.products });
      else body.innerHTML = '<div class="tm-empty">Only Manage inventory can link services to products.</div>';
    }
    else if (tab === "requests") renderRequests();
    else if (tab === "orders") renderOrders();
    else if (tab === "products") renderProducts();
    else if (tab === "suppliers") renderSuppliers();
    else if (tab === "notifications") {
      if (canManage) renderNotifications(body, { staff });
      else body.innerHTML = '<div class="tm-empty">Only Manage inventory can set up notifications.</div>';
    }
    else renderActivity();
  }

  /* ---------- Stock ---------- */
  function renderStock() {
    const active = st.products.filter((p) => p.active);
    const exp = (state) => active.filter((p) => lotsOf(p.id).some((l) => expiryState(l.expiry) === state)).length;
    body.innerHTML = `
      <div class="inv-stats">
        <div class="inv-stat"><strong>${active.length}</strong><span>Products</span></div>
        <div class="inv-stat is-warn"><strong>${active.filter((p) => lowAt(p, "shelf") || lowAt(p, "jt")).length}</strong><span>Low stock</span></div>
        <div class="inv-stat is-warn"><strong>${exp("soon")}</strong><span>Expiring within 60 days</span></div>
        <div class="inv-stat is-bad"><strong>${exp("expired")}</strong><span>With expired stock</span></div>
      </div>
      <div class="inv-tools">
        <label class="ib-search inv-find">${SEARCH}<input type="search" data-f="q" placeholder="Search products, brands or suppliers" value="${esc(st.q)}" aria-label="Search" /></label>
        <select class="fb-select" data-f="cat" aria-label="Category"><option value="">All categories</option>${INV_CATEGORIES.map((c) =>
          `<option value="${c.key}"${st.cat === c.key ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
        ${seg("inv-view", [["all", "Both"], ["shelf", "Shelf"], ["jt", "JT storage"]], st.view).replace(/name="inv-view"/g, 'name="inv-view" data-f="view"')}
        <label class="fe-check"><input type="checkbox" data-f="flagged"${st.flagged ? " checked" : ""} /> Only low or expiring</label>
        <span class="inv-spacer"></span>
        ${canManage ? `<button type="button" class="ff-btn${st.quick ? " is-primary" : ""}" data-act="quick">${st.quick ? "Done updating" : "Update digital count"}</button>` : ""}
        ${canRequest && !st.quick ? '<a class="ff-btn" href="#/tasks/order/low">Request low stock</a>' : ""}
      </div>
      ${st.quick ? `<p class="inv-hint">Type what's there now. Empty boxes stay as they are. Enter moves to the next box. Batch &amp; expiry products are counted by batch.</p>` : ""}
      <div data-role="list"></div>
      ${st.quick ? `<div class="inv-quickbar" data-role="quickbar">
        <span data-role="qtext"></span>
        <span class="inv-spacer"></span>
        <button type="button" class="lh-btn is-quiet" data-act="quick-discard">Discard</button>
        <button type="button" class="lh-btn is-primary" data-act="quick-save">Save</button>
      </div>` : ""}`;
    renderStockList();
    syncQuickBar();
  }

  function stockRow(p) {
    if (st.quick) return quickRow(p);
    const qty = (loc) => `<span class="inv-q${lowAt(p, loc) ? " is-low" : ""}"><small>${loc === "shelf" ? "Shelf" : "JT"}</small><b>${p.stock[loc]}</b></span>`;
    const sup = supplierOf(p.supplierId);
    return `
      <button type="button" class="inv-row" data-product="${esc(p.id)}">
        <span class="inv-name"><strong>${esc(p.name)}</strong>
          <small>${esc([p.brand, suppliersText(p), p.tracked ? "Batch & expiry" : "",
            isSharedProduct(p) ? `${st.open.filter((c) => c.productId === p.id).length} open` : ""].filter(Boolean).join(" · "))}</small></span>
          <span class="inv-flags">${flags(p).map(([t, l]) => `<span class="inv-flag is-${t}">${esc(l)}</span>`).join("")}</span>
        ${st.view !== "jt" ? qty("shelf") : ""}${st.view !== "shelf" ? qty("jt") : ""}
        <span class="inv-unit">${esc(unitPlural(p.stockUnit))}</span>
      </button>`;
  }

  function renderStockList() {
    const list = body.querySelector('[data-role="list"]');
    if (!list) return;
    if (!st.products.length) {
      list.innerHTML = `<div class="tm-empty"><strong>No products yet.</strong><br>${canManage
        ? 'Add your first product, then use <strong>Add stock</strong> to enter what you have.<div class="tm-empty-act"><button type="button" class="ff-btn is-primary" data-act="new-product">+ New product</button></div>'
        : "Ask an Admin to add the products."}</div>`;
      return;
    }
    const q = st.q.trim().toLowerCase();
    const rows = st.products.filter((p) => p.active
      && (!st.cat || p.category === st.cat)
      && (!q || `${p.name} ${p.brand} ${suppliersText(p)}`.toLowerCase().includes(q))
      && (!st.flagged || flags(p).length));
    if (!rows.length) { list.innerHTML = '<div class="tm-empty">No products match.</div>'; return; }
    list.innerHTML = INV_CATEGORIES.map((c) => {
      const items = rows.filter((p) => p.category === c.key);
      return items.length ? `<section class="inv-group"><h3>${esc(c.label)}<em>${items.length}</em></h3>
        <div class="inv-list">${items.map(stockRow).join("")}</div></section>` : "";
    }).join("");
  }

  /* ---------- Stock → Update digital count (Manage inventory) ---------- */
  function quickRow(p) {
    const locs = LOCATIONS.filter((l) => st.view === "all" || st.view === l.key);
    const cell = (loc) => {
      const k = `${p.id}|${loc}`;
      const v = st.qv.has(k) ? st.qv.get(k) : "";
      const set = v !== "" && Number(v) !== p.stock[loc];
      return `<label class="inv-qc${set ? " is-set" : ""}"><small>${loc === "shelf" ? "Shelf" : "JT"} · now ${p.stock[loc]}</small>
        <input class="fe-input inv-num" type="number" min="0" step="1" inputmode="numeric" data-qc="${esc(k)}"
          value="${esc(v)}" placeholder="${p.stock[loc]}" aria-label="${esc(`${p.name}: ${loc === "shelf" ? "Shelf" : "JT storage"}`)}" /></label>`;
    };
    return `
      <div class="inv-row inv-qrow">
        <span class="inv-name"><strong>${esc(p.name)}</strong><small>${esc(unitPlural(p.stockUnit))}</small></span>
        <span class="inv-flags">${flags(p).map(([t, l]) => `<span class="inv-flag is-${t}">${esc(l)}</span>`).join("")}</span>
        ${p.tracked
          ? `<button type="button" class="lh-btn" data-qbatch="${esc(p.id)}">Count by ${esc(batchName(p).toLowerCase())}…</button>`
          : locs.map((l) => cell(l.key)).join("")}
      </div>`;
  }

  // What's been typed that differs from digital (bad = not a whole number of 0 or more)
  function quickChanges() {
    return [...st.qv].map(([k, v]) => {
      const [pid, loc] = k.split("|");
      const p = st.products.find((x) => x.id === pid);
      const n = Number(v);
      return p ? { k, p, loc, n, bad: !Number.isInteger(n) || n < 0 } : null;
    }).filter((c) => c && (c.bad || c.n !== c.p.stock[c.loc]));
  }

  function syncQuickBar() {
    const bar = body.querySelector('[data-role="quickbar"]');
    if (!bar) return;
    const ch = quickChanges();
    const prods = new Set(ch.map((c) => c.p.id)).size;
    bar.querySelector('[data-role="qtext"]').textContent = ch.length
      ? `${plural(ch.length, "change")} across ${plural(prods, "product")}` : "No changes yet";
    bar.querySelector('[data-act="quick-save"]').disabled = !ch.length;
    bar.querySelector('[data-act="quick-discard"]').disabled = !st.qv.size;
  }

  async function toggleQuick() {
    if (st.quick && quickChanges().length) {
      const ok = await confirmDialog({
        title: "Discard what you've typed?",
        message: `${plural(quickChanges().length, "change")} haven't been saved.`,
        confirmLabel: "Discard", tone: "warning",
      });
      if (!ok) return;
    }
    st.quick = !st.quick;
    st.qv.clear();
    renderStock();
    if (st.quick) { const first = body.querySelector("[data-qc]"); if (first) first.focus(); }
  }

  async function saveQuick(btn) {
    const ch = quickChanges();
    const bad = ch.find((c) => c.bad);
    if (bad) {
      showToast(`${bad.p.name}: enter a whole number of 0 or more.`);
      const el = body.querySelector(`[data-qc="${CSS.escape(bad.k)}"]`);
      if (el) el.focus();
      return;
    }
    if (!ch.length) return;
    const byProduct = new Map();
    ch.forEach((c) => byProduct.set(c.p.id, [...(byProduct.get(c.p.id) || []), c]));
    const queue = [...byProduct.values()];
    const total = queue.length;
    let done = 0, places = 0;
    const failed = [];
    btn.disabled = true;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const g = queue.shift();
        const p = g[0].p;
        try {
          places += await setStartingStock(p, g.map((c) => ({ loc: c.loc, qty: c.n })), staff,
            { type: "count", reason: "Stock count", note: "Quick count" });
          g.forEach((c) => st.qv.delete(c.k));
        } catch (ex) {
          console.error("Quick count failed:", p.name, ex);
          failed.push(p.name);
        }
        btn.textContent = `Saving ${++done} of ${total}…`;
      }
    }));
    showToast(failed.length
      ? `Saved ${total - failed.length}. Couldn't save: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}. Their numbers are still there to try again.`
      : `Digital count updated: ${plural(places, "change")} across ${plural(total, "product")}`);
    await load();
  }

  /* ---------- Products (with tick boxes and bulk actions) ---------- */
  // "Counted daily · Shelf only", or "" when it isn't counted
  const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
  const countText = (p) => {
    const f = p.countFreq || "never";
    if (f === "never") return "";
    const when = f === "daily" ? "Counted daily"
      : f === "weekly" ? `Counted ${WEEKDAYS[Number(p.countDay) || 0]}s`
      : `Counted monthly (${p.countDay === "last" ? "last day" : `the ${ordinal(Number(p.countDay) || 1)}`})`;
    const where = p.countWhere === "shelf" ? " · Shelf only" : p.countWhere === "jt" ? " · JT storage only" : "";
    return when + where;
  };
  
  function productRows() {
    const q = st.pq.trim().toLowerCase();
    return st.products.filter((p) => (st.showInactive || p.active)
      && (!st.pcat || p.category === st.pcat)
      && (!st.psup || (st.psup === "none" ? !productSuppliers(p).length : suppliesProduct(p, st.psup)))
      && (!st.pcount || (st.pcount === "never" ? (p.countFreq || "never") === "never" : (p.countFreq || "never") !== "never"))
      && (!q || `${p.name} ${p.brand} ${p.supplierCode} ${suppliersText(p)}`.toLowerCase().includes(q)));
  }

  function renderProducts() {
    body.innerHTML = `
      <div class="inv-tools">
        <label class="ib-search inv-find">${SEARCH}<input type="search" data-f="pq" placeholder="Search products, codes or suppliers" value="${esc(st.pq)}" aria-label="Search products" /></label>
        <select class="fb-select" data-f="pcat" aria-label="Category"><option value="">All categories</option>${INV_CATEGORIES.map((c) =>
          `<option value="${c.key}"${st.pcat === c.key ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
        <select class="fb-select" data-f="psup" aria-label="Supplier">
          <option value="">Any supplier</option>
          <option value="none"${st.psup === "none" ? " selected" : ""}>No supplier yet</option>
          ${st.suppliers.map((s) => `<option value="${esc(s.id)}"${st.psup === s.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select>
        <select class="fb-select" data-f="pcount" aria-label="Opening count">
          <option value="">Any count</option>
          <option value="set"${st.pcount === "set" ? " selected" : ""}>Counted</option>
          <option value="never"${st.pcount === "never" ? " selected" : ""}>Not counted</option>
        </select>
        <label class="fe-check"><input type="checkbox" data-f="showInactive"${st.showInactive ? " checked" : ""} /> Show inactive</label>
        <span class="inv-spacer"></span>
        ${canManage ? `<button type="button" class="ff-btn" data-act="export-products">Export CSV</button>
          <button type="button" class="ff-btn is-primary" data-act="import-products">Import products</button>` : ""}
      </div>
      ${canManage ? `<div class="inv-bulk" data-role="bulk" hidden>
        <strong data-role="selcount"></strong>
        <button type="button" class="lh-btn is-primary" data-bulk="main">Set main supplier</button>
        <button type="button" class="lh-btn" data-bulk="alt">Add other suppliers</button>
        <button type="button" class="lh-btn" data-bulk="remove">Remove a supplier</button>
        <button type="button" class="lh-btn" data-bulk="category">Change category</button>
        <button type="button" class="lh-btn" data-bulk="count">Opening count</button>
        <button type="button" class="lh-btn" data-bulk="start">Set starting stock</button>
        <button type="button" class="lh-btn" data-bulk="active">Make active</button>
        <button type="button" class="lh-btn" data-bulk="inactive">Make inactive</button>
        <button type="button" class="lh-btn is-quiet" data-bulk="clear">Clear selection</button>
      </div>` : ""}
      <div data-role="plist"></div>`;
    drawProductList();
  }

  function drawProductList() {
    const box = body.querySelector('[data-role="plist"]');
    if (!box) return;
    const rows = productRows();
    // Only products that are still shown stay ticked
    const shown = new Set(rows.map((p) => p.id));
    [...st.sel].forEach((id) => { if (!shown.has(id)) st.sel.delete(id); });

    const line = (p) => `
      <div class="inv-prow${p.active ? "" : " is-off"}">
        <span class="inv-name inv-name-pick">${canManage
          ? `<input type="checkbox" class="inv-pick" data-pick="${esc(p.id)}" aria-label="Select ${esc(p.name)}" />` : ""}
          <span><strong>${esc(p.name)}${p.active ? "" : ' <em class="inv-off">Inactive</em>'}</strong>
          <small>${esc([packText(p), suppliersText(p) || "No supplier yet", p.supplierCode && `Code ${p.supplierCode}`, countText(p)].filter(Boolean).join(" · "))}</small></span></span>
          <span class="inv-price">${esc([p.cost !== null && `Cost ${money(p.cost)} / ${p.orderUnit}`, p.price !== null && `Retail ${money(p.price)}`].filter(Boolean).join(" · "))}</span>
        ${p.tracked ? '<span class="inv-flag is-info">Batch &amp; expiry</span>' : "<span></span>"}
        ${canManage ? `<button type="button" class="lh-btn" data-edit-product="${esc(p.id)}">Edit</button>` : "<span></span>"}
      </div>`;

    box.innerHTML = rows.length
      ? `${canManage ? `<label class="fe-check inv-pickall"><input type="checkbox" data-pickall /> Select all ${rows.length} shown</label>` : ""}
        ${INV_CATEGORIES.map((c) => {
          const items = rows.filter((p) => p.category === c.key);
          return items.length ? `<section class="inv-group"><h3>${canManage
            ? `<input type="checkbox" class="inv-pick" data-pickcat="${c.key}" aria-label="Select all ${esc(c.label)}" />` : ""}${esc(c.label)}<em>${items.length}</em></h3>
            <div class="inv-plist">${items.map(line).join("")}</div></section>` : "";
        }).join("")}`
      : `<div class="tm-empty">${st.products.length ? "No products match." : "No products yet."}</div>`;
    syncPick();
  }

  // Ticks, the category and "all" boxes (including half-ticked), and the action bar
  function syncPick() {
    const rows = productRows();
    body.querySelectorAll("[data-pick]").forEach((cb) => {
      cb.checked = st.sel.has(cb.dataset.pick);
      cb.closest(".inv-prow").classList.toggle("is-picked", cb.checked);
    });
    const setBox = (cb, ids) => {
      const n = ids.filter((id) => st.sel.has(id)).length;
      cb.checked = n > 0 && n === ids.length;
      cb.indeterminate = n > 0 && n < ids.length;
    };
    body.querySelectorAll("[data-pickcat]").forEach((cb) =>
      setBox(cb, rows.filter((p) => p.category === cb.dataset.pickcat).map((p) => p.id)));
    const all = body.querySelector("[data-pickall]");
    if (all) setBox(all, rows.map((p) => p.id));
    const bar = body.querySelector('[data-role="bulk"]');
    if (bar) {
      bar.hidden = !st.sel.size;
      bar.querySelector('[data-role="selcount"]').textContent = `${st.sel.size} selected`;
    }
  }

  // Saves each changed product (4 at a time). change(p) returns the fields to change, or null to skip.
  async function runBulk(list, change, onProgress = () => {}) {
    const todo = list.map((p) => [p, change(p)]).filter(([, c]) => c);
    if (!todo.length) { showToast("Nothing to change: they're already set that way."); return; }
    let done = 0;
    const failed = [];
    const queue = todo.slice();
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const [p, c] = queue.shift();
        const { id, stock, updatedAt, ...base } = p;
        try { await saveProduct(id, { ...base, ...c }, staff); }
        catch (err) { console.error("Bulk save failed:", p.name, err); failed.push(p.name); }
        onProgress(++done, todo.length);
      }
    }));
    showToast(failed.length
      ? `Updated ${todo.length - failed.length}. Couldn't save: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`
      : `Updated ${todo.length} product${todo.length === 1 ? "" : "s"}`);
    st.sel.clear();
    await load();
  }

  async function bulkAction(kind) {
    if (kind === "clear") { st.sel.clear(); syncPick(); return; }
    const list = st.products.filter((p) => st.sel.has(p.id));
    if (!list.length) return;
    const many = `${list.length} product${list.length === 1 ? "" : "s"}`;

    if (kind === "active" || kind === "inactive") {
      const on = kind === "active";
      const ok = await confirmDialog({
        title: `${on ? "Make active" : "Make inactive"}: ${many}?`,
        message: on ? "They'll show in stock and ordering again." : "They'll be hidden from stock and ordering. Their stock and history are kept.",
        confirmLabel: on ? "Make active" : "Make inactive", tone: on ? undefined : "warning",
      });
      if (ok) await runBulk(list, (p) => (p.active === on ? null : { active: on }));
      return;
    }

    if (kind === "count") { bulkCount(list, many); return; }
    if (kind === "start") { bulkStart(list, many); return; }
    if (kind !== "category" && !st.suppliers.length) { showToast("Add a supplier first, in the Suppliers tab."); return; }
    const choices = kind === "remove"
      ? st.suppliers.filter((s) => list.some((p) => suppliesProduct(p, s.id)))
      : st.suppliers.filter((s) => s.active);
    if (kind === "remove" && !choices.length) { showToast("None of the selected products have a supplier yet."); return; }
    const multi = kind === "alt"; // tick several suppliers at once

    // What each action changes on one product (null = nothing to do). For "alt", v is a list of supplier ids.
    const changeFor = (p, v, keep) => {
      if (kind === "category") return p.category === v ? null : { category: v };
      const alts = (p.altSuppliers || []).map((a) => ({ ...a }));
      if (kind === "alt") {
        const add = v.filter((id) => !suppliesProduct(p, id));
        return add.length ? { altSuppliers: [...alts, ...add.map((id) => ({ supplierId: id }))] } : null;
      }
      if (kind === "main") {
        if (p.supplierId === v) return null;
        const was = alts.find((a) => a.supplierId === v);
        const packChanges = !!(was && (was.orderUnit || was.packSize));
        const old = p.supplierId && keep ? [{
          supplierId: p.supplierId, supplierCode: p.supplierCode, cost: p.cost,
          orderUnit: packChanges ? p.orderUnit : "", packSize: packChanges ? p.packSize : null,
        }] : [];
        return {
          supplierId: v,
          supplierCode: was ? was.supplierCode || "" : (p.supplierId ? "" : p.supplierCode),
          cost: was && was.cost !== null && was.cost !== undefined ? was.cost : p.cost,
          ...(packChanges ? { orderUnit: was.orderUnit || p.orderUnit, packSize: was.packSize || p.packSize } : {}),
          altSuppliers: [...old, ...alts.filter((a) => a.supplierId !== v)],
        };
      }
      // remove
      if (!suppliesProduct(p, v)) return null;
      if (p.supplierId !== v) return { altSuppliers: alts.filter((a) => a.supplierId !== v) };
      const [next, ...others] = alts;
      if (!next) return { supplierId: "", supplierCode: "" };
      const pc = !!(next.orderUnit || next.packSize);
      return {
        supplierId: next.supplierId, supplierCode: next.supplierCode || "",
        cost: next.cost !== null && next.cost !== undefined ? next.cost : p.cost,
        ...(pc ? { orderUnit: next.orderUnit || p.orderUnit, packSize: next.packSize || p.packSize } : {}),
        altSuppliers: others,
      };
    };

    const titles = { main: "Set the main supplier", alt: "Add other suppliers", remove: "Remove a supplier", category: "Change category" };
    const help = {
      main: "The usual supplier for these products. The cost stays as it is, unless this supplier's own price is already on file.",
      alt: "Tick every supplier these products can also be ordered from. Add their codes and prices later in each product.",
      remove: "Taken off these products. Where it's the main supplier, the first other supplier becomes the main one.",
      category: "Moves the products to this category.",
    };
    const already = (sid) => list.filter((p) => suppliesProduct(p, sid)).length;
    const picker = kind === "category"
      ? `<label class="lh-field"><span class="lh-label">Category</span><select class="fb-select" name="v">${INV_CATEGORIES.map((c) =>
          `<option value="${c.key}">${esc(c.label)}</option>`).join("")}</select></label>`
      : multi
        ? `<div class="lh-field"><span class="lh-label">Suppliers</span>
            <input type="search" class="fe-input inv-supfind" data-role="supfind" placeholder="Search suppliers" aria-label="Search suppliers" autocomplete="off" />
            <div class="inv-supticks">${choices.map((s) => {
              const n = already(s.id);
              return `<label class="fe-check" data-find="${esc(s.name.toLowerCase())}"><input type="checkbox" name="v" value="${esc(s.id)}" /> ${esc(s.name)}${
                n ? ` <small class="muted">(already on ${n === list.length ? "all" : n})</small>` : ""}</label>`;
            }).join("")}<p class="tb-none" data-role="nomatch" hidden>No suppliers match.</p></div></div>`
        : `<label class="lh-field"><span class="lh-label">Supplier</span><select class="fb-select" name="v">${choices.map((s) =>
            `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select></label>`;

    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${titles[kind]}: ${esc(many)}</h3><p>${help[kind]}</p></div>
        ${picker}
        ${kind === "main" ? '<label class="fe-check"><input type="checkbox" name="keep" checked /> Keep their current main supplier as an other supplier</label>' : ""}
        <p class="inv-hint" data-role="preview"></p>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Apply</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const pv = dlg.querySelector('[data-role="preview"]');
    const err = dlg.querySelector(".lh-error");
    // Search suppliers: ticked ones always stay in view
    const find = dlg.querySelector('[data-role="supfind"]');
    if (find) {
      find.addEventListener("input", () => {
        const q = find.value.trim().toLowerCase();
        let any = false;
        dlg.querySelectorAll(".inv-supticks [data-find]").forEach((row) => {
          const ok = !q || row.dataset.find.includes(q) || row.querySelector("input").checked;
          row.hidden = !ok;
          if (ok) any = true;
        });
        dlg.querySelector('[data-role="nomatch"]').hidden = any;
      });
      find.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
      find.focus();
    }
    const value = () => (multi
      ? [...form.querySelectorAll('[name="v"]:checked')].map((x) => x.value)
      : form.elements.v.value);
    const keepOn = () => !form.elements.keep || form.elements.keep.checked;
    const preview = () => {
      const v = value();
      if (multi && !v.length) { pv.textContent = "Tick one or more suppliers."; return; }
      const n = list.filter((p) => changeFor(p, v, keepOn())).length;
      const ticked = multi ? `${v.length} ticked · ` : "";
      pv.textContent = ticked + (!n ? "Nothing to change: they already have these suppliers."
        : n === list.length ? `All ${n} will change.` : `${n} will change · ${list.length - n} already set that way.`);
    };
    preview();
    form.addEventListener("change", preview);
    let busy = false;
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = value();
      const keep = keepOn();
      if (multi && !v.length) { err.textContent = "Tick at least one supplier."; err.hidden = false; return; }
      if (!list.some((p) => changeFor(p, v, keep))) { dlg.close(); return; }
      err.hidden = true;
      busy = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      await runBulk(list, (p) => changeFor(p, v, keep), (d, t) => { btn.textContent = `Saving ${d} of ${t}…`; });
      busy = false;
      dlg.close();
    });
  }

  // Bulk: how often the selected products are counted at the opening count, and where
  function bulkCount(list, many) {
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Opening count: ${esc(many)}</h3>
          <p>How often these are counted in Task Manager → Opening count, and where. Products due today show in today's count straight away.</p></div>
        <div class="inv-two">
          <label class="lh-field"><span class="lh-label">Count</span>
            <select class="fb-select" name="freq">${[["daily", "Every day"], ["weekly", "Once a week"], ["monthly", "Once a month"], ["never", "Not counted"]]
              .map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
          <label class="lh-field" data-role="dayrow"><span class="lh-label">On</span>
            <select class="fb-select" name="day"></select></label>
          <label class="lh-field inv-span" data-role="whererow"><span class="lh-label">Count in</span>
            <select class="fb-select" name="where">
              <option value="">Keep each product's setting</option>
              <option value="both">Shelf and JT storage</option>
              <option value="shelf">Shelf only</option>
              <option value="jt">JT storage only</option>
            </select></label>
        </div>
        <p class="inv-hint" data-role="preview"></p>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Apply</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const f = form.elements;
    const pv = dlg.querySelector('[data-role="preview"]');
    let dayFor = "";

    // The day list follows the frequency (weekly: Monday…Sunday, monthly: 1st…28th or the last day)
    const syncDay = () => {
      const freq = f.freq.value;
      dlg.querySelector('[data-role="dayrow"]').hidden = freq !== "weekly" && freq !== "monthly";
      dlg.querySelector('[data-role="whererow"]').hidden = freq === "never";
      if (dayFor === freq) return;
      const opts = freq === "weekly" ? [1, 2, 3, 4, 5, 6, 0].map((d) => [String(d), WEEKDAYS[d]])
        : freq === "monthly" ? [...Array.from({ length: 28 }, (_, i) => [String(i + 1), `The ${ordinal(i + 1)}`]), ["last", "The last day of the month"]] : [];
      f.day.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
      dayFor = freq;
    };

    const want = (p) => {
      const freq = f.freq.value;
      const hasDay = freq === "weekly" || freq === "monthly";
      return {
        countFreq: freq,
        countDay: hasDay ? f.day.value : null,
        countWhere: freq === "never" ? (p.countWhere || "both") : (f.where.value || p.countWhere || "both"),
      };
    };
    const changeFor = (p) => {
      const w = want(p);
      const same = (p.countFreq || "never") === w.countFreq
        && (w.countDay === null || String(p.countDay) === String(w.countDay))
        && (p.countWhere || "both") === w.countWhere;
      return same ? null : w;
    };
    const preview = () => {
      syncDay();
      const n = list.filter((p) => changeFor(p)).length;
      const freq = f.freq.value;
      const sample = { countFreq: freq, countDay: f.day.value, countWhere: f.where.value || "both" };
      const what = freq === "never" ? "They won't be counted." : `${countText(sample)}${f.where.value ? "" : " (where: as each product is set)"}.`;
      pv.textContent = `${what} ${!n ? "Nothing to change: they're already set that way."
        : n === list.length ? `All ${n} will change.` : `${n} will change · ${list.length - n} already set that way.`}`;
    };
    preview();
    form.addEventListener("change", preview);

    let busy = false;
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!list.some((p) => changeFor(p))) { dlg.close(); return; }
      busy = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      await runBulk(list, changeFor, (d, t) => { btn.textContent = `Saving ${d} of ${t}…`; });
      busy = false;
      dlg.close();
    });
  }

  // Bulk: type in what's physically there now, as each product's starting point. An empty box = leave it as it is.
  function bulkStart(list, many) {
    const fields = []; // { p, loc, batch, expiry, have }
    const box = (f, label) => {
      const i = fields.push(f) - 1;
      return `<input class="fe-input inv-num" type="number" min="0" step="1" inputmode="numeric" data-sp="${i}"
        placeholder="${f.have}" aria-label="${esc(`${f.p.name}: ${label}`)}" />`;
    };
    const card = (p) => {
      const head = `<div class="inv-sp-name"><strong>${esc(p.name)}</strong><small>${esc(unitPlural(p.stockUnit))}</small></div>`;
      if (!p.tracked) {
        return `<div class="inv-sp">${head}<div class="inv-sp-locs">${LOCATIONS.map((l) => `
          <label class="inv-sp-loc"><span>${esc(l.label)}<small>Digital ${p.stock[l.key]}</small></span>
            ${box({ p, loc: l.key, batch: "", expiry: "", have: p.stock[l.key] }, l.label)}</label>`).join("")}</div></div>`;
      }
      const lots = lotsOf(p.id);
      const bn = batchName(p).toLowerCase();
      return `<div class="inv-sp">${head}${lots.length
        ? `<div class="inv-sp-locs">${lots.map((l) => `
            <label class="inv-sp-loc"><span>${esc(locLabel(l.loc))} · ${esc(batchText(p, l.batch))}<small>Exp ${esc(niceDate(l.expiry))} · digital ${l.qty}</small></span>
              ${box({ p, loc: l.loc, batch: l.batch, expiry: l.expiry, have: l.qty }, `${locLabel(l.loc)} ${batchText(p, l.batch)}`)}</label>`).join("")}</div>
          <small class="fe-note">Another ${esc(bn)} that isn't listed? Add it with Add stock in the product's window.</small>`
        : `<p class="tb-none">No stock recorded yet. Use Add stock in the product's window to enter each ${esc(bn)} with its expiry.</p>`}</div>`;
    };

    const dlg = openDialog("inv-dlg inv-spdlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Set starting stock: ${esc(many)}</h3>
          <p>Type what's physically there now. Digital is set to that number, and each change is logged in Activity as “Starting stock set”.
            Leave a box empty to keep it as it is.</p></div>
        <div class="inv-sp-list">${list.map(card).join("")}</div>
        <p class="inv-hint" data-role="preview"></p>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Set starting stock</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const pv = dlg.querySelector('[data-role="preview"]');
    const err = dlg.querySelector(".lh-error");
    const inputs = () => [...form.querySelectorAll("[data-sp]")];

    // What's been typed: null for an empty box
    const read = () => inputs().map((el) => {
      const raw = el.value.trim();
      if (raw === "") return null;
      const n = Number(raw);
      return { ...fields[Number(el.dataset.sp)], qty: n, bad: !Number.isInteger(n) || n < 0 };
    }).filter(Boolean);

    const preview = () => {
      inputs().forEach((el) => {
        const f = fields[Number(el.dataset.sp)];
        const v = el.value.trim();
        el.closest(".inv-sp-loc").classList.toggle("is-set", v !== "" && Number(v) !== f.have);
      });
      const typed = read();
      const ch = typed.filter((t) => !t.bad && t.qty !== t.have);
      const prods = new Set(ch.map((t) => t.p.id)).size;
      pv.textContent = !typed.length ? "Type the numbers you counted. Empty boxes stay as they are."
        : !ch.length ? "Everything typed already matches digital: nothing will change."
        : `${plural(ch.length, "change")} across ${plural(prods, "product")}.`;
    };
    preview();
    form.addEventListener("input", preview);

    // Enter moves to the next box instead of saving
    form.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.matches("[data-sp]")) return;
      e.preventDefault();
      const all = inputs();
      const next = all[all.indexOf(e.target) + 1];
      if (next) { next.focus(); next.select(); } else form.querySelector('[type="submit"]').focus();
    });

    let busy = false;
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const typed = read();
      const bad = typed.find((t) => t.bad);
      if (bad) { err.textContent = `${bad.p.name}: enter a whole number of 0 or more.`; err.hidden = false; return; }
      const ch = typed.filter((t) => t.qty !== t.have);
      if (!ch.length) { err.textContent = "Nothing to change. Type a number that's different from digital."; err.hidden = false; return; }

      const byProduct = new Map();
      ch.forEach((t) => byProduct.set(t.p.id, [...(byProduct.get(t.p.id) || []), t]));
      const queue = [...byProduct.values()];
      const total = queue.length;
      let done = 0, places = 0;
      const failed = [];
      busy = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const g = queue.shift();
          const p = g[0].p;
          try { places += await setStartingStock(p, g.map(({ loc, batch, expiry, qty }) => ({ loc, batch, expiry, qty })), staff); }
          catch (ex) { console.error("Starting stock failed:", p.name, ex); failed.push(p.name); }
          btn.textContent = `Saving ${++done} of ${total}…`;
        }
      }));
      busy = false;
      if (failed.length) {
        err.textContent = `Couldn't save: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}. The others were saved. Try those again.`;
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Set starting stock";
        await load();
        return;
      }
      dlg.close();
      showToast(`Starting stock set: ${plural(places, "change")} across ${plural(total, "product")}`);
      st.sel.clear();
      await load();
    });

    const first = form.querySelector("[data-sp]");
    if (first) first.focus();
  }

  /* ---------- Suppliers ---------- */
  function renderSuppliers() {
    if (!st.suppliers.length) {
      body.innerHTML = `<div class="tm-empty"><strong>No suppliers yet.</strong>${canManage
        ? '<div class="tm-empty-act"><button type="button" class="ff-btn is-primary" data-act="new-supplier">+ New supplier</button></div>' : ""}</div>`;
      return;
    }
    body.innerHTML = `<div class="inv-sups">${st.suppliers.map((s) => {
      const n = st.products.filter((p) => p.active && suppliesProduct(p, s.id)).length;
      return `
        <article class="inv-sup${s.active ? "" : " is-off"}">
          <div class="inv-sup-head"><strong>${esc(s.name)}</strong>${s.active ? "" : '<em class="inv-off">Inactive</em>'}
            <span class="inv-flag is-info">${n} product${n === 1 ? "" : "s"}</span></div>
          <dl>
            ${s.contactName ? `<dt>Contact</dt><dd>${esc(s.contactName)}</dd>` : ""}
            ${s.email ? `<dt>Order email</dt><dd><a href="mailto:${esc(s.email)}">${esc(s.email)}</a>${s.ccEmail ? ` <small>cc ${esc(s.ccEmail)}</small>` : ""}</dd>` : ""}
            ${s.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(s.phone.replace(/\s+/g, ""))}">${esc(s.phone)}</a></dd>` : ""}
            ${s.accountNo ? `<dt>Account</dt><dd>${esc(s.accountNo)}</dd>` : ""}
            ${s.website ? `<dt>Website</dt><dd><a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.website.replace(/^https?:\/\//, ""))}</a></dd>` : ""}
            ${s.orderNotes ? `<dt>Ordering notes</dt><dd>${esc(s.orderNotes)}</dd>` : ""}
          </dl>
          ${canManage ? `<button type="button" class="lh-btn" data-edit-supplier="${esc(s.id)}">Edit</button>` : ""}
        </article>`;
    }).join("")}</div>`;
  }

  /* ---------- Activity ---------- */
  async function renderActivity() {
    body.innerHTML = '<div class="skeleton" style="height:240px;border-radius:14px"></div>';
    try {
      const moves = await listMoves({ max: 200 });
      if (root.isConnected) body.innerHTML = movesHtml(moves, true, labelOf);
    } catch (err) {
      console.error("Inventory activity failed:", err);
      if (root.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the activity."))}</div>`;
    }
  }

  /* ---------- Product editor ---------- */
  function editProduct(p) {
    const isNew = !p;
    const x = p || { category: st.cat || "general", stockUnit: "", orderUnit: "", packSize: 1, reorder: {}, active: true, tracked: false };
    const hasStock = !!p && (p.stock.shelf + p.stock.jt) > 0;
    const val = (v) => esc(v === null || v === undefined ? "" : v);
    // One "other supplier" row: supplier, their code, their price, and (optional) a different pack
    const altRow = (a = {}) => `
      <div class="inv-alt" data-alt>
        <select class="fb-select" data-a="supplierId" aria-label="Supplier"><option value="">Choose a supplier…</option>${
          st.suppliers.filter((x) => x.active || x.id === a.supplierId).map((x) =>
            `<option value="${esc(x.id)}"${x.id === a.supplierId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
        <input data-a="supplierCode" maxlength="60" placeholder="Their code" value="${val(a.supplierCode)}" aria-label="Their product code" />
        <input data-a="cost" type="number" min="0" step="0.01" placeholder="Their price $" value="${val(a.cost)}" aria-label="Their price" />
        <input data-a="orderUnit" maxlength="30" placeholder="Bought as (same)" value="${val(a.orderUnit)}" aria-label="Bought as" />
        <input data-a="packSize" type="number" min="1" step="1" placeholder="How many (same)" value="${val(a.packSize)}" aria-label="How many in each" />
        <button type="button" class="ib-tool is-danger" data-act="alt-remove" aria-label="Remove this supplier" title="Remove">×</button>
      </div>`;
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${isNew ? "New product" : `Edit ${esc(x.name)}`}</h3>
          <p>Stock is changed from the product's stock window, so every change is logged.</p></div>
        <div class="inv-two">
          <label class="lh-field inv-span"><span class="lh-label">Product name</span>
            <input name="name" maxlength="150" placeholder="e.g. Xeomin 100 units" value="${val(x.name)}" /></label>
          <label class="lh-field"><span class="lh-label">Category</span><select class="fb-select" name="category">${INV_CATEGORIES.map((c) =>
            `<option value="${c.key}"${x.category === c.key ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></label>
          <label class="lh-field"><span class="lh-label">Brand (optional)</span><input name="brand" maxlength="80" value="${val(x.brand)}" /></label>
          <label class="lh-field"><span class="lh-label">Main supplier</span><select class="fb-select" name="supplierId">
            <option value="">No supplier yet</option>${st.suppliers.map((s) =>
              `<option value="${esc(s.id)}"${x.supplierId === s.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
          <label class="lh-field"><span class="lh-label">Main supplier's product code (optional)</span><input name="supplierCode" maxlength="60" value="${val(x.supplierCode)}" /></label>
          <div class="lh-field inv-span"><span class="lh-label">Other suppliers (optional)</span>
            <div class="inv-alts" data-role="alts">${(x.altSuppliers || []).map(altRow).join("")}</div>
            <button type="button" class="hx-add" data-act="alt-add">+ Add another supplier</button>
            <small class="fe-note">The ordering team can choose any of these when ordering. Price and pack can differ; leave them blank if they're the same as the main supplier.</small></div>

          <label class="lh-field"><span class="lh-label">Given to staff as</span>
            <input name="stockUnit" maxlength="30" placeholder="e.g. vial, syringe, needle" value="${val(x.stockUnit)}" />
            <small class="fe-note">What someone takes off the Shelf. Xeomin: vial. Belotero: syringe.</small></label>
          <div class="lh-field inv-dose"><span class="lh-label" data-role="doselbl">Amount in each (injectables)</span>
            <div class="inv-dose-row">
              <input name="dosePer" type="number" min="0" step="any" placeholder="e.g. 100" value="${val(x.dosePer)}" aria-label="Amount" />
              <input name="doseUnit" maxlength="20" placeholder="units / mL" value="${val(x.doseUnit)}" aria-label="Measured in" />
            </div>
            <small class="fe-note">What's given to patients. Xeomin: 100 units. Belotero: 1 mL. Leave empty for needles, gauze…</small></div>
          <label class="lh-field"><span class="lh-label">Bought from the supplier as</span>
            <input name="orderUnit" maxlength="30" placeholder="Same, or e.g. box" value="${val(x.orderUnit)}" />
            <small class="fe-note">Usually the same (vial). Type box or pack if they come boxed.</small></label>
          <label class="lh-field" data-role="packrow"><span class="lh-label" data-role="packlbl">How many in each box</span>
            <input name="packSize" type="number" min="1" step="1" value="${val(x.packSize)}" /></label>

           <label class="lh-field inv-span"><span class="lh-label">How it's used in treatments</span>
            <select class="fb-select" name="usage">
              <option value="storage"${!["kit", "shared"].includes(x.usage) ? " selected" : ""}>From the Shelf, one per patient (e.g. Belotero, needles)</option>
              <option value="shared"${x.usage === "shared" ? " selected" : ""}>From the Shelf, opened and shared across patients (e.g. numbing cream)</option>
              <option value="kit"${x.usage === "kit" ? " selected" : ""}>Carried in injectors' kits, shared across patients (e.g. Xeomin)</option>
            </select>
            <small class="fe-note" data-role="usagenote"></small></label>
          <label class="lh-field" data-role="shrow"><span class="lh-label">Typical amount per use (optional)</span>
            <div class="fe-num"><input name="perUse" type="number" min="0" step="any" placeholder="e.g. 2" value="${val(x.perUse)}" /><span data-role="perunit">mL</span></div>
            <small class="fe-note">Filled in on treatment records, and used to spot a container that runs out early.</small></label>
          <label class="lh-field" data-role="shrow"><span class="lh-label">Discard after opening (optional)</span>
            <div class="fe-num"><input name="openDays" type="number" min="1" step="1" placeholder="No limit" value="${val(x.openDays)}" /><span>days</span></div>
            <small class="fe-note">From the packaging's "use within" symbol. Never later than the expiry date.</small></label>

          <label class="lh-field"><span class="lh-label" data-role="costlbl">Cost per vial, $ (optional)</span><input name="cost" type="number" min="0" step="0.01" value="${val(x.cost)}" /></label>
          <label class="lh-field"><span class="lh-label">Retail price, $ (optional)</span><input name="price" type="number" min="0" step="0.01" value="${val(x.price)}" /></label>
          <label class="lh-field"><span class="lh-label">Barcode (optional)</span><input name="barcode" maxlength="60" value="${val(x.barcode)}" /></label>
          <label class="lh-field"><span class="lh-label">Reorder when Shelf is at or below</span><input name="reShelf" type="number" min="0" step="1" placeholder="No alert" value="${val(x.reorder.shelf)}" /></label>
          <label class="lh-field"><span class="lh-label">Reorder when JT storage is at or below</span><input name="reJt" type="number" min="0" step="1" placeholder="No alert" value="${val(x.reorder.jt)}" /></label>
          <label class="lh-field"><span class="lh-label">Opening count</span>
            <select class="fb-select" name="countFreq">
              ${[["never", "Not counted"], ["daily", "Every day"], ["weekly", "Once a week"], ["monthly", "Once a month"]].map(([v, l]) =>
                `<option value="${v}"${(x.countFreq || "never") === v ? " selected" : ""}>${l}</option>`).join("")}
            </select>
            <small class="fe-note">When Reception counts it in Task Manager → Opening count.</small></label>
          <label class="lh-field" data-role="countdayrow"><span class="lh-label">On</span>
            <select class="fb-select" name="countDay"></select></label>
          <label class="lh-field" data-role="countwhererow"><span class="lh-label">Count in</span>
            <select class="fb-select" name="countWhere">
              ${[["both", "Shelf and JT storage"], ["shelf", "Shelf only"], ["jt", "JT storage only"]].map(([v, l]) =>
                `<option value="${v}"${(x.countWhere || "both") === v ? " selected" : ""}>${l}</option>`).join("")}
            </select></label>
          <label class="lh-field"><span class="lh-label">Where it's kept on the Shelf (optional)</span>
            <input name="shelfPos" maxlength="30" placeholder="e.g. A2 or Fridge, top" value="${val(x.shelfPos)}" />
            <small class="fe-note">The opening count can list products in this order, so staff walk the shelf once.</small></label>
          <label class="lh-field"><span class="lh-label">Where it's kept in JT storage (optional)</span>
            <input name="jtPos" maxlength="30" placeholder="e.g. Cabinet 2" value="${val(x.jtPos)}" /></label>
          <label class="lh-field"><span class="lh-label">When a count doesn't match digital</span>
            <select class="fb-select" name="investigate">
              ${[["", "Default for the category"], ["always", "Always investigate (recount + admin review)"],
                ["over", "Investigate when it's worth more than…"], ["never", "Never: straight to Count differences"]].map(([v, l]) =>
                `<option value="${v}"${(x.investigate || "") === v ? " selected" : ""}>${l}</option>`).join("")}
            </select>
            <small class="fe-note">Defaults: Injectables always · General consumables never · others when over $20.</small></label>
          <label class="lh-field" data-role="invoverrow"><span class="lh-label">Worth more than, $</span>
            <input name="investigateOver" type="number" min="0" step="1" placeholder="20" value="${val(x.investigateOver)}" /></label>
        </div>
        <p class="inv-hint" data-role="pack"></p>
        <label class="fe-check"><input type="checkbox" name="tracked"${x.tracked ? " checked" : ""}${hasStock ? " disabled" : ""} />
          Needs a batch / lot number and expiry date (e.g. Xeomin, Belotero)</label>
        ${hasStock ? '<small class="fe-note">This can only be changed while there is no stock. Count it to zero first.</small>' : ""}
        <label class="lh-field"><span class="lh-label">What the packaging calls it</span>
          <input name="batchLabel" maxlength="20" list="inv-batch-names" placeholder="Batch" value="${val(x.batchLabel && x.batchLabel !== "Batch" ? x.batchLabel : "")}" />
          <datalist id="inv-batch-names"><option value="Batch"></option><option value="Lot"></option><option value="LOT"></option><option value="Batch / Lot"></option></datalist>
          <small class="fe-note">Used wherever it's entered or printed, e.g. "Lot 12345". Leave empty for "Batch".</small></label>
        <label class="fe-check"><input type="checkbox" name="active"${x.active !== false ? " checked" : ""} /> Active (shown in stock and ordering)</label>
        <label class="lh-field"><span class="lh-label">Notes (optional)</span><textarea name="notes" rows="2" maxlength="1000">${esc(x.notes || "")}</textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${isNew ? "Add product" : "Save"}</button>
        </div>
      </form>`, { editWording: tab === "products" });
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");

    // Keeps the labels and the summary line in plain words as things are typed
    const packHint = () => {
      const f = form.elements;
      const unit = f.stockUnit.value.trim() || "item";
      const ou = f.orderUnit.value.trim() || unit;
      const same = ou.toLowerCase() === unit.toLowerCase();
      // Bought the same way it's given out (e.g. vial and vial): no pack size needed
      dlg.querySelector('[data-role="packrow"]').style.display = same ? "none" : "";
      if (same) f.packSize.value = 1;
      const n = Math.max(1, parseInt(f.packSize.value, 10) || 1);
      const dp = Number(f.dosePer.value);
      const du = f.doseUnit.value.trim() || "units";
      const kit = f.usage.value === "kit";
      const sh = f.usage.value === "shared";
      dlg.querySelectorAll('[data-role="shrow"]').forEach((el) => { el.style.display = sh ? "" : "none"; });
      dlg.querySelector('[data-role="perunit"]').textContent = f.doseUnit.value.trim() || "mL";
      dlg.querySelector('[data-role="usagenote"]').textContent = sh
        ? `Opening one takes 1 ${unit} off stock. Each treatment record logs a use against the opened ${unit} (staff choose which, if more than one is open) until someone marks it finished. Stock counts only include sealed ones.`
        : kit ? "The clinician takes the vial into their own kit and uses it across patients until it's empty."
        : "The dose given is recorded and any leftover is logged as discarded.";
      dlg.querySelector('[data-role="packlbl"]').textContent = `How many ${unitPlural(unit)} in each ${ou}`;
      dlg.querySelector('[data-role="doselbl"]').textContent = sh ? `Amount in each ${unit} (optional)` : `Amount in each ${unit} (injectables)`;
      dlg.querySelector('[data-role="costlbl"]').textContent = `Cost per ${ou}, $ (optional)`;
      const each = dp > 0 ? ` (${+dp.toFixed(2)} ${du})` : "";
      const per = Number(f.perUse.value);
      const uses = sh && dp > 0 && per > 0 ? ` (about ${Math.max(1, Math.round(dp / per))} uses)` : "";
      dlg.querySelector('[data-role="pack"]').textContent =
        (sh ? `Staff open 1 ${unit}${each} and share it across patients until it's empty${uses}. `
          : `Staff take 1 ${unit}${each} off the Shelf${kit ? " into their own kit, and use it across patients until it's empty" : ""}. `) +
        (same ? `Each ${ou} received adds 1 ${unit} to stock.` : `Each ${ou} received adds ${plural(n, unit)} to stock.`) +
        (kit && !(dp > 0) ? ` Fill in the amount in each ${unit} (e.g. 100 units).` : "");
    };
    
    packHint();
    form.addEventListener("input", packHint);
    form.addEventListener("change", packHint);
    // Opening count: the day picker follows the frequency
    const ord = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
    let dayFor = "";
    const syncCount = () => {
      const f = form.elements;
      const freq = f.countFreq.value;
      dlg.querySelector('[data-role="countdayrow"]').style.display = freq === "weekly" || freq === "monthly" ? "" : "none";
      dlg.querySelector('[data-role="countwhererow"]').style.display = freq === "never" ? "none" : "";
      if (dayFor === freq) return;
      const keep = f.countDay.value || (x.countFreq === freq && x.countDay !== null && x.countDay !== undefined ? String(x.countDay) : "");
      const opts = freq === "weekly" ? [1, 2, 3, 4, 5, 6, 0].map((d) => [String(d), WEEKDAYS[d]])
        : freq === "monthly" ? [...Array.from({ length: 28 }, (_, i) => [String(i + 1), `The ${ord(i + 1)}`]), ["last", "The last day of the month"]] : [];
      f.countDay.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
      if (opts.some(([v]) => v === keep)) f.countDay.value = keep;
      dayFor = freq;
    };
    syncCount();
    form.elements.countFreq.addEventListener("change", syncCount);
    const syncInv = () => { dlg.querySelector('[data-role="invoverrow"]').style.display = form.elements.investigate.value === "over" ? "" : "none"; };
    syncInv();
    form.elements.investigate.addEventListener("change", syncInv);
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="alt-add"]')) {
        dlg.querySelector('[data-role="alts"]').insertAdjacentHTML("beforeend", altRow());
        const rows = dlg.querySelectorAll("[data-alt]");
        rows[rows.length - 1].querySelector("select").focus();
        return;
      }
      const rm = e.target.closest('[data-act="alt-remove"]');
      if (rm) rm.closest("[data-alt]").remove();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await saveProduct(p ? p.id : "", {
          name: f.name.value, category: f.category.value, brand: f.brand.value, supplierId: f.supplierId.value,
          supplierCode: f.supplierCode.value,
          altSuppliers: [...form.querySelectorAll("[data-alt]")].map((r) => ({
            supplierId: r.querySelector('[data-a="supplierId"]').value,
            supplierCode: r.querySelector('[data-a="supplierCode"]').value,
            cost: r.querySelector('[data-a="cost"]').value,
            orderUnit: r.querySelector('[data-a="orderUnit"]').value,
            packSize: r.querySelector('[data-a="packSize"]').value,
          })).filter((a) => a.supplierId),
          stockUnit: f.stockUnit.value,
          orderUnit: f.orderUnit.value.trim() || f.stockUnit.value,
          packSize: f.packSize.value, cost: f.cost.value, price: f.price.value, barcode: f.barcode.value,
          dosePer: f.dosePer.value, doseUnit: f.doseUnit.value,
          usage: f.usage.value,
          perUse: f.perUse.value, openDays: f.openDays.value,
          batchLabel: f.batchLabel.value,
          countFreq: f.countFreq.value, countDay: f.countDay.value, countWhere: f.countWhere.value,
          shelfPos: f.shelfPos.value, jtPos: f.jtPos.value,
          investigate: f.investigate.value, investigateOver: f.investigateOver.value,
          reorder: { shelf: f.reShelf.value, jt: f.reJt.value },
          tracked: hasStock ? x.tracked : f.tracked.checked, active: f.active.checked, notes: f.notes.value,
        }, staff);
        dlg.close();
        showToast(isNew ? "Product added" : "Product saved");
        load();
      } catch (ex) {
        console.error("Save product failed:", ex);
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.elements.name.focus();
  }

  /* ---------- Supplier editor ---------- */
  function editSupplier(s) {
    const isNew = !s;
    const x = s || { active: true };
    const val = (v) => esc(v || "");
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${isNew ? "New supplier" : `Edit ${esc(x.name)}`}</h3>
          <p>Purchase orders are emailed to the order email, with the CC copied in.</p></div>
        <div class="inv-two">
          <label class="lh-field inv-span"><span class="lh-label">Company</span><input name="name" maxlength="120" value="${val(x.name)}" /></label>
          <label class="lh-field"><span class="lh-label">Contact person</span><input name="contactName" maxlength="120" value="${val(x.contactName)}" /></label>
          <label class="lh-field"><span class="lh-label">Phone</span><input name="phone" maxlength="40" value="${val(x.phone)}" /></label>
          <label class="lh-field"><span class="lh-label">Order email</span><input name="email" type="email" maxlength="254" value="${val(x.email)}" /></label>
          <label class="lh-field"><span class="lh-label">CC on orders (optional)</span><input name="ccEmail" type="email" maxlength="254" value="${val(x.ccEmail)}" /></label>
          <label class="lh-field"><span class="lh-label">Our account number (optional)</span><input name="accountNo" maxlength="60" value="${val(x.accountNo)}" /></label>
          <label class="lh-field"><span class="lh-label">Website (optional)</span><input name="website" maxlength="300" value="${val(x.website)}" /></label>
          <label class="lh-field inv-span"><span class="lh-label">Address (optional)</span><input name="address" maxlength="300" value="${val(x.address)}" /></label>
        </div>
        <label class="lh-field"><span class="lh-label">Ordering notes (optional)</span>
          <textarea name="orderNotes" rows="2" maxlength="1000" placeholder="e.g. Orders before 2pm ship same day. Minimum order $200.">${esc(x.orderNotes || "")}</textarea></label>
        <label class="fe-check"><input type="checkbox" name="active"${x.active !== false ? " checked" : ""} /> Active</label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${isNew ? "Add supplier" : "Save"}</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await saveSupplier(s ? s.id : "", {
          name: f.name.value, contactName: f.contactName.value, phone: f.phone.value, email: f.email.value,
          ccEmail: f.ccEmail.value, accountNo: f.accountNo.value, website: f.website.value, address: f.address.value,
          orderNotes: f.orderNotes.value, active: f.active.checked,
        }, staff);
        dlg.close();
        showToast(isNew ? "Supplier added" : "Supplier saved");
        load();
      } catch (ex) {
        console.error("Save supplier failed:", ex);
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.elements.name.focus();
  }

  /* ---------- Stock actions: add, count, move, write off ---------- */
  function stockAction(p, mode) {
    const lots = lotsOf(p.id);
    const unit = p.stockUnit;
    const lotLabel = (l) => `${locLabel(l.loc)} · ${batchText(p, l.batch)} · Exp ${niceDate(l.expiry)} · ${plural(l.qty, unit)}`;
    const qtyField = (label) => `<label class="lh-field"><span class="lh-label">${label}</span>
      <div class="fe-num"><input class="fe-input" name="qty" type="number" min="1" step="1" /><span>${esc(unitPlural(unit))}</span></div></label>`;
    let inner = "";
    let title = "";
    let sub = "";

    if (mode === "add") {
      title = "Add stock";
      sub = "For opening balances and stock found. Deliveries go through Receive delivery, so they're matched to their purchase order.";
      inner = `
        <div class="lh-field"><span class="lh-label">Where</span>${seg("loc", LOCATIONS.map((l) => [l.key, l.label]), "shelf")}</div>
        ${p.tracked ? `<div class="inv-two">
        <label class="lh-field"><span class="lh-label">${esc(batchName(p))} number</span><input name="batch" maxlength="40" autocomplete="off" /></label>
          <label class="lh-field"><span class="lh-label">Expiry date</span><input name="expiry" type="date" /></label></div>` : ""}
        ${qtyField("How many")}
        <label class="lh-field"><span class="lh-label">Reason</span><select class="fb-select" name="reason">${ADD_REASONS.map((r) => `<option>${r}</option>`).join("")}</select></label>`;
    } else if (mode === "count") {
      title = "Count stock";
      sub = "Enter what's physically there. Any difference is logged.";
      inner = p.tracked
            ? (lots.length ? `<table class="inv-table"><thead><tr><th>Storage</th><th>${esc(batchName(p))}</th><th>Expiry</th><th>System</th><th>Counted</th></tr></thead><tbody>${
            lots.map((l, i) => `<tr><td>${esc(locLabel(l.loc))}</td><td>${esc(l.batch)}</td><td>${esc(niceDate(l.expiry))}</td><td>${l.qty}</td>
              <td><input class="fe-input inv-num" type="number" min="0" step="1" data-count="${i}" value="${l.qty}" aria-label="Counted" /></td></tr>`).join("")}</tbody></table>
            <small class="fe-note">A batch that isn't listed? Close this and use Add stock.</small>`
          : '<p class="tb-none">Nothing in stock yet. Use Add stock to enter what you have, with its batch and expiry.</p>')
        : `<table class="inv-table"><thead><tr><th>Storage</th><th>System</th><th>Counted</th></tr></thead><tbody>${
            LOCATIONS.map((l) => `<tr><td>${esc(l.label)}</td><td>${p.stock[l.key]}</td>
              <td><input class="fe-input inv-num" type="number" min="0" step="1" data-countloc="${l.key}" value="${p.stock[l.key]}" aria-label="Counted" /></td></tr>`).join("")}</tbody></table>`;
    } else if (mode === "move") {
      title = "Move stock";
      sub = "Between the Shelf and JT storage. Both sides are logged together.";
      const from = p.stock.shelf > 0 || p.stock.jt <= 0 ? "shelf" : "jt";
      inner = `
        <div class="lh-field"><span class="lh-label">Direction</span>${seg("from", [["shelf", "Shelf → JT storage"], ["jt", "JT storage → Shelf"]], from)}</div>
        ${p.tracked ? `<label class="lh-field"><span class="lh-label">${esc(batchName(p))}</span><select class="fb-select" name="lot"></select></label>` : ""}
        ${qtyField("How many")}
        <p class="inv-hint" data-role="avail"></p>`;
    } else {
      title = "Write off stock";
      sub = "Removes stock that can't be used. The reason is logged.";
      inner = `
        ${p.tracked
          ? (lots.length ? `<label class="lh-field"><span class="lh-label">${esc(batchName(p))}</span><select class="fb-select" name="lot">${lots.map((l, i) =>
              `<option value="${i}">${esc(lotLabel(l))}${expiryState(l.expiry) === "expired" ? " · EXPIRED" : ""}</option>`).join("")}</select></label>`
            : '<p class="tb-none">There is no stock to write off.</p>')
          : `<div class="lh-field"><span class="lh-label">From</span>${seg("loc", LOCATIONS.map((l) => [l.key, `${l.label} (${p.stock[l.key]})`]), p.stock.shelf > 0 ? "shelf" : "jt")}</div>`}
        ${qtyField("How many")}
        <label class="lh-field"><span class="lh-label">Reason</span><select class="fb-select" name="reason">${WRITEOFF_REASONS.map((r) => `<option>${r}</option>`).join("")}</select></label>`;
    }

    return new Promise((resolve) => {
      let saved = false;
      const dlg = openDialog("inv-dlg", `
        <form class="lh-form" novalidate>
          <div class="lh-dialog-head"><h3>${title}: ${esc(p.name)}</h3><p>${esc(sub)}</p></div>
          ${inner}
          <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="500" /></label>
          <p class="lh-error" role="alert" hidden></p>
          <div class="lh-actions">
            <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
            <button type="submit" class="lh-btn is-primary">${title}</button>
          </div>
        </form>`);
      const form = dlg.querySelector("form");
      const err = dlg.querySelector(".lh-error");
      const f = form.elements;

      // Move: the batches (oldest expiry first) and how many are available
      const moveLots = () => lots.filter((l) => l.loc === f.from.value);
      const syncMove = () => {
        if (mode !== "move") return;
        let avail = p.stock[f.from.value];
        if (p.tracked) {
          const list = moveLots();
          f.lot.innerHTML = list.length
            ? list.map((l, i) => `<option value="${i}">${esc(`${batchText(p, l.batch)} · Exp ${niceDate(l.expiry)} · ${plural(l.qty, unit)}`)}</option>`).join("")
            : '<option value="">Nothing here to move</option>';
          const l = list[Number(f.lot.value)];
          avail = l ? l.qty : 0;
        }
        dlg.querySelector('[data-role="avail"]').textContent = `Available to move: ${plural(avail, unit)}.`;
      };
      syncMove();
      form.addEventListener("change", (e) => { if (e.target.name === "from") syncMove(); if (e.target.name === "lot" && mode === "move") {
        const l = moveLots()[Number(f.lot.value)];
        dlg.querySelector('[data-role="avail"]').textContent = `Available to move: ${plural(l ? l.qty : 0, unit)}.`;
      } });

      dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        err.hidden = true;
        const qty = f.qty ? parseInt(f.qty.value, 10) : 0;
        let ops = [];
        let reason = f.reason ? f.reason.value : "";
        try {
          if (mode === "add") {
            if (!(qty >= 1)) throw new Error("Enter how many.");
            if (p.tracked && !f.batch.value.trim()) throw new Error(`Enter the ${batchName(p).toLowerCase()} number.`);
            if (p.tracked && !f.expiry.value) {
              throw new Error(f.expiry.validity && f.expiry.validity.badInput
                ? "That expiry date doesn't exist. Check the day (e.g. September has 30 days). If the box only shows a month and year, use the last day of that month."
                : "Enter the expiry date.");
            }
            ops = [{ loc: f.loc.value, batch: p.tracked ? f.batch.value : "", expiry: p.tracked ? f.expiry.value : "", delta: qty }];
          } else if (mode === "count") {
            if (p.tracked) {
              ops = lots.map((l, i) => {
                const n = parseInt(form.querySelector(`[data-count="${i}"]`).value, 10);
                if (!(n >= 0)) throw new Error("Enter a count of 0 or more for every batch.");
                return { loc: l.loc, batch: l.batch, expiry: l.expiry, delta: n - l.qty };
              });
            } else {
              ops = LOCATIONS.map((l) => {
                const n = parseInt(form.querySelector(`[data-countloc="${l.key}"]`).value, 10);
                if (!(n >= 0)) throw new Error("Enter a count of 0 or more.");
                return { loc: l.key, delta: n - p.stock[l.key] };
              });
            }
            reason = "Stock count";
          } else if (mode === "move") {
            if (!(qty >= 1)) throw new Error("Enter how many to move.");
            const from = f.from.value;
            const to = from === "shelf" ? "jt" : "shelf";
            const l = p.tracked ? moveLots()[Number(f.lot.value)] : null;
            if (p.tracked && !l) throw new Error("There's nothing in that storage to move.");
            const b = l ? l.batch : "";
            const x = l ? l.expiry : "";
            ops = [{ loc: from, batch: b, expiry: x, delta: -qty }, { loc: to, batch: b, expiry: x, delta: qty }];
            reason = `${locLabel(from)} → ${locLabel(to)}`;
          } else {
            if (!(qty >= 1)) throw new Error("Enter how many to write off.");
            if (p.tracked) {
              const l = lots[Number(f.lot.value)];
              if (!l) throw new Error("There is no stock to write off.");
              ops = [{ loc: l.loc, batch: l.batch, expiry: l.expiry, delta: -qty }];
            } else {
              ops = [{ loc: f.loc.value, delta: -qty }];
            }
          }
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          return;
        }
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
          await applyStock(p, { type: mode, ops, reason, note: f.note.value }, staff);
          saved = true;
          dlg.close();
          showToast(mode === "move" ? "Stock moved" : mode === "count" ? "Count saved" : mode === "add" ? "Stock added" : "Stock written off");
        } catch (ex) {
          console.error("Stock change failed:", ex);
          err.textContent = errText(ex, "Couldn't save. Try again.");
          err.hidden = false;
          btn.disabled = false;
          btn.textContent = title;
        }
      });
      dlg.addEventListener("close", () => resolve(saved));
    });
  }

  // The counted side of the three counters: the last opening count, and whether it matched digital
  function countLine(pid, loc) {
    const c = st.lastCounts.get(`${pid}|${loc}`);
    if (!c) return '<small class="ivx-cl">Not counted yet</small>';
    const d = niceDate(c.dateKey);
    const inv = c.invIds.map((iid) => st.invs.find((v) => v.id === iid)).find(Boolean);
    if (inv) return `<small class="ivx-cl is-bad">Counted ${c.counted} on ${esc(d)} · <a href="#/inventory/investigations/${esc(inv.id)}">Investigating</a></small>`;
    if (c.statuses.includes("open")) return `<small class="ivx-cl is-warn">Counted ${c.counted} on ${esc(d)} · difference to review</small>`;
    if (c.statuses.includes("investigating")) return `<small class="ivx-cl">Counted ${c.counted} on ${esc(d)} · investigated</small>`;
    return `<small class="ivx-cl is-ok">Counted ${c.counted} on ${esc(d)} ✓ matched</small>`;
  }

  /* ---------- A product's stock window ---------- */
  function openProduct(id) {
    const dlg = openDialog("inv-dlg inv-pdlg", '<div class="lh-form" data-role="pd"></div>');
    const box = dlg.querySelector('[data-role="pd"]');

    const canOpen = canMove || can("consult.record");
    function sharedSecHtml(p) {
      const list = st.open.filter((c) => c.productId === p.id);
      return `<div class="inv-pd-sec"><h4>Opened now <small>(not counted in stock)</small></h4>${list.length ? `<ul class="inv-open">${list.map((c) => {
        const s = openState(c);
        const exp = expectedUses(c);
        return `<li><span><strong>${esc(batchText(p, c.batch) || "No number")}</strong>${c.expiry ? ` · Exp ${esc(niceDate(c.expiry))}` : ""}
            <small>Opened ${esc(when(c.openedAt))}${c.openedBy ? ` by ${esc(c.openedBy)}` : ""} · ${c.uses} use${c.uses === 1 ? "" : "s"}${
              exp ? ` of about ${exp}` : ""}${c.used && c.doseUnit ? ` · ${esc(fmtN(c.used))} ${esc(c.doseUnit)} recorded` : ""}${
              c.useBy ? ` · use by ${esc(niceDate(c.useBy))}` : ""}</small></span>
          ${s ? `<span class="inv-flag is-${s === "overdue" ? "bad" : "warn"}">${s === "overdue" ? "Past use-by" : "Discard soon"}</span>` : "<span></span>"}
          ${canOpen ? `<button type="button" class="lh-btn" data-finish="${esc(c.id)}">Finished</button>` : "<span></span>"}</li>`;
      }).join("")}</ul>` : '<p class="tb-none">None open.</p>'}
        ${canOpen ? `<button type="button" class="hx-add" data-act="open-new">+ Open a new ${esc(p.stockUnit)}</button>` : ""}</div>`;
    }

    function openSharedDialog(p) {
      return new Promise((resolve) => {
        const lots = lotsOf(p.id);
        let saved = false;
        const d2 = openDialog("inv-dlg", `
          <form class="lh-form" novalidate>
            <div class="lh-dialog-head"><h3>Open a new ${esc(p.stockUnit)}: ${esc(p.name)}</h3>
              <p>1 ${esc(p.stockUnit)} comes off stock now. Treatment records then log uses against it until it's marked finished.</p></div>
            ${lots.length ? `<label class="lh-field"><span class="lh-label">Which one</span><select class="fb-select" name="lot">${lots.map((l, i) =>
              `<option value="${i}">${esc(`${locLabel(l.loc)}${p.tracked ? ` · ${batchText(p, l.batch)} · Exp ${niceDate(l.expiry)}` : ""} · ${plural(l.qty, p.stockUnit)}`)}</option>`).join("")}</select></label>`
              : '<p class="tb-none">There are none in stock to open.</p>'}
            <p class="lh-error" role="alert" hidden></p>
            <div class="lh-actions">
              <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
              ${lots.length ? '<button type="submit" class="lh-btn is-primary">Open it</button>' : ""}
            </div>
          </form>`);
        const form = d2.querySelector("form");
        d2.querySelector('[data-act="cancel"]').addEventListener("click", () => d2.close());
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = form.querySelector('[type="submit"]');
          btn.disabled = true;
          try {
            await openContainer(p, lots[Number(form.elements.lot.value)], staff);
            saved = true;
            d2.close();
            showToast(`Opened. It's now in use.`);
          } catch (ex) {
            const err = d2.querySelector(".lh-error");
            err.textContent = errText(ex, "Couldn't save. Try again.");
            err.hidden = false;
            btn.disabled = false;
          }
        });
        d2.addEventListener("close", () => resolve(saved));
      });
    }

    function finishSharedDialog(c, p) {
      return new Promise((resolve) => {
        const exp = expectedUses(c);
        let saved = false;
        const d2 = openDialog("inv-dlg", `
          <form class="lh-form" novalidate>
            <div class="lh-dialog-head"><h3>Finished: ${esc(p.name)}</h3>
              <p>${esc(batchText(p, c.batch) || "No number")} · ${c.uses} use${c.uses === 1 ? "" : "s"}${exp ? ` (expected about ${exp})` : ""}. Stock doesn't change: it came off when it was opened.</p></div>
            ${exp && c.uses < exp * 0.7 ? `<p class="inv-hint">That's fewer uses than expected. Add a note if you know why.</p>` : ""}
            <label class="lh-field"><span class="lh-label">Why</span><select class="fb-select" name="reason">${FINISH_REASONS.map((r) =>
              `<option${r === (openState(c) === "overdue" ? "Past its use-by date" : "Empty") ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
            <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="300" /></label>
            <p class="lh-error" role="alert" hidden></p>
            <div class="lh-actions">
              <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
              <button type="submit" class="lh-btn is-primary">Mark finished</button>
            </div>
          </form>`);
        const form = d2.querySelector("form");
        d2.querySelector('[data-act="cancel"]').addEventListener("click", () => d2.close());
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = form.querySelector('[type="submit"]');
          btn.disabled = true;
          try {
            await finishContainer(c, { reason: form.elements.reason.value, note: form.elements.note.value }, staff);
            saved = true;
            d2.close();
            showToast("Marked finished");
          } catch (ex) {
            const err = d2.querySelector(".lh-error");
            err.textContent = errText(ex, "Couldn't save. Try again.");
            err.hidden = false;
            btn.disabled = false;
          }
        });
        d2.addEventListener("close", () => resolve(saved));
      });
    }

    function draw() {
      const p = st.products.find((x) => x.id === id);
      if (!p) { dlg.close(); return; }
      const lots = lotsOf(id);
      const sup = supplierOf(p.supplierId);
      box.innerHTML = `
        <div class="inv-pd-head">
          <div><h3>${esc(p.name)}</h3>
            <p class="muted">${esc([catLabel(p.category), p.brand, packText(p), p.tracked ? "Batch & expiry tracked" : ""].filter(Boolean).join(" · "))}</p></div>
          <button type="button" class="ib-tool" data-act="close" aria-label="Close" title="Close">×</button>
        </div>
        <div class="inv-pd-qty">${LOCATIONS.map((l) => `
          <div class="inv-pd-loc${lowAt(p, l.key) ? " is-low" : ""}"><span>${esc(l.label)} · digital</span>
            <strong>${esc(qtyText(p, p.stock[l.key]))}</strong>
            ${p.reorder[l.key] !== null ? `<small>${lowAt(p, l.key) ? "Low · " : ""}reorder at ${p.reorder[l.key]}</small>` : ""}
            ${countLine(p.id, l.key)}</div>`).join("")}</div>
          ${canMove || canRequest ? `<div class="inv-pd-acts">
          ${canManage ? '<button type="button" class="lh-btn is-primary" data-stock="add">Add stock</button>' : ""}
          ${canMove ? '<button type="button" class="lh-btn" data-stock="move">Move Shelf ⇄ JT</button>' : ""}
          ${canRequest ? '<button type="button" class="lh-btn" data-act="request">Request more</button>' : ""}
          ${canManage ? `<button type="button" class="lh-btn" data-stock="count">Count</button>
            <button type="button" class="lh-btn" data-stock="writeoff">Write off</button>
            <button type="button" class="lh-btn is-quiet" data-act="edit">Edit product</button>` : ""}
        </div>` : ""}
        ${isSharedProduct(p) ? sharedSecHtml(p) : ""}
        ${p.tracked ? `<div class="inv-pd-sec"><h4>Stock by ${esc(batchName(p).toLowerCase())} <small>(oldest expiry first)</small></h4>${lots.length
          ? `<table class="inv-table"><thead><tr><th>Storage</th><th>${esc(batchName(p))}</th><th>Expiry</th><th>Qty</th></tr></thead><tbody>${lots.map((l) => {
           const ex = expiryState(l.expiry);
              return `<tr><td>${esc(locLabel(l.loc))}</td><td>${esc(l.batch)}</td>
                <td>${esc(niceDate(l.expiry))}${ex ? ` <span class="inv-flag is-${ex === "expired" ? "bad" : "warn"}">${ex === "expired" ? "Expired" : "Soon"}</span>` : ""}</td>
                <td>${esc(qtyText(p, l.qty))}</td></tr>`;
            }).join("")}</tbody></table>`
          : '<p class="tb-none">No batches in stock.</p>'}</div>` : ""}
        ${productSuppliers(p).length ? `<div class="inv-pd-sec"><h4>Supplier${productSuppliers(p).length > 1 ? "s" : ""}</h4>${
          productSuppliers(p).map((t) => {
            const s = supplierOf(t.supplierId);
            if (!s) return "";
            const bits = [
              s.contactName && esc(s.contactName),
              s.phone && `<a href="tel:${esc(s.phone.replace(/\s+/g, ""))}">${esc(s.phone)}</a>`,
              s.email && `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`,
              t.supplierCode && `Code ${esc(t.supplierCode)}`,
              t.cost !== null && esc(`${money(t.cost)} / ${t.orderUnit}`),
              (t.orderUnit !== p.orderUnit || t.packSize !== p.packSize) && esc(`${t.orderUnit} of ${plural(t.packSize, p.stockUnit)}`),
            ].filter(Boolean);
            return `<p class="inv-pd-sup"><strong>${esc(s.name)}</strong>${t.main ? ' <span class="inv-flag is-info">Main</span>' : ""}${
              bits.map((b) => ` · ${b}`).join("")}</p>`;
          }).join("")}</div>` : ""}
        <div class="inv-pd-sec"><h4>Recent activity</h4><div data-role="moves"><p class="tb-none">Loading…</p></div></div>`;
      listMoves({ productId: id, max: 15 })
        .then((m) => { const el = box.querySelector('[data-role="moves"]'); if (el) el.innerHTML = movesHtml(m, false, labelOf); })
        .catch(() => { const el = box.querySelector('[data-role="moves"]'); if (el) el.innerHTML = '<p class="tb-none tb-bad">Couldn\'t load the activity.</p>'; });
    }

    box.addEventListener("click", async (e) => {
      if (e.target.closest('[data-act="close"]')) { dlg.close(); return; }
      const p = st.products.find((x) => x.id === id);
      if (!p) return;
      if (e.target.closest('[data-act="open-new"]')) {
        if (await openSharedDialog(p)) { await load(); if (dlg.open) draw(); }
        return;
      }
      const fin = e.target.closest("[data-finish]");
      if (fin) {
        const c = st.open.find((x) => x.id === fin.dataset.finish);
        if (c && await finishSharedDialog(c, p)) { await load(); if (dlg.open) draw(); }
        return;
      }
      if (e.target.closest('[data-act="edit"]')) { dlg.close(); editProduct(p); return; }
      if (e.target.closest('[data-act="request"]')) { dlg.close(); location.hash = `#/tasks/order/${encodeURIComponent(id)}`; return; }
      const s = e.target.closest("[data-stock]");
      if (s && await stockAction(p, s.dataset.stock)) {
        await load();
        if (dlg.open) draw();
      }
    });
    draw();
  }

  /* ---------- Requests ---------- */
  function renderRequests() {
    const n = (fn) => st.requests.filter(fn).length;
    const counts = {
      open: n((r) => r.status === "open"),
      ordered: n((r) => r.status === "ordered"),
      received: n((r) => r.status === "received"),
      closed: n((r) => r.status === "declined" || r.status === "cancelled"),
    };
    const segF = (name, items, cur, key) => seg(name, items, cur).replace(new RegExp(`name="${name}"`, "g"), `name="${name}" data-f="${key}"`);
    body.innerHTML = `
      <div class="inv-tools">
        ${segF("rq-f", [["open", "Open", counts.open], ["ordered", "Ordered", counts.ordered], ["received", "Received", counts.received],
          ["closed", "Declined & cancelled"], ["all", "All"]], st.reqFilter, "reqFilter")}
        ${st.reqFilter === "open" ? segF("rq-v", [["list", "List"], ["supplier", "By supplier"]], st.reqView, "reqView") : ""}
        <span class="inv-spacer"></span>
        ${canManage ? '<a class="ff-btn" href="#/inventory/notifications">Email notifications</a>' : ""}
        ${canRequest ? '<a class="ff-btn is-primary" href="#/tasks/order">+ Request order</a>' : ""}
      </div>
      <div data-role="reqs"></div>`;
    const box = body.querySelector('[data-role="reqs"]');
    const f = st.reqFilter;
    const rows = st.requests.filter((r) => f === "all" || (f === "closed" ? ["declined", "cancelled"].includes(r.status) : r.status === f));
    if (!rows.length) {
      box.innerHTML = `<div class="tm-empty">${f === "open" ? "No open requests. Nice." : "Nothing here yet."}</div>`;
      return;
    }
    box.innerHTML = f === "open" && st.reqView === "supplier"
      ? bySupplierHtml(rows)
      : `<div class="rq-list">${rows.map(reqCard).join("")}</div>`;
  }

  function reqCard(r) {
    const mine = r.requestedByUid === myUid();
    const items = r.items.map((it, i) => {
      const p = st.products.find((x) => x.id === it.productId);
      const onPo = itemOnPo(r.id, i, st.pos);
      return `<li><strong>${esc(it.name)}</strong> × ${esc(plural(it.qty, it.unit))}${
        p ? ` <small>· now Shelf ${p.stock.shelf}, JT ${p.stock.jt}</small>`
          : it.productId ? "" : ' <span class="inv-flag is-info">Not on the product list</span>'}${
        onPo ? ` <a class="inv-flag is-info" href="#/inventory/po/${esc(onPo.id)}">On ${esc(onPo.number)} · ${esc(PO_STATUS[onPo.status])}</a>` : ""}</li>`;
    }).join("");
    const handled = r.status === "ordered" || r.status === "declined";
    return `
      <article class="rq-card${r.urgency === "urgent" && r.status === "open" ? " is-urgent" : ""}">
        <div class="rq-head">
          <strong>${esc(reqNumber(r))}</strong>
          <span class="rq-status is-${r.status}">${esc(REQ_STATUS[r.status])}</span>
          ${r.urgency === "urgent" ? '<span class="inv-flag is-bad">Urgent</span>' : ""}
          <span class="rq-meta">For ${esc(locLabel(r.loc))} · ${esc(r.requestedBy || "")} · ${esc(when(r.createdAt))}</span>
        </div>
        <ul class="rq-items">${items}</ul>
        ${r.note ? `<p class="rq-note">“${esc(r.note)}”</p>` : ""}
        ${handled ? `<p class="rq-resp"><strong>${esc(REQ_STATUS[r.status])}${r.handledBy ? ` by ${esc(r.handledBy)}` : ""}${
          r.handledAt ? `, ${esc(when(r.handledAt))}` : ""}</strong>${r.response ? `: ${esc(r.response)}` : ""}</p>` : ""}
        ${r.status === "open" && (canMove || mine) ? `<div class="rq-acts">
          ${canMove ? `<button type="button" class="lh-btn is-primary" data-req="ordered" data-id="${esc(r.id)}">Mark as ordered</button>
            <button type="button" class="lh-btn" data-req="declined" data-id="${esc(r.id)}">Decline</button>` : ""}
          ${mine ? `<button type="button" class="lh-btn is-quiet" data-req="cancel" data-id="${esc(r.id)}">Cancel request</button>` : ""}
        </div>` : ""}
      </article>`;
  }

  // Open items not on a purchase order yet, added up per product + storage, then placed under the supplier
  // they'll be ordered from: the one chosen here, otherwise the main supplier. Quantities are in that supplier's units.
  function openItemsBySupplier(rows) {
    const lines = new Map();
    rows.forEach((r) => r.items.forEach((it, i) => {
      if (itemOnPo(r.id, i, st.pos)) return;
      const p = st.products.find((x) => x.id === it.productId) || null;
      const key = `${it.productId || it.name.toLowerCase()}|${r.loc}`;
      const line = lines.get(key) || { key, p, name: it.name, rawUnit: it.unit, rawQty: 0, stockQty: 0, loc: r.loc,
        reqs: [], urgent: false, sources: [], fallbackSid: it.supplierId || "" };
      if (p) line.stockQty += it.unitKind === "stock" ? it.qty : it.qty * Math.max(1, p.packSize);
      else line.rawQty += it.qty;
      line.reqs.push(reqNumber(r));
      line.urgent = line.urgent || r.urgency === "urgent";
      line.sources.push({ r: r.id, i });
      lines.set(key, line);
    }));
    const groups = new Map();
    lines.forEach((l) => {
      const options = l.p ? productSuppliers(l.p) : [];
      const chosen = st.lineSup[l.key];
      const sid = options.some((o) => o.supplierId === chosen) ? chosen : (l.p && l.p.supplierId) || l.fallbackSid || "";
      const t = l.p ? supplierTerms(l.p, sid) : null;
      const pack = Math.max(1, (t && t.packSize) || (l.p && l.p.packSize) || 1);
      const out = { ...l, sid, options,
        qty: l.p ? Math.max(1, Math.ceil(l.stockQty / pack)) : l.rawQty,
        unit: l.p ? (t && t.orderUnit) || l.p.orderUnit : l.rawUnit };
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid).push(out);
    });
    return groups;
  }

  function bySupplierHtml(rows) {
    const groups = openItemsBySupplier(rows);
    if (!groups.size) return '<div class="tm-empty">Everything requested is already on a purchase order.</div>';
    const order = [...groups.keys()].sort((a, b) => !a ? 1 : !b ? -1
      : ((supplierOf(a) || {}).name || "").localeCompare((supplierOf(b) || {}).name || "", "en-AU"));
    const fromCell = (l) => (l.options.length > 1
      ? `<select class="fb-select rq-from" data-linesup="${esc(l.key)}" aria-label="Order from">${l.options.map((o) =>
          `<option value="${esc(o.supplierId)}"${o.supplierId === l.sid ? " selected" : ""}>${esc((supplierOf(o.supplierId) || {}).name || "Unknown supplier")}${
            o.cost !== null ? ` · ${money(o.cost)}/${o.orderUnit}` : ""}${o.main ? " (main)" : ""}</option>`).join("")}</select>`
      : '<small class="muted">Only supplier</small>');
    return order.map((sid) => {
      const s = supplierOf(sid);
      const lines = groups.get(sid);
      return `
        <section class="rq-sup">
          <div class="rq-sup-top">
            <div class="rq-sup-head"><strong>${esc(s ? s.name : "No supplier set")}</strong>
              <small>${esc(s ? [s.contactName, s.email, s.phone].filter(Boolean).join(" · ") : "New items, or products without a supplier")}</small></div>
            ${canMove ? `<button type="button" class="lh-btn is-primary" data-mkpo="${esc(sid)}">${sid ? "Create purchase order" : "Create purchase order…"}</button>` : ""}
          </div>
          <table class="inv-table"><thead><tr><th>Product</th><th>Quantity</th><th>For</th><th>Order from</th><th>Requests</th></tr></thead><tbody>${lines.map((l) => `
            <tr><td>${esc(l.name)}${l.urgent ? ' <span class="inv-flag is-bad">Urgent</span>' : ""}</td><td>${esc(plural(l.qty, l.unit))}</td>
              <td>${esc(locLabel(l.loc))}</td><td>${fromCell(l)}</td><td>${esc([...new Set(l.reqs)].join(", "))}</td></tr>`).join("")}</tbody></table>
        </section>`;
    }).join("");
  }

  /* ---------- Purchase orders ---------- */
  function renderOrders() {
    const n = (s) => st.pos.filter((p) => p.status === s).length;
    const segF = (name, items, cur, key) => seg(name, items, cur).replace(new RegExp(`name="${name}"`, "g"), `name="${name}" data-f="${key}"`);
    const f = st.poFilter;
    const rows = st.pos.filter((p) => f === "all" || p.status === f);
    body.innerHTML = `
      <div class="inv-tools">
        ${segF("po-f", [["draft", "Drafts", n("draft")], ["sent", "Sent", n("sent")], ["part", "Part received", n("part")],
          ["received", "Received"], ["cancelled", "Cancelled"], ["all", "All"]], f, "poFilter")}
        <span class="inv-spacer"></span>
        ${canMove ? '<button type="button" class="btn-primary" data-act="new-po">+ New purchase order</button>' : ""}
      </div>
      ${rows.length ? `<div class="po-list">${rows.map((po) => {
        const bits = [`${po.lines.length} item${po.lines.length === 1 ? "" : "s"}`,
          po.requestIds.length && `${po.requestIds.length} request${po.requestIds.length === 1 ? "" : "s"}`,
          po.sentAt ? `Sent ${when(po.sentAt)}` : `Created ${when(po.createdAt)}`, po.createdBy && `by ${po.createdBy}`].filter(Boolean);
        return `<a class="po-row" href="#/inventory/po/${encodeURIComponent(po.id)}">
          <span class="inv-name"><strong>${esc(po.number)} · ${esc(po.supplier.name)}</strong><small>${esc(bits.join(" · "))}</small></span>
          <span class="rq-status is-${po.status}">${esc(PO_STATUS[po.status])}</span>
          </a>`;
      }).join("")}</div>`
        : `<div class="tm-empty">${f === "draft" ? "No drafts. Create one from Requests → By supplier, or with + New purchase order." : "Nothing here."}</div>`}`;
  }

  function pickSupplier({ title, withLow = false }) {
    return new Promise((resolve) => {
      const act = st.suppliers.filter((s) => s.active);
      if (!act.length) { showToast("Add a supplier first, in the Suppliers tab."); resolve(null); return; }
      let out = null;
      const dlg = openDialog("inv-dlg", `
        <form class="lh-form" novalidate>
          <div class="lh-dialog-head"><h3>${esc(title)}</h3><p>A draft is created. You can change everything before it's sent.</p></div>
          <label class="lh-field"><span class="lh-label">Supplier</span><select class="fb-select" name="sid">${act.map((s) =>
            `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select></label>
          ${withLow ? '<label class="fe-check"><input type="checkbox" name="low" checked /> Start with this supplier\'s low stock</label>' : ""}
          <div class="lh-actions">
            <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
            <button type="submit" class="lh-btn is-primary">Create draft</button>
          </div>
        </form>`);
      const form = dlg.querySelector("form");
      dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        out = { id: form.elements.sid.value, low: withLow && form.elements.low.checked };
        dlg.close();
      });
      dlg.addEventListener("close", () => resolve(out));
    });
  }

  async function startPo(supplierId, lines) {
    const s = st.suppliers.find((x) => x.id === supplierId);
    if (!s) return;
    try {
      const id = await createPo({ supplier: s, lines }, staff);
      showToast("Draft purchase order created");
      location.hash = `#/inventory/po/${encodeURIComponent(id)}`;
    } catch (err) {
      console.error("Create PO failed:", err);
      showToast(errText(err, "Couldn't create the purchase order. Try again."));
    }
  }

  async function makePoFrom(sid) {
    let supplierId = sid;
    if (!supplierId) {
      const pick = await pickSupplier({ title: "Which supplier is this order for?" });
      if (!pick) return;
      supplierId = pick.id;
    }
    const g = openItemsBySupplier(st.requests.filter((r) => r.status === "open")).get(sid);
    if (!g) return;
    const lines = g.map((l) => (l.p
      ? lineFromProduct(l.p, l.qty, l.loc, l.sources, supplierId)
      : cleanPoLine({ name: l.name, qty: l.qty, orderUnit: l.unit, loc: l.loc, sources: l.sources })));
    startPo(supplierId, lines);
  }

  async function newPo() {
    const pick = await pickSupplier({ title: "New purchase order", withLow: true });
    if (!pick) return;
    const lines = [];
    if (pick.low) {
      st.products.filter((p) => p.active && suppliesProduct(p, pick.id)).forEach((p) => LOCATIONS.forEach((l) => {
        if (lowAt(p, l.key)) lines.push(lineFromProduct(p, suggestOrderFor(p, l.key, pick.id), l.key, [], pick.id));
      }));
    }
    startPo(pick.id, lines);
  }

  async function handleReq(id, act) {
    const r = st.requests.find((x) => x.id === id);
    if (!r) return;
    if (act === "cancel") {
      const ok = await confirmDialog({ title: `Cancel ${reqNumber(r)}?`, message: "It will show as cancelled.", confirmLabel: "Cancel request", tone: "warning" });
      if (!ok) return;
      try { await cancelRequest(id, staff); showToast("Request cancelled"); load(); }
      catch (err) { console.error(err); showToast(errText(err, "Couldn't cancel. Try again.")); }
      return;
    }
    const ordered = act === "ordered";
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${ordered ? "Mark as ordered" : "Decline"}: ${esc(reqNumber(r))}</h3>
          <p>${esc(r.requestedBy || "The requester")} is emailed${ordered ? " that it's been ordered" : " with your reason"}.</p></div>
        <label class="lh-field"><span class="lh-label">${ordered ? "Note (optional)" : "Reason"}</span>
          <textarea name="note" rows="3" maxlength="1000" placeholder="${ordered ? "e.g. Ordered by phone, arriving Friday" : "e.g. We have enough in JT storage. Move some across."}"></textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${ordered ? "Mark as ordered" : "Decline request"}</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const note = form.elements.note.value.trim();
      if (!ordered && !note) { err.textContent = "Give a reason, so they know what to do instead."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        await setRequestStatus(id, act, note, staff);
        callApi({ action: "inventory", op: "notifyUpdate", requestId: id }).catch((ex) => console.warn("Update email failed:", ex));
        dlg.close();
        showToast(ordered ? "Marked as ordered" : "Request declined");
        load();
      } catch (ex) {
        console.error("Request update failed:", ex);
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.elements.note.focus();
  }

  async function reqSettings() {
    let staffList, cur;
    try { [staffList, cur] = await Promise.all([fetchStaffList(), getRequestSettings()]); }
    catch (err) { console.error(err); showToast("Couldn't load the email settings. Try again."); return; }
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Order request emails</h3><p>Who gets an email when someone sends an order request.</p></div>
        <div class="tb-staff">${staffList.map((s) => `
          <label class="fe-check"><input type="checkbox" name="who" value="${esc(s.id)}"${cur.notifyIds.includes(s.id) ? " checked" : ""}${s.hasEmail ? "" : " disabled"} />
            ${esc(s.name)} <small class="muted">${esc(s.role || "")}${s.hasEmail ? "" : " · no email on file"}</small></label>`).join("")}</div>
        <label class="fe-check"><input type="checkbox" name="urgentOnly"${cur.urgentOnly ? " checked" : ""} /> Only email about urgent requests</label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await saveRequestSettings({
          notifyIds: [...form.querySelectorAll('[name="who"]:checked')].map((x) => x.value),
          urgentOnly: form.elements.urgentOnly.checked,
        }, staff);
        dlg.close();
        showToast("Email settings saved");
      } catch (ex) {
        const err = dlg.querySelector(".lh-error");
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
      }
    });
  }

  /* ---------- Events ---------- */
  root.addEventListener("click", (e) => {
    if (tab === "receive" && body.contains(e.target)) return;   // the receiving screen handles its own clicks
    if (e.target.closest('[data-act="quick"]')) { toggleQuick(); return; }
    if (e.target.closest('[data-act="quick-discard"]')) { st.qv.clear(); renderStockList(); syncQuickBar(); return; }
    const qs = e.target.closest('[data-act="quick-save"]');
    if (qs) { saveQuick(qs); return; }
    const qb = e.target.closest("[data-qbatch]");
    if (qb) {
      const p = st.products.find((x) => x.id === qb.dataset.qbatch);
      if (p) stockAction(p, "count").then((saved) => { if (saved) load(); });
      return;
    }
    const bk = e.target.closest("[data-bulk]");
    if (bk) { bulkAction(bk.dataset.bulk); return; }
    const mk = e.target.closest("[data-mkpo]");
    if (mk) { makePoFrom(mk.dataset.mkpo); return; }
    if (e.target.closest('[data-act="new-po"]')) { newPo(); return; }
    const rq = e.target.closest("[data-req]");
    if (rq) { handleReq(rq.dataset.id, rq.dataset.req); return; }
    if (e.target.closest('[data-act="req-settings"]')) { reqSettings(); return; }
    if (e.target.closest('[data-act="import-products"]')) { openProductImport({ products: st.products, suppliers: st.suppliers, staff, onDone: load }); return; }
    if (e.target.closest('[data-act="export-products"]')) { exportProductsCsv(st.products, st.suppliers); return; }
    if (e.target.closest('[data-act="new-product"]')) { editProduct(null); return; }
    if (e.target.closest('[data-act="new-supplier"]')) { editSupplier(null); return; }
    const pr = e.target.closest("[data-product]");
    if (pr) { openProduct(pr.dataset.product); return; }
    const ep = e.target.closest("[data-edit-product]");
    if (ep) { const p = st.products.find((x) => x.id === ep.dataset.editProduct); if (p) editProduct(p); return; }
    const es = e.target.closest("[data-edit-supplier]");
    if (es) { const s = st.suppliers.find((x) => x.id === es.dataset.editSupplier); if (s) editSupplier(s); }
  });
  body.addEventListener("input", (e) => {
    if (tab === "receive") return;
    const t = e.target;
    // Stock → Update digital count
    if (t.dataset.qc !== undefined) {
      const v = t.value.trim();
      if (v === "") st.qv.delete(t.dataset.qc); else st.qv.set(t.dataset.qc, v);
      const [pid, loc] = t.dataset.qc.split("|");
      const p = st.products.find((x) => x.id === pid);
      t.closest(".inv-qc").classList.toggle("is-set", !!p && v !== "" && Number(v) !== p.stock[loc]);
      syncQuickBar();
      return;
    }
    // Product tick boxes
    if (t.dataset.pick) {
      if (t.checked) st.sel.add(t.dataset.pick); else st.sel.delete(t.dataset.pick);
      syncPick();
      return;
    }
    if (t.dataset.pickcat !== undefined || t.dataset.pickall !== undefined) {
      const ids = productRows().filter((p) => t.dataset.pickall !== undefined || p.category === t.dataset.pickcat).map((p) => p.id);
      ids.forEach((id) => { if (t.checked) st.sel.add(id); else st.sel.delete(id); });
      syncPick();
      return;
    }
    if (t.dataset.linesup) { st.lineSup[t.dataset.linesup] = t.value; renderRequests(); return; }
    const k = t.dataset.f;
    if (!k) return;
    if (k === "reqFilter" || k === "reqView") { st[k] = t.value; renderRequests(); return; }
    if (k === "poFilter") { st.poFilter = t.value; renderOrders(); return; }
    if (k === "flagged" || k === "showInactive") st[k] = t.checked;
    else st[k] = t.value;
    if (["showInactive", "pq", "pcat", "psup", "pcount"].includes(k)) drawProductList(); else renderStockList();
  });

  body.addEventListener("keydown", (e) => {
    if (tab === "receive" || e.key !== "Enter" || e.target.dataset.qc === undefined) return;
    e.preventDefault();
    const all = [...body.querySelectorAll("[data-qc]")];
    const next = all[all.indexOf(e.target) + 1];
    if (next) { next.focus(); next.select(); }
    else { const save = body.querySelector('[data-act="quick-save"]'); if (save && !save.disabled) save.focus(); }
  });

  load();
}