// Treatment Plan section: the patient's master plan, tracked against their appointments (List and Calendar views).
import { db, auth } from "./firebase-config.js";
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMasterPlan, saveMasterPlan, listPlanHistory, PLAN_STATUS, CONCERN_STATUS, patternText, monthLabel, cleanLine, cleanEvent,
  matchServices,
} from "./master-plan-api.js";
import { getPlanSettings, serviceSetup } from "./plan-api.js";
import { visitsFrom, trackPlan, thisMonth, dateKeyOf, dayLabel, addMonths, monthDiff } from "./plan-track.js";
import { serviceKey } from "./inventory-api.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTH_RE = /^\d{4}-\d{2}$/;
const PATTERN_LABEL = { course: "A course", maintenance: "Ongoing (maintenance)", once: "Once", unknown: "Not set" };
const ACTIVE = ["active", "maintenance"];
const OPEN_STATES = ["planned", "due", "overdue"];   // sessions that can be moved
const VIEW_KEY = "po-view";                           // List or Calendar, remembered on this computer
const LONG_DOWNTIME = 7;                              // days: also warn in the month before an event

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
  const c = plan.concerns.find((x) => x.key === ck);
  const l = c && c.lines.find((x) => x.id === lid);
  if (!l) return;
  l.overrides = l.overrides || {};
  const o = { ...(l.overrides[n] || {}), ...patch };
  Object.keys(o).forEach((k) => { if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k]; });
  if (Object.keys(o).length) l.overrides[n] = o; else delete l.overrides[n];
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
    default: return `${base} · not scheduled yet`;
  }
}

function nextText(lt) {
  const extra = lt.extra ? ` · ${lt.extra} more visit${lt.extra === 1 ? "" : "s"} than planned` : "";
  if (lt.complete) return `Complete · ${lt.done} of ${lt.total} done${extra}`;
  const prog = lt.total ? `${lt.done} of ${lt.total} done` : lt.done ? `${lt.done} done` : "";
  const s = lt.next;
  if (!s) return prog || "No visits yet";
  const what = {
    booked: `booked ${dayLabel(s.date)}`, due: "due this month", overdue: `overdue since ${monthLabel(s.month)}`,
    planned: `next ${monthLabel(s.month)}`, unscheduled: "next not scheduled",
  }[s.state] || "";
  return [prog, what].filter(Boolean).join(" · ");
}

// ctx = { patient, staff, pre(), today(), consults(), latestConsult(), applyLatest(), onReminder() }
export function createPlanOverview(el, ctx) {
  const { patient, staff } = ctx;
  const st = {
    master: null, settings: { concerns: [], services: [] }, loaded: false, error: "", busy: false,
    view: (() => { try { return localStorage.getItem(VIEW_KEY) === "cal" ? "cal" : "list"; } catch { return "list"; } })(),
    calStart: addMonths(thisMonth(), -1),
  };
  const con = (k) => st.settings.concerns.find((c) => c.name === k) || { label: k, colour: "#888780" };
  const chip = (k) => `<span class="ps-chip" style="--c:${esc(con(k).colour)}">${esc(con(k).label)}</span>`;
  const attrs = (c, l, n) => `data-c="${esc(c.key)}"${l ? ` data-l="${esc(l.id)}"` : ""}${n ? ` data-n="${n}"` : ""}`;

  async function load() {
    try {
      const [m, s] = await Promise.all([
        getMasterPlan(patient.id),
        getPlanSettings().catch(() => ({ concerns: [], services: [] })),
      ]);
      Object.assign(st, { master: m, settings: s, loaded: true, error: "" });
    } catch (err) {
      console.warn("Master plan failed:", err);
      st.error = err && err.code === "permission-denied"
        ? "The master plan isn't accessible. Check the treatment_plans Firestore rules."
        : "Couldn't load the master plan.";
    }
    draw();
  }

  function compute() {
    const m = st.master;
    const consultDay = new Map((ctx.consults() || []).filter((r) => r.date).map((r) => [r.id, dateKeyOf(r.date)]));
    const fallback = (c) => consultDay.get(c.sourceRecordId) || (m.createdAt ? dateKeyOf(m.createdAt) : "");
    return trackPlan(m, {
      visits: visitsFrom(ctx.pre(), ctx.today()),
      services: st.settings.services,
      fromOf: (c, l) => (l && l.countFrom) || fallback(c),
    });
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
        track.get(c.key).lines.get(l.id).slots.forEach((s) => {
          if (![...OPEN_STATES, "booked"].includes(s.state) || !s.month) return;
          const e = evs.find((x) => s.month === x.month || (s.month === addMonths(x.month, -1) && dt.days >= LONG_DOWNTIME));
          if (!e) return;
          const early = addMonths(e.month, dt.days >= LONG_DOWNTIME ? -2 : -1);
          const to = early >= thisMonth() ? early : addMonths(e.month, 1);
          out.push({ c, l, s, e, dt, to, key: `${c.key}|${l.id}|${s.n}`,
            lt: track.get(c.key).lines.get(l.id) });
        });
      });
    });
    return out;
  }

  function needsList(track, clashes) {
    const m = st.master;
    const out = clashes.map((x) => ({ ...x, clash: true, rank: -1 }));
    if (["completed", "closed"].includes(m.status)) return out;
    const clashed = new Set(clashes.map((x) => x.key));
    const rank = { overdue: 0, due: 1, unscheduled: 2 };
    m.concerns.forEach((c) => {
      if (!ACTIVE.includes(c.status)) return;
      const t = track.get(c.key);
      c.lines.forEach((l) => {
        const lt = t.lines.get(l.id);
        const s = lt.next;
        if (s && s.state in rank && !clashed.has(`${c.key}|${l.id}|${s.n}`)) out.push({ c, l, lt, s, rank: rank[s.state] });
      });
      if (c.status === "active" && c.lines.length && c.lines.every((l) => t.lines.get(l.id).complete)) {
        out.push({ c, complete: true, rank: 3 });
      }
    });
    return out.sort((a, b) => a.rank - b.rank);
  }

  /* ---------- Drawing: shared ---------- */

  function emptyHtml() {
    const latest = ctx.latestConsult();
    return `<div class="mp-bar is-empty">
      <div class="mp-bar-main"><strong>No master plan yet</strong>
        <small>One plan per patient, organised by concern and tracked visit by visit.</small></div>
      ${latest ? '<button type="button" class="btn-primary sm" data-po="apply-latest">Create from the latest consultation</button>'
        : '<small class="muted">Record a consultation with a treatment plan first.</small>'}
    </div>`;
  }

  function headHtml(m) {
    const latest = ctx.latestConsult();
    const newer = latest && !m.sources.includes(latest.id);
    const when = m.updatedAt ? m.updatedAt.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
    return `<div class="po-head">
      <div class="po-title"><strong>Master plan</strong>
        <select class="fb-select po-pstatus is-${esc(m.status)}" data-po="plan-status" aria-label="Plan status">${
          Object.entries(PLAN_STATUS).map(([v, l]) => `<option value="${v}"${v === m.status ? " selected" : ""}>${l}</option>`).join("")}</select>
        <small>Version ${m.version}${when ? ` · updated ${esc(when)}${m.updatedBy ? ` by ${esc(m.updatedBy)}` : ""}` : ""}</small></div>
      <div class="po-head-acts">
        <div class="fe-seg po-viewseg">${[["list", "List"], ["cal", "Calendar"]].map(([v, l]) =>
          `<label class="fe-seg-btn"><input type="radio" name="po-view" value="${v}" data-po-view${st.view === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
        ${newer ? '<button type="button" class="lh-btn" data-po="apply-latest">Update from the latest consultation</button>' : ""}
        <button type="button" class="lh-btn is-quiet" data-po="history">History</button>
      </div>
    </div>`;
  }

  function needsHtml(list) {
    return `<section class="po-needs"><h4>Needs action <em>${list.length}</em></h4>${list.map((x) => {
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
    }).join("")}</section>`;
  }

  /* ---------- Drawing: List ---------- */

  function lineHtml(c, l, lt, clashKeys) {
    const shown = lt.total ? lt.slots : lt.slots.slice(-6);
    const hidden = lt.slots.length - shown.length;
    const sub = [patternText(l), l.services.length ? `${l.services.length} linked service${l.services.length === 1 ? "" : "s"}` : ""]
      .filter(Boolean).join(" · ");
    return `<div class="po-line">
      <div class="po-line-top"><strong>${esc(l.treatment)}</strong>
        <button type="button" class="po-mini" data-po="edit-line" ${attrs(c, l)}>Edit</button></div>
      ${sub ? `<small class="po-sub">${esc(sub)}</small>` : ""}
      <div class="po-dots">${hidden ? `<span class="po-more">+${hidden}</span>` : ""}${shown.map((s) => {
        const clash = clashKeys.has(`${c.key}|${l.id}|${s.n}`);
        const t = `${slotText(lt, s)}${clash ? " · too close to a patient event" : ""}`;
        return `<button type="button" class="po-dotb is-${s.state}${s.manual ? " is-manual" : ""}${clash ? " is-clash" : ""}" data-po="slot" ${
          attrs(c, l, s.n)} title="${esc(t)}" aria-label="${esc(t)}"></button>`;
      }).join("")}</div>
      <small class="po-next is-${lt.complete ? "complete" : lt.next ? lt.next.state : "none"}">${esc(nextText(lt))}</small>
    </div>`;
  }

  function cardHtml(c, t, clashKeys) {
    const k = con(c.key);
    return `<article class="po-card${ACTIVE.includes(c.status) ? "" : " is-off"}" style="--c:${esc(k.colour)}">
      <header class="po-card-head"><strong>${esc(k.label)}</strong>
        <select class="po-cstatus" data-po="concern-status" ${attrs(c)} aria-label="${esc(k.label)} status">${
          Object.entries(CONCERN_STATUS).map(([v, l]) => `<option value="${v}"${v === c.status ? " selected" : ""}>${l}</option>`).join("")}</select>
      </header>
      ${c.description || c.area ? `<p class="po-desc">${esc(c.description)}${c.area ? ` <em>${esc(c.area)}</em>` : ""}</p>` : ""}
      <div class="po-lines">${c.lines.map((l) => lineHtml(c, l, t.lines.get(l.id), clashKeys)).join("") || '<p class="tb-none">No treatments yet.</p>'}</div>
      ${t.unmatched ? `<p class="po-unmatched">${t.unmatched} visit${t.unmatched === 1 ? "" : "s"} for this concern couldn't be matched to a treatment. Edit a treatment to link its services.</p>` : ""}
      <button type="button" class="po-add" data-po="add-line" ${attrs(c)}>+ Add a treatment</button>
      ${c.quote ? `<details class="po-quote"><summary>Quote</summary><p>${esc(c.quote).replace(/\n/g, "<br>")}</p></details>` : ""}
    </article>`;
  }

  function eventsHtml(m) {
    const list = m.events.slice().sort((a, b) => a.month.localeCompare(b.month));
    return `<section class="po-events">
      <div class="po-sec-head"><h4>Patient events</h4><button type="button" class="po-mini" data-po="add-event">+ Add</button></div>
      ${list.length ? `<ul class="po-evlist">${list.map((e) => `
        <li><strong>${esc(e.name)}</strong><span>${esc(monthLabel(e.month) || "No month")}${e.avoidDowntime ? " · avoid downtime before it" : ""}</span>
          <button type="button" class="po-x" data-po="remove-event" data-e="${esc(e.id)}" aria-label="Remove ${esc(e.name)}">×</button></li>`).join("")}</ul>`
        : '<p class="tb-none">Weddings, holidays or other dates to plan around.</p>'}
    </section>`;
  }

  /* ---------- Drawing: Calendar ---------- */

  function stepHtml(c, l, lt, s, clash, active) {
    const movable = active && OPEN_STATES.includes(s.state);
    const t = `${slotText(lt, s)}${clash ? " · too close to a patient event" : ""}${movable ? " · drag to move" : ""}`;
    return `<button type="button" class="pcal-step is-${s.state}${s.manual ? " is-manual" : ""}${movable ? " is-movable" : ""}${
      clash ? " is-clash" : ""}" data-po="slot" ${attrs(c, l, s.n)} data-row="${esc(`${c.key}|${l.id}`)}"
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
    m.concerns.forEach((c) => {
      const k = con(c.key);
      const active = ACTIVE.includes(c.status);
      const t = track.get(c.key);
      rows += `<div class="pcal-concern${active ? "" : " is-off"}" style="--c:${esc(k.colour)}">${esc(k.label)}${
        active ? "" : ` <small>${esc(CONCERN_STATUS[c.status])}</small>`}</div>`;
      c.lines.forEach((l) => {
        const lt = t.lines.get(l.id);
        const row = `${c.key}|${l.id}`;
        const unsched = lt.slots.filter((s) => !s.month && s.state !== "skipped");
        rows += `<div class="pcal-label${active ? "" : " is-off"}" style="--c:${esc(k.colour)}">
          <strong>${esc(l.treatment)}</strong><small>${esc(nextText(lt))}</small>
          ${unsched.map((s) => `<button type="button" class="pcal-uns" data-po="slot" ${attrs(c, l, s.n)}>Session ${s.n}: not scheduled</button>`).join("")}
        </div>${cells(active ? row : "", (mo) => lt.slots.filter((s) => s.month === mo)
          .map((s) => stepHtml(c, l, lt, s, clashKeys.has(`${row}|${s.n}`), active)).join(""))}`;
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

  function draw() {
    if (!el.isConnected) return;
    if (st.error) { el.innerHTML = `<p class="empty-note error">${esc(st.error)}</p>`; return; }
    if (!st.loaded) { el.innerHTML = '<div class="skeleton sm"></div>'; return; }
    const m = st.master;
    if (!m) { el.innerHTML = emptyHtml(); return; }
    const track = compute();
    const clashes = clashList(track);
    const clashKeys = new Set(clashes.map((x) => x.key));
    const list = needsList(track, clashes);
    el.innerHTML = `<div class="po">
      ${headHtml(m)}
      ${list.length ? needsHtml(list) : ""}
      ${st.view === "cal"
        ? calendarHtml(track, clashKeys)
        : `<div class="po-grid">${m.concerns.map((c) => cardHtml(c, track.get(c.key), clashKeys)).join("")}</div>${eventsHtml(m)}`}
    </div>`;
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
    const c = st.master && st.master.concerns.find((x) => x.key === ck);
    return [c || null, c && lid ? c.lines.find((x) => x.id === lid) || null : null];
  };
  const slotOf = (c, l, n) => {
    const lt = compute().get(c.key).lines.get(l.id);
    return [lt, lt && lt.slots.find((x) => x.n === n)];
  };
  // Later sessions of the same treatment that are still to come (these follow a move)
  const laterOpen = (lt, n) => lt.slots.filter((x) => x.n > n && OPEN_STATES.includes(x.state) && x.month);

  function setPlanStatus(v) {
    if (!PLAN_STATUS[v] || v === st.master.status) return;
    commit((p) => { p.status = v; }, "Changed the plan status", PLAN_STATUS[v]);
  }

  function setConcernStatus(c, v) {
    if (!c || !CONCERN_STATUS[v] || v === c.status) return;
    commit((p) => { const x = p.concerns.find((y) => y.key === c.key); if (x) x.status = v; },
      "Changed a concern's status", `${con(c.key).label}: ${CONCERN_STATUS[v]}`);
  }

  /* ---------- Moving a session (later ones keep their spacing) ---------- */

  // keepGaps: sessions after it move by the same number of months. Otherwise they stay where they are.
  async function moveSlot(c, l, n, toMonth, keepGaps = true) {
    const [lt, s] = slotOf(c, l, n);
    if (!s || !MONTH_RE.test(toMonth) || !OPEN_STATES.concat("unscheduled").includes(s.state)) return false;
    if (toMonth === s.month && !s.moved) return false;
    const shift = s.month ? monthDiff(s.month, toMonth) : 0;
    const later = laterOpen(lt, n);
    const ov = l.overrides || {};
    return commit((p) => {
      setOv(p, c.key, l.id, String(n), { month: toMonth });
      later.forEach((x) => {
        const own = (ov[String(x.n)] || {}).month;
        // Sessions without their own month already follow the moved one (by the interval). Pinned ones shift with it.
        if (keepGaps) { if (own && shift) setOv(p, c.key, l.id, String(x.n), { month: addMonths(own, shift) }); }
        else setOv(p, c.key, l.id, String(x.n), { month: x.month });
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
    await commit((p) => setOv(p, c.key, l.id, String(n), { asked: { at: new Date().toISOString(), by: (staff && staff.name) || "" } }),
      rebookNote ? "Asked reception to rebook" : "Asked reception to book", text);
    showToast("Reminder added for reception");
    if (ctx.onReminder) ctx.onReminder();
  }

  /* ---------- One session ---------- */

  function slotDialog(c, l, n) {
    const [lt, s] = slotOf(c, l, n);
    if (!s) return;
    const today = dateKeyOf(new Date());
    const open = !["done", "booked", "skipped"].includes(s.state);
    const later = laterOpen(lt, n);
    const dt = downtimeOf(c, l);
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${esc(l.treatment)}</h3><p>${chip(c.key)} ${esc(slotText(lt, s))}${
        dt.days ? ` · ${dt.days} day${dt.days === 1 ? "" : "s"} of downtime` : ""}</p></div>
      ${s.state === "done" && !s.manual ? `<p class="inv-hint">Matched to the appointment on ${esc(dayLabel(s.date))}, so it's counted automatically.</p>` : ""}
      ${s.state === "booked" ? `<p class="inv-hint">There's an appointment booked for ${esc(dayLabel(s.date))}. It becomes Done after the visit.</p>` : ""}
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
      const b = e.target.closest("[data-act]");
      if (!b || st.busy) return;
      const act = b.dataset.act;
      if (act === "close") { dlg.close(); return; }
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
      if (await commit((p) => setOv(p, c.key, l.id, String(n), patch), action, label)) dlg.close();
      else b.disabled = false;
    });
  }

  /* ---------- Add / edit a treatment line ---------- */

  function editLine(c, l) {
    const isNew = !l;
    const x = l || { treatment: "", pattern: "course", sessions: 3, intervalWeeks: 4, startMonth: "", countFrom: "", services: [], overrides: {} };
    const linked = new Set(x.services.map(serviceKey));
    const cands = [...new Map([
      ...st.settings.services.filter((r) => r.concerns.includes(c.key)).map((r) => r.service),
      ...x.services,
    ].map((s) => [serviceKey(s), s])).values()].sort((a, b) => a.localeCompare(b, "en-AU"));
    const tracked = !isNew && Object.keys(x.overrides || {}).length > 0;
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${isNew ? "Add a treatment" : "Edit treatment"}</h3><p>${chip(c.key)}</p></div>
      <label class="lh-field"><span class="lh-label">Treatment</span>
        <input name="treatment" maxlength="300" value="${esc(x.treatment)}" placeholder="e.g. Skin Needling, full face" /></label>
      <div class="inv-two">
        <label class="lh-field"><span class="lh-label">How often</span><select class="fb-select" name="pattern">${
          Object.entries(PATTERN_LABEL).map(([v, t]) => `<option value="${v}"${v === x.pattern ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="lh-field" data-role="sess"><span class="lh-label">Sessions</span>
          <input name="sessions" type="number" min="1" max="52" step="1" value="${x.sessions || ""}" /></label>
        <label class="lh-field" data-role="iv"><span class="lh-label">Every (weeks)</span>
          <input name="interval" type="number" min="1" max="520" step="1" value="${x.intervalWeeks || ""}" placeholder="e.g. 4" />
          <small class="fe-note">13 weeks ≈ 3 months · 26 ≈ 6 months · 52 = a year</small></label>
        <label class="lh-field"><span class="lh-label">Start month</span>
          <input name="start" type="month" value="${esc(x.startMonth)}" placeholder="2026-11" /></label>
        <label class="lh-field"><span class="lh-label">Count visits from (optional)</span>
          <input name="from" type="date" value="${esc(x.countFrom)}" />
          <small class="fe-note">Visits before this day don't count. Empty: from the consultation.</small></label>
      </div>
      <div class="lh-field"><span class="lh-label">Appointment services that count as this treatment</span>
        ${cands.length ? `<input type="search" class="fe-input" data-role="svcfind" placeholder="Search services" aria-label="Search services" />
          <div class="po-svcs">${cands.map((s) => `<label class="fe-check" data-find="${esc(s.toLowerCase())}">
            <input type="checkbox" name="svc" value="${esc(s)}"${linked.has(serviceKey(s)) ? " checked" : ""} /> ${esc(s)}</label>`).join("")}</div>`
          : '<p class="tb-none">No services are set up for this concern yet (Inventory → Treatment plans).</p>'}
        <small class="fe-note">None ticked: visits for this concern are matched by the treatment's name.</small></div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        ${isNew ? "" : '<button type="button" class="lh-btn is-quiet po-danger" data-act="remove">Remove</button>'}
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">${isNew ? "Add" : "Save"}</button>
      </div>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const sync = () => {
      const p = form.elements.pattern.value;
      dlg.querySelector('[data-role="sess"]').style.display = p === "course" ? "" : "none";
      dlg.querySelector('[data-role="iv"]').style.display = p === "once" ? "none" : "";
    };
    sync();
    form.elements.pattern.addEventListener("change", sync);
    const find = dlg.querySelector('[data-role="svcfind"]');
    if (find) {
      find.addEventListener("input", () => {
        const q = find.value.trim().toLowerCase();
        dlg.querySelectorAll(".po-svcs [data-find]").forEach((r) => {
          r.hidden = !!q && !r.dataset.find.includes(q) && !r.querySelector("input").checked;
        });
      });
      find.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    }
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    const rm = dlg.querySelector('[data-act="remove"]');
    if (rm) {
      rm.addEventListener("click", async () => {
        if (!(await confirmDialog({
          title: `Remove ${x.treatment}?`,
          message: tracked ? "Sessions marked by hand, skipped or moved for it are removed too. The plan's history keeps a copy."
            : "It's taken out of the plan. The plan's history keeps a copy.",
          confirmLabel: "Remove", tone: "danger",
        }))) return;
        if (await commit((p) => {
          const pc = p.concerns.find((y) => y.key === c.key);
          if (pc) pc.lines = pc.lines.filter((y) => y.id !== l.id);
        }, "Removed a treatment", `${con(c.key).label}: ${x.treatment}`)) dlg.close();
      });
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const pattern = f.pattern.value;
      const treatment = f.treatment.value.trim();
      const start = f.start.value.trim();
      err.hidden = true;
      if (!treatment) { err.textContent = "Enter the treatment."; err.hidden = false; return; }
      if (start && !MONTH_RE.test(start)) { err.textContent = "Enter the start month as e.g. 2026-11."; err.hidden = false; return; }
      if (pattern === "course" && !(parseInt(f.sessions.value, 10) >= 1)) { err.textContent = "Enter how many sessions."; err.hidden = false; return; }
      const fields = {
        treatment, pattern,
        sessions: pattern === "course" ? f.sessions.value : 0,
        intervalWeeks: pattern === "once" ? 0 : f.interval.value,
        startMonth: start, countFrom: f.from.value,
        services: [...form.querySelectorAll('[name="svc"]:checked')].map((y) => y.value),
      };
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      const ok = await commit((p) => {
        const pc = p.concerns.find((y) => y.key === c.key);
        if (!pc) return;
        if (isNew) pc.lines.push(cleanLine(fields));
        else {
          const i = pc.lines.findIndex((y) => y.id === l.id);
          if (i > -1) pc.lines[i] = cleanLine({ ...pc.lines[i], ...fields });
        }
      }, isNew ? "Added a treatment" : "Edited a treatment", `${con(c.key).label}: ${treatment}`);
      if (ok) dlg.close(); else btn.disabled = false;
    });
    form.elements.treatment.focus();
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
    if (!b || b.tagName === "SELECT" || st.busy) return;
    const d = b.dataset;
    if (d.po === "apply-latest") { ctx.applyLatest(); return; }
    if (d.po === "history") { showHistory(); return; }
    if (d.po === "add-event") { addEvent(); return; }
    if (d.po === "remove-event") { removeEvent(d.e); return; }
    if (d.po === "cal-prev") { st.calStart = addMonths(st.calStart, -3); draw(); return; }
    if (d.po === "cal-next") { st.calStart = addMonths(st.calStart, 3); draw(); return; }
    if (d.po === "cal-today") { st.calStart = addMonths(thisMonth(), -1); draw(); return; }
    const [c, l] = findLine(d.c, d.l);
    if (!c) return;
    if (d.po === "set-concern") setConcernStatus(c, d.v);
    else if (d.po === "add-line") editLine(c, null);
    else if (d.po === "edit-line" && l) editLine(c, l);
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
    if (t.matches("[data-po-view]")) {
      st.view = t.value === "cal" ? "cal" : "list";
      try { localStorage.setItem(VIEW_KEY, st.view); } catch { /* not essential */ }
      draw();
      return;
    }
    if (st.busy) { draw(); return; }
    if (t.matches('[data-po="plan-status"]')) setPlanStatus(t.value);
    else if (t.matches('[data-po="concern-status"]')) setConcernStatus(findLine(t.dataset.c)[0], t.value);
  });

  draw();
  return { load, redraw: draw };
}