// Skin Script builder: each product's Shelf stock, from Inventory.
// Skin Script products aren't linked to Inventory, so they're matched by name (and size):
// "Dermedica Essential Cleanser" + "125mL" = "Dermedica Essential Cleanser 125 mL". Capitals, spaces and dashes don't matter.
// It never guesses: two Inventory products with the same name, or one name in several sizes without the size, aren't matched.
import { listProducts, listCounts, dayKey } from "./inventory-api.js";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Map of Skin Script product id → { productId, name, shelf, unit, reorder, countedKey }
export async function sspShelfStock(sspProducts) {
  const [inv, counts] = await Promise.all([
    listProducts(),
    listCounts({ from: dayKey(new Date(Date.now() - 180 * 864e5)) }).catch((err) => {
      console.warn("Skin Script stock: counts not loaded:", err);
      return [];
    }),
  ]);

  // Inventory products by name (null = two share it, so neither is used)
  const byName = new Map();
  inv.filter((p) => p.active).forEach((p) => {
    const k = norm(p.name);
    byName.set(k, byName.has(k) ? null : p);
  });

  // How many sizes each Skin Script name comes in (one size: the name alone may match)
  const sizes = new Map();
  sspProducts.forEach((s) => { const k = norm(s.name); sizes.set(k, (sizes.get(k) || 0) + 1); });

  // The last opening count with this product on the Shelf (counts come newest first)
  const lastCount = new Map();
  counts.filter((c) => c.kind === "opening" && !c.superseded).forEach((c) => {
    c.lines.forEach((l) => {
      if (l.loc === "shelf" && l.productId && !lastCount.has(l.productId)) lastCount.set(l.productId, c.dateKey);
    });
  });

  const out = new Map();
  sspProducts.forEach((s) => {
    const p = byName.get(norm(`${s.name} ${s.size}`))
      || (sizes.get(norm(s.name)) === 1 ? byName.get(norm(s.name)) : null);
    if (!p) return;
    out.set(s.id, {
      productId: p.id, name: p.name, shelf: p.stock.shelf, unit: p.stockUnit,
      reorder: p.reorder ? p.reorder.shelf : null, countedKey: lastCount.get(p.id) || "",
    });
  });
  return out;
}