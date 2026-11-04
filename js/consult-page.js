// The Consultation tab: opened by Start appointment. Records here, then shows the notes as soon as they're written.
import {
  subscribe, getState, startRecording, pauseRecording, resumeRecording, completeRecording, cancelRecording,
  uploadNow, retryProcessing, discardJob, markAnnounced,
} from "./recorder.js";
import { setRecordingPatient } from "./recording-bar.js";
import { getPatient } from "./patients.js";
import { showSoapPanel, detachSoapPanel } from "./soap-panel.js";
import { SECTIONS } from "./soap.js";
import { confirmDialog } from "./dialog.js";
import { auth, db } from "./firebase-config.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { escapeHtml as esc, getInitials, hueFromString, showToast } from "./utils.js";

const STEPS = ["Uploading", "Transcribing", "Writing notes", "Notes ready"];
const BAD = ["failed", "error"];

const fmt = (ms) => {
  const t = Math.floor((ms || 0) / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
// Which step a recording is on (0 Uploading … 3 Notes ready)
const stepOf = (j) => (j.status === "ready" ? 3 : ["uploading", "recovered", "error"].includes(j.status) ? 0
  : /writing|transcribed/.test(String(j.stage || "")) ? 2 : 1);
const micText = (err) => (err && err.name === "NotAllowedError"
  ? "Microphone access was blocked. Click the lock icon in the address bar, allow the microphone, then press Start recording."
  : err && err.name === "NotFoundError" ? "No microphone found. Plug one in, then press Start recording."
  : (err && err.message) || "Couldn't start the recording.");
const stateHtml = (title, text, btn = "") =>
  `<div class="cs-state"><strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ""}${btn}</div>`;

export function mountConsultPage(container, param = "", { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide cs-page";
  container.replaceChildren(root);
  // The view is redrawn as the recording moves along; the notes area never is, so the notes stay put
  root.innerHTML = '<div data-role="view"></div><div class="cs-notes" data-role="notes"></div>';
  const viewEl = root.querySelector('[data-role="view"]');
  const notesEl = root.querySelector('[data-role="notes"]');


  document.body.classList.add("is-consult");   // hides the recording bar: this page has its own controls
  setRecordingPatient(null);
  const startTitle = document.title;
  const [first = "", second = ""] = String(param || "").split("/");
  const newFor = first === "new" ? decodeURIComponent(second) : "";
  let recId = first === "new" ? "" : decodeURIComponent(first);
  let patient = null;        // { id, pttId, name }
  let server = null;         // this recording as the server sees it, when this tab isn't looking after it
  let stopServer = null;
  let opened = "";           // the notes already opened
  let lastKey = "";
  let starting = false;
  let startError = "";
  let ended = "";            // "deleted" after Cancel or Discard
  let blocked = false;       // another tab was already recording when this one tried to start
  const me = () => ({ uid: (staff && staff.uid) || (auth.currentUser && auth.currentUser.uid) || "", name: (staff && staff.name) || "" });

  function viewOf(s) {
    if (ended) return { kind: "ended" };
    const L = s.live;
    if (recId && L.recId === recId && L.status !== "idle") return { kind: "live", L };
    const j = recId ? s.jobs.find((x) => x.recId === recId) : null;
    if (j) return { kind: "job", j };
    // This consultation is being recorded in another tab (a copy of the tab, or its link opened again)
    if (recId && s.remote && s.remote.recId === recId) return { kind: "elsewhere" };
    if (server) return server.status === "missing" ? { kind: "missing" } : { kind: "server", j: server };
    if (!recId && blocked) return { kind: "blocked", remote: s.remote };
    return { kind: recId ? "lookup" : "starting" };
  }

  // Opened later, or the recording finished in the background: follow it on the server
  function watchServer() {
    if (stopServer || !recId) return;
    stopServer = onSnapshot(doc(db, "recording_jobs", recId), async (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        if (!patient && d.patientName) patient = { id: d.patientDocId || "", pttId: d.patientId || "", name: d.patientName };
        server = {
          recId, stage: d.status, error: d.error || "", transcriptId: d.transcriptId || recId, merged: !!d.mergedInto,
          status: d.status === "ready" ? "ready" : d.status === "failed" ? "failed" : "processing",
        };
      } else if (!snap.metadata.fromCache) {
        try {
          const t = await getDoc(doc(db, "appointment_transcripts", recId));
          if (t.exists() && !patient) patient = { name: t.data()["Patient Name"] || "Patient" };
          server = t.exists() ? { recId, status: "ready", transcriptId: recId } : { recId, status: "missing" };
        } catch { server = { recId, status: "missing" }; }
      }
      draw(getState());
    }, (err) => {
      console.warn("Consultation not followed:", err);
      server = { recId, status: "missing" };
      draw(getState());
    });
  }

  function headHtml(v) {
    const name = patient ? patient.name : "";
    const started = v.j && v.j.startedAt ? new Date(v.j.startedAt) : new Date();
    const day = started.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    let ctrl = "";
    if (v.kind === "live") {
      const st = v.L.status;
      ctrl = st === "stopping"
        ? '<span class="cs-rec is-busy"><span class="rec-spin"></span>Saving the last few seconds…</span>'
        : `<span class="cs-rec${st === "paused" ? " is-paused" : ""}"><i class="cs-dot"></i><b data-role="time">0:00</b>
            <small>${st === "paused" ? "Paused" : "Recording"}</small></span>
          ${st === "paused"
            ? '<button type="button" class="lh-btn" data-cs="resume">Resume</button>'
            : '<button type="button" class="lh-btn" data-cs="pause">Pause</button>'}
          <button type="button" class="lh-btn is-primary" data-cs="complete">Complete appointment</button>
          <button type="button" class="lh-btn is-quiet" data-cs="cancel">Cancel</button>`;
    }
    return `<header class="cs-head">
      ${name ? `<span class="cs-av" style="--h:${hueFromString(name)}">${esc(getInitials(name))}</span>` : ""}
      <div class="cs-who"><p class="cs-eyebrow">Consultation</p><h2>${esc(name || "Loading…")}</h2>
        <p class="muted">${esc(day)}${me().name ? ` · ${esc(me().name)}` : ""}</p></div>
      <div class="cs-ctrl">${ctrl}</div>
    </header>`;
  }

  const grid = (text, busy) => `<div class="cs-grid">${SECTIONS.map((s) => `
    <section class="cs-card${s.full ? " full" : ""}${busy ? " is-busy" : ""}"><h4>${esc(s.title)}</h4><p>${esc(text)}</p></section>`).join("")}</div>`;

  function stepsHtml(j) {
    const n = stepOf(j);
    const done = (i) => i < n || j.status === "ready";
    return `<ol class="cs-steps">${STEPS.map((label, i) => `
      <li class="${done(i) ? "is-done" : i === n ? (BAD.includes(j.status) ? "is-bad" : "is-now") : ""}">
        <span>${done(i) ? "✓" : i + 1}</span>${esc(label)}${i === 0 && j.status === "uploading" ? '<small data-role="pct">0%</small>' : ""}
      </li>`).join("")}</ol>`;
  }

  function bodyHtml(v) {
    if (v.kind === "ended") return stateHtml("Recording deleted", "No notes were written. You can close this tab.");
    if (v.kind === "elsewhere") {
      return stateHtml("This consultation is recording in another tab",
        "Pause or complete it in that tab. Once it's uploaded, this tab shows its progress and notes too.",
        '<button type="button" class="lh-btn" data-cs="close-tab">Close this tab</button>');
    }
    if (v.kind === "blocked") {
      const who = v.remote && v.remote.patient ? ` for ${v.remote.patient.name}` : "";
      return v.remote
        ? stateHtml(`Another recording${who} is already running`,
            "Only one appointment can be recorded at a time. Complete or cancel it in its tab, then start this one.",
            `<div class="cs-state-btns"><button type="button" class="lh-btn" data-cs="close-tab">Close this tab</button>
              <button type="button" class="lh-btn is-primary" data-cs="retry-start">Try again</button></div>`)
        : stateHtml("The other recording has finished",
            "You can start this one now.",
            `<div class="cs-state-btns"><button type="button" class="lh-btn" data-cs="close-tab">Close this tab</button>
              <button type="button" class="btn-primary" data-cs="retry-start">Start recording</button></div>`);
    }
    if (v.kind === "missing") return stateHtml("This consultation couldn't be found", "It may have been deleted. Open the patient's page to see their notes.");
    if (v.kind === "lookup") return stateHtml("Finding this consultation…", "");
    if (v.kind === "starting") {
      return startError
        ? stateHtml("Couldn't start the recording", startError, '<button type="button" class="btn-primary" data-cs="retry-start">Start recording</button>')
        : stateHtml("Starting the recording…", "Allow the microphone if your browser asks.");
    }
    if (v.kind === "live") {
      return `<p class="cs-note">Talk as normal. When the appointment ends, press <strong>Complete appointment</strong>.
          The notes are written and appear in this tab.</p>${grid("Writes itself when you press Complete appointment.", false)}`;
    }
    const j = v.j;
    if (j.status === "ready") {
      return `${stepsHtml(j)}<div class="cs-ready"><div>
          <strong>${j.merged ? "Added to the earlier consultation's notes" : "The notes are ready"}</strong>
          <p class="muted">They're below. Review them, then press Save as Draft or Save as Reviewed. You can close this tab when you're done.</p></div>
        <button type="button" class="lh-btn" data-cs="open-notes">Show the notes</button></div>`;
    }
    const mine = v.kind === "job";
    let msg = '<p class="cs-note">Keep this tab open and carry on in the patient\'s page. The notes appear here by themselves, usually within a few minutes.</p>';
    if (j.status === "error" || j.status === "recovered") {
      msg = `<div class="cs-alert"><p><strong>${j.status === "error" ? "The upload didn't finish." : "This recording hasn't been uploaded yet."}</strong>
          ${esc(j.error || "")} The audio is still safe on this computer.</p>
        <button type="button" class="lh-btn is-primary" data-cs="upload">${j.status === "error" ? "Try again" : "Upload now"}</button>
        <button type="button" class="lh-btn is-quiet" data-cs="discard">Discard</button></div>`;
    } else if (j.status === "failed") {
      msg = `<div class="cs-alert"><p><strong>The notes couldn't be written.</strong> ${esc(j.error || "")} The server keeps trying in the background.</p>
        ${mine ? '<button type="button" class="lh-btn is-primary" data-cs="process">Try again</button>' : ""}</div>`;
    }
    const stuck = BAD.includes(j.status) || j.status === "recovered";
    return stepsHtml(j) + msg + grid(stuck ? "Waiting for the recording." : "Being written…", !stuck);
  }

  // Only the numbers that change every second (the page isn't redrawn for these)
  function tick(s, v) {
    const name = (patient && patient.name) || "Consultation";
    if (v.kind === "live") {
      const txt = fmt(s.live.elapsedMs);
      const t = root.querySelector('[data-role="time"]');
      if (t) t.textContent = txt;
      document.title = `${s.live.status === "paused" ? "⏸" : "●"} ${txt} · ${name}`;
      return;
    }
    const pct = root.querySelector('[data-role="pct"]');
    if (pct && v.j) pct.textContent = `${Math.round((v.j.progress || 0) * 100)}%`;
    document.title = !v.j ? `Consultation · ${name}`
      : v.j.status === "ready" ? `✓ Notes ready · ${name}`
      : BAD.includes(v.j.status) ? `⚠ Needs attention · ${name}` : `Writing notes… · ${name}`;
  }

  function draw(s) {
    if (!root.isConnected) return;
    const v = viewOf(s);
    if (v.kind === "lookup") watchServer();
    if (!patient) patient = (v.L && v.L.patient) || (v.j && v.j.patient) || null;
    const key = [v.kind, v.L && v.L.status, v.j && v.j.status, v.j && v.j.stage, v.j && v.j.transcriptId,
      starting, startError, patient && patient.name, s.remote ? s.remote.recId : ""].join("|");
    if (key !== lastKey) {
      lastKey = key;
      viewEl.innerHTML = headHtml(v) + bodyHtml(v);
    }
    tick(s, v);
    // Notes ready: open them here, once
    if (v.j && v.j.status === "ready" && v.j.transcriptId && opened !== v.j.transcriptId) {
      opened = v.j.transcriptId;
      if (v.kind === "job") markAnnounced(v.j.recId);
      showSoapPanel(v.j.transcriptId, { mode: "page", host: notesEl });
    }
  }

  async function begin() {
    if (starting || recId) return;
    starting = true;
    startError = "";
    blocked = false;
    draw(getState());
    try {
      if (!me().uid) throw new Error("Your session has ended. Log in again.");
      const p = await getPatient(newFor);
      if (!p) throw new Error("That patient couldn't be found.");
      patient = { id: p.id, pttId: p.pttId || "", name: p.name };
      await startRecording(p, me());
      recId = getState().live.recId;
      history.replaceState(null, "", `#/consult/${encodeURIComponent(recId)}`);   // a refresh won't start a second one
    } catch (err) {
      if (err && err.code === "BUSY_ELSEWHERE") blocked = true;   // not a fault: another tab has the microphone
      else { console.error("Consultation didn't start:", err); startError = micText(err); }
    }
    starting = false;
    draw(getState());
  }

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cs]");
    if (!b || b.disabled) return;
    const a = b.dataset.cs;
    try {
      if (a === "pause") pauseRecording();
      else if (a === "resume") resumeRecording();
      else if (a === "complete") {
        if (await confirmDialog({
          title: "Complete this appointment?",
          message: "The recording uploads and the notes are written. They'll open in this tab when they're ready.",
          confirmLabel: "Complete appointment",
        })) await completeRecording();
      } else if (a === "cancel") {
        if (await confirmDialog({
          title: "Cancel and delete this recording?",
          message: "The audio is deleted and no notes are written. This can't be undone.",
          confirmLabel: "Delete recording", tone: "danger",
        })) { await cancelRecording(); ended = "deleted"; }
      }       else if (a === "retry-start") begin();
      else if (a === "close-tab") {
        window.close();   // works for tabs the portal opened
        setTimeout(() => { if (!window.closed) showToast("You can close this tab now."); }, 300);
      }
      else if (a === "open-notes") {
        const v = viewOf(getState());
        if (v.j && v.j.transcriptId) showSoapPanel(v.j.transcriptId, { mode: "page", host: notesEl });
      } else if (a === "upload") uploadNow(recId);
      else if (a === "process") retryProcessing(recId);
      else if (a === "discard") {
        if (await confirmDialog({
          title: "Delete this recording?",
          message: "It hasn't been uploaded, so it's only on this computer. Deleting it can't be undone.",
          confirmLabel: "Delete recording", tone: "danger",
        })) { await discardJob(recId); ended = "deleted"; }
      }
    } catch (err) {
      console.error("Consultation action failed:", err);
      showToast(err.message || "Something went wrong. Try again.");
    }
    draw(getState());
  });

  const unsub = subscribe((s) => draw(s));
  // Left this page: tidy up
  const onHash = () => setTimeout(() => { if (!root.isConnected) leave(); }, 0);
  window.addEventListener("hashchange", onHash);
  function leave() {
    unsub();
    if (stopServer) stopServer();
    window.removeEventListener("hashchange", onHash);
    document.body.classList.remove("is-consult");
    detachSoapPanel();
    document.title = startTitle;
  }

  if (newFor) begin();
}