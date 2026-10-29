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
};
const KIND_IC = { enquiry: "inbox", contact: "phone", text: "text", email: "mail", note: "note", stage: "flag",
  follow: "clock", assign: "user", link: "link", edit: "note" };

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
  const st = { view, q: "", source: "", who: "all", due: false, showLost: false, old: false };
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
    ["alert", all.filter((p) => notContacted(p, set)).length, `Not contacted in ${hoursOf(set)} hours`, "bad"],
    ["inbox", all.filter((p) => Date.now() - Date.parse(p.createdAt || "") < 7 * 864e5).length, "New enquiries this week", "sky"],
    ["clock", all.filter((p) => ["today", "overdue"].includes(followState(p))).length, "Follow-ups due", "amber"],
    ["trophy", all.filter((p) => ["treated", "active"].includes(p.stage) && keyOf(p.stageAt).slice(0, 7) === month).length,
      "Became patients this month", "green"],
  ];
  const srcList = [...new Set(all.map((p) => p.source).filter(Boolean))].sort();

  root.innerHTML = `
    <div class="pr-top">
      <div><h2>Prospect Dashboard</h2><p class="muted">Everyone who's enquired, from first contact to becoming a patient.</p></div>
      <div class="pr-top-acts">
        ${can("prospects.manage") ? `<button type="button" class="lh-btn is-quiet" data-act="settings">${I(IC.gear)} Settings</button>` : ""}
        ${work ? `<button type="button" class="lh-btn is-primary" data-act="new">${I(IC.plus)} New prospect</button>` : ""}
      </div>
    </div>
    <div class="pr-tiles">${tiles.map(([ic, n, l, tone]) =>
      `<div class="pr-tile is-${tone}">${I(IC[ic])}<div><strong>${n}</strong><span>${esc(l)}</span></div></div>`).join("")}</div>
    <div class="pr-tools">
      <div class="fe-seg">${[["board", "Board"], ["list", "List"]].map(([v, l]) =>
        `<label class="fe-seg-btn"><input type="radio" name="pr-view" value="${v}"${st.view === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
      <input type="search" class="fe-input pr-q" data-role="q" placeholder="Search name, mobile, email or interest" />
      <select class="fe-input" data-role="source"><option value="">All sources</option>${opts(srcList, "")}</select>
      <select class="fe-input" data-role="who"><option value="all">Everyone's</option><option value="me">Mine</option><option value="none">Not given to anyone</option></select>
      <label class="fe-check pr-due"><input type="checkbox" data-role="due" /> Needs action</label>
      <button type="button" class="lh-btn is-quiet" data-act="old">Show older enquiries</button>
    </div>
    <div data-role="body"></div>`;

  const match = (p) => {
    if (st.source && p.source !== st.source) return false;
    if (st.who === "me" && p.assignedToId !== me) return false;
    if (st.who === "none" && p.assignedToId) return false;
    if (st.due && !(notContacted(p, set) || ["today", "overdue"].includes(followState(p)))) return false;
    if (!st.q) return true;
    const digits = st.q.replace(/\D/g, "");
    return `${p.name} ${p.email} ${p.concern} ${p.patientName || ""}`.toLowerCase().includes(st.q) ||
      (digits.length >= 3 && String(p.phoneKey || "").includes(digits));
  };
  const urgency = (p) => (notContacted(p, set) ? 0 : followState(p) === "overdue" ? 1 : followState(p) === "today" ? 2 : 3);
  const byUrgency = (a, b) => urgency(a) - urgency(b) ||
    String(a.nextFollowUp || "9").localeCompare(String(b.nextFollowUp || "9")) ||
    String(b.lastEnquiryAt || "").localeCompare(String(a.lastEnquiryAt || ""));

  const card = (p) => {
    const fs = followState(p);
    const late = notContacted(p, set);
    return `<a class="pr-card${late ? " is-late" : ""}" href="#/prospects/${enc(p.id)}" data-id="${esc(p.id)}" draggable="${work}">
      <span class="pr-card-top"><strong>${esc(p.name || "No name")}</strong>${p.assignedToName
        ? `<i class="pr-av" title="${esc(p.assignedToName)}">${esc(initials(p.assignedToName))}</i>` : ""}</span>
      ${p.concern ? `<small class="pr-card-concern">${esc(p.concern)}</small>` : ""}
      <span class="pr-tags">
        <span class="pr-tag">${esc(p.source || "Other")}</span>
        ${p.patientId ? '<span class="pr-tag is-pt">Patient</span>' : ""}
        ${late ? '<span class="pr-tag is-bad">Not contacted</span>' : ""}
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
    const list = all.filter(match);
    const box = root.querySelector('[data-role="body"]');
    if (st.view === "list") {
      const rows = list.slice().sort(byUrgency);
      box.innerHTML = rows.length ? `<div class="pr-table-wrap"><table class="pr-table"><thead><tr>
          <th>Name</th><th>Stage</th><th>Interested in</th><th>Source</th><th>With</th><th>Follow up</th><th>Last contact</th><th>Enquired</th>
        </tr></thead><tbody>${rows.map((p) => {
          const s = stageOf(p.stage);
          const fs = followState(p);
          return `<tr data-href="#/prospects/${enc(p.id)}">
            <td><a href="#/prospects/${enc(p.id)}"><strong>${esc(p.name)}</strong></a>${notContacted(p, set) ? ' <span class="pr-tag is-bad">Not contacted</span>' : ""}</td>
            <td><span class="pr-pill is-${s.tone}">${esc(s.name)}</span></td>
            <td>${esc(p.concern || "")}</td><td>${esc(p.source || "")}</td><td>${esc(p.assignedToName || "")}</td>
            <td class="${fs === "overdue" ? "is-bad" : fs === "today" ? "is-warn" : ""}">${esc(niceDay(p.nextFollowUp))}</td>
            <td>${esc(p.lastContactAt ? ago(p.lastContactAt) : "")}</td><td>${esc(niceDay(keyOf(p.createdAt)))}</td></tr>`;
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
    if (e.target.name === "pr-view") { st.view = e.target.value; history.replaceState(null, "", st.view === "list" ? "#/prospects/list" : "#/prospects"); drawBody(); }
    if (e.target.dataset.role === "source") { st.source = e.target.value; drawBody(); }
    if (e.target.dataset.role === "who") { st.who = e.target.value; drawBody(); }
    if (e.target.dataset.role === "due") { st.due = e.target.checked; drawBody(); }
  });
  root.addEventListener("input", (e) => { if (e.target.dataset.role === "q") { st.q = e.target.value.trim().toLowerCase(); drawBody(); } });
  root.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a")) { location.hash = tr.dataset.href; return; }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "lost") { st.showLost = !st.showLost; drawBody(); }
    if (a.dataset.act === "old") {
      st.old = !st.old;
      a.disabled = true;
      a.textContent = st.old ? "Loading…" : "Show older enquiries";
      loadAll(st.old)
        .then((list) => { all = list; a.textContent = st.old ? "Hide older enquiries" : "Show older enquiries"; drawBody(); })
        .catch(() => { st.old = !st.old; showToast("Couldn't load them. Try again."); })
        .finally(() => { a.disabled = false; });
    }
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
        <label class="lh-field"><span class="lh-label">How they got in touch</span><select name="source" class="fe-input">${opts(SOURCES.filter((s) => s !== "Web form"), "Phone call")}</select></label>
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
            ${p.patientId ? `<a class="pr-chip is-pt" href="#/patient/${enc(p.patientId)}">${I(IC.user)}Patient: ${esc(p.patientName)}</a>` : ""}
            ${p.historic ? '<span class="pr-tag">Older</span>' : ""}
            
          </div>
        </div>
        <span class="pr-pill is-${s.tone} is-lg">${esc(s.name)}</span>
      </div>
      ${p.stage === "lost" ? `<div class="pr-banner is-lost">${I(IC.flag)}<div><strong>Lost: ${esc(p.lostReason || "")}</strong>${
        p.lostNote ? `<small>${esc(p.lostNote)}</small>` : ""}</div>${work ? '<button type="button" class="lh-btn" data-stage="contacted">Reopen</button>' : ""}</div>` : ""}
      ${late ? `<div class="pr-banner is-bad">${I(IC.alert)}<div><strong>Not contacted yet</strong><small>They enquired ${esc(ago(p.waitingSince))}.</small></div></div>` : ""}
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
            ${p.patientId ? `<p><a href="#/patient/${enc(p.patientId)}"><strong>${esc(p.patientName)}</strong></a></p>
              ${work ? '<button type="button" class="lh-btn is-quiet" data-act="unlink">Unlink</button>' : ""}`
              : `${p.patientMany > 1 ? `<p class="muted">${p.patientMany} patients have the same mobile or email. Choose the right one.</p>`
                : '<p class="muted">Not linked to a patient yet. When they book, link them here.</p>'}
              ${work ? `<input type="search" class="fe-input" data-role="ptq" placeholder="Search the Patient List" value="${esc(p.name)}" />
                <div class="pr-hits" data-role="hits"></div>` : ""}`}
          </section>
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