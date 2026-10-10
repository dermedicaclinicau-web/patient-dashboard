// Task Manager → To Print: print any published form blank, blank for a patient, or a completed copy.
// Route: #/tasks/print/<templateId>[/<patientId>]
import { listSubmissionsForPatient, getSubmission } from "./form-submissions.js";
import { getFormTemplate, getFormVersion, getLetterhead, getPrintSettings, categoryLabel } from "./form-templates.js";
import { DEFAULT_LETTERHEAD } from "./form-letterhead.js";
import { formPrintJob, pdfPayload, previewPdf, patientAnswers, deliveryError } from "./form-delivery.js";
import { niceDate } from "./form-document.js";
import { searchPatients } from "./task-runner.js";
import { getPatient, patientIds } from "./patients.js";
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  print: ic('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  open: ic('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
};
const pad = (n) => String(n).padStart(2, "0");
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const MODES = [["blank", "Blank"], ["patient", "Blank, for a patient"], ["saved", "A completed form"]];
const HINT = {
  blank: "The form as designed, with empty lines and boxes to fill in by hand.",
  patient: "The patient's details are filled in. Everything else is left blank.",
  saved: "A copy the patient has already completed, exactly as it was saved.",
};
const MAX_COPIES = 10;

// This patient's saved copies of this form (including from merged records), newest first
async function listSaved(patient, templateId) {
  const subs = await listSubmissionsForPatient([patient.id, ...patientIds(patient)]);
  return subs
    .filter((s) => s.templateId === templateId)
    .sort((a, b) => String(b.recordDate || "").localeCompare(String(a.recordDate || "")));
}

export async function mountPrintTask(container, { templateId, patientId = "" } = {}) {
  const backHref = "#/tasks/new/print";
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);
  const fail = (title, msg) => {
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };

  let tpl, liveVer, letterhead, printer = "";
  try {
    tpl = await getFormTemplate(templateId);
    if (!tpl || tpl.status !== "live" || !tpl.version) {
      fail("This form isn't available", "It may have been unpublished. Go back and choose another.");
      return;
    }
    const [v, lh, ps] = await Promise.all([
      getFormVersion(templateId, tpl.version),
      getLetterhead().catch(() => DEFAULT_LETTERHEAD),
      getPrintSettings().catch(() => ({ printerEmail: "" })),
    ]);
    liveVer = v;
    letterhead = lh;
    printer = String(ps.printerEmail || "");
  } catch (err) {
    console.error("Print form load failed:", err);
    fail("Couldn't open this form", "Check your connection and try again.");
    return;
  }
  if (!root.isConnected) return;
  if (!liveVer) { fail("Couldn't open this form", "Its published version is missing. Ask an admin to publish it again."); return; }

  const st = {
    mode: patientId ? "patient" : "blank", patient: null, saved: null, savedErr: "", chosen: "",
    copies: 1, job: null, seq: 0, busy: false, searchSeq: 0,
  };
  if (patientId) { try { st.patient = await getPatient(patientId); } catch (err) { console.warn("Patient load failed:", err); } }
  if (!root.isConnected) return;

  root.innerHTML = `
    <div class="ff-wrap tb-wrap">
      <div class="ff-bar" role="region" aria-label="Print actions">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${backHref}" aria-label="Back" title="Back">${I.back}</a>
          <div class="ff-bar-title"><strong>${esc(tpl.name)}</strong><span>To Print · ${esc(categoryLabel(tpl.category))}</span></div>
          <div class="ff-bar-actions">
            <button type="button" class="ff-btn" data-act="open" disabled>${I.open}<span>Open PDF</span></button>
            <button type="button" class="ff-btn is-primary" data-act="print" disabled>${I.print}<span>Print</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      <div class="tb-grid pt-grid">
        <div class="tb-form" data-role="left"></div>
        <aside class="tr-mail-col">
          <section class="tb-card">
            <h4>Preview</h4>
            <div class="pt-stage" data-role="stage"></div>
            <small class="muted">This is exactly what prints.</small>
          </section>
        </aside>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const left = $('[data-role="left"]');
  const stage = $('[data-role="stage"]');
  const msgEl = $('[data-role="msg"]');
  const openBtn = $('[data-act="open"]');
  const printBtn = $('[data-act="print"]');

  /* ---------- The left column ---------- */
  function patientHtml() {
    if (st.patient) {
      return `<div class="tb-pchip"><span><strong>${esc(st.patient.name)}</strong><small>${esc(st.patient.email || "")}</small></span>
        <button type="button" class="hx-add" data-act="change-patient">Change</button></div>`;
    }
    return `<div class="tb-psearch">
      <input class="fe-input" data-role="psearch" placeholder="Search for the patient by name" autocomplete="off" spellcheck="false" aria-label="Patient" />
      <div class="tb-presults" data-role="presults"></div></div>`;
  }

  function savedHtml() {
    if (st.saved === null) return '<p class="tb-none">Loading their saved copies…</p>';
    if (st.savedErr) return `<p class="tb-none tb-bad">${esc(st.savedErr)}</p>`;
    if (!st.saved.length) return `<p class="tb-none">${esc(st.patient.name)} has no saved copies of this form yet.</p>`;
    return `<div class="pt-saved">${st.saved.map((s) => `
      <label class="pt-saved-row">
        <input type="radio" name="pt-sub" value="${esc(s.id)}"${s.id === st.chosen ? " checked" : ""} />
        <span><strong>${esc(niceDate(s.recordDate) || "No date")}</strong>
          <small>${esc([s.createdBy && `by ${s.createdBy}`, s.version && s.version !== tpl.version ? `version ${s.version}` : ""].filter(Boolean).join(" · "))}</small></span>
      </label>`).join("")}</div>`;
  }

  function renderLeft() {
    const needPatient = st.mode !== "blank";
    left.innerHTML = `
      <section class="tb-card">
        <h4><span class="tb-num">1</span>Form</h4>
        <div class="pt-form"><strong>${esc(tpl.name)}</strong><small>${esc(categoryLabel(tpl.category))} · Version ${tpl.version}</small></div>
        <a class="hx-add pt-change" href="${backHref}">Choose a different form</a>
      </section>
      <section class="tb-card">
        <h4><span class="tb-num">2</span>What to print</h4>
        <div class="fe-seg">${MODES.map(([v, l]) => `
          <label class="fe-seg-btn"><input type="radio" name="pt-mode" value="${v}"${st.mode === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
        <p class="muted pt-hint">${HINT[st.mode]}</p>
        ${needPatient ? `<div class="tb-field"><span>Patient</span>${patientHtml()}</div>` : ""}
        ${st.mode === "saved" && st.patient ? `<div class="tb-field"><span>Saved copy</span>${savedHtml()}</div>` : ""}
      </section>
      <section class="tb-card">
        <h4><span class="tb-num">3</span>Copies</h4>
        <div class="fe-num"><input class="fe-input" type="number" min="1" max="${MAX_COPIES}" data-role="copies" value="${st.copies}" aria-label="Copies" /><span>${st.copies === 1 ? "copy" : "copies"}</span></div>
        <small class="muted">${printer
          ? `Each copy is sent to the clinic printer (${esc(printer)}).`
          : "No printer email address is set yet. An admin can add it in Form Builder, under Form settings. You can still open the PDF and print it yourself."}</small>
      </section>`;
  }

  function renderButtons() {
    openBtn.disabled = !st.job || st.busy;
    printBtn.disabled = !st.job || st.busy;
    if (!st.busy) printBtn.querySelector("span").textContent = st.copies > 1 ? `Print ${st.copies} copies` : "Print";
  }

  /* ---------- The preview ---------- */
  function notReady() {
    if (st.mode !== "blank" && !st.patient) return "Choose the patient to see the preview.";
    if (st.mode === "saved") {
      if (st.saved === null) return "Loading their saved copies…";
      if (!st.saved.length) return "There's nothing to preview until they have a saved copy of this form.";
      if (!st.chosen) return "Choose a saved copy.";
    }
    return "";
  }

  function fitPreview(frame) {
    const d = frame.contentDocument;
    if (!d || !frame.isConnected) return;
    const h = d.documentElement.scrollHeight;
    const scale = Math.min(1, (stage.clientWidth - 2) / 800);
    frame.style.height = `${h}px`;
    frame.style.transform = `scale(${scale})`;
    frame.parentElement.style.height = `${Math.ceil(h * scale)}px`;
  }

  async function buildJob() {
    const seq = ++st.seq;
    st.job = null;
    msgEl.textContent = "";
    renderButtons();
    const wait = notReady();
    if (wait) { stage.innerHTML = `<p class="tb-none pt-wait">${esc(wait)}</p>`; return; }
    stage.innerHTML = '<div class="skeleton pt-skel"></div>';
    try {
      let sub, ver = liveVer, blank = true;
      if (st.mode === "saved") {
        // The full saved form, loaded the same way as "View a saved form"
        const full = await getSubmission(st.chosen);
        if (!full) throw new Error("This saved form couldn't be found.");
        if (full.version && full.version !== tpl.version) ver = (await getFormVersion(templateId, full.version)) || liveVer;
        sub = { ...full, templateName: full.templateName || ver.name, patientName: full.patientName || st.patient.name || "" };
        blank = false;
      } else {
        const p = st.mode === "patient" ? st.patient : null;
        sub = {
          answers: p ? patientAnswers(ver, p) : {}, signatures: {}, templateName: ver.name,
          patientName: p ? p.name || "" : "", recordDate: p ? todayKey() : "", version: ver.version, createdBy: "",
        };
      }
      const job = await formPrintJob({ sub, ver, letterhead, blank });
      if (seq !== st.seq || !root.isConnected) return;
      st.job = job;
      job.blob().catch(() => {}); // start making the PDF now, so printing is quick
      stage.innerHTML = `<div class="pt-fit"><iframe class="pt-frame" title="Preview of ${esc(ver.name)}"></iframe></div>`;
      const frame = stage.querySelector("iframe");
      frame.addEventListener("load", () => { fitPreview(frame); setTimeout(() => fitPreview(frame), 600); });
      frame.srcdoc = job.doc.previewHtml;
    } catch (err) {
      console.error("Print preview failed:", err);
      if (seq === st.seq) stage.innerHTML = '<p class="tb-none tb-bad">Couldn\'t prepare this form. Check your connection and try again.</p>';
    }
    renderButtons();
  }

  /* ---------- Patient and saved copies ---------- */
  function search(q) {
    const box = left.querySelector('[data-role="presults"]');
    if (!box) return;
    if (q.trim().length < 2) { box.innerHTML = q.trim() ? '<p class="tb-none">Type at least 2 letters</p>' : ""; return; }
    box.innerHTML = '<p class="tb-none">Searching…</p>';
    const seq = ++st.searchSeq;
    clearTimeout(search.timer);
    search.timer = setTimeout(async () => {
      let list;
      try { list = await searchPatients(q); }
      catch (err) {
        console.warn("Patient search failed:", err);
        if (seq === st.searchSeq && box.isConnected) box.innerHTML = '<p class="tb-none tb-bad">Couldn\'t search. Check your connection.</p>';
        return;
      }
      if (seq !== st.searchSeq || !box.isConnected) return;
      box.innerHTML = list.length ? list.map((r) => `
        <button type="button" class="tb-presult" data-pick-patient="${esc(r.id)}">
          <strong>${esc(r.name)}</strong><small>${esc([r.dob && `DOB ${r.dob}`, r.email || "No email on file"].filter(Boolean).join(" · "))}</small>
        </button>`).join("") : '<p class="tb-none">No patients found. Try their last name.</p>';
    }, 250);
  }

  async function loadSaved() {
    const pid = st.patient && st.patient.id;
    if (!pid) return;
    st.saved = null;
    st.savedErr = "";
    st.chosen = "";
    try {
      const list = await listSaved(st.patient, templateId);
      if (!st.patient || st.patient.id !== pid) return;
      st.saved = list;
      st.chosen = list[0] ? list[0].id : "";
    } catch (err) {
      console.error("Saved forms load failed:", err);
      st.saved = [];
      st.savedErr = err && err.code === "permission-denied"
        ? "Saved forms are blocked. Check the form_submissions Firestore rule."
        : "Couldn't load their saved copies. Check your connection and try again.";
    }
    if (root.isConnected) { renderLeft(); buildJob(); }
  }

  async function pickPatient(id) {
    let p;
    try { p = await getPatient(id); }
    catch (err) { console.error("Patient load failed:", err); showToast("Couldn't open that patient. Try again."); return; }
    if (!p || !root.isConnected) return;
    st.patient = p;
    st.saved = null;
    st.chosen = "";
    renderLeft();
    if (st.mode === "saved") loadSaved();
    buildJob();
  }

  /* ---------- Printing ---------- */
  async function sendPrint() {
    if (!st.job || st.busy) return;
    if (!printer) {
      msgEl.textContent = "No printer email address is set. An admin can add it in Form Builder, under Form settings. Use Open PDF to print it yourself.";
      return;
    }
    const copies = st.copies;
    const saved = st.mode === "saved" ? st.saved.find((x) => x.id === st.chosen) : null;
    const label = printBtn.querySelector("span");
    st.busy = true;
    renderButtons();
    label.textContent = "Preparing PDF…";
    msgEl.textContent = "";
    try {
      const payload = await pdfPayload(st.job);
      label.textContent = "Sending…";
      const res = await callApi({
        action: "printTask",
        templateId, templateName: tpl.name, mode: st.mode, copies,
        patientId: st.mode !== "blank" && st.patient ? st.patient.id : "",
        patientName: st.mode !== "blank" && st.patient ? st.patient.name || "" : "",
        submissionId: saved ? saved.id : "",
        ...payload,
      });
      showToast(`Sent ${res.sent} cop${res.sent === 1 ? "y" : "ies"} to the printer`);
    } catch (err) {
      console.error("Print failed:", err);
      msgEl.textContent = deliveryError(err);
    } finally {
      st.busy = false;
      renderButtons();
    }
  }

  /* ---------- Events ---------- */
  left.addEventListener("input", (e) => {
    const el = e.target;
    if (el.name === "pt-mode") {
      st.mode = el.value;
      renderLeft();
      if (st.mode === "saved" && st.patient && st.saved === null) loadSaved();
      buildJob();
    } else if (el.name === "pt-sub") {
      st.chosen = el.value;
      buildJob();
    } else if (el.dataset.role === "copies") {
      st.copies = Math.min(MAX_COPIES, Math.max(1, parseInt(el.value, 10) || 1));
      const unit = el.parentElement.querySelector("span");
      if (unit) unit.textContent = st.copies === 1 ? "copy" : "copies";
      renderButtons();
    } else if (el.dataset.role === "psearch") {
      search(el.value);
    }
  });
  left.addEventListener("change", (e) => {
    if (e.target.dataset.role === "copies") e.target.value = st.copies;
  });

  root.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick-patient]");
    if (pick) { pickPatient(pick.dataset.pickPatient); return; }
    if (e.target.closest('[data-act="change-patient"]')) {
      st.patient = null;
      st.saved = null;
      st.chosen = "";
      renderLeft();
      buildJob();
      const s = left.querySelector('[data-role="psearch"]');
      if (s) s.focus();
      return;
    }
    if (e.target.closest('[data-act="open"]')) { if (st.job) previewPdf(st.job); return; }
    if (e.target.closest('[data-act="print"]')) sendPrint();
  });

  /* ---------- Start ---------- */
  renderLeft();
  if (st.mode === "saved" && st.patient) loadSaved();
  buildJob();
}