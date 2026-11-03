// SEO → Website → blog posts: write one (or start from an Advisor draft), add the SEO details, check spelling and the
// advertising rules, then save it as a draft, mark it ready for review, publish it or schedule it.
// Saved through Apps Script (action "wordpress") as WordPress blocks (paragraphs, headings, lists, images, quotes, dividers),
// so it can still be edited in WordPress. Posts built with Elementor or using other blocks (columns, embeds…) keep their
// words locked here: edit those in WordPress. Everything else can still be changed.
import { callApi } from "./appointments.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SITE = "Dermedica";
const LIM = { title: [30, 60], desc: [120, 160] };
const STATUS = { publish: "Published", draft: "Draft", pending: "Ready for review", private: "Private", future: "Scheduled" };
const LIVE = ["publish", "future", "private"];
const DRAFT_KEY = "dm.seo.postdraft";
const ISSUE = { spelling: "Spelling", grammar: "Grammar", advertising: "Advertising rules", claim: "Needs evidence", clarity: "Hard to read" };
const TOOLS = [["p", "¶", "Paragraph"], ["h2", "H2", "Heading"], ["h3", "H3", "Subheading"], ["|"], ["bold", "<b>B</b>", "Bold"],
  ["italic", "<i>I</i>", "Italic"], ["link", "Link", "Link the selected words"], ["|"], ["ul", "• List", "Bullet list"],
  ["ol", "1. List", "Numbered list"], ["quote", "“ Quote", "Quote"], ["hr", "―", "Divider"], ["image", "Image", "Add an image"],
  ["|"], ["undo", "↶", "Undo"], ["redo", "↷", "Redo"]];

async function api(op, data = {}) {
  const r = await callApi({ action: "wordpress", op, ...data });
  if (r && r.problem) throw new Error(r.problem);
  return r;
}
const errText = (err) => (err && err.code === "FORBIDDEN"
  ? "You don't have access to do that. Ask an Admin for Website access in Staff → Roles and access."
  : (err && err.message) || "Something went wrong. Try again.");

/** For the Advisor: keep a draft, then open #/seo/website/new to start a post from it.
 *  d: { title, html or text, seoTitle, desc, focus, excerpt, note } */
export function stashPostDraft(d) { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d || {})); } catch { /* private mode */ } }
export function takePostDraft() {
  try { const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); sessionStorage.removeItem(DRAFT_KEY); return d; }
  catch { return null; }
}

let termsP = null;
const loadTerms = () => (termsP ||= api("terms").then((r) => r.categories || []).catch(() => { termsP = null; return []; }));
let staffP = null;
const loadStaff = () => (staffP ||= callApi({ action: "staffList" }).then((r) => (r && r.staff) || []).catch(() => { staffP = null; return []; }));
let infoP = null;
const loadInfo = () => (infoP ||= api("info").catch(() => { infoP = null; return {}; }));

/* ---------- Small helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const perth = (ms) => new Date(ms + 8 * 3600e3);   // read with getUTC…
const tomorrow9 = () => { const d = perth(Date.now() + 864e5); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T09:00`; };
const nowInput = () => { const d = perth(Date.now() + 10 * 60e3); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const niceWhen = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).toLocaleString("en-AU",
    { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
};
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const countClass = (n, [lo, hi]) => `ws-count is-${n > hi ? "warn" : n < lo ? "info" : "good"}`;
const textToHtml = (t) => String(t || "").split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)
  .map((x) => (/^#{2,3}\s/.test(x) ? `<h${x.startsWith("###") ? 3 : 2}>${esc(x.replace(/^#+\s*/, ""))}</h${x.startsWith("###") ? 3 : 2}>`
    : `<p>${esc(x).replace(/\n/g, "<br>")}</p>`)).join("");

// A smaller copy of a photo (longest side 1600 px) as base64, so it uploads and loads quickly
async function shrink(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    const png = file.type === "image/png" && file.size < 1500000;
    const data = cv.toDataURL(png ? "image/png" : "image/jpeg", 0.86);
    return { data: data.split(",")[1], name: `${String(file.name || "image").replace(/\.[^.]+$/, "")}.${png ? "png" : "jpg"}` };
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- The words: tidy HTML in, WordPress blocks out ---------- */

const BLOCKS = new Set(["P", "H2", "H3", "H4", "UL", "OL", "BLOCKQUOTE", "FIGURE", "HR"]);
const INLINE = new Set(["STRONG", "EM", "A", "BR", "IMG", "LI", "FIGCAPTION"]);

// Pasted or saved HTML → only the tags the editor and WordPress blocks use
function cleanHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const walk = (node) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 8) { n.remove(); continue; }
      if (n.nodeType !== 1) continue;
      let el = n;
      if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|FORM|INPUT|BUTTON|SELECT|TEXTAREA|NOSCRIPT|SVG|META|LINK|TITLE)$/.test(el.tagName)) { el.remove(); continue; }
      const swap = (t) => { const x = document.createElement(t); while (el.firstChild) x.appendChild(el.firstChild); el.replaceWith(x); el = x; };
      if (el.tagName === "B") swap("strong");
      else if (el.tagName === "I") swap("em");
      else if (el.tagName === "H1") swap("h2");
      else if (/^H[56]$/.test(el.tagName)) swap("h4");
      if (!BLOCKS.has(el.tagName) && !INLINE.has(el.tagName)) {   // div, span, section…: keep what's inside
        walk(el);
        el.replaceWith(...el.childNodes);
        continue;
      }
      if (el.tagName === "IMG") {
        const m = /wp-image-(\d+)/.exec(el.getAttribute("class") || "");
        if (m && !el.dataset.id) el.setAttribute("data-id", m[1]);
      }
      for (const a of [...el.attributes]) {
        const keep = (el.tagName === "A" && ["href", "target", "rel"].includes(a.name))
          || (el.tagName === "IMG" && ["src", "alt", "data-id"].includes(a.name));
        if (!keep) el.removeAttribute(a.name);
      }
      if (el.tagName === "A" && !/^(https?:|mailto:|tel:|\/|#)/i.test(el.getAttribute("href") || "")) el.removeAttribute("href");
      if (el.tagName === "IMG" && !/^https:\/\//i.test(el.getAttribute("src") || "")) { el.remove(); continue; }
      walk(el);
    }
  };
  walk(tpl.content);
  // Loose words and inline tags at the top become paragraphs; loose images get their own figure
  const out = document.createElement("div");
  let p = null;
  for (const n of [...tpl.content.childNodes]) {
    if (n.nodeType === 1 && BLOCKS.has(n.tagName)) { p = null; out.appendChild(n); continue; }
    if (n.nodeType === 1 && n.tagName === "IMG") { p = null; const f = document.createElement("figure"); f.appendChild(n); out.appendChild(f); continue; }
    if (n.nodeType === 3 && !n.textContent.trim()) { if (p) p.appendChild(n); continue; }
    if (n.nodeType === 1 && n.tagName === "BR" && !p) continue;
    if (!p) { p = document.createElement("p"); out.appendChild(p); }
    p.appendChild(n.nodeType === 1 && ["LI", "FIGCAPTION"].includes(n.tagName) ? document.createTextNode(n.textContent) : n);
  }
  out.querySelectorAll("p img").forEach((img) => {
    const p0 = img.closest("p");
    const f = document.createElement("figure");
    f.appendChild(img);
    p0.after(f);
    if (!p0.textContent.trim() && !p0.querySelector("img")) p0.remove();
  });
  return out.innerHTML;
}

// Blocks the editor can rebuild exactly. Anything else (columns, embeds…) locks the words.
const SAFE_BLOCKS = new Set(["paragraph", "heading", "list", "list-item", "image", "quote", "separator", "freeform"]);
function unsafeBlocks(content) {
  const names = [...String(content || "").matchAll(/<!--\s*wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)/g)].map((m) => m[1].replace(/^core\//, ""));
  return [...new Set(names.filter((n) => !SAFE_BLOCKS.has(n)))];
}

const blk = (name, html, attrs) => `<!-- wp:${name}${attrs ? ` ${JSON.stringify(attrs)}` : ""} -->\n${html}\n<!-- /wp:${name} -->`;
// The editor's words → WordPress block markup
function toBlocks(root) {
  const out = [];
  for (const n of root.childNodes) {
    if (n.nodeType === 3) { if (n.textContent.trim()) out.push(blk("paragraph", `<p>${esc(n.textContent.trim())}</p>`)); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (tag === "P" || tag === "DIV") {
      if (n.querySelector("img")) { n.querySelectorAll("img").forEach((img) => out.push(imageBlock(img, null))); continue; }
      if (!n.textContent.trim()) continue;
      out.push(blk("paragraph", `<p>${n.innerHTML}</p>`));
    } else if (/^H[1-6]$/.test(tag)) {
      if (!n.textContent.trim()) continue;
      const lv = Math.min(4, Math.max(2, Number(tag[1])));
      out.push(blk("heading", `<h${lv} class="wp-block-heading">${n.innerHTML}</h${lv}>`, lv === 2 ? null : { level: lv }));
    } else if (tag === "UL" || tag === "OL") {
      const items = [...n.children].filter((li) => li.tagName === "LI" && li.textContent.trim())
        .map((li) => blk("list-item", `<li>${li.innerHTML}</li>`)).join("\n");
      if (!items) continue;
      const t = tag.toLowerCase();
      out.push(blk("list", `<${t} class="wp-block-list">${items}</${t}>`, tag === "OL" ? { ordered: true } : null));
    } else if (tag === "BLOCKQUOTE") {
      const ps = [...n.querySelectorAll("p")].filter((p) => p.textContent.trim());
      const inner = (ps.length ? ps.map((p) => p.innerHTML) : [n.innerHTML]).map((h) => blk("paragraph", `<p>${h}</p>`)).join("\n");
      out.push(blk("quote", `<blockquote class="wp-block-quote">${inner}</blockquote>`));
    } else if (tag === "FIGURE" || tag === "IMG") {
      const img = tag === "IMG" ? n : n.querySelector("img");
      if (img) out.push(imageBlock(img, tag === "FIGURE" ? n.querySelector("figcaption") : null));
    } else if (tag === "HR") {
      out.push(blk("separator", '<hr class="wp-block-separator has-alpha-channel-opacity"/>'));
    } else if (n.textContent.trim()) {
      out.push(blk("paragraph", `<p>${n.innerHTML}</p>`));
    }
  }
  return out.join("\n\n");
}
function imageBlock(img, cap) {
  const id = Number(img.dataset.id) || 0;
  const attrs = id ? { id, sizeSlug: "large", linkDestination: "none" } : { sizeSlug: "large", linkDestination: "none" };
  const capHtml = cap && cap.textContent.trim() ? `<figcaption class="wp-element-caption">${cap.innerHTML}</figcaption>` : "";
  return blk("image", `<figure class="wp-block-image size-large"><img src="${esc(img.getAttribute("src"))}" alt="${esc(img.getAttribute("alt") || "")}"${
    id ? ` class="wp-image-${id}"` : ""}/>${capHtml}</figure>`, attrs);
}

/* ===================== The editor ===================== */
// opts: { id } an existing post · { draft } a new post from the Advisor · onSaved(item) after each save

export async function openPostEditor(opts = {}) {
  const pub = can("seo.publish");
  const ov = document.createElement("div");
  ov.className = "ws-pe";
  ov.innerHTML = '<div class="ws-pe-bar"><button type="button" class="lh-btn is-quiet" data-a="close">← Website</button></div><div class="ws-pe-load">Opening…</div>';
  document.body.appendChild(ov);
  document.body.classList.add("ws-pe-open");
  const shut = () => { ov.remove(); document.body.classList.remove("ws-pe-open"); };
  ov.querySelector('[data-a="close"]').addEventListener("click", shut);

  let item = null;
  let cats = [], people = [], info = {};
  try {
    [item, cats, people, info] = await Promise.all([
      opts.id ? api("get", { id: opts.id }).then((r) => r.item) : null, loadTerms(), loadStaff(), loadInfo()]);
  } catch (err) {
    ov.querySelector(".ws-pe-load").innerHTML = `<div class="state"><strong>Couldn't open the post</strong>${esc(errText(err))}</div>`;
    return;
  }
  if (!ov.isConnected) return;

  const dr = !item && opts.draft ? opts.draft : null;
  const s0 = item ? (item.seo && (item.seo.aioseo || item.seo.yoast)) || {} : {};
  const unsafe = item ? unsafeBlocks(item.content || "") : [];
  const st = {
    id: item ? item.id : 0, status: item ? item.status : "draft", date: item ? item.date : "",
    link: item ? item.link : "", path: item ? item.path : "", editUrl: item ? item.editUrl : "",
    featured: item ? item.featuredId || 0 : 0, featuredUrl: item ? item.featured || "" : "",
    cats: item ? (item.categories || []).map(Number) : [],
    sched: item ? item.status === "future" : false, when: item && item.status === "future" ? String(item.date || "").slice(0, 16).replace(" ", "T") : tomorrow9(),
    revOk: false, revBy: "", busy: false,
  };
  const isLive = () => LIVE.includes(st.status);
  const lockReason = () => (item && item.elementor ? "This post is built with Elementor, so its words are edited in Elementor."
    : unsafe.length ? `This post uses WordPress blocks the portal can't safely rebuild (${unsafe.slice(0, 4).join(", ")}). Edit its words in WordPress.`
    : isLive() && !pub ? "It's live, so changing the words needs \"Website: publish and remove\". Everything on the right can still be changed." : "");
  // Clinicians first in the sign-off list
  const clin = people.filter((p) => p.ahpraNo || p.injector || /clinician|doctor|nurse/i.test(p.role || ""));
  const others = people.filter((p) => !clin.includes(p));

  ov.innerHTML = `
    <div class="ws-pe-bar">
      <button type="button" class="lh-btn is-quiet" data-a="close">← Website</button>
      <span data-p="status"></span><span class="ws-pe-saved" data-p="saved"></span>
      <span class="inv-spacer"></span>
      <a class="lh-btn is-quiet" data-p="view" target="_blank" rel="noopener" hidden>View ↗</a>
      <span class="ws-pe-acts" data-p="acts"></span>
    </div>
    <div class="ws-pe-grid">
      <main class="ws-pe-main">
        ${dr && dr.note ? `<div class="ws-pe-banner">${esc(dr.note)}</div>` : ""}
        <input class="ws-pe-title" name="title" placeholder="Post title" maxlength="200" value="${esc(item ? item.title : (dr && dr.title) || "")}" />
        <div class="ws-pe-banner" data-p="lock" hidden></div>
        <div class="ws-pe-tools" data-p="tools">${TOOLS.map(([k, l, t]) => (k === "|" ? "<i></i>"
          : `<button type="button" data-cmd="${k}" title="${esc(t)}" aria-label="${esc(t)}">${l}</button>`)).join("")}</div>
        <div class="ws-pe-body" data-p="body" data-ph="Start writing…"></div>
        <input type="file" accept="image/*" data-p="file" hidden />
      </main>
      <aside class="ws-pe-side">
        <section class="ws-pe-sec"><h4>Publish</h4><div data-p="pub"></div></section>
        <section class="ws-pe-sec"><h4>Checks <button type="button" class="lh-btn" data-a="check">Check spelling and rules</button></h4>
          <ul class="ws-pe-checks" data-p="checks"></ul><div data-p="proof"></div></section>
        <section class="ws-pe-sec"><h4>Google <button type="button" class="lh-btn" data-a="suggest">✨ Write suggestions</button></h4>
          <div class="ws-prev"><span class="ws-prev-url" data-p="purl"></span><span class="ws-prev-t" data-p="pt"></span><span class="ws-prev-d" data-p="pd"></span></div>
          <label class="lh-field"><span class="lh-label">SEO title <em data-c="t"></em></span>
            <input name="seoTitle" class="fe-input" maxlength="200" value="${esc(s0.title || (dr && dr.seoTitle) || "")}" /></label>
          <div class="ws-sug" data-sug="title"></div>
          <label class="lh-field"><span class="lh-label">Description <em data-c="d"></em></span>
            <textarea name="desc" class="fe-input" rows="3" maxlength="320">${esc(s0.description || (dr && dr.desc) || "")}</textarea></label>
          <div class="ws-sug" data-sug="desc"></div>
          <label class="lh-field"><span class="lh-label">Focus keyphrase</span>
            <input name="focus" class="fe-input" maxlength="120" value="${esc(s0.focus || (dr && dr.focus) || "")}" placeholder="e.g. melasma treatment perth" /></label>
          <div class="ws-sch" data-p="sch"></div>
        </section>
        <section class="ws-pe-sec"><h4>Category and tags</h4>
          <div class="ws-pe-cats">${cats.map((x) => `<label class="fe-check"><input type="checkbox" name="cat" value="${x.id}"${
            st.cats.includes(Number(x.id)) ? " checked" : ""} /> ${esc(x.name)}</label>`).join("") || '<span class="muted">No categories found.</span>'}</div>
          <input name="tags" class="fe-input" placeholder="Tags, separated by commas" value="${esc(item && item.tags ? item.tags.join(", ") : "")}" />
        </section>
        <section class="ws-pe-sec"><h4>Featured image</h4><div class="ws-pe-feat" data-p="feat"></div></section>
        <section class="ws-pe-sec"><h4>Summary</h4>
          <textarea name="excerpt" class="fe-input" rows="3" maxlength="600" placeholder="A sentence or two shown on the blog page (optional)">${esc(item ? item.excerpt || "" : (dr && dr.excerpt) || "")}</textarea></section>
        <section class="ws-pe-sec"><h4>Address</h4>
          <div class="ws-slug"><span>/</span><input name="slug" class="fe-input" maxlength="190" value="${esc(item && !/\?/.test(item.path || "") ? item.slug : "")}"
            placeholder="made from the title when it's published" /><span>/</span></div>
          <p class="ws-pe-note" data-p="slugnote"></p></section>
      </aside>
    </div>`;

  const $ = (k) => ov.querySelector(`[data-p="${k}"]`);
  const F = (n) => ov.querySelector(`[name="${n}"]`);
  const body = $("body");
  body.innerHTML = cleanHtml(item ? item.content || "" : dr ? dr.html || textToHtml(dr.text) : "");
  let locked = false;
  const applyLock = () => {
    const why = lockReason();
    locked = !!why;
    body.contentEditable = locked ? "false" : "true";
    $("tools").hidden = locked;
    $("lock").hidden = !locked;
    $("lock").innerHTML = locked ? `${esc(why)}${st.editUrl ? ` <a href="${esc(st.editUrl)}" target="_blank" rel="noopener">Edit in WordPress ↗</a>` : ""}` : "";
  };
  applyLock();
  document.execCommand("defaultParagraphSeparator", false, "p");

  /* ----- what's on screen now, and what was last saved ----- */
  const val = () => ({
    title: F("title").value.replace(/\s+/g, " ").trim(),
    seoTitle: F("seoTitle").value.replace(/\s+/g, " ").trim(),
    desc: F("desc").value.replace(/\s+/g, " ").trim(),
    focus: F("focus").value.replace(/\s+/g, " ").trim(),
    excerpt: F("excerpt").value.replace(/\s+/g, " ").trim(),
  });
  const snap = () => {
    const v = val();
    return {
      ...v, content: locked ? null : toBlocks(body),
      cats: [...ov.querySelectorAll('[name="cat"]:checked')].map((x) => Number(x.value)).sort((a, b) => a - b).join(","),
      tags: F("tags").value.split(",").map((t) => t.trim()).filter(Boolean).join(","),
      featured: st.featured, slug: slugify(F("slug").value),
    };
  };
  // A new post from the Advisor counts as changed until it's saved
  let base = dr ? { ...snap(), title: "", content: "" } : snap();
  const dirty = () => JSON.stringify(snap()) !== JSON.stringify(base);

  function fieldsToSave(cur) {
    const f = {}, seo = {};
    if (cur.title !== base.title) f.title = cur.title || "Untitled post";
    if (!locked && cur.content !== base.content) f.content = cur.content;
    if (cur.excerpt !== base.excerpt) f.excerpt = cur.excerpt;
    if (cur.seoTitle !== base.seoTitle) seo.title = cur.seoTitle;
    if (cur.desc !== base.desc) seo.description = cur.desc;
    if (cur.focus !== base.focus) seo.focus = cur.focus;
    if (Object.keys(seo).length) f.seo = seo;
    if (cur.cats !== base.cats) f.categories = cur.cats ? cur.cats.split(",").map(Number) : [];
    if (cur.tags !== base.tags) f.tags = cur.tags ? cur.tags.split(",") : [];
    if (cur.featured !== base.featured) f.featured = cur.featured;
    if (cur.slug && cur.slug !== base.slug) f.slug = cur.slug;
    return f;
  }

  /* ----- saving ----- */
  async function save(extra = {}, msg = "Saved") {
    if (st.busy) return false;
    const cur = snap();
    const f = { ...fieldsToSave(cur), ...extra };
    st.busy = true;
    drawTop("Saving…");
    try {
      if (!st.id) {   // the first save makes the draft in WordPress
        const r = await api("create", { fields: { title: cur.title || "Untitled post", content: cur.content || "", excerpt: cur.excerpt,
          seo: { title: cur.seoTitle, description: cur.desc, focus: cur.focus } } });
        item = r.item;
        st.id = item.id;
        base = { ...base, title: cur.title, content: cur.content, excerpt: cur.excerpt, seoTitle: cur.seoTitle, desc: cur.desc, focus: cur.focus };
        ["title", "content", "excerpt", "seo"].forEach((k) => { delete f[k]; });
        afterSave(item, cur, true);
      }
      const keys = Object.keys(f).filter((k) => k !== "reviewedBy");
      if (keys.length) {
        const r = await api("save", { id: st.id, fields: f });
        if (r.item) item = r.item;
        if (r.redirect && !r.redirect.ok) showToast(`Saved, but the redirect wasn't made: ${r.redirect.why}`);
      }
      afterSave(item, cur);
      showToast(msg);
      return true;
    } catch (ex) {
      showToast(errText(ex));
      return false;
    } finally {
      st.busy = false;
      drawTop();
    }
  }
  function afterSave(it, cur, partly) {
    st.status = it.status; st.date = it.date; st.link = it.link; st.path = it.path; st.editUrl = it.editUrl;
    st.featured = it.featuredId || 0; st.featuredUrl = it.featured || st.featuredUrl;
    if (it.slug && !/\?/.test(it.path || "")) F("slug").value = it.slug;
    if (!partly) {
      base = { ...snap(), content: cur.content };
      st.savedAt = new Date();
      st.revOk = false;   // a new sign-off for the next change
    }
    applyLock();
    drawPub(); drawFeat(); drawPreview(); drawChecks();
    if (opts.onSaved) opts.onSaved(it);
  }

  /* ----- the top bar and Publish ----- */
  function drawTop(busyText) {
    $("status").innerHTML = `<span class="ws-pill is-${esc(st.status)}">${esc(STATUS[st.status] || st.status)}</span>${
      st.status === "future" && st.date ? ` <span class="ws-pe-saved">for ${esc(niceWhen(st.date))}</span>` : ""}`;
    $("saved").textContent = busyText || (dirty() ? "Not saved" : st.savedAt
      ? `Saved ${st.savedAt.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}` : "");
    const view = $("view");
    view.hidden = !st.id;
    if (st.id) {
      view.href = st.status === "publish" ? st.link : `${st.link}${st.link.includes("?") ? "&" : "?"}preview=true`;
      view.textContent = st.status === "publish" ? "View ↗" : "Preview ↗";
      view.title = st.status === "publish" ? "" : "Previews need you to be signed in to WordPress in this browser";
    }
    const b = st.busy ? " disabled" : "";
    $("acts").innerHTML = isLive()
      ? `<button type="button" class="lh-btn is-primary" data-a="update"${b}>Update</button>`
      : `<button type="button" class="lh-btn" data-a="draft"${b}>Save draft</button>${pub
        ? `<button type="button" class="lh-btn is-primary" data-a="publish"${b}>${st.sched ? "Schedule…" : "Publish…"}</button>`
        : st.status !== "pending" ? `<button type="button" class="lh-btn is-primary" data-a="review"${b}>Ready for review</button>` : ""}`;
  }

  function drawPub() {
    const box = $("pub");
    const opt = (p) => `<option value="${esc(p.name)}"${p.name === st.revBy ? " selected" : ""}>${esc(p.name)}</option>`;
    const sign = `<label class="fe-check"><input type="checkbox" data-in="revOk"${st.revOk ? " checked" : ""} /> A clinician has checked the medical content</label>
      <select class="fe-input" data-in="revBy" aria-label="Who checked it"><option value="">Who checked it?</option>
        ${clin.length ? `<optgroup label="Clinicians">${clin.map(opt).join("")}</optgroup><optgroup label="Others">${others.map(opt).join("")}</optgroup>` : people.map(opt).join("")}</select>`;
    if (!pub) {
      box.innerHTML = `<p class="ws-pe-note">${isLive() ? "It's live. Changes to the words need \"Website: publish and remove\"; titles, Google details, category and images can still be changed."
        : st.status === "pending" ? "Marked ready for review. An Admin can publish it from here." : "Save it as a draft while you work. When it's ready, press Ready for review and an Admin publishes it."}</p>`;
      return;
    }
    box.innerHTML = isLive() ? `
        ${st.status === "future" ? `<p class="ws-pe-note">Scheduled for <strong>${esc(niceWhen(st.date))}</strong>.</p>
          <label class="lh-field"><span class="lh-label">Change the time</span><input type="datetime-local" class="fe-input" data-in="when" value="${esc(st.when)}" min="${nowInput()}" /></label>
          <button type="button" class="lh-btn" data-a="resched">Save the new time</button>` : '<p class="ws-pe-note">It\'s live on the website.</p>'}
        <div class="ws-pe-sign">${sign}<p class="ws-pe-note">Needed when you change the words.</p></div>
        <button type="button" class="lh-btn is-quiet ws-pe-unpub" data-a="unpublish">Unpublish (back to a draft)</button>`
      : `
        <div class="ws-pe-row"><label class="fe-check"><input type="radio" name="when" value="now"${st.sched ? "" : " checked"} /> Publish now</label>
          <label class="fe-check"><input type="radio" name="when" value="later"${st.sched ? " checked" : ""} /> Schedule</label></div>
        ${st.sched ? `<input type="datetime-local" class="fe-input" data-in="when" value="${esc(st.when)}" min="${nowInput()}" />` : ""}
        <div class="ws-pe-sign">${sign}</div>
        <p class="ws-pe-note">Times are Perth time.</p>`;
  }

  function drawFeat() {
    $("feat").innerHTML = st.featured && st.featuredUrl
      ? `<img src="${esc(st.featuredUrl)}" alt="" /><div class="ws-pe-row"><button type="button" class="lh-btn" data-a="feat">Replace</button>
          <button type="button" class="lh-btn is-quiet" data-a="nofeat">Remove</button></div>`
      : `<button type="button" class="lh-btn" data-a="feat">Add a featured image</button>
         <p class="ws-pe-note">Shown at the top of the post, on the blog page and when it's shared.</p>`;
  }

  /* ----- Google preview ----- */
  const effTitle = () => { const v = val(); return v.seoTitle || `${v.title || "Untitled post"} - ${SITE}`; };
  function drawPreview() {
    const v = val();
    const slug = slugify(F("slug").value) || slugify(v.title) || "your-post";
    const t = effTitle();
    $("purl").textContent = `dermedica.com.au › ${slug}`;
    $("pt").textContent = cut(t, 60);
    $("pd").textContent = v.desc ? cut(v.desc, 160) : "No description: Google picks some text from the post.";
    $("pd").classList.toggle("is-none", !v.desc);
    F("seoTitle").placeholder = `${v.title || "Untitled post"} - ${SITE}`;
    const ct = ov.querySelector('[data-c="t"]'), cd = ov.querySelector('[data-c="d"]');
    ct.textContent = `${t.length} characters`; ct.className = countClass(t.length, LIM.title);
    cd.textContent = v.desc ? `${v.desc.length} characters` : ""; cd.className = v.desc ? countClass(v.desc.length, LIM.desc) : "ws-count";
    const live = st.status === "publish";
    const slugOpen = !live || (pub && info && info.redirection);
    F("slug").disabled = !slugOpen;
    $("slugnote").textContent = !live ? "You can change it until it's published."
      : !pub ? 'Changing a live address needs "Website: publish and remove".'
      : !(info && info.redirection) ? "Turn on a redirect plugin before changing a live address, so the old one doesn't break."
      : "Changing it sends people from the old address to the new one.";
  }

  /* ----- checks ----- */
  let proof = null;       // [{ type, quote, fix, why, done }]
  let proofSig = "";
  function localChecks() {
    const v = val();
    const text = body.innerText.replace(/\s+/g, " ").trim();
    const words = text ? text.split(" ").length : 0;
    const out = [];
    const add = (tone, msg) => out.push({ tone, msg });
    if (!v.title) add("bad", "Add a title");
    add(words < 300 ? "bad" : words < 600 ? "warn" : "ok", `${words.toLocaleString()} words${words < 600 ? ": aim for 600 or more" : ""}`);
    add(body.querySelector("h2") ? "ok" : "warn", body.querySelector("h2") ? "Has subheadings" : "Add subheadings (H2) to break it up");
    const noAlt = [...body.querySelectorAll("img")].filter((i) => !(i.getAttribute("alt") || "").trim()).length;
    if (noAlt) add("bad", `${noAlt} image${noAlt === 1 ? "" : "s"} without a description: double-click ${noAlt === 1 ? "it" : "each"} to add one`);
    const links = [...body.querySelectorAll("a[href]")].filter((a) => /^\/|dermedica\.com\.au/i.test(a.getAttribute("href"))).length;
    add(links ? "ok" : "warn", links ? `${links} link${links === 1 ? "" : "s"} to your other pages` : "Link to a related treatment or page on your website");
    add(st.featured ? "ok" : "warn", st.featured ? "Has a featured image" : "Add a featured image");
    const real = [...ov.querySelectorAll('[name="cat"]:checked')].filter((x) => !/^uncategori[sz]ed$/i.test(x.parentElement.textContent.trim()));
    add(real.length ? "ok" : "warn", real.length ? "Has a category" : "Choose a category");
    const t = effTitle();
    add(t.length > 60 ? "warn" : "ok", `SEO title ${t.length} characters${t.length > 60 ? ": may be cut off" : ""}`);
    const d = v.desc.length;
    add(!d || d > 160 || d < 120 ? "warn" : "ok", !d ? "Add a description for Google" : `Description ${d} characters${d > 160 ? ": may be cut off" : d < 120 ? ": a little short" : ""}`);
    if (!v.focus) add("warn", "Add a focus keyphrase");
    else {
      const kp = v.focus.toLowerCase();
      const firstP = ([...body.querySelectorAll("p")].find((p) => p.textContent.trim()) || {}).textContent || "";
      const miss = [!t.toLowerCase().includes(kp) && "the SEO title", !firstP.toLowerCase().includes(kp) && "the first paragraph",
        ![...body.querySelectorAll("h2,h3")].some((h) => h.textContent.toLowerCase().includes(kp)) && "a subheading"].filter(Boolean);
      add(miss.length ? "warn" : "ok", miss.length ? `Focus keyphrase isn't in ${miss.join(", ")}` : "Focus keyphrase is in the title, first paragraph and a subheading");
    }
    return out;
  }
  const checkText = () => { const v = val(); return [v.title, body.innerText, v.seoTitle, v.desc, v.excerpt].join("\n\n"); };
  function drawChecks() {
    $("checks").innerHTML = localChecks().map((c) => `<li class="is-${c.tone}">${esc(c.msg)}</li>`).join("");
    const stale = proof && proofSig !== checkText();
    $("proof").innerHTML = !proof ? '<p class="ws-pe-note">Spelling, grammar and the advertising rules haven\'t been checked yet.</p>'
      : `${stale ? '<p class="ws-pe-note">The words have changed since the check. Check again before publishing.</p>' : ""}${
        proof.length ? proof.map((x, i) => `<div class="ws-pe-iss is-${esc(x.type)}${x.done ? " is-done" : ""}">
          <b>${esc(ISSUE[x.type] || x.type)}</b>“${esc(x.quote)}”${x.fix ? ` → “${esc(x.fix)}”` : ""}
          ${x.why ? `<small>${esc(x.why)}</small>` : ""}
          ${x.done ? `<small>${x.done === "fixed" ? "Fixed" : "Ignored"}</small>` : `<div class="ws-pe-ia">${x.fix ? `<button type="button" class="lh-btn" data-fixi="${i}">Apply fix</button>` : ""}
            <button type="button" class="lh-btn is-quiet" data-igni="${i}">Ignore</button></div>`}</div>`).join("")
          : '<p class="ws-pe-note">✓ No spelling, grammar or advertising problems found.</p>'}`;
  }
  async function runCheck(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    try {
      const sig = checkText();
      const r = await api("check", { text: sig });
      proof = (r.issues || []).map((x) => ({ ...x, done: "" }));
      proofSig = sig;
      drawChecks();
      return true;
    } catch (ex) { showToast(errText(ex)); return false; }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "Check again"; } }
  }
  // Swaps the quoted words for the fix: in the words first, then the title, Google details and summary
  function applyFix(x) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.data.indexOf(x.quote);
      if (i >= 0) { n.data = n.data.slice(0, i) + x.fix + n.data.slice(i + x.quote.length); return true; }
    }
    for (const name of ["title", "seoTitle", "desc", "excerpt"]) {
      const el = F(name);
      if (el.value.includes(x.quote)) { el.value = el.value.replace(x.quote, x.fix); return true; }
    }
    return false;
  }

  /* ----- suggestions (the same as Fix it) ----- */
  async function suggest(btn) {
    if (!st.id || (dirty() && !isLive())) {   // suggestions read the saved post
      if (!(await save({}, "Draft saved"))) return;
    }
    btn.disabled = true; btn.textContent = "Writing…";
    ["title", "desc"].forEach((k) => { ov.querySelector(`[data-sug="${k}"]`).innerHTML = '<p class="ws-sug-wait">Reading the post and its Google searches…</p>'; });
    try {
      const r = await api("suggest", { id: st.id, fix: "both", target: val().focus });
      const opt = (k, o) => {
        const lim = k === "title" ? LIM.title : LIM.desc;
        return `<button type="button" class="ws-opt${o.flags.length ? " is-flag" : ""}" data-use="${k}" data-text="${esc(o.text)}">
          <span class="ws-opt-t">${esc(o.text)}</span><span class="ws-opt-m"><span class="${countClass(o.text.length, lim)}">${o.text.length} characters</span>${o.why ? ` · ${esc(o.why)}` : ""}</span>
          ${o.flags.map((f) => `<span class="ws-flag">⚠ ${esc(f)}. Check before using.</span>`).join("")}</button>`;
      };
      ov.querySelector('[data-sug="title"]').innerHTML = (r.titles || []).map((o) => opt("title", o)).join("");
      ov.querySelector('[data-sug="desc"]').innerHTML = (r.descriptions || []).map((o) => opt("desc", o)).join("");
      $("sch").innerHTML = (r.searches || []).length ? `<p class="ws-sug-h">Searches that show it in Google: click one for the focus keyphrase</p>
        <div class="ws-sch-list">${r.searches.map((q) => `<button type="button" class="ws-chip" data-kp="${esc(q.q)}">${esc(q.q)}<em>${q.impressions}</em></button>`).join("")}</div>`
        : r.searchNote ? `<p class="ws-pe-note">${esc(r.searchNote)}</p>` : "";
    } catch (ex) {
      ov.querySelector('[data-sug="title"]').innerHTML = "";
      ov.querySelector('[data-sug="desc"]').innerHTML = `<p class="ws-sug-err">${esc(errText(ex))}</p>`;
    } finally { btn.disabled = false; btn.textContent = "✨ Write new suggestions"; }
  }

  /* ----- images ----- */
  let pickFor = "", savedRange = null;
  const keepRange = () => {
    const sel = window.getSelection();
    savedRange = sel && sel.rangeCount && body.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  };
  function pickImage(forWhat) { pickFor = forWhat; if (forWhat === "body") keepRange(); $("file").value = ""; $("file").click(); }
  $("file").addEventListener("change", async () => {
    const file = $("file").files[0];
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) { showToast("Choose an image file."); return; }
    const alt = prompt("Describe the image in a few words (alt text). It helps Google and people using screen readers.", "");
    if (alt === null) return;
    showToast("Uploading the image…");
    try {
      const sh = await shrink(file);
      const r = await api("media", { data: sh.data, name: sh.name, alt: alt.trim(), post: st.id || 0 });
      if (pickFor === "featured") { st.featured = r.id; st.featuredUrl = r.url; drawFeat(); }
      else {
        body.focus();
        const sel = window.getSelection();
        if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
        else { const rg = document.createRange(); rg.selectNodeContents(body); rg.collapse(false); sel.removeAllRanges(); sel.addRange(rg); }
        document.execCommand("insertHTML", false, `<figure><img src="${esc(r.url)}" alt="${esc(alt.trim())}" data-id="${Number(r.id) || ""}"></figure><p><br></p>`);
      }
      changed();
      showToast("Image added");
    } catch (ex) { showToast(errText(ex)); }
  });

  /* ----- the toolbar ----- */
  function run(cmd) {
    if (locked) return;
    body.focus();
    const ex = (c, v = null) => document.execCommand(c, false, v);
    if (cmd === "p" || cmd === "h2" || cmd === "h3") ex("formatBlock", cmd.toUpperCase());
    else if (cmd === "quote") ex("formatBlock", "BLOCKQUOTE");
    else if (cmd === "bold" || cmd === "italic" || cmd === "undo" || cmd === "redo") ex(cmd);
    else if (cmd === "ul") ex("insertUnorderedList");
    else if (cmd === "ol") ex("insertOrderedList");
    else if (cmd === "hr") ex("insertHorizontalRule");
    else if (cmd === "image") { pickImage("body"); return; }
    else if (cmd === "link") {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { showToast("Select the words to link first."); return; }
      const u = prompt("Link to: a full address (https://…), or a page on your website starting with / (e.g. /melasma-treatment-perth/)", "/");
      if (!u || !u.trim()) return;
      if (!/^(https?:\/\/|\/|mailto:|tel:)/i.test(u.trim())) { showToast("Start the address with https:// or /"); return; }
      ex("createLink", u.trim());
    }
    changed();
  }

  /* ----- changes ----- */
  let tmr = 0;
  function changed() {
    clearTimeout(tmr);
    tmr = setTimeout(() => { drawPreview(); drawChecks(); drawTop(); }, 350);
  }

  ov.addEventListener("mousedown", (e) => { if (e.target.closest("[data-cmd]")) e.preventDefault(); });   // keeps the selection
  ov.addEventListener("input", (e) => {
    if (e.target.name === "desc" && /\n/.test(e.target.value)) e.target.value = e.target.value.replace(/\n+/g, " ");
    const k = e.target.dataset.in;
    if (k === "when") st.when = e.target.value;
    changed();
  });
  ov.addEventListener("change", (e) => {
    const k = e.target.dataset.in;
    if (k === "revOk") st.revOk = e.target.checked;
    else if (k === "revBy") st.revBy = e.target.value;
    else if (k === "when") st.when = e.target.value;
    else if (e.target.name === "when") { st.sched = e.target.value === "later"; drawPub(); drawTop(); }
    changed();
  });
  body.addEventListener("paste", (e) => {
    if (locked) return;
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertHTML", false, html ? cleanHtml(html) : textToHtml(text));
    changed();
  });
  body.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); showToast("Use the Image button to add images."); } });
  body.addEventListener("dblclick", (e) => {
    const img = e.target.closest("img");
    if (!img || locked) return;
    const alt = prompt("Describe this image (alt text):", img.getAttribute("alt") || "");
    if (alt === null) return;
    img.setAttribute("alt", alt.trim());
    changed();
  });

  const close = () => { if (!dirty() || confirm("Leave without saving your changes?")) shut(); };

  // Before publishing: the problems worth a second look
  function blockers() {
    const out = localChecks().filter((c) => c.tone === "bad").map((c) => c.msg);
    if (!proof || proofSig !== checkText()) out.push("Spelling and the advertising rules haven't been checked since the last change");
    else {
      const ad = proof.filter((x) => !x.done && (x.type === "advertising" || x.type === "claim")).length;
      if (ad) out.push(`${ad} advertising or evidence problem${ad === 1 ? "" : "s"} not dealt with`);
    }
    return out;
  }
  const needSign = () => {
    if (st.revOk && st.revBy) return false;
    showToast("Tick that a clinician has checked the medical content, and choose who.");
    $("pub").scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  };

  ov.addEventListener("click", async (e) => {
    const cmd = e.target.closest("[data-cmd]");
    if (cmd) { run(cmd.dataset.cmd); return; }
    const use = e.target.closest("[data-use]");
    if (use) { F(use.dataset.use === "title" ? "seoTitle" : "desc").value = use.dataset.text; changed(); return; }
    const kp = e.target.closest("[data-kp]");
    if (kp) { F("focus").value = kp.dataset.kp; changed(); return; }
    const fx = e.target.closest("[data-fixi]");
    if (fx) {
      const x = proof[Number(fx.dataset.fixi)];
      if (x && applyFix(x)) { x.done = "fixed"; changed(); drawChecks(); }
      else showToast("Couldn't find those exact words. Change them by hand.");
      return;
    }
    const ig = e.target.closest("[data-igni]");
    if (ig) { const x = proof[Number(ig.dataset.igni)]; if (x) { x.done = "ignored"; drawChecks(); } return; }

    const a = e.target.closest("[data-a]");
    if (!a) return;
    const act = a.dataset.a;
    if (act === "close") close();
    else if (act === "draft") await save({}, "Draft saved");
    else if (act === "review") await save({ status: "pending" }, "Marked ready for review");
    else if (act === "check") await runCheck(a);
    else if (act === "suggest") await suggest(a);
    else if (act === "feat") pickImage("featured");
    else if (act === "nofeat") { st.featured = 0; st.featuredUrl = ""; drawFeat(); changed(); }
    else if (act === "publish") {
      if (st.sched && !st.when) { showToast("Choose when to publish it."); return; }
      if (needSign()) return;
      if (!proof || proofSig !== checkText()) await runCheck($("proof").closest(".ws-pe-sec").querySelector('[data-a="check"]'));
      const b = blockers();
      const when = st.sched ? `Schedule it for ${niceWhen(st.when)}?` : "Publish it on the website now?";
      if (!confirm(b.length ? `${when}\n\nStill to look at:\n• ${b.join("\n• ")}` : when)) return;
      await save(st.sched ? { status: "future", date: st.when.replace("T", " "), reviewedBy: st.revBy } : { status: "publish", reviewedBy: st.revBy },
        st.sched ? "Scheduled" : "Published. It's live on the website now.");
    } else if (act === "update") {
      const wordsChanged = !locked && toBlocks(body) !== base.content;
      if (wordsChanged && needSign()) return;
      if (wordsChanged) {
        if (!proof || proofSig !== checkText()) await runCheck($("proof").closest(".ws-pe-sec").querySelector('[data-a="check"]'));
        const b = blockers();
        if (b.length && !confirm(`Update the live post?\n\nStill to look at:\n• ${b.join("\n• ")}`)) return;
      }
      await save(wordsChanged ? { reviewedBy: st.revBy } : {}, "Updated. It's live on the website now.");
    } else if (act === "resched") {
      if (!st.when) { showToast("Choose a time."); return; }
      if (needSign()) return;
      await save({ status: "future", date: st.when.replace("T", " "), reviewedBy: st.revBy }, "New time saved");
    } else if (act === "unpublish") {
      if (!confirm("Take it off the website? It becomes a draft again, and its address stops working until it's published again.")) return;
      await save({ status: "draft" }, "Unpublished: it's a draft again");
    }
  });

  drawTop(); drawPub(); drawFeat(); drawPreview(); drawChecks();
  (body.contentEditable === "true" && !body.textContent.trim() && !F("title").value ? F("title") : body).focus();
}