import {
  subscribe, getState, startRecording, pauseRecording, resumeRecording, completeRecording,
  cancelRecording, uploadRecovered, discardRecording, retryUpload, dismiss, checkForUnfinished,
  retryProcessing,
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
let staff = null;
let context = null;   // the patient page currently open (for the "Ready" state)
let consent = true; // consent forms are signed at check-in
let lastKey = "";
let announcedNotes = ""; // so the notes tab only pops out once per recording

const fmt = (ms) => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
};

// States where a recording belongs to one patient (so the bar must say whose)
const OWNED = ["recording", "paused", "stopping", "uploading", "processing", "ready", "error", "failed", "recovered"];

// Initials + name: opens that patient's page from anywhere in the app
const patientChip = (p) => (p ? `
  <button type="button" class="rec-pt" data-rec="open" title="Open ${escapeHtml(p.name)}'s page">
    <span class="rec-av" style="--h:${hueFromString(p.name)}">${escapeHtml(getInitials(p.name))}</span>
    <span class="rec-pt-name">${escapeHtml(p.name)}</span>
  </button>` : "");

// On a different patient's page than the one this recording is for
const otherPatientWarning = (s) => (context && s.patient && context.id !== s.patient.id && OWNED.includes(s.status)
  ? `<span class="rec-warn">⚠ You're viewing ${escapeHtml(context.name)}. This recording is for ${escapeHtml(s.patient.name)}.</span>`
  : "");

export function initRecordingBar(currentStaff) {
  staff = currentStaff;
  bar = document.getElementById("rec-bar");
  if (!bar) return;
  if (!bar.dataset.wired) {
    bar.dataset.wired = "1";
    bar.addEventListener("click", onClick);
    bar.addEventListener("change", (e) => {
      if (e.target.matches("[data-rec-consent]")) {
        consent = e.target.checked;
        const start = bar.querySelector("[data-rec='start']");
        if (start) start.disabled = !consent;
      }
    });
    subscribe(render);
    // If the notes for the finished recording are deleted, clear the "notes ready" bar
    window.addEventListener("recording-deleted", (e) => {
      if (getState().transcriptId === e.detail.id) dismiss();
    });
  }
  checkForUnfinished();
  render(getState());
}

// Called by the patient page (patient) or other pages (null)
export function setRecordingPatient(patient) {
  if ((context && context.id) !== (patient && patient.id)) consent = true; // reset to the default for each patient
  context = patient;
  lastKey = "";
  if (bar) render(getState());
}

function render(s) {
  if (!bar) return;
  const key = [s.status, s.stage, s.recId, context && context.id].join("|");

  // Same state: just update the live numbers (keeps the consent box / focus intact)
  if (key === lastKey) {
    const timer = bar.querySelector(".rec-timer");
    if (timer) timer.textContent = fmt(s.elapsedMs);
    const bar2 = bar.querySelector(".rec-progress span");
    if (bar2) bar2.style.width = `${Math.round(s.progress * 100)}%`;
    const pct = bar.querySelector(".rec-pct");
    if (pct) pct.textContent = `${Math.round(s.progress * 100)}%`;
    return;
  }
  lastKey = key;

  let html = "";
  let cls = "";
  const chip = patientChip(s.patient);
  const warn = otherPatientWarning(s);

  switch (s.status) {
    case "idle":
      if (!context) break;
      cls = "is-idle";
      html = `
        <span class="rec-icon">${ICONS.mic}</span>
        <span class="rec-text"><strong>Ready to record · ${escapeHtml(context.name)}</strong>
          <small>The recording is saved to this patient.</small></span>
        <label class="rec-consent">
          <input type="checkbox" data-rec-consent ${consent ? "checked" : ""} />
          Recording consent on file (signed at check-in)
        </label>
        <span class="rec-actions">
          <button type="button" class="rec-btn primary" data-rec="start" ${consent ? "" : "disabled"}>${ICONS.mic}Start Appointment</button>
        </span>`;
      break;

    case "recording":
    case "paused": {
      const paused = s.status === "paused";
      cls = paused ? "is-paused" : "is-recording";
      html = `
        <span class="rec-dot"></span>
        ${chip}
        <span class="rec-text"><strong>${paused ? "Paused" : "Recording"}</strong>
          <small>Started by ${escapeHtml(s.staff ? s.staff.name : "")}</small>${warn}</span>
        <span class="rec-timer">${fmt(s.elapsedMs)}</span>
        <span class="rec-actions">
          ${paused
            ? `<button type="button" class="rec-btn" data-rec="resume">${ICONS.play}Resume</button>`
            : `<button type="button" class="rec-btn" data-rec="pause">${ICONS.pause}Pause</button>`}
          <button type="button" class="rec-btn go" data-rec="complete">${ICONS.check}Complete Appointment</button>
          <button type="button" class="rec-link" data-rec="cancel">Cancel</button>
        </span>`;
      break;
    }

    case "stopping":
      cls = "is-busy";
      html = `<span class="rec-icon">${ICONS.upload}</span>${chip}
        <span class="rec-text"><strong>Finishing recording…</strong><small>Saving the last few seconds.</small>${warn}</span>`;
      break;

    case "uploading":
      cls = "is-busy";
      html = `
        <span class="rec-icon">${ICONS.upload}</span>${chip}
        <span class="rec-text"><strong>Uploading recording</strong>
          <small>${fmt(s.elapsedMs)} recorded · please keep this tab open</small>${warn}</span>
        <span class="rec-progress"><span style="width:${Math.round(s.progress * 100)}%"></span></span>
        <span class="rec-pct">${Math.round(s.progress * 100)}%</span>`;
      break;

    case "done":
      cls = "is-done";
      html = `
        <span class="rec-icon">${ICONS.check}</span>${chip}
        <span class="rec-text"><strong>Recording uploaded</strong><small>${fmt(s.elapsedMs)} saved securely.</small></span>
        <span class="rec-actions"><button type="button" class="rec-btn" data-rec="dismiss">Done</button></span>`;
      break;

    case "processing": {
      cls = "is-busy";
      const stages = [["upload", "Uploaded"], ["transcribe", "Transcribing"], ["notes", "Writing notes"]];
      const current = (s.stage === "writing" || s.stage === "transcribed") ? 2 : s.stage === "transcribing" ? 1 : 0;
      const label = current === 2 ? "Writing clinical notes…" : current === 1 ? "Transcribing the consultation…" : "Starting processing…";
      html = `
        <span class="rec-spin"></span>${chip}
        <span class="rec-text"><strong>${label}</strong>
          <small>This usually takes under a minute. You can keep working.</small>${warn}</span>
        <span class="rec-steps">${stages.map(([, name], i) =>
          `<span class="rec-step ${i < current ? "done" : i === current ? "active" : ""}">${name}</span>`).join("")}</span>`;
      break;
    }

    case "ready":
      cls = "is-done";
      if (s.transcriptId && s.transcriptId !== announcedNotes) {
        announcedNotes = s.transcriptId;
        showSoapPanel(s.transcriptId, { mode: "min" }); // the notes tab slides out on the right
      }
      html = `
        <span class="rec-icon">${ICONS.check}</span>${chip}
        <span class="rec-text"><strong>Clinical notes ready</strong>
          <small>Saved as Draft. Review and save them as Reviewed when you're happy.</small>${warn}</span>
        <span class="rec-actions">
          <button type="button" class="rec-btn go" data-rec="review">Review notes</button>
          <button type="button" class="rec-btn" data-rec="dismiss">Done</button>
        </span>`;
      break;

    case "failed":
      cls = "is-error";
      html = `
        <span class="rec-icon">${ICONS.upload}</span>${chip}
        <span class="rec-text"><strong>Couldn't create notes</strong>
          <small>${escapeHtml(s.error)} The recording is saved securely, so nothing is lost.</small>${warn}</span>
        <span class="rec-actions">
          <button type="button" class="rec-btn go" data-rec="retry-process">Try again</button>
          <button type="button" class="rec-btn" data-rec="dismiss-failed">Hide</button>
        </span>`;
      break;

    case "error":
      cls = "is-error";
      html = `
        <span class="rec-icon">${ICONS.upload}</span>${chip}
        <span class="rec-text"><strong>Upload didn't finish</strong>
          <small>${escapeHtml(s.error)} The recording is safe on this device.</small>${warn}</span>
        <span class="rec-actions">
          <button type="button" class="rec-btn go" data-rec="retry">Try again</button>
          <button type="button" class="rec-link" data-rec="discard">Discard</button>
        </span>`;
      break;

    case "recovered":
      cls = "is-recovered";
      html = `
        <span class="rec-icon">${ICONS.mic}</span>${chip}
        <span class="rec-text"><strong>Unfinished recording found</strong>
          <small>${fmt(s.elapsedMs)} saved on this device and not yet uploaded.</small>${warn}</span>
        <span class="rec-actions">
          <button type="button" class="rec-btn go" data-rec="upload">${ICONS.upload}Upload now</button>
          <button type="button" class="rec-link" data-rec="discard">Discard</button>
        </span>`;
      break;
  }

  bar.className = `rec-bar ${cls}${warn ? " has-warn" : ""}`.trim();
  bar.innerHTML = html;
  bar.hidden = !html;
  // Lets the sticky patient header and sidebar sit below the bar
  document.documentElement.style.setProperty("--recbar-h", bar.hidden ? "0px" : `${bar.offsetHeight}px`);
}
async function onClick(e) {
  const btn = e.target.closest("[data-rec]");
  if (!btn) return;
  const action = btn.dataset.rec;

  try {
    if (action === "start") {
      if (!context || !consent) return;
      btn.disabled = true;
      await startRecording(context, staff);
    } else if (action === "pause") {
      pauseRecording();
    } else if (action === "resume") {
      resumeRecording();
    } else if (action === "complete") {
      if (confirm("Complete this appointment and upload the recording?")) await completeRecording();
    } else if (action === "cancel") {
      if (confirm("Cancel and delete this recording? This can't be undone.")) await cancelRecording();
    } else if (action === "upload") {
      uploadRecovered();
    } else if (action === "retry") {
      retryUpload();
    } else if (action === "discard") {
      if (confirm("Delete this recording permanently? This can't be undone.")) await discardRecording();
    } else if (action === "dismiss") {
      dismiss();
    } else if (action === "review") {
      const id = getState().transcriptId;
      if (id) showSoapPanel(id, { mode: "open" });  
    } else if (action === "retry-process") {
      retryProcessing();
    } else if (action === "dismiss-failed") {
      // The server keeps retrying in the background; this just hides the bar
      bar.hidden = true;
      document.documentElement.style.setProperty("--recbar-h", "0px");
    } else if (action === "open") {
      const p = getState().patient;
      if (!p || !p.id) return;
      const target = `#/patient/${encodeURIComponent(p.id)}`;
      if (location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange")); // reload the page's data
      else location.hash = target;
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