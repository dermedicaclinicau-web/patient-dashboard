// Marketing emails: the list (Task Manager → Marketing → Email templates, and Form Builder → Marketing emails)
// and the builder (#/tasks/marketing/templates/<id>). The builder works like Form Builder: blocks on the left,
// the email in the middle, settings on the right, the Image Bank for pictures and Form Builder's text editor.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { openImagePicker } from "./image-bank.js";
import { bankImage, bankUpload, bankError } from "./image-bank-api.js";
import { createRichEditor } from "./rich-editor.js";
import { makeResizable } from "./panel-resize.js";
import {
  esc, safeUrl, uid, BLOCKS, FONTS, MERGE_TAGS, STARTERS, styleOf, cleanDesign, newBlock, blockHtml, renderEmail,
  footerPreview, checkDesign, CUSTOM_PIECES, customNotes,
} from "./mkt-email.js";
import { openCropper } from "./mkt-crop.js";
import { listPublishedForms } from "./form-templates.js";

const COL = "mkt_templates";
const EMAIL_RE = /[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+/g;
const LIST_HREF = "#/tasks/marketing/templates";
const who = (staff) => String((staff && staff.name) || "").slice(0, 120);
const me = () => {
  const u = auth.currentUser && auth.currentUser.uid;
  if (!u) throw new Error("Your session has ended. Log in again.");
  return u;
};
const isAdminOf = (staff) => /^admin$/i.test(String((staff && staff.role) || ""));
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const day = (d) => (d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to marketing emails. Check Marketing access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);
// Where "← Back" goes from the builder: the list it was opened from
export const setBuilderBack = (href) => { try { sessionStorage.setItem("mkt.back", href); } catch { /* private mode */ } };
const builderBack = () => { try { return sessionStorage.getItem("mkt.back") || LIST_HREF; } catch { return LIST_HREF; } };

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  header: ic('<rect x="3" y="4" width="18" height="6" rx="1"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="18" x2="15" y2="18"/>'),
  heading: ic('<path d="M6 4v16M18 4v16M6 12h12"/>'),
  text: ic('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="11" x2="20" y2="11"/><line x1="4" y1="16" x2="14" y2="16"/>'),
  image: ic('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-8 8"/>'),
  button: ic('<rect x="3" y="8" width="18" height="8" rx="4"/>'),
  product: ic('<path d="M6 7h12l-1 13H7z"/><path d="M9 7a3 3 0 0 1 6 0"/>'),
  columns: ic('<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/>'),
  divider: ic('<line x1="3" y1="12" x2="21" y2="12"/>'),
  spacer: ic('<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>'),
  social: ic('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>'),
  buttons: ic('<rect x="2" y="9" width="9" height="6" rx="3"/><rect x="13" y="9" width="9" height="6" rx="3"/>'),
  imagetext: ic('<rect x="3" y="5" width="8" height="8" rx="1.5"/><line x1="14" y1="7" x2="21" y2="7"/><line x1="14" y1="11" x2="21" y2="11"/><line x1="3" y1="17" x2="21" y2="17"/>'),
  quote: ic('<path d="M7 7h4v4H8a3 3 0 0 0 3 3v2a5 5 0 0 1-5-5zM14 7h4v4h-3a3 3 0 0 0 3 3v2a5 5 0 0 1-5-5z"/>'),
  offer: ic('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  html: ic('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  up: ic('<polyline points="18 15 12 9 6 15"/>'),
  down: ic('<polyline points="6 9 12 15 18 9"/>'),
  copy: ic('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  trash: ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
  mail: ic('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
};
// The palette, grouped like Form Builder's
const PAL = [
  ["Text", ["heading", "text", "quote"]],
  ["Buttons", ["button", "buttons"]],
  ["Pictures and products", ["image", "imagetext", "product", "columns", "offer"]],
  ["Layout", ["header", "divider", "spacer", "social", "html"]],
];

function openDialog(html, cls = "") {
  const dlg = document.createElement("dialog");
  dlg.className = `lh-dialog mk-dlg ${cls}`;
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

/* ===================== Firestore ===================== */

function normTpl(d) {
  const x = d.data() || {};
  return {
    id: d.id, name: String(x.name || "Untitled"), subject: String(x.subject || ""), preview: String(x.preview || ""),
    design: cleanDesign(x.design), status: x.status === "archived" ? "archived" : "active",
    updatedAt: toDate(x.updatedAt), updatedBy: String(x.updatedBy || x.createdBy || ""),
  };
}
export async function listTemplates() {
  const snap = await getDocs(collection(db, COL));
  return snap.docs.map(normTpl).filter((t) => t.status !== "archived")
    .sort((a, b) => (b.updatedAt ? b.updatedAt.getTime() : 0) - (a.updatedAt ? a.updatedAt.getTime() : 0));
}
export async function getTemplate(id) {
  const s = await getDoc(doc(db, COL, id));
  return s.exists() ? normTpl(s) : null;
}
const clean = (t) => ({
  name: String(t.name || "").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled",
  subject: String(t.subject || "").slice(0, 200), preview: String(t.preview || "").slice(0, 200),
  design: cleanDesign(t.design),
});
export async function createTemplate({ name, starter = "blank", from = null }, staff) {
  const s = STARTERS.find((x) => x.key === starter) || STARTERS[0];
  const data = clean(from ? { ...from, name } : { name, subject: s.subject, preview: s.preview, design: s.design() });
  const ref = await addDoc(collection(db, COL), {
    ...data, html: renderEmail(data), status: "active",
    createdAt: serverTimestamp(), createdBy: who(staff), createdByUid: me(),
    updatedAt: serverTimestamp(), updatedBy: who(staff), updatedByUid: me(),
  });
  return ref.id;
}
export async function saveTemplate(t, staff) {
  const data = clean(t);
  await updateDoc(doc(db, COL, t.id), {
    ...data, html: renderEmail(data), updatedAt: serverTimestamp(), updatedBy: who(staff), updatedByUid: me(),
  });
}
export async function archiveTemplate(id, staff) {
  await updateDoc(doc(db, COL, id), { status: "archived", updatedAt: serverTimestamp(), updatedBy: who(staff), updatedByUid: me() });
}

/* ===================== Pictures: from the Image Bank, hosted so emails can load them ===================== */
// Every picture lives in the Image Bank. The first time one goes in an email, a copy is put in
// Firebase Storage (mkt_images/) and its link is remembered in mkt_bank_images/{bankId}.

async function shrink(blob, max = 1200) {
  if (blob.type === "image/gif") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    if (im.naturalWidth <= max && blob.size < 500 * 1024) return blob;
    const k = Math.min(1, max / im.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(im.naturalWidth * k);
    c.height = Math.round(im.naturalHeight * k);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    const type = blob.type === "image/png" ? "image/png" : "image/jpeg";
    return await new Promise((res) => c.toBlob((b) => res(b || blob), type, 0.85));
  } catch { return blob; } finally { URL.revokeObjectURL(url); }
}
async function hostBlob(blob) {
  if (blob.size > 5 * 1024 * 1024) throw new Error("That picture is over 5 MB, even after shrinking. Try a smaller one.");
  const type = /^image\/(png|jpeg|gif|webp)$/.test(blob.type) ? blob.type : "image/jpeg";
  const ext = { "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[type] || "jpg";
  const r = sRef(getStorage(), `mkt_images/${Date.now()}_${uid()}.${ext}`);
  await uploadBytes(r, blob, { contentType: type, cacheControl: "public,max-age=31536000" });
  return getDownloadURL(r);
}
const remember = (bankId, url) => setDoc(doc(db, "mkt_bank_images", bankId), { url, at: serverTimestamp(), byUid: me() });

async function bankUrl(bankId) {
  const s = await getDoc(doc(db, "mkt_bank_images", bankId)).catch(() => null);
  if (s && s.exists() && safeUrl(s.data().url)) return s.data().url;
  showToast("Getting the picture ready for email…");
  const src = await bankImage(bankId);
  const blob = await shrink(await (await fetch(src)).blob());
  const url = await hostBlob(blob);
  await remember(bankId, url).catch((err) => console.warn("Picture link not remembered:", err));
  return url;
}
// { src, name, bankId } or null if cancelled
async function pickPicture(staff) {
  const img = await openImagePicker({ isAdmin: isAdminOf(staff) });
  if (!img) return null;
  return { src: await bankUrl(img.id), name: img.name || "", bankId: img.id };
}
async function uploadPicture(file) {
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) throw new Error("Choose a picture (JPG, PNG, GIF or WebP).");
  showToast("Uploading to the Image Bank…");
  let saved = null;
  try { saved = await bankUpload("", file); } catch (err) { throw new Error(bankError(err)); }
  const url = await hostBlob(await shrink(file));
  const bankId = (saved && saved.image && saved.image.id) || "";
  if (bankId) await remember(bankId, url).catch(() => {});
  return { src: url, name: (saved && saved.image && saved.image.name) || file.name, bankId };
}

let sspCache = null;
async function sspProducts() {
  if (!sspCache) {
    const snap = await getDocs(collection(db, "ssp_products"));
    sspCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.name && p.published !== false)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return sspCache;
}
// Published forms patients can fill in online (Form Builder → Form settings)
let formsCache = null;
async function loadOnlineForms() {
  if (!formsCache) {
    try {
      formsCache = (await listPublishedForms())
        .filter((t) => t.online && t.online.on === true && !["treatment", "prescription"].includes(t.category))
        .map((t) => ({ id: t.id, name: t.name }));
    } catch (err) { console.warn("Forms not loaded:", err); formsCache = []; }
  }
  return formsCache;
}

/* ===================== The list ===================== */

const thumb = (t) => `<div class="mt-thumb-in">${renderEmail(t)}</div>`;

// Also used by Form Builder's "New" button when Marketing emails is chosen
export function openNewTemplateDialog(staff) {
  const dlg = openDialog(`
    <form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>New marketing email</h3><p>Start from a design. You can change everything.</p></div>
      <label class="lh-field"><span class="lh-label">Name</span>
        <input name="name" maxlength="120" placeholder="October newsletter" autocomplete="off" /></label>
      <div class="mt-starters">${STARTERS.map((s, i) => `
        <label class="mt-starter">
          <input type="radio" name="starter" value="${s.key}"${i === 1 ? " checked" : ""} />
          <span class="mt-thumb">${thumb({ subject: s.subject, preview: s.preview, design: s.design() })}</span>
          <span><strong>${esc(s.name)}</strong><small>${esc(s.blurb)}</small></span>
        </label>`).join("")}</div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Create and edit</button>
      </div>
    </form>`, "mt-new-dlg");
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) { err.textContent = "Give the email a name."; err.hidden = false; form.elements.name.focus(); return; }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const id = await createTemplate({ name, starter: form.elements.starter.value }, staff);
      dlg.close();
      if (!/^#\/forms/.test(location.hash)) setBuilderBack(LIST_HREF); // from Form Builder, Back keeps going there
      location.hash = `${LIST_HREF}/${encodeURIComponent(id)}`;
    } catch (ex) {
      console.error("Create template failed:", ex);
      err.textContent = errText(ex, "Couldn't create it. Try again.");
      err.hidden = false;
      btn.disabled = false;
    }
  });
  form.elements.name.focus();
}

export function mountTemplateList(box, { staff = null } = {}) {
  box.innerHTML = `
    <div class="mk-tools">
      <input type="search" class="fe-input" data-role="q" placeholder="Search templates" aria-label="Search templates" />
      <span class="inv-spacer"></span>
      ${isAdminOf(staff) ? '<a class="ff-btn" href="#/image-bank">Image Bank</a>' : ""}
      <button type="button" class="ff-btn is-primary" data-act="new">+ New template</button>
    </div>
    <p class="muted mt-note">Also listed in Form Builder under Marketing emails. Pictures come from the Image Bank.</p>
    <div data-role="grid"><div class="skeleton" style="height:260px;border-radius:14px"></div></div>`;
  const grid = box.querySelector('[data-role="grid"]');
  const qEl = box.querySelector('[data-role="q"]');
  let list = [];

  async function load() {
    try { list = await listTemplates(); draw(); }
    catch (err) {
      console.error("Templates failed:", err);
      grid.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the templates."))}</div>`;
    }
  }
  function draw() {
    if (!box.isConnected) return;
    const q = qEl.value.trim().toLowerCase();
    const shown = list.filter((t) => !q || `${t.name} ${t.subject}`.toLowerCase().includes(q));
    if (!list.length) {
      grid.innerHTML = `<div class="tm-empty"><strong>Design your first email</strong><br>Start from a ready-made design, then make it yours.
        <div class="tm-empty-act"><button type="button" class="ff-btn is-primary" data-act="new">+ New template</button></div></div>`;
      return;
    }
    grid.innerHTML = shown.length ? `<div class="mt-grid">${shown.map((t) => `
      <article class="mt-card">
        <a class="mt-thumb" href="${LIST_HREF}/${encodeURIComponent(t.id)}" data-open aria-label="Edit ${esc(t.name)}">${thumb(t)}</a>
        <div class="mt-meta">
          <strong>${esc(t.name)}</strong>
          <small>${esc(t.subject || "No subject yet")}</small>
          <small>Edited ${esc(day(t.updatedAt))}${t.updatedBy ? ` · ${esc(t.updatedBy)}` : ""}</small>
        </div>
        <div class="mt-acts">
          <a class="lh-btn is-primary" href="${LIST_HREF}/${encodeURIComponent(t.id)}" data-open>Edit</a>
          <button type="button" class="lh-btn" data-dup="${esc(t.id)}">Duplicate</button>
          <button type="button" class="lh-btn is-quiet" data-del="${esc(t.id)}">Delete</button>
        </div>
      </article>`).join("")}</div>` : '<div class="tm-empty">No templates match.</div>';
  }

  box.addEventListener("click", async (e) => {
    if (e.target.closest("[data-open]")) { setBuilderBack(LIST_HREF); return; }
    if (e.target.closest('[data-act="new"]')) { openNewTemplateDialog(staff); return; }
    const dup = e.target.closest("[data-dup]");
    if (dup) {
      const t = list.find((x) => x.id === dup.dataset.dup);
      if (!t) return;
      dup.disabled = true;
      try { await createTemplate({ name: `Copy of ${t.name}`.slice(0, 120), from: t }, staff); showToast("Template duplicated"); load(); }
      catch (ex) { console.error(ex); showToast(errText(ex, "Couldn't duplicate it.")); dup.disabled = false; }
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const t = list.find((x) => x.id === del.dataset.del);
      if (!t) return;
      const ok = await confirmDialog({ title: `Delete "${t.name}"?`, message: "It's removed from the template list. Campaigns already sent keep their copy.",
        confirmLabel: "Delete", tone: "danger" });
      if (!ok) return;
      try { await archiveTemplate(t.id, staff); showToast("Template deleted"); load(); }
      catch (ex) { console.error(ex); showToast(errText(ex, "Couldn't delete it.")); }
    }
  });
  qEl.addEventListener("input", draw);
  load();
}

/* ===================== The builder ===================== */

const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
const setPath = (o, p, v) => {
  const ks = p.split(".");
  let x = o;
  for (let i = 0; i < ks.length - 1; i++) x = x[ks[i]];
  x[ks[ks.length - 1]] = v;
};

// Settings fields, in Form Builder's style. Every input has data-k = the path of what it changes.
const setting = (label, control, note = "") => `<label class="fe-insp-field"><span class="fe-insp-label">${label}</span>${control}${
  note ? `<small class="fe-note">${note}</small>` : ""}</label>`;
const fText = (k, label, v, ph = "", n = "") => setting(label,
  `<input class="fe-input" data-k="${k}" value="${esc(v ?? "")}" placeholder="${esc(ph)}" maxlength="500" autocomplete="off" />`, n);
const fArea = (k, label, v, ph = "") => setting(label,
  `<textarea class="fe-input" data-k="${k}" rows="3" maxlength="600" placeholder="${esc(ph)}">${esc(v ?? "")}</textarea>`);
const fRange = (k, label, v, min, max, unit) => setting(`${label} <b data-show="${k}">${v}${unit}</b>`,
  `<input type="range" class="fe-range" data-k="${k}" data-num data-out="${unit}" min="${min}" max="${max}" step="1" value="${v}" />`);
const fCheck = (k, label, v) => `<label class="fe-check"><input type="checkbox" data-k="${k}"${v ? " checked" : ""} /> ${label}</label>`;
const fSeg = (k, label, opts, v) => `<div class="fe-insp-field"><span class="fe-insp-label">${label}</span><div class="fe-seg" role="radiogroup">${opts.map(([val, l]) =>
  `<label class="fe-seg-btn"><input type="radio" name="seg-${k}" data-k="${k}" value="${val}"${val === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div></div>`;
const fAlign = (v, k = "align") => fSeg(k, "Align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]], v || "left");
const fColor = (k, label, v, fallback, canReset = true) => `<div class="fe-insp-field"><span class="fe-insp-label">${label}</span><div class="mb-row">
  <input type="color" class="mb-color" data-k="${k}" value="${esc(v || fallback)}" aria-label="${esc(label)}" />
  ${canReset ? (v ? `<button type="button" class="lh-btn is-quiet" data-reset="${k}">Use the default</button>` : '<small class="fe-note">Default</small>') : ""}</div></div>`;
const fImage = (k, label, v, n = "") => `<div class="fe-insp-field"><span class="fe-insp-label">${label}</span>
  ${safeUrl(v) ? `<div class="fe-img-pick"><span class="fe-img-thumb mb-thumb"><img src="${esc(v)}" alt="" /></span></div>` : ""}
  <div class="fe-img-btns">
    <button type="button" class="lh-btn" data-pick="${k}">${v ? "Change" : "Choose from Image Bank"}</button>
    ${v ? `<button type="button" class="lh-btn" data-crop="${k}">Crop</button>` : ""}
    <label class="lh-btn">Upload from computer<input type="file" data-upload="${k}" accept="image/png,image/jpeg,image/webp,image/gif" hidden /></label>
    ${v ? `<button type="button" class="lh-btn is-quiet" data-reset="${k}">Remove</button>` : ""}
  </div>
  <small class="fe-note">${n || "Uploads are saved into the Image Bank so you can reuse them."}</small></div>`;
// Rounded corners, circle and border (the whole block's pictures)
const fShape = (b, label = "Picture shape") => `<div class="fe-insp-field"><span class="fe-insp-label mb-colh">${label}</span></div>` +
  fRange("radius", "Rounded corners", Number(b.radius) || 0, 0, 48, "px") +
  fCheck("circle", "Circle (crop it to Square first)", b.circle) +
  fRange("border", "Border", Number(b.border) || 0, 0, 8, "px") +
  fColor("borderColor", "Border colour", b.borderColor, "#e2e8f0", false);
// Where a button goes: a web page, or a form for the patient to fill in
const fLink = (p, it) => fSeg(`${p}link`, "Button opens", [["url", "A web page"], ["form", "A form to fill in"]], it.link === "form" ? "form" : "url") +
  (it.link === "form"
    ? setting("Form", `<select class="fb-select" data-k="${p}formId"><option value="">${
        formsCache ? (formsCache.length ? "Choose a form…" : "No forms are set up for online filling yet") : "Loading forms…"}</option>${
        (formsCache || []).map((x) => `<option value="${esc(x.id)}"${x.id === it.formId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}${
        it.formId && formsCache && !formsCache.some((x) => x.id === it.formId)
          ? `<option value="${esc(it.formId)}" selected>${esc(it.formName || "This form")} (not online any more)</option>` : ""}</select>`,
        "Each patient gets their own link, with their details already filled in. To list a form here, tick “Patients can fill this in online” in its Form settings.")
    : fText(`${p}href`, "Link", it.href, "https://"));
const fRich = (k, label) => `<div class="fe-insp-field"><span class="fe-insp-label">${label}</span><div data-rt="${k}"></div></div>`;
const tagChips = () => `<div class="fe-insp-field"><span class="fe-insp-label">Insert a tag</span>
  <div class="fe-chiprow">${MERGE_TAGS.map(([tag, help]) =>
    `<button type="button" class="fe-ins is-field" data-taginsert="${esc(tag)}" title="${esc(help)}">${esc(tag)}</button>`).join("")}</div>
  <small class="fe-note">Click in a box first, then a tag. It's filled in with each patient's details when the email is sent.</small></div>`;

  // Puts text where the cursor is in a code box, as if it was typed
function insertText(ta, text) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.focus();
  ta.setSelectionRange(s + text.length, s + text.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}
const htmlNotes = (b) => {
  const n = customNotes(b.code, b.pad !== false);
  return n.length ? `<ul class="mb-htmlnotes">${n.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : '<p class="mb-htmlok">Looks email-safe.</p>';
};
const picTag = (p) => `<img src="${esc(p.src)}" alt="${esc(String(p.name || "").replace(/\.[^.]+$/, ""))}" width="536" ` +
  'style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:8px;">\n';
const pieceOptions = () => CUSTOM_PIECES.map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(([k, l]) =>
  `<option value="${esc(k)}">${esc(l)}</option>`).join("")}</optgroup>`).join("");

export async function mountTemplateBuilder(container, { id, staff = null } = {}) {
  const backHref = builderBack();
  const backLink = `<a class="back-link" href="${esc(backHref)}">← ${backHref === "#/forms" ? "Form Builder"
    : /\/campaigns\//.test(backHref) ? "Campaign" : "Email templates"}</a>`;
  container.innerHTML = `<section class="page wide">${backLink}<div class="skeleton" style="height:420px;border-radius:14px"></div></section>`;
  let t;
  try { t = await getTemplate(id); }
  catch (err) {
    console.error("Template failed:", err);
    container.innerHTML = `<section class="page">${backLink}<div class="state error"><strong>Couldn't open this email</strong>${esc(errText(err, "Try again."))}</div></section>`;
    return;
  }
  if (!t || t.status === "archived") {
    container.innerHTML = `<section class="page">${backLink}<div class="state"><strong>This email has been deleted</strong>Go back to the list to choose another.</div></section>`;
    return;
  }

  const root = document.createElement("section");
  root.className = "page wide mb";
  root.innerHTML = `
    ${backLink}
    <div class="fe-top-sentinel" aria-hidden="true"></div>
    <div class="fe-top">
      <div class="fe-top-main">
        <input class="fe-name" data-role="name" maxlength="120" aria-label="Email name" value="${esc(t.name)}" />
        <div class="fe-sub"><span>Marketing email</span><span class="fe-state is-saved" data-role="state">All changes saved</span></div>
      </div>
      <div class="fe-top-actions">
        <div class="pt-tabs fe-modes" role="group" aria-label="Preview size">
          <button type="button" data-dev="desktop" class="active">Desktop</button>
          <button type="button" data-dev="mobile">Mobile</button>
        </div>
        <button type="button" class="btn-ghost" data-act="dup" title="Make a copy of this email">Duplicate</button>
        <button type="button" class="btn-ghost fe-savenow" data-act="save" data-role="savenow" disabled>Saved</button>
        <button type="button" class="btn-primary" data-act="test">Send a test</button>
      </div>
    </div>
    <div class="fe-shell is-build mb-shell">
      <aside class="fe-palette" data-role="pal" aria-label="Add a block">
        <input type="search" class="fe-input fe-pal-search" data-role="palsearch" placeholder="Search blocks" aria-label="Search blocks" />
        <p class="fe-pal-hint">Click to add, or drag onto the email</p>
        ${PAL.map(([g, keys]) => `<div class="fe-pal-group" data-group><div class="fe-pal-title">${esc(g)}</div>${keys.map((k) =>
          `<button type="button" class="fe-pal-item" draggable="true" data-add="${k}" data-find="${esc(BLOCKS[k].label.toLowerCase())}">${ICONS[k]}<span>${esc(BLOCKS[k].label)}</span></button>`).join("")}</div>`).join("")}
        <p class="fe-pal-none" data-role="palnone" hidden>No blocks match that search.</p>
      </aside>
      <div class="fe-stage mb-stage" data-role="stage">
        <button type="button" class="mb-inbox" data-role="inbox" title="Change the subject and preview text"></button>
        <div class="mb-mail" data-role="canvas"></div>
      </div>
      <aside class="fe-inspector" data-role="side" aria-label="Settings"></aside>
    </div>`;
  container.replaceChildren(root);
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const canvas = $("canvas");
  const side = $("side");
  const stage = $("stage");
  const stateEl = $("state");
  const saveNow = $("savenow");

  let sel = null;
  let mobile = false;
  let dirty = false;
  let timer = 0;
  let raf = 0;
  let savingP = null;
  let tagTarget = null;
  const blocks = () => t.design.blocks;
  const selBlock = () => blocks().find((b) => b.id === sel) || null;
  const target = () => selBlock() || t;

  /* ---------- Saving: automatic, a moment after each change ---------- */
  function setState(s, msg = "") {
    stateEl.className = `fe-state is-${s}`;
    stateEl.textContent = s === "saving" ? "Saving…" : s === "dirty" ? "Unsaved changes" : s === "error" ? msg : "All changes saved";
    saveNow.disabled = s === "saved" || s === "saving";
    saveNow.textContent = s === "saving" ? "Saving…" : s === "saved" ? "Saved" : "Save";
  }
  async function save() {
    clearTimeout(timer);
    if (savingP) await savingP;
    if (!dirty) return true;
    dirty = false;
    setState("saving");
    savingP = saveTemplate(t, staff)
      .then(() => { setState(dirty ? "dirty" : "saved"); return true; })
      .catch((err) => {
        console.error("Save template failed:", err);
        dirty = true;
        setState("error", err && err.code === "permission-denied" ? "Not saved: no access" : "Not saved. Check your connection.");
        return false;
      })
      .finally(() => { savingP = null; });
    return savingP;
  }
  function touch() {
    dirty = true;
    setState("dirty");
    clearTimeout(timer);
    timer = setTimeout(save, 1200);
  }
  const onUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("hashchange", () => { window.removeEventListener("beforeunload", onUnload); if (dirty) save(); }, { once: true });

  /* ---------- The email ---------- */
  function checksHtml() {
    const p = checkDesign(t);
    return p.length
      ? `<div class="mb-checks" data-role="checks"><strong>Before sending</strong><ul>${p.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
      : '<div class="mb-checks is-ok" data-role="checks">Ready to send. Send yourself a test first.</div>';
  }
  function drawCanvas() {
    raf = 0;
    const st = styleOf(t.design);
    stage.style.background = st.bg;
    $("inbox").innerHTML = `<small>Dermedica Clinic</small><b>${esc(t.subject || "No subject yet")}</b><span>${esc(t.preview || "No preview text")}</span>`;
    canvas.className = `mb-mail${mobile ? " is-mobile" : ""}`;
    canvas.style.background = st.body;
    const list = blocks();
    canvas.innerHTML = (list.length ? list.map((b, i) => `
      <div class="mb-blk${b.id === sel ? " is-sel" : ""}" data-blk="${esc(b.id)}" draggable="true" tabindex="0" role="button" aria-label="${esc(BLOCKS[b.type].label)}: click to change">
        <span class="mb-tag">${esc(BLOCKS[b.type].label)}</span>
        <div class="mb-tools">
          <button type="button" data-tool="up" aria-label="Move up" title="Move up"${i ? "" : " disabled"}>${ICONS.up}</button>
          <button type="button" data-tool="down" aria-label="Move down" title="Move down"${i < list.length - 1 ? "" : " disabled"}>${ICONS.down}</button>
          <button type="button" data-tool="copy" aria-label="Duplicate" title="Duplicate">${ICONS.copy}</button>
          <button type="button" data-tool="del" aria-label="Delete" title="Delete">${ICONS.trash}</button>
        </div>
        ${blockHtml(b, st, true)}
      </div>`).join("") : '<div class="mb-empty">Add a block from the left, or drag one here.</div>') +
      `<div class="mb-foot" title="Added automatically to every marketing email">${footerPreview()}</div>`;
    const ch = side.querySelector('[data-role="checks"]');
    if (ch) ch.outerHTML = checksHtml();
  }
  const drawSoon = () => { if (!raf) raf = requestAnimationFrame(drawCanvas); };
  const changed = () => { drawSoon(); touch(); };

  /* ---------- Settings ---------- */
  function emailForm() {
    const st = styleOf(t.design);
    return `
      <div class="fe-insp-head">${ICONS.mail}<span>Email settings</span></div>
      ${fText("subject", "Subject", t.subject, "What's new at Dermedica")}
      ${fText("preview", "Preview text", t.preview, "News, tips and something new for your skin", "Shown after the subject in most inboxes.")}
      ${tagChips()}
      <div class="fe-two">${fColor("design.style.bg", "Page background", st.bg, st.bg, false)}${fColor("design.style.body", "Email background", st.body, st.body, false)}</div>
      <div class="fe-two">${fColor("design.style.text", "Text", st.text, st.text, false)}${fColor("design.style.accent", "Buttons and links", st.accent, st.accent, false)}</div>
      ${setting("Font", `<select class="fb-select" data-k="design.style.font">${FONTS.map(([f, l]) =>
        `<option value="${esc(f)}"${f === st.font ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`)}
      <div class="fe-insp-field"><span class="fe-insp-label">Checks</span>${checksHtml()}</div>
      <p class="fe-note fe-pad">Every marketing email ends with the clinic's details and an Unsubscribe link. It's added automatically.
        Click a block in the email to change it.</p>`;
  }

  function blockForm(b) {
    const st = styleOf(t.design);
    switch (b.type) {
      case "header": return fImage("logo", "Logo", b.logo, "Leave empty to show the clinic name as text.") +
        (safeUrl(b.logo) ? fRange("logoWidth", "Logo width", b.logoWidth, 60, 400, "px") : fText("text", "Clinic name", b.text)) +
        fAlign(b.align) + fColor("bg", "Background", b.bg, st.body);
      case "heading": return fArea("text", "Heading", b.text) + tagChips() +
        fSeg("size", "Size", [["large", "Large"], ["medium", "Medium"], ["small", "Small"]], b.size) + fAlign(b.align);
      case "text": return fRich("html", "Text") + tagChips() + fAlign(b.align);
      case "quote": return fArea("text", "Quote", b.text) + fText("name", "Who said it (optional)", b.name, "Sarah, patient") +
        tagChips() + fColor("bg", "Background", b.bg, "#f8fafc") + fAlign(b.align);
      case "image": return fImage("src", "Picture", b.src, "Wide pictures look best. Crop to change the shape.") +
        fText("alt", "Describe the picture", b.alt, "", "Read out by screen readers, and shown if pictures are blocked.") +
        fText("caption", "Caption (optional)", b.caption, "Shown under the picture") +
        fText("href", "Link (optional)", b.href, "https://") +
        fCheck("edge", "Edge to edge (no side margins)", b.edge) +
        (b.edge ? "" : fRange("width", "Width", b.width, 20, 100, "%") + fAlign(b.align) + fShape(b));
      case "imagetext": return fImage("src", "Picture", b.src) +
        fText("alt", "Describe the picture", b.alt) +
        fSeg("side", "Picture on the", [["left", "Left"], ["right", "Right"]], b.side) + fShape(b) +
        fText("title", "Title", b.title) + fRich("html", "Text") +
        fText("label", "Button text (optional)", b.label) + fText("btnHref", "Button link", b.btnHref, "https://") +
        fText("href", "Picture link (optional)", b.href, "https://") + tagChips() +
        '<p class="fe-note fe-pad">On phones the text goes under the picture.</p>';
      case "button": return fText("label", "Button text", b.label) + tagChips() + fLink("", b) +
        `<div class="fe-two">${fColor("bg", "Button colour", b.bg, st.accent)}${fColor("color", "Text colour", b.color, "#ffffff")}</div>` +
        fAlign(b.align) + fCheck("full", "Full width", b.full);
      case "buttons": return b.items.map((it, i) => `<div class="fe-insp-field mb-subhead"><span class="fe-insp-label mb-colh">Button ${i + 1}</span>${
          b.items.length > 1 ? `<button type="button" class="lh-btn is-quiet" data-btn-del="${i}">Remove</button>` : ""}</div>` +
          fText(`items.${i}.label`, "Text", it.label) + fLink(`items.${i}.`, it) +
          fSeg(`items.${i}.style`, "Style", [["filled", "Filled"], ["outline", "Outline"]], it.style)).join("") +
        (b.items.length < 3 ? '<button type="button" class="lh-btn mb-addbtn" data-act="btn-add">+ Add a button</button>' : "") +
        tagChips() +
        `<div class="fe-two">${fColor("bg", "Button colour", b.bg, st.accent)}${fColor("color", "Text colour", b.color, "#ffffff")}</div>` +
        fAlign(b.align) + fCheck("same", "Make them the same width", b.same) +
        '<p class="fe-note fe-pad">On phones they go one under the other if there isn\'t room side by side.</p>';
      case "product": return setting("Fill in from the Skin Script catalogue",
          `<select class="fb-select" data-act="catalogue"><option value="">${sspCache ? "Choose a product…" : "Loading the catalogue…"}</option>${
            (sspCache || []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.size ? ` · ${esc(p.size)}` : ""}</option>`).join("")}</select>`) +
        fImage("src", "Picture", b.src) + fShape(b) + fText("name", "Name", b.name) + fText("price", "Price (optional)", b.price, "$89") +
        fArea("desc", "Description", b.desc) + fText("label", "Button text (optional)", b.label) + fText("href", "Link", b.href, "https://");
      case "columns": return [0, 1].map((i) => `<div class="fe-insp-field"><span class="fe-insp-label mb-colh">${i ? "Right" : "Left"} column</span></div>` +
        fImage(`items.${i}.src`, "Picture (optional)", b.items[i].src) + fText(`items.${i}.title`, "Title", b.items[i].title) +
        fRich(`items.${i}.html`, "Text") + fText(`items.${i}.label`, "Button text (optional)", b.items[i].label) +
        fText(`items.${i}.href`, "Button link", b.items[i].href, "https://")).join("") + tagChips() +
        fShape(b, "Picture shape (both columns)") +
        '<p class="fe-note fe-pad">On phones the right column goes under the left one.</p>';
      case "offer": return fText("title", "Headline", b.title, "20% off") + fArea("text", "Details", b.text, "Your next skin treatment") +
        fText("code", "Code (optional)", b.code, "GLOW20") + fText("note", "Small print (optional)", b.note, "Ends 31 October") +
        tagChips() + fColor("bg", "Background", b.bg, "#f0fdfa");
      case "divider": return fColor("color", "Line colour", b.color, "#e2e8f0", false);
      case "spacer": return fRange("size", "Height", b.size, 4, 120, "px");
      case "html": return fCheck("pad", "Side margins (turn off for designs 600px wide)", b.pad !== false) +
        `<div class="fe-insp-field"><span class="fe-insp-label">HTML</span>
          <textarea class="fe-input mb-code" data-k="code" rows="12" spellcheck="false" aria-label="HTML">${esc(b.code)}</textarea>
          <div class="mb-row mb-code-acts">
            <button type="button" class="lh-btn is-primary" data-act="html-big">Open the big editor</button>
            <select class="fb-select" data-act="snip" aria-label="Add a piece"><option value="">Add a piece…</option>${pieceOptions()}</select>
          </div></div>` +
        tagChips() + `<div class="fe-insp-field"><span class="fe-insp-label">Checks</span><div data-role="htmlnotes">${htmlNotes(b)}</div></div>`;
      case "social": return fText("facebook", "Facebook", b.facebook, "https://facebook.com/…") +
        fText("instagram", "Instagram", b.instagram, "https://instagram.com/…") + fText("tiktok", "TikTok", b.tiktok, "https://tiktok.com/@…") +
        fText("website", "Website", b.website, "https://dermedica.com.au") + fAlign(b.align) +
        '<p class="fe-note fe-pad">Leave a box empty to leave that link out.</p>';
    }
    return "";
  }
    // Form Builder's text editor in the settings panel (Text blocks and the two columns)
  function mountEditors() {
    side.querySelectorAll("[data-rt]").forEach((host) => {
      const key = host.dataset.rt;
      const tgt = target();
      const ed = createRichEditor(host, {
        button: false,
        accent: () => styleOf(t.design).accent,
        onInput: () => { setPath(tgt, key, ed.getHtml()); changed(); },
      });
      ed.setHtml(getPath(tgt, key) || "");
    });
  }

  function drawSide() {
    tagTarget = null;
    const b = selBlock();
    if (!b) { side.innerHTML = emailForm(); return; }
    side.innerHTML = `<div class="fe-insp-head">${ICONS[b.type]}<span>${esc(BLOCKS[b.type].label)}</span></div>${blockForm(b)}
      <div class="mb-side-acts"><button type="button" class="lh-btn" data-act="done">Done</button>
        <button type="button" class="fe-remove" data-act="remove">${ICONS.trash}Remove</button></div>`;
    mountEditors();
    if ((b.type === "button" || b.type === "buttons") && !formsCache) {
      loadOnlineForms().then(() => { if (sel === b.id) drawSide(); });
    }
    if (b.type === "product" && !sspCache) {
      sspProducts().then(() => { if (sel === b.id) drawSide(); }).catch((err) => console.warn("Catalogue not loaded:", err));
    }
  }
  const select = (bid) => { if (sel === bid) return; sel = bid; drawCanvas(); drawSide(); };
  // A new picture forgets the old crop, and remembers its Image Bank original (for cropping later)
  const setPicture = (tgt, key, p) => {
    setPath(tgt, key, p.src);
    setPath(tgt, `${key}Bank`, p.bankId || "");
    setPath(tgt, `${key}Crop`, null);
    if (key === "src" && !tgt.alt) tgt.alt = String(p.name || "").replace(/\.[^.]+$/, "");
  };

  // Crops from the original (the Image Bank picture), so cropping again never loses quality
  async function cropPicture(tgt, key, btn) {
    const bankId = getPath(tgt, `${key}Bank`);
    btn.disabled = true;
    let blob;
    try {
      const from = bankId ? await bankImage(bankId) : getPath(tgt, key);
      blob = await (await fetch(from)).blob();
    } catch (err) {
      console.error("Picture for cropping failed:", err);
      showToast("Couldn't load this picture to crop. Choose it again from the Image Bank, then crop it.");
      if (btn.isConnected) btn.disabled = false;
      return;
    }
    if (btn.isConnected) btn.disabled = false;
    let out;
    try { out = await openCropper(blob, getPath(tgt, `${key}Crop`)); }
    catch (err) { showToast(err.message); return; }
    if (!out) return;
    try {
      showToast("Saving the cropped picture…");
      setPath(tgt, key, await hostBlob(out.blob));
      setPath(tgt, `${key}Crop`, out.state);
      drawSide();
      changed();
      showToast("Picture cropped");
    } catch (err) {
      console.error("Cropped picture not saved:", err);
      showToast(errText(err, "Couldn't save the cropped picture."));
    }
  }
  /* ---------- Custom HTML ---------- */
  const pieceCode = (key) => {
    for (const [, list] of CUSTOM_PIECES) {
      const p = list.find((x) => x[0] === key);
      if (p) return p[2](styleOf(t.design)) + "\n";
    }
    return "";
  };
  const drawHtmlNotes = () => {
    const box = side.querySelector('[data-role="htmlnotes"]');
    const b = selBlock();
    if (box && b && b.type === "html") box.innerHTML = htmlNotes(b);
  };
  // The block on its own, in the email's colours, kept apart from the portal's styles
  const previewDoc = (b) => {
    const st = styleOf(t.design);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
      `<body style="margin:0;padding:16px 8px;background:${st.bg};">` +
      `<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
      `style="width:100%;max-width:600px;margin:0 auto;background:${st.body};border-radius:12px;"><tr><td style="padding:0;">` +
      `${blockHtml(b, st, true)}</td></tr></table></body></html>`;
  };

  function openHtmlEditor(b) {
    const orig = b.code;
    const st = styleOf(t.design);
    const dlg = openDialog(`
      <div class="ch-wrap">
        <div class="ch-head">
          <div><h3>Custom HTML</h3><p class="muted">Changes save as you type. Pieces go in where your cursor is.</p></div>
          <div class="ch-head-acts">
            <label class="lh-btn">Open an .html file<input type="file" data-ch="file" accept=".html,.htm,text/html" hidden /></label>
            <button type="button" class="lh-btn is-quiet" data-ch="undo">Undo my changes</button>
            <button type="button" class="lh-btn is-primary" data-ch="done">Done</button>
          </div>
        </div>
        <div class="ch-pal">
          ${CUSTOM_PIECES.map(([g, list]) => `<div class="ch-pal-row"><span>${esc(g)}</span>${list.map(([k, l]) =>
            `<button type="button" class="ch-chip" data-piece="${esc(k)}">${esc(l)}</button>`).join("")}</div>`).join("")}
          <div class="ch-pal-row"><span>Insert</span>
            <button type="button" class="ch-chip" data-ch="pic">Picture from Image Bank</button>
            <label class="ch-chip">Upload a picture<input type="file" data-ch="upload" accept="image/png,image/jpeg,image/webp,image/gif" hidden /></label>
            ${[["accent", "Accent"], ["text", "Text"], ["body", "Email background"], ["bg", "Page background"]].map(([k, l]) =>
              `<button type="button" class="ch-chip ch-sw" data-color="${esc(st[k])}" title="Insert ${esc(st[k])}"><i style="background:${esc(st[k])}"></i>${esc(l)}</button>`).join("")}
            ${MERGE_TAGS.map(([tag, help]) => `<button type="button" class="ch-chip is-tag" data-tag="${esc(tag)}" title="${esc(help)}">${esc(tag)}</button>`).join("")}
          </div>
        </div>
        <div class="ch-split">
          <textarea class="ch-code" spellcheck="false" aria-label="HTML"></textarea>
          <div class="ch-prev">
            <div class="pt-tabs ch-dev" role="group" aria-label="Preview size">
              <button type="button" class="active" data-chdev="desktop">Desktop</button>
              <button type="button" data-chdev="mobile">Mobile</button>
            </div>
            <iframe class="ch-frame" sandbox="" title="Preview"></iframe>
          </div>
        </div>
        <div class="ch-notes" data-role="chnotes"></div>
      </div>`, "ch-dlg");
    const ta = dlg.querySelector(".ch-code");
    const frame = dlg.querySelector(".ch-frame");
    const notes = dlg.querySelector('[data-role="chnotes"]');
    let pt = 0;
    const preview = () => { frame.srcdoc = previewDoc(b); notes.innerHTML = htmlNotes(b); };
    const update = () => { b.code = ta.value; changed(); clearTimeout(pt); pt = setTimeout(preview, 300); };
    ta.value = b.code || "";
    ta.addEventListener("input", update);
    ta.addEventListener("keydown", (e) => { if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); insertText(ta, "  "); } });
    dlg.addEventListener("mousedown", (e) => { if (e.target.closest("[data-piece], [data-color], [data-tag]")) e.preventDefault(); });

    dlg.addEventListener("click", async (e) => {
      const pc = e.target.closest("[data-piece]");
      if (pc) { insertText(ta, pieceCode(pc.dataset.piece)); return; }
      const c = e.target.closest("[data-color]");
      if (c) { insertText(ta, c.dataset.color); return; }
      const tg = e.target.closest("[data-tag]");
      if (tg) { insertText(ta, tg.dataset.tag); return; }
      const dv = e.target.closest("[data-chdev]");
      if (dv) {
        frame.classList.toggle("is-mobile", dv.dataset.chdev === "mobile");
        dlg.querySelectorAll("[data-chdev]").forEach((x) => x.classList.toggle("active", x === dv));
        return;
      }
      const act = e.target.closest("button[data-ch]");
      if (!act) return;
      if (act.dataset.ch === "done") { dlg.close(); return; }
      if (act.dataset.ch === "undo") {
        if (ta.value === orig) return;
        if (!(await confirmDialog({ title: "Undo your changes?", message: "The HTML goes back to how it was when you opened this editor.",
          confirmLabel: "Undo changes", tone: "warning" }))) return;
        ta.value = orig;
        update();
        return;
      }
      if (act.dataset.ch === "pic") {
        act.disabled = true;
        try { const p = await pickPicture(staff); if (p) insertText(ta, picTag(p)); }
        catch (err) { console.error("Picture failed:", err); showToast(errText(err, "Couldn't use that picture.")); }
        finally { act.disabled = false; }
      }
    });

    dlg.addEventListener("change", async (e) => {
      const el = e.target;
      const f = el.files && el.files[0];
      if (!f) return;
      el.value = "";
      if (el.dataset.ch === "upload") {
        try { insertText(ta, picTag(await uploadPicture(f))); showToast("Picture added"); }
        catch (err) { console.error("Upload failed:", err); showToast(errText(err, "Couldn't upload that picture.")); }
        return;
      }
      if (el.dataset.ch === "file") {
        if (f.size > 1024 * 1024) { showToast("That file is over 1 MB. Its pictures need to be links, not embedded."); return; }
        const text = await f.text();
        if (ta.value.trim() && !(await confirmDialog({ title: "Replace the HTML?",
          message: `What's in this block now is replaced by ${f.name}.`, confirmLabel: "Replace", tone: "warning" }))) return;
        ta.value = text;
        if (b.pad !== false && /width\s*[:=]\s*["']?6\d\d/i.test(text)) {
          b.pad = false;
          showToast("Side margins turned off, so the 600px design fits.");
        }
        update();
      }
    });

    dlg.addEventListener("close", () => { clearTimeout(pt); b.code = ta.value; drawCanvas(); drawSide(); });
    preview();
    ta.focus();
  }

  /* ---------- Blocks: add, move, copy, delete ---------- */
  function insertBlock(type, at) {
    const nb = newBlock(type);
    const list = blocks();
    let i = at;
    if (i === undefined || i === null) { const s = list.findIndex((x) => x.id === sel); i = s < 0 ? list.length : s + 1; }
    list.splice(Math.max(0, Math.min(i, list.length)), 0, nb);
    sel = nb.id;
    drawCanvas();
    drawSide();
    touch();
    requestAnimationFrame(() => {
      const el = canvas.querySelector(`[data-blk="${CSS.escape(nb.id)}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }
  function blockTool(k, bid) {
    const list = blocks();
    const i = list.findIndex((b) => b.id === bid);
    if (i < 0) return;
    if (k === "up" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (k === "down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else if (k === "copy") { const c = JSON.parse(JSON.stringify(list[i])); c.id = uid(); list.splice(i + 1, 0, c); sel = c.id; }
    else if (k === "del") { list.splice(i, 1); if (sel === bid) sel = null; }
    else return;
    drawCanvas();
    drawSide();
    touch();
  }

  /* ---------- Events ---------- */
  root.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) { insertBlock(add.dataset.add); return; }
    const dev = e.target.closest("[data-dev]");
    if (dev) {
      mobile = dev.dataset.dev === "mobile";
      root.querySelectorAll("[data-dev]").forEach((x) => x.classList.toggle("active", x === dev));
      drawCanvas();
      return;
    }
    if (e.target.closest('.fe-top [data-act="save"]')) { dirty = true; save().then((ok) => ok && showToast("Saved")); return; }
    if (e.target.closest('.fe-top [data-act="test"]')) { sendTest(); return; }
    if (e.target.closest('.fe-top [data-act="dup"]')) {
      save().then(() => createTemplate({ name: `Copy of ${t.name}`.slice(0, 120), from: t }, staff))
        .then((nid) => { showToast("Copy made. You're now editing it."); location.hash = `${LIST_HREF}/${encodeURIComponent(nid)}`; })
        .catch((err) => showToast(errText(err, "Couldn't duplicate it.")));
    }
  });

  $("palsearch").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    let any = false;
    root.querySelectorAll("[data-group]").forEach((g) => {
      let n = 0;
      g.querySelectorAll("[data-add]").forEach((b) => { const hit = !q || b.dataset.find.includes(q); b.hidden = !hit; if (hit) n++; });
      g.hidden = !n;
      if (n) any = true;
    });
    $("palnone").hidden = any;
  });

  canvas.addEventListener("click", (e) => {
    if (e.target.closest("a")) e.preventDefault();
    const blk = e.target.closest("[data-blk]");
    if (!blk) return;
    const tool = e.target.closest("[data-tool]");
    if (tool) blockTool(tool.dataset.tool, blk.dataset.blk);
    else select(blk.dataset.blk);
  });
  canvas.addEventListener("keydown", (e) => {
    const blk = e.target.closest("[data-blk]");
    if (blk && e.target === blk && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(blk.dataset.blk); }
  });
  stage.addEventListener("click", (e) => {
    if (e.target.closest("[data-blk]")) return;
    if (sel) { sel = null; drawCanvas(); drawSide(); }
    if (e.target.closest('[data-role="inbox"]')) { const s = side.querySelector('[data-k="subject"]'); if (s) s.focus(); }
  });

  side.addEventListener("input", (e) => {
    if (e.target.closest(".re")) return; // the text editor saves itself
    const el = e.target;
    const k = el.dataset.k;
    if (!k || el.type === "checkbox" || el.type === "radio" || el.tagName === "SELECT" || el.type === "file") return;
    setPath(target(), k, el.dataset.num !== undefined ? Number(el.value) : el.value);
    if (el.dataset.out !== undefined) {
      const out = side.querySelector(`[data-show="${CSS.escape(k)}"]`);
      if (out) out.textContent = el.value + el.dataset.out;
    }
    changed();
    if (k === "code") drawHtmlNotes();
  });
  // Tab in a code box makes a space instead of moving on (Shift+Tab still moves on)
  side.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && e.target.matches("textarea.mb-code")) { e.preventDefault(); insertText(e.target, "  "); }
  });
  side.addEventListener("change", (e) => {
    if (e.target.closest(".re")) return;
    const el = e.target;
    if (el.matches("[data-upload]")) {
      const f = el.files && el.files[0];
      el.value = "";
      if (!f) return;
      const tgt = target();
      const key = el.dataset.upload;
      uploadPicture(f)
        .then((p) => { setPicture(tgt, key, p); drawSide(); changed(); showToast("Picture added"); })
        .catch((err) => { console.error("Upload failed:", err); showToast(errText(err, "Couldn't upload that picture.")); });
      return;
    }
    if (el.matches('[data-act="catalogue"]')) {
      const p = (sspCache || []).find((x) => x.id === el.value);
      const b = selBlock();
      if (!p || !b) return;
      const price = String(p.price || "").trim();
      Object.assign(b, {
        name: String(p.name || ""), price: price ? (/^\$/.test(price) ? price : `$${price}`) : "",
        desc: String(p.details || "").replace(/\s+/g, " ").trim().slice(0, 240), href: safeUrl(p.shopLink) || b.href,
      });
      drawSide();
      changed();
      return;
    }
    if (el.matches('[data-act="snip"]')) {
      const code = pieceCode(el.value);
      el.value = "";
      const ta = side.querySelector('textarea[data-k="code"]');
      if (ta && code) insertText(ta, code);
      return;
    }
    const k = el.dataset.k;
    if (!k) return;
    if (el.type === "checkbox") setPath(target(), k, el.checked);
    else if (el.type === "radio" || el.tagName === "SELECT") {
      setPath(target(), k, el.value);
      if (/formId$/.test(k)) {
        const fm = (formsCache || []).find((x) => x.id === el.value);
        setPath(target(), k.replace(/formId$/, "formName"), fm ? fm.name : "");
      }
    }
    else return;
    drawSide();
    changed();
  });

  // Insert a tag: into the box last typed in (a plain box, or the text editor)
  side.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el.isContentEditable || (el.matches && el.matches("input.fe-input[data-k], textarea.fe-input[data-k]"))) tagTarget = el;
  });
  side.addEventListener("mousedown", (e) => { if (e.target.closest("[data-taginsert]")) e.preventDefault(); });
  side.addEventListener("click", (e) => {
    if (e.target.closest(".re")) return;
    const ti = e.target.closest("[data-taginsert]");
    if (ti) {
      const tok = ti.dataset.taginsert;
      const el = tagTarget && tagTarget.isConnected ? tagTarget : null;
      if (!el) { showToast("Click in a box first, then choose a tag."); return; }
      el.focus();
      if (el.isContentEditable) { document.execCommand("insertText", false, tok); return; } // the editor saves it like typing
      const s = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? s;
      el.value = el.value.slice(0, s) + tok + el.value.slice(end);
      el.setSelectionRange(s + tok.length, s + tok.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (e.target.closest('[data-act="html-big"]')) { const b = selBlock(); if (b) openHtmlEditor(b); return; }
    const cr = e.target.closest("[data-crop]");
    if (cr) { cropPicture(target(), cr.dataset.crop, cr); return; }
    if (e.target.closest('[data-act="btn-add"]')) {
      const b = selBlock();
      if (b && b.items.length < 3) { b.items.push({ label: "Button", href: "", style: "filled", link: "url", formId: "", formName: "" }); drawSide(); changed(); }
      return;
    }
    const bd = e.target.closest("[data-btn-del]");
    if (bd) {
      const b = selBlock();
      if (b && b.items.length > 1) { b.items.splice(Number(bd.dataset.btnDel), 1); drawSide(); changed(); }
      return;
    }
    
    if (e.target.closest('[data-act="done"]')) { sel = null; drawCanvas(); drawSide(); return; }
    if (e.target.closest('[data-act="remove"]')) { if (sel) blockTool("del", sel); return; }
    const reset = e.target.closest("[data-reset]");
    if (reset) { setPath(target(), reset.dataset.reset, ""); drawSide(); changed(); return; }
    const pk = e.target.closest("[data-pick]");
    if (pk) {
      const tgt = target();
      const key = pk.dataset.pick;
      pk.disabled = true;
      pickPicture(staff)
        .then((p) => {
          if (!p) return;
          setPicture(tgt, key, p);
          drawSide();
          changed();
        })
        .catch((err) => { console.error("Picture failed:", err); showToast(errText(err, "Couldn't use that picture.")); })
        .finally(() => { if (pk.isConnected) pk.disabled = false; });
    }
  });

  $("name").addEventListener("input", (e) => { t.name = e.target.value; touch(); });

  /* ---------- Drag and drop, like Form Builder ---------- */
  let drag = null;
  let dropAt = null;
  const clearLine = () => canvas.querySelectorAll(".is-drop-before, .is-drop-after").forEach((x) => x.classList.remove("is-drop-before", "is-drop-after"));
  const endDrag = () => { drag = null; dropAt = null; clearLine(); };
  root.addEventListener("dragstart", (e) => {
    const p = e.target.closest("[data-add]");
    const b = e.target.closest(".mb-blk[data-blk]");
    if (p) drag = { type: p.dataset.add };
    else if (b) drag = { id: b.dataset.blk };
    else return;
    e.dataTransfer.effectAllowed = drag.type ? "copy" : "move";
    e.dataTransfer.setData("text/plain", drag.type || drag.id);
  });
  canvas.addEventListener("dragover", (e) => {
    if (!drag) return;
    e.preventDefault();
    const items = [...canvas.querySelectorAll(".mb-blk")];
    let i = items.length;
    for (let k = 0; k < items.length; k++) {
      const r = items[k].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { i = k; break; }
    }
    if (i === dropAt) return;
    dropAt = i;
    clearLine();
    if (items[i]) items[i].classList.add("is-drop-before");
    else if (items.length) items[items.length - 1].classList.add("is-drop-after");
  });
  canvas.addEventListener("drop", (e) => {
    if (!drag || dropAt === null) return;
    e.preventDefault();
    if (drag.type) { const type = drag.type, at = dropAt; endDrag(); insertBlock(type, at); return; }
    const list = blocks();
    const from = list.findIndex((b) => b.id === drag.id);
    let to = dropAt;
    endDrag();
    if (from < 0) return;
    if (to > from) to--;
    if (to !== from) { const [m] = list.splice(from, 1); list.splice(to, 0, m); sel = m.id; touch(); }
    drawCanvas();
    drawSide();
  });
  root.addEventListener("dragend", endDrag);

  /* ---------- Sticky top bar (as in Form Builder) ---------- */
  function stickyTop() {
    const top = root.querySelector(".fe-top");
    const sentinel = root.querySelector(".fe-top-sentinel");
    const panels = [root.querySelector(".fe-palette"), side];
    const measure = () => {
      if (!root.isConnected) return;
      const tb = document.querySelector(".topbar");
      const pos = tb ? getComputedStyle(tb).position : "";
      const off = tb && (pos === "sticky" || pos === "fixed") ? Math.round(tb.getBoundingClientRect().height) : 0;
      top.style.top = `${off}px`;
      const below = off + Math.round(top.getBoundingClientRect().height);
      panels.forEach((el) => {
        if (el && getComputedStyle(el).position === "sticky") {
          el.style.top = `${below + 12}px`;
          el.style.maxHeight = `calc(100vh - ${below + 24}px)`;
        }
      });
    };
    new ResizeObserver(measure).observe(top);
    if (sentinel && "IntersectionObserver" in window) {
      new IntersectionObserver(([en]) => top.classList.toggle("is-stuck", !en.isIntersecting)).observe(sentinel);
    }
    measure();
  }
  // Does the email have a button that opens a form?
  const hasFormButton = () => blocks().some((b) =>
    (b.type === "button" && b.link === "form" && b.formId) ||
    (b.type === "buttons" && (b.items || []).some((it) => it.link === "form" && it.formId)));

  /* ---------- Send a test ---------- */
  async function sendTest() {
    await save();
    const probs = checkDesign(t);
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Send a test</h3><p>See exactly what patients will get. The subject starts with [Test].</p></div>
        ${probs.length ? `<div class="mb-checks"><strong>Before you send it for real</strong><ul>${probs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        <label class="lh-field"><span class="lh-label">Send to</span>
          <textarea name="to" rows="3" placeholder="you@dermedica.com.au">${esc((staff && staff.email) || "")}</textarea>
          <small class="fe-note">Up to 5 addresses, one per line.</small></label>
        <label class="lh-field"><span class="lh-label">Fill in the tags as (optional)</span>
          <input type="search" class="fe-input" data-role="q" placeholder="Search for a patient" autocomplete="off" /></label>
        <div class="mk-hits" data-role="hits"></div>
        <p class="mk-picked" data-role="picked" hidden></p>
        ${hasFormButton() ? `<label class="fe-check"><input type="checkbox" name="real" /> Let me send the form for real</label>
          <small class="fe-note">The form button opens the form for the patient above. Pressing Send saves it to their record
            (marked as a test) and tells the staff, like a real patient. Use a test patient.</small>` : ""}
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Send test</button>
        </div>
      </form>`, "mb-test-dlg");
    const form = dlg.querySelector("form");
    const q = dlg.querySelector('[data-role="q"]');
    const hits = dlg.querySelector('[data-role="hits"]');
    const picked = dlg.querySelector('[data-role="picked"]');
    const err = dlg.querySelector(".lh-error");
    let patient = null;
    let tmr = 0;
    let asked = "";
    q.addEventListener("input", () => {
      clearTimeout(tmr);
      tmr = setTimeout(async () => {
        const text = q.value.trim();
        asked = text;
        if (text.length < 2) { hits.innerHTML = ""; return; }
        hits.innerHTML = '<p class="muted">Searching…</p>';
        try {
          const res = await callApi({ action: "marketing", op: "search", q: text });
          if (asked !== text) return;
          hits.innerHTML = (res.results || []).map((r) => `<button type="button" class="du-fixhit" data-id="${esc(r.id)}" data-label="${esc(r.name)}">
            <strong>${esc(r.name)}</strong><small>ID ${esc(r.id)}${r.mobile ? ` · ${esc(r.mobile)}` : ""}</small></button>`).join("")
            || '<p class="muted">No patients found.</p>';
        } catch (ex) { hits.innerHTML = `<p class="du-warn">${esc(errText(ex, "Search failed."))}</p>`; }
      }, 300);
    });
    hits.addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (!b) return;
      patient = { id: b.dataset.id, name: b.dataset.label };
      picked.innerHTML = `✓ Filled in as <strong>${esc(patient.name)}</strong>`;
      picked.hidden = false;
      hits.innerHTML = "";
      q.value = "";
    });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const to = [...new Set((form.elements.to.value.match(EMAIL_RE) || []).map((x) => x.toLowerCase()))];
      if (!to.length) { err.textContent = "Add an email address to send it to."; err.hidden = false; return; }
      if (to.length > 5) { err.textContent = "Send to 5 addresses at most."; err.hidden = false; return; }
      const real = !!(form.elements.real && form.elements.real.checked);
      if (real && !patient) {
        err.textContent = 'Choose the patient in "Fill in the tags as". The form is saved to their record.';
        err.hidden = false;
        q.focus();
        return;
      }
      if (real && !/test/i.test(patient.name)) {
        const go = await confirmDialog({
          title: `Save the test to ${patient.name}'s record?`,
          message: "If you send the form, it's saved to this patient's record (marked as a test). A test patient is safer.",
          confirmLabel: "Send the test", tone: "warning",
        });
        if (!go) return;
      }
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        if (!(await save())) throw new Error("The latest changes couldn't be saved, so the test wasn't sent.");
        const res = await callApi({ action: "marketing", op: "testTemplate", templateId: t.id, to, patientId: patient ? patient.id : "", real });
        if (res.problem) throw new Error(res.problem);
        dlg.close();
        showToast(`Test sent to ${to.join(", ")}`);
      } catch (ex) {
        console.error("Test failed:", ex);
        err.textContent = errText(ex, "Couldn't send the test. Try again.");
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Send test";
      }
    });
    form.elements.to.focus();
  }

  drawCanvas();
  drawSide();
  stickyTop();
  try { makeResizable(root); } catch (err) { console.warn("Resizable panels not available:", err); }
}