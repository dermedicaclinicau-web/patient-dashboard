// One purchase order (#/inventory/po/<id>): items, and emailing the order to the supplier.
import {
  PO_STATUS, REQ_STATUS, LOCATIONS, locLabel, plural, unitPlural, lowAt, suggestOrder, reqNumber, batchName,
  getPo, savePo, renumberPo, markPoSent, cancelPo, poTotals, lineFromProduct, cleanPoLine, supplierSnapshot,
  listProducts, listSuppliers, listRequests, supplierTerms, suppliesProduct, suggestOrderFor, dayKey, productSuppliers,
  recordPastReceipt, getBaseline, syncReceivedRequests, fillPoTemplate, PO_ORDER_TAG_RE, amendPo,
  savePoEmail, listPoEmails,
} from "./inventory-api.js";
import { renderDeliveries } from "./po-deliveries.js";
import { deliveryError } from "./form-delivery.js";
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
// Plain text from a supplier's template → email paragraphs (blank line = new paragraph)
const textToHtml = (t) => String(t || "").trim().split(/\n{2,}/)
  .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

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
  let emails = null;   // copies of the emails sent (null = still loading)
  const loadEmails = () => listPoEmails(id)
    .then((list) => { emails = list; })
    .catch((err) => { console.warn("Sent emails not loaded:", err); emails = []; });
  // This account's Gmail Sent folder (through Apps Script): every email about this PO it sent
  const findInGmail = () => callApi({
    action: "inventory", op: "findSentPo", poId: id, poNumber: po.number,
    to: po.sentTo || (po.supplier && po.supplier.email) || "",
  }).then((r) => (r && Array.isArray(r.messages) ? r.messages : []));
  const gmailTime = (x) => Date.parse(x.date) || 0;
  // The message sent closest to a moment (within 10 minutes), or null
  const nearestTo = (list, t, timeOf, max = 10 * 60000) => {
    let best = null, gap = max;
    list.forEach((x) => { const g = Math.abs(timeOf(x) - t); if (g <= gap) { gap = g; best = x; } });
    return best;
  };
  // Keeps a copy of Gmail messages that History doesn't have yet
  async function keepFromGmail(list) {
    const have = emails || [];
    const fresh = list.filter((x) => !have.some((m) => m.gmailId === x.id)
      && !have.some((m) => !m.gmailId && Math.abs(m.time - gmailTime(x)) < 2 * 60000));   // already saved when sent
    await Promise.allSettled(fresh.map((x) => savePoEmail(id, {
      to: x.to, cc: x.cc, from: x.from, subject: x.subject, html: x.html, sentAt: x.date,
      kind: /^amended/i.test(x.subject || "") ? "amended" : "sent", gmailId: x.id, link: x.link,
    }, staff)));
    await loadEmails();
  }
    
  let amending = false;   // changing an order that's already been sent (saved only with "Save changes")
  const drafting = () => canOrder && po.status === "draft";
  const editable = () => drafting() || (canOrder && amending);
  const lockedLine = (l) => amending && (Number(l.received) || 0) > 0;   // some of it has arrived
  const supplierFull = () => suppliers.find((s) => s.id === po.supplierId) || null;
    // This PO's supplier's code, price and pack for a product. Not linked: no code or price (the PDF says "to be confirmed").
  const termsFor = (p) => supplierTerms(p, po.supplierId)
    || { supplierCode: "", cost: null, orderUnit: p.orderUnit, packSize: p.packSize };

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
      <div class="po-dv-wrap" data-role="deliveries"></div>
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
    if (amending) { setState("Not saved yet: press Save changes"); return; }   // never autosaved
    setState("Unsaved changes");
    clearTimeout(timer);
    timer = setTimeout(flush, 800);
  }
  async function flush() {
    clearTimeout(timer);
    if (!dirty || saving || !drafting()) return;
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
    // Backdated orders show their date; a backdated send shows the day only (no made-up time)
    const dated = po.backdated && po.orderDate ? ` · dated ${niceDate(po.orderDate)}` : "";
    const sentText = po.sentDate ? `Sent ${niceDate(po.sentDate)}` : po.sentAt ? `Sent ${when(po.sentAt)}` : "";
    $('[data-role="sub"]').innerHTML = `${esc((po.supplier.name || "No supplier") + dated)} · ${amending
      ? `<strong>Changing a sent order</strong> · <span data-role="state">${dirty ? "Not saved yet: press Save changes" : "No changes yet"}</span>`
      : editable()
      ? `<span data-role="state">${dirty ? "Unsaved changes" : "All changes saved"}</span>`
      : esc(sentText ? `${sentText}${po.sentVia ? ` (${po.sentVia})` : ""}` : PO_STATUS[po.status])}`;
    const pill = $('[data-role="pill"]');
    pill.className = `rq-status is-${po.status}`;
    pill.textContent = PO_STATUS[po.status];
    const nothingIn = po.lines.every((l) => !l.received);
    const acts = [];
    if (amending) {
      $('[data-role="acts"]').innerHTML = `<button type="button" class="ff-btn is-quiet" data-act="amend-discard">Discard changes</button>
        <button type="button" class="ff-btn is-primary" data-act="amend-save">${I.check}<span>Save changes</span></button>`;
      return;
    }
    if (canOrder && po.status === "draft") {
      acts.unshift('<button type="button" class="ff-btn is-quiet" data-act="cancel">Cancel PO</button>');
      acts.push(`<button type="button" class="ff-btn" data-act="mark-sent">${I.check}<span>Mark as sent</span></button>`);
      acts.push(`<button type="button" class="ff-btn is-primary" data-act="send">${I.send}<span>Send to supplier</span></button>`);
    } else if (canOrder && (po.status === "sent" || po.status === "part")) {
      if (po.status === "sent" && nothingIn) acts.unshift('<button type="button" class="ff-btn is-quiet" data-act="cancel">Cancel PO</button>');
      if (!po.historical) acts.push(`<button type="button" class="ff-btn" data-act="amend">${I.doc}<span>Change order</span></button>`);
      acts.push(`<button type="button" class="ff-btn" data-act="resend">${I.send}<span>Email again</span></button>`);
      acts.push(`<a class="ff-btn is-primary" href="#/inventory/receive/${encodeURIComponent(po.id)}">${I.check}<span>Receive stock</span></a>`);
    }
    // Admin: orders received before the portal (drafts, or sent with nothing in yet)
    if (can("inventory.history") && (po.status === "draft" || (po.status === "sent" && nothingIn))) {
      acts.splice(Math.max(0, acts.length - 1), 0,
        `<button type="button" class="ff-btn" data-act="past">${I.check}<span>Already received</span></button>`);
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
        ${drafting()
          ? `<select class="fb-select" data-k="supplierId" aria-label="Supplier">${suppliers.filter((x) => x.active || x.id === po.supplierId).map((x) =>
              `<option value="${esc(x.id)}"${x.id === po.supplierId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`
          : `<strong>${esc(po.supplier.name)}</strong>`}
        ${info ? `<small class="muted">${info}</small>` : ""}
        ${!s.email ? '<p class="tb-info">This supplier has no order email. Add one in Inventory → Suppliers, or order another way and use Mark as sent.</p>' : ""}
        ${s.orderNotes ? `<p class="tb-info">${esc(s.orderNotes)}</p>` : ""}
      </section>`;
  }

  function lineRow(l, i) {
    if (!editable()) {
      return `<tr><td><strong>${esc(l.name)}</strong>${l.supplierCode ? ` <small class="po-code">${esc(l.supplierCode)}</small>` : ""}</td>
        <td>${esc(plural(l.qty, l.orderUnit))}</td><td>${esc(locLabel(l.loc))}</td>
        ${po.status !== "draft" ? `<td>${l.received} of ${l.qty}</td>` : ""}</tr>`;
    }
    const named = !l.productId && (l.custom || l.name);
    const locked = lockedLine(l);
    const got = Number(l.received) || 0;
    return `
      <tr data-i="${i}"${locked ? ' class="po-locked"' : ""}>
        <td>${locked
          ? `<strong>${esc(l.name)}</strong>${l.supplierCode ? ` <small class="po-code">${esc(l.supplierCode)}</small>` : ""}
             <small class="po-src">Some has arrived, so only the quantity and “For” can change</small>`
          : named
          ? `<input class="fe-input" data-l="name" maxlength="150" placeholder="Item name, brand and size" value="${esc(l.name)}" aria-label="Item" />`
          : `<button type="button" class="fb-select po-pick${l.productId ? "" : " is-empty"}" data-l="pick"
              aria-haspopup="listbox" aria-expanded="false" aria-label="Product">${esc(
              l.productId ? `${(byId.get(l.productId) || {}).name || l.name}${byId.get(l.productId) && !byId.get(l.productId).active ? " (inactive)" : ""}`
                : "Search for a product…")}</button>`}
          ${l.sources.length ? `<small class="po-src">From ${l.sources.length} request item${l.sources.length === 1 ? "" : "s"}</small>` : ""}</td>
        <td><div class="po-qty"><input class="fe-input" type="number" min="${locked ? got : 1}" max="9999" step="1" data-l="qty" value="${l.qty}" aria-label="Quantity" />
          <small>${esc(unitPlural(l.orderUnit))}</small></div></td>
        <td><select class="fb-select" data-l="loc" aria-label="For">${LOCATIONS.map((x) =>
          `<option value="${x.key}"${x.key === l.loc ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select></td>
        ${amending ? `<td>${got} of ${l.qty}</td>` : ""}
        <td>${locked ? "" : '<button type="button" class="ib-tool is-danger" data-l="remove" aria-label="Remove" title="Remove">×</button>'}</td>
      </tr>`;
  }  
  function itemsCard() {
    const ed = editable();
    return `
      <section class="tb-card">
        <h4><span class="tb-num">2</span>Items</h4>
        ${amending ? `<p class="tb-info">You're changing an order that's already gone to the supplier. Nothing is saved until you press
          <strong>Save changes</strong>, and you can email them the updated order afterwards.</p>` : ""}
        ${po.lines.length ? `<div class="po-table-wrap"><table class="inv-table po-table"><thead><tr>
            <th>Item</th><th>Qty</th><th>For</th>${amending ? "<th>Received</th><th></th>" : ed ? "<th></th>" : po.status !== "draft" ? "<th>Received</th>" : ""}
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
          <dt>Order date</dt><dd>${esc(niceDate(po.orderDate) || "Not set")}${po.backdated ? ' <span class="po-tag">backdated</span>' : ""}</dd>
          ${po.sentDate || po.sentAt ? `<dt>Sent</dt><dd>${esc(po.sentDate ? niceDate(po.sentDate) : when(po.sentAt))}${
            po.sentVia ? ` (${esc(po.sentVia)})` : ""}</dd>` : ""}
          ${po.historical ? `<dt>Received</dt><dd>${esc(niceDate(po.receivedDate) || "Not recorded")}
            <span class="po-tag">before the portal</span><br><small class="muted">Recorded only. Stock wasn't changed.</small></dd>` : ""}
          <dt>Needed by</dt><dd>${esc(niceDate(po.expectedDate) || "Not set")}</dd>
          <dt>Notes to the supplier</dt><dd>${po.notesToSupplier ? esc(po.notesToSupplier).replace(/\n/g, "<br>") : "None"}</dd>
          <dt>Internal note</dt><dd>${po.internalNote ? esc(po.internalNote) : "None"}</dd>
          ${po.sentTo ? `<dt>Emailed to</dt><dd>${esc(po.sentTo)}</dd>` : ""}
          ${po.status === "cancelled" ? `<dt>Cancelled</dt><dd>${esc(po.cancelReason || "")}</dd>` : ""}
        </dl></section>`;
    }
    const today = dayKey();
    return `
      <section class="tb-card">
        <h4><span class="tb-num">3</span>Details</h4>
        <div class="po-dates">
          ${amending ? `<div class="tb-field"><span>Order date</span><strong>${esc(niceDate(po.orderDate) || "Not set")}</strong>
            <small class="muted">Can't be changed once it's been sent: the PO number follows it.</small></div>`
          : `<label class="tb-field"><span>Order date</span>
            <input class="fe-input" type="date" data-k="orderDate" value="${esc(po.orderDate || today)}" max="${today}" />
            <small class="muted">${po.backdated
              ? '<span class="po-tag">backdated</span> The PO number follows this date.'
              : "Change it for an order placed earlier, e.g. one from the old app."}</small></label>`}
          <label class="tb-field po-needed"><span>Needed by (optional)</span>
            <input class="fe-input" type="date" data-k="expectedDate" value="${esc(po.expectedDate)}" /></label>
        </div>
        <label class="tb-field"><span>Notes to the supplier (in the email)</span>
          <textarea class="fe-input" data-k="notesToSupplier" rows="3" maxlength="2000" placeholder="e.g. Please deliver before 2pm.">${esc(po.notesToSupplier)}</textarea></label>
        <label class="tb-field"><span>Internal note (not sent to the supplier)</span>
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
  // History entries about emailing the supplier ("Marked as sent" is not an email)
  const isEmailEvent = (e) => /email|sent to supplier/i.test(e.action || "") && !/marked/i.test(e.action || "");

  // Each email entry is matched to the saved copy sent closest to it (within 10 minutes).
  // A copy with no matching entry still shows, so nothing sent is ever hidden.
  function historyEntries() {
    const list = po.events.map((e) => ({ ...e, time: Date.parse(e.at) || 0, mail: null, emailish: isEmailEvent(e) }));
    const used = new Set();
    list.filter((e) => e.emailish).forEach((e) => {
      let best = null, gap = 10 * 60000;
      (emails || []).forEach((m) => {
        if (used.has(m.id)) return;
        const g = Math.abs(m.time - e.time);
        if (g <= gap) { gap = g; best = m; }
      });
      if (best) { used.add(best.id); e.mail = best; }
    });
    (emails || []).filter((m) => !used.has(m.id)).forEach((m) => list.push({
      action: m.kind === "amended" ? "Amended order emailed" : m.kind === "again" ? "Emailed again" : "Sent to supplier",
      note: `To ${m.to}`, by: m.by, time: m.time, at: new Date(m.time).toISOString(), mail: m, emailish: true,
    }));
    return list.sort((a, b) => b.time - a.time);
  }

  function historyHtml() {
    const list = historyEntries();
    if (!list.length) return '<p class="tb-none">Nothing yet.</p>';
    return `<ul class="po-events">${list.map((e) => {
      const inner = `<strong>${esc(e.action)}</strong>${e.note ? ` · ${esc(e.note)}` : ""}
        <small>${esc(e.by || "")} · ${esc(when(new Date(e.time)))}</small>`;
      if (e.mail) {
        return `<li><button type="button" class="po-ev-mail" data-mail="${esc(e.mail.id)}" title="See the email that was sent">
          ${inner}<span class="po-ev-view">${I.send}View the email${e.mail.gmailId ? " · from Gmail" : ""}</span></button></li>`;
      }
      const noCopy = e.emailish && emails !== null
        ? `<button type="button" class="po-ev-find" data-find="${e.time}">${I.send}Find it in Gmail's Sent folder</button>` : "";
      return `<li>${inner}${noCopy}</li>`;
    }).join("")}</ul>`;
  }

  function renderRight() {
    right.innerHTML = `
      <section class="tb-card"><h4>Requests on this order</h4>${reqsHtml()}</section>
      <section class="tb-card"><h4>History</h4>${historyHtml()}</section>`;
  }

  // The email as it was sent
  function emailPreview(m) {
    const row = (label, v) => (v ? `<div><span>${esc(label)}</span>${esc(v)}</div>` : "");
    const gmailRow = m.gmailId
      ? `<div><span>Gmail</span><strong class="po-gm-ok">✓ In the Sent folder</strong>${
          m.link ? ` <a href="${esc(m.link)}" target="_blank" rel="noopener">Open in Gmail ↗</a>` : ""}</div>`
      : `<div><span>Gmail</span><span data-role="verify"><button type="button" class="lh-btn" data-act="verify">Check it's in Gmail</button></span></div>`;
    const dlg = openDialog("th-dialog", `
      <div class="th-head">
        <div><h3>${esc(m.subject || "Purchase order email")}</h3>
          <p class="muted">${m.kind === "amended" ? "Amended order · " : m.kind === "again" ? "Sent again · " : ""}Sent ${esc(when(new Date(m.time)))}</p></div>
        <button type="button" class="ib-tool" data-act="close" aria-label="Close" title="Close">×</button>
      </div>
      <div class="th-meta">
        ${row("From", m.from || "The clinic's main address")}
        ${row("To", m.to)}
        ${row("CC", m.cc)}
        ${row("Sent by", m.by)}
        ${gmailRow}
      </div>
      ${m.html ? '<iframe class="th-frame" sandbox="" title="The email that was sent"></iframe>'
        : `<p class="tb-none" style="padding:0 1.2rem 1.2rem">${m.tooBig
          ? "The email was too big to keep a copy of, but the details above show it was sent."
          : "No copy of the message was kept."}</p>`}`);
    const frame = dlg.querySelector("iframe");
    if (frame) frame.srcdoc = m.html;
    dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());

    const vb = dlg.querySelector('[data-act="verify"]');
    if (vb) vb.addEventListener("click", async () => {
      const box = dlg.querySelector('[data-role="verify"]');
      vb.disabled = true;
      vb.textContent = "Looking in Gmail…";
      try {
        const hit = nearestTo(await findInGmail(), m.time, gmailTime);
        if (!dlg.open) return;
        box.innerHTML = hit
          ? `<strong class="po-gm-ok">✓ Found in the Sent folder</strong> · ${esc(when(new Date(gmailTime(hit))))} to ${esc(hit.to)}${
              hit.link ? ` · <a href="${esc(hit.link)}" target="_blank" rel="noopener">Open in Gmail ↗</a>` : ""}`
          : '<strong class="po-gm-bad">Not found in this account\'s Sent folder</strong> <small class="muted">around that time. It may have been deleted from Sent.</small>';
      } catch (err) {
        console.error("Gmail check failed:", err);
        if (!dlg.open) return;
        vb.disabled = false;
        vb.textContent = "Check it's in Gmail";
        showToast(err && err.code === "UNAUTHORIZED" ? "Your session has expired. Log out and back in." : "Couldn't check Gmail. Try again.");
      }
    });
  }
  
  const renderAll = () => { renderBar(); renderLeft(); renderRight(); };

  // Deliveries: only once the order has gone out (drafts have nothing to show)
  const dvBox = $('[data-role="deliveries"]');
  function renderDv() {
    if (po.status === "draft") { dvBox.innerHTML = ""; return; }
    renderDeliveries(dvBox, po, { labelOf: (pid) => batchName(byId.get(pid)), canReceive: false });
  }

  async function reload() {
    try { [po] = await Promise.all([getPo(id), loadEmails()]); } catch (err) { console.error(err); }
    if (root.isConnected && po) { renderAll(); renderDv(); }
  }

    // A draft's number follows its supplier (PO-<first 3 letters>-<date created>)
  async function renumber() {
    try {
      await settle();
      const n = await renumberPo(id, staff);
      if (n && n !== po.number) {
        po.number = n;
        renderBar();
        showToast(`Renumbered to ${n}`);
      }
    } catch (err) {
      console.warn("PO not renumbered:", err);
    }
  }

    /* ---------- Searchable product picker ---------- */
  // One panel at a time, attached to <body> so the table's scroll box never cuts it off
  const norm = (s) => String(s || "").toLowerCase();
  let combo = null;

  // Choosing a product for a row: this supplier's code, price and pack
  function setLineProduct(l, p) {
    const t = termsFor(p);
    Object.assign(l, { productId: p.id, name: p.name, supplierCode: t.supplierCode, orderUnit: t.orderUnit,
      packSize: t.packSize, stockUnit: p.stockUnit, dosePer: p.dosePer, doseUnit: p.doseUnit, unitCost: t.cost });
    renderLeft(); renderRight(); changed();
  }

  function closeCombo() {
    if (!combo) return;
    const { el, btn, outside, onScroll } = combo;
    combo = null;
    el.remove();
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", closeCombo);
    window.removeEventListener("scroll", onScroll, true);
    if (btn && btn.isConnected) btn.setAttribute("aria-expanded", "false");
  }

  function placeCombo() {
    if (!combo) return;
    const r = combo.btn.getBoundingClientRect();
    if (!r.width) { closeCombo(); return; }
    const w = Math.min(Math.max(r.width, 360), window.innerWidth - 16);
    const below = window.innerHeight - r.bottom;
    Object.assign(combo.el.style, { width: `${w}px`, left: `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px` });
    if (below < 300 && r.top > below) { combo.el.style.top = ""; combo.el.style.bottom = `${window.innerHeight - r.top + 4}px`; }
    else { combo.el.style.bottom = ""; combo.el.style.top = `${r.bottom + 4}px`; }
  }

  function drawCombo() {
    const words = norm(combo.input.value).split(/\s+/).filter(Boolean);
    const text = (p) => norm(`${p.name} ${p.brand} ${productSuppliers(p).map((s) => s.supplierCode).join(" ")} ${p.supplierCode}`);
    const hits = products.filter((p) => (p.active || p.id === combo.current) && words.every((w) => text(p).includes(w)));
    const mine = hits.filter((p) => suppliesProduct(p, po.supplierId));
    const others = hits.filter((p) => !suppliesProduct(p, po.supplierId));
    combo.items = [...mine, ...others].slice(0, 100);
    combo.active = Math.min(Math.max(0, combo.active), Math.max(0, combo.items.length - 1));
    const onPo = new Set(po.lines.map((l) => l.productId).filter(Boolean));
    const opt = (p, i) => {
      const t = termsFor(p);
      const pack = t.packSize > 1 ? `${t.orderUnit} of ${plural(t.packSize, p.stockUnit)}` : `By the ${p.stockUnit}`;
      const info = [p.brand, t.supplierCode && `Code ${t.supplierCode}`, pack, `Shelf ${p.stock.shelf} · JT ${p.stock.jt}`].filter(Boolean);
      const low = LOCATIONS.some((x) => lowAt(p, x.key));
      return `<li role="option" id="poc-${i}" data-pi="${i}" aria-selected="${i === combo.active}"
          class="po-combo-opt${i === combo.active ? " is-active" : ""}${p.id === combo.current ? " is-current" : ""}">
        <span class="po-combo-name"><strong>${esc(p.name)}</strong>${
          low ? '<em class="is-low">low</em>' : ""}${onPo.has(p.id) && p.id !== combo.current ? "<em>on this order</em>" : ""}</span>
        <small>${esc(info.join(" · "))}</small></li>`;
    };
    const head = (t) => `<li class="po-combo-head" role="presentation">${esc(t)}</li>`;
    const nMine = Math.min(mine.length, combo.items.length);
    combo.list.innerHTML = combo.items.length
      ? (nMine ? head("This supplier") : "") + combo.items.slice(0, nMine).map((p, i) => opt(p, i)).join("")
        + (combo.items.length > nMine ? head(nMine ? "Other products" : "Products") : "")
        + combo.items.slice(nMine).map((p, i) => opt(p, i + nMine)).join("")
        + (hits.length > combo.items.length ? `<li class="po-combo-more" role="presentation">Showing 100 of ${hits.length}. Type more to narrow it down.</li>` : "")
      : `<li class="po-combo-none" role="presentation">No product matches “${esc(combo.input.value)}”. Use “+ Add an item not on the list” instead.</li>`;
    combo.input.setAttribute("aria-activedescendant", combo.items.length ? `poc-${combo.active}` : "");
    const act = combo.list.querySelector(".is-active");
    if (act) act.scrollIntoView({ block: "nearest" });
  }

  function pickFromCombo(p) {
    if (!combo || !p) return;
    const l = po.lines[combo.li];
    closeCombo();
    if (l) setLineProduct(l, p);
  }

  function openCombo(btn) {
    closeCombo();
    const row = btn.closest("[data-i]");
    const l = row && po.lines[Number(row.dataset.i)];
    if (!l) return;
    const el = document.createElement("div");
    el.className = "po-combo";
    el.innerHTML = `<input type="search" class="fe-input po-combo-q" placeholder="Search name, brand or code" autocomplete="off"
        role="combobox" aria-expanded="true" aria-controls="po-combo-list" aria-label="Search products" />
      <ul class="po-combo-list" id="po-combo-list" role="listbox" aria-label="Products"></ul>`;
    document.body.appendChild(el);
    combo = { el, btn, li: Number(row.dataset.i), current: l.productId, input: el.querySelector("input"),
      list: el.querySelector("ul"), active: 0, items: [] };
    combo.outside = (e) => { if (!el.contains(e.target) && !btn.contains(e.target)) closeCombo(); };
    combo.onScroll = (e) => { if (combo && !el.contains(e.target)) placeCombo(); };
    document.addEventListener("pointerdown", combo.outside, true);
    window.addEventListener("resize", closeCombo);
    window.addEventListener("scroll", combo.onScroll, true);
    btn.setAttribute("aria-expanded", "true");

    placeCombo();
    drawCombo();
    const cur = combo.items.findIndex((p) => p.id === combo.current);   // start on the product already chosen
    if (cur > 0) { combo.active = cur; drawCombo(); }
    combo.input.focus();

    combo.input.addEventListener("input", () => { combo.active = 0; drawCombo(); });
    combo.input.addEventListener("keydown", (e) => {
      if (!combo) return;
      if (e.key === "ArrowDown") { e.preventDefault(); combo.active = Math.min(combo.items.length - 1, combo.active + 1); drawCombo(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); combo.active = Math.max(0, combo.active - 1); drawCombo(); }
      else if (e.key === "Enter") { e.preventDefault(); pickFromCombo(combo.items[combo.active]); }
      else if (e.key === "Escape") { e.preventDefault(); const b = combo.btn; closeCombo(); if (b.isConnected) b.focus(); }
      else if (e.key === "Tab") closeCombo();
    });
    combo.list.addEventListener("pointerdown", (e) => e.preventDefault());   // keeps the search box focused
    combo.list.addEventListener("click", (e) => {
      const o = e.target.closest("[data-pi]");
      if (o && combo) pickFromCombo(combo.items[Number(o.dataset.pi)]);
    });
  }
  window.addEventListener("hashchange", closeCombo);   // never left open on another page

  /* ---------- Editing ---------- */
  left.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.k === "orderDate") {   // the number follows the order date (once it's saved)
      renderLeft();
      renumber();
      return;
    }
    if (el.dataset.k === "supplierId") {
      const s = suppliers.find((x) => x.id === el.value);
      if (!s) return;
      po.supplierId = s.id;
      po.supplier = supplierSnapshot(s);
      // Each product line switches to the new supplier's code, price and pack, keeping the same amount of stock
      po.lines.forEach((l) => {
        const p = l.productId && byId.get(l.productId);
        if (!p) return;
        const t = termsFor(p);
        const stock = l.qty * Math.max(1, l.packSize);
        Object.assign(l, { supplierCode: t.supplierCode, unitCost: t.cost, orderUnit: t.orderUnit, packSize: t.packSize,
          qty: Math.max(1, Math.ceil(stock / Math.max(1, t.packSize))) });
      });
      renderAll(); changed();
      renumber();
      return;
    }
    const row = el.closest("[data-i]");
    if (!row) return;
    const l = po.lines[Number(row.dataset.i)];
    if (el.dataset.l === "product") {
      const p = byId.get(el.value);
      if (!p) return;
      const t = termsFor(p);
      Object.assign(l, { productId: p.id, name: p.name, supplierCode: t.supplierCode, orderUnit: t.orderUnit,
        packSize: t.packSize, stockUnit: p.stockUnit, dosePer: p.dosePer, doseUnit: p.doseUnit, unitCost: t.cost });
      renderLeft(); renderRight(); changed();
    } else if (el.dataset.l === "loc") {
      l.loc = el.value;
      changed();
    }
  });
  left.addEventListener("input", (e) => {
    const el = e.target;
    const k = el.dataset.k;
    if (k === "orderDate") {
      const v = el.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;   // still being typed
      if (v > dayKey()) { msgEl.textContent = "The order date can't be in the future."; return; }
      po.orderDate = v;
      po.backdated = v < (po.createdAt instanceof Date && !isNaN(po.createdAt) ? dayKey(po.createdAt) : dayKey());
      changed();
      return;
    }
    if (k && k !== "supplierId") {
      po[k] = el.type === "checkbox" ? el.checked : el.value;
      changed();
      return;
    }
    const row = el.closest("[data-i]");
    if (!row) return;
    const l = po.lines[Number(row.dataset.i)];
    if (el.dataset.l === "qty") l.qty = Math.min(9999, Math.max(1, parseInt(el.value, 10) || 1));
    else if (el.dataset.l === "name") l.name = el.value;
    else return;
    changed();
  });
  /* ---------- PDF, sending, cancelling ---------- */
  function problems() {
    if (!po.supplierId) return "Choose a supplier.";
    if (po.lines.some((l) => !l.productId && !String(l.name || "").trim())) return "Choose a product for every row, or remove the empty row.";
    if (!po.lines.length) return "Add at least one item.";
    return "";
  }


  // Under the item name: "Box of 5 syringes · 1 mL per syringe"
  const packSub = (l) => {
    const pack = l.packSize > 1 ? `${l.orderUnit} of ${plural(l.packSize, l.stockUnit)}` : "";
    const dose = l.dosePer && l.doseUnit ? `${l.dosePer} ${l.doseUnit} per ${l.stockUnit}` : "";
    return [pack, dose].filter(Boolean).join(" · ");
  };

  // The order itself, written into the email (styled inline so it looks right in every mail app)
  function itemsEmailHtml() {
    const lines = po.lines;
    const hasCode = lines.some((l) => String(l.supplierCode || "").trim());
    const th = (t, right = false) => `<th style="padding:8px 10px;background:#0f766e;color:#ffffff;font-size:13px;font-weight:bold;text-align:${right ? "right" : "left"}">${t}</th>`;
    const td = (v, right = false, extra = "") => `<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:14px;vertical-align:top;text-align:${right ? "right" : "left"};${extra}">${v}</td>`;
    return `<div style="margin:18px 0 6px;font-size:16px;font-weight:bold;color:#0f766e">Purchase order ${esc(po.number)}</div>`
      + (po.expectedDate ? `<p style="margin:0 0 8px;font-size:14px"><strong>Needed by:</strong> ${esc(niceDate(po.expectedDate))}</p>` : "")
      + `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:6px 0 12px">
          <tr>${th("#")}${th("Item")}${hasCode ? th("Code") : ""}${th("Qty", true)}</tr>
          ${lines.map((l, i) => {
            const sub = packSub(l);
            return `<tr>${td(i + 1, false, "color:#64748b;width:28px")}${
              td(`${esc(l.name)}${sub ? `<div style="font-size:12px;color:#64748b">${esc(sub)}</div>` : ""}`)}${
              hasCode ? td(esc(l.supplierCode || "")) : ""}${
              td(`<strong>${esc(plural(l.qty, l.orderUnit))}</strong>`, true, "white-space:nowrap")}</tr>`;
          }).join("")}
        </table>`
      + (po.notesToSupplier ? `<p style="margin:0 0 12px;padding:10px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-size:14px"><strong>Notes:</strong><br>${
          esc(po.notesToSupplier).replace(/\n/g, "<br>")}</p>` : "");
  }

  async function sendDialog(again, amended = false) {
    const p = problems();
    if (p) { msgEl.textContent = p; return; }
    await settle();
    const s = supplierFull() || po.supplier;
    const tpl = { po, supplier: s, staff };
    // The supplier's saved email (Inventory → Suppliers → Edit), otherwise the standard wording
    const ownBody = String(s.emailBody || "").trim();
    const ownSubject = String(s.emailSubject || "").trim();
    const first = String(s.contactName || "").split(" ")[0];
    const message = ownBody ? textToHtml(fillPoTemplate(ownBody, tpl))
      : `<p>Hi ${esc(first || "there")},</p>` +
        `<p>Please see our purchase order <strong>${esc(po.number)}</strong> below${s.accountNo ? ` (account ${esc(s.accountNo)})` : ""}.</p>` +
        "<p>Please reply to confirm the order, pricing and the expected delivery date.</p>";
    const baseSubject = ownSubject ? fillPoTemplate(ownSubject, tpl) : `Purchase order ${po.number} - Dermedica`;
    const subject = amended ? `Amended: ${baseSubject}` : baseSubject;
    // A template usually signs off itself, so the sign-off starts empty (it can still be typed in)
    const signoff = ownBody ? "" : `Kind regards,\n${(staff && staff.name) || "The team"}\nDermedica`;
    const amendNote = amended
      ? `<p><strong>Please note: this is an updated order.</strong> It replaces ${esc(po.number)} as we sent it earlier.</p>` : "";
    const tagged = PO_ORDER_TAG_RE.test(message);   // the supplier's message says where the order goes
    const dlg = openDialog("ec-dialog ac-mail", `
      <form class="lh-form ec-form" novalidate>
        <div class="lh-dialog-head"><h3>${amended ? "Email the amended order" : again ? "Email the purchase order again" : "Send to supplier"}</h3>
          <p data-role="orderwhere">${tagged ? "The order goes where {Order table} is in your message."
            : "The order is written into the email, below your message."} Nothing is attached.</p>
          ${ownBody || ownSubject ? `<p class="fe-note">Filled in from ${esc(s.name || "this supplier")}'s saved email.
            Changes here are for this email only. To change it for next time, edit the supplier.</p>` : ""}</div>
        <div class="po-from">
          <label class="lh-field"><span class="lh-label">From</span>
            <select class="fb-select" name="from" disabled><option value="">Loading your email addresses…</option></select></label>
          <label class="fe-check po-from-def" hidden><input type="checkbox" name="makeDefault" /> Use this for purchase orders from now on</label>
        </div>
        <div class="ac-ed-two">
          <label class="lh-field"><span class="lh-label">To</span><input type="email" name="to" maxlength="254" value="${esc(s.email || "")}" /></label>
          <label class="lh-field"><span class="lh-label">CC (optional)</span><input type="email" name="cc" maxlength="254" value="${esc(s.ccEmail || "")}" /></label>
        </div>
        <label class="lh-field"><span class="lh-label">Subject</span><input name="subject" maxlength="200" value="${esc(subject)}" /></label>
        <div class="lh-field"><span class="lh-label">Message</span><div class="tr-canvas" style="background-color:#f1f5f9"><div data-role="editor"></div></div></div>
        <div class="lh-field"><span class="lh-label" data-role="orderlabel">The order (${tagged
          ? "goes where {Order table} is in your message" : "added after your message"})</span>
        <div class="po-mail-items">${itemsEmailHtml()}</div></div>
        <label class="lh-field"><span class="lh-label">Sign-off</span><textarea name="signoff" rows="3" maxlength="300">${esc(signoff)}</textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${again ? "Send again" : "Send purchase order"}</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const editor = createRichEditor(dlg.querySelector('[data-role="editor"]'), { accent: () => "#0f766e" });
    editor.setHtml(amendNote + message);
    // If {Order table} is typed or deleted, the wording about where the order goes follows it
    const syncWhere = () => {
      const t = PO_ORDER_TAG_RE.test(editor.getHtml());
      dlg.querySelector('[data-role="orderwhere"]').textContent = (t
        ? "The order goes where {Order table} is in your message." : "The order is written into the email, below your message.")
        + " Nothing is attached.";
      dlg.querySelector('[data-role="orderlabel"]').textContent =
        `The order (${t ? "goes where {Order table} is in your message" : "added after your message"})`;
    };
    dlg.querySelector('[data-role="editor"]').addEventListener("input", syncWhere);

    // The addresses this clinic can send from (main account + Gmail "Send mail as" aliases)
    const fromSel = form.elements.from;
    const defBox = dlg.querySelector(".po-from-def");
    let defaultFrom = "";
    const syncDefault = () => { defBox.hidden = !fromSel.value || fromSel.value === defaultFrom; };
    callApi({ action: "inventory", op: "senders" }).then((res) => {
      if (!dlg.open) return;
      const list = [res.primary, ...(res.aliases || [])].filter(Boolean);
      defaultFrom = res.defaultFrom || res.primary || "";
      fromSel.innerHTML = list.map((a) => `<option value="${esc(a)}"${a === defaultFrom ? " selected" : ""}>${
        esc(a)}${a === res.primary ? " (main account)" : ""}</option>`).join("");
      fromSel.disabled = false;
      syncDefault();
    }).catch((ex) => {
      console.warn("Senders not loaded:", ex);
      if (dlg.open) fromSel.innerHTML = '<option value="">The clinic\'s main address</option>';
    });
    fromSel.addEventListener("change", syncDefault);

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
      btn.textContent = "Sending…";
      err.hidden = true;
      const sign = form.elements.signoff.value.trim();
      // {Order table} in the message: the table goes there (its paragraph is replaced, so the HTML stays tidy).
      // Otherwise it goes after the message. Any extra copies of the tag are removed.
      const msgHtml = editor.getHtml();
      const table = itemsEmailHtml();
      const ownLine = /<p[^>]*>\s*(?:<[^>]+>\s*)*\{\s*order\s+table\s*\}\s*(?:<\/?[^>]+>\s*)*<\/p>/i;
      const placed = ownLine.test(msgHtml) ? msgHtml.replace(ownLine, table)
        : PO_ORDER_TAG_RE.test(msgHtml) ? msgHtml.replace(PO_ORDER_TAG_RE, table)
        : msgHtml + table;
      const body = placed.replace(new RegExp(PO_ORDER_TAG_RE.source, "gi"), "")
        + (sign ? `<p>${esc(sign).replace(/\n/g, "<br>")}</p>` : "");
      const mailSubject = form.elements.subject.value.trim() || `Purchase order ${po.number}`;
      const mailHtml = emailShell(body, {}, { clinic: clinicDetails(letterhead), hasLogo: !!(letterhead && letterhead.logo) });
      try {
        await callApi({
          action: "inventory", op: "sendPo", poId: id, to, cc,
          from: fromSel.value, makeDefault: !defBox.hidden && form.elements.makeDefault.checked,
          subject: mailSubject, html: mailHtml,
        });
        // Sent: keep a copy for History. If saving the copy fails, the email has still gone.
        await savePoEmail(id, {
          to, cc, from: fromSel.value, subject: mailSubject, html: mailHtml,
          kind: amended ? "amended" : again ? "again" : "sent",
        }, staff).catch((ex) => console.warn("Copy of the sent email not saved:", ex));
        busy = false;
        dlg.close();
        showToast(`${po.number} emailed to ${to}`);
        reload();
      } catch (ex) {
        console.error("Send PO failed:", ex);
        busy = false;
        show(ex && ex.code === "FORBIDDEN" ? "Only the ordering team can send purchase orders."
          : ex && ex.code === "BAD_FROM" ? "That sending address isn't set up in Gmail any more. Choose another one."
          : deliveryError(ex));
        btn.disabled = false;
        btn.textContent = again ? "Send again" : "Send purchase order";
      }
    });
  }

  async function markSentDialog() {
    const p = problems();
    if (p) { msgEl.textContent = p; return; }
    await settle();
    const today = dayKey();
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Mark ${esc(po.number)} as sent</h3>
          <p>For orders placed another way, or already sent from the old app. Nothing is emailed. The requests it covers are marked as ordered.</p></div>
        <label class="lh-field"><span class="lh-label">How was it ordered?</span>
          <select class="fb-select" name="via">${SENT_VIA.map((v) => `<option>${esc(v)}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Date sent to the supplier</span>
          <input type="date" name="sentDate" value="${today}" max="${today}" min="${esc(po.orderDate || "")}" /></label>
        <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="300" placeholder="e.g. Spoke to Sarah, arriving Friday" /></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Mark as sent</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const sentDate = form.elements.sentDate.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sentDate)) { err.textContent = "Choose the date it was sent."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const done = await markPoSent(po, { via: form.elements.via.value, note: form.elements.note.value, sentDate }, staff);
        done.forEach((rid) => callApi({ action: "inventory", op: "notifyUpdate", requestId: rid }).catch(() => {}));
        dlg.close();
        showToast(`${po.number} marked as sent${sentDate < today ? ` on ${niceDate(sentDate)}` : ""}`);
        reload();
      } catch (ex) {
        console.error("Mark sent failed:", ex);
        err.textContent = ex && ex.message && !ex.code ? ex.message : "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  // Admin: an order already received before the portal. Recorded only: stock isn't changed.
  async function pastDialog() {
    const p = problems();
    if (p) { msgEl.textContent = p; return; }
    await settle();
    const today = dayKey();
    const draft = po.status === "draft";
    const sentKnown = po.sentDate || (po.sentAt ? dayKey(po.sentAt) : "");
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Record ${esc(po.number)} as already received</h3>
          <p>For orders received before the portal. Every item is marked as received in full.
            <strong>Stock isn't changed</strong>: it should already be in your counts.</p></div>
        <div class="po-dates">
          ${draft ? `<label class="lh-field"><span class="lh-label">Date sent to the supplier</span>
              <input type="date" name="sentDate" value="${esc(po.orderDate || today)}" min="${esc(po.orderDate || "")}" max="${today}" /></label>`
            : `<div class="lh-field"><span class="lh-label">Sent</span><strong>${esc(niceDate(sentKnown) || "Not recorded")}</strong></div>`}
          <label class="lh-field"><span class="lh-label">Date received</span>
            <input type="date" name="receivedDate" value="${today}" min="${esc(sentKnown || po.orderDate || "")}" max="${today}" /></label>
        </div>
        <div class="po-dates">
          <label class="lh-field"><span class="lh-label">Received by (optional)</span>
            <input name="receivedBy" maxlength="120" autocomplete="off" /></label>
          <label class="lh-field"><span class="lh-label">Docket number (optional)</span>
            <input name="docketNo" maxlength="60" autocomplete="off" /></label>
        </div>
        <label class="lh-field"><span class="lh-label">Note (optional)</span>
          <input name="note" maxlength="1000" placeholder="e.g. Entered from the old app" /></label>
        <p class="tb-info" data-role="warn" hidden></p>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Record as received</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const warn = dlg.querySelector('[data-role="warn"]');
    const show = (m) => { err.textContent = m; err.hidden = false; };

    // Received on or after the starting stock day: probably not in the counts yet
    let base = null;
    const check = () => {
      const rd = form.elements.receivedDate.value;
      const late = !!(base && rd && rd >= base.dateKey);
      warn.hidden = !late;
      if (late) warn.textContent = `Your starting stock was set from the count on ${niceDate(base.dateKey)}. `
        + "If this arrived after that count, it isn't in the stock numbers yet: use Receive stock instead.";
    };
    getBaseline().then((b) => { base = b; if (dlg.open) check(); }).catch(() => {});
    form.elements.receivedDate.addEventListener("input", check);

    let busy = false;
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const sentDate = draft ? form.elements.sentDate.value : "";
      const receivedDate = form.elements.receivedDate.value;
      if (draft && !/^\d{4}-\d{2}-\d{2}$/.test(sentDate)) { show("Choose the date it was sent."); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) { show("Choose the date it was received."); return; }
      if (draft && receivedDate < sentDate) { show("It can't have been received before it was sent."); return; }
      busy = true;
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        const res = await recordPastReceipt(po.id, {
          sentDate, receivedDate, receivedBy: form.elements.receivedBy.value,
          docketNo: form.elements.docketNo.value, note: form.elements.note.value,
        }, staff);
        try { await syncReceivedRequests(res.requestIds, staff); } catch (ex) { console.warn("Requests not updated", ex); }
        busy = false;
        dlg.close();
        showToast(`${res.number} recorded as received ${niceDate(receivedDate)}. Stock wasn't changed.`);
        reload();
      } catch (ex) {
        console.error("Record past receipt failed:", ex);
        busy = false;
        show(ex && ex.code === "permission-denied" ? "You don't have access to record orders received before the portal."
          : ex && ex.message && !ex.code ? ex.message : "Couldn't save. Try again.");
        btn.disabled = false;
        btn.textContent = "Record as received";
      }
    });
  }
  /* ---------- Changing a sent order ---------- */
  async function startAmend() {
    try { const fresh = await getPo(id); if (fresh) po = fresh; } catch (err) { console.warn("PO not refreshed:", err); }
    if (!["sent", "part"].includes(po.status)) {
      renderAll(); renderDv();
      showToast(`This order is now ${PO_STATUS[po.status].toLowerCase()}, so it can't be changed.`);
      return;
    }
    amending = true;
    dirty = false;
    msgEl.textContent = "";
    renderAll();
  }

  async function discardAmend() {
    if (dirty && !confirm("Discard your changes to this order?")) return;
    closeCombo();
    amending = false;
    dirty = false;
    msgEl.textContent = "";
    await reload();
  }

  function amendSaveDialog() {
    if (!dirty) { msgEl.textContent = "Nothing has changed yet."; return; }
    const p = problems();
    if (p) { msgEl.textContent = p; return; }
    closeCombo();
    const s = supplierFull() || po.supplier;
    const dlg = openDialog("inv-dlg", `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Save changes to ${esc(po.number)}</h3>
          <p>The changes and your reason are added to the order's history.${po.requestIds.length
            ? " Requests whose items were taken off this order go back to Open." : ""}</p></div>
        <label class="lh-field"><span class="lh-label">Reason for the change</span>
          <input name="reason" maxlength="300" placeholder="e.g. Wrong quantity entered" autocomplete="off" /></label>
        <label class="fe-check"><input type="checkbox" name="email"${s.email ? " checked" : " disabled"} />
          Email the amended order to the supplier next${s.email ? "" : " (no order email on file)"}</label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Keep editing</button>
          <button type="submit" class="lh-btn is-primary">Save changes</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    let busy = false;
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reason = form.elements.reason.value.trim();
      if (!reason) { err.textContent = "Add a reason, so everyone can see why it changed."; err.hidden = false; return; }
      const wantEmail = form.elements.email.checked;
      busy = true;
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        const res = await amendPo(id, {
          lines: po.lines, expectedDate: po.expectedDate, notesToSupplier: po.notesToSupplier,
          internalNote: po.internalNote, gst: po.gst, reason,
        }, staff);
        amending = false;
        dirty = false;
        let done = [];
        if (res.status === "received") {
          try { done = await syncReceivedRequests(res.requestIds, staff); } catch (ex) { console.warn("Requests not updated", ex); }
        }
        busy = false;
        dlg.close();
        showToast([
          `${res.number} updated`,
          res.status === "received" ? "everything on it has now arrived" : "",
          res.reopened.length ? `${res.reopened.length} request${res.reopened.length === 1 ? "" : "s"} back to Open` : "",
          done.length ? `${done.length} request${done.length === 1 ? "" : "s"} marked Received` : "",
        ].filter(Boolean).join(" · "));
        await reload();
        if (wantEmail && ["sent", "part"].includes(po.status)) sendDialog(true, true);
      } catch (ex) {
        console.error("Amend PO failed:", ex);
        busy = false;
        err.textContent = ex && ex.code === "permission-denied" ? "Only the ordering team can change purchase orders."
          : ex && ex.message && !ex.code ? ex.message : "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Save changes";
      }
    });
    form.elements.reason.focus();
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
    const mv = e.target.closest("[data-mail]");
    if (mv) {
      const m = (emails || []).find((x) => x.id === mv.dataset.mail);
      if (m) emailPreview(m);
      return;
    }
    const fb = e.target.closest("[data-find]");
    if (fb) {
      const t = Number(fb.dataset.find) || 0;
      fb.disabled = true;
      fb.textContent = "Looking in Gmail…";
      findInGmail().then(async (list) => {
        if (!root.isConnected) return;
        if (!list.length) {
          fb.outerHTML = '<small class="po-ev-nocopy">Not found in this account\'s Sent folder.</small>';
          return;
        }
        await keepFromGmail(list);
        if (!root.isConnected) return;
        renderRight();
        const hit = nearestTo(list, t, gmailTime);
        const m = hit && (emails || []).find((x) => x.gmailId === hit.id);
        if (m) emailPreview(m);
        else showToast(`Found ${list.length} email${list.length === 1 ? "" : "s"} for ${po.number} in Gmail. They're now in History.`);
      }).catch((err) => {
        console.error("Gmail search failed:", err);
        if (fb.isConnected) { fb.disabled = false; fb.innerHTML = `${I.send}Find it in Gmail's Sent folder`; }
        showToast(err && err.code === "UNAUTHORIZED" ? "Your session has expired. Log out and back in."
          : "Couldn't search Gmail. Check the Apps Script has been deployed.");
      });
      return;
    }
    const pk = e.target.closest('[data-l="pick"]');
    if (pk) {
      if (combo && combo.btn === pk) closeCombo(); else openCombo(pk);
      return;
    }
    const rm = e.target.closest('[data-l="remove"]');
    if (rm) {
      const ri = Number(rm.closest("[data-i]").dataset.i);
      if (lockedLine(po.lines[ri])) { msgEl.textContent = "Some of this has arrived, so it can't be removed."; return; }
      po.lines.splice(ri, 1);
      renderLeft(); renderRight(); changed();
      return;
    }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "add-line") {
      po.lines.push(cleanPoLine({ qty: 1 }));
      renderLeft(); changed();
      const picks = left.querySelectorAll('[data-l="pick"]');
      if (picks.length) openCombo(picks[picks.length - 1]);
    } else if (act === "add-custom") {
      po.lines.push({ ...cleanPoLine({ qty: 1 }), custom: true });
      renderLeft(); changed();
      const names = left.querySelectorAll('[data-l="name"]');
      if (names.length) names[names.length - 1].focus();
    } else if (act === "add-low") {
      let n = 0;
      products.filter((p) => p.active && suppliesProduct(p, po.supplierId)).forEach((p) => LOCATIONS.forEach((loc) => {
        if (!lowAt(p, loc.key) || po.lines.some((l) => l.productId === p.id && l.loc === loc.key)) return;
        po.lines.push(lineFromProduct(p, suggestOrderFor(p, loc.key, po.supplierId), loc.key, [], po.supplierId));
        n++;
      }));
      if (!n) { showToast("Nothing else from this supplier is low."); return; }
      renderLeft(); renderRight(); changed();
      showToast(`${n} low item${n === 1 ? "" : "s"} added with suggested amounts`);
    } else if (act === "send") sendDialog(false);
    else if (act === "resend") sendDialog(true);
    else if (act === "mark-sent") markSentDialog();
    else if (act === "past") pastDialog();
    else if (act === "cancel") cancelDialog();
    else if (act === "amend") startAmend();
    else if (act === "amend-discard") discardAmend();
    else if (act === "amend-save") amendSaveDialog();
  });

  renderAll();
  renderDv();
  loadEmails().then(() => { if (root.isConnected) renderRight(); });
  listRequests({ max: 300 })
    .then((list) => { reqs = list; if (root.isConnected) renderRight(); })
    .catch(() => { reqs = []; if (root.isConnected) renderRight(); });
}