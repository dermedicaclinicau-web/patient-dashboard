// Calendar → Add booking: a last-minute booking, shown until the next Day Sheet upload has it
import { searchPatients, warmPatients } from "./patient-list.js";
import { saveManualAppt } from "./manual-appts.js";
import { escapeHtml as esc, formatMobile, formatDobLong } from "./utils.js";

const pad = (n) => String(n).padStart(2, "0");
const lenText = (n) => (n < 60 ? `${n} min` : `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ""}`);

function defaultStart(dateKey) {
  const d = new Date();
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (dateKey !== today) return "09:00";
  const m = Math.min(Math.ceil((d.getHours() * 60 + d.getMinutes()) / 15) * 15, 23 * 60 + 45);   // the next quarter hour
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

async function searchPts(term) {
  const t = term.trim();
  const digits = t.replace(/\D/g, "");
  let list;
  if (digits.length >= 3 && digits.length >= t.replace(/[\s+()-]/g, "").length) list = await searchPatientsByPhone(t);
  else if (t.includes("@")) list = (await fetchPatients({ mode: "email", term: t })).patients;
  else list = (await fetchPatients({ mode: "name", term: t })).patients;
  return list.filter((p) => !p.mergedInto).slice(0, 8);
}

// Resolves { dateKey } once saved, or null
export function openBookingDialog({ dateKey, staffNames = [], services = [], defaultStaff = "", existing = null }) {
  return new Promise((resolve) => {
    let result = null, saving = false, seq = 0, timer = 0, found = [];
    let chosen = existing ? { id: existing.patientId || "", name: existing.patientName, isNew: !existing.patientId, meta: "" } : null;
    const lens = [...new Set([15, 30, 45, 60, 75, 90, 120, 150, 180, ...(existing ? [existing.durationMin] : [])])].sort((a, b) => a - b);
    const curLen = (existing && existing.durationMin) || 30;
    const opts = (list) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b))
      .map((s) => `<option value="${esc(s)}"></option>`).join("");

    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog bk-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${existing ? "Edit booking" : "Add a booking"}</h3>
          <p>Shows on the calendar until the next Day Sheet upload has it. Remember to book it in Timely too.</p></div>
        <div class="lh-field"><span class="lh-label">Patient</span><div data-role="pt"></div></div>
        <label class="lh-field"><span class="lh-label">With</span>
          <input name="staff" list="bk-staff" maxlength="80" autocomplete="off" placeholder="As in the appointment book, e.g. Dr Teh"
            value="${esc(existing ? existing.staff : defaultStaff)}" />
          <datalist id="bk-staff">${opts(staffNames)}</datalist></label>
        <div class="bk-row">
          <label class="lh-field"><span class="lh-label">Date</span>
            <input type="date" name="date" value="${esc(existing ? existing.dateKey : dateKey)}" /></label>
          <label class="lh-field"><span class="lh-label">Start</span>
            <input type="time" name="start" step="300" value="${esc(existing ? existing.start : defaultStart(dateKey))}" /></label>
          <label class="lh-field"><span class="lh-label">Length</span>
            <select class="fb-select" name="len">${lens.map((n) => `<option value="${n}"${n === curLen ? " selected" : ""}>${lenText(n)}</option>`).join("")}</select></label>
        </div>
        <label class="lh-field"><span class="lh-label">Services</span>
          <input name="services" list="bk-svc" maxlength="300" autocomplete="off" placeholder="Separate several with commas"
            value="${esc(existing ? (existing.services || []).join(", ") : "")}" />
          <datalist id="bk-svc">${opts(services)}</datalist></label>
        <label class="lh-field"><span class="lh-label">Note (optional)</span>
          <textarea class="fe-input" name="note" rows="2" maxlength="500">${esc(existing ? existing.note || "" : "")}</textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${existing ? "Save" : "Add booking"}</button>
        </div>
      </form>`;

    const form = dlg.querySelector("form");
    const ptHost = dlg.querySelector('[data-role="pt"]');
    const err = dlg.querySelector(".lh-error");
    const btn = form.querySelector('[type="submit"]');
    const fail = (m, el) => { err.textContent = m; err.hidden = false; if (el) el.focus(); };

    function drawPt() {
      if (chosen && !chosen.isNew) {
        ptHost.innerHTML = `<div class="bk-chosen"><span><strong>${esc(chosen.name)}</strong>${chosen.meta ? `<small>${esc(chosen.meta)}</small>` : ""}</span>
          <button type="button" class="lh-btn is-quiet" data-act="pt-change">Change</button></div>`;
      } else if (chosen && chosen.isNew) {
        ptHost.innerHTML = `<input class="fe-input" data-role="newname" maxlength="120" placeholder="Their full name" value="${esc(chosen.name)}" />
          <small class="fe-note">Not linked to a patient record yet. Add them to the Patient List when you can.
            <button type="button" class="rc-link" data-act="pt-change">Search instead</button></small>`;
      } else {
        ptHost.innerHTML = `<input class="fe-input" type="search" data-role="q" placeholder="Search by name or mobile" autocomplete="off" />
          <div class="bk-results" data-role="results"></div>
          <button type="button" class="rc-link" data-act="pt-new">New patient, not in the Patient List yet</button>`;
      }
    }
    function drawResults(msg) {
      const box = dlg.querySelector('[data-role="results"]');
      if (!box) return;
      box.innerHTML = msg ? `<p class="bk-none">${esc(msg)}</p>` : found.map((p, i) => `
        <button type="button" class="bk-res" data-pick="${i}"><strong>${esc(p.name)}</strong>
          <small>${esc([formatDobLong(p.dobKey), p.mobile && formatMobile(p.mobile), p.pttId].filter(Boolean).join(" · "))}</small></button>`).join("");
    }

    dlg.addEventListener("input", (e) => {
      err.hidden = true;
      if (e.target.dataset.role === "newname") { chosen.name = e.target.value; return; }
      if (e.target.dataset.role !== "q") return;
      clearTimeout(timer);
      const t = e.target.value;
      if (t.trim().length < 2) { found = []; drawResults(""); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        drawResults("Searching…");
        try {
          const r = await searchPts(t);
          if (my !== seq) return;
          found = r;
          drawResults(r.length ? "" : "No patients match. Check the spelling, or add them as a new patient.");
        } catch (ex) {
          if (my !== seq) return;
          console.warn("Patient search failed:", ex);
          drawResults("Couldn't search. Try again.");
        }
      }, 250);
    });

    dlg.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        const p = found[Number(pick.dataset.pick)];
        chosen = { id: p.pttId || p.id, name: p.name, isNew: false,
          meta: [formatDobLong(p.dobKey), p.mobile && formatMobile(p.mobile)].filter(Boolean).join(" · ") };
        drawPt();
        form.elements.staff.focus();
        return;
      }
      if (e.target.closest('[data-act="pt-change"]')) {
        chosen = null; found = []; drawPt();
        dlg.querySelector('[data-role="q"]').focus();
        return;
      }
      if (e.target.closest('[data-act="pt-new"]')) {
        const q = dlg.querySelector('[data-role="q"]');
        chosen = { id: "", name: q ? q.value.trim() : "", isNew: true, meta: "" };
        drawPt();
        dlg.querySelector('[data-role="newname"]').focus();
        return;
      }
      if (e.target.closest('[data-act="cancel"]') && !saving) dlg.close();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (saving) return;
      const f = form.elements;
      if (!chosen || !String(chosen.name || "").trim()) {
        return fail("Choose the patient, or add them as a new patient.", dlg.querySelector('[data-role="q"], [data-role="newname"]'));
      }
      if (!f.staff.value.trim()) return fail("Who is it with?", f.staff);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date.value)) return fail("Choose the date.", f.date);
      if (!/^\d{2}:\d{2}$/.test(f.start.value)) return fail("Choose the start time.", f.start);
      saving = true;
      btn.disabled = true;
      btn.textContent = "Saving…";
      err.hidden = true;
      try {
        await saveManualAppt({
          dateKey: f.date.value, staff: f.staff.value,
          patientId: chosen.isNew ? "" : chosen.id, patientName: chosen.name,
          start: f.start.value, durationMin: Number(f.len.value),
          services: f.services.value.split(","), note: f.note.value,
        }, existing ? existing.manualId : "");
        result = { dateKey: f.date.value };
        saving = false;
        dlg.close();
      } catch (ex) {
        console.error("Booking save failed:", ex);
        saving = false;
        btn.disabled = false;
        btn.textContent = existing ? "Save" : "Add booking";
        fail(ex && ex.code === "permission-denied"
          ? "Not allowed. Check you have the “Add bookings” access, and that the manual_appts Firestore rule is published."
          : ex && ex.message && !ex.code ? ex.message : "Couldn't save. Check your connection and try again.");
      }
    });

    dlg.addEventListener("cancel", (e) => { if (saving) e.preventDefault(); });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    drawPt();
    dlg.showModal();
    warmPatients();   // the list loads while they start typing
    const first = dlg.querySelector('[data-role="q"]') || form.elements.staff;
    if (first) first.focus();
  });
}