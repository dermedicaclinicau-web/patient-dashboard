// Task Manager: repeated jobs in a few clicks (emails to patients, reminders to staff, printing).
// Routes: #/tasks                -> Create new task
//         #/tasks/new/<category> -> the tasks in that category
//         #/tasks/history        -> Task history (coming next)
//         #/tasks/types          -> Task types, admins only (coming next)
import { listPublishedForms } from "./form-templates.js";
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
  bell: ic('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  calendar: ic('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
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

// Shown until real task types are set up (next step)
const EXAMPLES = {
  patient: [
    { name: "Send Treatment Info", blurb: "Information and aftercare for the treatments discussed.", icon: I.mail },
    { name: "Send Schedule", blurb: "The patient's upcoming appointments and treatment plan.", icon: I.calendar },
  ],
  staff: [
    { name: "Staff reminder", blurb: "A reminder email to chosen staff members.", icon: I.bell },
  ],
};

export function mountTaskManager(container, { param = "", isAdmin = false } = {}) {
  const parts = String(param || "").split("/").filter(Boolean);
  const view = parts[0] || "new";
  const sub = parts[1] || "";

  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <div class="fb-head">
      <div>
        <h2>Task Manager</h2>
        <p class="muted">Repeated jobs in a few clicks: emails to patients, reminders to staff and printing.</p>
      </div>
    </div>
    <div class="tm-layout">
      <nav class="tm-menu" aria-label="Task Manager">
        <a class="tm-link${view === "new" ? " active" : ""}" href="#/tasks/new"${view === "new" ? ' aria-current="page"' : ""}>${I.plus}<span>Create new task</span></a>
        <a class="tm-link${view === "history" ? " active" : ""}" href="#/tasks/history"${view === "history" ? ' aria-current="page"' : ""}>${I.history}<span>Task history</span></a>
        ${isAdmin ? `<a class="tm-link${view === "types" ? " active" : ""}" href="#/tasks/types"${view === "types" ? ' aria-current="page"' : ""}>${I.types}<span>Task types</span></a>` : ""}
      </nav>
      <div class="tm-main" data-role="main"></div>
    </div>`;
  container.replaceChildren(root);
  const main = root.querySelector('[data-role="main"]');

  if (view === "history") return renderComingSoon(main, "Task history",
    "Every task you run will be listed here: what was sent, to whom, by whom and when.");
  if (view === "types") {
    if (!isAdmin) return renderComingSoon(main, "Task types", "Only admins can set up task types.");
    return renderComingSoon(main, "Task types",
      "This is where admins will set up To Patient and To Staff tasks in a few simple steps: who it goes to, the message, and anything to attach.");
  }
  if (sub && CATEGORIES.some((c) => c.key === sub)) return renderCategory(main, sub, isAdmin);
  return renderCategories(main);
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
    <div class="tm-tasks" data-role="tasks">${key === "print" ? '<div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div>' : ""}</div>`;
  const list = main.querySelector('[data-role="tasks"]');

  if (key === "print") {
    try {
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
    } catch (err) {
      console.error("Couldn't load printables:", err);
      if (list.isConnected) list.innerHTML = '<div class="tm-empty is-error">Couldn\'t load the printables. Check your connection and try again.</div>';
    }
    list.addEventListener("click", (e) => {
      if (e.target.closest("[data-print]")) showToast("Choosing who it's for and printing is the next step we'll build.");
    });
    return;
  }

  // To Patient / To Staff: examples until task types are set up
  list.innerHTML = `
    ${(EXAMPLES[key] || []).map((x) => `
      <div class="tm-task is-example" aria-disabled="true">
        <span class="tm-task-icon">${x.icon}</span>
        <span class="tm-task-main"><strong>${esc(x.name)}</strong><small>${esc(x.blurb)}</small></span>
        <span class="tm-badge">Not set up yet</span>
      </div>`).join("")}
    <div class="tm-empty">
      ${key === "patient" ? "To Patient" : "To Staff"} tasks are set up once in <strong>Task types</strong>, then anyone can run them here.
      ${isAdmin ? '<div class="tm-empty-act"><a class="ff-btn is-primary" href="#/tasks/types">Go to Task types</a></div>' : ""}
    </div>`;
}

/* ===================== Placeholder pages ===================== */

function renderComingSoon(main, title, message) {
  main.innerHTML = `
    <h3 class="tm-h">${esc(title)}</h3>
    <div class="tm-empty"><strong>Coming next</strong><br>${esc(message)}</div>`;
}