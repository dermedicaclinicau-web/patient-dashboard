// Scanner (#/scanner): photograph a billing sheet with the products on it.
// Gemini reads the handwriting and the labels; the portal matches both to the product list and flags anything that doesn't line up.
// The sheet is matched to that day's booking, so the scan shows on the patient's dashboard.
// Saving keeps the scan and its photo as a record of what was given. Stock comes off the Shelf when the
// Timely invoices are uploaded, and the two are compared in Reporting.
import { listProducts, INV_CATEGORIES, plural } from "./inventory-api.js";
import { preparePhoto, readBillingSheet, readDocket, readPrescription, startReview, reviewBilling, saveBillingScan, earlierScans, findBooking, money } from "./scanner-api.js";
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
// Only one Scanner holds the camera: this switches off the one before
let releaseCamera = null;

// NEW: a booking → the patient saved with the scan
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

  // The product list (with Shelf stock). Loaded again after each sale, so the numbers stay current.
  let products = [];
  const loadProducts = () => listProducts().then((list) => { products = list.filter((p) => p.active); })
    .catch((err) => console.error("Scanner: the product list didn't load", err));
  let productsReady = loadProducts();
  warmUpLogin();   // wakes Apps Script while the photo is being lined up, so the first scan isn't slow

  const st = {
    mode: "camera", stream: null, track: null, starting: false, zoom: 1, hw: null, torch: false, canTorch: false, canFocus: false,
    camErr: "", photo: null, photoUrl: "", base64: "", result: null, lines: [], review: null, error: "", fixing: -1, busy: false,
    booking: null, patient: null, pickPatient: false, kind: KINDS[0][0],   // kind: "billing" or "docket"
  };

  const sellCount = () => st.lines.reduce((a, l) => a + (l.product ? l.take || 0 : 0), 0);
  const sellText = () => (sellCount()
    ? `${plural(sellCount(), "product")} recorded as given. Stock comes off the Shelf when the Timely invoices are uploaded.`
    : "No products recorded as given.");
  const saveLabel = () => "Save";
  // NEW: the booked name when matched, else the name read from the sheet
  const patientName = () => (st.patient && st.patient.name) || (st.review && st.review.patientName) || "";

  /* ---------- Screens ---------- */
  const headHtml = () => (KINDS.length < 2 ? "" : `<div class="scan-head"><div class="scan-modes" role="tablist" aria-label="What you're scanning">
      ${KINDS.map(([k, label]) => `<button type="button" class="scan-mode${st.kind === k ? " is-on" : ""}" role="tab"
        aria-selected="${st.kind === k}" data-kind="${k}">${label}</button>`).join("")}
    </div></div>`);

  // The viewfinder before the camera picture arrives: starting, or why it can't
  const tipText = () => (st.kind === "docket" ? "Fit the whole delivery docket inside the frame"
    : st.kind === "rx" ? "Fit the whole prescription inside the frame" : "Fit the billing sheet and the products inside the frame");
  const waitHtml = () => (st.camErr
    ? `${I.camera}<strong>The camera couldn't start</strong><p>${esc(st.camErr)}</p>
       <button type="button" class="lh-btn" data-act="cam-retry">Try again</button>`
    : `<span class="scan-wait-spin" aria-hidden="true"></span><strong>Starting the camera…</strong>
       <p>If your device asks to use the camera, tap Allow.</p>`);

  const cameraHtml = () => `${headHtml()}
    <div class="scan-vf" data-role="vf">
      <video playsinline muted autoplay></video>
      <div class="scan-frame" aria-hidden="true"></div>
      <span class="scan-focus" data-role="focus" aria-hidden="true"></span>
      <div class="scan-wait" data-role="wait" aria-live="polite">${waitHtml()}</div>
      <p class="scan-tip" data-role="tip">${esc(tipText())}</p>
      <div class="scan-zoom" role="group" aria-label="Zoom">${[1, 1.5, 2].map((z) =>
        `<button type="button" data-zoom="${z}" class="${z === st.zoom ? "is-on" : ""}">${z}×</button>`).join("")}</div>
      <button type="button" class="scan-torch" data-act="torch" aria-label="Torch" hidden>${I.bolt}</button>
    </div>
    <div class="scan-bar">
      <label class="scan-side">${I.photo}<span>Upload</span><input type="file" accept="image/*" data-role="file" hidden /></label>
      <button type="button" class="scan-shutter" data-act="shoot" aria-label="Take the photo"><span></span></button>
      <label class="scan-side">${I.camera}<span>Camera app</span><input type="file" accept="image/*" capture="environment" data-role="file" hidden /></label>
    </div>`;

  const busyHtml = () => `${headHtml()}
    <div class="scan-shot"><img src="${st.photoUrl}" alt="The photo being read" />
      <div class="scan-busy"><span class="scan-spin"></span>${st.kind === "docket" ? "Reading the delivery docket…"
        : st.kind === "rx" ? "Reading the prescription…" : "Reading the sheet and the products…"}</div></div>`;
  const errorHtml = () => `${headHtml()}
    ${st.photoUrl ? `<div class="scan-shot"><img src="${st.photoUrl}" alt="The photo" /></div>` : ""}
    <p class="scan-err">${esc(st.error)}</p>
    <div class="scan-acts">
      <button type="button" class="lh-btn" data-act="again">Scan again</button>
      ${st.base64 ? '<button type="button" class="lh-btn is-primary" data-act="retry">Try again</button>' : ""}
    </div>`;

  const fixHtml = (l, i) => `<select class="fb-select scan-fix" data-fixsel="${i}" aria-label="Which product is it?">
      <option value="">Not on the product list</option>
      ${INV_CATEGORIES.map((c) => {
        const g = products.filter((p) => p.category === c.key);
        return g.length ? `<optgroup label="${esc(c.label)}">${g.map((p) =>
          `<option value="${esc(p.id)}"${p.id === l.productId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>` : "";
      }).join("")}
    </select>`;

  // NEW: which booking this sheet belongs to, with "change" to pick another of that day's bookings
  const patientHtml = () => {
    const p = st.patient;
    const list = (st.booking && st.booking.list) || [];
    return `<div class="scan-pat">
        ${p ? `<span class="scan-pat-ok">✓ Booked ${esc(p.time)}${p.staff ? ` with ${esc(p.staff)}` : ""}${p.id ? ` · ID ${esc(p.id)}` : ""}</span>`
            : `<span class="scan-pat-no">Not matched to a booking${st.review.apptDate ? "" : " (no date read)"}</span>`}
        ${list.length ? '<button type="button" class="scan-pat-btn" data-act="pickpat">change</button>' : ""}
      </div>
      ${st.pickPatient ? `<select class="fb-select scan-fix" data-patsel aria-label="Which patient is it?">
          <option value="">Not one of these bookings</option>
          ${list.map((a, i) => `<option value="${i}"${p && p.id === String(a.patientId || "") && p.time === (a.time || "") ? " selected" : ""}>${
            esc(a.time || "")} · ${esc(a.patientName || "")} · ${esc(a.staff || "")}</option>`).join("")}
        </select>` : ""}`;
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
      : st.mode === "error" ? errorHtml() : resultHtml();
    const n2 = root.querySelector('[data-role="note"]');
    if (n2 && note) n2.value = note;
    if (st.mode === "camera") startCamera();
  }

  function rereview() {
    st.review = reviewBilling(st.lines, st.result, products);
    st.lines = st.review.lines;
  }

  /* ---------- Camera ---------- */
  function stopCamera() {
    const vf = root.querySelector('[data-role="vf"]');
    if (vf) vf.classList.remove("is-live");
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    st.track = null;
    st.torch = false;
  }
  // Phones and tablets (iPads report themselves as a Mac, but have a touch screen)
  const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));

  // The main back camera: not the ultra-wide, telephoto or depth lens. Names are only readable once the camera is allowed.
  async function backCameraId() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const backs = cams.filter((d) => /back|rear|environment/i.test(d.label));
    const main = backs.find((d) => !/ultra|wide|tele|depth|macro/i.test(d.label)) || backs[0];
    return main ? main.deviceId : "";
  }
  // Starts the camera, or shows the one already running in the current viewfinder
  // (switching Billing sheet / Delivery docket / Prescription draws a new one)
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
    const v = root.querySelector(".scan-vf video");
    if (!v || !v.videoWidth) { showToast("The camera isn't ready yet."); return; }
    const z = st.hw ? 1 : st.zoom;
    const k = Math.max(v.offsetWidth / v.videoWidth, v.offsetHeight / v.videoHeight);
    const sw = v.offsetWidth / k / z, sh = v.offsetHeight / k / z;
    const c = document.createElement("canvas");
    c.width = Math.round(sw);
    c.height = Math.round(sh);
    c.getContext("2d").drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    root.querySelector('[data-role="vf"]').classList.add("is-flash");
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
    if (blob) usePhoto(blob);
  }

  /* ---------- Reading the photo ---------- */
  async function usePhoto(blob) {
    stopCamera();
    try {
      const prep = await preparePhoto(blob);
      if (st.photoUrl) URL.revokeObjectURL(st.photoUrl);
      st.photo = prep.blob;
      st.base64 = prep.base64;
      st.photoUrl = URL.createObjectURL(prep.blob);
    } catch (err) {
      st.error = err.message || "That photo couldn't be used. Try again.";
      st.mode = "error";
      render();
      return;
    }
    analyse();
  }

  async function analyse() {
    st.mode = "busy";
    st.fixing = -1;
    render();
    try {
      const t0 = performance.now();
      if (st.kind === "rx") {
        // Prescriptions are matched to the prescription product list, not the stock products
        const list = rxProductList();
        if (!list.length) throw new Error("The prescription product list is empty. Ask an Admin to add it.");
        st.result = await readPrescription(st.base64, list);
        console.log(`Scanner: ${Math.round(performance.now() - t0)} ms to read the prescription`);
        st.mode = "rx";
      } else {
        await productsReady;
        if (!products.length) throw new Error("Couldn't load the product list. Check your connection and try again.");
        if (st.kind === "docket") {
          st.result = await readDocket(st.base64, products);
          console.log(`Scanner: ${Math.round(performance.now() - t0)} ms to read the docket`);
          st.mode = "docket";
        } else {
          st.result = await readBillingSheet(st.base64, products);
          console.log(`Scanner: ${Math.round(performance.now() - t0)} ms from sending the photo to the answer`);
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
    }
    if (root.isConnected) render();
  }

  function again() {
    if (st.photoUrl) URL.revokeObjectURL(st.photoUrl);
    Object.assign(st, { mode: "camera", photo: null, photoUrl: "", base64: "", result: null, lines: [], review: null, error: "",
      fixing: -1, camErr: "", booking: null, patient: null, pickPatient: false });   // NEW: patient reset
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
  
  /* ---------- Taps, pinch and buttons ---------- */
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

  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-role="tip"]') && st.camErr && st.mode === "camera") {
      st.camErr = "";
      stopCamera();
      render();   // draws the viewfinder again and starts the camera
      return;
    }
    const kd = e.target.closest("[data-kind]");
    if (kd) { if (st.mode !== "busy" && !st.busy && st.kind !== kd.dataset.kind) { st.kind = kd.dataset.kind; again(); } return; }
    const z = e.target.closest("[data-zoom]");
    if (z) { st.zoom = Number(z.dataset.zoom); applyZoom(); return; }
    const fx = e.target.closest("[data-fix]");
    if (fx) { const i = Number(fx.dataset.fix); st.fixing = st.fixing === i ? -1 : i; render(); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "cam-retry") { st.camErr = ""; stopCamera(); render(); return; }
    if (act === "shoot") shoot();
    else if (act === "torch" && st.track) {
      st.torch = !st.torch;
      st.track.applyConstraints({ advanced: [{ torch: st.torch }] }).catch(() => {});
      b.classList.toggle("is-on", st.torch);
    } else if (act === "again") again();
    else if (act === "retry") analyse();
    else if (act === "save") save(b);
    else if (act === "pickpat") { st.pickPatient = !st.pickPatient; render(); }   // NEW
    else if (act === "big") { const big = root.querySelector('[data-role="big"]'); if (big) big.hidden = !big.hidden; }
  });

  // Typing a quantity or a fee: the totals update straight away; the flags update when you leave the box
  root.addEventListener("input", (e) => {
    const t = e.target;
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
      if (f) usePhoto(f);
      return;
    }
    if (t.dataset.patsel !== undefined) {   // NEW: staff picked the right booking
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

  // The camera is switched off when leaving the page, putting the iPad down, refreshing,
  // or when this Scanner is no longer on screen. It comes back on when you return.
  const cleanup = () => {
    stopCamera();
    window.removeEventListener("hashchange", onHash);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", stopCamera);
    if (releaseCamera === cleanup) releaseCamera = null;
  };
  const onVis = () => {
    if (!root.isConnected) { cleanup(); return; }
    if (document.hidden) stopCamera();
    else if (st.mode === "camera") startCamera();
  };
  const onHash = () => {
    if (location.hash.startsWith("#/scanner") && root.isConnected) return;
    cleanup();
  };
  window.addEventListener("hashchange", onHash);
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", stopCamera);   // a refresh or closed tab never leaves the camera stuck
  releaseCamera = cleanup;

  render();
}