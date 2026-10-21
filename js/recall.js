// Recall (#/recall): patients due for their next treatment, worked by the recall team.
// The cards (recalls/{id}) are made, booked and closed by Apps Script (Code.gs → Recall) from the appointment book.
// Every change goes through Apps Script (action "recall"), so each card keeps a full history.
// Only the tab on screen is loaded, 50 at a time; the numbers come from Firestore count queries.
// With a Last visit filter on, each tab is one list sorted by last visit (Firestore can only sort by the date it filters on).
import { db, auth } from "./firebase-config.js";
import { collection, query, where, orderBy, limit, onSnapshot, getDocs, getDoc, doc, getCountFromServer }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { normRecallSettings } from "./recall-settings.js";

const COL = "recalls";
const PAGE = 50;
const OUTCOMES = [["no_answer", "No answer"], ["voicemail", "Left voicemail"], ["spoke", "Spoke to them"],
  ["texted", "Sent a text"], ["booked", "Booked"]];
const QUICK = [["no_answer", "No answer"], ["voicemail", "Left voicemail"], ["texted", "Sent a text"], ["booked", "Booked"]];
const LABEL = Object.fromEntries(OUTCOMES);
const GROUPS = [["Just due · last 30 days", (d) => d <= 30], ["Overdue · 1 to 6 months", (d) => d > 30 && d <= 182],
  ["Lapsed · over 6 months", (d) => d > 182]];
const LV_OPTS = [["", "Last visit: any time"], ["3", "Last visit: past 3 months"], ["3-6", "Last visit: 3 to 6 months ago"],
  ["6-12", "Last visit: 6 to 12 months ago"], ["12+", "Last visit: over a year ago"], ["custom", "Last visit: choose dates…"]];
const PICKS = [["Tomorrow", (t) => addDays(t, 1)], ["Next week", (t) => addDays(t, 7)],
  ["2 weeks", (t) => addDays(t, 14)], ["1 month", (t) => addMonths(t, 1)]];

const REPLY_TAG = { yes: "Wants to book", stop: "Opted out", other: "Replied" };
const STOP_LINE = "Reply STOP to opt out.";
const withStop = (t) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return /reply\s+stop/i.test(s) ? s : `${s}${s ? " " : ""}${STOP_LINE}`; };
const smsInfo = (t) => {
  const n = withStop(t).length;
  const parts = n <= 160 ? 1 : Math.ceil(n / 153);
  return `${n} characters · ${parts} text${parts === 1 ? "" : "s"}${/reply\s+stop/i.test(String(t || "")) ? "" : ` · "${STOP_LINE}" is added at the end`}`;
};

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
const daysFrom = (a, b) => { const x = keyDate(a), y = keyDate(b); return x && y ? Math.round((y - x) / 86400000) : 0; };
const when = (iso) => { const d = new Date(iso || ""); return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
const first = (n) => String(n || "").split(" ")[0];
const plural = (n, w) => `${Number(n).toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const ago = (days) => (days < 60 ? plural(days, "day") : plural(Math.round(days / 30.4), "month"));
// "Xuan (shwen) Ting" → "XT": nicknames in brackets or quotes and stray marks are ignored
const initials = (n) => {
  const w = String(n || "").replace(/\([^)]*\)|\[[^\]]*\]|"[^"]*"/g, " ").split(/\s+/)
    .map((x) => x.replace(/[^A-Za-z']/g, "")).filter((x) => /[A-Za-z]/.test(x));
  return w.length ? (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase() : "?";
};
// "61414498026" → "0414 498 026"; anything else is shown as it is
const mobileText = (m) => {
  let d = String(m || "").replace(/\D/g, "");
  if (/^614\d{8}$/.test(d)) d = `0${d.slice(2)}`;
  if (/^4\d{8}$/.test(d)) d = `0${d}`;
  return /^04\d{8}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : String(m || "").trim();
};
const telOf = (m) => mobileText(m).replace(/[^\d+]/g, "");
const me = () => (auth.currentUser && auth.currentUser.uid) || "";
const can = (staff, p) => !!staff && (/^admin$/i.test(String(staff.role || "")) || (Array.isArray(staff.perms) && staff.perms.includes(p)));
const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' -]/g, " ").replace(/\s+/g, " ").trim(); // same as recallKeys_
const blank = () => ({ out: "", note: "", remind: "", reason: "", until: "", sms: null });
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to Recall. Check Recall access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);
const getPref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* not essential */ } };

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

function norm(snap) {
  const x = snap.data() || {};
  const s = (k) => String(x[k] || "");
  return {
    id: snap.id, patientId: s("patientId"), patientName: s("patientName"), mobile: s("mobile"), email: s("email"),
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
    log: Array.isArray(x.log) ? x.log : [], updatedAt: s("updatedAt"),
  };
}

export function mountRecall(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page rc";
  root.innerHTML = `
    <div class="rc-top"><h2>Recall</h2><span class="inv-spacer"></span>
      ${can(staff, "recall.manage") ? '<a class="lh-btn is-quiet" href="#/settings/recall">Recall settings</a>' : ""}</div>
    <div class="rc-stats" data-role="stats"></div>
    <div class="rc-bar">
      <div class="rc-tabs" data-role="tabs" role="tablist"></div>
      <select class="fb-select rc-who" data-role="who" aria-label="Whose calls"></select>
      <span class="rc-lv" data-role="lvbox"></span>
      <span class="inv-spacer"></span>
      <input type="search" class="fe-input rc-q" data-role="q" placeholder="Find a patient by name, mobile or email" aria-label="Find a patient" />
    </div>
    <div class="rc-chips" data-role="chips"></div>
    <div class="rc-layout">
      <div data-role="list"></div>
      <aside class="tb-card rc-panel" data-role="panel" aria-label="Recall card" hidden></aside>
    </div>`;
  container.replaceChildren(root);
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);

  const ui = { tab: "mine", who: "mine", cat: "", q: "", lv: "", lvFrom: "", lvTo: "" };
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
  let panelSig = "";
  let draft = blank();
  let busy = false;
  let autoNext = getPref("rc_autonext", true);
  let countTimer = 0, countSeq = 0, searchTimer = 0, searchSeq = 0;

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
    const base = [...tabBase(ui.tab), ...(ui.cat ? [where("category", "==", ui.cat)] : [])];
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

  function build() {
    stopAll();
    sections = tabSections().map((s) => ({ ...s, n: PAGE, rows: [], loaded: false, more: false, error: "", open: !s.lazy, count: null, stop: null }));
    sections.filter((s) => s.open).forEach(listen);
    drawTabs(); drawWho(); drawLv(); drawChips(); drawList(); drawPanel(true);
    scheduleCounts(0);
  }

  /* ---------- Numbers ---------- */
  const countOf = async (cons) => {
    try { return (await getCountFromServer(query(collection(db, COL), ...cons))).data().count; }
    catch (err) { console.warn("Recall count failed:", err); return null; }
  };
  function scheduleCounts(delay = 1500) { clearTimeout(countTimer); countTimer = setTimeout(loadCounts, delay); }

  async function loadCounts() {
    if (!root.isConnected) return;
    const seq = ++countSeq;
    const t = todayKey(), uid = me();
    const cat = ui.cat ? [where("category", "==", ui.cat)] : [];
    const lv = lvRange();
    const lvc = lv ? [...lvWhere(lv), orderBy("lastVisit", "desc")] : [];   // the same indexes as the lists
    const cats = settings.categories.filter((c) => c.on).map((c) => c.key);
    const jobs = {
      mine: countOf([...tabBase("mine"), ...cat, ...lvc]),
      waiting: countOf([...tabBase("waiting"), ...cat, ...lvc]),
      later: countOf([...tabBase("later"), ...cat, ...lvc]),
      booked: countOf([...tabBase("booked"), ...cat, ...lvc]),
      myOpen: countOf([where("status", "==", "open"), where("stage", "==", "call"), where("assignedToId", "==", uid)]),
      logged: countOf([where("lastCallBy", "==", uid), where("lastCallDay", "==", t)]),
      newWeek: countOf([where("status", "==", "open"), where("dueDate", ">=", addDays(t, -7)), where("dueDate", "<=", t), orderBy("dueDate", "desc")]),
      bookedMonth: countOf([where("bookedAt", ">=", keyDate(`${t.slice(0, 8)}01`).toISOString())]),
    };
    cats.forEach((k) => { jobs[`cat:${k}`] = countOf([...tabBase(ui.tab), where("category", "==", k), ...lvc]); });
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
    if (q.length < 2) { found = null; searching = false; drawTabs(); drawWho(); drawLv(); drawChips(); drawList(); return; }
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
    drawTabs(); drawWho(); drawLv(); drawChips(); drawList();
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
  function drawStats() {
    const v = (x) => (x == null ? "–" : Number(x).toLocaleString());
    const box = (label, val, cls = "") => `<div class="rc-stat"><small>${esc(label)}</small><strong class="${cls}">${esc(v(val))}</strong></div>`;
    $("stats").innerHTML = box("My calls", counts.myOpen) + box("Called today", counts.logged) +
      box("Newly due this week", counts.newWeek) + box("Booked this month", counts.bookedMonth, "rc-good");
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
    s.hidden = ui.tab !== "mine" || ui.q.trim().length >= 2;
    const team = new Set(settings.team);
    const opts = [["mine", "Mine"], ["all", "Everyone's"],
      ...people.filter((p) => team.has(p.id) && p.id !== me()).map((p) => [p.id, p.name])];
    if (!opts.some(([k]) => k === ui.who)) opts.push([ui.who, "Someone else"]);
    s.innerHTML = opts.map(([k, l]) => `<option value="${esc(k)}"${k === ui.who ? " selected" : ""}>${esc(l)}</option>`).join("");
  }

  function drawLv() {
    const box = $("lvbox");
    box.hidden = ui.q.trim().length >= 2;
    const t = todayKey();
    box.innerHTML = `<select class="fb-select" data-role="lv" aria-label="Last visit">${LV_OPTS.map(([k, l]) =>
      `<option value="${k}"${k === ui.lv ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>` +
      (ui.lv === "custom" ? `
        <label>From <input type="date" class="fe-input" data-role="lvFrom" max="${t}" value="${esc(ui.lvFrom)}" /></label>
        <label>to <input type="date" class="fe-input" data-role="lvTo" max="${t}" value="${esc(ui.lvTo)}" /></label>` : "");
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
      c.lastStaff ? esc(`last with ${c.lastStaff}`) : ""].filter(Boolean).join(" · ");
    const side = [c.attempts ? `${c.attempts} tr${c.attempts === 1 ? "y" : "ies"}` : "",
      c.assignedToId && c.assignedToId !== me() ? first(c.assignedToName) : ""].filter(Boolean).join(" · ");
    const tag = c.replyOpen && c.reply
      ? `<span class="rc-tag is-${esc(c.reply.kind)}">${esc(REPLY_TAG[c.reply.kind] || "Replied")}</span>`
      : c.status === "open" && !c.assignedToId && c.textHoldUntil > t ? '<span class="rc-tag">Texted · waiting for a reply</span>' : "";
    const tel = telOf(c.mobile);
    const contact = tel ? `<a class="lh-btn rc-call" href="tel:${esc(tel)}">Call</a>`
      : c.email ? `<span class="rc-nomob">No mobile</span><a class="lh-btn is-quiet rc-call" href="mailto:${esc(c.email)}">Email</a>`
        : '<span class="rc-nomob">No mobile or email</span>';
    return `<div class="rc-item${on ? " is-on" : ""}" data-card="${esc(c.id)}" role="button" tabindex="0" aria-expanded="${on}">
        <span class="rc-av" aria-hidden="true">${esc(initials(c.patientName))}</span>
        <span class="rc-main"><strong>${esc(c.patientName || "Unknown patient")}</strong><small>${meta}</small></span>
        ${tag}
        ${side ? `<span class="rc-side">${esc(side)}</span>` : ""}
        ${contact}
      </div>${on && c.status === "open" ? `<div class="rc-quick">${QUICK.map(([k, l]) =>
        `<button type="button" class="rc-qb${k === "booked" ? " is-ok" : ""}" data-quick="${k}">${esc(l)}</button>`).join("")}
        <button type="button" class="rc-qb" data-act="details">Note or call back…</button></div>` : ""}`;
  }

  function groupedRows(rows, t) {
    const block = (title, list) => (list.length
      ? `<div class="rc-sub-h">${esc(title)}</div><div class="rc-list">${list.map((c) => rowHtml(c, t)).join("")}</div>` : "");
    const rest = rows.filter((c) => !c.replyOpen);
    return block("Replied · follow up first", rows.filter((c) => c.replyOpen)) +
      GROUPS.map(([title, test]) => block(title, rest.filter((c) => test(daysFrom(c.dueDate, t))))).join("");
  }

  function emptyText(sec) {
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
        GROUPS.forEach(([, test]) => s.rows.forEach((c) => { if (!c.replyOpen && test(daysFrom(c.dueDate, t))) out.push(c.id); }));
      }
      else s.rows.forEach((c) => out.push(c.id));
    });
    return out;
  }

  // The text for this card, from Recall settings → Texts
  function fillSms(c) {
    const s = settings.sms || {};
    const cat = settings.categories.find((x) => x.key === c.category);
    const months = c.lastVisit ? Math.max(1, Math.round(daysFrom(c.lastVisit, todayKey()) / 30.4)) : (cat ? cat.months : "");
    const firstName = String(c.patientName || "").replace(/\([^)]*\)/g, " ").trim().split(/\s+/)[0] || "there";
    return String(s.template || "")
      .replace(/\{\s*first name\s*\}/gi, firstName)
      .replace(/\{\s*treatment\s*\}/gi, (cat && cat.smsName) || "treatment")
      .replace(/\{\s*months\s*\}/gi, String(months))
      .replace(/\{\s*clinic phone\s*\}/gi, s.phone || "")
      .replace(/\s+/g, " ").trim();
  }

  /* ---------- One card ---------- */
  function drawPanel(force) {
    const p = $("panel");
    const c = sel ? findCard(sel) : null;
    if (!c) { p.hidden = true; p.innerHTML = ""; panelSig = ""; return; }
    const sig = `${c.id}|${c.updatedAt}|${c.status}|${people.length}`;
    if (!force && sig === panelSig) return;
    panelSig = sig;
    p.hidden = false;

    const t = todayKey();
    const over = daysFrom(c.dueDate, t);
    const team = new Set(settings.team);
    const ppl = [...people].sort((a, b) => (team.has(b.id) - team.has(a.id)) || String(a.name).localeCompare(String(b.name)));
    if (c.assignedToId && !ppl.some((s) => s.id === c.assignedToId)) ppl.unshift({ id: c.assignedToId, name: c.assignedToName || "Someone" });
    const reason = settings.reasons.find((r) => r.label === draft.reason);
    const tel = telOf(c.mobile);
    const sub = [
      c.category,
      `due ${nice(c.dueDate)}${over > 0 ? ` (${ago(over)} ago)` : ""}`,
      c.lastVisit ? `last visit ${nice(c.lastVisit)}${c.lastStaff ? ` with ${c.lastStaff}` : ""}` : "",
    ].filter(Boolean).join(" · ");

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
        <h4 class="rc-h">Log a call</h4>
        <label class="fe-check rc-auto"><input type="checkbox" data-role="auto"${autoNext ? " checked" : ""} />
          Open the next patient after logging a call</label>
        <div class="rc-outs">${OUTCOMES.map(([k, l]) => `<button type="button" class="ch-chip${draft.out === k ? " is-on" : ""}" data-out="${k}">${esc(l)}</button>`).join("")}</div>
        <textarea class="fe-input rc-note" data-role="note" rows="2" maxlength="1000" placeholder="Prefers Thursday mornings">${esc(draft.note)}</textarea>
        <div class="rc-row">
          <label>Call back on <input type="date" class="fe-input" data-role="remind" min="${addDays(t, 1)}" value="${esc(draft.remind)}" /></label>
          <span class="inv-spacer"></span>
          <button type="button" class="btn-primary" data-act="save">Save</button>
        </div>
        <div class="rc-picks">${PICKS.map(([l, fn], i) =>
          `<button type="button" class="rc-chip${draft.remind === fn(t) ? " is-on" : ""}" data-pick="${i}">${esc(l)}</button>`).join("")}</div>
        <h4 class="rc-h">Stop recall</h4>
        <div class="rc-row">
          <select class="fb-select" data-role="reason" aria-label="Reason">
            <option value="">Choose a reason</option>${settings.reasons.map((r) =>
              `<option value="${esc(r.label)}"${r.label === draft.reason ? " selected" : ""}>${esc(r.label)}</option>`).join("")}</select>
          ${reason && reason.askDate ? `<label>until <input type="date" class="fe-input" data-role="until" min="${addDays(t, 1)}" value="${esc(draft.until)}" /></label>` : ""}
          <button type="button" class="lh-btn" data-act="close">${reason && reason.askDate ? "Pause" : "Stop"}</button>
        </div>
        ${reason && reason.dnc ? '<small class="fe-note">This also puts them on the do-not-contact list.</small>' : ""}`;
    }

    p.innerHTML = `
      <div class="rc-p-top"><h3>${esc(c.patientName || "Unknown patient")}</h3>
        <button type="button" class="lh-btn is-quiet" data-act="deselect" aria-label="Close">×</button></div>
      <p class="rc-sub">${esc(sub)}${c.lastServices.length ? `<br>${esc(c.lastServices.join(", "))}` : ""}</p>
      ${c.reply ? `<div class="rc-reply${c.replyOpen ? " is-open" : ""}"><strong>${esc(REPLY_TAG[c.reply.kind] || "Replied")} · ${esc(when(c.reply.at))}</strong>
        <p>${esc(c.reply.text)}</p></div>` : ""}
      <div class="rc-links">
        ${tel ? `<a class="lh-btn" href="tel:${esc(tel)}">Call ${esc(mobileText(c.mobile))}</a>` : '<span class="rc-nomob">No mobile on file</span>'}
        ${tel && c.status !== "closed" ? '<button type="button" class="lh-btn" data-act="sms">Send text</button>' : ""}
        ${c.email ? `<a class="lh-btn is-quiet" href="mailto:${esc(c.email)}">Email</a>` : ""}
        ${c.patientId ? `<a class="lh-btn is-quiet" href="#/patient/${encodeURIComponent(c.patientId)}">Patient page</a>` : ""}
      </div>
      ${draft.sms == null ? "" : `<div class="rc-sms">
        <textarea class="fe-input" data-role="sms" rows="4" maxlength="560" aria-label="Text message">${esc(draft.sms)}</textarea>
        <div class="rc-row"><small class="fe-note" data-role="smsInfo">${esc(smsInfo(draft.sms))}</small><span class="inv-spacer"></span>
          <button type="button" class="lh-btn is-quiet" data-act="sms-cancel">Cancel</button>
          <button type="button" class="btn-primary" data-act="sms-send">Send to ${esc(mobileText(c.mobile))}</button></div>
      </div>`}
      ${c.status === "closed" ? "" : `<div class="rc-row">Given to
        <select class="fb-select" data-role="assign" aria-label="Given to">
          <option value="">Nobody yet (waiting)</option>${ppl.map((s) =>
            `<option value="${esc(s.id)}"${s.id === c.assignedToId ? " selected" : ""}>${esc(s.name)}${team.size && !team.has(s.id) ? " (not in the recall team)" : ""}</option>`).join("")}
        </select></div>`}
      ${work}
      <h4 class="rc-h">History</h4>
      <ul class="rc-log">${c.log.slice().reverse().map((l) => `<li><strong>${esc(l.what)}</strong>
        ${l.note ? `<p>${esc(l.note)}</p>` : ""}<small>${esc(when(l.at))}${l.by ? ` · ${esc(l.by)}` : ""}</small></li>`).join("")}</ul>`;
  }

  function openCard(id) {
    sel = id;
    seenSel = inRows(id);
    draft = blank();
    drawList();
    drawPanel(true);
    const row = root.querySelector(`[data-card="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function select(id) {
    if (sel === id) { sel = ""; seenSel = false; draft = blank(); drawList(); drawPanel(true); return; }
    openCard(id);
  }
  // After logging a call: the next open card that was below this one
  function goNext(fromId, ids) {
    const i = ids.indexOf(fromId);
    const next = ids.slice(i + 1).find((id) => { const c = findCard(id); return c && c.status === "open"; });
    if (next) openCard(next);
  }

  async function act(op, extraBody, btn) {
    if (busy || !sel) return false;
    const id = sel;
    busy = true;
    if (btn) btn.disabled = true;
    try {
      const res = await callApi({ action: "recall", op, id, ...extraBody });
      if (res && res.problem) { showToast(res.problem); return false; }
      scheduleCounts(800);
      if (!inRows(id)) keepOpen(id);
      return true;
    } catch (err) {
      showToast(errText(err, "Couldn't save. Try again."));
      return false;
    } finally {
      busy = false;
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  async function keepOpen(id) {
    try { const s = await getDoc(doc(db, COL, id)); if (s.exists()) extra.set(id, norm(s)); } catch { /* the panel just closes */ }
    if (sel === id) drawPanel(true);
  }

  /* ---------- Events ---------- */
  root.addEventListener("input", (e) => {
    const r = e.target.dataset.role;
    if (r === "q") {
      ui.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 300);
    } else if (r === "note") draft.note = e.target.value;
    else if (r === "sms") {
      draft.sms = e.target.value;
      const info = $("smsInfo");
      if (info) info.textContent = smsInfo(draft.sms);
    }
  });
  root.addEventListener("change", async (e) => {
    const el = e.target;
    const r = el.dataset.role;
    if (r === "who") { ui.who = el.value; sel = ""; build(); return; }
    if (r === "lv") {
      ui.lv = el.value;
      sel = "";
      if (ui.lv === "custom" && !ui.lvFrom && !ui.lvTo) { drawLv(); return; }   // wait for a date
      build();
      return;
    }
    if (r === "lvFrom" || r === "lvTo") { ui[r] = el.value; sel = ""; build(); return; }
    if (r === "auto") { autoNext = el.checked; setPref("rc_autonext", autoNext); return; }
    if (r === "remind") { draft.remind = el.value; drawPanel(true); return; }
    if (r === "until") { draft.until = el.value; return; }
    if (r === "reason") { draft.reason = el.value; drawPanel(true); return; }
    if (r === "assign" && !(await act("assign", { toId: el.value }, el))) drawPanel(true);
  });
  root.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest(".rc-item");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(row.dataset.card); }
  });
  root.addEventListener("click", async (e) => {
    if (e.target.closest('a[href^="tel:"], a[href^="mailto:"]')) return;
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
    const qb = e.target.closest("[data-quick]");
    if (qb) {
      const k = qb.dataset.quick;
      const ids = shownIds(), from = sel;
      if (await act("log", { outcome: k, note: "", remindOn: "" }, qb)) {
        showToast(`${LABEL[k]}: saved`);
        if (autoNext) goNext(from, ids);
      }
      return;
    }
    const row = e.target.closest("[data-card]");
    if (row) { select(row.dataset.card); return; }
    const out = e.target.closest("[data-out]");
    if (out) { draft.out = draft.out === out.dataset.out ? "" : out.dataset.out; drawPanel(true); return; }

    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "deselect") { sel = ""; drawList(); drawPanel(true); return; }
    if (b.dataset.act === "sms") {
      const c = findCard(sel);
      if (!c) return;
      draft.sms = fillSms(c);
      drawPanel(true);
      const ta = $("sms");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    if (b.dataset.act === "sms-cancel") { draft.sms = null; drawPanel(true); return; }
    if (b.dataset.act === "sms-send") {
      if (String(draft.sms || "").trim().length < 10) { showToast("Write the message first."); return; }
      if (await act("text", { text: draft.sms }, b)) { draft.sms = null; drawPanel(true); showToast("Text sent"); }
      return;
    }
    if (b.dataset.act === "details") {
      const p = $("panel");
      p.scrollIntoView({ behavior: "smooth", block: "start" });
      const note = p.querySelector('[data-role="note"]');
      if (note) note.focus({ preventScroll: true });
      return;
    }
    if (b.dataset.act === "save") {
      if (!draft.out && !draft.note.trim() && !draft.remind) { showToast("Choose what happened, or write a note."); return; }
      const ids = shownIds(), from = sel, logged = !!draft.out;
      if (await act("log", { outcome: draft.out, note: draft.note, remindOn: draft.remind }, b)) {
        draft = { ...draft, out: "", note: "", remind: "" };
        drawPanel(true);
        showToast("Saved");
        if (autoNext && logged) goNext(from, ids);
      }
      return;
    }
    if (b.dataset.act === "close") {
      const r = settings.reasons.find((x) => x.label === draft.reason);
      if (!r) { showToast("Choose a reason."); return; }
      if (r.askDate && !draft.until) { showToast("Choose when to start recalling them again."); return; }
      if (r.dnc && !(await confirmDialog({ title: "Don't contact again?", message: "Recall stops, and they go on the do-not-contact list for marketing emails.", confirmLabel: "Stop and add to the list", tone: "danger" }))) return;
      const ids = shownIds(), from = sel;
      if (await act("close", { reason: r.label, until: draft.until, note: draft.note }, b)) {
        draft = blank();
        drawPanel(true);
        showToast(r.askDate ? "Paused" : "Recall stopped");
        if (autoNext) goNext(from, ids);
      }
      return;
    }
    if (b.dataset.act === "reopen") {
      if (await act("reopen", {}, b)) showToast("Reopened");
    }
  });

  window.addEventListener("hashchange", function off() {
    setTimeout(() => {
      if (!root.isConnected) { stopAll(); clearTimeout(countTimer); clearTimeout(searchTimer); window.removeEventListener("hashchange", off); }
    }, 0);
  });

  /* ---------- Start ---------- */
  getDoc(doc(db, "recall_settings", "config"))
    .then((s) => { settings = normRecallSettings(s.exists() ? s.data() : {}); drawWho(); drawChips(); drawPanel(true); scheduleCounts(0); })
    .catch(() => {});
  callApi({ action: "staffList" }).then((r) => { people = (r && r.staff) || []; drawWho(); drawPanel(true); }).catch(() => {});
  drawStats();
  build();
}