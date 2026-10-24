// Scanner → Today → a saved scan: see what was recorded, correct it, or delete it.
// Billing sheets and prescriptions only change the scan record (invoices take the stock off),
// so a correction is one update, with the edit history kept and the first version in "original".
import { getScan, updateScan, bookingsOn, searchPatientsQuick, money } from "./scanner-api.js";
import { INV_CATEGORIES, dayKey } from "./inventory-api.js";
import { rxProductList } from "./rx-products.js";
import { patientIds } from "./patients.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TYPE_IT = "__type";
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const when = (v) => {
  const d = v && typeof v.toDate === "function" ? v.toDate() : v ? new Date(v) : null;
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
};
const lineText = (l) => `${parseInt(l.take, 10) || 0} × ${l.productName || "Not matched"}${
  l.fee !== null && l.fee !== undefined && l.fee !== "" ? ` (${money(l.fee)})` : ""}`;
const itemKey = (it) => [it.product, it.strengths, it.quantity, it.directions, it.repeats].map((x) => String(x || "").trim()).join("|");
const itemText = (it) => [it.product, it.strengths, it.quantity && `qty ${it.quantity}`].filter(Boolean).join(" ");
const KIND_NAME = { billing: "Billing sheet", rx: "Prescription", docket: "Delivery docket" };

export async function openScanReview({ id, products = [], onChanged = () => {} }) {
  let scan;
  try { scan = await getScan(id); }
  catch (err) { console.error("Scan not opened:", err); showToast("That scan couldn't be opened. Try again."); return; }
  if (!scan) { showToast("That scan no longer exists."); return; }

  const byId = new Map(products.map((p) => [p.id, p]));
  const rxList = rxProductList();
  const st = { mode: "view", busy: false, err: "", d: null, pick: false, q: "", hits: [], searching: false, bookings: null, bookFor: "" };
  let timer = null, seq = 0;
  const editable = () => ["billing", "rx"].includes(scan.kind) && scan.status !== "deleted" && can(`scanner.${scan.kind}`);

  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg scan-rev";
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => { clearTimeout(timer); dlg.remove(); });
  dlg.addEventListener("cancel", (e) => { if (st.busy) e.preventDefault(); });

  /* ---------- Viewing ---------- */
  function headHtml() {
    const url = scan.photo && scan.photo.url;
    return `<div class="lh-dialog-head scan-rev-head">
        <div><h3>${esc(KIND_NAME[scan.kind] || "Scan")}${scan.status === "deleted" ? ' <span class="inv-flag is-bad">Deleted</span>' : ""}</h3>
          <p>Saved ${esc(when(scan.at))}${scan.by ? ` by ${esc(scan.by)}` : ""}${
            scan.editCount ? ` · changed ${scan.editCount} time${scan.editCount === 1 ? "" : "s"}` : ""}</p></div>
        <button type="button" class="ib-tool" data-act="close" aria-label="Close" title="Close">×</button>
      </div>
      ${url ? `<a class="scan-rev-photo" href="${esc(url)}" target="_blank" rel="noopener" title="Open the photo full size">
          <img src="${esc(url)}" alt="The scanned photo" /></a>` : '<p class="tb-none">No photo was saved with this scan.</p>'}`;
  }

  function billingView() {
    const lines = scan.lines || [];
    return `<dl class="scan-rev-dl">
        <dt>Patient</dt><dd><strong>${esc(scan.patientName || "Not read")}</strong>${scan.patientPttId ? ` · ID ${esc(scan.patientPttId)}` : ""}
          ${scan.readName && scan.readName !== scan.patientName ? `<small class="muted">Written as “${esc(scan.readName)}”</small>` : ""}
          ${scan.bookedAt ? `<small class="muted">Booked ${esc(scan.bookedAt)}${scan.bookedWith ? ` with ${esc(scan.bookedWith)}` : ""}</small>` : ""}</dd>
        <dt>Appointment</dt><dd>${esc([niceDate(scan.apptDate), scan.apptTime, scan.provider].filter(Boolean).join(" · ") || "Not read")}</dd>
      </dl>
      <table class="inv-table"><thead><tr><th>Product</th><th>Given</th><th>Fee</th></tr></thead><tbody>${lines.length
        ? lines.map((l) => `<tr><td>${esc(l.productName || "Not matched")}
            <small class="muted">${esc([l.written && `Written “${l.written}”`, l.seen ? `in the photo ×${l.seen}` : ""].filter(Boolean).join(" · "))}</small>
            ${(l.flags || []).map((f) => `<span class="scan-flag is-warn">${esc(f)}</span>`).join("")}</td>
            <td>${parseInt(l.take, 10) || 0}</td><td>${esc(money(l.fee))}</td></tr>`).join("")
        : '<tr><td colspan="3" class="tb-none">No products recorded.</td></tr>'}</tbody></table>
      <p class="scan-total">Products total ${esc(money(scan.productsTotal || 0))}</p>
      ${scan.note ? `<p class="inv-hint">${esc(scan.note)}</p>` : ""}`;
  }

  function rxView() {
    const items = scan.items || [];
    return `<dl class="scan-rev-dl">
        <dt>Patient</dt><dd><strong>${esc(scan.patientName || "")}</strong>${scan.patientPttId ? ` · ID ${esc(scan.patientPttId)}` : ""}
          ${scan.readName && scan.readName !== scan.patientName ? `<small class="muted">Written as “${esc(scan.readName)}”</small>` : ""}</dd>
        <dt>Date</dt><dd>${esc(niceDate(scan.recordDate) || "Not read")}</dd>
        <dt>Prescriber</dt><dd>${esc([scan.prescriber, scan.scriptNumber && `Script ${scan.scriptNumber}`].filter(Boolean).join(" · ") || "Not read")}</dd>
      </dl>
      <ul class="scan-rev-items">${items.map((it) => `<li><strong>${esc(it.product || "Not chosen")}</strong>${
          it.custom ? ' <span class="inv-flag is-warn">Typed in</span>' : ""}
        <small>${esc([it.strengths, it.quantity && `Qty ${it.quantity}`, it.directions, it.repeats && `${it.repeats} repeats`].filter(Boolean).join(" · "))}</small>
        ${it.text ? `<small class="muted">Written: ${esc(it.text).replace(/\n/g, " / ")}</small>` : ""}</li>`).join("")
        || '<li class="tb-none">No items.</li>'}</ul>
      ${scan.note ? `<p class="inv-hint">${esc(scan.note)}</p>` : ""}`;
  }

  function docketView() {
    const moved = scan.status === "transferred";
    return `<dl class="scan-rev-dl">
        <dt>${moved ? "Moved" : "Supplier"}</dt><dd>${esc(moved ? "JT storage → Shelf" : scan.supplierName || "Not read")}</dd>
        <dt>Docket</dt><dd>${esc([scan.docketNumber, niceDate(scan.docketDate)].filter(Boolean).join(" · ") || "Not read")}</dd>
        <dt>Order</dt><dd>${esc(scan.poNumber || "Not linked")}</dd>
        <dt>Received by</dt><dd>${esc(scan.receivedBy || "")}</dd>
      </dl>
      <table class="inv-table"><thead><tr><th>Product</th><th>Qty</th><th>Batch</th><th>Expiry</th></tr></thead><tbody>${
        (scan.lines || []).map((l) => `<tr><td>${esc(l.productName || l.text || "Not matched")}${l.skip ? ' <small class="muted">not received</small>' : ""}</td>
          <td>${esc(l.qty)}</td><td>${esc(l.batch || "")}</td><td>${esc(niceDate(l.expiry))}</td></tr>`).join("")}</tbody></table>
      <p class="inv-hint">Dockets can't be changed here. A delivery is corrected on its purchase order.</p>`;
  }

  function histHtml() {
    const list = Array.isArray(scan.edits) ? scan.edits : [];
    return list.length ? `<details class="scan-rev-hist"><summary>Changes (${list.length})</summary><ul>${list.slice().reverse().map((e) =>
      `<li><strong>${e.deleted ? "Deleted" : "Changed"}</strong> ${esc(when(e.at))}${e.by ? ` by ${esc(e.by)}` : ""}
        <small>${esc(e.reason || "")}</small>${(e.changes || []).map((c) => `<small class="muted">${esc(c)}</small>`).join("")}</li>`).join("")}</ul></details>` : "";
  }

  function viewBody() {
    const del = scan.status === "deleted"
      ? `<p class="scan-err">Deleted${scan.deletedBy ? ` by ${esc(scan.deletedBy)}` : ""}: ${esc(scan.deleteReason || "")}</p>` : "";
    const body = scan.kind === "billing" ? billingView() : scan.kind === "rx" ? rxView() : docketView();
    return del + body + histHtml();
  }

  /* ---------- Editing ---------- */
  const hitsHtml = () => (st.searching ? '<p class="muted">Searching…</p>'
    : st.q.trim().length < 2 ? '<p class="muted">Type a name or patient ID.</p>'
    : !st.hits.length ? '<p class="muted">No patients match.</p>'
    : st.hits.map((p, i) => `<button type="button" class="rx-hit" data-hit="${i}"><strong>${esc(p.name)}</strong>
        <small>${esc([p.pttId && `ID ${p.pttId}`, p.dob || p.dobKey].filter(Boolean).join(" · "))}</small></button>`).join(""));
  const drawHits = () => { const b = dlg.querySelector('[data-role="hits"]'); if (b) b.innerHTML = hitsHtml(); };

  const bookHtml = () => {
    const list = st.bookings || [];
    if (scan.kind !== "billing" || !list.length) return "";
    return `<select class="fb-select" data-role="booking" aria-label="Bookings that day">
      <option value="">Bookings on ${esc(niceDate(st.d.apptDate || scan.dateKey))}…</option>
      ${list.map((a, i) => `<option value="${i}">${esc([a.time, a.patientName, a.staff].filter(Boolean).join(" · "))}</option>`).join("")}</select>`;
  };

  function patientHtml() {
    const p = st.d.patient;
    const sub = scan.kind === "billing"
      ? [p.pttId && `ID ${p.pttId}`, p.time && `Booked ${p.time}${p.staff ? ` with ${p.staff}` : ""}`]
      : [p.pttId && `ID ${p.pttId}`];
    return `<section class="rx-sec"><h4>Patient</h4>
      <div class="rx-pat ${p.name ? "is-ok" : "is-no"}"><span>${p.name
        ? `✓ <strong>${esc(p.name)}</strong><small>${esc(sub.filter(Boolean).join(" · "))}</small>` : "No patient chosen."}</span>
        <button type="button" class="scan-pat-btn" data-act="pick">${st.pick ? "cancel" : "change"}</button></div>
      ${st.pick ? `<div class="rx-find"><div data-role="book">${bookHtml()}</div>
        <input type="search" class="fe-input" data-role="q" placeholder="Search all patients by name or patient ID" value="${esc(st.q)}" autocomplete="off" />
        <div class="rx-hits" data-role="hits">${hitsHtml()}</div></div>` : ""}
    </section>`;
  }

  const reasonHtml = (hint) => `<label class="lh-field"><span class="lh-label">Why it's being changed</span>
      <input class="fe-input" data-role="reason" maxlength="300" value="${esc(st.d.reason)}"
        placeholder="e.g. Saved to the wrong patient · Wrong quantity" /></label>
    ${hint ? `<p class="inv-hint">${hint}</p>` : ""}`;

  const prodOpts = (l) => `<option value="">Choose the product…</option>${INV_CATEGORIES.map((c) => {
      const g = products.filter((p) => p.category === c.key);
      return g.length ? `<optgroup label="${esc(c.label)}">${g.map((p) =>
        `<option value="${esc(p.id)}"${p.id === l.productId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>` : "";
    }).join("")}${l.productId && !byId.has(l.productId)
      ? `<option value="${esc(l.productId)}" selected>${esc(l.productName || "Product")} (not on the list)</option>` : ""}`;

  const lineHtml = (l, i) => `<div class="scan-rev-line" data-i="${i}">
      <select class="fb-select" data-l="productId" aria-label="Product">${prodOpts(l)}</select>
      <label>Given <input class="fe-input inv-num" type="number" min="0" max="99" step="1" inputmode="numeric" data-l="take" value="${esc(l.take)}" /></label>
      <label>$ <input class="fe-input inv-num" type="number" min="0" step="0.01" inputmode="decimal" data-l="fee" value="${esc(l.fee ?? "")}" aria-label="Fee" /></label>
      <button type="button" class="ib-tool is-danger" data-act="line-x" aria-label="Remove this product" title="Remove">×</button>
      ${l.written || l.seen ? `<small class="muted">${esc([l.written && `Written “${l.written}”`, l.seen ? `in the photo ×${l.seen}` : ""].filter(Boolean).join(" · "))}</small>` : ""}
    </div>`;
  const total = () => r2(st.d.lines.reduce((a, l) => a + (Number(l.fee) || 0), 0));

  function billingEdit() {
    return `${patientHtml()}
      <section class="rx-sec"><h4>Appointment date</h4>
        <input type="date" class="fe-input" data-role="date" value="${esc(st.d.apptDate)}" max="${dayKey()}" /></section>
      <section class="rx-sec"><h4>Products given</h4>
        <div data-role="lines">${st.d.lines.map(lineHtml).join("") || '<p class="tb-none">No products.</p>'}</div>
        <button type="button" class="hx-add" data-act="line-add">+ Add a product</button>
        <p class="scan-total" data-role="total">Products total ${esc(money(total()))}</p></section>
      <label class="lh-field"><span class="lh-label">Note (optional)</span>
        <textarea class="fe-input" data-role="note" rows="2" maxlength="1000">${esc(st.d.note)}</textarea></label>
      ${reasonHtml("Saving marks the sheet as checked. Stock isn't changed: the Timely invoices take it off.")}`;
  }

  const itemHtml = (it, i) => `<div class="rx-item" data-i="${i}">
      <div class="rx-item-top">
        <select class="fb-select" data-rx="product" aria-label="Product"><option value="">Choose the product…</option>${
          rxList.map((n) => `<option${!it.custom && n === it.product ? " selected" : ""}>${esc(n)}</option>`).join("")}
          <option disabled>──────────</option>
          <option value="${TYPE_IT}"${it.custom ? " selected" : ""}>Not on the list: type the name…</option></select>
        <button type="button" class="ib-tool is-danger" data-act="item-x" aria-label="Remove this item" title="Remove">×</button>
      </div>
      ${it.custom ? `<input class="fe-input rx-custom" data-rx="customName" maxlength="150" value="${esc(it.customName)}" placeholder="Product name" aria-label="Product name" />` : ""}
      ${it.text ? `<small class="muted">Written: ${esc(it.text).replace(/\n/g, " / ")}</small>` : ""}
      <div class="rx-fields">
        <label><span>Strengths</span><input class="fe-input" data-rx="strengths" maxlength="300" value="${esc(it.strengths)}" /></label>
        <label><span>Quantity</span><input class="fe-input" data-rx="quantity" maxlength="60" value="${esc(it.quantity)}" /></label>
        <label><span>Directions</span><input class="fe-input" data-rx="directions" maxlength="300" value="${esc(it.directions)}" /></label>
        <label><span>Repeats</span><input class="fe-input" data-rx="repeats" maxlength="20" value="${esc(it.repeats)}" /></label>
      </div></div>`;

  function rxEdit() {
    return `${patientHtml()}
      <section class="rx-sec"><h4>Prescription date</h4>
        <input type="date" class="fe-input" data-role="date" value="${esc(st.d.recordDate)}" max="${dayKey()}" /></section>
      <section class="rx-sec"><h4>Prescribed</h4>
        <div data-role="items">${st.d.items.map(itemHtml).join("")}</div>
        <button type="button" class="hx-add" data-act="item-add">+ Add another item</button></section>
      <label class="lh-field"><span class="lh-label">Note (optional)</span>
        <textarea class="fe-input" data-role="note" rows="2" maxlength="1000">${esc(st.d.note)}</textarea></label>
      ${reasonHtml("")}`;
  }

  const deleteHtml = () => `<p class="inv-hint">It's taken off Today${scan.kind === "rx" ? " and the patient's Product Prescriptions" : ""}.
      The scan is kept, marked deleted, with your reason.${scan.kind === "billing" ? " Stock isn't changed: billing sheets never took stock off." : ""}</p>
    <label class="lh-field"><span class="lh-label">Why it's being deleted</span>
      <input class="fe-input" data-role="reason" maxlength="300" value="${esc(st.d.reason)}" placeholder="e.g. Scanned twice · Not a billing sheet" /></label>`;

  function actsHtml() {
    if (st.mode === "edit") {
      return '<button type="button" class="lh-btn is-quiet" data-act="view">Cancel</button><button type="button" class="lh-btn is-primary" data-act="save">Save changes</button>';
    }
    if (st.mode === "delete") {
      return '<button type="button" class="lh-btn is-quiet" data-act="view">Back</button><button type="button" class="lh-btn is-primary scan-rev-del" data-act="delete-go">Delete scan</button>';
    }
    return `<button type="button" class="lh-btn is-quiet" data-act="close">Close</button>${editable()
      ? '<button type="button" class="lh-btn is-quiet scan-rev-del" data-act="delete">Delete scan</button><button type="button" class="lh-btn is-primary" data-act="edit">Edit</button>' : ""}`;
  }

  function draw() {
    const body = st.mode === "edit" ? (scan.kind === "billing" ? billingEdit() : rxEdit())
      : st.mode === "delete" ? deleteHtml() : viewBody();
    dlg.innerHTML = `<div class="lh-form">${headHtml()}${body}
      <p class="lh-error" role="alert"${st.err ? "" : " hidden"}>${esc(st.err)}</p>
      <div class="lh-actions">${actsHtml()}</div></div>`;
  }

  const fail = (msg) => {
    st.err = msg;
    const el = dlg.querySelector(".lh-error");
    if (el) { el.textContent = msg; el.hidden = false; el.scrollIntoView({ block: "nearest" }); }
  };
  const setBusy = (on) => dlg.querySelectorAll(".lh-actions button").forEach((b) => { b.disabled = on; });

  function startEdit() {
    if (scan.kind === "billing") {
      st.d = {
        patient: { name: scan.patientName || "", pttId: scan.patientPttId || "", staff: scan.bookedWith || "", time: scan.bookedAt || "" },
        apptDate: scan.apptDate || "", note: scan.note || "", reason: "",
        lines: (scan.lines || []).map((l) => ({ ...l, take: parseInt(l.take, 10) || 0, fee: l.fee ?? null, feeEdited: false })),
      };
    } else {
      st.d = {
        patient: { id: scan.patientId || "", pttId: scan.patientPttId || "", name: scan.patientName || "", ids: scan.patientIds || [] },
        recordDate: scan.recordDate || "", note: scan.note || "", reason: "",
        items: (scan.items || []).map((it) => {
          const custom = !!it.custom || (!!it.product && !rxList.includes(it.product));
          return { ...it, custom, customName: custom ? it.product || "" : "" };
        }),
      };
      if (!st.d.items.length) st.d.items.push({ product: "", custom: false, customName: "", strengths: "", quantity: "", directions: "", repeats: "", text: "" });
    }
    Object.assign(st, { mode: "edit", err: "", pick: false, q: "", hits: [] });
    draw();
  }

  async function loadBookings() {
    if (scan.kind !== "billing") return;
    const date = st.d.apptDate || scan.dateKey;
    if (st.bookFor === date && st.bookings) return;
    st.bookFor = date;
    const list = await bookingsOn(date).catch(() => []);
    if (st.bookFor !== date || st.mode !== "edit") return;
    st.bookings = list;
    const box = dlg.querySelector('[data-role="book"]');
    if (box) box.innerHTML = bookHtml();
  }

  async function search() {
    const my = ++seq;
    if (st.q.trim().length < 2) { st.hits = []; st.searching = false; drawHits(); return; }
    st.searching = true;
    drawHits();
    const hits = await searchPatientsQuick(st.q).catch(() => []);
    if (my !== seq || !dlg.open) return;
    st.searching = false;
    st.hits = hits;
    drawHits();
  }

  function pickHit(i) {
    const h = st.hits[i];
    if (!h) return;
    st.d.patient = scan.kind === "billing"
      ? { name: h.name || "", pttId: String(h.pttId || ""), staff: "", time: "" }
      : { id: h.id, pttId: String(h.pttId || ""), name: h.name || "", ids: patientIds(h) };
    Object.assign(st, { pick: false, q: "", hits: [] });
    draw();
  }

  /* ---------- Saving ---------- */
  function billingChanges() {
    const d = st.d, changes = {}, summary = [];
    const p = d.patient;
    if (!p.name.trim()) throw new Error("Choose the patient.");
    if (p.name !== (scan.patientName || "") || p.pttId !== (scan.patientPttId || "")) {
      Object.assign(changes, { patientName: p.name, patientPttId: p.pttId || "", bookedWith: p.staff || "", bookedAt: p.time || "" });
      summary.push(`Patient: ${scan.patientName || "none"} → ${p.name}`);
    }
    if (d.apptDate && !/^\d{4}-\d{2}-\d{2}$/.test(d.apptDate)) throw new Error("Check the appointment date.");
    if (d.apptDate > dayKey()) throw new Error("The appointment date can't be in the future.");
    if (d.apptDate !== (scan.apptDate || "")) {
      changes.apptDate = d.apptDate;
      summary.push(`Appointment date: ${niceDate(scan.apptDate) || "none"} → ${niceDate(d.apptDate) || "none"}`);
    }
    const kept = d.lines.filter((l) => l.productId || parseInt(l.take, 10) || (l.fee !== null && l.fee !== ""));
    if (kept.some((l) => !l.productId)) throw new Error("Choose the product for every line, or remove it.");
    const lines = kept.map((l) => {
      const p2 = byId.get(l.productId);
      const fee = l.fee === null || l.fee === "" || !Number.isFinite(Number(l.fee)) ? null : r2(Math.max(0, Number(l.fee)));
      return {
        productId: l.productId, productName: p2 ? p2.name : String(l.productName || ""), written: String(l.written || ""),
        qty: Number(l.qty) || 0, fee, feeFrom: l.feeEdited ? "edited" : String(l.feeFrom || ""), seen: Number(l.seen) || 0,
        take: Math.min(99, Math.max(0, parseInt(l.take, 10) || 0)), seenAs: String(l.seenAs || ""), fixed: true,
        flags: Array.isArray(l.flags) ? l.flags.map(String).slice(0, 10) : [],
      };
    });
    const before = (scan.lines || []).map(lineText).join(", ");
    const after = lines.map(lineText).join(", ");
    if (before !== after) {
      changes.lines = lines;
      changes.productsTotal = r2(lines.reduce((a, l) => a + (l.fee || 0), 0));
      summary.push(`Products: ${before || "none"} → ${after || "none"}`);
    }
    const note = d.note.trim().slice(0, 1000);
    if (note !== (scan.note || "")) { changes.note = note; summary.push("Note changed"); }
    if (Object.keys(changes).length) Object.assign(changes, { flagCount: 0, status: "ok" });   // a person has checked it
    return { changes, summary };
  }

  function rxChanges() {
    const d = st.d, changes = {}, summary = [];
    const p = d.patient;
    if (!p.id) throw new Error("Choose the patient.");
    if (p.id !== scan.patientId) {
      Object.assign(changes, { patientId: p.id, patientPttId: p.pttId || "", patientIds: p.ids || [], patientName: p.name });
      summary.push(`Patient: ${scan.patientName || "none"} → ${p.name}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.recordDate || "")) throw new Error("Enter the prescription date.");
    if (d.recordDate > dayKey()) throw new Error("The prescription date can't be in the future.");
    if (d.recordDate !== (scan.recordDate || "")) {
      changes.recordDate = d.recordDate;
      summary.push(`Date: ${niceDate(scan.recordDate) || "none"} → ${niceDate(d.recordDate)}`);
    }
    const filled = d.items.filter((it) => it.product || (it.customName || "").trim() || it.text || it.strengths || it.quantity);
    if (!filled.length) throw new Error("Add what was prescribed.");
    if (filled.some((it) => (it.custom ? !(it.customName || "").trim() : !it.product))) {
      throw new Error("Choose the product, or type its name, for every item. Or remove it.");
    }
    const items = filled.map((it) => ({
      product: it.custom ? it.customName.trim().slice(0, 150) : it.product, text: String(it.text || ""),
      medicine: String(it.medicine || "").trim().slice(0, 200), custom: !!it.custom,
      strengths: String(it.strengths || "").trim().slice(0, 300), quantity: String(it.quantity || "").trim().slice(0, 60),
      directions: String(it.directions || "").trim().slice(0, 300), repeats: String(it.repeats || "").trim().slice(0, 20), fixed: true,
    }));
    if (items.map(itemKey).join("~") !== (scan.items || []).map(itemKey).join("~")) {
      changes.items = items;
      summary.push(`Items: ${(scan.items || []).map(itemText).join(", ") || "none"} → ${items.map(itemText).join(", ")}`);
    }
    const note = d.note.trim().slice(0, 1000);
    if (note !== (scan.note || "")) { changes.note = note; summary.push("Note changed"); }
    return { changes, summary };
  }

  async function run(fn, done) {
    st.busy = true;
    setBusy(true);
    try {
      await fn();
      showToast(done);
      scan = (await getScan(scan.id).catch(() => null)) || scan;
      Object.assign(st, { mode: "view", err: "", pick: false });
      draw();
      onChanged();
    } catch (ex) {
      console.error("Scan change failed:", ex);
      fail(ex && ex.code === "permission-denied" ? "You don't have access to change this scan."
        : ex && ex.message && !ex.code ? ex.message : "Couldn't save. Try again.");
    } finally {
      st.busy = false;
      setBusy(false);
    }
  }

  async function save() {
    let res;
    try { res = scan.kind === "billing" ? billingChanges() : rxChanges(); }
    catch (ex) { fail(ex.message); return; }
    if (!Object.keys(res.changes).length) { fail("Nothing has changed."); return; }
    if (!st.d.reason.trim()) { fail("Add why it's being changed."); return; }
    await run(() => updateScan(scan.id, res.changes, { reason: st.d.reason, summary: res.summary }), "Scan updated");
  }

  /* ---------- Events ---------- */
  dlg.addEventListener("click", async (e) => {
    const h = e.target.closest("[data-hit]");
    if (h) { pickHit(Number(h.dataset.hit)); return; }
    const b = e.target.closest("[data-act]");
    if (!b || st.busy) return;
    const act = b.dataset.act;
    const row = b.closest("[data-i]");
    if (act === "close") dlg.close();
    else if (act === "edit") startEdit();
    else if (act === "view") { Object.assign(st, { mode: "view", err: "", pick: false }); draw(); }
    else if (act === "delete") { st.d = { reason: "" }; Object.assign(st, { mode: "delete", err: "" }); draw(); }
    else if (act === "delete-go") {
      if (!st.d.reason.trim()) { fail("Add why it's being deleted."); return; }
      await run(() => updateScan(scan.id, {}, { reason: st.d.reason, remove: true }), "Scan deleted");
    }
    else if (act === "save") save();
    else if (act === "pick") {
      Object.assign(st, { pick: !st.pick, q: "", hits: [] });
      draw();
      if (st.pick) {
        loadBookings();
        const q = dlg.querySelector('[data-role="q"]');
        if (q) q.focus();
      }
    }
    else if (act === "line-add") {
      st.d.lines.push({ productId: "", productName: "", written: "", qty: 0, fee: null, feeFrom: "", seen: 0, take: 1, seenAs: "", flags: [], feeEdited: false });
      draw();
    }
    else if (act === "line-x" && row) { st.d.lines.splice(Number(row.dataset.i), 1); draw(); }
    else if (act === "item-add") {
      st.d.items.push({ product: "", custom: false, customName: "", strengths: "", quantity: "", directions: "", repeats: "", text: "" });
      draw();
    }
    else if (act === "item-x" && row) { st.d.items.splice(Number(row.dataset.i), 1); draw(); }
  });

  // Typing is kept in memory (no redraw), so the iPad keyboard stays up
  dlg.addEventListener("input", (e) => {
    const t = e.target;
    const role = t.dataset.role;
    if (role === "q") { st.q = t.value; clearTimeout(timer); timer = setTimeout(search, 250); return; }
    if (role === "reason") { st.d.reason = t.value; return; }
    if (role === "note") { st.d.note = t.value; return; }
    if (role === "date") {
      if (scan.kind === "billing") { st.d.apptDate = t.value; st.bookings = null; } else st.d.recordDate = t.value;
      return;
    }
    const row = t.closest("[data-i]");
    if (!row) return;
    const i = Number(row.dataset.i);
    if (t.dataset.l === "take") st.d.lines[i].take = t.value;
    else if (t.dataset.l === "fee") {
      Object.assign(st.d.lines[i], { fee: t.value, feeEdited: true });
      const tot = dlg.querySelector('[data-role="total"]');
      if (tot) tot.textContent = `Products total ${money(total())}`;
    }
    else if (t.dataset.rx && t.dataset.rx !== "product") st.d.items[i][t.dataset.rx] = t.value;
  });

  dlg.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.role === "booking") {
      const a = (st.bookings || [])[Number(t.value)];
      if (a) {
        st.d.patient = { name: a.patientName || "", pttId: String(a.patientId || ""), staff: a.staff || "", time: a.time || "" };
        st.pick = false;
        draw();
      }
      return;
    }
    if (t.dataset.role === "date" && st.pick) { loadBookings(); return; }
    const row = t.closest("[data-i]");
    if (!row) return;
    const i = Number(row.dataset.i);
    if (t.dataset.l === "productId") {
      const l = st.d.lines[i];
      const p = byId.get(t.value);
      l.productId = t.value;
      l.productName = p ? p.name : "";
      if ((l.fee === null || l.fee === "") && p && p.price !== null && p.price !== undefined && p.price !== "") {
        l.fee = r2(Number(p.price) * Math.max(1, parseInt(l.take, 10) || 1));
        l.feeFrom = "price";
      }
      draw();
    } else if (t.dataset.rx === "product") {
      const it = st.d.items[i];
      if (t.value === TYPE_IT) Object.assign(it, { custom: true, customName: it.customName || it.medicine || it.product || "" });
      else Object.assign(it, { custom: false, product: t.value });
      draw();
    }
  });

  draw();
  dlg.showModal();
}