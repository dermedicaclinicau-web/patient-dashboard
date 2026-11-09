// Recall (#/recall): patients due for their next treatment, worked by the recall team.
// The cards (recalls/{id}) are made, booked and closed by Apps Script (Code.gs → Recall) from the appointment book.
// Every change goes through Apps Script (action "recall"), so each card keeps a full history.
// Only the tab on screen is loaded, 50 at a time; the numbers come from Firestore count queries.
// With a Last visit filter on, each tab is one list sorted by last visit (Firestore can only sort by the date it filters on).
// Logging a call: tap what happened. It saves after 5 seconds (Undo until then). After No answer or Left voicemail
// a text is offered (Recall settings → Texts → After a missed call).
// Pressing Call turns the card into "On a call" (timer, outcomes first). Start calling works through My calls one at a time.
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
// Spend tiers (Code.gs → recallSpend_): from the Day Sheet, the last 12 months
const TIERS = { platinum: "Platinum", gold: "Gold", silver: "Silver" };
const TIER_RANK = { platinum: 0, gold: 1, silver: 2 };
const SPEND_OPTS = [["", "Any"], ["platinum", "Platinum"], ["gold", "Gold"], ["silver", "Silver"],
  ["pg", "Platinum or Gold"], ["none", "No tier"]];
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-AU")}`;
const PICKS = [["Tomorrow", (t) => addDays(t, 1)], ["Next week", (t) => addDays(t, 7)],
  ["2 weeks", (t) => addDays(t, 14)], ["1 month", (t) => addMonths(t, 1)]];
const SESSION_KEYS = [["N", "No answer"], ["V", "Voicemail"], ["S", "Spoke"], ["B", "Booked"], ["C", "Call"],
  ["T", "Send the offered text"], ["U", "Undo"], ["↓", "Skip"], ["↑", "Previous"], ["Esc", "Pause"]];

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
  headset: svg('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 19a2 2 0 0 1-2 2h-1v-7h3z"/><path d="M3 19a2 2 0 0 0 2 2h1v-7H3z"/>'),
  play: svg('<polygon points="6 4 20 12 6 20 6 4"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
  next: svg('<polyline points="9 6 15 12 9 18"/>'),
  prev: svg('<polyline points="15 6 9 12 15 18"/>'),
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
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
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
const blank = () => ({ note: "", remind: "", reason: "", until: "", sms: null, smsKey: "main", all: null });
// "Stop all their recalls" starts ticked for reasons about the person, not one treatment
const allDefault = (r) => !!r && (r.dnc || /moved|pregnan|breastfeed|passed|deceased/i.test(r.label));
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to Recall. Check Recall access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);
const dncTitle = (c) => `On the do-not-contact list${c.dncWhy ? ` (${c.dncWhy})` : ""}. ` +
  "No recall texts or emails. Calls and messages about their care are fine.";
// "3 Nov 2026" from an ISO time
const dayYear = (iso) => { const d = new Date(iso || ""); return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); };
// Opted out of texts: Textmagic's list, or they replied STOP (Code.gs → tmUnsubSync_ / recallStop_)
const smsStopText = (c) => (!c.smsStop ? ""
  : `${c.smsStop.source === "Textmagic" ? "Opted out of texts in Textmagic" : "Replied STOP to a text"}${
    c.smsStop.at ? ` on ${dayYear(c.smsStop.at)}` : ""}. No texts to this mobile. Calls${c.dnc ? " about their care" : " and emails"} are still fine.`);
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
    spendTier: s("spendTier"), spend12: Number(x.spend12) || 0, spendAll: Number(x.spendAll) || 0,
    spendVisits12: Number(x.spendVisits12) || 0,
    smsStop: x.smsStop && typeof x.smsStop === "object"
      ? { at: String(x.smsStop.at || ""), source: String(x.smsStop.source || "") } : null,
    log: Array.isArray(x.log) ? x.log : [], updatedAt: s("updatedAt"),
  };
}

export function mountRecall(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page rc";
  root.innerHTML = `
    <div class="rc-top"><h2>Recall</h2><span class="inv-spacer"></span>
      <button type="button" class="rc-start" data-act="session-start" hidden title="Work through My calls one patient at a time">${I.headset}<span>Start calling</span></button>
      <button type="button" class="lh-btn is-quiet" data-act="optouts" title="Mobiles that opted out of texts">Opted out</button>
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
          <label class="rc-f-row"><span>Spend</span>
            <select class="fb-select" data-role="spend" aria-label="Spend">${SPEND_OPTS.map(([k, l]) =>
              `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
          <label class="fe-check rc-f-row rc-f-tick"><input type="checkbox" data-role="spendFirst" />
            <span>My calls: higher spend first</span></label>
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
    <div class="rc-session" data-role="session" aria-label="Calling session" hidden></div>
    <div class="rc-ub" data-role="undo" role="status" aria-live="polite" hidden></div>`;
  container.replaceChildren(root);
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);

  const ui = { tab: "mine", who: "mine", cat: "", q: "", lv: "", lvFrom: "", lvTo: "", appt: "", spend: "" };
  // Upcoming visit and Spend: both added to every list and count
  const apptWhere = () => [
    ...(ui.appt ? [where("hasAppt", "==", ui.appt === "yes")] : []),
    ...(ui.spend === "pg" ? [where("spendTier", "in", ["platinum", "gold"])]
      : ui.spend ? [where("spendTier", "==", ui.spend === "none" ? "" : ui.spend)] : []),
  ];
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
  let spendFirst = getPref("rc_spendfirst", false);
  let spendInfo = null;   // recall_settings/spend_status: where each tier starts
  const showMoney = can(staff, "recall.manage");
  const tierTitle = (c) => {
    const name = TIERS[c.spendTier] || "";
    if (showMoney) {
      return `${name}: ${money(c.spend12)} in the last 12 months · ${money(c.spendAll)} all time · ` +
        `${plural(c.spendVisits12, "visit")} in 12 months. From Day Sheet prices.`;
    }
    const from = spendInfo && spendInfo.from && spendInfo.from[c.spendTier];
    return `${name}: one of the clinic's top patients by spend in the last 12 months${from ? ` (${money(from)} or more)` : ""}.`;
  };
  const tierPill = (c, cls = "") => (TIERS[c.spendTier]
    ? ` <span class="rc-tier is-${esc(c.spendTier)}${cls}" title="${esc(tierTitle(c))}">${esc(TIERS[c.spendTier])}</span>` : "");
  // My calls: higher spend first within each group (when ticked), otherwise as loaded (most recently due first)
  const bySpend = (list) => (!spendFirst ? list : list.slice().sort((a, b) =>
    (TIER_RANK[a.spendTier] ?? 9) - (TIER_RANK[b.spendTier] ?? 9) || b.spend12 - a.spend12));
  let countTimer = 0, countSeq = 0, searchTimer = 0, searchSeq = 0;
  let jumpTo = "";            // a group to scroll to once My calls has loaded ("replies", "callbacks")

  // The call just logged: saved after UNDO_MS unless Undo is pressed. One at a time.
  let pend = null;            // { id, first, label, body, kept, deadline, timer, tick, auto, counted }
  let bar = null;             // the bar at the bottom: { id, first, text, state: wait | saving | saved | failed, sent }
  let offer = null;           // the text (or email) offered after a missed call
  let quietNote = "";
  let barHide = 0;

  // On a call (after pressing Call): { id, start }. A calling session: { ids, calls, booked, paused, done, waitMore }.
  let call = null, callTick = 0;
  let session = null;
  let sessionSig = "", sessionId = "";

  // History: each card's texts and emails, from Apps Script (op "timeline")
  const tl = new Map();          // card id → { state: "loading" | "ok" | "error", data, for: the card's updatedAt }
  let tlFilter = "all";
  const openMail = new Set();    // emails opened in History (they stay open when the panel redraws)
  const tlSig = (id) => `${(tl.get(id) || {}).state || ""}|${tlFilter}`;
  function needTimeline(c) {
    const t = tl.get(c.id);
    if (t && (t.state === "loading" || t.for === c.updatedAt)) return;
    const fresh = !!t;   // the card has changed since: read it again
    tl.set(c.id, { state: "loading", data: t ? t.data : null, for: c.updatedAt });
    callApi({ action: "recall", op: "timeline", id: c.id, fresh })
      .then((r) => {
        if (!r || r.problem) throw new Error((r && r.problem) || "");
        tl.set(c.id, { state: "ok", data: r, for: c.updatedAt });
      })
      .catch((err) => {
        const old = tl.get(c.id);
        tl.set(c.id, { state: "error", data: old && old.data, for: c.updatedAt, error: errText(err, "") });
      })
      .finally(() => { if (root.isConnected && sel === c.id) drawPanel(true); });
  }

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
      // The calling session asked for the next 50: they join the end of it
      if (session && session.waitMore && sec.key === "mine") {
        session.waitMore = false;
        const last = session.ids[session.ids.length - 1];
        const add = shownIds().filter((id) => !session.ids.includes(id) && (findCard(id) || {}).status === "open");
        session.ids.push(...add);
        if (add.length) sessionMove(1, last);
      }
      drawList();
      drawPanel(false);
      drawStats();
      drawStart();
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

  function drawBar() { drawTabs(); drawWho(); drawLv(); drawFilters(); drawChips(); drawStart(); }
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
  const exactMine = () => (ui.tab === "mine" && ui.who === "mine" && !ui.cat && !ui.appt && !ui.spend && !lvRange()
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
      <button type="button" class="rc-stat2" data-go="mine"><strong>${v(done)}<em>/${target}</em></strong>
        <span class="rc-stat2-txt"><small>Called today</small><span class="rc-prog"><i style="width:${pct}%"></i></span></span></button>
      <button type="button" class="rc-stat2${replies ? " is-accent" : ""}" data-go="replies"><strong>${v(replies)}</strong>
        <span class="rc-stat2-txt"><small>Replies waiting</small></span></button>
      <button type="button" class="rc-stat2${cbs ? " is-warn" : ""}" data-go="callbacks"><strong>${v(cbs)}</strong>
        <span class="rc-stat2-txt"><small>Call-backs due</small></span></button>
      <button type="button" class="rc-stat2 is-good" data-go="booked"><strong>${v(counts.bookedMonth)}</strong>
        <span class="rc-stat2-txt"><small>Booked this month</small></span></button>`;
  }

  // "Start calling" shows on My calls once there's someone to call
  function drawStart() {
    const b = root.querySelector('[data-act="session-start"]');
    const sec = sections.find((s) => s.key === "mine");
    b.hidden = !(ui.tab === "mine" && ui.q.trim().length < 2 && sec && sec.loaded && sec.rows.length);
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
    $("spend").value = ui.spend;
    $("spendFirst").checked = spendFirst;
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
    if (ui.spend) active.push(["spend", `Spend: ${(SPEND_OPTS.find(([k]) => k === ui.spend) || ["", ""])[1]}`]);
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
    const onCall = call && call.id === c.id;
    const tag = sv ? `<span class="rc-tag is-saving">${esc(sv)}…</span>`
      : onCall ? '<span class="rc-tag is-call">On a call</span>'
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
      ? (on ? `<a class="rc-call is-main" href="tel:${esc(tel)}" data-call="${esc(c.id)}">${I.phone}<span>Call</span></a>`
        : `<a class="rc-call-ic" href="tel:${esc(tel)}" data-call="${esc(c.id)}" aria-label="Call ${name}" title="Call ${esc(mobileText(c.mobile))}">${I.phone}</a>`)
      : c.email && !c.dnc
        ? `<a class="rc-call-ic" href="mailto:${esc(c.email)}" data-card="${esc(c.id)}" aria-label="Email ${name}" title="No mobile · email them">${I.mail}</a>`
        : `<span class="rc-nomob">${c.email ? "No mobile" : "No mobile or email"}</span>`;
    return `<div class="rc-item ${rail(c, t)}${on ? " is-on" : ""}" data-card="${esc(c.id)}" role="button" tabindex="0" aria-expanded="${on}">
        <span class="rc-av h${hue(c.category)}" aria-hidden="true">${esc(initials(c.patientName))}</span>
        <span class="rc-main"><strong>${esc(c.patientName || "Unknown patient")}${tierPill(c)}${c.dnc
          ? ` <span class="rc-dnc" title="${esc(dncTitle(c))}">Do not contact</span>`
          : c.smsStop ? ` <span class="rc-dnc is-sms" title="${esc(smsStopText(c))}">No texts</span>` : ""}</strong><small>${meta}</small></span>
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
      GROUPS.map(([g, title, test]) => block(g, title, bySpend(rest.filter((c) => test(daysFrom(c.dueDate, t)))))).join("");
  }
  function scrollGroup(g) {
    if (!g) return;
    const h = root.querySelector(`.rc-sub-h[data-g="${g}"]`);
    if (h) h.scrollIntoView({ behavior: "smooth", block: "start" });
    else showToast(g === "replies" ? "No replies waiting right now." : "No call-backs due right now.");
  }

  function emptyText(sec) {
    if (ui.spend) return "Nobody here in that spend tier.";
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
        GROUPS.forEach(([, , test]) => bySpend(s.rows.filter((c) =>
          !c.replyOpen && !isCallBack(c) && test(daysFrom(c.dueDate, t)))).forEach((c) => out.push(c.id)));
      }
      else s.rows.forEach((c) => out.push(c.id));
    });
    return out;
  }

  // A text for this card, from Recall settings → Texts (the usual one, the one after a missed call, or a saved one)
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
  // The messages to choose from in the Text window [key, name, template]
  function smsChoices() {
    const s = settings.sms || {};
    return [["main", "Recall reminder", s.template], ["missed", "After a missed call", s.missedTemplate],
      ...(Array.isArray(s.saved) ? s.saved : []).map((m, i) => [`s${i}`, m.name, m.text])];
  }

  /* ---------- One card: the pieces (the panel and the calling session both use them) ---------- */
  function chipsHtml(c, t) {
    const dueCls = rail(c, t).replace("r-", "is-");
    return [
      TIERS[c.spendTier] ? `<span class="rc-pill rc-tier is-${esc(c.spendTier)}" title="${esc(tierTitle(c))}">${esc(TIERS[c.spendTier])}</span>` : "",
      c.category ? `<span class="rc-pill is-cat">${esc(c.category)}</span>` : "",
      `<span class="rc-pill ${dueCls}">${esc(dueText(c, t))}</span>`,
      c.alsoDue.length ? `<span class="rc-pill is-also">Also due: ${esc(c.alsoDue.join(", "))}</span>` : "",
    ].join("");
  }
  function noticesHtml(c) {
    return (c.reply ? `<div class="rc-reply${c.replyOpen ? " is-open" : ""}"><strong>${esc(REPLY_TAG[c.reply.kind] || "Replied")} · ${esc(when(c.reply.at))}</strong>
        <p>${esc(c.reply.text)}</p></div>` : "") +
      (c.dnc ? `<div class="rc-dnc-note"><strong>Do not contact</strong> · ${esc(dncTitle(c))}</div>`
        : c.smsStop ? `<div class="rc-dnc-note is-sms"><strong>No texts</strong> · ${esc(smsStopText(c))}</div>` : "");
  }
  function ctxHtml(c, t) {
    const lastCall = c.log.slice().reverse().find((l) => /no answer|voicemail|spoke|booked/i.test(String(l.what || "")));
    const items = [
      ["Last visit", c.lastVisit ? `${nice(c.lastVisit)}${c.lastStaff ? ` with ${c.lastStaff}` : ""}` : "Not known"],
      ["Had", c.lastServices.join(", ") || "–"],
      ["Calls so far", c.attempts ? `${c.attempts}${lastCall ? ` · ${String(lastCall.what).toLowerCase()} ${dayOf(lastCall.at)}` : ""}` : "None yet"],
      ["Last text", c.smsStop ? `Opted out${c.lastTextAt ? ` · last texted ${dayOf(c.lastTextAt)}` : ""}`
        : c.lastTextAt ? `${dayOf(c.lastTextAt)}${c.texts > 1 ? ` · ${c.texts} so far` : ""}` : "None yet"],
      ["Upcoming", c.nextAppt && c.nextAppt >= t ? short(c.nextAppt) : "Nothing booked"],
      ["Due", nice(c.dueDate) || "–"],
      ...(c.spendAll || c.spendTier ? [["Spent", showMoney
        ? `${money(c.spend12)} in 12 months · ${money(c.spendAll)} all time`
        : TIERS[c.spendTier] ? `${TIERS[c.spendTier]} tier` : "–"]] : []),
    ];
    return `<div class="rc-ctx">${items.map(([a, b]) => `<div><small>${esc(a)}</small><span>${esc(b)}</span></div>`).join("")}</div>`;
  }
  // Call on top (unless it's drawn elsewhere), then Text · Email · Patient
  function contactHtml(c, withCall = true) {
    const tel = telOf(c.mobile);
    return `<div class="rc-contact">
      ${withCall ? (tel ? `<a class="rc-call is-main" href="tel:${esc(tel)}" data-call="${esc(c.id)}">${I.phone}<span>Call ${esc(mobileText(c.mobile))}</span></a>`
        : '<span class="rc-nomob">No mobile on file</span>') : ""}
      ${tel && c.status !== "closed" ? (c.dnc || c.smsStop
        ? `<button type="button" class="lh-btn" disabled title="${esc(c.dnc ? dncTitle(c) : smsStopText(c))}">${I.msg}<span>Text</span></button>`
        : `<button type="button" class="lh-btn" data-act="sms">${I.msg}<span>Text</span></button>`) : ""}
      ${c.email ? (c.dnc
        ? `<button type="button" class="lh-btn" disabled title="${esc(dncTitle(c))}">${I.mail}<span>Email</span></button>`
        : `<a class="lh-btn" href="mailto:${esc(c.email)}" data-card="${esc(c.id)}">${I.mail}<span>Email</span></a>`) : ""}
      ${c.patientId ? `<a class="lh-btn" href="#/patient/${encodeURIComponent(c.patientId)}" title="Open their patient page">${I.user}<span>Patient</span></a>` : ""}
    </div>`;
  }
  function smsBoxHtml() {
    if (draft.sms == null) return "";
    return `<div class="rc-sms">
      <label class="rc-sms-pick"><span>Message</span>
        <select class="fb-select" data-role="smsPick" aria-label="Message">${smsChoices().map(([k, l]) =>
          `<option value="${esc(k)}"${draft.smsKey === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <textarea class="fe-input" data-role="sms" rows="4" maxlength="560" aria-label="Text message">${esc(draft.sms)}</textarea>
      <small class="fe-note" data-role="smsInfo">${esc(smsInfo(draft.sms))}</small>
      <div class="rc-row"><span class="inv-spacer"></span>
        <button type="button" class="lh-btn is-quiet" data-act="sms-cancel">Cancel</button>
        <button type="button" class="btn-primary" data-act="sms-send">${I.send}<span>Send text</span></button></div>
    </div>`;
  }
  function onCallHtml(c, t, withSub = true) {
    const sub = [c.category, dueText(c, t),
      c.lastServices.length ? `last had ${c.lastServices.join(", ")}${c.lastStaff ? ` with ${c.lastStaff}` : ""}` : c.lastStaff ? `last with ${c.lastStaff}` : "",
      c.alsoDue.length ? `also due: ${c.alsoDue.join(", ")}` : ""].filter(Boolean).join(" · ");
    return `<div class="rc-oncall"><span class="rc-oncall-dot" aria-hidden="true"></span>
        <strong>On a call with ${esc(first(c.patientName) || "them")}</strong>
        <span class="rc-oncall-t" data-role="callTime">${clock(Date.now() - call.start)}</span></div>
      ${withSub ? `<p class="rc-oncall-sub">${esc(sub)}</p>` : ""}`;
  }
  function workHtml(c, t, inSession) {
    if (c.status === "closed") {
      return `<div class="rc-state">Closed: ${esc(c.closeReason)}${c.closedBy ? ` · ${esc(c.closedBy)}` : ""}${c.closedAt ? ` · ${esc(when(c.closedAt))}` : ""}</div>
        ${c.closeReason === "Came in" ? "" : '<button type="button" class="lh-btn" data-act="reopen">Reopen</button>'}`;
    }
    if (c.status === "booked") {
      return `<div class="rc-state is-ok">${c.bookedFor
        ? `Booked for ${esc(nice(c.bookedFor))}. The card closes by itself when they come in.`
        : "Marked as booked by phone. If it isn't in the appointment book within 3 days, the card goes back to My calls."}</div>
        <button type="button" class="lh-btn" data-act="reopen">Not booked after all</button>`;
    }
    const onCall = !!(call && call.id === c.id);
    const ownDate = !!draft.remind && !PICKS.some(([, fn]) => fn(t) === draft.remind);   // picked from the calendar
    return `
      <div class="rc-ask">${onCall ? "How did it go?" : "What happened?"}</div>
      <div class="rc-tiles">${TILES.map(([k, l, key]) => `<button type="button" class="rc-tile${k === "booked" ? " is-good" : ""}" data-out="${k}">
        ${TILE_ICON[k]}<span>${esc(l)}</span><kbd>${key}</kbd></button>`).join("")}</div>
      <textarea class="fe-input rc-note" data-role="note" rows="2" maxlength="1000"
        placeholder="Add a note or call-back first if you like, then tap what happened">${esc(draft.note)}</textarea>
      <div class="rc-cb"><small class="rc-cb-lbl">Call back</small><div class="rc-cb-picks">${PICKS.map(([l, fn], i) =>
        `<button type="button" class="rc-chip${draft.remind === fn(t) ? " is-on" : ""}" data-pick="${i}">${esc(l)}</button>`).join("")}
        <span class="rc-cb-date">
          <button type="button" class="rc-chip rc-cb-pick${ownDate ? " is-on" : ""}" data-act="pick-date" title="Choose a date"
            aria-label="${ownDate ? `Call back ${esc(short(draft.remind))}. Change the date` : "Choose a date"}">${I.cal}${
            ownDate ? `<span>${esc(short(draft.remind))}</span>` : ""}</button>
          <input type="date" class="rc-cb-input" data-remind min="${addDays(t, 1)}" value="${esc(draft.remind)}" tabindex="-1" aria-hidden="true" />
        </span></div></div>
      <div class="rc-work-foot">
        ${inSession || onCall ? "" : `<label class="fe-check rc-auto"><input type="checkbox" data-role="auto"${autoNext ? " checked" : ""} /> Open the next patient after</label>`}
        <span class="inv-spacer"></span>
        ${onCall ? '<button type="button" class="lh-btn is-quiet" data-act="call-end" title="Close the call screen without logging">Log it later</button>' : ""}
        <button type="button" class="lh-btn is-quiet" data-act="save">${draft.remind ? "Save call-back" : "Save note"}</button>
      </div>`;
  }
  function moreHtml(c, t) {
    if (c.status === "closed") return "";
    const team = new Set(settings.team);
    const ppl = [...people].sort((a, b) => (team.has(b.id) - team.has(a.id)) || String(a.name).localeCompare(String(b.name)));
    if (c.assignedToId && !ppl.some((s) => s.id === c.assignedToId)) ppl.unshift({ id: c.assignedToId, name: c.assignedToName || "Someone" });
    const reason = settings.reasons.find((r) => r.label === draft.reason);
    const stop = c.status !== "open" ? "" : `
      <div class="rc-f-row"><span>Stop recall</span>
        <div class="rc-row">
          <select class="fb-select" data-role="reason" aria-label="Reason">
            <option value="">Choose a reason</option>${settings.reasons.map((r) =>
              `<option value="${esc(r.label)}"${r.label === draft.reason ? " selected" : ""}>${esc(r.label)}</option>`).join("")}</select>
          ${reason && reason.askDate ? `<label>until <input type="date" class="fe-input" data-role="until" min="${addDays(t, 1)}" value="${esc(draft.until)}" /></label>` : ""}
          <button type="button" class="lh-btn" data-act="close">${reason && reason.askDate ? "Pause" : "Stop"}</button>
        </div>
        ${reason ? `<label class="fe-check rc-all"><input type="checkbox" data-role="allCards"${
          reason.dnc ? " checked disabled" : (draft.all ?? allDefault(reason)) ? " checked" : ""} />
          ${reason.askDate ? "Pause" : "Stop"} all their recalls, not just ${esc(c.category || "this one")}</label>` : ""}
        ${reason && reason.dnc ? '<small class="fe-note">This also puts them on the do-not-contact list, and stops all their recalls.</small>' : ""}</div>`;
    return `<details class="rc-more" data-role="more"${moreOpen ? " open" : ""}>
      <summary><span>Given to ${esc(c.assignedToName || "nobody yet")}${c.status === "open" ? " · Stop recall" : ""}</span>${I.chev}</summary>
      <div class="rc-more-body">
        <label class="rc-f-row"><span>Given to</span>
          <select class="fb-select" data-role="assign" aria-label="Given to">
            <option value="">Nobody yet (waiting)</option>${ppl.map((s) =>
              `<option value="${esc(s.id)}"${s.id === c.assignedToId ? " selected" : ""}>${esc(s.name)}${team.size && !team.has(s.id) ? " (not in the recall team)" : ""}</option>`).join("")}
          </select></label>
        ${stop}
      </div></details>`;
  }
  /* ---------- History: texts, emails, calls and changes, by day ---------- */
  const tlDay = (iso) => {
    const d = new Date(iso || "");
    if (isNaN(d)) return "";
    const k = fmtKey(d), t = todayKey();
    if (k === t) return "Today";
    if (k === addDays(t, -1)) return "Yesterday";
    return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short",
      ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
  };
  const tlTime = (iso) => { const d = new Date(iso || ""); return isNaN(d) ? "" : d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }); };
  const tlAuto = (by) => /^recall( flow)?$/i.test(String(by || ""));

  // The card's own History, with its texts and emails swapped for the full ones once they've loaded
  function tlItems(c) {
    const t = tl.get(c.id);
    const d = t && t.data;
    const haveTexts = !!(d && Array.isArray(d.texts));
    const haveMail = !!(d && Array.isArray(d.emails));
    const out = [];
    c.log.forEach((l) => {
      const w = String(l.what || "");
      const isText = l.kind === "text" || (l.kind === "flow" && /^Text sent/.test(w));
      const isMail = l.kind === "email" || (l.kind === "flow" && /^Email sent/.test(w));
      const isReply = l.kind === "reply" && /^Replied(: wants to book| STOP)?$/.test(w);
      if ((isText || isReply) && haveTexts) return;
      if (isMail && haveMail) return;
      if (isText && l.note) out.push({ type: "sms", dir: "out", at: l.at, text: l.note, by: l.by, auto: !l.byUid });
      else if (isReply && l.note) out.push({ type: "sms", dir: "in", at: l.at, text: l.note, kind: /STOP/.test(w) ? "stop" : /book/.test(w) ? "yes" : "other" });
      else if (isMail) out.push({ type: "mail", dir: "out", at: l.at, subject: w.replace(/^Email sent:\s*/, ""), text: "", by: l.by, auto: !l.byUid });
      else out.push({ type: "ev", at: l.at, what: w, note: l.note, by: l.by, kind: l.kind });
    });
    if (haveTexts) d.texts.forEach((m) => out.push({ type: "sms", dir: m.dir, at: m.at, text: m.text, by: m.by, src: m.src,
      kind: m.kind, status: m.status || "", auto: tlAuto(m.by) }));
    if (haveMail) d.emails.forEach((m) => out.push({ type: "mail", ...m }));
    return out.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }

  function tlItemHtml(x, c) {
    const meta = (bits) => `<small class="rc-tl-meta">${bits.filter(Boolean).map(esc).join(" · ")}</small>`;
    if (x.type === "sms") {
      const who = x.dir === "in" ? first(c.patientName) || "Patient" : x.auto ? "Automatic" : x.by || "Clinic";
      const tag = x.dir === "in" && x.kind && x.kind !== "other"
        ? `<span class="rc-tl-tag is-${esc(x.kind)}">${esc(REPLY_TAG[x.kind] || "")}</span>` : "";
      return `<div class="rc-tl-msg is-${x.dir}"><span class="rc-tl-ic">${I.msg}</span><div class="rc-tl-body">
        <div class="rc-tl-bubble">${esc(x.text)}</div>
        ${meta([x.dir === "in" ? "Text received" : "Text sent", who, x.src && x.src !== "Recall" ? x.src : "", tlTime(x.at)])}${
          x.dir === "out" && x.status ? `<span class="rc-tl-st is-${x.status === "Failed" ? "bad" : x.status === "Delivered" ? "ok" : "wait"}">${
            x.status === "Failed" ? I.x : x.status === "Delivered" ? I.check : I.clock}${esc(x.status)}</span>` : ""}${tag}</div></div>`;
    }
    if (x.type === "mail") {
      const key = x.id || `${x.at}|${x.subject}`;
      const who = x.dir === "in" ? x.from || first(c.patientName) : x.auto ? "Automatic" : x.by || x.from || "Clinic";
      const prev = String(x.text || "").replace(/\s+/g, " ").trim().slice(0, 140);
      return `<details class="rc-tl-mail is-${x.dir}${x.bulk ? " is-bulk" : ""}" data-mail="${esc(key)}"${openMail.has(key) ? " open" : ""}>
        <summary><span class="rc-tl-ic">${I.mail}</span><span class="rc-tl-mhead">
          <strong>${esc(x.subject || "(no subject)")}</strong>${prev ? `<span class="rc-tl-prev">${esc(prev)}</span>` : ""}
          ${meta([x.dir === "in" ? "Email received" : x.bulk ? "Marketing email" : "Email sent", who, tlTime(x.at)])}</span></summary>
        ${x.text ? `<div class="rc-tl-mbody">${esc(x.text)}</div>` : '<p class="rc-tl-mbody muted">Only the subject was saved for this one.</p>'}
        ${/^https:\/\/mail\.google\.com\//.test(String(x.link || "")) ? `<a class="rc-tl-open" href="${esc(x.link)}" target="_blank" rel="noopener">Open in Gmail</a>` : ""}
      </details>`;
    }
    return `<div class="rc-tl-ev${x.kind === "call" ? " is-call" : ""}"><span class="rc-tl-ic">${histIcon(x.what)}</span><div>
      <strong>${esc(x.what)}</strong>${x.note ? `<p>${esc(x.note)}</p>` : ""}${meta([x.by, tlTime(x.at)])}</div></div>`;
  }

  function histHtml(c, max = 0) {
    const t = tl.get(c.id);
    const all = tlItems(c);
    if (!all.length && !(t && t.state === "loading")) return "";
    const groups = [["all", "All", () => true], ["sms", "Texts", (x) => x.type === "sms"],
      ["mail", "Emails", (x) => x.type === "mail"], ["calls", "Calls", (x) => x.type === "ev" && x.kind === "call"]];
    const items = all.filter((groups.find((g) => g[0] === tlFilter) || groups[0])[2]);
    const shown = max ? items.slice(0, max) : items;
    let day = "";
    const body = shown.map((x) => {
      const dl = tlDay(x.at);
      const head = dl !== day ? `<div class="rc-tl-day"><span>${esc(dl)}</span></div>` : "";
      day = dl;
      return head + tlItemHtml(x, c);
    }).join("");
    const d = t && t.data;
    const status = !t || t.state === "loading" ? '<small class="rc-tl-status">Loading texts and emails…</small>'
      : t.state === "error" ? `<small class="rc-tl-status is-err">Texts and emails couldn't be loaded.
          <button type="button" class="rc-tl-retry" data-act="tl-retry">Try again</button></small>`
      : d && (d.textError || d.emailError) ? `<small class="rc-tl-status">${esc([d.textError, d.emailError].filter(Boolean).join(" "))}</small>` : "";
    return `<div class="rc-tl-wrap">
      <div class="rc-tl-top"><h4 class="rc-h">History</h4><span class="inv-spacer"></span>
        <div class="rc-tl-filters">${groups.map(([k, l, fn]) => {
          const n = all.filter(fn).length;
          return k === "all" || n ? `<button type="button" class="rc-chip${tlFilter === k ? " is-on" : ""}" data-tlf="${k}">${esc(l)}${
            k === "all" ? "" : ` <em>${n}</em>`}</button>` : "";
        }).join("")}</div></div>
      ${status}
      ${items.length ? `<div class="rc-tl">${body}</div>` : '<p class="rc-empty">Nothing here yet.</p>'}
      ${max && items.length > max ? `<small class="muted">Latest ${max} of ${items.length}. Open the card for all of them.</small>` : ""}
    </div>`;
  }

  function panelHtml(c, sv) {
    const t = todayKey();
    const onCall = !!(call && call.id === c.id) && c.status === "open";
    return `
      <div class="rc-ph"><span class="rc-av rc-av-lg h${hue(c.category)}" aria-hidden="true">${esc(initials(c.patientName))}</span>
        <div class="rc-ph-main"><h3>${esc(c.patientName || "Unknown patient")}</h3><div class="rc-pchips">${chipsHtml(c, t)}</div></div>
        <button type="button" class="rc-x" data-act="deselect" aria-label="Close">${I.x}</button></div>
      ${noticesHtml(c)}
      ${onCall ? onCallHtml(c, t) : contactHtml(c) + smsBoxHtml() + ctxHtml(c, t)}
      ${sv ? `<p class="rc-saving-line" role="status">${esc(sv)}…</p>` : ""}
      <div class="rc-work">${workHtml(c, t, false)}</div>
      ${moreHtml(c, t)}${histHtml(c)}`;
  }

  function drawPanel(force) {
    if (session) { drawSession(force); return; }
    const p = $("panel");
    const c = sel ? findCard(sel) : null;
    if (!c) { p.hidden = true; p.innerHTML = ""; panelSig = ""; panelId = ""; return; }
    const sv = busyLabel(c.id);
    needTimeline(c);
    const sig = `${c.id}|${c.updatedAt}|${c.status}|${people.length}|${sv}|${call && call.id === c.id ? "call" : ""}|${tlSig(c.id)}`;
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

  /* ---------- Calling session: My calls, one patient at a time ---------- */
  function sessionHtml(c) {
    const s = session, t = todayKey(), n = s.ids.length;
    const pos = c ? Math.max(1, s.ids.indexOf(c.id) + 1) : n;
    const pct = s.done ? 100 : Math.round(((pos - 1) / n) * 100);
    const live = !s.done && !s.paused;
    const top = `<div class="rc-ss-top">
        <div class="rc-ss-title"><strong>${I.headset}<span>Calling session</span></strong>
          <small>${s.done ? "Finished" : `${pos} of ${n}`} · ${plural(s.calls, "call")} logged · ${s.booked} booked</small></div>
        <span class="inv-spacer"></span>
        ${live ? `<button type="button" class="lh-btn is-quiet" data-act="session-prev" title="Previous patient (↑)">${I.prev}<span>Previous</span></button>
          <button type="button" class="lh-btn is-quiet" data-act="session-skip" title="Skip for now (↓)"><span>Skip</span>${I.next}</button>
          <button type="button" class="lh-btn" data-act="session-pause" title="Pause (Esc)">${I.pause}<span>Pause</span></button>` : ""}
        <button type="button" class="lh-btn" data-act="session-end">${I.x}<span>End</span></button>
      </div>
      <span class="rc-prog rc-ss-prog"><i style="width:${pct}%"></i></span>`;
    if (s.paused) {
      return `${top}<div class="tb-card rc-ss-msg"><strong>Paused</strong>
        <p>${pos} of ${n} · ${plural(s.calls, "call")} logged so far.</p>
        <div class="rc-ss-msg-acts"><button type="button" class="btn-primary" data-act="session-resume">${I.play}<span>Resume</span></button>
          <button type="button" class="lh-btn" data-act="session-end">End session</button></div></div>`;
    }
    if (s.done) {
      const sec = sections.find((x) => x.key === "mine");
      return `${top}<div class="tb-card rc-ss-msg"><strong>${s.waitMore ? "Loading the next patients…" : "That's everyone in the list"}</strong>
        <p>${plural(s.calls, "call")} logged · ${s.booked} booked this session.</p>
        <div class="rc-ss-msg-acts">${sec && sec.more && !s.waitMore
          ? `<button type="button" class="btn-primary" data-act="session-more">Keep going: load ${PAGE} more</button>` : ""}
          <button type="button" class="lh-btn" data-act="session-end">Back to Recall</button></div></div>`;
    }
    if (!c) return `${top}<div class="skeleton" style="height:360px;border-radius:14px"></div>`;
    const tel = telOf(c.mobile);
    const onCall = !!(call && call.id === c.id) && c.status === "open";
    const sv = busyLabel(c.id);
    return `${top}<div class="rc-ss-grid">
      <section class="tb-card rc-ss-who">
        <div class="rc-ss-head"><span class="rc-av rc-av-xl h${hue(c.category)}" aria-hidden="true">${esc(initials(c.patientName))}</span>
          <div><h3>${esc(c.patientName || "Unknown patient")}</h3><div class="rc-pchips">${chipsHtml(c, t)}</div></div></div>
        ${noticesHtml(c)}
        ${onCall ? onCallHtml(c, t, false) : `<div class="rc-ss-num">${tel ? esc(mobileText(c.mobile)) : "No mobile on file"}</div>
          ${tel ? `<a class="rc-call is-main is-big" href="tel:${esc(tel)}" data-call="${esc(c.id)}">${I.phone}<span>Call</span><kbd>C</kbd></a>` : ""}`}
        ${contactHtml(c, false)}${smsBoxHtml()}
        ${ctxHtml(c, t)}
      </section>
      <section class="tb-card rc-ss-work${sv ? " is-saving" : ""}">
        ${sv ? `<p class="rc-saving-line" role="status">${esc(sv)}…</p>` : ""}
        <div class="rc-work">${workHtml(c, t, true)}</div>
        ${moreHtml(c, t)}${histHtml(c, 5)}
      </section></div>
      <p class="rc-ss-keys">${SESSION_KEYS.map(([k, l]) => `<span><kbd>${k}</kbd> ${esc(l)}</span>`).join("")}</p>`;
  }

  function drawSession(force) {
    const box = $("session");
    const s = session;
    const c = !s.done && sel ? findCard(sel) : null;
    if (!s.done && !s.paused && sel && !c) {   // their card has gone (booked or moved by someone else): on to the next
      setTimeout(() => { if (session && !session.done && sel && !findCard(sel)) sessionMove(1, sel); }, 0);
    }
    const sv = c ? busyLabel(c.id) : "";
    if (c) needTimeline(c);
    const sig = [s.done, s.paused, s.waitMore, s.calls, s.booked, c ? `${c.id}|${c.updatedAt}|${c.status}|${tlSig(c.id)}` : "",
      sv, call ? call.id : "", people.length].join("|");
    if (!force && sig === sessionSig) return;
    const same = !!c && sessionId === c.id;
    sessionSig = sig;
    sessionId = c ? c.id : "";
    const render = () => {
      box.innerHTML = sessionHtml(c);
      const nb = box.querySelector('[data-role="note"]');
      if (nb) grow(nb);
    };
    if (same) keepFocus(box, render); else render();
  }

  // The next (dir 1) or previous (dir -1) open card in the session. Past the last one, the session is finished.
  function sessionMove(dir, fromId = sel) {
    const s = session;
    if (!s) return false;
    const i = s.ids.indexOf(fromId);
    for (let j = i + dir; j >= 0 && j < s.ids.length; j += dir) {
      const id = s.ids[j];
      const c = findCard(id);
      if (c && c.status === "open" && !busyLabel(id)) { s.done = false; openCard(id); return true; }
    }
    if (dir > 0) { endCall(); s.done = true; sel = ""; drawPanel(true); }
    else showToast("This is the first patient in the session.");
    return false;
  }

  function startSession() {
    if (ui.tab !== "mine" || ui.q.trim().length >= 2) return;
    const ids = shownIds().filter((id) => { const c = findCard(id); return c && c.status === "open"; });
    if (!ids.length) { showToast("Nothing to call right now."); return; }
    session = { ids, calls: 0, booked: 0, paused: false, done: false, waitMore: false };
    sessionSig = ""; sessionId = "";
    root.classList.add("is-session");
    const p = $("panel");
    p.hidden = true; p.innerHTML = ""; panelSig = ""; panelId = "";
    $("session").hidden = false;
    const startId = sel && ids.includes(sel) && !busyLabel(sel) ? sel : ids.find((id) => !busyLabel(id));
    if (startId) openCard(startId); else { session.done = true; drawPanel(true); }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function endSession() {
    if (!session) return;
    const s = session;
    session = null;
    endCall();
    root.classList.remove("is-session");
    const box = $("session");
    box.hidden = true; box.innerHTML = ""; sessionSig = ""; sessionId = "";
    drawList();
    drawPanel(true);
    drawStart();
    if (s.calls) showToast(`Session ended: ${plural(s.calls, "call")} logged, ${s.booked} booked.`);
  }

  /* ---------- On a call ---------- */
  function startCall(id) {
    endCall();
    call = { id, start: Date.now() };
    callTick = setInterval(() => {
      const el = root.querySelector('[data-role="callTime"]');
      if (el && call) el.textContent = clock(Date.now() - call.start);
    }, 1000);
    if (sel !== id) openCard(id);
    else { drawList(); drawPanel(true); }
    const first = root.querySelector('.rc-tile[data-out="no_answer"]');
    if (first) first.focus({ preventScroll: true });
  }
  function endCall() {
    if (callTick) clearInterval(callTick);
    callTick = 0;
    const had = !!call;
    call = null;
    return had;
  }

  function openCard(id) {
    if (call && call.id !== id) endCall();
    sel = id;
    seenSel = inRows(id);
    draft = blank();
    moreOpen = false;
    drawList();
    drawPanel(true);
    if (session) return;
    const row = root.querySelector(`[data-card="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function select(id) {
    if (pend && pend.id === id) commit();   // reopening it: save now
    if (sel === id) { endCall(); sel = ""; seenSel = false; draft = blank(); drawList(); drawPanel(true); return; }
    openCard(id);
  }
  // After logging a call: the next open card that was below this one (not one still saving)
  function goNext(fromId, ids) {
    const i = ids.indexOf(fromId);
    const next = ids.slice(i + 1).find((id) => { const c = findCard(id); return c && c.status === "open" && !busyLabel(id); });
    if (next) openCard(next);
    else { sel = ""; draft = blank(); drawList(); drawPanel(true); }
  }
  // ↓ / ↑ on the board: the next or previous patient in the list
  function moveSel(dir) {
    const ids = shownIds();
    if (!ids.length) return;
    const i = ids.indexOf(sel);
    const j = i === -1 ? (dir > 0 ? 0 : ids.length - 1) : i + dir;
    if (j >= 0 && j < ids.length) openCard(ids[j]);
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
    if (isMobile(c.mobile) && !c.smsStop) return { kind: "sms", text: fillSms(c, settings.sms.missedTemplate), auto: mode === "auto" };
    if (c.email) return { kind: "email", auto: false, why: c.smsStop ? "They've opted out of texts." : "No mobile on file." };
    if (c.smsStop) return { skip: "They've opted out of texts, so no text is offered." };
    return { skip: "No mobile or email on file, so there's nothing to send." };
  }

  function logOutcome(k) {
    const id = sel;
    const c = findCard(id);
    if (!c || c.status !== "open") return;
    if (busyLabel(id)) { showToast("Still saving the last change. One moment."); return; }
    if (pend) commit();   // the call before this one saves now
    endCall();
    const f = first(c.patientName) || "Patient";
    const kept = { ...draft };
    const ids = shownIds();
    const o = missedOffer(c, k);
    clearTimeout(barHide); barHide = 0;
    offer = o && o.kind ? { ...o, id, first: f, mobile: c.mobile, email: c.email, editing: false, busy: false } : null;
    quietNote = o && o.skip ? o.skip : "";
    pend = { id, first: f, label: LABEL[k], body: { outcome: k, note: kept.note, remindOn: kept.remind }, kept,
      deadline: Date.now() + UNDO_MS, auto: offer && offer.auto ? offer : null, counted: session ? k : "" };
    pend.timer = setTimeout(commit, UNDO_MS);
    pend.tick = setInterval(tickUndo, 500);
    bar = { id, first: f, text: `${f}: ${LABEL[k].toLowerCase()}`, state: "wait", sent: false };
    draft = blank();
    if (session) {
      session.calls += 1;
      if (k === "booked") session.booked += 1;
      sessionMove(1, id);
    } else if (autoNext) goNext(id, ids);
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
      if (root.isConnected && sel !== p.id) {
        if (session) session.done = false;
        sel = p.id; seenSel = inRows(p.id); draft = p.kept; drawList(); drawPanel(true);
      }
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
    if (session && p.counted) {
      session.calls = Math.max(0, session.calls - 1);
      if (p.counted === "booked") session.booked = Math.max(0, session.booked - 1);
      session.done = false;
      session.paused = false;
    }
    sel = p.id;
    seenSel = inRows(p.id);
    draft = p.kept;
    moreOpen = false;
    drawList();
    drawPanel(true);
    drawUndo();
    if (!session) {
      const row = root.querySelector(`[data-card="${CSS.escape(p.id)}"]`);
      if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
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
      off = `<div class="rc-ub-offer"><strong>${esc(o.why || "No mobile on file.")} Email ${esc(o.first)} instead?</strong>
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

  /* ---------- Opted out of texts: Textmagic's list and STOP replies ---------- */
  function ooRow(r) {
    const mob = mobileText(r.phone);
    const src = r.source === "Textmagic" ? "Opted out in Textmagic" : "Replied STOP";
    const cards = [r.open ? plural(r.open, "open recall") : "", r.booked ? `${r.booked} booked` : ""].filter(Boolean).join(" · ");
    return `<li class="rc-oo-row" data-q="${esc(`${r.name || ""} ${r.phone} ${mob}`.toLowerCase())}">
      <div class="rc-oo-main"><strong>${esc(r.name || mob)}</strong>
        <small>${esc([r.name ? mob : "", src, dayYear(r.at)].filter(Boolean).join(" · "))}</small></div>
      ${cards ? `<span class="rc-oo-cards">${esc(cards)}</span>` : ""}
      ${r.patientId ? `<a class="lh-btn is-quiet" href="#/patient/${encodeURIComponent(r.patientId)}">${I.user}<span>Patient</span></a>` : ""}
    </li>`;
  }

  async function showOptouts(sync = false) {
    let dlg = root.querySelector("dialog.rc-oo");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "rc-oo";
      dlg.setAttribute("aria-label", "Opted out of texts");
      root.appendChild(dlg);
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest('[data-oo="close"]')) { dlg.close(); return; }
        const sb = e.target.closest('[data-oo="sync"]');
        if (sb && !sb.disabled) showOptouts(true);
      });
      dlg.addEventListener("input", (e) => {
        if (e.target.dataset.oo !== "q") return;
        const q = e.target.value.trim().toLowerCase();
        const digits = q.replace(/\D/g, "");
        let n = 0;
        dlg.querySelectorAll(".rc-oo-row").forEach((li) => {
          const hit = !q || li.dataset.q.includes(q) || (digits.length >= 3 && li.dataset.q.replace(/\D/g, "").includes(digits));
          li.hidden = !hit;
          if (hit) n++;
        });
        const none = dlg.querySelector('[data-oo="none"]');
        if (none) { none.hidden = n > 0; none.textContent = "No match."; }
      });
    }
    const head = `<div class="rc-oo-head"><h3>Opted out of texts</h3><span class="inv-spacer"></span>
      <button type="button" class="rc-x" data-oo="close" aria-label="Close">${I.x}</button></div>`;
    dlg.innerHTML = `${head}<p class="fe-note">${sync ? "Checking Textmagic…" : "Loading…"}</p>
      <div class="skeleton" style="height:220px;border-radius:12px"></div>`;
    if (!dlg.open) dlg.showModal();

    let res;
    try { res = await callApi({ action: "recall", op: "smsOptouts", sync }); }
    catch (err) { res = { problem: errText(err, "Couldn't load the list. Try again.") }; }
    if (!dlg.isConnected || !dlg.open) return;
    if (!res || res.problem) {
      dlg.innerHTML = `${head}<p class="rc-empty">${esc((res && res.problem) || "Couldn't load the list. Try again.")}</p>`;
      return;
    }
    const rows = Array.isArray(res.rows) ? res.rows : [];
    const st = res.status || {};
    const fromTm = rows.filter((r) => r.source === "Textmagic").length;
    dlg.innerHTML = `${head}
      <p class="fe-note">No recall texts go to these mobiles. Calls are still fine, and emails too unless they're on the
        do-not-contact list. ${esc(plural(rows.length, "mobile"))}: ${fromTm} from Textmagic's list, ${rows.length - fromTm} replied STOP${
        st.at ? `. Textmagic last checked ${esc(when(st.at))}` : ""}.</p>
      <div class="rc-oo-bar">
        <input type="search" class="fe-input" data-oo="q" placeholder="Find a name or mobile" aria-label="Find a name or mobile" />
        ${can(staff, "recall.manage") ? '<button type="button" class="lh-btn" data-oo="sync">Check Textmagic now</button>' : ""}
      </div>
      ${rows.length ? `<ul class="rc-oo-list">${rows.map(ooRow).join("")}</ul>` : ""}
      <p class="rc-empty" data-oo="none"${rows.length ? " hidden" : ""}>Nobody has opted out of texts.</p>`;
    if (sync) showToast(st.added ? `${plural(st.added, "new opt-out")} from Textmagic` : "Up to date with Textmagic");
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
    const ds = e.target.dataset || {};
    if (ds.role === "more") moreOpen = e.target.open;
    if (ds.mail) { if (e.target.open) openMail.add(ds.mail); else openMail.delete(ds.mail); }
  }, true);
  root.addEventListener("change", async (e) => {
    const el = e.target;
    const r = el.dataset.role;
    if (r === "who") { ui.who = el.value; sel = ""; build(); return; }
    if (r === "appt") { ui.appt = el.value; sel = ""; build(); return; }
    if (r === "spend") { ui.spend = el.value; sel = ""; build(); return; }
    if (r === "spendFirst") { spendFirst = el.checked; setPref("rc_spendfirst", spendFirst); drawList(); return; }
    if (r === "lv") {
      ui.lv = el.value;
      sel = "";
      if (ui.lv === "custom" && !ui.lvFrom && !ui.lvTo) { drawLv(); drawFilters(); return; }   // wait for a date
      build();
      return;
    }
    if (r === "lvFrom" || r === "lvTo") { ui[r] = el.value; sel = ""; build(); return; }
    if (r === "auto") { autoNext = el.checked; setPref("rc_autonext", autoNext); return; }
    if (r === "smsPick") {
      const ch = smsChoices().find(([k]) => k === el.value);
      const c = findCard(sel);
      if (ch && c) { draft.smsKey = ch[0]; draft.sms = fillSms(c, ch[2]); drawPanel(true); }
      return;
    }
    if (el.matches("[data-remind]")) { draft.remind = el.value; el.blur(); drawPanel(true); return; }   // blur: N, V, S, B keep working
    if (r === "until") { draft.until = el.value; return; }
    if (r === "allCards") { draft.all = el.checked; return; }
    if (r === "reason") { draft.reason = el.value; draft.all = null; drawPanel(true); return; }
    if (r === "assign" && !(await act("assign", { toId: el.value }, { label: "Saving", btn: el }))) drawPanel(true);
  });
  root.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest(".rc-item");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(row.dataset.card); }
  });

  // Keys: N, V, S, B log a call · C calls · T sends the offered text · U undoes · ↓ ↑ (or J K) move · Esc closes or pauses
  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector("dialog[open]") || document.querySelector(".rem:not(.is-min)")) return;
    const k = e.key.toLowerCase();
    if (session && session.paused) {
      if (k === "enter" && !/^(BUTTON|A)$/.test(t.tagName)) { e.preventDefault(); session.paused = false; drawPanel(true); }
      return;
    }
    if (k === "escape") {
      const f = $("filters");
      if (f.open) { f.open = false; return; }
      if (bar || offer) { dismissBar(); return; }
      if (session) { if (!session.done) { session.paused = true; drawPanel(true); } return; }
      if (sel) { endCall(); sel = ""; drawList(); drawPanel(true); }
      return;
    }
    if (k === "u" && pend) { e.preventDefault(); undo(); return; }
    if (k === "t" && offer && offer.kind === "sms" && !offer.auto) { e.preventDefault(); sendOffer(); return; }
    if (k === "arrowdown" || k === "arrowup" || k === "j" || k === "k") {
      if (!session && !sel && (k === "arrowdown" || k === "arrowup")) return;   // nothing open: arrows scroll the page
      e.preventDefault();
      const dir = k === "arrowdown" || k === "j" ? 1 : -1;
      if (session) { if (!session.done) sessionMove(dir); } else moveSel(dir);
      return;
    }
    if (k === "c" && sel) {
      const a = root.querySelector(`a[data-call="${CSS.escape(sel)}"]`);
      if (a) { e.preventDefault(); a.click(); }
      return;
    }
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
    // Calling: the phone dials (if it can) and the card turns into "On a call"
    const tl = e.target.closest('a[href^="tel:"]');
    if (tl) {
      const row = tl.closest(".rc-item");
      const id = tl.dataset.call || (row && row.dataset.card) || sel;
      if (id) setTimeout(() => startCall(id), 0);
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
      if (k === "spend") ui.spend = "";
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
    if (tb) { ui.tab = tb.dataset.tab; ui.q = ""; $("q").value = ""; found = null; sel = ""; endCall(); build(); return; }
    const ch = e.target.closest("[data-cat]");
    if (ch) { ui.cat = ch.dataset.cat; sel = ""; endCall(); build(); return; }
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
    const tf = e.target.closest("[data-tlf]");
    if (tf) { tlFilter = tf.dataset.tlf; drawPanel(true); return; }
    const out = e.target.closest("[data-out]");
    if (out) { logOutcome(out.dataset.out); return; }
    const row = e.target.closest("[data-card]");
    if (row) { select(row.dataset.card); return; }

    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (a === "optouts") { showOptouts(false); return; }
    if (a === "session-start") { startSession(); return; }
    if (a === "session-end") { endSession(); return; }
    if (a === "session-pause") { if (session) { session.paused = true; drawPanel(true); } return; }
    if (a === "session-resume") { if (session) { session.paused = false; drawPanel(true); } return; }
    if (a === "session-skip") { sessionMove(1); return; }
    if (a === "session-prev") { sessionMove(-1); return; }
    if (a === "session-more") {
      const sec = sections.find((x) => x.key === "mine");
      if (session && sec && sec.more) { session.waitMore = true; sec.n += PAGE; listen(sec); drawPanel(true); }
      return;
    }
    if (a === "call-end") { endCall(); drawList(); drawPanel(true); return; }
    if (a === "tl-retry") { tl.delete(sel); drawPanel(true); return; }
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
    if (a === "pick-date") {
      const inp = root.querySelector("[data-remind]");
      if (inp) { try { inp.showPicker(); } catch { inp.focus(); inp.click(); } }
      return;
    }
    if (a === "deselect") { endCall(); sel = ""; drawList(); drawPanel(true); return; }
    if (a === "sms") {
      const c = findCard(sel);
      if (!c) return;
      draft.smsKey = "main";
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
      if (r.dnc && !(await confirmDialog({ title: "Don't contact again?", message: "All their recalls stop, and they go on the do-not-contact list for marketing emails.", confirmLabel: "Stop and add to the list", tone: "danger" }))) return;
      const ids = shownIds(), from = sel;
      const all = r.dnc || (draft.all ?? allDefault(r));
      if (await act("close", { reason: r.label, until: draft.until, note: draft.note, all }, { label: r.askDate ? "Pausing" : "Stopping recall", btn: b })) {
        draft = blank();
        drawPanel(true);
        showToast(all ? (r.askDate ? "Paused for all their treatments" : "Recall stopped for all their treatments")
          : (r.askDate ? "Paused" : "Recall stopped"));
        if (sel === from) { if (session) sessionMove(1, from); else if (autoNext) goNext(from, ids); }
      }
      return;
    }
    if (a === "reopen") {
      const rc = findCard(sel);
      if (rc && rc.closeReason === "Replied STOP" && !(await confirmDialog({
        title: "Reopen after they replied STOP?",
        message: "They asked for no more texts, and they stay on the do-not-contact list. " +
          "Only reopen it if they've asked to be called about booking.",
        confirmLabel: "Reopen", tone: "warning",
      }))) return;
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
      endCall();
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
  getDoc(doc(db, "recall_settings", "spend_status"))
    .then((s) => { spendInfo = s.exists() ? s.data() : null; drawList(); drawPanel(true); })
    .catch(() => {});
  drawStats();
  build();
}