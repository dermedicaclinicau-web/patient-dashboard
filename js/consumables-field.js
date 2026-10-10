// Treatment records: the Consumables field ("Products used").
// Kit products (e.g. Xeomin) come from the clinician's own kit, in units.
// Shelf products with a dose (e.g. Belotero 1 mL, Radiesse 1.5 mL per syringe): the clinician records mL injected,
//   and the syringes opened come off the Shelf (JT storage for Dr Teh).
// Everything else comes off in whole items.
// Stock only changes when the form is saved, in the same transaction as the record.
// (Take from Shelf and Borrow happen straight away: they're real handovers, logged on their own.)
import {
  listProducts, listAllLots, listKits, isKitProduct, kitUnits, plural, unitPlural, fefo, lotId, INV_CATEGORIES, batchName, batchText,
} from "./inventory-api.js";
import { takeFromShelfDialog, borrowDialog } from "./inventory-kits.js";
import { isInjector } from "./perms.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(+Number(n || 0).toFixed(2));
const num = (v) => Number(v) || 0;
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
};
const isTeh = (staff) => /\bteh\b/i.test(String((staff && staff.name) || ""));
// A Shelf product measured by dose, e.g. a 1 mL syringe of filler
const dosed = (p) => !!p && !isKitProduct(p) && !!p.dosePer;
// What the clinician records: units (kit), mL (dosed), or items
const clinicalUnit = (p) => (isKitProduct(p) || dosed(p) ? p.doseUnit : p.stockUnit);
// Syringes needed for a dose: 2.2 mL of a 1.5 mL syringe = 2
const syringesFor = (p, dose) => (dose > 0 ? Math.max(1, Math.ceil(dose / p.dosePer - 1e-9)) : "");

// Shared by every Consumables field on the page
let stockJob = null;
function loadStock(force = false) {
  if (!stockJob || force) {
    stockJob = Promise.all([listProducts(), listAllLots(), listKits({ mine: true }).catch(() => [])])
      .then(([products, lots, kits]) => ({ products, lots, kits }));
    stockJob.catch(() => { stockJob = null; });
  }
  return stockJob;
}

export function mountConsumablesField(w, f, { staff, onChange = () => {} } = {}) {
  const host = w && w.querySelector("[data-cs-host]");
  if (!host) return;
  const canKit = isInjector();
  const defLoc = isTeh(staff) ? "jt" : "shelf";
  let stock = null, failed = false;
  const newRow = (preset = null) => ({ ref: "", amount: "", dose: "", auto: true, preset });
  const lines = (f.items || []).map((it) => ({
    productId: it.productId, item: it, extra: false, loc: defLoc, rows: [newRow(it.amount ?? null)],
  }));

  const productOf = (l) => (stock ? stock.products.find((p) => p.id === l.productId) : null);
  const nameOf = (l) => (productOf(l) || {}).name || (l.item && l.item.name) || "Product";
  // The amount the clinician gave (units / mL / items)
  const clinicalTotal = (l, p = productOf(l)) => l.rows.reduce((a, r) => a + num(dosed(p) ? r.dose : r.amount), 0);

  function sources(l) {
    const p = productOf(l);
    if (!p) return [];
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
        label: `${l.loc === "jt" ? "JT storage" : "Shelf"} · ${plural(lot ? lot.qty : 0, p.stockUnit)}` }];
    }
    return stock.lots.filter((x) => x.productId === p.id && x.loc === l.loc && x.qty > 0).sort(fefo).map((x) => ({
      ref: x.id, batch: x.batch, expiry: x.expiry, avail: x.qty,
      label: `${batchText(p, x.batch)} · Exp ${niceDate(x.expiry)} · ${plural(x.qty, p.stockUnit)}`,
     }));
  }

  // Default amounts from the form, once the product is known
  function applyPresets(l) {
    const p = productOf(l);
    if (!p) return;
    l.rows.forEach((r) => {
      if (r.preset === null || r.preset === undefined) return;
      if (dosed(p)) {
        if (l.rows.some((r) => num(r.dose) > 0 && !(num(r.amount) >= 1))) return `${name}: enter how many ${unitPlural(p.stockUnit)} were opened.`;
        if (l.rows.some((r) => num(r.amount) > 0 && !(num(r.dose) > 0))) return `${name}: enter how many ${p.doseUnit} were injected.`;
        if (l.rows.some((r) => num(r.dose) > num(r.amount) * p.dosePer + 0.001)) {
          return `${name}: ${fmt(clinicalTotal(l, p))} ${p.doseUnit} is more than ${plural(l.rows.reduce((a, r) => a + num(r.amount), 0), p.stockUnit)} hold. Check the ${unitPlural(p.stockUnit)} opened.`;
        }
      }
      else r.amount = r.preset;
      r.preset = null;
    });
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
      const waste = Math.max(0, Math.round((syr * p.dosePer - total) * 100) / 100);
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
    const kit = isKitProduct(p);
    if (kit && !canKit) {
      return `<div class="cs-line" data-i="${i}"><div class="cs-head"><strong>${esc(p.name)}${req}</strong></div>
        <p class="fe-help">${esc(p.name)} comes from injectors' own kits. Ask an Admin to give you kit access in Staff.</p></div>`;
    }
    const src = sources(l);
    const info = kit
      ? `${fmt(stock.kits.filter((k) => k.productId === p.id).reduce((a, k) => a + kitUnits(k), 0))} ${p.doseUnit} in your kit`
      : `${l.loc === "jt" ? "JT storage" : "Shelf"}: ${plural(p.stock[l.loc], p.stockUnit)}${dosed(p) ? ` · ${fmt(p.dosePer)} ${p.doseUnit} each` : ""}`;
    return `<div class="cs-line${shortOf(l, src) > 0 ? " is-short" : ""}" data-i="${i}">
      <div class="cs-head">
        <strong>${esc(p.name)}${req}</strong><small>${esc(info)}</small>
        ${kit ? "" : `<select class="fe-in cs-loc" data-f="loc" aria-label="Taken from">
          <option value="shelf"${l.loc === "shelf" ? " selected" : ""}>Shelf</option>
          <option value="jt"${l.loc === "jt" ? " selected" : ""}>JT storage</option></select>`}
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
    lines.forEach((l) => { applyPresets(l); fixRefs(l); });
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
    if (key === "dose") {
      r.dose = el.value;
      if (r.auto && p) {                                  // syringes follow the mL until changed by hand
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
    if (el.dataset.f === "ref") { l.rows[Number(el.closest(".cs-row").dataset.j)].ref = el.value; onChange(); draw(); }
    else if (el.dataset.f === "loc") { l.loc = el.value; l.rows.forEach((r) => { r.ref = ""; }); onChange(); draw(); }
  });

  host.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cs]");
    if (!b) return;
    const li = b.closest(".cs-line");
    const l = li ? lines[Number(li.dataset.i)] : null;
    if (!l) return;
    const act = b.dataset.cs;
    if (act === "add-row") { l.rows.push(newRow()); draw(); }
    else if (act === "remove-row") { l.rows.splice(Number(b.closest(".cs-row").dataset.j), 1); onChange(); draw(); }
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
    const kit = isKitProduct(p);
    if (kit && !canKit) return null;
    const src = sources(l);
    const rows = l.rows.map((r) => {
      const s = src.find((x) => x.ref === r.ref);
      const amount = kit ? Math.round(num(r.amount) * 10) / 10 : Math.round(num(r.amount));
      const dose = kit ? amount : dosed(p) ? Math.round(num(r.dose) * 100) / 100 : 0;
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
      if (p && isKitProduct(p) && !canKit && req) return `${name} has to be recorded by an injector with a kit.`;
      const total = p ? clinicalTotal(l, p) : l.rows.reduce((a, r) => a + num(r.amount), 0);
      if (req && !(total > 0)) return `${name}: enter how much was used.`;
      if (!p) continue;
      if (dosed(p)) {
        if (l.rows.some((r) => num(r.dose) > 0 && !(num(r.amount) >= 1))) return `${name}: enter how many ${unitPlural(p.stockUnit)} were opened.`;
        if (l.rows.some((r) => num(r.amount) > 0 && !(num(r.dose) > 0))) return `${name}: enter how many ${p.doseUnit} were injected.`;
      }
      const max = l.item && l.item.max;
      if (max && total > max) return `${name}: ${fmt(total)} ${clinicalUnit(p)} is more than the ${max} allowed. Check the amount.`;
      if (f.ifShort === "block" && shortOf(l) > 0) return `${name}: there isn't enough in stock, so this form can't be saved yet.`;
    }
    return "";
  };

  refresh(false);
}

// "0.8 mL (1 syringe, 0.2 mL discarded)" for dosed Shelf products, otherwise "20 units" / "1 needle"
export function consumableAmountText(l, r, withStock = true) {
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
  const from = (r) => (r.from === "kit" ? "Clinician's kit" : r.from === "jt" ? "JT storage" : "Shelf");
  return `<table class="inv-table cs-view"><thead><tr><th>Product</th><th>Amount</th><th>Batch / Lot</th><th>Expiry</th><th>From</th></tr></thead><tbody>${
  lines.map((l) => (l.rows && l.rows.length ? l.rows : [{ amount: l.total }]).map((r, i) => `<tr>
      <td>${i ? "" : `<strong>${esc(l.name)}</strong>${l.short > 0 ? ` <span class="inv-flag is-warn">Stock short by ${fmt(l.short)} ${esc(l.kind === "kit" ? l.unit : unitPlural(l.unit))}</span>` : ""}`}</td>
      <td>${esc(consumableAmountText(l, r))}</td>      <td>${esc(r.batch ? `${l.batchLabel || "Batch"} ${r.batch}` : "—")}</td>
      <td>${esc(r.expiry ? niceDate(r.expiry) : "—")}</td><td>${esc(from(r))}</td></tr>`).join("")).join("")}</tbody></table>`;
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