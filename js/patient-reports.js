// Reporting → patient lists: Packages left, Skin Scripts expiring, New patients not back.
// The lists are worked out by Apps Script (action "reports"); contacts are logged in Firestore report_contacts.
// Each list has summary cards, two breakdowns you can click to filter by, and the patients.
import { db, auth } from "./firebase-config.js";
import { collection, doc, getDocs, query, where, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { showToast, getInitials, hueFromString } from "./utils.js";
import { downloadCsv } from "./reports.js";

export const PATIENT_TABS = [["packages", "Packages left"], ["ssp", "Skin Scripts expiring"], ["newpts", "New patients not back"]];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const parse = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); };
const nice = (k) => { const d = parse(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const between = (a, b) => { const x = parse(a), y = parse(b); return x && y ? Math.round((y - x) / 864e5) : null; };
const money = (n) => `$${Math.round(n).toLocaleString("en-AU")}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const rel = (d) => (d === null ? "" : d === 0 ? "today" : d > 0 ? `in ${plural(d, "day")}` : `${plural(-d, "day")} ago`);

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  users: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  cal: ic('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  money: ic('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  clock: ic('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  alert: ic('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  chat: ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  spark: ic('<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>'),
  phone: ic('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  mail: ic('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
};

const OUTCOMES = [["booked", "Booked"], ["spoke", "Spoke to them"], ["message", "Left a message"],
  ["sent", "Sent a text or email"], ["callback", "Call back later"], ["not_interested", "Not interested"]];
const OUT = Object.fromEntries(OUTCOMES);

// The same key on every list, safe for a Firestore document ID
const rowKey = (r) => String(r.id || `ptt_${r.ptt || r.name}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);

// Off the list for now: not interested (until changed), call back (until the date), anything else (14 days)
function contacted(c, today) {
  if (!c) return false;
  if (c.outcome === "callback") return !!c.until && c.until > today;
  if (c.outcome === "not_interested") return true;
  return !!c.at && Date.now() - c.at.getTime() < 14 * 864e5;
}

async function loadContacts(kind) {
  const snap = await getDocs(query(collection(db, "report_contacts"), where("list", "==", kind)));
  const m = new Map();
  snap.forEach((d) => {
    const x = d.data() || {};
    m.set(String(x.key || ""), { ...x, at: x.at && typeof x.at.toDate === "function" ? x.at.toDate() : null });
  });
  return m;
}

/* ---------- Shared pieces ---------- */
const patientCell = (r) => {
  const name = r.name || "Patient";
  const tel = String(r.mobile || "").replace(/\s/g, "");
  const flags = `${r.dnc ? '<span class="inv-flag is-bad">Do not contact</span>' : ""}${
    r.id ? "" : '<span class="inv-flag is-warn" title="No Patient ID, or it isn\'t in the Patient List">Not linked</span>'}`;
  return `<div class="pr-who"><span class="pr-av" style="--h:${hueFromString(name)}">${esc(getInitials(name))}</span>
    <div>${r.id ? `<a class="pr-name" href="#/patient/${encodeURIComponent(r.id)}">${esc(name)}</a>` : `<span class="pr-name">${esc(name)}</span>`}
      <div class="pr-meta">${tel ? `<a href="tel:${esc(tel)}">${I.phone}${esc(r.mobile)}</a>` : ""}${
        r.email ? `<a href="mailto:${esc(r.email)}">${I.mail}${esc(r.email)}</a>` : ""}</div>
      ${flags ? `<div class="pr-flags">${flags}</div>` : ""}</div></div>`;
};
const pill = (cls, text) => `<span class="pr-pill is-${cls}">${esc(text)}</span>`;
const lastCell = (r, today) => {
  if (!r.last) return '<span class="muted">—</span>';
  const d = -between(today, r.last);
  return `${esc(nice(r.last))}<br>${pill(d > 180 ? "bad" : d > 90 ? "warn" : "ok", rel(-d))}`;
};
const nextCell = (r) => (r.next ? `${esc(nice(r.next))}${(r.nextSvc || []).length ? `<span class="pr-sub">${esc(r.nextSvc.join(", "))}</span>` : ""}`
  : '<span class="muted">Nothing booked</span>');
const sum = (list, f) => list.reduce((a, x) => a + (Number(f(x.r)) || 0), 0);

// New patients: a consult (or a Medicare item / review) only, or what they had
const consultOnly = (r) => (r.firstSvc || []).length > 0 && r.firstSvc.every((s) => /consult|medicare|review/i.test(s));
const firstKind = (r) => (consultOnly(r) ? "Consult only"
  : (r.firstCat || []).find((c) => !/consult|^other$|^add ons$/i.test(c)) || "Other treatment");
const expBucket = (r, today) => {
  const d = between(today, r.expires);
  return d === null ? "No expiry" : d <= 30 ? "Within 30 days" : d <= 90 ? "31 to 90 days" : "Later";
};
const sspBucket = (r, today) => {
  const d = between(today, r.expires);
  return d >= 0 ? "Expires in the next 30 days" : d >= -30 ? "Expired in the last 30 days"
    : d >= -90 ? "Expired 1 to 3 months ago" : "Expired 3 to 12 months ago";
};

/* ---------- The three lists ---------- */
const LISTS = {
  packages: {
    intro: "Patients with visits still left on a package. They've already paid, so these are the easiest to bring back.",
    find: "Filter: patient, package or mobile",
    filters: [
      { k: "nb", type: "check", label: "Only patients with nothing booked", def: true },
      { k: "exp", type: "select", label: "Expires", def: "any", options: [["any", "Any time"], ["30", "In the next 30 days"],
        ["60", "In the next 60 days"], ["90", "In the next 90 days"], ["none", "No expiry date"]] },
    ],
    match(r, f, today) {
      if (f.nb && r.next) return false;
      if (f.exp === "none") return !r.expires;
      if (f.exp !== "any") { const d = between(today, r.expires); return d !== null && d <= Number(f.exp); }
      return true;
    },
    sort: (a, b) => (a.expires || "9999").localeCompare(b.expires || "9999") || (b.value || 0) - (a.value || 0),
    cards(list, today) {
      const value = sum(list, (r) => r.value);
      const soon = list.filter((x) => { const d = between(today, x.r.expires); return d !== null && d <= 30; }).length;
      return [
        { v: new Set(list.map((x) => x.r.id || x.r.name)).size, l: "Patients", sub: plural(list.length, "package") + " with visits left", tone: "teal", icon: I.users },
        { v: sum(list, (r) => r.left), l: "Visits left", sub: "on these packages", tone: "violet", icon: I.cal },
        { v: value ? money(value) : "—", l: "Already paid for", sub: "the value of those visits", tone: "amber", icon: I.money },
        { v: soon, l: "Expire within 30 days", sub: soon ? "contact these first" : "none expiring soon", tone: soon ? "rose" : "slate", icon: I.alert },
      ];
    },
    groups: [
      { k: "exp", title: "Expires", order: ["Within 30 days", "31 to 90 days", "Later", "No expiry"], of: expBucket },
      { k: "pkg", title: "Package", of: (r) => r.pkg },
    ],
    head: ["Package", "Visits left", "Expires", "Last visit", "Next booking", "Value"],
    cells: (r, today) => {
      const d = between(today, r.expires);
      return [
        `<strong>${esc(r.pkg)}</strong>${r.status ? `<span class="pr-sub">${esc(r.status)}</span>` : ""}`,
        `<span class="pr-big">${esc(r.left)}</span>${(r.lines || []).length
          ? `<span class="pr-sub">${esc(r.lines.map((l) => `${l.svc || "Service"} ×${l.left}`).join(", "))}</span>` : ""}`,
        r.expires ? `${esc(nice(r.expires))}<br>${pill(d <= 30 ? "bad" : d <= 90 ? "warn" : "ok", rel(d))}` : '<span class="muted">No expiry</span>',
        lastCell(r, today), nextCell(r), r.value ? `<strong>${esc(money(r.value))}</strong>` : "—",
      ];
    },
    csvHead: ["Package", "Status", "Visits left", "Services left", "Expires", "Value ($)"],
    csvRow: (r) => [r.pkg, r.status, r.left, (r.lines || []).map((l) => `${l.svc} x${l.left}`).join("; "), r.expires, r.value || ""],
  },

  ssp: {
    intro: "Patients whose most recent Skin Script has expired or is about to. A good reason to book a skin review.",
    filters: [
      { k: "win", type: "select", label: "Show", def: "both", options: [["soon", "Expiring in the next 30 days"],
        ["recent", "Expired in the last 90 days"], ["both", "Both of those"], ["older", "Expired 3 to 12 months ago"]] },
      { k: "nb", type: "check", label: "Only patients with nothing booked", def: true },
    ],
    match(r, f, today) {
      if (f.nb && r.next) return false;
      const d = between(today, r.expires);
      if (d === null) return false;
      if (f.win === "soon") return d >= 0 && d <= 30;
      if (f.win === "recent") return d < 0 && d >= -90;
      if (f.win === "older") return d < -90 && d >= -365;
      return d >= -90 && d <= 30;
    },
    sort: (a, b, today) => Math.abs(between(today, a.expires)) - Math.abs(between(today, b.expires)),
    cards(list, today) {
      const soon = list.filter((x) => between(today, x.r.expires) >= 0).length;
      const stale = list.filter((x) => !x.r.last || between(x.r.last, today) > 180).length;
      return [
        { v: list.length, l: "Patients", sub: "due a Skin Script review", tone: "teal", icon: I.users },
        { v: soon, l: "Expiring soon", sub: "still valid for now", tone: "amber", icon: I.clock },
        { v: list.length - soon, l: "Expired", sub: "no current Skin Script", tone: list.length - soon ? "rose" : "slate", icon: I.alert },
        { v: stale, l: "Not seen in 6+ months", sub: "may need a full skin review", tone: "violet", icon: I.cal },
      ];
    },
    groups: [
      { k: "when", title: "When", of: sspBucket, order: ["Expires in the next 30 days", "Expired in the last 30 days",
        "Expired 1 to 3 months ago", "Expired 3 to 12 months ago"] },
      { k: "by", title: "Skin Script made by", of: (r) => r.by || "Not recorded" },
    ],
    head: ["Skin Script", "Expires", "Last visit", "Next booking"],
    cells: (r, today) => {
      const d = between(today, r.expires);
      return [
        `<strong>${esc(nice(r.date))}</strong>${r.by ? `<span class="pr-sub">by ${esc(r.by)}</span>` : ""}`,
        `${esc(nice(r.expires))}<br>${pill(d < -30 ? "bad" : d < 0 ? "warn" : "ok", d < 0 ? `Expired ${rel(d)}` : `Expires ${rel(d)}`)}`,
        lastCell(r, today), nextCell(r),
      ];
    },
    csvHead: ["Skin Script date", "Made by", "Expires"],
    csvRow: (r) => [r.date, r.by, r.expires],
  },

  newpts: {
    intro: "Patients who came in once and haven't been back, with nothing booked.",
    filters: [
      { k: "since", type: "select", label: "Their visit was", def: "30-180", options: [["30-90", "1 to 3 months ago"],
        ["30-180", "1 to 6 months ago"], ["90-180", "3 to 6 months ago"], ["180-365", "6 to 12 months ago"], ["0-365", "In the last 12 months"]] },
    ],
    match(r, f, today) {
      const [lo, hi] = String(f.since).split("-").map(Number);
      const d = between(r.first, today);
      return d !== null && d >= lo && d <= hi;
    },
    sort: (a, b) => String(b.first).localeCompare(String(a.first)),
    cards(list, today) {
      const n = list.length;
      const c = list.filter((x) => consultOnly(x.r)).length;
      const avg = n ? Math.round(sum(list, (r) => between(r.first, today)) / n) : 0;
      return [
        { v: n, l: "Didn't come back", sub: "one visit, nothing booked", tone: "teal", icon: I.users },
        { v: c, l: "Consult only", sub: n ? `${Math.round((c / n) * 100)}% didn't start treatment` : "", tone: "violet", icon: I.chat },
        { v: n - c, l: "Had a treatment", sub: "but haven't returned", tone: "amber", icon: I.spark },
        { v: n ? `${avg} days` : "—", l: "Since their visit", sub: "on average", tone: "slate", icon: I.clock },
      ];
    },
    groups: [
      { k: "kind", title: "Their visit was for", of: firstKind },
      { k: "staff", title: "Seen by", of: (r) => r.firstStaff },
    ],
    head: ["Their visit", "Treatment", "With"],
    cells: (r, today) => {
      const d = between(r.first, today);
      const kind = firstKind(r);
      return [
        `${esc(nice(r.first))}<br>${pill(d > 150 ? "bad" : d > 90 ? "warn" : "ok", rel(-d))}`,
        `<span class="pr-chip${kind === "Consult only" ? " is-consult" : ""}">${esc(kind)}</span>${
          (r.firstSvc || []).length ? `<span class="pr-sub">${esc(r.firstSvc.join(", "))}</span>` : ""}`,
        esc(r.firstStaff || "—"),
      ];
    },
    csvHead: ["Visit date", "Visit was for", "Treatment", "With"],
    csvRow: (r) => [r.first, firstKind(r), (r.firstSvc || []).join("; "), r.firstStaff],
  },
};

/* ---------- The page ---------- */
export function mountPatientReport(body, kind, staff) {
  const L = LISTS[kind];
  const st = { rows: [], contacts: new Map(), f: {}, q: "", done: false, pick: null, at: "", today: todayKey(), list: [] };
  L.filters.forEach((x) => { st.f[x.k] = x.def; });
  body.innerHTML = `<p class="muted rp-range">${esc(L.intro)}</p><div data-role="tools"></div><div data-role="out"></div>`;
  const toolsEl = body.querySelector('[data-role="tools"]');
  const out = body.querySelector('[data-role="out"]');
  const gval = (g, r) => g.of(r, st.today) || "Not recorded";

  function drawTools() {
    toolsEl.innerHTML = `<div class="inv-tools rp-tools">
      ${L.filters.map((x) => (x.type === "check"
        ? `<label class="fe-check"><input type="checkbox" data-f="${x.k}"${st.f[x.k] ? " checked" : ""} /> ${esc(x.label)}</label>`
        : `<label class="rp-from">${esc(x.label)} <select class="fb-select" data-f="${x.k}">${x.options.map(([v, l]) =>
          `<option value="${v}"${st.f[x.k] === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`)).join("")}
      <input type="search" class="fe-input rp-find" data-f="q" placeholder="${esc(L.find || "Filter: patient or mobile")}" value="${esc(st.q)}" aria-label="Filter" />
      <label class="fe-check"><input type="checkbox" data-f="done"${st.done ? " checked" : ""} /> Show people already contacted</label>
      <span class="inv-spacer"></span>
      <button type="button" class="ff-btn" data-act="refresh">Refresh</button>
      <button type="button" class="ff-btn" data-act="csv">Export CSV</button>
    </div>`;
  }

  // The filters, search and "already contacted" → base; a clicked bar narrows base → list
  function compute() {
    const q = st.q.trim().toLowerCase();
    let hidden = 0;
    const base = [];
    st.rows.forEach((r) => {
      if (!L.match(r, st.f, st.today)) return;
      if (q && ![r.name, r.mobile, r.email, r.pkg].join(" ").toLowerCase().includes(q)) return;
      const c = st.contacts.get(rowKey(r));
      if (!st.done && contacted(c, st.today)) { hidden++; return; }
      base.push({ r, c });
    });
    base.sort((a, b) => L.sort(a.r, b.r, st.today));
    const g = st.pick && L.groups.find((x) => x.k === st.pick.g);
    const list = g ? base.filter((x) => gval(g, x.r) === st.pick.v) : base;
    return { base, list, hidden };
  }

  const cardHtml = (c) => `<div class="pr-card is-${c.tone || "teal"}"><span class="pr-card-i">${c.icon || ""}</span>
    <div><strong>${esc(String(c.v))}</strong><span>${esc(c.l)}</span>${c.sub ? `<small>${esc(c.sub)}</small>` : ""}</div></div>`;

  function breakHtml(g, base) {
    const counts = new Map();
    base.forEach((x) => { const v = gval(g, x.r); counts.set(v, (counts.get(v) || 0) + 1); });
    const rows = g.order ? g.order.filter((v) => counts.has(v)).map((v) => [v, counts.get(v)])
      : [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = rows.slice(0, 7);
    const rest = rows.slice(7).reduce((a, [, n]) => a + n, 0);
    const max = Math.max(1, ...top.map(([, n]) => n));
    return `<section class="pr-break"><h4>${esc(g.title)}</h4>${top.map(([v, n]) => {
      const on = st.pick && st.pick.g === g.k && st.pick.v === v;
      return `<button type="button" class="pr-bar${on ? " is-on" : ""}" data-pick="${esc(g.k)}" data-v="${esc(v)}"
          title="${on ? "Show everyone" : `Show only ${esc(v)}`}">
        <span class="pr-bar-l">${esc(v)}</span><span class="pr-bar-t"><span style="width:${Math.max(4, Math.round((n / max) * 100))}%"></span></span>
        <span class="pr-bar-n">${n}</span></button>`;
    }).join("")}${rest ? `<p class="pr-bar-more">+ ${rest} more in smaller groups</p>` : ""}</section>`;
  }

  const contactCell = (c, i) => `${c ? `<div class="rp-done"><span class="inv-flag ${c.outcome === "booked" ? "is-ok"
    : c.outcome === "not_interested" ? "is-bad" : "is-info"}">${esc(OUT[c.outcome] || c.outcome)}</span>
      <small>${esc([c.at ? c.at.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "", c.by,
        c.outcome === "callback" && c.until ? `call back ${nice(c.until)}` : ""].filter(Boolean).join(" · "))}</small>
      ${c.note ? `<small>“${esc(c.note)}”</small>` : ""}</div>` : ""}
    <button type="button" class="lh-btn pr-log" data-log="${i}">${I.chat}<span>${c ? "Update" : "Log contact"}</span></button>`;

  function draw() {
    const { base, list, hidden } = compute();
    st.list = list;
    const g = st.pick && L.groups.find((x) => x.k === st.pick.g);
    const shown = list.slice(0, 500);
    const heads = ["Patient", ...L.head, "Contact"];
    out.innerHTML = `
      <div class="pr-cards">${L.cards(list, st.today).map(cardHtml).join("")}</div>
      ${base.length ? `<div class="pr-breaks">${L.groups.map((x) => breakHtml(x, base)).join("")}</div>` : ""}
      <div class="pr-listhead"><strong>${plural(list.length, "patient")}</strong>
        ${g ? `<span class="pr-chip is-consult">${esc(g.title)}: ${esc(st.pick.v)}</span>
          <button type="button" class="rc-link" data-act="unpick">Show everyone</button>` : ""}
        ${hidden ? `<span class="muted">· ${hidden} already contacted (hidden)</span>` : ""}
        <span class="inv-spacer"></span>
        ${st.at ? `<small class="muted">Worked out at ${esc(new Date(st.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }))}</small>` : ""}
      </div>
      ${list.length ? `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table pr-table">
          <thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${shown.map((x, i) => {
            const cells = [patientCell(x.r), ...L.cells(x.r, st.today), contactCell(x.c, i)];
            return `<tr>${cells.map((c, j) => `<td data-label="${esc(heads[j])}"${j === cells.length - 1 ? ' class="pr-contact"' : ""}>${c}</td>`).join("")}</tr>`;
          }).join("")}</tbody>
        </table></div>${list.length > 500 ? `<p class="muted rp-note">Showing the first 500. Export CSV for all ${list.length}.</p>` : ""}</section>`
        : `<div class="tm-empty">${hidden ? "Everyone here has been contacted. 👍" : "Nobody matches. 👍"}</div>`}`;
  }

  async function load(fresh = false) {
    const t0 = Date.now();
    const note = "The first time can take up to a minute or two: it reads the whole appointment book. After that it's quick for 10 minutes.";
    out.innerHTML = `<div class="tm-empty"><strong>Working it out…</strong><br><small class="muted" data-role="secs">${esc(note)}</small></div>`;
    const tick = setInterval(() => {
      const el = out.querySelector('[data-role="secs"]');
      if (!el) { clearInterval(tick); return; }
      const s = Math.round((Date.now() - t0) / 1000);
      if (s >= 5) el.textContent = `${s} seconds… ${note}`;
    }, 1000);
    try {
      const [res, contacts] = await Promise.all([
        callApi({ action: "reports", op: kind, fresh }),
        loadContacts(kind).catch((err) => { console.warn("Contacts not loaded:", err); return new Map(); }),
      ]);
      if (!out.isConnected) return;
      if (res.problem) { out.innerHTML = `<div class="tm-empty is-error">${esc(res.problem)}</div>`; return; }
      Object.assign(st, { rows: Array.isArray(res.rows) ? res.rows : [], at: res.at || "", today: res.today || todayKey(), contacts });
      draw();
    } catch (err) {
      console.error(`${kind} report failed:`, err);
      if (!out.isConnected) return;
      out.innerHTML = `<div class="tm-empty is-error">${esc(err && err.code === "FORBIDDEN"
        ? "You don't have access to patient lists. Ask an Admin to tick “Reporting: patient lists” for your role."
        : err && (err.code === "INVALID_PIN" || err.code === "BAD_REQUEST")
          ? "The server hasn't been updated yet. In Apps Script, deploy a new version."
          : (err && err.message) || "Couldn't load the report. Try again.")}</div>`;
    } finally {
      clearInterval(tick);
    }
  }

  function logContact(r) {
    const key = rowKey(r);
    const cur = st.contacts.get(key);
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>${esc(r.name || "Patient")}</h3>
        <p>${esc([r.mobile, r.email].filter(Boolean).join(" · ") || "No contact details on file")}</p></div>
      ${r.dnc ? `<p class="tb-info">They're on the do-not-contact list.${kind === "packages" ? " You can still contact them about visits they've already paid for." : ""}</p>` : ""}
      ${cur ? `<p class="muted">Last time: ${esc(OUT[cur.outcome] || cur.outcome)}${cur.by ? ` · ${esc(cur.by)}` : ""}${cur.note ? ` · “${esc(cur.note)}”` : ""}</p>` : ""}
      <div class="lh-field"><span class="lh-label">What happened?</span>
        <div class="pr-outs">${OUTCOMES.map(([v, l]) => `<label class="fe-check"><input type="radio" name="out" value="${v}" /> ${esc(l)}</label>`).join("")}</div></div>
      <label class="lh-field" data-role="when" hidden><span class="lh-label">Call back on</span>
        <input class="fe-input" type="date" name="until" min="${addDays(todayKey(), 1)}" /></label>
      <label class="lh-field"><span class="lh-label">Note (optional)</span>
        <textarea name="note" rows="2" maxlength="500" placeholder="e.g. Away until March, will book then"></textarea></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button>
      </div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const when = dlg.querySelector('[data-role="when"]');
    form.addEventListener("change", (e) => { if (e.target.name === "out") when.hidden = e.target.value !== "callback"; });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const outcome = (form.querySelector('[name="out"]:checked') || {}).value || "";
      const until = form.elements.until.value;
      const note = form.elements.note.value.trim().slice(0, 500);
      err.hidden = true;
      if (!outcome) { err.textContent = "Choose what happened."; err.hidden = false; return; }
      if (outcome === "callback" && !(until > todayKey())) { err.textContent = "Choose a call-back date after today."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      const data = {
        list: kind, key, patientId: r.id || "", patientName: String(r.name || "").slice(0, 120), outcome, note,
        until: outcome === "callback" ? until : "", by: String((staff && staff.name) || "").slice(0, 120),
        byUid: auth.currentUser ? auth.currentUser.uid : "", at: serverTimestamp(),
      };
      try {
        await setDoc(doc(db, "report_contacts", `${kind}__${key}`), data);
        st.contacts.set(key, { ...data, at: new Date() });
        dlg.close();
        showToast(outcome === "booked" ? "Saved. They come off the list once the booking is in the appointment book." : "Saved.");
        draw();
      } catch (ex) {
        console.error("Contact not saved:", ex);
        err.textContent = ex && ex.code === "permission-denied"
          ? "Couldn't save. Check the report_contacts Firestore rule has been published." : "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.showModal();
  }

  function exportCsv() {
    const { list } = compute();
    if (!list.length) { showToast("Nothing to export."); return; }
    downloadCsv(`${kind}-${st.today}.csv`, [
      ["Patient", "Patient ID", "Mobile", "Email", "Do not contact", ...L.csvHead, "Last visit", "Next booking",
        "Contact", "Contacted on", "Contacted by", "Note"],
      ...list.map(({ r, c }) => [r.name, r.ptt || r.id, r.mobile, r.email, r.dnc ? "Yes" : "", ...L.csvRow(r), r.last || "", r.next || "",
        c ? OUT[c.outcome] || c.outcome : "", c && c.at ? keyOf(c.at) : "", c ? c.by || "" : "", c ? c.note || "" : ""]),
    ]);
  }

  body.addEventListener("change", (e) => {
    const k = e.target.dataset.f;
    if (!k || k === "q") return;
    if (k === "done") st.done = e.target.checked;
    else { st.f[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value; st.pick = null; }
    draw();
  });
  let qTimer = null;
  body.addEventListener("input", (e) => {
    if (e.target.dataset.f !== "q") return;
    st.q = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(draw, 200);
  });
  body.addEventListener("click", (e) => {
    const pk = e.target.closest("[data-pick]");
    if (pk) {
      const same = st.pick && st.pick.g === pk.dataset.pick && st.pick.v === pk.dataset.v;
      st.pick = same ? null : { g: pk.dataset.pick, v: pk.dataset.v };
      draw();
      return;
    }
    if (e.target.closest('[data-act="unpick"]')) { st.pick = null; draw(); return; }
    const lg = e.target.closest("[data-log]");
    if (lg) { const x = st.list[Number(lg.dataset.log)]; if (x) logContact(x.r); return; }
    if (e.target.closest('[data-act="refresh"]')) { load(true); return; }
    if (e.target.closest('[data-act="csv"]')) exportCsv();
  });

  drawTools();
  load();
}