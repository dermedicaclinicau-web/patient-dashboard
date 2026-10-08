// Fill in a published form for a patient: #/fill/<patientId>/<templateId>
import { getFormTemplate, getFormVersion, getLetterhead, categoryLabel } from "./form-templates.js";
import { esc, renderField, normaliseField, watermarkHtml } from "./form-fields.js";
import { evaluateCalcs, formatCalc } from "./form-calc.js";
import { letterheadHtml, DEFAULT_LETTERHEAD } from "./form-letterhead.js";

export async function mountFormFill(container, param, { staff } = {}) {
  const [patientId = "", templateId = ""] = String(param || "").split("/");
  const back = `<a class="back-link" href="#/patient/${encodeURIComponent(patientId)}">← Back to patient</a>`;
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = back + '<div class="skeleton" style="height:420px;border-radius:14px"></div>';
  container.replaceChildren(root);

  const fail = (title, msg) => {
    if (root.isConnected) root.innerHTML = back + `<div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };
  if (!patientId || !templateId) { fail("Form not found", "Go back to the patient and choose a form again."); return; }

  let tpl, ver, letterhead;
  try {
    tpl = await getFormTemplate(templateId);
    if (!tpl || tpl.status !== "live" || !tpl.version) {
      fail("This form isn't available", "It may have been unpublished. Go back to the patient and choose another.");
      return;
    }
    [ver, letterhead] = await Promise.all([
      getFormVersion(templateId, tpl.version),
      getLetterhead().catch(() => DEFAULT_LETTERHEAD),
    ]);
  } catch (err) {
    console.error("Fill form load failed:", err);
    if (err && err.code === "permission-denied") fail("This form isn't available", "It may have been unpublished. Go back to the patient and choose another.");
    else fail("Couldn't open this form", "Check your connection and try again.");
    return;
  }
  if (!root.isConnected) return;
  if (!ver) { fail("Couldn't open this form", "The published copy is missing. Ask an admin to publish it again."); return; }

  const fields = ver.fields.map(normaliseField).filter(Boolean);
  const ctx = { live: true, fields, consentForms: [], letterhead, calcValues: null };
  const showLh = !(ver.settings && ver.settings.showLetterhead === false);

  root.innerHTML = `
    ${back}
    <div class="ff-wrap">
      <div class="ff-top">
        <div>
          <h2>${esc(ver.name)}</h2>
          <p class="muted">${esc(categoryLabel(tpl.category))} · Version ${ver.version}</p>
        </div>
      </div>
      <div class="fe-sheet ff-sheet" data-role="sheet">
        ${watermarkHtml(fields, letterhead)}
        ${showLh ? `<div class="fe-lh-wrap">${letterheadHtml(letterhead)}</div>` : ""}
        <h3 class="fe-title">${esc(ver.name)}</h3>
        <div class="fe-fields">${fields.map((f) => {
          const body = renderField(f, ctx);
          return body ? `<div class="fe-field">${body}</div>` : "";
        }).join("")}</div>
      </div>
      <div class="ff-actions">
        <p class="muted">Saving to the patient's record is the next step.</p>
        <button type="button" class="btn-primary" disabled>Save to patient record</button>
      </div>
    </div>`;

  const sheet = root.querySelector('[data-role="sheet"]');
  const updateCalcs = () => {
    const values = evaluateCalcs(fields, (f) => {
      const el = sheet.querySelector(`input[data-in="${f.id}"]`);
      return el ? el.value : null;
    });
    Object.keys(values).forEach((id) => {
      const out = sheet.querySelector(`[data-calc="${id}"]`);
      const f = fields.find((x) => x.id === id);
      if (out && f) out.textContent = formatCalc(values[id], f) || "—";
    });
  };
  sheet.addEventListener("input", updateCalcs);
  updateCalcs();
}