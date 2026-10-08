import {
  categoryLabel, getFormTemplate, getFormVersion, saveFormTemplate, publishFormTemplate,
  formSnapshot, listFormTemplates, getLetterhead, saveLetterhead,
} from "./form-templates.js";
import {
  esc, svg, ICONS, FIELD_TYPES, FIELD_GROUPS, CHOICE_TYPES, FILLS, FILLS_FOR,
  createField, normaliseField, renderField, fieldSettings, applyInput, applyClick,
  calcStatusHtml, checkFormula, canRequire, hasLabel, hasHelp, watermarkHtml,
} from "./form-fields.js";
import { evaluateCalcs, formatCalc } from "./form-calc.js";
import { DEFAULT_LETTERHEAD, letterheadHtml, openLetterheadDialog } from "./form-letterhead.js";
import { openPrinterDialog } from "./form-delivery.js";
import { conditionSettingsHtml, applyConditionInput, applyConditionClick, conditionSummary, conditionProblem } from "./form-conditions.js";
import { applyVisibility } from "./form-fill.js";
import { CATEGORIES, categorize } from "./records.js";
import { formTitleHtml } from "./form-fields.js";
import { openImagePicker } from "./image-bank.js";
import { bankUpload, bankError, hydrateBankImages } from "./image-bank-api.js";

const UI = {
  up: '<polyline points="18 15 12 9 6 15"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  x: ICONS.x,
};

const FORM = "__form"; // "selected" value meaning the form settings panel is open
const LAYOUT_ONLY = ["text_block", "space", "letterhead", "watermark"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (d) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

function newId() {
  const r = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return "f_" + r.slice(0, 10);
}

function confirmDialog({ title, message, confirm, tone = "danger" }) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog fe-confirm";
    dlg.innerHTML = `
      <div class="lh-form">
        <div class="lh-dialog-head"><h3>${esc(title)}</h3><p>${esc(message)}</p></div>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="no">Cancel</button>
          <button type="button" class="lh-btn ${tone === "danger" ? "is-danger" : "is-primary"}" data-act="yes">${esc(confirm)}</button>
        </div>
      </div>`;
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="yes"]')) { result = true; dlg.close(); }
      else if (e.target.closest('[data-act="no"]')) dlg.close();
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector('[data-act="no"]').focus();
  });
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
  if (!root.isConnected) return;
  if (!tpl || tpl.status === "archived") {
    root.innerHTML = back + '<div class="state"><strong>This form has been deleted</strong>Go back to the list to choose another form.</div>';
    return;
  }

  /* ---------- State ---------- */
  let name = tpl.name;
  const settings = { showLetterhead: true, ...(tpl.settings || {}) };
  const fields = (tpl.fields || [])
    .map((f) => normaliseField(f && f.id ? f : { ...f, id: newId() }))
    .filter(Boolean);
  let sel = fields.length ? fields[0].id : FORM;
  let mode = "build";
  let consentForms = [];
  let letterhead = DEFAULT_LETTERHEAD;
  let dirty = false, saving = false, saveTimer = null;

  // Publishing
  let status = tpl.status;
  let version = tpl.version;
  let publishedAt = tpl.publishedAt || null;
  let publishedSig = version > 0 ? null : ""; // null = still loading the published copy
  let publishing = false;

  const ctx = (live) => ({ live, fields, consentForms, letterhead, calcValues: null });
  const current = () => fields.find((f) => f.id === sel) || null;
  const signature = () => JSON.stringify(formSnapshot({ name, fields, settings }));

  root.innerHTML = `
    ${back}
    <div class="fe-top">
      <div class="fe-top-main">
        <input class="fe-name" data-role="name" maxlength="120" aria-label="Form name" value="${esc(name)}" />
        <div class="fe-sub">
          <span>${esc(categoryLabel(tpl.category))}</span>
          <span class="fb-pill" data-role="pill"></span>
          <span class="fe-state" data-role="state">All changes saved</span>
        </div>
      </div>
      <div class="fe-top-actions">
        <div class="pt-tabs fe-modes" role="group" aria-label="View">
          <button type="button" data-mode="build" class="active">Build</button>
          <button type="button" data-mode="preview">Preview</button>
        </div>
        <button type="button" class="btn-ghost fe-savenow" data-act="save-now" data-role="savenow" disabled>Save draft</button>
        <button type="button" class="btn-primary fe-publish" data-act="publish" data-role="publish">Publish</button>
      </div>
    </div>
    <div class="fe-shell is-build" data-role="shell">
      <aside class="fe-palette" aria-label="Add a question">
        <input type="search" class="fe-input fe-pal-search" data-role="palsearch" placeholder="Search fields" aria-label="Search fields" />
        <p class="fe-pal-hint">Click to add, or drag onto the page</p>
        ${FIELD_GROUPS.map(([g, types]) => `
          <div class="fe-pal-group" data-group>
            <div class="fe-pal-title">${esc(g)}</div>
            ${types.map((t) => {
              const d = FIELD_TYPES[t];
              return `<button type="button" class="fe-pal-item" draggable="true" data-add="${t}"
                        data-find="${esc((d.name + " " + d.was).toLowerCase())}"
                        ${d.was !== d.name ? `title="Called “${esc(d.was)}” in the old builder"` : ""}>
                        ${svg(ICONS[t])}<span>${esc(d.name)}</span></button>`;
            }).join("")}
          </div>`).join("")}
        <p class="fe-pal-none" data-role="palnone" hidden>No fields match that search.</p>
      </aside>
      <div class="fe-stage" data-role="stage"></div>
      <aside class="fe-inspector" data-role="inspector" aria-label="Settings"></aside>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const shell = $('[data-role="shell"]');
  const stage = $('[data-role="stage"]');
  const insp = $('[data-role="inspector"]');
  const stateEl = $('[data-role="state"]');
  const nameInput = $('[data-role="name"]');

  /* ---------- Saving ---------- */
  function setState(s, msg) {
    stateEl.className = "fe-state is-" + s;
    stateEl.innerHTML =
      s === "saving" ? "Saving…" :
      s === "dirty" ? "Unsaved changes" :
      s === "error" ? `${esc(msg || "Couldn't save.")} <button type="button" class="fe-retry" data-act="retry">Try again</button>` :
      "All changes saved";
    const sn = root.querySelector('[data-role="savenow"]');
    if (sn) { sn.disabled = s === "saved" || s === "saving"; sn.textContent = s === "saving" ? "Saving…" : s === "saved" ? "Saved" : "Save draft"; }
  }

  function changed() {
    dirty = true;
    setState("dirty");
    renderPublish();
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
      await saveFormTemplate(templateId, { name, fields, settings }, staff);
      setState(dirty ? "dirty" : "saved");
    } catch (err) {
      console.error("Form save failed:", err);
      dirty = true;
      setState("error", err.code === "permission-denied" ? "You don't have permission to edit this form."
        : err.code ? "Couldn't save." : err.message);
    } finally {
      saving = false;
      if (dirty && !stateEl.classList.contains("is-error")) saveTimer = setTimeout(flush, 400);
    }
  }

  async function settle() {
    clearTimeout(saveTimer);
    while (saving) await wait(100);
  }

  const onBeforeUnload = (e) => { if (dirty || saving || publishing) { e.preventDefault(); e.returnValue = ""; } };
  const onHashChange = () => {
    if (root.isConnected) return;
    flush();
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("hashchange", onHashChange);

  /* ---------- Publishing ---------- */
  function renderPublish() {
    const live = status === "live";
    const pill = $('[data-role="pill"]');
    pill.className = "fb-pill " + (live ? "is-live" : "is-draft");
    pill.textContent = live ? `Live · version ${version}` : "Draft";

    const btn = $('[data-role="publish"]');
    let label = "Publish", disabled = false, title = "";
    if (publishing) { label = "Publishing…"; disabled = true; }
    else if (!live) { label = "Publish"; title = "Put this form on the patient dashboard"; }
    else if (publishedSig === null) { label = "Publish changes"; disabled = true; }
    else if (signature() !== publishedSig) { label = "Publish changes"; title = "Staff are still using version " + version; }
    else { label = "Published"; disabled = true; title = "Staff are using the latest version"; }
    btn.textContent = label;
    btn.disabled = disabled;
    btn.title = title;
    btn.classList.toggle("is-done", label === "Published");
  }

  // The first thing that would stop the form working for staff, or null
  function publishProblem() {
    if (!fields.some((f) => !LAYOUT_ONLY.includes(f.type))) {
      return { msg: "Add at least one question before publishing." };
    }
    for (const f of fields) {
      const cp = conditionProblem(f, fields);
      if (cp) return { id: f.id, msg: `“${label || FIELD_TYPES[f.type].name}”: ${cp}` };
      const label = String(f.label || "").trim();
      if (hasLabel(f.type) && f.type !== "text_block" && !label) {
        return { id: f.id, msg: "Every question needs a name. Add one to the highlighted question." };
      }
      if (CHOICE_TYPES.includes(f.type) && !f.options.some((o) => String(o).trim())) {
        return { id: f.id, msg: `“${label}” needs at least one answer choice.` };
      }
      if (f.type === "calculation") {
        const c = checkFormula(f, fields);
        if (!c.ok) return { id: f.id, msg: `“${label || "Calculation"}”: ${c.error}` };
      }
      if (f.type === "consent_status" && !f.consentFormId) {
        return { id: f.id, msg: "Choose which consent form the Consent check looks for." };
      }
    }
    return null;
  }

  async function publish() {
    if (publishing) return;
    const problem = publishProblem();
    if (problem) {
      if (problem.id) {
        setMode("build");
        sel = problem.id;
        renderStage();
        renderInspector();
        const el = stage.querySelector(`[data-id="${problem.id}"]`);
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      showToast(problem.msg);
      return;
    }
    if (status === "live") {
      const ok = await confirmDialog({
        title: "Publish these changes?",
        message: `Staff will use version ${version + 1} straight away. Forms already filled in keep the version they were filled from.`,
        confirm: "Publish changes",
        tone: "primary",
      });
      if (!ok || !root.isConnected) return;
    }

    publishing = true;
    renderPublish();
    await settle();
    const sigAtPublish = signature();
    try {
      version = await publishFormTemplate(templateId, { name, fields, settings }, staff, version);
      status = "live";
      publishedAt = new Date();
      publishedSig = sigAtPublish;
      if (signature() === sigAtPublish) { dirty = false; setState("saved"); }
      showToast(`Published. Version ${version} is now on the patient dashboard.`);
    } catch (err) {
      console.error("Publish failed:", err);
      showToast(err.code === "conflict" ? err.message
        : err.code === "permission-denied" ? "Couldn't publish. Check the new Firestore rules for form versions have been published."
        : err.code ? "Couldn't publish. Check your connection and try again." : err.message);
    } finally {
      publishing = false;
      if (root.isConnected) { renderPublish(); if (sel === FORM) renderInspector(); }
    }
  }

  async function unpublish() {
    const ok = await confirmDialog({
      title: "Take this form off the patient dashboard?",
      message: "Staff won't be able to choose it until you publish it again. It stays here as a draft, and forms already filled in are kept.",
      confirm: "Unpublish",
    });
    if (!ok || !root.isConnected) return;
    await settle();
    try {
      await saveFormTemplate(templateId, { name, fields, settings, status: "draft" }, staff);
      status = "draft";
      dirty = false;
      setState("saved");
      renderPublish();
      renderInspector();
      showToast("Unpublished. It's no longer on the patient dashboard.");
    } catch (err) {
      console.error("Unpublish failed:", err);
      showToast("Couldn't unpublish. Try again.");
    }
  }

  /* ---------- Page ---------- */
  function setMode(m) {
    mode = m;
    root.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    shell.classList.toggle("is-build", m === "build");
    shell.classList.toggle("is-preview", m === "preview");
  }

  function updateCalcs() {
    const values = evaluateCalcs(fields, (f) => {
      const w = stage.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
      if (w && w.hidden) return null; // hidden questions count as unanswered
      const el = stage.querySelector(`input[data-in="${CSS.escape(f.id)}"]`);
      return el ? el.value : null;
    });
    Object.keys(values).forEach((id) => {
      const out = stage.querySelector(`[data-calc="${CSS.escape(id)}"]`);
      const f = fields.find((x) => x.id === id);
      if (out && f) out.textContent = formatCalc(values[id], f) || "—";
    });
    return values;
  }

  // Preview: questions appear and disappear as answers change, like the real form
  function refreshPreview() {
    if (mode !== "preview") return;
    let calc = updateCalcs();
    applyVisibility(stage, fields, { pads: {}, calc, consent: {} });
    calc = updateCalcs();
    applyVisibility(stage, fields, { pads: {}, calc, consent: {} });
  }

  function renderStage() {
    const build = mode === "build";
    const c = ctx(!build);
    const BRANCH = '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>';
    const items = fields.map((f, i) => {
      const body = renderField(f, c);
      if (!build) return body ? `<div class="fe-field" data-fid="${esc(f.id)}">${body}</div>` : "";
      const on = f.id === sel;
      const cond = conditionSummary(f, fields);
      const condBad = cond ? conditionProblem(f, fields) : "";
      const chips = [
        f.fill && `<span class="fe-chip">${svg(UI.user)}Auto-filled: ${esc(FILLS[f.fill] || f.fill)}</span>`,
        cond && `<span class="fe-chip is-cond${condBad ? " is-bad" : ""}">${svg(BRANCH)}${esc(condBad || cond)}</span>`,
      ].filter(Boolean).join("");
      return `
        <div class="fe-field${on ? " is-selected" : ""}${cond ? " is-conditional" : ""}" data-id="${esc(f.id)}" draggable="true" tabindex="0"
             aria-label="${esc(FIELD_TYPES[f.type].name)}${f.label ? ": " + esc(f.label) : ""}">
          ${body}
          ${chips ? `<div class="fe-chips">${chips}</div>` : ""}
          ${on ? `
          <div class="fe-tools">
            <button type="button" data-tool="up" aria-label="Move up"${i === 0 ? " disabled" : ""}>${svg(UI.up)}</button>
            <button type="button" data-tool="down" aria-label="Move down"${i === fields.length - 1 ? " disabled" : ""}>${svg(UI.down)}</button>
            <button type="button" data-tool="copy" aria-label="Duplicate">${svg(UI.copy)}</button>
            <button type="button" data-tool="remove" aria-label="Remove">${svg(UI.trash)}</button>
          </div>` : ""}
        </div>`;
    }).join("");

    const empty = build
      ? '<div class="fe-empty">Add your first question from the panel on the left, or drag one onto the page.</div>'
      : '<div class="fe-empty">This form has no questions yet.</div>';

    const lhOn = settings.showLetterhead !== false;
    const formSel = build && sel === FORM;
    const lhBlock = lhOn
      ? `<div class="fe-lh-wrap${formSel ? " is-selected" : ""}" data-role="lh"${
          build ? ' tabindex="0" role="button" aria-label="Letterhead. Open form settings"' : ""}>${letterheadHtml(letterhead)}</div>`
      : build
        ? `<button type="button" class="fe-lh-off${formSel ? " is-selected" : ""}" data-role="lh">Letterhead is hidden on this form. Click to change.</button>`
        : "";

    stage.innerHTML = `
      <div class="fe-sheet" data-role="sheet">
        ${watermarkHtml(fields, letterhead)}
        ${lhBlock}
        ${formTitleHtml(name || "Untitled form", settings, { build, selected: formSel })}
        <div class="fe-fields" data-role="fields">${items || empty}</div>
      </div>`;

    if (!build) refreshPreview();
    hydrateBankImages(stage);
  }

  /* ---------- Settings panel ---------- */
  const setting = (label, control, note = "") =>
    `<label class="fe-insp-field"><span class="fe-insp-label">${label}</span>${control}${
      note ? `<small class="fe-note">${note}</small>` : ""}</label>`;

  function renderFormSettings() {
    const live = status === "live";
    insp.innerHTML = `
      <div class="fe-insp-head">${svg(ICONS.letterhead)}<span>Form settings</span></div>
      <div class="fe-insp-field">
        <span class="fe-insp-label">Patient dashboard</span>
        ${live
          ? `<small class="fe-note">Version ${version} is available to staff${publishedAt ? `, published ${esc(fmtDate(publishedAt))}` : ""}.</small>
             <button type="button" class="lh-btn" data-act="unpublish">Unpublish</button>`
          : `<small class="fe-note">${version
              ? "Not on the patient dashboard. Publish to make it available again."
              : "Not published yet. Click Publish at the top when it's ready."}</small>`}
      </div>
      ${["consent", "treatment"].includes(tpl.category) ? `
      <label class="fe-insp-field"><span class="fe-insp-label">Treatment group</span>
        <select class="fb-select" data-s="group">
          <option value="">Automatic, from the form name (${esc((CATEGORIES.find((c) => c.key === categorize(name)) || { title: "Other" }).title)})</option>
          ${CATEGORIES.map((c) => `<option value="${c.key}"${settings.group === c.key ? " selected" : ""}>${esc(c.title)}</option>`).join("")}
          <option value="other"${settings.group === "other" ? " selected" : ""}>Other</option>
        </select>
        <small class="fe-note">Where saved forms appear on the patient's page, and which Create Consent / Create Tx buttons offer this form.</small>
      </label>` : ""}
      <div class="fe-insp-field fe-title-settings">
        <span class="fe-insp-label">Form title</span>
        <label class="fe-check"><input type="checkbox" data-s="showTitle"${settings.showTitle !== false ? " checked" : ""} /> Show the form title</label>
        <div class="fe-two">
          <label class="fe-insp-field"><span class="fe-insp-label">Position</span>
            <select class="fb-select" data-s="titleAlign">
              ${[["left", "Left"], ["center", "Centre"], ["right", "Right"]].map(([v, l]) =>
                `<option value="${v}"${(settings.titleAlign || "left") === v ? " selected" : ""}>${l}</option>`).join("")}
            </select>
          </label>
          <label class="fe-insp-field"><span class="fe-insp-label">Size</span>
            <select class="fb-select" data-s="titleSize">
              ${[["small", "Small"], ["medium", "Medium"], ["large", "Large"]].map(([v, l]) =>
                `<option value="${v}"${(settings.titleSize || "medium") === v ? " selected" : ""}>${l}</option>`).join("")}
            </select>
          </label>
        </div>
        <label class="fe-check"><input type="checkbox" data-s="showMeta"${settings.showMeta !== false ? " checked" : ""} /> Show the patient's name and date under the title on saved forms and PDFs</label>
      </div>
      <label class="fe-check"><input type="checkbox" data-s="showLetterhead"${settings.showLetterhead !== false ? " checked" : ""} /> Show the letterhead at the top</label>
      <div class="fe-insp-field">
        <span class="fe-insp-label">Letterhead</span>
        <button type="button" class="lh-btn" data-act="edit-lh">Edit letterhead and logo</button>
        <small class="fe-note">One letterhead is shared by every form, so changes show on all of them.</small>
      </div>
      <div class="fe-insp-field">
        <span class="fe-insp-label">Printer</span>
        <button type="button" class="lh-btn" data-act="printer">Printer email address</button>
        <small class="fe-note">Used by Save &amp; print. Shared by every form.</small>
      </div>
      <p class="fe-note fe-pad">Click a question on the page to change it.</p>
      <div class="fe-danger">
        <button type="button" class="fe-remove" data-act="delete-form">${svg(UI.trash)}Delete this form</button>
      </div>`;
  }

  function renderInspector() {
    const f = current();
    if (!f) { renderFormSettings(); return; }

    let h = `<div class="fe-insp-head">${svg(ICONS[f.type])}<span>${esc(FIELD_TYPES[f.type].name)}</span></div>`;
    if (hasLabel(f.type)) {
      const lbl = f.type === "text_block" ? "Heading" : f.type === "table" ? "Table title" : "Question";
      h += setting(lbl, `<input class="fe-input" data-k="label" maxlength="300" value="${esc(f.label)}" />`);
    }
    if (hasHelp(f.type)) {
      h += setting("Help text", `<input class="fe-input" data-k="help" maxlength="500" placeholder="Shown under the question" value="${esc(f.help)}" />`);
    }
    if (CHOICE_TYPES.includes(f.type)) {
      h += `<div class="fe-insp-field"><span class="fe-insp-label">Answer choices</span>
        <ul class="fe-opt-list">${f.options.map((o, i) => `
          <li>
            <input class="fe-input" data-opt="${i}" maxlength="200" value="${esc(o)}" aria-label="Choice ${i + 1}" />
            <button type="button" class="hx-x" data-optdel="${i}" aria-label="Remove choice ${i + 1}">${svg(UI.x)}</button>
          </li>`).join("")}</ul>
        <button type="button" class="hx-add" data-act="optadd">+ Add a choice</button></div>`;
    }
    h += fieldSettings(f, ctx(false));
    if (FILLS_FOR[f.type]) {
      h += setting("Fill in automatically",
        `<select class="fb-select" data-k="fill">${FILLS_FOR[f.type].map((k) =>
          `<option value="${k}"${(f.fill || "") === k ? " selected" : ""}>${esc(FILLS[k])}</option>`).join("")}</select>`,
        f.fill ? "Staff can still change it before saving." : "");
    }
    h += conditionSettingsHtml(f, fields);
    if (canRequire(f.type)) {
      h += `<label class="fe-check"><input type="checkbox" data-k="required"${f.required ? " checked" : ""} /> Answer required</label>`;
    }
    h += `<button type="button" class="fe-remove" data-tool="remove">${svg(UI.trash)}Remove</button>`;
    insp.innerHTML = h;
    hydrateBankImages(insp);
  }

  /* ---------- Actions ---------- */
  let toastEl = null, toastTimer = null;
  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) { toastEl.remove(); toastEl = null; }
  }
  function showToast(message, undo) {
    hideToast();
    toastEl = document.createElement("div");
    toastEl.className = "fe-toast";
    toastEl.setAttribute("role", "status");
    toastEl.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button">Undo</button>' : ""}`;
    if (undo) toastEl.querySelector("button").addEventListener("click", () => { hideToast(); undo(); });
    root.appendChild(toastEl);
    toastTimer = setTimeout(hideToast, undo ? 7000 : 5000);
  }

  function select(id) {
    if (id === sel) return;
    sel = id;
    renderStage();
    renderInspector();
  }

  function addField(type, at) {
    if (type === "record_date" && fields.some((f) => f.type === "record_date")) {
      showToast("This form already has a record date.");
      return;
    }
    if (type === "watermark" && fields.some((f) => f.type === "watermark")) {
      showToast("This form already has a watermark.");
      return;
    }
    const f = createField(type, newId());
    let i = at;
    if (i === undefined || i === null) {
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

  function tool(action, id) {
    const i = fields.findIndex((f) => f.id === id);
    if (i < 0) return;
    if (action === "up" && i > 0) {
      [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
    } else if (action === "down" && i < fields.length - 1) {
      [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]];
    } else if (action === "copy") {
      if (["record_date", "watermark"].includes(fields[i].type)) { showToast("A form can only have one of these."); return; }
      const c = JSON.parse(JSON.stringify(fields[i]));
      c.id = newId();
      fields.splice(i + 1, 0, c);
      sel = c.id;
    } else if (action === "remove") {
      const [gone] = fields.splice(i, 1);
      sel = fields[i] ? fields[i].id : fields[i - 1] ? fields[i - 1].id : FORM;
      showToast("Removed", () => {
        fields.splice(Math.min(i, fields.length), 0, gone);
        sel = gone.id;
        changed();
        renderStage();
        renderInspector();
      });
    } else {
      return;
    }
    changed();
    renderStage();
    renderInspector();
  }

  function editLetterhead() {
    openLetterheadDialog({
      letterhead,
      onSave: async (lh) => {
        letterhead = await saveLetterhead(lh, staff);
        if (!root.isConnected) return;
        renderStage();
        renderInspector();
      },
    });
  }

    async function pickImage(f) {
    const img = await openImagePicker({ isAdmin: true });
    if (!img || !root.isConnected) return;
    const target = fields.find((x) => x.id === f.id);
    if (!target) return;
    target.fileId = img.id;
    target.fileName = img.name;
    if (!target.alt) target.alt = img.name.replace(/\.[^.]+$/, "");
    changed(); renderStage(); renderInspector();
  }

  async function uploadImage(f, input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!f || !file) return;
    const lbl = input.closest("label");
    if (lbl) { lbl.classList.add("is-busy"); lbl.firstChild.textContent = "Uploading…"; }
    try {
      const r = await bankUpload("", file); // saved in the top folder of the Image Bank
      f.fileId = r.image.id;
      f.fileName = r.image.name;
      if (!f.alt) f.alt = r.image.name.replace(/\.[^.]+$/, "");
      changed(); renderStage(); renderInspector();
      showToast("Uploaded to the Image Bank");
    } catch (err) {
      console.error("Image upload failed:", err);
      showToast(bankError(err));
      renderInspector();
    }
  }

  async function deleteForm() {
    const ok = await confirmDialog({
      title: `Delete “${name || "Untitled form"}”?`,
      message: "It will be removed from the form list and from the patient dashboard. Forms already filled in for patients are kept.",
      confirm: "Delete form",
    });
    if (!ok || !root.isConnected) return;
    await settle();
    try {
      await saveFormTemplate(templateId, { name, fields, settings, status: "archived" }, staff);
      dirty = false;
      await listFormTemplates({ isAdmin: true, force: true }).catch(() => {});
      location.hash = "#/forms";
    } catch (err) {
      console.error("Delete failed:", err);
      showToast(err.code === "permission-denied" ? "You don't have permission to delete this form." : "Couldn't delete. Try again.");
    }
  }

  /* ---------- Events ---------- */
  root.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (m) { setMode(m.dataset.mode); renderStage(); return; }
    if (e.target.closest('[data-act="publish"]')) { publish(); return; }
    if (e.target.closest('[data-act="save-now"]')) { dirty = true; flush(); return; }
    if (e.target.closest('[data-act="retry"]')) { dirty = true; flush(); return; }
    const add = e.target.closest("[data-add]");
    if (add) addField(add.dataset.add);
  });

  $('[data-role="palsearch"]').addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    let any = false;
    root.querySelectorAll("[data-group]").forEach((g) => {
      let shown = 0;
      g.querySelectorAll("[data-add]").forEach((b) => {
        const hit = !q || b.dataset.find.includes(q);
        b.hidden = !hit;
        if (hit) shown++;
      });
      g.hidden = !shown;
      if (shown) any = true;
    });
    $('[data-role="palnone"]').hidden = any;
  });

  stage.addEventListener("click", (e) => {
    if (mode !== "build") return;
    if (e.target.closest('[data-role="lh"], [data-role="title"]')) { select(FORM); return; }
    const fieldEl = e.target.closest(".fe-field[data-id]");
    if (!fieldEl) return;
    const t = e.target.closest("[data-tool]");
    if (t) { tool(t.dataset.tool, fieldEl.dataset.id); return; }
    select(fieldEl.dataset.id);
  });

  stage.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.matches('.fe-lh-wrap[data-role="lh"], .fe-title[data-role="title"]')) {
      e.preventDefault();
      select(FORM);
      return;
    }
    const fieldEl = e.target.closest(".fe-field[data-id]");
    if (fieldEl && e.target === fieldEl) {
      e.preventDefault();
      select(fieldEl.dataset.id);
      const first = insp.querySelector("input, textarea, select");
      if (first) first.focus();
    }
  });

  stage.addEventListener("input", refreshPreview);

  insp.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.s) {
      settings[el.dataset.s] = el.type === "checkbox" ? el.checked : el.value;
      changed();
      renderStage();
      return;
    }
    const f = current();
    if (!f) return;
    if (el.dataset.opt !== undefined) {
      f.options[Number(el.dataset.opt)] = el.value;
    } else if (el.dataset.k) {
      const k = el.dataset.k;
      if (el.type === "checkbox") {
        f[k] = el.checked;
      } else if (el.dataset.num !== undefined) {
        const optional = el.dataset.num === "optional";
        if (el.value === "") {
          if (!optional) return;
          f[k] = null;
        } else {
          let n = Number(el.value);
          if (!Number.isFinite(n)) return;
          if (!optional) n = Math.round(n);
          const lo = el.min !== "" ? Number(el.min) : -Infinity;
          const hi = el.max !== "" ? Number(el.max) : Infinity;
          f[k] = Math.max(lo, Math.min(hi, n));
        }
      } else {
        f[k] = el.value;
      }
    } else if (el.dataset.cond !== undefined || el.dataset.rule !== undefined) {
      if (!applyConditionInput(f, el, fields)) return;
    } else if (!applyInput(f, el)) {
      return;
    }
    changed();
    renderStage();
    if (el.dataset.rerender !== undefined) { renderInspector(); return; }
    if (f.type === "calculation") {
      const st = insp.querySelector('[data-role="calc-status"]');
      if (st) st.innerHTML = calcStatusHtml(f, fields);
    }
  });

  insp.addEventListener("change", (e) => {
    if (e.target.matches('input[type="file"][data-img-upload]')) { uploadImage(current(), e.target); return; }
    const f = current();
    const el = e.target;
    if (f && el.dataset.k && el.dataset.num !== undefined && el.type !== "range" && el.tagName === "INPUT") {
      el.value = f[el.dataset.k] ?? "";
    }
  });

  insp.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-calcins]")) e.preventDefault();
  });

  insp.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="edit-lh"]')) { editLetterhead(); return; }
    if (e.target.closest('[data-act="printer"]')) { openPrinterDialog(staff); return; }
    if (e.target.closest('[data-act="delete-form"]')) { deleteForm(); return; }
    if (e.target.closest('[data-act="unpublish"]')) { unpublish(); return; }
    const f = current();
    if (!f) return;

    if (e.target.closest('[data-act="img-pick"]')) { pickImage(f); return; }
    if (e.target.closest('[data-act="img-clear"]')) {
      f.fileId = ""; f.fileName = "";
      changed(); renderStage(); renderInspector();
      return;
    }

    const ins = e.target.closest("[data-calcins]");
    if (ins) {
      const ta = insp.querySelector('[data-k="formula"]');
      if (!ta) return;
      const tok = ins.dataset.calcins;
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      const before = ta.value.slice(0, start);
      const spacer = before && !/[\s(,]$/.test(before) && !/^[),]/.test(tok) ? " " : "";
      ta.value = before + spacer + tok + ta.value.slice(end);
      f.formula = ta.value;
      const pos = start + spacer.length + tok.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      changed();
      renderStage();
      const st = insp.querySelector('[data-role="calc-status"]');
      if (st) st.innerHTML = calcStatusHtml(f, fields);
      return;
    }

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
    if (applyConditionClick(f, e.target, fields)) {
      changed(); renderStage(); renderInspector();
      return;
    }
    if (applyClick(f, e.target)) {
      changed(); renderStage(); renderInspector();
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
  const clearLine = () => { const old = stage.querySelector(".fe-dropline"); if (old) old.remove(); };
  const endDrag = () => { drag = null; dropAt = null; clearLine(); };

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
    if (!drag || dropAt === null) return;
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
  renderPublish();

  // The published copy, to tell whether there are unpublished changes
  if (version > 0) {
    getFormVersion(templateId, version)
      .then((v) => { publishedSig = v ? JSON.stringify(formSnapshot(v)) : ""; })
      .catch((err) => { console.warn("Couldn't load the published version:", err); publishedSig = ""; })
      .finally(() => { if (root.isConnected) renderPublish(); });
  }

  getLetterhead()
    .then((lh) => {
      letterhead = lh;
      if (!root.isConnected) return;
      renderStage();
      const f = current();
      if (f && f.type === "watermark") renderInspector();
    })
    .catch((err) => console.warn("Couldn't load the letterhead:", err));

  listFormTemplates({ isAdmin: true })
    .then((list) => {
      consentForms = list
        .filter((t) => t.category === "consent" && t.id !== templateId)
        .map((t) => ({ id: t.id, name: t.name, status: t.status }));
      if (!root.isConnected) return;
      renderStage();
      const f = current();
      if (f && f.type === "consent_status") renderInspector();
    })
    .catch((err) => console.warn("Couldn't load consent forms:", err));
}