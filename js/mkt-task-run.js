// Task Manager → To Patient: a marketing email template, sent to one patient.
// Route: #/tasks/run/mkt_<templateId>             (from Task Manager)
//        #/tasks/run/mkt_<templateId>/<patientId>
// Apps Script does the sending (marketing op "taskSend"): the patient's name, their own form and payment links,
// the Unsubscribe footer and the do-not-contact check. This screen shows the email and who it goes to.
import { db } from "./firebase-config.js";
import { collection, doc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { searchPatients } from "./task-runner.js";
import { getPatient } from "./patients.js";
import { showToast, formatDobLong } from "./utils.js";
import { EMAIL_RE } from "./task-tokens.js";
import { listTaskEmails } from "./mkt-task-run.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  search: ic('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  user: ic('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  x: ic('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

export const MKT_TASK_PREFIX = "mkt_";
const WIDTHS = [600, 640, 680, 720];
const FOOT_RE = /<div data-mkt-footer=""><\/div>/;
const NAME_RE = /\{\s*(first name|last name|full name|patient name)\s*\}/gi;

const ERR = {
  UNAUTHORIZED: "Your session has expired. Log out and back in, then try again.",
  FORBIDDEN: "You don't have access to send To Patient tasks. Ask an Admin.",
  BAD_REQUEST: "The server hasn't been updated yet. In Apps Script, deploy a new version.",
  RATE_LIMITED: "You've sent a lot of emails in the last hour. Try again a little later.",
  QUOTA: "The clinic's email limit for today has been reached. Try again tomorrow.",
  INVALID_PIN: "The server hasn't been updated yet. In Apps Script, deploy a new version.",
  SERVER_ERROR: "The server hit an error. Check Apps Script → Executions for details.",
};
const errText = (e) => ERR[e && e.code] || (e && e.message && !e.code ? e.message : `Couldn't send${e && e.code ? ` (${e.code})` : ""}. Try again.`);

// The templates switched on for To Patient, shaped like task types (none if the list can't be read)
export async function listTaskEmails() {
  try {
    const snap = await getDocs(query(collection(db, "mkt_templates"), where("taskOn", "==", true)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => t.status !== "archived")
      .map((t) => ({
        id: MKT_TASK_PREFIX + t.id, mkt: true,
        name: String(t.taskName || t.name || "Marketing email"),
        description: String(t.taskDescription || ""),
        category: "patient", channel: "email", status: "live",
        recipients: {}, fields: [], attachments: [],
      }));
  } catch (err) {
    console.warn("Marketing emails not listed in To Patient:", err);
    return [];
  }
}

// {First name} and the like, for the preview (Apps Script fills them in again when it's sent)
function nameVals(p) {
  const name = String((p && p.name) || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    "first name": (p && p.firstName) || parts[0] || "there",
    "last name": parts.length > 1 ? parts[parts.length - 1] : "",
    "full name": name || "there",
    "patient name": name,
  };
}
const valOf = (v, k) => v[k.toLowerCase().replace(/\s+/g, " ")];
const fillText = (s, v) => String(s || "").replace(NAME_RE, (m, k) => valOf(v, k) ?? m);
const fillHtml = (s, v) => String(s || "").replace(NAME_RE, (m, k) => { const x = valOf(v, k); return x === undefined ? m : esc(x); });

// The same box Apps Script puts at the top (mktTaskNote_)
function withNote(html, note, width) {
  const box = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:16px 12px 0">` +
    `<table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${width}px">` +
    `<tr><td style="padding:14px 18px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1e293b">` +
    `${esc(note).replace(/\n/g, "<br>")}</td></tr></table></td></tr></table>`;
  return /<body\b[^>]*>/i.test(html) ? html.replace(/<body\b[^>]*>/i, (m) => m + box) : box + html;
}

export async function mountMktTaskRunner(container, { templateId, patientId = "", staff } = {}) {
  const backHref = patientId ? `#/patient/${encodeURIComponent(patientId)}` : "#/tasks/new/patient";
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);
  const fail = (title, msg) => {
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };

  let t = null;
  try {
    const snap = await getDoc(doc(db, "mkt_templates", templateId));
    t = snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error("Marketing email not loaded:", err);
    if (err && err.code === "permission-denied") fail("This email isn't available", "It may have been switched off for Task Manager. Go back and choose another.");
    else fail("Couldn't open this email", "Check your connection and try again.");
    return;
  }
  if (!root.isConnected) return;
  if (!t || t.status === "archived" || t.taskOn !== true) {
    fail("This email isn't available", "It may have been switched off for Task Manager. Go back and choose another.");
    return;
  }
  if (!String(t.html || "").trim()) { fail("This email is empty", "Ask an admin to finish it in Marketing → Templates."); return; }

  const title = String(t.taskName || t.name || "Marketing email");
  const dw = Number(t.design && t.design.style && t.design.style.width);
  const width = WIDTHS.includes(dw) ? dw : 600;
  const st = {
    patient: null, sending: false, subjectEdited: false,
    combo: { results: [], active: -1, status: "", seq: 0 },
    check: { seq: 0, busy: false, blocked: "" },
  };

  root.innerHTML = `
    <div class="ff-wrap tb-wrap">
      <div class="ff-bar" role="region" aria-label="Task actions">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${backHref}" aria-label="Back" title="Back">${I.back}</a>
          <div class="ff-bar-title"><strong>${esc(title)}</strong><span>To Patient · Marketing email</span></div>
          <div class="ff-bar-actions">
            <a class="ff-btn is-quiet" href="${backHref}">Cancel</a>
            <button type="button" class="ff-btn is-primary" data-act="send" disabled>${I.send}<span>Send email</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      <div class="tb-grid tr-grid">
        <div class="tb-form">
          <section class="tb-card"><h4><span class="tb-num">1</span>Patient</h4><div data-role="who"></div></section>
          <section class="tb-card"><h4><span class="tb-num">2</span>A note at the top <small>(optional)</small></h4>
            <textarea class="fe-input" data-role="note" rows="3" maxlength="600"
              placeholder="e.g. Lovely to see you today. Here are the packages we talked about."></textarea>
            <small class="muted">It goes in its own box above the email. Leave it empty to send the email as it is.</small>
          </section>
          <section class="tb-card"><h4>When it's sent</h4>
            ${t.taskDescription ? `<p class="tb-info">${esc(t.taskDescription)}</p>` : ""}
            <ul class="mtr-points">
              <li>Their name is filled in, and form and payment buttons become their own, so what they send or pay is matched to them.</li>
              <li>The Unsubscribe footer is added, as with every marketing email.</li>
              <li>It's checked against the do-not-contact list first.</li>
              <li>It's saved in Task history and on their record.</li>
            </ul>
          </section>
        </div>
        <aside class="tr-mail-col">
          <section class="tb-card tr-mail">
            <h4>Email</h4>
            <div class="tr-row tr-row-to"><span>To</span><div class="tr-to" data-role="to"></div></div>
            <label class="tr-row"><span>Subject</span><input class="fe-input" data-role="subject" maxlength="200" /></label>
            <div data-role="block"></div>
            <div class="mtr-frame-wrap">
              <iframe class="mtr-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="The email"></iframe>
            </div>
            <small class="muted" data-role="hint"></small>
          </section>
        </aside>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const msgEl = $('[data-role="msg"]');
  const sendBtn = $('[data-act="send"]');
  const subjectEl = $('[data-role="subject"]');
  const noteEl = $('[data-role="note"]');
  const frame = $(".mtr-frame");
  const hint = $('[data-role="hint"]');
  subjectEl.value = String(t.subject || "");

  const toVal = () => (($('[data-role="to-input"]') || {}).value || "").trim();

  /* ---------- The preview ---------- */
  frame.addEventListener("load", () => {
    try { frame.style.height = `${frame.contentDocument.documentElement.scrollHeight + 4}px`; } catch { /* keeps its height */ }
  });
  function renderPreview() {
    let html = String(t.html || "");
    if (st.patient) html = fillHtml(html, nameVals(st.patient));
    const note = noteEl.value.trim();
    if (note) html = withNote(html, note, width);
    const foot = `<div style="margin:20px auto;max-width:${width}px;padding:12px;border-top:1px dashed #cbd5e1;font:12px Arial,sans-serif;color:#94a3b8;text-align:center">The Unsubscribe footer is added here when it's sent.</div>`;
    html = FOOT_RE.test(html) ? html.replace(FOOT_RE, foot) : html + foot;
    frame.srcdoc = /<html[\s>]/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => `${m}<base target="_blank">`)
      : `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:0">${html}</body></html>`;
    hint.textContent = st.patient ? `How ${st.patient.name} will see it.` : "Choose the patient to see it with their name filled in.";
  }

  /* ---------- Can it go? ---------- */
  function renderState() {
    const box = $('[data-role="block"]');
    const c = st.check;
    box.innerHTML = !st.patient ? ""
      : c.busy ? '<p class="mtr-wait">Checking the do-not-contact list…</p>'
      : c.blocked ? `<p class="mtr-block">${esc(c.blocked)}</p>` : "";
    sendBtn.disabled = st.sending || !st.patient || !EMAIL_RE.test(toVal()) || c.busy || !!c.blocked;
  }

  async function check() {
    if (!st.patient) return;
    const seq = ++st.check.seq;
    st.check.busy = true;
    renderState();
    try {
      const r = await callApi({ action: "marketing", op: "taskCheck", templateId, patientId: st.patient.id, to: toVal() });
      if (seq !== st.check.seq || !root.isConnected) return;
      st.check.blocked = String((r && (r.blocked || r.problem)) || "");
    } catch (err) {
      if (seq !== st.check.seq) return;
      console.warn("Do-not-contact check failed (it's checked again when sending):", err);
      st.check.blocked = "";
    } finally {
      if (seq === st.check.seq && root.isConnected) { st.check.busy = false; renderState(); }
    }
  }

  /* ---------- Who it goes to ---------- */
  function renderTo() {
    const box = $('[data-role="to"]');
    if (!st.patient) { box.innerHTML = '<span class="muted">Choose the patient on the left</span>'; return; }
    box.innerHTML = `<input class="fe-input" type="email" data-role="to-input" maxlength="254" aria-label="Email address"
        placeholder="No email on file. Type one in." value="${esc(st.patient.email || "")}" />
      <small class="tr-warn" data-role="to-warn" hidden></small>`;
    checkToWarn();
  }
  function checkToWarn() {
    const warn = $('[data-role="to-warn"]');
    if (!warn || !st.patient) return;
    const onFile = String(st.patient.email || "").toLowerCase();
    const v = toVal().toLowerCase();
    warn.textContent = onFile ? "This isn't the email address on the patient's record." : "There's no email on this patient's record. Type one in.";
    warn.hidden = onFile ? (!v || v === onFile) : false;
  }

  function renderWho() {
    const box = $('[data-role="who"]');
    if (st.patient) {
      const p = st.patient;
      box.innerHTML = `<div class="tr-pchip">
        <span class="pc-avatar">${I.user}</span>
        <span class="pc-text"><strong>${esc(p.name)}</strong><small>${esc(formatDobLong(p.dobKey) || p.dob || "")}</small></span>
        ${patientId ? "" : `<button type="button" class="ib-tool" data-act="change" aria-label="Choose a different patient" title="Choose a different patient">${I.x}</button>`}
      </div>`;
      return;
    }
    box.innerHTML = `
      <div class="pc" data-combo>
        <div class="pc-field">${I.search}
          <input type="text" class="pc-input" role="combobox" aria-expanded="false" aria-controls="mtr-list"
            aria-autocomplete="list" aria-label="Patient" placeholder="Search for the patient by name" autocomplete="off" spellcheck="false" />
        </div>
        <ul class="pc-list" id="mtr-list" role="listbox" aria-label="Matching patients" hidden></ul>
      </div>`;
  }

  async function pickPatient(id) {
    let p;
    try { p = await getPatient(id); }
    catch (err) { console.error(err); showToast("Couldn't open that patient. Try again."); return; }
    if (!root.isConnected || !p) return;
    st.patient = p;
    st.combo = { results: [], active: -1, status: "", seq: st.combo.seq + 1 };
    st.check.blocked = "";
    msgEl.textContent = "";
    if (!st.subjectEdited) subjectEl.value = fillText(t.subject, nameVals(p));
    renderWho(); renderTo(); renderPreview(); renderState();
    check();
  }

  function clearPatient() {
    st.patient = null;
    st.check = { seq: st.check.seq + 1, busy: false, blocked: "" };
    if (!st.subjectEdited) subjectEl.value = String(t.subject || "");
    renderWho(); renderTo(); renderPreview(); renderState();
    const input = root.querySelector(".pc-input");
    if (input) input.focus();
  }

  /* ---------- Searchable patient list (the same as the task screen) ---------- */
  function renderCombo() {
    const input = root.querySelector(".pc-input");
    const list = root.querySelector(".pc-list");
    if (!input || !list) return;
    const c = st.combo;
    let h = "";
    if (c.status === "short") h = '<li class="pc-status">Type at least 2 letters</li>';
    else if (c.status === "searching" && !c.results.length) h = '<li class="pc-status">Searching…</li>';
    else if (c.status === "none") h = '<li class="pc-status">No patients found. Try their last name.</li>';
    else if (c.status === "error") h = '<li class="pc-status pc-bad">Couldn\'t search. Check your connection.</li>';
    h += c.results.map((r, i) => `
      <li class="pc-opt${i === c.active ? " is-active" : ""}" id="mtr-opt-${i}" role="option" aria-selected="${i === c.active}" data-pick-patient="${esc(r.id)}">
        <span class="pc-avatar">${I.user}</span>
        <span class="pc-text"><strong>${esc(r.name)}</strong><small>${esc([r.dob && `DOB ${r.dob}`, r.email || "No email on file"].filter(Boolean).join(" · "))}</small></span>
      </li>`).join("");
    list.innerHTML = h;
    const open = !!h && document.activeElement === input;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (c.active >= 0) {
      input.setAttribute("aria-activedescendant", `mtr-opt-${c.active}`);
      const el = list.querySelector(`#mtr-opt-${c.active}`);
      if (el) el.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  let searchTimer = null;
  function runSearch(q) {
    clearTimeout(searchTimer);
    const c = st.combo;
    if (q.trim().length < 2) { c.results = []; c.active = -1; c.status = q.trim() ? "short" : ""; renderCombo(); return; }
    c.status = "searching";
    renderCombo();
    const seq = ++c.seq;
    searchTimer = setTimeout(async () => {
      let results = [];
      try { results = await searchPatients(q); }
      catch (err) { console.warn("Patient search failed:", err); if (seq === c.seq) { c.status = "error"; renderCombo(); } return; }
      if (seq !== c.seq || !root.isConnected) return;
      c.results = results;
      c.active = results.length ? 0 : -1;
      c.status = results.length ? "" : "none";
      renderCombo();
    }, 250);
  }

  /* ---------- Events ---------- */
  let toTimer = null;
  let noteTimer = null;
  root.addEventListener("input", (e) => {
    const el = e.target;
    if (el.matches(".pc-input")) { runSearch(el.value); return; }
    if (el.matches('[data-role="to-input"]')) {
      checkToWarn();
      st.check.busy = true;   // nothing goes until the new address is checked
      renderState();
      clearTimeout(toTimer);
      toTimer = setTimeout(check, 600);
      return;
    }
    if (el === subjectEl) { st.subjectEdited = true; return; }
    if (el === noteEl) { clearTimeout(noteTimer); noteTimer = setTimeout(renderPreview, 300); }
  });
  root.addEventListener("focusin", (e) => { if (e.target.matches(".pc-input")) renderCombo(); });
  root.addEventListener("focusout", (e) => {
    if (!e.target.matches(".pc-input")) return;
    setTimeout(() => {
      const l = root.querySelector(".pc-list");
      if (l && document.activeElement !== e.target) { l.hidden = true; e.target.setAttribute("aria-expanded", "false"); }
    }, 120);
  });
  root.addEventListener("keydown", (e) => {
    if (!e.target.matches(".pc-input")) return;
    const c = st.combo;
    if (e.key === "ArrowDown" && c.results.length) { e.preventDefault(); c.active = (c.active + 1) % c.results.length; renderCombo(); }
    else if (e.key === "ArrowUp" && c.results.length) { e.preventDefault(); c.active = (c.active - 1 + c.results.length) % c.results.length; renderCombo(); }
    else if (e.key === "Enter") { e.preventDefault(); if (c.results[c.active]) pickPatient(c.results[c.active].id); }
    else if (e.key === "Escape") { const l = root.querySelector(".pc-list"); if (l) l.hidden = true; e.target.setAttribute("aria-expanded", "false"); }
  });
  // mousedown (not click), so choosing happens before the box loses focus
  root.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".pc-opt");
    if (!opt) return;
    e.preventDefault();
    pickPatient(opt.dataset.pickPatient);
  });
  root.addEventListener("click", (e) => { if (e.target.closest('[data-act="change"]')) clearPatient(); });

  /* ---------- Sending ---------- */
  sendBtn.addEventListener("click", async () => {
    if (sendBtn.disabled || !st.patient) return;
    st.sending = true;
    msgEl.textContent = "";
    sendBtn.querySelector("span").textContent = "Sending…";
    renderState();
    try {
      const r = await callApi({
        action: "marketing", op: "taskSend", templateId, patientId: st.patient.id,
        to: toVal(), subject: subjectEl.value.trim(), note: noteEl.value.trim(),
      });
      if (r && r.problem) {
        msgEl.textContent = r.problem;
        if (r.blocked) st.check.blocked = r.blocked;
        return;
      }
      showToast(`Sent to ${st.patient.name}`);
      location.hash = patientId ? backHref : "#/tasks/history";
    } catch (err) {
      console.error("Marketing email not sent:", err);
      msgEl.textContent = errText(err);
    } finally {
      st.sending = false;
      if (root.isConnected) { sendBtn.querySelector("span").textContent = "Send email"; renderState(); }
    }
  });

  /* ---------- Start ---------- */
  renderWho();
  renderTo();
  renderPreview();
  renderState();
  if (patientId) pickPatient(patientId);
  else { const s = root.querySelector(".pc-input"); if (s) s.focus(); }
}