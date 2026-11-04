// Small nudges at the bottom right, and desktop alerts when the portal is in the background.
// Everything is read straight from Firestore for the person logged in:
//  · Prospects: a follow-up with a time, once it's due
//  · Help chat: Admins see new Help requests; staff see replies to theirs
//  · Recall: replies to recall texts on my cards, and the cards given to me today
//  · Staff tasks: tasks given to me that are overdue
// Tap: opens it · ×: hidden on this device (tasks and recall: until tomorrow) · Snooze: back in 10 minutes.
import { db, auth } from "./firebase-config.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const STATE_KEY = "nudge-v2";       // { key: { s: "closed" | snoozed-until ms, t } } on this device
const SENT_KEY = "nudge-sent-v1";   // keys already seen (so desktop alerts only go for new things)
const PREF_KEY = "nudge-desktop";   // "on" | "off"
const SNOOZE_MS = 10 * 60 * 1000;
const MAX_SHOWN = 3;
const P_OPEN = ["new", "contacted", "consult_booked", "consulted", "tx_booked", "treated"];

/* ---------- Helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Perth", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function perthNow() {
  const o = Object.fromEntries(FMT.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour}:${o.minute}` };
}
const hmText = (hm) => { const m = /^(\d{2}):(\d{2})$/.exec(hm || ""); if (!m) return ""; const h = +m[1]; return `${h % 12 || 12}:${m[2]} ${h < 12 ? "am" : "pm"}`; };
const minsPast = (hm, now) => { const a = hm.split(":").map(Number), b = now.split(":").map(Number); return b[0] * 60 + b[1] - (a[0] * 60 + a[1]); };
const lateText = (m) => (m >= 5 ? ` · ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`} ago` : "");
const niceDay = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m
  ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : ""; };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const toMs = (v) => (!v ? 0 : typeof v.toMillis === "function" ? v.toMillis() : v instanceof Date ? v.getTime() : Date.parse(v) || 0);
const docsOf = (snap) => new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  clock: ic('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  check: ic('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  chat: ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  phone: ic('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  bell: ic('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
};

function readJson(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } }
function writeJson(k, o) {
  const old = Date.now() - 7 * 864e5;   // tidy away anything older than a week
  Object.keys(o).forEach((x) => { const v = o[x]; if ((v && v.t ? v.t : v) < old) delete o[x]; });
  try { localStorage.setItem(k, JSON.stringify(o)); } catch { /* private browsing */ }
}
function setState(key, s) { const o = readJson(STATE_KEY); o[key] = { s, t: Date.now() }; writeJson(STATE_KEY, o); }
const isHidden = (v) => !!v && (v.s === "closed" || (typeof v.s === "number" && v.s > Date.now()));

/* ===================== The sources ===================== */

const prospects = {
  data: new Map(), day: "",
  start(ctx, changed) {
    this.day = perthNow().day;
    return onSnapshot(query(collection(db, "prospects"), where("assignedToId", "==", ctx.uid), where("nextFollowUp", "==", this.day)),
      (s) => { this.data = docsOf(s); changed(); },
      (err) => { warnOff("Prospects", err); this.data = new Map(); changed(); });
  },
  items(now) {
    return [...this.data.values()]
      .filter((p) => P_OPEN.includes(p.stage || "new") && /^\d{2}:\d{2}$/.test(p.nextFollowUpTime || "") && p.nextFollowUpTime <= now.hm)
      .map((p) => {
        const href = `#/prospects/${encodeURIComponent(p.id)}`;
        return {
          key: `pr|${p.id}|${p.nextFollowUp}|${p.nextFollowUpTime}`, rank: 1, icon: "clock", tone: "teal", href, page: href,
          title: `Follow up: ${p.name || "a prospect"}`, note: p.followNote || "", sort: p.nextFollowUpTime,
          sub: [`Due ${hmText(p.nextFollowUpTime)}${lateText(minsPast(p.nextFollowUpTime, now.hm))}`, p.concern].filter(Boolean).join(" · "),
        };
      });
  },
};

const chats = {
  mine: new Map(), queue: new Map(),
  start(ctx, changed) {
    const stops = [onSnapshot(query(collection(db, "chats"), where("members", "array-contains", ctx.uid)),
      (s) => { this.mine = docsOf(s); changed(); },
      (err) => { warnOff("Help chat", err); this.mine = new Map(); changed(); })];
    if (ctx.admin) {
      stops.push(onSnapshot(query(collection(db, "chats"), where("kind", "==", "help")),
        (s) => { this.queue = docsOf(s); changed(); },
        (err) => { warnOff("Help requests", err); this.queue = new Map(); changed(); }));
    }
    return () => stops.forEach((f) => f());
  },
  items(now, ctx) {
    const since = Date.now() - 3 * 864e5;
    const out = [];
    new Map([...this.queue, ...this.mine]).forEach((c) => {
      if (c.kind !== "help" || c.status === "sorted") return;
      const at = toMs(c.lastAt);
      if (!at || at < since || !c.lastBy || c.lastBy === ctx.uid) return;
      if (toMs((c.readAt || {})[ctx.uid]) >= at) return;                 // I've read it
      const asker = (c.members || [])[0];
      const queue = asker !== ctx.uid;                                    // someone else's Help request (I'm an Admin)
      if (queue && c.lastBy !== asker) return;                            // another admin has already replied
      const who = c.lastByName || (c.names && c.names[c.lastBy]) || (queue ? "A staff member" : "An admin");
      const href = `#/home/chat/${encodeURIComponent(c.id)}`;
      out.push({
        key: `ch|${c.id}|${at}`, rank: 0, icon: "chat", tone: "violet", href, page: href, sort: String(at),
        title: queue ? `${who} needs help` : `Help: ${who} replied`, sub: String(c.lastText || "").replace(/\s+/g, " ").slice(0, 140),
      });
    });
    return out;
  },
};

const recall = {
  data: new Map(),
  start(ctx, changed) {
    return onSnapshot(query(collection(db, "recalls"), where("assignedToId", "==", ctx.uid), where("status", "==", "open")),
      (s) => { this.data = docsOf(s); changed(); },
      (err) => { warnOff("Recall", err); this.data = new Map(); changed(); });
  },
  items(now) {
    const list = [...this.data.values()];
    const out = list.filter((c) => c.replyOpen === true && c.reply && c.reply.kind !== "stop").map((c) => ({
      key: `rr|${c.id}|${c.reply.at || ""}`, rank: 2, icon: "chat", tone: "sky", href: "#/recall", sort: String(c.reply.at || ""),
      title: `${c.patientName || "A patient"} replied`,
      sub: `${c.reply.kind === "yes" ? "Wants to book · " : ""}“${String(c.reply.text || "").slice(0, 120)}”`,
    }));
    if (now.hm >= "08:00") {
      const today = list.filter((c) => c.stage === "call" && (c.assignedDay === now.day || c.callBackDue === now.day));
      if (today.length) {
        const backs = today.filter((c) => c.callBackDue === now.day).length;
        out.push({
          key: `rd|${now.day}`, rank: 4, icon: "phone", tone: "green", href: "#/recall",
          title: `${plural(today.length, "recall call")} for you today`,
          sub: backs ? `Including ${plural(backs, "call-back")}` : "Given to you on the Recall board",
        });
      }
    }
    return out;
  },
};

const tasks = {
  data: new Map(),
  start(ctx, changed) {
    return onSnapshot(query(collection(db, "staff-task-list"), where("assignedToId", "==", ctx.uid), where("status", "in", ["Open", "In progress"])),
      (s) => { this.data = docsOf(s); changed(); },
      (err) => { warnOff("Staff tasks", err); this.data = new Map(); changed(); });
  },
  items(now, ctx) {
    if (now.hm < "08:00") return [];
    const late = [...this.data.values()]
      .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate || "") && t.dueDate < now.day)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    if (!late.length) return [];
    if (late.length > 2) {
      return [{ key: `tk|all|${now.day}`, rank: 3, icon: "check", tone: "amber", href: "#/home",
        title: `${plural(late.length, "overdue task")}`, sub: `The oldest was due ${niceDay(late[0].dueDate)}. Open My dashboard → Tasks.` }];
    }
    return late.map((t) => {
      const d = daysBetween(t.dueDate, now.day);
      return {
        key: `tk|${t.id}|${now.day}`, rank: 3, icon: "check", tone: "amber", sort: t.dueDate,
        title: `Overdue: ${String(t.taskText || "Task").slice(0, 80)}`,
        sub: [`Due ${niceDay(t.dueDate)} · ${plural(d, "day")} overdue`, t.patientName].filter(Boolean).join(" · "),
        open: () => openTask(t.id, ctx),
      };
    });
  },
};

const SOURCES = [chats, prospects, recall, tasks];

async function openTask(id, ctx) {
  try {
    const { openTaskPanel } = await import("./task-panel.js");
    openTaskPanel(id, { staff: { uid: ctx.uid, name: ctx.name, role: ctx.role }, onChange: () => {} });
  } catch (err) {
    console.warn("Task panel not opened:", err);
    location.hash = "#/home";
  }
}
function warnOff(name, err) { console.warn(`Nudges: ${name} off:`, err && (err.code || err.message)); }

/* ===================== Showing them ===================== */

let started = false, ctx = null, live = [], box = null, shownSig = "", current = new Map(), expanded = false, timer = 0;

function startAll() {
  stopAll();
  if (!ctx) { draw([]); return; }
  live = SOURCES.map((src) => {
    let stop = null;
    try { stop = src.start(ctx, schedule); } catch (err) { warnOff("A source", err); }
    return { src, stop };
  });
}
function stopAll() {
  live.forEach((x) => { try { if (x.stop) x.stop(); } catch { /* already stopped */ } });
  live = [];
  prospects.data = new Map(); chats.mine = new Map(); chats.queue = new Map(); recall.data = new Map(); tasks.data = new Map();
}
function schedule() { clearTimeout(timer); timer = setTimeout(check, 60); }

function check() {
  if (!ctx) return;
  const now = perthNow();
  // A new day: the sources that read "today" start again
  live.forEach((x) => {
    if (x.src.day && x.src.day !== now.day) {
      try { if (x.stop) x.stop(); } catch { /* ignore */ }
      x.stop = x.src.start(ctx, schedule);
    }
  });
  const st = readJson(STATE_KEY);
  const here = location.hash;
  const all = [];
  live.forEach((x) => { try { all.push(...x.src.items(now, ctx)); } catch (err) { console.warn("Nudge source failed:", err); } });
  const due = all.filter((it) => {
    if (it.page && here === it.page) { if (!isHidden(st[it.key])) setState(it.key, "closed"); return false; }   // already looking at it
    return !isHidden(st[it.key]);
  }).sort((a, b) => a.rank - b.rank || String(a.sort || "").localeCompare(String(b.sort || "")));
  draw(due, now);
  notify(due);
}

const desktopPref = () => {
  const p = localStorage.getItem(PREF_KEY);
  if (p) return p;
  return "Notification" in window && Notification.permission === "granted" ? "on" : "";
};
const canOffer = () => "Notification" in window && window.isSecureContext && Notification.permission === "default" && !desktopPref();

function draw(due, now = perthNow()) {
  const offer = due.length > 0 && canOffer();
  const sig = `${due.map((i) => `${i.key}~${i.sub}`).join(",")}|${expanded}|${offer}`;
  if (sig === shownSig) return;
  const before = new Set(current.keys());
  shownSig = sig;
  current = new Map(due.map((i) => [i.key, i]));
  if (!box) {
    box = document.createElement("div");
    box.className = "pn-stack";
    box.setAttribute("aria-live", "polite");
    box.addEventListener("click", onClick);
    document.body.appendChild(box);
  }
  const shown = expanded ? due.slice(0, 8) : due.slice(0, MAX_SHOWN);
  const more = due.length - shown.length;
  box.innerHTML = shown.map((it) => `
    <div class="pn is-${it.tone}${before.has(it.key) ? "" : " is-new"}" data-k="${esc(it.key)}">
      <button type="button" class="pn-main" data-act="open">
        <span class="pn-ic">${ICONS[it.icon] || ICONS.bell}</span>
        <span class="pn-txt"><strong>${esc(it.title)}</strong>
          ${it.sub ? `<small>${esc(it.sub)}</small>` : ""}
          ${it.note ? `<small class="pn-note">“${esc(it.note)}”</small>` : ""}</span>
      </button>
      <div class="pn-acts"><button type="button" data-act="snooze">Snooze 10 min</button></div>
      <button type="button" class="pn-x" data-act="close" aria-label="Close">×</button>
    </div>`).join("")
    + (more > 0 ? `<button type="button" class="pn-more" data-act="more">+${more} more</button>`
      : expanded && due.length > MAX_SHOWN ? '<button type="button" class="pn-more" data-act="more">Show fewer</button>' : "")
    + (offer ? `<div class="pn pn-offer">
        <div class="pn-main"><span class="pn-ic">${ICONS.bell}</span>
          <span class="pn-txt"><strong>Get these when the portal is in the background?</strong>
            <small>A pop-up from your computer, even when you're in another tab or app.</small></span></div>
        <div class="pn-acts"><button type="button" data-act="desk-no">Not now</button>
          <button type="button" class="is-primary" data-act="desk-yes">Turn on</button></div>
      </div>` : "");
}

function openItem(it) {
  setState(it.key, "closed");
  if (it.open) it.open(); else if (it.href) location.hash = it.href;
  schedule();
}

function onClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "more") { expanded = !expanded; check(); return; }
  if (act === "desk-yes") { setDesktopAlerts(true); return; }
  if (act === "desk-no") { localStorage.setItem(PREF_KEY, "off"); shownSig = ""; check(); return; }
  const card = e.target.closest(".pn");
  const it = card && current.get(card.dataset.k);
  if (!it) return;
  if (act === "open") { openItem(it); return; }
  if (act === "close") setState(it.key, "closed");
  if (act === "snooze") {
    setState(it.key, Date.now() + SNOOZE_MS);
    const sent = readJson(SENT_KEY); delete sent[it.key]; writeJson(SENT_KEY, sent);   // alerts again when it comes back
  }
  card.classList.add("is-out");
  setTimeout(check, 180);
}

/* ===================== Desktop alerts ===================== */

const ICON = (document.querySelector('link[rel~="icon"]') || {}).href || "";

// New things that arrive while the portal is in the background pop up as a computer notification
function notify(due) {
  const sent = readJson(SENT_KEY);
  const fresh = due.filter((it) => !sent[it.key]);
  if (!fresh.length) return;
  fresh.forEach((it) => { sent[it.key] = Date.now(); });
  writeJson(SENT_KEY, sent);   // shared by every open tab, so only one of them alerts
  const away = document.hidden || !document.hasFocus();
  if (!away || desktopPref() !== "on" || !("Notification" in window) || Notification.permission !== "granted") return;
  fresh.slice(0, 3).forEach((it) => {
    try {
      const n = new Notification(it.title, { body: [it.sub, it.note && `“${it.note}”`].filter(Boolean).join("\n"), tag: it.key, icon: ICON });
      n.onclick = () => { window.focus(); n.close(); openItem(it); };
    } catch (err) { console.warn("Desktop alert failed:", err); }
  });
}

// Turn desktop alerts on (asks the browser once) or off. Can be called from a settings toggle too.
export async function setDesktopAlerts(on) {
  if (!on) { localStorage.setItem(PREF_KEY, "off"); shownSig = ""; check(); return false; }
  if (!("Notification" in window)) return false;
  let p = Notification.permission;
  if (p === "default") { try { p = await Notification.requestPermission(); } catch { p = "denied"; } }
  localStorage.setItem(PREF_KEY, p === "granted" ? "on" : "off");
  if (p === "granted") {
    try { new Notification("Desktop alerts are on", { body: "You'll get these when the portal is in the background.", icon: ICON }); } catch { /* fine */ }
  }
  shownSig = "";
  check();
  return p === "granted";
}
export const desktopAlertsOn = () => desktopPref() === "on" && "Notification" in window && Notification.permission === "granted";

/* ===================== Start ===================== */

// Call once when the portal starts. It follows logging in and out by itself.
export function startNudges() {
  if (started) return;
  started = true;
  onAuthStateChanged(auth, async (user) => {
    if ((user && user.uid) === (ctx && ctx.uid)) return;
    if (!user) { ctx = null; stopAll(); draw([]); return; }
    let claims = {};
    try { claims = (await user.getIdTokenResult()).claims || {}; } catch { /* not essential */ }
    ctx = { uid: user.uid, name: String(claims.staffName || ""), role: String(claims.staffRole || ""),
      admin: /^admin$/i.test(String(claims.staffRole || "")) };
    shownSig = "";
    startAll();
  });
  setInterval(check, 30000);
  window.addEventListener("hashchange", schedule);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
}