// The chat bubble (bottom-right on every page): Help to the admins, and messages between staff.
// A new message: a chime, a pop-up, a red badge, "(2)" in the tab title, and a desktop alert when the portal is in the background.
import { watchChats, watchMessages, sendMessage, markRead, setChatStatus, listAllChats, isUnread, helpId, dmId } from "./chat-api.js";
import { fetchStaffList } from "./task-types.js";
import { isAdmin } from "./perms.js";
import { escapeHtml, getInitials, hueFromString, showToast } from "./utils.js";

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
};
const when = (d) => {
  if (!d) return "";
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};
const avatar = (name, help = false) => (help
  ? `<span class="ch-av is-help">${I.help}</span>`
  : `<span class="ch-av" style="--h:${hueFromString(name || "?")}">${esc(getInitials(name || "?"))}</span>`);

let me = null;
let admin = false;
let root = null;
let panel = null;
let unsub = null;
let msgUnsub = null;
let chats = [];              // every conversation I can see, live
let allChats = null;         // Admins: every conversation, loaded on demand
let staffList = null;
let staffById = new Map();
const drafts = new Map();    // conversations not created yet (no message sent)
const lastSeen = new Map();  // chat id → the last message time already known (for the chime)
let loaded = false;
let startedAt = 0;
let view = "list";           // list | thread | new | all
let openId = "";
let current = null;
let audio = null;
let popTimer = null;
let baseTitle = "";

/* ---------- Start and stop ---------- */

export function initChat(staff) {
  if (!staff) return;
  if (me && me.uid === staff.uid) { me = staff; admin = isAdmin(); return; }
  teardownChat();
  me = staff;
  admin = isAdmin();
  baseTitle = document.title.replace(/^\(\d+\)\s*/, "");
  startedAt = Date.now();
  drafts.set(helpId(me.uid), { id: helpId(me.uid), kind: "help", members: [me.uid], names: {}, status: "open", readAt: {}, lastAt: null });
  build();
  unsub = watchChats(me.uid, admin, onChats, (err) => console.warn("Chat failed to load:", err));
  fetchStaffList().then((list) => {
    staffList = (list || []).filter((s) => s && s.id && s.active !== false);
    staffById = new Map(staffList.map((s) => [String(s.id), s]));
    render();
  }).catch((err) => console.warn("Chat staff list failed:", err));
}

export function teardownChat() {
  if (unsub) unsub();
  stopMessages();
  unsub = null;
  if (root) root.remove();
  root = panel = null;
  me = null;
  chats = [];
  allChats = null;
  drafts.clear();
  lastSeen.clear();
  loaded = false;
  view = "list";
  openId = "";
  current = null;
  document.removeEventListener("pointerdown", unlockAudio);
  document.removeEventListener("visibilitychange", readIfViewing);
  if (baseTitle) document.title = baseTitle;
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
  root.addEventListener("submit", (e) => { e.preventDefault(); send(e.target); });
  root.addEventListener("keydown", onKey);
  root.addEventListener("input", onInput);
  document.addEventListener("pointerdown", unlockAudio);        // browsers only allow sound after a click
  document.addEventListener("visibilitychange", readIfViewing);
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
}

const chatFor = (id) => chats.find((c) => c.id === id) || (allChats || []).find((c) => c.id === id) || drafts.get(id) || null;
const isOpen = () => !!panel && !panel.hidden;
const myChats = () => chats.filter((c) => c.members.includes(me.uid) || (admin && c.kind === "help"));
const muteKey = () => `chat:mute:${me.uid}`;
const muted = () => { try { return localStorage.getItem(muteKey()) === "1"; } catch { return false; } };
const nameOf = (c, u) => (c.names && c.names[u]) || (staffById.get(u) || {}).name || "Staff";

function titleOf(c) {
  if (c.kind === "help") return c.members[0] === me.uid ? `${HELP_NAME} (Help)` : `${nameOf(c, c.members[0])} · Help`;
  if (!c.members.includes(me.uid)) return c.members.map((u) => nameOf(c, u)).join(" ↔ ");
  return nameOf(c, c.members.find((u) => u !== me.uid) || me.uid);
}

function render() {
  if (!root || !me) return;
  syncBadge();
  if (!isOpen()) return;
  if (view === "list") drawList();
  else if (view === "thread") {
    current = chatFor(openId) || current;
    const sb = panel.querySelector('[data-act="sorted"]');
    if (sb && current) sb.textContent = current.status === "sorted" ? "Reopen" : "Mark as sorted";
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

function notify(c) {
  if (isOpen() && view === "thread" && openId === c.id && !document.hidden) return;   // already looking at it
  if (!muted()) chime();
  popup(c);
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(c.lastByName || "New message", { body: c.lastText, tag: c.id });
      n.onclick = () => { window.focus(); openThread(c.id); n.close(); };
    } catch { /* ignore */ }
  }
}

function popup(c) {
  const pop = root.querySelector('[data-role="pop"]');
  pop.innerHTML = `<button type="button" class="ch-pop-in" data-open="${esc(c.id)}">${avatar(c.lastByName)}
      <span><strong>${esc(c.lastByName || titleOf(c))}</strong><small>${esc(c.lastText)}</small></span></button>
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
}
function stopMessages() { if (msgUnsub) msgUnsub(); msgUnsub = null; }

const head = (title, { back = false, extra = "" } = {}) => `<header class="ch-hd">
    ${back ? `<button type="button" class="ch-ic" data-act="back" aria-label="Back">${I.back}</button>` : ""}
    ${title}<span class="ch-sp"></span>${extra}
    <button type="button" class="ch-ic" data-act="close" aria-label="Close">${I.x}</button></header>`;

const row = (c) => {
  const unread = isUnread(c, me.uid);
  const helpRow = c.kind === "help" && c.members[0] === me.uid;
  return `<button type="button" class="ch-row${unread ? " is-unread" : ""}" data-open="${esc(c.id)}">
    ${avatar(titleOf(c), helpRow)}
    <span class="ch-row-main">
      <span class="ch-row-top"><strong>${esc(titleOf(c))}</strong><small>${esc(when(c.lastAt))}</small></span>
      <small class="ch-row-last">${c.lastAt ? `${c.lastBy === me.uid ? "You: " : ""}${esc(c.lastText)}` : helpRow ? "Ask anything about the portal" : ""}</small>
      ${admin && c.kind === "help" && c.status === "sorted" ? '<span class="ch-tag">Sorted</span>' : ""}
    </span>${unread ? '<span class="ch-dot" aria-label="Unread"></span>' : ""}</button>`;
};

function drawList() {
  view = "list";
  const list = myChats();
  const help = list.filter((c) => c.kind === "help" && c.members[0] !== me.uid)
    .sort((a, b) => (a.status === "sorted") - (b.status === "sorted"));
  const dms = list.filter((c) => c.kind === "dm");
  const myHelp = admin ? null : chatFor(helpId(me.uid));
  const ask = "Notification" in window && Notification.permission === "default"
    ? `<button type="button" class="ch-ask" data-act="notify">${I.bell} Turn on desktop alerts</button>` : "";
  panel.innerHTML = `${head("<strong>Chats</strong>", {
      extra: `<button type="button" class="ch-ic" data-act="mute" aria-label="${muted() ? "Turn sound on" : "Mute sound"}"
        title="${muted() ? "Sound is off" : "Sound is on"}">${muted() ? I.bellOff : I.bell}</button>` })}
    ${ask}
    <div class="ch-list">
      ${myHelp ? row(myHelp) : ""}
      ${admin ? `<p class="ch-sec">Help inbox</p>${help.map(row).join("") || '<p class="ch-none">No help requests.</p>'}` : ""}
      <p class="ch-sec">Your chats</p>
      ${dms.map(row).join("") || '<p class="ch-none">No chats yet. Start one with New message.</p>'}
    </div>
    <footer class="ch-ft">
      <button type="button" class="lh-btn is-primary" data-act="new">${I.plus}<span>New message</span></button>
      ${admin ? '<button type="button" class="lh-btn" data-act="all">All staff chats</button>' : ""}
    </footer>
    <p class="ch-note">Chats can be seen by the clinic's admins.</p>`;
}

function openThread(id) {
  const c = chatFor(id);
  if (!c || !me) return;
  if (!isOpen()) showPanel();
  view = "thread";
  openId = id;
  current = c;
  const isMember = c.members.includes(me.uid);
  const canWrite = isMember || (admin && c.kind === "help");
  const helpStaff = c.kind === "help" && c.members[0] === me.uid;
  const adminHelp = admin && c.kind === "help" && !helpStaff;
  panel.innerHTML = `${head(`${avatar(titleOf(c), helpStaff)}<span class="ch-hd-t"><strong>${esc(titleOf(c))}</strong>
      ${helpStaff ? "<small>Usually replies within a few hours</small>" : ""}</span>`, {
      back: true,
      extra: adminHelp ? `<button type="button" class="lh-btn" data-act="sorted">${c.status === "sorted" ? "Reopen" : "Mark as sorted"}</button>` : "",
    })}
    <div class="ch-msgs" data-role="msgs"><p class="ch-empty">${helpStaff
      ? "Ask anything about the portal. Bethany will get back to you." : "No messages yet."}</p></div>
    ${canWrite ? `<form class="ch-comp" novalidate>
        <textarea rows="1" maxlength="4000" placeholder="Type your message" aria-label="Message"></textarea>
        <button type="submit" class="ch-send" aria-label="Send">${I.send}</button></form>
      <label class="ch-link"><input type="checkbox" data-role="withpage"${helpStaff ? " checked" : ""} /> Include a link to this page</label>`
      : '<p class="ch-ro">You\'re viewing a chat between staff. Only they can reply.</p>'}`;
  stopMessages();
  if (chats.some((x) => x.id === id) || (allChats || []).some((x) => x.id === id)) startMessages(id);
  readIfViewing();
  const ta = panel.querySelector("textarea");
  if (ta) setTimeout(() => ta.focus(), 30);
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
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  if (!msgs.length) return;
  box.innerHTML = msgs.map((m) => {
    const mine = m.byUid === me.uid;
    return `<div class="ch-m${mine ? " is-me" : ""}">
      ${mine ? "" : `<small class="ch-m-by">${esc(m.by)}</small>`}
      <div class="ch-m-b">${esc(m.text)}</div>
      <small class="ch-m-meta">${m.page ? `<a href="${esc(m.page.hash)}">${I.link} ${esc(m.page.label || "Page")}</a> · ` : ""}${esc(when(m.at))}</small>
    </div>`;
  }).join("");
  if (first || atBottom) box.scrollTop = box.scrollHeight;
}

// Where they are now, so the other person can go straight there
function pageInfo() {
  const h = document.querySelector("#content .pb-name, #content h2");
  const nav = document.querySelector(".nav-item.active span");
  const label = (h && h.textContent.trim()) || (nav && nav.textContent.trim()) || "Portal";
  return { hash: location.hash || "#/home", label };
}

async function send(form) {
  if (!form.matches(".ch-comp") || !current) return;
  const ta = form.querySelector("textarea");
  const btn = form.querySelector('[type="submit"]');
  const text = ta.value.trim();
  if (!text || btn.disabled) return;
  const withPage = !!(panel.querySelector('[data-role="withpage"]') || {}).checked;
  btn.disabled = true;
  try {
    await sendMessage(current, text, withPage ? pageInfo() : null, me);
    ta.value = "";
    ta.style.height = "";
    if (!msgUnsub) startMessages(current.id);
  } catch (err) {
    console.error("Chat send failed:", err);
    showToast(err && err.code === "permission-denied"
      ? "Couldn't send. Check the chats Firestore rule has been published."
      : err && err.message && !err.code ? err.message : "Couldn't send. Check your connection and try again.");
  }
  btn.disabled = false;
  ta.focus();
}

async function drawNew() {
  view = "new";
  panel.innerHTML = `${head("<strong>New message</strong>", { back: true })}
    <div class="ch-find"><input type="search" class="fe-input" data-role="find" placeholder="Search staff" aria-label="Search staff" /></div>
    <div class="ch-list" data-role="people"><p class="ch-none">Loading staff…</p></div>`;
  setTimeout(() => { const f = panel.querySelector('[data-role="find"]'); if (f) f.focus(); }, 30);
  if (!staffList) {
    try {
      staffList = ((await fetchStaffList()) || []).filter((s) => s && s.id && s.active !== false);
      staffById = new Map(staffList.map((s) => [String(s.id), s]));
    } catch (err) {
      console.warn("Chat staff list failed:", err);
    }
  }
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
      status: "open", readAt: {}, lastAt: null });
  }
  openThread(id);
}

async function drawAll() {
  view = "all";
  panel.innerHTML = `${head("<strong>All staff chats</strong>", { back: true })}
    <div class="ch-list" data-role="all"><p class="ch-none">Loading…</p></div>
    <p class="ch-note">Chats between other staff. You can read them, but only they can reply.</p>`;
  try {
    allChats = (await listAllChats()).filter((c) => c.kind === "dm" && !c.members.includes(me.uid))
      .sort((a, b) => (b.lastAt ? b.lastAt.getTime() : 0) - (a.lastAt ? a.lastAt.getTime() : 0));
  } catch (err) {
    console.warn("All chats failed:", err);
    allChats = [];
  }
  const box = panel.querySelector('[data-role="all"]');
  if (box && view === "all") box.innerHTML = allChats.map(row).join("") || '<p class="ch-none">No chats between other staff yet.</p>';
}

/* ---------- Clicks and keys ---------- */

async function onClick(e) {
  const t = e.target.closest("[data-act],[data-open],[data-dm]");
  if (!t || !me) return;
  if (t.dataset.open) { hidePop(); openThread(t.dataset.open); return; }
  if (t.dataset.dm) { startDm(t.dataset.dm); return; }
  switch (t.dataset.act) {
    case "toggle":
      if (isOpen()) hidePanel(); else { showPanel(); drawList(); }
      break;
    case "close": hidePanel(); break;
    case "back": stopMessages(); drawList(); break;
    case "new": drawNew(); break;
    case "all": drawAll(); break;
    case "popx": hidePop(); break;
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

function onKey(e) {
  if (e.key === "Escape" && isOpen()) { hidePanel(); root.querySelector(".ch-bubble").focus(); return; }
  // Enter sends, Shift + Enter starts a new line
  if (e.key === "Enter" && !e.shiftKey && e.target.matches(".ch-comp textarea")) {
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
  }
}