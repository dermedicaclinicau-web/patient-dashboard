// seo-drill.js — Overview: click a number card to see the searches and pages behind it.
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
 * o: { key, label, r, cmp (null when there's no comparison), compareMode ('prev' | 'year'), preset, W, tab, cur, prev }
 */
export function drillHtml(c, o) {
  injectCss();
  const h = c.h, esc = h.esc;
  const pick = pickWindow(o.W || {}, o.r, o.preset);
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
  const pageFor = (path) => c.data.pages.filter((p) => keyOf(p.path) === keyOf(path))
    .sort((a, b) => (b.m28?.impressions || 0) - (a.m28?.impressions || 0))[0] || null;
  const pageLink = (path) => {
    const p = pageFor(path);
    const t = short(titleOf(c.work, c.data, path));
    return p ? `<button class="seo-w-link" type="button" data-open="${esc(p.id)}" title="${esc(path)}">${esc(t)}</button>` : esc(t);
  };
  const qLink = (q) => `<button class="seo-w-link" type="button" data-kq="${esc(q)}">${esc(q)}</button>`;
  const table = (cols, rows) => {
    if (!rows.length) return `<p class="seo-note" style="margin:8px 0">Nothing notable for these dates.</p>`;
    const g = `grid-template-columns:minmax(0,1fr)${" 92px".repeat(cols.length - 1)}`;
    return `<div class="seo-dr-t"><div class="seo-dr-r is-h" style="${g}">${cols.map((x) => `<span>${x}</span>`).join("")}</div>
      ${rows.map((r) => `<div class="seo-dr-r" style="${g}">${r.map((x) => `<span>${x}</span>`).join("")}</div>`).join("")}</div>`;
  };
  const sortCmp = (arr) => arr.sort((a, b) => (hasCmp ? Math.abs(b.now - (b.was || 0)) - Math.abs(a.now - (a.was || 0)) : b.now - a.now));
  const cmpTable = (head, items, name, fmt = h.fmtInt) => table(
    hasCmp ? [head, "Now", "Before", "Change"] : [head, "Now"],
    items.map((x) => (hasCmp ? [name(x), fmt(x.now), `<span class="seo-note">${fmt(x.was || 0)}</span>`, signed(x.now - (x.was || 0))] : [name(x), fmt(x.now)])));
  const totalLine = (label, a, b, fmt) => {
    if (b == null) return `${label}: ${fmt(a)}.`;
    if (a === b) return `${label} held steady (${fmt(a)}).`;
    const p = b ? Math.abs(Math.round(((a - b) / b) * 100)) : null;
    return `${label} ${a > b ? "rose" : "fell"}${p != null ? ` ${p}%` : ""} (${fmt(a)} vs ${fmt(b)}).`;
  };

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

  /* ----- each card ----- */
  const key = o.key;
  const tabs = TABS[key] || ["Searches"];
  const tab = tabs.includes(o.tab) ? o.tab : tabs[0];
  let title = o.label, sum = "", tip = "", body = "", notes = [];
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
      const pg = sortCmp(pageClicks()).slice(0, 12);
      body = cmpTable("Page", pg, (x) => pageLink(x.path));
    } else {
      body = cmpTable("Search", qs, (x) => qLink(x.q));
      notes.push(searchesNote());
    }
    const drivers = (key === "clicks" ? sortCmp(pageClicks()) : qs)
      .filter((x) => hasCmp && prevV != null && Math.sign(x.now - (x.was || 0)) === Math.sign(curV - prevV) && x.now !== x.was).slice(0, 2);
    sum = esc(totalLine(o.label, curV ?? 0, hasCmp ? prevV : null, h.fmtInt)) + (drivers.length
      ? ` Biggest changes: ${drivers.map((x) => `${esc(short(x.q || titleOf(c.work, c.data, x.path), 36))} (${(x.now - (x.was || 0)) > 0 ? "+" : "−"}${h.fmtInt(Math.abs(x.now - (x.was || 0)))})`).join(" and ")}.` : "");
    tip = key === "brandClicks"
      ? "Brand searches follow how well people know the clinic (campaigns, Google Business Profile, word of mouth), so they aren't really SEO wins or losses."
      : hasCmp && prevV != null && curV < prevV
        ? "Start with the page or search that lost the most: open it to see why, or ask the Advisor what to do."
        : "Look at what's working on the pages that gained, and do the same on similar pages.";
  }

  else if (key === "impressions") {
    title = "Where the site is being seen";
    const fresh = Q.filter((x) => hasCmp && (x.pi || 0) === 0 && x.i >= 50);
    if (tab === "Pages") {
      const pg = c.data.pages.map((p) => ({ path: p.path, now: p.m28?.impressions || 0, was: hasCmp ? p.prev28?.impressions || 0 : null }));
      body = cmpTable("Page", sortCmp(pg.filter((x) => x.now + (x.was || 0) > 0)).slice(0, 12), (x) => pageLink(x.path));
      notes.push("Pages: the last 28 days vs the 28 before.");
    } else {
      const qs = sortCmp(Q.filter((x) => x.i + (x.pi || 0) > 0).map((x) => ({ ...x, now: x.i, was: x.pi }))).slice(0, 12);
      body = cmpTable("Search", qs, (x) => qLink(x.q) + ((x.pi || 0) === 0 && hasCmp && x.i > 0 ? ` <span class="seo-pr-pill is-green">new</span>` : ""));
      notes.push(searchesNote());
    }
    sum = esc(totalLine("Impressions", o.cur.impressions, hasCmp ? o.prev?.impressions : null, h.fmtInt)) +
      (fresh.length ? ` ${fresh.length} search${fresh.length === 1 ? " is" : "es are"} new, with 50 or more impressions.` : "");
    tip = fresh.length
      ? `New searches can show growing demand. If a big one (like “${esc(fresh.sort((a, b) => b.i - a.i)[0].q)}”) has no page that answers it well, ask the Advisor for a page or FAQ.`
      : "Impressions show demand. Searches seen more often but not clicked are worth a better title and description.";
  }

  else if (key === "ctr") {
    title = "Seen near the top of Google, but rarely clicked";
    const missed = (i, cl, pos) => Math.max(0, Math.round(i * EXP_CTR[Math.max(0, Math.min(9, Math.round(pos) - 1))] - cl));
    if (tab === "Pages") {
      const pg = c.data.pages.filter((p) => (p.m28?.impressions || 0) >= 200 && p.m28?.position != null && p.m28.position <= 10)
        .map((p) => ({ p, miss: missed(p.m28.impressions, p.m28.clicks, p.m28.position) })).filter((x) => x.miss > 0)
        .sort((a, b) => b.miss - a.miss).slice(0, 12);
      body = table(["Page", "Impr.", "Position", "CTR", "Missed clicks"], pg.map((x) => [pageLink(x.p.path), h.fmtInt(x.p.m28.impressions),
        h.fmtPos(x.p.m28.position), h.fmtPct(x.p.m28.ctr), `<b>≈ ${h.fmtInt(x.miss)}</b>`]));
      notes.push("Pages: the last 28 days.");
    } else {
      const qs = Q.filter((x) => !x.brand && x.i >= 100 && x.pos != null && x.pos <= 10)
        .map((x) => ({ ...x, miss: missed(x.i, x.c, x.pos) }))
        .filter((x) => x.c / x.i < EXP_CTR[Math.max(0, Math.round(x.pos) - 1)] * 0.5).sort((a, b) => b.miss - a.miss).slice(0, 12);
      body = table(["Search", "Impr.", "Position", "CTR", "Missed clicks"], qs.map((x) => [qLink(x.q), h.fmtInt(x.i), h.fmtPos(x.pos),
        h.fmtPct(x.i ? x.c / x.i : 0), `<b>≈ ${h.fmtInt(x.miss)}</b>`]));
      notes.push(searchesNote());
      sum = qs.length ? `${qs.length} search${qs.length === 1 ? " is" : "es are"} seen on page 1 but rarely clicked: about ${h.fmtInt(qs.reduce((a, x) => a + x.miss, 0))} clicks are being missed.` : "";
    }
    sum = esc(totalLine("CTR", o.cur.ctr, hasCmp ? o.prev?.ctr : null, h.fmtPct)) + (sum ? " " + esc(sum) : "");
    tip = "Rewriting the title and description for these is quick, and often adds clicks within a few weeks. The Advisor can draft them.";
  }

  else if (key === "position") {
    title = "How rankings moved";
    const close = Q.filter((x) => !x.brand && x.i >= 50 && x.pos != null && x.pos >= 8 && x.pos <= 20).length;
    const moved = (now, was) => (was == null || now == null ? "" : `<span class="seo-d ${was - now > 0 ? "up" : was - now < 0 ? "down" : "flat"}">${
      was - now > 0 ? "▲ " : was - now < 0 ? "▼ " : ""}${Math.abs(was - now).toFixed(1)}</span>`);
    if (tab === "Pages") {
      const pg = c.data.pages.filter((p) => (p.m28?.impressions || 0) >= 100 && p.m28?.position != null && p.prev28?.position != null)
        .sort((a, b) => Math.abs(b.prev28.position - b.m28.position) - Math.abs(a.prev28.position - a.m28.position)).slice(0, 12);
      body = table(["Page", "Now", "Before", "Moved"], pg.map((p) => [pageLink(p.path), h.fmtPos(p.m28.position),
        `<span class="seo-note">${h.fmtPos(p.prev28.position)}</span>`, moved(p.m28.position, p.prev28.position)]));
      notes.push("Pages: the last 28 days vs the 28 before.");
    } else {
      const qs = Q.filter((x) => !x.brand && x.i >= 50 && x.pos != null && (!hasCmp || x.ppos != null))
        .sort((a, b) => (hasCmp ? Math.abs(b.ppos - b.pos) - Math.abs(a.ppos - a.pos) : b.i - a.i)).slice(0, 12);
      body = table(hasCmp ? ["Search", "Now", "Before", "Moved"] : ["Search", "Position", "Impr."], qs.map((x) => hasCmp
        ? [qLink(x.q), h.fmtPos(x.pos), `<span class="seo-note">${h.fmtPos(x.ppos)}</span>`, moved(x.pos, x.ppos)]
        : [qLink(x.q), h.fmtPos(x.pos), h.fmtInt(x.i)]));
      notes.push(searchesNote());
    }
    const a = o.cur.position, b = hasCmp ? o.prev?.position : null;
    sum = a == null ? "" : b == null ? `Average position: ${h.fmtPos(a)}.`
      : `Average position ${a < b ? "improved" : a > b ? "slipped" : "held"} (${h.fmtPos(a)} vs ${h.fmtPos(b)}; lower is better).`;
    sum = esc(sum);
    tip = close ? `${close} search${close === 1 ? " sits" : "es sit"} between positions 8 and 20, where a small push brings many more clicks. Opportunities and the Advisor can plan them.`
      : "Positions move a little every week. Watch the searches that matter for your priority pages.";
  }

  else if (key === "sessions" || key === "conversions") {
    const isK = key === "conversions";
    title = isK ? "The landing pages behind bookings and enquiries" : "Where visitors from Google land";
    const rows = sortCmp(G.map((x) => ({ ...x, now: isK ? x.k : x.s, was: isK ? x.pk : x.ps })).filter((x) => x.now + (x.was || 0) > 0)).slice(0, 12);
    body = table(hasCmp ? ["Landing page", "Now", "Before", "Change", isK ? "Per 100 visits" : "Engaged"] : ["Landing page", "Now", isK ? "Per 100 visits" : "Engaged"],
      rows.map((x) => {
        const extra = isK ? (x.s ? (Math.round((x.k / x.s) * 1000) / 10).toFixed(1) : "—") : (x.s ? Math.round((x.e / x.s) * 100) + "%" : "—");
        return hasCmp ? [pageLink(x.path), h.fmtInt(x.now), `<span class="seo-note">${h.fmtInt(x.was || 0)}</span>`, signed(x.now - (x.was || 0)), extra]
          : [pageLink(x.path), h.fmtInt(x.now), extra];
      }));
    notes.push(searchesNote().replace("Search details", "Landing page details"));
    const cs = isK ? o.cur.conversions : o.cur.sessions, ps = hasCmp ? (isK ? o.prev?.conversions : o.prev?.sessions) : null;
    sum = esc(totalLine(isK ? "Key events from Google visitors" : "Visits from Google", cs, ps, h.fmtInt));
    const sessDrop = hasCmp && o.prev?.sessions ? (o.cur.sessions - o.prev.sessions) / o.prev.sessions : 0;
    const keyDrop = hasCmp && o.prev?.conversions ? (o.cur.conversions - o.prev.conversions) / o.prev.conversions : 0;
    tip = isK
      ? (keyDrop <= -0.4 && sessDrop > -0.15
        ? "<b>Key events fell much more than visits.</b> That usually means a booking button, form or GA4 key event stopped working. Test a booking on the website, and check GA4 → Admin → Key events."
        : "These pages bring bookings and enquiries. Link to them from your guides and blog posts.")
      : "Pages with a low engaged rate may not match what people expected. Check that the first screen answers the search.";
  }

  else if (key === "aiSessions") {
    title = "Visits from AI assistants";
    if (tab === "Pages") {
      const by = new Map();
      A.forEach((x) => { const k = keyOf(x.path); const y = by.get(k) || { path: x.path, now: 0, was: hasCmp ? 0 : null }; y.now += x.s; if (hasCmp) y.was += x.ps || 0; by.set(k, y); });
      body = cmpTable("Page", sortCmp([...by.values()]).slice(0, 12), (x) => pageLink(x.path));
    } else {
      const by = new Map();
      A.forEach((x) => { const y = by.get(x.src) || { src: x.src, now: 0, was: hasCmp ? 0 : null }; y.now += x.s; if (hasCmp) y.was += x.ps || 0; by.set(x.src, y); });
      body = cmpTable("Assistant", sortCmp([...by.values()]).slice(0, 12), (x) => esc(x.src));
    }
    notes.push(searchesNote().replace("Search details", "AI assistant details"));
    sum = esc(totalLine("AI assistant visits", o.cur.aiSessions, hasCmp ? o.prev?.aiSessions : null, h.fmtInt));
    tip = "These pages are being recommended by AI assistants like ChatGPT and Perplexity. Keep them accurate and up to date, with clear answers near the top.";
  }

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
      <span class="seo-note">Click a search to see it in Keywords, or a page for its details.</span></div>
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
.seo-dr-tip{margin-top:10px;padding:8px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.5}
@media (max-width:640px){.seo-dr-r{grid-template-columns:minmax(0,1fr) 70px 70px !important}.seo-dr-r > span:nth-child(n+4){display:none}}
`;

function injectCss() {
  if (document.getElementById("seo-drill-css")) return;
  const s = document.createElement("style");
  s.id = "seo-drill-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}