// Deliveries on a purchase order: every receipt, with its docket, who received it and where stock was put away.
import { listReceipts, plural, locLabel } from "./inventory-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (d) => (d ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const niceKey = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
// Only https links (Firebase Storage) are shown as dockets
const safeUrl = (u) => (/^https:\/\//i.test(String(u || "")) ? String(u) : "");

// po: the purchase order (id, status, lines). labelOf(productId) → "Batch" / "Lot"…
// canReceive: show a "Receive delivery" button while the order is open
export async function renderDeliveries(box, po, { labelOf = () => "Batch", canReceive = false } = {}) {
  box.innerHTML = '<section class="tb-card po-dv"><h4>Deliveries</h4><p class="tb-none">Loading…</p></section>';
  let receipts = [];
  try {
    receipts = await listReceipts(po.id);
  } catch (err) {
    console.error("Deliveries failed:", err);
    if (box.isConnected) box.innerHTML = `<section class="tb-card po-dv"><h4>Deliveries</h4>
      <p class="tb-none tb-bad">${err && err.code === "permission-denied"
        ? "You don't have access to see deliveries." : "Couldn't load the deliveries. Try again."}</p></section>`;
    return;
  }
  if (!box.isConnected) return;

  const open = ["sent", "part"].includes(po.status);
  const ordered = po.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  const arrived = po.lines.reduce((a, l) => a + Math.min(Number(l.received) || 0, Number(l.qty) || 0), 0);
  const waiting = po.lines.filter((l) => (Number(l.received) || 0) < (Number(l.qty) || 0));

  const splitText = (l, s) => [
    `${locLabel(s.loc)} ${plural(s.qty, l.stockUnit)}`,
    s.batch ? `${labelOf(l.productId)} ${s.batch}` : "",
    s.expiry ? `exp ${niceKey(s.expiry)}` : "",
  ].filter(Boolean).join(" · ");

  const docketHtml = (r) => {
    const url = r.docket && safeUrl(r.docket.url);
    if (!url) return "";
    return r.docket.type === "pdf"
      ? `<a class="po-dv-doc" href="${esc(url)}" target="_blank" rel="noopener">📄 Docket (PDF)</a>`
      : `<a class="po-dv-doc" href="${esc(url)}" target="_blank" rel="noopener" title="Open the docket photo">
           <img src="${esc(url)}" alt="Docket photo" loading="lazy" /></a>`;
  };

  const card = (r, i) => `
    <article class="po-dv-item">
      <div class="po-dv-head">
        <strong>Delivery ${receipts.length - i}</strong>
        <span>${esc(r.historical ? niceKey(String(r.receivedAt || "").slice(0, 10)) : when(r.receivedAt ? new Date(r.receivedAt) : r.at))}${
          (r.receivedBy || (!r.historical && r.by)) ? ` · received by ${esc(r.receivedBy || r.by)}` : ""}${
          r.historical && r.by ? ` · recorded by ${esc(r.by)}` : ""}${
          !r.historical && r.receivedBy && r.by && r.receivedBy !== r.by ? ` · entered by ${esc(r.by)}` : ""}</span>
        ${r.historical ? '<span class="inv-flag is-info">Before the portal</span>' : ""}
        ${r.docketNo ? `<span class="inv-flag is-info">Docket ${esc(r.docketNo)}</span>` : ""}
        ${r.closed ? '<span class="inv-flag is-warn">Closed short</span>' : ""}
      </div>
      <div class="po-dv-body">
        <table class="inv-table"><thead><tr><th>Product</th><th>Arrived</th><th>Put away</th></tr></thead><tbody>${
          (r.lines || []).map((l) => `<tr>
            <td>${esc(l.name || "")}</td>
            <td>${esc(plural(Number(l.arrived) || 0, l.orderUnit || "unit"))}${
              Number(l.packSize) > 1 ? ` <small class="muted">(${esc(plural((Number(l.arrived) || 0) * Number(l.packSize), l.stockUnit))})</small>` : ""}</td>
            <td>${(l.splits || []).length ? (l.splits || []).map((s) => `<div>${esc(splitText(l, s))}</div>`).join("")
              : r.historical ? '<small class="muted">Recorded only, stock not changed</small>' : '<small class="muted">Not a stock item</small>'}</td></tr>`).join("")
          || '<tr><td colspan="3"><small class="muted">Order closed without stock</small></td></tr>'}</tbody></table>
        ${docketHtml(r)}
      </div>
      ${r.note ? `<p class="po-dv-note">“${esc(r.note)}”</p>` : ""}
    </article>`;

  box.innerHTML = `
    <section class="tb-card po-dv">
      <div class="po-dv-top">
        <h4>Deliveries <em>${receipts.length}</em></h4>
        ${po.status !== "draft" && po.status !== "cancelled" ? `<span class="muted">${arrived} of ${ordered} arrived</span>` : ""}
        <span class="inv-spacer"></span>
        ${canReceive && open ? `<a class="lh-btn is-primary" href="#/inventory/receive/${encodeURIComponent(po.id)}">Receive delivery</a>` : ""}
      </div>
      ${open && waiting.length ? `<p class="po-dv-wait"><strong>Still to come:</strong> ${waiting.map((l) =>
        esc(`${l.name} × ${plural((Number(l.qty) || 0) - (Number(l.received) || 0), l.orderUnit)}`)).join(" · ")}</p>` : ""}
      ${receipts.length ? receipts.map(card).join("")
        : `<p class="tb-none">${open ? "Nothing received yet." : "No deliveries were received on this order."}</p>`}
    </section>`;
}