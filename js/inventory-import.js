// Inventory → Products: import many products (and their opening stock) from a CSV, or export them to one.
import {
  INV_CATEGORIES, WEEKDAYS, catLabel, plural, cleanProduct, saveProduct, saveSupplier, applyStock, productSuppliers,
} from "./inventory-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const MAX_ROWS = 2000;
const errText = (err) => (err && err.code === "permission-denied"
  ? "No access. Check your Manage inventory access and the Inventory Firestore rules."
  : err && err.message ? err.message : "Couldn't save.");

// Column headings (aliases are also recognised, in any order, any capitals)
const COLS = [
  { key: "name", label: "Name", alias: ["product", "product name", "item"] },
  { key: "category", label: "Category" },
  { key: "brand", label: "Brand" },
  { key: "supplier", label: "Supplier" },
  { key: "supplierCode", label: "Supplier code", alias: ["code", "sku", "product code"] },
  { key: "altSuppliers", label: "Other suppliers", alias: ["more suppliers", "alt suppliers", "also from"] },
  { key: "barcode", label: "Barcode" },
  { key: "stockUnit", label: "Given as", alias: ["stock unit", "unit"] },
  { key: "dosePer", label: "Amount in each", alias: ["dose per", "amount each"] },
  { key: "doseUnit", label: "Measured in", alias: ["dose unit"] },
  { key: "orderUnit", label: "Bought as", alias: ["order unit"] },
  { key: "packSize", label: "Pack size", alias: ["per box", "how many in each"] },
  { key: "usage", label: "Used from", alias: ["usage"] },
  { key: "cost", label: "Cost" },
  { key: "price", label: "Retail price", alias: ["price", "rrp"] },
  { key: "tracked", label: "Batch and expiry", alias: ["tracked", "batch tracked", "batch & expiry"] },
  { key: "batchLabel", label: "Batch called", alias: ["batch label"] },
  { key: "reShelf", label: "Reorder Shelf at", alias: ["reorder shelf"] },
  { key: "reJt", label: "Reorder JT at", alias: ["reorder jt"] },
  { key: "countFreq", label: "Count", alias: ["count frequency", "opening count"] },
  { key: "countDay", label: "Count day" },
  { key: "countWhere", label: "Count in" },
  { key: "active", label: "Active" },
  { key: "notes", label: "Notes" },
  { key: "shelfQty", label: "Shelf qty", alias: ["shelf", "shelf stock"] },
  { key: "jtQty", label: "JT qty", alias: ["jt", "jt stock", "jt storage"] },
  { key: "batch", label: "Batch", alias: ["lot", "batch number", "lot number"] },
  { key: "expiry", label: "Expiry", alias: ["expiry date", "exp"] },
];

const EXAMPLES = [
  { name: "Xeomin 100 units", category: "Injectables", brand: "Merz", supplier: "Merz Aesthetics", altSuppliers: "Medical Supplies Co | MS-XEO100 | 310", stockUnit: "vial", dosePer: "100",
    doseUnit: "units", orderUnit: "vial", packSize: "1", usage: "Kit", cost: "300", tracked: "Yes", batchLabel: "Lot",
    reShelf: "2", countFreq: "Daily", countWhere: "Both", active: "Yes", shelfQty: "4", batch: "ABC123", expiry: "31/03/2027" },
  { name: "Xeomin 100 units", jtQty: "6", batch: "DEF456", expiry: "30/06/2027" },
  { name: "Belotero Balance 1mL", category: "Injectables", brand: "Merz", supplier: "Merz Aesthetics", stockUnit: "syringe", dosePer: "1",
    doseUnit: "mL", orderUnit: "syringe", packSize: "1", usage: "Shelf", cost: "180", tracked: "Yes", reShelf: "3",
    countFreq: "Weekly", countDay: "Monday", active: "Yes", shelfQty: "5", batch: "BB2201", expiry: "11/2027" },
  { name: "Needles 30G 13mm", category: "Treatment consumables", supplier: "Medical Supplies Co", stockUnit: "needle",
    orderUnit: "box", packSize: "100", usage: "Shelf", cost: "25", tracked: "No", reShelf: "100", countFreq: "Never",
    active: "Yes", shelfQty: "250" },
];

/* ---------- CSV ---------- */

function downloadCsv(name, rows) {
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(["\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Quoted cells, "" inside quotes, CRLF or LF, comma or semicolon separated
function parseCsv(text) {
  const src = String(text || "").replace(/^\ufeff/, "");
  const first = src.split(/\r?\n/, 1)[0] || "";
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

/* ---------- Reading values ---------- */

const yesNo = (s) => (/^(y|yes|true|1|x|✓|✔)$/i.test(s) ? true : /^(n|no|false|0)$/i.test(s) ? false : null);
function catKey(s) {
  const n = norm(s);
  const hit = INV_CATEGORIES.find((c) => norm(c.key) === n || norm(c.label) === n);
  if (hit) return hit.key;
  if (n.startsWith("inject")) return "injectable";
  if (n.startsWith("retail")) return "retail";
  if (n.startsWith("treat")) return "treatment";
  if (n.startsWith("general") || n.startsWith("consum")) return "general";
  return null;
}
const usageKey = (s) => (/kit/i.test(s) ? "kit" : /^(shelf|storage|one per patient|patient)/i.test(s.trim()) ? "storage" : null);
function freqKey(s) {
  const n = norm(s);
  if (!n || /^(never|no|none|notcounted)$/.test(n)) return "never";
  if (/^(daily|everyday|day)$/.test(n)) return "daily";
  if (/^(weekly|week|onceaweek)$/.test(n)) return "weekly";
  if (/^(monthly|month|onceamonth)$/.test(n)) return "monthly";
  return null;
}
function whereKey(s) {
  const n = norm(s);
  if (/^(both|shelfandjt|shelfandjtstorage|all)$/.test(n)) return "both";
  if (/^(shelf|shelfonly)$/.test(n)) return "shelf";
  if (/^(jt|jtstorage|jtonly|jtstorageonly)$/.test(n)) return "jt";
  return null;
}
function dayValue(s, freq) {
  const t = String(s || "").trim();
  if (!t) return undefined;
  if (freq === "weekly") {
    const i = WEEKDAYS.findIndex((d) => d.toLowerCase().startsWith(t.toLowerCase().slice(0, 3)));
    if (i >= 0) return i;
    const n = parseInt(t, 10);
    return n >= 0 && n <= 6 ? n : null;
  }
  if (freq === "monthly") {
    if (/^last/i.test(t)) return "last";
    const n = parseInt(t, 10);
    return n >= 1 && n <= 28 ? n : null;
  }
  return undefined;
}
// "" → undefined (leave as is); a number ≥ 0; NaN when it isn't one
function numVal(s) {
  const t = String(s || "").replace(/[$,\s]/g, "");
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
// 2027-03-31, 31/03/2027, 31-3-27, 03/2027 or 2027-03 (→ last day of that month). null when it can't be read.
function parseExpiry(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  const key = (y, mo, d) => {
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  const lastOf = (y, mo) => (mo >= 1 && mo <= 12 ? key(y, mo, new Date(y, mo, 0).getDate()) : null);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return key(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) return key(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return lastOf(+m[2], +m[1]);
  m = /^(\d{4})[/.-](\d{1,2})$/.exec(t);
  if (m) return lastOf(+m[1], +m[2]);
  return null;
}

/* ---------- Export ---------- */

export function downloadImportTemplate() {
  downloadCsv("product-import-template.csv", [COLS.map((c) => c.label), ...EXAMPLES.map((e) => COLS.map((c) => e[c.key] || ""))]);
}

export function exportProductsCsv(products, suppliers) {
  const supName = (id) => (suppliers.find((s) => s.id === id) || {}).name || "";
  const freq = { never: "Never", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
  const where = { both: "Both", shelf: "Shelf", jt: "JT" };
  const rows = products.map((p) => ({
    name: p.name, category: catLabel(p.category), brand: p.brand, supplier: supName(p.supplierId), supplierCode: p.supplierCode,
    altSuppliers: productSuppliers(p).filter((t) => !t.main).map((t) => {
      const parts = [supName(t.supplierId), t.supplierCode, t.cost ?? ""].map(String);
      while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
      return parts.join(" | ");
    }).join("; "),
    barcode: p.barcode, stockUnit: p.stockUnit, dosePer: p.dosePer ?? "", doseUnit: p.doseUnit, orderUnit: p.orderUnit,
    packSize: p.packSize, usage: p.usage === "kit" ? "Kit" : "Shelf", cost: p.cost ?? "", price: p.price ?? "",
    tracked: p.tracked ? "Yes" : "No", batchLabel: p.batchLabel === "Batch" ? "" : p.batchLabel,
    reShelf: p.reorder.shelf ?? "", reJt: p.reorder.jt ?? "", countFreq: freq[p.countFreq] || "Never",
    countDay: p.countFreq === "weekly" ? WEEKDAYS[p.countDay] || "" : p.countFreq === "monthly" ? (p.countDay === "last" ? "Last" : String(p.countDay ?? "")) : "",
    countWhere: p.countFreq === "never" ? "" : where[p.countWhere] || "Both", active: p.active ? "Yes" : "No", notes: p.notes,
  }));
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  downloadCsv(`products-${stamp}.csv`, [COLS.map((c) => c.label), ...rows.map((r) => COLS.map((c) => r[c.key] ?? ""))]);
}

/* ---------- Working out what an import will do ---------- */

function buildPlan(text, products, suppliers, opts) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("The file has no products in it. It needs a heading row and at least one product.");
  if (rows.length - 1 > MAX_ROWS) throw new Error(`That's ${rows.length - 1} rows. Import up to ${MAX_ROWS} at a time.`);
  const head = rows[0].map(norm);
  const idx = {};
  COLS.forEach((c) => {
    const names = [c.label, ...(c.alias || [])].map(norm);
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0) idx[c.key] = i;
  });
  if (idx.name === undefined) throw new Error('Couldn\'t find a "Name" column. Download the template to see the headings.');
  const ignored = rows[0].filter((h, i) => String(h).trim() && !Object.values(idx).includes(i));

  const byName = new Map(products.map((p) => [norm(p.name), p]));
  const supByName = new Map(suppliers.map((s) => [norm(s.name), s]));
  const items = new Map();
  const newSuppliers = new Map();
  let blankNames = 0;

  rows.slice(1).forEach((row, r) => {
    const line = r + 2;
    const v = (k) => (idx[k] === undefined ? "" : String(row[idx[k]] ?? "").trim());
    const name = v("name").replace(/\s+/g, " ");
    if (!name) { blankNames++; return; }
    const key = norm(name);
    let it = items.get(key);
    const firstRow = !it;
    if (!it) {
      it = { line, name, existing: byName.get(key) || null, over: {}, rawDay: "", rawStock: [], errors: [], notes: [], newSupplier: "", supplierText: "" };
      items.set(key, it);
    }

    if (firstRow) {
      const put = (k, val) => { it.over[k] = val; };
      const label = (k) => COLS.find((c) => c.key === k).label;
      if (v("category")) {
        const c = catKey(v("category"));
        if (c) put("category", c); else it.notes.push(`Unknown category "${v("category")}"`);
      }
      ["brand", "supplierCode", "barcode", "stockUnit", "doseUnit", "orderUnit", "batchLabel", "notes"].forEach((k) => { if (v(k)) put(k, v(k)); });
      if (v("name") && it.existing && it.existing.name !== name) put("name", name);
      if (!it.existing) put("name", name);
      [["dosePer", false], ["cost", false], ["price", false], ["packSize", true]].forEach(([k, whole]) => {
        const n = numVal(v(k));
        if (n === undefined) return;
        if (Number.isNaN(n) || (whole && (!Number.isInteger(n) || n < 1))) it.errors.push(`${label(k)} "${v(k)}" isn't a valid number`);
        else put(k, n);
      });
      const reorder = {};
      [["reShelf", "shelf"], ["reJt", "jt"]].forEach(([k, loc]) => {
        const n = numVal(v(k));
        if (n === undefined) return;
        if (Number.isNaN(n) || !Number.isInteger(n)) it.errors.push(`${label(k)} "${v(k)}" isn't a whole number`);
        else reorder[loc] = n;
      });
      if (Object.keys(reorder).length) put("reorder", reorder);
      [["tracked", "tracked"], ["active", "active"]].forEach(([k, f]) => {
        if (!v(k)) return;
        const b = yesNo(v(k));
        if (b === null) it.errors.push(`${label(k)} should be Yes or No, not "${v(k)}"`); else put(f, b);
      });
      if (v("usage")) { const u = usageKey(v("usage")); if (u) put("usage", u); else it.errors.push(`Used from should be Shelf or Kit, not "${v("usage")}"`); }
      if (v("countFreq")) { const f = freqKey(v("countFreq")); if (f) put("countFreq", f); else it.errors.push(`Count should be Never, Daily, Weekly or Monthly, not "${v("countFreq")}"`); }
      if (v("countWhere")) { const w = whereKey(v("countWhere")); if (w) put("countWhere", w); else it.errors.push(`Count in should be Both, Shelf or JT, not "${v("countWhere")}"`); }
      if (v("altSuppliers")) {
        if (/^(none|-)$/i.test(v("altSuppliers"))) put("altSuppliers", []);
        else {
          const alts = [];
          v("altSuppliers").split(";").map((x) => x.trim()).filter(Boolean).forEach((part) => {
            const [nm = "", code = "", cost = ""] = part.split("|").map((x) => x.trim());
            if (!nm) return;
            const c = numVal(cost);
            if (Number.isNaN(c)) { it.errors.push(`Other suppliers: price "${cost}" for ${nm} isn't a number`); return; }
            const s = supByName.get(norm(nm));
            if (!s && !opts.createSuppliers) { it.notes.push(`Other supplier "${nm}" isn't in the list, left out`); return; }
            if (!s) newSuppliers.set(norm(nm), nm);
            // Keep a different pack already set in the product editor for this supplier
            const prev = it.existing && s ? (it.existing.altSuppliers || []).find((a) => a.supplierId === s.id) : null;
            alts.push({
              supplierId: s ? s.id : "", pendingName: s ? "" : nm,
              supplierCode: code || (prev && prev.supplierCode) || "",
              cost: c === undefined ? (prev ? prev.cost : null) : c,
              orderUnit: prev ? prev.orderUnit : "", packSize: prev ? prev.packSize : null,
            });
          });
          put("altSuppliers", alts);
        }
      }
      it.rawDay = v("countDay");
      if (v("supplier")) {
        it.supplierText = v("supplier");
        const s = supByName.get(norm(v("supplier")));
        if (s) put("supplierId", s.id);
        else if (opts.createSuppliers) { it.newSupplier = v("supplier"); newSuppliers.set(norm(v("supplier")), v("supplier")); }
        else it.notes.push(`Supplier "${v("supplier")}" isn't in the list, left blank`);
      }
    }

    // Stock on this row (every row can add a batch)
    [["shelf", v("shelfQty")], ["jt", v("jtQty")]].forEach(([loc, raw]) => {
      if (!raw) return;
      const n = Number(raw.replace(/[,\s]/g, ""));
      if (!Number.isInteger(n) || n < 0) { it.stockErr = `Line ${line}: ${loc === "shelf" ? "Shelf" : "JT"} qty "${raw}" isn't a whole number`; return; }
      if (n > 0) it.rawStock.push({ loc, delta: n, batch: v("batch"), expiryRaw: v("expiry"), line });
    });
  });

  // Final product, status and opening stock for each
  const list = [...items.values()].map((it) => {
    const base = it.existing ? { ...it.existing } : { category: "general", active: true, tracked: false, usage: "storage", reorder: {} };
    delete base.id; delete base.stock; delete base.updatedAt;
    const data = { ...base, ...it.over, reorder: { ...(base.reorder || {}), ...(it.over.reorder || {}) } };
    if (!it.existing && !it.over.orderUnit) data.orderUnit = data.stockUnit || "item";
    const hasStock = !!it.existing && (it.existing.stock.shelf + it.existing.stock.jt) > 0;
    if (hasStock && it.over.tracked !== undefined && it.over.tracked !== it.existing.tracked) {
      data.tracked = it.existing.tracked;
      it.notes.push("Batch & expiry setting kept, because it already has stock");
    }
    if (it.rawDay) {
      const d = dayValue(it.rawDay, data.countFreq);
      if (d === null) it.errors.push(`Count day "${it.rawDay}" doesn't suit a ${data.countFreq} count`);
      else if (d !== undefined) data.countDay = d;
    }
    const clean = cleanProduct(data);
    if (clean.usage === "kit" && !clean.dosePer) it.errors.push("Kit products need an Amount in each (e.g. 100 units)");

    // Opening stock
    let stockOps = [];
    if (it.rawStock.length && !it.stockErr) {
      if (hasStock) it.stockSkip = "Already has stock, so opening stock isn't added. Use Count instead.";
      else if (clean.tracked) {
        for (const s of it.rawStock) {
          const exp = parseExpiry(s.expiryRaw);
          if (!s.batch || !exp) {
            it.stockErr = `Line ${s.line}: needs a ${clean.batchLabel.toLowerCase()} number and ${exp === null ? "a valid" : "an"} expiry date`;
            stockOps = [];
            break;
          }
          stockOps.push({ loc: s.loc, batch: s.batch, expiry: exp, delta: s.delta });
        }
      } else {
        const sum = { shelf: 0, jt: 0 };
        it.rawStock.forEach((s) => { sum[s.loc] += s.delta; });
        stockOps = ["shelf", "jt"].filter((l) => sum[l]).map((loc) => ({ loc, delta: sum[loc] }));
      }
    }
    const status = it.errors.length ? "error" : it.existing && !opts.update ? "skip" : it.existing ? "update" : "new";
    const stockText = stockOps.length
      ? ["shelf", "jt"].map((loc) => {
          const n = stockOps.filter((o) => o.loc === loc).reduce((a, o) => a + o.delta, 0);
          return n ? `${loc === "shelf" ? "Shelf" : "JT"} ${plural(n, clean.stockUnit)}` : "";
        }).filter(Boolean).join(" · ") + (clean.tracked ? ` (${new Set(stockOps.map((o) => o.batch)).size} ${clean.batchLabel.toLowerCase()}${new Set(stockOps.map((o) => o.batch)).size === 1 ? "" : "s"})` : "")
      : "";
    return { ...it, data, clean, status, stockOps, stockText };
  });

  return { items: list, newSuppliers: [...newSuppliers.values()], ignored, blankNames };
}

/* ---------- Saving ---------- */

async function runImport(plan, staff, onProgress) {
  const todo = plan.items.filter((it) => it.status === "new" || it.status === "update");
  const res = { created: 0, updated: 0, stocked: 0, failed: [] };
  const supIds = new Map();
  for (const name of plan.newSuppliers) {
    if (!todo.some((it) => norm(it.newSupplier) === norm(name)
      || (it.data.altSuppliers || []).some((a) => a.pendingName && norm(a.pendingName) === norm(name)))) continue;
    try { supIds.set(norm(name), await saveSupplier("", { name, active: true }, staff)); }
    catch (err) { res.failed.push({ name: `Supplier ${name}`, line: "", msg: errText(err) }); }
  }
  let done = 0;
  const one = async (it) => {
    let id = it.existing ? it.existing.id : "";
    try {
      const data = { ...it.data };
      if (it.newSupplier) data.supplierId = supIds.get(norm(it.newSupplier)) || "";
      data.altSuppliers = (data.altSuppliers || []).map((a) => (a.pendingName
        ? { ...a, supplierId: supIds.get(norm(a.pendingName)) || "" } : a));
      id = await saveProduct(id, data, staff);
      if (it.existing) res.updated++; else res.created++;
    } catch (err) {
      res.failed.push({ name: it.name, line: it.line, msg: errText(err) });
      onProgress(++done, todo.length);
      return;
    }
    if (it.stockOps.length) {
      try {
        await applyStock({ id, ...it.clean }, { type: "add", ops: it.stockOps, reason: "Opening balance", note: "Imported" }, staff);
        res.stocked++;
      } catch (err) {
        res.failed.push({ name: it.name, line: it.line, msg: `Product saved, but the opening stock wasn't: ${errText(err)}` });
      }
    }
    onProgress(++done, todo.length);
  };
  // A few at a time: quick, without hammering Firestore
  const queue = todo.slice();
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) await one(queue.shift());
  }));
  return res;
}

/* ---------- The window ---------- */

export function openProductImport({ products, suppliers, staff, onDone }) {
  const st = { plan: null, text: "", fileName: "", opts: { update: true, createSuppliers: true }, onlyProblems: false, busy: false, finished: false };
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg inv-imp";
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => { dlg.remove(); if (st.finished && onDone) onDone(); });
  dlg.addEventListener("cancel", (e) => { if (st.busy) e.preventDefault(); });

  const STATUS = { new: ["is-ok", "New"], update: ["is-info", "Update"], skip: ["", "Skip"], error: ["is-bad", "Problem"] };

  function rebuild() {
    if (!st.text) return;
    try { st.plan = buildPlan(st.text, products, suppliers, st.opts); st.err = ""; }
    catch (err) { st.plan = null; st.err = err.message || "Couldn't read that file."; }
  }

  function previewHtml() {
    const p = st.plan;
    const n = (s) => p.items.filter((it) => it.status === s).length;
    const stocked = p.items.filter((it) => it.stockOps.length && (it.status === "new" || it.status === "update")).length;
    const problems = (it) => it.status === "error" || it.stockErr || it.notes.length || it.stockSkip;
    const rows = (st.onlyProblems ? p.items.filter(problems) : p.items);
    const go = n("new") + n("update");
    return `
      <div class="inv-stats">
        <div class="inv-stat"><strong>${n("new")}</strong><span>New products</span></div>
        <div class="inv-stat"><strong>${n("update")}</strong><span>To update</span></div>
        <div class="inv-stat"><strong>${stocked}</strong><span>With opening stock</span></div>
        <div class="inv-stat ${n("error") ? "is-bad" : ""}"><strong>${n("error")}</strong><span>With problems</span></div>
      </div>
      ${p.newSuppliers.length && st.opts.createSuppliers ? `<p class="inv-hint">New suppliers to create: <strong>${esc(p.newSuppliers.join(", "))}</strong>. Add their emails later in Suppliers.</p>` : ""}
      ${p.ignored.length ? `<p class="inv-hint">Columns not used: ${esc(p.ignored.join(", "))}</p>` : ""}
      ${p.blankNames ? `<p class="inv-hint">${p.blankNames} row${p.blankNames === 1 ? "" : "s"} without a name ${p.blankNames === 1 ? "was" : "were"} left out.</p>` : ""}
      <label class="fe-check"><input type="checkbox" data-f="onlyProblems"${st.onlyProblems ? " checked" : ""} /> Only show rows with something to check</label>
      <div class="inv-imp-scroll"><table class="inv-table">
        <thead><tr><th>Line</th><th>Product</th><th>Category</th><th>Supplier</th><th></th><th>Opening stock</th><th>Notes</th></tr></thead>
        <tbody>${rows.slice(0, 400).map((it) => {
          const [cls, label] = STATUS[it.status];
          const notes = [...it.errors, it.stockErr, it.stockSkip, ...it.notes].filter(Boolean);
          return `<tr class="${it.status === "error" ? "is-diff" : ""}">
            <td>${it.line}</td><td><strong>${esc(it.clean.name || it.name)}</strong></td>
            <td>${esc(catLabel(it.clean.category))}</td>
            <td>${esc(it.supplierText || (suppliers.find((s) => s.id === it.clean.supplierId) || {}).name || "—")}${it.newSupplier && st.opts.createSuppliers ? ' <small class="muted">(new)</small>' : ""}</td>
            <td><span class="inv-flag ${cls}">${label}</span></td>
            <td>${esc(it.stockText || "—")}</td>
            <td>${notes.length ? `<small class="${it.status === "error" || it.stockErr ? "rp-neg" : "muted"}">${notes.map(esc).join("<br>")}</small>` : ""}</td></tr>`;
        }).join("") || '<tr><td colspan="7"><small class="muted">Nothing to check. 👍</small></td></tr>'}</tbody></table></div>
      ${rows.length > 400 ? `<p class="inv-hint">Showing the first 400 rows.</p>` : ""}
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="restart">Choose another file</button>
        <button type="button" class="lh-btn is-primary" data-act="import"${go ? "" : " disabled"}>Import ${go} product${go === 1 ? "" : "s"}</button>
      </div>`;
  }

  function draw() {
    if (st.finished) return;
    dlg.innerHTML = `
      <div class="lh-form">
        <div class="lh-dialog-head"><h3>Import products</h3>
          <p>Add many products at once, with their opening stock, from a CSV file (Excel: <em>File → Save As → CSV</em>).</p></div>
        ${st.plan ? `<p class="inv-imp-file"><strong>${esc(st.fileName)}</strong></p>` : `
          <div class="inv-imp-start">
            <button type="button" class="lh-btn" data-act="template">Download template</button>
            <label class="lh-btn is-primary inv-imp-pick">Choose CSV file<input type="file" accept=".csv,text/csv" data-role="file" hidden /></label>
          </div>
          <details class="inv-imp-help"><summary>What goes in each column</summary>
            <ul>
              <li><strong>Name</strong> is the only required column. A name that matches an existing product updates it; blank cells leave its details as they are.</li>
              <li><strong>Category</strong>: ${INV_CATEGORIES.map((c) => esc(c.label)).join(", ")}.</li>
              <li><strong>Supplier</strong> is the main one. <strong>Other suppliers</strong>: <em>Name | their code | their price</em>, several separated by <em>;</em> (code and price optional). Type <em>None</em> to clear them.</li>
              <li><strong>Given as</strong> what staff take off the Shelf (vial, syringe, needle). <strong>Bought as</strong> and <strong>Pack size</strong> when it comes boxed (box of 100).</li>
              <li><strong>Amount in each</strong> and <strong>Measured in</strong> for injectables (100 units, 1 mL). <strong>Used from</strong>: Shelf, or Kit for products carried in injectors' kits.</li>
              <li><strong>Batch and expiry</strong>: Yes or No. <strong>Count</strong>: Never, Daily, Weekly (Count day: Monday…) or Monthly (Count day: 1–28 or Last).</li>
              <li><strong>Shelf qty / JT qty</strong> add opening stock. For batch &amp; expiry products, fill in <strong>Batch</strong> and <strong>Expiry</strong>, one row per batch, repeating the name.</li>
              <li>Opening stock is only added to products that have no stock yet, so importing again never doubles it.</li>
            </ul></details>`}
        <div class="inv-imp-opts">
          <label class="fe-check"><input type="checkbox" data-f="update"${st.opts.update ? " checked" : ""} /> Update products that already exist (matched by name)</label>
          <label class="fe-check"><input type="checkbox" data-f="createSuppliers"${st.opts.createSuppliers ? " checked" : ""} /> Create suppliers that aren't in the list yet</label>
        </div>
        ${st.err ? `<p class="lh-error" role="alert">${esc(st.err)}</p>` : ""}
        ${st.plan ? previewHtml() : `<div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Cancel</button></div>`}
      </div>`;
  }

  async function doImport() {
    st.busy = true;
    const total = st.plan.items.filter((it) => it.status === "new" || it.status === "update").length;
    dlg.innerHTML = `<div class="lh-form"><div class="lh-dialog-head"><h3>Importing…</h3><p>Keep this window open until it finishes.</p></div>
      <div class="inv-imp-bar"><span data-role="bar" style="width:0%"></span></div><p class="muted" data-role="prog">0 of ${total}</p></div>`;
    const bar = dlg.querySelector('[data-role="bar"]');
    const prog = dlg.querySelector('[data-role="prog"]');
    const res = await runImport(st.plan, staff, (d, t) => {
      bar.style.width = `${Math.round((d / Math.max(1, t)) * 100)}%`;
      prog.textContent = `${d} of ${t}`;
    });
    st.busy = false;
    st.finished = true;
    dlg.innerHTML = `<div class="lh-form">
      <div class="lh-dialog-head"><h3>${res.failed.length ? "Import finished, with some problems" : "Import finished 🎉"}</h3></div>
      <div class="inv-stats">
        <div class="inv-stat"><strong>${res.created}</strong><span>Created</span></div>
        <div class="inv-stat"><strong>${res.updated}</strong><span>Updated</span></div>
        <div class="inv-stat"><strong>${res.stocked}</strong><span>Opening stock added</span></div>
        <div class="inv-stat ${res.failed.length ? "is-bad" : ""}"><strong>${res.failed.length}</strong><span>Not saved</span></div>
      </div>
      ${res.failed.length ? `<ul class="inv-imp-fail">${res.failed.map((f) => `<li><strong>${esc(f.name)}</strong>${f.line ? ` (line ${f.line})` : ""}: ${esc(f.msg)}</li>`).join("")}</ul>
        <p class="inv-hint">Fix these rows in your file and import it again. Products that were saved are matched by name, and get no extra stock.</p>` : ""}
      <div class="lh-actions"><button type="button" class="lh-btn is-primary" data-act="close">Done</button></div></div>`;
  }

  dlg.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a || st.busy) return;
    const act = a.dataset.act;
    if (act === "close") dlg.close();
    else if (act === "template") downloadImportTemplate();
    else if (act === "restart") { st.plan = null; st.text = ""; st.err = ""; draw(); }
    else if (act === "import" && st.plan) doImport();
  });
  dlg.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.role === "file" && t.files && t.files[0]) {
      const f = t.files[0];
      if (f.size > 5 * 1024 * 1024) { st.err = "That file is too big (over 5 MB). Split it into smaller files."; draw(); return; }
      st.fileName = f.name;
      st.text = await f.text();
      if (/\.xlsx?$/i.test(f.name)) { st.text = ""; st.err = "That's an Excel file. In Excel use File → Save As → CSV, then choose the CSV."; draw(); return; }
      rebuild();
      draw();
      return;
    }
    const k = t.dataset.f;
    if (k === "update" || k === "createSuppliers") { st.opts[k] = t.checked; rebuild(); draw(); }
    else if (k === "onlyProblems") { st.onlyProblems = t.checked; draw(); }
  });

  draw();
  dlg.showModal();
}