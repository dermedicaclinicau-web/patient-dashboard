// Phase 4: receive a delivery against a purchase order.
//   #/inventory/receive        → choose which sent order the delivery is for
//   #/inventory/receive/<poId> → docket photo, what arrived, where it was put (storage, batch, expiry)
import {
  LOCATIONS, PO_STATUS, getPo, listPos, listProducts, listReceipts, receivePo, uploadDocket,
  syncReceivedRequests, plural, unitPlural, locLabel, expiryState,
} from "./inventory-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const niceDate = (d) => (d instanceof Date ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const left = (l) => Math.max(0, (l.qty || 0) - (l.received || 0));
const doseText = (l, n) => (l.dosePer && l.doseUnit ? ` (${+(n * l.dosePer).toFixed(2)} ${l.doseUnit})` : "");
const int = (v) => Math.max(0, parseInt(v, 10) || 0);
const sumOf = (s) => s.splits.reduce((a, x) => a + int(x.qty), 0);

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

  const back = `#/inventory/po/${encodeURIComponent(po.id)}`;
  const open = ["sent", "part"].includes(po.status);
  const prod = new Map(products.map((p) => [p.id, p]));
  const tracked = (l) => !!(prod.get(l.productId) || {}).tracked;
  const state = new Map(po.lines.map((l) => [l.key, { arrived: 0, splits: [] }]));
  let docketFile = null, docketUrl = "", uploaded = null, busy = false;

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
              <input data-f="arrived" type="number" min="0" step="1" inputmode="numeric" value="${s.arrived}" />
              <button type="button" data-act="plus" aria-label="One more">+</button></div>
            <small>${remaining} still to come</small></div>`
          : `<span class="rcv-chip ${remaining ? "" : "is-done"}">${remaining ? `${remaining} not received` : "All received"}</span>`}
      </div>
      <div data-role="splits">${splitsHtml(l)}</div>
      <div class="rcv-check" data-role="check"></div>
    </div>`;
  };

  const splitsHtml = (l) => {
    const s = state.get(l.key);
    if (!s.arrived) return "";
    if (!l.productId) return `<p class="rcv-note">Not linked to a product, so no stock changes. It's only ticked off the order.</p>`;
    const tr = tracked(l);
    return `<div class="rcv-splits">${s.splits.map((x, i) => `<div class="rcv-split${tr ? " is-tracked" : ""}" data-i="${i}">
        <label><span>Put in</span><select data-f="loc">${LOCATIONS.map((o) =>
          `<option value="${o.key}"${o.key === x.loc ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>
        ${tr ? `<label><span>Batch</span><input data-f="batch" value="${esc(x.batch)}" maxlength="40" autocapitalize="characters" autocomplete="off" placeholder="Lot / batch #" /></label>
          <label><span>Expiry</span><input data-f="expiry" type="date" value="${esc(x.expiry)}" /></label>` : ""}
        <label><span>${esc(unitPlural(l.stockUnit))}</span><input data-f="qty" type="number" min="0" step="1" inputmode="numeric" value="${x.qty}" /></label>
        ${s.splits.length > 1 ? `<button type="button" class="rcv-x" data-act="rm" aria-label="Remove this row">×</button>` : "<span></span>"}
        <span class="rcv-exp" data-role="exp"></span>
      </div>`).join("")}
      <button type="button" class="rcv-link" data-act="add">+ ${tr ? "Another batch or storage" : "Split between storages"}</button></div>`;
  };

  const recHtml = (r) => `<div class="rcv-rec"><div>
      <strong>${esc(niceDate(r.at))}</strong> · ${esc(r.by || "")}${r.docketNo ? ` · Docket ${esc(r.docketNo)}` : ""}${r.closed ? " · <em>order closed</em>" : ""}
      <small>${esc((r.lines || []).map((x) => `${x.arrived} × ${x.name}`).join(", "))}</small>
      ${r.note ? `<small>${esc(r.note)}</small>` : ""}</div>
    ${r.docket && r.docket.url ? `<a class="rcv-link" href="${esc(r.docket.url)}" target="_blank" rel="noopener">View docket</a>` : ""}</div>`;

  root.innerHTML = `<div class="rcv">
    <a class="rcv-back" href="${back}">← ${esc(po.number)}</a>
    <div class="rcv-head">
      <div><h1>Receive delivery</h1>
        <p class="muted">${esc([po.supplier.name, po.number, PO_STATUS[po.status], po.sentAt && `sent ${niceDate(po.sentAt)}`].filter(Boolean).join(" · "))}</p></div>
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
          <input data-role="docketNo" maxlength="60" autocomplete="off" /></label>
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
    card.querySelectorAll(".rcv-split").forEach((row) => {
      const x = s.splits[+row.dataset.i];
      const st = x && tracked(l) ? expiryState(x.expiry) : "";
      const exp = row.querySelector('[data-role="exp"]');
      exp.textContent = st === "expired" ? "Expiry date has passed" : st === "soon" ? "Expires within 60 days" : "";
      exp.className = `rcv-exp${st ? ` is-${st}` : ""}`;
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
    if (!s.arrived) s.splits = [];
    else if (!s.splits.length) s.splits = [{ loc: l.loc, batch: "", expiry: "", qty: need }];
    else if (s.splits.length === 1) s.splits[0].qty = need;
    const inp = cardOf(l).querySelector('[data-f="arrived"]');
    if (inp && !fromInput) inp.value = s.arrived;
    drawSplits(l);
  }

  function drawSum() {
    const el = $('[data-role="sum"]');
    if (!el) return;
    const got = po.lines.filter((l) => state.get(l.key).arrived > 0);
    el.textContent = got.length
      ? `Receiving ${got.length} line${got.length === 1 ? "" : "s"}`
      : "Nothing entered yet";
  }

  function drawDocket() {
    const box = $('[data-role="photo"]');
    if (!box) return;
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
      const other = s.splits.length && !tracked(l) ? (s.splits[0].loc === "shelf" ? "jt" : "shelf") : l.loc;
      s.splits.push({ loc: other, batch: "", expiry: "", qty: Math.max(0, s.arrived * l.packSize - sumOf(s)) });
      drawSplits(l);
    } else if (act === "rm") {
      s.splits.splice(+b.closest(".rcv-split").dataset.i, 1);
      drawSplits(l);
    } else if (act === "zoom") b.closest(".rcv-photo").classList.toggle("is-zoom");
    else if (act === "clear-docket") {
      if (docketUrl) URL.revokeObjectURL(docketUrl);
      docketFile = null; docketUrl = ""; uploaded = null;
      drawDocket();
    } else if (act === "save") submit();
  });

  root.addEventListener("input", (e) => {
    const f = e.target.dataset && e.target.dataset.f;
    if (!f) return;
    const l = lineOf(e.target);
    if (!l) return;
    const s = state.get(l.key);
    if (f === "arrived") return setArrived(l, int(e.target.value), true);
    const row = e.target.closest(".rcv-split");
    const x = row && s.splits[+row.dataset.i];
    if (!x) return;
    x[f] = f === "qty" ? int(e.target.value) : e.target.value;
    drawCheck(l);
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
      if (tracked(l) && s.splits.some((x) => int(x.qty) && (!String(x.batch).trim() || !x.expiry))) {
        return toast(`${l.name} needs a batch number and expiry date.`, true);
      }
    }
    const expired = picked.filter(({ l, s }) => tracked(l) && s.splits.some((x) => expiryState(x.expiry) === "expired"));
    if (expired.length && !confirm(`${expired.map((x) => x.l.name).join(", ")}: an expiry date has already passed. Receive anyway?`)) return;
    const over = picked.filter(({ l, s }) => s.arrived > left(l));
    if (over.length && !confirm(`More arrived than was still to come for ${over.map((x) => x.l.name).join(", ")}. Receive anyway?`)) return;
    if (close && !confirm("Close this order? Anything not delivered won't be expected any more.")) return;
    if (!docketFile && picked.length && !confirm("No docket photo has been added. Receive without one?")) return;

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
        lines: picked.map(({ l, s }) => ({ key: l.key, arrived: s.arrived, splits: s.splits })),
      }, staff);
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

  drawDocket();
  po.lines.forEach((l) => drawCheck(l));
}

async function mountPicker(root) {
  root.innerHTML = `<div class="rcv">
    <a class="rcv-back" href="#/inventory/orders">← Purchase orders</a>
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