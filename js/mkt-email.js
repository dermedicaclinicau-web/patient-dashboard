// Marketing emails: the content blocks, the email they make, and the starter designs.
// Built from tables and inline styles, so it looks the same in Gmail, Outlook and Apple Mail.
// The clinic's details and the Unsubscribe link go in <div data-mkt-footer> when it's sent.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Pictures and links: https only (links may also be mailto: or tel:)
export const safeUrl = (u) => {
  const s = String(u || "").trim();
  return /^(https:\/\/|mailto:|tel:)[^\s"'<>]+$/i.test(s) ? s : "";
};
export const uid = () => Math.random().toString(36).slice(2, 10);
const hex = (c, d) => (/^#[0-9a-f]{3,8}$/i.test(String(c || "")) ? String(c) : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

export const FONTS = [
  ["Arial, Helvetica, sans-serif", "Arial"],
  ["Helvetica, Arial, sans-serif", "Helvetica"],
  ["Georgia, 'Times New Roman', serif", "Georgia"],
  ["Verdana, Geneva, sans-serif", "Verdana"],
  ["'Trebuchet MS', Arial, sans-serif", "Trebuchet"],
];
export const DEFAULT_STYLE = { bg: "#f1f5f9", body: "#ffffff", text: "#1e293b", accent: "#0f766e", font: FONTS[0][0] };
export const MERGE_TAGS = [["{First name}", "The patient's first name"], ["{Full name}", "The patient's full name"]];

const col = () => ({ src: "", title: "A title", html: "<p>A few words about it.</p>", label: "", href: "" });
export const BLOCKS = {
  header: { label: "Logo header", make: () => ({ logo: "", logoWidth: 160, align: "center", bg: "", text: "DERMEDICA" }) },
  heading: { label: "Heading", make: () => ({ text: "A heading", size: "large", align: "left" }) },
  text: { label: "Text", make: () => ({ html: "<p>Write your message here.</p>", align: "left" }) },
  image: { label: "Image", make: () => ({ src: "", alt: "", href: "", width: 100, align: "center", edge: false }) },
  button: { label: "Button", make: () => ({ label: "Book now", href: "", bg: "", color: "#ffffff", align: "center", full: false }) },
  product: { label: "Product", make: () => ({ src: "", name: "Product name", price: "", desc: "A short line about the product.", href: "", label: "Shop now" }) },
  columns: { label: "Two columns", make: () => ({ items: [col(), col()] }) },
  divider: { label: "Divider", make: () => ({ color: "#e2e8f0" }) },
  spacer: { label: "Space", make: () => ({ size: 24 }) },
  social: { label: "Social links", make: () => ({ facebook: "", instagram: "", tiktok: "", website: "", align: "center" }) },
};
export const newBlock = (type) => ({ id: uid(), type, ...BLOCKS[type].make() });

export function styleOf(d) {
  const s = (d && d.style) || {};
  return {
    bg: hex(s.bg, DEFAULT_STYLE.bg), body: hex(s.body, DEFAULT_STYLE.body), text: hex(s.text, DEFAULT_STYLE.text),
    accent: hex(s.accent, DEFAULT_STYLE.accent), font: FONTS.some(([f]) => f === s.font) ? s.font : DEFAULT_STYLE.font,
  };
}
// A saved design, with every block complete (older or partial blocks get their defaults)
export function cleanDesign(d) {
  const blocks = (d && Array.isArray(d.blocks) ? d.blocks : [])
    .filter((b) => b && BLOCKS[b.type])
    .map((b) => ({ ...BLOCKS[b.type].make(), ...b, id: String(b.id || uid()) }));
  blocks.forEach((b) => {
    if (b.type === "columns") b.items = [0, 1].map((i) => ({ ...col(), ...((Array.isArray(b.items) && b.items[i]) || {}) }));
  });
  return { style: styleOf(d), blocks };
}

/* ---------- Text from the editor: only simple formatting is kept ---------- */
const RICH_OK = { P: 1, BR: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1, A: 1, UL: 1, OL: 1, LI: 1 };
export function cleanRich(html) {
  const doc = new DOMParser().parseFromString(`<div>${String(html || "")}</div>`, "text/html");
  const root = doc.body.firstChild;
  const walk = (node) => {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === 3) return;
      if (n.nodeType !== 1) { n.remove(); return; }
      walk(n);
      const tag = n.tagName;
      if (tag === "DIV") { const p = doc.createElement("p"); p.append(...n.childNodes); n.replaceWith(p); return; }
      if (!RICH_OK[tag]) { n.replaceWith(...n.childNodes); return; }
      const href = tag === "A" ? safeUrl(n.getAttribute("href")) : "";
      [...n.attributes].forEach((a) => n.removeAttribute(a.name));
      if (tag === "A") { if (href) n.setAttribute("href", href); else n.replaceWith(...n.childNodes); }
    });
  };
  walk(root);
  return root.innerHTML.trim();
}
const styleRich = (html, st) => String(html || "")
  .replace(/<p>/g, '<p style="margin:0 0 14px;">')
  .replace(/<ul>/g, '<ul style="margin:0 0 14px;padding-left:22px;">')
  .replace(/<ol>/g, '<ol style="margin:0 0 14px;padding-left:22px;">')
  .replace(/<li>/g, '<li style="margin:0 0 6px;">')
  .replace(/<a href=/g, `<a style="color:${st.accent};text-decoration:underline;" href=`);

/* ---------- Blocks → email HTML ---------- */
const IN = 536; // 600px email, 32px each side
const box = (style, inner) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="${style}">${inner}</td></tr></table>`;
const font = (st, size = 16) => `font-family:${st.font};font-size:${size}px;line-height:1.6;color:${st.text};`;
const mg = (a) => (a === "center" ? "0 auto" : a === "right" ? "0 0 0 auto" : "0");
const btn = (label, href, bg, fg, st, full = false) =>
  `<a href="${esc(safeUrl(href) || "#")}" style="display:${full ? "block" : "inline-block"};padding:13px 28px;border-radius:8px;background:${bg};color:${fg};font-family:${st.font};font-size:15px;font-weight:bold;line-height:1.2;text-align:center;text-decoration:none;">${esc(label)}</a>`;
const img = (src, alt, w, href, extra = "") => {
  const tag = `<img src="${esc(safeUrl(src))}" alt="${esc(alt)}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;${extra}">`;
  const h = safeUrl(href);
  return h ? `<a href="${esc(h)}" style="text-decoration:none;">${tag}</a>` : tag;
};
const ph = (w, h, extra = "") => `<div style="width:100%;max-width:${w}px;height:${h}px;line-height:${h}px;background:#e2e8f0;color:#64748b;border-radius:8px;font-family:Arial,sans-serif;font-size:13px;text-align:center;${extra}">Add a picture</div>`;

export function blockHtml(b, st, preview = false) {
  const a = oneOf(b.align, ["left", "center", "right"], "left");
  switch (b.type) {
    case "header": {
      const inner = safeUrl(b.logo)
        ? img(b.logo, "Dermedica", Math.min(400, Math.max(60, Number(b.logoWidth) || 160)), "", `margin:${mg(a)};`)
        : `<div style="font-family:${st.font};font-size:20px;font-weight:bold;letter-spacing:3px;color:${st.accent};">${esc(b.text || "DERMEDICA")}</div>`;
      return box(`padding:26px 32px;text-align:${a};background:${hex(b.bg, st.body)};`, inner);
    }
    case "heading": {
      const size = { large: 28, medium: 22, small: 18 }[b.size] || 28;
      return box(`padding:20px 32px 6px;text-align:${a};`,
        `<h1 style="margin:0;font-family:${st.font};font-size:${size}px;line-height:1.25;font-weight:bold;color:${st.text};">${esc(b.text).replace(/\n/g, "<br>")}</h1>`);
    }
    case "text":
      return box(`padding:10px 32px 2px;text-align:${a};${font(st)}`, styleRich(cleanRich(b.html), st));
    case "image": {
      const w = b.edge ? 600 : Math.round(IN * Math.min(100, Math.max(20, Number(b.width) || 100)) / 100);
      const pic = safeUrl(b.src) ? img(b.src, b.alt, w, b.href, b.edge ? "" : `margin:${mg(a)};border-radius:8px;`)
        : preview ? ph(w, 200, `margin:${mg(a)};`) : "";
      return pic ? box(b.edge ? "padding:0;" : "padding:12px 32px;", pic) : "";
    }
    case "button":
      return box(`padding:14px 32px;text-align:${a};`, btn(b.label || "Button", b.href, hex(b.bg, st.accent), hex(b.color, "#ffffff"), st, b.full === true));
    case "product": {
      const pic = safeUrl(b.src) ? img(b.src, b.name, 200, b.href, "border-radius:8px;") : preview ? ph(200, 200) : "";
      const text = `<div style="${font(st, 15)}">` +
        `<div style="font-size:18px;font-weight:bold;margin:0 0 4px;">${esc(b.name)}</div>` +
        (b.price ? `<div style="font-weight:bold;color:${st.accent};margin:0 0 8px;">${esc(b.price)}</div>` : "") +
        (b.desc ? `<div style="margin:0 0 14px;">${esc(b.desc).replace(/\n/g, "<br>")}</div>` : "") +
        (b.label ? btn(b.label, b.href, st.accent, "#ffffff", st) : "") + "</div>";
      if (!pic) return box("padding:16px 32px;", text);
      return box("padding:16px 32px;font-size:0;",
        `<div style="display:inline-block;width:100%;max-width:200px;vertical-align:top;">${pic}</div>` +
        `<div style="display:inline-block;width:100%;max-width:316px;vertical-align:top;"><div style="padding:6px 0 0 20px;">${text}</div></div>`);
    }
    case "columns": {
      const cell = (c) => `<div style="display:inline-block;width:100%;max-width:268px;vertical-align:top;"><div style="padding:0 8px 16px;">` +
        (safeUrl(c.src) ? img(c.src, c.title, 252, c.href, "margin:0 0 12px;border-radius:8px;") : preview ? ph(252, 150, "margin:0 0 12px;") : "") +
        `<div style="${font(st, 15)}">` +
        (c.title ? `<div style="font-size:17px;font-weight:bold;margin:0 0 6px;">${esc(c.title)}</div>` : "") +
        styleRich(cleanRich(c.html), st) + (c.label ? btn(c.label, c.href, st.accent, "#ffffff", st) : "") + "</div></div></div>";
      return box("padding:16px 24px 0;font-size:0;", (b.items || []).slice(0, 2).map(cell).join(""));
    }
    case "divider":
      return box("padding:10px 32px;", `<div style="height:1px;line-height:1px;font-size:1px;background:${hex(b.color, "#e2e8f0")};">&nbsp;</div>`);
    case "spacer": {
      const h = Math.min(120, Math.max(4, Number(b.size) || 24));
      return box("padding:0;", `<div style="height:${h}px;line-height:${h}px;font-size:1px;">&nbsp;</div>`);
    }
    case "social": {
      const links = [["facebook", "Facebook"], ["instagram", "Instagram"], ["tiktok", "TikTok"], ["website", "Website"]]
        .filter(([k]) => safeUrl(b[k]));
      if (!links.length) {
        return preview ? box("padding:12px 32px;text-align:center;", `<span style="${font(st, 13)}color:#94a3b8;">Add your social links</span>`) : "";
      }
      return box(`padding:12px 32px;text-align:${a};`, links.map(([k, l]) =>
        `<a href="${esc(safeUrl(b[k]))}" style="display:inline-block;margin:0 4px 6px;padding:7px 14px;border:1px solid ${st.accent};border-radius:999px;color:${st.accent};font-family:${st.font};font-size:13px;font-weight:bold;text-decoration:none;">${l}</a>`).join(""));
    }
  }
  return "";
}

// What the footer looks like (the real one, with a working link, is added when the email is sent)
export const footerPreview = () => `<div style="padding:0 32px 24px;"><div style="margin:24px 0 0;padding:14px 0 0;border-top:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#94a3b8;text-align:center;">Sent by Dermedica. You're receiving this because you're a Dermedica patient.<br><span style="color:#64748b;text-decoration:underline;">Unsubscribe</span> from news and offers. You'll still get emails about your appointments.</div></div>`;

// The finished email (saved with the template, and what campaigns send)
export function renderEmail(t) {
  const st = styleOf(t.design);
  const blocks = ((t.design && t.design.blocks) || []).map((b) => blockHtml(b, st)).join("");
  const pre = String(t.preview || "").trim();
  return `<div style="margin:0;padding:24px 10px;background:${st.bg};">` +
    (pre ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${st.bg};">${esc(pre)}</div>` : "") +
    `<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;background:${st.body};border-collapse:separate;border-radius:12px;overflow:hidden;">` +
    `<tr><td style="padding:0;">${blocks}</td></tr>` +
    `<tr><td style="padding:0 32px 24px;"><div data-mkt-footer=""></div></td></tr></table></div>`;
}

// Things to fix before sending ([] when it's ready)
export function checkDesign(t) {
  const out = [];
  if (!String(t.subject || "").trim()) out.push("Add a subject line.");
  const blocks = (t.design && t.design.blocks) || [];
  if (!blocks.length) out.push("The email is empty. Add a block.");
  blocks.forEach((b) => {
    if (b.type === "button" && !safeUrl(b.href)) out.push(`The "${b.label || "Button"}" button has no link yet.`);
    if (b.type === "image" && !safeUrl(b.src)) out.push("An image block has no picture yet.");
    if (b.type === "product" && b.label && !safeUrl(b.href)) out.push(`The product "${b.name}" has no link yet.`);
    if (b.type === "columns") (b.items || []).forEach((c) => { if (c.label && !safeUrl(c.href)) out.push(`The "${c.label}" button in two columns has no link yet.`); });
    if (b.type === "text" && /\[[^\]]+\]/.test(b.html || "")) out.push("Some text still has [square-bracket] placeholders to fill in.");
  });
  return [...new Set(out)];
}

/* ---------- Starter designs ---------- */
const h = (type, over = {}) => ({ ...newBlock(type), ...over });
export const STARTERS = [
  { key: "blank", name: "Blank", blurb: "A logo and an empty message", subject: "", preview: "",
    design: () => ({ style: { ...DEFAULT_STYLE }, blocks: [h("header"), h("text", { html: "<p>Hi {First name},</p><p>Write your message here.</p>" })] }) },
  { key: "newsletter", name: "Newsletter", blurb: "News, two stories and a booking button",
    subject: "What's new at Dermedica", preview: "News, tips and something new for your skin",
    design: () => ({ style: { ...DEFAULT_STYLE }, blocks: [
      h("header"), h("image", { edge: true }),
      h("heading", { text: "What's new at Dermedica" }),
      h("text", { html: "<p>Hi {First name},</p><p>Here's what's been happening at the clinic, and a few things we think you'll love.</p>" }),
      h("columns", { items: [
        { src: "", title: "New treatment", html: "<p>Tell patients about something new.</p>", label: "Find out more", href: "" },
        { src: "", title: "Skin tip", html: "<p>A quick tip for this time of year.</p>", label: "Read more", href: "" },
      ] }),
      h("button", { label: "Book your next visit" }), h("divider"), h("social"),
    ] }) },
  { key: "offer", name: "Special offer", blurb: "One offer, one big button",
    subject: "{First name}, an offer just for you", preview: "For a limited time only",
    design: () => ({ style: { ...DEFAULT_STYLE }, blocks: [
      h("header"), h("image", { edge: true }),
      h("heading", { text: "An offer just for you", align: "center" }),
      h("text", { align: "center", html: "<p>Hi {First name},</p><p>For a limited time, enjoy [your offer]. Places are limited, so book soon.</p>" }),
      h("button", { label: "Claim your offer", align: "center" }),
      h("text", { align: "center", html: "<p><em>Offer ends [date]. Terms and conditions apply.</em></p>" }), h("social"),
    ] }) },
  { key: "treatment", name: "New treatment", blurb: "Introduce a treatment or product",
    subject: "Introducing [treatment name]", preview: "Something new at Dermedica",
    design: () => ({ style: { ...DEFAULT_STYLE }, blocks: [
      h("header"), h("heading", { text: "Introducing [treatment name]" }), h("image"),
      h("text", { html: "<p>Hi {First name},</p><p>[What it is, who it's for and what results to expect.]</p><ul><li>[A benefit]</li><li>[Another benefit]</li></ul>" }),
      h("button", { label: "Book a consultation" }), h("divider"), h("product"), h("social"),
    ] }) },
];