// seo-work.js — SEO Phase 2: Keywords, Opportunities, Change log, Settings.
// Used by seo.js. Reads seo_state/queries, seo_queries, seo_settings/main, seo_opps, seo_log.

import { db, auth } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { loadHealth, viewHealth, healthPanelHtml } from "./seo-health.js";
import { loadAudience, viewAudience } from "./seo-audience.js";

const BRAND = "__brand", OTHER = "__other", ALL = "__all";
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
const SUGGESTED = {
  topics: [
    { name: "Pigmentation", words: ["pigmentation", "melasma", "sun spot", "sunspot", "age spot", "freckle", "dark spot"] },
    { name: "Acne & scarring", words: ["acne", "scar", "breakout", "pimple"] },
    { name: "Rosacea & redness", words: ["rosacea", "redness", "capillar", "flushing", "angioma"] },
    { name: "Anti-wrinkle", words: ["wrinkle", "botox", "frown", "crow's feet", "crows feet"] },
    { name: "Fillers", words: ["filler", "lip ", "lips", "cheek", "jawline", "chin"] },
    { name: "Needling & laser", words: ["needling", "laser", "ipl", "resurfacing", "fraxel"] },
    { name: "Peels & facials", words: ["peel", "facial", "hydrafacial", "dermaplan"] },
    { name: "Skin care", words: ["skincare", "skin care", "serum", "sunscreen", "retinol", "vitamin c", "moisturiser"] },
    { name: "Ageing & tightening", words: ["ageing", "aging", "older", "sagging", "loose skin", "tightening", "jowl"] },
  ],
  brand: ["dermedica"],
};
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
    const w = { queries: [], qs: null, settings: null, opps: {}, log: [], errors: {}, prefill: null, health: null, audience: null };
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
  const [q, c, i, pos, pc, pi, ppos, pages] = r;
  return {
    q: String(q), c, i, pos, pc, pi, ppos, ctr: i ? c / i : 0,
    pages: (pages || []).map(([path, c2, i2, p2]) => ({ path, c: c2, i: i2, pos: p2 })),
  };
}

function settingsOf(w) {
  const s = w.settings || {};
  return {
    topics: (Array.isArray(s.topics) ? s.topics : [])
      .map((t) => ({ name: String(t.name || "").trim(), words: (t.words || []).map(norm).filter(Boolean) }))
      .filter((t) => t.name),
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
    if (st.brand.some((b) => l.includes(b))) { q.topic = BRAND; continue; }
    const t = st.topics.find((t) => t.words.some((x) => l.includes(x)));
    q.topic = t ? t.name : OTHER;
  }
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
  return `<div class="seo-w-panel">${healthPanelHtml(w.health, p)}
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
      const name = pg ? `<button class="seo-w-link" data-open="${pg.id}">${h.esc(p.path)}</button>` : h.esc(p.path);
      return `<tr><td>${name}</td><td>${h.fmtInt(p.c)}</td><td>${h.fmtInt(p.i)}</td><td>${Math.round((p.i / tot) * 100)}%</td><td>${h.fmtPos(p.pos)}</td></tr>`;
    }).join("")}</tbody></table>`;
}

/* ---------- Keywords ---------- */

function viewKeywords(wrap, c, ui) {
  const { work: w, h } = c;
  if (!w.queries.length) { wrap.innerHTML = noQueries(c); return; }
  const qs = w.qs || {};
  const label = (t) => (t === ALL ? "All searches" : t === BRAND ? "Brand searches" : t === OTHER ? "Not in a topic" : t);

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
    const order = [ALL, ...settingsOf(w).topics.map((t) => t.name), OTHER, BRAND];
    const g = new Map(order.map((k) => [k, { k, n: 0, c: 0, i: 0, pw: 0, pc: 0, pi: 0, ppw: 0 }]));
    for (const q of w.queries) {
      for (const k of [ALL, q.topic]) {
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
        <h3>${h.esc(label(ui.topic))}</h3><span class="seo-sp"></span>
        <input class="seo-input" type="search" data-w-q placeholder="Filter searches, e.g. melasma" value="${h.esc(ui.qfilter)}">
      </div>
      <div class="seo-table-wrap" data-w-qtable></div>
      <p class="seo-note" style="margin-top:8px">Click a search to see which pages show for it.</p>`;
    drawQ();
  }

  function qRow(q) {
    const row = `<tr data-w-qopen="${h.esc(q.q)}" class="${ui.qopen === q.q ? "is-on" : ""}">
      <td><div class="seo-path">${h.esc(q.q)}</div></td><td>${h.fmtInt(q.c)}</td><td>${h.delta(q.c, q.pc)}</td>
      <td>${h.fmtInt(q.i)}</td><td>${h.fmtPct(q.ctr)}</td><td>${h.fmtPos(q.pos)}</td>
      <td>${h.delta(q.pos, q.ppos, { invert: true, abs: true })}</td>
      <td><div class="seo-path seo-w-toppage">${h.esc(q.pages[0]?.path || "—")}</div></td></tr>`;
    return ui.qopen === q.q ? row + `<tr class="seo-w-sub"><td colspan="8">${pagesList(q.pages, c)}</td></tr>` : row;
  }

  function drawQ() {
    const f = norm(ui.qfilter);
    const col = COLS.find((x) => x.k === ui.qsort) || COLS[3];
    let rows = w.queries.filter((q) => (ui.topic === ALL || q.topic === ui.topic) && (!f || q.q.toLowerCase().includes(f)));
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
    const t = e.target.closest("[data-w-topic],[data-w-qsort],[data-w-qopen],[data-w-qmore]");
    if (!t) return;
    const d = t.dataset;
    if (d.wTopic !== undefined) { ui.topic = d.wTopic; ui.qopen = null; ui.qlimit = 100; draw(); }
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
  for (const arr of Object.values(by)) {
    arr.sort((a, b) => (b.gain || b.score || 0) - (a.gain || a.score || 0));
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
    list.push({ id, key: s.key, type: s.type, title: s.label, url: s.url, gain: 0, st: s, status: s.status, stale: true });
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
  return `<article class="seo-w-card is-${T.tone}">
    <header><span class="seo-w-pill is-${T.tone}">${h.esc(T.label)}</span>
      ${o.gain > 0 ? `<span class="seo-w-gain">≈ +${h.fmtInt(o.gain)} clicks / 28 days</span>` : ""}</header>
    <h4>${quoted}</h4>
    ${oppBody(o, c)}
    ${(o.type === "striking" || o.type === "ctr" || o.type === "area" || o.stale) && o.url
      ? `<p class="seo-note">Page: ${pg ? `<button class="seo-w-link" data-open="${pg.id}">${h.esc(o.url)}</button>` : h.esc(o.url)}</p>` : ""}
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
    const inType = list.filter((o) => ui.otype === "all" || o.type === ui.otype);
    const counts = {};
    for (const o of inType) counts[o.status] = (counts[o.status] || 0) + 1;
    const tcount = {};
    for (const o of list) if (o.status === ui.ostatus) tcount[o.type] = (tcount[o.type] || 0) + 1;
    const show = inType.filter((o) => o.status === ui.ostatus);

    wrap.innerHTML = `
      ${staleWarn(c)}
      ${!w.queries.length ? `<div class="seo-warn">Search data isn't loaded yet, so only “Losing clicks” can be worked out. Run <code>runSeoQueries()</code> in Apps Script.</div>` : ""}
      <div class="seo-row">${Object.entries(STATUS).map(([k, l]) =>
        `<button class="seo-btn ${ui.ostatus === k ? "on" : ""}" data-w-status="${k}">${l} <span class="seo-w-n">${counts[k] || 0}</span></button>`).join("")}</div>
      <div class="seo-row">${[["all", "All types"], ...Object.entries(OPP).map(([k, v]) => [k, v.label])].map(([k, l]) =>
        `<button class="seo-w-chip ${ui.otype === k ? "is-on" : ""}" data-w-type="${k}">${h.esc(l)}${k !== "all" ? ` <em>${tcount[k] || 0}</em>` : ""}</button>`).join("")}</div>
      <p class="seo-note">Worked out from the last 28 days. Brand searches are left out. Extra clicks are a rough estimate, so use them to pick what to do first.</p>
      ${show.length ? `<div class="seo-w-grid">${show.map((o) => oppCard(o, c)).join("")}</div>` : `<div class="seo-empty">Nothing here.</div>`}`;
  }

  wrap.onclick = async (e) => {
    if (e.target.closest("[data-open]")) return;
    const t = e.target.closest("[data-w-status],[data-w-type],[data-w-ost],[data-w-olog],[data-w-savenote]");
    if (!t) return;
    const d = t.dataset;
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

function viewLog(wrap, c) {
  const { work: w, h } = c;
  const canWork = c.can("seo.work"), canManage = c.can("seo.manage");
  const me = uid();
  const paths = c.data.pages.map((p) => p.path).sort();
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
      <datalist id="seo-w-paths">${paths.map((p) => `<option value="${h.esc(p)}">`).join("")}</datalist>
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
    let month = "";
    return w.log.map((e) => {
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
          <div class="seo-note">${e.url ? (pg ? `<button class="seo-w-link" data-open="${pg.id}">${h.esc(e.url)}</button>` : h.esc(e.url)) : "Site-wide"}</div>
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
        <h3 style="margin:0 0 4px">Changes</h3>
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
    const t = e.target.closest("[data-w-edit],[data-w-del],[data-w-cancel]");
    if (!t) return;
    const d = t.dataset;
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

function viewSettings(wrap, c) {
  const { work: w, h } = c;
  if (!c.can("seo.manage")) { wrap.innerHTML = `<div class="seo-empty">Only people with SEO settings access can change these.</div>`; return; }
  const st = settingsOf(w);
  const wordsText = (list) => list.map((x) => (x.why ? `${x.word} | ${x.why}` : x.word)).join("\n");
  let topics = st.topics.map((t) => ({ name: t.name, words: t.words.join(", ") }));
  let brand = st.brand.join(", ");
  let keyPages = st.keyPages.join("\n");
  let words = wordsText(st.compliance || COMPLIANCE);
  let dirty = false;

  const topPages = () => [...new Set(["/", ...c.data.pages.filter((p) => p.m28.clicks > 0)
    .sort((a, b) => b.m28.clicks - a.m28.clicks).map((p) => p.path)])].slice(0, 16).join("\n");
  const lines = (s) => s.split(/\n+/).map((x) => x.trim()).filter(Boolean);

  function draw() {
    const other = w.queries.filter((q) => q.topic === OTHER).sort((a, b) => b.i - a.i).slice(0, 30);
    wrap.innerHTML = `<div class="seo-w-set">
      <div>
        <div class="seo-card">
          <h3 style="margin:0 0 4px">Topics</h3>
          <p class="seo-note">A search goes into the first topic with a matching word, so put specific topics above general ones.
            Words match anywhere in the search: “peel” matches “chemical peel perth”.</p>
          <div class="seo-w-tlist">${topics.map((t, i) => `
            <div class="seo-w-trow">
              <input class="seo-input" data-w-ti="${i}" data-w-tf="name" value="${h.esc(t.name)}" placeholder="Topic name" maxlength="60">
              <input class="seo-input" data-w-ti="${i}" data-w-tf="words" value="${h.esc(t.words)}" placeholder="Words, separated by commas">
              <button class="seo-btn" type="button" data-w-up="${i}" title="Move up" ${i ? "" : "disabled"}>↑</button>
              <button class="seo-btn" type="button" data-w-rm="${i}" title="Remove">✕</button>
            </div>`).join("") || `<p class="seo-note">No topics yet.</p>`}</div>
          <div class="seo-w-acts">
            <button class="seo-btn" type="button" data-w-add>Add topic</button>
            <button class="seo-btn" type="button" data-w-suggest>${topics.length ? "Replace with suggested topics" : "Start with suggested topics"}</button>
          </div>
          <h3 style="margin:18px 0 4px">Brand words</h3>
          <p class="seo-note">Searches containing these are grouped as Brand and left out of Opportunities.</p>
          <input class="seo-input seo-w-full" data-w-brand value="${h.esc(brand)}" placeholder="dermedica">
        </div>

        <div class="seo-card">
          <h3 style="margin:0 0 4px">Key pages</h3>
          <p class="seo-note">The pages Site health checks every night: speed, titles, links and advertising wording.
            One per line, up to 30, e.g. <code>/melasma-treatment-perth/</code>. Leave it empty to check the home page and the 15 busiest pages.</p>
          <textarea class="seo-input seo-w-full seo-w-ta" rows="9" data-w-keypages placeholder="/book-now/">${h.esc(keyPages)}</textarea>
          <div class="seo-w-acts">
            <button class="seo-btn" type="button" data-w-top>Use the busiest pages</button>
            <span class="seo-note" data-w-kpn>${lines(keyPages).length} page${lines(keyPages).length === 1 ? "" : "s"}</span>
          </div>
        </div>

        <div class="seo-card">
          <h3 style="margin:0 0 4px">Advertising wording</h3>
          <p class="seo-note">Words and phrases Site health looks for on the key pages, including titles, descriptions and image alt text.
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
        <p class="seo-note">Use these to decide which words to add. The list updates after you save.</p>
        ${other.length
          ? `<ul class="seo-list">${other.map((q) => `<li style="cursor:default"><span class="seo-path">${h.esc(q.q)}</span><span>${h.fmtInt(q.i)} impr.</span></li>`).join("")}</ul>`
          : `<p class="seo-note">${w.queries.length ? "Every search is in a topic." : "No search data yet."}</p>`}
      </div>
    </div>`;
  }

  const mark = () => {
    dirty = true;
    const el = wrap.querySelector("[data-w-dirty]");
    if (el) el.textContent = "Unsaved changes";
  };

  wrap.oninput = (e) => {
    const t = e.target;
    if (t.dataset.wTi !== undefined) { topics[+t.dataset.wTi][t.dataset.wTf] = t.value; mark(); }
    else if (t.matches("[data-w-brand]")) { brand = t.value; mark(); }
    else if (t.matches("[data-w-keypages]")) {
      keyPages = t.value; mark();
      const n = lines(keyPages).length;
      const el = wrap.querySelector("[data-w-kpn]");
      if (el) el.textContent = `${n} page${n === 1 ? "" : "s"}${n > 30 ? " (only 30 are checked)" : ""}`;
    }
    else if (t.matches("[data-w-words]")) { words = t.value; mark(); }
  };

  wrap.onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const d = t.dataset;
    if (d.wAdd !== undefined) {
      topics.push({ name: "", words: "" }); mark(); draw();
      wrap.querySelector(`[data-w-ti="${topics.length - 1}"]`)?.focus();
    } else if (d.wRm !== undefined) {
      topics.splice(+d.wRm, 1); mark(); draw();
    } else if (d.wUp !== undefined) {
      const i = +d.wUp;
      [topics[i - 1], topics[i]] = [topics[i], topics[i - 1]];
      mark(); draw();
    } else if (d.wSuggest !== undefined) {
      if (topics.length && !confirm("Replace your topics with the suggested list?")) return;
      topics = SUGGESTED.topics.map((x) => ({ name: x.name, words: x.words.join(", ") }));
      if (!brand.trim()) brand = SUGGESTED.brand.join(", ");
      mark(); draw();
    } else if (d.wTop !== undefined) {
      if (lines(keyPages).length && !confirm("Replace the key pages with the home page and the 15 busiest pages?")) return;
      keyPages = topPages(); mark(); draw();
    } else if (d.wWdefault !== undefined) {
      if (!confirm("Replace the advertising wording list with the suggested list?")) return;
      words = wordsText(COMPLIANCE); mark(); draw();
    } else if (d.wSave !== undefined) {
      const clean = topics
        .map((x) => ({ name: x.name.trim().slice(0, 60), words: [...new Set(x.words.split(",").map(norm).filter(Boolean))].slice(0, 60) }))
        .filter((x) => x.name);
      if (clean.some((x) => !x.words.length)) { toast("Every topic needs at least one word.", true); return; }
      const brands = [...new Set(brand.split(",").map(norm).filter(Boolean))];
      const pages = [...new Set(lines(keyPages)
        .map((s) => s.replace(/^https?:\/\/[^/]+/i, "").split("#")[0].trim())
        .map((s) => (s.startsWith("/") ? s : "/" + s)))];
      if (pages.length > 30) { toast(`That's ${pages.length} key pages. Keep it to 30.`, true); return; }
      const wordList = [];
      const seenW = new Set();
      for (const l of lines(words)) {
        const [wd, ...rest] = l.split("|");
        const word = norm(wd);
        if (!word || seenW.has(word)) continue;
        seenW.add(word);
        wordList.push({ word: word.slice(0, 80), why: rest.join("|").trim().slice(0, 150) });
      }
      t.disabled = true;
      try {
        const data = { topics: clean, brand: brands, keyPages: pages, compliance: wordList.slice(0, 200) };
        await setDoc(doc(db, "seo_settings", "main"), { ...data, updatedBy: uid(), updatedAt: serverTimestamp() }, { merge: true });
        w.settings = { ...(w.settings || {}), ...data };
        classify(w);
        if (w.ui) w.ui.topic = ALL;
        const s2 = settingsOf(w);
        topics = s2.topics.map((x) => ({ name: x.name, words: x.words.join(", ") }));
        brand = s2.brand.join(", ");
        keyPages = s2.keyPages.join("\n");
        words = wordsText(s2.compliance || []);
        dirty = false;
        toast("Settings saved. Key page and wording changes show after the next nightly check.");
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
.seo-w-plog{margin:0 0 10px;padding-left:18px;font-size:13px}
.seo-w-plog span{color:var(--text-muted,#6b7280);margin-right:4px}
.seo-mark line{stroke:#f59e0b;stroke-width:1.5;stroke-dasharray:4 4}
.seo-mark circle{fill:#f59e0b;cursor:help}
.seo-w-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2000;padding:10px 16px;border-radius:999px;background:#0f172a;color:#fff;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.2)}
.seo-w-toast.is-bad{background:#b91c1c}
@media (max-width:900px){.seo-w-log,.seo-w-set{grid-template-columns:1fr}}
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