// Delivery docket result (Scanner → Delivery docket): who sent it, who received it and when, and which open
// purchase order it's for. "Receive this order" saves the docket and opens that order to receive it,
// with the docket's quantities, batches and expiries handed over (sessionStorage "docketPrefill").
// The Dermedica Delivery Docket Form can instead be an internal transfer: JT storage → Shelf, confirmed here.
import { auth } from "./firebase-config.js";
import {
  INV_CATEGORIES, batchName, batchText, plural, unitPlural, listAllLots, findJtLot, transferFromJt, listReleases,
} from "./inventory-api.js";
import {
  reviewDocket, rankPos, listOpenPos, poSupplier, staffList, matchStaff, saveDocketScan, markDocketTransferred,
} from "./scanner-api.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = (n) => String(n).padStart(2, "0");
const localDT = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const keyOf = (d) => (d instanceof Date && !isNaN(d) ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : "");
// "today", "yesterday", "12 days ago"
const ago = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return "";
  const now = new Date();
  const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};
// The date box needs a day: "2027-05" → "2027-05-31"
const fullExpiry = (e) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(e || "")) return e;
  const m = /^(\d{4})-(\d{2})$/.exec(e || "");
  return m ? `${m[1]}-${m[2]}-${pad2(new Date(+m[1], +m[2], 0).getDate())}` : "";
};

export function mountDocketResult(el, { photo, photoUrl, result, products, staff, onAgain }) {
  const myUid = (auth.currentUser && auth.currentUser.uid) || "";
  const byId = new Map(products.map((p) => [p.id, p]));
  const review = reviewDocket(result, products);
  const s = { review, pos: [], ranked: [], people: [], poId: "", showAll: false,
    recvUid: myUid, recvAt: localDT(new Date()), fixing: -1, busy: false, posError: "", note: "", big: false,
    // "transfer": the Dermedica form with "Internal transfer from JT store" ticked
    mode: review.transferType === "transfer" ? "transfer" : "delivery",
    lots: [], lotsError: "", rels: [], scanId: "" };

  const selected = () => (s.ranked.find((r) => r.po.id === s.poId) || {}).po || null;
  const idsOn = (po) => new Set(((po && po.lines) || []).map((l) => l.productId).filter(Boolean));
  const rerank = () => { s.ranked = rankPos(s.review, s.pos); };

  async function init() {
    el.innerHTML = '<p class="dk-muted">Reading the docket…</p>';
    const [pos, people, lots, rels] = await Promise.all([
      listOpenPos().catch((err) => {
        console.warn("Open purchase orders didn't load:", err);
        s.posError = err && err.code === "permission-denied"
          ? "You don't have access to purchase orders. Save the docket, and someone on the ordering team can receive it."
          : "Couldn't load the open purchase orders. Check your connection.";
        return [];
      }),
      staffList().catch(() => []),
      listAllLots().catch((err) => {
        console.warn("Stock batches didn't load:", err);
        s.lotsError = "Couldn't load what's in JT storage. Check your connection, then scan again.";
        return [];
      }),
      listReleases(100).then((list) => list.filter((r) => r.status === "pending")).catch(() => []),
    ]);
    s.pos = pos;
    s.people = people;
    s.lots = lots;
    s.rels = rels;
    rerank();
    const top = s.ranked[0];
    if (top && (top.numberMatch || top.supplierMatch)) s.poId = top.po.id;
    const read = matchStaff(s.review.receivedByText, people);
    if (read) s.recvUid = read.id;
    if (s.review.receivedDate) s.recvAt = `${s.review.receivedDate}T${s.review.receivedTime || localDT(new Date()).slice(11)}`;
    draw();
  }

  const fixHtml = (l, i) => `<select class="fb-select scan-fix" data-dkfixsel="${i}" aria-label="Which product is it?">
      <option value="">Not on the product list</option>
      ${INV_CATEGORIES.map((c) => {
        const g = products.filter((p) => p.category === c.key);
        return g.length ? `<optgroup label="${esc(c.label)}">${g.map((p) =>
          `<option value="${esc(p.id)}"${p.id === l.productId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>` : "";
      }).join("")}
    </select>`;

  /* ---------- New delivery: lines against a purchase order ---------- */

  // extra = on the docket but not on the chosen order (still received, if staff want it)
  const lineHtml = (l, i, extra = false) => {
    const p = byId.get(l.productId);
    const flags = [];
    if (extra) {
      if (l.skip) flags.push(["info", "Not being received"]);
      else if (!p) flags.push(["bad", "Choose the product, or tap “Don't receive this”"]);
      else flags.push(["warn", "Extra: not on this order"]);
    } else if (!p) flags.push(["bad", "Not matched to a product"]);
    if (p && !l.skip && !l.fixed && l.conf < 0.6) flags.push(["warn", "Check this is the right product"]);
    if (!l.skip && !l.qty) flags.push(["warn", "None supplied (back-ordered?)"]);
    const bad = flags.some((f) => f[0] === "bad");
    const name = p ? p.name : "this line";
    return `<div class="dk-row${l.skip ? " is-skip" : bad ? " is-bad" : flags.length ? " is-warn" : ""}" data-row="${i}">
      <div class="dk-main">
        <button type="button" class="scan-name" data-dkfix="${i}">${esc(p ? p.name : "Not matched")}<small>change</small></button>
        <small>${esc(l.text)}${l.code ? ` · ${esc(l.code)}` : ""}${l.count > 1 ? ` · ${l.count} lines on the docket` : ""}${
          l.edited ? ' <em class="dk-edited">edited</em>' : ""}</small>
        ${flags.map(([t, m]) => `<span class="scan-flag is-${t}">${esc(m)}</span>`).join("")}
        ${extra ? `<button type="button" class="scan-pat-btn dk-skip" data-dkskip="${i}">${l.skip ? "Receive this after all" : "Don't receive this"}</button>` : ""}
        ${s.fixing === i ? fixHtml(l, i) : ""}
      </div>
      ${l.skip ? "" : `<div class="dk-fields">
        <label class="dk-f dk-f-qty"><span>Qty${l.unit ? ` <small>${esc(l.unit)}</small>` : ""}</span>
          <input class="dk-input" type="number" min="0" max="9999" step="1" inputmode="numeric" data-dkq="${i}"
            value="${l.qty}" aria-label="Quantity of ${esc(name)}" /></label>
        ${p && p.tracked ? `
        <label class="dk-f dk-f-batch"><span>${esc(batchName(p))}</span>
          <input class="dk-input" maxlength="40" autocapitalize="characters" autocomplete="off" data-dkb="${i}"
            value="${esc(l.batch)}" placeholder="–" aria-label="${esc(batchName(p))} of ${esc(name)}" /></label>
        <label class="dk-f dk-f-exp"><span>Expiry</span>
          <input class="dk-input" type="date" data-dke="${i}" value="${esc(fullExpiry(l.expiry))}" aria-label="Expiry of ${esc(name)}" /></label>` : ""}
      </div>`}
    </div>`;
  };
  // Which docket lines are on the chosen order, and which are extra
  const splitLines = (po) => {
    const rows = s.review.lines.map((l, i) => ({ l, i }));
    if (!po) return { main: rows, extra: [] };
    const on = idsOn(po);
    const isOn = ({ l }) => !!l.productId && on.has(l.productId);
    return { main: rows.filter(isOn), extra: rows.filter((x) => !isOn(x)) };
  };

  const poHtml = (r) => {
    const po = r.po;
    const n = (po.lines || []).length;
    const docketProducts = s.review.lines.filter((l) => l.productId).length;
    const tags = [r.numberMatch && "PO number on the docket", r.supplierMatch && "Same supplier",
      r.hits && `${r.hits} of ${docketProducts} docket products on it`].filter(Boolean);
    // Who ordered it and when: whoever receives it often isn't the person who sent it
    const orderKey = po.orderDate || keyOf(po.createdAt);
    const ordered = orderKey ? `Ordered ${niceDate(orderKey)} (${ago(orderKey)})${po.createdBy ? ` by ${po.createdBy}` : ""}` : "";
    const sentKey = po.sentDate || keyOf(po.sentAt);
    const sent = sentKey ? `Sent ${niceDate(sentKey)}${po.sentBy ? ` by ${po.sentBy}` : ""}${po.sentVia ? ` · ${po.sentVia}` : ""}` : "";
    const facts = [po.status === "part" ? "Part received" : "", po.expectedDate && `Needed by ${niceDate(po.expectedDate) || po.expectedDate}`,
      `${n} line${n === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    return `<label class="dk-po${po.id === s.poId ? " is-on" : ""}">
      <input type="radio" name="dk-po" value="${esc(po.id)}" data-dkpo${po.id === s.poId ? " checked" : ""} />
      <span class="dk-po-txt">
        <span class="dk-po-title"><strong>${esc(po.number || "Purchase order")}</strong><span>${esc(poSupplier(po) || "No supplier")}</span></span>
        ${ordered ? `<small class="dk-po-who">${esc(ordered)}</small>` : ""}
        ${sent ? `<small class="dk-po-who">${esc(sent)}</small>` : ""}
        <small>${esc(facts)}</small>
        ${tags.length ? `<span class="dk-tags">${tags.map((t) => `<em>${esc(t)}</em>`).join("")}</span>` : ""}
      </span>
    </label>`;
  };

  // Two lines on the button: what it does, then which order
  const receiveLabel = (po) => `<span>Receive stock</span><small>${esc(po ? po.number || "this order" : "Choose an order")}</small>`;

  function deliveryBody(po) {
    const r = s.review;
    const near = s.ranked.filter((x) => x.numberMatch || x.supplierMatch || x.hits);
    const list = s.showAll || !near.length ? s.ranked : near;
    const docketIds = new Set(r.lines.map((l) => l.productId).filter(Boolean));
    const toCome = po ? (po.lines || []).filter((l) => l.productId && !docketIds.has(l.productId)) : [];
    const lines = (() => {
      if (!r.lines.length) return '<p class="scan-err">No product lines were read. Try a closer photo of the docket.</p>';
      const { main, extra } = splitLines(po);
      const tracked = r.lines.some((l) => (byId.get(l.productId) || {}).tracked);
      return `
        <h3 class="dk-h">${po ? "On the order" : "On the docket"} <small>${main.length}</small></h3>
        ${main.length ? `<p class="dk-muted dk-hint">${tracked
            ? "Check the quantities, and the batch and expiry where asked, against the docket. Fix anything misread."
            : "Check the quantities against the docket and fix anything misread."}</p>
          <div class="dk-list">${main.map(({ l, i }) => lineHtml(l, i)).join("")}</div>`
          : `<p class="dk-muted">None of the docket's items are on ${esc(po.number || "this order")}. Check it's the right order.</p>`}
        ${extra.length ? `
          <h3 class="dk-h dk-h-extra">Extra items <small>${extra.length}</small></h3>
          <p class="dk-muted dk-hint">These aren't on ${esc(po.number || "this order")}, but they came in the box. They're still received
            into stock, and you choose Shelf or JT storage on the next screen. Tap “Don't receive this” for freight, samples
            or anything you don't stock.</p>
          <div class="dk-list dk-list-extra">${extra.map(({ l, i }) => lineHtml(l, i, true)).join("")}</div>` : ""}`;
    })();
    return `${lines}
      <h3 class="dk-h">Which purchase order is it for?</h3>
      ${s.posError ? `<p class="scan-err">${esc(s.posError)}</p>`
        : !s.ranked.length ? '<p class="dk-muted">There are no open purchase orders (sent or part received).</p>'
        : `<div class="dk-pos">${list.map(poHtml).join("")}</div>
           ${list.length < s.ranked.length ? `<button type="button" class="scan-pat-btn dk-more" data-dk="all">Show all ${s.ranked.length} open orders</button>` : ""}`}
      ${toCome.length ? `<p class="dk-muted dk-tocome"><strong>Still to come on ${esc(po.number || "this order")}:</strong> ${toCome.map((l) =>
          esc(l.name || l.productName || (byId.get(l.productId) || {}).name || "a product")).join(", ")}</p>` : ""}`;
  }

  /* ---------- Internal transfer: JT storage → Shelf ---------- */

  // Each docket line matched to a JT storage batch. Lines hitting the same batch share what's there.
  // state: "ok" (can move), "bad" (fix before moving) or "skip" (not being moved)
  function transferPlans() {
    const used = new Map();
    return s.review.lines.map((l, i) => {
      const p = byId.get(l.productId) || null;
      if (l.skip) return { i, l, p, state: "skip" };
      if (!p) return { i, l, p, state: "bad", msg: "Choose the product, or tap “Don't move this”" };
      const f = findJtLot(p, s.lots, l.batch, l.expiry);
      const lot = l.jtLot ? f.options.find((x) => x.id === l.jtLot) || null : f.match;
      if (!l.qty) return { i, l, p, f, lot, state: "skip", msg: "Quantity is 0, so nothing moves" };
      const bn = batchName(p);
      if (!lot) {
        return { i, l, p, f, state: "bad", msg: !f.options.length ? `There's no ${p.name} in JT storage.`
          : f.sameBatch.length ? `${bn} ${l.batch} is in JT storage, but with a different expiry. Choose it below.`
          : `${bn} ${l.batch || "(not read)"} isn't in JT storage. Choose the one that was moved.` };
      }
      const total = (used.get(lot.id) || 0) + l.qty;
      used.set(lot.id, total);
      if (total > lot.qty) {
        return { i, l, p, f, lot, state: "bad",
          msg: `JT storage only has ${plural(lot.qty, p.stockUnit)}${p.tracked ? ` of ${lot.batch}` : ""}. Check the quantity.` };
      }
      return { i, l, p, f, lot, state: "ok", left: lot.qty - total, picked: !!l.jtLot };
    });
  }

  // The Qty column against the batch lines read for it, per product
  function qtyWarnings() {
    const m = new Map();
    s.review.lines.forEach((l) => {
      if (!l.productId || l.skip || l.formQty === null || l.formQty === undefined) return;
      const x = m.get(l.productId) || { form: l.formQty, sum: 0 };
      x.sum += l.qty;
      m.set(l.productId, x);
    });
    return m;
  }

  const tLineHtml = (pl, qw, shown) => {
    const { l, i, p } = pl;
    const flags = [];
    if (pl.state === "bad") flags.push(["bad", pl.msg]);
    else if (pl.state === "skip") flags.push(["info", pl.msg || "Not being moved"]);
    else flags.push(["ok", `JT storage → Shelf · ${pl.left} left in JT storage${p.tracked ? ` (${pl.lot.batch})` : ""}`]);
    if (pl.state === "ok" && pl.picked) flags.push(["warn", `${batchName(p)} chosen by hand`]);
    const w = p && !shown.has(p.id) ? qw.get(p.id) : null;
    if (p) shown.add(p.id);
    if (w && w.form !== w.sum) flags.push(["warn", `The Qty column says ${w.form}, but the ${batchName(p).toLowerCase()} lines add up to ${w.sum}`]);
    if (p && !l.skip && !l.fixed && l.conf < 0.6) flags.push(["warn", "Check this is the right product"]);
    const opts = pl.f ? pl.f.options : [];
    const read = [l.batch && `${p ? batchName(p) : "Batch"} ${l.batch}`, l.expiry && `Exp ${niceDate(fullExpiry(l.expiry)) || l.expiry}`]
      .filter(Boolean).join(" · ");
    const cls = pl.state === "skip" ? " is-skip" : pl.state === "bad" ? " is-bad" : flags.some((f) => f[0] === "warn") ? " is-warn" : "";
    const name = p ? p.name : "this line";
    return `<div class="dk-row${cls}" data-row="${i}">
      <div class="dk-main">
        <button type="button" class="scan-name" data-dkfix="${i}">${esc(p ? p.name : "Not matched")}<small>change</small></button>
        <small>${esc(l.text)}${read ? ` · Read: ${esc(read)}` : ""}${l.edited ? ' <em class="dk-edited">edited</em>' : ""}</small>
        ${flags.map(([t, m]) => `<span class="scan-flag is-${t}">${esc(m)}</span>`).join("")}
        <button type="button" class="scan-pat-btn dk-skip" data-dkskip="${i}">${l.skip ? "Move this after all" : "Don't move this"}</button>
        ${s.fixing === i ? fixHtml(l, i) : ""}
      </div>
      ${l.skip ? "" : `<div class="dk-fields">
        <label class="dk-f dk-f-qty"><span>Qty${p ? ` <small>${esc(unitPlural(p.stockUnit))}</small>` : ""}</span>
          <input class="dk-input" type="number" min="0" max="9999" step="1" inputmode="numeric" data-dkq="${i}"
            value="${l.qty}" aria-label="Quantity of ${esc(name)}" /></label>
        ${p && p.tracked && opts.length ? `<label class="dk-f dk-f-jt"><span>${esc(batchName(p))} in JT storage</span>
          <select class="dk-input" data-dkjt="${i}" aria-label="${esc(batchName(p))} in JT storage for ${esc(name)}">
            ${pl.lot ? "" : '<option value="" selected>Choose…</option>'}
            ${opts.map((o) => `<option value="${esc(o.id)}"${pl.lot && pl.lot.id === o.id ? " selected" : ""}>${
              esc(`${o.batch || "No number"} · Exp ${niceDate(o.expiry) || "none"} · ${o.qty} in JT`)}</option>`).join("")}
          </select></label>` : ""}
      </div>`}
    </div>`;
  };

  const canMove = (plans) => plans.some((x) => x.state === "ok") && !plans.some((x) => x.state === "bad");
  const moveLabel = (plans) => {
    const bad = plans.filter((x) => x.state === "bad").length;
    const n = plans.filter((x) => x.state === "ok").reduce((a, x) => a + x.l.qty, 0);
    return `<span>Move to the Shelf</span><small>${bad ? `${bad} line${bad === 1 ? "" : "s"} to fix` : plural(n, "item")}</small>`;
  };

  function transferBody() {
    const r = s.review;
    if (!r.lines.length) return '<p class="scan-err">No product lines were read. Try a closer photo of the form.</p>';
    if (s.lotsError) return `<p class="scan-err">${esc(s.lotsError)}</p>`;
    const plans = transferPlans();
    const qw = qtyWarnings();
    const shown = new Set();
    const pids = new Set(plans.filter((x) => x.state === "ok").map((x) => x.p.id));
    const waiting = s.rels.filter((rl) => pids.has(rl.productId));
    return `<h3 class="dk-h">From JT storage to the Shelf <small>${plans.filter((x) => x.state !== "skip").length}</small></h3>
      <p class="dk-muted dk-hint">Each line is matched to the same batch in JT storage. Check the quantities and batches against the form.
        Nothing moves until you confirm.</p>
      <div class="dk-list">${plans.map((pl) => tLineHtml(pl, qw, shown)).join("")}</div>
      ${waiting.length ? `<p class="dk-muted dk-tocome"><strong>Waiting JT storage requests:</strong> ${waiting.map((w) =>
        esc(`${w.requestedBy}: ${plural(w.qty, w.unit)} ${w.productName}`)).join(", ")}. Any this move fully covers are approved
        when you confirm (oldest first), and the person who asked is emailed.</p>` : ""}`;
  }

  // Typing a quantity: every line's status updates (they can share a batch) without touching the boxes
  function refreshTransfer() {
    const plans = transferPlans();
    const qw = qtyWarnings();
    const shown = new Set();
    plans.forEach((pl) => {
      const rowEl = el.querySelector(`.dk-row[data-row="${pl.i}"]`);
      if (!rowEl) return;
      const tmp = document.createElement("div");
      tmp.innerHTML = tLineHtml(pl, qw, shown);
      const fresh = tmp.firstElementChild;
      rowEl.className = fresh.className;
      rowEl.querySelector(".dk-main").replaceWith(fresh.querySelector(".dk-main"));
    });
    const btn = el.querySelector('[data-dk="move"]');
    if (btn && !s.busy) { btn.innerHTML = moveLabel(plans); btn.disabled = !canMove(plans); }
  }

  /* ---------- The screen ---------- */

  const modeHtml = () => {
    const r = s.review;
    if (r.formType !== "dermedica" && s.mode !== "transfer") return "";
    const ticked = r.transferType === "transfer" ? "Internal transfer from JT store"
      : r.transferType === "delivery" ? "New delivery from Supplier" : "";
    const btn = (m, label, sub) => `<button type="button" class="dk-mode-btn${s.mode === m ? " is-on" : ""}" data-dkmode="${m}"
      aria-pressed="${s.mode === m}"><strong>${label}</strong><small>${sub}</small></button>`;
    return `<div class="dk-mode"><span class="lh-label">This form is</span>
      <div class="dk-mode-btns">${btn("delivery", "New delivery", "Received against a purchase order")}${
        btn("transfer", "Internal transfer", "JT storage → Shelf")}</div>
      <small class="dk-muted">${ticked ? `Ticked on the form: ${esc(ticked)}. Change it here if that's wrong.`
        : "Neither box looked ticked on the form. Choose one."}</small>
    </div>`;
  };

  function draw() {
    const r = s.review;
    const transfer = s.mode === "transfer";
    const po = transfer ? null : selected();
    const supplier = (po && poSupplier(po)) || r.supplier || "Supplier not read";
    const people = s.people.length ? s.people : [{ id: myUid, name: (staff && staff.name) || "Me" }];
    const sub = [r.docketNumber && `Docket ${r.docketNumber}`, r.docketDate && niceDate(r.docketDate),
      r.poNumber && `Their ref ${r.poNumber}`].filter(Boolean).join(" · ");
    const plans = transfer ? transferPlans() : null;

    el.innerHTML = `
      <div class="scan-res-head">
        <button type="button" class="scan-thumb" data-dk="big" aria-label="Show the photo larger"><img src="${photoUrl}" alt="" /></button>
        <div><strong>${esc(transfer ? "Internal transfer" : supplier)}</strong>
          <small>${esc(transfer ? "JT storage → Shelf" : sub || "Docket number not read")}</small>
          ${!transfer && po && r.supplier && r.supplier !== supplier ? `<small>Read as “${esc(r.supplier)}”</small>` : ""}</div>
        ${transfer ? '<span class="scan-chip is-ok">From JT storage</span>'
          : `<span class="scan-chip ${po ? "is-ok" : "is-warn"}">${po ? esc(po.number || "Order linked") : "No order linked"}</span>`}
      </div>
      <div class="scan-big" data-role="dkbig"${s.big ? "" : " hidden"}><img src="${photoUrl}" alt="The docket" /></div>

      ${modeHtml()}

      <div class="dk-recv">
        <label class="dk-field"><span class="lh-label">${transfer ? "Moved by" : "Received by"}</span>
          <select class="dk-input" data-dkrecv>${people.map((p) =>
            `<option value="${esc(p.id)}"${p.id === s.recvUid ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
          ${r.receivedByText ? `<small class="dk-muted">Written on the form: “${esc(r.receivedByText)}”</small>` : ""}
        </label>
        <label class="dk-field"><span class="lh-label">Date and time</span>
          <input type="datetime-local" class="dk-input" data-dkat value="${esc(s.recvAt)}" /></label>
      </div>

      ${transfer ? transferBody() : deliveryBody(po)}

      <label class="dk-field dk-note"><span class="lh-label">Note (optional)</span>
        <textarea class="dk-input" data-dknote rows="2" maxlength="1000" placeholder="e.g. 1 box damaged">${esc(s.note)}</textarea></label>
      <div class="dk-acts">
        <button type="button" class="lh-btn" data-dk="again">Scan again</button>
        <button type="button" class="lh-btn" data-dk="save">Save docket only</button>
        ${transfer
          ? `<button type="button" class="lh-btn is-primary dk-receive" data-dk="move"${canMove(plans) ? "" : " disabled"}>${moveLabel(plans)}</button>`
          : `<button type="button" class="lh-btn is-primary dk-receive" data-dk="receive"${po ? "" : " disabled"}>${receiveLabel(po)}</button>`}
      </div>`;
  }

  /* ---------- Saving ---------- */

  const who = () => s.people.find((p) => p.id === s.recvUid) || null;
  const recvDate = () => { const at = new Date(s.recvAt); return isNaN(at) ? new Date() : at; };

  // The docket's lines as saved on the scan
  function scanLines(po) {
    const on = po ? idsOn(po) : new Set();
    return s.review.lines.map((l) => {
      const p = byId.get(l.productId);
      const tracked = !!(p && p.tracked);   // batch and expiry only for products that track them
      return {
        productId: l.productId, productName: p ? p.name : "",
        text: l.text, code: l.code, qty: l.qty, unit: l.unit,
        batch: tracked ? String(l.batch || "").trim() : "", expiry: tracked ? fullExpiry(l.expiry) : "",
        edited: l.edited === true,
        extra: !!po && !(l.productId && on.has(l.productId)),   // came in the box, not on the order
        skip: l.skip === true,                                  // staff chose not to receive / move it
      };
    });
  }

  // Saved once: trying again after a problem uses the same scan (and so the same transfer id)
  async function saveScanOnce(po) {
    if (s.scanId) return { id: s.scanId, photoUrl: "", photoPath: "" };
    const w = who();
    const saved = await saveDocketScan({ photo, result, review: s.review, lines: scanLines(po), po,
      receivedBy: w ? w.name : (staff && staff.name) || "", receivedByUid: s.recvUid, receivedAt: recvDate(), note: s.note }, staff);
    s.scanId = saved.id;
    return saved;
  }

  async function save(receive, btn) {
    if (s.busy) return;
    const po = s.mode === "transfer" ? null : selected();
    if (receive && !po) return;
    if (!receive && s.scanId) { showToast("Docket saved."); onAgain(); return; }
    if (receive) {
      const waiting = splitLines(po).extra.filter(({ l }) => !l.skip && !l.productId && l.qty > 0);
      if (waiting.length) {
        showToast(`Choose the product for ${waiting.length === 1 ? "the extra item" : `${waiting.length} extra items`}, or tap “Don't receive this”.`);
        const row = el.querySelector(`.dk-row[data-row="${waiting[0].i}"]`);
        if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    s.busy = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const saved = await saveScanOnce(po);
      if (!receive) { showToast("Docket saved."); onAgain(); return; }
      const w = who();
      const lines = scanLines(po);
      sessionStorage.setItem("docketPrefill", JSON.stringify({
        poId: po.id, scanId: saved.id, photoUrl: saved.photoUrl, photoPath: saved.photoPath,
        docketNumber: s.review.docketNumber, supplier: s.review.supplier,
        receivedBy: w ? w.name : "", receivedByUid: s.recvUid, receivedAt: recvDate().toISOString(), note: s.note,
        lines: lines.filter((l) => !l.extra && l.productId && l.qty > 0)
          .map((l) => ({ productId: l.productId, qty: l.qty, unit: l.unit, batch: l.batch, expiry: l.expiry })),
        // Not on the order, but received too: the receive page shows them with Shelf | JT storage boxes
        extras: lines.filter((l) => l.extra && !l.skip && l.productId && l.qty > 0)
          .map((l) => ({ productId: l.productId, qty: l.qty, unit: l.unit, batch: l.batch, expiry: l.expiry, text: l.text })),
      }));
      showToast(`Docket saved. Opening ${po.number || "the order"} to receive it.`);
      location.hash = `#/inventory/receive/${encodeURIComponent(po.id)}`;
    } catch (err) {
      console.error("Save docket failed:", err);
      showToast(err && err.message && !err.code ? err.message : "Couldn't save the docket. Try again.");
      btn.disabled = false;
      if (receive) btn.innerHTML = receiveLabel(po); else btn.textContent = "Save docket only";
    } finally {
      s.busy = false;
    }
  }

  async function doTransfer(btn) {
    if (s.busy) return;
    const plans = transferPlans();
    const bad = plans.filter((x) => x.state === "bad");
    if (bad.length) {
      showToast(`Fix ${bad.length === 1 ? "the line" : `${bad.length} lines`} marked in red, or tap “Don't move this”.`);
      const row = el.querySelector(`.dk-row[data-row="${bad[0].i}"]`);
      if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const go = plans.filter((x) => x.state === "ok");
    if (!go.length) { showToast("Nothing to move."); return; }
    const pids = new Set(go.map((x) => x.p.id));
    const waiting = s.rels.filter((r) => pids.has(r.productId));
    const ok = await confirmDialog({
      title: "Move these to the Shelf?",
      message: `${go.map((x) => `${plural(x.l.qty, x.p.stockUnit)} of ${x.p.name}${x.p.tracked ? ` (${batchText(x.p, x.lot.batch)})` : ""}`)
        .join(", ")}. They come out of JT storage and go onto the Shelf now.${waiting.length
        ? ` Waiting requests this covers are approved too: ${waiting.map((r) => `${r.requestedBy} (${plural(r.qty, r.unit)} ${r.productName})`).join(", ")}.` : ""}`,
      confirmLabel: "Move to the Shelf",
    });
    if (!ok) return;

    s.busy = true;
    btn.disabled = true;
    btn.textContent = "Moving…";
    try {
      await saveScanOnce(null);
      const w = who();
      const moveLines = go.map((x) => ({ productId: x.p.id, batch: x.lot.batch, expiry: x.lot.expiry, qty: x.l.qty }));
      const moveNote = [w && `Moved by ${w.name}`, s.note].filter(Boolean).join(" · ");

      // First try with the waiting JT requests approved. If this person isn't allowed to approve releases,
      // the whole transaction is rolled back (nothing moved), so it's tried again without approving them.
      let res;
      let notApproved = false;
      try {
        res = await transferFromJt(moveLines, { scanId: s.scanId, note: moveNote, approve: waiting.length > 0 }, staff);
      } catch (err) {
        if (!(err && err.code === "permission-denied" && waiting.length)) throw err;
        console.warn("No access to approve JT releases, moving without approving them:", err);
        res = await transferFromJt(moveLines, { scanId: s.scanId, note: moveNote, approve: false }, staff);
        notApproved = true;
      }

      await markDocketTransferred(s.scanId, res).catch((err) => console.warn("Scan not marked as transferred:", err));
      res.releases.forEach((r) => callApi({ action: "inventory", op: "notifyReleaseUpdate", releaseId: r.id })
        .catch((err) => console.warn("Release email failed:", err)));
      const n = res.moved.reduce((a, m) => a + m.qty, 0);
      showToast(`${plural(n, "item")} moved to the Shelf${res.releases.length
        ? ` · ${res.releases.length} JT request${res.releases.length === 1 ? "" : "s"} approved`
        : notApproved ? " · the waiting JT requests are left for a JT approver" : ""}.`);
      onAgain();
    } catch (err) {
      console.error("JT transfer failed:", err);
      showToast(err && err.code === "permission-denied"
        ? "You don't have access to move JT storage stock. Tap “Save docket only” and ask an admin."
        : err && err.message && !err.code ? err.message : "Couldn't move the stock. Try again.");
      s.lots = await listAllLots().catch(() => s.lots);   // stock may have changed: check again
      s.busy = false;
      draw();
    } finally {
      s.busy = false;
    }
  }

  /* ---------- Events ---------- */

  el.addEventListener("click", (e) => {
    const md = e.target.closest("[data-dkmode]");
    if (md) { s.mode = md.dataset.dkmode; s.fixing = -1; draw(); return; }
    const sk = e.target.closest("[data-dkskip]");
    if (sk) { const l = s.review.lines[Number(sk.dataset.dkskip)]; if (l) { l.skip = !l.skip; draw(); } return; }
    const fx = e.target.closest("[data-dkfix]");
    if (fx) { const i = Number(fx.dataset.dkfix); s.fixing = s.fixing === i ? -1 : i; draw(); return; }
    const b = e.target.closest("[data-dk]");
    if (!b) return;
    const act = b.dataset.dk;
    if (act === "big") { s.big = !s.big; const big = el.querySelector('[data-role="dkbig"]'); if (big) big.hidden = !s.big; }
    else if (act === "all") { s.showAll = true; draw(); }
    else if (act === "again") onAgain();
    else if (act === "save") save(false, b);
    else if (act === "receive") save(true, b);
    else if (act === "move") doTransfer(b);
  });

  // Refreshes one docket line's name, notes and flags without touching its boxes (so typing isn't interrupted)
  function refreshLine(i) {
    const rowEl = el.querySelector(`.dk-row[data-row="${i}"]`);
    const l = s.review.lines[i];
    if (!rowEl || !l) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = lineHtml(l, i, !!rowEl.closest(".dk-list-extra"));
    const fresh = tmp.firstElementChild;
    rowEl.className = fresh.className;
    rowEl.querySelector(".dk-main").replaceWith(fresh.querySelector(".dk-main"));
  }

  el.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.dknote !== undefined) { s.note = t.value; return; }
    const i = t.dataset.dkq ?? t.dataset.dkb ?? t.dataset.dke;
    const l = i !== undefined ? s.review.lines[Number(i)] : null;
    if (!l) return;
    if (t.dataset.dkq !== undefined) l.qty = Math.min(9999, Math.max(0, parseInt(t.value, 10) || 0));
    else if (t.dataset.dkb !== undefined) l.batch = t.value.trim().toUpperCase().slice(0, 40);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(t.value) || t.value === "") l.expiry = t.value;
    l.edited = true;
    if (s.mode === "transfer") refreshTransfer(); else refreshLine(Number(i));
  });

  el.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.dkrecv !== undefined) s.recvUid = t.value;
    else if (t.dataset.dkat !== undefined) s.recvAt = t.value;
    else if (t.dataset.dkpo !== undefined) { s.poId = t.value; draw(); }
    else if (t.dataset.dkjt !== undefined) {
      const l = s.review.lines[Number(t.dataset.dkjt)];
      if (!l) return;
      l.jtLot = t.value;
      l.edited = true;
      draw();
    } else if (t.dataset.dkfixsel !== undefined) {
      const l = s.review.lines[Number(t.dataset.dkfixsel)];
      if (!l) return;
      l.productId = t.value;
      l.fixed = true;
      l.jtLot = "";   // a different product: its JT batch is found again
      s.fixing = -1;
      rerank();
      draw();
    }
  });

  init();
}