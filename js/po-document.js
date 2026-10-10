// A purchase order as a PDF (made in the browser, like the forms).
import { poTotals, plural } from "./inventory-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "";
};
// Under the item name: "Box of 5 vials · 100 units per vial"
const packSub = (l) => {
  const pack = l.packSize > 1 ? `${l.orderUnit} of ${plural(l.packSize, l.stockUnit)}` : "";
  const dose = l.dosePer && l.doseUnit ? `${l.dosePer} ${l.doseUnit} per ${l.stockUnit}` : "";
  const t = [pack, dose].filter(Boolean).join(" · ");
  return t ? `<div class="po-sub">${esc(t)}</div>` : "";
};

const CSS = `
  .pdfdoc { width: 703px; font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; color: #1e293b; background: #fff; }
  .pdfdoc * { box-sizing: border-box; }
  .pdfdoc table { border-collapse: collapse; }
  .pdfdoc .po-head { width: 100%; border-bottom: 2px solid #0f766e; margin-bottom: 14px; }
  .pdfdoc .po-head td { vertical-align: top; padding: 0 0 12px; }
  .pdfdoc .po-clinic { font-family: Georgia, serif; font-size: 15pt; margin-top: 4px; }
  .pdfdoc .po-addr { font-size: 8.5pt; color: #64748b; line-height: 1.5; margin-top: 2px; }
  .pdfdoc .po-t { font-size: 18pt; font-weight: bold; color: #0f766e; }
  .pdfdoc .po-n { font-size: 12pt; font-weight: bold; margin-top: 2px; }
  .pdfdoc .po-d { font-size: 9pt; color: #64748b; }
  .pdfdoc .po-parties { width: 100%; margin-bottom: 16px; }
  .pdfdoc .po-parties td { width: 50%; vertical-align: top; padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 9.5pt; line-height: 1.5; }
  .pdfdoc .po-k { font-size: 8pt; font-weight: bold; letter-spacing: .06em; text-transform: uppercase; color: #64748b; margin-bottom: 3px; }
  .pdfdoc .po-items { width: 100%; font-size: 9.5pt; }
  .pdfdoc .po-items th { background: #0f766e; color: #fff; padding: 6px 8px; text-align: left; font-size: 8.5pt; }
  .pdfdoc .po-items td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .pdfdoc .r { text-align: right !important; }
  .pdfdoc .po-sub { font-size: 8pt; color: #64748b; }
  .pdfdoc .po-tot { font-size: 10pt; }
  .pdfdoc .po-tot td { padding: 4px 8px; }
  .pdfdoc .po-grand td { border-top: 2px solid #0f766e; font-weight: bold; font-size: 11.5pt; padding-top: 6px; }
  .pdfdoc .po-tbc { font-size: 8.5pt; color: #92400e; margin: 8px 0 0; }
  .pdfdoc .po-box { margin-top: 14px; padding: 10px 12px; border: 1px solid #e2e8f0; font-size: 9.5pt; line-height: 1.5; }
  .pdfdoc .po-foot { margin-top: 18px; font-size: 8.5pt; color: #64748b; }
`;

export function buildPoDocument({ po, letterhead: lh = {} }) {
  const t = poTotals(po);
  const s = po.supplier || {};
  const date = (po.sentAt || po.createdAt || new Date()).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const logo = LOGO_RE.test(lh.logo || "")
    ? `<img src="${lh.logo}" alt="" style="display:inline-block !important;height:52px !important;width:auto !important;max-width:none !important;">` : "";
  const clinic = lh.name || "Dermedica";
  const inner = `
    <table class="po-head"><tr>
      <td>${logo}${lh.showName !== false ? `<div class="po-clinic">${esc(clinic)}</div>` : ""}
        <div class="po-addr">${[lh.line1, lh.line2].filter(Boolean).map(esc).join("<br>")}</div></td>
      <td class="r"><div class="po-t">Purchase order</div><div class="po-n">${esc(po.number)}</div><div class="po-d">${esc(date)}</div></td>
    </tr></table>
    <table class="po-parties"><tr>
      <td><div class="po-k">Supplier</div><strong>${esc(s.name)}</strong>${
        [s.contactName && `Attn: ${s.contactName}`, s.email, s.phone, s.address].filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join("")}${
        s.accountNo ? `<div>Our account: ${esc(s.accountNo)}</div>` : ""}</td>
      <td><div class="po-k">Deliver to</div><strong>${esc(clinic)}</strong>${lh.line1 ? `<div>${esc(lh.line1)}</div>` : ""}${
        po.expectedDate ? `<div class="po-k" style="margin-top:8px">Needed by</div><div>${esc(niceDate(po.expectedDate))}</div>` : ""}</td>
    </tr></table>
    <table class="po-items"><thead><tr><th>#</th><th>Item</th><th>Code</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Total</th></tr></thead><tbody>
      ${po.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}${packSub(l)}</td>
        <td>${esc(l.supplierCode || "")}</td><td class="r">${esc(plural(l.qty, l.orderUnit))}</td>
        <td class="r">${l.unitCost === null ? "" : money(l.unitCost)}</td><td class="r">${l.unitCost === null ? "" : money(l.unitCost * l.qty)}</td></tr>`).join("")}
    </tbody></table>
    <table class="po-tot" style="width:46%;margin:10px 0 0 auto;">
      <tr><td>Subtotal</td><td class="r">${money(t.subtotal)}</td></tr>
      ${po.gst ? `<tr><td>GST (10%)</td><td class="r">${money(t.gst)}</td></tr>` : ""}
      <tr class="po-grand"><td>Total${po.gst ? " (inc. GST)" : ""}</td><td class="r">${money(t.total)}</td></tr>
    </table>
    ${t.missing ? '<p class="po-tbc">Prices to be confirmed for items without a unit price.</p>' : ""}
    ${po.notesToSupplier ? `<div class="po-box"><div class="po-k">Notes</div>${esc(po.notesToSupplier).replace(/\n/g, "<br>")}</div>` : ""}
    <p class="po-foot">Please confirm this order and the expected delivery date. Ordered by ${esc(po.sentBy || po.createdBy || clinic)}.</p>`;
  const fileName = `${po.number} - ${s.name || "Supplier"}.pdf`.replace(/[\\/:*?"<>|]+/g, "-");
  const previewHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(fileName)}</title><style>
    body { margin: 0; background: #e2e8f0; }
    .page { width: 703px; margin: 24px auto; padding: 45px; background: #fff; box-shadow: 0 4px 24px rgba(15, 23, 42, .15); }
    ${CSS}
  </style></head><body><div class="page"><div class="pdfdoc">${inner}</div></div></body></html>`;
  return { inner, css: CSS, fileName, previewHtml };
}