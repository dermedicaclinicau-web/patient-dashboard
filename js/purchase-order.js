// One purchase order (#/inventory/po/<id>): items, totals, the PDF, and sending it to the supplier.
import {
  PO_STATUS, REQ_STATUS, LOCATIONS, locLabel, plural, unitPlural, lowAt, suggestOrder, reqNumber,
  getPo, savePo, markPoSent, cancelPo, poTotals, lineFromProduct, cleanPoLine, supplierSnapshot,
  listProducts, listSuppliers, listRequests,
} from "./inventory-api.js";
import { buildPoDocument } from "./po-document.js";
import { docToPdf, deliveryError } from "./form-delivery.js";
import { getLetterhead } from "./form-templates.js";
import { DEFAULT_LETTERHEAD } from "./form-letterhead.js";
import { createRichEditor } from "./rich-editor.js";
import { richText } from "./rich-html.js";
import { emailShell, clinicDetails } from "./task-tokens.js";
import { callApi } from "./appointments.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  check: ic('<polyline points="20 6 9 17 4 12"/>'),
};
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const when = (d) => (d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SENT_VIA = ["Phone", "Supplier's website", "Email from another account", "In person", "Other"];

function openDialog(cls, html) {
  const dlg = document.createElement("dialog");
  dlg.className = `lh-dialog ${cls}`;
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

export async function mountPurchaseOrder(container, { id, staff } = {}) {
  const backHref = "#/inventory/orders";
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `<a class="back-link" href="${backHref}">← Purchase orders</a><div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);
  const fail = (title, msg) => {
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${backHref}">← Purchase orders</a><div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };

  let po, products, suppliers, letterhead;
  try {
    [po, products, suppliers, letterhead] = await Promise.all([
      getPo(id), listProducts(), listSuppliers(), getLetterhead().catch(() => DEFAULT_LETTERHEAD),
    ]);
  } catch (err) {
    console.error("PO load failed:", err);
    fail("Couldn't open this purchase order", err && err.code === "permission-denied"
      ? "Check your Inventory access, and that the purchase order rules have been published." : "Check your connection and try again.");
    return;
  }
  if (!root.isConnected) return;
  if (!po) { fail("Purchase order not found", "It may have been opened from an old link."); return; }

  const canOrder = can("inventory.order") || can("inventory.manage");
  const byId = new Map(products.map((p) => [p.id, p]));
  let dirty = false, saving = false, timer = null, reqs = null;
  const editable = () => canOrder && po.status === "draft";
  const supplierFull = () => suppliers.find((s) => s.id === po.supplierId) || null;

  root.innerHTML = `
    <div class="ff-wrap tb-wrap">
      <div class="ff-bar" role="region" aria-label="Purchase order">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${backHref}" aria-label="Back" title="Back">${I.back}</a>
          <div class="ff-bar-title"><strong data-role="title"></strong><span data-role="sub"></span></div>
          <span class="rq-status" data-role="pill"></span>
          <div class="ff-bar-actions" data-role="acts"></div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      <div class="tb-grid po-grid">
        <div class="tb-form" data-role="left"></div>
        <aside class="tr-mail-col po-side" data-role="right"></aside>
      </div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const left = $('[data-role="left"]');
  const right = $('[data-role="right"]');
  const msgEl = $('[data-role="msg"]');

  /* ---------- Saving ---------- */
  const setState = (t) => { const el = root.querySelector('[data-role="state"]'); if (el) el.textContent = t; };
  function changed() {
    dirty = true;
    msgEl.textContent = "";
    setState("Unsaved changes");
    clearTimeout(timer);
    timer = setTimeout(flush, 800);
  }
  async function flush() {
    clearTimeout(timer);
    if (!dirty || saving || !editable()) return;
    saving = true;
    dirty = false;
    setState("Saving…");
    let failed = false;
    try {
      await savePo(id, po, staff);
      setState(dirty ? "Unsaved changes" : "All changes saved");
    } catch (err) {
      console.error("PO save failed:", err);
      failed = true;
      dirty = true;
      setState("Couldn't save. Retrying…");
    } finally {
      saving = false;
      if (dirty) timer = setTimeout(flush, failed ? 4000 : 500);
    }
  }
  async function settle() {
    clearTimeout(timer);
    if (dirty) await flush();
    while (saving) await wait(100);
  }
  const onBeforeUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ""; } };
  const onHashChange = () => {
    if (root.isConnected) return;
    flush();
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("hashchange", onHashChange);

  /* ---------- Top bar ---------- */
  function renderBar() {
    $('[data-role="title"]').textContent = po.number;
    $('[data-role="sub"]').innerHTML = `${esc(po.supplier.name || "No supplier")} · ${editable()
      ? `<span data-role="state">${dirty ? "Unsaved changes" : "All changes saved"}</span>`
      : esc(po.sentAt ? `Sent ${when(po.sentAt)}${po.sentVia ? ` (${po.sentVia})` : ""}` : PO_STATUS[po.status])}`;
    const pill = $('[data-role="pill"]');
    pill.className = `rq-status is-${po.status}`;
    pill.textContent = PO_STATUS[po.status];
    const nothingIn = po.lines.every((l) => !l.received);
    const acts = [`<button type="button" class="ff-btn" data-act="preview">${I.doc}<span>Preview PDF</span></button>`];
    if (canOrder && po.status === "draft") {
      acts.unshift('<button type="button" class="ff-btn is-quiet" data-act="cancel">Cancel PO</button>');
      acts.push(`<button type="button" class="ff-btn" data-act="mark-sent">${I.check}<span>Mark as sent</span></button>`);
      acts.push(`<button type="button" class="ff-btn is-primary" data-act="send">${I.send}<span>Send to supplier</span></button>`);
    } else if (canOrder && (po.status === "sent" || po.status === "part")) {
      if (po.status === "sent" && nothingIn) acts.unshift('<button type="button" class="ff-btn is-quiet" data-act="cancel">Cancel PO</button>');
      acts.push(`<button type="button" class="ff-btn" data-act="resend">${I.send}<span>Email again</span></button>`);
      acts.push(`<a class="ff-btn is-primary" href="#/inventory/receive/${encodeURIComponent(po.id)}">${I.check}<span>Receive stock</span></a>`);
    }
    $('[data-role="acts"]').innerHTML = acts.join("");
  }

  /* ---------- Left: supplier, items, details ---------- */
  function supplierCard() {
    const s = supplierFull() || po.supplier;
    const info = [s.contactName, s.email, s.phone].filter(Boolean).map(esc).join(" · ");
    return `
      <section class="tb-card">
        <h4><span class="tb-num">1</span>Supplier</h4>
        ${editable()
          ? `<select class="fb-select" data-k="supplierId" aria-label="Supplier">${suppliers.filter((x) => x.active || x.id === po.supplierId).map((x) =>
              `<option value="${esc(x.id)}"${x.id === po.supplierId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`
          : `<strong>${esc(po.supplier.name)}</strong>`}
        ${info ? `<small class="muted">${info}</small>` : ""}
        ${!s.email ? '<p class="tb-info">This supplier has no order email. Add one in Inventory → Suppliers, or order another way and use Mark as sent.</p>' : ""}
        ${s.orderNotes ? `<p class="tb-info">${esc(s.orderNotes)}</p>` : ""}
      </section>`;
  }

  function productOptions(sel) {
    const mine = products.filter((p) => p.active && p.supplierId === po.supplierId);
    const others = products.filter((p) => p.active && p.supplierId !== po.supplierId);
    const current = sel ? byId.get(sel) : null;
    const opt = (p) => `<option value="${esc(p.id)}"${p.id === sel ? " selected" : ""}>${esc(p.name)}</option>`;
    return `<option value="">Choose a product…</option>${
      current && !current.active ? `<optgroup label="Inactive">${opt(current)}</optgroup>` : ""}${
      mine.length ? `<optgroup label="This supplier">${mine.map(opt).join("")}</optgroup>` : ""}${
      others.length ? `<optgroup label="Other products">${others.map(opt).join("")}</optgroup>` : ""}`;
  }

  function lineRow(l, i) {
    const total = l.unitCost === null ? "—" : money(l.unitCost * l.qty);
    if (!editable()) {
      return `<tr><td><strong>${esc(l.name)}</strong>${l.supplierCode ? ` <small class="po-code">${esc(l.supplierCode)}</small>` : ""}</td>
        <td>${esc(plural(l.qty, l.orderUnit))}</td><td>${l.unitCost === null ? "—" : money(l.unitCost)}</td><td>${esc(locLabel(l.loc))}</td>
        <td class="r">${total}</td>${po.status !== "draft" ? `<td>${l.received} of ${l.qty}</td>` : ""}</tr>`;
    }
    const named = !l.productId && (l.custom || l.name);
    return `
      <tr data-i="${i}">
        <td>${named
          ? `<input class="fe-input" data-l="name" maxlength="150" placeholder="Item name, brand and size" value="${esc(l.name)}" aria-label="Item" />`
          : `<select class="fb-select" data-l="product" aria-label="Product">${productOptions(l.productId)}</select>`}
          ${l.sources.length ? `<small class="po-src">From ${l.sources.length} request item${l.sources.length === 1 ? "" : "s"}</small>` : ""}</td>
        <td><div class="po-qty"><input class="fe-input" type="number" min="1" max="9999" step="1" data-l="qty" value="${l.qty}" aria-label="Quantity" />
          <small>${esc(unitPlural(l.orderUnit))}</small></div></td>
        <td><input class="fe-input po-cost" type="number" min="0" step="0.01" data-l="cost" placeholder="—" value="${l.unitCost ?? ""}" aria-label="Unit price" /></td>
        <td><select class="fb-select" data-l="loc" aria-label="For">${LOCATIONS.map((x) =>
          `<option value="${x.key}"${x.key === l.loc ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select></td>
        <td class="r" data-role="lt">${total}</td>
        <td><button type="button" class="ib-tool is-danger" data-l="remove" aria-label="Remove" title="Remove">×</button></td>
      </tr>`;
  }

  function itemsCard() {
    const ed = editable();
    return `
      <section class="tb-card">
        <h4><span class="tb-num">2</span>Items</h4>
        ${po.lines.length ? `<div class="po-table-wrap"><table class="inv-table po-table"><thead><tr>
            <th>Item</th><th>Qty</th><th>Unit price</th><th>For</th><th class="r">Total</th>${ed ? "<th></th>" : po.status !== "draft" ? "<th>Received</th>" : ""}
          </tr></thead><tbody>${po.lines.map(lineRow).join("")}</tbody></table></div>`
          : '<p class="tb-none">No items yet.</p>'}
        ${ed ? `<div class="or-add">
          <button type="button" class="hx-add" data-act="add-line">+ Add a product</button>
          <button type="button" class="hx-add" data-act="add-custom">+ Add an item not on the list</button>
          <button type="button" class="hx-add" data-act="add-low">+ Add low stock from this supplier</button>
        </div>` : ""}
        <small class="muted">“For” is where it goes when it arrives. It isn't shown to the supplier.</small>
      </section>`;
  }

  function detailsCard() {
    if (!editable()) {
      return `<section class="tb-card"><h4><span class="tb-num">3</span>Details</h4>
        <dl class="po-dl">
          <dt>Needed by</dt><dd>${esc(niceDate(po.expectedDate) || "Not set")}</dd>
          <dt>Notes to the supplier</dt><dd>${po.notesToSupplier ? esc(po.notesToSupplier).replace(/\n/g, "<br>") : "None"}</dd>
          <dt>Internal note</dt><dd>${po.internalNote ? esc(po.internalNote) : "None"}</dd>
          ${po.sentTo ? `<dt>Emailed to</dt><dd>${esc(po.sentTo)}</dd>` : ""}
          ${po.status === "cancelled" ? `<dt>Cancelled</dt><dd>${esc(po.cancelReason || "")}</dd>` : ""}
        </dl></section>`;
    }
    return `
      <section class="tb-card">
        <h4><span class="tb-num">3</span>Details</h4>
        <div class="tb-two">
          <label class="tb-field"><span>Needed by (optional)</span><input class="fe-input" type="date" data-k="expectedDate" value="${esc(po.expectedDate)}" /></label>
          <label class="fe-check po-gst"><input type="checkbox" data-k="gst"${po.gst ? " checked" : ""} /> Add 10% GST to the total</label>
        </div>
        <label class="tb-field"><span>Notes to the supplier (on the PDF)</span>
          <textarea class="fe-input" data-k="notesToSupplier" rows="3" maxlength="2000" placeholder="e.g. Please deliver before 2pm.">${esc(po.notesToSupplier)}</textarea></label>
        <label class="tb-field"><span>Internal note (not on the PDF)</span>
          <textarea class="fe-input" data-k="internalNote" rows="2" maxlength="1000">${esc(po.internalNote)}</textarea></label>
      </section>`;
  }

  const renderLeft = () => { left.innerHTML = supplierCard() + itemsCard() + detailsCard(); };

  /* ---------- Right: totals, requests, history ---------- */
  function reqsHtml() {
    if (!po.requestIds.length) return '<p class="tb-none">None. The items were added by hand.</p>';
    if (reqs === null) return '<p class="tb-none">Loading…</p>';
    const list = reqs.filter((r) => po.requestIds.includes(r.id));
    return list.length ? `<ul class="po-reqs">${list.map((r) => `<li><strong>${esc(reqNumber(r))}</strong> ${esc(r.requestedBy || "")}
      <span class="rq-status is-${r.status}">${esc(REQ_STATUS[r.status])}</span></li>`).join("")}</ul>`
      : '<p class="tb-none">The linked requests could not be found.</p>';
  }
  function renderRight() {
    const t = poTotals(po);
    right.innerHTML = `
      <section class="tb-card">
        <h4>Total</h4>
        <div class="po-sum"><span>Subtotal</span><strong>${money(t.subtotal)}</strong></div>
        ${po.gst ? `<div class="po-sum"><span>GST (10%)</span><strong>${money(t.gst)}</strong></div>` : ""}
        <div class="po-sum is-total"><span>Total${po.gst ? " inc. GST" : ""}</span><strong>${money(t.total)}</strong></div>
        ${t.missing ? '<small class="muted">Some items have no unit price. The PDF says prices are to be confirmed.</small>' : ""}
      </section>
      <section class="tb-card"><h4>Requests on this order</h4>${reqsHtml()}</section>
      <section class="tb-card"><h4>History</h4>${po.events.length
        ? `<ul class="po-events">${po.events.slice().reverse().map((e) => `<li><strong>${esc(e.action)}</strong>${e.note ? ` · ${esc(e.note)}` : ""}
            <small>${esc(e.by || "")} · ${esc(when(new Date(e.at)))}</small></li>`).join("")}</ul>`
        : '<p class="tb-none">Nothing yet.</p>'}</section>`;
  }

  const renderAll = () => { renderBar(); renderLeft(); renderRight(); };
  async function reload() {
    try { po = await getPo(id); } catch (err) { console.error(err); }
    if (root.isConnected && po) renderAll();
  }

  /* ---------- Editing ---------- */
  left.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.k === "supplierId") {
      const s = suppliers.find((x) => x.id === el.value);
      if (s) { po.supplierId = s.id; po.supplier = supplierSnapshot(s); renderAll(); changed(); }
      return;
    }
    const row = el.closest("[data-i]");
    if (!row) return;
    const l = po.lines[Number(row.dataset.i)];
    if (el.dataset.l === "product") {
      const p = byId.get(el.value);
      if (!p) return;
      Object.assign(l, { productId: p.id, name: p.name, supplierCode: p.supplierCode, orderUnit: p.orderUnit,
        packSize: p.packSize, stockUnit: p.stockUnit, dosePer: p.dosePer, doseUnit: p.doseUnit, unitCost: p.cost });
      renderLeft(); renderRight(); changed();
    } else if (el.dataset.l === "loc") {
      l.loc = el.value;
      changed();
    }
  });
  left.addEventListener("input", (e) => {
    const el = e.target;
    const k = el.dataset.k;
    if (k && k !== "supplierId") {
      po[k] = el.type === "checkbox" ? el.checked : el.value;
      if (k === "gst") renderRight();
      changed();
      return;
    }
    const row = el.closest("[data-i]");
    if (!row) return;
    const l = po.lines[Number(row.dataset.i)];
    if (el.dataset.l === "qty") l.qty = Math.min(9999, Math.max(1, parseInt(el.value, 10) || 1));
    else if (el.dataset.l === "cost") l.unitCost = el.value === "" ? null : Math.max(0, Math.round((Number(el.value) || 0) * 100) / 100);
    else if (el.dataset.l === "name") l.name = el.value;
    else return;
    const lt = row.querySelector('[data-role="lt"]');
    if (lt) lt.textContent = l.unitCost === null ? "—" : money(l.unitCost * l.qty);
    renderRight();
    changed();
  });

  /* ---------- PDF, sending, cancelling ---------- */
  function problems() {
    if (!po.supplierId) return "Choose a supplier.";
    if (po.lines.some((l) => !l.productId && !String(l.name || "").trim())) return "Choose a product for every row, or remove the empty row.";
    if (!po.lines.length) return "Add at least one item.";
    return "";
  }
  const makeDoc = () => buildPoDocument({ po, letterhead });

  async function preview() {
    await settle();
    const w = window.open("", "_blank");
    if (w) w.document.write('<p style="font-family:Arial,sans-serif;padding:2rem;color:#475569">Preparing the PDF…</p>');
    const d = makeDoc();
    try {
      const { blob } = await docToPdf(d);
      const url = URL.createObjectURL(blob);
      if (w) w.location.href = url; else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (err) {
      console.warn("PDF preview failed:", err);
      if (w) { w.document.open(); w.document.write(d.previewHtml); w.document.close(); }
    }
  }

  async function sendDialog(again) {
    const p = problems();
    if (p) { msgEl.textContent = p; return; }
    await settle();
    const s = supplierFull() || po.supplier;
    const d = makeDoc();
    let job = docToPdf(d);
    job.catch(() => {});
    const first = String(s.contactName || "").split(" ")[0];
    const message = `<p>Hi ${esc(first || "there")},</p>` +
      `<p>Please find attached our purchase order <strong>${esc(po.number)}</strong>${s.accountNo ? ` (account ${esc(s.accountNo)})` : ""}.</p>` +
      (po.expectedDate ? `<p>We'd appreciate delivery by ${esc(niceDate(po.expectedDate))}.</p>` : "") +
      "<p>Please reply to confirm the order and the expected delivery date.</p>" +
      `<p>Kind regards,<br>${esc((staff && staff.name) || "The team")}<br>Dermedica</p>`;
    const dlg = openDialog("ec-dialog ac-mail", `
      <form class="lh-form ec-form" novalidate>
        <div class="lh-dialog-head"><h3>${again ? "Email the purchase order again" : "Send to supplier"}</h3>
          <p>Sent from the clinic's email with the purchase order attached as a PDF.</p></div>
        <div class="ac-ed-two">
          <label class="lh-field"><span class="lh-label">To</span><input type="email" name="to" maxlength="254" value="${esc(s.email || "")}" /></label>
          <label class="lh-field"><span class="lh-label">CC (optional)</span><input type="email" name="cc" maxlength="254" value="${esc(s.ccEmail || "")}" /></label>
        </div>
        <label class="lh-field"><span class="lh-label">Subject</span><input name="subject" maxlength="200" value="${esc(`Purchase order ${po.number} - Dermedica`)}" /></label>
        <div class="lh-field"><span class="lh-label">Message</span><div class="tr-canvas" style="background-color:#f1f5f9"><div data-role="editor"></div></div></div>
        <div class="ec-attach">${I.doc}<span>${esc(d.fileName)}</span></div>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${again ? "Send again" : "Send purchase order"}</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const editor = createRichEditor(dlg.querySelector('[data-role="editor"]'), { accent: () => "#0f766e" });
    editor.setHtml(message);
    let busy = false;
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const to = form.elements.to.value.trim();
      const cc = form.elements.cc.value.trim();
      const show = (m) => { err.textContent = m; err.hidden = false; };
      if (!EMAIL_RE.test(to)) { show("Enter the supplier's email address."); return; }
      if (cc && !EMAIL_RE.test(cc)) { show("Check the CC email address."); return; }
      if (!richText(editor.getHtml())) { show("Add a short message."); return; }
      busy = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Preparing PDF…";
      err.hidden = true;
      try {
        let pdf;
        try { pdf = (await job).pdf; } catch { job = docToPdf(d); pdf = (await job).pdf; }
        btn.textContent = "Sending…";
        await callApi({
          action: "inventory", op: "sendPo", poId: id, to, cc,
          subject: form.elements.subject.value.trim() || `Purchase order ${po.number}`,
          html: emailShell(editor.getHtml(), {}, { clinic: clinicDetails(letterhead), hasLogo: !!(letterhead && letterhead.logo) }),
          pdf, fileName: d.fileName,
        });
        busy = false;
        dlg.close();
        showToast(`${po.number} emailed to ${to}`);
        reload();
      } catch (ex) {
        console.error("Send PO failed:", ex);
        busy = false;
        show(ex && ex.code === "FORBIDDEN" ? "Only the ordering team can send purchase orders." : deliveryError(ex));
        btn.disabled = false;
        btn.textContent = again ? "Send again" : "Send purchase order";
      }
    });
  }

  async function markSentDialog() {
    const p = problems();
    if (p) { msgEl.textContent = p; return; }
    await settle();
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Mark ${esc(po.number)} as sent</h3>
          <p>For orders placed another way. The requests it covers are marked as ordered.</p></div>
        <label class="lh-field"><span class="lh-label">How was it ordered?</span>
          <select class="fb-select" name="via">${SENT_VIA.map((v) => `<option>${esc(v)}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="300" placeholder="e.g. Spoke to Sarah, arriving Friday" /></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Mark as sent</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const done = await markPoSent(po, { via: form.elements.via.value, note: form.elements.note.value }, staff);
        done.forEach((rid) => callApi({ action: "inventory", op: "notifyUpdate", requestId: rid }).catch(() => {}));
        dlg.close();
        showToast(`${po.number} marked as sent`);
        reload();
      } catch (ex) {
        console.error("Mark sent failed:", ex);
        const err = dlg.querySelector(".lh-error");
        err.textContent = "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  async function cancelDialog() {
    await settle();
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Cancel ${esc(po.number)}?</h3>
          <p>${po.status === "sent" ? "Let the supplier know too. " : ""}Its requests go back to Open.</p></div>
        <label class="lh-field"><span class="lh-label">Reason</span><textarea name="reason" rows="2" maxlength="500"></textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Keep it</button>
          <button type="submit" class="lh-btn is-danger">Cancel purchase order</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reason = form.elements.reason.value.trim();
      if (!reason) { err.textContent = "Give a reason."; err.hidden = false; return; }
      try {
        await cancelPo(po, reason, staff);
        dlg.close();
        showToast(`${po.number} cancelled`);
        reload();
      } catch (ex) {
        err.textContent = ex && ex.message && !ex.code ? ex.message : "Couldn't cancel. Try again.";
        err.hidden = false;
      }
    });
  }

  root.addEventListener("click", (e) => {
    const rm = e.target.closest('[data-l="remove"]');
    if (rm) {
      po.lines.splice(Number(rm.closest("[data-i]").dataset.i), 1);
      renderLeft(); renderRight(); changed();
      return;
    }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "add-line") {
      po.lines.push(cleanPoLine({ qty: 1 }));
      renderLeft(); changed();
      const sels = left.querySelectorAll('[data-l="product"]');
      if (sels.length) sels[sels.length - 1].focus();
    } else if (act === "add-custom") {
      po.lines.push({ ...cleanPoLine({ qty: 1 }), custom: true });
      renderLeft(); changed();
      const names = left.querySelectorAll('[data-l="name"]');
      if (names.length) names[names.length - 1].focus();
    } else if (act === "add-low") {
      let n = 0;
      products.filter((p) => p.active && p.supplierId === po.supplierId).forEach((p) => LOCATIONS.forEach((loc) => {
        if (!lowAt(p, loc.key) || po.lines.some((l) => l.productId === p.id && l.loc === loc.key)) return;
        po.lines.push(lineFromProduct(p, suggestOrder(p, loc.key), loc.key));
        n++;
      }));
      if (!n) { showToast("Nothing else from this supplier is low."); return; }
      renderLeft(); renderRight(); changed();
      showToast(`${n} low item${n === 1 ? "" : "s"} added with suggested amounts`);
    } else if (act === "preview") preview();
    else if (act === "send") sendDialog(false);
    else if (act === "resend") sendDialog(true);
    else if (act === "mark-sent") markSentDialog();
    else if (act === "cancel") cancelDialog();
  });

  renderAll();
  listRequests({ max: 300 })
    .then((list) => { reqs = list; if (root.isConnected) renderRight(); })
    .catch(() => { reqs = []; if (root.isConnected) renderRight(); });
}