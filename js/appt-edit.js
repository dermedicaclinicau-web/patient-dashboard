// Calendar → change a booking from the Day Sheet: a new start time, someone else, cancelled or no-show, a note.
// Saved as a portal change on top of the Day Sheet (manual-appts.js), shown until the next upload from Timely has it.
import { saveApptChange, removeApptChange, minToClock } from "./manual-appts.js";
import { escapeHtml, showToast } from "./utils.js";

const pad = (n) => String(n).padStart(2, "0");
const toHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const fromHHMM = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
const dayLabel = (key) => {
  const [y, m, d] = String(key).split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return isNaN(dt) ? String(key) : dt.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
};

/**
 * dateKey: "2026-11-09"
 * rows: the Day Sheet bookings on one calendar card (one visit). Portal bookings are skipped (they have their own Edit).
 * columns: the clinician / room names on the calendar
 * onSaved: called after a save or undo (reload the day)
 */
export function openApptEdit({ dateKey, rows, columns = [], onSaved } = {}) {
  const list = (rows || []).filter((r) => r && !r.manual);
  if (!list.length) return;
  const orig = (r) => r.orig || r;                         // what the Day Sheet says
  const pc = list[0].portalChange || null;                // a change already saved for this visit
  const changeId = pc ? pc.id : "";
  const fromMins = (pc && !pc.conflict && pc.fromMins && pc.fromMins.length
    ? pc.fromMins : list.map((r) => Number(orig(r).sortMinutes)))
    .filter(Number.isFinite).sort((a, b) => a - b);
  if (!fromMins.length) { showToast("This booking's time couldn't be read."); return; }

  const origStaff = String(orig(list[0]).staff || "");
  const nowStart = Math.min(...list.map((r) => Number(r.sortMinutes)).filter(Number.isFinite));
  const nowStaff = String(list[0].staff || origStaff);
  const curCancel = pc && !pc.conflict ? pc.cancel || "" : "";
  const curNote = pc ? pc.note || "" : "";
  const name = list[0].patientName || "this patient";
  const staffOpts = [...new Set([...columns, origStaff, nowStaff].map((s) => String(s || "").trim()).filter(Boolean))];
  const radio = (value, label) => `<label class="fe-seg-btn"><input type="radio" name="status" value="${value}"${
    (curCancel || "booked") === value ? " checked" : ""} /><span>${label}</span></label>`;

  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog ae-dlg";
  dlg.innerHTML = `
    <form class="lh-form">
      <div class="lh-dialog-head">
        <h3>Change booking</h3>
        <p>${escapeHtml(name)} · ${escapeHtml(dayLabel(dateKey))}</p>
      </div>
      ${pc && pc.conflict ? `<p class="ae-warn">This was changed in the portal to <b>${escapeHtml(pc.toTime)}</b>${
        pc.toStaff && pc.toStaff !== pc.fromStaff ? ` with ${escapeHtml(pc.toStaff)}` : ""}, but Timely now has a different time.
        Save the right one below, or <b>Undo change</b> to go with Timely.</p>` : ""}
      <p class="ae-was">In Timely: <b>${escapeHtml(minToClock(fromMins[0]))} with ${escapeHtml(origStaff)}</b>${
        list.length > 1 ? ` · ${list.length} bookings, moved together` : ""}</p>
      <div class="ae-two">
        <label class="lh-field"><span class="lh-label">Start time</span>
          <input type="time" name="start" class="fe-input" step="300" required value="${toHHMM(nowStart)}" /></label>
        <label class="lh-field"><span class="lh-label">With</span>
          <select name="staff" class="fb-select">${staffOpts.map((s) =>
            `<option value="${escapeHtml(s)}"${s === nowStaff ? " selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select></label>
      </div>
      <div class="ae-quick">
        <button type="button" data-shift="-15">−15 min</button>
        <button type="button" data-shift="15">+15 min</button>
        <button type="button" data-shift="30">+30 min</button>
        <button type="button" data-shift="60">+1 hr</button>
      </div>
      <div class="lh-field"><span class="lh-label">Booking</span>
        <div class="fe-seg">${radio("booked", "Booked")}${radio("cancelled", "Cancelled")}${radio("no-show", "No-show")}</div></div>
      <label class="lh-field"><span class="lh-label">Note <small class="muted">(optional)</small></span>
        <textarea name="note" class="fe-input" rows="2" maxlength="500" placeholder="e.g. Patient called to move it">${escapeHtml(curNote)}</textarea></label>
      <p class="ae-tip">Change it in Timely too. The portal shows this change until the next Day Sheet upload has it.</p>
      <p class="lh-error" role="alert"></p>
      <div class="lh-actions">
        ${changeId ? '<button type="button" class="lh-btn is-quiet ae-undo" data-act="undo">Undo change</button>' : ""}
        <span class="ae-sp"></span>
        <button type="button" class="lh-btn" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());

  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  const saveBtn = dlg.querySelector('[type="submit"]');
  const timeIn = form.elements.start;

  async function run(btn, label, fn) {
    if (btn.disabled) return;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    err.textContent = "";
    try {
      await fn();
      dlg.close();
      if (onSaved) onSaved();
    } catch (e) {
      console.error("Booking change failed:", e);
      err.textContent = e.code === "permission-denied" ? "You don't have permission to change bookings."
        : e.code ? "Couldn't save. Check your connection and try again." : e.message;
      btn.disabled = false;
      btn.textContent = was;
    }
  }
  const undo = (btn) => run(btn, "Undoing…", async () => {
    await removeApptChange(changeId);
    showToast("Back to the Day Sheet booking");
  });

  dlg.addEventListener("click", (e) => {
    const q = e.target.closest("[data-shift]");
    if (q) {
      const cur = fromHHMM(timeIn.value);
      if (cur !== null) timeIn.value = toHHMM(Math.max(0, Math.min(1435, cur + Number(q.dataset.shift))));
      return;
    }
    if (e.target.closest('[data-act="cancel"]')) { dlg.close(); return; }
    const u = e.target.closest('[data-act="undo"]');
    if (u) undo(u);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const toMin = fromHHMM(timeIn.value);
    const toStaff = form.elements.staff.value;
    const status = form.elements.status.value;
    const cancel = status === "booked" ? "" : status;
    const note = form.elements.note.value.trim();
    if (toMin === null) { err.textContent = "Choose the start time."; return; }
    // Back to exactly what the Day Sheet says: nothing to keep
    if (toMin === fromMins[0] && toStaff === origStaff && !cancel && !note) {
      if (changeId) undo(saveBtn); else dlg.close();
      return;
    }
    run(saveBtn, "Saving…", async () => {
      await saveApptChange({
        dateKey, patientId: list[0].patientId || "", patientName: list[0].patientName || "",
        staff: origStaff, fromMins, toMin, toStaff, cancel, note,
      }, changeId);
      showToast(cancel ? `Marked as ${cancel === "no-show" ? "a no-show" : "cancelled"}. Do the same in Timely.`
        : "Saved. Change it in Timely too.");
    });
  });

  dlg.showModal();
  timeIn.focus();
}

// For a calendar card: " is-changed", " is-conflict" or ""
export function changeClass(rows) {
  const c = (rows || []).map((r) => r && r.portalChange).find(Boolean);
  return !c ? "" : c.conflict ? " is-conflict" : " is-changed";
}

// The tags (and note) on a calendar card changed in the portal. "" when there's nothing to show.
export function changeTagsHtml(rows) {
  const c = (rows || []).map((r) => r && r.portalChange).find(Boolean);
  if (!c) return "";
  const who = c.by ? ` by ${c.by}` : "";
  if (c.conflict) {
    return `<div class="ae-tags"><span class="ae-tag is-bad" title="${escapeHtml(`Changed in the portal${who} to ${c.toTime}, but the Day Sheet now has a different time`)}">Timely differs · portal said ${escapeHtml(c.toTime)}</span></div>`;
  }
  const moved = [c.toTime !== c.fromTime && c.fromTime, c.toStaff !== c.fromStaff && c.fromStaff].filter(Boolean);
  const tags = [
    c.cancel && `<span class="ae-tag is-bad">${c.cancel === "no-show" ? "No-show" : "Cancelled"} in portal</span>`,
    moved.length && `<span class="ae-tag" title="${escapeHtml(`Changed in the portal${who}`)}">Moved from ${escapeHtml(moved.join(" · "))}</span>`,
    c.pending && '<span class="ae-tag is-warn" title="The Day Sheet was uploaded after this change and still has the old booking">Not changed in Timely yet</span>',
  ].filter(Boolean).join("");
  return (tags ? `<div class="ae-tags">${tags}</div>` : "") + (c.note ? `<span class="appt-note">${escapeHtml(c.note)}</span>` : "");
}