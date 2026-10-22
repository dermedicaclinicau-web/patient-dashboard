// Inventory → Invoice links: which Timely invoice product names are stock products,
// and the date invoices start taking stock off the Shelf.
import { listProducts, getInvoiceSettings, saveInvoiceSettings, invoiceNameKey, INVOICE_NOT_STOCK, INV_CATEGORIES } from "./inventory-api.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// unlinked: [{ name, lines }] from an upload, shown first. Resolves true when saved.
export async function openInvoiceLinks({ staff, unlinked = [] } = {}) {
  let products, cfg;
  try { [products, cfg] = await Promise.all([listProducts(), getInvoiceSettings()]); }
  catch (err) {
    console.error("Invoice links failed:", err);
    showToast(err && err.code === "permission-denied" ? "No access to the Inventory settings." : "Couldn't load the invoice links. Try again.");
    return false;
  }
  const canEdit = can("inventory.manage");
  const active = products.filter((p) => p.active);
  const byId = new Map(products.map((p) => [p.id, p]));

  const rows = new Map();
  unlinked.forEach((u) => rows.set(invoiceNameKey(u.name), { name: u.name, productId: "", lines: u.lines || 0, isNew: true }));
  cfg.links.forEach((l) => {
    const k = invoiceNameKey(l.name);
    if (rows.has(k)) rows.get(k).productId = l.productId;
    else rows.set(k, { name: l.name, productId: l.productId, lines: 0, isNew: false });
  });
  const list = [...rows.values()];

  const options = (sel) => {
    const gone = sel && sel !== INVOICE_NOT_STOCK && !active.some((p) => p.id === sel);
    return `<option value="">Not linked yet</option>
      <option value="${INVOICE_NOT_STOCK}"${sel === INVOICE_NOT_STOCK ? " selected" : ""}>Not a stock item (service, voucher…)</option>
      ${gone ? `<option value="${esc(sel)}" selected>${esc((byId.get(sel) || {}).name || "A removed product")} (inactive)</option>` : ""}
      ${INV_CATEGORIES.map((c) => {
        const items = active.filter((p) => p.category === c.key);
        return items.length ? `<optgroup label="${esc(c.label)}">${items.map((p) =>
          `<option value="${esc(p.id)}"${p.id === sel ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>` : "";
      }).join("")}`;
  };

  return new Promise((resolve) => {
    let saved = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg inv-il";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Invoice links</h3>
          <p>Products sold on Timely invoices come off the Shelf when the invoices are uploaded in Daily uploads.
            Names that match a product exactly link by themselves. Link the rest here once.</p></div>
        <label class="lh-field"><span class="lh-label">Take stock off from</span>
          <input type="date" name="start" value="${esc(cfg.startDate)}"${canEdit ? "" : " disabled"} />
          <small class="fe-note">Invoices dated on or after this day take stock off. Leave it empty and nothing is taken off.
            Best set to the day of a full count of the retail Shelf.</small></label>
        ${list.length ? `
          <input type="search" class="fe-input" data-role="find" placeholder="Search invoice names" aria-label="Search invoice names" />
          ${canEdit ? '<button type="button" class="ff-btn is-quiet inv-il-rest" data-act="rest">Mark every one not linked yet as “Not a stock item”</button>' : ""}
          <div class="inv-il-scroll"><table class="inv-table">
            <thead><tr><th>Name on the invoice</th><th>Stock product</th></tr></thead>
            <tbody>${list.map((r, i) => `
              <tr data-find="${esc(r.name.toLowerCase())}"${r.isNew ? ' class="is-new"' : ""}>
                <td><strong>${esc(r.name)}</strong>${r.isNew ? ` <span class="inv-flag is-warn">New${r.lines > 1 ? ` · ${r.lines} lines` : ""}</span>` : ""}</td>
                <td><select class="fb-select" data-i="${i}"${canEdit ? "" : " disabled"}>${options(r.productId)}</select></td>
              </tr>`).join("")}</tbody></table></div>`
          : '<p class="tb-none">No invoice names to link yet. Any that don\'t match a product show here after an upload.</p>'}
        ${canEdit ? "" : '<p class="inv-hint">Only someone with Manage inventory can change these.</p>'}
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">${canEdit ? "Cancel" : "Close"}</button>
          ${canEdit ? '<button type="submit" class="lh-btn is-primary">Save</button>' : ""}
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(saved); });
    dlg.showModal();

    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    const find = dlg.querySelector('[data-role="find"]');
    if (find) {
      find.addEventListener("input", () => {
        const q = find.value.trim().toLowerCase();
        dlg.querySelectorAll("tr[data-find]").forEach((tr) => { tr.hidden = !!q && !tr.dataset.find.includes(q); });
      });
      find.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    }
    const rest = dlg.querySelector('[data-act="rest"]');
    if (rest) rest.addEventListener("click", () => {
      dlg.querySelectorAll("select[data-i]").forEach((s) => { if (!s.value) s.value = INVOICE_NOT_STOCK; });
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!canEdit) return;
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      dlg.querySelectorAll("select[data-i]").forEach((s) => { list[Number(s.dataset.i)].productId = s.value; });
      try {
        await saveInvoiceSettings({
          startDate: form.elements.start.value,
          links: list.filter((r) => r.productId).map((r) => ({ name: r.name, productId: r.productId })),
        }, staff);
        saved = true;
        dlg.close();
        showToast("Invoice links saved");
      } catch (ex) {
        console.error("Save invoice links failed:", ex);
        err.textContent = ex && ex.code === "permission-denied" ? "No access. Check your Manage inventory access." : (ex && ex.message) || "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
  });
}