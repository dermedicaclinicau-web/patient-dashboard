import {
  fetchPersonalNotes, addPersonalNote, updatePersonalNote, hidePersonalNote, canEditNote, noteDate,
} from "./personal-notes.js";
import { escapeHtml, showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d) => (d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : "Undated");

export function mountPersonalNotes(root, patient, staff) {
  const card = root.querySelector('details[data-key="personal-notes"]');
  if (!card) return { reload: async () => {} };

  const hint = card.querySelector(".hint");
  const body = card.querySelector(".sub-body");
  let notes = [];
  let composing = false;
  let draft = "";
  let editingId = null;

  async function reload() {
    try {
      const list = await fetchPersonalNotes(patient);
      if (!card.isConnected) return;
      notes = list;
      render();
    } catch (err) {
      if (!card.isConnected) return;
      console.error("Personal notes failed:", err);
      hint.hidden = false;
      hint.textContent = "—";
      body.innerHTML = `<p class="empty-note error">${
        err.code === "permission-denied"
          ? "Personal notes aren't accessible. Check the Firestore rules."
          : "Couldn't load personal notes."}</p>`;
    }
  }

  function render() {
    hint.hidden = false;
    hint.textContent = notes.length ? `${notes.length} ${notes.length === 1 ? "note" : "notes"}` : "No record";
    card.classList.toggle("is-empty", !notes.length && !composing);

    body.innerHTML = `
      ${composing ? `
        <div class="pn-compose">
          <textarea class="pn-input" data-pn-draft maxlength="2000"
            placeholder="e.g. Prefers morning appointments. Apply ice pack before treatment.">${escapeHtml(draft)}</textarea>
          <div class="pn-btns">
            <small>Ctrl + Enter to save</small>
            <button type="button" class="pn-btn" data-pn="cancel">Cancel</button>
            <button type="button" class="pn-btn primary" data-pn="save">Save note</button>
          </div>
        </div>` : ""}
      ${notes.length
        ? `<ul class="pn-list">${notes.map(noteHtml).join("")}</ul>`
        : composing ? "" : `<p class="empty-note">No personal notes on record.</p>`}`;

    const focus = body.querySelector(editingId ? "[data-pn-edit]" : "[data-pn-draft]");
    if (focus) { focus.focus(); focus.setSelectionRange(focus.value.length, focus.value.length); }
  }

  function noteHtml(n) {
    if (n.id === editingId) {
      return `
        <li class="pn-item is-editing">
          <textarea class="pn-input" data-pn-edit maxlength="2000">${escapeHtml(n.note)}</textarea>
          <div class="pn-btns">
            <button type="button" class="pn-btn" data-pn="edit-cancel">Cancel</button>
            <button type="button" class="pn-btn primary" data-pn="edit-save" data-id="${escapeHtml(n.id)}">Save</button>
          </div>
        </li>`;
    }
    const edited = n.updatedAt && n.updatedBy ? ` · edited by ${escapeHtml(n.updatedBy)}` : "";
    return `
      <li class="pn-item">
        <p class="pn-text">${escapeHtml(n.note)}</p>
        <div class="pn-meta">
          <span>${escapeHtml(fmt(noteDate(n)))}${n.createdBy ? ` · ${escapeHtml(n.createdBy)}` : ""}${edited}</span>
          ${canEditNote(n, staff) ? `
            <span class="pn-actions">
              <button type="button" data-pn="edit" data-id="${escapeHtml(n.id)}">Edit</button>
              <button type="button" data-pn="remove" data-id="${escapeHtml(n.id)}">Remove</button>
            </span>` : ""}
        </div>
      </li>`;
  }

  function startCompose() {
    composing = true;
    editingId = null;
    const pc = root.querySelector('details[data-key="preconsult"]');
    if (pc) pc.open = true;
    card.open = true;
    render();
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function saveNew(btn) {
    const text = draft.trim();
    if (!text) { showToast("Write a note first"); return; }
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await addPersonalNote(patient, text, staff);
      composing = false;
      draft = "";
      showToast("Personal note saved");
      await reload();
    } catch (err) {
      console.error("Saving note failed:", err);
      showToast(err.code === "permission-denied" ? "You don't have permission to add notes." : "Couldn't save the note.");
      btn.disabled = false;
      btn.textContent = "Save note";
    }
  }

  async function saveEdit(btn) {
    const ta = body.querySelector("[data-pn-edit]");
    const text = ta ? ta.value.trim() : "";
    if (!text) { showToast("A note can't be empty. Use Remove instead."); return; }
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await updatePersonalNote(btn.dataset.id, text, staff);
      editingId = null;
      showToast("Note updated");
      await reload();
    } catch (err) {
      console.error("Updating note failed:", err);
      showToast(err.code === "permission-denied" ? "You can only edit notes you wrote." : "Couldn't update the note.");
      btn.disabled = false;
      btn.textContent = "Save";
    }
  }

  async function remove(id) {
    const ok = await confirmDialog({
      title: "Remove this note?",
      message: "It will no longer show for this patient. A record of who removed it is kept.",
      confirmLabel: "Remove note",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await hidePersonalNote(id, staff);
      showToast("Note removed");
      await reload();
    } catch (err) {
      console.error("Removing note failed:", err);
      showToast(err.code === "permission-denied" ? "You can only remove notes you wrote." : "Couldn't remove the note.");
    }
  }

  // "+ Add" on the card AND the "Personal note" tile
  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="add-note"]')) startCompose();
  });

  card.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pn]");
    if (!btn) return;
    const a = btn.dataset.pn;
    if (a === "save") saveNew(btn);
    else if (a === "cancel") { composing = false; draft = ""; render(); }
    else if (a === "edit") { editingId = btn.dataset.id; composing = false; render(); }
    else if (a === "edit-cancel") { editingId = null; render(); }
    else if (a === "edit-save") saveEdit(btn);
    else if (a === "remove") remove(btn.dataset.id);
  });

  card.addEventListener("input", (e) => {
    if (e.target.matches("[data-pn-draft]")) draft = e.target.value;
  });

  card.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    if (e.target.matches("[data-pn-draft]")) { e.preventDefault(); saveNew(body.querySelector('[data-pn="save"]')); }
    if (e.target.matches("[data-pn-edit]")) { e.preventDefault(); saveEdit(body.querySelector('[data-pn="edit-save"]')); }
  });

  reload();
  return { reload };
}