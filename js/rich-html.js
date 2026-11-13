// Email-safe HTML for task messages: what's allowed, and Image Bank pictures.
// Pictures are stored as <img data-bank="ID"> (no picture data in the saved task).
import { bankImage } from "./image-bank-api.js";

const ALLOWED = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "S", "H1", "H2", "H3", "UL", "OL", "LI",
  "A", "IMG", "HR", "DIV", "SPAN", "BLOCKQUOTE"]);
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "TITLE", "HEAD", "SVG", "FORM",
  "INPUT", "BUTTON", "TEXTAREA", "SELECT", "VIDEO", "AUDIO", "CANVAS", "TEMPLATE", "NOSCRIPT"]);
const STYLE_OK = new Set(["color", "background-color", "text-align", "font-size", "font-weight", "font-style",
  "text-decoration", "padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "margin",
  "margin-top", "margin-bottom", "margin-left", "margin-right", "border-radius", "display", "width", "max-width",
  "height", "line-height", "border", "border-top", "letter-spacing"]);
const DRIVE_ID = /^[A-Za-z0-9_-]{10,80}$/;
// Fonts every email app has. Any other font is left out (email apps would swap it for Arial or Times anyway).
export const RICH_FONTS = [
  ["Arial, Helvetica, sans-serif", "Arial"],
  ["Helvetica, Arial, sans-serif", "Helvetica"],
  ["Verdana, Geneva, sans-serif", "Verdana"],
  ["Tahoma, Geneva, sans-serif", "Tahoma"],
  ["'Trebuchet MS', Arial, sans-serif", "Trebuchet"],
  ["Georgia, 'Times New Roman', serif", "Georgia"],
  ["'Times New Roman', Times, serif", "Times New Roman"],
  ["'Courier New', Courier, monospace", "Courier New"],
];
const FONT_OK = Object.fromEntries(RICH_FONTS.map(([f]) => [f.split(",")[0].replace(/["']/g, "").trim().toLowerCase(), f]));
// The browser's size words → pixels (what older text and pasted text use)
const SIZE_PX = { "xx-small": "10px", "x-small": "12px", small: "13px", medium: "16px", large: "18px",
  "x-large": "24px", "xx-large": "32px", "xxx-large": "48px", "-webkit-xxx-large": "48px" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function cleanStyle(v) {
  return String(v || "").split(";").map((s) => {
    const i = s.indexOf(":");
    if (i < 1) return "";
    const k = s.slice(0, i).trim().toLowerCase();
    const val = s.slice(i + 1).trim();
    if (k === "font-family") {   // only email-safe fonts, always written the same way
      const first = val.split(",")[0].replace(/["']/g, "").trim().toLowerCase();
      return FONT_OK[first] ? `font-family:${FONT_OK[first]}` : "";
    }
    if (k === "font-size" && SIZE_PX[val.toLowerCase()]) return `font-size:${SIZE_PX[val.toLowerCase()]}`;
    if (!STYLE_OK.has(k) || !val || val.length > 80 || /url\(|expression|javascript|[<>]/i.test(val)) return "";
    return `${k}:${val}`;
  }).filter(Boolean).join(";");
}

function walk(node) {
  [...node.childNodes].forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) return;
    if (n.nodeType !== Node.ELEMENT_NODE) { n.remove(); return; }
    const tag = n.tagName.toUpperCase();
    if (DROP.has(tag)) { n.remove(); return; }
    walk(n);
    if (!ALLOWED.has(tag)) { n.replaceWith(...n.childNodes); return; } // keep the text, drop the tag
    if (tag === "IMG" && !(DRIVE_ID.test(n.getAttribute("data-bank") || "") || n.hasAttribute("data-logo"))) {
      n.remove(); // only Image Bank pictures and the logo
      return;
    }
    [...n.attributes].forEach((a) => {
      const name = a.name.toLowerCase();
      if (name === "style") {
        const s = cleanStyle(a.value);
        if (s) n.setAttribute("style", s); else n.removeAttribute("style");
        return;
      }
      const href = a.value.trim();
      const ok = (tag === "A" && name === "href" && (/^(https?:|mailto:|tel:)/i.test(href) || /^\{[^{}<>"]{1,80}\}/.test(href)))
        || (tag === "IMG" && ["data-bank", "data-logo", "alt", "width"].includes(name));
      if (!ok) n.removeAttribute(a.name);
    });
    if (tag === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener"); }
  });
}

export function cleanRichHtml(html) {
  const doc = new DOMParser().parseFromString(`<body><div>${String(html || "")}</div></body>`, "text/html");
  const box = doc.body.firstElementChild;
  if (!box) return "";
  walk(box);
  return box.innerHTML.trim();
}

// The earlier plain-text messages, as rich text
export function textToRichHtml(text) {
  const t = String(text || "").trim();
  if (!t) return "<p><br></p>";
  return t.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
}

export const richText = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// Shows Image Bank pictures (and the logo) inside an element
const ready = new Map();
const pending = new WeakSet();
export function hydrateRichImages(root, { logo = "" } = {}) {
  if (!root) return;
  root.querySelectorAll("img[data-bank]").forEach((img) => {
    const id = img.getAttribute("data-bank");
    if (ready.has(id)) { if (img.getAttribute("src") !== ready.get(id)) img.src = ready.get(id); return; }
    if (pending.has(img)) return;
    pending.add(img);
    bankImage(id)
      .then((src) => { ready.set(id, src); if (img.isConnected) img.src = src; })
      .catch(() => { if (img.isConnected) img.alt = "This picture is missing from the Image Bank"; });
  });
  root.querySelectorAll("img[data-logo]").forEach((img) => {
    if (logo) img.src = logo; else img.remove();
  });
}