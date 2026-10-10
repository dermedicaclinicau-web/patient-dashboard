// Task Builder: the Task types list and the task editor.
import {
  listTaskTypes, getTaskType, createTaskType, saveTaskType, taskSnapshot, fetchStaffList,
  TASK_FIELD_TYPES, TASK_CHOICE_TYPES, CHOICE_DISPLAYS,
} from "./task-types.js";
import {
  tokenGroups, taskProblems, fillTemplate, sampleValues, subjectHtml, clinicDetails,
  fillTemplateHtml, emailShell, EMAIL_BACKGROUNDS, EMAIL_ACCENTS, formatChoice,
} from "./task-tokens.js";
import { SOURCES, loadSource } from "./task-sources.js";
import { createRichEditor } from "./rich-editor.js";
import { hydrateRichImages } from "./rich-html.js";
import { openImagePicker } from "./image-bank.js";
import { listPublishedForms, getLetterhead } from "./form-templates.js";
import { confirmDialog } from "./dialog.js";
import { showToast, formatMobile } from "./utils.js";
import {
  cleanSchedule, describeSchedule, scheduleProblems, nextSlots, FREQS, WEEK_ORDER, DAY_NAMES,
  fmtTime, fmtSlot, getClosedDays, openClosedDaysDialog, listScheduleStates,
} from "./task-schedule.js";
import { searchPatients } from "./task-runner.js";
import { getPatient } from "./patients.js";
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  plus: ic('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  patient: ic('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  staff: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  up: ic('<polyline points="18 15 12 9 6 15"/>'),
  down: ic('<polyline points="6 9 12 15 18 9"/>'),
  trash: ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  x: ic('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  link: ic('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  chev: ic('<polyline points="9 18 15 12 9 6"/>'),
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  copy: ic('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
};
const CAT_LABEL = { patient: "To Patient", staff: "To Staff" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => "t_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const PATIENT_TOKENS = ["Patient name", "Patient first name", "Patient mobile", "Patient email"];
const PATIENT_RE = /\{\s*(patient name|patient first name|patient mobile|patient email|upcoming appointments|treatment plan)\s*\}/gi;

function blankField(type) {
  const f = { id: newId(), type, label: "", required: false, help: "", placeholder: "" };
  if (TASK_CHOICE_TYPES.includes(type)) {
    f.source = "list";
    f.display = type === "checkboxes" ? "bullets" : "inline";
    f.options = [{ label: "Option 1", link: "" }, { label: "Option 2", link: "" }];
  }
  return f;
}
function treatmentsField() {
  return { ...blankField("checkboxes"), label: "Treatments", required: true, source: "treatments", display: "links",
    options: [], help: "Tick the treatments to send information about." };
}

function aftercareField() {
  return { ...blankField("checkboxes"), label: "Aftercare instructions", source: "aftercare", display: "links",
    options: [], help: "Tick the aftercare instructions to send." };
}

function editedAgo(date) {
  if (!date) return "";
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "Edited just now";
  if (mins < 60) return `Edited ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Edited ${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return "Edited " + date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/* ===================== Starter tasks ===================== */

function starters() {
  return [
    {
      name: "Send Treatment Info",
      description: "Email the patient information about the treatments discussed.",
      category: "patient", channel: "email",
      fields: [treatmentsField()],
      recipients: { mode: "patient", staffIds: [], cc: "", aboutPatient: false },
      subject: "Your treatment information - Dermedica",
      body: "Hi {First name},\n\nThank you for visiting Dermedica. Here is the information about the treatments we discussed:\n\n{Treatments}\n\nIf you have any questions, just reply to this email or call us on {Clinic phone}.\n\nKind regards,\n{Staff name}\nDermedica",
      attachments: [],
    },
    {
      name: "Send Schedule",
      description: "Email the patient their upcoming appointments and treatment plan.",
      category: "patient", channel: "email",
      fields: [{ ...blankField("long_text"), label: "Note", help: "Optional. Anything else to tell the patient." }],
      recipients: { mode: "patient", staffIds: [], cc: "", aboutPatient: false },
      subject: "Your upcoming appointments - Dermedica",
      body: "Hi {First name},\n\nHere are your upcoming appointments with us:\n\n{Upcoming appointments}\n\nYour treatment plan:\n\n{Treatment plan}\n\n{Note}\n\nIf you need to change anything, just reply to this email or call us on {Clinic phone}.\n\nKind regards,\n{Staff name}\nDermedica",
      attachments: [],
    },
    {
      name: "Staff reminder",
      description: "Email a reminder to one or more staff members.",
      category: "staff", channel: "email",
      fields: [
        { ...blankField("long_text"), label: "Reminder", required: true },
        { ...blankField("date"), label: "Due date" },
      ],
      recipients: { mode: "choose", staffIds: [], cc: "", aboutPatient: false },
      subject: "Reminder from {Staff name}",
      body: "Hi {First name},\n\n{Reminder}\n\nDue: {Due date}\n\nThanks,\n{Staff name}",
      attachments: [],
    },
  ];
}

/* ===================== Task types list ===================== */

export async function mountTaskTypes(main, { staff } = {}) {
  let tab = "all";
  main.innerHTML = `
    <div class="tb-head">
      <div>
        <h3 class="tm-h">Task types</h3>
        <p class="muted tm-sub">Set a task up once, then anyone can run it from Create new task.</p>
      </div>
      <div class="ff-bar-actions">
        <button type="button" class="ff-btn" data-act="closed">Clinic closed days</button>
        <button type="button" class="ff-btn" data-act="starters">Add starter tasks</button>
        <button type="button" class="ff-btn is-primary" data-act="new">${I.plus}<span>New task type</span></button>
      </div>
    </div>
    <div class="pt-tabs tb-tabs" role="group" aria-label="Show">
      <button type="button" data-tab="all" class="active">All</button>
      <button type="button" data-tab="patient">To Patient</button>
      <button type="button" data-tab="staff">To Staff</button>
    </div>
    <div class="tm-tasks" data-role="list"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>`;
  const list = main.querySelector('[data-role="list"]');
  let types = [];
  let states = new Map();
  let closed = [];
  const schedLine = (t) => {
    if (t.category !== "staff" || !t.schedule || !t.schedule.enabled) return "";
    if (t.schedule.paused) return " · 🔁 Paused";
    const st = states.get(t.id);
    const next = st && st.nextMs ? st.nextMs : (nextSlots(t.schedule, { count: 1, closed })[0] || {}).ms;
    return ` · 🔁 ${next ? `Next ${fmtSlot(next)}` : "No more sends"}${st && st.count ? ` · Sent ${st.count}×` : ""}`;
  };

  function render() {
    if (!types.length) {
      list.innerHTML = `<div class="tm-empty"><strong>No task types yet.</strong><br>
        Start with three ready-made tasks you can edit (Send Treatment Info, Send Schedule and Staff reminder), or create your own.
        <div class="tm-empty-act">
          <button type="button" class="ff-btn is-primary" data-act="starters">Add starter tasks</button>
          <button type="button" class="ff-btn" data-act="new">New task type</button>
        </div></div>`;
      return;
    }
    const rows = types.filter((t) => tab === "all" || t.category === tab);
    list.innerHTML = rows.length ? rows.map((t) => `
      <a class="tm-task" href="#/tasks/types/${encodeURIComponent(t.id)}">
        <span class="tm-task-icon">${t.category === "staff" ? I.staff : I.patient}</span>
        <span class="tm-task-main"><strong>${esc(t.name)}</strong>
          <small>${esc([CAT_LABEL[t.category], t.channel === "sms" ? "SMS" : "Email",
            `${t.fields.length} field${t.fields.length === 1 ? "" : "s"}`, editedAgo(t.updatedAt)].filter(Boolean).join(" · ") + schedLine(t))}</small></span>
        <span class="tb-pill ${t.status === "live" ? "is-live" : "is-draft"}">${t.status === "live" ? "Live" : "Draft"}</span>
        <span class="tm-task-go">${I.chev}</span>
      </a>`).join("")
      : '<div class="tm-empty">Nothing in this category yet.</div>';
  }

  async function load(force = false) {
    try {
      [types, states, closed] = await Promise.all([
        listTaskTypes({ isAdmin: true, force }), listScheduleStates(), getClosedDays().catch(() => []),
      ]);
      if (list.isConnected) render();
    } catch (err) {
      console.error("Task types load failed:", err);
      if (list.isConnected) list.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
        ? "Task types are blocked. Check the task_types Firestore rules have been published."
        : "Couldn't load task types. Check your connection and try again."}</div>`;
    }
  }

  main.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) {
      tab = t.dataset.tab;
      main.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b === t));
      render();
      return;
    }
    if (e.target.closest('[data-act="new"]')) { newTaskDialog(staff); return; }
    if (e.target.closest('[data-act="closed"]')) {
      openClosedDaysDialog(staff).then((d) => { if (d) { closed = d; render(); } });
      return;
    }
    const s = e.target.closest('[data-act="starters"]');
    if (s) {
      s.disabled = true;
      s.textContent = "Adding…";
      try {
        for (const st of starters()) await createTaskType(st, staff);
        showToast("Starter tasks added as drafts. Open one to check it, then publish.");
        await load(true);
      } catch (err) {
        console.error("Starter tasks failed:", err);
        showToast(err.code === "permission-denied" ? "Only admins can add task types." : "Couldn't add the starter tasks. Try again.");
      }
      if (s.isConnected) { s.disabled = false; s.textContent = "Add starter tasks"; }
    }
  });

  load();
}

function newTaskDialog(staff) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog fe-confirm";
  dlg.innerHTML = `
    <form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>New task type</h3><p>You can change all of this later.</p></div>
      <label class="lh-field"><span class="lh-label">Name</span>
        <input type="text" name="name" maxlength="120" placeholder="e.g. Send aftercare instructions" /></label>
      <div class="lh-field"><span class="lh-label">Sent to</span>
        <div class="fe-seg">
          <label class="fe-seg-btn"><input type="radio" name="category" value="patient" checked /><span>To Patient</span></label>
          <label class="fe-seg-btn"><input type="radio" name="category" value="staff" /><span>To Staff</span></label>
        </div></div>
      <div class="lh-field"><span class="lh-label">Sent by</span>
        <div class="fe-seg">
          <label class="fe-seg-btn"><input type="radio" name="channel" value="email" checked /><span>Email</span></label>
          <label class="fe-seg-btn is-soon" title="Coming soon"><input type="radio" name="channel" value="sms" disabled /><span>SMS · coming soon</span></label>
        </div></div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Create task</button>
      </div>
    </form>`;
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) { err.textContent = "Give the task a name."; err.hidden = false; return; }
    const category = form.elements.category.value;
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const id = await createTaskType({
        name, category, channel: "email", fields: [], attachments: [],
        recipients: { mode: category === "staff" ? "choose" : "patient", staffIds: [], cc: "", aboutPatient: false },
        subject: "",
        body: category === "patient"
          ? "Hi {First name},\n\n\n\nKind regards,\n{Staff name}\nDermedica"
          : "Hi {First name},\n\n\n\nThanks,\n{Staff name}",
      }, staff);
      dlg.close();
      location.hash = `#/tasks/types/${encodeURIComponent(id)}`;
    } catch (ex) {
      console.error("Create task failed:", ex);
      err.textContent = ex.code === "permission-denied" ? "Only admins can create task types." : "Couldn't create the task. Try again.";
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = "Create task";
    }
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  form.elements.name.focus();
}

/* ===================== Task editor ===================== */

export async function mountTaskEditor(container, { id, staff } = {}) {
  const back = '<a class="back-link" href="#/tasks/types">← Task types</a>';
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = back + '<div class="skeleton" style="height:420px;border-radius:14px"></div>';
  container.replaceChildren(root);

  let loaded;
  try {
    loaded = await getTaskType(id);
  } catch (err) {
    console.error("Task load failed:", err);
    if (root.isConnected) root.innerHTML = back + '<div class="state error"><strong>Couldn\'t open this task</strong>Check your connection and try again.</div>';
    return;
  }
  if (!root.isConnected) return;
  if (!loaded || loaded.status === "archived") {
    root.innerHTML = back + '<div class="state"><strong>This task type has been deleted</strong>Go back to Task types to choose another.</div>';
    return;
  }

  const task = taskSnapshot(loaded);
  let status = loaded.status;
  let letterhead = null, printables = null, staffList = null, staffError = false;
  const sources = {};
  const sourceRequested = new Set();
  let dirty = false, saving = false, saveTimer = null;
  let lastText = null; // the subject box, or null for the message editor
  let lastPatientTokens = 0;
  function patientTokens() {
    return (`${task.subject || ""} ${task.body || ""}`.match(PATIENT_RE) || []).length;
  }
  let closedDays = [];
  let schedState = null; // the scheduler's record for this task (count, last send, problems)
  let schedPatient = null; // the patient automatic sends are about
  let schSeq = 0, schTimer = null;
  task.schedule = cleanSchedule(task.schedule);

  root.innerHTML = `
    <div class="ff-wrap tb-wrap">
      <div class="ff-bar" role="region" aria-label="Task actions">
        <div class="ff-bar-inner">
          <a class="ff-back" href="#/tasks/types" aria-label="Back to Task types" title="Back to Task types">${I.back}</a>
          <div class="ff-bar-title">
            <strong data-role="title"></strong>
            <span><span data-role="sub"></span> · <span data-role="state">All changes saved</span></span>
          </div>
          <span class="tb-pill" data-role="pill"></span>
          <div class="ff-bar-actions">
            <button type="button" class="ff-btn is-quiet" data-act="delete">${I.trash}<span>Delete</span></button>
            <button type="button" class="ff-btn" data-act="duplicate">${I.copy}<span>Duplicate</span></button>
            <button type="button" class="ff-btn is-primary" data-act="publish">${I.send}<span>Publish</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      <div class="tb-grid">
        <div class="tb-form" data-role="form">
          <div class="tb-sec" data-sec="top"></div>
          <section class="tb-card" data-sec="message">
            <h4><span class="tb-num">4</span>Message</h4>
            <label class="tb-field"><span>Subject</span>
              <input class="fe-input" data-set="subject" data-tokens maxlength="200" value="${esc(task.subject)}" /></label>
            <div class="tb-field"><span>Message</span><div data-role="editor"></div></div>
            <div class="tb-chips" data-role="chips"></div>
            <small class="muted">Tap a blank to add it where your cursor is. Use the toolbar for headings, colours, pictures, buttons and dividers. Staff can still change the wording before sending.</small>
          </section>
          <div class="tb-sec" data-sec="bottom"></div>
        </div>
        <aside class="tb-preview" data-role="preview" aria-label="Preview"></aside>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const form = $('[data-role="form"]');
  const topSec = $('[data-sec="top"]');
  const bottomSec = $('[data-sec="bottom"]');
  const preview = $('[data-role="preview"]');
  const stateEl = $('[data-role="state"]');
  const msgEl = $('[data-role="msg"]');
  const pubBtn = $('[data-act="publish"]');
  const tokenOpts = () => ({ staffName: staff && staff.name, letterhead, sources });

  const editor = createRichEditor($('[data-role="editor"]'), {
    onInput: () => { task.body = editor.getHtml(); changed(); },
    onFocus: () => { lastText = null; },
    pickImage: () => openImagePicker({ isAdmin: true }),
    accent: () => task.style.accent,
    logo: () => (letterhead && letterhead.logo) || "",
  });
  editor.setHtml(task.body);
  lastPatientTokens = patientTokens();

  /* ---------- Saving ---------- */
  function setState(s) {
    stateEl.textContent = s === "saving" ? "Saving…" : s === "dirty" ? "Unsaved changes" : s === "error" ? "Couldn't save. Retrying…" : "All changes saved";
  }
  // Every problem, with the patient clash shown once instead of two messages that contradict each other
  function allProblems() {
    return [...taskProblems(task), ...scheduleProblems(task)];
  }

  function changed() {
    // Adding a patient blank to a staff task turns on "This is about a patient"
    const pt = patientTokens();
    if (task.category === "staff" && !task.recipients.aboutPatient && pt > lastPatientTokens) {
      task.recipients.aboutPatient = true;
      renderForm();
      showToast("Turned on “This is about a patient”. Staff will choose the patient when they run it.");
    }
    lastPatientTokens = pt;
    dirty = true;
    setState("dirty");
    msgEl.textContent = "";
    renderPreview();
    renderBar();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 800);
  }
    async function flush() {
    clearTimeout(saveTimer);
    if (!dirty || saving) return;
    saving = true;
    dirty = false;
    setState("saving");
    let failed = false;
    try {
      prepareSchedule();
      await saveTaskType(id, task, staff);
      setState(dirty ? "dirty" : "saved");
    } catch (err) {
      console.error("Task save failed:", err);
      failed = true;
      dirty = true;
      setState("error");
    } finally {
      saving = false;
      if (dirty) saveTimer = setTimeout(flush, failed ? 4000 : 400);
    }
  }
  async function settle() { clearTimeout(saveTimer); while (saving) await wait(100); }

  const onBeforeUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ""; } };
  const onHashChange = () => {
    if (root.isConnected) return;
    flush();
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("hashchange", onHashChange);

  /* ---------- Connected lists ---------- */
  function loadSources() {
    task.fields.forEach((f) => {
      const src = f.source;
      if (!TASK_CHOICE_TYPES.includes(f.type) || !src || src === "list" || sourceRequested.has(src)) return;
      sourceRequested.add(src);
      loadSource(src)
        .then((opts) => { sources[src] = opts; })
        .catch((err) => { console.warn(`Couldn't load ${src}:`, err); sources[src] = null; })
        .finally(() => { if (root.isConnected) { renderForm(); renderPreview(); } });
    });
  }

  /* ---------- The top bar ---------- */
  function renderBar() {
    const live = status === "live";
    $('[data-role="title"]').textContent = task.name.trim() || "Untitled task";
    $('[data-role="sub"]').textContent = `${CAT_LABEL[task.category]} · Email`;
    const pill = $('[data-role="pill"]');
    pill.className = "tb-pill " + (live ? "is-live" : "is-draft");
    pill.textContent = live ? "Live" : "Draft";
    pubBtn.querySelector("span").textContent = live ? "Unpublish" : "Publish";
    pubBtn.classList.toggle("is-primary", !live);
  }

  /* ---------- The steps ---------- */
  const seg = (name, items, current, attrs = "") => `<div class="fe-seg">${items.map(([v, l, disabled]) =>
    `<label class="fe-seg-btn${disabled ? " is-soon" : ""}"><input type="radio" name="tb-${name}" value="${v}"${
      current === v ? " checked" : ""}${disabled ? " disabled" : ` ${attrs}`} /><span>${l}</span></label>`).join("")}</div>`;

  function aboutHtml() {
    return `
      <section class="tb-card">
        <h4><span class="tb-num">1</span>About this task</h4>
        <label class="tb-field"><span>Name</span>
          <input class="fe-input" data-set="name" maxlength="120" value="${esc(task.name)}" /></label>
        <label class="tb-field"><span>Description <small>(shown to staff when they choose a task)</small></span>
          <textarea class="fe-input" data-set="description" rows="2" maxlength="300" placeholder="e.g. Email the patient information about their treatments.">${esc(task.description)}</textarea></label>
        <div class="tb-two">
          <div class="tb-field"><span>Sent to</span>
            ${seg("category", [["patient", "To Patient"], ["staff", "To Staff"]], task.category, 'data-set="category" data-rerender=""')}</div>
          <div class="tb-field"><span>Sent by</span>
            ${seg("channel", [["email", "Email"], ["sms", "SMS · coming soon", true]], "email", 'data-set="channel"')}</div>
        </div>
      </section>`;
  }

  function recipientsHtml() {
    const r = task.recipients;
    if (task.category === "patient") {
      return `
        <section class="tb-card">
          <h4><span class="tb-num">2</span>Who it goes to</h4>
          <p class="tb-info">The patient's email address from their record. Staff can change it before sending.</p>
          <label class="tb-field"><span>Always copy in <small>(optional)</small></span>
            <input class="fe-input" type="email" data-set="recipients.cc" maxlength="254" placeholder="e.g. info@dermedica.com.au" value="${esc(r.cc)}" /></label>
        </section>`;
    }
    let staffPick = "";
    if (r.mode === "fixed") {
      staffPick = staffList === null
        ? `<p class="tb-none">${staffError ? "Couldn't load the staff list. Refresh to try again." : "Loading staff…"}</p>`
        : `<div class="tb-staff">${staffList.map((s) => `
            <label class="fe-check"><input type="checkbox" data-staff="${esc(s.id)}"${r.staffIds.includes(s.id) ? " checked" : ""}${
              s.hasEmail ? "" : " disabled"} /> ${esc(s.name)} <small>${esc(s.role || "")}${s.hasEmail ? "" : " · no email on file"}</small></label>`).join("")}</div>`;
    }
    return `
      <section class="tb-card">
        <h4><span class="tb-num">2</span>Who it goes to</h4>
        ${seg("mode", [["choose", "Staff choose each time"], ["fixed", "Always these staff"]], r.mode, 'data-set="recipients.mode" data-rerender=""')}
        ${staffPick}
        <label class="fe-check"><input type="checkbox" data-set="recipients.aboutPatient" data-rerender=""${r.aboutPatient ? " checked" : ""} />
          This is about a patient <small class="muted">(staff choose the patient, and the patient's details become blanks)</small></label>
        <label class="tb-field"><span>Always copy in <small>(optional)</small></span>
          <input class="fe-input" type="email" data-set="recipients.cc" maxlength="254" value="${esc(r.cc)}" /></label>
      </section>`;
  }

  function choiceHtml(f, i) {
    const src = f.source || "list";
    let body;
    if (src === "list") {
      body = `
        <div class="tb-opts">${(f.options || []).map((o, oi) => `
          <div class="tb-opt">
            <input class="fe-input" data-fi="${i}" data-oi="${oi}" data-ok="label" maxlength="120" placeholder="Choice ${oi + 1}" value="${esc(o.label)}" aria-label="Choice ${oi + 1}" />
            <label class="tb-opt-link">${I.link}<input class="fe-input" data-fi="${i}" data-oi="${oi}" data-ok="link" maxlength="500" placeholder="Link (optional)" value="${esc(o.link)}" aria-label="Link for choice ${oi + 1}" /></label>
            <button type="button" class="ib-tool is-danger" data-odel="${i}:${oi}" aria-label="Remove choice ${oi + 1}" title="Remove">${I.x}</button>
          </div>`).join("")}</div>
        <button type="button" class="hx-add" data-oadd="${i}">+ Add a choice</button>`;
    } else {
      const items = sources[src];
      if (items === undefined) body = '<p class="tb-none">Loading the list…</p>';
      else if (items === null) body = '<p class="tb-none tb-bad">Couldn\'t load this list. Check your connection and refresh.</p>';
      else {
        const linked = items.filter((x) => x.link).length;
        body = `<div class="tb-info">
          <strong>${items.length} choice${items.length === 1 ? "" : "s"}</strong> from ${esc(SOURCES[src].name)}${
            src === "treatments" || src === "aftercare" ? `, ${linked} with links` : ""}. This list stays up to date automatically.
          <div class="tb-src-sample">${items.slice(0, 6).map((x) => `<span>${esc(x.label)}${x.link ? ` ${I.link}` : ""}</span>`).join("")}${
            items.length > 6 ? `<span>+${items.length - 6} more</span>` : ""}</div></div>`;
      }
    }
    return `
      <div class="tb-two">
        <label class="tb-field"><span>Choices come from</span>
          <select class="fb-select" data-fi="${i}" data-fk="source" data-rerender="">${Object.entries(SOURCES).map(([k, s]) =>
            `<option value="${k}"${src === k ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label class="tb-field"><span>In the message, show the answer</span>
          <select class="fb-select" data-fi="${i}" data-fk="display">${Object.entries(CHOICE_DISPLAYS).map(([k, l]) =>
            `<option value="${k}"${(f.display || "inline") === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      </div>
      ${body}`;
  }

  function fieldCard(f, i) {
    const choice = TASK_CHOICE_TYPES.includes(f.type);
    return `
      <div class="tb-fcard">
        <div class="tb-frow">
          <span class="tb-ftype">${esc(TASK_FIELD_TYPES[f.type])}</span>
          <input class="fe-input" data-fi="${i}" data-fk="label" maxlength="120" placeholder="Field name, e.g. Due date" value="${esc(f.label)}" aria-label="Field ${i + 1} name" />
          <label class="fe-check tb-req"><input type="checkbox" data-fi="${i}" data-fk="required"${f.required ? " checked" : ""} /> Required</label>
          <button type="button" class="ib-tool" data-fmove="${i}" data-dir="-1"${i === 0 ? " disabled" : ""} aria-label="Move up" title="Move up">${I.up}</button>
          <button type="button" class="ib-tool" data-fmove="${i}" data-dir="1"${i === task.fields.length - 1 ? " disabled" : ""} aria-label="Move down" title="Move down">${I.down}</button>
          <button type="button" class="ib-tool is-danger" data-fdel="${i}" aria-label="Remove field" title="Remove">${I.trash}</button>
        </div>
        ${choice ? choiceHtml(f, i) : ""}
        <input class="fe-input tb-help" data-fi="${i}" data-fk="help" maxlength="300" placeholder="Help text for staff (optional)" value="${esc(f.help)}" />
        ${task.category === "staff" && task.schedule.enabled ? `<input class="fe-input tb-help" data-fi="${i}" data-fk="default" maxlength="500"
          placeholder="Answer used for automatic sends${TASK_CHOICE_TYPES.includes(f.type) ? " (choice names, separated by commas)" : ""}${
            f.required ? " (required)" : ""}" value="${esc(f.default || "")}" />` : ""}
        </div>`;
  }

  function fieldsHtml() {
    const hasTx = task.fields.some((f) => f.source === "treatments");
    const hasAc = task.fields.some((f) => f.source === "aftercare");
    return `
      <section class="tb-card">
        <h4><span class="tb-num">3</span>Fields to fill in when running <small>(optional)</small></h4>
        <p class="muted tb-note">Questions staff answer each time. Use the answers in the message, like {Due date}.</p>
        <div class="tb-fields">${task.fields.map(fieldCard).join("") || '<p class="tb-none">No fields yet.</p>'}</div>
        <div class="tb-add">
          ${Object.entries(TASK_FIELD_TYPES).map(([k, l]) => `<button type="button" class="fe-ins" data-addfield="${k}">+ ${esc(l)}</button>`).join("")}
          ${hasTx ? "" : '<button type="button" class="fe-ins is-smart" data-addfield="treatments">+ Treatments (from Treatment information)</button>'}
          ${hasAc ? "" : '<button type="button" class="fe-ins is-smart" data-addfield="aftercare">+ Aftercare (from Aftercare Bank)</button>'}
        </div>
      </section>`;
  }

  function designHtml() {
    const s = task.style;
    const sw = (key, list) => `<div class="tb-swatches">${list.map((c) => `
      <label class="tb-sw" title="${c}"><input type="radio" name="tb-${key}" data-style="${key}" value="${c}"${s[key] === c ? " checked" : ""} />
        <span style="background:${c}"></span></label>`).join("")}</div>`;
    const hasLogo = !!(letterhead && letterhead.logo);
    return `
      <section class="tb-card">
        <h4><span class="tb-num">5</span>Email design</h4>
        <div class="tb-two">
          <div class="tb-field"><span>Background</span>${sw("background", EMAIL_BACKGROUNDS)}</div>
          <div class="tb-field"><span>Accent <small>(headings, links and buttons)</small></span>${sw("accent", EMAIL_ACCENTS)}</div>
        </div>
        <div class="tb-field"><span>Width</span>${seg("width", [["600", "Standard"], ["700", "Wide"]], String(s.width), 'data-style="width"')}</div>
        <label class="fe-check"><input type="checkbox" data-style="logo"${s.logo ? " checked" : ""} /> Clinic logo at the top${
          hasLogo || !letterhead ? "" : ' <small class="muted">(add a logo to the letterhead in Form Builder first)</small>'}</label>
        <label class="fe-check"><input type="checkbox" data-style="footer"${s.footer ? " checked" : ""} /> Clinic details at the bottom</label>
      </section>`;
  }

  function attachmentsHtml() {
    let inner;
    if (printables === null) inner = '<p class="tb-none">Loading printables…</p>';
    else if (!printables.length) inner = '<p class="tb-none">No published printables yet. Publish one in <a href="#/forms">Form Builder</a> under Printables.</p>';
    else {
      const full = task.attachments.length >= 3;
      inner = `<div class="tb-attach">${printables.map((p) => {
        const on = task.attachments.includes(p.id);
        return `<label class="fe-check"><input type="checkbox" data-attach="${esc(p.id)}"${on ? " checked" : ""}${!on && full ? " disabled" : ""} /> ${esc(p.name)}</label>`;
      }).join("")}</div>`;
    }
    return `
      <section class="tb-card">
        <h4><span class="tb-num">6</span>Attachments <small>(optional)</small></h4>
        ${inner}
        <small class="muted">Attached as PDFs, up to 3.</small>
      </section>`;
  }

    function renderChips() {
    const box = $('[data-role="chips"]');
    const groups = tokenGroups(task, tokenOpts());
    // Staff tasks: always offer the patient blanks. Using one turns on "This is about a patient".
    if (task.category === "staff" && !task.recipients.aboutPatient) {
      groups.splice(1, 0, {
        title: "Patient it's about (staff choose the patient when running)",
        tokens: PATIENT_TOKENS.map((name) => ({ name, kind: "", hint: "Using this turns on “This is about a patient”" })),
      });
    }
    box.innerHTML = groups.map((g) => `
      <div class="tb-chipgroup"><span>${esc(g.title)}</span>
        <div class="fe-chiprow">${g.tokens.map((t) => `<button type="button" class="fe-ins${
          t.kind === "smart" ? " is-smart" : t.kind === "field" ? " is-field" : ""}" data-token="${esc(t.name)}"${
          t.hint ? ` title="${esc(t.hint)}"` : ""}>{${esc(t.name)}}</button>`).join("")}</div></div>`).join("");
  }

    /* ---------- Schedule (To Staff only) ---------- */
  const pad2 = (n) => String(n).padStart(2, "0");
  const TIMES = [];
  for (let h = 0; h < 24; h++) for (const m of [0, 15, 30, 45]) TIMES.push(`${pad2(h)}:${pad2(m)}`);

  function scheduleInfoHtml() {
    const s = task.schedule;
    if (!s.enabled) return "";
    const sent = Number((schedState && schedState.count) || 0);
    const left = s.end === "count" && s.freq !== "once" ? Math.max(0, s.endCount - sent) : 5;
    const slots = s.paused ? [] : nextSlots(s, { count: Math.min(5, left), closed: closedDays });
    return `
      <p class="tb-sch-sum">🔁 ${esc(describeSchedule(s))}</p>
      ${s.paused ? '<p class="tb-none">Paused: nothing is sent until you untick Paused.</p>'
        : slots.length ? `<div class="tb-sch-next"><span>Next sends (Perth time)</span><ul>${slots.map((x) => `
            <li>${esc(fmtSlot(x.ms))}${x.moved ? ' <small class="muted">(moved from a skipped day)</small>' : ""}</li>`).join("")}</ul>
            ${s.onlyApptDays ? '<small class="muted">Days without appointments are skipped when the time comes.</small>' : ""}</div>`
        : '<p class="tb-none">No upcoming sends with these settings.</p>'}
      ${schedState ? `<small class="muted">Sent ${sent} time${sent === 1 ? "" : "s"}${schedState.lastSentAt
        ? `, last ${esc(fmtSlot(Date.parse(schedState.lastSentAt)))}` : ""}${schedState.lastError
        ? ` · <span class="tb-bad">Last problem: ${esc(schedState.lastError)}</span>` : ""}</small>` : ""}`;
  }
  function renderScheduleInfo() {
    const box = form.querySelector('[data-role="sch-info"]');
    if (box) box.innerHTML = scheduleInfoHtml();
  }

  function schedPatientHtml() {
    const s = task.schedule;
    const name = (schedPatient && schedPatient.id === s.patientId && schedPatient.name) || s.patientName;
    const body = s.patientId && name
      ? `<div class="tb-pchip"><span><strong>${esc(name)}</strong>${schedPatient && schedPatient.email
          ? `<small>${esc(schedPatient.email)}</small>` : ""}</span>
          <button type="button" class="hx-add" data-act="sch-patient-clear">Change</button></div>`
      : `<div class="tb-psearch">
          <input class="fe-input" data-role="sch-psearch" placeholder="Search for the patient by name" autocomplete="off" spellcheck="false" aria-label="Patient for automatic sends" />
          <div class="tb-presults" data-role="sch-presults"></div></div>`;
    return `<div class="tb-field"><span>Patient for automatic sends</span>${body}
      <small class="muted">Automatic sends are about this patient. When staff run the task themselves, they still choose the patient.</small></div>`;
  }

  function schSearch(q) {
    const box = form.querySelector('[data-role="sch-presults"]');
    clearTimeout(schTimer);
    if (!box) return;
    if (q.trim().length < 2) { box.innerHTML = q.trim() ? '<p class="tb-none">Type at least 2 letters</p>' : ""; return; }
    box.innerHTML = '<p class="tb-none">Searching…</p>';
    const seq = ++schSeq;
    schTimer = setTimeout(async () => {
      let list;
      try { list = await searchPatients(q); }
      catch (err) {
        console.warn("Patient search failed:", err);
        if (seq === schSeq && box.isConnected) box.innerHTML = '<p class="tb-none tb-bad">Couldn\'t search. Check your connection.</p>';
        return;
      }
      if (seq !== schSeq || !box.isConnected) return;
      box.innerHTML = list.length ? list.map((r) => `
        <button type="button" class="tb-presult" data-sch-patient="${esc(r.id)}">
          <strong>${esc(r.name)}</strong><small>${esc([r.dob && `DOB ${r.dob}`, r.email || "No email on file"].filter(Boolean).join(" · "))}</small>
        </button>`).join("") : '<p class="tb-none">No patients found. Try their last name.</p>';
    }, 250);
  }

  async function pickSchedPatient(pid) {
    let p;
    try { p = await getPatient(pid); }
    catch (err) { console.error("Patient load failed:", err); showToast("Couldn't open that patient. Try again."); return; }
    if (!p || !root.isConnected) return;
    schedPatient = p;
    task.schedule.patientId = p.id;
    task.schedule.patientName = String(p.name || "").slice(0, 120);
    renderForm();
    changed();
  }

  function scheduleHtml() {
    const s = task.schedule;
    const head = '<h4><span class="tb-num">7</span>Schedule <small>(optional)</small></h4>';
    const mode = seg("schmode", [["manual", "Only when someone runs it"], ["auto", "Send automatically"]],
      s.enabled ? "auto" : "manual", 'data-sch="enabled" data-rerender=""');
    if (!s.enabled) {
      return `<section class="tb-card">${head}${mode}
        <small class="muted">Send this to the chosen staff automatically, for example every weekday at 8:00 am.</small></section>`;
    }
    const opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${esc(l)}</option>`;
    let extra = "";
    if (s.freq === "weekly") {
      extra = `
        <div class="tb-field"><span>On</span><div class="tb-days">${WEEK_ORDER.map((d) => `
          <label class="tb-day"><input type="checkbox" data-sch="day" value="${d}"${s.days.includes(d) ? " checked" : ""} /><span>${DAY_NAMES[d]}</span></label>`).join("")}</div></div>
        <label class="tb-field"><span>Repeat</span><select class="fb-select" data-sch="everyWeeks">
          ${opt(1, "Every week", s.everyWeeks)}${opt(2, "Every 2 weeks", s.everyWeeks)}</select></label>`;
    } else if (s.freq === "monthlyDate") {
      extra = `<label class="tb-field"><span>On day</span><select class="fb-select" data-sch="monthDay">
        ${Array.from({ length: 31 }, (_, i) => opt(String(i + 1), String(i + 1), s.monthDay)).join("")}${opt("last", "Last day of the month", s.monthDay)}</select>
        <small class="muted">Months with fewer days use their last day.</small></label>`;
    } else if (s.freq === "monthlyNth") {
      extra = `<div class="tb-two">
        <label class="tb-field"><span>Which</span><select class="fb-select" data-sch="nth">
          ${[["1", "First"], ["2", "Second"], ["3", "Third"], ["4", "Fourth"], ["last", "Last"]].map(([v, l]) => opt(v, l, s.nth)).join("")}</select></label>
        <label class="tb-field"><span>Day</span><select class="fb-select" data-sch="nthDay">
          ${WEEK_ORDER.map((d) => opt(d, DAY_NAMES[d], s.nthDay)).join("")}</select></label></div>`;
    } else if (s.freq === "everyN") {
      extra = `<label class="tb-field"><span>Every</span><div class="fe-num">
        <input class="fe-input" type="number" min="2" max="60" data-sch="everyN" value="${s.everyN}" /><span>days</span></div></label>`;
    }
    const canSkipWeekends = !["weekdays", "weekly", "once"].includes(s.freq);
    return `
      <section class="tb-card tb-sched">
        ${head}${mode}
        <div class="tb-two">
          <label class="tb-field"><span>How often</span><select class="fb-select" data-sch="freq" data-rerender="">
            ${FREQS.map(([v, l]) => opt(v, l, s.freq)).join("")}</select></label>
          <label class="tb-field"><span>Time <small>(Perth)</small></span><select class="fb-select" data-sch="time">
            ${TIMES.map((t) => opt(t, fmtTime(t), s.time)).join("")}</select></label>
        </div>
        ${extra}
        <label class="tb-field"><span>${s.freq === "once" ? "Send on" : "Starts on"}</span>
          <input class="fe-input" type="date" data-sch="date" value="${esc(s.date)}" /></label>
        ${task.recipients.aboutPatient ? schedPatientHtml() : ""}
        ${s.freq !== "once" ? `
        <div class="tb-field"><span>Stops</span>
          ${seg("schend", [["never", "Never"], ["date", "On a date"], ["count", "After a number of sends"]], s.end, 'data-sch="end" data-rerender=""')}
          ${s.end === "date" ? `<input class="fe-input" type="date" data-sch="endDate" value="${esc(s.endDate)}" />` : ""}
          ${s.end === "count" ? `<div class="fe-num"><input class="fe-input" type="number" min="1" max="999" data-sch="endCount" value="${s.endCount}" /><span>sends</span></div>` : ""}
        </div>` : ""}
        <div class="tb-field"><span>Conditions</span>
          ${canSkipWeekends ? `<label class="fe-check"><input type="checkbox" data-sch="skipWeekends" data-rerender=""${s.skipWeekends ? " checked" : ""} /> Skip weekends</label>` : ""}
          <label class="fe-check"><input type="checkbox" data-sch="skipClosed" data-rerender=""${s.skipClosed ? " checked" : ""} /> Skip clinic closed days
            <button type="button" class="hx-add tb-closed-btn" data-act="sch-closed">Clinic closed days (${closedDays.length})</button></label>
          <label class="fe-check"><input type="checkbox" data-sch="onlyApptDays"${s.onlyApptDays ? " checked" : ""} /> Only send on days with appointments</label>
          ${(s.skipClosed || (canSkipWeekends && s.skipWeekends)) ? `
          <label class="tb-field"><span>If a send falls on a skipped day</span><select class="fb-select" data-sch="onSkip">
            ${opt("skip", "Skip that send", s.onSkip)}${opt("next", "Send on the next open day", s.onSkip)}</select></label>` : ""}
        </div>
        <label class="fe-check"><input type="checkbox" data-sch="paused"${s.paused ? " checked" : ""} /> Paused</label>
        <div class="tb-sch-info" data-role="sch-info">${scheduleInfoHtml()}</div>
        ${status !== "live" ? '<p class="tb-info">Publish the task to start the schedule.</p>' : ""}
        <div><button type="button" class="ff-btn" data-act="sch-test">Send a test to me</button></div>
      </section>`;
  }

  // The finished email for automatic sends: everything filled in except {First name}, {Full name} and {Today}
  // The finished email for automatic sends: everything filled in except {First name}, {Full name} and {Today}
  function prepareSchedule() {
    const s = task.schedule;
    if (task.category !== "staff" || !s.enabled) { s.renderedHtml = ""; s.renderedSubject = ""; return; }
    const about = task.recipients.aboutPatient;
    // Keep the last prepared email until the patient's details have loaded
    if (about && s.patientId && (!schedPatient || schedPatient.id !== s.patientId)) return;
    const p = about && schedPatient ? schedPatient : {};
    const c = clinicDetails(letterhead);
    const vals = new Map();
    const set = (k, v) => vals.set(k.toLowerCase(), v == null ? "" : String(v));
    set("First name", "{First name}"); set("Full name", "{Full name}"); set("Today", "{Today}");
    set("Staff name", "The Dermedica team");
    set("Clinic phone", c.phone); set("Clinic email", c.email); set("Clinic address", c.address);
    set("Patient name", p.name); set("Patient first name", p.firstName);
    set("Patient mobile", p.mobile ? formatMobile(p.mobile) : ""); set("Patient email", p.email);
    ["Upcoming appointments", "Treatment plan", "Treatment info", "Aftercare"].forEach((k) => set(k, ""));
    task.fields.forEach((f) => { if (String(f.label || "").trim()) set(f.label.trim(), defaultAnswer(f)); });
    s.renderedSubject = fillTemplate(task.subject, vals).replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1").slice(0, 200);
    s.renderedHtml = emailShell(fillTemplateHtml(task.body, vals), task.style, { clinic: c, hasLogo: !!(letterhead && letterhead.logo) });
  }

  // A field's answer for automatic sends. For choice fields, names that match the list become links.
  function defaultAnswer(f) {
    const raw = String(f.default || "").trim();
    if (!raw || !TASK_CHOICE_TYPES.includes(f.type)) return raw;
    const opts = (f.source || "list") === "list" ? (f.options || []) : (sources[f.source] || []);
    const find = (w) => opts.find((o) => String(o.label || "").trim().toLowerCase() === w.toLowerCase());
    const whole = find(raw);
    if (whole) return formatChoice(f, [whole]);
    const wanted = raw.split(/\s*[,;\n]\s*/).filter(Boolean);
    const chosen = wanted.map(find).filter(Boolean);
    return chosen.length === wanted.length ? formatChoice(f, chosen) : raw;
  }

  async function testSend(btn) {
    const probs = scheduleProblems(task).filter((p) => !/already passed/.test(p));
    if (probs.length) { showToast(probs[0]); return; }
    btn.disabled = true;
    btn.textContent = "Sending…";
    dirty = true;
    await flush();
    await settle();
    try {
      const r = await callApi({ action: "scheduledTask", op: "test", taskId: id });
      showToast(`Test sent to ${r.to}`);
    } catch (err) {
      console.error("Test send failed:", err);
      showToast(err.code === "NO_EMAIL" ? "There's no email address on your staff record. Add one in Staff."
        : err.code === "FORBIDDEN" ? "Only staff who build task types can send tests."
        : err.code === "INVALID_PIN" ? "The server hasn't been updated yet. Deploy a new Apps Script version."
        : "Couldn't send the test. Check Apps Script → Executions.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Send a test to me";
    }
  }

  // Everything except the message editor, which stays put while you work
  function renderForm() {
    topSec.innerHTML = aboutHtml() + recipientsHtml() + fieldsHtml();
    bottomSec.innerHTML = designHtml() + attachmentsHtml() + (task.category === "staff" ? scheduleHtml() : "");
    renderChips();
  }

  /* ---------- Preview ---------- */
  function renderPreview() {
    const values = sampleValues(task, tokenOpts());
    const problems = allProblems();
    const r = task.recipients;
    let to;
    if (task.category === "patient") to = "Jane Citizen &lt;jane@example.com&gt;";
    else if (r.mode === "fixed") {
      const names = (staffList || []).filter((s) => r.staffIds.includes(s.id)).map((s) => esc(s.name));
      to = names.length ? names.join(", ") + (names.length > 1 ? " <small>(each gets their own copy)</small>" : "") : "<em>No one chosen yet</em>";
    } else to = "<em>The staff chosen when it's run</em>";
    const attNames = (printables || []).filter((p) => task.attachments.includes(p.id));
    const hasLogo = !!(letterhead && letterhead.logo);

    preview.innerHTML = `
      <div class="tb-prev">
        <div class="tb-prev-head"><span>Preview</span><small>With example details</small></div>
        ${problems.length
          ? `<div class="tb-problems"><strong>Before publishing</strong><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`
          : '<div class="tb-ready">Ready to publish</div>'}
        <div class="tb-mail">
          <div class="tb-mail-row"><span>To</span><span>${to}</span></div>
          ${r.cc ? `<div class="tb-mail-row"><span>CC</span><span>${esc(r.cc)}</span></div>` : ""}
          <div class="tb-mail-row"><span>Subject</span><strong>${subjectHtml(fillTemplate(task.subject, values)) || "<em>No subject yet</em>"}</strong></div>
          <div class="tb-mail-body tb-mail-shell" data-role="shell">${emailShell(fillTemplateHtml(task.body, values), task.style,
            { clinic: clinicDetails(letterhead), hasLogo })}</div>
          ${attNames.length ? `<div class="tb-mail-att">${attNames.map((p) => `<span class="tb-att">${I.doc}${esc(p.name)}.pdf</span>`).join("")}</div>` : ""}
        </div>
        <small class="muted">Highlighted parts are filled in from the fields when the task is run. Choices show real examples from your lists.</small>
      </div>`;
    hydrateRichImages(preview.querySelector('[data-role="shell"]'), { logo: (letterhead && letterhead.logo) || "" });
  }

  /* ---------- Editing ---------- */
  function setValue(path, v) {
    if (path === "category") {
      task.category = v === "staff" ? "staff" : "patient";
      task.recipients.mode = task.category === "staff" ? (task.recipients.mode === "fixed" ? "fixed" : "choose") : "patient";
      if (task.category === "patient") task.recipients.aboutPatient = false;
      return;
    }
    if (path.startsWith("recipients.")) { task.recipients[path.slice(11)] = v; return; }
    task[path] = v;
  }

  form.addEventListener("focusin", (e) => { if (e.target.matches("[data-tokens]")) lastText = e.target; });
  form.addEventListener("mousedown", (e) => { if (e.target.closest("[data-token]")) e.preventDefault(); });

  form.addEventListener("input", (e) => {
    const el = e.target;
    if (el.closest(".re")) return; // the message editor reports its own changes
    if (el.matches('[data-role="sch-psearch"]')) { schSearch(el.value); return; }
    if (el.dataset.set) {
      setValue(el.dataset.set, el.type === "checkbox" ? el.checked : el.value);
      if (el.dataset.rerender !== undefined) {
        renderForm();
        if (el.dataset.set === "recipients.mode" && task.recipients.mode === "fixed") loadStaff();
      }
    } else if (el.dataset.style !== undefined) {
      const k = el.dataset.style;
      task.style[k] = el.type === "checkbox" ? el.checked : k === "width" ? Number(el.value) : el.value;
    } else if (el.dataset.oi !== undefined) {
      const f = task.fields[Number(el.dataset.fi)];
      const o = f && f.options && f.options[Number(el.dataset.oi)];
      if (!o) return;
      o[el.dataset.ok] = el.value;
    } else if (el.dataset.fi !== undefined) {
      const f = task.fields[Number(el.dataset.fi)];
      if (!f) return;
      const k = el.dataset.fk;
      if (k === "required") f.required = el.checked;
      else f[k] = el.value;
      if (k === "source") {
        if (f.source === "list" && !(f.options || []).length) f.options = [{ label: "Option 1", link: "" }];
        if (f.source === "treatments" || f.source === "aftercare") f.display = "links";
        renderForm();
        loadSources();
      }
      if (k === "label") renderChips();
    } else if (el.dataset.staff !== undefined) {
      const ids = new Set(task.recipients.staffIds);
      if (el.checked) ids.add(el.dataset.staff); else ids.delete(el.dataset.staff);
      task.recipients.staffIds = [...ids];
    } else if (el.dataset.sch !== undefined) {
      const k = el.dataset.sch;
      const s = task.schedule;
      if (k === "day") {
        const set = new Set(s.days);
        if (el.checked) set.add(el.value); else set.delete(el.value);
        s.days = WEEK_ORDER.filter((d) => set.has(d));
      } else if (k === "enabled") {
        s.enabled = el.value === "auto";
        if (s.enabled && task.recipients.mode !== "fixed") { task.recipients.mode = "fixed"; loadStaff(); }
      } else if (el.type === "checkbox") {
        s[k] = el.checked;
      } else if (["everyWeeks", "everyN", "endCount"].includes(k)) {
        s[k] = Number(el.value);
      } else {
        s[k] = el.value;
      }
      task.schedule = cleanSchedule(s);
      if (el.dataset.rerender !== undefined) renderForm(); else renderScheduleInfo();
    } else if (el.dataset.attach !== undefined) {
      const ids = new Set(task.attachments);
      if (el.checked) ids.add(el.dataset.attach); else ids.delete(el.dataset.attach);
      task.attachments = [...ids].slice(0, 3);
      renderForm();
    } else {
      return;
    }
    changed();
  });

  form.addEventListener("click", (e) => {
    const pp = e.target.closest("[data-sch-patient]");
    if (pp) { pickSchedPatient(pp.dataset.schPatient); return; }
    if (e.target.closest('[data-act="sch-patient-clear"]')) {
      task.schedule.patientId = "";
      task.schedule.patientName = "";
      schedPatient = null;
      renderForm();
      changed();
      const input = form.querySelector('[data-role="sch-psearch"]');
      if (input) input.focus();
      return;
    }
    if (e.target.closest('[data-act="sch-closed"]')) {
      e.preventDefault();
      openClosedDaysDialog(staff).then((d) => { if (d) { closedDays = d; renderForm(); } });
      return;
    }
    const st = e.target.closest('[data-act="sch-test"]');
    if (st) { testSend(st); return; }
    const tokenBtn = e.target.closest("[data-token]");
    if (tokenBtn) {
      const name = tokenBtn.dataset.token;
      if (lastText && lastText.isConnected) {
        const el = lastText;
        const tok = `{${name}}`;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        el.value = el.value.slice(0, start) + tok + el.value.slice(end);
        el.focus();
        el.setSelectionRange(start + tok.length, start + tok.length);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        editor.insertToken(name);
      }
      return;
    }
    const add = e.target.closest("[data-addfield]");
    if (add) {
      const kind = add.dataset.addfield;
      task.fields.push(kind === "treatments" ? treatmentsField() : kind === "aftercare" ? aftercareField() : blankField(kind));
      renderForm();
      loadSources();
      changed();
      const inputs = form.querySelectorAll('[data-fk="label"]');
      const last = inputs[inputs.length - 1];
      if (last) { last.focus(); last.select(); }
      return;
    }
    const oadd = e.target.closest("[data-oadd]");
    if (oadd) {
      const f = task.fields[Number(oadd.dataset.oadd)];
      if (!f) return;
      f.options = [...(f.options || []), { label: "", link: "" }];
      renderForm();
      changed();
      const rows = form.querySelectorAll(`[data-fi="${oadd.dataset.oadd}"][data-ok="label"]`);
      if (rows.length) rows[rows.length - 1].focus();
      return;
    }
    const odel = e.target.closest("[data-odel]");
    if (odel) {
      const [fi, oi] = odel.dataset.odel.split(":").map(Number);
      const f = task.fields[fi];
      if (!f || !f.options) return;
      f.options.splice(oi, 1);
      renderForm();
      changed();
      return;
    }
    const mv = e.target.closest("[data-fmove]");
    if (mv) {
      const i = Number(mv.dataset.fmove), j = i + Number(mv.dataset.dir);
      if (j < 0 || j >= task.fields.length) return;
      [task.fields[i], task.fields[j]] = [task.fields[j], task.fields[i]];
      renderForm();
      changed();
      return;
    }
    const del = e.target.closest("[data-fdel]");
    if (del) {
      task.fields.splice(Number(del.dataset.fdel), 1);
      renderForm();
      changed();
    }
  });

  /* ---------- Top bar actions ---------- */
  root.addEventListener("click", async (e) => {
    const act = e.target.closest(".ff-bar [data-act]");
    if (!act) return;

    if (act.dataset.act === "publish") {
      if (status === "live") {
        await settle();
        try {
          await saveTaskType(id, task, staff, "draft");
          status = "draft"; dirty = false; setState("saved"); renderBar();
          showToast("Unpublished. Staff can't run it until you publish it again.");
        } catch (err) { console.error(err); showToast("Couldn't unpublish. Try again."); }
        return;
      }
      const problems = allProblems();
      if (problems.length) {
        msgEl.textContent = problems[0] + (problems.length > 1 ? ` (${problems.length - 1} more listed beside the preview)` : "");
        return;
      }
      await settle();
      try {
        await saveTaskType(id, task, staff, "live");
        status = "live"; dirty = false; setState("saved"); renderBar();
        showToast("Published. Staff can now run it from Create new task.");
      } catch (err) {
        console.error("Publish failed:", err);
        showToast(err.code === "permission-denied" ? "Only admins can publish tasks. Check the task_types rules." : "Couldn't publish. Try again.");
      }
      return;
    }

    if (act.dataset.act === "duplicate") {
      await settle();
      try {
        const copy = await createTaskType({ ...task, name: `${task.name} (copy)`.slice(0, 120) }, staff);
        showToast("Copy made. You're now editing the copy.");
        location.hash = `#/tasks/types/${encodeURIComponent(copy)}`;
      } catch (err) { console.error(err); showToast("Couldn't make a copy. Try again."); }
      return;
    }

    if (act.dataset.act === "delete") {
      const ok = await confirmDialog({
        title: `Delete “${task.name}”?`,
        message: "It will be removed from Task types and from Create new task. Tasks already sent stay in Task history.",
        confirmLabel: "Delete task",
        tone: "danger",
      });
      if (!ok) return;
      await settle();
      try {
        await saveTaskType(id, task, staff, "archived");
        dirty = false;
        await listTaskTypes({ isAdmin: true, force: true }).catch(() => {});
        location.hash = "#/tasks/types";
      } catch (err) { console.error(err); showToast("Couldn't delete. Try again."); }
    }
  });

  /* ---------- Start ---------- */
  function loadStaff() {
    if (staffList !== null) return;
    fetchStaffList()
      .then((list) => { staffList = list; })
      .catch((err) => { console.warn("Staff list failed:", err); staffError = true; })
      .finally(() => { if (root.isConnected) { renderForm(); renderPreview(); } });
  }

  renderBar();
  renderForm();
  renderPreview();
  loadSources();

  getLetterhead()
    .then((lh) => { letterhead = lh; })
    .catch(() => { letterhead = {}; })
    .finally(() => { if (root.isConnected) { renderForm(); renderPreview(); } });
  listPublishedForms()
    .then((list) => { printables = list.filter((t) => t.category === "printable"); })
    .catch(() => { printables = []; })
    .finally(() => { if (root.isConnected) { renderForm(); renderPreview(); } });
  if (task.category === "staff" && task.recipients.mode === "fixed") loadStaff();

  getClosedDays().then((d) => { closedDays = d; }).catch(() => {}).finally(() => { if (root.isConnected) renderForm(); });
  listScheduleStates().then((m) => { schedState = m.get(id) || null; if (root.isConnected) renderScheduleInfo(); });
  if (task.schedule.patientId) {
    getPatient(task.schedule.patientId)
      .then((p) => { schedPatient = p || null; })
      .catch((err) => console.warn("Scheduled patient load failed:", err))
      .finally(() => { if (root.isConnected) renderForm(); });
  }
}