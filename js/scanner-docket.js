// Delivery docket result (Scanner → Delivery docket): who sent it, who received it and when, and which open
// purchase order it's for. "Receive this order" saves the docket and opens that order to receive it,
// with the docket's quantities, batches and expiries handed over (sessionStorage "docketPrefill").
import { auth } from "./firebase-config.js";
import { INV_CATEGORIES, batchName } from "./inventory-api.js";
import { reviewDocket, rankPos, listOpenPos, poSupplier, staffList, matchStaff, saveDocketScan } from "./scanner-api.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = (n) => String(n).padStart(2, "0");
const localDT = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const STATUS = { sent: "Sent", part: "Part received" };
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
  const s = { review: reviewDocket(result, products), pos: [], ranked: [], people: [], poId: "", showAll: false,
    recvUid: myUid, recvAt: localDT(new Date()), fixing: -1, busy: false, posError: "", note: "", big: false };

  const selected = () => (s.ranked.find((r) => r.po.id === s.poId) || {}).po || null;
  const idsOn = (po) => new Set(((po && po.lines) || []).map((l) => l.productId).filter(Boolean));
  const rerank = () => { s.ranked = rankPos(s.review, s.pos); };

  async function init() {
    el.innerHTML = '<p class="dk-muted">Finding open purchase orders…</p>';
    const [pos, people] = await Promise.all([
      listOpenPos().catch((err) => {
        console.warn("Open purchase orders didn't load:", err);
        s.posError = err && err.code === "permission-denied"
          ? "You don't have access to purchase orders. Save the docket, and someone on the ordering team can receive it."
          : "Couldn't load the open purchase orders. Check your connection.";
        return [];
      }),
      staffList().catch(() => []),
    ]);
    s.pos = pos;
    s.people = people;
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

  const lineHtml = (l, i) => {
    const p = byId.get(l.productId);
    const po = selected();
    const flags = [];
    if (!p) flags.push(["bad", "Not matched to a product"]);
    else if (po && !idsOn(po).has(l.productId)) flags.push(["warn", "Not on this purchase order"]);
    if (p && !l.fixed && l.conf < 0.6) flags.push(["warn", "Check this is the right product"]);
    if (!l.qty) flags.push(["warn", "None supplied (back-ordered?)"]);
    const bad = flags.some((f) => f[0] === "bad");
    const name = p ? p.name : "this line";
    return `<div class="dk-row${bad ? " is-bad" : flags.length ? " is-warn" : ""}">
      <div class="dk-main">
        <button type="button" class="scan-name" data-dkfix="${i}">${esc(p ? p.name : "Not matched")}<small>change</small></button>
        <small>${esc(l.text)}${l.code ? ` · ${esc(l.code)}` : ""}${l.count > 1 ? ` · ${l.count} lines on the docket` : ""}${
          l.edited ? ' <em class="dk-edited">edited</em>' : ""}</small>
        ${flags.map(([t, m]) => `<span class="scan-flag is-${t}">${esc(m)}</span>`).join("")}
        ${s.fixing === i ? fixHtml(l, i) : ""}
      </div>
      <div class="dk-fields">
        <label class="dk-f dk-f-qty"><span>Qty${l.unit ? ` <small>${esc(l.unit)}</small>` : ""}</span>
          <input class="dk-input" type="number" min="0" max="9999" step="1" inputmode="numeric" data-dkq="${i}"
            value="${l.qty}" aria-label="Quantity of ${esc(name)}" /></label>
        ${p && p.tracked ? `
        <label class="dk-f dk-f-batch"><span>${esc(batchName(p))}</span>
          <input class="dk-input" maxlength="40" autocapitalize="characters" autocomplete="off" data-dkb="${i}"
            value="${esc(l.batch)}" placeholder="–" aria-label="${esc(batchName(p))} of ${esc(name)}" /></label>
        <label class="dk-f dk-f-exp"><span>Expiry</span>
          <input class="dk-input" type="date" data-dke="${i}" value="${esc(fullExpiry(l.expiry))}" aria-label="Expiry of ${esc(name)}" /></label>` : ""}
      </div>
    </div>`;
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

  function draw() {
    const r = s.review;
    const po = selected();
    const near = s.ranked.filter((x) => x.numberMatch || x.supplierMatch || x.hits);
    const list = s.showAll || !near.length ? s.ranked : near;
    const supplier = (po && poSupplier(po)) || r.supplier || "Supplier not read";
    const docketIds = new Set(r.lines.map((l) => l.productId).filter(Boolean));
    const toCome = po ? (po.lines || []).filter((l) => l.productId && !docketIds.has(l.productId)) : [];
    const people = s.people.length ? s.people : [{ id: myUid, name: (staff && staff.name) || "Me" }];
    const sub = [r.docketNumber && `Docket ${r.docketNumber}`, r.docketDate && niceDate(r.docketDate),
      r.poNumber && `Their ref ${r.poNumber}`].filter(Boolean).join(" · ");

    el.innerHTML = `
      <div class="scan-res-head">
        <button type="button" class="scan-thumb" data-dk="big" aria-label="Show the photo larger"><img src="${photoUrl}" alt="" /></button>
        <div><strong>${esc(supplier)}</strong><small>${esc(sub || "Docket number not read")}</small>
          ${po && r.supplier && r.supplier !== supplier ? `<small>Read as “${esc(r.supplier)}”</small>` : ""}</div>
        <span class="scan-chip ${po ? "is-ok" : "is-warn"}">${po ? esc(po.number || "Order linked") : "No order linked"}</span>
      </div>
      <div class="scan-big" data-role="dkbig"${s.big ? "" : " hidden"}><img src="${photoUrl}" alt="The docket" /></div>

      <div class="dk-recv">
        <label class="dk-field"><span class="lh-label">Received by</span>
          <select class="dk-input" data-dkrecv>${people.map((p) =>
            `<option value="${esc(p.id)}"${p.id === s.recvUid ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
          ${r.receivedByText ? `<small class="dk-muted">Written on the docket: “${esc(r.receivedByText)}”</small>` : ""}
        </label>
        <label class="dk-field"><span class="lh-label">Received date and time</span>
          <input type="datetime-local" class="dk-input" data-dkat value="${esc(s.recvAt)}" /></label>
      </div>

      <h3 class="dk-h">On the docket <small>${r.lines.length}</small></h3>
      ${r.lines.length ? `<p class="dk-muted dk-hint">${r.lines.some((l) => (byId.get(l.productId) || {}).tracked)
          ? "Check the quantities, and the batch and expiry where asked, against the docket. Fix anything misread."
          : "Check the quantities against the docket and fix anything misread."}</p>
        <div class="dk-list">${r.lines.map(lineHtml).join("")}</div>`
        : '<p class="scan-err">No product lines were read. Try a closer photo of the docket.</p>'}

      <h3 class="dk-h">Which purchase order is it for?</h3>
      ${s.posError ? `<p class="scan-err">${esc(s.posError)}</p>`
        : !s.ranked.length ? '<p class="dk-muted">There are no open purchase orders (sent or part received).</p>'
        : `<div class="dk-pos">${list.map(poHtml).join("")}</div>
           ${list.length < s.ranked.length ? `<button type="button" class="scan-pat-btn dk-more" data-dk="all">Show all ${s.ranked.length} open orders</button>` : ""}`}
      ${toCome.length ? `<p class="dk-muted dk-tocome"><strong>Still to come on ${esc(po.number || "this order")}:</strong> ${toCome.map((l) =>
          esc(l.name || l.productName || (byId.get(l.productId) || {}).name || "a product")).join(", ")}</p>` : ""}

      <label class="dk-field dk-note"><span class="lh-label">Note (optional)</span>
        <textarea class="dk-input" data-dknote rows="2" maxlength="1000" placeholder="e.g. 1 box damaged">${esc(s.note)}</textarea></label>
      <div class="dk-acts">
        <button type="button" class="lh-btn" data-dk="again">Scan again</button>
        <button type="button" class="lh-btn" data-dk="save">Save docket only</button>
        <button type="button" class="lh-btn is-primary dk-receive" data-dk="receive"${po ? "" : " disabled"}>${receiveLabel(po)}</button>
      </div>`;
  }

  async function save(receive, btn) {
    if (s.busy) return;
    const po = selected();
    if (receive && !po) return;
    s.busy = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const who = s.people.find((p) => p.id === s.recvUid);
      const at = new Date(s.recvAt);
      const receivedAt = isNaN(at) ? new Date() : at;
      const lines = s.review.lines.map((l) => {
        const p = byId.get(l.productId);
        const tracked = !!(p && p.tracked);   // batch and expiry only for products that track them
        return {
          productId: l.productId, productName: p ? p.name : "",
          text: l.text, code: l.code, qty: l.qty, unit: l.unit,
          batch: tracked ? String(l.batch || "").trim() : "", expiry: tracked ? fullExpiry(l.expiry) : "",
          edited: l.edited === true,
        };
      });
      const saved = await saveDocketScan({ photo, result, review: s.review, lines, po,
        receivedBy: who ? who.name : (staff && staff.name) || "", receivedByUid: s.recvUid, receivedAt, note: s.note }, staff);

      if (!receive) { showToast("Docket saved."); onAgain(); return; }
      const on = idsOn(po);
      sessionStorage.setItem("docketPrefill", JSON.stringify({
        poId: po.id, scanId: saved.id, photoUrl: saved.photoUrl, photoPath: saved.photoPath,
        docketNumber: s.review.docketNumber, supplier: s.review.supplier,
        receivedBy: who ? who.name : "", receivedByUid: s.recvUid, receivedAt: receivedAt.toISOString(), note: s.note,
        lines: lines.filter((l) => l.productId && on.has(l.productId) && l.qty > 0)
          .map((l) => ({ productId: l.productId, qty: l.qty, unit: l.unit, batch: l.batch, expiry: l.expiry })),
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

  el.addEventListener("click", (e) => {
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
  });
  // Refreshes one docket line's name, notes and flags without touching its boxes (so typing isn't interrupted)
  function refreshLine(i) {
    const rowEl = el.querySelectorAll(".dk-list .dk-row")[i];
    const l = s.review.lines[i];
    if (!rowEl || !l) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = lineHtml(l, i);
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
    refreshLine(Number(i));   // flags and the "edited" tag update as you type
  });
  
  el.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.dkrecv !== undefined) s.recvUid = t.value;
    else if (t.dataset.dkat !== undefined) s.recvAt = t.value;
    else if (t.dataset.dkpo !== undefined) { s.poId = t.value; draw(); }
    else if (t.dataset.dkfixsel !== undefined) {
      const l = s.review.lines[Number(t.dataset.dkfixsel)];
      if (!l) return;
      l.productId = t.value;
      l.fixed = true;
      s.fixing = -1;
      rerank();
      draw();
    }
  });

  init();
}