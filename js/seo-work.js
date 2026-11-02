// seo-work.js — SEO Phase 2: Keywords, Opportunities, Change log, Settings.
// Used by seo.js. Reads seo_state/queries, seo_queries, seo_settings/main, seo_opps, seo_log.

import { db, auth } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { loadHealth, viewHealth, healthPanelHtml } from "./seo-health.js?v=2";
import { loadAudience, viewAudience } from "./seo-audience.js";

const BRAND = "__brand", OTHER = "__other", ALL = "__all", PRI = "__priority";
const EXP_CTR = [0.28, 0.16, 0.11, 0.08, 0.06, 0.045]; // rough click rate for positions 1–6
const PER_TYPE = 40;                                     // open opportunities shown per type
const OPP = {
  striking: { label: "Close to page 1", tone: "blue" },
  ctr:      { label: "Low click rate", tone: "amber" },
  decay:    { label: "Losing clicks", tone: "red" },
  cannibal: { label: "Pages competing", tone: "violet" },
  area: { label: "Local area", tone: "green" },
};
const STATUS = { open: "To do", doing: "Doing", done: "Done", ignored: "Ignored" };
const LOG_TYPES = ["Content", "Title / meta", "New page", "Technical", "Links", "Other"];
const LOG_TITLE = {
  striking: (o) => `Improved the page for “${o.title}”`,
  ctr: (o) => `Rewrote title and description for “${o.title}”`,
  decay: (o) => `Refreshed ${o.title}`,
  cannibal: (o) => `Fixed pages competing for “${o.title}”`,
  area: (o) => `Improved local content for ${o.title}`,
};
// [name, concern words, treatment words]. Specific topics first: a search goes into the first topic that matches.
const SUGGESTED = {
  topics: [
    ["Pigmentation", "pigmentation, melasma, sun spot, sunspot, age spot, freckle, dark spot, dark patch, dark neck, discolo", "pico, cosmelan, dermamelan"],
    ["Rosacea & redness", "rosacea, redness, capillar, flushing, angioma", "ipl, bbl, vascular laser"],
    ["Acne & scarring", "acne, scar, breakout, pimple", ""],
    ["Skin tightening", "crepey, sagging, loose skin, jowl, ageing, aging", "ultherapy, ulthera, hifu, exilis, tightening"],
    ["Body", "stretch mark, cellulite", "fat freezing, coolsculpt, cryolipolysis, fat reduction"],
    ["Anti-wrinkle", "wrinkle, frown, crow's feet, crows feet, fine lines", "anti-wrinkle, botox"],
    ["Fillers", "lips, cheek, jawline, chin", "filler"],
    ["Needling & laser", "", "needling, laser, resurfacing, fraxel"],
    ["Peels & facials", "", "peel, facial, hydrafacial, dermaplan"],
    ["Skin care", "", "skincare, skin care, serum, sunscreen, spf, retinol, vitamin c, moisturiser"],
  ].map(([name, cw, tw]) => {
    const split = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
    return { name, concern: split(cw), treatment: split(tw) };
  }),
  brand: ["dermedica"],
};

// Words that name a treatment rather than a skin concern. Used once, to sort topic words saved before the split.
const TREATMENT_WORDS = ["laser", "ipl", "bbl", "pico", "fraxel", "resurfac", "peel", "facial", "dermaplan", "needling", "filler",
  "inject", "anti-wrinkle", "botox", "dysport", "ultherapy", "ulthera", "hifu", "exilis", "cosmelan", "dermamelan", "prp", "booster",
  "profhilo", "thread", "coolsculpt", "fat freez", "cryolipo", "serum", "sunscreen", "spf", "retinol", "vitamin c", "moisturis",
  "skincare", "skin care", "cream", "tightening", "treatment", "removal", "therapy"];
const guessKind = (word) => (TREATMENT_WORDS.some((t) => word.includes(t)) ? "treatment" : "concern");

// Same starting list as SEO3_COMPLIANCE_ in Seo3.gs
const COMPLIANCE = [
  ["botox", "Prescription medicine brand name (TGA)"], ["dysport", "Prescription medicine brand name (TGA)"],
  ["xeomin", "Prescription medicine brand name (TGA)"], ["letybo", "Prescription medicine brand name (TGA)"],
  ["relatox", "Prescription medicine brand name (TGA)"], ["botulinum", "Prescription medicine (TGA)"],
  ["guarantee", "Promises a result (AHPRA)"], ["guaranteed", "Promises a result (AHPRA)"],
  ["risk-free", "Downplays risk (AHPRA)"], ["risk free", "Downplays risk (AHPRA)"],
  ["pain-free", "Downplays risk (AHPRA)"], ["pain free", "Downplays risk (AHPRA)"], ["painless", "Downplays risk (AHPRA)"],
  ["no downtime", "Downplays risk (AHPRA)"], ["completely safe", "Downplays risk (AHPRA)"], ["100% safe", "Downplays risk (AHPRA)"],
  ["miracle", "Creates unrealistic expectations (AHPRA)"], ["permanent results", "Creates unrealistic expectations (AHPRA)"],
  ["lunchtime", "Trivialises a procedure (AHPRA)"],
].map(([word, why]) => ({ word, why }));

/* ---------- small helpers ---------- */

const norm = (s) => String(s || "").trim().toLowerCase();
const uid = () => auth.currentUser?.uid || "";
const myName = (c) => c.staff?.name || c.staff?.displayName || auth.currentUser?.displayName || "";
const todayPerth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(new Date());
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const tsDate = (t) => (t?.toDate ? t.toDate() : t instanceof Date ? t : null);
const errMsg = (e) => (/permission/i.test(e?.message || "") ? "You don't have permission to do that." : e?.message || String(e));
const todo = (t) => `<p class="seo-w-todo"><strong>What to do:</strong> ${t}</p>`;
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || ((tsDate(b.createdAt)?.getTime() || 0) - (tsDate(a.createdAt)?.getTime() || 0));

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const oppId = (key) => "o_" + hash(key) + hash("|" + key);

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}

/** Permission check. Uses opts.can if app.js passes one, otherwise the staff record. Database rules have the final say. */
export function makeCan(opts = {}) {
  if (typeof opts.can === "function") return (k) => !!opts.can(k);
  const s = opts.staff || {};
  const p = s.perms || s.permissions || s.access || null;
  return (k) => {
    if (Array.isArray(p)) return p.includes(k);
    if (p && typeof p === "object" && k in p) return !!p[k];
    if (/admin/i.test(String(s.role || ""))) return true;
    return k !== "seo.manage";
  };
}

/* ---------- data ---------- */

const wcache = { v: null, pending: null };

export async function loadWork(force) {
  injectWorkCss();
  if (wcache.v && !force) return wcache.v;
  if (wcache.pending) return wcache.pending;
  wcache.pending = (async () => {
    const w = { queries: [], qs: null, settings: null, wp: null, opps: {}, log: [], errors: {}, prefill: null, health: null, audience: null };
    const safe = async (k, fn) => { try { await fn(); } catch (e) { w.errors[k] = e.message || String(e); } };
    await Promise.all([
      safe("queries", async () => {
        const s = await getDoc(doc(db, "seo_state", "queries"));
        if (!s.exists()) return;
        w.qs = s.data();
        if (!w.qs.build) return;
        const snap = await getDocs(query(collection(db, "seo_queries"), where("build", "==", w.qs.build)));
        snap.docs.map((d) => d.data()).sort((a, b) => a.n - b.n)
          .forEach((c) => JSON.parse(c.rows || "[]").forEach((r) => w.queries.push(rowToQ(r))));
      }),
      safe("health", async () => { w.health = await loadHealth(); }),
      safe("audience", async () => { w.audience = await loadAudience(); }),
      safe("settings", async () => {
        const s = await getDoc(doc(db, "seo_settings", "main"));
        if (s.exists()) w.settings = s.data();
      }),
      safe("wp", async () => {   // page titles from WordPress (SeoWp.gs)
        const s = await getDoc(doc(db, "seo_settings", "wp"));
        if (!s.exists()) return;
        const d = s.data();
        let pages = [];
        try { pages = JSON.parse(d.pages || "[]"); } catch { pages = []; }
        w.wp = { pages: Array.isArray(pages) ? pages : [], at: d.at || null, problems: d.problems || "" };
      }),
      safe("opps", async () => {
        const s = await getDocs(collection(db, "seo_opps"));
        s.docs.forEach((d) => { w.opps[d.id] = d.data(); });
      }),
      safe("log", async () => {
        const s = await getDocs(collection(db, "seo_log"));
        w.log = s.docs.map((d) => ({ id: d.id, ...d.data() }))
          .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date || "")).sort(byDateDesc);
      }),
    ]);
    classify(w);
    return w;
  })();
  try { const v = await wcache.pending; wcache.v = v; return v; } finally { wcache.pending = null; }
}

function rowToQ(r) {
  const [q, c, i, pos, pc, pi, ppos, pages, ppages] = r;
  const list = (a) => (a || []).map(([path, c2, i2, p2]) => ({ path, c: c2, i: i2, pos: p2 }));
  return {
    q: String(q), c, i, pos, pc, pi, ppos, ctr: i ? c / i : 0,
    pages: list(pages),
    ppages: Array.isArray(ppages) ? list(ppages) : null,   // null: data from before this was added
  };
}

function settingsOf(w) {
  const s = w.settings || {};
  return {
    topics: (Array.isArray(s.topics) ? s.topics : []).map((t) => {
      const list = (a) => [...new Set((Array.isArray(a) ? a : []).map(norm).filter(Boolean))];
      const split = Array.isArray(t.concern) || Array.isArray(t.treatment);
      const all = list(t.words);
      // Saved before the split: sort the words as a starting point
      const concern = split ? list(t.concern) : all.filter((x) => guessKind(x) === "concern");
      const treatment = split ? list(t.treatment).filter((x) => !concern.includes(x)) : all.filter((x) => guessKind(x) === "treatment");
      return {
        name: String(t.name || "").trim(), words: split ? [...concern, ...treatment] : all, concern, treatment,
        pages: (Array.isArray(t.pages) ? t.pages : []).map(String).filter(Boolean), guessed: !split,
      };
    }).filter((t) => t.name),
    brand: (s.brand || []).map(norm).filter(Boolean),
    keyPages: (Array.isArray(s.keyPages) ? s.keyPages : []).map(String).filter(Boolean),
    compliance: Array.isArray(s.compliance)   // null = never saved (the suggested list applies)
      ? s.compliance.map((x) => ({ word: String(x?.word || "").trim(), why: String(x?.why || "").trim() })).filter((x) => x.word)
      : null,
  };
}

function classify(w) {
  const st = settingsOf(w);
  for (const q of w.queries) {
    const l = q.q.toLowerCase();
    q.kind = "";
    if (st.brand.some((b) => l.includes(b))) { q.topic = BRAND; continue; }
    const t = st.topics.find((t) => t.words.some((x) => l.includes(x)));
    q.topic = t ? t.name : OTHER;
    if (t) {   // found by the problem ("melasma") or by the treatment ("cosmelan peel")?
      const tr = t.treatment.some((x) => l.includes(x)), co = t.concern.some((x) => l.includes(x));
      q.kind = tr && co ? "both" : tr ? "treatment" : "concern";
    }
  }
}

/* ---------- Page panel: why a page changed, and the pages it shares searches with ---------- */

export const npath = (s) => String(s || "").split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase() || "/";

// Priority pages: keyPages (also read by Site health) + priorityInfo [{ path, target, goal, support, note }]
export function prioritySettings(w) {
  const s = w?.settings || {};
  return {
    paths: (Array.isArray(s.keyPages) ? s.keyPages : []).map(String).filter(Boolean),
    info: (Array.isArray(s.priorityInfo) ? s.priorityInfo : []).filter((x) => x && x.path),
  };
}
// Quick lookups for the tabs: which pages are priority pages, and which searches are their targets
function priorityLookup(w) {
  const { paths, info } = prioritySettings(w);
  const pathSet = new Set(paths.map(npath));
  const targets = new Map();
  for (const x of info) if (x.target && pathSet.has(npath(x.path))) targets.set(String(x.target).toLowerCase(), x.path);
  return {
    any: pathSet.size > 0,
    isPage: (path) => !!path && pathSet.has(npath(path)),
    targetOf: (q) => targets.get(String(q || "").toLowerCase()) || "",
  };
}

// ★ next to a page in the tabs. Admins can click it (seo.js handles data-star); everyone else only sees ★.
function star(c, path) {
  if (!path) return "";
  const on = priorityLookup(c.work).isPage(path);
  const e = c.h.esc;
  if (!c.isAdmin) return on ? `<span class="seo-star is-on" title="Priority page">★</span>` : "";
  return `<button type="button" class="seo-star${on ? " is-on" : ""}" data-star="${e(path)}" aria-pressed="${on}"
    title="${on ? "Priority page. Click to unstar" : "Star as a priority page"}">${on ? "★" : "☆"}</button>`;
}

// "/neck-pigmentation-perth/" → "Neck pigmentation perth" (until WordPress gives the real title)
export function prettyPath(p) {
  let s = String(p || "").split("?")[0].replace(/\/+$/, "").split("/").pop();
  if (!s) return "Home page";
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  s = s.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Every page: WordPress's list (with titles) plus pages Google shows, with 28-day clicks
export function pageIndex(w, data) {
  if (w._pidx && w._pidx.data === data && w._pidx.wp === w.wp) return w._pidx;
  const map = new Map();
  const hasWp = !!(w.wp && w.wp.pages.length);
  for (const p of w.wp?.pages || []) {
    const k = npath(p.path);
    if (!map.has(k)) map.set(k, { path: p.path, title: p.title || "", clicks: 0, impr: 0, wp: true });
  }
  for (const p of data?.pages || []) {
    const k = npath(p.path);
    const x = map.get(k);
    if (x) { x.clicks += p.m28.clicks || 0; x.impr += p.m28.impressions || 0; continue; }
    if (hasWp && (!(p.m28.impressions > 0) || p.path.includes("?"))) continue;   // old addresses nobody sees
    map.set(k, { path: p.path, title: "", clicks: p.m28.clicks || 0, impr: p.m28.impressions || 0, wp: hasWp ? false : null });
  }
  const list = [...map.values()].sort((a, b) => b.clicks - a.clicks || b.impr - a.impr || a.path.localeCompare(b.path));
  w._pidx = { data, wp: w.wp, hasWp, list, get: (path) => map.get(npath(path)) || null };
  return w._pidx;
}
export const titleOf = (w, data, path) => (w && pageIndex(w, data).get(path)?.title) || prettyPath(path);

export function priorityOf(w, path) {
  const { paths, info } = prioritySettings(w);
  const hit = paths.find((x) => npath(x) === npath(path));
  if (!hit) return null;
  const meta = info.find((x) => npath(x.path) === npath(hit)) || {};
  return { target: "", goal: "", support: "", note: "", ...meta, path: hit };
}
const signed = (n) => { const r = Math.round(n); return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r).toLocaleString("en-AU"); };
const toneOf = (n) => (Math.round(n) > 0 ? "up" : Math.round(n) < 0 ? "down" : "flat");

// Splits a page's click change (last 28 days vs the 28 before) into: fewer/more searches, clicks moving between
// pages on the site, ranking, and click rate. Only searches Google shows (10+ impressions, top 5 pages each).
export function pageStory(w, p) {
  const me = npath(p.path);
  const mine = (list) => (list || []).find((x) => npath(x.path) === me) || null;
  const b = { demand: 0, shift: 0, rank: 0, ctr: 0 };
  const shiftBy = new Map();
  const related = new Map();
  const moves = [];
  let seen = 0;

  for (const q of w.queries) {
    const now = mine(q.pages), was = mine(q.ppages);
    if (!now && !was) continue;
    const Pc = now?.c || 0, Pp = was?.c || 0;
    seen += Pc - Pp;

    // 1. What this page would have got if only the number of searches had changed
    const expected = q.pi > 0 ? Pp * (q.i / q.pi) : Pp;
    b.demand += expected - Pp;
    let rem = Pc - expected;

    // 2. Clicks that moved to (or from) other pages on the site for this search
    const others = new Map();
    const put = (x, k) => {
      const key = npath(x.path);
      if (key === me) return;
      const o = others.get(key) || { path: x.path, now: null, was: null };
      o[k] = x;
      others.set(key, o);
    };
    q.pages.forEach((x) => put(x, "now"));
    (q.ppages || []).forEach((x) => put(x, "was"));
    let up = 0, down = 0;
    for (const o of others.values()) {
      o.d = (o.now?.c || 0) - (o.was?.c || 0);
      if (o.d > 0) up += o.d; else down -= o.d;
    }
    if (rem < 0 && up > 0) {
      const take = Math.min(-rem, up);
      b.shift -= take; rem += take;
      for (const o of others.values()) if (o.d > 0) shiftBy.set(o.path, (shiftBy.get(o.path) || 0) - (take * o.d) / up);
    } else if (rem > 0 && down > 0) {
      const take = Math.min(rem, down);
      b.shift += take; rem -= take;
      for (const o of others.values()) if (o.d < 0) shiftBy.set(o.path, (shiftBy.get(o.path) || 0) + (take * -o.d) / down);
    }

    // 3. What's left: ranking if the position moved half a place or more, otherwise click rate
    const worse = (was && !now) || (now?.pos != null && was?.pos != null && now.pos - was.pos >= 0.5);
    const better = (now && !was) || (now?.pos != null && was?.pos != null && was.pos - now.pos >= 0.5);
    if ((rem < 0 && worse) || (rem > 0 && better)) b.rank += rem; else b.ctr += rem;

    // Pages that show for the same searches
    for (const o of others.values()) {
      const k = npath(o.path);
      const r = related.get(k) || { path: o.path, n: 0, imp: 0, myNow: 0, myWas: 0, thNow: 0, thWas: 0, myPw: 0, myPi: 0, thPw: 0, thPi: 0 };
      r.n++; r.imp += q.i;
      r.myNow += Pc; r.myWas += Pp; r.thNow += o.now?.c || 0; r.thWas += o.was?.c || 0;
      if (now?.pos != null) { r.myPw += now.pos * now.i; r.myPi += now.i; }
      if (o.now?.pos != null) { r.thPw += o.now.pos * o.now.i; r.thPi += o.now.i; }
      related.set(k, r);
    }
    const rival = [...others.values()].filter((o) => o.now).sort((a, c2) => c2.now.c - a.now.c || c2.now.i - a.now.i)[0] || null;
    moves.push({ q: q.q, Pc, Pp, now, was, rival });
  }
  return { b, seen, shiftBy, moves, related: [...related.values()].sort((a, c2) => c2.imp - a.imp) };
}

// Starting details for a new priority page: its busiest non-brand search, and the page it shares the most searches with
export function suggestPriority(w, data, path) {
  const me = npath(path);
  let best = null;
  for (const q of w.queries) {
    if (q.topic === BRAND) continue;
    const x = q.pages.find((y) => npath(y.path) === me);
    if (x && (!best || x.i > best.i)) best = { q: q.q, i: x.i, pos: x.pos };
  }
  let support = "";
  const p = (data?.pages || []).find((x) => npath(x.path) === me);
  if (p && w.queries.some((q) => q.ppages)) {
    const r = pageStory(w, p).related[0];
    if (r && r.imp >= 50) support = r.path;
  }
  return { target: best ? best.q : "", goal: best && best.pos != null && best.pos <= 5 ? "top3" : "page1", support };
}

/* ---------- Action plan: step by step, on and off the page ---------- */

const STOPW = new Set(["in", "for", "the", "a", "an", "of", "and", "to", "on", "with", "near", "me", "my", "is", "are", "what", "how", "best"]);
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOPW.has(t));
const hasWords = (text, phrase) => {
  const t = String(text || "").toLowerCase();
  const ws = words(phrase);
  return ws.length > 0 && ws.every((x) => t.includes(x.replace(/s$/, "")));
};
const SMALLW = new Set(["in", "for", "and", "of", "the", "to", "with", "on", "a", "or", "vs"]);
const titleCase = (s) => String(s).replace(/[a-z0-9']+/gi, (m, i) =>
  (i && SMALLW.has(m.toLowerCase()) ? m.toLowerCase() : m.charAt(0).toUpperCase() + m.slice(1)));
const QUESTION = /\b(how|what|why|when|does|do|can|is|are|should|which|vs|or|safe|hurt|last|long)\b/;
const PRICE = /\b(cost|costs|price|prices|pricing|how much|cheap|fee|fees)\b/;
const EFFORT_TIP = { Quick: "Under 30 minutes", Medium: "A few hours", Bigger: "A day, or the website person" };
const plainOf = (html) => String(html).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

function planHtml(w, p, s, h, open, linksTo) {
  const me = npath(p.path);
  const hpOf = (path) => (w.health?.pages || []).find((x) => npath(x.path) === npath(path)) || null;
  const hp = hpOf(p.path);
  const banned = (settingsOf(w).compliance || COMPLIANCE).map((x) => x.word);
  const flagged = (t) => banned.find((b) =>
    new RegExp(`(^|[^a-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(t)) || "";
  const q = (t) => `“${h.esc(t)}”`;

  // The searches this page shows for (brand searches left out), busiest first
  const mine = [];
  for (const x of w.queries) {
    if (x.topic === BRAND) continue;
    const pg = x.pages.find((y) => npath(y.path) === me);
    if (pg) mine.push({ q: x.q, i: pg.i, c: pg.c, pos: pg.pos });
  }
  mine.sort((a, b) => b.i - a.i);
  const usable = mine.filter((m) => !flagged(m.q));
  const pri = priorityOf(w, p.path);
  const target = pri?.target && !flagged(pri.target) ? pri.target : "";
  const main = target || (usable[0] || {}).q || "";
  const topBad = mine[0] && flagged(mine[0].q) ? mine[0] : null;
  const others = usable.filter((m) => m.q !== main).slice(0, 5).map((m) => m.q);
  const questions = usable.filter((m) => QUESTION.test(m.q)).slice(0, 4).map((m) => m.q);
  const priceQ = usable.find((m) => PRICE.test(m.q));

  // The page taking its clicks, or else the related page ranking above it
  const shifts = [...s.shiftBy.entries()].filter(([, v]) => v <= -1).sort((a, b) => a[1] - b[1]);
  const r0 = s.related[0];
  const rival = pri?.support ? pri.support : shifts[0] ? shifts[0][0]
    : r0 && r0.thPi && r0.myPi && r0.thPw / r0.thPi < r0.myPw / r0.myPi ? r0.path : "";
  const rhp = rival ? hpOf(rival) : null;

  const on = [], between = [], off = [], then = [];
  const step = (list, effort, html) => list.push({ effort, html });

  /* On this page (anything that stops the rest working comes first) */
  const g = hp?.google;
  if (g && !g.err && g.v !== "PASS") {
    step(on, "Quick", `Get the page into Google first: in Search Console open URL Inspection for it and press <strong>Request indexing</strong>. Google says: ${h.esc(g.cs || "not indexed")}.${
      g.link ? ` <a class="seo-w-link" href="${h.esc(g.link)}" target="_blank" rel="noopener">Open it ↗</a>` : ""}`);
  }
  const wording = (hp?.issues || []).filter((i) => i.group === "wording" && i.status !== "ignored");
  if (wording.length) {
    step(on, "Quick", `Fix the advertising wording first: ${wording.map((i) => h.esc(i.msg)).join("; ")}. Rankings don't matter if the page breaks TGA or AHPRA rules.`);
  }
  if (topBad) {
    step(on, "Quick", `The busiest search for this page is ${q(topBad.q)}, but “${h.esc(flagged(topBad.q))}” can't be used in your advertising. Use the general name (e.g. “anti-wrinkle injections”) in titles and headings instead of chasing that word.`);
  }
  if (!hp) {
    step(on, "Quick", `Add this page to <a class="seo-w-link" href="#/seo/settings">SEO → Settings → Key pages</a> so its title, heading, wording, links and speed are checked every night. Until then, check the steps below yourself.`);
  }
  if (main) {
    const t = titleCase(main);
    const suggestion = (t + " | Dermedica").length <= 60 ? t + " | Dermedica" : t;
    if (!hp) step(on, "Quick", `Make sure the page title starts with ${q(main)}, for example ${q(suggestion)}. Keep it under 60 characters.`);
    else if (!hp.title) step(on, "Quick", `Add a page title, for example ${q(suggestion)}.`);
    else if (!hasWords(hp.title, main)) {
      step(on, "Quick", `Change the page title so it starts with the main search, ${q(main)}. Now: ${q(hp.title)}. Try ${q(suggestion)} (${suggestion.length} characters; Google shows about 60).`);
    } else if (hp.title.length > 60) {
      step(on, "Quick", `Shorten the title to under 60 characters so Google doesn't cut it off. Now ${hp.title.length}: ${q(hp.title)}.`);
    }
    if (hp && (!hp.h1 || !hasWords(hp.h1Text, main))) {
      step(on, "Quick", hp.h1 ? `Change the main heading (H1) to say ${q(t)}. Now: ${q(hp.h1Text)}.`
        : `Add one main heading (H1) at the top that says ${q(t)}.`);
    }
    const d = hp ? String(hp.desc || "") : "";
    if (hp && (!d || !hasWords(d, main) || d.length > 160 || d.length < 70)) {
      step(on, "Quick", `Rewrite the meta description (120–155 characters): who it's for, what the treatment does, and how to book, using ${q(main)}. Don't promise results or say it's painless or risk-free.${
        d ? ` Now (${d.length} characters): ${q(d)}` : " There isn't one now."}`);
    }
  }
  const rWords = rhp?.words || 0;
  if (hp && hp.words && (hp.words < 600 || (rWords && hp.words < rWords * 0.7))) {
    step(on, "Bigger", `Add depth. The page has about ${h.fmtInt(hp.words)} words${rWords ? `; ${open(rival)} has about ${h.fmtInt(rWords)}` : ""}.
      Treatment pages that rank usually cover what it is, who it suits, how many sessions, downtime, when results show, risks and side effects, cost, and FAQs. Add what's missing, each under its own heading.`);
  }
  if (others.length) {
    step(on, "Medium", `Cover the other searches this page shows for, using the words in a heading or the first sentence of a section: ${others.map(q).join(", ")}.`);
  }
  if (questions.length) step(on, "Medium", `Add an FAQ section answering each in 2–3 sentences: ${questions.map(q).join(", ")}.`);
  if (priceQ) {
    step(on, "Medium", `People search ${q(priceQ.q)}. Add a “Cost” section with a price range or “from $…”, what changes the price, and whether a consultation is needed first. Prices are fine in health advertising when they're clear and include all costs.`);
  }
  step(on, "Quick", `Show who wrote or medically reviewed the page, and when (e.g. “Reviewed by [doctor's name], [qualifications], [month year]”). Google looks for this on health pages.`);
  const m28 = p.m28 || {};
  if (m28.sessions >= 30 && m28.conversions / m28.sessions < 0.02) {
    step(on, "Medium", `Make booking easier: ${h.fmtInt(m28.sessions)} people arrived from Google in 28 days, but only ${h.fmtInt(m28.conversions)} took a key action. Put a Book button and the phone number near the top, and again after the cost and FAQs.`);
  }
  const sp = hp?.speed;
  if (sp && sp.score != null && sp.score < 50) {
    step(on, "Bigger", `Speed it up (mobile score ${sp.score}/100): compress and resize the top image, use WebP, and remove sliders, pop-ups or plugins the page doesn't need.`);
  }
  if (hp?.noAlt) step(on, "Quick", `Add short alt text to ${hp.noAlt} image${hp.noAlt === 1 ? "" : "s"} saying what each shows.`);

  /* Between your pages */
  if (rival) {
    const l = linksTo(rival, p.path);
    step(between, "Quick", `Decide which page should own ${q(main || "these searches")}. Usually it's the treatment page people book from (this one), and ${open(rival)} stays the guide that answers questions.`);
    step(between, "Quick", `${l === true ? `${open(rival)} already links here: make sure the link text says` : `Add a link from ${open(rival)} to this page with the link text`} ${q(main || "the treatment name")}. Put it near the top and again at the end, with a line like “Ready to treat it? Book a consultation”.`);
    if (rhp?.title && main && hasWords(rhp.title, main)) {
      step(between, "Quick", `Take ${q(main)} out of ${open(rival)}'s title and main heading, and aim it at the question instead${
        questions[0] ? `, like ${q(titleCase(questions[0]))}` : ""}. Now: ${q(rhp.title)}.`);
    }
    if (linksTo(p.path, rival) === false) step(between, "Quick", `Link back from this page to ${open(rival)} (“Read our full guide”), so the two pages support each other.`);
    step(between, "Quick", `Don't delete or redirect ${open(rival)}: it's bringing in visitors. Just make the two pages' jobs clear.`);
  }
  const helpers = s.related.filter((r) => npath(r.path) !== npath(rival) && linksTo(r.path, p.path) === false).slice(0, 3);
  if (helpers.length) {
    step(between, "Quick", `Add links to this page from ${helpers.map((r) => open(r.path)).join(", ")}. They show for the same searches but don't link here.`);
  }
  step(between, "Medium", `Link to this page from 2–3 related blog posts and from the treatments menu, using ${q(main || "the treatment name")} as the link text.`);

  /* Off the site */
  const term = main ? titleCase(main.replace(/\bperth\b/gi, "").replace(/\s+/g, " ").trim()) || titleCase(main) : "this treatment";
  step(off, "Quick", `Google Business Profile: add “${h.esc(term)}” as a Service with a short description and a link to this page, and post about it once a month with a photo and the link.`);
  step(off, "Medium", `Ask patients for a Google review after their treatment (by email or text, with no incentive). Don't copy reviews onto the website or ads: AHPRA doesn't allow testimonials in advertising.`);
  step(off, "Bigger", `Get a few relevant links to this page: your booking profiles (e.g. HotDoc, HealthEngine), the product suppliers' “find a clinic” pages, and local business or community sites. Avoid paid link schemes.`);
  if (s.b.demand <= -5) {
    step(off, "Medium", `Fewer people are searching, so reach the people you already have: send this page to patients interested in ${h.esc(term.toLowerCase())} through Task Manager → Marketing.`);
  }

  /* Then */
  step(then, "Quick", `Log each change in the Change log (the button below), so it shows on the Overview chart.`);
  step(then, "Quick", `After updating the page, press Request indexing in Search Console, then check this panel again in 2–4 weeks. Changes usually take 1–4 weeks to show in Google.`);

  const groups = [["On this page", on], ["Between your pages", between], ["Off the site", off], ["Then", then]].filter(([, l]) => l.length);
  const brief = [`Action plan: ${p.path}`, main ? `Main search: ${main}` : null]
    .concat(...groups.map(([title, list]) => ["", title.toUpperCase(), ...list.map((x, i) => `${i + 1}. [${x.effort}] ${plainOf(x.html)}`)]))
    .filter((x) => x !== null).join("\n");

  return `<details class="seo-w-plan"${s.seen < 0 ? " open" : ""}>
    <summary>Action plan <small>step by step${main ? ` · ${target ? "target search" : "main search"} ${q(main)}` : ""}</small></summary>
    ${groups.map(([title, list]) => `<h4>${title}</h4><ol>${list.map((x) =>
      `<li><span class="seo-w-eff is-${x.effort.toLowerCase()}" title="${EFFORT_TIP[x.effort]}">${x.effort}</span> ${x.html}</li>`).join("")}</ol>`).join("")}
    <div class="seo-w-acts"><button class="seo-btn" type="button" data-copyplan>Copy as a brief</button>
      <span class="seo-note">Worked out from this page's searches and the last Site health check. Check each step makes sense before doing it.</span></div>
    <textarea data-plantext hidden>${h.esc(brief)}</textarea>
  </details>`;
}

function storyHtml(w, p, h) {
  if (!w.queries.length) return "";
  if (!w.queries.some((q) => q.ppages)) {
    return `<h3>Why it changed</h3><p class="seo-note">In Apps Script, run <code>runSeoQueries()</code> once to see why this page changed and which pages compete with it.</p>`;
  }
  const s = pageStory(w, p);
  if (!s.moves.length) return `<h3>Why it changed</h3><p class="seo-note">No searches with enough impressions to explain it.</p>`;

  const open = (path) => {
    const id = h.idOf ? h.idOf(path) : "";
    return id ? `<button class="seo-w-link" data-open="${h.esc(id)}">${h.esc(path)}</button>` : h.esc(path);
  };
  const links = new Map((w.health?.pages || []).filter((x) => Array.isArray(x.links))
    .map((x) => [npath(x.path), new Set(x.links.map(npath))]));
  const linksTo = (from, to) => { const l = links.get(npath(from)); return l ? l.has(npath(to)) : null; };

  const total = p.m28.clicks - p.prev28.clicks;
  const shifts = [...s.shiftBy.entries()].filter(([, v]) => Math.abs(v) >= 1)
    .sort((a, c2) => Math.abs(c2[1]) - Math.abs(a[1])).slice(0, 3);
  const parts = [
    ["demand", s.b.demand < 0 ? "Fewer people searching" : "More people searching", s.b.demand,
      "The searches themselves went " + (s.b.demand < 0 ? "down" : "up")],
    ["shift", s.b.shift < 0 ? "Moved to other pages on the site" : "Moved here from other pages", s.b.shift,
      shifts.map(([path, v]) => `${v < 0 ? "→" : "←"} ${open(path)} ${signed(v)}`).join("<br>")],
    ["rank", s.b.rank < 0 ? "Ranking lower" : "Ranking higher", s.b.rank, "Its position on these searches moved"],
    ["ctr", s.b.ctr < 0 ? "Fewer people clicking" : "More people clicking", s.b.ctr, "At about the same position"],
  ].filter((x) => Math.abs(Math.round(x[2])) >= 1);

  // The biggest cause in the same direction as the change
  const main = parts.filter((x) => Math.sign(x[2]) === Math.sign(s.seen))
    .sort((a, c2) => Math.abs(c2[2]) - Math.abs(a[2]))[0] || null;

  let tip = "";
  if (main && s.seen < 0) {
    if (main[0] === "shift" && shifts.length) {
      const [rp] = shifts[0];
      const l = linksTo(rp, p.path);
      tip = `Google now sends some of these searches to ${open(rp)} instead. If this page is where you want people to land
        (to book), make it the clear answer: put the search words in its title and main heading, and
        ${l === false ? `add a link from ${open(rp)} to this page using those words (it doesn't link here at the moment).`
          : l === true ? `make sure the link from ${open(rp)} to this page uses those words (it already links here).`
          : `add a link from ${open(rp)} to this page using those words.`}
        Keep ${open(rp)} as the guide that answers the question, then points people here to book.`;
    } else if (main[0] === "demand") {
      tip = "Fewer people searched for these terms, so it isn't something the page did. Compare with the same time last year on the Overview: it may be seasonal.";
    } else if (main[0] === "rank") {
      tip = "This page ranks lower for its searches. Check Site health for problems, refresh the content, and look at who ranks above you for the searches below.";
    } else {
      tip = "It ranks about the same, but fewer people click. Rewrite the title and description to match these searches, and check whether Google now shows ads, a map or “People also ask” above it.";
    }
  }

  const rel = s.related.filter((r) => r.n >= 2 || r.imp >= 50).slice(0, 5);
  const pos = (pw, pi) => (pi ? h.fmtPos(pw / pi) : "—");
  const linkCell = (r) => {
    const a = linksTo(r.path, p.path), b2 = linksTo(p.path, r.path);
    if (a == null && b2 == null) return `<span class="seo-note">not a key page</span>`;
    return [a == null ? "" : a ? "links here ✓" : "doesn't link here", b2 == null ? "" : b2 ? "this links to it ✓" : "this doesn't link to it"]
      .filter(Boolean).join("<br>");
  };

  const moves = s.moves.filter((m) => m.Pc !== m.Pp)
    .sort((a, c2) => Math.abs(c2.Pc - c2.Pp) - Math.abs(a.Pc - a.Pp)).slice(0, 6);

  return `
    <h3>Why it changed <small class="seo-note">(28 days vs the 28 before)</small></h3>
    ${parts.length ? `<ul class="seo-w-why">${parts.map(([k, label, v, sub]) => `
      <li class="${main && main[0] === k ? "is-main" : ""}"><span>${h.esc(label)}${sub ? `<small>${sub}</small>` : ""}</span>
        <span class="n ${toneOf(v)}">${signed(v)}</span></li>`).join("")}</ul>` : ""}
    ${tip ? `<div class="seo-w-tip"><strong>In short:</strong> ${tip}</div>` : ""}
    ${planHtml(w, p, s, h, open, linksTo)}
    <p class="seo-note">From searches Google shows (10+ impressions). They explain ${signed(s.seen)} of this page's ${signed(total)} clicks; the rest are rarer searches.</p>

    ${rel.length ? `
      <h3>Pages showing for the same searches</h3>
      <table class="seo-w-mini seo-w-rel"><thead><tr><th>Page</th><th>Shared</th><th>This page</th><th>That page</th><th>Position</th><th>Links</th></tr></thead>
        <tbody>${rel.map((r) => `<tr>
          <td>${open(r.path)}</td>
          <td>${h.fmtInt(r.n)}</td>
          <td>${h.fmtInt(r.myWas)} → <strong>${h.fmtInt(r.myNow)}</strong></td>
          <td>${h.fmtInt(r.thWas)} → <strong>${h.fmtInt(r.thNow)}</strong></td>
          <td>${pos(r.myPw, r.myPi)} / ${pos(r.thPw, r.thPi)}</td>
          <td class="seo-note">${linkCell(r)}</td></tr>`).join("")}</tbody></table>
      <p class="seo-note">Clicks on the searches they share, before → now. Position: this page / that page.</p>` : ""}

    ${moves.length ? `
      <h3>Searches that moved</h3>
      <table class="seo-w-mini"><thead><tr><th>Search</th><th>This page</th><th>Also showing now</th></tr></thead>
        <tbody>${moves.map((m) => `<tr>
          <td>${h.esc(m.q)}</td>
          <td>${h.fmtInt(m.Pp)} → <strong>${h.fmtInt(m.Pc)}</strong><br><span class="seo-note">pos ${h.fmtPos(m.was?.pos ?? null)} → ${h.fmtPos(m.now?.pos ?? null)}</span></td>
          <td>${m.rival ? `${open(m.rival.path)}<br><span class="seo-note">${h.fmtInt(m.rival.was?.c || 0)} → ${h.fmtInt(m.rival.now.c)} clicks · pos ${h.fmtPos(m.rival.now.pos)}</span>` : `<span class="seo-note">—</span>`}</td>
        </tr>`).join("")}</tbody></table>` : ""}`;
}

/* ---------- used by seo.js ---------- */

export function logMarks(w) {
  return (w?.log || []).map((e) => ({ date: e.date, title: `${e.date} · ${e.title}${e.url ? " (" + e.url + ")" : ""}` }));
}

export function pagePanelExtras(w, p, h, can) {
  if (!w) return "";
  const qs = [];
  for (const q of w.queries) { const x = q.pages.find((y) => y.path === p.path); if (x) qs.push({ q: q.q, ...x }); }
  qs.sort((a, b) => b.i - a.i);
  const logs = w.log.filter((e) => e.url === p.path);
  return `<div class="seo-w-panel">${storyHtml(w, p, h)}${healthPanelHtml(w.health, p)}
    <h3>Top searches for this page <small class="seo-note">(28 days)</small></h3>
    ${qs.length
      ? `<table class="seo-kv"><tr><th>Search</th><th>Clicks</th><th>Impr.</th><th>Pos.</th></tr>${qs.slice(0, 15).map((x) =>
          `<tr><td>${h.esc(x.q)}</td><td>${h.fmtInt(x.c)}</td><td>${h.fmtInt(x.i)}</td><td>${h.fmtPos(x.pos)}</td></tr>`).join("")}</table>
         ${qs.length > 15 ? `<p class="seo-note">and ${qs.length - 15} more</p>` : ""}`
      : `<p class="seo-note">${w.queries.length ? "No searches with enough impressions." : "Search data isn't loaded yet."}</p>`}
    <h3>Changes to this page</h3>
    ${logs.length
      ? `<ul class="seo-w-plog">${logs.map((e) => `<li><span>${h.fmtDate(e.date)}</span> ${h.esc(e.title)}</li>`).join("")}</ul>`
      : `<p class="seo-note">None logged.</p>`}
    ${can("seo.work") ? `<button class="seo-btn" data-logpage="${h.esc(p.path)}">Log a change to this page</button>` : ""}
  </div>`;
}

export function renderWorkTab(tab, body, c) {
  injectWorkCss();
  const w = c.work;
  const ui = w.ui || (w.ui = { topic: ALL, qsort: "i", qdir: -1, qfilter: "", qlimit: 100, qopen: null, ostatus: "open", otype: "all" });
  const wrap = document.createElement("div");
  wrap.className = "seo-w";
  body.replaceChildren(wrap);
  ({ keywords: viewKeywords, opps: viewOpps, health: viewHealth, audience: viewAudience, log: viewLog, settings: viewSettings }[tab] || viewKeywords)(wrap, c, ui);
}

/* ---------- shared bits ---------- */

function staleWarn(c) {
  const qs = c.work.qs;
  return qs && qs.ok === false
    ? `<div class="seo-warn">The last search data update failed, so these numbers may be out of date: ${c.h.esc(qs.error || "")}</div>` : "";
}

function noQueries(c) {
  const { work: w, h } = c;
  const err = w.errors.queries;
  return `${staleWarn(c)}<div class="seo-empty">${err
    ? h.esc(errMsg({ message: err }))
    : "No search data yet. In Apps Script, run <code>runSeoQueries()</code> once, then <code>installSeoQueriesTrigger()</code>."}</div>`;
}

function pagesList(pages, c) {
  const { h } = c;
  if (!pages.length) return `<span class="seo-note">No page data.</span>`;
  const tot = pages.reduce((s, p) => s + p.i, 0) || 1;
  return `<table class="seo-w-mini"><thead><tr><th>Page</th><th>Clicks</th><th>Impressions</th><th>Share</th><th>Position</th></tr></thead>
    <tbody>${pages.map((p) => {
      const pg = c.byPath.get(p.path);
      const name = star(c, p.path) + (pg ? `<button class="seo-w-link" data-open="${pg.id}">${h.esc(p.path)}</button>` : h.esc(p.path));
      return `<tr><td>${name}</td><td>${h.fmtInt(p.c)}</td><td>${h.fmtInt(p.i)}</td><td>${Math.round((p.i / tot) * 100)}%</td><td>${h.fmtPos(p.pos)}</td></tr>`;
    }).join("")}</tbody></table>`;
}

/* ---------- Keywords ---------- */

function viewKeywords(wrap, c, ui) {
  const { work: w, h } = c;
  if (!w.queries.length) { wrap.innerHTML = noQueries(c); return; }
  const qs = w.qs || {};
  const pl = priorityLookup(w);
  const isPriQ = (q) => !!pl.targetOf(q.q) || pl.isPage(q.pages[0]?.path);
  const label = (t) => (t === ALL ? "All searches" : t === PRI ? "★ Priority pages' searches" : t === BRAND ? "Brand searches"
    : t === OTHER ? "Not in a topic" : t);

  const COLS = [
    { k: "q", l: "Search", get: (q) => q.q, asc: true },
    { k: "c", l: "Clicks", get: (q) => q.c },
    { k: "dc", l: "vs prev", get: (q) => q.c - q.pc },
    { k: "i", l: "Impressions", get: (q) => q.i },
    { k: "ctr", l: "CTR", get: (q) => q.ctr },
    { k: "pos", l: "Position", get: (q) => q.pos, asc: true },
    { k: "dpos", l: "Moved", get: (q) => (q.pos != null && q.ppos != null ? q.ppos - q.pos : null) },
    { k: "page", l: "Top page", get: (q) => q.pages[0]?.path || "", asc: true },
  ];

  function groups() {
    const order = [ALL, PRI, ...settingsOf(w).topics.map((t) => t.name), OTHER, BRAND];
    const g = new Map(order.map((k) => [k, { k, n: 0, c: 0, i: 0, pw: 0, pc: 0, pi: 0, ppw: 0 }]));
    for (const q of w.queries) {
      for (const k of isPriQ(q) ? [ALL, PRI, q.topic] : [ALL, q.topic]) {
        const a = g.get(k);
        if (!a) continue;
        a.n++; a.c += q.c; a.i += q.i; a.pc += q.pc; a.pi += q.pi;
        if (q.pos != null) a.pw += q.pos * q.i;
        if (q.ppos != null) a.ppw += q.ppos * q.pi;
      }
    }
    return [...g.values()].filter((a) => a.n);
  }

  function draw() {
    const noTopics = !settingsOf(w).topics.length;
    wrap.innerHTML = `
      ${staleWarn(c)}
      <p class="seo-note seo-w-intro">Searches people used to find the site, ${h.fmtDate(qs.from, false)} – ${h.fmtDate(qs.to)} vs the 28 days before ·
        ${h.fmtInt(w.queries.length)} searches. Google hides rare searches, so these won't add up exactly to the Overview totals.
        ${c.can("seo.manage") ? `Topics are set in <a href="#/seo/settings">Settings</a>.` : ""}</p>
      ${noTopics ? `<div class="seo-warn">No topics set up yet, so every search is under “Not in a topic”.${c.can("seo.manage") ? ` Go to <a href="#/seo/settings">Settings</a> and start with the suggested topics.` : ""}</div>` : ""}
      <div class="seo-table-wrap seo-w-topics"><table class="seo-table">
        <thead><tr><th>Topic</th><th>Searches</th><th>Clicks</th><th>vs prev</th><th>Impressions</th><th>Avg position</th><th>Moved</th></tr></thead>
        <tbody>${groups().map((a) => {
          const pos = a.i ? a.pw / a.i : null, ppos = a.pi ? a.ppw / a.pi : null;
          return `<tr data-w-topic="${h.esc(a.k)}" class="${ui.topic === a.k ? "is-on" : ""}">
            <td><strong>${h.esc(label(a.k))}</strong></td><td>${h.fmtInt(a.n)}</td><td>${h.fmtInt(a.c)}</td><td>${h.delta(a.c, a.pc)}</td>
            <td>${h.fmtInt(a.i)}</td><td>${h.fmtPos(pos)}</td><td>${h.delta(pos, ppos, { invert: true, abs: true })}</td></tr>`;
        }).join("")}</tbody></table></div>
      <div class="seo-row seo-w-qhead">
        <h3>${h.esc(label(ui.topic))}</h3>
        ${[["", "All"], ["concern", "Concern"], ["treatment", "Treatment"]].map(([k, l]) =>
          `<button class="seo-w-chip ${(ui.qkind || "") === k ? "is-on" : ""}" type="button" data-w-qkind="${k}"
            title="${k === "concern" ? "Found by the problem, e.g. melasma" : k === "treatment" ? "Found by the treatment, e.g. cosmelan peel" : ""}">${l}</button>`).join("")}
        <span class="seo-sp"></span>
        <input class="seo-input" type="search" data-w-q placeholder="Filter searches, e.g. melasma" value="${h.esc(ui.qfilter)}">
      </div>
      <div class="seo-table-wrap" data-w-qtable></div>
      <p class="seo-note" style="margin-top:8px">Click a search to see which pages show for it.</p>`;
    drawQ();
  }

  function qRow(q) {
    const row = `<tr data-w-qopen="${h.esc(q.q)}" class="${ui.qopen === q.q ? "is-on" : ""}">
      <td><div class="seo-path">${pl.targetOf(q.q) ? `<span class="seo-star is-on" title="Target search for ${h.esc(pl.targetOf(q.q))}">★</span>` : ""}${h.esc(q.q)}</div></td><td>${h.fmtInt(q.c)}</td><td>${h.delta(q.c, q.pc)}</td>
      <td>${h.fmtInt(q.i)}</td><td>${h.fmtPct(q.ctr)}</td><td>${h.fmtPos(q.pos)}</td>
      <td>${h.delta(q.pos, q.ppos, { invert: true, abs: true })}</td>
      <td><div class="seo-path seo-w-toppage">${pl.isPage(q.pages[0]?.path) ? `<span class="seo-star is-on" title="Priority page">★</span>` : ""}${h.esc(q.pages[0]?.path || "—")}</div></td></tr>`;
    return ui.qopen === q.q ? row + `<tr class="seo-w-sub"><td colspan="8">${pagesList(q.pages, c)}</td></tr>` : row;
  }

  function drawQ() {
    const f = norm(ui.qfilter);
    const col = COLS.find((x) => x.k === ui.qsort) || COLS[3];
    let rows = w.queries.filter((q) => (ui.topic === ALL || (ui.topic === PRI ? isPriQ(q) : q.topic === ui.topic))
      && (!f || q.q.toLowerCase().includes(f)) && (!ui.qkind || q.kind === ui.qkind || q.kind === "both"));
    rows.sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * ui.qdir;
    });
    const total = rows.length;
    rows = rows.slice(0, ui.qlimit);
    wrap.querySelector("[data-w-qtable]").innerHTML = `
      <table class="seo-table">
        <thead><tr>${COLS.map((x) => `<th data-w-qsort="${x.k}" class="${ui.qsort === x.k ? "on" : ""}">${x.l}${ui.qsort === x.k ? (ui.qdir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(qRow).join("")}</tbody>
      </table>
      ${total > ui.qlimit ? `<div style="padding:10px;text-align:center"><button class="seo-btn" data-w-qmore>Show all ${h.fmtInt(total)}</button></div>` : ""}
      ${!total ? `<div class="seo-empty">No searches match.</div>` : ""}`;
  }

  wrap.onclick = (e) => {
    if (e.target.closest("[data-open]")) return;
    const t = e.target.closest("[data-w-qkind],[data-w-topic],[data-w-qsort],[data-w-qopen],[data-w-qmore]");
    if (!t) return;
    const d = t.dataset;
    if (d.wQkind !== undefined) { ui.qkind = d.wQkind; ui.qopen = null; ui.qlimit = 100; draw(); }
    else if (d.wTopic !== undefined) { ui.topic = d.wTopic; ui.qopen = null; ui.qlimit = 100; draw(); }
    else if (d.wQsort !== undefined) {
      const col = COLS.find((x) => x.k === d.wQsort);
      if (ui.qsort === d.wQsort) ui.qdir *= -1;
      else { ui.qsort = d.wQsort; ui.qdir = col.asc ? 1 : -1; }
      drawQ();
    }
    else if (d.wQopen !== undefined) { ui.qopen = ui.qopen === d.wQopen ? null : d.wQopen; drawQ(); }
    else if (d.wQmore !== undefined) { ui.qlimit = Infinity; drawQ(); }
  };
  wrap.oninput = (e) => {
    if (!e.target.matches("[data-w-q]")) return;
    ui.qfilter = e.target.value; ui.qlimit = 100; ui.qopen = null; drawQ();
  };
  draw();
}

/* ---------- Opportunities ---------- */

function buildOpps(c) {
  const { work: w, data } = c;
  const by = { striking: [], ctr: [], decay: [], cannibal: [], area: [] };
  // Areas people search for, where the site isn't on page 1
  for (const a of w.audience?.areas || []) {
    const s = a.search;
    if (!s?.cur || s.cur.i < 50 || s.cur.pos == null || s.cur.pos <= 8) continue;
    by.area.push({ type: "area", key: "area:" + a.name, title: a.name, url: s.queries?.[0]?.[4] || "",
      gain: Math.max(0, Math.round(s.cur.i * EXP_CTR[2] - s.cur.c)), area: a });
  }
  for (const q of w.queries) {
    if (q.topic === BRAND || q.pos == null) continue;
    if (q.pos >= 8 && q.pos <= 20 && q.i >= 50) {
      by.striking.push({ type: "striking", key: "striking:" + q.q, title: q.q, url: q.pages[0]?.path || "",
        gain: Math.max(0, Math.round(q.i * EXP_CTR[2] - q.c)), q });
    }
    if (q.pos <= 6 && q.i >= 100) {
      const exp = EXP_CTR[Math.max(0, Math.round(q.pos) - 1)];
      if (q.ctr < exp * 0.5) {
        by.ctr.push({ type: "ctr", key: "ctr:" + q.q, title: q.q, url: q.pages[0]?.path || "",
          gain: Math.max(0, Math.round(q.i * exp - q.c)), q, exp });
      }
    }
    if (q.i >= 100 && q.pages.length >= 2) {
      const tot = q.pages.reduce((s, p) => s + p.i, 0);
      const comp = q.pages.filter((p) => p.i >= tot * 0.15);
      if (comp.length >= 2) by.cannibal.push({ type: "cannibal", key: "cannibal:" + q.q, title: q.q, url: comp[0].path, gain: 0, score: q.i, q });
    }
  }
  for (const p of data.pages) {
    const now = p.m28.clicks, before = p.prev28.clicks;
    if (before >= 15 && now <= before * 0.7) {
      by.decay.push({ type: "decay", key: "decay:" + p.path, title: p.path, url: p.path, gain: before - now, page: p });
    }
  }

  const list = [];
  const pl = priorityLookup(w);
  const priOf = (o) => (pl.isPage(o.url) || (o.q && (pl.targetOf(o.q.q) || o.q.pages.some((x) => pl.isPage(x.path)))) ? 1 : 0);
  for (const arr of Object.values(by)) {
    arr.forEach((o) => { o.pri = priOf(o); });
    arr.sort((a, b) => (b.pri - a.pri) || (b.gain || b.score || 0) - (a.gain || a.score || 0));
    let shown = 0;
    for (const o of arr) {
      o.id = oppId(o.key);
      o.st = w.opps[o.id] || null;
      o.status = o.st?.status || "open";
      if (o.status !== "open" || shown++ < PER_TYPE) list.push(o);
    }
  }
  // Ones someone acted on that the latest data no longer flags
  const seen = new Set(list.map((o) => o.id));
  for (const [id, s] of Object.entries(w.opps)) {
    if (seen.has(id) || !s.status || s.status === "open") continue;
    list.push({ id, key: s.key, type: s.type, title: s.label, url: s.url, gain: 0, st: s, status: s.status, stale: true, pri: pl.isPage(s.url) ? 1 : 0 });
  }
  return list;
}

function oppBody(o, c) {
  const { h } = c, q = o.q;
  if (o.stale) return `<p class="seo-note">The latest data no longer flags this. It's kept because someone marked it.</p>`;
  if (o.type === "striking") {
    return `<p>Average position <strong>${h.fmtPos(q.pos)}</strong> from ${h.fmtInt(q.i)} impressions (${h.fmtInt(q.c)} clicks). It's close to the top of page 1.</p>
      ${todo("Add a section that answers this search directly, use the words in a heading, and link to the page from related pages and blog posts.")}`;
  }
  if (o.type === "ctr") {
    return `<p>Ranks at position <strong>${h.fmtPos(q.pos)}</strong>, but only <strong>${h.fmtPct(q.ctr)}</strong> of ${h.fmtInt(q.i)} people click. Around ${h.fmtPct(o.exp)} is typical for that spot.</p>
      ${todo("Rewrite the page title and meta description so they match this search and give a clear reason to click.")}`;
  }
  if (o.type === "decay") {
    const p = o.page;
    return `<p><strong>${h.fmtInt(p.m28.clicks)}</strong> clicks in the last 28 days, down from ${h.fmtInt(p.prev28.clicks)} ${h.delta(p.m28.clicks, p.prev28.clicks)}</p>
      ${Array.isArray(p.weekly) ? `<div class="seo-w-spark">${h.sparkline(p.weekly, 160, 30)} <span class="seo-note">clicks, last 12 weeks</span></div>` : ""}
      ${todo("Open the page details to see which searches it lost. Refresh the content, check it loads quickly, and make sure related pages still link to it.")}`;
  }
  if (o.type === "area") {
    const s = o.area.search;
    return `<p>Searches mentioning <strong>${h.esc(o.title)}</strong> were seen ${h.fmtInt(s.cur.i)} times (${h.fmtInt(s.cur.c)} clicks),
        at an average position of <strong>${h.fmtPos(s.cur.pos)}</strong>.</p>
      <p class="seo-note">Top searches: ${s.queries.slice(0, 3).map((q) => h.esc(q[0])).join(" · ")}</p>
      ${todo("Add a section or page for this area: name the suburbs you see patients from, travel time and parking, and link to it from your treatment pages. A Google Business Profile post mentioning the area helps too.")}`;
  }
  if (o.type === "cannibal") {
    return `<p>${q.pages.length} pages show for this search (${h.fmtInt(q.i)} impressions), so Google splits between them.</p>
      ${pagesList(q.pages, c)}
      ${todo("Choose one page to own this search. Link to it from the others using these words, and take the phrase out of the other pages' titles and headings.")}`;
  }
  return "";
}

function oppCard(o, c) {
  const { h } = c;
  const T = OPP[o.type] || { label: o.type || "Other", tone: "grey" };
  const canWork = c.can("seo.work");
  const pg = o.url ? c.byPath.get(o.url) : null;
  const btn = (st, l, on) => `<button class="seo-btn ${on ? "on" : ""}" data-w-ost="${st}" data-w-id="${o.id}">${l}</button>`;
  const acts = !canWork ? ""
    : o.status === "open" ? btn("doing", "Start", true) + btn("done", "Done") + btn("ignored", "Ignore")
    : o.status === "doing" ? btn("done", "Done", true) + `<button class="seo-btn" data-w-olog="${o.id}">Log the change</button>` + btn("open", "Back to to-do")
    : btn("open", "Back to to-do");
  const at = tsDate(o.st?.at);
  const quoted = o.type === "decay" ? h.esc(o.title) : `“${h.esc(o.title)}”`;
  return `<article class="seo-w-card is-${T.tone}${o.pri ? " is-pri" : ""}">
    <header><span class="seo-w-pill is-${T.tone}">${h.esc(T.label)}</span>
      ${o.pri ? `<span class="seo-w-pill is-pri">★ Priority${o.q && priorityLookup(c.work).targetOf(o.q.q) ? " · target search" : ""}</span>` : ""}
      ${o.gain > 0 ? `<span class="seo-w-gain">≈ +${h.fmtInt(o.gain)} clicks / 28 days</span>` : ""}</header>
    <h4>${quoted}</h4>
    ${oppBody(o, c)}
    ${(o.type === "striking" || o.type === "ctr" || o.type === "area" || o.stale) && o.url
      ? `<p class="seo-note">Page: ${star(c, o.url)}${pg ? `<button class="seo-w-link" data-open="${pg.id}">${h.esc(o.url)}</button>` : h.esc(o.url)}</p>` : ""}
    ${o.type === "decay" && pg && !o.stale ? `<p><button class="seo-w-link" data-open="${pg.id}">Open page details</button></p>` : ""}
    ${o.st ? `<p class="seo-note">${STATUS[o.status] || ""} · ${h.esc(o.st.byName || "someone")}${at ? " · " + at.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""}</p>` : ""}
    ${canWork
      ? `<details class="seo-w-note"${o.st?.note ? " open" : ""}><summary>Note</summary>
          <textarea class="seo-input" rows="2" maxlength="2000" data-w-note="${o.id}">${h.esc(o.st?.note || "")}</textarea>
          <button class="seo-btn" data-w-savenote="${o.id}">Save note</button></details>`
      : o.st?.note ? `<p class="seo-w-notetext">${h.esc(o.st.note)}</p>` : ""}
    ${acts ? `<div class="seo-w-acts">${acts}</div>` : ""}
  </article>`;
}

async function saveOpp(c, o, patch) {
  const cur = c.work.opps[o.id] || {};
  const d = {
    key: o.key, type: o.type || "", label: String(o.title || "").slice(0, 300), url: o.url || "",
    status: patch.status ?? cur.status ?? "open",
    note: String(patch.note ?? cur.note ?? "").slice(0, 2000),
    by: uid(), byName: myName(c), at: serverTimestamp(),
  };
  await setDoc(doc(db, "seo_opps", o.id), d);
  c.work.opps[o.id] = { ...d, at: new Date() };
}

function viewOpps(wrap, c, ui) {
  const { work: w, h } = c;
  let byId = new Map();

  function draw() {
    const list = buildOpps(c);
    byId = new Map(list.map((o) => [o.id, o]));
    const inType = list.filter((o) => (ui.otype === "all" || o.type === ui.otype) && (!ui.opri || o.pri));
    const counts = {};
    for (const o of inType) counts[o.status] = (counts[o.status] || 0) + 1;
    const tcount = {};
    for (const o of list) if (o.status === ui.ostatus) tcount[o.type] = (tcount[o.type] || 0) + 1;
    const show = inType.filter((o) => o.status === ui.ostatus).sort((a, b) => (b.pri || 0) - (a.pri || 0));

    wrap.innerHTML = `
      ${staleWarn(c)}
      ${!w.queries.length ? `<div class="seo-warn">Search data isn't loaded yet, so only “Losing clicks” can be worked out. Run <code>runSeoQueries()</code> in Apps Script.</div>` : ""}
      <div class="seo-row">${Object.entries(STATUS).map(([k, l]) =>
        `<button class="seo-btn ${ui.ostatus === k ? "on" : ""}" data-w-status="${k}">${l} <span class="seo-w-n">${counts[k] || 0}</span></button>`).join("")}
        <span class="seo-sp"></span>
        ${priorityLookup(w).any ? `<button class="seo-w-chip ${ui.opri ? "is-on" : ""}" data-w-opri>★ Priority pages only</button>` : ""}</div>
      <div class="seo-row">${[["all", "All types"], ...Object.entries(OPP).map(([k, v]) => [k, v.label])].map(([k, l]) =>
        `<button class="seo-w-chip ${ui.otype === k ? "is-on" : ""}" data-w-type="${k}">${h.esc(l)}${k !== "all" ? ` <em>${tcount[k] || 0}</em>` : ""}</button>`).join("")}</div>
      <p class="seo-note">Worked out from the last 28 days. Brand searches are left out. Extra clicks are a rough estimate, so use them to pick what to do first.</p>
      ${show.length ? `<div class="seo-w-grid">${show.map((o) => oppCard(o, c)).join("")}</div>` : `<div class="seo-empty">Nothing here.</div>`}`;
  }

  wrap.onclick = async (e) => {
    if (e.target.closest("[data-open]")) return;
    const t = e.target.closest("[data-w-opri],[data-w-status],[data-w-type],[data-w-ost],[data-w-olog],[data-w-savenote]");
    if (!t) return;
    const d = t.dataset;
    if (d.wOpri !== undefined) { ui.opri = !ui.opri; draw(); return; }
    if (d.wStatus) { ui.ostatus = d.wStatus; draw(); return; }
    if (d.wType) { ui.otype = d.wType; draw(); return; }
    const o = byId.get(d.wId || d.wOlog || d.wSavenote);
    if (!o) return;
    if (d.wOlog) {
      w.prefill = { url: o.url, title: (LOG_TITLE[o.type] || ((x) => x.title))(o),
        opp: { id: o.id, key: o.key, type: o.type, title: o.title, url: o.url } };
      c.setTab("log");
      return;
    }
    t.disabled = true;
    try {
      if (d.wOst) await saveOpp(c, o, { status: d.wOst });
      else { await saveOpp(c, o, { note: wrap.querySelector(`[data-w-note="${o.id}"]`).value.trim() }); toast("Note saved"); }
      draw();
    } catch (err) { t.disabled = false; toast(errMsg(err), true); }
  };
  draw();
}

/* ---------- Change log ---------- */

function effect(e, c) {
  const { data, h } = c;
  const end = data.ov.periodEnd;
  const gap = Math.floor((Date.parse(end) - Date.parse(e.date)) / 864e5);
  if (gap < 14) return `<span class="seo-note">Too soon to see an effect (needs 2 weeks of data after the change).</span>`;
  const ba = (b, a, what) => `<span class="seo-note">${what}:</span> ${b.toFixed(1)} → <strong>${a.toFixed(1)}</strong> ${h.delta(a, b)}`;
  const pg = e.url ? c.byPath.get(e.url) : null;
  if (pg && Array.isArray(pg.weekly) && pg.weekly.length === 12) {
    const wEnd = (i) => h.addDays(end, -7 * (11 - i));
    const k = pg.weekly.findIndex((_, i) => e.date <= wEnd(i) && e.date >= h.addDays(wEnd(i), -6));
    if (k >= 0) {
      const b = pg.weekly.slice(Math.max(0, k - 4), k), a = pg.weekly.slice(k + 1, k + 5);
      if (b.length >= 2 && a.length >= 2) return ba(avg(b), avg(a), "Page clicks per week, before → after");
    }
  }
  const n = Math.min(28, gap);
  const b = h.sumRange(data.days, h.addDays(e.date, -28), h.addDays(e.date, -1)).clicks / 4;
  const a = (h.sumRange(data.days, h.addDays(e.date, 1), h.addDays(e.date, n)).clicks / n) * 7;
  return ba(b, a, pg ? "Site clicks per week (not enough page history)" : "Site clicks per week, before → after");
}

function viewLog(wrap, c, ui) {
  const { work: w, h } = c;
  const canWork = c.can("seo.work"), canManage = c.can("seo.manage");
  const me = uid();
  const plL = priorityLookup(w);
  const paths = c.data.pages.map((p) => p.path).sort((a, b) => (plL.isPage(b) - plL.isPage(a)) || a.localeCompare(b));
  let pre = w.prefill || null;
  let edit = null;
  w.prefill = null;

  function formHtml() {
    const f = edit || {
      date: todayPerth(), type: pre?.type || (pre?.opp?.type === "ctr" ? "Title / meta" : "Content"),
      title: pre?.title || "", url: pre?.url || "", note: "",
    };
    return `<form class="seo-card seo-w-form" data-w-form>
      <h3>${edit ? "Edit change" : "Log a change"}</h3>
      ${pre?.opp && !edit ? `<p class="seo-note">From the opportunity “${h.esc(pre.opp.title)}”.</p>` : ""}
      <div class="seo-w-fgrid">
        <label>Date<input class="seo-input" type="date" name="date" required max="${todayPerth()}" value="${h.esc(f.date)}"></label>
        <label>Type<select class="seo-input" name="type">${LOG_TYPES.map((t) => `<option ${t === f.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="is-wide">What changed<input class="seo-input" name="title" required maxlength="200" value="${h.esc(f.title)}" placeholder="e.g. Rewrote the melasma page title"></label>
        <label class="is-wide">Page <small>(leave empty for a site-wide change)</small>
          <input class="seo-input" name="url" list="seo-w-paths" value="${h.esc(f.url || "")}" placeholder="/melasma-treatment-perth/"></label>
        <label class="is-wide">Notes<textarea class="seo-input" name="note" rows="3" maxlength="2000">${h.esc(f.note || "")}</textarea></label>
      </div>
      <datalist id="seo-w-paths">${paths.map((p) => `<option value="${h.esc(p)}"${plL.isPage(p) ? ' label="★ Priority page"' : ""}>`).join("")}</datalist>
      ${pre?.opp && !edit ? `<label class="seo-check"><input type="checkbox" name="done" checked> Mark the opportunity as done</label>` : ""}
      <div class="seo-w-acts">
        <button class="seo-btn on" type="submit">${edit ? "Save changes" : "Save"}</button>
        ${edit || pre ? `<button class="seo-btn" type="button" data-w-cancel>Cancel</button>` : ""}
      </div>
    </form>`;
  }

  function listHtml() {
    if (!w.log.length) {
      return `<div class="seo-empty">No changes logged yet. Log title rewrites, content updates, new pages and technical fixes here, so you can see what moved the numbers.</div>`;
    }
    const entries = ui.lpri ? w.log.filter((e) => plL.isPage(e.url)) : w.log;
    if (!entries.length) return `<div class="seo-empty">No changes logged for priority pages yet.</div>`;
    let month = "";
    return entries.map((e) => {
      const m = e.date.slice(0, 7);
      const head = m !== month
        ? `<h4 class="seo-w-month">${new Date(e.date + "T00:00:00Z").toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" })}</h4>` : "";
      month = m;
      const pg = e.url ? c.byPath.get(e.url) : null;
      const mine = canManage || (canWork && e.by === me);
      return head + `<div class="seo-w-entry">
        <div class="seo-w-edate">${h.fmtDate(e.date)}</div>
        <div class="seo-w-emain">
          <div><span class="seo-w-pill is-grey">${h.esc(e.type || "Other")}</span> <strong>${h.esc(e.title)}</strong></div>
          <div class="seo-note">${e.url ? star(c, e.url) + (pg ? `<button class="seo-w-link" data-open="${pg.id}">${h.esc(e.url)}</button>` : h.esc(e.url)) : "Site-wide"}</div>
          ${e.note ? `<p class="seo-w-enote">${h.esc(e.note)}</p>` : ""}
          <div class="seo-w-effect">${effect(e, c)}</div>
          ${e.byName ? `<div class="seo-note">${h.esc(e.byName)}</div>` : ""}
        </div>
        ${mine ? `<div class="seo-w-acts"><button class="seo-btn" data-w-edit="${e.id}">Edit</button><button class="seo-btn" data-w-del="${e.id}">Delete</button></div>` : ""}
      </div>`;
    }).join("");
  }

  function draw() {
    wrap.innerHTML = `<div class="seo-w-log${canWork ? "" : " is-ro"}">
      ${canWork ? formHtml() : ""}
      <div class="seo-card">
        <div class="seo-row" style="margin:0 0 4px"><h3 style="margin:0">Changes</h3><span class="seo-sp"></span>
          ${plL.any ? `<button class="seo-w-chip ${ui.lpri ? "is-on" : ""}" type="button" data-w-lpri>★ Priority pages only</button>` : ""}</div>
        <p class="seo-note">Before/after numbers are a rough guide. Seasons, ads and other changes move them too.</p>
        ${listHtml()}
      </div>
    </div>`;
  }

  wrap.onsubmit = async (ev) => {
    ev.preventDefault();
    const fm = ev.target, fd = new FormData(fm);
    const btn = fm.querySelector("[type=submit]");
    let url = String(fd.get("url") || "").trim().replace(/^https?:\/\/[^/]+/i, "");
    if (url && !url.startsWith("/")) url = "/" + url;
    const v = {
      date: String(fd.get("date") || ""), type: String(fd.get("type") || "Other"),
      title: String(fd.get("title") || "").trim().slice(0, 200), url,
      note: String(fd.get("note") || "").trim().slice(0, 2000),
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !v.title) { toast("Add a date and what changed.", true); return; }
    btn.disabled = true;
    try {
      if (edit) {
        await updateDoc(doc(db, "seo_log", edit.id), { ...v, updatedAt: serverTimestamp() });
        Object.assign(edit, v);
      } else {
        const d = { ...v, by: uid(), byName: myName(c), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
        if (pre?.opp) d.oppId = pre.opp.id;
        const ref = await addDoc(collection(db, "seo_log"), d);
        w.log.push({ ...d, id: ref.id, createdAt: new Date(), updatedAt: new Date() });
        if (pre?.opp && fd.get("done")) await saveOpp(c, pre.opp, { status: "done" }).catch((e) => toast(errMsg(e), true));
      }
      w.log.sort(byDateDesc);
      edit = null; pre = null;
      toast("Saved");
      draw();
    } catch (e) { btn.disabled = false; toast(errMsg(e), true); }
  };

  wrap.onclick = async (e) => {
    if (e.target.closest("[data-open]")) return;
    const t = e.target.closest("[data-w-lpri],[data-w-edit],[data-w-del],[data-w-cancel]");
    if (!t) return;
    const d = t.dataset;
    if (d.wLpri !== undefined) { ui.lpri = !ui.lpri; draw(); return; }
    if (d.wCancel !== undefined) { edit = null; pre = null; draw(); return; }
    const entry = w.log.find((x) => x.id === (d.wEdit || d.wDel));
    if (!entry) return;
    if (d.wEdit) {
      edit = entry; pre = null; draw();
      wrap.querySelector("[data-w-form]")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (!confirm(`Delete “${entry.title}”?`)) return;
    t.disabled = true;
    try {
      await deleteDoc(doc(db, "seo_log", entry.id));
      w.log = w.log.filter((x) => x !== entry);
      draw();
    } catch (err) { t.disabled = false; toast(errMsg(err), true); }
  };
  draw();
}

/* ---------- Settings ---------- */

// Words left out when suggesting what to add from an unsorted search
const OSTOP = new Set(["in", "for", "the", "a", "an", "of", "and", "to", "on", "with", "near", "me", "my", "is", "are", "what", "how",
  "why", "does", "do", "best", "perth", "wa", "vs", "versus", "cost", "costs", "price", "prices", "before", "after", "treatment",
  "treatments", "causes", "cause", "clinic", "removal", "remove"]);

function wordFor(q, all) {
  const l = String(q).toLowerCase();
  const t = l.replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((x) => x && !OSTOP.has(x));
  if (!t.length) return l.trim();
  if (t.length >= 2) {
    const two = t[0] + " " + t[1];
    if (l.includes(two) && (t[0].length <= 4 || all.filter((x) => x.includes(two)).length >= 2)) return two;
  }
  return t[0];
}

function viewSettings(wrap, c) {
  const { work: w, h } = c;
  if (!c.can("seo.manage")) { wrap.innerHTML = `<div class="seo-empty">Only people with SEO settings access can change these.</div>`; return; }
  const st = settingsOf(w);
  const idx = pageIndex(w, c.data);
  const wordsText = (list) => list.map((x) => (x.why ? `${x.word} | ${x.why}` : x.word)).join("\n");
  const lines = (s) => s.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const guessed = st.topics.some((t) => t.guessed);
  const when = (t) => {
    const d = tsDate(t) || (t ? new Date(t) : null);
    return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
  };

  let topics = st.topics.map((t) => ({ name: t.name, concern: t.concern.slice(), treatment: t.treatment.slice(), pages: t.pages.slice() }));
  let brand = st.brand.join(", ");
  let keyPages = st.keyPages.slice();
  let words = wordsText(st.compliance || COMPLIANCE);
  let dirty = false;
  let openT = -1, tFind = "", tMore = false, pFind = "", pFilt = "all", pMore = false;

  const busy = new Set(idx.list.filter((x) => x.clicks > 0).slice(0, 15).map((x) => npath(x.path)));
  const brandList = () => [...new Set(brand.split(",").map(norm).filter(Boolean))];
  // Which topic a search would go into with the words as they are now (-1 none, -2 brand)
  const previewTopic = (text, brands) => {
    const l = String(text).toLowerCase();
    if (brands.some((b) => l.includes(b))) return -2;
    return topics.findIndex((t) => t.concern.some((x) => l.includes(x)) || t.treatment.some((x) => l.includes(x)));
  };
  // Ticked pages that aren't in the list any more still need a row
  const itemsWith = (paths) => {
    const extra = paths.filter((p) => !idx.get(p)).map((p) => ({ path: p, title: "", clicks: 0, impr: 0, wp: idx.hasWp ? false : null }));
    return extra.length ? idx.list.concat(extra) : idx.list;
  };
  const matches = (x, f) => !f || (x.title + " " + x.path).toLowerCase().includes(f);

  const mark = () => {
    dirty = true;
    const el = wrap.querySelector("[data-w-dirty]");
    if (el) el.textContent = "Unsaved changes";
  };

  function addWords(i, k, text) {
    const t = topics[i];
    if (!t) return 0;
    const other = k === "concern" ? "treatment" : "concern";
    let n = 0;
    for (const raw of String(text).split(",")) {
      const x = norm(raw).slice(0, 60);
      if (!x || t[k].includes(x)) continue;
      t[other] = t[other].filter((y) => y !== x);   // a word is one or the other
      t[k].push(x);
      n++;
    }
    if (n) mark();
    return n;
  }
  // Words typed but not yet added with Enter
  function commitPending() {
    wrap.querySelectorAll("[data-w-chipin]").forEach((el) => {
      if (!el.value.trim()) return;
      const [i, k] = el.dataset.wChipin.split("|");
      addWords(+i, k, el.value);
      el.value = "";
    });
  }

  /* ----- page tick lists ----- */

  function pickRows(items, isOn, isSug, attr, readonly) {
    return items.map((x) => {
      const on = isOn(x);
      return `<label class="seo-w-pk${on ? " is-on" : ""}">
        <input type="checkbox" ${attr}="${h.esc(x.path)}"${on ? " checked" : ""}${readonly ? " disabled" : ""}>
        <span class="seo-w-pkt"><span class="t">${h.esc(x.title || prettyPath(x.path))}${!on && isSug(x) ? "<em>suggested</em>" : ""}${
          x.wp === false ? `<em class="is-old" title="Not in WordPress's page list: an old address, or a redirect">not on the website</em>` : ""}</span>
          <span class="p">${h.esc(x.path)}</span></span>
        <span class="seo-w-pkc" title="Clicks from Google, last 28 days">${x.clicks ? h.fmtInt(x.clicks) : "—"}</span></label>`;
    }).join("");
  }

  function topicSuggest(i) {
    const t = topics[i];
    const ws = t.concern.concat(t.treatment);
    const out = new Set();
    if (!ws.length) return out;
    const brands = brandList();
    const by = new Map();
    for (const q of w.queries) {
      if (previewTopic(q.q, brands) !== i) continue;
      for (const p of q.pages) by.set(npath(p.path), (by.get(npath(p.path)) || 0) + p.i);
    }
    const tot = [...by.values()].reduce((a, b) => a + b, 0) || 1;
    [...by.entries()].filter(([, v]) => v / tot >= 0.05).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([k]) => out.add(k));
    for (const x of idx.list) {
      if (out.size >= 10) break;
      const hay = (x.title + " " + x.path).toLowerCase().replace(/[-_/]+/g, " ");
      if (ws.some((wd) => hay.includes(wd))) out.add(npath(x.path));
    }
    return out;
  }

  function tListHtml(i) {
    const t = topics[i];
    const on = new Set(t.pages.map(npath));
    const sug = topicSuggest(i);
    const f = norm(tFind);
    const items = itemsWith(t.pages).filter((x) => matches(x, f)).sort((a, b) =>
      on.has(npath(b.path)) - on.has(npath(a.path)) || sug.has(npath(b.path)) - sug.has(npath(a.path)) || b.clicks - a.clicks);
    const lim = tMore ? 300 : f ? 30 : Math.max(8, on.size + Math.min(sug.size, 6));
    if (!items.length) return `<p class="seo-note">No pages match.</p>`;
    return `<div class="seo-w-pklist">${pickRows(items.slice(0, lim), (x) => on.has(npath(x.path)), (x) => sug.has(npath(x.path)), "data-w-tpage")}</div>
      ${items.length > lim ? `<button class="seo-w-link" type="button" data-w-tmore>Show ${h.fmtInt(items.length - lim)} more</button>` : ""}`;
  }

  function pListHtml() {
    const on = new Set(keyPages.map(npath));
    const f = norm(pFind);
    let items = itemsWith(keyPages).filter((x) => matches(x, f));
    if (!c.isAdmin || pFilt === "sel") items = items.filter((x) => on.has(npath(x.path)));
    else if (pFilt === "sug") items = items.filter((x) => !on.has(npath(x.path)) && busy.has(npath(x.path)));
    items.sort((a, b) => on.has(npath(b.path)) - on.has(npath(a.path)) || b.clicks - a.clicks);
    const lim = pMore ? 1000 : f ? 40 : Math.max(12, on.size + 4);
    if (!items.length) return `<p class="seo-note">${!c.isAdmin ? "No priority pages yet." : pFilt === "sug" ? "Your busiest pages are all ticked." : "No pages match."}</p>`;
    return `<div class="seo-w-pklist">${pickRows(items.slice(0, lim), (x) => on.has(npath(x.path)),
        (x) => busy.has(npath(x.path)), "data-w-ppage", !c.isAdmin)}</div>
      ${items.length > lim ? `<button class="seo-w-link" type="button" data-w-pmore>Show ${h.fmtInt(items.length - lim)} more</button>` : ""}`;
  }

  /* ----- topics ----- */

  const tags = (list, k) => (list.length ? list.map((x) => `<span class="seo-w-tag is-${k}">${h.esc(x)}</span>`).join("") : `<span class="seo-note">—</span>`);

  function topicRow(t, i) {
    const n = t.pages.length;
    return `<div class="seo-w-trow2${i === openT ? " is-open" : ""}" data-w-topen="${i}" role="button" tabindex="0" aria-expanded="${i === openT}">
      <strong>${h.esc(t.name || "New topic")}</strong><span>${tags(t.concern, "c")}</span><span>${tags(t.treatment, "t")}</span>
      <span class="${n ? "" : "is-none"}">${n ? `${n} page${n === 1 ? "" : "s"}` : "None"}</span></div>`;
  }

  const chipBox = (i, k, label, ph) => `<div>
    <div class="seo-note">${label}</div>
    <div class="seo-w-chips">${topics[i][k].map((x, j) => `<span class="seo-w-tag is-${k[0]}">${h.esc(x)}<button type="button"
        data-w-chipx="${i}|${k}|${j}" aria-label="Remove ${h.esc(x)}">×</button></span>`).join("")}
      <input data-w-chipin="${i}|${k}" placeholder="${ph}" maxlength="60" aria-label="${label}"></div></div>`;

  function topicEditor(t, i) {
    return `<div class="seo-w-tedit">
      <div class="seo-w-tedit-h">
        <input class="seo-input" data-w-tname="${i}" value="${h.esc(t.name)}" placeholder="Topic name" maxlength="60" aria-label="Topic name">
        <span class="seo-sp"></span>
        <button class="seo-btn" type="button" data-w-up="${i}" title="Move up"${i ? "" : " disabled"}>↑</button>
        <button class="seo-btn" type="button" data-w-down="${i}" title="Move down"${i < topics.length - 1 ? "" : " disabled"}>↓</button>
        <button class="seo-btn" type="button" data-w-rm="${i}">Delete</button>
        <button class="seo-btn on" type="button" data-w-tclose>Done</button>
      </div>
      <div class="seo-w-tcols">
        ${chipBox(i, "concern", "Concern words: what people have", "melasma, then Enter")}
        ${chipBox(i, "treatment", "Treatment words: what they want done", "cosmelan peel, then Enter")}
      </div>
      <div class="seo-row" style="margin:12px 0 6px">
        <strong style="font-size:13px">Pages for this topic</strong>
        <span class="seo-note" data-w-tcount>${t.pages.length} ticked</span><span class="seo-sp"></span>
        <input class="seo-input seo-w-find" type="search" data-w-tfind placeholder="Search pages" value="${h.esc(tFind)}">
      </div>
      <div data-w-tlist>${tListHtml(i)}</div>
      <p class="seo-note" style="margin-top:6px">A page can belong to more than one topic.</p>
    </div>`;
  }

  /* ----- searches not in a topic ----- */

  function otherHtml() {
    const brands = brandList();
    const rest = w.queries.filter((q) => previewTopic(q.q, brands) === -1).sort((a, b) => b.i - a.i);
    const all = rest.map((q) => q.q.toLowerCase());
    const top = rest.slice(0, 30);
    if (!top.length) return `<p class="seo-note">${w.queries.length ? "Every search is in a topic." : "No search data yet."}</p>`;
    const opts = topics.map((t, i) => `<option value="${i}">${h.esc(t.name || "New topic")}</option>`).join("");
    return top.map((q) => {
      const wd = wordFor(q.q, all);
      const kind = guessKind(wd);
      return `<div class="seo-w-orow" data-w-orow="${h.esc(q.q)}">
        <div><span class="seo-path">${h.esc(q.q)}</span><span class="seo-note">${h.fmtInt(q.i)} impr.</span></div>
        <div class="seo-w-oacts">
          <input class="seo-input" data-w-oword value="${h.esc(wd)}" maxlength="60" aria-label="Word to add">
          <select class="seo-input" data-w-otopic aria-label="Topic"><option value="">Choose topic</option>${opts}<option value="new">New topic…</option></select>
          <select class="seo-input" data-w-okind aria-label="Concern or treatment">
            <option value="concern"${kind === "concern" ? " selected" : ""}>as concern</option>
            <option value="treatment"${kind === "treatment" ? " selected" : ""}>as treatment</option></select>
          <button class="seo-btn" type="button" data-w-oadd>Add</button>
        </div></div>`;
    }).join("") + (rest.length > 30 ? `<p class="seo-note">and ${h.fmtInt(rest.length - 30)} more</p>` : "");
  }

  /* ----- priority pages ----- */

  function priorityHtml() {
    const n = keyPages.length;
    const wpLine = w.wp?.pages?.length ? `Page titles from WordPress, updated ${h.esc(when(w.wp.at))}.`
      : w.errors.wp ? `Page titles couldn't be read: ${h.esc(errMsg({ message: w.errors.wp }))}`
      : "Page titles show once WordPress is connected (run seoWpSync in Apps Script).";
    return `<div class="seo-row" style="margin:0 0 4px"><h3 style="margin:0">★ Priority pages</h3>
        <span class="seo-note" data-w-pcount>${n} of 30 ticked</span></div>
      <p class="seo-note">The pages that matter most. They show first across SEO, and Site health checks them every night.
        Set each page's target search and goal from the ★ box in its page panel.${n ? "" : " None ticked yet, so Site health checks the home page and the 15 busiest pages."}</p>
      ${c.isAdmin ? `<div class="seo-row">
          ${[["all", "All pages"], ["sel", "Ticked"], ["sug", "Suggested"]].map(([k, l]) =>
            `<button class="seo-w-chip ${pFilt === k ? "is-on" : ""}" type="button" data-w-pf="${k}">${l}</button>`).join("")}
          <span class="seo-sp"></span>
          <input class="seo-input seo-w-find" type="search" data-w-pfind placeholder="Search title or address" value="${h.esc(pFind)}">
        </div>` : `<p class="seo-note">Only admins can change priority pages.</p>`}
      <div data-w-plist>${pListHtml()}</div>
      ${c.isAdmin ? `<div class="seo-w-acts"><button class="seo-btn" type="button" data-w-top>Tick the busiest pages</button></div>` : ""}
      <p class="seo-note">${wpLine}</p>`;
  }

  /* ----- the page ----- */

  function draw() {
    wrap.innerHTML = `<div class="seo-w-set">
      <div>
        <div class="seo-card">
          <div class="seo-row" style="margin:0 0 4px"><h3 style="margin:0">Topics</h3><span class="seo-sp"></span>
            <button class="seo-btn" type="button" data-w-add>Add topic</button>
            <button class="seo-btn" type="button" data-w-suggest>${topics.length ? "Replace with suggested topics" : "Start with suggested topics"}</button></div>
          <div class="seo-w-legend"><span><span class="seo-w-tag is-c">concern</span> what people have</span>
            <span><span class="seo-w-tag is-t">treatment</span> what they want done</span>
            <span>A search goes into the first topic with a matching word. Click a topic to edit it.</span></div>
          ${guessed ? `<div class="seo-w-tip">Your topic words were sorted into concern and treatment automatically. Check them, then press Save settings.</div>` : ""}
          ${topics.length ? `<div class="seo-w-thead"><span>Topic</span><span>Concern words</span><span>Treatment words</span><span>Pages</span></div>
            ${topics.map((t, i) => topicRow(t, i) + (i === openT ? topicEditor(t, i) : "")).join("")}`
            : `<p class="seo-note">No topics yet. Start with the suggested topics, then adjust them.</p>`}
          <h3 style="margin:18px 0 4px">Brand words</h3>
          <p class="seo-note">Searches containing these are grouped as Brand and left out of Opportunities.</p>
          <input class="seo-input seo-w-full" data-w-brand value="${h.esc(brand)}" placeholder="dermedica">
        </div>

        <div class="seo-card">${priorityHtml()}</div>

        <div class="seo-card">
          <h3 style="margin:0 0 4px">Advertising wording</h3>
          <p class="seo-note">Words and phrases Site health looks for on priority pages, including titles, descriptions and image alt text.
            One per line, with the reason after a <code>|</code> if you like. Matches whole words only, so “guarantee” doesn't match “guaranteed”.
            This is a starting list, not legal advice: have it checked by your compliance adviser.</p>
          <textarea class="seo-input seo-w-full seo-w-ta" rows="10" data-w-words>${h.esc(words)}</textarea>
          <div class="seo-w-acts"><button class="seo-btn" type="button" data-w-wdefault>Reset to the suggested list</button></div>
        </div>

        <div class="seo-w-acts">
          <button class="seo-btn on" type="button" data-w-save>Save settings</button>
          <span class="seo-note" data-w-dirty>${dirty ? "Unsaved changes" : ""}</span>
        </div>
      </div>

      <div class="seo-card">
        <h3 style="margin:0 0 4px">Busiest searches not in a topic</h3>
        <p class="seo-note">Add the word that matters to a topic. Edit the word if it should be shorter or longer. Press Save settings to keep it.</p>
        ${otherHtml()}
      </div>
    </div>`;
  }

  const refocus = (sel) => wrap.querySelector(sel)?.focus();

  wrap.oninput = (e) => {
    const t = e.target;
    if (t.dataset.wTname !== undefined) { topics[+t.dataset.wTname].name = t.value; mark(); }
    else if (t.dataset.wChipin !== undefined && t.value.includes(",")) {
      const [i, k] = t.dataset.wChipin.split("|");
      addWords(+i, k, t.value); draw(); refocus(`[data-w-chipin="${i}|${k}"]`);
    }
    else if (t.matches("[data-w-tfind]")) { tFind = t.value; tMore = false; wrap.querySelector("[data-w-tlist]").innerHTML = tListHtml(openT); }
    else if (t.matches("[data-w-pfind]")) { pFind = t.value; pMore = false; wrap.querySelector("[data-w-plist]").innerHTML = pListHtml(); }
    else if (t.matches("[data-w-brand]")) { brand = t.value; mark(); }
    else if (t.matches("[data-w-words]")) { words = t.value; mark(); }
  };

  wrap.onchange = (e) => {
    const t = e.target;
    const row = t.closest(".seo-w-pk");
    if (t.dataset.wTpage !== undefined && topics[openT]) {
      const tp = topics[openT];
      const k = npath(t.dataset.wTpage);
      tp.pages = t.checked ? tp.pages.concat([t.dataset.wTpage]) : tp.pages.filter((p) => npath(p) !== k);
      row?.classList.toggle("is-on", t.checked);
      const cnt = wrap.querySelector("[data-w-tcount]");
      if (cnt) cnt.textContent = `${tp.pages.length} ticked`;
      mark();
    } else if (t.dataset.wPpage !== undefined && c.isAdmin) {
      const k = npath(t.dataset.wPpage);
      if (t.checked && keyPages.length >= 30) { t.checked = false; toast("You can tick up to 30 pages. Untick one first.", true); return; }
      keyPages = t.checked ? keyPages.concat([t.dataset.wPpage]) : keyPages.filter((p) => npath(p) !== k);
      row?.classList.toggle("is-on", t.checked);
      const cnt = wrap.querySelector("[data-w-pcount]");
      if (cnt) cnt.textContent = `${keyPages.length} of 30 ticked`;
      mark();
    }
  };

  wrap.onkeydown = (e) => {
    const ci = e.target.closest?.("[data-w-chipin]");
    if (ci) {
      const [i, k] = ci.dataset.wChipin.split("|");
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        if (addWords(+i, k, ci.value)) { draw(); refocus(`[data-w-chipin="${i}|${k}"]`); } else ci.value = "";
      } else if (e.key === "Backspace" && !ci.value && topics[+i][k].length) {
        topics[+i][k].pop(); mark(); draw(); refocus(`[data-w-chipin="${i}|${k}"]`);
      }
      return;
    }
    const row = e.target.closest?.("[data-w-topen]");
    if (row && (e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); row.click(); }
  };

  wrap.onclick = async (e) => {
    if (e.target.closest(".seo-w-pk")) return;   // tick boxes are handled by onchange
    const t = e.target.closest("button");
    const row = !t && e.target.closest("[data-w-topen]");
    if (!t && !row) return;
    commitPending();
    if (row) {
      const i = +row.dataset.wTopen;
      openT = openT === i ? -1 : i; tFind = ""; tMore = false;
      draw();
      return;
    }
    const d = t.dataset;
    if (d.wAdd !== undefined) {
      topics.push({ name: "", concern: [], treatment: [], pages: [] });
      openT = topics.length - 1; tFind = ""; mark(); draw();
      refocus(`[data-w-tname="${openT}"]`);
    } else if (d.wTclose !== undefined) {
      const tp = topics[openT];
      if (tp && !tp.name.trim() && !tp.concern.length && !tp.treatment.length && !tp.pages.length) topics.splice(openT, 1);
      openT = -1; draw();
    } else if (d.wChipx !== undefined) {
      const [i, k, j] = d.wChipx.split("|");
      topics[+i][k].splice(+j, 1); mark(); draw();
    } else if (d.wRm !== undefined) {
      const i = +d.wRm;
      if ((topics[i].concern.length || topics[i].treatment.length) && !confirm(`Delete the topic “${topics[i].name || "New topic"}”?`)) return;
      topics.splice(i, 1); openT = -1; mark(); draw();
    } else if (d.wUp !== undefined || d.wDown !== undefined) {
      const i = +(d.wUp ?? d.wDown), j = d.wUp !== undefined ? i - 1 : i + 1;
      if (j < 0 || j >= topics.length) return;
      [topics[i], topics[j]] = [topics[j], topics[i]];
      openT = j; mark(); draw();
    } else if (d.wTmore !== undefined) {
      tMore = true; wrap.querySelector("[data-w-tlist]").innerHTML = tListHtml(openT);
    } else if (d.wPmore !== undefined) {
      pMore = true; wrap.querySelector("[data-w-plist]").innerHTML = pListHtml();
    } else if (d.wPf !== undefined) {
      pFilt = d.wPf; pMore = false; draw();
    } else if (d.wSuggest !== undefined) {
      if (topics.length && !confirm("Replace your topics with the suggested list? Pages ticked on topics with the same name are kept.")) return;
      const keep = new Map(topics.map((x) => [x.name.toLowerCase(), x.pages]));
      topics = SUGGESTED.topics.map((x) => ({ name: x.name, concern: x.concern.slice(), treatment: x.treatment.slice(),
        pages: (keep.get(x.name.toLowerCase()) || []).slice() }));
      if (!brand.trim()) brand = SUGGESTED.brand.join(", ");
      openT = -1; mark(); draw();
    } else if (d.wTop !== undefined) {
      if (keyPages.length && !confirm("Replace the ticked pages with the home page and the 15 busiest pages?")) return;
      keyPages = ["/", ...idx.list.filter((x) => x.clicks > 0 && npath(x.path) !== "/").slice(0, 15).map((x) => x.path)];
      pFilt = "all"; mark(); draw();
    } else if (d.wWdefault !== undefined) {
      if (!confirm("Replace the advertising wording list with the suggested list?")) return;
      words = wordsText(COMPLIANCE); mark(); draw();
    } else if (d.wOadd !== undefined) {
      const r = t.closest("[data-w-orow]");
      const wd = norm(r.querySelector("[data-w-oword]").value);
      const ti = r.querySelector("[data-w-otopic]").value;
      const kind = r.querySelector("[data-w-okind]").value;
      if (!wd) { toast("Type the word to add.", true); return; }
      if (ti === "") { toast("Choose a topic.", true); return; }
      let i = +ti;
      if (ti === "new") {
        const name = prompt("Name for the new topic", titleCase(wd));
        if (!name || !name.trim()) return;
        topics.push({ name: name.trim().slice(0, 60), concern: [], treatment: [], pages: [] });
        i = topics.length - 1;
      }
      addWords(i, kind, wd);
      toast(`Added “${wd}” to ${topics[i].name}. Press Save settings to keep it.`);
      draw();
    } else if (d.wSave !== undefined) {
      const named = topics.filter((x) => x.name.trim() || x.concern.length || x.treatment.length);
      if (named.some((x) => !x.name.trim())) { toast("Give every topic a name.", true); return; }
      const clean = named.map((x) => {
        const concern = [...new Set(x.concern.map(norm).filter(Boolean))].slice(0, 60);
        const treatment = [...new Set(x.treatment.map(norm).filter(Boolean))].filter((y) => !concern.includes(y)).slice(0, 60);
        return { name: x.name.trim().slice(0, 60), concern, treatment, words: [...concern, ...treatment], pages: [...new Set(x.pages)].slice(0, 50) };
      });
      if (clean.some((x) => !x.words.length)) { toast("Every topic needs at least one word.", true); return; }
      const brands = brandList();
      const wordList = [];
      const seenW = new Set();
      for (const l of lines(words)) {
        const [wd, ...rest] = l.split("|");
        const word = norm(wd);
        if (!word || seenW.has(word)) continue;
        seenW.add(word);
        wordList.push({ word: word.slice(0, 80), why: rest.join("|").trim().slice(0, 150) });
      }
      const data = { topics: clean, brand: brands, compliance: wordList.slice(0, 200) };
      if (c.isAdmin) {   // only admins change priority pages; new ones get a suggested target search
        const pages = [...new Map(keyPages.map((p) => [npath(p), p])).values()].slice(0, 30);
        const { info } = prioritySettings(w);
        const keep = new Set(pages.map(npath));
        const have = new Set(info.map((x) => npath(x.path)));
        const now = new Date().toISOString();
        data.keyPages = pages;
        data.priorityInfo = info.filter((x) => keep.has(npath(x.path)))
          .concat(pages.filter((p) => !have.has(npath(p)))
            .map((p) => ({ path: p, ...suggestPriority(w, c.data, p), note: "", by: uid(), at: now })));
      }
      t.disabled = true;
      try {
        await setDoc(doc(db, "seo_settings", "main"), { ...data, updatedBy: uid(), updatedAt: serverTimestamp() }, { merge: true });
        w.settings = { ...(w.settings || {}), ...data };
        classify(w);
        if (w.ui) w.ui.topic = ALL;
        const s2 = settingsOf(w);
        topics = s2.topics.map((x) => ({ name: x.name, concern: x.concern.slice(), treatment: x.treatment.slice(), pages: x.pages.slice() }));
        brand = s2.brand.join(", ");
        keyPages = s2.keyPages.slice();
        words = wordsText(s2.compliance || []);
        dirty = false; openT = -1;
        toast("Settings saved. Priority page and wording changes show after the next nightly check.");
        draw();
      } catch (err) { t.disabled = false; toast(errMsg(err), true); }
    }
  };
  draw();
}
/* ---------- styles ---------- */

const CSS = `
.seo-w-intro{margin:0 0 12px}
.seo-w-topics{max-height:none;margin-bottom:6px}
.seo-table tr.is-on td{background:rgba(37,99,235,.07)}
.seo-w-qhead{margin-top:18px}
.seo-w-qhead h3{margin:0;font-size:15px}
.seo-w-toppage{max-width:260px;color:var(--text-muted,#6b7280)}
.seo-table tr.seo-w-sub td{background:#f8fafc;white-space:normal;cursor:default}
.seo-w-mini{width:100%;border-collapse:collapse;font-size:12.5px}
.seo-w-mini th,.seo-w-mini td{padding:5px 8px;text-align:right;border-top:1px solid var(--border,#e5e7eb)}
.seo-w-mini th:first-child,.seo-w-mini td:first-child{text-align:left;word-break:break-all}
.seo-w-link{border:0;background:none;padding:0;color:var(--accent,#2563eb);font:inherit;cursor:pointer;text-align:left;word-break:break-all}
.seo-w-link:hover{text-decoration:underline}
.seo-w-n{display:inline-block;min-width:18px;margin-left:4px;padding:0 6px;border-radius:999px;background:rgba(0,0,0,.08);font-size:11px}
.seo-btn.on .seo-w-n{background:rgba(255,255,255,.25)}
.seo-w-chip{border:1px solid var(--border,#e5e7eb);background:var(--card,#fff);color:inherit;border-radius:999px;padding:4px 12px;font:inherit;font-size:12.5px;cursor:pointer}
.seo-w-chip em{font-style:normal;color:var(--text-muted,#6b7280);margin-left:3px}
.seo-w-chip.is-on{border-color:var(--accent,#2563eb);background:#eff6ff;color:#1d4ed8}
.seo-w-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.seo-w-card{display:flex;flex-direction:column;gap:6px;padding:14px;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-top:3px solid var(--tone,#94a3b8);border-radius:10px;font-size:13px;min-width:0}
.seo-w-card.is-blue{--tone:#2563eb}.seo-w-card.is-amber{--tone:#d97706}.seo-w-card.is-red{--tone:#dc2626}.seo-w-card.is-violet{--tone:#7c3aed}
.seo-w-card header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.seo-w-card h4{margin:2px 0;font-size:15px;word-break:break-word}
.seo-w-card p{margin:0;line-height:1.45}
.seo-w-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--pbg,#f1f5f9);color:var(--pfg,#475569)}
.seo-w-pill.is-blue{--pbg:#eff6ff;--pfg:#1d4ed8}.seo-w-pill.is-amber{--pbg:#fffbeb;--pfg:#b45309}
.seo-w-pill.is-red{--pbg:#fef2f2;--pfg:#b91c1c}.seo-w-pill.is-violet{--pbg:#f5f3ff;--pfg:#6d28d9}
.seo-w-gain{font-size:12px;font-weight:600;color:#16a34a}
.seo-w-todo{padding:8px 10px;border-radius:8px;background:#f8fafc}
.seo-w-spark{display:flex;align-items:center;gap:8px}
.seo-w-note summary{cursor:pointer;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-w-note textarea{display:block;width:100%;min-width:0;margin:6px 0;box-sizing:border-box;resize:vertical}
.seo-w-notetext{padding:8px 10px;border-radius:8px;background:#fffbeb}
.seo-w-acts{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding-top:6px}
.seo-w-card .seo-w-acts{margin-top:auto}
.seo-w-log{display:grid;grid-template-columns:minmax(280px,380px) minmax(0,1fr);gap:16px;align-items:start}
.seo-w-log.is-ro{grid-template-columns:minmax(0,1fr)}
.seo-w-form h3{margin:0 0 8px;font-size:15px}
.seo-w-fgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0}
.seo-w-fgrid label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--text-muted,#6b7280)}
.seo-w-fgrid label small{font-weight:400}
.seo-w-fgrid .is-wide{grid-column:1/-1}
.seo-w-fgrid .seo-input{width:100%;min-width:0;box-sizing:border-box;font-weight:400}
.seo-w-month{margin:16px 0 4px;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#6b7280)}
.seo-w-entry{display:grid;grid-template-columns:100px minmax(0,1fr) auto;gap:12px;padding:10px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-w-edate{font-size:12px;color:var(--text-muted,#6b7280)}
.seo-w-emain{display:flex;flex-direction:column;gap:3px;min-width:0}
.seo-w-enote{margin:2px 0;white-space:pre-wrap}
.seo-w-effect{font-size:12px}
.seo-w-entry .seo-w-acts{padding-top:0;align-items:flex-start}
.seo-w-set{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,1fr);gap:16px;align-items:start}
.seo-w-trow{display:grid;grid-template-columns:180px minmax(0,1fr) auto auto;gap:6px;margin-bottom:6px}
.seo-w-trow .seo-input,.seo-w-full{width:100%;min-width:0;box-sizing:border-box}
.seo-w-panel h3{margin:18px 0 6px;font-size:14px}
.seo-w-why{list-style:none;margin:6px 0 8px;padding:0;font-size:13px}
.seo-w-why li{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:6px 0;border-top:1px solid var(--border,#e5e7eb)}
.seo-w-why li.is-main{font-weight:600}
.seo-w-why small{display:block;margin-top:2px;font-weight:400;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-w-why .n{white-space:nowrap;font-weight:600}
.seo-w-why .n.up{color:#16a34a}.seo-w-why .n.down{color:#dc2626}.seo-w-why .n.flat{color:var(--text-muted,#6b7280)}
.seo-w-tip{padding:8px 10px;border-radius:8px;background:#eff6ff;font-size:13px;line-height:1.45;margin:6px 0 8px}
.seo-w-rel td{vertical-align:top}
.seo-w-plan{margin:8px 0 10px;padding:8px 12px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--card,#fff)}
.seo-w-plan summary{cursor:pointer;font-weight:600;font-size:14px}
.seo-w-plan summary small{font-weight:400;color:var(--text-muted,#6b7280)}
.seo-w-plan h4{margin:12px 0 4px;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#6b7280)}
.seo-w-plan ol{margin:0;padding-left:20px;font-size:13px;line-height:1.5}
.seo-w-plan li{margin:0 0 7px}
.seo-w-eff{display:inline-block;padding:0 6px;border-radius:999px;font-size:10.5px;font-weight:600;vertical-align:1px;cursor:help}
.seo-w-eff.is-quick{background:#ecfdf5;color:#047857}
.seo-w-eff.is-medium{background:#fffbeb;color:#b45309}
.seo-w-eff.is-bigger{background:#fef2f2;color:#b91c1c}
.seo-w-mini td{vertical-align:top}
.seo-w-plog{margin:0 0 10px;padding-left:18px;font-size:13px}
.seo-w-plog span{color:var(--text-muted,#6b7280);margin-right:4px}
.seo-mark line{stroke:#f59e0b;stroke-width:1.5;stroke-dasharray:4 4}
.seo-mark circle{fill:#f59e0b;cursor:help}
.seo-w-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2000;padding:10px 16px;border-radius:999px;background:#0f172a;color:#fff;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.2)}
.seo-w-toast.is-bad{background:#b91c1c}
.seo-star{border:0;background:none;padding:0 5px 0 0;font:inherit;font-size:15px;line-height:1;color:#cbd5e1;cursor:pointer;vertical-align:-1px}
.seo-star:hover,.seo-star.is-on{color:#f59e0b}
span.seo-star{cursor:default}
.seo-w-pill.is-pri{--pbg:#fffbeb;--pfg:#b45309}
.seo-w-card.is-pri{background:linear-gradient(#fffdf5,#fff 45%)}
.seo-w-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin:4px 0 10px;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-w-tag{display:inline-flex;align-items:center;gap:2px;margin:0 4px 4px 0;padding:1px 8px;border-radius:999px;font-size:12px;line-height:1.6;white-space:nowrap}
.seo-w-tag.is-c{background:#f5f3ff;color:#5b21b6}
.seo-w-tag.is-t{background:#ecfdf5;color:#047857}
.seo-w-tag button{border:0;background:none;padding:0 0 0 3px;font:inherit;font-size:14px;line-height:1;color:inherit;cursor:pointer;opacity:.6}
.seo-w-tag button:hover{opacity:1}
.seo-w-thead,.seo-w-trow2{display:grid;grid-template-columns:150px minmax(0,1fr) minmax(0,1fr) 72px;gap:10px;align-items:start}
.seo-w-thead{padding:0 8px 4px;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-w-trow2{padding:9px 8px;border-top:1px solid var(--border,#e5e7eb);font-size:13px;cursor:pointer}
.seo-w-trow2:hover{background:#f8fafc}
.seo-w-trow2.is-open{background:#eff6ff;border-radius:8px 8px 0 0}
.seo-w-trow2 .is-none{color:#b45309}
.seo-w-tedit{margin:0 0 10px;padding:12px;border:1px solid #bfdbfe;border-top:0;border-radius:0 0 10px 10px}
.seo-w-tedit-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.seo-w-tedit-h .seo-input{flex:0 1 240px;min-width:0;font-weight:600}
.seo-w-tcols{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.seo-w-chips{display:flex;flex-wrap:wrap;align-items:center;min-height:38px;margin-top:4px;padding:6px 8px 2px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--card,#fff);box-sizing:border-box}
.seo-w-chips input{flex:1;min-width:110px;margin-bottom:4px;border:0;outline:0;background:none;font:inherit;font-size:13px;color:inherit}
.seo-w-find{min-width:0;width:220px}
.seo-w-pklist{border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--card,#fff)}
.seo-w-pk{display:grid;grid-template-columns:18px minmax(0,1fr) 56px;gap:10px;align-items:center;padding:7px 10px;border-top:1px solid var(--border,#e5e7eb);font-size:13px;cursor:pointer}
.seo-w-pk:first-child{border-top:0}
.seo-w-pk:hover{background:#f8fafc}
.seo-w-pk.is-on{background:#eff6ff}
.seo-w-pk input{margin:0}
.seo-w-pkt{min-width:0}
.seo-w-pkt .t,.seo-w-pkt .p{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-w-pkt .p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--text-muted,#6b7280)}
.seo-w-pkt em{margin-left:6px;padding:0 6px;border-radius:999px;background:#fffbeb;color:#b45309;font-style:normal;font-size:11px}
.seo-w-pkt em.is-old{background:#f1f5f9;color:#475569}
.seo-w-pkc{text-align:right;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-w-orow{padding:9px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-w-orow > div:first-child{display:flex;justify-content:space-between;gap:8px}
.seo-w-oacts{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}
.seo-w-oacts .seo-input{width:100%;min-width:0;box-sizing:border-box;padding:4px 8px}
@media (max-width:900px){.seo-w-log,.seo-w-set{grid-template-columns:1fr}}
@media (max-width:640px){
  .seo-w-thead{display:none}
  .seo-w-trow2{grid-template-columns:1fr}
  .seo-w-tcols{grid-template-columns:1fr}
  .seo-w-find{width:100%}
}
@media (max-width:640px){
  .seo-w-entry{grid-template-columns:1fr}
  .seo-w-trow{grid-template-columns:1fr auto auto}
  .seo-w-trow input:first-child{grid-column:1/-1}
  .seo-w-fgrid{grid-template-columns:1fr}
}
`;

function injectWorkCss() {
  if (document.getElementById("seo-work-css")) return;
  const s = document.createElement("style");
  s.id = "seo-work-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}