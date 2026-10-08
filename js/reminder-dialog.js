import { addReminder } from "./reminders.js";
import { escapeHtml, toDateKey } from "./utils.js";

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

let dlg = null;
let ctx = null;

function markActiveChip() {
  const value = dlg.querySelector("input[name='due']").value;
  dlg.querySelectorAll(".rm-chip").forEach((c) => c.classList.toggle("active", c.dataset.due === value));
}

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement("dialog");
  dlg.className = "em-dialog rm-dialog";
  dlg.setAttribute("aria-label", "Add reminder");
  document.body.appendChild(dlg);

  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-rm='close']")) { dlg.close(); return; }
    const chip = e.target.closest(".rm-chip");
    if (chip) {
      dlg.querySelector("input[name='due']").value = chip.dataset.due;
      markActiveChip();
    }
  });
  dlg.addEventListener("input", (e) => { if (e.target.name === "due") markActiveChip(); });
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

        <div class="em-field"><span>Due date</span>
          <div class="rm-quick">
            ${QUICK.map(([label, fn]) => `<button type="button" class="rm-chip" data-due="${fn()}">${label}</button>`).join("")}
          </div>
          <input type="date" name="due" value="${tomorrow}" min="${plusDays(0)}" />
        </div>

        <p class="em-error" role="alert"></p>

        <footer class="em-foot">
          <button type="button" class="btn-ghost" data-rm="close">Cancel</button>
          <button type="submit" class="em-send">${I.bell}Save reminder</button>
        </footer>
      </form>`;

    dlg.showModal();
    markActiveChip();
    dlg.querySelector("textarea").focus();
  });
}

async function onSubmit(e) {
  e.preventDefault();
  if (!ctx) return;
  const form = e.target;
  const text = form.elements.text.value.trim();
  const due = form.elements.due.value;
  const errEl = dlg.querySelector(".em-error");
  const btn = dlg.querySelector(".em-send");

  if (!text) { errEl.textContent = "Please describe the reminder."; form.elements.text.focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) { errEl.textContent = "Please choose a due date."; return; }

  btn.disabled = true;
  btn.textContent = "Saving…";
  errEl.textContent = "";

  try {
    await addReminder(ctx.patient, { taskText: text, dueDate: due }, ctx.staff);
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