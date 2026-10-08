// Fill in a published form for a patient: #/fill/<patientId>/<templateId>
// View a saved one:                      #/form-record/<submissionId>
import { getFormTemplate, getFormVersion, getLetterhead, categoryLabel } from "./form-templates.js";
import { esc, svg, ICONS, renderField, normaliseField, watermarkHtml, canRequire } from "./form-fields.js";
import { evaluateCalcs, formatCalc } from "./form-calc.js";
import { letterheadHtml, DEFAULT_LETTERHEAD } from "./form-letterhead.js";
import { getPatient, patientIds } from "./patients.js";
import { saveSubmission, getSubmission, listSubmissionsForPatient } from "./form-submissions.js";
import { confirmDialog } from "./dialog.js";
import { showToast, formatDobLong, formatMobile } from "./utils.js";

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
    <h3 class="fe-title">${esc(name)}</h3>
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
  });

  new ResizeObserver(setup).observe(canvas);
  return {
    isEmpty: () => empty,
    toDataURL: () => (empty ? "" : canvas.toDataURL("image/png")),
  };
}

/* ===================== Reading and writing answers ===================== */

function readField(f, w, { pads, calc, consent }) {
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
      return i < 0 ? "" : (f.options[i] ?? "");
    }
    case "checkboxes":
      return $all(w, 'input[type="checkbox"]').flatMap((x, i) => (x.checked ? [f.options[i] ?? ""] : []));
    case "checkbox_notes":
      return $all(w, ".fe-optnote").flatMap((row, i) => {
        const box = row.querySelector('input[type="checkbox"]');
        if (!box || !box.checked) return [];
        const note = row.querySelector(".fe-note-in");
        return [{ option: f.options[i] ?? "", note: note ? note.value.trim().slice(0, 1000) : "" }];
      });
    case "sub_checks":
      return $all(w, ".fe-sub").flatMap((row, i) => {
        const boxes = $all(row, 'input[type="checkbox"]');
        const grp = f.groups[i] || { label: "", subs: [] };
        if (!boxes[0] || !boxes[0].checked) return [];
        return [{ option: grp.label, subs: boxes.slice(1).flatMap((b, j) => (b.checked ? [grp.subs[j] ?? ""] : [])) }];
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
    case "consent_status":
      return consent[f.id] || { found: false, date: "", submissionId: "", name: "" };
  }
  return null;
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
    case "single_choice":
      $all(w, 'input[type="radio"]').forEach((x, i) => { x.checked = f.options[i] === v; }); break;
    case "checkboxes": {
      const s = new Set(Array.isArray(v) ? v : []);
      $all(w, 'input[type="checkbox"]').forEach((x, i) => { x.checked = s.has(f.options[i]); });
      break;
    }
    case "checkbox_notes": {
      const m = new Map((Array.isArray(v) ? v : []).map((r) => [r.option, r.note]));
      $all(w, ".fe-optnote").forEach((row, i) => {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = m.has(f.options[i]);
        set(row.querySelector(".fe-note-in"), m.get(f.options[i]) || "");
      });
      break;
    }
    case "sub_checks": {
      const m = new Map((Array.isArray(v) ? v : []).map((r) => [r.option, new Set(r.subs || [])]));
      $all(w, ".fe-sub").forEach((row, i) => {
        const grp = f.groups[i] || { label: "", subs: [] };
        const subs = m.get(grp.label);
        const boxes = $all(row, 'input[type="checkbox"]');
        if (boxes[0]) boxes[0].checked = !!subs;
        boxes.slice(1).forEach((b, j) => { b.checked = !!subs && subs.has(grp.subs[j]); });
      });
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
    ${back}
    <div class="ff-wrap">
      <div class="ff-top">
        <div>
          <h2>${esc(ver.name)}</h2>
          <p class="muted">For <strong>${esc(patient.name)}</strong> · ${esc(categoryLabel(tpl.category))} · Version ${ver.version}</p>
        </div>
      </div>
      <div class="fe-sheet ff-sheet" data-role="sheet">${sheetHtml({ name: ver.name, fields, settings: ver.settings, letterhead })}</div>
      <div class="ff-actions">
        <p class="muted" data-role="msg" aria-live="polite"></p>
        <a class="btn-ghost" href="${patientHref}">Cancel</a>
        <button type="button" class="btn-primary" data-act="save">Save to patient record</button>
      </div>
    </div>`;

  const sheet = root.querySelector('[data-role="sheet"]');
  const msgEl = root.querySelector('[data-role="msg"]');
  const saveBtn = root.querySelector('[data-act="save"]');
  const wrap = (id) => sheet.querySelector(`[data-fid="${CSS.escape(id)}"]`);
  const pads = {};
  const consent = {};
  let calc = {};
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

  const updateCalcs = () => {
    calc = evaluateCalcs(fields, (f) => {
      const el = sheet.querySelector(`input[data-in="${CSS.escape(f.id)}"]`);
      return el ? el.value : null;
    });
    Object.keys(calc).forEach((id) => {
      const out = sheet.querySelector(`[data-calc="${CSS.escape(id)}"]`);
      const f = fields.find((x) => x.id === id);
      if (out && f) out.textContent = formatCalc(calc[id], f) || "—";
    });
  };
  updateCalcs();

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
      });
  }

  sheet.addEventListener("input", (e) => {
    dirty = true;
    updateCalcs();
    const w = e.target.closest("[data-fid]");
    if (w && w.classList.contains("is-invalid")) {
      w.classList.remove("is-invalid");
      const err = w.querySelector(".ff-err");
      if (err) err.remove();
    }
  });

  /* ---------- Checking and saving ---------- */
  const rctx = () => ({ pads, calc, consent });

  function problems() {
    const out = [];
    const t = todayIso();
    fields.forEach((f) => {
      if (LAYOUT.includes(f.type) || f.type === "photo") return;
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

  async function save() {
    if (saving) return;
    if (!consentReady) { msgEl.textContent = "Still checking consent records. Try again in a moment."; return; }
    updateCalcs();
    const list = problems();
    showProblems(list);
    if (list.length) return;

    const answers = {}, signatures = {};
    fields.forEach((f) => {
      if (LAYOUT.includes(f.type) || f.type === "photo") return;
      const w = wrap(f.id);
      if (!w) return;
      answers[f.id] = readField(f, w, rctx());
      if (f.type === "signature" && pads[f.id] && !pads[f.id].isEmpty()) signatures[f.id] = pads[f.id].toDataURL();
    });
    const rd = fields.find((f) => f.type === "record_date");
    let recordDate = rd ? answers[rd.id] : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate || "")) recordDate = todayIso();

    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    msgEl.textContent = "";
    try {
      await saveSubmission({
        templateId: tid,
        templateName: ver.name,
        category: tpl.category,
        version: ver.version,
        patientId: patient.id,
        patientPttId: patient.pttId || "",
        patientName: patient.name || "",
        recordDate,
        answers,
        signatures,
      }, staff);
      dirty = false;
      location.hash = patientHref;
      showToast(`${ver.name} saved to ${patient.name}'s record`);
    } catch (err) {
      console.error("Save form failed:", err);
      msgEl.textContent = err.code === "permission-denied"
        ? "Couldn't save. Check the Firestore rules for form_submissions have been published."
        : err.code ? "Couldn't save. Check your connection and try again." : err.message;
      saveBtn.disabled = false;
      saveBtn.textContent = "Save to patient record";
    } finally {
      saving = false;
    }
  }
  saveBtn.addEventListener("click", save);

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

export async function mountFormRecord(container, submissionId) {
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
    <a class="back-link" href="${patientHref}">← Back to patient</a>
    <div class="ff-wrap ff-view">
      <div class="ff-top">
        <div>
          <h2>${esc(sub.templateName)}</h2>
          <p class="muted">For <strong>${esc(sub.patientName)}</strong> · ${esc(niceDate(sub.recordDate))}${
            sub.createdBy ? ` · Filled in by ${esc(sub.createdBy)}` : ""} · Version ${sub.version}</p>
        </div>
        <button type="button" class="btn-ghost" data-act="print">Print</button>
      </div>
      <div class="fe-sheet ff-sheet ff-print" data-role="sheet">${sheetHtml({ name: ver.name, fields, settings: ver.settings, letterhead })}</div>
    </div>`;

  const sheet = root.querySelector('[data-role="sheet"]');
  fields.forEach((f) => {
    const w = sheet.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
    if (!w) return;
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
    writeField(f, w, sub.answers[f.id]);
  });
  $all(sheet, "input, textarea, select").forEach((el) => { el.disabled = true; });

  root.querySelector('[data-act="print"]').addEventListener("click", () => window.print());
}