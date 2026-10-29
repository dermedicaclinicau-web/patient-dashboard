// seo.js — SEO section, Phase 1: Overview + Pages
// Reads: seo_state/overview, seo_state/run, seo_pages (current build only)

// ⚠️ Make these match recall.js exactly (same Firebase version, same db instance)
import { db } from "./firebase-config.js";
import { doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { loadWork, renderWorkTab, pagePanelExtras, logMarks, makeCan } from "./seo-work.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "pages", label: "Pages" },
  { id: "keywords", label: "Keywords" },
  { id: "opps", label: "Opportunities" },
  { id: "log", label: "Change log" },
  { id: "settings", label: "Settings", manage: true },
];

const METRICS = {
  clicks:      { label: "Clicks",           fmt: (v) => fmtInt(v) },
  impressions: { label: "Impressions",      fmt: (v) => fmtInt(v) },
  ctr:         { label: "CTR",              fmt: (v) => fmtPct(v) },
  position:    { label: "Avg position",     fmt: (v) => fmtPos(v), invert: true },
  sessions:    { label: "Organic sessions", fmt: (v) => fmtInt(v) },
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
function fmtDate(iso, withYear = true) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU",
    { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** Totals over [from, to]; position is impression-weighted */
function sumRange(days, from, to) {
  const t = { clicks: 0, impressions: 0, posW: 0, posI: 0, sessions: 0, engaged: 0, conversions: 0, aiSessions: 0 };
  for (const d of days) {
    if (d.date < from || d.date > to) continue;
    t.clicks += d.clicks; t.impressions += d.impressions;
    if (d.position != null && d.impressions) { t.posW += d.position * d.impressions; t.posI += d.impressions; }
    t.sessions += d.sessions; t.engaged += d.engaged; t.conversions += d.conversions; t.aiSessions += d.aiSessions;
  }
  t.ctr = t.impressions ? t.clicks / t.impressions : 0;
  t.position = t.posI ? t.posW / t.posI : null;
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

/** Weekly line chart. points: [{ label, v }] */
function lineChart(points, { invert = false, fmt = fmtInt, marks = [] } = {}) {
  const W = 820, H = 230, L = 52, R = 12, T = 12, B = 28;
  const w = W - L - R, h = H - T - B;
  const vals = points.map((p) => p.v).filter((v) => v != null);
  if (!vals.length) return `<div class="seo-empty">No data</div>`;
  let min = Math.min(...vals), max = Math.max(...vals);
  if (!invert) min = Math.min(0, min);
  if (max === min) max = min + 1;
  const x = (i) => L + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (v) => T + (invert ? (v - min) / (max - min) : 1 - (v - min) / (max - min)) * h;

  let path = "", pen = false;
  points.forEach((p, i) => {
    if (p.v == null) { pen = false; return; }
    path += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(p.v).toFixed(1);
    pen = true;
  });

  const grid = [0, 1, 2, 3, 4].map((k) => {
    const v = min + ((max - min) * k) / 4;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="seo-grid"/>
      <text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`;
  }).join("");

  let lastMonth = "";
  const xl = points.map((p, i) => {
    const m = p.end.slice(0, 7);
    if (m === lastMonth) return "";
    lastMonth = m;
    if (i === 0) return "";
    const d = new Date(p.end + "T00:00:00Z");
    return `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${d.toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" })}${d.getUTCMonth() === 0 ? " " + String(d.getUTCFullYear()).slice(2) : ""}</text>`;
  }).join("");

  const step = w / Math.max(1, points.length - 1);
  const hits = points.map((p, i) =>
    `<rect x="${(x(i) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${h}" fill="transparent"><title>${esc(p.label)}: ${esc(p.v == null ? "—" : fmt(p.v))}</title></rect>`).join("");

  const byIdx = {};
  for (const mk of marks) {
    const i = points.findIndex((p) => p.end && mk.date <= p.end && mk.date >= addDays(p.end, -6));
    if (i >= 0) (byIdx[i] = byIdx[i] || []).push(mk.title);
  }
  const mks = Object.entries(byIdx).map(([i, titles]) => {
    const xx = x(+i).toFixed(1);
    return `<g class="seo-mark"><line x1="${xx}" x2="${xx}" y1="${T}" y2="${T + h}"/><circle cx="${xx}" cy="${T + 5}" r="5"/><title>${esc(titles.join("\n"))}</title></g>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}">${grid}${xl}<path d="${path}" class="seo-line"/>${hits}${mks}</svg>`;
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
  const tabs = TABS.filter((t) => !t.manage || can("seo.manage"));
  let work = null;
  let tab = tabs.some((t) => t.id === param) ? param : "overview";
  const ui = { range: 28, metric: "clicks", sortKey: "clicks", sortDir: -1, filter: "", hideZero: true, limit: 100 };
  let data = null;

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
      data, work, can, staff: opts.staff,
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
    const end = ov.periodEnd, n = ui.range;
    const cur = sumRange(days, addDays(end, -(n - 1)), end);
    const prev = sumRange(days, addDays(end, -(2 * n - 1)), addDays(end, -n));

    const tile = (label, value, d, note = "") =>
      `<div class="seo-kpi"><div class="l">${label}</div><div class="v">${value}</div>${d}${note ? `<div class="p">${note}</div>` : ""}</div>`;

    const kpis = [
      tile("Clicks", fmtInt(cur.clicks), delta(cur.clicks, prev.clicks)),
      tile("Impressions", fmtInt(cur.impressions), delta(cur.impressions, prev.impressions)),
      tile("CTR", fmtPct(cur.ctr), delta(cur.ctr, prev.ctr)),
      tile("Avg position", fmtPos(cur.position), delta(cur.position, prev.position, { invert: true, abs: true }), "lower is better"),
      tile("Organic sessions", fmtInt(cur.sessions), delta(cur.sessions, prev.sessions), "GA4"),
      tile("Organic key events", fmtInt(cur.conversions), delta(cur.conversions, prev.conversions), "GA4"),
      tile("AI assistant visits", fmtInt(cur.aiSessions), delta(cur.aiSessions, prev.aiSessions), "ChatGPT, Perplexity…"),
    ].join("");

    // Weekly series, full weeks only, ending at periodEnd
    const weeks = [];
    const first = days.length ? days[0].date : end;
    for (let i = 0; i < 70; i++) {
      const e = addDays(end, -7 * i), s = addDays(e, -6);
      if (s < first) break;
      const t = sumRange(days, s, e);
      weeks.unshift({ end: e, label: `Week to ${fmtDate(e)}`, v: t[ui.metric] });
    }
    const m = METRICS[ui.metric];

    const ranked = pages.filter((p) => p.m28.clicks + p.prev28.clicks >= 5);
    const winners = ranked.filter((p) => p.dClicks > 0).sort((a, b) => b.dClicks - a.dClicks).slice(0, 6);
    const losers = ranked.filter((p) => p.dClicks < 0).sort((a, b) => a.dClicks - b.dClicks).slice(0, 6);
    const list = (arr) => arr.length
      ? `<ul class="seo-list">${arr.map((p) => `
          <li data-open="${p.id}"><span class="seo-path" title="${esc(p.url)}">${esc(p.path)}</span>
          <span>${fmtInt(p.m28.clicks)} ${delta(p.m28.clicks, p.prev28.clicks)}</span></li>`).join("")}</ul>`
      : `<div class="seo-note">Nothing notable.</div>`;

    return `
      <div class="seo-row">
        ${[7, 28, 90].map((r) => `<button class="seo-btn ${ui.range === r ? "on" : ""}" data-range="${r}">${r} days</button>`).join("")}
        <span class="seo-note">${fmtDate(addDays(end, -(n - 1)), false)} – ${fmtDate(end)} vs the ${n} days before</span>
      </div>
      <div class="seo-kpis">${kpis}</div>
      <div class="seo-card">
        <div class="seo-row">
          <h3 style="margin:0">Weekly trend</h3><span class="seo-sp"></span>
          ${Object.entries(METRICS).map(([k, v]) => `<button class="seo-btn ${ui.metric === k ? "on" : ""}" data-metric="${k}">${v.label}</button>`).join("")}
        </div>
        <div class="seo-chart">${lineChart(weeks, { ...m, marks: logMarks(work) })}</div>
        ${work?.log?.length ? `<div class="seo-note">Orange dotted lines are changes from the Change log. Hover the dot to see them.</div>` : ""}
        ${m.invert ? `<div class="seo-note">Position axis is flipped: up means ranking higher.</div>` : ""}
      </div>
      <div class="seo-grid2">
        <div class="seo-card"><h3>Gaining clicks (28 days vs previous 28)</h3>${list(winners)}</div>
        <div class="seo-card"><h3>Losing clicks (28 days vs previous 28)</h3>${list(losers)}</div>
      </div>`;
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
        <span class="seo-sp"></span><span class="seo-note" data-count></span>
      </div>
      <div class="seo-table-wrap" data-table></div>
      <div class="seo-note" style="margin-top:8px">Last 28 complete days of search data vs the 28 before. Organic sessions and key events from GA4.</div>`;
  }

  function renderTable() {
    const f = ui.filter.trim().toLowerCase();
    let rows = data.pages.filter((p) =>
      (!f || p.url.toLowerCase().includes(f)) &&
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
    $("[data-count]").textContent = `${fmtInt(total)} pages`;

    $("[data-table]").innerHTML = `
      <table class="seo-table">
        <thead><tr>${COLS.map((c) => `<th data-sort="${c.get ? c.key : ""}" class="${ui.sortKey === c.key ? "on" : ""}">${c.label}${ui.sortKey === c.key ? (ui.sortDir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((p) => `
          <tr data-open="${p.id}">
            <td><div class="seo-path" title="${esc(p.url)}">${esc(p.path)}</div></td>
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
    const end = data.ov.periodEnd;
    const weekLabels = p.weekly.map((_, i) => "Week to " + fmtDate(addDays(end, -7 * (11 - i)), false));
    const row = (label, cur, prev, fmt, opts) =>
      `<tr><td>${label}</td><td>${fmt(cur)}</td><td>${prev == null ? "—" : fmt(prev)}</td><td>${prev == null ? "" : delta(cur, prev, opts)}</td></tr>`;

    panel.innerHTML = `
      <button class="seo-btn x" data-close>Close</button>
      <h2>${esc(p.path)}</h2>
      <a href="${esc(p.url)}" target="_blank" rel="noopener" class="seo-note">Open page ↗</a>
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
      ${pagePanelExtras(work, p, { esc, fmtInt, fmtPos, fmtDate }, can)}`;
    panel.hidden = false;
  }

  /* ----- events (delegated) ----- */

  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab],[data-range],[data-metric],[data-sort],[data-open],[data-close],[data-more],[data-reload],[data-logpage]");
    if (!t || !el.contains(t)) return;
    const ds = t.dataset;

    if (ds.tab !== undefined) {
      tab = ds.tab;
      // replaceState doesn't fire hashchange, so the router won't remount the page
      history.replaceState(null, "", "#/seo" + (tab === "overview" ? "" : "/" + tab));
      if (data) render(); else setTabs();
    } else if (ds.range) { ui.range = +ds.range; render(); }
    else if (ds.metric) { ui.metric = ds.metric; render(); }
    else if (ds.sort !== undefined) {
      if (!ds.sort) return; // the sparkline column isn't sortable
      const col = COLS.find((c) => c.key === ds.sort);
      if (ui.sortKey === ds.sort) ui.sortDir *= -1;
      else { ui.sortKey = ds.sort; ui.sortDir = col.asc || col.key === "path" ? 1 : -1; }
      renderTable();
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

  el.addEventListener("input", (e) => {
    if (e.target.matches("[data-filter]")) { ui.filter = e.target.value; ui.limit = 100; renderTable(); }
    else if (e.target.matches("[data-hidezero]")) { ui.hideZero = e.target.checked; renderTable(); }
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