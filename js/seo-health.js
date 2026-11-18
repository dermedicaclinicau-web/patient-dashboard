// seo-health.js — SEO Phase 3: the Site health tab, and speed + issues in the page panel.
// Reads seo_state/health, seo_health (current build) and seo_issues (what staff have ignored).

import { db, auth } from "./firebase-config.js";
import { contentHtml, contentClick, recheckPages, altBody, fixApi, fixErr, askConfirm, injectCss as fxCss } from "./seo-content.js";
import {
  doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SEV = {
  high: { label: "High", tone: "red", rank: 0 },
  medium: { label: "Medium", tone: "amber", rank: 1 },
  low: { label: "Low", tone: "grey", rank: 2 },
};
const GROUPS = { speed: "Speed", index: "Indexing", content: "Titles & content", links: "Links", images: "Images", wording: "Advertising wording" };
const LOG_TYPE = { speed: "Technical", index: "Technical", links: "Links", images: "Content", content: "Title / meta", wording: "Content" };
const HELP = {
  fetch: "Check the page opens in a browser. If it does, the website may be blocking automated checks.",
  blocked: "Ask whoever looks after the website to allow requests from Google's servers (Google Apps Script), or turn off bot blocking for these pages.",
  status: "Fix the page. If it's gone on purpose, remove it from Key pages and redirect the old address to the best page.",
  redirect: "Change the key page in Settings to the address it ends up at, and point menus and links straight there.",
  noindex: "Turn off 'noindex' in the page's SEO settings (in Yoast: Advanced → Allow search engines to show this page). Only leave it on pages that should stay out of Google.",
  no_canonical: "Set a canonical tag that points to the page itself. SEO plugins like Yoast do this automatically.",
  canonical: "The canonical should normally point to the page itself. When it points elsewhere, Google may ignore this page.",
  no_title: "Add a title that says what the page is about, e.g. 'Melasma Treatment Perth | Dermedica'.",
  title_long: "Keep titles to about 60 characters so Google doesn't cut them off. Put the most important words first.",
  title_short: "Make the title more descriptive: the treatment, the place and the clinic name.",
  dup_title: "Give each page its own title, so Google knows which page to show for which search.",
  no_desc: "Add a meta description of 120–155 characters that sums up the page and gives a reason to click.",
  desc_long: "Trim the description to about 155 characters so it isn't cut off.",
  desc_short: "Expand the description to 120–155 characters.",
  dup_desc: "Write a different description for each page.",
  no_h1: "Give the page one main heading (H1) that says what it's about.",
  many_h1: "Keep one H1 for the main heading and change the others to H2 or H3.",
  alt: "Add short alt text describing each image. It helps Google Images and people using screen readers. Decorative images can have empty alt text.",
  broken_link: "Fix or remove the link, or redirect the missing address to the right page.",
  redirect_links: "Update these links to point straight at the final address.",
  wording: "Reword this. Prescription medicine names can't be used in advertising to the public, and AHPRA's guidelines don't allow wording that promises results or downplays risk. Check with your compliance adviser if unsure.",
  cwv_lcp: "Usually the main image or banner is too big. Compress it, use WebP, and make sure the top image isn't lazy-loaded.",
  cwv_inp: "Too much JavaScript is running. Remove unused plugins, sliders and chat widgets, or load them later.",
  cwv_cls: "Give images, embeds and banners a fixed size so the page doesn't shift while they load.",
  score: "Open the page in pagespeed.web.dev to see the biggest problems. Large images and too many plugins are the usual causes.",
  g_not_indexed: "Open the page in URL Inspection (the Inspect link) and press Request indexing. 'Crawled – currently not indexed' means Google saw it but didn't think it was worth adding: make it more useful and clearly different from your other pages, and link to it from the menu or related pages. 'Discovered – currently not indexed' or 'URL is unknown' means Google hasn't visited yet: make sure it's in the sitemap and linked from other pages.",
  g_blocked: "Something tells Google not to index this page. Turn off 'noindex' in the page's SEO settings (in Yoast: Advanced → Allow search engines to show this page).",
  g_robots: "robots.txt stops Google visiting this page. Open dermedica.com.au/robots.txt and remove the Disallow line that matches it (in Yoast: Tools → File editor).",
  g_fetch: "Google couldn't load the page the last time it tried. Check it opens, isn't password protected and doesn't redirect in a loop, then Request indexing.",
  g_canonical: "Google treats a different address as the main version, so this one won't show in search. Make the canonical tag, menu links and sitemap all use the same address, and redirect the other version to it.",
  g_stale: "Google hasn't visited for a while. Link to the page from the home page or menu, update it, and Request indexing in URL Inspection.",
  g_sitemap_missing: "Add the page to the sitemap. Yoast and Rank Math do this automatically unless the page is set to noindex or excluded in their settings.",
  g_rich: "Fix the structured data (schema). Test the page at search.google.com/test/rich-results to see exactly what's wrong.",
  g_error: "Google's URL Inspection didn't answer for this page. It's checked again tomorrow.",
  sm_none: "Submit your sitemap in Search Console → Sitemaps. With Yoast it's usually https://dermedica.com.au/sitemap_index.xml.",
  sm_errors: "Open Search Console → Sitemaps and click the sitemap to see the problems.",
  sm_stale: "Google hasn't read the sitemap recently. Resubmit it in Search Console → Sitemaps.",
  sm_pages_out: "These pages are in the sitemap but not in Google. Check each in the In Google view: improve thin or duplicate pages, and take pages nobody should find (tags, old offers, test pages) out of the sitemap.",
  sm_clicks_missing: "These pages get clicks but aren't in the sitemap. Add them. If they're old addresses, redirect them to the current page.",
};
const LIMITS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] };

// Bounce rate (Seo12.gs): [sessions, engaged, seconds, …] → 0–1
const bRate = (a) => (a && a[0] ? 1 - a[1] / a[0] : null);
const pctB = (r) => (r == null ? "—" : Math.round(r * 100) + "%");
const durB = (s) => (s == null || !isFinite(s) ? "—" : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`);
const chipB = (r, n) => (r == null || n < 10 ? '<span class="seo-note">—</span>'
  : `<span class="seo-bnc is-${r <= 0.45 ? "good" : r <= 0.65 ? "ok" : "high"}"${n < 20 ? ' title="Fewer than 20 visits: not much to go on"' : ""}>${pctB(r)}</span>`);

// Fix it (SEO → Website): the issues it can write a suggestion for
const FIX = { no_title: "title", title_long: "title", title_short: "title", dup_title: "title",
  no_desc: "desc", desc_long: "desc", desc_short: "desc", dup_desc: "desc" };
const fixBtn = (path, what, target = "") =>
  `<button class="seo-btn" type="button" data-wsfix="${esc(`${path}|${what}|${target}`)}" title="Open the page's SEO settings">Open in the Website tab</button>`;

// One-click fixes on the Issues tab: state per issue while the page is open { opts, pick, text, now, items, h1, busy, err }
const HX = new Map();
const META = { no_title: "title", title_long: "title", title_short: "title", dup_title: "title",
  no_desc: "desc", desc_long: "desc", desc_short: "desc", dup_desc: "desc" };
const LIM = { title: [30, 60], desc: [120, 155] };
const spinH = '<span class="seo-fx-spin" aria-hidden="true"></span>';
// 🧭 Fix with the Advisor: which problems, and the question it starts with
const ADVK = { cwv_lcp: "speed", cwv_inp: "speed", cwv_cls: "speed", score: "speed", noindex: "index", canonical: "index", no_canonical: "index",
  g_not_indexed: "index", g_blocked: "index", g_fetch: "index", g_canonical: "index", g_stale: "index", g_robots: "index" };
const ADVQ = {
  speed: (p) => `The page ${p} is slow on phones. What's slowing it down, and what exactly should we change to make it faster?`,
  bounce: (p) => `Too many visitors from Google leave ${p} straight away. Why, and what should we change at the top of the page, in the title and in the description so it matches what they searched for?`,
  index: (p) => `Google isn't showing ${p} properly in search. What's the cause, and what should we change to fix it?`,
  page: (p) => `What should we fix first on ${p} to get more people from Google to book, and exactly how?`,
};
const advBtn = (path, kind, show) => (show
  ? `<button class="seo-btn seo-h-adv" type="button" data-h-adv="${esc(path)}|${kind}" title="Opens the Advisor with this page and problem filled in">🧭 Fix with the Advisor</button>` : "");

// Priority pages (seo_settings/main.keyPages). Read here so this file doesn't import seo-work.js.
const normP = (s) => String(s || "").split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase() || "/";
function priOf(c) {
  const s = c.work?.settings || {};
  const set = new Set((Array.isArray(s.keyPages) ? s.keyPages : []).map(normP));
  return (path) => (set.has(normP(path)) ? 1 : 0);
}
const starMark = (on) => (on ? `<span class="seo-star is-on" title="Priority page">★</span>` : "");

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const uid = () => auth.currentUser?.uid || "";
const myName = (c) => c.staff?.name || c.staff?.displayName || auth.currentUser?.displayName || "";
const tsDate = (t) => (t?.toDate ? t.toDate() : t ? new Date(t) : null);
const errText = (m) => (/permission/i.test(String(m)) ? "You don't have permission to do that." : String(m));
const when = (t) => {
  const d = tsDate(t);
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
};
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const issueId = (path, key) => "i_" + hash(path + "|" + key) + hash("#" + key + path);

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}

const rate = (k, v) => {
  if (v == null) return "";
  if (k === "score") return v >= 90 ? "good" : v >= 50 ? "ni" : "poor";
  return v <= LIMITS[k][0] ? "good" : v <= LIMITS[k][1] ? "ni" : "poor";
};
const fmtM = { lcp: (v) => (v / 1000).toFixed(1) + " s", inp: (v) => Math.round(v) + " ms", cls: (v) => Number(v).toFixed(2), score: (v) => String(v) };
const val = (k, v) => (v == null ? "—" : `<span class="seo-h-${rate(k, v)}">${fmtM[k](v)}</span>`);

// What to show for a page: real-visitor data for the page if Google has it, otherwise its lab test
function metricsOf(sp) {
  if (!sp) return null;
  const f = sp.field && sp.field.src === "page" ? sp.field : null;
  return {
    score: sp.score ?? null,
    lcp: f?.lcp?.v ?? sp.lab?.lcp ?? null,
    inp: f?.inp?.v ?? null,
    cls: f?.cls?.v ?? sp.lab?.cls ?? null,
    from: f ? "Real visitors" : "Google's test",
    pass: f ? ["lcp", "inp", "cls"].every((k) => !f[k] || f[k].c === "FAST") : null,
  };
}

/* ---------- Google indexing (Seo5.gs → seo_index/main) ---------- */

const STATE = {
  BLOCKED_BY_META_TAG: "a noindex tag", BLOCKED_BY_HTTP_HEADER: "a noindex header", BLOCKED_BY_ROBOTS_TXT: "robots.txt",
  NOT_FOUND: "Not found (404)", SOFT_404: "Looks like an empty or error page (soft 404)", ACCESS_DENIED: "Access denied (401)",
  ACCESS_FORBIDDEN: "Forbidden (403)", SERVER_ERROR: "Server error (5xx)", REDIRECT_ERROR: "Redirect error",
  BLOCKED_ROBOTS_TXT: "Blocked by robots.txt", INVALID_URL: "Invalid address", BLOCKED_4XX: "Another 4xx error",
  INTERNAL_CRAWL_ERROR: "Google had an internal error",
};
const stateText = (s) => STATE[s] || String(s || "").toLowerCase().replace(/_/g, " ");
const normU = (u) => String(u || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/#.*$/, "").replace(/\/+$/, "");
const shortU = (u) => String(u || "").replace(/^https?:\/\/[^/]+/i, "") || "/";
const daysSince = (iso) => { const t = Date.parse(iso || ""); return t ? Math.max(0, Math.floor((Date.now() - t) / 864e5)) : null; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function googleIssues(r, inSitemap) {
  const out = [];
  const add = (sev, code, msg, detail, key) => out.push({ group: "index", sev, code, msg, detail: detail || "", key: key || code });
  if (!r) return out;
  if (r.err) { add("low", "g_error", "Google's URL Inspection didn't answer", r.err); return out; }
  if (r.rb === "DISALLOWED") add("high", "g_robots", "Google is blocked by robots.txt");
  if (/^BLOCKED/.test(r.is || "")) add("high", "g_blocked", "Google is told not to index it", "Set by " + stateText(r.is));
  if (r.pf && !/^(SUCCESSFUL|PAGE_FETCH_STATE_UNSPECIFIED)$/.test(r.pf)) add("high", "g_fetch", "Google couldn't load it last time", stateText(r.pf));
  if (r.v !== "PASS") add("high", "g_not_indexed", "Not in Google", r.cs || "Unknown to Google");
  else if (r.gc && r.uc && normU(r.gc) !== normU(r.uc)) add("medium", "g_canonical", "Google chose a different main version", "Google uses " + r.gc);
  const d = daysSince(r.lc);
  if (d != null && d > 60) add("low", "g_stale", `Google last visited ${d} days ago`);
  if (inSitemap === false) add("low", "g_sitemap_missing", "Not in the sitemap");
  for (const x of r.rr || []) if (x.e) add("medium", "g_rich", `Structured data error: ${x.t}`, x.m, "g_rich:" + x.t);
  return out;
}

function attachIndex(out) {
  const X = out.index?.data;
  if (!X) return;
  const missing = new Set(X.keyNotInSitemap || []);
  for (const p of out.pages) {
    p.google = X.key?.[p.path] || null;
    p.issues = (p.issues || []).concat(googleIssues(p.google, X.sitemapUrls ? !missing.has(p.path) : null));
  }
  const site = [];
  const add = (sev, code, msg, detail, key) => site.push({ group: "index", sev, code, msg, detail: detail || "", key: key || code });
  if (!X.sitemaps?.length) {
    add("medium", "sm_none", X.sitemapUrls ? "Sitemap not submitted to Search Console" : "No sitemap found",
      X.sitemapUrls ? `One was ${X.sitemapSource || "found"} with ${X.sitemapUrls} pages, but Search Console doesn't have it.` : "None in Search Console, robots.txt or the usual addresses.");
  }
  for (const s of X.sitemaps || []) {
    if (s.errors) add("high", "sm_errors", `Sitemap has ${plural(s.errors, "error")}`, s.path, "sm_errors:" + s.path);
    if (s.warnings) add("low", "sm_errors", `Sitemap has ${plural(s.warnings, "warning")}`, s.path, "sm_warn:" + s.path);
    const d = daysSince(s.downloaded);
    if (d != null && d > 14) add("low", "sm_stale", `Google last read the sitemap ${d} days ago`, s.path, "sm_stale:" + s.path);
  }
  const outOf = Object.entries(X.others || {}).filter(([, r]) => r && !r.err && r.v && r.v !== "PASS");
  if (outOf.length) {
    add("medium", "sm_pages_out", `${plural(outOf.length, "sitemap page")} ${outOf.length === 1 ? "isn't" : "aren't"} in Google`,
      outOf.slice(0, 8).map(([p, r]) => `${p} (${r.cs || "unknown"})`).join(" · ") + (outOf.length > 8 ? ` and ${outOf.length - 8} more` : ""));
  }
  if (X.notInSitemap?.length) {
    add("low", "sm_clicks_missing", `${plural(X.notInSitemap.length, "page")} with clicks ${X.notInSitemap.length === 1 ? "isn't" : "aren't"} in the sitemap`,
      X.notInSitemap.slice(0, 8).map(([p]) => p).join(", "));
  }
  out.site = { path: "Whole site", url: "https://search.google.com/search-console", issues: site };
}

/* ---------- data ---------- */

export async function loadHealth() {
  injectCss();
  const out = { state: null, pages: [], status: {} };
  const s = await getDoc(doc(db, "seo_state", "health"));
  if (!s.exists()) return out;
  out.state = s.data();
  const jobs = [
    getDocs(collection(db, "seo_issues"))
      .then((snap) => snap.docs.forEach((d) => { out.status[d.id] = d.data(); }))
      .catch((e) => console.warn("SEO issue statuses not read:", e)),
    getDoc(doc(db, "seo_state", "content")).then(async (x) => {   // Site health → Content (Seo9.gs)
      if (!x.exists()) return;
      const [dp, du, cs] = await Promise.all([getDoc(doc(db, "seo_content", "deep")), getDoc(doc(db, "seo_content", "dups")),
        getDoc(doc(db, "seo_content", "consist"))]);
      const j = (d, def) => { try { return d.exists() && d.data().json ? JSON.parse(d.data().json) : def; } catch { return def; } };
      out.content = { state: x.data(), deep: j(dp, {}), dups: j(du, []), consist: j(cs, []) };
    }).catch((e) => console.warn("SEO content checks not read:", e)),
    getDoc(doc(db, "seo_index", "main")).then((x) => {
      if (!x.exists()) return;
      const d = x.data();
      out.index = { state: d, data: null };
      try { out.index.data = d.json ? JSON.parse(d.json) : null; } catch { /* unreadable: shown as not checked */ }
    }).catch((e) => console.warn("SEO index not read:", e)),
  ];
  if (out.state.build) {
    jobs.push(getDocs(query(collection(db, "seo_health"), where("build", "==", out.state.build)))
      .then((snap) => { out.pages = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }));
  }
  await Promise.all(jobs);
  attachIndex(out);
  for (const p of out.pages.concat(out.site ? [out.site] : [])) {
    for (const i of p.issues || []) {
      i.path = p.path;
      i.url = p.url;
      i.id = issueId(p.path, i.key);
      i.st = out.status[i.id] || null;
      i.status = i.st?.status === "ignored" ? "ignored" : "open";
    }
  }
  return out;
}

async function setStatus(c, i, status, note) {
  const d = {
    key: i.key, label: (i.msg + (i.detail ? " · " + i.detail : "")).slice(0, 300), path: i.path,
    status, note: String(note || "").slice(0, 1000), by: uid(), byName: myName(c), at: serverTimestamp(),
  };
  await setDoc(doc(db, "seo_issues", i.id), d);
  i.st = { ...d, at: new Date() };
  i.status = status === "ignored" ? "ignored" : "open";
  c.work.health.status[i.id] = i.st;
}

/* ---------- the page panel (seo-work.js → pagePanelExtras) ---------- */

export function healthPanelHtml(H, p) {
  if (!H || !H.state) return "";
  const k = H.pages.find((x) => x.path === p.path);
  if (!k) return `<p class="seo-note" style="margin-top:14px">Site health checks priority pages only. Star this page (☆, admins) to check its speed, titles, links and wording every night.</p>`;
  const m = metricsOf(k.speed);
  const open = (k.issues || []).filter((i) => i.status === "open").sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank);
  const g = k.google;
  const gLine = g && !g.err ? `<p class="seo-note">In Google: ${g.v === "PASS" ? '<span class="seo-h-good">yes</span>' : '<span class="seo-h-poor">no</span>'}${g.cs ? " · " + esc(g.cs) : ""}${g.lc ? " · Google last visited " + daysSince(g.lc) + " days ago" : ""}${g.link ? ` · <a class="seo-w-link" href="${esc(g.link)}" target="_blank" rel="noopener">Inspect ↗</a>` : ""}</p>` : "";
  return `<h3>Site health</h3>${gLine}
    ${m ? `<p class="seo-note">Mobile score ${val("score", m.score)} · LCP ${val("lcp", m.lcp)} · INP ${val("inp", m.inp)} · CLS ${val("cls", m.cls)} · ${esc(m.from)}</p>`
      : `<p class="seo-note">Speed not checked yet.</p>`}
    ${open.length
      ? `<ul class="seo-h-plist">${open.map((i) => `<li><span class="seo-w-pill is-${SEV[i.sev].tone}">${SEV[i.sev].label}</span> ${esc(i.msg)}</li>`).join("")}</ul>`
      : `<p class="seo-note">No open issues.</p>`}
    <p><a class="seo-w-link" href="#/seo/health">Open Site health</a></p>`;
}

/* ---------- the tab ---------- */

export function viewHealth(wrap, c, ui) {
  const H = c.work.health;
  if (!H || !H.state) {
    const err = c.work.errors?.health;
    wrap.innerHTML = `<div class="seo-empty">${err ? esc(errText(err))
      : "No site health data yet. In Apps Script, run <code>runSeoHealth()</code> once (it takes a few minutes), then <code>installSeoHealthTrigger()</code>."}</div>`;
    return;
  }
  if (!ui.hview) Object.assign(ui, { hview: "content", hsev: "all", hgroup: "all", hstatus: "open" });
  if (ui.hkpi === undefined) Object.assign(ui, { hkpi: "", hkx: "", hpage: "" });   // the number card that's open, its open row, Issues for one page
  fxCss();   // the Accept / overlay styles, also when Issues is opened first
  const canWork = c.can("seo.work");
  const isPri = priOf(c);
  let byId = new Map();
  // A page's engagement from SEO's data (any version of its address)
  const engOf = (path) => {
    const k = normP(path);
    const p = (c.data?.pages || []).find((x) => x.eng && normP(x.path) === k);
    return p ? p.eng : null;
  };
  const highBounce = (e) => !!e && e.c[0] >= 20 && bRate(e.c) > 0.65;

  /* --- Click a number: what's behind it --- */

  // What to try on a page that loses visitors (also used by the Engagement view)
  const tipsOf = (hp, e) => {
    if (!highBounce(e)) return "";
    const out = [];
    const mob = e.m[0] >= 10 ? bRate(e.m) : null, desk = e.d[0] >= 10 ? bRate(e.d) : null;
    const m = metricsOf(hp.speed);
    if (mob != null && desk != null && mob - desk >= 0.1) out.push("Check it on a phone: the top should load fast, with the Book button showing straight away.");
    if (m && m.score != null && m.score < 50) out.push(`It's slow on phones (score ${m.score}): compress the top image.`);
    if (e.c[2] / e.c[0] < 20) out.push("People leave within seconds: make the first screen answer what they searched for.");
    if (hp.words && hp.words < 400) out.push(`Only about ${hp.words} words: add what people want to know (cost, downtime, results).`);
    if (!out.length) out.push("Add a short answer near the top, and links to related treatments, so people read on.");
    return out.slice(0, 2).join(" ");
  };
  const VNAME = { lcp: "Loading (LCP)", inp: "Responding (INP)", cls: "Shifting (CLS)" };
  const CODE_L = {
    fetch: "Page couldn't be read", blocked: "Website blocks the check", status: "Page returns an error", redirect: "Priority page redirects",
    noindex: "Hidden from Google (noindex)", no_canonical: "No canonical tag", canonical: "Canonical points elsewhere",
    no_title: "No title", title_long: "Title too long", title_short: "Title too short", dup_title: "Same title as another page",
    no_desc: "No meta description", desc_long: "Meta description too long", desc_short: "Meta description too short", dup_desc: "Same description as another page",
    no_h1: "No main heading (H1)", many_h1: "More than one main heading", alt: "Images without alt text",
    broken_link: "Broken links", redirect_links: "Links that redirect", wording: "Advertising wording",
    cwv_lcp: "Slow to load (LCP)", cwv_inp: "Slow to respond (INP)", cwv_cls: "Page shifts while loading (CLS)", score: "Low mobile score",
    g_not_indexed: "Not in Google", g_blocked: "Google told not to index it", g_robots: "Blocked by robots.txt", g_fetch: "Google couldn't load it",
    g_canonical: "Google chose a different main version", g_stale: "Google hasn't visited lately", g_sitemap_missing: "Not in the sitemap",
    g_rich: "Structured data errors", g_error: "URL Inspection didn't answer",
    sm_none: "No sitemap in Search Console", sm_errors: "Sitemap errors", sm_stale: "Sitemap not read lately",
    sm_pages_out: "Sitemap pages not in Google", sm_clicks_missing: "Pages with clicks missing from the sitemap",
  };
  const fixable = (code) => !!META[code] || ["redirect_links", "broken_link", "many_h1", "alt"].includes(code);
  const fieldOf = (sp) => (sp && sp.field && sp.field.src === "page" ? sp.field : null);
  const openOf = (all, path) => all.filter((i) => i.status === "open" && i.path === path);
  const pageLink = (path) => {
    if (path === "Whole site") return "<b>Whole site</b>";
    const pg = c.byPath.get(path);
    return starMark(isPri(path)) + (pg ? `<button class="seo-w-link" type="button" data-open="${pg.id}">${esc(path)}</button>` : esc(path));
  };
  const openBtn = (path) => { const pg = c.byPath.get(path); return pg ? `<button class="seo-btn" type="button" data-open="${pg.id}">Open page details</button>` : ""; };
  const goBtn = (label, o) => `<button class="seo-btn" type="button" data-hk-go="${esc(JSON.stringify(o))}">${esc(label)} →</button>`;
  const psBtn = (url) => (url ? `<a class="seo-btn" href="https://pagespeed.web.dev/report?url=${encodeURIComponent(url)}&form_factor=mobile" target="_blank" rel="noopener">Test it on PageSpeed ↗</a>` : "");
  const hkActs = (btns) => `<div class="seo-hk-acts">${btns.filter(Boolean).join("")}</div>`;
  const hkStats = (pairs) => `<div class="seo-hk-stats">${pairs.filter(Boolean).map(([l, v]) => `<div><small>${l}</small>${v}</div>`).join("")}</div>`;
  const hkTable = (head, rows) => `<div class="seo-table-wrap" style="max-height:none"><table class="seo-table seo-hk-t"><thead><tr>${
    head.map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const hkRow = (k, cells, detail) => {
    const on = ui.hkx === k;
    return `<tr class="seo-hk-r${on ? " is-open" : ""}" data-hk-x="${esc(k)}" tabindex="0" aria-expanded="${on}">${
      cells.map((x, n) => `<td>${n === 0 ? `<i class="seo-hk-car">${on ? "▾" : "▸"}</i>` : ""}${x}</td>`).join("")}</tr>${
      on ? `<tr class="seo-hk-xr"><td colspan="${cells.length}">${detail()}</td></tr>` : ""}`;
  };
  const split = (parts) => {
    const shown = parts.filter((p) => p.n);
    if (!shown.length) return "";
    return `<div class="seo-hk-split" role="img" aria-label="${esc(shown.map((p) => `${p.label}: ${p.n}`).join(", "))}">${
      shown.map((p) => `<i class="is-${p.tone}" style="flex:${p.n}" title="${esc(p.label)}: ${p.n}"></i>`).join("")}</div>
      <div class="seo-hk-legend">${shown.map((p) => `<span><i class="is-${p.tone}"></i>${esc(p.label)} <b>${p.n}</b></span>`).join("")}</div>`;
  };
  const bars = (items) => {
    if (!items.length) return "";
    const max = Math.max(1, ...items.map((x) => x.n));
    return `<div class="seo-hk-bars">${items.map((x) => `<div class="seo-hk-bar"><span>${esc(x.label)}</span><b><i style="width:${
      Math.round((x.n / max) * 100)}%"></i></b><em>${x.n}</em></div>`).join("")}</div>`;
  };
  const sevPills = (list) => {
    const parts = ["high", "medium", "low"].map((s) => [s, list.filter((i) => i.sev === s).length]).filter((x) => x[1]);
    return parts.length ? parts.map(([s, n]) => `<span class="seo-w-pill is-${SEV[s].tone}" title="${SEV[s].label}">${n} ${SEV[s].label.toLowerCase()}</span>`).join(" ")
      : `<span class="seo-h-good">✓ None</span>`;
  };
  const issueList = (list, max = 8) => (list.length
    ? `<ul class="seo-hk-il">${list.slice().sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank).slice(0, max).map((i) =>
      `<li><span class="seo-w-pill is-${SEV[i.sev].tone}">${SEV[i.sev].label}</span> ${esc(i.msg)}${
        i.detail ? ` <span class="seo-note">· ${esc(String(i.detail).slice(0, 120))}</span>` : ""}${
        fixable(i.code) ? ` <span class="seo-hk-one" title="Fix it in one click on the Issues tab">✨ one click</span>` : ""}</li>`).join("")}</ul>${
      list.length > max ? `<p class="seo-note">and ${list.length - max} more</p>` : ""}`
    : `<p class="seo-h-good" style="margin:4px 0">No open issues. 👍</p>`);
  const helpBox = (code) => (HELP[code] ? `<div class="seo-hk-help"><b>How to fix</b><p>${esc(HELP[code])}</p></div>` : "");
  const gCell = (g) => (!g ? `<span class="seo-note">—</span>` : g.err ? `<span class="seo-note">Not answered</span>`
    : g.v === "PASS" ? `<span class="seo-h-good">✓ Yes</span>` : `<span class="seo-h-poor">✗ No</span>`);
  const hkCard = (key, o) => `<div class="seo-card seo-hk">
    <div class="seo-hk-head"><div><h3>${o.title}</h3>${o.sub ? `<div class="seo-note">${o.sub}</div>` : ""}</div><span class="seo-sp"></span>
      <button class="seo-btn" type="button" data-h-kpi="${key}">✕ Close</button></div>
    ${o.sum ? `<p class="seo-hk-sum">${o.sum}</p>` : ""}${o.viz || ""}${o.body || ""}
    ${o.note ? `<p class="seo-note" style="margin:8px 0 0">${o.note}</p>` : ""}
    ${o.tip ? `<div class="seo-hk-tip">💡 ${o.tip}</div>` : ""}
    ${o.body && o.body.indexOf("data-hk-x") !== -1 ? `<p class="seo-note" style="margin:8px 0 0">Click a row to see more.</p>` : ""}
  </div>`;

  function pagesCard(all) {
    const rows = H.pages.map((p) => {
      const iss = openOf(all, p.path), m = metricsOf(p.speed), g = p.google, e = engOf(p.path);
      const out = !!(g && !g.err && g.v !== "PASS");
      const bad = iss.reduce((a, i) => a + (i.sev === "high" ? 100 : i.sev === "medium" ? 10 : 1), 0) + (out ? 100 : 0) + (m?.score != null && m.score < 50 ? 30 : 0);
      return { p, iss, m, g, e, bad };
    }).sort((a, b) => b.bad - a.bad || a.p.path.localeCompare(b.p.path));
    const clean = rows.filter((x) => !x.iss.length).length;
    const hi = rows.filter((x) => x.iss.some((i) => i.sev === "high")).length;
    const worst = rows.find((x) => x.bad > 0);
    const sum = `${plural(rows.length, "priority page")} checked${H.state.at ? ` (${esc(when(H.state.at))})` : ""}. ${
      clean ? `<b>${clean}</b> ${clean === 1 ? "has" : "have"} no open issues` : "Every page has something to fix"}${
      hi ? `, <b class="seo-h-poor">${hi}</b> ${hi === 1 ? "has" : "have"} a high issue` : ""}.${worst ? ` Start with ${pageLink(worst.p.path)}.` : ""}`;
    const body = hkTable(["Page", "Open issues", "Mobile score", "In Google", "Bounce"], rows.map(({ p, iss, m, g, e }) => hkRow("p:" + p.path, [
      pageLink(p.path), sevPills(iss), m ? val("score", m.score) : `<span class="seo-note">—</span>`, gCell(g),
      e && e.c[0] ? chipB(bRate(e.c), e.c[0]) : `<span class="seo-note">—</span>`,
    ], () => issueList(iss) + hkActs([openBtn(p.path), iss.length ? goBtn("See its issues", { view: "issues", page: p.path }) : "", advBtn(p.path, "page", true)]))));
    return hkCard("pages", { title: "Priority pages: how each one is doing", sub: "Most to fix first", sum,
      viz: split([{ n: clean, tone: "green", label: "No open issues" }, { n: rows.length - clean - hi, tone: "amber", label: "Medium or low only" },
        { n: hi, tone: "red", label: "Has a high issue" }]),
      body, tip: "Site health checks priority pages every night. A fixed issue drops off at the next check (about 8am)." });
  }

  function sevCard(all, sev) {
    const S = SEV[sev];
    const list = all.filter((i) => i.status === "open" && i.sev === sev);
    const by = new Map();
    list.forEach((i) => {
      const g = by.get(i.code) || { code: i.code, group: i.group, label: CODE_L[i.code] || i.msg, items: [] };
      g.items.push(i);
      by.set(i.code, g);
    });
    const groups = [...by.values()].map((g) => ({ ...g, pages: new Set(g.items.map((i) => i.path)).size }))
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
    const pages = new Set(list.map((i) => i.path)).size;
    const quick = list.filter((i) => fixable(i.code) && i.path !== "Whole site").length;
    const types = {};
    list.forEach((i) => { types[i.group] = (types[i.group] || 0) + 1; });
    const sum = list.length
      ? `<b>${list.length}</b> open ${S.label.toLowerCase()} issue${list.length === 1 ? "" : "s"} on ${plural(pages, "page")}. Most common: <b>${esc(groups[0].label)}</b> (${groups[0].items.length}).${
        quick ? ` <span class="seo-hk-one">✨ ${quick} can be fixed in one click</span>` : ""}`
      : `No open ${S.label.toLowerCase()} issues. 👍`;
    const body = groups.length ? hkTable(["Problem", "Type", "Pages", "Fix"], groups.map((g) => hkRow("c:" + g.code, [
      `<b>${esc(g.label)}</b>`, `<span class="seo-note">${esc(GROUPS[g.group] || g.group)}</span>`, String(g.pages),
      fixable(g.code) ? `<span class="seo-hk-one">✨ One click</span>` : HELP[g.code] ? `<span class="seo-note">How-to</span>` : "—",
    ], () => `<ul class="seo-hk-il">${g.items.slice(0, 12).map((i) => `<li>${pageLink(i.path)}${
      i.detail ? ` <span class="seo-note">· ${esc(String(i.detail).slice(0, 140))}</span>` : ""}</li>`).join("")}</ul>${
      g.items.length > 12 ? `<p class="seo-note">and ${g.items.length - 12} more</p>` : ""}${helpBox(g.code)}${
      hkActs([goBtn(fixable(g.code) ? "Fix them in Issues" : "See them in Issues", { view: "issues", sev, group: g.group })])}`))) : "";
    return hkCard(sev, { title: `${S.label} issues: what they are`, sub: "Open issues on priority pages, grouped by problem", sum,
      viz: list.length ? bars(Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: GROUPS[k] || k, n }))) : "",
      body, tip: { high: "Fix these first: they can stop a page showing in Google or put people off booking.",
        medium: "Worth doing this week: they hold pages back in Google.",
        low: "Small wins. Do them when you're working on the page anyway." }[sev] });
  }

  function scoreCard() {
    const rows = H.pages.map((p) => ({ p, m: metricsOf(p.speed) })).sort((a, b) => (a.m?.score ?? 999) - (b.m?.score ?? 999));
    const sc = rows.filter((x) => x.m && x.m.score != null);
    const count = (f) => sc.filter((x) => f(x.m.score)).length;
    const good = count((s) => s >= 90), ni = count((s) => s >= 50 && s < 90), poor = count((s) => s < 50);
    const avg = sc.length ? Math.round(sc.reduce((a, x) => a + x.m.score, 0) / sc.length) : null;
    const worst = sc[0];
    const sum = avg == null ? "No pages have been speed-tested yet."
      : `Average <b>${val("score", avg)}</b> out of 100 on phones. ${good ? `${good} fast` : "None fast"}${ni ? `, ${ni} need work` : ""}${
        poor ? `, <b class="seo-h-poor">${poor} slow</b>` : ""}.${worst && worst.m.score < 90 ? ` Slowest: ${pageLink(worst.p.path)} (${worst.m.score}).` : ""}`;
    const body = hkTable(["Page", "Score", VNAME.lcp, VNAME.cls, VNAME.inp, "Trend", "Measured from"], rows.map(({ p, m }) => {
      const hist = (p.history || []).map((r) => r.s).filter((v) => v != null);
      if (!m) {
        return hkRow("s:" + p.path, [pageLink(p.path), `<span class="seo-note">${esc(p.speedError || "Not tested yet")}</span>`, "", "", "", "", ""],
          () => `<p class="seo-note">${esc(p.speedError || "Speed is tested three times a day. It shows here after the next test.")}</p>${hkActs([psBtn(p.url), openBtn(p.path)])}`);
      }
      return hkRow("s:" + p.path, [pageLink(p.path), val("score", m.score), val("lcp", m.lcp), val("cls", m.cls), val("inp", m.inp),
        hist.length > 1 ? c.h.sparkline(hist, 80, 20) : "", `<span class="seo-note">${esc(m.from)}</span>`], () => {
        const why = ["lcp", "inp", "cls"].filter((k) => m[k] != null && rate(k, m[k]) !== "good").map((k) =>
          `<li><b>${VNAME[k]}: ${fmtM[k](m[k])}</b> <span class="seo-note">(${rate(k, m[k]) === "poor" ? "slow" : "needs work"})</span><br>${esc(HELP["cwv_" + k])}</li>`);
        if (!why.length && m.score != null && m.score < 90) why.push(`<li>${esc(HELP.score)}</li>`);
        return hkStats([["Mobile score", val("score", m.score)], [VNAME.lcp, val("lcp", m.lcp)], [VNAME.inp, val("inp", m.inp)], [VNAME.cls, val("cls", m.cls)],
          ["Measured from", esc(m.from)], ["Tested", p.speedAt ? esc(when(p.speedAt)) : "—"],
          hist.length > 1 ? ["Lowest / highest kept", `${Math.min(...hist)} / ${Math.max(...hist)}`] : null])
          + (why.length ? `<div class="seo-hk-h">What's holding it back</div><ul class="seo-hk-why">${why.join("")}</ul>`
            : `<p class="seo-h-good" style="margin:4px 0">Fast on phones. Nothing to do here. 👍</p>`)
          + hkActs([psBtn(p.url), advBtn(p.path, "speed", why.length > 0), openBtn(p.path)]);
      });
    }));
    return hkCard("score", { title: "Mobile speed: page by page", sub: "Google PageSpeed Insights on a phone, slowest first", sum,
      viz: split([{ n: good, tone: "green", label: "Fast (90+)" }, { n: ni, tone: "amber", label: "Needs work (50–89)" },
        { n: poor, tone: "red", label: "Slow (under 50)" }, { n: rows.length - sc.length, tone: "grey", label: "Not tested" }]),
      body, tip: "Loading (LCP) matters most, to visitors and to Google. It's nearly always the big image at the top: compress it, and don't lazy-load it." });
  }

  function googleCard(all) {
    if (!H.index?.data) {
      return hkCard("google", { title: "Priority pages in Google", body: `<p class="seo-note">No indexing data yet. In Apps Script, run <code>runSeoIndex()</code> once.</p>` });
    }
    const X = H.index.data, missing = new Set(X.keyNotInSitemap || []);
    const day = (iso) => { const d = daysSince(iso); return d == null ? "—" : d === 0 ? "today" : d + " days ago"; };
    const rows = H.pages.map((p) => {
      const g = p.google, diff = !!(g && g.gc && g.uc && normU(g.gc) !== normU(g.uc));
      const rank = !g ? 4 : g.err ? 3 : g.v !== "PASS" ? 0 : diff ? 1 : (daysSince(g.lc) || 0) > 60 ? 2 : 2.5;
      return { p, g, diff, rank };
    }).sort((a, b) => a.rank - b.rank || a.p.path.localeCompare(b.p.path));
    const chk = rows.filter((x) => x.g && !x.g.err), yes = chk.filter((x) => x.g.v === "PASS"), no = chk.filter((x) => x.g.v !== "PASS");
    const other = yes.filter((x) => x.diff).length;
    const sum = chk.length
      ? `<b>${yes.length} of ${chk.length}</b> priority pages are in Google.${no.length ? ` Not in Google: ${no.slice(0, 3).map((x) => pageLink(x.p.path)).join(", ")}${
        no.length > 3 ? ` and ${no.length - 3} more` : ""}.` : " 👍"}${other ? ` ${plural(other, "page")} ${other === 1 ? "has" : "have"} a different main version in Google.` : ""}`
      : "Not checked yet.";
    const body = hkTable(["Page", "In Google", "Google says", "Google's last visit", "Main version", "In sitemap"], rows.map(({ p, g, diff }) => hkRow("g:" + p.path, [
      pageLink(p.path), gCell(g), `<span class="seo-note">${esc(g?.err ? g.err : g?.cs || "")}</span>`, g && !g.err ? day(g.lc) : "—",
      diff ? `<span class="seo-h-ni" title="${esc(g.gc)}">${esc(shortU(g.gc))}</span>` : g && !g.err ? `<span class="seo-note">Same</span>` : "—",
      X.sitemapUrls ? (missing.has(p.path) ? `<span class="seo-h-poor">No</span>` : `<span class="seo-h-good">Yes</span>`) : "—",
    ], () => {
      const idx = openOf(all, p.path).filter((i) => i.group === "index").sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank);
      return issueList(idx) + (idx[0] ? helpBox(idx[0].code) : "")
        + hkActs([g?.link ? `<a class="seo-btn" href="${esc(g.link)}" target="_blank" rel="noopener">Inspect in Search Console ↗</a>` : "",
          advBtn(p.path, "index", idx.length > 0), goBtn("Open In Google", { view: "index" })]);
    })));
    return hkCard("google", { title: "Priority pages in Google", sub: "Search Console's URL Inspection, checked each morning. Problems first.", sum,
      viz: split([{ n: yes.length, tone: "green", label: "In Google" }, { n: no.length, tone: "red", label: "Not in Google" },
        { n: rows.length - chk.length, tone: "grey", label: "Not checked" }]),
      body, tip: "After fixing a page, open Inspect and press Request indexing. Google usually visits within a few days." });
  }

  function cwvCard() {
    const rows = H.pages.map((p) => {
      const f = fieldOf(p.speed);
      return { p, f, fails: f ? ["lcp", "inp", "cls"].filter((k) => f[k] && f[k].c && f[k].c !== "FAST") : [] };
    });
    const withF = rows.filter((x) => x.f).sort((a, b) => b.fails.length - a.fails.length || a.p.path.localeCompare(b.p.path));
    const pass = withF.filter((x) => !x.fails.length).length, noData = rows.length - withF.length;
    const failN = { lcp: 0, inp: 0, cls: 0 };
    withF.forEach((x) => x.fails.forEach((k) => { failN[k]++; }));
    const top = Object.entries(failN).sort((a, b) => b[1] - a[1])[0];
    const cell = (f, k) => (f && f[k] ? `<span class="seo-h-${f[k].c === "FAST" ? "good" : f[k].c === "AVERAGE" ? "ni" : "poor"}">${fmtM[k](f[k].v)}</span>` : "—");
    const sum = withF.length
      ? `<b>${pass} of ${withF.length}</b> pages pass with real visitors.${top && top[1] ? ` Most common problem: <b>${VNAME[top[0]]}</b> on ${plural(top[1], "page")}.` : " 👍"}`
      : "None of the priority pages have enough visits from Chrome users yet for real-visitor data.";
    const body = withF.length ? hkTable(["Page", "Result", VNAME.lcp, VNAME.inp, VNAME.cls], withF.map(({ p, f, fails }) => hkRow("w:" + p.path, [
      pageLink(p.path), fails.length ? `<span class="seo-h-poor">✗ ${fails.length} failing</span>` : `<span class="seo-h-good">✓ Pass</span>`,
      cell(f, "lcp"), cell(f, "inp"), cell(f, "cls"),
    ], () => (fails.length
      ? `<ul class="seo-hk-why">${fails.map((k) => `<li><b>${VNAME[k]}: ${fmtM[k](f[k].v)}</b><br>${esc(HELP["cwv_" + k])}</li>`).join("")}</ul>`
      : `<p class="seo-h-good" style="margin:4px 0">All three are good for real visitors. 👍</p>`)
      + hkActs([psBtn(p.url), advBtn(p.path, "speed", fails.length > 0), openBtn(p.path)])))) : "";
    return hkCard("cwv", { title: "Core Web Vitals: real visitors", sub: "Chrome users over the last 28 days. Google uses these in ranking.", sum,
      viz: split([{ n: pass, tone: "green", label: "Pass" }, { n: withF.length - pass, tone: "red", label: "Fail" }, { n: noData, tone: "grey", label: "Not enough visits" }])
        + bars(["lcp", "inp", "cls"].filter((k) => failN[k]).map((k) => ({ label: VNAME[k], n: failN[k] }))),
      body, note: noData ? `${plural(noData, "page")} ${noData === 1 ? "doesn't" : "don't"} have enough real visits yet, so ${
        noData === 1 ? "it's" : "they're"} judged on Google's test instead (Avg mobile score).` : "",
      tip: "These are 28 days of real visits, so a fix takes up to four weeks to show fully here. Google's test (Avg mobile score) shows it the next day." });
  }

  function bounceCard() {
    const E = c.data?.eng;
    if (!E) return hkCard("bounce", { title: "Visitors who leave straight away", body: `<p class="seo-note">No engagement data yet.</p>` });
    const rows = H.pages.map((hp) => ({ hp, e: engOf(hp.path) })).filter((x) => x.e && x.e.c[0])
      .sort((a, b) => (b.e.c[0] >= 20) - (a.e.c[0] >= 20) || bRate(b.e.c) - bRate(a.e.c));
    const judged = rows.filter((x) => x.e.c[0] >= 20);
    const hi = judged.filter((x) => bRate(x.e.c) > 0.65), fair = judged.filter((x) => bRate(x.e.c) > 0.45 && bRate(x.e.c) <= 0.65);
    const s = E.site.c;
    const sum = `${hi.length ? `<b class="seo-h-poor">${hi.length}</b> priority page${hi.length === 1 ? " loses" : "s lose"} more than 65% of Google visitors straight away.`
      : "No priority page loses more than 65% of Google visitors. 👍"} Whole site: ${chipB(bRate(s), s[0])}.`;
    const body = rows.length ? hkTable(["Page", "Visits", "Bounce", "vs before", "Engaged time", "Phones", "Computers"], rows.map(({ hp, e }) => {
      const b = bRate(e.c), was = e.p[0] >= 20 ? bRate(e.p) : null;
      return hkRow("b:" + hp.path, [pageLink(hp.path), c.h.fmtInt(e.c[0]), chipB(b, e.c[0]),
        was == null || e.c[0] < 20 ? "—" : c.h.delta(b * 100, was * 100, { invert: true, abs: true, digits: 0 }),
        durB(e.c[2] / e.c[0]), chipB(bRate(e.m), e.m[0]), chipB(bRate(e.d), e.d[0])], () => {
        const t = tipsOf(hp, e);
        return hkStats([["Visits from Google", c.h.fmtInt(e.c[0])], ["Bounce", chipB(b, e.c[0])], ["28 days before", was == null ? "—" : pctB(was)],
          ["Engaged time", durB(e.c[2] / e.c[0])], ["Key events", c.h.fmtInt(e.c[3] || 0)]])
          + (t ? `<div class="seo-hk-h">What to try</div><p class="seo-hk-p">${esc(t)}</p>`
            : `<p class="seo-note">${e.c[0] < 20 ? "Fewer than 20 visits: not judged yet." : "This page keeps visitors well. 👍"}</p>`)
          + hkActs([advBtn(hp.path, "bounce", highBounce(e)), goBtn("Open Engagement", { view: "engage" }), openBtn(hp.path)]);
      });
    })) : `<p class="seo-note">No visits from Google to priority pages in the last 28 days.</p>`;
    return hkCard("bounce", { title: "Visitors who leave straight away", sub: `Visits from Google · ${esc(E.from || "")} to ${esc(E.to || "")}`, sum,
      viz: split([{ n: judged.length - hi.length - fair.length, tone: "green", label: "Good (45% or less)" }, { n: fair.length, tone: "amber", label: "Fair (45–65%)" },
        { n: hi.length, tone: "red", label: "High (over 65%)" }, { n: rows.length - judged.length, tone: "grey", label: "Under 20 visits" }]),
      body, tip: "A bounce is a visit that left within 10 seconds without clicking or booking. The first screen has to answer what they searched for, with a clear way to book." });
  }

  function kpiHtml(all) {
    switch (ui.hkpi) {
      case "pages": return pagesCard(all);
      case "high": case "medium": case "low": return sevCard(all, ui.hkpi);
      case "score": return scoreCard();
      case "google": return googleCard(all);
      case "cwv": return cwvCard();
      case "bounce": return bounceCard();
      default: return "";
    }
  }
  function tiles(all) {
    const open = all.filter((i) => i.status === "open");
    const n = (s) => open.filter((i) => i.sev === s).length;
    const ms = H.pages.map((p) => metricsOf(p.speed)).filter(Boolean);
    const scores = ms.map((m) => m.score).filter((v) => v != null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const real = ms.filter((m) => m.pass !== null);
    const tile = (key, l, v, p) => `<button type="button" class="seo-kpi${ui.hkpi === key ? " is-on" : ""}" data-h-kpi="${key}"
      aria-expanded="${ui.hkpi === key}" title="See what's behind this number"><div class="l">${l}</div><div class="v">${v}</div>${p ? `<div class="p">${p}</div>` : ""}</button>`;
    return `<div class="seo-kpis seo-hk-tiles">
      ${tile("pages", "Priority pages checked", H.pages.length, when(H.state.at))}
      ${tile("high", "High", `<span class="seo-h-poor">${n("high")}</span>`, "open issues")}
      ${tile("medium", "Medium", `<span class="seo-h-ni">${n("medium")}</span>`, "open issues")}
      ${tile("low", "Low", n("low"), "open issues")}
      ${tile("score", "Avg mobile score", avg == null ? "—" : val("score", avg), "out of 100")}
      ${H.index?.data ? tile("google", "In Google", (() => {
        const k = H.pages.filter((p) => p.google && !p.google.err);
        return k.length ? `${k.filter((p) => p.google.v === "PASS").length}/${k.length}` : "—";
      })(), "key pages indexed") : ""}
      ${tile("cwv", "Core Web Vitals", real.length ? `${real.filter((m) => m.pass).length}/${real.length}` : "—",
        real.length ? "pages passing (real visitors)" : "not enough visits yet")}
      ${c.data?.eng ? (() => {
        const hb = H.pages.filter((p) => highBounce(engOf(p.path))).length;
        return tile("bounce", "High bounce", hb ? `<span class="seo-h-poor">${hb}</span>` : "0", "priority pages over 65%");
      })() : ""}
    </div>`;
  }
  function issueRow(i) {
    const pg = c.byPath.get(i.path);
    const where = starMark(isPri(i.path)) + (pg ? `<button class="seo-w-link" data-open="${pg.id}">${esc(i.path)}</button>`
      : `<a class="seo-w-link" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.path)}</a>`);
    const ignored = i.status === "ignored";
    return `<div class="seo-h-issue is-${SEV[i.sev].tone}" data-hx-row>
      <div class="seo-h-ihead"><span class="seo-w-pill is-${SEV[i.sev].tone}">${SEV[i.sev].label}</span>
        <span class="seo-note">${esc(GROUPS[i.group] || i.group)}</span> · ${where}</div>
      <div><strong>${esc(i.msg)}</strong>${i.detail ? `<div class="seo-note seo-h-detail">${esc(i.detail)}</div>` : ""}</div>
      ${HELP[i.code] ? `<details class="seo-h-help"><summary>How to fix</summary><p>${esc(HELP[i.code])}</p></details>` : ""}
      ${!ignored ? hxBody(i) : ""}
      ${ignored ? `<p class="seo-note">Ignored by ${esc(i.st?.byName || "someone")}${i.st?.at ? " · " + esc(when(i.st.at)) : ""}${i.st?.note ? ": " + esc(i.st.note) : ""}</p>` : ""}
      ${(() => {
        const fix = (!ignored && FIX[i.code] && i.path !== "Whole site" && c.can("seo.pages") ? fixBtn(i.path, FIX[i.code]) : "")
          + (!ignored && ADVK[i.code] && i.path !== "Whole site" ? advBtn(i.path, ADVK[i.code], true) : "");
        const acts = canWork ? (ignored
          ? `<button class="seo-btn" data-h-undo="${i.id}">Back to open</button>`
          : `<button class="seo-btn" data-h-log="${i.id}">Log a fix</button><button class="seo-btn" data-h-ignore="${i.id}">Ignore</button>`) : "";
        return fix || acts ? `<div class="seo-w-acts">${fix}${acts}</div>` : "";
      })()}
    </div>`;
  }
  /* --- One-click fixes on the Issues tab --- */
  const shortI = (u) => String(u || "").replace(/^https?:\/\/[^/]+/i, "") || "/";
  function hxBody(i) {
    if (i.path === "Whole site") return "";
    const F = HX.get(i.id) || {};
    const errBox = F.err ? `<div class="seo-fx-err"><span>⚠</span><div>${esc(F.err)}</div></div>` : "";
    if (i.st?.status === "fixed" && i.st?.kind === "hx") return hxDone(i, i.st, F, errBox);
    const field = META[i.code];
    if (field) return c.can("seo.pages") ? metaBody(i, field, F, errBox) : "";
    if (!c.can("seo.fix")) return "";
    if (i.code === "redirect_links" || i.code === "broken_link") return linksBody(i, F, errBox);
    if (i.code === "many_h1") return h1Body(i, F, errBox);
    if (i.code === "alt") return altBody(c, i.path);
    if (i.code === "wording") return wordBody(i, F, errBox);
    return "";
  }

  function metaBody(i, field, F, errBox) {
    const name = field === "title" ? "title" : "meta description";
    if (!F.opts) {
      return `<div class="seo-fx-bar"><button class="seo-fx-b is-accept" type="button" data-hx-meta="${i.id}"${F.busy ? " disabled" : ""}>${
        F.busy === "go" ? spinH + "Writing options… (about 15 seconds)" : `✨ Write a new ${name}`}</button></div>${errBox}`;
    }
    const L = LIM[field], pick = F.pick ?? 0;
    return `<div class="seo-fx-opts">
      ${F.now ? `<div class="seo-fx-col is-now"><div class="seo-fx-lab">Now · ${F.now.length} characters</div><div class="seo-fx-txt">${esc(F.now)}</div></div>` : ""}
      <div class="seo-fx-lab" style="margin-top:6px">Choose the ${name}</div>
      ${F.opts.map((o, n) => `<button type="button" class="seo-fx-opt${pick === n ? " is-on" : ""}${(o.flags || []).length ? " is-flag" : ""}" data-hx-pick="${i.id}|${n}" aria-pressed="${pick === n}">
        <span class="seo-fx-radio"></span><span class="seo-fx-otxt"><b>${esc(o.text)}</b>
        <small>${o.text.length} characters${o.text.length >= L[0] && o.text.length <= L[1] ? " ✓" : ` · best ${L[0]}–${L[1]}`}${o.why ? " · " + esc(o.why) : ""}</small>
        ${(o.flags || []).map((f) => `<small class="seo-fx-flag">⚠ ${esc(f)}</small>`).join("")}</span></button>`).join("")}
      <label class="seo-fx-lab" style="display:block;margin-top:8px">Or edit it
        <input class="seo-input seo-hx-in" data-hx-text="${i.id}" value="${esc(F.text ?? "")}" maxlength="${field === "title" ? 70 : 170}"></label></div>
    <div class="seo-fx-bar">
      <button class="seo-fx-b is-accept" type="button" data-hx-metaok="${i.id}"${F.busy ? " disabled" : ""}>${F.busy === "apply" ? spinH + "Saving…" : "✓ Use it on the page"}</button>
      <button class="seo-fx-b is-ghost" type="button" data-hx-meta="${i.id}"${F.busy ? " disabled" : ""}>${F.busy === "go" ? spinH + "Writing…" : "↻ More options"}</button>
      <button class="seo-fx-b is-ghost" type="button" data-hx-cancel="${i.id}"${F.busy ? " disabled" : ""}>Cancel</button></div>${errBox}`;
  }

  function linksBody(i, F, errBox) {
    const broken = i.code === "broken_link";
    if (!F.items) {
      return `<div class="seo-fx-bar"><button class="seo-fx-b is-accept" type="button" data-hx-links="${i.id}"${F.busy ? " disabled" : ""}>${
        F.busy === "go" ? spinH + "Checking the links on the page…" : broken ? "🔧 Fix this link" : "🔧 Update the links"}</button></div>${errBox}`;
    }
    if (!F.items.length) {
      return `<p class="seo-note" style="margin:8px 0 0">Nothing to change now: ${broken ? "the link works again" : "the links go straight to their pages"}, or ${
        broken ? "it's" : "they're"} in the menu or footer. This issue clears at the next check.</p>
        <div class="seo-fx-bar"><button class="seo-fx-b is-ghost" type="button" data-hx-cancel="${i.id}">Close</button></div>${errBox}`;
    }
    return `<div class="seo-fx-places">
      <div class="seo-fx-lab">${broken ? "Where should the link go instead?" : `${plural(F.items.length, "link")} to update. The words stay the same.`}</div>
      ${F.items.map((x, n) => `<div class="seo-fx-place"><span class="seo-fx-pn">${n + 1}</span>
        <div class="seo-fx-txt"><del class="seo-fx-del">${esc(shortI(x.abs))}</del>${broken ? ` <span class="seo-note">(error ${x.code})</span>`
          : ` → <ins class="seo-fx-ins">${esc(shortI(x.to))}</ins>`}</div>
        ${broken ? `<select class="seo-input seo-hx-sel" data-hx-to="${n}" aria-label="Where the link goes">
          ${(x.options || []).map((o) => `<option value="${esc(o.path)}"${x.choice === o.path ? " selected" : ""}>${esc(o.title || o.path)} (${esc(o.path)})</option>`).join("")}
          <option value=""${x.choice === "" ? " selected" : ""}>Remove the link (keep the words)</option></select>` : ""}</div>`).join("")}
      <div class="seo-fx-bar">
        <button class="seo-fx-b is-accept" type="button" data-hx-linksok="${i.id}"${F.busy ? " disabled" : ""}>${F.busy === "apply" ? spinH + "Updating…" : "✓ Update on the page"}</button>
        <button class="seo-fx-b is-ghost" type="button" data-hx-cancel="${i.id}"${F.busy ? " disabled" : ""}>Cancel</button></div></div>${errBox}`;
  }

  function h1Body(i, F, errBox) {
    if (!F.h1) {
      return `<div class="seo-fx-bar"><button class="seo-fx-b is-accept" type="button" data-hx-h1="${i.id}"${F.busy ? " disabled" : ""}>${
        F.busy === "go" ? spinH + "Reading the page…" : "🔧 Fix the headings"}</button></div>${errBox}`;
    }
    const h = F.h1;
    if (!h.convert.length) {
      return `<p class="seo-note" style="margin:8px 0 0">The extra main headings aren't in the page's own content (they come from the theme or a template), so they can't be changed from here.</p>
        <div class="seo-fx-bar"><button class="seo-fx-b is-ghost" type="button" data-hx-cancel="${i.id}">Close</button></div>${errBox}`;
    }
    return `<div class="seo-fx-places">
      <div class="seo-fx-lab">${h.keep ? `“${esc(h.texts[0] || "")}” stays the main heading.` : "The theme already shows the page's main heading."}
        These become section headings (H2). They may look a little smaller.</div>
      <ul class="seo-fx-mlist">${h.convert.map((t) => `<li>“${esc(t)}”</li>`).join("")}</ul>
      <div class="seo-fx-bar">
        <button class="seo-fx-b is-accept" type="button" data-hx-h1ok="${i.id}"${F.busy ? " disabled" : ""}>${F.busy === "apply" ? spinH + "Changing…" : `✓ Change ${plural(h.convert.length, "heading")}`}</button>
        <button class="seo-fx-b is-ghost" type="button" data-hx-cancel="${i.id}"${F.busy ? " disabled" : ""}>Cancel</button></div></div>${errBox}`;
  }

  function wordBody(i, F, errBox) {
    if (!F.places) {
      return `<div class="seo-fx-bar"><button class="seo-fx-b is-accept" type="button" data-hx-word="${i.id}"${F.busy ? " disabled" : ""}>${
        F.busy === "go" ? spinH + "Finding it on the page and writing options… (about 20 seconds)" : "✨ Suggest compliant wording"}</button></div>${errBox}`;
    }
    if (!F.places.length) {
      return `<p class="seo-note" style="margin:8px 0 0">${esc(F.note || "The flagged wording isn't on the page any more. This issue clears at the next check.")}</p>
        <div class="seo-fx-bar"><button class="seo-fx-b is-ghost" type="button" data-hx-cancel="${i.id}">Close</button></div>${errBox}`;
    }
    const on = F.places.filter((p) => p.ok && p.on).length;
    const busy = F.busy ? " disabled" : "";
    return `<div class="seo-fx-places">
      <div class="seo-fx-lab">${plural(F.places.length, "place")} on the page. Choose the new wording for each, or edit it.</div>
      ${F.places.map((p, x) => p.ok ? `<div class="seo-hx-wp${p.on ? "" : " is-off"}">
        <label class="seo-hx-won"><input type="checkbox" data-hx-won="${x}"${p.on ? " checked" : ""}><span class="seo-fx-pn">${x + 1}</span> Change this one</label>
        <div class="seo-fx-txt seo-hx-wsent">${esc(p.before)}<del class="seo-fx-del">${esc(p.find)}</del>${esc(p.after)}</div>
        ${p.options.map((o, k) => `<button type="button" class="seo-fx-opt${p.pick === k ? " is-on" : ""}${(o.flags || []).length ? " is-flag" : ""}" data-hx-wpick="${i.id}|${x}|${k}" aria-pressed="${p.pick === k}">
          <span class="seo-fx-radio"></span><span class="seo-fx-otxt"><b>${esc(o.text)}</b>${o.why ? `<small>${esc(o.why)}</small>` : ""}
          ${(o.flags || []).map((f) => `<small class="seo-fx-flag">⚠ ${esc(f)}</small>`).join("")}</span></button>`).join("")}
        ${!p.options.length ? `<p class="seo-note" style="margin:4px 0">No options came back for this one. Edit it below, or press Regenerate.</p>` : ""}
        <label class="seo-fx-lab" style="display:block;margin-top:6px">Or edit it
          <input class="seo-input seo-hx-in" data-hx-wtext="${x}" value="${esc(p.text || "")}" maxlength="600"></label>
        <div class="seo-fx-txt seo-hx-wsent seo-hx-after"><span class="seo-note">After:</span> ${esc(p.before)}<ins class="seo-fx-ins">${esc(p.text || "")}</ins>${esc(p.after)}</div>
      </div>` : `<div class="seo-hx-wp is-off"><span class="seo-fx-pn">${x + 1}</span>
        <div class="seo-fx-txt seo-hx-wsent">${esc(p.before)}<b>${esc(p.old || "")}</b>${esc(p.after)}</div>
        <p class="seo-note" style="margin:4px 0 0">⚠ ${esc(p.why || "Change this one in WordPress.")}</p></div>`).join("")}
    </div>
    <div class="seo-fx-bar">
      <button class="seo-fx-b is-accept" type="button" data-hx-wordok="${i.id}"${busy || !on ? " disabled" : ""}>${
        F.busy === "apply" ? spinH + "Changing…" : `✓ Accept${on ? ` ${plural(on, "change")}` : ""}`}</button>
      <button class="seo-fx-b is-ghost" type="button" data-hx-word="${i.id}"${busy}>${F.busy === "go" ? spinH + "Writing…" : "↻ Regenerate"}</button>
      <button class="seo-fx-b is-ghost" type="button" data-hx-wreject="${i.id}"${busy}>✕ Reject: not a problem here</button>
      <button class="seo-fx-b is-ghost" type="button" data-hx-cancel="${i.id}"${busy}>Cancel</button></div>${errBox}`;
  }

  function hxDone(i, st, F, errBox) {
    let lines = [];
    try { lines = JSON.parse(st.results || "[]"); } catch { lines = []; }
    const what = st.fix === "meta" ? `New ${st.field === "desc" ? "meta description" : "title"} saved`
      : st.fix === "links" ? `${plural(Number(st.count) || 0, "link")} updated`
      : st.fix === "wording" ? `Wording changed in ${plural(Number(st.count) || 0, "place")}`
      : `${plural(Number(st.count) || 0, "heading")} changed to H2`;
    return `<div class="seo-fx is-done">
      <div class="seo-fx-head"><span class="seo-fx-tick">✓</span><strong>${what}</strong><span class="seo-sp"></span>
        <span class="seo-note">${esc(st.byName || "")}${st.at ? " · " + esc(when(st.at)) : ""}</span></div>
      ${st.fix === "meta" ? `<div class="seo-fx-sum">${st.from ? `<del class="seo-fx-del">${esc(st.from)}</del> → ` : ""}<ins class="seo-fx-ins">${esc(st.to || "")}</ins></div>
        ${st.verified === false ? `<div class="seo-note">Not on the live page yet: the page cache can take a few minutes.</div>` : ""}` : ""}
      ${lines.length ? `<ul class="seo-fx-res">${lines.map((l) => `<li class="is-ok"><span>✓</span><span class="seo-note">${esc(l)}</span></li>`).join("")}</ul>` : ""}
      ${st.note ? `<div class="seo-note">${esc(st.note)}</div>` : ""}
      <div class="seo-fx-bar">
        ${st.link ? `<a class="seo-fx-b is-accept" href="${esc(st.link)}" target="_blank" rel="noopener">View live page ↗</a>` : ""}
        ${c.can(st.fix === "meta" ? "seo.pages" : "seo.fix") ? `<button class="seo-fx-b is-ghost" type="button" data-hx-undo="${i.id}"${F.busy ? " disabled" : ""}>${
          F.busy === "undo" ? spinH + "Putting it back…" : "↶ Undo"}</button>` : ""}
        <span class="seo-sp"></span><span class="seo-note">This issue clears at the next Site health check (about 8am).</span></div>${errBox}</div>`;
  }

  async function hxClick(e) {
    const t = e.target.closest("[data-h-adv],[data-hx-meta],[data-hx-pick],[data-hx-metaok],[data-hx-links],[data-hx-linksok],[data-hx-h1],[data-hx-h1ok],[data-hx-cancel],[data-hx-undo],[data-hx-word],[data-hx-wpick],[data-hx-wordok],[data-hx-wreject]");
    if (!t) return false;
    e.stopPropagation();   // some sit inside a row that opens the page panel
    const d = t.dataset;
    if (d.hAdv) {
      const cut = d.hAdv.lastIndexOf("|"), path = d.hAdv.slice(0, cut), kind = d.hAdv.slice(cut + 1);
      c.work.advPrefill = { mode: "page", page: path, text: (ADVQ[kind] || ADVQ.index)(path) };
      c.setTab("advisor");
      return true;
    }
    const id = d.hxMeta || d.hxMetaok || d.hxLinks || d.hxLinksok || d.hxH1 || d.hxH1ok || d.hxCancel || d.hxUndo
      || d.hxWord || d.hxWordok || d.hxWreject || String(d.hxPick || d.hxWpick || "").split("|")[0];
    const i = byId.get(id);
    if (!i) return true;
    const F = HX.get(id) || {};
    HX.set(id, F);
    const row = t.closest("[data-hx-row]");   // what's typed and chosen, kept before the row is drawn again
    const inp = row?.querySelector("[data-hx-text]");
    if (inp) F.text = inp.value.replace(/\s+/g, " ").trim();
    row?.querySelectorAll("[data-hx-to]").forEach((s) => { const it = F.items?.[Number(s.dataset.hxTo)]; if (it) it.choice = s.value; });
    row?.querySelectorAll("[data-hx-wtext]").forEach((x) => { const p = F.places?.[Number(x.dataset.hxWtext)]; if (p) p.text = x.value.replace(/\s+/g, " ").trim(); });
    row?.querySelectorAll("[data-hx-won]").forEach((x) => { const p = F.places?.[Number(x.dataset.hxWon)]; if (p) p.on = x.checked; });
    const field = META[i.code];
    const base = { issueId: id, path: i.path, key: i.key, label: (i.msg + (i.detail ? " · " + i.detail : "")).slice(0, 300) };
    const run = async (busy, op, body = {}) => {
      F.busy = busy; F.err = ""; draw();
      try { return await fixApi(op, { ...base, ...body }); }
      catch (err) { F.err = fixErr(err); return null; }
      finally { F.busy = ""; draw(); }
    };
    const saved = (r, msg) => { c.work.health.status[id] = r.rec; i.st = r.rec; HX.delete(id); toast(msg); draw(); };
    const page = `<div class="seo-fx-mpage"><b>${esc(i.path)}</b></div>`;
    const after = `<ul class="seo-fx-mlist"><li>Live straight away.</li><li>It's added to the Change log, and you can <b>Undo</b> it from here.</li></ul>`;

    if (d.hxCancel) { HX.delete(id); draw(); return true; }
    // Advertising wording: suggest or regenerate, choose, accept, reject
    if (d.hxWord) {
      const r = await run("go", "hxWord", { msg: i.msg, detail: i.detail || "" });
      if (r) {
        F.note = r.note || "";
        F.places = (r.places || []).map((p) => {
          const k = (p.options || []).findIndex((o) => !(o.flags || []).length);
          const pick = k < 0 ? 0 : k;
          return { ...p, options: p.options || [], pick, text: p.options?.[pick]?.text || "", on: !!p.ok && !!p.options?.length };
        });
        if (F.places.some((p) => p.ok) && !F.places.some((p) => p.options.length)) F.err = "No new wording came back. Press Regenerate.";
        draw();
      }
      return true;
    }
    if (d.hxWpick) {
      const [, n, k] = d.hxWpick.split("|").map(Number);
      const p = F.places?.[n];
      if (p && p.options[k]) { p.pick = k; p.text = p.options[k].text; p.on = true; }
      draw();
      return true;
    }
    if (d.hxWordok) {
      const items = (F.places || []).filter((p) => p.ok && p.on && p.text);
      if (!items.length) { F.err = "Tick at least one change."; draw(); return true; }
      const yes = await askConfirm({ title: `Change the wording in ${plural(items.length, "place")}?`, ok: "✓ Yes, change it",
        body: `${page}${items.map((x) => `<div class="seo-fx-ba">
          <div class="seo-fx-col is-now"><div class="seo-fx-lab">Now</div><div class="seo-fx-txt">${esc(x.before)}<del class="seo-fx-del">${esc(x.find)}</del>${esc(x.after)}</div></div>
          <div class="seo-fx-arrow" aria-hidden="true">→</div>
          <div class="seo-fx-col is-new"><div class="seo-fx-lab">After</div><div class="seo-fx-txt">${esc(x.before)}<ins class="seo-fx-ins">${esc(x.text)}</ins>${esc(x.after)}</div></div></div>`).join("")}${after}` });
      if (!yes) return true;
      const r = await run("apply", "hxWordApply", { items: items.map((x) => ({ find: x.find, text: x.text, term: x.term || "" })) });
      if (r) saved(r, "Reworded ✓");
      return true;
    }
    if (d.hxWreject) {
      const note = prompt("Why isn't this a problem on this page? The reason is kept with the issue.", "");
      if (note === null) return true;
      if (note.trim().length < 3) { F.err = "Add a short reason, so others know why it was left."; draw(); return true; }
      try {
        await setStatus(c, i, "ignored", "Not a problem here: " + note.trim());
        HX.delete(id);
        toast("Marked as not a problem");
        draw();
      } catch (err) { F.err = errText(err.message || err); draw(); }
      return true;
    }
    if (d.hxPick) {
      const n = Number(d.hxPick.split("|")[1]);
      F.pick = n; F.text = F.opts?.[n]?.text || "";
      draw();
      return true;
    }
    if (d.hxMeta) {
      const r = await run("go", "hxMeta", { field });
      if (r) {
        F.opts = r.options || [];
        F.now = r.now || "";
        const ok = F.opts.findIndex((o) => !(o.flags || []).length);
        F.pick = ok < 0 ? 0 : ok;
        F.text = F.opts[F.pick]?.text || "";
        if (!F.opts.length) F.err = "No options came back. Try again.";
        draw();
      }
      return true;
    }
    if (d.hxMetaok) {
      const text = F.text || "";
      if (text.length < (field === "title" ? 20 : 50)) { F.err = `That's too short for a ${field === "title" ? "title" : "meta description"}.`; draw(); return true; }
      const yes = await askConfirm({ title: `Use this ${field === "title" ? "title" : "meta description"} on the page?`, ok: "✓ Yes, use it",
        body: `${page}<div class="seo-fx-ba">
          <div class="seo-fx-col is-now"><div class="seo-fx-lab">Now</div><div class="seo-fx-txt">${F.now ? esc(F.now) : "<i>(none)</i>"}</div></div>
          <div class="seo-fx-arrow" aria-hidden="true">→</div>
          <div class="seo-fx-col is-new"><div class="seo-fx-lab">After · ${text.length} characters</div><div class="seo-fx-txt">${esc(text)}</div></div></div>
          <ul class="seo-fx-mlist"><li>Saved in your SEO plugin and live straight away. Google usually shows it within a few days to two weeks.</li>
            <li>It's added to the Change log, and you can <b>Undo</b> it from here.</li></ul>` });
      if (!yes) return true;
      const r = await run("apply", "hxMetaApply", { field, value: text });
      if (r) saved(r, "Saved ✓");
      return true;
    }
    if (d.hxLinks) {
      const broken = i.code === "broken_link";
      const r = await run("go", "hxLinks", { kind: broken ? "broken" : "redirect", only: broken ? i.detail : "" });
      if (r) { F.items = (r.items || []).map((x) => ({ ...x, choice: x.options?.[0]?.path ?? "" })); draw(); }
      return true;
    }
    if (d.hxLinksok) {
      const broken = i.code === "broken_link";
      const items = (F.items || []).map((x) => ({ from: x.abs, to: broken ? x.choice : x.to }));
      const yes = await askConfirm({ title: `Update ${plural(items.length, "link")} on this page?`, ok: "✓ Yes, update them",
        body: `${page}<ul class="seo-fx-mlist">${items.map((x) => `<li>${esc(shortI(x.from))} → ${x.to ? `<b>${esc(shortI(x.to))}</b>` : "<i>link removed, words kept</i>"}</li>`).join("")}</ul>${after}` });
      if (!yes) return true;
      const r = await run("apply", "hxLinksApply", { items });
      if (r) saved(r, "Links updated ✓");
      return true;
    }
    if (d.hxH1) {
      const r = await run("go", "hxH1");
      if (r) { F.h1 = r; draw(); }
      return true;
    }
    if (d.hxH1ok) {
      const yes = await askConfirm({ title: `Change ${plural(F.h1?.convert?.length || 0, "heading")} to section headings?`, ok: "✓ Yes, change them",
        body: `${page}<ul class="seo-fx-mlist">${(F.h1?.convert || []).map((x) => `<li>“${esc(x)}” → H2</li>`).join("")}</ul>${after}` });
      if (!yes) return true;
      const r = await run("apply", "hxH1Apply");
      if (r) saved(r, "Headings fixed ✓");
      return true;
    }
    if (d.hxUndo) {
      const yes = await askConfirm({ title: "Undo this change?", ok: "↶ Yes, undo it", tone: "reject",
        body: `${page}<ul class="seo-fx-mlist"><li>The page goes back to how it was before.</li>
          <li>If someone has edited the page in WordPress since, it can't be undone from here.</li></ul>` });
      if (!yes) return true;
      const r = await run("undo", "hxUndo");
      if (r) { c.work.health.status[id] = r.rec; i.st = r.rec; i.status = "open"; toast("Put back"); draw(); }
      return true;
    }
    return true;
  }
  function issuesHtml(all) {
    const inStatus = all.filter((i) => i.status === ui.hstatus);
    const counts = { open: all.filter((i) => i.status === "open").length, ignored: all.filter((i) => i.status === "ignored").length };
    const gcount = {};
    for (const i of inStatus) gcount[i.group] = (gcount[i.group] || 0) + 1;
    const shown = inStatus
      .filter((i) => (ui.hsev === "all" || i.sev === ui.hsev) && (ui.hgroup === "all" || i.group === ui.hgroup) && (!ui.hpage || i.path === ui.hpage))
      .sort((a, b) => (isPri(b.path) - isPri(a.path)) || SEV[a.sev].rank - SEV[b.sev].rank || a.path.localeCompare(b.path));
    const chip = (attr, k, l, on, n) =>
      `<button class="seo-w-chip ${on ? "is-on" : ""}" ${attr}="${k}">${esc(l)}${n != null ? ` <em>${n}</em>` : ""}</button>`;
    return `
      <div class="seo-row">
        <button class="seo-btn ${ui.hstatus === "open" ? "on" : ""}" data-h-status="open">Open <span class="seo-w-n">${counts.open}</span></button>
        <button class="seo-btn ${ui.hstatus === "ignored" ? "on" : ""}" data-h-status="ignored">Ignored <span class="seo-w-n">${counts.ignored}</span></button>
        <span class="seo-sp"></span>
        ${chip("data-h-sev", "all", "All", ui.hsev === "all")}
        ${Object.entries(SEV).map(([k, v]) => chip("data-h-sev", k, v.label, ui.hsev === k, inStatus.filter((i) => i.sev === k).length)).join("")}
      </div>
      <div class="seo-row">
        ${chip("data-h-group", "all", "All types", ui.hgroup === "all")}
        ${Object.entries(GROUPS).map(([k, l]) => chip("data-h-group", k, l, ui.hgroup === k, gcount[k] || 0)).join("")}
      </div>
      ${ui.hpage ? `<div class="seo-row"><span class="seo-w-chip is-on">Only ${esc(ui.hpage)}
        <button type="button" class="seo-hk-clear" data-h-page title="Show every page">✕</button></span></div>` : ""}
      ${shown.length ? shown.map(issueRow).join("") : `<div class="seo-empty">${ui.hstatus === "open" ? "Nothing to fix here. 👍" : "Nothing ignored."}</div>`}
      <p class="seo-note" style="margin-top:8px">Fixed something? It disappears after the next nightly check (about 8am).</p>`;
  }

  function speedHtml() {
    const rows = H.pages.slice().sort((a, b) => (isPri(b.path) - isPri(a.path)) || (a.speed?.score ?? 999) - (b.speed?.score ?? 999));
    return `<div class="seo-table-wrap"><table class="seo-table">
      <thead><tr><th>Page</th><th>Mobile score</th><th>Loading (LCP)</th><th>Responding (INP)</th><th>Shifting (CLS)</th><th>Measured from</th><th>Trend</th><th>Checked</th><th></th></tr></thead>
      <tbody>${rows.map((p) => {
        const m = metricsOf(p.speed);
        const pg = c.byPath.get(p.path);
        const scores = (p.history || []).map((r) => r.s).filter((v) => v != null);
        return `<tr ${pg ? `data-open="${pg.id}"` : ""}>
          <td><div class="seo-path" title="${esc(p.url)}">${starMark(isPri(p.path))}${esc(p.path)}</div></td>
          ${m ? `<td>${val("score", m.score)}</td><td>${val("lcp", m.lcp)}</td><td>${val("inp", m.inp)}</td><td>${val("cls", m.cls)}</td><td>${esc(m.from)}</td>`
            : `<td colspan="5" class="seo-note">${p.speedError ? esc(p.speedError) : "Not checked yet"}</td>`}
          <td>${scores.length > 1 ? c.h.sparkline(scores, 90, 22) : ""}</td>
          <td class="seo-note">${p.speedAt ? esc(when(p.speedAt)) : "—"}</td>
          <td>${advBtn(p.path, "speed", !!m && ((m.score != null && m.score < 70) || m.pass === false))}</td>
        </tr>`;
      }).join("")}</tbody></table></div>
      <p class="seo-note" style="margin-top:8px">Mobile, from Google PageSpeed Insights. Good: LCP under 2.5 s, INP under 200 ms, CLS under 0.1, score 90+.
        “Real visitors” is Chrome data from the last 28 days. Pages without enough visits show Google's lab test instead (no INP).</p>`;
  }

  function indexHtml() {
    const I = H.index;
    if (!I?.data) {
      return `<div class="seo-empty">${I?.state?.error ? esc(I.state.error)
        : "No Google indexing data yet. In Apps Script, run <code>runSeoIndex()</code> once, then <code>installSeoIndexTrigger()</code>."}</div>`;
    }
    const X = I.data;
    const yes = (b) => (b ? `<span class="seo-h-good">Yes</span>` : `<span class="seo-h-poor">No</span>`);
    const day = (iso) => { const d = daysSince(iso); return d == null ? "—" : d === 0 ? "today" : d + " days ago"; };
    const missing = new Set(X.keyNotInSitemap || []);
    const inspect = (r) => (r?.link ? `<a class="seo-w-link" href="${esc(r.link)}" target="_blank" rel="noopener">Inspect ↗</a>` : "");

    const keyRows = H.pages.map((p) => {
      const r = p.google;
      const pg = c.byPath.get(p.path);
      const name = pg ? `<button class="seo-w-link" data-open="${pg.id}">${esc(p.path)}</button>` : esc(p.path);
      if (!r) return `<tr><td>${name}</td><td colspan="7" class="seo-note">Not checked yet</td></tr>`;
      if (r.err) return `<tr><td>${name}</td><td colspan="7" class="seo-note">${esc(r.err)}</td></tr>`;
      const diff = r.gc && r.uc && normU(r.gc) !== normU(r.uc);
      const rich = (r.rr || []).map((x) => esc(x.t) + (x.e ? ` <span class="seo-h-poor">${plural(x.e, "error")}</span>` : "")).join(", ");
      return `<tr><td>${name}</td><td>${yes(r.v === "PASS")}</td><td class="seo-note">${esc(r.cs || "")}</td><td>${day(r.lc)}</td>
        <td>${diff ? `<span class="seo-h-ni" title="${esc(r.gc)}">${esc(shortU(r.gc))}</span>` : `<span class="seo-note">Same</span>`}</td>
        <td>${X.sitemapUrls ? yes(!missing.has(p.path)) : "—"}</td><td class="seo-note">${rich || "—"}</td>
        <td>${inspect(r)} ${advBtn(p.path, "index", r.v !== "PASS" || diff)}</td></tr>`;
    }).join("");

    const fmtD = (iso) => (iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—");
    const smRows = (X.sitemaps || []).map((s) => `<tr><td>${esc(shortU(s.path))}${s.pending ? ' <span class="seo-note">(waiting for Google)</span>' : ""}</td>
      <td>${fmtD(s.submitted)}</td><td>${fmtD(s.downloaded)}</td><td>${s.urls ? c.h.fmtInt(s.urls) : "—"}</td>
      <td>${s.errors ? `<span class="seo-h-poor">${s.errors}</span>` : "0"}</td><td>${s.warnings || 0}</td></tr>`).join("");

    const others = Object.entries(X.others || {});
    const outOf = others.filter(([, r]) => r && !r.err && r.v && r.v !== "PASS");
    const otherRows = outOf.slice(0, 100).map(([p, r]) =>
      `<tr><td><a class="seo-w-link" href="${esc((H.pages[0]?.url || "").replace(/^(https?:\/\/[^/]+).*$/, "$1") + p)}" target="_blank" rel="noopener">${esc(p)}</a></td>
        <td class="seo-note">${esc(r.cs || "")}</td><td>${day(r.lc)}</td><td class="seo-note">${esc(r.at || "")}</td><td>${inspect(r)}</td></tr>`).join("");

    return `
      ${I.state.ok === false && I.state.error ? `<div class="seo-warn">${esc(I.state.error)}</div>` : ""}
      ${X.quota ? `<div class="seo-warn">Google's daily URL Inspection limit was reached. The rest are checked tomorrow.</div>` : ""}
      <div class="seo-card"><h3>Priority pages in Google</h3>
        <div class="seo-table-wrap" style="max-height:none"><table class="seo-table">
          <thead><tr><th>Page</th><th>In Google</th><th>Google says</th><th>Google's last visit</th><th>Main version</th><th>In sitemap</th><th>Rich results</th><th></th></tr></thead>
          <tbody>${keyRows}</tbody></table></div>
        <p class="seo-note" style="margin-top:6px">From Search Console's URL Inspection. “Main version” is the address Google treats as the real one. If it isn't this page, this page won't show in search.</p>
      </div>
      <div class="seo-card"><h3>Sitemaps</h3>
        ${smRows ? `<table class="seo-table"><thead><tr><th>Sitemap</th><th>Submitted</th><th>Google last read it</th><th>Pages</th><th>Errors</th><th>Warnings</th></tr></thead><tbody>${smRows}</tbody></table>`
          : `<p class="seo-note">No sitemap submitted to Search Console.${X.sitemapUrls ? ` One was ${esc(X.sitemapSource || "found")} with ${c.h.fmtInt(X.sitemapUrls)} pages.` : ""}</p>`}
        <p class="seo-note" style="margin-top:6px">${c.h.fmtInt(X.sitemapUrls || 0)} pages in the sitemap: ${c.h.fmtInt(X.sitemapSeen || 0)} are in Google (they had search impressions),
          ${c.h.fmtInt(others.length)} more checked with URL Inspection so far (up to 60 a day), ${c.h.fmtInt(outOf.length)} not in Google.</p>
      </div>
      <div class="seo-card"><h3>Sitemap pages not in Google</h3>
        ${otherRows ? `<table class="seo-table"><thead><tr><th>Page</th><th>Google says</th><th>Google's last visit</th><th>Checked</th><th></th></tr></thead><tbody>${otherRows}</tbody></table>
            ${outOf.length > 100 ? `<p class="seo-note">and ${outOf.length - 100} more</p>` : ""}`
          : `<p class="seo-note">${others.length ? "None found so far. 👍" : "Not checked yet."}</p>`}
      </div>
      ${X.notInSitemap?.length ? `<div class="seo-card"><h3>Pages with clicks that aren't in the sitemap</h3>
        <ul class="seo-h-plist">${X.notInSitemap.map(([p, n]) => {
          const pg = c.byPath.get(p);
          return `<li>${pg ? `<button class="seo-w-link" data-open="${pg.id}">${esc(p)}</button>` : esc(p)} <span class="seo-note">· ${plural(n, "click")} in 28 days</span></li>`;
        }).join("")}</ul></div>` : ""}`;
  }
  // Engagement: how many Google visitors each priority page keeps, and what to try
  function engageHtml() {
    const E = c.data?.eng;
    if (!E) {
      return `<div class="seo-empty">No engagement data yet. In Apps Script, run <code>runSeoEngagement()</code> once, then <code>installSeoEngagementTrigger()</code>.</div>`;
    }
    const s = E.site.c, dev = E.site.dev || {};
    const dRow = (k, l) => (dev[k] && dev[k][0] ? `<span>${l} ${chipB(bRate(dev[k]), dev[k][0])}</span>` : "");
    const tipsOf = (hp, e) => {
      if (!highBounce(e)) return "";
      const out = [];
      const mob = e.m[0] >= 10 ? bRate(e.m) : null, desk = e.d[0] >= 10 ? bRate(e.d) : null;
      const m = metricsOf(hp.speed);
      if (mob != null && desk != null && mob - desk >= 0.1) out.push("Check it on a phone: the top should load fast, with the Book button showing straight away.");
      if (m && m.score != null && m.score < 50) out.push(`It's slow on phones (score ${m.score}): compress the top image.`);
      if (e.c[2] / e.c[0] < 20) out.push("People leave within seconds: make the first screen answer what they searched for.");
      if (hp.words && hp.words < 400) out.push(`Only about ${hp.words} words: add what people want to know (cost, downtime, results).`);
      if (!out.length) out.push("Add a short answer near the top, and links to related treatments, so people read on.");
      return out.slice(0, 2).join(" ");
    };
    const rows = H.pages.map((hp) => ({ hp, e: engOf(hp.path) })).sort((a, b) => {
      const ok = (x) => (x.e && x.e.c[0] >= 20 ? 1 : 0);
      return ok(b) - ok(a) || (bRate(b.e?.c) ?? -1) - (bRate(a.e?.c) ?? -1);
    });
    return `
      <div class="seo-card"><div class="seo-row" style="margin:0;gap:14px">
        <strong>Google visitors who left straight away: ${chipB(bRate(s), s[0])}</strong>
        ${dRow("mobile", "Phones")}${dRow("desktop", "Computers")}${dRow("tablet", "Tablets")}
        <span class="seo-sp"></span><span class="seo-note">${esc(E.from || "")} to ${esc(E.to || "")} · ${c.h.fmtInt(s[0])} visits from Google</span></div>
        ${E.state && E.state.ok === false ? `<div class="seo-warn" style="margin:8px 0 0">The last engagement update failed: ${esc(E.state.error || "")}</div>` : ""}
      </div>
      <div class="seo-table-wrap"><table class="seo-table seo-h-eng">
        <thead><tr><th>Page</th><th>Visits</th><th>Bounce</th><th>vs before</th><th>Engaged time</th><th>Phones</th><th>Computers</th><th>Key events</th><th>What to try</th></tr></thead>
        <tbody>${rows.map(({ hp, e }) => {
          const pg = c.byPath.get(hp.path);
          const name = starMark(isPri(hp.path)) + (pg ? `<button class="seo-w-link" data-open="${pg.id}">${esc(hp.path)}</button>` : esc(hp.path));
          if (!e || !e.c[0]) return `<tr><td>${name}</td><td colspan="8" class="seo-note">No visits from Google in the last 28 days.</td></tr>`;
          const b = bRate(e.c), was = e.p[0] >= 20 ? bRate(e.p) : null;
          return `<tr><td>${name}</td><td>${c.h.fmtInt(e.c[0])}</td><td>${chipB(b, e.c[0])}</td>
            <td>${was == null || e.c[0] < 20 ? "—" : c.h.delta(b * 100, was * 100, { invert: true, abs: true, digits: 0 })}</td>
            <td>${durB(e.c[2] / e.c[0])}</td><td>${chipB(bRate(e.m), e.m[0])}</td><td>${chipB(bRate(e.d), e.d[0])}</td>
            <td>${c.h.fmtInt(e.c[3] || 0)}</td><td class="seo-h-try">${esc(tipsOf(hp, e))}${advBtn(hp.path, "bounce", highBounce(e))}</td></tr>`;
        }).join("")}</tbody></table></div>
      <p class="seo-note" style="margin-top:8px">A bounce is a visit from Google that left without engaging: under 10 seconds, no second page, no booking or enquiry.
        Green up to 45%, red over 65%. “vs before” is in points against the 28 days before. Pages with fewer than 20 visits aren't judged.</p>`;
  }
  function draw() {
    const all = H.pages.concat(H.site ? [H.site] : []).flatMap((p) => p.issues || []);
    byId = new Map(all.map((i) => [i.id, i]));
    const st = H.state;
    wrap.innerHTML = `
      ${st.ok === false ? `<div class="seo-warn">The last site health check failed, so this may be out of date: ${esc(st.error || "")}</div>` : ""}
      ${st.blocked ? `<div class="seo-warn">${st.blocked} key page${st.blocked === 1 ? "" : "s"} couldn't be read. The website may be blocking automated checks.</div>` : ""}
      ${st.speedProblem ? `<div class="seo-warn">${esc(st.speedProblem)}</div>` : ""}
      ${tiles(all)}
      ${ui.hkpi ? kpiHtml(all) : ""}
      <div class="seo-row">
        <button class="seo-btn ${ui.hview === "content" ? "on" : ""}" data-h-view="content">Content</button>
        <button class="seo-btn ${ui.hview === "issues" ? "on" : ""}" data-h-view="issues">Issues</button>
        <button class="seo-btn ${ui.hview === "speed" ? "on" : ""}" data-h-view="speed">Speed</button>
        <button class="seo-btn ${ui.hview === "engage" ? "on" : ""}" data-h-view="engage">Engagement</button>
        <button class="seo-btn ${ui.hview === "index" ? "on" : ""}" data-h-view="index">In Google</button>
        <span class="seo-sp"></span>
        <span class="seo-note">${st.linksChecked != null ? `${st.linksChecked} of ${st.linksFound} internal links checked · ` : ""}${c.isAdmin ? `Star pages (☆) in the <a href="#/seo/pages">Pages tab</a> to check them` : ""}</span>
      </div>
      ${ui.hview === "content" ? contentHtml(c, ui) : ui.hview === "speed" ? speedHtml() : ui.hview === "engage" ? engageHtml()
        : ui.hview === "index" ? indexHtml() : issuesHtml(all)}`;
  }

  wrap.onclick = async (e) => {
    if (await hxClick(e)) return;   // one-click fixes and Fix with the Advisor (first: some sit inside a row that opens the page panel)
    if (e.target.closest("[data-open]")) return;   // seo.js opens the page panel
    // The number cards: open or close a card, open a row, or go to a view with its filters set
    const hk = e.target.closest("[data-h-kpi],[data-hk-x],[data-hk-go],[data-h-page]");
    if (hk && wrap.contains(hk)) {
      const d = hk.dataset;
      if (d.hkX !== undefined) {
        const inner = e.target.closest("button,a");
        if (inner && inner !== hk && hk.contains(inner)) return;   // a link inside the row does its own job
        ui.hkx = ui.hkx === d.hkX ? "" : d.hkX;
        draw();
        return;
      }
      if (d.hKpi !== undefined) { ui.hkpi = ui.hkpi === d.hKpi ? "" : d.hKpi; ui.hkx = ""; draw(); return; }
      if (d.hPage !== undefined) { ui.hpage = ""; draw(); return; }
      let o = {};
      try { o = JSON.parse(d.hkGo || "{}"); } catch { o = {}; }
      ui.hview = o.view || "issues";
      if (ui.hview === "issues") Object.assign(ui, { hstatus: "open", hsev: o.sev || "all", hgroup: o.group || "all", hpage: o.page || "" });
      ui.hkpi = ""; ui.hkx = "";
      draw();
      wrap.querySelector("[data-h-view]")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (await contentClick(e, c, ui, draw)) return;   // the Content view's buttons
    const t = e.target.closest("[data-h-view],[data-h-sev],[data-h-group],[data-h-status],[data-h-log],[data-h-ignore],[data-h-undo]");
    if (!t) return;
    const d = t.dataset;
    if (d.hView) { ui.hview = d.hView; draw(); return; }
    if (d.hSev) { ui.hsev = d.hSev; draw(); return; }
    if (d.hGroup) { ui.hgroup = d.hGroup; draw(); return; }
    if (d.hStatus) { ui.hstatus = d.hStatus; draw(); return; }
    const i = byId.get(d.hLog || d.hIgnore || d.hUndo);
    if (!i) return;
    if (d.hLog) {
      c.work.prefill = { url: i.path, title: ("Fixed: " + i.msg).slice(0, 200), type: LOG_TYPE[i.group] || "Technical" };
      c.setTab("log");
      return;
    }
    let note = "";
    if (d.hIgnore) {
      note = prompt("Why ignore this? (optional)", "");
      if (note === null) return;
    }
    t.disabled = true;
    try {
      await setStatus(c, i, d.hIgnore ? "ignored" : "open", note);
      toast(d.hIgnore ? "Ignored" : "Back on the list");
      draw();
    } catch (err) { t.disabled = false; toast(errText(err.message || err), true); }
  };

  // Enter or Space opens a row in a number card
  wrap.onkeydown = (e) => {
    const r = e.target.closest && e.target.closest("[data-hk-x]");
    if (r && wrap.contains(r) && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); r.click(); }
  };
  // Typing your own wording updates its "After" line straight away
  if (!wrap.dataset.hxWordIn) {
    wrap.dataset.hxWordIn = "1";
    wrap.addEventListener("input", (e) => {
      const x = e.target.closest && e.target.closest("[data-hx-wtext]");
      const ins = x && x.closest(".seo-hx-wp")?.querySelector(".seo-hx-after ins");
      if (ins) ins.textContent = x.value;
    });
  }
  draw();
  // Refresh on this tab: re-check the pages changed from here, so fixed issues drop off now
  if (c.work.recheckNow) { c.work.recheckNow = false; recheckPages(c, draw); }
}

/* ---------- styles ---------- */

const CSS = `
.seo-h-issue{padding:12px 14px;margin-bottom:8px;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-left:3px solid var(--tone,#94a3b8);border-radius:10px;font-size:13px}
.seo-h-issue.is-red{--tone:#dc2626}.seo-h-issue.is-amber{--tone:#d97706}
.seo-h-ihead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:4px}
.seo-h-detail{margin-top:2px;word-break:break-word}
.seo-h-help summary{cursor:pointer;margin-top:6px;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-h-help p{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:#f8fafc;line-height:1.45}
.seo-h-good{color:#16a34a;font-weight:600}.seo-h-ni{color:#d97706;font-weight:600}.seo-h-poor{color:#dc2626;font-weight:600}
.seo-h-plist{list-style:none;margin:0 0 8px;padding:0;font-size:13px}
.seo-h-plist li{padding:5px 0;border-top:1px solid var(--border,#e5e7eb)}
.seo-w-ta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;resize:vertical}
.seo-hx-in{display:block;width:100%;max-width:640px;margin-top:4px;box-sizing:border-box;font-weight:400;text-transform:none;letter-spacing:0}
.seo-hx-sel{max-width:320px;min-width:0}
.seo-h-adv{margin-left:4px;white-space:nowrap}
.seo-h-try .seo-h-adv{display:inline-block;margin:6px 0 0}
.seo-h-issue .seo-fx.is-done{margin-top:10px}
.seo-hk-tiles .seo-kpi[data-h-kpi]{cursor:pointer;font:inherit;text-align:left;transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}
.seo-hk-tiles .seo-kpi[data-h-kpi]:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(15,23,42,.08)}
.seo-hk-tiles .seo-kpi[data-h-kpi]:focus-visible{outline:2px solid var(--accent,#2563eb);outline-offset:2px}
.seo-hk-tiles .seo-kpi.is-on{border-color:var(--accent,#2563eb);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
.seo-hk{border-color:#bfdbfe;box-shadow:0 8px 24px rgba(37,99,235,.07);animation:seoHkIn .18s ease-out}
@keyframes seoHkIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.seo-hk-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:2px}
.seo-hk-head h3{margin:0 0 2px}
.seo-hk-sum{margin:8px 0 10px;font-size:14px;line-height:1.6}
.seo-hk-split{display:flex;gap:2px;height:10px;margin:2px 0 8px;border-radius:6px;overflow:hidden;background:#f1f5f9}
.seo-hk-split i{display:block;min-width:6px}
.seo-hk-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 14px;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-hk-legend i{display:inline-block;width:9px;height:9px;margin-right:6px;border-radius:3px;vertical-align:-1px}
.seo-hk-legend b{color:var(--text,#111827);margin-left:2px}
.seo-hk .is-green{background:#22c55e}.seo-hk .is-amber{background:#f59e0b}.seo-hk .is-red{background:#ef4444}.seo-hk .is-grey{background:#cbd5e1}
.seo-hk-bars{display:grid;gap:6px;max-width:560px;margin:0 0 14px}
.seo-hk-bar{display:grid;grid-template-columns:190px minmax(0,1fr) 34px;align-items:center;gap:10px;font-size:12.5px}
.seo-hk-bar b{height:8px;border-radius:5px;background:#f1f5f9;overflow:hidden}
.seo-hk-bar b i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#60a5fa,#2563eb)}
.seo-hk-bar em{font-style:normal;font-weight:600;text-align:right}
.seo-hk-t tbody tr.seo-hk-r{cursor:pointer;transition:background .1s}
.seo-hk-t tbody tr.seo-hk-r:hover{background:#f8fbff}
.seo-hk-t tbody tr.seo-hk-r.is-open{background:#eff6ff}
.seo-hk-t tbody tr.seo-hk-r:focus-visible{outline:2px solid var(--accent,#2563eb);outline-offset:-2px}
.seo-hk-car{display:inline-block;width:14px;font-style:normal;color:var(--text-muted,#6b7280)}
.seo-hk-t tr.seo-hk-xr td{white-space:normal;text-align:left;max-width:none;padding:12px 16px 14px 30px;background:#f8fbff;border-top:0}
.seo-hk-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 16px;margin:0 0 10px;font-size:13px}
.seo-hk-stats small{display:block;font-size:11.5px;color:var(--text-muted,#6b7280)}
.seo-hk-h{margin:8px 0 4px;font-size:12px;font-weight:700;letter-spacing:.02em;color:var(--text-muted,#6b7280);text-transform:uppercase}
.seo-hk-il,.seo-hk-why{margin:0 0 6px;padding:0;list-style:none;font-size:13px;line-height:1.5}
.seo-hk-il li{padding:5px 0;border-top:1px solid var(--border,#e5e7eb)}
.seo-hk-il li:first-child{border-top:0}
.seo-hk-why li{margin:0 0 6px;padding:8px 10px;border-radius:8px;background:#fff;border:1px solid var(--border,#e5e7eb)}
.seo-hk-p{margin:0 0 6px;font-size:13px;line-height:1.5}
.seo-hk-help{margin:8px 0;padding:8px 12px;border-radius:8px;background:#fff;border:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-hk-help p{margin:4px 0 0;line-height:1.5}
.seo-hk-one{display:inline-block;padding:1px 8px;border-radius:999px;background:#f5f3ff;color:#6d28d9;font-size:11.5px;font-weight:600;white-space:nowrap}
.seo-hk-acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
.seo-hk-acts a.seo-btn{text-decoration:none}
.seo-hk-tip{margin-top:12px;padding:9px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.5}
.seo-hk-clear{border:0;background:none;padding:0 0 0 6px;cursor:pointer;font:inherit;color:inherit;opacity:.7}
.seo-hk-clear:hover{opacity:1}
@media (max-width:640px){.seo-hk-bar{grid-template-columns:120px minmax(0,1fr) 28px}.seo-hk-t tr.seo-hk-xr td{padding:10px 12px}}
.seo-hx-wp{padding:12px 0;border-top:1px solid var(--border,#e5e7eb);transition:opacity .15s}
.seo-hx-wp:first-of-type{border-top:0}
.seo-hx-wp.is-off{opacity:.55}
.seo-hx-won{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;cursor:pointer;margin-bottom:6px}
.seo-hx-wsent{margin:4px 0 8px;padding:8px 10px;border-radius:8px;background:#f8fafc;line-height:1.6}
.seo-hx-after{background:#f0fdf4;margin-top:8px}
`;

function injectCss() {
  if (document.getElementById("seo-health-css")) return;
  const s = document.createElement("style");
  s.id = "seo-health-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}