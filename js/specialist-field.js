// Referral specialist on a form: choose from the Specialist Bank, add a new one, or correct details.
// The saved form keeps a copy of the details, so later changes never alter a letter already saved.
import { listSpecialists, saveSpecialist, cleanSpecialist, specialitiesOf, findDuplicate, invalidateSpecialists } from "./specialists-api.js";
import { esc, specialistBlockHtml } from "./form-fields.js";
import { showToast } from "./utils.js";

const keyOf = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const snap = (s) => ({
  id: s.id || "", name: s.name || "", speciality: s.speciality || "", practice: s.practice || "",
  phone: s.phone || "", email: s.email || "", address: s.address || "",
});
const errText = (err) => (err && err.code === "permission-denied"
  ? "Couldn't save. Check the specialists Firestore rule has been published."
  : err && err.message && !err.code ? err.message : "Couldn't save. Try again.");

/* ---------- Add / edit window (also used by the Specialist Bank page) ---------- */

// Resolves with the saved specialist, or null if cancelled
export function openSpecialistDialog({ specialist = null, list = [], staff = null, speciality = "" } = {}) {
  return new Promise((resolve) => {
    let out = null, busy = false;
    const x = specialist || { speciality };
    const dl = `sp-specs-${Date.now()}`;
    const v = (k) => esc(x[k] || "");
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog sp-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${specialist ? `Edit ${esc(specialist.name)}` : "New specialist"}</h3>
          <p>${specialist
            ? "Saved to the Specialist Bank for everyone. Letters already saved keep the details they had."
            : "Saved to the Specialist Bank, so everyone can choose them next time."}</p></div>
        <label class="lh-field"><span class="lh-label">Name</span>
          <input name="name" maxlength="120" placeholder="e.g. Dr Jane Smith" value="${v("name")}" autocomplete="off" /></label>
        <div class="sp-two">
          <label class="lh-field"><span class="lh-label">Speciality</span>
            <input name="speciality" maxlength="80" list="${dl}" placeholder="e.g. Dermatologist" value="${v("speciality")}" autocomplete="off" />
            <datalist id="${dl}">${specialitiesOf(list).map((s) => `<option value="${esc(s)}"></option>`).join("")}</datalist></label>
          <label class="lh-field"><span class="lh-label">Practice or clinic (optional)</span>
            <input name="practice" maxlength="150" value="${v("practice")}" autocomplete="off" /></label>
        </div>
        <div class="sp-two">
          <label class="lh-field"><span class="lh-label">Phone</span>
            <input name="phone" type="tel" maxlength="40" value="${v("phone")}" autocomplete="off" /></label>
          <label class="lh-field"><span class="lh-label">Email</span>
            <input name="email" type="email" maxlength="254" value="${v("email")}" autocomplete="off" /></label>
        </div>
        <label class="lh-field"><span class="lh-label">Address</span>
          <textarea name="address" rows="2" maxlength="300">${v("address")}</textarea></label>
        <label class="lh-field"><span class="lh-label">Notes for staff (optional, never printed)</span>
          <textarea name="notes" rows="2" maxlength="1000" placeholder="e.g. Prefers referrals by email">${v("notes")}</textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${specialist ? "Save changes" : "Add specialist"}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const f = form.elements;
      const data = { name: f.name.value, speciality: f.speciality.value, practice: f.practice.value,
        phone: f.phone.value, email: f.email.value, address: f.address.value, notes: f.notes.value };
      const dup = findDuplicate(list, data, specialist ? specialist.id : "");
      if (dup) {
        fail(`${dup.name}${dup.speciality ? ` (${dup.speciality})` : ""} is already in the Specialist Bank${
          dup.active === false ? ", archived" : ""}. Choose them from the list instead.`);
        return;
      }
      busy = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        const id = await saveSpecialist(specialist ? specialist.id : "", data, staff);
        out = { id, ...cleanSpecialist(data), active: true };
        busy = false;
        dlg.close();
      } catch (ex) {
        console.error("Save specialist failed:", ex);
        busy = false;
        btn.disabled = false;
        fail(errText(ex));
      }
    });
    dlg.showModal();
    form.elements.name.focus();
  });
}

/* ---------- The field ---------- */

// saved given (even null): show a saved form. Otherwise: the live picker.
export function mountSpecialistField(w, f, { staff = null, saved, onChange = () => {} } = {}) {
  const host = w && w.querySelector("[data-sp-host]");
  if (!host) return;
  if (saved !== undefined) {
    host.outerHTML = saved && saved.name
      ? `<div class="sp-card">${specialistBlockHtml(f, saved)}</div>`
      : '<p class="fe-help">No specialist chosen.</p>';
    return;
  }

  let list = [], chosen = null, loaded = false, failed = false, q = "";
  let all = !f.speciality;
  const pool = () => list.filter((s) => all || keyOf(s.speciality) === keyOf(f.speciality));

  function optionsHtml() {
    const qq = q.trim().toLowerCase();
    const rows = pool().filter((s) => !qq || `${s.name} ${s.speciality} ${s.practice}`.toLowerCase().includes(qq));
    const groups = new Map();
    rows.forEach((s) => { const g = s.speciality || "Other"; groups.set(g, [...(groups.get(g) || []), s]); });
    const opt = (s) => `<option value="${esc(s.id)}"${chosen && chosen.id === s.id ? " selected" : ""}>${esc(s.name)}${
      s.practice ? ` · ${esc(s.practice)}` : ""}</option>`;
    const keep = chosen && !rows.some((s) => s.id === chosen.id)
      ? `<option value="${esc(chosen.id || "__chosen")}" selected>${esc(chosen.name)}</option>` : "";
    return `<option value="">${pool().length ? (rows.length ? "Choose a specialist" : "No specialists match") : "No specialists yet"}</option>${keep}${
      [...groups].sort(([a], [b]) => a.localeCompare(b, "en-AU"))
        .map(([g, l]) => `<optgroup label="${esc(g)}">${l.map(opt).join("")}</optgroup>`).join("")}`;
  }

  const actsHtml = () =>
    (f.allowAdd !== false ? '<button type="button" class="lh-btn" data-sp="add">+ Add new specialist</button>' : "") +
    (chosen && chosen.id && f.allowEdit !== false ? '<button type="button" class="lh-btn is-quiet" data-sp="edit">Edit details</button>' : "");
  const outHtml = () => (chosen ? `<div class="sp-card">${specialistBlockHtml(f, chosen)}</div>` : "");

  function draw() {
    if (!loaded) { host.innerHTML = '<p class="fe-help">Loading specialists…</p>'; return; }
    host.innerHTML = `
      <div class="sp-pick">
        ${list.length > 8 ? `<input type="search" class="fe-in" data-sp="find" placeholder="Search name, practice or speciality" value="${esc(q)}" aria-label="Search specialists" />` : ""}
        <select class="fe-in" data-sp="pick" aria-label="Specialist">${optionsHtml()}</select>
        ${f.speciality ? `<label class="fe-check sp-all"><input type="checkbox" data-sp="all"${all ? " checked" : ""} /> Show every speciality, not just ${esc(f.speciality)}</label>` : ""}
        <div class="sp-acts" data-sp-acts>${actsHtml()}</div>
      </div>
      ${failed ? '<p class="fe-help">Couldn\'t load the Specialist Bank. Check your connection and reload.</p>' : ""}
      <div data-sp-out>${outHtml()}</div>`;
  }
  // Only the buttons and the details card (the dropdown stays put while it's being used)
  function drawOut() {
    const a = host.querySelector("[data-sp-acts]");
    const o = host.querySelector("[data-sp-out]");
    if (!a || !o) { draw(); return; }
    a.innerHTML = actsHtml();
    o.innerHTML = outHtml();
  }

  const changed = () => {
    onChange();
    draw();
    host.dispatchEvent(new Event("input", { bubbles: true })); // the form re-checks required answers and conditions
  };
  const reload = async () => {
    invalidateSpecialists();
    list = await listSpecialists({ force: true }).catch(() => list);
  };

  host.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.sp === "find") {
      q = t.value;
      const sel = host.querySelector('[data-sp="pick"]');
      if (sel) sel.innerHTML = optionsHtml();
    } else if (t.dataset.sp === "pick") {
      const s = list.find((x) => x.id === t.value);
      if (s) chosen = snap(s);
      else if (!t.value) chosen = null;
      onChange();
      drawOut();
    } else if (t.dataset.sp === "all") {
      all = t.checked;
      draw();
    }
  });

  host.addEventListener("click", async (e) => {
    const b = e.target.closest('button[data-sp]');
    if (!b) return;
    if (b.dataset.sp === "add") {
      const s = await openSpecialistDialog({ list: await listSpecialists({ includeInactive: true }).catch(() => list), staff, speciality: f.speciality || "" });
      if (!s) return;
      await reload();
      chosen = snap(s);
      if (f.speciality && keyOf(s.speciality) !== keyOf(f.speciality)) all = true;
      changed();
      showToast(`${s.name} added to the Specialist Bank`);
    } else if (b.dataset.sp === "edit" && chosen) {
      const cur = list.find((x) => x.id === chosen.id);
      if (!cur) { showToast("This specialist isn't in the Specialist Bank any more."); return; }
      const s = await openSpecialistDialog({ specialist: cur, list: await listSpecialists({ includeInactive: true }).catch(() => list), staff });
      if (!s) return;
      await reload();
      chosen = snap({ ...s, id: cur.id });
      changed();
      showToast("Details updated in the Specialist Bank");
    }
  });

  w.spRead = () => (chosen ? { ...chosen } : "");
  w.spWrite = (v) => { chosen = v && typeof v === "object" && v.name ? snap(v) : null; draw(); };

  draw();
  listSpecialists()
    .then((l) => { list = l; })
    .catch((err) => { console.warn("Specialist Bank not loaded:", err); failed = true; })
    .finally(() => { loaded = true; if (host.isConnected) draw(); });
}