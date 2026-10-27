import { addReminder } from "./reminders.js";
import { escapeHtml, toDateKey } from "./utils.js";
import { fetchStaffList } from "./task-types.js";

const VERSION = "v3";   // shows in the console, so you can check the browser has this copy

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  bell: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toDateKey(d);
}

// Same day next month (31 Jan + 1 month = 28/29 Feb)
function plusMonths(n) {
  const d = new Date();
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toDateKey(d);
}

const QUICK = [
  ["Today", () => plusDays(0)],
  ["Tomorrow", () => plusDays(1)],
  ["1 week", () => plusDays(7)],
  ["2 weeks", () => plusDays(14)],
  ["1 month", () => plusMonths(1)],
  ["3 months", () => plusMonths(3)],
  ["6 months", () => plusMonths(6)],
];

// "2026-10-29" → "Thursday 29 October 2026 · tomorrow"
function dueText(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return "Choose a date";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 864e5);
  const label = d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const rel = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 ? `in ${days} days`
    : `${-days} day${days === -1 ? "" : "s"} ago`;
  return `${label} · ${rel}`;
}

let dlg = null;
let ctx = null;

const dueInput = () => dlg.querySelector("input[name='due']");

function markActiveChip() {
  const input = dueInput();
  const value = input ? input.value : "";
  dlg.querySelectorAll(".rm-chip").forEach((c) => c.classList.toggle("active", c.dataset.due === value));
  const when = dlg.querySelector("[data-role='due-when']");
  if (when) when.textContent = dueText(value);
}

// Under Assign to: where the reminder will show
function updateAssignHint() {
  const sel = dlg.querySelector("select[name='assign']");
  const hint = dlg.querySelector("[data-role='assign-hint']");
  if (!sel || !hint || hint.dataset.locked) return;
  const opt = sel.selectedOptions[0];
  hint.textContent = sel.value && opt
    ? `Shows on ${opt.dataset.name || "their"}'s dashboard under Tasks → Mine.`
    : "Not assigned: it only shows under Tasks → Everyone once it's due.";
}

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement("dialog");
  dlg.className = "em-dialog rm-dialog rm-add";
  dlg.setAttribute("aria-label", "Add reminder");
  document.body.appendChild(dlg);

  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-rm='close']")) { dlg.close(); return; }
    const chip = e.target.closest(".rm-chip");
    if (chip) {
      dueInput().value = chip.dataset.due;
      markActiveChip();
    }
  });
  dlg.addEventListener("input", (e) => { if (e.target.name === "due") markActiveChip(); });
  dlg.addEventListener("change", (e) => { if (e.target.name === "assign") updateAssignHint(); });
  dlg.addEventListener("submit", onSubmit);
  dlg.addEventListener("close", () => {
    if (ctx) ctx.resolve(ctx.saved);
    ctx = null;
    dlg.innerHTML = "";
  });
}

// Resolves true if a reminder was saved
export function openReminderDialog({ patient, staff }) {
  ensureDialog();
  if (dlg.open) dlg.close();
  console.info(`Add reminder dialog ${VERSION}`);

  return new Promise((resolve) => {
    ctx = { patient, staff, resolve, saved: false };
    const tomorrow = plusDays(1);

    dlg.innerHTML = `
      <form class="em-form" novalidate>
        <header class="em-head">
          ${I.bell}<h2>Add reminder</h2>
          <button type="button" class="em-close" data-rm="close" aria-label="Close">${I.x}</button>
        </header>
        <p class="rm-for">For <strong>${escapeHtml(patient.name || "this patient")}</strong></p>

        <label class="em-field"><span>Reminder</span>
          <textarea name="text" rows="3" maxlength="500"
            placeholder="e.g. Call to book a review 2 weeks after Ulthera"></textarea>
        </label>

        <div class="em-field"><span>Quick pick</span>
          <div class="rm-quick" role="group" aria-label="Quick due dates">
            ${QUICK.map(([label, fn]) => `<button type="button" class="rm-chip" data-due="${fn()}">${label}</button>`).join("")}
          </div>
        </div>

        <div class="rm-two">
          <label class="em-field"><span>Due date</span>
            <input type="date" name="due" class="rm-input" value="${tomorrow}" min="${plusDays(0)}" />
            <small class="rm-sub is-strong" data-role="due-when"></small>
          </label>
          <label class="em-field"><span>Assign to</span>
            <select name="assign" class="rm-input">
              <option value="">Anyone (the whole team)</option>
            </select>
            <small class="rm-sub" data-role="assign-hint"></small>
          </label>
        </div>

        <p class="em-error" role="alert"></p>

        <footer class="em-foot">
          <button type="button" class="btn-ghost" data-rm="close">Cancel</button>
          <button type="submit" class="em-send">${I.bell}Save reminder</button>
        </footer>
      </form>`;

    dlg.showModal();
    markActiveChip();
    updateAssignHint();
    dlg.querySelector("textarea").focus();

    // Staff to assign to (loaded in the background; "Anyone" works straight away)
    const mine = String((staff && staff.name) || "").trim().toLowerCase();
    fetchStaffList()
      .then((list) => {
        const sel = dlg.querySelector('select[name="assign"]');
        if (!sel || !ctx) return;
        sel.insertAdjacentHTML("beforeend", list.map((s) => `
          <option value="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}">${escapeHtml(s.name)}${
            String(s.name || "").trim().toLowerCase() === mine ? " (me)" : ""}${s.role ? ` · ${escapeHtml(s.role)}` : ""}</option>`).join(""));
      })
      .catch((err) => {
        console.warn("Staff list failed:", err);
        const hint = dlg.querySelector('[data-role="assign-hint"]');
        if (hint) { hint.dataset.locked = "1"; hint.textContent = "Couldn't load the staff list. It will be saved for anyone."; }
      });
  });
}

async function onSubmit(e) {
  e.preventDefault();
  if (!ctx) return;
  const form = e.target;
  const text = form.elements.text.value.trim();
  const input = form.querySelector("input[name='due']");
  const due = input ? input.value : "";
  const errEl = dlg.querySelector(".em-error");
  const btn = dlg.querySelector(".em-send");

  if (!text) { errEl.textContent = "Please describe the reminder."; form.elements.text.focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) { errEl.textContent = "Please choose a due date."; input && input.focus(); return; }

  btn.disabled = true;
  btn.textContent = "Saving…";
  errEl.textContent = "";

  try {
    const sel = form.querySelector("select[name='assign']");
    const opt = sel && sel.selectedOptions[0];
    await addReminder(ctx.patient, {
      taskText: text, dueDate: due,
      assignedToId: sel ? sel.value : "",
      assignedToName: sel && sel.value && opt ? opt.dataset.name || "" : "",
    }, ctx.staff);
    ctx.saved = true;
    dlg.close();
  } catch (err) {
    console.error("Saving reminder failed:", err);
    errEl.textContent = err.code === "permission-denied"
      ? "You don't have permission to add reminders. Check the Firestore rules."
      : "Couldn't save the reminder. Please try again.";
    btn.disabled = false;
    btn.innerHTML = `${I.bell}Save reminder`;
  }
}