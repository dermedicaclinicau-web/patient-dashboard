// Scanner (#/scanner): photograph a billing sheet with the products on it.
// Gemini reads the handwriting and the labels; the portal matches both to the product list and flags anything that doesn't line up.
// Nothing here changes stock. Each scan is kept (Firestore: scans) with its photo.
import { listProducts, INV_CATEGORIES } from "./inventory-api.js";
import { preparePhoto, readBillingSheet, startReview, reviewBilling, saveBillingScan, money } from "./scanner-api.js";
import { showToast } from "./utils.js";

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

export function mountScanner(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page scan";
  container.replaceChildren(root);

  let products = [];
  const productsReady = listProducts().then((list) => { products = list.filter((p) => p.active); })
    .catch((err) => console.error("Scanner: the product list didn't load", err));

  const st = {
    mode: "camera", stream: null, track: null, starting: false, zoom: 1, hw: null, torch: false, canTorch: false, canFocus: false,
    camErr: "", photo: null, photoUrl: "", base64: "", result: null, lines: [], review: null, error: "", fixing: -1, busy: false,
  };

  /* ---------- Screens ---------- */
  const headHtml = () => `<div class="scan-head"><div class="scan-modes" role="tablist" aria-label="What you're scanning">
      <button type="button" class="scan-mode is-on" role="tab" aria-selected="true">Billing sheet</button>
      <button type="button" class="scan-mode" role="tab" aria-selected="false" disabled>Delivery docket <small>soon</small></button>
    </div></div>`;

  const cameraHtml = () => `${headHtml()}
    <div class="scan-vf" data-role="vf">
      <video playsinline muted autoplay></video>
      <div class="scan-frame" aria-hidden="true"></div>
      <span class="scan-focus" data-role="focus" aria-hidden="true"></span>
      <p class="scan-tip${st.camErr ? " is-bad" : ""}" data-role="tip">${esc(st.camErr || "Fit the billing sheet and the products inside the frame")}</p>
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
      <div class="scan-busy"><span class="scan-spin"></span>Reading the sheet and the products…</div></div>`;

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

  const rowHtml = (l, i) => {
    const bad = l.flags.some((f) => f[0] === "bad");
    const written = l.written.map((w) => `“${w.text}”${w.qty > 1 ? ` ×${w.qty}` : ""}`).join(", ");
    const seenAs = !l.product && l.seenText.length ? ` (${l.seenText.join(", ")})` : "";
    return `<div class="scan-row${l.flags.length ? (bad ? " is-bad" : " is-warn") : ""}">
      <div class="scan-row-main">
        <button type="button" class="scan-name" data-fix="${i}">${esc(l.product ? l.product.name : "Not matched")}<small>change</small></button>
        <small>${written ? `Written ${esc(written)}` : "Not written on the sheet"}${l.seen ? ` · in the photo${l.seen > 1 ? ` ×${l.seen}` : ""}${esc(seenAs)}` : ""}</small>
        ${l.flags.map(([t, m]) => `<span class="scan-flag is-${t}">${esc(m)}</span>`).join("")}
        ${st.fixing === i ? fixHtml(l, i) : ""}
      </div>
      <span class="scan-fee">${l.fee !== null ? esc(money(l.fee)) : l.qty ? "none" : ""}</span>
      <span class="scan-seen ${l.seen ? "is-yes" : "is-no"}" aria-label="${l.seen ? "In the photo" : "Not in the photo"}">${l.seen ? "✓" : "✕"}</span>
    </div>`;
  };

  function resultHtml() {
    const r = st.review;
    const when = [r.apptDate && niceDate(r.apptDate), r.apptTime, r.provider].filter(Boolean).join(" · ");
    const sumText = `Products ${money(r.productsTotal)} + services ${money(r.servicesTotal)} = ${money(r.sum)}`;
    return `${headHtml()}
      <div class="scan-res-head">
        <button type="button" class="scan-thumb" data-act="big" aria-label="Show the photo larger"><img src="${st.photoUrl}" alt="" /></button>
        <div><strong>${esc(r.patientName || "Patient name not read")}</strong><small>${esc(when || "Date not read")}</small></div>
        <span class="scan-chip ${r.flagCount ? "is-warn" : "is-ok"}">${r.flagCount ? `${r.flagCount} to check` : "All matches"}</span>
      </div>
      <div class="scan-big" data-role="big" hidden><img src="${st.photoUrl}" alt="The photo" /></div>
      ${r.lines.length ? `<div class="scan-list">
          <div class="scan-list-head"><span>Product</span><span class="scan-fee">Fee</span><span class="scan-seen">Seen</span></div>
          ${r.lines.map(rowHtml).join("")}
        </div>`
        : '<p class="scan-err">No products were found on the sheet or in the photo. Try a closer, clearer photo.</p>'}
      ${r.services.length ? `<div class="scan-svc"><h4>Services</h4>${r.services.map((s) =>
        `<div class="scan-svc-row"><span>${esc(s.text)}</span><span>${esc(money(s.fee))}</span></div>`).join("")}</div>` : ""}
      <p class="scan-total${r.totalFlag ? " is-warn" : ""}">${esc(r.totalFlag
        || (r.writtenTotal !== null ? `${sumText} ✓ matches the total written` : sumText))}</p>
      ${r.flagCount ? `<label class="lh-field"><span class="lh-label">What happened? (optional)</span>
        <textarea data-role="note" rows="2" maxlength="1000" placeholder="e.g. SPF given as a sample, no charge"></textarea></label>` : ""}
      <div class="scan-acts">
        <button type="button" class="lh-btn" data-act="again">Scan again</button>
        <button type="button" class="lh-btn is-primary" data-act="save">${r.flagCount ? "Save" : "Looks right"}</button>
      </div>`;
  }

  function render() {
    root.innerHTML = st.mode === "camera" ? cameraHtml() : st.mode === "busy" ? busyHtml()
      : st.mode === "error" ? errorHtml() : resultHtml();
    if (st.mode === "camera") startCamera();
  }

  /* ---------- Camera ---------- */
  function stopCamera() {
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    st.track = null;
    st.torch = false;
  }

  async function startCamera() {
    if (st.starting || st.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setTip("This browser can't show the camera here. Use Camera app or Upload below.", true);
      return;
    }
    st.starting = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 4032 }, height: { ideal: 3024 } },
      });
      if (!root.isConnected || st.mode !== "camera") { stream.getTracks().forEach((t) => t.stop()); return; }
      st.stream = stream;
      st.track = stream.getVideoTracks()[0];
      const caps = st.track.getCapabilities ? st.track.getCapabilities() : {};
      st.hw = caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max } : null;   // real optical/sensor zoom where allowed
      st.canTorch = !!caps.torch;
      st.canFocus = Array.isArray(caps.focusMode) && caps.focusMode.includes("single-shot");
      const v = root.querySelector(".scan-vf video");
      if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
      const tb = root.querySelector('[data-act="torch"]');
      if (tb) tb.hidden = !st.canTorch;
      st.camErr = "";
      applyZoom();
    } catch (err) {
      console.warn("Camera failed:", err);
      setTip(err && err.name === "NotAllowedError"
        ? "Camera access is blocked. Allow the camera for this site in Settings, or use Camera app or Upload below."
        : "Couldn't start the camera. Use Camera app or Upload below.", true);
    } finally {
      st.starting = false;
    }
  }

  function setTip(text, bad = false) {
    st.camErr = bad ? text : "";
    const tip = root.querySelector('[data-role="tip"]');
    if (tip) { tip.textContent = text; tip.classList.toggle("is-bad", bad); }
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
      await productsReady;
      if (!products.length) throw new Error("Couldn't load the product list. Check your connection and try again.");
      st.result = await readBillingSheet(st.base64, products);
      st.review = reviewBilling(startReview(st.result, products), st.result, products);
      st.lines = st.review.lines;
      st.mode = "result";
    } catch (err) {
      console.error("Scan failed:", err);
      st.error = (err && err.message) || "The scanner couldn't read that photo. Try again.";
      st.mode = "error";
    }
    if (root.isConnected) render();
  }

  function again() {
    if (st.photoUrl) URL.revokeObjectURL(st.photoUrl);
    Object.assign(st, { mode: "camera", photo: null, photoUrl: "", base64: "", result: null, lines: [], review: null, error: "", fixing: -1, camErr: "" });
    render();
  }

  async function save(btn) {
    if (st.busy) return;
    st.busy = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const note = root.querySelector('[data-role="note"]');
      await saveBillingScan({ photo: st.photo, result: st.result, review: st.review, note: note ? note.value : "" }, staff);
      showToast(st.review.flagCount ? "Saved, with what needs checking" : "Saved");
      again();
    } catch (err) {
      console.error("Save scan failed:", err);
      showToast(err && err.code === "permission-denied"
        ? "Saving scans is blocked. Ask an Admin to publish the Firestore rule for scans."
        : "Couldn't save. Try again.");
      btn.disabled = false;
      btn.textContent = st.review.flagCount ? "Save" : "Looks right";
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
    const z = e.target.closest("[data-zoom]");
    if (z) { st.zoom = Number(z.dataset.zoom); applyZoom(); return; }
    const fx = e.target.closest("[data-fix]");
    if (fx) { const i = Number(fx.dataset.fix); st.fixing = st.fixing === i ? -1 : i; render(); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "shoot") shoot();
    else if (act === "torch" && st.track) {
      st.torch = !st.torch;
      st.track.applyConstraints({ advanced: [{ torch: st.torch }] }).catch(() => {});
      b.classList.toggle("is-on", st.torch);
    } else if (act === "again") again();
    else if (act === "retry") analyse();
    else if (act === "save") save(b);
    else if (act === "big") { const big = root.querySelector('[data-role="big"]'); if (big) big.hidden = !big.hidden; }
  });

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.role === "file") {
      const f = t.files && t.files[0];
      t.value = "";
      if (f) usePhoto(f);
      return;
    }
    if (t.dataset.fixsel !== undefined) {   // staff picked the right product for a line
      const l = st.lines[Number(t.dataset.fixsel)];
      if (!l) return;
      l.productId = t.value;
      l.fixed = true;
      st.review = reviewBilling(st.lines, st.result, products);
      st.lines = st.review.lines;
      st.fixing = -1;
      render();
    }
  });

  // The camera is switched off when leaving the page or putting the iPad down, and back on when you return
  const onVis = () => {
    if (document.hidden) stopCamera();
    else if (st.mode === "camera" && root.isConnected) startCamera();
  };
  const onHash = () => {
    if (location.hash.startsWith("#/scanner")) return;
    stopCamera();
    window.removeEventListener("hashchange", onHash);
    document.removeEventListener("visibilitychange", onVis);
  };
  window.addEventListener("hashchange", onHash);
  document.addEventListener("visibilitychange", onVis);

  render();
}