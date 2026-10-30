// Prospect Dashboard (#/prospects, #/prospects/list, #/prospects/<id>)
// People who've enquired but aren't patients yet: from web form emails, and added by hand.
// Read from Firestore; every change goes through Apps Script (action "prospects"), so it's logged on the prospect.
import { db, auth } from "./firebase-config.js";
import { collection, getDocs, getDoc, doc, query, orderBy, limit, where }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

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
const SOURCES = ["Web form", "Phone call", "Walk-in", "Online chat", "Instagram", "Facebook", "Referral", "Other"];
const AGES = ["Under 22", "22 to 30", "31 to 40", "41 to 50", "51 to 60", "Over 60"];
const PREFS = ["SMS", "Call", "Email"];
const OUTCOMES = [["spoke", "Spoke to them"], ["no_answer", "No answer"], ["voicemail", "Left voicemail"], ["met", "Met in clinic"]];
const stageOf = (k) => STAGES.find((s) => s.key === k) || STAGES[0];

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
  return r;
}
// Current prospects; the older enquiries (over 90 days, never worked) only when asked for
async function loadAll(withOld = false) {
  const qs = [getDocs(query(collection(db, "prospects"), where("historic", "==", false), limit(3000)))];
  if (withOld) qs.push(getDocs(query(collection(db, "prospects"), where("historic", "==", true), limit(5000))));
  const snaps = await Promise.all(qs);
  return snaps.flatMap((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })));
}
async function loadSettings() {
  try { const s = await getDoc(doc(db, "prospect_settings", "config")); return s.exists() ? s.data() : {}; }
  catch { return {}; }
}
let staffCache = null;
const staffList = () => (staffCache ||= callApi({ action: "staffList" }).then((r) => r.staff || []).catch(() => []));
const hoursOf = (set) => Math.max(1, Number(set.respondHours) || 24);
const notContacted = (p, set) => !!p.waitingSince && OPEN.includes(p.stage) && Date.now() - Date.parse(p.waitingSince) > hoursOf(set) * 3600000;
function followState(p) {
  if (!p.nextFollowUp || !OPEN.includes(p.stage)) return "";
  const t = todayKey();
  return p.nextFollowUp < t ? "overdue" : p.nextFollowUp === t ? "today" : "later";
}
// A follow-up date to start a form with: overdue ones are left blank (only today onwards can be saved)
const fuStart = (d, fallback = "") => (d && d >= todayKey() ? d : fallback);
// Booked, then cancelled or didn't come, and nothing booked since
const cancelOpen = (p) => p.cancelOpen === true && OPEN.includes(p.stage);
const cancelWord = (p) => (p.lastCancel && p.lastCancel.kind === "noshow" ? "Didn't come" : "Cancelled");
const isPast = (p) => p.wasPatient === true || !!p.prev;
const onRecall = (p) => !!(p.recall && p.recall.id);
const monthYear = (k) => { if (!/^\d{4}-\d{2}/.test(k || "")) return ""; const [y, m] = k.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "numeric" }); };
const prevText = (pv) => (pv ? `${pv.count} visit${pv.count === 1 ? "" : "s"} before they enquired, last on ${fullDay(pv.last)}${
  pv.svcs && pv.svcs.length ? ` (${pv.svcs.join(", ")})` : ""}${pv.staff ? ` with ${pv.staff}` : ""}` : "");
// The "Show" chips on the board, and the "Who" filter on the reports
const SHOW = [
  ["", "All", () => true],
  ["action", "Needs action", (p, set) => notContacted(p, set) || cancelOpen(p) || ["today", "overdue"].includes(followState(p))],
  ["new", "New to the clinic", (p) => !isPast(p)],
  ["past", "Past patients", isPast],
  ["recall", "Also on recall", onRecall],
  ["cancel", "Cancelled, not rebooked", (p) => cancelOpen(p)],
  ["nocontact", "Not contacted", (p, set) => notContacted(p, set)],
  ["follow", "Follow-ups due", (p) => ["today", "overdue"].includes(followState(p))],
  ["booked", "Booked directly", (p) => p.fromBook === true],
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
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try { await onSubmit(ctl); } catch (ex) { console.error(ex); ctl.fail(errText(ex)); }
  });
  dlg.showModal();
  if (onOpen) onOpen(ctl);
  return ctl;
}
const followHtml = (val = "", note = "") => `
  <div class="pr-fu">
    <span class="lh-label">Follow up on</span>
    <div class="pr-fu-row"><input type="date" name="followUp" value="${esc(val)}" min="${todayKey()}" class="fe-input" />
      <span class="pr-quick">${[["Tomorrow", 1], ["3 days", 3], ["1 week", 7], ["2 weeks", 14], ["None", ""]].map(([l, d]) =>
        `<button type="button" class="pr-chip-btn" data-days="${d}">${l}</button>`).join("")}</span></div>
    <input name="followNote" class="fe-input" maxlength="300" placeholder="What to follow up about (optional)" value="${esc(note)}" />
  </div>`;
const opts = (list, cur, blank = "") => (blank ? `<option value="">${esc(blank)}</option>` : "") +
  list.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`).join("");

/* ===================== Routes ===================== */

export function mountProspects(container, { param = "", staff = null } = {}) {
  const parts = String(param || "").split("/").filter(Boolean);
  if (parts[0] === "reports") { mountReports(container); return; }
  if (parts[0] && parts[0] !== "list") { mountProspect(container, decodeURIComponent(parts[0]), staff); return; }
  mountBoard(container, { view: parts[0] === "list" ? "list" : "board", staff });
}
/* ===================== The board and the list ===================== */

async function mountBoard(container, { view, staff }) {
  const root = document.createElement("section");
  root.className = "page wide pr-page";
  container.replaceChildren(root);
  const me = auth.currentUser && auth.currentUser.uid;
  const work = can("prospects.work") || can("prospects.manage");
  const st = { view, q: "", source: "", who: "all", show: "", range: "", from: "", to: "", showLost: false, old: false };
  let all = [];
  let set = {};
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
  try { [all, set] = await Promise.all([loadAll(), loadSettings()]); }
  catch (err) {
    console.error("Prospects failed:", err);
    root.innerHTML = `<div class="state"><strong>Couldn't load prospects</strong>${esc(err && err.code === "permission-denied"
      ? "Check the prospects Firestore rule has been published, and your Prospect access in Staff." : "Check your connection and try again.")}</div>`;
    return;
  }
  if (!root.isConnected) return;

  const t = todayKey();
  const month = t.slice(0, 7);
  const tiles = [
    { ic: "alert", n: all.filter((p) => notContacted(p, set)).length, l: `Not contacted in ${hoursOf(set)} hours`, tone: "bad", show: "nocontact" },
    { ic: "flag", n: all.filter(cancelOpen).length, l: "Cancelled, not rebooked", tone: "bad", show: "cancel" },
    { ic: "inbox", n: all.filter((p) => Date.now() - Date.parse(p.createdAt || "") < 7 * 864e5).length, l: "New enquiries this week", tone: "sky", range: "7" },
    { ic: "clock", n: all.filter((p) => ["today", "overdue"].includes(followState(p))).length, l: "Follow-ups due", tone: "amber", show: "follow" },
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
        <a class="lh-btn is-quiet" href="#/prospects/reports">${I(IC.chart)} Reports</a>
        ${can("prospects.manage") ? `<button type="button" class="lh-btn is-quiet" data-act="settings">${I(IC.gear)} Settings</button>` : ""}
        ${work ? `<button type="button" class="lh-btn is-primary" data-act="new">${I(IC.plus)} New prospect</button>` : ""}
      </div>
    </div>
    <div class="pr-tiles">${tiles.map(tileHtml).join("")}</div>
    <div class="pr-tools">
      <div class="fe-seg">${[["board", "Board"], ["list", "List"]].map(([v, l]) =>
        `<label class="fe-seg-btn"><input type="radio" name="pr-view" value="${v}"${st.view === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
      <input type="search" class="fe-input pr-q" data-role="q" placeholder="Search name, mobile, email or interest" />
      <select class="fe-input" data-role="range" aria-label="Enquired">${RANGES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>
      <span class="pr-dates" data-role="dates" hidden>
        <input type="date" class="fe-input" data-role="from" max="${t}" aria-label="From" /><span>to</span>
        <input type="date" class="fe-input" data-role="to" max="${t}" aria-label="To" /></span>
      <select class="fe-input" data-role="source"><option value="">All sources</option>${opts(srcList, "")}</select>
      <select class="fe-input" data-role="who"><option value="all">Everyone's</option><option value="me">Mine</option><option value="none">Not given to anyone</option></select>
      <button type="button" class="lh-btn is-quiet" data-act="old">Show older enquiries</button>
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
  const urgency = (p) => (notContacted(p, set) ? 0 : cancelOpen(p) ? 1 : followState(p) === "overdue" ? 2 : followState(p) === "today" ? 3 : 4);
  const byUrgency = (a, b) => urgency(a) - urgency(b) ||
    String(a.nextFollowUp || "9").localeCompare(String(b.nextFollowUp || "9")) ||
    String(b.lastEnquiryAt || "").localeCompare(String(a.lastEnquiryAt || ""));

  const typeTags = (p) => `${p.patientId ? (isPast(p)
      ? `<span class="pr-tag is-old" title="${esc(prevText(p.prev) || "Had a visit before they enquired")}">Past patient${p.prev && p.prev.last ? ` · last ${esc(monthYear(p.prev.last))}` : ""}</span>`
      : '<span class="pr-tag is-pt">Patient</span>') : ""}
    ${onRecall(p) ? `<span class="pr-tag is-recall" title="${esc(`${p.recall.category}, due ${fullDay(p.recall.due)}`)}">On recall</span>` : ""}`;

  const card = (p) => {
    const fs = followState(p);
    const late = notContacted(p, set);
    return `<a class="pr-card${late ? " is-late" : ""}" href="#/prospects/${enc(p.id)}" data-id="${esc(p.id)}" draggable="${work}">
      <span class="pr-card-top"><strong>${esc(p.name || "No name")}</strong>${p.assignedToName
        ? `<i class="pr-av" title="${esc(p.assignedToName)}">${esc(initials(p.assignedToName))}</i>` : ""}</span>
      ${p.concern ? `<small class="pr-card-concern">${esc(p.concern)}</small>` : ""}
      <span class="pr-tags">
        <span class="pr-tag">${esc(p.source || "Other")}</span>
        ${typeTags(p)}
        ${p.patientId && p.linkWeak ? '<span class="pr-tag is-warn">Check match</span>' : ""}
        ${p.nextAppt && OPEN.includes(p.stage) ? `<span class="pr-tag is-pt">Booked ${esc(niceDay(p.nextAppt))}</span>` : ""}
        ${late ? '<span class="pr-tag is-bad">Not contacted</span>' : ""}
        ${cancelOpen(p) ? `<span class="pr-tag is-bad">${cancelWord(p)}, not rebooked</span>` : ""}
        ${fs === "overdue" ? '<span class="pr-tag is-bad">Follow-up overdue</span>'
          : fs === "today" ? '<span class="pr-tag is-warn">Follow up today</span>'
          : fs === "later" ? `<span class="pr-tag">${esc(niceDay(p.nextFollowUp))}</span>` : ""}
        ${p.stage === "lost" && p.lostReason ? `<span class="pr-tag">${esc(p.lostReason)}</span>` : ""}
      </span>
      <span class="pr-card-foot"><small>${esc(ago(p.lastEnquiryAt || p.createdAt))}</small>${p.contacts
        ? `<small>${p.contacts} contact${p.contacts === 1 ? "" : "s"}</small>` : "<small>Not contacted</small>"}</span>
    </a>`;
  };

  function drawBody() {
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
            <td data-label="Follow up" class="${fs === "overdue" ? "is-bad" : fs === "today" ? "is-warn" : ""}">${esc(niceDay(p.nextFollowUp))}</td>
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
        <div class="pr-col-body">${items.map(card).join("") || '<p class="pr-col-empty">None</p>'}</div></section>`;
    }).join("")}</div>
    <button type="button" class="lh-btn is-quiet pr-lost-btn" data-act="lost">${st.showLost ? "Hide lost" : `Show lost (${lostN})`}</button>
    ${work ? '<p class="muted pr-hint">Drag a card to another column to move it along.</p>' : ""}`;
  }
  drawBody();

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

  const replace = (p) => { const i = all.findIndex((x) => x.id === p.id); if (i >= 0) all[i] = p; else all.unshift(p); drawBody(); };
  async function move(id, to) {
    const p = all.find((x) => x.id === id);
    if (!p || p.stage === to) return;
    if (to === "lost") { lostDialog(p, set, replace); return; }
    try {
      const r = await api("stage", { id, stage: to });
      replace(r.prospect);
      showToast(`${p.name}: ${stageOf(to).name}`);
    } catch (err) { showToast(errText(err)); }
  }

  root.addEventListener("change", (e) => {
    const r = e.target.dataset.role;
    if (e.target.name === "pr-view") { st.view = e.target.value; history.replaceState(null, "", st.view === "list" ? "#/prospects/list" : "#/prospects"); drawBody(); }
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
  root.addEventListener("input", (e) => { if (e.target.dataset.role === "q") { st.q = e.target.value.trim().toLowerCase(); drawBody(); } });
  root.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a")) { location.hash = tr.dataset.href; return; }
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
    if (a.dataset.act === "lost") { st.showLost = !st.showLost; drawBody(); }
    if (a.dataset.act === "old") setOld(!st.old);
    if (a.dataset.act === "new") newDialog(all, (id) => { location.hash = `#/prospects/${enc(id)}`; });
    if (a.dataset.act === "settings") settingsDialog(set, async () => { set = await loadSettings(); });
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
  let force = false;
  const ctl = openDialog({
    title: "New prospect", sub: "Someone who called, walked in, chatted online or messaged. Web form enquiries are added by themselves.",
    submit: "Add prospect",
    body: `
      <div class="pr-grid2">
        <label class="lh-field"><span class="lh-label">Full name</span><input name="name" class="fe-input" maxlength="120" required /></label>
        <label class="lh-field"><span class="lh-label">How they got in touch</span><select name="source" class="fe-input">${opts(SOURCES.filter((s) => !["Web form", "Booked directly"].includes(s)), "Phone call")}</select></label>
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
      const sel = c.form.querySelector('[data-role="staff"]');
      const list = await staffList();
      sel.innerHTML = '<option value="">Nobody yet</option>' + list.map((s) =>
        `<option value="${esc(s.id)}"${s.id === me ? " selected" : ""}>${esc(s.name)}${s.id === me ? " (me)" : ""}</option>`).join("");
      c.form.elements.name.focus();
    },
    onSubmit: async (c) => {
      const f = c.form.elements;
      const r = await api("add", {
        name: f.name.value, phone: f.phone.value, email: f.email.value, source: f.source.value, concern: f.concern.value,
        age: f.age.value, pref: f.pref.value, assignTo: f.assignTo.value, message: f.message.value,
        spoke: f.spoke.checked, followUp: f.followUp.value, followNote: f.followNote.value, force,
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
      showToast("Prospect added");
      onDone(r.id);
    },
  });
  return ctl;
}

function lostDialog(p, set, done) {
  const reasons = Array.isArray(set.lostReasons) && set.lostReasons.length ? set.lostReasons
    : ["Too expensive", "Went elsewhere", "No response", "Not suitable", "Just browsing", "Other"];
  openDialog({
    title: `Mark ${p.name} as lost`, submit: "Mark as lost",
    body: `<div class="pr-reasons">${reasons.map((r, i) => `<label class="pr-reason"><input type="radio" name="reason" value="${esc(r)}"${i ? "" : ""} /><span>${esc(r)}</span></label>`).join("")}</div>
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

async function settingsDialog(set, onSaved) {
  const list = await staffList();
  const ticks = (name, chosen) => `<div class="pr-ticks">${list.map((s) =>
    `<label class="fe-check"><input type="checkbox" name="${name}" value="${esc(s.id)}"${(chosen || []).includes(s.id) ? " checked" : ""} /> ${esc(s.name)}</label>`).join("")}</div>`;
  openDialog({
    title: "Prospect settings", submit: "Save",
    body: `
      <h4 class="pr-h4">When a web enquiry arrives, email</h4>${ticks("notify", set.notify)}
      <h4 class="pr-h4">Share new web enquiries in turn between</h4>
      <p class="muted pr-small">The person with the fewest open prospects (working today) gets the next one. Nobody ticked: they wait on the board for anyone.</p>
      ${ticks("team", set.team)}
      <label class="lh-field"><span class="lh-label">Flag as "Not contacted" after (hours)</span>
        <input name="hours" type="number" min="1" max="168" class="fe-input" value="${esc(set.respondHours || 24)}" /></label>
      <label class="lh-field"><span class="lh-label">Reasons a prospect is lost (one per line)</span>
        <textarea name="reasons" rows="5" class="fe-input">${esc((set.lostReasons && set.lostReasons.length ? set.lostReasons
          : ["Too expensive", "Went elsewhere", "No response", "Not suitable", "Just browsing", "Other"]).join("\n"))}</textarea></label>
      <div class="pr-import"><button type="button" class="lh-btn" data-role="import">Check for new web enquiries now</button><small data-role="imsg"></small></div>`,
    onOpen: (c) => {
      c.form.querySelector('[data-role="import"]').addEventListener("click", async (e) => {
        const b = e.currentTarget;
        const m = c.form.querySelector('[data-role="imsg"]');
        b.disabled = true;
        m.textContent = "Checking info@…";
        try { const r = await api("importNow", { days: 14 }); m.textContent = r.imported ? `${r.imported} new enquiry email(s) added.` : "No new enquiry emails."; }
        catch (err) { m.textContent = errText(err); }
        finally { b.disabled = false; }
      });
    },
    onSubmit: async (c) => {
      const pick = (n) => [...c.form.querySelectorAll(`[name="${n}"]:checked`)].map((x) => x.value);
      await api("saveSettings", {
        notify: pick("notify"), team: pick("team"), respondHours: c.form.elements.hours.value,
        lostReasons: c.form.elements.reasons.value.split(/\n+/).map((s) => s.trim()).filter(Boolean),
      });
      c.close();
      showToast("Prospect settings saved");
      onSaved();
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
  try {
    const [snap, s] = await Promise.all([getDoc(doc(db, "prospects", id)), loadSettings()]);
    set = s;
    if (snap.exists()) p = { id: snap.id, ...snap.data() };
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
      <ol class="pr-tl">${list.map((l) => `<li class="is-${esc(l.kind)}">
        <span class="pr-tl-ic">${I(IC[KIND_IC[l.kind] || "note"])}</span>
        <div><strong>${esc(l.what)}</strong><small>${esc([when(l.at), l.by].filter(Boolean).join(" · "))}</small>
          ${l.note ? `<p>${esc(l.note)}</p>` : ""}</div></li>`).join("")}</ol></section>`;
  }

  function render() {
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
            ${p.historic ? '<span class="pr-tag">Older</span>' : ""}
            
          </div>
        </div>
        <span class="pr-pill is-${s.tone} is-lg">${esc(s.name)}</span>
      </div>
      ${p.stage === "lost" ? `<div class="pr-banner is-lost">${I(IC.flag)}<div><strong>Lost: ${esc(p.lostReason || "")}</strong>${
        p.lostNote ? `<small>${esc(p.lostNote)}</small>` : ""}</div>${work ? '<button type="button" class="lh-btn" data-stage="contacted">Reopen</button>' : ""}</div>` : ""}
      ${late ? `<div class="pr-banner is-bad">${I(IC.alert)}<div><strong>Not contacted yet</strong><small>They enquired ${esc(ago(p.waitingSince))}.</small></div></div>` : ""}
      ${cancelOpen(p) ? `<div class="pr-banner is-bad">${I(IC.alert)}<div><strong>${cancelWord(p)} on ${esc(fullDay(p.lastCancel.date))}, not rebooked yet</strong>${
        p.lastCancel.svcs && p.lastCancel.svcs.length ? `<small>${esc(p.lastCancel.svcs.join(", "))}</small>` : ""}</div></div>` : ""}
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
            ${p.nextFollowUp ? `<p class="pr-follow-when"><strong>${esc(niceDay(p.nextFollowUp))}</strong>${
              fs === "overdue" ? ' <span class="pr-tag is-bad">Overdue</span>' : fs === "today" ? ' <span class="pr-tag is-warn">Today</span>' : ""}</p>
              ${p.followNote ? `<p class="muted">${esc(p.followNote)}</p>` : ""}` : '<p class="muted">No follow-up set.</p>'}
            ${work ? `<form data-role="follow" novalidate>${followHtml(fuStart(p.nextFollowUp), p.followNote || "")}
              <button type="submit" class="lh-btn is-primary">Save follow-up</button></form>` : ""}
          </section>
          ${timeline()}
        </div>
        <aside class="pr-side">
          <section class="pr-sec"><h3>${I(IC.inbox)} What they asked</h3>
            ${(p.enquiries || []).slice().reverse().map((q) => `<div class="pr-enq">
              <small>${esc(when(q.at))} · ${esc(q.source || "")}${q.concern ? ` · ${esc(q.concern)}` : ""}</small>
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
              ${work ? `<input type="search" class="fe-input" data-role="ptq" placeholder="Search the Patient List" value="${esc(p.name)}" />
                <div class="pr-hits" data-role="hits"></div>` : ""}`}
          </section>
          ${onRecall(p) ? `<section class="pr-sec pr-recall"><h3>${I(IC.clock)} Also on recall</h3>
            <p><strong>${esc(p.recall.category)}</strong> · due ${esc(fullDay(p.recall.due))}${p.recall.status === "booked" ? " · booked" : ""}</p>
            <p class="muted pr-small">${p.recall.with ? `With ${esc(p.recall.with)} on the recall team.` : "Not given to anyone on the recall team yet."}${
              p.recall.more ? ` ${p.recall.more} more recall${p.recall.more === 1 ? "" : "s"} due.` : ""}
              The recall team can see they enquired. Agree who's calling them, so they only hear from one of you.</p>
            ${can("recall.work") || can("recall.manage") ? '<a class="lh-btn" href="#/recall">Open Recall</a>' : ""}</section>` : ""}
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
              <label class="lh-field"><span class="lh-label">Source</span><select name="source" class="fe-input">${opts(SOURCES, p.source)}</select></label>
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
      if (!p.patientId) searchPt(p.name);
    }
  }

  let ptTimer = 0;
  async function searchPt(q) {
    const box = root.querySelector('[data-role="hits"]');
    if (!box) return;
    q = String(q || "").trim();
    if (q.length < 2) { box.innerHTML = ""; return; }
    box.innerHTML = '<small class="muted">Searching…</small>';
    try {
      const r = await callApi({ action: "prospects", op: "ptSearch", q });
      const list = r.results || [];
      box.innerHTML = list.length ? list.slice(0, 6).map((x) => `<button type="button" class="pr-hit" data-link="${esc(x.id)}">
        <strong>${esc(x.name)}</strong><small>${esc([x.mobile, x.dob].filter(Boolean).join(" · "))}</small></button>`).join("")
        : '<small class="muted">No patients found.</small>';
    } catch (err) { box.innerHTML = `<small class="muted">${esc(errText(err))}</small>`; }
  }

  function logDialog(outcome = "spoke") {
    openDialog({
      title: "Log a call", sub: p.phone ? `${p.name} · ${p.phone}` : p.name, submit: "Save",
      body: `<div class="pr-reasons">${OUTCOMES.map(([k, l]) =>
        `<label class="pr-reason"><input type="radio" name="outcome" value="${k}"${k === outcome ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>
        <label class="lh-field"><span class="lh-label">Note</span><textarea name="note" rows="3" maxlength="1000" class="fe-input" placeholder="What was said, what they want, when suits them"></textarea></label>
        ${followHtml(fuStart(p.nextFollowUp), p.followNote || "")}`,
      onSubmit: async (c) => {
        const f = c.form.elements;
        await save("log", { outcome: (c.form.querySelector('[name="outcome"]:checked') || {}).value, note: f.note.value,
          followUp: f.followUp.value, followNote: f.followNote.value }, "Saved");
        c.close();
      },
    });
  }

  root.addEventListener("click", async (e) => {
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
      try { await save("stage", { stage: to }, stageOf(to).name); } catch (err) { showToast(errText(err)); }
      return;
    }
    const a = e.target.closest("[data-act]");
    if (!a || !work) return;
    const act = a.dataset.act;
    if (act === "call") setTimeout(() => logDialog("spoke"), 400);   // the phone opens, then the log
    if (act === "log") logDialog();
    if (act === "lost") lostDialog(p, set, (np) => { p = np; render(); });
    if (act === "unlink") { try { await save("link", { pttId: "" }, "Unlinked"); } catch (err) { showToast(errText(err)); } }
    if (act === "confirmlink") { try { await save("link", { pttId: p.patientId }, "Confirmed"); } catch (err) { showToast(errText(err)); } }
    if (act === "note") {
      openDialog({ title: "Add a note", submit: "Save note",
        body: '<label class="lh-field"><span class="lh-label">Note</span><textarea name="note" rows="4" maxlength="1000" class="fe-input"></textarea></label>',
        onOpen: (c) => c.form.elements.note.focus(),
        onSubmit: async (c) => { await save("log", { outcome: "note", note: c.form.elements.note.value }, "Note saved"); c.close(); } });
    }
    if (act === "text") {
      const about = p.concern && !/^other/i.test(p.concern) ? ` about ${p.concern.toLowerCase()}` : "";
      openDialog({ title: `Text ${p.name}`, sub: p.phone, submit: "Send text",
        body: `<label class="lh-field"><span class="lh-label">Message</span>
          <textarea name="text" rows="5" maxlength="612" class="fe-input">Hi ${esc(p.firstName || "there")}, it's Dermedica. Thanks for your enquiry${esc(about)}. </textarea>
          <small class="muted" data-role="n"></small></label>${followHtml(fuStart(p.nextFollowUp, addDays(todayKey(), 2)), p.followNote || "")}`,
        onOpen: (c) => {
          const ta = c.form.elements.text;
          const n = c.form.querySelector('[data-role="n"]');
          const upd = () => { n.textContent = `${ta.value.length} characters · ${Math.max(1, Math.ceil(ta.value.length / 153))} text${ta.value.length > 160 ? "s" : ""}`; };
          ta.addEventListener("input", upd); upd(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
        },
        onSubmit: async (c) => {
          const f = c.form.elements;
          await save("text", { text: f.text.value, followUp: f.followUp.value, followNote: f.followNote.value }, "Text sent");
          c.close();
        } });
    }
    if (act === "email") {
      openDialog({ title: `Email ${p.name}`, sub: p.email, submit: "Send email",
        body: `<label class="lh-field"><span class="lh-label">Subject</span><input name="subject" class="fe-input" maxlength="200" value="Your enquiry with Dermedica" /></label>
          <label class="lh-field"><span class="lh-label">Message</span><textarea name="message" rows="8" maxlength="5000" class="fe-input">Hi ${esc(p.firstName || "there")},

Thank you for your enquiry${esc(p.concern && !/^other/i.test(p.concern) ? ` about ${p.concern.toLowerCase()}` : "")}.

Kind regards,
Dermedica</textarea></label>${followHtml(fuStart(p.nextFollowUp, addDays(todayKey(), 3)), p.followNote || "")}`,
        onSubmit: async (c) => {
          const f = c.form.elements;
          await save("email", { subject: f.subject.value, message: f.message.value, followUp: f.followUp.value, followNote: f.followNote.value }, "Email sent");
          c.close();
        } });
    }
  });

  root.addEventListener("change", async (e) => {
    if (e.target.dataset.role === "assign") {
      try { await save("assign", { toId: e.target.value }, e.target.value ? "Given to them" : "Not given to anyone"); }
      catch (err) { showToast(errText(err)); }
    }
  });
  root.addEventListener("input", (e) => {
    if (e.target.dataset.role === "ptq") { clearTimeout(ptTimer); ptTimer = setTimeout(() => searchPt(e.target.value), 300); }
  });
  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const f = form.elements;
      if (form.dataset.role === "follow") await save("followUp", { followUp: f.followUp.value, followNote: f.followNote.value }, "Follow-up saved");
      if (form.dataset.role === "details") {
        await save("update", { name: f.name.value, phone: f.phone.value, email: f.email.value, concern: f.concern.value,
          source: f.source.value, age: f.age.value, pref: f.pref.value }, "Details saved");
      }
    } catch (err) { showToast(errText(err)); btn.disabled = false; }
  });

  render();
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

async function mountReports(container) {
  const root = document.createElement("section");
  root.className = "page wide pr-page pr-rep";
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
  all.forEach((p) => { p._day = keyOf(p.createdAt); p._reach = reachOf(p); p._imp = wasImported(p); });
  const firstDay = all.map((p) => p._day).filter(Boolean).sort()[0] || today;
const SOURCES = ["Web form", "Phone call", "Walk-in", "Online chat", "Instagram", "Facebook", "Referral", "Booked directly", "Other"];
  const people = [...new Set(all.map((p) => p.assignedToName).filter(Boolean))].sort();
  const st = { range: "90", from: "", to: "", source: "", who: "", kind: "" };

  const span = () => (st.range === "custom" ? [st.from || firstDay, st.to || today]
    : st.range === "all" ? [firstDay, today] : [addDays(today, -(Number(st.range) - 1)), today]);
  const keep = (p) => (!st.source || (p.source || "Other") === st.source)
    && (!st.who || (st.who === "-" ? !p.assignedToName : p.assignedToName === st.who))
        && showOf(st.kind)(p, set);
  const cohort = (a, b) => all.filter((p) => p._day && p._day >= a && p._day <= b && keep(p));

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
  // ▲ / ▼ against the same length of time before. pts: a change in percentage points.
  const delta = (now, was, kind, upGood = true) => {
    if (now == null || was == null) return "";
    const d = kind === "pts" ? now - was : was ? ((now - was) / was) * 100 : null;
    if (d == null || !isFinite(d)) return "";
    if (Math.round(d) === 0) return '<span class="pr-delta">No change</span>';
    return `<span class="pr-delta ${(d > 0) === upGood ? "is-up" : "is-down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(Math.round(d))}${kind === "pts" ? " pts" : "%"}</span>`;
  };
  const kpi = (label, big, sub, d = "") => `<div class="pr-kpi"><span>${esc(label)}</span><strong>${big}</strong>
    <small>${sub}</small>${d}</div>`;

  function draw() {
    const [a, b] = span();
    const len = dayDiff(a, b) + 1;
    const list = cohort(a, b);
    const s = stats(list);
    const ps = st.range === "all" ? null : stats(cohort(addDays(a, -len), addDays(a, -1)));
    const rate = (x, n) => pct(x, n);
    const prev = (k) => (ps ? rate(ps[k], ps.n) : null);
    const lostTop = groupBy(list.filter((p) => p.stage === "lost"), (p) => p.lostReason || "No reason")[0];

    // Months: the range (at least 6, at most 36)
    let m0 = a.slice(0, 7);
    const m1 = b.slice(0, 7);
    if (addMonths(m0, 5) > m1) m0 = addMonths(m1, -5);
    const months = [];
    for (let m = m0; m <= m1 && months.length < 60; m = addMonths(m, 1)) months.push(m);
    const trend = months.slice(-36).map((m) => {
      const l = all.filter((p) => p._day && p._day.startsWith(m) && keep(p));
      return { m, n: l.length, booked: l.filter((p) => p._reach >= 2).length, treated: l.filter((p) => p._reach >= 5).length };
    });

    // Now (not the date range): open prospects on the board
    const open = all.filter((p) => !p.historic && OPEN.includes(p.stage) && keep(p));
    const nowMs = Date.now();
    const pipe = STAGES.filter((x) => OPEN.includes(x.key)).map((x) => {
      const l = open.filter((p) => p.stage === x.key);
      const stuck = l.filter((p) => nowMs - Date.parse(p.stageAt || p.createdAt || "") > 14 * 864e5).length;
      return { label: x.name, n: l.length, tone: x.tone, text: `${l.length}${stuck ? ` <small class="is-warn">${stuck} over 14 days</small>` : ""}` };
    });

    const live = list.filter((p) => !p._imp && !p.fromBook);
    const speed = SPEED.map(([label, max], i) => ({
      label, n: live.filter((p) => { const h = hoursToContact(p); return h != null && h >= 0 && h <= max && (i === 0 || h > SPEED[i - 1][1]); }).length,
    })).concat([{ label: "No contact logged", n: live.filter((p) => hoursToContact(p) == null).length, tone: "slate" }]);

    const linked = list.filter((p) => p.patientId);
    const oldPt = linked.filter((p) => p.wasPatient).length;
    const newPt = linked.length - oldPt;
    const none = list.length - linked.length;
    const seg = (n, cls, label) => (n ? `<i class="${cls}" style="flex:${n}" title="${esc(label)}: ${n}"></i>` : "");

    const srcRows = groupBy(list, (p) => p.source || "Other").map(({ k, l }) => { const x = stats(l); return `<tr>
      <td data-label="Source"><strong>${esc(k)}</strong></td><td data-label="Enquiries">${x.n}</td>
      <td data-label="Booked a consult">${cellBar(rate(x.booked, x.n))}</td><td data-label="Became patients">${cellBar(rate(x.treated, x.n))}</td>
      <td data-label="Lost">${rate(x.lost, x.n)}%</td><td data-label="Days to 1st appointment">${x.appt == null ? "–" : Math.round(x.appt)}</td></tr>`; }).join("");
    const teamRows = groupBy(list, (p) => p.assignedToName || "Nobody yet").map(({ k, l }) => {
      const x = stats(l);
      const lv = l.filter((p) => !p._imp && !p.fromBook);
      return `<tr><td data-label="Team member"><strong>${esc(k)}</strong></td><td data-label="Prospects">${x.n}</td>
        <td data-label="Contacted">${lv.length ? cellBar(rate(lv.filter((p) => Number(p.contacts) > 0).length, lv.length)) : "–"}</td>
        <td data-label="First contact">${hrsText(x.hrs)}</td>
        <td data-label="Booked a consult">${cellBar(rate(x.booked, x.n))}</td><td data-label="Became patients">${cellBar(rate(x.treated, x.n))}</td>
        <td data-label="Lost">${rate(x.lost, x.n)}%</td></tr>`;
    }).join("");
    const concerns = groupBy(list, (p) => String(p.concern || "Not given").split(/[,;]/)[0].trim() || "Not given").slice(0, 8)
      .map(({ k, l }) => ({ label: k, n: l.length, text: `${l.length} <small>${rate(l.filter((p) => p._reach >= 5).length, l.length)}% became patients</small>` }));
    const lost = groupBy(list.filter((p) => p.stage === "lost"), (p) => p.lostReason || "No reason").map(({ k, l }) => ({ label: k, n: l.length, tone: "slate" }));
    const optsR = (list2, cur) => list2.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");

    root.innerHTML = `${back}
      <div class="pr-top"><div><h2>Prospect reports</h2><p class="muted">Enquiries from ${esc(repDay(a))} to ${esc(repDay(b))}${
        ps ? ` · ▲▼ compared with the ${len} days before` : ""}</p></div>
        <div class="pr-top-acts"><button type="button" class="lh-btn is-quiet" data-act="csv">Download CSV</button></div></div>
      <div class="pr-rep-tools">
        <select class="fe-input" data-r="range" aria-label="Dates">${optsR(REP_RANGES, st.range)}</select>
        ${st.range === "custom" ? `<input type="date" class="fe-input" data-r="from" value="${esc(st.from || a)}" max="${today}" aria-label="From" />
          <input type="date" class="fe-input" data-r="to" value="${esc(st.to || b)}" max="${today}" aria-label="To" />` : ""}
        <select class="fe-input" data-r="source" aria-label="Source"><option value="">All sources</option>${optsR(sources.map((x) => [x, x]), st.source)}</select>
        <select class="fe-input" data-r="who" aria-label="Team member"><option value="">Everyone</option>
          <option value="-"${st.who === "-" ? " selected" : ""}>Nobody yet</option>${optsR(people.map((x) => [x, x]), st.who)}</select>
        <select class="fe-input" data-r="kind" aria-label="Who">${optsR(REP_KINDS, st.kind)}</select>
      </div>
      <div class="pr-kpis">
        ${kpi("Enquiries", s.n, `${s.live} since the dashboard started`, delta(s.n, ps && ps.n, "%"))}
        ${kpi("Booked a consultation", `${rate(s.booked, s.n)}%`, `${s.booked} people`, delta(rate(s.booked, s.n), prev("booked"), "pts"))}
        ${kpi("Became patients", `${rate(s.treated, s.n)}%`, `${s.treated} treated`, delta(rate(s.treated, s.n), prev("treated"), "pts"))}
        ${kpi("Active patients", `${rate(s.active, s.n)}%`, `${s.active} came back again`, delta(rate(s.active, s.n), prev("active"), "pts"))}
        ${kpi("First contact", hrsText(s.hrs), `${rate(s.fast, s.live)}% within ${hoursOf(set)} hours`, delta(s.hrs, ps && ps.hrs, "%", false))}
        ${kpi("Enquiry to first appointment", s.appt == null ? "–" : `${Math.round(s.appt)} days`, "Middle value", delta(s.appt, ps && ps.appt, "%", false))}
        ${kpi("Lost", `${rate(s.lost, s.n)}%`, lostTop ? `Mostly: ${esc(lostTop.k)}` : "None lost", delta(rate(s.lost, s.n), prev("lost"), "pts", false))}
        ${kpi("Cancelled after booking", `${rate(s.cancelled, s.everBooked)}%`, `${s.cancelOpen} not rebooked`,
          delta(rate(s.cancelled, s.everBooked), ps ? rate(ps.cancelled, ps.everBooked) : null, "pts", false))}
        </div>
      <div class="pr-rep-grid">
        <section class="pr-panel is-wide"><h3>Enquiries by month</h3>
          <ul class="pr-legend"><li><i class="is-all"></i>Enquiries</li><li><i class="is-won"></i>Became patients</li><li><i class="is-line"></i>Booked a consultation (%)</li></ul>
          ${trendSvg(trend)}</section>
        <section class="pr-panel"><h3>From enquiry to patient</h3>${funnelHtml(list)}
          <p class="pr-note">Enquiries imported from before the dashboard only count as contacted once they've booked.
            Recent enquiries may still book, so their rates can look lower.</p></section>
        <section class="pr-panel"><h3>Open prospects now</h3>${hbars(pipe, "No open prospects.")}
          <p class="pr-note">${open.filter((p) => notContacted(p, set)).length} not contacted in ${hoursOf(set)} hours ·
            ${open.filter((p) => followState(p) === "overdue").length} follow-ups overdue · this part isn't affected by the dates.</p></section>
        <section class="pr-panel is-wide"><h3>By source</h3>${srcRows ? `<div class="pr-rt-wrap"><table class="pr-rtable"><thead><tr>
          <th>Source</th><th>Enquiries</th><th>Booked a consult</th><th>Became patients</th><th>Lost</th><th>Days to 1st appointment</th>
          </tr></thead><tbody>${srcRows}</tbody></table></div>` : '<p class="muted">Nothing in this period.</p>'}</section>
        <section class="pr-panel is-wide"><h3>By team member</h3>${teamRows ? `<div class="pr-rt-wrap"><table class="pr-rtable"><thead><tr>
          <th>Team member</th><th>Prospects</th><th>Contacted</th><th>First contact</th><th>Booked a consult</th><th>Became patients</th><th>Lost</th>
          </tr></thead><tbody>${teamRows}</tbody></table></div>` : '<p class="muted">Nothing in this period.</p>'}</section>
        <section class="pr-panel"><h3>How quickly they're contacted</h3>${hbars(speed.filter((x) => x.n), "No enquiries since the dashboard started.")}
          <p class="pr-note">Enquiries since the dashboard started, from the first call, text or email logged. Booked directly isn't counted: they booked themselves.</p></section>
        <section class="pr-panel"><h3>Why they were lost</h3>${hbars(lost, "Nobody lost in this period. 👍")}</section>
        <section class="pr-panel"><h3>Booked, then cancelled</h3>${hbars([
          { label: "Cancelled, then rebooked", n: list.filter((p) => Number(p.cancels) > 0 && !p.cancelOpen).length, tone: "green" },
          { label: "Cancelled, not rebooked", n: list.filter((p) => p.cancelOpen === true && !(p.lastCancel && p.lastCancel.kind === "noshow")).length, tone: "orange" },
          { label: "Didn't come, not rebooked", n: list.filter((p) => p.cancelOpen === true && p.lastCancel && p.lastCancel.kind === "noshow").length, tone: "slate" },
        ].filter((x) => x.n), "No cancellations in this period. 👍")}
          <p class="pr-note">Consultations and treatments cancelled, or not attended, after they enquired.
            ${list.filter((p) => cancelOpen(p)).length} still open on the board to call.</p></section>
        <section class="pr-panel"><h3>What they're interested in</h3>${hbars(concerns)}</section>
        <section class="pr-panel"><h3>New or existing patients</h3>
          <div class="pr-stack">${seg(newPt, "is-new", "New to the clinic")}${seg(oldPt, "is-old", "Already patients")}${seg(none, "is-none", "Not linked to a patient yet")}</div>
          <ul class="pr-legend"><li><i class="is-new"></i>New to the clinic: ${newPt}</li><li><i class="is-old"></i>Already patients: ${oldPt}</li>
            <li><i class="is-none"></i>Not linked yet: ${none}</li></ul>
          <p class="pr-note">Already patients: they'd been in before they enquired.</p></section>
        <section class="pr-panel is-wide"><h3>When enquiries come in</h3>${heatHtml(list)}
          <p class="pr-note">Perth time. Darker means more enquiries, which helps with who's on to reply.</p></section>
      </div>`;
  }

  function downloadCsv() {
    const [a, b] = span();
    const list = cohort(a, b);
    const head = ["Name", "Enquired", "Source", "Interested in", "Stage", "Given to", "Contacts", "First contact",
      "First appointment", "First treatment", "Active from", "Lost reason", "Cancelled", "Already a patient",
      "Past patient", "On recall"];
    const rows = list.map((p) => { const m = p.milestones || {}; return [p.name, p._day, p.source, p.concern, stageOf(p.stage).name,
      p.assignedToName, p.contacts || 0, p.firstContactAt ? keyOf(p.firstContactAt) : "", m.consult_booked || "", m.treated || "",
      m.active || "", p.lostReason || "", p.cancels ? `${p.cancels}${p.cancelOpen ? " (not rebooked)" : ""}` : "",
      p.wasPatient ? "Yes" : p.patientId ? "No" : "",
      p.prev ? `Yes, last visit ${p.prev.last}` : "",
      p.recall ? `${p.recall.category} (due ${p.recall.due})` : ""]; });
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
    st[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    if (k === "range" && st.range === "custom" && !st.from) { st.from = addDays(today, -89); st.to = today; }
    if ((k === "from" || k === "to") && st.from && st.to && st.from > st.to) {   // dates the wrong way round
      if (k === "from") st.to = st.from; else st.from = st.to;
    }
    draw();
  });
  root.addEventListener("click", (e) => { if (e.target.closest('[data-act="csv"]')) downloadCsv(); });
  draw();
}