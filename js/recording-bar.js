// The recording bar: the live recording (timer, Pause, Complete), and a chip for each recording
// still uploading or becoming notes in the background.
import {
  subscribe, getState, startRecording, pauseRecording, resumeRecording, completeRecording, cancelRecording,
  uploadNow, retryProcessing, discardJob, dismissJob, markAnnounced, checkForUnfinished,
} from "./recorder.js";
import { escapeHtml, showToast, getInitials, hueFromString } from "./utils.js";
import { showSoapPanel } from "./soap-panel.js";

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  mic: svg('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
  play: svg('<polygon points="5 3 19 12 5 21 5 3"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>'),
  upload: svg('<polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>'),
};

let bar = null;
let slot = null;      // the top-bar spot: "Start appointment", or the live timer while recording
let staff = null;
let context = null;   // the patient page currently open
let lastKey = "";
const toasted = new Set();   // "notes ready" toasts already shown

const fmt = (ms) => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
};

// Initials + name: opens that patient's page from anywhere in the app
const patientChip = (p, act = "open", id = "") => (p ? `
  <button type="button" class="rec-pt" data-rec="${act}"${id ? ` data-id="${escapeHtml(id)}"` : ""} title="Open ${escapeHtml(p.name)}'s page">
    <span class="rec-av" style="--h:${hueFromString(p.name)}">${escapeHtml(getInitials(p.name))}</span>
    <span class="rec-pt-name">${escapeHtml(p.name)}</span>
  </button>` : "");

// Recording one patient while looking at another
const otherPatientWarning = (L) => (context && L.patient && context.id !== L.patient.id && L.status !== "idle"
  ? `<span class="rec-warn">⚠ You're viewing ${escapeHtml(context.name)}. This recording is for ${escapeHtml(L.patient.name)}.</span>`
  : "");

const stageText = (j) => (j.stage === "writing" || j.stage === "transcribed" ? "Writing notes…"
  : j.stage === "transcribing" ? "Transcribing…" : "Starting…");

export function initRecordingBar(currentStaff) {
  staff = currentStaff;
  bar = document.getElementById("rec-bar");
  if (!bar) return;
  slot = document.getElementById("tb-rec");
  if (slot && !slot.dataset.wired) {
    slot.dataset.wired = "1";
    slot.addEventListener("click", onClick);
  }
  if (!bar.dataset.wired) {
    bar.dataset.wired = "1";
    bar.addEventListener("click", onClick);
    subscribe(render);
    // Notes deleted: their chip goes too
    window.addEventListener("recording-deleted", (e) => {
      const j = getState().jobs.find((x) => x.transcriptId === e.detail.id);
      if (j) dismissJob(j.recId);
    });
  }
  checkForUnfinished();
  lastKey = "";
  render(getState());
}

// Called by the patient page (patient) or other pages (null)
export function setRecordingPatient(patient) {
  context = patient;
  lastKey = "";
  if (bar) render(getState());
}

/* ---------- Notes ready ---------- */

// Not recording: the notes tab slides out. Recording someone else: just a toast, so nothing covers the consultation.
function announce(s) {
  const ready = s.jobs.filter((j) => j.status === "ready" && !j.announced && j.transcriptId);
  if (!ready.length) return;
  if (s.live.status === "idle") {
    showSoapPanel(ready[ready.length - 1].transcriptId, { mode: "min" });
    ready.forEach((j) => markAnnounced(j.recId));
    return;
  }
  ready.forEach((j) => {
    if (toasted.has(j.recId)) return;
    toasted.add(j.recId);
    showToast(`Notes ready for ${j.patient ? j.patient.name : "your last patient"}. Review them when you're done.`);
  });
}

/* ---------- Drawing ---------- */

function liveParts(L) {
  if (L.status === "idle") {
    return { cls: "", html: "", top: context ? `<button type="button" class="tb-rec-btn" data-rec="start"
      title="Record this appointment for ${escapeHtml(context.name)}">${ICONS.mic}<span>Start appointment</span></button>` : "" };
  }
  const chip = patientChip(L.patient);
  const warn = otherPatientWarning(L);
  if (L.status === "stopping") {
    return { cls: "is-busy", top: "",
      html: `<span class="rec-spin"></span>${chip}<strong class="rec-live-msg">Saving the last few seconds…</strong>${warn}` };
  }
  const paused = L.status === "paused";
  return {
    cls: paused ? "is-paused" : "is-recording",
    top: `<button type="button" class="tb-rec-btn ${paused ? "is-paused" : "is-live"}" data-rec="open"
      title="${paused ? "Paused" : "Recording"}${L.patient ? ` · ${escapeHtml(L.patient.name)}` : ""}">
      <span class="rec-dot"></span><span class="tb-rec-time">${fmt(L.elapsedMs)}</span></button>`,
    html: `
      <span class="rec-dot"></span>
      ${chip}
      <span class="rec-timer">${fmt(L.elapsedMs)}</span>
      ${warn}
      <span class="rec-actions">
        ${paused
          ? `<button type="button" class="rec-btn" data-rec="resume">${ICONS.play}Resume</button>`
          : `<button type="button" class="rec-btn" data-rec="pause">${ICONS.pause}Pause</button>`}
        <button type="button" class="rec-btn go" data-rec="complete">${ICONS.check}Complete Appointment</button>
        <button type="button" class="rec-link" data-rec="cancel">Cancel</button>
      </span>`,
  };
}

function jobHtml(j) {
  const id = escapeHtml(j.recId);
  const pct = Math.round((j.progress || 0) * 100);
  const btn = (act, label, go = false) =>
    `<button type="button" class="rec-jb${go ? " go" : ""}" data-rec="${act}" data-id="${id}">${label}</button>`;
  const hide = (title) =>
    `<button type="button" class="rec-jx" data-rec="job-dismiss" data-id="${id}" title="${escapeHtml(title)}" aria-label="Hide">×</button>`;
  let cls = "", st = "", acts = "";
  switch (j.status) {
    case "uploading":
      cls = "is-busy";
      st = `${ICONS.upload}<span>Uploading</span><span class="rec-mini"><span style="width:${pct}%"></span></span>
        <span class="rec-mini-pct">${pct}%</span>`;
      break;
    case "processing":
      cls = "is-busy";
      st = `<span class="rec-spin"></span><span>${stageText(j)}</span>`;
      acts = hide("Hide. The notes still finish and appear on the patient's page.");
      break;
    case "ready":
      cls = "is-ready";
      st = `${ICONS.check}<span>Notes ready</span>`;
      acts = btn("job-review", "Review", true) + hide("Hide");
      break;
    case "failed":
      cls = "is-bad";
      st = "<span>Couldn't create notes</span>";
      acts = btn("job-process", "Try again", true) + hide("Hide. The server keeps trying in the background.");
      break;
    case "error":
      cls = "is-bad";
      st = `${ICONS.upload}<span>Upload didn't finish</span>`;
      acts = btn("job-upload", "Try again", true) + btn("job-discard", "Discard");
      break;
    case "recovered":
      cls = "is-saved";
      st = `${ICONS.mic}<span>Not uploaded yet · ${fmt(j.elapsedMs)}</span>`;
      acts = btn("job-upload", "Upload now", true) + btn("job-discard", "Discard");
      break;
  }
  return `<div class="rec-job ${cls}" data-job="${id}"${j.error ? ` title="${escapeHtml(j.error)}"` : ""}>
    ${patientChip(j.patient, "job-open", j.recId)}<span class="rec-job-st">${st}</span>${acts}</div>`;
}

function render(s) {
  if (!bar) return;
  const L = s.live;
  announce(s);
  const key = [L.status, L.recId, context && context.id,
    s.jobs.map((j) => `${j.recId}:${j.status}:${j.stage}`).join(",")].join("|");

  // Same layout: just update the live numbers
  if (key === lastKey) {
    const timer = bar.querySelector(".rec-timer");
    if (timer) timer.textContent = fmt(L.elapsedMs);
    const t = slot && slot.querySelector(".tb-rec-time");
    if (t) t.textContent = fmt(L.elapsedMs);
    s.jobs.forEach((j) => {
      if (j.status !== "uploading") return;
      const el = bar.querySelector(`[data-job="${CSS.escape(j.recId)}"]`);
      if (!el) return;
      const pct = Math.round((j.progress || 0) * 100);
      const fill = el.querySelector(".rec-mini span");
      if (fill) fill.style.width = `${pct}%`;
      const p = el.querySelector(".rec-mini-pct");
      if (p) p.textContent = `${pct}%`;
    });
    return;
  }
  lastKey = key;

  const { cls, html, top } = liveParts(L);
  const liveRow = html ? `<div class="rec-live ${cls}">${html}</div>` : "";
  const tray = s.jobs.length ? `<div class="rec-tray">${s.jobs.map(jobHtml).join("")}</div>` : "";
  bar.className = "rec-bar is-stack";
  bar.innerHTML = liveRow + tray;
  bar.hidden = !(liveRow || tray);
  if (slot) { slot.innerHTML = top; slot.hidden = !top; }
  // Lets the sticky patient header and sidebar sit below the bar
  document.documentElement.style.setProperty("--recbar-h", bar.hidden ? "0px" : `${bar.offsetHeight}px`);
}

/* ---------- Buttons ---------- */

function openPatient(p) {
  if (!p || !p.id) return;
  const target = `#/patient/${encodeURIComponent(p.id)}`;
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange")); // reload the page's data
  else location.hash = target;
}

async function onClick(e) {
  const btn = e.target.closest("[data-rec]");
  if (!btn) return;
  const action = btn.dataset.rec;
  const id = btn.dataset.id || "";
  const job = id ? getState().jobs.find((j) => j.recId === id) : null;

  try {
    if (action === "start") {
      if (!context) return;
      btn.disabled = true;
      await startRecording(context, staff);
    } else if (action === "pause") {
      pauseRecording();
    } else if (action === "resume") {
      resumeRecording();
    } else if (action === "complete") {
      if (!confirm("Complete this appointment? The recording uploads in the background.")) return;
      const who = getState().live.patient;
      await completeRecording();
      showToast(`${who ? `${who.name}'s recording` : "The recording"} is uploading in the background. You can start the next appointment.`);
    } else if (action === "cancel") {
      if (confirm("Cancel and delete this recording? This can't be undone.")) await cancelRecording();
    } else if (action === "open") {
      openPatient(getState().live.patient);
    } else if (action === "job-open") {
      if (job) openPatient(job.patient);
    } else if (action === "job-review") {
      if (job && job.transcriptId) { markAnnounced(job.recId); showSoapPanel(job.transcriptId, { mode: "open" }); }
    } else if (action === "job-dismiss") {
      dismissJob(id);
    } else if (action === "job-upload") {
      uploadNow(id);
    } else if (action === "job-process") {
      retryProcessing(id);
    } else if (action === "job-discard") {
      if (confirm(`Delete ${job && job.patient ? `${job.patient.name}'s` : "this"} recording permanently? It hasn't been uploaded, so this can't be undone.`)) {
        await discardJob(id);
      }
    }
  } catch (err) {
    console.error("Recording action failed:", err);
    const msg = err.name === "NotAllowedError"
      ? "Microphone access was blocked. Click the lock icon in the address bar and allow the microphone."
      : err.name === "NotFoundError"
        ? "No microphone found. Plug one in and try again."
        : err.message || "Couldn't start recording.";
    showToast(msg);
    lastKey = "";
    render(getState());
  }
}