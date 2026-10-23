// Scanner (#/scanner): billing sheets, delivery dockets and product prescriptions.
// Gemini reads the photo (through Apps Script); the portal matches it to the product list and flags anything that doesn't line up.
// Billing sheets are matched to that day's booking, so the scan shows on the patient's dashboard.
// Saving keeps the scan and its photo. Stock comes off the Shelf when the Timely invoices are uploaded.
//
// Also on this screen: a blurry / dark photo check, the screen kept awake, the last tab remembered, progress while reading,
// multi-page dockets, today's scans, any-patient search for billing sheets, unread photos kept on the device,
// Auto (takes the photo when held still) and Space / Enter to take the photo on a computer.
import { listProducts, INV_CATEGORIES, plural } from "./inventory-api.js";
import { preparePhoto, readBillingSheet, readDocket, readPrescription, startReview, reviewBilling, saveBillingScan,
  earlierScans, findBooking, money, searchPatientsQuick, todaysScans } from "./scanner-api.js";
import { mountRxResult } from "./scanner-rx.js";
import { rxProductList } from "./rx-products.js";
import { mountDocketResult } from "./scanner-docket.js";
import { showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";
import { warmUpLogin } from "./auth.js";
import { can } from "./perms.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  photo: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  camera: svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  bolt: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
};
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const KIND_KEY = "dm.scanKind";   // the last tab used on this device
const AUTO_KEY = "dm.scanAuto";   // Auto on or off on this device
const MAX_PAGES = 3;
const KIND_TAG = { billing: "Billing", docket: "Docket", rx: "Prescription" };
const readLocal = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const writeLocal = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

// Only one Scanner holds the camera: this switches off the one before
let releaseCamera = null;

// Phones and tablets (iPads report themselves as a Mac, but have a touch screen)
const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));

/* ===================== Shutter sound ===================== */
// Made by the browser (no sound file). The first tap on the Scanner unlocks sound, so Auto can click too.
// A short buzz as well, on phones that can (Android). iPhones and iPads stay quiet when their silent switch is on.
let audioCtx = null;
function audio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch { return null; }
}
function shutterSound() {
  try {
    const ctx = audio();
    if (ctx) {
      const now = ctx.currentTime;
      const click = (at, len, gain, freq) => {
        const n = Math.max(1, Math.floor(ctx.sampleRate * len));
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 0.8;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(f).connect(g).connect(ctx.destination);
        src.start(now + at);
      };
      click(0, 0.05, 0.9, 2600);     // the shutter opening
      click(0.07, 0.07, 0.7, 1500);  // and closing
    }
  } catch { /* no sound on this device */ }
  try { if (navigator.vibrate) navigator.vibrate(25); } catch { /* ignore */ }
}

/* ===================== Photo checks and pages ===================== */
async function decode(b) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(b, { imageOrientation: "from-image" }); }
    catch { try { return await createImageBitmap(b); } catch { /* fall back to <img> */ } }
  }
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(b);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(u); res(img); };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error("That photo couldn't be opened. Try another.")); };
    img.src = u;
  });
}
const dims = (im) => [im.naturalWidth || im.width, im.naturalHeight || im.height];
const done = (im) => { if (im && im.close) im.close(); };

// Brightness (0-255) and sharpness (how much the edges change). Checked on a small copy, so it's quick.
async function photoQuality(blob) {
  try {
    const im = await decode(blob);
    const [iw, ih] = dims(im);
    const w = 320, h = Math.max(3, Math.round(ih * (w / iw)));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(im, 0, 0, w, h);
    done(im);
    const d = g.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += gray[j]; }
    const mean = sum / gray.length;
    let ls = 0, lq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      const lap = gray[k - w] + gray[k + w] + gray[k - 1] + gray[k + 1] - 4 * gray[k];
      ls += lap; lq += lap * lap; n++;
    }
    const lm = ls / n;
    const sharp = lq / n - lm * lm;
    console.log(`Scanner photo check: brightness ${Math.round(mean)}, sharpness ${Math.round(sharp)}`);
    return { dark: mean < 70, blurry: sharp < 50 };
  } catch { return { dark: false, blurry: false }; }   // can't check: carry on
}

// Several docket pages joined top to bottom, read as one photo
async function stitchPages(blobs) {
  if (blobs.length === 1) return blobs[0];
  const ims = await Promise.all(blobs.map(decode));
  const W = Math.min(1600, Math.max(...ims.map((im) => dims(im)[0])));
  const GAP = 24;
  const hs = ims.map((im) => { const [w, h] = dims(im); return Math.round(h * (W / w)); });
  const c = document.createElement("canvas");
  c.width = W;
  c.height = hs.reduce((a, b) => a + b, 0) + GAP * (ims.length - 1);
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, c.width, c.height);
  let y = 0;
  ims.forEach((im, i) => { g.drawImage(im, 0, y, W, hs[i]); y += hs[i] + GAP; done(im); });
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("The pages couldn't be joined. Try again."))), "image/jpeg", 0.9));
}

const blobToB64 = (b) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] || "");
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

/* ===================== An unfinished scan, kept on this device ===================== */
// One at a time: kept from when the photo is taken until the scan is saved or discarded.
const PDB = "dm-scanner", PSTORE = "pending";
function openIdb() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error("No storage")); return; }
    const r = indexedDB.open(PDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(PSTORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const idb = await openIdb();
  return new Promise((res, rej) => {
    const tx = idb.transaction(PSTORE, mode);
    const req = fn(tx.objectStore(PSTORE));
    tx.oncomplete = () => { idb.close(); res(req && req.result); };
    tx.onerror = () => { idb.close(); rej(tx.error); };
  });
}
const pendingGet = () => idbDo("readonly", (s) => s.get("current")).catch(() => null);
const pendingPut = (v) => idbDo("readwrite", (s) => s.put(v, "current")).catch(() => {});
const pendingClear = () => idbDo("readwrite", (s) => s.delete("current")).catch(() => {});

// A booking → the patient saved with the scan
const fromBooking = (a) => (a ? { id: String(a.patientId || ""), name: a.patientName || "", time: a.time || "", staff: a.staff || "" } : null);

export function mountScanner(container, { staff = null } = {}) {
  if (releaseCamera) releaseCamera();   // an earlier Scanner (the page drawn again) lets go of the camera
  const root = document.createElement("section");
  root.className = "page scan";
  container.replaceChildren(root);
  // Which kinds of scan this person can do (Staff → Roles & access)
  const KINDS = [["billing", "Billing sheet"], ["docket", "Delivery docket"], ["rx", "Prescription"]].filter(([k]) => can(`scanner.${k}`));
  if (!KINDS.length) {
    root.innerHTML = `<div class="state"><strong>No scanner access</strong>
      Ask an Admin to tick “Scan billing sheets”, “Scan delivery dockets” or “Scan product prescriptions” for your role in Staff → Roles &amp; access.</div>`;
    return;
  }

  // The product list (with Shelf stock)
  let products = [];
  const productsReady = listProducts().then((list) => { products = list.filter((p) => p.active); })
    .catch((err) => console.error("Scanner: the product list didn't load", err));
  warmUpLogin();   // wakes Apps Script while the photo is being lined up, so the first scan isn't slow

  const savedKind = readLocal(KIND_KEY);
  const st = {
    mode: "camera", stream: null, track: null, starting: false, zoom: 1, hw: null, torch: false, canTorch: false, canFocus: false,
    camErr: "", photo: null, photoUrl: "", base64: "", result: null, lines: [], review: null, error: "", fixing: -1, busy: false,
    booking: null, patient: null, pickPatient: false, shooting: false,
    kind: KINDS.some(([k]) => k === savedKind) ? savedKind : KINDS[0][0],
    pages: [], pageUrls: [],                      // docket pages taken so far
    auto: readLocal(AUTO_KEY) === "1",
    pendingInfo: null, readThisSession: false,    // an unfinished scan from before
    today: null, todayAt: 0, todayOpen: false,    // today's scans
    step: 0, busyT0: 0, secTimer: 0,              // progress while reading
    pq: "", phits: [], psearching: false,         // billing: search all patients
  };
  const setKind = (k) => { st.kind = k; writeLocal(KIND_KEY, k); };

  const sellCount = () => st.lines.reduce((a, l) => a + (l.product ? l.take || 0 : 0), 0);
  const sellText = () => (sellCount()
    ? `${plural(sellCount(), "product")} recorded as given. Stock comes off the Shelf when the Timely invoices are uploaded.`
    : "No products recorded as given.");
  const saveLabel = () => "Save";
  // The booked (or chosen) name when there is one, else the name read from the sheet
  const patientName = () => (st.patient && st.patient.name) || (st.review && st.review.patientName) || "";

  /* ===================== Screens ===================== */
  const headHtml = () => (KINDS.length < 2 ? "" : `<div class="scan-head"><div class="scan-modes" role="tablist" aria-label="What you're scanning">
      ${KINDS.map(([k, label]) => `<button type="button" class="scan-mode${st.kind === k ? " is-on" : ""}" role="tab"
        aria-selected="${st.kind === k}" data-kind="${k}">${label}</button>`).join("")}
    </div></div>`);

  const tipText = () => (st.kind === "docket"
    ? (st.pages.length ? `Page ${st.pages.length + 1}: fit the whole page inside the frame` : "Fit the whole delivery docket inside the frame")
    : st.kind === "rx" ? "Fit the whole prescription inside the frame" : "Fit the billing sheet and the products inside the frame");

  // The viewfinder before the camera picture arrives: starting, or why it can't
  const waitHtml = () => (st.camErr
    ? `${I.camera}<strong>The camera couldn't start</strong><p>${esc(st.camErr)}</p>
       <button type="button" class="lh-btn" data-act="cam-retry">Try again</button>`
    : `<span class="scan-wait-spin" aria-hidden="true"></span><strong>Starting the camera…</strong>
       <p>If your device asks to use the camera, tap Allow.</p>`);

  const pendingHtml = () => {
    const p = st.pendingInfo;
    if (!p) return "";
    const when = new Date(p.at).toLocaleString("en-AU", { weekday: "short", hour: "numeric", minute: "2-digit" });
    return `<div class="scan-pending" role="status">
      <span><strong>A ${esc(KIND_TAG[p.kind].toLowerCase())} scan wasn't finished</strong>
        (taken ${esc(when)}${p.by ? ` by ${esc(p.by)}` : ""}). It's kept on this device.</span>
      <button type="button" class="lh-btn is-primary" data-act="pend-open">Open it</button>
      <button type="button" class="lh-btn is-quiet" data-act="pend-drop">Discard</button>
    </div>`;
  };

  const todayHtml = () => {
    const t = st.today;
    if (!t) return "";
    if (!t.length) return '<div class="scan-today is-empty"><span class="muted">Nothing scanned yet today.</span></div>';
    const n = (k) => t.filter((s) => s.kind === k).length;
    const parts = [
      n("billing") && plural(n("billing"), "billing sheet"),
      n("docket") && plural(n("docket"), "docket"),
      n("rx") && plural(n("rx"), "prescription"),
    ].filter(Boolean);
    const flagged = t.filter((s) => s.kind === "billing" && Number(s.flagCount) > 0).length;
    const row = (s) => {
      const at = s.at && typeof s.at.toDate === "function" ? s.at.toDate() : null;
      const time = at ? at.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "";
      const who = s.kind === "docket"
        ? `${s.supplierName || "Delivery docket"}${s.poNumber ? ` · ${s.poNumber}` : ""}`
        : (s.patientName || "Patient not read");
      const status = s.kind === "billing" ? (Number(s.flagCount) ? `${s.flagCount} to check` : "All matched")
        : s.kind === "docket" ? ({ received: "Received", linked: "Linked to an order", unlinked: "No order linked" }[s.status] || "")
        : Array.isArray(s.items) ? plural(s.items.length, "item") : "";
      return `<li>
        <span class="scan-today-k is-${esc(s.kind)}">${esc(KIND_TAG[s.kind] || s.kind)}</span>
        <span class="scan-today-main"><strong>${esc(who)}</strong>
          <small>${esc([time, s.by && `by ${s.by}`, status].filter(Boolean).join(" · "))}</small></span>
        ${s.photo && s.photo.url ? `<a class="scan-pat-btn" href="${esc(s.photo.url)}" target="_blank" rel="noopener">Photo</a>` : ""}
      </li>`;
    };
    return `<details class="scan-today" data-role="today"${st.todayOpen ? " open" : ""}>
      <summary><strong>Today</strong> ${esc(parts.join(" · "))}${flagged ? ` · <span class="scan-today-flag">${flagged} flagged</span>` : ""}</summary>
      <ul>${t.slice(0, 40).map(row).join("")}</ul>
    </details>`;
  };

  const cameraHtml = () => `${headHtml()}
    <div data-role="pending-host">${pendingHtml()}</div>
    ${st.kind === "docket" && st.pages.length
      ? `<button type="button" class="scan-pageback" data-act="page-back">← Back to ${plural(st.pages.length, "page")}</button>` : ""}
    <div class="scan-vf" data-role="vf">
      <video playsinline muted autoplay></video>
      <div class="scan-frame" aria-hidden="true"></div>
      <span class="scan-focus" data-role="focus" aria-hidden="true"></span>
      <div class="scan-wait" data-role="wait" aria-live="polite">${waitHtml()}</div>
      <p class="scan-tip" data-role="tip">${esc(tipText())}</p>
      <button type="button" class="scan-auto${st.auto ? " is-on" : ""}" data-act="auto" aria-pressed="${st.auto}"
        title="Takes the photo by itself when the device is held still over a sheet">Auto</button>
      <div class="scan-zoom" role="group" aria-label="Zoom">${[1, 1.5, 2].map((z) =>
        `<button type="button" data-zoom="${z}" class="${z === st.zoom ? "is-on" : ""}">${z}×</button>`).join("")}</div>
      <button type="button" class="scan-torch" data-act="torch" aria-label="Torch" hidden>${I.bolt}</button>
    </div>
    <div class="scan-bar">
      <label class="scan-side">${I.photo}<span>Upload</span><input type="file" accept="image/*" data-role="file" hidden /></label>
      <button type="button" class="scan-shutter" data-act="shoot" aria-label="Take the photo"><span></span></button>
      <label class="scan-side">${I.camera}<span>Camera app</span><input type="file" accept="image/*" capture="environment" data-role="file" hidden /></label>
    </div>
    ${isMobile() ? "" : '<p class="scan-keys">Tip: press Space to take the photo.</p>'}
    <div data-role="today-host">${todayHtml()}</div>`;

  const stepNames = () => [
    "Preparing the photo",
    st.kind === "docket" ? "Reading the docket" : st.kind === "rx" ? "Reading the prescription" : "Reading the handwriting and products",
    st.kind === "rx" ? "Getting it ready to check" : st.kind === "docket" ? "Finding the purchase order" : "Matching products and the booking",
  ];
  const stepsHtml = () => stepNames().map((t, i) =>
    `<li class="${i < st.step ? "is-done" : i === st.step ? "is-on" : ""}">${esc(t)}</li>`).join("");
  const busyHtml = () => `${headHtml()}
    <div class="scan-shot">${st.photoUrl ? `<img src="${st.photoUrl}" alt="The photo being read" />` : ""}
      <div class="scan-busy">
        <ol class="scan-steps" data-role="steps">${stepsHtml()}</ol>
        <small class="scan-secs" data-role="secs"></small>
      </div></div>`;

  const errorHtml = () => `${headHtml()}
    ${st.photoUrl ? `<div class="scan-shot"><img src="${st.photoUrl}" alt="The photo" /></div>` : ""}
    <p class="scan-err">${esc(st.error)}</p>
    ${st.base64 ? '<p class="dk-muted">The photo is kept on this device, so you can try again later too.</p>' : ""}
    <div class="scan-acts">
      <button type="button" class="lh-btn" data-act="again">Scan again</button>
      ${st.base64 ? '<button type="button" class="lh-btn is-primary" data-act="retry">Try again</button>' : ""}
    </div>`;

  const pagesHtml = () => `${headHtml()}
    <div class="scan-pages">
      <h3 class="dk-h">Delivery docket <small>${plural(st.pages.length, "page")}</small></h3>
      <p class="dk-muted">More than one page? Add each page, then read them together.</p>
      <div class="scan-page-list">${st.pageUrls.map((u, i) => `
        <figure class="scan-page"><img src="${u}" alt="Page ${i + 1}" />
          <figcaption>Page ${i + 1}</figcaption>
          <button type="button" class="scan-page-x" data-pagedel="${i}" aria-label="Remove page ${i + 1}">×</button></figure>`).join("")}</div>
      <div class="scan-acts">
        <button type="button" class="lh-btn is-quiet" data-act="again">Start over</button>
        ${st.pages.length < MAX_PAGES
          ? '<button type="button" class="lh-btn" data-act="page-add">+ Add another page</button>'
          : `<small class="dk-muted">Up to ${MAX_PAGES} pages.</small>`}
        <button type="button" class="lh-btn is-primary" data-act="page-read">${st.pages.length > 1 ? `Read all ${st.pages.length} pages` : "Read the docket"}</button>
      </div>
    </div>`;

  const fixHtml = (l, i) => `<select class="fb-select scan-fix" data-fixsel="${i}" aria-label="Which product is it?">
      <option value="">Not on the product list</option>
      ${INV_CATEGORIES.map((c) => {
        const g = products.filter((p) => p.category === c.key);
        return g.length ? `<optgroup label="${esc(c.label)}">${g.map((p) =>
          `<option value="${esc(p.id)}"${p.id === l.productId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>` : "";
      }).join("")}
    </select>`;

  // Billing: search all patients (walk-ins, or a sheet with the wrong date)
  const bpHitsHtml = () => (st.psearching ? '<p class="muted">Searching…</p>'
    : st.pq.trim().length < 2 ? ""
    : !st.phits.length ? '<p class="muted">No patients match.</p>'
    : st.phits.map((p, i) => `<button type="button" class="rx-hit" data-bppick="${i}"><strong>${esc(p.name)}</strong>
        <small>${esc([p.pttId && `ID ${p.pttId}`, p.dob || p.dobKey].filter(Boolean).join(" · "))}</small></button>`).join(""));

  // Which booking (or patient) this sheet belongs to
  const patientHtml = () => {
    const p = st.patient;
    const list = (st.booking && st.booking.list) || [];
    const ok = p && (p.searched
      ? `✓ Chosen from all patients${p.id ? ` · ID ${esc(p.id)}` : ""}`
      : `✓ Booked ${esc(p.time)}${p.staff ? ` with ${esc(p.staff)}` : ""}${p.id ? ` · ID ${esc(p.id)}` : ""}`);
    return `<div class="scan-pat">
        ${p ? `<span class="scan-pat-ok">${ok}</span>`
            : `<span class="scan-pat-no">Not matched to a booking${st.review.apptDate ? "" : " (no date read)"}</span>`}
        <button type="button" class="scan-pat-btn" data-act="pickpat">${st.pickPatient ? "cancel" : "change"}</button>
      </div>
      ${st.pickPatient ? `
        ${list.length ? `<select class="fb-select scan-fix" data-patsel aria-label="Which booking is it?">
          <option value="">Not one of these bookings</option>
          ${list.map((a, i) => `<option value="${i}"${p && !p.searched && p.id === String(a.patientId || "") && p.time === (a.time || "") ? " selected" : ""}>${
            esc(a.time || "")} · ${esc(a.patientName || "")} · ${esc(a.staff || "")}</option>`).join("")}
        </select>` : ""}
        <div class="scan-psearch">
          <input type="search" class="fe-input" data-role="bpq" value="${esc(st.pq)}" autocomplete="off"
            placeholder="${list.length ? "Or search" : "Search"} all patients by name or ID" aria-label="Search all patients" />
          <div class="rx-hits" data-role="bphits">${bpHitsHtml()}</div>
        </div>` : ""}`;
  };

  const rowHtml = (l, i) => {
    const bad = l.flags.some((f) => f[0] === "bad");
    const written = l.written.map((w) => `“${w.text}”${w.qty > 1 ? ` ×${w.qty}` : ""}`).join(", ");
    const seenAs = !l.product && l.seenText.length ? ` (${l.seenText.join(", ")})` : "";
    const take = l.product ? `<label class="scan-take">Given
        <input type="number" min="0" max="99" step="1" inputmode="numeric" data-take="${i}" value="${l.take || 0}"
          aria-label="How many ${esc(l.product.name)} were given" />
        <small>${Number(l.product.stock.shelf) || 0} on Shelf now</small></label>` : "";
    return `<div class="scan-row${l.flags.length ? (bad ? " is-bad" : " is-warn") : ""}">
      <div class="scan-row-main">
        <button type="button" class="scan-name" data-fix="${i}">${esc(l.product ? l.product.name : "Not matched")}<small>change</small></button>
        <small>${written ? `Written ${esc(written)}` : "Not written on the sheet"}${l.seen ? ` · in the photo${l.seen > 1 ? ` ×${l.seen}` : ""}${esc(seenAs)}` : ""}</small>
        ${l.flags.map(([t, m]) => `<span class="scan-flag is-${t}">${esc(m)}</span>`).join("")}
        ${take}
        ${st.fixing === i ? fixHtml(l, i) : ""}
      </div>
      ${l.product || l.qty ? `<label class="scan-fee scan-fee-edit">
          <span class="scan-fee-in">$<input type="number" min="0" max="99999" step="0.01" inputmode="decimal" data-fee="${i}"
            value="${l.fee ?? ""}" placeholder="0" aria-label="Fee for ${esc(l.product ? l.product.name : "this line")}" /></span>
          ${l.feeFrom === "price" ? "<small>retail price</small>" : l.feeFrom === "edited" ? "<small>changed</small>" : ""}
        </label>` : '<span class="scan-fee"></span>'}
      <span class="scan-seen ${l.seen ? "is-yes" : "is-no"}" aria-label="${l.seen ? "In the photo" : "Not in the photo"}">${l.seen ? "✓" : "✕"}</span>
    </div>`;
  };

  function resultHtml() {
    const r = st.review;
    const when = [r.apptDate && niceDate(r.apptDate), r.apptTime, r.provider].filter(Boolean).join(" · ");
    return `${headHtml()}
      <div class="scan-res-head">
        <button type="button" class="scan-thumb" data-act="big" aria-label="Show the photo larger"><img src="${st.photoUrl}" alt="" /></button>
        <div><strong>${esc(patientName() || "Patient name not read")}</strong>
          <small>${esc(when || "Date not read")}</small>${patientHtml()}</div>
        <span class="scan-chip ${r.flagCount ? "is-warn" : "is-ok"}">${r.flagCount ? `${r.flagCount} to check` : "All matches"}</span>
      </div>
      <div class="scan-big" data-role="big" hidden><img src="${st.photoUrl}" alt="The photo" /></div>
      ${r.lines.length ? `<div class="scan-list">
          <div class="scan-list-head"><span>Product</span><span class="scan-fee">Fee</span><span class="scan-seen">Seen</span></div>
          ${r.lines.map(rowHtml).join("")}
        </div>`
        : '<p class="scan-err">No products were found on the sheet or in the photo. Try a closer, clearer photo.</p>'}
      ${r.lines.length ? `<p class="scan-total" data-role="total">Products total ${esc(money(r.productsTotal))}</p>` : ""}
      ${r.flagCount ? `<label class="lh-field"><span class="lh-label">What happened? (optional)</span>
        <textarea data-role="note" rows="2" maxlength="1000" placeholder="e.g. SPF given as a sample, no charge"></textarea></label>` : ""}
      <p class="scan-sell" data-role="sell">${esc(sellText())}</p>
      <div class="scan-acts">
        <button type="button" class="lh-btn" data-act="again">Scan again</button>
        <button type="button" class="lh-btn is-primary" data-act="save">${esc(saveLabel())}</button>
      </div>`;
  }

  function render() {
    clearInterval(st.secTimer);
    if (st.mode === "rx") {   // the prescription screen draws itself
      root.innerHTML = `${headHtml()}<div data-role="rx"></div>`;
      mountRxResult(root.querySelector('[data-role="rx"]'),
        { photo: st.photo, photoUrl: st.photoUrl, result: st.result, staff, onAgain: again });
      return;
    }
    if (st.mode === "docket") {   // the docket screen draws itself
      root.innerHTML = `${headHtml()}<div data-role="docket"></div>`;
      mountDocketResult(root.querySelector('[data-role="docket"]'),
        { photo: st.photo, photoUrl: st.photoUrl, result: st.result, products, staff, onAgain: again });
      return;
    }
    // A note being typed survives a redraw (e.g. after changing a quantity)
    const noteEl = root.querySelector('[data-role="note"]');
    const note = noteEl ? noteEl.value : "";
    root.innerHTML = st.mode === "camera" ? cameraHtml() : st.mode === "busy" ? busyHtml()
      : st.mode === "pages" ? pagesHtml() : st.mode === "error" ? errorHtml() : resultHtml();
    const n2 = root.querySelector('[data-role="note"]');
    if (n2 && note) n2.value = note;
    if (st.mode === "camera") { startCamera(); loadToday(); }
    if (st.mode === "busy") st.secTimer = setInterval(tickSecs, 1000);
  }

  function rereview() {
    st.review = reviewBilling(st.lines, st.result, products);
    st.lines = st.review.lines;
  }

  /* ===================== Camera ===================== */
  function stopCamera() {
    const vf = root.querySelector('[data-role="vf"]');
    if (vf) vf.classList.remove("is-live");
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    st.track = null;
    st.torch = false;
  }

  // The main back camera: not the ultra-wide, telephoto or depth lens. Names are only readable once the camera is allowed.
  async function backCameraId() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const backs = cams.filter((d) => /back|rear|environment/i.test(d.label));
    const main = backs.find((d) => !/ultra|wide|tele|depth|macro/i.test(d.label)) || backs[0];
    return main ? main.deviceId : "";
  }

  // Starts the camera, or shows the one already running in the current viewfinder
  async function startCamera() {
    if (st.starting) return;
    if (st.stream) {
      const v = root.querySelector(".scan-vf video");
      if (v && v.srcObject !== st.stream) { v.srcObject = st.stream; v.play().catch(() => {}); }
      markLive(v);
      const tb = root.querySelector('[data-act="torch"]');
      if (tb) tb.hidden = !st.canTorch;
      applyZoom();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setTip("This browser can't show the camera here. Use Camera app or Upload below.", true);
      return;
    }
    st.starting = true;
    // Best first. Phones and tablets insist on the back camera; if that fails they fall back gently.
    // Some laptop webcams fail at the full size instead of choosing a smaller one.
    const back = isMobile() ? [
      { facingMode: { exact: "environment" }, width: { ideal: 4032 }, height: { ideal: 3024 } },
      { facingMode: { exact: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      { facingMode: { exact: "environment" } },
    ] : [];
    const tries = [
      ...back,
      { facingMode: { ideal: "environment" }, width: { ideal: 4032 }, height: { ideal: 3024 } },
      { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      { facingMode: { ideal: "environment" } },
      true,
    ];
    try {
      let stream = null, lastErr = null;
      for (const video of tries) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
          break;
        } catch (err) {
          lastErr = err;
          const n = err && err.name;
          if (n === "NotAllowedError" || n === "SecurityError" || n === "NotFoundError") break; // trying again won't help
          if (n === "NotReadableError" || n === "AbortError") await new Promise((r) => setTimeout(r, 400)); // let it finish closing
        }
      }
      if (!stream) throw lastErr || new Error("No camera");
      // A phone that still opened the front camera: switch to the main back camera
      if (isMobile()) {
        const t = stream.getVideoTracks()[0];
        const facing = t && t.getSettings ? t.getSettings().facingMode : "";
        const label = (t && t.label) || "";
        if (facing === "user" || /front|facetime|selfie/i.test(label)) {
          const id = await backCameraId().catch(() => "");
          if (id) {
            try {
              const better = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
                deviceId: { exact: id }, width: { ideal: 4032 }, height: { ideal: 3024 } } });
              stream.getTracks().forEach((x) => x.stop());
              stream = better;
            } catch (err) { console.warn("Couldn't switch to the back camera:", err); }
          }
        }
      }
      if (!root.isConnected || st.mode !== "camera") { stream.getTracks().forEach((t) => t.stop()); return; }
      st.stream = stream;
      st.track = stream.getVideoTracks()[0];
      const caps = st.track.getCapabilities ? st.track.getCapabilities() : {};
      st.hw = caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max } : null;   // real optical/sensor zoom where allowed
      st.canTorch = !!caps.torch;
      st.canFocus = Array.isArray(caps.focusMode) && caps.focusMode.includes("single-shot");
      const v = root.querySelector(".scan-vf video");
      if (v) { v.srcObject = stream; markLive(v); await v.play().catch(() => {}); }
      const tb = root.querySelector('[data-act="torch"]');
      if (tb) tb.hidden = !st.canTorch;
      st.camErr = "";
      applyZoom();
    } catch (err) {
      console.warn("Camera failed:", err);
      const n = err && err.name;
      setTip(n === "NotAllowedError" || n === "SecurityError"
        ? "Camera access is blocked. Allow the camera for this site in Settings, or use Camera app or Upload below."
        : n === "NotReadableError" || n === "TrackStartError" || n === "AbortError"
          ? "The camera is being used by another app or tab (Teams, Zoom, another portal tab). Close it, then tap Try again."
        : n === "NotFoundError" || n === "OverconstrainedError"
          ? "No camera was found on this device. Use Upload below."
        : "Couldn't start the camera. Tap Try again, or use Upload or Camera app below.", true);
    } finally {
      st.starting = false;
    }
  }

  function setTip(text, bad = false) {
    st.camErr = bad ? text : "";
    const wait = root.querySelector('[data-role="wait"]');
    if (wait) wait.innerHTML = waitHtml();
    const tip = root.querySelector('[data-role="tip"]');
    if (tip && !bad) tip.textContent = text;
  }
  const setHint = (t) => { const tip = root.querySelector('[data-role="tip"]'); if (tip && tip.textContent !== t) tip.textContent = t; };

  // The picture has arrived: fade it in and show the frame and zoom buttons
  function markLive(v) {
    const vf = root.querySelector('[data-role="vf"]');
    if (!v || !vf) return;
    const on = () => { if (v.isConnected) vf.classList.add("is-live"); };
    if (v.readyState >= 2 && !v.paused) on();
    else v.addEventListener("playing", on, { once: true });
  }

  function applyZoom() {
    const v = root.querySelector(".scan-vf video");
    if (st.hw && st.track) {
      const z = Math.min(st.hw.max, Math.max(st.hw.min, st.zoom));
      st.track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
      if (v) v.style.transform = "";
    } else if (v) {
      v.style.transform = st.zoom > 1 ? `scale(${st.zoom})` : "";   // digital zoom: the photo is cropped to match
    }
    root.querySelectorAll("[data-zoom]").forEach((b) => b.classList.toggle("is-on", Math.abs(Number(b.dataset.zoom) - st.zoom) < 0.05));
  }

  // Shows where you tapped. Focuses there where the browser allows it (iPhone keeps focusing on its own).
  function focusAt(e) {
    const vf = root.querySelector('[data-role="vf"]');
    const ring = root.querySelector('[data-role="focus"]');
    if (!vf || !ring) return;
    const r = vf.getBoundingClientRect();
    ring.style.left = `${e.clientX - r.left}px`;
    ring.style.top = `${e.clientY - r.top}px`;
    ring.classList.remove("is-on");
    void ring.offsetWidth;
    ring.classList.add("is-on");
    if (st.canFocus && st.track) {
      st.track.applyConstraints({ advanced: [{
        focusMode: "single-shot",
        pointsOfInterest: [{ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }],
      }] }).catch(() => {});
    }
  }

  // Takes exactly what's on screen (including digital zoom)
  async function shoot() {
    if (st.shooting || st.mode !== "camera") return;   // a double tap takes one photo
    const v = root.querySelector(".scan-vf video");
    if (!v || !v.videoWidth) { showToast("The camera isn't ready yet."); return; }
    st.shooting = true;
    shutterSound();
    const z = st.hw ? 1 : st.zoom;
    const k = Math.max(v.offsetWidth / v.videoWidth, v.offsetHeight / v.videoHeight);
    const sw = v.offsetWidth / k / z, sh = v.offsetHeight / k / z;
    const c = document.createElement("canvas");
    c.width = Math.round(sw);
    c.height = Math.round(sh);
    c.getContext("2d").drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    const vf = root.querySelector('[data-role="vf"]');
    if (vf) { vf.classList.remove("is-flash"); void vf.offsetWidth; vf.classList.add("is-flash"); }
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
    if (blob) handlePhoto(blob); else st.shooting = false;
  }

  /* ===================== A photo taken or uploaded ===================== */
  async function handlePhoto(blob) {
    const q = await photoQuality(blob);
    if (!root.isConnected) return;
    if (q.dark || q.blurry) {
      const retake = await confirmDialog({
        title: q.dark && q.blurry ? "This photo looks dark and blurry" : q.dark ? "This photo looks too dark" : "This photo looks blurry",
        message: q.dark
          ? "Turn on more light (or the torch), then take it again. Handwriting may not read well like this."
          : "Hold the device steady and tap the sheet to focus, then take it again. Handwriting may not read well like this.",
        confirmLabel: "Retake", cancelLabel: "Use it anyway", tone: "warning",
      });
      if (!root.isConnected) return;
      if (retake) {
        st.shooting = false;
        const vf = root.querySelector('[data-role="vf"]');
        if (vf) vf.classList.remove("is-flash");
        return;
      }
    }
    // Dockets: each photo is a page. The camera keeps running for the next one.
    if (st.kind === "docket") {
      st.pages.push(blob);
      st.pageUrls.push(URL.createObjectURL(blob));
      st.shooting = false;
      st.mode = "pages";
      render();
      return;
    }
    read([blob]);
  }

  // Prepares the photo (pages joined), keeps it on the device, then reads it
  async function read(blobs) {
    stopCamera();
    st.readThisSession = true;
    st.pendingInfo = null;
    st.busyT0 = Date.now();
    st.step = 0;
    st.mode = "busy";
    if (st.photoUrl) URL.revokeObjectURL(st.photoUrl);
    st.photoUrl = URL.createObjectURL(blobs[0]);
    render();
    try {
      const joined = await stitchPages(blobs);
      const prep = await preparePhoto(joined, blobs.length > 1 ? Math.min(4800, 1600 * blobs.length) : 1600);
      URL.revokeObjectURL(st.photoUrl);
      st.photo = prep.blob;
      st.base64 = prep.base64;
      st.photoUrl = URL.createObjectURL(prep.blob);
    } catch (err) {
      st.error = (err && err.message) || "That photo couldn't be used. Try again.";
      st.mode = "error";
      st.busyT0 = 0;
      if (root.isConnected) render();
      return;
    }
    pendingPut({ kind: st.kind, blob: st.photo, at: Date.now(), by: (staff && staff.name) || "", pages: blobs.length });
    analyse();
  }

  function setStep(n) {
    st.step = n;
    const el = root.querySelector('[data-role="steps"]');
    if (el) el.innerHTML = stepsHtml();
  }
  function tickSecs() {
    const el = root.querySelector('[data-role="secs"]');
    if (!el || !st.busyT0) { clearInterval(st.secTimer); return; }
    const s = Math.round((Date.now() - st.busyT0) / 1000);
    el.textContent = s >= 3 ? `${s} seconds` : "";
  }

  async function analyse() {
    if (!st.busyT0) st.busyT0 = Date.now();
    st.mode = "busy";
    st.fixing = -1;
    st.step = 1;
    render();
    try {
      const t0 = performance.now();
      if (st.kind === "rx") {
        // Prescriptions are matched to the prescription product list, not the stock products
        const list = rxProductList();
        if (!list.length) throw new Error("The prescription product list is empty. Ask an Admin to add it.");
        st.result = await readPrescription(st.base64, list);
        console.log(`Scanner: ${Math.round(performance.now() - t0)} ms to read the prescription`);
        setStep(2);
        st.mode = "rx";
      } else {
        await productsReady;
        if (!products.length) throw new Error("Couldn't load the product list. Check your connection and try again.");
        if (st.kind === "docket") {
          st.result = await readDocket(st.base64, products);
          console.log(`Scanner: ${Math.round(performance.now() - t0)} ms to read the docket`);
          setStep(2);
          st.mode = "docket";
        } else {
          st.result = await readBillingSheet(st.base64, products);
          console.log(`Scanner: ${Math.round(performance.now() - t0)} ms from sending the photo to the answer`);
          setStep(2);
          st.lines = startReview(st.result, products);
          rereview();
          // Which booked patient this is. Never stops the scan if it can't be worked out.
          st.booking = await findBooking(st.review).catch((err) => { console.warn("Booking match failed:", err); return null; });
          st.patient = fromBooking(st.booking && st.booking.match);
          st.pickPatient = false;
          st.mode = "result";
        }
      }
    } catch (err) {
      console.error("Scan failed:", err);
      st.error = (err && err.message) || "The scanner couldn't read that photo. Try again.";
      st.mode = "error";
    } finally {
      st.busyT0 = 0;
    }
    if (root.isConnected) render();
  }

  /* ===================== An unfinished scan from before ===================== */
  async function openPending() {
    const p = await pendingGet();
    st.pendingInfo = null;
    if (!p || !p.blob) { showToast("That scan isn't on this device any more."); render(); return; }
    stopCamera();
    setKind(p.kind);
    st.readThisSession = true;
    if (st.photoUrl) URL.revokeObjectURL(st.photoUrl);
    st.photo = p.blob;
    st.photoUrl = URL.createObjectURL(p.blob);
    try { st.base64 = await blobToB64(p.blob); }
    catch { showToast("That scan couldn't be opened. Discard it and scan again."); render(); return; }
    analyse();
  }
  function dropPending() {
    pendingClear();
    st.pendingInfo = null;
    const h = root.querySelector('[data-role="pending-host"]');
    if (h) h.innerHTML = "";
  }

  /* ===================== Today's scans ===================== */
  function loadToday(force = false) {
    if (!force && st.todayAt && Date.now() - st.todayAt < 30000) return;
    st.todayAt = Date.now();
    todaysScans()
      .then((list) => { st.today = list.filter((s) => KINDS.some(([k]) => k === s.kind)); })
      .catch((err) => { console.warn("Today's scans didn't load:", err); st.todayAt = 0; })
      .finally(() => {
        const h = root.querySelector('[data-role="today-host"]');
        if (h) h.innerHTML = todayHtml();
      });
  }

  /* ===================== Billing: search all patients ===================== */
  let bpTimer = null, bpSeq = 0;
  async function runPatientSearch() {
    const my = ++bpSeq;
    const box = () => root.querySelector('[data-role="bphits"]');
    if (st.pq.trim().length < 2) {
      st.phits = []; st.psearching = false;
      if (box()) box().innerHTML = bpHitsHtml();
      return;
    }
    st.psearching = true;
    if (box()) box().innerHTML = bpHitsHtml();
    const hits = await searchPatientsQuick(st.pq).catch(() => []);
    if (my !== bpSeq || !root.isConnected) return;
    st.psearching = false;
    st.phits = hits;
    if (box()) box().innerHTML = bpHitsHtml();
  }

  /* ===================== Starting again, and saving ===================== */
  function again() {
    if (st.photoUrl) URL.revokeObjectURL(st.photoUrl);
    st.pageUrls.forEach((u) => URL.revokeObjectURL(u));
    pendingClear();   // saved, or staff chose to start again
    Object.assign(st, { mode: "camera", photo: null, photoUrl: "", base64: "", result: null, lines: [], review: null, error: "",
      fixing: -1, camErr: "", booking: null, patient: null, pickPatient: false, shooting: false,
      pages: [], pageUrls: [], step: 0, busyT0: 0, todayAt: 0, pq: "", phits: [], psearching: false });
    render();
  }

  async function save(btn) {
    if (st.busy) return;
    const given = st.lines.filter((l) => l.product && l.take > 0);
    const who = patientName();

    // This patient's billing sheet already scanned today with some of these? Probably the same sheet twice.
    if (given.length) {
      const before = await earlierScans(who, given.map((l) => l.productId)).catch(() => []);
      if (before.length) {
        const ok = await confirmDialog({
          title: "Already scanned today?",
          message: `A billing sheet for ${who} with ${before.map((b) => `${b.qty} × ${b.name}${b.by ? ` (by ${b.by})` : ""}`).join(", ")} `
            + "was already scanned today. Save this one as well?",
          confirmLabel: "Save as well", tone: "warning",
        });
        if (!ok) return;
      }
    }

    st.busy = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const note = root.querySelector('[data-role="note"]');
      await saveBillingScan({ photo: st.photo, result: st.result, review: st.review,
        note: note ? note.value : "", patient: st.patient }, staff);
      showToast("Saved. It's checked against the Timely invoice when the invoices are uploaded.");
      again();
    } catch (err) {
      console.error("Save scan failed:", err);
      showToast(err && err.code === "permission-denied"
        ? "You don't have access to save billing sheets. Ask an Admin to tick Scan billing sheets."
        : (err && err.message && !err.code) ? err.message : "Couldn't save. Try again.");
      btn.disabled = false;
      btn.textContent = saveLabel();
    } finally {
      st.busy = false;
    }
  }

  /* ===================== Auto: takes the photo when held still over a sheet ===================== */
  // Needs a movement before each photo, so it never takes the same sheet twice.
  let autoTimer = 0, lastFrame = null, stillSince = 0, armed = true, autoCanvas = null;
  function autoTick() {
    const vf = root.querySelector('[data-role="vf"]');
    if (!st.auto || st.mode !== "camera" || st.shooting || !st.stream || !vf || !vf.classList.contains("is-live")
      || document.querySelector("dialog[open]")) {
      lastFrame = null; stillSince = 0;
      return;
    }
    const v = vf.querySelector("video");
    if (!v || !v.videoWidth) return;
    const w = 48, h = 36;
    if (!autoCanvas) { autoCanvas = document.createElement("canvas"); autoCanvas.width = w; autoCanvas.height = h; }
    const g = autoCanvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(v, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += gray[j]; }
    const mean = sum / gray.length;
    if (!lastFrame) { lastFrame = gray; return; }
    let sq = 0, diff = 0;
    for (let j = 0; j < gray.length; j++) { sq += (gray[j] - mean) ** 2; diff += Math.abs(gray[j] - lastFrame[j]); }
    lastFrame = gray;
    const contrast = Math.sqrt(sq / gray.length);
    if (diff / gray.length > 6) { armed = true; stillSince = 0; setHint(tipText()); return; }   // moving
    if (!armed || contrast < 18) { stillSince = 0; return; }   // just taken, or nothing much in view
    if (!stillSince) { stillSince = Date.now(); setHint("Hold still…"); return; }
    if (Date.now() - stillSince >= 1200) { armed = false; stillSince = 0; setHint(tipText()); shoot(); }
  }
  autoTimer = setInterval(autoTick, 200);

  /* ===================== Keep the screen awake ===================== */
  let wake = null;
  async function keepAwake() {
    if (!("wakeLock" in navigator) || wake || document.hidden) return;
    try {
      wake = await navigator.wakeLock.request("screen");
      wake.addEventListener("release", () => { wake = null; });
    } catch { /* not allowed here (low battery, or the browser doesn't offer it) */ }
  }
  function letSleep() { try { if (wake) wake.release(); } catch { /* ignore */ } wake = null; }

  /* ===================== Taps, pinch, keys and buttons ===================== */
  root.addEventListener("pointerdown", () => audio(), { once: true });   // unlocks the shutter sound for Auto

  const pts = new Map();
  let pinch = null, tap = null;
  const gap = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  root.addEventListener("pointerdown", (e) => {
    if (!e.target.closest('[data-role="vf"]') || e.target.closest("button")) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { pinch = { d: gap(), z: st.zoom }; tap = null; }
    else tap = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  root.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      st.zoom = Math.round(Math.min(4, Math.max(1, pinch.z * (gap() / pinch.d))) * 10) / 10;
      applyZoom();
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (tap && Date.now() - tap.t < 400 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 12) focusAt(e);
    tap = null;
  };
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", up);

  // Space or Enter takes the photo on a computer (not while typing, or with a window open)
  const onKey = (e) => {
    if (!root.isConnected) { cleanup(); return; }
    if (st.mode !== "camera" || e.repeat || (e.key !== " " && e.key !== "Enter")) return;
    if (e.target && e.target.closest && e.target.closest("input, textarea, select, button, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    e.preventDefault();
    shoot();
  };

  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-role="tip"]') && st.camErr && st.mode === "camera") {
      st.camErr = "";
      stopCamera();
      render();
      return;
    }
    const kd = e.target.closest("[data-kind]");
    if (kd) {
      const k = kd.dataset.kind;
      if (st.mode === "busy" || st.busy || st.kind === k) return;
      const unsaved = ["result", "rx", "docket", "pages"].includes(st.mode) || st.pages.length > 0 || (st.mode === "error" && !!st.base64);
      if (st.mode === "camera" && !unsaved) {
        // Same camera, same viewfinder: only the tab and the hint change (no flicker, zoom kept)
        setKind(k);
        root.querySelectorAll("[data-kind]").forEach((b) => {
          const on = b.dataset.kind === k;
          b.classList.toggle("is-on", on);
          b.setAttribute("aria-selected", String(on));
        });
        setHint(tipText());
        return;
      }
      if (unsaved) {
        confirmDialog({
          title: "Leave this scan?",
          message: "It hasn't been saved. Switching starts a new scan.",
          confirmLabel: "Switch", cancelLabel: "Stay", tone: "warning",
        }).then((ok) => { if (ok && root.isConnected) { setKind(k); again(); } });
        return;
      }
      setKind(k);
      again();
      return;
    }
    const z = e.target.closest("[data-zoom]");
    if (z) { st.zoom = Number(z.dataset.zoom); applyZoom(); return; }
    const fx = e.target.closest("[data-fix]");
    if (fx) { const i = Number(fx.dataset.fix); st.fixing = st.fixing === i ? -1 : i; render(); return; }
    const bp = e.target.closest("[data-bppick]");
    if (bp) {
      const p = st.phits[Number(bp.dataset.bppick)];
      if (!p) return;
      st.patient = { id: String(p.pttId || ""), name: p.name || "", time: "", staff: "", searched: true };
      Object.assign(st, { pickPatient: false, pq: "", phits: [] });
      render();
      return;
    }
    const pd = e.target.closest("[data-pagedel]");
    if (pd) {
      const i = Number(pd.dataset.pagedel);
      URL.revokeObjectURL(st.pageUrls[i]);
      st.pages.splice(i, 1);
      st.pageUrls.splice(i, 1);
      st.mode = st.pages.length ? "pages" : "camera";
      render();
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "cam-retry") { st.camErr = ""; stopCamera(); render(); }
    else if (act === "shoot") shoot();
    else if (act === "torch" && st.track) {
      st.torch = !st.torch;
      st.track.applyConstraints({ advanced: [{ torch: st.torch }] }).catch(() => {});
      b.classList.toggle("is-on", st.torch);
    } else if (act === "auto") {
      st.auto = !st.auto;
      writeLocal(AUTO_KEY, st.auto ? "1" : "0");
      b.classList.toggle("is-on", st.auto);
      b.setAttribute("aria-pressed", String(st.auto));
      setHint(tipText());
      showToast(st.auto ? "Auto is on: hold the device still over a sheet and the photo takes itself." : "Auto is off.");
    }
    else if (act === "page-add") { st.mode = "camera"; st.shooting = false; render(); }
    else if (act === "page-back") { st.mode = "pages"; render(); }
    else if (act === "page-read") { if (st.pages.length) read(st.pages.slice()); }
    else if (act === "pend-open") openPending();
    else if (act === "pend-drop") dropPending();
    else if (act === "again") again();
    else if (act === "retry") analyse();
    else if (act === "save") save(b);
    else if (act === "pickpat") {
      st.pickPatient = !st.pickPatient;
      render();
      if (st.pickPatient && !((st.booking && st.booking.list) || []).length) {
        const q = root.querySelector('[data-role="bpq"]');
        if (q) q.focus();
      }
    }
    else if (act === "big") { const big = root.querySelector('[data-role="big"]'); if (big) big.hidden = !big.hidden; }
  });

  // Remembers whether Today is open
  root.addEventListener("toggle", (e) => {
    if (e.target && e.target.matches && e.target.matches('[data-role="today"]')) st.todayOpen = e.target.open;
  }, true);

  // Typing: the totals update straight away; the flags update when you leave the box
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.role === "bpq") {
      st.pq = t.value;
      clearTimeout(bpTimer);
      bpTimer = setTimeout(runPatientSearch, 250);
      return;
    }
    if (t.dataset.fee !== undefined) {
      const l = st.lines[Number(t.dataset.fee)];
      if (!l) return;
      const v = t.value.trim();
      l.feeEdit = v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v) * 100) / 100);
      l.fee = l.feeEdit;
      const tot = root.querySelector('[data-role="total"]');
      if (tot) tot.textContent = `Products total ${money(Math.round(st.lines.reduce((a, x) => a + (x.fee || 0), 0) * 100) / 100)}`;
      return;
    }
    if (t.dataset.take === undefined) return;
    const l = st.lines[Number(t.dataset.take)];
    if (!l) return;
    l.take = Math.min(99, Math.max(0, parseInt(t.value, 10) || 0));
    const s = root.querySelector('[data-role="sell"]');
    if (s) s.textContent = sellText();
    const b = root.querySelector('[data-act="save"]');
    if (b && !st.busy) b.textContent = saveLabel();
  });

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.role === "file") {
      const f = t.files && t.files[0];
      t.value = "";
      if (f && !st.shooting) { st.shooting = true; handlePhoto(f); }
      return;
    }
    if (t.dataset.patsel !== undefined) {   // staff picked the right booking
      const list = (st.booking && st.booking.list) || [];
      st.patient = t.value === "" ? null : fromBooking(list[Number(t.value)]);
      st.pickPatient = false;
      render();
      return;
    }
    if (t.dataset.take !== undefined || t.dataset.fee !== undefined) { rereview(); render(); return; }
    if (t.dataset.fixsel !== undefined) {   // staff picked the right product for a line
      const l = st.lines[Number(t.dataset.fixsel)];
      if (!l) return;
      l.productId = t.value;
      l.fixed = true;
      l.take = undefined;      // worked out again for the new product
      l.feeEdit = undefined;   // and the fee (its retail price may differ)
      rereview();
      st.fixing = -1;
      render();
    }
  });

  /* ===================== Leaving, hiding and coming back ===================== */
  // The camera is switched off when leaving the page, putting the iPad down, refreshing,
  // or when this Scanner is no longer on screen. It comes back on when you return.
  const cleanup = () => {
    stopCamera();
    letSleep();
    clearInterval(autoTimer);
    clearInterval(st.secTimer);
    window.removeEventListener("hashchange", onHash);
    document.removeEventListener("visibilitychange", onVis);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("pagehide", stopCamera);
    if (releaseCamera === cleanup) releaseCamera = null;
  };
  const onVis = () => {
    if (!root.isConnected) { cleanup(); return; }
    if (document.hidden) { stopCamera(); return; }
    keepAwake();
    if (st.mode === "camera") startCamera();
  };
  const onHash = () => {
    if (location.hash.startsWith("#/scanner") && root.isConnected) return;
    cleanup();
  };
  window.addEventListener("hashchange", onHash);
  document.addEventListener("visibilitychange", onVis);
  document.addEventListener("keydown", onKey);
  window.addEventListener("pagehide", stopCamera);   // a refresh or closed tab never leaves the camera stuck
  releaseCamera = cleanup;
  keepAwake();

  // An unfinished scan from before (not too old, and a kind this person can scan)
  pendingGet().then((p) => {
    if (!p) return;
    const fresh = Date.now() - Number(p.at || 0) < 3 * 86400000;
    if (!p.blob || !fresh || !KINDS.some(([k]) => k === p.kind)) { if (!fresh) pendingClear(); return; }
    if (!root.isConnected || st.readThisSession || st.mode !== "camera") return;
    st.pendingInfo = { kind: p.kind, at: p.at, by: p.by || "" };
    const h = root.querySelector('[data-role="pending-host"]');
    if (h) h.innerHTML = pendingHtml();
  });

  render();
}