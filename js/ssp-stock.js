// Skin Script builder: each product's Shelf stock, from Inventory.
// A Skin Script product linked in Products Config (invProductId) always uses that Inventory product.
// Not linked: matched by name (and size), e.g. "Dermedica Essential Cleanser" + "125mL" = "Dermedica Essential Cleanser 125 mL".
// The name match never guesses: two Inventory products with the same name, or one name in several sizes without the size, aren't matched.
import { listProducts, listCounts, dayKey } from "./inventory-api.js";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

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

// Map of Skin Script product id → { productId, name, shelf, unit, reorder, countedKey, how } or { broken: true }
export async function sspShelfStock(sspProducts) {
  const [inv, counts] = await Promise.all([
    listProducts(),
    listCounts({ from: dayKey(new Date(Date.now() - 180 * 864e5)) }).catch((err) => {
      console.warn("Skin Script stock: counts not loaded:", err);
      return [];
    }),
  ]);
  const match = inventoryMatcher(sspProducts, inv);

  // The last opening count with this product on the Shelf (counts come newest first)
  const lastCount = new Map();
  counts.filter((c) => c.kind === "opening" && !c.superseded).forEach((c) => {
    c.lines.forEach((l) => {
      if (l.loc === "shelf" && l.productId && !lastCount.has(l.productId)) lastCount.set(l.productId, c.dateKey);
    });
  });

  const out = new Map();
  sspProducts.forEach((s) => {
    const m = match(s);
    if (m.how === "broken") { out.set(s.id, { broken: true }); return; }
    if (!m.product) return;
    const p = m.product;
    out.set(s.id, {
      productId: p.id, name: p.name, shelf: p.stock.shelf, unit: p.stockUnit,
      reorder: p.reorder ? p.reorder.shelf : null, countedKey: lastCount.get(p.id) || "", how: m.how,
    });
  });
  return out;
}