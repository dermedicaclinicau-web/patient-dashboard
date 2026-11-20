// Task Manager → To Order (#/tasks/order[/<productId>|/low]): ask the ordering team for stock, and see your requests.
import {
  INV_CATEGORIES, LOCATIONS, REQ_STATUS, plural, unitPlural, reqNumber, myUid, lowAt, suggestOrder, dayKey,
  listProducts, listRequests, createRequest, cancelRequest, getRequestSettings,
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
  injectCss();
  const backHref = "#/tasks/new";
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);

  let products = [];
  let requests = [];
  let reqCfg = { approverId: "", approverName: "" };
  try {
    [products, requests, reqCfg] = await Promise.all([listProducts(), listRequests({ max: 200 }),
      getRequestSettings().catch(() => reqCfg)]);
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

  // What's already been asked for: open, or ordered in the last 30 days
  const RECENT_MS = 30 * 864e5;
  let showAllPending = false;
  const pending = () => requests.filter((q) => q.status === "open"
    || (q.status === "ordered" && q.createdAt && Date.now() - q.createdAt.getTime() < RECENT_MS))
    .sort((a, b) => (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0));
  // Who approves requests: "Joanna" from "Dr Joanna Teh"
  const apShort = String(reqCfg.approverName || "").replace(/^dr\.?\s+/i, "").split(/\s+/)[0];
  const apWait = apShort ? `Waiting for ${apShort}'s approval` : "Waiting for approval";
  const viaApprover = !!reqCfg.approverId && reqCfg.approverId !== myUid();
  const reqState = (q) => (q.status === "ordered" ? ["Ordered", "is-ordered"]
    : q.status === "open" && q.approval === "waiting" ? [apWait, "is-appr"]
    : (q.poNumbers || []).length ? [`Being ordered (${q.poNumbers[q.poNumbers.length - 1]})`, "is-po"]
    : ["Waiting", "is-wait"]);
  const who = (q) => (q.requestedByUid === myUid() ? "You" : q.requestedBy || "Someone");
  const whenShort = (d) => {
    if (!d) return "";
    const t = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
    if (dayKey(d) === dayKey()) return `today ${t}`;
    if (dayKey(d) === dayKey(new Date(Date.now() - 864e5))) return `yesterday ${t}`;
    return `on ${day(d)}`;
  };
  const sameText = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  // Still waiting: open and not on a purchase order yet. These can be added to, so they're never requested twice.
  const isWaiting = (q) => q.status === "open" && !(q.poIds || []).length && !(q.poNumbers || []).length;
  const whose = (q) => (q.requestedByUid === myUid() ? "your" : `${q.requestedBy || "their"}'s`);
  const nameOf = (r) => { const p = byId.get(r.productId); return p ? p.name : r.name.trim(); };
  // Requests already asking for what's on this row (a product, or the same typed name)
  const dupsFor = (r) => {
    const p = byId.get(r.productId);
    const key = !p && r.isNew ? sameText(r.name) : "";
    if (!p && !key) return [];
    return pending().flatMap((q) => q.items.map((it, i) => ({ q, it, i }))
      .filter(({ it }) => (p ? it.productId === p.id : !it.productId && sameText(it.name) === key)));
  };
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
          <div class="ff-bar-title"><strong>Request order</strong><span>${viaApprover
            ? `To Order · ${esc(apShort || "the approver")} approves it first` : "To Order · goes to the ordering team"}</span></div>
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
          <section class="tb-card"><h4>Already requested</h4><div data-role="pending"></div></section>
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
    const dups = dupsFor(r);
    const units = p
      ? `<option value="order"${r.unitKind === "order" ? " selected" : ""}>${esc(p.packSize > 1 ? `${unitPlural(p.orderUnit)} (${p.packSize} each)` : unitPlural(p.orderUnit))}</option>${
          p.packSize > 1 ? `<option value="stock"${r.unitKind === "stock" ? " selected" : ""}>${esc(unitPlural(p.stockUnit))}</option>` : ""}`
      : '<option value="order">units</option>';
    const waiting = dups.find((d) => isWaiting(d.q));
    const unit = p ? (r.unitKind === "stock" ? p.stockUnit : p.orderUnit) : "";
    const more = p ? plural(r.qty || 1, unit) : `${r.qty || 1} more`;
    const dupHtml = !dups.length ? ""
      : waiting ? `<div class="or-dup-box is-block" role="status">
          <div class="or-dup-t">Already waiting in ${esc(whose(waiting.q))} request</div>
          <p>${esc(who(waiting.q))} asked for ${esc(plural(waiting.it.qty, waiting.it.unit))} ${esc(whenShort(waiting.q.createdAt))}
            (${esc(reqNumber(waiting.q))}). To keep it to one request, add what you need to it.</p>
          <div class="or-dup-acts">
            <button type="button" class="ff-btn is-primary" data-r="addto">Add ${esc(more)} to ${esc(whose(waiting.q))} request</button>
            <button type="button" class="ff-btn" data-r="remove">Remove it from mine</button>
          </div>
        </div>`
      : r.dupOk ? '<small class="or-dup-ok">Keeping it. The ordering team will see it was already asked for.</small>'
      : `<div class="or-dup-box" role="status">
          <div class="or-dup-t">⚠ Already being ordered</div>
          <ul>${dups.slice(0, 3).map((d) => `<li><b>${esc(who(d.q))}</b> asked for ${esc(plural(d.it.qty, d.it.unit))} ${esc(whenShort(d.q.createdAt))}
            · ${esc(reqState(d.q)[0])} <small>(${esc(reqNumber(d.q))})</small></li>`).join("")}</ul>
          <p>It's too late to add to that. If you still need more, keep it on yours.</p>
          <div class="or-dup-acts">
            <button type="button" class="ff-btn is-primary" data-r="remove">Remove it from mine</button>
            <button type="button" class="ff-btn" data-r="keep">Keep it, I need more</button>
          </div>
        </div>`;
        
      return `
      <div class="or-row" data-i="${i}">
        <div class="or-line">
          <div class="or-product or-pick">
            <input class="fe-input or-pick-in" type="text" data-r="search" autocomplete="off" spellcheck="false"
              role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="or-list-${i}" aria-label="Product"
              placeholder="${active.length ? "Type to find a product…" : "Type what's needed…"}" value="${esc(shown(r))}" />
            ${r.productId || r.isNew ? '<button type="button" class="or-pick-x" data-r="clear" aria-label="Clear the product" title="Clear">×</button>' : ""}
            <div class="or-pick-list" id="or-list-${i}" role="listbox" hidden></div>
          </div>
          <input class="fe-input or-qty" type="number" min="1" max="999" step="1" data-r="qty" value="${r.qty}" aria-label="Quantity" />
          <select class="fb-select or-unit" data-r="unit" aria-label="Unit">${units}</select>
          <button type="button" class="ib-tool is-danger" data-r="remove" aria-label="Remove" title="Remove">×</button>
        </div>
        ${r.isNew ? `<input class="fe-input" data-r="name" maxlength="150" placeholder="What's needed: name, brand and size" value="${esc(r.name)}" />` : ""}
        ${p ? `<small class="or-info">Now: Shelf ${p.stock.shelf} · JT ${p.stock.jt} ${esc(unitPlural(p.stockUnit))}${
          lowAt(p, "shelf") || lowAt(p, "jt") ? ' · <span class="inv-flag is-warn">Low</span>' : ""}</small>` : ""}
        ${dupHtml}
      </div>`;
  }
  const renderRows = () => { rowsEl.innerHTML = st.rows.map(rowHtml).join(""); };

  /* ---------- The product search ---------- */
  const catLabel = (p) => (INV_CATEGORIES.find((c) => c.key === p.category) || {}).label || "";
  const catOrder = (p) => { const k = INV_CATEGORIES.findIndex((c) => c.key === p.category); return k < 0 ? 99 : k; };
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  function shown(r) {
    const p = byId.get(r.productId);
    return p ? p.name : r.isNew ? "Something not on the list" : "";
  }
  let hi = 0;      // the highlighted option in the open list
  let picks = [];  // what the open list offers, in order (product ids, then "__new")

  function listHtml(i, q) {
    const ws = norm(q).split(" ").filter(Boolean);
    const taken = new Set(st.rows.filter((x, k) => k !== i && x.productId).map((x) => x.productId));
    const starts = (p) => (ws.length && norm(p.name).startsWith(ws[0]) ? 1 : 0);
    const hits = active
      .filter((p) => { const t = norm(`${p.name} ${catLabel(p)}`); return ws.every((w) => t.includes(w)); })
      .sort((a, b) => (ws.length ? starts(b) - starts(a) : catOrder(a) - catOrder(b)) || a.name.localeCompare(b.name));
    const list = hits.slice(0, ws.length ? 40 : 400);
    picks = list.map((p) => p.id).concat("__new");
    if (hi >= picks.length) hi = picks.length - 1;
    if (hi < 0) hi = 0;
    let lastCat = null;
    const opts = list.map((p, k) => {
      const head = !ws.length && p.category !== lastCat ? `<div class="or-pick-cat">${esc(catLabel(p) || "Other")}</div>` : "";
      lastCat = p.category;
      return `${head}<button type="button" class="or-opt${k === hi ? " is-on" : ""}" role="option" aria-selected="${k === hi}" data-pick="${esc(p.id)}" tabindex="-1">
        <span class="or-opt-n">${esc(p.name)}</span></button>`;
    }).join("");
    const last = picks.length - 1;
    const typed = String(q || "").trim();
    return `${ws.length && !hits.length ? `<div class="or-pick-none">No products match “${esc(typed)}”.</div>` : ""}${opts}
      ${hits.length > list.length ? `<div class="or-pick-none">${hits.length - list.length} more. Keep typing to narrow it down.</div>` : ""}
      <button type="button" class="or-opt is-new${last === hi ? " is-on" : ""}" role="option" aria-selected="${last === hi}" data-pick="__new" tabindex="-1">
        <span class="or-opt-n">+ Something not on the list${typed ? `: “${esc(typed)}”` : ""}</span></button>`;
  }

  function openList(input, resetHi = true) {
    const row = input.closest("[data-i]");
    const box = input.parentElement.querySelector(".or-pick-list");
    if (!row || !box) return;
    if (resetHi) hi = 0;
    box.innerHTML = listHtml(Number(row.dataset.i), input.dataset.typed ? input.value : "");
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    const on = box.querySelector(".or-opt.is-on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }

  function closeList(input) {
    const row = input.closest("[data-i]");
    if (!row) return;   // already redrawn
    const box = input.parentElement.querySelector(".or-pick-list");
    if (box) box.hidden = true;
    input.setAttribute("aria-expanded", "false");
    const r = st.rows[Number(row.dataset.i)];
    if (r) { input.value = shown(r); delete input.dataset.typed; }   // back to what's chosen
  }

  function choose(i, id, typed) {
    const r = st.rows[i];
    if (!r) return;
    r.isNew = id === "__new";
    r.productId = r.isNew ? "" : id;
    if (r.isNew && !r.name) r.name = typed || "";
    r.unitKind = "order";
    r.dupOk = false;   // a new choice is checked again
    const p = byId.get(r.productId);
    if (p && lowAt(p, st.loc)) r.qty = suggestOrder(p, st.loc);
    msgEl.textContent = "";
    renderRows();
    const row = rowsEl.querySelector(`[data-i="${i}"]`);
    const next = row && row.querySelector(r.isNew ? '[data-r="name"]' : '[data-r="qty"]');
    if (next) { next.focus(); if (next.select) next.select(); }
  }

  function renderMine() {
    const mine = requests.filter((q) => q.requestedByUid === myUid()).slice(0, 15);
    $('[data-role="mine"]').innerHTML = mine.length ? `<ul class="or-mine">${mine.map((q) => `
      <li>
        <div class="or-mine-head"><strong>${esc(reqNumber(q))}</strong>${q.status === "open" && q.approval === "waiting"
          ? `<span class="rq-status is-appr">${esc(apWait)}</span>`
          : `<span class="rq-status is-${q.status}">${esc(REQ_STATUS[q.status])}</span>`}
          <small>${esc(day(q.createdAt))}</small></div>
        <span>${esc(q.items.map((it) => `${it.name} × ${plural(it.qty, it.unit)}`).join(", "))}</span>
        ${q.response ? `<small class="muted">${esc([q.handledBy || q.approvedBy, q.response].filter(Boolean).join(": "))}</small>` : ""}
        ${q.approvalNote && q.approvalNote !== q.response
          ? `<small class="muted">${esc(q.approvedBy || "Approver")}: “${esc(q.approvalNote)}”</small>` : ""}
        ${q.status === "open" ? `<button type="button" class="hx-add" data-cancel="${esc(q.id)}">Cancel request</button>` : ""}
      </li>`).join("")}</ul>` : '<p class="tb-none">You haven\'t requested anything yet.</p>';
  }

  function renderPending() {
    const list = pending();
    const showing = showAllPending ? list : list.slice(0, 5);
    $('[data-role="pending"]').innerHTML = list.length ? `
      <p class="muted or-pend-lead">Check here first, so the same thing isn't asked for twice. Need more of something? Press + to add it to yours.</p>
      <ul class="or-pend">${showing.map((q) => {
        const [label, cls] = reqState(q);
        return `<li>
          <div class="or-pend-head"><strong>${esc(who(q))}</strong>${
            q.urgency === "urgent" && q.status === "open" ? ' <span class="inv-flag is-bad">Urgent</span>' : ""}
            <span class="or-pend-st ${cls}">${esc(label)}</span></div>
          <small class="muted">${esc(whenShort(q.createdAt))} · for ${q.loc === "jt" ? "JT storage" : "the Shelf"} · ${esc(reqNumber(q))}</small>
          <div class="or-pend-items">${q.items.map((it, i) => `<span class="or-pend-item">${esc(it.name)} × ${esc(plural(it.qty, it.unit))}
            <button type="button" class="or-pend-add" data-add="${esc(q.id)}" data-ai="${i}" title="Add this to my request"
              aria-label="${esc(`Add ${it.name} to my request`)}">+</button></span>`).join("")}</div>
        </li>`;
      }).join("")}</ul>
      ${list.length > 5 ? `<button type="button" class="hx-add" data-act="pend-all">${showAllPending ? "Show fewer" : `Show all ${list.length}`}</button>` : ""}`
      : '<p class="tb-none">Nothing is waiting to be ordered. 👍</p>';
  }

  // Adds this row's amount to the request it's already waiting in (through Apps Script), then takes it off this list
  async function addToWaiting(i, btn) {
    const r = st.rows[i];
    const d = r && dupsFor(r).find((x) => isWaiting(x.q));
    if (!d) return;
    if (!(r.qty >= 1)) { msgEl.textContent = "Enter how many more you need first."; return; }
    const p = byId.get(r.productId);
    const pack = p ? Math.max(1, p.packSize) : 1;
    const qtyStock = p ? (r.unitKind === "stock" ? r.qty : r.qty * pack) : r.qty;
    const qtyOrder = p ? (r.unitKind === "stock" ? Math.ceil(r.qty / pack) : r.qty) : r.qty;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      const res = await callApi({ action: "invRequestAdd", requestId: d.q.id, productId: p ? p.id : "", name: p ? "" : r.name.trim(),
        qtyStock, qtyOrder, note: $('[data-role="note"]').value.trim() });
      if (!res || res.ok === false || res.problem) throw new Error((res && (res.problem || res.error)) || "No answer came back");
      st.rows.splice(i, 1);
      if (!st.rows.length) st.rows.push(blankRow());
      msgEl.textContent = "";
      showToast(`Added to ${whose(d.q)} request (${reqNumber(d.q)}). It's now ${plural(res.qty, res.unit)}.`);
      await reload();
    } catch (err) {
      console.error("Add to request failed:", err);
      msgEl.textContent = `Couldn't add it: ${err.message || err}`;
      if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
      reload();
    }
  }

  async function reload() {
    try { requests = await listRequests({ max: 200 }); } catch (err) { console.warn("Requests reload failed:", err); }
    if (root.isConnected) { renderRows(); renderMine(); renderPending(); }
  }

  /* ---------- Events ---------- */
  rowsEl.addEventListener("change", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const r = st.rows[Number(row.dataset.i)];
    if (e.target.dataset.r === "unit") {
      r.unitKind = e.target.value === "stock" ? "stock" : "order";
    }
    if (e.target.dataset.r === "name") { r.dupOk = false; renderRows(); }   // a typed item: checked once it's been typed
  });
  rowsEl.addEventListener("input", (e) => {
    if (e.target.dataset.r === "search") { e.target.dataset.typed = "1"; openList(e.target); return; }
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const r = st.rows[Number(row.dataset.i)];
    if (e.target.dataset.r === "qty") r.qty = Math.min(999, Math.max(0, parseInt(e.target.value, 10) || 0));
    if (e.target.dataset.r === "name") r.name = e.target.value;
    msgEl.textContent = "";
  });
  rowsEl.addEventListener("click", (e) => {
    const pk = e.target.closest("[data-pick]");
    if (pk) {
      const inp = pk.closest(".or-pick").querySelector('[data-r="search"]');
      choose(Number(pk.closest("[data-i]").dataset.i), pk.dataset.pick, inp && inp.dataset.typed ? inp.value.trim() : "");
      return;
    }
    const cl = e.target.closest('[data-r="clear"]');
    if (cl) {
      const i = Number(cl.closest("[data-i]").dataset.i);
      Object.assign(st.rows[i], { productId: "", isNew: false, name: "", unitKind: "order" });
      renderRows();
      const inp = rowsEl.querySelector(`[data-i="${i}"] [data-r="search"]`);
      if (inp) inp.focus();
      return;
    }
    const at = e.target.closest('[data-r="addto"]');
    if (at) { addToWaiting(Number(at.closest("[data-i]").dataset.i), at); return; }
    const kp = e.target.closest('[data-r="keep"]');
    if (kp) { st.rows[Number(kp.closest("[data-i]").dataset.i)].dupOk = true; renderRows(); return; }
    const rm = e.target.closest('[data-r="remove"]');
    if (!rm) return;
    st.rows.splice(Number(rm.closest("[data-i]").dataset.i), 1);
    if (!st.rows.length) st.rows.push(blankRow());
    renderRows();
  });

  rowsEl.addEventListener("focusin", (e) => {
    const inp = e.target.closest('[data-r="search"]');
    if (!inp) return;
    delete inp.dataset.typed;
    inp.select();
    openList(inp);
  });
  rowsEl.addEventListener("focusout", (e) => {
    const inp = e.target.closest('[data-r="search"]');
    if (inp) setTimeout(() => { if (document.activeElement !== inp) closeList(inp); }, 200);
  });
  // Keeps the box focused (and the iPad keyboard up) while a result is tapped
  rowsEl.addEventListener("pointerdown", (e) => { if (e.target.closest("[data-pick]")) e.preventDefault(); });
  rowsEl.addEventListener("keydown", (e) => {
    const inp = e.target.closest('[data-r="search"]');
    if (!inp) return;
    const box = inp.parentElement.querySelector(".or-pick-list");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (box.hidden) { openList(inp); return; }
      hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + picks.length) % picks.length;
      openList(inp, false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!box.hidden && picks[hi]) choose(Number(inp.closest("[data-i]").dataset.i), picks[hi], inp.dataset.typed ? inp.value.trim() : "");
    } else if (e.key === "Escape") {
      closeList(inp);
    }
  });

  root.addEventListener("change", (e) => {
    if (e.target.name === "or-loc") st.loc = e.target.value;
    if (e.target.name === "or-urgency") st.urgency = e.target.value;
  });

  root.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="add"]')) {
      st.rows.push(blankRow());
      renderRows();
      const sels = rowsEl.querySelectorAll('[data-r="search"]');
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
    if (e.target.closest('[data-act="pend-all"]')) { showAllPending = !showAllPending; renderPending(); return; }
    const ad = e.target.closest("[data-add]");
    if (ad) {
      const q = requests.find((x) => x.id === ad.dataset.add);
      const it = q && q.items[Number(ad.dataset.ai)];
      if (!it) return;
      const p = it.productId ? byId.get(it.productId) : null;
      if (p && st.rows.some((r) => r.productId === p.id)) { showToast(`${p.name} is already on your list.`); return; }
      const row = p && p.active
        ? { productId: p.id, name: "", isNew: false, qty: 1, unitKind: "order", dupOk: true }
        : { productId: "", name: it.name, isNew: true, qty: 1, unitKind: "order", dupOk: true };
      st.rows = [...st.rows.filter((r) => r.productId || r.isNew), row];
      renderRows();
      showToast(`${it.name} added. Set how many more you need.`);
      const qs = rowsEl.querySelectorAll('[data-r="qty"]');
      if (qs.length) { qs[qs.length - 1].focus(); qs[qs.length - 1].select(); }
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

    // Already asked for: confirm anything still flagged, and tell the ordering team either way
    const filled = st.rows.filter((r) => byId.get(r.productId) || (r.isNew && r.name.trim()));
    const blocked = filled.filter((r) => dupsFor(r).some((d) => isWaiting(d.q)));
    if (blocked.length) {
      const one = blocked.length === 1;
      msgEl.textContent = `${blocked.map(nameOf).join(", ")} ${one ? "is" : "are"} already waiting in another request. `
        + `Add ${one ? "it" : "them"} to that request, or remove ${one ? "it" : "them"} from yours.`;
      const box = rowsEl.querySelector(".or-dup-box.is-block");
      if (box) box.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const flagged = filled.filter((r) => !r.dupOk && dupsFor(r).length);
    st.busy = true;
    if (flagged.length) {
      const ok = await confirmDialog({
        title: flagged.length === 1 ? "This is already requested" : "Some of this is already requested",
        message: `${flagged.map((r) => { const d = dupsFor(r)[0]; return `${nameOf(r)}: ${who(d.q)} asked ${whenShort(d.q.createdAt)} (${reqState(d.q)[0].toLowerCase()})`; })
          .join(" · ")}. Send it anyway?`,
        confirmLabel: "Send anyway",
      });
      if (!ok) { st.busy = false; return; }
    }
    const also = filled.filter((r) => dupsFor(r).length).map((r) => {
      const d = dupsFor(r)[0];
      return `${nameOf(r)} (also asked for by ${d.q.requestedBy || "someone"}, ${reqNumber(d.q)})`;
    });
    const note = [$('[data-role="note"]').value.trim(), also.length ? `Already requested: ${also.join("; ")}` : ""].filter(Boolean).join("\n");
    sendBtn.disabled = true;
    sendBtn.querySelector("span").textContent = "Sending…";
    try {
      const id = await createRequest({ items, loc: st.loc, urgency: st.urgency, note }, staff);
      callApi({ action: "inventory", op: "notifyRequest", requestId: id }).catch((err) => console.warn("Request email failed:", err));
      showToast(viaApprover ? `Request sent. It goes to ${apShort || "the approver"} for approval first.` : "Request sent to the ordering team");
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
  renderPending();
}

/* ---------- Styles: the product search ---------- */
const CSS = `
.or-pick{position:relative;flex:1 1 260px;min-width:0}
.or-pick-in{width:100%;box-sizing:border-box;padding-right:36px}
.or-pick-x{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:26px;height:26px;border:0;border-radius:50%;
  background:#f1f5f9;color:#475569;font-size:16px;line-height:1;cursor:pointer}
.or-pick-x:hover{background:#e2e8f0}
.or-pick-list{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:30;max-height:340px;overflow:auto;padding:6px;
  border:1px solid #e5e7eb;border-radius:12px;background:#fff;box-shadow:0 12px 32px rgba(15,23,42,.14)}
.or-pick-cat{padding:8px 10px 4px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#64748b}
.or-opt{display:block;width:100%;padding:9px 10px;border:0;border-radius:8px;background:none;font:inherit;text-align:left;color:inherit;cursor:pointer}
.or-opt:hover,.or-opt.is-on{background:#f0fdfa}
.or-opt-n{display:block;font-size:14px;font-weight:600}
.or-opt small{display:block;margin-top:1px;font-size:12px;color:#64748b}
.or-opt-low{color:#b45309}
.or-opt.is-new{margin-top:4px;border-top:1px solid #f1f5f9;border-radius:0 0 8px 8px}
.or-opt.is-new .or-opt-n{color:#0f766e}
.or-pick-none{padding:10px;font-size:13px;color:#64748b}
.or-dup-box{margin-top:8px;padding:10px 12px;border:1px solid #fde68a;border-radius:10px;background:#fffbeb;color:#78350f;font-size:13px}
.or-dup-t{font-weight:700;margin-bottom:4px}
.or-dup-box ul{margin:0 0 8px;padding-left:18px;line-height:1.5}
.or-dup-acts{display:flex;flex-wrap:wrap;gap:6px}
.or-dup-ok{display:block;margin-top:4px;color:#92400e}
.or-dup-box p{margin:0 0 8px;line-height:1.45}
.or-dup-box.is-block{border-color:#fdba74;background:#fff7ed;color:#7c2d12}
.or-pend-lead{margin:0 0 8px;font-size:13px}
.or-pend{list-style:none;margin:0 0 6px;padding:0;display:flex;flex-direction:column;gap:8px}
.or-pend li{padding:10px 12px;border:1px solid #e5e7eb;border-radius:10px;background:#fff}
.or-pend-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.or-pend-st{margin-left:auto;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:#f1f5f9;color:#475569}
.or-pend-st.is-wait{background:#fef3c7;color:#92400e}
.or-pend-st.is-po{background:#dbeafe;color:#1d4ed8}
.or-pend-st.is-ordered{background:#dcfce7;color:#166534}
.or-pend-st.is-appr,.rq-status.is-appr{background:#ede9fe;color:#6d28d9}
.or-pend-items{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.or-pend-item{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 9px;border-radius:999px;background:#f1f5f9;font-size:12.5px}
.or-pend-add{width:20px;height:20px;border:0;border-radius:50%;background:#0f766e;color:#fff;font-size:14px;line-height:1;cursor:pointer}
.or-pend-add:hover{background:#115e59}
`;
function injectCss() {
  if (document.getElementById("order-request-css")) return;
  const s = document.createElement("style");
  s.id = "order-request-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}