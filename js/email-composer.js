import { db } from "./firebase-config.js";
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { setTabTitle } from "./tab-icon.js";
import { getPatient } from "./patients.js";
import { callApi } from "./appointments.js";
import { escapeHtml, showToast } from "./utils.js";
import { treatmentEmailTemplate, buildTreatmentEmail, showTreatmentEmail } from "./treatment-email-template.js";

const str = (v) => String(v == null ? "" : v).trim();
const norm = (s) => str(s).toLowerCase().replace(/\s+/g, " ");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  mail: svg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  mailOpen: svg('<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>'),
  send: svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

/* ===================== Treatments from the record ===================== */

// Sidecar email items (preferred) or the "!!TREATMENT INFORMATION TO EMAIL" text (older records)
export function emailItemsFrom(sidecarObj, text) {
  if (sidecarObj && Array.isArray(sidecarObj.email)) {
    return sidecarObj.email
      .map((e) => (typeof e === "string" ? { name: e, dynamic_areas: [] } : e || {}))
      .map((e) => ({
        name: str(e.name),
        areas: (Array.isArray(e.dynamic_areas) ? e.dynamic_areas : [])
          .map((a) => ({ areaName: str(a && a.areaName), quote: str(a && a.quote), comment: str(a && a.comment) }))
          .filter((a) => a.areaName || a.quote || a.comment),
      }))
      .filter((e) => e.name);
  }
  return parseEmailText(text);
}

// The recorder's text format:
//   Clear Complexion Laser
//     * Area: Face
//       Quote: $295
//       Comment: For discrete pigmentation spots. | May require 2-3 treatments.
function parseEmailText(text) {
  const items = [];
  let cur = null;
  let area = null;
  const newArea = () => { area = { areaName: "", quote: "", comment: "" }; cur.areas.push(area); };

  String(text || "").split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    let m;
    if ((m = /^\s*\*\s*Area:\s*(.*)$/i.exec(line))) {
      if (!cur) return;
      newArea();
      area.areaName = m[1].trim();
      return;
    }
    if ((m = /^\s*Quote:\s*(.*)$/i.exec(line)) && cur) {
      if (!area) newArea();
      area.quote = m[1].trim();
      return;
    }
    if ((m = /^\s*Comment:\s*(.*)$/i.exec(line)) && cur) {
      if (!area) newArea();
      area.comment = m[1].split(/\s*\|\s*/).join("\n").trim();
      return;
    }
    if (/^\s/.test(line) && cur) return; // other indented detail
    cur = { name: line.replace(/^[-•*]\s*/, "").trim(), areas: [] };
    area = null;
    items.push(cur);
  });

  return items.filter((i) => i.name);
}

const splitComment = (c) => str(c).split(/\n|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);

function lastSentByName(log) {
  const map = new Map();
  (Array.isArray(log) ? log : []).forEach((e) => {
    const when = e && e.sentAt ? new Date(e.sentAt) : null;
    (e && Array.isArray(e.treatments) ? e.treatments : []).forEach((t) => {
      const prev = map.get(norm(t));
      if (when && !isNaN(when) && (!prev || when > prev)) map.set(norm(t), when);
    });
  });
  return map;
}

/* ===================== The card ===================== */

function areaHtml(a) {
  return `
    <span class="em-area">
      ${a.areaName ? `<span class="em-line"><b>Area/s:</b> ${escapeHtml(a.areaName)}</span>` : ""}
      ${a.quote ? `<span class="em-line"><b>Quote:</b> ${escapeHtml(a.quote)}</span>` : ""}
      ${splitComment(a.comment).map((c) => `<span class="em-note">${escapeHtml(c)}</span>`).join("")}
    </span>`;
}

// Inner HTML for <section class="sp-card ..." data-email-card>
export function emailCardHtml(items, sentLog) {
  const sent = lastSentByName(sentLog);
  return `
    <header>${I.mail}<span>Treatment Info to Email</span></header>
    <div class="em-body">
      <ul class="em-list">
        ${items.map((it, i) => {
          const when = sent.get(norm(it.name));
          return `
            <li class="em-item">
              <label class="em-check">
                <input type="checkbox" data-em-check="${i}" checked />
                <span class="em-main">
                  <span class="em-name">${escapeHtml(it.name)}${
                    when ? `<span class="em-sent">${I.check}Emailed ${when.getDate()} ${MONTHS[when.getMonth()]}</span>` : ""}</span>
                  ${it.areas.map(areaHtml).join("")}
                </span>
              </label>
            </li>`;
        }).join("")}
      </ul>
      <button type="button" class="em-draft" data-sp="email-draft">${I.mailOpen}Draft Email for Selected</button>
    </div>`;
}

/* ===================== Treatment links (TREATMENT-CONFIGURATIONS) ===================== */

let linksPromise = null;

function loadLinks() {
  if (!linksPromise) {
    linksPromise = getDocs(collection(db, "TREATMENT-CONFIGURATIONS"))
      .then((snap) => {
        const map = new Map();
        snap.forEach((d) => {
          const f = d.data();
          const keys = Object.keys(f);
          const get = (names) => {
            for (const n of names) {
              const k = keys.find((x) => x.trim().toLowerCase() === n);
              if (k) return str(f[k]);
            }
            return "";
          };
          const name = get(["treatment name", "name", "treatment"]);
          const link = get(["link", "url", "hyperlink"]);
          if (name && /^https?:\/\//i.test(link)) map.set(norm(name), link);
        });
        return map;
      })
      .catch((err) => {
        console.warn("Treatment links unavailable:", err);
        linksPromise = null; // try again next time
        return new Map();
      });
  }
  return linksPromise;
}

/* ===================== Email content ===================== */

// Inline styles so it looks right in every email app
// The treatments block on its own (used by the built-in email and by the Task types template).
// Inline styles so it looks right in every email app.
function treatmentBlocksHtml({ items, links, accent = "#0284c7" }) {
  return items.map((it) => {
    const link = links.get(norm(it.name));
    const title = link
      ? `<a href="${escapeHtml(link)}" style="color:${accent};font-weight:bold;text-decoration:none;">${escapeHtml(it.name)} &#8599;</a>`
      : `<strong style="color:${accent};">${escapeHtml(it.name)}</strong>`;
    const details = it.areas.map((a) => [
      a.areaName ? `<strong>Area/s:</strong> ${escapeHtml(a.areaName)}` : "",
      a.quote ? `Quote/Inclusions: ${escapeHtml(a.quote)}` : "",
      ...splitComment(a.comment).map((c) => `<em>${escapeHtml(c)}</em>`),
    ].filter(Boolean).join("<br>")).join("<br><br>");
    return `<p style="margin:0 0 18px;">${title}${details ? "<br>" + details : ""}</p>`;
  }).join("");
}

// The built-in email, used when no Treatment Info email is published in Task types
function buildEmailHtml({ firstName, items, links, staffName }) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">
      <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName || "there")},</p>
      <p style="margin:0 0 18px;">Please see below the treatment information you requested:</p>
      ${treatmentBlocksHtml({ items, links })}
      <p style="margin:0 0 16px;">If you have any questions, simply reply to this email or give us a call.</p>
      <p style="margin:0;">Kind regards,<br>${escapeHtml(staffName || "The Dermedica Team")}<br>Dermedica</p>
    </div>`;
}

// What's sent: pictures go as attachments (Apps Script adds them), so their on-screen copies are taken out
function htmlForSending(el) {
  const copy = el.cloneNode(true);
  copy.querySelectorAll("img[data-logo], img[data-bank]").forEach((img) => img.removeAttribute("src"));
  return copy.innerHTML;
}

/* ===================== The composer (overlay, or its own tab) ===================== */

const SEND_LABEL = `${I.send}Send Email Now`;

// Draws the composer into host and sends from it.
// opts: { items, recordId, record, staff, alive(), close(), onSent(entry, to), busy(on) }
async function fillComposer(host, opts) {
  const { items, record, staff, alive } = opts;
  host.innerHTML = `<div class="em-loading"><div class="spinner"></div><p>Preparing email…</p></div>`;

  const patientKey = str(record["Patient Doc ID"]) || str(record["Patient ID"]);
  const [patient, links, task] = await Promise.all([
    patientKey ? getPatient(patientKey).catch(() => null) : Promise.resolve(null),
    loadLinks(),
    treatmentEmailTemplate(),
  ]);
  if (!alive()) return; // closed meanwhile

  const email = patient ? str(patient.email) : "";
  const firstName = (patient && str(patient.firstName)) || str(record["Patient Name"]).split(/\s+/)[0] || "";

  // The email written in Task types, if one is published; otherwise the built-in one
  let subject = "Dermedica: Treatment Information";
  let html = "";
  let logo = "";
  if (task) {
    try {
      const built = await buildTreatmentEmail({
        task, record, staff, patient: patient || {},
        blockHtml: treatmentBlocksHtml({ items, links, accent: task.style && task.style.accent }),
      });
      subject = built.subject || subject;
      html = built.html;
      logo = built.logo;
    } catch (err) {
      console.warn("Treatment Info template failed, using the built-in email:", err);
    }
  }
  if (!alive()) return;
  const designed = !!html;
  if (!designed) html = buildEmailHtml({ firstName, items, links, staffName: staff ? staff.name : "" });

  host.innerHTML = `
    <form class="em-form" novalidate>
      <header class="em-head">
        ${I.mailOpen}<h2>Preview Email</h2>
        <button type="button" class="em-close" data-em="close" aria-label="Close">${I.x}</button>
      </header>

      <label class="em-field"><span>Patient email</span>
        <input type="email" name="to" value="${escapeHtml(email)}" placeholder="name@example.com" autocomplete="off" required />
      </label>
      ${email ? "" : `<p class="em-warn">There's no email address on file for this patient. Type one in to send.</p>`}

      <label class="em-field"><span>Subject</span>
        <input type="text" name="subject" maxlength="200" value="${escapeHtml(subject)}" />
      </label>

      <div class="em-field"><span>Message preview</span>
        <div class="em-preview${designed ? " is-designed" : ""}" contenteditable="true" role="textbox" aria-multiline="true"></div>
        <small>You can edit the message before sending.${designed
          ? ` <span class="em-tpl-note">Wording from Task types → ${escapeHtml(task.name)}.</span>` : ""}</small>
      </div>

      <p class="em-error" role="alert"></p>

      <footer class="em-foot">
        <button type="button" class="btn-ghost" data-em="close">Cancel</button>
        <button type="submit" class="em-send">${SEND_LABEL}</button>
      </footer>
    </form>`;

  const preview = host.querySelector(".em-preview");
  if (designed) showTreatmentEmail(preview, html, logo);   // logo and pictures shown on screen
  else preview.innerHTML = html;

  host.querySelectorAll("[data-em='close']").forEach((b) => b.addEventListener("click", () => opts.close()));
  host.querySelector("form").addEventListener("submit", (e) => sendFrom(e, host, opts));

  const toInput = host.querySelector("input[name='to']");
  (email ? host.querySelector(".em-send") : toInput).focus();
}

async function sendFrom(e, host, opts) {
  e.preventDefault();
  const form = e.target;
  const btn = host.querySelector(".em-send");
  if (!btn || btn.disabled) return;
  const to = form.elements.to.value.trim();
  const subject = form.elements.subject.value.trim();
  const preview = host.querySelector(".em-preview");
  const errEl = host.querySelector(".em-error");

  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)) {
    errEl.textContent = "Please enter a valid email address.";
    form.elements.to.focus();
    return;
  }
  if (!preview.textContent.trim()) {
    errEl.textContent = "The message is empty.";
    return;
  }

  btn.disabled = true;
  btn.innerHTML = "Sending…";
  errEl.textContent = "";
  if (opts.busy) opts.busy(true);

  try {
    const res = await callApi({
      action: "sendTreatmentEmail",
      recordId: opts.recordId,
      to,
      subject,
      html: htmlForSending(preview),
      treatments: opts.items.map((i) => i.name),
    });
    showToast(`Email sent to ${to}`);
    if (opts.onSent) opts.onSent(res && res.entry, to);
  } catch (err) {
    console.error("Sending the email failed:", err);
    const messages = {
      BAD_EMAIL: "That email address doesn't look right.",
      RATE_LIMITED: "You've sent a lot of emails in the last hour. Please try again shortly.",
      QUOTA: "The clinic's daily email limit has been reached. Please try again tomorrow.",
      NOT_FOUND: "This consultation record no longer exists.",
      UNAUTHORIZED: "Your session has expired. Please log in again.",
    };
    if (errEl.isConnected) errEl.textContent = messages[err.code] || "Couldn't send the email. Please try again.";
    btn.disabled = false;
    btn.innerHTML = SEND_LABEL;
  } finally {
    if (opts.busy) opts.busy(false);
  }
}

/* ----- The overlay (used when pop-ups are blocked) ----- */

let dlg = null;
let ctx = null;

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement("dialog");
  dlg.className = "em-dialog";
  dlg.setAttribute("aria-label", "Preview email");
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => { dlg.innerHTML = ""; ctx = null; });
}

export async function openEmailComposer({ items, recordId, record, staff, onSent }) {
  ensureDialog();
  const myCtx = {};
  ctx = myCtx;
  if (!dlg.open) dlg.showModal();
  await fillComposer(dlg, {
    items, recordId, record, staff,
    alive: () => ctx === myCtx,
    close: () => dlg.close(),
    onSent: (entry) => { if (onSent && entry) onSent(entry); dlg.close(); },
  });
}

/* ----- Its own tab: #/email/<recordId>/<token> ----- */

const HAND_KEY = "dm-email:";
const HAND_TTL = 24 * 3600 * 1000;   // drafts never sent are tidied away after a day

// From the notes: hands the ticked treatments to a new tab. false = pop-ups blocked (use the overlay).
export function openEmailInTab({ items, recordId }) {
  if (!recordId || !items || !items.length) return false;
  const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const key = HAND_KEY + token;
  try {
    Object.keys(localStorage).forEach((k) => {
      if (!k.startsWith(HAND_KEY)) return;
      try {
        const at = Number((JSON.parse(localStorage.getItem(k)) || {}).at) || 0;
        if (Date.now() - at > HAND_TTL) localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); }
    });
    localStorage.setItem(key, JSON.stringify({ recordId, items, at: Date.now() }));
  } catch { return false; }   // storage blocked or full: the overlay instead

  const url = `${location.href.split("#")[0]}#/email/${encodeURIComponent(recordId)}/${token}`;
  let w = null;
  try { w = window.open(url, "_blank"); } catch { w = null; }
  if (!w) { try { localStorage.removeItem(key); } catch { /* ignore */ } return false; }
  return true;
}

// The page in the new tab
export async function mountEmailPage(container, param = "", { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page em-page";
  root.innerHTML = '<div class="em-sheet"></div>';
  container.replaceChildren(root);
  const host = root.querySelector(".em-sheet");

  const [recordId = "", token = ""] = String(param || "").split("/");
  const key = HAND_KEY + token;
  const closeTab = () => {
    window.close();   // works for tabs the portal opened
    setTimeout(() => { if (!window.closed) showToast("You can close this tab now."); }, 300);
  };
  const state = (title, text) => {
    host.innerHTML = `<div class="em-state"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p>
      <button type="button" class="btn-ghost" data-em="close-tab">Close this tab</button></div>`;
  };
  root.addEventListener("click", (e) => { if (e.target.closest("[data-em='close-tab']")) closeTab(); });

  let hand = null;
  try { hand = JSON.parse(localStorage.getItem(key) || "null"); } catch { hand = null; }
  if (!token || !hand || hand.recordId !== recordId || !Array.isArray(hand.items) || !hand.items.length) {
    state("This email draft isn't available",
      "It may have been sent already. Go back to the consultation notes and press Draft Email for Selected again.");
    return;
  }

  setTabTitle("Email · Preparing…");
  let record = null;
  try {
    const snap = await getDoc(doc(db, "appointment_transcripts", recordId));
    if (!snap.exists()) throw Object.assign(new Error("Record not found"), { code: "not-found" });
    record = snap.data();
  } catch (err) {
    if (!root.isConnected) return;
    console.error("Email page: record not loaded:", err);
    state("Couldn't open this email", err.code === "permission-denied" ? "You don't have permission to view these notes."
      : err.code === "not-found" ? "This consultation record no longer exists." : "Check your connection and refresh this tab.");
    return;
  }
  if (!root.isConnected) return;
  const name = str(record["Patient Name"]) || "Patient";
  setTabTitle(`Email · ${name}`);

  // Closing the tab while it's sending: ask first
  let sending = false;
  const guard = (e) => { if (sending) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", guard);
  const onHash = () => setTimeout(() => {
    if (root.isConnected) return;
    window.removeEventListener("beforeunload", guard);
    window.removeEventListener("hashchange", onHash);
  }, 0);
  window.addEventListener("hashchange", onHash);

  await fillComposer(host, {
    items: hand.items, recordId, record, staff,
    alive: () => root.isConnected,
    close: closeTab,
    busy: (on) => { sending = on; setTabTitle(on ? `Sending… · ${name}` : `Email · ${name}`); },
    onSent: (entry, to) => {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      // The notes tab marks these treatments as emailed
      if (entry) {
        try {
          const ch = new BroadcastChannel("dm-notes");
          ch.postMessage({ type: "email-sent", id: recordId, entry });
          ch.close();
        } catch { /* older browsers: the notes show it after a refresh */ }
      }
      setTabTitle(`✓ Emailed · ${name}`);
      if (root.isConnected) state("Email sent", `Sent to ${to}. The consultation notes show it as emailed. You can close this tab.`);
    },
  });
}

/* ===================== Saving an edited list ===================== */

// Back to the recorder's text format for "!!TREATMENT INFORMATION TO EMAIL"
export function emailItemsToText(items) {
  return (items || []).map((it) => {
    let t = it.name;
    it.areas.forEach((a) => {
      t += `\n  * Area: ${a.areaName}`;
      if (a.quote) t += `\n    Quote: ${a.quote}`;
      const lines = splitComment(a.comment);
      if (lines.length) t += `\n    Comment: ${lines.join(" | ")}`;
    });
    return t;
  }).join("\n\n");
}

// Back to the recorder's sidecar shape
export function emailItemsToSidecar(items) {
  return (items || []).map((it) => ({
    name: it.name,
    dynamic_areas: it.areas.map((a) => ({
      areaName: a.areaName || "", quote: a.quote || "", comment: splitComment(a.comment).join("\n"),
    })),
  }));
}