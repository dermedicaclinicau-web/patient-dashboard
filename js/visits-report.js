// Reporting → Patient visits: who came in between two dates, for chosen services, and whether they're booked again
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); };
const nice = (k) => { const d = parse(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const PRESETS = [["30", "Last 30 days"], ["90", "Last 90 days"], ["180", "Last 6 months"], ["365", "Last 12 months"],
  ["year", "This year"], ["custom", "Choose dates"]];
const SENT_HOW = { email: "Emailed", text: "Texted", call: "Called" };
const SKELETON = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';

export function mountVisitsReport(body, { csv } = {}) {
  const today = keyOf(new Date());
  const yesterday = addDays(today, -1);
  const st = {
    preset: "90", from: addDays(yesterday, -89), to: yesterday, data: null,
    svcs: new Set(), svcQ: "", panel: false, staff: -1, next: "all", q: "", hideDnc: false,
    sort: "lastDay", dir: -1, show: 300,
  };

  body.innerHTML = `<div data-role="tools"></div><div data-role="panel"></div><div data-role="out">${SKELETON}</div>`;
  const toolsEl = body.querySelector('[data-role="tools"]');
  const panelEl = body.querySelector('[data-role="panel"]');
  const out = body.querySelector('[data-role="out"]');

  function setPreset(p) {
    st.preset = p;
    if (p === "custom") return;
    st.to = yesterday;
    st.from = p === "year" ? `${today.slice(0, 4)}-01-01` : addDays(yesterday, -(Number(p) - 1));
    if (st.from > st.to) st.from = st.to;
  }

  async function load(fresh = false) {
    out.innerHTML = SKELETON;
    try {
      const r = await callApi({ action: "reports", op: "visits", from: st.from, to: st.to, fresh });
      if (!out.isConnected) return;
      if (r.problem) { out.innerHTML = `<div class="tm-empty is-error">${esc(r.problem)}</div>`; return; }
      // Services picked before still apply, if they're in the new dates too
      const keep = st.data ? [...st.svcs].map((i) => st.data.services[i]) : [];
      const staffName = st.data && st.staff >= 0 ? st.data.staff[st.staff] : "";
      st.data = r;
      st.svcs = new Set(keep.map((s) => r.services.indexOf(s)).filter((i) => i >= 0));
      st.staff = staffName ? r.staff.indexOf(staffName) : -1;
      st.show = 300;
      drawTools();
      drawPanel();
      draw();
    } catch (err) {
      console.error("Patient visits failed:", err);
      if (out.isConnected) out.innerHTML = `<div class="tm-empty is-error">${esc((err && err.message) || "Couldn't load the report. Try again.")}</div>`;
    }
  }

  function drawTools() {
    const d = st.data;
    const staffOpts = d ? d.staff.map((n, i) => [i, n]).filter(([i, n]) => i > 0 && n)
      .sort((a, b) => a[1].localeCompare(b[1])) : [];
    const svcLabel = !st.svcs.size ? "Any service" : st.svcs.size === 1 ? d.services[[...st.svcs][0]] : `${st.svcs.size} services`;
    toolsEl.innerHTML = `<div class="inv-tools rp-tools vr-tools">
      <select class="fb-select" data-f="preset" aria-label="Dates">${PRESETS.map(([v, l]) =>
        `<option value="${v}"${st.preset === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
      ${st.preset === "custom" ? `
        <label class="rp-from">From <input class="fe-in" type="date" data-f="from" value="${esc(st.from)}" max="${esc(yesterday)}" /></label>
        <label class="rp-from">To <input class="fe-in" type="date" data-f="to" value="${esc(st.to)}" max="${esc(yesterday)}" /></label>`
        : `<span class="muted">${esc(nice(st.from))} – ${esc(nice(st.to))}</span>`}
      <button type="button" class="ff-btn${st.svcs.size ? " is-primary" : ""}" data-act="panel" aria-expanded="${st.panel}">
        Services: ${esc(svcLabel)} ▾</button>
      <select class="fb-select" data-f="staff" aria-label="Clinician"><option value="-1">Any clinician</option>${staffOpts.map(([i, n]) =>
        `<option value="${i}"${st.staff === i ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>
      <select class="fb-select" data-f="next" aria-label="Upcoming visit">
        <option value="all"${st.next === "all" ? " selected" : ""}>Upcoming visit: anyone</option>
        <option value="yes"${st.next === "yes" ? " selected" : ""}>Has an upcoming visit</option>
        <option value="no"${st.next === "no" ? " selected" : ""}>No upcoming visit</option></select>
      <input type="search" class="fe-input rp-find" data-f="q" placeholder="Name, mobile or email" value="${esc(st.q)}" aria-label="Search" />
      <label class="fe-check"><input type="checkbox" data-f="dnc"${st.hideDnc ? " checked" : ""} /> Hide do-not-contact</label>
      <span class="inv-spacer"></span>
      <button type="button" class="ff-btn" data-act="refresh" title="Read the appointment book again">Refresh</button>
      <button type="button" class="ff-btn" data-act="csv">Export CSV</button>
    </div>`;
  }

  // How many patients had each service in these dates
  function serviceCounts() {
    const d = st.data;
    const n = new Array(d.services.length).fill(0);
    d.pts.forEach((p) => {
      const seen = new Set();
      p.v.forEach(([, s]) => s.forEach((i) => seen.add(i)));
      seen.forEach((i) => { n[i]++; });
    });
    return n;
  }

  function drawPanel() {
    if (!st.panel || !st.data) { panelEl.innerHTML = ""; return; }
    const d = st.data;
    const counts = serviceCounts();
    const q = st.svcQ.trim().toLowerCase();
    const list = d.services.map((s, i) => ({ s, i, n: counts[i] }))
      .filter((x) => !q || x.s.toLowerCase().includes(q))
      .sort((a, b) => Number(st.svcs.has(b.i)) - Number(st.svcs.has(a.i)) || b.n - a.n || a.s.localeCompare(b.s));
    panelEl.innerHTML = `<section class="tb-card vr-panel">
      <div class="vr-panel-head">
        <input type="search" class="fe-input" data-f="svcQ" placeholder="Find a service, e.g. wrinkle, filler, laser" value="${esc(st.svcQ)}" />
        ${q && list.length ? `<button type="button" class="lh-btn" data-act="svc-all">Tick all shown (${list.length})</button>` : ""}
        ${st.svcs.size ? '<button type="button" class="lh-btn is-quiet" data-act="svc-none">Clear (any service)</button>' : ""}
        <button type="button" class="lh-btn is-primary" data-act="panel">Done</button>
      </div>
      <p class="muted vr-hint">A patient is listed if any of their visits in these dates was for a ticked service. Nothing ticked = any service.</p>
      <div class="vr-svcs">${list.slice(0, 300).map((x) => `<label class="fe-check vr-svc">
        <input type="checkbox" data-svc="${x.i}"${st.svcs.has(x.i) ? " checked" : ""} /> <span>${esc(x.s)}</span><small>${x.n}</small></label>`).join("")
        || '<p class="muted">No services match.</p>'}</div>
      ${list.length > 300 ? `<p class="muted vr-hint">Showing 300 of ${list.length}. Type to narrow it down.</p>` : ""}
    </section>`;
  }

  // Patients with at least one matching visit. withNext false: the upcoming filter isn't applied (for the cards)
  function matches(withNext = true) {
    const d = st.data;
    const q = st.q.trim().toLowerCase();
    const outRows = [];
    d.pts.forEach((p) => {
      if (st.hideDnc && p.dnc) return;
      if (q && !`${p.name} ${p.mobile} ${p.email}`.toLowerCase().includes(q)) return;
      if (withNext && st.next === "yes" && !p.next) return;
      if (withNext && st.next === "no" && p.next) return;
      const vis = p.v.filter(([, s, t]) => (!st.svcs.size || s.some((i) => st.svcs.has(i))) && (st.staff < 0 || t === st.staff));
      if (!vis.length) return;
      const lastV = vis[vis.length - 1];
      outRows.push({ p, n: vis.length, lastDay: lastV[0], lastSvcs: lastV[1].map((i) => d.services[i]),
        lastStaff: d.staff[lastV[2]] || "", firstDay: vis[0][0] });
    });
    return outRows;
  }

  function sorted(rows) {
    const k = st.sort, dir = st.dir;
    const val = (r) => (k === "name" ? r.p.name.toLowerCase() : k === "n" ? r.n : k === "next" ? (r.p.next || "9999")
      : k === "last" ? r.p.last : r.lastDay);
    return rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.p.name.localeCompare(b.p.name); });
  }

  function draw() {
    if (!st.data) return;
    const base = matches(false);
    const rows = sorted(matches(true));
    const withNext = base.filter((r) => r.p.next).length;
    const visits = rows.reduce((a, r) => a + r.n, 0);
    const card = (v, cls, num, label) => `<div class="inv-stat ${cls}${st.next === v ? " is-active" : ""}" data-next="${v}"
      role="button" tabindex="0"><strong>${num}</strong><span>${esc(label)}</span></div>`;
    const th = (k, l) => `<th data-sort="${k}" class="vr-sort${st.sort === k ? " is-on" : ""}">${esc(l)}${st.sort === k ? (st.dir < 0 ? " ↓" : " ↑") : ""}</th>`;
    const sentText = (s) => (s ? `${SENT_HOW[s.how] || "Contacted"} ${esc(nice(String(s.at).slice(0, 10)))}${s.src ? ` · ${esc(s.src)}` : ""}` : "");
    out.innerHTML = `
      <p class="muted rp-range">${esc(nice(st.from))} – ${esc(nice(st.to))} · ${plural(rows.length, "patient")} · ${plural(visits, "visit")}${
        st.svcs.size ? ` for ${esc([...st.svcs].map((i) => st.data.services[i]).slice(0, 3).join(", "))}${st.svcs.size > 3 ? ` and ${st.svcs.size - 3} more` : ""}` : ""}${
        st.data.cached ? ` · <small>worked out ${esc(new Date(st.data.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }))}</small>` : ""}</p>
      <div class="inv-stats">
        ${card("all", "", base.length, "Patients")}
        ${card("yes", "", withNext, "Have an upcoming visit")}
        ${card("no", base.length - withNext ? "is-warn" : "", base.length - withNext, "No upcoming visit")}
      </div>
      ${rows.length ? `<section class="tb-card"><div class="rp-scroll"><table class="inv-table rp-table vr-table">
        <thead><tr>${th("name", "Patient")}${th("n", "Visits")}${th("lastDay", "Last matching visit")}${th("last", "Last visit (any)")}${
          th("next", "Next booked")}<th>Contact</th></tr></thead>
        <tbody>${rows.slice(0, st.show).map((r) => `<tr>
          <td>${r.p.id ? `<a href="#/patient/${encodeURIComponent(r.p.id)}" target="_blank" rel="noopener">${esc(r.p.name || "Patient")}</a>` : esc(r.p.name || "—")}${
            r.p.dnc ? ' <span class="inv-flag is-warn">Do not contact</span>' : ""}</td>
          <td>${r.n}</td>
          <td>${esc(nice(r.lastDay))}<small class="muted">${esc(r.lastSvcs.join(", "))}${r.lastStaff ? ` · ${esc(r.lastStaff)}` : ""}</small></td>
          <td>${r.p.last && r.p.last !== r.lastDay ? esc(nice(r.p.last)) : '<span class="muted">same</span>'}</td>
          <td>${r.p.next ? `<strong>${esc(nice(r.p.next))}</strong><small class="muted">${esc(r.p.nextSvc.join(", "))}</small>`
            : '<span class="inv-flag">None booked</span>'}</td>
          <td><small>${esc(r.p.mobile || "")}${r.p.mobile && r.p.email ? "<br>" : ""}${esc(r.p.email || "")}</small>${
            r.p.sent ? `<small class="muted">${sentText(r.p.sent)}</small>` : ""}</td></tr>`).join("")}</tbody>
      </table></div>
      ${rows.length > st.show ? `<p class="rp-note"><button type="button" class="lh-btn" data-act="more">Show ${Math.min(300, rows.length - st.show)} more</button>
        <span class="muted">of ${rows.length}</span></p>` : ""}</section>`
      : `<div class="tm-empty">${st.data.pts.length ? "Nobody matches these filters." : "No visits in these dates."}</div>`}`;
  }

  function exportCsv() {
    if (!st.data || !csv) return;
    const rows = sorted(matches(true));
    if (!rows.length) { showToast("Nothing to export."); return; }
    const names = (r) => r.p.v.filter(([, s, t]) => (!st.svcs.size || s.some((i) => st.svcs.has(i))) && (st.staff < 0 || t === st.staff))
      .map(([d, s]) => `${d}: ${s.map((i) => st.data.services[i]).join(", ")}`).join(" | ");
    csv(`patient-visits-${st.from}-to-${st.to}.csv`, [
      ["Patient", "Mobile", "Email", "Do not contact", "Matching visits", "First matching visit", "Last matching visit",
        "Last matching services", "Clinician", "Last visit (any)", "Next booked", "Next services", "Contacted (last 30 days)", "All matching visits"],
      ...rows.map((r) => [r.p.name, r.p.mobile, r.p.email, r.p.dnc ? "Yes" : "", r.n, r.firstDay, r.lastDay, r.lastSvcs.join(", "),
        r.lastStaff, r.p.last, r.p.next || "", r.p.nextSvc.join(", "),
        r.p.sent ? `${SENT_HOW[r.p.sent.how] || "Contacted"} ${String(r.p.sent.at).slice(0, 10)}` : "", names(r)]),
    ]);
  }

  /* ---------- Events ---------- */

  body.addEventListener("change", (e) => {
    const t = e.target;
    const f = t.dataset.f;
    if (t.dataset.svc !== undefined) {
      const i = Number(t.dataset.svc);
      if (t.checked) st.svcs.add(i); else st.svcs.delete(i);
      st.show = 300;
      drawTools();
      draw();
      return;
    }
    if (f === "preset") { setPreset(t.value); drawTools(); if (st.preset !== "custom") load(); return; }
    if (f === "from" || f === "to") {
      st[f] = t.value;
      if (parse(st.from) && parse(st.to)) {
        if (st.from > st.to) [st.from, st.to] = [st.to, st.from];
        drawTools();
        load();
      }
      return;
    }
    if (f === "staff") { st.staff = Number(t.value); st.show = 300; draw(); return; }
    if (f === "next") { st.next = t.value; st.show = 300; draw(); return; }
    if (f === "dnc") { st.hideDnc = t.checked; draw(); }
  });

  let timer = null;
  body.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    if (f !== "q" && f !== "svcQ") return;
    st[f] = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (f === "svcQ") {
        const pos = e.target.selectionStart;
        drawPanel();
        const el = panelEl.querySelector('[data-f="svcQ"]');
        if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not a text box */ } }
      } else { st.show = 300; draw(); }
    }, 200);
  });

  body.addEventListener("click", (e) => {
    const nx = e.target.closest("[data-next]");
    if (nx) { st.next = nx.dataset.next; st.show = 300; drawTools(); draw(); return; }
    const so = e.target.closest("th[data-sort]");
    if (so) {
      const k = so.dataset.sort;
      st.dir = st.sort === k ? -st.dir : (k === "name" || k === "next" ? 1 : -1);
      st.sort = k;
      draw();
      return;
    }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "panel") { st.panel = !st.panel; drawTools(); drawPanel(); if (st.panel) panelEl.querySelector('[data-f="svcQ"]')?.focus(); }
    else if (act === "svc-all") {
      const q = st.svcQ.trim().toLowerCase();
      st.data.services.forEach((s, i) => { if (s.toLowerCase().includes(q)) st.svcs.add(i); });
      st.show = 300; drawTools(); drawPanel(); draw();
    } else if (act === "svc-none") { st.svcs.clear(); drawTools(); drawPanel(); draw(); }
    else if (act === "more") { st.show += 300; draw(); }
    else if (act === "refresh") load(true);
    else if (act === "csv") exportCsv();
  });

  body.addEventListener("keydown", (e) => {
    const nx = e.target.closest && e.target.closest("[data-next]");
    if (nx && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); nx.click(); }
  });

  drawTools();
  load();
}