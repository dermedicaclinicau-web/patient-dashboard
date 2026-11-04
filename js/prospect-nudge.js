// A small nudge at the bottom right when one of my prospect follow-ups is due (a follow-up with a time).
// Reads my prospects with a follow-up today straight from Firestore, and checks every 30 seconds.
// Tap: opens the prospect · ×: not shown again on this device · Snooze: back in 10 minutes.
import { db, auth } from "./firebase-config.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const OPEN = ["new", "contacted", "consult_booked", "consulted", "tx_booked", "treated"];
const KEY = "pr-nudge-v1";          // on this device: { "<id>|<date>|<time>": "closed" | snoozed-until (ms) }
const SNOOZE_MS = 10 * 60 * 1000;
const MAX_SHOWN = 3;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Perth", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function perthNow() {
  const o = Object.fromEntries(FMT.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour}:${o.minute}` };
}
const hmText = (hm) => { const m = /^(\d{2}):(\d{2})$/.exec(hm || ""); if (!m) return ""; const h = +m[1]; return `${h % 12 || 12}:${m[2]} ${h < 12 ? "am" : "pm"}`; };
const minsPast = (hm, now) => { const a = hm.split(":").map(Number), b = now.split(":").map(Number); return (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]); };
const keyOf = (p) => `${p.id}|${p.nextFollowUp}|${p.nextFollowUpTime}`;

function readState() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function writeState(k, v) {
  const s = readState();
  const today = perthNow().day;
  Object.keys(s).forEach((x) => { if (x.split("|")[1] !== today) delete s[x]; });   // tidy away other days
  s[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private browsing: shown again next time */ }
}

let started = false, uid = "", day = "", unsub = null, items = new Map(), box = null, shownSig = "";

function listen() {
  if (unsub) { unsub(); unsub = null; }
  items = new Map();
  day = perthNow().day;
  if (!uid) { draw([]); return; }
  unsub = onSnapshot(
    query(collection(db, "prospects"), where("assignedToId", "==", uid), where("nextFollowUp", "==", day)),
    (snap) => { items = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])); check(); },
    (err) => { console.warn("Prospect nudges off:", err && (err.code || err.message)); unsub = null; items = new Map(); draw([]); },
  );
}

function check() {
  const now = perthNow();
  if (uid && now.day !== day) { listen(); return; }   // a new day: today's follow-ups
  const s = readState();
  const here = location.hash;
  const due = [...items.values()]
    .filter((p) => OPEN.includes(p.stage || "new") && /^\d{2}:\d{2}$/.test(p.nextFollowUpTime || "") && p.nextFollowUpTime <= now.hm)
    .filter((p) => {
      const k = keyOf(p);
      if (here === `#/prospects/${encodeURIComponent(p.id)}`) { if (s[k] !== "closed") writeState(k, "closed"); return false; }   // already looking at it
      const v = s[k];
      return v !== "closed" && !(typeof v === "number" && v > Date.now());
    })
    .sort((a, b) => a.nextFollowUpTime.localeCompare(b.nextFollowUpTime));
  draw(due, now.hm);
}

function draw(due, nowHm = perthNow().hm) {
  const sig = due.map(keyOf).join(",") + "|" + nowHm.slice(0, 4);   // redraws when the list changes (or every 10 minutes for "x min ago")
  if (sig === shownSig) return;
  const before = new Set(shownSig.split("|")[0].split(",").filter(Boolean));
  shownSig = sig;
  if (!box) {
    box = document.createElement("div");
    box.className = "pn-stack";
    box.setAttribute("aria-live", "polite");
    box.addEventListener("click", onClick);
    document.body.appendChild(box);
  }
  const shown = due.slice(0, MAX_SHOWN);
  box.innerHTML = shown.map((p) => {
    const late = minsPast(p.nextFollowUpTime, nowHm);
    const when = `Due ${hmText(p.nextFollowUpTime)}${late >= 5 ? ` · ${late < 60 ? `${late} min` : `${Math.floor(late / 60)} h`} ago` : ""}`;
    return `<div class="pn${before.has(keyOf(p)) ? "" : " is-new"}" data-k="${esc(keyOf(p))}" data-id="${esc(p.id)}">
      <button type="button" class="pn-main" data-act="open" title="Open ${esc(p.name || "the prospect")}">
        <span class="pn-ic">${CLOCK}</span>
        <span class="pn-txt"><strong>Follow up: ${esc(p.name || "a prospect")}</strong>
          <small>${esc([when, p.concern].filter(Boolean).join(" · "))}</small>
          ${p.followNote ? `<small class="pn-note">“${esc(p.followNote)}”</small>` : ""}</span>
      </button>
      <div class="pn-acts"><button type="button" data-act="snooze">Snooze 10 min</button></div>
      <button type="button" class="pn-x" data-act="close" aria-label="Close this reminder">×</button>
    </div>`;
  }).join("") + (due.length > MAX_SHOWN
    ? `<a class="pn-more" href="#/prospects">+${due.length - MAX_SHOWN} more follow-up${due.length - MAX_SHOWN === 1 ? "" : "s"} due</a>` : "");
}

function onClick(e) {
  const b = e.target.closest("[data-act]");
  const card = e.target.closest(".pn");
  if (!b || !card) return;
  const k = card.dataset.k;
  if (b.dataset.act === "open") { writeState(k, "closed"); location.hash = `#/prospects/${encodeURIComponent(card.dataset.id)}`; }
  if (b.dataset.act === "close") writeState(k, "closed");
  if (b.dataset.act === "snooze") writeState(k, Date.now() + SNOOZE_MS);
  card.classList.add("is-out");
  setTimeout(check, 180);
}

// Call once when the portal starts. It follows logging in and out by itself.
export function startProspectNudges() {
  if (started) return;
  started = true;
  onAuthStateChanged(auth, (user) => {
    const next = user ? user.uid : "";
    if (next === uid) return;
    uid = next;
    shownSig = "";
    listen();
  });
  setInterval(check, 30000);
  window.addEventListener("hashchange", check);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}