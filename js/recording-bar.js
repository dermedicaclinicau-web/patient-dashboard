// The recording bar: the live recording (timer, Pause, Complete), recordings paused for another patient
// (Continue), and a chip for each recording still uploading or becoming notes in the background.
import {
  subscribe, getState, startRecording, pauseRecording, resumeRecording, completeRecording, cancelRecording,
  uploadNow, retryProcessing, discardJob, dismissJob, markAnnounced, checkForUnfinished,
  checkContinuation, unpark, setJoin,
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
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  plus: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>'),
};

let bar = null;
let slot = null;      // the top-bar spot: "Start appointment", or the live timer while recording
let staff = null;
let context = null;   // the patient page currently open
let lastKey = "";
let lastJobSig = "";
const toasted = new Set();   // "notes ready" toasts already shown
let lastToggle = 0;          // when Pause or Resume was last pressed

const fmt = (ms) => {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
};
const firstName = (n) => String(n || "").split(" ")[0];

/* ---------- Can this patient's recording be continued? (asked once a minute at most) ---------- */

const contCache = new Map();   // patient id → { info, at, loading }

function contFor(p) {
  if (!p || !p.id) return null;
  const c = contCache.get(p.id);
  if (c && (c.loading || Date.now() - c.at < 60000)) return c.info;
  contCache.set(p.id, { info: c ? c.info : null, at: c ? c.at : 0, loading: true });
  checkContinuation(p)
    .then((info) => { contCache.set(p.id, { info, at: Date.now(), loading: false }); })
    .catch(() => { contCache.set(p.id, { info: null, at: Date.now(), loading: false }); })
    .finally(() => { lastKey = ""; render(getState()); });
  return c ? c.info : null;
}
const contKnown = (p) => (p && contCache.has(p.id) ? contCache.get(p.id).info : null);

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
const BAD = ["failed", "error", "recovered"];
const BUSY = ["uploading", "processing"];
const jobViews = new Set();   // the "Recordings on this device" cards that are open (My dashboard)

// Counts only, never names (hover text on the menu badge)
function summaryText(jobs) {
  const n = (f) => jobs.filter(f).length;
  const parts = [
    [n((j) => j.status === "ready"), "notes ready"],
    [n((j) => BUSY.includes(j.status)), "processing"],
    [n((j) => BAD.includes(j.status)), "need attention"],
  ].filter(([c]) => c).map(([c, t]) => `${c} ${t}`);
  return `${jobs.length} recording${jobs.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

// The number beside "My dashboard" in the menu: the same recordings as the card
function renderNavBadge(all) {
  const link = document.querySelector('.nav-item[data-page="home"]');
  if (!link) return;
  const jobs = all.filter((j) => j.status !== "ready");
  let b = link.querySelector(".nav-badge");
  if (!jobs.length) {
    if (b) b.remove();
    link.removeAttribute("title");
    return;
  }
  if (!b) {
    b = document.createElement("span");
    link.appendChild(b);
  }
  b.className = `nav-badge ${jobs.some((j) => BAD.includes(j.status)) ? "is-bad" : "is-busy"}`;
  b.textContent = jobs.length > 9 ? "9+" : String(jobs.length);
  link.title = summaryText(jobs);
}
// My dashboard: the recordings on this device, live. Only shows when there's something in it.
export function mountRecordingJobs(el) {
  if (!el) return;
  el.addEventListener("click", onClick);
  // Only recordings still on their way or needing someone. Written notes are under "Notes to review".
  const draw = (all) => {
    if (!el.isConnected) { jobViews.delete(draw); return; }
    const jobs = all.filter((j) => j.status !== "ready");
    el.hidden = !jobs.length;
    if (!jobs.length) { el.innerHTML = ""; return; }
    const bad = jobs.some((j) => BAD.includes(j.status));
    const list = jobs.slice().sort((a, b) => (BAD.includes(b.status) ? 1 : 0) - (BAD.includes(a.status) ? 1 : 0));
    el.innerHTML = `<section class="md-card md-rec-card${bad ? " is-bad" : ""}">
      <div class="md-card-head">
        <h3>Recordings on this device</h3>
        <span class="md-count">${jobs.length}</span>
      </div>
      <p class="muted md-rec-note">${bad ? "<strong>Any in red need you.</strong> " : ""}Recordings still uploading or
        being turned into notes. You can keep working. When the notes are written, they move to Notes to review.</p>
      <div class="rec-tray">${list.map(jobHtml).join("")}</div>
    </section>`;
  };
  jobViews.add(draw);
  draw(getState().jobs);
}

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
    // This tab's recording was paused because another one started
    window.addEventListener("recording-taken-over", (e) => {
      const { stopped, by } = e.detail || {};
      showToast(`${stopped ? `${stopped.name}'s` : "The last"} recording is paused and saved${
        by && by.name ? ` while ${by.name} is recorded` : ""}. Continue it from the recording bar when you're ready.`);
    });
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
  if (patient) contCache.delete(patient.id);   // opening their page asks again
  lastKey = "";
  if (bar) render(getState());
}

/* ===================== Notes ready ===================== */

// Not recording: the notes tab slides out. Recording someone else: just a toast, so nothing covers the consultation.
// A paused patient's notes don't slide out: they change again when the appointment is continued.
function announce(s) {
  if (document.body.classList.contains("is-consult")) return;   // the Consultation tab shows its own notes
  const parked = new Set((s.parked || []).map((p) => p.patient.id));
  const ready = s.jobs.filter((j) => j.status === "ready" && !j.announced && j.transcriptId
    && !(j.patient && parked.has(j.patient.id)));
  if (!ready.length) return;
  if (s.live.status === "idle") {
    showSoapPanel(ready[ready.length - 1].transcriptId, { mode: "min" });
    ready.forEach((j) => markAnnounced(j.recId));
    return;
  }
  const fresh = ready.filter((j) => !toasted.has(j.recId));
  if (!fresh.length) return;
  fresh.forEach((j) => toasted.add(j.recId));
  showToast(`Notes are ready for ${fresh.length} recording${fresh.length === 1 ? "" : "s"}. They're on My dashboard when you're done.`);
}

// Notes written and already shown: nothing is left to do on this device, so the recording is cleared from it.
// The same as the old × (Hide): the notes stay in Notes to review and on the patient's page.
function clearDone() {
  getState().jobs.filter((j) => j.status === "ready" && j.announced).forEach((j) => dismissJob(j.recId));
}

/* ===================== Drawing ===================== */
// Joining the earlier notes, or new notes: switchable until Complete appointment
function joinSwitch(L) {
  if (!L.offer) return "";
  const at = L.offer.time ? `the ${escapeHtml(L.offer.time)} notes` : "the earlier notes";
  return L.continuesId
    ? `<span class="rec-join">${ICONS.link}Joining ${at} <button type="button" class="rec-link" data-rec="separate">Make separate</button></span>`
    : `<span class="rec-join is-new">New notes <button type="button" class="rec-link" data-rec="join">Join ${at}</button></span>`;
}
function liveParts(L, remote) {
  if (L.status === "idle") {
    const sameOne = remote && context && remote.patient && remote.patient.id === context.id;
    // No patient open, or this patient is the one already recording: just say so
    if (remote && (!context || sameOne)) {
      return { cls: "", html: "", top: `<span class="tb-rec-btn is-elsewhere"
        title="Recording${remote.patient ? ` ${escapeHtml(remote.patient.name)}` : ""} in another tab. Complete it there.">
        <span class="rec-dot"></span><span>Recording in another tab</span></span>` };
    }
    if (!context) return { cls: "", html: "", top: "" };
    const other = remote && remote.patient ? remote.patient.name : "";
    const ci = contFor(context);
    const cont = !!(ci && ci.id);
    const name = escapeHtml(context.name);
    const joins = cont ? (ci.time ? `the ${escapeHtml(ci.time)} recording` : "today's recording") : "";
    const title = other
      ? `Pauses ${escapeHtml(other)}'s recording (it's saved and can be continued), then records ${name}`
      : cont ? `${name} was recorded earlier today (${joins}, ${fmt(ci.ms)}). You'll choose whether this continues it or starts new notes.`
      : ci && ci.reviewed ? `Today's notes for ${name} are signed off, so this makes a new set of notes.`
      : `Opens a new tab to record ${name}'s appointment`;
    const note = other ? `${escapeHtml(firstName(other))} continues later` : cont ? "recorded earlier today" : "";
    return { cls: "", html: "", top: `<button type="button" class="tb-rec-btn" data-rec="start" title="${title}">${
      ICONS.mic}<span>Start appointment</span>${note ? `<em class="tb-rec-note">${note}</em>` : ""}</button>` };
  }
  const chip = patientChip(L.patient);
  const warn = otherPatientWarning(L);
  if (L.status === "stopping") {
    return { cls: "is-busy", top: "",
      html: `<span class="rec-spin"></span>${chip}<strong class="rec-live-msg">Saving the last few seconds…</strong>${warn}` };
  }
  const paused = L.status === "paused";
  const prior = L.priorMs || 0;
  return {
    cls: paused ? "is-paused" : "is-recording",
    top: `<button type="button" class="tb-rec-btn ${paused ? "is-paused" : "is-live"}" data-rec="open"
      title="${paused ? "Paused" : "Recording"}${L.patient ? ` · ${escapeHtml(L.patient.name)}` : ""}${
        prior ? ` · continuing, ${fmt(prior)} recorded earlier` : ""}">
      <span class="rec-dot"></span><span class="tb-rec-time">${fmt(prior + L.elapsedMs)}</span></button>`,
    html: `
      <span class="rec-dot"></span>
      ${chip}
      <span class="rec-timer">${fmt(L.elapsedMs)}</span>${prior
        ? `<span class="rec-prior" title="Recorded earlier today. This part joins the same notes.">+ ${fmt(prior)} earlier</span>` : ""}
      ${joinSwitch(L)}
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

// Recordings paused for another patient (not the one recording now)
function parkedHtml(s) {
  const liveId = s.live.patient && s.live.patient.id;
  const list = (s.parked || []).filter((p) => p.patient.id !== liveId);
  return list.map((p) => {
    const id = escapeHtml(p.patient.id);
    contFor(p.patient);   // so Continue knows whether the notes were edited
    return `<div class="rec-parked">
      <span class="rec-park-ic">${ICONS.pause}</span>
      ${patientChip(p.patient, "park-open", p.patient.id)}
      <span class="rec-park-st">Paused · ${fmt(p.elapsedMs)} recorded</span>
      <span class="rec-actions">
        <button type="button" class="rec-btn" data-rec="park-continue" data-id="${id}"
          title="Continue ${escapeHtml(p.patient.name)}'s appointment. It joins the same notes.">${ICONS.mic}Continue</button>
        <button type="button" class="rec-jx" data-rec="park-dismiss" data-id="${id}"
          title="Done with this patient: hide it. The notes are already saved." aria-label="Hide">×</button>
      </span>
    </div>`;
  }).join("");
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
      st = `${ICONS.check}<span>${j.merged ? "Added to the earlier consultation" : "Notes ready"}</span>`;
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
  // Straight after this redraw, not during it (clearing one redraws again)
  if (s.jobs.some((j) => j.status === "ready" && j.announced)) setTimeout(clearDone, 0);

  // A recording finished or changed: ask again what can be continued
  const jobSig = s.jobs.map((j) => `${j.recId}:${j.status}`).join(",");
  if (jobSig !== lastJobSig) { lastJobSig = jobSig; contCache.clear(); }

  const key = [L.status, L.recId, L.continuesId, L.priorMs, L.offer ? L.offer.id : "", context && context.id,
    s.remote ? `${s.remote.recId}:${s.remote.status}` : "",
    (s.parked || []).map((p) => `${p.patient.id}:${p.elapsedMs}`).join(","),
    context ? JSON.stringify(contKnown(context)) : "",
    s.jobs.map((j) => `${j.recId}:${j.status}:${j.stage}`).join(",")].join("|");

  // Same layout: just update the live numbers
  if (key === lastKey) {
    const timer = bar.querySelector(".rec-timer");
    if (timer) timer.textContent = fmt(L.elapsedMs);
    const t = slot && slot.querySelector(".tb-rec-time");
    if (t) t.textContent = fmt((L.priorMs || 0) + L.elapsedMs);
    s.jobs.forEach((j) => {
      if (j.status !== "uploading") return;
      const pct = Math.round((j.progress || 0) * 100);
      document.querySelectorAll(`[data-job="${CSS.escape(j.recId)}"]`).forEach((el) => {
        const fill = el.querySelector(".rec-mini span");
        if (fill) fill.style.width = `${pct}%`;
        const p = el.querySelector(".rec-mini-pct");
        if (p) p.textContent = `${pct}%`;
      });
    });
    return;
  }
  lastKey = key;

  const { cls, html, top } = liveParts(L, s.remote);
  const liveRow = html ? `<div class="rec-live ${cls}">${html}</div>` : "";
  const parked = parkedHtml(s);
  bar.className = "rec-bar is-stack";
  bar.innerHTML = liveRow + parked;   // the live recording and the paused ones; background ones are on My dashboard
  bar.hidden = !liveRow && !parked;
  renderNavBadge(s.jobs);
  jobViews.forEach((fn) => fn(s.jobs));
  if (slot) { slot.innerHTML = top; slot.hidden = !top; }
  // Lets the sticky patient header and sidebar sit below the bar
  document.documentElement.style.setProperty("--recbar-h", bar.hidden ? "0px" : `${bar.offsetHeight}px`);
}

/* ===================== Buttons ===================== */

function openPatient(p) {
  if (!p || !p.id) return;
  const target = `#/patient/${encodeURIComponent(p.id)}`;
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange")); // reload the page's data
  else location.hash = target;
}

// Records a patient: in the Consultation tab, or here if pop-ups are blocked.
// Recorded earlier today (still a Draft): they choose to continue those notes or start new ones.
// direct: the paused list's Continue, which always continues.
function startFor(patient, btn, { direct = false } = {}) {
  const rem = getState().remote;
  if (rem && rem.patient && rem.patient.id === patient.id) {
    showToast(`${patient.name}'s appointment is already recording in another tab.`);
    return;
  }
  const cc = contCache.get(patient.id);
  if (!direct && cc && cc.loading && !cc.info) {   // still checking today's recordings: wait for the answer
    showToast("Checking today's recordings. Tap Start appointment again in a moment.");
    return;
  }
  const ci = contKnown(patient);
  const parked = (getState().parked || []).find((p) => p.patient.id === patient.id);
  // Paused for another patient: that's the appointment to continue (it may not be on the server yet)
  const offer = parked && parked.recId
    ? Object.assign({ id: parked.recId, ms: parked.elapsedMs || 0, time: "" },
        ci && ci.id === parked.recId
          ? { ms: Math.max(ci.ms || 0, parked.elapsedMs || 0), time: ci.time, edited: ci.edited, editedBy: ci.editedBy } : {})
    : ci && ci.id ? ci : null;
  if (!offer) { openConsult(patient, null, btn); return; }
  if (direct) {
    if (offer.edited && !confirm(`${patient.name}'s notes from earlier today were edited${
      offer.editedBy ? ` by ${offer.editedBy}` : ""}. Continuing writes them again from both recordings, and the edited version is kept as the previous notes.\n\nContinue the appointment?`)) return;
    openConsult(patient, { join: true, offer }, btn);
    return;
  }
  chooseJoin(patient, offer, (join) => openConsult(patient, { join, offer }, btn));
}

// Opens the Consultation tab. Called straight from a click (nothing awaited first), so the browser lets the tab open.
function openConsult(patient, choice, btn) {
  const o = choice && choice.offer;
  const tail = o ? `/${choice.join ? "join" : "new"}/${encodeURIComponent(o.id)}/${Math.round(o.ms || 0)}/${encodeURIComponent(o.time || "")}` : "";
  const url = `${location.href.split("#")[0]}#/consult/new/${encodeURIComponent(patient.id)}${tail}`;
  if (window.open(url, "_blank")) return;   // the Consultation tab records it (and pauses the other one)
  // Pop-ups blocked: record in this tab
  if (btn) btn.disabled = true;
  const join = !!(choice && choice.join);
  startRecording(patient, staff, {
    takeOver: true, continuesId: join ? o.id : "", priorMs: join ? o.ms || 0 : 0, separate: !join, offer: o || null,
  }).then((res) => {
    showToast(res && res.stopped
      ? `${res.stopped.name}'s recording is paused and saved. ${patient.name}'s is recording now.`
      : join ? `Continuing ${patient.name}'s appointment in this tab (pop-ups are blocked).`
      : "Pop-ups are blocked, so this appointment is recording in this tab.");
  }).catch((err) => {
    console.error("Recording didn't start:", err);
    showToast(err && err.name === "NotAllowedError"
      ? "Microphone access was blocked. Click the lock icon in the address bar and allow the microphone."
      : err && err.name === "NotFoundError" ? "No microphone found. Plug one in and try again."
      : (err && err.message) || "Couldn't start recording.");
  }).finally(() => { if (btn) btn.disabled = false; lastKey = ""; render(getState()); });
}

// The choice: continue the earlier appointment, or start a new one. pick(join) runs inside the click.
function chooseJoin(patient, ci, pick) {
  document.querySelectorAll(".cj-back").forEach((el) => el.remove());
  const back = document.createElement("div");
  back.className = "cj-back";
  const time = ci.time ? escapeHtml(ci.time) : "";
  back.innerHTML = `<div class="cj" role="dialog" aria-modal="true" aria-labelledby="cj-title">
    <button type="button" class="cj-x" data-cj="close" aria-label="Cancel">×</button>
    <div class="cj-head">
      <span class="rec-av" style="--h:${hueFromString(patient.name)}">${escapeHtml(getInitials(patient.name))}</span>
      <div><h3 id="cj-title">${escapeHtml(patient.name)} was recorded earlier today</h3>
        <p>${time ? `${time} · ` : ""}${fmt(ci.ms)} recorded · Draft notes</p></div>
    </div>
    <p class="cj-q">Is this the same appointment, or a new one?</p>
    <div class="cj-opts">
      <button type="button" class="cj-opt is-main" data-cj="join">${ICONS.link}
        <strong>Continue the ${time || "earlier"} appointment</strong>
        <span>One set of notes, written again from both recordings.${ci.edited
          ? ` The edited notes${ci.editedBy ? ` (by ${escapeHtml(ci.editedBy)})` : ""} are kept as the previous version.` : ""}</span>
        <em>Continue</em></button>
      <button type="button" class="cj-opt" data-cj="new">${ICONS.plus}
        <strong>Start a new appointment</strong>
        <span>Separate notes. The ${time ? `${time} ` : "earlier "}notes stay as they are.</span>
        <em>Keep separate</em></button>
    </div>
    <p class="cj-foot">You can change this while recording, until you press Complete appointment.</p>
  </div>`;
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  back.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cj]");
    if (e.target === back || (b && b.dataset.cj === "close")) { close(); return; }
    if (!b) return;
    close();
    pick(b.dataset.cj === "join");
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(back);
  back.querySelector('[data-cj="join"]').focus();
}

async function onClick(e) {
  const btn = e.target.closest("[data-rec]");
  if (!btn) return;
  const action = btn.dataset.rec;
  const id = btn.dataset.id || "";
  const job = id ? getState().jobs.find((j) => j.recId === id) : null;
  const parked = id ? (getState().parked || []).find((p) => p.patient.id === id) : null;

  try {
    if (action === "start") {
      if (context) startFor(context, btn);
    } else if (action === "park-continue") {
      if (parked) startFor(parked.patient, btn, { direct: true });
    } else if (action === "park-open") {
      if (parked) openPatient(parked.patient);
    } else if (action === "park-dismiss") {
      unpark(id);
    } else if (action === "join" || action === "separate") {
      if (!setJoin(action === "join")) showToast("That can't be changed now.");
    } else if (action === "pause" || action === "resume") {
      if (Date.now() - lastToggle < 900) return;   // a quick second tap mustn't undo the first
      lastToggle = Date.now();
      if (action === "pause") pauseRecording(); else resumeRecording();
      if (getState().live.status !== (action === "pause" ? "paused" : "recording")) {
        showToast(action === "pause" ? "The recording didn't pause. Try Pause again." : "The recording didn't resume. Try Resume again.");
      }
    } else if (action === "complete") {
      if (!confirm("Complete this appointment? The recording uploads in the background.")) return;
      await completeRecording();
      showToast("The recording is uploading in the background. You can start the next appointment.");
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
    } else if (action === "clear-ready") {
      getState().jobs.filter((j) => j.status === "ready").forEach((j) => dismissJob(j.recId));
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