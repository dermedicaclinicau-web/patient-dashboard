// Talking to the Image Bank (Google Drive folder) through the portal's Apps Script.
// Folder listings and thumbnails are remembered so the bank opens quickly.
import { callApi } from "./appointments.js";

const api = (op, extra = {}) => callApi({ action: "imageBank", op, ...extra });

/* ---------- Folder listings: show the last one instantly, then refresh ---------- */

const listCache = new Map(); // folderId ("" = the top folder) -> listing

export function cachedList(folderId) {
  return listCache.get(folderId || "") || null;
}

export function rememberList(listing) {
  if (!listing || !listing.folder) return;
  listCache.set(listing.folder.id, listing);
  if (listing.path && listing.path.length === 1) listCache.set("", listing); // the top folder
}

export async function bankList(folderId = "", offset = 0) {
  const r = await api("list", { folderId, offset });
  if (!offset) rememberList(r);
  return r;
}

export const bankSearch = (q) => api("search", { q });
export const bankMkdir = (parentId, name) => api("mkdir", { parentId, name });
export const bankRename = (id, kind, name) => api("rename", { id, kind, name });
export async function bankTrash(id, kind) {
  const res = await api("trash", { id, kind });
  imageCache.delete(id);
  return res;
}

/* ---------- Thumbnails: remembered on this computer, fetched in small batches ---------- */

const DB_NAME = "dermedica-image-bank";
const STORE = "thumbs";
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (!("indexedDB" in window)) { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}
async function idbGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function idbPut(key, value) {
  const db = await openDb();
  if (!db) return;
  try { db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key); } catch { /* not essential */ }
}

const thumbCache = new Map(); // "id:updated" -> Promise<data URL>
let queue = [];
let timer = null;
let active = 0;
const BATCH = 10;
const PARALLEL = 4;

function schedule() { if (!timer) timer = setTimeout(pump, 30); }
function pump() {
  timer = null;
  while (queue.length && active < PARALLEL) {
    const batch = queue.splice(0, BATCH);
    active++;
    api("thumbs", { ids: batch.map((b) => b.id) })
      .then((r) => batch.forEach((b) => b.resolve((r.thumbs || {})[b.id] || "")))
      .catch((err) => batch.forEach((b) => b.reject(err)))
      .finally(() => { active--; if (queue.length) schedule(); });
  }
}

// The thumbnail for one image (an image in a listing: { id, updated })
export function thumbFor(item) {
  const key = `${item.id}:${item.updated || 0}`;
  if (!thumbCache.has(key)) {
    const job = (async () => {
      const saved = await idbGet(key);
      if (saved) return saved;
      const url = await new Promise((resolve, reject) => { queue.push({ id: item.id, resolve, reject }); schedule(); });
      if (url) idbPut(key, url);
      return url;
    })();
    thumbCache.set(key, job);
    job.catch(() => thumbCache.delete(key));
  }
  return thumbCache.get(key);
}

/* ---------- Full-size images, remembered for this session ---------- */

const imageCache = new Map(); // fileId -> Promise<data URL>
export function bankImage(fileId) {
  if (!imageCache.has(fileId)) {
    imageCache.set(fileId, api("get", { fileId })
      .then((r) => `data:${r.mime};base64,${r.data}`)
      .catch((err) => { imageCache.delete(fileId); throw err; }));
  }
  return imageCache.get(fileId);
}

/* ---------- Uploading ---------- */

const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_SIDE = 2400;
const MAX_BYTES = 8 * 1024 * 1024;

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be opened.")); };
    img.src = url;
  });
}

// Shrinks big photos (longest side 2400 px) so the bank stays quick. GIFs are kept as they are.
async function prepareImage(file) {
  if (!OK_TYPES.includes(file.type)) throw new Error("Only PNG, JPG, WebP or GIF images can be uploaded.");
  if (file.size > 25 * 1024 * 1024) throw new Error("That image is over 25 MB.");
  let blob = file;
  let mime = file.type;
  if (file.type !== "image/gif") {
    const img = await loadImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    if (scale < 1 || file.size > 3 * 1024 * 1024) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const outMime = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
      const out = await new Promise((r) => c.toBlob(r, outMime, 0.88));
      if (out && out.size < file.size) { blob = out; mime = outMime; }
    }
  }
  if (blob.size > MAX_BYTES) throw new Error("That image is too large, even after shrinking it (8 MB maximum).");
  const base = file.name.replace(/\.[^.]+$/, "").trim() || "Image";
  return { data: await blobToBase64(blob), mime, name: base + EXT[mime] };
}

export async function bankUpload(parentId, file) {
  const img = await prepareImage(file);
  return api("upload", { parentId, ...img });
}

/* ---------- Messages ---------- */

export function bankError(err) {
  switch (err && err.code) {
    case "UNAUTHORIZED": return "Your session has expired. Log out and back in, then try again.";
    case "FORBIDDEN": return "Only admins can change the Image Bank.";
    case "NO_IMAGE_BANK": return "The Image Bank isn't set up yet. Add IMAGE_BANK_FOLDER_ID in Apps Script → Project Settings → Script Properties.";
    case "NOT_FOUND": return "That item couldn't be found. It may have been moved or deleted in Google Drive.";
    case "BAD_TYPE": return "Only PNG, JPG, WebP or GIF images can be uploaded.";
    case "TOO_LARGE": return "That image is too large (8 MB maximum).";
    case "BAD_NAME": return "Enter a name.";
    case "CANT_DELETE": return "Google Drive wouldn't let the portal delete this. In a shared folder, only the file's owner can delete it.";
    case "INVALID_PIN": return "The server hasn't been updated yet. In Apps Script, deploy a new version.";
    case "SERVER_ERROR": return "Something went wrong in Apps Script. Check Apps Script → Executions for details.";
    default:
      return err && err.message && !err.code ? err.message
        : `Something went wrong${err && err.code ? ` (${err.code})` : ""}. Check your connection and try again.`;
  }
}

/* ---------- Pictures on forms ---------- */

const escAttr = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Fills in every [data-bank-img] placeholder inside an element with its Image Bank picture
export function hydrateBankImages(root) {
  if (!root) return;
  root.querySelectorAll("[data-bank-img]:not([data-ready])").forEach((el) => {
    el.setAttribute("data-ready", "1");
    bankImage(el.dataset.bankImg)
      .then((src) => {
        if (el.isConnected) el.innerHTML = `<img src="${escAttr(src)}" alt="${escAttr(el.dataset.alt || "")}" />`;
      })
      .catch(() => {
        if (el.isConnected) el.innerHTML = '<span class="fe-img-missing">This picture is missing from the Image Bank</span>';
      });
  });
}