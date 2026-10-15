// "Create / update the master plan" from one consultation: review each concern, tick what to apply.
import { getMasterPlan, planChanges, applyChanges, saveMasterPlan, patternText, monthLabel, matchServices } from "./master-plan-api.js";
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
  const { items, events } = planChanges(master, consult, { recordId, services: settings.services, fromKey });
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
          master ? ` · currently version ${master.version}` : ""}. Tick what to apply. Anything already tracked stays as it is.</p></div>
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
              <span class="mp-badge ${BADGE[it.kind][1]}">${BADGE[it.kind][0]}</span>
              ${it.kind === "new" || it.kind === "uncategorised" ? phaseSel(i) : ""}</span>
            ${it.after.description ? `<p class="mp-desc">${esc(it.after.description)}${it.after.area ? ` · <em>${esc(it.after.area)}</em>` : ""}</p>` : ""}
            ${linesHtml(it.after)}
            ${it.before ? `<details class="mp-before"><summary>What the plan has now</summary>${linesHtml(it.before)}</details>` : ""}
          </div>
        </div>`).join("")}
        ${events.map((e, i) => `
        <div class="mp-row">
          <label class="mp-tick"><input type="checkbox" name="ev" value="${i}" checked aria-label="Add event" /></label>
          <div class="mp-main"><span class="mp-top"><span class="ps-chip" style="--c:#BA7517">Patient event</span>
            <span class="mp-badge is-new">New</span></span>
            <p class="mp-desc"><strong>${esc(e.name)}</strong> · ${esc(monthLabel(e.month))}${e.avoidDowntime ? " · avoid downtime before it" : ""}</p></div>
        </div>`).join("")}
      </div>
      ${!toApply && !events.length ? '<p class="inv-hint">Everything in this consultation is already in the master plan.</p>' : ""}
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        ${toApply || events.length ? `<button type="submit" class="lh-btn is-primary">${master ? "Update master plan" : "Create master plan"}</button>` : ""}
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  // Choosing a concern for an uncategorised one ticks it
  form.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-cat]");
    if (sel && sel.value) form.querySelector(`[name="pick"][value="${sel.dataset.cat}"]`).checked = true;
  });
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
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
    const evPicks = [...form.querySelectorAll('[name="ev"]:checked')].map((x) => events[Number(x.value)]);
    if (new Set(picks.map((p) => p.key)).size < picks.length) {
      err.textContent = "Two ticked items are set to the same concern. Untick one, or choose a different concern."; err.hidden = false; return;
    }
    if (!picks.length && !evPicks.length) { err.textContent = "Tick at least one thing to apply."; err.hidden = false; return; }

    const added = picks.filter((p) => !master || !master.concerns.some((c) => c.key === p.key)).length;
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
        summary, recordId, expectedVersion: master ? master.version : 0,
      }, staff);
      dlg.close();
      showToast(master ? "Master plan updated" : "Master plan created");
      if (onDone) onDone();
    } catch (ex) {
      console.error("Save master plan failed:", ex);
      err.textContent = ex && ex.code === "permission-denied"
        ? "You don't have access to change treatment plans (needs clinical access)."
        : (ex && ex.message && !ex.code ? ex.message : "Couldn't save. Try again.");
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = master ? "Update master plan" : "Create master plan";
    }
  });
}