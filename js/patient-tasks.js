// Patient page → Tasks: this patient's staff tasks (open and done) and the task emails sent about them.
import { db } from "./firebase-config.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { patientIds } from "./patients.js";
import { mountTaskHistory } from "./task-history.js";
import { escapeHtml, toDateKey, parseDateKey, formatShortDate } from "./utils.js";

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const CHEV = svg('<polyline points="6 9 12 15 18 9"/>').replace("<svg ", '<svg class="sum-chev" ');
const TICK = svg('<polyline points="20 6 9 17 4 12"/>');
const OPEN_KEY = "pd-open-sections"; // same store the patient page uses for open/closed sections

const toD = (v) => {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v);
  return isNaN(d) ? null : d;
};
const isOpenTask = (t) => String(t.status || "").trim().toLowerCase() === "open";
const wasOpen = () => { try { return !!(JSON.parse(localStorage.getItem(OPEN_KEY)) || {})["tasks-section"]; } catch { return false; } };

export function patientTasksSectionHtml() {
  return `
    <details class="section-card ptk-card" data-key="tasks-section"${wasOpen() ? " open" : ""}>
      <summary>
        <span class="pc-head">${CHEV}<span class="pc-title">Tasks</span><span class="hint ptk-count">…</span></span>
        <button type="button" class="pc-refresh" data-action="add-reminder">+ Add reminder</button>
      </summary>
      <div class="section-body ptk-body">
        <div class="ptk-tools">
          <div class="ptk-tabs" role="tablist" aria-label="Tasks">
            <button type="button" class="ptk-tab is-on" role="tab" aria-selected="true" data-ptk-tab="staff">Staff tasks</button>
            <button type="button" class="ptk-tab" role="tab" aria-selected="false" data-ptk-tab="emails">Emails sent</button>
          </div>
          <div class="ptk-filters" data-role="filters">
            ${[["open", "Open"], ["done", "Done"], ["all", "All"]].map(([v, l], i) =>
              `<button type="button" class="ptk-filter${i === 0 ? " is-on" : ""}" data-ptk-filter="${v}">${l}</button>`).join("")}
          </div>
        </div>
        <div data-role="staff"><div class="skeleton sm"></div></div>
        <div data-role="emails" hidden></div>
      </div>
    </details>`;
}

// Returns { reload } so the patient page can refresh it after adding or completing a reminder
export function mountPatientTasks(root, patient) {
  const section = root.querySelector('details[data-key="tasks-section"]');
  if (!section) return { reload: () => {} };
  const count = section.querySelector(".ptk-count");
  const staffBox = section.querySelector('[data-role="staff"]');
  const emailBox = section.querySelector('[data-role="emails"]');
  const filters = section.querySelector('[data-role="filters"]');
  const st = { tab: "staff", filter: "open", tasks: null, emailsMounted: false };

  async function loadStaff() {
    try {
      const ids = patientIds(patient);
      const snap = ids.length
        ? await getDocs(query(collection(db, "staff-task-list"), where("patientId", "in", ids)))
        : { docs: [] };
      if (!section.isConnected) return;
      st.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      drawStaff();
    } catch (err) {
      console.error("Patient tasks failed:", err);
      if (!section.isConnected) return;
      count.textContent = "—";
      staffBox.innerHTML = `<p class="empty-note error">${err && err.code === "permission-denied"
        ? "Staff tasks aren't accessible. Check the Firestore rules." : "Couldn't load the tasks."}</p>`;
    }
  }

  function taskHtml(t) {
    const open = isOpenTask(t);
    const dueKey = String(t.dueDate || "").trim();
    const due = parseDateKey(dueKey);
    const overdue = open && !!due && dueKey < toDateKey();
    const doneAt = toD(t.completedAt || t.doneAt || t.updatedAt);
    const doneBy = t.completedBy || t.doneBy || t.updatedBy || "";
    const meta = open
      ? [due ? `Due ${formatShortDate(due)}` : dueKey ? `Due ${dueKey}` : "No due date",
        t.assignedToName ? `For ${t.assignedToName}` : "", t.createdBy ? `Added by ${t.createdBy}` : ""]
      : [`Done${doneAt ? ` ${formatShortDate(doneAt)}` : ""}${doneBy ? ` by ${doneBy}` : ""}`,
        due ? `was due ${formatShortDate(due)}` : "", t.createdBy ? `added by ${t.createdBy}` : ""];
    const status = String(t.status || "").trim();
    return `
      <li class="task${open ? " has-action" : " is-done"}${overdue ? " is-overdue" : ""}">
        <div class="task-main">
          <span class="task-text">${escapeHtml(t.taskText || "Untitled reminder")}</span>
          <span class="task-meta">${meta.filter(Boolean).map(escapeHtml).join(" · ")}${
            overdue ? '<span class="task-flag">Overdue</span>' : ""}${
            !open && status && !/^(done|completed?)$/i.test(status) ? `<span class="task-flag neutral">${escapeHtml(status)}</span>` : ""}</span>
        </div>
        ${open ? `<button type="button" class="task-done" data-action="task-done" data-id="${escapeHtml(t.id)}" title="Mark as done">${TICK}Done</button>` : ""}
      </li>`;
  }

  function drawStaff() {
    const all = st.tasks || [];
    const open = all.filter(isOpenTask).sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
    const done = all.filter((t) => !isOpenTask(t)).sort((a, b) => {
      const at = toD(a.completedAt || a.doneAt || a.updatedAt);
      const bt = toD(b.completedAt || b.doneAt || b.updatedAt);
      return (bt ? bt.getTime() : 0) - (at ? at.getTime() : 0) || String(b.dueDate || "").localeCompare(String(a.dueDate || ""));
    });
    count.textContent = all.length ? `${open.length} open · ${done.length} done` : "None";
    section.classList.toggle("is-empty", !all.length);
    const list = st.filter === "open" ? open : st.filter === "done" ? done : [...open, ...done];
    staffBox.innerHTML = list.length
      ? `<ul class="task-list">${list.map(taskHtml).join("")}</ul>`
      : `<p class="empty-note">${st.filter === "open" ? "No open tasks for this patient."
        : st.filter === "done" ? "No completed tasks yet." : "No tasks for this patient yet."}</p>`;
  }

  function showEmails() {
    if (st.emailsMounted) return;
    st.emailsMounted = true;
    emailBox.innerHTML = `<p class="ptk-full"><a href="#/tasks/history/${encodeURIComponent(patient.id)}">Open in Task Manager →</a></p>
      <div data-role="hist"></div>`;
    try {
      Promise.resolve(mountTaskHistory(emailBox.querySelector('[data-role="hist"]'), { patientId: patient.id }))
        .catch((err) => { console.error("Task history failed:", err); });
    } catch (err) {
      console.error("Task history failed:", err);
      emailBox.innerHTML = '<p class="empty-note error">Couldn\'t load the emails sent.</p>';
    }
  }

  section.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-ptk-tab]");
    if (tab) {
      st.tab = tab.dataset.ptkTab;
      section.querySelectorAll("[data-ptk-tab]").forEach((b) => {
        const on = b === tab;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-selected", String(on));
      });
      staffBox.hidden = st.tab !== "staff";
      filters.hidden = st.tab !== "staff";
      emailBox.hidden = st.tab !== "emails";
      if (st.tab === "emails") showEmails();
      return;
    }
    const f = e.target.closest("[data-ptk-filter]");
    if (f) {
      st.filter = f.dataset.ptkFilter;
      section.querySelectorAll("[data-ptk-filter]").forEach((b) => b.classList.toggle("is-on", b === f));
      if (st.tasks) drawStaff();
    }
  });

  loadStaff();
  return {
    reload() {
      loadStaff();
      if (st.emailsMounted) { st.emailsMounted = false; if (st.tab === "emails") showEmails(); }
    },
  };
}