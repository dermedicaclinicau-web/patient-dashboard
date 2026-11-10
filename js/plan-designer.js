// Treatment plan page designer, laid out like Form Builder:
// Add on the left, the page in the middle (click a block to select it), the selected block's settings on the right.
import { createRichEditor } from "./rich-editor.js";
import { textToRichHtml } from "./rich-html.js";
import { openImagePicker } from "./image-bank.js";
import { bankImage } from "./image-bank-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => Math.random().toString(36).slice(2, 10);
const NAME = { title: "Title and date", text: "Text", message: "Your message", concerns: "Concerns", treatments: "Treatments table",
  timeline: "Next 12 months", divider: "Line", space: "Space", sign: "Signature line", image: "Image" };
const LAYOUT = [["heading", "Heading"], ["text", "Text block"], ["image", "Image"], ["divider", "Line"], ["space", "Space"], ["sign", "Signature line"]];
const FROM_PLAN = [["details", "Patient details"], ["treatments", "Treatments table"], ["concerns", "Concerns"],
  ["timeline", "Next 12 months"], ["message", "Your message"], ["title", "Title and date"]];
const MANY = ["text", "image", "divider", "space", "sign"];   // can be on the page more than once
const TAGS = ["{Patient name}", "{First name}", "{Last name}", "{Date of birth}", "{Patient ID}", "{Today}", "{My name}"];
const NOTE = {
  message: "Shows the personal note typed in Print or email. Nothing shows when there's no note.",
  concerns: "Lists each concern in the plan that has a description.",
  timeline: "The planned and booked treatments for the coming 12 months, and the patient's events.",
  divider: "A thin line across the page.",
  sign: "A line for the patient to sign and date on a printed copy.",
};

// d = the design (its blocks are changed in place). images = { fileId: src } shared with the preview.
// render() → the page's HTML with each block marked. onChange() saves. onClose() runs when the designer closes.
export function openPlanDesigner({ d, images, staff, render, onChange, onClose }) {
  let sel = "";
  let pageTimer = 0;
  const dlg = document.createElement("dialog");
  dlg.className = "pdz";
  dlg.setAttribute("aria-label", "Treatment plan page designer");
  dlg.innerHTML = `
    <div class="pdz-top">
      <div class="pdz-top-main"><strong>Treatment plan page</strong>
        <small>Used for every patient. Changes save by themselves.</small></div>
      <button type="button" class="lh-btn is-primary" data-pz="done">Done</button>
    </div>
    <div class="pdz-body">
      <aside class="pdz-pal" data-role="pal" aria-label="Add to the page"></aside>
      <div class="pdz-stage"><div class="pdz-page" data-role="page"></div></div>
      <aside class="pdz-insp" data-role="insp" aria-label="Settings"></aside>
    </div>`;
  const pal = dlg.querySelector('[data-role="pal"]');
  const page = dlg.querySelector('[data-role="page"]');
  const insp = dlg.querySelector('[data-role="insp"]');
  const cur = () => d.blocks.find((b) => b.id === sel) || null;
  const mk = (type, extra = {}) => ({ id: newId(), type, text: "", html: "", size: "m", bold: false, tint: false, align: "left", gap: "", ...extra });
  const legacy = (b) => (b.size === "l" || b.size === "xl" ? `<h2>${esc(b.text)}</h2>` : textToRichHtml(b.text || ""));

  /* ---------- Drawing ---------- */

  function drawPal() {
    const item = ([k, label]) => {
      const type = k === "heading" || k === "details" ? "text" : k;
      const used = !MANY.includes(type) && d.blocks.some((b) => b.type === type);
      return `<button type="button" class="pdz-add" data-add="${k}"${used ? ' disabled title="Already on the page"' : ""}>${esc(label)}${
        used ? "<small>on the page</small>" : ""}</button>`;
    };
    pal.innerHTML = `<p class="pdz-h">Add</p>
      <p class="pdz-sub">Page layout</p>${LAYOUT.map(item).join("")}
      <p class="pdz-sub">From the plan</p>${FROM_PLAN.map(item).join("")}
      <p class="pdz-hint">Click to add it under the selected block.</p>`;
  }

  function drawPage() {
    clearTimeout(pageTimer);
    const keep = page.parentElement.scrollTop;
    page.innerHTML = d.blocks.length ? render()
      : '<p class="pdz-empty">The page is empty. Click a block in Add to start.</p>';
    const el = sel ? page.querySelector(`[data-blk="${CSS.escape(sel)}"]`) : null;
    if (el) {
      const i = d.blocks.findIndex((b) => b.id === sel);
      const b = d.blocks[i];
      el.classList.add("is-sel");
      el.insertAdjacentHTML("beforeend", `<div class="pdz-tools">
        <button type="button" data-pz="up" aria-label="Move up" title="Move up"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" data-pz="down" aria-label="Move down" title="Move down"${i === d.blocks.length - 1 ? " disabled" : ""}>↓</button>
        ${MANY.includes(b.type) ? '<button type="button" data-pz="dup" aria-label="Duplicate" title="Duplicate">⧉</button>' : ""}
        <button type="button" data-pz="del" aria-label="Remove" title="Remove">×</button></div>`);
    }
    page.parentElement.scrollTop = keep;
  }
  const drawPageSoon = () => { clearTimeout(pageTimer); pageTimer = setTimeout(drawPage, 250); };

  const seg = (key, items, value) => `<div class="pdz-seg" data-seg="${key}">${items.map(([v, l]) =>
    `<button type="button" data-v="${esc(v)}"${String(value) === String(v) ? ' class="is-on"' : ""}>${esc(l)}</button>`).join("")}</div>`;
  const field = (label, body) => `<div class="pdz-f"><span class="lh-label">${esc(label)}</span>${body}</div>`;

  function drawInsp() {
    const b = cur();
    if (!b) {
      insp.innerHTML = '<p class="pdz-h">Settings</p><p class="pdz-hint">Click a block on the page to change it.</p>';
      return;
    }
    let h = `<p class="pdz-h">${esc(NAME[b.type] || "Block")}</p>`;
    if (b.type === "text") {
      h += field("Text", '<div data-role="rte"></div>')
        + field("Insert a tag", `<div class="pdz-tags">${TAGS.map((t) => `<button type="button" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div>`)
        + field("Align", seg("align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]], b.align || "left"));
    } else if (b.type === "title") {
      h += field("Title", `<input class="fe-input" data-in="title" maxlength="80" value="${esc(b.text || d.title || "")}" />`)
        + '<p class="pdz-hint">The patient\'s name and today\'s date show under it.</p>';
    } else if (b.type === "treatments") {
      h += field("Columns", `
        <label class="fe-check"><input type="checkbox" data-in="freq"${b.hideFreq ? "" : " checked"} /> Frequency</label>
        <label class="fe-check"><input type="checkbox" data-in="desc"${b.hideDesc ? "" : " checked"} /> Description</label>
        <label class="fe-check"><input type="checkbox" data-in="quote"${d.showPrices ? " checked" : ""} /> Quote</label>`)
        + '<p class="pdz-hint">The treatments are listed under Now, Next and Later, in the order on the plan.</p>';
    } else if (b.type === "image") {
      h += field("Picture", `${b.fileId ? `<p class="pdz-file">${esc(b.fileName || "Chosen picture")}</p>` : ""}
          <button type="button" class="lh-btn" data-pz="pick">${b.fileId ? "Change picture" : "Choose from Image Bank"}</button>`)
        + field("Width", seg("width", [[30, "Small"], [50, "Medium"], [75, "Large"], [100, "Full"]], b.width || 50))
        + field("Align", seg("align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]], b.align || "left"));
    } else if (b.type === "space") {
      h += field("Height", seg("size", [["s", "Small"], ["m", "Medium"], ["l", "Large"]], ["s", "l"].includes(b.size) ? b.size : "m"));
    } else {
      h += `<p class="pdz-hint">${esc(NOTE[b.type] || "")}</p>`;
    }
    if (b.type !== "space") h += field("Space below", seg("gap", [["", "Normal"], ["more", "More"]], b.gap || ""));
    insp.innerHTML = h;

    // The same editor as Form Builder's Text block
    const host = insp.querySelector('[data-role="rte"]');
    if (host) {
      const ed = createRichEditor(host, {
        button: false,
        onInput: () => {
          b.html = ed.getHtml();
          b.text = ed.text().trim().slice(0, 2000);
          onChange();
          drawPageSoon();
        },
      });
      ed.setHtml(b.html || legacy(b));
    }
  }

  const drawAll = () => { drawPal(); drawPage(); drawInsp(); };
  const changed = () => { onChange(); drawAll(); };

  /* ---------- Actions ---------- */

  function select(id) {
    if (id === sel) return;
    sel = id;
    drawPage();
    drawInsp();
  }

  async function pickImage(b) {
    const img = await openImagePicker({ isAdmin: /^admin$/i.test(String((staff && staff.role) || "")) });
    if (!img || !dlg.isConnected || !d.blocks.includes(b)) return;
    b.fileId = img.id;
    b.fileName = img.name || "";
    changed();
    try { images[img.id] = await bankImage(img.id); } catch (err) { console.warn("Picture not loaded:", err); }
    if (dlg.isConnected) drawPage();
  }

  function add(kind) {
    const made = kind === "heading" ? mk("text", { text: "Heading", html: "<h2>Heading</h2>" })
      : kind === "text" ? mk("text", { text: "New text", html: "<p>New text</p>" })
      : kind === "details" ? mk("text", { text: "Patient name: {Patient name} Date: {Today}",
          html: "<p><strong>Patient name:</strong> {Patient name}<br><strong>Date:</strong> {Today}</p>" })
      : kind === "title" ? mk("title", { text: d.title || "" })
      : kind === "image" ? mk("image", { width: 50, align: "center" })
      : mk(kind);
    if (!MANY.includes(made.type) && d.blocks.some((b) => b.type === made.type)) return;
    const at = d.blocks.findIndex((b) => b.id === sel);
    d.blocks.splice(at > -1 ? at + 1 : d.blocks.length, 0, made);
    sel = made.id;
    changed();
    const el = page.querySelector(`[data-blk="${CSS.escape(sel)}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    if (made.type === "image") pickImage(made);
    else if (made.type === "text") { const box = insp.querySelector("[contenteditable]"); if (box) box.focus(); }
  }

  function tool(act) {
    const i = d.blocks.findIndex((b) => b.id === sel);
    if (i < 0) return;
    if (act === "del") {
      d.blocks.splice(i, 1);
      sel = (d.blocks[i] || d.blocks[i - 1] || {}).id || "";
    } else if (act === "dup") {
      const copy = { ...d.blocks[i], id: newId() };
      d.blocks.splice(i + 1, 0, copy);
      sel = copy.id;
    } else {
      const j = i + (act === "up" ? -1 : 1);
      if (j < 0 || j >= d.blocks.length) return;
      [d.blocks[i], d.blocks[j]] = [d.blocks[j], d.blocks[i]];
    }
    changed();
  }

  /* ---------- Events ---------- */

  dlg.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest(".re")) return;   // the rich text editor's own buttons
    const a = t.closest("[data-add]");
    if (a) { if (!a.disabled) add(a.dataset.add); return; }
    const z = t.closest("[data-pz]");
    if (z) {
      if (z.disabled) return;
      if (z.dataset.pz === "done") dlg.close();
      else if (z.dataset.pz === "pick") { const b = cur(); if (b) pickImage(b); }
      else tool(z.dataset.pz);
      return;
    }
    const tag = t.closest("[data-tag]");
    if (tag) {
      const box = insp.querySelector("[contenteditable]");
      if (!box) return;
      box.focus();
      document.execCommand("insertText", false, tag.dataset.tag);   // the editor saves it like typing
      return;
    }
    const sg = t.closest("[data-seg] [data-v]");
    if (sg) {
      const b = cur();
      if (!b) return;
      const key = sg.parentElement.dataset.seg;
      b[key] = key === "width" ? Number(sg.dataset.v) : sg.dataset.v;
      onChange();
      drawPage();
      sg.parentElement.querySelectorAll("[data-v]").forEach((x) => x.classList.toggle("is-on", x === sg));
      return;
    }
    if (page.contains(t)) {
      if (t.closest("a")) e.preventDefault();   // links on the page don't open here
      const blk = t.closest("[data-blk]");
      select(blk ? blk.dataset.blk : "");
    }
  });
  // Clicking a tag mustn't move the cursor out of the text
  dlg.addEventListener("mousedown", (e) => { if (e.target.closest("[data-tag]")) e.preventDefault(); });

  insp.addEventListener("input", (e) => {
    const t = e.target;
    if (t.closest(".re") || !t.dataset.in) return;
    const b = cur();
    if (!b) return;
    if (t.dataset.in === "title") { b.text = t.value; d.title = t.value; }
    else if (t.dataset.in === "freq") b.hideFreq = !t.checked;
    else if (t.dataset.in === "desc") b.hideDesc = !t.checked;
    else if (t.dataset.in === "quote") d.showPrices = t.checked;
    onChange();
    drawPageSoon();
  });

  dlg.addEventListener("close", () => { clearTimeout(pageTimer); dlg.remove(); if (onClose) onClose(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  drawAll();
}