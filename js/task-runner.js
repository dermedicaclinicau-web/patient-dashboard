// Running a task: who it's for, the details, the ready-written email, then send.
// Route: #/tasks/run/<taskId>            (from Task Manager)
//        #/tasks/run/<taskId>/<patientId> (from the patient page's Email button)
import { getTaskType, fetchStaffList, TASK_CHOICE_TYPES, parseAttachment } from "./task-types.js";
import { printablePdf, savedFormPdf, previewSavedForm } from "./form-delivery.js";
import { getSubmission, listSubmissionsForPatient } from "./form-submissions.js";
import { getPatient, patientIds } from "./patients.js";
import { mountFormFill } from "./form-fill.js";
import { loadSource } from "./task-sources.js";
import { fetchPreconsult, callApi } from "./appointments.js";
import { fetchTranscriptRecords, latestTreatmentPlan } from "./transcripts.js";
import { getLetterhead, listPublishedForms } from "./form-templates.js";
import { db } from "./firebase-config.js";
import { collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast, formatDobLong, formatMobile } from "./utils.js";
import { formatChoice, fillTemplate, fillTemplateHtml, emailShell, clinicDetails, EMAIL_RE } from "./task-tokens.js";
import { createRichEditor } from "./rich-editor.js";
import { openImagePicker } from "./image-bank.js";
import { upcomingAppointments, formatUpcoming, apptWhen, apptDetail, niceDay } from "./upcoming-appts.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  ext: ic('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  search: ic('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  x: ic('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  user: ic('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
};
const CAT_LABEL = { patient: "To Patient", staff: "To Staff" };
const todayLong = () => new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : (key || "");
};
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const SP_KEYS = ["specialist name", "specialist speciality", "specialist practice", "specialist email", "specialist phone", "specialist address"];

function runError(err) {
  switch (err && err.code) {
    case "UNAUTHORIZED": return "Your session has expired. Log out and back in, then try again.";
    case "TASK_NOT_LIVE": return "This task has been unpublished. Ask an admin to publish it again.";
    case "NO_PATIENT": return "Choose the patient first.";
    case "NO_RECIPIENTS": return "None of the chosen staff have an email address on file.";
    case "BAD_EMAIL": return "Check the email addresses and try again.";
    case "RATE_LIMITED": return "You've sent a lot of emails in the last hour. Try again a little later.";
    case "QUOTA": return "The clinic's email limit for today has been reached. Try again tomorrow.";
    case "PDF_FAILED": return "One of the attachments couldn't be prepared. Try again.";
    case "INVALID_PIN": return "The server hasn't been updated yet. In Apps Script, deploy a new version.";
    case "SERVER_ERROR": return "The server hit an error. Check Apps Script → Executions for details.";
    default: return err && err.message && !err.code ? err.message : `Couldn't send${err && err.code ? ` (${err.code})` : ""}. Try again.`;
  }
}

/* ===================== Patient search ===================== */

// Matches first name, last name or full name, in any word order
export async function searchPatients(q) {
  const key = q.toLowerCase().replace(/\s+/g, " ").trim();
  if (key.length < 2) return [];
  const words = key.split(" ");
  const col = collection(db, "patient_list");
  const prefix = (field, v) =>
    getDocs(query(col, where(field, ">=", v), where(field, "<=", v + "\uf8ff"), limit(10))).catch(() => null);
  const first = titleCase(words[0]);
  const snaps = await Promise.all([
    prefix("NameKey", key),
    prefix("Patient Name", titleCase(key)),
    prefix("First Name", first),
    prefix("Last Name", first),
  ]);

  const seen = new Map();
  snaps.forEach((snap) => snap && snap.forEach((d) => {
    if (seen.has(d.id)) return;
    const x = d.data() || {};
    if (x.MergedInto) return;
    const name = x["Patient Name"] || `${x["First Name"] || ""} ${x["Last Name"] || ""}`.trim() || "Unnamed patient";
    const lower = name.toLowerCase();
    if (!words.every((w) => lower.includes(w))) return; // every word typed must be in the name
    seen.set(d.id, { id: d.id, name, email: x.Email || "", dob: x.DOB || "", starts: lower.startsWith(key) });
  }));
  return [...seen.values()]
    .sort((a, b) => (b.starts - a.starts) || a.name.localeCompare(b.name, "en-AU"))
    .slice(0, 10);
}

/* ===================== The task screen ===================== */

export async function mountTaskRunner(container, { taskId, patientId = "", staff } = {}) {
  const backHref = patientId ? `#/patient/${encodeURIComponent(patientId)}` : "#/tasks/new";
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);
  const fail = (title, msg) => {
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };

  let task;
  try { task = await getTaskType(taskId); }
  catch (err) {
    console.error("Task load failed:", err);
    fail(err && err.code === "permission-denied" ? "This task isn't available" : "Couldn't open this task",
      err && err.code === "permission-denied" ? "It may have been unpublished." : "Check your connection and try again.");
    return;
  }
  if (!root.isConnected) return;
  if (!task || task.status !== "live") { fail("This task isn't available", "It may have been unpublished. Go back and choose another."); return; }

  const aboutPatient = task.category === "patient" || task.recipients.aboutPatient;
  const fixedStaff = task.category === "staff" && task.recipients.mode === "fixed";
  const st = {
    patient: null, staffList: null, staffSel: new Set(), answers: {}, sources: {},
    smart: { appointments: "", plan: "" }, letterhead: null, printables: null,
    appts: { months: 6, services: true, staff: true, items: null, status: "", source: "book", lastKey: "", toKey: "" },
    subjectEdited: false, bodyEdited: false, sending: false, touched: false,
    combo: { results: [], active: -1, status: "", seq: 0 },
    // Attachments: { mode: "blank"|"fill"|"saved", id, subId, tags, saved }
    atts: task.attachments.map(parseAttachment).map((a) => ({ ...a, subId: "", tags: null, saved: undefined })),
  };
  if (patientId) { try { st.patient = await getPatient(patientId); } catch (err) { console.warn("Patient load failed:", err); } }
  if (!root.isConnected) return;

  const allText = `${task.subject}\n${task.body}`;
  const uses = (name) => new RegExp(`\\{\\s*${name}\\s*\\}`, "i").test(allText);

  root.innerHTML = `
    <div class="ff-wrap tb-wrap">
      <div class="ff-bar" role="region" aria-label="Task actions">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${backHref}" aria-label="Back" title="Back">${I.back}</a>
          <div class="ff-bar-title"><strong>${esc(task.name)}</strong><span>${CAT_LABEL[task.category]} · Email</span></div>
          <div class="ff-bar-actions">
            <a class="ff-btn is-quiet" href="${backHref}">Cancel</a>
            <button type="button" class="ff-btn is-primary" data-act="send">${I.send}<span>Send email</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      <div class="tb-grid tr-grid">
        <div class="tb-form" data-role="left"></div>
        <aside class="tr-mail-col">
          <section class="tb-card tr-mail">
            <h4>Email</h4>
            <div class="tr-row tr-row-to"><span>To</span><div class="tr-to" data-role="to"></div></div>
            <label class="tr-row"><span>CC</span><input class="fe-input" type="email" data-role="cc" maxlength="254" placeholder="Optional" value="${esc(task.recipients.cc || "")}" /></label>
            <label class="tr-row"><span>Subject</span><input class="fe-input" data-role="subject" maxlength="200" /></label>
            <div class="tr-canvas" data-role="canvas"><div data-role="body"></div></div>
            <div class="tr-mail-foot">
              <small class="muted" data-role="note">Click into the message to change any wording.</small>
              <button type="button" class="lh-btn is-quiet" data-act="reset" hidden>Reset to the task's wording</button>
            </div>
            <div data-role="atts"></div>
          </section>
        </aside>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const left = $('[data-role="left"]');
  const msgEl = $('[data-role="msg"]');
  const subjectEl = $('[data-role="subject"]');
  $('[data-role="canvas"]').style.backgroundColor = task.style.background;
  const editor = createRichEditor($('[data-role="body"]'), {
    onInput: () => { st.bodyEdited = true; st.touched = true; resetBtn.hidden = false; },
    pickImage: () => openImagePicker({ isAdmin: false }),
    accent: () => task.style.accent,
    logo: () => (st.letterhead && st.letterhead.logo) || "",
  });
  const ccEl = $('[data-role="cc"]');
  const resetBtn = $('[data-act="reset"]');
  const noteEl = $('[data-role="note"]');
  const sendBtn = $('[data-act="send"]');

  /* ---------- Answers and blanks ---------- */
  const optionsOf = (f) => (f.source === "list" ? (f.options || []) : (st.sources[f.source] || []));
  function chosen(f) {
    const v = st.answers[f.id];
    const labels = Array.isArray(v) ? v : v ? [v] : [];
    const opts = optionsOf(f);
    return labels.map((l) => opts.find((o) => o.label === l) || { label: l, link: "" });
  }
  function answerText(f) {
    if (TASK_CHOICE_TYPES.includes(f.type)) return formatChoice(f, chosen(f));
    const v = st.answers[f.id];
    if (f.type === "date") return niceDate(v);
    return v == null ? "" : String(v);
  }
  const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);

  function values() {
    const m = new Map();
    const set = (k, v) => m.set(k.toLowerCase(), v == null ? "" : typeof v === "object" ? v : String(v));
    const p = st.patient || {};
    const c = clinicDetails(st.letterhead);
    if (task.category === "patient") {
      set("First name", p.firstName); set("Full name", p.name); set("Email", p.email);
      set("Mobile", p.mobile ? formatMobile(p.mobile) : ""); set("Date of birth", formatDobLong(p.dobKey) || p.dob);
    } else {
      set("First name", "{First name}"); set("Full name", "{Full name}"); // filled in for each person when sent
      set("Patient name", p.name); set("Patient first name", p.firstName);
      set("Patient mobile", p.mobile ? formatMobile(p.mobile) : ""); set("Patient email", p.email);
    }
    set("Today", todayLong()); set("Staff name", (staff && staff.name) || "");
    set("Clinic phone", c.phone); set("Clinic email", c.email); set("Clinic address", c.address);
    set("Upcoming appointments", st.smart.appointments);
    set("Treatment plan", st.smart.plan);
    set("Aftercare", ""); // only filled in when emailing aftercare from a form
    const tx = task.fields.find((f) => TASK_CHOICE_TYPES.includes(f.type) && f.source === "treatments");
    if (tx) set("Treatment info", formatChoice({ ...tx, display: "links" }, chosen(tx)));
    // From an attached form that's been filled in (its Referral specialist)
    const ft = st.atts.map((a) => a.tags).find((t) => t && t["specialist name"]) || {};
    SP_KEYS.forEach((k) => set(k, ft[k] || ""));
    // Your own fields last, so a field called "Aftercare" (or "Treatment plan") is never blanked out
    task.fields.forEach((f) => { if (f.label.trim()) set(f.label.trim(), answerText(f)); });
    return m;
  }

  function renderMessage(force = false) {
    const vals = values();
    if (!st.subjectEdited || force) subjectEl.value = fillTemplate(task.subject, vals).replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1");
    if (!st.bodyEdited || force) editor.setHtml(fillTemplateHtml(task.body, vals));
    if (force) { st.subjectEdited = false; st.bodyEdited = false; }
    resetBtn.hidden = !(st.subjectEdited || st.bodyEdited);
  }

  /* ---------- Searchable patient dropdown ---------- */
  function comboHtml(label) {
    return `
      <div class="pc" data-combo>
        <div class="pc-field">${I.search}
          <input type="text" class="pc-input" data-role="psearch" role="combobox" aria-expanded="false"
            aria-controls="pc-list" aria-autocomplete="list" aria-label="${esc(label)}"
            placeholder="Search for the patient by name" autocomplete="off" spellcheck="false" />
        </div>
        <ul class="pc-list" id="pc-list" role="listbox" aria-label="Matching patients" hidden></ul>
      </div>`;
  }

  function renderCombo() {
    const input = root.querySelector(".pc-input");
    const list = root.querySelector(".pc-list");
    if (!input || !list) return;
    const c = st.combo;
    let h = "";
    if (c.status === "short") h = '<li class="pc-status">Type at least 2 letters</li>';
    else if (c.status === "searching" && !c.results.length) h = '<li class="pc-status">Searching…</li>';
    else if (c.status === "none") h = '<li class="pc-status">No patients found. Try their last name.</li>';
    else if (c.status === "error") h = '<li class="pc-status pc-bad">Couldn\'t search. Check your connection.</li>';
    h += c.results.map((r, i) => `
      <li class="pc-opt${i === c.active ? " is-active" : ""}" id="pc-opt-${i}" role="option" aria-selected="${i === c.active}" data-pick-patient="${esc(r.id)}">
        <span class="pc-avatar">${I.user}</span>
        <span class="pc-text"><strong>${esc(r.name)}</strong><small>${esc([r.dob && `DOB ${r.dob}`, r.email || "No email on file"].filter(Boolean).join(" · "))}</small></span>
      </li>`).join("");
    list.innerHTML = h;
    const open = !!h && document.activeElement === input;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (c.active >= 0) {
      input.setAttribute("aria-activedescendant", `pc-opt-${c.active}`);
      const el = list.querySelector(`#pc-opt-${c.active}`);
      if (el) el.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  let searchTimer = null;
  function runSearch(q) {
    clearTimeout(searchTimer);
    const c = st.combo;
    if (q.trim().length < 2) { c.results = []; c.active = -1; c.status = q.trim() ? "short" : ""; renderCombo(); return; }
    c.status = "searching";
    renderCombo();
    const seq = ++c.seq;
    searchTimer = setTimeout(async () => {
      let results = [];
      try { results = await searchPatients(q); }
      catch (err) { console.warn("Patient search failed:", err); if (seq === c.seq) { c.status = "error"; renderCombo(); } return; }
      if (seq !== c.seq || !root.isConnected) return; // a newer search has started
      c.results = results;
      c.active = results.length ? 0 : -1;
      c.status = results.length ? "" : "none";
      renderCombo();
    }, 250);
  }

  root.addEventListener("input", (e) => { if (e.target.matches(".pc-input")) runSearch(e.target.value); });
  root.addEventListener("focusin", (e) => { if (e.target.matches(".pc-input")) renderCombo(); });
  root.addEventListener("focusout", (e) => {
    if (!e.target.matches(".pc-input")) return;
    setTimeout(() => { const l = root.querySelector(".pc-list"); if (l && document.activeElement !== e.target) { l.hidden = true; e.target.setAttribute("aria-expanded", "false"); } }, 120);
  });
  root.addEventListener("keydown", (e) => {
    if (!e.target.matches(".pc-input")) return;
    const c = st.combo;
    if (e.key === "ArrowDown" && c.results.length) { e.preventDefault(); c.active = (c.active + 1) % c.results.length; renderCombo(); }
    else if (e.key === "ArrowUp" && c.results.length) { e.preventDefault(); c.active = (c.active - 1 + c.results.length) % c.results.length; renderCombo(); }
    else if (e.key === "Enter") { e.preventDefault(); if (c.results[c.active]) pickPatient(c.results[c.active].id); }
    else if (e.key === "Escape") { const l = root.querySelector(".pc-list"); if (l) l.hidden = true; e.target.setAttribute("aria-expanded", "false"); }
  });
  // mousedown (not click) so choosing happens before the box loses focus
  root.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".pc-opt");
    if (!opt) return;
    e.preventDefault();
    pickPatient(opt.dataset.pickPatient);
  });

  async function pickPatient(id) {
    try { st.patient = await getPatient(id); }
    catch (err) { console.error(err); showToast("Couldn't open that patient. Try again."); return; }
    if (!root.isConnected || !st.patient) return;
    st.combo = { results: [], active: -1, status: "", seq: st.combo.seq + 1 };
    renderLeft(); renderTo(); loadSmart(); loadAttachments();
    const to = $('[data-role="to-input"]');
    if (to && !to.value) to.focus();
  }

  function clearPatient() {
    st.patient = null;
    renderLeft(); renderTo(); loadSmart(); loadAttachments();
    const input = root.querySelector(".pc-input");
    if (input) input.focus();
  }

  /* ---------- Who it's for ---------- */
  function patientChip() {
    const p = st.patient;
    return `<div class="tr-pchip">
      <span class="pc-avatar">${I.user}</span>
      <span class="pc-text"><strong>${esc(p.name)}</strong><small>${esc(formatDobLong(p.dobKey) || p.dob || "")}</small></span>
      ${patientId ? "" : `<button type="button" class="ib-tool" data-act="change-patient" aria-label="Choose a different patient" title="Choose a different patient">${I.x}</button>`}
    </div>`;
  }

  function renderTo() {
    const box = $('[data-role="to"]');
    if (task.category === "patient") {
      if (!st.patient) { box.innerHTML = comboHtml("Patient"); return; }
      box.innerHTML = `${patientChip()}
        <input class="fe-input" type="email" data-role="to-input" maxlength="254" aria-label="Email address"
          placeholder="No email on file. Type one in." value="${esc(st.patient.email || "")}" />
        <small class="tr-warn" data-role="to-warn" hidden></small>
        <div data-role="to-extra"></div>`;
      checkTo();
      renderToExtra();
      return;
    }
    const ids = fixedStaff ? task.recipients.staffIds : [...st.staffSel];
    const names = (st.staffList || []).filter((s) => ids.includes(s.id)).map((s) => s.name);
    box.innerHTML = names.length
      ? `<div class="tr-chips">${names.map((n) => `<span class="tr-chip">${esc(n)}</span>`).join("")}</div>${
          names.length > 1 ? '<small class="muted">Each person gets their own copy, addressed to them.</small>' : ""}`
      : `<span class="muted">${st.staffList === null ? "Loading staff…" : "Choose staff on the left"}</span>`;
  }

  const specialistTags = () => st.atts.map((a) => a.tags).find((t) => t && t["specialist email"]) || null;

  function checkTo() {
    const input = $('[data-role="to-input"]');
    const warn = $('[data-role="to-warn"]');
    if (!input || !warn) return;
    const onFile = ((st.patient && st.patient.email) || "").toLowerCase();
    const v = input.value.trim().toLowerCase();
    const sp = specialistTags();
    if (sp && v && v === String(sp["specialist email"]).toLowerCase()) {
      warn.textContent = `Sending to ${sp["specialist name"] || "the specialist"}, not the patient.`;
      warn.hidden = false;
      return;
    }
    if (!onFile) { warn.textContent = "There's no email on this patient's record. Type one in."; warn.hidden = false; return; }
    warn.textContent = "This isn't the email address on the patient's record.";
    warn.hidden = !v || v === onFile;
  }

  // "Send to the specialist instead", once an attached form with a Referral specialist is filled in
  function renderToExtra() {
    const box = $('[data-role="to-extra"]');
    if (!box) return;
    const sp = specialistTags();
    const em = sp && sp["specialist email"];
    box.innerHTML = em ? `<button type="button" class="hx-add" data-act="to-specialist" data-email="${esc(em)}">Send to ${
      esc(sp["specialist name"] || "the specialist")} instead (${esc(em)})</button>` : "";
  }

  function staffCard() {
    if (st.staffList === null) return '<p class="tb-none">Loading staff…</p>';
    if (fixedStaff) {
      const names = st.staffList.filter((s) => task.recipients.staffIds.includes(s.id));
      return `<p class="tb-info">This task always goes to: <strong>${esc(names.map((s) => s.name).join(", ") || "nobody yet")}</strong></p>`;
    }
    return `<div class="tb-staff">${st.staffList.map((s) => `
      <label class="fe-check"><input type="checkbox" data-staffsel="${esc(s.id)}"${st.staffSel.has(s.id) ? " checked" : ""}${s.hasEmail ? "" : " disabled"} />
        ${esc(s.name)} <small>${esc(s.role || "")}${s.hasEmail ? "" : " · no email on file"}</small></label>`).join("")}</div>`;
  }

  /* ---------- The task's fields ---------- */
  function fieldHtml(f) {
    const v = st.answers[f.id];
    const head = `<span class="tr-q">${esc(f.label)}${f.required ? '<span class="fe-req">*</span>' : ""}</span>`;
    const help = f.help ? `<small class="muted">${esc(f.help)}</small>` : "";
    const id = esc(f.id);
    switch (f.type) {
      case "short_text":
        return `<label class="tb-field">${head}<input class="fe-input" data-ans="${id}" maxlength="500" placeholder="${esc(f.placeholder)}" value="${esc(v || "")}" />${help}</label>`;
      case "long_text":
        return `<label class="tb-field">${head}<textarea class="fe-input" data-ans="${id}" rows="3" maxlength="3000" placeholder="${esc(f.placeholder)}">${esc(v || "")}</textarea>${help}</label>`;
      case "number":
        return `<label class="tb-field">${head}<input class="fe-input" type="number" data-ans="${id}" value="${esc(v ?? "")}" />${help}</label>`;
      case "date":
        return `<label class="tb-field">${head}<input class="fe-input tr-date" type="date" data-ans="${id}" value="${esc(v || "")}" />${help}</label>`;
    }
    const opts = optionsOf(f);
    if (f.source !== "list" && st.sources[f.source] === undefined) return `<div class="tb-field">${head}<p class="tb-none">Loading the list…</p></div>`;
    if (f.source !== "list" && st.sources[f.source] === null) return `<div class="tb-field">${head}<p class="tb-none tb-bad">Couldn't load this list.</p></div>`;
    if (f.type === "dropdown") {
      return `<label class="tb-field">${head}<select class="fb-select" data-ans="${id}"><option value="">${esc(f.placeholder || "Choose one")}</option>${
        opts.map((o) => `<option value="${esc(o.label)}"${v === o.label ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>${help}</label>`;
    }
    const multi = f.type === "checkboxes";
    const picked = new Set(Array.isArray(v) ? v : v ? [v] : []);
    return `<div class="tb-field">${head}${help}
      ${opts.length > 8 ? `<input type="search" class="fe-input tr-filter" data-filter="${id}" placeholder="Filter ${esc(f.label.toLowerCase())}" />` : ""}
      <div class="tr-opts" data-opts="${id}">${opts.map((o) => `
        <div class="tr-opt" data-find="${esc(o.label.toLowerCase())}">
          <label class="fe-check"><input type="${multi ? "checkbox" : "radio"}" name="ans-${id}" data-ans="${id}" value="${esc(o.label)}"${picked.has(o.label) ? " checked" : ""} /> ${esc(o.label)}</label>
          ${o.link ? `<a class="tr-link" href="${esc(o.link)}" target="_blank" rel="noopener" title="Open the information page" aria-label="Open the page for ${esc(o.label)}">${I.ext}</a>`
            : f.display === "links" ? '<small class="tr-nolink" title="Add a link in the Aftercare Bank to make it clickable">No link</small>' : ""}
        </div>`).join("") || '<p class="tb-none">No choices.</p>'}</div></div>`;
  }

  function renderLeft() {
    let n = 1;
    let h = "";
    if (task.category === "staff") {
      h += `<section class="tb-card"><h4><span class="tb-num">${n++}</span>Who it goes to</h4>${staffCard()}</section>`;
      if (aboutPatient) {
        h += `<section class="tb-card"><h4><span class="tb-num">${n++}</span>Which patient</h4>${
          st.patient ? patientChip() : comboHtml("Patient this is about")}</section>`;
      }
    }
    if (task.fields.length) {
      h += `<section class="tb-card"><h4><span class="tb-num">${n++}</span>Details</h4>${task.fields.map(fieldHtml).join("")}</section>`;
    } else if (task.category === "patient") {
      h += `<section class="tb-card"><h4>Details</h4><p class="tb-none">Nothing else to fill in. Choose the patient in the <strong>To</strong> box, check the email, then send.</p></section>`;
    }
    if (uses("upcoming appointments") && st.patient) {
      h += `<section class="tb-card" data-role="appts-card">${apptCardHtml()}</section>`;
    }
    left.innerHTML = h;
  }

  const formName = (fid) => ((st.printables || []).find((x) => x.id === fid) || {}).name || "Attachment";

  function renderAttachments() {
    const box = $('[data-role="atts"]');
    if (!st.atts.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="tr-atts">${st.atts.map((a, i) => {
      const n = esc(formName(a.id));
      if (a.mode === "blank") return `<div class="tr-att"><span class="tb-att">${I.doc}${n}.pdf</span></div>`;
      if (!st.patient) return `<div class="tr-att"><span class="tb-att is-todo">${I.doc}${n}</span><small class="muted">Choose the patient first.</small></div>`;
      if (a.mode === "fill") {
        return `<div class="tr-att"><span class="tb-att${a.subId ? "" : " is-todo"}">${I.doc}${n}${a.subId ? " ✓" : ""}</span>
          <small class="muted">${a.subId ? `Filled in and saved to ${esc(st.patient.name)}'s record.` : "Needs filling in before sending."}</small>
          ${a.subId ? `<button type="button" class="lh-btn is-quiet" data-attprev="${i}">Preview</button>` : ""}
          <button type="button" class="lh-btn${a.subId ? " is-quiet" : " is-primary"}" data-attfill="${i}">${a.subId ? "Fill in again" : "Fill in now"}</button></div>`;
      }
      if (a.saved === null || a.saved === undefined) return `<div class="tr-att"><span class="tb-att">${I.doc}${n}</span><small class="muted">Looking for saved copies…</small></div>`;
      if (!a.saved.length) {
        return `<div class="tr-att"><span class="tb-att is-todo">${I.doc}${n}</span><small class="muted">None saved for this patient yet.</small>
          <button type="button" class="lh-btn is-primary" data-attfill="${i}">Fill one in now</button></div>`;
      }
      return `<div class="tr-att"><span class="tb-att">${I.doc}${n}</span>
        <select class="fb-select" data-attpick="${i}" aria-label="Which saved copy">${a.saved.map((s) =>
          `<option value="${esc(s.id)}"${s.id === a.subId ? " selected" : ""}>${esc(niceDate(s.recordDate))}${s.createdBy ? ` · ${esc(s.createdBy)}` : ""}</option>`).join("")}</select>
        <button type="button" class="lh-btn is-quiet" data-attprev="${i}">Preview</button></div>`;
    }).join("")}</div>`;
  }

  // A new patient: nothing filled in yet; saved copies are looked up again
  function loadAttachments() {
    st.atts.forEach((a) => { a.subId = ""; a.tags = null; a.saved = a.mode === "saved" ? null : undefined; });
    renderAttachments();
    const p = st.patient;
    if (!p || !st.atts.some((a) => a.mode === "saved")) return;
    listSubmissionsForPatient([p.id, ...patientIds(p)])
      .then((subs) => {
        if (st.patient !== p) return;
        st.atts.forEach((a) => {
          if (a.mode !== "saved") return;
          a.saved = subs.filter((s) => s.templateId === a.id)
            .sort((x, y) => String(y.recordDate || "").localeCompare(String(x.recordDate || ""))); // newest first
          if (a.saved[0]) pickSaved(a, a.saved[0]);
        });
      })
      .catch((err) => { console.warn("Saved copies not loaded:", err); st.atts.forEach((a) => { if (a.mode === "saved") a.saved = []; }); })
      .finally(() => { if (root.isConnected && st.patient === p) { renderAttachments(); renderToExtra(); checkTo(); renderMessage(); } });
  }

    // Use a saved copy. Its specialist details come from the saved answers (read in full if the list didn't include them).
  async function pickSaved(a, s) {
    a.subId = s.id;
    a.tags = (s.answers && s.answers.__tags) || null;
    if (a.tags) return;
    try {
      const full = await getSubmission(s.id);
      if (a.subId !== s.id) return; // a different copy was chosen meanwhile
      a.tags = (full && full.answers && full.answers.__tags) || null;
    } catch (err) {
      console.warn("Saved form not read:", err);
    }
    if (root.isConnected) { renderToExtra(); checkTo(); renderMessage(); }
  }

  // The live form in an overlay. Saving puts it on the patient's record and attaches it.
  function openFill(i) {
    const a = st.atts[i];
    const p = st.patient;
    if (!a || !p) return;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog tr-fill-dlg";
    dlg.innerHTML = '<div data-role="fill"></div>';
    document.body.appendChild(dlg);
    const host = dlg.querySelector('[data-role="fill"]');
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      const c = host.querySelector('[data-act="emb-cancel"]');
      if (c) c.click(); else dlg.close();
    });
    dlg.addEventListener("close", () => dlg.remove());
    mountFormFill(host, `${p.id}/${a.id}`, {
      staff,
      embedded: {
        saveLabel: "Save and attach",
        onCancel: () => dlg.close(),
        onSaved: async (subId) => {
          dlg.close();
          a.subId = subId;
          try { const s = await getSubmission(subId); a.tags = (s && s.answers && s.answers.__tags) || null; }
          catch (err) { console.warn("Saved form not read back:", err); }
          if (a.mode === "saved") {
            a.saved = [{ id: subId, recordDate: isoToday(), createdBy: (staff && staff.name) || "", answers: { __tags: a.tags || {} } }, ...(a.saved || [])];
          }
          st.touched = true;
          if (!root.isConnected) return;
          renderAttachments(); renderToExtra(); checkTo(); renderMessage();
          if (st.bodyEdited && /\{\s*specialist/i.test(allText)) {
            noteEl.textContent = "The specialist's details are ready. Press “Reset to the task's wording” to put them in the email.";
          }
          showToast(`${formName(a.id)} saved to ${p.name}'s record and attached`);
        },
      },
    });
    dlg.showModal();
  }

  /* ---------- Loading data ---------- */
  function loadSmart() {
    const p = st.patient;
    st.smart = { appointments: "", plan: "" };
    if (!p) { st.appts.items = null; st.appts.status = ""; renderMessage(); return; }
    const jobs = [];
    if (uses("upcoming appointments")) {
      st.smart.appointments = "(loading appointments…)";
      jobs.push(loadAppointments(p));
    }
    if (uses("treatment plan")) {
      st.smart.plan = "(loading treatment plan…)";
      jobs.push(fetchTranscriptRecords(p).then((records) => {
        const plan = latestTreatmentPlan(records);
        st.smart.plan = plan && plan.plan ? String(plan.plan).trim() : "There's no treatment plan on record yet.";
      }).catch(() => { st.smart.plan = ""; }));
    }
    renderMessage();
    if (jobs.length) {
      noteEl.textContent = "Filling in the patient's details…";
      Promise.allSettled(jobs).then(() => {
        if (st.patient !== p || !root.isConnected) return;
        renderMessage();
        noteEl.textContent = st.bodyEdited
          ? "Appointments and plan have loaded. Press “Reset to the task's wording” to include them."
          : "Click into the message to change any wording.";
      });
    }
  }

  /* ---------- Upcoming appointments ---------- */
  async function loadAppointments(p) {
    const a = st.appts;
    a.status = "loading";
    renderApptCard();
    try {
      const res = await upcomingAppointments(p, { months: a.months });
      if (st.patient !== p) return;
      if (res.daysFound) {
        Object.assign(a, { items: res.items, source: "book", lastKey: res.lastKey, toKey: res.toKey });
      } else {
        // No future days uploaded to the appointment book yet: use the pre-consultation sheet's list instead
        const pre = await fetchPreconsult(p).catch(() => null);
        if (st.patient !== p) return;
        const lines = String((pre && pre.found && pre.data && pre.data.futureVisits) || "")
          .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        Object.assign(a, { items: lines.map((line) => ({ line })), source: "sheet", lastKey: "", toKey: res.toKey });
      }
      a.status = "";
    } catch (err) {
      console.warn("Upcoming appointments failed:", err);
      if (st.patient !== p) return;
      a.items = [];
      a.status = err && err.code === "permission-denied" ? "blocked" : "error";
    }
    applyAppts();
  }

  function applyAppts() {
    const a = st.appts;
    if (a.status === "error" || a.status === "blocked") st.smart.appointments = "";
    else if (!a.items || !a.items.length) st.smart.appointments = "There are no upcoming appointments booked at the moment.";
    else if (a.source === "sheet") st.smart.appointments = a.items.map((x) => "• " + x.line).join("\n");
    else st.smart.appointments = formatUpcoming(a.items, { services: a.services, staff: a.staff });
    renderApptCard();
  }

  function apptCardHtml() {
    const a = st.appts;
    const opts = { services: a.services, staff: a.staff };
    const n = a.items && a.status === "" ? a.items.length : null;
    let list;
    if (a.status === "loading" || a.items === null) list = '<p class="tb-none">Looking up appointments…</p>';
    else if (a.status === "blocked") list = '<p class="tb-none tb-bad">The appointment book is blocked. Check the appts_by_day Firestore rule allows read.</p>';
    else if (a.status === "error") list = '<p class="tb-none tb-bad">Couldn\'t load the appointments. Check your connection and try again.</p>';
    else if (!a.items.length) list = '<p class="tb-none">No upcoming appointments booked. The email will say so.</p>';
    else if (a.source === "sheet") list = `<ul class="tr-appts">${a.items.map((x) => `<li>${esc(x.line)}</li>`).join("")}</ul>`;
    else {
      list = `<ul class="tr-appts">${a.items.map((x) => {
        const d = apptDetail(x, opts);
        return `<li><strong>${esc(apptWhen(x))}</strong>${d ? `<span>${esc(d)}</span>` : ""}</li>`;
      }).join("")}</ul>`;
    }
    const notes = [];
    if (a.status === "" && a.source === "sheet") {
      notes.push("From the pre-consultation sheet, because the appointment book has no future days uploaded yet.");
    }
    if (a.status === "" && a.source === "book" && a.lastKey && a.lastKey < a.toKey) {
      notes.push(`The appointment book only goes up to ${niceDay(a.lastKey)}, so anything booked after that won't show.`);
    }
    return `
      <h4>Upcoming appointments${n !== null ? ` <small>${n} found</small>` : ""}</h4>
      <div class="tr-appt-opts">
        <label class="tr-appt-range">Show the next
          <select class="fb-select" data-appt="months">${[3, 6, 12].map((m) =>
            `<option value="${m}"${a.months === m ? " selected" : ""}>${m} months</option>`).join("")}</select></label>
        ${a.source === "sheet" ? "" : `
        <label class="fe-check"><input type="checkbox" data-appt="services"${a.services ? " checked" : ""} /> Treatments</label>
        <label class="fe-check"><input type="checkbox" data-appt="staff"${a.staff ? " checked" : ""} /> Who it's with</label>`}
      </div>
      ${list}
      ${notes.map((t) => `<small class="tr-appts-note">${esc(t)}</small>`).join("")}`;
  }

  function renderApptCard() {
    const box = left.querySelector('[data-role="appts-card"]');
    if (box) box.innerHTML = apptCardHtml();
  }

  function afterAppts() {
    renderMessage();
    if (st.bodyEdited) noteEl.textContent = "The appointments have changed. Press “Reset to the task's wording” to put them in the email.";
  }

  /* ---------- Events ---------- */
  left.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.appt !== undefined) {
      const k = el.dataset.appt;
      if (k === "months") {
        st.appts.months = Number(el.value) || 6;
        if (st.patient) loadAppointments(st.patient).then(afterAppts);
      } else {
        st.appts[k] = el.checked;
        applyAppts();
        afterAppts();
      }
      return;
    }
    if (el.dataset.filter !== undefined) {
      const q = el.value.trim().toLowerCase();
      left.querySelectorAll(`[data-opts="${CSS.escape(el.dataset.filter)}"] .tr-opt`).forEach((row) => {
        row.hidden = !!q && !row.dataset.find.includes(q);
      });
      return;
    }
    if (el.dataset.staffsel !== undefined) {
      if (el.checked) st.staffSel.add(el.dataset.staffsel); else st.staffSel.delete(el.dataset.staffsel);
      renderTo();
      return;
    }
    if (el.dataset.ans !== undefined) {
      const fid = el.dataset.ans;
      if (el.type === "checkbox") {
        st.answers[fid] = [...left.querySelectorAll(`[data-ans="${CSS.escape(fid)}"]:checked`)].map((x) => x.value);
      } else {
        st.answers[fid] = el.value;
      }
      st.touched = true;
      renderMessage();
    }
  });

  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="change-patient"]')) { clearPatient(); return; }
    const ts = e.target.closest('[data-act="to-specialist"]');
    if (ts) {
      const input = $('[data-role="to-input"]');
      if (input) { input.value = ts.dataset.email; checkTo(); st.touched = true; }
    }
  });
  const attsBox = $('[data-role="atts"]');
  attsBox.addEventListener("click", (e) => {
    const b = e.target.closest("[data-attfill]");
    if (b) { openFill(Number(b.dataset.attfill)); return; }
    const pv = e.target.closest("[data-attprev]");
    if (pv) {
      const a = st.atts[Number(pv.dataset.attprev)];
      if (a && a.subId) previewSavedForm(a.subId).catch((err) => { console.error(err); showToast(err.message || "Couldn't preview. Try again."); });
    }
  });
  attsBox.addEventListener("input", (e) => {
    const s = e.target.closest("[data-attpick]");
    if (!s) return;
    const a = st.atts[Number(s.dataset.attpick)];
    const hit = a && (a.saved || []).find((x) => x.id === s.value);
    if (!hit) return;
    pickSaved(a, hit);
    renderToExtra(); checkTo(); renderMessage();
  });
  $('[data-role="to"]').addEventListener("input", (e) => { if (e.target.matches('[data-role="to-input"]')) checkTo(); });
  subjectEl.addEventListener("input", () => { st.subjectEdited = true; st.touched = true; resetBtn.hidden = false; });
  resetBtn.addEventListener("click", () => { renderMessage(true); noteEl.textContent = "Click into the message to change any wording."; });

  /* ---------- Sending ---------- */
  function problems() {
    const out = [];
    if (aboutPatient && !st.patient) out.push(task.category === "patient" ? "Choose the patient in the To box." : "Choose the patient this is about.");
    if (task.category === "patient") {
      const to = ($('[data-role="to-input"]') || {}).value || "";
      if (st.patient && !EMAIL_RE.test(to.trim())) out.push("Enter the patient's email address.");
    } else {
      const ids = fixedStaff ? task.recipients.staffIds : [...st.staffSel];
      if (!ids.length) out.push("Choose who to send it to.");
    }
    const cc = ccEl.value.trim();
    if (cc && !EMAIL_RE.test(cc)) out.push("Check the CC email address.");
    if (st.patient) {
      st.atts.forEach((a) => {
        if (a.mode === "fill" && !a.subId) out.push(`Fill in “${formName(a.id)}” before sending (under the email).`);
        if (a.mode === "saved" && !a.subId) out.push(`There's no saved “${formName(a.id)}” for this patient. Fill one in under the email.`);
      });
    }
    task.fields.forEach((f) => { if (f.required && isEmpty(st.answers[f.id])) out.push(`Answer “${f.label}”.`); });
    if (!subjectEl.value.trim()) out.push("Add a subject.");
    if (!editor.text().trim()) out.push("The message is empty.");
    return out;
  }

  sendBtn.addEventListener("click", async () => {
    if (st.sending) return;
    const list = problems();
    if (list.length) {
      msgEl.textContent = list[0] + (list.length > 1 ? ` (and ${list.length - 1} more)` : "");
      if (!st.patient) { const s = root.querySelector(".pc-input"); if (s) s.focus(); }
      return;
    }
    msgEl.textContent = "";
    st.sending = true;
    sendBtn.disabled = true;
    const label = sendBtn.querySelector("span");
    try {
      const attachments = [];
      if (st.atts.length) {
        label.textContent = "Preparing PDFs…";
        for (const a of st.atts) {
          const att = a.mode === "blank"
            ? await printablePdf({ templateId: a.id, patient: st.patient })
            : await savedFormPdf(a.subId);
          console.info(att.pdf
            ? `Attachment "${att.name}" (${a.mode}): ${Math.round(att.pdf.length * 0.75 / 1024)} KB PDF`
            : `Attachment "${att.name}" (${a.mode}): the browser couldn't make it, so the server will`);
          attachments.push(att);
        }
      }
      label.textContent = "Sending…";
      const to = task.category === "patient" ? $('[data-role="to-input"]').value.trim() : "";
      const res = await callApi({
        action: "sendTaskEmail",
        taskId: task.id,
        patientId: st.patient ? st.patient.id : "",
        to,
        cc: ccEl.value.trim(),
        staffIds: fixedStaff ? [] : [...st.staffSel],
        subject: subjectEl.value.trim(),
        html: emailShell(editor.getHtml(), task.style, {
          clinic: clinicDetails(st.letterhead),
          hasLogo: !!(st.letterhead && st.letterhead.logo),
        }),
        attachments,
      });
      st.touched = false;
      showToast(task.category === "patient"
        ? `Sent to ${st.patient.name}`
        : `Sent to ${res.sent} staff member${res.sent === 1 ? "" : "s"}`);
      location.hash = patientId ? backHref : "#/tasks/history";
    } catch (err) {
      console.error("Task send failed:", err);
      msgEl.textContent = runError(err);
      sendBtn.disabled = false;
      label.textContent = "Send email";
    } finally {
      st.sending = false;
    }
  });

  const onBeforeUnload = (e) => { if (st.touched && root.isConnected) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("hashchange", function off() {
    if (root.isConnected) return;
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("hashchange", off);
  });

  /* ---------- Start ---------- */
  renderLeft();
  renderTo();
  renderAttachments();
  loadSmart();
  if (st.patient) loadAttachments();
  if (task.category === "patient" && !st.patient) {
    const s = root.querySelector(".pc-input");
    if (s) s.focus();
  }

  getLetterhead().then((lh) => { st.letterhead = lh; if (root.isConnected) renderMessage(); }).catch(() => {});
  if (task.attachments.length) {
    listPublishedForms().then((list) => { st.printables = list; if (root.isConnected) renderAttachments(); }).catch(() => {});
  }
  if (task.category === "staff") {
    fetchStaffList()
      .then((list) => { st.staffList = list; })
      .catch((err) => { console.warn("Staff list failed:", err); st.staffList = []; })
      .finally(() => { if (root.isConnected) { renderLeft(); renderTo(); } });
  }
  [...new Set(task.fields.filter((f) => TASK_CHOICE_TYPES.includes(f.type) && f.source !== "list").map((f) => f.source))]
    .forEach((src) => {
      loadSource(src)
        .then((opts) => { st.sources[src] = opts; })
        .catch(() => { st.sources[src] = null; })
        .finally(() => { if (root.isConnected) { renderLeft(); renderMessage(); } });
    });
}