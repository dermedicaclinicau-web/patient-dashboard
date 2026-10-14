// Phase 4: receive a delivery against a purchase order.
//   #/inventory/receive        → choose which sent order the delivery is for
//   #/inventory/receive/<poId> → docket photo, what arrived, where it went (Shelf | JT storage, batch, expiry)
import {
  LOCATIONS, PO_STATUS, getPo, listPos, listProducts, listReceipts, receivePo, uploadDocket,
  syncReceivedRequests, plural, unitPlural, locLabel, expiryState, batchName,
} from "./inventory-api.js";
import { can } from "./perms.js";
import { linkDocketReceipt } from "./scanner-api.js";

// Came from the Scanner? The scanned docket for this order (used once)
function takeDocketPrefill(poId) {
  let pre = null;
  try { pre = JSON.parse(sessionStorage.getItem("docketPrefill") || "null"); } catch { pre = null; }
  if (!pre || pre.poId !== poId) return null;
  sessionStorage.removeItem("docketPrefill");
  return pre;
}
// "2027-05" → "2027-05-31" (the date box needs a day)
function fullExpiry(e) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(e || "")) return e;
  const m = /^(\d{4})-(\d{2})$/.exec(e || "");
  return m ? `${m[1]}-${m[2]}-${String(new Date(+m[1], +m[2], 0).getDate()).padStart(2, "0")}` : "";
}

// "vial" / "vials", "box" / "boxes" are the same unit
const unitKey = (x) => String(x || "").trim().toLowerCase();
const sameUnit = (a, b) => {
  const x = unitKey(a), y = unitKey(b);
  return !!x && !!y && (x === y || `${x}s` === y || `${y}s` === x || `${x}es` === y || `${y}es` === x);
};
// A docket line in stock units: counted in single items (e.g. "20 syringes") → as is;
// counted in the order unit ("2 boxes") or no unit read → × pack size
const stockUnitsOf = (d, l) => (l.packSize > 1 && sameUnit(d.unit, l.stockUnit) && !sameUnit(d.unit, l.orderUnit)
  ? d.qty : d.qty * l.packSize);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const niceDate = (d) => (d instanceof Date ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const left = (l) => Math.max(0, (l.qty || 0) - (l.received || 0));
const doseText = (l, n) => (l.dosePer && l.doseUnit ? ` (${+(n * l.dosePer).toFixed(2)} ${l.doseUnit})` : "");
const int = (v) => Math.max(0, parseInt(v, 10) || 0);

// Each line's "where it went" is a list of rows: { batch, expiry, q: { shelf: n, jt: n } }
const rowQty = (r) => LOCATIONS.reduce((a, o) => a + int(r.q[o.key]), 0);
const sumOf = (s) => s.rows.reduce((a, r) => a + rowQty(r), 0);
const newRow = (loc, n) => ({ batch: "", expiry: "", q: Object.fromEntries(LOCATIONS.map((o) => [o.key, o.key === loc ? n : 0])) });
// One row: the storage it was ordered for takes whatever the others don't
function balance(r, keep, need) {
  const others = LOCATIONS.filter((o) => o.key !== keep).reduce((a, o) => a + int(r.q[o.key]), 0);
  if (others > need) { LOCATIONS.forEach((o) => { r.q[o.key] = 0; }); r.q[keep] = need; }
  else r.q[keep] = need - others;
}
// The rows as the splits receivePo expects (empty boxes left out)
const toSplits = (s) => s.rows.flatMap((r) => LOCATIONS.filter((o) => int(r.q[o.key]) > 0)
  .map((o) => ({ loc: o.key, batch: r.batch, expiry: r.expiry, qty: int(r.q[o.key]) })));

// The ordering team goes back to the purchase order; everyone else back to the list of deliveries
const canOrders = () => can("inventory.order") || can("inventory.manage");

function toast(msg, bad = false) {
  const t = document.createElement("div");
  t.className = `rcv-toast${bad ? " is-bad" : ""}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 4000);
}

export async function mountReceivePo(root, poId, staff) {
  if (!poId) return mountPicker(root);
  root.innerHTML = `<div class="rcv"><p class="muted">Loading order…</p></div>`;

  let po, products, receipts;
  try {
    [po, products, receipts] = await Promise.all([getPo(poId), listProducts(), listReceipts(poId).catch(() => [])]);
  } catch (e) {
    root.innerHTML = `<div class="rcv"><p class="rcv-banner is-bad">${esc(e.message || "Couldn't load this order.")}</p></div>`;
    return;
  }
  if (!po) {
    root.innerHTML = `<div class="rcv"><a class="rcv-back" href="#/inventory/receive">← Receive a delivery</a>
      <p class="rcv-banner is-bad">This purchase order doesn't exist.</p></div>`;
    return;
  }

  const back = canOrders() ? `#/inventory/po/${encodeURIComponent(po.id)}` : "#/inventory/receive";
  const open = ["sent", "part"].includes(po.status);
  const prod = new Map(products.map((p) => [p.id, p]));
  const tracked = (l) => !!(prod.get(l.productId) || {}).tracked;
  const home = (l) => (LOCATIONS.some((o) => o.key === l.loc) ? l.loc : LOCATIONS[0].key);
  const state = new Map(po.lines.map((l) => [l.key, { arrived: 0, rows: [] }]));
  let docketFile = null, docketUrl = "", uploaded = null, busy = false, fromDocket = null;

  const lineHtml = (l) => {
    const s = state.get(l.key);
    const remaining = left(l);
    const ordered = `Ordered ${plural(l.qty, l.orderUnit)}${l.packSize > 1 ? ` of ${plural(l.packSize, l.stockUnit)}` : ""}`;
    const info = [l.supplierCode && `Code ${l.supplierCode}`, ordered, l.received ? `${l.received} already in` : "", `for ${locLabel(l.loc)}`];
    return `<div class="rcv-line${remaining ? "" : " is-done"}" data-key="${esc(l.key)}">
      <div class="rcv-line-head">
        <div class="rcv-line-name"><strong>${esc(l.name)}</strong>
          <small>${esc(info.filter(Boolean).join(" · "))}</small></div>
        ${open && remaining ? `<div class="rcv-arrived"><span>${esc(unitPlural(l.orderUnit))} arrived</span>
            <div class="rcv-step"><button type="button" data-act="minus" aria-label="One less">−</button>
              <input data-f="arrived" type="number" min="0" step="1" inputmode="numeric" value="${s.arrived}" aria-label="How many arrived" />
              <button type="button" data-act="plus" aria-label="One more">+</button></div>
            <small>${remaining} still to come</small></div>`
          : `<span class="rcv-chip ${remaining ? "" : "is-done"}">${remaining ? `${remaining} not received` : "All received"}</span>`}
      </div>
      <div data-role="splits">${splitsHtml(l)}</div>
      <div class="rcv-check" data-role="check"></div>
    </div>`;
  };

  // Where it went: Shelf | JT storage side by side (and a batch + expiry per row for tracked products)
  const splitsHtml = (l) => {
    const s = state.get(l.key);
    if (!s.arrived) return "";
    if (!l.productId) return `<p class="rcv-note">Not linked to a product, so no stock changes. It's only ticked off the order.</p>`;
    const tr = tracked(l);
    const bn = tr ? batchName(prod.get(l.productId)) : "";
    const cls = `rcv-pa-row${tr ? " is-tracked" : ""}`;
    return `<div class="rcv-pa">
      <div class="rcv-pa-title">Where it's going <small>(${esc(unitPlural(l.stockUnit))})</small></div>
      <div class="${cls} rcv-pa-head" aria-hidden="true">
        ${tr ? `<span>${esc(bn)}</span><span>Expiry</span>` : ""}
        ${LOCATIONS.map((o) => `<span>${esc(o.label)}${o.key === home(l) ? " <small>ordered for</small>" : ""}</span>`).join("")}
        <span></span>
      </div>
      ${s.rows.map((r, i) => `<div class="${cls}" data-i="${i}">
        ${tr ? `<input data-f="batch" value="${esc(r.batch)}" maxlength="40" autocapitalize="characters" autocomplete="off"
            placeholder="${esc(bn)} #" aria-label="${esc(bn)} number" />
          <input data-f="expiry" type="date" value="${esc(r.expiry)}" aria-label="Expiry date" />` : ""}
        ${LOCATIONS.map((o) => `<input data-f="q" data-loc="${o.key}" class="${o.key === home(l) ? "is-for" : ""}" type="number"
            min="0" step="1" inputmode="numeric" value="${int(r.q[o.key])}" aria-label="${esc(o.label)}" />`).join("")}
        ${s.rows.length > 1 ? `<button type="button" class="rcv-x" data-act="rm" aria-label="Remove this row" title="Remove">×</button>` : "<span></span>"}
        <span class="rcv-exp" data-role="exp"></span>
      </div>`).join("")}
      ${tr ? `<button type="button" class="rcv-link" data-act="add">+ Another ${esc(bn.toLowerCase())}</button>` : ""}
    </div>`;
  };

  const recHtml = (r) => `<div class="rcv-rec"><div>
      <strong>${esc(niceDate(r.receivedAt ? new Date(r.receivedAt) : r.at))}</strong> · received by ${esc(r.receivedBy || r.by || "")}${
        r.docketNo ? ` · Docket ${esc(r.docketNo)}` : ""}${r.closed ? " · <em>order closed</em>" : ""}
      <small>${esc((r.lines || []).map((x) => `${x.arrived} × ${x.name}`).join(", "))}</small>
      ${r.note ? `<small>${esc(r.note)}</small>` : ""}</div>
    ${r.docket && r.docket.url ? `<a class="rcv-link" href="${esc(r.docket.url)}" target="_blank" rel="noopener">View docket</a>` : ""}</div>`;

  const subtitle = [po.supplier.name, po.number,
    po.status === "sent" && po.sentAt ? `Sent ${niceDate(po.sentAt)}`
      : [PO_STATUS[po.status], po.sentAt && `sent ${niceDate(po.sentAt)}`].filter(Boolean).join(", ")].filter(Boolean).join(" · ");

  root.innerHTML = `<div class="rcv">
    <a class="rcv-back" href="${back}">← ${esc(canOrders() ? po.number : "Receive a delivery")}</a>
    <div class="rcv-head">
      <div><h1>Receive delivery</h1><p class="muted">${esc(subtitle)}</p></div>
      ${open ? `<button type="button" class="rcv-btn" data-act="all">Everything arrived</button>` : ""}
    </div>
    ${open ? "" : `<p class="rcv-banner">This order is ${esc(PO_STATUS[po.status].toLowerCase())}, so stock can't be received on it.${
      po.status === "draft" ? " Send it (or mark it as sent) first." : ""}</p>`}
    <div class="rcv-grid${open ? "" : " is-closed"}">
      ${open ? `<aside class="rcv-docket">
        <h2>Docket</h2>
        <div class="rcv-photo" data-role="photo"></div>
        <div class="rcv-photo-btns">
          <label class="rcv-btn">Take photo<input type="file" accept="image/*" capture="environment" hidden data-role="cam" /></label>
          <label class="rcv-btn">Choose file<input type="file" accept="image/*,application/pdf" hidden data-role="file" /></label>
        </div>
        <label class="lh-field"><span class="lh-label">Docket or invoice number</span>
          <input type="text" data-role="docketNo" maxlength="60" autocomplete="off"
            data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" /></label>
      </aside>` : ""}
      <section class="rcv-main">
        <div data-role="lines">${po.lines.map(lineHtml).join("")}</div>
        ${open ? `<div class="rcv-foot">
          <label class="lh-field"><span class="lh-label">Note (optional)</span>
            <textarea data-role="note" rows="2" maxlength="1000" placeholder="e.g. One box damaged, replacement coming"></textarea></label>
          <label class="rcv-close"><input type="checkbox" data-role="close" />
            <span>Nothing more is coming on this order, so close it
            <small>Anything not delivered won't be expected any more. Its requests stay Ordered.</small></span></label>
          <div class="rcv-submit"><span class="muted" data-role="sum">Nothing entered yet</span>
            <button type="button" class="rcv-btn rcv-btn--primary" data-act="save">Receive stock</button></div>
        </div>` : ""}
        ${receipts.length ? `<h2 class="rcv-h2">Deliveries on this order</h2>${receipts.map(recHtml).join("")}` : ""}
      </section>
    </div>
  </div>`;

  const $ = (sel) => root.querySelector(sel);
  const cardOf = (l) => root.querySelector(`.rcv-line[data-key="${CSS.escape(l.key)}"]`);
  const lineOf = (el) => { const c = el.closest(".rcv-line"); return c ? po.lines.find((x) => x.key === c.dataset.key) : null; };

  function drawCheck(l) {
    const card = cardOf(l);
    if (!card) return;
    const s = state.get(l.key);
    const box = card.querySelector('[data-role="check"]');
    card.querySelectorAll(".rcv-pa-row[data-i]").forEach((row) => {
      const r = s.rows[+row.dataset.i];
      const ex = r && tracked(l) && rowQty(r) ? expiryState(r.expiry) : "";
      const el = row.querySelector('[data-role="exp"]');
      el.textContent = ex === "expired" ? "Expiry date has passed" : ex === "soon" ? "Expires within 60 days" : "";
      el.className = `rcv-exp${ex ? ` is-${ex}` : ""}`;
    });
    if (!s.arrived || !l.productId) { box.innerHTML = ""; drawSum(); return; }
    const need = s.arrived * l.packSize;
    const put = sumOf(s);
    const over = s.arrived > left(l) ? ` <span class="rcv-warn">More than was still to come</span>` : "";
    box.innerHTML = put === need
      ? `<span class="rcv-ok">✓ ${esc(plural(need, l.stockUnit))}${esc(doseText(l, need))} put away</span>${over}`
      : `<span class="rcv-warn">${put} of ${esc(plural(need, l.stockUnit))} put away</span>${over}`;
    drawSum();
  }

  function drawSplits(l) {
    const card = cardOf(l);
    if (!card) return;
    card.querySelector('[data-role="splits"]').innerHTML = splitsHtml(l);
    drawCheck(l);
  }

  function setArrived(l, n, fromInput = false) {
    const s = state.get(l.key);
    s.arrived = Math.max(0, Math.min(9999, n));
    const need = s.arrived * l.packSize;
    if (!s.arrived) s.rows = [];
    else if (!s.rows.length) s.rows = [newRow(home(l), need)];
    else if (s.rows.length === 1) balance(s.rows[0], home(l), need);
    const inp = cardOf(l).querySelector('[data-f="arrived"]');
    if (inp && !fromInput) inp.value = s.arrived;
    drawSplits(l);
  }

  function drawSum() {
    const el = $('[data-role="sum"]');
    if (!el) return;
    const got = po.lines.filter((l) => state.get(l.key).arrived > 0);
    el.textContent = got.length ? `Receiving ${got.length} line${got.length === 1 ? "" : "s"}` : "Nothing entered yet";
  }

  function drawDocket() {
    const box = $('[data-role="photo"]');
    if (!box) return;
    if (!docketFile && uploaded && uploaded.url) {   // the scanned docket, already saved
      box.innerHTML = `<img src="${esc(uploaded.url)}" alt="Docket" data-act="zoom" />
        <button type="button" class="rcv-link" data-act="clear-docket">Remove</button>`;
      return;
    }
    if (!docketFile) { box.innerHTML = `<p class="muted">No docket yet. Photograph it so it's kept with this order.</p>`; return; }
    const isPdf = docketFile.type === "application/pdf";
    box.innerHTML = `${isPdf
      ? `<div class="rcv-pdf">PDF · ${esc(docketFile.name)}</div>`
      : `<img src="${docketUrl}" alt="Docket" data-act="zoom" />`}
      <button type="button" class="rcv-link" data-act="clear-docket">Remove</button>`;
  }

  ["cam", "file"].forEach((role) => {
    const inp = $(`[data-role="${role}"]`);
    if (!inp) return;
    inp.addEventListener("change", () => {
      const f = inp.files && inp.files[0];
      inp.value = "";
      if (!f) return;
      if (docketUrl) URL.revokeObjectURL(docketUrl);
      docketFile = f;
      docketUrl = URL.createObjectURL(f);
      uploaded = null;
      drawDocket();
    });
  });

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !root.contains(b)) return;
    const act = b.dataset.act;
    const l = lineOf(b);
    const s = l && state.get(l.key);
    if (act === "all") po.lines.forEach((x) => { if (left(x)) setArrived(x, left(x)); });
    else if (act === "plus") setArrived(l, s.arrived + 1);
    else if (act === "minus") setArrived(l, s.arrived - 1);
    else if (act === "add") {
      s.rows.push(newRow(home(l), Math.max(0, s.arrived * l.packSize - sumOf(s))));
      drawSplits(l);
      const rows = cardOf(l).querySelectorAll('[data-f="batch"]');
      if (rows.length) rows[rows.length - 1].focus();
    } else if (act === "rm") {
      s.rows.splice(+b.closest(".rcv-pa-row").dataset.i, 1);
      drawSplits(l);
    } else if (act === "zoom") b.closest(".rcv-photo").classList.toggle("is-zoom");
    else if (act === "clear-docket") {
      if (docketUrl) URL.revokeObjectURL(docketUrl);
      docketFile = null; docketUrl = ""; uploaded = null;
      drawDocket();
    } else if (act === "save") submit();
  });

  root.addEventListener("input", (e) => {
    const t = e.target;
    const f = t.dataset && t.dataset.f;
    if (!f) return;
    const l = lineOf(t);
    if (!l) return;
    const s = state.get(l.key);
    if (f === "arrived") return setArrived(l, int(t.value), true);
    const rowEl = t.closest(".rcv-pa-row[data-i]");
    const r = rowEl && s.rows[+rowEl.dataset.i];
    if (!r) return;
    if (f === "q") {
      const loc = t.dataset.loc;
      r.q[loc] = int(t.value);
      // One row, two storages: the other box takes the rest
      if (s.rows.length === 1 && LOCATIONS.length === 2 && t.value !== "") {
        const other = LOCATIONS.find((o) => o.key !== loc).key;
        r.q[other] = Math.max(0, s.arrived * l.packSize - r.q[loc]);
        const oi = rowEl.querySelector(`[data-loc="${other}"]`);
        if (oi) oi.value = r.q[other];
      }
    } else r[f] = t.value;
    drawCheck(l);
  });

  // Clicking into a number box selects it, so typing replaces the 0
  root.addEventListener("focusin", (e) => {
    if (e.target.matches('[data-f="q"], [data-f="arrived"]')) e.target.select();
  });

  async function submit() {
    if (busy) return;
    const btn = $('[data-act="save"]');
    const picked = po.lines.map((l) => ({ l, s: state.get(l.key) })).filter((x) => x.s.arrived > 0);
    const close = $('[data-role="close"]').checked;
    if (!picked.length && !close) return toast("Enter what arrived first, or tick “Nothing more is coming”.", true);

    for (const { l, s } of picked) {
      if (!l.productId) continue;
      const need = s.arrived * l.packSize, put = sumOf(s);
      if (put !== need) return toast(`${l.name}: ${plural(need, l.stockUnit)} arrived, but ${put} have been put away.`, true);
      if (tracked(l)) {
        const label = batchName(prod.get(l.productId)).toLowerCase();
        const card = cardOf(l);
        const badDate = card && [...card.querySelectorAll('[data-f="expiry"]')].some((i) => i.validity && i.validity.badInput);
        if (badDate) return toast(`${l.name}: an expiry date doesn't exist. Check the day (e.g. September has 30 days).`, true);
        if (s.rows.some((r) => rowQty(r) && !String(r.batch).trim())) return toast(`${l.name}: enter the ${label} number.`, true);
        if (s.rows.some((r) => rowQty(r) && !r.expiry)) return toast(`${l.name}: enter the expiry date.`, true);
      }
    }
    const expired = picked.filter(({ l, s }) => tracked(l) && s.rows.some((r) => rowQty(r) && expiryState(r.expiry) === "expired"));
    if (expired.length && !confirm(`${expired.map((x) => x.l.name).join(", ")}: an expiry date has already passed. Receive anyway?`)) return;
    const over = picked.filter(({ l, s }) => s.arrived > left(l));
    if (over.length && !confirm(`More arrived than was still to come for ${over.map((x) => x.l.name).join(", ")}. Receive anyway?`)) return;
    if (close && !confirm("Close this order? Anything not delivered won't be expected any more.")) return;
    if (!docketFile && !uploaded && picked.length && !confirm("No docket photo has been added. Receive without one?")) return;

    busy = true;
    btn.disabled = true;
    try {
      if (docketFile && !uploaded) {
        btn.textContent = "Uploading docket…";
        uploaded = await uploadDocket(po.id, docketFile);       // kept, so a retry doesn't upload twice
      }
      btn.textContent = "Saving…";
      const res = await receivePo(po.id, {
        docketNo: $('[data-role="docketNo"]').value,
        note: $('[data-role="note"]').value,
        docket: uploaded,
        close,
        lines: picked.map(({ l, s }) => ({ key: l.key, arrived: s.arrived, splits: toSplits(s) })),
        scanId: fromDocket ? fromDocket.scanId : "",
        receivedBy: fromDocket ? fromDocket.receivedBy : "",
        receivedByUid: fromDocket ? fromDocket.receivedByUid : "",
        receivedAt: fromDocket ? fromDocket.receivedAt : "",
      }, staff);
      if (fromDocket && fromDocket.scanId) {
        linkDocketReceipt(fromDocket.scanId, res.receiptId).catch((err) => console.warn("Docket scan not linked to the delivery:", err));
      }
      let done = [];
      try { done = await syncReceivedRequests(res.requestIds, staff); } catch (err) { console.warn("Requests not updated", err); }
      toast(`${res.status === "received" ? `${res.number} is fully received` : "Delivery received"}.${
        done.length ? ` ${done.length} request${done.length === 1 ? "" : "s"} marked Received.` : ""}`);
      if (docketUrl) URL.revokeObjectURL(docketUrl);
      location.hash = back;
    } catch (err) {
      console.error(err);
      toast(err.message || "Couldn't receive this delivery.", true);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = "Receive stock";
    }
  }

  // From the Scanner: what the docket says arrived, its batches and expiries, ready to check
  function applyPrefill(pre) {
    fromDocket = pre;
    const byProduct = new Map();
    (pre.lines || []).forEach((d) => {
      if (d.productId && d.qty > 0) byProduct.set(d.productId, [...(byProduct.get(d.productId) || []), d]);
    });
    let filled = 0;
    byProduct.forEach((list, pid) => {
      const l = po.lines.find((x) => x.productId === pid && left(x) > 0);
      if (!l) return;
      const units = list.map((d) => stockUnitsOf(d, l));
      const total = units.reduce((a, n) => a + n, 0);
      // Order units arrived (rounded up). If the docket isn't a whole number of packs,
      // the "put away" check shows the mismatch so it can be fixed before saving.
      setArrived(l, Math.max(1, Math.ceil(total / l.packSize)));
      const s = state.get(l.key);
      s.rows = tracked(l)
        ? list.map((d, i) => ({ ...newRow(home(l), units[i]), batch: String(d.batch || ""), expiry: fullExpiry(d.expiry) }))
        : [newRow(home(l), total)];
      drawSplits(l);
      filled++;
    });
    
    const dn = $('[data-role="docketNo"]');
    if (dn && pre.docketNumber) dn.value = pre.docketNumber;
    const nt = $('[data-role="note"]');
    if (nt && pre.note) nt.value = pre.note;
    if (pre.photoUrl) uploaded = { path: pre.photoPath || "", url: pre.photoUrl, type: "image" };
    const when = pre.receivedAt ? new Date(pre.receivedAt) : null;
    const main = $(".rcv-main");
    if (main) main.insertAdjacentHTML("afterbegin", `<p class="rcv-banner is-info">Filled in from the scanned docket${
      pre.docketNumber ? ` ${esc(pre.docketNumber)}` : ""}${pre.receivedBy ? ` · received by ${esc(pre.receivedBy)}` : ""}${
      when && !isNaN(when) ? ` · ${esc(when.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}` : ""}.
      ${filled ? `${filled} line${filled === 1 ? "" : "s"} filled in.` : "None of the docket's products are still to come on this order."}
      Check the numbers, then press Receive stock.</p>`);
  }

  const pre = takeDocketPrefill(po.id);
  if (pre && open) applyPrefill(pre);
  drawDocket();
  po.lines.forEach((l) => drawCheck(l));
}

async function mountPicker(root) {
  root.innerHTML = `<div class="rcv">
    ${canOrders() ? '<a class="rcv-back" href="#/inventory/orders">← Purchase orders</a>' : ""}
    <h1>Receive a delivery</h1>
    <p class="muted">Which order is this delivery for? Match the supplier, or the PO number printed on the docket.</p>
    <input class="rcv-search" type="search" placeholder="Search supplier or PO number" data-role="q" />
    <div class="rcv-pick" data-role="list"><p class="muted">Loading…</p></div>
  </div>`;
  const list = root.querySelector('[data-role="list"]');
  let pos;
  try {
    pos = (await listPos()).filter((p) => ["sent", "part"].includes(p.status));
  } catch (e) {
    list.innerHTML = `<p class="rcv-banner is-bad">${esc(e.message || "Couldn't load orders.")}</p>`;
    return;
  }
  const draw = (q = "") => {
    const s = q.trim().toLowerCase();
    const rows = pos.filter((p) => !s || p.number.toLowerCase().includes(s) || p.supplier.name.toLowerCase().includes(s));
    list.innerHTML = rows.length ? rows.map((p) => {
      const waiting = p.lines.filter((l) => left(l) > 0).length;
      return `<a class="rcv-pick-row" href="#/inventory/receive/${encodeURIComponent(p.id)}">
        <span><strong>${esc(p.supplier.name || "No supplier")}</strong>
          <small>${esc([p.number, p.sentAt && `sent ${niceDate(p.sentAt)}`, p.expectedDate && `expected ${p.expectedDate}`].filter(Boolean).join(" · "))}</small></span>
        <span class="muted">${waiting} line${waiting === 1 ? "" : "s"} waiting</span>
        <span class="rcv-chip${p.status === "part" ? " is-part" : ""}">${esc(PO_STATUS[p.status])}</span></a>`;
    }).join("") : `<p class="muted">${pos.length ? "No order matches that."
      : "No orders are waiting for delivery. An order has to be sent, or marked as sent, before stock can be received on it."}</p>`;
  };
  root.querySelector('[data-role="q"]').addEventListener("input", (e) => draw(e.target.value));
  draw();
}