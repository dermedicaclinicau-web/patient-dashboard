// seo-health.js — SEO Phase 3: the Site health tab, and speed + issues in the page panel.
// Reads seo_state/health, seo_health (current build) and seo_issues (what staff have ignored).

import { db, auth } from "./firebase-config.js";
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
  if (!k) return `<p class="seo-note" style="margin-top:14px">Site health doesn't check this page. Add it under Settings → Key pages to check its speed, titles, links and wording every night.</p>`;
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
  if (!ui.hview) Object.assign(ui, { hview: "issues", hsev: "all", hgroup: "all", hstatus: "open" });
  const canWork = c.can("seo.work");
  let byId = new Map();

  function tiles(all) {
    const open = all.filter((i) => i.status === "open");
    const n = (s) => open.filter((i) => i.sev === s).length;
    const ms = H.pages.map((p) => metricsOf(p.speed)).filter(Boolean);
    const scores = ms.map((m) => m.score).filter((v) => v != null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const real = ms.filter((m) => m.pass !== null);
    const tile = (l, v, p) => `<div class="seo-kpi"><div class="l">${l}</div><div class="v">${v}</div>${p ? `<div class="p">${p}</div>` : ""}</div>`;
    return `<div class="seo-kpis">
      ${tile("Key pages checked", H.pages.length, when(H.state.at))}
      ${tile("High", `<span class="seo-h-poor">${n("high")}</span>`, "open issues")}
      ${tile("Medium", `<span class="seo-h-ni">${n("medium")}</span>`, "open issues")}
      ${tile("Low", n("low"), "open issues")}
      ${tile("Avg mobile score", avg == null ? "—" : val("score", avg), "out of 100")}
      ${H.index?.data ? tile("In Google", (() => {
        const k = H.pages.filter((p) => p.google && !p.google.err);
        return k.length ? `${k.filter((p) => p.google.v === "PASS").length}/${k.length}` : "—";
      })(), "key pages indexed") : ""}
      ${tile("Core Web Vitals", real.length ? `${real.filter((m) => m.pass).length}/${real.length}` : "—",
        real.length ? "pages passing (real visitors)" : "not enough visits yet")}
    </div>`;
  }

  function issueRow(i) {
    const pg = c.byPath.get(i.path);
    const where = pg ? `<button class="seo-w-link" data-open="${pg.id}">${esc(i.path)}</button>`
      : `<a class="seo-w-link" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.path)}</a>`;
    const ignored = i.status === "ignored";
    return `<div class="seo-h-issue is-${SEV[i.sev].tone}">
      <div class="seo-h-ihead"><span class="seo-w-pill is-${SEV[i.sev].tone}">${SEV[i.sev].label}</span>
        <span class="seo-note">${esc(GROUPS[i.group] || i.group)}</span> · ${where}</div>
      <div><strong>${esc(i.msg)}</strong>${i.detail ? `<div class="seo-note seo-h-detail">${esc(i.detail)}</div>` : ""}</div>
      ${HELP[i.code] ? `<details class="seo-h-help"><summary>How to fix</summary><p>${esc(HELP[i.code])}</p></details>` : ""}
      ${ignored ? `<p class="seo-note">Ignored by ${esc(i.st?.byName || "someone")}${i.st?.at ? " · " + esc(when(i.st.at)) : ""}${i.st?.note ? ": " + esc(i.st.note) : ""}</p>` : ""}
      ${canWork ? `<div class="seo-w-acts">${ignored
        ? `<button class="seo-btn" data-h-undo="${i.id}">Back to open</button>`
        : `<button class="seo-btn" data-h-log="${i.id}">Log a fix</button><button class="seo-btn" data-h-ignore="${i.id}">Ignore</button>`}</div>` : ""}
    </div>`;
  }

  function issuesHtml(all) {
    const inStatus = all.filter((i) => i.status === ui.hstatus);
    const counts = { open: all.filter((i) => i.status === "open").length, ignored: all.filter((i) => i.status === "ignored").length };
    const gcount = {};
    for (const i of inStatus) gcount[i.group] = (gcount[i.group] || 0) + 1;
    const shown = inStatus
      .filter((i) => (ui.hsev === "all" || i.sev === ui.hsev) && (ui.hgroup === "all" || i.group === ui.hgroup))
      .sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank || a.path.localeCompare(b.path));
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
      ${shown.length ? shown.map(issueRow).join("") : `<div class="seo-empty">${ui.hstatus === "open" ? "Nothing to fix here. 👍" : "Nothing ignored."}</div>`}
      <p class="seo-note" style="margin-top:8px">Fixed something? It disappears after the next nightly check (about 8am).</p>`;
  }

  function speedHtml() {
    const rows = H.pages.slice().sort((a, b) => (a.speed?.score ?? 999) - (b.speed?.score ?? 999));
    return `<div class="seo-table-wrap"><table class="seo-table">
      <thead><tr><th>Page</th><th>Mobile score</th><th>Loading (LCP)</th><th>Responding (INP)</th><th>Shifting (CLS)</th><th>Measured from</th><th>Trend</th><th>Checked</th></tr></thead>
      <tbody>${rows.map((p) => {
        const m = metricsOf(p.speed);
        const pg = c.byPath.get(p.path);
        const scores = (p.history || []).map((r) => r.s).filter((v) => v != null);
        return `<tr ${pg ? `data-open="${pg.id}"` : ""}>
          <td><div class="seo-path" title="${esc(p.url)}">${esc(p.path)}</div></td>
          ${m ? `<td>${val("score", m.score)}</td><td>${val("lcp", m.lcp)}</td><td>${val("inp", m.inp)}</td><td>${val("cls", m.cls)}</td><td>${esc(m.from)}</td>`
            : `<td colspan="5" class="seo-note">${p.speedError ? esc(p.speedError) : "Not checked yet"}</td>`}
          <td>${scores.length > 1 ? c.h.sparkline(scores, 90, 22) : ""}</td>
          <td class="seo-note">${p.speedAt ? esc(when(p.speedAt)) : "—"}</td>
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
        <td>${X.sitemapUrls ? yes(!missing.has(p.path)) : "—"}</td><td class="seo-note">${rich || "—"}</td><td>${inspect(r)}</td></tr>`;
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
      <div class="seo-card"><h3>Key pages in Google</h3>
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

  function draw() {
    const all = H.pages.concat(H.site ? [H.site] : []).flatMap((p) => p.issues || []);
    byId = new Map(all.map((i) => [i.id, i]));
    const st = H.state;
    wrap.innerHTML = `
      ${st.ok === false ? `<div class="seo-warn">The last site health check failed, so this may be out of date: ${esc(st.error || "")}</div>` : ""}
      ${st.blocked ? `<div class="seo-warn">${st.blocked} key page${st.blocked === 1 ? "" : "s"} couldn't be read. The website may be blocking automated checks.</div>` : ""}
      ${st.speedProblem ? `<div class="seo-warn">${esc(st.speedProblem)}</div>` : ""}
      ${tiles(all)}
      <div class="seo-row">
        <button class="seo-btn ${ui.hview === "issues" ? "on" : ""}" data-h-view="issues">Issues</button>
        <button class="seo-btn ${ui.hview === "speed" ? "on" : ""}" data-h-view="speed">Speed</button>
        <button class="seo-btn ${ui.hview === "index" ? "on" : ""}" data-h-view="index">In Google</button>
        <span class="seo-sp"></span>
        <span class="seo-note">${st.linksChecked != null ? `${st.linksChecked} of ${st.linksFound} internal links checked · ` : ""}${c.can("seo.manage") ? `Choose pages in <a href="#/seo/settings">Settings</a>` : ""}</span>
      </div>
      ${ui.hview === "speed" ? speedHtml() : ui.hview === "index" ? indexHtml() : issuesHtml(all)}`;
  }

  wrap.onclick = async (e) => {
    if (e.target.closest("[data-open]")) return;   // seo.js opens the page panel
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
  draw();
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
`;

function injectCss() {
  if (document.getElementById("seo-health-css")) return;
  const s = document.createElement("style");
  s.id = "seo-health-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}