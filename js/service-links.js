// Inventory → Service links: which products each appointment service uses (any one of them counts).
// Used to spot bookings where nothing was recorded: Reporting → Not recorded, investigations and the dashboard.
import { INV_CATEGORIES, getServiceLinks, saveServiceLinks, listServicesSeen, serviceKey } from "./inventory-api.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

export async function renderServiceLinks(body, { staff, products = [] } = {}) {
  body.innerHTML = '<div data-role="svc"><div class="skeleton" style="height:260px;border-radius:14px"></div></div>';
  const box = body.firstElementChild;
  let links;
  let seen;
  try {
    [links, seen] = await Promise.all([getServiceLinks(), listServicesSeen(90)]);
  } catch (err) {
    console.error("Service links failed:", err);
    if (box.isConnected) box.innerHTML = `<div class="tm-empty is-error">${esc(err && err.code === "permission-denied"
      ? "You don't have access to service links." : "Couldn't load the services. Try again.")}</div>`;
    return;
  }
  if (!box.isConnected) return;

  // One row per service: seen in bookings, linked, or both
  const rows = new Map();
  seen.forEach((s) => rows.set(serviceKey(s.service), { service: s.service, n: s.n, productIds: [] }));
  links.forEach((l) => {
    const k = serviceKey(l.service);
    const r = rows.get(k) || { service: l.service, n: 0, productIds: [] };
    r.productIds = l.productIds.slice();
    rows.set(k, r);
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const pName = (id) => (byId.get(id) || {}).name || "Removed product";
  const st = { q: "", view: "all" };

  function visible() {
    const q = st.q.trim().toLowerCase();
    return [...rows.entries()]
      .filter(([, r]) => (st.view === "all" || (st.view === "unlinked" ? !r.productIds.length : r.productIds.length > 0))
        && (!q || r.service.toLowerCase().includes(q) || r.productIds.some((id) => pName(id).toLowerCase().includes(q))))
      .sort(([, a], [, b]) => b.n - a.n || a.service.localeCompare(b.service, "en-AU"));
  }

  function drawList() {
    const el = box.querySelector('[data-role="svclist"]');
    if (!el) return;
    const list = visible();
    el.innerHTML = list.length ? list.map(([k, r]) => `
      <div class="sl-row${r.productIds.length ? "" : " is-unlinked"}">
        <div class="sl-name"><strong>${esc(r.service)}</strong>
          <small>${r.n ? `${r.n} booking${r.n === 1 ? "" : "s"} in the last 90 days` : "No bookings in the last 90 days"}</small></div>
        <div class="sl-prods">${r.productIds.length
          ? r.productIds.map((id) => `<span class="sl-chip">${esc(pName(id))}</span>`).join("")
          : '<span class="muted">Not linked, so not checked</span>'}</div>
        <button type="button" class="lh-btn" data-svc-edit="${esc(k)}">${r.productIds.length ? "Change" : "Link products"}</button>
      </div>`).join("")
      : `<div class="tm-empty">${rows.size ? "No services match." : "No appointments in the last 90 days to take services from."}</div>`;
    const linked = [...rows.values()].filter((r) => r.productIds.length).length;
    box.querySelector('[data-role="svccount"]').textContent = `${linked} of ${rows.size} services linked`;
  }

  box.innerHTML = `
    <p class="muted rp-range">Tick the products each appointment service uses. When someone is booked for a linked service but no
      treatment record uses one of its products within 3 days, it shows in Reporting → Not recorded, in investigations and on the
      clinician's dashboard. Cancelled and no-show bookings are skipped. Services that don't use stock (consultations, reviews) can stay unlinked.</p>
    <div class="inv-tools">
      <label class="ib-search inv-find">${SEARCH}<input type="search" data-svc="q" placeholder="Search services or products" aria-label="Search" /></label>
      <div class="fe-seg">${[["all", "All"], ["unlinked", "Not linked"], ["linked", "Linked"]].map(([v, l]) =>
        `<label class="fe-seg-btn"><input type="radio" name="svc-v" value="${v}"${v === st.view ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
      <span class="inv-spacer"></span>
      <span class="muted" data-role="svccount"></span>
    </div>
    <div class="sl-list" data-role="svclist"></div>`;
  drawList();

  async function persist() {
    await saveServiceLinks([...rows.values()].filter((r) => r.productIds.length)
      .map((r) => ({ service: r.service, productIds: r.productIds })), staff);
  }

  function edit(k) {
    const r = rows.get(k);
    if (!r) return;
    const choices = products.filter((p) => p.active || r.productIds.includes(p.id));
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${esc(r.service)}</h3>
          <p>Tick every product this service can use. A treatment record with any one of them counts as recorded.</p></div>
        <input type="search" class="fe-input inv-supfind" data-role="find" placeholder="Search products" autocomplete="off" />
        <div class="inv-supticks sl-ticks">${INV_CATEGORIES.map((c) => {
          const items = choices.filter((p) => p.category === c.key);
          return items.length ? `<p class="sc-cat">${esc(c.label)}</p>${items.map((p) => `
            <label class="fe-check" data-find="${esc(p.name.toLowerCase())}"><input type="checkbox" name="pid" value="${esc(p.id)}"${
              r.productIds.includes(p.id) ? " checked" : ""} /> ${esc(p.name)}</label>`).join("")}` : "";
        }).join("")}</div>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          ${r.productIds.length ? '<button type="button" class="lh-btn is-quiet" data-act="clear">Unlink this service</button>' : ""}
          <span class="inv-spacer"></span>
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const find = dlg.querySelector('[data-role="find"]');
    find.addEventListener("input", () => {
      const q = find.value.trim().toLowerCase();
      dlg.querySelectorAll(".sl-ticks [data-find]").forEach((row) => {
        row.hidden = !!q && !row.dataset.find.includes(q) && !row.querySelector("input").checked;
      });
    });
    find.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });

    const save = async (ids) => {
      const before = r.productIds;
      r.productIds = ids;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await persist();
        dlg.close();
        showToast(ids.length ? `${r.service}: ${ids.length} product${ids.length === 1 ? "" : "s"} linked` : `${r.service} unlinked`);
        drawList();
      } catch (ex) {
        console.error("Save service links failed:", ex);
        r.productIds = before;
        err.textContent = ex && ex.code === "permission-denied" ? "Only Manage inventory can change service links." : "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    };
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    const clr = dlg.querySelector('[data-act="clear"]');
    if (clr) clr.addEventListener("click", () => save([]));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      save([...form.querySelectorAll('[name="pid"]:checked')].map((x) => x.value));
    });
    find.focus();
  }

  box.addEventListener("input", (e) => {
    if (e.target.dataset.svc === "q") { st.q = e.target.value; drawList(); }
  });
  box.addEventListener("change", (e) => {
    if (e.target.name === "svc-v") { st.view = e.target.value; drawList(); }
  });
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-svc-edit]");
    if (b) edit(b.dataset.svcEdit);
  });
}