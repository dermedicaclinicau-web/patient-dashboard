import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getPatient } from "./patients.js";
import { callApi } from "./appointments.js";
import { escapeHtml, showToast } from "./utils.js";

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
function buildEmailHtml({ firstName, items, links, staffName }) {
  const blocks = items.map((it) => {
    const link = links.get(norm(it.name));
    const title = link
      ? `<a href="${escapeHtml(link)}" style="color:#0284c7;font-weight:bold;text-decoration:none;">${escapeHtml(it.name)} &#8599;</a>`
      : `<strong style="color:#0284c7;">${escapeHtml(it.name)}</strong>`;
    const details = it.areas.map((a) => [
      a.areaName ? `<strong>Area/s:</strong> ${escapeHtml(a.areaName)}` : "",
      a.quote ? `Quote/Inclusions: ${escapeHtml(a.quote)}` : "",
      ...splitComment(a.comment).map((c) => `<em>${escapeHtml(c)}</em>`),
    ].filter(Boolean).join("<br>")).join("<br><br>");
    return `<p style="margin:0 0 18px;">${title}${details ? "<br>" + details : ""}</p>`;
  }).join("");

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">
      <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName || "there")},</p>
      <p style="margin:0 0 18px;">Please see below the treatment information you requested:</p>
      ${blocks}
      <p style="margin:0 0 16px;">If you have any questions, simply reply to this email or give us a call.</p>
      <p style="margin:0;">Kind regards,<br>${escapeHtml(staffName || "The Dermedica Team")}<br>Dermedica</p>
    </div>`;
}

/* ===================== The composer overlay ===================== */

let dlg = null;
let ctx = null;

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement("dialog");
  dlg.className = "em-dialog";
  dlg.setAttribute("aria-label", "Preview email");
  document.body.appendChild(dlg);

  dlg.addEventListener("click", (e) => { if (e.target.closest("[data-em='close']")) dlg.close(); });
  dlg.addEventListener("submit", onSubmit);
  dlg.addEventListener("close", () => { dlg.innerHTML = ""; ctx = null; });
}

export async function openEmailComposer({ items, recordId, record, staff, onSent }) {
  ensureDialog();
  const myCtx = { items, recordId, onSent };
  ctx = myCtx;
  dlg.innerHTML = `<div class="em-loading"><div class="spinner"></div><p>Preparing email…</p></div>`;
  if (!dlg.open) dlg.showModal();

  const patientKey = str(record["Patient Doc ID"]) || str(record["Patient ID"]);
  const [patient, links] = await Promise.all([
    patientKey ? getPatient(patientKey).catch(() => null) : Promise.resolve(null),
    loadLinks(),
  ]);
  if (ctx !== myCtx) return; // closed meanwhile

  const email = patient ? str(patient.email) : "";
  const firstName = (patient && str(patient.firstName)) || str(record["Patient Name"]).split(/\s+/)[0] || "";
  const html = buildEmailHtml({ firstName, items, links, staffName: staff ? staff.name : "" });

  dlg.innerHTML = `
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
        <input type="text" name="subject" maxlength="200" value="Dermedica: Treatment Information" />
      </label>

      <div class="em-field"><span>Message preview</span>
        <div class="em-preview" contenteditable="true" role="textbox" aria-multiline="true">${html}</div>
        <small>You can edit the message before sending.</small>
      </div>

      <p class="em-error" role="alert"></p>

      <footer class="em-foot">
        <button type="button" class="btn-ghost" data-em="close">Cancel</button>
        <button type="submit" class="em-send">${I.send}Send Email Now</button>
      </footer>
    </form>`;

  const toInput = dlg.querySelector("input[name='to']");
  (email ? dlg.querySelector(".em-send") : toInput).focus();
}

async function onSubmit(e) {
  e.preventDefault();
  if (!ctx) return;
  const myCtx = ctx;
  const form = e.target;
  const to = form.elements.to.value.trim();
  const subject = form.elements.subject.value.trim();
  const preview = dlg.querySelector(".em-preview");
  const errEl = dlg.querySelector(".em-error");
  const btn = dlg.querySelector(".em-send");

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

  try {
    const res = await callApi({
      action: "sendTreatmentEmail",
      recordId: myCtx.recordId,
      to,
      subject,
      html: preview.innerHTML,
      treatments: myCtx.items.map((i) => i.name),
    });
    showToast(`Email sent to ${to}`);
    if (myCtx.onSent && res && res.entry) myCtx.onSent(res.entry);
    dlg.close();
  } catch (err) {
    console.error("Sending the email failed:", err);
    const messages = {
      BAD_EMAIL: "That email address doesn't look right.",
      RATE_LIMITED: "You've sent a lot of emails in the last hour. Please try again shortly.",
      QUOTA: "The clinic's daily email limit has been reached. Please try again tomorrow.",
      NOT_FOUND: "This consultation record no longer exists.",
      UNAUTHORIZED: "Your session has expired. Please log in again.",
    };
    errEl.textContent = messages[err.code] || "Couldn't send the email. Please try again.";
    btn.disabled = false;
    btn.innerHTML = `${I.send}Send Email Now`;
  }
}