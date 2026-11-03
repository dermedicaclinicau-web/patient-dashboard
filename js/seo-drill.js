// seo-drill.js — Overview: click a number card to see the searches and pages behind it.
// Click a search or page row to open it: a search shows its numbers over 7, 28 and 90 days and the pages Google shows for it;
// a page shows the searches that bring people to it.
// Searches, landing pages and AI assistant visits come from seo_windows (Seo11.gs: the last 7, 28 and 90 days, the period
// before each, and the same dates last year). Page clicks use each page's daily clicks, so they match any dates.

import { db } from "./firebase-config.js";
import { getDocs, collection } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { titleOf } from "./seo-work.js?v=16";

const EXP_CTR = [0.28, 0.16, 0.11, 0.08, 0.06, 0.045, 0.035, 0.03, 0.025, 0.02];   // rough click rate by position
const TABS = {
  clicks: ["Searches", "Pages"], nonBrand: ["Searches"], brandClicks: ["Searches"],
  impressions: ["Searches", "Pages"], ctr: ["Searches", "Pages"], position: ["Searches", "Pages"],
  sessions: ["Landing pages"], conversions: ["Landing pages"], aiSessions: ["Assistants", "Pages"],
};

// What people search for: each group, by the words in the search (a search can be in more than one)
const THEMES = [
  { k: "causes", label: "Causes and “what is”", color: "#7F77DD", re: /\b(causes?|caused|why|what is|what are|what's|meaning|reasons?)\b/ },
  { k: "treat", label: "Treatment options", color: "#1D9E75", re: /\b(treatments?|treat|treating|laser|removal|remove|get rid|cure|fix|therapy|cream|peel|clinic)\b/ },
  { k: "cost", label: "Cost and price", color: "#BA7517", re: /\b(cost|costs|price|prices|pricing|how much|cheap|affordable|afterpay|payment plan)\b/ },
  { k: "local", label: "Local (Perth and suburbs)", color: "#378ADD", re: /\b(perth|near me|wa|western australia|subiaco|nedlands|claremont|cottesloe|joondalup|fremantle|scarborough|leederville|mount lawley|applecross|cbd)\b/ },
  { k: "compare", label: "Comparisons", color: "#D85A30", re: /\b(vs|versus|or|compared|comparison|difference|better)\b/ },
  { k: "safety", label: "Safety, pain and downtime", color: "#D4537E", re: /\b(hurt|hurts|pain|painful|side effects?|safe|safety|risks?|downtime|recovery|swelling|bruising)\b/ },
  { k: "results", label: "Results and how long", color: "#639922", re: /\b(results?|before and after|how long|last|lasts|sessions?|how many|work|works|worth it|effective)\b/ },
];
const QUESTION_RE = /\b(how|what|why|when|does|do|can|is|are|should|which)\b|\?$/;
const WORD_STOP = new Set(["the", "and", "for", "with", "what", "how", "does", "can", "are", "you", "your", "from", "after", "best", "get",
  "why", "when", "which", "that", "this", "near", "into", "without", "much", "long", "will", "have", "has", "who"]);
const TAG_TONE = { Content: "grey", Cost: "amber", FAQ: "blue", Careful: "red", Local: "green", Growing: "green" };

const wcache = { v: null, p: null };
export async function loadWindows(force) {
  if (wcache.v && !force) return wcache.v;
  if (wcache.p) return wcache.p;
  wcache.p = (async () => {
    const snap = await getDocs(collection(db, "seo_windows"));
    const out = {};
    snap.docs.forEach((d) => { try { out[d.id] = JSON.parse(d.data().json || "{}"); } catch { /* skip */ } });
    wcache.v = out;
    return out;
  })();
  try { return await wcache.p; } finally { wcache.p = null; }
}

const keyOf = (p) => String(p || "").split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase() || "/";
const short = (s, n = 44) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const fmtDay = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtR = (r) => `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

function pickWindow(W, r, preset) {
  const exact = ["7", "28", "90"].includes(preset);
  const key = exact ? "w" + preset : r.n <= 10 ? "w7" : r.n <= 45 ? "w28" : "w90";
  return { key, w: W[key] || null, exact };
}

/**
 * o: { key, label, r, cmp (null when there's no comparison), compareMode ('prev' | 'year'), preset, W, tab, cur, prev,
 *      open ('q:<search>' or 'p:<path>': the row that's open) }
 */
export function drillHtml(c, o) {
  injectCss();
  const h = c.h, esc = h.esc;
  const W = o.W || {};
  const pick = pickWindow(W, o.r, o.preset);
  const mode = o.cmp ? o.compareMode : "none";
  const ci = mode === "year" ? 7 : mode === "prev" ? 4 : -1;
  const ai = mode === "year" ? 4 : mode === "prev" ? 3 : -1;
  const hasCmp = ci >= 0;
  const brandWords = (Array.isArray(c.work?.settings?.brand) && c.work.settings.brand.length ? c.work.settings.brand : ["dermedica"])
    .map((w) => String(w).toLowerCase()).filter(Boolean);
  const isBrand = (q) => brandWords.some((b) => q.toLowerCase().includes(b));

  const Q = (pick.w?.q || []).map((r) => ({ q: String(r[0]), c: r[1] || 0, i: r[2] || 0, pos: r[3],
    pc: hasCmp ? r[ci] || 0 : null, pi: hasCmp ? r[ci + 1] || 0 : null, ppos: hasCmp ? r[ci + 2] : null }));
  Q.forEach((x) => { x.brand = isBrand(x.q); });
  const G = (pick.w?.ga || []).map((r) => ({ path: r[0], s: r[1] || 0, e: r[2] || 0, k: r[3] || 0,
    ps: hasCmp ? r[ci] || 0 : null, pk: hasCmp ? r[ci + 2] || 0 : null }));
  const A = (pick.w?.ai || []).map((r) => ({ src: r[0], path: r[1], s: r[2] || 0, ps: ai >= 0 ? r[ai] || 0 : null }));

  /* ----- small builders ----- */
  const signed = (n) => {
    const v = Math.round(n);
    return `<span class="seo-d ${v > 0 ? "up" : v < 0 ? "down" : "flat"}">${v > 0 ? "+" : v < 0 ? "−" : ""}${h.fmtInt(Math.abs(v))}</span>`;
  };
  const moved = (now, was) => (was == null || now == null ? `<span class="seo-note">—</span>`
    : `<span class="seo-d ${was - now > 0 ? "up" : was - now < 0 ? "down" : "flat"}">${was - now > 0 ? "▲ " : was - now < 0 ? "▼ " : ""}${Math.abs(was - now).toFixed(1)}</span>`);
  const pageFor = (path) => c.data.pages.filter((p) => keyOf(p.path) === keyOf(path))
    .sort((a, b) => (b.m28?.impressions || 0) - (a.m28?.impressions || 0))[0] || null;
  const pageName = (path) => esc(short(titleOf(c.work, c.data, path)));
  const pageLink = (path) => {
    const p = pageFor(path);
    return p ? `<button class="seo-w-link" type="button" data-open="${esc(p.id)}" title="${esc(path)}">${pageName(path)}</button>` : pageName(path);
  };

  // A table. keys[i] makes row i open (and shows ▸ / ▾): 'q:<search>' or 'p:<path>'
  const table = (cols, rows, keys = []) => {
    if (!rows.length) return `<p class="seo-note" style="margin:8px 0">Nothing notable for these dates.</p>`;
    const g = `grid-template-columns:minmax(0,1fr)${" 92px".repeat(cols.length - 1)}`;
    return `<div class="seo-dr-t"><div class="seo-dr-r is-h" style="${g}">${cols.map((x) => `<span>${x}</span>`).join("")}</div>
      ${rows.map((r, i) => {
        const k = keys[i] || "";
        const open = !!k && o.open === k;
        const cells = r.map((x, j) => `<span>${j === 0 && k ? `<i class="seo-dr-car">${open ? "▾" : "▸"}</i>` : ""}${x}</span>`).join("");
        return `<div class="seo-dr-r${k ? " is-x" : ""}${open ? " is-open" : ""}" style="${g}"${k
          ? ` data-drx="${esc(k)}" role="button" tabindex="0" aria-expanded="${open}" title="Click to see more"` : ""}>${cells}</div>${open ? detail(k) : ""}`;
      }).join("")}</div>`;
  };
  const sortCmp = (arr) => arr.sort((a, b) => (hasCmp ? Math.abs(b.now - (b.was || 0)) - Math.abs(a.now - (a.was || 0)) : b.now - a.now));
  const cmpTable = (head, items, name, keyFn, fmt = h.fmtInt) => table(
    hasCmp ? [head, "Now", "Before", "Change"] : [head, "Now"],
    items.map((x) => (hasCmp ? [name(x), fmt(x.now), `<span class="seo-note">${fmt(x.was || 0)}</span>`, signed(x.now - (x.was || 0))] : [name(x), fmt(x.now)])),
    keyFn ? items.map(keyFn) : []);
  const totalLine = (label, a, b, fmt) => {
    if (b == null) return `${label}: ${fmt(a)}.`;
    if (a === b) return `${label} held steady (${fmt(a)}).`;
    const p = b ? Math.abs(Math.round(((a - b) / b) * 100)) : null;
    return `${label} ${a > b ? "rose" : "fell"}${p != null ? ` ${p}%` : ""} (${fmt(a)} vs ${fmt(b)}).`;
  };
  const qKey = (x) => "q:" + x.q;
  const pKey = (x) => "p:" + x.path;

  // Clicks to each page for exactly these dates (the same page with and without the end slash counts as one)
  const pageClicks = () => {
    const sum = (p, a, b) => {
      const i0 = Math.max(0, daysBetween(p.dailyFrom, a)), i1 = Math.min(p.dailyArr.length - 1, daysBetween(p.dailyFrom, b));
      let s = 0;
      for (let i = i0; i <= i1; i++) s += p.dailyArr[i] || 0;
      return s;
    };
    const by = new Map();
    for (const p of c.data.pages) {
      if (!Array.isArray(p.dailyArr) || !p.dailyFrom) continue;
      const k = keyOf(p.path);
      const x = by.get(k) || { path: p.path, now: 0, was: hasCmp ? 0 : null, imp: -1 };
      x.now += sum(p, o.r.from, o.r.to);
      if (hasCmp) x.was += sum(p, o.cmp.from, o.cmp.to);
      if ((p.m28?.impressions || 0) > x.imp) { x.imp = p.m28?.impressions || 0; x.path = p.path; }
      by.set(k, x);
    }
    return [...by.values()].filter((x) => x.now + (x.was || 0) > 0);
  };

  /* ----- an open row ----- */
  function detail(k) {
    return `<div class="seo-dr-x">${k.startsWith("q:") ? searchDetail(k.slice(2)) : pageDetail(k.slice(2))}</div>`;
  }

  // A search: its numbers for 7, 28 and 90 days, and the pages Google shows for it
  function searchDetail(q) {
    const lq = q.toLowerCase();
    const per = [["w7", "Last 7 days"], ["w28", "Last 28 days"], ["w90", "Last 90 days"]].map(([wk, label]) => {
      const r = (W[wk]?.q || []).find((x) => String(x[0]).toLowerCase() === lq);
      return r ? [label, h.fmtInt(r[1] || 0), h.fmtInt(r[2] || 0), h.fmtPos(r[3]), `<span class="seo-note">${h.fmtPos(r[6])}</span>`,
        `<span class="seo-note">${h.fmtPos(r[9])}</span>`] : [label, "—", "—", "—", "—", "—"];
    });
    const row = (c.work.queries || []).find((x) => String(x.q).toLowerCase() === lq);
    const pages = (row?.pages || []).slice().sort((a, b) => (b.i || 0) - (a.i || 0)).slice(0, 6);
    const prevOf = (path) => (row?.ppages || []).find((p) => keyOf(p.path) === keyOf(path));
    const g6 = "grid-template-columns:minmax(0,1fr) 70px 80px 70px 80px 80px";
    const g5 = "grid-template-columns:minmax(0,1fr) 70px 80px 70px 80px";
    return `
      <div class="seo-dr-xh">Over time</div>
      <div class="seo-dr-mini">
        <div class="seo-dr-mr is-h" style="${g6}"><span></span><span>Clicks</span><span>Impr.</span><span>Position</span><span>Before</span><span>Last year</span></div>
        ${per.map((r) => `<div class="seo-dr-mr" style="${g6}">${r.map((x) => `<span>${x}</span>`).join("")}</div>`).join("")}
      </div>
      <div class="seo-dr-xh">Pages Google shows for it <span class="seo-note">(last 28 days)</span></div>
      ${pages.length ? `<div class="seo-dr-mini">
        <div class="seo-dr-mr is-h" style="${g5}"><span>Page</span><span>Clicks</span><span>Impr.</span><span>Position</span><span>Moved</span></div>
        ${pages.map((p) => `<div class="seo-dr-mr" style="${g5}"><span>${pageLink(p.path)}</span><span>${h.fmtInt(p.c || 0)}</span>
          <span>${h.fmtInt(p.i || 0)}</span><span>${h.fmtPos(p.pos)}</span><span>${moved(p.pos, prevOf(p.path)?.pos ?? null)}</span></div>`).join("")}
      </div>
      ${pages.length > 1 ? `<p class="seo-dr-warn">Google splits this search between ${pages.length} pages, so they may be competing. Usually one page should own it.
        <button class="seo-w-link" type="button" data-cmp2="${esc(pages[0].path)}|${esc(pages[1].path)}">Compare the top 2 head to head</button></p>` : ""}`
      : `<p class="seo-note">Not in the last 28 days of search data.</p>`}
      <div class="seo-w-acts">
        <button class="seo-btn" type="button" data-kq="${esc(q)}">Open in Keywords</button>
        <button class="seo-btn" type="button" data-drask="${esc(`How can we rank better for “${q}”, and which page should own it?`)}">Ask the Advisor about this search</button>
      </div>`;
  }

  // A page: the searches that bring people to it (sorted by what matters for this card)
  function pageDetail(path) {
    const k = keyOf(path);
    const list = (c.work.queries || []).map((x) => {
      const me = (x.pages || []).find((p) => keyOf(p.path) === k);
      if (!me) return null;
      const was = (x.ppages || []).find((p) => keyOf(p.path) === k);
      return { q: x.q, c: me.c || 0, i: me.i || 0, pos: me.pos, pc: was?.c || 0, ppos: was?.pos ?? null };
    }).filter(Boolean);
    const byClicks = ["clicks", "nonBrand", "brandClicks", "sessions", "conversions", "aiSessions"].includes(o.key);
    list.sort((a, b) => (byClicks ? Math.abs(b.c - b.pc) - Math.abs(a.c - a.pc) || b.c - a.c
      : o.key === "position" ? Math.abs((b.ppos ?? b.pos) - b.pos) - Math.abs((a.ppos ?? a.pos) - a.pos) : b.i - a.i));
    const top = list.slice(0, 10);
    const p = pageFor(path);
    const g = "grid-template-columns:minmax(0,1fr) 64px 72px 80px 70px 70px";
    return `
      <div class="seo-dr-xh">Searches that bring people here <span class="seo-note">(last 28 days vs the 28 before)</span></div>
      ${top.length ? `<div class="seo-dr-mini">
        <div class="seo-dr-mr is-h" style="${g}"><span>Search</span><span>Clicks</span><span>Change</span><span>Impr.</span><span>Position</span><span>Moved</span></div>
        ${top.map((x) => `<div class="seo-dr-mr" style="${g}"><span><button class="seo-w-link" type="button" data-kq="${esc(x.q)}">${esc(x.q)}</button></span>
          <span>${h.fmtInt(x.c)}</span><span>${signed(x.c - x.pc)}</span><span>${h.fmtInt(x.i)}</span><span>${h.fmtPos(x.pos)}</span>
          <span>${moved(x.pos, x.ppos)}</span></div>`).join("")}
      </div>${list.length > 10 ? `<p class="seo-note" style="margin:4px 0 0">${list.length - 10} more searches. Open the page details to see them all.</p>` : ""}`
      : `<p class="seo-note">No searches in the last 28 days of search data.</p>`}
      <div class="seo-w-acts">
        ${p ? `<button class="seo-btn" type="button" data-open="${esc(p.id)}">Open page details</button>` : ""}
        <button class="seo-btn" type="button" data-advpage="${esc(path)}">Ask the Advisor about this page</button>
      </div>`;
  }

  /* ----- each card ----- */
  const key = o.key;
  const tabs = TABS[key] || ["Searches"];
  const tab = tabs.includes(o.tab) ? o.tab : tabs[0];
  let title = o.label, sum = "", tip = "", body = "";
  const notes = [];
  const searchesNote = () => {
    if (!pick.w) return "Search details aren't ready yet. They're added by the next morning's update.";
    const wr = pick.w.ranges;
    return (pick.exact ? "" : `Shown for the last ${pick.w.n} days (${fmtR(wr.cur)}), the closest saved period to your dates. `) +
      (hasCmp ? `Compared with ${fmtR(mode === "year" ? wr.ly : wr.prev)}.` : "");
  };

  if (key === "clicks" || key === "nonBrand" || key === "brandClicks") {
    const want = key === "clicks" ? null : key === "brandClicks";
    const qs = sortCmp(Q.filter((x) => (want == null || x.brand === want) && x.c + (x.pc || 0) > 0).map((x) => ({ ...x, now: x.c, was: x.pc }))).slice(0, 12);
    const curV = o.cur[key], prevV = o.prev ? o.prev[key] : null;
    title = key === "clicks" ? "Where the clicks came from" : key === "nonBrand" ? "Treatment searches (non-brand)" : "Brand searches";
    if (tab === "Pages") {
      body = cmpTable("Page", sortCmp(pageClicks()).slice(0, 12), (x) => pageName(x.path), pKey);
    } else {
      body = cmpTable("Search", qs, (x) => esc(x.q), qKey);
      notes.push(searchesNote());
    }
    const drivers = (key === "clicks" ? sortCmp(pageClicks()) : qs)
      .filter((x) => hasCmp && prevV != null && Math.sign(x.now - (x.was || 0)) === Math.sign(curV - prevV) && x.now !== x.was).slice(0, 2);
    sum = esc(totalLine(o.label, curV ?? 0, hasCmp ? prevV : null, h.fmtInt)) + (drivers.length
      ? ` Biggest changes: ${drivers.map((x) => `${esc(short(x.q || titleOf(c.work, c.data, x.path), 36))} (${(x.now - (x.was || 0)) > 0 ? "+" : "−"}${h.fmtInt(Math.abs(x.now - (x.was || 0)))})`).join(" and ")}.` : "");
    tip = key === "brandClicks"
      ? "Brand searches follow how well people know the clinic (campaigns, Google Business Profile, word of mouth), so they aren't really SEO wins or losses."
      : hasCmp && prevV != null && curV < prevV
        ? "Open the page or search that lost the most to see why, or ask the Advisor what to do."
        : "Open the pages that gained to see which searches are working, and do the same on similar pages.";
  }

  else if (key === "impressions") {
    title = "Where the site is being seen";
    const fresh = Q.filter((x) => hasCmp && (x.pi || 0) === 0 && x.i >= 50).sort((a, b) => b.i - a.i);
    if (tab === "Pages") {
      const pg = c.data.pages.map((p) => ({ path: p.path, now: p.m28?.impressions || 0, was: hasCmp ? p.prev28?.impressions || 0 : null }));
      body = cmpTable("Page", sortCmp(pg.filter((x) => x.now + (x.was || 0) > 0)).slice(0, 12), (x) => pageName(x.path), pKey);
      notes.push("Pages: the last 28 days vs the 28 before.");
    } else {
      const qs = sortCmp(Q.filter((x) => x.i + (x.pi || 0) > 0).map((x) => ({ ...x, now: x.i, was: x.pi }))).slice(0, 12);
      body = cmpTable("Search", qs, (x) => esc(x.q) + ((x.pi || 0) === 0 && hasCmp && x.i > 0 ? ` <span class="seo-pr-pill is-green">new</span>` : ""), qKey);
      notes.push(searchesNote());
    }
    sum = esc(totalLine("Impressions", o.cur.impressions, hasCmp ? o.prev?.impressions : null, h.fmtInt)) +
      (fresh.length ? ` ${fresh.length} search${fresh.length === 1 ? " is" : "es are"} new, with 50 or more impressions.` : "");
    tip = fresh.length
      ? `New searches can show growing demand. If a big one (like “${esc(fresh[0].q)}”) has no page that answers it well, ask the Advisor for a page or FAQ.`
      : "Impressions show demand. Searches seen more often but not clicked are worth a better title and description.";
  }

  else if (key === "ctr") {
    title = "Seen near the top of Google, but rarely clicked";
    const missed = (i, cl, pos) => Math.max(0, Math.round(i * EXP_CTR[Math.max(0, Math.min(9, Math.round(pos) - 1))] - cl));
    let extra = "";
    if (tab === "Pages") {
      const pg = c.data.pages.filter((p) => (p.m28?.impressions || 0) >= 200 && p.m28?.position != null && p.m28.position <= 10)
        .map((p) => ({ p, path: p.path, miss: missed(p.m28.impressions, p.m28.clicks, p.m28.position) })).filter((x) => x.miss > 0)
        .sort((a, b) => b.miss - a.miss).slice(0, 12);
      body = table(["Page", "Impr.", "Position", "CTR", "Missed clicks"], pg.map((x) => [pageName(x.path), h.fmtInt(x.p.m28.impressions),
        h.fmtPos(x.p.m28.position), h.fmtPct(x.p.m28.ctr), `<b>≈ ${h.fmtInt(x.miss)}</b>`]), pg.map(pKey));
      notes.push("Pages: the last 28 days.");
    } else {
      const qs = Q.filter((x) => !x.brand && x.i >= 100 && x.pos != null && x.pos <= 10)
        .map((x) => ({ ...x, miss: missed(x.i, x.c, x.pos) }))
        .filter((x) => x.c / x.i < EXP_CTR[Math.max(0, Math.round(x.pos) - 1)] * 0.5).sort((a, b) => b.miss - a.miss).slice(0, 12);
      body = table(["Search", "Impr.", "Position", "CTR", "Missed clicks"], qs.map((x) => [esc(x.q), h.fmtInt(x.i), h.fmtPos(x.pos),
        h.fmtPct(x.i ? x.c / x.i : 0), `<b>≈ ${h.fmtInt(x.miss)}</b>`]), qs.map(qKey));
      notes.push(searchesNote());
      if (qs.length) extra = ` ${qs.length} search${qs.length === 1 ? " is" : "es are"} seen on page 1 but rarely clicked: about ${h.fmtInt(qs.reduce((a, x) => a + x.miss, 0))} clicks are being missed.`;
    }
    sum = esc(totalLine("CTR", o.cur.ctr, hasCmp ? o.prev?.ctr : null, h.fmtPct) + extra);
    tip = "Rewriting the title and description for these is quick, and often adds clicks within a few weeks. Open a row to see which page Google shows, then ask the Advisor for drafts.";
  }

  else if (key === "position") {
    title = "How rankings moved";
    const close = Q.filter((x) => !x.brand && x.i >= 50 && x.pos != null && x.pos >= 8 && x.pos <= 20).length;
    if (tab === "Pages") {
      const pg = c.data.pages.filter((p) => (p.m28?.impressions || 0) >= 100 && p.m28?.position != null && p.prev28?.position != null)
        .sort((a, b) => Math.abs(b.prev28.position - b.m28.position) - Math.abs(a.prev28.position - a.m28.position)).slice(0, 12);
      body = table(["Page", "Now", "Before", "Moved"], pg.map((p) => [pageName(p.path), h.fmtPos(p.m28.position),
        `<span class="seo-note">${h.fmtPos(p.prev28.position)}</span>`, moved(p.m28.position, p.prev28.position)]), pg.map(pKey));
      notes.push("Pages: the last 28 days vs the 28 before.");
    } else {
      const qs = Q.filter((x) => !x.brand && x.i >= 50 && x.pos != null && (!hasCmp || x.ppos != null))
        .sort((a, b) => (hasCmp ? Math.abs(b.ppos - b.pos) - Math.abs(a.ppos - a.pos) : b.i - a.i)).slice(0, 12);
      body = table(hasCmp ? ["Search", "Now", "Before", "Moved"] : ["Search", "Position", "Impr."], qs.map((x) => hasCmp
        ? [esc(x.q), h.fmtPos(x.pos), `<span class="seo-note">${h.fmtPos(x.ppos)}</span>`, moved(x.pos, x.ppos)]
        : [esc(x.q), h.fmtPos(x.pos), h.fmtInt(x.i)]), qs.map(qKey));
      notes.push(searchesNote());
    }
    const a = o.cur.position, b = hasCmp ? o.prev?.position : null;
    sum = esc(a == null ? "" : b == null ? `Average position: ${h.fmtPos(a)}.`
      : `Average position ${a < b ? "improved" : a > b ? "slipped" : "held"} (${h.fmtPos(a)} vs ${h.fmtPos(b)}; lower is better).`);
    tip = close ? `${close} search${close === 1 ? " sits" : "es sit"} between positions 8 and 20, where a small push brings many more clicks. Open a row to see which page ranks, then ask the Advisor how to push it.`
      : "Positions move a little every week. Watch the searches that matter for your priority pages.";
  }

  else if (key === "sessions" || key === "conversions") {
    const isK = key === "conversions";
    title = isK ? "The landing pages behind bookings and enquiries" : "Where visitors from Google land";
    const rows = sortCmp(G.map((x) => ({ ...x, now: isK ? x.k : x.s, was: isK ? x.pk : x.ps })).filter((x) => x.now + (x.was || 0) > 0)).slice(0, 12);
    body = table(hasCmp ? ["Landing page", "Now", "Before", "Change", isK ? "Per 100 visits" : "Engaged"] : ["Landing page", "Now", isK ? "Per 100 visits" : "Engaged"],
      rows.map((x) => {
        const extra = isK ? (x.s ? (Math.round((x.k / x.s) * 1000) / 10).toFixed(1) : "—") : (x.s ? Math.round((x.e / x.s) * 100) + "%" : "—");
        return hasCmp ? [pageName(x.path), h.fmtInt(x.now), `<span class="seo-note">${h.fmtInt(x.was || 0)}</span>`, signed(x.now - (x.was || 0)), extra]
          : [pageName(x.path), h.fmtInt(x.now), extra];
      }), rows.map(pKey));
    notes.push(searchesNote().replace("Search details", "Landing page details"));
    const cs = isK ? o.cur.conversions : o.cur.sessions, ps = hasCmp ? (isK ? o.prev?.conversions : o.prev?.sessions) : null;
    sum = esc(totalLine(isK ? "Key events from Google visitors" : "Visits from Google", cs, ps, h.fmtInt));
    const sessDrop = hasCmp && o.prev?.sessions ? (o.cur.sessions - o.prev.sessions) / o.prev.sessions : 0;
    const keyDrop = hasCmp && o.prev?.conversions ? (o.cur.conversions - o.prev.conversions) / o.prev.conversions : 0;
    tip = isK
      ? (keyDrop <= -0.4 && sessDrop > -0.15
        ? "<b>Key events fell much more than visits.</b> That usually means a booking button, form or GA4 key event stopped working. Test a booking on the website, and check GA4 → Admin → Key events."
        : "These pages bring bookings and enquiries. Open one to see which searches lead there, and link to it from your guides.")
      : "Pages with a low engaged rate may not match what people expected. Open one to see which searches bring people there.";
  }

  else if (key === "aiSessions") {
    title = "Visits from AI assistants";
    if (tab === "Pages") {
      const by = new Map();
      A.forEach((x) => { const k = keyOf(x.path); const y = by.get(k) || { path: x.path, now: 0, was: hasCmp ? 0 : null }; y.now += x.s; if (hasCmp) y.was += x.ps || 0; by.set(k, y); });
      body = cmpTable("Page", sortCmp([...by.values()]).slice(0, 12), (x) => pageName(x.path), pKey);
    } else {
      const by = new Map();
      A.forEach((x) => { const y = by.get(x.src) || { src: x.src, now: 0, was: hasCmp ? 0 : null }; y.now += x.s; if (hasCmp) y.was += x.ps || 0; by.set(x.src, y); });
      body = cmpTable("Assistant", sortCmp([...by.values()]).slice(0, 12), (x) => esc(x.src));
    }
    notes.push(searchesNote().replace("Search details", "AI assistant details"));
    sum = esc(totalLine("AI assistant visits", o.cur.aiSessions, hasCmp ? o.prev?.aiSessions : null, h.fmtInt));
    tip = "These pages are being recommended by AI assistants like ChatGPT and Perplexity. Keep them accurate and up to date, with clear answers near the top.";
  }

  // "What people are searching for" and "Worth considering" (treatment searches only)
  function themesHtml() {
    const nb = Q.filter((x) => !x.brand);
    const list = nb.filter((x) => x.i > 0);
    if (list.length < 10) return "";
    const tot = list.reduce((a, x) => a + x.i, 0) || 1;
    const pct = (s) => Math.round(s * 100) + "%";
    const rows = THEMES.map((t) => {
      const m = nb.filter((x) => t.re.test(x.q.toLowerCase()));
      const now = m.filter((x) => x.i > 0).sort((a, b) => b.i - a.i);
      const imp = now.reduce((a, x) => a + x.i, 0);
      const pimp = hasCmp ? m.reduce((a, x) => a + (x.pi || 0), 0) : null;
      return { ...t, imp, pimp, share: imp / tot, ex: now.slice(0, 3).map((x) => x.q) };
    }).filter((r) => r.imp > 0).sort((a, b) => b.imp - a.imp);
    if (!rows.length) return "";
    const T = Object.fromEntries(rows.map((r) => [r.k, r]));
    const change = (r) => {
      if (r.pimp == null) return "";
      if (!r.pimp) return ` <span class="seo-pr-pill is-green">new</span>`;
      const p = Math.round((r.imp / r.pimp - 1) * 100);
      return p ? `<div class="seo-d ${p > 0 ? "up" : "down"}">${p > 0 ? "▲" : "▼"} ${Math.abs(p)}%</div>` : `<div class="seo-d flat">no change</div>`;
    };
    const growing = (r) => (r.pimp && r.imp >= r.pimp * 1.2 ? " and growing" : "");

    // The most common words, weighted by impressions
    const wc = new Map();
    list.forEach((x) => {
      new Set(x.q.toLowerCase().split(/[^a-z0-9']+/)).forEach((w) => {
        if (w.length < 3 || WORD_STOP.has(w) || /^\d+$/.test(w)) return;
        wc.set(w, (wc.get(w) || 0) + x.i);
      });
    });
    const words = [...wc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);

    // The pages Google shows for searches in a group (last 28 days)
    const pagesFor = (re) => {
      const by = new Map();
      (c.work.queries || []).forEach((q) => {
        const l = String(q.q).toLowerCase();
        if (q.topic === "__brand" || isBrand(l) || !re.test(l)) return;
        (q.pages || []).forEach((p) => {
          const k = keyOf(p.path);
          const x = by.get(k) || { path: p.path, i: 0 };
          x.i += p.i || 0;
          by.set(k, x);
        });
      });
      return [...by.values()].sort((a, b) => b.i - a.i).slice(0, 3);
    };

    // Worth considering: [weight, tag, text]
    const sugg = [];
    if (T.causes && T.causes.share >= 0.15) {
      sugg.push([T.causes.share, "Content", `<b>${pct(T.causes.share)} of searches ask what causes it or what it is${growing(T.causes)}.</b> Open the main pages with a short, clear answer, and link those guides to the treatment pages.`]);
    }
    if (T.cost && T.cost.share >= 0.04) {
      const pg = pagesFor(THEMES.find((t) => t.k === "cost").re);
      sugg.push([T.cost.share + 0.05, "Cost", `<b>Cost searches are ${pct(T.cost.share)}${growing(T.cost)}</b>${pg.length ? `, landing mostly on ${pg.map((x) => pageLink(x.path)).join(", ")}` : ""}. Check those pages have a cost section with “from [your price]” and what changes the price.`]);
    }
    if (T.compare && T.compare.share >= 0.04) {
      sugg.push([T.compare.share, "FAQ", `<b>Comparison searches</b> like “${esc(T.compare.ex[0])}” are ${pct(T.compare.share)}. A short comparison section or FAQ on the treatment page can win them.`]);
    }
    const qShare = list.filter((x) => QUESTION_RE.test(x.q.toLowerCase())).reduce((a, x) => a + x.i, 0) / tot;
    const deep = c.work.health?.content?.deep || {};
    const noFaq = (c.work.settings?.keyPages || []).filter((p) => deep[keyOf(p)] && !deep[keyOf(p)].faq).length;
    if (qShare >= 0.15 && noFaq) {
      sugg.push([qShare, "FAQ", `<b>${pct(qShare)} of searches are questions, but ${noFaq} priority page${noFaq === 1 ? " has" : "s have"} no FAQ section.</b> FAQs answer them directly and can show in Google. Site health → Content lists the pages.`]);
    }
    if (T.safety && T.safety.share >= 0.03) {
      sugg.push([T.safety.share, "Careful", `<b>Questions about pain, side effects and downtime are ${pct(T.safety.share)}${growing(T.safety)}.</b> Answer them honestly on the page: the advertising rules don't allow playing them down.`]);
    }
    if (T.results && T.results.share >= 0.04) {
      sugg.push([T.results.share * 0.9, "Careful", `<b>People ask about results and how long they last (${pct(T.results.share)}).</b> Explain what to expect and how many sessions, without promising results.`]);
    }
    if (T.local && T.local.share >= 0.08) {
      sugg.push([T.local.share * 0.8, "Local", `<b>${pct(T.local.share)} of searches name Perth or a suburb.</b> Keep “Perth” in treatment page titles, and keep your Google Business Profile services and posts up to date.`]);
    }
    const grow = rows.filter((r) => r.pimp >= 100 && r.imp >= r.pimp * 1.3).sort((a, b) => b.imp / b.pimp - a.imp / a.pimp)[0];
    if (grow) {
      sugg.push([1, "Growing", `<b>“${esc(grow.label)}” searches grew ${Math.round((grow.imp / grow.pimp - 1) * 100)}%</b>, for example “${esc(grow.ex[0])}”. Make sure a page answers them well.`]);
    }
    const top = sugg.sort((a, b) => b[0] - a[0]).slice(0, 4);

    const askThemes = `People's treatment searches between ${fmtDay(o.r.from)} and ${fmtDay(o.r.to)}: ${rows.slice(0, 6).map((r) => `${r.label} ${pct(r.share)}`).join(", ")}. ` +
      `Most common words: ${words.join(", ")}. What should we add or change on our pages to answer these searches better? Write drafts where useful.`;

    return `<div class="seo-dr-th">
      <div class="seo-row" style="margin:0 0 4px"><h4>What people are searching for</h4>
        <span class="seo-note">${h.fmtInt(list.length)} treatment searches · share of impressions${hasCmp ? " · change vs before" : ""}</span></div>
      ${rows.map((r) => `<div class="seo-dr-tr"><span>${esc(r.label)}</span>
        <div style="min-width:0"><div class="seo-dr-track"><i style="width:${Math.max(2, Math.round(r.share * 100))}%;background:${r.color}"></i></div>
          <div class="seo-note seo-dr-ex">${r.ex.map(esc).join(" · ")}</div></div>
        <span><b>${pct(r.share)}</b>${change(r)}</span></div>`).join("")}
      ${words.length ? `<p class="seo-note" style="margin:6px 0 0">Most common words: <b>${words.map(esc).join(" · ")}</b></p>` : ""}
      <p class="seo-note" style="margin:2px 0 0">A search can be in more than one group. Brand searches are left out.</p>
      ${top.length ? `<h4 style="margin-top:14px">Worth considering</h4>
        ${top.map(([, tag, txt], i) => `<div class="seo-dr-do"><span class="seo-dr-n">${i + 1}</span>
          <div>${txt} <span class="seo-pr-pill is-${TAG_TONE[tag] || "grey"}">${tag}</span></div></div>`).join("")}` : ""}
      <div class="seo-w-acts"><button class="seo-btn" type="button" data-drask="${esc(askThemes)}">Ask the Advisor to plan these</button></div>
    </div>`;
  }
  const themes = ["clicks", "nonBrand", "impressions", "ctr", "position"].includes(key) && pick.w ? themesHtml() : "";

  const ask = hasCmp
    ? `Why did our ${o.label.toLowerCase()} change between ${fmtDay(o.r.from)} and ${fmtDay(o.r.to)} compared with ${mode === "year" ? "the same time last year" : "the period before"}, and what should we do about it?`
    : `What's driving our ${o.label.toLowerCase()} between ${fmtDay(o.r.from)} and ${fmtDay(o.r.to)}, and how can we improve it?`;

  return `<div class="seo-card seo-dr">
    <div class="seo-row" style="margin:0 0 2px"><h3 style="margin:0">${esc(title)}</h3><span class="seo-note">${esc(fmtR(o.r))}</span>
      <span class="seo-sp"></span><button class="seo-btn" type="button" data-drclose>Close</button></div>
    ${sum ? `<p class="seo-dr-sum">${sum}</p>` : ""}
    ${tabs.length > 1 ? `<div class="seo-dr-tabs">${tabs.map((t) => `<button type="button" class="seo-dr-tab${t === tab ? " is-on" : ""}" data-drtab="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
    ${body}
    ${notes.filter(Boolean).length ? `<p class="seo-note" style="margin:6px 0 0">${esc(notes.filter(Boolean).join(" "))}</p>` : ""}
    ${tip ? `<div class="seo-dr-tip">${tip}</div>` : ""}
    <div class="seo-w-acts"><button class="seo-btn on" type="button" data-drask="${esc(ask)}">Ask the Advisor about this</button>
      <span class="seo-note">Click a row to see what's behind it.</span></div>
    ${themes}
  </div>`;
}

/* ---------- styles ---------- */

const CSS = `
.seo-dr{border-color:#bfdbfe;box-shadow:0 4px 16px rgba(37,99,235,.06)}
.seo-dr-sum{margin:4px 0 0;font-size:14px;line-height:1.5}
.seo-dr-tabs{display:inline-flex;gap:4px;margin:10px 0 6px;padding:3px;border-radius:10px;background:#f1f5f9}
.seo-dr-tab{border:0;background:none;padding:5px 12px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;color:inherit}
.seo-dr-tab.is-on{background:var(--card,#fff);box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:600}
.seo-dr-t{border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow:hidden}
.seo-dr-r{display:grid;gap:8px;align-items:center;padding:7px 12px;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-dr-r:first-child{border-top:0}
.seo-dr-r.is-h{background:#f8fafc;font-size:12px;color:var(--text-muted,#6b7280);font-weight:600}
.seo-dr-r > span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-dr-r > span:not(:first-child){text-align:right}
.seo-dr-r.is-x{cursor:pointer}
.seo-dr-r.is-x:hover{background:#f8fbff}
.seo-dr-r.is-x:focus-visible{outline:2px solid var(--accent,#2563eb);outline-offset:-2px}
.seo-dr-r.is-open{background:#eff6ff;font-weight:600}
.seo-dr-car{display:inline-block;width:14px;font-style:normal;color:var(--text-muted,#6b7280)}
.seo-dr-x{padding:10px 14px 12px 30px;background:#f8fbff;border-top:1px solid #dbeafe}
.seo-dr-xh{margin:6px 0 4px;font-size:12px;font-weight:700;color:var(--text-muted,#6b7280)}
.seo-dr-xh:first-child{margin-top:0}
.seo-dr-mini{border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--card,#fff);overflow:hidden}
.seo-dr-mr{display:grid;gap:8px;align-items:center;padding:5px 10px;border-top:1px solid var(--border,#e5e7eb);font-size:12.5px}
.seo-dr-mr:first-child{border-top:0}
.seo-dr-mr.is-h{background:#f8fafc;font-size:11.5px;color:var(--text-muted,#6b7280);font-weight:600}
.seo-dr-mr > span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-dr-mr > span:not(:first-child){text-align:right}
.seo-dr-warn{margin:6px 0 0;padding:6px 10px;border-radius:6px;background:#fffbeb;color:#92400e;font-size:12.5px}
.seo-dr-tip{margin-top:10px;padding:8px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.5}
.seo-dr-th{margin-top:16px;padding-top:14px;border-top:1px dashed var(--border,#e5e7eb)}
.seo-dr-th h4{margin:0;font-size:14px}
.seo-dr-tr{display:grid;grid-template-columns:190px minmax(0,1fr) 72px;gap:12px;align-items:center;padding:7px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-dr-tr:first-of-type{border-top:0}
.seo-dr-tr > span:last-child{text-align:right}
.seo-dr-track{height:8px;border-radius:4px;background:#f1f5f9;overflow:hidden}
.seo-dr-track i{display:block;height:100%;border-radius:4px}
.seo-dr-ex{margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-dr-do{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px;line-height:1.5}
.seo-dr-do:first-of-type{border-top:0}
.seo-dr-n{flex:none;width:22px;height:22px;border-radius:50%;background:#eff6ff;color:#1d4ed8;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}
.seo-dr .seo-pr-pill.is-blue{background:#eff6ff;color:#1d4ed8}
@media (max-width:640px){.seo-dr-tr{grid-template-columns:120px minmax(0,1fr) 56px}}
@media (max-width:640px){
  .seo-dr-r{grid-template-columns:minmax(0,1fr) 70px 70px !important}.seo-dr-r > span:nth-child(n+4){display:none}
  .seo-dr-mr{grid-template-columns:minmax(0,1fr) 60px 60px !important}.seo-dr-mr > span:nth-child(n+4){display:none}
  .seo-dr-x{padding-left:14px}
}
`;

function injectCss() {
  if (document.getElementById("seo-drill-css")) return;
  const s = document.createElement("style");
  s.id = "seo-drill-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}