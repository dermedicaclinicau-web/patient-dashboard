// Recall settings → Email templates (#/settings/recall/emails). Saved in recall_settings/emails.
// Used by the compose window on recall cards (recall-email.js) and the flow's "Send an email" card.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { createRichEditor } from "./rich-editor.js";
import { hydrateRichImages } from "./rich-html.js";
import { openImagePicker } from "./image-bank.js";
import { getLetterhead } from "./form-templates.js";
import {
  fillTemplate, fillTemplateHtml, emailShell, clinicDetails, subjectHtml, EMAIL_BACKGROUNDS, EMAIL_ACCENTS,
} from "./task-tokens.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { normRecallSettings, recallTabsHtml } from "./recall-settings.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rid = () => "t_" + Math.random().toString(36).slice(2, 9);
export const RECALL_EMAIL_TOKENS = ["First name", "Full name", "Treatment", "Months", "Due date", "Last visit", "Last seen with", "Clinic phone"];
const MAX = 30;

const starter = () => ({
  id: rid(), name: "Recall reminder", isDefault: true,
  subject: "Time for your next {Treatment}, {First name}?",
  body: ["Hi {First name},",
    "It's been about {Months} months since your last {Treatment}, so you're due for your next one.",
    "Reply to this email or call us on {Clinic phone} and we'll find a time that suits you.",
    "Kind regards,<br>The Dermedica team"].map((l) => `<p>${l}</p>`).join(""),
});
export const blankEmailTemplate = () => ({ id: rid(), name: "New template", subject: "", body: "", isDefault: false });

export function normEmailTemplates(d) {
  const src = d && typeof d === "object" ? d : {};
  const list = (Array.isArray(src.templates) ? src.templates : []).filter((t) => t && typeof t === "object").slice(0, MAX)
    .map((t) => ({ id: String(t.id || rid()), name: String(t.name || "Untitled").slice(0, 80),
      subject: String(t.subject || "").slice(0, 200), body: String(t.body || ""), isDefault: t.isDefault === true }));
  if (!list.length) list.push(starter());
  let seen = false;
  list.forEach((t) => { if (t.isDefault) { if (seen) t.isDefault = false; seen = true; } });
  if (!seen) list[0].isDefault = true;
  return {
    templates: list,
    style: { background: EMAIL_BACKGROUNDS[0], accent: EMAIL_ACCENTS[0], width: 600, logo: true, footer: true, ...(src.style || {}) },
  };
}
export async function loadRecallEmailTemplates() {
  const d = await getDoc(doc(db, "recall_settings", "emails"));
  return normEmailTemplates(d.exists() ? d.data() : null);
}

export async function mountRecallEmails(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide rs re-page";
  root.innerHTML = `<a class="back-link" href="#/recall">← Recall</a>${recallTabsHtml("emails")}
    <div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);

  let data, settings, letterhead = {};
  try {
    const [t, s, lh] = await Promise.all([
      loadRecallEmailTemplates(),
      getDoc(doc(db, "recall_settings", "config")),
      getLetterhead().catch(() => ({})),
    ]);
    data = t;
    settings = normRecallSettings(s.exists() ? s.data() : {});
    letterhead = lh || {};
  } catch (err) {
    console.error("Recall email templates load failed:", err);
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="#/recall">← Recall</a>${recallTabsHtml("emails")}
      <div class="state error"><strong>Couldn't open the email templates</strong>${err && err.code === "permission-denied"
        ? "Check Recall settings access in Staff, and that the Firestore rules are published." : "Check your connection and try again."}</div>`;
    return;
  }
  if (!root.isConnected) return;

  let selId = (data.templates.find((t) => t.isDefault) || data.templates[0]).id;
  let editor = null, lastInput = null;
  let dirty = false, saving = false, timer = null;

  root.innerHTML = `
    <a class="back-link" href="#/recall">← Recall</a>
    ${recallTabsHtml("emails")}
    <div class="mc-head">
      <h2 style="margin:0">Email templates</h2>
      <span class="muted" data-role="state">All changes saved</span>
      <button type="button" class="btn-primary" data-act="new" style="margin-left:auto">+ New template</button>
    </div>
    <p class="muted" style="margin:.6rem .25rem 1.1rem;font-size:.85rem">Used when staff press Email on a recall card, and by the
      Send an email card in the Flow. The ★ default is filled in automatically.</p>
    <div class="re-grid">
      <aside class="re-side">
        <div class="tb-card re-list" data-role="list"></div>
        <div class="tb-card" data-role="design"></div>
      </aside>
      <div class="tb-card re-edit" data-role="edit"></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const stateEl = $('[data-role="state"]');
  const listEl = $('[data-role="list"]');
  const editEl = $('[data-role="edit"]');
  const designEl = $('[data-role="design"]');

  /* ---------- Saving ---------- */
  const setState = (s) => {
    stateEl.textContent = s === "saving" ? "Saving…" : s === "dirty" ? "Unsaved changes" : s === "error" ? "Couldn't save. Retrying…" : "All changes saved";
  };
  function changed() { dirty = true; setState("dirty"); clearTimeout(timer); timer = setTimeout(flush, 800); }
  async function flush() {
    clearTimeout(timer);
    if (!dirty || saving) return;
    saving = true; dirty = false; setState("saving");
    let failed = false;
    try {
      const uid = auth.currentUser && auth.currentUser.uid;
      if (!uid) throw new Error("Not logged in");
      await setDoc(doc(db, "recall_settings", "emails"), {
        templates: JSON.parse(JSON.stringify(data.templates)), style: { ...data.style },
        updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120), updatedByUid: uid,
      });
      setState(dirty ? "dirty" : "saved");
    } catch (err) {
      console.error("Recall email templates save failed:", err);
      failed = true; dirty = true; setState("error");
    } finally {
      saving = false;
      if (dirty) timer = setTimeout(flush, failed ? 4000 : 400);
    }
  }
  const onBeforeUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ""; } };
  const onHashChange = () => {
    if (root.isConnected) return;
    flush();
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("hashchange", onHashChange);

  /* ---------- Example details for the preview ---------- */
  function sample() {
    const cat = settings.categories.find((c) => c.on) || settings.categories[0];
    const c = clinicDetails(letterhead);
    return new Map([
      ["first name", "Sarah"], ["full name", "Sarah Citizen"], ["treatment", (cat && cat.smsName) || "treatment"],
      ["months", String((cat && cat.months) || 4)], ["due date", "14 October 2026"], ["last visit", "14 June 2026"],
      ["last seen with", "Dr Teh"], ["clinic phone", settings.sms.phone || c.phone || ""],
      ["clinic email", c.email || ""], ["clinic address", c.address || ""],
    ]);
  }
  const cur = () => data.templates.find((t) => t.id === selId) || data.templates[0];

  /* ---------- Drawing ---------- */
  function renderList() {
    listEl.innerHTML = `<h4 class="mc-h">Templates <small class="muted">${data.templates.length} of ${MAX}</small></h4>
      <div class="re-items">${data.templates.map((t) => `
        <button type="button" class="re-item${t.id === selId ? " is-on" : ""}" data-pick="${esc(t.id)}" aria-pressed="${t.id === selId}">
          <span class="re-item-name">${t.isDefault ? '<span class="re-star" title="Default">★</span>' : ""}${esc(t.name)}</span>
          <small>${esc(t.subject || "No subject yet")}</small>
        </button>`).join("")}</div>`;
  }
  function renderDesign() {
    const s = data.style;
    const sw = (key, list) => `<div class="tb-swatches">${list.map((c) => `
      <label class="tb-sw" title="${c}"><input type="radio" name="re-${key}" data-style="${key}" value="${c}"${s[key] === c ? " checked" : ""} />
        <span style="background:${c}"></span></label>`).join("")}</div>`;
    designEl.innerHTML = `<h4 class="mc-h">Email design</h4>
      <div class="tb-field"><span>Background</span>${sw("background", EMAIL_BACKGROUNDS)}</div>
      <div class="tb-field"><span>Accent</span>${sw("accent", EMAIL_ACCENTS)}</div>
      <label class="fe-check"><input type="checkbox" data-style="logo"${s.logo ? " checked" : ""} /> Clinic logo at the top</label>
      <label class="fe-check"><input type="checkbox" data-style="footer"${s.footer ? " checked" : ""} /> Clinic details at the bottom</label>`;
  }
  function renderEdit() {
    const t = cur();
    editEl.innerHTML = `
      <div class="re-edit-head">
        <label class="tb-field" style="flex:1"><span>Template name</span>
          <input class="fe-input" data-k="name" maxlength="80" value="${esc(t.name)}" /></label>
        <button type="button" class="lh-btn is-quiet re-del" data-act="delete"${data.templates.length < 2 ? " disabled" : ""}>Delete</button>
      </div>
      <label class="fe-check"><input type="checkbox" data-k="isDefault"${t.isDefault ? " checked" : ""}${t.isDefault ? " disabled" : ""} />
        ${t.isDefault ? "★ This is the default template" : "Use as the default"}</label>
      <label class="tb-field"><span>Subject</span><input class="fe-input" data-k="subject" data-tokens maxlength="200" value="${esc(t.subject)}" /></label>
      <div class="tb-field"><span>Message</span><div data-role="editor"></div></div>
      <div class="fe-chiprow">${RECALL_EMAIL_TOKENS.map((k) => `<button type="button" class="fe-ins" data-token="${esc(k)}">{${esc(k)}}</button>`).join("")}</div>
      <small class="muted">{Treatment} names every treatment they're due for. An unsubscribe link is always added at the bottom.</small>
      <h4 class="mc-h" style="margin-top:.5rem">Preview <small class="muted">(with example details)</small></h4>
      <div data-role="prev"></div>`;
    editor = createRichEditor(editEl.querySelector('[data-role="editor"]'), {
      onInput: () => { cur().body = editor.getHtml(); changed(); renderPreview(); },
      onFocus: () => { lastInput = null; },
      pickImage: () => openImagePicker({ isAdmin: true }),
      accent: () => data.style.accent,
      logo: () => letterhead.logo || "",
      tokens: () => [{ title: "Recall", tokens: RECALL_EMAIL_TOKENS.map((name) => ({ name, kind: "", hint: "" })) }],
    });
    editor.setHtml(t.body || "");
    renderPreview();
  }
  function renderPreview() {
    const box = editEl.querySelector('[data-role="prev"]');
    if (!box) return;
    const t = cur(), vals = sample();
    box.innerHTML = `<div class="tb-mail">
      <div class="tb-mail-row"><span>To</span><span>Sarah Citizen &lt;sarah@example.com&gt;</span></div>
      <div class="tb-mail-row"><span>Subject</span><strong>${subjectHtml(fillTemplate(t.subject, vals)) || "<em>No subject yet</em>"}</strong></div>
      <div class="tb-mail-body tb-mail-shell" data-role="shell">${emailShell(fillTemplateHtml(t.body || "", vals), data.style,
        { clinic: clinicDetails(letterhead), hasLogo: !!letterhead.logo })}</div></div>`;
    hydrateRichImages(box.querySelector('[data-role="shell"]'), { logo: letterhead.logo || "" });
  }

  /* ---------- Events ---------- */
  root.addEventListener("focusin", (e) => { if (e.target.matches("[data-tokens]")) lastInput = e.target; });
  root.addEventListener("mousedown", (e) => { if (e.target.closest("[data-token]")) e.preventDefault(); });
  root.addEventListener("input", (e) => {
    const el = e.target;
    if (el.closest(".re")) return;   // the rich editor reports its own changes
    if (el.dataset.style !== undefined) {
      data.style[el.dataset.style] = el.type === "checkbox" ? el.checked : el.value;
      changed(); renderPreview();
      return;
    }
    const k = el.dataset.k;
    if (!k) return;
    const t = cur();
    if (k === "isDefault") {
      data.templates.forEach((x) => { x.isDefault = x.id === t.id; });
      changed(); renderList(); renderEdit();
      return;
    }
    t[k] = el.value;
    changed();
    if (k === "name" || k === "subject") renderList();
    if (k === "subject") renderPreview();
  });
  root.addEventListener("click", async (e) => {
    const tok = e.target.closest("[data-token]");
    if (tok) {
      const ins = `{${tok.dataset.token}}`;
      if (lastInput && lastInput.isConnected) {
        const el = lastInput, a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
        el.value = el.value.slice(0, a) + ins + el.value.slice(b);
        el.focus();
        el.setSelectionRange(a + ins.length, a + ins.length);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (editor) editor.insertToken(tok.dataset.token);
      return;
    }
    const pick = e.target.closest("[data-pick]");
    if (pick) { selId = pick.dataset.pick; lastInput = null; renderList(); renderEdit(); return; }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "new") {
      if (data.templates.length >= MAX) { showToast(`You can have up to ${MAX} templates.`); return; }
      const t = blankEmailTemplate();
      data.templates.push(t);
      selId = t.id;
      changed(); renderList(); renderEdit();
      editEl.querySelector('[data-k="name"]').select();
      return;
    }
    if (act.dataset.act === "delete") {
      const t = cur();
      if (data.templates.length < 2) return;
      if (!(await confirmDialog({ title: `Delete "${t.name}"?`, message: "Emails already sent aren't affected.", confirmLabel: "Delete", tone: "danger" }))) return;
      data.templates = data.templates.filter((x) => x.id !== t.id);
      if (t.isDefault) data.templates[0].isDefault = true;
      selId = data.templates[0].id;
      changed(); renderList(); renderEdit();
    }
  });

  renderList();
  renderDesign();
  renderEdit();
}