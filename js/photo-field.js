// Photos added while filling in a form: take, upload or pick from the Image Bank,
// laid out side by side or stacked, optionally marked up. Stored privately in Firebase Storage.
import { storage } from "./firebase-config.js";
import { ref as sref, uploadBytes, getBlob } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { bankImage } from "./image-bank-api.js";
import { openImagePicker } from "./image-bank.js";
import { createAnnotator } from "./form-annotate.js";
import { imageSizing } from "./form-fields.js";
import { showToast } from "./utils.js";

const MAX_SIDE = 1600;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  camera: ic('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  upload: ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  bank: ic('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  pen: ic('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  trash: ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
};

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const rand = () => Math.random().toString(36).slice(2, 8);

// A saved photo is { path, name, width, height, drawingPath? } or { bankId, name, drawingPath? }
export const photoKey = (p) => (p && p.path ? p.path : `bank:${p && p.bankId}`);

const srcCache = new Map();
export function photoSrc(p) {
  const k = photoKey(p);
  if (!srcCache.has(k)) {
    const job = p.path ? getBlob(sref(storage, p.path)).then(blobToDataUrl) : bankImage(p.bankId);
    srcCache.set(k, job);
    job.catch(() => srcCache.delete(k));
  }
  return srcCache.get(k);
}

// How the photos are laid out (also used by the PDF)
export function photoLayout(f) {
  const stack = f.photoLayout === "stack";
  return {
    stack,
    perRow: Math.max(2, Math.min(4, parseInt(f.perRow, 10) || 2)),
    pct: stack ? imageSizing({ ...f, annotate: true }).pct : 100,
  };
}
const gridAttrs = (f) => {
  const L = photoLayout(f);
  return L.stack ? `class="ph-grid is-stack" style="--ph-w:${L.pct}%"` : `class="ph-grid cols-${L.perRow}"`;
};

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That photo couldn't be opened.")); };
    img.src = url;
  });
}

// Shrinks to 1600 px on the longest side, as a JPEG
async function compress(file) {
  if (!/^image\//.test(file.type || "image/jpeg")) throw new Error("Only photos and pictures can be added.");
  const img = await loadImage(file);
  const w0 = img.naturalWidth || 1, h0 = img.naturalHeight || 1;
  const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w0 * s));
  c.height = Math.max(1, Math.round(h0 * s));
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("That photo couldn't be prepared.");
  return { blob, width: c.width, height: c.height };
}

function viewPhoto(src, name, over = "") {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog ib-preview";
  dlg.innerHTML = `
    <div class="ib-prev-head"><strong>${esc(name || "Photo")}</strong>
      <button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>
    <div class="ib-prev-body"><span class="ph-pic"><img src="${esc(src)}" alt="${esc(name || "Photo")}" />${
      over ? `<img class="ph-over" src="${esc(over)}" alt="Markings" />` : ""}</span></div>`;
  dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
}

// Opens a photo large for drawing. Resolves with the markings (PNG data URL, "" if cleared) or null if cancelled.
function drawOn(src, base) {
  return new Promise((resolve) => {
    let out = null;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ph-draw";
    dlg.innerHTML = `
      <div class="ib-prev-head"><strong>Draw on the photo</strong>
        <div class="ph-draw-acts">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="button" class="lh-btn is-primary" data-act="done">Done</button>
        </div></div>
      <div class="ph-draw-body"><div class="ph-draw-box"></div></div>`;
    document.body.appendChild(dlg);
    const ann = createAnnotator(dlg.querySelector(".ph-draw-box"), src, { base });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.querySelector('[data-act="done"]').addEventListener("click", () => { out = ann.toDataURL(); dlg.close(); });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out); });
    dlg.showModal();
  });
}

// saved: the saved answer ({ photos: [...] }) when viewing a saved form; leave out when filling in
export function mountPhotoField(w, f, { patient = null, saved, onChange = () => {} } = {}) {
  const host = w && w.querySelector("[data-ph-host]");
  if (!host) return;
  const max = Math.max(1, Math.min(10, parseInt(f.max, 10) || 1));

  /* ---------- A saved form ---------- */
  if (saved !== undefined) {
    const photos = saved && Array.isArray(saved.photos) ? saved.photos : [];
    host.innerHTML = photos.length
      ? `<div ${gridAttrs(f)}>${photos.map((p, i) => `
          <div class="ph-tile">
            <button type="button" class="ph-open" data-ph-view="${i}" aria-label="View ${esc(p.name || "photo")}">
              <span class="ph-pic"><img alt="" data-ph-img="${i}" />${p.drawingPath ? `<img class="ph-over" alt="" data-ph-over="${i}" />` : ""}</span>
            </button>
          </div>`).join("")}</div>`
      : '<p class="fe-help">No photos were added.</p>';
    photos.forEach((p, i) => {
      photoSrc(p).then((src) => { const img = host.querySelector(`[data-ph-img="${i}"]`); if (img) img.src = src; }).catch(() => {});
      if (p.drawingPath) {
        photoSrc({ path: p.drawingPath }).then((src) => { const o = host.querySelector(`[data-ph-over="${i}"]`); if (o) o.src = src; }).catch(() => {});
      }
    });
    host.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-ph-view]");
      if (!t) return;
      const p = photos[Number(t.dataset.phView)];
      try {
        const [src, over] = await Promise.all([photoSrc(p), p.drawingPath ? photoSrc({ path: p.drawingPath }) : ""]);
        viewPhoto(src, p.name, over);
      } catch { showToast("This photo couldn't be opened."); }
    });
    return;
  }

  /* ---------- Filling in ---------- */
  if (!patient) {
    host.innerHTML = '<p class="fe-help">Staff take or upload photos here when filling in the form for a patient.</p>';
    return;
  }
  const folder = String(patient.id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  // { status: "uploading" | "done" | "failed", local, photo, file, job, drawing, drawingDirty, drawFailed }
  const items = [];

  async function finalizeDrawings() {
    for (const it of items) {
      if (!it.drawingDirty || it.status !== "done") continue;
      try {
        if (it.drawing) {
          const blob = await (await fetch(it.drawing)).blob();
          const path = `form_photos/${folder}/${Date.now()}-${rand()}-drawing.png`;
          await uploadBytes(sref(storage, path), blob, { contentType: "image/png", cacheControl: "private, max-age=31536000" });
          it.photo = { ...it.photo, drawingPath: path };
        } else {
          const { drawingPath, ...rest } = it.photo;
          it.photo = rest;
        }
        it.drawingDirty = false;
        it.drawFailed = false;
      } catch (err) {
        console.error("Saving the markings failed:", err);
        it.drawFailed = true;
      }
    }
    if (host.isConnected) render();
  }

  w.photoRead = () => ({ photos: items.filter((i) => i.status === "done").map((i) => i.photo) });
  // Save waits for this: uploads finishing, then any markings
  w.photoPending = async () => {
    await Promise.allSettled(items.filter((i) => i.status === "uploading" && i.job).map((i) => i.job));
    await finalizeDrawings();
  };
  w.photoFailed = () => items.some((i) => i.status === "failed" || i.drawFailed);

  function upload(item) {
    item.status = "uploading";
    item.job = (async () => {
      const c = await compress(item.file);
      const path = `form_photos/${folder}/${Date.now()}-${rand()}.jpg`;
      await uploadBytes(sref(storage, path), c.blob, { contentType: "image/jpeg", cacheControl: "private, max-age=31536000" });
      item.photo = { path, name: String(item.file.name || "Photo").slice(0, 120), width: c.width, height: c.height };
      item.status = "done";
    })()
      .catch((err) => { console.error("Photo upload failed:", err); item.status = "failed"; })
      .finally(() => { if (host.isConnected) render(); onChange(); });
    render();
    onChange();
  }

  function addFiles(fileList) {
    const files = [...(fileList || [])];
    const room = max - items.length;
    if (!files.length) return;
    if (files.length > room) showToast(room ? `Only ${room} more photo${room === 1 ? "" : "s"} can be added.` : `This question allows ${max} photo${max === 1 ? "" : "s"}.`);
    files.slice(0, Math.max(0, room)).forEach((file) => {
      const item = { status: "uploading", local: URL.createObjectURL(file), photo: null, file, job: null, drawing: "", drawingDirty: false };
      items.push(item);
      upload(item);
    });
  }

  const srcOf = (it) => (it.local ? Promise.resolve(it.local) : photoSrc(it.photo));

  function render() {
    const tiles = items.map((it, i) => `
      <div class="ph-tile is-${it.status}${it.drawFailed ? " is-failed" : ""}">
        <button type="button" class="ph-open" data-ph-view="${i}" aria-label="View photo ${i + 1}">
          <span class="ph-pic"><img alt="" data-ph-img="${i}" />${it.drawing ? `<img class="ph-over" alt="" src="${esc(it.drawing)}" />` : ""}</span>
        </button>
        ${it.status === "uploading" ? '<span class="ph-st">Uploading…</span>' : ""}
        ${it.status === "failed" ? `<span class="ph-st is-bad">Didn't upload · <button type="button" data-ph-retry="${i}">Retry</button></span>` : ""}
        ${it.drawFailed ? '<span class="ph-st is-bad">Markings didn\'t save. Try saving again.</span>' : ""}
        <div class="ph-bar">
          ${f.annotate ? `<button type="button" class="ph-btn" data-ph-draw="${i}">${I.pen}<span>${it.drawing ? "Edit markings" : "Draw"}</span></button>` : ""}
          <button type="button" class="ph-btn is-danger" data-ph-del="${i}" aria-label="Remove photo ${i + 1}">${I.trash}<span>Remove</span></button>
        </div>
      </div>`).join("");
    const full = items.length >= max;
    host.innerHTML = `
      ${items.length ? `<div ${gridAttrs(f)}>${tiles}</div>` : ""}
      <div class="ph-actions">
        ${full ? "" : `
          <label class="ff-btn">${I.camera}<span>Take photo</span>
            <input type="file" accept="image/*" capture="environment" data-ph-file hidden /></label>
          <label class="ff-btn">${I.upload}<span>Upload</span>
            <input type="file" accept="image/*"${max - items.length > 1 ? " multiple" : ""} data-ph-file hidden /></label>
          ${f.allowBank !== false ? `<button type="button" class="ff-btn" data-ph-bank>${I.bank}<span>Image Bank</span></button>` : ""}`}
        <small class="muted">${items.length} of ${max} photo${max === 1 ? "" : "s"}</small>
      </div>`;
    items.forEach((it, i) => {
      const img = host.querySelector(`[data-ph-img="${i}"]`);
      if (img) srcOf(it).then((src) => { if (img.isConnected) img.src = src; }).catch(() => {});
    });
  }

  host.addEventListener("change", (e) => {
    if (!e.target.matches("[data-ph-file]")) return;
    addFiles(e.target.files);
    e.target.value = "";
  });
  host.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-ph-del]");
    if (del) {
      const [gone] = items.splice(Number(del.dataset.phDel), 1);
      if (gone && gone.local) URL.revokeObjectURL(gone.local);
      render();
      onChange();
      return;
    }
    const retry = e.target.closest("[data-ph-retry]");
    if (retry) { const it = items[Number(retry.dataset.phRetry)]; if (it) upload(it); return; }
    const draw = e.target.closest("[data-ph-draw]");
    if (draw) {
      const it = items[Number(draw.dataset.phDraw)];
      if (!it) return;
      try {
        const out = await drawOn(await srcOf(it), it.drawing || "");
        if (out === null) return; // cancelled
        it.drawing = out;
        it.drawingDirty = true;
        render();
        onChange();
      } catch { showToast("This photo couldn't be opened for drawing."); }
      return;
    }
    const view = e.target.closest("[data-ph-view]");
    if (view) {
      const it = items[Number(view.dataset.phView)];
      if (it) srcOf(it).then((src) => viewPhoto(src, (it.file && it.file.name) || (it.photo && it.photo.name), it.drawing)).catch(() => {});
      return;
    }
    if (e.target.closest("[data-ph-bank]")) {
      if (items.length >= max) return;
      const pick = await openImagePicker({ isAdmin: false });
      if (!pick || !host.isConnected) return;
      items.push({ status: "done", local: "", photo: { bankId: pick.id, name: pick.name }, file: null, job: null, drawing: "", drawingDirty: false });
      render();
      onChange();
    }
  });

  render();
}