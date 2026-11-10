// "Create / update the master plan" from one consultation: review each concern, tick what to apply.
import {
  getMasterPlan, planChanges, applyChanges, saveMasterPlan, patternText, monthLabel, matchServices,
  cleanEvent, isTreatmentEvent, normTx, newId, stampText, savedLine,
} from "./master-plan-api.js";
import { getPlanSettings, getPlanWorkflow, cleanWorkflow } from "./plan-api.js";
import { CATEGORIES } from "./plan-editor.js";
import { showToast, toDateKey } from "./utils.js";


const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BADGE = {
  new: ["New concern", "is-new"], changed: ["Changed", "is-chg"], same: ["No change", "is-same"], uncategorised: ["Choose a concern", "is-chg"],
};

// patient = { id, pttId, name } · consult = the plan model from the consultation
export async function openPlanReview({ patient, consult, recordId = "", recordDate = null, staff, onDone } = {}) {
  if (!patient || !patient.id) { showToast("This consultation isn't linked to a patient record."); return; }
  if (!consult || consult.intent === "reviewing_existing" || !(consult.concerns || []).length) {
    showToast(consult && consult.intent === "reviewing_existing"
      ? "This consultation reviewed the existing plan, so there's nothing new to add."
      : "This consultation has no treatment plan to add.");
    return;
  }
  let master;
  let settings;
  let wf;
  try {
    [master, settings, wf] = await Promise.all([
      getMasterPlan(patient.id),
      getPlanSettings().catch(() => ({ concerns: [], services: [] })),
      getPlanWorkflow().catch(() => cleanWorkflow({})),
    ]);
  } catch (err) {
    console.error("Master plan load failed:", err);
    showToast(err && err.code === "permission-denied"
      ? "The master plan isn't accessible. Check the treatment_plans Firestore rules."
      : "Couldn't open the master plan. Try again.");
    return;
  }
  const fromKey = recordDate instanceof Date && !isNaN(recordDate) ? toDateKey(recordDate) : "";
  const { items, events: suggested, dropped = [] } = planChanges(master, consult,
    { recordId, services: settings.services, treatments: settings.treatments || [], fromKey });
  // Patient events, editable here before applying: ticked, edited, removed or added
  const MONTH_RE = /^\d{4}-\d{2}$/;
  const evs = suggested.map((e) => ({ ...e, on: true, isNew: false }));
  let editing = "";   // the event open for editing ("" = none)
  // Treatment names an event mustn't be (this consultation's, the services, the clinic's list)
  const txNames = [
    ...items.flatMap((it) => it.after.lines.map((l) => l.treatment)),
    ...(settings.services || []).map((r) => r.service),
    ...(settings.treatments || []).map((t) => t.name),
  ].filter(Boolean);
  const con = (k) => settings.concerns.find((c) => c.name === k) || { label: k, colour: "#888780" };
  const chip = (k) => (k ? `<span class="ps-chip" style="--c:${esc(con(k).colour)}">${esc(con(k).label)}</span>` : "");
  const linesHtml = (c) => `<ul class="mp-lines">${c.lines.map((l) => {
    const bits = [patternText(l), l.startMonth && `from ${monthLabel(l.startMonth)}`].filter(Boolean);
    return `<li><strong>${esc(l.treatment)}</strong>${bits.length ? ` <small>${esc(bits.join(" · "))}</small>` : ""}</li>`;
  }).join("")}</ul>${c.quote ? `<p class="mp-quote">${esc(c.quote).replace(/\n/g, "<br>")}</p>` : ""}`;
  const when = recordDate instanceof Date && !isNaN(recordDate)
    ? recordDate.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
  const toApply = items.filter((it) => it.kind !== "same").length;
  // The starting priority for new concerns (the clinician can change it for each one)
  const defPhase = master && master.concerns.length ? wf.addPhase : wf.newPlanPhase;
  const phaseSel = (i) => wf.phases.length > 1
    ? `<select class="fb-select mp-phase" data-phase="${i}" aria-label="Priority">${wf.phases.map((p) =>
      `<option value="${esc(p.id)}"${p.id === defPhase ? " selected" : ""}>${esc(p.name)}${p.tracked ? "" : " (waiting)"}</option>`).join("")}</select>`
    : "";
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg mp-dlg";
  dlg.innerHTML = `
    <form class="lh-form" novalidate>
      <div class="lh-dialog-head">
        <h3>${master ? "Update the master plan" : "Create the master plan"}</h3>
        <p>${esc(patient.name || "Patient")}${when ? ` · from the consultation on ${esc(when)}` : ""}${
          master ? ` · currently version ${master.version}` : ""}. Tick what to apply. Anything already tracked stays as it is.</p>
        ${master && master.updatedAt ? `<p class="mp-saved">Last ${esc(savedLine(master).charAt(0).toLowerCase() + savedLine(master).slice(1))}</p>` : ""}</div>
      <div class="mp-items">${items.map((it, i) => it.kind === "same" ? `
        <div class="mp-row is-same"><span class="mp-tick"></span><div class="mp-main">
          <span class="mp-top">${chip(it.key)} <span class="mp-badge is-same">No change</span></span></div></div>` : `
        <div class="mp-row">
          <label class="mp-tick"><input type="checkbox" name="pick" value="${i}" checked aria-label="Apply" /></label>
          <div class="mp-main">
            <span class="mp-top">${it.kind === "uncategorised"
              ? `<select class="fb-select mp-cat" data-cat="${i}" aria-label="Which concern"><option value="">Choose a concern…</option>${
                CATEGORIES.map((k) => `<option value="${esc(k)}">${esc(con(k).label)}</option>`).join("")}</select>`
              : chip(it.key)}
              <span class="mp-badge ${BADGE[it.kind][1]}">${it.again ? "Another entry for this concern" : BADGE[it.kind][0]}</span>
              ${it.kind === "new" || it.kind === "uncategorised" ? phaseSel(i) : ""}</span>
            ${it.after.description ? `<p class="mp-desc">${esc(it.after.description)}${it.after.area ? ` · <em>${esc(it.after.area)}</em>` : ""}</p>` : ""}
            ${linesHtml(it.after)}
            ${it.before ? `<details class="mp-before"><summary>What the plan has now</summary>${linesHtml(it.before)}</details>` : ""}
          </div>
        </div>`).join("")}
        <section class="mp-evs">
          <p class="mp-ev-head"><strong>Patient events</strong>
            <small>Holidays, birthdays, weddings, travel: dates to plan treatments around. Not appointments or treatments.</small></p>
          <div data-role="evs"></div>
          <button type="button" class="lh-btn mp-ev-add" data-evact="add">+ Add an event</button>
          ${dropped.length ? `<p class="mp-ev-dropped">Not added as events (they're treatments, not patient events): ${
            dropped.map((e) => esc(e.name)).join(", ")}</p>` : ""}
        </section>
      </div>
      ${!toApply && !evs.length ? '<p class="inv-hint">Everything in this consultation is already in the master plan. You can still add a patient event.</p>' : ""}
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">${master ? "Update master plan" : "Create master plan"}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  const opId = newId();   // this dialog's save: sending it twice can't make a conflict
  // Open the dialog again with the plan as it is now
  err.addEventListener("click", (e) => {
    if (!e.target.closest('[data-act="reload"]')) return;
    dlg.close();
    if (onDone) onDone();
    openPlanReview({ patient, consult, recordId, recordDate, staff, onDone });
  });

  /* ---------- Patient events: tick, edit, remove, add ---------- */

  const evBox = dlg.querySelector('[data-role="evs"]');
  const evRowHtml = (e) => (e.id === editing ? `
    <div class="mp-row is-editing" data-ev="${esc(e.id)}">
      <span class="mp-tick"></span>
      <div class="mp-main">
        <span class="mp-top"><span class="ps-chip" style="--c:#BA7517">Patient event</span></span>
        <div class="mp-ev-form">
          <label class="lh-field"><span class="lh-label">What</span>
            <input data-evf="name" maxlength="100" value="${esc(e.name)}" placeholder="e.g. Holiday in Bali, daughter's wedding" /></label>
          <label class="lh-field"><span class="lh-label">Month</span>
            <input data-evf="month" type="month" value="${esc(e.month)}" placeholder="2027-03" /></label>
        </div>
        <label class="fe-check"><input type="checkbox" data-evf="avoid"${e.avoidDowntime ? " checked" : ""} /> Avoid treatments with downtime just before it</label>
        <p class="fe-note fe-bad" data-role="everr" hidden></p>
        <div class="mp-ev-acts">
          <button type="button" class="lh-btn is-quiet" data-evact="cancel">Cancel</button>
          <button type="button" class="lh-btn is-primary" data-evact="save">Done</button>
        </div>
      </div>
    </div>` : `
    <div class="mp-row" data-ev="${esc(e.id)}">
      <label class="mp-tick"><input type="checkbox" data-evon="${esc(e.id)}"${e.on ? " checked" : ""} aria-label="Add ${esc(e.name)}" /></label>
      <div class="mp-main">
        <span class="mp-top"><span class="ps-chip" style="--c:#BA7517">Patient event</span>
          <span class="mp-badge is-new">${e.source === "staff" ? "Added here" : "New"}</span>
          <span class="mp-ev-btns">
            <button type="button" class="po-mini" data-evact="edit" aria-label="Edit ${esc(e.name)}">Edit</button>
            <button type="button" class="po-x" data-evact="remove" aria-label="Remove ${esc(e.name)}" title="Remove">×</button>
          </span></span>
        <p class="mp-desc"><strong>${esc(e.name)}</strong> · ${esc(monthLabel(e.month))}${e.avoidDowntime ? " · avoid downtime before it" : ""}</p>
      </div>
    </div>`);

  function drawEvents() {
    evBox.innerHTML = evs.length ? evs.map(evRowHtml).join("")
      : '<p class="mp-ev-none">No patient events from this consultation.</p>';
    const name = evBox.querySelector('[data-evf="name"]');
    if (name) name.focus();
  }

  // Checks and keeps the event being edited. false = something needs fixing (the message shows on the row).
  function saveEdit() {
    const e = evs.find((x) => x.id === editing);
    const row = e && evBox.querySelector(`[data-ev="${CSS.escape(e.id)}"]`);
    if (!e || !row) { editing = ""; return true; }
    const bad = (t) => { const p = row.querySelector('[data-role="everr"]'); p.textContent = t; p.hidden = false; return false; };
    const name = row.querySelector('[data-evf="name"]').value.trim().replace(/\s+/g, " ").slice(0, 100);
    const month = row.querySelector('[data-evf="month"]').value.trim();
    if (!name) return bad("Enter what the event is.");
    if (!MONTH_RE.test(month)) return bad("Choose the month (e.g. 2027-03).");
    if (isTreatmentEvent(name, txNames)) {
      return bad("That looks like a treatment or appointment. Patient events are things like holidays, birthdays and weddings.");
    }
    const key = `${normTx(name)}|${month}`;
    const others = [...(master ? master.events : []), ...evs.filter((x) => x.id !== e.id)];
    if (others.some((x) => `${normTx(x.name)}|${x.month}` === key)) return bad("That event is already on this list or on the plan.");
    Object.assign(e, { name, month, avoidDowntime: row.querySelector('[data-evf="avoid"]').checked, on: true, isNew: false });
    editing = "";
    return true;
  }

  form.addEventListener("click", (e) => {
    const b = e.target.closest("[data-evact]");
    if (!b) return;
    const act = b.dataset.evact;
    const row = b.closest("[data-ev]");
    const id = row ? row.dataset.ev : "";
    if (act === "add") {
      if (editing && !saveEdit()) return;
      const ev = { ...cleanEvent({ name: "", month: "", avoidDowntime: true, source: "staff" }), on: true, isNew: true };
      evs.push(ev);
      editing = ev.id;
      drawEvents();
      return;
    }
    if (act === "edit") {
      if (editing && editing !== id && !saveEdit()) return;
      editing = id;
      drawEvents();
      return;
    }
    if (act === "remove") {
      const i = evs.findIndex((x) => x.id === id);
      if (i > -1) evs.splice(i, 1);
      if (editing === id) editing = "";
      drawEvents();
      return;
    }
    if (act === "cancel") {
      const i = evs.findIndex((x) => x.id === id);
      if (i > -1 && evs[i].isNew) evs.splice(i, 1);   // a new one that was never finished goes
      editing = "";
      drawEvents();
      return;
    }
    if (act === "save" && saveEdit()) drawEvents();
  });

  // Enter in the event's boxes = Done (not "Create master plan")
  form.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.closest("[data-evf]")) return;
    e.preventDefault();
    if (saveEdit()) drawEvents();
  });

  drawEvents();
  // Choosing a concern for an uncategorised one ticks it
  form.addEventListener("change", (e) => {
    const on = e.target.closest("[data-evon]");
    if (on) { const ev = evs.find((x) => x.id === on.dataset.evon); if (ev) ev.on = on.checked; return; }
    const sel = e.target.closest("[data-cat]");
    if (sel && sel.value) form.querySelector(`[name="pick"][value="${sel.dataset.cat}"]`).checked = true;
  });
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (editing && !saveEdit()) {
      err.textContent = "Finish the patient event you're editing (press Done), or cancel it.";
      err.hidden = false;
      return;
    }
    const picks = [];
    for (const box of form.querySelectorAll('[name="pick"]:checked')) {
      const i = Number(box.value);
      const it = items[i];
      const sel = form.querySelector(`[data-phase="${i}"]`);
      const priority = sel ? sel.value : defPhase;
      if (it.kind === "changed") { picks.push(it); continue; }      // keeps its current priority
      if (it.kind !== "uncategorised") { picks.push({ ...it, after: { ...it.after, priority } }); continue; }
      const key = form.querySelector(`[data-cat="${i}"]`).value;
      if (!key) { err.textContent = "Choose which concern each ticked item belongs to, or untick it."; err.hidden = false; return; }
      const after = { ...it.after, key, priority, lines: it.after.lines.map((l) => ({ ...l, services: l.services.length ? l.services : matchServices(l.treatment, key, settings.services) })) };
      picks.push({ ...it, key, after });
    }
    const evPicks = evs.filter((x) => x.on && x.name && MONTH_RE.test(x.month))
      .map(({ on, isNew, ...x }) => cleanEvent(x));
    // A concern chosen by hand updates the plan's entry for it when there's exactly one that nothing else is updating.
    // Otherwise it's listed as its own entry: the same concern can be in the plan more than once.
    const used = new Set(picks.map((p) => p.targetId).filter(Boolean));
    picks.forEach((p) => {
      if (p.kind !== "uncategorised" || !master) return;
      const free = master.concerns.filter((c) => c.key === p.key && !used.has(c.id));
      if (free.length === 1) { p.targetId = free[0].id; used.add(free[0].id); }
    });
    if (!picks.length && !evPicks.length) { err.textContent = "Tick at least one thing to apply."; err.hidden = false; return; }

    const added = picks.filter((p) => !p.targetId).length;
    const changed = picks.length - added;
    const summary = [added && `${added} concern${added === 1 ? "" : "s"} added`, changed && `${changed} updated`,
      evPicks.length && `${evPicks.length} event${evPicks.length === 1 ? "" : "s"} added`].filter(Boolean).join(", ") +
      (when ? ` (consultation ${when})` : "");
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await saveMasterPlan(patient, applyChanges(master, picks, evPicks), {
        action: master ? "Updated from a consultation" : "Created from a consultation",
        summary, recordId, expectedVersion: master ? master.version : 0, opId,
      }, staff);
      dlg.close();
      showToast(`${master ? "Master plan updated" : "Master plan created"} · saved ${stampText(new Date())}`);
      if (onDone) onDone();
    } catch (ex) {
      console.error("Save master plan failed:", ex);
      btn.disabled = false;
      btn.textContent = master ? "Update master plan" : "Create master plan";
      err.hidden = false;
      if (ex && /Someone else/.test(ex.message || "")) {
        // Who saved it, and when, then one click to start again from their version
        let now = null;
        try { now = await getMasterPlan(patient.id); } catch { now = null; }
        const who = now && now.updatedAt
          ? `${now.updatedBy || "Someone"} saved it ${stampText(now.updatedAt)}` : "Someone has just saved it";
        const inIt = now && recordId && now.sources.includes(recordId) ? ", and this consultation is already in it" : "";
        err.innerHTML = `The plan changed after this window opened: ${esc(who)}${inIt}.
          <button type="button" class="lh-btn" data-act="reload">Reload with the latest plan</button>`;
        return;
      }
      err.textContent = ex && ex.code === "permission-denied"
        ? "You don't have access to change treatment plans (needs clinical access)."
        : (ex && ex.message && !ex.code ? ex.message : "Couldn't save. Try again.");
    }
  });
}