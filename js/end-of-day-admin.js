// Settings → End of Day: the kit count, the reminder, and the questions staff answer when they end their day.
// Questions come in presets (saved as "sets"): Everyone, plus presets given to roles or to particular people.
// A person gets the preset given to them by name, then their role's, otherwise Everyone's.
import { EOD_TYPES, MOODS, getEndOfDaySettings, saveEndOfDaySettings, newQid, newSetId, setFor } from "./end-of-day-api.js";
import { callApi } from "./appointments.js";
import { can } from "./perms.js";
import { confirmDialog } from "./dialog.js";
import { escapeHtml, showToast } from "./utils.js";

const esc = (s) => escapeHtml(String(s ?? ""));
const firstName = (n) => String(n || "").trim().replace(/^(dr|prof)\.?\s+/i, "").split(/\s+/)[0] || "Jane";
const copyQs = (list) => list.map((q) => ({ ...q, id: newQid(), options: [...(q.options || [])] }));
const ALL = "all";
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

export function mountEndOfDaySettings(container, { staff = null } = {}) {
  const root = document.createElement("div");
  root.className = "eod-admin";
  container.replaceChildren(root);
  if (!can("eod.manage")) {
    root.innerHTML = `<p class="sds-empty">You don't have access to set up End of Day. Ask an admin to tick
      "End of Day: set up the questions" for you in Staff → Roles and access.</p>`;
    return;
  }
  const st = { cfg: null, dirty: false, saving: false, tab: ALL, people: [], roles: [] };
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';

  const curSet = () => (st.tab === ALL ? null : st.cfg.sets.find((x) => x.id === st.tab) || null);
  const curList = () => { const x = curSet(); return x ? x.questions : st.cfg.questions; };
  // set = null: the people on Everyone's questions
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
  const statusText = () => (st.dirty ? "Unsaved changes" : "All changes saved");

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
      ${q.type === "taskflags" ? `<small class="muted">Lists each task from the nearest <b>Task list</b> question above this one.
        Staff mark each Fine, Challenging or Need help.</small>` : ""}
      <div class="eod-qe-acts">
        <button type="button" class="lh-btn is-quiet" data-act="up" aria-label="Move up"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="lh-btn is-quiet" data-act="down" aria-label="Move down"${i === n - 1 ? " disabled" : ""}>↓</button>
        <button type="button" class="lh-btn is-quiet" data-act="del">Remove</button>
      </div>
    </div>`;

  // The preset bar: the same as Start of Day's
  const tabsHtml = () => {
    const tab = (id, title, sub, n) => {
      const who = whoGets(id === ALL ? null : st.cfg.sets.find((x) => x.id === id)).length;
      return `<button type="button" role="tab" class="sds-tab${st.tab === id ? " is-on" : ""}" data-tab="${esc(id)}" aria-selected="${st.tab === id}">
        <b>${esc(title)}</b><small>${esc(sub)}</small>
        <span>${n} question${n === 1 ? "" : "s"} · ${who} ${who === 1 ? "person" : "people"}</span></button>`;
    };
    return tab(ALL, "Everyone", "Anyone not in a preset", st.cfg.questions.length) +
      st.cfg.sets.map((x) => tab(x.id, x.name || "New preset", givenText(x), x.questions.length)).join("") +
      `<button type="button" class="sds-tab is-add" data-act="add-set"><b>${PLUS} New preset</b><small>For a role or particular people</small></button>`;
  };

  const whoHtml = (set) => {
    const list = whoGets(set);
    return `<div class="sds-who"><b>${list.length} ${list.length === 1 ? "person gets" : "people get"} these questions</b>${list.length
      ? `<div class="sds-who-names">${list.map((p) => `<span title="${esc(p.role)}">${esc(p.name)}</span>`).join("")}</div>`
      : `<small class="sds-muted">${set ? "Tick a role or a person above." : "Everyone is in a preset."}</small>`}</div>`;
  };

  const presetHtml = () => {
    const x = curSet();
    if (!x) {
      return `<div class="sds-setbox is-all"><p class="sds-hint">Everyone who isn't in a preset answers these questions.
        Someone given a preset by name gets it whatever their role.</p>${whoHtml(null)}</div>`;
    }
    const chip = (attr, val, label, own, sub) => {
      const mine = !!own && own.id === x.id;
      const taken = !!own && !mine;
      return `<label class="sds-chip${taken ? " is-taken" : ""}${mine ? " is-on" : ""}">
        <input type="checkbox" ${attr}="${esc(val)}"${mine ? " checked" : ""}${taken ? " disabled" : ""}>
        <span>${esc(label)}</span>${taken ? `<em>in ${esc(own.name || "another preset")}</em>` : sub ? `<em>${esc(sub)}</em>` : ""}</label>`;
    };
    return `<div class="sds-setbox">
      <div class="sds-setgrid">
        <label class="sds-f"><span>Preset name</span>
          <input type="text" data-set="name" maxlength="60" placeholder="e.g. Reception" value="${esc(x.name)}"></label>
        <div class="sds-f"><span>Given to these roles</span>
          <div class="sds-chips2">${st.roles.map((r) => chip("data-role-chip", r, r, roleOwner(r))).join("")
            || '<small class="sds-muted">No roles found.</small>'}</div></div>
      </div>
      <details class="sds-people"${x.staffIds.length ? " open" : ""}>
        <summary>And these people <small>${x.staffIds.length ? `${x.staffIds.length} chosen · ` : ""}they get this preset whatever their role</small></summary>
        <div class="sds-chips2">${st.people.map((p) => chip("data-person", p.id, p.name, personOwner(p.id), p.role)).join("")
          || '<small class="sds-muted">The staff list couldn\'t be loaded.</small>'}</div>
      </details>
      ${whoHtml(x)}
      <div class="sds-setacts">
        <button type="button" class="sds-btn is-quiet" data-act="copy-all">Copy Everyone's questions</button>
        <button type="button" class="sds-btn is-quiet" data-act="dup-set">Duplicate</button>
        <button type="button" class="sds-btn is-quiet is-dangertext" data-act="del-set">Delete this preset</button>
      </div>
    </div>`;
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
      case "tasks": input = `<div class="eod-pv-box is-long eod-pv-lines"><span>Confirmed tomorrow's bookings</span>
        <span>Called the recall list</span></div>`; break;
      case "taskflags": input = `<div class="eod-tflags">${[["Confirmed tomorrow's bookings", "ok"], ["Called the recall list", "help"]]
        .map(([t, on]) => `<div class="eod-tf-row"><span class="eod-tf-task">${t}</span><div class="eod-tf-opts">${
          [["ok", "Fine"], ["hard", "Challenging"], ["help", "Need help"]].map(([v, l]) =>
            `<span class="eod-tf-opt is-${v}"><input type="radio" disabled${v === on ? " checked" : ""} /><span>${l}</span></span>`).join("")
        }</div></div>`).join("")}</div>`; break;
      default: input = '<div class="eod-pv-box"></div>';
    }
    return `<div class="eod-q eod-pv-q">${head}${input}</div>`;
  };

  const previewHtml = () => {
    const list = curList();
    const people = whoGets(curSet());
    return `<div class="eod-pv-label">What they'll see</div>
      <div class="eod-pv">
        <div class="eod-pv-head"><b>End of day</b><span>Thanks for today, ${esc(firstName(people[0] && people[0].name))}.</span></div>
        <div class="eod-pv-body">${list.length ? list.map(pvQ).join("") : '<p class="muted">No questions. They just end their day.</p>'}</div>
        <div class="eod-pv-acts"><span>Not yet</span><span class="is-pri">Save</span></div>
      </div>`;
  };

  /* ---------- The page ---------- */

  function draw() {
    const c = st.cfg;
    const list = curList();
    const y = window.scrollY;
    root.innerHTML = `
      <div class="sds">
        <div class="sds-head">
          <div>
            <h2 class="sds-h">End of Day</h2>
            <p class="sds-sub">What staff are asked when they click <strong>End my day</strong>.
              Admins see the answers on My dashboard → Start &amp; end of day.</p>
          </div>
          <div class="sds-top-acts">
            <span class="sds-status${st.dirty ? " is-dirty" : ""}" data-role="state">${statusText()}</span>
            <button type="button" class="sds-btn is-primary" data-act="save"${st.saving ? " disabled" : ""}>${st.saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>

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
          <p class="muted">Everyone answers <b>Everyone</b>'s questions, unless a preset is given to their role or to them by name.</p></div>
        <div class="sds eod-presets">
          <div class="sds-tabs" role="tablist" data-role="tabs">${tabsHtml()}</div>
          ${presetHtml()}
        </div>
        <div class="eod-split">
          <div class="eod-editor">
            ${list.length ? list.map((q, i) => qHtml(q, i, list.length)).join("")
              : '<p class="tb-none">No questions. These staff will only do the kit count (injectors), or just end their day.</p>'}
            <button type="button" class="ff-btn" data-act="add">+ Add a question</button>
          </div>
          <aside class="eod-preview" data-role="pv">${previewHtml()}</aside>
        </div>
      </section>`;
    window.scrollTo(0, y);
  }

  const drawPreview = () => { const el = root.querySelector('[data-role="pv"]'); if (el) el.innerHTML = previewHtml(); };
  const drawTabs = () => { const el = root.querySelector('[data-role="tabs"]'); if (el) el.innerHTML = tabsHtml(); };

  function markDirty() {
    st.dirty = true;
    const s = root.querySelector('[data-role="state"]');
    if (s) { s.textContent = statusText(); s.classList.add("is-dirty"); }
  }
  const changed = () => { st.dirty = true; draw(); };

  async function save() {
    if (st.saving) return;
    // A preset needs a name and someone given to it
    for (const x of st.cfg.sets) {
      if (!String(x.name || "").trim()) {
        st.tab = x.id; draw(); showToast("Give this preset a name.");
        root.querySelector('[data-set="name"]')?.focus();
        return;
      }
      if (!x.roles.length && !x.staffIds.length) {
        st.tab = x.id; draw(); showToast(`"${x.name}" isn't given to anyone yet. Tick a role or a person.`);
        return;
      }
    }
    // Every question needs wording, and a choice question its choices
    for (const [id, list] of [[ALL, st.cfg.questions], ...st.cfg.sets.map((x) => [x.id, x.questions])]) {
      const i = list.findIndex((q) => !String(q.label || "").trim()
        || (q.type === "choice" && !(q.options || []).some((o) => String(o).trim())));
      if (i < 0) continue;
      st.tab = id;
      draw();
      const blank = !String(list[i].label || "").trim();
      showToast(blank ? `Question ${i + 1} has no wording. Write it, or remove the question.` : `Add the choices for question ${i + 1}.`);
      root.querySelector(`.eod-qe[data-i="${i}"] ${blank ? '[data-k="label"]' : '[data-k="options"]'}`)?.focus();
      return;
    }
    st.saving = true;
    draw();
    try {
      st.cfg = await saveEndOfDaySettings(st.cfg, staff);
      if (st.tab !== ALL && !st.cfg.sets.some((x) => x.id === st.tab)) st.tab = ALL;
      st.dirty = false;
      showToast("End of Day saved. Staff get it the next time they end their day.");
    } catch (ex) {
      console.error("End of day settings failed:", ex);
      showToast(ex && ex.code === "permission-denied"
        ? "Couldn't save: check the app_settings Firestore rule is published, and that you have the End of Day tick."
        : ex && ex.message && !ex.code ? ex.message : "Couldn't save. Check your connection and try again.");
    }
    st.saving = false;
    draw();
  }

  /* ---------- Changes ---------- */

  root.addEventListener("input", (e) => {
    const el = e.target;
    const c = st.cfg;
    if (!c) return;
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
      changed();
      return;
    }
    if (set && el.dataset.person !== undefined) {
      const id = el.dataset.person;
      set.staffIds = el.checked ? [...set.staffIds, id] : set.staffIds.filter((x) => x !== id);
      changed();
      return;
    }
    if (el.dataset.k !== "type") return;
    const q = curList()[Number(el.closest(".eod-qe").dataset.i)];
    q.type = el.value;
    changed();
  });

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) { st.tab = t.dataset.tab; draw(); return; }
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "save") { save(); return; }

    if (act === "add-set") {
      const x = { id: newSetId(), name: "", roles: [], staffIds: [], questions: copyQs(st.cfg.questions) };
      st.cfg.sets.push(x);
      st.tab = x.id;
      changed();
      root.querySelector('[data-set="name"]')?.focus();
      return;
    }
    if (act === "dup-set") {
      const x = curSet();
      if (!x) return;
      const nx = { id: newSetId(), name: `${x.name || "Preset"} (copy)`.slice(0, 60), roles: [], staffIds: [], questions: copyQs(x.questions) };
      st.cfg.sets.splice(st.cfg.sets.indexOf(x) + 1, 0, nx);
      st.tab = nx.id;
      changed();
      showToast("Copied. Give it a name and choose who gets it.");
      return;
    }
    if (act === "del-set") {
      const x = curSet();
      if (!x) return;
      if (!(await confirmDialog({ title: `Delete "${x.name || "this preset"}"?`,
        message: "Its staff will answer their role's preset, or Everyone's, once you save. Answers already given are kept.",
        confirmLabel: "Delete preset", tone: "warning" }))) return;
      st.cfg.sets = st.cfg.sets.filter((y) => y.id !== x.id);
      st.tab = ALL;
      changed();
      return;
    }
    if (act === "copy-all") {
      const x = curSet();
      if (!x) return;
      if (x.questions.length && !(await confirmDialog({ title: "Replace this preset's questions?",
        message: "They'll be replaced with a copy of Everyone's questions.", confirmLabel: "Replace", tone: "warning" }))) return;
      x.questions = copyQs(st.cfg.questions);
      changed();
      return;
    }

    const list = curList();
    if (act === "add") {
      list.push({ id: newQid(), type: "short", label: "", help: "", required: false, options: [] });
      changed();
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
      if (list[i].label && !(await confirmDialog({ title: "Remove this question?", message: `"${list[i].label}". Answers already given are kept.`,
        confirmLabel: "Remove", tone: "warning" }))) return;
      list.splice(i, 1);
    } else return;
    changed();
  });

  // Leaving with unsaved changes: ask first, in the portal's own dialog
  const guard = (e) => {
    if (!root.isConnected) { window.removeEventListener("hashchange", guard, true); return; }
    if (!st.dirty || /^#\/settings\/eod\/?$/.test(location.hash)) return;
    e.stopImmediatePropagation();
    const to = location.hash;
    history.replaceState(null, "", e.oldURL);
    confirmDialog({ title: "Leave without saving?", message: "Your End of Day changes haven't been saved.",
      confirmLabel: "Leave", tone: "warning" }).then((ok) => { if (ok) { st.dirty = false; location.hash = to; } });
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
    if (root.isConnected) root.innerHTML = '<p class="sds-empty">Couldn\'t load the End of Day settings. Check your connection and the app_settings Firestore rule.</p>';
  });
}