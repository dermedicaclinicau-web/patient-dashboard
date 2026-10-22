// Patient page → SMS: text the patient through Textmagic (sent by Apps Script, so the key never reaches the browser).
// Shows the conversation so far: texts from patient pages, Recall texts, and their replies.
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { escapeHtml as esc, formatMobile, toTelHref, showToast } from "./utils.js";

const MAX = 612;
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";
const TEMPLATES = [
  ["Running late", "Hi {First name}, it's Dermedica. We're running about 15 minutes behind today. Sorry for the wait, see you soon."],
  ["Please call us", "Hi {First name}, it's Dermedica. Could you please give us a call when you have a moment? Thank you."],
  ["Products ready", "Hi {First name}, it's Dermedica. Your products are ready to collect from reception."],
  ["Missed appointment", "Hi {First name}, it's Dermedica. We missed you at your appointment today. Reply or give us a call to book a new time."],
];

// iPad autocorrect makes curly quotes and long dashes, which halve how much fits in one SMS: swapped for plain ones
export const plainSms = (s) => String(s || "")
  .replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
  .replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/\u00A0/g, " ");

// { n: characters as counted, parts: how many SMS, uni: has an emoji or special character }
export function smsParts(text) {
  let units = 0;
  for (const ch of text) {
    if (GSM.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      const n = text.length;
      return { n, uni: true, parts: n <= 70 ? 1 : Math.ceil(n / 67) };
    }
  }
  return { n: units, uni: false, parts: units <= 160 ? 1 : Math.ceil(units / 153) };
}

const fmtAt = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const today = new Date().toDateString() === d.toDateString();
  return (today ? "Today" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }))
    + ", " + d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
};

const errText = (e) => (e && e.code === "FORBIDDEN"
  ? "You don't have access to send texts. Ask an Admin to tick “Text patients from their page” in Staff → Roles & access."
  : e && e.code === "UNAUTHORIZED" ? "Your session has expired. Log out and back in."
  : (e && e.message) || "Couldn't reach the server. Try again.");

export function openSmsDialog({ patient }) {
  const first = patient.firstName || String(patient.name || "").split(" ")[0] || "there";
  const tel = toTelHref(patient.mobile);
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog sms-dlg";
  dlg.innerHTML = `<form class="lh-form sms-form" novalidate>
      <div class="sms-head">
        <div><h3>Text ${esc(patient.name || "patient")}</h3><p>${esc(formatMobile(patient.mobile))}</p></div>
        <button type="button" class="hx-x" data-act="cancel" aria-label="Close">×</button>
      </div>
      <div class="sms-thread" data-role="thread" aria-live="polite"><div class="skeleton" style="height:90px;border-radius:12px"></div></div>
      <div data-role="warn"></div>
      <div class="sms-tpls" role="group" aria-label="Quick messages">${TEMPLATES.map(([l], i) =>
        `<button type="button" class="sms-tpl" data-tpl="${i}">${esc(l)}</button>`).join("")}</div>
      <textarea name="text" class="fe-input sms-text" rows="4" maxlength="${MAX}" placeholder="Type your message…"
        aria-label="Message"></textarea>
      <div class="sms-meta"><span data-role="count"></span>
        ${tel ? `<a class="sms-phone" href="sms:${esc(tel)}">Open in phone instead</a>` : ""}</div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Close</button>
        <button type="submit" class="lh-btn is-primary" disabled>Send</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  const $ = (s) => dlg.querySelector(s);
  const form = $("form");
  const ta = form.elements.text;
  const btn = $('[type="submit"]');
  const err = $(".lh-error");
  const st = { ready: false, blocked: null, items: [], busy: false, loaded: false };

  function drawThread() {
    const box = $('[data-role="thread"]');
    if (!st.items.length) { box.innerHTML = '<p class="sms-empty">No texts with this patient yet.</p>'; return; }
    box.innerHTML = st.items.map((m) => `<div class="sms-msg is-${m.dir === "in" ? "in" : "out"}${m.kind === "stop" ? " is-stop" : ""}">
        <div class="sms-bubble">${esc(m.text).replace(/\n/g, "<br>")}</div>
        <small>${esc([fmtAt(m.at), m.dir === "in" ? "Patient" : m.by, m.src].filter(Boolean).join(" · "))}</small>
      </div>`).join("");
    box.scrollTop = box.scrollHeight;
  }

  function drawWarn() {
    const box = $('[data-role="warn"]');
    if (!st.ready) {
      box.innerHTML = `<p class="sms-warn is-bad">Texts aren't set up yet. Ask an Admin to add the Textmagic details in Apps Script.</p>`;
      return;
    }
    const b = st.blocked;
    box.innerHTML = b && b.dnc ? `<div class="sms-warn">
        <p><strong>${esc(b.why)}</strong> Only text them about their appointments or care, never offers or promotions.</p>
        <label class="fe-check"><input type="checkbox" name="service" /> This is about their appointment or care</label>
      </div>` : "";
  }

  function update() {
    const text = plainSms(ta.value);
    const c = smsParts(text);
    const cnt = $('[data-role="count"]');
    cnt.textContent = text.trim()
      ? `${c.n} characters · ${c.parts} SMS${c.uni ? " · has an emoji or special character, so each SMS holds less" : ""}`
      : "1 SMS holds 160 characters";
    cnt.classList.toggle("is-warn", c.parts > 1 || c.uni);
    const needsTick = st.blocked && st.blocked.dnc && !(form.elements.service && form.elements.service.checked);
    btn.disabled = st.busy || !st.loaded || !st.ready || !text.trim() || text.length > MAX || !!needsTick;
  }

  async function load() {
    try {
      const res = await callApi({ action: "sms", op: "thread", patientId: patient.id });
      if (!dlg.open) return;
      if (res.problem) { $('[data-role="thread"]').innerHTML = `<p class="sms-empty is-bad">${esc(res.problem)}</p>`; return; }
      Object.assign(st, { ready: res.ready !== false, blocked: res.blocked || null, items: res.items || [], loaded: true });
      drawThread();
      drawWarn();
      update();
    } catch (e) {
      console.error("SMS thread failed:", e);
      if (dlg.open) $('[data-role="thread"]').innerHTML = `<p class="sms-empty is-bad">${esc(errText(e))}</p>`;
    }
  }

  dlg.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="cancel"]')) { dlg.close(); return; }
    const t = e.target.closest("[data-tpl]");
    if (t) {
      ta.value = TEMPLATES[Number(t.dataset.tpl)][1].replace(/\{First name\}/g, first);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      update();
    }
  });
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!btn.disabled) form.requestSubmit(); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    const text = plainSms(ta.value).trim();
    const c = smsParts(text);
    if (c.parts > 1) {
      const ok = await confirmDialog({
        title: `Send as ${c.parts} SMS?`,
        message: `This message is ${c.n} characters, so it goes as ${c.parts} texts joined together, and each one is charged. Shorten it to keep it to 1.`,
        confirmLabel: "Send anyway",
      });
      if (!ok) return;
    }
    st.busy = true;
    err.hidden = true;
    btn.textContent = "Sending…";
    update();
    try {
      const res = await callApi({
        action: "sms", op: "send", patientId: patient.id, text,
        service: !!(form.elements.service && form.elements.service.checked),
      });
      if (res.problem) throw new Error(res.problem);
      st.items.push(res.item);
      drawThread();
      ta.value = "";
      showToast(`Text sent to ${first}`);
    } catch (ex) {
      console.error("SMS send failed:", ex);
      err.textContent = errText(ex);
      err.hidden = false;
    } finally {
      st.busy = false;
      btn.textContent = "Send";
      update();
      ta.focus();
    }
  });

  update();
  ta.focus();
  load();
}