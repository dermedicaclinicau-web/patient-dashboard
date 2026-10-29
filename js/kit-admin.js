// Inventory → Kits: an admin sets an injector's kit to what they physically have
import { setKitBalance, isKitProduct, batchName, batchText, plural, lotId, listAllLots, recordKitFromShelf } from "./inventory-api.js";
import { escapeHtml as esc, showToast } from "./utils.js";

// injectors: [{ uid, name }]  products: listProducts()  kits: listKits() (everyone's)
export function openSetKitDialog({ staff, injectors, products, kits, days = [], uid = "", productId = "", onSaved = () => {} }) {
  const kitProducts = products.filter((p) => p.active && isKitProduct(p));
  if (!kitProducts.length) { showToast("No products are set up as kit products."); return; }
  if (!injectors.length) { showToast("No injectors found yet. They appear once they've counted their kit at Start of Day."); return; }

  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg kit-set-dlg";
  dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head">
        <h3>Set an injector's kit</h3>
        <p>Enter what they have in their kit right now. This replaces what the portal has for them, and it's logged.</p>
      </div>
      <div class="lh-two">
        <label class="lh-field"><span class="lh-label">Injector</span>
          <select class="fb-select" data-f="who">${injectors.map((s) =>
            `<option value="${esc(s.uid)}"${s.uid === uid ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Product</span>
          <select class="fb-select" data-f="product">${kitProducts.map((p) =>
            `<option value="${esc(p.id)}"${p.id === productId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      </div>
      <div data-role="rows"></div>
      <p class="kit-set-total" data-role="total"></p>
      <label class="lh-field"><span class="lh-label">Note</span>
        <input class="fe-input" data-f="note" value="Moved over from the old app" maxlength="300" /></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save kit</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);

  const $ = (s) => dlg.querySelector(s);
  const err = $(".lh-error");
  const showErr = (m) => { err.textContent = m || ""; err.hidden = !m; };
  const product = () => kitProducts.find((p) => p.id === $('[data-f="product"]').value);
  const who = () => injectors.find((s) => s.uid === $('[data-f="who"]').value);
  let wasUnits = 0;

  const rowHtml = (p, r = {}) => `<tr>
      ${p.tracked ? `<td><input class="fe-input" data-c="batch" value="${esc(r.batch || "")}" style="text-transform:uppercase" /></td>
      <td><input class="fe-input" type="date" data-c="expiry" value="${esc(r.expiry || "")}" /></td>` : ""}
      <td><input class="fe-input" type="number" min="0" step="1" inputmode="numeric" data-c="sealed" value="${r.sealed || ""}" placeholder="0" /></td>
      <td><input class="fe-input" type="number" min="0" step="0.1" inputmode="decimal" data-c="open" value="${r.open || ""}" placeholder="0" /></td>
      <td><button type="button" class="hx-x" data-act="rm" aria-label="Remove">×</button></td>
    </tr>`;

  const niceKey = (k) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : k;
  };
  // Their latest own count of this product (End of Day before Start of Day), newest day first
  const lastCount = (s, p) => {
    for (const d of days) {
      if (d.staffUid !== s.uid) continue;
      for (const [part, label] of [[d.end, "End of Day"], [d.start, "Start of Day"]]) {
        const it = part && (part.items || []).find((x) => x.productId === p.id);
        if (it && (it.rows || []).length) {
          return { label, dateKey: d.dateKey,
            rows: it.rows.map((r) => ({ batch: r.batch, expiry: r.expiry, sealed: r.sealed, open: r.open })) };
        }
      }
    }
    return null;
  };

  const render = () => {
    const p = product();
    const s = who();
    const mine = kits.filter((k) => k.staffUid === s.uid && k.productId === p.id);
    wasUnits = Math.round(mine.reduce((a, k) => a + k.sealed * p.dosePer + k.open, 0) * 10) / 10;
    const last = mine.length ? null : lastCount(s, p);
    const rows = mine.length ? mine : last ? last.rows : [{}];
    $('[data-role="rows"]').innerHTML = `
      ${last ? `<p class="inv-hint">Filled in from ${esc(s.name)}'s ${last.label} count on ${esc(niceKey(last.dateKey))}. Check it against their kit before saving.</p>` : ""}
      <table class="inv-table kit-set-table">
        <thead><tr>
          ${p.tracked ? `<th>${esc(batchName(p))}</th><th>Expiry</th>` : ""}
          <th>Unopened ${esc(p.stockUnit)}s</th><th>Opened ${esc(p.stockUnit)} (${esc(p.doseUnit)} left)</th><th></th>
        </tr></thead>
        <tbody>${rows.map((r) => rowHtml(p, r)).join("")}</tbody>
      </table>
      ${p.tracked ? `<button type="button" class="lh-btn is-quiet" data-act="add">+ Add ${esc(batchName(p).toLowerCase())}</button>` : ""}`;
    total();
  };

  const readRows = () => [...dlg.querySelectorAll(".kit-set-table tbody tr")].map((tr) => {
    const v = (c) => (tr.querySelector(`[data-c="${c}"]`) || {}).value || "";
    return { batch: v("batch").trim().toUpperCase(), expiry: v("expiry"), sealed: v("sealed"), open: v("open") };
  });

  const total = () => {
    const p = product();
    const now = Math.round(readRows().reduce((a, r) => a + (parseInt(r.sealed, 10) || 0) * p.dosePer + (Number(r.open) || 0), 0) * 10) / 10;
    $('[data-role="total"]').innerHTML = `Total: <strong>${now} ${esc(p.doseUnit)}</strong>
      <span class="muted"> · the portal has ${wasUnits} ${esc(p.doseUnit)} now</span>`;
  };

  dlg.addEventListener("change", (e) => { if (e.target.matches('[data-f="who"], [data-f="product"]')) { showErr(""); render(); } });
  dlg.addEventListener("input", () => { showErr(""); total(); });
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "cancel") dlg.close();
    if (b.dataset.act === "add") { $(".kit-set-table tbody").insertAdjacentHTML("beforeend", rowHtml(product())); total(); }
    if (b.dataset.act === "rm") {
      const body = $(".kit-set-table tbody");
      b.closest("tr").remove();
      if (!body.children.length) body.insertAdjacentHTML("beforeend", rowHtml(product()));
      total();
    }
  });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    showErr("");
    try {
      const s = who();
      const r = await setKitBalance({
        staffUid: s.uid, staffName: s.name, product: product(), rows: readRows(), note: $('[data-f="note"]').value,
      }, staff);
      showToast(`${s.name}'s kit: ${r.before} → ${r.after} ${r.unit}.`);
      dlg.close();
      onSaved();
    } catch (ex) {
      console.error("Set kit failed:", ex);
      showErr(ex && ex.code === "permission-denied"
        ? "Couldn't save. The Firestore rules need to let admins write to inv_kits for other staff."
        : (ex && ex.message) || "Couldn't save. Try again.");
      btn.disabled = false;
      btn.textContent = "Save kit";
    }
  });

  dlg.addEventListener("close", () => dlg.remove());
  render();
  dlg.showModal();
}

// Vials already in an injector's kit (set by hand) that were never taken off the Shelf
export async function openKitFromShelfDialog({ staff, injectors, products, kits, uid = "", productId = "", onSaved = () => {} }) {
  const kitProducts = products.filter((p) => p.active && isKitProduct(p));
  if (!kitProducts.length || !injectors.length) { showToast("No injectors or kit products found."); return; }
  let lots;
  try { lots = await listAllLots(); }
  catch (ex) { console.error("Lots not loaded:", ex); showToast("Couldn't load the Shelf stock. Try again."); return; }

  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg kit-set-dlg";
  dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head">
        <h3>Taken from the Shelf, already in their kit</h3>
        <p>For vials you added to someone's kit by hand that are still showing on the Shelf. The Shelf goes down;
          their kit doesn't change. It's recorded as taken into their kit.</p>
      </div>
      <div class="lh-two">
        <label class="lh-field"><span class="lh-label">Injector</span>
          <select class="fb-select" data-f="who">${injectors.map((s) =>
            `<option value="${esc(s.uid)}"${s.uid === uid ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Product</span>
          <select class="fb-select" data-f="product">${kitProducts.map((p) =>
            `<option value="${esc(p.id)}"${p.id === productId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      </div>
      <div data-role="rows"></div>
      <label class="lh-field"><span class="lh-label">Note</span>
        <input class="fe-input" data-f="note" maxlength="300" placeholder="e.g. Took it from the Shelf on 27 Oct; her kit was set by hand" /></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Take off the Shelf</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);

  const $ = (s) => dlg.querySelector(s);
  const err = $(".lh-error");
  const showErr = (m) => { err.textContent = m || ""; err.hidden = !m; };
  const product = () => kitProducts.find((p) => p.id === $('[data-f="product"]').value);
  const who = () => injectors.find((s) => s.uid === $('[data-f="who"]').value);
  let rows = [];

  const render = () => {
    const p = product();
    const s = who();
    rows = kits.filter((k) => k.staffUid === s.uid && k.productId === p.id).map((k) => ({
      k, lot: lots.find((l) => l.id === lotId(p.id, "shelf", k.batch, k.expiry) && l.qty > 0) || null,
    }));
    $('[data-role="rows"]').innerHTML = rows.length ? `<table class="inv-table kit-set-table">
        <thead><tr><th>${esc(batchName(p))}</th><th>In ${esc(s.name)}'s kit</th><th>On the Shelf</th><th>Take off the Shelf</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr>
          <td>${esc(r.k.batch || "-")}${r.k.expiry ? ` <span class="muted">exp ${esc(r.k.expiry)}</span>` : ""}</td>
          <td>${r.k.sealed} unopened${r.k.open ? ` + ${r.k.open} ${esc(p.doseUnit)}` : ""}</td>
          <td>${r.lot ? esc(plural(r.lot.qty, p.stockUnit)) : '<span class="muted">None of this batch</span>'}</td>
          <td>${r.lot ? `<input class="fe-input" type="number" min="0" max="${r.lot.qty}" step="1" inputmode="numeric"
            data-i="${i}" placeholder="0" />` : ""}</td></tr>`).join("")}</tbody></table>`
      : `<p class="inv-hint">${esc(s.name)} has none of this in their kit.</p>`;
  };

  dlg.addEventListener("change", (e) => { if (e.target.matches('[data-f="who"], [data-f="product"]')) { showErr(""); render(); } });
  dlg.addEventListener("input", () => showErr(""));
  $('[data-act="cancel"]').addEventListener("click", () => dlg.close());

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = product();
    const s = who();
    const work = [...dlg.querySelectorAll("[data-i]")]
      .map((el) => ({ r: rows[+el.dataset.i], n: parseInt(el.value, 10) || 0 }))
      .filter((w) => w.n > 0);
    if (!work.length) { showErr("Enter how many came from the Shelf."); return; }
    const bad = work.find((w) => w.n > w.r.lot.qty);
    if (bad) { showErr(`Only ${plural(bad.r.lot.qty, p.stockUnit)} of ${bad.r.k.batch} on the Shelf.`); return; }
    const note = $('[data-f="note"]').value.trim();
    if (!note) { showErr("Add a note saying what happened."); return; }

    const btn = $('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    let done = 0;
    try {
      for (const w of work) {
        await recordKitFromShelf({ staffUid: s.uid, staffName: s.name, product: p, lot: w.r.lot, vials: w.n, note }, staff);
        done += w.n;
      }
      showToast(`${plural(done, p.stockUnit)} taken off the Shelf. ${s.name}'s kit didn't change.`);
      dlg.close();
      onSaved();
    } catch (ex) {
      console.error("Kit from Shelf failed:", ex);
      showErr((done ? `${plural(done, p.stockUnit)} done, then: ` : "") + (ex && ex.code === "permission-denied"
        ? "Couldn't save. This needs Manage inventory access."
        : (ex && ex.message) || "Couldn't save. Try again."));
      btn.disabled = false;
      btn.textContent = "Take off the Shelf";
    }
  });

  dlg.addEventListener("close", () => dlg.remove());
  render();
  dlg.showModal();
}