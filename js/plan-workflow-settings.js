// System configuration → Plan workflow: the priorities (phases) and the rules the master plan follows.
import { getPlanWorkflow, savePlanWorkflow, cleanWorkflow } from "./plan-api.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newPhaseId = () => `p${Math.random().toString(36).slice(2, 8)}`;

export async function renderPlanWorkflowSettings(el, { staff } = {}) {
  el.innerHTML = '<div class="skeleton sm"></div>';
  let wf;
  try { wf = await getPlanWorkflow(); }
  catch (err) {
    console.error("Plan workflow failed:", err);
    el.innerHTML = '<p class="empty-note error">Couldn\'t load the plan workflow.</p>';
    return;
  }
  let dirty = false;
  let saving = false;

  const radios = (name, value, opts) => opts.map(([v, l]) =>
    `<label class="fe-check"><input type="radio" name="${name}" value="${v}"${v === value ? " checked" : ""} /> ${esc(l)}</label>`).join("");
  const phaseSelect = (name, value) => `<select class="fb-select" name="${name}">${wf.phases.map((p) =>
    `<option value="${esc(p.id)}"${p.id === value ? " selected" : ""}>${esc(p.name || "Untitled")}</option>`).join("")}</select>`;

  function draw() {
    el.innerHTML = `<div class="pw">
      <section class="pw-card">
        <h3>Priorities</h3>
        <p class="muted">Each concern in a master plan sits in one priority. <strong>Tracked</strong> priorities are scheduled: their
          sessions can be due or overdue, and reception is asked to book them. The others show as <em>Waiting</em> until the concern is moved up.</p>
        <div class="pw-phases">${wf.phases.map((p, i) => `
          <div class="pw-phase" data-i="${i}">
            <span class="pw-num">${i + 1}</span>
            <input type="color" data-f="colour" value="${esc(p.colour)}" aria-label="Colour" />
            <div class="pw-fields">
              <input class="fe-input" data-f="name" maxlength="40" value="${esc(p.name)}" placeholder="e.g. Priority 1 · Now" aria-label="Name" />
              <input class="fe-input" data-f="note" maxlength="200" value="${esc(p.note)}" placeholder="Shown to the patient under the heading (optional)" aria-label="Description" />
            </div>
            <label class="fe-check pw-tracked"><input type="checkbox" data-f="tracked"${p.tracked ? " checked" : ""} /> Tracked</label>
            <div class="pw-btns">
              <button type="button" class="po-mini" data-act="up"${i === 0 ? " disabled" : ""} aria-label="Move up">↑</button>
              <button type="button" class="po-mini" data-act="down"${i === wf.phases.length - 1 ? " disabled" : ""} aria-label="Move down">↓</button>
              <button type="button" class="po-mini" data-act="remove"${wf.phases.length === 1 ? " disabled" : ""} aria-label="Remove">×</button>
            </div>
          </div>`).join("")}</div>
        ${wf.phases.length < 5 ? '<button type="button" class="lh-btn" data-act="add">+ Add a priority</button>' : ""}
      </section>

      <section class="pw-card">
        <h3>New concerns from a consultation</h3>
        <div class="inv-two">
          <label class="lh-field"><span class="lh-label">When creating a new plan</span>${phaseSelect("newPlanPhase", wf.newPlanPhase)}</label>
          <label class="lh-field"><span class="lh-label">When the plan already has concerns</span>${phaseSelect("addPhase", wf.addPhase)}</label>
        </div>
        <small class="fe-note">Only the starting choice. The clinician can change it for each concern when applying the consultation.</small>
      </section>

      <section class="pw-card">
        <h3>Moving up</h3>
        <div class="lh-field"><span class="lh-label">When the tracked concerns are finished, or a waiting concern is booked</span>
          <div class="pv-radios">${radios("promote", wf.promote, [["suggest", "Suggest moving it up (in Needs action)"], ["off", "Don't suggest anything"]])}</div></div>
        <div class="lh-field"><span class="lh-label">Start month when a concern is moved up</span>
          <div class="pv-radios">${radios("promoteStart", wf.promoteStart, [["ask", "Ask each time"], ["this", "This month"], ["next", "Next month"]])}</div>
          <small class="fe-note">Only for treatments not done or booked yet, so they don't show as overdue the moment they're moved up.</small></div>
      </section>

      <section class="pw-card">
        <h3>Plan status and reminders</h3>
        <div class="lh-field"><span class="lh-label">Booking reminders start</span>
          <div class="pv-radios">${radios("remindFrom", wf.remindFrom, [["accepted", "Once the patient has accepted the plan"], ["proposed", "Straight away, from Proposed"]])}</div></div>
        <label class="fe-check"><input type="checkbox" name="waitingKeepsOpen"${wf.waitingKeepsOpen ? " checked" : ""} /> Waiting concerns keep the plan In progress</label>
        <small class="fe-note">Untick to mark the plan Completed once every tracked concern is resolved or not pursued, even if some are still waiting.</small>
      </section>

      <section class="pw-card">
        <h3>Patient copy</h3>
        <label class="fe-check"><input type="checkbox" name="docShowWaiting"${wf.docShowWaiting ? " checked" : ""} /> Include waiting priorities (ticked by default)</label>
        <label class="fe-check"><input type="checkbox" name="docPhaseTotals"${wf.docPhaseTotals ? " checked" : ""} /> Show a quote total under each priority</label>
        <small class="fe-note">Totals add up the dollar amounts in the quotes shown, so write one price per line (not "$650 or $900").</small>
      </section>

      <p class="lh-error" role="alert" hidden></p>
      <div class="pw-save">
        <button type="button" class="lh-btn is-quiet" data-act="reset">Back to the defaults</button>
        <button type="button" class="lh-btn is-primary" data-act="save"${dirty ? "" : " disabled"}>Save workflow</button>
      </div>
    </div>`;
  }

  const touch = () => {
    dirty = true;
    const b = el.querySelector('[data-act="save"]');
    if (b) b.disabled = false;
  };

  const onEdit = (e) => {
    const t = e.target;
    const row = t.closest(".pw-phase");
    if (row && t.dataset.f) {
      const p = wf.phases[Number(row.dataset.i)];
      p[t.dataset.f] = t.dataset.f === "tracked" ? t.checked : t.value;
      // The new name shows in the two lists below without redrawing (keeps the cursor where it is)
      if (t.dataset.f === "name") el.querySelectorAll(`option[value="${CSS.escape(p.id)}"]`).forEach((o) => { o.textContent = p.name || "Untitled"; });
      touch();
      return;
    }
    if (t.name && t.name in wf) {
      wf[t.name] = t.type === "checkbox" ? t.checked : t.value;
      touch();
    }
  };
  el.addEventListener("input", onEdit);
  el.addEventListener("change", onEdit);

  async function save() {
    const err = el.querySelector(".lh-error");
    const fail = (t) => { err.textContent = t; err.hidden = false; };
    err.hidden = true;
    if (wf.phases.some((p) => !String(p.name || "").trim())) { fail("Give every priority a name."); return; }
    if (!wf.phases.some((p) => p.tracked)) { fail("At least one priority must be Tracked, otherwise nothing is ever scheduled."); return; }
    const b = el.querySelector('[data-act="save"]');
    saving = true;
    b.disabled = true;
    b.textContent = "Saving…";
    try {
      await savePlanWorkflow(wf, staff);
      wf = await getPlanWorkflow();
      dirty = false;
      saving = false;
      showToast("Plan workflow saved");
      draw();
    } catch (ex) {
      console.error("Save plan workflow failed:", ex);
      saving = false;
      fail(ex && ex.code === "permission-denied"
        ? "Only Admins can change the plan workflow. Check the plan_settings Firestore rule includes 'workflow'."
        : "Couldn't save. Try again.");
      b.disabled = false;
      b.textContent = "Save workflow";
    }
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled || saving) return;
    const act = b.dataset.act;
    const row = b.closest(".pw-phase");
    const i = row ? Number(row.dataset.i) : -1;

    if (act === "add") {
      wf.phases.push({ id: newPhaseId(), name: `Priority ${wf.phases.length + 1}`, note: "", colour: "#888780", tracked: false });
      touch(); draw(); return;
    }
    if (act === "up" || act === "down") {
      const j = act === "up" ? i - 1 : i + 1;
      [wf.phases[i], wf.phases[j]] = [wf.phases[j], wf.phases[i]];
      touch(); draw(); return;
    }
    if (act === "remove") {
      const p = wf.phases[i];
      const to = wf.phases[i - 1] || wf.phases[i + 1];
      if (!(await confirmDialog({
        title: `Remove ${p.name || "this priority"}?`,
        message: `Concerns already in it move to ${to.name || "the next priority"}. Nothing else in the plans changes.`,
        confirmLabel: "Remove", tone: "warning",
      }))) return;
      wf.phases.splice(i, 1);
      Object.keys(wf.moved).forEach((k) => { if (wf.moved[k] === p.id) wf.moved[k] = to.id; });
      wf.moved[p.id] = to.id;
      if (wf.newPlanPhase === p.id) wf.newPlanPhase = to.id;
      if (wf.addPhase === p.id) wf.addPhase = to.id;
      touch(); draw(); return;
    }
    if (act === "reset") {
      if (!(await confirmDialog({
        title: "Go back to the defaults?",
        message: "The three standard priorities and the standard rules come back. Concerns in priorities you added move to Priority 1. Nothing is saved until you press Save.",
        confirmLabel: "Use the defaults", tone: "warning",
      }))) return;
      const old = wf;
      wf = cleanWorkflow({});
      wf.moved = { ...old.moved };
      old.phases.forEach((p) => { if (!wf.phases.some((x) => x.id === p.id)) wf.moved[p.id] = wf.phases[0].id; });
      touch(); draw(); return;
    }
    if (act === "save") save();
  });

  draw();
}