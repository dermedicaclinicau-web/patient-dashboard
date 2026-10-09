// A small rich text editor for emails: headings, bold, colours, lists, links,
// Image Bank pictures, buttons, dividers and spacing.
import { cleanRichHtml, hydrateRichImages, textToRichHtml } from "./rich-html.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  bold: ic('<path d="M6 4h8a4 4 0 0 1 0 8H6z"/><path d="M6 12h9a4 4 0 0 1 0 8H6z"/>'),
  italic: ic('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>'),
  underline: ic('<path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" y1="21" x2="20" y2="21"/>'),
  colour: ic('<path d="M6 16l6-12 6 12"/><line x1="8.5" y1="11" x2="15.5" y2="11"/><line x1="4" y1="21" x2="20" y2="21"/>'),
  left: ic('<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>'),
  center: ic('<line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/>'),
  right: ic('<line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/>'),
  ul: ic('<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  ol: ic('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
  link: ic('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  image: ic('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  button: ic('<rect x="3" y="7" width="18" height="10" rx="3"/><line x1="8" y1="12" x2="16" y2="12"/>'),
  hr: ic('<line x1="3" y1="12" x2="21" y2="12"/>'),
  space: ic('<polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/>'),
  clear: ic('<path d="M20 20H7L3 16l10-10 7 7-6.5 6.5"/><line x1="18" y1="13" x2="11" y2="6"/>'),
  undo: ic('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
  redo: ic('<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>'),
};
const COLOURS = ["#1e293b", "#475569", "#0f766e", "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a"];
const STATE_CMDS = ["bold", "italic", "underline", "justifyLeft", "justifyCenter", "justifyRight", "insertUnorderedList", "insertOrderedList"];

function askDialog({ title, fields, confirm = "Add" }) {
  return new Promise((resolve) => {
    let result = null;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog fe-confirm";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${esc(title)}</h3></div>
        ${fields.map((f) => `<label class="lh-field"><span class="lh-label">${esc(f.label)}</span>
          <input type="text" name="${f.key}" maxlength="500" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}" /></label>`).join("")}
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${esc(confirm)}</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const out = {};
      fields.forEach((f) => { out[f.key] = form.elements[f.key].value.trim(); });
      const missing = fields.find((f) => f.required && !out[f.key]);
      if (missing) {
        const er = dlg.querySelector(".lh-error");
        er.textContent = `Fill in ${missing.label.toLowerCase()}.`;
        er.hidden = false;
        return;
      }
      result = out;
      dlg.close();
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    dlg.showModal();
    form.elements[fields[0].key].select();
  });
}

const fixUrl = (u) => {
  const s = String(u || "").trim();
  if (!s) return "";
  return /^(https?:|mailto:|tel:)/i.test(s) ? s : "https://" + s.replace(/^\/+/, "");
};

export function createRichEditor(host, {
  onInput = () => {}, onFocus = () => {}, pickImage = null,
  accent = () => "#0f766e", logo = () => "",
} = {}) {
  const btn = (cmd, icon, title) =>
    `<button type="button" class="re-btn" data-cmd="${cmd}" title="${title}" aria-label="${title}">${icon}</button>`;
  host.innerHTML = `
    <div class="re">
      <div class="re-bar" role="toolbar" aria-label="Formatting">
        <select class="re-block" aria-label="Text style">
          <option value="p">Normal text</option><option value="h1">Title</option>
          <option value="h2">Heading</option><option value="h3">Subheading</option>
        </select>
        <span class="re-sep"></span>
        ${btn("bold", I.bold, "Bold")}${btn("italic", I.italic, "Italic")}${btn("underline", I.underline, "Underline")}
        <span class="re-pop-wrap">${btn("colour", I.colour, "Text colour")}
          <div class="re-pop" hidden>${COLOURS.map((c) => `<button type="button" class="re-sw" data-colour="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join("")}</div>
        </span>
        <span class="re-sep"></span>
        ${btn("justifyLeft", I.left, "Align left")}${btn("justifyCenter", I.center, "Centre")}${btn("justifyRight", I.right, "Align right")}
        ${btn("insertUnorderedList", I.ul, "Bulleted list")}${btn("insertOrderedList", I.ol, "Numbered list")}
        <span class="re-sep"></span>
        ${btn("link", I.link, "Link")}${pickImage ? btn("image", I.image, "Picture from the Image Bank") : ""}
        ${btn("button", I.button, "Button")}${btn("divider", I.hr, "Divider line")}${btn("spacer", I.space, "Extra space")}
        <span class="re-sep"></span>
        ${btn("removeFormat", I.clear, "Clear formatting")}${btn("undo", I.undo, "Undo")}${btn("redo", I.redo, "Redo")}
      </div>
      <div class="re-area" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message"></div>
      <div class="re-imgbar" role="toolbar" aria-label="Picture" hidden>
        <button type="button" data-imgw="33">Small</button><button type="button" data-imgw="60">Medium</button><button type="button" data-imgw="100">Full width</button>
        <span class="re-sep"></span>
        <button type="button" data-imga="left">Left</button><button type="button" data-imga="center">Centre</button>
        <span class="re-sep"></span>
        <button type="button" data-imgdel class="is-danger">Remove</button>
      </div>
    </div>`;

  const wrap = host.querySelector(".re");
  const bar = host.querySelector(".re-bar");
  const area = host.querySelector(".re-area");
  const blockSel = host.querySelector(".re-block");
  const pop = host.querySelector(".re-pop");
  const imgbar = host.querySelector(".re-imgbar");
  let saved = null;
  let selImg = null;

  const changed = () => onInput();
  const hydrate = () => hydrateRichImages(area, { logo: logo() });

  /* ---------- Keeping the cursor while using the toolbar ---------- */
  const onSel = () => {
    if (!area.isConnected) { document.removeEventListener("selectionchange", onSel); return; }
    const s = getSelection();
    if (s.rangeCount && area.contains(s.anchorNode)) { saved = s.getRangeAt(0).cloneRange(); updateState(); }
  };
  document.addEventListener("selectionchange", onSel);

  function restore() {
    area.focus();
    const s = getSelection();
    s.removeAllRanges();
    if (saved && area.contains(saved.startContainer)) s.addRange(saved);
    else { const r = document.createRange(); r.selectNodeContents(area); r.collapse(false); s.addRange(r); }
  }
  function exec(cmd, val = null) {
    restore();
    document.execCommand("styleWithCSS", false, cmd === "foreColor");
    document.execCommand(cmd, false, val);
    changed();
    updateState();
  }
  const insertHtml = (h) => { restore(); document.execCommand("insertHTML", false, h); hydrate(); changed(); };

  function updateState() {
    STATE_CMDS.forEach((c) => {
      const b = bar.querySelector(`[data-cmd="${c}"]`);
      let on = false;
      try { on = document.queryCommandState(c); } catch { /* not supported */ }
      if (b) { b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", String(on)); }
    });
    let block = "p";
    try { block = String(document.queryCommandValue("formatBlock") || "p").toLowerCase().replace(/[<>]/g, ""); } catch { /* ignore */ }
    blockSel.value = ["h1", "h2", "h3"].includes(block) ? block : "p";
  }

  /* ---------- Toolbar ---------- */
  bar.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  blockSel.addEventListener("change", () => exec("formatBlock", `<${blockSel.value}>`));

  bar.addEventListener("click", async (e) => {
    const sw = e.target.closest("[data-colour]");
    if (sw) { pop.hidden = true; exec("foreColor", sw.dataset.colour); return; }
    const b = e.target.closest("[data-cmd]");
    if (!b) return;
    const cmd = b.dataset.cmd;
    if (cmd === "colour") { pop.hidden = !pop.hidden; return; }
    pop.hidden = true;

    if (cmd === "link") {
      const text = saved ? saved.toString() : "";
      const res = await askDialog({
        title: "Add a link",
        fields: [
          { key: "url", label: "Web address", value: "https://", required: true },
          ...(text ? [] : [{ key: "text", label: "Text to show", placeholder: "e.g. Read more about this treatment" }]),
        ],
      });
      if (!res) return;
      const url = fixUrl(res.url);
      if (text) exec("createLink", url);
      else insertHtml(`<a href="${esc(url)}">${esc(res.text || url)}</a>&nbsp;`);
      return;
    }
    if (cmd === "image") {
      const img = await pickImage();
      if (!img) return;
      insertHtml(`<img data-bank="${esc(img.id)}" alt="${esc(String(img.name || "").replace(/\.[^.]+$/, ""))}" width="560" style="display:block;width:100%;max-width:100%;height:auto;margin:0 auto;border-radius:8px"><p><br></p>`);
      return;
    }
    if (cmd === "button") {
      const res = await askDialog({
        title: "Add a button",
        fields: [
          { key: "text", label: "Button text", placeholder: "e.g. Book your review", required: true },
          { key: "url", label: "Web address it opens", value: "https://", required: true },
        ],
      });
      if (!res) return;
      insertHtml(`<p style="text-align:center"><a href="${esc(fixUrl(res.url))}" style="display:inline-block;padding:12px 28px;background-color:${accent()};color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold">${esc(res.text)}</a></p><p><br></p>`);
      return;
    }
    if (cmd === "divider") { insertHtml('<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"><p><br></p>'); return; }
    if (cmd === "spacer") { insertHtml('<div style="height:24px;line-height:24px">&nbsp;</div><p><br></p>'); return; }
    exec(cmd);
  });

  document.addEventListener("mousedown", function closePop(e) {
    if (!wrap.isConnected) { document.removeEventListener("mousedown", closePop); return; }
    if (!e.target.closest(".re-pop-wrap")) pop.hidden = true;
  });

  /* ---------- Typing, pasting ---------- */
  area.addEventListener("focus", () => {
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older browsers */ }
    onFocus();
  });
  area.addEventListener("input", () => { hideImgBar(); changed(); });
  area.addEventListener("keyup", updateState);
  area.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    const html = cd.getData("text/html");
    const text = cd.getData("text/plain");
    if (html) insertHtml(cleanRichHtml(html.replace(/<!--[\s\S]*?-->/g, "")));
    else if (!/\n/.test(text)) { restore(); document.execCommand("insertText", false, text); changed(); }
    else insertHtml(textToRichHtml(text));
  });
  area.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) e.preventDefault(); // pictures come from the Image Bank
  });

  /* ---------- Clicking a picture ---------- */
  function showImgBar() {
    if (!selImg || !selImg.isConnected) { hideImgBar(); return; }
    area.querySelectorAll("img.is-sel").forEach((x) => x.classList.remove("is-sel"));
    selImg.classList.add("is-sel");
    const r = selImg.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    imgbar.style.top = `${Math.max(0, r.top - w.top + 8)}px`;
    imgbar.style.left = `${Math.max(8, r.left - w.left + 8)}px`;
    imgbar.hidden = false;
  }
  function hideImgBar() {
    imgbar.hidden = true;
    area.querySelectorAll("img.is-sel").forEach((x) => x.classList.remove("is-sel"));
    selImg = null;
  }
  area.addEventListener("click", (e) => {
    const img = e.target.closest("img[data-bank]");
    if (img) { selImg = img; showImgBar(); } else hideImgBar();
  });
  imgbar.addEventListener("mousedown", (e) => e.preventDefault());
  imgbar.addEventListener("click", (e) => {
    if (!selImg) return;
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.imgw) {
      selImg.style.width = `${b.dataset.imgw}%`;
      selImg.setAttribute("width", String(Math.round(560 * Number(b.dataset.imgw) / 100)));
    } else if (b.dataset.imga) {
      selImg.style.margin = b.dataset.imga === "center" ? "0 auto" : "0";
    } else if (b.dataset.imgdel !== undefined) {
      selImg.remove();
      hideImgBar();
      changed();
      return;
    }
    changed();
    showImgBar();
  });

  return {
    getHtml: () => cleanRichHtml(area.innerHTML),
    setHtml(h) { area.innerHTML = h || "<p><br></p>"; hideImgBar(); hydrate(); },
    insertToken(name) { restore(); document.execCommand("insertText", false, `{${name}}`); changed(); },
    text: () => area.textContent || "",
    focus: () => area.focus(),
    hydrate,
    area,
  };
}