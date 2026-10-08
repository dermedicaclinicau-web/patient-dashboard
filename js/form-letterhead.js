// The clinic letterhead shared by every form: defaults, logo preparation,
// how it looks on a form, and the window for editing it.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

export const DEFAULT_LETTERHEAD = {
  logo: "",
  logoSize: "medium",
  name: "Dermedica",
  showName: true,
  line1: "Unit 4/91 Scarborough Beach Rd, Scarborough WA 6019, Australia",
  line2: "info@dermedica.com.au  |  Tel: 9205 1995",
  layout: "split",
};

const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

export function normaliseLetterhead(d = {}) {
  return {
    logo: typeof d.logo === "string" && LOGO_RE.test(d.logo) ? d.logo : "",
    logoSize: pick(d.logoSize, ["small", "medium", "large"], "medium"),
    name: String(d.name ?? DEFAULT_LETTERHEAD.name).slice(0, 80),
    showName: d.showName !== false,
    line1: String(d.line1 ?? DEFAULT_LETTERHEAD.line1).slice(0, 150),
    line2: String(d.line2 ?? DEFAULT_LETTERHEAD.line2).slice(0, 150),
    layout: pick(d.layout, ["split", "centre"], "split"),
  };
}

// Shrinks an uploaded logo so it can be stored with the form settings.
// Keeps transparency (PNG) unless the original was a JPG.
export async function prepareLogo(file) {
  if (!file || !/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPG, WebP or SVG image.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("That image is over 10 MB. Choose a smaller one.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That image couldn't be opened. Try saving it as a PNG."));
      i.src = url;
    });
    const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    for (const max of [900, 600, 400]) {
      const w0 = img.naturalWidth || 600, h0 = img.naturalHeight || 200;
      const scale = Math.min(1, max / Math.max(w0, h0));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w0 * scale));
      c.height = Math.max(1, Math.round(h0 * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL(type, 0.9);
      if (data.length < 700000) return data;
    }
    throw new Error("That logo is too detailed to store. Try a simpler or smaller image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function letterheadHtml(lh) {
  const d = lh || DEFAULT_LETTERHEAD;
  const logo = typeof d.logo === "string" && d.logo.startsWith("data:image/")
    ? `<img class="lh-logo is-${esc(d.logoSize || "medium")}" src="${esc(d.logo)}" alt="${esc(d.name || "Clinic")} logo" />`
    : "";
  const name = d.showName !== false && d.name ? `<span class="lh-name">${esc(d.name)}</span>` : "";
  const lines = [d.line1, d.line2].filter(Boolean).map(esc).join("<br>");
  return `<div class="lh is-${esc(d.layout || "split")}">
    ${logo || name ? `<div class="lh-brand">${logo}${name}</div>` : ""}
    ${lines ? `<div class="lh-lines">${lines}</div>` : ""}
  </div>`;
}

// Opens the letterhead window. onSave(letterhead) must save it, and may throw.
export function openLetterheadDialog({ letterhead, onSave }) {
  const draft = normaliseLetterhead(letterhead || DEFAULT_LETTERHEAD);
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog";
  dlg.setAttribute("aria-labelledby", "lh-dialog-title");
  const opt = (v, l, cur) => `<option value="${v}"${cur === v ? " selected" : ""}>${l}</option>`;

  dlg.innerHTML = `
    <form class="lh-form" novalidate>
      <div class="lh-dialog-head">
        <h3 id="lh-dialog-title">Letterhead</h3>
        <p>Shared by every form, so changes show on all of them.</p>
      </div>
      <div class="lh-preview" data-role="preview"></div>

      <div class="lh-field">
        <span class="lh-label">Logo</span>
        <div class="lh-logo-row">
          <label class="lh-btn">
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-role="file" hidden />
            <span data-role="filelabel"></span>
          </label>
          <button type="button" class="lh-btn is-quiet" data-act="remove-logo">Remove logo</button>
        </div>
        <small class="lh-note">A PNG with a transparent background looks best.</small>
      </div>

      <div class="lh-two">
        <label class="lh-field"><span class="lh-label">Logo size</span>
          <select data-k="logoSize">${opt("small", "Small", draft.logoSize)}${opt("medium", "Medium", draft.logoSize)}${opt("large", "Large", draft.logoSize)}</select>
        </label>
        <label class="lh-field"><span class="lh-label">Layout</span>
          <select data-k="layout">${opt("split", "Logo left, details right", draft.layout)}${opt("centre", "Centred", draft.layout)}</select>
        </label>
      </div>

      <label class="lh-field"><span class="lh-label">Clinic name</span>
        <input type="text" data-k="name" maxlength="80" value="${esc(draft.name)}" />
      </label>
      <label class="lh-check"><input type="checkbox" data-k="showName"${draft.showName ? " checked" : ""} /> Show the name beside the logo</label>

      <label class="lh-field"><span class="lh-label">Address line</span>
        <input type="text" data-k="line1" maxlength="150" value="${esc(draft.line1)}" />
      </label>
      <label class="lh-field"><span class="lh-label">Contact line</span>
        <input type="text" data-k="line2" maxlength="150" value="${esc(draft.line2)}" />
      </label>

      <p class="lh-error" data-role="error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary" data-role="save">Save letterhead</button>
      </div>
    </form>`;

  const $ = (s) => dlg.querySelector(s);
  const errEl = $('[data-role="error"]');
  const showError = (msg) => { errEl.textContent = msg || ""; errEl.hidden = !msg; };

  function refresh() {
    $('[data-role="preview"]').innerHTML = letterheadHtml(draft);
    $('[data-role="filelabel"]').textContent = draft.logo ? "Replace logo" : "Upload logo";
    $('[data-act="remove-logo"]').hidden = !draft.logo;
  }

  dlg.addEventListener("input", (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    draft[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    refresh();
  });

  $('[data-role="file"]').addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    showError("");
    $('[data-role="filelabel"]').textContent = "Preparing…";
    try {
      draft.logo = await prepareLogo(file);
    } catch (err) {
      showError(err.message);
    }
    refresh();
  });

  dlg.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="remove-logo"]')) { draft.logo = ""; refresh(); }
    if (e.target.closest('[data-act="cancel"]')) dlg.close();
  });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $('[data-role="save"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    showError("");
    try {
      await onSave(normaliseLetterhead(draft));
      dlg.close();
    } catch (err) {
      console.error("Letterhead save failed:", err);
      showError(err && err.code === "permission-denied"
        ? "You don't have permission to change the letterhead. Check the form_settings rule has been published."
        : "Couldn't save. Check your connection and try again.");
      btn.disabled = false;
      btn.textContent = "Save letterhead";
    }
  });

  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  refresh();
  dlg.showModal();
}