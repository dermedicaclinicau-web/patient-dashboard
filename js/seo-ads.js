// seo-ads.js — SEO → Ads: Google Ads numbers through GA4
// Reads seo_state/ads and seo_state/ads_run (written each morning by runSeoAds in SeoAds.gs)
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, collection, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";

// Apps Script action "seoAds" (SeoAds.gs → handleSeoAds_)
const api = (op, data = {}) => callApi({ action: "seoAds", op, ...data });

// Claude's suggestions as saved (Firestore) or as sent back by Apps Script
function coachOf(x) {
  if (!x) return null;
  const at = x.at && typeof x.at.toDate === "function" ? x.at.toDate() : x.at ? new Date(x.at) : null;
  let actions = x.actions;
  if (typeof actions === "string") { try { actions = JSON.parse(actions); } catch { actions = []; } }
  return { at, by: x.by || "", summary: x.summary || "", actions: Array.isArray(actions) ? actions : [] };
}

/* ---------- data (cached for the session; Refresh in SEO clears it) ---------- */

const store = { data: null, pending: null };
export function clearAds() { store.data = null; PL.st = ""; PL.rows = []; }
// The Ads numbers if they're loaded, otherwise null (Keywords and the Overview use them when they're there)
export const peekAds = () => store.data;
// Spend, clicks and enquiries between two dates, for the Overview's What changed
export function adsTotals(from, to) {
  const A = store.data;
  if (!A || A.none || !A.days.length) return null;
  const t = sum(A, from, to);
  const L = A.leadsFrom && to >= A.leadsFrom ? sumLeads(A, from < A.leadsFrom ? A.leadsFrom : from, to) : null;
  return { cost: t.cost, clicks: t.clicks, ke: t.ke, enq: L ? L.enq : null, came: L ? L.came : null, first: A.days[0].date };
}

const J = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

export async function loadAds() {
  if (store.data) return store.data;
  if (store.pending) return store.pending;
  store.pending = (async () => {
    const [a, run, cSnap, sSnap] = await Promise.all([
      getDoc(doc(db, "seo_state", "ads")),
      getDoc(doc(db, "seo_state", "ads_run")).catch(() => null),
      getDoc(doc(db, "seo_state", "ads_coach")).catch(() => null),
      getDoc(doc(db, "seo_state", "ads_coach_status")).catch(() => null),
    ]);
    const r = run && run.exists() ? run.data() : null;
    const coach = cSnap && cSnap.exists() ? coachOf(cSnap.data()) : null;
    let status = {};
    try { status = sSnap && sSnap.exists() ? JSON.parse(sSnap.data().s || "{}") : {}; } catch { status = {}; }
    if (!a.exists()) return { none: true, run: r, days: [] };
    const x = a.data();
    return {
      coach, status, run: r, from: x.from, to: x.to, kwFrom: x.kwFrom, kwTo: x.kwTo, lpFrom: x.lpFrom, lpTo: x.lpTo,
      updatedAt: x.updatedAt?.toDate ? x.updatedAt.toDate() : null,
      camps: J(x.camps).map((c) => ({ name: String(c[0] || ""), type: String(c[1] || ""), id: String(c[2] || "") })),
      leads: J(x.leads).map((l) => ({ date: l[0], c: l[1], enq: l[2], cb: l[3], came: l[4], tx: l[5], lost: l[6] })),
      leadsFrom: x.leadsFrom || "",
      days: J(x.days).map((d) => ({ date: d[0], c: d[1], cost: d[2], clicks: d[3], impr: d[4], sess: d[5], eng: d[6], ke: d[7] })),
      kw: J(x.kw).map((k) => ({ kw: String(k[0] || ""), c: k[1], cost: k[2], clicks: k[3], impr: k[4], sess: k[5], eng: k[6], ke: k[7], oPos: k[8], oClicks: k[9] || 0 })),
      q: J(x.q).map((k) => ({ q: String(k[0] || ""), sess: k[1], eng: k[2], ke: k[3], oPos: k[4], oClicks: k[5] || 0 })),
      lp: J(x.lp).map((k) => ({ path: String(k[0] || ""), sess: k[1], eng: k[2], ke: k[3], psess: k[4], peng: k[5], pke: k[6] })),
    };
  })();
  try { store.data = await store.pending; return store.data; } finally { store.pending = null; }
}

/* ---------- a page's Google Ads visitors (the SEO page panel) ---------- */

export function adsPageHtml(A, path, h, tkey) {
  if (!A || A.none || !Array.isArray(A.lp)) return "";
  const k = tkey(path);
  const t = { sess: 0, eng: 0, ke: 0, psess: 0, peng: 0, pke: 0 };
  A.lp.filter((x) => tkey(x.path) === k).forEach((x) => {
    t.sess += x.sess || 0; t.eng += x.eng || 0; t.ke += x.ke || 0;
    t.psess += x.psess || 0; t.peng += x.peng || 0; t.pke += x.pke || 0;
  });
  if (!t.sess && !t.psess) return "";
  const b = t.sess ? 1 - t.eng / t.sess : null, pb = t.psess ? 1 - t.peng / t.psess : null;
  const row = (l, a, c) => `<tr><td>${l}</td><td>${a}</td><td>${c}</td></tr>`;
  const tip = b != null && b > 0.65 && t.sess >= 30
    ? `<p class="seo-bn-tip">💡 Most ad visitors leave this page straight away. Check the ad promises what the top of the page shows.</p>` : "";
  return `<div class="seo-ad-panel">
    <div class="seo-row" style="margin:0"><strong>Google Ads</strong><span class="seo-note">visitors who landed here from an ad</span>
      <span class="seo-sp"></span><button class="seo-btn" type="button" data-tab="ads">Open Ads</button></div>
    <table class="seo-kv"><tr><th></th><th>Last 28d</th><th>Prev 28d</th></tr>
      ${row("Visits from ads", num(t.sess), num(t.psess))}
      ${row("Bounce", pct0(b), pct0(pb))}
      ${row("Key events", keF(t.ke), keF(t.pke))}</table>${tip}</div>`;
}

/* ---------- what's chosen (remembered in this tab) ---------- */

const KEY = "dm.seo.ads";
const ui = (() => {
  const d = { preset: "28", from: "", to: "", compare: "prev", metric: "cost", camp: "",
    sort: "cost", dir: -1, kwSort: "cost", kwDir: -1, kwAll: false, qAll: false,
    kpi: "", kpiTab: "", kpiX: "" };   // the number card that's open, its tab, and the row that's open
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

// Enquiries from ads between two dates (by the day they enquired)
function sumLeads(A, from, to, camp = "") {
  const t = { enq: 0, cb: 0, came: 0, tx: 0, lost: 0 };
  const ci = camp === "" ? null : Number(camp);
  for (const l of A.leads || []) {
    if (l.date < from || l.date > to || (ci !== null && l.c !== ci)) continue;
    t.enq += l.enq; t.cb += l.cb; t.came += l.came; t.tx += l.tx; t.lost += l.lost;
  }
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
.seo-ad-coach{border-color:#c7d2fe;background:linear-gradient(180deg,#f8faff,#fff)}
.seo-ad-sum{margin:0 0 10px;font-size:14px;line-height:1.55}
.seo-ad-act{border:1px solid var(--border,#e5e7eb);border-left:4px solid #94a3b8;border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--card,#fff)}
.seo-ad-act.is-high{border-left-color:#16a34a}.seo-ad-act.is-medium{border-left-color:#2563eb}
.seo-ad-act p{margin:6px 0 0;font-size:13.5px;line-height:1.5}
.seo-ad-act-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.seo-ad-chip{font-size:11.5px;padding:1px 8px;border-radius:999px;background:#f1f5f9;color:#475569}
.seo-ad-chip.is-high{background:#dcfce7;color:#166534}
.seo-ad-how{color:#334155}
.seo-ad-copy{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin:8px 0 0;padding:8px 10px;border-radius:8px;background:#f8fafc;font-size:13px}
.seo-ad-copy ul{margin:4px 0 0;padding-left:18px}
.seo-adk{border-color:#bfdbfe;box-shadow:0 4px 16px rgba(37,99,235,.06)}
.seo-adk-sum{margin:4px 0 0;font-size:14px;line-height:1.5}
.seo-adk-tabs{display:inline-flex;gap:4px;margin:10px 0 6px;padding:3px;border-radius:10px;background:#f1f5f9}
.seo-adk-tabs button{border:0;background:none;padding:5px 12px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;color:inherit}
.seo-adk-tabs button.on{background:var(--card,#fff);box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:600}
.seo-adk .seo-table tbody tr.is-open{background:#eff6ff;font-weight:600}
.seo-adk .seo-table tbody tr.is-x:focus-visible{outline:2px solid var(--accent,#2563eb);outline-offset:-2px}
.seo-adk .seo-table tbody tr.seo-adk-x,.seo-adk .seo-table tbody tr.seo-adk-x:hover{background:#f8fbff;cursor:default}
.seo-adk .seo-table tr.seo-adk-x td{white-space:normal;text-align:left;max-width:none;padding:10px 14px 12px 30px;font-weight:400}
.seo-adk-car{display:inline-block;width:14px;font-style:normal;color:var(--text-muted,#6b7280)}
.seo-adk-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px 14px;margin:0 0 8px;font-size:13px}
.seo-adk-stats small{display:block;font-size:11.5px;color:var(--text-muted,#6b7280)}
.seo-adk-h{margin:8px 0 4px;font-size:12px;font-weight:700;color:var(--text-muted,#6b7280)}
.seo-adk-ul{margin:0;padding-left:18px;font-size:12.5px;line-height:1.6}
.seo-adk-say{margin:6px 0;padding:6px 10px;border-radius:6px;font-size:12.5px;line-height:1.45}
.seo-adk-say.is-red{background:#fef2f2;color:#991b1b}.seo-adk-say.is-green{background:#f0fdf4;color:#166534}
.seo-adk-say.is-amber{background:#fffbeb;color:#92400e}.seo-adk-say.is-blue{background:#eff6ff;color:#1e40af}
.seo-adk-acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
.seo-adk-acts a.seo-btn{text-decoration:none}
.seo-adk-tip{margin-top:10px;padding:8px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.5}
.seo-adk-fun{display:grid;grid-template-columns:170px minmax(0,1fr) 90px 110px 80px;gap:12px;align-items:center;padding:7px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-adk-fun.is-h{border-top:0;font-size:12px;font-weight:600;color:var(--text-muted,#6b7280)}
.seo-adk-fun > span:nth-child(n+3){text-align:right}
.seo-adk-bar{height:10px;border-radius:5px;background:#f1f5f9;overflow:hidden}
.seo-adk-bar i{display:block;height:100%;border-radius:5px;background:var(--accent,#2563eb)}
@media (max-width:640px){.seo-adk-fun{grid-template-columns:110px minmax(0,1fr) 60px}.seo-adk-fun > span:nth-child(n+4){display:none}}
.seo-adk-ok{color:#16a34a;font-weight:700}
.seo-adk-kw{margin:4px 0 8px;font-size:12.5px;line-height:1.6}
.seo-adk .seo-table td .seo-path{max-width:240px}
.seo-adk .seo-table td a{color:var(--accent,#2563eb);text-decoration:none;font-weight:600}
.seo-adk .seo-table td a:hover{text-decoration:underline}
`;
function injectCss() {
  if (document.getElementById("seo-ads-css")) return;
  const s = document.createElement("style");
  s.id = "seo-ads-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ---------- SEO → Tasks, from the Ads tab ---------- */

// The same rule as SEO → Tasks: admins and the SEO team
const canTask = () => !!C && (C.isAdmin === true || /^seo$/i.test(String(C.staff?.role || C.staff?.staffRole || "")));
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
function adsToast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}

// One task in SEO → Tasks. It comes first in Up next, like the Advisor's tasks.
async function addAdsTask(o) {   // { key, path, title, why, steps: [{ text, detail, effort, check }] }
  const id = "t_ads" + hashStr(o.key) + hashStr("#" + o.key);
  const ref = doc(db, "seo_tasks", id);
  const ex = await getDoc(ref);
  if (ex.exists() && !["done", "dismissed"].includes(ex.data().status)) return "already";
  const steps = {}, order = [];
  o.steps.forEach((s, i) => {
    const sid = "s_" + hashStr(id + "|" + i) + hashStr(i + "#" + id);
    steps[sid] = { text: s.text, detail: s.detail || "", effort: s.effort || "Quick", check: s.check || { k: "manual" },
      status: "todo", by: "", byName: "", at: "" };
    order.push(sid);
  });
  const role = String(C.staff?.role || C.staff?.staffRole || (C.isAdmin ? "Admin" : ""));
  const b = writeBatch(db);
  b.set(ref, { path: o.path, group: "ads", source: "ads", title: o.title, why: o.why || "", gain: 0, order, steps,
    status: "open", skipUntil: "", skipNote: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  b.set(doc(collection(db, "seo_task_log")), { taskId: id, path: o.path, taskTitle: o.title, stepId: "", text: "",
    note: "From the Ads tab", action: "add", by: auth.currentUser?.uid || "", byName: C.staff?.name || "", role,
    day: new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(new Date()), at: serverTimestamp() });
  await b.commit();
  return "added";
}

// "Worth an SEO page": improve the page that already shows in Google for it, or write a new one
function seoPageTask(k) {
  const kw = kq(k.kw);
  const hit = (C.work?.queries || []).find((q) => q.q.toLowerCase() === kw.toLowerCase());
  const page = hit && hit.pages[0] ? hit.pages[0].path : "";
  const why = `${keF(k.ke)} key events from Google Ads at ${money(k.ke ? k.cost / k.ke : null)} each, ${
    k.oPos == null ? "and no page ranks for it" : `but it only ranks ${C.h.fmtPos(k.oPos)} for free`}. A page that ranks could win these without paying.`;
  if (page) {
    return { key: "kw:" + kw.toLowerCase(), path: page, title: `Win “${kw}” for free (now paid for in Google Ads)`, why, steps: [
      { text: `Start the page title with “${kw}”`, effort: "Quick", check: { k: "title", page, has: kw } },
      { text: `Add a heading and a section that answers “${kw}”`, effort: "Medium", check: { k: "heading", page, has: kw },
        detail: "What it is, who it suits, results, downtime and cost." },
      { text: "Link to this page from 2–3 related pages, using those words", effort: "Quick", check: { k: "manual" } },
    ] };
  }
  return { key: "kw:" + kw.toLowerCase(), path: "/", title: `New page for “${kw}” (now paid for in Google Ads)`, why, steps: [
    { text: `Write a new page that answers “${kw}”`, effort: "Bigger", check: { k: "manual" },
      detail: "Ask the Advisor for an outline. Publish it, then add it to the treatments menu." },
    { text: "Link to the new page from 2–3 related pages", effort: "Quick", check: { k: "manual" } },
  ] };
}

// Claude's suggestion about a page → a task to do on that page
function coachTask(a) {
  const path = String(a.page || "").replace(/^https?:\/\/[^/]+/i, "").split("?")[0] || "/";
  return { key: "coach:" + a.key, path, title: a.title, why: String(a.why || "").slice(0, 300), steps: [
    { text: a.title, detail: a.how || "", effort: a.effort === "quick" ? "Quick" : a.effort === "big" ? "Bigger" : "Medium", check: { k: "manual" } },
  ] };
}

/* ---------- Claude's suggestions ---------- */

let coachBusy = false, coachErr = "", coachFilter = "todo";
const IMPACT = { high: "Big win", medium: "Worth doing", low: "Small" };
const EFFORT = { quick: "Quick", medium: "Under an hour", big: "Bigger job" };

// Suggestions marked Done, as markers on the chart
function doneMarks(A) {
  return Object.values(A.status || {}).filter((s) => s && s.st === "done" && s.date)
    .map((s) => ({ date: s.date, title: "Done: " + (s.title || "a suggestion") }));
}

function coachHtml(h, A) {
  const esc = h.esc;
  const c = A.coach, S = A.status || {};
  const can = typeof C.can === "function" ? C.can("seo.work") : true;
  const when = c && c.at ? c.at.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
  const btn = can ? `<button class="seo-btn${c ? "" : " on"}" type="button" data-ads-coach${coachBusy ? " disabled" : ""}>${
    coachBusy ? "Claude is reading your numbers… (about a minute)" : c ? "Ask again now" : "Ask Claude now"}</button>` : "";
  const head = `<div class="seo-row" style="margin:0 0 8px"><h3 style="margin:0">✨ Claude's suggestions</h3>
    ${when ? `<span class="seo-note">${esc(when)}${c.by ? ` · ${esc(c.by)}` : ""}</span>` : ""}<span class="seo-sp"></span>${btn}</div>`;
  const err = coachErr ? `<div class="seo-warn">${esc(coachErr)}</div>` : "";
  if (!c) {
    return `<div class="seo-card seo-ad-coach">${head}${err}<p class="seo-note" style="margin:0">Every Monday morning Claude reads these
      numbers and suggests what to change to get more patients for your spend.${can ? " Press <b>Ask Claude now</b> for the first set." : ""}</p></div>`;
  }
  const all = c.actions.map((a) => ({ ...a, st: S[a.key] || null }));
  const n = { todo: all.filter((a) => !a.st).length, done: all.filter((a) => a.st && a.st.st === "done").length,
    later: all.filter((a) => a.st && a.st.st === "later").length };
  const list = all.filter((a) => (coachFilter === "todo" ? !a.st : a.st && a.st.st === coachFilter));
  const seg = `<span class="seo-seg">${[["todo", "To do"], ["done", "Done"], ["later", "Not now"]].map(([k, l]) =>
    `<button type="button" class="${coachFilter === k ? "on" : ""}" data-ads-cf="${k}">${l} (${n[k]})</button>`).join("")}</span>`;
  const lines = (title, arr, max) => (arr && arr.length ? `<div><b>${title}</b>
    <button type="button" class="seo-ad-link" data-ads-copy="${esc(arr.join("\n"))}">Copy</button>
    <ul>${arr.map((x) => `<li>${esc(x)} <span class="seo-note">${x.length}/${max}</span></li>`).join("")}</ul></div>` : "");
  const item = (a) => {
    const copy = (a.headlines || []).length || (a.descriptions || []).length
      ? `<div class="seo-ad-copy">${lines("Headlines", a.headlines, 30)}${lines("Descriptions", a.descriptions, 90)}</div>` : "";
    const acts = a.st
      ? `<span class="seo-note">${a.st.st === "done" ? "Done" : "Not now"}${a.st.date ? ` · ${esc(h.fmtDate(a.st.date))}` : ""}${a.st.by ? ` · ${esc(a.st.by)}` : ""}</span>
         ${can ? `<button class="seo-btn" type="button" data-ads-act="${esc(a.key)}|undo">Undo</button>` : ""}`
      : can ? `<button class="seo-btn on" type="button" data-ads-act="${esc(a.key)}|done">Done</button>
         <button class="seo-btn" type="button" data-ads-act="${esc(a.key)}|later">Not now</button>` : "";
    return `<div class="seo-ad-act is-${esc(a.impact)}">
      <div class="seo-ad-act-h"><b>${esc(a.title)}</b>
        <span class="seo-ad-chip is-${esc(a.impact)}">${IMPACT[a.impact] || ""}</span>
        <span class="seo-ad-chip">${EFFORT[a.effort] || ""}</span>
        ${a.campaign ? `<span class="seo-ad-chip">${esc(a.campaign)}</span>` : ""}</div>
      <p>${esc(a.why)}</p>
      ${a.how ? `<p class="seo-ad-how"><b>How:</b> ${esc(a.how)}</p>` : ""}
      ${copy}
      ${a.risk ? `<div class="seo-warn">⚠ ${esc(a.risk)}</div>` : ""}
      ${(a.flags || []).length ? `<div class="seo-warn">${a.flags.map((f) => `⚠ ${esc(f)}`).join("<br>")}</div>` : ""}
      <div class="seo-row" style="margin:8px 0 0">${acts}
        ${a.page ? `<button class="seo-btn" type="button" data-advpage="${esc(String(a.page).replace(/^https?:\/\/[^/]+/i, "") || "/")}">Ask the Advisor about this page</button>` : ""}
        ${a.keyword ? `<button class="seo-btn" type="button" data-kq="${esc(kq(a.keyword))}">See it in Keywords</button>` : ""}
        ${a.page && !a.st && canTask() ? `<button class="seo-btn" type="button" data-ads-ctask="${esc(a.key)}">Add to Tasks</button>` : ""}</div>
    </div>`;
  };
  return `<div class="seo-card seo-ad-coach">${head}${err}
    ${c.summary ? `<p class="seo-ad-sum">${esc(c.summary)}</p>` : ""}
    <div class="seo-row">${seg}</div>
    ${list.length ? list.map(item).join("") : `<p class="seo-note">${coachFilter === "todo" ? "Nothing left to do from this set. 👍" : "None yet."}</p>`}
    <p class="seo-note" style="margin:8px 0 0">Written by Claude from these numbers. Check each suggestion before you change your account,
      and check any ad text against the advertising rules before you use it.</p>
  </div>`;
}

function copyText(txt, btn) {
  const done = (ok) => {
    btn.textContent = ok ? "Copied ✓" : "Couldn't copy";
    setTimeout(() => { if (btn.isConnected) btn.textContent = "Copy"; }, 1800);
  };
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(txt).then(() => done(true)).catch(() => done(fallback()));
  else done(fallback());
}

async function coachClick(t) {
  const d = t.dataset;
  const stillHere = () => B && B.querySelector(".seo-ad-coach");
  if (d.adsCf !== undefined) { coachFilter = d.adsCf; draw(); return; }
  if (d.adsCopy !== undefined) { copyText(d.adsCopy, t); return; }
  if (d.adsTask !== undefined || d.adsCtask !== undefined) {
    if (!canTask()) return;
    let o = null;
    if (d.adsTask !== undefined) { const k = AD.kw.find((x) => x.kw === d.adsTask); if (k) o = seoPageTask(k); }
    else { const a = (AD.coach?.actions || []).find((x) => x.key === d.adsCtask); if (a) o = coachTask(a); }
    if (!o) return;
    t.disabled = true;
    try {
      const r = await addAdsTask(o);
      adsToast(r === "already" ? "It's already in SEO → Tasks." : "Added to SEO → Tasks (Up next)");
      t.textContent = "In Tasks ✓";
    } catch (err) {
      t.disabled = false;
      adsToast(/permission/i.test(err?.message || "") ? "You don't have permission to add tasks." : err?.message || "Not added.", true);
    }
    return;
  }
  if (d.adsCoach !== undefined) {
    if (coachBusy) return;
    coachBusy = true; coachErr = "";
    draw();
    try {
      const r = await api("coach");
      if (r && r.problem) coachErr = r.problem;
      else if (r && r.coach) { AD.coach = coachOf(r.coach); coachFilter = "todo"; }
    } catch (err) {
      console.error("Ads coach:", err);
      coachErr = (err && err.message) || "Claude couldn't be reached. Try again.";
    } finally {
      coachBusy = false;
      if (stillHere()) draw();
    }
    return;
  }
  if (d.adsAct !== undefined) {
    const [key, st] = d.adsAct.split("|");
    t.disabled = true;
    try {
      const r = await api("act", { key, st });
      if (r && r.problem) coachErr = r.problem;
      else if (r && r.status) {
        AD.status = r.status;
        coachErr = "";
        // Done went into the Change log (Undo or Not now took it out): the other tabs see it straight away
        const w = C && C.work;
        if (w && Array.isArray(w.log)) {
          w.log = w.log.filter((e) => e.id !== r.removedLog && !(r.log && e.id === r.log.id));
          if (r.log) w.log.push({ ...r.log, createdAt: new Date(), updatedAt: new Date() });
          w.log.sort((a, b) => b.date.localeCompare(a.date));
        }
      }
    } catch (err) {
      coachErr = (err && err.message) || "Not saved. Try again.";
    }
    if (stillHere()) draw();
  }
}

/* ---------- The people behind "Enquiries from ads" (Apps Script: seoAds → adLeads) ---------- */
// Loaded once, the first time it's needed. st: "" not asked yet · "loading" · "ok" · "err" (Try again resets it)
const PL = { st: "", rows: [], names: false, err: "" };
function loadPeople() {
  if (PL.st) return;
  PL.st = "loading";
  PL.err = "";
  api("adLeads").then((r) => {
    if (r && r.problem) { PL.st = "err"; PL.err = r.problem; return; }
    PL.st = "ok";
    PL.rows = Array.isArray(r && r.rows) ? r.rows : [];
    PL.names = !!(r && r.names);
  }).catch((e) => {
    PL.st = "err";
    PL.err = (e && e.message) || "The enquiries couldn't be loaded.";
  }).finally(() => {
    if (B && B.isConnected && B.querySelector(".seo-adk")) draw();   // still looking at a card
  });
}
// The same matching as SeoAds.gs: the campaign ID from the ad click, otherwise its name. -1 = not known
function campIndexOf(A, c) {
  c = String(c || "");
  if (!c) return -1;
  const byId = A.camps.findIndex((x) => x.id && x.id === c);
  return byId >= 0 ? byId : A.camps.findIndex((x) => x.name.toLowerCase() === c.toLowerCase());
}
const PR_STAGE = { new: "New enquiry", contacted: "Contacted", consult_booked: "Consultation booked", consulted: "Consulted",
  tx_booked: "Treatment booked", treated: "Treated", active: "Active patient", lost: "Lost" };

/* ---------- Click a number card: what's behind it ---------- */
// Campaigns follow the dates you choose. Keywords and searches are always the last 90 days, and landing pages the
// last 28 days vs the 28 before: that's how SeoAds.gs saves them. Enquiries come from the Prospect Dashboard.

const KPIS = {
  cost: { label: "Spend", fmt: money, tabs: ["Campaigns", "Keywords"], neutral: true, add: true },
  clicks: { label: "Ad clicks", fmt: num, tabs: ["Campaigns", "Keywords"], add: true },
  cpc: { label: "Cost per click", fmt: money, tabs: ["Campaigns", "Keywords"], invert: true },
  impr: { label: "Impressions", fmt: num, tabs: ["Campaigns", "Keywords"], add: true },
  ctr: { label: "CTR", fmt: pct, tabs: ["Campaigns", "Keywords"] },
  sess: { label: "Visits from ads", fmt: num, tabs: ["Campaigns", "Landing pages", "Searches"], add: true },
  ke: { label: "Key events", fmt: keF, tabs: ["Campaigns", "Keywords", "Landing pages", "Searches"], add: true },
  cpke: { label: "Cost per key event", fmt: money, tabs: ["Campaigns", "Keywords"], invert: true },
  bounce: { label: "Bounce rate", fmt: pct0, tabs: ["Landing pages", "Campaigns", "Searches"], invert: true },
  enq: { label: "Enquiries from ads", fmt: num, tabs: ["Campaigns", "People", "Journey"], lead: true, add: true },
  cpe: { label: "Cost per enquiry", fmt: money, tabs: ["Campaigns", "People", "Journey"], lead: true, invert: true },
  came: { label: "Came in", fmt: num, tabs: ["Journey", "People", "Campaigns"], lead: true, add: true },
  cpp: { label: "Cost per patient who came in", fmt: money, tabs: ["Campaigns", "People", "Journey"], lead: true, invert: true },
};

// A keyword's value for a card
function kwV(k, key) {
  switch (key) {
    case "cpc": return k.clicks ? k.cost / k.clicks : null;
    case "ctr": return k.impr ? k.clicks / k.impr : null;
    case "cpke": return k.ke ? k.cost / k.ke : null;
    case "bounce": return k.sess ? 1 - k.eng / k.sess : null;
    default: return k[key] ?? null;
  }
}
// An enquiry card's value. cost: the spend over the same days (null when the campaign isn't known)
function leadV(L, cost, key) {
  if (!L) return null;
  if (key === "enq") return L.enq;
  if (key === "came") return L.came;
  if (key === "cpe") return cost != null && L.enq ? cost / L.enq : null;
  if (key === "cpp") return cost != null && L.came ? cost / L.came : null;
  return null;
}

function adsDrillHtml(o) {
  const { h, K, A, key, r, cmp, prev, cur, camp, per, kwIn, byPath } = o;
  const esc = h.esc;
  const m = KPIS[key];
  if (!m || (m.lead && !A.leadsFrom)) return "";
  const tab = m.tabs.includes(ui.kpiTab) ? ui.kpiTab : m.tabs[0];
  const hasCmp = !!prev;
  const ci = camp === "" ? -1 : Number(camp);
  const MAX = 15;

  /* ----- small builders ----- */
  const campName = (i) => (i < 0 ? "Campaign not known" : (A.camps[i] && A.camps[i].name) || "Campaign");
  const bnc = (s, e) => (s ? 1 - e / s : null);
  const fmtV = (v, f = m.fmt) => (v == null ? "—" : f(v));
  const was = (v, f = m.fmt) => `<span class="seo-note">${fmtV(v, f)}</span>`;
  const change = (now, before) => (now == null || before == null ? `<span class="seo-d flat">—</span>`
    : key === "bounce" ? h.delta(now * 100, before * 100, { invert: true, abs: true, digits: 0 }).replace(/<\/span>$/, " pts</span>")
    : chg(h, now, before, { neutral: m.neutral, invert: m.invert }));
  const signed = (d) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${m.fmt(Math.abs(d))}`;
  const totalLine = (a, b) => {
    if (a == null) return "";
    if (b == null) return `${m.label}: ${m.fmt(a)}.`;
    if (Math.abs(a - b) < 1e-9) return `${m.label} held steady (${m.fmt(a)}).`;
    const by = key === "bounce" ? ` ${Math.round(Math.abs(a - b) * 100)} points` : b ? ` ${Math.round(Math.abs((a - b) / b) * 100)}%` : "";
    return `${m.label} ${a > b ? "rose" : "fell"}${by} (${m.fmt(a)} vs ${m.fmt(b)}).`;
  };
  const isOpen = (k) => ui.kpiX === k;
  const xrow = (k, cells, cols, detail) => `<tr class="is-x${isOpen(k) ? " is-open" : ""}" data-ads-dx="${esc(k)}" tabindex="0" role="button" aria-expanded="${isOpen(k)}">${
    cells.map((c, i) => `<td>${i === 0 ? `<i class="seo-adk-car">${isOpen(k) ? "▾" : "▸"}</i>` : ""}${c}</td>`).join("")}</tr>${
    isOpen(k) ? `<tr class="seo-adk-x"><td colspan="${cols}">${detail()}</td></tr>` : ""}`;
  const table = (head, rows) => `<div class="seo-table-wrap" style="max-height:none"><table class="seo-table"><thead><tr>${
    head.map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const stats = (pairs) => `<div class="seo-adk-stats">${pairs.filter(Boolean).map(([l, v]) => `<div><small>${l}</small>${v}</div>`).join("")}</div>`;
  const say = (tone, html) => `<p class="seo-adk-say is-${tone}">${html}</p>`;
  const acts = (btns) => `<div class="seo-adk-acts">${btns.filter(Boolean).join("")}</div>`;
  const btn = (attr, label) => `<button class="seo-btn" type="button" ${attr}>${label}</button>`;
  const askBtn = (q) => btn(`data-drask="${esc(q)}"`, "Ask the Advisor");
  const kwLink = (s) => btn(`data-kq="${esc(kq(s))}"`, "See it in Keywords");
  const more = (n) => (n > MAX ? `<p class="seo-note" style="margin:6px 0 0">Top ${MAX} of ${num(n)}.</p>` : "");
  const orgOf = (path) => byPath.get(K.tkey(path)) || null;
  const orgB = (pg) => (!pg ? null : pg.eng && pg.eng.c[0] ? 1 - pg.eng.c[1] / pg.eng.c[0]
    : pg.m28.sessions ? 1 - (pg.m28.engaged || 0) / pg.m28.sessions : null);
  const per100 = (k, s) => (s ? (Math.round((k / s) * 1000) / 10).toFixed(1) : "—");
  // Enquiries traced to a keyword or landing page, since a date (loads the People list the first time)
  const enqStat = (label, match, since) => {
    if (!A.leadsFrom) return null;
    if (!PL.st) loadPeople();
    if (PL.st !== "ok") return [label, PL.st === "err" ? "—" : "loading…"];
    const l = PL.rows.filter((x) => x.day >= since && match(x));
    return [label, l.length ? `${num(l.length)} <span class="seo-note">${num(l.filter((x) => x.came).length)} came in</span>` : "0"];
  };

  /* ----- an open row ----- */
  const campDetail = (x) => {
    const t = x.cur;
    const by = m.add ? (k) => kwV(k, key) || 0 : (k) => k.cost;
    const top = A.kw.filter((k) => k.c === x.i && k.kw !== "(not set)").sort((a, b) => by(b) - by(a)).slice(0, 5);
    return stats([
      ["Spend", money(t.cost)], ["Clicks", num(t.clicks)], ["Cost per click", money(t.cpc)], ["CTR", pct(t.ctr)],
      ["Visits", num(t.sess)], ["Bounce", pct0(t.bounce)], ["Key events", keF(t.ke)], ["Cost per key event", money(t.cpke)],
      x.leads ? ["Enquiries", num(x.leads.enq)] : null, x.leads ? ["Came in", num(x.leads.came)] : null,
    ]) + (top.length ? `<div class="seo-adk-h">Its keywords <span class="seo-note">(last 90 days)</span></div>
      <ul class="seo-adk-ul">${top.map((k) => `<li><b>${esc(k.kw)}</b> · ${money(k.cost)} · ${num(k.clicks)} clicks · ${keF(k.ke)} key events${
        k.oPos != null ? ` · ranks ${h.fmtPos(k.oPos)} for free` : ""}</li>`).join("")}</ul>` : "")
      + acts([btn(`data-ads-camp="${x.i}"`, camp === String(x.i) ? "Show all campaigns" : "Show only this campaign")]);
  };

  const kwDetail = (k) => {
    const gap = k.ke >= 2 && (k.oPos == null || k.oPos > 10);
    const verdict = k.oPos != null && k.oPos <= 3 && k.cost >= 20
      ? say("green", `You already rank ${h.fmtPos(k.oPos)} for this for free (${num(k.oClicks)} free clicks in 28 days). Try a lower bid and watch whether total clicks hold.`)
      : !k.ke && k.cost >= 50 ? say("red", `${money(k.cost)} spent with no key events. Check which searches it shows for and the landing page, or pause it.`)
      : gap ? say("blue", `It brings bookings from ads, but ${k.oPos == null ? "no page ranks for it" : `it only ranks ${h.fmtPos(k.oPos)}`} for free. A strong page could win these without paying.`)
      : "";
    return stats([
      ["Spend", money(k.cost)], ["Clicks", num(k.clicks)], ["Cost per click", money(kwV(k, "cpc"))], ["CTR", pct(kwV(k, "ctr"))],
      ["Visits", num(k.sess)], ["Bounce", pct0(kwV(k, "bounce"))], ["Key events", keF(k.ke)], ["Cost per key event", money(kwV(k, "cpke"))],
      ["Free position", k.oPos == null ? "not ranking" : `${h.fmtPos(k.oPos)} <span class="seo-note">${num(k.oClicks)} clicks</span>`],
      enqStat("Enquiries from it", (x) => kq(x.kw || "").toLowerCase() === kq(k.kw).toLowerCase(), A.kwFrom || ""),
    ]) + verdict + acts([
      kwLink(k.kw),
      askBtn(`Our Google Ads keyword "${k.kw}" cost ${money(k.cost)} over the last 90 days for ${keF(k.ke)} key events${
        k.oPos != null ? `, and we rank ${h.fmtPos(k.oPos)} for it for free` : ""}. Is it worth what we pay, and what should we change?`),
      gap && canTask() ? btn(`data-ads-task="${esc(k.kw)}"`, "Add to Tasks") : "",
    ]);
  };

  const pageDetail = (p) => {
    const pg = orgOf(p.path);
    const b = bnc(p.sess, p.eng), pb = bnc(p.psess, p.peng), ob = orgB(pg);
    const verdict = b != null && ob != null && p.sess >= 20 && b > ob + 0.1
      ? say("amber", `Ad visitors leave much more often than visitors from Google search (${pct0(b)} vs ${pct0(ob)}). The page works for searchers, so check the ad promises what the top of the page shows.`)
      : b != null && b > 0.65 && p.sess >= 30
        ? say("red", "Most ad visitors leave straight away. Make sure the first screen answers what the ad promised, with a clear way to book.") : "";
    return stats([
      ["Ad visits", `${num(p.sess)} <span class="seo-note">was ${num(p.psess)}</span>`],
      ["Bounce", `${pct0(b)} <span class="seo-note">was ${pct0(pb)}</span>`],
      ["Key events", `${keF(p.ke)} <span class="seo-note">was ${keF(p.pke)}</span>`],
      ["Per 100 ad visits", per100(p.ke, p.sess)],
      ob != null ? ["Google visitors' bounce", pct0(ob)] : null,
      pg && pg.m28.sessions ? ["Per 100 Google visitors", per100(pg.m28.conversions || 0, pg.m28.sessions)] : null,
      enqStat("Enquiries from ad visitors here", (x) => !!x.land && K.tkey(x.land) === K.tkey(p.path), A.lpFrom || ""),
    ]) + verdict + acts([
      pg ? btn(`data-open="${esc(pg.id)}"`, "Open page details") : "",
      btn(`data-advpage="${esc(p.path)}"`, "Ask the Advisor about this page"),
    ]);
  };

  const qDetail = (x) => {
    const b = bnc(x.sess, x.eng);
    return stats([
      ["Ad visits", num(x.sess)], ["Bounce", pct0(b)], ["Key events", keF(x.ke)],
      ["Free position", x.oPos == null ? "not ranking" : `${h.fmtPos(x.oPos)} <span class="seo-note">${num(x.oClicks)} clicks</span>`],
    ]) + (x.oPos != null && x.oPos <= 3 ? say("green", `You already show ${h.fmtPos(x.oPos)} for this search for free.`) : "")
      + (x.sess >= 10 && !x.ke && b != null && b > 0.7
        ? say("amber", "People searching this mostly leave without doing anything. If it isn't something you offer, add it as a negative keyword.") : "")
      + acts([kwLink(x.q), askBtn(`People searched "${x.q}" before clicking our Google Ad (${num(x.sess)} visits, ${keF(x.ke)} key events). Should we bid on it, add it as a negative keyword, or build a page for it?`)]);
  };

  let sumLine = "", note = "", tip = "", body = "";

  /* ----- Enquiries, cost per enquiry, came in, cost per patient ----- */
  if (m.lead) {
    const lf = r.from < A.leadsFrom ? A.leadsFrom : r.from;
    const Lok = hasCmp && cmp.from >= A.leadsFrom;
    const tot = sumLeads(A, lf, r.to, camp), spend = sum(A, lf, r.to, camp).cost;
    const totP = Lok ? sumLeads(A, cmp.from, cmp.to, camp) : null;
    const spendP = Lok ? sum(A, cmp.from, cmp.to, camp).cost : null;
    sumLine = (lf > r.from ? `Counted from ${h.fmtDate(lf)}, when enquiry tracking began. ` : "") +
      totalLine(leadV(tot, spend, key), totP ? leadV(totP, spendP, key) : null);

    // sum() treats "-1" as all campaigns, so the unknown campaign gets no spend
    const rows = A.camps.map((_, i) => i).concat([-1]).map((i) => {
      const L = sumLeads(A, lf, r.to, String(i));
      const cost = i >= 0 ? sum(A, lf, r.to, String(i)).cost : null;
      const Lp = Lok ? sumLeads(A, cmp.from, cmp.to, String(i)) : null;
      const pc = Lok && i >= 0 ? sum(A, cmp.from, cmp.to, String(i)).cost : null;
      return { i, L, cost, now: leadV(L, cost, key), was: Lp ? leadV(Lp, pc, key) : null };
    }).filter((y) => y.L.enq || (y.cost || 0) >= 1);
    const rank = m.invert ? (y) => (y.cost == null ? -1 : y.now == null ? 1e12 + y.cost : y.now) : (y) => y.now || 0;
    rows.sort((a, b) => rank(b) - rank(a));

    if (tab === "People") {
      if (!PL.st) loadPeople();
      if (PL.st !== "ok") {
        body = PL.st === "err"
          ? `<p class="seo-note">${esc(PL.err)} <button class="seo-btn" type="button" data-ads-pretry>Try again</button></p>`
          : `<p class="seo-note">Loading the enquiries…</p>`;
      } else {
        const inRange = PL.rows.filter((x) => x.day >= lf && x.day <= r.to && (ci < 0 || campIndexOf(A, x.camp) === ci));
        const FIL = [["", "Everyone", () => true], ["came", "Came in", (x) => !!x.came],
          ["wait", "Not in yet", (x) => !x.came && x.stage !== "lost"], ["lost", "Lost", (x) => x.stage === "lost"]];
        const pf = FIL.some((f) => f[0] === ui.kpiPf) ? ui.kpiPf : "";
        const ppl = inRange.filter(FIL.find((f) => f[0] === pf)[2]);
        const SHOW = 50;
        const byKw = new Map();
        inRange.forEach((x) => {
          const k = kq(x.kw || "") || "(no keyword)";
          const y = byKw.get(k) || { k, n: 0, came: 0 };
          y.n++;
          if (x.came) y.came++;
          byKw.set(k, y);
        });
        const kws = [...byKw.values()].sort((a, b) => b.n - a.n || b.came - a.came).slice(0, 6);
        const tick = (v) => (v ? `<span class="seo-adk-ok">✓</span>` : `<span class="seo-note">–</span>`);
        const head = ["Enquired", "Name", ...(camp ? [] : ["Campaign"]), "Keyword", "Landed on", "Interested in", "Now", "Booked", "Came in", "Treated"];
        body = `<div class="seo-adk-tabs">${FIL.map(([k, l, f]) =>
            `<button type="button" class="${pf === k ? "on" : ""}" data-ads-pf="${k}">${l} (${num(inRange.filter(f).length)})</button>`).join("")}</div>`
          + (kws.length ? `<p class="seo-adk-kw"><b>Keywords behind them:</b> ${kws.map((y) =>
              `${esc(y.k)} <span class="seo-note">${y.n}${y.came ? `, ${y.came} came in` : ""}</span>`).join(" · ")}</p>` : "")
          + (ppl.length ? table(head, ppl.slice(0, SHOW).map((x) => {
              const i = campIndexOf(A, x.camp);
              return `<tr style="cursor:default">
                <td>${esc(h.fmtDate(x.day, false))}</td>
                <td>${PL.names && x.id ? `<a href="#/prospects/${encodeURIComponent(x.id)}">${esc(x.name || "No name")}</a>`
                  : `<span class="seo-note">Hidden</span>`}</td>
                ${camp ? "" : `<td><div class="seo-path" title="${esc(campName(i))}">${esc(campName(i))}</div></td>`}
                <td><div class="seo-path" title="${esc(x.kw)}">${esc(x.kw || "—")}</div></td>
                <td><div class="seo-path" title="${esc(x.land)}">${esc(x.land || "—")}</div></td>
                <td><div class="seo-path" title="${esc(x.concern)}">${esc(x.concern || "—")}</div></td>
                <td>${esc(x.stage === "lost" ? `Lost${x.lost ? `: ${x.lost}` : ""}` : PR_STAGE[x.stage] || x.stage)}</td>
                <td>${tick(x.cb)}</td><td>${tick(x.came)}</td><td>${tick(x.tx)}</td></tr>`;
            })) + (ppl.length > SHOW ? `<p class="seo-note" style="margin:6px 0 0">The latest ${SHOW} of ${num(ppl.length)}.
              On the Prospect Dashboard, “From Google Ads” shows them all.</p>` : "")
            : `<p class="seo-note">Nobody here for these dates.</p>`)
          + `<div class="seo-adk-acts"><a class="seo-btn" href="#/prospects">Open the Prospect Dashboard</a></div>`;
        note = "Stages here are live from the Prospect Dashboard, so they can be ahead of the numbers above, which update each morning." +
          (PL.names ? "" : " Names are hidden: they need Prospect access (Staff → Roles & access).");
      }
    } else if (tab === "Journey") {
      const steps = [["Enquired", "enq"], ["Booked a consultation", "cb"], ["Came in", "came"], ["Treated", "tx"]];
      body = `<div class="seo-adk-fun is-h"><span></span><span></span><span>People</span><span>Spend per person</span><span>${totP ? "vs before" : ""}</span></div>` +
        steps.map(([l, k]) => {
          const n = tot[k], w = tot.enq ? Math.round((n / tot.enq) * 100) : 0;
          return `<div class="seo-adk-fun"><span>${l}</span><span class="seo-adk-bar"><i style="width:${w}%"></i></span>
            <span><b>${num(n)}</b>${tot.enq && k !== "enq" ? ` <span class="seo-note">${w}%</span>` : ""}</span>
            <span>${n ? money(spend / n) : "—"}</span><span>${totP ? chg(h, n, totP[k]) : ""}</span></div>`;
        }).join("") +
        `<p class="seo-note" style="margin:8px 0 0">${num(tot.lost)} marked lost · ${money(spend)} spent over the same days.</p>
         <div class="seo-adk-acts"><a class="seo-btn" href="#/prospects">Open the Prospect Dashboard</a></div>`;
    } else {
      const head = ["Campaign", "Spend", "Enquiries", "Booked a consult", "Came in", "Treated", "Cost per enquiry", "Cost per patient", ...(Lok ? ["Change"] : [])];
      body = rows.length ? table(head, rows.map((y) => `<tr${y.i >= 0
        ? ` data-ads-camp="${y.i}" class="${camp === String(y.i) ? "is-on" : ""}"` : ` style="cursor:default"`}>
        <td><div class="seo-path">${esc(campName(y.i))}</div></td><td>${fmtV(y.cost, money)}</td><td>${num(y.L.enq)}</td><td>${num(y.L.cb)}</td>
        <td>${num(y.L.came)}</td><td>${num(y.L.tx)}</td><td>${fmtV(leadV(y.L, y.cost, "cpe"), money)}</td><td>${fmtV(leadV(y.L, y.cost, "cpp"), money)}</td>
        ${Lok ? `<td>${change(y.now, y.was)}</td>` : ""}</tr>`)) : `<p class="seo-note">No enquiries or spend in these dates.</p>`;
      note = "Click a campaign to see only that one. “Campaign not known”: enquiries whose ad click couldn't be matched to a campaign.";
    }
    if (hasCmp && !Lok) note = (note ? note + " " : "") + `No comparison: enquiries are only tracked from ${h.fmtDate(A.leadsFrom)}.`;

    const ranked = rows.filter((y) => y.now != null && (key === "cpe" ? y.L.enq : y.L.came) >= 2).sort((a, b) => a.now - b.now);
    tip = key === "came" || key === "cpp"
      ? "Came in keeps growing for a few weeks after people enquire, so the latest weeks look worse than they'll end up."
      : spend >= 50 && !tot.enq
        ? "No enquiries from ads were traced in these dates. If the ads are running, check the website's Ad tracking field still reaches the Prospect Dashboard."
        : key === "cpe" && ranked.length >= 2
          ? `${esc(campName(ranked[ranked.length - 1].i))} costs ${money(ranked[ranked.length - 1].now)} per enquiry, against ${money(ranked[0].now)} for ${esc(campName(ranked[0].i))}. Shifting some budget towards the cheaper one is worth testing.`
          : "";
  }

  /* ----- Spend, clicks, visits, key events, bounce… ----- */
  else {
    sumLine = (camp ? `${campName(ci)}: ` : "") + totalLine(cur[key], prev ? prev[key] : null);
    if (hasCmp && m.add && !camp && cur[key] !== prev[key]) {
      const dir = Math.sign(cur[key] - prev[key]);
      const d = per.filter((x) => x.prev && Math.sign(x.cur[key] - x.prev[key]) === dir)
        .sort((a, b) => Math.abs(b.cur[key] - b.prev[key]) - Math.abs(a.cur[key] - a.prev[key])).slice(0, 2);
      if (d.length) sumLine += ` Biggest change${d.length > 1 ? "s" : ""}: ${d.map((x) => `${x.name} (${signed(x.cur[key] - x.prev[key])})`).join(" and ")}.`;
    }

    if (tab === "Campaigns") {
      const vol = { cpc: (t) => t.clicks, ctr: (t) => t.impr, bounce: (t) => t.sess }[key];
      const rows = per.map((x) => ({ x, now: x.cur[key], was: x.prev ? x.prev[key] : null }))
        .filter((y) => (vol ? vol(y.x.cur) > 0 : key === "cpke" ? y.x.cur.cost > 0 : y.now || y.was));
      const rank = vol ? (y) => vol(y.x.cur) : key === "cpke" ? (y) => (y.now == null ? 1e12 + y.x.cur.cost : y.now)
        : hasCmp ? (y) => Math.abs((y.now || 0) - (y.was || 0)) : (y) => y.now || 0;
      rows.sort((a, b) => rank(b) - rank(a));
      const all = m.add ? rows.reduce((a, y) => a + (y.now || 0), 0) : 0;
      const extraHead = vol ? { cpc: "Clicks", ctr: "Impressions", bounce: "Visits" }[key] : key === "cpke" ? "Spend" : "Share";
      const head = ["Campaign", "Now", ...(hasCmp ? ["Before", "Change"] : []), extraHead];
      body = rows.length ? table(head, rows.map((y) => {
        const val = key === "cpke" && y.now == null ? `<span class="seo-note">no key events</span>` : fmtV(y.now);
        const extra = vol ? num(vol(y.x.cur)) : key === "cpke" ? money(y.x.cur.cost) : all ? Math.round(((y.now || 0) / all) * 100) + "%" : "—";
        return xrow("c:" + y.x.i, [`${esc(y.x.name)}${camp === String(y.x.i) ? ` <span class="seo-note">(chosen)</span>` : ""}`, val,
          ...(hasCmp ? [was(y.was), change(y.now, y.was)] : []), extra], head.length, () => campDetail(y.x));
      })) : `<p class="seo-note">No campaign activity in these dates.</p>`;
      if (camp) note = "Every campaign is listed. The one you chose is marked.";
    }

    else if (tab === "Keywords") {
      let list = kwIn.filter((k) => k.kw !== "(not set)");
      if (key === "cpc") list = list.filter((k) => k.clicks >= 5);
      else if (key === "ctr") list = list.filter((k) => k.impr >= 100);
      else if (key === "cpke") list = list.filter((k) => k.cost >= 10);
      else list = list.filter((k) => (kwV(k, key) || 0) > 0);
      const rank = key === "ctr" ? (k) => -(kwV(k, key) || 0)
        : key === "cpke" ? (k) => (k.ke ? k.cost / k.ke : 1e12 + k.cost) : (k) => kwV(k, key) || 0;
      list.sort((a, b) => rank(b) - rank(a));
      const other = ["cost", "clicks", "ke"].filter((x) => x !== key);
      const head = ["Keyword", m.label, ...other.map((x) => KPIS[x].label), "Free position"];
      body = list.length ? table(head, list.slice(0, MAX).map((k) => xrow("k:" + k.kw + "|" + k.c, [
        `${esc(k.kw)}${camp === "" ? ` <span class="seo-note">${esc(campName(k.c))}</span>` : ""}`,
        key === "cpke" && !k.ke ? `<span class="seo-note">none yet</span>` : fmtV(kwV(k, key)),
        ...other.map((x) => KPIS[x].fmt(kwV(k, x) || 0)),
        k.oPos == null ? "—" : h.fmtPos(k.oPos),
      ], head.length, () => kwDetail(k)))) + more(list.length)
        : `<p class="seo-note">No keywords with enough data${key === "ctr" ? " (100+ impressions)" : key === "cpc" ? " (5+ clicks)" : ""}.</p>`;
      const ns = kwIn.filter((k) => k.kw === "(not set)").reduce((a, k) => a + k.cost, 0);
      note = (key === "ctr" ? "Lowest click rate first (100+ impressions). " : key === "cpke" ? "Keywords spending without key events first. " : "") +
        (A.kwFrom ? `Keywords: ${h.fmtDate(A.kwFrom, false)} – ${h.fmtDate(A.kwTo)} (always the last 90 days).` : "Keywords: the last 90 days.") +
        (ns >= 1 ? ` Another ${money(ns)} went on Performance Max and similar campaigns, which don't report keywords.` : "");
    }

    else if (tab === "Landing pages") {
      let list = A.lp.filter((p) => p.sess || p.psess);
      if (key === "bounce") list = list.filter((p) => p.sess >= 10);
      const rank = key === "ke" ? (p) => p.ke : key === "bounce" ? (p) => p.sess - p.eng : (p) => p.sess;
      list.sort((a, b) => rank(b) - rank(a));
      const head = ["Landing page", "Ad visits", "Before", "Bounce", "Key events", "Google visitors' bounce"];
      body = list.length ? table(head, list.slice(0, MAX).map((p) => xrow("p:" + p.path, [
        `<div class="seo-path" title="${esc(p.path)}">${esc(p.path)}</div>`, num(p.sess), was(p.psess, num),
        pct0(bnc(p.sess, p.eng)), keF(p.ke), pct0(orgB(orgOf(p.path))),
      ], head.length, () => pageDetail(p)))) + more(list.length) : `<p class="seo-note">No landing page data yet.</p>`;
      note = (key === "bounce" ? "Pages losing the most ad visitors first (10+ visits). " : "") +
        "Landing pages: the last 28 days vs the 28 before, all campaigns (GA4 doesn't save these by campaign).";
    }

    else if (tab === "Searches") {
      let list = A.q.filter((x) => x.sess);
      if (key === "bounce") list = list.filter((x) => x.sess >= 10);
      const rank = key === "ke" ? (x) => x.ke : key === "bounce" ? (x) => x.sess - x.eng : (x) => x.sess;
      list.sort((a, b) => rank(b) - rank(a));
      const head = ["Search", "Ad visits", "Key events", "Bounce", "Free position"];
      body = list.length ? table(head, list.slice(0, MAX).map((x) => xrow("q:" + x.q, [
        `<div class="seo-path" title="${esc(x.q)}">${esc(x.q)}</div>`, num(x.sess), keF(x.ke), pct0(bnc(x.sess, x.eng)),
        x.oPos == null ? "—" : h.fmtPos(x.oPos),
      ], head.length, () => qDetail(x)))) + more(list.length) : `<p class="seo-note">No search data yet.</p>`;
      note = "Searches: the last 90 days, all campaigns. GA4 doesn't report every search.";
    }

    // Tips
    const waste = kwIn.filter((k) => k.kw !== "(not set)" && !k.ke && k.cost >= 20);
    const wasteSum = waste.reduce((a, k) => a + k.cost, 0);
    const lpBad = A.lp.filter((p) => p.sess >= 30).sort((a, b) => (b.sess - b.eng) - (a.sess - a.eng))[0];
    const keDrop = prev && prev.ke >= 5 && cur.ke <= prev.ke * 0.6 && prev.sess && cur.sess >= prev.sess * 0.85;
    const byCpke = per.filter((x) => x.cur.ke >= 2).sort((a, b) => b.cur.cpke - a.cur.cpke);
    tip = ({
      cost: wasteSum >= 50 ? `${money(wasteSum)} of the last 90 days' spend went on ${waste.length} keyword${waste.length === 1 ? "" : "s"} with no key events. The Keywords tab here lists them on the Cost per key event card.` : "",
      cpc: "Cost per click rises when more clinics bid on the same searches, or when Google rates the ad or landing page as less relevant. Open a campaign to see its costliest keywords.",
      ctr: prev && cur.ctr != null && prev.ctr != null && cur.ctr < prev.ctr * 0.85 && cur.impr > prev.impr
        ? "The ads were shown more often, but a smaller share clicked. That usually means they're showing for broader searches: check the Searches on the Visits card, and add negative keywords."
        : "A low click rate usually means the ad text doesn't match the search well. Keywords lists the lowest first.",
      sess: "GA4 counts visits, which are usually a little lower than ad clicks: some people leave before the page loads.",
      ke: keDrop
        ? "<b>Key events fell much more than visits.</b> That usually means a booking button, form or GA4 key event stopped working. Test a booking on the website."
        : A.leadsFrom ? "Key events are GA4's count. Enquiries from ads is the Prospect Dashboard's own count, and the better guide." : "",
      cpke: byCpke.length >= 2
        ? `${esc(byCpke[0].name)} costs ${money(byCpke[0].cur.cpke)} per key event, against ${money(byCpke[byCpke.length - 1].cur.cpke)} for ${esc(byCpke[byCpke.length - 1].name)}. Shifting some budget towards the cheaper one is worth testing.` : "",
      bounce: lpBad && bnc(lpBad.sess, lpBad.eng) > 0.6
        ? `Start with ${esc(lpBad.path)}: it loses the most ad visitors (${pct0(bnc(lpBad.sess, lpBad.eng))} of ${num(lpBad.sess)} leave straight away).` : "",
    })[key] || "";
  }

  const ask = `Our Google Ads ${m.label.toLowerCase()} for ${h.fmtDate(r.from)} to ${h.fmtDate(r.to)}${camp ? ` (campaign "${campName(ci)}")` : ""}${
    hasCmp ? `, compared with ${cmp.name.toLowerCase()}` : ""}: what's behind it, and what should we change to get more patients for the spend?`;

  return `<div class="seo-card seo-adk">
    <div class="seo-row" style="margin:0 0 2px"><h3 style="margin:0">${esc(m.label)}: what's behind it</h3>
      <span class="seo-note">${esc(h.fmtDate(r.from, false))} – ${esc(h.fmtDate(r.to))}${camp ? ` · ${esc(campName(ci))}` : ""}</span><span class="seo-sp"></span>
      ${METRICS[key] ? `<button class="seo-btn" type="button" data-ads-metric="${key}">Show on the Trend chart ↓</button>` : ""}
      <button class="seo-btn" type="button" data-ads-kpi="${key}">Close</button></div>
    ${sumLine ? `<p class="seo-adk-sum">${esc(sumLine)}</p>` : ""}
    ${m.tabs.length > 1 ? `<div class="seo-adk-tabs">${m.tabs.map((t) =>
      `<button type="button" class="${t === tab ? "on" : ""}" data-ads-dtab="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
    ${body}
    ${note ? `<p class="seo-note" style="margin:6px 0 0">${esc(note)}</p>` : ""}
    ${tip ? `<div class="seo-adk-tip">${tip}</div>` : ""}
    <div class="seo-adk-acts"><button class="seo-btn on" type="button" data-drask="${esc(ask)}">Ask the Advisor about this</button>
      ${!["Journey", "People"].includes(tab) ? `<span class="seo-note">Click a row to see more.</span>` : ""}</div>
  </div>`;
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

  /* Totals (click one to see what's behind it) */
  const tile = (key, label, v, d, note) => `<button type="button" class="seo-kpi${ui.kpi === key ? " is-on" : ""}" data-ads-kpi="${key}"
    aria-expanded="${ui.kpi === key}" title="See what's behind this number"><div class="l">${label}</div><div class="v">${v}</div>${d || ""}${
    note ? `<div class="p">${note}</div>` : ""}</button>`;
  const vs = (f, k) => (prev && prev[k] != null ? `vs ${f(prev[k])}` : "");
  const both = (...xs) => xs.filter(Boolean).join(" · ");
  const kpis = [
    tile("cost", "Spend", money(cur.cost), prev ? chg(h, cur.cost, prev.cost, { neutral: true }) : "", vs(money, "cost")),
    tile("clicks", "Ad clicks", num(cur.clicks), prev ? chg(h, cur.clicks, prev.clicks) : "", vs(num, "clicks")),
    tile("cpc", "Cost per click", money(cur.cpc), prev ? chg(h, cur.cpc, prev.cpc, { invert: true }) : "", vs(money, "cpc")),
    tile("impr", "Impressions", num(cur.impr), prev ? chg(h, cur.impr, prev.impr) : "", vs(num, "impr")),
    tile("ctr", "CTR", pct(cur.ctr), prev ? chg(h, cur.ctr, prev.ctr) : "", vs(pct, "ctr")),
    tile("sess", "Visits from ads", num(cur.sess), prev ? chg(h, cur.sess, prev.sess) : "", both(vs(num, "sess"), "GA4")),
    tile("ke", "Key events", keF(cur.ke), prev ? chg(h, cur.ke, prev.ke) : "", both(vs(keF, "ke"), "bookings and enquiries")),
    tile("cpke", "Cost per key event", money(cur.cpke), prev ? chg(h, cur.cpke, prev.cpke, { invert: true }) : "", both(vs(money, "cpke"), "lower is better")),
    tile("bounce", "Bounce rate", pct0(cur.bounce),
      prev && cur.bounce != null && prev.bounce != null
        ? h.delta(cur.bounce * 100, prev.bounce * 100, { invert: true, abs: true, digits: 1 }).replace(/<\/span>$/, " pts</span>") : "",
      both(vs(pct0, "bounce"), "left straight away")),
  ].join("");

  /* Enquiries from ads (Prospect Dashboard), from the day tracking started */
  let leadKpis = "", leadNote = "";
  if (A.leadsFrom) {
    const lf = r.from < A.leadsFrom ? A.leadsFrom : r.from;
    const L = sumLeads(A, lf, r.to, camp);
    const spend = sum(A, lf, r.to, camp).cost;
    const Lok = !!prev && cmp.from >= A.leadsFrom;   // only compare periods that were both tracked
    const Lp = Lok ? sumLeads(A, cmp.from, cmp.to, camp) : null;
    const cpe = L.enq ? spend / L.enq : null, cpp = L.came ? spend / L.came : null;
    leadKpis = [
      tile("enq", "Enquiries from ads", num(L.enq), Lp ? chg(h, L.enq, Lp.enq) : "", both(Lp ? `vs ${num(Lp.enq)}` : "", "Prospect Dashboard")),
      tile("cpe", "Cost per enquiry", money(cpe), Lp && Lp.enq ? chg(h, cpe, prev.cost / Lp.enq, { invert: true }) : "", "lower is better"),
      tile("came", "Came in", num(L.came), Lp ? chg(h, L.came, Lp.came) : "", both(`${num(L.cb)} booked a consultation`, `${num(L.tx)} treated`)),
      tile("cpp", "Cost per patient who came in", money(cpp), Lp && Lp.came ? chg(h, cpp, prev.cost / Lp.came, { invert: true }) : "", "the number that matters"),
    ].join("");
    leadNote = `<p class="seo-note" style="margin:-6px 0 14px">${r.from < A.leadsFrom
      ? `Enquiries are tracked from ${esc(h.fmtDate(A.leadsFrom))}, so cost per enquiry and per patient use the spend from then. ` : ""}Recent enquiries may not have come in yet, so "Came in" grows over the following weeks.</p>`;
  } else {
    leadNote = `<p class="seo-note" style="margin:-6px 0 14px">Cost per enquiry and per new patient appear here once enquiries arrive with the website's Ad tracking field.</p>`;
  }

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
    <div class="seo-chart">${K.lineChart(points, { fmt: m.fmt, cmp: cpts, gran, labels: true, marks: doneMarks(A) })}</div>
    ${doneMarks(A).length ? `<div class="seo-note">Orange lines: Claude's suggestions you marked Done. Hover the dot to see which.</div>` : ""}
    ${cpts ? `<div class="seo-legend"><span></span>${esc(h.fmtDate(r.from, false))} – ${esc(h.fmtDate(r.to))}
      <span class="is-cmp"></span>${esc(cmp.name)}: ${esc(h.fmtDate(cmp.from, false))} – ${esc(h.fmtDate(cmp.to))}</div>` : ""}
  </div>`;

  /* Campaigns */
  const per = A.camps.map((c, i) => ({
    i, name: c.name, type: c.type,
    cur: sum(A, r.from, r.to, String(i)),
    prev: prev ? sum(A, cmp.from, cmp.to, String(i)) : null,
    leads: A.leadsFrom ? sumLeads(A, r.from < A.leadsFrom ? A.leadsFrom : r.from, r.to, String(i)) : null,
  })).filter((x) => x.cur.cost || x.cur.sess || (x.prev && x.prev.cost) || (x.leads && x.leads.enq));
  const CS = { name: (x) => x.name.toLowerCase(), cost: (x) => x.cur.cost, clicks: (x) => x.cur.clicks, cpc: (x) => x.cur.cpc,
    sess: (x) => x.cur.sess, ke: (x) => x.cur.ke, cpke: (x) => x.cur.cpke, bounce: (x) => x.cur.bounce };
  per.sort(sorter(CS[ui.sort] || CS.cost, ui.dir));
  const th = (k, l) => `<th data-ads-sort="${k}" class="${ui.sort === k ? "on" : ""}">${l}${ui.sort === k ? (ui.dir > 0 ? " ↑" : " ↓") : ""}</th>`;
  const campCard = `<div class="seo-card"><h3>Campaigns <small class="seo-note">click one to see only that campaign</small></h3>
    ${per.length ? `<div class="seo-table-wrap" style="max-height:none"><table class="seo-table">
      <thead><tr>${th("name", "Campaign")}${th("cost", "Spend")}<th>vs before</th>${th("clicks", "Clicks")}${th("cpc", "Cost per click")}
        ${th("sess", "Visits")}${th("ke", "Key events")}${th("cpke", "Cost per key event")}${th("bounce", "Bounce")}
        ${A.leadsFrom ? `<th>Enquiries</th><th>Came in</th>` : ""}</tr></thead>
      <tbody>${per.map((x) => `<tr data-ads-camp="${x.i}" class="${camp === String(x.i) ? "is-on" : ""}">
        <td><div class="seo-path" title="${esc(x.name)}">${esc(x.name)}${x.type ? ` <span class="seo-note">${esc(x.type)}</span>` : ""}</div></td>
        <td>${money(x.cur.cost)}</td><td>${x.prev ? chg(h, x.cur.cost, x.prev.cost, { neutral: true }) : "—"}</td>
        <td>${num(x.cur.clicks)}</td><td>${money(x.cur.cpc)}</td><td>${num(x.cur.sess)}</td>
        <td>${keF(x.cur.ke)}</td><td>${money(x.cur.cpke)}</td><td>${pct0(x.cur.bounce)}</td>
        ${x.leads ? `<td>${num(x.leads.enq)}</td><td>${num(x.leads.came)}</td>` : ""}</tr>`).join("")}</tbody>
    </table></div>` : `<p class="seo-note">No campaign activity in these dates.</p>`}</div>`;

  /* Opportunities */
  const cname = (k) => A.camps[k.c]?.name || "";
  const kwBtn = (k) => (k === "(not set)" ? `<b>${esc(k)}</b>`
    : `<button type="button" class="seo-ad-link" data-kq="${esc(kq(k))}" title="See it in Keywords"><b>${esc(k)}</b></button>`);
  const askBtn = (q) => `<button type="button" class="seo-ad-link" data-drask="${esc(q)}">Ask the Advisor</button>`;
  const byPath = new Map();
  ctx.data.pages.forEach((p) => { const k = K.tkey(p.path); if (!byPath.has(k)) byPath.set(k, p); });
  const kwIn = A.kw.filter((k) => camp === "" || k.c === Number(camp));

  const waste = kwIn.filter((k) => k.cost >= 50 && !k.ke && k.kw !== "(not set)").sort((a, b) => b.cost - a.cost).slice(0, 6)
    .map((k) => `<li>${kwBtn(k.kw)} · ${money(k.cost)} on ${num(k.clicks)} clicks, no key events<small>${esc(cname(k))} · ${
      askBtn(`We spent ${money(k.cost)} on Google Ads for "${k.kw}" with no bookings or enquiries. Which page should that search land on, and what is it missing?`)}</small></li>`);
  const free = kwIn.filter((k) => k.cost >= 20 && k.oPos != null && k.oPos <= 3).sort((a, b) => b.cost - a.cost).slice(0, 6)
    .map((k) => `<li>${kwBtn(k.kw)} · ranks ${h.fmtPos(k.oPos)} for free (${num(k.oClicks)} organic clicks in 28 days), ${money(k.cost)} on ads<small>${esc(cname(k))}</small></li>`);
  const gap = kwIn.filter((k) => k.ke >= 2 && (k.oPos == null || k.oPos > 10)).sort((a, b) => b.ke - a.ke).slice(0, 6)
    .map((k) => `<li>${kwBtn(k.kw)} · ${keF(k.ke)} key events from ads at ${money(k.cost / k.ke)} each, ${
      k.oPos == null ? "not in Google's organic results" : `organic position ${h.fmtPos(k.oPos)}`}<small>${esc(cname(k))} · ${
      askBtn(`"${k.kw}" brings bookings from Google Ads but we ${k.oPos == null ? "don't rank for it" : `only rank ${h.fmtPos(k.oPos)}`} organically. Should we write a new page or improve an existing one, and what should it cover?`)}${
      canTask() ? ` · <button type="button" class="seo-ad-link" data-ads-task="${esc(k.kw)}">Add to Tasks</button>` : ""}</small></li>`);
  const lpBad = A.lp.filter((p) => p.sess >= 30 && 1 - p.eng / p.sess > 0.65).sort((a, b) => b.sess - a.sess).slice(0, 6)
    .map((p) => {
      const pg = byPath.get(K.tkey(p.path));
      const ob = pg && pg.m28.sessions >= 20 ? 1 - (pg.m28.engaged || 0) / pg.m28.sessions : null;
      const name = (pg ? `<button type="button" class="seo-ad-link" data-open="${esc(pg.id)}"><b>${esc(p.path)}</b></button>` : `<b>${esc(p.path)}</b>`) +
        ` <button type="button" class="seo-ad-link" data-advpage="${esc(p.path)}">Ask the Advisor</button>`;
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

  /* The number card that's open */
  const drill = ui.kpi ? adsDrillHtml({ h, K, A, key: ui.kpi, r, cmp, prev, cur, camp, per, kwIn, byPath }) : "";

  /* Footer */
  const run = A.run;
  const at = A.updatedAt ? A.updatedAt.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
  const warn = run && run.ok === false ? `<div class="seo-warn">The last Ads update failed, so these numbers may be out of date: ${esc(run.error || "")}</div>` : "";

  body.innerHTML = `${warn}${controls}<div class="seo-kpis">${kpis}${leadKpis}</div>${leadNote}${drill}${coachHtml(h, A)}${share}${oppCard}${chart}${campCard}${kwCard}${qCard}
    <p class="seo-note">These numbers come from GA4, so they can differ a little from the Google Ads screen: key events are counted the way GA4 credits them, not as Google Ads conversions.
      Data to ${esc(h.fmtDate(last))}${at ? ` · updated ${esc(at)}` : ""}.</p>`;
}

/* ---------- clicks and changes (bound once to the SEO body) ---------- */

function bind(body) {
  if (body.dataset.adsBound) return;
  body.dataset.adsBound = "1";
  body.addEventListener("click", (e) => {
    const ca = e.target.closest("[data-ads-coach],[data-ads-act],[data-ads-cf],[data-ads-copy],[data-ads-task],[data-ads-ctask]");
    if (ca && AD && body.contains(ca)) { coachClick(ca); return; }
    const t = e.target.closest("[data-ads-preset],[data-ads-metric],[data-ads-camp],[data-ads-sort],[data-ads-kwsort],[data-ads-more],[data-ads-kpi],[data-ads-dtab],[data-ads-dx],[data-ads-pf],[data-ads-pretry]");
    if (!t || !AD || !body.contains(t)) return;
    const d = t.dataset;
    const inner = e.target.closest("button,a");
    if (d.adsDx !== undefined && inner && inner !== t) return;   // a button inside a row does its own job
    if (d.adsKpi !== undefined) {
      ui.kpi = ui.kpi === d.adsKpi ? "" : d.adsKpi;
      ui.kpiTab = ""; ui.kpiX = "";
    } else if (d.adsDtab !== undefined) { ui.kpiTab = d.adsDtab; ui.kpiX = ""; }
    else if (d.adsDx !== undefined) ui.kpiX = ui.kpiX === d.adsDx ? "" : d.adsDx;
    else if (d.adsPf !== undefined) ui.kpiPf = d.adsPf;
    else if (d.adsPretry !== undefined) PL.st = "";   // the card asks again when it's drawn
    else if (d.adsPreset !== undefined) {
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
  // Enter or Space on a row opens it (the rows have tabindex)
  body.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest("[data-ads-dx]");
    if (row && body.contains(row) && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
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