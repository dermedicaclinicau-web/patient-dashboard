// The Aftercare Bank page (#/aftercare-bank) and the aftercare chooser.
import { listAftercare, aftercarePanel, bindPanels } from "./aftercare-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

const matches = (a, q) => !q || a.title.toLowerCase().includes(q) || a.treatment.toLowerCase().includes(q);

function grouped(list) {
  const groups = new Map();
  list.forEach((a) => {
    const k = a.treatment || "Other";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  });
  return [...groups.entries()];
}

/* ===================== The page ===================== */

export function mountAftercareBank(container) {
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <a class="back-link" href="#/forms">← Form Builder</a>
    <div class="fb-head">
      <div>
        <h2>Aftercare Bank</h2>
        <p class="muted">Aftercare instructions you can add to forms. Click one to read it. They come from the clinic's aftercare list, so updates show here automatically.</p>
      </div>
    </div>
    <label class="ib-search ac-search">${SEARCH}<input type="search" data-role="q" placeholder="Search aftercare or treatments" aria-label="Search aftercare" /></label>
    <div data-role="list"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>`;
  container.replaceChildren(root);
  const listEl = root.querySelector('[data-role="list"]');
  const qEl = root.querySelector('[data-role="q"]');
  bindPanels(listEl);
  let all = [];

  function render() {
    const q = qEl.value.trim().toLowerCase();
    const rows = all.filter((a) => matches(a, q));
    if (!all.length) { listEl.innerHTML = '<div class="tm-empty">No aftercare instructions found.</div>'; return; }
    if (!rows.length) { listEl.innerHTML = `<div class="tm-empty">Nothing matches “${esc(qEl.value.trim())}”.</div>`; return; }
    listEl.innerHTML = grouped(rows).map(([t, items]) => `
      <section class="ac-group">
        <h3>${esc(t)}<em>${items.length}</em></h3>
        <div class="ac-list">${items.map((a) => aftercarePanel(a)).join("")}</div>
      </section>`).join("");
  }

  qEl.addEventListener("input", render);
  listAftercare({ force: true })
    .then((list) => { all = list; if (listEl.isConnected) render(); })
    .catch((err) => {
      console.error("Aftercare load failed:", err);
      listEl.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
        ? "Aftercare is blocked. Check the Aftercare-instruction Firestore rule has been published."
        : "Couldn't load the aftercare. Check your connection and try again."}</div>`;
    });
}

/* ===================== Chooser ===================== */

// Resolves with the chosen aftercare ids (in order), or null if cancelled
export function openAftercarePicker({ selected = [] } = {}) {
  return new Promise((resolve) => {
    const picked = new Set(selected);
    let result = null;
    let all = [];
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ac-picker";
    dlg.innerHTML = `
      <div class="ib-picker-head"><h3>Choose aftercare</h3><span class="muted" data-role="count"></span></div>
      <label class="ib-search ac-search">${SEARCH}<input type="search" data-role="q" placeholder="Search aftercare or treatments" aria-label="Search aftercare" /></label>
      <div class="ac-pick-list" data-role="list"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="button" class="lh-btn is-primary" data-act="done">Use selected</button>
      </div>`;
    const listEl = dlg.querySelector('[data-role="list"]');
    const qEl = dlg.querySelector('[data-role="q"]');
    const countEl = dlg.querySelector('[data-role="count"]');
    bindPanels(listEl);

    const count = () => { countEl.textContent = picked.size ? `${picked.size} selected` : ""; };
    function render() {
      const q = qEl.value.trim().toLowerCase();
      const rows = all.filter((a) => matches(a, q));
      listEl.innerHTML = rows.length ? grouped(rows).map(([t, items]) => `
        <section class="ac-group"><h3>${esc(t)}<em>${items.length}</em></h3>
          <div class="ac-list">${items.map((a) => aftercarePanel(a, { control:
            `<label class="ac-send"><input type="checkbox" data-pick="${esc(a.id)}"${picked.has(a.id) ? " checked" : ""} /> Use</label>` })).join("")}</div>
        </section>`).join("") : '<div class="tm-empty">Nothing matches that search.</div>';
      count();
    }

    listEl.addEventListener("change", (e) => {
      const id = e.target.dataset && e.target.dataset.pick;
      if (id === undefined) return;
      if (e.target.checked) picked.add(id); else picked.delete(id);
      count();
    });
    qEl.addEventListener("input", render);
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.querySelector('[data-act="done"]').addEventListener("click", () => {
      result = [
        ...selected.filter((id) => picked.has(id)),
        ...all.map((a) => a.id).filter((id) => picked.has(id) && !selected.includes(id)),
      ];
      dlg.close();
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    dlg.showModal();
    qEl.focus();

    listAftercare()
      .then((list) => { all = list; if (dlg.open) render(); })
      .catch(() => { listEl.innerHTML = '<div class="tm-empty is-error">Couldn\'t load the aftercare. Check your connection and try again.</div>'; });
  });
}