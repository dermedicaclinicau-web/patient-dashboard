// Staff (Admins only): add staff, edit, roles, reset PINs, turn access on or off, activity log.
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast, escapeHtml as esc, getInitials, hueFromString } from "./utils.js";

const api = (op, extra = {}) => callApi({ action: "staff", op, ...extra });
const ERR = {
  LAST_ADMIN: "There must always be at least one active Admin.",
  SELF: "You can't turn off your own account.",
  PIN_TAKEN: "Another staff member already uses that PIN. Choose a different one.",
  BAD_PIN: "PINs are 4 to 8 digits.",
  BAD_NAME: "Enter the staff member's name.",
  BAD_EMAIL: "Check the email address.",
  BAD_PHOTO: "The photo must be a web address starting with https://",
  BAD_ROLE: "Choose a role.",
  FORBIDDEN: "Only Admins can manage staff.",
  NOT_FOUND: "That staff member couldn't be found. Refresh and try again.",
  INVALID_PIN: "The server hasn't been updated yet. In Apps Script, deploy a new version.",
  UNAUTHORIZED: "Your session has ended. Log out and back in.",
};
const errText = (err) => ERR[err && err.code] ||
  (err && err.code ? `Something went wrong (${err.code}). Check Apps Script → Executions.` : (err && err.message) || "Something went wrong.");
const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
};
const ROLE_NOTE = {
  Admin: "Everything, including Staff.",
  Clinician: "Patients, Calendar, Task Manager, consultations, Skin Scripts and forms.",
  Reception: "Patients, Calendar, Task Manager, forms, email and print.",
};

export function mountStaffManager(container, { staff: me = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <div class="fb-head">
      <div><h2>Staff</h2><p class="muted">Add staff, set their role, reset PINs and turn access on or off.</p></div>
      <div class="fb-head-actions"><button type="button" class="btn-primary" data-act="add">+ Add staff</button></div>
    </div>
    <div data-role="lock"></div>
    <div class="st-bar">
      <div class="pt-tabs" role="tablist">
        <button type="button" data-tab="staff" class="active">Staff</button>
        <button type="button" data-tab="audit">Activity</button>
      </div>
      <div class="st-tools" data-role="tools">
        <input type="search" class="fe-input st-search" data-role="q" placeholder="Search staff…" aria-label="Search staff" />
        <select class="fb-select st-filter" data-role="role" aria-label="Role"><option value="">All roles</option></select>
        <label class="fe-check"><input type="checkbox" data-role="inactive" /> Show turned-off staff</label>
      </div>
    </div>
    <div data-role="body"><div class="skeleton" style="height:240px;border-radius:14px"></div></div>`;
  container.replaceChildren(root);
  const $ = (s) => root.querySelector(s);
  const body = $('[data-role="body"]');
  let list = [];
  let roles = ["Admin", "Clinician", "Reception"];
  let tab = "staff";

  function renderLock(locked) {
    $('[data-role="lock"]').innerHTML = locked
      ? `<div class="st-lock"><span><strong>Logins are locked</strong> after too many wrong PINs. They unlock on their own within 15 minutes.</span>
          <button type="button" class="lh-btn is-primary" data-act="unlock">Unlock now</button></div>` : "";
  }

  function renderStaff() {
    const q = $('[data-role="q"]').value.trim().toLowerCase();
    const r = $('[data-role="role"]').value;
    const showOff = $('[data-role="inactive"]').checked;
    const rows = list.filter((s) => (showOff || s.active) && (!r || s.role === r) &&
      (!q || `${s.name} ${s.email} ${s.role}`.toLowerCase().includes(q)));
    const off = list.filter((s) => !s.active).length;
    body.innerHTML = rows.length ? `<div class="st-list">${rows.map((s) => `
      <div class="st-row${s.active ? "" : " is-off"}">
        <span class="st-avatar" style="--h:${hueFromString(s.name)}">${s.photo
          ? `<img src="${esc(s.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}<b>${esc(getInitials(s.name))}</b></span>
        <div class="st-main">
          <strong>${esc(s.name || "Unnamed")}${me && me.uid === s.id ? ' <em class="st-you">You</em>' : ""}</strong>
          <small>${esc(s.email || "No email")} · ${s.lastLogin ? `Last login ${esc(when(s.lastLogin))}` : "Never logged in"}</small>
        </div>
        <span class="st-role is-${esc(String(s.role || "").toLowerCase())}">${esc(s.role || "No role")}</span>
        <span class="st-status ${s.active ? "is-on" : "is-off"}">${s.active ? "Active" : "Turned off"}</span>
        <div class="st-acts">
          <button type="button" class="lh-btn" data-edit="${esc(s.id)}">Edit</button>
          <button type="button" class="lh-btn" data-pin="${esc(s.id)}">Reset PIN</button>
          <button type="button" class="lh-btn ${s.active ? "st-danger" : "is-primary"}" data-toggle="${esc(s.id)}">${s.active ? "Turn off" : "Turn on"}</button>
        </div>
      </div>`).join("")}</div>
      ${!showOff && off ? `<p class="st-note">${off} turned-off staff hidden. Tick “Show turned-off staff” to see them.</p>` : ""}`
      : '<div class="tm-empty">No staff match.</div>';
  }

  async function renderAudit() {
    body.innerHTML = '<div class="skeleton" style="height:200px;border-radius:14px"></div>';
    try {
      const res = await api("audit");
      if (!root.isConnected || tab !== "audit") return;
      const entries = res.entries || [];
      body.innerHTML = entries.length ? `<ul class="st-audit">${entries.map((e) => `
        <li><span class="st-a-when">${esc(when(e.at))}</span>
          <span><strong>${esc(e.action)}</strong>${e.targetName ? ` · ${esc(e.targetName)}` : ""}${e.details ? ` <span class="muted">(${esc(e.details)})</span>` : ""}</span>
          <span class="muted">by ${esc(e.by || "—")}</span></li>`).join("")}</ul>`
        : '<div class="tm-empty">No staff changes yet.</div>';
    } catch (err) {
      body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err))}</div>`;
    }
  }

  async function load() {
    try {
      const res = await api("list");
      if (!root.isConnected) return;
      list = res.staff || [];
      roles = res.roles || roles;
      const sel = $('[data-role="role"]');
      if (sel.options.length === 1) sel.insertAdjacentHTML("beforeend", roles.map((r) => `<option>${esc(r)}</option>`).join(""));
      renderLock(res.locked);
      if (tab === "staff") renderStaff();
    } catch (err) {
      console.error("Staff load failed:", err);
      body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err))}</div>`;
    }
  }

  /* ---------- Windows ---------- */

  function showPin(name, pin, verb) {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog st-pin-dlg";
    dlg.innerHTML = `
      <div class="lh-form">
        <div class="lh-dialog-head"><h3>${esc(verb)}</h3><p>Give this PIN to <strong>${esc(name)}</strong>. It won't be shown again.</p></div>
        <div class="st-pin" aria-label="PIN">${esc(pin).split("").map((d) => `<span>${d}</span>`).join("")}</div>
        <div class="lh-actions">
          <button type="button" class="lh-btn" data-act="copy">Copy PIN</button>
          <button type="button" class="lh-btn is-primary" data-act="done">Done</button>
        </div>
      </div>`;
    dlg.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-act]");
      if (!a) return;
      if (a.dataset.act === "done") dlg.close();
      if (a.dataset.act === "copy") {
        try { await navigator.clipboard.writeText(pin); showToast("PIN copied"); } catch { showToast("Couldn't copy. Write it down instead."); }
      }
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  const pinChoice = (label) => `
    <div class="lh-field"><span class="lh-label">${label}</span>
      <label class="fe-check"><input type="radio" name="pinMode" value="auto" checked /> Make a PIN for me (6 digits)</label>
      <label class="fe-check"><input type="radio" name="pinMode" value="typed" /> I'll type one</label>
      <input name="pin" inputmode="numeric" maxlength="8" placeholder="4 to 8 digits" autocomplete="off" hidden />
    </div>`;
  const wirePinChoice = (form) => form.addEventListener("change", (e) => {
    if (e.target.name === "pinMode") {
      form.elements.pin.hidden = e.target.value !== "typed";
      if (!form.elements.pin.hidden) form.elements.pin.focus();
    }
  });
  const readPin = (form) => (form.querySelector('[name="pinMode"]:checked').value === "typed" ? form.elements.pin.value.trim() : "");

  function editStaff(s) {
    const isNew = !s;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${isNew ? "Add staff" : `Edit ${esc(s.name)}`}</h3>
          <p>${isNew ? "They can log in as soon as you save." : "Changes apply within a few minutes."}</p></div>
        <label class="lh-field"><span class="lh-label">Name</span><input name="name" maxlength="120" value="${esc(s ? s.name : "")}" /></label>
        <label class="lh-field"><span class="lh-label">Role</span>
          <select class="fb-select" name="role">${roles.map((r) => `<option${s && s.role === r ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>
          <small class="fe-note" data-role="rolenote"></small></label>
        <label class="lh-field"><span class="lh-label">Email (optional)</span><input type="email" name="email" maxlength="254" value="${esc(s ? s.email : "")}" /></label>
        <label class="lh-field"><span class="lh-label">Photo link (optional)</span><input name="photo" maxlength="1000" placeholder="https://…" value="${esc(s ? s.photo : "")}" /></label>
        ${isNew ? pinChoice("PIN") : ""}
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${isNew ? "Add staff" : "Save"}</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const note = () => { dlg.querySelector('[data-role="rolenote"]').textContent = ROLE_NOTE[form.elements.role.value] || ""; };
    note();
    form.elements.role.addEventListener("change", note);
    if (isNew) wirePinChoice(form);
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        const res = await api("save", { staff: {
          id: s ? s.id : "", name: form.elements.name.value, role: form.elements.role.value,
          email: form.elements.email.value, photo: form.elements.photo.value, pin: isNew ? readPin(form) : "",
        } });
        dlg.close();
        if (res.pin) showPin(form.elements.name.value.trim(), res.pin, "Staff member added");
        else showToast("Staff details saved");
        load();
      } catch (ex) {
        err.textContent = errText(ex);
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    form.elements.name.focus();
  }

  function resetPin(s) {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Reset ${esc(s.name)}'s PIN</h3><p>Their old PIN stops working straight away.</p></div>
        ${pinChoice("New PIN")}
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Reset PIN</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    wirePinChoice(form);
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        const res = await api("resetPin", { id: s.id, pin: readPin(form) });
        dlg.close();
        showPin(s.name, res.pin, "PIN reset");
      } catch (ex) {
        err.textContent = errText(ex);
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  async function toggle(s) {
    const off = s.active;
    const ok = await confirmDialog({
      title: off ? `Turn off ${s.name}?` : `Turn on ${s.name}?`,
      message: off
        ? "They can't log in, and any session they're in ends. Their records stay as they are. You can turn them back on any time."
        : "They can log in again with their existing PIN.",
      confirmLabel: off ? "Turn off" : "Turn on",
      tone: off ? "danger" : "info",
    });
    if (!ok) return;
    try {
      const res = await api("setActive", { id: s.id, active: !off });
      showToast(off
        ? (res.firebase ? `${s.name} turned off` : `${s.name} turned off. Their open pages may keep working for up to an hour.`)
        : `${s.name} turned on`);
      load();
    } catch (ex) { showToast(errText(ex)); }
  }

  /* ---------- Events ---------- */
  root.addEventListener("click", async (e) => {
    const t = e.target;
    const find = (id) => list.find((s) => s.id === id);
    if (t.closest('[data-act="add"]')) { editStaff(null); return; }
    const ed = t.closest("[data-edit]");
    if (ed) { editStaff(find(ed.dataset.edit)); return; }
    const pn = t.closest("[data-pin]");
    if (pn) { resetPin(find(pn.dataset.pin)); return; }
    const tg = t.closest("[data-toggle]");
    if (tg) { toggle(find(tg.dataset.toggle)); return; }
    const tb = t.closest("[data-tab]");
    if (tb) {
      tab = tb.dataset.tab;
      root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b === tb));
      $('[data-role="tools"]').hidden = tab !== "staff";
      if (tab === "staff") renderStaff(); else renderAudit();
      return;
    }
    const un = t.closest('[data-act="unlock"]');
    if (un) {
      un.disabled = true;
      try { await api("unlock"); renderLock(false); showToast("Logins unlocked"); }
      catch (ex) { showToast(errText(ex)); un.disabled = false; }
    }
  });
  $('[data-role="q"]').addEventListener("input", renderStaff);
  $('[data-role="role"]').addEventListener("change", renderStaff);
  $('[data-role="inactive"]').addEventListener("change", renderStaff);

  load();
}