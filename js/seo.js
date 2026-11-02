// seo.js — SEO section, Phase 1: Overview + Pages
// Reads: seo_state/overview, seo_state/run, seo_pages (current build only)

// ⚠️ Make these match recall.js exactly (same Firebase version, same db instance)
import { db } from "./firebase-config.js";
import { doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { loadWork, renderWorkTab, pagePanelExtras, logMarks, makeCan } from "./seo-work.js?v=5";
import { priorityCardHtml, panelPriorityHtml, starHtml, toggleStar, savePriorityDetails, isPriorityPath, prToast } from "./seo-priority.js?v=1";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "pages", label: "Pages" },
  { id: "keywords", label: "Keywords" },
  { id: "opps", label: "Opportunities" },
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
  nonBrand:    { label: "Non-brand clicks", fmt: (v) => fmtInt(v), brand: true },
};

/* ---------- data (cached for the session; Refresh reloads) ---------- */

const cache = { data: null, pending: null };

async function loadData(force) {
  if (cache.data && !force) return cache.data;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const [ovSnap, runSnap] = await Promise.all([
      getDoc(doc(db, "seo_state", "overview")),
      getDoc(doc(db, "seo_state", "run")),
    ]);
    if (!ovSnap.exists()) throw new Error("No SEO data yet. Run runSeoNightly() in Apps Script.");
    const ov = ovSnap.data();
    const cols = ov.cols;
    const days = JSON.parse(ov.days).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

    const snap = await getDocs(query(collection(db, "seo_pages"), where("build", "==", ov.build)));
    const pages = snap.docs.map((d) => {
      const p = { id: d.id, ...d.data() };
      p.dClicks = p.m28.clicks - p.prev28.clicks;
      // positive = moved up (better)
      p.dPos = p.m28.position != null && p.prev28.position != null ? p.prev28.position - p.m28.position : null;
      return p;
    });

    cache.data = { ov, days, pages, run: runSnap.exists() ? runSnap.data() : null };
    return cache.data;
  })();
  try { return await cache.pending; } finally { cache.pending = null; }
}

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => Math.round(n || 0).toLocaleString("en-AU");
const fmtPct = (r) => ((r || 0) * 100).toFixed(2) + "%";
const fmtPos = (p) => (p == null ? "—" : p.toFixed(1));

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
function lineChart(points, { invert = false, fmt = fmtInt, marks = [], cmp = null, freshAfter = "", gran = "week" } = {}) {
  const W = 820, H = 240, L = 52, R = 12, T = 12, B = 28;
  const w = W - L - R, h = H - T - B;
  const vals = points.concat(cmp || []).map((p) => p.v).filter((v) => v != null);
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

  const dots = n <= 62 ? points.map((p, i) => (p.v == null ? ""
    : `<circle class="seo-dot" cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${n <= 31 ? 2.5 : 1.8}"/>`)).join("") : "";

  const hits = points.map((p, i) => {
    const c = cmp && cmp[i];
    const tip = `${p.label}: ${p.v == null ? "—" : fmt(p.v)}` + (c ? `\n${c.label}: ${c.v == null ? "—" : fmt(c.v)}` : "");
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

  return `<svg viewBox="0 0 ${W} ${H}">${fresh}${grid}${xl}${cmp ? `<path d="${path(cmp)}" class="seo-line-cmp"/>` : ""}<path d="${path(points)}" class="seo-line"/>${dots}${hits}${mks}</svg>`;
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
.seo-chart svg{width:100%;height:auto;display:block}
.seo-chart text,.seo-bars text{font-size:11px;fill:var(--text-muted,#6b7280)}
.seo-grid{stroke:var(--border,#e5e7eb);stroke-width:1}
.seo-line{fill:none;stroke:var(--accent,#2563eb);stroke-width:2}
.seo-line-cmp{fill:none;stroke:#94a3b8;stroke-width:1.5;stroke-dasharray:5 4}
.seo-dot{fill:var(--accent,#2563eb)}
.seo-fresh{fill:#f1f5f9}
.seo-range{gap:6px}
.seo-range label{display:flex;align-items:center;gap:6px}
.seo-date,.seo-select{min-width:0;padding:5px 8px}
.seo-btn:disabled{opacity:.45;cursor:not-allowed}
.seo-legend{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--text-muted,#6b7280);margin-top:6px}
.seo-legend span{display:inline-block;width:22px;height:0;border-top:2px solid var(--accent,#2563eb);margin-left:10px}
.seo-legend span:first-child{margin-left:0}
.seo-legend .is-cmp{border-top:2px dashed #94a3b8}
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
  let tab = tabs.some((t) => t.id === param) ? param : "overview";
  const ui = { preset: "28", from: "", to: "", compare: "prev", gran: "auto", metric: "clicks",
    sortKey: "clicks", sortDir: -1, filter: "", hideZero: true, limit: 100 };
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
      setTab: (id) => { tab = id; history.replaceState(null, "", "#/seo/" + id); render(); },
    };
  }

  function render() {
    setTabs();
    const warn = data.run && data.run.ok === false
      ? `<div class="seo-warn">The last nightly update failed, so these numbers may be out of date: ${esc(data.run.error || "")}</div>` : "";
    if (tab !== "overview" && tab !== "pages") { renderWorkTab(tab, body, ctx()); return; }
    body.innerHTML = warn + (tab === "overview" ? overviewHtml() : pagesShellHtml());
    if (tab === "pages") renderTable();
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

    const tile = (label, value, d, notes) => {
      const ns = notes.filter(Boolean);
      return `<div class="seo-kpi"><div class="l">${label}</div><div class="v">${value}</div>${d || ""}${ns.length ? `<div class="p">${ns.join(" · ")}</div>` : ""}</div>`;
    };
    const kpi = (label, key, f, opts = {}, note = "") => tile(label, f(cur[key]),
      prev ? delta(cur[key], prev[key], opts) : "",
      [prev && prev[key] != null ? `vs ${f(prev[key])}` : "", note]);

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
      kpi("Organic key events", "conversions", fmtInt, {}, "GA4"),
      kpi("AI assistant visits", "aiSessions", fmtInt, {}, "ChatGPT, Perplexity…"),
    ].join("");

    // The chart: days, weeks or months across the chosen dates, and the comparison lined up underneath
    let gran = ui.gran === "auto" ? autoGran(r.n) : ui.gran;
    if ((gran === "day" && r.n > 120) || (gran === "month" && r.n < 45)) gran = autoGran(r.n);
    const mk = METRICS[ui.metric] && (!METRICS[ui.metric].brand || hasBrand) ? ui.metric : "clicks";
    const m = METRICS[mk];
    const bks = buckets(r.from, r.to, gran);
    const off = prev ? daysBetween(cmp.from, r.from) : 0;
    const points = bks.map((b) => ({ ...b, label: bucketLabel(b, gran), v: sumRange(days, b.start, b.end)[mk] }));
    const cpts = prev ? bks.map((b) => {
      const s = addDays(b.start, -off), e = addDays(b.end, -off);
      return { label: bucketLabel({ start: s, end: e }, gran), v: sumRange(days, s, e)[mk] };
    }) : null;

    const fresh = r.to > ov.periodEnd ? daysBetween(ov.periodEnd, r.to) : 0;
    const rangeText = `${fmtDate(r.from)} – ${fmtDate(r.to)} · ${r.n} day${r.n === 1 ? "" : "s"}` +
      (cmp ? (cmp.ok ? ` · vs ${fmtDate(cmp.from)} – ${fmtDate(cmp.to)}` : ` · no comparison: search data starts ${fmtDate(first)}`) : "");

    const ranked = pages.filter((p) => p.m28.clicks + p.prev28.clicks >= 5);
    const winners = ranked.filter((p) => p.dClicks > 0).sort((a, b) => b.dClicks - a.dClicks).slice(0, 6);
    const losers = ranked.filter((p) => p.dClicks < 0).sort((a, b) => a.dClicks - b.dClicks).slice(0, 6);
    const list = (arr) => arr.length
      ? `<ul class="seo-list">${arr.map((p) => `
          <li data-open="${p.id}"><span class="seo-path" title="${esc(p.url)}">${starHtml(ctx(), p.path)}${esc(p.path)}</span>
          <span>${fmtInt(p.m28.clicks)} ${delta(p.m28.clicks, p.prev28.clicks)}</span></li>`).join("")}</ul>`
      : `<div class="seo-note">Nothing notable.</div>`;

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
      ${priorityCardHtml(ctx())}
      <div class="seo-card">
        <div class="seo-row">
          <h3 style="margin:0">Trend</h3>
          ${[["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"]].map(([k, l]) => {
            const off2 = (k === "day" && r.n > 120) || (k === "month" && r.n < 45);
            return `<button class="seo-btn ${gran === k ? "on" : ""}" data-gran="${k}"${off2
              ? ` disabled title="${k === "day" ? "Choose 120 days or fewer" : "Choose at least 45 days"}"` : ""}>${l}</button>`;
          }).join("")}
          <span class="seo-sp"></span>
          ${Object.entries(METRICS).filter(([, v]) => !v.brand || hasBrand)
            .map(([k, v]) => `<button class="seo-btn ${mk === k ? "on" : ""}" data-metric="${k}">${v.label}</button>`).join("")}
        </div>
        <div class="seo-chart">${lineChart(points, { ...m, marks: logMarks(work), cmp: cpts, freshAfter: ov.periodEnd, gran })}</div>
        ${cpts ? `<div class="seo-legend"><span></span>${esc(fmtDate(r.from, false))} – ${esc(fmtDate(r.to))}
          <span class="is-cmp"></span>${esc(cmp.name)}: ${esc(fmtDate(cmp.from, false))} – ${esc(fmtDate(cmp.to))}</div>` : ""}
        ${work?.log?.length ? `<div class="seo-note">Orange dotted lines are changes from the Change log. Hover the dot to see them.</div>` : ""}
        ${m.invert ? `<div class="seo-note">Position axis is flipped: up means ranking higher.</div>` : ""}
        ${hasBrand ? `<div class="seo-note">Brand = searches with your brand words (SEO → Settings). Non-brand includes rare searches Google hides.</div>` : ""}
      </div>
      <div class="seo-grid2">
        <div class="seo-card"><h3>Gaining clicks (28 days vs previous 28)</h3>${list(winners)}</div>
        <div class="seo-card"><h3>Losing clicks (28 days vs previous 28)</h3>${list(losers)}</div>
      </div>
      ${ui.preset !== "28" ? `<p class="seo-note">These two lists always use the last 28 days.</p>` : ""}`;
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
    { key: "weekly",      label: "12 weeks",     get: null },
  ];

  function pagesShellHtml() {
    return `
      <div class="seo-row">
        <input class="seo-input" data-filter placeholder="Filter pages, e.g. pigmentation" value="${esc(ui.filter)}">
        <label class="seo-check"><input type="checkbox" data-hidezero ${ui.hideZero ? "checked" : ""}> Hide pages with no activity</label>
        <label class="seo-check"><input type="checkbox" data-prionly ${ui.priOnly ? "checked" : ""}> ★ Priority pages only</label>
        <span class="seo-sp"></span><span class="seo-note" data-count></span>
      </div>
      <div class="seo-table-wrap" data-table></div>
      <div class="seo-note" style="margin-top:8px">Last 28 complete days of search data vs the 28 before. Organic sessions and key events from GA4.</div>`;
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
      <h2>${esc(p.path)}</h2>
      <a href="${esc(p.url)}" target="_blank" rel="noopener" class="seo-note">Open page ↗</a>
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
    const t = e.target.closest("[data-star],[data-pedit],[data-pcancel],[data-psave],[data-tab],[data-preset],[data-gran],[data-metric],[data-sort],[data-open],[data-close],[data-more],[data-reload],[data-logpage],[data-copyplan]");
    if (!t || !root.contains(t)) return;
    const ds = t.dataset;

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
    else if (t.matches("[data-from],[data-to]")) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.value)) return;
      ui[t.matches("[data-from]") ? "from" : "to"] = t.value;
      saveOv(); render();
    }
  });

  root.addEventListener("input", (e) => {
    if (e.target.matches("[data-filter]")) { ui.filter = e.target.value; ui.limit = 100; renderTable(); }
    else if (e.target.matches("[data-hidezero]")) { ui.hideZero = e.target.checked; renderTable(); }
    else if (e.target.matches("[data-prionly]")) { ui.priOnly = e.target.checked; renderTable(); }
  });

  const onKey = (e) => {
    if (!document.body.contains(panel)) { document.removeEventListener("keydown", onKey); return; }
    if (e.key === "Escape") panel.hidden = true;
  };
  document.addEventListener("keydown", onKey);

  document.addEventListener("click", function outside(e) {
    if (!document.body.contains(panel)) { document.removeEventListener("click", outside); return; }
    if (!panel.hidden && !panel.contains(e.target) && !e.target.closest("[data-open]")) panel.hidden = true;
  });

  setTabs();
  await load(false);
}