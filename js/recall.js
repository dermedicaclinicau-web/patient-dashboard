// Recall (#/recall): patients due for their next treatment, worked by the recall team.
// The cards (recalls/{id}) are made, booked and closed by Apps Script (Code.gs → Recall) from the appointment book.
// Every change goes through Apps Script (action "recall"), so each card keeps a full history.
// Only the tab on screen is loaded, 50 at a time; the numbers come from Firestore count queries.
// With a Last visit filter on, each tab is one list sorted by last visit (Firestore can only sort by the date it filters on).
// Logging a call: tap what happened. It saves after 5 seconds (Undo until then). After No answer or Left voicemail
// a text is offered (Recall settings → Texts → After a missed call).
import { db, auth } from "./firebase-config.js";
import { collection, query, where, orderBy, limit, onSnapshot, getDocs, getDoc, doc, getCountFromServer }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { normRecallSettings } from "./recall-settings.js";
import { installRecallEmail, openRecallEmail } from "./recall-email.js"; installRecallEmail();

const COL = "recalls";
const PAGE = 50;
const UNDO_MS = 5000;
const OUTCOMES = [["no_answer", "No answer"], ["voicemail", "Left voicemail"], ["spoke", "Spoke to them"],
  ["texted", "Sent a text"], ["booked", "Booked"]];
const LABEL = Object.fromEntries(OUTCOMES);
// The answers to "What happened?" [outcome, label, key]. A text sent with the Text button logs itself.
const TILES = [["no_answer", "No answer", "N"], ["voicemail", "Left voicemail", "V"], ["spoke", "Spoke to them", "S"], ["booked", "Booked", "B"]];
const MISSED = new Set(["no_answer", "voicemail"]);
const GROUPS = [["just", "Just due · last 30 days", (d) => d <= 30], ["over", "Overdue · 1 to 6 months", (d) => d > 30 && d <= 182],
  ["lapsed", "Lapsed · over 6 months", (d) => d > 182]];
const LV_OPTS = [["", "Any time"], ["3", "Past 3 months"], ["3-6", "3 to 6 months ago"],
  ["6-12", "6 to 12 months ago"], ["12+", "Over a year ago"], ["custom", "Choose dates…"]];
const APPT_OPTS = [["", "Any"], ["yes", "Has one booked"], ["no", "None booked"]];
const PICKS = [["Tomorrow", (t) => addDays(t, 1)], ["Next week", (t) => addDays(t, 7)],
  ["2 weeks", (t) => addDays(t, 14)], ["1 month", (t) => addMonths(t, 1)]];

const REPLY_TAG = { yes: "Wants to book", stop: "Opted out", other: "Replied" };
const STOP_LINE = "Reply STOP to opt out.";
const withStop = (t) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return /reply\s+stop/i.test(s) ? s : `${s}${s ? " " : ""}${STOP_LINE}`; };
const smsCount = (t) => {
  const n = withStop(t).length;
  const parts = n <= 160 ? 1 : Math.ceil(n / 153);
  return `${n} characters · ${parts} text${parts === 1 ? "" : "s"}`;
};
const smsInfo = (t) => `${smsCount(t)}${/reply\s+stop/i.test(String(t || "")) ? "" : ` · "${STOP_LINE}" is added at the end`}`;

/* ---------- Icons ---------- */
const svg = (p, w = 2) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const PHONE = '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>';
const I = {
  phone: svg(PHONE),
  phoneOff: svg(`${PHONE}<line x1="2" y1="2" x2="22" y2="22"/>`),
  voicemail: svg('<circle cx="6" cy="12" r="4"/><circle cx="18" cy="12" r="4"/><line x1="6" y1="16" x2="18" y2="16"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  msg: svg('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>'),
  cal: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 16 11 18 15 14"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>'),
  user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>', 2.4),
  undo: svg('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
  send: svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  filter: svg('<polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3"/>'),
  ban: svg('<circle cx="12" cy="12" r="9"/><line x1="5.7" y1="5.7" x2="18.3" y2="18.3"/>'),
  reply: svg('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
  dot: svg('<circle cx="12" cy="12" r="3"/>'),
  chev: svg('<polyline points="6 9 12 15 18 9"/>'),
};
const TILE_ICON = { no_answer: I.phoneOff, voicemail: I.voicemail, spoke: I.chat, booked: I.cal };
const histIcon = (w) => {
  const s = String(w || "").toLowerCase();
  return /repl/.test(s) ? I.reply : /voicemail/.test(s) ? I.voicemail : /no answer/.test(s) ? I.phoneOff
    : /spoke/.test(s) ? I.chat : /book/.test(s) ? I.cal : /email/.test(s) ? I.mail : /text|sms/.test(s) ? I.msg
    : /given|assign|shared/.test(s) ? I.user : /stop|close|pause/.test(s) ? I.ban : /call back/.test(s) ? I.clock : I.dot;
};

/* ---------- Helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayKey = () => fmtKey(new Date());
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (k, n) => { const d = keyDate(k); d.setDate(d.getDate() + n); return fmtKey(d); };
const addMonths = (k, n) => {
  const d = keyDate(k);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return fmtKey(d);
};
const nice = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const short = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : ""; };
const dayOf = (iso) => { const d = new Date(iso || ""); return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }); };
const daysFrom = (a, b) => { const x = keyDate(a), y = keyDate(b); return x && y ? Math.round((y - x) / 86400000) : 0; };
const when = (iso) => { const d = new Date(iso || ""); return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
const first = (n) => String(n || "").split(" ")[0];
const plural = (n, w) => `${Number(n).toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
// "Victoria Winters}}" → "Victoria Winters": stray brackets and marks from the appointment book are dropped
const cleanName = (s) => String(s || "").replace(/[{}[\]<>|\\~^*_=+#]+/g, " ").replace(/\s+/g, " ").trim()
  .replace(/^[^\p{L}(]+|[^\p{L})'.]+$/gu, "").trim();
// "Xuan (shwen) Ting" → "XT": nicknames in brackets or quotes and stray marks are ignored
const initials = (n) => {
  const w = String(n || "").replace(/\([^)]*\)|\[[^\]]*\]|"[^"]*"/g, " ").split(/\s+/)
    .map((x) => x.replace(/[^A-Za-z']/g, "")).filter((x) => /[A-Za-z]/.test(x));
  return w.length ? (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase() : "?";
};
// Same treatment = same avatar colour
const hue = (s) => { let h = 0; for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 6; };
// "61414498026" → "0414 498 026"; anything else is shown as it is
const mobileText = (m) => {
  let d = String(m || "").replace(/\D/g, "");
  if (/^614\d{8}$/.test(d)) d = `0${d.slice(2)}`;
  if (/^4\d{8}$/.test(d)) d = `0${d}`;
  return /^04\d{8}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : String(m || "").trim();
};
const telOf = (m) => mobileText(m).replace(/[^\d+]/g, "");
const isMobile = (m) => /^04\d{8}$/.test(telOf(m));
const me = () => (auth.currentUser && auth.currentUser.uid) || "";
const can = (staff, p) => !!staff && (/^admin$/i.test(String(staff.role || "")) || (Array.isArray(staff.perms) && staff.perms.includes(p)));
const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' -]/g, " ").replace(/\s+/g, " ").trim(); // same as recallKeys_
const blank = () => ({ note: "", remind: "", reason: "", until: "", sms: null });
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to Recall. Check Recall access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);
const dncTitle = (c) => `On the do-not-contact list${c.dncWhy ? ` (${c.dncWhy})` : ""}. ` +
  "No recall texts or emails. Calls and messages about their care are fine.";
const getPref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* not essential */ } };
// The note box grows with what's typed (up to 240px, then it scrolls)
const grow = (ta) => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`; };
const textedAt = (c) => { const d = new Date(c.lastTextAt || ""); return isNaN(d) ? 0 : d.getTime(); };

// Redraws a box without losing the cursor: the focused field (by data-role) and its selection come back
function keepFocus(box, fn) {
  const ae = document.activeElement;
  const role = ae && box.contains(ae) && ae.dataset ? ae.dataset.role || "" : "";
  let a = null, b = null;
  try { if (role && typeof ae.selectionStart === "number") { a = ae.selectionStart; b = ae.selectionEnd; } } catch { /* not a text box */ }
  const top = box.scrollTop;
  fn();
  box.scrollTop = top;
  if (!role) return;
  const el = box.querySelector(`[data-role="${role}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (a != null) { try { el.setSelectionRange(a, b); } catch { /* not a text box */ } }
}

function dueText(c, t) {
  if (c.status === "booked") return c.bookedFor ? `Booked for ${short(c.bookedFor)}` : "Booked by phone";
  if (c.stage === "later") return c.pauseReason ? `Paused until ${short(c.remindOn)}` : `Call back ${short(c.remindOn)}`;
  const d = daysFrom(c.dueDate, t);
  if (d < 0) return `Due in ${plural(-d, "day")}`;
  if (d === 0) return "Due today";
  if (d < 60) return `Due ${plural(d, "day")} ago`;
  return `${plural(Math.round(d / 30.4), "month")} overdue`;
}
function lateness(c, t) {
  if (c.status !== "open" || c.stage === "later") return "";
  const d = daysFrom(c.dueDate, t);
  return d > 182 ? "is-old" : d > 30 ? "is-late" : "";
}
// The coloured edge on each row: teal just due, amber overdue, red lapsed
function rail(c, t) {
  if (c.status !== "open" || c.stage === "later") return "";
  const d = daysFrom(c.dueDate, t);
  return d > 182 ? "r-old" : d > 30 ? "r-late" : "r-due";
}

function norm(snap) {
  const x = snap.data() || {};
  const s = (k) => String(x[k] || "");
  return {
    id: snap.id, patientId: s("patientId"), patientName: cleanName(x.patientName), mobile: s("mobile"), email: s("email"),
    category: s("category"), lastVisit: s("lastVisit"), lastStaff: s("lastStaff"),
    lastServices: Array.isArray(x.lastServices) ? x.lastServices.map(String) : [],
    dueDate: s("dueDate"), status: s("status") || "open", stage: s("stage") || "due",
    assignedToId: s("assignedToId"), assignedToName: s("assignedToName"), remindOn: s("remindOn"), pauseReason: s("pauseReason"),
    attempts: Number(x.attempts) || 0, bookedFor: s("bookedFor"), bookedAt: s("bookedAt"),
    closeReason: s("closeReason"), closedAt: s("closedAt"), closedBy: s("closedBy"),
    reply: x.reply && typeof x.reply === "object"
      ? { at: String(x.reply.at || ""), text: String(x.reply.text || ""), kind: String(x.reply.kind || "other") } : null,
    replyOpen: x.replyOpen === true, months: Number(x.months) || 0,
    lastTextAt: s("lastTextAt"), textHoldUntil: s("textHoldUntil"), texts: Number(x.texts) || 0,
    flowState: s("flowState"), flowDueAt: Number(x.flowDueAt) || 0,
    joinedCat: s("joinedCat"), alsoDue: Array.isArray(x.alsoDue) ? x.alsoDue.map(String) : [],
    dnc: x.dnc === true, dncWhy: s("dncWhy"), nextAppt: s("nextAppt"), callBackDue: s("callBackDue"),
    log: Array.isArray(x.log) ? x.log : [], updatedAt: s("updatedAt"),
  };
}

export function mountRecall(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page rc";
  root.innerHTML = `
    <div class="rc-top"><h2>Recall</h2><span class="inv-spacer"></span>
      <a class="lh-btn is-quiet" href="#/recall/messages">Texts & emails</a>
      ${can(staff, "recall.manage") ? '<a class="lh-btn is-quiet" href="#/recall/results">Results</a>' : ""}
      ${can(staff, "recall.manage") ? '<a class="lh-btn is-quiet" href="#/settings/recall">Recall settings</a>' : ""}</div>
    <div class="rc-stats2" data-role="stats"></div>
    <div class="rc-bar">
      <div class="rc-tabs" data-role="tabs" role="tablist"></div>
      <details class="rc-filters" data-role="filters">
        <summary class="lh-btn is-quiet">${I.filter}<span>Filters</span><span data-role="fcount"></span></summary>
        <div class="rc-fpop">
          <label class="rc-f-row" data-role="whoRow"><span>Whose calls</span>
            <select class="fb-select" data-role="who" aria-label="Whose calls"></select></label>
          <div class="rc-f-row"><span>Last visit</span><span class="rc-lv" data-role="lvbox"></span></div>
          <label class="rc-f-row"><span>Upcoming visit</span>
            <select class="fb-select" data-role="appt" aria-label="Upcoming visit">${APPT_OPTS.map(([k, l]) =>
              `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
        </div>
      </details>
      <span class="inv-spacer"></span>
      <input type="search" class="fe-input rc-q" data-role="q" placeholder="Find a patient by name, mobile or email" aria-label="Find a patient" />
    </div>
    <div class="rc-chips"><div class="rc-actives" data-role="active"></div><div class="rc-cats" data-role="chips"></div></div>
    <div class="rc-layout">
      <div data-role="list"></div>
      <aside class="tb-card rc-panel" data-role="panel" aria-label="Recall card" hidden></aside>
    </div>
    <div class="rc-ub" data-role="undo" role="status" aria-live="polite" hidden></div>`;
  container.replaceChildren(root);
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);

  const ui = { tab: "mine", who: "mine", cat: "", q: "", lv: "", lvFrom: "", lvTo: "", appt: "" };
  const apptWhere = () => (ui.appt ? [where("hasAppt", "==", ui.appt === "yes")] : []);
  let settings = normRecallSettings({});
  let people = [];
  let sections = [];
  let found = null;          // search results (null when not searching)
  let searching = false;
  const extra = new Map();   // cards that have left the list, still open in the panel
  let counts = {};
  let chipCounts = {};
  let sel = "";
  let seenSel = false;
  let panelSig = "", panelId = "";
  let moreOpen = false;
  let draft = blank();
  const saving = new Map();   // card id → what's being saved ("Saving: No answer")
  let autoNext = getPref("rc_autonext", true);
  let countTimer = 0, countSeq = 0, searchTimer = 0, searchSeq = 0;
  let jumpTo = "";            // a group to scroll to once My calls has loaded ("replies", "callbacks")

  // The call just logged: saved after UNDO_MS unless Undo is pressed. One at a time.
  let pend = null;            // { id, first, label, body, kept, deadline, timer, tick, auto }
  let bar = null;             // the bar at the bottom: { id, first, text, state: wait | saving | saved | failed, sent }
  let offer = null;           // the text (or email) offered after a missed call
  let quietNote = "";
  let barHide = 0;

  /* ---------- Last visit filter ---------- */
  function lvRange() {
    const t = todayKey();
    switch (ui.lv) {
      case "3": return { from: addMonths(t, -3), to: t };
      case "3-6": return { from: addMonths(t, -6), to: addDays(addMonths(t, -3), -1) };
      case "6-12": return { from: addMonths(t, -12), to: addDays(addMonths(t, -6), -1) };
      case "12+": return { from: "", to: addDays(addMonths(t, -12), -1) };
      case "custom": {
        let a = ui.lvFrom, b = ui.lvTo;
        if (a && b && a > b) [a, b] = [b, a];
        return a || b ? { from: a, to: b } : null;
      }
      default: return null;
    }
  }
  const lvWhere = (r) => [...(r.from ? [where("lastVisit", ">=", r.from)] : []), ...(r.to ? [where("lastVisit", "<=", r.to)] : [])];

  /* ---------- What each tab loads ---------- */
  function tabBase(tab) {
    if (tab === "mine") {
      const w = [where("status", "==", "open"), where("stage", "==", "call")];
      if (ui.who === "mine") w.push(where("assignedToId", "==", me()));
      else if (ui.who !== "all") w.push(where("assignedToId", "==", ui.who));
      return w;
    }
    if (tab === "waiting") return [where("status", "==", "open"), where("stage", "==", "due")];
    if (tab === "later") return [where("status", "==", "open"), where("stage", "==", "later")];
    return [where("status", "==", "booked")];
  }
  function tabSections() {
    const t = todayKey(), d30 = addDays(t, -30), d182 = addDays(t, -182);
    const base = [...tabBase(ui.tab), ...(ui.cat ? [where("category", "==", ui.cat)] : []), ...apptWhere()];
    const lv = lvRange();
    if (lv) return [{ key: ui.tab, title: "", where: [...base, ...lvWhere(lv)], order: ["lastVisit", "desc"] }];
    const due = ["dueDate", "desc"];
    if (ui.tab === "waiting") return [
      { key: "just", title: "Just due · last 30 days", where: [...base, where("dueDate", ">=", d30)], order: due },
      { key: "over", title: "Overdue · 1 to 6 months", where: [...base, where("dueDate", "<", d30), where("dueDate", ">=", d182)], order: due },
      { key: "lapsed", title: "Lapsed · over 6 months", where: [...base, where("dueDate", "<", d182)], order: due, lazy: true },
    ];
    if (ui.tab === "later") return [{ key: "later", title: "", where: base, order: ["remindOn", "asc"] }];
    if (ui.tab === "booked") return [{ key: "booked", title: "", where: base, order: ["bookedFor", "asc"] }];
    return [{ key: "mine", title: "", where: base, order: due }];
  }

  const inRows = (id) => sections.some((s) => s.rows.some((x) => x.id === id));
  function findCard(id) {
    for (const s of sections) { const c = s.rows.find((x) => x.id === id); if (c) return c; }
    return extra.get(id) || (found && found.find((x) => x.id === id)) || null;
  }
  const busyLabel = (id) => saving.get(id) || (pend && pend.id === id ? `Saving: ${pend.label}` : "");

  function stopAll() { sections.forEach((s) => { if (s.stop) s.stop(); s.stop = null; }); }

  function listen(sec) {
    if (sec.stop) sec.stop();
    const q = query(collection(db, COL), ...sec.where, orderBy(sec.order[0], sec.order[1]), limit(sec.n));
    sec.stop = onSnapshot(q, (snap) => {
      if (!root.isConnected) { stopAll(); return; }
      sec.rows = snap.docs.map(norm);
      sec.more = snap.size >= sec.n;
      sec.loaded = true;
      sec.error = "";
      const here = sel ? inRows(sel) : false;
      if (sel && seenSel && !here) keepOpen(sel);   // the open card has left this list
      seenSel = here;
      drawList();
      drawPanel(false);
      drawStats();
      if (jumpTo && sec.key === "mine") { const g = jumpTo; jumpTo = ""; scrollGroup(g); }
      scheduleCounts();
    }, (err) => {
      if (!root.isConnected) return;
      console.error("Recall list failed. If this mentions an index, open the link to create it:", err);
      sec.loaded = true;
      sec.error = /index/i.test(String(err && err.message)) ? "This list needs a Firestore index. An Admin can create it from the link in the browser console."
        : errText(err, "Couldn't load this list.");
      drawList();
    });
  }

  function drawBar() { drawTabs(); drawWho(); drawLv(); drawFilters(); drawChips(); }
  function build() {
    stopAll();
    sections = tabSections().map((s) => ({ ...s, n: PAGE, rows: [], loaded: false, more: false, error: "", open: !s.lazy, count: null, stop: null }));
    sections.filter((s) => s.open).forEach(listen);
    drawBar(); drawList(); drawPanel(true);
    scheduleCounts(0);
  }

  /* ---------- Numbers ---------- */
  const countOf = async (cons) => {
    try { return (await getCountFromServer(query(collection(db, COL), ...cons))).data().count; }
    catch (err) { console.warn("Recall count failed. If this mentions an index, open the link to create it:", err); return null; }
  };
  function scheduleCounts(delay = 1500) { clearTimeout(countTimer); countTimer = setTimeout(loadCounts, delay); }

  async function loadCounts() {
    if (!root.isConnected) return;
    const seq = ++countSeq;
    const t = todayKey(), uid = me();
    const cat = [...(ui.cat ? [where("category", "==", ui.cat)] : []), ...apptWhere()];
    const lv = lvRange();
    const lvc = lv ? [...lvWhere(lv), orderBy("lastVisit", "desc")] : [];   // the same indexes as the lists
    const cats = settings.categories.filter((c) => c.on).map((c) => c.key);
    const mine = [where("status", "==", "open"), where("stage", "==", "call"), where("assignedToId", "==", uid)];
    const jobs = {
      mine: countOf([...tabBase("mine"), ...cat, ...lvc]),
      waiting: countOf([...tabBase("waiting"), ...cat, ...lvc]),
      later: countOf([...tabBase("later"), ...cat, ...lvc]),
      booked: countOf([...tabBase("booked"), ...cat, ...lvc]),
      logged: countOf([where("lastCallBy", "==", uid), where("lastCallDay", "==", t)]),
      replies: countOf([...mine, where("replyOpen", "==", true)]),
      callBacks: countOf([...mine, where("callBackDue", ">", ""), where("callBackDue", "<=", t), orderBy("callBackDue")]),
      bookedMonth: countOf([where("bookedAt", ">=", keyDate(`${t.slice(0, 8)}01`).toISOString())]),
    };
    cats.forEach((k) => { jobs[`cat:${k}`] = countOf([...tabBase(ui.tab), where("category", "==", k), ...apptWhere(), ...lvc]); });
    sections.forEach((s) => { if (s.title) jobs[`sec:${s.key}`] = countOf([...s.where, orderBy(s.order[0], s.order[1])]); });
    const keys = Object.keys(jobs);
    const vals = await Promise.all(keys.map((k) => jobs[k]));
    if (seq !== countSeq || !root.isConnected) return;
    counts = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
    chipCounts = Object.fromEntries(cats.map((k) => [k, counts[`cat:${k}`]]));
    sections.forEach((s) => { if (`sec:${s.key}` in counts) s.count = counts[`sec:${s.key}`]; });
    drawStats(); drawTabs(); drawChips(); drawList();
  }

  /* ---------- Search ---------- */
  async function runSearch() {
    const q = ui.q.trim();
    const seq = ++searchSeq;
    if (q.length < 2) { found = null; searching = false; drawBar(); drawList(); return; }
    const look = (field, p) => getDocs(query(collection(db, COL), where(field, ">=", p), where(field, "<=", `${p}\uf8ff`), orderBy(field), limit(25)));
    const jobs = [];
    if (q.includes("@")) jobs.push(look("emailKey", q.toLowerCase()));
    else {
      const digits = q.replace(/\D/g, "");
      if (digits.length >= 3 && digits.length >= q.replace(/[\s()+-]/g, "").length) {
        jobs.push(look("mobileKey", digits.replace(/^614/, "04").replace(/^4/, "04")));
      } else {
        const k = nameKey(q);
        if (k.length >= 2) jobs.push(look("nameKey", k), look("nameKeyR", k));
      }
    }
    if (!jobs.length) { found = []; searching = false; drawList(); return; }
    searching = true;
    drawBar(); drawList();
    try {
      const snaps = await Promise.all(jobs);
      if (seq !== searchSeq) return;
      const seen = new Set();
      const out = [];
      snaps.forEach((s) => s.docs.forEach((d) => {
        if (seen.has(d.id)) return;
        seen.add(d.id);
        const c = norm(d);
        if (c.status !== "closed") out.push(c);
      }));
      found = out.sort((a, b) => a.patientName.localeCompare(b.patientName)).slice(0, 30);
    } catch (err) {
      console.error("Recall search failed:", err);
      found = [];
      showToast(errText(err, "Couldn't search. Try again."));
    } finally {
      if (seq === searchSeq) { searching = false; drawList(); }
    }
  }

  /* ---------- Drawing ---------- */
  // My calls fully loaded with no filters: the numbers come straight from the list, so they're exact
  const exactMine = () => (ui.tab === "mine" && ui.who === "mine" && !ui.cat && !ui.appt && !lvRange()
    ? sections.find((s) => s.key === "mine" && s.loaded && !s.more && !s.error) : null);

  function drawStats() {
    const v = (x) => (x == null ? "–" : Number(x).toLocaleString());
    const target = settings.perDay || 15;
    const done = counts.logged;
    const pct = done == null ? 0 : Math.min(100, Math.round((done / target) * 100));
    const mine = exactMine();
    const replies = mine ? mine.rows.filter((c) => c.replyOpen).length : counts.replies;
    const cbs = mine ? callBacks(mine.rows).length : counts.callBacks;
    $("stats").innerHTML = `
      <button type="button" class="rc-stat2" data-go="mine"><small>Called today</small>
        <strong>${v(done)} <em>of ${target}</em></strong><span class="rc-prog"><i style="width:${pct}%"></i></span></button>
      <button type="button" class="rc-stat2${replies ? " is-accent" : ""}" data-go="replies"><small>Replies waiting</small><strong>${v(replies)}</strong></button>
      <button type="button" class="rc-stat2${cbs ? " is-warn" : ""}" data-go="callbacks"><small>Call-backs due</small><strong>${v(cbs)}</strong></button>
      <button type="button" class="rc-stat2 is-good" data-go="booked"><small>Booked this month</small><strong>${v(counts.bookedMonth)}</strong></button>`;
  }

  function drawTabs() {
    const searchingNow = ui.q.trim().length >= 2;
    const tab = (k, label) => {
      const n = counts[k];
      const on = ui.tab === k && !searchingNow;
      return `<button type="button" class="rc-tab${on ? " is-on" : ""}" data-tab="${k}" role="tab" aria-selected="${on}">${esc(label)}${n != null ? ` <em>${n.toLocaleString()}</em>` : ""}</button>`;
    };
    $("tabs").innerHTML = tab("mine", ui.who === "mine" ? "My calls" : "Calls") + tab("waiting", "Waiting") +
      tab("later", "Call back") + tab("booked", "Booked");
  }

  function drawWho() {
    const s = $("who");
    $("whoRow").hidden = ui.tab !== "mine";
    const team = new Set(settings.team);
    const opts = [["mine", "Mine"], ["all", "Everyone's"],
      ...people.filter((p) => team.has(p.id) && p.id !== me()).map((p) => [p.id, p.name])];
    if (!opts.some(([k]) => k === ui.who)) opts.push([ui.who, "Someone else"]);
    s.innerHTML = opts.map(([k, l]) => `<option value="${esc(k)}"${k === ui.who ? " selected" : ""}>${esc(l)}</option>`).join("");
  }

  function drawLv() {
    $("appt").value = ui.appt;
    const t = todayKey();
    $("lvbox").innerHTML = `<select class="fb-select" data-role="lv" aria-label="Last visit">${LV_OPTS.map(([k, l]) =>
      `<option value="${k}"${k === ui.lv ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>` +
      (ui.lv === "custom" ? `<span class="rc-lv-dates">
        <input type="date" class="fe-input" data-role="lvFrom" max="${t}" value="${esc(ui.lvFrom)}" aria-label="From" />
        <span>to</span>
        <input type="date" class="fe-input" data-role="lvTo" max="${t}" value="${esc(ui.lvTo)}" aria-label="To" /></span>` : "");
  }

  // The Filters button (with how many are on) and a chip for each one, to clear it
  function drawFilters() {
    const searchingNow = ui.q.trim().length >= 2;
    $("filters").hidden = searchingNow;
    const active = [];
    if (ui.tab === "mine" && ui.who !== "mine") {
      const p = people.find((x) => x.id === ui.who);
      active.push(["who", ui.who === "all" ? "Everyone's calls" : `${p ? p.name : "Someone else"}'s calls`]);
    }
    if (ui.lv) {
      const r = lvRange();
      active.push(["lv", ui.lv === "custom"
        ? (r ? `Last visit: ${[r.from && nice(r.from), r.to && nice(r.to)].filter(Boolean).join(" to ")}` : "Last visit: choose dates")
        : `Last visit: ${(LV_OPTS.find(([k]) => k === ui.lv) || ["", ""])[1].toLowerCase()}`]);
    }
    if (ui.appt) active.push(["appt", ui.appt === "yes" ? "Has an upcoming visit" : "No upcoming visit"]);
    $("fcount").textContent = active.length ? ` · ${active.length}` : "";
    $("filters").classList.toggle("is-on", !!active.length);
    $("active").innerHTML = searchingNow ? "" : active.map(([k, l]) =>
      `<button type="button" class="rc-active" data-clear="${k}" aria-label="Clear ${esc(l)}">${esc(l)}${I.x}</button>`).join("");
  }

  function drawChips() {
    const box = $("chips");
    box.hidden = ui.q.trim().length >= 2;
    const cats = settings.categories.filter((c) => c.on).map((c) => c.key)
      .filter((k) => (chipCounts[k] || 0) > 0 || k === ui.cat);
    box.innerHTML = `<button type="button" class="rc-chip${!ui.cat ? " is-on" : ""}" data-cat="">All treatments</button>` +
      cats.map((k) => `<button type="button" class="rc-chip${ui.cat === k ? " is-on" : ""}" data-cat="${esc(k)}">${esc(k)}${
        chipCounts[k] != null ? ` <em>${chipCounts[k].toLocaleString()}</em>` : ""}</button>`).join("");
  }

  function rowHtml(c, t) {
    const on = c.id === sel;
    const meta = [esc(c.category), `<span class="${lateness(c, t)}">${esc(dueText(c, t))}</span>`,
      c.lastStaff ? esc(`last with ${c.lastStaff}`) : "",
      c.nextAppt && c.status === "open" && c.nextAppt >= t ? `<span class="rc-appt">Appt ${esc(short(c.nextAppt))}</span>` : ""]
      .filter(Boolean).join(" · ");
    const side = [c.attempts ? `${c.attempts} tr${c.attempts === 1 ? "y" : "ies"}` : "",
      c.assignedToId && c.assignedToId !== me() ? first(c.assignedToName) : ""].filter(Boolean).join(" · ");
    const sv = busyLabel(c.id);
    const tag = sv ? `<span class="rc-tag is-saving">${esc(sv)}…</span>`
      : c.replyOpen && c.reply
        ? `<span class="rc-tag is-${esc(c.reply.kind)}">${esc(REPLY_TAG[c.reply.kind] || "Replied")}</span>`
      : c.callBackDue && c.status === "open" && c.stage === "call"
        ? `<span class="rc-tag is-cb">${c.callBackDue < t ? `Call back · since ${esc(short(c.callBackDue))}` : "Call back today"}</span>`
      : c.status === "open" && c.flowState === "wait" && c.flowDueAt
        ? `<span class="rc-tag is-flow">Flow: waiting until ${esc(short(fmtKey(new Date(c.flowDueAt))))}</span>`
      : c.status === "open" && c.flowState === "joined" ? `<span class="rc-tag is-flow">With their ${esc(c.joinedCat || "other")} recall</span>`
      : c.status === "open" && c.flowState === "released" ? '<span class="rc-tag is-flow">Flow: starts soon</span>'
      : c.status === "open" && c.flowState === "run" ? '<span class="rc-tag is-flow">Flow: sending soon</span>'
      : c.status === "open" && c.flowState === "queued" ? '<span class="rc-tag is-flow">Flow: starts soon</span>'
      : c.status === "open" && !c.assignedToId && c.textHoldUntil > t ? '<span class="rc-tag">Texted · waiting for a reply</span>'
      : c.status === "open" && c.alsoDue.length ? `<span class="rc-tag">Also due: ${esc(c.alsoDue.join(", "))}</span>` : "";
    const tel = telOf(c.mobile);
    const name = esc(c.patientName || "this patient");
    const contact = tel
      ? (on ? `<a class="rc-call is-main" href="tel:${esc(tel)}">${I.phone}<span>Call</span></a>`
        : `<a class="rc-call-ic" href="tel:${esc(tel)}" aria-label="Call ${name}" title="Call ${esc(mobileText(c.mobile))}">${I.phone}</a>`)
      : c.email && !c.dnc
        ? `<a class="rc-call-ic" href="mailto:${esc(c.email)}" data-card="${esc(c.id)}" aria-label="Email ${name}" title="No mobile · email them">${I.mail}</a>`
        : `<span class="rc-nomob">${c.email ? "No mobile" : "No mobile or email"}</span>`;
    return `<div class="rc-item ${rail(c, t)}${on ? " is-on" : ""}" data-card="${esc(c.id)}" role="button" tabindex="0" aria-expanded="${on}">
        <span class="rc-av h${hue(c.category)}" aria-hidden="true">${esc(initials(c.patientName))}</span>
        <span class="rc-main"><strong>${esc(c.patientName || "Unknown patient")}${c.dnc
          ? ` <span class="rc-dnc" title="${esc(dncTitle(c))}">Do not contact</span>` : ""}</strong><small>${meta}</small></span>
        ${tag}
        ${side ? `<span class="rc-side">${esc(side)}</span>` : ""}
        ${contact}
      </div>`;
  }
  const isCallBack = (c) => !!c.callBackDue && !c.replyOpen && c.status === "open" && c.stage === "call";
  const callBacks = (rows) => rows.filter(isCallBack).sort((a, b) => a.callBackDue.localeCompare(b.callBackDue));

  function groupedRows(rows, t) {
    const block = (g, title, list) => (list.length
      ? `<div class="rc-sub-h" data-g="${g}">${esc(title)}</div><div class="rc-list">${list.map((c) => rowHtml(c, t)).join("")}</div>` : "");
    const rest = rows.filter((c) => !c.replyOpen && !isCallBack(c));
    return block("replies", "Replied · follow up first", rows.filter((c) => c.replyOpen)) +
      block("callbacks", "Call back today · as promised", callBacks(rows)) +
      GROUPS.map(([g, title, test]) => block(g, title, rest.filter((c) => test(daysFrom(c.dueDate, t))))).join("");
  }
  function scrollGroup(g) {
    if (!g) return;
    const h = root.querySelector(`.rc-sub-h[data-g="${g}"]`);
    if (h) h.scrollIntoView({ behavior: "smooth", block: "start" });
    else showToast(g === "replies" ? "No replies waiting right now." : "No call-backs due right now.");
  }

  function emptyText(sec) {
    if (ui.appt) return ui.appt === "yes" ? "Nobody here with an upcoming visit." : "Nobody here without an upcoming visit.";
    if (lvRange()) return ui.cat ? `Nobody here for ${ui.cat} with a last visit in those dates.` : "Nobody here with a last visit in those dates.";
    if (ui.cat) return `Nobody here for ${ui.cat}.`;
    if (sec.key === "mine") {
      if (ui.who !== "mine") return "No calls here right now.";
      return counts.waiting ? "No calls given to you right now. New ones are shared out from Waiting every hour." : "Nothing to call right now.";
    }
    return { just: "Nobody newly due.", over: "Nobody in this group.", lapsed: "Nobody in this group.",
      later: "No call-backs or pauses.", booked: "Nobody booked from Recall right now." }[sec.key] || "Nobody here.";
  }

  function sectionHtml(sec, t) {
    const head = sec.title ? `<div class="rc-sec-h"><span>${esc(sec.title)}</span>${sec.count != null ? `<em>${sec.count.toLocaleString()}</em>` : ""}</div>` : "";
    if (!sec.open) {
      return `<div class="rc-sec"><button type="button" class="rc-lapsed" data-open="${sec.key}"><span>${esc(sec.title)}${
        sec.count != null ? ` · ${plural(sec.count, "patient")}` : ""}</span><em>Show</em></button></div>`;
    }
    if (sec.error) return `<div class="rc-sec">${head}<p class="rc-empty">${esc(sec.error)}</p></div>`;
    if (!sec.loaded) return `<div class="rc-sec">${head}<div class="skeleton" style="height:140px;border-radius:12px"></div></div>`;
    const body = !sec.rows.length ? `<p class="rc-empty">${esc(emptyText(sec))}</p>`
      : sec.key === "mine" ? groupedRows(sec.rows, t)
        : `<div class="rc-list">${sec.rows.map((c) => rowHtml(c, t)).join("")}</div>`;
    const more = sec.more ? `<button type="button" class="lh-btn is-quiet rc-more" data-more="${sec.key}">Load ${PAGE} more</button>` : "";
    return `<div class="rc-sec">${head}${body}${more}</div>`;
  }

  function drawList() {
    const t = todayKey();
    const box = $("list");
    if (ui.q.trim().length >= 2) {
      if (searching || !found) { box.innerHTML = '<div class="skeleton" style="height:140px;border-radius:12px"></div>'; return; }
      box.innerHTML = `<div class="rc-sec"><div class="rc-sec-h"><span>Matching patients</span><em>${found.length}</em></div>${
        found.length ? `<div class="rc-list">${found.map((c) => rowHtml(c, t)).join("")}</div>`
          : `<p class="rc-empty">No open recall for “${esc(ui.q.trim())}”.</p>`}</div>`;
      return;
    }
    box.innerHTML = sections.map((s) => sectionHtml(s, t)).join("");
  }

  // The rows in the order they're on screen (for "open the next patient")
  function shownIds() {
    if (ui.q.trim().length >= 2) return (found || []).map((c) => c.id);
    const t = todayKey();
    const out = [];
    sections.forEach((s) => {
      if (!s.open || !s.loaded) return;
      if (s.key === "mine") {
        s.rows.forEach((c) => { if (c.replyOpen) out.push(c.id); });
        callBacks(s.rows).forEach((c) => out.push(c.id));
        GROUPS.forEach(([, , test]) => s.rows.forEach((c) => {
          if (!c.replyOpen && !isCallBack(c) && test(daysFrom(c.dueDate, t))) out.push(c.id);
        }));
      }
      else s.rows.forEach((c) => out.push(c.id));
    });
    return out;
  }

  // A text for this card, from Recall settings → Texts (the usual one, or the one after a missed call)
  function fillSms(c, template = settings.sms.template) {
    const s = settings.sms || {};
    const cat = settings.categories.find((x) => x.key === c.category);
    const months = c.lastVisit ? Math.max(1, Math.round(daysFrom(c.lastVisit, todayKey()) / 30.4)) : (cat ? cat.months : "");
    const firstName = String(c.patientName || "").replace(/\([^)]*\)/g, " ").trim().split(/\s+/)[0] || "there";
    return String(template || "")
      .replace(/\{\s*first name\s*\}/gi, firstName)
      .replace(/\{\s*treatment\s*\}/gi, () => {
        const names = [c.category, ...c.alsoDue].map((k) => (settings.categories.find((x) => x.key === k) || {}).smsName || "treatment")
          .filter((n, i, a) => a.indexOf(n) === i);
        return names.length <= 1 ? names[0] || "treatment" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      })
      .replace(/\{\s*months\s*\}/gi, String(months))
      .replace(/\{\s*clinic phone\s*\}/gi, s.phone || "")
      .replace(/\s+/g, " ").trim();
  }

  /* ---------- One card ---------- */
  function panelHtml(c, sv) {
    const t = todayKey();
    const team = new Set(settings.team);
    const ppl = [...people].sort((a, b) => (team.has(b.id) - team.has(a.id)) || String(a.name).localeCompare(String(b.name)));
    if (c.assignedToId && !ppl.some((s) => s.id === c.assignedToId)) ppl.unshift({ id: c.assignedToId, name: c.assignedToName || "Someone" });
    const reason = settings.reasons.find((r) => r.label === draft.reason);
    const tel = telOf(c.mobile);
    const dueCls = rail(c, t).replace("r-", "is-");

    const chips = [
      c.category ? `<span class="rc-pill is-cat">${esc(c.category)}</span>` : "",
      `<span class="rc-pill ${dueCls}">${esc(dueText(c, t))}</span>`,
      c.alsoDue.length ? `<span class="rc-pill is-also">Also due: ${esc(c.alsoDue.join(", "))}</span>` : "",
    ].join("");

    const lastCall = c.log.slice().reverse().find((l) => /no answer|voicemail|spoke|booked/i.test(String(l.what || "")));
    const ctx = [
      ["Last visit", c.lastVisit ? `${nice(c.lastVisit)}${c.lastStaff ? ` with ${c.lastStaff}` : ""}` : "Not known"],
      ["Had", c.lastServices.join(", ") || "–"],
      ["Calls so far", c.attempts ? `${c.attempts}${lastCall ? ` · ${String(lastCall.what).toLowerCase()} ${dayOf(lastCall.at)}` : ""}` : "None yet"],
      ["Last text", c.lastTextAt ? `${dayOf(c.lastTextAt)}${c.texts > 1 ? ` · ${c.texts} so far` : ""}` : "None yet"],
      ["Upcoming", c.nextAppt && c.nextAppt >= t ? short(c.nextAppt) : "Nothing booked"],
      ["Due", nice(c.dueDate) || "–"],
    ];

    const contact = `<div class="rc-contact">
      ${tel ? `<a class="rc-call is-main" href="tel:${esc(tel)}">${I.phone}<span>Call ${esc(mobileText(c.mobile))}</span></a>`
        : '<span class="rc-nomob">No mobile on file</span>'}
      ${tel && c.status !== "closed" ? (c.dnc
        ? `<button type="button" class="lh-btn" disabled title="${esc(dncTitle(c))}">${I.msg}<span>Text</span></button>`
        : `<button type="button" class="lh-btn" data-act="sms">${I.msg}<span>Text</span></button>`) : ""}
      ${c.email ? (c.dnc
        ? `<button type="button" class="lh-btn" disabled title="${esc(dncTitle(c))}">${I.mail}<span>Email</span></button>`
        : `<a class="lh-btn" href="mailto:${esc(c.email)}" data-card="${esc(c.id)}">${I.mail}<span>Email</span></a>`) : ""}
      ${c.patientId ? `<a class="lh-btn is-quiet rc-icon-btn" href="#/patient/${encodeURIComponent(c.patientId)}" aria-label="Patient page" title="Patient page">${I.user}</a>` : ""}
    </div>`;

    const smsBox = draft.sms == null ? "" : `<div class="rc-sms">
      <textarea class="fe-input" data-role="sms" rows="4" maxlength="560" aria-label="Text message">${esc(draft.sms)}</textarea>
      <div class="rc-row"><small class="fe-note" data-role="smsInfo">${esc(smsInfo(draft.sms))}</small><span class="inv-spacer"></span>
        <button type="button" class="lh-btn is-quiet" data-act="sms-cancel">Cancel</button>
        <button type="button" class="btn-primary" data-act="sms-send">Send to ${esc(mobileText(c.mobile))}</button></div>
    </div>`;

    let work;
    if (c.status === "closed") {
      work = `<div class="rc-state">Closed: ${esc(c.closeReason)}${c.closedBy ? ` · ${esc(c.closedBy)}` : ""}${c.closedAt ? ` · ${esc(when(c.closedAt))}` : ""}</div>
        ${c.closeReason === "Came in" ? "" : '<button type="button" class="lh-btn" data-act="reopen">Reopen</button>'}`;
    } else if (c.status === "booked") {
      work = `<div class="rc-state is-ok">${c.bookedFor
        ? `Booked for ${esc(nice(c.bookedFor))}. The card closes by itself when they come in.`
        : "Marked as booked by phone. If it isn't in the appointment book within 3 days, the card goes back to My calls."}</div>
        <button type="button" class="lh-btn" data-act="reopen">Not booked after all</button>`;
    } else {
      work = `
        <div class="rc-ask">What happened?</div>
        <div class="rc-tiles">${TILES.map(([k, l, key]) => `<button type="button" class="rc-tile${k === "booked" ? " is-good" : ""}" data-out="${k}">
          ${TILE_ICON[k]}<span>${esc(l)}</span><kbd>${key}</kbd></button>`).join("")}</div>
        <textarea class="fe-input rc-note" data-role="note" rows="2" maxlength="1000"
          placeholder="Add a note or call-back first if you like, then tap what happened">${esc(draft.note)}</textarea>
        <div class="rc-cb"><span>Call back</span>${PICKS.map(([l, fn], i) =>
          `<button type="button" class="rc-chip${draft.remind === fn(t) ? " is-on" : ""}" data-pick="${i}">${esc(l)}</button>`).join("")}
          <input type="date" class="fe-input" data-role="remind" min="${addDays(t, 1)}" value="${esc(draft.remind)}" aria-label="Call back on" /></div>
        <div class="rc-work-foot">
          <label class="fe-check rc-auto"><input type="checkbox" data-role="auto"${autoNext ? " checked" : ""} /> Open the next patient after</label>
          <span class="inv-spacer"></span>
          <button type="button" class="lh-btn is-quiet" data-act="save">Save note or call-back</button>
        </div>`;
    }

    const stop = c.status !== "open" ? "" : `
      <div class="rc-f-row"><span>Stop recall</span>
        <div class="rc-row">
          <select class="fb-select" data-role="reason" aria-label="Reason">
            <option value="">Choose a reason</option>${settings.reasons.map((r) =>
              `<option value="${esc(r.label)}"${r.label === draft.reason ? " selected" : ""}>${esc(r.label)}</option>`).join("")}</select>
          ${reason && reason.askDate ? `<label>until <input type="date" class="fe-input" data-role="until" min="${addDays(t, 1)}" value="${esc(draft.until)}" /></label>` : ""}
          <button type="button" class="lh-btn" data-act="close">${reason && reason.askDate ? "Pause" : "Stop"}</button>
        </div>
        ${reason && reason.dnc ? '<small class="fe-note">This also puts them on the do-not-contact list.</small>' : ""}</div>`;
    const more = c.status === "closed" ? "" : `<details class="rc-more" data-role="more"${moreOpen ? " open" : ""}>
      <summary><span>Given to ${esc(c.assignedToName || "nobody yet")}${c.status === "open" ? " · Stop recall" : ""}</span>${I.chev}</summary>
      <div class="rc-more-body">
        <label class="rc-f-row"><span>Given to</span>
          <select class="fb-select" data-role="assign" aria-label="Given to">
            <option value="">Nobody yet (waiting)</option>${ppl.map((s) =>
              `<option value="${esc(s.id)}"${s.id === c.assignedToId ? " selected" : ""}>${esc(s.name)}${team.size && !team.has(s.id) ? " (not in the recall team)" : ""}</option>`).join("")}
          </select></label>
        ${stop}
      </div></details>`;

    const hist = c.log.length ? `<h4 class="rc-h">History</h4><ul class="rc-hist">${c.log.slice().reverse().map((l) => `<li>
        <span class="rc-hist-ic">${histIcon(l.what)}</span>
        <div><strong>${esc(l.what)}</strong>${l.note ? `<p>${esc(l.note)}</p>` : ""}
          <small>${esc(when(l.at))}${l.by ? ` · ${esc(l.by)}` : ""}</small></div></li>`).join("")}</ul>` : "";

    return `
      <div class="rc-ph"><span class="rc-av rc-av-lg h${hue(c.category)}" aria-hidden="true">${esc(initials(c.patientName))}</span>
        <div class="rc-ph-main"><h3>${esc(c.patientName || "Unknown patient")}</h3><div class="rc-pchips">${chips}</div></div>
        <button type="button" class="rc-x" data-act="deselect" aria-label="Close">${I.x}</button></div>
      ${c.reply ? `<div class="rc-reply${c.replyOpen ? " is-open" : ""}"><strong>${esc(REPLY_TAG[c.reply.kind] || "Replied")} · ${esc(when(c.reply.at))}</strong>
        <p>${esc(c.reply.text)}</p></div>` : ""}
      ${c.dnc ? `<div class="rc-dnc-note"><strong>Do not contact</strong> · ${esc(dncTitle(c))}</div>` : ""}
      ${contact}${smsBox}
      <div class="rc-ctx">${ctx.map(([a, b]) => `<div><small>${esc(a)}</small><span>${esc(b)}</span></div>`).join("")}</div>
      ${sv ? `<p class="rc-saving-line" role="status">${esc(sv)}…</p>` : ""}
      <div class="rc-work">${work}</div>
      ${more}${hist}`;
  }

  function drawPanel(force) {
    const p = $("panel");
    const c = sel ? findCard(sel) : null;
    if (!c) { p.hidden = true; p.innerHTML = ""; panelSig = ""; panelId = ""; return; }
    const sv = busyLabel(c.id);
    const sig = `${c.id}|${c.updatedAt}|${c.status}|${people.length}|${sv}`;
    if (!force && sig === panelSig) return;
    const same = panelId === c.id;
    panelSig = sig;
    panelId = c.id;
    p.hidden = false;
    p.classList.toggle("is-saving", !!sv);
    const render = () => {
      p.innerHTML = panelHtml(c, sv);
      const nb = p.querySelector('[data-role="note"]');
      if (nb) grow(nb);
    };
    if (same) keepFocus(p, render);   // a colleague or the flow saved: keep the cursor where it was
    else { render(); p.scrollTop = 0; }
  }

  function openCard(id) {
    sel = id;
    seenSel = inRows(id);
    draft = blank();
    moreOpen = false;
    drawList();
    drawPanel(true);
    const row = root.querySelector(`[data-card="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function select(id) {
    if (pend && pend.id === id) commit();   // reopening it: save now
    if (sel === id) { sel = ""; seenSel = false; draft = blank(); drawList(); drawPanel(true); return; }
    openCard(id);
  }
  // After logging a call: the next open card that was below this one (not one still saving)
  function goNext(fromId, ids) {
    const i = ids.indexOf(fromId);
    const next = ids.slice(i + 1).find((id) => { const c = findCard(id); return c && c.status === "open" && !busyLabel(id); });
    if (next) openCard(next);
    else { sel = ""; draft = blank(); drawList(); drawPanel(true); }
  }

  // Saves through Apps Script (1 to 3 seconds). The card shows "Saving…" meanwhile; other cards can be worked.
  async function act(op, extraBody, { id = sel, label = "Saving", btn = null } = {}) {
    if (!id) return false;
    if (pend && pend.id === id && !(await commit())) return false;   // the call logged just before goes first
    if (saving.has(id)) { showToast("Still saving the last change. One moment."); return false; }
    const c = findCard(id);
    saving.set(id, label);
    if (btn) btn.disabled = true;
    drawList();
    if (id === sel) drawPanel(true);
    try {
      const res = await callApi({ action: "recall", op, id, ...extraBody });
      if (res && res.problem) { showToast(`${c && c.patientName ? `${c.patientName}: ` : ""}${res.problem}`); return false; }
      scheduleCounts(800);
      if (sel === id && !inRows(id)) keepOpen(id);
      return true;
    } catch (err) {
      showToast(`${c && c.patientName ? `${c.patientName}: ` : ""}${errText(err, "Couldn't save. Try again.")}`);
      return false;
    } finally {
      saving.delete(id);
      if (btn && btn.isConnected) btn.disabled = false;
      if (root.isConnected) { drawList(); if (id === sel) drawPanel(true); }
    }
  }

  async function keepOpen(id) {
    try { const s = await getDoc(doc(db, COL, id)); if (s.exists()) extra.set(id, norm(s)); } catch { /* the panel just closes */ }
    if (sel === id) drawPanel(true);
  }

  /* ---------- Logging a call, Undo, and the text after a missed call ---------- */
  // What to offer after No answer / Left voicemail: a text, an email, nothing, or why not ({ skip })
  function missedOffer(c, k) {
    if (!MISSED.has(k)) return null;
    const mode = settings.sms.missedMode;
    if (mode === "off" || c.dnc || c.status !== "open") return null;
    const last = textedAt(c);
    if (last) {
      const days = Math.floor((Date.now() - last) / 864e5);
      if (days < settings.sms.missedQuiet) {
        return { skip: days < 1 ? "Texted today, so no text is offered." : `Texted ${plural(days, "day")} ago, so no text is offered.` };
      }
    }
    if (isMobile(c.mobile)) return { kind: "sms", text: fillSms(c, settings.sms.missedTemplate), auto: mode === "auto" };
    if (c.email) return { kind: "email", auto: false };
    return { skip: "No mobile or email on file, so there's nothing to send." };
  }

  function logOutcome(k) {
    const id = sel;
    const c = findCard(id);
    if (!c || c.status !== "open") return;
    if (busyLabel(id)) { showToast("Still saving the last change. One moment."); return; }
    if (pend) commit();   // the call before this one saves now
    const f = first(c.patientName) || "Patient";
    const kept = { ...draft };
    const ids = shownIds();
    const o = missedOffer(c, k);
    clearTimeout(barHide); barHide = 0;
    offer = o && o.kind ? { ...o, id, first: f, mobile: c.mobile, email: c.email, editing: false, busy: false } : null;
    quietNote = o && o.skip ? o.skip : "";
    pend = { id, first: f, label: LABEL[k], body: { outcome: k, note: kept.note, remindOn: kept.remind }, kept,
      deadline: Date.now() + UNDO_MS, auto: offer && offer.auto ? offer : null };
    pend.timer = setTimeout(commit, UNDO_MS);
    pend.tick = setInterval(tickUndo, 500);
    bar = { id, first: f, text: `${f}: ${LABEL[k].toLowerCase()}`, state: "wait", sent: false };
    draft = blank();
    if (autoNext) goNext(id, ids);
    else { drawList(); drawPanel(true); }
    drawUndo();
  }

  // Sends the call that's waiting. Returns false if it couldn't be saved (the card opens again, with what was typed).
  async function commit() {
    const p = pend;
    if (!p) return true;
    pend = null;
    clearTimeout(p.timer);
    clearInterval(p.tick);
    if (bar && bar.id === p.id) bar.state = "saving";
    drawUndo();
    const ok = await act("log", p.body, { id: p.id, label: `Saving: ${p.label}` });
    if (bar && bar.id === p.id) bar.state = ok ? "saved" : "failed";
    if (!ok) {
      if (offer && offer.id === p.id) offer = null;
      if (root.isConnected && sel !== p.id) { sel = p.id; seenSel = inRows(p.id); draft = p.kept; drawList(); drawPanel(true); }
    } else if (p.auto) {
      // "Send the text automatically" in Recall settings: it goes once the call is saved
      const sent = await act("text", { text: p.auto.text }, { id: p.id, label: "Sending the text" });
      if (sent) {
        if (bar && bar.id === p.id) bar.sent = true; else showToast(`${p.first}: text sent`);
        if (offer === p.auto) offer = null;
      } else if (offer === p.auto) offer.auto = false;   // it couldn't go: offer the button instead
    }
    drawUndo();
    return ok;
  }

  function undo() {
    const p = pend;
    if (!p) return;
    pend = null;
    clearTimeout(p.timer);
    clearInterval(p.tick);
    if (offer && offer.id === p.id) offer = null;
    bar = null;
    quietNote = "";
    sel = p.id;
    seenSel = inRows(p.id);
    draft = p.kept;
    moreOpen = false;
    drawList();
    drawPanel(true);
    drawUndo();
    const row = root.querySelector(`[data-card="${CSS.escape(p.id)}"]`);
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    showToast("Undone. Nothing was saved.");
  }

  async function sendOffer() {
    const o = offer;
    if (!o || o.kind !== "sms" || o.busy) return;
    if (String(o.text || "").trim().length < 10) { showToast("Write the message first."); return; }
    if (pend && pend.id === o.id && !(await commit())) return;   // the call goes into History first
    if (offer !== o) return;
    o.busy = true;
    drawUndo();
    const ok = await act("text", { text: o.text }, { id: o.id, label: "Sending the text" });
    o.busy = false;
    if (offer === o && ok) {
      offer = null;
      if (bar && bar.id === o.id) bar.sent = true;
      else showToast(`${o.first}: text sent`);
    }
    drawUndo();
  }

  function dismissBar() {
    if (pend) commit();
    clearTimeout(barHide); barHide = 0;
    bar = null; offer = null; quietNote = "";
    drawUndo();
  }

  const secsLeft = () => (pend ? Math.max(0, Math.ceil((pend.deadline - Date.now()) / 1000)) : 0);
  function tickUndo() { const el = $("undoLeft"); if (el) el.textContent = `${secsLeft()}s`; }

  function drawUndo() {
    const el = $("undo");
    if (!el) return;
    if (!bar && !offer) { el.hidden = true; el.innerHTML = ""; return; }
    const o = offer;
    let line = "";
    if (bar) {
      const ic = bar.state === "failed" ? I.x : bar.state === "wait" ? I.clock : I.check;
      const st = bar.state === "wait" ? `<small>Saving in <b data-role="undoLeft">${secsLeft()}s</b></small>`
        : bar.state === "saving" ? "<small>Saving…</small>"
        : bar.state === "failed" ? "<small>Couldn't save. It's open again so you can try again.</small>"
        : "<small>Saved</small>";
      line = `<div class="rc-ub-line is-${bar.state}"><span class="rc-ub-ic">${ic}</span>
        <span class="rc-ub-t"><strong>${esc(bar.text)}</strong> ${st}</span>
        ${pend && pend.id === bar.id ? `<button type="button" class="rc-ub-undo" data-act="undo">${I.undo}<span>Undo</span><kbd>U</kbd></button>` : ""}
        <button type="button" class="rc-ub-x" data-act="bar-x" aria-label="Close">${I.x}</button></div>`;
    }
    const notes = (quietNote ? `<p class="rc-ub-note">${esc(quietNote)}</p>` : "") +
      (bar && bar.sent ? `<p class="rc-ub-note is-ok">${I.check} Text sent to ${esc(bar.first)}.</p>` : "");
    let off = "";
    if (o && o.kind === "sms") {
      off = `<div class="rc-ub-offer">
        <strong>${o.auto ? `A text goes to ${esc(o.first)} once this saves` : `Send ${esc(o.first)} a text so they know it was you?`}</strong>
        ${o.editing ? `<textarea class="fe-input" data-role="offerText" rows="3" maxlength="560" aria-label="Text message">${esc(o.text)}</textarea>`
          : `<div class="rc-bubble">${esc(withStop(o.text))}</div>`}
        <small data-role="offerInfo">To ${esc(mobileText(o.mobile))} · ${esc(smsCount(o.text))}</small>
        <div class="rc-ub-acts">
          ${o.auto ? "" : `<button type="button" class="rc-ub-send" data-act="offer-send"${o.busy ? " disabled" : ""}>${I.send}<span>${
            o.busy ? "Sending…" : "Send text"}</span><kbd>T</kbd></button>`}
          <button type="button" class="lh-btn is-quiet" data-act="offer-edit">${o.editing ? "Done" : `${I.edit}<span>Edit</span>`}</button>
          <span class="inv-spacer"></span>
          <button type="button" class="lh-btn is-quiet" data-act="offer-no">${o.auto ? "Don't send" : "Not now"}</button>
        </div></div>`;
    } else if (o && o.kind === "email") {
      off = `<div class="rc-ub-offer"><strong>No mobile on file. Email ${esc(o.first)} instead?</strong>
        <div class="rc-ub-acts"><button type="button" class="rc-ub-send" data-act="offer-email">${I.mail}<span>Write an email</span></button>
          <span class="inv-spacer"></span><button type="button" class="lh-btn is-quiet" data-act="offer-no">Not now</button></div></div>`;
    }
    el.hidden = false;
    keepFocus(el, () => { el.innerHTML = line + notes + off; });
    // A saved line on its own fades after a few seconds
    if (bar && (bar.state === "saved" || bar.state === "failed") && !o && !pend && !barHide) {
      const b = bar;
      barHide = setTimeout(() => {
        barHide = 0;
        if (bar === b && !offer && !pend) { bar = null; quietNote = ""; drawUndo(); }
      }, b.state === "failed" ? 8000 : 4500);
    }
  }

  /* ---------- Events ---------- */
  root.addEventListener("input", (e) => {
    const r = e.target.dataset.role;
    if (r === "q") {
      ui.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 300);
    } else if (r === "note") { draft.note = e.target.value; grow(e.target); }
    else if (r === "sms") {
      draft.sms = e.target.value;
      const info = $("smsInfo");
      if (info) info.textContent = smsInfo(draft.sms);
    } else if (r === "offerText" && offer) {
      offer.text = e.target.value;
      const info = $("offerInfo");
      if (info) info.textContent = `To ${mobileText(offer.mobile)} · ${smsCount(offer.text)}`;
    }
  });
  root.addEventListener("toggle", (e) => {   // toggle doesn't bubble, so this listens on the way down
    if (e.target.dataset && e.target.dataset.role === "more") moreOpen = e.target.open;
  }, true);
  root.addEventListener("change", async (e) => {
    const el = e.target;
    const r = el.dataset.role;
    if (r === "who") { ui.who = el.value; sel = ""; build(); return; }
    if (r === "appt") { ui.appt = el.value; sel = ""; build(); return; }
    if (r === "lv") {
      ui.lv = el.value;
      sel = "";
      if (ui.lv === "custom" && !ui.lvFrom && !ui.lvTo) { drawLv(); drawFilters(); return; }   // wait for a date
      build();
      return;
    }
    if (r === "lvFrom" || r === "lvTo") { ui[r] = el.value; sel = ""; build(); return; }
    if (r === "auto") { autoNext = el.checked; setPref("rc_autonext", autoNext); return; }
    if (r === "remind") { draft.remind = el.value; drawPanel(true); return; }
    if (r === "until") { draft.until = el.value; return; }
    if (r === "reason") { draft.reason = el.value; drawPanel(true); return; }
    if (r === "assign" && !(await act("assign", { toId: el.value }, { label: "Saving", btn: el }))) drawPanel(true);
  });
  root.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest(".rc-item");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(row.dataset.card); }
  });

  // Keys for desk users: N, V, S, B log a call · T sends the offered text · U undoes · Esc closes
  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector("dialog[open]") || document.querySelector(".rem:not(.is-min)")) return;
    const k = e.key.toLowerCase();
    if (k === "escape") {
      const f = $("filters");
      if (f.open) { f.open = false; return; }
      if (bar || offer) { dismissBar(); return; }
      if (sel) { sel = ""; drawList(); drawPanel(true); }
      return;
    }
    if (k === "u" && pend) { e.preventDefault(); undo(); return; }
    if (k === "t" && offer && offer.kind === "sms" && !offer.auto) { e.preventDefault(); sendOffer(); return; }
    const tile = TILES.find((x) => x[2].toLowerCase() === k);
    if (tile && sel) {
      const c = findCard(sel);
      if (c && c.status === "open") { e.preventDefault(); logOutcome(tile[0]); }
    }
  };
  document.addEventListener("keydown", onKey);

  // The Filters menu closes when clicking anywhere else
  const onDocClick = (e) => {
    if (!root.isConnected) { document.removeEventListener("click", onDocClick); return; }
    const f = $("filters");
    if (f && f.open && !f.contains(e.target)) f.open = false;
  };
  document.addEventListener("click", onDocClick);

  root.addEventListener("click", async (e) => {
    // Calling from a row opens that patient too, ready to log what happened
    const tl = e.target.closest('a[href^="tel:"]');
    if (tl) {
      const r = tl.closest(".rc-item");
      if (r && r.dataset.card !== sel) { const id = r.dataset.card; setTimeout(() => openCard(id), 0); }
      return;
    }
    if (e.target.closest('a[href^="mailto:"]')) return;

    const go = e.target.closest("[data-go]");
    if (go) {
      const g = go.dataset.go;
      const onMine = ui.tab === "mine" && ui.who === "mine" && ui.q.trim().length < 2;
      if (g === "booked") { if (ui.tab !== "booked") { ui.tab = "booked"; ui.q = ""; $("q").value = ""; found = null; sel = ""; build(); } return; }
      if (onMine) { scrollGroup(g === "mine" ? "" : g); return; }
      ui.tab = "mine"; ui.who = "mine"; ui.q = ""; $("q").value = ""; found = null; sel = "";
      jumpTo = g === "mine" ? "" : g;
      build();
      return;
    }
    const clr = e.target.closest("[data-clear]");
    if (clr) {
      const k = clr.dataset.clear;
      if (k === "who") ui.who = "mine";
      if (k === "lv") { ui.lv = ""; ui.lvFrom = ""; ui.lvTo = ""; }
      if (k === "appt") ui.appt = "";
      sel = "";
      build();
      return;
    }
    const pk = e.target.closest("[data-pick]");
    if (pk) {
      const v = PICKS[Number(pk.dataset.pick)][1](todayKey());
      draft.remind = draft.remind === v ? "" : v;
      drawPanel(true);
      return;
    }
    const tb = e.target.closest("[data-tab]");
    if (tb) { ui.tab = tb.dataset.tab; ui.q = ""; $("q").value = ""; found = null; sel = ""; build(); return; }
    const ch = e.target.closest("[data-cat]");
    if (ch) { ui.cat = ch.dataset.cat; sel = ""; build(); return; }
    const opn = e.target.closest("[data-open]");
    if (opn) {
      const s = sections.find((x) => x.key === opn.dataset.open);
      if (s) { s.open = true; listen(s); drawList(); }
      return;
    }
    const more = e.target.closest("[data-more]");
    if (more) {
      const s = sections.find((x) => x.key === more.dataset.more);
      if (s) { s.n += PAGE; more.disabled = true; more.textContent = "Loading…"; listen(s); }
      return;
    }
    const out = e.target.closest("[data-out]");
    if (out) { logOutcome(out.dataset.out); return; }
    const row = e.target.closest("[data-card]");
    if (row) { select(row.dataset.card); return; }

    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (a === "undo") { undo(); return; }
    if (a === "bar-x") { dismissBar(); return; }
    if (a === "offer-send") { sendOffer(); return; }
    if (a === "offer-edit") {
      if (!offer) return;
      offer.editing = !offer.editing;
      drawUndo();
      const ta = $("offerText");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    if (a === "offer-no") {
      if (offer && pend && pend.auto === offer) pend.auto = null;   // "Don't send" before it saves
      offer = null;
      drawUndo();
      return;
    }
    if (a === "offer-email") {
      const o = offer;
      offer = null;
      drawUndo();
      if (o && o.email) openRecallEmail({ email: o.email, cardId: o.id });
      return;
    }
    if (a === "deselect") { sel = ""; drawList(); drawPanel(true); return; }
    if (a === "sms") {
      const c = findCard(sel);
      if (!c) return;
      draft.sms = fillSms(c);
      drawPanel(true);
      const ta = $("sms");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    if (a === "sms-cancel") { draft.sms = null; drawPanel(true); return; }
    if (a === "sms-send") {
      if (String(draft.sms || "").trim().length < 10) { showToast("Write the message first."); return; }
      if (await act("text", { text: draft.sms }, { label: "Sending the text", btn: b })) { draft.sms = null; drawPanel(true); showToast("Text sent"); }
      return;
    }
    if (a === "save") {
      if (!draft.note.trim() && !draft.remind) { showToast("Write a note or choose a call-back date first."); return; }
      const from = sel, kept = { ...draft };
      const c = findCard(from);
      const what = kept.remind ? "Call back" : "Note";
      const ok = await act("log", { outcome: "", note: kept.note, remindOn: kept.remind }, { id: from, label: `Saving: ${what}` });
      if (ok) {
        if (sel === from) { draft = { ...draft, note: "", remind: "" }; drawPanel(true); }
        showToast(`${c ? `${first(c.patientName)}: ` : ""}${what} saved`);
      }
      return;
    }
    if (a === "close") {
      const r = settings.reasons.find((x) => x.label === draft.reason);
      if (!r) { showToast("Choose a reason."); return; }
      if (r.askDate && !draft.until) { showToast("Choose when to start recalling them again."); return; }
      if (r.dnc && !(await confirmDialog({ title: "Don't contact again?", message: "Recall stops, and they go on the do-not-contact list for marketing emails.", confirmLabel: "Stop and add to the list", tone: "danger" }))) return;
      const ids = shownIds(), from = sel;
      if (await act("close", { reason: r.label, until: draft.until, note: draft.note }, { label: r.askDate ? "Pausing" : "Stopping recall", btn: b })) {
        draft = blank();
        drawPanel(true);
        showToast(r.askDate ? "Paused" : "Recall stopped");
        if (autoNext && sel === from) goNext(from, ids);
      }
      return;
    }
    if (a === "reopen") {
      if (await act("reopen", {}, { label: "Reopening", btn: b })) showToast("Reopened");
    }
  });

  // Leaving with a call still waiting to save: it saves now (the browser asks first, so it has time)
  const onUnload = (e) => { if (pend) { commit(); e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("hashchange", function off() {
    setTimeout(() => {
      if (root.isConnected) return;
      if (pend) commit();
      stopAll(); clearTimeout(countTimer); clearTimeout(searchTimer); clearTimeout(barHide);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("hashchange", off);
    }, 0);
  });

  /* ---------- Start ---------- */
  getDoc(doc(db, "recall_settings", "config"))
    .then((s) => { settings = normRecallSettings(s.exists() ? s.data() : {}); drawWho(); drawChips(); drawStats(); drawPanel(true); scheduleCounts(0); })
    .catch(() => {});
  callApi({ action: "staffList" }).then((r) => { people = (r && r.staff) || []; drawWho(); drawFilters(); drawPanel(true); }).catch(() => {});
  drawStats();
  build();
}