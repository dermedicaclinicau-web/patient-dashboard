// Patient tags: short labels on a patient ("Doesn't live in Perth", "Prefers text"), shown on their Recall cards and the
// patient page. The clinic's list is in ui_settings/patient_tags. Changes go through Apps Script (action "recall"), so every
// recall card for the patient gets the tags and a History line.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";

export const TAG_COLORS = ["teal", "blue", "violet", "amber", "red", "green", "pink", "grey"];
// The same as TAG_STARTERS_ in Code.gs: the list until the clinic saves its own
export const STARTER_TAGS = [
  { id: "t_notperth", label: "Doesn't live in Perth", color: "blue" },
  { id: "t_prefertext", label: "Prefers text", color: "teal" },
  { id: "t_preferemail", label: "Prefers email", color: "violet" },
  { id: "t_callafter3", label: "Call after 3pm", color: "amber" },
  { id: "t_vip", label: "VIP", color: "pink" },
];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (list) => (Array.isArray(list) ? list : []).map((t) => ({
  id: String((t && t.id) || ""),
  label: String((t && t.label) || "").replace(/\s+/g, " ").trim().slice(0, 40),
  color: TAG_COLORS.includes(t && t.color) ? t.color : "grey",
})).filter((t) => /^t_[a-z0-9_]{2,40}$/.test(t.id) && t.label);

let libPromise = null;
export function loadTagLib(fresh = false) {
  if (!libPromise || fresh) {
    libPromise = getDoc(doc(db, "ui_settings", "patient_tags"))
      .then((s) => norm(s.exists() && Array.isArray(s.data().tags) ? s.data().tags : STARTER_TAGS))
      .catch((err) => { console.warn("Patient tags not loaded:", err); return norm(STARTER_TAGS); });
  }
  return libPromise;
}
export function setTagLib(list) { libPromise = Promise.resolve(norm(list)); }

// The coloured tags. max: how many before "+2"
export function tagChipsHtml(ids, lib, { max = 0, cls = "" } = {}) {
  const byId = new Map((lib || []).map((t) => [t.id, t]));
  const list = (ids || []).map((id) => byId.get(id)).filter(Boolean);
  if (!list.length) return "";
  const shown = max ? list.slice(0, max) : list;
  const rest = list.slice(shown.length);
  return `<span class="pt-tags ${cls}">${shown.map((t) => `<span class="pt-tag is-${t.color}">${esc(t.label)}</span>`).join("")}${
    rest.length ? `<span class="pt-tag is-more" title="${esc(rest.map((t) => t.label).join(", "))}">+${rest.length}</span>` : ""}</span>`;
}

/* ---------- The picker: tick tags, or add a new one ---------- */
let open = null;
function closePicker() {
  if (!open) return;
  const o = open;
  open = null;
  o.el.remove();
  document.removeEventListener("pointerdown", o.outside, true);
  document.removeEventListener("keydown", o.key, true);
  window.removeEventListener("hashchange", closePicker);
}

function place(el, anchor) {
  if (window.matchMedia("(max-width: 760px)").matches) {
    el.classList.add("is-sheet");
    Object.assign(el.style, { left: "8px", right: "8px", bottom: "8px", width: "auto", maxHeight: "75dvh" });
    return;
  }
  const r = anchor.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  el.style.width = `${w}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  const below = window.innerHeight - r.bottom - 14;
  if (below >= 280 || below >= r.top) { el.style.top = `${r.bottom + 6}px`; el.style.maxHeight = `${Math.max(220, below)}px`; }
  else { el.style.bottom = `${window.innerHeight - r.top + 6}px`; el.style.maxHeight = `${r.top - 14}px`; }
}

export async function openTagPicker({ anchor, patientId, name = "", current = [], onSaved } = {}) {
  if (!anchor || !patientId) return;
  if (open && open.anchor === anchor) { closePicker(); return; }
  closePicker();
  let lib = await loadTagLib();
  const sel = new Set((current || []).filter((id) => lib.some((t) => t.id === id)));
  let q = "";
  let color = "teal";
  let busy = false;

  const el = document.createElement("div");
  el.className = "tgp";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Tags");
  el.innerHTML = `<div class="tgp-head"><strong>Tags${name ? ` for ${esc(name)}` : ""}</strong></div>
    <input type="search" class="fe-input tgp-q" placeholder="Find or add a tag" maxlength="40" aria-label="Find or add a tag" />
    <div class="tgp-body"></div>
    <div class="tgp-foot"><button type="button" class="lh-btn is-quiet" data-tg="cancel">Cancel</button>
      <button type="button" class="btn-primary" data-tg="save">Save</button></div>`;
  document.body.appendChild(el);
  place(el, anchor);
  const input = el.querySelector(".tgp-q");
  const body = el.querySelector(".tgp-body");
  const saveBtn = el.querySelector('[data-tg="save"]');

  const drawBody = () => {
    const ql = q.trim().toLowerCase();
    const list = lib.filter((t) => !ql || t.label.toLowerCase().includes(ql));
    const exact = lib.some((t) => t.label.toLowerCase() === ql);
    body.innerHTML = `<div class="tgp-list">${list.map((t) => `<label class="tgp-item">
        <input type="checkbox" data-id="${esc(t.id)}"${sel.has(t.id) ? " checked" : ""} />
        <span class="pt-tag is-${t.color}">${esc(t.label)}</span></label>`).join("") || '<p class="muted tgp-none">No tags match.</p>'}</div>
      ${ql.length >= 2 && !exact ? `<div class="tgp-new">
        <span>Add <strong>${esc(q.trim())}</strong> as a new tag</span>
        <div class="tgp-colors">${TAG_COLORS.map((c) => `<button type="button" class="tgp-color is-${c}${c === color ? " is-on" : ""}"
          data-color="${c}" aria-label="${c}" aria-pressed="${c === color}"></button>`).join("")}</div>
        <button type="button" class="lh-btn" data-tg="new"${busy ? " disabled" : ""}>${busy ? "Adding…" : "Add tag"}</button></div>` : ""}`;
  };

  async function addNew() {
    const label = q.trim();
    if (busy || label.length < 2) return;
    busy = true;
    drawBody();
    try {
      const r = await callApi({ action: "recall", op: "tagNew", label, color });
      if (r.problem) { showToast(r.problem); return; }
      setTagLib(r.tags);
      lib = await loadTagLib();
      if (r.tag) sel.add(r.tag.id);
      q = "";
      input.value = "";
    } catch (err) {
      showToast((err && err.message) || "Couldn't add the tag.");
    } finally {
      busy = false;
      if (el.isConnected) { drawBody(); input.focus(); }
    }
  }

  async function save() {
    if (busy) return;
    busy = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const r = await callApi({ action: "recall", op: "tagSet", patientId, tags: [...sel] });
      if (r.problem) { showToast(r.problem); return; }
      closePicker();
      if (onSaved) onSaved(r.tags || [...sel]);
    } catch (err) {
      showToast((err && err.message) || "Couldn't save the tags.");
    } finally {
      busy = false;
      if (el.isConnected) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
    }
  }

  input.addEventListener("input", () => { q = input.value; drawBody(); });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const ql = q.trim().toLowerCase();
    const hit = lib.find((t) => t.label.toLowerCase() === ql);
    if (hit) { sel.add(hit.id); q = ""; input.value = ""; drawBody(); } else addNew();
  });
  el.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-id]");
    if (cb) { if (cb.checked) sel.add(cb.dataset.id); else sel.delete(cb.dataset.id); }
  });
  el.addEventListener("click", (e) => {
    const c = e.target.closest("[data-color]");
    if (c) { color = c.dataset.color; drawBody(); return; }
    const b = e.target.closest("[data-tg]");
    if (!b) return;
    if (b.dataset.tg === "cancel") closePicker();
    else if (b.dataset.tg === "new") addNew();
    else if (b.dataset.tg === "save") save();
  });
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePicker(); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); closePicker(); anchor.focus(); } };
  open = { el, anchor, outside, key };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("hashchange", closePicker);
  drawBody();
  if (window.matchMedia("(pointer: fine)").matches) input.focus();
}