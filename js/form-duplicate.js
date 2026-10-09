// "Duplicate form": the window used by both the form list and the form editor.
import { FORM_CATEGORIES, duplicateFormTemplate } from "./form-templates.js";
import { escapeHtml, showToast } from "./utils.js";

// source: { name, category, fields, settings }
export function openDuplicateDialog(source, staff) {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog";
  const copyName = `${source.name || "Untitled form"} (copy)`.slice(0, 120);
  const count = Array.isArray(source.fields) ? source.fields.length : 0;
  dlg.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2>Duplicate form</h2>
      <p class="fd-note">Makes a new <strong>draft</strong> with all ${count} question${count === 1 ? "" : "s"} and settings from
        “${escapeHtml(source.name || "Untitled form")}”. The original isn't changed, and the copy won't appear on the
        patient dashboard until you publish it.</p>
      <label class="field">
        <span>Name for the copy</span>
        <input name="name" maxlength="120" autocomplete="off" value="${escapeHtml(copyName)}" />
      </label>
      <label class="field">
        <span>Category</span>
        <select name="category" class="fb-select">
          ${FORM_CATEGORIES.map((c) => `<option value="${c.key}"${c.key === source.category ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
      </label>
      <p class="form-error" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="btn-ghost" data-act="cancel">Cancel</button>
        <button type="submit" class="btn-primary">Duplicate</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);

  const form = dlg.querySelector("form");
  const nameInput = form.elements.name;
  const errorEl = dlg.querySelector(".form-error");
  const submitBtn = dlg.querySelector('button[type="submit"]');
  let busy = false;

  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
  nameInput.addEventListener("input", () => { errorEl.textContent = ""; });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim().replace(/\s+/g, " ");
    if (!name) { errorEl.textContent = "Give the copy a name."; nameInput.focus(); return; }
    busy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Duplicating…";
    errorEl.textContent = "";
    try {
      const id = await duplicateFormTemplate(source, { name, category: form.elements.category.value }, staff);
      busy = false;
      dlg.close();
      location.hash = `#/forms/${encodeURIComponent(id)}`;
      showToast(`Copy made. You're now editing “${name}”.`);
    } catch (err) {
      console.error("Duplicate form failed:", err);
      busy = false;
      errorEl.textContent = err.code === "permission-denied"
        ? "Only admins can create forms."
        : err.code ? "Couldn't duplicate the form. Try again." : err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = "Duplicate";
    }
  });

  dlg.showModal();
  nameInput.focus();
  nameInput.select();
}