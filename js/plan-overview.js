// Treatment Plan section: the patient's master plan, tracked against their appointments (List and Calendar views).
import { db, auth } from "./firebase-config.js";
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMasterPlan, saveMasterPlan, listPlanHistory, PLAN_STATUS, CONCERN_STATUS, patternText, monthLabel, cleanLine, cleanEvent,
  matchServices, sharesWord, newId, LINE_STATUS, lineOff,
} from "./master-plan-api.js";
import { getPlanSettings, serviceSetup, getPlanWorkflow, cleanWorkflow, phaseOf } from "./plan-api.js";
import { visitsFrom, trackPlan, thisMonth, dateKeyOf, dayLabel, addMonths, monthDiff } from "./plan-track.js";
import { serviceKey } from "./inventory-api.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { showSoapPanel } from "./soap-panel.js";
import { openPlanDocument } from "./plan-doc.js";
import { callApi } from "./appointments.js";
import { freqHtml, mountFreq } from "./plan-frequency.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTH_RE = /^\d{4}-\d{2}$/;
const PATTERN_LABEL = { course: "A course", maintenance: "Ongoing (maintenance)", once: "Once", unknown: "Not set" };
const ACTIVE = ["active", "maintenance"];
const OPEN_STATES = ["planned", "due", "overdue"];   // sessions that can be moved
const VIEW_KEY = "po-view";                           // List or Calendar, remembered on this computer
const LONG_DOWNTIME = 7;                              // days: also warn in the month before an event
const BOOKING_STATUSES = ["accepted", "in_progress"]; // booking reminders only once the patient has agreed
const REC_LABEL = { tx: "Treatment record", cons: "Consent record", rx: "Prescription", summary: "Consultation notes" };
const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON_PLAN = SVG('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 14l2 2 4-4"/>');
const ADD_CONCERN_BTN = '<button type="button" class="pv-addcon" data-po="add-treatment">+ Add a treatment</button>';
const ICON_SPARK = SVG('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>');

function openDlg(html) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg po-dlg";
  dlg.innerHTML = `<form class="lh-form" novalidate>${html}</form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

// Change one session's override inside a plan copy (empty values are removed)
function setOv(plan, ck, lid, n, patch) {
  const c = plan.concerns.find((x) => x.id === ck);
  const l = c && c.lines.find((x) => x.id === lid);
  if (!l) return;
  l.overrides = l.overrides || {};
  const o = { ...(l.overrides[n] || {}), ...patch };
  Object.keys(o).forEach((k) => { if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k]; });
  if (Object.keys(o).length) l.overrides[n] = o; else delete l.overrides[n];
}

// "12 Oct" this year, "12 Oct 2025" other years
function shortDay(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || "");
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString("en-AU", +m[1] === new Date().getFullYear()
    ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

function slotText(lt, s) {
  const base = `Session ${s.n}${lt.total ? ` of ${lt.total}` : ""}`;
  switch (s.state) {
    case "done": return `${base} · done${s.date ? ` ${dayLabel(s.date)}` : ""}${s.manual ? " (marked by hand)" : ""}`;
    case "booked": return `${base} · booked ${dayLabel(s.date)}`;
    case "skipped": return `${base} · skipped`;
    case "overdue": return `${base} · overdue since ${monthLabel(s.month)}`;
    case "due": return `${base} · due this month`;
    case "planned": return `${base} · planned ${monthLabel(s.month)}`;
    case "waiting": return `${base} · waiting (later in the plan)`;   // slotText, before default
    default: return `${base} · not scheduled yet`;
  }
}

function chipLabel(s) {
  const today = dateKeyOf(new Date());
  switch (s.state) {
    case "done": return `✓ ${s.date ? shortDay(s.date) : "Done"}`;
    case "booked": return s.date === today ? "Today" : `Booked ${shortDay(s.date)}`;
    case "due": return "Due this month";
    case "overdue": return `Overdue · ${monthLabel(s.month)}`;
    case "planned": return monthLabel(s.month);
    case "skipped": return "Skipped";
    case "waiting": return "Waiting";                                  // chipLabel, before default
    default: return "Choose a month";
  }
}

function nextText(lt) {
  if (lt.off) return [LINE_STATUS[lt.off], lt.done ? `${lt.done} done` : ""].filter(Boolean).join(" · ");
  const extra = lt.extra ? ` · ${lt.extra} more visit${lt.extra === 1 ? "" : "s"} than planned` : "";
  if (lt.complete) return `Complete · ${lt.done} of ${lt.total} done${extra}`;
  const prog = lt.total ? `${lt.done} of ${lt.total} done` : lt.done ? `${lt.done} done` : "";
  const s = lt.next;
  if (!s) return prog || "No visits yet";
  const what = {
    booked: `booked ${dayLabel(s.date)}`, due: "due this month", overdue: `overdue since ${monthLabel(s.month)}`,
    planned: `next ${monthLabel(s.month)}`, unscheduled: "next not scheduled", waiting: "waiting",   // nextText map
  }[s.state] || "";
  return [prog, what].filter(Boolean).join(" · ");
}

// The price for one treatment from its concern's quote ("Dermal filler 1ml - $650" → "$650")
function priceOf(c, l) {
  const own = String(l.quote || "").match(/\$\s?[\d,]+(?:\.\d{2})?/);   // the treatment's own quote wins
  if (own) return own[0].replace(/\s/g, "");
  const lines = String(c.quote || "").split(/\n+/).filter((q) => /\$\s?\d/.test(q));
  if (!lines.length) return "";
  const hit = lines.find((q) => sharesWord(q, l.treatment)) || (c.lines.length === 1 ? lines[0] : "");
  const m = hit && hit.match(/\$\s?[\d,]+(?:\.\d{2})?/);
  return m ? m[0].replace(/\s/g, "") : "";
}

// Area and quote are kept on the concern. A treatment's own area and quote are added to them (never twice);
// a quote line that already starts with this treatment's name is replaced.
function addToConcern(pc, treatment, area, quote) {
  if (area) {
    const have = String(pc.area || "").split(/\s*,\s*/).filter(Boolean);
    area.split(/\s*,\s*/).filter(Boolean).forEach((a) => {
      if (!have.some((h) => h.toLowerCase() === a.toLowerCase())) have.push(a);
    });
    pc.area = have.join(", ");
  }
  if (quote) {
    const line = sharesWord(quote, treatment) ? quote : `${treatment} - ${quote}`;
    const lines = String(pc.quote || "").split(/\n+/).filter(Boolean);
    const i = lines.findIndex((q) => q.toLowerCase().startsWith(`${treatment.toLowerCase()} - `));
    if (i > -1) lines[i] = line;
    else if (!lines.some((q) => q.toLowerCase() === line.toLowerCase())) lines.push(line);
    pc.quote = lines.join("\n");
  }
}

// ctx = { patient, staff, pre(), today(), consults(), recordsOn(dateKey), latestConsult(), applyLatest(), onReminder() }
export function createPlanOverview(el, ctx) {
  const { patient, staff } = ctx;
  const st = {
    master: null, settings: { concerns: [], services: [] }, loaded: false, error: "", busy: false, autoFor: -1,
    filter: "",   // List view: show one concern's treatments ("" = all)
    wf: cleanWorkflow({}),
    view: (() => { try { return localStorage.getItem(VIEW_KEY) === "cal" ? "cal" : "list"; } catch { return "list"; } })(),
    calStart: addMonths(thisMonth(), -1),
  };
  const con = (k) => st.settings.concerns.find((c) => c.name === k) || { label: k, colour: "#888780" };
  const chip = (k) => `<span class="ps-chip" style="--c:${esc(con(k).colour)}">${esc(con(k).label)}</span>`;
  const attrs = (c, l, n) => `data-c="${esc(c.id)}"${l ? ` data-l="${esc(l.id)}"` : ""}${n ? ` data-n="${n}"` : ""}`;
  const sectionHint = () => {
    const card = el.closest(".tp-card");
    return card ? card.querySelector(".tp-count") : null;
  };
  const phase = (c) => phaseOf(st.wf, c.priority);
  const isWaiting = (c) => !phase(c).tracked;
  // A treatment follows its concern's priority unless it has its own
  const linePhase = (c, l) => phaseOf(st.wf, (l && l.priority) || c.priority);
  const lineWaiting = (c, l) => !linePhase(c, l).tracked;
  const liveLines = (c) => c.lines.filter((l) => !lineOff(l));
  // Every treatment still going ahead is complete (true too when they've all been declined)
  const allDone = (c, t) => c.lines.length > 0 && liveLines(c).every((l) => t.lines.get(l.id).complete);
  const phaseRank = (c, l) => st.wf.phases.findIndex((p) => p.id === linePhase(c, l).id);
  // Within a concern: by priority, declined treatments last
  const orderedLines = (c) => c.lines.slice().sort((a, b) =>
    (lineOff(a) ? 99 : phaseRank(c, a)) - (lineOff(b) ? 99 : phaseRank(c, b)));
  // The concern's next waiting treatment (lowest priority first, then the order listed), or null
  const nextWaitingLine = (c, not) => c.lines.filter((y) => y.id !== not.id && !lineOff(y) && lineWaiting(c, y))
    .sort((a, b) => phaseRank(c, a) - phaseRank(c, b))[0] || null;
  const firstTracked = () => st.wf.phases.find((p) => p.tracked) || st.wf.phases[0];

  // Every treatment in the plan, in the order to book them: going ahead first, by priority, then the order staff set
  function planItems(track) {
    const out = [];
    st.master.concerns.forEach((c, ci) => c.lines.forEach((l, li) => out.push({
      c, l, ci, li, ph: linePhase(c, l), going: ACTIVE.includes(c.status) && !lineOff(l),
      lt: track ? track.get(c.id).lines.get(l.id) : null,
    })));
    const pr = (x) => st.wf.phases.findIndex((p) => p.id === x.ph.id);
    return out.sort((a, b) => (a.going ? 0 : 1) - (b.going ? 0 : 1) || pr(a) - pr(b)
      || (a.l.rank ? 0 : 1) - (b.l.rank ? 0 : 1) || (a.l.rank || 0) - (b.l.rank || 0) || a.ci - b.ci || a.li - b.li);
  }
  const lineIn = (p, cid, lid) => {
    const pc = p.concerns.find((y) => y.id === cid);
    return (pc && pc.lines.find((y) => y.id === lid)) || null;
  };
  // A treatment leaving a waiting priority starts this month (or next), and months planned while it waited are dropped
  const wakeStart = () => (st.wf.promoteStart === "next" ? addMonths(thisMonth(), 1) : thisMonth());
  function wakeLine(pl, start) {
    if (!pl.startMonth || pl.startMonth < start) pl.startMonth = start;
    Object.keys(pl.overrides || {}).forEach((n) => {
      delete pl.overrides[n].month;
      if (!Object.keys(pl.overrides[n]).length) delete pl.overrides[n];
    });
  }
  const byPhase = () => st.wf.phases.map((ph) => ({ ph, list: st.master.concerns.filter((c) => phase(c).id === ph.id) }));

  async function load() {
    try {
      const [m, s, wf] = await Promise.all([
        getMasterPlan(patient.id),
        getPlanSettings().catch(() => ({ concerns: [], services: [] })),
        getPlanWorkflow().catch(() => cleanWorkflow({})),
      ]);
      Object.assign(st, { master: m, settings: s, wf, loaded: true, error: "" });
      if (ctx.onPlan) ctx.onPlan(m, s);   // the patient page marks which consultation plans are in it
      if (m) refreshProgress();
    } catch (err) {
      console.warn("Master plan failed:", err);
      st.error = err && err.code === "permission-denied"
        ? "The master plan isn't accessible. Check the treatment_plans Firestore rules."
        : "Couldn't load the master plan.";
    }
    draw();
  }

  // Reporting's summary for this patient is worked out again in the background (at most every 20 seconds)
  let lastRefresh = 0;
  function refreshProgress() {
    if (Date.now() - lastRefresh < 20000) return;
    lastRefresh = Date.now();
    callApi({ action: "plan", op: "refreshProgress", patientId: patient.id })
      .catch((err) => console.warn("Plan progress not refreshed:", err));
  }
  
  function compute() {
    const m = st.master;
    const consultDay = new Map((ctx.consults() || []).filter((r) => r.date).map((r) => [r.id, dateKeyOf(r.date)]));
    const fallback = (c) => consultDay.get(c.sourceRecordId) || (m.createdAt ? dateKeyOf(m.createdAt) : "");
    return trackPlan(m, {
      visits: visitsFrom(ctx.pre(), ctx.today()),
      services: st.settings.services,
      waiting: lineWaiting,
      fromOf: (c, l) => (l && l.countFrom) || fallback(c),
    });
  }

  /* ---------- Plan status that keeps itself up to date ---------- */

  // In progress once a planned treatment is done or booked; Completed when every concern is resolved or not pursued
  function autoStatus(track) {
    const m = st.master;
    if (m.status === "closed") return m.status;
    const live = m.concerns.filter((c) => ACTIVE.includes(c.status));
    if (m.concerns.length && (!live.length || (!st.wf.waitingKeepsOpen && !live.some((c) => !isWaiting(c))))) return "completed";
    if (["proposed", "sent", "accepted"].includes(m.status)) {
      const started = m.concerns.some((c) => ACTIVE.includes(c.status) && c.lines.some((l) =>
        track.get(c.id).lines.get(l.id).slots.some((s) => s.state === "done" || s.state === "booked")));
      if (started) return "in_progress";
    }
    return m.status;
  }

  // Saved once per change (quietly: staff without access to change plans simply see the worked-out status)
  async function saveAutoStatus(eff) {
    const m = st.master;
    if (!m || eff === m.status || st.autoFor === m.version || st.busy) return;
    st.autoFor = m.version;
    try {
      await saveMasterPlan(patient, { status: eff, concerns: m.concerns, events: m.events }, {
        action: "Status updated automatically", summary: `${PLAN_STATUS[m.status]} → ${PLAN_STATUS[eff]}`, expectedVersion: m.version,
      }, staff);
      await load();
    } catch (err) {
      console.warn("Automatic plan status not saved:", err);
    }
  }

  /* ---------- Downtime and clashes with patient events ---------- */

  // The longest downtime among the services that count for this treatment
  function downtimeOf(c, l) {
    const names = l.services.length ? l.services : matchServices(l.treatment, c.key, st.settings.services);
    let best = { days: 0, note: "" };
    names.forEach((n) => {
      const r = serviceSetup(st.settings.services, n);
      if (r && r.downtimeDays > best.days) best = { days: r.downtimeDays, note: r.downtimeNote };
    });
    return best;
  }

  // Sessions with downtime in an "avoid downtime" event's month (or the month before, for longer downtime)
  function clashList(track) {
    const m = st.master;
    const evs = m.events.filter((e) => e.avoidDowntime && MONTH_RE.test(e.month));
    const out = [];
    if (!evs.length) return out;
    m.concerns.forEach((c) => {
      if (!ACTIVE.includes(c.status)) return;
      c.lines.forEach((l) => {
        const dt = downtimeOf(c, l);
        if (!dt.days) return;
        const lt = track.get(c.id).lines.get(l.id);
        lt.slots.forEach((s) => {
          if (![...OPEN_STATES, "booked"].includes(s.state) || !s.month) return;
          const e = evs.find((x) => s.month === x.month || (s.month === addMonths(x.month, -1) && dt.days >= LONG_DOWNTIME));
          if (!e) return;
          const early = addMonths(e.month, dt.days >= LONG_DOWNTIME ? -2 : -1);
          const to = early >= thisMonth() ? early : addMonths(e.month, 1);
          out.push({ c, l, s, e, dt, to, lt, key: `${c.id}|${l.id}|${s.n}` });
        });
      });
    });
    return out;
  }

  // Waiting concerns that could move up: booked early, or every tracked concern is finished
  function promoteList(track) {
    if (st.wf.promote === "off") return [];
    const live = st.master.concerns.filter((c) => ACTIVE.includes(c.status));
    const waiting = live.filter(isWaiting);
    if (!waiting.length) return [];
    const out = waiting
      .filter((c) => c.lines.some((l) => track.get(c.id).lines.get(l.id).slots.some((s) => s.state === "booked")))
      .map((c) => ({ c, promote: "early", rank: 0.5 }));
    const trackedOpen = live.some((c) => !isWaiting(c) && c.status === "active" && !allDone(c, track.get(c.id)));
    if (!trackedOpen && !out.length) {
      const order = st.wf.phases.map((p) => p.id);
      const next = waiting.slice().sort((a, b) => order.indexOf(phase(a).id) - order.indexOf(phase(b).id))[0];
      out.push({ c: next, promote: "ready", rank: 3.5 });
    }
    return out;
  }

  function needsList(track, clashes, booking) {
    const m = st.master;
    const out = clashes.map((x) => ({ ...x, clash: true, rank: -1 }));
    if (m.status === "closed") return out;
    out.push(...promoteList(track));
    if (m.status === "completed") return out.sort((a, b) => a.rank - b.rank);
    const clashed = new Set(clashes.map((x) => x.key));
    const rank = { overdue: 0, due: 1, unscheduled: 2 };
    m.concerns.forEach((c) => {
      if (!ACTIVE.includes(c.status)) return;
      const t = track.get(c.id);
      if (booking) {
        c.lines.forEach((l) => {
          const lt = t.lines.get(l.id);
          const s = lt.next;
          if (s && s.state in rank && !clashed.has(`${c.id}|${l.id}|${s.n}`)) out.push({ c, l, lt, s, rank: rank[s.state] });
        });
      }
      if (c.status === "active" && allDone(c, t)) out.push({ c, complete: true, declined: !liveLines(c).length, rank: 3 });
    });
    return out.sort((a, b) => a.rank - b.rank);
  }

  /* ---------- Drawing: shared ---------- */

  function emptyHtml() {
    const latest = ctx.latestConsult();
    return `<div class="mp-empty">
      <span class="mp-empty-ic">${ICON_PLAN}</span>
      <div class="mp-empty-main">
        <strong>No master plan yet</strong>
        <p>One plan per patient, organised by concern and tracked visit by visit.</p>
        <ol class="mp-empty-steps">
          <li><b>1</b>Consultation plan</li><li><b>2</b>Review and apply</li><li><b>3</b>Track every visit</li>
        </ol>
      </div>
      <div class="mp-empty-acts">
        ${latest
          ? `<button type="button" class="mp-empty-btn" data-po="apply-latest">${ICON_SPARK}<span>Create from the latest consultation</span></button>`
          : '<small class="mp-empty-none">No consultation with a treatment plan yet.</small>'}
        <button type="button" class="mp-empty-alt" data-po="add-concern">Start a plan without a consultation</button>
      </div>
    </div>`;
  }

  // Sessions done out of those planned (courses only; concerns still waiting don't count yet)
  function progressOf(track) {
    let done = 0;
    let total = 0;
    st.master.concerns.forEach((c) => {
      if (!ACTIVE.includes(c.status)) return;
      c.lines.forEach((l) => {
        if (lineOff(l) || lineWaiting(c, l)) return;
        const lt = track.get(c.id).lines.get(l.id);
        if (lt && lt.total) { total += lt.total; done += Math.min(lt.done, lt.total); }
      });
    });
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function barHtml(m, eff, track) {
    const latest = ctx.latestConsult();
    const newer = latest && !m.sources.includes(latest.id);
    const lines = m.concerns.reduce((n, c) => n + c.lines.length, 0);
    const when = m.updatedAt ? m.updatedAt.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "";
    const pg = progressOf(track);
    return `<div class="pv-bar is-v2">
      <div class="pv-bar-top">
        <span class="pv-bar-ic">${ICON_PLAN}</span>
        <div class="pv-bar-title">
          <div><strong>Master plan</strong><span class="pv-status is-${esc(eff)}">${esc(PLAN_STATUS[eff])}</span></div>
          <span class="pv-sub">${m.concerns.length} concern${m.concerns.length === 1 ? "" : "s"} · ${lines} treatment${lines === 1 ? "" : "s"} · v${m.version}${
            when ? `, ${esc(when)}${m.updatedBy ? ` by ${esc(m.updatedBy)}` : ""}` : ""}</span>
        </div>
        <span class="pv-spacer"></span>
        <div class="pv-bar-acts">
          ${newer ? '<button type="button" class="lh-btn" data-po="apply-latest">Update from the latest consultation</button>' : ""}
          <button type="button" class="lh-btn" data-po="doc">Patient copy</button>
          <div class="fe-seg po-viewseg">${[["list", "List"], ["cal", "Calendar"]].map(([v, l]) =>
            `<label class="fe-seg-btn"><input type="radio" name="po-view" value="${v}" data-po-view${st.view === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
          ${["proposed", "sent"].includes(eff) ? '<button type="button" class="lh-btn is-primary" data-po="accept">Patient accepted</button>' : ""}
          <button type="button" class="lh-btn is-quiet pv-dots" data-po="plan-menu" aria-label="Plan options" title="Plan options">⋯</button>
        </div>
      </div>
      ${pg.total ? `<div class="pv-prog${pg.done >= pg.total ? " is-done" : ""}" role="progressbar" aria-label="Planned sessions done"
          aria-valuemin="0" aria-valuemax="${pg.total}" aria-valuenow="${pg.done}">
        <div class="pv-prog-track"><i style="width:${pg.pct}%"></i></div>
        <span><b>${pg.done}</b> of ${pg.total} planned session${pg.total === 1 ? "" : "s"} done · ${pg.pct}%</span>
      </div>` : ""}
    </div>`;
  }

  // Today's appointment, and which planned treatments it covers
  function todayHtml(track) {
    const appts = ctx.today() || [];
    if (!appts.length) return "";
    const tk = dateKeyOf(new Date());
    const hits = [];
    st.master.concerns.forEach((c) => c.lines.forEach((l) => {
      const lt = track.get(c.id).lines.get(l.id);
      const s = lt.slots.find((x) => x.date === tk);
      if (s) hits.push({ c, l, lt, s });
    }));
    const when = appts.map((a) => [a.time, a.staff].filter(Boolean).join(" with ")).join(", ");
    const booked = [...new Set(appts.flatMap((a) => a.services || []))];
    return `<div class="pv-today">
      <div class="pv-today-head"><strong>Today</strong><span class="pv-sub">${esc(when)}</span></div>
      ${hits.length ? `<div class="pv-today-list">${hits.map((h) => `
        <button type="button" class="pv-today-item" data-po="slot" ${attrs(h.c, h.l, h.s.n)}>${chip(h.c.key)}
          <strong>${esc(h.l.treatment)}</strong><small>${esc(h.lt.total ? `session ${h.s.n} of ${h.lt.total}` : `session ${h.s.n}`)}</small></button>`).join("")}</div>`
        : `<p class="pv-sub">Nothing booked today is part of this plan${booked.length ? ` (booked: ${esc(booked.join(", "))})` : ""}.</p>`}
    </div>`;
  }

  function needRowHtml(x) {
    if (x.promote) {
      return `<div class="po-need is-promote">${chip(x.c.key)}
        <div class="po-need-main"><strong>${x.promote === "early" ? "Booked early" : "Ready to move up"}</strong>
          <small>${x.promote === "early"
            ? `A visit is booked for this concern, but it's in ${esc(phase(x.c).name)}.`
            : `Every tracked concern is done, in maintenance or not being pursued. This one is next (${esc(phase(x.c).name)}).`}</small></div>
        <div class="po-need-acts"><button type="button" class="lh-btn is-primary" data-po="promote" ${attrs(x.c)}>Move to ${esc(firstTracked().name)}</button></div>
      </div>`;
    }
    if (x.clash) {
      return `<div class="po-need is-clash">${chip(x.c.key)}
        <div class="po-need-main"><strong>${esc(x.l.treatment)} is too close to ${esc(x.e.name)}</strong>
          <small>${esc(slotText(x.lt, x.s))} · ${x.dt.days} day${x.dt.days === 1 ? "" : "s"} of downtime${
            x.dt.note ? ` (${esc(x.dt.note)})` : ""} · ${esc(x.e.name)} is in ${esc(monthLabel(x.e.month))}</small></div>
        <div class="po-need-acts">${x.s.state === "booked"
          ? `<button type="button" class="lh-btn is-primary" data-po="ask-rebook" ${attrs(x.c, x.l, x.s.n)} data-ev="${esc(x.e.id)}">Ask reception to rebook</button>`
          : `<button type="button" class="lh-btn is-primary" data-po="clash-move" ${attrs(x.c, x.l, x.s.n)} data-to="${esc(x.to)}">Move to ${esc(monthLabel(x.to))}</button>`}
          <button type="button" class="lh-btn" data-po="slot" ${attrs(x.c, x.l, x.s.n)}>More</button></div>
      </div>`;
    }
    if (x.complete && x.declined) {
      return `<div class="po-need is-complete">${chip(x.c.key)}
        <div class="po-need-main"><strong>No treatments left to do</strong>
          <small>Every treatment here was marked not interested or no longer relevant.</small></div>
        <div class="po-need-acts">
          <button type="button" class="lh-btn" data-po="set-concern" data-v="not_pursuing" ${attrs(x.c)}>Not pursuing</button></div>
      </div>`;
    }
    if (x.complete) {
      return `<div class="po-need is-complete">${chip(x.c.key)}
        <div class="po-need-main"><strong>Every treatment is done</strong>
          <small>Move this concern to maintenance, or mark it resolved.</small></div>
        <div class="po-need-acts">
          <button type="button" class="lh-btn" data-po="set-concern" data-v="maintenance" ${attrs(x.c)}>Maintenance</button>
          <button type="button" class="lh-btn" data-po="set-concern" data-v="resolved" ${attrs(x.c)}>Resolved</button></div>
      </div>`;
    }
    return `<div class="po-need is-${x.s.state}">${chip(x.c.key)}
      <div class="po-need-main"><strong>${esc(x.l.treatment)}</strong>
        <small>${esc(slotText(x.lt, x.s))}${x.s.asked ? ` · asked reception ${esc(dayLabel(String(x.s.asked.at || "").slice(0, 10)))}${
          x.s.asked.by ? ` (${esc(x.s.asked.by)})` : ""}` : ""}</small></div>
      <div class="po-need-acts">
        <button type="button" class="lh-btn is-primary" data-po="ask" ${attrs(x.c, x.l, x.s.n)}>${x.s.asked ? "Ask again" : "Ask reception to book"}</button>
        <button type="button" class="lh-btn" data-po="slot" ${attrs(x.c, x.l, x.s.n)}>More</button></div>
    </div>`;
  }

  // Booking reminders are one line that opens; it opens by itself when something is overdue or clashes
  function needsHtml(list, booking, eff) {
    const quiet = !booking && ["proposed", "sent"].includes(eff)
      ? '<p class="pv-quiet">Waiting for the patient to agree. Booking reminders appear once the plan is accepted.</p>' : "";
    if (!list.length) return quiet;
    const count = (f) => list.filter(f).length;
    const clash = count((x) => x.clash);
    const book = count((x) => !x.clash && !x.complete && !x.promote);
    const fin = count((x) => x.complete);
    const up = count((x) => x.promote);
    const parts = [
      clash && `${clash} too close to a patient event`,
      book && `${book} treatment${book === 1 ? "" : "s"} need${book === 1 ? "s" : ""} booking`,
      fin && `${fin} concern${fin === 1 ? "" : "s"} finished`,
      up && `${up} ready to move up`,
    ].filter(Boolean);
    const open = list.some((x) => x.clash || x.promote || (x.s && x.s.state === "overdue"));
    return `${quiet}<details class="pv-needs"${open ? " open" : ""}>
      <summary><span class="pv-needs-dot"></span>${esc(parts.join(" · "))}</summary>
      <div class="pv-needs-list">${list.map(needRowHtml).join("")}</div>
    </details>`;
  }

  /* ---------- Drawing: List ---------- */

  function chipHtml(c, l, lt, s, clash) {
    const t = `${slotText(lt, s)}${clash ? " · too close to a patient event" : ""}`;
    return `<button type="button" class="pv-chip is-${s.state}${s.manual ? " is-manual" : ""}${clash ? " is-clash" : ""}" data-po="slot" ${
      attrs(c, l, s.n)} title="${esc(t)}" aria-label="${esc(t)}">${clash ? "⚠ " : ""}${esc(chipLabel(s))}</button>`;
  }

  function slotChipsHtml(c, l, lt, clashKeys) {
    const done = lt.slots.filter((s) => s.state === "done");
    const firstWait = lt.slots.find((s) => s.state === "waiting");
    const shown = firstWait ? lt.slots.filter((s) => s.state !== "waiting").concat(firstWait)
      : lt.total ? lt.slots : [...done.slice(-3), ...lt.slots.filter((s) => s.state !== "done")];
    const hidden = firstWait ? 0 : lt.slots.length - shown.length;
    return `${hidden ? `<span class="pv-more">+${hidden} earlier</span>` : ""}${
      shown.map((s) => chipHtml(c, l, lt, s, clashKeys.has(`${c.id}|${l.id}|${s.n}`))).join("")}${
      lt.complete ? '<span class="pv-chip is-complete">Course complete</span>' : ""}`;
  }

  // One treatment: its place in the plan, its concern as a tag, its sessions and its menu
  function txRowHtml(x, clashKeys) {
    const { c, l, lt } = x;
    const k = con(c.key);
    const price = priceOf(c, l);
    let sub;
    if (lineOff(l)) {
      const when = l.statusAt ? shortDay(dateKeyOf(new Date(l.statusAt))) : "";
      sub = [LINE_STATUS[l.status], [when, l.statusBy].filter(Boolean).join(", "), l.statusNote].filter(Boolean).join(" · ");
    } else if (!x.going) {
      sub = `${k.label}: ${CONCERN_STATUS[c.status]}`;
    } else {
      sub = [l.area || c.area, patternText(l) || "Schedule not set", lt.total ? `${lt.done} of ${lt.total} done` : ""].filter(Boolean).join(" · ");
    }
    return `<div class="pt-row${x.going ? "" : " is-off"}" style="--c:${esc(k.colour)}">
      <span class="pt-rank">${x.going ? x.n : "–"}</span>
      <div class="pt-main"><strong>${esc(l.treatment)}</strong>
        <div class="pt-meta"><button type="button" class="pt-tag" data-po="concern-menu" ${attrs(c)} title="Concern details">${esc(k.label)}</button>
          <span>${esc(sub)}</span></div></div>
      <div class="pv-chips">${slotChipsHtml(c, l, lt, clashKeys)}</div>
      <div class="pv-price">${price ? esc(price) : ""}</div>
      <button type="button" class="po-mini pv-dots" data-po="line-menu" ${attrs(c, l)} aria-label="${esc(l.treatment)} options" title="Options">⋯</button>
    </div>`;
  }

  function eventsHtml(m) {
    const list = m.events.slice().sort((a, b) => a.month.localeCompare(b.month));
    return `<div class="pv-events"><strong>Patient events</strong>
      ${list.length ? list.map((e) => `<span class="pv-ev${e.avoidDowntime ? " is-avoid" : ""}" title="${
        e.avoidDowntime ? "Avoid downtime before it" : ""}">${esc(e.name)} · ${esc(monthLabel(e.month))}
        <button type="button" class="po-x" data-po="remove-event" data-e="${esc(e.id)}" aria-label="Remove ${esc(e.name)}">×</button></span>`).join("")
        : '<span class="pv-sub">Weddings, holidays or other dates to plan around</span>'}
      <span class="pv-spacer"></span>
      <button type="button" class="po-mini" data-po="add-event">+ Add</button>
    </div>`;
  }

  /* ---------- Drawing: Calendar ---------- */

  function stepHtml(c, l, lt, s, clash, active) {
    const movable = active && OPEN_STATES.includes(s.state);
    const t = `${slotText(lt, s)}${clash ? " · too close to a patient event" : ""}${movable ? " · drag to move" : ""}`;
    return `<button type="button" class="pcal-step is-${s.state}${s.manual ? " is-manual" : ""}${movable ? " is-movable" : ""}${
      clash ? " is-clash" : ""}" data-po="slot" ${attrs(c, l, s.n)} data-row="${esc(`${c.id}|${l.id}`)}"
      title="${esc(t)}" aria-label="${esc(t)}">${clash ? "⚠ " : ""}${s.n}</button>`;
  }

  function calendarHtml(track, clashKeys) {
    const m = st.master;
    const cur = thisMonth();
    const months = Array.from({ length: 12 }, (_, i) => addMonths(st.calStart, i));
    const head = (k, i) => {
      const [y, mo] = k.split("-").map(Number);
      const name = new Date(y, mo - 1, 1).toLocaleDateString("en-AU", { month: "short" });
      return `<div class="pcal-mh${k === cur ? " is-now" : ""}">${name}${i === 0 || mo === 1 ? `<small>${y}</small>` : ""}</div>`;
    };
    const cells = (row, fill) => months.map((k) =>
      `<div class="pcal-cell${k === cur ? " is-now" : ""}" data-month="${k}"${row ? ` data-row="${esc(row)}"` : ""}>${fill(k)}</div>`).join("");

    let rows = "";
    const many = st.wf.phases.length > 1;
    byPhase().forEach(({ ph, list }) => {
      if (!list.length) return;
      if (many) rows += `<div class="pcal-phase" style="--p:${esc(ph.colour)}">${esc(ph.name)}${ph.tracked ? "" : " · waiting"}</div>`;
      list.forEach((c) => {
        const k = con(c.key);
        const active = ACTIVE.includes(c.status);
        const t = track.get(c.id);
        rows += `<div class="pcal-concern${active ? "" : " is-off"}" style="--c:${esc(k.colour)}">${esc(k.label)}${
          active ? "" : ` <small>${esc(CONCERN_STATUS[c.status])}</small>`}</div>`;
        c.lines.forEach((l) => {
          const lt = t.lines.get(l.id);
          const row = `${c.id}|${l.id}`;
          const unsched = lt.slots.filter((s) => !s.month && !["skipped", "waiting"].includes(s.state));
          rows += `<div class="pcal-label${active ? "" : " is-off"}" style="--c:${esc(k.colour)}">
            <strong>${esc(l.treatment)}</strong><small>${esc(nextText(lt))}</small>
            ${unsched.map((s) => `<button type="button" class="pcal-uns" data-po="slot" ${attrs(c, l, s.n)}>Session ${s.n}: choose a month</button>`).join("")}
          </div>${cells(active ? row : "", (mo) => lt.slots.filter((s) => s.month === mo)
            .map((s) => stepHtml(c, l, lt, s, clashKeys.has(`${row}|${s.n}`), active)).join(""))}`;
        });
      });
    });

    return `<section class="pcal-wrap">
      <div class="pcal-nav">
        <button type="button" class="lh-btn is-quiet" data-po="cal-prev" aria-label="Earlier months">‹ Earlier</button>
        <strong>${esc(monthLabel(months[0]))} to ${esc(monthLabel(months[11]))}</strong>
        <button type="button" class="lh-btn is-quiet" data-po="cal-today">Today</button>
        <button type="button" class="lh-btn is-quiet" data-po="cal-next" aria-label="Later months">Later ›</button>
      </div>
      <div class="pcal-scroll"><div class="pcal">
        <div class="pcal-label pcal-corner"></div>${months.map(head).join("")}
        <div class="pcal-label pcal-evl"><strong>Patient events</strong>
          <button type="button" class="po-mini" data-po="add-event">+ Add</button></div>${cells("", (k) => m.events.filter((e) => e.month === k)
          .map((e) => `<span class="pcal-ev${e.avoidDowntime ? " is-avoid" : ""}" title="${esc(e.name)}${
            e.avoidDowntime ? " · avoid downtime before it" : ""}">${esc(e.name)}</span>`).join(""))}
        ${rows}
      </div></div>
      <p class="pcal-legend">
        <span><i class="pcal-key is-done"></i>Done</span><span><i class="pcal-key is-booked"></i>Booked</span>
        <span><i class="pcal-key is-due"></i>Due</span><span><i class="pcal-key is-overdue"></i>Overdue</span>
        <span><i class="pcal-key is-planned"></i>Planned</span>
        <span class="pcal-hint">Drag a planned session to another month, or tap it for more.</span>
      </p>
    </section>`;
  }

  // List view: every treatment in booking order, under its priority. The concern is a tag on each one.
  function phasesHtml(track, clashKeys) {
    const m = st.master;
    const all = planItems(track);
    const going = all.filter((x) => x.going);
    going.forEach((x, i) => { x.n = i + 1; });
    if (st.filter && !m.concerns.some((c) => c.id === st.filter)) st.filter = "";
    const show = (x) => !st.filter || x.c.id === st.filter;
    const many = st.wf.phases.length > 1;

    const filters = m.concerns.length > 1 ? `<div class="pt-filter"><span>Concerns</span>
      <button type="button" class="pt-fchip${st.filter ? "" : " is-on"}" data-po="filter" data-c="">All · ${all.length}</button>
      ${m.concerns.map((c) => `<button type="button" class="pt-fchip${st.filter === c.id ? " is-on" : ""}" data-po="filter" data-c="${esc(c.id)}"
        style="--c:${esc(con(c.key).colour)}">${esc(con(c.key).label)} · ${c.lines.length}</button>`).join("")}</div>` : "";

    const sections = st.wf.phases.map((ph) => {
      const list = going.filter((x) => x.ph.id === ph.id && show(x));
      if (!list.length) return "";
      return `<section class="pt-sec${ph.tracked ? "" : " is-waiting"}" style="--p:${esc(ph.colour)}">
        ${many ? `<p class="pt-sec-head"><strong>${esc(ph.name)}</strong>${ph.note ? `<small>${esc(ph.note)}</small>` : ""}${
          ph.tracked ? "" : "<small>· no reminders yet</small>"}</p>` : ""}
        <div class="pt-list">${list.map((x) => txRowHtml(x, clashKeys)).join("")}</div>
      </section>`;
    }).join("");

    const off = all.filter((x) => !x.going && show(x));
    const offHtml = off.length ? `<section class="pt-sec is-off">
      <p class="pt-sec-head"><strong>Not going ahead</strong><small>${off.length} treatment${off.length === 1 ? "" : "s"} · kept for the record</small></p>
      <div class="pt-list">${off.map((x) => txRowHtml(x, clashKeys)).join("")}</div></section>` : "";

    const unmatched = m.concerns.map((c) => {
      const n = track.get(c.id).unmatched;
      return n && (!st.filter || st.filter === c.id)
        ? `<p class="po-unmatched">${n} visit${n === 1 ? "" : "s"} for ${esc(con(c.key).label)} couldn't be matched to a treatment. Edit a treatment to link its services.</p>` : "";
    }).join("");

    return `${filters}${sections || (offHtml ? "" : '<p class="tb-none">No treatments yet. Open a concern to add one.</p>')}${offHtml}${unmatched}`;
  }

  function draw() {
    if (!el.isConnected) return;
    const hint = sectionHint();
    if (st.error) { el.innerHTML = `<p class="empty-note error">${esc(st.error)}</p>`; if (hint) hint.textContent = "—"; return; }
    if (!st.loaded) { el.innerHTML = '<div class="skeleton sm"></div>'; return; }
    const m = st.master;
    if (!m) { el.innerHTML = emptyHtml(); if (hint) hint.textContent = "No master plan"; return; }
    const track = compute();
    const eff = autoStatus(track);
    const booking = BOOKING_STATUSES.includes(eff) || (st.wf.remindFrom === "proposed" && ["proposed", "sent"].includes(eff));
    const clashes = clashList(track);
    const clashKeys = new Set(clashes.map((x) => x.key));
    const list = needsList(track, clashes, booking);
    if (hint) hint.textContent = `${PLAN_STATUS[eff]} · ${m.concerns.length} concern${m.concerns.length === 1 ? "" : "s"}`;
    el.innerHTML = `<div class="po pv">
      ${barHtml(m, eff, track)}
      ${todayHtml(track)}
      ${needsHtml(list, booking, eff)}
      ${st.view === "cal"
        ? `${calendarHtml(track, clashKeys)}${ADD_CONCERN_BTN}`
        : `${phasesHtml(track, clashKeys)}${ADD_CONCERN_BTN}${eventsHtml(m)}`}
    </div>`;
    if (eff !== m.status) setTimeout(() => saveAutoStatus(eff), 0);
  }
  /* ---------- Saving: every change is a new version ---------- */

  async function commit(mutate, action, summary) {
    const m = st.master;
    const next = JSON.parse(JSON.stringify({ status: m.status, concerns: m.concerns, events: m.events }));
    mutate(next);
    st.busy = true;
    el.classList.add("is-busy");
    try {
      await saveMasterPlan(patient, next, { action, summary, expectedVersion: m.version }, staff);
      await load();
      return true;
    } catch (err) {
      console.error("Plan change failed:", err);
      showToast(err && err.code === "permission-denied"
        ? "You don't have access to change treatment plans (needs clinical access)."
        : err && err.message && !err.code ? err.message : "Couldn't save. Try again.");
      if (err && /Someone else/.test(err.message || "")) await load(); else draw(); // put the screen back as saved
      return false;
    } finally {
      st.busy = false;
      el.classList.remove("is-busy");
    }
  }

  const findLine = (ck, lid) => {
    const c = st.master && st.master.concerns.find((x) => x.id === ck);
    return [c || null, c && lid ? c.lines.find((x) => x.id === lid) || null : null];
  };
  const slotOf = (c, l, n) => {
    const lt = compute().get(c.id).lines.get(l.id);
    return [lt, lt && lt.slots.find((x) => x.n === n)];
  };
  // Later sessions of the same treatment that are still to come (these follow a move)
  const laterOpen = (lt, n) => lt.slots.filter((x) => x.n > n && OPEN_STATES.includes(x.state) && x.month);

  function setPlanStatus(v) {
    if (!PLAN_STATUS[v] || v === st.master.status) return Promise.resolve(false);
    return commit((p) => { p.status = v; }, "Changed the plan status", PLAN_STATUS[v]);
  }

  function setConcernStatus(c, v) {
    if (!c || !CONCERN_STATUS[v] || v === c.status) return Promise.resolve(false);
    return commit((p) => { const x = p.concerns.find((y) => y.id === c.id); if (x) x.status = v; },
      "Changed a concern's status", `${con(c.key).label}: ${CONCERN_STATUS[v]}`);
  }

  /* ---------- Menus ---------- */

  // The patient's copy: emailing a Proposed plan moves it to "Sent to patient"
  function openDoc() {
    openPlanDocument({
      patient, master: st.master, track: compute(), labelOf: con, staff, workflow: st.wf,
      onSent: async (kind) => {
        if (kind === "email" && st.master.status === "proposed") await setPlanStatus("sent");
      },
    });
  }

  function planMenu() {
    const m = st.master;
    const eff = autoStatus(compute());
    const latest = ctx.latestConsult();
    const newer = latest && !m.sources.includes(latest.id);
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>Plan options</h3>
        <p>The status updates itself: In progress once a planned treatment is done or booked, Completed when every concern is resolved or not pursued.</p></div>
      <div class="lh-field"><span class="lh-label">Status</span>
        <div class="pv-radios">${Object.entries(PLAN_STATUS).map(([v, l]) => `
          <label class="fe-check"><input type="radio" name="status" value="${v}"${v === eff ? " checked" : ""} /> ${l}</label>`).join("")}</div></div>
      <div class="po-slot-btns">
        <button type="button" class="lh-btn" data-act="doc">Patient copy</button>
        <button type="button" class="lh-btn" data-act="history">History</button>
        ${newer ? '<button type="button" class="lh-btn" data-act="latest">Update from the latest consultation</button>' : ""}
      </div>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>`);
    const form = dlg.querySelector("form");
    form.addEventListener("submit", (e) => e.preventDefault());
    form.addEventListener("change", async (e) => {
      if (e.target.name !== "status" || st.busy) return;
      if (await setPlanStatus(e.target.value)) dlg.close();
    });
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "doc") { dlg.close(); openDoc(); return; }
      if (b.dataset.act === "history") { dlg.close(); showHistory(); }
      else if (b.dataset.act === "latest") { dlg.close(); ctx.applyLatest(); }
      else if (b.dataset.act === "close") dlg.close();
    });
  }

  function concernMenu(c) {
    const k = con(c.key);
    const ph = phase(c);
    const same = st.master.concerns.filter((x) => phase(x).id === ph.id);
    const at = same.findIndex((x) => x.id === c.id);
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${esc(k.label)}</h3><p>${esc(c.description || "")}</p></div>
      ${st.wf.phases.length > 1 ? `<div class="lh-field"><span class="lh-label">Priority</span>
        <div class="pv-radios">${st.wf.phases.map((p) => `
          <label class="fe-check"><input type="radio" name="phase" value="${esc(p.id)}"${p.id === ph.id ? " checked" : ""} /> ${esc(p.name)}${
            p.tracked ? "" : ' <small class="muted">(waiting)</small>'}</label>`).join("")}</div></div>` : ""}
      ${same.length > 1 ? `<div class="po-slot-btns">
        <button type="button" class="lh-btn" data-act="up"${at === 0 ? " disabled" : ""}>↑ Move up</button>
        <button type="button" class="lh-btn" data-act="down"${at === same.length - 1 ? " disabled" : ""}>↓ Move down</button>
        <small class="fe-note">The order within ${esc(ph.name)}</small></div>` : ""}
      <div class="lh-field"><span class="lh-label">Status</span>
        <div class="pv-radios">${Object.entries(CONCERN_STATUS).map(([v, l]) => `
          <label class="fe-check"><input type="radio" name="cstatus" value="${v}"${v === c.status ? " checked" : ""} /> ${l}</label>`).join("")}</div>
        <small class="fe-note">Resolved and Not pursuing hide it from Needs action. When every concern is one of these, the plan is Completed.</small></div>
      ${c.comments ? `<div class="lh-field"><span class="lh-label">Clinician's notes</span><p class="pv-notes-full">${esc(c.comments).replace(/\n/g, "<br>")}</p></div>` : ""}
      <div class="po-slot-btns"><button type="button" class="lh-btn" data-act="add">+ Add a treatment</button>
        <button type="button" class="lh-btn" data-act="details">Edit area, quote and notes</button></div>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>`);
    const form = dlg.querySelector("form");
    form.addEventListener("submit", (e) => e.preventDefault());
    form.addEventListener("change", async (e) => {
      if (st.busy) return;
      if (e.target.name === "phase") { dlg.close(); setConcernPhase(c, e.target.value); return; }
      if (e.target.name === "cstatus" && await setConcernStatus(c, e.target.value)) dlg.close();
    });
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      if (b.dataset.act === "add") { dlg.close(); editLine(c, null); }
      else if (b.dataset.act === "details") { dlg.close(); editConcern(c); }
      else if (b.dataset.act === "up" || b.dataset.act === "down") { dlg.close(); moveConcern(c, b.dataset.act === "up" ? -1 : 1); }
      else if (b.dataset.act === "close") dlg.close();
    });
  }

  // A concern's own wording: description, area, quote and the clinician's notes
  function editConcern(c) {
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${esc(con(c.key).label)}</h3><p>The area, quote and notes shown for this concern.</p></div>
      <label class="lh-field"><span class="lh-label">Description</span>
        <input name="description" maxlength="600" value="${esc(c.description)}" /></label>
      <label class="lh-field"><span class="lh-label">Area</span>
        <input name="area" maxlength="200" value="${esc(c.area)}" placeholder="e.g. Full face, Neck" /></label>
      <label class="lh-field"><span class="lh-label">Quote</span>
        <textarea name="quote" rows="4" maxlength="1500" placeholder="One line per treatment, e.g. Rejuran - $899">${esc(c.quote)}</textarea>
        <small class="fe-note">One line per treatment. The price beside each treatment comes from the line that names it.</small></label>
      <label class="lh-field"><span class="lh-label">Clinician's notes</span>
        <textarea name="comments" rows="3" maxlength="1500">${esc(c.comments)}</textarea></label>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button>
      </div>`);
    const form = dlg.querySelector("form");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const vals = { description: f.description.value.trim(), area: f.area.value.trim(),
        quote: f.quote.value.trim(), comments: f.comments.value.trim() };
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      const ok = await commit((p) => {
        const x = p.concerns.find((y) => y.id === c.id);
        if (x) Object.assign(x, vals);
      }, "Edited a concern's details", con(c.key).label);
      if (ok) dlg.close(); else btn.disabled = false;
    });
  }

  // Up or down within its priority (the plan's order is the order of master.concerns)
  function moveConcern(c, dir) {
    const same = st.master.concerns.filter((x) => phase(x).id === phase(c).id);
    const other = same[same.findIndex((x) => x.id === c.id) + dir];
    if (!other) return Promise.resolve(false);
    return commit((p) => {
      const a = p.concerns.findIndex((x) => x.id === c.id);
      const b = p.concerns.findIndex((x) => x.id === other.id);
      [p.concerns[a], p.concerns[b]] = [p.concerns[b], p.concerns[a]];
    }, dir < 0 ? "Moved a concern up" : "Moved a concern down", `${con(c.key).label}, within ${phase(c).name}`);
  }

  // Start month for treatments that haven't started, when a concern moves up (null = cancelled)
  function askStart(c, to) {
    return new Promise((resolve) => {
      let val = null;
      const dlg = openDlg(`
        <div class="lh-dialog-head"><h3>Move ${esc(con(c.key).label)} to ${esc(to.name)}</h3>
          <p>When should its treatments start? Sessions already done or booked aren't changed.</p></div>
        <label class="lh-field"><span class="lh-label">Start month</span><input type="month" name="start" value="${thisMonth()}" /></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Move</button></div>`);
      const form = dlg.querySelector("form");
      dlg.addEventListener("close", () => resolve(val));
      dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = form.elements.start.value.trim();
        if (!MONTH_RE.test(v)) {
          const er = dlg.querySelector(".lh-error");
          er.textContent = "Choose a month (e.g. 2026-11).";
          er.hidden = false;
          return;
        }
        val = v;
        dlg.close();
      });
    });
  }

  async function setConcernPhase(c, id) {
    const to = st.wf.phases.find((p) => p.id === id);
    const from = phase(c);
    if (!to || to.id === from.id || st.busy) return false;
    const promoting = to.tracked && !from.tracked;
    const t = compute().get(c.id);
    const fresh = new Set(c.lines.filter((l) => !t.lines.get(l.id).slots
      .some((s) => s.state === "done" || s.state === "booked")).map((l) => l.id));
    let start = "";
    if (promoting && fresh.size) {
      start = st.wf.promoteStart === "this" ? thisMonth()
        : st.wf.promoteStart === "next" ? addMonths(thisMonth(), 1)
        : await askStart(c, to);
      if (start === null) return false;
    }
    return commit((p) => {
      const x = p.concerns.find((y) => y.id === c.id);
      if (!x) return;
      x.priority = to.id;
      if (start) {
        x.lines.forEach((l) => {
          if (!fresh.has(l.id)) return;
          l.startMonth = start;
          Object.keys(l.overrides || {}).forEach((n) => {
            delete l.overrides[n].month;                                   // old planned months would be overdue
            if (!Object.keys(l.overrides[n]).length) delete l.overrides[n];
          });
        });
      }
      if (promoting && p.status === "completed") p.status = "in_progress";
      p.concerns.splice(p.concerns.indexOf(x), 1);                         // last in its new priority
      p.concerns.push(x);
    }, promoting ? "Moved a concern up" : "Changed a concern's priority",
    `${con(c.key).label}: ${from.name} → ${to.name}${start ? `, starting ${monthLabel(start)}` : ""}`);
  }

    /* ---------- One treatment's menu: order, priority and the patient's decision ---------- */

  function lineMenu(c, l) {
    const off = lineOff(l);
    const live = ACTIVE.includes(c.status);
    const ph = linePhase(c, l);
    const same = planItems(null).filter((x) => x.going && x.ph.id === ph.id);
    const at = same.findIndex((x) => x.c.id === c.id && x.l.id === l.id);
    const btn = (act, label, extra = "") => `<button type="button" class="lh-btn" data-act="${act}"${extra}>${label}</button>`;
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${esc(l.treatment)}</h3>
        <p>${chip(c.key)} ${esc(off ? LINE_STATUS[l.status] : live ? ph.name : CONCERN_STATUS[c.status])}</p></div>
      <div class="pt-menu">
        ${!off && live ? `<p class="pt-menu-h">Order and priority</p>
          ${same.length > 1 ? `${btn("up", "↑ Move up", at <= 0 ? " disabled" : "")}${btn("down", "↓ Move down", at === same.length - 1 ? " disabled" : "")}` : ""}
          ${st.wf.phases.filter((p) => p.id !== ph.id).map((p) =>
            btn("to", `Move to ${esc(p.name)}${p.tracked ? "" : " (waiting)"}`, ` data-v="${esc(p.id)}"`)).join("")}
          <p class="pt-menu-h">The patient's decision</p>
          ${btn("off", "Not interested", ' data-v="not_interested"')}${btn("off", "No longer relevant", ' data-v="not_relevant"')}` : ""}
        ${off ? btn("revive", "Make active again") : ""}
        ${!live ? btn("reopen", `Make ${esc(con(c.key).label)} active again`) : ""}
        <p class="pt-menu-h">Details</p>
        ${btn("edit", "Edit treatment")}${btn("concern", "Concern details")}
      </div>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>`);
    const form = dlg.querySelector("form");
    form.addEventListener("submit", (e) => e.preventDefault());
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled || st.busy) return;
      const act = b.dataset.act;
      dlg.close();
      if (act === "up" || act === "down") moveLine(c, l, act === "up" ? -1 : 1);
      else if (act === "to") moveLineTo(c, l, b.dataset.v);
      else if (act === "off") declineLine(c, l, b.dataset.v);
      else if (act === "revive") reviveLine(c, l);
      else if (act === "reopen") setConcernStatus(c, "active");
      else if (act === "edit") editLine(c, l);
      else if (act === "concern") concernMenu(c);
    });
  }

  // Up or down within its priority: every treatment in that priority gets its place saved
  function moveLine(c, l, dir) {
    const ph = linePhase(c, l);
    const same = planItems(null).filter((x) => x.going && x.ph.id === ph.id);
    const i = same.findIndex((x) => x.c.id === c.id && x.l.id === l.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= same.length) return Promise.resolve(false);
    [same[i], same[j]] = [same[j], same[i]];
    return commit((p) => same.forEach((x, n) => {
      const pl = lineIn(p, x.c.id, x.l.id);
      if (pl) pl.rank = n + 1;
    }), dir < 0 ? "Moved a treatment up" : "Moved a treatment down", `${l.treatment}, within ${ph.name}`);
  }

  // To another priority (it goes to the end of that priority)
  function moveLineTo(c, l, id) {
    const to = st.wf.phases.find((p) => p.id === id);
    const from = linePhase(c, l);
    if (!to || to.id === from.id) return Promise.resolve(false);
    const wake = to.tracked && !from.tracked;
    const start = wakeStart();
    return commit((p) => {
      const pc = p.concerns.find((y) => y.id === c.id);
      const pl = pc && pc.lines.find((y) => y.id === l.id);
      if (!pl) return;
      pl.priority = to.id === phaseOf(st.wf, pc.priority).id ? "" : to.id;   // "" = the concern's own priority
      pl.rank = 0;
      if (wake) wakeLine(pl, start);
      if (wake && p.status === "completed") p.status = "in_progress";
    }, "Moved a treatment", `${l.treatment}: ${from.name} → ${to.name}${wake ? `, starting ${monthLabel(start)}` : ""}`);
  }

  // Not interested / No longer relevant: its reminders stop, and the concern's next waiting treatment takes its place
  function declineLine(c, l, status) {
    if (!LINE_STATUS[status] || status === "active") return;
    const label = LINE_STATUS[status].toLowerCase();
    const up = !lineWaiting(c, l) && st.wf.promote !== "off" ? nextWaitingLine(c, l) : null;
    const upTo = up ? linePhase(c, l) : null;
    const start = wakeStart();
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>Mark ${esc(l.treatment)} as ${esc(label)}?</h3>
        <p>Its reminders stop. Sessions already done stay on the plan.</p></div>
      ${up ? `<p class="pt-preview">↑ ${esc(up.treatment)} moves up to ${esc(upTo.name)}, starting ${esc(monthLabel(start))}</p>` : ""}
      <label class="lh-field"><span class="lh-label">Reason (optional)</span>
        <input name="why" maxlength="200" placeholder="e.g. Worried about downtime" /></label>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Mark ${esc(label)}</button>
      </div>`);
    const form = dlg.querySelector("form");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const why = form.elements.why.value.trim();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      const ok = await commit((p) => {
        const pc = p.concerns.find((y) => y.id === c.id);
        const pl = pc && pc.lines.find((y) => y.id === l.id);
        if (!pl) return;
        Object.assign(pl, { status, statusAt: new Date().toISOString(), statusBy: (staff && staff.name) || "", statusNote: why });
        const pu = up ? pc.lines.find((y) => y.id === up.id) : null;
        if (pu) {
          pu.priority = upTo.id === phaseOf(st.wf, pc.priority).id ? "" : upTo.id;
          pu.rank = pl.rank || 0;   // it takes the declined treatment's place
          wakeLine(pu, start);
        }
      }, `Marked a treatment ${label}`,
      `${con(c.key).label}: ${l.treatment}${why ? ` (${why})` : ""}${up ? `; ${up.treatment} moved up to ${upTo.name}` : ""}`);
      if (!ok) { btn.disabled = false; return; }
      dlg.close();
      if (up) showToast(`${up.treatment} is now ${upTo.name}, starting ${monthLabel(start)}`);
    });
    form.elements.why.focus();
  }

  function reviveLine(c, l) {
    return commit((p) => {
      const pl = lineIn(p, c.id, l.id);
      if (pl) Object.assign(pl, { status: "active", statusAt: new Date().toISOString(), statusBy: (staff && staff.name) || "", statusNote: "" });
    }, "Made a treatment active again", `${con(c.key).label}: ${l.treatment}`);
  }

  function showQuote(c) {
    const quoteHtml = esc(c.quote).split("\n").map((q) => q.replace(/\$[\d,]+(?:\.\d{2})?/g, (x) => `<strong>${x}</strong>`)).join("<br>");
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>Quote</h3><p>${chip(c.key)}</p></div>
      <p class="pv-quote">${quoteHtml}</p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>`);
    dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
  }

  /* ---------- Moving a session (later ones keep their spacing) ---------- */

  async function moveSlot(c, l, n, toMonth, keepGaps = true) {
    const [lt, s] = slotOf(c, l, n);
    if (!s || !MONTH_RE.test(toMonth) || !OPEN_STATES.concat("unscheduled").includes(s.state)) return false;
    if (toMonth === s.month && !s.moved) return false;
    const shift = s.month ? monthDiff(s.month, toMonth) : 0;
    const later = laterOpen(lt, n);
    const ov = l.overrides || {};
    return commit((p) => {
      setOv(p, c.id, l.id, String(n), { month: toMonth });
      later.forEach((x) => {
        const own = (ov[String(x.n)] || {}).month;
        // Sessions without their own month already follow the moved one (by the interval). Pinned ones shift with it.
        if (keepGaps) { if (own && shift) setOv(p, c.id, l.id, String(x.n), { month: addMonths(own, shift) }); }
        else setOv(p, c.id, l.id, String(x.n), { month: x.month });
      });
    }, `Moved a session to ${monthLabel(toMonth)}`,
    `${l.treatment}, session ${n}${later.length ? (keepGaps ? `, and the ${later.length} after it` : ", later sessions kept in place") : ""}`);
  }

  /* ---------- Ask reception to book (a reminder on the patient) ---------- */

  async function askReception(c, l, n, rebookNote = "") {
    const [lt, s] = slotOf(c, l, n);
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!s) return;
    if (!uid) { showToast("Your session has ended. Log in again."); return; }
    const what = `${l.treatment} (${con(c.key).label}${lt.total ? `, session ${s.n} of ${lt.total}` : ""})`;
    const when = s.state === "overdue" ? "as soon as possible" : s.month ? `in ${monthLabel(s.month)}` : "when it suits the patient";
    const text = rebookNote
      ? `Please rebook ${patient.name}: ${what}, booked ${dayLabel(s.date)}. ${rebookNote}`
      : `Please book ${patient.name}: ${what}, ${when}.`;
    const today = dateKeyOf(new Date());
    const due = !rebookNote && s.month && `${s.month}-01` > today ? `${s.month}-01` : today;
    st.busy = true;
    try {
      await addDoc(collection(db, "staff-task-list"), {
        patientId: patient.pttId || patient.id, patientName: patient.name || "", taskText: text.slice(0, 500),
        dueDate: due, status: "Open", createdAt: new Date().toISOString(),
        createdBy: (staff && staff.name) || "", createdByUid: uid,
      });
    } catch (err) {
      console.error("Reminder failed:", err);
      showToast("Couldn't add the reminder. Try again.");
      st.busy = false;
      return;
    }
    st.busy = false;
    await commit((p) => setOv(p, c.id, l.id, String(n), { asked: { at: new Date().toISOString(), by: (staff && staff.name) || "" } }),
      rebookNote ? "Asked reception to rebook" : "Asked reception to book", text);
    showToast("Reminder added for reception");
    if (ctx.onReminder) ctx.onReminder();
  }

  /* ---------- One session ---------- */

  function recordsHtml(dateKey) {
    const recs = dateKey && ctx.recordsOn ? ctx.recordsOn(dateKey) : [];
    if (!recs.length) return "";
    return `<div class="lh-field"><span class="lh-label">Records from ${esc(dayLabel(dateKey))}</span>
      <div class="pv-recs">${recs.map((r) => {
        const text = `${REC_LABEL[r.kind] || "Record"}${r.label ? ` · ${r.label}` : ""}`;
        if (r.summaryId) return `<button type="button" class="pv-rec" data-sum="${esc(r.summaryId)}">${esc(text)}</button>`;
        if (!r.href) return `<span class="pv-rec is-none">${esc(text)}</span>`;
        const ext = /^https?:\/\//i.test(r.href) ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a class="pv-rec" href="${esc(r.href)}"${ext}>${esc(text)}</a>`;
      }).join("")}</div></div>`;
  }

  function slotDialog(c, l, n) {
    const [lt, s] = slotOf(c, l, n);
    if (!s) return;
    const today = dateKeyOf(new Date());
    const waiting = s.state === "waiting";
    const open = !["done", "booked", "skipped", "waiting"].includes(s.state);
    const later = laterOpen(lt, n);
    const dt = downtimeOf(c, l);
    const price = priceOf(c, l);
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${esc(l.treatment)}</h3><p>${chip(c.key)} ${esc(slotText(lt, s))}${
        dt.days ? ` · ${dt.days} day${dt.days === 1 ? "" : "s"} of downtime` : ""}${price ? ` · quoted ${esc(price)}` : ""}</p></div>
      ${s.state === "done" && !s.manual ? `<p class="inv-hint">Matched to the appointment on ${esc(dayLabel(s.date))}, so it's counted automatically.</p>` : ""}
      ${s.state === "done" ? recordsHtml(s.date) : ""}
      ${s.state === "booked" ? `<p class="inv-hint">There's an appointment booked for ${esc(dayLabel(s.date))}. It becomes Done after the visit.</p>` : ""}
      ${waiting ? `<p class="inv-hint">${esc(l.priority ? l.treatment : con(c.key).label)} is in ${esc(linePhase(c, l).name)}, so its sessions aren't scheduled yet.</p>
        <div class="po-slot-btns"><button type="button" class="lh-btn is-primary" data-act="promote">Move to ${esc(firstTracked().name)}</button></div>` : ""}
      ${open ? `
        <div class="po-slot-row">
          <label class="lh-field"><span class="lh-label">Done on</span><input type="date" name="date" value="${today}" max="${today}" /></label>
          <button type="button" class="lh-btn is-primary" data-act="done">Mark done</button></div>
        <small class="fe-note">Only if the visit isn't in the appointment history (e.g. done elsewhere, or not synced yet).</small>
        <div class="po-slot-row">
          <label class="lh-field"><span class="lh-label">Move to</span><input type="month" name="month" value="${esc(s.month || thisMonth())}" placeholder="2026-11" /></label>
          <button type="button" class="lh-btn" data-act="move">Move</button></div>
        ${later.length ? `<label class="fe-check"><input type="checkbox" name="keep" checked /> Move the ${later.length} later session${
          later.length === 1 ? "" : "s"} with it (keeps the gaps)</label>` : ""}
        <div class="po-slot-btns">
          <button type="button" class="lh-btn" data-act="ask">${s.asked ? "Ask reception again" : "Ask reception to book"}</button>
          <button type="button" class="lh-btn is-quiet" data-act="skip">Skip this session</button>
          ${s.moved ? '<button type="button" class="lh-btn is-quiet" data-act="unmove">Back to the planned month</button>' : ""}
        </div>` : ""}
      ${s.manual || s.state === "skipped" ? `<div class="po-slot-btns"><button type="button" class="lh-btn" data-act="undo">${
        s.manual ? "Undo Mark done" : "Undo skip"}</button></div>` : ""}
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const fail = (t) => { err.textContent = t; err.hidden = false; };
    form.addEventListener("submit", (e) => e.preventDefault());
    form.addEventListener("click", async (e) => {
      const sum = e.target.closest("[data-sum]");
      if (sum) { dlg.close(); showSoapPanel(sum.dataset.sum); return; }
      if (e.target.closest("a.pv-rec")) { dlg.close(); return; }
      const b = e.target.closest("[data-act]");
      if (!b || st.busy) return;
      const act = b.dataset.act;
      if (act === "close") { dlg.close(); return; }
      if (act === "promote") {
        dlg.close();
        if (!l.priority) { setConcernPhase(c, firstTracked().id); return; }
        // The treatment has its own priority: only it moves up
        commit((p) => {
          const pc = p.concerns.find((y) => y.id === c.id);
          const pl = pc && pc.lines.find((y) => y.id === l.id);
          if (pl) pl.priority = firstTracked().id;
        }, "Moved a treatment up", `${l.treatment}: ${linePhase(c, l).name} → ${firstTracked().name}`);
        return;
      }
      if (act === "ask") { dlg.close(); askReception(c, l, n); return; }
      if (act === "move") {
        const mo = form.elements.month.value.trim();
        if (!MONTH_RE.test(mo)) { fail("Choose a month (e.g. 2026-11)."); return; }
        if (mo === s.month) { dlg.close(); return; }
        b.disabled = true;
        if (await moveSlot(c, l, n, mo, !form.elements.keep || form.elements.keep.checked)) dlg.close();
        else b.disabled = false;
        return;
      }
      const label = `${l.treatment}, ${slotText(lt, s).split(" · ")[0].toLowerCase()}`;
      let patch;
      let action;
      if (act === "done") {
        const d = form.elements.date.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today) { fail("Choose the day it was done (today or earlier)."); return; }
        patch = { status: "done", date: d, month: undefined };
        action = "Marked a session done";
      } else if (act === "skip") {
        patch = { status: "skipped" };
        action = "Skipped a session";
      } else if (act === "unmove") {
        patch = { month: undefined };
        action = "Moved a session back";
      } else if (act === "undo") {
        patch = { status: undefined, date: undefined };
        action = s.manual ? "Undid Mark done" : "Undid a skip";
      } else return;
      b.disabled = true;
      if (await commit((p) => setOv(p, c.id, l.id, String(n), patch), action, label)) dlg.close();
      else b.disabled = false;
    });
  }

  /* ---------- Add / edit a treatment line ---------- */

  // c and l given: edit that treatment. l empty: add one (c empty: the concern is chosen in the window).
  function editLine(c, l, defaults = {}) {
    const m = st.master;
    const isNew = !l;
    const today = dateKeyOf(new Date());
    const x = l || { treatment: "", pattern: "course", sessions: 3, intervalWeeks: 4, startMonth: "", countFrom: "", services: [],
      overrides: {}, area: "", quote: "", ...defaults };
    const many = st.wf.phases.length > 1;
    const inPlan = m ? m.concerns : [];
    const others = st.settings.concerns.filter((k) => !k.hidden && !inPlan.some((y) => y.key === k.name));
    if (!c && !inPlan.length && !others.length) { showToast("The concern list didn't load. Reload the page and try again."); return; }
    // The concern box holds "id:<entry in this plan>" or "key:<a concern not in the plan yet>"
    const keyOf = (v) => (v.startsWith("id:") ? (inPlan.find((y) => y.id === v.slice(3)) || {}).key || "" : v.slice(4));
    const catOf = (key) => (st.settings.treatments || []).filter((t) => t.concern === key && !t.hidden);
    const defPhase = l ? linePhase(c, l).id : c ? phase(c).id : inPlan.length ? st.wf.addPhase : st.wf.newPlanPhase;
    const area0 = x.area || "";
    const quote0 = l ? (x.quote || priceOf(c, l)) : (x.quote || "");
    const tracked = !isNew && Object.keys(x.overrides || {}).length > 0;

    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${isNew ? "Add a treatment" : "Edit treatment"}</h3>
        <p>${isNew ? "Choose the concern it treats. A concern that isn't in the plan yet is added with it." : "Everything about this treatment."}</p></div>
      <div class="inv-two">
        <label class="lh-field"><span class="lh-label">Concern</span>
          <select class="fb-select" name="concern">${c ? "" : '<option value="">Choose a concern…</option>'}
            ${inPlan.length ? `<optgroup label="In this plan">${inPlan.map((y) =>
              `<option value="id:${esc(y.id)}"${c && y.id === c.id ? " selected" : ""}>${esc(con(y.key).label)}</option>`).join("")}</optgroup>` : ""}
            ${others.length ? `<optgroup label="Add a concern">${others.map((k) =>
              `<option value="key:${esc(k.name)}">${esc(k.label)}</option>`).join("")}</optgroup>` : ""}
          </select></label>
        ${many ? `<label class="lh-field"><span class="lh-label">Priority</span>
          <select class="fb-select" name="lpriority">${st.wf.phases.map((p) =>
            `<option value="${esc(p.id)}"${p.id === defPhase ? " selected" : ""}>${esc(p.name)}${p.tracked ? "" : " (waiting)"}</option>`).join("")}</select></label>` : ""}
      </div>
      <label class="lh-field" data-role="presetwrap" hidden><span class="lh-label">${isNew ? "Choose from the treatment list" : "Fill in from the treatment list"}</span>
        <select class="fb-select" name="preset"></select>
        <small class="fe-note">Fills in everything below. You can still change any of it.</small></label>
      <label class="lh-field"><span class="lh-label">Treatment</span>
        <input name="treatment" maxlength="300" value="${esc(x.treatment)}" placeholder="e.g. Skin Needling, full face" /></label>
      ${freqHtml(x)}
      <div class="inv-two">
        <label class="lh-field"><span class="lh-label">Area (optional)</span>
          <input name="area" maxlength="200" list="po-area-list" value="${esc(area0)}" placeholder="${esc((c && c.area) || "e.g. Full face")}" />
          <datalist id="po-area-list"></datalist></label>
        <label class="lh-field"><span class="lh-label">Quote (optional)</span>
          <input name="quote" maxlength="200" value="${esc(quote0)}" placeholder="e.g. $899 per session" /></label>
      </div>
      <div class="inv-two">
        <label class="lh-field"><span class="lh-label">Start month</span>
          <input name="start" type="month" value="${esc(x.startMonth)}" placeholder="2026-11" /></label>
        <label class="lh-field"><span class="lh-label">Count visits from (optional)</span>
          <input name="from" type="date" value="${esc(x.countFrom)}" />
          <small class="fe-note">Visits before this day don't count. Empty: from the consultation.</small></label>
      </div>
      <div class="lh-field"><span class="lh-label">Appointment services that count as this treatment</span>
        <input type="search" class="fe-input" data-role="svcfind" placeholder="Search services" aria-label="Search services" />
        <div class="po-svcs" data-role="svcs"></div>
        <small class="fe-note">None ticked: visits for this concern are matched by the treatment's name.</small></div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        ${isNew ? "" : '<button type="button" class="lh-btn is-quiet po-danger" data-act="remove">Remove</button>'}
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">${isNew ? "Add" : "Save"}</button>
      </div>`);
    const form = dlg.querySelector("form");
    const f = form.elements;
    const err = dlg.querySelector(".lh-error");
    const fail = (t) => { err.textContent = t; err.hidden = false; };
    const freq = mountFreq(dlg);
    const svcBox = dlg.querySelector('[data-role="svcs"]');
    const presetWrap = dlg.querySelector('[data-role="presetwrap"]');
    const find = dlg.querySelector('[data-role="svcfind"]');
    let firstSync = true;

    // The treatment list, services and area suggestions follow the chosen concern
    const sync = () => {
      const key = keyOf(f.concern.value);
      const cat = catOf(key);
      presetWrap.hidden = !cat.length;
      f.preset.innerHTML = `<option value="">${isNew ? "Type my own" : "Keep as it is"}</option>${
        cat.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${t.quote ? ` · ${esc(t.quote)}` : ""}</option>`).join("")}`;
      const ticked = new Map([...form.querySelectorAll('[name="svc"]:checked')].map((b) => [serviceKey(b.value), b.value]));
      if (firstSync) x.services.forEach((s) => ticked.set(serviceKey(s), s));
      firstSync = false;
      const cands = [...new Map([
        ...st.settings.services.filter((r) => r.concerns.includes(key)).map((r) => r.service),
        ...cat.flatMap((t) => t.services),
        ...ticked.values(),
      ].map((s) => [serviceKey(s), s])).values()].sort((a, b) => a.localeCompare(b, "en-AU"));
      find.hidden = !cands.length;
      svcBox.innerHTML = cands.length ? cands.map((s) => `<label class="fe-check" data-find="${esc(s.toLowerCase())}">
          <input type="checkbox" name="svc" value="${esc(s)}"${ticked.has(serviceKey(s)) ? " checked" : ""} /> ${esc(s)}</label>`).join("")
        : `<p class="tb-none">${key ? "No services are set up for this concern yet (Inventory → Treatment plans)." : "Choose a concern first."}</p>`;
      dlg.querySelector("#po-area-list").innerHTML = [...new Set(cat.flatMap((t) => t.areas))]
        .map((a) => `<option value="${esc(a)}"></option>`).join("");
    };
    sync();
    f.concern.addEventListener("change", sync);

    f.preset.addEventListener("change", () => {
      const t = catOf(keyOf(f.concern.value)).find((y) => y.id === f.preset.value);
      if (!t) return;
      f.treatment.value = t.name;
      freq.set(t);
      if (t.services.length) {
        const want = new Set(t.services.map(serviceKey));
        form.querySelectorAll('[name="svc"]').forEach((b) => {
          b.checked = want.has(serviceKey(b.value));
          b.closest("[data-find]").hidden = false;
        });
      }
      f.quote.value = t.quote;
      f.area.value = t.areas.length === 1 ? t.areas[0] : "";   // several areas: choose from the suggestions
    });
    find.addEventListener("input", () => {
      const q = find.value.trim().toLowerCase();
      svcBox.querySelectorAll("[data-find]").forEach((r) => {
        r.hidden = !!q && !r.dataset.find.includes(q) && !r.querySelector("input").checked;
      });
    });
    find.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());

    const rm = dlg.querySelector('[data-act="remove"]');
    if (rm) {
      rm.addEventListener("click", async () => {
        const lastOne = c.lines.length === 1;
        if (!(await confirmDialog({
          title: `Remove ${x.treatment}?`,
          message: `${tracked ? "Sessions marked by hand, skipped or moved for it are removed too. " : "It's taken out of the plan. "}${
            lastOne ? `It's the only treatment for ${con(c.key).label}, so that concern goes too. ` : ""}The plan's history keeps a copy.`,
          confirmLabel: "Remove", tone: "danger",
        }))) return;
        if (await commit((p) => {
          const pc = p.concerns.find((y) => y.id === c.id);
          if (!pc) return;
          pc.lines = pc.lines.filter((y) => y.id !== l.id);
          if (!pc.lines.length) p.concerns = p.concerns.filter((y) => y !== pc);
        }, "Removed a treatment", `${con(c.key).label}: ${x.treatment}`)) dlg.close();
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const v = f.concern.value;
      const key = keyOf(v);
      const treatment = f.treatment.value.trim();
      const start = f.start.value.trim();
      if (!key) { fail("Choose the concern it treats."); return; }
      if (!treatment) { fail("Enter the treatment."); return; }
      if (start && !MONTH_RE.test(start)) { fail("Enter the start month as e.g. 2026-11."); return; }
      if (f.pattern.value === "course" && !(parseInt(f.sessions.value, 10) >= 1)) { fail("Enter how many sessions."); return; }
      const target = v.startsWith("id:") ? inPlan.find((y) => y.id === v.slice(3)) || null : null;
      if (target && target !== c && target.lines.length >= 10) { fail("That concern already has 10 treatments."); return; }
      const prio = f.lpriority ? f.lpriority.value : defPhase;
      const to = phaseOf(st.wf, prio);
      const moved = !isNew && to.id !== linePhase(c, l).id;
      const wake = moved && to.tracked && lineWaiting(c, l);
      const area = f.area.value.trim();
      const quote = f.quote.value.trim();
      const fields = {
        treatment, ...freq.read(), area, quote, startMonth: start, countFrom: f.from.value,
        services: [...form.querySelectorAll('[name="svc"]:checked')].map((y) => y.value),
      };
      const newConcernId = inPlan.some((y) => y.id === key) ? `${key}#${newId()}` : key;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      const ok = await commitOrCreate((p) => {
        let pc = target ? p.concerns.find((y) => y.id === target.id) : null;
        if (!pc) {
          pc = { id: newConcernId, key, status: "active", priority: to.id, description: "", area: "", quote: "", comments: "",
            sourceRecordId: "", lines: [] };
          p.concerns.push(pc);
        }
        if (isNew && !ACTIVE.includes(pc.status)) pc.status = "active";
        const own = to.id === phaseOf(st.wf, pc.priority).id ? "" : to.id;   // "" = the concern's own priority
        if (isNew) {
          pc.lines.push(cleanLine({ ...fields, priority: own }));
          if (p.status === "completed") p.status = "in_progress";   // there's something to do again
        } else {
          const old = p.concerns.find((y) => y.id === c.id);
          const i = old ? old.lines.findIndex((y) => y.id === l.id) : -1;
          if (i === -1) return;
          const next = cleanLine({ ...old.lines[i], ...fields, priority: own, ...(moved ? { rank: 0 } : {}) });
          if (wake) wakeLine(next, wakeStart());
          if (old === pc) old.lines[i] = next;
          else {
            old.lines.splice(i, 1);
            pc.lines.push(next);
            if (!old.lines.length) p.concerns = p.concerns.filter((y) => y !== old);   // nothing left for that concern
          }
        }
        // The concern's own area and quote are kept in step until the patient copy reads them from the treatment
        addToConcern(pc, treatment, area !== area0 ? area : "", quote !== quote0 ? quote : "");
      }, isNew ? "Added a treatment" : target && c && target.id === c.id ? "Edited a treatment" : "Moved a treatment to another concern",
      `${con(key).label}: ${treatment}`);
      if (!ok) { btn.disabled = false; return; }
      dlg.close();
      if (isNew) showToast(m ? "Treatment added" : "Master plan created");
    });
    (c ? f.treatment : f.concern).focus();
  }  
    /* ---------- Add a concern by hand (no consultation needed) ---------- */

  // Saves a change to the plan, or creates the plan when there isn't one yet
  async function commitOrCreate(mutate, action, summary) {
    if (st.master) return commit(mutate, action, summary);
    const next = { status: "proposed", concerns: [], events: [] };
    mutate(next);
    st.busy = true;
    el.classList.add("is-busy");
    try {
      await saveMasterPlan(patient, next, { action: "Created by hand", summary, expectedVersion: 0 }, staff);
      await load();
      return true;
    } catch (err) {
      console.error("Create master plan failed:", err);
      showToast(err && err.code === "permission-denied"
        ? "You don't have access to change treatment plans (needs clinical access)."
        : err && err.message && !err.code ? err.message : "Couldn't save. Try again.");
      if (err && /Someone else/.test(err.message || "")) await load();
      return false;
    } finally {
      st.busy = false;
      el.classList.remove("is-busy");
    }
  }

  /* ---------- Patient events ---------- */

  function addEvent() {
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>Add a patient event</h3><p>A date to plan treatments around.</p></div>
      <label class="lh-field"><span class="lh-label">What</span><input name="name" maxlength="100" placeholder="e.g. Daughter's wedding" /></label>
      <label class="lh-field"><span class="lh-label">Month</span><input name="month" type="month" placeholder="2027-03" /></label>
      <label class="fe-check"><input type="checkbox" name="avoid" checked /> Avoid treatments with downtime just before it</label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Add</button>
      </div>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      const month = form.elements.month.value.trim();
      if (!name || !MONTH_RE.test(month)) { err.textContent = "Enter what it is and the month (e.g. 2027-03)."; err.hidden = false; return; }
      const ev = cleanEvent({ name, month, avoidDowntime: form.elements.avoid.checked, source: "staff" });
      if (await commit((p) => { p.events.push(ev); }, "Added a patient event", `${name} · ${monthLabel(month)}`)) dlg.close();
    });
    form.elements.name.focus();
  }

  async function removeEvent(id) {
    const ev = st.master.events.find((x) => x.id === id);
    if (!ev) return;
    if (!(await confirmDialog({ title: `Remove ${ev.name}?`, message: "It's taken off the plan.", confirmLabel: "Remove", tone: "warning" }))) return;
    commit((p) => { p.events = p.events.filter((x) => x.id !== id); }, "Removed a patient event", ev.name);
  }

  /* ---------- History ---------- */

  async function showHistory() {
    let rows;
    try { rows = await listPlanHistory(patient.id, 50); }
    catch (err) { console.error(err); showToast("Couldn't load the history."); return; }
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>Plan history</h3><p>Every change is a new version. The previous version is kept with each one.</p></div>
      <ul class="po-hist">${rows.map((h) => `
        <li><b>v${esc(h.version)}</b><span><strong>${esc(h.action || "Changed")}</strong>${h.summary ? `<small>${esc(h.summary)}</small>` : ""}</span>
          <small>${esc(h.at ? h.at.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "")}${
            h.by ? ` · ${esc(h.by)}` : ""}</small></li>`).join("") || '<li class="tb-none">No history yet.</li>'}</ul>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>`);
    dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
  }

  /* ---------- Calendar: drag a session to another month (mouse, pen or finger) ---------- */

  let drag = null;
  let swallowClick = false; // the click that follows a drag must not open the session

  el.addEventListener("pointerdown", (e) => {
    const step = e.target.closest(".pcal-step.is-movable");
    if (!step || st.busy || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag = { step, x: e.clientX, y: e.clientY, id: e.pointerId, on: false, target: null };
    try { step.setPointerCapture(e.pointerId); } catch { /* not essential */ }
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return; // a tap, not a drag (yet)
      drag.on = true;
      drag.step.classList.add("is-dragging");
      el.classList.add("pcal-dragging");
    }
    e.preventDefault();
    drag.step.style.transform = `translate(${e.clientX - drag.x}px, ${e.clientY - drag.y}px)`;
    // Look under the finger, not at the session being dragged
    drag.step.style.visibility = "hidden";
    const under = document.elementFromPoint(e.clientX, e.clientY);
    drag.step.style.visibility = "";
    const cell = under && under.closest(".pcal-cell[data-row]");
    const ok = cell && cell.dataset.row === drag.step.dataset.row ? cell : null;
    if (drag.target !== ok) {
      if (drag.target) drag.target.classList.remove("is-target");
      drag.target = ok;
      if (ok) ok.classList.add("is-target");
    }
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    el.classList.remove("pcal-dragging");
    if (!d.on) return; // a tap: the click opens the session
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 400);
    d.step.classList.remove("is-dragging");
    d.step.style.transform = "";
    if (d.target) d.target.classList.remove("is-target");
    if (e.type === "pointercancel" || !d.target) return;
    const [c, l] = findLine(d.step.dataset.c, d.step.dataset.l);
    if (c && l) moveSlot(c, l, Number(d.step.dataset.n), d.target.dataset.month, true);
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);

  /* ---------- Events ---------- */

  el.addEventListener("click", (e) => {
    if (swallowClick) { swallowClick = false; e.preventDefault(); return; }
    const b = e.target.closest("[data-po]");
    if (!b || st.busy) return;
    const d = b.dataset;
    if (d.po === "apply-latest") { ctx.applyLatest(); return; }
    if (d.po === "accept") { setPlanStatus("accepted"); return; }
    if (d.po === "plan-menu") { planMenu(); return; }
    if (d.po === "doc") { openDoc(); return; }
    if (d.po === "add-event") { addEvent(); return; }
    if (d.po === "add-treatment" || d.po === "add-concern") { editLine(null, null, { countFrom: dateKeyOf(new Date()) }); return; }
    if (d.po === "remove-event") { removeEvent(d.e); return; }
    if (d.po === "cal-prev") { st.calStart = addMonths(st.calStart, -3); draw(); return; }
    if (d.po === "cal-next") { st.calStart = addMonths(st.calStart, 3); draw(); return; }
    if (d.po === "cal-today") { st.calStart = addMonths(thisMonth(), -1); draw(); return; }
    if (d.po === "filter") { st.filter = d.c || ""; draw(); return; }
    const [c, l] = findLine(d.c, d.l);
    if (!c) return;
    if (d.po === "set-concern") setConcernStatus(c, d.v);
    else if (d.po === "promote") setConcernPhase(c, firstTracked().id);
    else if (d.po === "concern-menu") concernMenu(c);
    else if (d.po === "quote") showQuote(c);
    else if (d.po === "edit-line" && l) editLine(c, l);
    else if (d.po === "line-menu" && l) lineMenu(c, l);
    else if (d.po === "slot" && l) slotDialog(c, l, Number(d.n));
    else if (d.po === "ask" && l) askReception(c, l, Number(d.n));
    else if (d.po === "clash-move" && l) moveSlot(c, l, Number(d.n), d.to, true);
    else if (d.po === "ask-rebook" && l) {
      const ev = st.master.events.find((x) => x.id === d.ev);
      askReception(c, l, Number(d.n), ev ? `It's too close to ${ev.name} (${monthLabel(ev.month)}), so it needs a new date.` : "It needs a new date.");
    }
  });

  el.addEventListener("change", (e) => {
    const t = e.target;
    if (!t.matches("[data-po-view]")) return;
    st.view = t.value === "cal" ? "cal" : "list";
    try { localStorage.setItem(VIEW_KEY, st.view); } catch { /* not essential */ }
    draw();
  });

  draw();
  return { load, redraw: draw };
}