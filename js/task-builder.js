// Task Builder: the Task types list and the task editor.
import {
  listTaskTypes, getTaskType, createTaskType, saveTaskType, taskSnapshot, fetchStaffList,
  TASK_FIELD_TYPES, TASK_CHOICE_TYPES,
} from "./task-types.js";
import { tokenGroups, taskProblems, fillTemplate, sampleValues, emailBodyHtml, subjectHtml } from "./task-tokens.js";
import { listPublishedForms, getLetterhead } from "./form-templates.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

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
  chev: ic('<polyline points="9 18 15 12 9 6"/>'),
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  copy: ic('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
};
const CAT_LABEL = { patient: "To Patient", staff: "To Staff" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => "t_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function blankField(type) {
  return {
    id: newId(), type, label: "", required: false, help: "", placeholder: "",
    ...(TASK_CHOICE_TYPES.includes(type) ? { options: ["Option 1", "Option 2"] } : {}),
  };
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
      fields: [{ ...blankField("treatments"), label: "Treatments", required: true, help: "Tick the treatments to send information about." }],
      recipients: { mode: "patient", staffIds: [], cc: "", aboutPatient: false },
      subject: "Your treatment information - Dermedica",
      body: "Hi {First name},\n\nThank you for visiting Dermedica. Here is the information about the treatments we discussed:\n\n{Treatment info}\n\nIf you have any questions, just reply to this email or call us on {Clinic phone}.\n\nKind regards,\n{Staff name}\nDermedica",
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
            `${t.fields.length} field${t.fields.length === 1 ? "" : "s"}`, editedAgo(t.updatedAt)].filter(Boolean).join(" · "))}</small></span>
        <span class="tb-pill ${t.status === "live" ? "is-live" : "is-draft"}">${t.status === "live" ? "Live" : "Draft"}</span>
        <span class="tm-task-go">${I.chev}</span>
      </a>`).join("")
      : '<div class="tm-empty">Nothing in this category yet.</div>';
  }

  async function load(force = false) {
    try {
      types = await listTaskTypes({ isAdmin: true, force });
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
        s.disabled = false;
        s.textContent = "Add starter tasks";
      }
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
  let dirty = false, saving = false, saveTimer = null;
  let lastText = null;

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
        <div class="tb-form" data-role="form"></div>
        <aside class="tb-preview" data-role="preview" aria-label="Preview"></aside>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const form = $('[data-role="form"]');
  const preview = $('[data-role="preview"]');
  const stateEl = $('[data-role="state"]');
  const msgEl = $('[data-role="msg"]');
  const pubBtn = $('[data-act="publish"]');

  /* ---------- Saving ---------- */
  function setState(s) {
    stateEl.textContent = s === "saving" ? "Saving…" : s === "dirty" ? "Unsaved changes" : s === "error" ? "Couldn't save. Retrying…" : "All changes saved";
  }
  function changed() {
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

  /* ---------- The five steps ---------- */
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
        ${choice ? `<textarea class="fe-input" data-fi="${i}" data-fk="options" rows="3" placeholder="One choice per line">${esc((f.options || []).join("\n"))}</textarea>` : ""}
        ${f.type === "treatments" ? '<small class="muted">Staff tick treatments from your treatment list. Use {Treatment info} in the message to include each one\'s information and link.</small>' : ""}
        <input class="fe-input tb-help" data-fi="${i}" data-fk="help" maxlength="300" placeholder="Help text for staff (optional)" value="${esc(f.help)}" />
      </div>`;
  }

  function fieldsHtml() {
    const hasTx = task.fields.some((f) => f.type === "treatments");
    return `
      <section class="tb-card">
        <h4><span class="tb-num">3</span>Fields to fill in when running <small>(optional)</small></h4>
        <p class="muted tb-note">Questions staff answer each time. Use the answers in the message, like {Due date}.</p>
        <div class="tb-fields">${task.fields.map(fieldCard).join("") || '<p class="tb-none">No fields yet.</p>'}</div>
        <div class="tb-add">${Object.entries(TASK_FIELD_TYPES)
          .filter(([k]) => k !== "treatments" || !hasTx)
          .map(([k, l]) => `<button type="button" class="fe-ins" data-addfield="${k}">+ ${esc(l)}</button>`).join("")}</div>
      </section>`;
  }

  function messageHtml() {
    return `
      <section class="tb-card">
        <h4><span class="tb-num">4</span>Message</h4>
        <label class="tb-field"><span>Subject</span>
          <input class="fe-input" data-set="subject" data-tokens maxlength="200" value="${esc(task.subject)}" /></label>
        <label class="tb-field"><span>Message</span>
          <textarea class="fe-input tb-body" data-set="body" data-tokens rows="12" maxlength="10000">${esc(task.body)}</textarea></label>
        <div class="tb-chips" data-role="chips"></div>
        <small class="muted">Tap a blank to add it where your cursor is. Staff can still change any of the wording before sending.</small>
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
        <h4><span class="tb-num">5</span>Attachments <small>(optional)</small></h4>
        ${inner}
        <small class="muted">Attached as PDFs, up to 3.</small>
      </section>`;
  }

  function renderChips() {
    const box = form.querySelector('[data-role="chips"]');
    if (!box) return;
    box.innerHTML = tokenGroups(task, { staffName: staff && staff.name, letterhead }).map((g) => `
      <div class="tb-chipgroup"><span>${esc(g.title)}</span>
        <div class="fe-chiprow">${g.tokens.map((t) => `<button type="button" class="fe-ins${
          t.kind === "smart" ? " is-smart" : t.kind === "field" ? " is-field" : ""}" data-token="${esc(t.name)}"${
          t.hint ? ` title="${esc(t.hint)}"` : ""}>{${esc(t.name)}}</button>`).join("")}</div></div>`).join("");
  }

  function renderForm() {
    form.innerHTML = aboutHtml() + recipientsHtml() + fieldsHtml() + messageHtml() + attachmentsHtml();
    renderChips();
  }

  /* ---------- Preview ---------- */
  function renderPreview() {
    const values = sampleValues(task, { staffName: staff && staff.name, letterhead });
    const problems = taskProblems(task);
    const r = task.recipients;
    let to;
    if (task.category === "patient") to = "Jane Citizen &lt;jane@example.com&gt;";
    else if (r.mode === "fixed") {
      const names = (staffList || []).filter((s) => r.staffIds.includes(s.id)).map((s) => esc(s.name));
      to = names.length ? names.join(", ") + (names.length > 1 ? " <small>(each gets their own copy)</small>" : "") : "<em>No one chosen yet</em>";
    } else to = "<em>The staff chosen when it's run</em>";
    const attNames = (printables || []).filter((p) => task.attachments.includes(p.id));

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
          <div class="tb-mail-body">${emailBodyHtml(fillTemplate(task.body, values)) || "<em>No message yet</em>"}</div>
          ${attNames.length ? `<div class="tb-mail-att">${attNames.map((p) => `<span class="tb-att">${I.doc}${esc(p.name)}.pdf</span>`).join("")}</div>` : ""}
        </div>
        <small class="muted">Highlighted words are filled in from the fields when the task is run.</small>
      </div>`;
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
    if (el.dataset.set) {
      setValue(el.dataset.set, el.type === "checkbox" ? el.checked : el.value);
      if (el.dataset.rerender !== undefined) {
        renderForm();
        if (el.dataset.set === "recipients.mode" && task.recipients.mode === "fixed") loadStaff();
      }
    } else if (el.dataset.fi !== undefined) {
      const f = task.fields[Number(el.dataset.fi)];
      if (!f) return;
      const k = el.dataset.fk;
      if (k === "required") f.required = el.checked;
      else if (k === "options") f.options = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
      else f[k] = el.value;
      if (k === "label") renderChips();
    } else if (el.dataset.staff !== undefined) {
      const ids = new Set(task.recipients.staffIds);
      if (el.checked) ids.add(el.dataset.staff); else ids.delete(el.dataset.staff);
      task.recipients.staffIds = [...ids];
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
    const tokenBtn = e.target.closest("[data-token]");
    if (tokenBtn) {
      const el = lastText && lastText.isConnected ? lastText : form.querySelector('[data-set="body"]');
      const tok = `{${tokenBtn.dataset.token}}`;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      el.value = el.value.slice(0, start) + tok + el.value.slice(end);
      el.focus();
      el.setSelectionRange(start + tok.length, start + tok.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const add = e.target.closest("[data-addfield]");
    if (add) {
      task.fields.push(blankField(add.dataset.addfield));
      if (add.dataset.addfield === "treatments") task.fields[task.fields.length - 1].label = "Treatments";
      renderForm();
      changed();
      const inputs = form.querySelectorAll('[data-fk="label"]');
      const last = inputs[inputs.length - 1];
      if (last) { last.focus(); last.select(); }
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
      const problems = taskProblems(task);
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

  getLetterhead().then((lh) => { letterhead = lh; if (root.isConnected) { renderChips(); renderPreview(); } }).catch(() => {});
  listPublishedForms()
    .then((list) => { printables = list.filter((t) => t.category === "printable"); })
    .catch(() => { printables = []; })
    .finally(() => { if (root.isConnected) { renderForm(); renderPreview(); } });
  if (task.category === "staff" && task.recipients.mode === "fixed") loadStaff();
}