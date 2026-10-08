// Emailing a saved form as a PDF, sending it to the clinic printer,
// the send log, and the printer address setting.
// The PDF is made in the browser so it looks exactly like the preview.
import { callApi } from "./appointments.js";
import { getPatient } from "./patients.js";
import { getPrintSettings, savePrintSettings } from "./form-templates.js";
import { esc } from "./form-fields.js";
import { buildFormDocument, niceDate } from "./form-document.js";
import { showToast } from "./utils.js";
import { bankImage } from "./image-bank-api.js";

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const PDF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const HTML2PDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";

/* ---------- Hand-over from the fill-in page ("Save & email" / "Save & print") ---------- */

let pending = null;
export function queueDelivery(submissionId, kind) { pending = { submissionId, kind }; }
export function takeDelivery(submissionId) {
  if (!pending || pending.submissionId !== submissionId) return null;
  const kind = pending.kind;
  pending = null;
  return kind;
}

/* ---------- Messages ---------- */

export function deliveryError(err) {
  switch (err && err.code) {
    case "UNAUTHORIZED": return "Your session has expired. Log out and back in, then try again.";
    case "NO_PRINTER": return "No printer email address is set. An admin can add it in Form Builder, under Form settings.";
    case "BAD_EMAIL": return "Check the email address and try again.";
    case "RATE_LIMITED": return "You've sent a lot of emails in the last hour. Try again a little later.";
    case "QUOTA": return "The clinic's email limit for today has been reached. Try again tomorrow.";
    case "PDF_FAILED": return "Couldn't create the PDF. Try again.";
    case "NOT_FOUND": return "This saved form couldn't be found.";
    case "INVALID_PIN":
      return "The server hasn't been updated yet. In Apps Script, deploy a new version (Deploy → Manage deployments → Edit → New version).";
    case "SERVER_ERROR":
      return "The server hit an error while sending. Check Apps Script → Executions for details.";
    default:
      return err && err.message && !err.code
        ? err.message
        : `Couldn't send${err && err.code ? ` (${err.code})` : ""}. Check your connection and try again.`;
  }
}

function when(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function deliveriesHtml(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return `<ul class="ff-log">${list.slice().reverse().map((d) => `
    <li>${d.kind === "print"
      ? "Sent to the printer"
      : `Emailed to ${esc(d.to)}${d.cc ? ` (cc ${esc(d.cc)})` : ""}`} by ${esc(d.sentBy || "staff")}, ${esc(when(d.sentAt))}</li>`).join("")}
  </ul>`;
}

/* ---------- Making the PDF in the browser ---------- */

let libPromise = null;
function loadHtml2Pdf() {
  if (window.html2pdf) return Promise.resolve(window.html2pdf);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = HTML2PDF_URL;
      s.async = true;
      s.onload = () => (window.html2pdf ? resolve(window.html2pdf) : reject(new Error("PDF tool didn't load")));
      s.onerror = () => { libPromise = null; reject(new Error("PDF tool didn't load")); };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

async function renderPdf(doc) {
  const html2pdf = await loadHtml2Pdf();
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;";
  holder.innerHTML = `<style>${doc.css}</style><div class="pdfdoc">${doc.inner}</div>`;
  document.body.appendChild(holder);
  try {
    return await html2pdf().set({
      margin: [12, 12, 12, 12],
      filename: doc.fileName,
      image: { type: "jpeg", quality: 0.92 },
      html2canvas: { scale: 2, backgroundColor: "#ffffff", logging: false },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"], avoid: [".q", ".block", "tr", ".sig"] },
    }).from(holder.querySelector(".pdfdoc")).outputPdf("blob");
  } finally {
    holder.remove();
  }
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// One saved form's PDF, made once and reused (preview, then send)
// Image Bank pictures used by the form, ready to go into the PDF
async function preloadImages(fields) {
  const ids = [...new Set((fields || [])
    .filter((f) => f.type === "image" && f.source !== "staff" && f.fileId)
    .map((f) => f.fileId))];
  const out = {};
  await Promise.all(ids.map((id) => bankImage(id).then((src) => { out[id] = src; }).catch(() => {})));
  return out;
}

// One saved form's PDF, made once and reused (preview, then send)
async function formPdf({ sub, ver, letterhead }) {
  const images = await preloadImages(ver.fields);
  const doc = buildFormDocument({ sub, ver, letterhead, images });
  let job = null;
  return {
    doc,
    blob() {
      if (!job) job = renderPdf(doc).catch((err) => { job = null; throw err; });
      return job;
    },
  };
}

// What gets sent to Apps Script: the finished PDF, or (if the browser couldn't
// make one) the document, which the server then turns into a PDF itself
async function pdfPayload(p) {
  try {
    return { pdf: await blobToBase64(await p.blob()), fileName: p.doc.fileName };
  } catch (err) {
    console.warn("Browser PDF failed; the server will make it instead:", err);
    return { html: p.doc.printHtml, fileName: p.doc.fileName };
  }
}

async function previewPdf(p) {
  const w = window.open("", "_blank");
  if (w) w.document.write('<p style="font-family:Arial,sans-serif;padding:2rem;color:#475569">Preparing the PDF…</p>');
  try {
    const url = URL.createObjectURL(await p.blob());
    if (w) w.location.href = url; else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (err) {
    console.warn("PDF preview failed, showing the page instead:", err);
    if (w) { w.document.open(); w.document.write(p.doc.previewHtml); w.document.close(); }
  }
}

/* ---------- Send to printer ---------- */

export async function sendToPrinter({ sub, ver, letterhead }) {
  const payload = await pdfPayload(await formPdf({ sub, ver, letterhead }));
  const res = await callApi({ action: "sendFormPdf", submissionId: sub.id, kind: "print", ...payload });
  return res.entry;
}

/* ---------- Email window ---------- */

// Resolves with the send-log entry, or null if cancelled
export async function openEmailComposer({ sub, ver, letterhead, staff }) {
  let patient = null;
  try { patient = await getPatient(sub.patientId); } catch (err) { console.warn("Couldn't load patient email:", err); }
  const onFile = String((patient && patient.email) || "").trim();
  const first = (patient && patient.firstName) || String(sub.patientName || "").split(" ")[0] || "";
  const p = await formPdf({ sub, ver, letterhead });
  p.blob().catch(() => {}); // start making the PDF now, so sending is quick
  const fileName = p.doc.fileName;

  const message =
    `Hi ${first || "there"},\n\n` +
    `Please find attached a copy of your ${sub.templateName}, completed on ${niceDate(sub.recordDate)}.\n\n` +
    "If you have any questions, just reply to this email.\n\n" +
    `Kind regards,\n${(staff && staff.name) || "The team"}\nDermedica`;

  return new Promise((resolve) => {
    let result = null;
    let sending = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ec-dialog";
    dlg.setAttribute("aria-labelledby", "ec-title");
    dlg.innerHTML = `
      <form class="lh-form ec-form" novalidate>
        <div class="lh-dialog-head">
          <h3 id="ec-title">Email this form</h3>
          <p>The completed form is attached as a PDF.</p>
        </div>
        <label class="lh-field"><span class="lh-label">To</span>
          <input type="email" data-k="to" maxlength="254" value="${esc(onFile)}" autocomplete="off" />
        </label>
        <p class="ec-warn" data-role="warn" hidden></p>
        <label class="lh-field"><span class="lh-label">CC (optional)</span>
          <input type="email" data-k="cc" maxlength="254" autocomplete="off" />
        </label>
        <label class="lh-field"><span class="lh-label">Subject</span>
          <input type="text" data-k="subject" maxlength="200" value="${esc(`Your ${sub.templateName} - Dermedica`)}" />
        </label>
        <label class="lh-field"><span class="lh-label">Message</span>
          <textarea data-k="message" rows="8" maxlength="5000">${esc(message)}</textarea>
        </label>
        <div class="ec-attach">${PDF_ICON}<span title="${esc(fileName)}">${esc(fileName)}</span>
          <button type="button" class="lh-btn is-quiet" data-act="preview">Preview</button>
        </div>
        <p class="lh-error" data-role="error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary" data-role="send">Send email</button>
        </div>
      </form>`;

    const $ = (s) => dlg.querySelector(s);
    const toEl = $('[data-k="to"]');
    const warn = $('[data-role="warn"]');
    const errEl = $('[data-role="error"]');
    const sendBtn = $('[data-role="send"]');
    const showErr = (m) => { errEl.textContent = m || ""; errEl.hidden = !m; };

    const checkTo = () => {
      const v = toEl.value.trim().toLowerCase();
      if (!onFile) { warn.textContent = "There's no email address on this patient's record. Type one in."; warn.hidden = false; }
      else { warn.textContent = "This isn't the email address on the patient's record."; warn.hidden = !v || v === onFile.toLowerCase(); }
    };
    toEl.addEventListener("input", checkTo);
    checkTo();

    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]') && !sending) dlg.close();
      if (e.target.closest('[data-act="preview"]')) previewPdf(p);
    });
    dlg.addEventListener("cancel", (e) => { if (sending) e.preventDefault(); });

    $("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const to = toEl.value.trim();
      const cc = $('[data-k="cc"]').value.trim();
      const subject = $('[data-k="subject"]').value.trim();
      const msg = $('[data-k="message"]').value;
      if (!EMAIL_RE.test(to)) { showErr("Enter a valid email address in To."); toEl.focus(); return; }
      if (cc && !EMAIL_RE.test(cc)) { showErr("Check the CC email address."); return; }
      if (!msg.trim()) { showErr("Add a short message."); return; }

      sending = true;
      sendBtn.disabled = true;
      sendBtn.textContent = "Preparing PDF…";
      showErr("");
      try {
        const payload = await pdfPayload(p);
        sendBtn.textContent = "Sending…";
        const res = await callApi({
          action: "sendFormPdf", submissionId: sub.id, kind: "email",
          to, cc, subject, message: msg, ...payload,
        });
        result = res.entry;
        sending = false;
        dlg.close();
        showToast(`Emailed to ${to}`);
      } catch (err) {
        console.error("Email form failed:", err);
        sending = false;
        showErr(deliveryError(err));
        sendBtn.disabled = false;
        sendBtn.textContent = "Send email";
      }
    });

    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    dlg.showModal();
    (onFile ? $('[data-k="message"]') : toEl).focus();
  });
}

/* ---------- Printer address (admins, from Form Builder) ---------- */

export async function openPrinterDialog(staff) {
  let current = "";
  try { current = (await getPrintSettings()).printerEmail; } catch (err) { console.warn("Couldn't load printer settings:", err); }

  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog fe-confirm";
  dlg.innerHTML = `
    <form class="lh-form ec-form" novalidate>
      <div class="lh-dialog-head">
        <h3>Printer email address</h3>
        <p>Save &amp; print and Send to printer email the PDF here. Use the printer's own email-print address.</p>
      </div>
      <label class="lh-field"><span class="lh-label">Email address</span>
        <input type="email" data-k="printer" maxlength="254" value="${esc(current)}" placeholder="printer@example.com" />
      </label>
      <p class="lh-error" data-role="error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary" data-role="save">Save</button>
      </div>
    </form>`;
  const input = dlg.querySelector('[data-k="printer"]');
  const errEl = dlg.querySelector('[data-role="error"]');
  const btn = dlg.querySelector('[data-role="save"]');

  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v && !EMAIL_RE.test(v)) { errEl.textContent = "Enter a valid email address."; errEl.hidden = false; return; }
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await savePrintSettings({ printerEmail: v }, staff);
      dlg.close();
      showToast(v ? "Printer address saved" : "Printer address removed");
    } catch (err) {
      console.error("Save printer address failed:", err);
      errEl.textContent = err.code === "permission-denied"
        ? "Only admins can change this. Check the form_settings rule has been published."
        : "Couldn't save. Try again.";
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = "Save";
    }
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  input.focus();
}