// Skin Script builder: each product's Shelf stock, from Inventory.
// A Skin Script product linked in Products Config (invProductId) always uses that Inventory product.
// Not linked: matched by name (and size), e.g. "Dermedica Essential Cleanser" + "125mL" = "Dermedica Essential Cleanser 125 mL".
// The name match never guesses: two Inventory products with the same name, or one name in several sizes without the size, aren't matched.
import { listProducts, listCounts, dayKey } from "./inventory-api.js";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// How many were physically counted on a count line
const QTY_FIELDS = ["counted", "qty", "count", "n", "actual", "units"];
let warned = false;
function countedQty(l) {
  for (const k of QTY_FIELDS) {
    if (l[k] === undefined || l[k] === null || l[k] === "") continue;
    const v = Number(l[k]);
    if (Number.isFinite(v)) return v;
  }
  if (!warned) {   // tells us the real field name if it's none of the above
    warned = true;
    console.warn("Skin Script stock: no counted number found on a count line. Its fields are:", Object.keys(l));
  }
  return null;
}
const countMs = (c) => {
  const v = c.at || c.createdAt || c.savedAt || c.doneAt;
  if (v && typeof v.toMillis === "function") return v.toMillis();
  return Date.parse(v) || 0;
};

// → (sspProduct) => { product, how: "link" | "name" | "broken" | "none" }
export function inventoryMatcher(sspProducts, invProducts) {
  const byId = new Map(invProducts.map((p) => [p.id, p]));
  const byName = new Map();   // null = two share the name, so neither is used
  invProducts.filter((p) => p.active).forEach((p) => {
    const k = norm(p.name);
    byName.set(k, byName.has(k) ? null : p);
  });
  const sizes = new Map();    // how many sizes each Skin Script name comes in
  sspProducts.forEach((s) => { const k = norm(s.name); sizes.set(k, (sizes.get(k) || 0) + 1); });

  return (s) => {
    if (s.invProductId) {
      const p = byId.get(s.invProductId);
      return p && p.active ? { product: p, how: "link" } : { product: null, how: "broken" };
    }
    const p = byName.get(norm(`${s.name} ${s.size}`))
      || (sizes.get(norm(s.name)) === 1 ? byName.get(norm(s.name)) : null);
    return p ? { product: p, how: "name" } : { product: null, how: "none" };
  };
}

// Map of Skin Script product id → { productId, name, counted, countedKey, countedBy, unit, reorder, how } or { broken: true }.
// counted = what staff physically counted on the Shelf in the latest opening count (null = not counted in 6 months).
export async function sspShelfStock(sspProducts) {
  const [inv, counts] = await Promise.all([
    listProducts(),
    listCounts({ from: dayKey(new Date(Date.now() - 180 * 864e5)) }).catch((err) => {
      console.warn("Skin Script stock: counts not loaded:", err);
      return [];
    }),
  ]);
  const match = inventoryMatcher(sspProducts, inv);

  // Opening counts, newest first (two on one day: the later one)
  const opening = counts.filter((c) => c.kind === "opening" && !c.superseded)
    .sort((a, b) => String(b.dateKey).localeCompare(String(a.dateKey)) || countMs(b) - countMs(a));

  // Each product's Shelf total in the newest opening count that has it
  const lastCount = new Map();   // productId → { qty, dateKey, by }
  opening.forEach((c) => {
    const here = new Map();      // this count's Shelf total per product (a product can be on several lines)
    (c.lines || []).forEach((l) => {
      if (l.loc !== "shelf" || !l.productId || lastCount.has(l.productId)) return;
      const q = countedQty(l);
      if (q === null) return;
      here.set(l.productId, (here.get(l.productId) || 0) + q);
    });
    here.forEach((qty, id) => lastCount.set(id, {
      qty, dateKey: c.dateKey, by: String(c.byName || c.staffName || c.createdBy || c.by || ""),
    }));
  });

  const out = new Map();
  sspProducts.forEach((s) => {
    const m = match(s);
    if (m.how === "broken") { out.set(s.id, { broken: true }); return; }
    if (!m.product) return;
    const p = m.product;
    const lc = lastCount.get(p.id) || null;
    out.set(s.id, {
      productId: p.id, name: p.name, unit: p.stockUnit, how: m.how,
      counted: lc ? lc.qty : null, countedKey: lc ? lc.dateKey : "", countedBy: lc ? lc.by : "",
      reorder: p.reorder ? p.reorder.shelf : null,
    });
  });
  return out;
}