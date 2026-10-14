// Scanner → Prescription: check what was read, pick the patient and products, then save to the patient.
import { reviewRx, findRxPatient, searchPatientsQuick, rxScanExists, saveRxScan } from "./scanner-api.js";
import { rxProductList } from "./rx-products.js";
import { dayKey } from "./inventory-api.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const blank = () => ({ text: "", product: "", strengths: "", quantity: "", directions: "", repeats: "", conf: 1, fixed: true });

export function mountRxResult(el, { photo, photoUrl, result, staff, onAgain }) {
  const products = rxProductList();
  const review = reviewRx(result, products);
  const today = dayKey();
  const st = { patient: null, candidates: [], finding: true, pick: false, q: "", hits: [], searching: false,
    date: review.date, items: review.items.length ? review.items.map((x) => ({ ...x })) : [blank()], note: "", busy: false };
  let timer = null, seq = 0;

  const prodOptions = (cur) => `<option value="">Choose the product…</option>${products.map((n) =>
    `<option${n === cur ? " selected" : ""}>${esc(n)}</option>`).join("")}`;

  function itemFlags(it) {
    if (!it.product) return [["bad", it.text ? "Not matched: choose the product" : "Choose the product"]];
    if (!it.fixed && it.conf < 0.6) return [["warn", "Check this is the right product"]];
    return [];
  }
  function itemHtml(it, i) {
    const fl = itemFlags(it);
    return `<div class="rx-item${fl.some((f) => f[0] === "bad") ? " is-bad" : fl.length ? " is-warn" : ""}" data-i="${i}">
      <div class="rx-item-top">
        <select class="fb-select" data-rx="product" aria-label="Product">${prodOptions(it.product)}</select>
        <button type="button" class="ib-tool is-danger" data-act="rx-remove" aria-label="Remove this item" title="Remove">×</button>
      </div>
      ${it.text ? `<small class="muted">Written: ${esc(it.text).replace(/\n/g, " / ")}</small>` : ""}
      <div class="rx-fields">
        <label><span>Strengths</span><input class="fe-input" data-rx="strengths" maxlength="300" value="${esc(it.strengths)}" placeholder="e.g. 4% HQ, 2% kojic acid" /></label>
        <label><span>Quantity</span><input class="fe-input" data-rx="quantity" maxlength="60" value="${esc(it.quantity)}" placeholder="e.g. 50g, 100" /></label>
        <label><span>Directions</span><input class="fe-input" data-rx="directions" maxlength="300" value="${esc(it.directions)}" placeholder="e.g. Twice a day" /></label>
        <label><span>Repeats</span><input class="fe-input" data-rx="repeats" maxlength="20" value="${esc(it.repeats)}" placeholder="0" /></label>
      </div>
      ${fl.map(([t, m]) => `<span class="scan-flag is-${t}">${esc(m)}</span>`).join("")}
    </div>`;
  }

  const hitList = () => (st.q.trim().length >= 2 ? st.hits : st.candidates);
  function hitsHtml() {
    if (st.searching) return '<p class="muted">Searching…</p>';
    const list = hitList();
    if (!list.length) return `<p class="muted">${st.q.trim().length >= 2 ? "No patients match." : "Type a name or patient ID to search."}</p>`;
    return list.map((p, i) => `<button type="button" class="rx-hit" data-ppick="${i}"><strong>${esc(p.name)}</strong>
      <small>${esc([p.pttId && `ID ${p.pttId}`, p.dob || p.dobKey, p.address].filter(Boolean).join(" · "))}</small></button>`).join("");
  }
  function patientHtml() {
    if (st.finding) return '<p class="muted">Finding the patient…</p>';
    const p = st.patient;
    const read = review.patientName ? ` · written as “${esc(review.patientName)}”` : "";
    const head = p
      ? `<div class="rx-pat is-ok"><span>✓ <strong>${esc(p.name)}</strong>
          <small>${esc([p.pttId && `ID ${p.pttId}`, p.dob || p.dobKey, p.address].filter(Boolean).join(" · "))}${read}</small></span>
          <button type="button" class="scan-pat-btn" data-act="rx-pick">${st.pick ? "cancel" : "change"}</button></div>`
      : `<div class="rx-pat is-no"><span>${review.patientName ? `Couldn't be sure who “${esc(review.patientName)}” is.` : "The patient's name couldn't be read."}
          Choose them below.</span></div>`;
    return head + (st.pick || !p ? `<div class="rx-find">
        <input type="search" class="fe-input" data-role="pq" placeholder="Search by name or patient ID" value="${esc(st.q)}" autocomplete="off" />
        <div class="rx-hits" data-role="hits">${hitsHtml()}</div></div>` : "");
  }
  const drawPat = () => { const b = el.querySelector('[data-role="pat"]'); if (b) b.innerHTML = patientHtml(); };
  const drawHits = () => { const b = el.querySelector('[data-role="hits"]'); if (b) b.innerHTML = hitsHtml(); };
  const drawItems = () => { const b = el.querySelector('[data-role="items"]'); if (b) b.innerHTML = st.items.map(itemHtml).join(""); };
  function dateNote() {
    const n = el.querySelector('[data-role="datenote"]');
    if (!n) return;
    const msg = !st.date ? "Enter the date written on the prescription." : st.date > today ? "This date is in the future. Check it." : "";
    n.textContent = msg;
    n.hidden = !msg;
  }

  el.innerHTML = `
    <div class="scan-res-head">
      <button type="button" class="scan-thumb" data-act="rx-big" aria-label="Show the photo larger"><img src="${photoUrl}" alt="" /></button>
      <div><strong>Product prescription</strong>
        <small>${esc([review.prescriber, review.scriptNumber && `Script ${review.scriptNumber}`].filter(Boolean).join(" · ") || "Prescriber not read")}</small></div>
    </div>
    <div class="scan-big" data-role="rx-big" hidden><img src="${photoUrl}" alt="The photo" /></div>
    <section class="rx-sec"><h4>Patient</h4><div data-role="pat">${patientHtml()}</div></section>
    <section class="rx-sec"><h4>Date</h4>
      <label class="lh-field"><span class="lh-label">Prescription date</span>
        <input type="date" class="fe-input rx-date" data-role="date" value="${esc(st.date)}" max="${today}" /></label>
      <small class="scan-flag is-warn" data-role="datenote" hidden></small></section>
    <section class="rx-sec"><h4>Prescribed</h4>
      <div class="rx-items" data-role="items">${st.items.map(itemHtml).join("")}</div>
      <button type="button" class="hx-add" data-act="rx-add">+ Add another item</button></section>
    <label class="lh-field"><span class="lh-label">Note (optional)</span>
      <textarea data-role="rxnote" rows="2" maxlength="1000" placeholder="e.g. Patient brought in a paper script"></textarea></label>
    <div class="scan-acts">
      <button type="button" class="lh-btn" data-act="rx-again">Scan again</button>
      <button type="button" class="lh-btn is-primary" data-act="rx-save">Save to patient</button>
    </div>`;
  dateNote();

  findRxPatient(review).then((r) => {
    st.candidates = r.candidates;
    st.patient = r.match;
  }).catch((err) => console.warn("Patient match failed:", err))
    .finally(() => { st.finding = false; if (el.isConnected) drawPat(); });

  async function runSearch() {
    const my = ++seq;
    if (st.q.trim().length < 2) { st.searching = false; drawHits(); return; }
    st.searching = true;
    drawHits();
    const hits = await searchPatientsQuick(st.q).catch(() => []);
    if (my !== seq || !el.isConnected) return;
    st.searching = false;
    st.hits = hits;
    drawHits();
  }

  async function save(btn) {
    if (st.busy) return;
    if (!st.patient) { showToast("Choose the patient first."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(st.date || "")) { showToast("Enter the prescription date."); return; }
    if (st.date > today) { showToast("The prescription date can't be in the future."); return; }
    const items = st.items.filter((it) => it.product || it.text || it.strengths || it.quantity);
    if (!items.length) { showToast("Add what was prescribed."); return; }
    if (items.some((it) => !it.product)) { showToast("Choose the product for every item, or remove it."); return; }

    const dup = await rxScanExists(review.scriptNumber).catch(() => null);
    if (dup) {
      const ok = await confirmDialog({
        title: "Already saved?",
        message: `Script ${review.scriptNumber} was already saved for ${dup.patientName || "a patient"}${dup.recordDate ? ` (${dup.recordDate})` : ""}${
          dup.by ? `, by ${dup.by}` : ""}. Save it again?`,
        confirmLabel: "Save again", tone: "warning",
      });
      if (!ok) return;
    }
    st.busy = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await saveRxScan({ photo, result, review, patient: st.patient, date: st.date, items, note: st.note }, staff);
      showToast(`Saved to ${st.patient.name}'s Product Prescriptions`);
      onAgain();
    } catch (ex) {
      console.error("Save prescription failed:", ex);
      showToast(ex && ex.code === "permission-denied"
        ? "You don't have access to save prescriptions. Ask an Admin to tick Scan product prescriptions."
        : (ex && ex.message && !ex.code) ? ex.message : "Couldn't save. Try again.");
      btn.disabled = false;
      btn.textContent = "Save to patient";
    } finally {
      st.busy = false;
    }
  }

  el.addEventListener("click", (e) => {
    const pk = e.target.closest("[data-ppick]");
    if (pk) {
      st.patient = hitList()[Number(pk.dataset.ppick)] || st.patient;
      st.pick = false; st.q = ""; st.hits = [];
      drawPat();
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "rx-pick") {
      st.pick = !st.pick;
      drawPat();
      if (st.pick) { const q = el.querySelector('[data-role="pq"]'); if (q) q.focus(); }
    } else if (act === "rx-add") {
      st.items.push(blank());
      drawItems();
      const sels = el.querySelectorAll('[data-rx="product"]');
      if (sels.length) sels[sels.length - 1].focus();
    } else if (act === "rx-remove") {
      const row = b.closest("[data-i]");
      st.items.splice(Number(row.dataset.i), 1);
      if (!st.items.length) st.items.push(blank());
      drawItems();
    } else if (act === "rx-big") {
      const big = el.querySelector('[data-role="rx-big"]');
      if (big) big.hidden = !big.hidden;
    } else if (act === "rx-again") onAgain();
    else if (act === "rx-save") save(b);
  });

  // Typing: kept in memory only (no redraw), so the iPad keyboard stays up
  el.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.role === "pq") { st.q = t.value; clearTimeout(timer); timer = setTimeout(runSearch, 250); return; }
    if (t.dataset.role === "date") { st.date = t.value; dateNote(); return; }
    if (t.dataset.role === "rxnote") { st.note = t.value; return; }
    const k = t.dataset.rx;
    const row = t.closest("[data-i]");
    if (!k || !row || k === "product") return;
    st.items[Number(row.dataset.i)][k] = t.value;
  });
  el.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.rx !== "product") return;
    const row = t.closest("[data-i]");
    const i = Number(row.dataset.i);
    st.items[i].product = t.value;
    st.items[i].fixed = true;
    row.outerHTML = itemHtml(st.items[i], i);
  });
}