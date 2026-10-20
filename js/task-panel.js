// A staff task opened like Asana: status, who it's for, due date, and a comment trail. Updates live.
import { db } from "./firebase-config.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const getInitials = (n) => String(n || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
const hueFromString = (s) => [...String(s || "")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
export const TASK_STATUSES = [
  { key: "Open", tone: "open" },
  { key: "In progress", tone: "progress" },
  { key: "On hold", tone: "hold" },
  { key: "Completed", tone: "done" },
];
export const taskStatus = (t) => (TASK_STATUSES.some((s) => s.key === (t && t.status)) ? t.status : "Open");
export const statusTone = (s) => (TASK_STATUSES.find((x) => x.key === s) || TASK_STATUSES[0]).tone;
export const isTaskOpen = (t) => taskStatus(t) !== "Completed";
export const statusPillHtml = (t) => { const s = taskStatus(t); return `<span class="tk-pill is-${statusTone(s)}">${esc(s)}</span>`; };

const ERR = {
  FORBIDDEN: "Only the person it's for, the person who assigned it, or an Admin can change who it's for or the due date.",
  NO_STAFF: "That staff member couldn't be found.",
  DONE: "Reopen the task first.",
  NO_NOTE: "Write a comment first.",
  BUSY: "Busy. Try again in a moment.",
};
const errText = (ex) => ERR[ex && (ex.code || ex.error)] || (ex && ex.message) || "Couldn't save. Try again.";

let staffCache = null;
async function staffList() {
  if (staffCache && Date.now() - staffCache.at < 10 * 60000) return staffCache.list;
  const res = await callApi({ action: "staffList" });
  staffCache = { at: Date.now(), list: res.staff || [] };
  return staffCache.list;
}

const toDate = (v) => { if (!v) return null; if (typeof v.toDate === "function") return v.toDate(); const d = new Date(v); return isNaN(d) ? null : d; };
const when = (v) => {
  const d = toDate(v);
  if (!d) return "";
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const avatar = (name) => `<span class="tk-av" style="--h:${hueFromString(name || "?")}">${esc(getInitials(name || "?"))}</span>`;

export function openTaskPanel(id, { staff: me = null, onChange = null } = {}) {
  document.querySelector("dialog.tk-dlg")?.close();
  const dlg = document.createElement("dialog");
  dlg.className = "tk-dlg";
  dlg.innerHTML = '<div class="tk-wrap"><div class="skeleton" style="height:240px;margin:1.25rem;border-radius:12px"></div></div>';
  document.body.appendChild(dlg);
  dlg.showModal();

  let t = null;
  let staff = [];
  let busy = false;
  let built = false;
  let firstFeed = true;

  const isAdmin = !!me && /^admin$/i.test(String(me.role || ""));
  const canEdit = () => !!t && (isAdmin || !t.assignedToId || t.assignedToId === me?.uid || t.createdByUid === me?.uid);
  const $ = (s) => dlg.querySelector(s);

  async function act(op, extra = {}, ok = "") {
    if (busy) return false;
    busy = true;
    dlg.classList.add("is-busy");
    try {
      await callApi({ action: "staffTask", op, id, ...extra });
      if (ok) showToast(ok);
      if (onChange) onChange();
      return true;
    } catch (ex) {
      showToast(errText(ex));
      draw();   // puts the controls back as they were
      return false;
    } finally {
      busy = false;
      dlg.classList.remove("is-busy");
    }
  }

  function build() {
    dlg.innerHTML = `<div class="tk-wrap">
      <div data-r="head"></div>
      <div data-r="meta"></div>
      <div class="tk-feed" data-r="feed"></div>
      <form class="tk-comp" novalidate>
        <textarea class="fe-input" rows="2" maxlength="1000" placeholder="Add a comment… (Ctrl+Enter to send)" aria-label="Comment"></textarea>
        <div class="tk-comp-acts"><small class="muted">The others on this task get an email.</small>
          <button type="submit" class="lh-btn is-primary">Comment</button></div>
      </form></div>`;
    const form = $(".tk-comp");
    const ta = form.querySelector("textarea");
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const note = ta.value.trim();
      if (!note) { ta.focus(); return; }
      if (await act("comment", { note })) { ta.value = ""; firstFeed = true; }
    });
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="close"]') || e.target.closest(".tk-pt")) { dlg.close(); return; }
      const st = e.target.closest("[data-status]");
      if (st && !st.disabled && st.dataset.status !== taskStatus(t)) {
        act("status", { status: st.dataset.status }, st.dataset.status === "Completed" ? "Task completed" : "");
      }
    });
    dlg.addEventListener("change", (e) => {
      if (e.target.matches('[data-f="assign"]')) act("assign", { toId: e.target.value }, "Task passed on");
      if (e.target.matches('[data-f="due"]')) act("due", { due: e.target.value });
    });
    built = true;
  }

  function draw() {
    if (!t) return;
    if (!built) build();
    const edit = canEdit();
    const dis = edit ? "" : " disabled";
    const cur = taskStatus(t);
    $('[data-r="head"]').innerHTML = `<header class="tk-head">
        <div class="tk-head-top"><span class="tk-kicker">${esc(t.taskName || (t.source === "task" ? "Task" : "Reminder"))}</span>
          <button type="button" class="tk-x" data-act="close" aria-label="Close">×</button></div>
        <h3 class="tk-title">${esc(t.taskText || "Task")}</h3>
        ${t.patientName && t.patientId ? `<a class="tk-pt" href="#/patient/${encodeURIComponent(t.patientId)}">${esc(t.patientName)} →</a>` : ""}
        <div class="tk-status" role="group" aria-label="Status">${TASK_STATUSES.map((s) =>
          `<button type="button" class="tk-st is-${s.tone}${s.key === cur ? " is-on" : ""}" data-status="${esc(s.key)}"
            aria-pressed="${s.key === cur}">${esc(s.key)}</button>`).join("")}</div>
        ${edit ? "" : '<p class="tk-ro">You can change the status and comment. Only the person it\'s for, who assigned it, or an Admin can change who it\'s for or the due date.</p>'}
      </header>`;

    const opts = staff.slice();
    if (t.assignedToId && !opts.some((s) => s.id === t.assignedToId)) opts.unshift({ id: t.assignedToId, name: t.assignedToName || "Someone" });
    const overdue = t.dueDate && t.dueDate < todayKey() && cur !== "Completed";
    $('[data-r="meta"]').innerHTML = `<dl class="tk-meta">
        <dt>For</dt><dd><select class="fb-select" data-f="assign"${edit && cur !== "Completed" ? "" : " disabled"}>
          <option value="">Anyone</option>${opts.map((s) =>
            `<option value="${esc(s.id)}"${s.id === t.assignedToId ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></dd>
        <dt>Due</dt><dd><input type="date" class="fe-input${overdue ? " is-overdue" : ""}" data-f="due" value="${esc(t.dueDate || "")}"${dis} />
          ${overdue ? '<small class="tk-late">Overdue</small>' : ""}</dd>
        <dt>Assigned by</dt><dd>${esc(t.createdBy || "—")}${t.createdAt ? ` <span class="muted">· ${esc(when(t.createdAt))}</span>` : ""}</dd>
      </dl>`;

    const feed = [
      ...(t.notes || []).map((n) => ({ kind: "c", at: n.at, by: n.by, text: n.text })),
      ...(t.history || []).map((h) => ({ kind: "e", at: h.at, by: h.by, text: h.what })),
    ].sort((a, b) => (toDate(a.at) || 0) - (toDate(b.at) || 0));
    const el = $('[data-r="feed"]');
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.innerHTML = feed.length ? feed.map((f) => f.kind === "c"
      ? `<div class="tk-c">${avatar(f.by)}<div class="tk-c-b"><header><strong>${esc(f.by || "Staff")}</strong>
          <small class="muted">${esc(when(f.at))}</small></header><p>${esc(f.text)}</p></div></div>`
      : `<div class="tk-e"><span>${esc(f.by || "")} · ${esc(f.text)}</span><small>${esc(when(f.at))}</small></div>`).join("")
      : '<p class="tk-empty">No comments yet.</p>';
    if (firstFeed || nearBottom) { el.scrollTop = el.scrollHeight; firstFeed = false; }
  }

  const unsub = onSnapshot(doc(db, "staff-task-list", id), (snap) => {
    if (!snap.exists()) {
      dlg.innerHTML = '<div class="tk-wrap"><p class="tk-empty" style="margin:2rem">This task has been removed.</p></div>';
      built = false;
      return;
    }
    t = { id, ...snap.data() };
    draw();
  }, (err) => {
    console.error("Task not loaded:", err);
    dlg.innerHTML = '<div class="tk-wrap"><p class="tk-empty" style="margin:2rem">Couldn\'t load this task.</p></div>';
  });
  staffList().then((l) => { staff = l; draw(); }).catch(() => {});
  dlg.addEventListener("close", () => { unsub(); dlg.remove(); });
  return dlg;
}