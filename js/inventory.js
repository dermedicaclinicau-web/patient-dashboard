// Inventory (#/inventory/<tab>): stock on the Shelf and in JT storage, products, suppliers and the activity log.
import {
  INV_CATEGORIES, LOCATIONS, qtyText, packText, batchName, batchText, WEEKDAYS, WRITEOFF_REASONS, ADD_REASONS, MOVE_TYPES, REQ_STATUS, PO_STATUS, catLabel, locLabel, plural, unitPlural,
  expiryState, fefo, reqNumber, myUid, suggestOrder, listProducts, saveProduct, listSuppliers, saveSupplier, listAllLots, listMoves,
  applyStock, listRequests, setRequestStatus, cancelRequest, getRequestSettings, saveRequestSettings,
  listPos, createPo, poTotals, itemOnPo, lineFromProduct, cleanPoLine,
  productSuppliers, supplierTerms, suppliesProduct, suggestOrderFor,
  listCounts, listInvestigations, dayKey, 
  isSharedProduct, listOpenContainers, openContainer, finishContainer, openState, expectedUses, FINISH_REASONS,
  setStartingStock, PO_EMAIL_TAGS, fillPoTemplate, poNumberBase, PO_ORDER_TAG_RE, setTracking, correctLot,
  listKits, listKitDays, recordManualSale, undoMove, recordPaperUse, isKitProduct,
  recordPatientReturn, recordSupplierReturn, markReturnCredited, listReturns, RETURN_REASONS, RETURN_STATUS,
  rebuildPlan, applyRebuild, listCountsOn, getInvoiceSettings, saveInvoiceSettings,
  listBaseCounts, saveBaseCount, planFromBases, productLedger, suggestInvoiceLinks, invoiceNameKey,
  removeBaseCount, canUndoCorrection, undoCorrection, productSales, settlePendingSales, settleShortSales,
} from "./inventory-api.js";
import { searchPatients } from "./task-runner.js";
import { openSetKitDialog, openKitFromShelfDialog } from "./kit-admin.js";
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
import { openInvoiceLinks } from "./invoice-links.js";
import { renderBillingCheck } from "./billing-check.js";


const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const TABS = [["stock", "Stock"], ["kits", "Kits"], ["investigations", "Investigations"], ["billing", "Billing check"], ["requests", "Requests"],
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
// acts: Undo on write-offs and paper records that haven't been undone; "Used on a patient…" on write-offs (Manage inventory)
function movesHtml(moves, showProduct = true, labelOf = () => "Batch", acts = false) {
  if (!moves.length) return '<p class="tb-none">No stock changes yet.</p>';
  const undoable = (m) => !!m.id && !m.undone && (m.type === "writeoff" || (m.type === "use" && m.paper === true) || canUndoCorrection(m));
  return `<ul class="inv-moves">${moves.map((m) => `
    <li${m.undone ? ' class="is-undone"' : ""}>
      <span class="inv-m-when">${esc(when(m.at))}</span>
      <span class="inv-m-main"><strong>${esc(MOVE_TYPES[m.type] || m.type)}</strong>${m.undone ? ' <span class="inv-flag">Undone</span>' : ""}${
        showProduct ? ` · ${esc(m.productName || "")}` : ""}
        <small>${esc(linesText(m, labelOf(m.productId)))}${m.reason ? ` · ${esc(m.reason)}` : ""}${m.note ? ` · ${esc(m.note)}` : ""}</small>
        ${acts && undoable(m) ? `<span class="inv-m-acts">
          <button type="button" class="lh-btn is-quiet" data-undo="${esc(m.id)}">Undo</button>
          ${m.type === "writeoff" ? `<button type="button" class="lh-btn is-quiet" data-touse="${esc(m.id)}">Used on a patient…</button>` : ""}</span>` : ""}</span>
      <span class="inv-m-by">${esc(m.by || "")}</span>
    </li>`).join("")}</ul>`;
}

// Used on a patient, recorded on paper. from: a write-off to turn into this instead.
function paperUseDialogFor(p, lots, staff, from = null, prefill = null) {
      const today = dayKey();
      const unit = p.stockUnit;
      const avail = lots.filter((l) => l.qty > 0);
      // A write-off's note often says when and who: "Usage: 22/10 Dianne Anderson"
      let guessDate = today, guessName = "";
      if (prefill && /^\d{4}-\d{2}-\d{2}$/.test(prefill.date || "") && prefill.date <= today) guessDate = prefill.date;
      if (from) {
        const t = String(from.note || "");
        const dm = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(t);
        if (dm) {
          const y = dm[3] ? (dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]) : new Date().getFullYear();
          let k = `${y}-${String(+dm[2]).padStart(2, "0")}-${String(+dm[1]).padStart(2, "0")}`;
          if (!dm[3] && k > today) k = `${y - 1}${k.slice(4)}`;
          if (/^\d{4}-\d{2}-\d{2}$/.test(k) && k <= today && niceDate(k)) guessDate = k;
        }
        guessName = t.replace(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g, " ").replace(/\b(usage|used|use|on|for)\b:?/gi, " ")
          .replace(/[·:,]/g, " ").replace(/\s+/g, " ").trim();
      }
      const whereHtml = from
        ? `<p class="inv-hint">From the write-off on ${esc(when(from.at))}: ${esc(linesText(from, batchName(p)))}. It's already off stock,
            so stock doesn't change: the write-off is undone and it becomes this patient's usage instead.</p>`
        : p.tracked
          ? (avail.length ? `<label class="lh-field"><span class="lh-label">Which one</span><select class="fb-select" name="lot">${avail.map((l, i) =>
              `<option value="${i}">${esc(`${locLabel(l.loc)} · ${batchText(p, l.batch)} · Exp ${niceDate(l.expiry)} · ${plural(l.qty, unit)}`)}</option>`).join("")}</select></label>`
            : '<p class="tb-none">There is no stock to take it from.</p>')
          : `<div class="lh-field"><span class="lh-label">Taken from</span>${seg("loc", LOCATIONS.map((l) => [l.key, `${l.label} (${p.stock[l.key]})`]),
              p.stock.shelf > 0 ? "shelf" : "jt")}</div>`;
      const canSave = !!from || !p.tracked || avail.length > 0;

      return new Promise((resolve) => {
        let saved = false, found = [], timer = null, seq = 0;
        let chosen = prefill && prefill.patientId ? { id: prefill.patientId, name: prefill.patientName || "Patient", dob: "", pttId: "" } : null;
        const d2 = openDialog("inv-dlg", `
          <form class="lh-form" novalidate>
            <div class="lh-dialog-head"><h3>Used on a patient: ${esc(p.name)}</h3>
              <p>For a treatment recorded on paper (or a form outside the portal). It's saved to the patient's usage on the day it was
                used, so it counts as usage, not waste, and opening counts done since are corrected.</p></div>
            <label class="lh-field" data-role="find"><span class="lh-label">Patient</span>
              <input type="search" name="q" placeholder="Search by name" autocomplete="off" value="${esc(guessName)}" /></label>
            <div class="ef-test-hits" data-role="hits"></div>
            <div data-role="pick"></div>
            <div class="inv-two">
              <label class="lh-field"><span class="lh-label">Date used</span>
                <input type="date" name="date" value="${guessDate}" max="${today}" /></label>
              ${from ? "" : `<label class="lh-field"><span class="lh-label">How many</span>
                <div class="fe-num"><input class="fe-input" name="qty" type="number" min="1" max="99" step="1" value="1" inputmode="numeric" />
                  <span>${esc(unitPlural(unit))}</span></div></label>`}
            </div>
            ${whereHtml}
            ${p.doseUnit ? `<label class="lh-field"><span class="lh-label">Amount given (${esc(p.doseUnit)}), optional</span>
              <input name="dose" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. ${esc(fmtN(p.dosePer || 1))}" /></label>` : ""}
            <label class="lh-field"><span class="lh-label">Note (optional)</span>
              <input name="note" maxlength="300" placeholder="e.g. Paper consent and treatment record, Dr Teh" /></label>
            <p class="lh-error" role="alert" hidden></p>
            <div class="lh-actions">
              <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
              ${canSave ? `<button type="submit" class="lh-btn is-primary">${from ? "Move to their record" : "Record it"}</button>` : ""}
            </div>
          </form>`);
        const form = d2.querySelector("form");
        const f = form.elements;
        const err = d2.querySelector(".lh-error");
        const hits = d2.querySelector('[data-role="hits"]');
        const pick = d2.querySelector('[data-role="pick"]');
        const findBox = d2.querySelector('[data-role="find"]');

        const showPick = () => {
          pick.innerHTML = chosen ? `<div class="ef-chosen"><span><strong>${esc(chosen.name)}</strong><br>
            <small class="muted">${esc([chosen.dob && `DOB ${chosen.dob}`, chosen.pttId && `ID ${chosen.pttId}`].filter(Boolean).join(" · "))}</small></span>
            <button type="button" class="lh-btn is-quiet" data-act="unpick">Change</button></div>` : "";
          findBox.hidden = !!chosen;
          if (chosen) hits.innerHTML = "";
        };
        const search = () => {
          clearTimeout(timer);
          const q = f.q.value;
          if (q.trim().length < 2) { hits.innerHTML = ""; return; }
          const my = ++seq;
          timer = setTimeout(async () => {
            try { found = await searchPatients(q); } catch (ex) { console.warn(ex); found = []; }
            if (my !== seq || !d2.open) return;
            hits.innerHTML = found.length ? found.map((x, i) => `<button type="button" class="ef-hit" data-hit="${i}">
              <strong>${esc(x.name)}</strong><small>${esc([x.dob && `DOB ${x.dob}`, x.email].filter(Boolean).join(" · "))}</small></button>`).join("")
              : '<p class="tb-none">No patients found. Try their last name.</p>';
          }, 250);
        };
        f.q.addEventListener("input", search);
        if (guessName) search();
        if (chosen) showPick();
        if (prefill && prefill.formName && !f.note.value) f.note.value = `Products for: ${prefill.formName}`;

        d2.addEventListener("click", (e) => {
          if (e.target.closest('[data-act="cancel"]')) { d2.close(); return; }
          if (e.target.closest('[data-act="unpick"]')) { chosen = null; showPick(); f.q.focus(); return; }
          const h = e.target.closest("[data-hit]");
          if (h) { chosen = found[Number(h.dataset.hit)] || null; showPick(); }
        });

        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          err.hidden = true;
          if (!chosen) { err.textContent = "Choose the patient."; err.hidden = false; return; }
          if (!f.date.value || f.date.value > today) { err.textContent = "Choose the date it was used. It can't be in the future."; err.hidden = false; return; }
          const lot = !from && p.tracked ? avail[Number(f.lot.value)] : null;
          const btn = form.querySelector('[type="submit"]');
          btn.disabled = true;
          btn.textContent = "Saving…";
          try {
            const r = await recordPaperUse(p, {
              patientId: chosen.id, patientName: chosen.name, date: f.date.value,
              loc: lot ? lot.loc : (f.loc ? f.loc.value : "shelf"), batch: lot ? lot.batch : "", expiry: lot ? lot.expiry : "",
              qty: f.qty ? f.qty.value : 1, dose: f.dose ? f.dose.value : "", note: f.note.value, fromMove: from,
              submissionId: prefill ? prefill.submissionId || "" : "", formName: prefill ? prefill.formName || "" : "",
            }, staff);
            saved = true;
            d2.close();
            const bd = r.backdated || {};
            showToast([
              `Recorded on ${chosen.name}'s usage for ${niceDate(f.date.value)}${from ? ", and the write-off undone" : ""}.`,
              bd.lines ? `${bd.lines} count line${bd.lines === 1 ? "" : "s"} corrected${bd.closed ? `, ${bd.closed} investigation${bd.closed === 1 ? "" : "s"} closed` : ""}.` : "",
              bd.skipped && bd.skipped.length ? `Already accepted, so not changed: ${bd.skipped.join(", ")}.` : "",
            ].filter(Boolean).join(" "));
          } catch (ex) {
            console.error("Paper use failed:", ex);
            err.textContent = errText(ex, "Couldn't save. Try again.");
            err.hidden = false;
            btn.disabled = false;
            btn.textContent = from ? "Move to their record" : "Record it";
          }
        });
        d2.addEventListener("close", () => { clearTimeout(timer); resolve(saved); });
        f.q.focus();
      });
    }

// Reporting → Treatment check: "Record <product>" on a visit whose record has no product. Opens Used on a patient, pre-filled.
export async function openPaperUse({ productId, patientId, patientName, date, submissionId = "", formName = "", staff = null }) {
  const [products, lots] = await Promise.all([listProducts(), listAllLots()]);
  const p = products.find((x) => x.id === productId);
  if (!p) throw new Error("That product isn't on the product list any more.");
  if (isKitProduct(p) || isSharedProduct(p)) throw new Error(`${p.name} is used from a kit or an opened container, so it's recorded there, not here.`);
  uiStaff = staff;
  return paperUseDialogFor(p, lots.filter((l) => l.productId === p.id).sort(fefo), staff, null,
    { patientId, patientName, date, submissionId, formName });
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
    stock: canView, kits: showKits, investigations: showInv, billing: showInv, requests: canRequest || canMove, receive: canReceive,
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
    reqFilter: "open", reqView: "list", pos: [], poFilter: "sent", lineSup: {},
    sel: new Set(), pq: "", pcat: "", psup: "",  pcount: "",
    counts: [], invs: [], lastCounts: new Map(), open: [], bases: new Map(),
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
      [st.products, st.suppliers, st.lots, st.requests, st.pos, st.counts, st.invs, st.open, st.bases] = await Promise.all([
        listProducts(), listSuppliers(), listAllLots(), listRequests({ max: 300 }).catch(() => []), listPos().catch(() => []),
        listCounts({ from: dayKey(new Date(Date.now() - 120 * 864e5)) }).catch(() => []),
        listInvestigations({ open: true }).catch(() => []),
        listOpenContainers().catch(() => []),
        listBaseCounts().catch((err) => { console.warn("Base counts not loaded:", err); return new Map(); }),
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
    else if (tab === "kits") renderKitsTab();
    else if (tab === "investigations") renderInvestigations(body, { staff });
    else if (tab === "billing") renderBillingCheck(body, { staff });
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
  /* ---------- Kits (admins: set an injector's kit) ---------- */
  function renderKitsTab() {
    const opts = { staff, products: st.products, lots: st.lots, canKit, canJt, canManage, reload: load };
    if (!canManage) { renderKits(body, opts); return; }
    body.innerHTML = `
      <div class="inv-tools kit-admin-bar">
        <p class="muted">Moving someone over from the old app, or their kit is wrong? Set it to what they physically have.</p>
        <span class="inv-spacer"></span>
        <button type="button" class="ff-btn" data-act="kit-from-shelf">Already in a kit, still on the Shelf</button>
        <button type="button" class="ff-btn is-primary" data-act="set-kit">Set an injector's kit</button>
      </div>
      <div data-role="kits"></div>`;
    renderKits(body.querySelector('[data-role="kits"]'), opts);
  }

  // Injectors from the staff list, their kit records, and anyone who counted a kit in the last 30 days
  // mode "set": Set an injector's kit · "shelf": already in a kit, still on the Shelf
  async function openSetKit(uid = "", mode = "set") {
    const act = mode === "shelf" ? "kit-from-shelf" : "set-kit";
    const label = mode === "shelf" ? "Already in a kit, still on the Shelf" : "Set an injector's kit";
    const btn = body.querySelector(`[data-act="${act}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    try {
      const [kits, staffList, days] = await Promise.all([
        listKits(),
        fetchStaffList().catch(() => []),
        listKitDays(new Date(Date.now() - 30 * 864e5), new Date(Date.now() + 864e5)).catch(() => []),
      ]);
      const counted = days.filter((d) => (d.start && d.start.items.length) || (d.end && d.end.items.length));
      const people = new Map();
      const add = (id, name) => { if (id && !people.has(id)) people.set(id, { uid: String(id), name: String(name || "Unnamed") }); };
      staffList.forEach((s) => { if (s.injector === true || s.carriesKit === true) add(s.id || s.uid, s.name); });
      kits.forEach((k) => add(k.staffUid, k.staffName));
      counted.forEach((d) => add(d.staffUid, d.staffName));
      const injectors = [...people.values()].sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
      if (mode === "shelf") await openKitFromShelfDialog({ staff, injectors, products: st.products, kits, uid, onSaved: load });
      else openSetKitDialog({ staff, injectors, products: st.products, kits, days: counted, uid, onSaved: load });
    } catch (err) {
      console.error("Kit window failed to open:", err);
      showToast(errText(err, "Couldn't load the kits. Try again."));
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
    }
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
        ${canManage && st.bases.size ? `<button type="button" class="ff-btn" data-act="base-all">Check against base counts</button>` : ""}
        ${canManage ? `<button type="button" class="ff-btn" data-act="invoice-links">Invoice links</button>
          <button type="button" class="ff-btn" data-act="export-products">Export CSV</button>
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
        <button type="button" class="lh-btn" data-bulk="rebuild">Base count &amp; rebuild</button>
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
          <small>${esc([packText(p), suppliersText(p) || "No supplier yet", p.supplierCode && `Code ${p.supplierCode}`, countText(p),
            st.bases.has(p.id) && `Base count ${niceDate(st.bases.get(p.id).dateKey)}`].filter(Boolean).join(" · "))}</small></span></span>
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
    if (kind === "rebuild") { rebuildDialog(list, many); return; }
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

  // Rebuild from a count: what was there on a day, plus everything since = what should be there now
  // Base counts and rebuilding. Type what was there on a day: save it as the base count, or work out what should be there now.
  // fromBases: start from each product's saved base count instead.
  function rebuildDialog(list, many, { fromBases = false } = {}) {
    const today = dayKey();
    const bases = st.bases || new Map();
    const shared = [...new Set(list.map((p) => (bases.get(p.id) || {}).dateKey).filter(Boolean))];
    let fromKey = shared.length === 1 ? shared[0] : `${today.slice(0, 4)}-01-01`;
    const typed = new Map();          // "productId|loc" → what's typed
    const auto = new Set();           // boxes filled in for the chosen date (cleared when the date changes)
    let plan = null, busy = false, prefilled = "", lastPast = true;
    const dlg = openDialog("inv-dlg inv-spdlg inv-rbdlg", '<div class="lh-form" data-role="rb"></div>');
    const box = dlg.querySelector('[data-role="rb"]');
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    const sgn = (v) => (v > 0 ? `+${fmtN(v)}` : v < 0 ? `−${fmtN(-v)}` : "0");
    const fetchRows = async (from) => {
      const res = await callApi({ action: "inventory", op: "invoiceLines", from, to: today });
      if (res.problem) throw new Error(res.problem);
      return res.rows || [];
    };

    // Empty boxes are filled from a base count saved for that day, then from an opening count that day
    async function prefill() {
      let fromBase = 0, fromCount = 0;
      list.forEach((p) => {
        const b = bases.get(p.id);
        if (!b || b.dateKey !== fromKey) return;
        LOCATIONS.forEach((l) => {
          const k = `${p.id}|${l.key}`;
          if (b[l.key] !== null && !typed.get(k)) { typed.set(k, String(b[l.key])); auto.add(k); fromBase++; }
        });
      });
      try {
        const counts = (await listCountsOn(fromKey)).filter((c) => c.kind === "opening")
          .sort((a, b) => (a.at ? a.at.getTime() : 0) - (b.at ? b.at.getTime() : 0));
        const byRef = new Map();
        counts.forEach((c) => c.lines.forEach((l) => { if (l.loc !== "kit") byRef.set(l.ref, l); }));   // the latest count of each spot
        const sum = new Map();
        byRef.forEach((l) => { const k = `${l.productId}|${l.loc}`; sum.set(k, (sum.get(k) || 0) + (Number(l.counted) || 0)); });
        list.forEach((p) => LOCATIONS.forEach((l) => {
          const k = `${p.id}|${l.key}`;
          if (sum.has(k) && !typed.get(k)) { typed.set(k, String(sum.get(k))); auto.add(k); fromCount++; }
        }));
      } catch (err) { console.warn("Opening count not read:", err); }
      const bits = [fromBase && `${plural(fromBase, "box")} from the saved base count`,
        fromCount && `${plural(fromCount, "box")} from the opening count on ${niceDate(fromKey)}`].filter(Boolean);
      prefilled = bits.length ? `Filled in ${bits.join(" and ")}. Check them.` : "";
      if (!plan) drawAsk();
    }

    function drawAsk(errMsg = "") {
      box.innerHTML = `
        <div class="lh-dialog-head"><h3>Base count: ${esc(many)}</h3>
          <p>Type what was physically there on a day you know, like a stocktake or the start of the year. Save it as each product's
            <strong>base count</strong> (stock doesn't change), or work out what should be there now: the base count, plus deliveries,
            Timely invoices, treatments, write-offs and returns since.</p></div>
        <label class="lh-field"><span class="lh-label">Counted on</span>
          <input type="date" name="from" value="${fromKey}" max="${today}" />
          <small class="fe-note"><strong>${esc(niceDate(fromKey))}</strong> (at the start of that day)</small></label>
        ${prefilled ? `<p class="inv-hint">${esc(prefilled)}</p>` : ""}
        <div class="inv-sp-list">${list.map((p) => {
          const b = bases.get(p.id);
          return `<div class="inv-sp">
          <div class="inv-sp-name"><strong>${esc(p.name)}</strong><small>${esc(unitPlural(p.stockUnit))}${p.tracked ? " · batch &amp; expiry" : ""}${
            b ? ` · base count ${esc(niceDate(b.dateKey))}` : ""}</small></div>
          <div class="inv-sp-locs">${LOCATIONS.map((l) => `<label class="inv-sp-loc"><span>${esc(l.label)}<small>on that day</small></span>
            <input class="fe-input inv-num" type="number" min="0" step="1" inputmode="numeric" placeholder="—"
              data-rb="${esc(p.id)}|${l.key}" value="${esc(typed.get(`${p.id}|${l.key}`) || "")}" /></label>`).join("")}</div></div>`;
        }).join("")}</div>
        <label class="fe-check"><input type="checkbox" name="past" checked /> Add deliveries recorded as “received before the portal”</label>
        <small class="fe-note">Leave a box empty to leave that place out. Enter moves to the next box.</small>
        <p class="lh-error" role="alert"${errMsg ? "" : " hidden"}>${esc(errMsg)}</p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="button" class="lh-btn" data-act="savebase">Save as base count only</button>
          <button type="button" class="lh-btn is-primary" data-act="work">Work out what should be there now</button>
        </div>`;
    }

    function drawPlan(cfg) {
      const head = `<thead><tr><th>Where</th><th>Counted</th><th>Delivered</th><th>Sold</th><th>Used</th><th>Written off</th>
        <th>Other</th><th>Should be now</th><th>Digital now</th><th>Change</th></tr></thead>`;
      const card = (r, i) => {
        const any = Object.values(r.locs).some((x) => x.change);
        return `<section class="inv-rb">
          <div class="inv-rb-top">
            <label class="fe-check inv-rb-pick"><input type="checkbox" data-pick-rb="${i}"${any && !r.p.tracked ? " checked" : ""}${r.p.tracked ? " disabled" : ""} />
              <strong>${esc(r.p.name)}</strong> <small class="muted">· counted ${esc(niceDate(r.fromKey))}</small>${
              !any ? ' <span class="inv-flag is-info">Already right</span>' : ""}</label>
            <button type="button" class="lh-btn is-quiet" data-ledger="${i}">Day by day</button>
          </div>
          <table class="inv-table inv-rb-table">${head}<tbody>${Object.entries(r.locs).map(([loc, x]) => `<tr>
            <td>${esc(locLabel(loc))}</td><td>${x.start}</td><td>${sgn(x.received + x.pastIn)}${x.pastIn ? `<small> (${x.pastIn} before the portal)</small>` : ""}</td>
            <td>${sgn(x.sold + x.unapplied)}${x.unapplied ? `<small> (${-x.unapplied} not taken off yet)</small>` : ""}</td>
            <td>${sgn(x.used)}</td><td>${sgn(x.wasted)}</td><td>${sgn(x.other)}</td>
            <td><strong>${x.expected}</strong>${x.raw < 0 ? ' <small class="rp-neg">(came to less than 0)</small>' : ""}</td>
            <td>${x.now}</td><td><span class="inv-rb-chg is-${x.change < 0 ? "neg" : x.change > 0 ? "pos" : "zero"}">${sgn(x.change)}</span></td></tr>`).join("")}
          </tbody></table>
          ${r.p.tracked ? `<small class="fe-note">Batch &amp; expiry product: open it and use <strong>Count</strong> to set each batch to these totals.</small>` : ""}
          ${whyHtml(r)}
        </section>`;
      };
      const off = plan.rows.filter((r) => Object.values(r.locs).some((x) => x.change)).length;
      box.innerHTML = `
        <div class="lh-dialog-head"><h3>What should be there now</h3>
          <p>${plan.fromBases ? "From each product's base count" : `From what was counted on ${esc(niceDate(plan.fromKey))}`}, plus everything since.
            ${off ? `<strong>${plural(off, "product")}</strong> ${off === 1 ? "is" : "are"} off.` : "Everything matches. 👍"}
            Tick the ones to set digital to “Should be now”.</p></div>
        ${unlinkedHtml()}
        <div class="inv-rb-list">${plan.rows.map(card).join("") || '<p class="tb-none">Nothing to check.</p>'}</div>
        ${!cfg.startDate ? `<label class="fe-check"><input type="checkbox" name="setStart" checked />
          From now on, take invoice sales off stock automatically (sets the invoice start date to ${esc(niceDate(plan.fromKey))})</label>` : ""}
        <small class="fe-note">Do it when nothing's being sold or used, as stock that moves while you're looking at this isn't included.
          Invoice sales counted here are marked as already taken off, so an upload never takes them off twice.</small>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          ${plan.fromBases ? '<button type="button" class="lh-btn is-quiet" data-act="cancel">Close</button>'
            : '<button type="button" class="lh-btn is-quiet" data-act="back">← Change the counts</button>'}
          <button type="button" class="lh-btn is-primary" data-act="apply">Set digital</button>
        </div>`;
    }
        // Why digital isn't "should be": the parts always add up to the difference
    function whyHtml(r) {
      return Object.entries(r.locs).filter(([, x]) => x.change).map(([loc, x]) => {
        const parts = [];
        const d0 = x.digitalStart - x.start;
        if (d0) parts.push(`Digital was <b>${fmtN(x.digitalStart)}</b> at the start of ${esc(niceDate(r.fromKey))}, but ${fmtN(x.start)} were counted <b>(${sgn(d0)})</b>`);
        if (x.fix) parts.push(`<b>${sgn(x.fix)}</b> from corrections to digital since then: ${esc(x.fixes.slice(-4).map((f) =>
          `${f.label} ${sgn(f.n)} on ${niceDate(f.day)}${f.by ? ` by ${f.by}` : ""}${f.reason ? ` (${f.reason})` : ""}`).join("; "))}${x.fixes.length > 4 ? "…" : ""}`);
        if (x.early) parts.push(`<b>${sgn(x.early)}</b> entered since then for something that happened before that day`);
        if (x.unapplied) parts.push(`<b>${sgn(-x.unapplied)}</b>: ${plural(-x.unapplied, "invoice sale")} not taken off digital yet`);
        if (x.kept) parts.push(`<b>${sgn(-x.kept)}</b>: invoice sales counted by an earlier rebuild`);
        if (x.pastIn) parts.push(`<b>${sgn(-x.pastIn)}</b>: delivered before the portal, never added to digital`);
        if (x.raw < 0) parts.push(`Should be came to ${fmtN(x.raw)}, so it's shown as 0`);
        return `<div class="inv-rb-why"><strong>Why digital (${fmtN(x.now)}) isn't ${fmtN(x.expected)} in ${esc(locLabel(loc))}:</strong>
          <ul>${parts.map((t) => `<li>${t}</li>`).join("")}</ul></div>`;
      }).join("");
    }

        // Invoice names that aren't linked: the ones that look like these products first, each with a Link button
    function unlinkedHtml() {
      if (!plan.unlinked.length) return "";
      const mine = new Set(list.map((p) => p.id));
      plan.sugg = suggestInvoiceLinks(plan.unlinked, st.products);
      const near = plan.sugg.map((u, i) => ({ ...u, i }))
        .filter((u) => (u.product && mine.has(u.product.id)) || u.candidates.some((c) => mine.has(c.id)));
      const rest = plan.sugg.filter((u) => !near.some((x) => x.name === u.name));
      const pick = (u) => (u.product
        ? `<strong>${esc(u.product.name)}</strong>`
        : `<select class="fb-select" data-linkpick="${u.i}">${u.candidates.map((c) =>
            `<option value="${esc(c.id)}"${mine.has(c.id) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`);
      return `<div class="inv-hint is-warn">
        ${near.length ? `<strong>${plural(near.length, "invoice name")} look${near.length === 1 ? "s" : ""} like ${list.length === 1 ? "this product" : "these products"}
          but ${near.length === 1 ? "isn't" : "aren't"} linked</strong>, so ${near.length === 1 ? "its" : "their"} sales aren't counted:
          <div class="inv-rb-links">${near.map((u) => `<div class="inv-rb-link">
            <span>“${esc(u.name)}” <small>(${plural(u.n, "sale")})</small> → ${pick(u)}</span>
            <button type="button" class="lh-btn" data-link="${u.i}">Link</button></div>`).join("")}</div>
          ${near.length > 1 ? '<button type="button" class="lh-btn is-primary" data-act="link-all">Link all of these</button>' : ""}` : ""}
        ${rest.length ? `<details class="inv-rb-more"${near.length ? "" : " open"}><summary>${plural(rest.length, "other invoice name")} not linked</summary>
          <p>${esc(rest.slice(0, 30).map((u) => `${u.name} (${u.n})${u.product ? ` → ${u.product.name}?` : ""}`).join(", "))}${rest.length > 30 ? "…" : ""}.
          Link them in <strong>Products → Invoice links</strong> if they're stock products.</p></details>` : ""}
        <small>Linking also means future invoice uploads take that product off the Shelf.</small></div>`;
    }

    async function linkNames(pairs, btn) {
      if (!pairs.length) return;
      busy = true;
      if (btn) { btn.disabled = true; btn.textContent = "Linking…"; }
      try {
        const cur = await getInvoiceSettings();
        const keys = new Set(pairs.map((x) => invoiceNameKey(x.name)));
        await saveInvoiceSettings({
          startDate: cur.startDate,
          links: [...cur.links.filter((l) => !keys.has(invoiceNameKey(l.name))), ...pairs],
        }, staff);
        showToast(`Linked ${plural(pairs.length, "invoice name")}. Checking again…`);
      } catch (ex) {
        console.error("Link failed:", ex);
        showToast(errText(ex, "Couldn't save the link. Try again."));
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = "Link"; }
        return;
      }
      busy = false;
      if (plan.fromBases) workBases(); else work(null);
    }

    const linkPair = (i) => {
      const u = plan.sugg && plan.sugg[i];
      if (!u) return null;
      const sel = box.querySelector(`[data-linkpick="${i}"]`);
      const productId = sel ? sel.value : u.product ? u.product.id : "";
      return productId ? { name: u.name, productId } : null;
    };

    function readCounted() {
      const counted = new Map();
      for (const p of list) {
        const c = { shelf: null, jt: null };
        for (const l of LOCATIONS) {
          const v = (typed.get(`${p.id}|${l.key}`) || "").trim();
          if (v === "") continue;
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0) throw new Error(`${p.name}: enter a whole number of 0 or more.`);
          c[l.key] = n;
        }
        if (c.shelf !== null || c.jt !== null) counted.set(p.id, c);
      }
      if (!counted.size) throw new Error("Type what was there on that day for at least one product.");
      return counted;
    }

    async function saveBases(btn) {
      let counted;
      try { counted = readCounted(); } catch (ex) { drawAsk(ex.message); return; }
      busy = true;
      btn.disabled = true;
      const queue = list.filter((p) => counted.has(p.id));
      const total = queue.length;
      let done = 0;
      const failed = [];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const p = queue.shift();
          try { await saveBaseCount(p, { dateKey: fromKey, ...counted.get(p.id) }, staff); }
          catch (ex) { console.error("Base count failed:", p.name, ex); failed.push(p.name); }
          btn.textContent = `Saving ${++done} of ${total}…`;
        }
      }));
      busy = false;
      if (failed.length) { drawAsk(`Couldn't save: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}. Try again.`); return; }
      dlg.close();
      showToast(`Base count saved for ${plural(total, "product")} (${niceDate(fromKey)}). Stock wasn't changed.`);
      await load();
    }

    async function work(btn) {
      let counted;
      try { counted = readCounted(); } catch (ex) { drawAsk(ex.message); return; }
      const pastEl = box.querySelector('[name="past"]');
      const past = pastEl ? pastEl.checked : lastPast;
      lastPast = past;
      busy = true;
      if (btn) { btn.disabled = true; btn.textContent = "Adding it all up…"; }
      else box.querySelector(".inv-rb-list").innerHTML = '<div class="skeleton" style="height:160px;border-radius:12px"></div>';
      try {
        const [p2, cfg] = await Promise.all([
          fetchRows(fromKey).then((rows) => rebuildPlan({ fromKey, products: list, allProducts: st.products, counted, pos: st.pos, invoiceRows: rows, includePast: past })),
          getInvoiceSettings(),
        ]);
        plan = p2;
        drawPlan(cfg);
      } catch (ex) {
        console.error("Rebuild failed:", ex);
        drawAsk(errText(ex, "Couldn't work it out. Try again."));
      } finally { busy = false; }
    }

    async function workBases() {
      box.innerHTML = `<div class="lh-dialog-head"><h3>Checking against base counts…</h3>
        <p>Adding up everything since each product's base count.</p></div><div class="skeleton" style="height:220px;border-radius:12px"></div>`;
      busy = true;
      try {
        const [p2, cfg] = await Promise.all([
          planFromBases({ products: list, allProducts: st.products, pos: st.pos, bases, fetchInvoiceRows: fetchRows }),
          getInvoiceSettings(),
        ]);
        plan = { ...p2, fromBases: true };
        drawPlan(cfg);
      } catch (ex) {
        console.error("Base check failed:", ex);
        box.innerHTML = `<div class="tm-empty is-error">${esc(errText(ex, "Couldn't check them. Try again."))}</div>
          <div class="lh-actions"><button type="button" class="lh-btn" data-act="cancel">Close</button></div>`;
      } finally { busy = false; }
    }

    async function apply(btn) {
      const picked = [...box.querySelectorAll("[data-pick-rb]:checked")].map((cb) => plan.rows[Number(cb.dataset.pickRb)]);
      const err = box.querySelector(".lh-error");
      const setStart = box.querySelector('[name="setStart"]');
      if (!picked.length && !(setStart && setStart.checked)) { err.textContent = "Tick at least one product."; err.hidden = false; return; }
      busy = true;
      btn.disabled = true;
      let done = 0, places = 0, marked = 0;
      const failed = [];
      const queue = picked.slice();
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const r = queue.shift();
          try {
            const x = await applyRebuild(r, staff, r.fromKey);
            places += x.changed;
            marked += x.marked;
            // A rebuild from a typed count: that count becomes the product's base count
            if (!plan.fromBases) {
              await saveBaseCount(r.p, { dateKey: r.fromKey, shelf: r.locs.shelf ? r.locs.shelf.start : null,
                jt: r.locs.jt ? r.locs.jt.start : null, note: "Used to rebuild digital" }, staff);
            }
          } catch (ex) { console.error("Rebuild apply failed:", r.p.name, ex); failed.push(r.p.name); }
          btn.textContent = `Saving ${++done} of ${picked.length}…`;
        }
      }));
      if (setStart && setStart.checked) {
        try {
          const cur = await getInvoiceSettings();
          if (!cur.startDate) await saveInvoiceSettings({ startDate: plan.fromKey, links: cur.links }, staff);
        } catch (ex) { console.error("Invoice start date not saved:", ex); failed.push("the invoice start date"); }
      }
      busy = false;
      dlg.close();
      showToast(failed.length
        ? `Saved, except: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}. Try those again.`
        : `Digital set: ${plural(places, "change")} across ${plural(picked.length, "product")}${marked ? `, ${plural(marked, "invoice sale")} marked as counted` : ""}.`);
      st.sel.clear();
      await load();
    }

    box.addEventListener("input", (e) => {
      if (e.target.dataset.rb) { typed.set(e.target.dataset.rb, e.target.value); auto.delete(e.target.dataset.rb); }
      if (e.target.name === "from" && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && e.target.value <= today) {
        fromKey = e.target.value;
        auto.forEach((k) => typed.delete(k));   // numbers you typed yourself stay
        auto.clear();
        prefill();
      }
    });
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.dataset.rb) return;
      e.preventDefault();
      const all = [...box.querySelectorAll("[data-rb]")];
      const next = all[all.indexOf(e.target) + 1];
      if (next) { next.focus(); next.select(); }
    });
    box.addEventListener("click", (e) => {
      const lk = e.target.closest("[data-link]");
      if (lk && plan && !busy) { const pr = linkPair(Number(lk.dataset.link)); if (pr) linkNames([pr], lk); return; }
      if (e.target.closest('[data-act="link-all"]') && plan && !busy) {
        const btns = [...box.querySelectorAll("[data-link]")];
        linkNames(btns.map((b) => linkPair(Number(b.dataset.link))).filter(Boolean), e.target.closest('[data-act="link-all"]'));
        return;
      }
      const lg = e.target.closest("[data-ledger]");
      if (lg && plan) {
        const r = plan.rows[Number(lg.dataset.ledger)];
        if (r) ledgerDialog(r.p, { fromKey: r.fromKey, start: {
          shelf: r.locs.shelf ? r.locs.shelf.start : null, jt: r.locs.jt ? r.locs.jt.start : null } });
        return;
      }
      const a = e.target.closest("[data-act]");
      if (!a || busy) return;
      if (a.dataset.act === "cancel") dlg.close();
      else if (a.dataset.act === "savebase") saveBases(a);
      else if (a.dataset.act === "work") work(a);
      else if (a.dataset.act === "back") { plan = null; drawAsk(); }
      else if (a.dataset.act === "apply") apply(a);
    });

    if (fromBases) workBases();
    else { drawAsk(); prefill(); }
  }

  // Day by day: one product from a starting point to today. Where did it stop matching?
  // start: { shelf, jt } typed or from a rebuild (otherwise the base count, or digital that day)
  function ledgerDialog(p, { fromKey: fk = "", start = null } = {}) {
    const today = dayKey();
    const base = st.bases.get(p.id) || null;
    const s = {
      fromKey: fk || (base ? base.dateKey : dayKey(new Date(Date.now() - 30 * 864e5))),
      source: start ? "given" : base ? "base" : "digital",
      loc: p.stock.jt > 0 && !p.stock.shelf ? "jt" : "shelf",
      quiet: false, open: new Set(), data: null, busy: false, err: "",
    };
    let givenKey = s.fromKey;
    const rowsCache = new Map();
    const dlg = openDialog("inv-dlg inv-lgdlg", '<div class="lh-form" data-role="lg"></div>');
    const box = dlg.querySelector('[data-role="lg"]');
    const sgn = (v) => (v > 0 ? `+${fmtN(v)}` : v < 0 ? `−${fmtN(-v)}` : "");
    const dayLabel = (k) => { const [y, m, d] = k.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }); };
    const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");

    const startFor = () => (s.source === "given" ? start
      : s.source === "base" && base && base.dateKey === s.fromKey ? { shelf: base.shelf, jt: base.jt } : null);

    async function run() {
      s.busy = true; s.err = ""; draw();
      try {
        if (!rowsCache.has(s.fromKey)) {
          const res = await callApi({ action: "inventory", op: "invoiceLines", from: s.fromKey, to: today });
          if (res.problem) throw new Error(res.problem);
          rowsCache.set(s.fromKey, res.rows || []);
        }
        s.data = await productLedger({ product: p, fromKey: s.fromKey, start: startFor(), invoiceRows: rowsCache.get(s.fromKey),
          allProducts: st.products, pos: st.pos });
      } catch (ex) {
        console.error("Day by day failed:", ex);
        s.err = errText(ex, "Couldn't work it out. Try again.");
        s.data = null;
      }
      s.busy = false;
      draw();
    }

    function eventsHtml(x, loc) {
      const L = x.locs[loc];
      const list = x.events.filter((e) => e.lines.some((l) => l.loc === loc));
      const items = list.map((e) => {
        const n = e.lines.filter((l) => l.loc === loc).reduce((a, l) => a + l.delta, 0);
        return { at: e.at, html: `<li class="is-${e.kind}"><span class="inv-lg-t">${esc(timeOf(e.at)) || "—"}</span>
          <span><strong>${esc(e.label)}</strong> <b class="inv-lg-n ${n < 0 ? "is-neg" : "is-pos"}">${sgn(n) || "0"}</b>${
            e.kind === "fix" ? ' <span class="inv-flag">Digital corrected</span>' : ""}${
            e.kind === "unsold" ? ' <span class="inv-flag is-warn">Not taken off stock yet</span>' : ""}${
            e.undone ? ' <span class="inv-flag">Undone</span>' : ""}${
            e.entered ? ` <span class="inv-flag is-info">Entered ${esc(niceDate(e.entered))}</span>` : ""}
            <small>${esc([e.note, e.by].filter(Boolean).join(" · "))}</small></span></li>` };
      });
      const c = L.count;
      if (c) {
        const i = items.findIndex((it) => !it.at || it.at > c.at);
        items.splice(i < 0 ? items.length : i, 0, { html: `<li class="is-count"><span class="inv-lg-t">${esc(timeOf(c.at))}</span>
          <span><strong>Opening count${c.by ? ` by ${esc(c.by)}` : ""}: ${c.counted}</strong>
          <small>Should have been ${fmtN(c.expected)} at that moment · digital said ${c.system}${
            c.diff ? ` · <b class="${c.diff < 0 ? "rp-neg" : ""}">${sgn(c.diff)}</b>` : " · matched"}</small></span></li>` });
      }
      return items.length ? `<ul class="inv-lg-ev">${items.map((it) => it.html).join("")}</ul>` : '<p class="tb-none">Nothing happened this day.</p>';
    }

    function draw() {
      const loc = s.loc;
      const baseOk = base && base.dateKey === s.fromKey;
      const srcItems = [
        ...(s.source === "given" && s.fromKey === givenKey ? [["given", "A count"]] : []),
        ...(baseOk ? [["base", "Base count"]] : []),
        ["digital", "Digital that day"],
      ];
      const head = `
        <div class="inv-pd-head"><div><h3>Day by day: ${esc(p.name)}</h3>
          <p class="muted">What should have been there each day, next to digital and the opening counts. Click a day to see what happened.</p></div>
          <button type="button" class="ib-tool" data-act="close" aria-label="Close" title="Close">×</button></div>
        <div class="inv-tools inv-lg-tools">
          <label class="lh-field"><span class="lh-label">From</span><input type="date" name="from" value="${s.fromKey}" max="${today}" />
            <small class="fe-note">${esc(niceDate(s.fromKey))}</small></label>
          <div class="lh-field"><span class="lh-label">Start from</span>${seg("lg-src", srcItems, s.source)}</div>
          <div class="lh-field"><span class="lh-label">Where</span>${seg("lg-loc", LOCATIONS.map((l) => [l.key, l.label]), loc)}</div>
          <label class="fe-check"><input type="checkbox" name="quiet"${s.quiet ? " checked" : ""} /> Show quiet days</label>
        </div>
        ${base && !baseOk ? `<p class="inv-hint">This product's base count is on ${esc(niceDate(base.dateKey))}.
          <button type="button" class="rc-link" data-act="use-base">Start from it</button></p>` : ""}`;

      if (s.busy) { box.innerHTML = `${head}<div class="skeleton" style="height:300px;border-radius:12px"></div>`; return; }
      if (s.err || !s.data) { box.innerHTML = `${head}<div class="tm-empty is-error">${esc(s.err || "Nothing to show.")}</div>`; return; }

      const d = s.data;
      const tot = (k) => d.days.reduce((a, x) => a + x.locs[loc][k], 0);
      const last = d.days[d.days.length - 1].locs[loc];
      const unsoldN = -tot("unsold");
      const diffs = d.days.filter((x) => x.locs[loc].count && x.locs[loc].count.diff);
      const counted = d.days.filter((x) => x.locs[loc].count).length;
      const gap = last.digital - last.end;
      const first = diffs[0] || null;
      const fc = first ? first.locs[loc].count : null;

      // Movement columns only when something happened in them
      const has = (k) => d.days.some((x) => (k === "sold" ? x.locs[loc].sold + x.locs[loc].unsold : x.locs[loc][k]));
      const cols = [["received", "In"], ["sold", "Sold"], ["used", "Used"], ["wasted", "Written off"], ["other", "Other"]].filter(([k]) => has(k));
      const span = 6 + cols.length;
      const cell = (L, k) => (k === "sold"
        ? `${sgn(L.sold + L.unsold)}${L.unsold ? '<small title="Not taken off stock yet">*</small>' : ""}` : sgn(L[k]));

      // Quiet days are folded away (the first and last day always show)
      let skipped = 0;
      const rows = [];
      const flush = () => { if (skipped) rows.push(`<tr class="inv-lg-gap"><td colspan="${span}">${plural(skipped, "quiet day")}</td></tr>`); skipped = 0; };
      d.days.forEach((x, i) => {
        const L = x.locs[loc];
        if (!s.quiet && L.quiet && i && i !== d.days.length - 1) { skipped++; return; }
        flush();
        const c = L.count;
        const isOpen = s.open.has(x.key);
        rows.push(`<tr class="inv-lg-row${c && c.diff ? " is-diff" : ""}${isOpen ? " is-open" : ""}" data-day="${x.key}">
          <td>${esc(dayLabel(x.key))}</td><td>${fmtN(L.start)}</td>
          ${cols.map(([k]) => `<td>${cell(L, k)}</td>`).join("")}
          <td><strong>${fmtN(L.end)}</strong></td>
          <td class="${L.digital !== L.end ? "is-off" : ""}">${fmtN(L.digital)}${L.fix ? ` <small>(${sgn(L.fix)} fixed)</small>` : ""}</td>
          <td>${c ? c.counted : ""}</td>
          <td>${c ? `<span class="inv-rb-chg is-${c.diff < 0 ? "neg" : c.diff > 0 ? "pos" : "zero"}">${c.diff ? sgn(c.diff) : "✓"}</span>` : ""}</td></tr>
          ${isOpen ? `<tr class="inv-lg-detail"><td colspan="${span}">${eventsHtml(x, loc)}</td></tr>` : ""}`);
      });
      flush();

      const pill = (label, v, cls = "") => `<span class="inv-lg-pill ${cls}"><b>${esc(String(v))}</b> ${esc(label)}</span>`;
      box.innerHTML = `${head}
        <div class="inv-lg-sum">
          ${pill(d.source[loc] === "counted" ? "counted at the start" : "digital at the start", fmtN(d.startAt[loc]))}
          ${pill("delivered", sgn(tot("received")) || "0")}
          ${pill(unsoldN ? `sold (${unsoldN} not off stock)` : "sold", sgn(tot("sold") + tot("unsold")) || "0")}
          ${tot("used") ? pill("used", sgn(tot("used"))) : ""}
          ${tot("wasted") ? pill("written off", sgn(tot("wasted"))) : ""}
          ${tot("other") ? pill("other", sgn(tot("other"))) : ""}
          <span class="inv-lg-eq">=</span>
          ${pill("should be now", fmtN(last.end), "is-strong")}
          ${pill("digital now", fmtN(last.digital), gap ? "is-warn" : "is-strong")}
        </div>
        <p class="inv-hint${diffs.length ? " is-warn" : ""}">${first
          ? `<strong>${plural(diffs.length, "opening count")} didn't match</strong> what should have been there. The first was
             ${esc(dayLabel(first.key))}: counted ${fc.counted}, should have been ${fmtN(fc.expected)} (${sgn(fc.diff)}).
             <button type="button" class="rc-link" data-jump="${first.key}">Show it</button>
             ${s.source === "digital" && d.source[loc] === "digital"
               ? ` · If digital was wrong from the start, <button type="button" class="rc-link" data-act="from-count" data-day="${first.key}">start from this count instead</button>.` : ""}`
          : counted ? "Every opening count in this period matched what should have been there. 👍" : "No opening counts in this period."}
          ${gap ? ` Digital is ${sgn(gap)} against what should be there now.` : ""}</p>
        <div class="inv-lg-scroll"><table class="inv-table inv-lg-table">
          <thead><tr><th>Day</th><th>Start</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join("")}
            <th>Should be</th><th>Digital</th><th>Counted</th><th>Difference</th></tr></thead>
          <tbody>${rows.join("")}</tbody></table></div>
        <small class="fe-note">Start is the start of the day. Difference compares the opening count with what should have been there when it was counted.
          Corrections (counts, starting stock, investigations) change Digital but not Should be.${unsoldN ? " * includes invoice sales not taken off stock yet." : ""}</small>`;
    }
    box.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="close"]')) { dlg.close(); return; }
      if (s.busy) return;
      if (e.target.closest('[data-act="use-base"]')) { s.fromKey = base.dateKey; s.source = "base"; run(); return; }
      const fcBtn = e.target.closest('[data-act="from-count"]');
      if (fcBtn && s.data) {
        // That morning's count, less anything that moved before it, is what was there at the start of that day
        const x = s.data.days.find((dd) => dd.key === fcBtn.dataset.day);
        const c = x && x.locs[s.loc].count;
        if (!c) return;
        start = { shelf: null, jt: null, [s.loc]: Math.max(0, c.counted - (c.before || 0)) };
        s.fromKey = x.key;
        givenKey = x.key;
        s.source = "given";
        s.open.clear();
        run();
        return;
      }
      const j = e.target.closest("[data-jump]");
      if (j) {
        s.open.add(j.dataset.jump);
        draw();
        const row = box.querySelector(`[data-day="${j.dataset.jump}"]`);
        if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const r = e.target.closest("tr[data-day]");
      if (r) { const k = r.dataset.day; if (s.open.has(k)) s.open.delete(k); else s.open.add(k); draw(); }
    });
    box.addEventListener("change", (e) => {
      const t = e.target;
      if (t.name === "from" && /^\d{4}-\d{2}-\d{2}$/.test(t.value) && t.value <= today) {
        s.fromKey = t.value;
        s.source = s.source === "given" && s.fromKey === givenKey ? "given" : base && base.dateKey === s.fromKey ? "base" : "digital";
        s.open.clear();
        run();
      } else if (t.name === "lg-src") { s.source = t.value; run(); }
      else if (t.name === "lg-loc") { s.loc = t.value; s.open.clear(); draw(); }
      else if (t.name === "quiet") { s.quiet = t.checked; draw(); }
    });
    run();
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
        ${hasStock ? `<div class="inv-trk">
          <small class="fe-note" data-role="trknote"></small>
          <button type="button" class="lh-btn" data-act="trk"></button></div>` : ""}
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

    // A product with stock: batch & expiry is switched with its own window, so the stock is converted properly
    const syncTrk = () => {
      const note = dlg.querySelector('[data-role="trknote"]');
      if (!note) return;
      note.textContent = x.tracked
        ? "It has stock. Turning this off adds its batches together into one amount on the Shelf and in JT storage."
        : "It has stock, so turning this on means entering the batch and expiry date of what's there now.";
      dlg.querySelector('[data-act="trk"]').textContent = x.tracked ? "Turn off…" : "Turn on…";
      form.elements.tracked.checked = !!x.tracked;
    };
    syncTrk();
    const trkBtn = dlg.querySelector('[data-act="trk"]');
    if (trkBtn) trkBtn.addEventListener("click", async () => {
      const on = !x.tracked;
      if (await trackingDialog(p, on, form.elements.batchLabel.value.trim())) {
        x.tracked = on;
        syncTrk();
        load();
      }
    });

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

  /* ---------- Batch & expiry on / off for a product that has stock ---------- */
  async function trackingDialog(p, on, labelTyped = "") {
    if (st.invs.some((v) => v.productId === p.id)) {
      showToast(`${p.name} has an open investigation. Close it first, then change this.`);
      return false;
    }
    if (!on) {
      const ok = await confirmDialog({
        title: `Stop tracking batch and expiry for ${p.name}?`,
        message: `Its batches are added together: Shelf ${p.stock.shelf}, JT storage ${p.stock.jt}. ` +
          "Their batch numbers and expiry dates are dropped, and expiry warnings stop. The totals don't change.",
        confirmLabel: "Turn it off", tone: "warning",
      });
      if (!ok) return false;
      try {
        await setTracking(p, false, [], staff);
        showToast("Batch and expiry turned off");
        return true;
      } catch (ex) {
        console.error("Tracking off failed:", ex);
        showToast(errText(ex, "Couldn't change it. Try again."));
        return false;
      }
    }

    const bl = labelTyped || batchName(p);
    const blLow = bl.toLowerCase();
    const locs = LOCATIONS.filter((l) => p.stock[l.key] > 0);
    const row = (qty = "") => `
      <div class="inv-trk-row" data-trkrow>
        <input class="fe-input" data-k="batch" maxlength="40" placeholder="${esc(bl)} number" aria-label="${esc(bl)} number" autocomplete="off" />
        <input class="fe-input" data-k="expiry" type="date" aria-label="Expiry date" />
        <input class="fe-input inv-num" data-k="qty" type="number" min="1" step="1" inputmode="numeric" value="${qty}" aria-label="How many" />
        <button type="button" class="ib-tool is-danger" data-act="trk-rm" aria-label="Remove" title="Remove">×</button>
      </div>`;

    return new Promise((resolve) => {
      let saved = false;
      const dlg = openDialog("inv-dlg", `
        <form class="lh-form" novalidate>
          <div class="lh-dialog-head"><h3>Track ${esc(blLow)} and expiry: ${esc(p.name)}</h3>
            <p>Check the labels of what's there now and enter each ${esc(blLow)} with its expiry date. They need to add up to
              what's in stock, so the totals don't change.</p></div>
          ${locs.map((l) => `
            <section class="inv-trk-sec" data-loc="${l.key}">
              <h4>${esc(l.label)} <small data-role="sum"></small></h4>
              <div class="inv-trk-head"><span>${esc(bl)}</span><span>Expiry</span><span>How many</span><span></span></div>
              <div data-role="rows">${row(p.stock[l.key])}</div>
              <button type="button" class="hx-add" data-act="trk-add">+ Another ${esc(blLow)}</button>
            </section>`).join("")}
          <small class="fe-note">Only a month and year on the box? Use the last day of that month.</small>
          <p class="lh-error" role="alert" hidden></p>
          <div class="lh-actions">
            <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
            <button type="submit" class="lh-btn is-primary">Turn on batch &amp; expiry</button>
          </div>
        </form>`);
      const form = dlg.querySelector("form");
      const err = dlg.querySelector(".lh-error");

      const sync = () => dlg.querySelectorAll(".inv-trk-sec").forEach((sec) => {
        const loc = sec.dataset.loc;
        const typed = [...sec.querySelectorAll('[data-k="qty"]')].reduce((a, el) => a + (parseInt(el.value, 10) || 0), 0);
        const sum = sec.querySelector('[data-role="sum"]');
        sum.textContent = `${typed} of ${plural(p.stock[loc], p.stockUnit)}`;
        sum.className = typed === p.stock[loc] ? "is-ok" : "is-bad";
        const rows = sec.querySelectorAll("[data-trkrow]");
        rows.forEach((r) => { r.querySelector('[data-act="trk-rm"]').hidden = rows.length < 2; });
      });
      sync();
      form.addEventListener("input", sync);

      dlg.addEventListener("click", (e) => {
        if (e.target.closest('[data-act="cancel"]')) { dlg.close(); return; }
        const add = e.target.closest('[data-act="trk-add"]');
        if (add) {
          const sec = add.closest(".inv-trk-sec");
          sec.querySelector('[data-role="rows"]').insertAdjacentHTML("beforeend", row());
          const rows = sec.querySelectorAll("[data-trkrow]");
          rows[rows.length - 1].querySelector('[data-k="batch"]').focus();
          sync();
          return;
        }
        const rm = e.target.closest('[data-act="trk-rm"]');
        if (rm) { rm.closest("[data-trkrow]").remove(); sync(); }
      });

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        err.hidden = true;
        const splits = [];
        try {
          dlg.querySelectorAll(".inv-trk-sec").forEach((sec) => {
            const loc = sec.dataset.loc;
            let total = 0;
            sec.querySelectorAll("[data-trkrow]").forEach((r) => {
              const batch = r.querySelector('[data-k="batch"]').value.trim();
              const exp = r.querySelector('[data-k="expiry"]');
              const qty = parseInt(r.querySelector('[data-k="qty"]').value, 10);
              if (!batch && !exp.value && !qty) return;   // an empty extra row
              if (!batch) throw new Error(`Enter the ${blLow} number for each row.`);
              if (!exp.value) {
                throw new Error(exp.validity && exp.validity.badInput
                  ? "One of the expiry dates doesn't exist. Check the day (e.g. September has 30 days)."
                  : `Enter the expiry date for ${bl} ${batch}.`);
              }
              if (!(qty >= 1)) throw new Error(`Enter how many for ${bl} ${batch}.`);
              total += qty;
              splits.push({ loc, batch, expiry: exp.value, qty });
            });
            if (total !== p.stock[loc]) {
              throw new Error(`${locLabel(loc)}: ${total} entered, but there ${p.stock[loc] === 1 ? "is" : "are"} ${plural(p.stock[loc], p.stockUnit)}. They need to add up.`);
            }
          });
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          return;
        }
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
          await setTracking(p, true, splits, staff);
          saved = true;
          dlg.close();
          showToast(`${p.name} now tracks ${blLow} and expiry`);
        } catch (ex) {
          console.error("Tracking on failed:", ex);
          err.textContent = errText(ex, "Couldn't save. Try again.");
          err.hidden = false;
          btn.disabled = false;
          btn.textContent = "Turn on batch & expiry";
        }
      });
      dlg.addEventListener("close", () => resolve(saved));
      const first = dlg.querySelector('[data-k="batch"]');
      if (first) first.focus();
    });
  }

  // Correct one batch's number or expiry (the quantity stays the same)
  function editLotDialog(p, lot) {
    const bl = batchName(p);
    const other = lotsOf(p.id).find((l) => l.loc !== lot.loc && l.batch === lot.batch && l.expiry === lot.expiry);
    return new Promise((resolve) => {
      let saved = false;
      const d2 = openDialog("inv-dlg", `
        <form class="lh-form" novalidate>
          <div class="lh-dialog-head"><h3>Correct ${esc(bl.toLowerCase())}: ${esc(p.name)}</h3>
            <p>${esc(locLabel(lot.loc))} · ${esc(batchText(p, lot.batch) || "No number")} · Exp ${esc(niceDate(lot.expiry) || "none")} ·
              ${esc(plural(lot.qty, p.stockUnit))}. For a typo or a wrong date: how many stays the same.</p></div>
          <div class="inv-two">
            <label class="lh-field"><span class="lh-label">${esc(bl)} number</span>
              <input name="batch" maxlength="40" value="${esc(lot.batch)}" autocomplete="off" /></label>
            <label class="lh-field"><span class="lh-label">Expiry date</span>
              <input name="expiry" type="date" value="${esc(lot.expiry)}" /></label>
          </div>
          ${other ? `<label class="fe-check"><input type="checkbox" name="both" checked />
            Also correct the ${esc(plural(other.qty, p.stockUnit))} of the same ${esc(bl.toLowerCase())} in ${esc(locLabel(other.loc))}</label>` : ""}
          ${p.usage === "kit" ? `<small class="fe-note">Vials already taken into injectors' kits keep the details they had.</small>` : ""}
          <p class="lh-error" role="alert" hidden></p>
          <div class="lh-actions">
            <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
            <button type="submit" class="lh-btn is-primary">Save</button>
          </div>
        </form>`);
      const form = d2.querySelector("form");
      const err = d2.querySelector(".lh-error");
      d2.querySelector('[data-act="cancel"]').addEventListener("click", () => d2.close());
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        err.hidden = true;
        const f = form.elements;
        if (f.expiry.validity && f.expiry.validity.badInput) {
          err.textContent = "That expiry date doesn't exist. Check the day (e.g. September has 30 days).";
          err.hidden = false;
          return;
        }
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        try {
          await correctLot(p, lot, { batch: f.batch.value, expiry: f.expiry.value, both: !!(f.both && f.both.checked) }, staff);
          saved = true;
          d2.close();
          showToast(`${bl} details corrected`);
        } catch (ex) {
          console.error("Correct batch failed:", ex);
          err.textContent = errText(ex, "Couldn't save. Try again.");
          err.hidden = false;
          btn.disabled = false;
        }
      });
      d2.addEventListener("close", () => resolve(saved));
      form.elements.batch.focus();
      form.elements.batch.select();
    });
  }

  /* ---------- Supplier editor ---------- */
  function editSupplier(s) {
    const isNew = !s;
    const x = s || { active: true };
    const val = (v) => esc(v || "");
    const noFill = 'autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore data-form-type="other"';
    const on = x.active !== false;
    const dlg = openDialog("inv-dlg sup-dlg", `
      <form class="sup-form" novalidate>
        <header class="sup-head">
          <div><h3>${isNew ? "New supplier" : `Edit ${esc(x.name)}`}</h3>
            <p>Purchase orders are emailed to the order email, with the CC copied in.</p></div>
          <label class="sup-active${on ? "" : " is-off"}"><input type="checkbox" name="active"${on ? " checked" : ""} />
            <span class="sup-switch" aria-hidden="true"></span><span data-role="activetxt">${on ? "Active" : "Inactive"}</span></label>
        </header>

        <div class="sup-body">
          <div class="sup-col">
            <section class="sup-sec"><h4>Company</h4>
              <label class="lh-field"><span class="lh-label">Company name</span>
                <input name="company" maxlength="120" ${noFill} value="${val(x.name)}" /></label>
              <div class="sup-two">
                <label class="lh-field"><span class="lh-label">Our account number</span>
                  <input name="accountNo" maxlength="60" ${noFill} placeholder="Optional" value="${val(x.accountNo)}" /></label>
                <label class="lh-field"><span class="lh-label">Website</span>
                  <input name="website" maxlength="300" ${noFill} placeholder="Optional" value="${val(x.website)}" /></label>
              </div>
              <label class="lh-field"><span class="lh-label">Address</span>
                <input name="address" maxlength="300" ${noFill} placeholder="Optional" value="${val(x.address)}" /></label>
            </section>

            <section class="sup-sec"><h4>Who to order from</h4>
              <div class="sup-two">
                <label class="lh-field"><span class="lh-label">Contact person</span>
                  <input name="contactName" maxlength="120" ${noFill} placeholder="e.g. Joshua Harry" value="${val(x.contactName)}" /></label>
                <label class="lh-field"><span class="lh-label">Phone</span>
                  <input name="phone" maxlength="40" ${noFill} placeholder="Optional" value="${val(x.phone)}" /></label>
              </div>
              <div class="sup-two">
                <label class="lh-field"><span class="lh-label">Order email</span>
                  <input name="email" type="email" maxlength="254" ${noFill} value="${val(x.email)}" /></label>
                <label class="lh-field"><span class="lh-label">CC on orders</span>
                  <input name="ccEmail" type="email" maxlength="254" ${noFill} placeholder="Optional" value="${val(x.ccEmail)}" /></label>
              </div>
            </section>

            <section class="sup-sec"><h4>Ordering notes <small>optional</small></h4>
              <label class="lh-field"><span class="lh-label">Notes for staff</span>
                <textarea name="orderNotes" rows="3" maxlength="1000"
                  placeholder="e.g. Orders before 2pm ship same day. Minimum order $200.">${esc(x.orderNotes || "")}</textarea></label>
              <small class="fe-note">Shown to staff on every purchase order for this supplier. Not sent to the supplier.</small>
            </section>
          </div>

          <div class="sup-col">
            <section class="sup-sec"><h4>Purchase order email <small>optional</small></h4>
              <p class="fe-note">Fills in the email when an order is sent to this supplier. Staff can still change it before sending.
                Put <strong>{Order table}</strong> on its own line to choose where the order goes, e.g. above a footer.
                Without it, the order goes after your message. Leave both empty to use the standard wording.</p>
              <label class="lh-field"><span class="lh-label">Subject</span>
                <input name="emailSubject" maxlength="200" data-tpl ${noFill} placeholder="Purchase order {PO number} from Dermedica" value="${val(x.emailSubject)}" /></label>
              <label class="lh-field"><span class="lh-label">Message</span>
                <textarea name="emailBody" rows="6" maxlength="5000" data-tpl
                  placeholder="Hi {Contact first name},&#10;&#10;Please find our order {PO number} below.&#10;&#10;{Order table}&#10;&#10;Thank you,&#10;{My name}">${esc(x.emailBody || "")}</textarea></label>
              <div class="inv-tags"><small class="muted">Insert:</small>${PO_EMAIL_TAGS.map(([t, help]) =>
                `<button type="button" class="ch-chip" data-tag="${esc(t)}" title="${esc(help)}">${esc(t)}</button>`).join("")}</div>
            </section>

            <section class="sup-sec"><h4>Preview <small data-role="pvnote"></small></h4>
              <div class="sup-pv-card">
                <div class="sup-pv-row"><span>To</span><strong data-role="pvto"></strong></div>
                <div class="sup-pv-row"><span>Subject</span><strong data-role="pvsub"></strong></div>
                <div class="sup-pv-body" data-role="pvbody"></div>
                <div class="sup-pv-order" data-role="pvorder" aria-hidden="true"><b data-role="pvnum"></b><i></i><i></i><i></i>
                  <small>The order's items, codes and quantities are added here</small></div>
              </div>
            </section>
          </div>
        </div>

        <footer class="sup-foot">
          <p class="lh-error" role="alert" hidden></p>
          <span class="inv-spacer"></span>
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${isNew ? "Add supplier" : "Save"}</button>
        </footer>
      </form>`);
    const form = dlg.querySelector("form");
    const f = form.elements;
    const err = dlg.querySelector(".lh-error");
    const $d = (r) => dlg.querySelector(`[data-role="${r}"]`);
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());

    // Active switch: its wording follows it
    f.active.addEventListener("change", () => {
      $d("activetxt").textContent = f.active.checked ? "Active" : "Inactive";
      f.active.closest(".sup-active").classList.toggle("is-off", !f.active.checked);
    });

    // Live preview with sample details. {Order table} shows where the order goes; other unfilled tags (typos) are highlighted.
    const orderMock = (num) => `<div class="sup-pv-order is-inline" aria-hidden="true"><b>Purchase order ${esc(num)}</b>
      <i></i><i></i><i></i><small>The order's items, codes and quantities go here</small></div>`;
    const typo = /\{(?!\s*order\s+table\s*\})[^{}]+\}/gi;
    const paras = (t, num) => t.trim().split(/\n{2,}/).map((p) => {
      if (/^\{\s*order\s+table\s*\}$/i.test(p.trim())) return orderMock(num);
      return `<p>${esc(p).replace(/\n/g, "<br>").replace(typo, "<mark>$&</mark>")
        .replace(new RegExp(PO_ORDER_TAG_RE.source, "gi"), `</p>${orderMock(num)}<p>`)}</p>`;
    }).join("").replace(/<p>(\s|<br>)*<\/p>/g, "");
    const drawPreview = () => {
      const sup = { name: f.company.value.trim(), contactName: f.contactName.value.trim(), accountNo: f.accountNo.value.trim() };
      const po = { number: poNumberBase(sup.name || "Supplier"), orderDate: dayKey(), lines: [{}, {}, {}] };
      const tpl = { po, supplier: sup, staff };
      const subj = f.emailSubject.value.trim();
      const body = f.emailBody.value.trim();
      const first = sup.contactName.split(/\s+/)[0];
      $d("pvto").textContent = [f.email.value.trim() || "No order email yet", f.ccEmail.value.trim() && `cc ${f.ccEmail.value.trim()}`]
        .filter(Boolean).join(" · ");
      $d("pvsub").textContent = subj ? fillPoTemplate(subj, tpl) : `Purchase order ${po.number} - Dermedica`;
      $d("pvbody").innerHTML = body ? paras(fillPoTemplate(body, tpl), po.number)
        : `<p>Hi ${esc(first || "there")},</p><p>Please see our purchase order <strong>${esc(po.number)}</strong> below${
            sup.accountNo ? ` (account ${esc(sup.accountNo)})` : ""}.</p><p>Please reply to confirm the order, pricing and the expected delivery date.</p>
          <p>Kind regards,<br>${esc((staff && staff.name) || "The team")}<br>Dermedica</p>`;
      $d("pvnum").textContent = `Purchase order ${po.number}`;
      $d("pvnote").textContent = subj || body ? "with sample details" : "standard wording";
      $d("pvorder").hidden = !!body && PO_ORDER_TAG_RE.test(body);   // shown in place instead
    };
    drawPreview();
    form.addEventListener("input", drawPreview);

    // Insert buttons: put the placeholder where the cursor is, in the subject or message (whichever was used last)
    let tplField = f.emailBody;
    form.querySelectorAll("[data-tpl]").forEach((el) => el.addEventListener("focus", () => { tplField = el; }));
    dlg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-tag]");
      if (!b) return;
      const el = tplField;
      const at = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? at;
      el.value = el.value.slice(0, at) + b.dataset.tag + el.value.slice(end);
      el.focus();
      el.setSelectionRange(at + b.dataset.tag.length, at + b.dataset.tag.length);
      drawPreview();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await saveSupplier(s ? s.id : "", {
          name: f.company.value, contactName: f.contactName.value, phone: f.phone.value, email: f.email.value,
          ccEmail: f.ccEmail.value, accountNo: f.accountNo.value, website: f.website.value, address: f.address.value,
          orderNotes: f.orderNotes.value, active: f.active.checked,
          emailSubject: f.emailSubject.value, emailBody: f.emailBody.value,
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
    f.company.focus();
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
      sub = "Removes stock that can't be used. The reason is logged. Used on a patient without a portal record? Use Used on a patient instead, so it counts as usage, not waste.";
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
    if (c.statuses.some((s) => s === "accepted" || s === "explained")) return `<small class="ivx-cl">Counted ${c.counted} on ${esc(d)} · difference resolved</small>`;
    return `<small class="ivx-cl is-ok">Counted ${c.counted} on ${esc(d)} ✓ matched</small>`;
  }

  /* ---------- A product's stock window ---------- */
  function openProduct(id) {
    const dlg = openDialog("inv-dlg inv-pdlg", '<div class="lh-form" data-role="pd"></div>');
    const box = dlg.querySelector('[data-role="pd"]');
    let pdMoves = [];   // the activity shown, for Undo / Used on a patient…
    let pdReturns = [];   // the returns shown, for Credit received
    const canOpen = canMove || can("consult.record");

    // Sales: every sale since a day, and whether it came off stock. Loaded on request (it reads the Timely invoices).
    const baseKey = () => (st.bases.get(id) || {}).dateKey || "";
    const sl = { fromKey: baseKey() || dayKey(new Date(Date.now() - 90 * 864e5)), open: false, busy: false, err: "",
      list: [], startDate: "", only: false, sel: new Set() };
    const SALE_STATE = { taken: ["Taken off", "is-ok"], short: ["Shelf was short", "is-warn"], pending: ["Not taken off stock", "is-bad"],
      counted: ["Counted, stock not changed", "is-info"], voided: ["Voided", ""] };
    const SALE_SRC = { invoice: "Invoice", manual: "By hand", scan: "Billing sheet", pos: "Checkout" };
    const fixable = (s) => s.state === "pending" || s.state === "short";
    const owed = (s) => (s.state === "short" ? s.left : s.qty);   // what still has to come off

    async function loadSales() {
      const p = st.products.find((x) => x.id === id);
      if (!p) return;
      sl.busy = true;
      sl.err = "";
      drawSales();
      try {
        const res = await callApi({ action: "inventory", op: "invoiceLines", from: sl.fromKey, to: dayKey() });
        if (res.problem) throw new Error(res.problem);
        const r = await productSales({ product: p, fromKey: sl.fromKey, invoiceRows: res.rows || [], allProducts: st.products });
        sl.list = r.list;
        sl.startDate = r.startDate;
        const cut = baseKey();
        sl.sel = new Set(r.list.filter((s) => fixable(s) && (!cut || s.date >= cut)).map((s) => s.id));
        sl.open = true;
      } catch (ex) {
        console.error("Sales not loaded:", ex);
        sl.err = errText(ex, "Couldn't load the sales. Try again.");
      }
      sl.busy = false;
      drawSales();
    }

    function drawSales() {
      const el = box.querySelector('[data-role="sales"]');
      const p = st.products.find((x) => x.id === id);
      if (!el || !p) return;
      const unit = p.stockUnit;
      const cut = baseKey();
      const head = `<div class="inv-pd-salehead"><h4>Sales</h4>
        <label class="inv-pd-salefrom">Since <input type="date" data-sl="from" value="${sl.fromKey}" max="${dayKey()}" /></label>
        <button type="button" class="lh-btn${sl.open ? " is-quiet" : ""}" data-sl="load"${sl.busy ? " disabled" : ""}>${
          sl.busy ? "Checking invoices…" : sl.open ? "Refresh" : "Show sales"}</button></div>`;
      if (sl.busy) { el.innerHTML = `<div class="inv-pd-sec">${head}<div class="skeleton" style="height:120px;border-radius:12px"></div></div>`; return; }
      if (sl.err) { el.innerHTML = `<div class="inv-pd-sec">${head}<p class="tb-none tb-bad">${esc(sl.err)}</p></div>`; return; }
      if (!sl.open) {
        el.innerHTML = `<div class="inv-pd-sec">${head}<p class="muted">Every sale since ${esc(niceDate(sl.fromKey))}: Timely invoices,
          billing sheets and sales recorded by hand, and whether each one came off stock.</p></div>`;
        return;
      }

      const L = sl.list;
      const sum = (pred) => L.filter(pred).reduce((a, s) => a + s.qty, 0);
      const sold = sum((s) => s.state !== "voided");
      const taken = L.filter((s) => s.state === "taken" || s.state === "short").reduce((a, s) => a + s.taken, 0);
      const pending = L.filter((s) => s.state === "pending");
      const pendN = pending.reduce((a, s) => a + s.qty, 0);
      const shortN = L.filter((s) => s.state === "short").reduce((a, s) => a + s.left, 0);
      const countedN = sum((s) => s.state === "counted");
      const todo = L.filter(fixable);
      const after = todo.filter((s) => !cut || s.date >= cut).length;
      const before = todo.length - after;
      const rows = sl.only ? todo : L;
      const picks = canManage && todo.length;
      const pill = (label, v, cls = "") => `<span class="inv-lg-pill ${cls}"><b>${esc(String(v))}</b> ${esc(label)}</span>`;

      el.innerHTML = `<div class="inv-pd-sec inv-pd-sales">${head}
        <div class="inv-lg-sum">
          ${pill("sold", sold, "is-strong")}
          ${pill("taken off stock", taken)}
          ${pendN ? pill("not taken off", pendN, "is-warn") : ""}
          ${shortN ? pill("the Shelf was short", shortN, "is-warn") : ""}
          ${countedN ? pill("counted, stock not changed", countedN) : ""}
        </div>
        ${!sl.startDate ? `<p class="inv-hint is-warn">Invoice uploads don't take sales off stock yet: there's no invoice start date.
          Set it in Products → <strong>Invoice links</strong> (the same day as your base counts).</p>` : ""}
        ${after ? `<p class="inv-hint is-warn"><strong>${plural(after, "sale")}${cut ? ` since the base count (${esc(niceDate(cut))})` : ""}
          never fully came off stock.</strong> Not linked when uploaded, before the invoice start date, or the Shelf showed 0 when it sold (often a delivery not received yet).</p>` : ""}
        ${before ? `<p class="inv-hint">${plural(before, "sale")} before the base count never came off stock. The base count already
          reflects them, so <strong>mark them as already counted</strong> rather than taking them off.</p>` : ""}
        ${L.length ? `<label class="fe-check"><input type="checkbox" data-sl="only"${sl.only ? " checked" : ""} /> Only ones not taken off</label>
          <div class="inv-pd-salescroll"><table class="inv-table inv-pd-saletable"><thead><tr>${picks ? "<th></th>" : ""}
            <th>Sold</th><th>From</th><th>Patient</th><th>Qty</th><th>Stock</th></tr></thead><tbody>${rows.map((s) => {
            const [label, cls] = SALE_STATE[s.state] || [s.state, ""];
            return `<tr class="${s.state === "pending" ? "is-diff" : ""}">
              ${picks ? `<td>${fixable(s) ?`<input type="checkbox" data-slpick="${esc(s.id)}"${sl.sel.has(s.id) ? " checked" : ""}
                aria-label="Select ${esc(s.invoiceId || "sale")}" />` : ""}</td>` : ""}
              <td>${esc(niceDate(s.date))}${cut && s.date < cut ? '<small class="muted">before base count</small>' : ""}</td>
              <td>${esc(SALE_SRC[s.source] || s.source)}${s.invoiceId ? ` ${esc(s.invoiceId)}` : ""}${s.provider ? `<small class="muted">${esc(s.provider)}</small>` : ""}</td>
              <td>${esc(s.patientName || "—")}</td><td>${esc(plural(s.qty, unit))}</td>
              <td><span class="inv-flag ${cls}">${esc(label)}</span>${s.state === "short" ? `<small>${s.left} not taken off</small>` : ""}${
                s.batches.length ? `<small class="muted">${esc(batchName(p))} ${esc(s.batches.join(", "))}</small>` : ""}</td></tr>`;
          }).join("") || `<tr><td colspan="${picks ? 6 : 5}" class="tb-none">Nothing still to sort out. 👍</td></tr>`}</tbody></table></div>`
          : `<p class="tb-none">No sales since ${esc(niceDate(sl.fromKey))}.</p>`}
        ${picks ? `<div class="inv-pd-saleacts"><small class="muted">${sl.sel.size} ticked</small>
          <button type="button" class="lh-btn is-primary" data-sl="take"${sl.sel.size ? "" : " disabled"}>Take off stock</button>
          <button type="button" class="lh-btn" data-sl="mark"${sl.sel.size ? "" : " disabled"}>Mark as already counted</button></div>` : ""}
        <small class="fe-note">Only invoice names linked to this product are listed. An unlinked name won't show here: link it in Products → Invoice links.</small>
      </div>`;
    }

    async function settleSales(deduct, btn) {
      const p = st.products.find((x) => x.id === id);
      const items = sl.list.filter((s) => fixable(s) && sl.sel.has(s.id));
      if (!p || !items.length) return;
      const n = items.reduce((a, s) => a + owed(s), 0);
      const ok = await confirmDialog({
        title: deduct ? `Take ${plural(n, p.stockUnit)} off the Shelf?` : `Mark ${plural(items.length, "sale")} as already counted?`,
        message: deduct
          ? "Each comes off the Shelf (oldest expiry first), dated the day it was sold. Opening counts done since are corrected."
          : "Stock doesn't change. They're recorded, so they stop showing as missing and an invoice upload never takes them off.",
        confirmLabel: deduct ? "Take off stock" : "Mark as counted",
      });
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        const pend = items.filter((s) => s.state === "pending");
        const shorts = items.filter((s) => s.state === "short");
        const a = pend.length ? await settlePendingSales(p, pend, { deduct }, staff) : null;
        const b = shorts.length ? await settleShortSales(p, shorts.map((s) => s.id), { deduct }, staff) : null;
        const zero = { done: 0, short: 0, failed: [], backdated: { lines: 0, closed: 0 } };
        const A = a || zero, B = b || zero;
        const r = { done: A.done + B.done, short: A.short + B.short, failed: [...A.failed, ...B.failed], error: A.error || B.error,
          backdated: { lines: A.backdated.lines + B.backdated.lines, closed: A.backdated.closed + B.backdated.closed } };
        const bd = r.backdated;
        showToast([
          deduct ? `${plural(r.done, "sale")} taken off stock.` : `${plural(r.done, "sale")} marked as counted.`,
          r.short ? `The Shelf was short by ${r.short}.` : "",
          bd.lines ? `${bd.lines} count line${bd.lines === 1 ? "" : "s"} corrected${bd.closed ? `, ${bd.closed} investigation${bd.closed === 1 ? "" : "s"} closed` : ""}.` : "",
          r.failed.length ? `Couldn't save ${r.failed.length}: ${errText((b && b.error) || (a && a.error), "try again")}` : "",
        ].filter(Boolean).join(" "));
      } catch (ex) {
        console.error("Sales not settled:", ex);
        showToast(errText(ex, "Couldn't save. Try again."));
      }
      await load();
      if (dlg.open) { draw(); await loadSales(); }
    }
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

    // A sale that isn't on a Timely invoice, dated when it happened
    function saleDialog(p) {
      const today = dayKey();
      return new Promise((resolve) => {
        let saved = false;
        const d2 = openDialog("inv-dlg", `
          <form class="lh-form" novalidate>
            <div class="lh-dialog-head"><h3>Record a sale: ${esc(p.name)}</h3>
              <p>Only for sales that <strong>aren't on a Timely invoice</strong>, or were before invoices started taking stock off.
                Anything on an invoice comes off when the invoices are uploaded, so recording it here too would take it off twice.</p></div>
            <div class="inv-two">
              <label class="lh-field"><span class="lh-label">Date sold</span>
                <input type="date" name="date" value="${today}" max="${today}" /></label>
              <label class="lh-field"><span class="lh-label">How many</span>
                <div class="fe-num"><input class="fe-input" name="qty" type="number" min="1" max="99" step="1" value="1" inputmode="numeric" />
                  <span>${esc(unitPlural(p.stockUnit))}</span></div></label>
            </div>
            <label class="lh-field"><span class="lh-label">Patient or who it was for (optional)</span>
              <input name="who" maxlength="150" placeholder="e.g. Jane Smith" /></label>
            <label class="lh-field"><span class="lh-label">Why it's recorded here</span>
              <input name="note" maxlength="300" placeholder="e.g. Invoice 1234, sold before invoices took stock off · Sample" /></label>
            <p class="inv-hint">It comes off the Shelf, oldest expiry first (Shelf now: ${esc(plural(p.stock.shelf, p.stockUnit))}).
              Opening counts done after that date are corrected, so a difference it explains closes by itself.</p>
            <p class="lh-error" role="alert" hidden></p>
            <div class="lh-actions">
              <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
              <button type="submit" class="lh-btn is-primary">Record sale</button>
            </div>
          </form>`);
        const form = d2.querySelector("form");
        const err = d2.querySelector(".lh-error");
        d2.querySelector('[data-act="cancel"]').addEventListener("click", () => d2.close());
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          err.hidden = true;
          const f = form.elements;
          const btn = form.querySelector('[type="submit"]');
          btn.disabled = true;
          btn.textContent = "Saving…";
          try {
            const r = await recordManualSale(p, { date: f.date.value, qty: f.qty.value, patientName: f.who.value, note: f.note.value }, staff);
            saved = true;
            d2.close();
            const l = r.lines[0];
            const bd = r.backdated || {};
            showToast([
              `Sale recorded${l && l.short ? `, but the Shelf showed ${l.short} fewer than that` : ""}.`,
              bd.lines ? `${bd.lines} count line${bd.lines === 1 ? "" : "s"} corrected${bd.closed ? `, ${bd.closed} investigation${bd.closed === 1 ? "" : "s"} closed` : ""}.` : "",
              bd.skipped && bd.skipped.length ? `Already accepted, so not changed: ${bd.skipped.join(", ")}.` : "",
            ].filter(Boolean).join(" "));
          } catch (ex) {
            console.error("Record sale failed:", ex);
            err.textContent = errText(ex, "Couldn't save. Try again.");
            err.hidden = false;
            btn.disabled = false;
            btn.textContent = "Record sale";
          }
        });
        d2.addEventListener("close", () => resolve(saved));
        f2focus(form);
      });
    }

    function undoDialog(p, m) {
      const paper = m.type === "use";
      const fix = canUndoCorrection(m);
      const back = (m.lines || []).filter((l) => l.loc === "shelf" || l.loc === "jt")
        .map((l) => `${locLabel(l.loc)} ${-l.delta > 0 ? "+" : "−"}${Math.abs(l.delta)}`).join(" · ");
      return new Promise((resolve) => {
        let saved = false;
        const d2 = openDialog("inv-dlg", `
          <form class="lh-form" novalidate>
            <div class="lh-dialog-head"><h3>${fix ? "Undo this correction?" : paper ? "Undo this paper record?" : "Undo this write-off?"}</h3>
              <p>${esc(when(m.at))}${m.by ? ` by ${esc(m.by)}` : ""}: ${esc(linesText(m, batchName(p)))}${m.reason ? ` · ${esc(m.reason)}` : ""}${
                m.note ? ` · ${esc(m.note)}` : ""}.</p>
              <p>${fix
                ? `Digital goes back by the same amount: <strong>${esc(back)}</strong>. Anything sold or used since stays as it is.
                   The base count isn't changed: change it in the Base count section if it was wrong too.`
                : paper
                ? "It goes back into stock, and the patient's usage is cleared (the original stays on their record, with your reason). Opening counts corrected for it aren't changed back: check Count differences afterwards."
                : "It goes back into stock, and the write-off is marked Undone (and left out of wastage)."}</p></div>
            <label class="lh-field"><span class="lh-label">Why</span>
              <input name="why" maxlength="300" placeholder="${fix ? "e.g. Wrong base count date" : paper ? "e.g. Recorded on the wrong patient" : "e.g. Written off by mistake"}" /></label>
            ${paper || fix ? "" : `<p class="inv-hint">Was it actually used on a patient? Close this and choose <strong>Used on a patient…</strong>,
              so it's on their record and counts as usage.</p>`}
            <p class="lh-error" role="alert" hidden></p>
            <div class="lh-actions">
              <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
              <button type="submit" class="lh-btn is-primary">${fix ? "Undo correction" : paper ? "Undo paper record" : "Undo write-off"}</button>
            </div>
          </form>`);
        const form = d2.querySelector("form");
        const err = d2.querySelector(".lh-error");
        d2.querySelector('[data-act="cancel"]').addEventListener("click", () => d2.close());
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          err.hidden = true;
          const btn = form.querySelector('[type="submit"]');
          btn.disabled = true;
          try {
            if (fix) await undoCorrection(m, form.elements.why.value, staff);
            else await undoMove(m, form.elements.why.value, staff);
            saved = true;
            d2.close();
            showToast(fix ? "Correction undone. Digital is back to what it was."
              : paper ? "Paper record undone. It's back in stock and off the patient's usage." : "Write-off undone. It's back in stock.");
          } catch (ex) {
            console.error("Undo failed:", ex);
            err.textContent = errText(ex, "Couldn't undo it. Try again.");
            err.hidden = false;
            btn.disabled = false;
          }
        });
        d2.addEventListener("close", () => resolve(saved));
        form.elements.why.focus();
      });
    }
    
    const paperUseDialog = (p, from = null) => paperUseDialogFor(p, lotsOf(p.id), staff, from);
    const f2focus = (form) => { const q = form.elements.qty; if (q) { q.focus(); q.select(); } };

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

    const returnText = (p, r) => (r.kind === "supplier"
      ? [`${plural(r.qty, p.stockUnit)} to ${r.supplierName || "the supplier"}`, r.reason, r.poNumber,
          r.raNumber && `Return no. ${r.raNumber}`, r.credit !== null && `credit ${money(r.credit)} expected`].filter(Boolean).join(" · ")
      : [`${plural(r.qty, p.stockUnit)} from ${r.patientName || "a patient"}`,
          r.resell ? `back in ${locLabel(r.loc)}${r.batch ? ` (${batchText(p, r.batch)})` : ""}` : "not resellable",
          r.invoiceId && `Invoice ${r.invoiceId}`].filter(Boolean).join(" · "));

    // Only shown once the product has a return
    const returnsHtml = (p, list) => (!list.length ? "" : `<div class="inv-pd-sec"><h4>Returns</h4><ul class="inv-open">${
      list.slice(0, 10).map((r) => {
        const s = r.kind === "supplier" ? r.status : "";
        return `<li><span><strong>${r.kind === "supplier" ? "Back to the supplier" : "From a patient"}</strong> · ${esc(niceDate(r.date) || when(r.at))}
            <small>${esc(returnText(p, r))}${r.by ? ` · ${esc(r.by)}` : ""}</small></span>
          ${s ? `<span class="inv-flag is-${s === "awaiting" ? "warn" : "info"}">${esc(RETURN_STATUS[s] || s)}${
            s === "credited" && r.creditReceived !== null ? ` ${esc(money(r.creditReceived))}` : ""}</span>` : "<span></span>"}
          ${s === "awaiting" && canMove ? `<button type="button" class="lh-btn" data-credit="${esc(r.id)}">Credit received</button>` : "<span></span>"}</li>`;
      }).join("")}</ul></div>`);

    // A patient brings it back, or it goes back to the supplier
    function returnDialog(p) {
      const today = dayKey();
      const unit = p.stockUnit;
      const lots = lotsOf(p.id);
      const batches = [...new Map(lots.map((l) => [`${l.batch}|${l.expiry}`, l])).values()];
      const sups = productSuppliers(p).map((t) => supplierOf(t.supplierId)).filter(Boolean);
      const supList = sups.length ? sups : st.suppliers.filter((s) => s.active);
      const pos = st.pos.filter((po) => ["part", "received"].includes(po.status) && po.lines.some((l) => l.productId === p.id));
      const each = p.cost !== null && p.cost !== undefined ? p.cost / Math.max(1, p.packSize) : null;
      const bn = batchName(p);

      const batchHtml = p.tracked ? `
        <label class="lh-field"><span class="lh-label">${esc(bn)}</span>
          <select class="fb-select" name="pbatch">${batches.map((l, i) =>
            `<option value="${i}">${esc(`${batchText(p, l.batch)} · Exp ${niceDate(l.expiry)}`)}</option>`).join("")}
            <option value="new">Another ${esc(bn.toLowerCase())}…</option></select></label>
        <div class="inv-two" data-role="pnew" hidden>
          <label class="lh-field"><span class="lh-label">${esc(bn)} number</span><input name="pbn" maxlength="40" autocomplete="off" /></label>
          <label class="lh-field"><span class="lh-label">Expiry date</span><input name="pbe" type="date" /></label>
        </div>` : "";
      const fromHtml = p.tracked
        ? (lots.length ? `<label class="lh-field"><span class="lh-label">Which one</span><select class="fb-select" name="slot">${lots.map((l, i) =>
            `<option value="${i}">${esc(`${locLabel(l.loc)} · ${batchText(p, l.batch)} · Exp ${niceDate(l.expiry)} · ${plural(l.qty, unit)}`)}${
              expiryState(l.expiry) === "expired" ? " · EXPIRED" : ""}</option>`).join("")}</select></label>`
          : '<p class="tb-none">There is no stock to send back.</p>')
        : `<div class="lh-field"><span class="lh-label">Taken from</span>${seg("sloc", LOCATIONS.map((l) => [l.key, `${l.label} (${p.stock[l.key]})`]),
            p.stock.shelf > 0 ? "shelf" : "jt")}</div>`;

      return new Promise((resolve) => {
        let saved = false, creditTyped = false;
        const d2 = openDialog("inv-dlg", `
          <form class="lh-form" novalidate>
            <div class="lh-dialog-head"><h3>Return: ${esc(p.name)}</h3></div>
            <div class="lh-field">${seg("kind", [["patient", "From a patient"], ["supplier", "Back to the supplier"]], "patient")}</div>

            <div data-kind="patient">
              <p class="inv-hint">A product a patient brought back. It came off stock when it was sold, so only a sealed one goes back in.</p>
              <div class="inv-two">
                <label class="lh-field"><span class="lh-label">Date returned</span><input type="date" name="pdate" value="${today}" max="${today}" /></label>
                <label class="lh-field"><span class="lh-label">How many</span>
                  <div class="fe-num"><input class="fe-input" name="pqty" type="number" min="1" max="99" step="1" value="1" inputmode="numeric" />
                    <span>${esc(unitPlural(unit))}</span></div></label>
                <label class="lh-field"><span class="lh-label">Timely invoice no. (optional)</span><input name="inv" maxlength="60" placeholder="e.g. 35775" />
                  <small class="fe-note">Links it to the sale, so it can't be returned twice.</small></label>
              </div>
              <label class="lh-field" data-role="pfind"><span class="lh-label">Patient (optional)</span>
                <input type="search" name="pq" placeholder="Search your patient list by name" autocomplete="off" /></label>
              <div class="ef-test-hits" data-role="phits"></div>
              <div data-role="ppick"></div>
              <div class="lh-field"><span class="lh-label">Its condition</span>
                ${seg("cond", [["resell", "Sealed: back into stock"], ["discard", "Opened or damaged: can't be resold"]], "resell")}</div>
              <div data-role="resell">
                <div class="lh-field"><span class="lh-label">Put back in</span>${seg("ploc", LOCATIONS.map((l) => [l.key, l.label]), "shelf")}</div>
                ${batchHtml}
              </div>
            </div>

            <div data-kind="supplier" hidden>
              <p class="inv-hint">Faulty, wrong item, expired or a recall. It comes off stock now and isn't counted as wastage.</p>
              ${fromHtml}
              <div class="inv-two">
                <label class="lh-field"><span class="lh-label">How many</span>
                  <div class="fe-num"><input class="fe-input" name="sqty" type="number" min="1" step="1" value="1" inputmode="numeric" />
                    <span>${esc(unitPlural(unit))}</span></div></label>
                <label class="lh-field"><span class="lh-label">Supplier</span>${supList.length
                  ? `<select class="fb-select" name="sup">${supList.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select>`
                  : '<span class="tb-none">Add a supplier first, in the Suppliers tab.</span>'}</label>
                <label class="lh-field"><span class="lh-label">Why</span>
                  <select class="fb-select" name="reason">${RETURN_REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
                <label class="lh-field"><span class="lh-label">Came on order (optional)</span>
                  <select class="fb-select" name="po"><option value="">Not linked to an order</option>${pos.map((po) =>
                    `<option value="${esc(po.id)}">${esc(`${po.number} · ${po.supplier.name} · ${niceDate(po.orderDate)}`)}</option>`).join("")}</select></label>
                <label class="lh-field"><span class="lh-label">Their return number (optional)</span><input name="ra" maxlength="60" placeholder="RA / authorisation no." /></label>
                <label class="lh-field"><span class="lh-label">Credit expected, $</span>
                  <input name="credit" type="number" min="0" step="0.01" inputmode="decimal" /></label>
              </div>
              <label class="fe-check"><input type="checkbox" name="noCredit" /> No credit expected (e.g. they're replacing it)</label>
            </div>

            <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="300" /></label>
            <p class="lh-error" role="alert" hidden></p>
            <div class="lh-actions">
              <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
              <button type="submit" class="lh-btn is-primary">Record return</button>
            </div>
          </form>`);
        const form = d2.querySelector("form");
        const f = form.elements;
        const err = d2.querySelector(".lh-error");
        const submit = form.querySelector('[type="submit"]');

        // Patient: picked from the patient list (or left empty)
        let chosen = null, found = [], timer = null, seq = 0;
        const hits = d2.querySelector('[data-role="phits"]');
        const pick = d2.querySelector('[data-role="ppick"]');
        const findBox = d2.querySelector('[data-role="pfind"]');
        const showPick = () => {
          pick.innerHTML = chosen ? `<div class="ef-chosen"><span><strong>${esc(chosen.name)}</strong><br>
            <small class="muted">${esc([chosen.dob && `DOB ${chosen.dob}`, chosen.pttId && `ID ${chosen.pttId}`].filter(Boolean).join(" · "))}</small></span>
            <button type="button" class="lh-btn is-quiet" data-act="unpick">Change</button></div>` : "";
          findBox.hidden = !!chosen;
          if (chosen) hits.innerHTML = "";
        };
        f.pq.addEventListener("input", () => {
          clearTimeout(timer);
          const q = f.pq.value;
          if (q.trim().length < 2) { hits.innerHTML = ""; return; }
          const my = ++seq;
          timer = setTimeout(async () => {
            try { found = await searchPatients(q); } catch (ex) { console.warn(ex); found = []; }
            if (my !== seq || !d2.open) return;
            hits.innerHTML = found.length ? found.map((x, i) => `<button type="button" class="ef-hit" data-hit="${i}">
              <strong>${esc(x.name)}</strong><small>${esc([x.dob && `DOB ${x.dob}`, x.email].filter(Boolean).join(" · "))}</small></button>`).join("")
              : '<p class="tb-none">No patients found. Try their last name.</p>';
          }, 250);
        });
        f.pq.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });   // Enter doesn't save the form
        d2.addEventListener("click", (e) => {
          if (e.target.closest('[data-act="unpick"]')) { chosen = null; showPick(); f.pq.value = ""; f.pq.focus(); return; }
          const h = e.target.closest("[data-hit]");
          if (h) { chosen = found[Number(h.dataset.hit)] || null; showPick(); }
        });

        const fillCredit = () => {
          if (creditTyped || each === null) return;
          const n = parseInt(f.sqty.value, 10) || 0;
          f.credit.value = n ? (Math.round(n * each * 100) / 100).toFixed(2) : "";
        };
        const sync = () => {
          const k = f.kind.value;
          d2.querySelectorAll("[data-kind]").forEach((el) => { el.hidden = el.dataset.kind !== k; });
          d2.querySelector('[data-role="resell"]').hidden = f.cond.value !== "resell";
          if (p.tracked) d2.querySelector('[data-role="pnew"]').hidden = f.pbatch.value !== "new";
          f.credit.disabled = f.noCredit.checked;
          submit.textContent = k === "patient" ? "Record return" : "Send back";
          submit.hidden = k === "supplier" && ((p.tracked && !lots.length) || !supList.length);
        };
        fillCredit();
        sync();
        form.addEventListener("change", sync);
        form.addEventListener("input", (e) => {
          if (e.target.name === "credit") creditTyped = true;
          if (e.target.name === "sqty") fillCredit();
        });
        d2.querySelector('[data-act="cancel"]').addEventListener("click", () => d2.close());

        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          err.hidden = true;
          const k = f.kind.value;
          submit.disabled = true;
          submit.textContent = "Saving…";
          try {
            if (k === "patient") {
              if (!chosen && f.pq.value.trim()) throw new Error("Choose the patient from the list, or clear the search box.");
              let batch = "", expiry = "";
              if (f.cond.value === "resell" && p.tracked) {
                if (f.pbatch.value === "new") {
                  if (f.pbe.validity && f.pbe.validity.badInput) throw new Error("That expiry date doesn't exist. Check the day.");
                  batch = f.pbn.value.trim();
                  expiry = f.pbe.value;
                } else {
                  const l = batches[Number(f.pbatch.value)];
                  batch = l.batch;
                  expiry = l.expiry;
                }
              }
              const r = await recordPatientReturn(p, {
                date: f.pdate.value, qty: f.pqty.value, resell: f.cond.value === "resell", loc: f.ploc.value,
                batch, expiry, invoiceId: f.inv.value, patientId: chosen ? chosen.id : "", patientName: chosen ? chosen.name : "", note: f.note.value,
              }, staff);
              const bd = r.backdated || {};
              showToast([
                f.cond.value === "resell" ? `Return recorded. ${plural(parseInt(f.pqty.value, 10), unit)} back in ${locLabel(f.ploc.value)}.`
                  : "Return recorded. Stock wasn't changed.",
                bd.lines ? `${bd.lines} count line${bd.lines === 1 ? "" : "s"} corrected${bd.closed ? `, ${bd.closed} investigation${bd.closed === 1 ? "" : "s"} closed` : ""}.` : "",
                bd.skipped && bd.skipped.length ? `Already accepted, so not changed: ${bd.skipped.join(", ")}.` : "",
              ].filter(Boolean).join(" "));
            } else {
              const lot = p.tracked ? lots[Number(f.slot.value)] : { loc: f.sloc.value, batch: "", expiry: "" };
              const s = supList.find((x) => x.id === f.sup.value) || null;
              await recordSupplierReturn(p, {
                lot, qty: f.sqty.value, reason: f.reason.value, supplierId: s ? s.id : "", supplierName: s ? s.name : "",
                poId: f.po.value, raNumber: f.ra.value, credit: f.credit.value, noCredit: f.noCredit.checked, note: f.note.value,
              }, staff);
              showToast(f.noCredit.checked ? "Returned to the supplier." : "Returned to the supplier. It's waiting for its credit.");
            }
            saved = true;
            d2.close();
          } catch (ex) {
            console.error("Return failed:", ex);
            err.textContent = errText(ex, "Couldn't save. Try again.");
            err.hidden = false;
            submit.disabled = false;
            submit.textContent = k === "patient" ? "Record return" : "Send back";
          }
        });
        d2.addEventListener("close", () => { clearTimeout(timer); resolve(saved); });
      });
    }

    function creditDialog(r) {
      return new Promise((resolve) => {
        let saved = false;
        const d2 = openDialog("inv-dlg", `
          <form class="lh-form" novalidate>
            <div class="lh-dialog-head"><h3>Credit received: ${esc(r.productName)}</h3>
              <p>${esc(plural(r.qty, r.unit))} back to ${esc(r.supplierName || "the supplier")} on ${esc(niceDate(r.date))}${
                r.credit !== null ? ` · ${esc(money(r.credit))} expected` : ""}.</p></div>
            <div class="inv-two">
              <label class="lh-field"><span class="lh-label">Amount credited, $</span>
                <input name="amount" type="number" min="0" step="0.01" value="${r.credit !== null ? esc(Number(r.credit).toFixed(2)) : ""}" /></label>
              <label class="lh-field"><span class="lh-label">Credit note no. (optional)</span><input name="cn" maxlength="60" /></label>
            </div>
            <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="300" /></label>
            <p class="lh-error" role="alert" hidden></p>
            <div class="lh-actions">
              <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
              <button type="submit" class="lh-btn is-primary">Mark credited</button>
            </div>
          </form>`);
        const form = d2.querySelector("form");
        d2.querySelector('[data-act="cancel"]').addEventListener("click", () => d2.close());
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = form.querySelector('[type="submit"]');
          btn.disabled = true;
          try {
            await markReturnCredited(r.id, { amount: form.elements.amount.value, creditNoteNo: form.elements.cn.value, note: form.elements.note.value }, staff);
            saved = true;
            d2.close();
            showToast("Marked credited");
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
          ${canMove ? '<button type="button" class="lh-btn" data-act="sale">Record a sale</button>' : ""}
          ${canMove && !isKitProduct(p) && !isSharedProduct(p) ? '<button type="button" class="lh-btn" data-act="paper">Used on a patient</button>' : ""}
          ${canMove && !isKitProduct(p) && !isSharedProduct(p) ? '<button type="button" class="lh-btn" data-act="return">Return…</button>' : ""}
          ${canRequest ? '<button type="button" class="lh-btn" data-act="request">Request more</button>' : ""}
          ${canManage ? `<button type="button" class="lh-btn" data-stock="count">Count</button>
            <button type="button" class="lh-btn" data-stock="writeoff">Write off</button>
            <button type="button" class="lh-btn" data-act="ledger">Day by day</button>
            <button type="button" class="lh-btn is-quiet" data-act="edit">Edit product</button>` : ""}
        </div>` : ""}
        ${isSharedProduct(p) ? sharedSecHtml(p) : ""}
        ${!p.tracked && canManage && p.stock.shelf + p.stock.jt > 0 ? `<div class="inv-pd-sec inv-pd-nolot">
          <div><h4>Lot and expiry</h4>
            <p class="muted">This stock has no ${esc(batchName(p).toLowerCase())} number or expiry date, so expiry warnings can't work for it.</p></div>
          <button type="button" class="lh-btn${p.category === "injectable" ? " is-primary" : ""}" data-act="add-lots">Add lot &amp; expiry…</button>
        </div>` : ""}
        ${p.tracked ? `<div class="inv-pd-sec"><h4>Stock by ${esc(batchName(p).toLowerCase())} <small>(oldest expiry first)</small></h4>${lots.length
          ? `<table class="inv-table"><thead><tr><th>Storage</th><th>${esc(batchName(p))}</th><th>Expiry</th><th>Qty</th>${canManage ? "<th></th>" : ""}</tr></thead><tbody>${lots.map((l, i) => {
           const ex = expiryState(l.expiry);
              return `<tr><td>${esc(locLabel(l.loc))}</td><td>${esc(l.batch || "—")}</td>
                <td>${esc(niceDate(l.expiry) || "—")}${ex ? ` <span class="inv-flag is-${ex === "expired" ? "bad" : "warn"}">${ex === "expired" ? "Expired" : "Soon"}</span>` : ""}</td>
                <td>${esc(qtyText(p, l.qty))}</td>
                ${canManage ? `<td class="inv-lot-act"><button type="button" class="lh-btn" data-editlot="${i}">Edit</button></td>` : ""}</tr>`;
            }).join("")}</tbody></table>`
          : '<p class="tb-none">No batches in stock.</p>'}</div>` : ""}
        ${productSuppliers(p).length ? `<div class="inv-pd-sec"><h4>Supplier${productSuppliers(p).length > 1 ? "s" : ""}</h4>${
          productSuppliers(p).map((t) => {
            const s = supplierOf(t.supplierId);
            if (!s) return "";
             const bits = [
              t.supplierCode && `Code ${t.supplierCode}`,
              t.cost !== null && t.cost !== undefined && `${money(t.cost)} / ${t.orderUnit || p.orderUnit}`,
              s.email, s.phone,
            ].filter(Boolean);
            return `<p class="inv-pd-sup"><strong>${esc(s.name)}</strong>${t.main ? ' <span class="inv-flag is-info">Main</span>' : ""}${
              bits.map((b) => ` · ${b}`).join("")}</p>`;
          }).join("")}</div>` : ""}
        ${canManage ? (() => {
          const b = st.bases.get(p.id);
          const nums = (x) => [x.shelf !== null && x.shelf !== undefined && `Shelf ${x.shelf}`,
            x.jt !== null && x.jt !== undefined && `JT storage ${x.jt}`].filter(Boolean).join(" · ");
          const hist = b ? b.history.filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.dateKey || "")).slice(-3).reverse() : [];
          return `<div class="inv-pd-sec inv-pd-base"><div><h4>Base count</h4>
            <p class="muted">${b ? `${esc(nums(b))} on <strong>${esc(niceDate(b.dateKey))}</strong>${b.by ? ` · saved by ${esc(b.by)}` : ""}`
              : "No starting point saved yet. Save what was there on a day you know, and digital can be checked against it at any time."}</p>
            ${hist.length ? `<ul class="inv-base-hist">${hist.map((h, i) => `<li><span>Before: ${esc(nums(h) || "—")} on ${esc(niceDate(h.dateKey))}${
              h.by ? ` · ${esc(h.by)}` : ""}</span><button type="button" class="rc-link" data-base-restore="${i}">Use again</button></li>`).join("")}</ul>` : ""}</div>
            <span class="kit-acts">${b ? '<button type="button" class="lh-btn" data-act="base-check">Check digital</button>' : ""}
              <button type="button" class="lh-btn${b ? " is-quiet" : ""}" data-act="base-set">${b ? "Change" : "Set base count"}</button>
              ${b ? '<button type="button" class="lh-btn is-quiet" data-act="base-remove">Remove</button>' : ""}</span></div>`;
        })() : ""}
        <div data-role="returns"></div>
        ${canView ? '<div data-role="sales"></div>' : ""}
        <div class="inv-pd-sec"><h4>Recent activity</h4><div data-role="moves"><p class="tb-none">Loading…</p></div></div>`;
      drawSales();
      listMoves({ productId: id, max: 15 })
        .then((m) => { pdMoves = m; const el = box.querySelector('[data-role="moves"]'); if (el) el.innerHTML = movesHtml(m, false, labelOf, canManage); })
        .catch(() => { const el = box.querySelector('[data-role="moves"]'); if (el) el.innerHTML = '<p class="tb-none tb-bad">Couldn\'t load the activity.</p>'; });
      listReturns({ productId: id })
        .then((list) => { pdReturns = list; const el = box.querySelector('[data-role="returns"]'); if (el) el.innerHTML = returnsHtml(p, list); })
        .catch((err) => console.warn("Returns not loaded:", err));
    }

    box.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.sl === "from" && /^\d{4}-\d{2}-\d{2}$/.test(t.value) && t.value <= dayKey()) {
        sl.fromKey = t.value;
        if (sl.open) loadSales(); else drawSales();
      } else if (t.dataset.sl === "only") { sl.only = t.checked; drawSales(); }
      else if (t.dataset.slpick) { if (t.checked) sl.sel.add(t.dataset.slpick); else sl.sel.delete(t.dataset.slpick); drawSales(); }
    });

    box.addEventListener("click", async (e) => {
      if (e.target.closest('[data-act="close"]')) { dlg.close(); return; }
      const sb = e.target.closest("button[data-sl]");
      if (sb && !sl.busy) {
        if (sb.dataset.sl === "load") loadSales();
        else if (sb.dataset.sl === "take") settleSales(true, sb);
        else if (sb.dataset.sl === "mark") settleSales(false, sb);
        return;
      }
      const p = st.products.find((x) => x.id === id);
      if (!p) return;
      if (e.target.closest('[data-act="sale"]')) {
        if (await saleDialog(p)) { await load(); if (dlg.open) draw(); }
        return;
      }
      if (e.target.closest('[data-act="paper"]')) {
        if (await paperUseDialog(p)) { await load(); if (dlg.open) draw(); }
        return;
      }
      if (e.target.closest('[data-act="return"]')) {
        if (await returnDialog(p)) { await load(); if (dlg.open) draw(); }
        return;
      }
      const cr = e.target.closest("[data-credit]");
      if (cr) {
        const r = pdReturns.find((x) => x.id === cr.dataset.credit);
        if (r && await creditDialog(r)) { if (dlg.open) draw(); }
        return;
      }
      const un = e.target.closest("[data-undo]");
      if (un) {
        const m = pdMoves.find((x) => x.id === un.dataset.undo);
        if (m && await undoDialog(p, m)) { await load(); if (dlg.open) draw(); }
        return;
      }
      const tu = e.target.closest("[data-touse]");
      if (tu) {
        const m = pdMoves.find((x) => x.id === tu.dataset.touse);
        if (m && await paperUseDialog(p, m)) { await load(); if (dlg.open) draw(); }
        return;
      }
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
      if (e.target.closest('[data-act="add-lots"]')) {
        if (await trackingDialog(p, true)) { await load(); if (dlg.open) draw(); }
        return;
      }
      const el = e.target.closest("[data-editlot]");
      if (el) {
        const lot = lotsOf(id)[Number(el.dataset.editlot)];
        if (lot && await editLotDialog(p, lot)) { await load(); if (dlg.open) draw(); }
        return;
      }
      if (e.target.closest('[data-act="edit"]')) { dlg.close(); editProduct(p); return; }
      if (e.target.closest('[data-act="ledger"]')) { ledgerDialog(p); return; }
      if (e.target.closest('[data-act="base-check"]')) { dlg.close(); rebuildDialog([p], p.name, { fromBases: true }); return; }
      if (e.target.closest('[data-act="base-set"]')) { dlg.close(); rebuildDialog([p], p.name); return; }
      if (e.target.closest('[data-act="base-remove"]')) {
        const ok = await confirmDialog({ title: `Remove the base count for ${p.name}?`,
          message: "Stock doesn't change. It's kept in the history, and you can set a new one at any time.", confirmLabel: "Remove", tone: "warning" });
        if (!ok) return;
        try { await removeBaseCount(p, staff); showToast("Base count removed"); await load(); if (dlg.open) draw(); }
        catch (err) { console.error(err); showToast(errText(err, "Couldn't remove it. Try again.")); }
        return;
      }
      const rs = e.target.closest("[data-base-restore]");
      if (rs) {
        const b = st.bases.get(p.id);
        const hist = b ? b.history.filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.dateKey || "")).slice(-3).reverse() : [];
        const h = hist[Number(rs.dataset.baseRestore)];
        if (!h) return;
        try {
          await saveBaseCount(p, { dateKey: h.dateKey, shelf: h.shelf, jt: h.jt, note: "Earlier base count used again" }, staff);
          showToast(`Base count is ${niceDate(h.dateKey)} again. Stock wasn't changed.`);
          await load();
          if (dlg.open) draw();
        } catch (err) { console.error(err); showToast(errText(err, "Couldn't save. Try again.")); }
        return;
      }
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
          <button type="button" class="lh-btn" data-req="email" data-id="${esc(r.id)}">Email it again</button>
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
        ${segF("po-f", [["sent", "Sent", n("sent")], ["part", "Part received", n("part")],
          ["received", "Received"], ["cancelled", "Cancelled"], ["all", "All"], ["draft", "Drafts", n("draft")]], f, "poFilter")}
        <span class="inv-spacer"></span>
        ${canMove ? '<button type="button" class="btn-primary" data-act="new-po">+ New purchase order</button>' : ""}
      </div>
      ${rows.length ? `<div class="po-list">${rows.map((po) => {
        const bits = [
          `Ordered ${niceDate(po.orderDate)}`,
          po.historical ? `received ${niceDate(po.receivedDate)} (before the portal)`
            : po.sentDate ? `sent ${niceDate(po.sentDate)}`
            : po.sentAt ? `sent ${when(po.sentAt)}` : "",
          `${po.lines.length} item${po.lines.length === 1 ? "" : "s"}`,
          po.requestIds.length && `${po.requestIds.length} request${po.requestIds.length === 1 ? "" : "s"}`,
          po.createdBy && `by ${po.createdBy}`,
        ].filter(Boolean);
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

    // Sends an open request to whoever the "New order requests" rule says now
  async function emailRequestAgain(r) {
    const btn = body.querySelector(`[data-req="email"][data-id="${CSS.escape(r.id)}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    try {
      const res = await callApi({ action: "inventory", op: "resendRequest", requestId: r.id });
      showToast(res.sent ? `${reqNumber(r)} emailed to ${res.sent} ${res.sent === 1 ? "person" : "people"}`
        : res.queued ? "It's queued and goes out in the next few minutes."
        : res.reason === "RULE_OFF" ? "The “New order requests” email rule is turned off. Turn it on in Inventory → Notifications."
        : res.reason === "NOT_OPEN" ? "This request isn't open any more."
        : "Nobody matched the email rule (it may be set to urgent only, or the people on it have no email). Check Inventory → Notifications.");
    } catch (err) {
      console.error("Email again failed:", err);
      showToast(errText(err, "Couldn't send it. Try again."));
    }
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "Email it again"; }
  }
  
  async function handleReq(id, act) {
    const r = st.requests.find((x) => x.id === id);
    if (!r) return;
    if (act === "email") { emailRequestAgain(r); return; }
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
    if (e.target.closest('[data-act="set-kit"]')) { openSetKit(); return; }
    if (e.target.closest('[data-act="kit-from-shelf"]')) { openSetKit("", "shelf"); return; }
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
    if (e.target.closest('[data-act="invoice-links"]')) { openInvoiceLinks({ staff }).then((ok) => { if (ok) load(); }); return; }
    if (e.target.closest('[data-act="export-products"]')) { exportProductsCsv(st.products, st.suppliers); return; }
    if (e.target.closest('[data-act="base-all"]')) {
      const list = st.products.filter((p) => p.active && st.bases.has(p.id));
      if (list.length) rebuildDialog(list, plural(list.length, "product"), { fromBases: true });
      return;
    }
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