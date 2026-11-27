// Prospect Dashboard (#/prospects, #/prospects/list, #/prospects/<id>)
// People who've enquired but aren't patients yet: from web form emails, and added by hand.
// Read from Firestore; every change goes through Apps Script (action "prospects"), so it's logged on the prospect.
import { db, auth } from "./firebase-config.js";
import { collection, getDocs, getDoc, doc, query, orderBy, limit, where, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";
import { openProspectCompose } from "./prospect-compose.js?v=2";
import { fetchPatients, searchPatientsByPhone } from "./patients.js";


const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;

export const STAGES = [
  { key: "new", name: "New enquiry", tone: "sky" },
  { key: "contacted", name: "Contacted", tone: "violet" },
  { key: "consult_booked", name: "Consultation booked", tone: "amber" },
  { key: "consulted", name: "Consulted", tone: "orange" },
  { key: "tx_booked", name: "Treatment booked", tone: "teal" },
  { key: "treated", name: "Treated", tone: "green" },
  { key: "active", name: "Active patient", tone: "emerald" },
  { key: "lost", name: "Lost", tone: "slate" },
];
const OPEN = ["new", "contacted", "consult_booked", "consulted", "tx_booked", "treated"];
const SOURCES = ["Web form", "Phone call", "Email", "Walk-in", "Online chat", "Instagram", "Facebook", "Referral", "Booked directly", "Other"];
const AGES = ["Under 22", "22 to 30", "31 to 40", "41 to 50", "51 to 60", "Over 60"];
const PREFS = ["SMS", "Call", "Email"];
const OUTCOMES = [["spoke", "Spoke to them"], ["no_answer", "No answer"], ["voicemail", "Left voicemail"], ["met", "Met in clinic"]];
const stageOf = (k) => STAGES.find((s) => s.key === k) || STAGES[0];

// Lost reasons. Ones switched off in Settings ("Not counted": spam, tests) are left out of the reports and counts.
const DEFAULT_LOST = ["Too expensive", "Went elsewhere", "No response", "Not suitable", "Just browsing", "Spam", "Test entry", "Other"];
const lostReasonsOf = (set) => (Array.isArray(set.lostReasons) && set.lostReasons.length ? set.lostReasons : DEFAULT_LOST);
const normR = (s) => String(s || "").trim().toLowerCase();
const junkCache = new WeakMap();
function junkReason(reason, set) {
  const r = normR(reason);
  if (!r) return false;
  if (!set || !Array.isArray(set.lostIgnore)) return /\b(spam|tests?|testing)\b/.test(r);   // until Settings is saved
  let s = junkCache.get(set);
  if (!s) { s = new Set(set.lostIgnore.map(normR)); junkCache.set(set, s); }
  return s.has(r);
}
const isJunk = (p, set) => p.stage === "lost" && junkReason(p.lostReason, set);

// "How they got in touch": the standard sources, then any typed in under "Other" before (kept for next time), then Other.
// skip: standard ones not offered here (e.g. Web form when adding by hand)
function sourceList(list, skip = []) {
  const std = new Set(SOURCES.map(normR));
  const extra = new Map();
  (list || []).forEach((p) => {
    const s = String((p && p.source) || "").replace(/\s+/g, " ").trim();
    if (s && !std.has(normR(s)) && !extra.has(normR(s))) extra.set(normR(s), s);
  });
  return [...SOURCES.filter((s) => s !== "Other" && !skip.includes(s)),
    ...[...extra.values()].sort((a, b) => a.localeCompare(b, "en-AU")), "Other"];
}
const sourceField = (list, cur) => `<label class="lh-field"><span class="lh-label">How they got in touch</span>
    <select name="source" class="fe-input" data-role="srcsel">${opts(list, cur)}</select>
    <input name="sourceOther" class="fe-input pr-src-other" maxlength="40" autocomplete="off"
      placeholder="What was it? e.g. Newsletter" aria-label="What the other source was"${cur === "Other" ? "" : " hidden"} /></label>`;
// Shows the "What was it?" box only when Other is chosen
function syncSourceOther(sel) {
  const box = sel.closest("form").querySelector('[name="sourceOther"]');
  if (!box) return;
  box.hidden = sel.value !== "Other";
  if (!box.hidden) box.focus();
}
// The source to save. Typing one that's already a choice uses it as written there ("email" → "Email").
function sourceValue(form, list) {
  const picked = form.elements.source.value;
  if (picked !== "Other") return { source: picked };
  const typed = form.elements.sourceOther.value.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!typed) return { problem: "Say how they got in touch, e.g. Newsletter." };
  return { source: list.find((s) => normR(s) === normR(typed)) || typed };
}
/* ---------- Dates ---------- */
const PERTH = { timeZone: "Australia/Perth" };
const keyOf = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", PERTH) : "");
const todayKey = () => new Date().toLocaleDateString("en-CA", PERTH);
const addDays = (k, n) => { const [y, m, d] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const niceDay = (k) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(k || "")) return ""; const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }); };
const fullDay = (k) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(k || "")) return ""; const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); };
const JOURNEY = [["consult_booked", "First appointment"], ["consulted", "First visit"], ["tx_booked", "First treatment appointment"],
  ["treated", "First treatment"], ["active", "Active patient from"]];
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("en-AU", { ...PERTH, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); };
const ago = (iso) => {
  const ms = Date.now() - Date.parse(iso || "");
  if (!(ms >= 0)) return "";
  const h = Math.floor(ms / 3600000);
  return h < 1 ? "just now" : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

/* ---------- Shared ---------- */
const errText = (err, fb = "Couldn't save. Try again.") =>
  err && err.code === "FORBIDDEN" ? "You don't have access to do that. Ask an Admin for Prospect access."
    : (err && err.message) || fb;
async function api(op, data = {}) {
  const r = await callApi({ action: "prospects", op, ...data });
  if (r && r.problem) throw new Error(r.problem);
  if (r && r.prospect) r.prospect = tidyP(r.prospect);
  return r;
}
// Current prospects; the older enquiries (over 90 days, never worked) only when asked for
async function loadAll(withOld = false) {
  const qs = [getDocs(query(collection(db, "prospects"), where("historic", "==", false), limit(3000)))];
  if (withOld) qs.push(getDocs(query(collection(db, "prospects"), where("historic", "==", true), limit(5000))));
  const snaps = await Promise.all(qs);
  return snaps.flatMap((s) => s.docs.map((d) => tidyP({ id: d.id, ...d.data() })));
}
// Remembered for 5 minutes (Settings → Save reads it again)
let setCache = null, setAt = 0;
async function loadSettings(fresh = false) {
  if (!fresh && setCache && Date.now() - setAt < 300000) return setCache;
  try {
    const s = await getDoc(doc(db, "prospect_settings", "config"));
    setCache = s.exists() ? s.data() : {};
    setAt = Date.now();
    return setCache;
  } catch { return setCache || {}; }
}
// A prospect just added: its page opens without reading it again
const justAdded = new Map();
// The board's list, kept for 10 minutes so going back to the board (or into a prospect) is instant.
// It's refreshed in the background each time, and saves update it straight away.
let boardCache = null;   // { at, list }
const COL_MAX = 50;      // cards drawn per board column before "Show more"

// The board's filters and scroll position, kept while a prospect is open (and for this tab after a refresh)
const BOARD_KEY = "pr_board_v1";
const BOARD_KEYS = ["view", "q", "qRaw", "source", "who", "show", "range", "from", "to", "showLost", "old", "more"];
let boardState = null;
let boardScroll = null;
function readBoardState() {
  if (boardState) return boardState;
  try { boardState = JSON.parse(sessionStorage.getItem(BOARD_KEY) || "null"); } catch { boardState = null; }
  return boardState;
}
function saveBoardState(st) {
  boardState = {};
  BOARD_KEYS.forEach((k) => { boardState[k] = st[k]; });
  try { sessionStorage.setItem(BOARD_KEY, JSON.stringify(boardState)); } catch { /* private browsing: kept for this visit only */ }
}
function boardScrollOf(root) {
  const b = root.querySelector(".pr-board");
  if (!b) return null;
  const cols = {};
  b.querySelectorAll(".pr-col").forEach((c) => { const body = c.querySelector(".pr-col-body"); if (body) cols[c.dataset.stage] = body.scrollTop; });
  return { x: b.scrollLeft, cols };
}
function applyBoardScroll(root, s) {
  const b = s && root.querySelector(".pr-board");
  if (!b) return;
  b.scrollLeft = s.x || 0;
  Object.entries(s.cols || {}).forEach(([k, top]) => {
    const body = b.querySelector(`.pr-col[data-stage="${k}"] .pr-col-body`);
    if (body) body.scrollTop = top;
  });
}
function rememberBoardScroll(root) {
  const ct = document.getElementById("content");
  boardScroll = { ...(boardScrollOf(root) || {}), y: window.scrollY, ct: ct ? ct.scrollTop : 0, at: Date.now() };
}
function cacheUpsert(p) {
  if (!boardCache || !p || !p.id) return;
  const i = boardCache.list.findIndex((x) => x.id === p.id);
  if (i >= 0) boardCache.list[i] = p;
  else if (!p.historic) boardCache.list.unshift(p);
}

// Patient search for "Patient record": straight from Firestore (Apps Script only if that isn't allowed)
const ptCache = new Map();
async function findPatients(q) {
  const k = q.toLowerCase();
  if (ptCache.has(k)) return ptCache.get(k);
  let list;
  try {
    const found = q.replace(/\D/g, "").length >= 6 ? await searchPatientsByPhone(q) : (await fetchPatients({ mode: "name", term: q })).patients;
    list = found.filter((x) => !x.mergedInto).slice(0, 6)
      .map((x) => ({ id: x.pttId || x.id, name: x.name, mobile: x.mobile, dob: x.dobKey }));
  } catch (err) {
    if (!err || err.code !== "permission-denied") throw err;
    list = ((await callApi({ action: "prospects", op: "ptSearch", q })).results || []).slice(0, 6);
  }
  ptCache.set(k, list);
  return list;
}
// The staff list (for "Give to" and Settings). Remembered for this tab, so dialogs open instantly.
// A failed load isn't kept, so the next try asks again.
let staffCache = null;
function staffList() {
  if (!staffCache) {
    let hit = null;
    try { hit = JSON.parse(sessionStorage.getItem("pr_staff_v1") || "null"); } catch { /* ignore */ }
    staffCache = hit && Date.now() - hit.at < 30 * 60000 && Array.isArray(hit.list)
      ? Promise.resolve(hit.list)
      : callApi({ action: "staffList" }).then((r) => {
          const list = r.staff || [];
          try { sessionStorage.setItem("pr_staff_v1", JSON.stringify({ at: Date.now(), list })); } catch { /* full */ }
          return list;
        });
    staffCache.catch(() => { staffCache = null; });
  }
  return staffCache.catch(() => []);
}
const hoursOf = (set) => Math.max(1, Number(set.respondHours) || 24);
const notContacted = (p, set) => !!p.waitingSince && OPEN.includes(p.stage) && Date.now() - Date.parse(p.waitingSince) > hoursOf(set) * 3600000;
// "14:30" in Perth now, and "14:30" → "2:30 pm"
const nowHm = () => new Date().toLocaleTimeString("en-GB", { ...PERTH, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const hmText = (hm) => { const m = /^(\d{2}):(\d{2})$/.exec(hm || ""); if (!m) return ""; const h = +m[1]; return `${h % 12 || 12}:${m[2]} ${h < 12 ? "am" : "pm"}`; };
const fuText = (p) => [niceDay(p.nextFollowUp), hmText(p.nextFollowUpTime)].filter(Boolean).join(", ");
// Today with a time that has passed counts as overdue
function followState(p) {
  if (!p.nextFollowUp || !OPEN.includes(p.stage)) return "";
  const t = todayKey();
  if (p.nextFollowUp < t) return "overdue";
  if (p.nextFollowUp > t) return "later";
  return p.nextFollowUpTime && p.nextFollowUpTime <= nowHm() ? "overdue" : "today";
}
// "" if fine, otherwise what's wrong
const fuProblem = (d, tm) => (!d ? (tm ? "Choose a date for the follow-up time." : "")
  : d < todayKey() ? "Choose a follow-up date from today onwards."
  : d === todayKey() && tm && tm <= nowHm() ? "That time has already passed today. Choose a later time." : "");
// A follow-up date to start a form with: overdue ones are left blank (only today onwards can be saved)
const fuStart = (d, fallback = "") => (d && d >= todayKey() ? d : fallback);
// Booked, then cancelled or didn't come, and nothing booked since
const cancelOpen = (p) => p.cancelOpen === true && OPEN.includes(p.stage);
const cancelWord = (p) => (p.lastCancel && p.lastCancel.kind === "noshow" ? "Didn't come" : "Cancelled");
const isPast = (p) => p.wasPatient === true || !!p.prev;
// The ad that brought them (the website's Ad tracking field)
const adText = (a) => (a ? ["Came from a Google ad", a.keyword ? `searched “${a.keyword}”` : "",
  a.landing ? `landed on ${a.landing}` : "", a.clicked ? `clicked ${fullDay(a.clicked)}` : ""].filter(Boolean).join(" · ") : "");
const onRecall = (p) => !!(p.recall && p.recall.id);
// The website's tracking (via=…; vland=…) and the form's name (*General Appt Request Form*) sometimes end up in
// "Interested in". They're left out when prospects are read, so the board, reports and templates only see the interest.
const TRACK_RE = /\b(?:via|vland|vseen|fvia|fland|fseen|vform|gclid|kw)=/i;
const dirtyConcern = (s) => !!s && (TRACK_RE.test(s) || /\*[^*]+\*/.test(s));
function cleanConcern(s) {
  let c = String(s || "");
  const m = TRACK_RE.exec(c);
  if (m) c = c.slice(0, m.index);
  return c.replace(/\*[^*]*\*/g, "").replace(/\s*,\s*,/g, ",").replace(/[\s,;:]+$/, "").replace(/^[\s,;:]+/, "").trim();
}
function tidyP(p) {
  if (!p) return p;
  const enq = Array.isArray(p.enquiries) && p.enquiries.some((q) => q && dirtyConcern(q.concern));
  if (!dirtyConcern(p.concern) && !enq) return p;
  return { ...p, concern: dirtyConcern(p.concern) ? cleanConcern(p.concern) : p.concern,
    enquiries: enq ? p.enquiries.map((q) => (q && dirtyConcern(q.concern) ? { ...q, concern: cleanConcern(q.concern) } : q)) : p.enquiries };
}

// No next step: open, nothing booked, no follow-up, and nothing has happened for a week. This is where enquiries go cold.
// "Not contacted" and "Cancelled, not rebooked" are flagged on their own. Treated is left to Recall.
const STUCK_DAYS = 7;
const lastActive = (p) => {
  const log = p.log || [];
  return Math.max(0, ...[p.lastContactAt, p.stageAt, p.lastEnquiryAt, p.createdAt, log.length ? log[log.length - 1].at : ""]
    .map((x) => Date.parse(x || "") || 0));
};
const idleDays = (p) => Math.floor((Date.now() - lastActive(p)) / 864e5);
const noNextStep = (p, set) => OPEN.includes(p.stage) && p.stage !== "treated" && !p.nextFollowUp
  && !(p.nextAppt && p.nextAppt >= todayKey()) && !notContacted(p, set) && !cancelOpen(p) && idleDays(p) >= STUCK_DAYS;
// How they found the website (the website's Visit tracking field → Code.gs prosViaParse_)
const VIA_NAME = { g: "Google search", google: "Google search", s: "Other search", search: "Other search", bing: "Other search",
  a: "Google Ads", ad: "Google Ads", ads: "Google Ads", i: "AI assistant", ai: "AI assistant", chatgpt: "AI assistant",
  o: "Social media", social: "Social media", facebook: "Social media", e: "Email", email: "Email",
  r: "Another website", referral: "Another website", d: "Typed the address", direct: "Typed the address" };
const viaKindOf = (src) => {   // "google/organic" → "google", when only the raw source was saved
  const s = String(src || "").toLowerCase();
  return /google/.test(s) && /organic/.test(s) ? "google" : /organic/.test(s) ? "search" : s.split("/").pop() || s;
};
function viaNorm(v) {
  if (!v || typeof v !== "object") return null;
  const kind = String(v.kind || v.via || viaKindOf(v.src) || "").toLowerCase();
  const land = String(v.land || v.landing || v.page || "");
  if (!kind && !land) return null;
  const name = v.name || VIA_NAME[kind] || (kind ? kind[0].toUpperCase() + kind.slice(1) : "The website");
  // The first visit: Code.gs saves firstKind / firstLand / firstSeen (older shapes: first, or fvia / fland / fseen)
  const fk = v.firstKind || v.fvia || viaKindOf(v.firstSrc);
  const fl = v.firstLand || v.fland;
  const first = v.first ? viaNorm(v.first) : (fk || fl) ? viaNorm({ kind: fk, land: fl, seen: v.firstSeen || v.fseen }) : null;
  const form = String(v.form || "");
  return { kind, name, land, seen: v.seen || v.t || "", first, form };
}
// The prospect's own "via", otherwise the latest enquiry that has one
const viaOfP = (p) => viaNorm(p.via) || viaNorm(((p.enquiries || []).slice().reverse().find((q) => q && q.via) || {}).via);
const isAdVia = (v) => !!v && ["a", "ad", "ads"].includes(v.kind);
const isGoogleVia = (v) => !!v && ["g", "google"].includes(v.kind);
const seenText = (s) => { const d = new Date(typeof s === "number" || /^\d+$/.test(String(s)) ? Number(s) : s); return isNaN(d) ? "" : fullDay(keyOf(d.toISOString())); };
const viaText = (v) => (v ? [`Found us: ${v.name}${v.land ? ` → ${v.land}` : ""}`, seenText(v.seen) && `visited ${seenText(v.seen)}`,
  v.first && (v.first.name !== v.name || v.first.land !== v.land) && `first visit: ${v.first.name}${v.first.land ? ` → ${v.first.land}` : ""}`,
  v.form && v.form !== v.land && `sent the form on ${v.form}`]
  .filter(Boolean).join(" · ") : "");
// Show the "Found us" tag unless it would only repeat the Google Ads tag
const showVia = (p, v) => !!v && !(isAdVia(v) && p.ads);

(function viaCss() {
  if (typeof document === "undefined" || document.getElementById("pr-via-css")) return;
  const s = document.createElement("style");
  s.id = "pr-via-css";
  s.textContent = `.pr-tag.is-via{background:#dcfce7;color:#166534;border-color:#bbf7d0}
    .pr-chip.is-via{background:#f0fdf4;color:#166534;border-color:#bbf7d0}
    .pr-enq-via{display:block;color:#166534;margin-top:2px}
    .pr-src-other{margin-top:6px}.pr-src-other[hidden]{display:none}`;
  document.head.appendChild(s);
})();
(function boardCss() {
  if (typeof document === "undefined" || document.getElementById("pr-board2-css")) return;
  const s = document.createElement("style");
  s.id = "pr-board2-css";
  s.textContent = `.pr-tiles{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
    .pr-card .pr-tags{display:flex;flex-direction:row;flex-wrap:wrap;gap:4px;align-items:flex-start}
    .pr-card .pr-tag{display:inline-flex;width:auto;flex:0 0 auto;max-width:100%;font-size:11.5px;line-height:1.4;padding:1px 7px;margin:0}
    .pr-card .pr-tag.is-src{background:#f1f5f9;color:#475569}
    .pr-card-concern{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .pr-card.is-cancel{border-left:3px solid #ef4444}
    .pr-card.is-stuck{border-left:3px solid #f59e0b}
    .pr-banner.is-warn{background:#fffbeb;border-color:#fde68a;color:#92400e}
    .pr-plan{margin:6px 0 8px;padding-left:18px}.pr-plan li{margin:0 0 6px}
    .pr-plan-q{display:block;color:#0f766e;font-weight:600}`;
  document.head.appendChild(s);
})();

const monthYear = (k) => { if (!/^\d{4}-\d{2}/.test(k || "")) return ""; const [y, m] = k.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "numeric" }); };
const prevText = (pv) => (pv ? `${pv.count} visit${pv.count === 1 ? "" : "s"} before they enquired, last on ${fullDay(pv.last)}${
  pv.svcs && pv.svcs.length ? ` (${pv.svcs.join(", ")})` : ""}${pv.staff ? ` with ${pv.staff}` : ""}` : "");
// The "Show" chips on the board, and the "Who" filter on the reports
const SHOW = [
  ["", "All", () => true],
  ["action", "Needs action", (p, set) => notContacted(p, set) || cancelOpen(p) || ["today", "overdue"].includes(followState(p)) || noNextStep(p, set)],
  ["new", "New to the clinic", (p) => !isPast(p)],
  ["past", "Past patients", isPast],
  ["recall", "Also on recall", onRecall],
  ["cancel", "Cancelled, not rebooked", (p) => cancelOpen(p)],
  ["nocontact", "Not contacted", (p, set) => notContacted(p, set)],
  ["follow", "Follow-ups due", (p) => ["today", "overdue"].includes(followState(p))],
  ["stuck", "No next step", (p, set) => noNextStep(p, set)],
  ["consulted_no_tx", "Consulted, no treatment", (p) => p.stage === "consulted" && !(p.nextAppt && p.nextAppt >= todayKey())],
  ["booked", "Booked directly", (p) => p.fromBook === true],
  ["ads", "From Google Ads", (p) => !!p.ads],
  ["seo", "From Google search", (p) => isGoogleVia(viaOfP(p))],
  ["check", "Check match", (p) => !!p.patientId && p.linkWeak === true],
];
const showOf = (k) => (SHOW.find((x) => x[0] === k) || SHOW[0])[2];
const RANGES = [["", "Enquired: any time"], ["7", "Enquired: last 7 days"], ["30", "Enquired: last 30 days"],
  ["90", "Enquired: last 3 months"], ["365", "Enquired: last 12 months"], ["custom", "Enquired: choose dates"]];
const I = (p) => `<svg class="pr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  text: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  pause: '<circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
};
const KIND_IC = { enquiry: "inbox", contact: "phone", text: "text", email: "mail", note: "note", stage: "flag",
  follow: "clock", assign: "user", link: "link", edit: "note", cancel: "alert" };

/* ---------- A small dialog ---------- */
function openDialog({ title, sub = "", body, submit = "Save", onOpen, onSubmit }) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog pr-dlg";
  dlg.innerHTML = `<form class="lh-form" novalidate>
    <div class="lh-dialog-head"><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ""}</div>
    <div class="pr-dlg-body">${body}</div>
    <p class="lh-error" role="alert" hidden></p>
    <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
      <button type="submit" class="lh-btn is-primary">${esc(submit)}</button></div></form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  const btn = form.querySelector('[type="submit"]');
  const ctl = {
    form, dlg, btn,
    fail(m) { err.textContent = m; err.hidden = !m; btn.disabled = false; },
    close() { dlg.close(); },
  };
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => {   // follow-up quick picks
    const q = e.target.closest("[data-days]");
    if (!q) return;
    const input = form.querySelector('[name="followUp"]');
    if (input) input.value = q.dataset.days === "" ? "" : addDays(todayKey(), Number(q.dataset.days));
    const tm = form.querySelector('[name="followTime"]');
    if (tm && q.dataset.days === "") tm.value = "";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    const label = btn.textContent;
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try { await onSubmit(ctl); } catch (ex) { console.error(ex); ctl.fail(errText(ex)); }
    finally {
      if (dlg.open && btn.textContent === "Saving…") { btn.textContent = label; btn.disabled = false; }
    }
  });
  dlg.showModal();
  if (onOpen) onOpen(ctl);
  return ctl;
}
const followHtml = (val = "", note = "", time = "") => `
  <div class="pr-fu">
    <span class="lh-label">Follow up on <small class="muted">(time optional)</small></span>
    <div class="pr-fu-row"><input type="date" name="followUp" value="${esc(val)}" min="${todayKey()}" class="fe-input" />
      <input type="time" name="followTime" value="${esc(val ? time : "")}" step="300" class="fe-input pr-fu-time" aria-label="Time (optional)" />
      <span class="pr-quick">${[["Tomorrow", 1], ["3 days", 3], ["1 week", 7], ["2 weeks", 14], ["None", ""]].map(([l, d]) =>
        `<button type="button" class="pr-chip-btn" data-days="${d}">${l}</button>`).join("")}</span></div>
    <input name="followNote" class="fe-input" maxlength="300" placeholder="What to follow up about (optional)" value="${esc(note)}" />
  </div>`;
const opts = (list, cur, blank = "") => (blank ? `<option value="">${esc(blank)}</option>` : "") +
  list.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`).join("");


/* ===================== Follow-ups: the list, and Done / Change / Remove ===================== */

const FU_GROUPS = [["overdue", "Overdue"], ["today", "Today"], ["soon", "Next 7 days"], ["later", "Later"]];
function fuGroup(p) {
  const fs = followState(p);
  if (fs === "overdue" || fs === "today") return fs;
  return p.nextFollowUp <= addDays(todayKey(), 7) ? "soon" : "later";
}
const fuSort = (a, b) => `${a.nextFollowUp} ${a.nextFollowUpTime || "99"}`.localeCompare(`${b.nextFollowUp} ${b.nextFollowUpTime || "99"}`);
const telOf = (s) => String(s || "").replace(/[^\d+]/g, "");

function followListHtml(list, { showWho = false, work = true } = {}) {
  const items = list.filter((p) => p.nextFollowUp && OPEN.includes(p.stage)).sort(fuSort);
  if (!items.length) return '<p class="pr-empty">No follow-ups set. 👍</p>';
  return FU_GROUPS.map(([g, label]) => {
    const rows = items.filter((p) => fuGroup(p) === g);
    if (!rows.length) return "";
    return `<section class="pr-fu-grp is-${g}"><h4>${esc(label)} <em>${rows.length}</em></h4>${rows.map((p) => `
      <div class="pr-fu-item" data-id="${esc(p.id)}">
        <div class="pr-fu-main">
          <a href="#/prospects/${enc(p.id)}"><strong>${esc(p.name || "No name")}</strong></a>
          <small><b>${esc(fuText(p))}</b>${p.concern ? ` · ${esc(p.concern)}` : ""}${showWho ? ` · ${esc(p.assignedToName || "Nobody yet")}` : ""}</small>
          ${p.followNote ? `<small class="pr-fu-note">“${esc(p.followNote)}”</small>` : ""}
        </div>
        <div class="pr-fu-acts">
          ${p.phone ? `<a class="lh-btn is-quiet" href="tel:${esc(telOf(p.phone))}" title="Call ${esc(p.phone)}">${I(IC.phone)}</a>` : ""}
          ${work ? `<button type="button" class="lh-btn is-primary" data-fu="done">${I(IC.check)} Done</button>
            <button type="button" class="lh-btn" data-fu="change">Change</button>
            <button type="button" class="lh-btn is-quiet" data-fu="remove">Remove</button>` : ""}
        </div>
      </div>`).join("")}</section>`;
  }).join("");
}

// submit(data) saves it: data = { outcome, note, followUp, followTime, followNote }
function followDoneDialog(p, submit) {
  openDialog({
    title: `Follow-up done: ${p.name}`, sub: [fuText(p), p.followNote].filter(Boolean).join(" · "), submit: "Mark as done",
    body: `<span class="lh-label">What happened? <small class="muted">(optional)</small></span>
      <div class="pr-reasons">${[["", "Just mark it done"], ...OUTCOMES].map(([k, l], i) =>
        `<label class="pr-reason"><input type="radio" name="outcome" value="${k}"${i ? "" : " checked"} /><span>${esc(l)}</span></label>`).join("")}</div>
      <label class="lh-field"><span class="lh-label">Note <small class="muted">(optional)</small></span>
        <textarea name="note" rows="2" maxlength="1000" class="fe-input" placeholder="What was said, what happens next"></textarea></label>
      ${followHtml("", "", "")}
      <small class="muted">Set a date above to book the next follow-up straight away, or leave it empty.</small>`,
    onSubmit: async (c) => {
      const f = c.form.elements;
      const fp = fuProblem(f.followUp.value, f.followTime.value);
      if (fp) { c.fail(fp); return; }
      await submit({ outcome: (c.form.querySelector('[name="outcome"]:checked') || {}).value || "", note: f.note.value,
        followUp: f.followUp.value, followTime: f.followTime.value, followNote: f.followNote.value });
      c.close();
    },
  });
}
function followChangeDialog(p, submit) {
  openDialog({
    title: `Change the follow-up: ${p.name}`, sub: p.nextFollowUp ? `Now ${fuText(p)}` : "", submit: "Save",
    body: followHtml(fuStart(p.nextFollowUp), p.followNote || "", fuStart(p.nextFollowUp) ? p.nextFollowUpTime || "" : ""),
    onSubmit: async (c) => {
      const f = c.form.elements;
      if (!f.followUp.value) { c.fail("Choose a date, or use Remove to cancel the follow-up."); return; }
      const fp = fuProblem(f.followUp.value, f.followTime.value);
      if (fp) { c.fail(fp); return; }
      await submit({ followUp: f.followUp.value, followTime: f.followTime.value, followNote: f.followNote.value });
      c.close();
    },
  });
}
function followRemoveDialog(p, submit) {
  openDialog({
    title: `Remove the follow-up for ${p.name}?`, sub: fuText(p), submit: "Remove follow-up",
    body: '<p class="muted">It comes off the list and won\'t remind anyone. It\'s noted on their Timeline.</p>',
    onSubmit: async (c) => { await submit({ followUp: "", followTime: "", followNote: "" }); c.close(); },
  });
}
// From a list (the board's Follow-ups view, My dashboard): saves, then onSaved(prospect)
function followAction(kind, p, onSaved) {
  const go = (op, msg) => async (data) => {
    const r = await api(op, { id: p.id, ...data });
    showToast(msg);
    if (onSaved) onSaved(r && r.prospect);
  };
  if (kind === "done") followDoneDialog(p, go("followDone", "Follow-up done"));
  if (kind === "change") followChangeDialog(p, go("followUp", "Follow-up changed"));
  if (kind === "remove") followRemoveDialog(p, go("followUp", "Follow-up removed"));
}

// My dashboard → My follow-ups: my prospects' follow-ups, kept up to date. el: an empty element on the page.
// bare: no header (the dashboard draws its own) · onCount(due, total): for a badge · alive(): false once the page has gone
export function mountMyFollowUps(el, { bare = false, onCount = null, alive = null } = {}) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!el) return () => {};
  if (!uid || !can("menu.prospects")) { el.hidden = true; return () => {}; }
  const work = can("prospects.work") || can("prospects.manage");
  const isAlive = alive || (() => el.isConnected);
  let list = [];
  let loaded = false;
  if (!bare) el.classList.add("pr-myfu");
  el.innerHTML = '<div class="mv-loading"><span class="mv-spin" aria-hidden="true"></span>Loading…</div>';
  const draw = () => {
    if (!loaded) return;
    const open = list.filter((p) => p.nextFollowUp && OPEN.includes(p.stage));
    const due = open.filter((p) => ["overdue", "today"].includes(followState(p))).length;
    if (onCount) onCount(due, open.length);
    el.innerHTML = (bare ? "" : `<div class="pr-myfu-head"><h3>${I(IC.clock)} My follow-ups${due ? ` <em>${due} due</em>` : ""}</h3>
      <a href="#/prospects/followups">All follow-ups →</a></div>`) + followListHtml(list, { work });
  };
  const stop = onSnapshot(query(collection(db, "prospects"), where("assignedToId", "==", uid), where("historic", "==", false)),
    (snap) => { list = snap.docs.map((d) => tidyP({ id: d.id, ...d.data() })); loaded = true; draw(); },
    (err) => { console.warn("My follow-ups:", err); el.innerHTML = '<p class="tb-none">Couldn\'t load your follow-ups.</p>'; });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fu]");
    const row = e.target.closest("[data-id]");
    const p = b && row && list.find((x) => x.id === row.dataset.id);
    if (p) followAction(b.dataset.fu, p);   // the list updates by itself
  });
  const tick = setInterval(() => {          // "Today" turns into "Overdue" as times pass; stops when the page has gone
    if (!isAlive()) { stop(); clearInterval(tick); return; }
    draw();
  }, 60000);
  return () => { stop(); clearInterval(tick); };
}

/* ===================== Routes ===================== */

export function mountProspects(container, { param = "", staff = null } = {}) {
  const parts = String(param || "").split("/").filter(Boolean);
  if (parts[0] === "reports") { mountReports(container, parts[1] || ""); return; }
  if (parts[0] && !["list", "followups"].includes(parts[0])) { mountProspect(container, decodeURIComponent(parts[0]), staff); return; }
  mountBoard(container, { view: ["list", "followups"].includes(parts[0]) ? parts[0] : "board", staff });
}
/* ===================== The board and the list ===================== */

async function mountBoard(container, { view, staff }) {
  const root = document.createElement("section");
  root.className = "page wide pr-page";
  container.replaceChildren(root);
  const me = auth.currentUser && auth.currentUser.uid;
  const work = can("prospects.work") || can("prospects.manage");
  const st = { view, q: "", qRaw: "", source: "", who: "all", show: "", range: "", from: "", to: "", showLost: false, old: false, more: {} };
  const saved = readBoardState();
  if (saved) {
    BOARD_KEYS.forEach((k) => { if (k in saved && saved[k] != null) st[k] = saved[k]; });
    st.view = view;
    // Back to the plain Prospects address: the view you were using (List or Follow-ups)
    if (view === "board" && ["list", "followups"].includes(saved.view)) {
      st.view = saved.view;
      history.replaceState(null, "", `#/prospects/${st.view}`);
    }
    if (!st.more || typeof st.more !== "object") st.more = {};
  }
  let all = [];
  let set = {};
  const cached = !st.old && boardCache && Date.now() - boardCache.at < 10 * 60000 ? boardCache : null;
  if (cached) {
    all = cached.list;
    set = await loadSettings();
  } else {
    root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
    try { [all, set] = await Promise.all([loadAll(st.old), loadSettings()]); }
    catch (err) {
      console.error("Prospects failed:", err);
      root.innerHTML = `<div class="state"><strong>Couldn't load prospects</strong>${esc(err && err.code === "permission-denied"
        ? "Check the prospects Firestore rule has been published, and your Prospect access in Staff." : "Check your connection and try again.")}</div>`;
      return;
    }
    boardCache = { at: Date.now(), list: st.old ? all.filter((p) => !p.historic) : all };
  }
  if (!root.isConnected) return;
  staffList();   // ready for New prospect and Settings

  const t = todayKey();
  const month = t.slice(0, 7);
  const tilesOf = () => [
    { ic: "alert", n: all.filter((p) => notContacted(p, set)).length, l: `Not contacted in ${hoursOf(set)} hours`, tone: "bad", show: "nocontact" },
    { ic: "flag", n: all.filter(cancelOpen).length, l: "Cancelled, not rebooked", tone: "bad", show: "cancel" },
    { ic: "inbox", n: all.filter((p) => !isJunk(p, set) && Date.now() - Date.parse(p.createdAt || "") < 7 * 864e5).length, l: "New enquiries this week", tone: "sky", range: "7" },
    { ic: "clock", n: all.filter((p) => ["today", "overdue"].includes(followState(p))).length, l: "Follow-ups due", tone: "amber", show: "follow" },
    { ic: "pause", n: all.filter((p) => noNextStep(p, set)).length, l: "No next step for a week", tone: "amber", show: "stuck" },
    // The date of their first treatment (from the appointment book), or when staff moved them there by hand
    { ic: "trophy", n: all.filter((p) => {
      const d = (p.milestones || {}).treated || (["treated", "active"].includes(p.stage) ? keyOf(p.stageAt) : "");
      return d.slice(0, 7) === month;
    }).length, l: "Became patients this month", tone: "green" },
  ];
  const tileHtml = (x) => {
    const attr = x.show ? ` data-show="${x.show}"` : x.range ? ` data-range="${x.range}"` : "";
    const tag = attr ? "button" : "div";
    return `<${tag}${attr ? ` type="button"${attr} title="Show these"` : ""} class="pr-tile is-${x.tone}">${I(IC[x.ic])}<div><strong>${x.n}</strong><span>${esc(x.l)}</span></div></${tag}>`;
  };
  const srcList = [...new Set(all.map((p) => p.source).filter(Boolean))].sort();

  root.innerHTML = `
    <div class="pr-top">
      <div><h2>Prospect Dashboard</h2><p class="muted">Everyone who's enquired, from first contact to becoming a patient.</p></div>
      <div class="pr-top-acts">
        <button type="button" class="lh-btn is-quiet pr-refresh" data-act="refresh" title="Check for new enquiries and reload the board">
          ${I(IC.refresh)} <span class="pr-refresh-tx">Refresh</span></button>
        <a class="lh-btn is-quiet" href="#/prospects/reports">${I(IC.chart)} Reports</a>
        ${can("prospects.manage") ? `<button type="button" class="lh-btn is-quiet" data-act="settings">${I(IC.gear)} Settings</button>` : ""}
        ${work ? `<button type="button" class="lh-btn is-primary" data-act="new">${I(IC.plus)} New prospect</button>` : ""}
      </div>
    </div>
    <div class="pr-tiles" data-role="tiles"></div>
    <div class="pr-tools">
      <div class="fe-seg">${[["board", "Board"], ["list", "List"], ["followups", "Follow-ups"]].map(([v, l]) =>
        `<label class="fe-seg-btn"><input type="radio" name="pr-view" value="${v}"${st.view === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
      <input type="search" class="fe-input pr-q" data-role="q" placeholder="Search name, mobile, email or interest" />
      <select class="fe-input" data-role="range" aria-label="Enquired">${RANGES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>
      <span class="pr-dates" data-role="dates" hidden>
        <input type="date" class="fe-input" data-role="from" max="${t}" aria-label="From" /><span>to</span>
        <input type="date" class="fe-input" data-role="to" max="${t}" aria-label="To" /></span>
      <select class="fe-input" data-role="source"><option value="">All sources</option>${opts(srcList, "")}</select>
      <select class="fe-input" data-role="who"><option value="all">Everyone's</option><option value="me">Mine</option><option value="none">Not given to anyone</option></select>
      <button type="button" class="lh-btn is-quiet" data-act="old">${st.old ? "Hide" : "Show"} older enquiries</button>
      <button type="button" class="lh-btn is-quiet" data-act="clear" hidden>Clear filters</button>
    </div>
    <div class="pr-show" data-role="show" role="group" aria-label="Show"></div>
    <div data-role="body"></div>`;

  // Enquired between: their first enquiry, or any enquiry since
  const rangeOf = () => (st.range === "custom" ? [st.from || "0000-01-01", st.to || t]
    : st.range ? [addDays(t, -(Number(st.range) - 1)), t] : ["", ""]);
  const inRange = (p) => {
    const [a, b] = rangeOf();
    if (!a) return true;
    return [keyOf(p.createdAt)].concat((p.enquiries || []).map((q) => keyOf(q.at))).some((d) => d && d >= a && d <= b);
  };
  const base = (p) => {
    if (st.source && p.source !== st.source) return false;
    if (st.who === "me" && p.assignedToId !== me) return false;
    if (st.who === "none" && p.assignedToId) return false;
    if (!inRange(p)) return false;
    if (!st.q) return true;
    const digits = st.q.replace(/\D/g, "");
    return `${p.name} ${p.email} ${p.concern} ${p.patientName || ""}`.toLowerCase().includes(st.q) ||
      (digits.length >= 3 && String(p.phoneKey || "").includes(digits));
  };
  const urgency = (p) => (notContacted(p, set) ? 0 : cancelOpen(p) ? 1 : followState(p) === "overdue" ? 2
    : followState(p) === "today" ? 3 : noNextStep(p, set) ? 4 : 5);
  const byUrgency = (a, b) => urgency(a) - urgency(b) ||
    `${a.nextFollowUp || "9"} ${a.nextFollowUpTime || "99"}`.localeCompare(`${b.nextFollowUp || "9"} ${b.nextFollowUpTime || "99"}`) ||
    String(b.lastEnquiryAt || "").localeCompare(String(a.lastEnquiryAt || ""));

  const typeTags = (p) => `${p.patientId ? (isPast(p)
      ? `<span class="pr-tag is-old" title="${esc(prevText(p.prev) || "Had a visit before they enquired")}">Past patient${p.prev && p.prev.last ? ` · last ${esc(monthYear(p.prev.last))}` : ""}</span>`
      : '<span class="pr-tag is-pt">Patient</span>') : ""}
    ${onRecall(p) ? `<span class="pr-tag is-recall" title="${esc(`${p.recall.category}, due ${fullDay(p.recall.due)}`)}">On recall</span>` : ""}
    ${p.ads ? `<span class="pr-tag is-ad" title="${esc(adText(p.ads))}">Google Ads</span>` : ""}
    ${(() => { const v = viaOfP(p); return showVia(p, v) ? `<span class="pr-tag is-via" title="${esc(viaText(v))}">${esc(v.name)}</span>` : ""; })()}`;

  // A card: what needs doing first, then the booking, then where they came from. Tags sit side by side where they fit.
  const card = (p) => {
    const fs = followState(p);
    const late = notContacted(p, set);
    const stuck = noNextStep(p, set);
    const v = viaOfP(p);
    const from = [p.source || "Other", showVia(p, v) && normR(v.name) !== normR(p.source) ? v.name : ""].filter(Boolean).join(" · ");
    const tags = [
      late && '<span class="pr-tag is-bad">Not contacted</span>',
      cancelOpen(p) && `<span class="pr-tag is-bad">${cancelWord(p)}, not rebooked</span>`,
      fs === "overdue" && `<span class="pr-tag is-bad">Follow-up overdue${p.nextFollowUp === todayKey() && p.nextFollowUpTime
        ? ` · ${esc(hmText(p.nextFollowUpTime))}` : ""}</span>`,
      fs === "today" && `<span class="pr-tag is-warn">Follow up ${p.nextFollowUpTime ? esc(hmText(p.nextFollowUpTime)) : "today"}</span>`,
      stuck && `<span class="pr-tag is-warn">No next step · ${idleDays(p)} days</span>`,
      p.patientId && p.linkWeak && '<span class="pr-tag is-warn">Check match</span>',
      p.nextAppt && OPEN.includes(p.stage) && p.nextAppt >= todayKey() && `<span class="pr-tag is-pt">Booked ${esc(niceDay(p.nextAppt))}</span>`,
      fs === "later" && `<span class="pr-tag">${esc(fuText(p))}</span>`,
      p.stage === "lost" && p.lostReason && `<span class="pr-tag">${esc(p.lostReason)}${isJunk(p, set) ? " · not counted" : ""}</span>`,
      `<span class="pr-tag is-src"${showVia(p, v) ? ` title="${esc(viaText(v))}"` : ""}>${esc(from)}</span>`,
      p.patientId && isPast(p) && `<span class="pr-tag is-old" title="${esc(prevText(p.prev) || "Had a visit before they enquired")}">Past patient${
        p.prev && p.prev.last ? ` · last ${esc(monthYear(p.prev.last))}` : ""}</span>`,
      p.patientId && !isPast(p) && ["new", "contacted"].includes(p.stage || "new") && '<span class="pr-tag is-pt">Patient</span>',
      onRecall(p) && `<span class="pr-tag is-recall" title="${esc(`${p.recall.category}, due ${fullDay(p.recall.due)}`)}">On recall</span>`,
      p.ads && `<span class="pr-tag is-ad" title="${esc(adText(p.ads))}">Google Ads</span>`,
    ].filter(Boolean).join("");
    const contacts = p.contacts ? `${p.contacts} contact${p.contacts === 1 ? "" : "s"}` : p.fromBook ? "Booked themselves" : "Not contacted";
    return `<a class="pr-card${late ? " is-late" : ""}${cancelOpen(p) ? " is-cancel" : stuck ? " is-stuck" : ""}" href="#/prospects/${enc(p.id)}" data-id="${esc(p.id)}" draggable="${work}">
      <span class="pr-card-top"><strong>${esc(p.name || "No name")}</strong>${p.assignedToName
        ? `<i class="pr-av" title="${esc(p.assignedToName)}">${esc(initials(p.assignedToName))}</i>` : ""}</span>
      ${p.concern ? `<small class="pr-card-concern" title="${esc(p.concern)}">${esc(p.concern)}</small>` : ""}
      <span class="pr-tags">${tags}</span>
      <span class="pr-card-foot"><small>${esc(ago(p.lastEnquiryAt || p.createdAt))} · ${contacts}</small></span>
    </a>`;
  };

  function drawBody() {
    saveBoardState(st);
    const clr = root.querySelector('[data-act="clear"]');
    if (clr) clr.hidden = !(st.q || st.source || st.who !== "all" || st.show || st.range);
    const prevScroll = boardScrollOf(root);   // a background refresh redraws the board: keep its scroll
    root.querySelector('[data-role="tiles"]').innerHTML = tilesOf().map(tileHtml).join("");
    const pool = all.filter(base);
    root.querySelector('[data-role="show"]').innerHTML = SHOW.map(([k, l, f]) => {
      const n = k ? pool.filter((p) => f(p, set)).length : pool.length;
      const on = st.show === k;
      return `<button type="button" class="pr-show-chip${on ? " is-on" : ""}${!n && !on && k ? " is-zero" : ""}" data-show="${k}" aria-pressed="${on}">${esc(l)} <em>${n}</em></button>`;
    }).join("");
    root.querySelectorAll(".pr-tile[data-show]").forEach((x) => x.classList.toggle("is-on", x.dataset.show === st.show));
    root.querySelectorAll(".pr-tile[data-range]").forEach((x) => x.classList.toggle("is-on", x.dataset.range === st.range));
    const pred = showOf(st.show);
    const list = pool.filter((p) => pred(p, set));
    const box = root.querySelector('[data-role="body"]');
    if (st.view === "followups") {
      box.innerHTML = followListHtml(list, { showWho: true, work });
      return;
    }
    if (st.view === "list") {
      const rows = list.slice().sort(byUrgency);
      box.innerHTML = rows.length ? `<div class="pr-table-wrap"><table class="pr-table"><thead><tr>
<th>Name</th><th>Stage</th><th>Interested in</th><th>Source</th><th>With</th><th>Follow up</th><th>Next appointment</th><th>Last contact</th><th>Enquired</th>
        </tr></thead><tbody>${rows.map((p) => {
          const s = stageOf(p.stage);
          const fs = followState(p);
          return `<tr data-href="#/prospects/${enc(p.id)}">
            <td data-label="Name"><a href="#/prospects/${enc(p.id)}"><strong>${esc(p.name)}</strong></a> ${typeTags(p)}${notContacted(p, set) ? ' <span class="pr-tag is-bad">Not contacted</span>' : ""}${cancelOpen(p) ? ` <span class="pr-tag is-bad">${cancelWord(p)}, not rebooked</span>` : ""}</td>
            <td data-label="Stage"><span class="pr-pill is-${s.tone}">${esc(s.name)}</span></td>
            <td data-label="Interested in">${esc(p.concern || "")}</td>
            <td data-label="Source">${esc(p.source || "")}</td>
            <td data-label="With">${esc(p.assignedToName || "")}</td>
            <td data-label="Follow up" class="${fs === "overdue" ? "is-bad" : fs === "today" ? "is-warn" : ""}">${esc(fuText(p))}</td>
            <td data-label="Next appointment">${esc(niceDay(p.nextAppt))}</td>
            <td data-label="Last contact">${esc(p.lastContactAt ? ago(p.lastContactAt) : "")}</td>
            <td data-label="Enquired">${esc(niceDay(keyOf(p.createdAt)))}</td></tr>`;
        }).join("")}</tbody></table></div>`
        : '<p class="pr-empty">No prospects match.</p>';
      return;
    }
    const lostN = list.filter((p) => p.stage === "lost").length;
    const cols = STAGES.filter((s) => s.key !== "lost" || st.showLost);
    box.innerHTML = `<div class="pr-board">${cols.map((s) => {
      const items = list.filter((p) => (p.stage || "new") === s.key).sort(byUrgency);
      return `<section class="pr-col is-${s.tone}" data-stage="${s.key}">
        <header><i></i><b>${esc(s.name)}</b><em>${items.length}</em></header>
        <div class="pr-col-body">${items.slice(0, st.more[s.key] || COL_MAX).map(card).join("") || '<p class="pr-col-empty">None</p>'}${
          items.length > (st.more[s.key] || COL_MAX) ? `<button type="button" class="lh-btn is-quiet" data-more="${s.key}">Show ${
            items.length - (st.more[s.key] || COL_MAX)} more</button>` : ""}</div></section>`;
    }).join("")}</div>
    <button type="button" class="lh-btn is-quiet pr-lost-btn" data-act="lost">${st.showLost ? "Hide lost" : `Show lost (${lostN})`}</button>
    ${work ? '<p class="muted pr-hint">Drag a card to another column to move it along.</p>' : ""}`;
    applyBoardScroll(root, prevScroll);
  }
  // The remembered filters, back in their boxes
  const setVal = (role, v) => { const el = root.querySelector(`[data-role="${role}"]`); if (el) el.value = v ?? ""; return el; };
  setVal("q", st.qRaw || st.q);
  setVal("range", st.range);
  setVal("who", st.who);
  const srcSel = setVal("source", st.source);
  if (srcSel && srcSel.value !== st.source) st.source = "";   // that source isn't on the list any more
  root.querySelector('[data-role="dates"]').hidden = st.range !== "custom";
  setVal("from", st.from);
  setVal("to", st.to);
  drawBody();
  // Back from a prospect: the same place on the page
  if (boardScroll && Date.now() - boardScroll.at < 30 * 60000) {
    const s = boardScroll;
    boardScroll = null;
    requestAnimationFrame(() => {
      applyBoardScroll(root, s);
      window.scrollTo(0, s.y || 0);
      const ct = document.getElementById("content");
      if (ct) ct.scrollTop = s.ct || 0;
    });
  }
  const reload = () => loadAll().then((list) => {
    if (!root.isConnected || st.old) return;
    all = list;
    boardCache = { at: Date.now(), list: all };
    drawBody();
  }).catch((err) => console.warn("Prospects refresh:", err));
  if (cached) reload();   // the remembered list is on screen; get the latest quietly

  // Refresh: Apps Script checks info@ (and texts and emails sent outside the portal) now, then the board is read again.
  // People who can only view prospects just get the board reloaded.
  let refreshing = false;
  async function refreshNow(btn) {
    if (refreshing) return;
    refreshing = true;
    const tx = btn.querySelector(".pr-refresh-tx");
    btn.disabled = true;
    btn.classList.add("is-busy");
    tx.textContent = "Checking…";
    let r = {};
    try {
      if (work) {
        try { r = (await api("refresh")) || {}; }
        catch (err) { r = { problem: `${errText(err, "New emails couldn't be checked.")} The board was reloaded.` }; }
      }
      const [list, s] = await Promise.all([loadAll(st.old), loadSettings(true)]);
      if (!root.isConnected) return;
      all = list;
      set = s;
      boardCache = { at: Date.now(), list: st.old ? all.filter((p) => !p.historic) : all };
      drawBody();
      const bits = [];
      if (r.imported) bits.push(`${r.imported} new enquir${r.imported === 1 ? "y" : "ies"}`);
      if (r.contacts) bits.push(`${r.contacts} contact${r.contacts === 1 ? "" : "s"} picked up`);
      showToast(r.problem || (bits.length ? bits.join(" · ")
        : r.recent ? "Up to date (checked in the last minute)" : "Up to date"));
    } catch (err) {
      console.warn("Prospects refresh:", err);
      showToast("Couldn't reload the board. Check your connection and try again.");
    } finally {
      refreshing = false;
      btn.disabled = false;
      btn.classList.remove("is-busy");
      tx.textContent = "Refresh";
    }
  }

  // Older enquiries (over 90 days, never worked): loaded when asked for, or when the dates go back that far
  async function setOld(on) {
    if (on === st.old) return;
    const btn = root.querySelector('[data-act="old"]');
    btn.disabled = true;
    btn.textContent = on ? "Loading…" : "Show older enquiries";
    try { all = await loadAll(on); st.old = on; }
    catch { showToast("Couldn't load them. Try again."); }
    finally { btn.disabled = false; btn.textContent = st.old ? "Hide older enquiries" : "Show older enquiries"; drawBody(); }
  }
  const maybeOld = () => { const [a] = rangeOf(); if (a && a < addDays(t, -90) && !st.old) setOld(true); };
  const syncDates = () => {
    const box = root.querySelector('[data-role="dates"]');
    box.hidden = st.range !== "custom";
    box.querySelector('[data-role="from"]').value = st.from;
    box.querySelector('[data-role="to"]').value = st.to;
  };
  function clearFilters() {
    Object.assign(st, { q: "", qRaw: "", source: "", who: "all", show: "", range: "", from: "", to: "" });
    ["q", "source", "range", "from", "to"].forEach((r) => setVal(r, ""));
    setVal("who", "all");
    syncDates();
  }
  const replace = (p) => { const i = all.findIndex((x) => x.id === p.id); if (i >= 0) all[i] = p; else all.unshift(p); drawBody(); };
  async function move(id, to) {
    const p = all.find((x) => x.id === id);
    if (!p || p.stage === to) return;
    if (to === "lost") { lostDialog(p, set, replace); return; }
    replace({ ...p, stage: to, stageAt: new Date().toISOString(), ...(to !== "new" ? { waitingSince: "" } : {}) });   // moves now, saves in the background
    showToast(`${p.name}: ${stageOf(to).name}`);
    try {
      const r = await api("stage", { id, stage: to });
      if (r && r.prospect) replace(r.prospect);
    } catch (err) {
      replace(p);
      showToast(`${errText(err)} ${p.name} was moved back.`);
    }
  }

  root.addEventListener("change", (e) => {
    const r = e.target.dataset.role;
    if (e.target.name === "pr-view") {
      st.view = e.target.value;
      history.replaceState(null, "", st.view === "board" ? "#/prospects" : `#/prospects/${st.view}`);
      drawBody();
    }
    if (r === "source") { st.source = e.target.value; drawBody(); }
    if (r === "who") { st.who = e.target.value; drawBody(); }
    if (r === "range") {
      st.range = e.target.value;
      if (st.range === "custom" && !st.from) { st.from = addDays(t, -29); st.to = t; }
      syncDates(); maybeOld(); drawBody();
    }
    if (r === "from" || r === "to") {
      st[r] = e.target.value;
      if (st.from && st.to && st.from > st.to) { if (r === "from") st.to = st.from; else st.from = st.to; }   // the wrong way round
      syncDates(); maybeOld(); drawBody();
    }
  });
  let qTimer = 0;
  root.addEventListener("input", (e) => {
    if (e.target.dataset.role !== "q") return;
    st.qRaw = e.target.value;
    st.q = e.target.value.trim().toLowerCase();
    clearTimeout(qTimer);
    qTimer = setTimeout(drawBody, 150);   // redraws once typing pauses, not on every key
  });
  root.addEventListener("click", (e) => {
    if (e.target.closest('a[href^="#/prospects/"], tr[data-href]')) rememberBoardScroll(root);
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a")) { location.hash = tr.dataset.href; return; }
    const fb = e.target.closest("[data-fu]");
    if (fb) {
      const row = fb.closest("[data-id]");
      const p = row && all.find((x) => x.id === row.dataset.id);
      if (p) followAction(fb.dataset.fu, p, (np) => { if (np) replace(np); });
      return;
    }
    const mb = e.target.closest("[data-more]");
    if (mb) { st.more[mb.dataset.more] = (st.more[mb.dataset.more] || COL_MAX) + COL_MAX * 2; drawBody(); return; }
    // A tile counts the whole board, so it clears the filters and shows exactly the ones it counted
    const tile = e.target.closest(".pr-tile[data-show], .pr-tile[data-range]");
    if (tile) {
      const on = tile.dataset.show ? st.show === tile.dataset.show : st.range === tile.dataset.range;
      clearFilters();
      if (!on && tile.dataset.show) st.show = tile.dataset.show;
      if (!on && tile.dataset.range) { st.range = tile.dataset.range; setVal("range", st.range); }
      drawBody();
      return;
    }
    const sh = e.target.closest("[data-show]");
    if (sh) { st.show = st.show === sh.dataset.show ? "" : sh.dataset.show; drawBody(); return; }
    const rg = e.target.closest("[data-range]");
    if (rg) {
      st.range = st.range === rg.dataset.range ? "" : rg.dataset.range;
      root.querySelector('[data-role="range"]').value = st.range;
      syncDates(); drawBody(); return;
    }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "clear") { clearFilters(); drawBody(); return; }
    if (a.dataset.act === "lost") { st.showLost = !st.showLost; drawBody(); }
    if (a.dataset.act === "refresh") { refreshNow(a); return; }
    if (a.dataset.act === "old") setOld(!st.old);
    if (a.dataset.act === "new") newDialog(all, (id) => { location.hash = `#/prospects/${enc(id)}`; });
    if (a.dataset.act === "settings") settingsDialog(set, async () => { set = await loadSettings(true); drawBody(); }, reload);
  });

  // Drag a card to another column
  if (work) {
    root.addEventListener("dragstart", (e) => {
      const c = e.target.closest(".pr-card");
      if (!c) return;
      e.dataTransfer.setData("text/plain", c.dataset.id);
      e.dataTransfer.effectAllowed = "move";
      c.classList.add("is-drag");
    });
    root.addEventListener("dragend", (e) => {
      const c = e.target.closest(".pr-card");
      if (c) c.classList.remove("is-drag");
      root.querySelectorAll(".pr-col.is-over").forEach((x) => x.classList.remove("is-over"));
    });
    root.addEventListener("dragover", (e) => {
      const col = e.target.closest(".pr-col");
      if (!col) return;
      e.preventDefault();
      root.querySelectorAll(".pr-col.is-over").forEach((x) => { if (x !== col) x.classList.remove("is-over"); });
      col.classList.add("is-over");
    });
    root.addEventListener("drop", (e) => {
      const col = e.target.closest(".pr-col");
      if (!col) return;
      e.preventDefault();
      col.classList.remove("is-over");
      move(e.dataTransfer.getData("text/plain"), col.dataset.stage);
    });
  }
}
/* ===================== Dialogs ===================== */

async function newDialog(all, onDone) {
  const me = auth.currentUser && auth.currentUser.uid;
  const concerns = [...new Set(all.map((p) => p.concern).filter(Boolean))].slice(0, 60);
  const sources = sourceList(all, ["Web form", "Booked directly"]);
  let force = false;
  const ctl = openDialog({
    title: "New prospect", sub: "Someone who called, walked in, chatted online or messaged. Web form enquiries are added by themselves.",
    submit: "Add prospect",
    body: `
      <div class="pr-grid2">
        <label class="lh-field"><span class="lh-label">Full name</span><input name="name" class="fe-input" maxlength="120" required /></label>
        ${sourceField(sources, "Phone call")}
        <label class="lh-field"><span class="lh-label">Mobile</span><input name="phone" class="fe-input" inputmode="tel" maxlength="30" /></label>
        <label class="lh-field"><span class="lh-label">Email</span><input name="email" type="email" class="fe-input" maxlength="254" /></label>
        <label class="lh-field"><span class="lh-label">Interested in</span><input name="concern" class="fe-input" maxlength="150" list="pr-concerns" placeholder="e.g. Wrinkle Relaxer, acne scars" />
          <datalist id="pr-concerns">${concerns.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist></label>
        <label class="lh-field"><span class="lh-label">Age group</span><select name="age" class="fe-input"><option value="">Not asked</option>${opts(AGES, "")}</select></label>
        <label class="lh-field"><span class="lh-label">Prefers</span><select name="pref" class="fe-input"><option value="">Not asked</option>${opts(PREFS, "")}</select></label>
        <label class="lh-field"><span class="lh-label">Give it to</span><select name="assignTo" class="fe-input" data-role="staff"><option value="">Loading…</option></select></label>
      </div>
      <label class="lh-field"><span class="lh-label">What they asked about</span><textarea name="message" rows="3" maxlength="2000" class="fe-input"></textarea></label>
      <label class="fe-check"><input type="checkbox" name="spoke" checked /> I've spoken to them (it starts as Contacted)</label>
      ${followHtml()}
      <div class="pr-dup" data-role="dup" hidden></div>`,
    onOpen: async (c) => {
      c.form.addEventListener("change", (e) => { if (e.target.dataset.role === "srcsel") syncSourceOther(e.target); });
      const sel = c.form.querySelector('[data-role="staff"]');
      const list = await staffList();
      sel.innerHTML = '<option value="">Nobody yet</option>' + list.map((s) =>
        `<option value="${esc(s.id)}"${s.id === me ? " selected" : ""}>${esc(s.name)}${s.id === me ? " (me)" : ""}</option>`).join("");
      c.form.elements.name.focus();
    },
    onSubmit: async (c) => {
      const f = c.form.elements;
      const fp = fuProblem(f.followUp.value, f.followTime.value);
      if (fp) { c.fail(fp); return; }
      const src = sourceValue(c.form, sources);
      if (src.problem) { c.fail(src.problem); f.sourceOther.focus(); return; }
      const r = await api("add", {
        name: f.name.value, phone: f.phone.value, email: f.email.value, source: src.source, concern: f.concern.value,
        age: f.age.value, pref: f.pref.value, assignTo: f.assignTo.value, message: f.message.value,
        spoke: f.spoke.checked, followUp: f.followUp.value, followNote: f.followNote.value, followTime: f.followTime.value, force,
      });
      if (r.duplicate) {
        const box = c.form.querySelector('[data-role="dup"]');
        box.hidden = false;
        box.innerHTML = `${I(IC.alert)}<div><strong>${esc(r.duplicate.name)} is already a prospect</strong>
          <small>Same mobile or email · ${esc(stageOf(r.duplicate.stage).name)}.</small>
          <a class="lh-btn" href="#/prospects/${enc(r.duplicate.id)}">Open them</a></div>`;
        box.querySelector("a").addEventListener("click", () => c.close());
        force = true;
        c.btn.textContent = "Add as a new prospect anyway";
        c.fail("");
        return;
      }
      c.close();
      // Apps Script may only accept the standard sources: if it changed it, say so
      const kept = !r.prospect || normR(r.prospect.source) === normR(src.source);
      showToast(kept ? "Prospect added"
        : `Prospect added, but its source was saved as “${r.prospect.source || "nothing"}”. Apps Script needs the update for new sources.`);
      if (r.prospect) justAdded.set(r.id, r.prospect);
      onDone(r.id);
    },
  });
  return ctl;
}

function lostDialog(p, set, done) {
  const reasons = lostReasonsOf(set);
  const real = reasons.filter((r) => !junkReason(r, set));
  const junk = reasons.filter((r) => junkReason(r, set));
  const pill = (r) => `<label class="pr-reason"><input type="radio" name="reason" value="${esc(r)}" /><span>${esc(r)}</span></label>`;
  openDialog({
    title: `Mark ${p.name} as lost`, submit: "Mark as lost",
    body: `<div class="pr-reasons">${real.map(pill).join("")}</div>
      ${junk.length ? `<p class="prs-lost-h">Not a real enquiry <small class="muted">(left out of the reports)</small></p>
        <div class="pr-reasons is-junk">${junk.map(pill).join("")}</div>` : ""}
      <label class="lh-field"><span class="lh-label">Note (optional)</span><textarea name="note" rows="2" maxlength="1000" class="fe-input"></textarea></label>`,
    onSubmit: async (c) => {
      const reason = (c.form.querySelector('[name="reason"]:checked') || {}).value;
      if (!reason) { c.fail("Choose why they were lost."); return; }
      const r = await api("stage", { id: p.id, stage: "lost", reason, note: c.form.elements.note.value });
      c.close();
      showToast(`${p.name} marked as lost`);
      done(r.prospect);
    },
  });
}

// Prospect settings → Import past chats (the .zip from Tawk.to → Inbox → Export). Checks first, then imports.
function wireTawkImport(c) {
  const input = c.form.querySelector('[data-role="tawkfile"]');
  const box = c.form.querySelector('[data-role="tmsg"]');
  if (!input || !box) return;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const text = (r) => [
    `${plural(r.found, "chat")} in the file`,
    r.new && `${r.dry ? "" : "✓ "}${plural(r.new, "new prospect")}`,
    r.again && `${r.again} added to someone already here`,
    r.already && `${r.already} already in`,
    r.skipped && `${r.skipped} skipped (${Object.entries(r.reasons || {}).map(([k, n]) => `${n}: ${k.toLowerCase()}`).join(", ")})`,
    r.left && `${r.left} not checked yet: choose the file again to finish`,
  ].filter(Boolean).join(" · ");
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { box.textContent = "That file is too big. Export fewer chats at a time."; return; }
    box.textContent = "Reading the file…";
    let data;
    try {
      data = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(",")[1] || "");
        fr.onerror = () => rej(new Error("The file couldn't be read."));
        fr.readAsDataURL(file);
      });
      box.textContent = "Checking the chats…";
      const r = await api("tawkImport", { name: file.name, data, dryRun: true });
      const todo = (r.new || 0) + (r.again || 0);
      box.innerHTML = `<span>${esc(text(r))}</span>${r.sample && r.sample.length
        ? `<small class="muted">For example: ${esc(r.sample.slice(0, 4).join(" · "))}</small>` : ""}${todo
        ? `<button type="button" class="lh-btn is-primary" data-role="tawkgo">Import them</button>` : ""}`;
      const go = box.querySelector('[data-role="tawkgo"]');
      if (go) go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Importing…";
        try {
          const done = await api("tawkImport", { name: file.name, data, dryRun: false });
          box.textContent = `Done. ${text(done)}`;
          showToast("Past chats imported");
        } catch (err) { box.textContent = errText(err); }
      });
    } catch (err) { box.textContent = errText(err, "That file couldn't be imported."); }
  });
}

function settingsDialog(set, onSaved, onImported) {
  const SUGGEST = ["Spam", "Test entry"];
  const reasonRow = (name, counts) => `<li class="prs-reason${counts ? "" : " is-off"}">
      <input class="fe-input" data-f="name" value="${esc(name)}" maxlength="60" aria-label="Reason" />
      <label class="prs-switch" title="Turn off for spam, tests and anything that wasn't a real enquiry">
        <input type="checkbox" data-f="counts"${counts ? " checked" : ""} /><span aria-hidden="true"></span>
        <em>${counts ? "Counts as lost" : "Not counted"}</em></label>
      <button type="button" class="prs-x" data-del aria-label="Remove this reason">×</button></li>`;
  const people = (name, label, help) => `<div class="prs-block">
      <div class="prs-bh"><span class="prs-label">${esc(label)}</span><span class="prs-count" data-count="${name}"></span>
        <span class="prs-quick"><button type="button" data-pick="${name}" data-on="1">All</button>
          <button type="button" data-pick="${name}" data-on="">None</button></span></div>
      ${help ? `<p class="prs-help">${esc(help)}</p>` : ""}
      <div class="prs-people" data-ticks="${name}"><small class="muted">Loading staff…</small></div></div>`;
  const sec = (ic, tone, title, sub, inner) => `<section class="prs-sec">
      <header class="prs-sec-h"><span class="prs-ic is-${tone}">${I(IC[ic])}</span><div><h4>${esc(title)}</h4><p>${esc(sub)}</p></div></header>
      ${inner}</section>`;
  const toggle = (name, on, title, help) => `<div class="prs-block"><label class="prs-toggle">
      <input type="checkbox" name="${name}"${on ? " checked" : ""} /><span class="prs-sw" aria-hidden="true"></span>
      <span><b>${esc(title)}</b><small>${esc(help)}</small></span></label></div>`;
  openDialog({
    title: "Prospect settings", sub: "These apply to everyone using the Prospect Dashboard.", submit: "Save settings",
    body: `<div class="prs-wrap">
      ${sec("inbox", "teal", "New web enquiries", "Who hears about them, who gets them, and how quickly they should be contacted.",
        people("notify", "Email these people when one arrives", "")
        + people("team", "Share them out between",
          "Each new enquiry goes to whoever on this list is working today and has the fewest open prospects. Nobody chosen: they wait on the board for anyone.")
        + `<div class="prs-block prs-inline">
            <div><span class="prs-label">Flag as “Not contacted” after</span>
              <p class="prs-help">The card turns red if nobody has called, texted or emailed them by then.</p></div>
            <div class="prs-hours">
              <button type="button" class="prs-step" data-step="-1" aria-label="Fewer hours">−</button>
              <input name="hours" type="number" min="1" max="168" inputmode="numeric" class="fe-input" value="${hoursOf(set)}" aria-label="Hours" />
              <span>hours</span>
              <button type="button" class="prs-step" data-step="1" aria-label="More hours">+</button>
            </div>
            <div class="prs-chips">${[4, 12, 24, 48, 72].map((h) => `<button type="button" class="prs-chip" data-hours="${h}">${h} h</button>`).join("")}</div>
          </div>
          <div class="prs-block prs-inline">
            <div><span class="prs-label">Missed an enquiry?</span>
              <p class="prs-help">Looks in info@ for web form emails from the last 14 days and adds any that aren't here yet.</p></div>
            <button type="button" class="lh-btn" data-role="import">Check now</button>
            <small class="prs-msg" data-role="imsg"></small>
          </div>`)}

      ${sec("mail", "teal", "Automatic emails", "Turn each one on or off for everyone.",
        toggle("emailDaily", set.emailDaily !== false, "Daily “Prospects to follow up today” email",
          "After 8 am, each person gets their follow-ups due today or overdue, anyone not contacted yet, and anyone with no next step for a week. Prospects given to nobody go to the people ticked under “Email these people”, or the Admins.")
        + toggle("emailNew", set.emailNew !== false, "Email when a new enquiry arrives",
          "To the person it's given to and the people ticked above. Replies to campaign texts are still emailed.")
        + toggle("emailFollowTime", set.emailFollowTime !== false, "Email at the follow-up time",
          "For follow-ups with a time. The reminder in the corner of the portal still shows either way.")
        + toggle("cancelFollow", set.cancelFollow !== false, "Add a follow-up when someone cancels",
          "When a prospect cancels or doesn't come and hasn't rebooked, a follow-up is set for that day to call them. Turn off if these are filling up the daily email.")
        + `<div class="prs-block prs-inline">
            <div><span class="prs-label">Follow up after a consultation with no treatment booked</span>
              <p class="prs-help">A follow-up is added this many days after their consultation, noting what they were quoted. 0 turns it off.</p></div>
            <div class="prs-hours"><input name="consultDays" type="number" min="0" max="30" inputmode="numeric" class="fe-input"
              value="${esc(set.consultFollowDays ?? 3)}" aria-label="Days" /><span>days</span></div>
          </div>`)}

      ${sec("text", "teal", "SMS and email templates", "Ready-made messages for each situation, like booked then cancelled, or consulted but no treatment.",
        `<div class="prs-block prs-inline">
           <div><span class="prs-label">Templates</span>
             <p class="prs-help" data-role="tplcount">${(set.templates || []).length
               ? `${set.templates.length} saved. They show in the Send text and Send email windows.`
               : "None yet, so the three built-in ones are used."}</p></div>
           <button type="button" class="lh-btn" data-act="templates">Edit templates</button>
         </div>`)}

      ${sec("text", "sky", "Online chat (Tawk.to)", "Chats from the website come in as prospects.",
        `<div class="prs-block"><label class="prs-toggle"><input type="checkbox" name="tawkSkip"${set.tawkSkipPatients ? " checked" : ""} />
            <span class="prs-sw" aria-hidden="true"></span>
            <span><b>Skip chats from existing patients</b><small>For example, someone asking to move an appointment.</small></span></label></div>
         <div class="prs-block"><span class="prs-label">Import past chats</span>
           <ol class="prs-steps"><li>In Tawk.to, open <b>Inbox</b>.</li><li>Tick the chats (up to 50 at a time) and choose <b>Export</b>.</li>
             <li>Tawk.to emails you a .zip. Choose it below.</li></ol>
           <div class="prs-file"><label class="lh-btn">Choose the .zip…<input type="file" accept=".zip,.json,application/zip,application/json" data-role="tawkfile" hidden /></label>
             <div class="pr-tawk-msg" data-role="tmsg"></div></div>
           <p class="prs-help">You'll see what it finds before anything is added.</p></div>`)}
      ${sec("flag", "slate", "Lost reasons", "The choices when someone is marked as lost.",
        `<div class="prs-block">
           <p class="prs-help">Turn off <b>Counts as lost</b> for anything that wasn't a real enquiry, like spam or a test.
             They stay on the board under Lost, but they're left out of the reports and the board's counts.</p>
           <ul class="prs-reasons" data-role="reasons">${lostReasonsOf(set).map((r) => reasonRow(r, !junkReason(r, set))).join("")}</ul>
           <div class="prs-add"><input class="fe-input" data-role="newreason" maxlength="60" placeholder="Add a reason, e.g. Moved away" aria-label="New reason" />
             <button type="button" class="lh-btn" data-act="addreason">${I(IC.plus)} Add</button></div>
           <div class="prs-suggest" data-role="suggest" hidden></div>
         </div>`)}
    </div>`,
    onOpen: (c) => {
      const f = c.form;
      c.dlg.classList.add("prs-dlg");
      c.btn.disabled = true;   // until the staff list is in, so nobody is unticked by accident

      const counts = () => {
        ["notify", "team"].forEach((n) => {
          const el = f.querySelector(`[data-count="${n}"]`);
          const k = f.querySelectorAll(`[name="${n}"]:checked`).length;
          if (el) { el.textContent = k ? `${k} chosen` : "Nobody"; el.classList.toggle("is-none", !k); }
        });
        const h = Number(f.elements.hours.value);
        f.querySelectorAll("[data-hours]").forEach((b) => b.classList.toggle("is-on", Number(b.dataset.hours) === h));
      };
      const names = () => [...f.querySelectorAll('.prs-reason [data-f="name"]')].map((x) => normR(x.value));
      const suggest = () => {
        const box = f.querySelector('[data-role="suggest"]');
        const miss = SUGGEST.filter((s) => !names().includes(normR(s)));
        box.hidden = !miss.length;
        box.innerHTML = miss.length ? `Quick add (not counted): ${miss.map((s) =>
          `<button type="button" class="prs-chip" data-suggest="${esc(s)}">+ ${esc(s)}</button>`).join("")}` : "";
      };
      const addReason = (raw, countsIt = true) => {
        const name = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (!name) return false;
        const list = f.querySelector('[data-role="reasons"]');
        const i = names().indexOf(normR(name));
        if (i >= 0) {   // already there: point to it
          const row = list.children[i];
          row.classList.remove("is-flash"); void row.offsetWidth; row.classList.add("is-flash");
          return false;
        }
        list.insertAdjacentHTML("beforeend", reasonRow(name, countsIt));
        suggest();
        return true;
      };
      c.addReason = addReason;

      f.addEventListener("click", (e) => {
        if (e.target.closest('[data-act="templates"]')) {
          templatesDialog((n) => {
            const el = f.querySelector('[data-role="tplcount"]');
            if (el) el.textContent = n ? `${n} saved. They show in the Send text and Send email windows.` : "None yet, so the three built-in ones are used.";
          });
          return;
        }
        const pk = e.target.closest("[data-pick]");
        if (pk) { f.querySelectorAll(`[name="${pk.dataset.pick}"]`).forEach((x) => { x.checked = !!pk.dataset.on; }); counts(); return; }
        const stp = e.target.closest("[data-step]");
        if (stp) {
          const inp = f.elements.hours;
          inp.value = Math.min(168, Math.max(1, (Number(inp.value) || 24) + Number(stp.dataset.step)));
          counts(); return;
        }
        const hb = e.target.closest("[data-hours]");
        if (hb) { f.elements.hours.value = hb.dataset.hours; counts(); return; }
        const del = e.target.closest("[data-del]");
        if (del) { del.closest(".prs-reason").remove(); suggest(); return; }
        const sg = e.target.closest("[data-suggest]");
        if (sg) { addReason(sg.dataset.suggest, false); return; }
        if (e.target.closest('[data-act="addreason"]')) {
          const inp = f.querySelector('[data-role="newreason"]');
          if (addReason(inp.value)) inp.value = "";
          inp.focus();
        }
      });
      f.addEventListener("change", (e) => {
        const sw = e.target.closest('[data-f="counts"]');
        if (sw) {
          const row = sw.closest(".prs-reason");
          row.classList.toggle("is-off", !sw.checked);
          row.querySelector(".prs-switch em").textContent = sw.checked ? "Counts as lost" : "Not counted";
        }
        counts();
      });
      f.addEventListener("input", (e) => { if (e.target.name === "hours") counts(); });
      f.querySelector('[data-role="newreason"]').addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); if (addReason(e.target.value)) e.target.value = ""; }
      });

      staffList().then((list) => {
        if (!c.dlg.open) return;
        [["notify", set.notify], ["team", set.team]].forEach(([name, chosen]) => {
          const box = f.querySelector(`[data-ticks="${name}"]`);
          box.innerHTML = list.length ? list.map((s) => `<label class="prs-person">
              <input type="checkbox" name="${name}" value="${esc(s.id)}"${(chosen || []).includes(s.id) ? " checked" : ""} />
              <span class="prs-av">${esc(initials(s.name))}</span><span class="prs-pname">${esc(s.name)}</span></label>`).join("")
            : '<small class="muted">The staff list couldn\'t be loaded. Close Settings and open it again.</small>';
        });
        c.btn.disabled = !list.length;
        counts();
      });
      counts();
      suggest();
      wireTawkImport(c);

      f.querySelector('[data-role="import"]').addEventListener("click", async (e) => {
        const b = e.currentTarget;
        const m = f.querySelector('[data-role="imsg"]');
        b.disabled = true;
        m.textContent = "Checking info@… (this can take up to a minute)";
        try {
          const r = await api("importNow", { days: 14 });
          m.textContent = r.imported ? `${r.imported} new enquiry email(s) added. They're on the board now.` : "No new enquiry emails.";
          if (r.imported && onImported) onImported();
        } catch (err) { m.textContent = errText(err); }
        finally { b.disabled = false; }
      });
    },
    onSubmit: async (c) => {
      const f = c.form;
      const newBox = f.querySelector('[data-role="newreason"]');
      if (newBox.value.trim()) { c.addReason(newBox.value); newBox.value = ""; }   // typed but not added yet
      const seen = new Set();
      const rows = [];
      f.querySelectorAll(".prs-reason").forEach((li) => {
        const name = li.querySelector('[data-f="name"]').value.replace(/\s+/g, " ").trim().slice(0, 60);
        if (!name || seen.has(normR(name))) return;
        seen.add(normR(name));
        rows.push({ name, counts: li.querySelector('[data-f="counts"]').checked });
      });
      if (!rows.some((r) => r.counts)) { c.fail("Keep at least one reason that counts as lost."); return; }
      const pick = (n) => [...f.querySelectorAll(`[name="${n}"]:checked`)].map((x) => x.value);
      await api("saveSettings", {
        emailDaily: f.elements.emailDaily.checked,
        emailNew: f.elements.emailNew.checked,
        emailFollowTime: f.elements.emailFollowTime.checked,
        cancelFollow: f.elements.cancelFollow.checked,
        consultFollowDays: Math.max(0, Math.min(30, Math.round(Number(f.elements.consultDays.value) || 0))),
        notify: pick("notify"), team: pick("team"),
        respondHours: Math.min(168, Math.max(1, Math.round(Number(f.elements.hours.value) || 24))),
        tawkSkipPatients: f.elements.tawkSkip.checked,
        lostReasons: rows.map((r) => r.name),
        lostIgnore: rows.filter((r) => !r.counts).map((r) => r.name),
      });
      const back = await loadSettings(true);
      c.close();
      const kept = Array.isArray(back.lostIgnore) && typeof back.emailDaily === "boolean";
      showToast(kept ? "Prospect settings saved" : "Saved, but some settings weren't kept. Apps Script needs the update.");
      onSaved();
    },
  });
}

/* ===================== Prospect settings → SMS and email templates ===================== */
// Saved through Apps Script (op "saveTemplates"). Situations and blanks come from Apps Script (op "templateList").

function prtCssOnce() {
  if (document.getElementById("prt-css")) return;
  const s = document.createElement("style");
  s.id = "prt-css";
  s.textContent = `.prt-dlg{width:min(1000px,96vw)}
    .prt-wrap{display:grid;grid-template-columns:260px 1fr;gap:16px;min-height:440px}
    @media(max-width:720px){.prt-wrap{grid-template-columns:1fr}}
    .prt-side{display:flex;flex-direction:column;gap:8px}
    .prt-list{display:flex;flex-direction:column;gap:6px;max-height:470px;overflow:auto}
    .prt-item{text-align:left;border:1px solid #e2e8f0;border-radius:10px;padding:8px 10px;background:#fff;cursor:pointer;display:grid;gap:2px}
    .prt-item.is-on{border-color:#0f766e;box-shadow:0 0 0 2px #ccfbf1}
    .prt-item.is-off{opacity:.55}
    .prt-item small{color:#64748b;font-size:12px}
    .prt-ch{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;width:max-content}
    .prt-ch.is-sms{background:#e0f2fe;color:#075985}.prt-ch.is-email{background:#ede9fe;color:#5b21b6}
    .prt-new{display:flex;gap:6px}
    .prt-edit{display:flex;flex-direction:column;gap:10px}
    .prt-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .prt-seg{display:inline-flex;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden}
    .prt-seg button{border:0;background:#fff;padding:5px 14px;cursor:pointer}
    .prt-seg button.is-on{background:#0f766e;color:#fff}
    .prt-sits{display:flex;flex-wrap:wrap;gap:6px}
    .prt-sit{display:flex;align-items:center;gap:6px;border:1px solid #e2e8f0;border-radius:999px;padding:4px 10px;font-size:13px;cursor:pointer}
    .prt-sit:has(input:checked){background:#f0fdfa;border-color:#5eead4}
    .prt-tools{display:flex;gap:4px}
    .prt-tools button{border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:3px 9px;cursor:pointer}
    .prt-html{min-height:180px;max-height:340px;overflow:auto;line-height:1.5}
    .prt-tokens{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
    .prt-del{align-self:flex-start;color:#b91c1c}
    .prt-empty{padding:40px 0;text-align:center}`;
  document.head.appendChild(s);
}

async function templatesDialog(onSaved) {
  let data;
  try { data = await api("templateList"); }
  catch (err) { showToast(errText(err, "Couldn't load the templates. Check the new Code.gs is deployed.")); return; }
  prtCssOnce();
  const sits = data.situations || {};
  const sitKeys = Object.keys(sits);
  const tokens = data.tokens || [];
  const list = (data.templates || []).map((t) => ({ ...t, situations: [...(t.situations || ["any"])] }));
  let cur = list.length ? 0 : -1;
  let lastField = null;
  const ui = {};

  openDialog({
    title: "SMS and email templates",
    sub: "Staff choose these in the Send text and Send email windows. The ones for the prospect's situation are shown first.",
    submit: "Save templates",
    body: `<div class="prt-wrap">
        <div class="prt-side"><div class="prt-list" data-role="tlist"></div>
          <div class="prt-new"><button type="button" class="lh-btn" data-tnew="sms">${I(IC.plus)} SMS</button>
            <button type="button" class="lh-btn" data-tnew="email">${I(IC.plus)} Email</button></div></div>
        <div class="prt-edit" data-role="tedit"></div>
      </div>`,
    onOpen: (c) => {
      c.dlg.classList.add("prt-dlg");
      const f = c.form;
      const listEl = f.querySelector('[data-role="tlist"]');
      const editEl = f.querySelector('[data-role="tedit"]');
      const q = (s) => editEl.querySelector(s);
      const sitText = (t) => (t.situations.includes("any") ? "Any prospect" : t.situations.map((k) => sits[k] || k).join(", "));

      function drawList() {
        listEl.innerHTML = list.length ? list.map((t, i) => `<button type="button" class="prt-item${i === cur ? " is-on" : ""}${
            t.on === false ? " is-off" : ""}" data-tpick="${i}">
            <span class="prt-ch is-${t.channel}">${t.channel === "email" ? "Email" : "SMS"}${t.on === false ? " · off" : ""}</span>
            <strong>${esc(t.name || "Untitled")}</strong><small>${esc(sitText(t))}</small></button>`).join("")
          : '<p class="muted">No templates yet. Add an SMS or email template.</p>';
      }
      function commit() {
        const t = list[cur];
        if (!t || !q('[data-t="name"]')) return;
        t.name = q('[data-t="name"]').value.replace(/\s+/g, " ").trim().slice(0, 60);
        t.on = q('[data-t="on"]').checked;
        const ticked = [...editEl.querySelectorAll('[data-t="sit"]:checked')].map((x) => x.value);
        t.situations = ticked.length ? ticked : ["any"];
        if (t.channel === "email") { t.subject = q('[data-t="subject"]').value; t.body = q('[data-t="html"]').innerHTML; }
        else t.body = q('[data-t="text"]').value;
      }
      function countSms() {
        const ta = q('[data-t="text"]');
        const out = q('[data-role="smscount"]');
        if (ta && out) out.textContent = `${ta.value.length} / 560 characters · about ${Math.max(1, Math.ceil(ta.value.length / 153))} SMS (before blanks are filled)`;
      }
      function drawEdit() {
        const t = list[cur];
        lastField = null;
        if (!t) { editEl.innerHTML = '<p class="muted prt-empty">Choose a template on the left, or add one.</p>'; return; }
        const isE = t.channel === "email";
        editEl.innerHTML = `
          <label class="lh-field"><span class="lh-label">Name</span>
            <input class="fe-input" data-t="name" maxlength="60" value="${esc(t.name || "")}" placeholder="e.g. Cancelled – call to rebook" /></label>
          <div class="prt-row"><span class="lh-label">Type</span>
            <span class="prt-seg"><button type="button" data-tch="sms" class="${isE ? "" : "is-on"}">SMS</button>
              <button type="button" data-tch="email" class="${isE ? "is-on" : ""}">Email</button></span>
            <label class="fe-check"><input type="checkbox" data-t="on"${t.on !== false ? " checked" : ""} /> Show it to staff</label></div>
          <span class="lh-label">Suggest it when the prospect is</span>
          <div class="prt-sits">${sitKeys.map((k) => `<label class="prt-sit"><input type="checkbox" data-t="sit" value="${esc(k)}"${
            t.situations.includes(k) ? " checked" : ""} /><span>${esc(sits[k])}</span></label>`).join("")}</div>
          ${isE ? `<label class="lh-field"><span class="lh-label">Subject</span>
              <input class="fe-input" data-t="subject" maxlength="200" value="${esc(t.subject || "")}" /></label>
            <span class="lh-label">Message</span>
            <div class="prt-tools"><button type="button" data-tcmd="bold"><b>B</b></button><button type="button" data-tcmd="italic"><i>I</i></button>
              <button type="button" data-tcmd="insertUnorderedList">• List</button><button type="button" data-tcmd="link">Link</button></div>
            <div class="prt-html fe-input" contenteditable="true" data-t="html">${t.body || ""}</div>`
          : `<label class="lh-field"><span class="lh-label">Message</span>
              <textarea class="fe-input" data-t="text" rows="5" maxlength="560">${esc(t.body || "")}</textarea></label>
            <small class="muted" data-role="smscount"></small>`}
          <div class="prt-tokens"><span class="lh-label">Insert</span>${tokens.map((x) =>
            `<button type="button" class="prs-chip" data-token="${esc(x)}">{${esc(x)}}</button>`).join("")}</div>
          <p class="prs-help">Blanks are filled in for each prospect. In a text, a blank with nothing to fill is left out.
            For an offer or promotion, end with "Reply STOP to opt out".</p>
          <button type="button" class="lh-btn is-quiet prt-del" data-tdel>Delete this template</button>`;
        if (!isE) countSms();
      }
      function insertToken(tok) {
        const txt = `{${tok}}`;
        const el = lastField || q('[data-t="text"], [data-t="html"]');
        if (!el) return;
        if (el.isContentEditable) { el.focus(); document.execCommand("insertText", false, txt); return; }
        const s = el.selectionStart ?? el.value.length;
        const e2 = el.selectionEnd ?? s;
        el.value = el.value.slice(0, s) + txt + el.value.slice(e2);
        el.focus();
        el.setSelectionRange(s + txt.length, s + txt.length);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      Object.assign(ui, { commit, drawList, drawEdit, pick: (i) => { cur = i; drawList(); drawEdit(); } });

      f.addEventListener("mousedown", (e) => { if (e.target.closest("[data-tcmd], [data-token]")) e.preventDefault(); });   // keeps the cursor where it was
      f.addEventListener("focusin", (e) => { if (e.target.matches('[data-t="subject"], [data-t="text"], [data-t="html"]')) lastField = e.target; });
      f.addEventListener("input", (e) => {
        if (e.target.matches('[data-t="text"]')) countSms();
        if (e.target.matches('[data-t="name"]') && list[cur]) { list[cur].name = e.target.value; drawList(); }
      });
      f.addEventListener("change", (e) => { if (e.target.matches('[data-t="sit"], [data-t="on"]')) { commit(); drawList(); } });
      f.addEventListener("paste", (e) => {
        if (!e.target.closest('[data-t="html"]')) return;
        e.preventDefault();
        document.execCommand("insertText", false, (e.clipboardData || window.clipboardData).getData("text/plain"));
      });
      f.addEventListener("click", (e) => {
        const pk = e.target.closest("[data-tpick]");
        if (pk) { commit(); ui.pick(Number(pk.dataset.tpick)); return; }
        const nw = e.target.closest("[data-tnew]");
        if (nw) {
          commit();
          list.push({ id: "", name: "", channel: nw.dataset.tnew, situations: ["any"], subject: "", body: "", on: true });
          ui.pick(list.length - 1);
          q('[data-t="name"]').focus();
          return;
        }
        const ch = e.target.closest("[data-tch]");
        if (ch && list[cur] && list[cur].channel !== ch.dataset.tch) {
          commit();
          const t = list[cur];
          if (ch.dataset.tch === "email") {   // the text becomes paragraphs
            t.body = String(t.body || "").split(/\n{2,}/).filter((x) => x.trim())
              .map((x) => `<p>${esc(x.trim()).replace(/\n/g, "<br>")}</p>`).join("");
          } else {                            // the email becomes plain text
            const tmp = document.createElement("div");
            tmp.innerHTML = t.body || "";
            t.body = tmp.innerText.replace(/\n{3,}/g, "\n\n").trim().slice(0, 560);
          }
          t.channel = ch.dataset.tch;
          drawList(); drawEdit();
          return;
        }
        if (e.target.closest("[data-tdel]")) {
          if (!confirm(`Delete "${list[cur].name || "this template"}"? It goes when you press Save templates.`)) return;
          list.splice(cur, 1);
          ui.pick(Math.min(cur, list.length - 1));
          return;
        }
        const cmd = e.target.closest("[data-tcmd]");
        if (cmd) {
          const ed = q('[data-t="html"]');
          ed.focus();
          if (cmd.dataset.tcmd === "link") {
            let url = prompt("Link address (https://…)", "https://");
            if (!url) return;
            url = url.trim();
            if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
            document.execCommand("createLink", false, url);
          } else document.execCommand(cmd.dataset.tcmd, false, null);
          return;
        }
        const tk = e.target.closest("[data-token]");
        if (tk) insertToken(tk.dataset.token);
      });
      drawList();
      drawEdit();
    },
    onSubmit: async (c) => {
      ui.commit();
      const empty = (t) => !(t.channel === "email" ? String(t.body || "").replace(/<[^>]*>/g, "").trim() : String(t.body || "").trim());
      const bad = list.findIndex((t) => !t.name || empty(t) || (t.channel === "email" && !String(t.subject || "").trim()));
      if (bad >= 0) {
        const t = list[bad];
        ui.pick(bad);
        c.fail(!t.name ? "Give this template a name." : t.channel === "email" && !String(t.subject || "").trim()
          ? `Add a subject to "${t.name}".` : `Write the message for "${t.name}".`);
        return;
      }
      const r = await api("saveTemplates", {
        templates: list.map(({ id, name, channel, situations, subject, body, on }) => ({ id, name, channel, situations, subject, body, on })),
      });
      await loadSettings(true);
      c.close();
      const n = (r.templates || []).length;
      showToast(`${n} template${n === 1 ? "" : "s"} saved`);
      if (onSaved) onSaved(n);
    },
  });
}
/* ===================== One prospect ===================== */

async function mountProspect(container, id, staff) {
  const root = document.createElement("section");
  root.className = "page wide pr-page";
  container.replaceChildren(root);
  const work = can("prospects.work") || can("prospects.manage");
  let p = null;
  let set = {};
  root.innerHTML = `<a class="back-link" href="#/prospects">← Prospects</a><div class="skeleton" style="height:320px;border-radius:14px"></div>`;
  let fresh = null;   // the latest copy, read in the background when the board's copy was used
  try {
    const pre = justAdded.get(id);
    justAdded.delete(id);
    const quick = pre || (boardCache && boardCache.list.find((x) => x.id === id)) || null;
    if (quick) {
      p = quick;
      set = await loadSettings();
      if (!pre) fresh = getDoc(doc(db, "prospects", id));
    } else {
      const [snap, s] = await Promise.all([getDoc(doc(db, "prospects", id)), loadSettings()]);
      set = s;
      if (snap.exists()) p = tidyP({ id: snap.id, ...snap.data() });
    }
  } catch (err) { console.error("Prospect failed:", err); }
  if (!root.isConnected) return;
  if (!p) { root.innerHTML = `<a class="back-link" href="#/prospects">← Prospects</a><div class="state"><strong>Not found</strong>This prospect couldn't be opened.</div>`; return; }

  const save = async (op, data, msg) => {
    const r = await api(op, { id: p.id, ...data });
    p = r.prospect;
    render();
    if (msg) showToast(msg);
    return r;
  };

  // Quick saves: the page changes straight away and the save runs in the background, one after another
  // (so two quick changes never clash). If one doesn't save, you're told and the real record is loaded again.
  let queue = Promise.resolve();
  let pending = 0;
  let failed = false;
  let redraw = false;
  const meName = (staff && staff.name) || "You";
  const typing = () => { const a = document.activeElement; return !!a && root.contains(a) && a.matches("input, textarea, select"); };
  const draw = () => { if (typing()) redraw = true; else { redraw = false; render(); } };
  root.addEventListener("focusout", () => setTimeout(() => { if (redraw && !typing() && root.isConnected) { redraw = false; render(); } }, 0));
  window.addEventListener("beforeunload", (e) => { if (pending && root.isConnected) { e.preventDefault(); e.returnValue = ""; } });

  function saveFast(op, data, { patch = {}, log = null, msg = "" } = {}) {
    const at = new Date().toISOString();
    p = { ...p, ...patch, log: log ? [...(p.log || []), { at, by: meName, kind: log.kind, what: log.what, note: log.note || "", pending: true }] : p.log };
    render();
    if (msg) showToast(msg);
    pending++;
    const pid = p.id;
    queue = queue
      .then(() => api(op, { id: pid, ...data }))
      .then((r) => { if (r && r.prospect && pending === 1 && !failed) p = r.prospect; })
      .catch((err) => { console.error(`Prospect ${op} failed:`, err); failed = true; showToast(`${errText(err)} It wasn't saved.`); })
      .finally(async () => {
        pending--;
        if (!pending && failed) {
          failed = false;
          try { const s = await getDoc(doc(db, "prospects", pid)); if (s.exists()) p = tidyP({ id: s.id, ...s.data() }); } catch { /* keep what's shown */ }
        }
        if (root.isConnected && p.id === pid) draw();
      });
    return queue;
  }
  const contactPatch = () => {
    const at = new Date().toISOString();
    const x = { contacts: Number(p.contacts || 0) + 1, lastContactAt: at, waitingSince: "" };
    if (!p.firstContactAt) x.firstContactAt = at;
    if (p.stage === "new") Object.assign(x, { stage: "contacted", stageAt: at });
    return x;
  };
  const fuPatch = (d, note, tm) => ({ nextFollowUp: d, nextFollowUpTime: d ? (tm || "") : "", followNote: String(note || "").trim().slice(0, 300) });
  const fuStartTime = () => (fuStart(p.nextFollowUp) ? p.nextFollowUpTime || "" : "");
  const fuWhat = (d, tm) => (d ? `Follow up on ${fullDay(d)}${tm ? ` at ${hmText(tm)}` : ""}` : "Follow-up cleared");
  let hitsHtml = "", ptQ = "";
  // Their own source is always a choice, plus any typed in before
  const srcsHere = () => sourceList([p, ...((boardCache && boardCache.list) || [])]);

  function stepper() {
    const lost = p.stage === "lost";
    const cur = STAGES.findIndex((s) => s.key === p.stage);
    return `<ol class="pr-steps${lost ? " is-lost" : ""}">${STAGES.filter((s) => s.key !== "lost").map((s, i) => {
      const state = lost ? "todo" : i < cur ? "done" : i === cur ? "now" : "todo";
      return `<li class="is-${state}"><button type="button" ${work ? `data-stage="${s.key}"` : "disabled"} title="${work ? `Move to ${esc(s.name)}` : ""}">
        <span class="pr-dot">${state === "done" ? I(IC.check) : i + 1}</span><span>${esc(s.name)}</span></button></li>`;
    }).join("")}</ol>`;
  }

  function timeline() {
    const list = (p.log || []).slice().reverse();
    return `<section class="pr-sec"><h3>${I(IC.clock)} Timeline</h3>
      <ol class="pr-tl">${list.map((l) => `<li class="is-${esc(l.kind)}${l.pending ? " is-pending" : ""}">
        <span class="pr-tl-ic">${I(IC[KIND_IC[l.kind] || "note"])}</span>
        <div><strong>${esc(l.what)}</strong><small>${l.pending ? "Saving…" : esc([when(l.at), l.by].filter(Boolean).join(" · "))}</small>
          ${l.note ? `<p>${esc(l.note)}</p>` : ""}</div></li>`).join("")}</ol></section>`;
  }

  function render() {
    cacheUpsert(p);   // the board shows the change when you go back
    const s = stageOf(p.stage);
    const fs = followState(p);
    const late = notContacted(p, set);
    const tel = p.phone ? `tel:${String(p.phone).replace(/[^\d+]/g, "")}` : "";
    root.innerHTML = `
      <a class="back-link" href="#/prospects">← Prospects</a>
      <div class="pr-head">
        <span class="pr-head-av is-${s.tone}">${esc(initials(p.name))}</span>
        <div class="pr-head-main">
          <h2>${esc(p.name)}</h2>
          <p class="muted">${esc([p.concern, p.source, `enquired ${niceDay(keyOf(p.createdAt))}`].filter(Boolean).join(" · "))}${
            p.enquiryCount > 1 ? ` · <b>${p.enquiryCount} enquiries</b>` : ""}</p>
          <div class="pr-chips">
            ${p.phone ? `<a class="pr-chip" href="${esc(tel)}">${I(IC.phone)}${esc(p.phone)}</a>` : ""}
            ${p.email ? `<a class="pr-chip" href="mailto:${esc(p.email)}">${I(IC.mail)}${esc(p.email)}</a>` : ""}
            ${p.pref ? `<span class="pr-chip">Prefers ${esc(p.pref)}</span>` : ""}
            ${p.ageGroup ? `<span class="pr-chip">Age ${esc(p.ageGroup)}</span>` : ""}
            ${p.patientId ? `<a class="pr-chip is-pt" href="#/patient/${enc(p.patientId)}">${I(IC.user)}${isPast(p) ? "Past patient" : "Patient"}: ${esc(p.patientName)}</a>` : ""}
            ${onRecall(p) ? `<span class="pr-chip is-recall">${I(IC.clock)}On recall: ${esc(p.recall.category)}</span>` : ""}
            ${p.nextAppt ? `<span class="pr-chip">${I(IC.clock)}Next appointment ${esc(fullDay(p.nextAppt))}</span>` : ""}
            ${p.ads ? `<span class="pr-chip is-ad" title="${esc(adText(p.ads))}">${I(IC.link)}Google Ads${p.ads.keyword ? `: “${esc(p.ads.keyword)}”` : ""}</span>` : ""}
            ${(() => { const v = viaOfP(p); return showVia(p, v) ? `<span class="pr-chip is-via" title="${esc(viaText(v))}">${I(IC.link)}Found us: ${esc(v.name)}${
              v.land ? ` → ${esc(v.land)}` : ""}</span>` : ""; })()}
            ${p.historic ? '<span class="pr-tag">Older</span>' : ""}
          </div>
        </div>
        <span class="pr-pill is-${s.tone} is-lg">${esc(s.name)}</span>
      </div>
      ${p.stage === "lost" ? `<div class="pr-banner is-lost">${I(IC.flag)}<div><strong>Lost: ${esc(p.lostReason || "")}</strong>${
        p.lostNote ? `<small>${esc(p.lostNote)}</small>` : ""}${isJunk(p, set) ? "<small>Not a real enquiry: left out of the reports.</small>" : ""}</div>${work ? '<button type="button" class="lh-btn" data-stage="contacted">Reopen</button>' : ""}</div>` : ""}
      ${late ? `<div class="pr-banner is-bad">${I(IC.alert)}<div><strong>Not contacted yet</strong><small>They enquired ${esc(ago(p.waitingSince))}.</small></div></div>` : ""}
      ${cancelOpen(p) ? `<div class="pr-banner is-bad">${I(IC.alert)}<div><strong>${cancelWord(p)} on ${esc(fullDay(p.lastCancel.date))}, not rebooked yet</strong>${
        p.lastCancel.svcs && p.lastCancel.svcs.length ? `<small>${esc(p.lastCancel.svcs.join(", "))}</small>` : ""}</div></div>` : ""}
      ${noNextStep(p, set) ? `<div class="pr-banner is-warn">${I(IC.pause)}<div><strong>No next step</strong><small>Nothing booked, no follow-up,
        and nothing logged for ${idleDays(p)} days. Set a follow-up below, or mark them as lost.</small></div></div>` : ""}
      ${stepper()}
      ${work ? `<div class="pr-actions">
        ${tel ? `<a class="lh-btn" href="${esc(tel)}" data-act="call">${I(IC.phone)} Call</a>` : ""}
        <button type="button" class="lh-btn" data-act="log">${I(IC.phone)} Log a call</button>
        <button type="button" class="lh-btn" data-act="text"${p.phone ? "" : " disabled"}>${I(IC.text)} Send text</button>
        <button type="button" class="lh-btn" data-act="email"${p.email ? "" : " disabled"}>${I(IC.mail)} Send email</button>
        <button type="button" class="lh-btn" data-act="note">${I(IC.note)} Add note</button>
        ${p.stage !== "lost" ? `<button type="button" class="lh-btn is-quiet pr-lostbtn" data-act="lost">${I(IC.flag)} Mark as lost</button>` : ""}
      </div>` : ""}
      <div class="pr-grid">
        <div class="pr-main">
          <section class="pr-sec pr-follow is-${fs || "none"}"><h3>${I(IC.clock)} Next follow-up</h3>
            ${p.nextFollowUp ? `<p class="pr-follow-when"><strong>${esc(fuText(p))}</strong>${
              fs === "overdue" ? ' <span class="pr-tag is-bad">Overdue</span>' : fs === "today" ? ' <span class="pr-tag is-warn">Today</span>' : ""}</p>
              ${p.followNote ? `<p class="muted">${esc(p.followNote)}</p>` : ""}` : '<p class="muted">No follow-up set.</p>'}
            ${work && p.nextFollowUp ? `<div class="pr-row pr-fu-btns">
              <button type="button" class="lh-btn is-primary" data-act="fu-done">${I(IC.check)} Done</button>
              <button type="button" class="lh-btn is-quiet" data-act="fu-remove">Remove</button></div>` : ""}
            ${work ? `<form data-role="follow" novalidate>${followHtml(fuStart(p.nextFollowUp), p.followNote || "", fuStartTime())}
              <button type="submit" class="lh-btn${p.nextFollowUp ? "" : " is-primary"}">${p.nextFollowUp ? "Change follow-up" : "Save follow-up"}</button></form>` : ""}
          </section>
          ${timeline()}
        </div>
        <aside class="pr-side">
          <section class="pr-sec"><h3>${I(IC.inbox)} What they asked</h3>
            ${(p.enquiries || []).slice().reverse().map((q) => `<div class="pr-enq">
              <small>${esc(when(q.at))} · ${esc(q.source || "")}${q.concern ? ` · ${esc(q.concern)}` : ""}</small>
              ${(() => { const v = viaNorm(q.via); return v ? `<small class="pr-enq-via">Came from ${esc(v.name)}${v.land ? ` · landed on ${esc(v.land)}` : ""}${
                v.form && v.form !== v.land ? ` · sent the form on ${esc(v.form)}` : ""}${
                v.first && (v.first.name !== v.name || v.first.land !== v.land) ? ` · first found us through ${esc(v.first.name)}${v.first.land ? ` (${esc(v.first.land)})` : ""}` : ""}</small>` : ""; })()}
              ${q.message ? `<p>${esc(q.message)}</p>` : '<p class="muted">No message.</p>'}
              ${q.link ? `<a href="${esc(q.link)}" target="_blank" rel="noopener">Open the email</a>` : ""}</div>`).join("") || '<p class="muted">Nothing recorded.</p>'}
          </section>
          ${work ? `<section class="pr-sec"><h3>${I(IC.user)} Given to</h3>
            <div class="pr-row"><select class="fe-input" data-role="assign"><option>${esc(p.assignedToName || "Nobody yet")}</option></select></div></section>` : ""}
          <section class="pr-sec"><h3>${I(IC.link)} Patient record</h3>
            ${p.patientId ? `<p><a href="#/patient/${enc(p.patientId)}"><strong>${esc(p.patientName)}</strong></a>${
                p.wasPatient ? ' <span class="pr-tag is-pt">Already a patient when they enquired</span>' : ""}</p>
              ${p.prev ? `<p class="muted pr-small">${esc(prevText(p.prev))}.</p>` : ""}
              ${p.linkWeak ? `<p class="pr-warnline">${I(IC.alert)} Matched by name only. Check it's the same person.</p>` : ""}
              ${work ? `<div class="pr-row">${p.linkWeak ? '<button type="button" class="lh-btn" data-act="confirmlink">Yes, that\'s them</button>' : ""}
                <button type="button" class="lh-btn is-quiet" data-act="unlink">${p.linkWeak ? "Not them: unlink" : "Unlink"}</button></div>` : ""}`
              : `${p.patientMany > 1 ? `<p class="muted">${p.patientMany} patients could be them (same mobile, email or name). Choose the right one.</p>`
                : '<p class="muted">Not linked yet. They\'re linked by themselves when their mobile, email or full name matches one patient, or link them here.</p>'}
              ${work ? `<input type="search" class="fe-input" data-role="ptq" placeholder="Search the Patient List" value="${esc(ptQ || p.name)}" />
                <div class="pr-hits" data-role="hits"></div>` : ""}`}
          </section>
          ${onRecall(p) ? `<section class="pr-sec pr-recall"><h3>${I(IC.clock)} Also on recall</h3>
            <p><strong>${esc(p.recall.category)}</strong> · due ${esc(fullDay(p.recall.due))}${p.recall.status === "booked" ? " · booked" : ""}</p>
            <p class="muted pr-small">${p.recall.with ? `With ${esc(p.recall.with)} on the recall team.` : "Not given to anyone on the recall team yet."}${
              p.recall.more ? ` ${p.recall.more} more recall${p.recall.more === 1 ? "" : "s"} due.` : ""}
              The recall team can see they enquired. Agree who's calling them, so they only hear from one of you.</p>
            ${can("recall.work") || can("recall.manage") ? '<a class="lh-btn" href="#/recall">Open Recall</a>' : ""}</section>` : ""}
          ${p.plan && Array.isArray(p.plan.items) && p.plan.items.length ? `<section class="pr-sec"><h3>${I(IC.note)} Their treatment plan</h3>
            ${p.plan.at ? `<small class="muted">Made ${esc(fullDay(keyOf(p.plan.at)))}${p.plan.by ? ` by ${esc(p.plan.by)}` : ""}</small>` : ""}
            <ul class="pr-plan">${p.plan.items.map((x) => `<li><strong>${esc(x.treatment)}</strong>${
              x.concern ? ` <small class="muted">· ${esc(x.concern)}</small>` : ""}${x.quote ? `<span class="pr-plan-q">${esc(x.quote)}</span>` : ""}</li>`).join("")}</ul>
            ${p.patientId ? `<a href="#/patient/${enc(p.patientId)}">Open the full plan →</a>` : ""}</section>` : ""}
          ${p.patientId ? `<section class="pr-sec"><h3>${I(IC.flag)} Journey</h3>
            ${JOURNEY.some(([k]) => (p.milestones || {})[k]) || p.nextAppt || p.lastVisit || p.cancels ? `<dl class="pr-journey">
              ${JOURNEY.filter(([k]) => (p.milestones || {})[k]).map(([k, l]) =>
                `<div><dt>${esc(l)}</dt><dd>${esc(fullDay(p.milestones[k]))}</dd></div>`).join("")}
              ${p.lastVisit ? `<div><dt>Last visit</dt><dd>${esc(fullDay(p.lastVisit))}</dd></div>` : ""}
              ${p.nextAppt ? `<div><dt>Next appointment</dt><dd><strong>${esc(fullDay(p.nextAppt))}</strong></dd></div>` : ""}
              ${p.cancels ? `<div><dt>Cancelled or didn't come</dt><dd>${p.cancels} time${p.cancels === 1 ? "" : "s"} · last ${esc(fullDay(p.lastCancel && p.lastCancel.date))}${
                p.cancelOpen ? ' <span class="pr-tag is-bad">Not rebooked</span>' : ""}</dd></div>` : ""}
            </dl><small class="muted">From the appointment book, since they enquired. Updated after each PCN update.</small>`
              : '<p class="muted">No appointments since they enquired.</p>'}</section>` : ""}
          ${work ? `<section class="pr-sec"><h3>${I(IC.note)} Details</h3>
            <form data-role="details" novalidate class="pr-details">
              <label class="lh-field"><span class="lh-label">Name</span><input name="name" class="fe-input" value="${esc(p.name)}" /></label>
              <label class="lh-field"><span class="lh-label">Mobile</span><input name="phone" class="fe-input" value="${esc(p.phone || "")}" /></label>
              <label class="lh-field"><span class="lh-label">Email</span><input name="email" class="fe-input" value="${esc(p.email || "")}" /></label>
              <label class="lh-field"><span class="lh-label">Interested in</span><input name="concern" class="fe-input" value="${esc(p.concern || "")}" /></label>
              ${sourceField(srcsHere(), p.source)}
              <label class="lh-field"><span class="lh-label">Age group</span><select name="age" class="fe-input"><option value="">Not asked</option>${opts(AGES, p.ageGroup)}</select></label>
              <label class="lh-field"><span class="lh-label">Prefers</span><select name="pref" class="fe-input"><option value="">Not asked</option>${opts(PREFS, p.pref)}</select></label>
              <button type="submit" class="lh-btn">Save details</button>
            </form></section>` : ""}
        </aside>
      </div>`;
    if (work) {
      staffList().then((list) => {
        const sel = root.querySelector('[data-role="assign"]');
        if (!sel) return;
        sel.innerHTML = '<option value="">Nobody yet</option>' + list.map((s) =>
          `<option value="${esc(s.id)}"${s.id === p.assignedToId ? " selected" : ""}>${esc(s.name)}</option>`).join("");
      });
      if (!p.patientId) {
        const box = root.querySelector('[data-role="hits"]');
        if (box && hitsHtml) box.innerHTML = hitsHtml;
        else searchPt(ptQ || p.name);
      }
    }
  }

  let ptTimer = 0;
  async function searchPt(q) {
    const box = root.querySelector('[data-role="hits"]');
    if (!box) return;
    q = String(q || "").trim();
    if (q.length < 2) { box.innerHTML = hitsHtml = ""; return; }
    box.innerHTML = '<small class="muted">Searching…</small>';
    try {
      const list = await findPatients(q);
      hitsHtml = list.length ? list.map((x) => `<button type="button" class="pr-hit" data-link="${esc(x.id)}">
        <strong>${esc(x.name)}</strong><small>${esc([x.mobile, x.dob].filter(Boolean).join(" · "))}</small></button>`).join("")
        : '<small class="muted">No patients found.</small>';
    } catch (err) { hitsHtml = `<small class="muted">${esc(errText(err, "Couldn't search. Try again."))}</small>`; }
    const now = root.querySelector('[data-role="hits"]');
    if (now) now.innerHTML = hitsHtml;
  }
  
  function logDialog(outcome = "spoke") {
    openDialog({
      title: "Log a call", sub: p.phone ? `${p.name} · ${p.phone}` : p.name, submit: "Save",
      body: `<div class="pr-reasons">${OUTCOMES.map(([k, l]) =>
        `<label class="pr-reason"><input type="radio" name="outcome" value="${k}"${k === outcome ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>
        <label class="lh-field"><span class="lh-label">Note</span><textarea name="note" rows="3" maxlength="1000" class="fe-input" placeholder="What was said, what they want, when suits them"></textarea></label>
        ${followHtml(fuStart(p.nextFollowUp), p.followNote || "", fuStartTime())}`,
      onSubmit: async (c) => {
        const f = c.form.elements;
        const outcome = (c.form.querySelector('[name="outcome"]:checked') || {}).value;
        if (!outcome) { c.fail("Choose what happened."); return; }
        const fp = fuProblem(f.followUp.value, f.followTime.value);
        if (fp) { c.fail(fp); return; }
        c.close();
        saveFast("log", { outcome, note: f.note.value, followUp: f.followUp.value, followNote: f.followNote.value, followTime: f.followTime.value }, {
          patch: { ...contactPatch(), ...fuPatch(f.followUp.value, f.followNote.value, f.followTime.value) },
          log: { kind: "contact", what: (OUTCOMES.find(([k]) => k === outcome) || [, "Call"])[1], note: f.note.value.trim() },
          msg: "Saved",
        });
      },
    });
  }

  // The Email / Text window (prospect-compose.js)
  function openCompose(kind) {
    openProspectCompose({
      prospect: p,
      kind,
      myName: (staff && staff.name) || "",
      send: async ({ op, ...rest }) => {
        try { return await api(op, { id: p.id, ...rest }); }
        catch (err) { throw new Error(errText(err, "It wasn't sent. Try again.")); }
      },
      onSent: (np) => { if (np) { p = np; render(); } },
      toast: showToast,
      loadTemplates: () => api("templates", { id: p.id }),
    });
  }

  root.addEventListener("click", async (e) => {
    const qd = e.target.closest("[data-days]");
    if (qd) {
      const form = qd.closest("form");
      const dIn = form && form.querySelector('[name="followUp"]');
      const tIn = form && form.querySelector('[name="followTime"]');
      if (dIn) dIn.value = qd.dataset.days === "" ? "" : addDays(todayKey(), Number(qd.dataset.days));
      if (tIn && qd.dataset.days === "") tIn.value = "";
      return;
    }
    const hit = e.target.closest("[data-link]");
    if (hit) {
      hit.disabled = true;
      try { await save("link", { pttId: hit.dataset.link }, "Linked to the patient"); } catch (err) { showToast(errText(err)); hit.disabled = false; }
      return;
    }
    const sb = e.target.closest("[data-stage]");
    if (sb && work) {
      const to = sb.dataset.stage;
      if (to === p.stage) return;
      saveFast("stage", { stage: to }, {
        patch: { stage: to, stageAt: new Date().toISOString(), ...(to !== "new" ? { waitingSince: "" } : {}),
          ...(p.stage === "lost" ? { lostReason: "", lostNote: "" } : {}) },
        log: { kind: "stage", what: `${p.stage === "lost" ? "Reopened: " : "Moved to "}${stageOf(to).name}` },
        msg: stageOf(to).name,
      });
      return;
    }
    const a = e.target.closest("[data-act]");
    if (!a || !work) return;
    const act = a.dataset.act;
    if (act === "fu-done") {
      followDoneDialog(p, (d) => {
        const o = OUTCOMES.find(([k]) => k === d.outcome);
        saveFast("followDone", d, {
          patch: { ...(o ? contactPatch() : {}), ...fuPatch("", "", ""), ...(d.followUp ? fuPatch(d.followUp, d.followNote, d.followTime) : {}) },
          log: { kind: "follow", what: o ? `Follow-up done: ${o[1]}` : "Follow-up done", note: d.note.trim() },
          msg: "Follow-up done",
        });
      });
      return;
    }
    if (act === "fu-remove") {
      followRemoveDialog(p, (d) => saveFast("followUp", d, {
        patch: fuPatch("", "", ""), log: { kind: "follow", what: "Follow-up removed" }, msg: "Follow-up removed",
      }));
      return;
    }
    if (act === "call") setTimeout(() => logDialog("spoke"), 400);   // the phone opens, then the log
    if (act === "log") logDialog();
    if (act === "text" || act === "email") openCompose(act);
    if (act === "lost") lostDialog(p, set, (np) => { p = np; render(); });
    if (act === "unlink") { try { await save("link", { pttId: "" }, "Unlinked"); } catch (err) { showToast(errText(err)); } }
    if (act === "confirmlink") { try { await save("link", { pttId: p.patientId }, "Confirmed"); } catch (err) { showToast(errText(err)); } }
    if (act === "note") {
      openDialog({ title: "Add a note", submit: "Save note",
        body: '<label class="lh-field"><span class="lh-label">Note</span><textarea name="note" rows="4" maxlength="1000" class="fe-input"></textarea></label>',
        onOpen: (c) => c.form.elements.note.focus(),
        onSubmit: async (c) => {
          const note = c.form.elements.note.value.trim();
          if (!note) { c.fail("Write the note first."); return; }
          c.close();
          saveFast("log", { outcome: "note", note }, { log: { kind: "note", what: "Note", note }, msg: "Note saved" });
        } });
    }
  });

  root.addEventListener("change", async (e) => {
    if (e.target.dataset.role === "srcsel") { syncSourceOther(e.target); return; }
    if (e.target.dataset.role === "assign") {
      const v = e.target.value;
      const nm = v ? e.target.selectedOptions[0].textContent.trim() : "";
      e.target.blur();
      saveFast("assign", { toId: v }, {
        patch: { assignedToId: v, assignedToName: nm },
        log: { kind: "assign", what: v ? `Given to ${nm}` : "Not given to anyone" },
        msg: v ? `Given to ${nm}` : "Not given to anyone",
      });
    }
  });
  root.addEventListener("input", (e) => {
    if (e.target.dataset.role === "ptq") { ptQ = e.target.value; clearTimeout(ptTimer); ptTimer = setTimeout(() => searchPt(ptQ), 300); }
  });
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    if (form.dataset.role === "follow") {
      const d = f.followUp.value;
      const tm = f.followTime.value;
      const fp = fuProblem(d, tm);
      if (fp) { showToast(fp); return; }
      document.activeElement.blur();
      saveFast("followUp", { followUp: d, followNote: f.followNote.value, followTime: tm }, {
        patch: fuPatch(d, f.followNote.value, tm),
        log: { kind: "follow", what: fuWhat(d, tm), note: f.followNote.value.trim() },
        msg: "Follow-up saved",
      });
    }
    if (form.dataset.role === "details") {
      const name = f.name.value.trim();
      const email = f.email.value.trim();
      if (!name) { showToast("Add their name."); return; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast("Check the email address."); return; }
      const src = sourceValue(form, srcsHere());
      if (src.problem) { showToast(src.problem); f.sourceOther.focus(); return; }
      document.activeElement.blur();
      saveFast("update", { name, phone: f.phone.value, email, concern: f.concern.value, source: src.source, age: f.age.value, pref: f.pref.value }, {
        patch: { name, phone: f.phone.value.trim(), email: email.toLowerCase(), concern: f.concern.value.trim(),
          source: src.source, ageGroup: f.age.value, pref: f.pref.value },
        msg: "Details saved",
      });
    }
  });

  render();
  if (fresh) fresh.then((s) => {
    if (s.exists() && !pending && root.isConnected && p.id === id) { p = tidyP({ id: s.id, ...s.data() }); draw(); }
  }).catch(() => {});
}
/* ===================== Reports (#/prospects/reports) ===================== */
// Everything is worked out here from the prospects (current and older), so filters change instantly.

const REP_RANGES = [["30", "Last 30 days"], ["90", "Last 3 months"], ["180", "Last 6 months"], ["365", "Last 12 months"],
  ["all", "All time"], ["custom", "Choose dates"]];
const REP_KINDS = [["", "Everyone"], ["new", "New to the clinic"], ["past", "Past patients"], ["recall", "Also on recall"], ["booked", "Booked directly"]];
const ORDER = ["new", "contacted", "consult_booked", "consulted", "tx_booked", "treated", "active"];
const FUNNEL = ["Enquired", "Contacted", "Consultation booked", "Consulted", "Treatment booked", "Treated", "Active patient"];
const SPEED = [["Within 1 hour", 1], ["1 to 4 hours", 4], ["4 to 24 hours", 24], ["1 to 3 days", 72], ["Over 3 days", Infinity]];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const repDay = (k) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(k || "")) return ""; const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); };
const monthName = (m, withYear) => { const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString("en-AU", withYear ? { month: "short", year: "2-digit" } : { month: "short" }); };
const addMonths = (m, n) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const hrsText = (h) => (h == null ? "–" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
const PERTH_PARTS = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Perth", weekday: "short", hour: "2-digit", hourCycle: "h23" });
const whenParts = (iso) => {
  const o = {};
  PERTH_PARTS.formatToParts(new Date(iso)).forEach((x) => { o[x.type] = x.value; });
  return { d: DOW.indexOf(String(o.weekday || "").slice(0, 3)), h: Number(o.hour) % 24 };
};
// The furthest stage reached: 0 enquired … 6 active (the stage now, and the appointment book's dates)
function reachOf(p) {
  let i = p.stage === "lost" ? 0 : Math.max(0, ORDER.indexOf(p.stage));
  const m = p.milestones || {};
  ORDER.forEach((k, j) => { if (m[k]) i = Math.max(i, j); });
  if (i < 1 && (Number(p.contacts) > 0 || p.firstContactAt)) i = 1;
  return i;
}
const wasImported = (p) => (p.log || []).some((l) => l && l.what === "Imported from older emails");
const hoursToContact = (p) => (p.firstContactAt && p.createdAt ? (Date.parse(p.firstContactAt) - Date.parse(p.createdAt)) / 36e5 : null);
const daysToAppt = (p) => {
  const k = (p.milestones || {}).consult_booked;
  const d = k && p._day ? dayDiff(p._day, k) : null;
  return d !== null && d >= 0 ? d : null;
};
function groupBy(list, keyFn) {
  const g = new Map();
  list.forEach((p) => { const k = keyFn(p); if (!g.has(k)) g.set(k, []); g.get(k).push(p); });
  return [...g.entries()].map(([k, l]) => ({ k, l })).sort((a, b) => b.l.length - a.l.length);
}
const cellBar = (v) => `<span class="pr-cb"><i style="width:${v}%"></i></span>${v}%`;
function hbars(rows, empty = "Nothing in this period.") {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  const max = Math.max(1, ...rows.map((x) => x.n));
  return rows.map((x) => `<div class="pr-hb${x.tone ? ` is-${x.tone}` : ""}"><span class="pr-hb-l">${esc(x.label)}</span>
    <span class="pr-hb-t"><i style="width:${x.n ? Math.max(2, pct(x.n, max)) : 0}%"></i></span><b>${x.text ?? x.n}</b></div>`).join("");
}

function trendSvg(rows) {
  const W = 640, H = 230, L = 30, R = 36, T = 12, B = 28;
  const ih = H - T - B;
  const max = Math.max(1, ...rows.map((x) => x.n));
  const bw = (W - L - R) / Math.max(1, rows.length);
  const y = (v) => T + ih * (1 - v / max);
  const yp = (v) => T + ih * (1 - v / 100);
  const every = Math.ceil(rows.length / 12);
  const pts = rows.map((x, i) => [L + i * bw + bw / 2, yp(pct(x.booked, x.n))]);
  return `<svg class="pr-trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Enquiries, bookings and new patients by month">
    ${[0, 50, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${yp(v)}" y2="${yp(v)}" class="pr-t-grid"/>
      <text x="${W - R + 4}" y="${yp(v) + 4}" class="pr-t-ax">${v}%</text>`).join("")}
    <text x="${L - 4}" y="${y(max) + 4}" class="pr-t-ax" text-anchor="end">${max}</text>
    <text x="${L - 4}" y="${y(0) + 4}" class="pr-t-ax" text-anchor="end">0</text>
    ${rows.map((x, i) => {
      const x0 = L + i * bw + bw * 0.16;
      const w = bw * 0.68;
      return `<g><title>${monthName(x.m, true)}: ${x.n} enquiries · ${x.booked} booked (${pct(x.booked, x.n)}%) · ${x.treated} became patients</title>
        <rect x="${x0}" y="${y(x.n)}" width="${w}" height="${Math.max(0, H - B - y(x.n))}" rx="3" class="pr-t-all"/>
        <rect x="${x0}" y="${y(x.treated)}" width="${w}" height="${Math.max(0, H - B - y(x.treated))}" rx="3" class="pr-t-won"/>
        ${i % every === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 9}" text-anchor="middle" class="pr-t-ax">${
          monthName(x.m, i === 0 || x.m.endsWith("-01"))}</text>` : ""}</g>`;
    }).join("")}
    ${pts.length > 1 ? `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" class="pr-t-line"/>` : ""}
    ${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" class="pr-t-dot"/>`).join("")}
  </svg>`;
}

function funnelHtml(list) {
  const c = FUNNEL.map((_, i) => list.filter((p) => p._reach >= i).length);
  return `<div class="pr-fn">${FUNNEL.map((name, i) => `<div class="pr-fn-row is-s${i}">
    <span class="pr-fn-l">${esc(name)}</span>
    <span class="pr-fn-t"><i style="width:${c[i] ? Math.max(2, pct(c[i], c[0])) : 0}%"></i></span>
    <span class="pr-fn-v"><b>${c[i]}</b> · ${pct(c[i], c[0])}%${i ? `<small>${pct(c[i], c[i - 1])}% of the step before</small>` : ""}</span>
  </div>`).join("")}</div>`;
}

function heatHtml(list) {
  const g = DOW.map(() => Array(12).fill(0));
  list.forEach((p) => { if (!p.createdAt) return; const w = whenParts(p.createdAt); if (w.d >= 0) g[w.d][Math.floor(w.h / 2)]++; });
  const max = Math.max(1, ...g.flat());
  const hr = (h) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`);
  return `<div class="pr-heat"><span></span>${g[0].map((_, i) => `<small>${i % 3 === 0 ? hr(i * 2) : ""}</small>`).join("")}
    ${g.map((row, d) => `<small>${DOW[d]}</small>${row.map((n, i) =>
      `<i title="${DOW[d]} ${hr(i * 2)} to ${hr((i * 2 + 2) % 24)}: ${n} enquir${n === 1 ? "y" : "ies"}" style="--a:${n ? (0.15 + 0.85 * n / max).toFixed(2) : 0}"></i>`).join("")}`).join("")}</div>`;
}

/* ---------- Better reports: helpers ---------- */
const REP_TABS = [["overview", "Overview"], ["conversion", "Conversion"], ["sources", "Sources & interests"],
  ["team", "Team & speed"], ["templates", "Templates"]];
// Clinic opening hours (Perth time), Monday to Sunday: [from hour, to hour], or null when closed. Change to match the clinic.
const CLINIC_OPEN = [[8, 18], [8, 18], [8, 18], [8, 18], [8, 18], [9, 14], null];
const BANDS = [["open", "During clinic hours"], ["evening", "Weekday evenings & early mornings"], ["weekend", "Weekends, outside opening hours"]];
function bandOf(iso) {
  const w = whenParts(iso);
  if (w.d < 0) return "";
  const o = CLINIC_OPEN[w.d];
  if (o && w.h >= o[0] && w.h < o[1]) return "open";
  return w.d >= 5 ? "weekend" : "evening";
}
// "Interested in" is typed freely: these group it (first match wins, so the order matters)
const INTERESTS = [
  ["Body sculpting", /\bfat\b|body|coolsculpt|trusculpt|vanquish|double chin/i],
  ["Wrinkle relaxer", /wrinkle|botox|dysport|xeomin|frown|crow'?s|forehead|\bwr\b|relaxer|masseter|jaw ?slim|grind/i],
  ["Filler", /filler|\blips?\b|cheek|\bchin\b|tear ?trough|radiesse|sculptra|volume/i],
  ["Skin boosters", /booster|profhilo|rejuran|polynucle|hydrat|skin quality/i],
  ["Acne & scarring", /acne|pimple|breakout|scar/i],
  ["Pigmentation", /pigment|melasma|sun ?spots?|freckle|age spots?|brown spots?/i],
  ["Redness & vascular", /\bred(ness)?\b|rosacea|vascular|\bveins?\b|capillar|flush/i],
  ["Skin tightening", /ulthera|tighten|\bsag|hifu|skin lift|laxity|jowl|loose skin/i],
  ["Laser & light", /laser|\bipl\b|\bbbl\b|\bopl\b|genesis|resurfac/i],
  ["Peels", /\bpeels?\b/i],
  ["Skin needling", /needl|dermaglow|restoraglow|collagen|\bprp\b/i],
  ["Hair", /\bhair\b|thinning/i],
  ["Skincare", /skin ?care|serum|cream|sunscreen|products?|skin script/i],
  ["General enquiry", /consult|general|other|query|enquir|not sure|advice|price|cost/i],
];
const interestOf = (p) => {
  const c = String(p.concern || "").trim();
  if (!c) return "Not given";
  const hit = INTERESTS.find(([, re]) => re.test(c));
  return hit ? hit[0] : "Other";
};
// The date they reached a stage: the appointment book's date, or when staff moved them there
function reachDate(p, k) {
  const m = p.milestones || {};
  if (m[k]) return m[k];
  const i = ORDER.indexOf(k);
  const cur = p.stage === "lost" ? -1 : ORDER.indexOf(p.stage);
  return i >= 0 && cur >= i && p.stageAt ? keyOf(p.stageAt) : "";
}
const money = (n) => (n == null || !isFinite(n) ? "–" : `$${Math.round(n).toLocaleString("en-AU")}`);

// Messages sent from a template (the Timeline notes 'Text sent (template "…")'), and what happened next
function templateStats(list) {
  const m = new Map();
  list.forEach((p) => {
    const log = p.log || [];
    log.forEach((l, i) => {
      if (!l || !["text", "email"].includes(l.kind)) return;
      const mt = /\(template "([^"]+)"\)/.exec(l.what || "");
      const at = Date.parse(l.at || "");
      if (!mt || !at) return;
      const key = `${l.kind}|${mt[1]}`;
      if (!m.has(key)) m.set(key, { name: mt[1], kind: l.kind, sent: 0, people: new Set(), replied: 0, booked: 0, last: 0 });
      const x = m.get(key);
      x.sent++;
      x.people.add(p.id);
      x.last = Math.max(x.last, at);
      const later = log.slice(i + 1);
      const inWin = (r, days) => { const t = Date.parse(r.at || ""); return t > at && t <= at + days * 864e5; };
      if (later.some((r) => (r.kind === "enquiry" && /^(Replied|Another enquiry)/.test(r.what || "") && inWin(r, 7))
        || (r.kind === "contact" && /Spoke to them|Met in clinic/.test(r.what || "") && inWin(r, 7)))) x.replied++;
      if (later.some((r) => r.kind === "stage" && /(Consultation booked|Treatment booked|Consulted|Treated|Active patient)/.test(r.what || "")
        && inWin(r, 14))) x.booked++;
    });
  });
  return [...m.values()].sort((a, b) => b.sent - a.sent);
}

function prrCss() {
  if (document.getElementById("prr-css")) return;
  const s = document.createElement("style");
  s.id = "prr-css";
  s.textContent = `.prr{--prr-b:#e2e8f0;--prr-m:#64748b}
  .prr-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin:6px 0 14px}
  .prr-head h2{margin:0;font-family:Fraunces,Georgia,serif;font-weight:500;font-size:30px;color:#0f172a}
  .prr-head p{margin:4px 0 0;color:var(--prr-m);font-size:14px}
  .prr-bar{position:sticky;top:0;z-index:5;background:rgba(248,250,252,.94);backdrop-filter:blur(8px);border:1px solid var(--prr-b);
    border-radius:16px;padding:10px 12px;display:flex;flex-direction:column;gap:10px;margin-bottom:18px}
  .prr-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .prr-filters .fe-input{width:auto;min-width:140px}
  .prr-tabs{display:flex;gap:4px;overflow-x:auto;padding-bottom:2px}
  .prr-tab{border:0;background:transparent;padding:7px 15px;border-radius:999px;color:#475569;font-weight:600;font-size:14px;cursor:pointer;white-space:nowrap}
  .prr-tab:not(.is-on):hover{background:#e2e8f0}
  .prr-tab.is-on{background:#0f766e;color:#fff}
  .prr-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:18px}
  .prr-kpi{background:#fff;border:1px solid var(--prr-b);border-radius:16px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;
    box-shadow:0 1px 2px rgba(15,23,42,.04)}
  .prr-kpi-top{display:flex;align-items:center;gap:8px;color:var(--prr-m);font-size:13px;font-weight:600}
  .prr-kpi-ic{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:none}
  .prr-kpi-ic .pr-ic{width:16px;height:16px}
  .prr-kpi strong{font-size:30px;line-height:1.1;color:#0f172a;letter-spacing:-.01em}
  .prr-kpi small{color:var(--prr-m);font-size:12px}
  .prr-t-sky{background:#e0f2fe;color:#0369a1}.prr-t-amber{background:#fef3c7;color:#b45309}.prr-t-green{background:#dcfce7;color:#15803d}
  .prr-t-teal{background:#ccfbf1;color:#0f766e}.prr-t-violet{background:#ede9fe;color:#6d28d9}.prr-t-slate{background:#f1f5f9;color:#475569}
  .prr-t-rose{background:#ffe4e6;color:#be123c}
  .prr-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
  @media(max-width:900px){.prr-grid{grid-template-columns:1fr}}
  .prr-card{background:#fff;border:1px solid var(--prr-b);border-radius:16px;padding:16px 18px;box-shadow:0 1px 2px rgba(15,23,42,.04);min-width:0}
  .prr-card.is-wide{grid-column:1/-1}
  .prr-card h3{margin:0 0 2px;font-size:16px;color:#0f172a}
  .prr-sub{margin:0 0 12px;color:var(--prr-m);font-size:13px}
  .prr-note{margin:10px 0 0;color:var(--prr-m);font-size:12px}
  .prr-winrow{display:grid;grid-template-columns:190px 1fr;gap:12px;align-items:center;margin-bottom:12px}
  @media(max-width:640px){.prr-winrow{grid-template-columns:1fr}}
  .prr-winlbl{font-weight:600;color:#334155}
  .prr-wins{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .prr-win{border:1px solid var(--prr-b);border-radius:12px;padding:10px 12px;text-align:center;background:#f8fafc}
  .prr-win b{display:block;font-size:26px;color:#0f766e;line-height:1.15}
  .prr-win span{font-size:12px;color:#475569}
  .prr-win em{display:block;font-style:normal;font-size:11px;margin-top:2px;color:var(--prr-m)}
  .prr-curve{width:100%;height:auto;display:block}
  .prr-curve .ax{fill:#94a3b8;font-size:11px}.prr-curve .gr{stroke:#e2e8f0}
  .prr-curve .l1{fill:none;stroke:#38bdf8;stroke-width:2.5;stroke-linejoin:round}
  .prr-curve .l2{fill:none;stroke:#0f766e;stroke-width:2.5;stroke-linejoin:round}
  .prr-curve .t1{fill:#0369a1;font-size:12px;font-weight:700}.prr-curve .t2{fill:#0f766e;font-size:12px;font-weight:700}
  .prr-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--prr-m);margin:0 0 8px;padding:0;list-style:none}
  .prr-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
  .prr-pipe{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:4px 0 12px}
  .prr-pipe b{font-size:34px;color:#0f766e;line-height:1}
  .prr-pipe span{color:#334155}
  .prr-empty{padding:28px 10px;text-align:center;color:var(--prr-m);margin:0}
  .prr-ch{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .prr-ch.is-text{background:#e0f2fe;color:#075985}.prr-ch.is-email{background:#ede9fe;color:#5b21b6}`;
  document.head.appendChild(s);
}

/* ---------- The reports page ---------- */
async function mountReports(container, tabParam = "") {
  prrCss();
  const root = document.createElement("section");
  root.className = "page wide pr-page pr-rep prr";
  container.replaceChildren(root);
  const back = '<a class="back-link" href="#/prospects">← Prospects</a>';
  root.innerHTML = `${back}<div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  let all = [];
  let set = {};
  try { [all, set] = await Promise.all([loadAll(true), loadSettings()]); }
  catch (err) {
    console.error("Prospect reports failed:", err);
    root.innerHTML = `${back}<div class="state"><strong>Couldn't load the reports</strong>Check your connection and try again.</div>`;
    return;
  }
  if (!root.isConnected) return;

  const today = todayKey();
  all.forEach((p) => {
    p._day = keyOf(p.createdAt);
    p._reach = reachOf(p);
    p._imp = wasImported(p);
    p._int = interestOf(p);
    p._band = p.createdAt ? bandOf(p.createdAt) : "";
  });
  const firstDay = all.map((p) => p._day).filter(Boolean).sort()[0] || today;
  const sources = [...new Set(all.map((p) => p.source || "Other"))].sort();
  const people = [...new Set(all.map((p) => p.assignedToName).filter(Boolean))].sort();
  const st = { tab: REP_TABS.some(([k]) => k === tabParam) ? tabParam : "overview",
    range: "90", from: "", to: "", source: "", who: "", kind: "" };

  // Spend: from the patient records of prospects who became patients (loaded after the page shows)
  const spend = new Map();
  let spendState = "loading";

  const span = () => (st.range === "custom" ? [st.from || firstDay, st.to || today]
    : st.range === "all" ? [firstDay, today] : [addDays(today, -(Number(st.range) - 1)), today]);
  const keep = (p) => (!st.source || (p.source || "Other") === st.source)
    && (!st.who || (st.who === "-" ? !p.assignedToName : p.assignedToName === st.who))
    && showOf(st.kind)(p, set) && !isJunk(p, set);
  const cohort = (a, b) => all.filter((p) => p._day && p._day >= a && p._day <= b && keep(p));

  // Of those who enquired at least n days ago, how many reached the stage within n days
  function within(list, key, n) {
    const el = list.filter((p) => p._day && dayDiff(p._day, today) >= n);
    const hit = el.filter((p) => { const d = reachDate(p, key); if (!d) return false; const x = dayDiff(p._day, d); return x >= 0 && x <= n; }).length;
    return { n: el.length, hit, pct: el.length ? pct(hit, el.length) : null };
  }
  function stats(list) {
    const live = list.filter((p) => !p._imp && !p.fromBook);
    const hrs = live.map(hoursToContact).filter((h) => h != null && h >= 0);
    return {
      n: list.length,
      booked: list.filter((p) => p._reach >= 2).length,
      treated: list.filter((p) => p._reach >= 5).length,
      active: list.filter((p) => p._reach >= 6).length,
      lost: list.filter((p) => p.stage === "lost").length,
      live: live.length, hrs: median(hrs), fast: hrs.filter((h) => h <= hoursOf(set)).length,
      appt: median(list.filter((p) => !p.fromBook).map(daysToAppt).filter((d) => d != null)),
      everBooked: list.filter((p) => p._reach >= 2 || Number(p.cancels) > 0).length,
      cancelled: list.filter((p) => Number(p.cancels) > 0).length,
      cancelOpen: list.filter((p) => p.cancelOpen === true).length,
    };
  }
  const spendOfList = (l) => {
    const x = l.filter((p) => p._reach >= 5 && !isPast(p) && p.patientId && spend.has(p.patientId));
    return { n: x.length, total: x.reduce((t, p) => t + spend.get(p.patientId).all, 0) };
  };
  const spendCell = (l) => (spendState === "ok" ? money(spendOfList(l).total)
    : spendState === "loading" ? '<span class="muted">…</span>' : "–");

  const delta = (now, was, kind, upGood = true) => {
    if (now == null || was == null) return "";
    const d = kind === "pts" ? now - was : was ? ((now - was) / was) * 100 : null;
    if (d == null || !isFinite(d)) return "";
    if (Math.round(d) === 0) return '<span class="pr-delta">No change</span>';
    return `<span class="pr-delta ${(d > 0) === upGood ? "is-up" : "is-down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(Math.round(d))}${kind === "pts" ? " pts" : "%"}</span>`;
  };
  const kpi = (ic, tone, label, big, sub, d = "") => `<div class="prr-kpi">
    <div class="prr-kpi-top"><span class="prr-kpi-ic prr-t-${tone}">${I(IC[ic])}</span>${esc(label)}</div>
    <strong>${big}</strong><small>${sub}</small>${d}</div>`;
  const card = (title, sub, inner, wide = false) => `<section class="prr-card${wide ? " is-wide" : ""}">
    <h3>${esc(title)}</h3>${sub ? `<p class="prr-sub">${sub}</p>` : ""}${inner}</section>`;

  function convTable(groups, first) {
    if (!groups.length) return '<p class="prr-empty">Nothing in this period.</p>';
    return `<div class="pr-rt-wrap"><table class="pr-rtable"><thead><tr><th>${esc(first)}</th><th>Enquiries</th>
      <th>Booked a consult</th><th>Treated within 90 days</th><th>Became patients</th><th>Lost</th><th>Spend (new patients)</th>
      </tr></thead><tbody>${groups.map(({ k, l }) => {
        const x = stats(l);
        const w = within(l, "treated", 90);
        return `<tr><td data-label="${esc(first)}"><strong>${esc(k)}</strong></td><td data-label="Enquiries">${x.n}</td>
          <td data-label="Booked a consult">${cellBar(pct(x.booked, x.n))}</td>
          <td data-label="Treated within 90 days">${w.n ? `${cellBar(w.pct)} <small class="muted">of ${w.n}</small>` : '<span class="muted">Too recent</span>'}</td>
          <td data-label="Became patients">${cellBar(pct(x.treated, x.n))}</td>
          <td data-label="Lost">${pct(x.lost, x.n)}%</td>
          <td data-label="Spend (new patients)">${spendCell(l)}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  // What the open prospects should bring, from what happened to people who enquired over 4 months ago
  function pipeline() {
    const settled = all.filter((p) => p._day && dayDiff(p._day, today) >= 120 && !isJunk(p, set));
    const rate = ORDER.slice(0, 5).map((k, i) => {
      const reached = settled.filter((p) => p._reach >= i);
      return reached.length >= 10 ? reached.filter((p) => p._reach >= 5).length / reached.length : null;
    });
    const open = all.filter((p) => !p.historic && ORDER.slice(0, 5).includes(p.stage) && keep(p));
    let exp = 0;
    const rows = ORDER.slice(0, 5).map((k, i) => {
      const n = open.filter((p) => p.stage === k).length;
      if (rate[i] != null) exp += n * rate[i];
      return { k, n, r: rate[i] };
    });
    const newPts = all.filter((p) => p._reach >= 5 && !isPast(p) && p.patientId && spend.has(p.patientId));
    const avg = newPts.length >= 5 ? newPts.reduce((t, p) => t + spend.get(p.patientId).m12, 0) / newPts.length : null;
    return { rows, exp, avg, open: open.length, settled: settled.length };
  }

  function curveSvg(list) {
    const W = 640, H = 240, L = 42, R = 16, T = 14, B = 30, STEP = 5, MAXD = 180;
    const lines = [[], []];
    for (let d = 0; d <= MAXD; d += STEP) {
      const el = list.filter((p) => p._day && dayDiff(p._day, today) >= d);
      if (el.length < 8) break;
      ["consulted", "treated"].forEach((k, j) => {
        const hit = el.filter((p) => { const x = reachDate(p, k); const dd = x ? dayDiff(p._day, x) : -1; return dd >= 0 && dd <= d; }).length;
        lines[j].push([d, (hit / el.length) * 100]);
      });
    }
    if (lines[0].length < 3) return '<p class="prr-empty">Not enough enquiries old enough yet. Choose a longer date range.</p>';
    const lastD = lines[0][lines[0].length - 1][0];
    const top = Math.min(100, Math.max(10, Math.ceil(Math.max(...lines.flat().map((v) => v[1])) / 10) * 10));
    const x = (d) => L + ((W - L - R) * d) / lastD;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const grid = [0, top / 2, top].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gr"/>
      <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${Math.round(v)}%</text>`).join("");
    const xs = [];
    for (let d = 0; d <= lastD; d += 30) xs.push(`<text x="${x(d)}" y="${H - 8}" text-anchor="middle" class="ax">${d ? `${d} days` : "Enquired"}</text>`);
    const path = (pts, cls) => `<polyline class="${cls}" points="${pts.map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`;
    const end = (pts, cls) => { const [d, v] = pts[pts.length - 1]; return `<text x="${x(d) - 4}" y="${y(v) - 8}" text-anchor="end" class="${cls}">${Math.round(v)}%</text>`; };
    return `<svg class="prr-curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="How conversion builds up after an enquiry">
      ${grid}${xs.join("")}${path(lines[0], "l1")}${path(lines[1], "l2")}${end(lines[0], "t1")}${end(lines[1], "t2")}</svg>`;
  }

  /* ---------- The tabs ---------- */
  function tabOverview(c) {
    const { list, s, ps, prevList, a, b } = c;
    const w90 = within(list, "treated", 90);
    const pw90 = prevList ? within(prevList, "treated", 90) : null;
    const sp = spendOfList(list);
    const lostTop = groupBy(list.filter((p) => p.stage === "lost"), (p) => p.lostReason || "No reason")[0];

    let m0 = a.slice(0, 7);
    const m1 = b.slice(0, 7);
    if (addMonths(m0, 5) > m1) m0 = addMonths(m1, -5);
    const months = [];
    for (let m = m0; m <= m1 && months.length < 60; m = addMonths(m, 1)) months.push(m);
    const trend = months.slice(-36).map((m) => {
      const l = all.filter((p) => p._day && p._day.startsWith(m) && keep(p));
      return { m, n: l.length, booked: l.filter((p) => p._reach >= 2).length, treated: l.filter((p) => p._reach >= 5).length };
    });

    const open = all.filter((p) => !p.historic && OPEN.includes(p.stage) && keep(p));
    const nowMs = Date.now();
    const pipe = STAGES.filter((x) => OPEN.includes(x.key)).map((x) => {
      const l = open.filter((p) => p.stage === x.key);
      const stuck = l.filter((p) => nowMs - Date.parse(p.stageAt || p.createdAt || "") > 14 * 864e5).length;
      return { label: x.name, n: l.length, tone: x.tone, text: `${l.length}${stuck ? ` <small class="is-warn">${stuck} over 14 days</small>` : ""}` };
    });
    const pl = pipeline();
    const plHtml = `<div class="prr-pipe"><b>${Math.round(pl.exp)}</b><span>new patients expected from ${pl.open} open prospect${pl.open === 1 ? "" : "s"}${
        pl.avg != null && spendState === "ok" ? `, worth about <strong>${money(pl.exp * pl.avg)}</strong> a year` : ""}</span></div>
      ${hbars(pl.rows.filter((x) => x.n).map((x) => ({ label: stageOf(x.k).name, n: x.n, tone: stageOf(x.k).tone,
        text: `${x.n} <small>${x.r == null ? "not enough history yet" : `${Math.round(x.r * 100)}% usually become patients`}</small>` })), "No open prospects.")}
      <p class="prr-note">Based on what happened to the ${pl.settled} people who enquired over 4 months ago${
        pl.avg != null && spendState === "ok" ? `. A new patient spends about ${money(pl.avg)} a year` : ""}.</p>`;

    return `<div class="prr-kpis">
        ${kpi("inbox", "sky", "Enquiries", s.n, `${s.live} since the dashboard started`, delta(s.n, ps && ps.n, "%"))}
        ${kpi("clock", "amber", "Booked a consultation", `${pct(s.booked, s.n)}%`, `${s.booked} people`,
          delta(pct(s.booked, s.n), ps ? pct(ps.booked, ps.n) : null, "pts"))}
        ${kpi("trophy", "green", "Treated within 90 days", w90.n ? `${w90.pct}%` : "–",
          w90.n ? `${w90.hit} of ${w90.n} who enquired 90+ days ago` : "These enquiries are too recent", delta(w90.pct, pw90 && pw90.pct, "pts"))}
        ${kpi("chart", "teal", "Spend from new patients", spendState === "ok" ? money(sp.total) : spendState === "loading" ? "…" : "–",
          spendState === "ok" ? `${sp.n} new patient${sp.n === 1 ? "" : "s"} · all time` : spendState === "denied" ? "Needs Patient List access" : "Loading…")}
        ${kpi("phone", "violet", "First contact", hrsText(s.hrs), `${pct(s.fast, s.live)}% within ${hoursOf(set)} hours`, delta(s.hrs, ps && ps.hrs, "%", false))}
        ${kpi("flag", "slate", "Lost", `${pct(s.lost, s.n)}%`, lostTop ? `Mostly: ${esc(lostTop.k)}` : "None lost",
          delta(pct(s.lost, s.n), ps ? pct(ps.lost, ps.n) : null, "pts", false))}
      </div>
      <div class="prr-grid">
        ${card("Enquiries by month", "", `<ul class="pr-legend"><li><i class="is-all"></i>Enquiries</li><li><i class="is-won"></i>Became patients</li>
          <li><i class="is-line"></i>Booked a consultation (%)</li></ul>${trendSvg(trend)}`, true)}
        ${card("From enquiry to patient", "Everyone who enquired in this period, and how far they've got.", funnelHtml(list))}
        ${card("Expected from the open prospects", "Today's board, whatever dates are chosen.", plHtml)}
        ${card("Open prospects now", "", `${hbars(pipe, "No open prospects.")}
          <p class="prr-note">${open.filter((p) => notContacted(p, set)).length} not contacted in ${hoursOf(set)} hours ·
          ${open.filter((p) => followState(p) === "overdue").length} follow-ups overdue.</p>`, true)}
      </div>`;
  }

  function tabConversion(c) {
    const { list, s, ps } = c;
    const winsHtml = [["consulted", "Came in for a first visit"], ["treated", "Had a first treatment"]].map(([k, l]) =>
      `<div class="prr-winrow"><span class="prr-winlbl">${l}</span><div class="prr-wins">${[30, 60, 90].map((n) => {
        const w = within(list, k, n);
        return `<div class="prr-win"><b>${w.n ? `${w.pct}%` : "–"}</b><span>within ${n} days</span>
          <em>${w.n ? `${w.hit} of ${w.n}` : "too recent"}</em></div>`;
      }).join("")}</div></div>`).join("");
    const linked = list.filter((p) => p.patientId);
    const oldPt = linked.filter((p) => p.wasPatient).length;
    const newPt = linked.length - oldPt;
    const none = list.length - linked.length;
    const seg = (n, cls, label) => (n ? `<i class="${cls}" style="flex:${n}" title="${esc(label)}: ${n}"></i>` : "");
    const lost = groupBy(list.filter((p) => p.stage === "lost"), (p) => p.lostReason || "No reason").map(({ k, l }) => ({ label: k, n: l.length, tone: "slate" }));
    return `<div class="prr-kpis">
        ${kpi("clock", "amber", "Enquiry to first appointment", s.appt == null ? "–" : `${Math.round(s.appt)} days`, "Middle value",
          delta(s.appt, ps && ps.appt, "%", false))}
        ${kpi("alert", "rose", "Cancelled after booking", `${pct(s.cancelled, s.everBooked)}%`, `${s.cancelOpen} not rebooked`,
          delta(pct(s.cancelled, s.everBooked), ps ? pct(ps.cancelled, ps.everBooked) : null, "pts", false))}
        ${kpi("trophy", "green", "Became patients", `${pct(s.treated, s.n)}%`, `${s.treated} treated so far`,
          delta(pct(s.treated, s.n), ps ? pct(ps.treated, ps.n) : null, "pts"))}
        ${kpi("user", "teal", "Active patients", `${pct(s.active, s.n)}%`, `${s.active} came back again`,
          delta(pct(s.active, s.n), ps ? pct(ps.active, ps.n) : null, "pts"))}
      </div>
      <div class="prr-grid">
        ${card("Fair conversion", "Each figure only counts people who enquired long enough ago, so recent enquiries don't pull it down.", winsHtml, true)}
        ${card("How conversion builds up after an enquiry", "", `<ul class="prr-legend">
          <li><i style="background:#38bdf8"></i>Came in for a first visit</li><li><i style="background:#0f766e"></i>Had a first treatment</li></ul>
          ${curveSvg(list)}<p class="prr-note">Where the lines flatten is roughly when people stop converting, a good time for a last follow-up.</p>`, true)}
        ${card("Booked, then cancelled", "", `${hbars([
          { label: "Cancelled, then rebooked", n: list.filter((p) => Number(p.cancels) > 0 && !p.cancelOpen).length, tone: "green" },
          { label: "Cancelled, not rebooked", n: list.filter((p) => p.cancelOpen === true && !(p.lastCancel && p.lastCancel.kind === "noshow")).length, tone: "orange" },
          { label: "Didn't come, not rebooked", n: list.filter((p) => p.cancelOpen === true && p.lastCancel && p.lastCancel.kind === "noshow").length, tone: "slate" },
        ].filter((x) => x.n), "No cancellations in this period. 👍")}
          <p class="prr-note">${list.filter((p) => cancelOpen(p)).length} still open on the board to call.</p>`)}
        ${card("New or existing patients", "", `<div class="pr-stack">${seg(newPt, "is-new", "New to the clinic")}${seg(oldPt, "is-old", "Already patients")}${seg(none, "is-none", "Not linked yet")}</div>
          <ul class="pr-legend"><li><i class="is-new"></i>New to the clinic: ${newPt}</li><li><i class="is-old"></i>Already patients: ${oldPt}</li>
            <li><i class="is-none"></i>Not linked yet: ${none}</li></ul>`)}
        ${card("Why they were lost", "", hbars(lost, "Nobody lost in this period. 👍"), true)}
      </div>`;
  }

  function tabSources(c) {
    const { list } = c;
    const found = groupBy(list.filter((p) => viaOfP(p)), (p) => viaOfP(p).name).map(({ k, l }) => ({
      label: k, n: l.length, tone: k === "Google search" ? "green" : "",
      text: `${l.length} <small>${pct(l.filter((p) => p._reach >= 5).length, l.length)}% became patients</small>` }));
    return `<div class="prr-grid">
      ${card("By source", "How they got in touch, and what that turned into.", convTable(groupBy(list, (p) => p.source || "Other"), "Source"), true)}
      ${card("By interest", "What they were interested in, grouped (e.g. Botox, anti-wrinkle and WR all count as Wrinkle relaxer).",
        convTable(groupBy(list, (p) => p._int), "Interest"), true)}
      ${card("How they found the website", "Web form enquiries since visit tracking started.", hbars(found, "No tracked web enquiries in this period yet."), true)}
    </div>`;
  }

  function tabTeam(c) {
    const { list } = c;
    const teamRows = groupBy(list, (p) => p.assignedToName || "Nobody yet").map(({ k, l }) => {
      const x = stats(l);
      const lv = l.filter((p) => !p._imp && !p.fromBook);
      return `<tr><td data-label="Team member"><strong>${esc(k)}</strong></td><td data-label="Prospects">${x.n}</td>
        <td data-label="Contacted">${lv.length ? cellBar(pct(lv.filter((p) => Number(p.contacts) > 0).length, lv.length)) : "–"}</td>
        <td data-label="First contact">${hrsText(x.hrs)}</td>
        <td data-label="Booked a consult">${cellBar(pct(x.booked, x.n))}</td><td data-label="Became patients">${cellBar(pct(x.treated, x.n))}</td>
        <td data-label="Lost">${pct(x.lost, x.n)}%</td><td data-label="Spend (new patients)">${spendCell(l)}</td></tr>`;
    }).join("");
    const live = list.filter((p) => !p._imp && !p.fromBook);
    const speed = SPEED.map(([label, max], i) => ({
      label, n: live.filter((p) => { const h = hoursToContact(p); return h != null && h >= 0 && h <= max && (i === 0 || h > SPEED[i - 1][1]); }).length,
    })).concat([{ label: "No contact logged", n: live.filter((p) => hoursToContact(p) == null).length, tone: "slate" }]);
    const bandRows = BANDS.map(([k, l]) => {
      const lv = live.filter((p) => p._band === k);
      const hrs = lv.map(hoursToContact).filter((h) => h != null && h >= 0);
      return `<tr><td data-label="When they enquired"><strong>${esc(l)}</strong></td><td data-label="Enquiries">${lv.length}</td>
        <td data-label="First contact">${hrsText(median(hrs))}</td>
        <td data-label="Contacted in time">${lv.length ? cellBar(pct(hrs.filter((h) => h <= hoursOf(set)).length, lv.length)) : "–"}</td>
        <td data-label="Became patients">${lv.length ? cellBar(pct(lv.filter((p) => p._reach >= 5).length, lv.length)) : "–"}</td></tr>`;
    }).join("");
    return `<div class="prr-grid">
      ${card("By team member", "", teamRows ? `<div class="pr-rt-wrap"><table class="pr-rtable"><thead><tr><th>Team member</th><th>Prospects</th>
        <th>Contacted</th><th>First contact</th><th>Booked a consult</th><th>Became patients</th><th>Lost</th><th>Spend (new patients)</th>
        </tr></thead><tbody>${teamRows}</tbody></table></div>` : '<p class="prr-empty">Nothing in this period.</p>', true)}
      ${card("How quickly they're contacted", "From the first call, text or email logged. Booked directly isn't counted.",
        hbars(speed.filter((x) => x.n), "No enquiries since the dashboard started."))}
      ${card("Contact speed by when they enquired", `"Contacted in time" means within ${hoursOf(set)} hours.`,
        `<div class="pr-rt-wrap"><table class="pr-rtable"><thead><tr><th>When they enquired</th><th>Enquiries</th><th>First contact</th>
          <th>Contacted in time</th><th>Became patients</th></tr></thead><tbody>${bandRows}</tbody></table></div>
          <p class="prr-note">Opening hours are set at the top of the reports code (CLINIC_OPEN).</p>`)}
      ${card("When enquiries come in", "Perth time. Darker means more enquiries, which helps decide who's on to reply.", heatHtml(list), true)}
    </div>`;
  }

  function tabTemplates(c) {
    const rows = templateStats(c.list);
    const body = rows.length ? `<div class="pr-rt-wrap"><table class="pr-rtable"><thead><tr><th>Template</th><th>Type</th><th>Sent</th>
        <th>People</th><th>Responded within 7 days</th><th>Booked within 14 days</th><th>Last used</th></tr></thead><tbody>${rows.map((x) => `<tr>
        <td data-label="Template"><strong>${esc(x.name)}</strong></td>
        <td data-label="Type"><span class="prr-ch is-${x.kind}">${x.kind === "email" ? "Email" : "SMS"}</span></td>
        <td data-label="Sent">${x.sent}</td><td data-label="People">${x.people.size}</td>
        <td data-label="Responded within 7 days">${cellBar(pct(x.replied, x.sent))}</td>
        <td data-label="Booked within 14 days">${cellBar(pct(x.booked, x.sent))}</td>
        <td data-label="Last used">${esc(repDay(keyOf(new Date(x.last).toISOString())))}</td></tr>`).join("")}</tbody></table></div>`
      : '<p class="prr-empty">No messages have been sent from a template in this period yet. Template use is recorded from now on.</p>';
    return `<div class="prr-grid">${card("How each template does",
      "Responded: they replied, enquired again, or a call was logged as spoken to them. Booked: they moved to a booked stage.", body, true)}</div>`;
  }

  /* ---------- Drawing ---------- */
  function draw() {
    const [a, b] = span();
    const len = dayDiff(a, b) + 1;
    const list = cohort(a, b);
    const prevList = st.range === "all" ? null : cohort(addDays(a, -len), addDays(a, -1));
    const s = stats(list);
    const ps = prevList ? stats(prevList) : null;
    const junkN = all.filter((p) => p._day && p._day >= a && p._day <= b && isJunk(p, set)).length;
    const c = { list, s, ps, prevList, a, b };
    const optsR = (l2, cur) => l2.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
    const body = st.tab === "conversion" ? tabConversion(c) : st.tab === "sources" ? tabSources(c)
      : st.tab === "team" ? tabTeam(c) : st.tab === "templates" ? tabTemplates(c) : tabOverview(c);

    root.innerHTML = `${back}
      <div class="prr-head">
        <div><h2>Prospect reports</h2>
          <p>Enquiries from ${esc(repDay(a))} to ${esc(repDay(b))} · ${s.n} ${s.n === 1 ? "person" : "people"}${
            ps ? ` · ▲▼ compared with the ${len} days before` : ""}${junkN ? ` · ${junkN} spam or test entr${junkN === 1 ? "y" : "ies"} left out` : ""}</p></div>
        <button type="button" class="lh-btn is-quiet" data-act="csv">Download CSV</button>
      </div>
      <div class="prr-bar">
        <div class="prr-filters">
          <select class="fe-input" data-r="range" aria-label="Dates">${optsR(REP_RANGES, st.range)}</select>
          ${st.range === "custom" ? `<input type="date" class="fe-input" data-r="from" value="${esc(st.from || a)}" max="${today}" aria-label="From" />
            <input type="date" class="fe-input" data-r="to" value="${esc(st.to || b)}" max="${today}" aria-label="To" />` : ""}
          <select class="fe-input" data-r="source" aria-label="Source"><option value="">All sources</option>${optsR(sources.map((x) => [x, x]), st.source)}</select>
          <select class="fe-input" data-r="who" aria-label="Team member"><option value="">Everyone</option>
            <option value="-"${st.who === "-" ? " selected" : ""}>Nobody yet</option>${optsR(people.map((x) => [x, x]), st.who)}</select>
          <select class="fe-input" data-r="kind" aria-label="Who">${optsR(REP_KINDS, st.kind)}</select>
        </div>
        <nav class="prr-tabs" role="tablist">${REP_TABS.map(([k, l]) =>
          `<button type="button" role="tab" class="prr-tab${st.tab === k ? " is-on" : ""}" aria-selected="${st.tab === k}" data-tab="${k}">${esc(l)}</button>`).join("")}</nav>
      </div>
      ${body}`;
  }

  function downloadCsv() {
    const [a, b] = span();
    const list = cohort(a, b);
    const head = ["Name", "Enquired", "Source", "Interested in", "Interest group", "Stage", "Given to", "Contacts", "First contact",
      "First appointment", "First treatment", "Active from", "Lost reason", "Cancelled", "Already a patient",
      "Past patient", "On recall", "Found us", "Spend (all time)"];
    const rows = list.map((p) => { const m = p.milestones || {}; return [p.name, p._day, p.source, p.concern, p._int, stageOf(p.stage).name,
      p.assignedToName, p.contacts || 0, p.firstContactAt ? keyOf(p.firstContactAt) : "", m.consult_booked || "", m.treated || "",
      m.active || "", p.lostReason || "", p.cancels ? `${p.cancels}${p.cancelOpen ? " (not rebooked)" : ""}` : "",
      p.wasPatient ? "Yes" : p.patientId ? "No" : "",
      p.prev ? `Yes, last visit ${p.prev.last}` : "",
      p.recall ? `${p.recall.category} (due ${p.recall.due})` : "",
      (() => { const v = viaOfP(p); return v ? `${v.name}${v.land ? ` → ${v.land}` : ""}` : ""; })(),
      p.patientId && spend.has(p.patientId) ? Math.round(spend.get(p.patientId).all) : ""]; });
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const blob = new Blob(["\ufeff" + [head, ...rows].map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `prospects-${a}-to-${b}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  root.addEventListener("change", (e) => {
    const k = e.target.dataset.r;
    if (!k) return;
    st[k] = e.target.value;
    if (k === "range" && st.range === "custom" && !st.from) { st.from = addDays(today, -89); st.to = today; }
    if ((k === "from" || k === "to") && st.from && st.to && st.from > st.to) {   // dates the wrong way round
      if (k === "from") st.to = st.from; else st.from = st.to;
    }
    draw();
  });
  root.addEventListener("click", (e) => {
    const tb = e.target.closest("[data-tab]");
    if (tb) {
      st.tab = tb.dataset.tab;
      history.replaceState(null, "", `#/prospects/reports/${st.tab}`);
      draw();
      return;
    }
    if (e.target.closest('[data-act="csv"]')) downloadCsv();
  });
  draw();

  // Spend for prospects who became patients, then draw again with it
  try {
    const ids = [...new Set(all.filter((p) => p.patientId && p._reach >= 5).map((p) => p.patientId))].slice(0, 800);
    for (let i = 0; i < ids.length; i += 40) {
      const snaps = await Promise.all(ids.slice(i, i + 40).map((id) => getDoc(doc(db, "patient_list", id))));
      snaps.forEach((sn) => {
        if (!sn.exists()) return;
        const sp = sn.data().Spend || {};
        spend.set(sn.id, { m12: Number(sp.m12) || 0, all: Number(sp.all) || 0 });
      });
      if (!root.isConnected) return;
    }
    spendState = "ok";
  } catch (err) {
    console.warn("Prospect reports: spend not read:", err);
    spendState = err && err.code === "permission-denied" ? "denied" : "failed";
  }
  if (root.isConnected) draw();
}