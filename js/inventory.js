// Inventory (#/inventory/<tab>): stock on the Shelf and in JT storage, products, suppliers and the activity log.
import {
  INV_CATEGORIES, LOCATIONS, qtyText, packText, batchName, batchText, WRITEOFF_REASONS, ADD_REASONS, MOVE_TYPES, REQ_STATUS, PO_STATUS, catLabel, locLabel, plural, unitPlural,
  expiryState, fefo, reqNumber, myUid, suggestOrder, listProducts, saveProduct, listSuppliers, saveSupplier, listAllLots, listMoves,
  applyStock, listRequests, setRequestStatus, cancelRequest, getRequestSettings, saveRequestSettings,
  listPos, createPo, poTotals, itemOnPo, lineFromProduct, cleanPoLine,
} from "./inventory-api.js";
import { mountPurchaseOrder } from "./purchase-order.js";
import { fetchStaffList } from "./task-types.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";
import { mountReceivePo } from "./receive-po.js";
import { renderKits } from "./inventory-kits.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const TABS = [["stock", "Stock"], ["kits", "Kits"], ["requests", "Requests"], ["orders", "Purchase orders"], ["products", "Products"], ["suppliers", "Suppliers"], ["activity", "Activity"]];
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const when = (d) => (d ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const money = (n) => (n === null || n === undefined ? "" : `$${Number(n).toFixed(2)}`);
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to do this. Ask an Admin to check your Inventory access in Staff."
  : err && err.message && !err.code ? err.message : fallback);
const seg = (name, items, cur) => `<div class="fe-seg">${items.map(([v, l]) =>
  `<label class="fe-seg-btn"><input type="radio" name="${name}" value="${v}"${v === cur ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>`;
const lowAt = (p, loc) => p.reorder[loc] !== null && p.reorder[loc] !== undefined && p.stock[loc] <= p.reorder[loc];

function openDialog(cls, html) {
  const dlg = document.createElement("dialog");
  dlg.className = `lh-dialog ${cls}`;
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
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
  const parts = String(param || "").split("/");
  if (parts[0] === "po" && parts[1]) { mountPurchaseOrder(container, { id: parts[1], staff }); return; }
  if (parts[0] === "receive") {
    const page = document.createElement("section");
    page.className = "page wide";
    container.replaceChildren(page);
    mountReceivePo(page, parts[1] ? decodeURIComponent(parts[1]) : "", staff);
    return;
  }
  const first = String(param || "").split("/")[0];
  const tab = TABS.some(([k]) => k === first) ? first : "stock";
  const canManage = can("inventory.manage");
  const canMove = canManage || can("inventory.order");
  const canRequest = can("inventory.request");
  const canKit = can("inventory.kit");
  const canJt = can("inventory.jt");
  const showKits = canKit || canJt || canManage;

  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <div class="fb-head">
      <div><h2>Inventory</h2><p class="muted">Stock on the Shelf and in JT storage, products and suppliers.</p></div>
      ${canMove ? `<div class="fb-head-actions">
        <a class="btn-ghost inv-head-link" href="#/inventory/receive">Receive delivery</a>
        ${canManage ? `<button type="button" class="btn-ghost" data-act="new-supplier">+ New supplier</button>
        <button type="button" class="btn-primary" data-act="new-product">+ New product</button>` : ""}
      </div>` : ""}
    </div>
    <nav class="pt-tabs inv-tabs" aria-label="Inventory">${TABS.filter(([k]) => k !== "kits" || showKits).map(([k, l]) =>
      `<a href="#/inventory/${k}"${k === tab ? ' class="active" aria-current="page"' : ""}>${l}${
        k === "requests" ? ' <em class="inv-tabcount" data-role="reqcount" hidden></em>' : ""}</a>`).join("")}</nav>
    <div data-role="body"><div class="skeleton" style="height:320px;border-radius:14px"></div></div>`;
  container.replaceChildren(root);
  const body = root.querySelector('[data-role="body"]');

  const st = {
    products: [], suppliers: [], lots: [], requests: [], q: "", cat: "", view: "all", flagged: false, showInactive: false,
    reqFilter: "open", reqView: "list", pos: [], poFilter: "draft",
  };
  const supplierOf = (id) => st.suppliers.find((s) => s.id === id) || null;
  const lotsOf = (pid) => st.lots.filter((l) => l.productId === pid).sort(fefo);
  const labelOf = (pid) => batchName(st.products.find((p) => p.id === pid));
  function flags(p) {
    const out = [];
    if (lowAt(p, "shelf")) out.push(["warn", "Low on Shelf"]);
    if (lowAt(p, "jt")) out.push(["warn", "Low in JT storage"]);
    const ex = lotsOf(p.id).map((l) => expiryState(l.expiry));
    if (ex.includes("expired")) out.push(["bad", "Expired stock"]);
    else if (ex.includes("soon")) out.push(["warn", "Expires soon"]);
    return out;
  }

  async function load() {
    try {
      [st.products, st.suppliers, st.lots, st.requests, st.pos] = await Promise.all([
        listProducts(), listSuppliers(), listAllLots(), listRequests({ max: 300 }).catch(() => []), listPos().catch(() => []),
      ]);
      if (!root.isConnected) return;
      const open = st.requests.filter((r) => r.status === "open").length;
      const badge = root.querySelector('[data-role="reqcount"]');
      if (badge) { badge.textContent = open; badge.hidden = !open; }
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
    else if (tab === "kits") renderKits(body, { staff, products: st.products, lots: st.lots, canKit, canJt, canManage, reload: load });
    else if (tab === "requests") renderRequests();
    else if (tab === "orders") renderOrders();
    else if (tab === "products") renderProducts();
    else if (tab === "suppliers") renderSuppliers();
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
        ${canRequest ? '<a class="ff-btn" href="#/tasks/order/low">Request low stock</a>' : ""}
      </div>
      <div data-role="list"></div>`;
    renderStockList();
  }

  function stockRow(p) {
    const qty = (loc) => `<span class="inv-q${lowAt(p, loc) ? " is-low" : ""}"><small>${loc === "shelf" ? "Shelf" : "JT"}</small><b>${p.stock[loc]}</b></span>`;
    const sup = supplierOf(p.supplierId);
    return `
      <button type="button" class="inv-row" data-product="${esc(p.id)}">
        <span class="inv-name"><strong>${esc(p.name)}</strong>
          <small>${esc([p.brand, sup && sup.name, p.tracked ? "Batch & expiry" : ""].filter(Boolean).join(" · "))}</small></span>
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
      && (!q || `${p.name} ${p.brand} ${(supplierOf(p.supplierId) || {}).name || ""}`.toLowerCase().includes(q))
      && (!st.flagged || flags(p).length));
    if (!rows.length) { list.innerHTML = '<div class="tm-empty">No products match.</div>'; return; }
    list.innerHTML = INV_CATEGORIES.map((c) => {
      const items = rows.filter((p) => p.category === c.key);
      return items.length ? `<section class="inv-group"><h3>${esc(c.label)}<em>${items.length}</em></h3>
        <div class="inv-list">${items.map(stockRow).join("")}</div></section>` : "";
    }).join("");
  }

  /* ---------- Products ---------- */
  function renderProducts() {
    const rows = st.products.filter((p) => st.showInactive || p.active);
    const line = (p) => {
      const sup = supplierOf(p.supplierId);
      return `
        <div class="inv-prow${p.active ? "" : " is-off"}">
          <span class="inv-name"><strong>${esc(p.name)}${p.active ? "" : ' <em class="inv-off">Inactive</em>'}</strong>
            <small>${esc([packText(p), sup && sup.name, p.supplierCode && `Code ${p.supplierCode}`].filter(Boolean).join(" · "))}</small></span>
          <span class="inv-price">${esc([p.cost !== null && `Cost ${money(p.cost)} / ${p.orderUnit}`, p.price !== null && `Retail ${money(p.price)}`].filter(Boolean).join(" · "))}</span>
          ${p.tracked ? '<span class="inv-flag is-info">Batch &amp; expiry</span>' : '<span></span>'}
          ${canManage ? `<button type="button" class="lh-btn" data-edit-product="${esc(p.id)}">Edit</button>` : "<span></span>"}
        </div>`;
    };
    body.innerHTML = `
      <div class="inv-tools"><label class="fe-check"><input type="checkbox" data-f="showInactive"${st.showInactive ? " checked" : ""} /> Show inactive products</label></div>
      ${rows.length ? INV_CATEGORIES.map((c) => {
        const items = rows.filter((p) => p.category === c.key);
        return items.length ? `<section class="inv-group"><h3>${esc(c.label)}<em>${items.length}</em></h3>
          <div class="inv-plist">${items.map(line).join("")}</div></section>` : "";
      }).join("") : '<div class="tm-empty">No products yet.</div>'}`;
  }

  /* ---------- Suppliers ---------- */
  function renderSuppliers() {
    if (!st.suppliers.length) {
      body.innerHTML = `<div class="tm-empty"><strong>No suppliers yet.</strong>${canManage
        ? '<div class="tm-empty-act"><button type="button" class="ff-btn is-primary" data-act="new-supplier">+ New supplier</button></div>' : ""}</div>`;
      return;
    }
    body.innerHTML = `<div class="inv-sups">${st.suppliers.map((s) => {
      const n = st.products.filter((p) => p.supplierId === s.id && p.active).length;
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
          <label class="lh-field"><span class="lh-label">Supplier</span><select class="fb-select" name="supplierId">
            <option value="">No supplier yet</option>${st.suppliers.map((s) =>
              `<option value="${esc(s.id)}"${x.supplierId === s.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
          <label class="lh-field"><span class="lh-label">Supplier's product code (optional)</span><input name="supplierCode" maxlength="60" value="${val(x.supplierCode)}" /></label>

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
              <option value="storage"${x.usage !== "kit" ? " selected" : ""}>From the Shelf, one per patient (e.g. Belotero, needles)</option>
              <option value="kit"${x.usage === "kit" ? " selected" : ""}>Carried in injectors' kits, shared across patients (e.g. Xeomin)</option>
            </select>
            <small class="fe-note">One per patient: the dose given is recorded and any leftover is logged as discarded. Kits: the clinician takes the vial into their own kit and uses it across patients until it's empty.</small></label>

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
      </form>`);
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
      dlg.querySelector('[data-role="packlbl"]').textContent = `How many ${unitPlural(unit)} in each ${ou}`;
      dlg.querySelector('[data-role="doselbl"]').textContent = `Amount in each ${unit} (injectables)`;
      dlg.querySelector('[data-role="costlbl"]').textContent = `Cost per ${ou}, $ (optional)`;
      const each = dp > 0 ? ` (${+dp.toFixed(2)} ${du})` : "";
      dlg.querySelector('[data-role="pack"]').textContent =
        `Staff take 1 ${unit}${each} off the Shelf${kit ? " into their own kit, and use it across patients until it's empty" : ""}. ` +
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
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());

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
          stockUnit: f.stockUnit.value,
          orderUnit: f.orderUnit.value.trim() || f.stockUnit.value,
          packSize: f.packSize.value, cost: f.cost.value, price: f.price.value, barcode: f.barcode.value,
          dosePer: f.dosePer.value, doseUnit: f.doseUnit.value,
          usage: f.usage.value,
          batchLabel: f.batchLabel.value,
          countFreq: f.countFreq.value, countDay: f.countDay.value, countWhere: f.countWhere.value,
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

  /* ---------- A product's stock window ---------- */
  function openProduct(id) {
    const dlg = openDialog("inv-dlg inv-pdlg", '<div class="lh-form" data-role="pd"></div>');
    const box = dlg.querySelector('[data-role="pd"]');

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
          <div class="inv-pd-loc${lowAt(p, l.key) ? " is-low" : ""}"><span>${esc(l.label)}</span>
            <strong>${esc(qtyText(p, p.stock[l.key]))}</strong>
            ${p.reorder[l.key] !== null ? `<small>${lowAt(p, l.key) ? "Low · " : ""}reorder at ${p.reorder[l.key]}</small>` : ""}</div>`).join("")}</div>
        ${canMove || canRequest ? `<div class="inv-pd-acts">
          ${canManage ? '<button type="button" class="lh-btn is-primary" data-stock="add">Add stock</button>' : ""}
          ${canMove ? '<button type="button" class="lh-btn" data-stock="move">Move Shelf ⇄ JT</button>' : ""}
          ${canRequest ? '<button type="button" class="lh-btn" data-act="request">Request more</button>' : ""}
          ${canManage ? `<button type="button" class="lh-btn" data-stock="count">Count</button>
            <button type="button" class="lh-btn" data-stock="writeoff">Write off</button>
            <button type="button" class="lh-btn is-quiet" data-act="edit">Edit product</button>` : ""}
        </div>` : ""}
        ${p.tracked ? `<div class="inv-pd-sec"><h4>Stock by ${esc(batchName(p).toLowerCase())} <small>(oldest expiry first)</small></h4>${lots.length
          ? `<table class="inv-table"><thead><tr><th>Storage</th><th>${esc(batchName(p))}</th><th>Expiry</th><th>Qty</th></tr></thead><tbody>${lots.map((l) => {
           const ex = expiryState(l.expiry);
              return `<tr><td>${esc(locLabel(l.loc))}</td><td>${esc(l.batch)}</td>
                <td>${esc(niceDate(l.expiry))}${ex ? ` <span class="inv-flag is-${ex === "expired" ? "bad" : "warn"}">${ex === "expired" ? "Expired" : "Soon"}</span>` : ""}</td>
                <td>${esc(qtyText(p, l.qty))}</td></tr>`;
            }).join("")}</tbody></table>`
          : '<p class="tb-none">No batches in stock.</p>'}</div>` : ""}
        ${sup ? `<div class="inv-pd-sec"><h4>Supplier</h4><p class="inv-pd-sup"><strong>${esc(sup.name)}</strong>${
          [sup.contactName, sup.phone && `<a href="tel:${esc(sup.phone.replace(/\s+/g, ""))}">${esc(sup.phone)}</a>`,
            sup.email && `<a href="mailto:${esc(sup.email)}">${esc(sup.email)}</a>`, p.supplierCode && `Code ${esc(p.supplierCode)}`]
            .filter(Boolean).map((x) => ` · ${x.startsWith("<") ? x : esc(x)}`).join("")}</p></div>` : ""}
        <div class="inv-pd-sec"><h4>Recent activity</h4><div data-role="moves"><p class="tb-none">Loading…</p></div></div>`;
      listMoves({ productId: id, max: 15 })
        .then((m) => { const el = box.querySelector('[data-role="moves"]'); if (el) el.innerHTML = movesHtml(m, false, labelOf); })
        .catch(() => { const el = box.querySelector('[data-role="moves"]'); if (el) el.innerHTML = '<p class="tb-none tb-bad">Couldn\'t load the activity.</p>'; });
    }

    box.addEventListener("click", async (e) => {
      if (e.target.closest('[data-act="close"]')) { dlg.close(); return; }
      const p = st.products.find((x) => x.id === id);
      if (!p) return;
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
        ${segF("rq-f", [["open", `Open (${counts.open})`], ["ordered", `Ordered (${counts.ordered})`], ["received", `Received (${counts.received})`], ["closed", "Declined & cancelled"], ["all", "All"]], st.reqFilter, "reqFilter")}
        ${st.reqFilter === "open" ? segF("rq-v", [["list", "List"], ["supplier", "By supplier"]], st.reqView, "reqView") : ""}
        <span class="inv-spacer"></span>
        ${canManage ? '<button type="button" class="ff-btn" data-act="req-settings">Email settings</button>' : ""}
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

    // Open items that aren't on a purchase order yet, added up per supplier (in the supplier's order units)
  function openItemsBySupplier(rows) {
    const groups = new Map();
    rows.forEach((r) => r.items.forEach((it, i) => {
      if (itemOnPo(r.id, i, st.pos)) return;
      const p = st.products.find((x) => x.id === it.productId) || null;
      const sid = (p && p.supplierId) || it.supplierId || "";
      if (!groups.has(sid)) groups.set(sid, new Map());
      const lines = groups.get(sid);
      const key = `${it.productId || it.name.toLowerCase()}|${r.loc}`;
      const line = lines.get(key) || { p, name: it.name, unit: p ? p.orderUnit : it.unit, qty: 0, loc: r.loc, reqs: [], urgent: false, sources: [] };
      line.qty += p && it.unitKind === "stock" ? Math.ceil(it.qty / Math.max(1, p.packSize)) : it.qty;
      line.reqs.push(reqNumber(r));
      line.urgent = line.urgent || r.urgency === "urgent";
      line.sources.push({ r: r.id, i });
      lines.set(key, line);
    }));
    return groups;
  }

  function bySupplierHtml(rows) {
    const groups = openItemsBySupplier(rows);
    if (!groups.size) return '<div class="tm-empty">Everything requested is already on a purchase order.</div>';
    const order = [...groups.keys()].sort((a, b) => !a ? 1 : !b ? -1
      : ((supplierOf(a) || {}).name || "").localeCompare((supplierOf(b) || {}).name || "", "en-AU"));
    return order.map((sid) => {
      const s = supplierOf(sid);
      const lines = [...groups.get(sid).values()];
      return `
        <section class="rq-sup">
          <div class="rq-sup-top">
            <div class="rq-sup-head"><strong>${esc(s ? s.name : "No supplier set")}</strong>
              <small>${esc(s ? [s.contactName, s.email, s.phone].filter(Boolean).join(" · ") : "New items, or products without a supplier")}</small></div>
            ${canMove ? `<button type="button" class="lh-btn is-primary" data-mkpo="${esc(sid)}">${sid ? "Create purchase order" : "Create purchase order…"}</button>` : ""}
          </div>
          <table class="inv-table"><thead><tr><th>Product</th><th>Quantity</th><th>For</th><th>Requests</th></tr></thead><tbody>${lines.map((l) => `
            <tr><td>${esc(l.name)}${l.urgent ? ' <span class="inv-flag is-bad">Urgent</span>' : ""}</td><td>${esc(plural(l.qty, l.unit))}</td>
              <td>${esc(locLabel(l.loc))}</td><td>${esc([...new Set(l.reqs)].join(", "))}</td></tr>`).join("")}</tbody></table>
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
        ${segF("po-f", [["draft", `Drafts (${n("draft")})`], ["sent", `Sent (${n("sent")})`], ["part", `Part received (${n("part")})`],
          ["received", "Received"], ["cancelled", "Cancelled"], ["all", "All"]], f, "poFilter")}
        <span class="inv-spacer"></span>
        ${canMove ? '<button type="button" class="btn-primary" data-act="new-po">+ New purchase order</button>' : ""}
      </div>
      ${rows.length ? `<div class="po-list">${rows.map((po) => {
        const t = poTotals(po);
        const bits = [`${po.lines.length} item${po.lines.length === 1 ? "" : "s"}`,
          po.requestIds.length && `${po.requestIds.length} request${po.requestIds.length === 1 ? "" : "s"}`,
          po.sentAt ? `Sent ${when(po.sentAt)}` : `Created ${when(po.createdAt)}`, po.createdBy && `by ${po.createdBy}`].filter(Boolean);
        return `<a class="po-row" href="#/inventory/po/${encodeURIComponent(po.id)}">
          <span class="inv-name"><strong>${esc(po.number)} · ${esc(po.supplier.name)}</strong><small>${esc(bits.join(" · "))}</small></span>
          <span class="rq-status is-${po.status}">${esc(PO_STATUS[po.status])}</span>
          <strong class="po-amt">${esc(money(t.total))}</strong></a>`;
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
    const lines = [...g.values()].map((l) => (l.p
      ? lineFromProduct(l.p, l.qty, l.loc, l.sources)
      : cleanPoLine({ name: l.name, qty: l.qty, orderUnit: l.unit, loc: l.loc, sources: l.sources })));
    startPo(supplierId, lines);
  }

  async function newPo() {
    const pick = await pickSupplier({ title: "New purchase order", withLow: true });
    if (!pick) return;
    const lines = [];
    if (pick.low) {
      st.products.filter((p) => p.active && p.supplierId === pick.id).forEach((p) => LOCATIONS.forEach((l) => {
        if (lowAt(p, l.key)) lines.push(lineFromProduct(p, suggestOrder(p, l.key), l.key));
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
    const mk = e.target.closest("[data-mkpo]");
    if (mk) { makePoFrom(mk.dataset.mkpo); return; }
    if (e.target.closest('[data-act="new-po"]')) { newPo(); return; }
    const rq = e.target.closest("[data-req]");
    if (rq) { handleReq(rq.dataset.id, rq.dataset.req); return; }
    if (e.target.closest('[data-act="req-settings"]')) { reqSettings(); return; }
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
    const k = e.target.dataset.f;
    if (!k) return;
    if (k === "reqFilter" || k === "reqView") { st[k] = e.target.value; renderRequests(); return; }
    if (k === "poFilter") { st.poFilter = e.target.value; renderOrders(); return; }
    if (k === "flagged" || k === "showInactive") st[k] = e.target.checked;
    else st[k] = e.target.value;
    if (k === "showInactive") renderProducts(); else renderStockList();
  });

  load();
}