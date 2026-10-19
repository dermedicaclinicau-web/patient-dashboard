// Fill in a published form for a patient: #/fill/<patientId>/<templateId>
// View a saved one:                      #/form-record/<submissionId>
import { getFormTemplate, getFormVersion, getLetterhead, categoryLabel, listPublishedForms } from "./form-templates.js";
import { fetchPatientRecords } from "./records.js";
import { fetchBillingAndRx } from "./billing-rx-view.js";
import { esc, svg, ICONS, renderField, normaliseField, watermarkHtml, canRequire,
  choiceList, otherLabel, syncChoiceExtras, readExtras, writeExtras, readImageQs, writeImageQs, STAFF_FILLS,
  tableCols, tableMax, tableRowHtml, syncTableRows, tableClick, tableTotal, tableRecalc, spanClass, syncButtons,
  readTableDisc, readTablePays, tableInvRead, tableInvWrite, tableInvoice } from "./form-fields.js";
import { listMarkingSets, markSummary } from "./marking-sets.js";
import { evaluateCalcs, formatCalc } from "./form-calc.js";
import { letterheadHtml, DEFAULT_LETTERHEAD } from "./form-letterhead.js";
import { getPatient, patientIds, formatMedicare, formatMedicareExpiry } from "./patients.js";
import { saveSubmission, getSubmission, listSubmissionsForPatient } from "./form-submissions.js";
import { confirmDialog } from "./dialog.js";
import { showToast, formatDobLong, formatMobile } from "./utils.js";
import { queueDelivery, takeDelivery, openEmailComposer, sendToPrinter, deliveriesHtml, deliveryError } from "./form-delivery.js";
import { conditionPasses, visibleIds } from "./form-conditions.js";
import { formGroup } from "./form-templates.js";
import { highlightRecord } from "./records-view.js";
import { formTitleHtml } from "./form-fields.js";
import { hydrateBankImages } from "./image-bank-api.js";
import { attachAnnotators } from "./form-annotate.js";
import { bankImage } from "./image-bank-api.js";
import { mountAftercareField } from "./aftercare-field.js";
import { mountPhotoField } from "./photo-field.js";
import { mountConsumablesField, consumablesViewHtml } from "./consumables-field.js";
import { consumeInTx } from "./inventory-api.js";
import { listStaffDetails, staffDetailsFor } from "./staff-details.js";
import { mountSpecialistField } from "./specialist-field.js";
import { tagValues, collectTagNodes, applyTagNodes, fillTags, formFieldTags } from "./form-tags.js";
import { mountRichTextField } from "./rich-field.js";
import { openMoveRecordDialog, canMoveRecords, movesHtml } from "./record-move.js";
import { signaturePad, readField, applyVisibility, isBlank, fieldTagValues } from "./form-live.js";
export { readField, applyVisibility, answerTagText, fieldTagValues } from "./form-live.js";

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const BAR_ICONS = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  print: ic('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  mail: ic('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  check: ic('<polyline points="20 6 9 17 4 12"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
};

const LAYOUT = ["text_block", "space", "letterhead", "watermark", "button"]; // nothing is saved for these
const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => isoOf(new Date());
const $all = (el, s) => [...el.querySelectorAll(s)];
// "Fill in consent now": remembers the treatment form while the consent is filled in
const RETURN_KEY = "dm.consentReturn";
function readReturn() {
  try {
    const r = JSON.parse(sessionStorage.getItem(RETURN_KEY) || "null");
    return r && Date.now() - Number(r.at || 0) < 3 * 3600000 ? r : null;
  } catch { return null; }
}
function writeReturn(r) { try { sessionStorage.setItem(RETURN_KEY, JSON.stringify(r)); } catch { /* storage full or private mode */ } }
function clearReturn() { try { sessionStorage.removeItem(RETURN_KEY); } catch { /* ignore */ } }

function niceDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return key || "";
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function sheetHtml({ name, fields, settings, letterhead }) {
  const ctx = { live: true, fields, consentForms: [], letterhead, calcValues: null };
  const showLh = !(settings && settings.showLetterhead === false);
  return `
    ${watermarkHtml(fields, letterhead)}
    ${showLh ? `<div class="fe-lh-wrap">${letterheadHtml(letterhead)}</div>` : ""}
    ${formTitleHtml(name, settings || {})}
    <div class="fe-fields">${fields.map((f) => {
      const body = renderField(f, ctx);
      return body ? `<div class="fe-field${spanClass(f)}" data-fid="${esc(f.id)}">${body}</div>` : "";
    }).join("")}</div>`;
}

// Consent check and Prescription check: what was found, or a button to fill one in now
function consentHtml(f, res, { canStart = false } = {}) {
  const rx = f.type === "prescription_status";
  const months = Number(f.months) || (rx ? 6 : 12);
  const icon = svg(ICONS[f.type] || ICONS.consent_status);
  if (res && res.found) {
    return `<div class="fe-consent">${icon}<span>${rx ? "Prescription" : "Signed"} ${res.name ? `“${esc(res.name)}” ` : ""}on ${esc(niceDate(res.date))}.${
      res.submissionId ? ` <a href="#/form-record/${encodeURIComponent(res.submissionId)}">View it</a>`
      : res.link ? ` <a href="${esc(res.link)}" target="_blank" rel="noopener noreferrer">View PDF</a>` : ""}</span></div>`;
  }
  return `<div class="fe-consent is-warn">${icon}<span>No ${rx ? "prescription" : "signed consent"} in the last ${months} months.${
    f.block ? ` This form can't be saved until ${rx ? "there's a valid prescription" : "one is signed"}.` : ""}</span>${
    canStart && f.consentFormId
      ? `<button type="button" class="ff-btn is-primary fe-consent-go" data-consent-go="${esc(f.consentFormId)}" data-kind="${rx ? "Prescription" : "Consent"}">Fill in ${
          rx ? "prescription" : "consent"} now</button>` : ""}</div>`;
}



function writeField(f, w, v) {
  const set = (el, val) => { if (el) el.value = val ?? ""; };
  switch (f.type) {
    case "short_text": case "long_text": case "email": case "date": case "record_date":
      set(w.querySelector(".fe-in"), v); break;
    case "number":
      set(w.querySelector("input[data-in]"), v); break;
    case "dropdown":
      set(w.querySelector("select"), v); break;
    case "single_choice": {
      const list = choiceList(f);
      $all(w, 'input[type="radio"]').forEach((x, i) => { x.checked = list[i] === v; });
      break;
    }
    case "checkboxes": {
      const s = new Set(Array.isArray(v) ? v : []);
      const list = choiceList(f);
      $all(w, 'input[type="checkbox"]').forEach((x, i) => { x.checked = s.has(list[i]); });
      break;
    }
    case "checkbox_notes": {
      const m = new Map((Array.isArray(v) ? v : []).map((r) => [r.option, r.note]));
      const list = choiceList(f);
      $all(w, ".fe-optnote").forEach((row, i) => {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = m.has(list[i]);
        set(row.querySelector(".fe-note-in"), m.get(list[i]) || "");
      });
      break;
    }
    case "sub_checks": {
      const rows = Array.isArray(v) ? v : [];
      const m = new Map(rows.map((r) => [r.option, new Set(r.subs || [])]));
      $all(w, ".fe-sub").forEach((row, i) => {
        const boxes = $all(row, 'input[type="checkbox"]');
        if (row.classList.contains("is-other")) {
          const hit = rows.find((r) => r.option === otherLabel(f) && "other" in r);
          if (boxes[0]) boxes[0].checked = !!hit;
          set(row.querySelector("[data-other]"), hit ? hit.other : "");
          return;
        }
        const grp = f.groups[i] || { label: "", subs: [] };
        const subs = m.get(grp.label);
        const subList = [...(grp.subs || []), ...(grp.other ? [otherLabel(f)] : [])];
        const hit = rows.find((r) => r.option === grp.label);
        if (boxes[0]) boxes[0].checked = !!subs;
        boxes.slice(1).forEach((b, j) => { b.checked = !!subs && subs.has(subList[j]); });
        set(row.querySelector("[data-subother]"), (hit && hit.subOther) || "");
        const sn = new Map(((hit && Array.isArray(hit.subNotes)) ? hit.subNotes : []).map((n) => [n.sub, n.note]));
        $all(row, "[data-subcmt]").forEach((c) => { c.value = sn.get((grp.subs || [])[Number(c.dataset.subcmt)]) || ""; });
      });
      syncChoiceExtras(f, w);
      break;
    }
    case "table": {
      const saved = Array.isArray(v) ? v : [];
      const tbody = w.querySelector("tbody");
      const want = Math.min(saved.length, tableMax(f));
      if (tbody) while (tbody.rows.length < want) tbody.insertAdjacentHTML("beforeend", tableRowHtml(f, true, true));
      const cols = tableCols(f);
      $all(w, "tbody tr").forEach((tr, r) => {
        const cells = saved[r] && Array.isArray(saved[r].cells) ? saved[r].cells : [];
        cols.forEach((c, ci) => {
          const el = tr.querySelector(`[data-c="${ci}"]`);
          if (!el) return;
          if (c.type === "check") el.checked = cells[ci] === true;
          else if (c.type !== "calc") el.value = cells[ci] === null || cells[ci] === undefined || cells[ci] === false ? "" : String(cells[ci]);
        });
      });
      syncTableRows(f, w);
      tableRecalc(f, w); // Calculated cells and totals
      break;
    }
    case "calculation": {
      const out = w.querySelector("[data-calc]");
      if (out) out.textContent = formatCalc(v, f) || "—";
      break;
    }
    case "clinician": {
      const sel = w.querySelector("[data-clin-pick]");
      if (sel && v && v.staffId) {
        if (![...sel.options].some((o) => o.value === v.staffId)) {
          sel.insertAdjacentHTML("beforeend", `<option value="${esc(v.staffId)}">${esc(v.name || "Clinician")}</option>`);
        }
        sel.value = v.staffId;
      }
      $all(w, "[data-cpart]").forEach((el) => { el.value = (v && v[el.dataset.cpart]) || ""; });
      break;
    }
    case "rich_text":
      if (w.rtWrite) w.rtWrite(v);
      break;
    case "specialist":
      if (w.spWrite) w.spWrite(v);
      break;
    case "patient":
      $all(w, "[data-part]").forEach((el) => { el.value = (v && v[el.dataset.part]) || ""; });
      break;
  }
}


// The meaningful part of a form / record name: years, versions and filler words removed, so
// "2026 Wrinkle Relaxer Consent Form" and "Wrinkle Relaxer Consent Form" both become "wrinkle relaxer".
const NAME_NOISE = new Set(["consent", "consents", "form", "forms", "record", "records", "version", "new", "updated",
  "copy", "of", "for", "and", "the", "patient", "prescription", "prescriptions", "script", "scripts", "rx", "s4"]);
function coreName(s) {
  return String(s || "").toLowerCase()
    .replace(/\bwr\b/g, "wrinkle relaxer")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NAME_NOISE.has(w) && !/^(19|20)\d{2}$/.test(w) && !/^v\d+$/.test(w))
    .join(" ");
}

// Consent check: the chosen consent form filled in on the portal, or a consent with the same name
// (years and "Consent Form" ignored), on the portal or in the older consent records.
// Prescription check: the chosen prescription form filled in on the portal, or a prescription with the same name
// (years and "S4 / Prescription" ignored) from the patient's Prescription cards: older records, portal forms or scanned.
async function checkConsents(consentFields, patient) {
  const needConsents = consentFields.some((f) => f.type === "consent_status");
  const needRx = consentFields.some((f) => f.type === "prescription_status");
  const [subs, recs, forms, rxData] = await Promise.all([
    listSubmissionsForPatient([patient.id, ...patientIds(patient)]),
    needConsents
      ? fetchPatientRecords(patient).catch((err) => { console.warn("Older consents not checked:", err); return null; })
      : null,
    listPublishedForms().catch(() => []),
    needRx
      ? fetchBillingAndRx(patient).catch((err) => { console.warn("Older prescriptions not checked:", err); return null; })
      : null,
  ]);
  // Every prescription on the patient's two Prescription cards, newest first (null if they couldn't be loaded)
  const allRx = rxData && (rxData.injectables || rxData.rx)
    ? [...(rxData.injectables || []), ...(rxData.rx || [])]
        .sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0))
    : null;

  const out = {};
  consentFields.forEach((f) => {
    const cut = new Date();
    cut.setMonth(cut.getMonth() - (Number(f.months) || (f.type === "prescription_status" ? 6 : 12)));
    cut.setHours(0, 0, 0, 0);
    const cutKey = isoOf(cut);
    const tpl = forms.find((t) => t.id === f.consentFormId);
    const want = tpl ? coreName(tpl.name) : "";
    const pdf = (r) => (!r.portalId && /^https:\/\//i.test(r.link || "") ? r.link : "");

    // 1) The chosen form, filled in on the portal (most recent first)
    const hit = f.consentFormId
      ? subs.filter((s) => s.templateId === f.consentFormId && s.recordDate >= cutKey)
          .sort((a, b) => String(b.recordDate).localeCompare(String(a.recordDate)))[0]
      : null;
    if (hit) {
      out[f.id] = { found: true, date: hit.recordDate, submissionId: hit.id, name: hit.templateName };
      return;
    }

    // 2) Consent checks: a consent with the same name, portal or older record
    if (f.type === "consent_status" && recs && want) {
      const c = recs.consents.find((x) => x.date && x.date >= cut && coreName(x.title) === want);
      if (c) {
        out[f.id] = { found: true, date: isoOf(c.date), submissionId: c.portalId || "", name: c.title, link: pdf(c) };
        return;
      }
    }

    // 3) Prescription checks: a prescription with the same name on either Prescription card
    if (f.type === "prescription_status" && want) {
      if (allRx) {
        const p = allRx.find((x) => x.date && x.date >= cut && coreName(x.title) === want);
        if (p) {
          out[f.id] = { found: true, date: isoOf(p.date), submissionId: p.portalId || "", name: p.title, link: pdf(p) };
          return;
        }
      } else {
        // The cards couldn't be loaded: portal prescriptions only
        const p = subs
          .filter((s) => s.category === "prescription" && s.recordDate >= cutKey && coreName(s.templateName) === want)
          .sort((a, b) => String(b.recordDate).localeCompare(String(a.recordDate)))[0];
        if (p) {
          out[f.id] = { found: true, date: p.recordDate, submissionId: p.id, name: p.templateName };
          return;
        }
      }
    }

    // Nothing found
    out[f.id] = { found: false, date: "", submissionId: "", name: "" };
  });
  return out;
}


/* ===================== Fill in ===================== */

// embedded (Task Manager overlay): { onSaved(submissionId), onCancel(), saveLabel }
export async function mountFormFill(container, param, { staff, embedded = null } = {}) {
  const [pid = "", tid = ""] = String(param || "").split("/");
  const patientHref = `#/patient/${encodeURIComponent(pid)}`;
  const ret = embedded ? null : readReturn();
  const isConsentLeg = !!(ret && ret.patientId === pid && ret.consentId === tid);   // filling in the consent
  const isReturnLeg = !!(ret && ret.patientId === pid && ret.templateId === tid && !isConsentLeg); // back on the treatment form
  const exitHref = isConsentLeg ? ret.returnHash : patientHref;
  const back = embedded ? "" : `<a class="back-link" href="${patientHref}">← Back to patient</a>`;
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = back + '<div class="skeleton" style="height:420px;border-radius:14px"></div>';
  container.replaceChildren(root);

  const fail = (title, msg) => {
    if (root.isConnected) root.innerHTML = back + `<div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };
  if (!pid || !tid) { fail("Form not found", "Go back to the patient and choose a form again."); return; }

  let tpl, patient, ver, letterhead, markSets = [];
  try {
    [tpl, patient] = await Promise.all([
      getFormTemplate(tid).catch((err) => { if (err && err.code === "permission-denied") return null; throw err; }),
      getPatient(pid),
    ]);
    if (!patient) { fail("Patient not found", "Go back to the patient list and try again."); return; }
    if (!tpl || tpl.status !== "live" || !tpl.version) {
      fail("This form isn't available", "It may have been unpublished. Go back to the patient and choose another.");
      return;
    }
    [ver, letterhead, markSets] = await Promise.all([
      getFormVersion(tid, tpl.version),
      getLetterhead().catch(() => DEFAULT_LETTERHEAD),
      listMarkingSets().catch(() => []),
    ]);
  } catch (err) {
    console.error("Fill form load failed:", err);
    fail("Couldn't open this form", "Check your connection and try again.");
    return;
  }
  if (!root.isConnected) return;
  if (!ver) { fail("Couldn't open this form", "The published copy is missing. Ask an admin to publish it again."); return; }

  const fields = ver.fields.map(normaliseField).filter(Boolean);

  root.innerHTML = `
    <div class="ff-wrap">
      <div class="ff-bar" role="region" aria-label="Form actions">
        <div class="ff-bar-inner">
          ${embedded
            ? `<button type="button" class="ff-back" data-act="emb-cancel" aria-label="Cancel" title="Cancel">${BAR_ICONS.back}</button>`
            : `<a class="ff-back" href="${exitHref}" aria-label="Back" title="Back">${BAR_ICONS.back}</a>`}
          <div class="ff-bar-title">
            <strong>${esc(ver.name)}</strong>
            <span>${esc(patient.name)} · ${esc(categoryLabel(tpl.category))} · Version ${ver.version}</span>
          </div>
          <span class="ff-progress" data-role="progress" hidden></span>
          <div class="ff-bar-actions">${embedded ? `
            <button type="button" class="ff-btn is-quiet" data-act="emb-cancel">Cancel</button>
            <button type="button" class="ff-btn is-primary" data-save="save">${BAR_ICONS.check}<span>${esc(embedded.saveLabel || "Save")}</span></button>` : `
            <a class="ff-btn is-quiet" href="${exitHref}">Cancel</a>
            <button type="button" class="ff-btn" data-save="print">${BAR_ICONS.print}<span>Save &amp; print</span></button>
            <button type="button" class="ff-btn" data-save="email">${BAR_ICONS.mail}<span>Save &amp; email</span></button>
            <button type="button" class="ff-btn is-primary" data-save="save">${BAR_ICONS.check}<span>Save</span></button>`}
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
        ${isConsentLeg ? `<p class="ff-return">${esc(ret.kind || "Consent")} for <strong>${esc(ret.templateName)}</strong>. When you save, you'll go back to it.</p>` : ""}
      </div>
      <div class="fe-sheet ff-sheet" data-role="sheet">${sheetHtml({ name: ver.name, fields, settings: ver.settings, letterhead })}</div>
    </div>`;

  const sheet = root.querySelector('[data-role="sheet"]');
  hydrateBankImages(sheet);
  const annots = attachAnnotators(sheet, fields, { markSets });
  const msgEl = root.querySelector('[data-role="msg"]');
  const progressEl = root.querySelector('[data-role="progress"]');
  const saveBtns = $all(root, "[data-save]");
  const wrap = (id) => sheet.querySelector(`[data-fid="${CSS.escape(id)}"]`);
  // Hidden from staff: hidden with a class, not `hidden`, so calculations, tags and show-when rules still read the answer
  fields.forEach((f) => { if (f.liveHide) { const w = wrap(f.id); if (w) w.classList.add("is-livehide"); } });
  const tagNodes = collectTagNodes(sheet);
  const pads = {};
  const consent = {};
  let calc = {};
  let shown = new Set(fields.map((f) => f.id));
  let dirty = false, saving = false;

  // Signature pads (with name + date), and photos (coming next)
  fields.forEach((f) => {
    const w = wrap(f.id);
    if (!w) return;
    if (f.type === "signature") {
      const host = w.querySelector(".fe-sig");
      if (!host) return;
      pads[f.id] = signaturePad(host);
      if (f.showNameDate !== false) {
        const fixed = f.signer === "practitioner" ? ((staff && staff.name) || "")
          : (f.signer || "patient") === "patient" ? (patient.name || "") : "";
        host.insertAdjacentHTML("afterend", `
          <div class="sig-meta">
            <label><small>Name</small><input class="fe-in" type="text" data-sig-name maxlength="120" value="${esc(fixed)}"${fixed ? " readonly" : ' placeholder="Name of the person signing"'} /></label>
            <label><small>Date</small><input class="fe-in" type="date" data-sig-date value="${todayIso()}" readonly /></label>
          </div>`);
      }
    }
    if (f.type === "photo") {
      const el = w.querySelector(".fe-photo");
      if (el) el.outerHTML = '<p class="fe-help">Taking photos on forms is coming soon.</p>';
    }
  });
  // Aftercare panels
  fields.filter((f) => f.type === "aftercare").forEach((f) => {
    mountAftercareField(wrap(f.id), f, { onChange: () => { dirty = true; }, patient, staff, actions: true });
  });

    // Photo questions
  fields.filter((f) => f.type === "image" && f.source === "staff").forEach((f) => {
    mountPhotoField(wrap(f.id), f, { patient, onChange: () => { dirty = true; } });
  });

  // Products used. An amount can follow a marked picture, Calculation or Number on this form.
  const linkedValue = (id) => {
    const src = fields.find((x) => x.id === id);
    const w = wrap(id);
    if (!src || (w && w.hidden)) return null;
    if (src.type === "image") { const a = annots[id]; return a && a.total ? a.total() : null; }
    if (src.type === "calculation") return Number.isFinite(calc[id]) ? calc[id] : null;
    if (src.type === "number") {
      const el = sheet.querySelector(`input[data-in="${CSS.escape(id)}"]`);
      return el && el.value !== "" ? Number(el.value) : null;
    }
    return null;
  };
  const linkedLabel = (id) => {
    const src = fields.find((x) => x.id === id);
    return !src ? "the form" : src.type === "image" ? (src.label || src.fileName || "the picture") : (src.label || "the form");
  };
  fields.filter((f) => f.type === "consumables").forEach((f) => {
    mountConsumablesField(wrap(f.id), f, { staff, onChange: () => { dirty = true; }, linked: linkedValue, linkLabel: linkedLabel });
  });
  // Referral specialist: from the Specialist Bank. Staff can add or correct one here.
  fields.filter((f) => f.type === "specialist").forEach((f) => {
    mountSpecialistField(wrap(f.id), f, { staff, onChange: () => { dirty = true; } });
  });
  // Rich text answers: their starting text fills in from the patient now, and from the specialist once chosen
  fields.filter((f) => f.type === "rich_text").forEach((f) => {
    mountRichTextField(wrap(f.id), f, { onChange: () => { dirty = true; }, tags: tagValues({ patient, staff, recordDate: todayIso() }) });
  });

  const P = {
    "patient.name": patient.name,
    "patient.firstName": patient.firstName,
    "patient.lastName": patient.lastName,
    "patient.dob": patient.dobKey,
    "patient.email": patient.email,
    "patient.mobile": patient.mobile,
    "patient.address": patient.address,
    "patient.medicare": formatMedicare(patient.medicareNo),
    "patient.medicareIrn": patient.medicareIrn,
    "patient.medicareExp": formatMedicareExpiry(patient.medicareExp),
    "today": todayIso(),
    "staff.name": (staff && staff.name) || "",
  };
  const PART_VALUES = {
    name: patient.name,
    dob: formatDobLong(patient.dobKey) || patient.dob,
    mobile: patient.mobile ? formatMobile(patient.mobile) : "",
    email: patient.email,
    address: patient.address,
    medicare: formatMedicare(patient.medicareNo),
    medicareIrn: patient.medicareIrn,
    medicareExp: formatMedicareExpiry(patient.medicareExp),
    pttId: patient.pttId || patient.id,
  };
  
  fields.forEach((f) => {
    const w = wrap(f.id);
    if (!w) return;
    if (f.fill && P[f.fill]) {
      const el = w.querySelector(".fe-in");
      if (el) el.value = P[f.fill];
    }
    if (f.type === "patient") {
      $all(w, "[data-part]").forEach((el) => {
        el.value = PART_VALUES[el.dataset.part] || "";
        el.readOnly = true;
      });
    }
  });


    // Clinician details and the staff number fills: from Staff, loaded in the background. Never overwrites typing.
  let staffList = [];
  const meDetails = () => staffDetailsFor(staffList, staff) || { id: "", name: (staff && staff.name) || "" };
  const fillClin = (w, d, overwrite) => $all(w, "[data-cpart]").forEach((el) => {
    if (overwrite || !el.value) el.value = (d && d[el.dataset.cpart]) || "";
  });
  fields.filter((f) => f.type === "clinician").forEach((f) => { const w = wrap(f.id); if (w) fillClin(w, meDetails(), false); });
  if (fields.some((f) => f.type === "clinician" || STAFF_FILLS.includes(f.fill))) {
    listStaffDetails()
      .then((list) => {
        if (!root.isConnected) return;
        staffList = list;
        const me = meDetails();
        fields.forEach((f) => {
          const w = wrap(f.id);
          if (!w) return;
          if (STAFF_FILLS.includes(f.fill)) {
            const el = w.querySelector(".fe-in");
            const v = me[f.fill.slice(6)];
            if (el && !el.value && v) el.value = v;
          }
          if (f.type === "clinician") {
            const sel = w.querySelector("[data-clin-pick]");
            if (sel) {
              const keep = sel.value;
              sel.innerHTML = '<option value="">Choose a clinician</option>' + list.map((s) =>
                `<option value="${esc(s.id)}">${esc(s.name)}${s.providerNo ? ` · ${esc(s.providerNo)}` : ""}</option>`).join("");
              sel.value = keep || me.id || "";
            }
            fillClin(w, me, false);
          }
        });
        refresh();
      })
      .catch((err) => console.warn("Staff details not loaded:", err));
  }

  // Merge tags: the patient, the staff member, the record date and the specialist chosen on this form
  const liveTags = () => {
    const spF = fields.find((f) => f.type === "specialist" && shown.has(f.id));
    const spW = spF && wrap(spF.id);
    const rdF = fields.find((f) => f.type === "record_date" && shown.has(f.id));
    const rdEl = rdF && wrap(rdF.id) && wrap(rdF.id).querySelector(".fe-in");
    return fieldTagValues(sheet, fields, tagValues({
      patient, staff, specialist: spW && spW.spRead ? spW.spRead() : null,
      recordDate: (rdEl && rdEl.value) || todayIso(),
    }), rctx());
  };

  /* ---------- Calculations + which questions show ---------- */
  const rctx = () => ({ pads, calc, consent, annots });

  const updateCalcs = () => {
    calc = evaluateCalcs(fields, (f, col) => {
      const w = wrap(f.id);
      if (w && w.hidden) return null; // hidden questions count as unanswered
      if (f.type === "table") return tableTotal(f, w, col);
      if (f.type === "image") { const a = annots[f.id]; return a && a.total ? a.total() : null; }
      const el = sheet.querySelector(`input[data-in="${CSS.escape(f.id)}"]`);
      return el ? el.value : null;
    });
    Object.keys(calc).forEach((id) => {
      const out = sheet.querySelector(`[data-calc="${CSS.escape(id)}"]`);
      const f = fields.find((x) => x.id === id);
      if (out && f) out.textContent = formatCalc(calc[id], f) || "—";
    });
  };

  // Twice, because a calculation can depend on what's shown and decide what's shown
  const refresh = () => {
    fields.forEach((f) => { if (f.type === "table") tableRecalc(f, wrap(f.id)); });
    updateCalcs();
    shown = applyVisibility(sheet, fields, rctx());
    updateCalcs();
    shown = applyVisibility(sheet, fields, rctx());
    fields.forEach((f) => {
      if (f.type !== "consumables") return;
      const w = wrap(f.id);
      if (w && w.csSync) w.csSync();
    });
    updateProgress();
    const tv = liveTags();
    applyTagNodes(tagNodes, tv, null); // an empty tag stays visible until it can be filled
    syncButtons(sheet, fields, tv);
    fields.forEach((f) => {
      if (f.type !== "rich_text") return;
      const w = wrap(f.id);
      if (w && w.rtRetag) w.rtRetag(tv);
    });
  };

  // "2 of 4 required" in the top bar (only questions that are showing count)
  function updateProgress() {
    let need = 0, done = 0;
    fields.forEach((f) => {
      if (!f.required || !canRequire(f.type) || LAYOUT.includes(f.type) || f.type === "photo") return;
      if (!shown.has(f.id) || f.liveHide) return;
      const w = wrap(f.id);
      if (!w) return;
      need++;
      if (!isBlank(readField(f, w, rctx()))) done++;
    });
    progressEl.hidden = !need;
    progressEl.classList.toggle("is-done", done === need);
    progressEl.textContent = done === need ? "All required answered" : `${done} of ${need} required`;
  }
  // Back from "Fill in consent now": put the answers back
  if (isReturnLeg) {
    const a = ret.answers || {};
    fields.forEach((f) => {
      const w = wrap(f.id);
      if (!w || !(f.id in a)) return;
      tableInvWrite(f, w, a);
      writeField(f, w, a[f.id]);
      writeExtras(f, w, a[`${f.id}__x`]);
    });
    $all(sheet, "[data-linked]").forEach((el) => { if (el.value) el.dataset.touched = "1"; });
    clearReturn();
    dirty = Object.keys(a).length > 0;
    const redo = fields.some((f) => f.type === "signature" || f.type === "aftercare" || (f.type === "image" && (f.source === "staff" || f.annotate)));
    showToast(redo
      ? "Welcome back. Your answers are restored. Add any signatures, photos or aftercare again."
      : "Welcome back. Your answers are restored.");
  }
  refresh();

  // Consent checks run in the background
  const consentFields = fields.filter((f) => f.type === "consent_status" || f.type === "prescription_status");
  let consentReady = !consentFields.length;
  if (consentFields.length) {
    checkConsents(consentFields, patient)
      .then((res) => Object.assign(consent, res))
      .catch((err) => {
        console.warn("Consent check failed:", err);
        consentFields.forEach((f) => { consent[f.id] = { found: false, date: "", submissionId: "", name: "" }; });
      })
      .finally(() => {
        consentReady = true;
        if (!root.isConnected) return;
        consentFields.forEach((f) => {
          const el = wrap(f.id) && wrap(f.id).querySelector(".fe-consent");
          if (el) el.outerHTML = consentHtml(f, consent[f.id], { canStart: !embedded }); // no leaving the overlay mid-task
        });
        refresh();
      });
  }

  sheet.addEventListener("input", (e) => {
    if (e.target.matches && e.target.matches("[data-linked]")) e.target.dataset.touched = "1"; // staff typed: stop following
    const clinPick = e.target.closest("[data-clin-pick]");
    if (clinPick) {
      const d = staffList.find((s) => s.id === clinPick.value);
      fillClin(clinPick.closest("[data-fid]"), d || {}, true);
    }
    dirty = true;
    refresh();
    const w = e.target.closest("[data-fid]");
    if (w && w.classList.contains("is-invalid")) {
      w.classList.remove("is-invalid");
      const err = w.querySelector(".ff-err");
      if (err) err.remove();
    }
    // Ticking "Other" (or a choice that asks for details) jumps into its box
    const t = e.target;
    if (w && t.matches('input[type="radio"], input[type="checkbox"], select') && (t.tagName === "SELECT" || t.checked)) {
      const row = t.closest(".fe-optx");
      const box = row ? row.querySelector("[data-other], [data-cmt], [data-subother], [data-subcmt]") : w.querySelector("[data-other]:not([hidden]), [data-cmt]:not([hidden])");
      if (box && !box.hidden) box.focus();
    }
  });

    // Tables: + Add a row / remove an added row
  sheet.addEventListener("click", (e) => {
    if (tableClick(e.target, fields)) { dirty = true; refresh(); }
  });
  fields.filter((f) => f.type === "table").forEach((f) => syncTableRows(f, wrap(f.id)));

    // "Fill in consent now": keep the answers so far, then open the consent form
  root.addEventListener("click", (e) => {
    const go = e.target.closest("[data-consent-go]");
    if (!go) return;
    const draft = {};
    fields.forEach((f) => {
      if (LAYOUT.includes(f.type) || ["photo", "signature", "image", "aftercare", "consumables", "consent_status", "prescription_status"].includes(f.type)) return;
      const w = wrap(f.id);
      if (!w || w.hidden) return;
      draft[f.id] = readField(f, w, rctx());
      const x = readExtras(f, w);
      if (x) draft[`${f.id}__x`] = x;
      if (f.type === "table") Object.assign(draft, tableInvRead(f, w));
    });
    writeReturn({
      at: Date.now(), patientId: pid, templateId: tid, templateName: ver.name,
      consentId: go.dataset.consentGo,
      kind: go.dataset.kind || "Consent",
      returnHash: `#/fill/${encodeURIComponent(pid)}/${encodeURIComponent(tid)}`,
      answers: draft,
    });
    dirty = false; // the answers are kept, so don't ask "Leave without saving?"
    location.hash = `#/fill/${encodeURIComponent(pid)}/${encodeURIComponent(go.dataset.consentGo)}`;
  });

  /* ---------- Checking and saving ---------- */
  function problems() {
    const out = [];
    const t = todayIso();
    fields.forEach((f) => {
      if (LAYOUT.includes(f.type) || f.type === "photo") return;
      if (!shown.has(f.id)) return; // hidden questions are never required
      if (f.liveHide) return;       // staff can't see it, so they can't be asked to fix it
      const w = wrap(f.id);
      if (!w) return;
      const v = readField(f, w, rctx());
      if (f.type === "image" && f.source !== "staff") {
        const got = new Set(readImageQs(f, w).map((q) => q.id));
        const miss = (f.questions || []).find((q) => q.required && String(q.label || "").trim() && !got.has(q.id));
        if (miss) { out.push({ id: f.id, msg: `Answer “${miss.label}”.` }); return; }
      }
      if (f.type === "aftercare" && w.acProblem) {
        const m = w.acProblem();
        if (m) { out.push({ id: f.id, msg: m }); return; }
      }
      if (f.type === "consumables" && w.csProblem) {
        const m = w.csProblem();
        if (m) { out.push({ id: f.id, msg: m }); return; }
      }
      if (f.required && canRequire(f.type) && isBlank(v)) {
        out.push({ id: f.id, msg: f.type === "signature" ? "Sign here before saving." : "Answer this question." });
        return;
      }
      if (f.type === "email" && v && !EMAIL_RE.test(v)) out.push({ id: f.id, msg: "Enter a valid email address." });
      if (f.type === "table") {
        const inv = tableInvoice(f);
        const d = readTableDisc(f, w);
        if (inv && inv.disc === "percent" && d !== null && d > 100) out.push({ id: f.id, msg: "The discount can't be more than 100%." });
        else if (readTablePays(f, w).some((p) => p.amount > 0 && !p.method)) out.push({ id: f.id, msg: "Choose how each payment was made." });
      }
      if (f.type === "date" && v) {
        if (f.range === "past" && v > t) out.push({ id: f.id, msg: "Choose today or an earlier date." });
        if (f.range === "future" && v < t) out.push({ id: f.id, msg: "Choose today or a later date." });
      }
      if (f.type === "number" && v !== null) {
        if (f.min !== null && f.min !== undefined && v < Number(f.min)) out.push({ id: f.id, msg: `Enter ${f.min} or more.` });
        else if (f.max !== null && f.max !== undefined && v > Number(f.max)) out.push({ id: f.id, msg: `Enter ${f.max} or less.` });
      }
      if (f.type === "signature" && v && f.showNameDate !== false && !v.name) {
        out.push({ id: f.id, msg: "Add the name of the person signing." });
      }
      if ((f.type === "consent_status" || f.type === "prescription_status") && f.block && !(consent[f.id] && consent[f.id].found)) {
        out.push({ id: f.id, msg: f.type === "prescription_status"
          ? "There's no valid prescription on file, so this form can't be saved yet."
          : "There's no valid consent on file, so this form can't be saved yet." });
      }
      if (w.photoFailed && w.photoFailed()) {
        out.push({ id: f.id, msg: "A photo didn't upload. Tap Retry on it, or remove it." });
      }
      const ob = w.querySelector("[data-other]");
      const onRow = w.querySelector(".fe-optnote.is-other");
      const onTicked = onRow && onRow.querySelector('input[type="checkbox"]').checked;
      const subOtherEmpty = $all(w, "[data-subother]").some((x) => !x.hidden && !x.value.trim());
      if ((ob && !ob.hidden && !ob.value.trim()) || (onTicked && !onRow.querySelector(".fe-note-in").value.trim()) || subOtherEmpty) {
        out.push({ id: f.id, msg: `Type the “${otherLabel(f)}” answer.` });
      } else if (f.commentRequired && $all(w, "[data-cmt]").some((c) => !c.hidden && !c.value.trim())) {
        out.push({ id: f.id, msg: "Add the details for the ticked answer." });
      } else if ($all(w, "[data-subcmt][data-req]").some((c) => !c.hidden && !c.value.trim())) {
        out.push({ id: f.id, msg: "Add the comment for the ticked sub-option." });
      }
    });
    return out;
  }

  function showProblems(list) {
    $all(sheet, ".ff-err").forEach((e) => e.remove());
    $all(sheet, ".is-invalid").forEach((e) => e.classList.remove("is-invalid"));
    list.forEach(({ id, msg }) => {
      const w = wrap(id);
      if (!w) return;
      w.classList.add("is-invalid");
      w.insertAdjacentHTML("beforeend", `<p class="ff-err" role="alert">${esc(msg)}</p>`);
    });
    msgEl.textContent = list.length ? `${list.length} question${list.length === 1 ? " needs" : "s need"} attention.` : "";
    if (list.length) {
      const first = wrap(list[0].id);
      first.scrollIntoView({ block: "center", behavior: "smooth" });
      const inp = first.querySelector("input:not([readonly]):not([type='hidden']), textarea, select");
      if (inp) inp.focus({ preventScroll: true });
    }
  }

  async function save(kind) {
    if (saving) return;
    if (!consentReady) { msgEl.textContent = "Still checking consent records. Try again in a moment."; return; }
    // Let photos that are still uploading finish first
    const pending = fields.map((f) => { const w = wrap(f.id); return w && w.photoPending ? w.photoPending() : null; }).filter(Boolean);
    if (pending.length) {
      msgEl.textContent = "Finishing photo uploads…";
      await Promise.all(pending);
      msgEl.textContent = "";
    }
    refresh();
    const list = problems();
    showProblems(list);
    if (list.length) return;

    // Only questions that are showing are saved
    const answers = {}, signatures = {};
    fields.forEach((f) => {
      if (LAYOUT.includes(f.type) || f.type === "photo") return;
      if (!shown.has(f.id)) return;
      const w = wrap(f.id);
      if (!w) return;
      answers[f.id] = readField(f, w, rctx());
      const extra = readExtras(f, w);
      if (extra) answers[`${f.id}__x`] = extra;
      if (f.type === "table") Object.assign(answers, tableInvRead(f, w)); // discount and payments
      if (f.type === "image" && f.source !== "staff") {
        const a = annots[f.id];
        const out = {};
        if (a && !a.isEmpty()) {
          out.drawing = a.toDataURL();
          if (a.markData) Object.assign(out, a.markData());
        }
        const qs = readImageQs(f, w);
        if (qs.length) out.questions = qs;
        answers[f.id] = Object.keys(out).length ? out : "";
      }
      if (f.type === "signature" && pads[f.id] && !pads[f.id].isEmpty()) signatures[f.id] = pads[f.id].toDataURL();
    });
    answers.__tags = liveTags(); // frozen, so the saved copy and PDF always read the same
    const rd = fields.find((f) => f.type === "record_date" && shown.has(f.id));
    let recordDate = rd ? answers[rd.id] : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate || "")) recordDate = todayIso();

    // Products used: taken off stock in the same save as the record
    const csLines = fields.filter((f) => f.type === "consumables" && shown.has(f.id))
      .flatMap((f) => { const w = wrap(f.id); return w && w.csPlan ? w.csPlan() : []; });

    const btn = saveBtns.find((b) => b.dataset.save === kind);
    const lbl = btn && btn.querySelector("span"); const label = lbl ? lbl.textContent : "";
    saving = true;
    saveBtns.forEach((b) => { b.disabled = true; });
    if (lbl) lbl.textContent = "Saving…";
    msgEl.textContent = "";
    try {
      const id = await saveSubmission({
        templateId: tid,
        templateName: ver.name,
        category: tpl.category,
        group: formGroup({ name: ver.name, settings: ver.settings }),
        version: ver.version,
        patientId: patient.id,
        patientPttId: patient.pttId || "",
        patientName: patient.name || "",
        recordDate,
        answers,
        signatures,
      }, staff, csLines.length ? {
        consume: (tx, subId) => consumeInTx(tx, {
          submissionId: subId, lines: csLines, patientId: patient.id, patientName: patient.name || "",
          formName: ver.name, recordDate, staff,
        }),
      } : undefined);
      dirty = false;
      if (embedded) { embedded.onSaved(id); return; }
      if (kind === "save" && isConsentLeg) {
        location.hash = ret.returnHash;
        showToast(`${ver.name} saved. Back to ${ret.templateName}.`);
      } else if (kind === "save") {
        if (tpl.category === "consent" || tpl.category === "treatment") highlightRecord(id);
        location.hash = patientHref;
        showToast(`${ver.name} saved to ${patient.name}'s record`);
      } else {
        // Open the saved form, which then emails or prints it
        queueDelivery(id, kind);
        location.hash = `#/form-record/${encodeURIComponent(id)}`;
        showToast(`${ver.name} saved`);
      }
    } catch (err) {
      console.error("Save form failed:", err);
      msgEl.textContent = err.code === "permission-denied"
        ? "Couldn't save. Check the Firestore rules for form_submissions have been published."
        : err.code ? "Couldn't save. Check your connection and try again." : err.message;
      saveBtns.forEach((b) => { b.disabled = false; });
      if (lbl) lbl.textContent = label;
    } finally {
      saving = false;
    }
  }
  saveBtns.forEach((b) => b.addEventListener("click", () => save(b.dataset.save)));

    // Inside an overlay: Cancel asks first if anything has been filled in
  if (embedded) {
    root.addEventListener("click", async (e) => {
      if (!e.target.closest('[data-act="emb-cancel"]')) return;
      if (dirty && !(await confirmDialog({
        title: "Close without saving?",
        message: "The answers on this form haven't been saved and will be lost.",
        confirmLabel: "Close without saving", tone: "warning",
      }))) return;
      dirty = false;
      embedded.onCancel();
    });
  }
  
  /* ---------- Don't lose answers by accident ---------- */
  const onBeforeUnload = (e) => { if (dirty && root.isConnected) { e.preventDefault(); e.returnValue = ""; } };
  const guard = async (e) => {
    if (!root.isConnected) {
      document.removeEventListener("click", guard, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      return;
    }
    const a = e.target.closest('a[href^="#/"]');
    if (!a || !dirty || a.closest(".fe-consent")) return;
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirmDialog({
      title: "Leave without saving?",
      message: "The answers on this form haven't been saved and will be lost.",
      confirmLabel: "Leave without saving",
      tone: "warning",
    });
    if (ok) { dirty = false; location.hash = a.getAttribute("href"); }
  };
  document.addEventListener("click", guard, true);
  window.addEventListener("beforeunload", onBeforeUnload);
}

/* ===================== View a saved form ===================== */

export async function mountFormRecord(container, submissionId, { staff } = {}) {
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = '<a class="back-link" href="#/patients">← Back</a><div class="skeleton" style="height:420px;border-radius:14px"></div>';
  container.replaceChildren(root);

  const fail = (title, msg, href = "#/patients") => {
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${href}">← Back</a><div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };

  let sub, ver, letterhead;
  try {
    sub = await getSubmission(submissionId);
    if (!sub) { fail("Form not found", "It may have been opened from an old link."); return; }
    [ver, letterhead] = await Promise.all([
      getFormVersion(sub.templateId, sub.version),
      getLetterhead().catch(() => DEFAULT_LETTERHEAD),
    ]);
  } catch (err) {
    console.error("Form record load failed:", err);
    fail("Couldn't open this form", "Check your connection and try again.");
    return;
  }
  if (!root.isConnected) return;
  const patientHref = `#/patient/${encodeURIComponent(sub.patientId)}`;
  if (!ver) { fail("Couldn't show this form", "The version it was filled in on is missing.", patientHref); return; }

  const fields = ver.fields.map(normaliseField).filter(Boolean);
    root.innerHTML = `
    <div class="ff-wrap ff-view">
      <div class="ff-bar" role="region" aria-label="Form actions">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${patientHref}" aria-label="Back to patient" title="Back to patient">${BAR_ICONS.back}</a>
          <div class="ff-bar-title">
            <strong>${esc(sub.templateName)}</strong>
            <span>${esc(sub.patientName)} · ${esc(niceDate(sub.recordDate))}${sub.createdBy ? ` · by ${esc(sub.createdBy)}` : ""} · Version ${sub.version}</span>
          </div>
          <span class="ff-saved-pill">${BAR_ICONS.check}Saved</span>
          <div class="ff-bar-actions">
            <button type="button" class="ff-btn" data-act="email">${BAR_ICONS.mail}<span>Email</span></button>
            <button type="button" class="ff-btn" data-act="printer">${BAR_ICONS.send}<span>Send to printer</span></button>
            <button type="button" class="ff-btn" data-act="print">${BAR_ICONS.print}<span>Print here</span></button>
            ${canMoveRecords() ? `<button type="button" class="ff-btn" data-act="move" title="Saved to the wrong patient? Move it">${BAR_ICONS.send}<span>Move</span></button>` : ""}
          </div>
        </div>
      </div>
      <div data-role="log">${deliveriesHtml(sub.deliveries)}</div>
      <div data-role="moves">${movesHtml(sub.moves)}</div>
      ${sub.online ? `<div class="ff-online"><strong>Filled in online by the patient</strong>${
        Array.isArray(sub.online.changed) && sub.online.changed.length
          ? `<span>They changed their details on the form. Their record hasn't been changed: ${sub.online.changed.map((c) =>
              `${esc(c.what)} ${esc(c.from || "(none)")} → <strong>${esc(c.to)}</strong>`).join(" · ")}</span>`
          : ""}</div>` : ""}
      ${(() => {
        const r = readReturn();
        return r && r.patientId === sub.patientId && r.consentId === sub.templateId
          ? `<div class="ff-return-bar"><span>${esc(r.kind || "Consent")} saved. Carry on with <strong>${esc(r.templateName)}</strong>.</span>
              <a class="ff-btn is-primary" href="${esc(r.returnHash)}">Continue with ${esc(r.templateName)} →</a></div>`
          : "";
      })()}
      <div class="fe-sheet ff-sheet ff-print" data-role="sheet">${sheetHtml({ name: ver.name, fields, settings: ver.settings, letterhead })}</div>
    </div>`;

  const sheet = root.querySelector('[data-role="sheet"]');
  hydrateBankImages(sheet);
  const shownIds = visibleIds(fields, sub.answers);
  fields.forEach((f) => {
    const w = sheet.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
    if (!w) return;
    if (!shownIds.has(f.id)) { w.hidden = true; return; } // wasn't shown when it was filled in
    if (f.liveHide && !f.liveHideShow) { w.hidden = true; return; } // hidden from staff and not part of the saved copy
    if (f.pdfHide && !f.liveHide) w.classList.add("is-pdf-hide");
    if (f.type === "signature") {
      const host = w.querySelector(".fe-sig");
      const src = sub.signatures[f.id];
      const v = sub.answers[f.id];
      const meta = v && typeof v === "object" && (v.name || v.date)
        ? `<p class="fe-help fe-help-after">Signed${v.name ? ` by ${esc(v.name)}` : ""}${v.date ? ` on ${esc(niceDate(v.date))}` : ""}</p>`
        : "";
      if (host) host.outerHTML = (src && PNG_RE.test(src)
        ? `<img class="sig-img" src="${esc(src)}" alt="Signature" />`
        : '<div class="fe-sig"><span>Not signed</span></div>') + meta;
      return;
    }
    if (f.type === "consent_status" || f.type === "prescription_status") {
      const el = w.querySelector(".fe-consent");
      if (el) el.outerHTML = consentHtml(f, sub.answers[f.id]);
      return;
    }
    if (f.type === "photo") {
      const el = w.querySelector(".fe-photo");
      if (el) el.outerHTML = '<p class="fe-help">No photos.</p>';
      return;
    }
    if (f.type === "image" && f.source !== "staff") {
      const v = sub.answers[f.id];
      const saved = v && typeof v === "object" ? v : {};
      writeImageQs(f, w, saved.questions);
      const sum = markSummary(saved);
      const fig = w.querySelector("figure");
      if (sum && fig) fig.insertAdjacentHTML("beforeend", `<p class="an-sum">${esc(sum)}</p>`);
      if (f.annotate && f.fileId) {
        const box = w.querySelector("[data-annot-img]");
        const drawing = PNG_RE.test(saved.drawing || "") ? saved.drawing : "";
        if (box) {
          bankImage(f.fileId)
            .then((src) => {
              if (box.isConnected) box.innerHTML = `<span class="an-view"><img src="${esc(src)}" alt="" />${
                drawing ? `<img class="an-over" src="${esc(drawing)}" alt="Markings" />` : ""}</span>`;
            })
            .catch(() => { if (box.isConnected) box.innerHTML = '<span class="fe-img-missing">This picture is missing from the Image Bank</span>'; });
        }
      }
      return;
    }
    if (f.type === "image" && f.source === "staff") {
      mountPhotoField(w, f, { saved: sub.answers[f.id] || null });
      return;
    }
    if (f.type === "aftercare") {
      mountAftercareField(w, f, { saved: sub.answers[f.id] || null });
      return;
    }
    if (f.type === "rich_text") {
      mountRichTextField(w, f, { saved: sub.answers[f.id] || null });
      return;
    }
    if (f.type === "specialist") {
      mountSpecialistField(w, f, { saved: sub.answers[f.id] || null });
      return;
    }
    if (f.type === "consumables") {
      const host = w.querySelector("[data-cs-host]");
      if (host) host.outerHTML = consumablesViewHtml(sub.answers[f.id]);
      return;
    }
    tableInvWrite(f, w, sub.answers);
    writeField(f, w, sub.answers[f.id]);
    writeExtras(f, w, sub.answers[`${f.id}__x`]);
    $all(w, "[data-subcmt]").forEach((c) => { if (!c.value) c.hidden = true; }); // no comment typed: nothing to show
  });
  // Merge tags, as they were when the form was saved (older forms: worked out from the record)
  const savedTags = {
    ...tagValues({ patient: { name: sub.patientName }, staff: { name: sub.createdBy }, recordDate: sub.recordDate, today: sub.recordDate }),
    ...((sub.answers && sub.answers.__tags) || {}),
  };
  applyTagNodes(collectTagNodes(sheet), savedTags);
  syncButtons(sheet, fields, savedTags);
  $all(sheet, "[data-tadd], [data-trm], [data-tpayadd], [data-tpayrm]").forEach((b) => b.remove()); // a saved form can't change
  $all(sheet, "input, textarea, select").forEach((el) => { el.disabled = true; });

  /* ---------- Email / send to printer / print here ---------- */
  const logEl = root.querySelector('[data-role="log"]');
  const printerBtn = root.querySelector('[data-act="printer"]');
  const addEntry = (entry) => {
    if (!entry || !root.isConnected) return;
    sub.deliveries.push(entry);
    logEl.innerHTML = deliveriesHtml(sub.deliveries);
  };

  const emailFlow = async () => addEntry(await openEmailComposer({ sub, ver, letterhead, staff }));

  const printerFlow = async () => {
    if (printerBtn.disabled) return;
    printerBtn.disabled = true;
    printerBtn.querySelector("span").textContent = "Sending…";
    try {
      addEntry(await sendToPrinter({ sub, ver, letterhead }));
      showToast("Sent to the printer");
    } catch (err) {
      console.error("Send to printer failed:", err);
      showToast(deliveryError(err));
    } finally {
      if (printerBtn.isConnected) { printerBtn.disabled = false; printerBtn.querySelector("span").textContent = "Send to printer"; }
    }
  };

  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="email"]')) emailFlow();
    else if (e.target.closest('[data-act="printer"]')) printerFlow();
    else if (e.target.closest('[data-act="print"]')) window.print();
    else if (e.target.closest('[data-act="move"]')) {
      openMoveRecordDialog({ sub }).then((res) => {
        if (res && container.isConnected) mountFormRecord(container, submissionId, { staff }); // show it on the new patient
      });
    }
  });

  // Arrived here from "Save & email" or "Save & print"
  const next = takeDelivery(submissionId);
  if (next === "email") emailFlow();
  else if (next === "print") printerFlow();
}