import { storage, db, auth } from "./firebase-config.js";
import { ref, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { toDateKey } from "./utils.js";

/* ===================== State ===================== */

const state = {
  status: "idle", // idle | recording | paused | stopping | uploading | done | error | recovered
  recId: null, patient: null, staff: null,
  elapsedMs: 0, startedAt: null, mime: "",
  progress: 0, error: "",
};

const listeners = new Set();
let mediaRecorder = null;
let stream = null;
let chunkSeq = 0;
let runStart = 0;
let wakeLock = null;
let tickTimer = null;
let lastMetaSave = 0;
const pendingWrites = new Set();

const ACTIVE = ["recording", "paused", "stopping", "uploading"];

function elapsed() {
  return state.elapsedMs + (state.status === "recording" ? performance.now() - runStart : 0);
}

export function getState() {
  return { ...state, elapsedMs: elapsed() };
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

export function isRecorderBusy() {
  return ACTIVE.includes(state.status);
}

/* ===================== IndexedDB: crash-safe chunk storage ===================== */

const DB_NAME = "dermedica-recordings";
const CHUNKS = "chunks";
const META = "meta";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore(CHUNKS, { keyPath: ["recId", "seq"] });
      d.createObjectStore(META, { keyPath: "recId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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

async function deleteRecording(recId) {
  await withStore(CHUNKS, "readwrite", (s) => s.delete(chunkRange(recId)));
  await withStore(META, "readwrite", (s) => s.delete(recId));
}

function metaFromState() {
  return {
    recId: state.recId, patient: state.patient, staff: state.staff,
    startedAt: state.startedAt, mime: state.mime, elapsedMs: elapsed(),
  };
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
    if (state.status !== "recording") return;
    emit();
    if (Date.now() - lastMetaSave > 10_000) {
      lastMetaSave = Date.now();
      putMeta(metaFromState()).catch(() => {});
    }
  }, 1000);
}

function stopTick() {
  clearInterval(tickTimer);
  tickTimer = null;
}

function reset() {
  Object.assign(state, {
    status: "idle", recId: null, patient: null, staff: null,
    elapsedMs: 0, startedAt: null, mime: "", progress: 0, error: "",
  });
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

/* ===================== Public actions ===================== */

export async function startRecording(patient, staff) {
  if (isRecorderBusy() || state.status === "recovered") {
    throw new Error("Finish or discard the current recording first.");
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
  Object.assign(state, {
    status: "recording", recId,
    patient: { id: patient.id, pttId: patient.pttId || "", name: patient.name },
    staff: { uid: staff.uid, name: staff.name },
    elapsedMs: 0, startedAt: new Date().toISOString(),
    mime: mediaRecorder.mimeType || mime || "audio/webm", progress: 0, error: "",
  });
  chunkSeq = 0;
  await putMeta(metaFromState());

  // Every chunk is saved to the device as it arrives
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const p = putChunk(recId, chunkSeq++, e.data).catch((err) => console.error("Chunk save failed:", err));
    pendingWrites.add(p);
    p.finally(() => pendingWrites.delete(p));
  };

  // Microphone unplugged / permission revoked: save what we have
  stream.getAudioTracks().forEach((t) => {
    t.onended = () => { if (state.status === "recording" || state.status === "paused") completeRecording(); };
  });

  mediaRecorder.start(5000); // a chunk every 5 seconds
  runStart = performance.now();
  lastMetaSave = Date.now();
  acquireWakeLock();
  startTick();
  emit();
}

export function pauseRecording() {
  if (state.status !== "recording") return;
  mediaRecorder.pause();
  state.elapsedMs += performance.now() - runStart;
  state.status = "paused";
  putMeta(metaFromState()).catch(() => {});
  emit();
}

export function resumeRecording() {
  if (state.status !== "paused") return;
  mediaRecorder.resume();
  runStart = performance.now();
  state.status = "recording";
  emit();
}

export async function completeRecording() {
  if (state.status !== "recording" && state.status !== "paused") return;
  if (state.status === "recording") state.elapsedMs += performance.now() - runStart;
  state.status = "stopping";
  emit();

  await stopRecorder();
  await putMeta(metaFromState()).catch(() => {});
  await uploadRecording(state.recId);
}

export async function cancelRecording() {
  if (state.status !== "recording" && state.status !== "paused") return;
  const id = state.recId;
  await stopRecorder();
  await deleteRecording(id).catch(() => {});
  reset();
}

// On logout: stop the mic but KEEP the audio on the device for upload at next login
export async function suspendRecorder() {
  if (state.status === "recording" || state.status === "paused") {
    if (state.status === "recording") state.elapsedMs += performance.now() - runStart;
    await stopRecorder();
    await putMeta(metaFromState()).catch(() => {});
  }
  reset();
}

async function uploadRecording(recId) {
  try {
    const meta = await getMeta(recId);
    if (!meta) throw new Error("Recording not found on this device.");

    Object.assign(state, {
      status: "uploading", progress: 0, recId,
      patient: meta.patient, staff: meta.staff, elapsedMs: meta.elapsedMs || 0, mime: meta.mime,
    });
    emit();

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
      task.on("state_changed",
        (snap) => {
          state.progress = snap.totalBytes ? snap.bytesTransferred / snap.totalBytes : 0;
          emit();
        },
        reject,
        resolve);
    });

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
      staffName: meta.staff.name || "",
      createdByUid: auth.currentUser ? auth.currentUser.uid : "",
      startedAt: meta.startedAt,
      consent: true,
      createdAt: serverTimestamp(),
    });

    await deleteRecording(recId); // the device copy is no longer needed
    Object.assign(state, { status: "done", progress: 1 });
    emit();
  } catch (err) {
    console.error("Recording upload failed:", err);
    state.status = "error";
    state.error = err.code === "storage/unauthorized" || err.code === "permission-denied"
      ? "Upload was blocked. Make sure you're logged in, then try again."
      : (err.message || "Upload failed. Check your connection and try again.");
    emit();
  }
}

export function retryUpload() {
  if (state.status === "error" && state.recId) uploadRecording(state.recId);
}

export function dismiss() {
  if (state.status === "done") reset();
}

/* ===================== Recovery after a crash / closed tab / logout ===================== */

export async function checkForUnfinished() {
  if (state.status !== "idle") return;
  try {
    const metas = await getAllMeta();
    const latest = metas.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
    if (!latest || state.status !== "idle") return;
    Object.assign(state, {
      status: "recovered", recId: latest.recId, patient: latest.patient, staff: latest.staff,
      elapsedMs: latest.elapsedMs || 0, mime: latest.mime,
    });
    emit();
  } catch (err) {
    console.warn("Recording recovery check failed:", err);
  }
}

export function uploadRecovered() {
  if (state.status === "recovered") uploadRecording(state.recId);
}

export async function discardRecording() {
  const id = state.recId;
  if (id) await deleteRecording(id).catch(() => {});
  reset();
}

/* ===================== Safety nets ===================== */

window.addEventListener("beforeunload", (e) => {
  if (isRecorderBusy()) {
    e.preventDefault();
    e.returnValue = ""; // browser shows "Leave site?"
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (state.status === "recording" || state.status === "paused")) {
    acquireWakeLock(); // wake lock is dropped when the tab is hidden
  }
});