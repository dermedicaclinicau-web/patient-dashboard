// A purchase order as a PDF (made in the browser, like the forms). No prices: the supplier confirms them.
import { plural } from "./inventory-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
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
  .pdfdoc table { display: table; }
  .pdfdoc .po-head { display: table; width: 100%; border-bottom: 2px solid #0f766e; margin-bottom: 14px; }
  .pdfdoc .po-head td { vertical-align: top; padding: 0 0 12px; }
  .pdfdoc .po-sub { display: block; }
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
  .pdfdoc .po-items td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .pdfdoc .po-items .c-n { width: 32px; color: #64748b; }
  .pdfdoc .po-items .c-code { width: 130px; }
  .pdfdoc .po-items .c-qty { width: 120px; white-space: nowrap; font-weight: bold; }
  .pdfdoc .r { text-align: right !important; }
  .pdfdoc .po-sub { font-size: 8pt; color: #64748b; }
  .pdfdoc .po-count { margin: 8px 0 0; font-size: 9pt; color: #64748b; text-align: right; }
  .pdfdoc .po-box { margin-top: 14px; padding: 10px 12px; border: 1px solid #e2e8f0; font-size: 9.5pt; line-height: 1.5; }
  .pdfdoc .po-foot { margin-top: 18px; font-size: 8.5pt; color: #64748b; }
`;

export function buildPoDocument({ po, letterhead: lh = {} }) {
  const s = po.supplier || {};
  const date = po.orderDate ? niceDate(po.orderDate)
    : (po.sentAt || po.createdAt || new Date()).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const logo = LOGO_RE.test(lh.logo || "")
    ? `<img src="${lh.logo}" alt="" style="display:inline-block !important;height:52px !important;width:auto !important;max-width:none !important;">` : "";
  const clinic = lh.name || "Dermedica";
  const lines = po.lines || [];
  const hasCode = lines.some((l) => String(l.supplierCode || "").trim());
  const n = lines.length;

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
    <table class="po-items"><thead><tr>
      <th class="c-n">#</th><th>Item</th>${hasCode ? '<th class="c-code">Code</th>' : ""}<th class="c-qty r">Qty</th>
    </tr></thead><tbody>
      ${lines.map((l, i) => `<tr><td class="c-n">${i + 1}</td><td>${esc(l.name)}${packSub(l)}</td>
        ${hasCode ? `<td class="c-code">${esc(l.supplierCode || "")}</td>` : ""}
        <td class="c-qty r">${esc(plural(l.qty, l.orderUnit))}</td></tr>`).join("")}
    </tbody></table>
    <p class="po-count">${n} item${n === 1 ? "" : "s"}</p>
    ${po.notesToSupplier ? `<div class="po-box"><div class="po-k">Notes</div>${esc(po.notesToSupplier).replace(/\n/g, "<br>")}</div>` : ""}
    <p class="po-foot">Please confirm this order, its pricing and the expected delivery date. Ordered by ${esc(po.sentBy || po.createdBy || clinic)}.</p>`;
  const fileName = `${po.number} - ${s.name || "Supplier"}.pdf`.replace(/[\\/:*?"<>|]+/g, "-");
  const previewHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(fileName)}</title><style>
    body { margin: 0; background: #e2e8f0; }
    .page { width: 793px; margin: 24px auto; padding: 45px; background: #fff; box-shadow: 0 4px 24px rgba(15, 23, 42, .15); box-sizing: border-box; }
    ${CSS}
  </style></head><body><div class="page"><div class="pdfdoc">${inner}</div></div></body></html>`;
  return { inner, css: CSS, fileName, previewHtml };
}