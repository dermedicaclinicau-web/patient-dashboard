// The Image Bank: browse, upload, organise and choose images.
// Used as its own page (#/image-bank) and as the picker for the Image field.
import {
  bankList, cachedList, rememberList, bankSearch, bankMkdir, bankRename, bankTrash,
  bankUpload, bankImage, bankError, thumbFor,
} from "./image-bank-api.js";
import { listFormTemplates } from "./form-templates.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  folder: ic('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  image: ic('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  search: ic('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  newFolder: ic('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>'),
  upload: ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  pencil: ic('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  trash: ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  chev: ic('<polyline points="9 18 15 12 9 6"/>'),
};
const byName = (a, b) => String(a.name).localeCompare(String(b.name), "en-AU", { numeric: true });

function promptDialog({ title, label, value = "", confirm = "Save" }) {
  return new Promise((resolve) => {
    let out = null;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog fe-confirm";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${esc(title)}</h3></div>
        <label class="lh-field"><span class="lh-label">${esc(label)}</span>
          <input type="text" maxlength="120" value="${esc(value)}" />
        </label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${esc(confirm)}</button>
        </div>
      </form>`;
    const input = dlg.querySelector("input");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { err.textContent = "Enter a name."; err.hidden = false; return; }
      out = v;
      dlg.close();
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out); });
    document.body.appendChild(dlg);
    dlg.showModal();
    input.focus();
    const dot = value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : value.length); // select the name, not the extension
  });
}

/* ===================== The bank itself ===================== */

// mode "manage": click an image to view it. mode "pick": click an image to choose it (onPick).
function createBank(host, { mode = "manage", isAdmin = false, onPick = null } = {}) {
  const picking = mode === "pick";
  const canEdit = isAdmin;
  const state = { folderId: "", path: [], folders: [], images: [], next: null, q: "", searching: false };
  let token = 0;
  let observer = null;

  host.innerHTML = `
    <div class="ib${picking ? " is-picking" : ""}">
      <div class="ib-bar">
        <nav class="ib-crumbs" data-role="crumbs" aria-label="Folder"></nav>
        <div class="ib-actions">
          <label class="ib-search">${I.search}
            <input type="search" data-role="q" placeholder="Search images" aria-label="Search images" />
          </label>
          ${canEdit ? `
            <button type="button" class="ff-btn" data-act="mkdir">${I.newFolder}<span>New folder</span></button>
            <label class="ff-btn is-primary">${I.upload}<span>Upload</span>
              <input type="file" data-role="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
            </label>` : ""}
        </div>
      </div>
      <div class="ib-uploads" data-role="uploads"></div>
      <div class="ib-area" data-role="area">
        <div class="ib-grid" data-role="grid"></div>
        <div class="ib-more" data-role="more"></div>
        ${canEdit ? '<div class="ib-drop" data-role="drop">Drop images here to upload them</div>' : ""}
      </div>
    </div>`;

  const $ = (s) => host.querySelector(s);
  const grid = $('[data-role="grid"]');
  const crumbs = $('[data-role="crumbs"]');
  const more = $('[data-role="more"]');
  const qInput = $('[data-role="q"]');

  /* ---------- Drawing ---------- */
  const tools = (kind, x) => canEdit ? `
    <div class="ib-tools">
      <button type="button" class="ib-tool" data-rename="${esc(x.id)}" data-kind="${kind}" title="Rename" aria-label="Rename ${esc(x.name)}">${I.pencil}</button>
      <button type="button" class="ib-tool is-danger" data-trash="${esc(x.id)}" data-kind="${kind}" title="Delete" aria-label="Delete ${esc(x.name)}">${I.trash}</button>
    </div>` : "";

  const folderTile = (f) => `
    <div class="ib-tile is-folder">
      <button type="button" class="ib-hit" data-open="${esc(f.id)}" title="${esc(f.name)}">
        <span class="ib-thumb">${I.folder}</span><span class="ib-name">${esc(f.name)}</span>
      </button>${tools("folder", f)}
    </div>`;

  const imageTile = (m) => `
    <div class="ib-tile is-image">
      <button type="button" class="ib-hit" data-img="${esc(m.id)}" title="${esc(m.name)}">
        <span class="ib-thumb${m.localThumb ? " is-loaded" : ""}" data-thumb="${esc(m.id)}">${
          m.localThumb ? `<img src="${esc(m.localThumb)}" alt="" />` : I.image}</span>
        <span class="ib-name">${esc(m.name)}</span>
      </button>${tools("image", m)}
    </div>`;

  function renderCrumbs() {
    if (state.searching) {
      crumbs.innerHTML = `<span class="ib-crumb is-here">Search results for “${esc(state.q)}”</span>
        <button type="button" class="ib-clear" data-act="clear">Clear search</button>`;
      return;
    }
    crumbs.innerHTML = state.path.map((p, i) => i === state.path.length - 1
      ? `<span class="ib-crumb is-here" aria-current="page">${esc(p.name)}</span>`
      : `<button type="button" class="ib-crumb" data-open="${esc(p.id)}">${esc(p.name)}</button>${I.chev}`).join("");
  }

  function render() {
    renderCrumbs();
    if (!state.folders.length && !state.images.length) {
      grid.innerHTML = `<div class="ib-empty">${state.searching
        ? "No images or folders match that search."
        : canEdit ? "This folder is empty. Upload images, or create a folder to organise them." : "No images here yet."}</div>`;
    } else {
      grid.innerHTML = state.folders.map(folderTile).join("") + state.images.map(imageTile).join("");
    }
    more.innerHTML = state.next !== null ? '<button type="button" class="ff-btn" data-act="more">Show more images</button>' : "";
    if (!state.searching && state.path.length) {
      rememberList({ folder: { id: state.folderId }, path: state.path, folders: state.folders, images: state.images, next: state.next });
    }
    watchThumbs();
  }

  function renderLoading() {
    grid.innerHTML = Array.from({ length: 8 }, () => '<div class="ib-tile"><div class="skeleton ib-skel"></div></div>').join("");
    more.innerHTML = "";
  }

  function renderError(err) {
    grid.innerHTML = `<div class="ib-empty is-error">${esc(bankError(err))}
      <button type="button" class="ff-btn" data-act="retry">Try again</button></div>`;
  }

  /* ---------- Thumbnails: only for tiles on screen ---------- */
  function loadThumb(span) {
    const m = state.images.find((x) => x.id === span.dataset.thumb);
    if (!m) return;
    span.classList.add("is-loading");
    thumbFor(m)
      .then((url) => {
        if (!url || !span.isConnected) return;
        span.innerHTML = `<img src="${esc(url)}" alt="" />`;
        span.classList.add("is-loaded");
      })
      .catch(() => { /* leave the picture icon */ })
      .finally(() => span.classList.remove("is-loading"));
  }

  function watchThumbs() {
    if (observer) observer.disconnect();
    const spans = grid.querySelectorAll(".ib-thumb[data-thumb]:not(.is-loaded)");
    if (!spans.length) return;
    if (!("IntersectionObserver" in window)) { spans.forEach(loadThumb); return; }
    observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        observer.unobserve(e.target);
        loadThumb(e.target);
      });
    }, { root: picking ? host : null, rootMargin: "300px" });
    spans.forEach((s) => observer.observe(s));
  }

  /* ---------- Loading ---------- */
  const apply = (r) => Object.assign(state, {
    folderId: r.folder.id, path: r.path, folders: [...r.folders], images: [...r.images], next: r.next,
  });
  const sig = (r) => JSON.stringify([
    r.folders.map((f) => f.id + f.name),
    r.images.map((m) => m.id + m.name + m.updated),
    r.next,
  ]);

  async function open(folderId) {
    const t = ++token;
    state.searching = false;
    state.q = "";
    qInput.value = "";
    const cached = cachedList(folderId);
    if (cached) { apply(cached); render(); } else renderLoading();
    try {
      const r = await bankList(folderId);
      if (t !== token) return;
      if (!cached || sig(cached) !== sig(r)) { apply(r); render(); } // only redraw if Drive changed
    } catch (err) {
      if (t !== token) return;
      console.error("Image bank list failed:", err);
      if (cached) showToast(bankError(err)); else renderError(err);
    }
  }

  async function loadMore() {
    const btn = more.querySelector("button");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    try {
      const r = await bankList(state.folderId, state.next);
      state.images = state.images.concat(r.images);
      state.next = r.next;
      render();
    } catch (err) {
      showToast(bankError(err));
      if (btn) { btn.disabled = false; btn.textContent = "Show more images"; }
    }
  }

  async function runSearch(q) {
    if (q.length < 2) {
      if (state.searching) open(state.folderId);
      return;
    }
    const t = ++token;
    state.searching = true;
    state.q = q;
    renderCrumbs();
    renderLoading();
    try {
      const r = await bankSearch(q);
      if (t !== token) return;
      state.folders = r.folders;
      state.images = r.images;
      state.next = null;
      render();
    } catch (err) {
      if (t !== token) return;
      renderError(err);
    }
  }

  /* ---------- Actions ---------- */
  const findItem = (kind, id) => (kind === "folder" ? state.folders : state.images).find((x) => x.id === id);

  async function makeFolder() {
    const name = await promptDialog({ title: "New folder", label: "Folder name", confirm: "Create folder" });
    if (!name) return;
    try {
      const r = await bankMkdir(state.folderId, name);
      if (!state.searching) { state.folders.push(r.folder); state.folders.sort(byName); render(); }
      showToast(`Folder “${r.folder.name}” created`);
    } catch (err) { showToast(bankError(err)); }
  }

  async function rename(kind, id) {
    const item = findItem(kind, id);
    if (!item) return;
    const name = await promptDialog({ title: `Rename ${kind === "folder" ? "folder" : "image"}`, label: "Name", value: item.name, confirm: "Rename" });
    if (!name || name === item.name) return;
    try {
      const r = await bankRename(id, kind, name);
      item.name = r.name;
      (kind === "folder" ? state.folders : state.images).sort(byName);
      render();
    } catch (err) { showToast(bankError(err)); }
  }

  async function trash(kind, id) {
    const item = findItem(kind, id);
    if (!item) return;
    let message = kind === "folder"
      ? `Everything inside “${item.name}” goes to the Google Drive Bin too. It can be restored from the Bin for 30 days.`
      : "It goes to the Google Drive Bin and can be restored from there for 30 days.";
    if (kind === "image") {
      try {
        const used = (await listFormTemplates({ isAdmin: true }))
          .filter((t) => (t.fields || []).some((f) => f.type === "image" && f.fileId === id));
        if (used.length) {
          const names = used.slice(0, 3).map((t) => t.name).join(", ") + (used.length > 3 ? ` and ${used.length - 3} more` : "");
          message = `It's used in ${used.length} form${used.length === 1 ? "" : "s"}: ${names}. Those forms will show a missing image. ${message}`;
        }
      } catch (err) { console.warn("Couldn't check which forms use this image:", err); }
    }
    const ok = await confirmDialog({ title: `Delete “${item.name}”?`, message, confirmLabel: "Delete", tone: "danger" });
    if (!ok) return;
    try {
      await bankTrash(id, kind);
      if (kind === "folder") state.folders = state.folders.filter((x) => x.id !== id);
      else state.images = state.images.filter((x) => x.id !== id);
      render();
      showToast("Moved to the Google Drive Bin");
    } catch (err) { showToast(bankError(err)); }
  }

  function preview(m) {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ib-preview";
    dlg.innerHTML = `
      <div class="ib-prev-head"><strong title="${esc(m.name)}">${esc(m.name)}</strong>
        <button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>
      <div class="ib-prev-body"><div class="skeleton" style="height:320px;width:100%;border-radius:10px"></div></div>`;
    dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    bankImage(m.id)
      .then((src) => { dlg.querySelector(".ib-prev-body").innerHTML = `<img src="${esc(src)}" alt="${esc(m.name)}" />`; })
      .catch((err) => { dlg.querySelector(".ib-prev-body").innerHTML = `<p class="ib-empty is-error">${esc(bankError(err))}</p>`; });
  }

  /* ---------- Uploading ---------- */
  function uploadRow(name) {
    const row = document.createElement("div");
    row.className = "ib-up";
    row.innerHTML = `<span class="ib-up-name">${esc(name)}</span><span class="ib-up-st">Uploading…</span>`;
    $('[data-role="uploads"]').appendChild(row);
    const st = row.querySelector(".ib-up-st");
    return {
      done() { row.classList.add("is-done"); st.textContent = "Uploaded"; setTimeout(() => row.remove(), 2500); },
      fail(msg) { row.classList.add("is-failed"); st.textContent = msg; setTimeout(() => row.remove(), 8000); },
    };
  }

  async function uploadFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const target = state.folderId;
    for (const file of files) {
      const row = uploadRow(file.name);
      try {
        const r = await bankUpload(target, file);
        row.done();
        r.image.localThumb = URL.createObjectURL(file); // show it straight away
        if (state.folderId === target && !state.searching) {
          state.images.push(r.image);
          state.images.sort(byName);
          render();
        }
      } catch (err) {
        console.error("Upload failed:", err);
        row.fail(bankError(err));
      }
    }
  }

  /* ---------- Events ---------- */
  host.addEventListener("click", (e) => {
    const t = e.target;
    const openBtn = t.closest("[data-open]");
    if (openBtn) { open(openBtn.dataset.open); return; }
    const imgBtn = t.closest("[data-img]");
    if (imgBtn) {
      const m = state.images.find((x) => x.id === imgBtn.dataset.img);
      if (!m) return;
      if (picking && onPick) onPick({ id: m.id, name: m.name });
      else preview(m);
      return;
    }
    const ren = t.closest("[data-rename]");
    if (ren) { rename(ren.dataset.kind, ren.dataset.rename); return; }
    const del = t.closest("[data-trash]");
    if (del) { trash(del.dataset.kind, del.dataset.trash); return; }
    const act = t.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "mkdir") makeFolder();
    else if (act.dataset.act === "more") loadMore();
    else if (act.dataset.act === "clear" || act.dataset.act === "retry") open(state.folderId);
  });

  let searchTimer = null;
  qInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(qInput.value.trim()), 400);
  });

  if (canEdit) {
    const fileInput = $('[data-role="file"]');
    fileInput.addEventListener("change", () => { uploadFiles(fileInput.files); fileInput.value = ""; });

    const area = $('[data-role="area"]');
    let depth = 0;
    area.addEventListener("dragenter", (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { depth++; area.classList.add("is-dragging"); }
    });
    area.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) area.classList.remove("is-dragging"); });
    area.addEventListener("dragover", (e) => { if (area.classList.contains("is-dragging")) e.preventDefault(); });
    area.addEventListener("drop", (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      depth = 0;
      area.classList.remove("is-dragging");
      uploadFiles(e.dataTransfer.files);
    });
  }

  open("");
}

/* ===================== The Image Bank page ===================== */

export function mountImageBank(container, { isAdmin = false } = {}) {
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `
    <a class="back-link" href="#/forms">← Form Builder</a>
    <div class="fb-head">
      <div>
        <h2>Image Bank</h2>
        <p class="muted">Images for your forms, kept in the clinic's Google Drive folder.${
          isAdmin ? " Drag images onto the page to upload them." : " Only admins can add or change images."}</p>
      </div>
    </div>
    <div data-role="bank"></div>`;
  container.replaceChildren(root);
  createBank(root.querySelector('[data-role="bank"]'), { mode: "manage", isAdmin });
}

/* ===================== Picker (used by the Image field) ===================== */

// Resolves with { id, name } or null if cancelled
export function openImagePicker({ isAdmin = false } = {}) {
  return new Promise((resolve) => {
    let picked = null;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ib-picker";
    dlg.innerHTML = `
      <div class="ib-picker-head"><h3>Choose an image</h3>
        <button type="button" class="lh-btn is-quiet" data-act="close">Cancel</button></div>
      <div class="ib-picker-body"></div>`;
    document.body.appendChild(dlg);
    createBank(dlg.querySelector(".ib-picker-body"), {
      mode: "pick", isAdmin, onPick: (img) => { picked = img; dlg.close(); },
    });
    dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { dlg.remove(); resolve(picked); });
    dlg.showModal();
  });
}