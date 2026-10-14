// Product prescriptions the Scanner can match to. Names must be EXACTLY as they should appear on the patient's
// Product Prescriptions card. Gemini can only choose from this list; anything else is left for staff to pick.
// "Fading Cream" is always used for compounds with HQ, kojic acid, ascorbic acid or dexamethasone.
export const RX_PRODUCTS = [
  "Fading Cream",
  // Paste the rest here, one per line, e.g.
  // "Epiduo",
  // "Tranexamic Acid",
  // "Panadeine",
];

export const rxProductList = () => [...new Set(RX_PRODUCTS.map((s) => String(s || "").trim()).filter(Boolean))];