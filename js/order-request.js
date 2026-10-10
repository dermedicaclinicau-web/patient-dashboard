// Task Manager → To Order (#/tasks/order[/<productId>|/low]): ask the ordering team for stock, and see your requests.
import {
  INV_CATEGORIES, LOCATIONS, REQ_STATUS, plural, unitPlural, reqNumber, myUid, lowAt, suggestOrder,
  listProducts, listRequests, createRequest, cancelRequest,
} from "./inventory-api.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
};
const day = (d) => (d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "");
const seg = (name, items, cur) => `<div class="fe-seg">${items.map(([v, l]) =>
  `<label class="fe-seg-btn"><input type="radio" name="${name}" value="${v}"${v === cur ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>`;

export async function mountOrderRequest(container, { param = "", staff = null } = {}) {
  const backHref = "#/tasks/new";
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);

  let products = [];
  let requests = [];
  try {
    [products, requests] = await Promise.all([listProducts(), listRequests({ max: 200 })]);
  } catch (err) {
    console.error("Order request load failed:", err);
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="state"><strong>Couldn't open order requests</strong>${
      err && err.code === "permission-denied"
        ? "You may not have access to request orders. Ask an Admin to check your Inventory access in Staff."
        : "Check your connection and try again."}</div>`;
    return;
  }
  if (!root.isConnected) return;

  const active = products.filter((p) => p.active);
  const byId = new Map(products.map((p) => [p.id, p]));
  const st = {
    loc: /\bteh\b/i.test(String((staff && staff.name) || "")) ? "jt" : "shelf",
    urgency: "normal", rows: [], busy: false,
  };
  const blankRow = () => ({ productId: "", name: "", isNew: false, qty: 1, unitKind: "order" });
  const lowRows = () => active.filter((p) => lowAt(p, st.loc))
    .map((p) => ({ productId: p.id, name: "", isNew: false, qty: suggestOrder(p, st.loc), unitKind: "order" }));

  if (param === "low") st.rows = lowRows();
  else if (byId.has(param)) {
    const p = byId.get(param);
    st.rows = [{ productId: p.id, name: "", isNew: false, qty: lowAt(p, st.loc) ? suggestOrder(p, st.loc) : 1, unitKind: "order" }];
  }
  if (!st.rows.length) st.rows = [blankRow()];

  root.innerHTML = `
    <div class="ff-wrap tb-wrap">
      <div class="ff-bar" role="region" aria-label="Order request">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${backHref}" aria-label="Back" title="Back">${I.back}</a>
          <div class="ff-bar-title"><strong>Request order</strong><span>To Order · goes to the ordering team</span></div>
          <div class="ff-bar-actions">
            <a class="ff-btn is-quiet" href="${backHref}">Cancel</a>
            <button type="button" class="ff-btn is-primary" data-act="send">${I.send}<span>Send request</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      <div class="tb-grid or-grid">
        <div class="tb-form">
          <section class="tb-card">
            <h4><span class="tb-num">1</span>What's needed</h4>
            <div class="or-rows" data-role="rows"></div>
            <div class="or-add">
              <button type="button" class="hx-add" data-act="add">+ Add another item</button>
              ${active.length ? '<button type="button" class="hx-add" data-act="low">+ Add everything that\'s low</button>' : ""}
            </div>
            ${active.length ? "" : '<p class="tb-none">No products have been set up yet. Choose “Something not on the list” and type what\'s needed.</p>'}
          </section>
          <section class="tb-card">
            <h4><span class="tb-num">2</span>Details</h4>
            <div class="tb-field"><span>For</span>${seg("or-loc", LOCATIONS.map((l) => [l.key, l.label]), st.loc)}</div>
            <div class="tb-field"><span>How urgent</span>${seg("or-urgency", [["normal", "Normal"], ["urgent", "Urgent"]], st.urgency)}</div>
            <label class="tb-field"><span>Note for the ordering team (optional)</span>
              <textarea class="fe-input" data-role="note" rows="2" maxlength="1000" placeholder="e.g. Needed for Thursday's clinic"></textarea></label>
          </section>
        </div>
        <aside class="tr-mail-col">
          <section class="tb-card"><h4>Your requests</h4><div data-role="mine"></div></section>
        </aside>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const rowsEl = $('[data-role="rows"]');
  const msgEl = $('[data-role="msg"]');
  const sendBtn = $('[data-act="send"]');

  const options = (sel) => INV_CATEGORIES.map((c) => {
    const items = active.filter((p) => p.category === c.key);
    return items.length ? `<optgroup label="${esc(c.label)}">${items.map((p) =>
      `<option value="${esc(p.id)}"${p.id === sel ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>` : "";
  }).join("");

  function rowHtml(r, i) {
    const p = byId.get(r.productId);
    const dup = p ? requests.find((q) => q.status === "open" && q.items.some((it) => it.productId === p.id)) : null;
    const units = p
      ? `<option value="order"${r.unitKind === "order" ? " selected" : ""}>${esc(p.packSize > 1 ? `${unitPlural(p.orderUnit)} (${p.packSize} each)` : unitPlural(p.orderUnit))}</option>${
          p.packSize > 1 ? `<option value="stock"${r.unitKind === "stock" ? " selected" : ""}>${esc(unitPlural(p.stockUnit))}</option>` : ""}`
      : '<option value="order">units</option>';
    return `
      <div class="or-row" data-i="${i}">
        <div class="or-line">
          <select class="fb-select or-product" data-r="product" aria-label="Product">
            <option value="">Choose a product…</option>${options(r.isNew ? "" : r.productId)}
            <option value="__new"${r.isNew ? " selected" : ""}>Something not on the list…</option>
          </select>
          <input class="fe-input or-qty" type="number" min="1" max="999" step="1" data-r="qty" value="${r.qty}" aria-label="Quantity" />
          <select class="fb-select or-unit" data-r="unit" aria-label="Unit">${units}</select>
          <button type="button" class="ib-tool is-danger" data-r="remove" aria-label="Remove" title="Remove">×</button>
        </div>
        ${r.isNew ? `<input class="fe-input" data-r="name" maxlength="150" placeholder="What's needed: name, brand and size" value="${esc(r.name)}" />` : ""}
        ${p ? `<small class="or-info">Now: Shelf ${p.stock.shelf} · JT ${p.stock.jt} ${esc(unitPlural(p.stockUnit))}${
          lowAt(p, "shelf") || lowAt(p, "jt") ? ' · <span class="inv-flag is-warn">Low</span>' : ""}${
          dup ? ` · <span class="or-dup">Already requested by ${esc(dup.requestedBy)} on ${esc(day(dup.createdAt))} (${esc(reqNumber(dup))}, still open)</span>` : ""}</small>` : ""}
      </div>`;
  }
  const renderRows = () => { rowsEl.innerHTML = st.rows.map(rowHtml).join(""); };

  function renderMine() {
    const mine = requests.filter((q) => q.requestedByUid === myUid()).slice(0, 15);
    $('[data-role="mine"]').innerHTML = mine.length ? `<ul class="or-mine">${mine.map((q) => `
      <li>
        <div class="or-mine-head"><strong>${esc(reqNumber(q))}</strong><span class="rq-status is-${q.status}">${esc(REQ_STATUS[q.status])}</span>
          <small>${esc(day(q.createdAt))}</small></div>
        <span>${esc(q.items.map((it) => `${it.name} × ${plural(it.qty, it.unit)}`).join(", "))}</span>
        ${q.response ? `<small class="muted">${esc(q.handledBy || "")}: ${esc(q.response)}</small>` : ""}
        ${q.status === "open" ? `<button type="button" class="hx-add" data-cancel="${esc(q.id)}">Cancel request</button>` : ""}
      </li>`).join("")}</ul>` : '<p class="tb-none">You haven\'t requested anything yet.</p>';
  }

  async function reload() {
    try { requests = await listRequests({ max: 200 }); } catch (err) { console.warn("Requests reload failed:", err); }
    if (root.isConnected) { renderRows(); renderMine(); }
  }

  /* ---------- Events ---------- */
  rowsEl.addEventListener("change", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const r = st.rows[Number(row.dataset.i)];
    if (e.target.dataset.r === "product") {
      const v = e.target.value;
      r.isNew = v === "__new";
      r.productId = r.isNew ? "" : v;
      r.unitKind = "order";
      const p = byId.get(r.productId);
      if (p && lowAt(p, st.loc)) r.qty = suggestOrder(p, st.loc);
      renderRows();
      if (r.isNew) { const n = rowsEl.querySelector(`[data-i="${row.dataset.i}"] [data-r="name"]`); if (n) n.focus(); }
    } else if (e.target.dataset.r === "unit") {
      r.unitKind = e.target.value === "stock" ? "stock" : "order";
    }
  });
  rowsEl.addEventListener("input", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const r = st.rows[Number(row.dataset.i)];
    if (e.target.dataset.r === "qty") r.qty = Math.min(999, Math.max(0, parseInt(e.target.value, 10) || 0));
    if (e.target.dataset.r === "name") r.name = e.target.value;
    msgEl.textContent = "";
  });
  rowsEl.addEventListener("click", (e) => {
    const rm = e.target.closest('[data-r="remove"]');
    if (!rm) return;
    st.rows.splice(Number(rm.closest("[data-i]").dataset.i), 1);
    if (!st.rows.length) st.rows.push(blankRow());
    renderRows();
  });

  root.addEventListener("change", (e) => {
    if (e.target.name === "or-loc") st.loc = e.target.value;
    if (e.target.name === "or-urgency") st.urgency = e.target.value;
  });

  root.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="add"]')) {
      st.rows.push(blankRow());
      renderRows();
      const sels = rowsEl.querySelectorAll('[data-r="product"]');
      if (sels.length) sels[sels.length - 1].focus();
      return;
    }
    if (e.target.closest('[data-act="low"]')) {
      const low = lowRows().filter((n) => !st.rows.some((r) => r.productId === n.productId));
      if (!low.length) { showToast(`Nothing else is low in ${st.loc === "jt" ? "JT storage" : "the Shelf"}.`); return; }
      st.rows = [...st.rows.filter((r) => r.productId || r.isNew), ...low];
      renderRows();
      showToast(`${low.length} low item${low.length === 1 ? "" : "s"} added with suggested amounts`);
      return;
    }
    const cx = e.target.closest("[data-cancel]");
    if (cx) {
      const ok = await confirmDialog({ title: "Cancel this request?", message: "The ordering team will see it as cancelled.", confirmLabel: "Cancel request", tone: "warning" });
      if (!ok) return;
      try { await cancelRequest(cx.dataset.cancel, staff); showToast("Request cancelled"); reload(); }
      catch (err) { console.error(err); showToast("Couldn't cancel. It may already have been ordered."); }
      return;
    }
    if (e.target.closest('[data-act="send"]')) send();
  });

  async function send() {
    if (st.busy) return;
    const items = [];
    for (const r of st.rows) {
      const p = byId.get(r.productId);
      if (!p && !(r.isNew && r.name.trim())) continue;
      if (!(r.qty >= 1)) { msgEl.textContent = "Enter a quantity of 1 or more for each item."; return; }
      items.push(p ? {
        productId: p.id, name: p.name, supplierId: p.supplierId, qty: r.qty, unitKind: r.unitKind,
        unit: r.unitKind === "stock" ? p.stockUnit : p.orderUnit,
        stockQty: r.unitKind === "stock" ? r.qty : r.qty * p.packSize,
      } : { productId: "", name: r.name.trim(), supplierId: "", qty: r.qty, unitKind: "order", unit: "unit", stockQty: r.qty });
    }
    if (!items.length) { msgEl.textContent = "Choose at least one product, or type something that isn't on the list."; return; }

    st.busy = true;
    sendBtn.disabled = true;
    sendBtn.querySelector("span").textContent = "Sending…";
    try {
      const id = await createRequest({ items, loc: st.loc, urgency: st.urgency, note: $('[data-role="note"]').value }, staff);
      callApi({ action: "inventory", op: "notifyRequest", requestId: id }).catch((err) => console.warn("Request email failed:", err));
      showToast("Request sent to the ordering team");
      st.rows = [blankRow()];
      $('[data-role="note"]').value = "";
      await reload();
    } catch (err) {
      console.error("Send request failed:", err);
      msgEl.textContent = err && err.code === "permission-denied"
        ? "You don't have access to request orders. Ask an Admin to check your Inventory access."
        : err && err.message && !err.code ? err.message : "Couldn't send. Try again.";
    } finally {
      st.busy = false;
      sendBtn.disabled = false;
      sendBtn.querySelector("span").textContent = "Send request";
    }
  }

  renderRows();
  renderMine();
}