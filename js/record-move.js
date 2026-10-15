// Moving a record to another patient (it was saved to the wrong one). Done by Apps Script,
// so records stay locked against normal editing and every move is kept.
// Portal forms: { sub }. Older imported records (a row + a Drive PDF): { legacy }.
import { callApi } from "./appointments.js";
import { can } from "./perms.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : (key || "");
};
const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};
const REASONS = [["wrong", "Saved to the wrong patient"], ["duplicate", "Duplicate patient record"], ["other", "Other"]];

export const canMoveRecords = () => can("records.move");

function moveError(err) {
  switch (err && err.code) {
    case "UNAUTHORIZED": return "Your session has expired. Log out and back in, then try again.";
    case "FORBIDDEN": return "You don't have access to move records. Ask an admin.";
    case "NOT_FOUND": return "This record couldn't be found. It may have been moved already.";
    case "NO_PATIENT": return "That patient couldn't be found. Search again.";
    case "SAME_PATIENT": return "It's already on that patient's record.";
    case "MERGED": return "That patient record was merged into another. Choose the record it was merged into.";
    case "NO_REASON": return "Choose a reason.";
    case "NO_NOTE": return "Add a note explaining the reason.";
    case "BUSY": return "Someone else is moving a record right now. Try again in a moment.";
    case "INVALID_PIN": case "BAD_REQUEST": return "The server hasn't been updated yet. In Apps Script, deploy a new version.";
    default: return err && err.message && !err.code ? err.message : `Couldn't move it${err && err.code ? ` (${err.code})` : ""}. Try again.`;
  }
}

// The history shown on a saved form
export function movesHtml(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return `<ul class="ff-log rm-log">${list.slice().reverse().map((m) => `
    <li>Moved from <strong>${esc(m.fromName || "another patient")}</strong> to <strong>${esc(m.toName || "")}</strong>
      by ${esc(m.by || "staff")}, ${esc(when(m.at))}${m.reasonText ? ` · ${esc(m.reasonText)}` : ""}${m.note ? `: ${esc(m.note)}` : ""}</li>`).join("")}
  </ul>`;
}

// Warnings for a portal form
function formChecks(c, sub) {
  const items = [];
  const sent = (sub.deliveries || []).length;
  if (sent) items.push(`It has been <strong>emailed or printed ${sent} time${sent === 1 ? "" : "s"}</strong>. Those copies have ${esc(sub.patientName)}'s details on them.`);
  if (c.dependents && c.dependents.length) items.push(`<strong>${c.dependents.length} other form${c.dependents.length === 1 ? "" : "s"}</strong> of ${esc(sub.patientName)} used it as their consent: ${
    c.dependents.map((d) => `${esc(d.name)} (${esc(niceDate(d.date))})`).join(", ")}. They won't be changed.`);
  if (c.consentChecks) items.push("Its consent check found a consent on the <strong>old patient's</strong> record. That result is kept as it was.");
  if (c.textMention) items.push(`Answers typed on the form mention <strong>${esc(sub.patientName)}</strong>. Saved forms can't be edited, so those stay. If that matters, fill in a new form instead.`);
  if (c.photos) items.push(`${c.photos} photo${c.photos === 1 ? "" : "s"} stay with the record.`);
  if (c.usage) items.push("The products used move with it.");
  return items;
}

// Warnings for an older record (a finished PDF)
function legacyChecks(c, sub, legacy) {
  const items = [];
  const old = esc(sub.patientName);
  if (c.fileFound) {
    items.push(`The PDF shows <strong>${old}</strong>'s name and details. A finished PDF can't be changed, so it will still show them.`);
    items.push(c.canRename
      ? `The file in Google Drive (<strong>${esc(c.fileName)}</strong>) will be renamed for the new patient.`
      : `The portal can't rename the file in Google Drive (<strong>${esc(c.fileName)}</strong>) because it doesn't have edit access. It will keep its name.`);
  } else if (c.hasLink) {
    items.push(`The PDF couldn't be opened from the portal's Google account, so it won't be renamed. It still shows ${old}'s details.`);
  } else {
    items.push("There's no PDF attached to this record.");
  }
  if (legacy.kind === "consent") items.push("Moving a consent changes the <strong>Consent on file</strong> badges on both patients' treatment records.");
  if (legacy.matchedByName) items.push(`This record was matched to ${old} <strong>by name only</strong>. After the move it's linked to the chosen patient by ID.`);
  if (c.moves) items.push(`It has been moved ${c.moves} time${c.moves === 1 ? "" : "s"} before.`);
  return items;
}

// Resolves with the result once moved, or null if cancelled
export async function openMoveRecordDialog({ sub: subIn = null, legacy = null } = {}) {
  const { searchPatients } = await import("./task-runner.js"); // loaded here, so pages don't import each other in a loop
  // An older record looks like a saved form to the dialog
  const sub = legacy ? {
    id: legacy.id, templateName: legacy.title, recordDate: legacy.dateText,
    patientName: legacy.patientName, patientId: legacy.patientId, deliveries: [],
  } : subIn;
  const noun = legacy ? "record" : "form";

  return new Promise((resolve) => {
    let result = null, target = null, busy = false, seq = 0, timer = null, results = [];
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog rm-dialog";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head">
          <h3>Move to another patient</h3>
          <p><strong>${esc(sub.templateName)}</strong> · ${esc(niceDate(sub.recordDate))}${legacy ? " · older record (PDF)" : ""}<br>
            Now on <strong>${esc(sub.patientName)}</strong>'s record.</p>
        </div>
        <div class="rm-checks" data-role="checks"><p class="muted">Checking what's linked to this record…</p></div>
        <div class="lh-field"><span class="lh-label">Move it to</span><div data-role="pick"></div></div>
        <label class="lh-field"><span class="lh-label">Reason</span>
          <select class="fb-select" data-k="reason">${REASONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Note <small data-role="note-req">(optional)</small></span>
          <textarea class="fe-input" data-k="note" rows="2" maxlength="500" placeholder="e.g. Two patients with the same name booked at 10 am"></textarea></label>
        <label class="fe-check rm-sure"><input type="checkbox" data-k="sure" /> <span data-role="sure-text">I've checked this is the right patient</span></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary" data-role="go" disabled>Move record</button>
        </div>
      </form>`;
    const $ = (s) => dlg.querySelector(s);
    const form = $("form");
    const pick = $('[data-role="pick"]');
    const errEl = $(".lh-error");
    const goBtn = $('[data-role="go"]');
    const showErr = (m) => { errEl.textContent = m || ""; errEl.hidden = !m; };

    const sync = () => {
      const sure = $('[data-k="sure"]');
      $('[data-role="sure-text"]').textContent = target
        ? `I've checked: this ${noun} belongs to ${target.name}, not ${sub.patientName}`
        : "I've checked this is the right patient";
      $('[data-role="note-req"]').textContent = $('[data-k="reason"]').value === "other" ? "(required)" : "(optional)";
      goBtn.disabled = busy || !target || !sure.checked;
    };

    const renderPick = () => {
      pick.innerHTML = target
        ? `<div class="rm-chosen"><span><strong>${esc(target.name)}</strong><small>${esc([target.dob && `DOB ${target.dob}`, target.email || "No email on file"].filter(Boolean).join(" · "))}</small></span>
            <button type="button" class="lh-btn is-quiet" data-act="change">Change</button></div>`
        : `<input class="fe-input" type="search" data-role="q" placeholder="Search for the right patient by name" autocomplete="off" spellcheck="false" />
           <div class="rm-results" data-role="results"></div>`;
      $('[data-k="sure"]').checked = false;
      sync();
      const q = $('[data-role="q"]');
      if (q) q.focus();
    };

    const search = (q) => {
      clearTimeout(timer);
      const box = $('[data-role="results"]');
      if (!box) return;
      if (q.trim().length < 2) { box.innerHTML = q.trim() ? '<p class="muted">Type at least 2 letters</p>' : ""; return; }
      box.innerHTML = '<p class="muted">Searching…</p>';
      const mine = ++seq;
      timer = setTimeout(async () => {
        try { results = (await searchPatients(q)).filter((r) => r.id !== sub.patientId); }
        catch (err) { console.warn("Patient search failed:", err); if (mine === seq && box.isConnected) box.innerHTML = '<p class="tb-bad">Couldn\'t search. Check your connection.</p>'; return; }
        if (mine !== seq || !box.isConnected) return;
        box.innerHTML = results.length ? results.map((r, i) => `
          <button type="button" class="rm-result" data-pick="${i}"><strong>${esc(r.name)}</strong>
            <small>${esc([r.dob && `DOB ${r.dob}`, r.email || "No email on file"].filter(Boolean).join(" · "))}</small></button>`).join("")
          : '<p class="muted">No other patients found. Try their last name.</p>';
      }, 250);
    };

    // What's linked to it, before moving
    const checks = $('[data-role="checks"]');
    callApi(legacy
      ? { action: "records", op: "legacyCheck", kind: legacy.kind, recordId: legacy.id }
      : { action: "records", op: "moveCheck", submissionId: sub.id })
      .then((c) => {
        if (!dlg.isConnected) return;
        const items = legacy ? legacyChecks(c, sub, legacy) : formChecks(c, sub);
        checks.innerHTML = items.length
          ? `<p class="rm-checks-h">Before you move it</p><ul>${items.map((t) => `<li>${t}</li>`).join("")}</ul>`
          : '<p class="muted">Nothing else is linked to this record.</p>';
      })
      .catch((err) => {
        console.warn("Move check failed:", err);
        if (!dlg.isConnected) return;
        if (err && ["FORBIDDEN", "INVALID_PIN", "BAD_REQUEST"].includes(err.code)) {
          checks.innerHTML = `<p class="tb-bad">${esc(moveError(err))}</p>`;
          busy = true;
          sync();
        } else {
          checks.innerHTML = '<p class="muted">Couldn\'t check what\'s linked to this record. You can still move it.</p>';
        }
      });

    dlg.addEventListener("input", (e) => {
      if (e.target.matches('[data-role="q"]')) search(e.target.value);
      else sync();
    });
    dlg.addEventListener("change", sync);
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]')) { if (!busy || result) dlg.close(); return; }
      if (e.target.closest('[data-act="change"]')) { target = null; renderPick(); return; }
      const p = e.target.closest("[data-pick]");
      if (p) { target = results[Number(p.dataset.pick)] || null; renderPick(); }
    });
    dlg.addEventListener("cancel", (e) => { if (busy && !result) e.preventDefault(); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy || !target) return;
      const reason = $('[data-k="reason"]').value;
      const note = $('[data-k="note"]').value.trim();
      if (reason === "other" && !note) { showErr("Add a note explaining the reason."); return; }
      busy = true;
      sync();
      goBtn.textContent = "Moving…";
      showErr("");
      try {
        result = await callApi(legacy
          ? { action: "records", op: "moveLegacy", kind: legacy.kind, recordId: legacy.id,
              fromPatientId: legacy.patientId, toPatientId: target.id, reason, note }
          : { action: "records", op: "moveSubmission", submissionId: sub.id, toPatientId: target.id, reason, note });

        const after = [];
        if (legacy) {
          if (result.file === "renamed") after.push(`The PDF in Google Drive was renamed to <strong>${esc(result.fileName)}</strong>.`);
          else if (result.file === "failed") after.push("The PDF in Google Drive couldn't be renamed. Rename it by hand if needed.");
          if (result.file !== "none") after.push(`The PDF itself still shows ${esc(sub.patientName)}'s details.`);
        } else {
          if (result.deliveries) after.push(`It was emailed or printed while on ${esc(sub.patientName)}'s record. Consider letting the clinic manager know, in case those copies need following up.`);
          if (result.dependents && result.dependents.length) after.push(`Check ${esc(sub.patientName)}'s ${result.dependents.map((d) => esc(d.name)).join(", ")}: their consent check pointed to this form.`);
          if (result.textMention) after.push(`Typed answers still mention ${esc(sub.patientName)}.`);
        }
        form.innerHTML = `
          <div class="lh-dialog-head"><h3>Moved</h3>
            <p><strong>${esc(sub.templateName)}</strong> is now on <strong>${esc(target.name)}</strong>'s record. The move is kept on the record.</p></div>
          ${after.length ? `<div class="rm-checks"><p class="rm-checks-h">Follow up</p><ul>${after.map((t) => `<li>${t}</li>`).join("")}</ul></div>` : ""}
          <div class="lh-actions"><button type="button" class="lh-btn is-primary" data-act="cancel">Done</button></div>`;
      } catch (err) {
        console.error("Move record failed:", err);
        busy = false;
        goBtn.textContent = "Move record";
        showErr(moveError(err));
        sync();
      }
    });

    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    dlg.showModal();
    renderPick();
  });
}