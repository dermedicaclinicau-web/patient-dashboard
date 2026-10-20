// The chat bubble (bottom-right on every page): Help to the admins, messages between staff, and group chats.
// A new message: a chime, a pop-up, a red badge, "(2)" in the tab title, and a desktop alert when the portal is in the background.
// Your own messages can be edited or deleted; any chat can be removed from your own list.
import { fetchStaffList } from "./task-types.js";
import { isAdmin } from "./perms.js";
import { confirmDialog } from "./dialog.js";
import { escapeHtml, getInitials, hueFromString, showToast } from "./utils.js";
import {
  watchChats, watchMessages, sendMessage, markRead, setChatStatus, listAllChats, isUnread, isHiddenFor, helpId, dmId,
  newGroupId, watchAway, saveAway, editMessage, deleteMessage, hideChat, newMessageId,
} from "./chat-api.js";

const HELP_NAME = "Bethany";   // who answers Help
const esc = (s) => escapeHtml(String(s ?? ""));
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  back: svg('<polyline points="15 18 9 12 15 6"/>'),
  send: svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  bell: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  bellOff: svg('<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  group: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  moon: svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  smile: svg('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
};

// The emoji panel in the message box
const EMOJI = ["😀", "😂", "😊", "😍", "🥰", "😉", "😎", "🤔", "😅", "😢", "😮", "😴", "🙏", "👍", "👎", "👏",
  "🙌", "💪", "👋", "🤞", "🎉", "❤️", "💯", "✅", "❌", "⭐", "🔥", "☕", "🍰", "🌸", "📅", "⏰"];
// "👍" or "🎉🎉": shown large, without the bubble
const onlyEmoji = (s) => s.length <= 12 && /\p{Extended_Pictographic}/u.test(s)
  && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u.test(s);

const when = (d) => {
  if (!d) return "";
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return keyOf(d); };
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); return keyOf(d); };
const niceBack = (k) => {
  if (k === dayFromNow(1)) return "tomorrow";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" }) : "";
};

// "Today", "Yesterday", "Mon 12 Oct" (and the year if it isn't this year)
const dayLabel = (d) => {
  const k = keyOf(d);
  if (k === keyOf(new Date())) return "Today";
  if (k === dayFromNow(-1)) return "Yesterday";
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};
const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
// Phones and iPads: Enter makes a new line, the Send button sends
const isTouch = () => !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
// One tap for you on Help. The last one also marks it as sorted.
const QUICK_REPLIES = ["On my way", "Looking into it now", "Can you call me?", "All sorted ✓"];
// kind: "help" | "group" | "" (a person)
const avatar = (name, kind = "") => (kind === "help" ? `<span class="ch-av is-help">${I.help}</span>`
  : kind === "group" ? `<span class="ch-av is-group">${I.group}</span>`
  : `<span class="ch-av" style="--h:${hueFromString(name || "?")}">${esc(getInitials(name || "?"))}</span>`);

let me = null;
let admin = false;
let root = null;
let panel = null;
let unsub = null;
let msgUnsub = null;
let awayUnsub = null;
let away = { on: false, back: "", note: "" };
let chats = [];              // every conversation I can see, live
let allChats = null;         // Admins: every conversation, loaded on demand
let staffList = null;
let staffById = new Map();
const drafts = new Map();    // conversations not created yet (no message sent)
const pendingSends = new Map();   // message id → { chatId, text, page, at, failed, sent }: shown before it's saved
const lastSeen = new Map();  // chat id → the last message time already known (for the chime)
const groupSel = new Set();  // people ticked for a new group
let loaded = false;
let startedAt = 0;
let view = "list";           // list | thread | new | group | all | away
let openId = "";
let current = null;
let canWriteNow = false;     // the open conversation can be written in
let msgList = [];            // the open conversation's messages
let editing = "";            // the id of my message being edited
let audio = null;
let popTimer = null;
let baseTitle = "";
let pendingOpen = "";        // a conversation to open from a link (e.g. the reminder email)

/* ---------- Start and stop ---------- */

export function initChat(staff) {
  if (!staff) return;
  if (me && me.uid === staff.uid) { me = staff; admin = isAdmin(); return; }
  teardownChat();
  me = staff;
  admin = isAdmin();
  baseTitle = document.title.replace(/^\(\d+\)\s*/, "");
  startedAt = Date.now();
  drafts.set(helpId(me.uid), { id: helpId(me.uid), kind: "help", members: [me.uid], names: {}, status: "open", readAt: {}, hiddenAt: {}, lastAt: null });
  build();
  unsub = watchChats(me.uid, admin, onChats, (err) => console.warn("Chat failed to load:", err));
  awayUnsub = watchAway((a) => { away = a; render(); });
  loadStaff().then(render);
  checkChatLink();
}

export function teardownChat() {
  if (unsub) unsub();
  if (awayUnsub) awayUnsub();
  stopMessages();
  unsub = awayUnsub = null;
  if (root) root.remove();
  root = panel = null;
  me = null;
  chats = [];
  allChats = null;
  drafts.clear();
  pendingSends.clear();
  lastSeen.clear();
  groupSel.clear();
  loaded = false;
  view = "list";
  openId = "";
  current = null;
  msgList = [];
  editing = "";
  document.removeEventListener("pointerdown", unlockAudio);
  document.removeEventListener("visibilitychange", readIfViewing);
  window.removeEventListener("hashchange", checkChatLink);
  pendingOpen = "";
  if (baseTitle) document.title = baseTitle;
}

async function loadStaff() {
  if (staffList) return staffList;
  try {
    staffList = ((await fetchStaffList()) || []).filter((s) => s && s.id && s.active !== false);
    staffById = new Map(staffList.map((s) => [String(s.id), s]));
  } catch (err) {
    console.warn("Chat staff list failed:", err);
  }
  return staffList;
}

function build() {
  root = document.createElement("div");
  root.className = "ch";
  root.innerHTML = `
    <div class="ch-pop" data-role="pop" hidden></div>
    <section class="ch-panel" data-role="panel" aria-label="Chat" hidden></section>
    <button type="button" class="ch-bubble" data-act="toggle" aria-label="Open chat">${I.chat}<span class="ch-badge" data-role="badge" hidden></span></button>`;
  document.body.appendChild(root);
  panel = root.querySelector('[data-role="panel"]');
  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("keydown", onKey);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  document.addEventListener("pointerdown", unlockAudio);        // browsers only allow sound after a click
  document.addEventListener("visibilitychange", readIfViewing);
  window.addEventListener("hashchange", checkChatLink);
}

// "#/home/chat/<id>" (the button in the reminder email): open that conversation once it has loaded
function checkChatLink() {
  const m = /^#\/home\/chat\/([A-Za-z0-9_-]{3,120})$/.exec(location.hash || "");
  if (!m || !me) return;
  pendingOpen = m[1];
  history.replaceState(null, "", "#/home");
  openPending();
}
function openPending() {
  if (!pendingOpen || !root) return;
  if (!chats.some((c) => c.id === pendingOpen)) return;   // not loaded yet: tried again on the next update
  const id = pendingOpen;
  pendingOpen = "";
  openThread(id);
}

/* ---------- Live updates ---------- */

function onChats(list) {
  if (!me) return;
  const fresh = [];
  list.forEach((c) => {
    const t = c.lastAt ? c.lastAt.getTime() : 0;
    const prev = lastSeen.get(c.id);
    const isNew = prev !== undefined ? t > prev : loaded && t > startedAt;
    if (isNew && isUnread(c, me.uid)) fresh.push(c);
    lastSeen.set(c.id, t);
  });
  chats = list.sort((a, b) => (b.lastAt ? b.lastAt.getTime() : 0) - (a.lastAt ? a.lastAt.getTime() : 0));
  loaded = true;
  fresh.forEach(notify);
  render();
  readIfViewing();
  openPending();
}

const chatFor = (id) => chats.find((c) => c.id === id) || (allChats || []).find((c) => c.id === id) || drafts.get(id) || null;
const isOpen = () => !!panel && !panel.hidden;
// My list: my conversations (Admins: plus Help), minus any I removed that have nothing new
const myChats = () => chats.filter((c) => (c.members.includes(me.uid) || (admin && c.kind === "help")) && !isHiddenFor(c, me.uid));
const muteKey = () => `chat:mute:${me.uid}`;
const muted = () => { try { return localStorage.getItem(muteKey()) === "1"; } catch { return false; } };
const nameOf = (c, u) => (c.names && c.names[u]) || (staffById.get(u) || {}).name || "Staff";
const awayOn = () => !!(away && away.on && (!away.back || away.back > keyOf(new Date())));
const helpSub = () => (awayOn()
  ? `${HELP_NAME} is away${away.back ? ` · back ${niceBack(away.back)}` : ""}${away.note ? ` · ${away.note}` : ""}`
  : "Usually replies within a few hours");

function titleOf(c) {
  if (c.kind === "help") return c.members[0] === me.uid ? `${HELP_NAME} (Help)` : `${nameOf(c, c.members[0])} · Help`;
  if (c.kind === "group") return c.name || "Group";
  if (!c.members.includes(me.uid)) return c.members.map((u) => nameOf(c, u)).join(" ↔ ");
  return nameOf(c, c.members.find((u) => u !== me.uid) || me.uid);
}
// "You, Ana, Jacquie +3"
function membersText(c) {
  const others = c.members.filter((u) => u !== me.uid).map((u) => nameOf(c, u).split(/\s+/)[0]);
  const shown = others.slice(0, 3).join(", ");
  return `${c.members.includes(me.uid) ? "You, " : ""}${shown}${others.length > 3 ? ` +${others.length - 3}` : ""}`;
}
const kindOf = (c) => (c.kind === "help" && c.members[0] === me.uid ? "help" : c.kind === "group" ? "group" : "");

function render() {
  if (!root || !me) return;
  syncBadge();
  if (!isOpen()) return;
  if (view === "list") drawList();
  else if (view === "thread") {
    current = chatFor(openId) || current;
    const sb = panel.querySelector('[data-act="sorted"]');
    if (sb && current) sb.textContent = current.status === "sorted" ? "Reopen" : "Mark as sorted";
    const hs = panel.querySelector('[data-role="helpsub"]');
    if (hs) { hs.textContent = helpSub(); hs.classList.toggle("is-away", awayOn()); }
    updateSeen();
  }
}

function syncBadge() {
  const n = myChats().filter((c) => isUnread(c, me.uid)).length;
  const badge = root.querySelector('[data-role="badge"]');
  badge.textContent = n > 9 ? "9+" : String(n);
  badge.hidden = !n;
  document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
}

// The conversation on screen is read as soon as it's seen
function readIfViewing() {
  if (!me || !isOpen() || view !== "thread" || document.hidden) return;
  const c = chats.find((x) => x.id === openId);
  if (c && isUnread(c, me.uid) && (c.members.includes(me.uid) || (admin && c.kind === "help"))) {
    markRead(c.id).catch((err) => console.warn("Mark read failed:", err));
  }
}

/* ---------- New message: chime, pop-up, desktop alert ---------- */

function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { /* no sound on this device */ }
}

function chime() {
  try {
    unlockAudio();
    if (!audio) return;
    const t = audio.currentTime;
    [[880, 0], [1320, 0.13]].forEach(([f, d]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.2, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.4);
      o.connect(g).connect(audio.destination);
      o.start(t + d);
      o.stop(t + d + 0.45);
    });
  } catch { /* ignore */ }
}

const fromText = (c) => (c.kind === "group" ? `${c.lastByName || "Someone"} in ${c.name || "a group"}` : c.lastByName || titleOf(c));

function notify(c) {
  if (isOpen() && view === "thread" && openId === c.id && !document.hidden) return;   // already looking at it
  if (!muted()) chime();
  popup(c);
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(fromText(c), { body: c.lastText, tag: c.id });
      n.onclick = () => { window.focus(); openThread(c.id); n.close(); };
    } catch { /* ignore */ }
  }
}

function popup(c) {
  const pop = root.querySelector('[data-role="pop"]');
  pop.innerHTML = `<button type="button" class="ch-pop-in" data-open="${esc(c.id)}">${avatar(c.lastByName, c.kind === "group" ? "group" : "")}
      <span><strong>${esc(fromText(c))}</strong><small>${esc(c.lastText)}</small></span></button>
    <button type="button" class="ch-ic" data-act="popx" aria-label="Dismiss">${I.x}</button>`;
  pop.hidden = false;
  clearTimeout(popTimer);
  popTimer = setTimeout(() => { pop.hidden = true; }, 8000);
}
const hidePop = () => { const pop = root && root.querySelector('[data-role="pop"]'); if (pop) pop.hidden = true; };

/* ---------- The panel ---------- */

function showPanel() {
  panel.hidden = false;
  root.classList.add("is-open");
  hidePop();
}
function hidePanel() {
  panel.hidden = true;
  root.classList.remove("is-open");
  stopMessages();
  view = "list";
  editing = "";
}
function stopMessages() { if (msgUnsub) msgUnsub(); msgUnsub = null; }

const head = (title, { back = false, extra = "" } = {}) => `<header class="ch-hd">
    ${back ? `<button type="button" class="ch-ic" data-act="back" aria-label="Back">${I.back}</button>` : ""}
    ${title}<span class="ch-sp"></span>${extra}
    <button type="button" class="ch-ic" data-act="close" aria-label="Close">${I.x}</button></header>`;

const row = (c) => {
  const unread = isUnread(c, me.uid);
  const helpRow = c.kind === "help" && c.members[0] === me.uid;
  const empty = helpRow ? (awayOn() ? helpSub() : "Ask anything about the portal") : c.kind === "group" ? membersText(c) : "";
  return `<button type="button" class="ch-row${unread ? " is-unread" : ""}" data-open="${esc(c.id)}">
    ${avatar(titleOf(c), kindOf(c))}
    <span class="ch-row-main">
      <span class="ch-row-top"><strong>${esc(titleOf(c))}</strong><small>${esc(when(c.lastAt))}</small></span>
      <small class="ch-row-last">${c.lastAt ? `${c.lastBy === me.uid ? "You: " : c.kind === "group" ? `${esc((c.lastByName || "").split(/\s+/)[0])}: ` : ""}${esc(c.lastText)}` : esc(empty)}</small>
      ${admin && c.kind === "help" && c.status === "sorted" ? '<span class="ch-tag">Sorted</span>' : ""}
    </span>${unread ? '<span class="ch-dot" aria-label="Unread"></span>' : ""}</button>`;
};

function drawList() {
  view = "list";
  editing = "";
  const list = myChats();
  const help = list.filter((c) => c.kind === "help" && c.members[0] !== me.uid)
    .sort((a, b) => (a.status === "sorted") - (b.status === "sorted"));
  const others = list.filter((c) => c.kind !== "help");
  const myHelp = admin ? null : chatFor(helpId(me.uid));
  const ask = "Notification" in window && Notification.permission === "default"
    ? `<button type="button" class="ch-ask" data-act="notify">${I.bell} Turn on desktop alerts</button>` : "";
  const awayBar = !admin ? "" : awayOn()
    ? `<div class="ch-away is-on"><span>${I.moon} You're shown as away${away.back ? ` · back ${esc(niceBack(away.back))}` : ""}</span>
        <button type="button" class="rc-link" data-act="awayoff">I'm back</button></div>`
    : `<div class="ch-away"><span>Staff see “Usually replies within a few hours”</span>
        <button type="button" class="rc-link" data-act="awayset">Set away</button></div>`;
  panel.innerHTML = `${head("<strong>Chats</strong>", {
      extra: `<button type="button" class="ch-ic" data-act="mute" aria-label="${muted() ? "Turn sound on" : "Mute sound"}"
        title="${muted() ? "Sound is off" : "Sound is on"}">${muted() ? I.bellOff : I.bell}</button>` })}
    ${awayBar}${ask}
    <div class="ch-list">
      ${myHelp ? row(myHelp) : ""}
      ${admin ? `<p class="ch-sec">Help inbox</p>${help.map(row).join("") || '<p class="ch-none">No help requests.</p>'}` : ""}
      <p class="ch-sec">Your chats</p>
      ${others.map(row).join("") || '<p class="ch-none">No chats yet. Start one with New message.</p>'}
    </div>
    <footer class="ch-ft">
      <button type="button" class="lh-btn is-primary" data-act="new">${I.plus}<span>New message</span></button>
      ${admin ? '<button type="button" class="lh-btn" data-act="all">All staff chats</button>' : ""}
    </footer>
    <p class="ch-note"></p>`;
}

function openThread(id) {
  const c = chatFor(id);
  if (!c || !me) return;
  if (!isOpen()) showPanel();
  view = "thread";
  openId = id;
  current = c;
  msgList = [];
  editing = "";
  const isMember = c.members.includes(me.uid);
  const canWrite = isMember || (admin && c.kind === "help");
  canWriteNow = canWrite;
  const helpStaff = c.kind === "help" && c.members[0] === me.uid;
  const adminHelp = admin && c.kind === "help" && !helpStaff;
  // Remove from my list: saved conversations I'm part of (not my own Help chat, which is always there)
  const canHide = !helpStaff && (isMember || adminHelp) && chats.some((x) => x.id === id);
  const sub = helpStaff ? `<small data-role="helpsub" class="${awayOn() ? "is-away" : ""}">${esc(helpSub())}</small>`
    : c.kind === "group" ? `<small>${esc(membersText(c))}</small>` : "";
  panel.innerHTML = `${head(`${avatar(titleOf(c), kindOf(c))}<span class="ch-hd-t"><strong>${esc(titleOf(c))}</strong>${sub}</span>`, {
      back: true,
      extra: `${adminHelp ? `<button type="button" class="lh-btn" data-act="sorted">${c.status === "sorted" ? "Reopen" : "Mark as sorted"}</button>` : ""}${
        canHide ? `<button type="button" class="ch-ic" data-act="hide" aria-label="Remove from my list" title="Remove from my list">${I.trash}</button>` : ""}`,
    })}
    <div class="ch-msgs" data-role="msgs"><p class="ch-empty">${helpStaff
      ? "Ask anything about the portal. Bethany will get back to you."
      : c.kind === "group" ? "Say hello to start the group." : "No messages yet."}</p></div>
    ${canWrite ? `<div class="ch-editing" data-role="editing" hidden><span>Editing your message</span>
        <button type="button" class="rc-link" data-act="canceledit">Cancel</button></div>
      ${adminHelp ? `<div class="ch-replies">${QUICK_REPLIES.map((q) =>
        `<button type="button" class="ch-chip" data-reply="${esc(q)}">${esc(q)}</button>`).join("")}</div>` : ""}
      <form class="ch-comp" novalidate>
        <div class="ch-emo" data-role="emo" hidden>${EMOJI.map((x) => `<button type="button" data-emo="${x}">${x}</button>`).join("")}</div>
        <button type="button" class="ch-ic ch-emo-btn" data-act="emoji" aria-label="Add emoji" title="Emoji">${I.smile}</button>
        <textarea rows="1" maxlength="4000" placeholder="${isTouch() ? "Type your message" : "Type your message (Shift+Enter for a new line)"}" aria-label="Message"></textarea>
        <button type="submit" class="ch-send" aria-label="Send">${I.send}</button></form>
      <label class="ch-link"><input type="checkbox" data-role="withpage"${helpStaff ? " checked" : ""} /> Include a link to this page</label>`
      : '<p class="ch-ro">You\'re viewing a chat between staff. Only they can reply.</p>'}`;
  stopMessages();
  if (chats.some((x) => x.id === id) || (allChats || []).some((x) => x.id === id)) startMessages(id);
  readIfViewing();
  const ta = panel.querySelector("textarea");
  if (ta && !isTouch()) setTimeout(() => ta.focus(), 30);
}

function startMessages(id) {
  stopMessages();
  let first = true;
  msgUnsub = watchMessages(id, (msgs) => { drawMessages(msgs, first); first = false; },
    (err) => console.warn("Chat messages failed:", err));
}

function drawMessages(msgs, first) {
  const box = panel && panel.querySelector('[data-role="msgs"]');
  if (!box || view !== "thread") return;
  msgList = msgs;
  // Messages still on their way: shown until the saved copy arrives
  const ids = new Set(msgs.map((m) => m.id));
  const local = [];
  pendingSends.forEach((p, id) => {
    if (ids.has(id)) { if (p.sent) pendingSends.delete(id); return; }
    if (p.chatId !== openId) return;
    local.push({ id, text: p.text, by: me.name, byUid: me.uid, at: p.at, page: p.page,
      local: true, failed: p.failed, pending: !p.failed && !p.sent });
  });
  const all = msgs.concat(local);
  if (!all.length) return;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  let prevDay = "";
  let prev = null;
  box.innerHTML = all.map((m) => {
    const mine = m.byUid === me.uid;
    const day = m.at ? keyOf(m.at) : prevDay;
    const divider = day && day !== prevDay ? `<p class="ch-day"><span>${esc(dayLabel(m.at))}</span></p>` : "";
    // Several in a row from the same person, within 5 minutes: one name above them
    const run = !divider && prev && prev.byUid === m.byUid && m.at && prev.at && m.at - prev.at < 5 * 60000;
    prevDay = day;
    prev = m;
    const canAct = mine && canWriteNow && !m.deleted && !m.local;
    const text = String(m.text || "").trim();
    const bubble = m.deleted
      ? '<div class="ch-m-b is-deleted">Message deleted</div>'
      : `<div class="ch-m-b${onlyEmoji(text) ? " is-emoji" : ""}"${canAct
        ? ` data-mine="${esc(m.id)}" role="button" tabindex="0" title="Tap to edit or delete"` : ""}>${esc(m.text)}</div>`;
    const acts = canAct ? `<span class="ch-m-acts" hidden>
        <button type="button" data-act="medit" data-mid="${esc(m.id)}">Edit</button>
        <button type="button" class="is-danger" data-act="mdel" data-mid="${esc(m.id)}">Delete</button></span>` : "";
    const status = m.failed
      ? `<button type="button" class="ch-m-retry" data-act="retry" data-mid="${esc(m.id)}">Not sent · Tap to retry</button>
         · <button type="button" class="ch-m-retry" data-act="discard" data-mid="${esc(m.id)}">Remove</button>`
      : m.pending ? "Sending…" : esc(timeOf(m.at));
    return `${divider}<div class="ch-m${mine ? " is-me" : ""}${run ? " is-run" : ""}${m.pending ? " is-pending" : ""}${m.failed ? " is-failed" : ""}">
      ${mine || run ? "" : `<small class="ch-m-by">${esc(m.by)}</small>`}
      ${bubble}${acts}
      <small class="ch-m-meta">${m.page && !m.deleted ? `<a href="${esc(m.page.hash)}">${I.link} ${esc(m.page.label || "Page")}</a> · ` : ""}${status}${m.edited && !m.deleted ? " · edited" : ""}</small>
    </div>`;
  }).join("") + '<p class="ch-seen" data-role="seen" hidden></p>';
  updateSeen();
  if (first || atBottom) box.scrollTop = box.scrollHeight;
}

const redrawMessages = (toBottom = false) => { if (view === "thread") drawMessages(msgList, toBottom); };

// "Seen" under my last message, once someone else has read it
function seenText() {
  if (!current || !me) return "";
  const last = [...msgList].reverse().find((m) => !m.deleted);
  if (!last || last.byUid !== me.uid || !last.at || last.pending) return "";
  if ([...pendingSends.values()].some((p) => p.chatId === current.id && !p.sent)) return "";
  const read = current.readAt || {};
  const pool = current.kind === "help" ? Object.keys(read) : current.members;
  const who = pool.filter((u) => u !== me.uid && read[u] && read[u] >= last.at)
    .map((u) => nameOf(current, u).split(/\s+/)[0]);
  if (!who.length) return "";
  if (current.kind === "dm") return "Seen";
  return `Seen by ${who.slice(0, 3).join(", ")}${who.length > 3 ? ` +${who.length - 3}` : ""}`;
}
function updateSeen() {
  const el = panel && panel.querySelector('[data-role="seen"]');
  if (!el) return;
  const t = seenText();
  el.textContent = t;
  el.hidden = !t;
}

// Where they are now, so the other person can go straight there
function pageInfo() {
  const h = document.querySelector("#content .pb-name, #content h2");
  const nav = document.querySelector(".nav-item.active span");
  const label = (h && h.textContent.trim()) || (nav && nav.textContent.trim()) || "Portal";
  return { hash: location.hash || "#/home", label };
}

const isLastMsg = (id) => msgList.length > 0 && msgList[msgList.length - 1].id === id;

function sendErr(err) {
  return err && err.code === "permission-denied"
    ? "Couldn't save. Check the chats Firestore rule has been published."
    : err && err.message && !err.code ? err.message : "Couldn't send. Check your connection and try again.";
}

async function send(form) {
  if (!current) return;
  const ta = form.querySelector("textarea");
  const text = ta.value.trim();
  if (!text) return;
  hideEmoji();
  if (editing) {
    // Saving an edit to one of my messages
    const btn = form.querySelector('[type="submit"]');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const id = editing;
      const old = msgList.find((x) => x.id === id);
      if (!old || old.deleted) throw new Error("That message can't be edited any more.");
      if (old.text !== text) await editMessage(current.id, id, text, isLastMsg(id));
      stopEdit();
    } catch (err) {
      console.error("Chat edit failed:", err);
      showToast(sendErr(err));
    }
    btn.disabled = false;
    ta.focus();
    return;
  }
  // A new message: on screen straight away, saved in the background
  const withPage = !!(panel.querySelector('[data-role="withpage"]') || {}).checked;
  ta.value = "";
  ta.style.height = "";
  ta.focus();
  deliver(current, newMessageId(current.id), text, withPage ? pageInfo() : null);
}

async function deliver(chat, id, text, page) {
  pendingSends.set(id, { chatId: chat.id, text, page, at: new Date(), failed: false, sent: false });
  if (openId === chat.id) redrawMessages(true);
  try {
    await sendMessage(chat, text, page, me, id);
    const p = pendingSends.get(id);
    if (p) p.sent = true;
    // A brand-new chat: start listening now it exists
    if (view === "thread" && openId === chat.id && !msgUnsub) startMessages(chat.id);
  } catch (err) {
    console.error("Chat send failed:", err);
    const p = pendingSends.get(id);
    if (p) p.failed = true;
    showToast(sendErr(err));
  }
  if (openId === chat.id) redrawMessages();
}

// Admins on Help: one-tap replies
function quickReply(text) {
  if (!current) return;
  deliver(current, newMessageId(current.id), text, null);
  if (text === "All sorted ✓" && current.status !== "sorted") {
    setChatStatus(current.id, "sorted").catch((err) => console.warn("Mark sorted failed:", err));
  }
}
/* ---------- My own messages: edit and delete ---------- */

// Tapping one of my messages shows Edit / Delete under it
function toggleMsgActs(bubble) {
  const acts = bubble.parentElement && bubble.parentElement.querySelector(".ch-m-acts");
  if (!acts) return;
  const show = acts.hidden;
  panel.querySelectorAll(".ch-m-acts").forEach((a) => { a.hidden = true; });
  acts.hidden = !show;
}

function startEdit(mid) {
  const m = msgList.find((x) => x.id === mid);
  const ta = panel.querySelector(".ch-comp textarea");
  const bar = panel.querySelector('[data-role="editing"]');
  if (!m || m.deleted || !ta || !bar) return;
  editing = mid;
  bar.hidden = false;
  ta.value = m.text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));   // grows the box to fit
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  panel.querySelectorAll(".ch-m-acts").forEach((a) => { a.hidden = true; });
}

function stopEdit() {
  editing = "";
  const bar = panel && panel.querySelector('[data-role="editing"]');
  if (bar) bar.hidden = true;
  const ta = panel && panel.querySelector(".ch-comp textarea");
  if (ta) { ta.value = ""; ta.style.height = ""; }
}

async function removeMsg(mid) {
  if (!current) return;
  const ok = await confirmDialog({
    title: "Delete this message?",
    message: "It's removed for everyone in this chat.",
    confirmLabel: "Delete",
    tone: "danger",
  });
  if (!ok) return;
  if (editing === mid) stopEdit();
  try {
    await deleteMessage(current.id, mid, isLastMsg(mid));
  } catch (err) {
    console.error("Delete message failed:", err);
    showToast(err && err.code === "permission-denied"
      ? "Couldn't delete. Check the chats Firestore rule has been published."
      : "Couldn't delete. Try again.");
  }
}

// Remove the open conversation from my list (others keep it)
async function hideThread() {
  if (!current) return;
  const ok = await confirmDialog({
    title: "Remove this chat from your list?",
    message: "Only your list changes. Everyone else keeps the chat, and it comes back here if someone sends a new message.",
    confirmLabel: "Remove",
    tone: "warning",
  });
  if (!ok) return;
  try {
    await hideChat(current.id);
    stopMessages();
    drawList();
    showToast("Chat removed from your list");
  } catch (err) {
    console.error("Remove chat failed:", err);
    showToast("Couldn't remove it. Try again.");
  }
}

/* ---------- Emoji ---------- */

function hideEmoji() {
  const emo = panel && panel.querySelector('[data-role="emo"]');
  if (emo) emo.hidden = true;
}

function toggleEmoji() {
  const emo = panel && panel.querySelector('[data-role="emo"]');
  if (emo) emo.hidden = !emo.hidden;
}

// Puts the emoji where the cursor is (or replaces the selected text)
function insertEmoji(ch) {
  const ta = panel && panel.querySelector(".ch-comp textarea");
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + ch + ta.value.slice(end);
  const pos = start + ch.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event("input", { bubbles: true }));   // grows the box if needed
}

/* ---------- New message (one person) ---------- */

async function drawNew() {
  view = "new";
  panel.innerHTML = `${head("<strong>New message</strong>", { back: true })}
    <div class="ch-find">
      <button type="button" class="lh-btn ch-newgroup" data-act="group">${I.group}<span>New group</span></button>
      <input type="search" class="fe-input" data-role="find" placeholder="Search staff" aria-label="Search staff" />
    </div>
    <div class="ch-list" data-role="people"><p class="ch-none">Loading staff…</p></div>`;
  setTimeout(() => { const f = panel.querySelector('[data-role="find"]'); if (f) f.focus(); }, 30);
  await loadStaff();
  if (view === "new") drawPeople("");
}

function drawPeople(q) {
  const box = panel.querySelector('[data-role="people"]');
  if (!box) return;
  if (!staffList) { box.innerHTML = '<p class="ch-none">Couldn\'t load the staff list. Try again.</p>'; return; }
  const list = staffList.filter((s) => String(s.id) !== me.uid && (!q || String(s.name || "").toLowerCase().includes(q)));
  box.innerHTML = list.map((s) => `<button type="button" class="ch-row" data-dm="${esc(s.id)}">${avatar(s.name)}
      <span class="ch-row-main"><strong>${esc(s.name)}</strong><small class="ch-row-last">${esc(s.role || "")}</small></span></button>`).join("")
    || '<p class="ch-none">No one matches.</p>';
}

function startDm(otherUid) {
  const s = staffById.get(otherUid);
  const id = dmId(me.uid, otherUid);
  if (!chatFor(id)) {
    drafts.set(id, { id, kind: "dm", members: [me.uid, otherUid].sort(), names: { [otherUid]: (s && s.name) || "" },
      status: "open", readAt: {}, hiddenAt: {}, lastAt: null });
  }
  openThread(id);
}

/* ---------- New group ---------- */

async function drawGroup() {
  view = "group";
  groupSel.clear();
  panel.innerHTML = `${head("<strong>New group</strong>", { back: true })}
    <div class="ch-gform">
      <input class="fe-input" data-role="gname" maxlength="60" placeholder="Group name, e.g. Injectors" aria-label="Group name" />
      <div class="ch-quick" data-role="groles"></div>
      <input type="search" class="fe-input" data-role="gfind" placeholder="Search staff" aria-label="Search staff" />
    </div>
    <div class="ch-list" data-role="gpeople"><p class="ch-none">Loading staff…</p></div>
    <footer class="ch-ft"><button type="button" class="lh-btn is-primary" data-act="mkgroup">Create group</button></footer>`;
  setTimeout(() => { const f = panel.querySelector('[data-role="gname"]'); if (f) f.focus(); }, 30);
  await loadStaff();
  if (view !== "group") return;
  // Quick picks: injectors, and one chip per role
  const others = (staffList || []).filter((s) => String(s.id) !== me.uid);
  const roles = [...new Set(others.map((s) => String(s.role || "").trim()).filter(Boolean))].sort();
  const chips = [];
  if (others.some((s) => s.injector === true)) chips.push('<button type="button" class="ch-chip" data-pick="injector">Injectors</button>');
  roles.forEach((r) => chips.push(`<button type="button" class="ch-chip" data-pick="role:${esc(r)}">${esc(r)}</button>`));
  panel.querySelector('[data-role="groles"]').innerHTML = chips.join("");
  drawGroupPeople("");
}

function drawGroupPeople(q) {
  const box = panel.querySelector('[data-role="gpeople"]');
  if (!box) return;
  if (!staffList) { box.innerHTML = '<p class="ch-none">Couldn\'t load the staff list. Try again.</p>'; return; }
  const list = staffList.filter((s) => String(s.id) !== me.uid && (!q || String(s.name || "").toLowerCase().includes(q)));
  box.innerHTML = list.map((s) => `<label class="ch-row ch-pick">
      <input type="checkbox" data-gsel="${esc(s.id)}"${groupSel.has(String(s.id)) ? " checked" : ""} />${avatar(s.name)}
      <span class="ch-row-main"><strong>${esc(s.name)}</strong><small class="ch-row-last">${esc(s.role || "")}</small></span></label>`).join("")
    || '<p class="ch-none">No one matches.</p>';
  syncGroupCount();
}

function syncGroupCount() {
  const btn = panel.querySelector('[data-act="mkgroup"]');
  if (btn) btn.textContent = groupSel.size ? `Create group (${groupSel.size + 1} people)` : "Create group";
}

function pickMany(key) {
  const others = (staffList || []).filter((s) => String(s.id) !== me.uid);
  const ids = others.filter((s) => (key === "injector" ? s.injector === true
    : String(s.role || "").trim() === key.slice(5))).map((s) => String(s.id));
  const all = ids.length && ids.every((id) => groupSel.has(id));
  ids.forEach((id) => (all ? groupSel.delete(id) : groupSel.add(id)));   // tap again to remove them
  const q = (panel.querySelector('[data-role="gfind"]') || {}).value || "";
  drawGroupPeople(q.trim().toLowerCase());
}

function createGroup() {
  const name = ((panel.querySelector('[data-role="gname"]') || {}).value || "").trim();
  if (!name) { showToast("Give the group a name."); panel.querySelector('[data-role="gname"]').focus(); return; }
  if (!groupSel.size) { showToast("Tick at least one person to add."); return; }
  const members = [me.uid, ...groupSel];
  const names = { [me.uid]: me.name };
  groupSel.forEach((u) => { names[u] = (staffById.get(u) || {}).name || ""; });
  const id = newGroupId();
  drafts.set(id, { id, kind: "group", name: name.slice(0, 60), members, names, createdByUid: me.uid,
    status: "open", readAt: {}, hiddenAt: {}, lastAt: null });
  groupSel.clear();
  openThread(id);
}

/* ---------- Admins: all chats, and away ---------- */

async function drawAll() {
  view = "all";
  panel.innerHTML = `${head("<strong>All staff chats</strong>", { back: true })}
    <div class="ch-list" data-role="all"><p class="ch-none">Loading…</p></div>
    <p class="ch-note">Chats and groups between other staff. You can read them, but only they can reply.</p>`;
  try {
    allChats = (await listAllChats()).filter((c) => c.kind !== "help" && !c.members.includes(me.uid))
      .sort((a, b) => (b.lastAt ? b.lastAt.getTime() : 0) - (a.lastAt ? a.lastAt.getTime() : 0));
  } catch (err) {
    console.warn("All chats failed:", err);
    allChats = [];
  }
  const box = panel.querySelector('[data-role="all"]');
  if (box && view === "all") box.innerHTML = allChats.map(row).join("") || '<p class="ch-none">No chats between other staff yet.</p>';
}

function drawAway() {
  view = "away";
  const tomorrow = dayFromNow(1);
  panel.innerHTML = `${head("<strong>Set away</strong>", { back: true })}
    <form class="ch-awayform" data-role="awayform" novalidate>
      <p class="muted">Staff see this at the top of their Help chat. It turns itself off on the day you're back.</p>
      <div class="ch-quick">
        <button type="button" class="ch-chip" data-back="${tomorrow}">Back tomorrow</button>
        <button type="button" class="ch-chip" data-back="${nextMonday()}">Back Monday</button>
      </div>
      <label class="lh-field"><span class="lh-label">Back on</span>
        <input class="fe-input" type="date" name="back" min="${tomorrow}" value="${away.back > keyOf(new Date()) ? away.back : tomorrow}" /></label>
      <label class="lh-field"><span class="lh-label">Note (optional)</span>
        <input class="fe-input" name="note" maxlength="120" placeholder="Urgent? Ask Dr Teh" value="${esc(away.note || "")}" /></label>
      <button type="submit" class="lh-btn is-primary">Save</button>
    </form>`;
}

async function submitAway(form) {
  const back = form.elements.back.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(back) || back <= keyOf(new Date())) { showToast("Choose the day you're back (tomorrow or later)."); return; }
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  try {
    await saveAway({ on: true, back, note: form.elements.note.value }, me);
    showToast(`Staff now see you're away until ${niceBack(back)}`);
    drawList();
  } catch (err) {
    console.error("Save away failed:", err);
    showToast(err && err.code === "permission-denied" ? "Couldn't save. Check the app_settings Firestore rule." : "Couldn't save. Try again.");
    btn.disabled = false;
  }
}

/* ---------- Clicks, keys and typing ---------- */

async function onClick(e) {
  if (!e.target.closest('.ch-emo, [data-act="emoji"]')) hideEmoji();   // a tap anywhere else closes the emoji panel
  const t = e.target.closest("[data-act],[data-open],[data-dm],[data-pick],[data-back],[data-emo],[data-mine],[data-reply]");
  if (!t || !me) return;
  if (t.dataset.emo) { insertEmoji(t.dataset.emo); return; }
  if (t.dataset.open) { hidePop(); openThread(t.dataset.open); return; }
  if (t.dataset.dm) { startDm(t.dataset.dm); return; }
  if (t.dataset.pick) { pickMany(t.dataset.pick); return; }
  if (t.dataset.back) { const f = panel.querySelector('[name="back"]'); if (f) f.value = t.dataset.back; return; }
  if (t.dataset.mine) { toggleMsgActs(t); return; }
  switch (t.dataset.act) {
    case "toggle":
      if (isOpen()) hidePanel(); else { showPanel(); drawList(); }
      break;
    case "close": hidePanel(); break;
    case "back": stopMessages(); drawList(); break;
    case "new": drawNew(); break;
    case "group": drawGroup(); break;
    case "mkgroup": createGroup(); break;
    case "all": drawAll(); break;
    case "awayset": drawAway(); break;
    case "awayoff":
      try { await saveAway({ on: false }, me); showToast("Staff now see you're available"); }
      catch (err) { console.error("Save away failed:", err); showToast("Couldn't save. Try again."); }
      break;
    case "popx": hidePop(); break;
    case "emoji": toggleEmoji(); break;
    case "medit": startEdit(t.dataset.mid); break;
    case "mdel": removeMsg(t.dataset.mid); break;
    case "canceledit": stopEdit(); break;
    case "retry": {
      const p = pendingSends.get(t.dataset.mid);
      const chat = p && chatFor(p.chatId);
      if (chat) deliver(chat, t.dataset.mid, p.text, p.page);
      break;
    }
    case "discard": pendingSends.delete(t.dataset.mid); redrawMessages(); break;
    case "hide": hideThread(); break;
    case "mute":
      try { localStorage.setItem(muteKey(), muted() ? "0" : "1"); } catch { /* ignore */ }
      if (!muted()) chime();   // a sample of the sound when it's turned on
      drawList();
      break;
    case "notify":
      try { await Notification.requestPermission(); } catch { /* ignore */ }
      if (view === "list") drawList();
      break;
    case "sorted":
      if (!current) return;
      t.disabled = true;
      try {
        await setChatStatus(current.id, current.status === "sorted" ? "open" : "sorted");
        showToast(current.status === "sorted" ? "Reopened" : "Marked as sorted");
      } catch (err) {
        console.error("Chat status failed:", err);
        showToast("Couldn't save. Try again.");
      }
      t.disabled = false;
      break;
    default:
  }
}

function onSubmit(e) {
  e.preventDefault();
  if (e.target.matches(".ch-comp")) send(e.target);
  else if (e.target.dataset.role === "awayform") submitAway(e.target);
}

function onKey(e) {
  if (e.key === "Escape" && isOpen()) {
    const emo = panel.querySelector('[data-role="emo"]');
    if (emo && !emo.hidden) { emo.hidden = true; return; }
    if (editing) { stopEdit(); return; }
    hidePanel();
    root.querySelector(".ch-bubble").focus();
    return;
  }
  // Keyboard: Enter on one of my messages shows Edit / Delete
  if (e.key === "Enter" && e.target.matches("[data-mine]")) {
    e.preventDefault();
    toggleMsgActs(e.target);
    return;
  }
  // Enter sends, Shift + Enter starts a new line. On phones and iPads Enter is a new line (the Send button sends).
  // Not while a word is still being typed (predictive text, accents).
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch() && e.target.matches(".ch-comp textarea")) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
}

function onInput(e) {
  if (e.target.matches(".ch-comp textarea")) {
    e.target.style.height = "";
    e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
  } else if (e.target.dataset.role === "find") {
    drawPeople(e.target.value.trim().toLowerCase());
  } else if (e.target.dataset.role === "gfind") {
    drawGroupPeople(e.target.value.trim().toLowerCase());
  }
}

function onChange(e) {
  const id = e.target.dataset.gsel;
  if (!id) return;
  if (e.target.checked) groupSel.add(id); else groupSel.delete(id);
  syncGroupCount();
}