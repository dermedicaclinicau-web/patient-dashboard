// Skin Script settings (Firestore form_settings/ssp): validity, closing message, signature, email template.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { listTaskTypes } from "./task-types.js";
import { showToast } from "./utils.js";

export const SSP_DEFAULTS = {
  validMonths: 3,
  closing: [
    "This Skin Script Protocol is valid until {Valid until}.",
    "Dr. Teh will then provide you with a personalised skin assessment to ensure your skin health is on track.",
    "For all other questions on the above protocol, please do not hesitate to let us know.",
    "Visit our Online shop should you wish to purchase any of the above items: www.dermedica.com.au/online-store",
  ].join("\n"),
  signature: "Best Regards,\nDr Joanna Teh and the Team",
  emailTemplate: "",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let cache = null;

export async function getSspSettings({ force = false } = {}) {
  if (cache && !force) return cache;
  const snap = await getDoc(doc(db, "form_settings", "ssp"));
  const d = snap.exists() ? snap.data() : {};
  cache = {
    validMonths: Math.max(1, Math.min(24, parseInt(d.validMonths, 10) || SSP_DEFAULTS.validMonths)),
    closing: typeof d.closing === "string" ? d.closing : SSP_DEFAULTS.closing,
    signature: typeof d.signature === "string" ? d.signature : SSP_DEFAULTS.signature,
    emailTemplate: typeof d.emailTemplate === "string" ? d.emailTemplate : "",
  };
  return cache;
}

export async function saveSspSettings(s, staff) {
  const clean = {
    validMonths: Math.max(1, Math.min(24, parseInt(s.validMonths, 10) || 3)),
    closing: String(s.closing || "").slice(0, 3000),
    signature: String(s.signature || "").slice(0, 500),
    emailTemplate: /^[A-Za-z0-9]{10,40}$/.test(s.emailTemplate || "") ? s.emailTemplate : "",
  };
  await setDoc(doc(db, "form_settings", "ssp"), {
    ...clean, updatedAt: new Date().toISOString(), updatedBy: String((staff && staff.name) || "").slice(0, 120),
  });
  cache = clean;
  return clean;
}

// Admins: the settings window
export async function openSspSettings({ staff = null } = {}) {
  const [s, tasks] = await Promise.all([
    getSspSettings({ force: true }).catch(() => ({ ...SSP_DEFAULTS })),
    listTaskTypes({ isAdmin: true }).catch(() => []),
  ]);
  const templates = tasks.filter((t) => t.category === "patient" && t.channel === "email");
  return new Promise((resolve) => {
    let saved = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ssp-set";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Skin Script settings</h3><p>Used on every new Skin Script Protocol.</p></div>
        <label class="lh-field"><span class="lh-label">Valid for</span>
          <select class="fb-select" name="validMonths">${Array.from({ length: 12 }, (_, i) => i + 1).map((n) =>
            `<option value="${n}"${n === s.validMonths ? " selected" : ""}>${n} month${n === 1 ? "" : "s"}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Closing message</span>
          <textarea name="closing" rows="6" maxlength="3000">${esc(s.closing)}</textarea>
          <small class="fe-note">One paragraph per line. {Valid until}, {Record date} and {First name} are filled in. Web addresses become links.</small></label>
        <label class="lh-field"><span class="lh-label">Signature</span>
          <textarea name="signature" rows="2" maxlength="500">${esc(s.signature)}</textarea>
          <small class="fe-note">The last line is printed in bold.</small></label>
        <label class="lh-field"><span class="lh-label">Email template</span>
          <select class="fb-select" name="emailTemplate">
            <option value="">Standard Skin Script email</option>
            ${templates.map((t) => `<option value="${esc(t.id)}"${s.emailTemplate === t.id ? " selected" : ""}>${esc(t.name)}${
              t.status === "live" ? "" : " (draft: publish it in Task Manager)"}</option>`).join("")}
          </select>
          <small class="fe-note">Make templates in Task Manager → Task types (To Patient). {Valid until} and {Record date} work there too.</small></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save settings</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        await saveSspSettings({
          validMonths: form.elements.validMonths.value,
          closing: form.elements.closing.value,
          signature: form.elements.signature.value,
          emailTemplate: form.elements.emailTemplate.value,
        }, staff);
        saved = true;
        dlg.close();
        showToast("Skin Script settings saved");
      } catch (ex) {
        console.error("SSP settings save failed:", ex);
        err.textContent = ex.code === "permission-denied"
          ? "Only admins can change these. Check the form_settings/ssp rule has been published." : "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Save settings";
      }
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(saved); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}