// Who's on the portal: each open tab says "I'm here" every 2 minutes, and straight away when it's hidden, shown or closed.
// presence/<staff uid> → { name, devices: { <tab id>: { state: "active"|"away"|"offline", at, device } }, updatedAt }
// Online = any tab active in the last 5 minutes. Away = open but hidden, or untouched for 10 minutes.
import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const BEAT = 2 * 60 * 1000;            // "I'm here", at least this often
const STALE = 5 * 60 * 1000;           // no word from a tab for this long: it's gone (closed, asleep, no signal)
const IDLE = 10 * 60 * 1000;           // untouched for this long: away
const TICK = 30 * 1000;
const MAX_TABS = 25;                   // the Firestore rule allows 30: stay well under it
const ACT = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"];
const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);

// One id per tab (kept through a refresh)
const tabId = (() => {
  const make = () => Math.random().toString(36).slice(2, 10);
  try {
    let id = sessionStorage.getItem("dm.tab");
    if (!/^[a-z0-9]{6,12}$/.test(id || "")) { id = make(); sessionStorage.setItem("dm.tab", id); }
    return id;
  } catch { return make(); }
})();

function deviceName() {
  const ua = navigator.userAgent || "";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone|Android.*Mobile/.test(ua)) return "phone";
  if (/Android/.test(ua)) return "tablet";
  return "computer";
}

/* ---------- Saying "I'm here" ---------- */
let me = null;
let state = "";
let lastWrite = 0;
let lastActivity = Date.now();
let timer = null;
let skew = 0;           // Firestore's clock minus this device's clock
let lastPrune = 0;

// Other tabs to remove: closed, or not heard from in 5 minutes, plus the oldest if there are still too many
function dropList(devices, now) {
  const others = Object.entries(devices || {}).filter(([k]) => k !== tabId);
  const live = others.filter(([, t]) => t && t.state !== "offline" && now - toMs(t.at) < STALE)
    .sort((a, b) => toMs(b[1].at) - toMs(a[1].at));
  const keep = new Set(live.slice(0, MAX_TABS - 1).map(([k]) => k));
  return others.map(([k]) => k).filter((k) => !keep.has(k));
}

// A save was refused (too many tabs on record): tidy up first. True if anything was removed.
async function tidy() {
  if (!me) return false;
  const ref = doc(db, "presence", me.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return false;
  const drop = dropList((snap.data({ serverTimestamps: "estimate" }) || {}).devices, Date.now() + skew);
  if (!drop.length) return false;
  await updateDoc(ref, Object.fromEntries(drop.map((k) => [`devices.${k}`, deleteField()])));
  lastPrune = Date.now();
  return true;
}

function write(next, retried = false) {
  if (!me) return;
  state = next;
  lastWrite = Date.now();
  setDoc(doc(db, "presence", me.uid), {
    name: String(me.name || "").slice(0, 120),
    devices: { [tabId]: { state: next, at: serverTimestamp(), device: deviceName() } },
    updatedAt: serverTimestamp(),
  }, { merge: true }).catch((err) => {
    if (err && err.code === "permission-denied" && !retried) {
      tidy()
        .then((did) => { if (did) write(next, true); else console.warn("Presence not saved:", err); })
        .catch((e) => console.warn("Presence not tidied:", e));
      return;
    }
    console.warn("Presence not saved:", err);
  });
}

// This tab is closing (or logging out): take it off the record
function removeTab() {
  if (!me) return;
  state = "";
  updateDoc(doc(db, "presence", me.uid), { [`devices.${tabId}`]: deleteField(), updatedAt: serverTimestamp() })
    .catch((err) => console.warn("Presence not cleared:", err));
}

const wanted = () => (document.hidden || Date.now() - lastActivity > IDLE ? "away" : "active");
function tick() {
  // A hidden tab says "away" once, then goes quiet (it drops off after 5 minutes). Saves most of the reads.
  if (document.hidden) { if (state !== "away") write("away"); return; }
  const w = wanted();
  if (w !== state || Date.now() - lastWrite >= BEAT) write(w);
}
function onActivity() {
  const now = Date.now();
  if (now - lastActivity < 5000) return;   // at most every 5 seconds
  lastActivity = now;
  if (state === "away" && !document.hidden) write("active");
}
function onShow() {
  if (!document.hidden) lastActivity = Date.now();
  tick();
}
const onLeave = () => removeTab();

export function startPresence(staff) {
  if (!staff || !staff.uid) return;
  if (me && me.uid === staff.uid) { me = staff; return; }
  stopPresence();
  me = staff;
  state = "";
  lastPrune = 0;
  lastActivity = Date.now();
  tick();
  timer = setInterval(tick, TICK);
  document.addEventListener("visibilitychange", onShow);
  window.addEventListener("pageshow", onShow);
  window.addEventListener("pagehide", onLeave);
  ACT.forEach((e) => window.addEventListener(e, onActivity, { passive: true, capture: true }));
}

export function stopPresence() {
  if (!me) return;
  removeTab();
  clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onShow);
  window.removeEventListener("pageshow", onShow);
  window.removeEventListener("pagehide", onLeave);
  ACT.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }));
  me = null;
  state = "";
}

/* ---------- Seeing who's here ---------- */
// One person's tabs → { status: "online"|"away"|"offline", device, lastAt (ms) }
export function summarise(x, now = Date.now() + skew) {
  const tabs = Object.values((x && x.devices) || {}).map((t) => ({
    state: String((t && t.state) || ""), at: toMs(t && t.at), device: String((t && t.device) || ""),
  }));
  const lastAt = tabs.reduce((m, t) => Math.max(m, t.at), toMs(x && x.updatedAt));
  const live = tabs.filter((t) => t.at && t.state !== "offline" && now - t.at < STALE).sort((a, b) => b.at - a.at);
  const act = live.find((t) => t.state === "active");
  if (act) return { status: "online", device: act.device, lastAt };
  if (live.length) return { status: "away", device: live[0].device, lastAt };
  return { status: "offline", device: "", lastAt };
}

// My closed and silent tabs are removed (at most every 10 minutes, and only once there are a few)
function prune(mine) {
  if (!me || !mine || Date.now() - lastPrune < 10 * 60 * 1000) return;
  const devices = mine.devices || {};
  if (Object.keys(devices).length < 8) return;
  const drop = dropList(devices, Date.now() + skew);
  if (!drop.length) return;
  lastPrune = Date.now();
  updateDoc(doc(db, "presence", me.uid), Object.fromEntries(drop.map((k) => [`devices.${k}`, deleteField()])))
    .catch((err) => console.warn("Old presence not removed:", err));
}

// Everyone, live: Map<uid, summary>. Only called again when someone's status actually changes.
export function watchPresence(onChange, onError = () => {}) {
  let docs = [];
  let sig = "";
  const emit = () => {
    const map = new Map(docs.map((d) => [d.id, summarise(d.data)]));
    const s = [...map].map(([u, p]) => `${u}:${p.status}:${p.device}:${p.status === "offline" ? Math.floor(p.lastAt / 60000) : ""}`).join("|");
    if (s === sig) return;
    sig = s;
    onChange(map);
  };
  const unsub = onSnapshot(collection(db, "presence"), (snap) => {
    docs = snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: "estimate" }) || {}, pending: d.metadata.hasPendingWrites }));
    const mine = me && docs.find((d) => d.id === me.uid);
    if (mine) {
      // This tab's saved time vs when it was sent: how far this device's clock is out
      const at = toMs(mine.data.devices && mine.data.devices[tabId] && mine.data.devices[tabId].at);
      if (!mine.pending && at && lastWrite) skew = at - lastWrite;
      prune(mine.data);
    }
    emit();
  }, onError);
  const t = setInterval(emit, TICK);   // people drop to offline even when nothing is written
  return () => { unsub(); clearInterval(t); };
}