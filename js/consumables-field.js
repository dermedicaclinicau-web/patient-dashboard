// Treatment records: the Consumables field ("Products used").
// Kit products (e.g. Xeomin) come from the clinician's own kit, in units.
// Shelf products with a dose (e.g. Belotero 1 mL, Radiesse 1.5 mL per syringe): the clinician records mL injected,
//   and the syringes opened come off the Shelf (JT storage for Dr Teh).
// Shared products (e.g. numbing cream): each record is one use of an opened container; a new one is opened
//   (and comes off stock) only when needed. If several are open, staff choose which.
// Everything else comes off in whole items.
// Stock only changes when the form is saved, in the same transaction as the record.
// (Take from Shelf and Borrow happen straight away: they're real handovers, logged on their own.)
import {
  listProducts, listAllLots, listKits, listOpenContainers, isKitProduct, isSharedProduct, openState, kitUnits,
  plural, unitPlural, fefo, lotId, INV_CATEGORIES, batchName, batchText, createRequest, suggestOrder, openContainer,
  expiryState, listReleases, myUid,
} from "./inventory-api.js";
import { takeFromShelfDialog, borrowDialog, jtReleaseDialog } from "./inventory-kits.js";
import { isInjector, isAdmin, can } from "./perms.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(+Number(n || 0).toFixed(2));
const num = (v) => Number(v) || 0;
const r2 = (n) => Math.round(n * 100) / 100;
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
};
const shortDate = (d) => (d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "");
const isTeh = (staff) => /\bteh\b/i.test(String((staff && staff.name) || ""));
const shared = (p) => isSharedProduct(p);
// A kit product an Admin takes straight from the Shelf or JT storage counts as storage, not kit
const isKit = (p) => isKitProduct(p) && !p.fromStore;
// A Shelf product measured by dose, e.g. a 1 mL syringe of filler
// A kit product taken from JT storage / the Shelf: units come out of that place's opened vial
const vial = (p) => !!p && isKitProduct(p) && !!p.fromStore;
const dosed = (p) => !!p && !isKit(p) && !shared(p) && !vial(p) && !!p.dosePer;
// What the clinician records: units (kit and opened vials), mL (dosed), or items
const clinicalUnit = (p) => (isKit(p) || vial(p) || dosed(p) ? p.doseUnit : shared(p) ? (p.dosePer ? p.doseUnit : "use") : p.stockUnit);
// Syringes needed for a dose: 2.2 mL of a 1.5 mL syringe = 2
const syringesFor = (p, dose) => (dose > 0 ? Math.max(1, Math.ceil(dose / p.dosePer - 1e-9)) : "");

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const RS_ICON = {
  kit: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>'),
  shelf: svg('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6 6 0 0 1 3.5 5.5"/>'),
  send: svg('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>'),
};

// Shared by every Consumables field on the same form (reloaded for each new form)
let stockJob = null;
let stockAt = 0;
function loadStock(force = false) {
  if (!stockJob || force || Date.now() - stockAt > 10000) {
    stockAt = Date.now();
    stockJob = Promise.all([listProducts(), listAllLots(), listKits({ mine: true }).catch(() => []),
      listOpenContainers().catch(() => []), listReleases().catch(() => [])])
      .then(([products, lots, kits, open, rels]) => ({ products, lots, kits, open, rels }));
    stockJob.catch(() => { stockJob = null; });
  }
  return stockJob;
}

// Restock: choose which batch the new vial comes from. Oldest expiry is chosen to start with; expired ones can't be.
// lots: that place's batches with stock, oldest expiry first. Resolves the chosen lot, or null.
function chooseVialDialog(p, lots, { where, openLeft = 0 }) {
  return new Promise((resolve) => {
    let out = null;
    const total = lots.reduce((a, x) => a + x.qty, 0);
    const first = lots.findIndex((x) => expiryState(x.expiry) !== "expired");
    const unitOf = (n) => (n === 1 ? p.stockUnit : unitPlural(p.stockUnit));
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog cs-vdlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head">
        <h3>Open a new ${esc(p.stockUnit)} of ${esc(p.name)}</h3>
        <p>Choose the ${esc(batchName(p).toLowerCase())} you're opening from ${esc(where)}. Check it matches the label on the ${esc(p.stockUnit)}.</p>
      </div>
      <div class="cs-vpick" role="radiogroup" aria-label="${esc(batchName(p))}">
        ${lots.map((x, i) => {
          const st = expiryState(x.expiry);
          const off = st === "expired";
          return `<label class="cs-vopt${off ? " is-off" : ""}">
            <input type="radio" name="lot" value="${i}"${i === first ? " checked" : ""}${off ? " disabled" : ""} />
            <span class="cs-vopt-tick" aria-hidden="true"></span>
            <span class="cs-vopt-main">
              <strong>${esc(batchText(p, x.batch) || "No batch number")}</strong>
              <small>Exp ${esc(niceDate(x.expiry))}</small>
              <span class="cs-vtags">
                ${i === first ? '<em class="cs-vtag">Use first · oldest expiry</em>' : ""}
                ${st === "soon" ? '<em class="cs-vtag is-soon">Expires soon</em>' : ""}
                ${off ? '<em class="cs-vtag is-bad">Expired · can\'t be used</em>' : ""}
              </span>
            </span>
            <span class="cs-vopt-qty"><b>${esc(x.qty)}</b><small>${esc(unitOf(x.qty))} left</small></span>
          </label>`;
        }).join("")}
      </div>
      <p class="cs-vnote" data-role="note"></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary"${first < 0 ? " disabled" : ""}>Open ${esc(p.stockUnit)}</button>
      </div>
    </form>`;
    const note = dlg.querySelector('[data-role="note"]');
    const showNote = () => {
      if (first < 0) {
        note.innerHTML = `<span class="cs-warn">Every ${esc(batchName(p).toLowerCase())} in ${esc(where)} has expired. Write them off and order more.</span>`;
        return;
      }
      note.textContent = `${plural(total - 1, p.stockUnit)} left in ${where} after this.`
        + (openLeft > 0 ? ` The ${fmt(openLeft)} ${p.doseUnit} left in the opened one are used first.` : "");
    };
    showNote();
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const sel = dlg.querySelector('input[name="lot"]:checked');
      if (!sel) return;
      out = lots[Number(sel.value)];
      dlg.close();
    });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out); });
    document.body.appendChild(dlg);
    dlg.showModal();
    const sel = dlg.querySelector('input[name="lot"]:checked');
    if (sel) sel.focus();
  });
}

// Restock: where to take a kit product from. opts: [{ k, icon, title, sub, off, admin }]. Resolves the chosen k, or null.
function restockDialog(p, opts) {
  return new Promise((resolve) => {
    let out = null;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog cs-rsdlg";
    dlg.innerHTML = `
      <div class="cs-rs-head">
        <div><h3>Restock ${esc(p.name)}</h3><p>Where are you taking it from?</p></div>
        <button type="button" class="hx-x" data-act="close" aria-label="Close">×</button>
      </div>
      <div class="cs-rs-list">${opts.map((o) => `
        <button type="button" class="cs-rs-opt${o.off ? " is-off" : ""}" data-k="${esc(o.k)}"${o.off ? " disabled" : ""}>
          <span class="cs-rs-ic">${RS_ICON[o.icon] || RS_ICON.shelf}</span>
          <span class="cs-rs-main"><strong>${esc(o.title)}${o.admin ? ' <em class="cs-rs-tag">Admins only</em>' : ""}</strong>
            <small>${esc(o.sub || "")}</small></span>
          <span class="cs-rs-go" aria-hidden="true">›</span>
        </button>`).join("")}
      </div>`;
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="close"]')) { dlg.close(); return; }
      const b = e.target.closest("[data-k]");
      if (!b || b.disabled) return;
      out = b.dataset.k;
      dlg.close();
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out); });
    document.body.appendChild(dlg);
    dlg.showModal();
    const first = dlg.querySelector(".cs-rs-opt:not([disabled])");
    if (first) first.focus();
  });
}

// linked(fieldId): the current total of a marked picture / Calculation / Number on the form (or null)
// linkLabel(fieldId): its name, shown as "Filled in from …"
export function mountConsumablesField(w, f, { staff, onChange = () => {}, linked = null, linkLabel = null } = {}) {
  const host = w && w.querySelector("[data-cs-host]");
  if (!host) return;
  const canKit = isInjector();
  const adminStore = isAdmin();
  // Stock numbers: Manage inventory (and Admins) only. Everyone else counts blind.
  const seeStock = can("inventory.manage");
  // Form Builder → Consumables → "Can use more than one batch" (on unless it's been turned off)
  const multiOf = (l) => !(l.item && l.item.multi === false);
  const defLoc = isTeh(staff) ? "jt" : "shelf";
  let stock = null, failed = false;
  // use: shared products only (null = not decided yet)
  const newRow = (preset = null) => ({ ref: "", amount: "", dose: "", auto: true, preset, use: null, finish: false, seeded: false, openId: "" });
  const lines = (f.items || []).map((it) => ({
    productId: it.productId, item: it, extra: false, loc: defLoc, rows: [newRow(it.amount ?? null)],
  }));

  const rawProduct = (l) => (stock ? stock.products.find((p) => p.id === l.productId) : null);
  // Kit products come from the kit, unless an Admin chooses the Shelf or JT storage
  const productOf = (l) => {
    const p = rawProduct(l);
    return p && isKitProduct(p) && l.loc !== "kit" ? { ...p, fromStore: true } : p;
  };
  // Admins: their kit if it has this product right now, otherwise JT storage (until they choose)
  function fixLoc(l) {
    const p = rawProduct(l);
    if (!p || !isKitProduct(p)) { if (l.loc === "kit") l.loc = defLoc; return; }
    if (!adminStore) { l.loc = "kit"; return; }
    if (l.userLoc) return;
    const inKit = canKit && stock.kits.some((k) => k.productId === p.id && kitUnits(k) > 0);
    l.loc = inKit ? "kit" : "jt";
  }
  const nameOf = (l) => (productOf(l) || {}).name || (l.item && l.item.name) || "Product";
  const whereOf = (l) => (l.loc === "jt" ? "JT storage" : "Shelf");
  // The amount the clinician gave (units / mL / items)
  const clinicalTotal = (l, p = productOf(l)) => l.rows.reduce((a, r) => a + num(dosed(p) ? r.dose : r.amount), 0);

  // Where each row can come from. label: with what's left (Manage inventory). plain: batch and expiry only.
  function sources(l) {
    const p = productOf(l);
    if (!p || shared(p)) return [];
    if (isKit(p)) {
      return stock.kits.filter((k) => k.productId === p.id && kitUnits(k) > 0).map((k) => ({
        ref: k.id, batch: k.batch, expiry: k.expiry, avail: kitUnits(k),
        plain: `${batchText(p, k.batch) || "No number"} · Exp ${niceDate(k.expiry)}`,
        label: `${batchText(p, k.batch) || "No number"} · Exp ${niceDate(k.expiry)} · ${fmt(kitUnits(k))} ${k.doseUnit}${k.open ? ` (${fmt(k.open)} opened)` : ""}`,
      }));
    }
    if (!p.tracked) {
      const id = lotId(p.id, l.loc, "", "");
      const lot = stock.lots.find((x) => x.id === id);
      return [{ ref: id, batch: "", expiry: "", avail: lot ? lot.qty : 0, plain: whereOf(l),
        label: `${whereOf(l)} · ${plural(lot ? lot.qty : 0, p.stockUnit)}` }];
    }
    return stock.lots.filter((x) => x.productId === p.id && x.loc === l.loc && x.qty > 0).sort(fefo).map((x) => ({
      ref: x.id, batch: x.batch, expiry: x.expiry, avail: x.qty,
      plain: `${batchText(p, x.batch)} · Exp ${niceDate(x.expiry)}`,
      label: `${batchText(p, x.batch)} · Exp ${niceDate(x.expiry)} · ${plural(x.qty, p.stockUnit)}`,
    }));
  }
  /* ---------- Opened vials in JT storage / on the Shelf ---------- */
  function vialStock(l, p) {
    const open = (stock.open || []).filter((c) => c.productId === p.id && c.kind === "vial" && c.from === l.loc)
      .map((c) => ({ id: c.id, batch: c.batch, expiry: c.expiry, left: r2(Math.max(0, (c.size || p.dosePer) - c.used)) }))
      .filter((c) => c.left > 0);
    const lots = stock.lots.filter((x) => x.productId === p.id && x.loc === l.loc && x.qty > 0).sort(fefo);
    const units = r2(open.reduce((a, c) => a + c.left, 0) + lots.reduce((a, x) => a + x.qty, 0) * p.dosePer);
    return { open, lots, units };
  }

  // The dose is more than what's left in the opened vial(s): time to Restock
  const needsVial = (l, p) => vialSplit(l, p, clinicalTotal(l, p)).rows.some((x) => x.isNew);
  const vialsLeft = (v) => v.lots.reduce((a, x) => a + x.qty, 0);
  // Which vials each row's units come from: the vial chosen for the row first, then the other opened ones
  // (oldest first), then new vials. { rows: [{ j, openId, batch, expiry, units, isNew }], short, stock }
  function vialSplit(l, p) {
    const v = vialStock(l, p);
    const left = new Map(v.open.map((c) => [c.id, c.left]));
    const sealed = v.lots.map((x) => ({ x, q: x.qty }));
    const parts = [];
    let short = 0;
    l.rows.forEach((r, j) => {
      let need = r2(num(r.amount));
      if (!(need > 0)) return;
      const ids = v.open.map((c) => c.id);
      const order = r.openId && ids.includes(r.openId) ? [r.openId, ...ids.filter((id) => id !== r.openId)] : ids;
      order.forEach((id) => {
        if (need <= 0) return;
        const c = v.open.find((o) => o.id === id);
        const t = r2(Math.min(need, left.get(id) || 0));
        if (!c || !(t > 0)) return;
        parts.push({ j, openId: id, batch: c.batch, expiry: c.expiry, units: t, isNew: false });
        left.set(id, r2(left.get(id) - t));
        need = r2(need - t);
      });
      sealed.forEach((s) => {
        while (need > 0.001 && s.q > 0) {
          s.q -= 1;
          const t = r2(Math.min(need, p.dosePer));
          parts.push({ j, openId: "", batch: s.x.batch, expiry: s.x.expiry, units: t, isNew: true });
          need = r2(need - t);
        }
      });
      if (need > 0.001) short = r2(short + need);
    });
    return { rows: parts, short, stock: v };
  }
  
  /* ---------- Shared products ---------- */
  // Opened containers first, then sealed ones that could be opened (oldest expiry first)
  function sharedOptions(l, p) {
    const open = (stock.open || []).filter((c) => c.productId === p.id).map((c) => {
      const s = openState(c);
      return { value: c.id, c, label: [
        `${batchText(p, c.batch) || "No number"}${c.expiry ? ` · Exp ${niceDate(c.expiry)}` : ""}`,
        c.openedAt ? `opened ${shortDate(c.openedAt)}` : "", plural(c.uses, "use"),
        s === "overdue" ? "PAST USE-BY" : s === "soon" ? `use by ${niceDate(c.useBy)}` : "",
      ].filter(Boolean).join(" · ") };
    });
    const fresh = stock.lots.filter((x) => x.productId === p.id && x.loc === l.loc && x.qty > 0).sort(fefo).map((x) => ({
      value: `new:${x.id}`, lot: x,
      label: `${p.tracked ? `${batchText(p, x.batch)} · Exp ${niceDate(x.expiry)} · ` : ""}${seeStock
        ? `${plural(x.qty, p.stockUnit)} on the ${whereOf(l)}` : `from the ${whereOf(l)}`}`,
    }));
    return { open, fresh };
  }
  // One open: use it. Several open: staff choose. None open: open the oldest expiry.
  function fixShared(l, p) {
    if (!l.rows.length) l.rows = [newRow()];
    const r = l.rows[0];
    const o = sharedOptions(l, p);
    if ([...o.open, ...o.fresh].some((x) => x.value === r.ref)) return;
    r.ref = o.open.length === 1 ? o.open[0].value : o.open.length > 1 ? "" : (o.fresh[0] ? o.fresh[0].value : "");
  }
  function sharedShort(l, p) {
    const r = l.rows[0];
    if (!r || !r.use || r.ref) return 0;
    const o = sharedOptions(l, p);
    return !o.open.length && !o.fresh.length ? 1 : 0;
  }
  function sharedMsg(l, p) {
    const r = l.rows[0];
    if (!r || !r.use) return "";
    const u = p.stockUnit;
    const o = sharedOptions(l, p);
    if (!o.open.length && !o.fresh.length) {
      return `<span class="cs-warn">None open and none on the ${esc(whereOf(l))}. ${f.ifShort === "block"
        ? "Restock before saving." : "It will be saved and flagged for the ordering team."}</span>`;
    }
    if (!r.ref) return `<span class="cs-warn">More than one ${esc(u)} is open: choose which one you used.</span>`;
    const c = o.open.find((x) => x.value === r.ref);
    if (c && openState(c.c) === "overdue") {
      return `<span class="cs-warn">This ${esc(u)} is past its use-by date (${esc(niceDate(c.c.useBy))}). Mark it finished and open a new one.</span>`;
    }
    const amt = num(r.dose) > 0 ? `${fmt(r.dose)} ${esc(p.doseUnit)}` : "Used";
    return `<span class="cs-ok">✓ ${amt}${c ? ` from the opened ${esc(u)}` : ` · opens a new ${esc(u)}`}${r.finish ? ` · ${esc(u)} marked finished` : ""}</span>`;
  }
  function sharedLineHtml(l, i, p, req) {
    const r = l.rows[0];
    const o = sharedOptions(l, p);
    const none = !o.open.length && !o.fresh.length;
    const opt = (x) => `<option value="${esc(x.value)}"${x.value === r.ref ? " selected" : ""}>${esc(x.label)}</option>`;
    const pick = none
      ? `<span class="cs-src">None open, none on the ${esc(whereOf(l))}</span>`
      : `<select class="fe-in" data-f="ref" aria-label="Which ${esc(p.stockUnit)}">
          ${!r.ref ? `<option value="" selected>Choose which ${esc(p.stockUnit)}…</option>` : ""}
          ${o.open.length ? `<optgroup label="Already open">${o.open.map(opt).join("")}</optgroup>` : ""}
          ${o.fresh.length ? `<optgroup label="Open a new ${esc(p.stockUnit)}">${o.fresh.map(opt).join("")}</optgroup>` : ""}
        </select>`;
    return `<div class="cs-line${sharedShort(l, p) ? " is-short" : ""}" data-i="${i}">
      <div class="cs-head">
        <strong>${esc(p.name)}${req}</strong>
        <small>${esc(seeStock ? `${o.open.length} open · ${whereOf(l)}: ${plural(p.stock[l.loc], p.stockUnit)} sealed`
          : `${o.open.length} open`)}</small>${linkNoteHtml(l)}
        <select class="fe-in cs-loc" data-f="loc" aria-label="Open new ones from">
          <option value="shelf"${l.loc === "shelf" ? " selected" : ""}>Shelf</option>
          <option value="jt"${l.loc === "jt" ? " selected" : ""}>JT storage</option></select>
        ${l.extra ? '<button type="button" class="hx-x" data-cs="remove-line" aria-label="Remove">×</button>' : ""}
      </div>
      <div class="cs-row is-shared${p.dosePer ? "" : " no-dose"}" data-j="0">
        <label class="fe-check cs-used"><input type="checkbox" data-f="use"${r.use ? " checked" : ""} /> Used</label>
        ${pick}
        ${p.dosePer ? `<div class="fe-num"><input class="fe-in" type="number" min="0" step="0.1" inputmode="decimal" data-f="dose"
          value="${esc(r.dose)}" placeholder="Amount" aria-label="${esc(p.doseUnit)} used" /><span>${esc(p.doseUnit)}</span></div>` : ""}
      </div>
      ${none ? "" : `<label class="fe-check cs-finish"><input type="checkbox" data-f="finish"${r.finish ? " checked" : ""} />
        It's empty after this patient: mark the ${esc(p.stockUnit)} finished</label>`}
      <div class="cs-foot"><span data-role="msg">${sharedMsg(l, p)}</span></div>
    </div>`;
  }

  // Default amounts from the form, once the product is known
  function applyPresets(l) {
    const p = productOf(l);
    if (!p) return;
    if (shared(p)) {
      l.rows.forEach((r) => {
        if (r.use === null || r.use === undefined) r.use = !!(l.extra || (l.item && l.item.required));
        if (r.preset !== null && r.preset !== undefined) { r.dose = r.preset; r.preset = null; r.seeded = true; }
        else if (!r.seeded) { if (p.dosePer && p.perUse) r.dose = p.perUse; r.seeded = true; }
      });
      return;
    }
    l.rows.forEach((r) => {
      if (r.preset === null || r.preset === undefined) return;
      if (dosed(p)) { r.dose = r.preset; r.amount = syringesFor(p, num(r.preset)); }
      else r.amount = r.preset;
      r.preset = null;
    });
  }

  // A linked amount: kit units are split across batches (oldest expiry first), mL fills the dose
  function fillFrom(l, val) {
    const p = productOf(l);
    if (p && shared(p)) {
      const r = l.rows[0] || newRow();
      r.dose = val || "";
      if (val > 0) r.use = true;
      r.seeded = true;
      l.rows = [r];
      return;
    }
    if (!val) { l.rows = [newRow()]; return; }
    if (!p) { l.rows = [newRow(val)]; return; }
    if (vial(p)) { l.rows = [{ ...newRow(), amount: r2(val), openId: (l.rows[0] && l.rows[0].openId) || "" }]; return; }
    if (dosed(p)) { l.rows = [{ ...newRow(), dose: val, amount: syringesFor(p, val) }]; return; }
    if (!multiOf(l)) {   // one batch only: everything on it (flagged if it isn't enough)
      const s = sources(l)[0];
      l.rows = [{ ...newRow(), ref: s ? s.ref : "", amount: r2(val) }];
      return;
    }
    let left = val;
    const rows = [];
    for (const s of sources(l)) {
      if (left <= 0.0001) break;
      const take = Math.min(left, Math.max(0, s.avail));
      if (take > 0) { rows.push({ ...newRow(), ref: s.ref, amount: r2(take) }); left = r2(left - take); }
    }
    if (left > 0.0001) { // not enough in stock: the rest goes on the last row and is flagged as short
      if (rows.length) rows[rows.length - 1].amount = r2(rows[rows.length - 1].amount + left);
      else rows.push({ ...newRow(), amount: r2(left) });
    }
    l.rows = rows;
  }

  // A linked line split across batches by hand: the first row takes what's left of the linked total
  function restToFirst(l) {
    const p = productOf(l);
    if (!p || !l.rows.length) return;
    const dz = dosed(p);
    const others = l.rows.slice(1).reduce((a, x) => a + num(dz ? x.dose : x.amount), 0);
    const r0 = l.rows[0];
    const rest = r2(Math.max(0, num(l.linkVal) - others));
    if (dz) { r0.dose = rest; if (r0.auto) r0.amount = syringesFor(p, rest); } else r0.amount = rest;
  }

  function linkNoteHtml(l) {
    const from = l.item && l.item.from;
    if (!from || !linked) return "";
    return `<small class="cs-linknote">${l.manual
      ? `Changed by hand · linked total ${esc(fmt(l.linkVal || 0))} <button type="button" class="cs-link" data-cs="relink">Use the linked total</button>`
      : `Filled in from ${esc(linkLabel ? linkLabel(from) : "the form")}`}</small>`;
  }

  function fixRefs(l) {
    const src = sources(l);
    l.rows.forEach((r, i) => {
      if (src.some((s) => s.ref === r.ref)) return;
      const used = l.rows.filter((x, j) => j !== i).map((x) => x.ref);
      r.ref = (src.find((s) => !used.includes(s.ref)) || src[0] || { ref: "" }).ref;
    });
  }

  // Stock that isn't there (kit units, or whole syringes / items)
  function shortOf(l, src = sources(l)) {
    const p = productOf(l);
    if (p && shared(p)) return sharedShort(l, p);
    if (p && vial(p)) return vialSplit(l, p, clinicalTotal(l, p)).short;
    const used = new Map();
    let short = 0;
    l.rows.forEach((r) => {
      const a = num(r.amount);
      if (a <= 0) return;
      const s = src.find((x) => x.ref === r.ref);
      const avail = s ? s.avail - (used.get(r.ref) || 0) : 0;
      const t = Math.max(0, Math.min(a, avail));
      used.set(r.ref, (used.get(r.ref) || 0) + t);
      short += a - t;
    });
    return Math.round(short * 10) / 10;
  }

  function msgHtml(l) {
    const p = productOf(l);
    if (!p) return "";
    if (shared(p)) return sharedMsg(l, p);
    const total = clinicalTotal(l, p);
    const short = shortOf(l);
    const max = l.item && l.item.max;
    const cu = clinicalUnit(p);
    if (max && total > max) return `<span class="cs-warn">${fmt(total)} ${esc(cu)} is more than the ${esc(max)} allowed. Check the amount.</span>`;
    if (short > 0 && !seeStock) {   // blind: say there isn't enough, never how much there is
      return `<span class="cs-warn">Not enough ${isKit(p) ? "in your kit" : `in ${esc(whereOf(l))}`} for this amount. ${isKit(p)
        ? "Press Restock to take more, otherwise it's saved and flagged."
        : f.ifShort === "block" ? "Ask the ordering team to restock before saving." : "It will be saved and flagged for the ordering team."}</span>`;
    }
    if (short > 0) {
      const su = isKit(p) || vial(p) ? p.doseUnit : unitPlural(p.stockUnit);
      return `<span class="cs-warn">Short by ${fmt(short)} ${esc(su)}. ${isKit(p)
        ? "Press Restock to take more, otherwise it's saved and flagged."
        : f.ifShort === "block" ? "Restock before saving." : "It will be saved and flagged for the ordering team."}</span>`;
    }
    if (!(total > 0)) return "";
    if (vial(p)) {
      const sp = vialSplit(l, p, total);
      if (sp.rows.some((x) => x.isNew)) {
        const left = sp.stock.open.reduce((a, c) => a + c.left, 0);
        return `<span class="cs-warn">${left > 0 ? `Only ${esc(fmt(left))} ${esc(cu)} left in the opened ${esc(p.stockUnit)}.` : `No ${esc(p.stockUnit)} is open.`}
          Press Restock to open a new one. (If you don't, it's opened when you save.)</span>`;
      }
      return `<span class="cs-ok">✓ ${fmt(total)} ${esc(cu)} from the opened ${esc(p.stockUnit)}</span>`;
    }
    if (dosed(p)) {
      const syr = l.rows.reduce((a, r) => a + num(r.amount), 0);
      const waste = Math.max(0, r2(syr * p.dosePer - total));
      if (total > syr * p.dosePer + 0.001) {
        return `<span class="cs-warn">${fmt(total)} ${esc(cu)} needs at least ${esc(plural(syringesFor(p, total), p.stockUnit))}.</span>`;
      }
      return `<span class="cs-ok">✓ ${fmt(total)} ${esc(cu)} · ${esc(plural(syr, p.stockUnit))} opened</span>${
        waste ? ` <span class="cs-waste">${fmt(waste)} ${esc(cu)} discarded</span>` : ""}`;
    }
    return `<span class="cs-ok">✓ ${fmt(total)} ${esc(isKit(p) || total === 1 ? cu : unitPlural(cu))}</span>`;
  }

  function rowHtml(l, p, src, r, j) {
    const kit = isKit(p);
    const pick = kit || p.tracked
      ? `<select class="fe-in" data-f="ref" aria-label="Batch">${src.length
          ? src.map((s) => `<option value="${esc(s.ref)}"${s.ref === r.ref ? " selected" : ""}>${esc(seeStock ? s.label : s.plain)}</option>`).join("")
          : `<option value="">${kit ? "Nothing in your kit" : "None in stock here"}</option>`}</select>`
      : `<span class="cs-src">${esc(src[0] ? (seeStock ? src[0].label : src[0].plain) : "")}</span>`;
    const del = l.rows.length > 1 ? '<button type="button" class="hx-x" data-cs="remove-row" aria-label="Remove">×</button>' : "<span></span>";
    if (dosed(p)) {
      return `<div class="cs-row is-dosed" data-j="${j}">${pick}
        <div class="fe-num"><input class="fe-in" type="number" min="0" step="0.1" inputmode="decimal" data-f="dose"
          value="${esc(r.dose)}" placeholder="0" aria-label="${esc(p.doseUnit)} injected" /><span>${esc(p.doseUnit)}</span></div>
        <div class="fe-num"><input class="fe-in" type="number" min="0" step="1" inputmode="numeric" data-f="amount"
          value="${esc(r.amount)}" placeholder="0" aria-label="${esc(unitPlural(p.stockUnit))} opened" /><span>${esc(unitPlural(p.stockUnit))}</span></div>
        ${del}</div>`;
    }
    return `<div class="cs-row" data-j="${j}">${pick}
      <div class="fe-num"><input class="fe-in" type="number" min="0" step="${kit ? "0.5" : "1"}" inputmode="decimal" data-f="amount"
        value="${esc(r.amount)}" placeholder="0" aria-label="Amount used" /><span>${esc(kit ? p.doseUnit : unitPlural(p.stockUnit))}</span></div>
      ${del}</div>`;
  }
  /* ---------- Opened vials: cards to choose from, and a row per vial used ---------- */
  // One row's batch and expiry, following where its units come from
  function vialCells(l, p, j = 0) {
    const sp = vialSplit(l, p);
    const r = l.rows[j] || {};
    let parts = sp.rows.filter((x) => x.j === j);
    if (!parts.length) {
      const c = sp.stock.open.find((o) => o.id === r.openId) || sp.stock.open[0] || sp.stock.lots[0];
      parts = c ? [c] : [];
    }
    const uniq = (list) => list.filter((x, k, a) => a.indexOf(x) === k);
    const batches = uniq(parts.map((x) => x.batch || "No number"));
    return {
      batch: batches.length ? batches.map(esc).join(" → ") : "—",
      exp: parts.length ? uniq(parts.map((x) => expMY(x.expiry))).map(esc).join(" → ") : "—",
      multi: parts.length > 1,
    };
  }

  function vialCardsHtml(l, p) {
    const v = vialStock(l, p);
    if (!v.open.length) {
      return `<div class="cs-cards"><div class="cs-card cs-card-empty"><strong>No vial open</strong>
        <small>${v.lots.length ? "Press Restock to open one." : `None left in ${esc(whereOf(l))}. Order more.`}</small></div></div>`;
    }
    const chosen = new Set(l.rows.map((r) => r.openId).filter(Boolean));
    const using = new Set(vialSplit(l, p).rows.filter((x) => !x.isNew).map((x) => x.openId));
    return `<div class="cs-cards">${v.open.map((c, i) => {
      const on = chosen.has(c.id) || (!chosen.size && using.has(c.id));
      const tag = chosen.has(c.id) ? "Selected" : using.has(c.id) ? "Using" : !chosen.size && !using.size && i === 0 ? "Used first" : "";
      return `<button type="button" class="cs-card cs-card-vial${on ? " is-on" : ""}" data-cs="vpick" data-open="${esc(c.id)}" aria-pressed="${on}">
        <span class="cs-card-top"><strong>${esc(c.batch || "No number")}</strong>${tag ? `<em>${tag}</em>` : ""}</span>
        <small>Exp ${esc(expMY(c.expiry))}</small>
        <span class="cs-vial-left"><b>${esc(fmt(c.left))}</b> ${esc(p.doseUnit)} remaining</span>
        <span class="cs-bar"><i style="width:${Math.round(Math.min(1, c.left / p.dosePer) * 100)}%"></i></span>
      </button>`;
    }).join("")}${v.open.length > 1 && multiOf(l) && v.open.length > l.rows.length
      ? '<button type="button" class="cs-card cs-card-add" data-cs="add-row">+ Use another vial</button>' : ""}</div>`;
  }

  function vialTableHtml(l, p) {
    const v = vialStock(l, p);
    const pick = v.open.length > 1;
    const rows = l.rows.length ? l.rows : [newRow()];
    const total = rows.reduce((a, r) => a + num(r.amount), 0);
    return `<table class="cs-table is-vial"><thead><tr><th>${esc(batchName(p))}</th><th>Expiry</th><th>${esc(p.doseUnit)} used</th><th></th></tr></thead>
      <tbody>${rows.map((r, j) => {
        const c = vialCells(l, p, j);
        const batchCell = pick
          ? `<select class="fe-in" data-f="open" aria-label="Which vial">
              <option value=""${!r.openId ? " selected" : ""}>Oldest opened first</option>
              ${v.open.map((o) => `<option value="${esc(o.id)}"${o.id === r.openId ? " selected" : ""}>${esc(o.batch || "No number")} · Exp ${
                esc(expMY(o.expiry))} · ${esc(fmt(o.left))} ${esc(p.doseUnit)} left</option>`).join("")}
            </select><small class="cs-vrun" data-role="vrun">${c.multi || !r.openId ? `Uses ${c.batch}` : ""}</small>`
          : `<span data-role="vbatch">${c.batch}</span>`;
        return `<tr class="cs-row" data-j="${j}">
          <td class="cs-exp">${batchCell}</td>
          <td class="cs-exp" data-role="vexp">${c.exp}</td>
          <td><div class="fe-num"><input class="fe-in" type="number" min="0" step="0.5" inputmode="decimal" data-f="amount"
            value="${esc(r.amount)}" placeholder="0" aria-label="${esc(p.doseUnit)} used" /><span>${esc(p.doseUnit)}</span></div></td>
          <td>${rows.length > 1 ? '<button type="button" class="hx-x" data-cs="remove-row" aria-label="Remove this vial">×</button>' : ""}</td>
        </tr>`;
      }).join("")}</tbody>
      <tfoot><tr><td colspan="4">Total ${esc(p.doseUnit)} used: <strong data-role="total">${esc(fmt(total))}</strong> ${esc(p.doseUnit)}</td></tr></tfoot>
    </table>`;
  }


  /* ---------- Batch cards and the table (kit products and products with batch & expiry) ---------- */
  const expMY = (k) => { const m = /^(\d{4})-(\d{2})/.exec(k || ""); return m ? `${m[2]}/${m[1]}` : "—"; };
  const availText = (p, s) => (isKit(p) ? `${fmt(s.avail)} ${p.doseUnit}`
    : dosed(p) ? `${fmt(s.avail * p.dosePer)} ${p.doseUnit} · ${plural(s.avail, p.stockUnit)}` : plural(s.avail, p.stockUnit));
  const leftText = (p, src) => `${availText(p, { avail: src.reduce((a, s) => a + s.avail, 0) })} left`;

  function cardsHtml(l, p, src) {
    if (!src.length) return `<p class="cs-none">${isKit(p) ? "Nothing in your kit" : `None in ${esc(whereOf(l))}`}</p>`;
    const used = new Set(l.rows.map((r) => r.ref));
    const max = Math.max(1, ...src.map((s) => s.avail));
    return `<div class="cs-cards">${src.map((s) => {
      const on = used.has(s.ref);
      return `<button type="button" class="cs-card${on ? " is-on" : ""}" data-cs="pick" data-ref="${esc(s.ref)}" aria-pressed="${on}">
        <span class="cs-card-top"><strong>${esc(s.batch || "No number")}</strong>${on ? "<em>Selected</em>" : ""}</span>
        <small>Exp ${esc(expMY(s.expiry))}</small>
        ${seeStock ? `<span class="cs-card-left">${esc(availText(p, s))}</span>
          <span class="cs-bar"><i style="width:${Math.round((s.avail / max) * 100)}%"></i></span>` : ""}
      </button>`;
    }).join("")}${multiOf(l) && src.length > l.rows.length
      ? '<button type="button" class="cs-card cs-card-add" data-cs="add-row">+ Add batch</button>' : ""}</div>`;
  }

  function tableHtml(l, p, src) {
    const dz = dosed(p);
    const cu = clinicalUnit(p);
    const opt = (r) => (src.length
      ? src.map((x) => `<option value="${esc(x.ref)}"${x.ref === r.ref ? " selected" : ""}>${esc(seeStock ? x.label : x.plain)}</option>`).join("")
      : `<option value="">${isKit(p) ? "Nothing in your kit" : "None in stock here"}</option>`);
    return `<table class="cs-table"><thead><tr><th>${esc(batchName(p))}</th><th>Expiry</th><th>${esc(cu)} used</th>${
      dz ? `<th>${esc(unitPlural(p.stockUnit))} opened</th>` : ""}<th></th></tr></thead><tbody>${l.rows.map((r, j) => {
      const s = src.find((x) => x.ref === r.ref);
      return `<tr class="cs-row" data-j="${j}">
        <td><select class="fe-in" data-f="ref" aria-label="${esc(batchName(p))}">${opt(r)}</select></td>
        <td class="cs-exp">${esc(s ? expMY(s.expiry) : "—")}</td>
        <td><div class="fe-num"><input class="fe-in" type="number" min="0" step="${isKit(p) ? "0.5" : dz ? "0.1" : "1"}" inputmode="decimal"
          data-f="${dz ? "dose" : "amount"}" value="${esc(dz ? r.dose : r.amount)}" placeholder="0" aria-label="${esc(cu)} used" /><span>${esc(cu)}</span></div></td>
        ${dz ? `<td><div class="fe-num"><input class="fe-in" type="number" min="0" step="1" inputmode="numeric" data-f="amount"
          value="${esc(r.amount)}" placeholder="0" aria-label="${esc(unitPlural(p.stockUnit))} opened" /></div></td>` : ""}
        <td>${l.rows.length > 1 ? '<button type="button" class="hx-x" data-cs="remove-row" aria-label="Remove this batch">×</button>' : ""}</td>
      </tr>`;
    }).join("")}</tbody>
      <tfoot><tr><td colspan="${dz ? 5 : 4}">Total ${esc(cu)} used: <strong data-role="total">${esc(fmt(clinicalTotal(l, p)))}</strong> ${esc(cu)}</td></tr></tfoot>
    </table>`;
  }

  function lineHtml(l, i) {
    const p = productOf(l);
    const req = l.item && l.item.required ? ' <span class="fe-req">*</span>' : "";
    if (!p) {
      return `<div class="cs-line is-missing" data-i="${i}"><div class="cs-head"><strong>${esc(nameOf(l))}${req}</strong></div>
        <p class="fe-help">This product isn't on the inventory list any more. Ask an Admin to update the form.</p></div>`;
    }
    if (shared(p)) return sharedLineHtml(l, i, p, req);
    const kit = isKit(p);
    const rawKit = isKitProduct(p);
    if (kit && !canKit) {
      return `<div class="cs-line" data-i="${i}"><div class="cs-head"><strong>${esc(p.name)}${req}</strong></div>
        <p class="fe-help">${esc(p.name)} comes from injectors' own kits. Ask an Admin to give you kit access in Staff.</p></div>`;
    }
    const src = sources(l);
    const info = kit
      ? `${fmt(stock.kits.filter((k) => k.productId === p.id).reduce((a, k) => a + kitUnits(k), 0))} ${p.doseUnit} in your kit`
      : `${whereOf(l)}: ${plural(p.stock[l.loc], p.stockUnit)}${dosed(p) ? ` · ${fmt(p.dosePer)} ${p.doseUnit} each` : ""}`;
    // Kit products: where it comes from is changed with Restock. Other products: Shelf or JT storage.
    const locSel = rawKit
      ? `<small class="cs-from">${esc(l.loc === "kit" ? "From your kit" : `From ${whereOf(l)} · opened ${p.stockUnit}`)}${
          pendingRel(p) ? ' · <span class="cs-pending">JT storage release requested · waiting for approval</span>' : ""}</small>`
      : `<select class="fe-in cs-loc" data-f="loc" aria-label="Taken from">
          <option value="shelf"${l.loc === "shelf" ? " selected" : ""}>Shelf</option>
          <option value="jt"${l.loc === "jt" ? " selected" : ""}>JT storage</option></select>`;
    if (vial(p)) {   // JT storage / the Shelf: the opened vial, then the next one
      const v = vialStock(l, p);
      const nv = vialsLeft(v);
      return `<div class="cs-line cs-v2${shortOf(l) > 0 || needsVial(l, p) ? " is-short" : ""}" data-i="${i}">
        <div class="cs-head">
          <strong>${esc(p.name)}${req}</strong>${linkNoteHtml(l)}
          ${locSel}
          <button type="button" class="cs-restock${nv ? "" : " is-out"}" data-cs="restock">Restock${seeStock
            ? ` · ${nv ? `${esc(plural(nv, p.stockUnit))} left` : "none left here"}` : ""}</button>
          ${l.extra ? '<button type="button" class="hx-x" data-cs="remove-line" aria-label="Remove">×</button>' : ""}
        </div>
        ${vialCardsHtml(l, p)}
        ${vialTableHtml(l, p)}
        <div class="cs-foot"><span data-role="msg">${msgHtml(l)}</span></div>
      </div>`;
    }
    if (kit || p.tracked) {   // batches: cards to choose from, and a table of what was used
      return `<div class="cs-line cs-v2${shortOf(l, src) > 0 ? " is-short" : ""}" data-i="${i}">
        <div class="cs-head">
          <strong>${esc(p.name)}${req}</strong>${linkNoteHtml(l)}
          ${locSel}
          ${rawKit || seeStock ? `<button type="button" class="cs-restock" data-cs="restock" title="${rawKit
            ? "Take more into your kit" : "Ask the ordering team for more"}">Restock${seeStock ? ` · ${esc(leftText(p, src))}` : ""}</button>` : ""}
          ${l.extra ? '<button type="button" class="hx-x" data-cs="remove-line" aria-label="Remove">×</button>' : ""}
        </div>
        ${cardsHtml(l, p, src)}
        ${tableHtml(l, p, src)}
        <div class="cs-foot"><span data-role="msg">${msgHtml(l)}</span></div>
      </div>`;
    }
    return `<div class="cs-line${shortOf(l, src) > 0 ? " is-short" : ""}" data-i="${i}">
      <div class="cs-head">
        <strong>${esc(p.name)}${req}</strong>${seeStock ? `<small>${esc(info)}</small>` : ""}${linkNoteHtml(l)}
        ${locSel}
        ${l.extra ? '<button type="button" class="hx-x" data-cs="remove-line" aria-label="Remove">×</button>' : ""}
      </div>
      ${dosed(p) ? `<div class="cs-cols"><span>${esc(batchName(p))}</span><span>${esc(p.doseUnit)} injected</span><span>${esc(unitPlural(p.stockUnit))} opened</span></div>` : ""}
      ${l.rows.map((r, j) => rowHtml(l, p, src, r, j)).join("")}
      <div class="cs-foot">
        <span data-role="msg">${msgHtml(l)}</span>
        <span class="cs-acts">
          ${multiOf(l) && src.length > l.rows.length ? '<button type="button" class="cs-link" data-cs="add-row">+ Another batch</button>' : ""}
        </span>
      </div>
    </div>`;
  }
  function addHtml() {
    if (f.allowExtra === false || !stock) return "";
    const listed = new Set(lines.map((l) => l.productId));
    const groups = INV_CATEGORIES.filter((c) => c.key !== "retail").map((c) => {
      const ps = stock.products.filter((p) => p.active && p.category === c.key && !listed.has(p.id));
      return ps.length ? `<optgroup label="${esc(c.label)}">${ps.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</optgroup>` : "";
    }).join("");
    return groups ? `<div class="cs-add"><select class="fe-in" data-cs-add aria-label="Add another product">
      <option value="">+ Add another product…</option>${groups}</select></div>` : "";
  }

  function draw() {
    if (!host.isConnected) return;
    if (failed) {
      host.innerHTML = '<p class="fe-help tb-bad">Couldn\'t load the stock. Check your connection, then reopen the form.</p>';
      return;
    }
    if (!stock) return;
    lines.forEach((l) => {
      fixLoc(l);
      applyPresets(l);
      const p = productOf(l);
      if (p && shared(p)) fixShared(l, p); else fixRefs(l);
    });
    host.innerHTML = lines.map(lineHtml).join("") + addHtml();
  }

  async function refresh(force = false) {
    try {
      stock = await loadStock(force);
      failed = false;
    } catch (err) {
      console.error("Stock load failed:", err);
      failed = true;
    }
    if (force) document.dispatchEvent(new CustomEvent("cs:stock"));
    draw();
    if (w.csSync) { lines.forEach((l) => { if (!l.manual) l.linkVal = undefined; }); w.csSync(); }
  }
  const onStock = () => {
    if (!host.isConnected) { document.removeEventListener("cs:stock", onStock); return; }
    loadStock().then((s) => { stock = s; draw(); }).catch(() => {});
  };
  document.addEventListener("cs:stock", onStock);

  host.addEventListener("input", (e) => {
    const el = e.target;
    const key = el.dataset.f;
    if (key !== "amount" && key !== "dose") return;
    const li = el.closest(".cs-line");
    const rowEl = el.closest(".cs-row");
    const l = lines[Number(li.dataset.i)];
    const r = l.rows[Number(rowEl.dataset.j)];
    const p = productOf(l);
    // Linked line: changing the first row (or the only row) counts as "by hand". Changing a later batch keeps it
    // linked, and the first row takes what's left of the linked total.
    const j = Number(rowEl.dataset.j);
    const main = !p || shared(p) || key === (dosed(p) ? "dose" : "amount");
    const linkedLine = !!(l.item && l.item.from);
    const split = linkedLine && !l.manual && main && j > 0 && !(p && shared(p));
    if (linkedLine && main && !split) l.manual = true;
    if (key === "dose") {
      r.dose = el.value;
      if (p && shared(p)) {                               // typing an amount means it was used
        if (num(el.value) > 0 && !r.use) {
          r.use = true;
          const cb = rowEl.querySelector('[data-f="use"]');
          if (cb) cb.checked = true;
        }
      } else if (r.auto && dosed(p)) {                    // syringes follow the mL until changed by hand
        r.amount = syringesFor(p, num(el.value));
        const syr = rowEl.querySelector('[data-f="amount"]');
        if (syr) syr.value = r.amount;
      }
    } else {
      r.amount = el.value;
      if (dosed(p)) r.auto = el.value === "";             // typed a syringe count: stop auto-filling
    }
    if (split) {
      l.split = true;
      restToFirst(l);
      const r0 = l.rows[0];
      const row0 = li.querySelector('.cs-row[data-j="0"]');
      if (row0) {
        const d = row0.querySelector('[data-f="dose"]'); if (d) d.value = r0.dose;
        const a = row0.querySelector('[data-f="amount"]'); if (a) a.value = r0.amount;
      }
    }
    const tot = li.querySelector('[data-role="total"]');
    if (tot && p) tot.textContent = fmt(clinicalTotal(l, p));
    if (p && vial(p)) {   // each row's batch and expiry follow which vial(s) its units come from
      li.querySelectorAll(".cs-row[data-j]").forEach((tr) => {
        const jj = Number(tr.dataset.j);
        const c = vialCells(l, p, jj);
        const vb = tr.querySelector('[data-role="vbatch"]'); if (vb) vb.innerHTML = c.batch;
        const vr = tr.querySelector('[data-role="vrun"]');
        if (vr) vr.innerHTML = c.multi || !(l.rows[jj] && l.rows[jj].openId) ? `Uses ${c.batch}` : "";
        const ve = tr.querySelector('[data-role="vexp"]'); if (ve) ve.innerHTML = c.exp;
      });
      const cards = li.querySelector(".cs-cards");
      if (cards) cards.outerHTML = vialCardsHtml(l, p);
    }
    li.querySelector('[data-role="msg"]').innerHTML = msgHtml(l);
    li.classList.toggle("is-short", shortOf(l) > 0 || !!(p && vial(p) && needsVial(l, p)));
    onChange();
  });

  host.addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches("[data-cs-add]")) {
      if (el.value) {
        lines.push({ productId: el.value, item: null, extra: true, loc: defLoc, rows: [newRow()] });
        onChange();
      }
      draw();
      return;
    }
    const li = el.closest(".cs-line");
    if (!li) return;
    const l = lines[Number(li.dataset.i)];
    if (el.dataset.f === "use" || el.dataset.f === "finish") { l.rows[0][el.dataset.f] = el.checked; onChange(); draw(); return; }
    if (el.dataset.f === "open") { l.rows[Number(el.closest(".cs-row").dataset.j)].openId = el.value; onChange(); draw(); return; }
    if (el.dataset.f === "ref") { l.rows[Number(el.closest(".cs-row").dataset.j)].ref = el.value; onChange(); draw(); }
    else if (el.dataset.f === "loc") {
      const p0 = rawProduct(l);
      if (p0 && isKitProduct(p0)) { setLoc(l, el.value); return; }
      l.loc = el.value;
      l.rows.forEach((r) => { r.ref = ""; });
      onChange(); draw();
    }
  });

  // A kit product to another source: the units given are kept, worked out again for where they now come from
  function setLoc(l, loc) {
    const was = clinicalTotal(l);
    l.loc = loc;
    l.userLoc = true;
    l.split = false;
    const p1 = productOf(l);
    if (isKit(p1) || dosed(p1) || vial(p1)) fillFrom(l, was); else l.rows = [newRow()];
    onChange();
    draw();
  }

  // Open a new vial in the place this line uses (staff choose the batch)
  async function openVial(l) {
    const p = productOf(l);
    if (!p || !vial(p)) return;
    const v = vialStock(l, p);
    if (!v.lots.length) { showToast(`None left in ${whereOf(l)}.`); return; }
    const left = r2(v.open.reduce((a, c) => a + c.left, 0));
    const lot = await chooseVialDialog(p, v.lots, { where: whereOf(l), openLeft: left });
    if (!lot) return;
    try {
      await openContainer(p, lot, staff);
      await refresh(true);
      showToast(`New ${p.stockUnit} opened (${batchText(p, lot.batch) || "no batch number"}): ${fmt(p.dosePer)} ${p.doseUnit} ready.`);
    } catch (err) {
      console.error("Open vial failed:", err);
      showToast(err && err.message && !err.code ? err.message : "Couldn't open it. Try again.");
    }
  }

  // An order request to the ordering team
  async function orderMore(l, loc = l.loc === "kit" ? "shelf" : l.loc) {
    const p = rawProduct(l);
    if (!p) return;
    const where = loc === "jt" ? "JT storage" : "Shelf";
    const qty = suggestOrder(p, loc);
    const ok = await confirmDialog({
      title: `Ask for more ${p.name}?`,
      message: `This sends an order request to the ordering team for ${plural(qty, p.orderUnit)} for ${where}.`,
      confirmLabel: "Send request", tone: "info",
    });
    if (!ok) return;
    try {
      await createRequest({
        items: [{ productId: p.id, name: p.name, supplierId: p.supplierId, qty, unitKind: "order",
          unit: p.orderUnit, stockQty: qty * p.packSize }],
        loc, urgency: "normal", note: `Asked for from a treatment record (${f.label || "Products used"})`,
      }, staff);
      showToast(`Order request sent for ${p.name}.`);
    } catch (err) {
      console.error("Order request failed:", err);
      showToast(err && err.message && !err.code ? err.message : "Couldn't send the request. Try again.");
    }
  }

  // The Shelf or JT storage's opened vial (Admins): use it, or open a new one if it's already in use
  function vialOpt(p, l, loc) {
    const v = vialStock({ loc }, p);
    const where = loc === "jt" ? "JT storage" : "the Shelf";
    const nv = vialsLeft(v);
    const open = r2(v.open.reduce((a, c) => a + c.left, 0));
    const left = seeStock ? ` · ${plural(nv, p.stockUnit)} left` : "";
    if (l.loc === loc) {
      return { k: loc, title: `Open a new ${p.stockUnit} from ${where}`, off: !nv,
        sub: nv ? `Choose the batch${left}` : `None left in ${where}` };
    }
    return { k: loc, title: `From ${where.replace(/^the /, "the ")}`, off: !(open > 0 || nv),
      sub: open > 0 ? (seeStock ? `${fmt(open)} ${p.doseUnit} in the opened ${p.stockUnit}` : `Uses its opened ${p.stockUnit}`)
        : nv ? `Opens a new ${p.stockUnit}${left}` : `None left in ${where}` };
  }

  // This person's release request for the product that's still waiting, or undefined
  const pendingRel = (p) => ((stock && stock.rels) || []).find((r) =>
    r.productId === p.id && r.requestedByUid === myUid() && r.status === "pending");

  // Where Restock can take a kit product from, for this person
  function restockOptions(l) {
    const p = rawProduct(l);
    const shelfN = num(p.stock && p.stock.shelf);
    const jtN = num(p.stock && p.stock.jt);
    const opts = [];
    if (canKit && l.loc !== "kit") {
      const u = stock.kits.filter((k) => k.productId === p.id).reduce((a, k) => a + kitUnits(k), 0);
      opts.push({ k: "kit", icon: "kit", title: "Use my kit", off: !(u > 0),
        sub: u > 0 ? (seeStock ? `${fmt(u)} ${p.doseUnit} in your kit` : "Your own kit") : "Nothing in your kit yet" });
    }
    if (canKit) {
      opts.push({ k: "shelf", icon: "shelf", title: "From the Shelf", off: shelfN <= 0,
        sub: shelfN > 0 ? `Into your kit${seeStock ? ` · ${plural(shelfN, p.stockUnit)} left` : ""}` : "None left on the Shelf" });
    } else if (adminStore) {
      opts.push({ ...vialOpt(p, l, "shelf"), icon: "shelf" });
    }
    if (adminStore) opts.push({ ...vialOpt(p, l, "jt"), icon: "lock", admin: true });
    if (canKit) {
      opts.push({ k: "take", icon: "users", title: "Take from a colleague",
        sub: `${p.doseUnit} from their opened ${p.stockUnit}. They're asked to confirm.` });
    }
    // Not an Admin and the Shelf is empty: ask the approvers to release some from JT storage
    if (canKit && !adminStore && shelfN <= 0 && jtN > 0) {
      const pend = pendingRel(p);
      opts.push({ k: "release", icon: "send", title: "Ask for a JT storage release", off: !!pend,
        sub: pend ? `Asked for ${plural(pend.qty, pend.unit || p.stockUnit)} · waiting for approval`
          : "Sends a request to the approvers. Once it's approved, it goes on the Shelf." });
    }
    if (seeStock && shelfN <= 0 && jtN <= 0) {
      opts.push({ k: "order", icon: "send", title: "Ask the ordering team for more", sub: "None left on the Shelf or in JT storage" });
    }
    return opts;
  }

  // Restock: kit products → the overlay; everything else → an order request
  async function restock(l) {
    const p0 = rawProduct(l);
    if (!p0) return;
    if (!isKitProduct(p0)) { await orderMore(l); return; }
    const k = await restockDialog(p0, restockOptions(l));
    if (!k) return;
    if (k === "kit") { setLoc(l, "kit"); return; }
    if (k === "order") { await orderMore(l); return; }
    if (k === "release") {
      if (await jtReleaseDialog(p0, staff)) await refresh(true);   // shows "waiting for approval" straight away
      return;
    }
    if (k === "take") {
      if (await borrowDialog(p0, staff)) { await refresh(true); setLoc(l, "kit"); }
      return;
    }
    if (k === "shelf" && canKit) {
      if (await takeFromShelfDialog(p0, staff)) { await refresh(true); setLoc(l, "kit"); }
      return;
    }
    // Admins: the Shelf's or JT storage's opened vial
    if (l.loc !== k) {
      setLoc(l, k);
      if (!vialStock(l, p0).open.length) await openVial(l);
      return;
    }
    await openVial(l);
  }

  host.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cs]");
    if (!b) return;
    const li = b.closest(".cs-line");
    const l = li ? lines[Number(li.dataset.i)] : null;
    if (!l) return;
    const act = b.dataset.cs;
    const li2 = lines.indexOf(l);
    const focusRow = (j) => setTimeout(() => {
      const el = host.querySelector(`.cs-line[data-i="${li2}"] .cs-row[data-j="${j}"] input`);
      if (el) el.focus();
    }, 0);
    if (act === "relink") { l.manual = false; l.split = false; l.linkVal = undefined; w.csSync(); onChange(); return; }
    if (act === "pick") {   // a batch card: use it (or, if it's already in the table, go to its row)
      const ref = b.dataset.ref;
      const at = l.rows.findIndex((r) => r.ref === ref);
      if (at >= 0) { focusRow(at); return; }
      const first = l.rows[0];
      const firstUsed = first && (num(first.amount) > 0 || num(first.dose) > 0);
      if (firstUsed && multiOf(l)) { l.rows.push({ ...newRow(), ref }); l.split = true; }
      else if (first) first.ref = ref;
      onChange(); draw();
      focusRow(l.rows.findIndex((r) => r.ref === ref));
      return;
    }
    if (act === "restock") { await restock(l); return; }
    // Before adding a vial row, the first row keeps the vial it's using now
    const pinFirst = (p) => {
      const r0 = l.rows[0];
      if (!r0 || r0.openId) return;
      const f = vialSplit(l, p).rows.find((x) => x.j === 0 && x.openId);
      if (f) r0.openId = f.openId;
    };
    if (act === "vpick") {   // a vial card: use this vial
      const p = productOf(l);
      const id = b.dataset.open;
      if (!p || !id) return;
      const at = l.rows.findIndex((r) => r.openId === id);
      if (at >= 0) { focusRow(at); return; }
      const r0 = l.rows[0];
      if (!r0) l.rows = [{ ...newRow(), openId: id }];
      else if (!(num(r0.amount) > 0) || !multiOf(l)) r0.openId = id;
      else {
        pinFirst(p);
        if (r0.openId === id) { focusRow(0); return; }
        l.rows.push({ ...newRow(), openId: id });
        l.split = true;
      }
      onChange(); draw();
      focusRow(Math.max(0, l.rows.findIndex((r) => r.openId === id)));
      return;
    }
    if (act === "add-row") {
      const r = newRow();
      const p = productOf(l);
      if (p && vial(p)) {
        pinFirst(p);
        const free = vialStock(l, p).open.find((c) => !l.rows.some((x) => x.openId === c.id));
        if (free) r.openId = free.id;
      }
      l.rows.push(r); l.split = true; draw(); focusRow(l.rows.length - 1);
    }
    else if (act === "remove-row") {
      l.rows.splice(Number(b.closest(".cs-row").dataset.j), 1);
      if (l.rows.length < 2) l.split = false;
      if (l.item && l.item.from && !l.manual) { if (l.split) restToFirst(l); else fillFrom(l, num(l.linkVal)); }
      onChange(); draw();
    }
    else if (act === "remove-line") { lines.splice(lines.indexOf(l), 1); onChange(); draw(); }
  });

  // What gets taken off when the form is saved
  w.csPlan = () => (!stock ? [] : lines.map((l) => {
    const p = productOf(l);
    if (!p) return null;
    if (shared(p)) {
      const r = l.rows[0];
      if (!r || !r.use) return null;
      const isNew = String(r.ref || "").startsWith("new:");
      const lot = isNew ? stock.lots.find((x) => x.id === r.ref.slice(4)) : null;
      const c = !isNew && r.ref ? (stock.open || []).find((x) => x.id === r.ref) : null;
      const src = c || lot || {};
      return {
        fid: f.id, productId: p.id, name: p.name, kind: "shared", unit: p.stockUnit,
        doseUnit: p.dosePer ? p.doseUnit : "", dosePer: 0, batchLabel: batchName(p), loc: l.loc, block: f.ifShort === "block",
        rows: [{ ref: c ? c.id : "", lot: lot ? lot.id : "", batch: src.batch || "", expiry: src.expiry || "",
          amount: 1, dose: r2(Math.max(0, num(r.dose))), finish: !!r.finish }],
      };
    }
    if (vial(p)) {
      const v = vialStock(l, p);
      const ids = v.open.map((c) => c.id);
      // Each row: its chosen vial first, then the other opened ones, then new vials
      const rows = l.rows.map((r) => ({
        amount: r2(num(r.amount)),
        openIds: r.openId && ids.includes(r.openId) ? [r.openId, ...ids.filter((x) => x !== r.openId)] : ids,
        lots: v.lots.map((x) => x.id),
      })).filter((r) => r.amount > 0);
      if (!rows.length) return null;
      return {
        fid: f.id, productId: p.id, name: p.name, kind: "vial", unit: p.doseUnit, stockUnit: p.stockUnit,
        doseUnit: p.doseUnit, dosePer: p.dosePer, batchLabel: batchName(p), loc: l.loc, block: f.ifShort === "block",
        rows,
      };
    }
    const kit = isKit(p);
    if (kit && !canKit) return null;
    const src = sources(l);
    const rows = l.rows.map((r) => {
      const s = src.find((x) => x.ref === r.ref);
      const amount = kit ? Math.round(num(r.amount) * 10) / 10 : Math.round(num(r.amount));
      const dose = kit ? amount : dosed(p) ? r2(num(r.dose)) : 0;
      return { ref: r.ref || "", batch: s ? s.batch : "", expiry: s ? s.expiry : "", amount, dose };
    }).filter((r) => r.amount > 0 || r.dose > 0);
    if (!rows.length) return null;
    return {
      fid: f.id, productId: p.id, name: p.name, kind: kit ? "kit" : "storage",
      unit: kit ? p.doseUnit : p.stockUnit, doseUnit: kit || dosed(p) ? p.doseUnit : "",
      dosePer: dosed(p) ? p.dosePer : 0, batchLabel: batchName(p),
      loc: kit ? "kit" : l.loc, block: f.ifShort === "block", rows,
    };
  }).filter(Boolean));

  w.csRead = () => ({ lines: w.csPlan().map(({ block, fid, ...x }) => x) });

  w.csProblem = () => {
    if (failed) return "The stock couldn't be loaded. Check your connection and reopen the form.";
    if (!stock) return "Stock is still loading. Try again in a moment.";
    for (const l of lines) {
      const p = productOf(l);
      const name = nameOf(l);
      const req = l.item && l.item.required;
      if (l.rows.some((r) => num(r.amount) < 0 || num(r.dose) < 0)) return `${name}: amounts can't be negative.`;
      if (p && shared(p)) {
        const r = l.rows[0];
        if (req && !(r && r.use)) return `${name}: tick Used.`;
        if (r && r.use) {
          const o = sharedOptions(l, p);
          if (!r.ref && (o.open.length || o.fresh.length)) return `${name}: more than one ${p.stockUnit} is open. Choose which one you used.`;
          if (!r.ref && f.ifShort === "block") return `${name}: none open and none in stock, so this form can't be saved yet.`;
          if (p.dosePer && num(r.dose) > p.dosePer) return `${name}: ${fmt(r.dose)} ${p.doseUnit} is more than a whole ${p.stockUnit} holds.`;
        }
        continue;
      }
      if (p && isKit(p) && !canKit && req) return `${name} has to be recorded by an injector with a kit.`;
      const total = p ? clinicalTotal(l, p) : l.rows.reduce((a, r) => a + num(r.amount), 0);
      if (req && !(total > 0)) return `${name}: enter how much was used.`;
      if (!p) continue;
      if (dosed(p)) {
        if (l.rows.some((r) => num(r.dose) > 0 && !(num(r.amount) >= 1))) return `${name}: enter how many ${unitPlural(p.stockUnit)} were opened.`;
        if (l.rows.some((r) => num(r.amount) > 0 && !(num(r.dose) > 0))) return `${name}: enter how many ${p.doseUnit} were injected.`;
        if (l.rows.some((r) => num(r.dose) > num(r.amount) * p.dosePer + 0.001)) {
          return `${name}: ${fmt(clinicalTotal(l, p))} ${p.doseUnit} is more than ${plural(l.rows.reduce((a, r) => a + num(r.amount), 0), p.stockUnit)} hold. Check the ${unitPlural(p.stockUnit)} opened.`;
        }
      }
      const max = l.item && l.item.max;
      if (max && total > max) return `${name}: ${fmt(total)} ${clinicalUnit(p)} is more than the ${max} allowed. Check the amount.`;
      if (f.ifShort === "block" && shortOf(l) > 0) return `${name}: there isn't enough in stock, so this form can't be saved yet.`;
    }
    return "";
  };
  // Called by the form whenever answers change: linked lines follow their total
  w.csSync = () => {
    if (!linked || !stock) return;
    let redraw = false;
    lines.forEach((l, i) => {
      const from = l.item && l.item.from;
      if (!from) return;
      const raw = Number(linked(from));
      const val = Number.isFinite(raw) && raw > 0 ? r2(raw) : 0;
      if (l.linkVal === val) return;
      l.linkVal = val;
      if (l.manual) { // keep their figure; just update the note
        const note = host.querySelector(`.cs-line[data-i="${i}"] .cs-linknote`);
        if (note) note.outerHTML = linkNoteHtml(l);
        return;
      }
      if (l.split && l.rows.length > 1) restToFirst(l);   // split across batches by hand: the first row takes the rest
      else fillFrom(l, val);
      redraw = true;
    });
    if (redraw) draw();
  };
  refresh(false);
}

// "0.8 mL (1 syringe, 0.2 mL discarded)" for dosed Shelf products, "2 mL (from an opened tube)" for shared ones,
// otherwise "20 units" / "1 needle"
export function consumableAmountText(l, r, withStock = true) {
  if (l.kind === "vial") return `${fmt(r.amount)} ${l.unit}${withStock && r.opened ? ` (new ${l.stockUnit || "vial"} opened)` : ""}`;
  if (l.kind === "shared") {
    const amt = r.dose ? `${fmt(r.dose)} ${l.doseUnit}` : "Used";
    const extra = !r.taken ? ["none in stock"]
      : [r.opened ? `opened a new ${l.unit}` : `from an opened ${l.unit}`, r.finished ? `${l.unit} finished` : ""].filter(Boolean);
    return `${amt}${withStock ? ` (${extra.join(", ")})` : ""}`;
  }
  if (l.kind !== "kit" && l.doseUnit && r.dose) {
    const extra = [r.amount ? plural(r.amount, l.unit) : "", r.waste ? `${fmt(r.waste)} ${l.doseUnit} discarded` : ""].filter(Boolean);
    return `${fmt(r.dose)} ${l.doseUnit}${withStock && extra.length ? ` (${extra.join(", ")})` : ""}`;
  }
  return l.kind === "kit" ? `${fmt(r.amount)} ${l.unit}` : plural(r.amount, l.unit);
}

// A saved record: what was given, with batches
export function consumablesViewHtml(v) {
  const lines = v && Array.isArray(v.lines) ? v.lines : [];
  if (!lines.length) return '<p class="fe-help">Nothing recorded.</p>';
  const from = (l, r) => (r.from === "kit" ? "Clinician's kit"
    : r.from === "open" ? `Opened ${l.unit}`
    : `${r.from === "jt" ? "JT storage" : "Shelf"}${l.kind === "shared" && r.opened ? ` (new ${l.unit} opened)` : ""}`);
  const shortText = (l) => (l.kind === "shared" ? "None in stock"
    : `Stock short by ${fmt(l.short)} ${l.kind === "kit" || l.kind === "vial" ? l.unit : unitPlural(l.unit)}`);
  return `<table class="inv-table cs-view"><thead><tr><th>Product</th><th>Amount</th><th>Batch / Lot</th><th>Expiry</th><th>From</th></tr></thead><tbody>${
  lines.map((l) => (l.rows && l.rows.length ? l.rows : [{ amount: l.total }]).map((r, i) => `<tr>
      <td>${i ? "" : `<strong>${esc(l.name)}</strong>${l.short > 0 ? ` <span class="inv-flag is-warn">${esc(shortText(l))}</span>` : ""}`}</td>
      <td>${esc(consumableAmountText(l, r))}</td>
      <td>${esc(r.batch ? `${l.batchLabel || "Batch"} ${r.batch}` : "—")}</td>
      <td>${esc(r.expiry ? niceDate(r.expiry) : "—")}</td><td>${esc(from(l, r))}</td></tr>`).join("")).join("")}</tbody></table>`;
}

// Form Builder: choose which products a Consumables field lists (retail is left out)
export function openProductPicker(products, selectedIds = []) {
  return new Promise((resolve) => {
    let out = null;
    const sel = new Set(selectedIds);
    const groups = INV_CATEGORIES.filter((c) => c.key !== "retail").map((c) => {
      const ps = products.filter((p) => (p.active || sel.has(p.id)) && p.category === c.key);
      return ps.length ? `<div class="cs-pick-group"><h4>${esc(c.label)}</h4>${ps.map((p) => `
        <label class="fe-check" data-find="${esc(p.name.toLowerCase())}"><input type="checkbox" value="${esc(p.id)}"${sel.has(p.id) ? " checked" : ""} />
          ${esc(p.name)} <small class="muted">${isKitProduct(p) ? `Kit · ${esc(p.doseUnit)}`
            : shared(p) ? `Shared across patients${p.dosePer ? ` · ${fmt(p.dosePer)} ${esc(p.doseUnit)} per ${esc(p.stockUnit)}` : ""}`
            : dosed(p) ? `${esc(p.doseUnit)} · ${fmt(p.dosePer)} per ${esc(p.stockUnit)}` : esc(unitPlural(p.stockUnit))}</small></label>`).join("")}</div>` : "";
    }).join("");
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Choose products</h3><p>These show on the form for staff to fill in. Retail products aren't listed.</p></div>
      <input class="fe-input" type="search" data-role="q" placeholder="Search products" />
      <div class="cs-pick">${groups || '<p class="tb-none">No products yet. Add them in Inventory → Products.</p>'}</div>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Use these products</button>
      </div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out); });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.querySelector('[data-role="q"]').addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      dlg.querySelectorAll("[data-find]").forEach((el) => { el.hidden = !!q && !el.dataset.find.includes(q); });
    });
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const checked = [...dlg.querySelectorAll('input[type="checkbox"]:checked')].map((x) => x.value);
      out = [...selectedIds.filter((id) => checked.includes(id)), ...checked.filter((id) => !selectedIds.includes(id))];
      dlg.close();
    });
    dlg.showModal();
  });
}