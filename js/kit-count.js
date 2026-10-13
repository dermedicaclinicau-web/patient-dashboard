// The kit question at Start and End of Day, one per kit product: "How many units remaining?"
// 0 (or nothing in the kit) → that's all. More than 0 → the batch number and expiry date from the label.
import { escapeHtml } from "./utils.js";

const esc = (s) => escapeHtml(String(s ?? ""));
const bl = (p) => (p && p.batchLabel) || "Batch";

// items: [{ p, batch, expiry }]: batch and expiry are filled in when known; the units never are
export function kitCountHtml(items) {
  return items.map(({ p, batch = "", expiry = "" }) => `
    <div class="kc" data-pid="${esc(p.id)}">
      <label class="kc-q">
        <span><strong>${esc(p.name)}</strong><small>How many ${esc(p.doseUnit)} remaining?</small></span>
        <span class="fe-num kc-units"><input class="fe-input" type="number" min="0" step="0.5" inputmode="decimal" data-f="units"
          aria-label="${esc(p.name)}: ${esc(p.doseUnit)} remaining" /><span>${esc(p.doseUnit)}</span></span>
      </label>
      ${p.tracked ? `<div class="kc-batch" hidden>
        <label class="lh-field"><span class="lh-label">${esc(bl(p))} #</span>
          <input class="fe-input sod-batch" data-f="batch" maxlength="40" autocomplete="off" spellcheck="false" placeholder="From the label" value="${esc(batch)}" /></label>
        <label class="lh-field"><span class="lh-label">Expiry date</span>
          <input class="fe-input" type="date" data-f="expiry" value="${esc(expiry)}" /></label>
      </div>` : ""}
    </div>`).join("");
}

// Shows the batch and expiry only once the units are more than 0
export function wireKitCount(root) {
  root.addEventListener("input", (e) => {
    if (e.target.dataset.f !== "units") return;
    const box = e.target.closest(".kc").querySelector(".kc-batch");
    if (box) box.hidden = !(Number(e.target.value) > 0);
  });
}

// { items: [{ productId, rows }] } (rows: [] when 0), or { error, focus }
export function readKitCount(root, products) {
  const items = [];
  for (const p of products) {
    const box = root.querySelector(`.kc[data-pid="${CSS.escape(p.id)}"]`);
    if (!box) continue;
    const f = (k) => box.querySelector(`[data-f="${k}"]`);
    const raw = f("units").value.trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n) || n < 0) {
      return { error: `${p.name}: enter how many ${p.doseUnit} remaining (0 if none).`, focus: f("units") };
    }
    if (!(n > 0)) { items.push({ productId: p.id, rows: [] }); continue; }
    let batch = "", expiry = "";
    if (p.tracked) {
      batch = f("batch").value.trim();
      expiry = f("expiry").value;
      if (!batch) return { error: `${p.name}: type the ${bl(p).toLowerCase()} number from the label.`, focus: f("batch") };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return { error: `${p.name}: enter the expiry date from the label.`, focus: f("expiry") };
    }
    items.push({ productId: p.id, rows: [{ batch, expiry, units: Math.round(n * 10) / 10, inUse: true }] });
  }
  return { items };
}