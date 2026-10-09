// The Image Bank: pictures in Firebase Storage, their details in Firestore.
// Older Google Drive picture IDs keep working, both before and after moving.
import { db, auth, storage } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref as sref, uploadBytes, getBlob } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { callApi } from "./appointments.js";

const IMAGES = "image_bank";
const FOLDERS = "image_folders";
const TOP = { id: "", name: "Image Bank" };
const FRESH_MS = 30 * 1000;
const driveApi = (op, extra = {}) => callApi({ action: "imageBank", op, ...extra });
const fail = (code, message) => Object.assign(new Error(message || code), { code });
const byName = (a, b) => String(a.name).localeCompare(String(b.name), "en-AU", { numeric: true });
const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);
const cleanName = (s, max) => String(s || "").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function who() {
  const u = auth.currentUser;
  if (!u) throw fail("UNAUTHORIZED");
  let name = "";
  try { name = String((await u.getIdTokenResult()).claims.staffName || ""); } catch { /* not essential */ }
  return { uid: u.uid, name };
}

/* ---------- Everything in the bank, loaded in one go (it's small) ---------- */

let all = null;      // { at, images: Map, folders: Map }
let loading = null;

function toImage(d) {
  const x = d.data() || {};
  return {
    kind: "image", id: d.id, name: x.name || "Image", folderId: x.folderId || "",
    mime: x.mime || "image/png", size: x.size || 0, width: x.width || 0, height: x.height || 0,
    fullPath: x.fullPath || "", thumbPath: x.thumbPath || "", driveId: x.driveId || "",
    trashed: x.trashed === true, updated: ms(x.updatedAt) || ms(x.createdAt) || 1,
  };
}
function toFolder(d) {
  const x = d.data() || {};
  return { kind: "folder", id: d.id, name: x.name || "Folder", parentId: x.parentId || "", driveId: x.driveId || "", trashed: x.trashed === true };
}

async function loadAll(force = false) {
  if (!force && all && Date.now() - all.at < FRESH_MS) return all;
  if (!loading) {
    loading = Promise.all([getDocs(collection(db, IMAGES)), getDocs(collection(db, FOLDERS))])
      .then(([is, fs]) => {
        const images = new Map();
        is.forEach((d) => images.set(d.id, toImage(d)));
        const folders = new Map();
        fs.forEach((d) => folders.set(d.id, toFolder(d)));
        all = { at: Date.now(), images, folders };
        return all;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

// A folder is usable if neither it nor anything above it was deleted
function folderAlive(id, a) {
  let guard = 0;
  while (id && guard++ < 30) {
    const f = a.folders.get(id);
    if (!f || f.trashed) return false;
    id = f.parentId;
  }
  return true;
}
function pathTo(id, a) {
  const out = [];
  let guard = 0;
  while (id && guard++ < 30) {
    const f = a.folders.get(id);
    if (!f) break;
    out.unshift({ id: f.id, name: f.name });
    id = f.parentId;
  }
  return [TOP, ...out];
}
const pubFolder = (f) => ({ kind: "folder", id: f.id, name: f.name });

function listingFor(folderId, a) {
  if (folderId && !folderAlive(folderId, a)) throw fail("NOT_FOUND");
  const folder = folderId ? a.folders.get(folderId) : TOP;
  return {
    ok: true,
    folder: { id: folderId, name: folder.name },
    path: pathTo(folderId, a),
    folders: [...a.folders.values()].filter((f) => !f.trashed && f.parentId === folderId).sort(byName).map(pubFolder),
    images: [...a.images.values()].filter((m) => !m.trashed && m.folderId === folderId).sort(byName),
    next: null,
  };
}

/* ---------- Folder listings: show the last one instantly, then refresh ---------- */

const listCache = new Map(); // folderId ("" = the top folder) -> listing

export function cachedList(folderId) {
  return listCache.get(folderId || "") || null;
}
export function rememberList(listing) {
  if (!listing || !listing.folder) return;
  listCache.set(listing.folder.id || "", listing);
}

export async function bankList(folderId = "") {
  const r = listingFor(folderId || "", await loadAll(true));
  rememberList(r);
  return r;
}

export async function bankSearch(q) {
  const s = String(q || "").trim().toLowerCase();
  const a = await loadAll();
  if (s.length < 2) return { ok: true, folders: [], images: [] };
  return {
    ok: true,
    folders: [...a.folders.values()].filter((f) => folderAlive(f.id, a) && f.name.toLowerCase().includes(s)).sort(byName).map(pubFolder),
    images: [...a.images.values()].filter((m) => !m.trashed && folderAlive(m.folderId, a) && m.name.toLowerCase().includes(s)).sort(byName),
  };
}

export async function bankStats() {
  const a = await loadAll(true);
  const imgs = [...a.images.values()].filter((m) => !m.trashed);
  return { count: imgs.length, fromDrive: imgs.filter((m) => m.driveId).length };
}

/* ---------- Folders and names ---------- */

export async function bankMkdir(parentId, name, { driveId = "" } = {}) {
  const clean = cleanName(name, 80);
  if (!clean) throw fail("BAD_NAME");
  const me = await who();
  const ref = doc(collection(db, FOLDERS));
  await setDoc(ref, {
    name: clean, parentId: parentId || "", trashed: false, driveId,
    createdAt: serverTimestamp(), createdBy: me.name, createdByUid: me.uid,
    updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid,
  });
  const folder = { kind: "folder", id: ref.id, name: clean, parentId: parentId || "", driveId, trashed: false };
  if (all) all.folders.set(ref.id, folder);
  listCache.clear();
  return { ok: true, folder: pubFolder(folder) };
}

export async function bankRename(id, kind, name) {
  let clean = cleanName(name, kind === "folder" ? 80 : 120);
  if (!clean) throw fail("BAD_NAME");
  const a = await loadAll();
  const item = kind === "folder" ? a.folders.get(id) : a.images.get(id);
  if (!item) throw fail("NOT_FOUND");
  if (kind !== "folder") {
    const ext = (item.name.match(/\.[A-Za-z0-9]{2,5}$/) || [""])[0];
    if (ext && !/\.[A-Za-z0-9]{2,5}$/.test(clean)) clean += ext; // keep the file type
  }
  const me = await who();
  await updateDoc(doc(db, kind === "folder" ? FOLDERS : IMAGES, id), {
    name: clean, updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid,
  });
  item.name = clean;
  item.updated = Date.now();
  listCache.clear();
  return { ok: true, name: clean };
}

// Hidden from the bank; forms and emails already using it keep working
export async function bankTrash(id, kind) {
  const a = await loadAll();
  const item = kind === "folder" ? a.folders.get(id) : a.images.get(id);
  if (!item) throw fail("NOT_FOUND");
  const me = await who();
  await updateDoc(doc(db, kind === "folder" ? FOLDERS : IMAGES, id), {
    trashed: true, updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid,
  });
  item.trashed = true;
  listCache.clear();
  return { ok: true };
}

/* ---------- Remembered on this computer (IndexedDB) ---------- */

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
  const d = await openDb();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function idbPut(key, value) {
  const d = await openDb();
  if (!d) return;
  try { d.transaction(STORE, "readwrite").objectStore(STORE).put(value, key); } catch { /* not essential */ }
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/* ---------- Thumbnails ---------- */

const thumbCache = new Map(); // "id:updated" -> Promise<data URL>

export function thumbFor(item) {
  const key = `${item.id}:${item.updated || 0}`;
  if (!thumbCache.has(key)) {
    const job = (async () => {
      const saved = await idbGet(key);
      if (saved) return saved;
      const meta = (all && all.images.get(item.id)) || item;
      const path = meta.thumbPath || meta.fullPath;
      if (!path) return "";
      const url = await blobToDataUrl(await getBlob(sref(storage, path)));
      idbPut(key, url);
      return url;
    })();
    thumbCache.set(key, job);
    job.catch(() => thumbCache.delete(key));
  }
  return thumbCache.get(key);
}

/* ---------- Full-size pictures (by new ID or an older Google Drive ID) ---------- */

async function findMeta(id) {
  if (all) {
    const hit = all.images.get(id) || [...all.images.values()].find((m) => m.driveId === id);
    if (hit) return hit;
  }
  const snap = await getDoc(doc(db, IMAGES, id));
  if (snap.exists()) return toImage(snap);
  const q = await getDocs(query(collection(db, IMAGES), where("driveId", "==", id), limit(1)));
  return q.empty ? null : toImage(q.docs[0]);
}

const imageCache = new Map(); // id -> Promise<data URL>
export function bankImage(id) {
  if (!imageCache.has(id)) {
    const job = (async () => {
      const meta = await findMeta(id).catch(() => null);
      if (meta && meta.fullPath) {
        const key = `full:${meta.id}`; // pictures never change, so they can be kept
        const saved = await idbGet(key);
        if (saved) return saved;
        const url = await blobToDataUrl(await getBlob(sref(storage, meta.fullPath)));
        idbPut(key, url);
        return url;
      }
      // Not moved yet: still in Google Drive
      const r = await driveApi("get", { fileId: id });
      return `data:${r.mime};base64,${r.data}`;
    })();
    imageCache.set(id, job);
    job.catch(() => imageCache.delete(id));
  }
  return imageCache.get(id);
}

/* ---------- Uploading ---------- */

const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_SIDE = 2400;
const MAX_BYTES = 8 * 1024 * 1024;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be opened.")); };
    img.src = url;
  });
}
const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));

// A small copy for the grid (keeps transparency)
async function makeThumb(img) {
  const s = Math.min(1, 400 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  let b = await toBlob(c, "image/webp", 0.82);
  if (!b || b.type !== "image/webp") b = await toBlob(c, "image/png");
  return b;
}

// Shrinks big photos (longest side 2400 px). GIFs are kept as they are.
async function prepareImage(file) {
  if (!OK_TYPES.includes(file.type)) throw fail("BAD_TYPE");
  if (file.size > 25 * 1024 * 1024) throw new Error("That image is over 25 MB.");
  const img = await loadImage(file);
  let width = img.naturalWidth || 1;
  let height = img.naturalHeight || 1;
  let blob = file;
  let mime = file.type;
  if (file.type !== "image/gif") {
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    if (scale < 1 || file.size > 3 * 1024 * 1024) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(width * scale));
      c.height = Math.max(1, Math.round(height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const outMime = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
      const out = await toBlob(c, outMime, 0.88);
      if (out && out.size < file.size) { blob = out; mime = outMime; width = c.width; height = c.height; }
    }
  }
  if (blob.size > MAX_BYTES) throw fail("TOO_LARGE");
  const base = cleanName(file.name.replace(/\.[^.]+$/, ""), 110) || "Image";
  return { blob, mime, name: base + EXT[mime], width, height, thumb: await makeThumb(img) };
}

export async function bankUpload(parentId, file, { driveId = "" } = {}) {
  const p = await prepareImage(file);
  const me = await who();
  const ref = doc(collection(db, IMAGES));
  const fullPath = `${IMAGES}/${ref.id}/full`;
  const thumbPath = `${IMAGES}/${ref.id}/thumb`;
  const meta = { cacheControl: "private, max-age=31536000" };
  await uploadBytes(sref(storage, fullPath), p.blob, { ...meta, contentType: p.mime });
  await uploadBytes(sref(storage, thumbPath), p.thumb, { ...meta, contentType: p.thumb.type || "image/png" });
  await setDoc(ref, {
    name: p.name, folderId: parentId || "", size: p.blob.size, mime: p.mime, width: p.width, height: p.height,
    fullPath, thumbPath, driveId, trashed: false,
    createdAt: serverTimestamp(), createdBy: me.name, createdByUid: me.uid,
    updatedAt: serverTimestamp(), updatedBy: me.name, updatedByUid: me.uid,
  });
  const image = {
    kind: "image", id: ref.id, name: p.name, folderId: parentId || "", mime: p.mime, size: p.blob.size,
    width: p.width, height: p.height, fullPath, thumbPath, driveId, trashed: false, updated: Date.now(),
  };
  if (all) all.images.set(ref.id, image);
  listCache.clear();
  return { ok: true, image };
}

/* ---------- Moving the Google Drive Image Bank across ---------- */

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Copies folders and pictures not moved yet. Safe to run again. Nothing is deleted from Drive.
export async function migrateFromDrive(onProgress = () => {}) {
  const a = await loadAll(true);
  const moved = new Set([...a.images.values()].map((m) => m.driveId).filter(Boolean));
  const folderMap = new Map([...a.folders.values()].filter((f) => f.driveId && !f.trashed).map((f) => [f.driveId, f.id]));
  const todo = [];
  let folders = 0;

  onProgress({ stage: "scan" });
  async function walk(driveFolderId, parentId) {
    let offset = 0;
    let first = true;
    while (offset !== null && offset !== undefined) {
      const r = await driveApi("list", { folderId: driveFolderId, offset });
      if (first) {
        for (const f of r.folders || []) {
          let fid = folderMap.get(f.id);
          if (!fid) {
            fid = (await bankMkdir(parentId, f.name, { driveId: f.id })).folder.id;
            folderMap.set(f.id, fid);
            folders++;
          }
          await walk(f.id, fid);
        }
        first = false;
      }
      (r.images || []).forEach((m) => { if (!moved.has(m.id)) todo.push({ id: m.id, name: m.name, parentId }); });
      offset = r.next;
    }
  }
  await walk("", "");

  const total = todo.length;
  let done = 0;
  let failed = 0;
  onProgress({ stage: "copy", done, total, failed });
  const worker = async () => {
    while (todo.length) {
      const m = todo.shift();
      try {
        const r = await driveApi("get", { fileId: m.id });
        await bankUpload(m.parentId, new File([b64ToBlob(r.data, r.mime)], m.name, { type: r.mime }), { driveId: m.id });
      } catch (err) {
        console.warn(`Couldn't move "${m.name}":`, err);
        failed++;
      }
      done++;
      onProgress({ stage: "copy", done, total, failed });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await loadAll(true);
  return { moved: done - failed, failed, folders };
}

/* ---------- Messages ---------- */

export function bankError(err) {
  const code = err && err.code;
  switch (code) {
    case "UNAUTHORIZED": return "Your session has expired. Log out and back in, then try again.";
    case "FORBIDDEN":
    case "permission-denied":
    case "storage/unauthorized":
      return "Only admins can change the Image Bank. If you are an admin, check the new Firestore and Storage rules have been published.";
    case "NOT_FOUND":
    case "storage/object-not-found":
      return "That item couldn't be found. It may have been deleted.";
    case "BAD_TYPE": return "Only PNG, JPG, WebP or GIF images can be uploaded.";
    case "TOO_LARGE": return "That image is too large (8 MB maximum).";
    case "BAD_NAME": return "Enter a name.";
    case "storage/retry-limit-exceeded":
    case "unavailable":
      return "The connection dropped. Check your internet and try again.";
    case "NO_IMAGE_BANK": return "The Google Drive Image Bank isn't set up, so there's nothing to move.";
    case "INVALID_PIN": return "The server hasn't been updated yet. In Apps Script, deploy a new version.";
    case "SERVER_ERROR": return "Something went wrong in Apps Script. Check Apps Script → Executions for details.";
    default:
      return err && err.message && !code ? err.message
        : `Something went wrong${code ? ` (${code})` : ""}. Check your connection and try again.`;
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