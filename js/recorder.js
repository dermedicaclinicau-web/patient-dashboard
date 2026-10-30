// Recording consultations.
// The live recording: one at a time (there's one microphone). Complete Appointment hands it to the background
// straight away, so the next appointment can be recorded while the last one uploads and becomes notes.
// Background recordings ("jobs"): any number at once, each with its own upload, progress and notes.
// Audio stays on this device (IndexedDB) until its job is created, so a closed tab or a logout loses nothing.
import { storage, db, auth } from "./firebase-config.js";
import { ref, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { doc, getDoc, setDoc, serverTimestamp, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { toDateKey } from "./utils.js";


/* ===================== State ===================== */

const IDLE = { status: "idle", recId: null, patient: null, staff: null, elapsedMs: 0, startedAt: null, mime: "" };
const live = { ...IDLE };   // status: idle | recording | paused | stopping

// recId → { recId, patient, staff, elapsedMs, startedAt, at, status, stage, progress, error, transcriptId, announced }
// status: recovered (on this device, not uploaded) | uploading | error (upload failed) | processing | failed | ready
const jobs = new Map();

const listeners = new Set();
let mediaRecorder = null;
let stream = null;
let chunkSeq = 0;
let runStart = 0;
let wakeLock = null;
let tickTimer = null;
let lastMetaSave = 0;
let checkedFor = "";               // the person the unfinished-recordings check last ran for
const pendingWrites = new Set();
const uploads = new Map();         // recId → the running upload
const watchers = new Map();        // recId → stop watching its job

const LIVE_BUSY = ["recording", "paused", "stopping"];
const elapsed = () => live.elapsedMs + (live.status === "recording" ? performance.now() - runStart : 0);
const myUid = () => (auth.currentUser && auth.currentUser.uid) || "";

export function getState() {
  const l = { ...live, elapsedMs: elapsed() };
  return {
    ...l,   // older callers read status / patient from the top
    live: l,
    jobs: [...jobs.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).map((j) => ({ ...j })),
  };
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(getState());
  return () => listeners.delete(fn);
}

function emit() {
  const s = getState();
  listeners.forEach((fn) => fn(s));
}

// The microphone is in use
export const isRecorderBusy = () => LIVE_BUSY.includes(live.status);
// A finished recording is still on its way up
export const hasPendingUploads = () => [...jobs.values()].some((j) => j.status === "uploading");

/* ===================== IndexedDB: crash-safe chunk storage ===================== */

const DB_NAME = "dermedica-recordings";
const CHUNKS = "chunks";
const META = "meta";

let dbPromise = null;   // one connection, reused (it used to open a new one every time)

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore(CHUNKS, { keyPath: ["recId", "seq"] });
      d.createObjectStore(META, { keyPath: "recId" });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); dbPromise = null; };
      d.onclose = () => { dbPromise = null; };
      resolve(d);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function withStore(name, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    tx.oncomplete = () => resolve(req && "result" in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const chunkRange = (recId) => IDBKeyRange.bound([recId, 0], [recId, Number.MAX_SAFE_INTEGER]);
const putChunk = (recId, seq, blob) => withStore(CHUNKS, "readwrite", (s) => s.put({ recId, seq, blob }));
const getChunks = (recId) => withStore(CHUNKS, "readonly", (s) => s.getAll(chunkRange(recId)));
const putMeta = (meta) => withStore(META, "readwrite", (s) => s.put(meta));
const getMeta = (recId) => withStore(META, "readonly", (s) => s.get(recId));
const getAllMeta = () => withStore(META, "readonly", (s) => s.getAll());

// The audio and its details go together, or not at all
async function deleteRecording(recId) {
  const d = await openDb();
  await new Promise((resolve, reject) => {
    const tx = d.transaction([CHUNKS, META], "readwrite");
    tx.objectStore(CHUNKS).delete(chunkRange(recId));
    tx.objectStore(META).delete(recId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function metaFromLive() {
  return {
    recId: live.recId, patient: live.patient, staff: live.staff,
    startedAt: live.startedAt, mime: live.mime, elapsedMs: elapsed(),
  };
}

/* ===================== Recordings still becoming notes (remembered across a refresh) ===================== */

const TRACK_KEY = "dm-rec-jobs-v1";
const DAY = 864e5;

function readTracked() {
  try {
    const v = JSON.parse(localStorage.getItem(TRACK_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function saveTracked() {
  const me = myUid();
  if (!me) return;
  const mine = [...jobs.values()].filter((j) => ["processing", "failed", "ready"].includes(j.status))
    .map((j) => ({ recId: j.recId, patient: j.patient, staff: j.staff, elapsedMs: j.elapsedMs, at: j.at,
      merged: !!j.merged, announced: !!j.announced, uid: me }));
  // Someone else's on a shared iPad are kept (for a day)
  const others = readTracked().filter((t) => t.uid !== me && Date.now() - (t.at || 0) < DAY);
  try { localStorage.setItem(TRACK_KEY, JSON.stringify([...others, ...mine].slice(-40))); } catch { /* not essential */ }
}

/* ===================== Jobs ===================== */

function addJob(meta, status) {
  jobs.set(meta.recId, {
    recId: meta.recId, patient: meta.patient || null, staff: meta.staff || null, elapsedMs: meta.elapsedMs || 0,
    startedAt: meta.startedAt || "", at: meta.at || Date.now(), status, stage: "", progress: 0, error: "",
    transcriptId: "", merged: !!meta.merged, announced: !!meta.announced,
  });
}

function setJob(recId, patch) {
  const j = jobs.get(recId);
  if (!j) return;
  const statusChanged = patch.status && patch.status !== j.status;
  Object.assign(j, patch);
  if (statusChanged) saveTracked();
  emit();
}

/* ===================== Helpers ===================== */

function pickMime() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return options.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

async function acquireWakeLock() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch { /* not critical */ }
}

function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch { /* ignore */ }
  wakeLock = null;
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (live.status !== "recording") return;
    emit();
    if (Date.now() - lastMetaSave > 10_000) {
      lastMetaSave = Date.now();
      putMeta(metaFromLive()).catch(() => {});
    }
  }, 1000);
}

function stopTick() {
  clearInterval(tickTimer);
  tickTimer = null;
}

function resetLive() {
  Object.assign(live, IDLE);
  emit();
}

// Waits for the recorder to flush its last chunk and for all chunk saves to finish
async function stopRecorder() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      mediaRecorder.addEventListener("stop", resolve, { once: true });
      mediaRecorder.stop();
    });
  }
  await Promise.allSettled([...pendingWrites]);
  mediaRecorder = null;
  stopStream();
  releaseWakeLock();
  stopTick();
}

/* ===================== The live recording ===================== */

export async function startRecording(patient, staff) {
  if (isRecorderBusy()) {
    throw new Error(`The recording for ${live.patient ? live.patient.name : "another patient"} is still going. Complete or cancel it first.`);
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("This browser can't record audio. Please use Chrome, Edge or Safari.");
  }

  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });

  const mime = pickMime();
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);

  const recId = `REC-${toDateKey().replace(/-/g, "")}-${Date.now().toString(36).toUpperCase()}`;
  Object.assign(live, {
    status: "recording", recId,
    patient: { id: patient.id, pttId: patient.pttId || "", name: patient.name },
    staff: { uid: staff.uid, name: staff.name },
    elapsedMs: 0, startedAt: new Date().toISOString(),
    mime: mediaRecorder.mimeType || mime || "audio/webm",
  });
  chunkSeq = 0;
  await putMeta(metaFromLive());

  // Every chunk is saved to the device as it arrives
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const p = putChunk(recId, chunkSeq++, e.data).catch((err) => console.error("Chunk save failed:", err));
    pendingWrites.add(p);
    p.finally(() => pendingWrites.delete(p));
  };

  // Microphone unplugged / permission revoked: save what we have
  stream.getAudioTracks().forEach((t) => {
    t.onended = () => { if (live.status === "recording" || live.status === "paused") completeRecording(); };
  });

  mediaRecorder.start(5000); // a chunk every 5 seconds
  runStart = performance.now();
  lastMetaSave = Date.now();
  acquireWakeLock();
  startTick();
  emit();
}

export function pauseRecording() {
  if (live.status !== "recording") return;
  mediaRecorder.pause();
  live.elapsedMs += performance.now() - runStart;
  live.status = "paused";
  putMeta(metaFromLive()).catch(() => {});
  emit();
}

export function resumeRecording() {
  if (live.status !== "paused") return;
  mediaRecorder.resume();
  runStart = performance.now();
  live.status = "recording";
  emit();
}

// Saves the last seconds, frees the microphone, and sends the recording on in the background
export async function completeRecording() {
  if (live.status !== "recording" && live.status !== "paused") return;
  if (live.status === "recording") live.elapsedMs += performance.now() - runStart;
  live.status = "stopping";
  emit();

  await stopRecorder();
  const meta = metaFromLive();
  await putMeta(meta).catch(() => {});
  resetLive();                 // ready for the next patient straight away
  addJob(meta, "uploading");
  emit();
  runUpload(meta.recId);       // not awaited: it carries on in the background
}

export async function cancelRecording() {
  if (live.status !== "recording" && live.status !== "paused") return;
  const id = live.recId;
  await stopRecorder();
  await deleteRecording(id).catch(() => {});
  resetLive();
}

// On logout: stop the mic and any uploads, but KEEP the audio on the device for upload at the next login
export async function suspendRecorder() {
  if (live.status === "recording" || live.status === "paused") {
    if (live.status === "recording") live.elapsedMs += performance.now() - runStart;
    await stopRecorder();
    await putMeta(metaFromLive()).catch(() => {});
  }
  uploads.forEach((task) => { try { if (task) task.cancel(); } catch { /* already finished */ } });
  uploads.clear();
  watchers.forEach((stop) => stop());
  watchers.clear();
  jobs.clear();
  checkedFor = "";
  resetLive();
}

/* ===================== Upload (background) ===================== */

// Recovered or failed uploads: send now
export function uploadNow(recId) {
  const j = jobs.get(recId);
  if (j && ["recovered", "error"].includes(j.status)) runUpload(recId);
}
// Is this recording already on the server? (The device copy wasn't cleared last time.)
// → "ready" | "deleted" | the job's status | null (not there, or couldn't check)
async function serverCopy(recId) {
  try {
    const job = await getDoc(doc(db, "recording_jobs", recId));
    if (job.exists()) return String(job.data().status || "uploaded");
  } catch (err) { console.warn("Recording job not checked:", err); }
  try {
    const tr = await getDoc(doc(db, "appointment_transcripts", recId));
    if (tr.exists()) return "ready";
  } catch (err) { console.warn("Transcript not checked:", err); }
  try {
    const del = await getDoc(doc(db, "deleted_records", recId));
    if (del.exists()) return "deleted";   // deleted by staff: never upload it again
  } catch { /* not readable here: fine */ }
  return null;
}

// Already uploaded: clear the device copy, and either drop the chip or follow its notes
async function settleUploaded(recId, status) {
  await deleteRecording(recId).catch((err) => console.warn("Device copy not cleared:", err));
  uploads.delete(recId);
  if (!jobs.has(recId)) return;
  if (status === "ready" || status === "deleted") {
    stopWatching(recId);
    jobs.delete(recId);
    saveTracked();
    emit();
    return;
  }
  setJob(recId, { status: "processing", stage: status, progress: 1, error: "" });
  watchJob(recId);
}
async function runUpload(recId) {
  if (!jobs.has(recId) || uploads.has(recId)) return;
  setJob(recId, { status: "uploading", progress: 0, error: "" });
  uploads.set(recId, null);   // claims it while we check, so it isn't started twice
  const already = await serverCopy(recId);
  if (already) { await settleUploaded(recId, already); return; }
  if (!jobs.has(recId)) { uploads.delete(recId); return; }   // logged out while checking
  try {
    const meta = await getMeta(recId);
    if (!meta) throw new Error("This recording isn't on this device any more.");
    const chunks = await getChunks(recId);
    if (!chunks.length) throw new Error("No audio was captured. Check the microphone and try again.");

    const baseType = String(meta.mime || "audio/webm").split(";")[0];
    const blob = new Blob(chunks.map((c) => c.blob), { type: baseType });
    const ext = baseType.includes("mp4") ? "m4a" : baseType.includes("ogg") ? "ogg" : "webm";
    const patientKey = String(meta.patient.pttId || meta.patient.id).replace(/[/#[\]]/g, "_");
    const path = `appointment_audio/${patientKey}/${recId}.${ext}`;

    await new Promise((resolve, reject) => {
      const task = uploadBytesResumable(ref(storage, path), blob, {
        contentType: baseType,
        customMetadata: { recordingId: recId, patientId: patientKey },
      });
      uploads.set(recId, task);
      task.on("state_changed",
        (snap) => {
          const j = jobs.get(recId);
          if (!j) return;
          j.progress = snap.totalBytes ? snap.bytesTransferred / snap.totalBytes : 0;
          emit();
        },
        reject,
        resolve);
    });
    uploads.delete(recId);
    if (!jobs.has(recId)) return;   // logged out mid-upload: it goes again at the next login

    await setDoc(doc(db, "recording_jobs", recId), {
      recordingId: recId,
      status: "uploaded",
      audioPath: path,
      mimeType: baseType,
      sizeBytes: blob.size,
      durationSec: Math.round((meta.elapsedMs || 0) / 1000),
      patientId: meta.patient.pttId || "",
      patientDocId: meta.patient.id || "",
      patientName: meta.patient.name || "",
      staffName: (meta.staff && meta.staff.name) || "",
      createdByUid: myUid(),
      startedAt: meta.startedAt,
      consent: true,
      createdAt: serverTimestamp(),
    });

    await deleteRecording(recId); // the device copy is no longer needed
    startProcessing(recId);
  } catch (err) {
    uploads.delete(recId);
    if (!jobs.has(recId) || (err && err.code === "storage/canceled")) return;
    // Refused because it's already there (e.g. another tab finished it first): not a failure
    const already = await serverCopy(recId);
    if (already) { await settleUploaded(recId, already); return; }
    console.error("Recording upload failed:", err);
    setJob(recId, {
      status: "error",
      error: err.code === "storage/unauthorized" || err.code === "permission-denied"
        ? "Upload was blocked. Make sure you're logged in, then try again."
        : (err.message || "Upload failed. Check your connection and try again."),
    });
  }
}

/* ===================== Processing (Deepgram → Gemini, in Apps Script) ===================== */

function stopWatching(recId) {
  const stop = watchers.get(recId);
  if (stop) { stop(); watchers.delete(recId); }
}

// Live progress from the server via the recording_jobs document
function watchJob(recId) {
  stopWatching(recId);
  watchers.set(recId, onSnapshot(doc(db, "recording_jobs", recId), (snap) => {
    if (!jobs.has(recId)) { stopWatching(recId); return; }
    // The recording was deleted on the server: its chip goes too (but not just because the iPad is offline)
    if (!snap.exists()) { if (!snap.metadata.fromCache) dismissJob(recId); return; }
    const job = snap.data();
    if (job.status === "ready") {
      stopWatching(recId);
      setJob(recId, { status: "ready", transcriptId: job.transcriptId || recId, merged: !!job.mergedInto, error: "" });
    } else if (job.status === "failed") {
      setJob(recId, { status: "failed", error: job.error || "Processing failed." });
    } else {
      setJob(recId, { status: "processing", stage: job.status });
    }
  }, (err) => console.warn("Watching the recording job failed:", err)));
}

// Step 1 (transcribe) and step 2 (write notes) run as separate server calls
async function kickProcessing(recId, round = 0) {
  try {
    const res = await callApi({ action: "processRecording", recordingId: recId });
    if (res && res.next && round < 3 && jobs.has(recId)) kickProcessing(recId, round + 1);
  } catch (err) {
    console.warn("Process request didn't complete (the 5-minute sweeper will continue it):", err);
  }
}

function startProcessing(recId) {
  setJob(recId, { status: "processing", stage: "uploaded", error: "", progress: 1 });
  watchJob(recId);
  kickProcessing(recId);
}

export function retryProcessing(recId) {
  const j = jobs.get(recId);
  if (j && j.status === "failed") startProcessing(recId);
}

/* ===================== Tidying the list ===================== */

// Hides a recording that's safely uploaded (its notes still finish on the server)
export function dismissJob(recId) {
  const j = jobs.get(recId);
  if (!j || ["uploading", "recovered", "error"].includes(j.status)) return;   // audio not safe yet: Discard instead
  stopWatching(recId);
  jobs.delete(recId);
  saveTracked();
  emit();
}

// Deletes a recording that's only on this device
export async function discardJob(recId) {
  const j = jobs.get(recId);
  if (!j || !["recovered", "error"].includes(j.status)) return;
  await deleteRecording(recId).catch(() => {});
  jobs.delete(recId);
  emit();
}

// The notes panel has been shown for this one (so it doesn't slide out again after a refresh)
export function markAnnounced(recId) {
  const j = jobs.get(recId);
  if (!j || j.announced) return;
  j.announced = true;
  saveTracked();
}

/* ===================== After a crash / closed tab / logout ===================== */

export async function checkForUnfinished() {
  const me = myUid();
  if (!me || checkedFor === me) return;
  checkedFor = me;

  // 1. Audio still on this device (never uploaded). Your own goes straight up; anyone else's waits for a tap.
  try {
    const metas = await getAllMeta();
    metas.forEach((m) => {
      if (!m || !m.recId || m.recId === live.recId || jobs.has(m.recId)) return;
      addJob({ ...m, at: Date.parse(m.startedAt) || Date.now() }, "recovered");
      if (m.staff && m.staff.uid === me) runUpload(m.recId);
      // On the server already: forget the device copy (their notes are theirs to review)
      else serverCopy(m.recId).then((s) => { if (s) settleUploaded(m.recId, "ready"); });
    });
  } catch (err) {
    console.warn("Recording recovery check failed:", err);
  }

  // 2. Uploaded, and still being turned into notes when the page was closed
  readTracked()
    .filter((t) => t.uid === me && Date.now() - (t.at || 0) < DAY && t.recId && !jobs.has(t.recId))
    .forEach((t) => {
      addJob(t, "processing");
      watchJob(t.recId);
    });
  emit();
}

/* ===================== Safety nets ===================== */

window.addEventListener("beforeunload", (e) => {
  if (isRecorderBusy() || hasPendingUploads()) {
    e.preventDefault();
    e.returnValue = ""; // browser shows "Leave site?"
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (live.status === "recording" || live.status === "paused")) {
    acquireWakeLock(); // wake lock is dropped when the tab is hidden
  }
});