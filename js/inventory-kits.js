// Inventory → Kits: injectables each injector carries (e.g. Xeomin), and releases from JT storage.
import {
  plural, unitPlural, expiryState, fefo, MOVE_TYPES, myUid,
  isKitProduct, kitUnits, listKits, listMyKitMoves, kitTake, kitOpen, kitReturn, kitDiscard,
  REL_STATUS, listReleases, requestRelease, approveRelease, declineRelease, cancelRelease,
} from "./inventory-api.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
};
const when = (d) => (d ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const fmt = (n) => String(+Number(n || 0).toFixed(1));
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to do this. Ask an Admin to check your Inventory access in Staff."
  : err && err.message && !err.code ? err.message : fallback);
const DISCARD_REASONS = ["Past its use-by after mixing", "Expired", "Damaged", "Other"];

function openDialog(html) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg";
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

export async function renderKits(body, { staff, products, lots, canKit, canJt, canManage, reload }) {
  const canApprove = canJt || canManage;
  const box = document.createElement("div");
  box.className = "kit-wrap";
  box.innerHTML = '<div class="skeleton" style="height:240px;border-radius:14px"></div>';
  body.replaceChildren(box);

  let kits = [], rels = [], moves = [];
  try {
    [kits, rels, moves] = await Promise.all([
      listKits({ mine: !canApprove }),
      listReleases().catch(() => []),
      canKit ? listMyKitMoves().catch(() => []) : Promise.resolve([]),
    ]);
  } catch (err) {
    console.error("Kits load failed:", err);
    if (box.isConnected) box.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the kits."))}</div>`;
    return;
  }
  if (!box.isConnected) return;

  const me = myUid();
  const byId = new Map(products.map((p) => [p.id, p]));
  const kitProducts = products.filter((p) => p.active && isKitProduct(p));
  const mine = kits.filter((k) => k.staffUid === me);
  const lotsAt = (pid, loc) => lots.filter((l) => l.productId === pid && l.loc === loc && l.qty > 0).sort(fefo);
  const expFlag = (key) => {
    const s = expiryState(key);
    return s ? ` <span class="inv-flag is-${s === "expired" ? "bad" : "warn"}">${s === "expired" ? "Expired" : "Soon"}</span>` : "";
  };

  /* ---------- My kit ---------- */
  function myCard(p) {
    const ks = mine.filter((k) => k.productId === p.id);
    const total = ks.reduce((a, k) => a + kitUnits(k), 0);
    const pending = rels.find((r) => r.productId === p.id && r.requestedByUid === me && r.status === "pending");
    const unit = p.stockUnit;
    let action;
    if (p.stock.shelf > 0) action = `<button type="button" class="lh-btn is-primary" data-kit="take" data-pid="${esc(p.id)}">Take from Shelf</button>`;
    else if (pending) action = `<span class="inv-flag is-info">Asked JT storage for ${esc(plural(pending.qty, unit))} · waiting</span>`;
    else if (p.stock.jt > 0) action = `<button type="button" class="lh-btn is-primary" data-kit="request" data-pid="${esc(p.id)}">Request from JT storage</button>`;
    else action = `<a class="lh-btn" href="#/tasks/order/${encodeURIComponent(p.id)}">None in stock · request an order</a>`;
    return `
      <article class="kit-card">
        <div class="kit-top">
          <div><h4>${esc(p.name)}</h4><small class="muted">${esc(`${p.dosePer} ${p.doseUnit} per ${p.stockUnit}`)}</small></div>
          <div class="kit-total${total ? "" : " is-empty"}"><strong>${fmt(total)}</strong><span>${esc(p.doseUnit)} in my kit</span></div>
        </div>
        ${ks.length ? `<table class="inv-table kit-table"><thead><tr><th>Batch</th><th>Expiry</th><th>Opened</th><th>Unopened</th><th></th></tr></thead><tbody>${
          ks.map((k) => `<tr>
            <td>${esc(k.batch || "—")}</td><td>${esc(niceDate(k.expiry))}${expFlag(k.expiry)}</td>
            <td>${k.open ? `<strong>${fmt(k.open)}</strong> ${esc(k.doseUnit)} left` : "—"}</td>
            <td>${k.sealed ? esc(plural(k.sealed, unit)) : "—"}</td>
            <td class="kit-acts">
              ${k.sealed ? `<button type="button" class="lh-btn" data-kit="open" data-id="${esc(k.id)}">Open a ${esc(unit)}</button>` : ""}
              <button type="button" class="lh-btn" data-kit="discard" data-id="${esc(k.id)}">Discard</button>
              ${k.sealed ? `<button type="button" class="lh-btn is-quiet" data-kit="return" data-id="${esc(k.id)}">Return</button>` : ""}
            </td></tr>`).join("")}</tbody></table>`
          : '<p class="tb-none">Nothing in your kit.</p>'}
        <div class="kit-foot">
          <span class="muted">Shelf: ${esc(plural(p.stock.shelf, unit))} · JT storage: ${esc(plural(p.stock.jt, unit))}</span>
          ${action}
        </div>
      </article>`;
  }
  const myKitHtml = () => !canKit ? "" : `
    <section class="kit-sec"><h3>My kit</h3>${kitProducts.length
      ? `<div class="kit-cards">${kitProducts.map(myCard).join("")}</div>`
      : '<div class="tm-empty">No products are carried in kits yet. In Products, edit Xeomin and set <strong>How it\'s used</strong> to <strong>Carried in injectors\' kits</strong>.</div>'}</section>`;

  /* ---------- JT storage releases ---------- */
  const recent = (r) => r.status === "pending" || (r.createdAt && Date.now() - r.createdAt.getTime() < 30 * 864e5);
  const relShown = rels.filter((r) => recent(r) && (canApprove || r.requestedByUid === me)).slice(0, 20);
  const releasesHtml = () => (!relShown.length && !canApprove) ? "" : `
    <section class="kit-sec"><h3>JT storage releases</h3>${relShown.length ? relShown.map((r) => `
      <div class="kit-rel">
        <div><strong>${esc(plural(r.qty, r.unit))} of ${esc(r.productName)}</strong> for ${esc(r.requestedBy)}
          <small>${esc(when(r.createdAt))}${r.note ? ` · “${esc(r.note)}”` : ""}${
            r.status === "approved" ? ` · Moved to the Shelf by ${esc(r.handledBy)}${r.batch ? ` (batch ${esc(r.batch)})` : ""}` : ""}${
            r.status === "declined" ? ` · Declined by ${esc(r.handledBy)}${r.response ? `: ${esc(r.response)}` : ""}` : ""}</small></div>
        <span class="rq-status is-${r.status}">${esc(REL_STATUS[r.status])}</span>
        ${r.status === "pending" ? `<div class="kit-acts">
          ${canApprove ? `<button type="button" class="lh-btn is-primary" data-kit="approve" data-rel="${esc(r.id)}">Approve</button>
            <button type="button" class="lh-btn" data-kit="decline" data-rel="${esc(r.id)}">Decline</button>` : ""}
          ${r.requestedByUid === me ? `<button type="button" class="lh-btn is-quiet" data-kit="cancel" data-rel="${esc(r.id)}">Cancel</button>` : ""}
        </div>` : ""}
      </div>`).join("") : '<p class="tb-none">No requests in the last 30 days.</p>'}</section>`;

  /* ---------- Everyone's kits ---------- */
  const allKitsHtml = () => !canApprove ? "" : `
    <section class="kit-sec"><h3>Everyone's kits</h3>${kits.length
      ? `<table class="inv-table"><thead><tr><th>Staff</th><th>Product</th><th>Batch</th><th>Expiry</th><th>Opened</th><th>Unopened</th><th>Total</th><th>Updated</th></tr></thead><tbody>${
        kits.slice().sort((a, b) => a.staffName.localeCompare(b.staffName) || a.productName.localeCompare(b.productName)).map((k) => `<tr>
          <td>${esc(k.staffName)}</td><td>${esc(k.productName)}</td><td>${esc(k.batch || "—")}</td>
          <td>${esc(niceDate(k.expiry))}${expFlag(k.expiry)}</td>
          <td>${k.open ? `${fmt(k.open)} ${esc(k.doseUnit)}` : "—"}</td><td>${k.sealed || "—"}</td>
          <td><strong>${fmt(kitUnits(k))}</strong> ${esc(k.doseUnit)}</td><td>${esc(when(k.updatedAt))}</td></tr>`).join("")}</tbody></table>`
      : '<p class="tb-none">Nobody is holding kit stock.</p>'}</section>`;

  /* ---------- My recent kit activity ---------- */
  const activityHtml = () => !canKit || !moves.length ? "" : `
    <section class="kit-sec"><h3>My recent kit activity</h3><ul class="inv-moves">${moves.map((m) => `
      <li><span class="inv-m-when">${esc(when(m.at))}</span>
        <span class="inv-m-main"><strong>${esc(MOVE_TYPES[m.type] || m.type)}</strong> · ${esc(m.productName || "")}
          <small>${esc([m.reason, m.note].filter(Boolean).join(" · "))}</small></span></li>`).join("")}</ul></section>`;

  box.innerHTML = [myKitHtml(), releasesHtml(), allKitsHtml(), activityHtml()].join("")
    || '<div class="tm-empty">Kits are for staff who carry injectables. Ask an Admin to give you access in Staff.</div>';

  /* ---------- Dialogs ---------- */
  function formDialog({ title, sub = "", inner, submit, onSubmit, onInput }) {
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ""}</div>
        ${inner}
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${esc(submit)}</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const btn = form.querySelector('[type="submit"]');
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    if (onInput) { form.addEventListener("input", () => onInput(form.elements, dlg)); onInput(form.elements, dlg); }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        const msg = await onSubmit(form.elements);
        dlg.close();
        if (msg) showToast(msg);
        reload();
      } catch (ex) {
        console.error(ex);
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  function takeDialog(p) {
    const list = lotsAt(p.id, "shelf");
    if (!list.length) { showToast("There's nothing on the Shelf."); return; }
    formDialog({
      title: `Take ${p.name} from the Shelf`,
      sub: "Unopened vials go into your kit. The oldest expiry is listed first.",
      inner: `${p.tracked ? `<label class="lh-field"><span class="lh-label">Batch</span><select class="fb-select" name="lot">${list.map((l, i) =>
          `<option value="${i}">Batch ${esc(l.batch)} · Exp ${esc(niceDate(l.expiry))} · ${esc(plural(l.qty, p.stockUnit))}</option>`).join("")}</select></label>` : ""}
        <label class="lh-field"><span class="lh-label">How many ${esc(unitPlural(p.stockUnit))}</span>
          <input name="n" type="number" min="1" step="1" value="1" inputmode="numeric" /></label>
        <p class="inv-hint" data-role="hint"></p>`,
      submit: "Take into my kit",
      onInput: (f, dlg) => {
        const n = Math.max(0, parseInt(f.n.value, 10) || 0);
        dlg.querySelector('[data-role="hint"]').textContent = `= ${fmt(n * p.dosePer)} ${p.doseUnit} into your kit.`;
      },
      onSubmit: async (f) => {
        const n = parseInt(f.n.value, 10);
        if (!(n >= 1)) throw new Error("Enter how many.");
        await kitTake(p, list[p.tracked ? Number(f.lot.value) : 0], n, staff);
        return `${plural(n, p.stockUnit)} added to your kit`;
      },
    });
  }

  function requestDialog(p) {
    formDialog({
      title: `Request ${p.name} from JT storage`,
      sub: "The Shelf is empty. Once approved, it's moved to the Shelf for you to take into your kit.",
      inner: `<label class="lh-field"><span class="lh-label">How many ${esc(unitPlural(p.stockUnit))}</span>
          <input name="n" type="number" min="1" max="${Math.min(10, p.stock.jt)}" step="1" value="1" inputmode="numeric" /></label>
        <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="500" placeholder="e.g. Fully booked Thursday" /></label>`,
      submit: "Send request",
      onSubmit: async (f) => {
        const n = parseInt(f.n.value, 10);
        if (!(n >= 1)) throw new Error("Enter how many.");
        if (n > p.stock.jt) throw new Error(`There ${p.stock.jt === 1 ? "is" : "are"} only ${plural(p.stock.jt, p.stockUnit)} in JT storage.`);
        const id = await requestRelease(p, n, f.note.value, staff);
        callApi({ action: "inventory", op: "notifyRelease", releaseId: id }).catch((e) => console.warn("Release email failed:", e));
        return "Request sent to JT storage";
      },
    });
  }

  function discardDialog(k) {
    formDialog({
      title: `Discard ${k.productName}`,
      sub: `Batch ${k.batch || "—"}. The reason is logged.`,
      inner: `${k.open ? `<label class="lh-field"><span class="lh-label">From the opened vial (${fmt(k.open)} ${esc(k.doseUnit)} left)</span>
          <div class="fe-num"><input class="fe-input" name="units" type="number" min="0" step="0.5" value="${fmt(k.open)}" /><span>${esc(k.doseUnit)}</span></div></label>` : ""}
        ${k.sealed ? `<label class="lh-field"><span class="lh-label">Unopened (${k.sealed} in this batch)</span>
          <div class="fe-num"><input class="fe-input" name="vials" type="number" min="0" max="${k.sealed}" step="1" value="0" /><span>unopened</span></div></label>` : ""}
        <label class="lh-field"><span class="lh-label">Reason</span><select class="fb-select" name="reason">${DISCARD_REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Note (optional)</span><input name="note" maxlength="400" /></label>`,
      submit: "Discard",
      onSubmit: async (f) => {
        await kitDiscard(k, { units: f.units ? f.units.value : 0, vials: f.vials ? f.vials.value : 0, reason: f.reason.value, note: f.note.value }, staff);
        return "Discarded and logged";
      },
    });
  }

  function returnDialog(k, p) {
    formDialog({
      title: `Return ${k.productName} to the Shelf`,
      sub: "Only unopened vials can go back.",
      inner: `<label class="lh-field"><span class="lh-label">How many (${k.sealed} unopened)</span>
        <input name="n" type="number" min="1" max="${k.sealed}" step="1" value="${k.sealed}" inputmode="numeric" /></label>`,
      submit: "Return to Shelf",
      onSubmit: async (f) => {
        const n = parseInt(f.n.value, 10);
        if (!(n >= 1)) throw new Error("Enter how many.");
        await kitReturn(p, k, n, staff);
        return `${plural(n, p.stockUnit)} returned to the Shelf`;
      },
    });
  }

  function approveDialog(r) {
    const list = lotsAt(r.productId, "jt");
    if (!list.length) { showToast("There's nothing in JT storage for this product."); return; }
    formDialog({
      title: `Release ${plural(r.qty, r.unit)} of ${r.productName}`,
      sub: `For ${r.requestedBy}. It moves from JT storage to the Shelf, and they're emailed.`,
      inner: `<label class="lh-field"><span class="lh-label">Batch</span><select class="fb-select" name="lot">${list.map((l, i) =>
        `<option value="${i}">Batch ${esc(l.batch || "—")} · Exp ${esc(niceDate(l.expiry))} · ${esc(plural(l.qty, r.unit))}</option>`).join("")}</select></label>`,
      submit: "Approve and move to Shelf",
      onSubmit: async (f) => {
        await approveRelease(r, list[Number(f.lot.value)], staff);
        callApi({ action: "inventory", op: "notifyReleaseUpdate", releaseId: r.id }).catch((e) => console.warn("Release email failed:", e));
        return `Moved to the Shelf for ${r.requestedBy}`;
      },
    });
  }

  function declineDialog(r) {
    formDialog({
      title: `Decline: ${r.productName} for ${r.requestedBy}`,
      inner: `<label class="lh-field"><span class="lh-label">Reason</span><textarea name="reason" rows="2" maxlength="500"></textarea></label>`,
      submit: "Decline",
      onSubmit: async (f) => {
        if (!f.reason.value.trim()) throw new Error("Give a reason.");
        await declineRelease(r, f.reason.value, staff);
        callApi({ action: "inventory", op: "notifyReleaseUpdate", releaseId: r.id }).catch((e) => console.warn("Release email failed:", e));
        return "Request declined";
      },
    });
  }

  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-kit]");
    if (!b) return;
    const act = b.dataset.kit;
    const p = b.dataset.pid ? byId.get(b.dataset.pid) : null;
    const k = b.dataset.id ? kits.find((x) => x.id === b.dataset.id) : null;
    const r = b.dataset.rel ? rels.find((x) => x.id === b.dataset.rel) : null;
    if (act === "take" && p) takeDialog(p);
    else if (act === "request" && p) requestDialog(p);
    else if (act === "discard" && k) discardDialog(k);
    else if (act === "return" && k) {
      const kp = byId.get(k.productId);
      if (kp) returnDialog(k, kp); else showToast("This product is no longer on the list.");
    } else if (act === "open" && k) {
      const ok = await confirmDialog({ title: `Open a vial of ${k.productName}?`,
        message: `Batch ${k.batch || "—"}. ${k.dosePer} ${k.doseUnit} become ready to use.`, confirmLabel: "Open vial" });
      if (!ok) return;
      try { await kitOpen(k, staff); showToast("Vial opened"); reload(); }
      catch (err) { console.error(err); showToast(errText(err, "Couldn't save. Try again.")); }
    } else if (act === "approve" && r) approveDialog(r);
    else if (act === "decline" && r) declineDialog(r);
    else if (act === "cancel" && r) {
      const ok = await confirmDialog({ title: "Cancel this request?", message: "Dr Teh won't need to approve it.", confirmLabel: "Cancel request", tone: "warning" });
      if (!ok) return;
      try { await cancelRelease(r); showToast("Request cancelled"); reload(); }
      catch (err) { console.error(err); showToast(errText(err, "Couldn't cancel. Try again.")); }
    }
  });
}