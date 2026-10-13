// Reporting → Treatment plans: conversion, treatments that need booking, and plans going quiet.
import { db, auth } from "./firebase-config.js";
import { collection, getDocs, addDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { getPlanSettings } from "./plan-api.js";
import { getMasterPlan, saveMasterPlan, PLAN_STATUS, monthLabel } from "./master-plan-api.js";
import { dateKeyOf, dayLabel } from "./plan-track.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const RANK = { proposed: 0, sent: 1, accepted: 2, in_progress: 3, completed: 4 };
const STAGES = [["created", "Created"], ["sent", "Sent"], ["accepted", "Accepted"], ["in_progress", "Started"], ["completed", "Completed"]];
const ACTIVE = ["active", "maintenance"];
const BOOKING = ["accepted", "in_progress"];
const NEED = { overdue: "Overdue", due: "Due this month", unscheduled: "Not scheduled" };
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const keyAgo = (days) => dateKeyOf(new Date(Date.now() - days * 864e5));
const daysSince = (key) => (key ? Math.max(0, Math.floor((Date.now() - new Date(`${key}T00:00:00`).getTime()) / 864e5)) : null);
const seg = (name, items, cur) => `<div class="fe-seg">${items.map(([v, l]) =>
  `<label class="fe-seg-btn"><input type="radio" name="${name}" value="${v}" data-rp-f="${name}"${v === cur ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>`;
const patientLink = (r) => `<a href="#/patient/${encodeURIComponent(r.patientId)}">${esc(r.patientName || r.patientId)}</a>`;

export async function renderPlanReports(body, { staff } = {}) {
  body.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
  const st = { view: "conversion", days: "90", need: "all", q: "", quiet: "90", drill: "", needs: [], quietList: [] };
  let rows = [];
  let settings = { concerns: [] };

  async function fetchAll() {
    const [snap, s] = await Promise.all([
      getDocs(collection(db, "plan_progress")),
      getPlanSettings().catch(() => ({ concerns: [] })),
    ]);
    rows = snap.docs.map((d) => ({ ...d.data(), patientId: d.id }));
    settings = s;
  }

  try {
    await fetchAll();
  } catch (err) {
    console.error("Plan reports failed:", err);
    if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
      ? "Plan progress isn't accessible. Check the plan_progress Firestore rule has been published."
      : "Couldn't load the treatment plan reports. Try again."}</div>`;
    return;
  }
  if (!body.isConnected) return;

  const con = (k) => settings.concerns.find((c) => c.name === k) || { label: k, colour: "#888780" };
  const chip = (k) => `<span class="ps-chip" style="--c:${esc(con(k).colour)}">${esc(con(k).label)}</span>`;
  const reached = (r, stage) => stage === "created" || (RANK[r.effStatus] ?? -1) >= RANK[stage];
  const statusPill = (r) => `<span class="pv-status is-${esc(r.effStatus)}">${esc(PLAN_STATUS[r.effStatus] || r.effStatus)}</span>`;

  /* ---------- Conversion ---------- */

  function inPeriod() {
    const since = st.days === "all" ? "" : keyAgo(Number(st.days));
    return rows.filter((r) => !since || String(r.createdAt).slice(0, 10) >= since);
  }

  function drillRows(list) {
    const [kind, a, b] = st.drill.split("|");
    if (kind === "stage") return list.filter((r) => (a === "closed" ? r.effStatus === "closed" : reached(r, a)));
    if (kind === "clin") return list.filter((r) => (r.createdBy || "Unknown") === a && (b === "closed" ? r.effStatus === "closed" : reached(r, b)));
    if (kind === "con") {
      return list.filter((r) => (r.concerns || []).some((c) => c.key === a
        && (b === "all" || (b === "started" && c.started) || c.status === b)));
    }
    return [];
  }

  function conversionHtml() {
    const list = inPeriod();
    if (!list.length) return '<div class="tm-empty">No plans were created in this period.</div>';
    const cell = (drill, n, of) => `<button type="button" class="rp-num${st.drill === drill ? " is-on" : ""}" data-drill="${esc(drill)}">${n}${
      of !== undefined ? ` <small>${pct(n, of)}</small>` : ""}</button>`;
    const closed = list.filter((r) => r.effStatus === "closed").length;

    const byClin = new Map();
    list.forEach((r) => {
      const k = r.createdBy || "Unknown";
      if (!byClin.has(k)) byClin.set(k, []);
      byClin.get(k).push(r);
    });
    const keys = settings.concerns.map((c) => c.name).filter((k) => list.some((r) => (r.concerns || []).some((c) => c.key === k)));

    const drilled = st.drill ? drillRows(list) : [];
    return `
      <div class="rp-funnel">${STAGES.map(([k, l]) => {
        const n = list.filter((r) => reached(r, k)).length;
        return `<button type="button" class="rp-stage${st.drill === `stage|${k}` ? " is-on" : ""}" data-drill="stage|${k}">
          <span>${esc(l)}</span><strong>${n}</strong><small>${k === "created" ? "plans" : `${pct(n, list.length)} of created`}</small></button>`;
      }).join("")}
        <button type="button" class="rp-stage is-closed${st.drill === "stage|closed" ? " is-on" : ""}" data-drill="stage|closed">
          <span>Closed</span><strong>${closed}</strong><small>stopped early</small></button>
      </div>
      <p class="rp-note">"Started" means a planned treatment has been done or booked. Each stage counts every plan that got at least that far.</p>

      <section class="tb-card"><h4>By clinician</h4>
        <table class="inv-table rp-table"><thead><tr><th>Made by</th><th>Created</th><th>Accepted</th><th>Started</th><th>Completed</th><th>Closed</th></tr></thead>
        <tbody>${[...byClin.entries()].sort((a, b) => b[1].length - a[1].length).map(([name, rs]) => {
          const n = (s) => rs.filter((r) => reached(r, s)).length;
          return `<tr><td>${esc(name)}</td><td>${cell(`clin|${name}|created`, rs.length)}</td>
            <td>${cell(`clin|${name}|accepted`, n("accepted"), rs.length)}</td><td>${cell(`clin|${name}|in_progress`, n("in_progress"), rs.length)}</td>
            <td>${cell(`clin|${name}|completed`, n("completed"), rs.length)}</td>
            <td>${cell(`clin|${name}|closed`, rs.filter((r) => r.effStatus === "closed").length)}</td></tr>`;
        }).join("")}</tbody></table></section>

      <section class="tb-card"><h4>By concern</h4>
        <table class="inv-table rp-table"><thead><tr><th>Concern</th><th>In plans</th><th>Started</th><th>Resolved</th><th>Not pursuing</th></tr></thead>
        <tbody>${keys.map((k) => {
          const cs = list.flatMap((r) => (r.concerns || []).filter((c) => c.key === k));
          return `<tr><td>${chip(k)}</td><td>${cell(`con|${k}|all`, cs.length)}</td>
            <td>${cell(`con|${k}|started`, cs.filter((c) => c.started).length, cs.length)}</td>
            <td>${cell(`con|${k}|resolved`, cs.filter((c) => c.status === "resolved").length, cs.length)}</td>
            <td>${cell(`con|${k}|not_pursuing`, cs.filter((c) => c.status === "not_pursuing").length, cs.length)}</td></tr>`;
        }).join("")}</tbody></table></section>

      ${st.drill ? `<section class="tb-card"><h4>Patients <small class="muted">(${drilled.length})</small>
          <button type="button" class="po-mini" data-rp="undrill">Clear</button></h4>
        ${drilled.length ? `<div class="rp-list">${drilled.map((r) => `<div class="rp-row">
          <span class="rp-who">${patientLink(r)}</span>${statusPill(r)}
          <span class="rp-meta">Created ${esc(dayLabel(String(r.createdAt).slice(0, 10)))}${r.createdBy ? ` by ${esc(r.createdBy)}` : ""}</span>
          <span class="rp-chips">${(r.concerns || []).map((c) => chip(c.key)).join("")}</span></div>`).join("")}</div>`
          : '<p class="tb-none">Nobody.</p>'}</section>` : ""}`;
  }

  /* ---------- Needs booking ---------- */

  function needsHtml() {
    const q = st.q.trim().toLowerCase();
    const rank = { overdue: 0, due: 1, unscheduled: 2 };
    st.needs = [];
    rows.forEach((r) => {
      if (!BOOKING.includes(r.effStatus)) return;
      (r.lines || []).forEach((l) => {
        if (!ACTIVE.includes(l.concernStatus) || !(l.state in rank)) return;
        if (st.need !== "all" && l.state !== st.need) return;
        if (q && !`${r.patientName} ${l.treatment}`.toLowerCase().includes(q)) return;
        st.needs.push({ r, l });
      });
    });
    st.needs.sort((a, b) => rank[a.l.state] - rank[b.l.state] || String(a.l.month).localeCompare(String(b.l.month))
      || String(a.r.patientName).localeCompare(String(b.r.patientName)));
    const n = (s) => rows.reduce((t, r) => t + (BOOKING.includes(r.effStatus)
      ? (r.lines || []).filter((l) => ACTIVE.includes(l.concernStatus) && l.state === s).length : 0), 0);
    return `
      <div class="inv-tools">
        ${seg("need", [["all", "All"], ["overdue", `Overdue (${n("overdue")})`], ["due", `Due (${n("due")})`], ["unscheduled", `Not scheduled (${n("unscheduled")})`]], st.need)}
        <label class="ib-search inv-find"><input type="search" data-rp-q placeholder="Search patients or treatments" value="${esc(st.q)}" aria-label="Search" /></label>
      </div>
      ${st.needs.length ? `<div class="rp-list">${st.needs.map(({ r, l }, i) => `<div class="rp-row is-${esc(l.state)}">
        <span class="rp-who">${patientLink(r)}</span>
        <span class="rp-tx">${chip(l.concern)} <strong>${esc(l.treatment)}</strong>${l.total ? ` <small>session ${l.n} of ${l.total}</small>` : ""}</span>
        <span class="rp-when">${esc(l.state === "overdue" ? `Overdue since ${monthLabel(l.month)}` : NEED[l.state])}</span>
        <span class="rp-meta">${l.askedAt ? `Asked reception ${esc(dayLabel(l.askedAt.slice(0, 10)))}${l.askedBy ? ` (${esc(l.askedBy)})` : ""}` : ""}</span>
        <button type="button" class="lh-btn${l.askedAt ? "" : " is-primary"}" data-ask="${i}">${l.askedAt ? "Ask again" : "Ask reception to book"}</button>
      </div>`).join("")}</div>`
        : '<div class="tm-empty">Nothing needs booking. 👍</div>'}
      <p class="rp-note">Only plans the patient has accepted (or started) are listed. Plans still Proposed or Sent aren't chased.</p>`;
  }

  /* ---------- Going quiet ---------- */

  function quietHtml() {
    const limitKey = keyAgo(Number(st.quiet));
    st.quietList = rows.filter((r) => BOOKING.includes(r.effStatus) && !r.nextBooked
      && (r.lastVisit ? r.lastVisit < limitKey : String(r.createdAt).slice(0, 10) < limitKey))
      .sort((a, b) => String(a.lastVisit || a.createdAt).localeCompare(String(b.lastVisit || b.createdAt)));
    return `
      <div class="inv-tools">
        <span class="muted">Nothing booked, and no visit for</span>
        ${seg("quiet", [["60", "60 days"], ["90", "90 days"], ["180", "6 months"]], st.quiet)}
      </div>
      ${st.quietList.length ? `<div class="rp-list">${st.quietList.map((r, i) => {
        const last = r.lastVisit
          ? `Last plan visit ${dayLabel(r.lastVisit)} (${daysSince(r.lastVisit)} days ago)`
          : `No plan visits since it was made, ${dayLabel(String(r.createdAt).slice(0, 10))}`;
        return `<div class="rp-row">
          <span class="rp-who">${patientLink(r)}</span>${statusPill(r)}
          <span class="rp-meta">${esc(last)}</span>
          <span class="rp-chips">${(r.concerns || []).filter((c) => ACTIVE.includes(c.status)).map((c) => chip(c.key)).join("")}</span>
          <button type="button" class="lh-btn" data-call="${i}">Ask reception to call</button>
        </div>`;
      }).join("")}</div>`
        : '<div class="tm-empty">No accepted plans have gone quiet. 👍</div>'}`;
  }

  /* ---------- Layout ---------- */

  function draw() {
    if (!body.isConnected) return;
    const newest = rows.map((r) => r.computedAt).filter(Boolean).sort().pop();
    body.innerHTML = `
      <div class="inv-tools">
        ${seg("view", [["conversion", "Conversion"], ["needs", "Needs booking"], ["quiet", "Going quiet"]], st.view)}
        ${st.view === "conversion" ? seg("days", [["30", "30 days"], ["90", "90 days"], ["365", "12 months"], ["all", "All time"]], st.days) : ""}
        <span class="inv-spacer"></span>
        <span class="muted">${newest ? `Updated ${esc(new Date(newest).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}` : "Not worked out yet"}</span>
        <button type="button" class="lh-btn" data-rp="refresh">Refresh now</button>
      </div>
      ${!rows.length ? '<div class="tm-empty">No plan summaries yet. Click <strong>Refresh now</strong>, or wait for tomorrow morning\'s update.</div>'
        : st.view === "needs" ? needsHtml() : st.view === "quiet" ? quietHtml() : conversionHtml()}`;
  }

  /* ---------- Reminders for reception ---------- */

  async function remind(r, text, due) {
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) throw new Error("Your session has ended. Log in again.");
    await addDoc(collection(db, "staff-task-list"), {
      patientId: r.patientPttId || r.patientId, patientName: r.patientName || "", taskText: text.slice(0, 500),
      dueDate: due, status: "Open", createdAt: new Date().toISOString(),
      createdBy: (staff && staff.name) || "", createdByUid: uid,
    });
  }

  // Also notes "asked" on the session in the plan (needs clinical access; the reminder is added either way)
  async function markAsked(r, l, text) {
    const m = await getMasterPlan(r.patientId);
    const c = m && m.concerns.find((x) => x.key === l.concern);
    const line = c && c.lines.find((x) => x.id === l.lineId);
    if (!line) return;
    const n = String(l.n);
    line.overrides = { ...line.overrides, [n]: { ...(line.overrides[n] || {}), asked: { at: new Date().toISOString(), by: (staff && staff.name) || "" } } };
    await saveMasterPlan({ id: r.patientId, pttId: m.patientPttId, name: m.patientName },
      { status: m.status, concerns: m.concerns, events: m.events },
      { action: "Asked reception to book", summary: text, expectedVersion: m.version }, staff);
  }

  async function askBook(btn, i) {
    const it = st.needs[i];
    if (!it) return;
    const { r, l } = it;
    const when = l.state === "overdue" ? "as soon as possible" : l.month ? `in ${monthLabel(l.month)}` : "when it suits the patient";
    const text = `Please book ${r.patientName}: ${l.treatment} (${con(l.concern).label}${l.total ? `, session ${l.n} of ${l.total}` : ""}), ${when}.`;
    const today = dateKeyOf(new Date());
    btn.disabled = true;
    try {
      await remind(r, text, l.month && `${l.month}-01` > today ? `${l.month}-01` : today);
      try { await markAsked(r, l, text); } catch (e) { console.warn("Reminder added; the plan wasn't marked:", e); }
      l.askedAt = new Date().toISOString();
      l.askedBy = (staff && staff.name) || "";
      showToast("Reminder added for reception");
      draw();
    } catch (err) {
      console.error("Reminder failed:", err);
      showToast(err && err.message && !err.code ? err.message : "Couldn't add the reminder. Try again.");
      btn.disabled = false;
    }
  }

  async function askCall(btn, i) {
    const r = st.quietList[i];
    if (!r) return;
    const since = r.lastVisit ? `nothing booked since ${dayLabel(r.lastVisit)}` : "nothing booked since the plan was made";
    btn.disabled = true;
    try {
      await remind(r, `Please call ${r.patientName} about their treatment plan (${since}).`, dateKeyOf(new Date()));
      btn.textContent = "Reminder added";
      showToast("Reminder added for reception");
    } catch (err) {
      console.error("Reminder failed:", err);
      showToast("Couldn't add the reminder. Try again.");
      btn.disabled = false;
    }
  }

  /* ---------- Events ---------- */

  body.addEventListener("change", (e) => {
    const f = e.target.dataset.rpF;
    if (!f) return;
    st[f] = e.target.value;
    if (f === "view" || f === "days") st.drill = "";
    draw();
  });
  body.addEventListener("input", (e) => {
    if (!e.target.matches("[data-rp-q]")) return;
    st.q = e.target.value;
    const pos = e.target.selectionStart;
    draw();
    const box = body.querySelector("[data-rp-q]");
    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  });
  body.addEventListener("click", async (e) => {
    const dr = e.target.closest("[data-drill]");
    if (dr) { st.drill = st.drill === dr.dataset.drill ? "" : dr.dataset.drill; draw(); return; }
    if (e.target.closest('[data-rp="undrill"]')) { st.drill = ""; draw(); return; }
    const ask = e.target.closest("[data-ask]");
    if (ask) { askBook(ask, Number(ask.dataset.ask)); return; }
    const call = e.target.closest("[data-call]");
    if (call) { askCall(call, Number(call.dataset.call)); return; }
    const rf = e.target.closest('[data-rp="refresh"]');
    if (!rf || rf.disabled) return;
    rf.disabled = true;
    rf.textContent = "Working it out…";
    try {
      await callApi({ action: "plan", op: "refreshProgress" });
      await fetchAll();
      showToast("Plan reports updated");
      draw();
    } catch (err) {
      console.error("Refresh failed:", err);
      showToast(err && err.code === "FORBIDDEN" ? "Only staff with Reporting can refresh every plan." : "Couldn't refresh. Try again.");
      rf.disabled = false;
      rf.textContent = "Refresh now";
    }
  });

  draw();
}