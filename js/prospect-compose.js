/* Prospect Dashboard → the Email / Text window.
   openProspectCompose({ prospect, kind: "email" | "text", myName, send, onSent, toast })
   send(body) → Promise of the Apps Script reply ({ ok, problem, prospect }) */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const SMS_MAX = 612;
const GSM_RE = /^[\n\r A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;

const TEMPLATES = {
  email: [
    { label: "Thanks for enquiring", subject: "Your enquiry with Dermedica",
      body: "<p>Hi {First name},</p><p>Thank you for getting in touch with Dermedica about {Interest}. I'd love to have a quick chat about what you're hoping to achieve and the options that might suit you.</p><p>Is there a good time for me to give you a call? Or reply to this email with a few times that work for you.</p><p>Kind regards,<br>{My name}<br>Dermedica</p>" },
    { label: "Following up", subject: "Following up on your enquiry",
      body: "<p>Hi {First name},</p><p>I'm just following up on your recent enquiry about {Interest}. If you have any questions, I'm happy to help, and we can book a consultation whenever suits you.</p><p>Just reply to this email and let me know.</p><p>Kind regards,<br>{My name}<br>Dermedica</p>" },
    { label: "Book a consultation", subject: "Booking your consultation at Dermedica",
      body: "<p>Hi {First name},</p><p>Thanks again for your interest in {Interest}. The best first step is a consultation, where we'll look at your concerns together and put together a plan that's right for you.</p><p>Let me know a day and time that suits, and I'll book it in.</p><p>Kind regards,<br>{My name}<br>Dermedica</p>" },
  ],
  text: [
    { label: "Thanks for enquiring",
      body: "Hi {First name}, it's {My name} from Dermedica. Thanks for your enquiry about {Interest}. When's a good time for a quick call?" },
    { label: "Following up",
      body: "Hi {First name}, it's {My name} from Dermedica, just following up on your enquiry. Happy to answer any questions or book you in. Just reply here." },
    { label: "Book a consultation",
      body: "Hi {First name}, it's {My name} from Dermedica. Would you like to book a consultation? Let me know a day and time that suits and I'll book it in." },
  ],
};

/* ---------- Perth time ---------- */
function perth() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Perth", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { key: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) };
}
const addDays = (key, n) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const longDate = (key) => (/^\d{4}-\d{2}-\d{2}$/.test(key || "")
  ? new Date(`${key}T12:00:00Z`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
  : "");

/* ---------- Helpers ---------- */
function fill(text, vals, html) {
  return String(text || "").replace(/\{\s*(first name|interest|my name)\s*\}/gi, (m, k) => {
    const v = vals[k.toLowerCase().replace(/\s+/g, " ")] ?? "";
    return html ? esc(v) : v;
  });
}
function smsMeter(text) {
  const len = text.length;
  const unicode = !GSM_RE.test(text);
  const one = unicode ? 70 : 160;
  const many = unicode ? 67 : 153;
  return { len, unicode, parts: !len ? 0 : len <= one ? 1 : Math.ceil(len / many) };
}

/* ---------- The window ---------- */
export function openProspectCompose({ prospect, kind = "email", myName = "", send, onSent, toast } = {}) {
  const p = prospect || {};
  const isEmail = kind === "email";
  const concern = String(p.concern || "").trim();
  const vals = {
    "first name": String(p.firstName || p.name || "").trim().split(/\s+/)[0] || "there",
    "interest": concern && !/other|query|general|enquir/i.test(concern) ? concern.toLowerCase() : "treatment options",
    "my name": String(myName || "").trim().split(/\s+/)[0] || "the Dermedica team",
  };
  const to = isEmail ? String(p.email || "") : String(p.phone || "");
  const prefNote = !isEmail && p.pref === "Email" ? "They said they prefer email."
    : isEmail && (p.pref === "SMS" || p.pref === "Call") ? `They said they prefer ${p.pref === "SMS" ? "a text" : "a call"}.` : "";
  const today = perth().key;
  const title = `${isEmail ? "Email" : "Text"} ${p.name || "this prospect"}`;

  const root = document.createElement("div");
  root.className = "pc-backdrop";
  root.innerHTML = `
    <div class="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-title">
      <header class="pc-head">
        <div class="pc-head-txt">
          <h2 id="pc-title">${esc(title)}</h2>
          <p class="pc-to">${to ? `To <strong>${esc(to)}</strong>` : `<span class="pc-warn">No ${isEmail ? "email address" : "mobile number"} for them</span>`}
            ${prefNote ? `<span class="pc-pref">${esc(prefNote)}</span>` : ""}</p>
        </div>
        <button type="button" class="pc-x" aria-label="Close">×</button>
      </header>

      <div class="pc-body">
        <div class="pc-tpl">
          <span class="pc-lbl">Start from</span>
          ${TEMPLATES[isEmail ? "email" : "text"].map((t, i) => `<button type="button" class="pc-chip" data-tpl="${i}">${esc(t.label)}</button>`).join("")}
        </div>

        ${isEmail ? `
          <label class="pc-field"><span class="pc-lbl">Subject</span>
            <input class="fe-input pc-subject" maxlength="200" autocomplete="off"></label>
          <div class="pc-field">
            <span class="pc-lbl">Message</span>
            <div class="pc-editor-wrap">
              <div class="pc-tools" role="toolbar" aria-label="Formatting">
                <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
                <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
                <button type="button" data-cmd="insertUnorderedList" title="Bullet list">• List</button>
                <button type="button" data-cmd="link" title="Add a link">Link</button>
                <button type="button" data-cmd="removeFormat" title="Clear formatting">Clear</button>
              </div>
              <div class="pc-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message"></div>
            </div>
          </div>` : `
          <label class="pc-field"><span class="pc-lbl">Message</span>
            <textarea class="fe-input pc-sms" rows="5" maxlength="${SMS_MAX}"></textarea></label>
          <div class="pc-meter"><span class="pc-count">0 / ${SMS_MAX}</span><span class="pc-parts"></span></div>
          <div class="pc-phone" aria-hidden="true"><div class="pc-bubble pc-bubble-empty">Your text will look like this.</div></div>`}

        <div class="pc-follow">
          <span class="pc-lbl">Follow up${p.nextFollowUp ? ` <em>(now ${esc(longDate(p.nextFollowUp))})</em>` : ""}</span>
          <div class="pc-seg">
            <button type="button" class="is-on" data-fu="keep">Leave as is</button>
            <button type="button" data-fu="2">In 2 days</button>
            <button type="button" data-fu="7">In a week</button>
            <button type="button" data-fu="pick">Pick a date</button>
          </div>
          <div class="pc-fu-more" hidden>
            <input type="date" class="fe-input pc-fu-date" min="${today}">
            <input class="fe-input pc-fu-note" maxlength="300" placeholder="What to follow up (optional)">
          </div>
        </div>

        <p class="pc-err" role="alert" hidden></p>
      </div>

      <footer class="pc-foot">
        <span class="pc-note">Logged on their Timeline. A New enquiry moves to Contacted.</span>
        <div class="pc-btns">
          <button type="button" class="pc-btn pc-cancel">Cancel</button>
          <button type="button" class="pc-btn pc-send" ${to ? "" : "disabled"}>${isEmail ? "Send email" : "Send text"}</button>
        </div>
      </footer>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const sendBtn = $(".pc-send");
  const errEl = $(".pc-err");
  const subjectEl = $(".pc-subject");
  const editor = $(".pc-editor");
  const sms = $(".pc-sms");
  const fuMore = $(".pc-fu-more");
  const fuDate = $(".pc-fu-date");
  const fuNote = $(".pc-fu-note");
  const prevFocus = document.activeElement;
  let dirty = false;
  let busy = false;
  let fuMode = "keep";

  const showErr = (m) => { errEl.textContent = m || ""; errEl.hidden = !m; };

  // Texts: only 8 am to 8 pm Perth (the same rule as Apps Script)
  const quiet = () => { const h = perth().hour; return h < 8 || h >= 20; };
  if (!isEmail && quiet()) showErr("Texts can only be sent between 8 am and 8 pm (Perth time).");

  /* ---- Templates ---- */
  root.querySelectorAll("[data-tpl]").forEach((b) => b.addEventListener("click", () => {
    const t = TEMPLATES[isEmail ? "email" : "text"][Number(b.dataset.tpl)];
    const has = isEmail ? editor.innerText.trim() || subjectEl.value.trim() : sms.value.trim();
    if (has && dirty && !confirm("Replace what you've written with this template?")) return;
    if (isEmail) {
      subjectEl.value = fill(t.subject, vals, false);
      editor.innerHTML = fill(t.body, vals, true);
    } else {
      sms.value = fill(t.body, vals, false);
      updateSms();
    }
    root.querySelectorAll("[data-tpl]").forEach((x) => x.classList.toggle("is-on", x === b));
    dirty = true;
    (isEmail ? editor : sms).focus();
  }));

  /* ---- Email editor ---- */
  if (isEmail) {
    root.querySelectorAll("[data-cmd]").forEach((b) => {
      b.addEventListener("mousedown", (e) => e.preventDefault());   // keeps the selection in the editor
      b.addEventListener("click", () => {
        editor.focus();
        if (b.dataset.cmd === "link") {
          let url = prompt("Link address (https://…)", "https://");
          if (!url) return;
          url = url.trim();
          if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
          document.execCommand("createLink", false, url);
        } else {
          document.execCommand(b.dataset.cmd, false, null);
        }
        dirty = true;
      });
    });
    editor.addEventListener("paste", (e) => {   // pasted text arrives clean
      e.preventDefault();
      document.execCommand("insertText", false, (e.clipboardData || window.clipboardData).getData("text/plain"));
    });
    editor.addEventListener("input", () => { dirty = true; });
    subjectEl.addEventListener("input", () => { dirty = true; });
  }

  /* ---- Text counter and preview ---- */
  function updateSms() {
    const m = smsMeter(sms.value);
    $(".pc-count").textContent = `${m.len} / ${SMS_MAX}`;
    $(".pc-parts").textContent = m.parts ? `${m.parts} SMS${m.unicode ? " · has emoji or special characters" : ""}` : "";
    $(".pc-parts").classList.toggle("is-many", m.parts > 2);
    const bub = $(".pc-bubble");
    bub.textContent = sms.value.trim() || "Your text will look like this.";
    bub.classList.toggle("pc-bubble-empty", !sms.value.trim());
  }
  if (!isEmail) {
    sms.addEventListener("input", () => { dirty = true; updateSms(); });
    updateSms();
  }

  /* ---- Follow-up ---- */
  root.querySelectorAll("[data-fu]").forEach((b) => b.addEventListener("click", () => {
    fuMode = b.dataset.fu;
    root.querySelectorAll("[data-fu]").forEach((x) => x.classList.toggle("is-on", x === b));
    fuMore.hidden = fuMode === "keep";
    fuDate.hidden = fuMode !== "pick";
    if (fuMode === "2" || fuMode === "7") fuDate.value = addDays(perth().key, Number(fuMode));
    if (fuMode === "pick") { if (!fuDate.value) fuDate.value = addDays(perth().key, 3); fuDate.focus(); }
  }));
  function followUp() {
    if (fuMode === "keep") return {};
    const d = fuDate.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < perth().key) { showErr("Choose a follow-up date from today onwards."); return null; }
    return { followUp: d, followNote: fuNote.value.trim().slice(0, 300) };
  }

  /* ---- Sending ---- */
  async function doSend() {
    if (busy) return;
    showErr("");
    let body;
    if (isEmail) {
      const subject = subjectEl.value.replace(/\s+/g, " ").trim();
      if (!subject) { showErr("Add a subject."); subjectEl.focus(); return; }
      if (editor.innerText.replace(/\s+/g, "").length < 5) { showErr("Write the message first."); editor.focus(); return; }
      body = { op: "email", subject, html: editor.innerHTML };
    } else {
      const text = sms.value.replace(/\r/g, "").trim();
      if (text.length < 5) { showErr("Write the message first."); sms.focus(); return; }
      if (quiet()) { showErr("Texts can only be sent between 8 am and 8 pm (Perth time)."); return; }
      body = { op: "text", text };
    }
    const fu = followUp();
    if (!fu) return;
    Object.assign(body, fu);

    busy = true;
    const label = sendBtn.textContent;
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    try {
      const res = await send(body);
      if (!res || res.problem || res.ok === false) {
        showErr(res?.problem || "It wasn't sent. Try again.");
        return;
      }
      dirty = false;
      close();
      onSent?.(res.prospect || null);
      toast?.(isEmail ? "Email sent" : "Text sent");
    } catch (e) {
      showErr(e?.message || "It wasn't sent. Check your connection and try again.");
    } finally {
      busy = false;
      if (root.isConnected) { sendBtn.disabled = !to; sendBtn.textContent = label; }
    }
  }
  sendBtn.addEventListener("click", doSend);

  /* ---- Opening and closing ---- */
  function close() {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    document.body.classList.remove("pc-open");
    prevFocus?.focus?.();
  }
  function tryClose() {
    if (busy) return;
    if (dirty && !confirm("Close without sending? What you've written will be lost.")) return;
    close();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); tryClose(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); return; }
    if (e.key === "Tab") {   // keeps the keyboard inside the window
      const f = [...root.querySelectorAll("button:not([disabled]),input:not([hidden]),textarea,[contenteditable=true]")]
        .filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }
  $(".pc-x").addEventListener("click", tryClose);
  $(".pc-cancel").addEventListener("click", tryClose);
  root.addEventListener("mousedown", (e) => { if (e.target === root) tryClose(); });
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(root);
  document.body.classList.add("pc-open");
  requestAnimationFrame(() => root.classList.add("is-in"));
  (isEmail ? subjectEl : sms).focus();
}