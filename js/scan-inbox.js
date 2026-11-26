// Scan Inbox: everything scanned on the ScanSnap from the switch-on date, read and filed by itself.
// Scans it couldn't file wait for someone with "File scans the portal couldn't match".
// Billing sheets become follow-ups (book the next appointments, do the handwritten jobs).
// Everything goes through Apps Script (ScanInbox.gs, ScanFollowups.gs; action "scanInbox").
// Route: #/scan-inbox[/mine|/followups|/all]
import { callApi } from "./appointments.js";
import { escapeHtml as esc, showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";
import { can, isAdmin } from "./perms.js";

const POLL_MS = 30000;
const KINDS = [
  ["billing", "Billing sheet"], ["consent", "Consent"], ["rx", "Prescription"], ["treatment", "Treatment record"],
];
const NOT_RECORD = ["Blank page", "Scanned twice", "Not a patient record", "Other"];
const TABS = ["today", "mine", "followups", "all"];

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  inbox: svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  alert: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="15"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>'),
  doc: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
  refresh: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-2.82-1.17l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.09 14H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.17-2.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9.91 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.91 10H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  left: svg('<polyline points="15 18 9 12 15 6"/>'),
  right: svg('<polyline points="9 18 15 12 9 6"/>'),
  drive: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  cal: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  calPlus: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="14" x2="12" y2="19"/><line x1="9.5" y1="16.5" x2="14.5" y2="16.5"/>'),
  list: svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  ext: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
};

IC.flask = svg('<path d="M9 3h6"/><path d="M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><line x1="7" y1="15" x2="17" y2="15"/>');

/* ---------- Small helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const shiftDay = (k, n) => { const [y, m, d] = k.split("-").map(Number); return keyOf(new Date(y, m - 1, d + n)); };
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase(); };
const fmtDay = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); if (!m) return ""; return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }); };
const fmtLong = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); if (!m) return ""; return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }); };
const dayOfIso = (iso) => { const d = new Date(iso); return isNaN(d) ? todayKey() : keyOf(d); };
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
const first = (n) => String(n || "").trim().split(/\s+/)[0] || "";
const api = (op, body = {}) => callApi({ action: "scanInbox", op, ...body });
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

let staffMemo = null;
async function staffList() {
  if (staffMemo) return staffMemo;
  try { const r = await callApi({ action: "staffList" }); staffMemo = (r.staff || []).filter((s) => s.name); }
  catch { staffMemo = []; }
  return staffMemo;
}

/* ---------- Entry ---------- */

export async function mountScanInbox(container, { param = "", staff = null } = {}) {
  injectStyles();
  const canFile = can("scans.file");
  const canAll = can("scans.all") || canFile;
  const canBook = can("scans.book") || can("scans.all");
  const admin = isAdmin();
  const me = staff && staff.uid ? staff.uid : "";
  const root = document.createElement("section");
  root.className = "page wide si";
  root.innerHTML = '<div class="si-wrap"><div class="skeleton sm"></div></div>';
  container.replaceChildren(root);

  const sub = String(param || "").split("/")[0];
  const st = {
    tab: TABS.includes(sub) ? sub : "today", day: todayKey(), data: null, error: "", checking: false,
    fuScope: "mine", fuMore: "", busyFu: "",
  };
  if (st.tab === "all" && !canAll) st.tab = "today";
  const thumbs = new Map();
  let thumbBusy = false;

  async function load() {
    try {
      const res = await api("list", { day: st.day });
      if (!root.isConnected) return;
      if (res.problem) { st.error = res.problem; render(); return; }
      st.data = res; st.error = "";
      render();
    } catch (err) {
      console.error("Scan Inbox not loaded:", err);
      if (!root.isConnected) return;
      st.error = err && /FORBIDDEN/.test(String(err.message || err)) ? "Ask an Admin to tick a Scan Inbox box for you in Staff."
        : "Couldn't load the Scan Inbox. Check your connection.";
      render();
    }
  }
  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    if (document.visibilityState === "visible" && !st.busyFu && !st.fuMore) load();
  }, POLL_MS);

  const fu = () => (st.data && st.data.followUps) || { mine: [], all: [], canAll: false };
  const myOpen = (type) => fu().mine.filter((f) => f.status === "open" && f.type === type);

  function headLine(d) {
    if (!d) return "";
    if (!d.on) return '<span class="si-live is-off"></span>Not switched on yet';
    const last = d.lastCheck ? fmtTime(d.lastCheck) : "";
    if (d.open && (!d.lastCheck || Date.now() - Date.parse(d.lastCheck) > 5 * 60000)) {
      return `<span class="si-live is-warn"></span>${last ? `Hasn't checked the scan folder since ${esc(last)}` : "Hasn't checked the scan folder yet"}`;
    }
    return `<span class="si-live${d.open ? "" : " is-off"}"></span>${d.open ? "Watching the scan folder" : "After hours: checks every 15 minutes"}${
      last ? ` · last check ${esc(last)}` : ""}`;
  }

  /* ---- The page ---- */
  function render() {
    const d = st.data;
    if (!d && !st.error) return;
    const c = (d && d.counts) || {};
    const mine = (d && d.mine) || [];
    const isToday = st.day === todayKey();
    const nBook = myOpen("book").length, nTask = myOpen("task").length;
    const tabs = [["today", "Today", 0], ["mine", "To file", mine.length], ["followups", "Follow-ups", nBook + nTask],
      ...(canAll ? [["all", "Everyone", c.needsAll || 0]] : [])];
    root.innerHTML = `<div class="si-wrap">
      <header class="si-head">
        <span class="si-logo">${IC.inbox}</span>
        <div class="si-head-main"><h2>${greeting()}${staff && staff.name ? `, ${esc(first(staff.name))}` : ""}</h2>
          <p>${headLine(d)}</p></div>
        <div class="si-head-acts">
          ${canFile || admin ? `<button type="button" class="si-ghost" data-act="check" ${st.checking ? "disabled" : ""}>${IC.refresh}<span>${st.checking ? "Checking…" : "Check now"}</span></button>` : ""}
          ${admin ? `<button type="button" class="si-ghost" data-act="test">${IC.flask}<span>Test on past scans</span></button>` : ""}
          ${admin ? `<button type="button" class="si-ghost" data-act="settings">${IC.gear}<span>Settings</span></button>` : ""}
        </div>
      </header>
      ${st.error ? `<div class="si-note is-bad">${esc(st.error)}</div>` : ""}
      ${d && d.lastError && (canFile || admin) ? `<div class="si-note is-warn">The last check stopped with a problem: ${esc(d.lastError.split("|")[1] || d.lastError)}. ${
        admin ? "Apps Script → Executions has the details." : "Let an Admin know."}</div>` : ""}
      ${d && !d.on ? `<div class="si-off"><strong>The Scan Inbox isn't switched on yet.</strong>
        <span>Once it is, every sheet scanned on the ScanSnap is read and filed here by itself. Scans from before then stay in Paper records.</span>
        ${admin ? '<button type="button" class="si-primary" data-act="settings">Switch it on</button>' : "<span>Ask an Admin to switch it on.</span>"}</div>` : ""}
      ${d ? `
      <p class="si-sec">Needs you</p>
      <div class="si-tiles">
        <button type="button" class="si-tile ${mine.length ? "is-warn" : ""}" data-tab="mine">
          <span class="si-ti is-warn">${IC.alert}</span><strong>${mine.length}</strong><span>${mine.length === 1 ? "Scan" : "Scans"} to file</span></button>
        <button type="button" class="si-tile ${nBook ? "is-hot" : ""}" data-tab="followups">
          <span class="si-ti is-acc">${IC.calPlus}</span><strong>${nBook}</strong><span>${nBook === 1 ? "Appointment" : "Appointments"} to book</span></button>
        <button type="button" class="si-tile" data-tab="followups">
          <span class="si-ti is-mut">${IC.list}</span><strong>${nTask}</strong><span>${nTask === 1 ? "Task" : "Tasks"}</span></button>
        <button type="button" class="si-tile" data-tab="today" data-today="1">
          <span class="si-ti is-ok">${IC.check}</span><strong>${isToday ? c.filed || 0 : "–"}</strong><span>Filed by itself today</span></button>
      </div>
      <div class="si-bar">
        <div class="si-seg" role="tablist">${tabs.map(([k, l, n]) =>
          `<button type="button" role="tab" aria-selected="${st.tab === k}" class="${st.tab === k ? "is-on" : ""}" data-tab="${k}">${l}${n ? `<em>${n}</em>` : ""}</button>`).join("")}</div>
        ${st.tab === "today" ? `<div class="si-day">
          <button type="button" class="si-icon" data-day="-1" aria-label="Day before">${IC.left}</button>
          <span>${isToday ? "Today" : esc(fmtDay(st.day))}</span>
          <button type="button" class="si-icon" data-day="1" aria-label="Day after" ${isToday ? "disabled" : ""}>${IC.right}</button>
          ${isToday ? "" : '<button type="button" class="si-link" data-day="0">Back to today</button>'}</div>` : ""}
        ${st.tab === "followups" && fu().canAll ? `<div class="si-seg is-sm">${[["mine", "Mine"], ["all", "Everyone's"]].map(([k, l]) =>
          `<button type="button" class="${st.fuScope === k ? "is-on" : ""}" data-scope="${k}">${l}</button>`).join("")}</div>` : ""}
        <span class="si-sp"></span>
        ${st.tab === "today" ? `<span class="si-stat">${plural(c.scanned || 0, "scan")} · ${c.filed || 0} filed by itself${
          c.followUps ? ` · ${plural(c.followUps, "follow-up")}` : ""}</span>` : ""}
      </div>
      ${st.tab === "followups" ? fuHtml() : `<div class="si-list">${rowsHtml()}</div>`}` : ""}
    </div>`;
    loadThumbs();
  }

  /* ---- Scans ---- */
  function scanList() {
    const d = st.data || {};
    if (st.tab === "mine") return d.mine || [];
    if (st.tab === "all") return d.all || [];
    return d.items || [];
  }
  function rowsHtml() {
    const list = scanList();
    if (!list.length) {
      const msg = st.tab === "mine" ? ["All clear", "There's nothing for you to file."]
        : st.tab === "all" ? ["All clear", "Every scan has been filed."]
        : st.day === todayKey() ? ["Nothing scanned yet today", "Scans show up here about a minute after the ScanSnap saves them."]
        : ["Nothing scanned that day", ""];
      return `<div class="si-empty">${IC.inbox}<strong>${msg[0]}</strong>${msg[1] ? `<span>${msg[1]}</span>` : ""}</div>`;
    }
    return list.map(rowHtml).join("");
  }
  function rowHtml(it) {
    const r = it.read || {};
    const name = it.patientName || r.patientName;
    const reading = it.status === "reading";
    const time = st.tab === "today" ? fmtTime(it.created) : `${fmtDay(dayOfIso(it.created))}<br>${fmtTime(it.created)}`;
    let title, subline = "", right;
    if (reading) {
      title = '<span class="si-muted">Reading the scan…</span>';
      const wait = it.nextTryAt > Date.now();
      subline = it.error ? `<span class="si-bad">${esc(it.error)}</span>${wait ? ` · tries again at ${esc(fmtTime(it.nextTryAt))}` : ""}` : "Usually about a minute";
      right = '<span class="si-pill is-mut"><span class="si-spin"></span>Reading</span>';
    } else if (it.status === "needs") {
      title = name ? `“${esc(name)}”` : '<span class="si-muted">No name read</span>';
      subline = `${esc(it.kindName || "Scan")} · <span class="si-warn">${esc(it.reasonText)}</span>${
        st.tab !== "mine" && it.assignedToName ? ` · with ${esc(first(it.assignedToName))}` : ""}${it.help ? ' · <span class="si-warn">help asked</span>' : ""}`;
      right = canFile ? '<span class="si-btn">File it</span>' : '<span class="si-pill is-warn">Needs filing</span>';
    } else if (it.status === "filed") {
      title = esc(it.patientName || name || "Patient");
      const chips = [];
      if (r.nextAppts && r.nextAppts.length) chips.push(`${r.nextAppts.length} to book`);
      if (r.tasks && r.tasks.length) chips.push(plural(r.tasks.length, "task"));
      if (r.quotes && r.quotes.length) chips.push("Quote");
      subline = chips.length ? chips.map((x) => `<span class="si-chip">${esc(x)}</span>`).join("")
        : `${esc(it.kindName)}${it.filedBy && it.filedBy !== "Scan Inbox" ? ` · filed by ${esc(first(it.filedBy))}` : ""}`;
      right = '<span class="si-pill is-ok">Filed</span>';
    } else if (it.status === "paper") {
      title = esc(name || "Treatment record");
      subline = `${esc(it.kindName || "Scan")} · in Paper records, for the products used`;
      right = '<span class="si-pill is-acc">Paper records</span>';
    } else if (it.status === "notrecord") {
      title = esc(name || it.name); subline = "Not a patient record";
      right = '<span class="si-pill is-mut">Not a record</span>';
    } else if (it.status === "kept") {
      title = esc(it.kindName || "Scan");
      subline = `${r.title ? `${esc(r.title)} · ` : ""}kept in ${esc(it.keptIn || "Google Drive")}`;
      right = '<span class="si-pill is-mut">Kept</span>';
    } else {
      title = esc(it.name); subline = "Removed from Google Drive";
      right = '<span class="si-pill is-mut">Removed</span>';
    }
    return `<button type="button" class="si-row" data-open="${esc(it.id)}">
      <span class="si-th" ${reading ? "" : `data-thumb="${esc(it.id)}"`}>${thumbs.get(it.id) ? `<img alt="" src="${esc(thumbs.get(it.id))}">` : reading ? '<span class="si-spin"></span>' : IC.doc}</span>
      <span class="si-time">${time}</span>
      <span class="si-main"><strong>${title}</strong><small>${subline}</small></span>
      ${right}</button>`;
  }

  /* ---- Follow-ups ---- */
  function fuHtml() {
    const all = st.fuScope === "all" && fu().canAll;
    const list = all ? fu().all : fu().mine;
    const open = list.filter((f) => f.status === "open");
    const book = open.filter((f) => f.type === "book").sort((a, b) => String(a.sheetDate).localeCompare(String(b.sheetDate)));
    const tasks = open.filter((f) => f.type === "task").sort((a, b) => String(a.sheetDate).localeCompare(String(b.sheetDate)));
    const done = all ? [] : list.filter((f) => f.status !== "open").sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
    if (!open.length && !done.length) {
      return `<div class="si-list"><div class="si-empty">${IC.calPlus}<strong>No follow-ups${all ? "" : " for you"}</strong>
        <span>Next appointments and jobs written on billing sheets show up here once the sheet is filed.</span></div></div>`;
    }
    const sec = (title, items, hint) => (items.length ? `<div class="si-fu-sec"><div class="si-fu-h"><h3>${title}</h3><span>${items.length}</span>${hint ? `<small>${hint}</small>` : ""}</div>
      <div class="si-list">${items.map((f) => fuRow(f, all)).join("")}</div></div>` : "");
    return sec("To book", book, "Booked ones close by themselves when they show up in the calendar")
      + sec("Tasks", tasks, "")
      + (done.length ? `<details class="si-fu-sec si-done"><summary><h3>Done lately</h3><span>${done.length}</span></summary>
          <div class="si-list">${done.map((f) => fuRow(f, false)).join("")}</div></details>` : "");
  }
  function fuRow(f, showWho) {
    const open = f.status === "open";
    const mineFu = f.assignedToId === me;
    const may = mineFu || canBook;
    const meta = [
      f.sheetDate && `From the sheet on ${fmtDay(f.sheetDate)}`,
      f.prefers && `Prefers ${f.prefers}`,
      f.price && f.type === "book" && f.price,
      f.attempts && `Tried ${f.attempts}×${f.lastTryAt ? `, last ${fmtDay(dayOfIso(f.lastTryAt))}` : ""}`,
      showWho && f.assignedToName && `With ${first(f.assignedToName)}`,
    ].filter(Boolean);
    let state = "";
    if (f.status === "booked") state = `<span class="si-pill is-ok">${f.foundBy === "calendar" ? `Found in calendar${f.bookedFor ? ` · ${esc(fmtDay(f.bookedFor))}` : ""}` : `Booked${f.bookedFor ? ` · ${esc(fmtDay(f.bookedFor))}` : ""}`}</span>`;
    else if (f.status === "done") state = '<span class="si-pill is-ok">Done</span>';
    else if (f.status === "notneeded") state = '<span class="si-pill is-mut">Not needed</span>';
    const busy = st.busyFu === f.id;
    const acts = !may ? "" : open ? `${f.type === "book"
        ? `<button type="button" class="si-fbtn is-pri" data-fu="booked" data-id="${esc(f.id)}" ${busy ? "disabled" : ""}>Booked</button>
           <button type="button" class="si-fbtn" data-fu="noanswer" data-id="${esc(f.id)}" ${busy ? "disabled" : ""}>Couldn't reach</button>`
        : `<button type="button" class="si-fbtn is-pri" data-fu="done" data-id="${esc(f.id)}" ${busy ? "disabled" : ""}>Done</button>`}
        <button type="button" class="si-icon" data-fumore="${esc(f.id)}" aria-label="More" title="More">${IC.more}</button>`
      : `${state}${f.closedBy !== "Calendar" ? `<button type="button" class="si-link" data-fu="reopen" data-id="${esc(f.id)}">Reopen</button>` : ""}`;
    const moreOpen = st.fuMore === f.id;
    return `<div class="si-fu ${open ? "" : "is-closed"}">
      <span class="si-fu-ic ${f.type === "book" ? "is-book" : "is-task"}">${f.type === "book" ? IC.calPlus : IC.list}</span>
      <div class="si-fu-main">
        <div class="si-fu-top"><a href="#/patient/${encodeURIComponent(f.patientId)}" target="_blank" rel="noopener">${esc(f.patientName || "Patient")}${IC.ext}</a>
          ${f.checkSheet && open ? '<span class="si-chip is-warn">Check the sheet</span>' : ""}</div>
        <strong>${esc(f.title)}</strong>
        ${meta.length ? `<small>${meta.map(esc).join(" · ")}</small>` : ""}
      </div>
      <div class="si-fu-acts">${acts}</div>
      ${moreOpen ? `<div class="si-fu-more">
        <button type="button" class="si-fbtn" data-fu="notneeded" data-id="${esc(f.id)}">Not needed</button>
        <button type="button" class="si-fbtn" data-sheet="${esc(f.scanId)}">See the sheet</button>
        <label class="si-f si-inline-sel"><select data-give="${esc(f.id)}"><option value="">Give to…</option></select></label>
      </div>` : ""}
    </div>`;
  }
  async function fuAct(id, outcome) {
    if (st.busyFu) return;
    st.busyFu = id; render();
    try {
      const res = await api("fuAct", { id, outcome });
      if (res && res.problem) showToast(res.problem);
      else showToast({ booked: "Marked as booked", noanswer: "Noted. It stays on your list.", done: "Done", notneeded: "Taken off the list", reopen: "Back on the list" }[outcome] || "Saved");
    } catch (err) { console.error("Follow-up not saved:", err); showToast("That didn't save. Try again."); }
    st.busyFu = ""; st.fuMore = "";
    load();
  }
  async function fillGive() {
    const sel = root.querySelector("[data-give]");
    if (!sel) return;
    const list = await staffList();
    if (!sel.isConnected) return;
    sel.innerHTML = '<option value="">Give to…</option>' + list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  }

  /* ---- Thumbnails ---- */
  async function loadThumbs() {
    if (thumbBusy || !root.isConnected) return;
    const want = [...new Set([...root.querySelectorAll("[data-thumb]")].map((e) => e.dataset.thumb))].filter((id) => !thumbs.has(id)).slice(0, 12);
    if (!want.length) return;
    thumbBusy = true;
    want.forEach((id) => thumbs.set(id, null));
    try {
      const res = await api("thumbs", { ids: want });
      Object.entries((res && res.thumbs) || {}).forEach(([id, u]) => thumbs.set(id, u || ""));
    } catch (err) { console.warn("Scan pictures not loaded:", err); want.forEach((id) => thumbs.set(id, "")); }
    thumbBusy = false;
    root.querySelectorAll("[data-thumb]").forEach((el) => {
      const u = thumbs.get(el.dataset.thumb);
      if (u && !el.querySelector("img")) el.innerHTML = `<img alt="" src="${esc(u)}">`;
    });
    loadThumbs();
  }

  async function openById(id) {
    const d = st.data || {};
    let it = [...(d.items || []), ...(d.mine || []), ...(d.all || [])].find((x) => x.id === id);
    if (!it) {
      try { const res = await api("item", { fileId: id }); if (res.problem) { showToast(res.problem); return; } it = res.item; }
      catch { showToast("The sheet couldn't be opened."); return; }
    }
    openScan(it, { canFile, onDone: load, types: (st.data && st.data.types) || [] });
  }

  /* ---- Taps ---- */
  root.addEventListener("change", async (e) => {
    const g = e.target.closest("[data-give]");
    if (!g || !g.value) return;
    try {
      const res = await api("fuAssign", { id: g.dataset.give, toId: g.value });
      if (res && res.problem) showToast(res.problem);
      else showToast("Passed on");
    } catch { showToast("That didn't save. Try again."); }
    st.fuMore = "";
    load();
  });
  root.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("a[href]")) return;
    const tab = t.closest("[data-tab]");
    if (tab) {
      st.tab = tab.dataset.tab;
      if (tab.dataset.today) st.day = todayKey();
      history.replaceState(null, "", `#/scan-inbox${st.tab === "today" ? "" : `/${st.tab}`}`);
      if (tab.dataset.today) load(); else render();
      return;
    }
    const sc = t.closest("[data-scope]");
    if (sc) { st.fuScope = sc.dataset.scope; render(); return; }
    const day = t.closest("[data-day]");
    if (day) {
      const n = Number(day.dataset.day);
      st.day = n === 0 ? todayKey() : shiftDay(st.day, n);
      if (st.day > todayKey()) st.day = todayKey();
      const list = root.querySelector(".si-list");
      if (list) list.innerHTML = '<div class="si-empty"><span class="si-spin"></span></div>';
      load();
      return;
    }
    const fa = t.closest("[data-fu]");
    if (fa) { fuAct(fa.dataset.id, fa.dataset.fu); return; }
    const fm = t.closest("[data-fumore]");
    if (fm) { st.fuMore = st.fuMore === fm.dataset.fumore ? "" : fm.dataset.fumore; render(); fillGive(); return; }
    const sh = t.closest("[data-sheet]");
    if (sh) { openById(sh.dataset.sheet); return; }
    const open = t.closest("[data-open]");
    if (open) { openById(open.dataset.open); return; }
    const a = t.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "settings") openSettings(load);
    else if (a.dataset.act === "test") openTest();
    else if (a.dataset.act === "check") {
      st.checking = true; render();
      try {
        const r = await api("checkNow");
        if (r.recent) showToast("It was checked a moment ago.");
        else if (r.off) showToast("The Scan Inbox isn't switched on.");
        else if (r.busy) showToast("It's checking right now. Give it a minute.");
        else showToast([r.added ? `${plural(r.added, "new scan")} found` : "No new scans", r.read ? `${r.read} read` : "",
          r.waiting ? `${r.waiting} still waiting, read over the next few minutes` : ""].filter(Boolean).join(" · "));
      } catch (err) { console.error("Check failed:", err); showToast("Couldn't check the folder. Try again."); }
      st.checking = false;
      load();
    }
  });

  await load();
}

/* ===================== One scan, full screen ===================== */

function readHtml(r) {
  if (!r) return '<p class="si-muted">Not read yet.</p>';
  const row = (k, v) => (v ? `<div class="si-kv"><span>${k}</span><strong>${v}</strong></div>` : "");
  const conf = r.patientName && r.nameConfidence < 0.6 ? ' <em class="si-warn">(not sure)</em>' : "";
  const p = r.payment || null;
  const list = (arr, fn) => (arr && arr.length ? `<ul class="si-ul">${arr.map(fn).join("")}</ul>` : "");
  return `${row("Name", r.patientName ? esc(r.patientName) + conf : '<em class="si-muted">Couldn\'t read it</em>')}
    ${row("Date", esc(fmtLong(r.date)))}${row("Time", esc(r.time))}${row("With", esc(r.provider))}${row("Form", esc(r.title))}
    ${p ? row("Paid", [p.fee != null ? `$${Number(p.fee).toFixed(2)}` : "", p.tyroRef && `Tyro ${esc(p.tyroRef)}`, p.checkedOut && "checked out"].filter(Boolean).join(" · ")) : ""}
    ${r.nextAppts && r.nextAppts.length ? `<div class="si-kv-h">Next appointments</div>${list(r.nextAppts, (a) =>
      `<li><strong>${esc(a.service || a.text)}</strong>${[a.staff, a.minutes && `${a.minutes} min`, a.when, a.dateGuess && `about ${fmtDay(a.dateGuess)}`, a.price].filter(Boolean).map((x) => ` · ${esc(x)}`).join("")}</li>`)}` : ""}
    ${r.tasks && r.tasks.length ? `<div class="si-kv-h">Tasks</div>${list(r.tasks, (x) => `<li>${esc(x.text)}${x.who ? ` · <em>${esc(x.who)}</em>` : ""}</li>`)}` : ""}
    ${r.preferredTimes ? `<div class="si-kv-h">Prefers</div><p class="si-p">${esc(r.preferredTimes)}</p>` : ""}
    ${r.quotes && r.quotes.length ? `<div class="si-kv-h">Quotes</div>${list(r.quotes, (q) => `<li>${esc(q.text)}${q.price ? ` · ${esc(q.price)}` : ""}</li>`)}` : ""}
    ${r.notes ? `<div class="si-kv-h">Notes</div><p class="si-p">${esc(r.notes)}</p>` : ""}`;
}

const FU_STATE = { open: ["Open", "is-warn"], booked: ["Booked", "is-ok"], done: ["Done", "is-ok"], notneeded: ["Not needed", "is-mut"],
  cancelled: ["Cancelled", "is-mut"], info: ["Saved", "is-acc"] };

function openScan(it, { canFile, onDone, types = [] }) {
  injectStyles();
  const r = it.read || {};
  const typeOf = (k) => types.find((t) => t.id === k) || null;
  const s = {
    pt: it.patientId ? { id: it.patientId, name: it.patientName, note: it.apptTime ? `Booked ${it.apptTime}${it.staff ? ` with ${it.staff}` : ""}` : "" } : null,
    kind: KINDS.some(([k]) => k === it.kind) || typeOf(it.kind) ? it.kind : "",
    date: it.recordDate || r.date || dayOfIso(it.created), clin: it.staff || r.provider || "", title: r.title || "",
    meds: [""], mode: "", results: null, bookings: null, busy: false, fus: null, adding: false, tname: "", thint: "",
  };
  const dlg = document.createElement("dialog");
  dlg.className = "si si-dlg";
  dlg.setAttribute("aria-label", "Scan");
  dlg.innerHTML = `<div class="si-dlg-h">
      <div><h3>${esc(it.kindName || "Scan")}</h3><p>Scanned ${esc(fmtDay(dayOfIso(it.created)))} at ${esc(fmtTime(it.created))}</p></div>
      <div class="si-dlg-acts">${it.link ? `<a class="si-ghost" href="${esc(it.link)}" target="_blank" rel="noopener">${IC.drive}<span>Open in Drive</span></a>` : ""}
        <button type="button" class="si-icon" data-x aria-label="Close">${IC.x}</button></div></div>
    <div class="si-dlg-b"><div class="si-view" data-role="view"><span class="si-spin"></span></div><div class="si-side" data-role="side"></div></div>`;
  document.body.appendChild(dlg);
  const side = dlg.querySelector('[data-role="side"]');
  const view = dlg.querySelector('[data-role="view"]');
  let blobUrl = "";
  const close = () => { if (blobUrl) URL.revokeObjectURL(blobUrl); if (dlg.open) dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });

  api("file", { fileId: it.id }).then((res) => {
    if (!dlg.isConnected) return;
    if (!res || res.problem || !res.data) {
      view.innerHTML = `<div class="si-view-msg">${esc((res && res.problem) || "The scan couldn't be shown.")}${it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">Open it in Drive</a>` : ""}</div>`;
      return;
    }
    const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
    blobUrl = URL.createObjectURL(new Blob([bytes], { type: res.mime }));
    if (res.mime === "application/pdf") view.innerHTML = `<iframe title="Scan" src="${blobUrl}#view=FitH"></iframe>`;
    else if (/heic|heif/i.test(res.mime)) view.innerHTML = `<div class="si-view-msg">This photo type can't be shown here.<a href="${esc(it.link)}" target="_blank" rel="noopener">Open it in Drive</a></div>`;
    else {
      view.innerHTML = `<img alt="The scan" src="${blobUrl}" title="Tap to zoom">`;
      view.querySelector("img").addEventListener("click", () => view.classList.toggle("is-zoom"));
    }
  }).catch((err) => {
    console.error("Scan not shown:", err);
    if (dlg.isConnected) view.innerHTML = '<div class="si-view-msg">The scan couldn\'t be shown. Check your connection.</div>';
  });

  // The follow-ups made from a filed billing sheet
  if (it.status === "filed" && it.kind === "billing") {
    api("scanFollowups", { fileId: it.id }).then((res) => {
      s.fus = (res && res.followUps) || [];
      if (dlg.isConnected) paint();
    }).catch(() => { s.fus = []; if (dlg.isConnected) paint(); });
  }
  function fusHtml() {
    if (it.status !== "filed" || it.kind !== "billing") return "";
    if (s.fus === null) return '<div class="si-loading"><span class="si-spin"></span>Loading the follow-ups…</div>';
    if (!s.fus.length) return '<p class="si-hint">Nothing to follow up was written on this sheet.</p>';
    return `<div class="si-kv-h">Follow-ups from this sheet</div><div class="si-fus">${s.fus.map((f) => {
      const [label, cls] = FU_STATE[f.status] || ["", "is-mut"];
      return `<div class="si-fus-row"><span>${esc(f.title)}${f.type !== "quote" && f.assignedToName ? `<small>${esc(f.assignedToName)}</small>` : ""}</span>
        <span class="si-pill ${cls}">${esc(f.foundBy === "calendar" ? "Found in calendar" : label)}</span></div>`;
    }).join("")}</div>`;
  }

  function sideHtml() {
    const reason = it.status === "needs" ? `<div class="si-banner is-warn">${IC.alert}<div><strong>${esc(it.reasonText || "Needs filing")}</strong>
        ${it.help ? `<span>Help asked: “${esc(it.help)}”</span>` : ""}${it.assignedToName ? `<span>With ${esc(it.assignedToName)}</span>` : ""}</div></div>` : "";
    const readBox = `<details class="si-read" ${it.status === "needs" ? "open" : ""}><summary>What the portal read</summary>${readHtml(it.read)}</details>`;
    const hist = (it.history || []).length ? `<details class="si-read"><summary>History</summary><ul class="si-ul">${it.history.slice().reverse().map((h) =>
      `<li>${esc(h.what)}<br><small>${esc(h.by)} · ${esc(fmtDay(dayOfIso(h.at)))} ${esc(fmtTime(h.at))}</small></li>`).join("")}</ul></details>` : "";
    const putBack = canFile ? '<button type="button" class="si-ghost" data-a="undo">Put it back to file again</button>' : "";

    if (it.status === "reading") {
      return `<div class="si-banner"><span class="si-spin"></span><div><strong>Reading the scan…</strong><span>${esc(it.error || "Usually about a minute.")}</span></div></div>
        ${canFile && it.error ? '<button type="button" class="si-ghost" data-a="retry">Read it again now</button>' : ""}${hist}`;
    }
    if (it.status === "filed") {
      return `<div class="si-banner is-ok">${IC.check}<div><strong>Filed for ${esc(it.patientName)}</strong>
        <span>${esc(it.kindName)} · ${esc(fmtLong(it.recordDate))} · ${it.filedBy === "Scan Inbox" ? "by itself" : `by ${esc(it.filedBy)}`}</span></div></div>
        <div class="si-acts"><a class="si-primary" href="#/patient/${encodeURIComponent(it.patientId)}" target="_blank" rel="noopener">Open the patient's page</a>${putBack}</div>
        ${fusHtml()}${readBox}${hist}`;
    }
    if (it.status === "paper") {
      return `<div class="si-banner is-acc">${IC.doc}<div><strong>In Paper records</strong><span>Treatment records are filed there, where the products used are entered.</span></div></div>
        <div class="si-acts"><a class="si-primary" href="#/paper">Open Paper records</a>${putBack}</div>${readBox}${hist}`;
    }
    if (it.status === "kept") {
      return `<div class="si-banner is-ok">${IC.check}<div><strong>Kept in ${esc(it.keptIn || "Google Drive")}</strong>
        <span>${esc(it.kindName)} · ${it.filedBy === "Scan Inbox" ? "by itself" : `by ${esc(it.filedBy)}`}</span></div></div>
        <div class="si-acts">${putBack}</div>${readBox}${hist}`;
    }
    if (it.status === "notrecord" || it.status === "gone") {
      return `<div class="si-banner">${IC.doc}<div><strong>${it.status === "gone" ? "Removed from Google Drive" : "Not a patient record"}</strong></div></div>
        ${it.status === "notrecord" ? `<div class="si-acts">${putBack}</div>` : ""}${readBox}${hist}`;
    }
    if (!canFile) return `${reason}<p class="si-hint">Someone with "File scans the portal couldn't match" sorts this one out.</p>${readBox}${hist}`;
    const sugg = (it.suggestions || []).filter((x) => x.patientId || x.ptt);
    const treat = s.kind === "treatment";
    const custom = typeOf(s.kind);
    const kindBtn = (k, l) => `<button type="button" class="${s.kind === k ? "is-on" : ""}" data-kind="${esc(k)}">${esc(l)}</button>`;
    const who = `
      <div class="si-step"><span>2</span><h4>Who is it?</h4></div>
      ${s.pt ? `<div class="si-pt"><span class="si-av">${esc(first(s.pt.name).slice(0, 1) || "?")}</span><div><strong>${esc(s.pt.name)}</strong>${s.pt.note ? `<small>${esc(s.pt.note)}</small>` : ""}</div>
          <button type="button" class="si-link" data-a="clearpt">Change</button></div>`
        : `${sugg.length ? `<p class="si-lbl">Could it be</p><div class="si-cards">${sugg.map((x, i) =>
            `<button type="button" class="si-card" data-sugg="${i}"><strong>${esc(x.name)}</strong><small>${x.source === "booking"
              ? `Booked ${esc(fmtDay(x.date))}${x.time ? ` ${esc(x.time)}` : ""}${x.staff ? ` with ${esc(x.staff)}` : ""}` : "No booking that day"}</small></button>`).join("")}</div>` : ""}
          <div class="si-search">${IC.search}<input type="search" data-role="q" placeholder="Search by name, mobile or date of birth" autocomplete="off"></div>
          <div data-role="results">${s.results || ""}</div>
          <button type="button" class="si-link" data-a="bookings">${IC.cal}See who was booked on ${esc(fmtDay(s.date))}</button>
          <div data-role="bookings">${s.bookings || ""}</div>`}
      <div class="si-step"><span>3</span><h4>Details</h4></div>
      <div class="si-fields">
        <label class="si-f"><span>Date on the paper</span><input type="date" data-f="date" value="${esc(s.date)}" max="${todayKey()}"></label>
        <label class="si-f"><span>Clinician</span><input data-f="clin" value="${esc(s.clin)}" placeholder="e.g. Dr Teh"></label>
        ${s.kind === "consent" ? `<label class="si-f si-wide"><span>Which consent</span><input data-f="title" value="${esc(s.title)}" placeholder="e.g. Consent for laser treatment"></label>` : ""}
        ${s.kind === "rx" ? `<div class="si-f si-wide"><span>What was prescribed</span>${s.meds.map((m, i) =>
          `<input data-med="${i}" value="${esc(m)}" placeholder="Medicine ${i + 1}">`).join("")}
          <button type="button" class="si-link" data-a="addmed">+ Another medicine</button></div>` : ""}
      </div>
      ${s.kind === "billing" && ((r.nextAppts || []).length || (r.tasks || []).length)
        ? `<p class="si-hint">Filing it makes ${plural((r.nextAppts || []).length + (r.tasks || []).length, "follow-up")} from what's written on it.</p>` : ""}`;
    return `${reason}${readBox}
      <div class="si-step"><span>1</span><h4>What is it?</h4></div>
      <div class="si-kinds">${KINDS.map(([k, l]) => kindBtn(k, l)).join("")}${types.map((t) => kindBtn(t.id, t.name)).join("")}
        <button type="button" class="si-kind-add${s.adding ? " is-on" : ""}" data-a="addtype">+ Something else</button></div>
      ${s.adding ? `<div class="si-addtype">
        <label class="si-f"><span>What is it called?</span><input data-f="tname" value="${esc(s.tname)}" maxlength="40" placeholder="e.g. Delivery docket"></label>
        <label class="si-f"><span>How can the portal spot one? <small>Optional. It also learns from each one you keep.</small></span>
          <textarea data-f="thint" rows="2" maxlength="300" placeholder="e.g. A supplier's packing slip with product codes and quantities">${esc(s.thint)}</textarea></label>
        <div class="si-acts"><button type="button" class="si-primary sm" data-a="savetype" ${s.busy ? "disabled" : ""}>Save and use it</button>
          <button type="button" class="si-link" data-a="canceltype">Cancel</button></div></div>` : ""}
      ${treat ? '<p class="si-hint">Treatment records go to Paper records, where the products used are entered and taken off stock.</p>'
        : custom ? `<p class="si-hint">${esc(custom.name)} scans are kept in their own Google Drive folder, not on a patient's page.</p>` : who}
      <div class="si-acts">
        <button type="button" class="si-primary" data-a="${treat ? "topaper" : custom ? "keep" : "file"}" ${s.busy ? "disabled" : ""}>${
          s.busy ? "Saving…" : treat ? "Send to Paper records" : custom ? "Keep it" : "File it"}</button>
      </div>
      <div class="si-more">
        ${treat ? "" : '<button type="button" data-a="topaper">Send to Paper records</button>'}
        <button type="button" data-mode="notrecord" class="${s.mode === "notrecord" ? "is-on" : ""}">Not a patient record</button>
        <button type="button" data-mode="help" class="${s.mode === "help" ? "is-on" : ""}">Ask for help</button>
        <button type="button" data-mode="assign" class="${s.mode === "assign" ? "is-on" : ""}">Give to someone</button>
        <button type="button" data-a="retry">Read it again</button>
      </div>
      <div data-role="mode">${modeHtml()}</div>${hist}`;
  }
  
  function modeHtml() {
    if (s.mode === "notrecord") return `<div class="si-inline"><label class="si-f"><span>What is it?</span>
      <select data-f="why">${NOT_RECORD.map((x) => `<option>${x}</option>`).join("")}</select></label>
      <button type="button" class="si-primary sm" data-a="notrecord">Save</button></div>`;
    if (s.mode === "help") return `<div class="si-inline"><label class="si-f si-wide"><span>What do you need help with?</span>
      <textarea data-f="help" rows="2" placeholder="e.g. Can't read the surname"></textarea></label>
      <button type="button" class="si-primary sm" data-a="help">Ask</button></div>`;
    if (s.mode === "assign") return `<div class="si-inline"><label class="si-f"><span>Give it to</span><select data-f="to"><option value="">Loading…</option></select></label>
      <button type="button" class="si-primary sm" data-a="assign">Give</button></div>`;
    return "";
  }
  function paint() {
    side.innerHTML = sideHtml();
    if (s.mode === "assign") staffList().then((list) => {
      const sel = side.querySelector('[data-f="to"]');
      if (sel) sel.innerHTML = '<option value="">Nobody</option>' + list.map((x) => `<option value="${esc(x.id)}" ${x.id === it.assignedToId ? "selected" : ""}>${esc(x.name)}</option>`).join("");
    });
  }

  async function act(op, body = {}, done = "") {
    if (s.busy) return;
    s.busy = true; paint();
    try {
      const res = await api(op, { fileId: it.id, ...body });
      if (res && res.problem) { showToast(res.problem); return; }
      showToast(op === "fileIt" && res.followUps ? `${done} · ${plural(res.followUps, "follow-up")} made`
        : op === "keepIt" && res.keptIn ? `Kept in ${res.keptIn}` : done || "Saved");
      close();
      onDone();
    } catch (err) {
      console.error(`Scan Inbox ${op} failed:`, err);
      showToast("That didn't save. Check your connection and try again.");
    } finally {
      s.busy = false;
      if (dlg.isConnected) paint();
    }
  }

  async function saveType() {
    const name = s.tname.trim();
    if (name.length < 2) { showToast("Type what it's called, e.g. Delivery docket."); return; }
    if (s.busy) return;
    s.busy = true; paint();
    try {
      const res = await api("addType", { name, hint: s.thint.trim() });
      if (res && res.problem) { showToast(res.problem); return; }
      types.push(res.type);
      Object.assign(s, { kind: res.type.id, adding: false, tname: "", thint: "" });
      showToast(`${res.type.name} saved. The portal looks for these from now on.`);
    } catch (err) {
      console.error("Scan kind not saved:", err);
      showToast("That didn't save. Try again.");
    } finally {
      s.busy = false;
      if (dlg.isConnected) paint();
    }
  }

  let qT = 0, qSeq = 0;
  dlg.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.role === "q") {
      clearTimeout(qT);
      qT = setTimeout(async () => {
        const box = side.querySelector('[data-role="results"]');
        if (!box) return;
        if (t.value.trim().length < 2) { box.innerHTML = s.results = ""; return; }
        const seq = ++qSeq;
        box.innerHTML = '<div class="si-loading"><span class="si-spin"></span>Searching…</div>';
        try {
          const res = await api("search", { q: t.value });
          if (seq !== qSeq) return;
          const list = (res.results || []).slice(0, 8);
          s.results = list.length ? `<div class="si-cards">${list.map((x) =>
            `<button type="button" class="si-card" data-pick="${esc(x.id)}" data-name="${esc(x.name)}"><strong>${esc(x.name)}</strong><small>${
              [x.dob && fmtLong(x.dob), x.mobile].filter(Boolean).map(esc).join(" · ") || "&nbsp;"}</small></button>`).join("")}</div>`
            : '<p class="si-hint">No patients found. Try part of the first or last name.</p>';
          box.innerHTML = s.results;
        } catch { if (seq === qSeq) box.innerHTML = '<p class="si-hint">Search didn\'t work. Check your connection.</p>'; }
      }, 300);
      return;
    }
    if (t.dataset.f === "date") s.date = t.value;
    else if (t.dataset.f === "clin") s.clin = t.value;
    else if (t.dataset.f === "title") s.title = t.value;
    else if (t.dataset.f === "tname") s.tname = t.value;
    else if (t.dataset.f === "thint") s.thint = t.value;
    else if (t.dataset.med !== undefined) s.meds[Number(t.dataset.med)] = t.value;
  });

  dlg.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-x]")) { close(); return; }
    const sg = t.closest("[data-sugg]");
    if (sg) {
      const x = (it.suggestions || []).filter((y) => y.patientId || y.ptt)[Number(sg.dataset.sugg)];
      s.pt = { id: x.patientId || x.ptt, name: x.name, note: x.source === "booking" ? `Booked ${x.time || ""}${x.staff ? ` with ${x.staff}` : ""}` : "" };
      if (x.date) s.date = x.date;
      if (x.staff && !s.clin) s.clin = x.staff;
      paint(); return;
    }
    const pk = t.closest("[data-pick]");
    if (pk) { s.pt = { id: pk.dataset.pick, name: pk.dataset.name, note: "" }; paint(); return; }
    const bk = t.closest("[data-book]");
    if (bk) {
      s.pt = { id: bk.dataset.book, name: bk.dataset.name, note: `Booked ${bk.dataset.time}${bk.dataset.staff ? ` with ${bk.dataset.staff}` : ""}` };
      if (bk.dataset.staff && !s.clin) s.clin = bk.dataset.staff;
      paint(); return;
    }
    const kd = t.closest("[data-kind]");
    if (kd) { s.kind = kd.dataset.kind; s.adding = false; paint(); return; }
    const md = t.closest("[data-mode]");
    if (md) { s.mode = s.mode === md.dataset.mode ? "" : md.dataset.mode; paint(); return; }
    const a = t.closest("[data-a]");
    if (!a) return;
    const op = a.dataset.a;
    if (op === "clearpt") { s.pt = null; paint(); }
    else if (op === "addmed") { s.meds.push(""); paint(); }
    else if (op === "addtype") {
      s.adding = !s.adding;
      if (s.adding && !s.thint && r.title) s.thint = `The printed title says "${r.title}"`;
      paint();
      if (s.adding) side.querySelector('[data-f="tname"]')?.focus();
    }
    else if (op === "canceltype") { s.adding = false; paint(); }
    else if (op === "savetype") saveType();
    else if (op === "keep") act("keepIt", { as: s.kind }, "Kept");
    else if (op === "bookings") {
      const box = side.querySelector('[data-role="bookings"]');
      box.innerHTML = '<div class="si-loading"><span class="si-spin"></span>Loading the bookings…</div>';
      try {
        const res = await api("bookings", { date: s.date });
        const list = res.bookings || [];
        s.bookings = list.length ? `<div class="si-books">${list.map((b) => {
          const id = b.patientId || b.ptt;
          return `<button type="button" class="si-book" ${id ? `data-book="${esc(id)}"` : "disabled"} data-name="${esc(b.name)}" data-time="${esc(b.time)}" data-staff="${esc(b.staff)}">
            <span>${esc(b.time)}</span><strong>${esc(b.name)}</strong><small>${esc(b.staff)}${id ? "" : " · not linked to a patient"}</small></button>`;
        }).join("")}</div>` : '<p class="si-hint">Nobody was booked that day.</p>';
        box.innerHTML = s.bookings;
      } catch { box.innerHTML = '<p class="si-hint">The bookings couldn\'t be loaded.</p>'; }
    }
    else if (op === "file") {
      if (!s.pt) { showToast("Choose who it is first."); return; }
      if (!s.kind) { showToast("Choose what it is."); return; }
      if (!s.date) { showToast("Choose the date on the paper."); return; }
      const meds = s.meds.map((m) => m.trim()).filter(Boolean);
      if (s.kind === "rx" && !meds.length) { showToast("Type what was prescribed."); return; }
      act("fileIt", { as: s.kind, patientId: s.pt.id, recordDate: s.date, clinician: s.clin,
        title: s.kind === "consent" ? (s.title.trim() || "Consent") : "", items: meds.map((m) => ({ product: m, custom: true })) },
        `Filed for ${s.pt.name}`);
    }
    else if (op === "topaper") act("toPaper", {}, "Sent to Paper records");
    else if (op === "retry") act("retry", {}, "It will be read again in a minute");
    else if (op === "notrecord") act("notRecord", { reason: side.querySelector('[data-f="why"]').value }, "Marked as not a patient record");
    else if (op === "help") {
      const note = side.querySelector('[data-f="help"]').value.trim();
      if (!note) { showToast("Say what you need help with."); return; }
      act("help", { note }, "Help asked");
    }
    else if (op === "assign") act("assign", { toId: side.querySelector('[data-f="to"]').value }, "Done");
    else if (op === "undo") {
      if (!(await confirmDialog({ title: "Put it back to file again?",
        message: it.status === "filed" ? "It's taken off the patient's page, its open follow-ups are cancelled, and it goes back on the list to file." : "It goes back on the list to file.",
        confirmLabel: "Put it back", tone: "warning" }))) return;
      act("undo", {}, "Back on the list");
    }
  });

  paint();
  dlg.showModal();
}

/* ===================== Settings (Admins) ===================== */

async function openSettings(onDone) {
  injectStyles();
  let cur;
  try { cur = await api("settings"); } catch { showToast("Settings couldn't be loaded."); return; }
  const startKey = cur.startAt ? dayOfIso(cur.startAt) : "";
  const hours = Array.from({ length: 25 }, (_, h) => h);
  const hText = (h) => (h === 0 || h === 24 ? "midnight" : h === 12 ? "midday" : `${h % 12} ${h < 12 ? "am" : "pm"}`);
  const typeRow = (t) => `<div class="si-type" data-tid="${esc(t.id)}">
    <div class="si-fields">
      <label class="si-f"><span>Name</span><input data-tf="name" value="${esc(t.name)}" maxlength="40"></label>
      <label class="si-f"><span>Google Drive folder ${t.folderId ? `· <a href="https://drive.google.com/drive/folders/${esc(t.folderId)}" target="_blank" rel="noopener">Open</a>` : ""}</span>
        <input data-tf="folder" placeholder="Paste a folder link to change it"></label>
      <label class="si-f si-wide"><span>How the portal spots one</span><textarea data-tf="hint" rows="2" maxlength="300">${esc(t.hint)}</textarea></label>
    </div>
    ${t.seen && t.seen.length ? `<p class="si-hint">Learnt from ones kept before: ${t.seen.map(esc).join(" · ")}</p>` : ""}
    <div class="si-type-acts">
      <label class="si-switch"><input type="checkbox" data-tf="auto" ${t.auto ? "checked" : ""}><span class="si-sw"></span><span><strong>Keep these by itself</strong><small>No one checks them first</small></span></label>
      <button type="button" class="si-link si-type-del" data-tdel>Remove</button>
    </div></div>`;
  const dlg = document.createElement("dialog");
  dlg.className = "si si-dlg si-set";
  dlg.innerHTML = `<div class="si-dlg-h"><div><h3>Scan Inbox settings</h3><p>Only Admins see these.</p></div>
      <button type="button" class="si-icon" data-x aria-label="Close">${IC.x}</button></div>
    <div class="si-set-b">
      <label class="si-switch"><input type="checkbox" data-s="on" ${cur.on ? "checked" : ""}><span class="si-sw"></span><span><strong>Switched on</strong><small>Read and file new scans from the ScanSnap</small></span></label>
      <label class="si-f"><span>Handle scans from</span><input type="date" data-s="start" value="${esc(startKey)}" max="${todayKey()}">
        <small>Scans from before this date stay in Paper records. ${startKey ? "" : "Empty: from the moment it's switched on."}</small></label>
      <div class="si-fields">
        <label class="si-f"><span>Check from</span><select data-s="from">${hours.slice(0, 24).map((h) => `<option value="${h}" ${h === cur.fromHour ? "selected" : ""}>${hText(h)}</option>`).join("")}</select></label>
        <label class="si-f"><span>Until</span><select data-s="to">${hours.slice(1).map((h) => `<option value="${h}" ${h === cur.toHour ? "selected" : ""}>${hText(h)}</option>`).join("")}</select></label>
      </div>
      <label class="si-switch"><input type="checkbox" data-s="bill" ${cur.autoBilling ? "checked" : ""}><span class="si-sw"></span><span><strong>File billing sheets by themselves</strong><small>When exactly one booking that day clearly matches</small></span></label>
      <label class="si-switch"><input type="checkbox" data-s="cons" ${cur.autoConsent ? "checked" : ""}><span class="si-sw"></span><span><strong>File consents by themselves</strong><small>The same check as billing sheets</small></span></label>
      <p class="si-hint">Treatment records always go to Paper records, and prescriptions always wait for a person to check the medicines.</p>
      <div class="si-types"><strong>Other kinds of scan</strong>
        ${(cur.types || []).length ? cur.types.map(typeRow).join("")
          : '<p class="si-hint">None yet. When filing a scan, staff choose "+ Something else" to add one.</p>'}
      </div>
    </div>
    <div class="si-dlg-f"><button type="button" class="si-ghost" data-x>Cancel</button><button type="button" class="si-primary" data-save>Save</button></div>`;
  document.body.appendChild(dlg);
  const close = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.addEventListener("click", async (e) => {
    if (e.target.closest("[data-x]")) { close(); return; }
    const del = e.target.closest("[data-tdel]");
    if (del) {
      const row = del.closest("[data-tid]");
      const name = row.querySelector('[data-tf="name"]').value;
      if (await confirmDialog({ title: `Remove ${name}?`, message: "The portal stops looking for these. Scans already kept stay in their Google Drive folder. It's removed when you press Save.",
        confirmLabel: "Remove", tone: "warning" })) row.hidden = true;
      return;
    }
    const sv = e.target.closest("[data-save]");
    if (!sv) return;
    const q = (k) => dlg.querySelector(`[data-s="${k}"]`);
    const start = q("start").value;
    if (start && start !== startKey && startKey && !(await confirmDialog({ title: "Change the start date?",
      message: "Scans move between Paper records and the Scan Inbox to match the new date. Anything already filed stays filed.",
      confirmLabel: "Change it", tone: "warning" }))) return;
    sv.disabled = true; sv.textContent = "Saving…";
    try {
      const res = await api("saveSettings", { on: q("on").checked, startDate: start, fromHour: Number(q("from").value),
        toHour: Number(q("to").value), autoBilling: q("bill").checked, autoConsent: q("cons").checked,
        types: [...dlg.querySelectorAll("[data-tid]")].filter((row) => !row.hidden).map((row) => ({
          id: row.dataset.tid, name: row.querySelector('[data-tf="name"]').value, hint: row.querySelector('[data-tf="hint"]').value,
          folder: row.querySelector('[data-tf="folder"]').value, auto: row.querySelector('[data-tf="auto"]').checked })) });
      if (res.problem) { showToast(res.problem); return; }
      showToast("Settings saved");
      close();
      onDone();
    } catch (err) { console.error("Settings not saved:", err); showToast("Couldn't save. Try again."); }
    finally { if (dlg.isConnected) { sv.disabled = false; sv.textContent = "Save"; } }
  });
  dlg.showModal();
}

/* ===================== Test on past scans (Admins, read only) ===================== */

const WOULD = { file: ["Would file by itself", "is-ok"], keep: ["Would keep it by itself", "is-ok"], paper: ["Would go to Paper records", "is-acc"], needs: ["Would wait for someone", "is-warn"] };
const LIVE = { reading: "being read", needs: "waiting to be filed", filed: "filed", kept: "kept in its folder", paper: "in Paper records", notrecord: "marked not a record", gone: "removed" };

async function openTest() {
  injectStyles();
  const t = { from: todayKey(), to: todayKey(), data: null, running: false, stop: false, sel: "", busy: false };
  const thumbs = new Map();
  let thumbBusy = false, blobUrl = "", viewSeq = 0;
  const dlg = document.createElement("dialog");
  dlg.className = "si si-dlg";
  dlg.setAttribute("aria-label", "Test on past scans");
  dlg.innerHTML = `<div class="si-dlg-h">
      <div><h3>Test on past scans</h3><p>Reads the scans and shows what it would do. Nothing is filed, and nothing changes in Paper records.</p></div>
      <button type="button" class="si-icon" data-x aria-label="Close">${IC.x}</button></div>
    <div class="si-dlg-b"><div class="si-view" data-role="view"><div class="si-view-msg">Choose a scan to see it here.</div></div>
      <div class="si-side" data-role="side"><div class="si-loading"><span class="si-spin"></span>Loading…</div></div></div>`;
  document.body.appendChild(dlg);
  const side = dlg.querySelector('[data-role="side"]');
  const view = dlg.querySelector('[data-role="view"]');
  const close = () => { t.stop = true; if (blobUrl) URL.revokeObjectURL(blobUrl); if (dlg.open) dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  const counts = () => (t.data && t.data.counts) || {};
  const rows = () => (t.data && t.data.rows) || [];
  const aiName = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

  function summaryHtml() {
    const k = counts();
    const total = rows().length;
    if (!total) return "";
    const doneN = (k.done || 0) + (k.error || 0) + (k.sorted || 0);
    const run = t.data.run;
    const chip = (n, label, cls) => (n ? `<span class="si-pill ${cls}">${n} ${label}</span>` : "");
    return `<div class="si-tsum">
      <div class="si-tsum-h"><strong>${run ? `${esc(fmtDay(run.from))}${run.to !== run.from ? ` to ${esc(fmtDay(run.to))}` : ""}` : ""}</strong>
        <span>${doneN} of ${plural(total, "scan")} done${k.queued ? (t.running ? " · reading…" : " · paused") : ""}</span></div>
      <div class="si-prog"><span style="width:${Math.round((doneN * 100) / total)}%"></span></div>
      <div class="si-tchips">${chip(k.file, "would file by itself", "is-ok")}${chip(k.paper, "to Paper records", "is-acc")}${
        chip(k.keep, "would keep by itself", "is-ok") + chip(k.needs, "would wait", "is-warn")}${chip(k.sorted, "already sorted", "is-mut")}${chip(k.error, "couldn't read", "is-bad")}</div>
    </div>`;
  }

  function detailHtml(x) {
    const drive = x.link ? `<a class="si-link" href="${esc(x.link)}" target="_blank" rel="noopener">${IC.drive}Open in Drive</a>` : "";
    if (x.status !== "done") return drive ? `<div class="si-tdet"><div class="si-tmeta"><span></span>${drive}</div></div>` : "";
    const m = x.match;
    let banner;
    if (x.would === "file") {
      banner = `<div class="si-banner is-ok">${IC.check}<div><strong>Would file it for ${esc(m.name)}</strong>
        <span>${esc(x.kindName)} · ${esc(fmtLong(m.date))}${m.time ? ` · ${esc(m.time)}` : ""}${m.staff ? ` with ${esc(m.staff)}` : ""}</span>
        ${x.fus ? `<span>Would make ${plural(x.fus.book, "appointment")} to book and ${plural(x.fus.task, "task")}${
          x.fus.quote ? `, and save ${plural(x.fus.quote, "quote")}` : ""}</span>` : ""}</div></div>`;
    } else if (x.would === "keep") {
      banner = `<div class="si-banner is-ok">${IC.check}<div><strong>Would keep it by itself</strong><span>${esc(x.kindName)} · in its own Google Drive folder</span></div></div>`;
    } else if (x.would === "paper") {
      banner = `<div class="si-banner is-acc">${IC.doc}<div><strong>Would go to Paper records</strong>
        <span>${m && x.confident ? `Looks like ${esc(m.name)} (${esc(fmtLong(m.date))})` : "Treatment records are filed there, where the products used are entered."}</span></div></div>`;
    } else {
      banner = `<div class="si-banner is-warn">${IC.alert}<div><strong>Would wait for someone to file it</strong><span>${esc(x.whyText)}</span></div></div>`;
    }
    const sugg = !x.confident && x.sugg.length ? `<div class="si-kv-h">It would suggest</div><ul class="si-ul">${x.sugg.map((s) =>
      `<li><strong>${esc(s.name)}</strong>${s.source === "booking"
        ? ` · booked ${esc(fmtDay(s.date))}${s.time ? ` ${esc(s.time)}` : ""}${s.staff ? ` with ${esc(s.staff)}` : ""}` : " · no booking that day"}${
        s.patientId ? "" : ' · <em class="si-warn">not linked to a patient</em>'}</li>`).join("")}</ul>` : "";
    const meta = [x.ms && `Read in ${(x.ms / 1000).toFixed(1)} s`, x.ai && `with ${aiName(x.ai)}`,
      x.live && `In the live Scan Inbox: ${LIVE[x.live] || x.live}`].filter(Boolean).join(" · ");
    return `<div class="si-tdet">${banner}${sugg}
      <details class="si-read" open><summary>What it read</summary>${readHtml(x.read)}</details>
      <div class="si-tmeta"><span>${esc(meta)}</span>${drive}</div></div>`;
  }

  function rowHtml(x) {
    const r = x.read || {};
    let title, sub, pill;
    if (x.status === "queued") {
      title = '<span class="si-muted">Waiting to be read</span>';
      sub = esc(x.name);
      pill = t.running ? '<span class="si-pill is-mut"><span class="si-spin"></span>Reading</span>' : '<span class="si-pill is-mut">Waiting</span>';
    } else if (x.status === "sorted") {
      title = esc(x.name);
      sub = `Already sorted in Paper records (${esc(x.sorted)}), so it isn't read`;
      pill = '<span class="si-pill is-mut">Skipped</span>';
    } else if (x.status === "error") {
      title = '<span class="si-muted">Couldn\'t read it</span>';
      sub = `<span class="si-bad">${esc(x.error)}</span>`;
      pill = '<span class="si-pill is-bad">Not read</span>';
    } else {
      const [label, cls] = WOULD[x.would] || ["", "is-mut"];
      const m = x.match;
      title = r.patientName ? `“${esc(r.patientName)}”` : '<span class="si-muted">No name read</span>';
      sub = `${esc(x.kindName || "Scan")} · ${x.would === "file" && m
        ? `for ${esc(m.name)}${m.time ? ` · booked ${esc(m.time)}` : ""}${m.staff ? ` with ${esc(m.staff)}` : ""}`
        : x.would === "paper" ? "products entered there" : x.would === "keep" ? "kept in its own folder" : `<span class="si-warn">${esc(x.whyText)}</span>`}`;
      pill = `<span class="si-pill ${cls}">${label}</span>`;
    }
    const on = t.sel === x.id;
    return `<div class="si-tr${on ? " is-on" : ""}"><button type="button" class="si-row" data-row="${esc(x.id)}">
      <span class="si-th" data-tthumb="${esc(x.id)}">${thumbs.get(x.id) ? `<img alt="" src="${esc(thumbs.get(x.id))}">` : IC.doc}</span>
      <span class="si-time">${esc(fmtDay(dayOfIso(x.created)))}<br>${esc(fmtTime(x.created))}</span>
      <span class="si-main"><strong>${title}</strong><small>${sub}</small></span>${pill}</button>
      ${on ? detailHtml(x) : ""}</div>`;
  }

  function paint() {
    if (!dlg.isConnected) return;
    const keep = side.scrollTop;
    const k = counts();
    const has = rows().length > 0;
    side.innerHTML = `<div class="si-tctl">
        <div class="si-fields">
          <label class="si-f"><span>From</span><input type="date" data-t="from" value="${esc(t.from)}" max="${todayKey()}" ${t.running ? "disabled" : ""}></label>
          <label class="si-f"><span>To</span><input type="date" data-t="to" value="${esc(t.to)}" max="${todayKey()}" ${t.running ? "disabled" : ""}></label>
        </div>
        <div class="si-acts">${t.running
          ? '<button type="button" class="si-ghost" data-ta="stop">Stop</button>'
          : `<button type="button" class="si-primary sm" data-ta="start" ${t.busy ? "disabled" : ""}>${t.busy ? "Finding the scans…" : "Run test"}</button>
             ${k.queued ? '<button type="button" class="si-ghost" data-ta="carry">Carry on</button>' : ""}
             ${has ? '<button type="button" class="si-ghost" data-ta="clear">Clear results</button>' : ""}`}</div>
        <p class="si-hint">Uses the same reading and matching as the live Scan Inbox, with its current settings. About 4 scans a minute, and each one is a real AI read. Scans already sorted in Paper records are skipped.</p>
      </div>
      ${summaryHtml()}
      ${has ? `<div class="si-list">${rows().map(rowHtml).join("")}</div>`
        : t.data && !t.busy ? `<div class="si-empty">${IC.flask}<strong>No test results yet</strong><span>Choose the dates, then press Run test.</span></div>` : ""}`;
    side.scrollTop = keep;
    loadThumbs();
  }

  async function loadThumbs() {
    if (thumbBusy || !dlg.isConnected) return;
    const want = [...new Set([...side.querySelectorAll("[data-tthumb]")].map((e) => e.dataset.tthumb))].filter((id) => !thumbs.has(id)).slice(0, 12);
    if (!want.length) return;
    thumbBusy = true;
    want.forEach((id) => thumbs.set(id, null));
    try {
      const res = await api("thumbs", { ids: want });
      Object.entries((res && res.thumbs) || {}).forEach(([id, u]) => thumbs.set(id, u || ""));
    } catch { want.forEach((id) => thumbs.set(id, "")); }
    thumbBusy = false;
    side.querySelectorAll("[data-tthumb]").forEach((el) => {
      const u = thumbs.get(el.dataset.tthumb);
      if (u && !el.querySelector("img")) el.innerHTML = `<img alt="" src="${esc(u)}">`;
    });
    loadThumbs();
  }

  async function show(id) {
    const seq = ++viewSeq;
    view.classList.remove("is-zoom");
    view.innerHTML = '<span class="si-spin"></span>';
    try {
      const res = await api("file", { fileId: id });
      if (seq !== viewSeq || !dlg.isConnected) return;
      if (!res || res.problem || !res.data) {
        view.innerHTML = `<div class="si-view-msg">${esc((res && res.problem) || "The scan couldn't be shown.")}</div>`;
        return;
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      const bytes = Uint8Array.from(atob(res.data), (ch) => ch.charCodeAt(0));
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: res.mime }));
      if (res.mime === "application/pdf") view.innerHTML = `<iframe title="Scan" src="${blobUrl}#view=FitH"></iframe>`;
      else if (/heic|heif/i.test(res.mime)) view.innerHTML = '<div class="si-view-msg">This photo type can\'t be shown here. Open it in Drive.</div>';
      else {
        view.innerHTML = `<img alt="The scan" src="${blobUrl}" title="Tap to zoom">`;
        view.querySelector("img").addEventListener("click", () => view.classList.toggle("is-zoom"));
      }
    } catch {
      if (seq === viewSeq && dlg.isConnected) view.innerHTML = '<div class="si-view-msg">The scan couldn\'t be shown. Check your connection.</div>';
    }
  }

  async function run() {
    if (t.running) return;
    t.running = true; t.stop = false; paint();
    try {
      for (let guard = 0; guard < 120 && !t.stop && dlg.isConnected; guard++) {
        const res = await api("testRun");
        if (res && res.problem) { showToast(res.problem); break; }
        t.data = res; paint();
        if (!(res.counts && res.counts.queued)) break;
        if (res.busy) await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (err) {
      console.error("Scan test stopped:", err);
      showToast("The test stopped. Check your connection, then press Carry on.");
    }
    t.running = false;
    paint();
  }

  async function start() {
    if (!t.from || !t.to) { showToast("Choose the dates."); return; }
    if (t.from > t.to) { showToast("The From date needs to be on or before the To date."); return; }
    if (rows().length && !(await confirmDialog({ title: "Start a new test?", message: "The last test's results are replaced.",
      confirmLabel: "Start", tone: "warning" }))) return;
    t.busy = true; t.sel = ""; paint();
    let ok = false;
    try {
      const res = await api("testStart", { from: t.from, to: t.to });
      if (res.problem) showToast(res.problem);
      else {
        t.data = res;
        if (!res.rows.length) showToast("No scans were uploaded on those dates.");
        else ok = true;
      }
    } catch (err) { console.error("Scan test not started:", err); showToast("The test couldn't start. Try again."); }
    t.busy = false;
    paint();
    if (ok) run();
  }

  async function clear() {
    if (!(await confirmDialog({ title: "Clear the test results?", message: "Only the test results are deleted. Nothing else changes.",
      confirmLabel: "Clear", tone: "warning" }))) return;
    try { t.data = await api("testClear"); t.sel = ""; paint(); }
    catch { showToast("Couldn't clear them. Try again."); }
  }

  dlg.addEventListener("input", (e) => {
    const k = e.target.dataset.t;
    if (!k) return;
    t[k] = e.target.value;
    if (k === "from" && t.to && t.from > t.to) { t.to = t.from; const to = side.querySelector('[data-t="to"]'); if (to) to.value = t.to; }
  });
  dlg.addEventListener("click", (e) => {
    const el = e.target;
    if (el.closest("[data-x]")) { close(); return; }
    if (el.closest("a[href]")) return;
    const r = el.closest("[data-row]");
    if (r) { const id = r.dataset.row; t.sel = t.sel === id ? "" : id; paint(); if (t.sel) show(id); return; }
    const a = el.closest("[data-ta]");
    if (!a) return;
    if (a.dataset.ta === "start") start();
    else if (a.dataset.ta === "carry") run();
    else if (a.dataset.ta === "clear") clear();
    else if (a.dataset.ta === "stop") { t.stop = true; showToast("Stopping once the scans it's reading now are done."); }
  });

  dlg.showModal();
  try {
    const res = await api("testList");
    if (res.problem) { showToast(res.problem); t.data = { rows: [], counts: {} }; }
    else {
      t.data = res;
      if (res.run) { t.from = res.run.from; t.to = res.run.to; }
    }
  } catch { showToast("The last test couldn't be loaded."); t.data = { rows: [], counts: {} }; }
  paint();
}

/* ===================== Styles ===================== */

function injectStyles() {
  if (document.getElementById("si-styles-3")) return;
  document.getElementById("si-styles-1")?.remove();
  document.getElementById("si-styles-2")?.remove();
  const s = document.createElement("style");
  s.id = "si-styles-3";
  s.textContent = `
.si{--t:#0f766e;--t2:#14b8a6;--tl:#f0fdfa;--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--warn:#b45309;--warnl:#fffbeb;--ok:#047857;--okl:#ecfdf5}
.si svg{width:18px;height:18px;flex:none}
.si-wrap{max-width:1080px;margin:0 auto;padding:4px 4px 48px}
.si-head{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.si-logo{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;flex:none;background:linear-gradient(135deg,var(--t2),var(--t));color:#fff;box-shadow:0 6px 16px rgba(15,118,110,.25)}
.si-logo svg{width:24px;height:24px}
.si-head-main{flex:1;min-width:0}
.si-head h2{margin:0;font-size:22px;color:var(--ink)}
.si-head p{margin:3px 0 0;color:var(--mut);font-size:13.5px;display:flex;align-items:center;gap:7px}
.si-live{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:sipulse 2s infinite}
.si-live.is-off{background:#cbd5e1;animation:none}
@keyframes sipulse{70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.si-head-acts{display:flex;gap:8px}
.si-ghost{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 14px;border:1px solid var(--line);border-radius:11px;background:#fff;color:var(--ink);font-family:inherit;font-size:13.5px;font-weight:600;text-decoration:none;cursor:pointer;white-space:nowrap}
.si-ghost:hover{border-color:var(--t2);color:var(--t)}
.si-ghost:disabled{opacity:.6;cursor:progress}
.si-ghost svg{width:16px;height:16px}
.si-primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:48px;padding:0 22px;border:0;border-radius:13px;background:linear-gradient(135deg,var(--t2),var(--t));color:#fff;font-family:inherit;font-size:15px;font-weight:700;text-decoration:none;cursor:pointer;box-shadow:0 8px 20px rgba(15,118,110,.25)}
.si-primary:disabled{opacity:.6;cursor:progress}
.si-primary.sm{height:40px;padding:0 16px;font-size:14px;box-shadow:none}
.si-sec{margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8}
.si-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:24px}
.si-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:16px;border:1px solid var(--line);border-radius:16px;background:#fff;text-align:left;font-family:inherit;cursor:pointer;transition:.15s;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.si-tile:hover{border-color:#99f6e4;transform:translateY(-1px);box-shadow:0 6px 16px rgba(15,23,42,.06)}
.si-tile.is-warn{border-color:#fde68a;background:linear-gradient(#fff,#fffdf5)}
.si-tile.is-hot{border-color:#99f6e4;background:linear-gradient(#fff,#f7fefc)}
.si-tile strong{font-size:30px;line-height:1;color:var(--ink);font-weight:600}
.si-tile>span:last-child{font-size:13.5px;color:var(--mut)}
.si-ti{width:36px;height:36px;border-radius:11px;display:grid;place-items:center}
.si-ti.is-warn{background:var(--warnl);color:var(--warn)}.si-ti.is-acc{background:var(--tl);color:var(--t)}
.si-ti.is-ok{background:var(--okl);color:var(--ok)}.si-ti.is-mut{background:#f1f5f9;color:#475569}
.si-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.si-seg{display:inline-flex;padding:3px;border-radius:12px;background:#f1f5f9}
.si-seg button{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;padding:8px 16px;border-radius:9px;font-family:inherit;font-size:13.5px;font-weight:600;color:var(--mut);cursor:pointer}
.si-seg.is-sm button{padding:6px 12px;font-size:12.5px}
.si-seg button.is-on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(15,23,42,.1)}
.si-seg em{font-style:normal;font-size:11px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#f59e0b;color:#fff;display:grid;place-items:center}
.si-day{display:flex;align-items:center;gap:4px;font-size:13.5px;font-weight:600;color:var(--ink)}
.si-day>span{min-width:92px;text-align:center}
.si-icon{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--mut);cursor:pointer;flex:none}
.si-icon:hover:not(:disabled){color:var(--t);border-color:var(--t2)}
.si-icon:disabled{opacity:.35;cursor:default}
.si-link{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:6px 0;color:var(--t);font-family:inherit;font-size:13.5px;font-weight:600;cursor:pointer}
.si-link svg{width:15px;height:15px}
.si-sp{flex:1}
.si-stat{font-size:13px;color:var(--mut)}
.si-list{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.si-row{display:grid;grid-template-columns:52px 64px minmax(0,1fr) auto;gap:14px;align-items:center;width:100%;padding:12px 16px;border:0;border-top:1px solid var(--line);background:#fff;text-align:left;font-family:inherit;cursor:pointer;transition:background .12s}
.si-row:first-child{border-top:0}
.si-row:hover{background:#f8fafc}
.si-row:focus-visible{outline:2px solid var(--t2);outline-offset:-2px}
.si-th{width:52px;height:64px;border-radius:8px;border:1px solid var(--line);background:#f8fafc;display:grid;place-items:center;color:#94a3b8;overflow:hidden}
.si-th img{width:100%;height:100%;object-fit:cover}
.si-time{font-size:12.5px;color:var(--mut);line-height:1.35}
.si-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.si-main strong{font-size:15px;color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.si-main small{font-size:12.5px;color:var(--mut);display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.si-muted{color:var(--mut)!important;font-weight:500!important}
.si-warn{color:var(--warn)}.si-bad{color:#b91c1c}
.si-chip{font-size:11.5px;padding:2px 9px;border-radius:999px;background:#f1f5f9;color:#475569}
.si-chip.is-warn{background:var(--warnl);color:var(--warn);font-weight:600}
.si-pill{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:5px 12px;border-radius:999px;white-space:nowrap}
.si-pill.is-ok{background:var(--okl);color:var(--ok)}.si-pill.is-warn{background:var(--warnl);color:var(--warn)}
.si-pill.is-acc{background:var(--tl);color:var(--t)}.si-pill.is-mut{background:#f1f5f9;color:var(--mut)}
.si-btn{display:inline-flex;align-items:center;height:36px;padding:0 16px;border-radius:10px;background:var(--t);color:#fff;font-size:13.5px;font-weight:700;white-space:nowrap}
.si-row:hover .si-btn{background:#115e59}
.si-spin{width:16px;height:16px;border:2px solid #ccfbf1;border-top-color:var(--t);border-radius:50%;animation:sispin .8s linear infinite;flex:none}
@keyframes sispin{to{transform:rotate(360deg)}}
.si-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:48px 20px;text-align:center;color:var(--mut)}
.si-empty svg{width:34px;height:34px;color:#cbd5e1}
.si-empty strong{color:var(--ink);font-size:15px}
.si-empty span{font-size:13.5px;max-width:380px}
.si-off{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:20px;margin-bottom:22px;border-radius:16px;background:var(--tl);border:1px solid #99f6e4;color:#134e4a;font-size:14px}
.si-note{padding:12px 14px;border-radius:12px;margin-bottom:16px;font-size:13.5px}
.si-note.is-bad{background:#fef2f2;color:#991b1b}
/* Follow-ups */
.si-fu-sec{margin-bottom:20px}
.si-fu-h{display:flex;align-items:baseline;gap:8px;margin:0 2px 8px;flex-wrap:wrap}
.si-fu-h h3{margin:0;font-size:15px;color:var(--ink)}
.si-fu-h>span{font-size:12px;font-weight:700;color:var(--t);background:var(--tl);border-radius:999px;padding:1px 8px}
.si-fu-h small{font-size:12px;color:var(--mut)}
.si-done summary{list-style:none;cursor:pointer;display:flex;align-items:baseline;gap:8px;margin:0 2px 8px}
.si-done summary::-webkit-details-marker{display:none}
.si-done summary h3{margin:0;font-size:15px;color:var(--mut)}
.si-done summary>span{font-size:12px;font-weight:700;color:var(--mut);background:#f1f5f9;border-radius:999px;padding:1px 8px}
.si-fu{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 16px;border-top:1px solid var(--line);background:#fff}
.si-list>.si-fu:first-child{border-top:0}
.si-fu.is-closed{background:#fbfcfd}
.si-fu.is-closed strong{color:var(--mut)}
.si-fu-ic{width:40px;height:40px;border-radius:12px;display:grid;place-items:center}
.si-fu-ic.is-book{background:var(--tl);color:var(--t)}.si-fu-ic.is-task{background:#f1f5f9;color:#475569}
.si-fu-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.si-fu-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px}
.si-fu-top a{display:inline-flex;align-items:center;gap:4px;color:var(--mut);font-weight:600;text-decoration:none}
.si-fu-top a:hover{color:var(--t)}
.si-fu-top a svg{width:12px;height:12px}
.si-fu-main strong{font-size:15px;color:var(--ink);font-weight:600;line-height:1.35}
.si-fu-main small{font-size:12.5px;color:var(--mut);line-height:1.45}
.si-fu-acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.si-fbtn{height:38px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:#fff;font-family:inherit;font-size:13.5px;font-weight:600;color:#334155;cursor:pointer;white-space:nowrap}
.si-fbtn:hover:not(:disabled){border-color:var(--t2);color:var(--t)}
.si-fbtn.is-pri{background:var(--t);border-color:var(--t);color:#fff}
.si-fbtn.is-pri:hover:not(:disabled){background:#115e59;color:#fff}
.si-fbtn:disabled{opacity:.55;cursor:progress}
.si-fu-more{grid-column:2/-1;display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 12px;border-radius:12px;background:#f8fafc}
.si-inline-sel select{min-height:38px}
.si-fus{display:grid;gap:6px;margin-top:6px}
.si-fus-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;font-size:13.5px}
.si-fus-row>span:first-child{display:flex;flex-direction:column;min-width:0}
.si-fus-row small{font-size:12px;color:var(--mut)}
/* The scan, full screen */
.si-dlg{width:min(1240px,calc(100vw - 24px));max-width:none;height:min(860px,calc(100vh - 24px));max-height:none;padding:0;border:0;border-radius:20px;overflow:hidden;box-shadow:0 24px 60px rgba(15,23,42,.35);color:var(--ink)}
.si-dlg[open]{position:fixed;inset:0;margin:auto;display:flex;flex-direction:column}
.si-dlg::backdrop{background:rgba(15,23,42,.5);backdrop-filter:blur(2px)}
.si-dlg-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)}
.si-dlg-h h3{margin:0;font-size:18px}
.si-dlg-h p{margin:2px 0 0;font-size:13px;color:var(--mut)}
.si-dlg-acts{display:flex;gap:8px;align-items:center}
.si-dlg-b{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(360px,1fr)}
.si-view{background:#1e293b;display:grid;place-items:center;overflow:auto;min-height:0}
.si-view img{max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-in}
.si-view.is-zoom{place-items:start}
.si-view.is-zoom img{max-width:none;max-height:none;width:160%;cursor:zoom-out}
.si-view iframe{width:100%;height:100%;border:0;background:#fff}
.si-view .si-spin{border-color:#334155;border-top-color:#5eead4}
.si-view-msg{display:flex;flex-direction:column;gap:10px;align-items:center;color:#cbd5e1;font-size:14px;text-align:center;padding:20px}
.si-view-msg a{color:#5eead4;font-weight:600}
.si-side{overflow:auto;padding:18px 20px 24px;display:flex;flex-direction:column;gap:12px}
.si-banner{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:14px;background:#f8fafc;border:1px solid var(--line)}
.si-banner>div{display:flex;flex-direction:column;gap:2px;font-size:13px;color:var(--mut)}
.si-banner strong{font-size:14.5px;color:var(--ink)}
.si-banner.is-warn{background:var(--warnl);border-color:#fde68a}.si-banner.is-warn svg{color:var(--warn)}
.si-banner.is-ok{background:var(--okl);border-color:#a7f3d0}.si-banner.is-ok svg{color:var(--ok)}
.si-banner.is-acc{background:var(--tl);border-color:#99f6e4}.si-banner.is-acc svg{color:var(--t)}
.si-read{border:1px solid var(--line);border-radius:14px;padding:10px 14px}
.si-read summary{cursor:pointer;font-size:13.5px;font-weight:600;color:#475569;list-style:none}
.si-read summary::-webkit-details-marker{display:none}
.si-read summary::before{content:"▸ ";color:#94a3b8}
.si-read[open] summary::before{content:"▾ "}
.si-read[open] summary{margin-bottom:8px}
.si-kv{display:flex;gap:12px;font-size:13.5px;padding:3px 0}
.si-kv span{width:70px;flex:none;color:var(--mut)}
.si-kv-h{margin-top:8px;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8}
.si-ul{margin:4px 0 0;padding-left:18px;font-size:13.5px;display:grid;gap:4px}
.si-ul small{color:var(--mut)}
.si-p{margin:4px 0 0;font-size:13.5px}
.si-step{display:flex;align-items:center;gap:10px;margin-top:6px}
.si-step span{width:24px;height:24px;border-radius:8px;background:var(--tl);color:var(--t);font-size:12.5px;font-weight:700;display:grid;place-items:center}
.si-step h4{margin:0;font-size:15px}
.si-lbl{margin:0;font-size:12.5px;color:var(--mut)}
.si-cards{display:grid;gap:6px}
.si-card{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#fff;text-align:left;font-family:inherit;cursor:pointer}
.si-card:hover{border-color:var(--t2);background:var(--tl)}
.si-card strong{font-size:14px}.si-card small{font-size:12.5px;color:var(--mut)}
.si-search{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border:1.5px solid #cbd5e1;border-radius:12px}
.si-search:focus-within{border-color:var(--t2);box-shadow:0 0 0 3px rgba(20,184,166,.15)}
.si-search svg{color:#94a3b8}
.si-search input{flex:1;min-width:0;border:0;outline:0;font-family:inherit;font-size:15px;background:transparent}
.si-books{display:grid;gap:4px;max-height:240px;overflow:auto}
.si-book{display:grid;grid-template-columns:70px 1fr;gap:0 10px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#fff;text-align:left;font-family:inherit;cursor:pointer}
.si-book:hover:not(:disabled){border-color:var(--t2);background:var(--tl)}
.si-book:disabled{opacity:.5;cursor:not-allowed}
.si-book span{grid-row:span 2;font-size:12.5px;color:var(--mut);padding-top:2px}
.si-book strong{font-size:13.5px}.si-book small{font-size:12px;color:var(--mut)}
.si-loading{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--mut);padding:6px 0}
.si-pt{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;background:var(--tl);border:1px solid #99f6e4}
.si-pt>div{flex:1;min-width:0;display:flex;flex-direction:column}
.si-pt strong{font-size:15px}.si-pt small{font-size:12.5px;color:var(--mut)}
.si-av{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#ccfbf1,#99f6e4);color:var(--t);font-weight:700;flex:none}
.si-kinds{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.si-kinds button{height:42px;border:1px solid var(--line);border-radius:11px;background:#fff;font-family:inherit;font-size:13.5px;font-weight:600;color:#334155;cursor:pointer}
.si-kinds button:hover{border-color:#99f6e4}
.si-kinds button.is-on{border-color:var(--t2);background:var(--tl);color:var(--t);box-shadow:0 0 0 3px rgba(20,184,166,.12)}
.si-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.si-f{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12.5px;font-weight:600;color:#475569}
.si-f small{font-weight:400;color:var(--mut)}
.si-wide{grid-column:1/-1}
.si-f input,.si-f select,.si-f textarea{width:100%;box-sizing:border-box;min-height:42px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;font-family:inherit;font-size:14px;color:var(--ink)}
.si-f input:focus,.si-f select:focus,.si-f textarea:focus{outline:none;border-color:var(--t2);box-shadow:0 0 0 3px rgba(20,184,166,.15)}
.si-f input+input{margin-top:6px}
.si-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px}
.si-acts .si-primary{flex:1;min-width:180px}
.si-more{display:flex;flex-wrap:wrap;gap:6px;padding-top:10px;border-top:1px solid var(--line)}
.si-more button{padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:#fff;font-family:inherit;font-size:12.5px;font-weight:600;color:#475569;cursor:pointer}
.si-more button:hover,.si-more button.is-on{border-color:var(--t2);color:var(--t);background:var(--tl)}
.si-inline{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:12px;border-radius:12px;background:#f8fafc}
.si-inline .si-f{flex:1;min-width:180px}
.si-hint{margin:0;font-size:12.5px;line-height:1.5;color:var(--mut)}
/* Settings */
.si-set{height:auto;width:min(560px,calc(100vw - 24px))}
.si-set[open]{height:fit-content}
.si-set-b{padding:18px 20px;display:flex;flex-direction:column;gap:14px;overflow:auto}
.si-dlg-f{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--line)}
.si-switch{position:relative;display:flex;align-items:flex-start;gap:12px;cursor:pointer}
.si-switch input{position:absolute;opacity:0;pointer-events:none}
.si-sw{position:relative;width:38px;height:22px;border-radius:999px;background:#cbd5e1;flex:none;margin-top:1px;transition:.15s}
.si-sw::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:.15s}
.si-switch input:checked+.si-sw{background:var(--t2)}
.si-switch input:checked+.si-sw::after{left:18px}
.si-switch input:focus-visible+.si-sw{box-shadow:0 0 0 3px rgba(20,184,166,.25)}
.si-switch>span:last-child{display:flex;flex-direction:column;gap:1px;font-size:14px}
.si-switch small{font-size:12.5px;color:var(--mut)}
/* Test on past scans */
.si-tctl{display:flex;flex-direction:column;gap:10px}
.si-tsum{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#fff}
.si-tsum-h{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:13.5px;color:var(--mut)}
.si-tsum-h strong{color:var(--ink)}
.si-prog{height:6px;border-radius:999px;background:#f1f5f9;overflow:hidden}
.si-prog span{display:block;height:100%;background:linear-gradient(90deg,var(--t2),var(--t));transition:width .3s}
.si-tchips{display:flex;flex-wrap:wrap;gap:6px}
.si-pill.is-bad{background:#fef2f2;color:#b91c1c}
.si-tr{border-top:1px solid var(--line)}
.si-list>.si-tr:first-child{border-top:0}
.si-tr .si-row{border-top:0}
.si-tr.is-on,.si-tr.is-on .si-row{background:#f8fafc}
.si-tdet{display:flex;flex-direction:column;gap:10px;padding:2px 14px 14px}
.si-tmeta{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;color:var(--mut)}
.si-side .si-row{grid-template-columns:44px 54px minmax(0,1fr) auto;gap:10px;padding:10px 12px}
.si-side .si-th{width:44px;height:54px}
.si-side .si-pill{white-space:normal;text-align:center}
.si [hidden]{display:none!important}
@media (max-width:1000px){.si-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){.si-dlg-b{grid-template-columns:1fr;grid-template-rows:40vh auto;overflow:auto}.si-side{overflow:visible}}
@media (max-width:640px){.si-tile{flex-direction:row;align-items:center}.si-tile strong{font-size:24px}
  .si-row{grid-template-columns:44px minmax(0,1fr) auto}.si-time{display:none}.si-th{width:44px;height:54px}
  .si-fu{grid-template-columns:36px minmax(0,1fr)}.si-fu-acts{grid-column:1/-1;justify-content:flex-start}.si-fu-more{grid-column:1/-1}
  .si-head{flex-wrap:wrap}.si-ghost span{display:none}.si-dlg{width:100vw;height:100vh;border-radius:0}
  .si-fields,.si-kinds{grid-template-columns:1fr}.si input,.si select,.si textarea{font-size:16px!important}}
.si-live.is-warn{background:#f59e0b;animation:none}
.si-note.is-warn{background:var(--warnl);color:var(--warn)}
.si-kinds .si-kind-add{grid-column:1/-1;border-style:dashed;color:var(--t)}
.si-kinds .si-kind-add.is-on{background:var(--tl);border-color:var(--t2)}
.si-addtype{display:grid;gap:10px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#f8fafc}
.si-types{display:grid;gap:10px;padding-top:14px;border-top:1px solid var(--line);font-size:14px}
.si-type{display:grid;gap:8px;padding:12px;border:1px solid var(--line);border-radius:12px}
.si-type-acts{display:flex;align-items:center;justify-content:space-between;gap:10px}
.si-type-del{color:#b91c1c}
.si-set{max-height:calc(100vh - 24px)}
.si-set-b{min-height:0}`;
  document.head.appendChild(s);
}