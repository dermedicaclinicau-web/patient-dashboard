// "Update everyone's portal": an admin asks every open portal to refresh (app_settings/refresh → { id, at, by }).
// Each portal waits until it's safe (no recording, no form handed to a patient, not typing, no dialog open),
// shows a short countdown, then re-downloads the portal's files and reloads (like Ctrl+Shift+R).
import { db, auth } from "./firebase-config.js";
import { doc, onSnapshot, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const COUNTDOWN = 15;                 // seconds
const SNOOZE = 5 * 60 * 1000;
const MAX_SNOOZES = 2;
const TYPING = 60 * 1000;             // typed in the last minute (while in a text box): wait

/* ---------- Is anything going on that a refresh would lose? ---------- */
// Recordings: every recorder started anywhere in the portal is tracked (this file loads first)
const recorders = new Set();
if (window.MediaRecorder && !MediaRecorder.prototype.__dmTracked) {
  const start = MediaRecorder.prototype.start;
  MediaRecorder.prototype.start = function (...a) { recorders.add(this); return start.apply(this, a); };
  MediaRecorder.prototype.__dmTracked = true;
}
// The microphone: any mic opened by the portal and not yet closed
const mics = new Set();
const md = navigator.mediaDevices;
if (md && md.getUserMedia && !md.__dmTracked) {
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await gum(c);
    s.getAudioTracks().forEach((t) => mics.add(t));
    return s;
  };
  md.__dmTracked = true;
}
const isRecording = () => {
  for (const r of recorders) { if (r.state === "inactive") recorders.delete(r); }
  for (const t of mics) { if (t.readyState === "ended") mics.delete(t); }
  return recorders.size > 0 || mics.size > 0;
};

// Anything else can say "not now": setBusy("my-key", true) … setBusy("my-key", false)
const busyKeys = new Set();
export function setBusy(key, on) { if (on) busyKeys.add(key); else busyKeys.delete(key); }

let lastActivity = 0;
["keydown", "input"].forEach((e) => window.addEventListener(e, () => { lastActivity = Date.now(); }, { capture: true, passive: true }));

function blocker() {
  if (isRecording()) return "recording";
  if (document.body.classList.contains("ff-handing")) return "handover";
  if (busyKeys.size) return "busy";
  if (document.querySelector("dialog[open]")) return "dialog";
  const a = document.activeElement;
  if (a && a.matches("input, textarea, select, [contenteditable='true']") && Date.now() - lastActivity < TYPING) return "typing";
  return "";
}

/* ---------- Waiting, the countdown, and the refresh ---------- */
let pending = null;        // the request being acted on
let seenId = null;         // the request already handled by this page
let countdown = null;
let snoozeUntil = 0;
let snoozes = 0;
let reloading = false;
let loop = null;
let bar = null;

function showBar(kind) {
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "fr-bar";
    bar.setAttribute("role", "status");
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-fr]");
      if (!b) return;
      if (b.dataset.fr === "now") hardReload();
      else { snoozes += 1; snoozeUntil = Date.now() + SNOOZE; countdown = null; hideBar(); }
    });
    document.body.appendChild(bar);
  }
  if (bar.dataset.kind !== kind) {
    bar.dataset.kind = kind;
    bar.innerHTML = kind === "wait"
      ? "<span>The portal has been updated. It'll refresh after your recording finishes.</span>"
      : `<span>The portal has been updated. Refreshing in <b data-role="n"></b>s…</span>
         <button type="button" class="fr-btn is-primary" data-fr="now">Refresh now</button>
         ${snoozes < MAX_SNOOZES ? '<button type="button" class="fr-btn" data-fr="later">Not yet</button>' : ""}`;
  }
  const n = bar.querySelector('[data-role="n"]');
  if (n) n.textContent = String(countdown);
  bar.hidden = false;
}
function hideBar() { if (bar) { bar.hidden = true; bar.dataset.kind = ""; } }

function step() {
  if (!pending || reloading) return;
  if (Date.now() < snoozeUntil) return;
  const why = blocker();
  if (why) {
    countdown = null;
    if (why === "recording") showBar("wait"); else hideBar();   // never shown to a patient
    return;
  }
  if (document.hidden) { hardReload(); return; }               // nobody's looking: refresh now
  countdown = countdown === null ? COUNTDOWN : countdown - 1;
  if (countdown <= 0) { hardReload(); return; }
  showBar("count");
}

// Re-downloads the portal's own files (skipping the browser's saved copies), then reloads
async function hardReload() {
  if (reloading) return;
  reloading = true;
  if (bar) bar.innerHTML = "<span>Refreshing…</span>";
  const own = performance.getEntriesByType("resource").map((e) => e.name)
    .filter((u) => u.startsWith(location.origin) && /\.(js|css|json|html)(\?|$)/i.test(u));
  const urls = [...new Set([location.origin + location.pathname, ...own])];
  await Promise.race([
    Promise.allSettled(urls.map((u) => fetch(u, { cache: "reload", credentials: "same-origin" }))),
    new Promise((r) => setTimeout(r, 8000)),                    // never wait more than 8 seconds
  ]);
  location.reload();
  // Still here (e.g. "Leave site?" was cancelled): try again in 5 minutes
  setTimeout(() => { reloading = false; countdown = null; snoozeUntil = Date.now() + SNOOZE; hideBar(); }, 3000);
}

/* ---------- Listening for the request ---------- */
let unsub = null;
onAuthStateChanged(auth, (u) => {
  if (unsub) { unsub(); unsub = null; }
  if (!u) return;
  let first = true;
  unsub = onSnapshot(doc(db, "app_settings", "refresh"), (s) => {
    const x = s.exists() ? s.data() : null;
    const id = x && typeof x.id === "string" ? x.id : "";
    // The request already there when this page opened is old news
    if (first) { first = false; seenId = id; return; }
    if (!id || id === seenId) return;
    seenId = id;
    pending = { id, by: String(x.by || "") };
    countdown = null;
    snoozes = 0;
    snoozeUntil = 0;
    clearInterval(loop);
    loop = setInterval(step, 1000);
    step();
  }, (err) => console.warn("Refresh signal not loaded:", err));
});

/* ---------- Admins: ask everyone to refresh ---------- */
export async function requestRefresh(staff) {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  seenId = id;   // not this tab: you've just pushed, refresh yourself with Ctrl+Shift+R
  await setDoc(doc(db, "app_settings", "refresh"), {
    id, at: serverTimestamp(), by: String((staff && staff.name) || "").slice(0, 120),
  });
}