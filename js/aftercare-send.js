// "Email aftercare" and "Print aftercare" from a form being filled in.
import { getTaskType } from "./task-types.js";
import { fillTemplate, fillTemplateHtml, emailShell, clinicDetails, EMAIL_RE } from "./task-tokens.js";
import { createRichEditor } from "./rich-editor.js";
import { openImagePicker } from "./image-bank.js";
import { getLetterhead } from "./form-templates.js";
import { aftercarePdf, deliveryError } from "./form-delivery.js";
import { cleanRichHtml } from "./rich-html.js";
import { callApi } from "./appointments.js";
import { showToast, formatDobLong, formatMobile } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Used when the form doesn't name a template
const STANDARD = {
  subject: "Your aftercare instructions - Dermedica",
  body: "<p>Hi {First name},</p><p>Thank you for visiting Dermedica. Here are your aftercare instructions:</p>" +
    "<div>{Aftercare}</div><p>If you have any questions, just reply to this email or call us on {Clinic phone}.</p>" +
    "<p>Kind regards,<br>{Staff name}<br>Dermedica</p>",
  style: {},
};

const aftercareHtml = (items) => items.map((it) =>
  `<h2>${esc(it.title || "Aftercare")}</h2>${cleanRichHtml(it.html || "")}`).join("");

function sendError(err) {
  switch (err && err.code) {
    case "NO_PATIENT": return "This patient couldn't be found.";
    case "BAD_EMAIL": return "Check the email addresses and try again.";
    default: return deliveryError(err);
  }
}

/* ---------- Email ---------- */

export async function emailAftercare({ items, patient, staff, templateId = "" }) {
  let tpl = null;
  if (templateId) {
    try { const t = await getTaskType(templateId); if (t && t.status === "live") tpl = t; }
    catch (err) { console.warn("Aftercare template unavailable, using the standard email:", err); }
  }
  const lh = await getLetterhead().catch(() => null);
  const src = tpl ? { subject: tpl.subject, body: tpl.body, style: tpl.style } : STANDARD;
  const c = clinicDetails(lh);
  const p = patient || {};

  // The template's blanks
  const vals = new Map();
  const set = (k, v) => vals.set(k.toLowerCase(), v == null ? "" : v);
  set("First name", p.firstName); set("Full name", p.name); set("Email", p.email);
  set("Mobile", p.mobile ? formatMobile(p.mobile) : ""); set("Date of birth", formatDobLong(p.dobKey) || p.dob);
  set("Today", new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }));
  set("Staff name", (staff && staff.name) || "");
  set("Clinic phone", c.phone); set("Clinic email", c.email); set("Clinic address", c.address);
  ["Upcoming appointments", "Treatment plan", "Treatment info"].forEach((k) => set(k, ""));
  (tpl ? tpl.fields : []).forEach((f) => { if (String(f.label || "").trim()) set(f.label.trim(), ""); });
  set("Aftercare", { html: aftercareHtml(items), text: items.map((i) => i.title).join(", ") });

  const onFile = String(p.email || "").trim();
  return new Promise((resolve) => {
    let sent = false;
    let busy = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ac-mail";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head">
          <h3>Email aftercare</h3>
          <p>${esc(items.map((i) => i.title).join(", "))}${tpl ? ` · Template: ${esc(tpl.name)}` : ""}</p>
        </div>
        <div class="ac-ed-two">
          <label class="lh-field"><span class="lh-label">To</span>
            <input type="email" name="to" maxlength="254" autocomplete="off" value="${esc(onFile)}" /></label>
          <label class="lh-field"><span class="lh-label">CC (optional)</span>
            <input type="email" name="cc" maxlength="254" autocomplete="off" value="${esc((tpl && tpl.recipients.cc) || "")}" /></label>
        </div>
        <p class="ec-warn" data-role="warn" hidden></p>
        <label class="lh-field"><span class="lh-label">Subject</span>
          <input name="subject" maxlength="200" value="${esc(fillTemplate(src.subject, vals))}" /></label>
        <div class="lh-field"><span class="lh-label">Message</span>
          <div class="tr-canvas" style="background-color:${esc((src.style && src.style.background) || "#f1f5f9")}"><div data-role="editor"></div></div></div>
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
      pickImage: () => openImagePicker({ isAdmin: false }),
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
      if (!editor.text().trim()) { showErr("The message is empty."); return; }
      busy = true;
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending…";
      showErr("");
      try {
        await callApi({
          action: "sendAftercareEmail",
          patientId: p.id || "",
          to, cc, subject,
          html: emailShell(editor.getHtml(), src.style || {}, { clinic: c, hasLogo: !!(lh && lh.logo) }),
          templateId: tpl ? tpl.id : "",
          titles: items.map((i) => i.title),
        });
        sent = true;
        busy = false;
        dlg.close();
        showToast(`Aftercare emailed to ${to}`);
      } catch (err) {
        console.error("Email aftercare failed:", err);
        busy = false;
        sendBtn.disabled = false;
        sendBtn.textContent = "Send email";
        showErr(sendError(err));
      }
    });

    dlg.addEventListener("close", () => { dlg.remove(); resolve(sent); });
    dlg.showModal();
    (onFile ? form.elements.subject : form.elements.to).focus();
  });
}

/* ---------- Print ---------- */

export async function printAftercare({ items, patient }) {
  const payload = await aftercarePdf({ items, patient });
  await callApi({ action: "printPdf", pdf: payload.pdf, fileName: payload.fileName });
}