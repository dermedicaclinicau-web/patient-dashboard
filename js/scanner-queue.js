// Scanner: each photo is read and saved in the background, so staff can take the next one straight away.
// Photos stay on this device (IndexedDB) until they're saved, so locking the iPad or closing the app never loses one.
// Prescriptions and billing sheets are saved (or sent to be checked). Dockets, photos it couldn't sort, and ones it
// couldn't read are kept under Ready to check for the person who took them.
import { auth } from "./firebase-config.js";
import { preparePhoto, readAuto, readForQueue, setScanJob, newScanJobId, parkScan, openScanJob, finishScanJob } from "./scanner-api.js";
import { autoRx, autoBilling } from "./scanner-rx-auto.js";
import { listProducts } from "./inventory-api.js";
import { rxProductList } from "./rx-products.js";
import { showToast } from "./utils.js";

const DB = "dm-scan-queue", STORE = "items";
const AT_ONCE = 2;   // read at the same time
const TRIES = 3;     // connection problems, before it asks
const KINDS = ["billing", "docket", "rx"];

/* ---------- Kept on this device ---------- */
function openDb() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error("No storage")); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function store(mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(req && req.result); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}
const saveItem = (it, blob) => store("readwrite", (s) => s.put({ ...it, blob }, it.id)).catch(() => {});
const dropItem = (id) => store("readwrite", (s) => s.delete(id)).catch(() => {});
const allItems = () => store("readonly", (s) => s.getAll()).then((x) => x || []).catch(() => []);

/* ---------- The queue ---------- */
const items = new Map();   // id → { id, kind, uid, by, at, status: waiting | working | retry | stuck, tries, again }
const blobs = new Map();
let running = 0, staffNow = null, resumed = false;
const subs = new Set();
const emit = (type) => subs.forEach((f) => { try { f(type); } catch (err) { console.warn(err); } });
const me = () => (auth.currentUser && auth.currentUser.uid) || "";
const mine = (it) => !it.uid || it.uid === me();   // someone else's photos wait for them to sign in again
const who = (r) => (r && r.name) || "the team";

export const onQueueChange = (f) => { subs.add(f); return () => subs.delete(f); };
export function queueState() {
  const list = [...items.values()].filter(mine);
  return { busy: list.filter((x) => x.status !== "stuck").length, stuck: list.filter((x) => x.status === "stuck").length };
}

let prodP = null, prodAt = 0;
function products() {
  if (!prodP || Date.now() - prodAt > 10 * 60000) {
    prodAt = Date.now();
    prodP = listProducts().then((l) => l.filter((p) => p.active)).catch((err) => { prodP = null; throw err; });
  }
  return prodP;
}

export function queueScan(blob, kind, staff) {
  if (staff) staffNow = staff;
  const it = { id: newScanJobId(), kind, uid: me(), by: (staff && staff.name) || "", at: Date.now(), status: "waiting", tries: 0 };
  items.set(it.id, it);
  blobs.set(it.id, blob);
  saveItem(it, blob);
  pump();
}

// Photos left from before (the app was closed, or the iPad locked, before they were saved)
export async function resumeQueue(staff) {
  if (staff) staffNow = staff;
  if (resumed) { pump(); return; }
  resumed = true;
  (await allItems()).forEach((x) => {
    if (!x || !x.id || items.has(x.id) || !x.blob) return;
    items.set(x.id, { id: x.id, kind: x.kind, uid: x.uid || "", by: x.by || "", at: x.at || 0, status: "waiting", tries: 0, again: true });
    blobs.set(x.id, x.blob);
  });
  pump();
}

export function retryStuck() {
  items.forEach((it) => { if (it.status === "stuck" && mine(it)) Object.assign(it, { status: "waiting", tries: 0, again: true }); });
  pump();
}
export function dropStuck() {
  [...items.values()].filter((it) => it.status === "stuck" && mine(it)).forEach((it) => forget(it.id));
  emit("changed");
}
window.addEventListener("online", retryStuck);

function forget(id) { items.delete(id); blobs.delete(id); dropItem(id); }

function pump() {
  for (const it of items.values()) {
    if (running >= AT_ONCE) break;
    if (it.status !== "waiting" || !me() || !mine(it)) continue;
    it.status = "working";
    running++;
    work(it).finally(() => { running--; pump(); });
  }
  emit("changed");
}

async function work(it) {
  try {
    const prep = await preparePhoto(blobs.get(it.id), 1600, 0.8, it.kind === "auto" ? 768 : 0);
    // Tried before: the answer may already be kept on the server, so the AI isn't paid for twice
    const read = (it.again && await fromServer(it.id)) || await readIt(it, prep);
    it.again = true;
    await finish(it, prep, read);
    forget(it.id);
  } catch (err) {
    it.tries++;
    console.warn(`Background scan failed (try ${it.tries}):`, err);
    if ((err && err.code === "UNAUTHORIZED") || it.tries >= TRIES) { it.status = "stuck"; emit("changed"); return; }
    it.status = "retry";
    setTimeout(() => {
      if (items.get(it.id) === it && it.status === "retry") { it.status = "waiting"; pump(); }
    }, 15000 * it.tries);
  }
}

async function fromServer(id) {
  try {
    const j = await openScanJob(id);
    const kind = KINDS.includes(j && j.readAs) ? j.readAs : KINDS.includes(j && j.kind) ? j.kind : "";
    if (j && j.status === "ready" && j.result && kind) return { kind, result: j.result, problem: "" };
  } catch { /* not kept: read it again */ }
  return null;
}

// The job ID is picked up when the request starts, so it's set and cleared around the call
async function readIt(it, prep) {
  const rx = rxProductList();
  if (it.kind === "rx" || it.kind === "billing") {
    if (it.kind === "rx" && !rx.length) throw new Error("The prescription product list is empty.");
    const prods = it.kind === "billing" ? await products() : [];
    setScanJob(it.id);
    const p = readForQueue(it.kind, prep.base64, prods, rx);
    setScanJob("", it.id);
    return { kind: it.kind, ...(await p) };
  }
  const prods = await products();
  setScanJob(it.id);
  const p = readAuto(prep.base64, prep.thumb, prods, rx);
  setScanJob("", it.id);
  const r = await p;
  const a = r.auto || {};
  return { kind: KINDS.includes(a.kind) && !a.notAllowed ? a.kind : "", result: r.result, problem: r.problem || "" };
}

async function finish(it, prep, read) {
  const ok = !!read.kind && !!read.result && !read.problem;
  if (ok && read.kind === "rx") {
    const d = await autoRx({ photo: prep.blob, result: read.result, staff: staffNow });
    finishScanJob(it.id);
    showToast(d.saved ? `✓ Prescription saved to ${d.patient.name}` : `Prescription sent to ${who(d.reviewer)} to check`);
    emit("saved");
    return;
  }
  if (ok && read.kind === "billing") {
    const d = await autoBilling({ photo: prep.blob, result: read.result, products: await products(), staff: staffNow });
    finishScanJob(it.id);
    showToast(d.saved ? `✓ Billing sheet saved${d.name ? `: ${d.name}` : ""}`
      : `Billing sheet${d.name ? ` for ${d.name}` : ""} saved and sent to ${who(d.reviewer)} to check`);
    emit("saved");
    return;
  }
  // A docket, not sure what it is, or not read: kept under Ready to check, to open and finish
  await parkScan(it.id, prep.base64, it.kind, it.kind === "auto" ? read.kind : "");
  showToast(ok && read.kind === "docket" ? "Delivery docket read. Open it under Ready to check to receive it."
    : read.problem ? "A scan couldn't be read. It's under Ready to check to try again."
    : "Couldn't tell what one photo is. Choose it under Ready to check.");
  emit("parked");
}