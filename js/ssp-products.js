// Skin Script Protocol: Products Config (used on its own page now, and inside the SSP builder later).
import { SSP_STEPS, listSspProducts, saveSspProduct, importSspProducts } from "./ssp-products-api.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { listProducts } from "./inventory-api.js";
import { inventoryMatcher } from "./ssp-stock.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const blank = () => ({
  id: "", name: "", steps: [], size: "", price: "", defaultInstruction: "", maintenanceInstruction: "",
  details: "", shopLink: "", published: true, sheetRow: 0, invProductId: "",
});

export function createProductsConfig(host, { staff = null, isAdmin = false, selectId = null } = {}) {
  // Inventory products, for the link picker (loaded once, in the background)
  let inv = null;
  const invReady = listProducts()
    .then((l) => { inv = [...l].sort((a, b) => String(a.name).localeCompare(String(b.name), "en-AU", { numeric: true })); })
    .catch((err) => { console.warn("Inventory products not loaded:", err); inv = []; });
  host.innerHTML = `
    <div class="sp-cfg">
      <aside class="sp-side">
        <input type="search" class="fe-input" data-role="q" placeholder="Search products…" aria-label="Search products" />
        ${isAdmin ? '<button type="button" class="btn-primary sp-new" data-act="new">+ New product</button>' : ""}
        <div class="sp-list" data-role="list"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>
      </aside>
      <section class="sp-main" data-role="form">
        <div class="tm-empty">Choose a product on the left${isAdmin ? ", or add a new one" : ""}.</div>
      </section>
    </div>`;
  const listEl = host.querySelector('[data-role="list"]');
  const formHost = host.querySelector('[data-role="form"]');
  const qEl = host.querySelector('[data-role="q"]');
  let all = [];
  let current = null;   // the product as saved
  let selectedId = null; // "" = a new product
  let dirty = false;

  function renderList() {
    const q = qEl.value.trim().toLowerCase();
    const hit = (p) => !q || p.name.toLowerCase().includes(q) || p.size.toLowerCase().includes(q);
    const groups = [...SSP_STEPS.map((s) => [s.label + (s.sub ? ` · ${s.sub}` : ""), all.filter((p) => p.steps.includes(s.key) && hit(p))]),
      ["Not in a step yet", all.filter((p) => !p.steps.length && hit(p))]].filter(([, items]) => items.length);
    listEl.innerHTML = groups.length ? groups.map(([title, items]) => `
      <div class="sp-group"><h4>${esc(title)}</h4>${items.map((p) => `
        <button type="button" class="sp-item${p.id === selectedId ? " is-on" : ""}${p.published ? "" : " is-off"}" data-pick="${esc(p.id)}">
          <span class="sp-item-name">${esc(p.name)}${p.published ? "" : '<em class="sp-tag">Unpublished</em>'}</span>
          ${p.size ? `<small>${esc(p.size)}</small>` : ""}
        </button>`).join("")}</div>`).join("")
      : `<div class="tm-empty">${all.length ? "No products match that search." : "No products yet."}${
          !all.length && isAdmin ? " Use <strong>Import from product_info</strong> to bring in your catalogue." : ""}</div>`;
  }

  function renderForm(p) {
    const ro = !isAdmin;
    formHost.innerHTML = `
      <form class="sp-form" novalidate>
        <fieldset ${ro ? "disabled" : ""}>
          <label class="sp-f"><span>Product name *</span><input class="fe-input" name="name" maxlength="150" value="${esc(p.name)}" /></label>
          <div class="sp-f"><span>Steps <small>(tick one or more)</small></span>
            <div class="sp-steps">${SSP_STEPS.map((s) => `
              <label class="fe-check"><input type="checkbox" name="step" value="${s.key}"${p.steps.includes(s.key) ? " checked" : ""} />
                <span>${esc(s.label)}${s.sub ? ` — ${esc(s.sub)}` : ""}</span></label>`).join("")}</div></div>
          <div class="sp-two">
            <label class="sp-f"><span>Size</span><input class="fe-input" name="size" maxlength="60" placeholder="e.g. 125mL" value="${esc(p.size)}" /></label>
            <label class="sp-f"><span>Price</span><input class="fe-input" name="price" maxlength="30" placeholder="e.g. 69" value="${esc(p.price)}" /></label>
          </div>
          <label class="sp-f"><span>Default instruction <small>(beginners)</small></span>
            <textarea class="fe-input" name="defaultInstruction" rows="3" maxlength="3000">${esc(p.defaultInstruction)}</textarea></label>
          <label class="sp-f"><span>Maintenance instruction</span>
            <textarea class="fe-input" name="maintenanceInstruction" rows="3" maxlength="3000">${esc(p.maintenanceInstruction)}</textarea></label>
          <label class="sp-f"><span>Details</span>
            <textarea class="fe-input" name="details" rows="4" maxlength="3000">${esc(p.details)}</textarea></label>
          <label class="sp-f"><span>Shop link</span>
            <input class="fe-input" name="shopLink" type="url" maxlength="500" placeholder="https://…" value="${esc(p.shopLink)}" /></label>
          <div class="sp-f"><span>Inventory product <small>(for the Shelf stock in the Skin Script builder)</small></span>
            <div class="sp-inv-search">
              <input type="search" class="fe-input" data-role="invq" placeholder="Search Inventory products…"
                aria-label="Search Inventory products" autocomplete="off" />
              <small class="muted" data-role="invcount"></small>
            </div>
            <select class="fb-select" name="invProductId" data-role="inv" aria-label="Inventory product"><option value="${esc(p.invProductId)}">Loading Inventory…</option></select>
            <small class="fe-note" data-role="invnote"></small></div>
          <label class="fe-check"><input type="checkbox" name="published"${p.published ? " checked" : ""} /> Show in the Skin Script builder</label>
        </fieldset>
        <p class="lh-error" role="alert" hidden></p>
        ${ro ? '<p class="fe-note">Only admins can change products.</p>' : `
        <div class="sp-actions">
          <small class="muted">${p.updatedAt ? `Last saved ${esc(new Date(p.updatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }))}${p.updatedBy ? ` by ${esc(p.updatedBy)}` : ""}` : "Not saved yet"}</small>
          <button type="button" class="lh-btn is-quiet" data-act="revert">Cancel changes</button>
          <button type="submit" class="lh-btn is-primary">Save product</button>
        </div>`}
      </form>`;
    dirty = false;
    const form = formHost.querySelector("form");
    form.addEventListener("input", () => { dirty = true; });
    invReady.then(() => { if (form.isConnected) fillInv(form, p); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = formHost.querySelector(".lh-error");
      const btn = form.querySelector('[type="submit"]');
      const draft = {
        id: selectedId || "",
        name: form.elements.name.value,
        steps: [...form.querySelectorAll('[name="step"]:checked')].map((x) => x.value),
        size: form.elements.size.value,
        price: form.elements.price.value,
        defaultInstruction: form.elements.defaultInstruction.value,
        maintenanceInstruction: form.elements.maintenanceInstruction.value,
        details: form.elements.details.value,
        shopLink: form.elements.shopLink.value,
        published: form.elements.published.checked,
        invProductId: form.elements.invProductId.value,
      };
      if (!draft.name.trim()) { errEl.textContent = "Give the product a name."; errEl.hidden = false; return; }
      if (!draft.steps.length) { errEl.textContent = "Tick at least one step."; errEl.hidden = false; return; }
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        const id = await saveSspProduct(draft, staff, current && current.id ? current : null);
        dirty = false;
        showToast(`“${draft.name.trim()}” saved`);
        await load(true, id);
      } catch (err) {
        console.error("Save product failed:", err);
        errEl.textContent = err.code === "permission-denied"
          ? "Firestore refused the save. Either your account can't change products, or the ssp_products rule doesn't allow one of the fields (e.g. invProductId). Check the rule in Firebase."
          : err.code ? "Couldn't save. Try again." : err.message;
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = "Save product";
      }
    });
    const revert = form.querySelector('[data-act="revert"]');
    if (revert) revert.addEventListener("click", () => renderForm(current || blank()));
  }

  // The Inventory picker: a search box over the list. The chosen product always stays in the list.
  function fillInv(form, p) {
    const sel = form.querySelector('[data-role="inv"]');
    const note = form.querySelector('[data-role="invnote"]');
    const q = form.querySelector('[data-role="invq"]');
    const count = form.querySelector('[data-role="invcount"]');
    if (!sel || !inv) return;
    if (!inv.length) {
      sel.innerHTML = `<option value="${esc(p.invProductId)}">${p.invProductId ? "Linked (Inventory couldn't be loaded)" : "Not linked"}</option>`;
      note.textContent = "Inventory couldn't be loaded, so the link can't be changed right now.";
      if (q) q.closest(".sp-inv-search").hidden = true;
      return;
    }

    const opts = inv.filter((x) => x.active || x.id === p.invProductId);
    const low = (s) => String(s || "").toLowerCase();
    const words = () => low(q && q.value).split(/\s+/).filter(Boolean);
    const hit = (x, w) => w.every((t) => low(`${x.name} ${x.brand || ""} ${x.category || ""}`).includes(t));

    const draw = () => {
      const cur = sel.value;                       // the first time: the saved link (from the Loading option)
      const w = words();
      const matches = w.length ? opts.filter((x) => hit(x, w)) : opts;
      const shown = matches.some((x) => x.id === cur) ? matches
        : opts.filter((x) => x.id === cur).concat(matches);   // keep the chosen one at the top
      sel.innerHTML = '<option value="">Not linked: match by name</option>' + shown.map((x) =>
        `<option value="${esc(x.id)}"${x.id === cur ? " selected" : ""}>${esc(x.name)}${x.active ? "" : " (inactive)"}</option>`).join("");
      sel.value = shown.some((x) => x.id === cur) ? cur : "";
      if (count) count.textContent = w.length ? (matches.length ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : "No matches") : "";
      return matches;
    };

    if (q) {
      // Searching isn't a change to the product, so it doesn't mark the form as unsaved
      q.addEventListener("input", (e) => { e.stopPropagation(); draw(); });
      // Enter picks the first match (and never submits the form)
      q.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); sel.focus(); return; }
        if (e.key !== "Enter") return;
        e.preventDefault();
        const first = draw()[0];
        if (first && sel.value !== first.id) {
          sel.value = first.id;
          dirty = true;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    }
    sel.addEventListener("change", () => { if (q && sel.value) q.value = ""; draw(); });

    draw();
    const linked = p.invProductId ? inv.find((x) => x.id === p.invProductId) : null;
    if (p.invProductId && !linked) {
      note.textContent = "The linked Inventory product no longer exists. Choose another.";
    } else if (p.invProductId) {
      note.textContent = linked.active ? "Linked: the Shelf stock always comes from this product." : "This Inventory product is inactive. Choose the one in use.";
    } else {
      const m = inventoryMatcher(all, inv)(p);
      note.textContent = m.product
        ? `Matched by name to “${m.product.name}”. Choose it to keep them linked even if a name changes.`
        : "No Inventory product has this name. Choose one to link it.";
    }
  }
  
  async function select(id) {
    if (dirty && !(await confirmDialog({
      title: "Discard your changes?",
      message: "The changes to this product haven't been saved.",
      confirmLabel: "Discard changes",
      tone: "warning",
    }))) return;
    selectedId = id;
    current = id ? all.find((p) => p.id === id) || null : blank();
    renderList();
    if (current) renderForm(current);
    if (id === "") formHost.querySelector('[name="name"]').focus();
  }

  async function load(force = false, keepId = selectedId) {
    try {
      all = await listSspProducts({ force, all: true });
      if (!host.isConnected) return;
      selectedId = keepId;
      current = keepId ? all.find((p) => p.id === keepId) || null : current;
      renderList();
      if (current && keepId) renderForm(current);
    } catch (err) {
      console.error("Products load failed:", err);
      listEl.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
        ? "Products are blocked. Check the ssp_products Firestore rule has been published."
        : "Couldn't load the products. Check your connection and try again."}</div>`;
    }
  }

  qEl.addEventListener("input", renderList);
  host.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) { select(pick.dataset.pick); return; }
    if (e.target.closest('[data-act="new"]')) select("");
  });

  load(true, selectId);
  return { reload: () => load(true), isDirty: () => dirty };
}

/* ===================== The page (#/ssp-products) ===================== */

export function mountSspProductsPage(container, { isAdmin = false, staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <a class="back-link" href="#/forms">← Form Builder</a>
    <div class="fb-head">
      <div>
        <h2>Skin Script Products</h2>
        <p class="muted">The product catalogue for Skin Script Protocols. Changes are saved to the portal and to the product_info sheet.</p>
      </div>
      ${isAdmin ? '<div class="fb-head-actions"><button type="button" class="btn-ghost" data-act="import">Import from product_info</button></div>' : ""}
    </div>
    <div data-role="cfg"></div>`;
  container.replaceChildren(root);
  const cfg = createProductsConfig(root.querySelector('[data-role="cfg"]'), { staff, isAdmin });

  root.addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-act="import"]');
    if (!btn || btn.disabled) return;
    const ok = await confirmDialog({
      title: "Import from product_info?",
      message: "Reads every product in the product_info sheet. New products are added; products already here (same name and size) are updated with the sheet's values. Nothing is deleted.",
      confirmLabel: "Import",
      tone: "primary",
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const r = await importSspProducts();
      showToast(`Imported: ${r.added} new, ${r.updated} updated (${r.total} products)`);
      cfg.reload();
    } catch (err) {
      console.error("Import failed:", err);
      showToast(err.code === "FORBIDDEN" ? "Only admins can import products."
        : err.code === "INVALID_PIN" ? "The server hasn't been updated yet. In Apps Script, deploy a new version."
        : "Couldn't import. Check Apps Script → Executions for details.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Import from product_info";
    }
  });
}