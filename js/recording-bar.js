import {
  subscribe, getState, startRecording, pauseRecording, resumeRecording, completeRecording,
  cancelRecording, uploadRecovered, discardRecording, retryUpload, dismiss, checkForUnfinished,
} from "./recorder.js";
import { escapeHtml, showToast } from "./utils.js";

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
let consent = false;
let lastKey = "";

const fmt = (ms) => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
};

const patientLink = (p) => p
  ? `<a href="#/patient/${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>`
  : "patient";

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
  }
  checkForUnfinished();
  render(getState());
}

// Called by the patient page (patient) or other pages (null)
export function setRecordingPatient(patient) {
  if ((context && context.id) !== (patient && patient.id)) consent = false;
  context = patient;
  lastKey = "";
  if (bar) render(getState());
}

function render(s) {
  if (!bar) return;
  const key = [s.status, s.recId, context && context.id].join("|");

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

  switch (s.status) {
    case "idle":
      if (!context) break;
      cls = "is-idle";
      html = `
        <span class="rec-icon">${ICONS.mic}</span>
        <span class="rec-text"><strong>Ready to record</strong><small>${escapeHtml(context.name)}</small></span>
        <label class="rec-consent">
          <input type="checkbox" data-rec-consent ${consent ? "checked" : ""} />
          Patient has consented to this consultation being recorded
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
        <span class="rec-text"><strong>${paused ? "Paused" : "Recording"} · ${patientLink(s.patient)}</strong>
          <small>Started by ${escapeHtml(s.staff ? s.staff.name : "")}</small></span>
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
      html = `<span class="rec-icon">${ICONS.upload}</span>
        <span class="rec-text"><strong>Finishing recording…</strong><small>${patientLink(s.patient)}</small></span>`;
      break;

    case "uploading":
      cls = "is-busy";
      html = `
        <span class="rec-icon">${ICONS.upload}</span>
        <span class="rec-text"><strong>Uploading recording · ${patientLink(s.patient)}</strong>
          <small>${fmt(s.elapsedMs)} recorded · please keep this tab open</small></span>
        <span class="rec-progress"><span style="width:${Math.round(s.progress * 100)}%"></span></span>
        <span class="rec-pct">${Math.round(s.progress * 100)}%</span>`;
      break;

    case "done":
      cls = "is-done";
      html = `
        <span class="rec-icon">${ICONS.check}</span>
        <span class="rec-text"><strong>Recording uploaded · ${patientLink(s.patient)}</strong>
          <small>${fmt(s.elapsedMs)} saved securely. Clinical notes generation is coming in the next step.</small></span>
        <span class="rec-actions"><button type="button" class="rec-btn" data-rec="dismiss">Done</button></span>`;
      break;

    case "error":
      cls = "is-error";
      html = `
        <span class="rec-icon">${ICONS.upload}</span>
        <span class="rec-text"><strong>Upload didn't finish · ${patientLink(s.patient)}</strong>
          <small>${escapeHtml(s.error)} The recording is safe on this device.</small></span>
        <span class="rec-actions">
          <button type="button" class="rec-btn go" data-rec="retry">Try again</button>
          <button type="button" class="rec-link" data-rec="discard">Discard</button>
        </span>`;
      break;

    case "recovered":
      cls = "is-recovered";
      html = `
        <span class="rec-icon">${ICONS.mic}</span>
        <span class="rec-text"><strong>Unfinished recording found · ${patientLink(s.patient)}</strong>
          <small>${fmt(s.elapsedMs)} saved on this device and not yet uploaded.</small></span>
        <span class="rec-actions">
          <button type="button" class="rec-btn go" data-rec="upload">${ICONS.upload}Upload now</button>
          <button type="button" class="rec-link" data-rec="discard">Discard</button>
        </span>`;
      break;
  }

  bar.className = `rec-bar ${cls}`.trim();
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