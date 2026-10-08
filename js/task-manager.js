// Task Manager: repeated jobs in a few clicks (emails to patients, reminders to staff, printing).
// Routes: #/tasks                        -> Create new task
//         #/tasks/new/<category>         -> the tasks in that category
//         #/tasks/run/<taskId>[/<patient>] -> run a task
//         #/tasks/history                -> Task history
//         #/tasks/types[/<id>]           -> Task types (admins)
import { listPublishedForms } from "./form-templates.js";
import { listTaskTypes } from "./task-types.js";
import { mountTaskTypes, mountTaskEditor } from "./task-builder.js";
import { mountTaskRunner } from "./task-runner.js";
import { mountTaskHistory } from "./task-history.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  plus: ic('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  history: ic('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  types: ic('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  patient: ic('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  staff: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  print: ic('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  mail: ic('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  chev: ic('<polyline points="9 18 15 12 9 6"/>'),
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
};

const CATEGORIES = [
  { key: "patient", title: "To Patient", icon: I.patient, tone: "teal",
    blurb: "Email information to a patient, such as their treatment info or schedule." },
  { key: "staff", title: "To Staff", icon: I.staff, tone: "violet",
    blurb: "Email a reminder or a note to one or more staff members." },
  { key: "print", title: "To Print", icon: I.print, tone: "amber",
    blurb: "Print a document from the Printables in Form Builder." },
];

export function mountTaskManager(container, { param = "", isAdmin = false, staff = null } = {}) {
  const parts = String(param || "").split("/").filter(Boolean);
  const view = parts[0] || "new";
  const sub = parts[1] || "";

  // Full-page screens
  if (view === "run" && sub) { mountTaskRunner(container, { taskId: sub, patientId: parts[2] || "", staff }); return; }
  if (view === "types" && sub) {
    if (isAdmin) { mountTaskEditor(container, { id: sub, staff }); return; }
    container.innerHTML = '<section class="page"><div class="state"><strong>Admins only</strong>Only admins can edit task types.</div></section>';
    return;
  }

  const root = document.createElement("section");
  root.className = "page wide";
  const link = (key, href, icon, label) =>
    `<a class="tm-link${view === key ? " active" : ""}" href="${href}"${view === key ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  root.innerHTML = `
    <div class="fb-head">
      <div>
        <h2>Task Manager</h2>
        <p class="muted">Repeated jobs in a few clicks: emails to patients, reminders to staff and printing.</p>
      </div>
    </div>
    <div class="tm-layout">
      <nav class="tm-menu" aria-label="Task Manager">
        ${link("new", "#/tasks/new", I.plus, "Create new task")}
        ${link("history", "#/tasks/history", I.history, "Task history")}
        ${isAdmin ? link("types", "#/tasks/types", I.types, "Task types") : ""}
      </nav>
      <div class="tm-main" data-role="main"></div>
    </div>`;
  container.replaceChildren(root);
  const main = root.querySelector('[data-role="main"]');

  if (view === "history") { mountTaskHistory(main, { patientId: sub }); return; }
  if (view === "types") {
    if (!isAdmin) { main.innerHTML = '<div class="tm-empty">Only admins can set up task types.</div>'; return; }
    mountTaskTypes(main, { staff });
    return;
  }
  if (sub && CATEGORIES.some((c) => c.key === sub)) { renderCategory(main, sub, isAdmin); return; }
  renderCategories(main);
}

/* ===================== Create new task: choose a category ===================== */

function steps(active) {
  const names = ["Choose a type", "Choose a task", "Details", "Send"];
  return `<ol class="tm-steps">${names.map((n, i) =>
    `<li class="${i < active ? "is-done" : i === active ? "is-on" : ""}"><span>${i + 1}</span>${n}</li>`).join("")}</ol>`;
}

function renderCategories(main) {
  main.innerHTML = `
    ${steps(0)}
    <h3 class="tm-h">What kind of task?</h3>
    <div class="tm-cats">${CATEGORIES.map((c) => `
      <a class="tm-cat tone-${c.tone}" href="#/tasks/new/${c.key}">
        <span class="tm-cat-icon">${c.icon}</span>
        <span class="tm-cat-title">${esc(c.title)}</span>
        <span class="tm-cat-blurb">${esc(c.blurb)}</span>
        <span class="tm-cat-go">${I.chev}</span>
      </a>`).join("")}
    </div>`;
}

/* ===================== Create new task: choose a task ===================== */

async function renderCategory(main, key, isAdmin) {
  const cat = CATEGORIES.find((c) => c.key === key);
  main.innerHTML = `
    ${steps(1)}
    <a class="tm-back" href="#/tasks/new">${I.back}<span>All task types</span></a>
    <h3 class="tm-h"><span class="tm-h-icon tone-${cat.tone}">${cat.icon}</span>${esc(cat.title)}</h3>
    <p class="muted tm-sub">${esc(cat.blurb)}</p>
    <div class="tm-tasks" data-role="tasks"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>`;
  const list = main.querySelector('[data-role="tasks"]');

  list.addEventListener("click", (e) => {
    const run = e.target.closest("[data-run]");
    if (run) { location.hash = `#/tasks/run/${encodeURIComponent(run.dataset.run)}`; return; }
    if (e.target.closest("[data-print]")) showToast("Printing from Task Manager is coming next. For now, open the patient and use Consent record or Treatment record.");
  });

  try {
    if (key === "print") {
      const printables = (await listPublishedForms()).filter((t) => t.category === "printable");
      if (!list.isConnected) return;
      list.innerHTML = printables.length
        ? printables.map((t) => `
            <button type="button" class="tm-task" data-print="${esc(t.id)}">
              <span class="tm-task-icon">${I.doc}</span>
              <span class="tm-task-main"><strong>${esc(t.name)}</strong><small>Printable · Version ${t.version}</small></span>
              <span class="tm-task-go">${I.chev}</span>
            </button>`).join("")
        : `<div class="tm-empty">No printables are published yet.${isAdmin
            ? ' Create one in <a href="#/forms">Form Builder</a> under <strong>Printables</strong>, then publish it.'
            : " Ask an admin to publish one in Form Builder."}</div>`;
      return;
    }

    const tasks = (await listTaskTypes({ isAdmin: false })).filter((t) => t.category === key);
    if (!list.isConnected) return;
    list.innerHTML = tasks.length
      ? tasks.map((t) => `
          <button type="button" class="tm-task" data-run="${esc(t.id)}">
            <span class="tm-task-icon">${I.mail}</span>
            <span class="tm-task-main"><strong>${esc(t.name)}</strong><small>${esc(t.description || "Email")}</small></span>
            <span class="tm-task-go">${I.chev}</span>
          </button>`).join("")
      : `<div class="tm-empty">No ${esc(cat.title)} tasks are published yet.${isAdmin
          ? ' Set them up in <strong>Task types</strong>.<div class="tm-empty-act"><a class="ff-btn is-primary" href="#/tasks/types">Go to Task types</a></div>'
          : " Ask an admin to set some up."}</div>`;
  } catch (err) {
    console.error("Task list failed:", err);
    if (list.isConnected) list.innerHTML = '<div class="tm-empty is-error">Couldn\'t load the tasks. Check your connection and try again.</div>';
  }
}