// SEO → Website: every page and blog post on the website, with how each one shows in Google.
// Read and saved through Apps Script (action "wordpress"), which talks to the Dermedica Portal Connector plugin.
// Changes go live straight away, and each one is added to the Change log.
// Fix it: Claude suggests titles and descriptions from the page's text and its Google searches, checked against the advertising rules.
import { callApi } from "./appointments.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";
import { openPostEditor, takePostDraft } from "./seo-post.js?v=1";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SITE = "Dermedica";
const LIM = { title: [30, 60], desc: [120, 160] };
const TYPE = { page: "Page", post: "Blog post" };
const STATUS = { publish: "Published", draft: "Draft", pending: "Pending review", private: "Private", future: "Scheduled" };
const STATUSES = [["publish", "Published"], ["draft", "Drafts"], ["future", "Scheduled"], ["private", "Private"], ["all", "Everything"]];
const CHECKS = [
  ["", "All"], ["attn", "Needs attention"], ["no-desc", "No description"], ["title-long", "Title too long"],
  ["desc-long", "Description too long"], ["desc-short", "Description too short"], ["no-focus", "No focus keyphrase"],
  ["noindex", "Hidden from Google"],
];
const PAGE = 100;

let cache = null;   // { items, at }: kept while you move between SEO tabs
let info = null;    // the plugins on the site (whether redirects work)

async function api(op, data = {}) {
  const r = await callApi({ action: "wordpress", op, ...data });
  if (r && r.problem) throw new Error(r.problem);
  return r;
}
const errText = (err) => (err && err.code === "FORBIDDEN"
  ? "You don't have access to do that. Ask an Admin for Website access in Staff → Roles and access."
  : (err && err.message) || "Something went wrong. Try again.");

/** A Fix it button for Site health, Tasks or anywhere in SEO. what: "title", "desc" or "both" */
export function fixItHtml(path, what = "both", target = "") {
  return `<button type="button" class="seo-btn ws-fixit" data-wsfix="${esc(`${path}|${what}|${target}`)}" title="Open the page with suggestions written">✨ Fix it</button>`;
}

/* ---------- SEO details ---------- */
const aio = (it) => (it.seo && (it.seo.aioseo || it.seo.yoast)) || {};
const live = (it) => (it.seo && it.seo.live) || {};
const fillTags = (s, title) => String(s || "").replace(/#post_title/g, title).replace(/#separator_sa/g, "-")
  .replace(/#site_title/g, SITE).replace(/#\w+/g, "").replace(/\s+/g, " ").trim();
// The title Google gets when the SEO title is blank: the page title plus the site's ending (" - Dermedica")
function defaultTitle(it, pageTitle) {
  const l = live(it).title || "";
  const suffix = !aio(it).title && it.title && l.startsWith(it.title) ? l.slice(it.title.length) : ` - ${SITE}`;
  return `${pageTitle}${suffix}`;
}
const seoTitle = (it) => live(it).title || (aio(it).title ? fillTags(aio(it).title, it.title) : defaultTitle(it, it.title));

function checksOf(it) {
  const a = aio(it);
  const t = seoTitle(it).length;
  const d = (a.description || "").length;
  const out = [];
  if (t > LIM.title[1]) out.push(["title-long", "Title may be cut off", "warn"]);
  if (!d) out.push(["no-desc", "No description", "bad"]);
  else if (d > LIM.desc[1]) out.push(["desc-long", "Description may be cut off", "warn"]);
  else if (d < LIM.desc[0]) out.push(["desc-short", "Short description", "info"]);
  if (!a.focus) out.push(["no-focus", "No focus keyphrase", "info"]);
  if (a.noindex) out.push(["noindex", "Hidden from Google", "bad"]);
  return out;
}
const hasCheck = (it, k) => (k === "attn" ? checksOf(it).some((c) => c[2] !== "info") : checksOf(it).some((c) => c[0] === k));
// What Fix it should write for this page: "title", "desc", "both" or "" (nothing to fix)
function fixOf(it) {
  const c = checksOf(it).map((x) => x[0]);
  const t = c.includes("title-long");
  const d = c.some((k) => ["no-desc", "desc-long", "desc-short"].includes(k));
  return t && d ? "both" : t ? "title" : d ? "desc" : "";
}

/* ---------- Small helpers ---------- */
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const niceDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const lenTag = (n, [lo, hi], none = "None") => (!n ? `<span class="ws-len is-bad">${none}</span>`
  : `<span class="ws-len is-${n > hi ? "warn" : n < lo ? "info" : "good"}" title="${n} characters">${n}</span>`);
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "dermedica.com.au"; } };
const prefixOf = (it) => (/\?/.test(it.path || "") ? "/" : String(it.path || "/").replace(/[^/]+\/?$/, "") || "/");
const normPath = (s) => String(s || "").replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase() || "/";
const countClass = (n, [lo, hi]) => `ws-count is-${n > hi ? "warn" : n < lo ? "info" : "good"}`;

/* ===================== The list ===================== */

export async function mountSeoSite(container, { param = "" } = {}) {
  const root = document.createElement("section");
  root.className = "ws";
  container.replaceChildren(root);
  const edit = can("seo.pages");
  const pub = can("seo.publish");
  const st = { type: "", status: "publish", q: "", chk: "", n: PAGE };

  if (!info) api("info").then((r) => { info = r; }).catch(() => { info = {}; });
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
  try { if (!cache) await load(false); }
  catch (err) {
    console.error("Website pages failed:", err);
    root.innerHTML = `<div class="state"><strong>Couldn't load the website's pages</strong>${esc(errText(err))}</div>`;
    return;
  }
  if (!root.isConnected) return;

  async function load(fresh) {
    const r = await api("list", { fresh });
    cache = { items: r.items || [], at: r.at || new Date().toISOString() };
  }

  root.innerHTML = `
    <div class="ws-top">
      <div><h3>Website pages and posts</h3>
        <p class="muted">How each page shows in Google. Changes go live on the website straight away, and are added to the Change log.</p></div>
      <div class="ws-acts"><small class="muted" data-role="at"></small>
        <button type="button" class="lh-btn is-quiet" data-act="refresh">Refresh</button>
        ${edit ? '<button type="button" class="lh-btn is-primary" data-act="newpost">+ New blog post</button>' : ""}</div>
    </div>
    <div class="ws-tools">
      <input type="search" class="fe-input" data-role="q" placeholder="Search a title or address" aria-label="Search" />
      <select class="fe-input" data-role="type" aria-label="Type">
        <option value="">Pages and blog posts</option><option value="page">Pages</option><option value="post">Blog posts</option></select>
      <select class="fe-input" data-role="status" aria-label="Status">${STATUSES.map(([v, l]) =>
        `<option value="${v}"${v === st.status ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
    </div>
    <div class="ws-chips" data-role="chips" role="group" aria-label="Show"></div>
    <div data-role="body"></div>`;
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);

  const pool = () => cache.items.filter((it) => (!st.type || it.type === st.type)
    && (st.status === "all" || it.status === st.status)
    && (!st.q || `${it.title} ${it.path} ${seoTitle(it)} ${aio(it).focus || ""}`.toLowerCase().includes(st.q)));

  function drawBody() {
    $("at").textContent = `Read ${new Date(cache.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}`;
    const list = pool();
    $("chips").innerHTML = CHECKS.map(([k, l]) => {
      const n = k ? list.filter((it) => hasCheck(it, k)).length : list.length;
      const on = st.chk === k;
      return `<button type="button" class="ws-chip${on ? " is-on" : ""}${!n && !on && k ? " is-zero" : ""}" data-chk="${k}" aria-pressed="${on}">${esc(l)}<em>${n}</em></button>`;
    }).join("");
    const rows = list.filter((it) => !st.chk || hasCheck(it, st.chk));
    if (!rows.length) { $("body").innerHTML = '<p class="ws-empty">Nothing matches.</p>'; return; }
    $("body").innerHTML = `<div class="ws-wrap"><table class="ws-table"><thead><tr>
        <th>Page</th><th>Status</th><th>How it shows in Google</th><th>Description</th><th class="ws-hide-sm">Focus keyphrase</th><th class="ws-hide-sm">Edited</th>${edit ? "<th></th>" : ""}
      </tr></thead><tbody>${rows.slice(0, st.n).map((it) => {
        const a = aio(it);
        const t = seoTitle(it);
        const fx = edit ? fixOf(it) : "";
        return `<tr data-id="${it.id}" tabindex="0">
          <td><strong>${esc(it.title || "(no title)")}</strong><small>${esc(it.path)}</small>
            ${it.type === "post" ? '<span class="ws-badge">Blog post</span>' : ""}${it.elementor ? '<span class="ws-badge is-el">Elementor</span>' : ""}
            ${checksOf(it).filter((c) => c[2] !== "info").map((c) => `<span class="ws-badge is-${c[2]}">${esc(c[1])}</span>`).join("")}</td>
          <td><span class="ws-pill is-${esc(it.status)}">${esc(STATUS[it.status] || it.status)}</span></td>
          <td class="ws-st">${lenTag(t.length, LIM.title)} ${esc(cut(t, 70))}${a.title ? "" : '<small>Default title</small>'}</td>
          <td>${lenTag((a.description || "").length, LIM.desc)}</td>
          <td class="ws-hide-sm">${a.focus ? esc(a.focus) : '<span class="muted">None</span>'}</td>
          <td class="ws-hide-sm">${esc(niceDate(it.modified))}</td>
          ${edit ? `<td>${fx ? `<button type="button" class="lh-btn ws-fix" data-fix="${it.id}" data-what="${fx}">✨ Fix it</button>` : ""}</td>` : ""}</tr>`;
      }).join("")}</tbody></table></div>
      ${rows.length > st.n ? `<button type="button" class="lh-btn is-quiet ws-more" data-act="more">Show ${Math.min(PAGE, rows.length - st.n)} more of ${rows.length - st.n}</button>` : ""}`;
  }
  drawBody();

  const byId = (id) => cache.items.find((x) => String(x.id) === String(id));
  const openId = (id, opts) => { const it = byId(id); if (it) openEditor(it, opts); };
  // A saved post goes back into the list (new ones at the top)
  const upsert = (item) => {
    const i = cache.items.findIndex((x) => x.id === item.id);
    if (i >= 0) cache.items[i] = { ...cache.items[i], ...item }; else cache.items.unshift(item);
    if (root.isConnected) drawBody();
  };
  // Clicking a row: blog posts open the full post editor, pages (and Elementor posts) the SEO window
  const openRow = (id) => {
    const it = byId(id);
    if (!it) return;
    if (edit && it.type === "post" && !it.elementor) openPostEditor({ id: it.id, onSaved: upsert });
    else openEditor(it);
  };

  root.addEventListener("input", (e) => {
    if (e.target.dataset.role === "q") { st.q = e.target.value.trim().toLowerCase(); st.n = PAGE; drawBody(); }
  });
  root.addEventListener("change", (e) => {
    const r = e.target.dataset.role;
    if (r === "type" || r === "status") { st[r] = e.target.value; st.n = PAGE; drawBody(); }
  });
  root.addEventListener("keydown", (e) => {
    const tr = e.target.closest && e.target.closest("tr[data-id]");
    if (tr && e.target === tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openRow(tr.dataset.id); }
  });
  root.addEventListener("click", async (e) => {
    const fx = e.target.closest("[data-fix]");
    if (fx) { openId(fx.dataset.fix, { fix: fx.dataset.what || "both" }); return; }
    const ch = e.target.closest("[data-chk]");
    if (ch) { st.chk = st.chk === ch.dataset.chk ? "" : ch.dataset.chk; st.n = PAGE; drawBody(); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) { openRow(tr.dataset.id); return; }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "more") { st.n += PAGE; drawBody(); }
    if (a.dataset.act === "newpost") openPostEditor({ onSaved: upsert });
    if (a.dataset.act === "refresh") {
      a.disabled = true;
      a.textContent = "Reading the website…";
      try { await load(true); drawBody(); showToast("Up to date"); }
      catch (err) { showToast(errText(err)); }
      finally { a.disabled = false; a.textContent = "Refresh"; }
    }
  });

  /* ===================== One page ===================== */
  // opts.fix: "title", "desc" or "both" starts the suggestions as soon as it opens

  function openEditor(it, opts = {}) {
    const a = aio(it);
    const isPub = it.status === "publish";
    const slugOpen = pub && (!isPub || (info && info.redirection));
    const slugNote = !pub ? 'Changing the address needs "Website: publish and remove".'
      : !slugOpen ? "Turn on a redirect plugin before changing a published page's address, so the old address doesn't break."
      : isPub ? "Changing it sends people from the old address to the new one. Google takes a few weeks to catch up, so only change it if you need to." : "";
    const ro = edit ? "" : " disabled";
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ws-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>${esc(it.title || "(no title)")}</h3>
        <p>${esc([TYPE[it.type], STATUS[it.status] || it.status, `edited ${niceDate(it.modified)}${it.author ? ` by ${it.author}` : ""}`].join(" · "))}</p></div>
      <div class="ws-prev" aria-label="How it may look in Google">
        <div class="ws-prev-head"><small>Google preview</small>
          ${edit ? '<button type="button" class="lh-btn ws-ai-btn" data-act="suggest">✨ Write suggestions</button>' : ""}</div>
        <span class="ws-prev-url" data-p="url"></span><span class="ws-prev-t" data-p="t"></span><span class="ws-prev-d" data-p="d"></span></div>
      <p class="ws-sug-note" data-p="note" hidden></p>
      <label class="lh-field"><span class="lh-label">Page title</span>
        <input name="title" class="fe-input" maxlength="200" value="${esc(it.title)}"${ro} />
        <small class="fe-note">The page's name in WordPress.${it.elementor ? " The heading people see on the page is set in Elementor." : ""}</small></label>
      <label class="lh-field"><span class="lh-label">SEO title <em data-c="t"></em></span>
        <input name="seoTitle" class="fe-input" maxlength="200" value="${esc(a.title || "")}"${ro} />
        <small class="fe-note">What Google shows as the link. Leave it blank to use the default (shown in grey). Aim for 50 to 60 characters.</small></label>
      <div class="ws-sug" data-sug="title"></div>
      ${/#\w+/.test(a.title || "") ? '<p class="ws-warn">This uses All in One SEO tags (like #post_title). Typing your own title replaces them.</p>' : ""}
      <label class="lh-field"><span class="lh-label">Description <em data-c="d"></em></span>
        <textarea name="desc" class="fe-input" rows="3" maxlength="320"${ro}>${esc(a.description || "")}</textarea>
        <small class="fe-note">The text under the link in Google. Aim for 120 to 160 characters.</small></label>
      <div class="ws-sug" data-sug="desc"></div>
      <label class="lh-field"><span class="lh-label">Focus keyphrase</span>
        <input name="focus" class="fe-input" maxlength="120" value="${esc(a.focus || "")}" placeholder="e.g. neck pigmentation"${ro} /></label>
      <div class="ws-sch" data-p="sch"></div>
      <ul class="ws-kp" data-p="kp"></ul>
      <label class="lh-field"><span class="lh-label">Address</span>
        <span class="ws-slug"><span>${esc(prefixOf(it))}</span><input name="slug" class="fe-input" maxlength="190" value="${esc(it.slug)}"${slugOpen ? "" : " disabled"} /><span>/</span></span>
        ${slugNote ? `<small class="fe-note">${esc(slugNote)}</small>` : ""}</label>
      ${pub ? `<label class="fe-check"><input type="checkbox" name="noindex"${a.noindex ? " checked" : ""} /> Hide this page from Google</label>`
        : a.noindex ? '<p class="ws-warn">This page is hidden from Google.</p>' : ""}
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions ws-dlg-acts">
        <a class="lh-btn is-quiet" href="${esc(it.link)}" target="_blank" rel="noopener">Open page ↗</a>
        ${it.elementor ? `<a class="lh-btn is-quiet" href="${esc(it.elementorUrl || it.editUrl)}" target="_blank" rel="noopener">Edit in Elementor ↗</a>`
          : `<a class="lh-btn is-quiet" href="${esc(it.editUrl)}" target="_blank" rel="noopener">Edit in WordPress ↗</a>`}
        <span class="inv-spacer"></span>
        <button type="button" class="lh-btn is-quiet" data-act="cancel">${edit ? "Cancel" : "Close"}</button>
        ${edit ? '<button type="submit" class="lh-btn is-primary">Save</button>' : ""}
      </div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("form");
    const f = form.elements;
    const err = dlg.querySelector(".lh-error");
    const P = (k) => dlg.querySelector(`[data-p="${k}"]`);
    const S = (k) => dlg.querySelector(`[data-sug="${k}"]`);

    const val = () => ({
      title: f.title.value.replace(/\s+/g, " ").trim(),
      seoTitle: f.seoTitle.value.replace(/\s+/g, " ").trim(),
      desc: f.desc.value.replace(/\s+/g, " ").trim(),
      focus: f.focus.value.replace(/\s+/g, " ").trim(),
      slug: slugify(f.slug.value),
      noindex: f.noindex ? f.noindex.checked : !!a.noindex,
    });
    // From a task step: its words become the focus keyphrase, if there isn't one yet
    if (edit && opts.target && opts.target[0] !== "!" && !f.focus.value) f.focus.value = opts.target;
    const start = JSON.stringify(val());
    const dirty = () => JSON.stringify(val()) !== start;
    if (edit && opts.preset) {   // from the Advisor: its title and description, ready to check and save
      if (opts.preset.seoTitle) f.seoTitle.value = opts.preset.seoTitle;
      if (opts.preset.desc) f.desc.value = opts.preset.desc;
      P("note").textContent = "From the Advisor: check the title and description, then Save.";
      P("note").hidden = false;
    }
    const count = (el, n, lim) => { el.textContent = n ? `${n} characters` : ""; el.className = n ? countClass(n, lim) : "ws-count"; };

    function update() {
      const v = val();
      const title = v.seoTitle ? fillTags(v.seoTitle, v.title) : defaultTitle(it, v.title);
      f.seoTitle.placeholder = defaultTitle(it, v.title);
      const desc = v.desc || (!a.description && live(it).description) || "";
      const path = isPub ? `${prefixOf(it)}${v.slug}/` : it.path;
      P("url").textContent = [hostOf(it.link), ...String(path).split(/[/?]/).filter(Boolean)].join(" › ");
      P("t").textContent = cut(title, 60);
      P("d").textContent = desc ? cut(desc, 160) : "No description: Google picks some text from the page.";
      P("d").classList.toggle("is-none", !desc);
      count(dlg.querySelector('[data-c="t"]'), title.length, LIM.title);
      count(dlg.querySelector('[data-c="d"]'), v.desc.length, LIM.desc);
      const kp = v.focus.toLowerCase();
      P("kp").innerHTML = kp ? [["In the SEO title", title.toLowerCase().includes(kp)],
        ["In the description", desc.toLowerCase().includes(kp)],
        ["In the address", v.slug.includes(slugify(kp))]]
        .map(([l, ok]) => `<li class="${ok ? "is-ok" : ""}">${ok ? "✓" : "✗"} ${esc(l)}</li>`).join("") : "";
      // The suggestion in use is marked
      dlg.querySelectorAll("[data-use]").forEach((b) => {
        const cur = b.dataset.use === "title" ? v.seoTitle : v.desc;
        b.classList.toggle("is-on", !!cur && b.dataset.text === cur);
      });
    }

    /* ----- Suggestions (Fix it) ----- */
    let busy = false;
    const optHtml = (k, o) => {
      const n = o.text.length;
      const lim = k === "title" ? LIM.title : LIM.desc;
      return `<button type="button" class="ws-opt${o.flags.length ? " is-flag" : ""}" data-use="${k}" data-text="${esc(o.text)}">
        <span class="ws-opt-t">${esc(o.text)}</span>
        <span class="ws-opt-m"><span class="${countClass(n, lim)}">${n} characters</span>${o.why ? ` · ${esc(o.why)}` : ""}</span>
        ${o.flags.map((x) => `<span class="ws-flag">⚠ ${esc(x)}. Check before using.</span>`).join("")}</button>`;
    };
    async function suggest() {
      if (busy) return;
      busy = true;
      const b = dlg.querySelector('[data-act="suggest"]');
      if (b) { b.disabled = true; b.textContent = "Writing suggestions…"; }
      const fix = opts.fix || "both";
      ["title", "desc"].forEach((k) => {
        S(k).innerHTML = fix === "both" || fix === k ? '<p class="ws-sug-wait">Reading the page and its Google searches…</p>' : "";
      });
      P("note").hidden = true;
      try {
        const r = await api("suggest", { id: it.id, fix, target: opts.target || "" });
        if (!dlg.isConnected) return;
        S("title").innerHTML = (r.titles || []).length
          ? `<p class="ws-sug-h">Suggested SEO titles: click one to use it</p>${r.titles.map((o) => optHtml("title", o)).join("")}` : "";
        S("desc").innerHTML = (r.descriptions || []).length
          ? `<p class="ws-sug-h">Suggested descriptions: click one to use it</p>${r.descriptions.map((o) => optHtml("desc", o)).join("")}` : "";
        const sch = r.searches || [];
        P("sch").innerHTML = sch.length ? `<p class="ws-sug-h">Searches that show this page in Google (last 90 days): click one to make it the focus keyphrase</p>
          <div class="ws-sch-list">${sch.map((q) => `<button type="button" class="ws-chip" data-kp="${esc(q.q)}"
            title="${q.impressions} times in Google · ${q.clicks} clicks · position ${q.position}">${esc(q.q)}<em>${q.impressions}</em></button>`).join("")}</div>` : "";
        P("note").textContent = [r.searchNote, "Suggestions are a starting point: check they're accurate for this page before saving."].filter(Boolean).join(" ");
        P("note").hidden = false;
        update();
        const firstBox = fix === "desc" ? S("desc") : S("title");
        if (firstBox && firstBox.firstElementChild) firstBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (ex) {
        S("title").innerHTML = "";
        S("desc").innerHTML = `<p class="ws-sug-err">${esc(errText(ex))}</p>`;
      } finally {
        busy = false;
        if (b && b.isConnected) { b.disabled = false; b.textContent = "✨ Write new suggestions"; }
      }
    }

    update();
    form.addEventListener("input", (e) => {
      if (e.target.name === "desc" && /\n/.test(e.target.value)) e.target.value = e.target.value.replace(/\n+/g, " ");
      update();
    });
    dlg.addEventListener("click", (e) => {
      const use = e.target.closest("[data-use]");
      if (use && edit) {
        const field = use.dataset.use === "title" ? f.seoTitle : f.desc;
        field.value = use.dataset.text;
        update();
        field.focus();
        return;
      }
      const kp = e.target.closest("[data-kp]");
      if (kp && edit) { f.focus.value = kp.dataset.kp; update(); return; }
      if (e.target.closest('[data-act="suggest"]')) suggest();
    });

    const close = () => { if (!edit || !dirty() || confirm("Close without saving your changes?")) dlg.close(); };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", close);
    dlg.addEventListener("close", () => dlg.remove());

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!edit) return;
      const v = val();
      if (!v.title) { err.textContent = "The page title can't be empty."; err.hidden = false; return; }
      const fields = {};
      if (v.title !== it.title) fields.title = v.title;
      const seo = {};
      if (v.seoTitle !== (a.title || "")) seo.title = v.seoTitle;
      if (v.desc !== (a.description || "")) seo.description = v.desc;
      if (v.focus !== (a.focus || "")) seo.focus = v.focus;
      if (pub && v.noindex !== !!a.noindex) {
        if (v.noindex && !confirm(`Hide "${it.title}" from Google? It will drop out of search results over the next few days.`)) return;
        seo.noindex = v.noindex;
      }
      if (Object.keys(seo).length) fields.seo = seo;
      if (slugOpen && v.slug && v.slug !== it.slug) fields.slug = v.slug;
      if (!Object.keys(fields).length) { dlg.close(); showToast("Nothing changed"); return; }

      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Saving…";
      err.hidden = true;
      try {
        const r = await api("save", { id: it.id, fields });
        const i = cache.items.findIndex((x) => x.id === it.id);
        if (i >= 0 && r.item) cache.items[i] = r.item;
        dlg.close();
        drawBody();
        if (r.redirect && !r.redirect.ok) showToast(`Saved, but the redirect wasn't made: ${r.redirect.why}`);
        else showToast(isPub ? "Saved. It's live on the website now." : "Saved");
      } catch (ex) {
        err.textContent = errText(ex);
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Save";
      }
    });
    dlg.showModal();
    if (edit && opts.fix) suggest();
  }

  // Opening a page straight away:
  //   #/seo/website/<id>            that page
  //   "path:/address/"              from a page's panel in Pages
  //   "fix:<what>:/address/"        from a Fix it button: opens it and writes suggestions
  const pv = String(param || "");
  const byPath = (p) => { const want = normPath(p); return cache.items.find((x) => normPath(x.path) === want) || cache.items.find((x) => normPath(x.link) === want); };
  const notFound = () => showToast("That page isn't in WordPress's list of pages and posts (it may be a category or archive page).");
  if (pv === "new" && edit) { openPostEditor({ draft: takePostDraft(), onSaved: upsert }); return; }
  if (pv === "set") {   // from the Advisor's "Use on the page"
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem("dm.seo.setmeta") || "null"); sessionStorage.removeItem("dm.seo.setmeta"); } catch { s = null; }
    const it = s && byPath(s.path);
    if (it) openEditor(it, { preset: { seoTitle: s.seoTitle || "", desc: s.desc || "" } });
    else if (s) notFound();
    return;
  }
  const fm = /^fix:(title|desc|both)?:([^:]*):(.*)$/.exec(pv);
  if (/^\d+$/.test(pv)) openId(pv);
  else if (fm) {
    const it = byPath(fm[3]);
    let target = "";
    try { target = decodeURIComponent(fm[2]); } catch { target = ""; }
    if (it) openEditor(it, { fix: edit ? fm[1] || "both" : "", target }); else notFound();
  }
  else if (pv.startsWith("path:")) { const it = byPath(pv.slice(5)); if (it) openEditor(it); else notFound(); }
}