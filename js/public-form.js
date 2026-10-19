// form.html: a patient fills in a form from a link in an email (#t=<signed link>).
// No login: Apps Script checks the link, sends the form with only the details it needs, and saves what comes back.
// Drawn with the portal's own form code (form-fields / form-live), so it saves exactly like a form staff fill in.
import {
  esc, renderField, normaliseField, watermarkHtml, formTitleHtml, spanClass, canRequire, syncTableRows, tableClick,
  tableRecalc, tableTotal, syncButtons, readImageQs, otherLabel, readExtras, tableInvRead, readTableDisc, readTablePays, tableInvoice,
} from "./form-fields.js";
import { letterheadHtml, normaliseLetterhead } from "./form-letterhead.js";
import { evaluateCalcs, formatCalc } from "./form-calc.js";
import { signaturePad, readField, applyVisibility, isBlank, fieldTagValues } from "./form-live.js";
import { tagValues, collectTagNodes, applyTagNodes } from "./form-tags.js";

const API = "https://script.google.com/macros/s/AKfycbzb4J7itwDNblPVtBbbZoxdcd2DOqmiZTMXeI7lnRIKuCV92YjJ6hHgS74wz3G9uqOuSA/exec";
const CLINIC = "Dermedica Clinic · info@dermedica.com.au · 9205 1995";
const LAYOUT = ["text_block", "space", "letterhead", "watermark", "button"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const box = document.getElementById("pf");
const $all = (el, s) => [...el.querySelectorAll(s)];
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// "1985-03-12" → "12 March 1985"
const dobLong = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
};
// "0412345678" → "0412 345 678"
const mobileNice = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return /^04\d{8}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : String(s || "");
};

const MSG = {
  BAD_LINK: ["This link isn't working", "It may have been copied only partly. Open it again from the email, or contact the clinic."],
  EXPIRED: ["This link has expired", "Contact the clinic and we'll send you a new one."],
  UNAVAILABLE: ["This form isn't available", "It may have been changed or taken offline. Contact the clinic."],
  NO_PATIENT: ["We couldn't find your record", "Contact the clinic and we'll sort it out."],
  BUSY: ["Too many tries", "Wait a few minutes, then try again."],
  DONE: ["Thanks, we've already got this", "You've already filled in this form, so there's nothing more to do."],
  TEMPLATE: ["This is the form's general link", "It only works from an email sent to a patient, where it has their own link."],
  SERVER: ["Something went wrong", "Try again in a few minutes. If it keeps happening, contact the clinic."],
};
function state(key) {
  const [t, m] = MSG[key] || MSG.SERVER;
  box.innerHTML = `<div class="pf-state"><h1>${esc(t)}</h1><p>${esc(m)}</p><p><small>${esc(CLINIC)}</small></p></div>`;
  window.scrollTo(0, 0);
}
async function call(body) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "publicForm", ...body }),
  });
  return res.json();
}

// The thank-you page: the clinic's own wording (Form settings), a button to the website, and an optional automatic redirect
function thanks(after, first, preview) {
  const a = after || {};
  const fill = (s) => String(s || "").replace(/\{\s*first name\s*\}/gi, first || "").replace(/\s+([,.!?])/g, "$1").trim();
  const title = fill(a.title) || `Thanks${first ? `, ${first}` : ""}. We've got your form.`;
  const text = fill(a.text) || "It's been saved to your record at Dermedica. You can close this page.";
  const url = /^https:\/\/[^\s"'<>]+$/i.test(String(a.url || "")) ? String(a.url) : "";
  box.innerHTML = `<div class="pf-state">
      ${preview ? '<p class="pf-preview">Preview: this is what patients see after they send the form.</p>' : ""}
      <div class="pf-tick">${TICK}</div>
      <h1>${esc(title)}</h1>
      <p>${esc(text).replace(/\n/g, "<br>")}</p>
      ${url ? `<a class="pf-go" href="${esc(url)}" rel="noopener">${esc(a.label || "Visit our website")}</a>` : ""}
      ${url && a.auto ? `<p class="pf-auto">Taking you there in <span data-n>5</span> seconds…</p>` : ""}
      ${preview ? '<p><button type="button" class="pf-linkbtn" data-act="back">Back to the form</button></p>' : ""}
      <p><small>${esc(CLINIC)}</small></p>
    </div>`;
  window.scrollTo(0, 0);
  if (preview) {
    box.querySelector('[data-act="back"]').addEventListener("click", () => location.reload());
    return;
  }
  if (url && a.auto) {
    let n = 5;
    const out = box.querySelector("[data-n]");
    const timer = setInterval(() => {
      n -= 1;
      if (out) out.textContent = String(n);
      if (n <= 0) { clearInterval(timer); location.href = url; }
    }, 1000);
  }
}

async function main() {
  let h = "";
  try { h = decodeURIComponent((location.hash || "").slice(1)); } catch { h = ""; }
  if (/^f=/.test(h)) { state("TEMPLATE"); return; }
  const t = h.replace(/^t=/, "");
  if (!/^p1\./.test(t)) { state("BAD_LINK"); return; }
  // form.html already asked for the form while this code downloaded
  const early = window.__pfT === t && window.__pfGet ? window.__pfGet : null;
  let res;
  try { res = early ? await early.catch(() => call({ op: "get", t })) : await call({ op: "get", t }); }
  catch { state("SERVER"); return; }
  if (!res || res.problem) { state((res && res.problem) || "SERVER"); return; }
  if (res.done) { state("DONE"); return; }
  mountForm(t, res);
}

// Pictures arrive after the form is showing, so they never hold it up
function loadImages(t, res, sheet) {
  const put = (imgs) => $all(sheet, "[data-bank-img]").forEach((el) => {
    const src = String((imgs || {})[el.dataset.bankImg] || "");
    if (/^(https:\/\/|data:image\/)/.test(src)) el.innerHTML = `<img src="${esc(src)}" alt="${esc(el.dataset.alt || "")}" />`;
  });
  if (res.images) { put(res.images); return; }
  if (!(res.imageIds || []).length) return;
  call({ op: "images", t }).then((r) => { if (r && r.images) put(r.images); }).catch(() => { /* the form still works without them */ });
}

function mountForm(t, res) {
  const lh = normaliseLetterhead(res.letterhead || {});
  const ver = res.form || {};
  const test = res.test === true;
  const after = res.after || {};
  // Buttons to portal pages mean nothing here
  const fields = (ver.fields || []).map(normaliseField).filter(Boolean)
    .filter((f) => !(f.type === "button" && /^#/.test(String(f.url || "").trim())));
  const p = res.patient || {};
  const patient = {
    id: "", name: p.name || "", firstName: p.firstName || "", lastName: p.lastName || "", dobKey: p.dobKey || "",
    email: p.email || "", mobile: p.mobile || "", address: p.address || "", pttId: p.pttId || "",
  };
  const ctx = { live: true, fields, consentForms: [], letterhead: lh, calcValues: null };
  const showLh = !(ver.settings && ver.settings.showLetterhead === false);

  box.innerHTML = `
    ${test ? `<p class="pf-test">This is a test link. You can try the form, but it can't be sent.
      <button type="button" class="pf-linkbtn" data-act="thanks">See the thank-you page</button></p>`
      : res.testLive ? `<p class="pf-test"><strong>Staff test.</strong> This works for real: sending it saves the form to
      ${esc(patient.name || "this patient")}'s record, marked as a test, and tells the staff.</p>` : ""}
    <p class="pf-hi">${patient.firstName ? `Hi <strong>${esc(patient.firstName)}</strong>, please` : "Please"} fill in this form for Dermedica.
      Your details are already filled in, so it only takes a few minutes.</p>
    <div class="fe-sheet ff-sheet pf-sheet" data-role="sheet">
      ${watermarkHtml(fields, lh)}
      ${showLh ? `<div class="fe-lh-wrap">${letterheadHtml(lh)}</div>` : ""}
      ${formTitleHtml(ver.name || "Form", ver.settings || {})}
      <div class="fe-fields">${fields.map((f) => {
        const b = renderField(f, ctx);
        return b ? `<div class="fe-field${spanClass(f)}" data-fid="${esc(f.id)}">${b}</div>` : "";
      }).join("")}</div>
    </div>
    <div class="pf-foot">
      <p class="pf-msg" data-role="msg" aria-live="polite"></p>
      <button type="button" class="pf-send" data-act="send"${test ? " disabled" : ""}>Send to Dermedica</button>
      <p class="pf-privacy">Your answers go straight to your record at Dermedica Clinic.</p>
    </div>`;

  const sheet = box.querySelector('[data-role="sheet"]');
  const msgEl = box.querySelector('[data-role="msg"]');
  const sendBtn = box.querySelector('[data-act="send"]');
  const wrap = (id) => sheet.querySelector(`[data-fid="${CSS.escape(id)}"]`);
  const prev = box.querySelector('[data-act="thanks"]');
  if (prev) prev.addEventListener("click", () => thanks(after, patient.firstName, true));

  loadImages(t, res, sheet);
  fields.forEach((f) => { if (f.liveHide) { const w = wrap(f.id); if (w) w.classList.add("is-livehide"); } });
  const tagNodes = collectTagNodes(sheet);
  const pads = {};
  let calc = {};
  let shown = new Set(fields.map((f) => f.id));
  let dirty = false;
  let sending = false;
  let sent = false;

  // Signatures
  fields.forEach((f) => {
    if (f.type !== "signature") return;
    const w = wrap(f.id);
    const host = w && w.querySelector(".fe-sig");
    if (!host) return;
    pads[f.id] = signaturePad(host);
    if (f.showNameDate !== false) {
      const fixed = (f.signer || "patient") === "patient" ? patient.name : "";
      host.insertAdjacentHTML("afterend", `
        <div class="sig-meta">
          <label><small>Name</small><input class="fe-in" type="text" data-sig-name maxlength="120" value="${esc(fixed)}"${fixed ? " readonly" : ' placeholder="Name of the person signing"'} /></label>
          <label><small>Date</small><input class="fe-in" type="date" data-sig-date value="${todayIso()}" readonly /></label>
        </div>`);
    }
  });

  // Their details
  const P = {
    "patient.name": patient.name, "patient.firstName": patient.firstName, "patient.lastName": patient.lastName,
    "patient.dob": patient.dobKey, "patient.email": patient.email, "patient.mobile": patient.mobile,
    "patient.address": patient.address, "today": todayIso(),
  };
  const PART = {
    name: patient.name, dob: dobLong(patient.dobKey), mobile: mobileNice(patient.mobile),
    email: patient.email, address: patient.address, pttId: patient.pttId,
  };
  fields.forEach((f) => {
    const w = wrap(f.id);
    if (!w) return;
    if (f.fill && P[f.fill]) { const el = w.querySelector(".fe-in"); if (el) el.value = P[f.fill]; }
    if (f.type === "patient") {
      $all(w, "[data-part]").forEach((el) => { el.value = PART[el.dataset.part] || ""; el.readOnly = true; });
    }
  });

  /* ---------- Calculations, which questions show, tags ---------- */
  const rctx = () => ({ pads, calc, consent: {}, annots: {} });
  const updateCalcs = () => {
    calc = evaluateCalcs(fields, (f, col) => {
      const w = wrap(f.id);
      if (w && w.hidden) return null;
      if (f.type === "table") return tableTotal(f, w, col);
      const el = sheet.querySelector(`input[data-in="${CSS.escape(f.id)}"]`);
      return el ? el.value : null;
    });
    Object.keys(calc).forEach((id) => {
      const out = sheet.querySelector(`[data-calc="${CSS.escape(id)}"]`);
      const f = fields.find((x) => x.id === id);
      if (out && f) out.textContent = formatCalc(calc[id], f) || "—";
    });
  };
  const recordDate = () => {
    const rd = fields.find((f) => f.type === "record_date" && shown.has(f.id));
    const el = rd && wrap(rd.id) && wrap(rd.id).querySelector(".fe-in");
    return el && /^\d{4}-\d{2}-\d{2}$/.test(el.value) ? el.value : todayIso();
  };
  const liveTags = () => fieldTagValues(sheet, fields, tagValues({ patient, staff: null, recordDate: recordDate() }), rctx());
  const refresh = () => {
    fields.forEach((f) => { if (f.type === "table") tableRecalc(f, wrap(f.id)); });
    updateCalcs();
    shown = applyVisibility(sheet, fields, rctx());
    updateCalcs();
    shown = applyVisibility(sheet, fields, rctx());
    const tv = liveTags();
    applyTagNodes(tagNodes, tv, "");
    syncButtons(sheet, fields, tv);
  };
  fields.filter((f) => f.type === "table").forEach((f) => syncTableRows(f, wrap(f.id)));
  refresh();

  sheet.addEventListener("input", (e) => {
    if (e.target.matches && e.target.matches("[data-linked]")) e.target.dataset.touched = "1";
    dirty = true;
    refresh();
    const w = e.target.closest("[data-fid]");
    if (w && w.classList.contains("is-invalid")) {
      w.classList.remove("is-invalid");
      const er = w.querySelector(".ff-err");
      if (er) er.remove();
    }
  });
  sheet.addEventListener("click", (e) => { if (tableClick(e.target, fields)) { dirty = true; refresh(); } });

  /* ---------- Checking ---------- */
  function problems() {
    const out = [];
    const t0 = todayIso();
    fields.forEach((f) => {
      if (LAYOUT.includes(f.type) || !shown.has(f.id) || f.liveHide) return;
      const w = wrap(f.id);
      if (!w) return;
      const v = readField(f, w, rctx());
      if (f.type === "image") {
        const got = new Set(readImageQs(f, w).map((q) => q.id));
        const miss = (f.questions || []).find((q) => q.required && String(q.label || "").trim() && !got.has(q.id));
        if (miss) out.push({ id: f.id, msg: `Please answer “${miss.label}”.` });
        return;
      }
      if (f.required && canRequire(f.type) && isBlank(v)) {
        out.push({ id: f.id, msg: f.type === "signature" ? "Please sign here." : "Please answer this question." });
        return;
      }
      if (f.type === "email" && v && !EMAIL_RE.test(v)) out.push({ id: f.id, msg: "Please check the email address." });
      if (f.type === "table") {
        const inv = tableInvoice(f);
        const d = readTableDisc(f, w);
        if (inv && inv.disc === "percent" && d !== null && d > 100) out.push({ id: f.id, msg: "The discount can't be more than 100%." });
        else if (readTablePays(f, w).some((x) => x.amount > 0 && !x.method)) out.push({ id: f.id, msg: "Choose how each payment was made." });
      }
      if (f.type === "date" && v) {
        if (f.range === "past" && v > t0) out.push({ id: f.id, msg: "Choose today or an earlier date." });
        if (f.range === "future" && v < t0) out.push({ id: f.id, msg: "Choose today or a later date." });
      }
      if (f.type === "number" && v !== null) {
        if (f.min !== null && f.min !== undefined && v < Number(f.min)) out.push({ id: f.id, msg: `Enter ${f.min} or more.` });
        else if (f.max !== null && f.max !== undefined && v > Number(f.max)) out.push({ id: f.id, msg: `Enter ${f.max} or less.` });
      }
      if (f.type === "signature" && v && f.showNameDate !== false && !v.name) out.push({ id: f.id, msg: "Add the name of the person signing." });
      const ob = w.querySelector("[data-other]");
      const onRow = w.querySelector(".fe-optnote.is-other");
      const onTicked = onRow && onRow.querySelector('input[type="checkbox"]').checked;
      const subOtherEmpty = $all(w, "[data-subother]").some((x) => !x.hidden && !x.value.trim());
      if ((ob && !ob.hidden && !ob.value.trim()) || (onTicked && !onRow.querySelector(".fe-note-in").value.trim()) || subOtherEmpty) {
        out.push({ id: f.id, msg: `Please type the “${otherLabel(f)}” answer.` });
      } else if (f.commentRequired && $all(w, "[data-cmt]").some((c) => !c.hidden && !c.value.trim())) {
        out.push({ id: f.id, msg: "Please add the details." });
      } else if ($all(w, "[data-subcmt][data-req]").some((c) => !c.hidden && !c.value.trim())) {
        out.push({ id: f.id, msg: "Please add the comment." });
      }
    });
    return out;
  }
  function showProblems(list) {
    $all(sheet, ".ff-err").forEach((x) => x.remove());
    $all(sheet, ".is-invalid").forEach((x) => x.classList.remove("is-invalid"));
    list.forEach(({ id, msg }) => {
      const w = wrap(id);
      if (!w) return;
      w.classList.add("is-invalid");
      w.insertAdjacentHTML("beforeend", `<p class="ff-err" role="alert">${esc(msg)}</p>`);
    });
    msgEl.textContent = list.length ? `${list.length} question${list.length === 1 ? " needs" : "s need"} an answer.` : "";
    if (list.length) wrap(list[0].id).scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /* ---------- Sending ---------- */
  async function send() {
    if (sending || test) return;
    refresh();
    const list = problems();
    showProblems(list);
    if (list.length) return;
    const answers = {};
    const signatures = {};
    fields.forEach((f) => {
      if (LAYOUT.includes(f.type) || !shown.has(f.id)) return;
      const w = wrap(f.id);
      if (!w) return;
      if (f.type === "image") {
        const qs = readImageQs(f, w);
        answers[f.id] = qs.length ? { questions: qs } : "";
        return;
      }
      answers[f.id] = readField(f, w, rctx());
      const x = readExtras(f, w);
      if (x) answers[`${f.id}__x`] = x;
      if (f.type === "table") Object.assign(answers, tableInvRead(f, w));
      if (f.type === "signature" && pads[f.id] && !pads[f.id].isEmpty()) signatures[f.id] = pads[f.id].toDataURL();
    });
    answers.__tags = liveTags();
    if (JSON.stringify({ answers, signatures }).length > 850000) {
      msgEl.textContent = "The form is too big to send. Clear the signature and sign again a little smaller.";
      return;
    }
    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    msgEl.textContent = "";
    try {
      const r = await call({ op: "submit", t, answers, signatures, recordDate: recordDate(), version: ver.version });
      if (r && r.ok && !r.problem) {
        sent = true;
        thanks(after, patient.firstName, false);
        return;
      }
      const pr = (r && r.problem) || "SERVER";
      if (pr === "DONE" || pr === "EXPIRED" || pr === "UNAVAILABLE") { state(pr); return; }
      msgEl.textContent = pr === "CHANGED" ? "The clinic has just updated this form. Reload the page to fill in the latest version."
        : pr === "INCOMPLETE" ? "Some required questions aren't answered yet."
        : pr === "TOO_BIG" ? "The form is too big to send. Clear the signature and sign again a little smaller."
        : pr === "BUSY" ? "Too many tries. Wait a few minutes, then try again."
        : "It didn't send. Check your connection and try again.";
    } catch {
      msgEl.textContent = "It didn't send. Check your connection and try again.";
    }
    sending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = "Send to Dermedica";
  }
  sendBtn.addEventListener("click", send);
  window.addEventListener("beforeunload", (e) => { if (dirty && !sent) { e.preventDefault(); e.returnValue = ""; } });
}

main();