// System configuration → Recording rules (Admins only)
import {
  getRules, saveRules, listRuleHistory, cleanRule, ruleProblem, newRuleId,
  RULE_TYPES, typeName, NOTE_SECTIONS, NOTE_TARGETS, TOKENS_HELP, wordsHeard, applySpellings, fillTokens,
  BUILTIN_ID, builtinRule,
} from "./recording-rules-api.js";
import { listStaffDetails } from "./staff-details.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SKELETON = '<div class="skeleton" style="height:240px;border-radius:14px"></div>';
const isAdmin = (staff) => /^admin$/i.test(String((staff && staff.role) || ""));
const sectionName = (k) => (NOTE_SECTIONS.find(([v]) => v === k) || NOTE_SECTIONS[0])[1];
const DUE = [[0, "Today"], [1, "Tomorrow"], [2, "In 2 days"], [7, "In a week"], [14, "In 2 weeks"], [30, "In a month"]];
const ico = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const TYPE_ICON = {
  words: ico('<path d="M3 21c3 0 7-1 7-8V5H3v7h4c0 4-2 6-4 6"/><path d="M14 21c3 0 7-1 7-8V5h-7v7h4c0 4-2 6-4 6"/>'),
  topic: ico('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  instruction: ico('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  spelling: ico('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
};
const TYPE_SHORT = {
  words: "Exact words or phrases, checked word for word",
  topic: "Gemini judges the meaning",
  instruction: "Tells Gemini how to write the notes",
  spelling: "Fixes misheard names and products",
};
const NAME_PH = {
  words: "e.g. Pregnancy or breastfeeding", topic: "e.g. Pregnancy or breastfeeding",
  instruction: "e.g. Units per area", spelling: "e.g. Injectable product names",
};
const when = (d) => (d ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const errText = (err) => (err && err.code === "permission-denied"
  ? "Couldn't save. Check the Firestore rules for recording_config have been published."
  : err && err.message && !err.code ? err.message : "Couldn't save. Check your connection and try again.");
const defaultActions = (type) => [{ type: "flag", text: type === "topic" ? "{What was said}" : "Mentioned: {Words heard}" }];

function openDialog(html, cls = "") {
  const dlg = document.createElement("dialog");
  dlg.className = `lh-dialog inv-dlg ${cls}`.trim();
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}
// "heard = correct" per line -> { pairs, bad }
function parsePairs(text) {
  let bad = 0;
  const pairs = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(.+?)\s*(?:=|→|->)\s*(.+)$/.exec(l);
    if (!m) { bad++; return null; }
    return { heard: m[1].trim(), correct: m[2].trim() };
  }).filter(Boolean);
  return { pairs, bad };
}

function ruleSummary(r) {
  if (r.type === "words") return `Hears: ${r.words.join(", ")}`;
  if (r.type === "topic") return `About: ${r.topic}`;
  if (r.type === "instruction") return `${sectionName(r.section)}: ${r.instruction}`;
  const p = r.pairs.map((x) => `${x.heard} → ${x.correct}`);
  return p.slice(0, 6).join(" · ") + (p.length > 6 ? ` · and ${p.length - 6} more` : "");
}

function actionText(a) {
  if (a.type === "flag") return "Highlights it in the notes";
  if (a.type === "note") return `Adds a line to ${a.section ? sectionName(a.section) : "the notes"}`;
  const who = a.assign === "staff" ? a.staffName || "a staff member" : a.assign === "anyone" ? "anyone" : "the clinician";
  const due = (DUE.find(([n]) => n === a.dueDays) || [0, `in ${a.dueDays} days`])[1].toLowerCase();
  return `Reminder for ${who}, due ${due}`;
}

export function mountRecordingSettings(container, { staff = null, embedded = false } = {}) {
  const root = document.createElement(embedded ? "div" : "section");
  root.className = embedded ? "rr-embed" : "page wide";
  container.replaceChildren(root);
  if (!isAdmin(staff)) {
    root.innerHTML = '<div class="state"><strong>No access</strong>Only Admins can change the system configuration.</div>';
    return;
  }

  const st = { rules: [], version: 0, updatedAt: null, updatedBy: "", staffList: [] };
  root.innerHTML = `
    <div class="fb-head${embedded ? " rr-subhead" : ""}">
      <div>${embedded ? "" : "<h2>System configuration</h2>"}
        <p class="muted">Recording rules: what happens when a consultation is recorded.</p></div>
      <div class="rr-head-acts">
        <button type="button" class="ff-btn" data-act="test">Test rules</button>
        <button type="button" class="ff-btn is-primary" data-act="add">+ Add rule</button>
      </div>
    </div>
    <div data-role="body">${SKELETON}</div>`;
  const body = root.querySelector('[data-role="body"]');
  
  async function load() {
    try {
      const [res, staffList] = await Promise.all([getRules(), listStaffDetails().catch(() => [])]);
      Object.assign(st, res, { staffList });
      if (root.isConnected) draw();
    } catch (err) {
      console.error("Recording rules failed:", err);
      if (root.isConnected) body.innerHTML = `<div class="tm-empty is-error">${err.code === "permission-denied"
        ? "Recording rules aren't accessible. Check the Firestore rules have been published." : "Couldn't load the rules. Try again."}</div>`;
    }
  }

  function ruleHtml(r) {
    const acts = (r.actions || []).map((a) => `<span class="inv-flag is-info">${esc(actionText(a))}</span>`).join("");
    return `<article class="rr-rule${r.enabled ? "" : " is-off"}" data-id="${esc(r.id)}">
      <div class="rr-rule-main"><strong>${esc(r.name)}</strong><small>${esc(ruleSummary(r))}</small>${acts ? `<div class="rr-acts">${acts}</div>` : ""}</div>
      <label class="fe-check rr-on"><input type="checkbox" data-act="toggle"${r.enabled ? " checked" : ""} /> On</label>
      <button type="button" class="lh-btn" data-act="edit">Edit</button>
      <button type="button" class="lh-btn is-quiet" data-act="delete">Delete</button>
    </article>`;
  }

  function draw() {
    body.innerHTML = `
      <p class="muted rr-intro">Rules run each time a recording is turned into notes, and changes apply from the next recording. ${
        st.version ? `Version ${st.version}${st.updatedBy ? `, saved by ${esc(st.updatedBy)}` : ""}${st.updatedAt ? ` on ${esc(when(st.updatedAt))}` : ""}.` : "No rules saved yet."}</p>
      ${RULE_TYPES.map(([type, name, hint]) => {
        const list = st.rules.filter((r) => r.type === type);
        return `<section class="tb-card rr-group">
          <div class="rr-group-head"><div><h4>${esc(name)}</h4><p class="muted">${esc(hint)}</p></div>
            <div class="rr-group-acts">${type === "spelling" && !st.rules.some((r) => r.id === BUILTIN_ID)
              ? '<button type="button" class="lh-btn" data-act="import-builtin">Import built-in spellings</button>' : ""}
              <button type="button" class="lh-btn" data-act="add" data-type="${type}">+ Add</button></div></div>
          ${list.length ? list.map(ruleHtml).join("") : '<p class="muted rr-none">None yet.</p>'}
        </section>`;
      }).join("")}
      <details class="tb-card rr-history" data-role="history"><summary>History and undo</summary><div data-role="hist">${SKELETON}</div></details>`;
  }

  async function commit(change, msg, note) {
    try {
      const res = await saveRules(change, staff, note);
      st.rules = res.rules;
      st.version = res.version;
      st.updatedBy = (staff && staff.name) || "";
      st.updatedAt = new Date();
      if (root.isConnected) draw();
      showToast(msg);
      return true;
    } catch (err) {
      console.error("Saving recording rules failed:", err);
      showToast(errText(err));
      if (root.isConnected) draw();
      return false;
    }
  }

  /* ---------- Add / edit a rule ---------- */

  function typeFields(d) {
    if (d.type === "words") {
      return `<label class="lh-field"><span class="lh-label">Words or phrases</span>
        <textarea class="fe-input" name="words" rows="4" placeholder="pregnant&#10;breastfeeding">${esc((d.words || []).join("\n"))}</textarea>
        <small class="fe-note">One per line. Whole words, any capitals. It fires whenever the word is said, even in “not pregnant”,
          so use “When the conversation is about…” when the meaning matters.</small></label>`;
    }
    if (d.type === "topic") {
      return `<label class="lh-field"><span class="lh-label">The conversation is about</span>
        <textarea class="fe-input" name="topic" rows="3" maxlength="600" placeholder="e.g. The patient is pregnant, trying to conceive, or breastfeeding">${esc(d.topic || "")}</textarea>
        <small class="fe-note">Describe it in plain words, as you would to a new staff member.</small></label>`;
    }
    if (d.type === "instruction") {
      return `<label class="lh-field"><span class="lh-label">Instruction</span>
          <textarea class="fe-input" name="instruction" rows="4" maxlength="1000" placeholder="e.g. Always list each area treated with the units used.">${esc(d.instruction || "")}</textarea>
          <small class="fe-note">Write it as you'd tell a scribe. It can't change the layout of the notes or the treatment plan.</small></label>`;
    }
      return `<label class="lh-field"><span class="lh-label">Words and spellings</span>
      <textarea class="fe-input" name="pairs" rows="6" placeholder="zeo min = Xeomin&#10;dys port = Dysport">${esc(d._pairLines ?? (d.pairs || []).map((p) => `${p.heard} = ${p.correct}`).join("\n"))}</textarea>
      <small class="fe-note">One per line: how it's often heard = how it should be written.</small></label>`;
  }

  function actionsHtml(d) {
    const get = (t) => (d.actions || []).find((a) => a.type === t);
    const f = get("flag"), r = get("reminder"), n = get("note");
    const assign = (r && r.assign) || "clinician";
    const due = r ? r.dueDays : 0;
    const dueOpts = DUE.some(([v]) => v === due) ? DUE : [...DUE, [due, `In ${due} days`]];
    return `<div class="lh-field"><span class="lh-label">What it does</span>
      <div class="rr-act">
        <label class="fe-check"><input type="checkbox" name="a_flag"${f ? " checked" : ""} /> Highlight it at the top of the notes</label>
        <div class="rr-act-body"${f ? "" : " hidden"}>
          <input class="fe-input" name="flag_text" maxlength="300" value="${esc(f ? f.text : "Mentioned: {Words heard}")}" placeholder="What the highlight says" />
        </div>
      </div>
      <div class="rr-act">
        <label class="fe-check"><input type="checkbox" name="a_reminder"${r ? " checked" : ""} /> Create a reminder</label>
        <div class="rr-act-body"${r ? "" : " hidden"}>
          <input class="fe-input" name="rem_text" maxlength="300" value="${esc(r ? r.text : "")}" placeholder="e.g. Check {Patient name}'s pregnancy status before injectables" />
          <div class="fe-two">
            <label class="lh-field"><span class="lh-label">For</span>
              <select class="fb-select" name="rem_assign">${[["clinician", "The clinician who recorded"], ["anyone", "Anyone"], ["staff", "A staff member"]].map(([v, l]) =>
                `<option value="${v}"${assign === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
            <label class="lh-field"><span class="lh-label">Due</span>
              <select class="fb-select" name="rem_due">${dueOpts.map(([v, l]) =>
                `<option value="${v}"${due === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          </div>
          <select class="fb-select" name="rem_staff"${assign === "staff" ? "" : " hidden"}>
            <option value="">Choose a staff member</option>
            ${st.staffList.map((s) => `<option value="${esc(s.id)}"${r && r.staffId === s.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="rr-act">
        <label class="fe-check"><input type="checkbox" name="a_note"${n ? " checked" : ""} /> Add a line to the notes</label>
        <div class="rr-act-body"${n ? "" : " hidden"}>
           <select class="fb-select" name="note_section">${NOTE_TARGETS.map(([k, l]) =>
            `<option value="${k}"${n && n.section === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
          <input class="fe-input" name="note_text" maxlength="300" value="${esc(n ? n.text : "")}" placeholder="e.g. Patient reports breastfeeding: {What was said}" />
        </div>
      </div>
      <small class="fe-note">${esc(TOKENS_HELP)}</small></div>`;
  }

  const nameField = (d) => `<label class="lh-field"><span class="lh-label">Name</span>
    <input class="fe-input" name="rname" maxlength="100" value="${esc(d.name || "")}" placeholder="${esc(NAME_PH[d.type] || "")}" /></label>`;
  const sectionField = (d) => `<label class="lh-field"><span class="lh-label">Section</span>
    <select class="fb-select" name="section">${NOTE_SECTIONS.map(([k, l]) =>
      `<option value="${k}"${(d.section || "") === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;

  function editorHtml(d, isNew) {
    const acts = d.type === "words" || d.type === "topic";
    return `
      <header class="rr-dlg-head">
        <div>
          <h3>${isNew ? "New rule" : "Edit rule"}</h3>
          <p>${isNew ? "Choose the kind of rule, then fill in the details." : `${TYPE_ICON[d.type] || ""}${esc(typeName(d.type))}`}</p>
        </div>
        <button type="button" class="rr-x" data-act="cancel" aria-label="Close">×</button>
      </header>

      <div class="rr-dlg-body">
        ${isNew ? `<fieldset class="rr-typegrid"><legend class="lh-label">Type of rule</legend>
          ${RULE_TYPES.map(([k, l]) => `
            <label class="rr-typecard${d.type === k ? " is-on" : ""}">
              <input type="radio" name="rtype" value="${k}"${d.type === k ? " checked" : ""} />
              <span class="rr-typeicon">${TYPE_ICON[k]}</span>
              <span class="rr-typetext"><strong>${esc(l)}</strong><small>${esc(TYPE_SHORT[k])}</small></span>
            </label>`).join("")}
        </fieldset>` : ""}

        ${d.type === "instruction" ? `<div class="rr-row">${nameField(d)}${sectionField(d)}</div>` : nameField(d)}
        ${typeFields(d)}
        ${acts ? actionsHtml(d) : ""}
        <p class="lh-error" role="alert" hidden></p>
      </div>

      <footer class="rr-dlg-foot">
        <label class="rr-switch"><input type="checkbox" name="enabled"${d.enabled !== false ? " checked" : ""} /><span></span> Rule is on</label>
        <div class="rr-foot-btns">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save rule</button>
        </div>
      </footer>`;
  }

  // Reads what's on the form; anything not on it keeps its value from `base`
  function readForm(form, base) {
    const E = form.elements;
    const d = { ...base };
    if (E.rname) d.name = E.rname.value;
    if (E.enabled) d.enabled = E.enabled.checked;
    if (E.words) d.words = E.words.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (E.topic) d.topic = E.topic.value;
    if (E.instruction) { d.instruction = E.instruction.value; d.section = E.section.value; }
    if (E.pairs) { d._pairLines = E.pairs.value; d.pairs = parsePairs(E.pairs.value).pairs; }
    if (E.a_flag) {
      const acts = [];
      if (E.a_flag.checked) acts.push({ type: "flag", text: E.flag_text.value });
      if (E.a_reminder.checked) {
        const sid = E.rem_staff.value;
        const s = st.staffList.find((x) => x.id === sid);
        acts.push({ type: "reminder", text: E.rem_text.value, assign: E.rem_assign.value, staffId: sid,
          staffName: s ? s.name : "", dueDays: Number(E.rem_due.value) || 0 });
      }
      if (E.a_note.checked) acts.push({ type: "note", text: E.note_text.value, section: E.note_section.value });
      d.actions = acts;
    }
    return d;
  }

  function openEditor(rule, type) {
    const isNew = !rule;
    let draft = rule ? JSON.parse(JSON.stringify(rule)) : {
      id: newRuleId(), type, name: "", enabled: true, words: [], topic: "", section: "", instruction: "", pairs: [],
      actions: type === "words" || type === "topic" ? defaultActions(type) : [],
    };
    const dlg = openDialog('<form class="rr-form" novalidate></form>', "rr-dlg");
    const form = dlg.querySelector("form");
    const render = () => { form.innerHTML = editorHtml(draft, isNew); };
    render();

    form.addEventListener("click", (e) => { if (e.target.closest('[data-act="cancel"]')) dlg.close(); });
    form.addEventListener("change", (e) => {
      const t = e.target;
      if (t.name === "rtype") {
        draft = { ...readForm(form, draft), type: t.value };
        if ((draft.type === "words" || draft.type === "topic") && !(draft.actions || []).length) draft.actions = defaultActions(draft.type);
        render();
        return;
      }
      if (/^a_/.test(t.name)) {
        const b = t.closest(".rr-act").querySelector(".rr-act-body");
        if (b) b.hidden = !t.checked;
      }
      if (t.name === "rem_assign") form.elements.rem_staff.hidden = t.value !== "staff";
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = form.querySelector(".lh-error");
      const d = readForm(form, draft);
      const bad = form.elements.pairs ? parsePairs(form.elements.pairs.value).bad : 0;
      const clean = cleanRule(d);
      const problem = bad ? `${bad} line${bad === 1 ? " needs" : "s need"} to be written as heard = correct.` : ruleProblem(clean);
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      const ok = await commit(
        (rules) => (rules.some((x) => x.id === clean.id) ? rules.map((x) => (x.id === clean.id ? clean : x)) : [...rules, clean]),
        "Rule saved", `${isNew ? "Added" : "Changed"}: ${clean.name}`);
      if (ok) dlg.close(); else btn.disabled = false;
    });
    const first = form.querySelector('[name="rname"]');
    if (first) first.focus();
  }

  /* ---------- Test rules ---------- */

  function testResults(text) {
    const on = st.rules.filter((r) => r.enabled);
    const { text: fixed, fixes } = applySpellings(on, text);
    const sentences = fixed.split(/(?<=[.!?])\s+|\n+/);
    const fired = on.filter((r) => r.type === "words").map((r) => {
      const heard = wordsHeard(r, fixed);
      if (!heard.length) return "";
      const said = (sentences.find((s) => wordsHeard({ words: heard }, s).length) || "").trim();
      const vals = { "patient name": "the patient", "words heard": heard.join(", "), "what was said": said };
      return `<li><strong>${esc(r.name)}</strong> would fire (heard: ${esc(heard.join(", "))})
        <ul>${r.actions.map((a) => `<li>${esc(actionText(a))}${a.text ? `: “${esc(fillTokens(a.text, vals))}”` : ""}</li>`).join("")}</ul></li>`;
    }).filter(Boolean);
    const topics = on.filter((r) => r.type === "topic").length;
    const instr = on.filter((r) => r.type === "instruction").length;
    return `
      <p><strong>Spellings:</strong> ${fixes ? `${fixes} correction${fixes === 1 ? "" : "s"} would be made.` : "nothing to correct."}</p>
      <p><strong>When it hears…:</strong> ${fired.length ? "" : "no rules would fire."}</p>
      ${fired.length ? `<ul>${fired.join("")}</ul>` : ""}
      ${topics ? `<div class="rr-topics"><p class="muted">${topics} “When the conversation is about…” rule${topics === 1 ? "" : "s"}: Gemini checks the meaning, using the rules as they're saved now.</p>
        <button type="button" class="lh-btn" data-act="topics">Check with Gemini</button><div data-role="topics-out"></div></div>` : ""}
      ${instr ? `<p class="muted">${instr} note-writing instruction${instr === 1 ? " is" : "s are"} always added when notes are written.</p>` : ""}
      <p class="muted">Spellings are fixed first, so words rules also match the corrected spelling.</p>`;
  }

  async function checkTopics(btn, text) {
    const out = btn.parentElement.querySelector('[data-role="topics-out"]');
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const res = await callApi({ action: "recordingRules", op: "test", text: text.slice(0, 50000) });
      const hits = (res.matches || []).map((m) => ({ m, r: st.rules.find((x) => x.id === m.ruleId) })).filter((x) => x.r);
      out.innerHTML = hits.length
        ? `<ul>${hits.map(({ m, r }) => `<li><strong>${esc(r.name)}</strong> would fire${m.quote ? `: “${esc(m.quote)}”` : ""}
            <ul>${(r.actions || []).map((a) => `<li>${esc(actionText(a))}</li>`).join("")}</ul></li>`).join("")}</ul>`
        : '<p class="muted">No topic rules would fire.</p>';
    } catch (err) {
      console.error("Topic test failed:", err);
      out.innerHTML = `<p class="muted">${esc(err.code === "FORBIDDEN" ? "Only Admins can test rules."
        : err.code === "GEMINI_FAILED" ? "Gemini couldn't check them just now. Try again."
        : "Couldn't check the topic rules. Make sure the Apps Script update is deployed.")}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Check with Gemini";
    }
  }

  function openTester() {
    const dlg = openDialog(`
      <div class="lh-form rr-test">
        <div class="lh-dialog-head"><h3>Test rules</h3><p>Paste part of a consultation. Nothing is saved and no reminders are created.</p></div>
        <textarea class="fe-input" rows="8" data-role="text" placeholder="e.g. She mentioned she's still breastfeeding, so we'll hold off on the zeo min today."></textarea>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="close">Close</button>
          <button type="button" class="lh-btn is-primary" data-act="run">Test</button>
        </div>
        <div class="rr-test-out" data-role="out"></div>
      </div>`);
    const ta = dlg.querySelector('[data-role="text"]');
    const out = dlg.querySelector('[data-role="out"]');
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="close"]')) dlg.close();
      const tb = e.target.closest('[data-act="topics"]');
      if (tb) { checkTopics(tb, ta.value); return; }
      if (e.target.closest('[data-act="run"]')) {
        out.innerHTML = ta.value.trim() ? testResults(ta.value) : '<p class="muted">Paste some text first.</p>';
      }
    });
    ta.focus();
  }

  /* ---------- History ---------- */

  async function loadHistory(el) {
    try {
      const list = await listRuleHistory();
      el._list = list;
      el.innerHTML = list.length ? `<div class="rp-scroll"><table class="inv-table rp-table">
        <thead><tr><th>Version</th><th>Saved</th><th>By</th><th>Change</th><th></th></tr></thead>
        <tbody>${list.map((h) => `<tr><td>${h.version}</td><td>${esc(when(h.at))}</td><td>${esc(h.by || "—")}</td><td>${esc(h.note || "—")}</td>
          <td>${h.version === st.version ? '<span class="inv-flag is-ok">Current</span>'
            : `<button type="button" class="lh-btn" data-restore="${h.version}">Restore</button>`}</td></tr>`).join("")}</tbody></table></div>`
        : '<p class="muted">No history yet.</p>';
    } catch (err) {
      console.error("Rule history failed:", err);
      el.innerHTML = '<p class="muted">Couldn\'t load the history.</p>';
    }
  }

  /* ---------- Events ---------- */

  root.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="import-builtin"]')) {
      const ok = await confirmDialog({
        title: "Import the built-in spellings?",
        message: "The Recorder's fixed corrections (for example botox → Wrinkle Relaxer, HIFU → Skin Lifting) become a rule you can edit here. " +
          "From the next recording, this rule is used instead of the fixed list.",
        confirmLabel: "Import",
      });
      if (ok) commit((rules) => (rules.some((r) => r.id === BUILTIN_ID) ? rules : [...rules, builtinRule()]),
        "Built-in spellings imported", "Imported built-in spellings");
      return;
    }
    const add = e.target.closest('[data-act="add"]');
    if (add) { openEditor(null, add.dataset.type || "words"); return; }
    if (e.target.closest('[data-act="test"]')) { openTester(); return; }

    const restore = e.target.closest("[data-restore]");
    if (restore) {
      const el = restore.closest('[data-role="hist"]');
      const h = el && (el._list || []).find((x) => x.version === Number(restore.dataset.restore));
      if (!h) return;
      const ok = await confirmDialog({
        title: `Restore version ${h.version}?`,
        message: "The rules go back to how they were in that version. The current rules stay in the history, so you can undo this too.",
        confirmLabel: "Restore",
      });
      if (ok) commit(() => h.rules, `Restored version ${h.version}`, `Restored version ${h.version}`);
      return;
    }

    const card = e.target.closest(".rr-rule[data-id]");
    const rule = card && st.rules.find((r) => r.id === card.dataset.id);
    if (!rule) return;
    if (e.target.closest('[data-act="edit"]')) { openEditor(rule); return; }
    if (e.target.closest('[data-act="delete"]')) {
      const ok = await confirmDialog({
        title: `Delete “${rule.name}”?`,
        message: rule.id === BUILTIN_ID
          ? "The Recorder's fixed list will be used again. To stop these corrections, switch the rule off instead of deleting it."
          : "It stops applying to new recordings. You can bring it back from History and undo.",
        confirmLabel: "Delete rule",
        tone: "danger",
      });
      if (ok) commit((rules) => rules.filter((r) => r.id !== rule.id), "Rule deleted", `Deleted: ${rule.name}`);
    }
  });

  root.addEventListener("change", (e) => {
    if (e.target.dataset.act !== "toggle") return;
    const card = e.target.closest(".rr-rule[data-id]");
    const rule = card && st.rules.find((r) => r.id === card.dataset.id);
    if (!rule) return;
    const on = e.target.checked;
    commit((rules) => rules.map((r) => (r.id === rule.id ? { ...r, enabled: on } : r)),
      on ? "Rule switched on" : "Rule switched off", `${on ? "Switched on" : "Switched off"}: ${rule.name}`);
  });

  root.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.matches && d.matches('details[data-role="history"]') && d.open) loadHistory(d.querySelector('[data-role="hist"]'));
  }, true);

  load();
}