// seo.js — SEO section, Phase 1: Overview + Pages
// Reads: seo_state/overview, seo_state/run, seo_pages (current build only)

// ⚠️ Make these match recall.js exactly (same Firebase version, same db instance)
import { db } from "./firebase-config.js";
import { doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { loadWork, renderWorkTab, pagePanelExtras, logMarks, makeCan, titleOf } from "./seo-work.js?v=15";
import { renderTasks } from "./seo-tasks.js?v=9";
import { renderClusters } from "./seo-clusters.js?v=2";
import { renderAdvisor } from "./seo-advisor.js?v=2";
import { drillHtml, loadWindows } from "./seo-drill.js?v=4";
import { compareHtml } from "./seo-compare.js?v=1";
import { mountSeoSite } from "./seo-site.js?v=4";
import { priorityCardHtml, panelPriorityHtml, starHtml, toggleStar, savePriorityDetails, isPriorityPath, prToast, priorityRows } from "./seo-priority.js?v=9";
import { renderAds, clearAds } from "./seo-ads.js?v=3";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "advisor", label: "Advisor" },
  { id: "pages", label: "Pages" },
  { id: "website", label: "Website" },
  { id: "keywords", label: "Keywords" },
  { id: "ads", label: "Ads" },
  { id: "opps", label: "Tasks" },
  { id: "health", label: "Site health" },
  { id: "audience", label: "Audience" },
  { id: "log", label: "Change log" },
  { id: "settings", label: "Settings", manage: true },
];

const METRICS = {
  clicks:      { label: "Clicks",           fmt: (v) => fmtInt(v) },
  impressions: { label: "Impressions",      fmt: (v) => fmtInt(v) },
  ctr:         { label: "CTR",              fmt: (v) => fmtPct(v) },
  position:    { label: "Avg position",     fmt: (v) => fmtPos(v), invert: true },
  sessions:    { label: "Organic sessions", fmt: (v) => fmtInt(v) },
  bounce:      { label: "Bounce rate",      fmt: (v) => fmtB(v), invert: true },
  nonBrand:    { label: "Non-brand clicks", fmt: (v) => fmtInt(v), brand: true },
};

/* ---------- data (cached for the session; Refresh reloads) ---------- */

const cache = { data: null, pending: null };

async function loadData(force) {
  if (cache.data && !force) return cache.data;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const [ovSnap, runSnap, engSnap] = await Promise.all([
      getDoc(doc(db, "seo_state", "overview")),
      getDoc(doc(db, "seo_state", "run")),
      getDoc(doc(db, "seo_state", "engagement")).catch(() => null),   // Seo12.gs: bounce rate by page and device
    ]);
    if (!ovSnap.exists()) throw new Error("No SEO data yet. Run runSeoNightly() in Apps Script.");
    const ov = ovSnap.data();
    const cols = ov.cols;
    const days = JSON.parse(ov.days).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

    const snap = await getDocs(query(collection(db, "seo_pages"), where("build", "==", ov.build)));
    const pages = snap.docs.map((d) => {
      const p = { id: d.id, ...d.data() };
      p.dailyArr = typeof p.daily === "string" ? (p.daily ? p.daily.split(",").map(Number) : []) : null;
      p.dailyIArr = typeof p.dailyI === "string" ? (p.dailyI ? p.dailyI.split(",").map(Number) : []) : null;
      p.dailyPArr = typeof p.dailyP === "string" ? (p.dailyP ? p.dailyP.split(",").map((v) => Number(v) / 10) : []) : null;
      p.dClicks = p.m28.clicks - p.prev28.clicks;
      // positive = moved up (better)
      p.dPos = p.m28.position != null && p.prev28.position != null ? p.prev28.position - p.m28.position : null;
      return p;
    });

    let eng = null;
    try {
      if (engSnap && engSnap.exists() && engSnap.data().json) eng = { ...JSON.parse(engSnap.data().json), state: engSnap.data() };
    } catch (e) { console.warn("Engagement not read:", e); }
    for (const p of pages) p.eng = eng && eng.pages ? eng.pages[tkey(p.path)] || null : null;
    cache.data = { ov, days, pages, eng, run: runSnap.exists() ? runSnap.data() : null };
    return cache.data;
  })();
  try { return await cache.pending; } finally { cache.pending = null; }
}

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => Math.round(n || 0).toLocaleString("en-AU");
const fmtPct = (r) => ((r || 0) * 100).toFixed(2) + "%";
const fmtPos = (p) => (p == null ? "—" : p.toFixed(1));

/* Bounce rate: visits from Google that left without engaging (GA4). [sessions, engaged, seconds…] → 0–1 */
const fmtB = (r) => (r == null ? "—" : Math.round(r * 100) + "%");
const fmtDur = (s) => (s == null || !isFinite(s) ? "—" : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`);
const bRate = (a) => (a && a[0] ? 1 - a[1] / a[0] : null);
const bTone = (r) => (r == null ? "" : r <= 0.45 ? "good" : r <= 0.65 ? "ok" : "high");
// A page's bounce rate, last 28 days: from the engagement update, otherwise from the nightly numbers
const pageBounce = (p) => (p.eng && p.eng.c[0] ? bRate(p.eng.c) : p.m28.sessions ? 1 - (p.m28.engaged || 0) / p.m28.sessions : null);
const pageTime = (p) => (p.eng && p.eng.c[0] ? p.eng.c[2] / p.eng.c[0] : null);
const bChip = (r, n) => (r == null ? `<span class="seo-note">—</span>`
  : `<span class="seo-bnc is-${bTone(r)}"${n != null && n < 20 ? ' title="Fewer than 20 visits: not much to go on"' : ""}>${fmtB(r)}</span>`);

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

function addYears(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y + n, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);   // 29 Feb → 28 Feb
  return dt.toISOString().slice(0, 10);
}

const PRESETS = [
  ["7", "7 days"], ["28", "28 days"], ["90", "90 days"], ["thisMonth", "This month"], ["lastMonth", "Last month"],
  ["ytd", "This year"], ["12m", "12 months"], ["custom", "Custom"],
];

/** The chosen dates. end = last settled day; first / last = the data's first and last days */
function rangeOf(ui, end, first, last) {
  const clamp = (d) => (d < first ? first : d > last ? last : d);
  const L = new Date(last + "T00:00:00Z");
  let from, to = end;
  switch (ui.preset) {
    case "7": case "28": case "90": from = addDays(end, -(Number(ui.preset) - 1)); break;
    case "thisMonth": from = last.slice(0, 8) + "01"; to = last; break;
    case "lastMonth":
      from = new Date(Date.UTC(L.getUTCFullYear(), L.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
      to = new Date(Date.UTC(L.getUTCFullYear(), L.getUTCMonth(), 0)).toISOString().slice(0, 10);
      break;
    case "ytd": from = last.slice(0, 4) + "-01-01"; to = last; break;
    case "12m": from = addDays(addYears(end, -1), 1); break;
    default: from = ui.from || addDays(end, -27); to = ui.to || end;
  }
  from = clamp(from); to = clamp(to);
  if (from > to) [from, to] = [to, from];
  return { from, to, n: daysBetween(from, to) + 1 };
}

function compareOf(r, mode, first) {
  if (mode === "none") return null;
  let from, to;
  if (mode === "year") { from = addYears(r.from, -1); to = addYears(r.to, -1); }
  else { to = addDays(r.from, -1); from = addDays(to, -(r.n - 1)); }
  return { from, to, ok: from >= first, name: mode === "year" ? "Same time last year" : "Previous period" };
}

const autoGran = (n) => (n <= 45 ? "day" : n <= 400 ? "week" : "month");

/** Days, weeks (ending on the last day) or calendar months between two dates */
function buckets(from, to, gran) {
  const out = [];
  if (gran === "day") {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ start: d, end: d });
  } else if (gran === "week") {
    for (let e = to; e >= from;) {
      const s = addDays(e, -6) < from ? from : addDays(e, -6);
      out.unshift({ start: s, end: e });
      e = addDays(s, -1);
    }
  } else {
    for (let s = from; s <= to;) {
      const [y, m] = s.split("-").map(Number);
      const me = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const e = me > to ? to : me;
      out.push({ start: s, end: e });
      s = addDays(e, 1);
    }
  }
  return out;
}

function bucketLabel(b, gran) {
  const len = daysBetween(b.start, b.end) + 1;
  const f = (iso, o) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { ...o, timeZone: "UTC" });
  if (gran === "day") return f(b.start, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  if (gran === "month") {
    const full = b.start.endsWith("-01") && addDays(b.end, 1).endsWith("-01");
    return f(b.start, { month: "long", year: "numeric" }) + (full ? "" : ` (${fmtDate(b.start, false)} – ${fmtDate(b.end, false)})`);
  }
  return `${fmtDate(b.start, false)} – ${fmtDate(b.end)}${len < 7 ? ` (${len} days)` : ""}`;
}

function fmtDate(iso, withYear = true) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU",
    { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** Totals over [from, to]; position is impression-weighted. nonBrand is null unless every day has brand data. */
function sumRange(days, from, to) {
  const t = { clicks: 0, impressions: 0, posW: 0, posI: 0, sessions: 0, engaged: 0, conversions: 0, aiSessions: 0,
    brandClicks: 0, brandImpressions: 0, days: 0, brandDays: 0 };
  for (const d of days) {
    if (d.date < from || d.date > to) continue;
    t.days++;
    t.clicks += d.clicks; t.impressions += d.impressions;
    if (d.position != null && d.impressions) { t.posW += d.position * d.impressions; t.posI += d.impressions; }
    t.sessions += d.sessions; t.engaged += d.engaged; t.conversions += d.conversions; t.aiSessions += d.aiSessions;
    if (d.brandClicks != null) { t.brandClicks += d.brandClicks; t.brandImpressions += d.brandImpressions || 0; t.brandDays++; }
  }
  t.ctr = t.impressions ? t.clicks / t.impressions : 0;
  t.bounce = t.sessions ? 1 - t.engaged / t.sessions : null;
  t.position = t.posI ? t.posW / t.posI : null;
  t.nonBrand = t.days && t.brandDays === t.days ? t.clicks - t.brandClicks : null;
  t.brandShare = t.nonBrand != null && t.clicks ? t.brandClicks / t.clicks : null;
  return t;
}

/** Change chip. invert: lower is better (position). abs: show absolute difference instead of % */
function delta(cur, prev, { invert = false, abs = false, digits = 1 } = {}) {
  if (cur == null || prev == null) return `<span class="seo-d flat">—</span>`;
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9) return `<span class="seo-d flat">no change</span>`;
  const good = invert ? diff < 0 : diff > 0;
  const arrow = good ? "▲" : "▼";
  const txt = abs ? Math.abs(diff).toFixed(digits) : prev ? Math.abs((diff / prev) * 100).toFixed(0) + "%" : "new";
  return `<span class="seo-d ${good ? "up" : "down"}">${arrow} ${txt}</span>`;
}

// Copies text when navigator.clipboard isn't available (older iPads, non-https)
function fallbackCopy(txt) {
  const ta = document.createElement("textarea");
  ta.value = txt;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

function sparkline(vals, w = 84, h = 22) {
  const max = Math.max(1, ...vals);
  const step = w / Math.max(1, vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="seo-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function bars(vals, labels, w = 400, h = 120) {
  const max = Math.max(1, ...vals);
  const bw = w / vals.length;
  return `<svg viewBox="0 0 ${w} ${h + 18}" class="seo-bars">${vals.map((v, i) => {
    const bh = (v / max) * (h - 4);
    return `<g><title>${esc(labels[i])}: ${fmtInt(v)} clicks</title>
      <rect x="${(i * bw + 2).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${bh.toFixed(1)}" rx="2"/></g>`;
  }).join("")}
  <text x="0" y="${h + 14}">${esc(labels[0])}</text><text x="${w}" y="${h + 14}" text-anchor="end">${esc(labels[labels.length - 1])}</text></svg>`;
}

/** Line chart. points: [{ start, end, label, v }]. cmp: [{ label, v }] (same length) or null */
// multi: more lines [{ label, color, pts: [{ v }] }]; color / name: the main line's colour and name (for pages)
function lineChart(points, { invert = false, fmt = fmtInt, marks = [], cmp = null, freshAfter = "", gran = "week", multi = null, color = "", name = "", labels = false } = {}) {
  const W = 820, H = 240, L = 52, R = 12, T = labels ? 24 : 12, B = 28;   // more room at the top for the numbers
  const w = W - L - R, h = H - T - B;
  const vals = points.concat(cmp || [], ...(multi || []).map((s) => s.pts)).map((p) => p.v).filter((v) => v != null);
  if (!vals.length) return `<div class="seo-empty">No data for these dates</div>`;
  let min = Math.min(...vals), max = Math.max(...vals);
  if (!invert) min = Math.min(0, min);
  if (max === min) max = min + 1;
  const n = points.length;
  const x = (i) => L + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v) => T + (invert ? (v - min) / (max - min) : 1 - (v - min) / (max - min)) * h;
  const path = (arr) => {
    let d = "", pen = false;
    arr.forEach((p, i) => {
      if (p.v == null) { pen = false; return; }
      d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(p.v).toFixed(1);
      pen = true;
    });
    return d;
  };

  const grid = [0, 1, 2, 3, 4].map((k) => {
    const v = min + ((max - min) * k) / 4;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="seo-grid"/>
      <text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`;
  }).join("");

  // About 7 labels along the bottom, whatever the length
  const every = Math.max(1, Math.ceil(n / 7));
  const xl = points.map((p, i) => {
    if (i % every) return "";
    const d = new Date(p.start + "T00:00:00Z");
    const t = gran === "month"
      ? d.toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" })
      : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
    return `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : "middle"}">${esc(t)}</text>`;
  }).join("");

  const step = n > 1 ? w / (n - 1) : w;

  // Days Search Console is still settling (after the last complete day)
  const fi = freshAfter ? points.findIndex((p) => p.end > freshAfter) : -1;
  const fx = fi >= 0 ? Math.max(L, x(fi) - step / 2) : 0;
  const fresh = fi >= 0
    ? `<rect class="seo-fresh" x="${fx.toFixed(1)}" y="${T}" width="${(W - R - fx).toFixed(1)}" height="${h}"><title>Search Console may still update these days</title></rect>`
    : "";

  const dotStyle = color ? ` style="fill:${color}"` : "";
  const dots = n <= 62 && !(multi && multi.length) ? points.map((p, i) => (p.v == null ? ""
    : `<circle class="seo-dot" cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${n <= 31 ? 2.5 : 1.8}"${dotStyle}/>`)).join("") : "";
  const more = (multi || []).map((s) => `<path d="${path(s.pts)}" class="seo-line" style="stroke:${s.color}"/>`).join("");

  const hits = points.map((p, i) => {
    const c = cmp && cmp[i];
    const val = (v) => (v == null ? "—" : fmt(v));
    const tip = multi && multi.length
      ? [p.label, `${name}: ${val(p.v)}`, ...multi.map((s) => `${s.label}: ${val(s.pts[i]?.v)}`)].join("\n")
      : `${p.label}${name ? ` · ${name}` : ""}: ${val(p.v)}` + (c ? `\n${c.label}: ${val(c.v)}` : "");
    return `<rect x="${(x(i) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${h}" fill="transparent"><title>${esc(tip)}</title></rect>`;
  }).join("");

  const byIdx = {};
  for (const mk of marks) {
    const i = points.findIndex((p) => mk.date >= p.start && mk.date <= p.end);
    if (i >= 0) (byIdx[i] = byIdx[i] || []).push(mk.title);
  }
  const mks = Object.entries(byIdx).map(([i, titles]) => {
    const xx = x(+i).toFixed(1);
    return `<g class="seo-mark"><line x1="${xx}" x2="${xx}" y1="${T}" y2="${T + h}"/><circle cx="${xx}" cy="${T + 5}" r="5"/><title>${esc(titles.join("\n"))}</title></g>`;
  }).join("");

  // Numbers on the chart: each line's peaks (highest first, skipping any that would overlap) and its latest point.
  // With 14 points or fewer, every point. "Peak" means highest on screen, so for position it's the best (lowest) number.
  const placed = [];
  const labelLine = (arr, col) => {
    const P = arr.map((p, i) => (p.v == null ? null : { i, v: p.v, X: x(i), Y: y(p.v) }));
    const real = P.filter(Boolean);
    if (!real.length) return;
    let pick;
    if (n <= 14) pick = real;
    else {
      pick = real.filter((p) => {
        const a = P[p.i - 1], b = P[p.i + 1];
        return (!a || p.Y <= a.Y) && (!b || p.Y <= b.Y) && ((a && p.Y < a.Y) || (b && p.Y < b.Y));
      });
      const last = real[real.length - 1];
      if (!pick.includes(last)) pick.push(last);
    }
    pick.sort((p, q) => p.Y - q.Y);
    let count = 0;
    for (const p of pick) {
      if (count >= 10 && n > 14) break;
      if (placed.some((o) => Math.abs(o.X - p.X) < 28 && Math.abs(o.Y - p.Y) < 16)) continue;
      placed.push({ X: p.X, Y: p.Y, txt: fmt(p.v), col });
      count++;
    }
  };
  if (labels) {
    labelLine(points, color || "var(--accent,#2563eb)");
    (multi || []).forEach((s) => labelLine(s.pts, s.color));
  }
  const vlabs = placed.map((l) => `<text class="seo-vlab" x="${l.X.toFixed(1)}" y="${Math.max(T - 6, l.Y - 8).toFixed(1)}" text-anchor="middle" style="fill:${l.col}">${esc(l.txt)}</text>`).join("");

  return `<svg viewBox="0 0 ${W} ${H}">${fresh}${grid}${xl}${cmp ? `<path d="${path(cmp)}" class="seo-line-cmp"/>` : ""}${more}<path d="${path(points)}" class="seo-line"${color ? ` style="stroke:${color}"` : ""}/>${dots}${vlabs}${hits}${mks}</svg>`;
}


/* ---------- the Trend card's pages ---------- */

const TCOLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#db2777", "#0891b2"];
const TMAX = 6;
const PAGE_METRICS = ["clicks", "impressions", "ctr", "position"];
// A page's address for matching: no website address in front, no ?query or #part, no end slash, lower case
const tkey = (p) => {
  let s = String(p || "").trim().replace(/^https?:\/\/[^/]+/i, "").split("#")[0].split("?")[0];
  try { s = decodeURIComponent(s); } catch { /* as is */ }
  if (!s.startsWith("/")) s = "/" + s;
  return s.replace(/\/+$/, "").toLowerCase() || "/";
};
const shortT = (s, n = 34) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

/** Clicks, impressions, CTR or position for some pages over [from, to], from their daily numbers */
function pageVal(pgs, from, to, metric) {
  let c = 0, i = 0, pw = 0;
  for (const p of pgs) {
    if (!Array.isArray(p.dailyArr) || !p.dailyFrom) continue;
    const i0 = Math.max(0, daysBetween(p.dailyFrom, from)), i1 = daysBetween(p.dailyFrom, to);
    for (let d = i0; d <= i1; d++) {
      c += p.dailyArr[d] || 0;
      const imp = p.dailyIArr ? p.dailyIArr[d] || 0 : 0;
      i += imp;
      if (p.dailyPArr && imp) pw += (p.dailyPArr[d] || 0) * imp;
    }
  }
  if (metric === "clicks") return c;
  if (metric === "impressions") return i;
  if (metric === "ctr") return i ? c / i : null;
  return i ? pw / i : null;
}

/* ---------- styles ---------- */

const CSS = `
.seo{padding:4px 0 40px}
.seo-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.seo-head h1{margin:0;font-size:22px}
.seo-meta{color:var(--text-muted,#6b7280);font-size:13px;flex:1}
.seo-btn{border:1px solid var(--border,#e5e7eb);background:var(--card,#fff);color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px}
.seo-btn.on{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
.seo-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border,#e5e7eb);margin-bottom:16px}
.seo-tab{background:none;border:0;padding:10px 14px;cursor:pointer;font:inherit;color:var(--text-muted,#6b7280);border-bottom:2px solid transparent;margin-bottom:-1px}
.seo-tab.on{color:inherit;border-bottom-color:var(--accent,#2563eb);font-weight:600}
.seo-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.seo-row .seo-sp{flex:1}
.seo-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.seo-kpi,.seo-card{background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px}
.seo-kpi{padding:12px}
button.seo-kpi{display:block;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s}
button.seo-kpi:hover{border-color:#93c5fd}
button.seo-kpi.is-on{border-color:var(--accent,#2563eb);box-shadow:0 0 0 1px var(--accent,#2563eb)}
.seo-kpi .l{font-size:12px;color:var(--text-muted,#6b7280)}
.seo-kpi .v{font-size:22px;font-weight:600;margin:4px 0}
.seo-kpi .p{font-size:11px;color:var(--text-muted,#6b7280)}
.seo-d{font-size:12px;font-weight:600}
.seo-d.up{color:#16a34a}.seo-d.down{color:#dc2626}.seo-d.flat{color:var(--text-muted,#6b7280);font-weight:400}
.seo-card{padding:14px;margin-bottom:16px}
.seo-card h3{margin:0 0 10px;font-size:15px}
.seo-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.seo-list{list-style:none;margin:0;padding:0}
.seo-list li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--border,#e5e7eb);cursor:pointer;font-size:13px}
.seo-list li:first-child{border-top:0}
.seo-list li:hover .seo-path{text-decoration:underline}
.seo-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.seo-movers li{align-items:flex-start}
.seo-movers .seo-path small{display:block;font-size:11.5px;color:var(--text-muted,#6b7280);overflow:hidden;text-overflow:ellipsis}
.seo-mv-n{white-space:nowrap}
.seo-card h3 small{font-weight:400;margin-left:4px}
.seo-wc{background:#fbfdff}
.seo-wc-list{list-style:none;margin:0;padding:0;font-size:13.5px;line-height:1.5}
.seo-wc-list li{position:relative;padding:6px 0 6px 22px;border-top:1px solid var(--border,#e5e7eb)}
.seo-wc-list li:first-child{border-top:0}
.seo-wc-list li::before{position:absolute;left:3px;top:7px;font-size:11px;font-weight:700}
.seo-wc-list li.is-up::before{content:"▲";color:#16a34a}
.seo-wc-list li.is-down::before{content:"▼";color:#dc2626}
.seo-wc-list li.is-flat::before{content:"•";color:#94a3b8}
.seo-wc-list li.is-note::before{content:"✎";color:#d97706}
.seo-chart svg{width:100%;height:auto;display:block}
.seo-chart text,.seo-bars text{font-size:11px;fill:var(--text-muted,#6b7280)}
.seo-grid{stroke:var(--border,#e5e7eb);stroke-width:1}
.seo-line{fill:none;stroke:var(--accent,#2563eb);stroke-width:2}
.seo-line-cmp{fill:none;stroke:#94a3b8;stroke-width:1.5;stroke-dasharray:5 4}
.seo-dot{fill:var(--accent,#2563eb)}
.seo-chart text.seo-vlab{font-size:11px;font-weight:700;paint-order:stroke;stroke:var(--card,#fff);stroke-width:3px;stroke-linejoin:round;pointer-events:none}
.seo-fresh{fill:#f1f5f9}
.seo-range{gap:6px}
.seo-range label{display:flex;align-items:center;gap:6px}
.seo-date,.seo-select{min-width:0;padding:5px 8px}
.seo-btn:disabled{opacity:.45;cursor:not-allowed}
.seo-legend{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--text-muted,#6b7280);margin-top:6px}
.seo-legend span{display:inline-block;width:22px;height:0;border-top:2px solid var(--accent,#2563eb);margin-left:10px}
.seo-legend span:first-child{margin-left:0}
.seo-legend .is-cmp{border-top:2px dashed #94a3b8}
.seo-seg{display:inline-flex;gap:3px;padding:3px;border-radius:10px;background:#f1f5f9}
.seo-seg button{border:0;background:none;padding:5px 12px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;color:inherit}
.seo-seg button.on{background:var(--card,#fff);box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:600}
.seo-tp{margin:0 0 10px;padding:10px 12px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:#fafbfc}
.seo-tp-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.seo-tp-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 4px 3px 10px;border:1px solid var(--border,#e5e7eb);border-radius:999px;background:var(--card,#fff);font-size:12.5px}
.seo-tp-chip i{width:10px;height:10px;border-radius:50%}
.seo-tp-chip button{border:0;background:none;padding:0 6px;font-size:15px;line-height:1;cursor:pointer;color:var(--text-muted,#6b7280)}
.seo-tp-chip button:hover{color:#dc2626}
.seo-tp-combo{position:relative}
.seo-tp-msg{margin:0 0 8px;padding:8px 12px;border-radius:8px;background:#eff6ff;border:1px solid #bfdbfe;font-size:13px}
.seo-tp-nochart{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:200px;padding:20px;
  border:1px dashed var(--border,#e5e7eb);border-radius:10px;text-align:center;font-size:13.5px;color:var(--text-muted,#6b7280);line-height:1.6}
.seo-tp-nochart b{color:var(--text,#1e293b)}
.seo-tp-add{min-width:280px;padding:6px 12px;border-radius:999px}
.seo-tp-add:focus{outline:none;border-color:var(--accent,#2563eb);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
.seo-tp-res{display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:30;width:min(460px,90vw);max-height:360px;overflow:auto;
  padding:6px;border:1px solid var(--border,#e5e7eb);border-radius:12px;background:var(--card,#fff);box-shadow:0 12px 32px rgba(15,23,42,.14)}
.seo-tp-combo:focus-within .seo-tp-res{display:block}
.seo-tp-src{padding:4px 8px 6px;font-size:11.5px;color:var(--text-muted,#6b7280)}
.seo-tp-opt{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1px 10px;width:100%;padding:8px 10px;border:0;border-radius:8px;
  background:none;font:inherit;text-align:left;cursor:pointer;color:inherit}
.seo-tp-opt:hover,.seo-tp-opt.is-on{background:#eff6ff}
.seo-tp-opt .t{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-tp-opt .n{font-size:12px;color:var(--text-muted,#6b7280);white-space:nowrap;align-self:center}
.seo-tp-opt .p{grid-column:1 / -1;font-size:11.5px;color:var(--text-muted,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-tp-star{color:#f59e0b;font-weight:400;margin-right:4px}
.seo-tp-empty,.seo-tp-more{padding:10px;font-size:12.5px;color:var(--text-muted,#6b7280)}
.seo-tp-more{border-top:1px solid var(--border,#e5e7eb);margin-top:4px}
.seo-bars{width:100%;height:auto}
.seo-bars rect{fill:var(--accent,#2563eb);opacity:.8}
.seo-spark{color:var(--accent,#2563eb);vertical-align:middle}
.seo-table-wrap{overflow:auto;max-height:70vh;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--card,#fff)}
.seo-table{width:100%;border-collapse:collapse;font-size:13px}
.seo-table th{position:sticky;top:0;z-index:1;background:var(--card,#fff);text-align:right;padding:8px 10px;border-bottom:1px solid var(--border,#e5e7eb);white-space:nowrap;cursor:pointer;user-select:none;font-weight:600}
.seo-table th.on{color:var(--accent,#2563eb)}
.seo-table td{text-align:right;padding:7px 10px;border-top:1px solid var(--border,#e5e7eb);white-space:nowrap}
.seo-table th:first-child,.seo-table td:first-child{text-align:left;max-width:380px}
.seo-table tbody tr{cursor:pointer}
.seo-table tbody tr:hover{background:rgba(37,99,235,.05)}
.seo-input{border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;min-width:240px;background:var(--card,#fff);color:inherit}
.seo-check{font-size:13px;display:flex;align-items:center;gap:6px}
.seo-empty{padding:40px;text-align:center;color:var(--text-muted,#6b7280)}
.seo-err{color:#dc2626}
.seo-warn{background:#fef3c7;border:1px solid #fcd34d;color:#78350f;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px}
.seo-note{font-size:12px;color:var(--text-muted,#6b7280)}
.seo-panel{position:fixed;top:0;right:0;bottom:0;width:min(460px,100vw);background:var(--card,#fff);border-left:1px solid var(--border,#e5e7eb);box-shadow:-8px 0 24px rgba(0,0,0,.08);z-index:1000;overflow:auto;padding:18px}
.seo-panel[hidden]{display:none}
.seo-panel h2{font-size:16px;margin:0 0 4px;word-break:break-all}
.seo-panel .x{float:right}
.seo-kv{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}
.seo-kv th,.seo-kv td{padding:6px 4px;border-top:1px solid var(--border,#e5e7eb);text-align:right}
.seo-kv th:first-child,.seo-kv td:first-child{text-align:left;font-weight:400;color:var(--text-muted,#6b7280)}
`;

function injectCss() {
  if (document.getElementById("seo-css")) return;
  const s = document.createElement("style");
  s.id = "seo-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ---------- page ---------- */

export async function mountSeo(el, opts = {}) {
  const { param } = opts;
  injectCss();

  const can = makeCan(opts);
  const isAdmin = opts.isAdmin === true || /^admin$/i.test(String(opts.staff?.role || opts.staff?.staffRole || ""));
  const tabs = TABS.filter((t) => !t.manage || can("seo.manage"));
  let work = null;
  const [param0, ...paramRest] = String(param || "").split("/");
  let tab = tabs.some((t) => t.id === param0) ? param0 : "overview";
  let siteParam = tab === "website" ? paramRest.join("/") : "";   // which page the Website tab opens
  const ui = { preset: "28", from: "", to: "", compare: "prev", gran: "auto", metric: "clicks",
    sortKey: "clicks", sortDir: -1, filter: "", hideZero: true, limit: 100, pview: "table", kpi: "", drtab: "", drOpen: "" };
  let W = null;          // the Overview drill-downs (seo_windows), loaded the first time a card is opened
  let wForce = false;
  const OV_KEY = "dm.seo.overview";
  try {
    const s = JSON.parse(sessionStorage.getItem(OV_KEY) || "{}") || {};
    ["preset", "from", "to", "compare", "gran", "metric"].forEach((k) => { if (typeof s[k] === "string") ui[k] = s[k]; });
  } catch { /* private mode */ }
  const saveOv = () => {
    try {
      sessionStorage.setItem(OV_KEY, JSON.stringify({ preset: ui.preset, from: ui.from, to: ui.to,
        compare: ui.compare, gran: ui.gran, metric: ui.metric }));
    } catch { /* private mode */ }
  };
  // The Trend card: whole site or pages, which pages, separate lines or combined (remembered on this device)
  const TR_KEY = "dm.seo.trend";
  try {
    const s = JSON.parse(localStorage.getItem(TR_KEY) || "{}") || {};
    ui.tshow = s.tshow === "pages" ? "pages" : "site";
    ui.tpages = Array.isArray(s.tpages) ? s.tpages.filter((x) => typeof x === "string").slice(0, TMAX) : [];
    ui.tmode = s.tmode === "sum" ? "sum" : "sep";
    ui.tnum = s.tnum !== false;   // numbers on the chart: on unless turned off
  } catch { ui.tshow = "site"; ui.tpages = []; ui.tmode = "sep"; ui.tnum = true; }
  const saveTr = () => { try { localStorage.setItem(TR_KEY, JSON.stringify({ tshow: ui.tshow, tpages: ui.tpages, tmode: ui.tmode, tnum: ui.tnum })); } catch { /* private mode */ } };
  // The page search in the Trend card: every WordPress page and post, plus any page Google knows
  let tpActive = 0, tpLast = [];
  const tpAll = () => {
    const m = new Map();
    const typeName = (t) => (!t || t === "page" ? "Page" : t === "post" ? "Blog post" : String(t).replace(/[-_]/g, " ").replace(/^./, (ch) => ch.toUpperCase()));
    (work?.wp?.pages || []).forEach((p) => {
      const raw = p && (p.path || p.url || p.link);
      if (!raw) return;
      const path = String(raw).replace(/^https?:\/\/[^/]+/i, "") || "/";
      m.set(tkey(path), { path, title: p.title || titleOf(work, data, path), type: typeName(p.type), clicks: 0 });
    });
    data.pages.forEach((p) => {
      const k = tkey(p.path);
      const x = m.get(k);
      if (x) { x.clicks += p.m28.clicks; x.path = p.path; }   // use Google's version of the address
      else if (p.m28.impressions > 0) m.set(k, { path: p.path, title: titleOf(work, data, p.path), type: "Page", clicks: p.m28.clicks });
    });
    return [...m.values()];
  };
  const tpResults = (q) => {
    const chosen = new Set(ui.tpages.map(tkey));
    const ws = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = tpAll();
    const hits = all.filter((x) => !chosen.has(tkey(x.path)) && ws.every((w) => (x.title + " " + x.path).toLowerCase().includes(w)))
      .sort((a, b) => b.clicks - a.clicks || a.title.localeCompare(b.title));
    tpLast = hits.slice(0, 8);
    if (tpActive >= tpLast.length) tpActive = Math.max(0, tpLast.length - 1);
    if (!tpLast.length) return `<div class="seo-tp-empty">No pages match “${esc(q)}”.</div>`;
    return `<div class="seo-tp-src">${ws.length ? `${fmtInt(hits.length)} match${hits.length === 1 ? "" : "es"}` : `${fmtInt(all.length)} pages from WordPress and Google · busiest first`}</div>` +
      tpLast.map((x, i) => `<button type="button" class="seo-tp-opt${i === tpActive ? " is-on" : ""}" role="option" aria-selected="${i === tpActive}" data-tpick="${esc(x.path)}">
        <span class="t">${isPriorityPath(work, x.path) ? `<b class="seo-tp-star">★</b>` : ""}${esc(x.title)}</span>
        <span class="n">${x.clicks ? `${fmtInt(x.clicks)} clicks` : esc(x.type)}</span>
        <span class="p">${esc(x.path)}</span></button>`).join("") +
      (hits.length > 8 ? `<div class="seo-tp-more">${fmtInt(hits.length - 8)} more. Keep typing to narrow it down.</div>` : "");
  };
  const tpRefresh = (input) => {
    const box = input.closest(".seo-tp-combo")?.querySelector("[data-tpres]");
    if (box) box.innerHTML = tpResults(input.value);
  };

  const addTPages = (paths) => {
    const seen = new Set(ui.tpages.map(tkey));
    for (const p of paths) {
      if (ui.tpages.length >= TMAX) break;
      if (!p || seen.has(tkey(p))) continue;
      seen.add(tkey(p));
      ui.tpages.push(p);
    }
    ui.tshow = "pages";
    saveTr();
    render();
  };

  // The Overview's Priority pages card: open or collapsed, status filter, show all (remembered on this device)
  const PR_KEY = "dm.seo.prcard";
  const prc = (() => {
    try { return { open: false, filter: "", all: false, ...JSON.parse(localStorage.getItem(PR_KEY) || "{}") }; }
    catch { return { open: false, filter: "", all: false }; }
  })();
  const savePrc = () => { try { localStorage.setItem(PR_KEY, JSON.stringify(prc)); } catch { /* private mode */ } };

  const currentRange = () => {
    const d = data.days, end = data.ov.periodEnd;
    return rangeOf(ui, end, d[0]?.date || end, d[d.length - 1]?.date || end);
  };
  let data = null;
  let panelId = null;   // the page open in the side panel
  let prEdit = null;    // the priority page whose details are being edited

  el.innerHTML = `
    <div class="seo">
      <div class="seo-head">
        <h1>SEO</h1>
        <div class="seo-meta" data-meta></div>
        <button class="seo-btn" data-reload>Refresh</button>
      </div>
      <div class="seo-tabs">${tabs.map((t) => `<button class="seo-tab" data-tab="${t.id}">${t.label}</button>`).join("")}</div>
      <div data-body></div>
      <div class="seo-panel" data-panel hidden></div>
    </div>`;

  const $ = (s) => el.querySelector(s);
  const root = $(".seo");            // listeners go here, not on #content, so they're removed with the page
  const body = $("[data-body]");
  const panel = $("[data-panel]");


  function setTabs() {
    el.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  }

  async function load(force) {
    body.innerHTML = `<div class="seo-empty">Loading…</div>`;
    try {
      [data, work] = await Promise.all([loadData(force), loadWork(force)]);
      if (force) { W = null; wForce = true; clearAds(); }
      renderMeta();
      render();
    } catch (e) {
      const msg = /permission/i.test(e.message) ? "You don't have access to SEO data (needs the SEO menu permission)." : e.message;
      body.innerHTML = `<div class="seo-empty seo-err">${esc(msg)}</div>`;
    }
  }

  function renderMeta() {
    const { ov, run } = data;
    const at = run?.at?.toDate ? run.at.toDate() : ov.updatedAt?.toDate?.();
    $("[data-meta]").innerHTML =
      `Search data to ${fmtDate(ov.periodEnd)} · ${fmtInt(ov.pageCount)} pages` +
      (at ? ` · updated ${at.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : "");
  }

  function ctx() {
    return {
      data, work, can, isAdmin, staff: opts.staff,
      h: { esc, fmtInt, fmtPct, fmtPos, delta, addDays, fmtDate, sumRange, sparkline },
      byPath: new Map(data.pages.map((p) => [p.path, p])),
      kit: { PRESETS, rangeOf, compareOf, buckets, bucketLabel, autoGran, daysBetween, lineChart, tkey },
      prRows: () => priorityRows(ctx()),   // priority page status, used by Settings
      setTab: (id) => { tab = id; history.replaceState(null, "", "#/seo/" + id); render(); },
    };
  }

  function render() {
    setTabs();
    const warn = data.run && data.run.ok === false
      ? `<div class="seo-warn">The last nightly update failed, so these numbers may be out of date: ${esc(data.run.error || "")}</div>` : "";
    if (tab === "advisor") { renderAdvisor(body, ctx()); return; }
    if (tab === "ads") { renderAds(body, ctx()); return; }
    if (tab === "website") { const sp = siteParam; siteParam = ""; mountSeoSite(body, { param: sp }); return; }
    if (tab === "opps") { renderTasks(body, ctx()); return; }
    if (tab === "pages" && ui.pview === "clusters") { renderClusters(body, ctx()); return; }
    if (tab !== "overview" && tab !== "pages") { renderWorkTab(tab, body, ctx()); return; }
    body.innerHTML = warn + (tab === "overview" ? overviewHtml() : pagesShellHtml());
    if (tab === "pages") renderTable();
  }

    /* ----- Overview → Bounce rate: what's behind it ----- */
  function bounceHtml(cur, prev, cmp) {
    const E = data.eng;
    const head = `<div class="seo-row" style="margin:0 0 6px"><h3 style="margin:0">Bounce rate: what's behind it</h3><span class="seo-sp"></span>
      <button class="seo-btn" type="button" data-drclose>Close</button></div>`;
    const what = `<details class="seo-bn-what"><summary>What counts as a bounce?</summary>
      <p>A visit from Google where the person left without engaging: under 10 seconds, no second page, and no booking or enquiry.
      Lower is better. For treatment pages, under 45% is good, and over 65% usually means the page isn't giving people what they searched for.</p></details>`;
    const sentence = cur.bounce == null ? "" : `<p class="seo-bn-sum"><strong>${fmtB(cur.bounce)}</strong> of visits from Google left straight away in these dates${
      prev && prev.bounce != null ? ` (${fmtB(prev.bounce)} ${esc(cmp.name.toLowerCase())})` : ""}: about <strong>${fmtInt(cur.sessions * cur.bounce)}</strong> of ${fmtInt(cur.sessions)} visits.</p>`;
    if (!E) {
      return `<div class="seo-card seo-bn">${head}${sentence}<p class="seo-note">Pages and phone vs computer numbers appear once the engagement update has run.
        In Apps Script, run <code>runSeoEngagement</code> once, then <code>installSeoEngagementTrigger</code>.</p>${what}</div>`;
    }
    // Phones and computers
    const dev = E.site.dev || {};
    const tot = Object.values(dev).reduce((a, x) => a + x[0], 0) || 1;
    const devRow = (k, l) => {
      const x = dev[k];
      if (!x || !x[0]) return "";
      const share = Math.round((x[0] / tot) * 100);
      return `<div class="seo-bn-dev"><span>${l}</span><span class="seo-bn-bar"><i style="width:${share}%"></i></span>
        <span class="seo-note">${share}% of visits</span>${bChip(bRate(x), x[0])}<span class="seo-note">${fmtDur(x[2] / x[0])} engaged</span></div>`;
    };
    const mob = dev.mobile, desk = dev.desktop;
    const gap = mob && desk && mob[0] >= 30 && desk[0] >= 30 ? bRate(mob) - bRate(desk) : 0;
    // Pages losing the most visitors (each address once)
    const byK = new Map();
    for (const p of data.pages) if (p.eng && !byK.has(tkey(p.path))) byK.set(tkey(p.path), p);
    const rows = [...byK.values()].filter((p) => p.eng.c[0] >= 20)
      .map((p) => ({ p, b: bRate(p.eng.c), was: p.eng.p[0] >= 20 ? bRate(p.eng.p) : null, lost: p.eng.c[0] - p.eng.c[1] }))
      .sort((a, b) => b.lost - a.lost).slice(0, 15);
    const table = rows.length ? `<div class="seo-table-wrap" style="max-height:none"><table class="seo-table">
      <thead><tr><th>Page</th><th>Visits</th><th>Bounce</th><th>vs before</th><th>Engaged time</th><th>Mobile</th><th>Desktop</th></tr></thead>
      <tbody>${rows.map(({ p, b, was }) => `<tr data-open="${esc(p.id)}">
        <td><div class="seo-path" title="${esc(p.path)}">${starHtml(ctx(), p.path)}${esc(titleOf(work, data, p.path))}</div></td>
        <td>${fmtInt(p.eng.c[0])}</td><td>${bChip(b, p.eng.c[0])}</td>
        <td>${was == null ? "—" : delta(b * 100, was * 100, { invert: true, abs: true, digits: 0 })}</td>
        <td>${fmtDur(p.eng.c[2] / p.eng.c[0])}</td>
        <td>${p.eng.m[0] >= 10 ? bChip(bRate(p.eng.m), p.eng.m[0]) : "—"}</td>
        <td>${p.eng.d[0] >= 10 ? bChip(bRate(p.eng.d), p.eng.d[0]) : "—"}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="seo-note">Not enough visits per page yet (20 or more).</p>`;
    const tips = [];
    if (gap >= 0.1) tips.push(`Visitors on phones leave ${Math.round(gap * 100)} points more often than on computers. Open your main pages on a phone: does the top load fast, and is the next step (Book a consultation) clear without scrolling?`);
    if (rows[0] && rows[0].b > 0.65) tips.push(`Start with “${titleOf(work, data, rows[0].p.path)}”: it loses the most visitors. Make sure its first screen answers what people searched for.`);
    const at = E.at ? new Date(E.at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
    return `<div class="seo-card seo-bn">${head}${sentence}
      ${E.state && E.state.ok === false ? `<div class="seo-warn">The last engagement update failed: ${esc(E.state.error || "")}</div>` : ""}
      <h4 class="seo-bn-h">Phones and computers <span class="seo-note">· last 28 days</span></h4>
      ${devRow("mobile", "Mobile")}${devRow("desktop", "Desktop")}${devRow("tablet", "Tablet")}
      <h4 class="seo-bn-h">Pages losing the most visitors <span class="seo-note">· last 28 days, vs the 28 before (points)</span></h4>${table}
      ${tips.length ? `<div class="seo-bn-tips">${tips.map((x) => `<p>💡 ${esc(x)}</p>`).join("")}</div>` : ""}
      <div class="seo-w-acts" style="margin-top:10px">
        <button class="seo-btn" type="button" data-drask="${esc("Which pages have the highest bounce rate from Google visitors, and what should we change on them to keep people reading and booking?")}">Ask the Advisor about this</button>
        <span class="seo-note">${at ? `Updated ${esc(at)}` : ""}</span></div>
      ${what}</div>`;
  }

  /* ----- Overview ----- */

  function overviewHtml() {
    const { ov, days, pages } = data;
    const first = days[0]?.date || ov.periodEnd, last = days[days.length - 1]?.date || ov.periodEnd;
    const r = rangeOf(ui, ov.periodEnd, first, last);
    const cmp = compareOf(r, ui.compare, first);
    const cur = sumRange(days, r.from, r.to);
    const prev = cmp && cmp.ok ? sumRange(days, cmp.from, cmp.to) : null;
    const hasBrand = cur.nonBrand != null;

    const LABELS = {};
    const tile = (label, value, d, notes, key) => {
      const ns = notes.filter(Boolean);
      LABELS[key] = label;
      return `<button type="button" class="seo-kpi${ui.kpi === key ? " is-on" : ""}" data-kpi="${key}" aria-expanded="${ui.kpi === key}"
        title="See what's behind this number"><div class="l">${label}</div><div class="v">${value}</div>${d || ""}${ns.length ? `<div class="p">${ns.join(" · ")}</div>` : ""}</button>`;
    };
    const kpi = (label, key, f, opts = {}, note = "") => tile(label, f(cur[key]),
      prev ? delta(cur[key], prev[key], opts) : "",
      [prev && prev[key] != null ? `vs ${f(prev[key])}` : "", note], key);

    const kpis = [
      kpi("Clicks", "clicks", fmtInt),
      ...(hasBrand ? [
        kpi("Non-brand clicks", "nonBrand", fmtInt, {}, "treatment searches"),
        kpi("Brand clicks", "brandClicks", fmtInt, {}, cur.brandShare != null ? Math.round(cur.brandShare * 100) + "% of clicks" : ""),
      ] : []),
      kpi("Impressions", "impressions", fmtInt),
      kpi("CTR", "ctr", fmtPct),
      kpi("Avg position", "position", fmtPos, { invert: true, abs: true }, "lower is better"),
      kpi("Organic sessions", "sessions", fmtInt, {}, "GA4"),
      tile("Bounce rate", fmtB(cur.bounce),
        prev && cur.bounce != null && prev.bounce != null
          ? delta(cur.bounce * 100, prev.bounce * 100, { invert: true, abs: true, digits: 1 }).replace(/<\/span>$/, " pts</span>") : "",
        [prev && prev.bounce != null ? `vs ${fmtB(prev.bounce)}` : "", "left straight away · lower is better"], "bounce"),
      kpi("Organic key events", "conversions", fmtInt, {}, "GA4"),
      kpi("AI assistant visits", "aiSessions", fmtInt, {}, "ChatGPT, Perplexity…"),
    ].join("");

    // The chart: days, weeks or months across the chosen dates, and the comparison lined up underneath
    let gran = ui.gran === "auto" ? autoGran(r.n) : ui.gran;
    if ((gran === "day" && r.n > 120) || (gran === "month" && r.n < 45)) gran = autoGran(r.n);
    const hasPI = data.pages.some((p) => Array.isArray(p.dailyIArr) && p.dailyIArr.length);
    const mk = METRICS[ui.metric] && (!METRICS[ui.metric].brand || hasBrand) ? ui.metric : "clicks";
    const wantPages = ui.tshow === "pages" && ui.tpages.length > 0;
    const siteOnly = wantPages && !PAGE_METRICS.includes(mk);   // e.g. Organic sessions: only recorded for the whole site
    const pageMode = wantPages && !siteOnly;
    const pageWaiting = pageMode && mk !== "clicks" && !hasPI;   // page impressions and position not saved yet
    const m = METRICS[mk];
    const bks = buckets(r.from, r.to, gran);
    const off = prev ? daysBetween(cmp.from, r.from) : 0;
    let points, cpts = null, multi = null, lineColor = "", lineName = "", pageLegend = "", trendMarks = logMarks(work);
    if (!pageMode) {
      points = bks.map((b) => ({ ...b, label: bucketLabel(b, gran), v: sumRange(days, b.start, b.end)[mk] }));
      cpts = prev ? bks.map((b) => {
        const s = addDays(b.start, -off), e = addDays(b.end, -off);
        return { label: bucketLabel({ start: s, end: e }, gran), v: sumRange(days, s, e)[mk] };
      }) : null;
    } else {
      const groups = ui.tpages.map((path, i) => ({ path, color: TCOLORS[i % TCOLORS.length], title: titleOf(work, data, path),
        pages: data.pages.filter((p) => tkey(p.path) === tkey(path)) }));
      const keys = new Set(ui.tpages.map(tkey));
      trendMarks = (work?.log || []).filter((e) => e.date && keys.has(tkey(e.url || ""))).map((e) => ({ date: e.date, title: e.title || "Change" }));
      if (ui.tmode === "sum") {
        const all = groups.flatMap((g) => g.pages);
        lineColor = "#7c3aed";
        lineName = `${groups.length} page${groups.length === 1 ? "" : "s"} combined`;
        points = bks.map((b) => ({ ...b, label: bucketLabel(b, gran), v: pageVal(all, b.start, b.end, mk) }));
        cpts = prev ? bks.map((b) => {
          const s = addDays(b.start, -off), e = addDays(b.end, -off);
          return { label: bucketLabel({ start: s, end: e }, gran), v: pageVal(all, s, e, mk) };
        }) : null;
        pageLegend = `<div class="seo-legend"><span style="border-top-color:${lineColor}"></span>${esc(lineName)}: ${esc(fmtDate(r.from, false))} – ${esc(fmtDate(r.to))}
          ${cpts ? `<span class="is-cmp"></span>${esc(cmp.name)}: ${esc(fmtDate(cmp.from, false))} – ${esc(fmtDate(cmp.to))}` : ""}</div>`;
      } else {
        const ser = groups.map((g) => ({ label: shortT(g.title), color: g.color, pts: bks.map((b) => ({ v: pageVal(g.pages, b.start, b.end, mk) })) }));
        lineColor = ser[0].color;
        lineName = ser[0].label;
        points = bks.map((b, i) => ({ ...b, label: bucketLabel(b, gran), v: ser[0].pts[i].v }));
        multi = ser.slice(1);
        pageLegend = `<div class="seo-legend">${ser.map((s) => `<span style="border-top-color:${s.color}"></span>${esc(s.label)}`).join("")}</div>`;
      }
    }

    // The page picker (Trend card, Pages)
    tpActive = 0;
    const tClusters = (Array.isArray(work?.settings?.clusters) ? work.settings.clusters : []).filter((x) => x && x.main);
    const tTopics = (Array.isArray(work?.settings?.topics) ? work.settings.topics : []).filter((x) => x && Array.isArray(x.pages) && x.pages.length);
    const pickerHtml = ui.tshow !== "pages" ? "" : `<div class="seo-tp">
      <div class="seo-tp-chips">
        ${ui.tpages.map((p, i) => `<span class="seo-tp-chip"><i style="background:${TCOLORS[i % TCOLORS.length]}"></i>${esc(shortT(titleOf(work, data, p)))}
          <button type="button" data-tprm="${esc(p)}" aria-label="Remove ${esc(titleOf(work, data, p))}">×</button></span>`).join("")}
        ${ui.tpages.length < TMAX ? `<div class="seo-tp-combo">
            <input class="seo-input seo-tp-add" data-tpq placeholder="+ Add a page: type its name" autocomplete="off" spellcheck="false"
              role="combobox" aria-autocomplete="list" aria-controls="seo-tp-res" aria-label="Add a page to the chart">
            <div class="seo-tp-res" id="seo-tp-res" role="listbox" data-tpres>${tpResults("")}</div>
          </div>` : `<span class="seo-note">Up to ${TMAX} pages. Remove one to add another.</span>`}
      </div>
      <div class="seo-row" style="margin:8px 0 0">
        <span class="seo-note">Quick picks:</span>
        <button class="seo-btn" type="button" data-tquick="pri">★ Top 5 priority pages</button>
        ${tClusters.length ? `<select class="seo-input seo-select" data-tcluster aria-label="Pick a cluster"><option value="">A cluster…</option>
          ${tClusters.map((x, i) => `<option value="${i}">${esc(x.name || titleOf(work, data, x.main))}</option>`).join("")}</select>` : ""}
        ${tTopics.length ? `<select class="seo-input seo-select" data-ttopic aria-label="Pick a topic"><option value="">A topic…</option>
          ${tTopics.map((x, i) => `<option value="${i}">${esc(x.name || "Topic")}</option>`).join("")}</select>` : ""}
        ${ui.tpages.length ? `<button class="seo-btn" type="button" data-tclear>Clear</button>` : ""}
        <span class="seo-sp"></span>
        <span class="seo-seg">
          <button type="button" class="${ui.tmode === "sep" ? "on" : ""}" data-tmode="sep">Separate lines</button>
          <button type="button" class="${ui.tmode === "sum" ? "on" : ""}" data-tmode="sum">Combined</button></span>
      </div>
      ${!ui.tpages.length ? `<p class="seo-note" style="margin:6px 0 0">Choose up to ${TMAX} pages to compare.</p>` : ""}
      ${!hasPI ? `<p class="seo-note" style="margin:6px 0 0">Impressions, CTR and Position for pages appear after the next nightly update. Clicks work now.</p>` : ""}
    </div>`;

    const fresh = r.to > ov.periodEnd ? daysBetween(ov.periodEnd, r.to) : 0;
    const rangeText = `${fmtDate(r.from)} – ${fmtDate(r.to)} · ${r.n} day${r.n === 1 ? "" : "s"}` +
      (cmp ? (cmp.ok ? ` · vs ${fmtDate(cmp.from)} – ${fmtDate(cmp.to)}` : ` · no comparison: search data starts ${fmtDate(first)}`) : "");

    // Pages gaining and losing clicks over the chosen dates, from each page's daily clicks.
    // Until the nightly job has added those, the last 28 days vs the 28 before.
    const hasDaily = pages.some((p) => Array.isArray(p.dailyArr));
    const clicksIn = (p, a, b) => {
      if (!Array.isArray(p.dailyArr) || !p.dailyFrom) return null;
      const i0 = Math.max(0, daysBetween(p.dailyFrom, a)), i1 = Math.min(p.dailyArr.length - 1, daysBetween(p.dailyFrom, b));
      let s = 0;
      for (let i = i0; i <= i1; i++) s += p.dailyArr[i] || 0;
      return s;
    };
    const keyOf = (p) => String(p.path || "").split("?")[0].replace(/\/+$/, "").toLowerCase() || "/";
    const byKey = new Map();   // the same page with and without the end slash counts as one
    for (const p of pages) {
      const now = hasDaily ? clicksIn(p, r.from, r.to) : p.m28.clicks;
      const was = hasDaily ? (prev ? clicksIn(p, cmp.from, cmp.to) : null) : p.prev28.clicks;
      if (now == null) continue;
      const k = keyOf(p);
      const x = byKey.get(k);
      if (!x) { byKey.set(k, { p, now, was, imp: p.m28.impressions || 0 }); continue; }
      x.now += now;
      if (was != null) x.was = (x.was || 0) + was;
      if ((p.m28.impressions || 0) > x.imp) { x.p = p; x.imp = p.m28.impressions || 0; }
    }
    const moved = [...byKey.values()].filter((m) => m.now + (m.was || 0) >= 5);
    const showCmp = hasDaily ? !!prev : true;
    const winners = showCmp ? moved.filter((m) => m.was != null && m.now > m.was).sort((a, b) => (b.now - b.was) - (a.now - a.was)).slice(0, 8) : [];
    const losers = showCmp ? moved.filter((m) => m.was != null && m.now < m.was).sort((a, b) => (a.now - a.was) - (b.now - b.was)).slice(0, 8) : [];
    const top = showCmp ? [] : moved.slice().sort((a, b) => b.now - a.now).slice(0, 8);
    const cx = ctx();
    const list = (arr) => arr.length
      ? `<ul class="seo-list seo-movers">${arr.map((m) => `
          <li data-open="${m.p.id}"><span class="seo-path" title="${esc(m.p.url)}">${starHtml(cx, m.p.path)}${esc(titleOf(work, data, m.p.path))}
            <small>${esc(m.p.path)}</small></span>
          <span class="seo-mv-n">${fmtInt(m.now)} ${m.was != null ? delta(m.now, m.was) : ""}</span></li>`).join("")}</ul>`
      : `<div class="seo-note">Nothing notable for these dates.</div>`;
    const moveRange = !hasDaily ? "last 28 days vs the 28 before"
      : `${fmtDate(r.from, false)} – ${fmtDate(r.to)}${prev ? ` vs ${fmtDate(cmp.from, false)} – ${fmtDate(cmp.to)}` : ""}`;

    // "What changed": a few plain sentences about what moved, worked out from the numbers on this page
    const changedHtml = (() => {
      if (!prev) return "";
      const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
      const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtInt(Math.abs(n));
      const shortT = (s) => (s.length > 40 ? s.slice(0, 39) + "…" : s);
      const lines = [];

      // 1. Clicks, and the pages behind the change (only when the page lists match these dates)
      const dc = cur.clicks - prev.clicks, pc = pct(cur.clicks, prev.clicks);
      const dir = dc > 0 ? "up" : dc < 0 ? "down" : "flat";
      const driversOk = hasDaily || (ui.preset === "28" && ui.compare === "prev");
      const drivers = driversOk && dir !== "flat" ? (dc > 0 ? winners : losers).slice(0, 2) : [];
      const name = (m) => `<button class="seo-w-link" type="button" data-open="${esc(m.p.id)}">${esc(shortT(titleOf(work, data, m.p.path)))}</button> (${signed(m.now - m.was)})`;
      lines.push([dir, `Clicks ${dir === "flat" ? "held steady" : `${dir} ${Math.abs(pc ?? 0)}%`} (${fmtInt(cur.clicks)} vs ${fmtInt(prev.clicks)})${
        drivers.length ? `, mostly ${drivers.map(name).join(" and ")}` : ""}.`]);

      // 2. Brand searches (people who already know the clinic) or treatment searches (SEO)
      if (hasBrand && prev.nonBrand != null && dc !== 0) {
        const db = cur.brandClicks - prev.brandClicks, dn = cur.nonBrand - prev.nonBrand;
        const tot = Math.abs(db) + Math.abs(dn);
        if (tot >= 5) {
          const share = Math.abs(db) / tot;
          if (share >= 0.6) lines.push([db >= 0 ? "up" : "down", `Most of that is brand searches, people looking for the clinic by name (${signed(db)}). Treatment searches: ${signed(dn)}.`]);
          else if (share <= 0.4) lines.push([dn >= 0 ? "up" : "down", `Most of that is treatment searches (${signed(dn)}), so it's coming from SEO rather than people who already know the clinic. Brand searches: ${signed(db)}.`]);
        }
      }

      // 3. Seen more or less often, and whether people clicked
      const pi = pct(cur.impressions, prev.impressions);
      if (pi != null && Math.abs(pi) >= 15) {
        const ctrDown = cur.ctr < prev.ctr * 0.85, ctrUp = cur.ctr > prev.ctr * 1.15;
        lines.push([pi > 0 ? "up" : "down", `Seen ${pi > 0 ? "more" : "less"} often in Google (impressions ${pi > 0 ? "+" : "−"}${Math.abs(pi)}%)${
          ctrDown ? `, but a smaller share clicked (CTR ${fmtPct(prev.ctr)} → ${fmtPct(cur.ctr)}). That usually means showing for new searches where the site ranks lower.`
          : ctrUp ? `, and a bigger share clicked (CTR ${fmtPct(prev.ctr)} → ${fmtPct(cur.ctr)}).` : "."}`]);
      }

      // 4. Average position, when it moved a full place or more
      if (cur.position != null && prev.position != null && Math.abs(cur.position - prev.position) >= 1) {
        const better = cur.position < prev.position;
        lines.push([better ? "up" : "down", `Average position ${better ? "improved" : "slipped"} from ${fmtPos(prev.position)} to ${fmtPos(cur.position)}.`]);
      }

      // 5. Bookings and enquiries from Google visitors (GA4 key events)
      const pk = pct(cur.conversions, prev.conversions);
      if (pk != null && Math.abs(pk) >= 25 && Math.abs(cur.conversions - prev.conversions) >= 5) {
        lines.push([pk > 0 ? "up" : "down", `Key events from Google visitors (bookings and enquiries tracked in GA4) ${pk > 0 ? "rose" : "fell"} ${Math.abs(pk)}%: ${fmtInt(cur.conversions)} vs ${fmtInt(prev.conversions)}.`]);
      }

      // 6. Changes logged in these dates (including tasks the website check finished)
      const logged = (work?.log || []).filter((e) => e.date >= r.from && e.date <= r.to);
      if (logged.length) {
        const tasks = logged.filter((e) => e.taskId).length;
        lines.push(["note", `${logged.length} change${logged.length === 1 ? "" : "s"} logged in these dates${
          tasks ? `, including ${tasks} task${tasks === 1 ? "" : "s"} confirmed on the website` : ""}. <button class="seo-w-link" type="button" data-tab="log">See the Change log</button>`]);
      }

      return `<div class="seo-card seo-wc">
        <div class="seo-row" style="margin:0 0 4px"><h3 style="margin:0">What changed</h3>
          <span class="seo-note">${esc(fmtDate(r.from, false))} – ${esc(fmtDate(r.to))} vs ${esc(cmp.name.toLowerCase())}</span></div>
        <ul class="seo-wc-list">${lines.slice(0, 6).map(([d, t]) => `<li class="is-${d}">${t}</li>`).join("")}</ul>
        ${fresh ? `<p class="seo-note" style="margin:6px 0 0">The last ${fresh} day${fresh === 1 ? "" : "s"} may still change while Search Console settles.</p>` : ""}
      </div>`;
    })();

    return `
      <div class="seo-row seo-range">
        ${PRESETS.map(([k, l]) => `<button class="seo-btn ${ui.preset === k ? "on" : ""}" data-preset="${k}">${l}</button>`).join("")}
      </div>
      <div class="seo-row seo-range">
        ${ui.preset === "custom" ? `
          <label class="seo-note">From <input type="date" class="seo-input seo-date" data-from min="${first}" max="${last}" value="${r.from}"></label>
          <label class="seo-note">To <input type="date" class="seo-input seo-date" data-to min="${first}" max="${last}" value="${r.to}"></label>` : ""}
        <label class="seo-note">Compare to
          <select class="seo-input seo-select" data-compare>
            ${[["prev", "Previous period"], ["year", "Same time last year"], ["none", "No comparison"]].map(([k, l]) =>
              `<option value="${k}"${ui.compare === k ? " selected" : ""}>${l}</option>`).join("")}
          </select></label>
        <span class="seo-note">${esc(rangeText)}</span>
      </div>
      ${fresh ? `<p class="seo-note" style="margin:-4px 0 12px">The last ${fresh} day${fresh === 1 ? "" : "s"} may still change: Search Console takes about 3 days to settle. They're shaded on the chart.</p>` : ""}
      <div class="seo-kpis">${kpis}</div>
      ${ui.kpi === "bounce" ? bounceHtml(cur, prev, cmp) : ui.kpi && LABELS[ui.kpi] ? (W
        ? drillHtml(ctx(), { key: ui.kpi, label: LABELS[ui.kpi], r, cmp: cmp && cmp.ok ? cmp : null, compareMode: ui.compare,
            preset: ui.preset, W, tab: ui.drtab, cur, prev, open: ui.drOpen })
        : (loadWindows(wForce).then((x) => { W = x; wForce = false; if (tab === "overview") render(); })
            .catch((e) => { console.warn("Drill-downs not loaded:", e); W = {}; if (tab === "overview") render(); }),
          `<div class="seo-card seo-empty">Loading…</div>`)) : ""}
      ${changedHtml}
      ${priorityCardHtml(ctx(), prc)}
      <div class="seo-card">
        <div class="seo-row">
          <h3 style="margin:0" data-trend>Trend</h3>
          <span class="seo-seg">
            <button type="button" class="${ui.tshow !== "pages" ? "on" : ""}" data-tshow="site">Whole site</button>
            <button type="button" class="${ui.tshow === "pages" ? "on" : ""}" data-tshow="pages">Pages</button></span>
          ${[["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"]].map(([k, l]) => {
            const off2 = (k === "day" && r.n > 120) || (k === "month" && r.n < 45);
            return `<button class="seo-btn ${gran === k ? "on" : ""}" data-gran="${k}"${off2
              ? ` disabled title="${k === "day" ? "Choose 120 days or fewer" : "Choose at least 45 days"}"` : ""}>${l}</button>`;
          }).join("")}
          <button type="button" class="seo-btn ${ui.tnum ? "on" : ""}" data-tnum aria-pressed="${ui.tnum}" title="Show the numbers on the chart">123 Numbers</button>
          <span class="seo-sp"></span>
          ${Object.entries(METRICS).filter(([, v]) => !v.brand || hasBrand).map(([k, v]) => {
            const tip = ui.tshow === "pages" && !PAGE_METRICS.includes(k) ? ` title="Shown for the whole site: not recorded for single pages"` : "";
            return `<button class="seo-btn ${mk === k ? "on" : ""}" data-metric="${k}"${tip}>${v.label}</button>`;
          }).join("")}
        </div>
        ${pickerHtml}
        ${siteOnly ? `<div class="seo-tp-msg">${esc(m.label)} isn't recorded for single pages, so this shows <b>the whole site</b>.
          Choose Clicks, Impressions, CTR or Avg position to compare your pages.</div>` : ""}
        <div class="seo-chart">${pageWaiting
          ? `<div class="seo-tp-nochart"><b>${esc(m.label)} for single pages isn't saved yet.</b><br>
              The nightly update adds it. To see it now, run <code>runSeoNightly</code> once in Apps Script, then press Refresh.</div>`
          : pageMode && !points.concat(...(multi || []).map((s) => s.pts)).some((p) => p.v)
            ? `<div class="seo-tp-nochart"><b>No ${esc(m.label.toLowerCase())} from Google for ${ui.tpages.length === 1 ? "this page" : "these pages"} in these dates.</b><br>
                Google may not be showing ${ui.tpages.length === 1 ? "it" : "them"} yet. Try a longer date range.</div>`
            : lineChart(points, { ...m, marks: trendMarks, cmp: cpts, freshAfter: ov.periodEnd, gran, multi, color: lineColor, name: lineName, labels: ui.tnum })}</div>
        ${pageMode ? pageLegend : cpts ? `<div class="seo-legend"><span></span>${esc(fmtDate(r.from, false))} – ${esc(fmtDate(r.to))}
          <span class="is-cmp"></span>${esc(cmp.name)}: ${esc(fmtDate(cmp.from, false))} – ${esc(fmtDate(cmp.to))}</div>` : ""}
        ${pageMode && ui.tmode === "sep" && prev ? `<div class="seo-note">Choose Combined to compare these pages with ${esc(cmp.name.toLowerCase())}.</div>` : ""}
        ${wantPages && ui.tpages.length === 2 ? compareHtml(ctx(), { a: ui.tpages[0], b: ui.tpages[1], r, colors: TCOLORS, pageVal, hasPI }) : ""}
        ${wantPages && ui.tpages.length > 2 ? `<p class="seo-note" style="margin-top:8px">Choose exactly 2 pages to see them head to head.</p>` : ""}
        ${work?.log?.length ? `<div class="seo-note">Orange dotted lines are changes from the Change log. Hover the dot to see them.</div>` : ""}
        ${m.invert ? `<div class="seo-note">Position axis is flipped: up means ranking higher.</div>` : ""}
        ${hasBrand ? `<div class="seo-note">Brand = searches with your brand words (SEO → Settings). Non-brand includes rare searches Google hides.</div>` : ""}
      </div>
      ${showCmp ? `<div class="seo-grid2">
        <div class="seo-card"><h3>Gaining clicks <small class="seo-note">${esc(moveRange)}</small></h3>${list(winners)}</div>
        <div class="seo-card"><h3>Losing clicks <small class="seo-note">${esc(moveRange)}</small></h3>${list(losers)}</div>
      </div>` : `<div class="seo-card"><h3>Pages with the most clicks <small class="seo-note">${esc(moveRange)}</small></h3>${list(top)}</div>`}
      ${hasDaily ? "" : `<p class="seo-note">These lists use the last 28 days until the nightly update adds each page's daily clicks.</p>`}`;
  }


  /* ----- Pages ----- */

  const COLS = [
    { key: "path",        label: "Page",         get: (p) => p.path },
    { key: "clicks",      label: "Clicks",       get: (p) => p.m28.clicks },
    { key: "dClicks",     label: "vs prev",      get: (p) => p.dClicks },
    { key: "impressions", label: "Impressions",  get: (p) => p.m28.impressions },
    { key: "ctr",         label: "CTR",          get: (p) => p.m28.ctr },
    { key: "position",    label: "Position",     get: (p) => p.m28.position, nullsLast: true, asc: true },
    { key: "dPos",        label: "Moved",        get: (p) => p.dPos },
    { key: "sessions",    label: "Org. sessions", get: (p) => p.m28.sessions },
    { key: "conversions", label: "Key events",   get: (p) => p.m28.conversions },
    { key: "bounce",      label: "Bounce",       get: (p) => pageBounce(p), nullsLast: true },
    { key: "engTime",     label: "Engaged time", get: (p) => pageTime(p), nullsLast: true },
    { key: "weekly",      label: "12 weeks",     get: null },
  ];

  function pagesShellHtml() {
    return `
      <div class="seo-row">
        <button class="seo-btn on" type="button" data-pview="table">All pages</button>
        <button class="seo-btn" type="button" data-pview="clusters">Clusters</button>
        <input class="seo-input" data-filter placeholder="Filter pages, e.g. pigmentation" value="${esc(ui.filter)}">
        <label class="seo-check"><input type="checkbox" data-hidezero ${ui.hideZero ? "checked" : ""}> Hide pages with no activity</label>
        <label class="seo-check"><input type="checkbox" data-prionly ${ui.priOnly ? "checked" : ""}> ★ Priority pages only</label>
        <span class="seo-sp"></span><span class="seo-note" data-count></span>
      </div>
      <div class="seo-table-wrap" data-table></div>
      <div class="seo-note" style="margin-top:8px">Last 28 complete days of search data vs the 28 before. Organic sessions and key events from GA4.
        Bounce: visits from Google that left straight away (green up to 45%, red over 65%). Engaged time: per visit.</div>`;
  }

  function renderTable() {
    const f = ui.filter.trim().toLowerCase();
    let rows = data.pages.filter((p) =>
      (!f || p.url.toLowerCase().includes(f)) && (!ui.priOnly || isPriorityPath(work, p.path)) &&
      (!ui.hideZero || p.m28.clicks || p.m28.impressions || p.m28.sessions));

    const col = COLS.find((c) => c.key === ui.sortKey) || COLS[1];
    rows.sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;           // empty values always last
      if (vb == null) return -1;
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * ui.sortDir;
    });

    const total = rows.length;
    rows = rows.slice(0, ui.limit);
    const cx = ctx();
    $("[data-count]").textContent = `${fmtInt(total)} pages`;

    $("[data-table]").innerHTML = `
      <table class="seo-table">
        <thead><tr>${COLS.map((c) => `<th data-sort="${c.get ? c.key : ""}" class="${ui.sortKey === c.key ? "on" : ""}">${c.label}${ui.sortKey === c.key ? (ui.sortDir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((p) => `
          <tr data-open="${p.id}">
            <td><div class="seo-path" title="${esc(p.url)}">${starHtml(cx, p.path)}${esc(p.path)}</div></td>
            <td>${fmtInt(p.m28.clicks)}</td>
            <td>${delta(p.m28.clicks, p.prev28.clicks)}</td>
            <td>${fmtInt(p.m28.impressions)}</td>
            <td>${fmtPct(p.m28.ctr)}</td>
            <td>${fmtPos(p.m28.position)}</td>
            <td>${delta(p.m28.position, p.prev28.position, { invert: true, abs: true })}</td>
            <td>${fmtInt(p.m28.sessions)}</td>
            <td>${fmtInt(p.m28.conversions)}</td>
            <td>${bChip(pageBounce(p), p.eng ? p.eng.c[0] : p.m28.sessions)}</td>
            <td>${fmtDur(pageTime(p))}</td>
            <td>${sparkline(p.weekly)}</td>
          </tr>`).join("")}</tbody>
      </table>
      ${total > ui.limit ? `<div style="padding:10px;text-align:center"><button class="seo-btn" data-more>Show all ${fmtInt(total)}</button></div>` : ""}
      ${!total ? `<div class="seo-empty">No pages match.</div>` : ""}`;
  }

  /* ----- Page panel ----- */

  function openPanel(id) {
    const p = data.pages.find((x) => x.id === id);
    if (!p) return;
    panelId = id;
    if (prEdit && prEdit !== p.path) prEdit = null;
    const end = data.ov.periodEnd;
    const weekLabels = p.weekly.map((_, i) => "Week to " + fmtDate(addDays(end, -7 * (11 - i)), false));
    const row = (label, cur, prev, fmt, opts) =>
      `<tr><td>${label}</td><td>${fmt(cur)}</td><td>${prev == null ? "—" : fmt(prev)}</td><td>${prev == null ? "" : delta(cur, prev, opts)}</td></tr>`;

    panel.innerHTML = `
      <button class="seo-btn x" data-close>Close</button>
      <h2>${esc(titleOf(work, data, p.path))}</h2>
      <div class="seo-note" style="word-break:break-all;margin-bottom:2px">${esc(p.path)}</div>
      <a href="${esc(p.url)}" target="_blank" rel="noopener" class="seo-note">Open page ↗</a>
      <button class="seo-btn" type="button" data-advpage="${esc(p.path)}" style="margin-left:8px">Ask the Advisor about this page</button>
      <button class="seo-btn" type="button" data-wsedit="${esc(p.path)}" style="margin-left:8px">Edit title and description</button>
      ${panelPriorityHtml({ ...ctx(), h: { esc, fmtInt, fmtPos, idOf: (path) => data.pages.find((x) => x.path === path)?.id || "" } }, p, prEdit === p.path)}
      <table class="seo-kv">
        <tr><th></th><th>Last 28d</th><th>Prev 28d</th><th></th></tr>
        ${row("Clicks", p.m28.clicks, p.prev28.clicks, fmtInt)}
        ${row("Impressions", p.m28.impressions, p.prev28.impressions, fmtInt)}
        ${row("CTR", p.m28.ctr, p.prev28.ctr, fmtPct)}
        ${row("Avg position", p.m28.position, p.prev28.position, fmtPos, { invert: true, abs: true })}
        ${row("Organic sessions", p.m28.sessions, null, fmtInt)}
        ${row("Engaged sessions", p.m28.engaged, null, fmtInt)}
        ${row("Key events", p.m28.conversions, null, fmtInt)}
      </table>
      ${(() => {
        const b = pageBounce(p);
        if (b == null) return "";
        const e = p.eng;
        const was = e && e.p[0] >= 20 ? bRate(e.p) : null;
        const mob = e && e.m[0] >= 10 ? bRate(e.m) : null, desk = e && e.d[0] >= 10 ? bRate(e.d) : null;
        const tip = b <= 0.65 ? "" : mob != null && desk != null && mob - desk >= 0.1
          ? "Visitors on phones leave much more often: check how the top of the page looks and loads on a phone."
          : "Most Google visitors leave straight away: make sure the first screen answers what they searched for, with a clear next step.";
        return `<div class="seo-bn-panel"><div class="seo-row" style="margin:0"><strong>Bounce rate</strong>${bChip(b, e ? e.c[0] : p.m28.sessions)}
            ${was != null ? `${delta(b * 100, was * 100, { invert: true, abs: true, digits: 0 })}<span class="seo-note">points vs the 28 days before</span>` : ""}</div>
          <p class="seo-note" style="margin:4px 0 0">${[e && e.c[0] ? `Engaged time ${fmtDur(e.c[2] / e.c[0])} a visit` : "",
            mob != null ? `Mobile ${fmtB(mob)}` : "", desk != null ? `Desktop ${fmtB(desk)}` : ""].filter(Boolean).join(" · ")}</p>
          ${tip ? `<p class="seo-bn-tip">💡 ${esc(tip)}</p>` : ""}</div>`;
      })()}
      <h3 style="font-size:14px;margin:16px 0 6px">Clicks per week</h3>
      ${bars(p.weekly, weekLabels)}
      ${pagePanelExtras(work, p, { esc, fmtInt, fmtPos, fmtDate, delta,
        idOf: (path) => {
          const n = (s) => String(s || "").split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase() || "/";
          const hit = data.pages.find((x) => x.path === path) || data.pages.find((x) => n(x.path) === n(path));
          return hit ? hit.id : "";
        } }, can)}`;
    panel.hidden = false;
    panel.scrollTop = 0;
  }

  /* ----- events (delegated) ----- */

  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-wsfix],[data-wsedit],[data-tnum],[data-cmp2],[data-cmpcl],[data-tpick],[data-tshow],[data-tprm],[data-tquick],[data-tclear],[data-tmode],[data-drx],[data-kpi],[data-drtab],[data-drclose],[data-kq],[data-drask],[data-advpage],[data-prtoggle],[data-prf],[data-prall],[data-pview],[data-star],[data-pedit],[data-pcancel],[data-psave],[data-tab],[data-preset],[data-gran],[data-metric],[data-sort],[data-open],[data-close],[data-more],[data-reload],[data-logpage],[data-copyplan]");
    if (!t || !root.contains(t)) return;
    const ds = t.dataset;

    // A Fix it button (Site health, Tasks…) → the Website tab, the page open, suggestions being written.
    // data-wsfix = "path|title, desc or both|words to use (or !words to keep out)"
    if (ds.wsfix !== undefined) {
      const [path, what, ...rest] = ds.wsfix.split("|");
      if (!path) return;
      panel.hidden = true;
      tab = "website";
      siteParam = `fix:${["title", "desc", "both"].includes(what) ? what : "both"}:${encodeURIComponent(rest.join("|"))}:${path}`;
      history.replaceState(null, "", "#/seo/website");
      render();
      return;
    }

    // Page panel → the Website tab, with this page open in the editor
    if (ds.wsedit !== undefined) {
      panel.hidden = true;
      tab = "website";
      siteParam = "path:" + ds.wsedit;
      history.replaceState(null, "", "#/seo/website");
      render();
      return;
    }

    // Overview drill-downs
    if (ds.tnum !== undefined) { ui.tnum = !ui.tnum; saveTr(); render(); return; }

    // Head to head: open 2 pages in the Trend card (from Site health duplicates, drill-downs…)
    if (ds.cmp2 !== undefined) {
      const [a, b] = ds.cmp2.split("|");
      if (!a || !b) return;
      ui.tshow = "pages"; ui.tpages = [a, b]; ui.tmode = "sep"; saveTr();
      panel.hidden = true;
      tab = "overview";
      history.replaceState(null, "", "#/seo");
      render();
      root.querySelector("[data-trend]")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // Head to head → Clusters, with the roles filled in (an admin saves it)
    if (ds.cmpcl !== undefined) {
      const [keep, other, role] = ds.cmpcl.split("|");
      const cls = Array.isArray(work?.settings?.clusters) ? work.settings.clusters : [];
      const hit = cls.find((x) => x && x.main && [x.main, ...(x.pages || []).map((p) => p.path)].some((p) => tkey(p) === tkey(keep) || tkey(p) === tkey(other)));
      work.cui = {
        sel: hit ? String(hit.id || "") : "", node: 0, find: "", adding: false,
        draft: hit ? null : { id: "c_" + Date.now().toString(36), name: shortT(titleOf(work, data, keep), 40), main: keep,
          pages: [{ path: other, role: role === "merge" ? "merge" : "sup" }], isNew: true },
      };
      if (hit) prToast(`These pages are already in the “${hit.name || "…"}” cluster, so it's opened.`);
      ui.pview = "clusters";
      tab = "pages";
      history.replaceState(null, "", "#/seo/pages");
      render();
      return;
    }

    // The Trend card: pages
    if (ds.tpick !== undefined) {
      addTPages([ds.tpick]);
      root.querySelector("[data-tpq]")?.focus();   // ready for the next one
      return;
    }
    if (ds.tshow !== undefined) { ui.tshow = ds.tshow; saveTr(); render(); return; }
    if (ds.tprm !== undefined) { ui.tpages = ui.tpages.filter((p) => tkey(p) !== tkey(ds.tprm)); saveTr(); render(); return; }
    if (ds.tclear !== undefined) { ui.tpages = []; saveTr(); render(); return; }
    if (ds.tmode !== undefined) { ui.tmode = ds.tmode === "sum" ? "sum" : "sep"; saveTr(); render(); return; }
    if (ds.tquick === "pri") {
      const pri = Array.isArray(work?.settings?.keyPages) ? work.settings.keyPages : [];
      if (!pri.length) { prToast("There are no priority pages yet.", true); return; }
      ui.tpages = [];
      addTPages(pri.slice(0, 5));
      return;
    }
    if (ds.drx !== undefined) { ui.drOpen = ui.drOpen === ds.drx ? "" : ds.drx; render(); return; }
    if (ds.kpi !== undefined) { ui.kpi = ui.kpi === ds.kpi ? "" : ds.kpi; ui.drtab = ""; ui.drOpen = ""; render(); return; }
    if (ds.drtab !== undefined) { ui.drtab = ds.drtab; ui.drOpen = ""; render(); return; }
    if (ds.drclose !== undefined) { ui.kpi = ""; render(); return; }
    if (ds.kq !== undefined) {   // a search: open it in Keywords
      work.ui = work.ui || { topic: "__all", qsort: "i", qdir: -1, qfilter: "", qlimit: 100, qopen: null, ostatus: "open", otype: "all" };
      Object.assign(work.ui, { topic: "__all", qfilter: ds.kq, qopen: ds.kq, qlimit: 100 });
      tab = "keywords";
      history.replaceState(null, "", "#/seo/keywords");
      render();
      return;
    }
    if (ds.drask !== undefined) {   // ask the Advisor, with the question written
      work.advPrefill = { mode: "question", text: ds.drask };
      tab = "advisor";
      history.replaceState(null, "", "#/seo/advisor");
      render();
      return;
    }
    if (ds.advpage !== undefined) {
      panel.hidden = true;
      if (work) work.advPrefill = { page: ds.advpage, mode: "page" };
      tab = "advisor";
      history.replaceState(null, "", "#/seo/advisor");
      render();
      return;
    }

    // The Overview's Priority pages card
    if (ds.prtoggle !== undefined) { prc.open = !prc.open; savePrc(); render(); return; }
    if (ds.prf !== undefined) { prc.filter = prc.filter === ds.prf ? "" : ds.prf; prc.open = true; prc.all = false; savePrc(); render(); return; }
    if (ds.prall !== undefined) { prc.all = !prc.all; savePrc(); render(); return; }

    // Priority pages (admins only). These come first, because the star sits inside clickable rows.
    if (ds.star !== undefined || ds.pedit !== undefined || ds.pcancel !== undefined || ds.psave !== undefined) {
      if (!isAdmin) return;
      priorityAction(t, ds);
      return;
    }

    if (ds.tab !== undefined) {
      tab = ds.tab;
      // replaceState doesn't fire hashchange, so the router won't remount the page
      history.replaceState(null, "", "#/seo" + (tab === "overview" ? "" : "/" + tab));
      if (data) render(); else setTabs();
    } else if (ds.preset) {
      if (ds.preset === "custom" && data) {   // start Custom from the dates showing now
        const r = currentRange();
        ui.from = r.from; ui.to = r.to;
      }
      ui.preset = ds.preset; saveOv(); render();
    }
    else if (ds.gran) { ui.gran = ds.gran; saveOv(); render(); }
    else if (ds.metric) { ui.metric = ds.metric; saveOv(); render(); }
    else if (ds.sort !== undefined) {
      if (!ds.sort) return; // the sparkline column isn't sortable
      const col = COLS.find((c) => c.key === ds.sort);
      if (ui.sortKey === ds.sort) ui.sortDir *= -1;
      else { ui.sortKey = ds.sort; ui.sortDir = col.asc || col.key === "path" ? 1 : -1; }
      renderTable();
    }
    else if (ds.copyplan !== undefined) {
      const txt = panel.querySelector("[data-plantext]")?.value || "";
      const done = (ok) => {
        t.textContent = ok ? "Copied ✓" : "Couldn't copy";
        setTimeout(() => { if (t.isConnected) t.textContent = "Copy as a brief"; }, 2000);
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(txt).then(() => done(true)).catch(() => done(fallbackCopy(txt)));
      else done(fallbackCopy(txt));
    }
    else if (ds.open) openPanel(ds.open);
    else if (ds.close !== undefined) panel.hidden = true;
    else if (ds.more !== undefined) { ui.limit = Infinity; renderTable(); }
    else if (ds.reload !== undefined) { panel.hidden = true; load(true); }
    else if (ds.logpage !== undefined) {
      panel.hidden = true;
      if (work) work.prefill = { url: ds.logpage };
      tab = "log";
      history.replaceState(null, "", "#/seo/log");
      render();
    }
  });

  // After a priority page changes: redraw the tab, and the panel if it's open
  function afterPriority() {
    if (tab === "pages") renderTable(); else render();
    if (!panel.hidden && panelId) openPanel(panelId);
  }

  async function priorityAction(t, ds) {
    if (ds.pedit !== undefined) { prEdit = ds.pedit; if (panelId) openPanel(panelId); return; }
    if (ds.pcancel !== undefined) { prEdit = null; if (panelId) openPanel(panelId); return; }
    t.disabled = true;
    try {
      if (ds.star !== undefined) {
        const on = await toggleStar(ctx(), ds.star);
        if (on === null) return;
        // Starred from the panel: open the details straight away to check them
        prEdit = on && !panel.hidden ? ds.star : null;
      } else {
        const val = (k) => panel.querySelector(`[data-pf="${k}"]`)?.value || "";
        await savePriorityDetails(ctx(), ds.psave, { target: val("target"), goal: val("goal"), support: val("support"), note: val("note") });
        prEdit = null;
        prToast("Saved");
      }
      afterPriority();
    } catch (err) {
      console.error("Priority page not saved:", err);
      prToast(/permission/i.test(err.message || "") ? "You don't have permission to change priority pages." : (err.message || "Couldn't save. Try again."), true);
    } finally {
      if (t.isConnected) t.disabled = false;
    }
  }

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("[data-compare]")) { ui.compare = t.value; saveOv(); render(); }
    else if (t.matches("[data-tpadd]")) {
      const mm = /—\s*(\/\S*)$/.exec(t.value);
      if (mm) addTPages([mm[1]]);
    }
    else if (t.matches("[data-tcluster]") && t.value !== "") {
      const cl = (work?.settings?.clusters || []).filter((x) => x && x.main)[+t.value];
      if (cl) { ui.tpages = []; addTPages([cl.main, ...(cl.pages || []).map((p) => p.path)]); }
    }
    else if (t.matches("[data-ttopic]") && t.value !== "") {
      const tp = (work?.settings?.topics || []).filter((x) => x && Array.isArray(x.pages) && x.pages.length)[+t.value];
      if (tp) { ui.tpages = []; addTPages(tp.pages); }
    }
    else if (t.matches("[data-from],[data-to]")) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.value)) return;
      ui[t.matches("[data-from]") ? "from" : "to"] = t.value;
      saveOv(); render();
    }
  });

  root.addEventListener("input", (e) => {
    if (e.target.matches("[data-tpq]")) { tpActive = 0; tpRefresh(e.target); }
    else if (e.target.matches("[data-filter]")) { ui.filter = e.target.value; ui.limit = 100; renderTable(); }
    else if (e.target.matches("[data-hidezero]")) { ui.hideZero = e.target.checked; renderTable(); }
    else if (e.target.matches("[data-prionly]")) { ui.priOnly = e.target.checked; renderTable(); }
  });

  // The page search: keep the box focused while a result is clicked (Safari doesn't focus buttons), and the keyboard
  root.addEventListener("mousedown", (e) => { if (e.target.closest("[data-tpick]")) e.preventDefault(); });
  root.addEventListener("keydown", (e) => {
    const input = e.target.closest?.("[data-tpq]");
    if (!input) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!tpLast.length) return;
      tpActive = (tpActive + (e.key === "ArrowDown" ? 1 : -1) + tpLast.length) % tpLast.length;
      tpRefresh(input);
      input.closest(".seo-tp-combo")?.querySelector(".seo-tp-opt.is-on")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = tpLast[tpActive];
      if (pick) { addTPages([pick.path]); root.querySelector("[data-tpq]")?.focus(); }
    } else if (e.key === "Escape") {
      input.value = "";
      input.blur();
    }
  });

  const onKey = (e) => {
    if (!document.body.contains(panel)) { document.removeEventListener("keydown", onKey); return; }
    if (e.key === "Escape") panel.hidden = true;
    // Enter or Space on a drill-down row opens it
    const row = e.target.closest?.("[data-drx]");
    if (row && root.contains(row) && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
  };
  document.addEventListener("keydown", onKey);

  document.addEventListener("click", function outside(e) {
    if (!document.body.contains(panel)) { document.removeEventListener("click", outside); return; }
    // A button that redraws the panel (Edit, Save, Cancel, Unstar) is already gone from the page here: that's still a click inside it
    if (!e.target.isConnected) return;
    if (document.body.classList.contains("seo-dragging")) return;
    if (!panel.hidden && !panel.contains(e.target) && !e.target.closest("[data-open]")) panel.hidden = true;
  });

  setTabs();
  await load(false);
}