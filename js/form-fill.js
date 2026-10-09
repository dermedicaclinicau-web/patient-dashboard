// Fill in a published form for a patient: #/fill/<patientId>/<templateId>
// View a saved one:                      #/form-record/<submissionId>
import { getFormTemplate, getFormVersion, getLetterhead, categoryLabel } from "./form-templates.js";
import { esc, svg, ICONS, renderField, normaliseField, watermarkHtml, canRequire,
  choiceList, otherLabel, syncChoiceExtras, readExtras, writeExtras } from "./form-fields.js";
import { evaluateCalcs, formatCalc } from "./form-calc.js";
import { letterheadHtml, DEFAULT_LETTERHEAD } from "./form-letterhead.js";
import { getPatient, patientIds } from "./patients.js";
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

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const BAR_ICONS = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  print: ic('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  mail: ic('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  check: ic('<polyline points="20 6 9 17 4 12"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
};

const LAYOUT = ["text_block", "space", "letterhead", "watermark"];
const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => isoOf(new Date());
const $all = (el, s) => [...el.querySelectorAll(s)];

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
      return body ? `<div class="fe-field" data-fid="${esc(f.id)}">${body}</div>` : "";
    }).join("")}</div>`;
}

function consentHtml(f, res) {
  const months = Number(f.months) || 12;
  if (res && res.found) {
    return `<div class="fe-consent">${svg(ICONS.consent_status)}<span>Signed ${res.name ? `“${esc(res.name)}” ` : ""}on ${esc(niceDate(res.date))}.${
      res.submissionId ? ` <a href="#/form-record/${encodeURIComponent(res.submissionId)}">View it</a>` : ""}</span></div>`;
  }
  return `<div class="fe-consent is-warn">${svg(ICONS.consent_status)}<span>No signed consent in the last ${months} months.${
    f.block ? " This form can't be saved until one is signed." : ""}</span></div>`;
}

/* ===================== Signature pad ===================== */

function signaturePad(host) {
  host.className = "sig-pad";
  host.innerHTML = `
    <canvas class="sig-canvas" aria-label="Signature pad. Sign with a finger, stylus or mouse"></canvas>
    <div class="sig-bar"><span>Sign above</span><button type="button" class="sig-clear">Clear</button></div>`;
  const canvas = host.querySelector("canvas");
  const g = canvas.getContext("2d");
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  let empty = true, drawing = false, last = null;

  function setup() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const keep = empty ? null : canvas.toDataURL("image/png");
    canvas.width = Math.round(r.width * scale);
    canvas.height = Math.round(r.height * scale);
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.lineWidth = 2.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = g.fillStyle = "#0f172a";
    if (keep) {
      const img = new Image();
      img.onload = () => g.drawImage(img, 0, 0, r.width, r.height);
      img.src = keep;
    }
  }
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const mark = () => {
    if (!empty) return;
    empty = false;
    host.classList.add("is-signed");
    host.dispatchEvent(new Event("input", { bubbles: true }));
  };

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    g.beginPath();
    g.arc(last.x, last.y, 1.1, 0, Math.PI * 2);
    g.fill();
    mark();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    g.beginPath();
    g.moveTo(last.x, last.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last = p;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);

  host.querySelector(".sig-clear").addEventListener("click", () => {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.restore();
    empty = true;
    host.classList.remove("is-signed");
    host.dispatchEvent(new Event("input", { bubbles: true }));
  });

  new ResizeObserver(setup).observe(canvas);
  return {
    isEmpty: () => empty,
    toDataURL: () => (empty ? "" : canvas.toDataURL("image/png")),
  };
}

/* ===================== Reading and writing answers ===================== */

export function readField(f, w, { pads = {}, calc = {}, consent = {}, annots = {} } = {}) {
  switch (f.type) {
    case "short_text": case "long_text": case "email": case "date": case "record_date": {
      const el = w.querySelector(".fe-in");
      return el ? String(el.value || "").trim().slice(0, 5000) : "";
    }
    case "number": {
      const el = w.querySelector("input[data-in]");
      if (!el || el.value === "") return null;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : null;
    }
    case "dropdown": {
      const el = w.querySelector("select");
      return el ? el.value : "";
    }
    case "single_choice": {
      const i = $all(w, 'input[type="radio"]').findIndex((x) => x.checked);
      return i < 0 ? "" : (choiceList(f)[i] ?? "");
    }
    case "checkboxes": {
      const list = choiceList(f);
      return $all(w, 'input[type="checkbox"]').flatMap((x, i) => (x.checked ? [list[i] ?? ""] : []));
    }
    case "checkbox_notes": {
      const list = choiceList(f);
      return $all(w, ".fe-optnote").flatMap((row, i) => {
        const box = row.querySelector('input[type="checkbox"]');
        if (!box || !box.checked) return [];
        const note = row.querySelector(".fe-note-in");
        return [{ option: list[i] ?? "", note: note ? note.value.trim().slice(0, 1000) : "" }];
      });
    }
    case "sub_checks":
      return $all(w, ".fe-sub").flatMap((row, i) => {
        const boxes = $all(row, 'input[type="checkbox"]');
        if (!boxes[0] || !boxes[0].checked) return [];
        if (row.classList.contains("is-other")) {
          const o = row.querySelector("[data-other]");
          return [{ option: otherLabel(f), subs: [], other: o ? o.value.trim().slice(0, 500) : "" }];
        }
        const grp = f.groups[i] || { label: "", subs: [] };
        const subList = [...(grp.subs || []), ...(grp.other ? [otherLabel(f)] : [])];
        const out = { option: grp.label, subs: boxes.slice(1).flatMap((b, j) => (b.checked ? [subList[j] ?? ""] : [])) };
        const so = row.querySelector("[data-subother]");
        if (so && !so.hidden && so.value.trim()) out.subOther = so.value.trim().slice(0, 300);
        return [out];
      });
    case "table": // Firestore can't store lists inside lists, so each row is { cells: [...] }
      return $all(w, "tbody tr").map((tr) => ({
        cells: $all(tr, "input").map((inp) => (inp.type === "checkbox" ? inp.checked : inp.value.trim().slice(0, 500))),
      }));
    case "calculation": {
      const v = calc[f.id];
      return Number.isFinite(v) ? v : null;
    }
    case "signature": {
      const p = pads[f.id];
      if (!p || p.isEmpty()) return "";
      const n = w.querySelector("[data-sig-name]");
      const d = w.querySelector("[data-sig-date]");
      return { signed: true, name: n ? n.value.trim().slice(0, 120) : "", date: d ? d.value : todayIso() };
    }
    case "patient": {
      const out = {};
      $all(w, "[data-part]").forEach((el) => { out[el.dataset.part] = el.value; });
      return out;
    }
    case "image": {
      const a = annots[f.id];
      return a && !a.isEmpty() ? { drawn: true } : "";
    }
    case "aftercare":
      return w.acRead ? w.acRead() : { items: [] };
    case "consent_status":
      return consent[f.id] || { found: false, date: "", submissionId: "", name: "" };
  }
  return null;
}

// Hides / shows questions on a live page from the current answers. Returns the shown ids.
// Questions are worked out top to bottom, so each one only depends on answers above it.
export function applyVisibility(sheet, fields, ctx) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const answers = {};
  const shown = new Set();
  fields.forEach((f) => {
    const w = sheet.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
    const ok = conditionPasses(f, answers, byId, shown);
    if (ok) shown.add(f.id);
    if (!w) return;
    w.hidden = !ok;
    syncChoiceExtras(f, w);
    if (ok && !LAYOUT.includes(f.type) && f.type !== "photo") answers[f.id] = readField(f, w, ctx);
  });
  return shown;
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
        if (boxes[0]) boxes[0].checked = !!subs;
        boxes.slice(1).forEach((b, j) => { b.checked = !!subs && subs.has(subList[j]); });
        const hit = rows.find((r) => r.option === grp.label);
        set(row.querySelector("[data-subother]"), (hit && hit.subOther) || "");
      });
      syncChoiceExtras(f, w);
      break;
    }
    case "table":
      $all(w, "tbody tr").forEach((tr, r) => {
        const cells = (Array.isArray(v) && v[r] && Array.isArray(v[r].cells)) ? v[r].cells : [];
        $all(tr, "input").forEach((inp, c) => {
          if (inp.type === "checkbox") inp.checked = cells[c] === true;
          else inp.value = typeof cells[c] === "string" ? cells[c] : "";
        });
      });
      break;
    case "calculation": {
      const out = w.querySelector("[data-calc]");
      if (out) out.textContent = formatCalc(v, f) || "—";
      break;
    }
    case "patient":
      $all(w, "[data-part]").forEach((el) => { el.value = (v && v[el.dataset.part]) || ""; });
      break;
  }
}

function isBlank(v) {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) {
    return v.length === 0 ||
      v.every((r) => r && Array.isArray(r.cells) && r.cells.every((c) => c === "" || c === false));
  }
  return false;
}

async function checkConsents(consentFields, patient) {
  const subs = await listSubmissionsForPatient([patient.id, ...patientIds(patient)]);
  const out = {};
  consentFields.forEach((f) => {
    const cut = new Date();
    cut.setMonth(cut.getMonth() - (Number(f.months) || 12));
    const hit = f.consentFormId
      ? subs.find((s) => s.templateId === f.consentFormId && s.recordDate >= isoOf(cut))
      : null;
    out[f.id] = hit
      ? { found: true, date: hit.recordDate, submissionId: hit.id, name: hit.templateName }
      : { found: false, date: "", submissionId: "", name: "" };
  });
  return out;
}

/* ===================== Fill in ===================== */

export async function mountFormFill(container, param, { staff } = {}) {
  const [pid = "", tid = ""] = String(param || "").split("/");
  const patientHref = `#/patient/${encodeURIComponent(pid)}`;
  const back = `<a class="back-link" href="${patientHref}">← Back to patient</a>`;
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = back + '<div class="skeleton" style="height:420px;border-radius:14px"></div>';
  container.replaceChildren(root);

  const fail = (title, msg) => {
    if (root.isConnected) root.innerHTML = back + `<div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };
  if (!pid || !tid) { fail("Form not found", "Go back to the patient and choose a form again."); return; }

  let tpl, patient, ver, letterhead;
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
    [ver, letterhead] = await Promise.all([
      getFormVersion(tid, tpl.version),
      getLetterhead().catch(() => DEFAULT_LETTERHEAD),
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
          <a class="ff-back" href="${patientHref}" aria-label="Back to patient" title="Back to patient">${BAR_ICONS.back}</a>
          <div class="ff-bar-title">
            <strong>${esc(ver.name)}</strong>
            <span>${esc(patient.name)} · ${esc(categoryLabel(tpl.category))} · Version ${ver.version}</span>
          </div>
          <span class="ff-progress" data-role="progress" hidden></span>
          <div class="ff-bar-actions">
            <a class="ff-btn is-quiet" href="${patientHref}">Cancel</a>
            <button type="button" class="ff-btn" data-save="print">${BAR_ICONS.print}<span>Save &amp; print</span></button>
            <button type="button" class="ff-btn" data-save="email">${BAR_ICONS.mail}<span>Save &amp; email</span></button>
            <button type="button" class="ff-btn is-primary" data-save="save">${BAR_ICONS.check}<span>Save</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      <div class="fe-sheet ff-sheet" data-role="sheet">${sheetHtml({ name: ver.name, fields, settings: ver.settings, letterhead })}</div>
    </div>`;

  const sheet = root.querySelector('[data-role="sheet"]');
  hydrateBankImages(sheet);
  const annots = attachAnnotators(sheet, fields);
  const msgEl = root.querySelector('[data-role="msg"]');
  const progressEl = root.querySelector('[data-role="progress"]');
  const saveBtns = $all(root, "[data-save]");
  const wrap = (id) => sheet.querySelector(`[data-fid="${CSS.escape(id)}"]`);
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
    mountAftercareField(wrap(f.id), f, { onChange: () => { dirty = true; } });
  });

  // Fill in from the patient's record
  const P = {
    "patient.name": patient.name,
    "patient.firstName": patient.firstName,
    "patient.lastName": patient.lastName,
    "patient.dob": patient.dobKey,
    "patient.email": patient.email,
    "patient.mobile": patient.mobile,
    "patient.address": patient.address,
    "today": todayIso(),
    "staff.name": (staff && staff.name) || "",
  };
  const PART_VALUES = {
    name: patient.name,
    dob: formatDobLong(patient.dobKey) || patient.dob,
    mobile: patient.mobile ? formatMobile(patient.mobile) : "",
    email: patient.email,
    address: patient.address,
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

  /* ---------- Calculations + which questions show ---------- */
  const rctx = () => ({ pads, calc, consent, annots });

  const updateCalcs = () => {
    calc = evaluateCalcs(fields, (f) => {
      const w = wrap(f.id);
      if (w && w.hidden) return null; // hidden questions count as unanswered
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
    updateCalcs();
    shown = applyVisibility(sheet, fields, rctx());
    updateCalcs();
    shown = applyVisibility(sheet, fields, rctx());
    updateProgress();
  };

  // "2 of 4 required" in the top bar (only questions that are showing count)
  function updateProgress() {
    let need = 0, done = 0;
    fields.forEach((f) => {
      if (!f.required || !canRequire(f.type) || LAYOUT.includes(f.type) || f.type === "photo") return;
      if (!shown.has(f.id)) return;
      const w = wrap(f.id);
      if (!w) return;
      need++;
      if (!isBlank(readField(f, w, rctx()))) done++;
    });
    progressEl.hidden = !need;
    progressEl.classList.toggle("is-done", done === need);
    progressEl.textContent = done === need ? "All required answered" : `${done} of ${need} required`;
  }
  refresh();

  // Consent checks run in the background
  const consentFields = fields.filter((f) => f.type === "consent_status");
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
          if (el) el.outerHTML = consentHtml(f, consent[f.id]);
        });
        refresh();
      });
  }

  sheet.addEventListener("input", (e) => {
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
      const box = row ? row.querySelector("[data-other], [data-cmt]") : w.querySelector("[data-other]:not([hidden]), [data-cmt]:not([hidden])");
      if (box && !box.hidden) box.focus();
    }
  });

  /* ---------- Checking and saving ---------- */
  function problems() {
    const out = [];
    const t = todayIso();
    fields.forEach((f) => {
      if (LAYOUT.includes(f.type) || f.type === "photo") return;
      if (!shown.has(f.id)) return; // hidden questions are never required
      const w = wrap(f.id);
      if (!w) return;
      const v = readField(f, w, rctx());
      if (f.required && canRequire(f.type) && isBlank(v)) {
        out.push({ id: f.id, msg: f.type === "signature" ? "Sign here before saving." : "Answer this question." });
        return;
      }
      if (f.type === "email" && v && !EMAIL_RE.test(v)) out.push({ id: f.id, msg: "Enter a valid email address." });
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
      if (f.type === "consent_status" && f.block && !(consent[f.id] && consent[f.id].found)) {
        out.push({ id: f.id, msg: "There's no valid consent on file, so this form can't be saved yet." });
      }
      const ob = w.querySelector("[data-other]");
      const onRow = w.querySelector(".fe-optnote.is-other");
      const onTicked = onRow && onRow.querySelector('input[type="checkbox"]').checked;
      const subOtherEmpty = $all(w, "[data-subother]").some((x) => !x.hidden && !x.value.trim());
      if ((ob && !ob.hidden && !ob.value.trim()) || (onTicked && !onRow.querySelector(".fe-note-in").value.trim()) || subOtherEmpty) {
        out.push({ id: f.id, msg: `Type the “${otherLabel(f)}” answer.` });
      } else if (f.commentRequired && $all(w, "[data-cmt]").some((c) => !c.hidden && !c.value.trim())) {
        out.push({ id: f.id, msg: "Add the details for the ticked answer." });
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
      if (f.type === "image" && annots[f.id] && !annots[f.id].isEmpty()) answers[f.id] = { drawing: annots[f.id].toDataURL() };
      if (f.type === "signature" && pads[f.id] && !pads[f.id].isEmpty()) signatures[f.id] = pads[f.id].toDataURL();
    });
    const rd = fields.find((f) => f.type === "record_date" && shown.has(f.id));
    let recordDate = rd ? answers[rd.id] : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate || "")) recordDate = todayIso();

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
      }, staff);
      dirty = false;
      if (kind === "save") {
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
          </div>
        </div>
      </div>
      <div data-role="log">${deliveriesHtml(sub.deliveries)}</div>
      <div class="fe-sheet ff-sheet ff-print" data-role="sheet">${sheetHtml({ name: ver.name, fields, settings: ver.settings, letterhead })}</div>
    </div>`;

  const sheet = root.querySelector('[data-role="sheet"]');
  hydrateBankImages(sheet);
  const shownIds = visibleIds(fields, sub.answers);
  fields.forEach((f) => {
    const w = sheet.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
    if (!w) return;
    if (!shownIds.has(f.id)) { w.hidden = true; return; } // wasn't shown when it was filled in
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
    if (f.type === "consent_status") {
      const el = w.querySelector(".fe-consent");
      if (el) el.outerHTML = consentHtml(f, sub.answers[f.id]);
      return;
    }
    if (f.type === "photo") {
      const el = w.querySelector(".fe-photo");
      if (el) el.outerHTML = '<p class="fe-help">No photos.</p>';
      return;
    }
    if (f.type === "image" && f.annotate && f.source !== "staff" && f.fileId) {
      const box = w.querySelector("[data-annot-img]");
      const v = sub.answers[f.id];
      const drawing = v && typeof v === "object" && PNG_RE.test(v.drawing || "") ? v.drawing : "";
      if (box) {
        bankImage(f.fileId)
          .then((src) => {
            if (box.isConnected) box.innerHTML = `<span class="an-view"><img src="${esc(src)}" alt="" />${
              drawing ? `<img class="an-over" src="${esc(drawing)}" alt="Markings" />` : ""}</span>`;
          })
          .catch(() => { if (box.isConnected) box.innerHTML = '<span class="fe-img-missing">This picture is missing from the Image Bank</span>'; });
      }
      return;
    }
    if (f.type === "aftercare") {
      mountAftercareField(w, f, { saved: sub.answers[f.id] || null });
      return;
    }
    writeField(f, w, sub.answers[f.id]);
    writeExtras(f, w, sub.answers[`${f.id}__x`]);
  });
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
  });

  // Arrived here from "Save & email" or "Save & print"
  const next = takeDelivery(submissionId);
  if (next === "email") emailFlow();
  else if (next === "print") printerFlow();
}