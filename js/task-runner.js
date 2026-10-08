// Running a task: who it's for, the details, the ready-written email, then send.
// Route: #/tasks/run/<taskId>            (from Task Manager)
//        #/tasks/run/<taskId>/<patientId> (from the patient page's Email button)
import { getTaskType, fetchStaffList, TASK_CHOICE_TYPES } from "./task-types.js";
import { loadSource } from "./task-sources.js";
import { formatChoice, fillTemplate, emailBodyHtml, clinicDetails, EMAIL_RE } from "./task-tokens.js";
import { getPatient } from "./patients.js";
import { fetchPreconsult, callApi } from "./appointments.js";
import { fetchTranscriptRecords, latestTreatmentPlan } from "./transcripts.js";
import { getLetterhead, listPublishedForms } from "./form-templates.js";
import { printablePdf } from "./form-delivery.js";
import { db } from "./firebase-config.js";
import { collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast, formatDobLong, formatMobile } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  ext: ic('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  search: ic('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  doc: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
};
const CAT_LABEL = { patient: "To Patient", staff: "To Staff" };
const todayLong = () => new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : (key || "");
};
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

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

async function searchPatients(q) {
  const key = q.toLowerCase().replace(/\s+/g, " ").trim();
  if (key.length < 2) return [];
  const col = collection(db, "patient_list");
  const title = titleCase(key);
  const [a, b] = await Promise.all([
    getDocs(query(col, where("NameKey", ">=", key), where("NameKey", "<=", key + "\uf8ff"), limit(12))).catch(() => null),
    getDocs(query(col, where("Patient Name", ">=", title), where("Patient Name", "<=", title + "\uf8ff"), limit(12))).catch(() => null),
  ]);
  const seen = new Map();
  [a, b].forEach((snap) => snap && snap.forEach((d) => {
    const x = d.data() || {};
    if (x.MergedInto || seen.has(d.id)) return;
    seen.set(d.id, {
      id: d.id,
      name: x["Patient Name"] || `${x["First Name"] || ""} ${x["Last Name"] || ""}`.trim() || "Unnamed patient",
      email: x.Email || "",
      dob: x.DOB || "",
    });
  }));
  return [...seen.values()].sort((p, q2) => p.name.localeCompare(q2.name, "en-AU")).slice(0, 12);
}

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
    patient: null, results: [], staffList: null, staffSel: new Set(), answers: {}, sources: {},
    smart: { appointments: "", plan: "" }, letterhead: null, printables: null,
    subjectEdited: false, bodyEdited: false, sending: false, touched: false,
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
            <div class="tr-row"><span>To</span><div class="tr-to" data-role="to"></div></div>
            <label class="tr-row"><span>CC</span><input class="fe-input" type="email" data-role="cc" maxlength="254" placeholder="Optional" value="${esc(task.recipients.cc || "")}" /></label>
            <label class="tr-row"><span>Subject</span><input class="fe-input" data-role="subject" maxlength="200" /></label>
            <div class="tr-body" data-role="body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message"></div>
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
  const bodyEl = $('[data-role="body"]');
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
    const set = (k, v) => m.set(k.toLowerCase(), v == null ? "" : String(v));
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
    task.fields.forEach((f) => { if (f.label.trim()) set(f.label.trim(), answerText(f)); });
    set("Upcoming appointments", st.smart.appointments);
    set("Treatment plan", st.smart.plan);
    const tx = task.fields.find((f) => TASK_CHOICE_TYPES.includes(f.type) && f.source === "treatments");
    if (tx) set("Treatment info", formatChoice({ ...tx, display: "links" }, chosen(tx)));
    return m;
  }

  function renderMessage(force = false) {
    const vals = values();
    if (!st.subjectEdited || force) subjectEl.value = fillTemplate(task.subject, vals).replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1");
    if (!st.bodyEdited || force) bodyEl.innerHTML = emailBodyHtml(fillTemplate(task.body, vals));
    if (force) { st.subjectEdited = false; st.bodyEdited = false; }
    resetBtn.hidden = !(st.subjectEdited || st.bodyEdited);
  }

  /* ---------- Who it's for ---------- */
  function renderTo() {
    const box = $('[data-role="to"]');
    if (task.category === "patient") {
      const onFile = (st.patient && st.patient.email) || "";
      const current = box.querySelector("input") ? box.querySelector("input").value : onFile;
      box.innerHTML = `<input class="fe-input" type="email" data-role="to-input" maxlength="254" placeholder="${st.patient ? "No email on file. Type one in." : "Choose the patient first"}" value="${esc(current)}" />
        <small class="tr-warn" data-role="to-warn" hidden></small>`;
      checkTo();
    } else {
      const ids = fixedStaff ? task.recipients.staffIds : [...st.staffSel];
      const names = (st.staffList || []).filter((s) => ids.includes(s.id)).map((s) => s.name);
      box.innerHTML = names.length
        ? `<div class="tr-chips">${names.map((n) => `<span class="tr-chip">${esc(n)}</span>`).join("")}</div>${
            names.length > 1 ? '<small class="muted">Each person gets their own copy, addressed to them.</small>' : ""}`
        : `<span class="muted">${st.staffList === null ? "Loading staff…" : "Choose staff on the left"}</span>`;
    }
  }
  function checkTo() {
    const input = $('[data-role="to-input"]');
    const warn = $('[data-role="to-warn"]');
    if (!input || !warn) return;
    const onFile = ((st.patient && st.patient.email) || "").toLowerCase();
    const v = input.value.trim().toLowerCase();
    warn.hidden = !st.patient || !v || !onFile || v === onFile;
    warn.textContent = "This isn't the email address on the patient's record.";
  }

  function patientCard() {
    const label = task.category === "patient" ? "Patient" : "Patient it's about";
    if (st.patient) {
      const p = st.patient;
      return `<div class="tr-person">
        <div><strong>${esc(p.name)}</strong><small>${esc([formatDobLong(p.dobKey) || p.dob, p.email || "No email on file"].filter(Boolean).join(" · "))}</small></div>
        ${patientId ? "" : '<button type="button" class="lh-btn is-quiet" data-act="change-patient">Change</button>'}
      </div>`;
    }
    return `<div class="tb-field"><span>${label}</span>
      <label class="ib-search tr-psearch">${I.search}<input type="search" data-role="psearch" placeholder="Search patients by name" autocomplete="off" /></label>
      <div class="tr-results" data-role="results">${st.results.map((r) => `
        <button type="button" class="tr-result" data-pick-patient="${esc(r.id)}">
          <strong>${esc(r.name)}</strong><small>${esc([r.dob, r.email].filter(Boolean).join(" · "))}</small>
        </button>`).join("")}</div>
      <small class="muted">Can't find them? Open the patient from the Patient List and use the Email button there.</small></div>`;
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
    // Choices
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
          ${o.link ? `<a class="tr-link" href="${esc(o.link)}" target="_blank" rel="noopener" title="Open the information page" aria-label="Open the page for ${esc(o.label)}">${I.ext}</a>` : ""}
        </div>`).join("") || '<p class="tb-none">No choices.</p>'}</div></div>`;
  }

  function renderLeft() {
    let n = 1;
    let h = "";
    if (task.category === "patient") {
      h += `<section class="tb-card"><h4><span class="tb-num">${n++}</span>Who it's for</h4>${patientCard()}</section>`;
    } else {
      h += `<section class="tb-card"><h4><span class="tb-num">${n++}</span>Who it goes to</h4>${staffCard()}</section>`;
      if (aboutPatient) h += `<section class="tb-card"><h4><span class="tb-num">${n++}</span>Which patient</h4>${patientCard()}</section>`;
    }
    if (task.fields.length) {
      h += `<section class="tb-card"><h4><span class="tb-num">${n++}</span>Details</h4>${task.fields.map(fieldHtml).join("")}</section>`;
    }
    left.innerHTML = h;
  }

  function renderAttachments() {
    const box = $('[data-role="atts"]');
    if (!task.attachments.length) { box.innerHTML = ""; return; }
    const names = task.attachments.map((id) => {
      const p = (st.printables || []).find((x) => x.id === id);
      return p ? p.name : "Attachment";
    });
    box.innerHTML = `<div class="tb-mail-att">${names.map((n2) => `<span class="tb-att">${I.doc}${esc(n2)}.pdf</span>`).join("")}</div>`;
  }

  /* ---------- Loading data ---------- */
  function loadSmart() {
    const p = st.patient;
    st.smart = { appointments: "", plan: "" };
    if (!p) { renderMessage(); return; }
    const jobs = [];
    if (uses("upcoming appointments")) {
      st.smart.appointments = "(loading appointments…)";
      jobs.push(fetchPreconsult(p).then((res) => {
        const lines = String((res && res.found && res.data && res.data.futureVisits) || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        st.smart.appointments = lines.length ? lines.map((l) => "• " + l).join("\n") : "There are no upcoming appointments booked at the moment.";
      }).catch(() => { st.smart.appointments = ""; }));
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

  async function pickPatient(id) {
    try {
      st.patient = await getPatient(id);
    } catch (err) { console.error(err); showToast("Couldn't open that patient. Try again."); return; }
    if (!root.isConnected) return;
    st.results = [];
    const input = $('[data-role="to-input"]');
    if (input) input.value = (st.patient && st.patient.email) || "";
    renderLeft(); renderTo(); loadSmart();
  }

  /* ---------- Events ---------- */
  let searchTimer = null;
  left.addEventListener("input", (e) => {
    const el = e.target;
    if (el.matches('[data-role="psearch"]')) {
      clearTimeout(searchTimer);
      const q = el.value;
      searchTimer = setTimeout(async () => {
        try { st.results = await searchPatients(q); } catch { st.results = []; }
        const box = left.querySelector('[data-role="results"]');
        if (box) box.innerHTML = st.results.map((r) => `
          <button type="button" class="tr-result" data-pick-patient="${esc(r.id)}">
            <strong>${esc(r.name)}</strong><small>${esc([r.dob, r.email].filter(Boolean).join(" · "))}</small>
          </button>`).join("") || (q.trim().length >= 2 ? '<p class="tb-none">No patients found with that name.</p>' : "");
      }, 300);
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

  left.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick-patient]");
    if (pick) { pickPatient(pick.dataset.pickPatient); return; }
    if (e.target.closest('[data-act="change-patient"]')) {
      st.patient = null;
      renderLeft(); renderTo(); loadSmart();
      const s = left.querySelector('[data-role="psearch"]');
      if (s) s.focus();
    }
  });

  root.querySelector('[data-role="to"]').addEventListener("input", checkTo);
  subjectEl.addEventListener("input", () => { st.subjectEdited = true; st.touched = true; resetBtn.hidden = false; });
  bodyEl.addEventListener("input", () => { st.bodyEdited = true; st.touched = true; resetBtn.hidden = false; });
  resetBtn.addEventListener("click", () => { renderMessage(true); noteEl.textContent = "Click into the message to change any wording."; });

  /* ---------- Sending ---------- */
  function problems() {
    const out = [];
    if (aboutPatient && !st.patient) out.push(task.category === "patient" ? "Choose the patient." : "Choose the patient this is about.");
    if (task.category === "patient") {
      const to = ($('[data-role="to-input"]') || {}).value || "";
      if (st.patient && !EMAIL_RE.test(to.trim())) out.push("Enter the patient's email address.");
    } else {
      const ids = fixedStaff ? task.recipients.staffIds : [...st.staffSel];
      if (!ids.length) out.push("Choose who to send it to.");
    }
    const cc = ccEl.value.trim();
    if (cc && !EMAIL_RE.test(cc)) out.push("Check the CC email address.");
    task.fields.forEach((f) => { if (f.required && isEmpty(st.answers[f.id])) out.push(`Answer “${f.label}”.`); });
    if (!subjectEl.value.trim()) out.push("Add a subject.");
    if (!bodyEl.textContent.trim()) out.push("The message is empty.");
    return out;
  }

  sendBtn.addEventListener("click", async () => {
    if (st.sending) return;
    const list = problems();
    if (list.length) {
      msgEl.textContent = list[0] + (list.length > 1 ? ` (and ${list.length - 1} more)` : "");
      return;
    }
    msgEl.textContent = "";
    st.sending = true;
    sendBtn.disabled = true;
    const label = sendBtn.querySelector("span");
    try {
      const attachments = [];
      if (task.attachments.length) {
        label.textContent = "Preparing PDFs…";
        for (const tid of task.attachments) attachments.push(await printablePdf({ templateId: tid, patient: st.patient }));
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
        html: bodyEl.innerHTML,
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