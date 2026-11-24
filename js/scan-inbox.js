// Scan Inbox: everything scanned on the ScanSnap from the switch-on date, read and filed by itself.
// The ones it couldn't file wait for someone with "File scans the portal couldn't match".
// Everything goes through Apps Script (ScanInbox.gs, action "scanInbox"). Route: #/scan-inbox[/mine|/all]
import { callApi } from "./appointments.js";
import { escapeHtml as esc, showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";
import { can, isAdmin } from "./perms.js";

const POLL_MS = 30000;
const KINDS = [
  ["billing", "Billing sheet"], ["consent", "Consent"], ["rx", "Prescription"], ["treatment", "Treatment record"],
];
const NOT_RECORD = ["Blank page", "Scanned twice", "Not a patient record", "Other"];

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  inbox: svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  alert: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="15"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
  users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
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
};

/* ---------- Small helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const shiftDay = (k, n) => { const [y, m, d] = k.split("-").map(Number); return keyOf(new Date(y, m - 1, d + n)); };
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase(); };
const fmtDay = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); if (!m) return ""; const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }); };
const fmtLong = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); if (!m) return ""; return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }); };
const dayOfIso = (iso) => { const d = new Date(iso); return isNaN(d) ? todayKey() : keyOf(d); };
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
const first = (n) => String(n || "").trim().split(/\s+/)[0] || "";
const api = (op, body = {}) => callApi({ action: "scanInbox", op, ...body });
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* ---------- Entry ---------- */

export async function mountScanInbox(container, { param = "", staff = null } = {}) {
  injectStyles();
  const canFile = can("scans.file");
  const canAll = can("scans.all") || canFile;
  const admin = isAdmin();
  const root = document.createElement("section");
  root.className = "page wide si";
  root.innerHTML = '<div class="si-wrap"><div class="skeleton sm"></div></div>';
  container.replaceChildren(root);

  const sub = String(param || "").split("/")[0];
  const st = {
    tab: sub === "mine" || sub === "all" ? sub : "today",
    day: todayKey(), data: null, error: "", checking: false,
  };
  if (st.tab === "all" && !canAll) st.tab = "today";
  const thumbs = new Map();   // id → data URL ("" none, null asked)
  let thumbBusy = false;

  /* ---- Loading ---- */
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
    if (document.visibilityState === "visible") load();
  }, POLL_MS);

  /* ---- The page ---- */
  function listFor() {
    const d = st.data || {};
    if (st.tab === "mine") return d.mine || [];
    if (st.tab === "all") return d.all || [];
    return d.items || [];
  }
  function render() {
    const d = st.data;
    if (!d && !st.error) return;
    const c = (d && d.counts) || {};
    const mine = (d && d.mine) || [];
    const last = d && d.lastCheck ? fmtTime(d.lastCheck) : "";
    const isToday = st.day === todayKey();
    root.innerHTML = `<div class="si-wrap">
      <header class="si-head">
        <span class="si-logo">${IC.inbox}</span>
        <div class="si-head-main"><h2>${greeting()}${staff && staff.name ? `, ${esc(first(staff.name))}` : ""}</h2>
          <p>${d && d.on ? `<span class="si-live"></span>Watching the scan folder${last ? ` · last check ${esc(last)}` : ""}`
            : '<span class="si-live is-off"></span>Not switched on yet'}</p></div>
        <div class="si-head-acts">
          ${canFile || admin ? `<button type="button" class="si-ghost" data-act="check" ${st.checking ? "disabled" : ""}>${IC.refresh}<span>${st.checking ? "Checking…" : "Check now"}</span></button>` : ""}
          ${admin ? `<button type="button" class="si-ghost" data-act="settings">${IC.gear}<span>Settings</span></button>` : ""}
        </div>
      </header>
      ${st.error ? `<div class="si-note is-bad">${esc(st.error)}</div>` : ""}
      ${d && !d.on ? `<div class="si-off"><strong>The Scan Inbox isn't switched on yet.</strong>
        <span>Once it is, every sheet scanned on the ScanSnap is read and filed here by itself. Scans from before then stay in Paper records.</span>
        ${admin ? '<button type="button" class="si-primary" data-act="settings">Switch it on</button>' : "<span>Ask an Admin to switch it on.</span>"}</div>` : ""}
      ${d ? `
      <p class="si-sec">Needs you</p>
      <div class="si-tiles">
        <button type="button" class="si-tile ${mine.length ? "is-warn" : ""}" data-tab="mine">
          <span class="si-ti is-warn">${IC.alert}</span><strong>${mine.length}</strong><span>${mine.length === 1 ? "Scan" : "Scans"} for you to file</span></button>
        ${canAll ? `<button type="button" class="si-tile" data-tab="all">
          <span class="si-ti is-acc">${IC.users}</span><strong>${c.needsAll || 0}</strong><span>Waiting for anyone</span></button>` : ""}
        <button type="button" class="si-tile" data-tab="today" data-today="1">
          <span class="si-ti is-ok">${IC.check}</span><strong>${isToday ? c.filed || 0 : "–"}</strong><span>Filed by itself today</span></button>
      </div>
      <div class="si-bar">
        <div class="si-seg" role="tablist">
          ${[["today", "Today"], ["mine", "My list"], ...(canAll ? [["all", "Everyone"]] : [])].map(([k, l]) =>
            `<button type="button" role="tab" aria-selected="${st.tab === k}" class="${st.tab === k ? "is-on" : ""}" data-tab="${k}">${l}${
              k === "mine" && mine.length ? `<em>${mine.length}</em>` : ""}</button>`).join("")}
        </div>
        ${st.tab === "today" ? `<div class="si-day">
          <button type="button" class="si-icon" data-day="-1" aria-label="Day before">${IC.left}</button>
          <span>${isToday ? "Today" : esc(fmtDay(st.day))}</span>
          <button type="button" class="si-icon" data-day="1" aria-label="Day after" ${isToday ? "disabled" : ""}>${IC.right}</button>
          ${isToday ? "" : '<button type="button" class="si-link" data-day="0">Back to today</button>'}</div>` : ""}
        <span class="si-sp"></span>
        ${st.tab === "today" ? `<span class="si-stat">${plural(c.scanned || 0, "scan")} · ${c.filed || 0} filed by itself${
          c.followUps ? ` · ${plural(c.followUps, "follow-up")} read` : ""}</span>` : ""}
      </div>
      <div class="si-list">${rowsHtml()}</div>` : ""}
    </div>`;
    loadThumbs();
  }

  function rowsHtml() {
    const list = listFor();
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
      subline = it.error ? `<span class="si-bad">${esc(it.error)}</span>` : "Usually about a minute";
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
      subline = chips.length ? chips.map((c) => `<span class="si-chip">${esc(c)}</span>`).join("")
        : `${esc(it.kindName)}${it.filedBy && it.filedBy !== "Scan Inbox" ? ` · filed by ${esc(first(it.filedBy))}` : ""}`;
      right = '<span class="si-pill is-ok">Filed</span>';
    } else if (it.status === "paper") {
      title = esc(name || "Treatment record");
      subline = `${esc(it.kindName || "Scan")} · in Paper records, for the products used`;
      right = '<span class="si-pill is-acc">Paper records</span>';
    } else if (it.status === "notrecord") {
      title = esc(name || it.name);
      subline = "Not a patient record";
      right = '<span class="si-pill is-mut">Not a record</span>';
    } else {
      title = esc(it.name);
      subline = "Removed from Google Drive";
      right = '<span class="si-pill is-mut">Removed</span>';
    }
    return `<button type="button" class="si-row" data-open="${esc(it.id)}">
      <span class="si-th" ${reading ? "" : `data-thumb="${esc(it.id)}"`}>${thumbs.get(it.id) ? `<img alt="" src="${esc(thumbs.get(it.id))}">` : reading ? '<span class="si-spin"></span>' : IC.doc}</span>
      <span class="si-time">${time}</span>
      <span class="si-main"><strong>${title}</strong><small>${subline}</small></span>
      ${right}</button>`;
  }

  /* ---- Thumbnails, 12 at a time ---- */
  async function loadThumbs() {
    if (thumbBusy || !root.isConnected) return;
    const want = [...new Set([...root.querySelectorAll("[data-thumb]")].map((e) => e.dataset.thumb))]
      .filter((id) => !thumbs.has(id)).slice(0, 12);
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

  /* ---- Taps ---- */
  root.addEventListener("click", async (e) => {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) {
      st.tab = tab.dataset.tab;
      if (tab.dataset.today) st.day = todayKey();
      history.replaceState(null, "", `#/scan-inbox${st.tab === "today" ? "" : `/${st.tab}`}`);
      if (tab.dataset.today) load(); else render();
      return;
    }
    const day = t.closest("[data-day]");
    if (day) {
      const n = Number(day.dataset.day);
      st.day = n === 0 ? todayKey() : shiftDay(st.day, n);
      if (st.day > todayKey()) st.day = todayKey();
      root.querySelector(".si-list").innerHTML = '<div class="si-empty"><span class="si-spin"></span></div>';
      load();
      return;
    }
    const open = t.closest("[data-open]");
    if (open) {
      const it = [...(st.data.items || []), ...(st.data.mine || []), ...(st.data.all || [])].find((x) => x.id === open.dataset.open);
      if (it) openScan(it, { canFile, admin, onDone: load });
      return;
    }
    const a = t.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "settings") openSettings(load);
    else if (a.dataset.act === "check") {
      st.checking = true; render();
      try {
        const r = await api("checkNow");
        if (r.recent) showToast("It was checked a moment ago.");
        else if (r.off) showToast("The Scan Inbox isn't switched on.");
        else if (r.busy) showToast("It's checking right now. Give it a minute.");
        else showToast(r.added ? `${plural(r.added, "new scan")} found${r.read ? `, ${r.read} read` : ""}` : "No new scans in the folder.");
      } catch (err) { console.error("Check failed:", err); showToast("Couldn't check the folder. Try again."); }
      st.checking = false;
      load();
    }
  });

  await load();
}

/* ===================== One scan, full screen ===================== */

let staffMemo = null;
async function staffList() {
  if (staffMemo) return staffMemo;
  try {
    const r = await callApi({ action: "staffList" });
    staffMemo = (r.staff || []).filter((s) => s.name);
  } catch { staffMemo = []; }
  return staffMemo;
}

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

function openScan(it, { canFile, admin, onDone }) {
  injectStyles();
  const r = it.read || {};
  const s = {
    pt: it.patientId ? { id: it.patientId, name: it.patientName, note: it.apptTime ? `Booked ${it.apptTime}${it.staff ? ` with ${it.staff}` : ""}` : "" } : null,
    kind: KINDS.some(([k]) => k === it.kind) ? it.kind : "",
    date: it.recordDate || r.date || dayOfIso(it.created),
    clin: it.staff || r.provider || "",
    title: r.title || "",
    meds: [""],
    mode: "", results: null, bookings: null, busy: false,
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

  // The scan itself
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

  function sideHtml() {
    const reason = it.status === "needs" ? `<div class="si-banner is-warn">${IC.alert}<div><strong>${esc(it.reasonText || "Needs filing")}</strong>
        ${it.help ? `<span>Help asked: “${esc(it.help)}”</span>` : ""}${it.assignedToName ? `<span>With ${esc(it.assignedToName)}</span>` : ""}</div></div>` : "";
    const readBox = `<details class="si-read" ${it.status === "needs" ? "open" : ""}><summary>What the portal read</summary>${readHtml(it.read)}</details>`;
    const hist = (it.history || []).length ? `<details class="si-read"><summary>History</summary><ul class="si-ul">${it.history.slice().reverse().map((h) =>
      `<li>${esc(h.what)}<br><small>${esc(h.by)} · ${esc(fmtDay(dayOfIso(h.at)))} ${esc(fmtTime(h.at))}</small></li>`).join("")}</ul></details>` : "";
    const putBack = canFile ? '<button type="button" class="si-ghost" data-a="undo">Put it back to file again</button>' : "";

    if (it.status === "reading") {
      return `<div class="si-banner">${'<span class="si-spin"></span>'}<div><strong>Reading the scan…</strong><span>${esc(it.error || "Usually about a minute.")}</span></div></div>
        ${canFile && it.error ? '<button type="button" class="si-ghost" data-a="retry">Read it again now</button>' : ""}${hist}`;
    }
    if (it.status === "filed") {
      return `<div class="si-banner is-ok">${IC.check}<div><strong>Filed for ${esc(it.patientName)}</strong>
        <span>${esc(it.kindName)} · ${esc(fmtLong(it.recordDate))} · ${it.filedBy === "Scan Inbox" ? "by itself" : `by ${esc(it.filedBy)}`}</span></div></div>
        <div class="si-acts"><a class="si-primary" href="#/patient/${encodeURIComponent(it.patientId)}" target="_blank" rel="noopener">Open the patient's page</a>${putBack}</div>
        ${it.read && it.kind === "billing" && ((it.read.nextAppts || []).length || (it.read.tasks || []).length)
          ? '<p class="si-hint">The next appointments and tasks below are saved. Booking them from here comes in the next update.</p>' : ""}
        ${readBox}${hist}`;
    }
    if (it.status === "paper") {
      return `<div class="si-banner is-acc">${IC.doc}<div><strong>In Paper records</strong><span>Treatment records are filed there, where the products used are entered.</span></div></div>
        <div class="si-acts"><a class="si-primary" href="#/paper">Open Paper records</a>${putBack}</div>${readBox}${hist}`;
    }
    if (it.status === "notrecord" || it.status === "gone") {
      return `<div class="si-banner">${IC.doc}<div><strong>${it.status === "gone" ? "Removed from Google Drive" : "Not a patient record"}</strong></div></div>
        ${it.status === "notrecord" ? `<div class="si-acts">${putBack}</div>` : ""}${readBox}${hist}`;
    }
    // Needs filing
    if (!canFile) return `${reason}<p class="si-hint">Someone with "File scans the portal couldn't match" sorts this one out.</p>${readBox}${hist}`;
    const sugg = (it.suggestions || []).filter((x) => x.patientId || x.ptt);
    const treat = s.kind === "treatment";
    return `${reason}${readBox}
      <div class="si-step"><span>1</span><h4>Who is it?</h4></div>
      ${s.pt ? `<div class="si-pt"><span class="si-av">${esc(first(s.pt.name).slice(0, 1) || "?")}</span><div><strong>${esc(s.pt.name)}</strong>${s.pt.note ? `<small>${esc(s.pt.note)}</small>` : ""}</div>
          <button type="button" class="si-link" data-a="clearpt">Change</button></div>`
        : `${sugg.length ? `<p class="si-lbl">Could it be</p><div class="si-cards">${sugg.map((x, i) =>
            `<button type="button" class="si-card" data-sugg="${i}"><strong>${esc(x.name)}</strong><small>${x.source === "booking"
              ? `Booked ${esc(fmtDay(x.date))}${x.time ? ` ${esc(x.time)}` : ""}${x.staff ? ` with ${esc(x.staff)}` : ""}` : "No booking that day"}</small></button>`).join("")}</div>` : ""}
          <div class="si-search">${IC.search}<input type="search" data-role="q" placeholder="Search by name, mobile or date of birth" autocomplete="off"></div>
          <div data-role="results">${s.results || ""}</div>
          <button type="button" class="si-link" data-a="bookings">${IC.cal}See who was booked on ${esc(fmtDay(s.date))}</button>
          <div data-role="bookings">${s.bookings || ""}</div>`}
      <div class="si-step"><span>2</span><h4>What is it?</h4></div>
      <div class="si-kinds">${KINDS.map(([k, l]) => `<button type="button" class="${s.kind === k ? "is-on" : ""}" data-kind="${k}">${l}</button>`).join("")}</div>
      ${treat ? '<p class="si-hint">Treatment records go to Paper records, where the products used are entered and taken off stock.</p>' : `
      <div class="si-step"><span>3</span><h4>Details</h4></div>
      <div class="si-fields">
        <label class="si-f"><span>Date on the paper</span><input type="date" data-f="date" value="${esc(s.date)}" max="${todayKey()}"></label>
        <label class="si-f"><span>Clinician</span><input data-f="clin" value="${esc(s.clin)}" placeholder="e.g. Dr Teh"></label>
        ${s.kind === "consent" ? `<label class="si-f si-wide"><span>Which consent</span><input data-f="title" value="${esc(s.title)}" placeholder="e.g. Consent for laser treatment"></label>` : ""}
        ${s.kind === "rx" ? `<div class="si-f si-wide"><span>What was prescribed</span>${s.meds.map((m, i) =>
          `<input data-med="${i}" value="${esc(m)}" placeholder="Medicine ${i + 1}">`).join("")}
          <button type="button" class="si-link" data-a="addmed">+ Another medicine</button></div>` : ""}
      </div>`}
      <div class="si-acts">
        <button type="button" class="si-primary" data-a="${treat ? "topaper" : "file"}" ${s.busy ? "disabled" : ""}>${s.busy ? "Saving…" : treat ? "Send to Paper records" : "File it"}</button>
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
      if (done) showToast(done);
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
    if (kd) { s.kind = kd.dataset.kind; paint(); return; }
    const md = t.closest("[data-mode]");
    if (md) { s.mode = s.mode === md.dataset.mode ? "" : md.dataset.mode; paint(); return; }
    const a = t.closest("[data-a]");
    if (!a) return;
    const op = a.dataset.a;
    if (op === "clearpt") { s.pt = null; paint(); }
    else if (op === "addmed") { s.meds.push(""); paint(); }
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
        message: it.status === "filed" ? "It's taken off the patient's page and goes back on the list to file." : "It goes back on the list to file.",
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
    </div>
    <div class="si-dlg-f"><button type="button" class="si-ghost" data-x>Cancel</button><button type="button" class="si-primary" data-save>Save</button></div>`;
  document.body.appendChild(dlg);
  const close = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.addEventListener("click", async (e) => {
    if (e.target.closest("[data-x]")) { close(); return; }
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
        toHour: Number(q("to").value), autoBilling: q("bill").checked, autoConsent: q("cons").checked });
      if (res.problem) { showToast(res.problem); return; }
      showToast("Settings saved");
      close();
      onDone();
    } catch (err) { console.error("Settings not saved:", err); showToast("Couldn't save. Try again."); }
    finally { if (dlg.isConnected) { sv.disabled = false; sv.textContent = "Save"; } }
  });
  dlg.showModal();
}

/* ===================== Styles ===================== */

function injectStyles() {
  if (document.getElementById("si-styles-1")) return;
  const s = document.createElement("style");
  s.id = "si-styles-1";
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
.si-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:24px}
.si-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:16px;border:1px solid var(--line);border-radius:16px;background:#fff;text-align:left;font-family:inherit;cursor:pointer;transition:.15s;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.si-tile:hover{border-color:#99f6e4;transform:translateY(-1px);box-shadow:0 6px 16px rgba(15,23,42,.06)}
.si-tile.is-warn{border-color:#fde68a;background:linear-gradient(#fff,#fffdf5)}
.si-tile strong{font-size:30px;line-height:1;color:var(--ink);font-weight:600}
.si-tile>span:last-child{font-size:13.5px;color:var(--mut)}
.si-ti{width:36px;height:36px;border-radius:11px;display:grid;place-items:center}
.si-ti.is-warn{background:var(--warnl);color:var(--warn)}.si-ti.is-acc{background:var(--tl);color:var(--t)}.si-ti.is-ok{background:var(--okl);color:var(--ok)}
.si-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.si-seg{display:inline-flex;padding:3px;border-radius:12px;background:#f1f5f9}
.si-seg button{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;padding:8px 16px;border-radius:9px;font-family:inherit;font-size:13.5px;font-weight:600;color:var(--mut);cursor:pointer}
.si-seg button.is-on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(15,23,42,.1)}
.si-seg em{font-style:normal;font-size:11px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#f59e0b;color:#fff;display:grid;place-items:center}
.si-day{display:flex;align-items:center;gap:4px;font-size:13.5px;font-weight:600;color:var(--ink)}
.si-day>span{min-width:92px;text-align:center}
.si-icon{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--mut);cursor:pointer}
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
.si [hidden]{display:none!important}
@media (max-width:900px){.si-dlg-b{grid-template-columns:1fr;grid-template-rows:40vh auto}.si-dlg-b{overflow:auto}.si-side{overflow:visible}}
@media (max-width:640px){.si-tiles{grid-template-columns:1fr}.si-tile{flex-direction:row;align-items:center}.si-tile strong{font-size:24px}
  .si-row{grid-template-columns:44px minmax(0,1fr) auto}.si-time{display:none}.si-th{width:44px;height:54px}
  .si-head{flex-wrap:wrap}.si-ghost span{display:none}.si-dlg{width:100vw;height:100vh;border-radius:0}
  .si-fields,.si-kinds{grid-template-columns:1fr}.si input,.si select,.si textarea{font-size:16px!important}}`;
  document.head.appendChild(s);
}