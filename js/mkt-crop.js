// Marketing emails: crop a picture to a shape (square, 16:9…). Drag to move it, zoom with the slider or the mouse wheel.
// Email apps can't crop pictures themselves, so the cropped copy is made here and saved as its own file.
const RATIOS = [
  ["free", "Original", 0], ["1:1", "Square", 1], ["4:3", "4:3", 4 / 3], ["3:2", "3:2", 3 / 2],
  ["16:9", "16:9", 16 / 9], ["2:1", "Banner", 2], ["4:5", "Portrait", 4 / 5],
];
const MAX_OUT = 1200;   // pixels wide at most (emails are 600 wide; this stays sharp on phones)
const clamp01 = (v, d = 0.5) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d; };
const loadImg = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

// → { blob, state } once cropped, or null if cancelled. state lets the next crop start where this one left off.
export async function openCropper(blob, prev = null) {
  const url = URL.createObjectURL(blob);
  let img;
  try { img = await loadImg(url); } catch {
    URL.revokeObjectURL(url);
    throw new Error("That picture couldn't be opened for cropping.");
  }
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  return new Promise((resolve) => {
    let result = null;
    const st = {
      ratio: prev && RATIOS.some((r) => r[0] === prev.ratio) ? prev.ratio : "free",
      zoom: Math.min(4, Math.max(1, Number(prev && prev.zoom) || 1)),
      cx: clamp01(prev && prev.cx), cy: clamp01(prev && prev.cy),
    };
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog mk-dlg mcrop-dlg";
    dlg.innerHTML = `
      <div class="lh-form">
        <div class="lh-dialog-head"><h3>Crop the picture</h3>
          <p>Choose a shape, then drag the picture to move it. Zoom with the slider or your mouse wheel.</p></div>
        <div class="mcrop-ratios" role="radiogroup" aria-label="Shape">${RATIOS.map(([k, l]) =>
          `<button type="button" class="ch-chip" data-ratio="${k}" role="radio">${l}</button>`).join("")}</div>
        <div class="mcrop-wrap" data-role="wrap"><div class="mcrop-frame" data-role="frame"><img alt="" draggable="false" data-role="img" /></div></div>
        <label class="mcrop-zoom"><span>Zoom</span><input type="range" min="1" max="4" step="0.01" data-role="zoom" /></label>
        ${/gif/i.test(blob.type) ? '<p class="fe-note">This is a GIF: the cropped copy will be a still picture.</p>' : ""}
        <p class="fe-note" data-role="size"></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="reset">Reset</button>
          <span class="inv-spacer"></span>
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="button" class="lh-btn is-primary" data-act="apply">Use this crop</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    const $ = (r) => dlg.querySelector(`[data-role="${r}"]`);
    const frame = $("frame");
    const im = $("img");
    const zoomEl = $("zoom");
    im.src = url;
    let fw = 0;
    let fh = 0;
    let s = 1;   // screen pixels per picture pixel

    const ratioOf = () => RATIOS.find((r) => r[0] === st.ratio)[2] || iw / ih;
    function layout() {
      const r = ratioOf();
      fw = Math.max(200, Math.min(560, ($("wrap").clientWidth || 588) - 28));
      fh = fw / r;
      if (fh > 380) { fh = 380; fw = fh * r; }
      frame.style.width = `${Math.round(fw)}px`;
      frame.style.height = `${Math.round(fh)}px`;
      frame.classList.toggle("is-square", st.ratio === "1:1");
      s = Math.max(fw / iw, fh / ih) * st.zoom;
      const sw = fw / s;
      const sh = fh / s;
      const cx = Math.min(iw - sw / 2, Math.max(sw / 2, st.cx * iw));
      const cy = Math.min(ih - sh / 2, Math.max(sh / 2, st.cy * ih));
      st.cx = cx / iw;
      st.cy = cy / ih;
      im.style.width = `${iw * s}px`;
      im.style.height = `${ih * s}px`;
      im.style.transform = `translate(${fw / 2 - cx * s}px, ${fh / 2 - cy * s}px)`;
      const outW = Math.round(Math.min(MAX_OUT, sw));
      $("size").textContent = `The cropped picture will be ${outW} × ${Math.round((outW * sh) / sw)} pixels.` +
        (sw < 500 ? " That's quite small, so it may look soft if it's shown wide." : "");
      dlg.querySelectorAll("[data-ratio]").forEach((b) => {
        const on = b.dataset.ratio === st.ratio;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-checked", String(on));
      });
      zoomEl.value = String(st.zoom);
    }

    let drag = null;
    frame.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY };
      frame.setPointerCapture(e.pointerId);
      frame.classList.add("is-drag");
    });
    frame.addEventListener("pointermove", (e) => {
      if (!drag) return;
      st.cx -= (e.clientX - drag.x) / s / iw;
      st.cy -= (e.clientY - drag.y) / s / ih;
      drag = { x: e.clientX, y: e.clientY };
      layout();
    });
    const endDrag = () => { drag = null; frame.classList.remove("is-drag"); };
    frame.addEventListener("pointerup", endDrag);
    frame.addEventListener("pointercancel", endDrag);
    frame.addEventListener("wheel", (e) => {
      e.preventDefault();
      st.zoom = Math.min(4, Math.max(1, st.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
      layout();
    }, { passive: false });
    zoomEl.addEventListener("input", () => { st.zoom = Number(zoomEl.value) || 1; layout(); });

    async function apply(btn) {
      btn.disabled = true;
      btn.textContent = "Cropping…";
      const sw = fw / s;
      const sh = fh / s;
      const outW = Math.max(1, Math.round(Math.min(MAX_OUT, sw)));
      const outH = Math.max(1, Math.round((outW * sh) / sw));
      const c = document.createElement("canvas");
      c.width = outW;
      c.height = outH;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, st.cx * iw - sw / 2, st.cy * ih - sh / 2, sw, sh, 0, 0, outW, outH);
      const type = /png|gif/i.test(blob.type) ? "image/png" : "image/jpeg";   // PNG keeps see-through areas
      let out = await new Promise((res) => c.toBlob(res, type, 0.88));
      // A big PNG (usually a photo) is saved as a JPEG instead, on white, so emails stay light
      if (out && type === "image/png" && out.size > 1.5 * 1024 * 1024) {
        const w = document.createElement("canvas");
        w.width = outW;
        w.height = outH;
        const wx = w.getContext("2d");
        wx.fillStyle = "#ffffff";
        wx.fillRect(0, 0, outW, outH);
        wx.drawImage(c, 0, 0);
        out = (await new Promise((res) => w.toBlob(res, "image/jpeg", 0.88))) || out;
      }
      if (!out) { btn.disabled = false; btn.textContent = "Use this crop"; return; }
      result = { blob: out, state: { ratio: st.ratio, zoom: st.zoom, cx: st.cx, cy: st.cy } };
      dlg.close();
    }

    dlg.addEventListener("click", (e) => {
      const r = e.target.closest("[data-ratio]");
      if (r) { st.ratio = r.dataset.ratio; layout(); return; }
      if (e.target.closest('[data-act="reset"]')) { st.zoom = 1; st.cx = 0.5; st.cy = 0.5; layout(); return; }
      if (e.target.closest('[data-act="cancel"]')) { dlg.close(); return; }
      const a = e.target.closest('[data-act="apply"]');
      if (a) apply(a);
    });
    dlg.addEventListener("close", () => {
      window.removeEventListener("resize", layout);
      URL.revokeObjectURL(url);
      dlg.remove();
      resolve(result);
    });
    dlg.showModal();
    window.addEventListener("resize", layout);
    requestAnimationFrame(layout);
  });
}