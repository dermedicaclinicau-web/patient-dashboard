// Task history: everything sent from Task Manager, newest first. Read-only.
import { db } from "./firebase-config.js";
import { collection, query, orderBy, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  mail: ic('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  staff: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  search: ic('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  chev: ic('<polyline points="9 18 15 12 9 6"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
};
const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};
const toText = (r) => {
  const names = (r.recipients || []).map((x) => x.name || x.email).filter(Boolean);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
};

export async function mountTaskHistory(main, { patientId = "" } = {}) {
  main.innerHTML = `
    <div class="tb-head">
      <div>
        <h3 class="tm-h">Task history</h3>
        <p class="muted tm-sub">Everything sent from Task Manager, newest first. Click one to read exactly what was sent.</p>
      </div>
    </div>
    <label class="ib-search th-search">${I.search}<input type="search" data-role="q" placeholder="Search by task, patient or staff" /></label>
    <div class="tm-tasks" data-role="list"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>`;
  const list = main.querySelector('[data-role="list"]');
  const qEl = main.querySelector('[data-role="q"]');
  let runs = [];

  function render() {
    const q = qEl.value.trim().toLowerCase();
    const rows = runs.filter((r) => !q || [r.taskName, r.patientName, r.sentBy, toText(r)].join(" ").toLowerCase().includes(q));
    if (!runs.length) { list.innerHTML = '<div class="tm-empty">Nothing has been sent yet. Tasks you send will appear here.</div>'; return; }
    list.innerHTML = rows.length ? rows.map((r) => `
      <button type="button" class="tm-task" data-run="${esc(r.id)}">
        <span class="tm-task-icon">${r.category === "staff" ? I.staff : I.mail}</span>
        <span class="tm-task-main"><strong>${esc(r.taskName || "Task")}</strong>
          <small>${esc([`To ${toText(r)}`, r.sentBy && `by ${r.sentBy}`, when(r.sentAt),
            (r.attachments || []).length ? `${r.attachments.length} attachment${r.attachments.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "))}</small></span>
        <span class="tm-task-go">${I.chev}</span>
      </button>`).join("") : '<div class="tm-empty">Nothing matches that search.</div>';
  }

  function openRun(r) {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog th-dialog";
    dlg.innerHTML = `
      <div class="th-head">
        <div>
          <h3>${esc(r.subject || r.taskName)}</h3>
          <p class="muted">${esc(r.taskName)} · sent ${esc(when(r.sentAt))}${r.sentBy ? ` by ${esc(r.sentBy)}` : ""}</p>
        </div>
        <button type="button" class="lh-btn is-quiet" data-act="close">Close</button>
      </div>
      <div class="th-meta">
        <div><span>To</span>${esc((r.recipients || []).map((x) => `${x.name} <${x.email}>`).join(", "))}</div>
        ${r.cc ? `<div><span>CC</span>${esc(r.cc)}</div>` : ""}
        ${r.patientName ? `<div><span>Patient</span>${esc(r.patientName)}</div>` : ""}
        ${(r.attachments || []).length ? `<div><span>Attached</span>${r.attachments.map((a) => `<span class="tb-att">${I.doc}${esc(a)}</span>`).join(" ")}</div>` : ""}
      </div>
      <iframe class="th-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" title="The email that was sent"></iframe>`;
    dlg.querySelector(".th-frame").srcdoc =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>
        body{margin:0;padding:18px 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1e293b}
        a{color:#0f766e} p{margin:0 0 12px}</style></head><body>${r.html || ""}</body></html>`;
    dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  qEl.addEventListener("input", render);
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-run]");
    if (!b) return;
    const r = runs.find((x) => x.id === b.dataset.run);
    if (r) openRun(r);
  });

  try {
    const col = collection(db, "task_runs");
    const snap = await getDocs(patientId
      ? query(col, where("patientId", "==", patientId), limit(200))
      : query(col, orderBy("sentAt", "desc"), limit(150)));
    runs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
    if (list.isConnected) render();
  } catch (err) {
    console.error("Task history failed:", err);
    if (list.isConnected) list.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
      ? "Task history is blocked. Check the task_runs Firestore rule has been published."
      : "Couldn't load the history. Check your connection and try again."}</div>`;
  }
}