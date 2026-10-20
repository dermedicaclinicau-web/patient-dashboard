// Silent updates: when a new version is deployed, the portal reloads itself at a moment nobody notices
// (tab in the background, idle, or moving to another page), and puts them back where they were.
// It never reloads while someone is typing, recording, filling in a form, uploading, or has a window open.
import { VERSION } from "./version.js";

const CHECK_EVERY = 2 * 60 * 1000;   // look for a new version every 2 minutes
const CDN_WAIT = 11 * 60 * 1000;     // GitHub Pages caches files for 10 minutes: wait so every file is the new one
const IDLE_FOR = 3 * 60 * 1000;      // no clicks or typing for 3 minutes
const HIDDEN_FOR = 30 * 1000;        // the tab has been in the background for 30 seconds
const KEY = "upd:restore";

// Anything on screen that means "don't reload now"
const BUSY = [
  ".rec-live.is-recording", ".rec-live.is-paused", ".rec-live.is-busy",
  ".rec-bar.is-recording", ".rec-bar.is-paused", ".rec-bar.is-busy", ".rec-job.is-busy",
  ".fe-state.is-dirty", ".fe-state.is-saving", ".mb-state.is-dirty", ".sp-save-state.dirty",
  ".ff-wrap",                                    // filling in a form
  ".sc-table", ".rcv", ".scan",                  // opening count, receiving a delivery, the scanner
  ".ib-up:not(.is-done):not(.is-failed)", ".pq-item:not(.is-done):not(.is-failed)", ".du-steps .is-run",
  ".ch-att:not([hidden])", ".ch-m.is-pending", ".tk-c.is-pending",
].join(",");

let started = false;
let pending = "";        // the newer version on the server
let seenAt = 0;          // when it was first seen
let lastActive = Date.now();
let hiddenAt = 0;
const holds = new Set();

// For screens that know they have unsaved work: holdUpdates("plan", true) … holdUpdates("plan", false)
export function holdUpdates(key, on = true) {
  if (on) holds.add(key); else holds.delete(key);
}

async function serverVersion() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return "";
    return String((await r.json()).v || "");
  } catch {
    return "";   // offline: try again later
  }
}

async function check() {
  const v = await serverVersion();
  if (!v || v === VERSION) return;
  if (v !== pending) { pending = v; seenAt = Date.now(); }
}

function busy() {
  if (holds.size) return true;
  if (document.querySelector("dialog[open]")) return true;
  const a = document.activeElement;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return true;
  if (document.querySelector(BUSY)) return true;
  const ta = document.querySelector(".ch-comp textarea");
  return !!(ta && ta.value.trim());   // a chat message typed but not sent
}

const ready = () => !!pending && Date.now() - seenAt >= CDN_WAIT;

function apply() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({
      y: window.scrollY, chat: !!document.querySelector(".ch.is-open"), at: Date.now(),
    }));
  } catch { /* private mode: they just land at the top */ }
  location.reload();
}

function tryApply() {
  if (ready() && !busy()) apply();
}

// After the reload: back to the same scroll position (and the chat panel, if it was open)
function restore() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(KEY) || "null"); sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  if (!s || Date.now() - s.at > 60000) return;
  let n = 0;
  const t = setInterval(() => {
    n += 1;
    if (s.y) window.scrollTo(0, s.y);
    const bubble = s.chat && document.querySelector(".ch-bubble");
    if (bubble && !document.querySelector(".ch.is-open")) { bubble.click(); s.chat = false; }
    if (n > 30 || (Math.abs(window.scrollY - s.y) < 2 && !s.chat)) clearInterval(t);
  }, 150);   // the page draws in stages, so keep trying for a few seconds
}

export function startUpdater() {
  if (started) return;
  started = true;
  restore();
  const touch = () => { lastActive = Date.now(); };
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, touch, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else check();   // back on the tab: look straight away
  });
  window.addEventListener("hashchange", tryApply);   // moving to another page anyway
  setInterval(() => {
    const now = Date.now();
    if (document.hidden ? now - hiddenAt >= HIDDEN_FOR : now - lastActive >= IDLE_FOR) tryApply();
  }, 30 * 1000);
  setInterval(check, CHECK_EVERY);
  check();
}