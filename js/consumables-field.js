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
  plural, unitPlural, fefo, lotId, INV_CATEGORIES, batchName, batchText,
} from "./inventory-api.js";
import { takeFromShelfDialog, borrowDialog } from "./inventory-kits.js";
import { isInjector, isAdmin } from "./perms.js";

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
const dosed = (p) => !!p && !isKitProduct(p) && !shared(p) && !!p.dosePer;
// What the clinician records: units (kit), mL (dosed), or items
const clinicalUnit = (p) => (isKitProduct(p) || dosed(p) ? p.doseUnit : shared(p) ? (p.dosePer ? p.doseUnit : "use") : p.stockUnit);
// Syringes needed for a dose: 2.2 mL of a 1.5 mL syringe = 2
const syringesFor = (p, dose) => (dose > 0 ? Math.max(1, Math.ceil(dose / p.dosePer - 1e-9)) : "");

// Shared by every Consumables field on the same form (reloaded for each new form)
let stockJob = null;
let stockAt = 0;
function loadStock(force = false) {
  if (!stockJob || force || Date.now() - stockAt > 10000) {
    stockAt = Date.now();
    stockJob = Promise.all([listProducts(), listAllLots(), listKits({ mine: true }).catch(() => []), listOpenContainers().catch(() => [])])
      .then(([products, lots, kits, open]) => ({ products, lots, kits, open }));
    stockJob.catch(() => { stockJob = null; });
  }
  return stockJob;
}

// linked(fieldId): the current total of a marked picture / Calculation / Number on the form (or null)
// linkLabel(fieldId): its name, shown as "Filled in from …"
export function mountConsumablesField(w, f, { staff, onChange = () => {}, linked = null, linkLabel = null } = {}) {
  const host = w && w.querySelector("[data-cs-host]");
  if (!host) return;
  const canKit = isInjector();
    const adminStore = isAdmin();
  const defLoc = isTeh(staff) ? "jt" : "shelf";
  let stock = null, failed = false;
  // use: shared products only (null = not decided yet)
  const newRow = (preset = null) => ({ ref: "", amount: "", dose: "", auto: true, preset, use: null, finish: false, seeded: false });
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

  function sources(l) {
    const p = productOf(l);
    if (!p || shared(p)) return [];
    if (isKitProduct(p)) {
      return stock.kits.filter((k) => k.productId === p.id && kitUnits(k) > 0).map((k) => ({
        ref: k.id, batch: k.batch, expiry: k.expiry, avail: kitUnits(k),
        label: `${batchText(p, k.batch) || "No number"} · Exp ${niceDate(k.expiry)} · ${fmt(kitUnits(k))} ${k.doseUnit}${k.open ? ` (${fmt(k.open)} opened)` : ""}`,
      }));
    }
    if (!p.tracked) {
      const id = lotId(p.id, l.loc, "", "");
      const lot = stock.lots.find((x) => x.id === id);
      return [{ ref: id, batch: "", expiry: "", avail: lot ? lot.qty : 0,
        label: `${whereOf(l)} · ${plural(lot ? lot.qty : 0, p.stockUnit)}` }];
    }
    return stock.lots.filter((x) => x.productId === p.id && x.loc === l.loc && x.qty > 0).sort(fefo).map((x) => ({
      ref: x.id, batch: x.batch, expiry: x.expiry, avail: x.qty,
      label: `${batchText(p, x.batch)} · Exp ${niceDate(x.expiry)} · ${plural(x.qty, p.stockUnit)}`,
    }));
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
      label: `${p.tracked ? `${batchText(p, x.batch)} · Exp ${niceDate(x.expiry)} · ` : ""}${plural(x.qty, p.stockUnit)} on the ${whereOf(l)}`,
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
        <small>${esc(`${o.open.length} open · ${whereOf(l)}: ${plural(p.stock[l.loc], p.stockUnit)} sealed`)}</small>${linkNoteHtml(l)}
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
    if (dosed(p)) { l.rows = [{ ...newRow(), dose: val, amount: syringesFor(p, val) }]; return; }
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
    if (short > 0) {
      const su = isKitProduct(p) ? p.doseUnit : unitPlural(p.stockUnit);
      return `<span class="cs-warn">Short by ${fmt(short)} ${esc(su)}. ${isKitProduct(p)
        ? "Take from the Shelf or borrow from a colleague, otherwise it's saved and flagged."
        : f.ifShort === "block" ? "Restock before saving." : "It will be saved and flagged for the ordering team."}</span>`;
    }
    if (!(total > 0)) return "";
    if (dosed(p)) {
      const syr = l.rows.reduce((a, r) => a + num(r.amount), 0);
      const waste = Math.max(0, r2(syr * p.dosePer - total));
      if (total > syr * p.dosePer + 0.001) {
        return `<span class="cs-warn">${fmt(total)} ${esc(cu)} needs at least ${esc(plural(syringesFor(p, total), p.stockUnit))}.</span>`;
      }
      return `<span class="cs-ok">✓ ${fmt(total)} ${esc(cu)} · ${esc(plural(syr, p.stockUnit))} opened</span>${
        waste ? ` <span class="cs-waste">${fmt(waste)} ${esc(cu)} discarded</span>` : ""}`;
    }
    return `<span class="cs-ok">✓ ${fmt(total)} ${esc(isKitProduct(p) || total === 1 ? cu : unitPlural(cu))}</span>`;
  }

  function rowHtml(l, p, src, r, j) {
    const kit = isKitProduct(p);
    const pick = kit || p.tracked
      ? `<select class="fe-in" data-f="ref" aria-label="Batch">${src.length
          ? src.map((s) => `<option value="${esc(s.ref)}"${s.ref === r.ref ? " selected" : ""}>${esc(s.label)}</option>`).join("")
          : `<option value="">${kit ? "Nothing in your kit" : "None in stock here"}</option>`}</select>`
      : `<span class="cs-src">${esc(src[0] ? src[0].label : "")}</span>`;
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
    const locSel = !rawKit || adminStore
      ? `<select class="fe-in cs-loc" data-f="loc" aria-label="Taken from">
          ${rawKit && canKit ? `<option value="kit"${l.loc === "kit" ? " selected" : ""}>My kit</option>` : ""}
          <option value="shelf"${l.loc === "shelf" ? " selected" : ""}>Shelf</option>
          <option value="jt"${l.loc === "jt" ? " selected" : ""}>JT storage</option></select>`
      : "";
    return `<div class="cs-line${shortOf(l, src) > 0 ? " is-short" : ""}" data-i="${i}">
      <div class="cs-head">
        <strong>${esc(p.name)}${req}</strong><small>${esc(info)}</small>${linkNoteHtml(l)}
        ${locSel}
        ${l.extra ? '<button type="button" class="hx-x" data-cs="remove-line" aria-label="Remove">×</button>' : ""}
      </div>
      ${dosed(p) ? `<div class="cs-cols"><span>${esc(batchName(p))}</span><span>${esc(p.doseUnit)} injected</span><span>${esc(unitPlural(p.stockUnit))} opened</span></div>` : ""}
      ${l.rows.map((r, j) => rowHtml(l, p, src, r, j)).join("")}
      <div class="cs-foot">
        <span data-role="msg">${msgHtml(l)}</span>
        <span class="cs-acts">
          ${src.length > l.rows.length ? '<button type="button" class="cs-link" data-cs="add-row">+ Another batch</button>' : ""}
          ${kit ? `${p.stock.shelf > 0 ? '<button type="button" class="cs-link" data-cs="take">Take from Shelf</button>' : ""}
            <button type="button" class="cs-link" data-cs="borrow">Borrow from a colleague</button>` : ""}
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
    if (l.item && l.item.from) l.manual = true; // their own figure wins until "Use the linked total"
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
    li.querySelector('[data-role="msg"]').innerHTML = msgHtml(l);
    li.classList.toggle("is-short", shortOf(l) > 0);
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
    if (el.dataset.f === "ref") { l.rows[Number(el.closest(".cs-row").dataset.j)].ref = el.value; onChange(); draw(); }
    else if (el.dataset.f === "loc") {
      const p0 = rawProduct(l);
      if (p0 && isKitProduct(p0)) {
        // Kit ↔ storage: keep the units given, worked out again for where they now come from
        const was = clinicalTotal(l);
        l.loc = el.value;
        l.userLoc = true;
        const p1 = productOf(l);
        if (isKit(p1) || dosed(p1)) fillFrom(l, was); else l.rows = [newRow()];
      } else {
        l.loc = el.value;
        l.rows.forEach((r) => { r.ref = ""; });
      }
      onChange(); draw();
    }
  });

  host.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cs]");
    if (!b) return;
    const li = b.closest(".cs-line");
    const l = li ? lines[Number(li.dataset.i)] : null;
    if (!l) return;
    const act = b.dataset.cs;
    if (act === "relink") { l.manual = false; l.linkVal = undefined; w.csSync(); onChange(); return; }
    if (act === "add-row") { if (l.item && l.item.from) l.manual = true; l.rows.push(newRow()); draw(); }
    else if (act === "remove-row") { if (l.item && l.item.from) l.manual = true; l.rows.splice(Number(b.closest(".cs-row").dataset.j), 1); onChange(); draw(); }
    else if (act === "remove-line") { lines.splice(lines.indexOf(l), 1); onChange(); draw(); }
    else if (act === "take" || act === "borrow") {
      const p = productOf(l);
      if (!p) return;
      const ok = act === "take" ? await takeFromShelfDialog(p, staff) : await borrowDialog(p, staff);
      if (ok) await refresh(true);
    }
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
    const kit = isKitProduct(p);
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
      if (p && isKitProduct(p) && !canKit && req) return `${name} has to be recorded by an injector with a kit.`;
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
      fillFrom(l, val);
      redraw = true;
    });
    if (redraw) draw();
  };
  refresh(false);
}

// "0.8 mL (1 syringe, 0.2 mL discarded)" for dosed Shelf products, "2 mL (from an opened tube)" for shared ones,
// otherwise "20 units" / "1 needle"
export function consumableAmountText(l, r, withStock = true) {
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
  const shortText = (l) => (l.kind === "shared" ? "None in stock" : `Stock short by ${fmt(l.short)} ${l.kind === "kit" ? l.unit : unitPlural(l.unit)}`);
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