// Staff (Admins only): add staff, edit, roles & access, reset PINs, turn access on or off, activity log.
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast, escapeHtml as esc, getInitials, hueFromString } from "./utils.js";
import { uploadStaffPhoto, photoErrText } from "./staff-photo.js";

const api = (op, extra = {}) => callApi({ action: "staff", op, ...extra });
const ERR = {
  LAST_ADMIN: "There must always be at least one active Admin.",
  SELF: "You can't turn off your own account.",
  PIN_TAKEN: "Another staff member already uses that PIN. Choose a different one.",
  BAD_PIN: "PINs are 4 to 8 digits.",
  BAD_NAME: "Enter the staff member's name.",
  BAD_EMAIL: "Check the email address.",
  BAD_PHOTO: "That photo couldn't be used. Upload it again.",
  BAD_ROLE: "Choose a role.",
  ROLE_IN_USE: "Someone still has that role. Change their role first, then remove it.",
  ROLE_EXISTS: "There's already a role with that name.",
  BAD_ROLE_NAME: "Role names can use letters, numbers, spaces, & and - (up to 40 characters).",
  FORBIDDEN: "Only Admins can manage staff.",
  NOT_FOUND: "That staff member couldn't be found. Refresh and try again.",
  INVALID_PIN: "The server hasn't been updated yet. In Apps Script, deploy a new version.",
  UNAUTHORIZED: "Your session has ended. Log out and back in.",
  BAD_PROVIDER: "Check the provider number: 6 digits, then a location character and a letter (e.g. 2345671A).",
  BAD_PRESCRIBER: "Check the prescriber number: 6 or 7 digits.",
  BAD_AHPRA: "Check the AHPRA number: 3 letters and 10 digits (e.g. MED0001234567).",
  BAD_HOURS: "Check the work hours: each working day needs a start and a finish, with the finish after the start.",
  BAD_LEAVE: "Check the leave dates: leave can't end before it starts.",
};
const errText = (err) => ERR[err && err.code] ||
  (err && err.code ? `Something went wrong (${err.code}). Check Apps Script → Executions.` : (err && err.message) || "Something went wrong.");
const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
};
const SCHED_DAYS = [["mo", "Monday"], ["tu", "Tuesday"], ["we", "Wednesday"], ["th", "Thursday"], ["fr", "Friday"], ["sa", "Saturday"], ["su", "Sunday"]];
const LEAVE_TYPES = ["Annual leave", "Sick", "Other"];
const isoDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shortDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const leaveNow = (s) => {
  const t = isoDay();
  const l = ((s.schedule && s.schedule.leave) || []).find((x) => x.from <= t && t <= x.to);
  return l ? ` · On leave until ${shortDay(l.to)}` : "";
};

const leaveRow = (l = {}) => `<div class="st-leave-row">
    <input class="fe-input" type="date" data-lv="from" value="${esc(l.from || "")}" aria-label="Leave from" />
    <span class="muted">to</span>
    <input class="fe-input" type="date" data-lv="to" value="${esc(l.to || "")}" aria-label="Leave to" />
    <select class="fb-select" data-lv="type" aria-label="Type of leave">${LEAVE_TYPES.map((t) =>
      `<option${t === (l.type || "Annual leave") ? " selected" : ""}>${t}</option>`).join("")}</select>
    <input class="fe-input" data-lv="note" maxlength="120" placeholder="Note (optional)" value="${esc(l.note || "")}" />
    <button type="button" class="hx-x" data-act="leave-rm" aria-label="Remove this leave" title="Remove">×</button>
  </div>`;

function schedHtml(s) {
  const sc = (s && s.schedule) || {};
  const week = sc.week || {};
  const any = Object.values(week).some((d) => d && d.on) || (sc.leave || []).length || sc.apptName;
  return `
    <details class="st-sched"${any ? " open" : ""}>
      <summary>Work schedule <small class="muted" data-role="schedsum"></small></summary>
      <p class="fe-note">Used to pop up End of day before they finish, and to email them if they forget. Leave it empty to use the clinic finish time.</p>
      <div class="st-week">${SCHED_DAYS.map(([k, label]) => {
        const d = week[k] || {};
        return `<div class="st-day" data-day="${k}">
          <label class="fe-check"><input type="checkbox" data-sd="on"${d.on ? " checked" : ""} /> ${label}</label>
          <input class="fe-input" type="time" data-sd="start" value="${esc(d.start || "08:30")}" aria-label="${label} start" />
          <span class="muted">to</span>
          <input class="fe-input" type="time" data-sd="end" value="${esc(d.end || "17:00")}" aria-label="${label} finish" />
        </div>`;
      }).join("")}</div>
      <button type="button" class="lh-btn is-quiet" data-act="sched-copy">Give every working day the first day's hours</button>
      <div class="st-leave"><span class="lh-label">Leave</span>
        <div data-role="leave">${(sc.leave || []).map(leaveRow).join("")}</div>
        <button type="button" class="lh-btn is-quiet" data-act="leave-add">+ Add leave</button>
      </div>
      <label class="lh-field"><span class="lh-label">Name in the appointment book (optional)</span>
        <input name="apptName" maxlength="80" placeholder="e.g. Dr Teh" value="${esc(sc.apptName || "")}" /></label>
      <small class="fe-note">For clinicians: if their last appointment runs past their finish time, End of day waits until it's nearly over.</small>
    </details>`;
}

function readSched(dlg) {
  const week = {};
  for (const [k, label] of SCHED_DAYS) {
    const row = dlg.querySelector(`[data-day="${k}"]`);
    const on = row.querySelector('[data-sd="on"]').checked;
    const start = row.querySelector('[data-sd="start"]').value;
    const end = row.querySelector('[data-sd="end"]').value;
    if (on && (!start || !end || end <= start)) {
      return { error: `${label}: the finish time needs to be after the start time.`, focus: row.querySelector('[data-sd="end"]') };
    }
    week[k] = { on, start: on ? start : "", end: on ? end : "" };
  }
  const leave = [];
  for (const row of dlg.querySelectorAll(".st-leave-row")) {
    const g = (f) => row.querySelector(`[data-lv="${f}"]`).value.trim();
    const from = g("from");
    const to = g("to") || from;
    if (!from && !g("to")) continue;
    if (!from) return { error: "Each leave needs its first day.", focus: row.querySelector('[data-lv="from"]') };
    if (to < from) return { error: "Leave can't end before it starts.", focus: row.querySelector('[data-lv="to"]') };
    leave.push({ from, to, type: g("type"), note: g("note") });
  }
  return { schedule: { week, leave, apptName: dlg.querySelector('[name="apptName"]').value.trim() } };
}

// Shows a button is working: spinner, wording, disabled. After 4 seconds: "Still saving…". Returns done() to put it back.
function busy(btn, text = "Saving…") {
  if (!btn) return () => {};
  const html = btn.innerHTML;
  const spin = '<span class="st-spin" aria-hidden="true"></span>';
  btn.disabled = true;
  btn.classList.add("is-busy");
  btn.setAttribute("aria-busy", "true");
  btn.innerHTML = spin + esc(text);
  const slow = setTimeout(() => { if (btn.isConnected) btn.innerHTML = `${spin}Still saving…`; }, 4000);
  return () => {
    clearTimeout(slow);
    if (!btn.isConnected) return;
    btn.disabled = false;
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-busy");
    btn.innerHTML = html;
  };
}

export function mountStaffManager(container, { staff: me = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <div class="fb-head">
      <div><h2>Staff</h2><p class="muted">Add staff, set their role and access, reset PINs and turn access on or off.</p></div>
      <div class="fb-head-actions"><button type="button" class="btn-primary" data-act="add">+ Add staff</button></div>
    </div>
    <div data-role="lock"></div>
    <div class="st-bar">
      <div class="pt-tabs" role="tablist">
        <button type="button" data-tab="staff" class="active">Staff</button>
        <button type="button" data-tab="roles">Roles &amp; access</button>
        <button type="button" data-tab="audit">Activity</button>
      </div>
      <div class="st-tools" data-role="tools">
        <input type="search" class="fe-input st-search" data-role="q" placeholder="Search staff…" aria-label="Search staff" />
        <select class="fb-select st-filter" data-role="rolefilter" aria-label="Role"><option value="">All roles</option></select>
        <label class="fe-check"><input type="checkbox" data-role="inactive" /> Show turned-off staff</label>
      </div>
    </div>
    <div data-role="body"><div class="skeleton" style="height:240px;border-radius:14px"></div></div>`;
  container.replaceChildren(root);
  const $ = (s) => root.querySelector(s);
  const body = $('[data-role="body"]');
  let list = [];
  let roleNames = ["Admin", "Clinician", "Reception"];
  let catalogue = [];   // [{ key, group, label }]
  let roleTicks = {};   // { Clinician: [...], Reception: [...] }
  let tab = "staff";
  let dirty = false;    // role changes not saved yet
  let savedNames = roleNames;   // roles the server knows (used in the Edit staff window)
  let savedTicks = {};  // role access as saved on the server (the Edit window's "role default" uses this, not unsaved ticks)
  const savedHas = (role, key) => /^admin$/i.test(role) || (savedTicks[role] || []).includes(key);

  const groups = () => [...new Set(catalogue.map((p) => p.group))];
  const roleHas = (role, key) => /^admin$/i.test(role) || (roleTicks[role] || []).includes(key);

  function renderLock(locked) {
    $('[data-role="lock"]').innerHTML = locked
      ? `<div class="st-lock"><span><strong>Logins are locked</strong> after too many wrong PINs. They unlock on their own within 15 minutes.</span>
          <button type="button" class="lh-btn is-primary" data-act="unlock">Unlock now</button></div>` : "";
  }

  /* ---------- Staff tab ---------- */
  function renderStaff() {
    const q = $('[data-role="q"]').value.trim().toLowerCase();
    const r = $('[data-role="rolefilter"]').value;
    const showOff = $('[data-role="inactive"]').checked;
    const rows = list.filter((s) => (showOff || s.active) && (!r || s.role === r) &&
      (!q || `${s.name} ${s.email} ${s.role}`.toLowerCase().includes(q)));
    const off = list.filter((s) => !s.active).length;
    const exceptions = (s) => {
      const n = ((s.access && s.access.allow) || []).length + ((s.access && s.access.deny) || []).length;
      return n ? ` · ${n} access exception${n === 1 ? "" : "s"}` : "";
    };
    body.innerHTML = rows.length ? `<div class="st-list">${rows.map((s) => `
      <div class="st-row${s.active ? "" : " is-off"}">
        <span class="st-avatar" style="--h:${hueFromString(s.name)}">${s.photo
          ? `<img src="${esc(s.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}<b>${esc(getInitials(s.name))}</b></span>
        <div class="st-main">
          <strong>${esc(s.name || "Unnamed")}${me && (me.uid === s.id || me.id === s.id) ? ' <em class="st-you">You</em>' : ""}</strong>
          <small>${esc(s.email || "No email")} · ${s.lastLogin ? `Last login ${esc(when(s.lastLogin))}` : "Never logged in"}${s.injector ? " · Injector" : ""}${
            s.providerNo ? ` · Provider ${esc(s.providerNo)}` : ""}${esc(exceptions(s))}${esc(leaveNow(s))}</small>
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

  /* ---------- Roles & access tab ---------- */
  function renderRoles() {
    if (!catalogue.length) { body.innerHTML = '<div class="tm-empty">Loading…</div>'; return; }
    const inUse = (r) => list.filter((s) => s.role === r).length;
    body.innerHTML = `
      <div class="st-matrix-wrap">
        <table class="st-matrix">
          <thead><tr><th>Access</th>${roleNames.map((r) => /^admin$/i.test(r) ? `<th>${esc(r)}</th>`
            : `<th><span class="st-rolehead">${esc(r)}<button type="button" class="st-delrole" data-delrole="${esc(r)}"
                title="${inUse(r) ? `${inUse(r)} staff have this role` : "Remove this role"}" aria-label="Remove ${esc(r)}">×</button></span></th>`).join("")}</tr></thead>
          <tbody>${groups().map((g) => `
            <tr class="st-mgroup"><td colspan="${roleNames.length + 1}">${esc(g)}</td></tr>
            ${catalogue.filter((p) => p.group === g).map((p) => `
              <tr><td>${esc(p.label)}</td>${roleNames.map((r) => /^admin$/i.test(r)
                ? '<td><input type="checkbox" checked disabled aria-label="Admins always have this" /></td>'
                : `<td><input type="checkbox" data-rrole="${esc(r)}" data-perm="${esc(p.key)}"${roleHas(r, p.key) ? " checked" : ""} aria-label="${esc(r)}: ${esc(p.label)}" /></td>`).join("")}</tr>`).join("")}`).join("")}
          </tbody>
        </table>
      </div>
      <div class="st-matrix-foot">
        <button type="button" class="lh-btn" data-act="add-role">+ Add role</button>
        <small class="muted">Admins always have everything. Exceptions for one person are set in their <strong>Edit</strong> window. Changes reach staff within a minute.</small>
        ${dirty ? '<span class="st-dirty">Unsaved changes</span>' : ""}
        <button type="button" class="lh-btn is-primary" data-act="save-roles">Save role access</button>
      </div>`;
    // Group names stick just under the role names, whatever height the header is
    const wrap = body.querySelector(".st-matrix-wrap");
    const head = wrap && wrap.querySelector("thead");
    if (head) wrap.style.setProperty("--st-head", `${head.offsetHeight}px`);
  }

  // Ticks are remembered as you go, so adding or removing a role doesn't lose them
  body.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-rrole]");
    if (!cb) return;
    const r = cb.dataset.rrole;
    const set = new Set(roleTicks[r] || []);
    if (cb.checked) set.add(cb.dataset.perm); else set.delete(cb.dataset.perm);
    roleTicks[r] = [...set];
    if (!dirty) {
      dirty = true;
      const foot = body.querySelector(".st-matrix-foot");
      const btn = foot && foot.querySelector('[data-act="save-roles"]');
      if (btn && !foot.querySelector(".st-dirty")) btn.insertAdjacentHTML("beforebegin", '<span class="st-dirty">Unsaved changes</span>');
    }
  });

  function fillRoleFilter() {
    const sel = $('[data-role="rolefilter"]');
    const cur = sel.value;
    sel.innerHTML = `<option value="">All roles</option>${roleNames.map((r) => `<option>${esc(r)}</option>`).join("")}`;
    sel.value = roleNames.includes(cur) ? cur : "";
  }

  function addRole() {
    const others = roleNames.filter((r) => !/^admin$/i.test(r));
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Add a role</h3><p>For example Nurse or Practice Manager. You can adjust its access after adding it.</p></div>
        <label class="lh-field"><span class="lh-label">Role name</span><input name="name" maxlength="40" autocomplete="off" /></label>
        <label class="lh-field"><span class="lh-label">Start with the same access as</span>
          <select class="fb-select" name="from"><option value="">Nothing (I'll tick it myself)</option>${others.map((r) =>
            `<option${/^clinician$/i.test(r) ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Add role</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim().replace(/\s+/g, " ");
      const fail = (code) => { err.textContent = ERR[code]; err.hidden = false; };
      if (!/^[A-Za-z][A-Za-z0-9 &'-]{0,39}$/.test(name)) return fail("BAD_ROLE_NAME");
      if (roleNames.some((r) => r.toLowerCase() === name.toLowerCase())) return fail("ROLE_EXISTS");
      const from = form.elements.from.value;
      roleNames = [...roleNames, name];
      roleTicks[name] = from ? [...(roleTicks[from] || [])] : [];
      dirty = true;
      dlg.close();
      renderRoles();
      showToast(`${name} added. Check its access, then press Save role access.`);
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    form.elements.name.focus();
  }

  async function removeRole(r) {
    const n = list.filter((s) => s.role === r).length;
    if (n) { showToast(`${n} staff member${n === 1 ? " has" : "s have"} the ${r} role. Change their role first.`); return; }
    const ok = await confirmDialog({
      title: `Remove the ${r} role?`,
      message: "It's removed when you press Save role access.",
      confirmLabel: "Remove role",
      tone: "warning",
    });
    if (!ok) return;
    roleNames = roleNames.filter((x) => x !== r);
    delete roleTicks[r];
    dirty = true;
    renderRoles();
  }

  
  async function saveRoles(btn) {
    const out = {};
    roleNames.filter((r) => !/^admin$/i.test(r)).forEach((r) => { out[r] = [...new Set(roleTicks[r] || [])]; });
    const wrap = body.querySelector(".st-matrix-wrap");
    if (wrap) wrap.classList.add("is-saving");          // no tick changes while it saves
    const done = busy(btn, "Saving…");
    try {
      const res = await api("saveRoles", { roles: out, roleNames });
      roleTicks = res.roles || out;
      if (Array.isArray(res.roleNames)) roleNames = res.roleNames;
      dirty = false;
      savedNames = roleNames;
      savedTicks = JSON.parse(JSON.stringify(roleTicks));
      fillRoleFilter();
      renderRoles();
      showToast("Role access saved. Staff get it within a minute.");
    } catch (ex) {
      done();
      if (wrap) wrap.classList.remove("is-saving");
      showToast(errText(ex));
    }
  }
  
  /* ---------- Activity tab ---------- */
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

  function render() {
    $('[data-role="tools"]').hidden = tab !== "staff";
    if (tab === "staff") renderStaff();
    else if (tab === "roles") renderRoles();
    else renderAudit();
  }

  async function load() {
    try {
      const [res, rolesRes] = await Promise.all([api("list"), api("roles")]);
      if (!root.isConnected) return;
      list = res.staff || [];
      if (!dirty) {                     // don't throw away a role that hasn't been saved yet
        roleNames = rolesRes.roleNames || res.roles || roleNames;
        roleTicks = rolesRes.roles || {};
        savedNames = roleNames;
      }
      savedTicks = JSON.parse(JSON.stringify(rolesRes.roles || {}));
      catalogue = (rolesRes.perms || []).filter((p) => p.key !== "inventory.kit");
      fillRoleFilter();
      renderLock(res.locked);
      if (tab !== "audit") render();
    } catch (err) {
      console.error("Staff load failed:", err);
      body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err))}</div>`;
    }
  }

    // After a save: only the staff list is fetched again, quietly, behind what's already on screen
  async function refreshList() {
    try {
      const res = await api("list");
      if (!root.isConnected) return;
      list = res.staff || list;
      renderLock(res.locked);
      if (tab === "staff") renderStaff();
    } catch (err) { console.warn("Staff list refresh failed:", err); }
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

  // Per-person exceptions: Role default / Always allow / Always block
  // Per-person exceptions: Role default / Always allow / Always block, with what they end up with
  function accessHtml(s) {
    const acc = (s && s.access) || { allow: [], deny: [] };
    const val = (k) => (acc.allow || []).includes(k) ? "allow" : (acc.deny || []).includes(k) ? "deny" : "";
    const n = (acc.allow || []).length + (acc.deny || []).length;
    if (!catalogue.length) return '<p class="fe-note" data-role="access">Access settings are still loading. Close this and open it again.</p><p data-role="adminnote" hidden></p>';
    return `
      <details class="st-access" data-role="access"${n ? " open" : ""}>
        <summary>Access for this person <small class="muted" data-role="acccount"></small></summary>
        <p class="fe-note">Leave on <strong>Role default</strong> unless this person needs something different from their role.</p>
        <div class="st-acc-list">${groups().map((g) => `
          <div class="st-acc-group">${esc(g)}</div>
          ${catalogue.filter((p) => p.group === g).map((p) => `
            <label class="st-acc-row" data-accrow="${esc(p.key)}">
              <span>${esc(p.label)} <small class="muted" data-def="${esc(p.key)}"></small></span>
              <select class="fb-select" data-acc="${esc(p.key)}">
                <option value=""${val(p.key) === "" ? " selected" : ""}>Role default</option>
                <option value="allow"${val(p.key) === "allow" ? " selected" : ""}>Always allow</option>
                <option value="deny"${val(p.key) === "deny" ? " selected" : ""}>Always block</option>
              </select>
              <span class="st-acc-res" data-res="${esc(p.key)}"></span>
            </label>`).join("")}`).join("")}
        </div>
        <button type="button" class="lh-btn is-quiet st-acc-reset" data-act="acc-reset">Reset all to role default</button>
      </details>
      <p class="fe-note" data-role="adminnote" hidden>Admins can do everything, so there are no exceptions to set.</p>`;
  }
  
  
  // new staff start as Clinician (or the first non-Admin role). Unknown roles must be chosen.
  function roleOptions(s) {
    const names = savedNames;
    const find = (v) => names.find((r) => r.toLowerCase() === String(v || "").toLowerCase()) || "";
    const cur = s ? find(s.role) : (find("Clinician") || names.find((r) => !/^admin$/i.test(r)) || names[0]);
    return (cur ? "" : `<option value="" selected disabled>Choose a role${s && s.role ? ` (was ${esc(s.role)})` : ""}</option>`)
      + names.map((r) => `<option${r === cur ? " selected" : ""}>${esc(r)}</option>`).join("");
  }

  function editStaff(s) {
    const isNew = !s;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog st-edit-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${isNew ? "Add staff" : `Edit ${esc(s.name)}`}</h3>
          <p>${isNew ? "They can log in as soon as you save." : "Changes reach them within a minute."}</p></div>
        <label class="lh-field"><span class="lh-label">Name</span><input name="name" maxlength="120" value="${esc(s ? s.name : "")}" /></label>
        <label class="lh-field"><span class="lh-label">Role</span>
          <select class="fb-select" name="role">${roleOptions(s)}</select></label>
        <label class="fe-check st-injector"><input type="checkbox" name="injector"${s && s.injector ? " checked" : ""} />
          Injector: carries their own kit (e.g. Xeomin)</label>
        <small class="fe-note">Gives them My kit, the kit check, and kit products in treatment records. Works with any role, including Admin.</small>
        <label class="lh-field"><span class="lh-label">Email (optional)</span><input type="email" name="email" maxlength="254" value="${esc(s ? s.email : "")}" /></label>
        <div class="lh-field"><span class="lh-label">Photo (optional)</span>
          <div class="st-photo-pick">
            <span class="st-avatar st-avatar-lg" data-role="pv"></span>
            <div class="st-photo-btns">
              <label class="lh-btn">Upload photo<input type="file" accept="image/*" hidden data-role="photofile" /></label>
              <button type="button" class="lh-btn is-quiet" data-act="photo-remove">Remove</button>
              <small class="fe-note" data-role="photonote" role="status"></small>
            </div>
          </div>
          <input type="hidden" name="photo" value="${esc(s ? s.photo || "" : "")}" />
        </div>
        <fieldset class="st-reg"><legend>Registration (optional)</legend>
          <p class="fe-note">Used to fill in forms automatically. Staff can still change them on a form.</p>
          <div class="st-reg-grid">
            <label class="lh-field"><span class="lh-label">Provider number</span>
              <input name="providerNo" maxlength="12" placeholder="e.g. 2345671A" autocapitalize="characters" autocomplete="off" value="${esc(s ? s.providerNo || "" : "")}" /></label>
            <label class="lh-field"><span class="lh-label">Prescriber number</span>
              <input name="prescriberNo" maxlength="10" inputmode="numeric" placeholder="7 digits" autocomplete="off" value="${esc(s ? s.prescriberNo || "" : "")}" /></label>
            <label class="lh-field"><span class="lh-label">AHPRA registration</span>
              <input name="ahpraNo" maxlength="16" placeholder="e.g. MED0001234567" autocapitalize="characters" autocomplete="off" value="${esc(s ? s.ahpraNo || "" : "")}" /></label>
            <label class="lh-field st-reg-wide"><span class="lh-label">Title and qualifications</span>
              <input name="quals" maxlength="150" placeholder="e.g. Dr Jane Smith, MBBS FRACGP" value="${esc(s ? s.quals || "" : "")}" /></label>
          </div>
        </fieldset>
        ${schedHtml(s)}
        ${isNew ? pinChoice("PIN") : ""}
        ${accessHtml(s)}
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${isNew ? "Add staff" : "Save"}</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    // Photo: uploaded straight away, saved with everything else when Save is pressed
    const pv = dlg.querySelector('[data-role="pv"]');
    const pnote = dlg.querySelector('[data-role="photonote"]');
    let uploading = false;
    const drawPv = () => {
      const url = form.elements.photo.value;
      const nm = form.elements.name.value.trim() || "?";
      pv.style.setProperty("--h", hueFromString(nm));
      pv.innerHTML = (url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />` : "")
        + `<b>${esc(getInitials(nm))}</b>`;
      dlg.querySelector('[data-act="photo-remove"]').hidden = !url;
    };
    drawPv();
    form.elements.name.addEventListener("input", drawPv);
    const photoFolder = s ? s.id : `new_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    dlg.querySelector('[data-role="photofile"]').addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file || uploading) return;
      uploading = true;
      pnote.classList.remove("is-bad");
      pnote.textContent = "Uploading photo…";
      try {
        form.elements.photo.value = await uploadStaffPhoto(photoFolder, file);
        drawPv();
        pnote.textContent = "New photo ready. Press Save to keep it.";
      } catch (ex) {
        console.error("Staff photo failed:", ex);
        pnote.textContent = photoErrText(ex);
        pnote.classList.add("is-bad");
      } finally { uploading = false; }
    });
    dlg.querySelector('[data-act="photo-remove"]').addEventListener("click", () => {
      form.elements.photo.value = "";
      drawPv();
      pnote.classList.remove("is-bad");
      pnote.textContent = "Photo removed. Press Save to keep the change.";
    });
    // Keeps every row's role default, result and highlight up to date as the role or a setting changes
    const syncAccess = () => {
      const role = form.elements.role.value;
      const admin = /^admin$/i.test(role);
      dlg.querySelector('[data-role="access"]').hidden = admin;
      dlg.querySelector('[data-role="adminnote"]').hidden = !admin;
      let n = 0;
      dlg.querySelectorAll("[data-acc]").forEach((sel) => {
        const key = sel.dataset.acc;
        const def = role ? savedHas(role, key) : false;
        const v = sel.value;
        const has = v === "allow" ? true : v === "deny" ? false : def;
        const pointless = (v === "allow" && def) || (v === "deny" && !def);
        if (v) n++;
        const row = sel.closest("[data-accrow]");
        row.classList.toggle("is-changed", !!v);
        row.querySelector("[data-def]").textContent = role
          ? `(${role}: ${def ? "yes" : "no"}${pointless ? ", so this changes nothing" : ""})` : "";
        const res = row.querySelector("[data-res]");
        res.textContent = has ? "Has it" : "No";
        res.className = `st-acc-res ${has ? "is-yes" : "is-no"}`;
      });
      const count = dlg.querySelector('[data-role="acccount"]');
      if (count) count.textContent = n ? `${n} exception${n === 1 ? "" : "s"}` : "same as their role";
    };
    syncAccess();
    form.elements.role.addEventListener("change", syncAccess);
    // Work schedule: times only for working days, a summary in the heading, leave rows, copy hours
    const syncSched = () => {
      const on = [];
      dlg.querySelectorAll("[data-day]").forEach((row) => {
        const ticked = row.querySelector('[data-sd="on"]').checked;
        row.querySelectorAll('input[type="time"]').forEach((i) => { i.disabled = !ticked; });
        if (ticked) on.push(SCHED_DAYS.find(([k]) => k === row.dataset.day)[1].slice(0, 3));
      });
      dlg.querySelector('[data-role="schedsum"]').textContent = on.length ? on.join(", ") : "not set: uses the clinic finish time";
    };
    syncSched();
    dlg.addEventListener("change", (e) => { if (e.target.matches('[data-sd="on"]')) syncSched(); });
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="leave-add"]')) {
        dlg.querySelector('[data-role="leave"]').insertAdjacentHTML("beforeend", leaveRow());
        dlg.querySelector('.st-leave-row:last-child [data-lv="from"]').focus();
        return;
      }
      const rm = e.target.closest('[data-act="leave-rm"]');
      if (rm) { rm.closest(".st-leave-row").remove(); return; }
      if (e.target.closest('[data-act="sched-copy"]')) {
        const rows = [...dlg.querySelectorAll("[data-day]")].filter((r) => r.querySelector('[data-sd="on"]').checked);
        if (!rows.length) { showToast("Tick their working days first."); return; }
        const s0 = rows[0].querySelector('[data-sd="start"]').value;
        const e0 = rows[0].querySelector('[data-sd="end"]').value;
        rows.slice(1).forEach((r) => { r.querySelector('[data-sd="start"]').value = s0; r.querySelector('[data-sd="end"]').value = e0; });
      }
    });
    dlg.addEventListener("change", (e) => { if (e.target.matches("[data-acc]")) syncAccess(); });
    dlg.addEventListener("click", (e) => {
      if (!e.target.closest('[data-act="acc-reset"]')) return;
      dlg.querySelectorAll("[data-acc]").forEach((sel) => { sel.value = ""; });
      syncAccess();
    });
    if (isNew) wirePinChoice(form);
    let saving = false;
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!saving) dlg.close(); });
    dlg.addEventListener("cancel", (e) => { if (saving) e.preventDefault(); });   // Esc can't close it mid-save
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (saving) return;
      if (uploading) { err.textContent = "Wait for the photo to finish uploading."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      err.hidden = true;
      const sr = readSched(dlg);
      if (sr.error) {
        err.textContent = sr.error;
        err.hidden = false;
        dlg.querySelector(".st-sched").open = true;
        if (sr.focus) sr.focus.focus();
        return;
      }
      const access = { allow: [], deny: [] };
      dlg.querySelectorAll("[data-acc]").forEach((sel) => {
        if (sel.value === "allow") access.allow.push(sel.dataset.acc);
        if (sel.value === "deny") access.deny.push(sel.dataset.acc);
      });
      const f = form.elements;
      const payload = {
        id: s ? s.id : "", name: f.name.value, role: f.role.value,
        email: f.email.value, photo: f.photo.value, pin: isNew ? readPin(form) : "", access,
        injector: f.injector.checked,
        providerNo: f.providerNo.value, prescriberNo: f.prescriberNo.value,
        ahpraNo: f.ahpraNo.value, quals: f.quals.value,schedule: sr.schedule,
      };
      saving = true;
      const done = busy(btn, isNew ? "Adding…" : "Saving…");
      try {
        const res = await api("save", { staff: payload });
        // Show the change straight away; the full list is fetched again quietly
        const { pin, ...shown } = payload;
        const row = { ...(s || { active: true, lastLogin: "", hasPin: true }), ...shown,
          id: res.id || shown.id, name: shown.name.trim(), email: shown.email.trim() };
        list = s ? list.map((x) => (x.id === s.id ? row : x))
          : [...list, row].sort((a, b) => String(a.name).localeCompare(String(b.name)));
        saving = false;
        dlg.close();
        if (tab === "staff") renderStaff();
        if (res.pin) showPin(row.name, res.pin, "Staff member added");
        else showToast(`${row.name} saved`);
        refreshList();
      } catch (ex) {
        saving = false;
        done();
        err.textContent = errText(ex);
        err.hidden = false;
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
    let saving = false;
    dlg.addEventListener("cancel", (e) => { if (saving) e.preventDefault(); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (saving) return;
      err.hidden = true;
      saving = true;
      const done = busy(form.querySelector('[type="submit"]'), "Resetting…");
      try {
        const res = await api("resetPin", { id: s.id, pin: readPin(form) });
        saving = false;
        dlg.close();
        showPin(s.name, res.pin, "PIN reset");
      } catch (ex) {
        saving = false;
        done();
        err.textContent = errText(ex);
        err.hidden = false;
      }
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  async function toggle(s, btn) {
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
    const done = busy(btn, off ? "Turning off…" : "Turning on…");
    try {
      const res = await api("setActive", { id: s.id, active: !off });
      list = list.map((x) => (x.id === s.id ? { ...x, active: !off } : x));
      renderStaff();
      showToast(off
        ? (res.firebase ? `${s.name} turned off` : `${s.name} turned off. Their open pages may keep working for up to an hour.`)
        : `${s.name} turned on`);
      refreshList();
    } catch (ex) {
      done();
      showToast(errText(ex));
    }
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
    if (tg) { if (!tg.disabled) toggle(find(tg.dataset.toggle), tg); return; }
    if (t.closest('[data-act="add-role"]')) { addRole(); return; }
    const dr = t.closest("[data-delrole]");
    if (dr) { removeRole(dr.dataset.delrole); return; }
    const sr = t.closest('[data-act="save-roles"]');
    if (sr) { saveRoles(sr); return; }
    const tb = t.closest("[data-tab]");
    if (tb) {
      tab = tb.dataset.tab;
      root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b === tb));
      render();
      return;
    }
    const un = t.closest('[data-act="unlock"]');
    if (un && !un.disabled) {
      const done = busy(un, "Unlocking…");
      try { await api("unlock"); renderLock(false); showToast("Logins unlocked"); }
      catch (ex) { done(); showToast(errText(ex)); }
    }
  });
  $('[data-role="q"]').addEventListener("input", renderStaff);
  $('[data-role="rolefilter"]').addEventListener("change", renderStaff);
  $('[data-role="inactive"]').addEventListener("change", renderStaff);

  load();
}