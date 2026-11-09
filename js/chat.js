// The chat bubble (bottom-right on every page): Help to the admins, messages between staff, and group chats.
// A new message: a chime, a pop-up, a red badge, "(2)" in the tab title, and a desktop alert when the portal is in the background.
// Your own messages can be edited or deleted; any chat can be removed from your own list.
import { fetchStaffList } from "./task-types.js";
import { isAdmin } from "./perms.js";
import { confirmDialog } from "./dialog.js";
import { escapeHtml, getInitials, hueFromString, showToast, toDateKey, formatDobLong } from "./utils.js";
import { getPatient, patientIds, fetchPatients, findPatientsById, searchPatientsByPhone } from "./patients.js";
import { fetchDayAppointments } from "./appointments.js";
import {
  watchChats, watchMessages, sendMessage, markRead, setChatStatus, listAllChats, isUnread, isHiddenFor, helpId, dmId,
  newGroupId, watchAway, saveAway, editMessage, deleteMessage, hideChat, newMessageId,
  uploadChatImage, chatImageUrl, cachedImageUrl, countUnread,
} from "./chat-api.js";
import { startPresence, stopPresence, watchPresence } from "./presence.js";
import { requestRefresh } from "./force-refresh.js";

const HELP_NAME = "Bethany";   // who answers Help
const esc = (s) => escapeHtml(String(s ?? ""));
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  clip: svg('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
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
  min: svg('<polyline points="6 9 12 15 18 9"/>'),
  down: svg('<polyline points="6 9 12 15 18 9"/>'),
  up: svg('<polyline points="18 15 12 9 6 15"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  photo: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  userPlus: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>'),
  reply: svg('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
  chevR: svg('<polyline points="9 18 15 12 9 6"/>'),
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

// Web addresses and portal links (#/…) in a message can be tapped. The text is made safe first.
const LINK_RE = /(https?:\/\/[^\s<]+|#\/[\w\-/%.~]+)/g;
function linkify(text) {
  return esc(text).replace(LINK_RE, (m) => {
    const tail = (m.match(/[).,!?;:]+$/) || [""])[0];   // full stops and brackets after a link aren't part of it
    const url = tail ? m.slice(0, -tail.length) : m;
    const web = url.startsWith("http");
    const shown = web ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : url;
    return `<a class="ch-m-a" href="${url}"${web ? ' target="_blank" rel="noopener noreferrer"' : ""}>${shown}</a>${tail}`;
  });
}

// "Enter to send" shows while typing, for your first few messages
const hintKey = () => `chat:hints:${me.uid}`;
const hintsLeft = () => { try { return Number(localStorage.getItem(hintKey()) || 0) < 8; } catch { return true; } };
const usedHint = () => { try { localStorage.setItem(hintKey(), String(Number(localStorage.getItem(hintKey()) || 0) + 1)); } catch { /* ignore */ } };

// One chat muted: no sound, pop-up or desktop alert (the red badge still counts it)
const chatMuteKey = (id) => `chat:mute:${me.uid}:${id}`;
const chatMuted = (id) => { try { return localStorage.getItem(chatMuteKey(id)) === "1"; } catch { return false; } };
// One tap for you on Help. The last one also marks it as sorted.
const QUICK_REPLIES = ["On my way", "Looking into it now", "Can you call me?", "All sorted ✓"];
// A person's profile photo: mine from my login, everyone else's from the staff list. "" if none.
const photoOf = (u) => {
  if (!u || !me) return "";
  const s = String(u) === me.uid ? me : staffById.get(String(u));
  return String((s && (s.photo || s.photoUrl)) || "");
};
// Whose face a conversation shows: the other person in a chat for two, the staff member on an admin's Help chat
const faceOf = (c) => (c.kind === "dm" ? c.members.find((u) => u !== me.uid) || c.members[0]
  : c.kind === "help" && c.members[0] !== me.uid ? c.members[0] : "");
// kind: "help" | "group" | "" (a person). u: their ID, for the photo (initials show if there isn't one, or it won't load).
/* ---------- Who's on the portal ---------- */
const presOf = (u) => presence.get(String(u || "")) || { status: "offline", device: "", lastAt: 0 };
// "today 2:14 pm", "yesterday 4:30 pm", "Tue 2:14 pm", "12 Oct"
function seenWhen(ms) {
  const d = new Date(ms);
  const t = timeOf(d);
  const k = keyOf(d);
  if (k === keyOf(new Date())) return `today ${t}`;
  if (k === dayFromNow(-1)) return `yesterday ${t}`;
  if (Date.now() - ms < 6 * 86400000) return `${d.toLocaleDateString("en-AU", { weekday: "short" })} ${t}`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
const ON_DEVICE = { phone: "their phone", iPad: "an iPad", tablet: "a tablet" };
function presText(u) {
  const p = presOf(u);
  if (p.status === "online") return `Online now${ON_DEVICE[p.device] ? ` · on ${ON_DEVICE[p.device]}` : ""}`;
  if (p.status === "away") return "Away";
  return p.lastAt ? `Last seen ${seenWhen(p.lastAt)}` : "";
}
const presDot = (u) => {
  const s = presOf(u).status;
  return s === "offline" ? "" : `<span class="ch-pres is-${s}" title="${s === "online" ? "Online now" : "Away"}"></span>`;
};

// kind: "help" | "group" | "" (a person). u: their ID, for the photo and the online dot.
const avatar = (name, kind = "", u = "") => {
  if (kind === "help") return `<span class="ch-av is-help">${I.help}</span>`;
  if (kind === "group") return `<span class="ch-av is-group">${I.group}</span>`;
  const photo = photoOf(u);
  const face = `<span class="ch-av" style="--h:${hueFromString(name || "?")}">${esc(getInitials(name || "?"))}${photo
    ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}</span>`;
  const dot = u && me && String(u) !== me.uid ? presDot(u) : "";
  return dot ? `<span class="ch-avw">${face}${dot}</span>` : face;
};

let me = null;
let admin = false;
let root = null;
let panel = null;
let unsub = null;
let msgUnsub = null;
let awayUnsub = null;
let presUnsub = null;
let presence = new Map();    // uid → { status, device, lastAt }, live
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
let attach = null;           // the picture waiting to be sent: { blob, url, w, h, type }
let minimized = false;       // folded down to its header: the conversation, typing and picture are kept
const draftText = new Map(); // chat id → what was typed and not sent yet
let linkPage = false;        // the next message links the page you're on
let actsOpen = "";           // my message whose Edit / Delete is showing (survives a redraw)
let searchQ = "";            // Search this chat
let hitIdx = -1;
let jumpCount = 0;           // new messages below while you're scrolled up
let replyTo = null;          // the message being answered: { id, by, byUid, text, image }
let linkPt = null;           // the patient linked to the next message
const PAGE = 150;            // messages loaded at a time
let msgLimit = PAGE;
const unreadN = new Map();   // chat id → { key, n }: how many unread
const counting = new Set();
const ptCache = new Map();   // patient id → promise of the patient
let ptSearchTimer = 0;       // Link a patient: search waits until typing pauses
let ptSearchSeq = 0;         // only the latest search's results are shown
let apptJob = null;          // today's bookings, read once a day
let pendingJump = "";        // a message to go to once the chat has loaded (from a patient's page)

/* ---------- Pictures ---------- */
// Shrunk to about 1600px before sending. Screenshots stay PNG (sharp text); photos become JPEG. GIFs are sent as they are.
const IMG_MAX = 1600;
const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
async function prepImage(file) {
  const type = String(file.type || "").toLowerCase().replace("image/jpg", "image/jpeg");
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new Error("Choose a picture (JPG, PNG, GIF or WebP).");
  if (file.size > 25 * 1024 * 1024) throw new Error("That picture is over 25 MB.");
  const src = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That picture couldn't be opened."));
      i.src = src;
    });
    const w0 = im.naturalWidth;
    const h0 = im.naturalHeight;
    if (type === "image/gif" || (w0 <= IMG_MAX && h0 <= IMG_MAX && file.size <= 1.5 * 1024 * 1024)) {
      if (file.size > 5 * 1024 * 1024) throw new Error("That picture is over 5 MB.");
      return { blob: file, w: w0, h: h0, type };
    }
    const k = Math.min(1, IMG_MAX / Math.max(w0, h0));
    const c = document.createElement("canvas");
    c.width = Math.round(w0 * k);
    c.height = Math.round(h0 * k);
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    if (type === "image/png") {
      g.drawImage(im, 0, 0, c.width, c.height);
      const png = await toBlob(c, "image/png");
      if (png && png.size <= 1.5 * 1024 * 1024) return { blob: png, w: c.width, h: c.height, type: "image/png" };
      g.clearRect(0, 0, c.width, c.height);   // a big PNG is usually a photo: JPEG on white
    }
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(im, 0, 0, c.width, c.height);
    const jpg = await toBlob(c, "image/jpeg", 0.85);
    if (!jpg) throw new Error("That picture couldn't be made ready.");
    return { blob: jpg, w: c.width, h: c.height, type: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(src);
  }
}

function drawAttach() {
  const box = panel && panel.querySelector('[data-role="att"]');
  if (!box) return;
  box.hidden = !attach;
  box.innerHTML = attach ? `<img src="${esc(attach.url)}" alt="" /><span>Add a caption, or just press Send</span>
    <button type="button" class="ch-ic" data-act="unattach" aria-label="Remove the picture" title="Remove">${I.x}</button>` : "";
}
function clearAttach() {
  if (attach && attach.url) URL.revokeObjectURL(attach.url);
  attach = null;
  drawAttach();
}
async function setAttach(file) {
  if (!file || !isOpen() || view !== "thread" || !canWriteNow) return;
  if (editing) { showToast("Finish editing your message first."); return; }
  try {
    const img = await prepImage(file);
    clearAttach();
    attach = { ...img, url: URL.createObjectURL(img.blob) };
    drawAttach();
    const ta = panel.querySelector(".ch-comp textarea");
    if (ta && !isTouch()) ta.focus();
  } catch (err) {
    showToast((err && err.message) || "Couldn't use that picture.");
  }
}
// Ctrl+V / Cmd+V a screenshot into the message box
function onPaste(e) {
  if (!isOpen() || view !== "thread" || !canWriteNow) return;
  const f = [...((e.clipboardData && e.clipboardData.files) || [])].find((x) => /^image\//.test(x.type));
  if (!f) return;
  e.preventDefault();
  setAttach(f);
}
const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes("Files"));
function onDragOver(e) {
  if (!hasFiles(e) || view !== "thread" || !canWriteNow) return;
  e.preventDefault();
  panel.classList.add("is-drop");
}
function onDragLeave(e) {
  if (!panel.contains(e.relatedTarget)) panel.classList.remove("is-drop");
}
function onDrop(e) {
  panel.classList.remove("is-drop");
  if (!hasFiles(e)) return;
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => /^image\//.test(x.type));
  if (f) setAttach(f); else showToast("Only pictures can be sent in chat.");
}

// A picture in a message: from this device while sending, otherwise from Storage
function imgHtml(m, own) {
  const im = m.image;
  const ratio = im.w && im.h ? ` style="aspect-ratio:${im.w}/${im.h}"` : "";
  const src = im.local || cachedImageUrl(im.path);
  return `<button type="button" class="ch-m-img" data-zoom="${esc(m.id)}"${own ? ' data-own="1"' : ""} aria-label="Open the picture">` +
    `<img alt="Picture"${ratio}${src ? ` src="${esc(src)}"` : ` data-chimg="${esc(im.path)}"`} /></button>`;
}
function loadImages(box) {
  box.querySelectorAll("img[data-chimg]").forEach((el) => {
    chatImageUrl(el.dataset.chimg)
      .then((u) => { if (u && el.isConnected) { el.src = u; el.removeAttribute("data-chimg"); } })
      .catch(() => { const b = el.closest(".ch-m-img"); if (b) b.classList.add("is-broken"); });
  });
}
// Full size, with Delete for my own
function zoomImage(btn) {
  const img = btn.querySelector("img");
  const src = img && (img.currentSrc || img.src);
  if (!src) return;
  const mid = btn.dataset.own ? btn.dataset.zoom : "";
  const d = document.createElement("dialog");
  d.className = "ch-zoom";
  d.innerHTML = `<img src="${esc(src)}" alt="Picture" />
    <div class="ch-zoom-bar">
      <a class="lh-btn" href="${esc(src)}" target="_blank" rel="noopener">Open in a new tab</a>
      ${mid ? '<button type="button" class="lh-btn" data-zdel>Delete</button>' : ""}
      <button type="button" class="lh-btn is-primary" data-zx>Close</button>
    </div>`;
  document.body.appendChild(d);
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target.closest("[data-zx]")) d.close();
    else if (e.target.closest("[data-zdel]")) { d.close(); removeMsg(mid); }
  });
  d.showModal();
}

/* ---------- Patients in chat ---------- */
const recentKey = () => `chat:recentPts:${me.uid}`;
// The patient whose page, form or consultation is open, from the address
function currentPatientId() {
  const m = /^#\/(?:patient|fill|consult\/new)\/([^/?#]+)/.exec(location.hash || "");
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return ""; }
}
// Patients you open are remembered on this device (newest first, 8 at most)
function rememberPatient() {
  const id = currentPatientId();
  if (!id || !me) return;
  try {
    const list = JSON.parse(localStorage.getItem(recentKey()) || "[]").filter((x) => x !== id);
    list.unshift(id);
    localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, 8)));
  } catch { /* ignore */ }
}
function ptFull(id) {
  if (!ptCache.has(id)) ptCache.set(id, getPatient(id).then((p) => p || null).catch(() => null));
  return ptCache.get(id);
}
function todaysAppts() {
  const k = keyOf(new Date());
  if (!apptJob || apptJob.k !== k) {
    apptJob = { k, p: fetchDayAppointments(toDateKey()).then((d) => (d && d.appointments) || []).catch(() => []) };
  }
  return apptJob.p;
}
// Their time today ("9:15 am"), or ""
async function apptFor(p) {
  const list = await todaysAppts();
  const ids = patientIds(p).map((s) => String(s).toLowerCase());
  const name = String(p.name || "").toLowerCase();
  const a = list.filter((x) => (x.patientId ? ids.includes(String(x.patientId).toLowerCase())
    : String(x.patientName || "").toLowerCase() === name))
    .sort((x, y) => (x.sortMinutes || 0) - (y.sortMinutes || 0))[0];
  return a && a.time ? a.time : "";
}
// "Appt today 9:15 am", or "Appt 9 Nov, 9:15 am" on later days
function apptText(p) {
  if (!p.apptKey || !p.apptTime) return "";
  if (p.apptKey === keyOf(new Date())) return `Appt today ${p.apptTime}`;
  const [y, mo, d] = p.apptKey.split("-").map(Number);
  return `Appt ${new Date(y, mo - 1, d).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}, ${p.apptTime}`;
}
const ptCardHtml = (p) => `<a class="ch-pt" href="#/patient/${encodeURIComponent(p.id)}" title="Open ${esc(p.name)}'s page">
    <span class="ch-pt-av" style="--h:${hueFromString(p.name)}">${esc(getInitials(p.name))}</span>
    <span class="ch-pt-t"><b>${esc(p.name)}</b><small>${esc([p.pttId && `ID ${p.pttId}`, apptText(p)].filter(Boolean).join(" · ") || "Open their page")}</small></span>
    ${I.chevR}</a>`;

async function openPtPick() {
  const box = panel && panel.querySelector('[data-role="ptpick"]');
  if (!box) return;
  closeMenus();
  box.hidden = false;
  box.innerHTML = `<div class="ch-pp-head"><strong>Link a patient</strong>
      <button type="button" class="ch-ic" data-act="ptclose" aria-label="Close">${I.x}</button></div>
    <input type="search" class="fe-input ch-pp-q" data-role="ptq" placeholder="Search by surname, mobile or ID"
      aria-label="Search all patients" autocomplete="off" />
    <div data-role="ptres" hidden></div>
    <div data-role="ptrecent"><p class="ch-none">Loading recent patients…</p></div>`;
  const q = box.querySelector('[data-role="ptq"]');
  if (q && !isTouch()) q.focus();
  // Recent: the patient whose page you're on, then the ones you opened lately
  const here = currentPatientId();
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem(recentKey()) || "[]"); } catch { ids = []; }
  ids = [...new Set([here, ...ids].filter(Boolean))].slice(0, 8);
  const pts = (await Promise.all(ids.map(ptFull))).filter(Boolean);
  const rec = box.querySelector('[data-role="ptrecent"]');
  if (box.hidden || !rec || !rec.isConnected) return;
  rec.innerHTML = pts.length
    ? `<p class="ch-pp-sec">Recent</p><div class="ch-pp-list">${pts.map((p) => ptRowHtml(p, p.id === here ? "This page" : "")).join("")}</div>`
    : '<p class="ch-pp-note">The patients you open will also show here.</p>';
}

// One patient in the picker: name, ID and date of birth (to tell two people with the same name apart)
const ptRowHtml = (p, tag = "") => `<button type="button" class="ch-pp-row" data-ptpick="${esc(p.id)}">
    <span class="ch-pt-av" style="--h:${hueFromString(p.name)}">${esc(getInitials(p.name))}</span>
    <span class="ch-pt-t"><b>${esc(p.name)}</b><small>${esc([p.pttId && `ID ${p.pttId}`,
      p.dobKey && formatDobLong(p.dobKey) && `born ${formatDobLong(p.dobKey)}`].filter(Boolean).join(" · "))}</small></span>
    ${tag ? `<em>${esc(tag)}</em>` : ""}</button>`;

// The whole patient list: a mobile number, a surname (or full name, either order), and an ID if there's a number in it
async function searchAllPatients(t) {
  const compact = t.replace(/[\s+()-]/g, "");
  const isPhone = /^\d{4,}$/.test(compact);
  const jobs = [isPhone ? searchPatientsByPhone(t) : fetchPatients({ mode: "name", term: t }).then((r) => r.patients)];
  if (/\d/.test(t) && /^[\w-]{2,64}$/.test(t.trim())) jobs.push(findPatientsById(t.trim()));
  const res = await Promise.allSettled(jobs);
  if (res.every((r) => r.status === "rejected")) throw res[0].reason;
  const out = new Map();
  res.forEach((r) => {
    if (r.status === "fulfilled") r.value.forEach((p) => { if (!p.mergedInto) out.set(p.id, p); });
  });
  return [...out.values()].slice(0, 20);
}

function onPtSearch(value) {
  clearTimeout(ptSearchTimer);
  const box = panel && panel.querySelector('[data-role="ptres"]');
  const recent = panel && panel.querySelector('[data-role="ptrecent"]');
  const t = String(value || "").trim();
  if (recent) recent.hidden = !!t;
  if (!box) return;
  if (t.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = '<p class="ch-none">Searching…</p>';
  const seq = ++ptSearchSeq;
  ptSearchTimer = setTimeout(async () => {
    let list;
    try {
      list = await searchAllPatients(t);
    } catch (err) {
      console.warn("Patient search failed:", err);
      if (seq === ptSearchSeq && box.isConnected) box.innerHTML = '<p class="ch-none">Couldn\'t search. Check your connection and try again.</p>';
      return;
    }
    if (seq !== ptSearchSeq || !box.isConnected) return;   // they've typed more since
    list.forEach((p) => ptCache.set(p.id, Promise.resolve(p)));   // picking one doesn't load them again
    box.innerHTML = list.length
      ? `<div class="ch-pp-list">${list.map((p) => ptRowHtml(p)).join("")}</div>`
      : '<p class="ch-none">No patients match. Try their surname, mobile or ID.</p>';
  }, 280);
}

function closePtPick() {
  const box = panel && panel.querySelector('[data-role="ptpick"]');
  if (box) { box.hidden = true; box.innerHTML = ""; }
}
async function pickPatient(id) {
  const p = await ptFull(id);
  if (!p) { showToast("Couldn't load that patient."); return; }
  linkPt = { id: p.id, name: p.name || "Patient", pttId: p.pttId || "", apptKey: "", apptTime: "" };
  closePtPick();
  paintPt();
  const ta = panel.querySelector(".ch-comp textarea");
  if (ta && !isTouch()) ta.focus();
  const t = await apptFor(p);   // added when today's bookings have been read
  if (t && linkPt && linkPt.id === p.id) { linkPt.apptKey = keyOf(new Date()); linkPt.apptTime = t; paintPt(); }
}
function paintPt() {
  const chip = panel && panel.querySelector('[data-role="ptchip"]');
  if (!chip) return;
  chip.hidden = !linkPt;
  if (linkPt) chip.querySelector("span").textContent = [linkPt.name, apptText(linkPt)].filter(Boolean).join(" · ");
}

/* ---------- Replies ---------- */
function startReply(mid) {
  const m = msgList.find((x) => x.id === mid);
  if (!m || m.deleted) return;
  if (editing) stopEdit();
  replyTo = { id: m.id, by: m.by, byUid: m.byUid, image: !!m.image,
    text: String(m.text || (m.patient ? `👤 ${m.patient.name}` : "")).slice(0, 140) };
  panel.querySelectorAll(".ch-m.is-acts").forEach((x) => x.classList.remove("is-acts"));
  actsOpen = "";
  paintReply();
  const ta = panel.querySelector(".ch-comp textarea");
  if (ta) ta.focus();
}
function paintReply() {
  const bar = panel && panel.querySelector('[data-role="replybar"]');
  if (!bar) return;
  bar.hidden = !replyTo;
  bar.innerHTML = replyTo ? `<span><b>Replying to ${esc(replyTo.byUid === me.uid ? "yourself" : replyTo.by)}</b>
      <small>${esc(replyTo.text || (replyTo.image ? "📷 Photo" : "Message"))}</small></span>
    <button type="button" class="ch-ic" data-act="unreply" aria-label="Cancel reply" title="Cancel reply">${I.x}</button>` : "";
}
// Tapping a quote: to the original message, with a short highlight
function jumpTo(mid) {
  const el = panel && panel.querySelector(`.ch-m[data-mid="${CSS.escape(mid)}"]`);
  if (!el) {
    showToast(msgList.length >= msgLimit ? "That message is further back. Tap Load earlier messages." : "That message isn't here any more.");
    return;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("is-flash");
  void el.offsetWidth;
  el.classList.add("is-flash");
}

/* ---------- Unread counts in the list ---------- */
function refreshCounts() {
  if (!me) return;
  myChats().forEach((c) => {
    if (!isUnread(c, me.uid)) { unreadN.delete(c.id); return; }
    const since = c.readAt[me.uid] || null;
    const key = `${c.lastAt ? c.lastAt.getTime() : 0}:${since ? since.getTime() : 0}`;
    const have = unreadN.get(c.id);
    if ((have && have.key === key) || counting.has(c.id)) return;
    counting.add(c.id);
    countUnread(c.id, since)
      .then((n) => {
        unreadN.set(c.id, { key, n });
        if (isOpen() && !minimized && view === "list") redrawList();
      })
      .catch((err) => console.warn("Unread count failed:", err))
      .finally(() => counting.delete(c.id));
  });
}
// The chat list again, keeping where it was scrolled to
function redrawList() {
  const sc = panel.querySelector(".ch-list");
  const top = sc ? sc.scrollTop : 0;
  drawList();
  const sc2 = panel.querySelector(".ch-list");
  if (sc2) sc2.scrollTop = top;
}

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
  startPresence(me);
  presUnsub = watchPresence((m) => { presence = m; onPresence(); }, (err) => console.warn("Presence failed to load:", err));
  loadStaff().then(render);
  checkChatLink();
  rememberPatient();
}

export function teardownChat() {
  if (unsub) unsub();
  if (awayUnsub) awayUnsub();
  if (presUnsub) presUnsub();
  stopPresence();
  presence = new Map();
  stopMessages();
  unsub = awayUnsub = presUnsub = null;
  if (root) root.remove();
  root = panel = null;
  me = null;
  chats = [];
  allChats = null;
  drafts.clear();
  pendingSends.clear();
  attach = null;
  lastSeen.clear();
  groupSel.clear();
  loaded = false;
  view = "list";
  openId = "";
  current = null;
  msgList = [];
  editing = "";
  draftText.clear();
  document.removeEventListener("pointerdown", unlockAudio);
  document.removeEventListener("visibilitychange", readIfViewing);
  window.removeEventListener("hashchange", checkChatLink);
  window.removeEventListener("hashchange", rememberPatient);
  unreadN.clear();
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
  root.addEventListener("paste", onPaste);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("dragleave", onDragLeave);
  root.addEventListener("drop", onDrop);
  document.addEventListener("pointerdown", unlockAudio);        // browsers only allow sound after a click
  document.addEventListener("visibilitychange", readIfViewing);
  window.addEventListener("hashchange", checkChatLink);
  window.addEventListener("hashchange", rememberPatient);
}

// "#/home/chat/<id>" (the button in the reminder email): open that conversation once it has loaded
function checkChatLink() {
  const m = /^#\/home\/chat\/([A-Za-z0-9_-]{3,120})$/.exec(location.hash || "");
  if (!m || !me) return;
  pendingOpen = m[1];
  history.replaceState(null, "", "#/home");
  openPending();
}
// From elsewhere in the portal (a patient's page): open a conversation, and go to one message in it
export function openChat(id, msgId = "") {
  if (!me || !root || !id) return;
  pendingJump = msgId || "";
  if (chatFor(id)) openThread(id);
  else { pendingOpen = id; openPending(); }
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

// Someone came online, went away or left: update what's on screen (keeping the list's scroll position)
function onPresence() {
  if (!root || !me || !isOpen()) return;
  if (view === "list") {
    const sc = panel.querySelector(".ch-list");
    const top = sc ? sc.scrollTop : 0;
    drawList();
    const sc2 = panel.querySelector(".ch-list");
    if (sc2) sc2.scrollTop = top;
  } else if (view === "new") {
    const f = panel.querySelector('[data-role="find"]');
    drawPeople(((f && f.value) || "").trim().toLowerCase());
  } else if (view === "thread") {
    updatePresSub();
  }
}

// The chat header: "Online now" / "Last seen …", and the dot on their picture
function updatePresSub() {
  if (!panel || !current) return;
  const u = faceOf(current);
  const el = panel.querySelector('[data-role="presub"]');
  if (el) {
    el.textContent = u ? presText(u) : "";
    el.classList.toggle("is-online", presOf(u).status === "online");
  }
  const av = panel.querySelector(".ch-hd > .ch-avw, .ch-hd > .ch-av");
  if (av && u) av.outerHTML = avatar(titleOf(current), kindOf(current), u);
}

function syncBadge() {
  const n = myChats().filter((c) => isUnread(c, me.uid)).length;
  const badge = root.querySelector('[data-role="badge"]');
  badge.textContent = n > 9 ? "9+" : String(n);
  badge.hidden = !n;
  document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
  paintMin();
}

// The conversation on screen is read as soon as it's seen
function readIfViewing() {
  if (!me || !isOpen() || minimized || view !== "thread" || document.hidden) return;
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
  if (isOpen() && !minimized && view === "thread" && openId === c.id && !document.hidden) return;   // already looking at it
  if (chatMuted(c.id)) return;   // muted: just the badge
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
  pop.innerHTML = `<button type="button" class="ch-pop-in" data-open="${esc(c.id)}">${avatar(c.lastByName, c.kind === "group" ? "group" : "", c.lastBy)}
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
  clearAttach();
  minimized = false;
  paintMin();
  panel.hidden = true;
  root.classList.remove("is-open");
  stopMessages();
  view = "list";
  editing = "";
}
function stopMessages() { if (msgUnsub) msgUnsub(); msgUnsub = null; }

// Folded: just the header shows. Unfolded: back where you were, scrolled to the latest message.
function setMin(on) {
  if (!panel || panel.hidden) return;
  minimized = !!on;
  if (minimized) {
    hideEmoji();
    closeMenus();
    panel.querySelectorAll(".ch-m.is-acts").forEach((x) => x.classList.remove("is-acts"));
    actsOpen = "";
  }
  const b = panel.querySelector('[data-act="min"]');
  if (b) { b.setAttribute("aria-label", minimized ? "Open chat" : "Minimise"); b.title = minimized ? "Open" : "Minimise"; }
  paintMin();
  if (minimized) return;
  hidePop();
  const box = panel.querySelector('[data-role="msgs"]');
  if (box) box.scrollTop = box.scrollHeight;
  readIfViewing();
  const ta = panel.querySelector(".ch-comp textarea");
  if (ta && !isTouch()) ta.focus();
}

// The folded bar: its class, and the unread count shown on it
function paintMin() {
  if (!panel || !me) return;
  const n = minimized ? myChats().filter((c) => isUnread(c, me.uid)).length : 0;
  root.classList.toggle("is-min", minimized);
  panel.classList.toggle("is-min", minimized);
  panel.classList.toggle("has-new", n > 0);
  panel.style.setProperty("--n", `"${n > 9 ? "9+" : n}"`);
}

const head = (title, { back = false, extra = "" } = {}) => `<header class="ch-hd">
    ${back ? `<button type="button" class="ch-ic" data-act="back" aria-label="Back">${I.back}</button>` : ""}
    ${title}<span class="ch-sp"></span>${extra}
    <button type="button" class="ch-ic ch-min-btn" data-act="min" aria-label="${minimized ? "Open chat" : "Minimise"}"
      title="${minimized ? "Open" : "Minimise"}">${I.min}</button>
    <button type="button" class="ch-ic" data-act="close" aria-label="Close">${I.x}</button></header>`;

const row = (c) => {
  const unread = isUnread(c, me.uid);
  const helpRow = c.kind === "help" && c.members[0] === me.uid;
  const empty = helpRow ? (awayOn() ? helpSub() : "Ask anything about the portal") : c.kind === "group" ? membersText(c) : "";
  const draft = draftText.get(c.id);
  const quiet = chatMuted(c.id) ? `<span class="ch-muted" title="Muted">${I.bellOff}</span>` : "";
  const last = draft ? `<b>Draft:</b> ${esc(draft)}`
    : c.lastAt ? `${c.lastBy === me.uid ? "You: " : c.kind === "group" ? `${esc((c.lastByName || "").split(/\s+/)[0])}: ` : ""}${esc(c.lastText)}`
    : esc(empty);
  return `<button type="button" class="ch-row${unread ? " is-unread" : ""}" data-open="${esc(c.id)}">
    ${avatar(titleOf(c), kindOf(c), faceOf(c))}
    <span class="ch-row-main">
      <span class="ch-row-top"><strong>${esc(titleOf(c))}${quiet}</strong><small>${esc(when(c.lastAt))}</small></span>
      <small class="ch-row-last${draft ? " is-draft" : ""}">${last}</small>
      ${admin && c.kind === "help" && c.status === "sorted" ? '<span class="ch-tag">Sorted</span>' : ""}
    </span>${unread ? (() => {
      const n = (unreadN.get(c.id) || {}).n;
      return n ? `<span class="ch-count" aria-label="${n} unread">${n > 9 ? "9+" : n}</span>`
        : '<span class="ch-dot" aria-label="Unread"></span>';
    })() : ""}</button>`;
};
// The faces of everyone on the portal now (online first). Tap one to message them.
function hereHtml() {
  if (!staffList) return "";
  const rank = (s) => (presOf(s.id).status === "online" ? 0 : 1);
  const here = staffList.filter((s) => String(s.id) !== me.uid && presOf(s.id).status !== "offline")
    .sort((a, b) => rank(a) - rank(b) || String(a.name || "").localeCompare(String(b.name || "")));
  return `<div class="ch-online">
    <p class="ch-sec">On the portal now${here.length ? ` (${here.length})` : ""}</p>
    ${here.length ? `<div class="ch-online-row">${here.map((s) => `
      <button type="button" class="ch-online-p" data-dm="${esc(s.id)}" title="${esc(`${s.name} · ${presText(s.id)}`)}">
        ${avatar(s.name, "", s.id)}<span class="ch-online-n">${esc(String(s.name || "").split(/\s+/)[0])}</span></button>`).join("")}</div>`
      : '<p class="ch-none">No one else is on the portal right now.</p>'}
  </div>`;
}

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
      ${hereHtml()}
      ${myHelp ? row(myHelp) : ""}
      ${admin ? `<p class="ch-sec">Help inbox</p>${help.map(row).join("") || '<p class="ch-none">No help requests.</p>'}` : ""}
      <p class="ch-sec">Your chats</p>
      ${others.map(row).join("") || '<p class="ch-none">No chats yet. Start one with New message.</p>'}
    </div>
    <footer class="ch-ft">
      <button type="button" class="lh-btn is-primary" data-act="new">${I.plus}<span>New message</span></button>
      ${admin ? '<button type="button" class="lh-btn" data-act="all">All staff chats</button>' : ""}
    </footer>
    ${admin ? '<button type="button" class="ch-refresh" data-act="refreshall">↻ Update everyone\'s portal</button>' : ""}
    <p class="ch-note">${admin ? "" : "Chats between staff can be seen by Admins."}</p>`;
  refreshCounts();
} 

function openThread(id) {
  const c = chatFor(id);
  if (!c || !me) return;
  if (!isOpen()) showPanel();
  if (minimized) { minimized = false; paintMin(); }
  view = "thread";
  openId = id;
  current = c;
  msgList = [];
  editing = "";
  actsOpen = "";
  searchQ = "";
  hitIdx = -1;
  jumpCount = 0;
  replyTo = null;
  linkPt = null;
  msgLimit = PAGE;
  clearAttach();
  const isMember = c.members.includes(me.uid);
  const canWrite = isMember || (admin && c.kind === "help");
  canWriteNow = canWrite;
  const helpStaff = c.kind === "help" && c.members[0] === me.uid;
  const adminHelp = admin && c.kind === "help" && !helpStaff;
  linkPage = helpStaff;   // Help messages link the page you're on, unless you turn it off
  // Remove from my list: saved conversations I'm part of (not my own Help chat, which is always there)
  const canHide = !helpStaff && (isMember || adminHelp) && chats.some((x) => x.id === id);
  const sub = helpStaff ? `<small data-role="helpsub" class="${awayOn() ? "is-away" : ""}">${esc(helpSub())}</small>`
    : c.kind === "group" ? `<small>${esc(membersText(c))}</small>`
    : c.kind === "dm" && isMember ? '<small data-role="presub"></small>' : "";
  const muteOn = chatMuted(id);
  const more = `<span class="ch-more-wrap">
      <button type="button" class="ch-ic" data-act="more" aria-label="More" aria-haspopup="true" aria-expanded="false" title="More">${I.dots}</button>
      <div class="ch-menu" data-role="more" hidden>
        <button type="button" data-act="cmute">${muteOn ? I.bell : I.bellOff}<span>${muteOn ? "Unmute this chat" : "Mute this chat"}</span></button>
        <button type="button" data-act="search">${I.search}<span>Search this chat</span></button>
        ${canHide ? `<hr /><button type="button" class="is-danger" data-act="hide">${I.trash}<span>Remove from my list</span></button>` : ""}
      </div></span>`;
  panel.innerHTML = `${head(`${avatar(titleOf(c), kindOf(c), faceOf(c))}<span class="ch-hd-t"><strong>${esc(titleOf(c))}</strong>${sub}</span>`, {
      back: true,
      extra: `${adminHelp ? `<button type="button" class="lh-btn" data-act="sorted">${c.status === "sorted" ? "Reopen" : "Mark as sorted"}</button>` : ""}${more}`,
    })}
    <div class="ch-search" data-role="search" hidden>
      <input type="search" class="fe-input" data-role="sq" placeholder="Search this chat" aria-label="Search this chat" />
      <small data-role="shits"></small>
      <button type="button" class="ch-ic" data-act="sprev" aria-label="Older match" title="Older">${I.up}</button>
      <button type="button" class="ch-ic" data-act="snext" aria-label="Newer match" title="Newer">${I.down}</button>
      <button type="button" class="ch-ic" data-act="sclose" aria-label="Close search">${I.x}</button>
    </div>
    <div class="ch-msgs-wrap">
      <div class="ch-msgs" data-role="msgs"><p class="ch-empty">${helpStaff
        ? "Ask anything about the portal. Bethany will get back to you."
        : c.kind === "group" ? "Say hello to start the group." : "No messages yet."}</p></div>
      <button type="button" class="ch-jump" data-act="jump" hidden>${I.down}<span></span></button>
    </div>
    ${canWrite ? `<div class="ch-editing" data-role="editing" hidden><span>Editing your message</span>
        <button type="button" class="rc-link" data-act="canceledit">Cancel</button></div>
      ${adminHelp ? `<div class="ch-replies">${QUICK_REPLIES.map((q) =>
        `<button type="button" class="ch-chip" data-reply="${esc(q)}">${esc(q)}</button>`).join("")}</div>` : ""}
      <div class="ch-replybar" data-role="replybar" hidden></div>
      <div class="ch-ptpick" data-role="ptpick" hidden></div>
      <div class="ch-att" data-role="att" hidden></div>
      <div class="ch-linkchip ch-ptchip" data-role="ptchip" hidden>${I.userPlus}<span></span>
        <button type="button" class="ch-ic" data-act="ptunlink" aria-label="Remove the patient" title="Remove">${I.x}</button></div>
      <div class="ch-linkchip" data-role="linkchip" hidden>${I.link}<span></span>
        <button type="button" class="ch-ic" data-act="unlink" aria-label="Don't link this page" title="Don't link this page">${I.x}</button></div>
      <form class="ch-comp" novalidate>
        <div class="ch-emo" data-role="emo" hidden>${EMOJI.map((x) => `<button type="button" data-emo="${x}">${x}</button>`).join("")}</div>
        <div class="ch-menu ch-plus" data-role="plus" hidden>
          <button type="button" data-act="attach">${I.photo}<span>Add a picture</span></button>
          <button type="button" data-act="linkpage">${I.link}<span data-role="lptext">Link this page</span><small>${esc(pageInfo().label)}</small></button>
          <button type="button" data-act="ptlink">${I.userPlus}<span>Link a patient</span></button>
        </div>
        <button type="button" class="ch-ic ch-plus-btn" data-act="plus" aria-label="Add a picture or link" aria-haspopup="true" aria-expanded="false" title="Add">${I.plus}</button>
        <input type="file" accept="image/*" data-role="file" hidden />
        <textarea rows="1" maxlength="4000" placeholder="Type a message…" aria-label="Message"
          data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false" data-lt-active="false"></textarea>
        <button type="button" class="ch-ic ch-emo-btn" data-act="emoji" aria-label="Add emoji" title="Emoji">${I.smile}</button>
        <button type="submit" class="ch-send" aria-label="Send">${I.send}</button></form>
      ${isTouch() ? "" : '<small class="ch-hint" data-role="hint" hidden>Enter to send · Shift+Enter for a new line</small>'}`
      : '<p class="ch-ro">You\'re viewing a chat between staff. Only they can reply.</p>'}`;
  updatePresSub();
  paintLink();
  // Back at the bottom: the "new messages" button goes
  const box = panel.querySelector('[data-role="msgs"]');
  box.addEventListener("scroll", () => {
    if (jumpCount && box.scrollTop + box.clientHeight >= box.scrollHeight - 40) setJump(0);
  }, { passive: true });
  stopMessages();
  if (chats.some((x) => x.id === id) || (allChats || []).some((x) => x.id === id)) startMessages(id);
  readIfViewing();
  // What you'd typed here before comes back
  const ta = panel.querySelector(".ch-comp textarea");
  if (ta) {
    const draft = draftText.get(id) || "";
    if (draft) { ta.value = draft; ta.dispatchEvent(new Event("input", { bubbles: true })); }
    if (!isTouch()) setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
  }
}

// "Linking this page: Stock" above the message box
function paintLink() {
  if (!panel) return;
  const chip = panel.querySelector('[data-role="linkchip"]');
  if (chip) { chip.hidden = !linkPage; chip.querySelector("span").textContent = `Linking this page: ${pageInfo().label}`; }
  const t = panel.querySelector('[data-role="lptext"]');
  if (t) t.textContent = linkPage ? "Don't link this page" : "Link this page";
}

// The ⋯ and + menus: one open at a time, closed by a tap anywhere else
function toggleMenu(role, btn) {
  const m = panel && panel.querySelector(`[data-role="${role}"]`);
  if (!m) return;
  const show = m.hidden;
  closeMenus();
  m.hidden = !show;
  if (btn) btn.setAttribute("aria-expanded", String(show));
}
function closeMenus(e) {
  if (!panel) return;
  ["more", "plus"].forEach((role) => {
    const m = panel.querySelector(`[data-role="${role}"]`);
    if (!m || m.hidden) return;
    if (e && e.target.closest(`[data-role="${role}"], [data-act="${role}"]`)) return;
    m.hidden = true;
    const b = panel.querySelector(`[data-act="${role}"]`);
    if (b) b.setAttribute("aria-expanded", "false");
  });
}

// keep: loading earlier messages (stay on the same message instead of jumping to the bottom)
function startMessages(id, keep = false) {
  stopMessages();
  let first = !keep;
  msgUnsub = watchMessages(id, (msgs) => { drawMessages(msgs, first); first = false; },
    (err) => console.warn("Chat messages failed:", err), msgLimit);
}

function drawMessages(msgs, first) {
  const box = panel && panel.querySelector('[data-role="msgs"]');
  if (!box || view !== "thread") return;
  msgList = msgs;
  // Messages still on their way: shown until the saved copy arrives
  const ids = new Set(msgs.map((m) => m.id));
  const local = [];
  pendingSends.forEach((p, id) => {
    if (ids.has(id)) {   // the saved copy is here
      if (p.img && p.img.url) URL.revokeObjectURL(p.img.url);
      pendingSends.delete(id);
      return;
    }
    if (p.chatId !== openId) return;
    local.push({ id, text: p.text, by: me.name, byUid: me.uid, at: p.at, page: p.page,
      local: true, failed: p.failed, pending: !p.failed && !p.sent,
      patient: (p.extra && p.extra.patient) || null, replyTo: (p.extra && p.extra.replyTo) || null,
      image: p.img ? { local: p.img.url, path: p.img.path || "", w: p.img.w, h: p.img.h } : null });
  });
  const all = msgs.concat(local);
  const newOnes = box._ids ? msgs.filter((m) => !box._ids.has(m.id) && m.byUid !== me.uid).length : 0;
  box._ids = ids;
  if (!all.length) return;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const fromBottom = box.scrollHeight - box.scrollTop;
  const grewAbove = !!box._firstId && all[0].id !== box._firstId && msgs.length > (box._n || 0);   // "Load earlier" arrived
  box._firstId = all[0].id;
  box._n = msgs.length;
  const showBy = !!current && current.kind !== "dm";   // names only where it isn't obvious who's who
  const now = Date.now();
  // The same person, the same day, within 5 minutes: one run
  const linked = (a, b) => !!a && !!b && a.byUid === b.byUid && !!a.at && !!b.at
    && keyOf(a.at) === keyOf(b.at) && b.at - a.at < 5 * 60000;
  const more = msgs.length >= msgLimit
    ? '<button type="button" class="ch-earlier" data-act="earlier">Load earlier messages</button>' : "";

  const html = more + all.map((m, i) => {
    const prev = all[i - 1];
    const next = all[i + 1];
    const mine = m.byUid === me.uid;
    const divider = m.at && (!prev || !prev.at || keyOf(prev.at) !== keyOf(m.at))
      ? `<p class="ch-day"><span>${esc(dayLabel(m.at))}</span></p>` : "";
    const runStart = !!divider || !linked(prev, m);
    const runEnd = !linked(m, next);
    const pos = runStart && runEnd ? "" : runStart ? " is-first" : runEnd ? " is-last" : " is-mid";
    const canAct = mine && canWriteNow && !m.deleted && !m.local;
    const canReply = canWriteNow && !m.deleted && !m.local && !m.pending;
    const text = String(m.text || "").trim();
    const pic = m.image && !m.deleted ? imgHtml(m, canAct) : "";
    const quote = m.replyTo && !m.deleted ? `<button type="button" class="ch-q" data-jump="${esc(m.replyTo.id)}" title="Go to the message">
        <b>${esc(m.replyTo.byUid === me.uid ? "You" : (m.replyTo.by || "Message"))}</b>
        <span>${esc(m.replyTo.text || (m.replyTo.image ? "📷 Photo" : "…"))}</span></button>` : "";
    const card = m.patient && !m.deleted ? ptCardHtml(m.patient) : "";
    const plain = !pic && !quote && !card;
    const textHtml = !text ? "" : pic ? `<span class="ch-m-cap">${linkify(m.text)}</span>`
      : plain ? linkify(m.text) : `<span class="ch-m-txt">${linkify(m.text)}</span>`;
    // Hover any bubble for its exact time
    const tipText = m.at ? m.at.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
      + (m.edited && !m.deleted ? " · edited" : "") : "";
    const tip = tipText ? ` title="${esc(tipText)}"` : "";
    const bubble = m.deleted
      ? `<div class="ch-m-b is-deleted"${tip}>Message deleted</div>`
      : `<div class="ch-m-b${pic ? " is-img" : ""}${card ? " has-pt" : ""}${plain && onlyEmoji(text) ? " is-emoji" : ""}"${
          canReply || canAct ? ' data-acts="1" role="button" tabindex="0"' : ""}${tip}>${quote}${pic}${textHtml}${card}</div>`;
    const acts = canReply || canAct ? `<span class="ch-m-acts">${canReply
        ? `<button type="button" data-act="mreply" data-mid="${esc(m.id)}" aria-label="Reply" title="Reply">${I.reply}</button>` : ""}${canAct ? `
        <button type="button" data-act="medit" data-mid="${esc(m.id)}" aria-label="Edit" title="Edit">${I.edit}</button>
        <button type="button" class="is-danger" data-act="mdel" data-mid="${esc(m.id)}" aria-label="Delete" title="Delete">${I.trash}</button>` : ""}</span>` : "";
    const stuck = m.pending && m.at && now - m.at.getTime() > 20000;
    const status = m.failed
      ? `<button type="button" class="ch-m-retry" data-act="retry" data-mid="${esc(m.id)}">Not sent · Tap to retry</button>
         · <button type="button" class="ch-m-retry" data-act="discard" data-mid="${esc(m.id)}">Remove</button>`
      : stuck ? '<span class="ch-m-slow">Still sending… check your connection</span>'
      : m.pending ? "Sending…" : esc(timeOf(m.at));
    const page = m.page && !m.deleted ? `<a href="${esc(m.page.hash)}">${I.link} ${esc(m.page.label || "Page")}</a> · ` : "";
    const showMeta = runEnd || m.failed || m.pending || !!page;   // the time once per run
    return `${divider}<div class="ch-m${mine ? " is-me" : ""}${pos}${m.pending ? " is-pending" : ""}${m.failed ? " is-failed" : ""}${
      m.id === actsOpen ? " is-acts" : ""}" data-mid="${esc(m.id)}">
      ${!mine && showBy && runStart ? `<small class="ch-m-by">${esc(m.by)}</small>` : ""}
      ${bubble}${acts}
      ${showMeta ? `<small class="ch-m-meta">${page}${status}${m.edited && !m.deleted ? " · edited" : ""}</small>` : ""}
    </div>`;
  }).join("") + '<p class="ch-seen" data-role="seen" hidden></p>';

  // Only redrawn when something on screen changed: no flicker, and the buttons stay put
  if (html !== box._html) {
    box._html = html;
    box.innerHTML = html;
    loadImages(box);
  }
  updateSeen();
  applySearch(0, false);
  if (first || atBottom) {
    box.scrollTop = box.scrollHeight;
    setJump(0);
  } else {
    if (grewAbove) box.scrollTop = box.scrollHeight - fromBottom;   // older messages added above: stay on the same one
    if (newOnes) setJump(jumpCount + newOnes);
  }
  if (pendingJump) { const j = pendingJump; pendingJump = ""; jumpTo(j); }
}


// "↓ 2 new messages" while you're scrolled up
function setJump(n) {
  jumpCount = n;
  const b = panel && panel.querySelector('[data-role="jump"]');
  if (!b) return;
  b.hidden = !n;
  b.querySelector("span").textContent = n === 1 ? "1 new message" : `${n} new messages`;
}

/* ---------- Search this chat ---------- */
function openSearch() {
  const bar = panel && panel.querySelector('[data-role="search"]');
  if (!bar) return;
  bar.hidden = false;
  const q = bar.querySelector("input");
  q.focus();
  q.select();
  applySearch(0, true);
}
function closeSearch() {
  const bar = panel && panel.querySelector('[data-role="search"]');
  if (!bar) return;
  bar.hidden = true;
  searchQ = "";
  hitIdx = -1;
  bar.querySelector("input").value = "";
  panel.querySelectorAll(".ch-m.is-hit").forEach((el) => el.classList.remove("is-hit", "is-hit-on"));
}
// move: -1 older, +1 newer, 0 stay. Starts at the newest match.
function applySearch(move = 0, scroll = false) {
  const box = panel && panel.querySelector('[data-role="msgs"]');
  const bar = panel && panel.querySelector('[data-role="search"]');
  if (!box || !bar || bar.hidden) return;
  const q = searchQ.trim().toLowerCase();
  const els = [...box.querySelectorAll(".ch-m")];
  els.forEach((el) => el.classList.remove("is-hit", "is-hit-on"));
  const hits = q ? els.filter((el) => {
    const b = el.querySelector(".ch-m-b");
    return b && !b.classList.contains("is-deleted") && b.textContent.toLowerCase().includes(q);
  }) : [];
  const out = bar.querySelector('[data-role="shits"]');
  if (!hits.length) { hitIdx = -1; out.textContent = q ? "No matches" : ""; return; }
  if (hitIdx < 0 || hitIdx >= hits.length) hitIdx = hits.length - 1;
  hitIdx = (hitIdx + move + hits.length) % hits.length;
  hits.forEach((el) => el.classList.add("is-hit"));
  hits[hitIdx].classList.add("is-hit-on");
  out.textContent = `${hitIdx + 1} of ${hits.length}`;
  if (scroll) hits[hitIdx].scrollIntoView({ block: "center", behavior: "smooth" });
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
  const code = String((err && err.code) || "");
  if (code.startsWith("storage/")) {
    return code === "storage/unauthorized"
      ? "Couldn't upload the picture. Check the chat_images Storage rule has been published."
      : "Couldn't upload the picture. Check your connection and try again.";
  }
  return code === "permission-denied"
    ? "Couldn't save. Check the chats Firestore rule has been published."
    : err && err.message && !err.code ? err.message : "Couldn't send. Check your connection and try again.";
}

async function send(form) {
  if (!current) return;
  const ta = form.querySelector("textarea");
  const text = ta.value.trim();
  hideEmoji();
  if (editing) {
    // Saving an edit to one of my messages (a picture's caption can be emptied)
    const btn = form.querySelector('[type="submit"]');
    if (btn.disabled) return;
    const id = editing;
    const old = msgList.find((x) => x.id === id);
    if (!text && !(old && old.image)) return;
    btn.disabled = true;
    try {
      if (!old || old.deleted) throw new Error("That message can't be edited any more.");
      if (old.text !== text) await editMessage(current.id, id, text, isLastMsg(id), !!old.image);
      stopEdit();
    } catch (err) {
      console.error("Chat edit failed:", err);
      showToast(sendErr(err));
    }
    btn.disabled = false;
    ta.focus();
    return;
  }
  if (!text && !attach && !linkPt) return;
  // A brand-new group is made by its first message, so it starts with words
  if (attach && current.kind === "group" && !chats.some((c) => c.id === current.id)) {
    showToast("Send a message first to start the group, then add pictures.");
    return;
  }
  // A new message: on screen straight away, saved in the background
  const withPage = linkPage;
  const img = attach;
  attach = null;          // the picture now belongs to the message being sent (not revoked here)
  drawAttach();
  ta.value = "";
  ta.style.height = "";
  draftText.delete(current.id);
  const hint = panel.querySelector('[data-role="hint"]');
  if (hint) hint.hidden = true;
  if (!isTouch()) ta.focus();
  const extra = { patient: linkPt, replyTo };
  linkPt = null;
  replyTo = null;
  paintPt();
  paintReply();
  deliver(current, newMessageId(current.id), text, withPage ? pageInfo() : null, img, extra);
}

// img: { blob, url, w, h, type } (+ path once uploaded, so a retry doesn't upload it again)
// extra: { patient, replyTo }
async function deliver(chat, id, text, page, img = null, extra = {}) {
  pendingSends.set(id, { chatId: chat.id, text, page, img, extra, at: new Date(), failed: false, sent: false });
  if (openId === chat.id) redrawMessages(true);
  // Not gone after 20 seconds: say so, instead of "Sending…" forever
  const slow = setTimeout(() => { if (openId === chat.id) redrawMessages(); }, 20500);
  try {
    if (img && !img.path) Object.assign(img, await uploadChatImage(chat.id, id, img));
    await sendMessage(chat, text, page, me, id, img, extra);
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
  clearTimeout(slow);
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

// Tapping one of my messages shows Edit / Delete beside it (on desktop they show on hover)
function toggleMsgActs(bubble) {
  const m = bubble.closest(".ch-m");
  if (!m || !m.querySelector(".ch-m-acts")) return;
  const show = !m.classList.contains("is-acts");
  panel.querySelectorAll(".ch-m.is-acts").forEach((x) => x.classList.remove("is-acts"));
  m.classList.toggle("is-acts", show);
  actsOpen = show ? m.dataset.mid : "";
}

function startEdit(mid) {
  const m = msgList.find((x) => x.id === mid);
  const ta = panel.querySelector(".ch-comp textarea");
  const bar = panel.querySelector('[data-role="editing"]');
  if (!m || m.deleted || !ta || !bar) return;
  if (replyTo) { replyTo = null; paintReply(); }
  editing = mid;
  bar.hidden = false;
  ta.value = m.text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));   // grows the box to fit
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  panel.querySelectorAll(".ch-m.is-acts").forEach((x) => x.classList.remove("is-acts"));
  actsOpen = "";
}

function stopEdit() {
  editing = "";
  const bar = panel && panel.querySelector('[data-role="editing"]');
  if (bar) bar.hidden = true;
  const ta = panel && panel.querySelector(".ch-comp textarea");
  if (ta) {
    ta.value = draftText.get(openId) || "";
    ta.style.height = "";
    if (ta.value) ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
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
    const m = msgList.find((x) => x.id === mid);
    await deleteMessage(current.id, mid, isLastMsg(mid), m && m.image ? m.image.path : "", !!(m && m.patient));
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
  const rank = (s) => ({ online: 0, away: 1 }[presOf(s.id).status] ?? 2);
  const list = staffList.filter((s) => String(s.id) !== me.uid && (!q || String(s.name || "").toLowerCase().includes(q)))
    .sort((a, b) => rank(a) - rank(b) || String(a.name || "").localeCompare(String(b.name || "")));
  box.innerHTML = list.map((s) => `<button type="button" class="ch-row" data-dm="${esc(s.id)}">${avatar(s.name, "", s.id)}
      <span class="ch-row-main"><strong>${esc(s.name)}</strong><small class="ch-row-last${presOf(s.id).status === "online" ? " is-online" : ""}">${
        esc([s.role, presText(s.id)].filter(Boolean).join(" · "))}</small></span></button>`).join("")
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
      <input type="checkbox" data-gsel="${esc(s.id)}"${groupSel.has(String(s.id)) ? " checked" : ""} />${avatar(s.name, "", s.id)}
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
  closeMenus(e);
  // A tap on the header (not one of its buttons or menus) folds it down or opens it again
  if (e.target.closest(".ch-hd") && !e.target.closest("button, a, input, label, .ch-menu")) { setMin(!minimized); return; }
  // A link in a message just opens. Portal links (and patient cards) fold the chat down so the page shows.
  const msgLink = e.target.closest(".ch-m-b a");
  if (msgLink) { if ((msgLink.getAttribute("href") || "").startsWith("#/")) setMin(true); return; }
  const t = e.target.closest("[data-act],[data-open],[data-dm],[data-pick],[data-back],[data-emo],[data-acts],[data-reply],[data-zoom],[data-jump],[data-ptpick]");
  if (!t || !me) return;
  if (t.dataset.zoom !== undefined) { zoomImage(t); return; }
  if (t.dataset.emo) { insertEmoji(t.dataset.emo); return; }
  if (t.dataset.open) { hidePop(); openThread(t.dataset.open); return; }
  if (t.dataset.dm) { startDm(t.dataset.dm); return; }
  if (t.dataset.pick) { pickMany(t.dataset.pick); return; }
  if (t.dataset.back) { const f = panel.querySelector('[name="back"]'); if (f) f.value = t.dataset.back; return; }
  if (t.dataset.jump) { jumpTo(t.dataset.jump); return; }
  if (t.dataset.ptpick) { pickPatient(t.dataset.ptpick); return; }
  if (t.dataset.acts) { toggleMsgActs(t); return; }
  if (t.dataset.reply) { quickReply(t.dataset.reply); return; }
  switch (t.dataset.act) {
    case "toggle":
      if (isOpen()) hidePanel(); else { showPanel(); drawList(); }
      break;
    case "close": hidePanel(); break;
    case "min": setMin(!minimized); break;
    case "mreply": startReply(t.dataset.mid); break;
    case "unreply": replyTo = null; paintReply(); break;
    case "ptlink": openPtPick(); break;
    case "ptclose": closePtPick(); break;
    case "ptunlink": linkPt = null; paintPt(); break;
    case "earlier": msgLimit += PAGE; startMessages(openId, true); break;
    case "more": toggleMenu("more", t); break;
    case "plus": toggleMenu("plus", t); break;
    case "cmute": {
      if (!current) break;
      const on = !chatMuted(current.id);
      try { localStorage.setItem(chatMuteKey(current.id), on ? "1" : "0"); } catch { /* ignore */ }
      t.innerHTML = `${on ? I.bell : I.bellOff}<span>${on ? "Unmute this chat" : "Mute this chat"}</span>`;
      closeMenus();
      showToast(on ? "Chat muted. It still shows in the red count." : "Sound back on for this chat");
      break;
    }
    case "search": closeMenus(); openSearch(); break;
    case "sprev": applySearch(-1, true); break;
    case "snext": applySearch(1, true); break;
    case "sclose": closeSearch(); break;
    case "linkpage": linkPage = !linkPage; paintLink(); closeMenus(); break;
    case "unlink": linkPage = false; paintLink(); break;
    case "jump": {
      const box = panel.querySelector('[data-role="msgs"]');
      if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
      setJump(0);
      break;
    }
    case "back": clearAttach(); stopMessages(); drawList(); break;
    case "attach": { closeMenus(); const f = panel.querySelector('[data-role="file"]'); if (f) f.click(); break; }
    case "unattach": clearAttach(); break;
    case "new": drawNew(); break;
    case "group": drawGroup(); break;
    case "mkgroup": createGroup(); break;
    case "all": drawAll(); break;
    case "refreshall": {
      const ok = await confirmDialog({
        title: "Update everyone's portal?",
        message: "Every open portal refreshes to get your latest changes. Anyone recording, handing a form to a patient, "
          + "or typing is refreshed once they've finished. Push your changes to GitHub first, and wait about a minute for them to go live.",
        confirmLabel: "Update everyone",
      });
      if (!ok) break;
      try {
        await requestRefresh(me);
        showToast("Sent. Open portals will refresh within the next minute or so. Press Ctrl+Shift+R to refresh this one.");
      } catch (err) {
        console.error("Refresh request failed:", err);
        showToast(err && err.code === "permission-denied"
          ? "Couldn't send. Check the app_settings Firestore rule lets admins write."
          : "Couldn't send. Try again.");
      }
      break;
    }
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
      if (chat) deliver(chat, t.dataset.mid, p.text, p.page, p.img, p.extra);
      break;
    }
    case "discard": {
      const p = pendingSends.get(t.dataset.mid);
      if (p && p.img && p.img.url) URL.revokeObjectURL(p.img.url);
      pendingSends.delete(t.dataset.mid);
      redrawMessages();
      break;
    }
    case "hide": closeMenus(); hideThread(); break;
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
  if (e.key === "Escape" && isOpen() && !minimized) {
    if (panel.querySelector(".ch-menu:not([hidden])")) { closeMenus(); return; }
    const sb = panel.querySelector('[data-role="search"]');
    if (sb && !sb.hidden) { closeSearch(); return; }
    const pp = panel.querySelector('[data-role="ptpick"]');
    if (pp && !pp.hidden) { closePtPick(); return; }
    if (replyTo) { replyTo = null; paintReply(); return; }
    const emo = panel.querySelector('[data-role="emo"]');
    if (emo && !emo.hidden) { emo.hidden = true; return; }
    if (editing) { stopEdit(); return; }
    hidePanel();
    root.querySelector(".ch-bubble").focus();
    return;
  }
  // Keyboard: Enter on one of my messages shows Edit / Delete
  if (e.key === "Enter" && e.target.matches("[data-acts]")) {
    e.preventDefault();
    toggleMsgActs(e.target);
    return;
  }
  // Enter sends, Shift + Enter starts a new line. On phones and iPads Enter is a new line (the Send button sends).
  // Not while a word is still being typed (predictive text, accents).
  // Link a patient: Enter picks the top one
  if (e.key === "Enter" && e.target.dataset.role === "ptq") {
    e.preventDefault();
    const box = e.target.closest('[data-role="ptpick"]');
    const res = box && box.querySelector('[data-role="ptres"]');
    const first = box && box.querySelector(res && !res.hidden ? '[data-role="ptres"] .ch-pp-row' : '[data-role="ptrecent"] .ch-pp-row');
    if (first) first.click();
    return;
  }
  // Search: Enter for the next older match, Shift + Enter for newer
  if (e.key === "Enter" && e.target.dataset.role === "sq") {
    e.preventDefault();
    applySearch(e.shiftKey ? 1 : -1, true);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch() && e.target.matches(".ch-comp textarea")) {
    e.preventDefault();
    if (e.target.value.trim()) usedHint();
    e.target.form.requestSubmit();
  }
}

function onInput(e) {
  if (e.target.matches(".ch-comp textarea")) {
    // Grows as you type, up to about 6 lines; a scrollbar only after that
    const MAX = 160;
    e.target.style.height = "";
    e.target.style.height = `${Math.min(MAX, e.target.scrollHeight + 2)}px`;
    e.target.style.overflowY = e.target.scrollHeight > MAX ? "auto" : "hidden";
    // Kept as a draft for this chat (not while editing an old message)
    if (!editing) {
      if (e.target.value) draftText.set(openId, e.target.value); else draftText.delete(openId);
    }
    const hint = panel.querySelector('[data-role="hint"]');
    if (hint) hint.hidden = !(e.target.value.trim() && hintsLeft());
  } else if (e.target.dataset.role === "ptq") {
    onPtSearch(e.target.value);
  } else if (e.target.dataset.role === "sq") {
    searchQ = e.target.value;
    hitIdx = -1;
    applySearch(0, true);
  } else if (e.target.dataset.role === "find") {
    drawPeople(e.target.value.trim().toLowerCase());
  } else if (e.target.dataset.role === "gfind") {
    drawGroupPeople(e.target.value.trim().toLowerCase());
  }
}

function onChange(e) {
  if (e.target.dataset.role === "file") {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) setAttach(f);
    return;
  }
  const id = e.target.dataset.gsel;
  if (!id) return;
  if (e.target.checked) groupSel.add(id); else groupSel.delete(id);
  syncGroupCount();
}