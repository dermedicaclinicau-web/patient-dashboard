import {
  categoryLabel, getFormTemplate, getFormVersion, saveFormTemplate, publishFormTemplate,
  formSnapshot, listFormTemplates, getLetterhead, saveLetterhead, RX_KINDS, rxKindGuess,
  FORM_CATEGORIES, changeFormCategory, formGroup, saveFormOnline,
  listFormBlocks, saveFormBlock, archiveFormBlock,
} from "./form-templates.js";
import {
  esc, svg, ICONS, FIELD_TYPES, FIELD_GROUPS, CHOICE_TYPES, FILLS, FILLS_FOR,
  createField, normaliseField, renderField, fieldSettings, applyInput, applyClick,
  calcStatusHtml, checkFormula, canRequire, hasLabel, hasHelp, watermarkHtml, iqHasOptions, isMarkImage,
  markSetIdsOf, prefillSettings, prefillSummary, renameInPrefill, tidyPrefill, subExtrasHtml,
  tableCols, tableTotal, tableClick, spanClass, tableRecalc, tableProblem, BUTTON_URL_RE, syncButtons, canLiveHide,
} from "./form-fields.js";
import { evaluateCalcs, formatCalc, calcRefs } from "./form-calc.js";
import { DEFAULT_LETTERHEAD, letterheadHtml, openLetterheadDialog } from "./form-letterhead.js";
import { openPrinterDialog } from "./form-delivery.js";
import { conditionSettingsHtml, applyConditionInput, applyConditionClick, conditionSummary, conditionProblem } from "./form-conditions.js";
import { applyVisibility, fieldTagValues } from "./form-fill.js";
import { CATEGORIES, categorize } from "./records.js";
import { TAG_TYPES, fieldTagName, tagKeyOf, formTitleHtml } from "./form-fields.js";
import { openImagePicker } from "./image-bank.js";
import { bankUpload, bankError, hydrateBankImages } from "./image-bank-api.js";
import { attachAnnotators } from "./form-annotate.js";
import { createRichEditor } from "./rich-editor.js";
import { textToRichHtml } from "./rich-html.js";
import { makeResizable } from "./panel-resize.js";
import { openDuplicateDialog } from "./form-duplicate.js";
import { listAftercare } from "./aftercare-api.js";
import { openAftercarePicker } from "./aftercare-bank.js";
import { mountAftercareField } from "./aftercare-field.js";
import { listTaskTypes } from "./task-types.js";
import { listProducts, isKitProduct } from "./inventory-api.js";
import { openProductPicker } from "./consumables-field.js";
import { listMarkingSets, openMarkingSetsDialog } from "./marking-sets.js";
import { listSpecialists, specialitiesOf } from "./specialists-api.js";
import { openSpecialistBankDialog } from "./specialist-bank.js";
import { tagPickerHtml, collectTagNodes, applyTagNodes, SAMPLE_TAGS, formFieldTags, tagUsedBy, renameTagRefs, tagRefRe } from "./form-tags.js";
import { mountRichTextField } from "./rich-field.js";
import { onlineBlockers, ONLINE_NO_CATS } from "./form-live.js";
import { listStaffDetails } from "./staff-details.js";

const UI = {
  up: '<polyline points="18 15 12 9 6 15"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  undo: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  redo: '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  block: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  x: ICONS.x,
};

const FORM = "__form"; // "selected" value meaning the form settings panel is open
const LAYOUT_ONLY = ["text_block", "space", "letterhead", "watermark", "button"];
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
  let prescriptionForms = [];
  let letterhead = DEFAULT_LETTERHEAD;
  let dirty = false, saving = false, saveTimer = null;

  // Publishing
  let status = tpl.status;
  let version = tpl.version;
  let publishedAt = tpl.publishedAt || null;
  let publishedSig = version > 0 ? null : ""; // null = still loading the published copy
  let publishing = false;
  let showIssues = false;     // after a Publish that found problems: they're outlined until fixed

  let aftercareMap = null;   // aftercare id -> aftercare, once loaded
  let emailTemplates = [];   // To Patient task types, for the aftercare email
  let products = [];         // inventory products, for the Consumables field
  let markSets = null;       // marking sets, once loaded
  let specialities = [];     // from the Specialist Bank, for the field's Speciality suggestions
  let previewAnnots = {};    // pictures being drawn on in Preview
  let previewTags = [];      // text with tags in it, on the Preview
  let staffView = false;     // Preview: hide the fields staff won't see
  const picked = new Set();  // questions selected together (outline ticks, Shift / Ctrl + click)
  let blocks = null;         // saved blocks, once loaded
  let blockIdx = new Map();  // question id -> { link, block, first } for questions inserted from a block
  let palTab = (() => { try { return localStorage.getItem("fe-paltab") === "outline" ? "outline" : "add"; } catch { return "add"; } })();
  const ctx = (live) => ({ live, fields, consentForms, prescriptionForms, letterhead, calcValues: null, aftercare: aftercareMap, emailTemplates, products, markSets, specialities });
  const current = () => fields.find((f) => f.id === sel) || null;
  const signature = () => JSON.stringify(formSnapshot({ name, fields, settings }));

  root.innerHTML = `
    ${back}
    <div class="fe-top-sentinel" aria-hidden="true"></div>
    <div class="fe-top">
      <div class="fe-top-main">
        <input class="fe-name" data-role="name" maxlength="120" aria-label="Form name" value="${esc(name)}" />
        <div class="fe-sub">
          <span data-role="cat">${esc(categoryLabel(tpl.category))}</span>
          <span class="fb-pill" data-role="pill"></span>
          <span class="fe-state" data-role="state">All changes saved</span>
        </div>
      </div>
      <div class="fe-top-actions">
        <div class="pt-tabs fe-modes" role="group" aria-label="View">
          <button type="button" data-mode="build" class="active">Build</button>
          <button type="button" data-mode="preview">Preview</button>
        </div>
        <div class="fe-undo" role="group" aria-label="Undo and redo">
          <button type="button" class="btn-ghost fe-ur" data-act="undo" data-role="undo" aria-label="Undo" title="Undo (Ctrl+Z)" disabled>${svg(UI.undo)}</button>
          <button type="button" class="btn-ghost fe-ur" data-act="redo" data-role="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled>${svg(UI.redo)}</button>
        </div>
        <button type="button" class="btn-ghost fe-issues" data-act="issues" data-role="issues" hidden></button>
        <button type="button" class="btn-ghost fe-staffview" data-act="staff-view" data-role="staffview" hidden>Show as staff see it</button>
        <button type="button" class="btn-ghost fe-dup" data-act="duplicate" title="Make a new draft with these questions">Duplicate</button>
        <button type="button" class="btn-ghost fe-savenow" data-act="save-now" data-role="savenow" disabled>Save draft</button>
        <button type="button" class="btn-ghost fe-unpub" data-act="unpublish" data-role="unpublish" hidden>Unpublish</button>
        <button type="button" class="btn-ghost fe-discard" data-act="discard" data-role="discard" hidden>Discard changes</button>
        <button type="button" class="btn-primary fe-publish" data-act="publish" data-role="publish">Publish</button>
      </div>
    </div>
    <div class="fe-shell is-build" data-role="shell">
      <aside class="fe-palette" aria-label="Questions">
        <div class="pt-tabs fe-paltabs" role="tablist" aria-label="Add or arrange questions">
          <button type="button" role="tab" data-paltab="add"${palTab === "add" ? ' class="active" aria-selected="true"' : ' aria-selected="false"'}>Add</button>
          <button type="button" role="tab" data-paltab="outline"${palTab === "outline" ? ' class="active" aria-selected="true"' : ' aria-selected="false"'}>Outline <em data-role="olcount"></em></button>
        </div>
        <div class="fe-pal-add" data-role="paladd"${palTab === "add" ? "" : " hidden"}>
          <button type="button" class="lh-btn fe-copyfrom" data-act="copy-from">${svg(UI.copy)}Copy from another form</button>
          <div class="fe-blocks" data-role="blocks"></div>
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
        </div>
        <div class="fe-outline" data-role="outline"${palTab === "outline" ? "" : " hidden"}></div>
      </aside>
      <div class="fe-stage" data-role="stage"></div>
      <aside class="fe-inspector" data-role="inspector" aria-label="Settings"></aside>
    </div>
    <div class="fe-bulk" data-role="bulk" role="toolbar" aria-label="Selected questions" hidden></div>`;

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

  /* ---------- Undo / redo ---------- */
  // Each step is the form as it was before a change, and which question was being worked on
  const MAX_UNDO = 60;
  const past = [], future = [];
  const snap = () => JSON.stringify({ name, fields, settings });
  let lastSnap = "";            // set once the page has drawn (see Start)
  let burstKey = "", burstAt = 0;

  function syncUndo() {
    const u = $('[data-role="undo"]');
    const r = $('[data-role="redo"]');
    if (u) { u.disabled = !past.length; u.title = past.length ? `Undo (Ctrl+Z) · ${past.length} step${past.length === 1 ? "" : "s"}` : "Nothing to undo"; }
    if (r) { r.disabled = !future.length; r.title = future.length ? "Redo (Ctrl+Shift+Z)" : "Nothing to redo"; }
  }

  // key: typing in the same box within a second is one step ("" = always its own step)
  function record(key = "") {
    const now = snap();
    if (now === lastSnap) return;
    const join = key && key === burstKey && Date.now() - burstAt < 1200 && past.length && !future.length;
    if (!join) {
      past.push({ data: lastSnap, sel });
      if (past.length > MAX_UNDO) past.shift();
    }
    burstKey = key;
    burstAt = Date.now();
    future.length = 0;
    lastSnap = now;
    syncUndo();
  }

  function restore(e) {
    const s = JSON.parse(e.data);
    name = s.name;
    nameInput.value = name;
    fields.splice(0, fields.length, ...(s.fields || []).map(normaliseField).filter(Boolean));
    Object.keys(settings).forEach((k) => delete settings[k]);
    Object.assign(settings, s.settings || {});
    sel = fields.some((f) => f.id === e.sel) ? e.sel : fields.some((f) => f.id === sel) ? sel : FORM;
    lastSnap = snap();
    burstKey = "";
    dirty = true;
    setState("dirty");
    renderPublish();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 900);
    renderStage();
    renderInspector();
    syncUndo();
  }

  function undo() {
    if (!past.length) return;
    const e = past.pop();
    future.push({ data: lastSnap, sel });
    restore(e);
  }
  function redo() {
    if (!future.length) return;
    const e = future.pop();
    past.push({ data: lastSnap, sel });
    restore(e);
  }

  function changed(key = "") {
    record(key);
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

    const unpub = $('[data-role="unpublish"]');
    if (unpub) {
      unpub.hidden = !live;
      unpub.disabled = publishing;
      unpub.title = "Take this form off the patient dashboard and keep it as a draft";
    }
    const iss = $('[data-role="issues"]');
    if (iss) {
      const n = showIssues ? publishProblems().length : 0;
      iss.hidden = !n;
      iss.textContent = `${n} to fix`;
      iss.title = "See what needs fixing before publishing";
    }
    const disc = $('[data-role="discard"]');
    if (disc) {
      disc.hidden = publishing || !(version > 0 && publishedSig && signature() !== publishedSig);
      disc.title = `Put the form back to version ${version}, exactly as staff see it`;
    }
  }

  // What would stop this question working for staff, or null
  function fieldProblem(f) {
    const label = String(f.label || "").trim();
    const nm = label || FIELD_TYPES[f.type].name;
    const cp = conditionProblem(f, fields);
    if (cp) return { id: f.id, msg: `“${nm}”: ${cp}` };
    if (hasLabel(f.type) && !["text_block", "image"].includes(f.type) && !label) {
      return { id: f.id, msg: "This question needs a name." };
    }
    if (f.liveHide && f.required && canRequire(f.type)) {
      return { id: f.id, msg: `“${nm}” is hidden from staff but set as Answer required. Untick one of them.` };
    }
    if (CHOICE_TYPES.includes(f.type) && !f.options.some((o) => String(o).trim())) {
      return { id: f.id, msg: `“${label}” needs at least one answer choice.` };
    }
    if (f.type === "button" && !BUTTON_URL_RE.test(String(f.url || "").trim())) {
      return { id: f.id, msg: `“${label || "Button"}” needs a link starting with https://, mailto:, tel: or #/.` };
    }
    if (f.type === "calculation") {
      const c = checkFormula(f, fields);
      if (!c.ok) return { id: f.id, msg: `“${label || "Calculation"}”: ${c.error}` };
    }
    if (f.type === "table") {
      const tp = tableProblem(f);
      if (tp) return { id: f.id, msg: tp };
      const bad = tableCols(f).find((c) => c.type === "dropdown" && !c.options.length);
      if (bad) return { id: f.id, msg: `Table column “${bad.label || "Column"}” needs at least one choice.` };
    }
    if (f.type === "image" && f.source !== "staff") {
      if (f.annotate && f.markMode === "marks" && markSets) {
        const chosen = markSetIdsOf(f).map((id) => markSets.find((s) => s.id === id)).filter(Boolean);
        if (!chosen.length) return { id: f.id, msg: "Choose at least one marking set for the picture, or change what staff can do with it." };
      }
      const badQ = (f.questions || []).find((q) => !String(q.label || "").trim() || (iqHasOptions(q) && !(q.options || []).length));
      if (badQ) {
        return { id: f.id, msg: String(badQ.label || "").trim()
          ? `“${badQ.label}” under the picture needs at least one choice.` : "A question under the picture needs a name." };
      }
    }
    if (f.type === "consent_status" && !f.consentFormId) {
      return { id: f.id, msg: "Choose which consent form the Consent check looks for." };
    }
    if (f.type === "consumables" && !(f.items || []).length) {
      return { id: f.id, msg: "Choose at least one product for the Consumables field." };
    }
    if (f.type === "consumables") {
      const bad = (f.items || []).find((it) => {
        if (!it.from) return false;
        const src = fields.find((x) => x.id === it.from);
        return !src || !(isMarkImage(src) || ["calculation", "number"].includes(src.type));
      });
      if (bad) return { id: f.id, msg: `${bad.name}: the question its amount comes from has been removed or no longer has unit marks.` };
    }
    if (f.type === "prescription_status" && !f.consentFormId) {
      return { id: f.id, msg: "Choose which prescription form the Prescription check looks for." };
    }
    return null;
  }

  // Everything that would stop the form working for staff: [{ id?, msg }]
  function publishProblems() {
    const out = [];
    if (!fields.some((f) => !LAYOUT_ONLY.includes(f.type))) out.push({ msg: "Add at least one question before publishing." });
    fields.forEach((f) => { const p = fieldProblem(f); if (p) out.push(p); });
    return out;
  }
  const problemMap = () => (showIssues ? new Map(publishProblems().filter((p) => p.id).map((p) => [p.id, p.msg])) : null);

  // Jumps to a question on the build page
  function goTo(id) {
    setMode("build");
    sel = id;
    renderStage();
    renderInspector();
    const el = stage.querySelector(`.fe-field[data-id="${CSS.escape(id)}"]`);
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.focus({ preventScroll: true }); }
  }

  function openProblems(list) {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog fe-problems";
    const where = (id) => {
      const i = fields.findIndex((x) => x.id === id);
      return i < 0 ? "" : `Question ${i + 1} · ${FIELD_TYPES[fields[i].type].name}`;
    };
    dlg.innerHTML = `<div class="lh-form">
      <div class="lh-dialog-head"><h3>${list.length === 1 ? "1 thing" : `${list.length} things`} to fix before publishing</h3>
        <p>They're outlined in red on the page. Fix them, then press Publish again.</p></div>
      <ol class="fe-prob-list">${list.map((p) => `<li>
        <span>${p.id ? `<small>${esc(where(p.id))}</small>` : ""}${esc(p.msg)}</span>
        ${p.id ? `<button type="button" class="lh-btn" data-go="${esc(p.id)}">Go to it</button>` : ""}
      </li>`).join("")}</ol>
      <div class="lh-actions"><button type="button" class="lh-btn is-primary" data-act="close">OK</button></div>
    </div>`;
    dlg.addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]");
      if (go) { dlg.close(); goTo(go.dataset.go); return; }
      if (e.target.closest('[data-act="close"]')) dlg.close();
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    const first = dlg.querySelector("[data-go], [data-act='close']");
    if (first) first.focus();
  }

  async function publish() {
    if (publishing) return;
    const problems = publishProblems();
    if (problems.length) {
      showIssues = true;
      setMode("build");
      renderStage();
      renderPublish();
      openProblems(problems);
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

  async function discardChanges() {
    const ok = await confirmDialog({
      title: "Discard unpublished changes?",
      message: `The form goes back to version ${version}, exactly as staff see it. Everything changed since then is lost. This can't be undone.`,
      confirm: "Discard changes",
    });
    if (!ok || !root.isConnected) return;
    await settle();
    try {
      const v = await getFormVersion(templateId, version);
      if (!v) throw new Error(`Version ${version} couldn't be found.`);
      if (!root.isConnected) return;
      name = v.name;
      nameInput.value = name;
      fields.splice(0, fields.length, ...v.fields.map(normaliseField).filter(Boolean));
      Object.keys(settings).forEach((k) => delete settings[k]);
      Object.assign(settings, { showLetterhead: true, ...(v.settings || {}) });
      sel = FORM;
      dirty = false;
      await saveFormTemplate(templateId, { name, fields, settings }, staff);
      publishedSig = signature();
      past.length = 0;
      future.length = 0;
      lastSnap = snap();
      syncUndo();
      setState("saved");
      renderStage();
      renderInspector();
      renderPublish();
      showToast(`Back to version ${version}.`);
    } catch (err) {
      console.error("Discard changes failed:", err);
      showToast(err.code === "permission-denied" ? "You don't have permission to edit this form."
        : err.code ? "Couldn't discard the changes. Check your connection and try again." : err.message);
      if (root.isConnected) renderPublish();
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
    const values = evaluateCalcs(fields, (f, col) => {
      const w = stage.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
      if (w && w.hidden) return null; // hidden questions count as unanswered
      if (f.type === "table") return tableTotal(f, w, col);
      if (f.type === "image") { const a = previewAnnots[f.id]; return a && a.total ? a.total() : null; }
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

  // Preview: questions appear and disappear as answers change, and tags fill in, like the real form
  function refreshPreview() {
    if (mode !== "preview") return;
    fields.forEach((f) => { if (f.type === "table") tableRecalc(f, stage.querySelector(`[data-fid="${CSS.escape(f.id)}"]`)); });
    let calc = updateCalcs();
    applyVisibility(stage, fields, { pads: {}, calc, consent: {} });
    calc = updateCalcs();
    applyVisibility(stage, fields, { pads: {}, calc, consent: {} });
    const tv = fieldTagValues(stage, fields, SAMPLE_TAGS, { pads: {}, calc, consent: {} });
    applyTagNodes(previewTags, tv, null); // unanswered tags stay visible as {Tag}
    syncButtons(stage, fields, tv);
    fields.forEach((f) => {
      const w = f.type === "rich_text" && stage.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
      if (w && w.rtRetag) w.rtRetag(tv);
    });
  }

  const BRANCH = '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>';
  const EYE_OFF = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
  const NO_PDF = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="4" y1="4" x2="20" y2="20"/>';
  const WARN = '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';

  // One question on the build page (also used to redraw just that question while typing)
  function fieldHtml(f, i, c, tagOwners, bad) {
    const body = renderField(f, c);
    const on = f.id === sel;
    const cond = conditionSummary(f, fields);
    const condBad = cond ? conditionProblem(f, fields) : "";
    const pf = prefillSummary(f);
    const issue = bad ? bad.get(f.id) : "";
    const blk = blockIdx.get(f.id);
    const blkNew = blk && blk.block && blk.block.version > blk.link.v;
    const chips = [
      issue && `<span class="fe-chip is-problem-chip">${svg(WARN)}${esc(issue)}</span>`,
      blk && blk.first === f.id && `<span class="fe-chip is-blk${blkNew ? " is-new" : ""}">${svg(UI.block)}${esc(blockChipText(blk))}</span>`,
      f.fill && `<span class="fe-chip">${svg(UI.user)}Auto-filled: ${esc(FILLS[f.fill] || f.fill)}</span>`,
      pf && `<span class="fe-chip">${svg('<polyline points="20 6 9 17 4 12"/>')}Pre-filled: ${esc(pf)}</span>`,
      (() => {
        const tn = tagOwners.has(f.id) ? fieldTagName(f) : "";
        const n = tn ? tagUsedBy(fields, tn, f.id).length : 0;
        return n && `<span class="fe-chip is-tag">{${esc(tn)}} · used in ${n} place${n === 1 ? "" : "s"}</span>`;
      })(),
      cond && `<span class="fe-chip is-cond${condBad ? " is-bad" : ""}">${svg(BRANCH)}${esc(condBad || cond)}</span>`,
      f.liveHide && `<span class="fe-chip is-livehide-chip">${svg(EYE_OFF)}Hidden from staff${f.liveHideShow ? " · on the PDF" : ""}</span>`,
      f.pdfHide && !f.liveHide && `<span class="fe-chip">${svg(NO_PDF)}Not on the PDF</span>`,
    ].filter(Boolean).join("");
    return `
      <div class="fe-field${spanClass(f)}${on ? " is-selected" : ""}${cond ? " is-conditional" : ""}${f.liveHide ? " is-livehide" : ""}${issue ? " is-problem" : ""}${picked.has(f.id) ? " is-picked" : ""}${blk ? " is-block" : ""}" data-id="${esc(f.id)}" draggable="true" tabindex="0"
           aria-label="${esc(FIELD_TYPES[f.type].name)}${f.label ? ": " + esc(f.label) : ""}">
        ${body}
        ${chips ? `<div class="fe-chips">${chips}</div>` : ""}
        ${on ? `
        <div class="fe-tools">
          <button type="button" data-tool="up" aria-label="Move up" title="Move up (Alt+↑)"${i === 0 ? " disabled" : ""}>${svg(UI.up)}</button>
          <button type="button" data-tool="down" aria-label="Move down" title="Move down (Alt+↓)"${i === fields.length - 1 ? " disabled" : ""}>${svg(UI.down)}</button>
          <button type="button" data-tool="copy" aria-label="Duplicate" title="Duplicate (Ctrl+D)">${svg(UI.copy)}</button>
          <button type="button" data-tool="remove" aria-label="Remove" title="Remove (Delete)">${svg(UI.trash)}</button>
        </div>` : ""}
      </div>`;
  }

  // While typing in the settings panel: redraw just that question, and the whole page once typing stops
  let fullTimer = 0;
  function redraw(f) {
    clearTimeout(fullTimer);
    if (mode !== "build" || !f || f.type === "watermark") { renderStage(); return; }
    const el = stage.querySelector(`.fe-field[data-id="${CSS.escape(f.id)}"]`);
    const i = fields.indexOf(f);
    if (!el || i < 0) { renderStage(); return; }
    blockIdx = blockIndex();
    const t = document.createElement("template");
    t.innerHTML = fieldHtml(f, i, ctx(false), new Set(formFieldTags(fields).map((x) => x.f.id)), problemMap()).trim();
    const next = t.content.firstElementChild;
    if (!next) { renderStage(); return; }
    el.replaceWith(next);
    hydrateBankImages(next);
    fullTimer = setTimeout(() => { if (root.isConnected) renderStage(); }, 400);   // other questions that use this one catch up
  }

  function renderStage() {
    clearTimeout(fullTimer);
    for (const id of [...picked]) if (!fields.some((f) => f.id === id)) picked.delete(id);   // removed, or undone
    blockIdx = blockIndex();
    const build = mode === "build";
    const c = ctx(!build);
    const tagOwners = new Set(formFieldTags(fields).map((t) => t.f.id));
    const bad = build ? problemMap() : null;
    const items = fields.map((f, i) => {
      if (build) return fieldHtml(f, i, c, tagOwners, bad);
      const body = renderField(f, c);
      return body ? `<div class="fe-field${spanClass(f)}${f.liveHide ? " is-livehide" : ""}" data-fid="${esc(f.id)}">${
        f.liveHide ? '<span class="fe-livehide-tag">Hidden from staff</span>' : ""}${body}</div>` : "";
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

    // Preview: "Show as staff see it" (only when something is hidden)
    const anyHidden = fields.some((f) => f.liveHide);
    const sv = $('[data-role="staffview"]');
    if (sv) {
      sv.hidden = build || !anyHidden;
      sv.textContent = staffView ? "Show hidden fields" : "Show as staff see it";
      sv.classList.toggle("is-on", staffView);
    }
    shell.classList.toggle("is-staff-view", !build && staffView && anyHidden);

    previewTags = build ? [] : collectTagNodes(stage);
    if (!build) refreshPreview();
    hydrateBankImages(stage);
    if (!build) {
      fields.filter((f) => f.type === "rich_text").forEach((f) => {
        mountRichTextField(stage.querySelector(`[data-fid="${CSS.escape(f.id)}"]`), f, { tags: SAMPLE_TAGS });
      });
      previewAnnots = attachAnnotators(stage, fields, { markSets: markSets || [] });
      fields.filter((f) => f.type === "aftercare").forEach((f) => {
        mountAftercareField(stage.querySelector(`[data-fid="${CSS.escape(f.id)}"]`), f, { onChange: refreshPreview });
      });
      stage.querySelectorAll("[data-cs-host]").forEach((h) => {
        h.innerHTML = '<p class="fe-help">Staff see their kit and Shelf stock here, and record what they used.</p>';
      });
      stage.querySelectorAll("[data-sp-host]").forEach((h) => {
        h.innerHTML = '<p class="fe-help">Staff choose a specialist from the Specialist Bank here, or add a new one.</p>';
      });
    }
    renderOutline();
    renderBulk();
  }
  /* ---------- Settings panel ---------- */
  const setting = (label, control, note = "") =>
    `<label class="fe-insp-field"><span class="fe-insp-label">${label}</span>${control}${
      note ? `<small class="fe-note">${note}</small>` : ""}</label>`;

  /* ---------- Patients fill it in online ---------- */
  let staffList = null;
  listStaffDetails().then((l) => { staffList = l; if (root.isConnected && sel === FORM) renderInspector(); })
    .catch((err) => { console.warn("Staff not loaded:", err); staffList = []; });
  let onlineSaving = Promise.resolve();

  function onlineHtml() {
    const head = '<span class="fe-insp-label">Patients fill it in online</span>';
    if (ONLINE_NO_CATS.includes(tpl.category)) {
      return `<div class="fe-insp-field">${head}<small class="fe-note">Treatment records and prescriptions are filled in by clinicians, so they can't be sent to patients.</small></div>`;
    }
    const o = tpl.online || {};
    const on = o.on === true;
    const blk = onlineBlockers(fields);
    const ids = new Set(Array.isArray(o.notify) ? o.notify : []);
    const a = o.after || {};
    const badUrl = a.url && !/^https:\/\/[^\s"'<>]+$/i.test(String(a.url).trim());
    const afterHtml = `<span class="fe-insp-sub"><small>After they send it</small></span>
        <input class="fe-input" data-online-after="title" maxlength="120" placeholder="Thanks, {First name}. We've got your form."
          value="${esc(a.title || "")}" aria-label="Thank-you heading" />
        <textarea class="fe-input" data-online-after="text" rows="3" maxlength="600"
          placeholder="It's been saved to your record at Dermedica. You can close this page." aria-label="Thank-you message">${esc(a.text || "")}</textarea>
        <input class="fe-input" data-online-after="url" type="url" maxlength="500" placeholder="https://www.dermedica.com.au (optional)"
          value="${esc(a.url || "")}" aria-label="Web page to send them to" />
        ${badUrl ? '<small class="fe-note fe-bad">The web page must start with https://</small>' : ""}
        <input class="fe-input" data-online-after="label" maxlength="40" placeholder="Visit our website"
          value="${esc(a.label || "")}" aria-label="Button text" />
        <label class="fe-check"><input type="checkbox" data-online-after="auto"${a.auto ? " checked" : ""} /> Take them to the web page by itself after 5 seconds</label>
        <small class="fe-note">Empty boxes use the wording shown in grey. {First name} is filled in for them. Without a web page, they just see the thank-you message.</small>`;
    return `<div class="fe-insp-field fe-online">${head}
      <label class="fe-check"><input type="checkbox" data-online="on"${on ? " checked" : ""}${blk.length && !on ? " disabled" : ""} />
        Patients can fill this in from a link in an email</label>
      ${blk.length ? `<small class="fe-note fe-bad">${on ? "Patients can't open it while the form has" : "Not available while the form has"}: ${esc(blk.join(", "))}.</small>` : ""}
      ${on ? `<span class="fe-insp-sub"><small>Tell these staff when a patient fills it in</small></span>
        <div class="fe-parts">${staffList ? (staffList.length ? staffList.map((s) => `<label class="fe-check"><input type="checkbox" data-online-staff="${esc(s.id)}"${
          ids.has(s.id) ? " checked" : ""} /> ${esc(s.name)}</label>`).join("") : '<small class="fe-note">No staff found.</small>') : '<small class="fe-note">Loading staff…</small>'}</div>
        <small class="fe-note">Nobody ticked: the Admins are told.</small>
        <label class="fe-check"><input type="checkbox" data-online="todo"${o.todo !== false ? " checked" : ""} /> Add a to-do to their task list</label>
        ${afterHtml}
        ${status !== "live" ? '<small class="fe-note">Publish the form so patients can open it.</small>' : ""}` : ""}
      <small class="fe-note">Their name, email and other details are filled in for them (never their Medicare details). It's saved to their record as
        "Filled in online by the patient". Changes take effect straight away, without publishing again.</small>
    </div>`;
  }
  
  function saveOnline(el) {
    const o = { on: false, notify: [], todo: true, ...(tpl.online || {}) };
    if (el.dataset.online === "on") o.on = el.checked;
    else if (el.dataset.online === "todo") o.todo = el.checked;
    else {
      const set = new Set(o.notify || []);
      if (el.checked) set.add(el.dataset.onlineStaff); else set.delete(el.dataset.onlineStaff);
      o.notify = [...set];
    }
    o.group = formGroup({ name, settings });
    tpl.online = o;
    renderInspector();
    onlineSaving = onlineSaving
      .then(() => saveFormOnline(templateId, o, staff))
      .then(() => { if (el.dataset.online === "on") showToast(o.on ? "Patients can now fill this in online." : "Turned off for patients."); })
      .catch((err) => {
        console.error("Online setting not saved:", err);
        showToast(err.code === "permission-denied" ? "Not saved. Check the Firestore rules have been published." : "Not saved. Try again.");
      });
  }
  
  // The thank-you wording and web page: saved a moment after typing stops (the panel isn't redrawn, so typing isn't interrupted)
  let afterTimer = 0;
  function saveAfter(el) {
    const o = { on: false, notify: [], todo: true, ...(tpl.online || {}) };
    o.after = { ...(o.after || {}), [el.dataset.onlineAfter]: el.type === "checkbox" ? el.checked : el.value };
    o.group = formGroup({ name, settings });
    tpl.online = o;
    clearTimeout(afterTimer);
    afterTimer = setTimeout(() => {
      onlineSaving = onlineSaving
        .then(() => saveFormOnline(templateId, tpl.online, staff))
        .catch((err) => {
          console.error("Thank-you settings not saved:", err);
          showToast(err.code === "permission-denied" ? "Not saved. Check the Firestore rules have been published." : "Not saved. Try again.");
        });
    }, 800);
  }

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
      <label class="fe-insp-field"><span class="fe-insp-label">Category</span>
        <select class="fb-select" data-cat>
          ${FORM_CATEGORIES.map((c) => `<option value="${c.key}"${tpl.category === c.key ? " selected" : ""}>${esc(c.label)}</option>`).join("")}
        </select>
        <small class="fe-note">Where this form is listed: on patient pages, in Task Manager and in the Form Builder.
          Changes straight away${status === "live" ? ", without publishing again" : ""}. Forms already saved for patients keep their category.</small>
      </label>
      ${onlineHtml()}
      ${["consent", "treatment"].includes(tpl.category) ? `
      <label class="fe-insp-field"><span class="fe-insp-label">Treatment group</span>
        <select class="fb-select" data-s="group">
          <option value="">Automatic, from the form name (${esc((CATEGORIES.find((c) => c.key === categorize(name)) || { title: "Other" }).title)})</option>
          ${CATEGORIES.map((c) => `<option value="${c.key}"${settings.group === c.key ? " selected" : ""}>${esc(c.title)}</option>`).join("")}
          <option value="other"${settings.group === "other" ? " selected" : ""}>Other</option>
        </select>
        <small class="fe-note">Where saved forms appear on the patient's page, and which Create Consent / Create Tx buttons offer this form.</small>
      </label>` : ""}
      ${tpl.category === "prescription" ? `
      <label class="fe-insp-field"><span class="fe-insp-label">Prescription type</span>
        <select class="fb-select" data-s="rxKind">
          <option value="">Automatic, from the form name (${esc(RX_KINDS[rxKindGuess(name)])})</option>
          <option value="product"${settings.rxKind === "product" ? " selected" : ""}>Product prescription</option>
          <option value="treatment"${settings.rxKind === "treatment" ? " selected" : ""}>Treatment prescription</option>
        </select>
        <small class="fe-note">Product prescriptions show under Billing &amp; Prescriptions on the patient's page. Treatment prescriptions show under Injectable Prescription Records. Publish to apply it.</small>
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
      <div class="fe-insp-field"><span class="fe-insp-label">Keyboard shortcuts</span>
        <div class="fe-keys">
          <span><kbd>Ctrl</kbd> <kbd>Z</kbd></span><span>Undo</span>
          <span><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Z</kbd></span><span>Redo</span>
          <span><kbd>Ctrl</kbd> <kbd>S</kbd></span><span>Save the draft now</span>
          <span><kbd>↑</kbd> <kbd>↓</kbd></span><span>Select the question above or below</span>
          <span><kbd>Shift</kbd> + click</span><span>Select every question in between</span>
          <span><kbd>Ctrl</kbd> + click</span><span>Add one to the selection, or take it out</span>
          <span><kbd>Shift</kbd> <kbd>↑</kbd> <kbd>↓</kbd></span><span>Grow the selection</span>
          <span><kbd>Ctrl</kbd> <kbd>A</kbd></span><span>Select every question</span>
          <span><kbd>Ctrl</kbd> <kbd>D</kbd></span><span>Duplicate the selected question(s)</span>
          <span><kbd>Alt</kbd> <kbd>↑</kbd> <kbd>↓</kbd></span><span>Move them up or down</span>
          <span><kbd>Delete</kbd></span><span>Remove them (Undo brings them back)</span>
          <span><kbd>Esc</kbd></span><span>Clear the selection, then back to Form settings</span>
        </div>
        <small class="fe-note">On a Mac or an iPad keyboard, use ⌘ instead of Ctrl.</small>
      </div>
      <div class="fe-danger">
        <button type="button" class="fe-remove" data-act="delete-form">${svg(UI.trash)}Delete this form</button>
      </div>`;
  }

  // This answer's own tag: what it's called, where it's used, and a name of its own if wanted
  function myTagHtml(f) {
    if (!TAG_TYPES.includes(f.type)) return "";
    const tn = fieldTagName(f);
    const owner = !!tn && formFieldTags(fields).some((t) => t.f.id === f.id);
    const used = owner ? tagUsedBy(fields, tn, f.id) : [];
    const note = !tn ? "Name the question to give its answer a tag."
      : !owner ? `{${tn}} is already used by another question or a built-in tag. Type a tag name of its own to use this answer.`
      : used.length ? `Used in: ${used.map((x) => x.label || FIELD_TYPES[x.type].name).join(", ")}.`
      : "Put it in a later question's name, help text or pre-fill to repeat this answer there.";
    return `<div class="fe-insp-field fe-mytag"><span class="fe-insp-label">This answer's tag</span>
      ${owner ? `<div class="fe-mytag-row"><code>{${esc(tn)}}</code>
        <button type="button" class="lh-btn is-quiet" data-act="tag-copy" data-tag="{${esc(tn)}}">Copy</button></div>` : ""}
      <input class="fe-input" data-k="tag" maxlength="40" placeholder="Same as the question" value="${esc(f.tag || "")}" aria-label="Tag name" />
      <small class="fe-note">${esc(note)}</small></div>`;
  }

  // Renaming a question (or its tag): everywhere that uses the tag follows.
  // If the new name is empty or clashes, the old tag is kept so nothing breaks.
  const tagOwnerName = (f) => {
    const tn = fieldTagName(f);
    return tn && formFieldTags(fields).some((t) => t.f.id === f.id) ? tn : "";
  };
  function followTag(f, before) {
    const inTitle = tagRefRe(before, "i").test(name);
    if (!inTitle && !tagUsedBy(fields, before, f.id).length) return;
    const after = tagOwnerName(f);
    if (!after) { if (!f.tag) f.tag = before; return; }
    if (tagKeyOf(after) === tagKeyOf(before)) return;
    renameTagRefs(fields, before, after);
    if (inTitle) { name = name.replace(tagRefRe(before), `{${after}}`); nameInput.value = name; }
  }

  function renderInspector() {
    const f = current();
    if (!f) { renderFormSettings(); return; }

    let h = `<div class="fe-insp-head">${svg(ICONS[f.type])}<span>${esc(FIELD_TYPES[f.type].name)}</span></div>`;
    h += blockBoxHtml(f);
    if (hasLabel(f.type)) {
      const lbl = f.type === "button" ? "Button text" : f.type === "text_block" ? "Heading" : f.type === "table" ? "Table title"
        : f.type === "image" ? "Title (optional)" : "Question";
      h += setting(lbl, `<input class="fe-input" data-k="label" maxlength="300" value="${esc(f.label)}" />`);
    }
    h += myTagHtml(f);
    if (hasLabel(f.type) || hasHelp(f.type)) h += tagPickerHtml({ fields, current: f });
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
        `<select class="fb-select" data-k="fill" data-rerender="">${FILLS_FOR[f.type].map((k) =>
          `<option value="${k}"${(f.fill || "") === k ? " selected" : ""}>${esc(FILLS[k])}</option>`).join("")}</select>`,
        f.fill ? "Staff can still change it before saving." : "");
    }
    h += prefillSettings(f);
    h += conditionSettingsHtml(f, fields);
    if (canLiveHide(f)) {
      h += `<label class="fe-check"><input type="checkbox" data-k="liveHide" data-rerender=""${f.liveHide ? " checked" : ""} /> Hide on the live form</label>
        <small class="fe-note fe-pad">Staff won't see it when filling in. It still works behind the scenes: calculations, tags, pre-fills and show-when rules use its answer, and it's saved with the form.</small>`;
      if (f.liveHide) {
        h += `<label class="fe-check"><input type="checkbox" data-k="liveHideShow" data-rerender=""${f.liveHideShow ? " checked" : ""} /> Still show it on the PDF and saved copy</label>
          <small class="fe-note fe-pad">Leave unticked for helper questions and notes for admins.</small>`;
      }
    }
    if (!["watermark", "letterhead"].includes(f.type) && !f.liveHide) {
      h += `<label class="fe-check"><input type="checkbox" data-k="pdfHide"${f.pdfHide ? " checked" : ""} /> Leave out of the PDF and printouts</label>
        <small class="fe-note fe-pad">For questions only meant for the live form. They're still answered and saved, and show when the saved form is opened in the portal.</small>`;
    }
    if (canRequire(f.type)) {
      h += `<label class="fe-check"><input type="checkbox" data-k="required"${f.required ? " checked" : ""} /> Answer required</label>`;
    }
    h += `<button type="button" class="fe-remove" data-tool="remove">${svg(UI.trash)}Remove</button>`;
    insp.innerHTML = h;
    hydrateBankImages(insp);

    // Text block: rich text editor
    const tbHost = insp.querySelector('[data-role="tb-editor"]');
    const tbField = current();
    if (tbHost && tbField) {
      const ed = createRichEditor(tbHost, {
        button: false,
        onInput: () => {
          tbField.html = ed.getHtml();
          tbField.text = ed.text().trim().slice(0, 5000); // plain copy for search and older pages
          changed(`${tbField.id}:html`);
          redraw(tbField);
        },
      });
      ed.setHtml(tbField.html || textToRichHtml(tbField.text));
    }
    // Rich text answer: its starting text
    const rtHost = insp.querySelector('[data-role="rt-starter"]');
    const rtField = current();
    if (rtHost && rtField && rtField.type === "rich_text") {
      const ed2 = createRichEditor(rtHost, {
        button: false,
        onInput: () => { rtField.starter = ed2.getHtml(); changed(`${rtField.id}:starter`); redraw(rtField); },
      });
      ed2.setHtml(rtField.starter || "");
    }
  }

    // Moving the form to another category: warns about anything that uses it, then saves straight away
  let catBusy = false;
  async function changeCategory(next) {
    const prev = tpl.category;
    if (catBusy || next === prev) return;
    catBusy = true;
    try {
      const [tasks, forms] = await Promise.all([
        listTaskTypes({ isAdmin: true }).catch(() => null),
        listFormTemplates({ isAdmin: true, force: true }).catch(() => null),
      ]);
      if (!root.isConnected) return;
      // Task types that attach or print this form (matched by its id anywhere in the task)
      const usedBy = (tasks || []).filter((t) => t.status !== "archived" && JSON.stringify(t).includes(templateId));
      // Other forms whose Consent / Prescription check looks for this one
      const checkedBy = (forms || []).filter((t) => t.id !== templateId && (t.fields || []).some((f) =>
        f && (f.type === "consent_status" || f.type === "prescription_status") && f.consentFormId === templateId));

      const lines = [
        `It moves from ${categoryLabel(prev)} to ${categoryLabel(next)}${status === "live" ? " straight away" : ""}. Forms already saved for patients keep their category.`,
        usedBy.length ? `Used by ${usedBy.length === 1 ? "this task" : "these tasks"}: ${usedBy.map((t) => t.name).join(", ")}. Check ${usedBy.length === 1 ? "it still attaches or prints" : "they still attach or print"} it.` : "",
        checkedBy.length ? `Checked for by: ${checkedBy.map((t) => t.name).join(", ")}. Those checks keep working.` : "",
        !tasks || !forms ? "Couldn't check which tasks and forms use it." : "",
        next === "prescription" ? "Choose Product or Treatment prescription in Form settings afterwards." : "",
        ["consent", "treatment"].includes(next) ? "Check the Treatment group in Form settings afterwards." : "",
      ].filter(Boolean);

      const ok = await confirmDialog({
        title: `Move to ${categoryLabel(next)}?`,
        message: lines.join(" "),
        confirm: "Move it",
        tone: "primary",
      });
      if (!ok || !root.isConnected) { if (root.isConnected) renderInspector(); return; } // puts the dropdown back

      await settle();
      await changeFormCategory(templateId, next, staff);
      tpl.category = next;
      if (dirty) flush(); // an edit made just before was waiting to autosave
      const catEl = $('[data-role="cat"]');
      if (catEl) catEl.textContent = categoryLabel(next);
      renderInspector();
      showToast(`Moved to ${categoryLabel(next)}.`);
    } catch (err) {
      console.error("Category change failed:", err);
      showToast(err.code === "permission-denied" ? "You don't have permission to change this form." : "Couldn't change the category. Try again.");
      if (root.isConnected) renderInspector();
    } finally {
      catBusy = false;
    }
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

  // Everything else on the form that uses this question
  function fieldUses(f, skip = null) {
    const nm = (x) => `“${String(x.label || "").trim() || FIELD_TYPES[x.type].name}”`;
    const out = [];
    fields.forEach((x) => {
      if (x.id === f.id || (skip && skip.has(x.id))) return;
      if (x.showWhen && Array.isArray(x.showWhen.rules) && x.showWhen.rules.some((r) => r && r.q === f.id)) {
        out.push(`the show-when rule on ${nm(x)}`);
      }
      if (x.type === "calculation" && calcRefs(x.formula).some((r) => r === f.id || r.startsWith(`${f.id}.`))) {
        out.push(`the calculation ${nm(x)}`);
      }
      if (x.type === "consumables") {
        (x.items || []).filter((it) => it.from === f.id)
          .forEach((it) => out.push(`the ${it.name || "product"} amount in ${nm(x)}`));
      }
    });
    const tn = tagOwnerName(f);
    if (tn) {
      tagUsedBy(fields, tn, f.id).filter((x) => !(skip && skip.has(x.id))).forEach((x) => out.push(`the {${tn}} tag in ${nm(x)}`));
      if (tagRefRe(tn, "i").test(name)) out.push(`the {${tn}} tag in the form title`);
    }
    return [...new Set(out)];
  }

  async function removeField(id) {
    const f = fields.find((x) => x.id === id);
    if (!f) return;
    const uses = fieldUses(f);
    if (uses.length) {
      const list = uses.length > 6 ? [...uses.slice(0, 6), `${uses.length - 6} more`] : uses;
      const ok = await confirmDialog({
        title: `Remove “${String(f.label || "").trim() || FIELD_TYPES[f.type].name}”?`,
        message: `It's used by ${list.join(", ")}. Those stop working until you change them.`,
        confirm: "Remove anyway",
      });
      if (!ok || !root.isConnected) return;
    }
    const i = fields.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [gone] = fields.splice(i, 1);
    sel = fields[i] ? fields[i].id : fields[i - 1] ? fields[i - 1].id : FORM;
    showToast("Removed", () => {
      fields.splice(Math.min(i, fields.length), 0, gone);
      sel = gone.id;
      changed();
      renderStage();
      renderInspector();
    });
    changed();
    renderStage();
    renderInspector();
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
      delete c.tag;
      fields.splice(i + 1, 0, c);
      sel = c.id;
    } else if (action === "remove") {
      removeField(id);
      return;
    }
    changed();
    renderStage();
    renderInspector();
  }
  /* ---------- Several questions at once, the outline, and copying from another form ---------- */
  const NO_SPAN = ["aftercare", "consumables", "letterhead", "watermark", "space"];   // these have no width setting
  const ONE_ONLY = ["record_date", "watermark"];
  const W_TAG = { half: "½", third: "⅓", twothirds: "⅔" };
  const pickedFields = () => fields.filter((f) => picked.has(f.id));
  const spanOf = (f) => spanClass(f).trim().replace("span-", "") || "full";

  // Copies with new ids. Show-when rules, calculations and product amounts between the copied questions follow the copies.
  // keepOutside: references to questions that weren't copied stay (same form) or are cleared (another form).
  // ids: optional Map of source id -> id to use (so updated copies keep their ids)
  function cloneFields(list, { keepOutside = true, ids = null } = {}) {
    const map = new Map(list.map((f) => [f.id, (ids && ids.get(f.id)) || newId()]));
    const here = new Set(fields.map((f) => f.id));
    const keeps = (id) => keepOutside && here.has(id);
    const notes = { rules: 0, calcs: 0, amounts: 0 };
    const copies = list.map((src) => {
      const c = JSON.parse(JSON.stringify(src));
      c.id = map.get(src.id);
      delete c.tag;
      if (c.showWhen && Array.isArray(c.showWhen.rules)) {
        c.showWhen.rules = c.showWhen.rules.filter((r) => {
          if (map.has(r.q)) { r.q = map.get(r.q); return true; }
          if (keeps(r.q)) return true;
          notes.rules++;
          return false;
        });
        if (!c.showWhen.rules.length) c.showWhen = null;
      }
      if (c.type === "calculation" && c.formula) {
        let broken = false;
        c.formula = String(c.formula).replace(/\{([^}]*)\}/g, (m, raw) => {
          const ref = raw.trim();
          const dot = ref.indexOf(".");
          const id = dot > 0 ? ref.slice(0, dot) : ref;
          if (map.has(id)) return `{${map.get(id)}${dot > 0 ? ref.slice(dot) : ""}}`;
          if (!keeps(id)) broken = true;
          return m;
        });
        if (broken) notes.calcs++;
      }
      if (c.type === "consumables" && Array.isArray(c.items)) {
        c.items.forEach((it) => {
          if (!it.from) return;
          if (map.has(it.from)) it.from = map.get(it.from);
          else if (!keeps(it.from)) { it.from = ""; notes.amounts++; }
        });
      }
      return normaliseField(c);
    }).filter(Boolean);
    return { copies, notes, map };
  }

  // Moves questions (in their current order) so they sit just before beforeId (null = at the end)
  function moveTo(ids, beforeId) {
    const set = new Set(ids);
    const moving = fields.filter((f) => set.has(f.id));
    const rest = fields.filter((f) => !set.has(f.id));
    let at = beforeId ? rest.findIndex((f) => f.id === beforeId) : rest.length;
    if (at < 0) at = rest.length;
    rest.splice(at, 0, ...moving);
    if (!rest.every((f, i) => f === fields[i])) {
      fields.splice(0, fields.length, ...rest);
      changed();
    }
    renderStage();
    renderInspector();
  }

  // One place up or down, keeping their order
  function moveBlock(ids, dir) {
    const set = new Set(ids);
    const idx = fields.map((f, i) => (set.has(f.id) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length || (dir < 0 && idx[0] === 0) || (dir > 0 && idx[idx.length - 1] === fields.length - 1)) return;
    (dir < 0 ? idx : idx.slice().reverse()).forEach((i) => {
      const j = i + dir;
      [fields[i], fields[j]] = [fields[j], fields[i]];
    });
    changed();
    renderStage();
    renderInspector();
  }

  async function removeMany(list) {
    if (!list.length) return;
    const ids = new Set(list.map((f) => f.id));
    const uses = [...new Set(list.flatMap((f) => fieldUses(f, ids)))];
    const shown = uses.length > 6 ? [...uses.slice(0, 6), `${uses.length - 6} more`] : uses;
    const ok = await confirmDialog({
      title: `Remove ${list.length} question${list.length === 1 ? "" : "s"}?`,
      message: uses.length
        ? `They're used by ${shown.join(", ")}. Those stop working until you change them. Undo brings them back.`
        : "Undo brings them back.",
      confirm: "Remove",
    });
    if (!ok || !root.isConnected) return;
    fields.splice(0, fields.length, ...fields.filter((f) => !ids.has(f.id)));
    picked.clear();
    if (ids.has(sel)) sel = FORM;
    changed();
    renderStage();
    renderInspector();
    showToast(`Removed ${list.length} question${list.length === 1 ? "" : "s"}`, () => undo());
  }

  // Shift + click: every question in between. Ctrl / ⌘ + click: add or take out one.
  function pickClick(id, range) {
    if (range && sel !== FORM) {
      const a = fields.findIndex((f) => f.id === sel);
      const b = fields.findIndex((f) => f.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) picked.add(fields[i].id);
      }
    } else {
      if (!picked.size && sel !== FORM && sel !== id && fields.some((f) => f.id === sel)) picked.add(sel);
      if (picked.has(id)) picked.delete(id); else picked.add(id);
    }
    renderStage();
  }

  function bulk(act, val) {
    const list = pickedFields();
    if (!list.length) return;
    if (act === "clear") { picked.clear(); renderStage(); return; }
    if (act === "up" || act === "down") { moveBlock(list.map((f) => f.id), act === "up" ? -1 : 1); return; }
    if (act === "del") { removeMany(list); return; }
    if (act === "block") { saveAsBlock(list); return; }
    if (act === "span") {
      list.filter((f) => !NO_SPAN.includes(f.type)).forEach((f) => { f.style = { ...(f.style || {}), span: val }; });
      changed();
      renderStage();
      renderInspector();
      return;
    }
    if (act === "hide") {
      const can = list.filter(canLiveHide);
      const hide = !can.every((f) => f.liveHide);
      let unreq = 0;
      can.forEach((f) => {
        f.liveHide = hide;
        if (!hide) f.liveHideShow = false;
        if (hide && f.required && canRequire(f.type)) { f.required = false; unreq++; }
      });
      changed();
      renderStage();
      renderInspector();
      showToast(hide
        ? `Hidden from staff${unreq ? `. Answer required was turned off for ${unreq}, as staff can't see ${unreq === 1 ? "it" : "them"}` : ""}.`
        : "Shown to staff again.");
      return;
    }
    if (act === "copy") {
      const ok = list.filter((f) => !ONE_ONLY.includes(f.type));
      if (!ok.length) { showToast("A form can only have one of these."); return; }
      const { copies } = cloneFields(ok, { keepOutside: true });
      fields.splice(fields.indexOf(list[list.length - 1]) + 1, 0, ...copies);
      picked.clear();
      copies.forEach((c) => picked.add(c.id));
      sel = copies[0].id;
      changed();
      renderStage();
      renderInspector();
      showToast(`${copies.length} duplicated. The copies are selected.${ok.length < list.length ? " (A form can only have one record date or watermark.)" : ""}`);
    }
  }

  function renderBulk() {
    const bar = $('[data-role="bulk"]');
    if (!bar) return;
    const list = pickedFields();
    bar.hidden = mode !== "build" || !list.length;
    if (bar.hidden) { bar.innerHTML = ""; return; }
    const spans = list.filter((f) => !NO_SPAN.includes(f.type)).map(spanOf);
    const span = spans.length && spans.every((s) => s === spans[0]) ? spans[0] : "";
    const can = list.filter(canLiveHide);
    const allHidden = can.length > 0 && can.every((f) => f.liveHide);
    const first = fields.indexOf(list[0]);
    const last = fields.indexOf(list[list.length - 1]);
    bar.innerHTML = `
      <strong>${list.length} selected</strong>
      <span class="fe-bulk-grp">
        <button type="button" class="lh-btn" data-bulk="up" aria-label="Move up" title="Move up (Alt+↑)"${first === 0 ? " disabled" : ""}>${svg(UI.up)}</button>
        <button type="button" class="lh-btn" data-bulk="down" aria-label="Move down" title="Move down (Alt+↓)"${last === fields.length - 1 ? " disabled" : ""}>${svg(UI.down)}</button>
      </span>
      ${spans.length ? `<span class="fe-bulk-span" role="group" aria-label="Width on the page">${[
        ["full", "Full", "Full width"], ["half", "½", "Half"], ["third", "⅓", "Third"], ["twothirds", "⅔", "Two thirds"],
      ].map(([v, l, t]) => `<button type="button" data-bulkspan="${v}" title="${t}" aria-pressed="${span === v}"${span === v ? ' class="is-on"' : ""}>${l}</button>`).join("")}</span>` : ""}
      ${can.length ? `<button type="button" class="lh-btn" data-bulk="hide">${allHidden ? "Show to staff" : "Hide from staff"}</button>` : ""}
      <button type="button" class="lh-btn" data-bulk="block" title="Save these questions to reuse on other forms">${svg(UI.block)}Save as block</button>
      <button type="button" class="lh-btn" data-bulk="copy" title="Duplicate (Ctrl+D)">${svg(UI.copy)}Duplicate</button>
      <button type="button" class="lh-btn st-danger" data-bulk="del" title="Remove (Delete)">${svg(UI.trash)}Remove</button>
      <button type="button" class="lh-btn is-quiet" data-bulk="clear" title="Clear the selection (Esc)">Clear</button>`;
  }

  function renderOutline() {
    const cnt = $('[data-role="olcount"]');
    if (cnt) cnt.textContent = fields.length ? String(fields.length) : "";
    const host = $('[data-role="outline"]');
    if (!host || palTab !== "outline" || mode !== "build") return;
    const pal = $(".fe-palette");
    const keep = pal ? pal.scrollTop : 0;
    const bad = problemMap();
    const all = fields.length > 0 && fields.every((f) => picked.has(f.id));
    const bi = blockIndex();
    host.innerHTML = fields.length ? `
      <div class="fe-ol-head">
        <label class="fe-check"><input type="checkbox" data-olall${all ? " checked" : ""} /> Select all</label>
        <small class="muted">Drag ⠿ to move</small>
      </div>
      <ol class="fe-ol-list">${fields.map((f, i) => {
        const label = String(f.label || "").trim() || FIELD_TYPES[f.type].name;
        const w = W_TAG[spanOf(f)];
        const flags = [
          w ? `<span class="fe-ol-w" title="Width on the page">${w}</span>` : "",
          f.required && canRequire(f.type) ? '<span class="fe-ol-req" title="Answer required">*</span>' : "",
          f.showWhen && Array.isArray(f.showWhen.rules) && f.showWhen.rules.length ? `<span title="Shown only for some answers">${svg(BRANCH)}</span>` : "",
          f.liveHide ? `<span title="Hidden from staff">${svg(EYE_OFF)}</span>` : "",
          bi.has(f.id) ? `<span class="fe-ol-blk" title="${esc(blockChipText(bi.get(f.id)))}">${svg(UI.block)}</span>` : "",
          bad && bad.has(f.id) ? `<span class="is-bad" title="${esc(bad.get(f.id))}">${svg(WARN)}</span>` : "",
        ].join("");
        return `<li class="fe-ol-item${f.id === sel ? " is-on" : ""}${picked.has(f.id) ? " is-picked" : ""}" data-olid="${esc(f.id)}">
          <span class="fe-ol-grip" data-olgrip title="Drag to move" aria-hidden="true">⠿</span>
          <input type="checkbox" data-olpick aria-label="Select ${esc(label)}"${picked.has(f.id) ? " checked" : ""} />
          <button type="button" class="fe-ol-go" data-olgo title="${esc(label)}">
            <span class="fe-ol-n">${i + 1}</span>${svg(ICONS[f.type] || ICONS.text_block)}<span class="fe-ol-label">${esc(label)}</span>
          </button>
          <span class="fe-ol-flags">${flags}</span>
        </li>`;
      }).join("")}</ol>`
      : '<p class="fe-note fe-pad">No questions yet. Add them from the Add tab, or copy them from another form.</p>';
    const allBox = host.querySelector("[data-olall]");
    if (allBox) allBox.indeterminate = !all && picked.size > 0;
    if (pal) pal.scrollTop = keep;
  }

  async function openCopyFrom() {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog fe-cf-dlg";
    dlg.innerHTML = '<div class="lh-form"><div class="lh-dialog-head"><h3>Copy questions from another form</h3><p>Loading forms…</p></div></div>';
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();

    let forms;
    try {
      forms = (await listFormTemplates({ isAdmin: true, force: true }))
        .filter((t) => t.id !== templateId && t.status !== "archived" && (t.fields || []).length);
    } catch (err) {
      console.error("Forms not loaded:", err);
      if (dlg.open) dlg.innerHTML = `<div class="lh-form"><div class="lh-dialog-head"><h3>Copy questions from another form</h3>
        <p class="lh-error">Couldn't load the forms. Check your connection and try again.</p></div>
        <div class="lh-actions"><button type="button" class="lh-btn" data-cf="cancel">Close</button></div></div>`;
      return;
    }
    if (!dlg.open) return;

    const has = (type) => fields.some((f) => f.type === type);
    const where = () => {
      const f = current();
      return f ? `after “${String(f.label || "").trim() || FIELD_TYPES[f.type].name}”` : "at the end of this form";
    };
    let src = null, qs = [];
    const chosen = new Set();

    const pickForm = () => {
      const groups = FORM_CATEGORIES.map((c) => [c, forms.filter((t) => t.category === c.key)]).filter(([, l]) => l.length);
      dlg.innerHTML = `<div class="lh-form">
        <div class="lh-dialog-head"><h3>Copy questions from another form</h3>
          <p>Choose a form, then tick the questions you want. The other form isn't changed.</p></div>
        ${forms.length ? `<input type="search" class="fe-input" data-cf="q" placeholder="Search forms" aria-label="Search forms" />
          <div class="fe-cf-forms">${groups.map(([c, list]) => `<div class="fe-cf-grp"><h4>${esc(c.label)}</h4>${list.map((t) => `
            <button type="button" class="fe-cf-form" data-cfform="${esc(t.id)}" data-find="${esc(t.name.toLowerCase())}">
              <strong>${esc(t.name)}</strong>
              <small>${(t.fields || []).length} question${(t.fields || []).length === 1 ? "" : "s"} · ${t.status === "live" ? `Live, version ${t.version}` : "Draft"}</small>
            </button>`).join("")}</div>`).join("")}
            <p class="fe-note" data-role="cfnone" hidden>No forms match that search.</p></div>`
          : '<p class="fe-note">There are no other forms with questions yet.</p>'}
        <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-cf="cancel">Cancel</button></div></div>`;
      const s = dlg.querySelector('[data-cf="q"]');
      if (s) s.focus();
    };

    const pickQs = () => {
      qs = (src.fields || []).map(normaliseField).filter(Boolean);
      dlg.innerHTML = `<div class="lh-form">
        <div class="lh-dialog-head"><h3>${esc(src.name)}</h3><p>Tick the questions to copy. They go ${esc(where())}.</p></div>
        <div class="fe-cf-bar">
          <button type="button" class="lh-btn is-quiet" data-cf="back">← All forms</button>
          <label class="fe-check"><input type="checkbox" data-cf="all" /> Select all</label>
        </div>
        <ol class="fe-cf-qs">${qs.map((f, i) => {
          const blocked = ONE_ONLY.includes(f.type) && has(f.type);
          const cond = f.showWhen && Array.isArray(f.showWhen.rules) && f.showWhen.rules.length;
          return `<li${blocked ? ' class="is-off"' : ""}><label class="fe-check">
            <input type="checkbox" data-cfq="${esc(f.id)}"${blocked ? " disabled" : ""} />
            <span class="fe-ol-n">${i + 1}</span>${svg(ICONS[f.type] || ICONS.text_block)}
            <span class="fe-cf-q"><span>${esc(String(f.label || "").trim() || FIELD_TYPES[f.type].name)}</span>
              <small>${esc(FIELD_TYPES[f.type].name)}${cond ? " · shown only for some answers" : ""}${blocked ? " · this form already has one" : ""}</small></span>
          </label></li>`;
        }).join("")}</ol>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-cf="cancel">Cancel</button>
          <button type="button" class="lh-btn is-primary" data-cf="insert" disabled>Choose questions</button>
        </div></div>`;
    };

    const syncInsert = () => {
      const b = dlg.querySelector('[data-cf="insert"]');
      const all = dlg.querySelector('[data-cf="all"]');
      const boxes = [...dlg.querySelectorAll("[data-cfq]:not(:disabled)")];
      if (b) {
        b.disabled = !chosen.size;
        b.textContent = chosen.size ? `Insert ${chosen.size} question${chosen.size === 1 ? "" : "s"}` : "Choose questions";
      }
      if (all) {
        all.checked = boxes.length > 0 && boxes.every((x) => x.checked);
        all.indeterminate = !all.checked && boxes.some((x) => x.checked);
      }
    };

    const insert = () => {
      const list = qs.filter((f) => chosen.has(f.id));
      if (!list.length) return;
      const { copies, notes } = cloneFields(list, { keepOutside: false });
      if (!copies.length) return;
      const i = fields.findIndex((f) => f.id === sel);
      fields.splice(i < 0 ? fields.length : i + 1, 0, ...copies);
      picked.clear();
      copies.forEach((c) => picked.add(c.id));
      sel = copies[0].id;
      dlg.close();
      changed();
      renderStage();
      renderInspector();
      const el = stage.querySelector(`.fe-field[data-id="${CSS.escape(sel)}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      const extra = [
        notes.rules && `${notes.rules} show-when rule${notes.rules === 1 ? " was" : "s were"} removed, as the question ${notes.rules === 1 ? "it" : "they"} used wasn't copied`,
        notes.calcs && `check the formula in ${notes.calcs} calculation${notes.calcs === 1 ? "" : "s"}`,
        notes.amounts && `${notes.amounts} product amount${notes.amounts === 1 ? " now asks" : "s now ask"} staff to type it`,
      ].filter(Boolean);
      showToast(`Copied ${copies.length} question${copies.length === 1 ? "" : "s"} from “${src.name}”. ${
        extra.length ? `Note: ${extra.join("; ")}.` : "They're selected, so you can move them together."}`);
    };

    dlg.addEventListener("click", (e) => {
      const f = e.target.closest("[data-cfform]");
      if (f) { src = forms.find((x) => x.id === f.dataset.cfform) || null; chosen.clear(); if (src) pickQs(); return; }
      const a = e.target.closest("[data-cf]");
      if (!a) return;
      if (a.dataset.cf === "cancel") dlg.close();
      else if (a.dataset.cf === "back") { src = null; pickForm(); }
      else if (a.dataset.cf === "insert") insert();
    });
    dlg.addEventListener("input", (e) => {
      if (e.target.dataset.cf !== "q") return;
      const q = e.target.value.trim().toLowerCase();
      let any = false;
      dlg.querySelectorAll(".fe-cf-grp").forEach((g) => {
        let n = 0;
        g.querySelectorAll("[data-cfform]").forEach((b) => {
          const hit = !q || b.dataset.find.includes(q);
          b.hidden = !hit;
          if (hit) n++;
        });
        g.hidden = !n;
        if (n) any = true;
      });
      const none = dlg.querySelector('[data-role="cfnone"]');
      if (none) none.hidden = any;
    });
    dlg.addEventListener("change", (e) => {
      if (e.target.dataset.cf === "all") {
        dlg.querySelectorAll("[data-cfq]:not(:disabled)").forEach((b) => {
          b.checked = e.target.checked;
          if (b.checked) chosen.add(b.dataset.cfq); else chosen.delete(b.dataset.cfq);
        });
        syncInsert();
        return;
      }
      const b = e.target.closest("[data-cfq]");
      if (b) { if (b.checked) chosen.add(b.dataset.cfq); else chosen.delete(b.dataset.cfq); syncInsert(); }
    });
    pickForm();
  }
  /* ---------- Reusable blocks ---------- */
  // settings.blocks: [{ gid, blockId, v, map: { blockQuestionId: thisFormQuestionId } }]
  const blockLinks = () => (Array.isArray(settings.blocks) ? settings.blocks : []);
  const blockById = (id) => (blocks || []).find((b) => b.id === id) || null;
  const linkIds = (l) => Object.values(l.map || {});
  const byName = (a, b) => a.name.localeCompare(b.name);
  const cleanForBlock = (list) => {
    const s = formSnapshot({ name: "", fields: list, settings: {} });
    return (s && s.fields) || list;
  };

  function blockIndex() {
    const here = new Set(fields.map((f) => f.id));
    const m = new Map();
    blockLinks().forEach((l) => {
      const ids = new Set(linkIds(l).filter((id) => here.has(id)));
      if (!ids.size) return;
      const first = fields.find((f) => ids.has(f.id));
      const block = blockById(l.blockId);
      ids.forEach((id) => m.set(id, { link: l, block, first: first.id }));
    });
    return m;
  }

  function blockChipText(e) {
    const b = e.block;
    if (!b) return blocks === null ? "From a block" : "From a deleted block";
    return `Block: ${b.name}${b.version > e.link.v ? ` · version ${b.version} available` : ""}`;
  }

  // Links questions to a block (taking them out of any block they were linked to before)
  function linkFields(blockId, v, map) {
    const ids = new Set(Object.values(map));
    const others = blockLinks()
      .map((l) => ({ ...l, map: Object.fromEntries(Object.entries(l.map || {}).filter(([, fid]) => !ids.has(fid))) }))
      .filter((l) => Object.keys(l.map).length);
    settings.blocks = [...others, { gid: newId(), blockId, v, map }];
  }

  function renderBlocks() {
    const host = $('[data-role="blocks"]');
    if (!host) return;
    if (blocks === null) { host.innerHTML = '<p class="fe-blk-empty">Loading saved blocks…</p>'; return; }
    host.innerHTML = `<div class="fe-blocks-h">Saved blocks</div>${blocks.length
      ? `<div class="fe-blk-list">${blocks.map((b) => {
          const n = b.fields.length;
          return `<div class="fe-blk-row">
            <button type="button" class="fe-blk-add" data-blkadd="${esc(b.id)}" title="${esc(b.description || "Insert this block")}">${svg(UI.block)}
              <span><strong>${esc(b.name)}</strong><small>${n} question${n === 1 ? "" : "s"} · version ${b.version}</small></span>
            </button>
            <button type="button" class="fe-blk-x" data-blkdel="${esc(b.id)}" aria-label="Delete ${esc(b.name)}" title="Delete this block">×</button>
          </div>`;
        }).join("")}</div>`
      : '<p class="fe-blk-empty">Select questions (tick them in the Outline) and choose Save as block to reuse them on other forms.</p>'}`;
  }

  function blockNameDialog({ count, note }) {
    return new Promise((resolve) => {
      let result = null;
      const dlg = document.createElement("dialog");
      dlg.className = "lh-dialog fe-blk-dlg";
      dlg.innerHTML = `<form class="lh-form">
        <div class="lh-dialog-head"><h3>Save as a block</h3>
          <p>${count} question${count === 1 ? "" : "s"}. You can insert it into any form from the Add tab.</p></div>
        <label class="lh-field"><span class="lh-label">Block name</span>
          <input type="text" data-f="name" maxlength="120" placeholder="e.g. Medical history" /></label>
        <label class="lh-field"><span class="lh-label">What it's for (optional)</span>
          <input type="text" data-f="desc" maxlength="300" placeholder="Shown when you point at it in the Add tab" /></label>
        ${note ? `<p class="fe-note">${esc(note)}</p>` : ""}
        <p class="lh-error" data-role="err" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="no">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save block</button>
        </div></form>`;
      const form = dlg.querySelector("form");
      const err = dlg.querySelector('[data-role="err"]');
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const nm = form.querySelector('[data-f="name"]').value.trim();
        const bad = !nm ? "Give the block a name."
          : (blocks || []).some((b) => b.name.toLowerCase() === nm.toLowerCase()) ? "There's already a block with that name." : "";
        if (bad) { err.textContent = bad; err.hidden = false; return; }
        result = { name: nm, description: form.querySelector('[data-f="desc"]').value.trim() };
        dlg.close();
      });
      dlg.querySelector('[data-act="no"]').addEventListener("click", () => dlg.close());
      dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
      document.body.appendChild(dlg);
      dlg.showModal();
      form.querySelector('[data-f="name"]').focus();
    });
  }

  async function saveAsBlock(list) {
    const use = list.filter((f) => !ONE_ONLY.includes(f.type));
    if (!use.length) { showToast("Record dates and watermarks can't go in a block."); return; }
    const ids = new Map(use.map((f) => [f.id, f.id]));
    const { copies, notes } = cloneFields(use, { keepOutside: false, ids });
    const out = notes.rules + notes.calcs + notes.amounts;
    const note = [
      use.length < list.length ? "Record dates and watermarks aren't included." : "",
      out ? `${out} link${out === 1 ? "" : "s"} to questions outside the selection (show-when rules, formulas or product amounts) won't be in the block.` : "",
    ].filter(Boolean).join(" ");
    const res = await blockNameDialog({ count: use.length, note });
    if (!res || !root.isConnected) return;
    showToast("Saving the block…");
    try {
      const saved = await saveFormBlock({ name: res.name, description: res.description, fields: cleanForBlock(copies) }, staff);
      if (!root.isConnected) return;
      blocks = [...(blocks || []).filter((b) => b.id !== saved.id), saved].sort(byName);
      linkFields(saved.id, saved.version, Object.fromEntries(use.map((f) => [f.id, f.id])));
      picked.clear();
      changed();
      renderStage();
      renderInspector();
      renderBlocks();
      showToast(`Saved “${saved.name}”. Insert it into any form from the Add tab.`);
    } catch (err) {
      console.error("Block not saved:", err);
      showToast(err.code === "permission-denied" ? "Not saved. Check the Firestore rule for form_blocks has been published." : "Couldn't save the block. Try again.");
    }
  }

  function insertBlock(id) {
    const b = blockById(id);
    if (!b) return;
    const src = b.fields.map(normaliseField).filter(Boolean)
      .filter((f) => !(ONE_ONLY.includes(f.type) && fields.some((x) => x.type === f.type)));
    if (!src.length) { showToast("This block has no questions to add."); return; }
    const { copies, map } = cloneFields(src, { keepOutside: false });
    const i = fields.findIndex((f) => f.id === sel);
    fields.splice(i < 0 ? fields.length : i + 1, 0, ...copies);
    linkFields(b.id, b.version, Object.fromEntries(map));
    picked.clear();
    copies.forEach((c) => picked.add(c.id));
    sel = copies[0].id;
    changed();
    renderStage();
    renderInspector();
    const el = stage.querySelector(`.fe-field[data-id="${CSS.escape(sel)}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    showToast(`Added “${b.name}” (${copies.length} question${copies.length === 1 ? "" : "s"}). They're selected, so you can move them together.`);
  }

  // Replace this form's copy with the latest version of the block
  async function updateFromBlock(gid) {
    const l = blockLinks().find((x) => x.gid === gid);
    const b = l && blockById(l.blockId);
    if (!l || !b) return;
    const here = new Map(fields.map((f) => [f.id, f]));
    const oldIds = linkIds(l).filter((id) => here.has(id));
    const src = b.fields.map(normaliseField).filter(Boolean);
    const ids = new Map(Object.entries(l.map || {}).filter(([, fid]) => here.has(fid)));
    const kept = new Set(src.map((s) => ids.get(s.id)).filter(Boolean));
    const gone = oldIds.filter((id) => !kept.has(id)).map((id) => here.get(id));
    const uses = [...new Set(gone.flatMap((f) => fieldUses(f, new Set(oldIds))))];
    const ok = await confirmDialog({
      title: `Update to version ${b.version} of “${b.name}”?`,
      message: `This form's ${oldIds.length} question${oldIds.length === 1 ? "" : "s"} from the block are replaced with the latest ${src.length}. `
        + "Any changes made to them on this form only are lost. "
        + (uses.length ? `Removed questions are used by ${uses.slice(0, 6).join(", ")}${uses.length > 6 ? ` and ${uses.length - 6} more` : ""}. ` : "")
        + "Undo brings the old ones back. Publish afterwards so staff get it.",
      confirm: "Update",
      tone: "primary",
    });
    if (!ok || !root.isConnected) return;
    const { copies, map } = cloneFields(src, { keepOutside: false, ids });
    copies.forEach((c) => { const o = here.get(c.id); if (o && o.tag) c.tag = o.tag; });   // keep a tag name given on this form
    const old = new Set(oldIds);
    const at = fields.findIndex((f) => old.has(f.id));
    const rest = fields.filter((f) => !old.has(f.id));
    rest.splice(at < 0 ? rest.length : at, 0, ...copies);
    fields.splice(0, fields.length, ...rest);
    settings.blocks = blockLinks().map((x) => (x.gid === gid ? { ...x, v: b.version, map: Object.fromEntries(map) } : x));
    picked.clear();
    sel = copies.length ? copies[0].id : FORM;
    changed();
    renderStage();
    renderInspector();
    showToast(`Updated to version ${b.version}. Publish when you're ready.`);
  }

  // Send this form's copy back to the block as its next version
  async function pushToBlock(gid) {
    const l = blockLinks().find((x) => x.gid === gid);
    const b = l && blockById(l.blockId);
    if (!l || !b) return;
    const rev = new Map(Object.entries(l.map || {}).map(([bid, fid]) => [fid, bid]));
    const group = fields.filter((f) => rev.has(f.id));
    if (!group.length) return;
    const ok = await confirmDialog({
      title: `Save as version ${b.version + 1} of “${b.name}”?`,
      message: `The block becomes these ${group.length} question${group.length === 1 ? "" : "s"}, as they are on this form. `
        + "Other forms that use it show “version available” and only change when someone updates them there.",
      confirm: "Save to the block",
      tone: "primary",
    });
    if (!ok || !root.isConnected) return;
    const { copies } = cloneFields(group, { keepOutside: false, ids: new Map(group.map((f) => [f.id, rev.get(f.id)])) });
    try {
      const saved = await saveFormBlock({ id: b.id, name: b.name, description: b.description, fields: cleanForBlock(copies) }, staff);
      if (!root.isConnected) return;
      blocks = (blocks || []).map((x) => (x.id === saved.id ? saved : x));
      settings.blocks = blockLinks().map((x) => (x.gid === gid ? { ...x, v: saved.version } : x));
      changed();
      renderStage();
      renderInspector();
      renderBlocks();
      showToast(`“${saved.name}” is now version ${saved.version}.`);
    } catch (err) {
      console.error("Block not updated:", err);
      showToast(err.code === "gone" ? err.message
        : err.code === "permission-denied" ? "Not saved. Check the Firestore rule for form_blocks has been published." : "Couldn't save the block. Try again.");
    }
  }

  function unlinkBlock(gid) {
    settings.blocks = blockLinks().filter((x) => x.gid !== gid);
    changed();
    renderStage();
    renderInspector();
    showToast("Unlinked. The questions stay as ordinary questions.");
  }

  async function deleteBlock(id) {
    const b = blockById(id);
    if (!b) return;
    const ok = await confirmDialog({
      title: `Delete the block “${b.name}”?`,
      message: "It's taken out of the Add tab. Forms that already use it keep their questions.",
      confirm: "Delete block",
    });
    if (!ok || !root.isConnected) return;
    try {
      await archiveFormBlock(id, staff);
      blocks = (blocks || []).filter((x) => x.id !== id);
      renderBlocks();
      renderStage();
      if (current() && blockIdx.has(sel)) renderInspector();
      showToast(`Deleted “${b.name}”.`);
    } catch (err) {
      console.error("Block not deleted:", err);
      showToast("Couldn't delete the block. Try again.");
    }
  }

  function blockBoxHtml(f) {
    const e = blockIndex().get(f.id);
    if (!e) return "";
    const { link, block } = e;
    const n = linkIds(link).filter((id) => fields.some((x) => x.id === id)).length;
    const newer = block && block.version > link.v;
    return `<div class="fe-insp-field fe-blkbox${newer ? " is-new" : ""}">
      <span class="fe-insp-label">${svg(UI.block)}Part of a block</span>
      ${block
        ? `<strong>${esc(block.name)}</strong>
           <small class="fe-note">${n} question${n === 1 ? "" : "s"} on this form. This form has version ${link.v}${
             newer ? `, and version ${block.version} is available.` : ", the latest."}</small>`
        : `<small class="fe-note">${blocks === null ? "Loading…" : "The block has been deleted. These questions stay on the form."}</small>`}
      <div class="fe-blk-acts">
        ${newer ? `<button type="button" class="lh-btn is-primary" data-blkupd="${esc(link.gid)}">Update to version ${block.version}</button>` : ""}
        ${block ? `<button type="button" class="lh-btn" data-blkpush="${esc(link.gid)}">Save changes to the block</button>` : ""}
        <button type="button" class="lh-btn is-quiet" data-blkunlink="${esc(link.gid)}">Unlink</button>
      </div>
      <small class="fe-note">Edits here stay on this form until you save them to the block. Questions you add next to it aren't part of the block.</small>
    </div>`;
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

  /* ---------- Sticky top bar ---------- */
  function initStickyTop() {
    const top = $(".fe-top");
    const sentinel = $(".fe-top-sentinel");
    if (!top) return;
    const panels = [$(".fe-palette"), insp];

    const measure = () => {
      if (!root.isConnected) return;
      // Sit below the portal's own top bar if that one stays on screen
      const tb = document.querySelector(".topbar");
      const tbPos = tb ? getComputedStyle(tb).position : "";
      const offset = tb && (tbPos === "sticky" || tbPos === "fixed") ? Math.round(tb.getBoundingClientRect().height) : 0;
      top.style.top = `${offset}px`;
      const below = offset + Math.round(top.getBoundingClientRect().height);
      // The side panels start under the bar instead of sliding beneath it
      panels.forEach((el) => {
        if (el && getComputedStyle(el).position === "sticky") {
          el.style.top = `${below + 12}px`;
          el.style.maxHeight = `calc(100vh - ${below + 24}px)`;
        }
      });
    };
    new ResizeObserver(measure).observe(top);
    window.addEventListener("resize", function onResize() {
      if (!root.isConnected) { window.removeEventListener("resize", onResize); return; }
      measure();
    });

    // Compact look once the page has scrolled
    if (sentinel && "IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => top.classList.toggle("is-stuck", !entry.isIntersecting))
        .observe(sentinel);
    }
    measure();
  }

  /* ---------- Events ---------- */
  root.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (m) { setMode(m.dataset.mode); renderStage(); return; }
    if (e.target.closest('[data-act="staff-view"]')) { staffView = !staffView; renderStage(); return; }
    const pt = e.target.closest("[data-paltab]");
    if (pt) {
      palTab = pt.dataset.paltab;
      try { localStorage.setItem("fe-paltab", palTab); } catch { /* storage blocked */ }
      root.querySelectorAll("[data-paltab]").forEach((b) => {
        const on = b === pt;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      });
      $('[data-role="paladd"]').hidden = palTab !== "add";
      $('[data-role="outline"]').hidden = palTab !== "outline";
      renderOutline();
      return;
    }
    if (e.target.closest('[data-act="copy-from"]')) { openCopyFrom(); return; }
    const ba = e.target.closest("[data-blkadd]");
    if (ba) { insertBlock(ba.dataset.blkadd); return; }
    const bd = e.target.closest("[data-blkdel]");
    if (bd) { deleteBlock(bd.dataset.blkdel); return; }
    const bk = e.target.closest("[data-bulk]");
    if (bk) { if (!bk.disabled) bulk(bk.dataset.bulk); return; }
    const bs = e.target.closest("[data-bulkspan]");
    if (bs) { bulk("span", bs.dataset.bulkspan); return; }
    if (e.target.closest('[data-act="undo"]')) { undo(); return; }
    if (e.target.closest('[data-act="redo"]')) { redo(); return; }
    if (e.target.closest('[data-act="issues"]')) { const p = publishProblems(); if (p.length) openProblems(p); return; }
    if (e.target.closest('[data-act="publish"]')) { publish(); return; }
    if (e.target.closest('.fe-top [data-act="unpublish"]')) { unpublish(); return; }
    if (e.target.closest('[data-act="discard"]')) { discardChanges(); return; }
    if (e.target.closest('.fe-top [data-act="duplicate"]')) {
      openDuplicateDialog({ name, category: tpl.category, fields, settings }, staff);
      return;
    }
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
    if (mode === "preview" && tableClick(e.target, fields)) { refreshPreview(); return; }
    const btnf = mode === "preview" && e.target.closest("[data-btnf]");
    if (btnf) { // Preview never leaves the editor
      e.preventDefault();
      const h = btnf.getAttribute("href");
      showToast(h ? `On the real form this opens ${h}` : "Add a link to this button first.");
      return;
    }
    if (mode !== "build") return;
    if (e.target.closest('[data-role="lh"], [data-role="title"]')) { select(FORM); return; }
    const fieldEl = e.target.closest(".fe-field[data-id]");
    if (!fieldEl) return;
    const t = e.target.closest("[data-tool]");
    if (t) { tool(t.dataset.tool, fieldEl.dataset.id); return; }
    const id = fieldEl.dataset.id;
    if (e.shiftKey || e.ctrlKey || e.metaKey) { pickClick(id, e.shiftKey); return; }
    const had = picked.size;
    picked.clear();
    if (id === sel) { if (had) renderStage(); return; }
    select(id);
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

  stage.addEventListener("input", (e) => {
    if (e.target.matches && e.target.matches("[data-linked]")) e.target.dataset.touched = "1";
    refreshPreview();
  });

  insp.addEventListener("input", (e) => {
    if (e.target.closest(".re")) return;
    if (e.target.dataset.onlineAfter !== undefined) { saveAfter(e.target); return; }
    if (e.target.dataset.online !== undefined || e.target.dataset.onlineStaff !== undefined) { saveOnline(e.target); return; }
    const el = e.target;
    if (el.dataset.s) {
      settings[el.dataset.s] = el.type === "checkbox" ? el.checked : el.value;
      changed(`s:${el.dataset.s}`);
      renderStage();
      return;
    }
    const f = current();
    if (!f) return;
    if (el.dataset.opt !== undefined) {
      const i = Number(el.dataset.opt);
      renameInPrefill(f, f.options[i], el.value);
      f.options[i] = el.value;
    } else if (el.dataset.k) {
      const k = el.dataset.k;
      const tagBefore = k === "label" || k === "tag" ? tagOwnerName(f) : "";
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
      if (tagBefore) followTag(f, tagBefore); // renaming a question: everywhere its tag is used follows
    } else if (el.dataset.cond !== undefined || el.dataset.rule !== undefined) {
      if (!applyConditionInput(f, el, fields)) return;
    } else if (!applyInput(f, el)) {
      return;
    }
    changed(`${f.id}:${el.dataset.k || (el.dataset.opt !== undefined ? `opt${el.dataset.opt}` : el.dataset.col !== undefined ? `col${el.dataset.col}${el.dataset.colk}` : "x")}`);
    if (el.dataset.rerender !== undefined) renderStage(); else redraw(f);
    // Typing sub-options: refresh just that option's comment list (the textarea keeps focus)
    if (el.dataset.grpk === "subs") {
      const host = insp.querySelector(`[data-subx="${el.dataset.grp}"]`);
      if (host) host.innerHTML = subExtrasHtml(f.groups[Number(el.dataset.grp)], Number(el.dataset.grp));
    }
    if (el.dataset.rerender !== undefined) { renderInspector(); return; }
    if (f.type === "calculation") {
      const st = insp.querySelector('[data-role="calc-status"]');
      if (st) st.innerHTML = calcStatusHtml(f, fields);
    }
  });

  insp.addEventListener("change", (e) => {
    if (e.target.closest(".re")) return;
    if (e.target.matches("[data-cat]")) { changeCategory(e.target.value); return; }
    if (e.target.matches('input[type="file"][data-img-upload]')) { uploadImage(current(), e.target); return; }
    const f = current();
    const el = e.target;
    if (f && el.dataset.k && el.dataset.num !== undefined && el.type !== "range" && el.tagName === "INPUT") {
      el.value = f[el.dataset.k] ?? "";
    }
  });

  insp.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-calcins], [data-tcalcins]")) e.preventDefault(); // keep the cursor in the formula
  });
  // Which box "Insert a tag" goes into: the last one typed in (including a Text block or starting text)
  let tagKey = "label", richEl = null;
  insp.addEventListener("focusin", (e) => {
    if (e.target.isContentEditable) { tagKey = "__rich"; richEl = e.target; return; }
    const k = e.target.dataset && e.target.dataset.k;
    if (k === "label" || k === "help" || k === "prefill" || k === "url") { tagKey = k; richEl = null; }
  });
  insp.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-taginsert]")) e.preventDefault(); // keep the cursor where it is
  });

  insp.addEventListener("click", (e) => {
    if (e.target.closest(".re")) return;
    if (e.target.closest('[data-act="edit-lh"]')) { editLetterhead(); return; }
    if (e.target.closest('[data-act="printer"]')) { openPrinterDialog(staff); return; }
    if (e.target.closest('[data-act="delete-form"]')) { deleteForm(); return; }
    if (e.target.closest('[data-act="unpublish"]')) { unpublish(); return; }
    const f = current();
    if (!f) return;

    const bu = e.target.closest("[data-blkupd]");
    if (bu) { updateFromBlock(bu.dataset.blkupd); return; }
    const bp = e.target.closest("[data-blkpush]");
    if (bp) { pushToBlock(bp.dataset.blkpush); return; }
    const bx = e.target.closest("[data-blkunlink]");
    if (bx) { unlinkBlock(bx.dataset.blkunlink); return; }

    const ti = e.target.closest("[data-taginsert]");
    if (ti) {
      const tok = ti.dataset.taginsert;
      if (tagKey === "__rich" && richEl && richEl.isConnected) {
        richEl.focus();
        document.execCommand("insertText", false, tok); // the editor saves it like typing
        return;
      }
      const el = insp.querySelector(`[data-k="${tagKey}"]`) || insp.querySelector('[data-k="label"]');
      if (!el) return;
      const s = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? s;
      el.value = el.value.slice(0, s) + tok + el.value.slice(end);
      el.focus();
      el.setSelectionRange(s + tok.length, s + tok.length);
      el.dispatchEvent(new Event("input", { bubbles: true })); // saves it like typing
      return;
    }
    const cp = e.target.closest('[data-act="tag-copy"]');
    if (cp) {
      if (navigator.clipboard) navigator.clipboard.writeText(cp.dataset.tag).then(() => showToast(`Copied ${cp.dataset.tag}`)).catch(() => {});
      return;
    }

    if (e.target.closest('[data-act="sp-bank"]')) {
      openSpecialistBankDialog({ staff })
        .then(() => listSpecialists({ force: true }))
        .then((list) => {
          specialities = specialitiesOf(list);
          if (root.isConnected) renderInspector();
        })
        .catch((err) => console.warn("Couldn't refresh the Specialist Bank:", err));
      return;
    }
    if (e.target.closest('[data-act="ms-manage"]')) {
      openMarkingSetsDialog({ staff }).then((sets) => {
        if (!sets || !root.isConnected) return;
        markSets = sets;
        renderStage();
        renderInspector();
      });
      return;
    }

    if (e.target.closest('[data-act="ac-pick"]')) {
      openAftercarePicker({ selected: f.items || [] }).then((ids) => {
        if (!ids || !root.isConnected) return;
        const target = fields.find((x) => x.id === f.id);
        if (!target) return;
        target.items = ids;
        changed(); renderStage(); renderInspector();
      });
      return;
    }
    if (e.target.closest('[data-act="cs-pick"]')) {
      openProductPicker(products, (f.items || []).map((it) => it.productId)).then((ids) => {
        if (!ids || !root.isConnected) return;
        const target = fields.find((x) => x.id === f.id);
        if (!target) return;
        const old = new Map((target.items || []).map((it) => [it.productId, it]));
        target.items = ids.map((id) => {
          const p = products.find((x) => x.id === id);
          const o = old.get(id);
          const kit = isKitProduct(p);
          return {
            productId: id, name: p ? p.name : (o && o.name) || "Product", kind: kit ? "kit" : "storage",
            unit: p ? (kit || p.dosePer ? p.doseUnit : p.stockUnit) : (o && o.unit) || "",
            required: o ? o.required : false, amount: o ? o.amount : null, max: o ? o.max : null,
            from: o ? o.from || "" : "",
            multi: o ? o.multi !== false : true,
          };
        });
        changed(); renderStage(); renderInspector();
      });
      return;
    }
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
      redraw(f);
      const st = insp.querySelector('[data-role="calc-status"]');
      if (st) st.innerHTML = calcStatusHtml(f, fields);
      return;
    }

    const del = e.target.closest("[data-optdel]");
    if (del) {
      if (f.options.length > 1) {
        f.options.splice(Number(del.dataset.optdel), 1);
        tidyPrefill(f);
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
    changed("name");
  });
  nameInput.addEventListener("blur", () => {
    if (!nameInput.value.trim()) {
      name = "Untitled form";
      nameInput.value = name;
      changed();
    }
  });
  /* ---------- Keyboard shortcuts ---------- */
  const isTyping = (t) => !!t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT"
    || (t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes(t.type)));
  const onField = (t) => !!(t && t.closest && t.closest(".fe-field[data-id], [data-olid]"));
  function focusSel(inOutline = false) {
    const el = inOutline
      ? root.querySelector(`[data-olid="${CSS.escape(sel)}"] [data-olgo]`)
      : stage.querySelector(`.fe-field[data-id="${CSS.escape(sel)}"]`);
    if (el) el.focus();
  }
  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (document.querySelector("dialog[open]")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = String(e.key || "").toLowerCase();
    const inOl = !!(e.target && e.target.closest && e.target.closest("[data-olid]"));
    if (mod && k === "s") { e.preventDefault(); dirty = true; flush(); return; }
    if (isTyping(e.target)) return;   // inside a box: the browser's own undo and typing
    if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mode !== "build") return;
    const many = picked.size > 0;
    const f = current();
    const arrow = e.key === "ArrowUp" || e.key === "ArrowDown";
    const dir = e.key === "ArrowUp" ? -1 : 1;

    if (mod && k === "a" && onField(e.target)) {
      e.preventDefault();
      fields.forEach((x) => picked.add(x.id));
      renderStage();
      return;
    }
    if (mod && k === "d" && (many || f)) {
      e.preventDefault();
      if (many) bulk("copy"); else { tool("copy", f.id); focusSel(inOl); }
      return;
    }
    if (e.altKey && arrow && (many || f)) {
      e.preventDefault();
      if (many) moveBlock([...picked], dir); else tool(dir < 0 ? "up" : "down", f.id);
      focusSel(inOl);
      return;
    }
    // Plain arrows and Delete only act when a question (on the page or in the outline) has focus
    if (!mod && !e.altKey && arrow && onField(e.target)) {
      e.preventDefault();
      const i = fields.findIndex((x) => x.id === sel);
      const next = fields[Math.max(0, Math.min(fields.length - 1, (i < 0 ? 0 : i) + dir))];
      if (!next) return;
      if (e.shiftKey) {
        if (sel !== FORM) picked.add(sel);
        picked.add(next.id);
        sel = next.id;
        renderStage();
        renderInspector();
      } else {
        picked.clear();
        if (next.id === sel) renderStage(); else select(next.id);
      }
      focusSel(inOl);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && onField(e.target) && (many || f)) {
      e.preventDefault();
      if (many) removeMany(pickedFields()); else removeField(f.id);
      return;
    }
    if (e.key === "Escape") {
      if (many) { picked.clear(); renderStage(); }
      else if (sel !== FORM) select(FORM);
    }
  };
  document.addEventListener("keydown", onKey);

  /* ---------- Outline: jump, tick, drag to reorder (mouse, pen or finger) ---------- */
  const olHost = $('[data-role="outline"]');
  olHost.addEventListener("click", (e) => {
    const go = e.target.closest("[data-olgo]");
    if (go) goTo(go.closest("[data-olid]").dataset.olid);
  });
  olHost.addEventListener("change", (e) => {
    if (e.target.matches("[data-olall]")) {
      if (e.target.checked) fields.forEach((f) => picked.add(f.id)); else picked.clear();
      renderStage();
      return;
    }
    const box = e.target.closest("[data-olpick]");
    if (!box) return;
    const id = box.closest("[data-olid]").dataset.olid;
    if (box.checked) picked.add(id); else picked.delete(id);
    renderStage();
    const again = olHost.querySelector(`[data-olid="${CSS.escape(id)}"] [data-olpick]`);
    if (again) again.focus();
  });

  let olDrag = null;
  const olClear = () => olHost.querySelectorAll(".is-drop-before, .is-drop-after")
    .forEach((el) => el.classList.remove("is-drop-before", "is-drop-after"));
  olHost.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-olgrip]");
    if (!grip || mode !== "build") return;
    const li = grip.closest("[data-olid]");
    const id = li.dataset.olid;
    const ids = picked.has(id) && picked.size > 1 ? pickedFields().map((f) => f.id) : [id];
    const items = [...olHost.querySelectorAll("[data-olid]")];
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    olDrag = {
      ids, li, items, y0: e.clientY, to: null,
      mids: items.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; }),
    };
    items.filter((el) => ids.includes(el.dataset.olid)).forEach((el) => el.classList.add("is-dragging"));
    document.body.classList.add("is-arranging");
  });
  olHost.addEventListener("pointermove", (e) => {
    if (!olDrag) return;
    olDrag.li.style.transform = `translateY(${e.clientY - olDrag.y0}px)`;
    let to = olDrag.mids.findIndex((m) => e.clientY < m);
    if (to < 0) to = olDrag.items.length;
    if (to === olDrag.to) return;
    olDrag.to = to;
    olClear();
    const target = olDrag.items[to];
    if (target) target.classList.add("is-drop-before");
    else olDrag.items[olDrag.items.length - 1].classList.add("is-drop-after");
  });
  const olEnd = (cancel) => {
    if (!olDrag) return;
    const { ids, items, to } = olDrag;
    olDrag = null;
    document.body.classList.remove("is-arranging");
    if (cancel || to === null) { renderOutline(); return; }
    let k = to;
    while (items[k] && ids.includes(items[k].dataset.olid)) k++;   // dropped among the ones being moved
    if (ids.length === 1) sel = ids[0];
    moveTo(ids, items[k] ? items[k].dataset.olid : null);
  };
  olHost.addEventListener("pointerup", () => olEnd(false));
  olHost.addEventListener("pointercancel", () => olEnd(true));
  /* ---------- Drag and drop ---------- */
  let drag = null, dropAt = null;
  const clearLine = () => stage.querySelectorAll(".is-drop-before, .is-drop-after")
    .forEach((el) => el.classList.remove("is-drop-before", "is-drop-after", "is-drop-side"));
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

  // Full-width questions: top or bottom half. Side-by-side ones: left or right half.
  stage.addEventListener("dragover", (e) => {
    if (!drag || mode !== "build") return;
    const list = stage.querySelector('[data-role="fields"]');
    if (!list) return;
    e.preventDefault();
    const lr = list.getBoundingClientRect();
    const items = [...list.querySelectorAll(".fe-field[data-id]")];
    let i = items.length;
    for (let k = 0; k < items.length; k++) {
      const r = items[k].getBoundingClientRect();
      const before = r.width > lr.width * 0.8
        ? e.clientY < r.top + r.height / 2
        : e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
      if (before) { i = k; break; }
    }
    if (i === dropAt) return;
    dropAt = i;
    clearLine();
    if (items[i]) {
      items[i].classList.add("is-drop-before");
      if (items[i].getBoundingClientRect().left > lr.left + 24) items[i].classList.add("is-drop-side");
    } else if (items.length) {
      items[items.length - 1].classList.add("is-drop-after");
    }
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
    const items = [...stage.querySelectorAll('[data-role="fields"] .fe-field[data-id]')];
    const ids = picked.has(drag.id) && picked.size > 1 ? pickedFields().map((f) => f.id) : [drag.id];
    let k = dropAt;
    while (items[k] && ids.includes(items[k].dataset.id)) k++;
    endDrag();
    if (ids.length === 1) sel = ids[0];
    moveTo(ids, items[k] ? items[k].dataset.id : null);
  });

  root.addEventListener("dragend", endDrag);
  
  /* ---------- Start ---------- */
  renderStage();
  renderInspector();
  renderPublish();
  lastSnap = snap();   // the starting point for Undo
  syncUndo();
  renderBlocks();
  listFormBlocks()
    .then((list) => {
      blocks = list;
      if (!root.isConnected) return;
      renderBlocks();
      renderStage();
      if (current() && blockIdx.has(sel)) renderInspector();
    })
    .catch((err) => {
      console.warn("Couldn't load blocks:", err);
      blocks = [];
      if (root.isConnected) renderBlocks();
    });
  makeResizable(root);
  initStickyTop();

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

  listAftercare()
    .then((list) => {
      aftercareMap = new Map(list.map((a) => [a.id, a]));
      if (!root.isConnected) return;
      renderStage();
      const f = current();
      if (f && f.type === "aftercare") renderInspector();
    })
    .catch((err) => console.warn("Couldn't load aftercare:", err));

  listFormTemplates({ isAdmin: true })
    .then((list) => {
      const pick = (cat) => list
        .filter((t) => t.category === cat && t.id !== templateId)
        .map((t) => ({ id: t.id, name: t.name, status: t.status }));
      consentForms = pick("consent");
      prescriptionForms = pick("prescription");
      if (!root.isConnected) return;
      renderStage();
      const f = current();
      if (f && (f.type === "consent_status" || f.type === "prescription_status")) renderInspector();
    })
    .catch((err) => console.warn("Couldn't load consent and prescription forms:", err));

  listTaskTypes({ isAdmin: true })
    .then((list) => {
      emailTemplates = list.filter((t) => t.category === "patient" && t.channel === "email")
        .map((t) => ({ id: t.id, name: t.name, status: t.status }));
      const f = current();
      if (root.isConnected && f && f.type === "aftercare") renderInspector();
    })
    .catch((err) => console.warn("Couldn't load email templates:", err));

  listProducts()
    .then((list) => {
      products = list;
      const f = current();
      if (root.isConnected && f && f.type === "consumables") renderInspector();
    })
    .catch((err) => console.warn("Couldn't load products:", err));

  listMarkingSets()
    .then((sets) => {
      markSets = sets;
      if (!root.isConnected) return;
      const f = current();
      if (f && f.type === "image") renderInspector();
      if (mode === "preview") renderStage();
    })
    .catch((err) => { console.warn("Couldn't load marking sets:", err); markSets = []; });
    
    listSpecialists()
    .then((list) => {
      specialities = specialitiesOf(list);
      const f = current();
      if (root.isConnected && f && f.type === "specialist") renderInspector();
    })
    .catch((err) => console.warn("Couldn't load the Specialist Bank:", err));
}
