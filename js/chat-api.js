// Chat: Help (staff → the admins) and messages between staff.
// chats/<id>: one per conversation (help__<staffUid>, or dm__<uidA>__<uidB> sorted), with its messages under it.
// Members read and write their own chats; Admins can read every chat and answer Help.
// People can edit or delete their own messages; anyone can remove a chat from their own list.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, onSnapshot, query, where, orderBy, limitToLast, writeBatch, updateDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const uid = () => {
  const u = auth.currentUser && auth.currentUser.uid;
  if (!u) throw new Error("Your session has ended. Log in again.");
  return u;
};
const PAGE_RE = /^#\/[\w\-/%.~]*$/;
const dates = (m) => {
  const out = {};
  Object.entries(m || {}).forEach(([k, v]) => { out[k] = toDate(v); });
  return out;
};

export const helpId = (staffUid) => `help__${staffUid}`;
export const dmId = (a, b) => `dm__${[a, b].sort().join("__")}`;
// A message id made in the browser, so the message can show on screen before it's saved
export const newMessageId = (chatId) => doc(collection(db, "chats", chatId, "messages")).id;
// Only links inside the portal (#/…) are kept
export const safePage = (p) => (p && PAGE_RE.test(String(p.hash || ""))
  ? { hash: String(p.hash).slice(0, 300), label: String(p.label || "").slice(0, 80) } : null);

function normChat(d) {
  const x = d.data({ serverTimestamps: "estimate" }) || {};
  return {
    id: d.id, kind: ["help", "dm", "group"].includes(x.kind) ? x.kind : "dm",
    name: String(x.name || ""), createdByUid: String(x.createdByUid || ""),
    members: Array.isArray(x.members) ? x.members.map(String) : [], names: x.names || {},
    lastText: String(x.lastText || ""), lastAt: toDate(x.lastAt), lastBy: String(x.lastBy || ""),
    lastByName: String(x.lastByName || ""), status: x.status === "sorted" ? "sorted" : "open",
    readAt: dates(x.readAt), hiddenAt: dates(x.hiddenAt),
  };
}
// Someone else wrote last, after I last read it
export const isUnread = (c, me) => !!c.lastAt && c.lastBy !== me && (!c.readAt[me] || c.readAt[me] < c.lastAt);
// I removed it from my list, and nothing new has arrived since
export const isHiddenFor = (c, me) => {
  const h = c.hiddenAt && c.hiddenAt[me];
  return !!h && (!c.lastAt || c.lastAt <= h);
};

// My conversations, live. Admins also get every Help conversation.
export function watchChats(me, admin, onChange, onError = () => {}) {
  const col = collection(db, "chats");
  let mine = new Map();
  let help = new Map();
  const emit = () => onChange([...new Map([...help, ...mine]).values()]);
  const subs = [onSnapshot(query(col, where("members", "array-contains", me)),
    (s) => { mine = new Map(s.docs.map((d) => [d.id, normChat(d)])); emit(); }, onError)];
  if (admin) {
    subs.push(onSnapshot(query(col, where("kind", "==", "help")),
      (s) => { help = new Map(s.docs.map((d) => [d.id, normChat(d)])); emit(); }, onError));
  }
  return () => subs.forEach((u) => u());
}

// Admins: every conversation, including chats between other staff
export async function listAllChats() {
  const s = await getDocs(collection(db, "chats"));
  return s.docs.map(normChat);
}

// The latest 150 messages of one conversation, live, oldest first. pending: not saved on the server yet.
export function watchMessages(chatId, onChange, onError = () => {}) {
  return onSnapshot(query(collection(db, "chats", chatId, "messages"), orderBy("at"), limitToLast(150)),
    { includeMetadataChanges: true }, (s) => {
      onChange(s.docs.map((d) => {
        const x = d.data({ serverTimestamps: "estimate" }) || {};
        return { id: d.id, text: String(x.text || ""), by: String(x.by || ""), byUid: String(x.byUid || ""),
          at: toDate(x.at), page: safePage(x.page), edited: x.edited === true, deleted: x.deleted === true,
          pending: d.metadata.hasPendingWrites };
      }));
    }, onError);
}
// The conversation (created on the first message) and the message, together
export async function sendMessage(chat, text, page, staff, msgId = "") {
  const me = uid();
  const by = String((staff && staff.name) || "").slice(0, 120);
  const body = String(text || "").trim().slice(0, 4000);
  if (!body) throw new Error("Type a message first.");
  const cRef = doc(db, "chats", chat.id);
  const b = writeBatch(db);
  b.set(cRef, {
    kind: chat.kind, members: chat.members, names: { ...(chat.names || {}), [me]: by },
    lastText: body.slice(0, 200), lastAt: serverTimestamp(), lastBy: me, lastByName: by,
    readAt: { [me]: serverTimestamp() }, updatedAt: serverTimestamp(),
    ...(chat.kind === "help" && chat.members[0] === me ? { status: "open" } : {}),   // a new Help message reopens it
    ...(chat.kind === "group" ? { name: String(chat.name || "").slice(0, 60), createdByUid: chat.createdByUid } : {}),
  }, { merge: true });
  const mRef = msgId ? doc(cRef, "messages", msgId) : doc(collection(cRef, "messages"));
  b.set(mRef, { text: body, by, byUid: me, at: serverTimestamp(), page: safePage(page) });
  await b.commit();
}

// My own message, changed. If it's the latest one, the chat list preview changes too
// (lastAt stays the same, so nobody gets a new-message alert).
export async function editMessage(chatId, msgId, text, isLast) {
  uid();
  const body = String(text || "").trim().slice(0, 4000);
  if (!body) throw new Error("Type a message first.");
  const b = writeBatch(db);
  b.update(doc(db, "chats", chatId, "messages", msgId), { text: body, edited: true, editedAt: serverTimestamp() });
  if (isLast) b.update(doc(db, "chats", chatId), { lastText: body.slice(0, 200), updatedAt: serverTimestamp() });
  await b.commit();
}

// My own message, deleted for everyone. It keeps its place in the conversation as "Message deleted".
export async function deleteMessage(chatId, msgId, isLast) {
  uid();
  const b = writeBatch(db);
  b.update(doc(db, "chats", chatId, "messages", msgId), { text: "", page: null, deleted: true, deletedAt: serverTimestamp() });
  if (isLast) b.update(doc(db, "chats", chatId), { lastText: "Message deleted", updatedAt: serverTimestamp() });
  await b.commit();
}

// Removes a chat from MY list only (it comes back when a new message arrives)
export async function hideChat(chatId) {
  const me = uid();
  await updateDoc(doc(db, "chats", chatId), {
    [`hiddenAt.${me}`]: serverTimestamp(),
    [`readAt.${me}`]: serverTimestamp(),
  });
}

export async function markRead(chatId) {
  await updateDoc(doc(db, "chats", chatId), { [`readAt.${uid()}`]: serverTimestamp() });
}

// Admins: a Help conversation is "sorted", or reopened
export async function setChatStatus(chatId, status) {
  await updateDoc(doc(db, "chats", chatId), { status: status === "sorted" ? "sorted" : "open", updatedAt: serverTimestamp() });
}

// A new group's id (the group is created with its first message)
export const newGroupId = () => `group__${doc(collection(db, "chats")).id}`;

// "Away" for Help: app_settings/chat → { away: { on, back: "YYYY-MM-DD", note } }
export function watchAway(onChange) {
  return onSnapshot(doc(db, "app_settings", "chat"), (s) => {
    const a = (s.exists() && s.data().away) || {};
    onChange({ on: a.on === true, back: /^\d{4}-\d{2}-\d{2}$/.test(a.back || "") ? a.back : "", note: String(a.note || "") });
  }, (err) => console.warn("Chat away status failed:", err));
}

export async function saveAway({ on, back = "", note = "" }, staff) {
  await setDoc(doc(db, "app_settings", "chat"), {
    away: { on: on === true, back: on ? String(back || "") : "", note: on ? String(note || "").trim().slice(0, 120) : "" },
    updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120),
  }, { merge: true });
}