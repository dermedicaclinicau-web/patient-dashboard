import { fetchFormTemplates, fetchFormCategories, clearFormCache, liveFormUrl, builderUrl } from "./forms.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function editedAgo(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/**
 * @param {HTMLElement} container
 * @param {{ isAdmin?: boolean }} opts  isAdmin shows "Edit in builder"
 */
export async function mountFormLibrary(container, { isAdmin = false } = {}) {
  const ui = { cat: "all", status: "all", q: "" };
  let forms = [], cats = [];

  container.innerHTML = `
    <div class="fl-wrap">
      <aside class="fl-cats" data-role="cats"><div class="fl-muted">Loading…</div></aside>
      <section class="fl-main">
        <div class="fl-toolbar">
          <input type="search" class="fl-search" data-role="q" placeholder="Search forms" />
          <select class="fl-status" data-role="status">
            <option value="all">All statuses</option>
            <option value="live">Live</option>
            <option value="draft">Draft</option>
          </select>
          <button class="fl-btn" data-act="refresh" title="Reload from Firestore">↻ Refresh</button>
          ${isAdmin ? `<a class="fl-btn fl-btn-primary" href="${esc(builderUrl())}" target="_blank" rel="noopener">＋ New form</a>` : ""}
        </div>
        <div class="fl-list" data-role="list"><div class="fl-muted">Loading forms…</div></div>
      </section>
    </div>`;

  const $ = sel => container.querySelector(sel);

  function counts() {
    const c = { all: forms.length };
    forms.forEach(f => { c[f.category] = (c[f.category] || 0) + 1; });
    return c;
  }

  function renderCats() {
    const c = counts();
    // A form saved under a since-deleted category still needs a filter entry
    const known = new Set(cats.map(x => x.key));
    const orphans = [...new Set(forms.map(f => f.category))]
      .filter(k => !known.has(k))
      .map(k => ({ key: k, label: k, icon: "📂" }));

    $('[data-role="cats"]').innerHTML =
      [{ key: "all", label: "All forms", icon: "🗂" }, ...cats, ...orphans].map(x => `
        <button class="fl-cat${ui.cat === x.key ? " on" : ""}" data-cat="${esc(x.key)}">
          <span class="fl-cat-icon">${esc(x.icon)}</span>
          <span class="fl-cat-label">${esc(x.label)}</span>
          <span class="fl-cat-n">${c[x.key] || 0}</span>
        </button>`).join("");
  }

  function renderList() {
    const q = ui.q.trim().toLowerCase();
    const rows = forms.filter(f =>
      (ui.cat === "all" || f.category === ui.cat) &&
      (ui.status === "all" || (ui.status === "live") === f.live) &&
      (!q || f.name.toLowerCase().includes(q) || f.category.toLowerCase().includes(q)));

    const el = $('[data-role="list"]');
    if (!rows.length) {
      el.innerHTML = `<div class="fl-muted">${q ? `No forms match “${esc(ui.q.trim())}”.` : "No forms in this category yet."}</div>`;
      return;
    }
    const icon = key => (cats.find(c => c.key === key) || {}).icon || "📂";

    el.innerHTML = rows.map(f => {
      const isTemplate = f.category === "Email Templates";
      return `
      <div class="fl-row">
        <div class="fl-row-icon">${esc(icon(f.category))}</div>
        <div class="fl-row-main">
          <div class="fl-row-name">${esc(f.name)}</div>
          <div class="fl-row-meta">
            ${esc(f.category)} · ${f.fieldCount} field${f.fieldCount === 1 ? "" : "s"}
            ${f.layoutMode === "canvas" ? ` · canvas, ${f.pageCount} page${f.pageCount === 1 ? "" : "s"}` : ""}
            ${f.updatedAt ? ` · edited ${esc(editedAgo(f.updatedAt))}` : ""}
          </div>
        </div>
        <span class="fl-pill ${f.live ? "fl-live" : "fl-draft"}">${f.live ? "Live" : "Draft"}</span>
        <div class="fl-row-actions">
          ${f.live && !isTemplate ? `<a class="fl-btn" href="${esc(liveFormUrl(f.id))}" target="_blank" rel="noopener">Open</a>` : ""}
          ${f.printablePdfUrl ? `<a class="fl-btn" href="${esc(f.printablePdfUrl)}" target="_blank" rel="noopener">Blank PDF</a>` : ""}
          ${isAdmin ? `<a class="fl-btn" href="${esc(builderUrl())}" target="_blank" rel="noopener" title="Opens the Apps Script builder">Edit ↗</a>` : ""}
        </div>
      </div>`;
    }).join("");
  }

  async function load(force) {
    try {
      [forms, cats] = await Promise.all([
        fetchFormTemplates({ force }),
        fetchFormCategories({ force })
      ]);
      renderCats();
      renderList();
    } catch (e) {
      console.error("Form library load failed", e);
      $('[data-role="list"]').innerHTML = e && e.code === "permission-denied"
        ? `<div class="fl-error">Firestore rules are blocking the <code>forms</code> collection. Publish the new rules and refresh.</div>`
        : `<div class="fl-error">Couldn't load forms. Try refreshing.</div>`;
      $('[data-role="cats"]').innerHTML = "";
    }
  }

  // Delegated, so re-renders never drop listeners
  container.addEventListener("click", e => {
    const cat = e.target.closest("[data-cat]");
    if (cat) { ui.cat = cat.dataset.cat; renderCats(); renderList(); return; }
    if (e.target.closest('[data-act="refresh"]')) { clearFormCache(); load(true); }
  });
  $('[data-role="q"]').addEventListener("input", e => { ui.q = e.target.value; renderList(); });
  $('[data-role="status"]').addEventListener("change", e => { ui.status = e.target.value; renderList(); });

  await load(false);
}