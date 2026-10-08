// Talking to the Image Bank (Google Drive folder) through the portal's Apps Script
import { callApi } from "./appointments.js";

const api = (op, extra = {}) => callApi({ action: "imageBank", op, ...extra });

export const bankList = (folderId = "", offset = 0) => api("list", { folderId, offset });
export const bankSearch = (q) => api("search", { q });
export const bankMkdir = (parentId, name) => api("mkdir", { parentId, name });
export const bankRename = (id, kind, name) => api("rename", { id, kind, name });
export async function bankTrash(id, kind) {
  const res = await api("trash", { id, kind });
  imageCache.delete(id);
  return res;
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