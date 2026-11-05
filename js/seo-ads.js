// seo-ads.js — SEO → Ads: Google Ads numbers through GA4
// Reads seo_state/ads and seo_state/ads_run (written each morning by runSeoAds in SeoAds.gs)
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- data (cached for the session; Refresh in SEO clears it) ---------- */

const store = { data: null, pending: null };
export function clearAds() { store.data = null; }

const J = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

async function loadAds() {
  if (store.data) return store.data;
  if (store.pending) return store.pending;
  store.pending = (async () => {
    const [a, run] = await Promise.all([
      getDoc(doc(db, "seo_state", "ads")),
      getDoc(doc(db, "seo_state", "ads_run")).catch(() => null),
    ]);
    const r = run && run.exists() ? run.data() : null;
    if (!a.exists()) return { none: true, run: r, days: [] };
    const x = a.data();
    return {
      run: r, from: x.from, to: x.to, kwFrom: x.kwFrom, kwTo: x.kwTo, lpFrom: x.lpFrom, lpTo: x.lpTo,
      updatedAt: x.updatedAt?.toDate ? x.updatedAt.toDate() : null,
      camps: J(x.camps).map((c) => ({ name: String(c[0] || ""), type: String(c[1] || "") })),
      days: J(x.days).map((d) => ({ date: d[0], c: d[1], cost: d[2], clicks: d[3], impr: d[4], sess: d[5], eng: d[6], ke: d[7] })),
      kw: J(x.kw).map((k) => ({ kw: String(k[0] || ""), c: k[1], cost: k[2], clicks: k[3], impr: k[4], sess: k[5], eng: k[6], ke: k[7], oPos: k[8], oClicks: k[9] || 0 })),
      q: J(x.q).map((k) => ({ q: String(k[0] || ""), sess: k[1], eng: k[2], ke: k[3], oPos: k[4], oClicks: k[5] || 0 })),
      lp: J(x.lp).map((k) => ({ path: String(k[0] || ""), sess: k[1], eng: k[2], ke: k[3], psess: k[4], peng: k[5], pke: k[6] })),
    };
  })();
  try { store.data = await store.pending; return store.data; } finally { store.pending = null; }
}

/* ---------- what's chosen (remembered in this tab) ---------- */

const KEY = "dm.seo.ads";
const ui = (() => {
  const d = { preset: "28", from: "", to: "", compare: "prev", metric: "cost", camp: "",
    sort: "cost", dir: -1, kwSort: "cost", kwDir: -1, kwAll: false, qAll: false };
  try { return { ...d, ...JSON.parse(sessionStorage.getItem(KEY) || "{}") }; } catch { return d; }
})();
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(ui)); } catch { /* private mode */ } };

/* ---------- helpers ---------- */

const money = (v) => (v == null || !isFinite(v) ? "—" : "$" + (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-AU") : v.toFixed(2)));
const num = (v) => Math.round(v || 0).toLocaleString("en-AU");
const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
const pct0 = (v) => (v == null ? "—" : Math.round(v * 100) + "%");
const keF = (v) => (Math.abs((v || 0) - Math.round(v || 0)) < 0.05 ? num(v) : Number(v).toFixed(1));
const kq = (s) => String(s).replace(/[+\[\]"]/g, " ").replace(/\s+/g, " ").trim();

function sum(A, from, to, camp = "") {
  const t = { cost: 0, clicks: 0, impr: 0, sess: 0, eng: 0, ke: 0 };
  const ci = camp === "" ? -1 : Number(camp);
  for (const d of A.days) {
    if (d.date < from || d.date > to || (ci >= 0 && d.c !== ci)) continue;
    t.cost += d.cost; t.clicks += d.clicks; t.impr += d.impr; t.sess += d.sess; t.eng += d.eng; t.ke += d.ke;
  }
  t.cpc = t.clicks ? t.cost / t.clicks : null;
  t.ctr = t.impr ? t.clicks / t.impr : null;
  t.cpke = t.ke ? t.cost / t.ke : null;
  t.bounce = t.sess ? 1 - t.eng / t.sess : null;
  return t;
}

// The change chip. neutral: shown in grey (more spend isn't good or bad on its own)
function chg(h, cur, prev, o = {}) {
  if (cur == null || prev == null) return `<span class="seo-d flat">—</span>`;
  if (o.neutral) {
    if (!prev) return `<span class="seo-d flat">${cur ? "new" : "no change"}</span>`;
    const d = ((cur - prev) / prev) * 100;
    return Math.abs(d) < 0.5 ? `<span class="seo-d flat">no change</span>`
      : `<span class="seo-d flat">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(0)}%</span>`;
  }
  return h.delta(cur, prev, o);
}

function sorter(get, dir) {
  return (a, b) => {
    const va = get(a), vb = get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  };
}

const METRICS = {
  cost: { label: "Spend", fmt: money },
  clicks: { label: "Ad clicks", fmt: num },
  sess: { label: "Visits", fmt: num },
  ke: { label: "Key events", fmt: keF },
  cpke: { label: "Cost per key event", fmt: money },
  cpc: { label: "Cost per click", fmt: money },
};
const ASC = ["name", "kw", "cpc", "cpke", "bounce", "oPos"];   // these sort lowest first

const CSS = `
.seo-ad-ops{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.seo-ad-op{border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:10px 12px;background:#fbfdff}
.seo-ad-op h4{margin:0 0 2px;font-size:14px}
.seo-ad-op.is-red h4{color:#b91c1c}.seo-ad-op.is-green h4{color:#15803d}.seo-ad-op.is-amber h4{color:#b45309}.seo-ad-op.is-blue h4{color:#1d4ed8}
.seo-ad-op ul{list-style:none;margin:6px 0 0;padding:0}
.seo-ad-op li{padding:6px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px;line-height:1.45}
.seo-ad-op li:first-child{border-top:0}
.seo-ad-op li small{display:block;color:var(--text-muted,#6b7280)}
.seo-table tr.is-on{background:rgba(37,99,235,.08)}
.seo-ad-steps{margin:8px 0 0;padding-left:20px;line-height:1.7;font-size:14px}
.seo-ad-link{border:0;background:none;padding:0;color:var(--accent,#2563eb);cursor:pointer;font:inherit;text-align:left}
.seo-ad-link:hover{text-decoration:underline}
`;
function injectCss() {
  if (document.getElementById("seo-ads-css")) return;
  const s = document.createElement("style");
  s.id = "seo-ads-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ---------- the tab ---------- */

let B = null, C = null, AD = null, lastR = null;

export function renderAds(body, ctx) {
  B = body; C = ctx;
  injectCss();
  bind(body);
  if (store.data) { AD = store.data; draw(); return; }
  body.innerHTML = `<div class="seo-empty" data-ads-wait>Loading…</div>`;
  loadAds().then((a) => {
    AD = a;
    if (B === body && body.querySelector("[data-ads-wait]")) draw();   // still on the Ads tab
  }).catch((e) => {
    console.error("Ads not loaded:", e);
    if (body.querySelector("[data-ads-wait]")) {
      body.innerHTML = `<div class="seo-empty seo-err">${ctx.h.esc(/permission/i.test(e.message || "")
        ? "You don't have access to the SEO data." : e.message || "The Ads numbers couldn't be loaded.")}</div>`;
    }
  });
}

function setupHtml(esc, A) {
  const r = A.run;
  return `<div class="seo-card"><h3>Connect Google Ads</h3>
    ${r && r.ok === false ? `<div class="seo-warn">The last Ads update failed: ${esc(r.error || "")}</div>` : ""}
    ${!A.none ? `<p>The Ads update ran, but GA4 doesn't have any Google Ads costs yet.</p>` : ""}
    <ol class="seo-ad-steps">
      <li>In GA4: <b>Admin → Product links → Google Ads links → Link</b>, and choose your Google Ads account.</li>
      <li>In Google Ads: <b>Admin → Account settings → Auto-tagging</b> on.</li>
      <li>In Apps Script, run <code>testSeoAds</code>. It lists your campaigns once GA4 has their costs (usually a day after linking).</li>
      <li>Then run <code>runSeoAds</code> once, and <code>installSeoAdsTrigger</code> so it updates every morning. Press Refresh here.</li>
    </ol></div>`;
}

function draw() {
  const body = B, ctx = C, A = AD, h = ctx.h, K = ctx.kit, esc = h.esc;
  if (!body || !A) return;
  if (A.none || !A.days.length) { body.innerHTML = setupHtml(esc, A); return; }

  const first = A.days[0].date;
  const last = A.to || A.days[A.days.length - 1].date;
  const r = K.rangeOf(ui, last, first, last);
  lastR = r;
  const cmp = K.compareOf(r, ui.compare, first);
  const camp = ui.camp !== "" && A.camps[Number(ui.camp)] ? ui.camp : "";
  const cur = sum(A, r.from, r.to, camp);
  const prev = cmp && cmp.ok ? sum(A, cmp.from, cmp.to, camp) : null;

  /* Dates and campaign */
  const rangeText = `${h.fmtDate(r.from)} – ${h.fmtDate(r.to)} · ${r.n} day${r.n === 1 ? "" : "s"}` +
    (cmp ? (cmp.ok ? ` · vs ${h.fmtDate(cmp.from)} – ${h.fmtDate(cmp.to)}` : ` · no comparison: ad data starts ${h.fmtDate(first)}`) : "");
  const controls = `
    <div class="seo-row seo-range">${K.PRESETS.map(([k, l]) =>
      `<button class="seo-btn ${ui.preset === k ? "on" : ""}" data-ads-preset="${k}">${l}</button>`).join("")}</div>
    <div class="seo-row seo-range">
      ${ui.preset === "custom" ? `
        <label class="seo-note">From <input type="date" class="seo-input seo-date" data-ads-from min="${first}" max="${last}" value="${r.from}"></label>
        <label class="seo-note">To <input type="date" class="seo-input seo-date" data-ads-to min="${first}" max="${last}" value="${r.to}"></label>` : ""}
      <label class="seo-note">Compare to
        <select class="seo-input seo-select" data-ads-compare>
          ${[["prev", "Previous period"], ["year", "Same time last year"], ["none", "No comparison"]].map(([k, l]) =>
            `<option value="${k}"${ui.compare === k ? " selected" : ""}>${l}</option>`).join("")}
        </select></label>
      <label class="seo-note">Campaign
        <select class="seo-input seo-select" data-ads-campsel>
          <option value="">All campaigns</option>
          ${A.camps.map((c, i) => `<option value="${i}"${camp === String(i) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select></label>
      <span class="seo-note">${esc(rangeText)}</span>
    </div>`;

  /* Totals */
  const tile = (label, v, d, note) => `<div class="seo-kpi"><div class="l">${label}</div><div class="v">${v}</div>${d || ""}${note ? `<div class="p">${note}</div>` : ""}</div>`;
  const vs = (f, k) => (prev && prev[k] != null ? `vs ${f(prev[k])}` : "");
  const both = (...xs) => xs.filter(Boolean).join(" · ");
  const kpis = [
    tile("Spend", money(cur.cost), prev ? chg(h, cur.cost, prev.cost, { neutral: true }) : "", vs(money, "cost")),
    tile("Ad clicks", num(cur.clicks), prev ? chg(h, cur.clicks, prev.clicks) : "", vs(num, "clicks")),
    tile("Cost per click", money(cur.cpc), prev ? chg(h, cur.cpc, prev.cpc, { invert: true }) : "", vs(money, "cpc")),
    tile("Impressions", num(cur.impr), prev ? chg(h, cur.impr, prev.impr) : "", vs(num, "impr")),
    tile("CTR", pct(cur.ctr), prev ? chg(h, cur.ctr, prev.ctr) : "", vs(pct, "ctr")),
    tile("Visits from ads", num(cur.sess), prev ? chg(h, cur.sess, prev.sess) : "", both(vs(num, "sess"), "GA4")),
    tile("Key events", keF(cur.ke), prev ? chg(h, cur.ke, prev.ke) : "", both(vs(keF, "ke"), "bookings and enquiries")),
    tile("Cost per key event", money(cur.cpke), prev ? chg(h, cur.cpke, prev.cpke, { invert: true }) : "", both(vs(money, "cpke"), "lower is better")),
    tile("Bounce rate", pct0(cur.bounce),
      prev && cur.bounce != null && prev.bounce != null
        ? h.delta(cur.bounce * 100, prev.bounce * 100, { invert: true, abs: true, digits: 1 }).replace(/<\/span>$/, " pts</span>") : "",
      both(vs(pct0, "bounce"), "left straight away")),
  ].join("");

  /* Ads vs free clicks */
  const ov = ctx.data.ov;
  const org = h.sumRange(ctx.data.days, r.from, r.to);
  const tot = cur.clicks + org.clicks;
  const share = !camp && tot ? `<p class="seo-note" style="margin:-6px 0 14px">Of ${num(tot)} clicks from Google in these dates,
    <strong>${Math.round((cur.clicks / tot) * 100)}%</strong> were ads and ${Math.round((org.clicks / tot) * 100)}% were free (organic)${
    r.to > ov.periodEnd ? `. Organic clicks are counted to ${esc(h.fmtDate(ov.periodEnd))}, Search Console's last settled day` : ""}.</p>` : "";

  /* The chart */
  const mk = METRICS[ui.metric] ? ui.metric : "cost";
  const m = METRICS[mk];
  const gran = K.autoGran(r.n);
  const bks = K.buckets(r.from, r.to, gran);
  const off = prev ? K.daysBetween(cmp.from, r.from) : 0;
  const points = bks.map((b) => ({ ...b, label: K.bucketLabel(b, gran), v: sum(A, b.start, b.end, camp)[mk] }));
  const cpts = prev ? bks.map((b) => {
    const s = h.addDays(b.start, -off), e = h.addDays(b.end, -off);
    return { label: K.bucketLabel({ start: s, end: e }, gran), v: sum(A, s, e, camp)[mk] };
  }) : null;
  const chart = `<div class="seo-card">
    <div class="seo-row"><h3 style="margin:0">Trend${camp ? ` · ${esc(A.camps[Number(camp)].name)}` : ""}</h3><span class="seo-sp"></span>
      ${Object.entries(METRICS).map(([k, v]) => `<button class="seo-btn ${mk === k ? "on" : ""}" data-ads-metric="${k}">${v.label}</button>`).join("")}</div>
    <div class="seo-chart">${K.lineChart(points, { fmt: m.fmt, cmp: cpts, gran, labels: true })}</div>
    ${cpts ? `<div class="seo-legend"><span></span>${esc(h.fmtDate(r.from, false))} – ${esc(h.fmtDate(r.to))}
      <span class="is-cmp"></span>${esc(cmp.name)}: ${esc(h.fmtDate(cmp.from, false))} – ${esc(h.fmtDate(cmp.to))}</div>` : ""}
  </div>`;

  /* Campaigns */
  const per = A.camps.map((c, i) => ({
    i, name: c.name, type: c.type,
    cur: sum(A, r.from, r.to, String(i)),
    prev: prev ? sum(A, cmp.from, cmp.to, String(i)) : null,
  })).filter((x) => x.cur.cost || x.cur.sess || (x.prev && x.prev.cost));
  const CS = { name: (x) => x.name.toLowerCase(), cost: (x) => x.cur.cost, clicks: (x) => x.cur.clicks, cpc: (x) => x.cur.cpc,
    sess: (x) => x.cur.sess, ke: (x) => x.cur.ke, cpke: (x) => x.cur.cpke, bounce: (x) => x.cur.bounce };
  per.sort(sorter(CS[ui.sort] || CS.cost, ui.dir));
  const th = (k, l) => `<th data-ads-sort="${k}" class="${ui.sort === k ? "on" : ""}">${l}${ui.sort === k ? (ui.dir > 0 ? " ↑" : " ↓") : ""}</th>`;
  const campCard = `<div class="seo-card"><h3>Campaigns <small class="seo-note">click one to see only that campaign</small></h3>
    ${per.length ? `<div class="seo-table-wrap" style="max-height:none"><table class="seo-table">
      <thead><tr>${th("name", "Campaign")}${th("cost", "Spend")}<th>vs before</th>${th("clicks", "Clicks")}${th("cpc", "Cost per click")}
        ${th("sess", "Visits")}${th("ke", "Key events")}${th("cpke", "Cost per key event")}${th("bounce", "Bounce")}</tr></thead>
      <tbody>${per.map((x) => `<tr data-ads-camp="${x.i}" class="${camp === String(x.i) ? "is-on" : ""}">
        <td><div class="seo-path" title="${esc(x.name)}">${esc(x.name)}${x.type ? ` <span class="seo-note">${esc(x.type)}</span>` : ""}</div></td>
        <td>${money(x.cur.cost)}</td><td>${x.prev ? chg(h, x.cur.cost, x.prev.cost, { neutral: true }) : "—"}</td>
        <td>${num(x.cur.clicks)}</td><td>${money(x.cur.cpc)}</td><td>${num(x.cur.sess)}</td>
        <td>${keF(x.cur.ke)}</td><td>${money(x.cur.cpke)}</td><td>${pct0(x.cur.bounce)}</td></tr>`).join("")}</tbody>
    </table></div>` : `<p class="seo-note">No campaign activity in these dates.</p>`}</div>`;

  /* Opportunities */
  const cname = (k) => A.camps[k.c]?.name || "";
  const kwBtn = (k) => (k === "(not set)" ? `<b>${esc(k)}</b>`
    : `<button type="button" class="seo-ad-link" data-kq="${esc(kq(k))}" title="See it in Keywords"><b>${esc(k)}</b></button>`);
  const byPath = new Map();
  ctx.data.pages.forEach((p) => { const k = K.tkey(p.path); if (!byPath.has(k)) byPath.set(k, p); });
  const kwIn = A.kw.filter((k) => camp === "" || k.c === Number(camp));

  const waste = kwIn.filter((k) => k.cost >= 50 && !k.ke && k.kw !== "(not set)").sort((a, b) => b.cost - a.cost).slice(0, 6)
    .map((k) => `<li>${kwBtn(k.kw)} · ${money(k.cost)} on ${num(k.clicks)} clicks, no key events<small>${esc(cname(k))}</small></li>`);
  const free = kwIn.filter((k) => k.cost >= 20 && k.oPos != null && k.oPos <= 3).sort((a, b) => b.cost - a.cost).slice(0, 6)
    .map((k) => `<li>${kwBtn(k.kw)} · ranks ${h.fmtPos(k.oPos)} for free (${num(k.oClicks)} organic clicks in 28 days), ${money(k.cost)} on ads<small>${esc(cname(k))}</small></li>`);
  const gap = kwIn.filter((k) => k.ke >= 2 && (k.oPos == null || k.oPos > 10)).sort((a, b) => b.ke - a.ke).slice(0, 6)
    .map((k) => `<li>${kwBtn(k.kw)} · ${keF(k.ke)} key events from ads at ${money(k.cost / k.ke)} each, ${
      k.oPos == null ? "not in Google's organic results" : `organic position ${h.fmtPos(k.oPos)}`}<small>${esc(cname(k))}</small></li>`);
  const lpBad = A.lp.filter((p) => p.sess >= 30 && 1 - p.eng / p.sess > 0.65).sort((a, b) => b.sess - a.sess).slice(0, 6)
    .map((p) => {
      const pg = byPath.get(K.tkey(p.path));
      const ob = pg && pg.m28.sessions >= 20 ? 1 - (pg.m28.engaged || 0) / pg.m28.sessions : null;
      const name = pg ? `<button type="button" class="seo-ad-link" data-open="${esc(pg.id)}"><b>${esc(p.path)}</b></button>` : `<b>${esc(p.path)}</b>`;
      return `<li>${name} · ${pct0(1 - p.eng / p.sess)} of ${num(p.sess)} ad visitors left straight away${
        ob != null ? `<small>Visitors from Google search: ${pct0(ob)}${ob < 1 - p.eng / p.sess - 0.1 ? ". The page works for search visitors, so check the ad matches what the page offers" : ""}</small>` : ""}</li>`;
    });
  const rising = !camp && prev ? per.filter((x) => x.prev && x.cur.ke >= 3 && x.prev.ke >= 3 && x.cur.cpke > x.prev.cpke * 1.3).slice(0, 4)
    .map((x) => `<li><button type="button" class="seo-ad-link" data-ads-camp="${x.i}"><b>${esc(x.name)}</b></button> · cost per key event ${money(x.prev.cpke)} → ${money(x.cur.cpke)}</li>`) : [];

  const group = (title, tone, intro, items) => (items.length
    ? `<div class="seo-ad-op is-${tone}"><h4>${title}</h4><p class="seo-note" style="margin:0">${intro}</p><ul>${items.join("")}</ul></div>` : "");
  const ops = [
    group("Spending without bookings", "red", "Check the searches and the landing page, or pause these.", waste),
    group("Already ranking for free", "green", "You're in Google's top 3 for these. Try a lower bid and watch whether total clicks hold.", free),
    group("Worth an SEO page", "blue", "These bring bookings from ads but don't rank organically. A strong page could win them for free.", gap),
    group("Ad visitors leaving straight away", "amber", "Last 28 days. The page may not match what the ad promised.", lpBad),
    group("Cost per key event rising", "amber", "More than 30% up on the period before.", rising),
  ].join("");
  const kwRange = A.kwFrom ? `keywords: ${esc(h.fmtDate(A.kwFrom, false))} – ${esc(h.fmtDate(A.kwTo))} · landing pages: last 28 days` : "";
  const oppCard = `<div class="seo-card"><h3>Opportunities <small class="seo-note">${kwRange}</small></h3>
    ${ops ? `<div class="seo-ad-ops">${ops}</div>` : `<p class="seo-note">Nothing stands out right now. 👍</p>`}</div>`;

  /* Keywords */
  const KS = { kw: (k) => k.kw.toLowerCase(), cost: (k) => k.cost, clicks: (k) => k.clicks, cpc: (k) => (k.clicks ? k.cost / k.clicks : null),
    ke: (k) => k.ke, cpke: (k) => (k.ke ? k.cost / k.ke : null), oPos: (k) => k.oPos };
  const kws = kwIn.slice().sort(sorter(KS[ui.kwSort] || KS.cost, ui.kwDir));
  const kshow = ui.kwAll ? kws : kws.slice(0, 25);
  const kth = (k, l) => `<th data-ads-kwsort="${k}" class="${ui.kwSort === k ? "on" : ""}">${l}${ui.kwSort === k ? (ui.kwDir > 0 ? " ↑" : " ↓") : ""}</th>`;
  const kwCard = `<div class="seo-card"><h3>Keywords <small class="seo-note">last 90 days · organic position from Search Console, last 28 days</small></h3>
    ${kws.length ? `<div class="seo-table-wrap" style="max-height:none"><table class="seo-table">
      <thead><tr>${kth("kw", "Keyword")}${kth("cost", "Spend")}${kth("clicks", "Clicks")}${kth("cpc", "Cost per click")}
        ${kth("ke", "Key events")}${kth("cpke", "Cost per key event")}${kth("oPos", "Organic")}</tr></thead>
      <tbody>${kshow.map((k) => `<tr>
        <td><div class="seo-path" title="${esc(k.kw)}">${k.kw === "(not set)"
          ? `<span class="seo-note">(not set: Performance Max and similar)</span>` : kwBtn(k.kw)} <span class="seo-note">${esc(cname(k))}</span></div></td>
        <td>${money(k.cost)}</td><td>${num(k.clicks)}</td><td>${money(k.clicks ? k.cost / k.clicks : null)}</td>
        <td>${keF(k.ke)}</td><td>${money(k.ke ? k.cost / k.ke : null)}</td>
        <td>${k.oPos == null ? "—" : `${h.fmtPos(k.oPos)} <span class="seo-note">${num(k.oClicks)} clicks</span>`}</td></tr>`).join("")}</tbody>
    </table></div>
    ${kws.length > 25 ? `<div style="padding:8px 0 0;text-align:center"><button class="seo-btn" data-ads-more="kwAll">${ui.kwAll ? "Show fewer" : `Show all ${num(kws.length)}`}</button></div>` : ""}`
    : `<p class="seo-note">No keyword data yet.</p>`}</div>`;

  /* What people searched */
  const qs = A.q.slice(0, ui.qAll ? A.q.length : 15);
  const qCard = A.q.length ? `<div class="seo-card"><h3>What people searched before clicking an ad <small class="seo-note">last 90 days, busiest first</small></h3>
    <div class="seo-table-wrap" style="max-height:none"><table class="seo-table">
      <thead><tr><th>Search</th><th>Visits</th><th>Key events</th><th>Bounce</th><th>Organic</th></tr></thead>
      <tbody>${qs.map((x) => `<tr><td><div class="seo-path" title="${esc(x.q)}">${kwBtn(x.q)}</div></td>
        <td>${num(x.sess)}</td><td>${keF(x.ke)}</td><td>${pct0(x.sess ? 1 - x.eng / x.sess : null)}</td>
        <td>${x.oPos == null ? "—" : `${h.fmtPos(x.oPos)} <span class="seo-note">${num(x.oClicks)} clicks</span>`}</td></tr>`).join("")}</tbody>
    </table></div>
    ${A.q.length > 15 ? `<div style="padding:8px 0 0;text-align:center"><button class="seo-btn" data-ads-more="qAll">${ui.qAll ? "Show fewer" : `Show all ${num(A.q.length)}`}</button></div>` : ""}
  </div>` : "";

  /* Footer */
  const run = A.run;
  const at = A.updatedAt ? A.updatedAt.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
  const warn = run && run.ok === false ? `<div class="seo-warn">The last Ads update failed, so these numbers may be out of date: ${esc(run.error || "")}</div>` : "";

  body.innerHTML = `${warn}${controls}<div class="seo-kpis">${kpis}</div>${share}${oppCard}${chart}${campCard}${kwCard}${qCard}
    <p class="seo-note">These numbers come from GA4, so they can differ a little from the Google Ads screen: key events are counted the way GA4 credits them, not as Google Ads conversions.
      Data to ${esc(h.fmtDate(last))}${at ? ` · updated ${esc(at)}` : ""}.</p>`;
}

/* ---------- clicks and changes (bound once to the SEO body) ---------- */

function bind(body) {
  if (body.dataset.adsBound) return;
  body.dataset.adsBound = "1";
  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-ads-preset],[data-ads-metric],[data-ads-camp],[data-ads-sort],[data-ads-kwsort],[data-ads-more]");
    if (!t || !AD || !body.contains(t)) return;
    const d = t.dataset;
    if (d.adsPreset !== undefined) {
      if (d.adsPreset === "custom" && lastR) { ui.from = lastR.from; ui.to = lastR.to; }   // start from what's showing
      ui.preset = d.adsPreset;
    } else if (d.adsMetric !== undefined) ui.metric = d.adsMetric;
    else if (d.adsCamp !== undefined) ui.camp = ui.camp === d.adsCamp ? "" : d.adsCamp;
    else if (d.adsSort !== undefined) {
      if (ui.sort === d.adsSort) ui.dir *= -1;
      else { ui.sort = d.adsSort; ui.dir = ASC.includes(d.adsSort) ? 1 : -1; }
    } else if (d.adsKwsort !== undefined) {
      if (ui.kwSort === d.adsKwsort) ui.kwDir *= -1;
      else { ui.kwSort = d.adsKwsort; ui.kwDir = ASC.includes(d.adsKwsort) ? 1 : -1; }
    } else if (d.adsMore !== undefined) ui[d.adsMore] = !ui[d.adsMore];
    save();
    draw();
  });
  body.addEventListener("change", (e) => {
    const t = e.target;
    if (!AD) return;
    if (t.matches("[data-ads-compare]")) ui.compare = t.value;
    else if (t.matches("[data-ads-campsel]")) ui.camp = t.value;
    else if (t.matches("[data-ads-from],[data-ads-to]")) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.value)) return;
      ui[t.matches("[data-ads-from]") ? "from" : "to"] = t.value;
    } else return;
    save();
    draw();
  });
}