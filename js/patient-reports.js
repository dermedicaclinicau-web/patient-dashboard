// Reporting → patient lists: Packages left, Skin Scripts expiring, New patients not back.
// The lists are worked out by Apps Script (action "reports"); contacts are logged in Firestore report_contacts.
import { db, auth } from "./firebase-config.js";
import { collection, doc, getDocs, query, where, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";
import { downloadCsv } from "./reports.js";

export const PATIENT_TABS = [["packages", "Packages left"], ["ssp", "Skin Scripts expiring"], ["newpts", "New patients not back"]];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SKEL = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const parse = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); };
const nice = (k) => { const d = parse(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const between = (a, b) => { const x = parse(a), y = parse(b); return x && y ? Math.round((y - x) / 864e5) : null; };
const money = (n) => `$${Math.round(n).toLocaleString("en-AU")}`;
const rel = (d) => (d === null ? "" : d === 0 ? "today" : d > 0 ? `in ${d} day${d === 1 ? "" : "s"}` : `${-d} day${d === -1 ? "" : "s"} ago`);

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

/* ---------- Shared cells ---------- */
const patientCell = (r) => `${r.id ? `<a href="#/patient/${encodeURIComponent(r.id)}"><strong>${esc(r.name || "Patient")}</strong></a>`
  : `<strong>${esc(r.name || "Patient")}</strong> <span class="inv-flag is-warn" title="No Patient ID, or it isn't in the Patient List">Not linked</span>`}${
  r.dnc ? ' <span class="inv-flag is-bad">Do not contact</span>' : ""}${
  r.mobile || r.email ? `<br><small class="muted">${esc([r.mobile, r.email].filter(Boolean).join(" · "))}</small>` : ""}`;
const lastCell = (r, today) => (r.last ? `${esc(nice(r.last))}<br><small class="muted">${esc(rel(between(today, r.last)))}</small>` : "—");
const nextCell = (r) => (r.next ? `${esc(nice(r.next))}${(r.nextSvc || []).length ? `<br><small class="muted">${esc(r.nextSvc.join(", "))}</small>` : ""}`
  : '<span class="muted">Nothing booked</span>');

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
    stats(list, today) {
      const value = list.reduce((a, x) => a + (x.r.value || 0), 0);
      const soon = list.filter((x) => { const d = between(today, x.r.expires); return d !== null && d <= 30; }).length;
      return [[new Set(list.map((x) => x.r.id || x.r.name)).size, "Patients"], [list.reduce((a, x) => a + (x.r.left || 0), 0), "Visits left"],
        [value ? money(value) : "—", "Value of visits left"], [soon, "Expire in the next 30 days", soon ? "is-warn" : ""]];
    },
    head: ["Package", "Visits left", "Expires", "Last visit", "Next booking", "Value"],
    cells: (r, today) => {
      const d = between(today, r.expires);
      return [
        `${esc(r.pkg)}${r.status ? `<br><small class="muted">${esc(r.status)}</small>` : ""}`,
        `<strong>${esc(r.left)}</strong>${(r.lines || []).length ? `<br><small class="muted">${esc(r.lines.map((l) => `${l.svc || "Service"} ×${l.left}`).join(", "))}</small>` : ""}`,
        r.expires ? `${esc(nice(r.expires))}<br><small class="${d !== null && d <= 30 ? "rp-neg" : "muted"}">${esc(rel(d))}</small>` : '<span class="muted">No expiry</span>',
        lastCell(r, today), nextCell(r), r.value ? esc(money(r.value)) : "—",
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
    stats(list, today) {
      const soon = list.filter((x) => between(today, x.r.expires) >= 0).length;
      return [[list.length, "Patients"], [soon, "Still valid, expiring soon"], [list.length - soon, "Already expired", list.length - soon ? "is-warn" : ""]];
    },
    head: ["Skin Script", "Expires", "Last visit", "Next booking"],
    cells: (r, today) => {
      const d = between(today, r.expires);
      return [
        `${esc(nice(r.date))}${r.by ? `<br><small class="muted">by ${esc(r.by)}</small>` : ""}`,
        `${esc(nice(r.expires))}<br><small class="${d < 0 ? "rp-neg" : "muted"}">${d < 0 ? "Expired " : "Expires "}${esc(rel(d))}</small>`,
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
    stats(list) {
      const by = {};
      list.forEach((x) => { const s = x.r.firstStaff || "Unknown"; by[s] = (by[s] || 0) + 1; });
      const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n, c]) => `${n} (${c})`).join(", ");
      return [[list.length, "Patients"], [top || "—", "Seen most by"]];
    },
    head: ["Their visit", "Treatment", "With"],
    cells: (r, today) => [
      `${esc(nice(r.first))}<br><small class="muted">${esc(rel(between(today, r.first)))}</small>`,
      esc((r.firstSvc || []).join(", ") || "—"), esc(r.firstStaff || "—"),
    ],
    csvHead: ["Visit date", "Treatment", "With"],
    csvRow: (r) => [r.first, (r.firstSvc || []).join("; "), r.firstStaff],
  },
};

/* ---------- The page ---------- */
export function mountPatientReport(body, kind, staff) {
  const L = LISTS[kind];
  const st = { rows: [], contacts: new Map(), f: {}, q: "", done: false, at: "", today: todayKey(), list: [] };
  L.filters.forEach((x) => { st.f[x.k] = x.def; });
  body.innerHTML = `<p class="muted rp-range">${esc(L.intro)}</p><div data-role="tools"></div><div data-role="out">${SKEL}</div>`;
  const toolsEl = body.querySelector('[data-role="tools"]');
  const out = body.querySelector('[data-role="out"]');

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

  function compute() {
    const q = st.q.trim().toLowerCase();
    let hidden = 0;
    const list = [];
    st.rows.forEach((r) => {
      if (!L.match(r, st.f, st.today)) return;
      if (q && ![r.name, r.mobile, r.email, r.pkg].join(" ").toLowerCase().includes(q)) return;
      const c = st.contacts.get(rowKey(r));
      if (!st.done && contacted(c, st.today)) { hidden++; return; }
      list.push({ r, c });
    });
    list.sort((a, b) => L.sort(a.r, b.r, st.today));
    return { list, hidden };
  }

  const contactCell = (c, i) => `${c ? `<div class="rp-done"><span class="inv-flag ${c.outcome === "booked" ? "is-ok"
    : c.outcome === "not_interested" ? "is-bad" : "is-info"}">${esc(OUT[c.outcome] || c.outcome)}</span>
      <small>${esc([c.at ? c.at.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "", c.by,
        c.outcome === "callback" && c.until ? `call back ${nice(c.until)}` : ""].filter(Boolean).join(" · "))}</small>
      ${c.note ? `<small>“${esc(c.note)}”</small>` : ""}</div>` : ""}
    <button type="button" class="lh-btn" data-log="${i}">${c ? "Update" : "Log contact"}</button>`;

  function draw() {
    const { list, hidden } = compute();
    st.list = list;
    const shown = list.slice(0, 500);
    out.innerHTML = `
      <p class="muted rp-range">${list.length} on the list${hidden ? ` · ${hidden} already contacted (hidden)` : ""}${
        st.at ? ` · worked out at ${esc(new Date(st.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }))}` : ""}</p>
      ${list.length ? `<div class="inv-stats">${L.stats(list, st.today).map(([v, l, cls]) =>
          `<div class="inv-stat ${cls || ""}"><strong>${esc(String(v))}</strong><span>${esc(l)}</span></div>`).join("")}</div>
        <section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table">
          <thead><tr><th>Patient</th>${L.head.map((h) => `<th>${esc(h)}</th>`).join("")}<th>Contact</th></tr></thead>
          <tbody>${shown.map((x, i) => `<tr><td>${patientCell(x.r)}</td>${L.cells(x.r, st.today).map((c) => `<td>${c}</td>`).join("")}
            <td class="pr-contact">${contactCell(x.c, i)}</td></tr>`).join("")}</tbody>
        </table></div>${list.length > 500 ? `<p class="muted rp-note">Showing the first 500. Export CSV for all ${list.length}.</p>` : ""}</section>`
        : `<div class="tm-empty">${hidden ? "Everyone on this list has been contacted. 👍" : "Nobody matches. 👍"}</div>`}`;
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
    else st.f[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
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
    const lg = e.target.closest("[data-log]");
    if (lg) { const x = st.list[Number(lg.dataset.log)]; if (x) logContact(x.r); return; }
    if (e.target.closest('[data-act="refresh"]')) { load(true); return; }
    if (e.target.closest('[data-act="csv"]')) exportCsv();
  });

  drawTools();
  load();
}