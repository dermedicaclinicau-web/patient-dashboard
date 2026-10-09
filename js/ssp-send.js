// Skin Script Protocol: preview, download, send to printer, email to patient.
import { buildSspDocument, longDate } from "./ssp-document.js";
import { getSspSettings } from "./ssp-settings.js";
import { docToPdf, deliveryError } from "./form-delivery.js";
import { getLetterhead } from "./form-templates.js";
import { getTaskType } from "./task-types.js";
import { fillTemplate, fillTemplateHtml, emailShell, clinicDetails, EMAIL_RE } from "./task-tokens.js";
import { createRichEditor } from "./rich-editor.js";
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PDF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

const STANDARD = {
  subject: "Your Skin Script Protocol - Dermedica",
  body: "<p>Hi {First name},</p><p>Please find attached your Skin Script Protocol, valid until {Valid until}.</p>" +
    "<p>If you have any questions, just reply to this email or call us on {Clinic phone}.</p>" +
    "<p>Kind regards,<br>{Staff name}<br>Dermedica</p>",
  style: {},
};

function sendError(err) {
  if (err && err.code === "NOT_FOUND") return "This protocol couldn't be found. Save it first.";
  return deliveryError(err);
}

/* ===================== Preview ===================== */

// record: a saved protocol (has id) or an unsaved one from the builder (then onSave saves it and returns it)
// Resolves with { saved: true } if it was saved from here.
export async function openSspPreview({ record, patient = null, staff = null, onSave = null, autoAction = "" } = {}) {
  const [settings, letterhead] = await Promise.all([
    getSspSettings().catch(() => null),
    getLetterhead().catch(() => null),
  ]);
  let rec = record;
  let savedHere = false;
  const doc = buildSspDocument({ record: rec, letterhead, settings });
  let pdfJob = null;
  const pdf = () => {
    if (!pdfJob) pdfJob = docToPdf(doc).catch((e) => { pdfJob = null; throw e; });
    return pdfJob;
  };

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ssp-prev";
    dlg.innerHTML = `
      <div class="ssp-prev-bar">
        <div><strong>Skin Script Protocol</strong><span class="ssp-prev-state" data-role="state"></span></div>
        <div class="ssp-prev-acts">
          <button type="button" class="lh-btn is-quiet" data-act="close">Close</button>
          <button type="button" class="lh-btn" data-act="save" hidden>Save</button>
          <button type="button" class="lh-btn" data-act="pdf">Download PDF</button>
          <button type="button" class="lh-btn" data-act="print">Send to printer</button>
          <button type="button" class="lh-btn is-primary" data-act="email">Email to patient</button>
        </div>
      </div>
      <p class="ssp-prev-msg" data-role="msg" aria-live="polite"></p>
      <div class="ssp-prev-body"><div class="ssp-paper"><style>${doc.css}</style><div class="pdfdoc">${doc.inner}</div></div></div>`;
    document.body.appendChild(dlg);
    const $ = (s) => dlg.querySelector(s);
    const msg = (t) => { $('[data-role="msg"]').textContent = t || ""; };
    let busy = false;

    function renderState() {
      $('[data-role="state"]').textContent = rec.id ? ` · Saved ${longDate(rec.recordDate)}` : " · Not saved yet";
      $('[data-act="save"]').hidden = !!rec.id || !onSave;
    }
    renderState();

    async function ensureSaved() {
      if (rec.id) return rec;
      if (!onSave) throw new Error("This protocol hasn't been saved.");
      msg("Saving…");
      rec = await onSave();
      savedHere = true;
      renderState();
      msg("");
      return rec;
    }

    async function run(btn, label, fn) {
      if (busy) return;
      busy = true;
      dlg.querySelectorAll(".ssp-prev-acts button").forEach((b) => { b.disabled = true; });
      const old = btn.textContent;
      btn.textContent = label;
      try { await fn(); } catch (err) {
        console.error("SSP action failed:", err);
        msg(err && err.code ? sendError(err) : (err && err.message) || "Something went wrong. Try again.");
      } finally {
        busy = false;
        dlg.querySelectorAll(".ssp-prev-acts button").forEach((b) => { b.disabled = false; });
        btn.textContent = old;
      }
    }

    dlg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const a = b.dataset.act;
      if (a === "close") { if (!busy) dlg.close(); return; }
      if (a === "save") run(b, "Saving…", async () => { await ensureSaved(); showToast("Skin Script Protocol saved"); });
      if (a === "pdf") run(b, "Preparing…", async () => {
        const out = await pdf();
        const url = URL.createObjectURL(out.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = out.fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      });
      if (a === "print") run(b, "Sending…", async () => {
        const saved = await ensureSaved();
        const out = await pdf();
        await callApi({ action: "ssp", op: "deliver", kind: "print", recordId: saved.id, pdf: out.pdf, fileName: out.fileName });
        showToast("Sent to the printer");
      });
      if (a === "email") run(b, "Preparing…", async () => {
        const saved = await ensureSaved();
        await openSspEmail({ rec: saved, patient, staff, settings, letterhead, pdf });
      });
    });
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.addEventListener("close", () => { dlg.remove(); resolve({ saved: savedHere }); });
    dlg.showModal();
    if (autoAction) {
      setTimeout(() => {
        const b = $(`[data-act="${autoAction}"]`);
        if (b && !b.hidden) b.click();
      }, 0);
    }
  });
}

/* ===================== Email ===================== */

async function openSspEmail({ rec, patient, staff, settings, letterhead, pdf }) {
  let tpl = null;
  if (settings && settings.emailTemplate) {
    try { const t = await getTaskType(settings.emailTemplate); if (t && t.status === "live") tpl = t; }
    catch (err) { console.warn("SSP email template unavailable, using the standard email:", err); }
  }
  const src = tpl ? { subject: tpl.subject, body: tpl.body, style: tpl.style } : STANDARD;
  const c = clinicDetails(letterhead);
  const p = patient || {};
  const vals = new Map();
  const set = (k, v) => vals.set(k.toLowerCase(), v == null ? "" : v);
  set("First name", p.firstName || String(rec.patientName || "").split(" ")[0]);
  set("Full name", p.name || rec.patientName); set("Email", p.email); set("Mobile", p.mobile);
  set("Today", new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }));
  set("Staff name", (staff && staff.name) || "");
  set("Clinic phone", c.phone); set("Clinic email", c.email); set("Clinic address", c.address);
  set("Valid until", longDate(rec.validUntil)); set("Record date", longDate(rec.recordDate));
  ["Upcoming appointments", "Treatment plan", "Treatment info", "Aftercare"].forEach((k) => set(k, ""));
  (tpl ? tpl.fields : []).forEach((f) => { if (String(f.label || "").trim()) set(f.label.trim(), ""); });

  const onFile = String(p.email || "").trim();
  const fileName = (await pdf().catch(() => null) || {}).fileName || "Skin Script Protocol.pdf";

  return new Promise((resolve) => {
    let busy = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ac-mail";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Email Skin Script Protocol</h3>
          <p>${esc(rec.patientName || "")}${tpl ? ` · Template: ${esc(tpl.name)}` : ""}</p></div>
        <div class="ac-ed-two">
          <label class="lh-field"><span class="lh-label">To</span><input type="email" name="to" maxlength="254" value="${esc(onFile)}" /></label>
          <label class="lh-field"><span class="lh-label">CC (optional)</span><input type="email" name="cc" maxlength="254" value="${esc((tpl && tpl.recipients.cc) || "")}" /></label>
        </div>
        <p class="ec-warn" data-role="warn" hidden></p>
        <label class="lh-field"><span class="lh-label">Subject</span><input name="subject" maxlength="200" value="${esc(fillTemplate(src.subject, vals))}" /></label>
        <div class="lh-field"><span class="lh-label">Message</span>
          <div class="tr-canvas" style="background-color:${esc((src.style && src.style.background) || "#f1f5f9")}"><div data-role="editor"></div></div></div>
        <div class="ec-attach">${PDF_ICON}<span title="${esc(fileName)}">${esc(fileName)}</span></div>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary" data-role="send">Send email</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("form");
    const warn = dlg.querySelector('[data-role="warn"]');
    const errEl = dlg.querySelector(".lh-error");
    const sendBtn = dlg.querySelector('[data-role="send"]');
    const showErr = (m) => { errEl.textContent = m || ""; errEl.hidden = !m; };
    const editor = createRichEditor(dlg.querySelector('[data-role="editor"]'), {
      accent: () => (src.style && src.style.accent) || "#0f766e",
    });
    editor.setHtml(fillTemplateHtml(src.body, vals));

    const checkTo = () => {
      const v = form.elements.to.value.trim().toLowerCase();
      if (!onFile) { warn.textContent = "There's no email on this patient's record. Type one in."; warn.hidden = false; return; }
      warn.textContent = "This isn't the email address on the patient's record.";
      warn.hidden = !v || v === onFile.toLowerCase();
    };
    form.elements.to.addEventListener("input", checkTo);
    checkTo();

    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const to = form.elements.to.value.trim();
      const cc = form.elements.cc.value.trim();
      const subject = form.elements.subject.value.trim();
      if (!EMAIL_RE.test(to)) { showErr("Enter a valid email address in To."); return; }
      if (cc && !EMAIL_RE.test(cc)) { showErr("Check the CC email address."); return; }
      if (!subject) { showErr("Add a subject."); return; }
      busy = true;
      sendBtn.disabled = true;
      sendBtn.textContent = "Preparing PDF…";
      showErr("");
      try {
        const out = await pdf();
        sendBtn.textContent = "Sending…";
        await callApi({
          action: "ssp", op: "deliver", kind: "email", recordId: rec.id,
          to, cc, subject,
          html: emailShell(editor.getHtml(), src.style || {}, { clinic: c, hasLogo: !!(letterhead && letterhead.logo) }),
          pdf: out.pdf, fileName: out.fileName,
        });
        busy = false;
        dlg.close();
        showToast(`Skin Script emailed to ${to}`);
      } catch (err) {
        console.error("SSP email failed:", err);
        busy = false;
        sendBtn.disabled = false;
        sendBtn.textContent = "Send email";
        showErr(sendError(err));
      }
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(); });
    dlg.showModal();
    (onFile ? form.elements.subject : form.elements.to).focus();
  });
}