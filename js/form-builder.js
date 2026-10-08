import { escapeHtml } from "./utils.js";
import {
  FORM_CATEGORIES, categoryLabel, listFormTemplates, getFormTemplate, createFormTemplate,
} from "./form-templates.js";
import { mountFormEditor } from "./form-editor.js";

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

const ICONS = {
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  all: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  consent: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  treatment: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  prescription: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  printable: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  email: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  admin: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
};

function editedAgo(date) {
  if (!date) return "";
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "Edited just now";
  if (mins < 60) return `Edited ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Edited ${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `Edited ${days} day${days === 1 ? "" : "s"} ago`;
  return "Edited " + date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function statusPill(status) {
  return status === "live"
    ? '<span class="fb-pill is-live">Live</span>'
    : '<span class="fb-pill is-draft">Draft</span>';
}

function loadError(err, what) {
  return err && err.code === "permission-denied"
    ? `<div class="state error"><strong>${what} blocked</strong>The Firestore rules for form templates haven't been published yet, or your login has expired. Publish the rules, then refresh.</div>`
    : `<div class="state error"><strong>Couldn't load ${what.toLowerCase()}</strong>Check your connection and try again.<div class="retry"><button type="button" class="btn-ghost" data-act="retry">Try again</button></div></div>`;
}

export function mountFormBuilder(container, { isAdmin = false, staff = null, templateId = "" } = {}) {
  if (templateId) {
    return isAdmin
      ? mountFormEditor(container, { templateId, staff })
      : mountTemplatePage(container, { isAdmin, templateId });
  }
  return mountLibrary(container, { isAdmin, staff });
}
/* ===================== Library ===================== */

function mountLibrary(container, { isAdmin, staff }) {
  const ui = { cat: "all", status: "all", q: "" };
  let templates = [];

  // A fresh root on every visit, so listeners never pile up on #content
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <div class="fb-head">
      <div>
        <h2>Form Builder</h2>
        <p class="muted">Consent forms, treatment records and printables for the clinic.</p>
      </div>
      ${isAdmin ? `<button type="button" class="btn-primary fb-new" data-act="new">${svg(ICONS.plus)}New form</button>` : ""}
    </div>
    <div class="fb-layout">
      <nav class="fb-cats" data-role="cats" aria-label="Form categories"></nav>
      <div class="fb-main">
        <div class="fb-tools">
          <label class="pt-search fb-search">
            ${svg(ICONS.search)}
            <input type="search" data-role="q" placeholder="Search forms" aria-label="Search forms" />
          </label>
          ${isAdmin ? `
          <div class="pt-tabs" data-role="status" role="group" aria-label="Status">
            <button type="button" data-s="all" class="active">All</button>
            <button type="button" data-s="live">Live</button>
            <button type="button" data-s="draft">Drafts</button>
          </div>` : ""}
        </div>
        <div data-role="list"></div>
      </div>
    </div>`;
  container.replaceChildren(root);
  const $ = (s) => root.querySelector(s);

  function renderCats() {
    const counts = { all: templates.length };
    templates.forEach((t) => { counts[t.category] = (counts[t.category] || 0) + 1; });
    $('[data-role="cats"]').innerHTML = [{ key: "all", label: "All forms" }, ...FORM_CATEGORIES]
      .map((c) => `
        <button type="button" class="fb-cat${ui.cat === c.key ? " active" : ""}" data-cat="${c.key}"
                ${ui.cat === c.key ? 'aria-current="true"' : ""}>
          ${svg(ICONS[c.key])}<span>${escapeHtml(c.label)}</span><em>${counts[c.key] || 0}</em>
        </button>`).join("");
  }

  function renderList() {
    const list = $('[data-role="list"]');
    const q = ui.q.trim().toLowerCase();

    if (!templates.length) {
      list.innerHTML = isAdmin
        ? `<div class="state"><strong>Create your first form</strong>Start with a consent form or a treatment record. It stays a draft until you publish it.
             <div class="retry"><button type="button" class="btn-primary" data-act="new">New form</button></div></div>`
        : `<div class="state"><strong>No forms published yet</strong>When an admin publishes a form, it will appear here.</div>`;
      return;
    }

    const rows = templates.filter((t) =>
      (ui.cat === "all" || t.category === ui.cat) &&
      (ui.status === "all" || t.status === ui.status) &&
      (!q || t.name.toLowerCase().includes(q)));

    if (!rows.length) {
      list.innerHTML = q
        ? `<div class="state"><strong>No forms match “${escapeHtml(ui.q.trim())}”</strong>Check the spelling or try another category.</div>`
        : `<div class="state"><strong>Nothing here yet</strong>${isAdmin ? "Create a form in this category with New form." : "No forms have been published in this category."}</div>`;
      return;
    }

    list.innerHTML = `<div class="fb-list">${rows.map((t) => `
      <a class="fb-row" href="#/forms/${encodeURIComponent(t.id)}">
        <span class="fb-row-icon">${svg(ICONS[t.category] || ICONS.admin)}</span>
        <span class="fb-row-main">
          <span class="fb-row-name">${escapeHtml(t.name)}</span>
          <span class="fb-row-meta">
            <span>${escapeHtml(categoryLabel(t.category))}</span>
            <span>${t.fieldCount} question${t.fieldCount === 1 ? "" : "s"}</span>
            ${t.updatedAt ? `<span>${escapeHtml(editedAgo(t.updatedAt))}</span>` : ""}
          </span>
        </span>
        ${isAdmin ? statusPill(t.status) : ""}
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.chevron}</svg>
      </a>`).join("")}</div>`;
  }

  async function load(force = false) {
    $('[data-role="list"]').innerHTML =
      '<div class="fb-list"><div class="skeleton fb-skel"></div><div class="skeleton fb-skel"></div><div class="skeleton fb-skel"></div></div>';
    try {
      templates = await listFormTemplates({ isAdmin, force });
      renderCats();
      renderList();
    } catch (err) {
      console.error("Form library load failed:", err);
      renderCats();
      $('[data-role="list"]').innerHTML = loadError(err, "Forms");
    }
  }

  function openNewForm() {
    const dlg = document.createElement("dialog");
    dlg.className = "dialog";
    const startCat = ui.cat !== "all" ? ui.cat : "consent";
    dlg.innerHTML = `
      <form class="dialog-body" novalidate>
        <h2>New form</h2>
        <label class="field">
          <span>Form name</span>
          <input name="name" maxlength="120" placeholder="Anti-wrinkle consent" autocomplete="off" />
        </label>
        <label class="field">
          <span>Category</span>
          <select name="category" class="fb-select">
            ${FORM_CATEGORIES.map((c) => `<option value="${c.key}"${c.key === startCat ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
          </select>
        </label>
        <p class="form-error" role="alert"></p>
        <div class="dialog-actions">
          <button type="button" class="btn-ghost" data-act="cancel">Cancel</button>
          <button type="submit" class="btn-primary">Create form</button>
        </div>
      </form>`;
    root.appendChild(dlg);

    const form = dlg.querySelector("form");
    const nameInput = form.elements.name;
    const errorEl = dlg.querySelector(".form-error");
    const submitBtn = dlg.querySelector('button[type="submit"]');

    dlg.addEventListener("close", () => dlg.remove());
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    nameInput.addEventListener("input", () => { errorEl.textContent = ""; });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!nameInput.value.trim()) {
        errorEl.textContent = "Give the form a name.";
        nameInput.focus();
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating…";
      errorEl.textContent = "";
      try {
        const id = await createFormTemplate(
          { name: nameInput.value, category: form.elements.category.value }, staff);
        dlg.close();
        location.hash = `#/forms/${encodeURIComponent(id)}`;
      } catch (err) {
        console.error("Create form failed:", err);
        errorEl.textContent = err.code === "permission-denied"
          ? "Only admins can create forms."
          : err.code ? "Couldn't create the form. Try again." : err.message;
        submitBtn.disabled = false;
        submitBtn.textContent = "Create form";
      }
    });

    dlg.showModal();
    nameInput.focus();
  }

  root.addEventListener("click", (e) => {
    const cat = e.target.closest("[data-cat]");
    if (cat) { ui.cat = cat.dataset.cat; renderCats(); renderList(); return; }

    const st = e.target.closest("[data-s]");
    if (st) {
      ui.status = st.dataset.s;
      root.querySelectorAll("[data-s]").forEach((b) => b.classList.toggle("active", b === st));
      renderList();
      return;
    }
    if (e.target.closest('[data-act="new"]')) { openNewForm(); return; }
    if (e.target.closest('[data-act="retry"]')) load(true);
  });
  $('[data-role="q"]').addEventListener("input", (e) => { ui.q = e.target.value; renderList(); });

  load();
}

/* ===================== One form ===================== */

async function mountTemplatePage(container, { isAdmin, templateId }) {
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <a class="back-link" href="#/forms">← All forms</a>
    <div data-role="body"><div class="skeleton" style="height:140px"></div></div>`;
  container.replaceChildren(root);
  const body = root.querySelector('[data-role="body"]');

  async function load() {
    try {
      const t = await getFormTemplate(templateId);
      if (!t) {
        body.innerHTML = `<div class="state"><strong>Form not found</strong>It may have been removed. Go back to the list to choose another.</div>`;
        return;
      }
      body.innerHTML = `
        <div class="fb-head">
          <div>
            <h2>${escapeHtml(t.name)}</h2>
            <p class="muted">${escapeHtml(categoryLabel(t.category))}${t.updatedAt ? ` · ${escapeHtml(editedAgo(t.updatedAt))}` : ""}${t.updatedBy ? ` by ${escapeHtml(t.updatedBy)}` : ""}</p>
          </div>
          ${isAdmin ? statusPill(t.status) : ""}
        </div>
        <div class="state">
          <strong>${isAdmin ? "The editor is the next step" : "Filling in forms is coming soon"}</strong>
          ${isAdmin
            ? "This is where you'll add questions, preview the page and publish the form."
            : "You'll be able to fill this form in with a patient from here."}
        </div>`;
    } catch (err) {
      console.error("Form load failed:", err);
      body.innerHTML = err && err.code === "permission-denied"
        ? `<div class="state"><strong>This form isn't available</strong>It may still be a draft. Go back to the list to see published forms.</div>`
        : loadError(err, "Form");
      const retry = body.querySelector('[data-act="retry"]');
      if (retry) retry.addEventListener("click", load);
    }
  }
  load();
}