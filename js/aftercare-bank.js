// The Aftercare Bank page (#/aftercare-bank) and the aftercare chooser.
import {
  listAftercare, aftercarePanel, bindPanels, saveAftercare, deleteAftercare,
} from "./aftercare-api.js";
import { createRichEditor } from "./rich-editor.js";
import { listFormTemplates } from "./form-templates.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

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

const PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const BIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

export function mountAftercareBank(container, { isAdmin = false, staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <a class="back-link" href="#/forms">← Form Builder</a>
    <div class="fb-head">
      <div>
        <h2>Aftercare Bank</h2>
        <p class="muted">Aftercare instructions you can add to forms. Click one to read it.${
          isAdmin ? " Use the pencil to edit, or add a new one." : ""}</p>
      </div>
      ${isAdmin ? `<div class="fb-head-actions"><button type="button" class="btn-primary" data-act="new">${PLUS}New aftercare</button></div>` : ""}
    </div>
    <label class="ib-search ac-search">${SEARCH}<input type="search" data-role="q" placeholder="Search aftercare or treatments" aria-label="Search aftercare" /></label>
    <div data-role="list"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>`;
  container.replaceChildren(root);
  const listEl = root.querySelector('[data-role="list"]');
  const qEl = root.querySelector('[data-role="q"]');
  bindPanels(listEl);
  let all = [];

  const tools = (a) => isAdmin ? `
    <button type="button" class="ib-tool" data-ac-edit="${esc(a.id)}" title="Edit" aria-label="Edit ${esc(a.title)}">${PENCIL}</button>
    <button type="button" class="ib-tool is-danger" data-ac-del="${esc(a.id)}" title="Delete" aria-label="Delete ${esc(a.title)}">${BIN}</button>` : "";

  function render() {
    const q = qEl.value.trim().toLowerCase();
    const rows = all.filter((a) => matches(a, q));
    if (!all.length) {
      listEl.innerHTML = `<div class="tm-empty">No aftercare instructions yet.${isAdmin ? " Click <strong>New aftercare</strong> to add the first one." : ""}</div>`;
      return;
    }
    if (!rows.length) { listEl.innerHTML = `<div class="tm-empty">Nothing matches “${esc(qEl.value.trim())}”.</div>`; return; }
    listEl.innerHTML = grouped(rows).map(([t, items]) => `
      <section class="ac-group">
        <h3>${esc(t)}<em>${items.length}</em></h3>
        <div class="ac-list">${items.map((a) => aftercarePanel(a, { control: tools(a) })).join("")}</div>
      </section>`).join("");
  }

  async function load(force = true) {
    try {
      all = await listAftercare({ force });
      if (listEl.isConnected) render();
    } catch (err) {
      console.error("Aftercare load failed:", err);
      listEl.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
        ? "Aftercare is blocked. Check the Aftercare-instruction Firestore rule has been published."
        : "Couldn't load the aftercare. Check your connection and try again."}</div>`;
    }
  }

  async function edit(item) {
    const treatments = [...new Set(all.map((a) => a.treatment).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en-AU"));
    const savedId = await openAftercareEditor({ item, treatments, staff });
    if (!savedId) return;
    await load(true);
    // Open the one just saved, so it's easy to check
    const btn = listEl.querySelector(`[data-acid="${CSS.escape(savedId)}"] .ac-toggle`);
    if (btn) { btn.click(); btn.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }

  async function remove(item) {
    let message = "It's removed from the Aftercare Bank and the clinic's aftercare list. Patient forms already saved keep their copy.";
    try {
      const used = (await listFormTemplates({ isAdmin: true }))
        .filter((t) => (t.fields || []).some((f) => f.type === "aftercare" && (f.items || []).includes(item.id)));
      if (used.length) {
        const names = used.slice(0, 3).map((t) => t.name).join(", ") + (used.length > 3 ? ` and ${used.length - 3} more` : "");
        message = `It's used in ${used.length} form${used.length === 1 ? "" : "s"}: ${names}. Those forms will show it as missing until you choose another. ${message}`;
      }
    } catch (err) { console.warn("Couldn't check which forms use this aftercare:", err); }
    const ok = await confirmDialog({ title: `Delete “${item.title}”?`, message, confirmLabel: "Delete aftercare", tone: "danger" });
    if (!ok) return;
    try {
      await deleteAftercare(item.id);
      showToast("Aftercare deleted");
      load(true);
    } catch (err) {
      console.error("Delete aftercare failed:", err);
      showToast(err.code === "permission-denied" ? "Only admins can delete aftercare." : "Couldn't delete. Try again.");
    }
  }

  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="new"]')) { edit(null); return; }
    const ed = e.target.closest("[data-ac-edit]");
    if (ed) { const a = all.find((x) => x.id === ed.dataset.acEdit); if (a) edit(a); return; }
    const del = e.target.closest("[data-ac-del]");
    if (del) { const a = all.find((x) => x.id === del.dataset.acDel); if (a) remove(a); }
  });
  qEl.addEventListener("input", render);
  load(true);
}

/* ===================== Editing one aftercare ===================== */

// Resolves with the saved aftercare's id, or null if cancelled
function openAftercareEditor({ item = null, treatments = [], staff = null }) {
  return new Promise((resolve) => {
    let result = null;
    let dirty = false;
    let busy = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ac-editor";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head">
          <h3>${item ? "Edit aftercare" : "New aftercare"}</h3>
          <p>${item
            ? "Changes show on every form that uses this aftercare. Patient forms already saved keep the copy they were sent."
            : "Once saved, you can add it to forms with the Aftercare field."}</p>
        </div>
        <div class="ac-ed-two">
          <label class="lh-field"><span class="lh-label">Title</span>
            <input name="title" maxlength="200" autocomplete="off" placeholder="e.g. IPL Hair Removal Aftercare Instructions" value="${esc(item ? item.title : "")}" /></label>
          <label class="lh-field"><span class="lh-label">Associated treatment</span>
            <input name="treatment" maxlength="120" autocomplete="off" list="ac-treatments" placeholder="e.g. Hair Removal" value="${esc(item ? item.treatment : "")}" />
            <datalist id="ac-treatments">${treatments.map((t) => `<option value="${esc(t)}"></option>`).join("")}</datalist></label>
          <label class="lh-field"><span class="lh-label">Link <small>(optional, must start with https://: makes the name clickable in Task Manager emails)</small></span>
            <input name="link" type="url" maxlength="500" autocomplete="off" inputmode="url"
              placeholder="https://dermedica.com.au/aftercare/ipl-hair-removal" value="${esc(item ? item.link || "" : "")}" /></label>
        </div>
        <div class="lh-field"><span class="lh-label">Instructions</span><div data-role="editor"></div></div>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary" data-role="save">${item ? "Save changes" : "Add aftercare"}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);

    const form = dlg.querySelector("form");
    const errEl = dlg.querySelector(".lh-error");
    const saveBtn = dlg.querySelector('[data-role="save"]');
    const showErr = (m) => { errEl.textContent = m || ""; errEl.hidden = !m; };
    const editor = createRichEditor(dlg.querySelector('[data-role="editor"]'), {
      button: false,
      onInput: () => { dirty = true; showErr(""); },
    });
    editor.setHtml(item && item.html ? item.html : "<p><br></p>");
    form.addEventListener("input", (e) => { if (!e.target.closest(".re")) { dirty = true; showErr(""); } });

    async function close() {
      if (busy) return;
      if (dirty) {
        const ok = await confirmDialog({
          title: "Discard your changes?",
          message: "The changes to this aftercare haven't been saved.",
          confirmLabel: "Discard changes",
          tone: "warning",
        });
        if (!ok) return;
      }
      dlg.close();
    }
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", close);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); }); // the Esc key

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      showErr("");
      try {
        result = await saveAftercare(item ? item.id : "", {
          title: form.elements.title.value,
          treatment: form.elements.treatment.value,
          html: editor.getHtml(),
          link: form.elements.link.value,
        }, staff);
        busy = false;
        dirty = false;
        dlg.close();
        showToast(item ? "Aftercare saved" : "Aftercare added");
      } catch (err) {
        console.error("Save aftercare failed:", err);
        busy = false;
        saveBtn.disabled = false;
        saveBtn.textContent = item ? "Save changes" : "Add aftercare";
        showErr(err.code === "permission-denied"
          ? "The save was blocked. You need Form Builder access, and the Aftercare-instruction rule (with the Link field) must be published in Firebase."
          : err.code ? "Couldn't save. Check your connection and try again." : err.message);
      }
    });

    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    dlg.showModal();
    form.elements.title.focus();
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