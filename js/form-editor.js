import { escapeHtml } from "./utils.js";
import { categoryLabel, getFormTemplate, saveFormTemplate } from "./form-templates.js";

const esc = escapeHtml;
const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

const I = {
  patient: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M15 9h2M15 13h2M7 16h10"/>',
  short_text: '<path d="M4 7V4h16v3"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  long_text: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="3" y2="12"/><line x1="15" y1="18" x2="3" y2="18"/>',
  date: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  single_choice: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  checkboxes: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  dropdown: '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="9 11 12 14 15 11"/>',
  signature: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  text_block: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  space: '<line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/>',
  up: '<polyline points="18 15 12 9 6 15"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
};

const TYPES = {
  patient:       { name: "Patient details", label: "Patient details" },
  short_text:    { name: "Short answer",    label: "Untitled question" },
  long_text:     { name: "Long answer",     label: "Untitled question" },
  date:          { name: "Date",            label: "Date" },
  single_choice: { name: "Single choice",   label: "Untitled question" },
  checkboxes:    { name: "Checkboxes",      label: "Untitled question" },
  dropdown:      { name: "Dropdown",        label: "Untitled question" },
  signature:     { name: "Signature",       label: "Patient signature" },
  text_block:    { name: "Text block",      label: "Information" },
  space:         { name: "Space",           label: "" },
};

const GROUPS = [
  ["Patient and visit", ["patient", "short_text", "long_text", "date"]],
  ["Choices", ["single_choice", "checkboxes", "dropdown"]],
  ["Signing and layout", ["signature", "text_block", "space"]],
];

const CHOICE = ["single_choice", "checkboxes", "dropdown"];

const FILLS = {
  "": "Nothing, staff type it",
  "patient.name": "Patient full name",
  "patient.firstName": "Patient first name",
  "patient.lastName": "Patient last name",
  "patient.dob": "Date of birth",
  "patient.email": "Patient email",
  "patient.mobile": "Patient mobile",
  "patient.address": "Patient address",
  "today": "Today's date",
  "staff.name": "Staff member filling it in",
};
const FILLS_FOR = {
  short_text: ["", "patient.name", "patient.firstName", "patient.lastName", "patient.email", "patient.mobile", "patient.address", "staff.name"],
  long_text: ["", "patient.address"],
  date: ["", "today", "patient.dob"],
};

function newId() {
  const r = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return "f_" + r.slice(0, 10);
}

function newField(type) {
  const f = { id: newId(), type, label: TYPES[type].label, help: "", required: false };
  if (CHOICE.includes(type)) f.options = ["Option 1", "Option 2"];
  if (type === "patient" || type === "signature") f.required = true;
  if (type === "text_block") f.text = "";
  if (type === "space") f.size = "medium";
  return f;
}

const multiline = (s) => esc(s).replace(/\n/g, "<br>");

// One renderer for both Build and Preview. In Build the inputs are inert,
// so clicking a question selects it instead of typing into it.
function fieldBody(f, live) {
  const inert = live ? "" : ' tabindex="-1"';
  const q = `<div class="fe-q">${esc(f.label || (TYPES[f.type] || {}).label || "Untitled question")}${
    f.required ? '<span class="fe-req" aria-label="required">*</span>' : ""}</div>`;
  const help = f.help ? `<div class="fe-help">${esc(f.help)}</div>` : "";
  const opts = Array.isArray(f.options) && f.options.length ? f.options : ["Option 1"];

  switch (f.type) {
    case "short_text": return q + help + `<input class="fe-in" type="text"${inert} />`;
    case "long_text":  return q + help + `<textarea class="fe-in" rows="3"${inert}></textarea>`;
    case "date":       return q + help + `<input class="fe-in fe-in-date" type="date"${inert} />`;
    case "dropdown":
      return q + help + `<select class="fe-in"${inert}><option value="">Choose one</option>${
        opts.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    case "single_choice":
    case "checkboxes": {
      const t = f.type === "single_choice" ? "radio" : "checkbox";
      return q + help + `<div class="fe-opts">${opts.map((o) =>
        `<label class="fe-opt"><input type="${t}" name="${esc(f.id)}"${inert} /><span>${esc(o)}</span></label>`).join("")}</div>`;
    }
    case "signature":
      return q + help + '<div class="fe-sig"><span>Sign here</span></div>';
    case "patient":
      return q + `<div class="fe-patient">${["Full name", "Date of birth", "Address"].map((l) =>
        `<label><small>${l}</small><input class="fe-in" type="text"${inert} /></label>`).join("")}</div>` +
        '<div class="fe-help fe-help-after">Filled in from the patient\'s record.</div>';
    case "text_block":
      return `<div class="fe-block">${f.label ? `<div class="fe-block-h">${esc(f.label)}</div>` : ""}${
        f.text ? `<p>${multiline(f.text)}</p>`
               : live ? "" : '<p class="fe-ph">Click to write the information patients need to read.</p>'}</div>`;
    case "space":
      return `<div class="fe-space is-${esc(f.size || "medium")}"></div>`;
    default:
      return "";
  }
}

export async function mountFormEditor(container, { templateId, staff }) {
  const back = '<a class="back-link" href="#/forms">← All forms</a>';
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = back + '<div class="skeleton" style="height:420px;border-radius:14px"></div>';
  container.replaceChildren(root);

  let tpl;
  try {
    tpl = await getFormTemplate(templateId);
  } catch (err) {
    console.error("Form load failed:", err);
    if (root.isConnected) {
      root.innerHTML = back + `<div class="state error"><strong>Couldn't open this form</strong>${
        err && err.code === "permission-denied" ? "Only admins can edit forms." : "Check your connection and try again."}</div>`;
    }
    return;
  }
  if (!root.isConnected) return; // left the page while it was loading
  if (!tpl) {
    root.innerHTML = back + '<div class="state"><strong>Form not found</strong>It may have been removed. Go back to the list to choose another.</div>';
    return;
  }

  /* ---------- State ---------- */
  let name = tpl.name;
  const fields = JSON.parse(JSON.stringify(tpl.fields || []));
  fields.forEach((f) => {
    if (!f.id) f.id = newId();
    if (CHOICE.includes(f.type) && !(Array.isArray(f.options) && f.options.length)) f.options = ["Option 1"];
  });
  let sel = fields.length ? fields[0].id : null;
  let mode = "build";
  let dirty = false, saving = false, saveTimer = null;

  root.innerHTML = `
    ${back}
    <div class="fe-top">
      <div class="fe-top-main">
        <input class="fe-name" data-role="name" maxlength="120" aria-label="Form name" value="${esc(name)}" />
        <div class="fe-sub">
          <span>${esc(categoryLabel(tpl.category))}</span>
          <span class="fb-pill ${tpl.status === "live" ? "is-live" : "is-draft"}">${tpl.status === "live" ? "Live" : "Draft"}</span>
          <span class="fe-state" data-role="state">All changes saved</span>
        </div>
      </div>
      <div class="pt-tabs fe-modes" role="group" aria-label="View">
        <button type="button" data-mode="build" class="active">Build</button>
        <button type="button" data-mode="preview">Preview</button>
      </div>
    </div>
    <div class="fe-shell is-build" data-role="shell">
      <aside class="fe-palette" aria-label="Add a question">
        <p class="fe-pal-hint">Click to add, or drag onto the page</p>
        ${GROUPS.map(([g, types]) => `
          <div class="fe-pal-group">
            <div class="fe-pal-title">${g}</div>
            ${types.map((t) => `<button type="button" class="fe-pal-item" draggable="true" data-add="${t}">${svg(I[t])}<span>${TYPES[t].name}</span></button>`).join("")}
          </div>`).join("")}
      </aside>
      <div class="fe-stage" data-role="stage"></div>
      <aside class="fe-inspector" data-role="inspector" aria-label="Question settings"></aside>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const shell = $('[data-role="shell"]');
  const stage = $('[data-role="stage"]');
  const insp = $('[data-role="inspector"]');
  const stateEl = $('[data-role="state"]');
  const nameInput = $('[data-role="name"]');
  const current = () => fields.find((f) => f.id === sel) || null;

  /* ---------- Saving ---------- */
  function setState(s, msg) {
    stateEl.className = "fe-state is-" + s;
    stateEl.innerHTML =
      s === "saving" ? "Saving…" :
      s === "dirty" ? "Unsaved changes" :
      s === "error" ? `${esc(msg || "Couldn't save.")} <button type="button" class="fe-retry" data-act="retry">Try again</button>` :
      "All changes saved";
  }

  function changed() {
    dirty = true;
    setState("dirty");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 900);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!dirty || saving) return;
    saving = true;
    dirty = false;
    setState("saving");
    try {
      await saveFormTemplate(templateId, { name, fields }, staff);
      setState(dirty ? "dirty" : "saved");
    } catch (err) {
      console.error("Form save failed:", err);
      dirty = true;
      setState("error", err.code === "permission-denied" ? "You don't have permission to edit this form."
        : err.code ? "Couldn't save." : err.message);
    } finally {
      saving = false;
      if (dirty && stateEl.className !== "fe-state is-error") saveTimer = setTimeout(flush, 400);
    }
  }

  const onBeforeUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ""; } };
  const onHashChange = () => {
    if (root.isConnected) return;      // still on this page
    flush();                           // left the editor: save what's pending
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("hashchange", onHashChange);

  /* ---------- Rendering ---------- */
  function renderStage() {
    const build = mode === "build";
    const items = fields.map((f, i) => {
      if (!build) return `<div class="fe-field">${fieldBody(f, true)}</div>`;
      const on = f.id === sel;
      return `
        <div class="fe-field${on ? " is-selected" : ""}" data-id="${esc(f.id)}" draggable="true" tabindex="0"
             aria-label="${esc((TYPES[f.type] || {}).name || "Question")}: ${esc(f.label || "")}">
          ${fieldBody(f, false)}
          ${f.fill ? `<div class="fe-chips"><span class="fe-chip">${svg(I.user)}Auto-filled: ${esc(FILLS[f.fill] || f.fill)}</span></div>` : ""}
          ${on ? `
          <div class="fe-tools">
            <button type="button" data-tool="up" aria-label="Move up"${i === 0 ? " disabled" : ""}>${svg(I.up)}</button>
            <button type="button" data-tool="down" aria-label="Move down"${i === fields.length - 1 ? " disabled" : ""}>${svg(I.down)}</button>
            <button type="button" data-tool="copy" aria-label="Duplicate">${svg(I.copy)}</button>
            <button type="button" data-tool="remove" aria-label="Remove">${svg(I.trash)}</button>
          </div>` : ""}
        </div>`;
    }).join("");

    const empty = build
      ? '<div class="fe-empty">Add your first question from the panel on the left, or drag one onto the page.</div>'
      : '<div class="fe-empty">This form has no questions yet.</div>';

    stage.innerHTML = `
      <div class="fe-sheet" data-role="sheet">
        <div class="fe-letter">
          <span class="fe-brand">Dermedica</span>
          <span class="fe-addr">Unit 4/91 Scarborough Beach Rd, Scarborough WA 6019</span>
        </div>
        <h3 class="fe-title">${esc(name || "Untitled form")}</h3>
        <div class="fe-fields" data-role="fields">${items || empty}</div>
      </div>`;
  }

  const setting = (label, control, note = "") =>
    `<label class="fe-insp-field"><span class="fe-insp-label">${label}</span>${control}${
      note ? `<small class="fe-note">${note}</small>` : ""}</label>`;

  function renderInspector() {
    const f = current();
    if (!f) {
      insp.innerHTML = '<div class="fe-insp-empty"><strong>No question selected</strong>Click a question on the page to change it.</div>';
      return;
    }
    const t = TYPES[f.type] || { name: f.type };
    let h = `<div class="fe-insp-head">${svg(I[f.type] || I.short_text)}<span>${esc(t.name)}</span></div>`;

    if (f.type === "space") {
      h += setting("Height", `<select class="fb-select" data-k="size">${["small", "medium", "large"].map((s) =>
        `<option value="${s}"${(f.size || "medium") === s ? " selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select>`);
    } else {
      h += setting(f.type === "text_block" ? "Heading" : "Question",
        `<input class="fe-input" data-k="label" maxlength="300" value="${esc(f.label)}" />`);
      if (f.type === "text_block") {
        h += setting("Text", `<textarea class="fe-input" data-k="text" rows="9" maxlength="5000" placeholder="Information patients need to read before signing">${esc(f.text || "")}</textarea>`);
      } else if (f.type !== "patient") {
        h += setting("Help text", `<input class="fe-input" data-k="help" maxlength="500" placeholder="Shown under the question" value="${esc(f.help)}" />`);
      }
    }

    if (CHOICE.includes(f.type)) {
      h += `<div class="fe-insp-field"><span class="fe-insp-label">Answer choices</span>
        <ul class="fe-opt-list">${f.options.map((o, i) => `
          <li>
            <input class="fe-input" data-opt="${i}" maxlength="200" value="${esc(o)}" aria-label="Choice ${i + 1}" />
            <button type="button" class="hx-x" data-optdel="${i}" aria-label="Remove choice ${i + 1}">${svg(I.x)}</button>
          </li>`).join("")}</ul>
        <button type="button" class="hx-add" data-act="optadd">+ Add a choice</button></div>`;
    }

    if (FILLS_FOR[f.type]) {
      h += setting("Fill in automatically",
        `<select class="fb-select" data-k="fill">${FILLS_FOR[f.type].map((k) =>
          `<option value="${k}"${(f.fill || "") === k ? " selected" : ""}>${esc(FILLS[k])}</option>`).join("")}</select>`,
        f.fill ? "Staff can still change it before saving." : "");
    }

    if (!["text_block", "space"].includes(f.type)) {
      h += `<label class="fe-check"><input type="checkbox" data-k="required"${f.required ? " checked" : ""} /> Answer required</label>`;
    }
    h += `<button type="button" class="fe-remove" data-tool="remove">${svg(I.trash)}Remove question</button>`;
    insp.innerHTML = h;
  }

  /* ---------- Actions ---------- */
  function select(id) {
    if (id === sel) return;
    sel = id;
    renderStage();
    renderInspector();
  }

  function addField(type, at) {
    const f = newField(type);
    let i = at;
    if (i == null) {
      const s = fields.findIndex((x) => x.id === sel);
      i = s > -1 ? s + 1 : fields.length;
    }
    fields.splice(Math.max(0, Math.min(i, fields.length)), 0, f);
    sel = f.id;
    changed();
    renderStage();
    renderInspector();
    const el = stage.querySelector(`[data-id="${f.id}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const label = insp.querySelector('[data-k="label"]');
    if (label && f.type !== "patient") { label.focus(); label.select(); }
  }

  let toastEl = null, toastTimer = null;
  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) { toastEl.remove(); toastEl = null; }
  }
  function showUndo(field, index) {
    hideToast();
    toastEl = document.createElement("div");
    toastEl.className = "fe-toast";
    toastEl.setAttribute("role", "status");
    toastEl.innerHTML = '<span>Question removed</span><button type="button">Undo</button>';
    toastEl.querySelector("button").addEventListener("click", () => {
      fields.splice(Math.min(index, fields.length), 0, field);
      sel = field.id;
      hideToast();
      changed();
      renderStage();
      renderInspector();
    });
    root.appendChild(toastEl);
    toastTimer = setTimeout(hideToast, 7000);
  }

  function tool(name, id) {
    const i = fields.findIndex((f) => f.id === id);
    if (i < 0) return;
    if (name === "up" && i > 0) {
      [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
    } else if (name === "down" && i < fields.length - 1) {
      [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]];
    } else if (name === "copy") {
      const c = JSON.parse(JSON.stringify(fields[i]));
      c.id = newId();
      fields.splice(i + 1, 0, c);
      sel = c.id;
    } else if (name === "remove") {
      const [gone] = fields.splice(i, 1);
      sel = fields[i] ? fields[i].id : fields[i - 1] ? fields[i - 1].id : null;
      showUndo(gone, i);
    } else {
      return;
    }
    changed();
    renderStage();
    renderInspector();
  }

  /* ---------- Events ---------- */
  root.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (m) {
      mode = m.dataset.mode;
      root.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b === m));
      shell.classList.toggle("is-build", mode === "build");
      shell.classList.toggle("is-preview", mode === "preview");
      renderStage();
      return;
    }
    if (e.target.closest('[data-act="retry"]')) { dirty = true; flush(); return; }
    const add = e.target.closest("[data-add]");
    if (add) { addField(add.dataset.add); }
  });

  stage.addEventListener("click", (e) => {
    if (mode !== "build") return;
    const fieldEl = e.target.closest(".fe-field[data-id]");
    if (!fieldEl) return;
    const t = e.target.closest("[data-tool]");
    if (t) { tool(t.dataset.tool, fieldEl.dataset.id); return; }
    select(fieldEl.dataset.id);
  });

  stage.addEventListener("keydown", (e) => {
    const fieldEl = e.target.closest(".fe-field[data-id]");
    if (fieldEl && e.target === fieldEl && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      select(fieldEl.dataset.id);
      const label = insp.querySelector('[data-k="label"]');
      if (label) label.focus();
    }
  });

  insp.addEventListener("input", (e) => {
    const f = current();
    if (!f) return;
    const el = e.target;
    if (el.dataset.opt != null) {
      f.options[Number(el.dataset.opt)] = el.value;
    } else if (el.dataset.k === "required") {
      f.required = el.checked;
    } else if (el.dataset.k) {
      f[el.dataset.k] = el.value;
    } else {
      return;
    }
    changed();
    renderStage();
  });

  insp.addEventListener("click", (e) => {
    const f = current();
    if (!f) return;
    const del = e.target.closest("[data-optdel]");
    if (del) {
      if (f.options.length > 1) {
        f.options.splice(Number(del.dataset.optdel), 1);
        changed(); renderStage(); renderInspector();
      }
      return;
    }
    if (e.target.closest('[data-act="optadd"]')) {
      f.options.push(`Option ${f.options.length + 1}`);
      changed(); renderStage(); renderInspector();
      const inputs = insp.querySelectorAll("[data-opt]");
      const last = inputs[inputs.length - 1];
      if (last) { last.focus(); last.select(); }
      return;
    }
    if (e.target.closest('[data-tool="remove"]')) tool("remove", f.id);
  });

  nameInput.addEventListener("input", () => {
    name = nameInput.value;
    const title = stage.querySelector(".fe-title");
    if (title) title.textContent = name || "Untitled form";
    changed();
  });
  nameInput.addEventListener("blur", () => {
    if (!nameInput.value.trim()) {
      name = "Untitled form";
      nameInput.value = name;
      changed();
    }
  });

  /* ---------- Drag and drop ---------- */
  let drag = null, dropAt = null;

  function clearLine() {
    const old = stage.querySelector(".fe-dropline");
    if (old) old.remove();
  }
  function endDrag() { drag = null; dropAt = null; clearLine(); }

  root.addEventListener("dragstart", (e) => {
    const p = e.target.closest("[data-add]");
    const f = e.target.closest(".fe-field[data-id]");
    if (p) drag = { type: p.dataset.add };
    else if (f && mode === "build") drag = { id: f.dataset.id };
    else return;
    e.dataTransfer.effectAllowed = drag.type ? "copy" : "move";
    e.dataTransfer.setData("text/plain", drag.type || drag.id);
  });

  stage.addEventListener("dragover", (e) => {
    if (!drag || mode !== "build") return;
    const list = stage.querySelector('[data-role="fields"]');
    if (!list) return;
    e.preventDefault();
    const items = [...list.querySelectorAll(".fe-field[data-id]")];
    let i = items.length;
    for (let k = 0; k < items.length; k++) {
      const r = items[k].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { i = k; break; }
    }
    if (i === dropAt && stage.querySelector(".fe-dropline")) return;
    dropAt = i;
    clearLine();
    const line = document.createElement("div");
    line.className = "fe-dropline";
    if (items[i]) list.insertBefore(line, items[i]); else list.appendChild(line);
  });

  stage.addEventListener("drop", (e) => {
    if (!drag || dropAt == null) return;
    e.preventDefault();
    if (drag.type) {
      const t = drag.type, at = dropAt;
      endDrag();
      addField(t, at);
      return;
    }
    const from = fields.findIndex((f) => f.id === drag.id);
    let to = dropAt;
    endDrag();
    if (from < 0) return;
    if (to > from) to--;
    if (to !== from) {
      const [moved] = fields.splice(from, 1);
      fields.splice(to, 0, moved);
      sel = moved.id;
      changed();
    }
    renderStage();
    renderInspector();
  });

  root.addEventListener("dragend", endDrag);

  /* ---------- Start ---------- */
  renderStage();
  renderInspector();
}