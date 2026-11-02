// seo-clusters.js — SEO → Pages → Clusters
// A cluster is one main page (where people should land and book) and the pages that support it.
// Stored in seo_settings/main.clusters = [{ id, name, main, pages: [{ path, role: 'sup' | 'merge' }] }] (admins only).
// Links and redirects come from Site health (priority pages) and Seo8.gs (the other cluster pages), every morning.

import { db, auth } from "./firebase-config.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { npath, titleOf, pageOf, pageIndex, prettyPath, prioritySettings, priorityOf, clustersOf, linkState, redirectState, logPriority }
  from "./seo-work.js?v=15";

const MAX_CLUSTERS = 40, MAX_MEMBERS = 15;
const STOP = new Set(["in", "for", "the", "a", "an", "of", "and", "to", "on", "with", "near", "me", "my", "is", "are", "what", "how",
  "best", "perth", "treatment", "treatments", "skin", "clinic", "causes", "options", "guide", "dermedica", "your", "vs", "or", "does",
  "it", "work", "can", "you", "about"]);
const SMALLW = new Set(["in", "for", "and", "of", "the", "to", "with", "on", "a", "or", "vs"]);
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
const hasWords = (text, phrase) => {
  const t = String(text || "").toLowerCase();
  const ws = words(phrase);
  return ws.length > 0 && ws.every((x) => t.includes(x.replace(/s$/, "")));
};
const titleCase = (s) => String(s).replace(/[a-z0-9']+/gi, (m, i) =>
  (i && SMALLW.has(m.toLowerCase()) ? m.toLowerCase() : m.charAt(0).toUpperCase() + m.slice(1)));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const short = (s, n = 28) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const newId = () => "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}

// Every page's searches (brand left out): page → search → { i, c, pos }
function pageSearches(w) {
  const m = new Map();
  for (const q of w.queries || []) {
    if (q.topic === "__brand") continue;
    for (const p of q.pages) {
      const k = npath(p.path);
      let x = m.get(k);
      if (!x) m.set(k, (x = new Map()));
      const cur = x.get(q.q);   // the same page with and without the end slash: added together
      x.set(q.q, cur ? { i: cur.i + p.i, c: cur.c + p.c, pos: Math.min(cur.pos ?? 999, p.pos ?? 999) } : { i: p.i, c: p.c, pos: p.pos });
    }
  }
  return m;
}

export function renderClusters(body, c) {
  injectCss();
  const w = c.work, h = c.h;
  const admin = !!c.isAdmin;
  const ui = w.cui || (w.cui = { sel: "", node: 0, draft: null, find: "", adding: false });
  const wrap = document.createElement("div");
  wrap.className = "seo-c";
  body.replaceChildren(wrap);
  const PS = pageSearches(w);
  const idx = pageIndex(w, c.data);
  let lastSugg = [];

  const tOf = (p) => titleOf(w, c.data, p);
  const realTitle = (p) => (w.health?.pages || []).find((x) => npath(x.path) === npath(p))?.title || w.cpages?.[npath(p)]?.title || "";
  const clicksOf = (p) => pageOf(c.data, p)?.m28?.clicks || 0;
  const taken = () => {
    const s = new Set();
    clustersOf(w).forEach((x) => { s.add(npath(x.main)); x.pages.forEach((p) => s.add(npath(p.path))); });
    return s;
  };
  const clusterName = (main) => {
    const pri = priorityOf(w, main) || {};
    const base = pri.target ? titleCase(pri.target.replace(/\bperth\b/gi, "").replace(/\s+/g, " ").trim()) : "";
    return base || short(tOf(main), 40);
  };

  /* ----- suggestions ----- */

  function candidatesFor(main, used) {
    const k = npath(main);
    const mine = PS.get(k);
    const cand = new Map();
    if (mine && mine.size) {
      const myImp = [...mine.values()].reduce((a, x) => a + x.i, 0) || 1;
      for (const [pk, qs] of PS) {
        if (pk === k || pk === "/" || used.has(pk)) continue;
        let n = 0, imp = 0;
        for (const [q, x] of qs) if (mine.has(q)) { n++; imp += x.i; }
        if (n >= 3 || imp >= myImp * 0.15) cand.set(pk, { n, imp });
      }
    }
    // Pages whose title or address has the main search's key word (e.g. "ultherapy")
    const key = words((priorityOf(w, main) || {}).target || tOf(main))[0];
    if (key && key.length >= 4) {
      for (const x of idx.list) {
        const pk = npath(x.path);
        if (pk === k || pk === "/" || used.has(pk) || cand.has(pk)) continue;
        if ((x.title + " " + x.path).toLowerCase().includes(key)) cand.set(pk, { n: 0, imp: 0 });
      }
    }
    return [...cand.entries()].sort((a, b) => b[1].imp - a[1].imp || b[1].n - a[1].n).slice(0, 10)
      .map(([pk, v]) => ({ path: idx.get(pk)?.path || pageOf(c.data, pk)?.path || pk, n: v.n }));
  }

  function suggestions() {
    const used = taken();
    const dismissed = new Set((w.settings?.clusterDismissed || []).map(npath));
    const out = [];
    for (const main of prioritySettings(w).paths) {
      const k = npath(main);
      if (used.has(k) || dismissed.has(k) || k === "/") continue;
      const cand = candidatesFor(main, used);
      if (!cand.length) continue;
      out.push({ main, name: clusterName(main), pages: cand.map((x) => x.path), shared: cand.reduce((a, x) => a + x.n, 0) });
    }
    return out.slice(0, 8);
  }

  /* ----- the model behind the graph ----- */

  function current() {
    if (ui.draft) return ui.draft;
    const list = clustersOf(w);
    return list.find((x) => x.id === ui.sel) || list[0] || null;
  }

  function modelOf(cl) {
    const mainS = PS.get(npath(cl.main)) || new Map();
    const tgt = (priorityOf(w, cl.main) || {}).target || "";
    const important = [...mainS.entries()].filter(([, x]) => x.i >= 30).sort((a, b) => b[1].i - a[1].i).slice(0, 10).map(([q]) => q);
    if (tgt && !important.includes(tgt)) important.unshift(tgt);
    const mainSearch = tgt || important[0] || "";
    const nodes = [{ path: cl.main, role: "main", title: tOf(cl.main), clicks: clicksOf(cl.main), beats: [] }];
    for (const m of cl.pages) {
      const ms = PS.get(npath(m.path)) || new Map();
      let shared = 0;
      for (const q of ms.keys()) if (mainS.has(q)) shared++;
      const beats = important.filter((q) => {
        const a = ms.get(q), b = mainS.get(q);
        return a && a.i >= 10 && a.pos != null && (!b || b.pos == null || a.pos + 1 <= b.pos);
      });
      nodes.push({
        path: m.path, role: m.role, title: tOf(m.path), clicks: clicksOf(m.path), shared, beats,
        titleHasMain: !!(mainSearch && realTitle(m.path) && hasWords(realTitle(m.path), mainSearch)),
        link: m.role === "sup" ? linkState(w, m.path, cl.main) : null,
        redir: m.role === "merge" ? redirectState(w, m.path, cl.main) : null,
      });
    }
    // Who Google shows for the cluster's searches, and who should own each one
    const agg = new Map();
    for (const n of nodes) {
      for (const [q, x] of PS.get(npath(n.path)) || new Map()) {
        const a = agg.get(q) || { q, tot: 0, by: [] };
        a.tot += x.i;
        a.by.push({ n, ...x });
        agg.set(q, a);
      }
    }
    const table = [...agg.values()].filter((a) => a.tot >= 20).sort((a, b) => b.tot - a.tot).slice(0, 12).map((a) => {
      a.by.sort((x, y) => y.i - x.i);
      const now = a.by[0];
      const split = a.by[1] && a.by[1].i >= a.tot * 0.25;
      const fit = nodes.filter((n) => n.role === "sup" && hasWords(n.title, a.q) && !hasWords(nodes[0].title, a.q));
      const owner = fit[0] || nodes[0];
      const status = split ? "split" : npath(now.n.path) === npath(owner.path) ? "right" : "wrong";
      return { q: a.q, tot: a.tot, now, owner, status };
    });
    return { nodes, table, mainSearch };
  }

  /* ----- drawing ----- */

  function svg(M) {
    const W = 680, H = 340, cx = 340, cy = 170;
    const n = M.nodes.length - 1;
    const R = (x) => Math.min(34, 12 + Math.sqrt(x.clicks || 0) * 2);
    M.nodes.forEach((nd, i) => {
      if (i === 0) { nd.x = cx; nd.y = cy; return; }
      const a = -Math.PI / 2 + ((i - 1) / Math.max(1, n)) * Math.PI * 2 + (n === 2 ? Math.PI / 2 : 0);
      nd.x = cx + Math.cos(a) * 250;
      nd.y = cy + Math.sin(a) * 120;
    });
    const COL = { ok: "#16a34a", miss: "#dc2626", unk: "#94a3b8" };
    const m = M.nodes[0];
    const edges = M.nodes.slice(1).map((nd) => {
      const st = nd.role === "merge" ? nd.redir : nd.link;
      const kind = st === true ? "ok" : st === false ? "miss" : "unk";
      const dx = m.x - nd.x, dy = m.y - nd.y, d = Math.hypot(dx, dy) || 1;
      const x1 = nd.x + (dx / d) * R(nd), y1 = nd.y + (dy / d) * R(nd);
      const x2 = m.x - (dx / d) * (R(m) + 4), y2 = m.y - (dy / d) * (R(m) + 4);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${COL[kind]}" stroke-width="2"${
        kind === "ok" ? "" : ' stroke-dasharray="5 4"'} marker-end="url(#seo-c-a-${kind})"/>`;
    }).join("");
    const nodes = M.nodes.map((nd, i) => {
      const r = R(nd), isM = i === 0;
      const below = isM || nd.y >= cy;
      const ly = below ? nd.y + r + 14 : nd.y - r - 7;
      const cls = (isM ? "is-main" : nd.role === "merge" ? "is-merge" : "is-sup") + (nd.beats.length ? " is-beats" : "") + (i === ui.node ? " is-sel" : "");
      return `<g class="seo-c-node ${cls}" data-c-node="${i}" tabindex="0" role="button" aria-label="${h.esc(nd.title)}">
        <circle cx="${nd.x.toFixed(1)}" cy="${nd.y.toFixed(1)}" r="${r.toFixed(1)}"/>
        <text class="n" x="${nd.x.toFixed(1)}" y="${(nd.y + 4).toFixed(1)}" text-anchor="middle">${h.fmtInt(nd.clicks)}</text>
        <text class="l" x="${nd.x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${isM ? "★ " : nd.role === "merge" ? "merge · " : ""}${h.esc(short(nd.title))}</text>
      </g>`;
    }).join("");
    return `<svg class="seo-c-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cluster graph">
      <defs>${Object.entries(COL).map(([k, col]) => `<marker id="seo-c-a-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
        orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${col}"/></marker>`).join("")}</defs>${edges}${nodes}</svg>`;
  }

  function detailHtml(M, nd) {
    const isM = nd.role === "main";
    const pid = pageOf(c.data, nd.path)?.id || "";
    const issues = [];
    if (!isM && nd.role === "merge") {
      issues.push(nd.redir === true ? ["ok", "Redirects to the main page"] : nd.redir === false
        ? ["bad", "Still live: move what's useful into the main page, then redirect it there"] : ["unk", "Not checked yet (tomorrow morning)"]);
    } else if (!isM) {
      issues.push(nd.link === true ? ["ok", "Links to the main page"] : nd.link === false
        ? ["bad", "Doesn't link to the main page"] : ["unk", "Links not checked yet (tomorrow morning)"]);
      if (nd.beats.length) issues.push(["bad", `Beats the main page for ${nd.beats.slice(0, 3).map((q) => `“${q}”`).join(", ")}`]);
      if (nd.titleHasMain) issues.push(["warn", `Its title also targets “${M.mainSearch}”`]);
      if (nd.shared >= 10) issues.push(["warn", `Shares ${nd.shared} searches with the main page`]);
    }
    const advice = isM ? "This is where people should land and book. Its own title, heading and content tasks are in its action plan."
      : nd.role === "merge" ? "Merging puts this page's links and history behind the main page, so the main page ranks better."
      : nd.beats.length || nd.titleHasMain ? `Aim this page at its own question (for example “How does it work?”), take “${M.mainSearch}” out of its title, and link to the main page near the top. If it says the same as the main page, merge it instead.`
      : nd.link === false ? "Add a link to the main page near the top and again at the end, using the main search words."
      : nd.link === true ? "Doing its job." : "Its links are checked tomorrow morning.";
    return `<div class="seo-row" style="margin:0">
        <span class="seo-pr-pill ${isM ? "is-amber" : nd.role === "merge" ? "is-grey" : "is-blue"}">${isM ? "★ Main page" : nd.role === "merge" ? "Merge into main" : "Supporting"}</span>
        ${nd.beats.length ? '<span class="seo-pr-pill is-red">Competing</span>' : ""}</div>
      <h3 class="seo-c-dt">${h.esc(nd.title)}</h3>
      <div class="seo-note seo-w-mono">${h.esc(nd.path)}</div>
      <p class="seo-note" style="margin:4px 0 0">${h.fmtInt(nd.clicks)} clicks in 28 days${isM ? "" : ` · ${plural(nd.shared, "search")} shared with the main page`}</p>
      ${issues.length ? `<ul class="seo-c-issues">${issues.map(([k, t]) => `<li class="is-${k}">${h.esc(t)}</li>`).join("")}</ul>` : ""}
      <p class="seo-c-advice"><strong>${isM ? "Role" : "Suggested"}:</strong> ${h.esc(advice)}</p>
      <div class="seo-w-acts">
        ${pid ? `<button class="seo-btn" type="button" data-open="${h.esc(pid)}">Open page details</button>` : ""}
        ${admin && !isM ? `<button class="seo-btn" type="button" data-c-main>Make this the main page</button>
          ${nd.role === "merge" ? `<button class="seo-btn" type="button" data-c-role="sup">Keep as supporting</button>`
            : `<button class="seo-btn" type="button" data-c-role="merge">Merge into main</button>`}
          <button class="seo-btn" type="button" data-c-remove>Not in this cluster</button>` : ""}
        ${admin && isM ? `<button class="seo-btn" type="button" data-c-rename>Rename cluster</button>
          ${ui.draft ? "" : `<button class="seo-btn" type="button" data-c-delete>Delete cluster</button>`}` : ""}
      </div>`;
  }

  function resHtml() {
    const cl = current();
    const used = taken();
    if (cl) { used.add(npath(cl.main)); cl.pages.forEach((p) => used.add(npath(p.path))); }
    const f = ui.find.trim().toLowerCase();
    const items = idx.list.filter((x) => !used.has(npath(x.path)) && npath(x.path) !== "/"
      && (!f || (x.title + " " + x.path).toLowerCase().includes(f))).slice(0, 8);
    return items.length ? items.map((x) => `<button class="seo-c-res" type="button" data-c-add="${h.esc(x.path)}">
        <span>${h.esc(x.title || prettyPath(x.path))}</span><span class="seo-note seo-w-mono">${h.esc(x.path)}</span></button>`).join("")
      : `<p class="seo-note">No pages match. Pages already in a cluster aren't listed.</p>`;
  }

  function clusterHtml(cl) {
    const M = modelOf(cl);
    if (ui.node >= M.nodes.length) ui.node = 0;
    const sup = M.nodes.filter((n) => n.role === "sup"), mer = M.nodes.filter((n) => n.role === "merge");
    const missing = sup.filter((n) => n.link === false).length, competing = sup.filter((n) => n.beats.length).length;
    const pendingMerge = mer.filter((n) => n.redir !== true).length;
    const notPri = !priorityOf(w, cl.main);
    return `
      ${ui.draft ? `<div class="seo-w-tip seo-row" style="margin:0 0 10px">
          <span><strong>${ui.draft.isNew ? "New cluster" : "Suggested cluster"}.</strong> Check the pages: click one to change its role or take it out.</span>
          <span class="seo-sp"></span>
          ${admin ? `<button class="seo-btn on" type="button" data-c-savedraft>Save this cluster</button>` : ""}
          ${admin && !ui.draft.isNew ? `<button class="seo-btn" type="button" data-c-dismiss>Not a cluster</button>` : ""}
          <button class="seo-btn" type="button" data-c-cancel>Cancel</button></div>` : ""}
      <div class="seo-card">
        <div class="seo-row" style="margin:0 0 4px">
          <h3 style="margin:0">${h.esc(cl.name || "Cluster")}</h3>
          <span class="seo-note">${plural(M.nodes.length, "page")}</span>
          ${missing ? `<span class="seo-pr-pill is-red">${plural(missing, "missing link")}</span>` : ""}
          ${competing ? `<span class="seo-pr-pill is-red">${competing} competing</span>` : ""}
          ${pendingMerge ? `<span class="seo-pr-pill is-amber">${pendingMerge} to merge</span>` : ""}
          ${!missing && !competing && !pendingMerge && sup.length ? `<span class="seo-pr-pill is-green">In good shape</span>` : ""}
          <span class="seo-sp"></span>
          ${admin ? `<button class="seo-btn" type="button" data-c-adding>${ui.adding ? "Close" : "+ Add a page"}</button>` : ""}
        </div>
        ${ui.adding && admin ? `<div class="seo-c-pick"><input class="seo-input" type="search" data-c-find placeholder="Search pages to add" value="${h.esc(ui.find)}">
          <div data-c-res>${resHtml()}</div></div>` : ""}
        ${svg(M)}
        <div class="seo-c-legend">
          <span><i class="ok"></i>links to the main page</span><span><i class="miss"></i>link missing</span><span><i class="unk"></i>not checked yet</span>
          <span>circle size = clicks · red ring = beats the main page for its own searches</span></div>
        ${notPri ? `<div class="seo-w-tip">The main page isn't a priority page, so this cluster doesn't make tasks yet. Star it to get tasks for the problems here.</div>` : ""}
      </div>
      <div class="seo-card">${detailHtml(M, M.nodes[ui.node])}</div>
      ${M.table.length ? `<div class="seo-card"><h3>Who Google shows for these searches</h3>
        <table class="seo-w-mini seo-c-tab"><thead><tr><th>Search</th><th>Impr.</th><th>Shows now</th><th>Should be</th><th></th></tr></thead>
        <tbody>${M.table.map((r) => `<tr><td>${h.esc(r.q)}</td><td>${h.fmtInt(r.tot)}</td>
          <td>${h.esc(short(r.now.n.title, 34))} <span class="seo-note">pos ${h.fmtPos(r.now.pos === 999 ? null : r.now.pos)}</span></td>
          <td>${h.esc(short(r.owner.title, 34))}</td>
          <td><span class="seo-pr-pill is-${r.status === "right" ? "green" : "red"}">${r.status === "right" ? "right page" : r.status === "split" ? "split" : "wrong page"}</span></td></tr>`).join("")}</tbody></table>
        <p class="seo-note" style="margin-top:6px">“Should be” is the main page, unless a supporting page is clearly about that search. Wrong and split rows are where clicks are lost.</p></div>` : ""}
      <p class="seo-note">${w.cpagesAt ? `Pages in clusters were last read ${h.esc(when(w.cpagesAt))}.` : "Pages in clusters are read each morning."}
        ${notPri ? "" : "Problems here become a “Tidy the cluster” task on the main page, checked on the website each night."}</p>`;
  }

  function when(t) {
    const d = t?.toDate ? t.toDate() : t ? new Date(t) : null;
    return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
  }

  function draw() {
    const list = clustersOf(w);
    lastSugg = suggestions();
    const cl = current();
    if (cl && !ui.draft) ui.sel = cl.id;
    const used = new Set(list.map((x) => npath(x.main)));
    const newOpts = prioritySettings(w).paths.filter((p) => !used.has(npath(p)) && !taken().has(npath(p)));
    wrap.innerHTML = `
      <div class="seo-row">
        <button class="seo-btn" type="button" data-pview="table">All pages</button>
        <button class="seo-btn on" type="button" data-pview="clusters">Clusters</button>
        <span class="seo-sp"></span>
        ${admin && newOpts.length ? `<select class="seo-input seo-c-new" data-c-newmain aria-label="Main page for a new cluster">
          <option value="">New cluster for…</option>${newOpts.map((p) => `<option value="${h.esc(p)}">${h.esc(short(tOf(p), 50))}</option>`).join("")}</select>` : ""}
      </div>
      <p class="seo-note">A cluster is one main page, where people should land and book, and the pages that support it by answering narrower questions and linking to it.</p>
      ${list.length ? `<div class="seo-row">${list.map((x) => `<button class="seo-w-chip ${!ui.draft && cl && x.id === cl.id ? "is-on" : ""}" type="button"
        data-c-sel="${h.esc(x.id)}">${h.esc(x.name || short(tOf(x.main), 30))} <em>${x.pages.length + 1}</em></button>`).join("")}</div>` : ""}
      ${lastSugg.length && !ui.draft ? `<div class="seo-card seo-c-sugg">
          <div class="seo-row" style="margin:0 0 4px"><h3 style="margin:0">Suggested clusters</h3>
            <span class="seo-note">Priority pages with other pages about the same thing</span></div>
          ${lastSugg.map((s, i) => `<div class="seo-c-srow"><div style="min-width:0"><strong>${h.esc(s.name)}</strong>
              <span class="seo-note">${plural(s.pages.length + 1, "page")}${s.shared ? ` · ${plural(s.shared, "shared search")}` : ""}</span>
              <div class="seo-note seo-path">Main page: ${h.esc(tOf(s.main))}</div></div>
            <button class="seo-btn" type="button" data-c-review="${i}">Review</button></div>`).join("")}</div>` : ""}
      ${cl ? clusterHtml(cl) : `<div class="seo-empty">${lastSugg.length ? "Review a suggested cluster above to start."
        : admin ? "No clusters yet. Start one with “New cluster for…”." : "No clusters yet. Admins can create them."}</div>`}`;
  }

  /* ----- saving (admins) ----- */

  async function save(list, logs) {
    const clean = list.slice(0, MAX_CLUSTERS).map((x) => ({
      id: x.id || newId(), name: String(x.name || "").slice(0, 80), main: x.main,
      pages: x.pages.slice(0, MAX_MEMBERS).map((p) => ({ path: p.path, role: p.role === "merge" ? "merge" : "sup" })),
    }));
    await setDoc(doc(db, "seo_settings", "main"), { clusters: clean, updatedBy: auth.currentUser?.uid || "", updatedAt: serverTimestamp() }, { merge: true });
    w.settings = { ...(w.settings || {}), clusters: clean };
    if (logs && logs.length) logPriority(c, logs);
  }

  async function change(fn) {
    const cl = current();
    if (!cl) return;
    const copy = { ...cl, pages: cl.pages.map((p) => ({ ...p })) };
    const note = fn(copy);
    if (note === false) return;
    if (ui.draft) { ui.draft = copy; draw(); return; }
    try {
      await save(clustersOf(w).map((x) => (x.id === copy.id ? copy : x)), note ? [{ path: copy.main, note: `cluster “${copy.name}”: ${note}` }] : []);
      ui.sel = copy.id;
      toast("Saved");
    } catch (e) { toast(/permission/i.test(e.message || "") ? "Only admins can change clusters." : e.message, true); }
    draw();
  }

  wrap.onclick = async (e) => {
    const nodeEl = e.target.closest("[data-c-node]");
    if (nodeEl) { ui.node = +nodeEl.dataset.cNode; draw(); return; }
    const t = e.target.closest("button");
    if (!t || t.dataset.open !== undefined || t.dataset.pview !== undefined) return;   // seo.js handles these
    const d = t.dataset;
    if (d.cSel) { ui.sel = d.cSel; ui.node = 0; ui.adding = false; draw(); return; }
    if (d.cReview !== undefined) {
      const s = lastSugg[+d.cReview];
      if (!s) return;
      ui.draft = { id: newId(), name: s.name, main: s.main, pages: s.pages.map((p) => ({ path: p, role: "sup" })) };
      ui.node = 0; ui.adding = false;
      draw();
      return;
    }
    if (d.cCancel !== undefined) { ui.draft = null; ui.node = 0; draw(); return; }
    if (d.cAdding !== undefined) { ui.adding = !ui.adding; ui.find = ""; draw(); wrap.querySelector("[data-c-find]")?.focus(); return; }
    if (!admin) return;

    const cl = current();
    const nd = cl ? (ui.node === 0 ? cl.main : cl.pages[ui.node - 1]?.path) : "";
    if (d.cAdd) {
      change((x) => {
        if (x.pages.length >= MAX_MEMBERS) { toast(`A cluster can have up to ${MAX_MEMBERS + 1} pages.`, true); return false; }
        x.pages.push({ path: d.cAdd, role: "sup" });
        return `added ${d.cAdd} as a supporting page`;
      });
      return;
    }
    if (d.cRole) {
      change((x) => {
        const p = x.pages.find((y) => npath(y.path) === npath(nd));
        if (!p) return false;
        p.role = d.cRole;
        return `${nd} marked “${d.cRole === "merge" ? "merge into main" : "supporting"}”`;
      });
      return;
    }
    if (d.cRemove !== undefined) {
      change((x) => { x.pages = x.pages.filter((y) => npath(y.path) !== npath(nd)); ui.node = 0; return `took ${nd} out`; });
      return;
    }
    if (d.cMain !== undefined) {
      change((x) => {
        const old = x.main;
        x.pages = x.pages.filter((y) => npath(y.path) !== npath(nd)).concat([{ path: old, role: "sup" }]);
        x.main = nd;
        ui.node = 0;
        return `made ${nd} the main page (was ${old})`;
      });
      return;
    }
    if (d.cRename !== undefined) {
      const v = prompt("Name for this cluster", cl.name || "");
      if (v === null || !v.trim()) return;
      change((x) => { x.name = v.trim().slice(0, 80); return `renamed to “${x.name}”`; });
      return;
    }
    if (d.cDelete !== undefined) {
      if (!confirm(`Delete the cluster “${cl.name}”? The pages stay as they are; only the grouping goes.`)) return;
      try {
        await save(clustersOf(w).filter((x) => x.id !== cl.id), [{ path: cl.main, note: `deleted the cluster “${cl.name}”` }]);
        ui.sel = ""; ui.node = 0;
        toast("Cluster deleted");
      } catch (e2) { toast(e2.message, true); }
      draw();
      return;
    }
    if (d.cSavedraft !== undefined) {
      const dr = ui.draft;
      try {
        await save(clustersOf(w).concat([dr]), [{ path: dr.main, note: `cluster “${dr.name}” created with ${plural(dr.pages.length + 1, "page")}` }]);
        ui.sel = dr.id; ui.draft = null; ui.node = 0;
        toast("Cluster saved");
      } catch (e2) { toast(/permission/i.test(e2.message || "") ? "Only admins can change clusters." : e2.message, true); }
      draw();
      return;
    }
    if (d.cDismiss !== undefined) {
      const list = [...new Set([...(w.settings?.clusterDismissed || []), ui.draft.main])].slice(-100);
      try {
        await setDoc(doc(db, "seo_settings", "main"), { clusterDismissed: list, updatedBy: auth.currentUser?.uid || "", updatedAt: serverTimestamp() }, { merge: true });
        w.settings = { ...(w.settings || {}), clusterDismissed: list };
        ui.draft = null;
        toast("It won't be suggested again");
      } catch (e2) { toast(e2.message, true); }
      draw();
    }
  };

  wrap.onchange = (e) => {
    const t = e.target;
    if (t.matches("[data-c-newmain]") && t.value && admin) {
      const main = t.value;
      ui.draft = { id: newId(), name: clusterName(main), main, isNew: true,
        pages: candidatesFor(main, taken()).map((x) => ({ path: x.path, role: "sup" })) };
      ui.node = 0; ui.adding = false;
      draw();
    }
  };

  wrap.oninput = (e) => {
    if (!e.target.matches("[data-c-find]")) return;
    ui.find = e.target.value;
    const box = wrap.querySelector("[data-c-res]");
    if (box) box.innerHTML = resHtml();
  };

  wrap.onkeydown = (e) => {
    const g = e.target.closest?.("[data-c-node]");
    if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); ui.node = +g.dataset.cNode; draw(); }
  };

  draw();
}

/* ---------- styles ---------- */

const CSS = `
.seo-c-new{min-width:0;max-width:280px}
.seo-c-sugg{background:#fffdf5;border-color:#fde68a}
.seo-c-srow{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-c-srow > div{flex:1}
.seo-c-svg{display:block;width:100%;height:auto;margin:4px 0}
.seo-c-node{cursor:pointer;outline:none}
.seo-c-node circle{stroke-width:1.5}
.seo-c-node.is-main circle{fill:#fef3c7;stroke:#d97706}
.seo-c-node.is-sup circle{fill:#dbeafe;stroke:#3b82f6}
.seo-c-node.is-merge circle{fill:#f1f5f9;stroke:#94a3b8;stroke-dasharray:4 3}
.seo-c-node.is-beats circle{stroke:#dc2626;stroke-width:3}
.seo-c-node.is-sel circle{stroke-width:4}
.seo-c-node:hover circle,.seo-c-node:focus circle{stroke-width:4}
.seo-c-node .n{font-size:12px;font-weight:700;fill:#0f172a}
.seo-c-node .l{font-size:11px;fill:#475569}
.seo-c-node.is-main .l{font-weight:700;fill:#0f172a}
.seo-c-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-c-legend i{display:inline-block;width:22px;height:0;margin-right:6px;vertical-align:middle;border-top:2px solid #16a34a}
.seo-c-legend i.miss{border-top:2px dashed #dc2626}
.seo-c-legend i.unk{border-top:2px dashed #94a3b8}
.seo-c-dt{margin:6px 0 2px;font-size:16px}
.seo-c-issues{margin:8px 0 0;padding:0;list-style:none;font-size:13px}
.seo-c-issues li{padding:3px 0 3px 22px;position:relative}
.seo-c-issues li::before{position:absolute;left:0;font-weight:700}
.seo-c-issues li.is-ok::before{content:"✓";color:#16a34a}
.seo-c-issues li.is-bad::before{content:"✕";color:#dc2626}
.seo-c-issues li.is-warn::before{content:"!";color:#d97706}
.seo-c-issues li.is-unk::before{content:"?";color:#94a3b8}
.seo-c-advice{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:#f8fafc;font-size:13px;line-height:1.45}
.seo-c-pick{margin:6px 0 8px}
.seo-c-pick .seo-input{width:100%;min-width:0;box-sizing:border-box}
.seo-c-res{display:flex;flex-direction:column;align-items:flex-start;width:100%;margin-top:4px;padding:6px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--card,#fff);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.seo-c-res:hover{border-color:var(--accent,#2563eb);background:#eff6ff}
.seo-c-tab td{vertical-align:top}
.seo-pr-pill.is-blue{background:#eff6ff;color:#1d4ed8}
`;

function injectCss() {
  if (document.getElementById("seo-clusters-css")) return;
  const s = document.createElement("style");
  s.id = "seo-clusters-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}