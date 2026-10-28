// Task Manager → End of day: who sees "End my day", the kit count, the reminder, and the questions.
// Questions come in sets: Everyone, plus sets given to roles (e.g. Reception) or to particular people.
// A person gets the set given to them by name, then their role's set, otherwise Everyone's.
import { EOD_TYPES, MOODS, getEndOfDaySettings, saveEndOfDaySettings, newQid, newSetId, setFor } from "./end-of-day-api.js";
import { callApi } from "./appointments.js";
import { can } from "./perms.js";
import { confirmDialog } from "./dialog.js";
import { escapeHtml, showToast } from "./utils.js";

const esc = (s) => escapeHtml(String(s ?? ""));
const firstName = (n) => String(n || "").trim().replace(/^(dr|prof)\.?\s+/i, "").split(/\s+/)[0] || "Jane";
const copyQs = (list) => list.map((q) => ({ ...q, id: newQid(), options: [...(q.options || [])] }));

export function mountEndOfDaySettings(container, { staff = null, embedded = false } = {}) {
  const root = document.createElement("section");
  root.className = embedded ? "eod-admin" : "page eod-admin";
  container.replaceChildren(root);
  if (!can("tasks.build")) {
    root.innerHTML = '<div class="state"><strong>No access</strong>Ask an Admin for Build tasks access in Staff.</div>';
    return;
  }
  const st = { cfg: null, dirty: false, saving: false, tab: "all", people: [], roles: [] };
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';

  const curSet = () => (st.tab === "all" ? null : st.cfg.sets.find((x) => x.id === st.tab) || null);
  const curList = () => { const x = curSet(); return x ? x.questions : st.cfg.questions; };
  const whoGets = (set) => st.people.filter((p) => {
    const s = setFor(st.cfg, { uid: p.id, role: p.role });
    return set ? !!s && s.id === set.id : !s;
  });
  const givenText = (x) => {
    const bits = [...x.roles];
    if (x.staffIds.length) bits.push(`${x.staffIds.length} ${x.staffIds.length === 1 ? "person" : "people"}`);
    return bits.join(" · ") || "Not given to anyone yet";
  };
  const roleOwner = (r) => st.cfg.sets.find((x) => x.roles.some((y) => y.toLowerCase() === r.toLowerCase())) || null;
  const personOwner = (id) => st.cfg.sets.find((x) => x.staffIds.includes(id)) || null;

  /* ---------- Pieces ---------- */

  const qHtml = (q, i, n) => `
    <div class="eod-qe" data-i="${i}">
      <div class="eod-qe-row">
        <span class="eod-qe-n">${i + 1}</span>
        <input class="fe-input eod-qe-label" data-k="label" maxlength="200" placeholder="e.g. How was your day?" value="${esc(q.label)}" aria-label="Question ${i + 1}" />
        <select class="fb-select" data-k="type" aria-label="Answer type">${EOD_TYPES.map((t) =>
          `<option value="${t.key}"${t.key === q.type ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
      </div>
      <div class="eod-qe-row">
        <input class="fe-input" data-k="help" maxlength="300" placeholder="Hint under the question (optional)" value="${esc(q.help)}" aria-label="Hint" />
        <label class="fe-check"><input type="checkbox" data-k="required"${q.required ? " checked" : ""} /> Must answer</label>
      </div>
      ${q.type === "choice" ? `<label class="lh-field"><span class="lh-label">Choices (one per line)</span>
        <textarea class="fe-input" data-k="options" rows="3" placeholder="Quiet&#10;Steady&#10;Flat out">${esc(q.options.join("\n"))}</textarea></label>` : ""}
      <div class="eod-qe-acts">
        <button type="button" class="lh-btn is-quiet" data-act="up" aria-label="Move up"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="lh-btn is-quiet" data-act="down" aria-label="Move down"${i === n - 1 ? " disabled" : ""}>↓</button>
        <button type="button" class="lh-btn is-quiet" data-act="del">Remove</button>
      </div>
    </div>`;

  const tabsHtml = () => {
    const tab = (id, title, sub, n) => `<button type="button" role="tab" class="eod-tab${st.tab === id ? " is-on" : ""}"
        data-tab="${esc(id)}" aria-selected="${st.tab === id}">
        <b>${esc(title)}</b><small>${esc(sub)}</small><span class="eod-tab-n">${n} question${n === 1 ? "" : "s"}</span></button>`;
    return tab("all", "Everyone", "Anyone not in a set below", st.cfg.questions.length) +
      st.cfg.sets.map((x) => tab(x.id, x.name || "New set", givenText(x), x.questions.length)).join("") +
      `<button type="button" class="eod-tab is-add" data-act="add-set"><b>+ New set</b><small>For a role or particular people</small></button>`;
  };

  // How each question looks in the End of day window (the same styles staff see)
  const pvQ = (q) => {
    const head = `<div class="eod-q-label">${esc(q.label || "Untitled question")}${q.required ? ' <span class="eod-req">*</span>' : ""}</div>
      ${q.help ? `<small class="muted eod-q-help">${esc(q.help)}</small>` : ""}`;
    const pills = (vals) => `<div class="eod-pills">${vals.map((v) => `<span class="eod-pill"><span>${esc(v)}</span></span>`).join("")}</div>`;
    let input;
    switch (q.type) {
      case "mood": input = `<div class="eod-moods">${MOODS.map(([, e, l]) =>
        `<span class="eod-mood"><span class="eod-face">${e}</span><small>${esc(l)}</small></span>`).join("")}</div>`; break;
      case "rating": input = pills([1, 2, 3, 4, 5]); break;
      case "yesno": input = pills(["Yes", "No"]); break;
      case "choice": input = `<div class="eod-choices">${(q.options || []).filter((o) => o.trim()).map((o) =>
        `<span class="fe-check"><input type="radio" disabled /> ${esc(o)}</span>`).join("") || '<small class="muted">Add the choices</small>'}</div>`; break;
      case "long": input = '<div class="eod-pv-box is-long"></div>'; break;
      case "number": input = '<div class="eod-pv-box is-num"></div>'; break;
      default: input = '<div class="eod-pv-box"></div>';
    }
    return `<div class="eod-q eod-pv-q">${head}${input}</div>`;
  };

  const previewHtml = () => {
    const set = curSet();
    const list = curList();
    const people = whoGets(set);
    return `<div class="eod-pv-label">What they'll see</div>
      <div class="eod-pv">
        <div class="eod-pv-head"><b>End of day</b><span>Thanks for today, ${esc(firstName(people[0] && people[0].name))}.</span></div>
        <div class="eod-pv-body">${list.length ? list.map(pvQ).join("") : '<p class="muted">No questions. They just end their day.</p>'}</div>
        <div class="eod-pv-acts"><span>Not yet</span><span class="is-pri">Save</span></div>
      </div>
      <div class="eod-pv-who">
        <b>${people.length} ${people.length === 1 ? "person gets" : "people get"} these</b>
        ${people.length ? `<div class="eod-pv-names">${people.map((p) =>
          `<span title="${esc(p.role)}">${esc(p.name)}</span>`).join("")}</div>`
          : `<small class="muted">${set ? "Tick a role or a person on the left." : "Everyone is in a set."}</small>`}
      </div>`;
  };

  const setBoxHtml = (x) => `
    <div class="eod-setbox">
      <label class="lh-field"><span class="lh-label">Set name</span>
        <input class="fe-input" data-set="name" maxlength="60" placeholder="e.g. Reception" value="${esc(x.name)}" /></label>
      <div class="lh-field"><span class="lh-label">Given to these roles</span>
        <div class="eod-chips">${st.roles.map((r) => {
          const own = roleOwner(r);
          const mine = !!own && own.id === x.id;
          const taken = !!own && !mine;
          return `<label class="eod-chip${taken ? " is-taken" : ""}"><input type="checkbox" data-role-chip="${esc(r)}"${mine ? " checked" : ""}${taken ? " disabled" : ""} />
            <span>${esc(r)}</span>${taken ? `<em>in ${esc(own.name || "another set")}</em>` : ""}</label>`;
        }).join("") || '<small class="muted">No roles found.</small>'}</div></div>
      <details class="eod-people"${x.staffIds.length ? " open" : ""}>
        <summary>And these people <small>${x.staffIds.length ? `${x.staffIds.length} chosen · ` : ""}they get this set whatever their role</small></summary>
        <div class="eod-chips">${st.people.map((p) => {
          const own = personOwner(p.id);
          const mine = !!own && own.id === x.id;
          const taken = !!own && !mine;
          return `<label class="eod-chip${taken ? " is-taken" : ""}"><input type="checkbox" data-person="${esc(p.id)}"${mine ? " checked" : ""}${taken ? " disabled" : ""} />
            <span>${esc(p.name)}</span><em>${esc(taken ? `in ${own.name || "another set"}` : p.role)}</em></label>`;
        }).join("")}</div>
      </details>
      <div class="eod-setacts">
        <button type="button" class="lh-btn is-quiet" data-act="copy-all">Copy Everyone's questions</button>
        <button type="button" class="lh-btn is-quiet eod-danger" data-act="del-set">Delete this set</button>
      </div>
    </div>`;

  /* ---------- The page ---------- */

  function draw() {
    const c = st.cfg;
    const set = curSet();
    const list = curList();
    root.innerHTML = `
      ${embedded
        ? `<h3 class="tm-h">End of day</h3>
           <p class="muted tm-sub">What staff are asked when they click <strong>End my day</strong> in the top bar.
             Admins see the answers on My dashboard → Start &amp; end of day.</p>`
        : `<a class="ff-btn is-quiet eod-back" href="#/tasks">← Task Manager</a>
           <div class="fb-head"><div><h2>End of day</h2>
             <p class="muted">What staff are asked when they click <strong>End my day</strong> in the top bar.
               Admins see the answers on My dashboard → Start &amp; end of day.</p></div></div>`}
      <div class="eod-top">
        <section class="tb-card eod-set">
          <h4>Kit count</h4>
          <label class="fe-check"><input type="checkbox" data-s="kitCheck"${c.kitCheck ? " checked" : ""} />
            Injectors count their kit (units left) before answering</label>
          <small class="muted">Everyone sees End my day. Only injectors count a kit.</small>
        </section>
        <section class="tb-card eod-set">
          <h4>Reminder</h4>
          <label class="fe-check"><input type="checkbox" data-s="prompt"${c.prompt ? " checked" : ""} />
            Pop up End of day before each person finishes</label>
          <div class="eod-remind-row">
            <label class="lh-field"><span class="lh-label">How long before</span>
              <select class="fb-select" data-s="remindBefore">${[0, 5, 10, 15, 30, 45, 60].map((n) =>
                `<option value="${n}"${c.remindBefore === n ? " selected" : ""}>${n ? `${n} minutes` : "At their finish time"}</option>`).join("")}</select></label>
            <label class="lh-field"><span class="lh-label">Clinic finish time</span>
              <input class="fe-input" type="time" data-s="finishTime" value="${esc(c.finishTime)}" /></label>
          </div>
          <small class="muted">Each person's finish time comes from their work schedule in Staff. The clinic finish time is for anyone
            without one. If a clinician's last appointment runs late, they're reminded before it ends instead.</small>
        </section>
      </div>

      <section class="tb-card eod-qcard">
        <div class="eod-qcard-head"><h4>Questions</h4>
          <p class="muted">Everyone answers <b>Everyone</b>'s questions, unless a set is given to their role or to them by name.
            Someone given a set by name gets it whatever their role.</p></div>
        <div class="eod-tabs" role="tablist" data-role="tabs">${tabsHtml()}</div>
        <div class="eod-split">
          <div class="eod-editor">
            ${set ? setBoxHtml(set) : '<p class="eod-note">These are for everyone who isn\'t in a set.</p>'}
            ${list.length ? list.map((q, i) => qHtml(q, i, list.length)).join("")
              : '<p class="tb-none">No questions. These staff will only do the kit count (injectors), or just end their day.</p>'}
            <button type="button" class="ff-btn" data-act="add">+ Add a question</button>
          </div>
          <aside class="eod-preview" data-role="pv">${previewHtml()}</aside>
        </div>
      </section>

      <div class="eod-savebar">
        <span class="muted" data-role="state">${st.dirty ? "Unsaved changes" : "All changes saved"}</span>
        <button type="button" class="ff-btn is-primary" data-act="save"${st.dirty && !st.saving ? "" : " disabled"}>${st.saving ? "Saving…" : "Save changes"}</button>
      </div>`;
  }

  const drawPreview = () => { const el = root.querySelector('[data-role="pv"]'); if (el) el.innerHTML = previewHtml(); };
  const drawTabs = () => { const el = root.querySelector('[data-role="tabs"]'); if (el) el.innerHTML = tabsHtml(); };

  function markDirty() {
    st.dirty = true;
    const s = root.querySelector('[data-role="state"]');
    if (s) s.textContent = "Unsaved changes";
    const b = root.querySelector('[data-act="save"]');
    if (b) b.disabled = false;
  }

  async function save() {
    st.saving = true;
    draw();
    try {
      st.cfg = await saveEndOfDaySettings(st.cfg, staff);
      if (st.tab !== "all" && !st.cfg.sets.some((x) => x.id === st.tab)) st.tab = "all";
      st.dirty = false;
      showToast("End of day saved");
    } catch (ex) {
      console.error("End of day settings failed:", ex);
      showToast(ex && ex.code === "permission-denied"
        ? "Couldn't save. Check the app_settings Firestore rule has been published."
        : ex && ex.message && !ex.code ? ex.message : "Couldn't save. Try again.");
    }
    st.saving = false;
    draw();
  }

  /* ---------- Changes ---------- */

  root.addEventListener("input", (e) => {
    const el = e.target;
    const c = st.cfg;
    if (el.dataset.s === "kitCheck") { c.kitCheck = el.checked; markDirty(); return; }
    if (el.dataset.s === "prompt") { c.prompt = el.checked; markDirty(); return; }
    if (el.dataset.s === "remindBefore") { c.remindBefore = Number(el.value); markDirty(); return; }
    if (el.dataset.s === "finishTime") { c.finishTime = el.value; markDirty(); return; }
    if (el.dataset.set === "name") { curSet().name = el.value; markDirty(); drawTabs(); return; }
    if (el.dataset.roleChip !== undefined || el.dataset.person !== undefined) return;   // handled on change
    const box = el.closest(".eod-qe");
    const k = el.dataset.k;
    if (!box || !k || k === "type") return;
    const q = curList()[Number(box.dataset.i)];
    if (k === "required") q.required = el.checked;
    else if (k === "options") q.options = el.value.split("\n");
    else q[k] = el.value;
    markDirty();
    drawPreview();
  });

  root.addEventListener("change", (e) => {
    const el = e.target;
    const set = curSet();
    if (set && el.dataset.roleChip !== undefined) {
      const r = el.dataset.roleChip;
      set.roles = el.checked ? [...set.roles, r] : set.roles.filter((x) => x !== r);
      st.dirty = true;
      draw();
      return;
    }
    if (set && el.dataset.person !== undefined) {
      const id = el.dataset.person;
      set.staffIds = el.checked ? [...set.staffIds, id] : set.staffIds.filter((x) => x !== id);
      st.dirty = true;
      draw();
      return;
    }
    if (el.dataset.k !== "type") return;
    const q = curList()[Number(el.closest(".eod-qe").dataset.i)];
    q.type = el.value;
    st.dirty = true;
    draw();
  });

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) { st.tab = t.dataset.tab; draw(); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "save") { save(); return; }

    if (act === "add-set") {
      const x = { id: newSetId(), name: "", roles: [], staffIds: [], questions: copyQs(st.cfg.questions) };
      st.cfg.sets.push(x);
      st.tab = x.id;
      st.dirty = true;
      draw();
      root.querySelector('[data-set="name"]')?.focus();
      return;
    }
    if (act === "del-set") {
      const x = curSet();
      if (!x) return;
      if (!(await confirmDialog({ title: `Delete “${x.name || "this set"}”?`,
        message: "Its staff will answer Everyone's questions instead. Answers already given are kept.",
        confirmLabel: "Delete set", tone: "warning" }))) return;
      st.cfg.sets = st.cfg.sets.filter((y) => y.id !== x.id);
      st.tab = "all";
      st.dirty = true;
      draw();
      return;
    }
    if (act === "copy-all") {
      const x = curSet();
      if (!x) return;
      if (x.questions.length && !(await confirmDialog({ title: "Replace this set's questions?",
        message: "They'll be replaced with a copy of Everyone's questions.", confirmLabel: "Replace", tone: "warning" }))) return;
      x.questions = copyQs(st.cfg.questions);
      st.dirty = true;
      draw();
      return;
    }

    const list = curList();
    if (act === "add") {
      list.push({ id: newQid(), type: "short", label: "", help: "", required: false, options: [] });
      st.dirty = true;
      draw();
      const inputs = root.querySelectorAll(".eod-qe-label");
      inputs[inputs.length - 1]?.focus();
      return;
    }
    const box = b.closest(".eod-qe");
    if (!box) return;
    const i = Number(box.dataset.i);
    if (act === "up" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (act === "down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else if (act === "del") {
      if (list[i].label && !(await confirmDialog({ title: "Remove this question?", message: `“${list[i].label}”. Answers already given are kept.`,
        confirmLabel: "Remove", tone: "warning" }))) return;
      list.splice(i, 1);
    } else return;
    st.dirty = true;
    draw();
  });

  // Leaving with unsaved changes: ask first
  const guard = (e) => {
    if (!st.dirty || !root.isConnected) { window.removeEventListener("hashchange", guard, true); return; }
    if (location.hash.startsWith("#/tasks/end-of-day")) return;
    if (!confirm("You have unsaved End of day changes. Leave without saving?")) {
      history.replaceState(null, "", e.oldURL);
      e.stopImmediatePropagation();
    } else window.removeEventListener("hashchange", guard, true);
  };
  window.addEventListener("hashchange", guard, true);

  Promise.all([
    getEndOfDaySettings(),
    callApi({ action: "staffList" }).then((r) => r.staff || []).catch((err) => { console.warn("Staff list not loaded:", err); return []; }),
  ]).then(([cfg, people]) => {
    st.cfg = cfg;
    st.people = people.map((p) => ({ id: p.id, name: p.name, role: p.role || "" }));
    const roles = new Set(["Admin", ...st.people.map((p) => p.role).filter(Boolean)]);
    cfg.sets.forEach((x) => x.roles.forEach((r) => roles.add(r)));
    st.roles = [...roles].sort((a, b) => (a === "Admin" ? -1 : b === "Admin" ? 1 : a.localeCompare(b)));
    if (root.isConnected) draw();
  }).catch((err) => {
    console.error("End of day settings load failed:", err);
    if (root.isConnected) root.innerHTML = '<div class="tm-empty is-error">Couldn\'t load the End of day settings. Check the app_settings Firestore rule.</div>';
  });
}