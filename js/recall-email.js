// The Gmail-style compose window for emailing a patient from a recall card.
// installRecallEmail() turns the Email (mailto:) links on the Recall pages into this window.
import { db } from "./firebase-config.js";
import { collection, query, where, limit, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { createRichEditor } from "./rich-editor.js";
import { openImagePicker } from "./image-bank.js";
import { getLetterhead } from "./form-templates.js";
import { fillTemplate, fillTemplateHtml, emailShell, clinicDetails } from "./task-tokens.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { normRecallSettings } from "./recall-settings.js";
import { loadRecallEmailTemplates } from "./recall-emails.js";
import { fillDateTokens } from "./date-tokens.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  min: ic('<line x1="5" y1="12" x2="19" y2="12"/>'),
  max: ic('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  x: ic('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  trash: ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  send: ic('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
};
const longDate = (k) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(k || ""))) return "";
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
};

let current = null;
let installed = false;

export function installRecallEmail() {
  if (installed) return;
  installed = true;
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest('a[href^="mailto:"]');
    if (!a || !String(location.hash).startsWith("#/recall") || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const email = decodeURIComponent(a.getAttribute("href").slice(7).split("?")[0]).trim();
    if (!email) return;
    e.preventDefault();
    e.stopPropagation();
    const host = a.closest("[data-card]");
    openRecallEmail({ email, cardId: (host && host.dataset.card) || "" });
  }, true);
}

export async function openRecallEmail({ email, cardId = "" }) {
  if (current) {
    if (current.email.toLowerCase() === email.toLowerCase()) { current.restore(); return; }
    if (current.dirty() && !(await confirmDialog({
      title: "Discard this email?", message: "You have an email you haven't sent. Discard it and start a new one?",
      confirmLabel: "Discard", tone: "danger",
    }))) { current.restore(); return; }
    current.destroy();
  }
  current = compose(email, cardId);
}

// The recall card this email is about: the one clicked, else their open card (the main one if they're due for several)
async function findCard(email, cardId) {
  if (cardId) {
    try {
      const d = await getDoc(doc(db, "recalls", cardId));
      if (d.exists()) return { id: d.id, ...d.data() };
    } catch (err) { console.warn("Recall card not read:", err); }
  }
  const snap = await getDocs(query(collection(db, "recalls"), where("email", "==", email), where("status", "==", "open"), limit(10)));
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return list.find((c) => c.flowState !== "joined") || list[0] || null;
}

function valuesFor(card, settings, lh) {
  const nameOf = (k) => ((settings.categories.find((c) => c.key === k) || {}).smsName) || "treatment";
  const names = [card.category, ...(Array.isArray(card.alsoDue) ? card.alsoDue : [])].filter(Boolean).map(nameOf)
    .filter((n, i, a) => a.indexOf(n) === i);
  const treatment = names.length <= 1 ? names[0] || "treatment" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  let months = "";
  if (card.lastVisit) {
    const [y, m, d] = String(card.lastVisit).split("-").map(Number);
    months = String(Math.max(1, Math.round((Date.now() - new Date(y, m - 1, d)) / 864e5 / 30.4)));
  }
  const full = String(card.patientName || "");
  const c = clinicDetails(lh);
  return new Map([
    ["first name", full.replace(/\([^)]*\)/g, " ").trim().split(/\s+/)[0] || "there"], ["full name", full || "there"],
    ["treatment", treatment], ["main treatment", names[0] || "treatment"], ["months", months],
    ["due date", longDate(card.dueDate)], ["last visit", longDate(card.lastVisit)],
    ["last seen with", card.lastStaff || "our team"], ["clinic phone", settings.sms.phone || c.phone || ""],
    ["clinic email", c.email || ""], ["clinic address", c.address || ""],
  ]);
}

function compose(email, cardId) {
  const box = document.createElement("div");
  box.className = "rem";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "New email");
  box.innerHTML = `
    <div class="rem-head" data-act="restore">
      <strong data-role="title">New message</strong>
      <div class="rem-head-btns">
        <button type="button" data-act="min" aria-label="Minimise" title="Minimise">${I.min}</button>
        <button type="button" data-act="max" aria-label="Full screen" title="Full screen">${I.max}</button>
        <button type="button" data-act="close" aria-label="Close" title="Close">${I.x}</button>
      </div>
    </div>
    <div class="rem-main" data-role="main"><p class="rem-loading">Loading…</p></div>`;
  document.body.appendChild(box);

  let card = null, tpls = null, settings = null, lh = {}, editor = null, vals = null;
  let touched = false, sending = false;
  const api = {
    email,
    dirty: () => touched && !sending,
    restore: () => { box.classList.remove("is-min"); const s = box.querySelector(".rem-subject"); if (s) s.focus(); },
    destroy,
  };
  function destroy() { box.remove(); if (current === api) current = null; }
  const main = box.querySelector('[data-role="main"]');

  Promise.all([
    findCard(email, cardId),
    loadRecallEmailTemplates(),
    getDoc(doc(db, "recall_settings", "config")).then((d) => normRecallSettings(d.exists() ? d.data() : {})),
    getLetterhead().catch(() => ({})),
  ]).then(([c, t, s, l]) => {
    if (!box.isConnected) return;
    if (!c) {
      main.innerHTML = `<p class="rem-loading">No open recall card uses ${esc(email)}. Refresh the board and try again.</p>`;
      return;
    }
    card = c; tpls = t; settings = s; lh = l || {};
    vals = valuesFor(card, settings, lh);
    draw();
  }).catch((err) => {
    console.error("Compose failed to load:", err);
    if (box.isConnected) main.innerHTML = '<p class="rem-loading">Couldn\'t load. Check your connection and try again.</p>';
  });

  function draw() {
    const def = tpls.templates.find((t) => t.isDefault) || tpls.templates[0];
    box.querySelector('[data-role="title"]').textContent = `Email ${card.patientName || ""}`.trim();
    main.innerHTML = `
      <div class="rem-row"><span class="rem-lbl">To</span>
        <span class="rem-chip" title="${esc(email)}"><strong>${esc(card.patientName || "")}</strong> &lt;${esc(email)}&gt;</span></div>
      <div class="rem-row"><span class="rem-lbl">Template</span>
        <select class="rem-select" data-role="tpl" aria-label="Template">${tpls.templates.map((t) =>
          `<option value="${esc(t.id)}"${t.id === def.id ? " selected" : ""}>${t.isDefault ? "★ " : ""}${esc(t.name)}</option>`).join("")}
          <option value="">Blank email</option></select></div>
      <div class="rem-row"><input class="rem-subject" data-role="subject" maxlength="200" placeholder="Subject" aria-label="Subject" /></div>
      <div class="rem-editor" data-role="editor"></div>
      <p class="rem-err" role="alert" hidden></p>
      <div class="rem-foot">
        <button type="button" class="rem-send" data-act="send">${I.send}<span>Send</span></button>
        <span class="rem-note">From the clinic's email, with an unsubscribe link. Saved to the card's History.</span>
        <button type="button" class="rem-icon" data-act="discard" aria-label="Discard" title="Discard">${I.trash}</button>
      </div>`;
    editor = createRichEditor(main.querySelector('[data-role="editor"]'), {
      onInput: () => { touched = true; },
      onFocus: () => {},
      pickImage: () => openImagePicker({ isAdmin: false }),
      accent: () => tpls.style.accent,
      logo: () => lh.logo || "",
      tokens: () => [],
    });
    apply(def);
    main.querySelector('[data-role="subject"]').addEventListener("input", () => { touched = true; });
    main.querySelector('[data-role="tpl"]').addEventListener("change", async (e) => {
      const t = tpls.templates.find((x) => x.id === e.target.value) || null;
      if (touched && !(await confirmDialog({ title: "Replace what you've written?", message: "Choosing a template replaces the subject and message.",
        confirmLabel: "Replace", tone: "warning" }))) return;
      apply(t);
    });
    setTimeout(() => main.querySelector('[data-role="subject"]').focus(), 30);
  }
  function apply(t) {
    main.querySelector('[data-role="subject"]').value = t ? fillTemplate(fillDateTokens(t.subject), vals) : "";
    editor.setHtml(t ? fillTemplateHtml(fillDateTokens(t.body || ""), vals) : "");
    touched = false;
  }
  const showErr = (m) => { const el = main.querySelector(".rem-err"); el.textContent = m; el.hidden = !m; };

  async function send() {
    if (sending || !card) return;
    const subject = main.querySelector('[data-role="subject"]').value.replace(/\s+/g, " ").trim();
    const body = editor.getHtml();
    if (!subject) { showErr("Add a subject."); return; }
    if (!String(body).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, "").trim() && !/<img/i.test(body)) { showErr("Write a message first."); return; }
    if (/\{[A-Za-z ]+\}/.test(subject + body)) {
      if (!(await confirmDialog({ title: "Some blanks weren't filled in", message: "The email still has a {blank} in it. Send it anyway?",
        confirmLabel: "Send anyway", tone: "warning" }))) return;
    }
    showErr("");
    sending = true;
    const btn = main.querySelector('[data-act="send"]');
    btn.disabled = true;
    btn.querySelector("span").textContent = "Sending…";
    const reset = () => {
      sending = false;
      btn.disabled = false;
      btn.querySelector("span").textContent = "Send";
    };
    try {
      const html = emailShell(body, tpls.style, { clinic: clinicDetails(lh), hasLogo: !!lh.logo });
      const res = await callApi({ action: "recall", op: "sendEmail", id: card.id, to: email, subject, html });
      // The server said why it can't send (do-not-contact, bounced address, too big…): show it, keep the draft
      if (res && res.problem) { reset(); showErr(res.problem); return; }
      if (res && res.ok === false) throw Object.assign(new Error(res.error || "Failed"), { detail: res.detail });
      showToast(`Email sent to ${card.patientName || email}.`);
      destroy();
    } catch (err) {
      console.error("Recall email failed:", err);
      reset();
      showErr((err && err.detail) || "The email couldn't be sent. Check your connection and try again.");
    }
  }
  
  box.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const a = act.dataset.act;
    if (a === "restore") { if (box.classList.contains("is-min")) api.restore(); return; }
    e.stopPropagation();
    if (a === "min") { box.classList.toggle("is-min"); box.classList.remove("is-max"); return; }
    if (a === "max") { box.classList.toggle("is-max"); box.classList.remove("is-min"); return; }
    if (a === "send") { send(); return; }
    if (a === "close" || a === "discard") {
      if (touched && !sending && !(await confirmDialog({ title: "Discard this email?", message: "What you've written won't be saved.",
        confirmLabel: "Discard", tone: "danger" }))) return;
      destroy();
    }
  });
  box.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
  });
  return api;
}