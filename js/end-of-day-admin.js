// Task Manager → End of day: who sees "End my day", the kit count, and the questions.
import { EOD_TYPES, getEndOfDaySettings, saveEndOfDaySettings, newQid } from "./end-of-day-api.js";
import { can } from "./perms.js";
import { confirmDialog } from "./dialog.js";
import { escapeHtml as esc, showToast } from "./utils.js";

export function mountEndOfDaySettings(container, { staff = null, embedded = false } = {}) {
  const root = document.createElement("section");
  root.className = embedded ? "eod-admin" : "page";
  container.replaceChildren(root);
  if (!can("tasks.build")) {
    root.innerHTML = '<div class="state"><strong>No access</strong>Ask an Admin for Build tasks access in Staff.</div>';
    return;
  }
  const st = { cfg: null, dirty: false, saving: false };
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';

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

  function draw() {
    const c = st.cfg;
    root.innerHTML = `
      ${embedded
        ? `<h3 class="tm-h">End of day</h3>
           <p class="muted tm-sub">What staff are asked when they click <strong>End my day</strong> under their profile.
             Answers show in Reporting → Start &amp; end of day.</p>`
        : `<a class="ff-btn is-quiet eod-back" href="#/tasks">← Task Manager</a>
           <div class="fb-head"><div><h2>End of day</h2>
             <p class="muted">What staff are asked when they click <strong>End my day</strong> under their profile.
               Answers show in Reporting → Start &amp; end of day.</p></div></div>`}
      <section class="tb-card eod-set">
        <h4>Who sees End my day</h4>
        <div class="fe-seg">${[["all", "Everyone"], ["injectors", "Injectors only"]].map(([v, l]) =>
          `<label class="fe-seg-btn"><input type="radio" name="eod-who" data-s="who" value="${v}"${c.who === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
        <label class="fe-check"><input type="checkbox" data-s="kitCheck"${c.kitCheck ? " checked" : ""} />
          Injectors count their kit (units left) before answering</label>
      </section>
      <section class="tb-card">
        <h4>Questions</h4>
        ${c.questions.length ? c.questions.map((q, i) => qHtml(q, i, c.questions.length)).join("")
          : '<p class="tb-none">No questions. Staff will only do the kit count (injectors), or just end their day.</p>'}
        <button type="button" class="ff-btn" data-act="add">+ Add a question</button>
      </section>
      <div class="eod-savebar">
        <span class="muted" data-role="state">${st.dirty ? "Unsaved changes" : "All changes saved"}</span>
        <button type="button" class="ff-btn is-primary" data-act="save"${st.dirty && !st.saving ? "" : " disabled"}>${st.saving ? "Saving…" : "Save changes"}</button>
      </div>`;
  }

  function markDirty() {
    st.dirty = true;
    root.querySelector('[data-role="state"]').textContent = "Unsaved changes";
    root.querySelector('[data-act="save"]').disabled = false;
  }

  async function save() {
    st.saving = true;
    draw();
    try {
      st.cfg = await saveEndOfDaySettings(st.cfg, staff);
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

  root.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.s === "kitCheck") { st.cfg.kitCheck = el.checked; markDirty(); return; }
    if (el.dataset.s === "who") { st.cfg.who = el.value; markDirty(); return; }
    const box = el.closest(".eod-qe");
    const k = el.dataset.k;
    if (!box || !k || k === "type") return;
    const q = st.cfg.questions[Number(box.dataset.i)];
    if (k === "required") q.required = el.checked;
    else if (k === "options") q.options = el.value.split("\n");
    else q[k] = el.value;
    markDirty();
  });
  root.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.k !== "type") return;
    const q = st.cfg.questions[Number(el.closest(".eod-qe").dataset.i)];
    q.type = el.value;
    st.dirty = true;
    draw();
  });
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "save") { save(); return; }
    const list = st.cfg.questions;
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
    if (!st.dirty || !root.isConnected) { window.removeEventListener("hashchange", guard); return; }
    if (location.hash.startsWith("#/tasks/end-of-day")) return;
    if (!confirm("You have unsaved End of day changes. Leave without saving?")) {
      history.replaceState(null, "", e.oldURL);
      e.stopImmediatePropagation();
    } else window.removeEventListener("hashchange", guard);
  };
  window.addEventListener("hashchange", guard, true);
  
  getEndOfDaySettings()
    .then((cfg) => { st.cfg = cfg; if (root.isConnected) draw(); })
    .catch((err) => {
      console.error("End of day settings load failed:", err);
      if (root.isConnected) root.innerHTML = '<div class="tm-empty is-error">Couldn\'t load the End of day settings. Check the app_settings Firestore rule.</div>';
    });
}