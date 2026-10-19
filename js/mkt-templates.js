// Task Manager → Marketing → Email templates: the list, and the block builder (#/tasks/marketing/templates/<id>).
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import {
  esc, safeUrl, uid, BLOCKS, FONTS, MERGE_TAGS, STARTERS, styleOf, cleanDesign, newBlock, blockHtml, renderEmail,
  footerPreview, cleanRich, checkDesign,
} from "./mkt-email.js";

const COL = "mkt_templates";
const EMAIL_RE = /[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+/g;
const who = (staff) => String((staff && staff.name) || "").slice(0, 120);
const me = () => {
  const u = auth.currentUser && auth.currentUser.uid;
  if (!u) throw new Error("Your session has ended. Log in again.");
  return u;
};
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const day = (d) => (d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to email templates. Check Marketing access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);

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
  up: ic('<polyline points="18 15 12 9 6 15"/>'),
  down: ic('<polyline points="6 9 12 15 18 9"/>'),
  copy: ic('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  trash: ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
};

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
// starter: a STARTERS key. from: an existing template to copy.
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

/* ---------- Pictures: shrunk, then hosted in Firebase Storage (mkt_images/) ---------- */
async function shrink(file, max = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    if (im.naturalWidth <= max && file.size < 500 * 1024) return file;
    const k = Math.min(1, max / im.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(im.naturalWidth * k);
    c.height = Math.round(im.naturalHeight * k);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    return await new Promise((res) => c.toBlob((b) => res(b || file), type, 0.85));
  } catch { return file; } finally { URL.revokeObjectURL(url); }
}
async function uploadImage(file) {
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) throw new Error("Choose a picture (JPG, PNG or GIF).");
  if (file.size > 15 * 1024 * 1024) throw new Error("That picture is too big.");
  const blob = file.type === "image/gif" ? file : await shrink(file);
  if (blob.size > 5 * 1024 * 1024) throw new Error("That picture is still over 5 MB. Try a smaller one.");
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/gif" ? "gif" : blob.type === "image/webp" ? "webp" : "jpg";
  const r = sRef(getStorage(), `mkt_images/${Date.now()}_${uid()}.${ext}`);
  await uploadBytes(r, blob, { contentType: blob.type || "image/jpeg", cacheControl: "public,max-age=31536000" });
  return getDownloadURL(r);
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

/* ===================== The list ===================== */

const thumb = (t) => `<div class="mt-thumb-in">${renderEmail(t)}</div>`;

export function mountTemplateList(box, { staff = null } = {}) {
  box.innerHTML = `
    <div class="mk-tools">
      <input type="search" class="fe-input" data-role="q" placeholder="Search templates" aria-label="Search templates" />
      <span class="inv-spacer"></span>
      <button type="button" class="ff-btn is-primary" data-act="new">+ New template</button>
    </div>
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
        <a class="mt-thumb" href="#/tasks/marketing/templates/${encodeURIComponent(t.id)}" aria-label="Edit ${esc(t.name)}">${thumb(t)}</a>
        <div class="mt-meta">
          <strong>${esc(t.name)}</strong>
          <small>${esc(t.subject || "No subject yet")}</small>
          <small>Edited ${esc(day(t.updatedAt))}${t.updatedBy ? ` · ${esc(t.updatedBy)}` : ""}</small>
        </div>
        <div class="mt-acts">
          <a class="lh-btn is-primary" href="#/tasks/marketing/templates/${encodeURIComponent(t.id)}">Edit</a>
          <button type="button" class="lh-btn" data-dup="${esc(t.id)}">Duplicate</button>
          <button type="button" class="lh-btn is-quiet" data-del="${esc(t.id)}">Delete</button>
        </div>
      </article>`).join("")}</div>` : '<div class="tm-empty">No templates match.</div>';
  }

  function newDialog() {
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>New email template</h3><p>Start from a design. You can change everything.</p></div>
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
      if (!name) { err.textContent = "Give the template a name."; err.hidden = false; form.elements.name.focus(); return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const id = await createTemplate({ name, starter: form.elements.starter.value }, staff);
        dlg.close();
        location.hash = `#/tasks/marketing/templates/${encodeURIComponent(id)}`;
      } catch (ex) {
        console.error("Create template failed:", ex);
        err.textContent = errText(ex, "Couldn't create it. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.elements.name.focus();
  }

  box.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="new"]')) { newDialog(); return; }
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

// Settings fields. Every input has data-k = the path of what it changes.
const note = (n) => (n ? `<small class="fe-note">${n}</small>` : "");
const fText = (k, label, v, ph = "", n = "") => `<label class="lh-field"><span class="lh-label">${label}</span>
  <input class="fe-input" data-k="${k}" value="${esc(v ?? "")}" placeholder="${esc(ph)}" maxlength="500" autocomplete="off" />${note(n)}</label>`;
const fArea = (k, label, v, ph = "") => `<label class="lh-field"><span class="lh-label">${label}</span>
  <textarea class="fe-input" data-k="${k}" rows="3" maxlength="600" placeholder="${esc(ph)}">${esc(v ?? "")}</textarea></label>`;
const fRange = (k, label, v, min, max, unit) => `<label class="lh-field"><span class="lh-label">${label} <b data-show="${k}">${v}${unit}</b></span>
  <input type="range" class="mb-range" data-k="${k}" data-num data-out="${unit}" min="${min}" max="${max}" step="1" value="${v}" /></label>`;
const fCheck = (k, label, v) => `<label class="fe-check"><input type="checkbox" data-k="${k}"${v ? " checked" : ""} /> ${label}</label>`;
const fSeg = (k, label, opts, v) => `<div class="lh-field"><span class="lh-label">${label}</span><div class="fe-seg">${opts.map(([val, l]) =>
  `<label class="fe-seg-btn"><input type="radio" name="seg-${k}" data-k="${k}" value="${val}"${val === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div></div>`;
const fAlign = (v, k = "align") => fSeg(k, "Align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]], v || "left");
const fColor = (k, label, v, fallback, canReset = true) => `<div class="lh-field"><span class="lh-label">${label}</span><div class="mb-row">
  <input type="color" class="mb-color" data-k="${k}" value="${esc(v || fallback)}" aria-label="${esc(label)}" />
  ${canReset ? (v ? `<button type="button" class="lh-btn is-quiet" data-reset="${k}">Use the default</button>` : '<small class="fe-note">Default</small>') : ""}</div></div>`;
const fImage = (k, label, v, n = "") => `<div class="lh-field"><span class="lh-label">${label}</span>
  <div class="mb-img">${safeUrl(v) ? `<img src="${esc(v)}" alt="" />` : '<span class="mb-img-ph">No picture</span>'}
    <span class="mb-row"><label class="lh-btn">Upload<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-upload="${k}" hidden /></label>
    ${v ? `<button type="button" class="lh-btn is-quiet" data-reset="${k}">Remove</button>` : ""}</span></div>
  <input class="fe-input" data-k="${k}" value="${esc(v || "")}" placeholder="or paste a picture address (https://…)" autocomplete="off" />${note(n)}</div>`;
const fRich = (k, label, v) => `<div class="lh-field"><span class="lh-label">${label}</span><div class="mb-rt">
  <div class="mb-rt-bar">
    <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
    <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
    <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
    <button type="button" data-cmd="insertUnorderedList" title="Bulleted list">• List</button>
    <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
    <button type="button" data-cmd="link" title="Add a link">Link</button>
    <button type="button" data-cmd="unlink" title="Remove the link">Unlink</button>
    ${MERGE_TAGS.map(([tag, help]) => `<button type="button" data-tag="${esc(tag)}" title="${esc(help)}">${esc(tag)}</button>`).join("")}
  </div>
  <div class="mb-rt-area" contenteditable="true" data-rich="${k}">${cleanRich(v)}</div></div></div>`;

export async function mountTemplateBuilder(container, { id, staff = null } = {}) {
  container.innerHTML = '<section class="page wide"><div class="skeleton" style="height:420px;border-radius:14px"></div></section>';
  let t;
  try { t = await getTemplate(id); }
  catch (err) {
    console.error("Template failed:", err);
    container.innerHTML = `<section class="page"><div class="state error"><strong>Couldn't open the template</strong>${esc(errText(err, "Try again."))}</div></section>`;
    return;
  }
  if (!t || t.status === "archived") {
    container.innerHTML = '<section class="page"><div class="state"><strong>Template not found</strong>It may have been deleted. <a href="#/tasks/marketing/templates">Back to templates</a></div></section>';
    return;
  }

  const root = document.createElement("section");
  root.className = "page wide mb";
  root.innerHTML = `
    <div class="mb-top">
      <a class="ff-back" href="#/tasks/marketing/templates" aria-label="Back to templates">${ICONS.back}</a>
      <input class="mb-name" data-role="name" maxlength="120" value="${esc(t.name)}" aria-label="Template name" />
      <span class="mb-state" data-role="state">Saved</span>
      <span class="inv-spacer"></span>
      <div class="fe-seg mb-dev" role="radiogroup" aria-label="Preview">
        <label class="fe-seg-btn"><input type="radio" name="mb-dev" value="desktop" checked /><span>Desktop</span></label>
        <label class="fe-seg-btn"><input type="radio" name="mb-dev" value="mobile" /><span>Mobile</span></label>
      </div>
      <button type="button" class="ff-btn" data-act="test">Send a test</button>
      <button type="button" class="ff-btn is-primary" data-act="save">Save</button>
    </div>
    <div class="mb-grid">
      <aside class="mb-pal" data-role="pal">
        <p class="mb-pal-h">Add a block</p>
        ${Object.keys(BLOCKS).map((k) => `<button type="button" class="mb-add" data-add="${k}">${ICONS[k]}<span>${esc(BLOCKS[k].label)}</span></button>`).join("")}
        <p class="mb-pal-hint fe-note">New blocks go under the one you've selected. Click a block in the email to change it.</p>
      </aside>
      <div class="mb-stage" data-role="stage">
        <button type="button" class="mb-inbox" data-role="inbox" title="Change the subject and preview text"></button>
        <div class="mb-mail" data-role="canvas"></div>
      </div>
      <aside class="mb-side" data-role="side"></aside>
    </div>`;
  container.replaceChildren(root);
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const canvas = $("canvas");
  const side = $("side");
  const stateEl = $("state");

  let sel = null;
  let mobile = false;
  let dirty = false;
  let timer = 0;
  let raf = 0;
  let savingP = null;
  const blocks = () => t.design.blocks;
  const selBlock = () => blocks().find((b) => b.id === sel) || null;
  const target = () => selBlock() || t;

  /* ---------- Saving: automatic, a moment after each change ---------- */
  const setState = (text, cls = "") => { stateEl.textContent = text; stateEl.className = `mb-state ${cls}`; };
  async function save() {
    clearTimeout(timer);
    if (savingP) await savingP;
    if (!dirty) return true;
    dirty = false;
    setState("Saving…");
    savingP = saveTemplate(t, staff)
      .then(() => { setState(dirty ? "Unsaved changes" : "Saved", dirty ? "is-dirty" : ""); return true; })
      .catch((err) => {
        console.error("Save template failed:", err);
        dirty = true;
        setState(err && err.code === "permission-denied" ? "Not saved: no access" : "Not saved. Check your connection.", "is-bad");
        return false;
      })
      .finally(() => { savingP = null; });
    return savingP;
  }
  function touch() {
    dirty = true;
    setState("Unsaved changes", "is-dirty");
    clearTimeout(timer);
    timer = setTimeout(save, 1500);
  }
  const onUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("hashchange", () => { window.removeEventListener("beforeunload", onUnload); if (dirty) save(); }, { once: true });

  /* ---------- The email ---------- */
  function drawCanvas() {
    raf = 0;
    const st = styleOf(t.design);
    $("stage").style.background = st.bg;
    $("inbox").innerHTML = `<small>Dermedica Clinic</small><b>${esc(t.subject || "No subject yet")}</b><span>${esc(t.preview || "No preview text")}</span>`;
    canvas.className = `mb-mail${mobile ? " is-mobile" : ""}`;
    canvas.style.background = st.body;
    const list = blocks();
    canvas.innerHTML = (list.length ? list.map((b, i) => `
      <div class="mb-blk${b.id === sel ? " is-sel" : ""}" data-blk="${esc(b.id)}" tabindex="0" role="button" aria-label="${esc(BLOCKS[b.type].label)}: click to change">
        <span class="mb-tag">${esc(BLOCKS[b.type].label)}</span>
        <div class="mb-tools">
          <button type="button" data-tool="up" aria-label="Move up" title="Move up"${i ? "" : " disabled"}>${ICONS.up}</button>
          <button type="button" data-tool="down" aria-label="Move down" title="Move down"${i < list.length - 1 ? "" : " disabled"}>${ICONS.down}</button>
          <button type="button" data-tool="copy" aria-label="Duplicate" title="Duplicate">${ICONS.copy}</button>
          <button type="button" data-tool="del" aria-label="Delete" title="Delete">${ICONS.trash}</button>
        </div>
        ${blockHtml(b, st, true)}
      </div>`).join("") : '<div class="mb-empty">Add a block from the left to start your email.</div>') +
      `<div class="mb-foot" title="Added automatically to every marketing email">${footerPreview()}</div>`;
    const ch = side.querySelector('[data-role="checks"]');
    if (ch) ch.outerHTML = checksHtml();
  }
  const drawSoon = () => { if (!raf) raf = requestAnimationFrame(drawCanvas); };
  const changed = () => { drawSoon(); touch(); };

  function checksHtml() {
    const p = checkDesign(t);
    return p.length
      ? `<div class="mb-checks" data-role="checks"><strong>Before sending</strong><ul>${p.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
      : '<div class="mb-checks is-ok" data-role="checks">Ready to send. Send yourself a test first.</div>';
  }

  /* ---------- Settings ---------- */
  function emailForm() {
    const st = styleOf(t.design);
    return `
      <div class="mb-side-head"><h4>Email settings</h4></div>
      <label class="lh-field"><span class="lh-label">Subject</span>
        <input class="fe-input" data-k="subject" maxlength="150" value="${esc(t.subject)}" placeholder="What's new at Dermedica" /></label>
      <div class="mb-tags"><small class="muted">Insert:</small>${MERGE_TAGS.map(([tag, help]) =>
        `<button type="button" class="ch-chip" data-subtag="${esc(tag)}" title="${esc(help)}">${esc(tag)}</button>`).join("")}</div>
      <label class="lh-field"><span class="lh-label">Preview text</span>
        <input class="fe-input" data-k="preview" maxlength="150" value="${esc(t.preview)}" placeholder="News, tips and something new for your skin" />
        <small class="fe-note">Shown after the subject in most inboxes.</small></label>
      <p class="mb-sec">Colours and font</p>
      ${fColor("design.style.bg", "Page background", st.bg, st.bg, false)}
      ${fColor("design.style.body", "Email background", st.body, st.body, false)}
      ${fColor("design.style.text", "Text", st.text, st.text, false)}
      ${fColor("design.style.accent", "Buttons and links", st.accent, st.accent, false)}
      <label class="lh-field"><span class="lh-label">Font</span><select class="fb-select" data-k="design.style.font">${FONTS.map(([f, l]) =>
        `<option value="${esc(f)}"${f === st.font ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <p class="mb-sec">Checks</p>
      ${checksHtml()}
      <p class="fe-note mb-footnote">Every marketing email ends with the clinic's details and an Unsubscribe link. It's added automatically.</p>`;
  }

  function blockForm(b) {
    const st = styleOf(t.design);
    switch (b.type) {
      case "header": return fImage("logo", "Logo", b.logo, "Leave empty to show the clinic name as text.") +
        (safeUrl(b.logo) ? fRange("logoWidth", "Logo width", b.logoWidth, 60, 400, "px") : fText("text", "Clinic name", b.text)) +
        fAlign(b.align) + fColor("bg", "Background", b.bg, st.body);
      case "heading": return fArea("text", "Heading", b.text) +
        fSeg("size", "Size", [["large", "Large"], ["medium", "Medium"], ["small", "Small"]], b.size) + fAlign(b.align);
      case "text": return fRich("html", "Text", b.html) + fAlign(b.align);
      case "image": return fImage("src", "Picture", b.src, "Wide pictures look best. They're shrunk to 1200px wide.") +
        fText("alt", "Describe the picture", b.alt, "", "Read out by screen readers, and shown if pictures are blocked.") +
        fText("href", "Link (optional)", b.href, "https://") +
        fCheck("edge", "Edge to edge (no side margins)", b.edge) +
        (b.edge ? "" : fRange("width", "Width", b.width, 20, 100, "%") + fAlign(b.align));
      case "button": return fText("label", "Button text", b.label) + fText("href", "Link", b.href, "https://dermedica.com.au/book") +
        fColor("bg", "Button colour", b.bg, st.accent) + fColor("color", "Text colour", b.color, "#ffffff") +
        fAlign(b.align) + fCheck("full", "Full width", b.full);
      case "product": return `<label class="lh-field"><span class="lh-label">Fill in from the Skin Script catalogue</span>
          <select class="fb-select" data-act="catalogue"><option value="">${sspCache ? "Choose a product…" : "Loading the catalogue…"}</option>${
            (sspCache || []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.size ? ` · ${esc(p.size)}` : ""}</option>`).join("")}</select></label>` +
        fImage("src", "Picture", b.src) + fText("name", "Name", b.name) + fText("price", "Price (optional)", b.price, "$89") +
        fArea("desc", "Description", b.desc) + fText("label", "Button text (optional)", b.label) + fText("href", "Link", b.href, "https://");
      case "columns": return [0, 1].map((i) => `<p class="mb-sec">${i ? "Right" : "Left"} column</p>` +
        fImage(`items.${i}.src`, "Picture (optional)", b.items[i].src) + fText(`items.${i}.title`, "Title", b.items[i].title) +
        fRich(`items.${i}.html`, "Text", b.items[i].html) + fText(`items.${i}.label`, "Button text (optional)", b.items[i].label) +
        fText(`items.${i}.href`, "Button link", b.items[i].href, "https://")).join("") +
        '<p class="fe-note">On phones the right column goes under the left one.</p>';
      case "divider": return fColor("color", "Line colour", b.color, "#e2e8f0", false);
      case "spacer": return fRange("size", "Height", b.size, 4, 120, "px");
      case "social": return fText("facebook", "Facebook", b.facebook, "https://facebook.com/…") +
        fText("instagram", "Instagram", b.instagram, "https://instagram.com/…") + fText("tiktok", "TikTok", b.tiktok, "https://tiktok.com/@…") +
        fText("website", "Website", b.website, "https://dermedica.com.au") + fAlign(b.align) +
        '<p class="fe-note">Leave a box empty to leave that link out.</p>';
    }
    return "";
  }

  function drawSide() {
    const b = selBlock();
    if (!b) { side.innerHTML = emailForm(); return; }
    side.innerHTML = `<div class="mb-side-head"><h4>${esc(BLOCKS[b.type].label)}</h4>
      <button type="button" class="lh-btn" data-act="done">Done</button></div>${blockForm(b)}`;
    if (b.type === "product" && !sspCache) {
      sspProducts().then(() => { if (sel === b.id) drawSide(); }).catch((err) => console.warn("Catalogue not loaded:", err));
    }
  }

  const select = (bid) => { if (sel === bid) return; sel = bid; drawCanvas(); drawSide(); };

  /* ---------- Events ---------- */
  $("pal").addEventListener("click", (e) => {
    const a = e.target.closest("[data-add]");
    if (!a) return;
    const nb = newBlock(a.dataset.add);
    const list = blocks();
    const i = list.findIndex((x) => x.id === sel);
    list.splice(i < 0 ? list.length : i + 1, 0, nb);
    sel = nb.id;
    drawCanvas();
    drawSide();
    touch();
    requestAnimationFrame(() => {
      const el = canvas.querySelector(`[data-blk="${CSS.escape(nb.id)}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });

  canvas.addEventListener("click", (e) => {
    if (e.target.closest("a")) e.preventDefault();
    const blk = e.target.closest("[data-blk]");
    const tool = e.target.closest("[data-tool]");
    if (!blk) return;
    if (!tool) { select(blk.dataset.blk); return; }
    const list = blocks();
    const i = list.findIndex((b) => b.id === blk.dataset.blk);
    if (i < 0) return;
    const k = tool.dataset.tool;
    if (k === "up" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (k === "down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else if (k === "copy") { const c = JSON.parse(JSON.stringify(list[i])); c.id = uid(); list.splice(i + 1, 0, c); sel = c.id; }
    else if (k === "del") { list.splice(i, 1); if (sel === blk.dataset.blk) sel = null; }
    else return;
    drawCanvas();
    drawSide();
    touch();
  });
  canvas.addEventListener("keydown", (e) => {
    const blk = e.target.closest("[data-blk]");
    if (blk && (e.key === "Enter" || e.key === " ") && e.target === blk) { e.preventDefault(); select(blk.dataset.blk); }
  });
  $("stage").addEventListener("click", (e) => {
    if (e.target.closest("[data-blk]")) return;
    if (sel) { sel = null; drawCanvas(); drawSide(); }
    if (e.target.closest('[data-role="inbox"]')) { const s = side.querySelector('[data-k="subject"]'); if (s) s.focus(); }
  });

  side.addEventListener("input", (e) => {
    const el = e.target;
    if (el.matches("[data-rich]")) { setPath(target(), el.dataset.rich, cleanRich(el.innerHTML)); changed(); return; }
    const k = el.dataset.k;
    if (!k || el.type === "checkbox" || el.type === "radio" || el.tagName === "SELECT" || el.type === "file") return;
    setPath(target(), k, el.dataset.num !== undefined ? Number(el.value) : el.value);
    if (el.dataset.out !== undefined) {
      const out = side.querySelector(`[data-show="${CSS.escape(k)}"]`);
      if (out) out.textContent = el.value + el.dataset.out;
    }
    changed();
  });
  side.addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches("[data-upload]")) {
      const f = el.files && el.files[0];
      if (!f) return;
      const tgt = target();
      const key = el.dataset.upload;
      showToast("Uploading the picture…");
      uploadImage(f)
        .then((url) => { setPath(tgt, key, url); drawSide(); changed(); showToast("Picture added"); })
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
    const k = el.dataset.k;
    if (!k) return;
    if (el.type === "checkbox") setPath(target(), k, el.checked);
    else if (el.type === "radio" || el.tagName === "SELECT") setPath(target(), k, el.value);
    else if (el.dataset.k === "src" || el.dataset.k === "logo" || /\.src$/.test(k)) { drawSide(); return; } // a pasted picture address: show it
    else return;
    drawSide();
    changed();
  });

  // The text editor's buttons keep the selection where it was
  side.addEventListener("mousedown", (e) => { if (e.target.closest(".mb-rt-bar button")) e.preventDefault(); });
  side.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="done"]')) { sel = null; drawCanvas(); drawSide(); return; }
    const reset = e.target.closest("[data-reset]");
    if (reset) { setPath(target(), reset.dataset.reset, ""); drawSide(); changed(); return; }
    const sub = e.target.closest("[data-subtag]");
    if (sub) {
      const inp = side.querySelector('[data-k="subject"]');
      const at = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, at) + sub.dataset.subtag + inp.value.slice(inp.selectionEnd ?? at);
      inp.focus();
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const b = e.target.closest(".mb-rt-bar button");
    if (!b) return;
    const area = b.closest(".mb-rt").querySelector("[data-rich]");
    area.focus();
    if (b.dataset.tag) document.execCommand("insertText", false, b.dataset.tag);
    else if (b.dataset.cmd === "link") {
      const url = window.prompt("Link address", "https://");
      if (url === null) return;
      if (!safeUrl(url)) { showToast("Links need to start with https://"); return; }
      document.execCommand("createLink", false, url.trim());
    } else document.execCommand(b.dataset.cmd, false, null);
    setPath(target(), area.dataset.rich, cleanRich(area.innerHTML));
    changed();
  });

  $("name").addEventListener("input", (e) => { t.name = e.target.value; touch(); });
  root.querySelector(".mb-dev").addEventListener("change", (e) => { mobile = e.target.value === "mobile"; drawCanvas(); });
  root.querySelector('[data-act="save"]').addEventListener("click", async () => {
    dirty = true;
    if (await save()) showToast("Template saved");
  });
  root.querySelector('[data-act="test"]').addEventListener("click", sendTest);

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
        <label class="lh-field"><span class="lh-label">Fill in {First name} as (optional)</span>
          <input type="search" class="fe-input" data-role="q" placeholder="Search for a patient" autocomplete="off" /></label>
        <div class="mk-hits" data-role="hits"></div>
        <p class="mk-picked" data-role="picked" hidden></p>
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
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        if (!(await save())) throw new Error("The latest changes couldn't be saved, so the test wasn't sent.");
        const res = await callApi({ action: "marketing", op: "testTemplate", templateId: t.id, to, patientId: patient ? patient.id : "" });
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
}