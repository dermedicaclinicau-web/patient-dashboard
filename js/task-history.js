// Task history: everything sent from Task Manager (newest first), and emails scheduled for later.
// #/tasks/history            → Sent
// #/tasks/history/scheduled  → Scheduled
// #/tasks/history/<patient>  → one patient's (both tabs)
import { db } from "./firebase-config.js";
import { collection, query, orderBy, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { bankImage } from "./image-bank-api.js";
import { getLetterhead } from "./form-templates.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { pickSendTime, fmtSendTime } from "./task-later.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  mail: ic('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  staff: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  search: ic('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  chev: ic('<polyline points="9 18 15 12 9 6"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
};
const WAITING = ["scheduled", "failed", "sending"];
const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};
const toText = (r) => {
  const names = (r.recipients || []).map((x) => x.name || x.email).filter(Boolean);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
};
const schedTo = (s) => (s.category === "patient"
  ? (s.patientName || s.to || "the patient")
  : `${(s.staffIds || []).length} staff member${(s.staffIds || []).length === 1 ? "" : "s"}`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function schedError(err) {
  switch (err && err.code) {
    case "FORBIDDEN": return "Only the person who scheduled it, or someone who builds task types, can change it.";
    case "NOT_WAITING": return "It has already been sent or cancelled.";
    case "BAD_TIME": return "Choose a time at least 5 minutes from now.";
    case "TOO_FAR": return "Emails can be scheduled up to 90 days ahead.";
    case "BUSY": return "The server is busy. Try again in a moment.";
    case "SEND_FAILED": return `Couldn't send: ${(err.detail || err.message || "try again").toString().slice(0, 160)}`;
    case "UNAUTHORIZED": return "Your session has expired. Log out and back in.";
    default: return "Something went wrong. Try again.";
  }
}

// The pictures and logo in an email, for reading it back
async function withImages(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const box = doc.body.firstElementChild;
  const imgs = [...box.querySelectorAll("img[data-bank], img[data-logo]")];
  if (!imgs.length) return html;
  let logo = "";
  if (box.querySelector("img[data-logo]")) { try { logo = (await getLetterhead()).logo || ""; } catch { /* no logo */ } }
  await Promise.all(imgs.map(async (img) => {
    if (img.hasAttribute("data-logo")) { if (logo) img.src = logo; return; }
    try { img.src = await bankImage(img.getAttribute("data-bank")); } catch { /* missing picture */ }
  }));
  return box.innerHTML;
}

// Reads one email back: a sent one (r) or a scheduled one (scheduled = true)
function openEmail(r, scheduled) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog th-dialog";
  const to = scheduled
    ? (r.category === "patient" ? `${r.patientName || ""} <${r.to}>` : schedTo(r))
    : (r.recipients || []).map((x) => `${x.name} <${x.email}>`).join(", ");
  const atts = scheduled ? (r.attachments || []).map((a) => a.name) : (r.attachments || []);
  dlg.innerHTML = `
    <div class="th-head">
      <div>
        <h3>${esc(r.subject || r.taskName)}</h3>
        <p class="muted">${esc(r.taskName)} · ${scheduled
          ? `scheduled for ${esc(fmtSendTime(r.sendAtMs))}${r.createdBy ? ` by ${esc(r.createdBy)}` : ""}`
          : `sent ${esc(when(r.sentAt))}${r.sentBy ? ` by ${esc(r.sentBy)}` : ""}`}</p>
      </div>
      <button type="button" class="lh-btn is-quiet" data-act="close">Close</button>
    </div>
    <div class="th-meta">
      <div><span>To</span>${esc(to)}</div>
      ${r.cc ? `<div><span>CC</span>${esc(r.cc)}</div>` : ""}
      ${r.patientName ? `<div><span>Patient</span>${esc(r.patientName)}</div>` : ""}
      ${atts.length ? `<div><span>Attached</span>${atts.map((a) => `<span class="tb-att">${I.doc}${esc(a)}</span>`).join(" ")}</div>` : ""}
      ${scheduled && r.fillsLater ? '<div><span>Note</span>Blanks still showing, like {Upcoming appointments}, are filled in when it\'s sent.</div>' : ""}
    </div>
    <iframe class="th-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" title="The email"></iframe>`;
  const frame = dlg.querySelector(".th-frame");
  const write = (html) => {
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>
      body{margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1e293b}
      a{color:#0f766e}</style></head><body>${html}</body></html>`;
  };
  write(r.html || "");
  withImages(r.html || "").then((h) => { if (dlg.open) write(h); }).catch(() => {});
  dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
}

export async function mountTaskHistory(main, { patientId = "" } = {}) {
  let tab = patientId === "scheduled" ? "scheduled" : "sent";
  if (patientId === "scheduled") patientId = "";
  main.innerHTML = `
    <div class="tb-head">
      <div>
        <h3 class="tm-h">Task history</h3>
        <p class="muted tm-sub">Everything sent from Task Manager, and emails waiting to go later. Click one to read it.</p>
      </div>
    </div>
    <div class="pt-tabs tb-tabs" role="group" aria-label="Show">
      <button type="button" data-tab="sent">Sent</button>
      <button type="button" data-tab="scheduled">Scheduled<em class="th-count" data-role="count" hidden></em></button>
    </div>
    <label class="ib-search th-search">${I.search}<input type="search" data-role="q" placeholder="Search by task, patient or staff" /></label>
    <div class="tm-tasks" data-role="list"><div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div></div>`;
  const list = main.querySelector('[data-role="list"]');
  const qEl = main.querySelector('[data-role="q"]');
  const countEl = main.querySelector('[data-role="count"]');
  let runs = null, sched = null, runsErr = "", schedErr = "";
  const skeleton = '<div class="skeleton tm-skel"></div><div class="skeleton tm-skel"></div>';

  function renderSent(q) {
    if (runsErr) { list.innerHTML = `<div class="tm-empty is-error">${runsErr}</div>`; return; }
    if (!runs) { list.innerHTML = skeleton; return; }
    if (!runs.length) { list.innerHTML = '<div class="tm-empty">Nothing has been sent yet. Tasks you send will appear here.</div>'; return; }
    const rows = runs.filter((r) => !q || [r.taskName, r.patientName, r.sentBy, toText(r)].join(" ").toLowerCase().includes(q));
    list.innerHTML = rows.length ? rows.map((r) => `
      <button type="button" class="tm-task" data-run="${esc(r.id)}">
        <span class="tm-task-icon">${r.scheduled ? I.clock : r.category === "staff" ? I.staff : I.mail}</span>
        <span class="tm-task-main"><strong>${esc(r.taskName || "Task")}</strong>
          <small>${esc([`To ${toText(r)}`, r.sentBy && `by ${r.sentBy}`, when(r.sentAt),
            (r.attachments || []).length ? plural(r.attachments.length, "attachment") : ""].filter(Boolean).join(" · "))}</small></span>
        <span class="tm-task-go">${I.chev}</span>
      </button>`).join("") : '<div class="tm-empty">Nothing matches that search.</div>';
  }

  function schedRow(s) {
    const failed = s.status === "failed";
    const sending = s.status === "sending";
    return `
      <div class="th-sched${failed ? " is-failed" : ""}" data-sched="${esc(s.id)}">
        <span class="tm-task-icon">${I.clock}</span>
        <button type="button" class="th-sched-main" data-act="preview">
          <strong>${esc(s.taskName || "Task")}</strong>
          <small>${esc([`To ${schedTo(s)}`, fmtSendTime(s.sendAtMs), s.createdBy && `by ${s.createdBy}`,
            (s.attachments || []).length ? plural(s.attachments.length, "attachment") : ""].filter(Boolean).join(" · "))}</small>
        </button>
        <span class="th-pill is-${esc(s.status)}">${failed ? "Not sent" : sending ? "Sending…" : "Scheduled"}</span>
        ${sending ? "" : `<div class="th-sched-acts">
          <button type="button" class="lh-btn" data-act="when">Change time</button>
          <button type="button" class="lh-btn" data-act="now">Send now</button>
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Don't send</button>
        </div>`}
        ${failed && s.lastError ? `<p class="th-err">${esc(s.lastError)}</p>` : ""}
      </div>`;
  }

  function renderSched(q) {
    if (schedErr) { list.innerHTML = `<div class="tm-empty is-error">${schedErr}</div>`; return; }
    if (!sched) { list.innerHTML = skeleton; return; }
    if (!sched.length) {
      list.innerHTML = '<div class="tm-empty">Nothing is waiting to be sent. When running a task, choose <strong>Schedule</strong> instead of Send email.</div>';
      return;
    }
    const rows = sched.filter((s) => !q || [s.taskName, s.patientName, s.createdBy, s.to].join(" ").toLowerCase().includes(q));
    list.innerHTML = rows.length ? rows.map(schedRow).join("") : '<div class="tm-empty">Nothing matches that search.</div>';
  }

  function render() {
    main.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    const waiting = (sched || []).filter((s) => s.status === "scheduled").length;
    countEl.hidden = !waiting;
    countEl.textContent = waiting;
    const q = qEl.value.trim().toLowerCase();
    if (tab === "sent") renderSent(q); else renderSched(q);
  }

  async function load() {
    const col = (n) => collection(db, n);
    const [a, b] = await Promise.allSettled([
      getDocs(patientId
        ? query(col("task_runs"), where("patientId", "==", patientId), limit(200))
        : query(col("task_runs"), orderBy("sentAt", "desc"), limit(150))),
      getDocs(patientId
        ? query(col("task_scheduled"), where("patientId", "==", patientId), limit(100))
        : query(col("task_scheduled"), where("status", "in", WAITING), limit(200))),
    ]);
    if (a.status === "fulfilled") {
      runs = a.value.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => String(y.sentAt).localeCompare(String(x.sentAt)));
      runsErr = "";
    } else {
      console.error("Task history failed:", a.reason);
      runsErr = a.reason && a.reason.code === "permission-denied"
        ? "Task history is blocked. Check the task_runs Firestore rule has been published."
        : "Couldn't load the history. Check your connection and try again.";
    }
    if (b.status === "fulfilled") {
      sched = b.value.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => WAITING.includes(s.status))
        .sort((x, y) => (Number(x.sendAtMs) || 0) - (Number(y.sendAtMs) || 0));
      schedErr = "";
    } else {
      console.error("Scheduled emails failed:", b.reason);
      schedErr = b.reason && b.reason.code === "permission-denied"
        ? "Scheduled emails are blocked. Publish the task_scheduled Firestore rule."
        : "Couldn't load the scheduled emails. Check your connection and try again.";
    }
    if (list.isConnected) render();
  }

  async function change(btn, payload, done) {
    btn.disabled = true;
    try {
      await callApi({ action: "scheduleTaskEmail", ...payload });
      showToast(done);
      await load();
    } catch (err) {
      console.error("Scheduled email change failed:", err);
      showToast(schedError(err));
      if (btn.isConnected) btn.disabled = false;
    }
  }

  main.querySelector(".tb-tabs").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) { tab = t.dataset.tab; render(); }
  });
  qEl.addEventListener("input", render);

  list.addEventListener("click", async (e) => {
    const runBtn = e.target.closest("[data-run]");
    if (runBtn) {
      const r = (runs || []).find((x) => x.id === runBtn.dataset.run);
      if (r) openEmail(r, false);
      return;
    }
    const row = e.target.closest("[data-sched]");
    const act = e.target.closest("[data-act]");
    if (!row || !act) return;
    const s = (sched || []).find((x) => x.id === row.dataset.sched);
    if (!s) return;

    if (act.dataset.act === "preview") { openEmail(s, true); return; }
    if (act.dataset.act === "when") {
      const pick = await pickSendTime({ title: "Change when it's sent", confirmLabel: "Save", current: s.sendAtMs });
      if (pick) await change(act, { op: "reschedule", id: s.id, sendAt: new Date(pick.ms).toISOString() }, `Now sending ${fmtSendTime(pick.ms)}`);
      return;
    }
    if (act.dataset.act === "now") {
      const ok = await confirmDialog({
        title: "Send it now?",
        message: `“${s.taskName}” goes ${s.category === "patient" ? `to ${s.patientName || s.to} ` : ""}straight away, with the appointments as they are now.`,
        confirmLabel: "Send now", tone: "info",
      });
      if (ok) await change(act, { op: "sendNow", id: s.id }, "Sent");
      return;
    }
    if (act.dataset.act === "cancel") {
      const ok = await confirmDialog({
        title: "Don't send this email?",
        message: "It's cancelled and won't be sent. Run the task again to schedule a new one.",
        confirmLabel: "Don't send it", cancelLabel: "Keep it", tone: "danger",
      });
      if (ok) await change(act, { op: "cancel", id: s.id }, "Cancelled. It won't be sent.");
    }
  });

  render();
  load();
}