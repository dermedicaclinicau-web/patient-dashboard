// seo-priority.js — Priority pages (★)
// The Key pages list (seo_settings/main.keyPages, which Site health in Seo3.gs checks every night), with details per page:
// seo_settings/main.priorityInfo = [{ path, target, goal, support, note, by, at }]. Only admins change them.

import { db, auth } from "./firebase-config.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// Must be exactly the same address seo.js imports seo-work.js from, or the browser loads it twice
import { npath, pageStory, prioritySettings, priorityOf, suggestPriority, titleOf, logPriority, pageOf } from "./seo-work.js?v=15";

const MAX = 50;   // priority pages (Site health checks them all each night)
export const GOALS = [["top3", "Top 3", 3], ["top5", "Top 5", 5], ["page1", "Page 1", 10], ["", "No goal", null]];
const goalOf = (k) => GOALS.find((g) => g[0] === (k || "")) || GOALS[3];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

export function prToast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}

export const isPriorityPath = (w, path) => !!priorityOf(w, path);

// ☆ / ★ next to a page name. Admins can click it; everyone else only sees ★ on priority pages.
export function starHtml(c, path) {
  injectCss();
  const on = isPriorityPath(c.work, path);
  if (!c.isAdmin) return on ? `<span class="seo-star is-on" title="Priority page">★</span>` : "";
  return `<button type="button" class="seo-star${on ? " is-on" : ""}" data-star="${esc(path)}" aria-pressed="${on}"
    title="${on ? "Priority page. Click to unstar" : "Star as a priority page"}">${on ? "★" : "☆"}</button>`;
}

/* ---------- saving ---------- */

async function save(c, paths, info) {
  const keyPages = [...new Map(paths.map((p) => [npath(p), p])).values()].slice(0, MAX);
  const keep = new Set(keyPages.map(npath));
  const seen = new Set();
  const priorityInfo = info.filter((x) => {
    const k = npath(x.path);
    if (!keep.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await setDoc(doc(db, "seo_settings", "main"),
    { keyPages, priorityInfo, updatedBy: auth.currentUser?.uid || "", updatedAt: serverTimestamp() },
    { mergeFields: ["keyPages", "priorityInfo", "updatedBy", "updatedAt"] });
  c.work.settings = { ...(c.work.settings || {}), keyPages, priorityInfo };
}
const suggest = (c, path) => suggestPriority(c.work, c.data, path);

// true = starred, false = unstarred, null = nothing changed
export async function toggleStar(c, path) {
  const { paths, info } = prioritySettings(c.work);
  if (paths.some((x) => npath(x) === npath(path))) {
    if (!confirm(`Unstar ${path}?\n\nIt stops being a priority page, and Site health stops checking it every night.`)) return null;
    await save(c, paths.filter((x) => npath(x) !== npath(path)), info);
    logPriority(c, [{ path, note: "removed from priority pages" }]);
    prToast("Unstarred");
    return false;
  }
  if (paths.length >= MAX) { prToast(`You can star up to ${MAX} pages. Unstar one first.`, true); return null; }

  let list = paths.slice();
  if (!list.length) {
    // Until now Site health checked the home page and the 15 busiest pages by itself
    const busy = ["/", ...c.data.pages.filter((p) => p.m28.clicks > 0).sort((a, b) => b.m28.clicks - a.m28.clicks).map((p) => p.path)];
    const auto = [...new Map(busy.map((p) => [npath(p), p])).values()].slice(0, 16);
    if (confirm(`Site health checks your home page and 15 busiest pages until you choose your own. Once you star a page, it checks only starred pages.\n\nStar those ${auto.length} pages too, so they keep being checked? You can unstar any of them later.`)) list = auto;
  }
  if (!list.some((x) => npath(x) === npath(path))) list.push(path);
  const now = new Date().toISOString(), by = auth.currentUser?.uid || "";
  const added = list.filter((x) => !info.some((i) => npath(i.path) === npath(x)))
    .map((x) => ({ path: x, ...suggest(c, x), note: "", by, at: now }));
  await save(c, list.slice(0, MAX), info.concat(added));
  const had = new Set(paths.map(npath));
  logPriority(c, list.slice(0, MAX).filter((p) => !had.has(npath(p)))
    .map((p) => ({ path: p, note: `added as priority page #${list.indexOf(p) + 1}` })));
  prToast(!paths.length && list.length > 1 ? `Starred ${list.length} pages` : "Starred. Check its target search in the page's panel.");
  return true;
}

export async function savePriorityDetails(c, path, v) {
  const { paths, info } = prioritySettings(c.work);
  const hit = paths.find((x) => npath(x) === npath(path));
  if (!hit) throw new Error("This page isn't starred any more.");
  let support = String(v.support || "").trim().replace(/^https?:\/\/[^/]+/i, "").split("#")[0];
  if (support && !support.startsWith("/")) support = "/" + support;
  if (support && npath(support) === npath(hit)) support = "";
  const entry = {
    path: hit,
    target: String(v.target || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120),
    goal: goalOf(v.goal)[0],
    support: support.slice(0, 300),
    note: String(v.note || "").trim().slice(0, 300),
    by: auth.currentUser?.uid || "", at: new Date().toISOString(),
  };
  await save(c, paths, info.filter((x) => npath(x.path) !== npath(hit)).concat([entry]));
  logPriority(c, [{ path: hit, note: (entry.target ? `set the target search to “${entry.target}”` : "cleared the target search") +
    (entry.goal ? `, goal ${goalOf(entry.goal)[1]}` : "") + (entry.support ? `, supporting page ${entry.support}` : "") }]);
}

/* ---------- how each priority page is doing (last 28 days vs the 28 before) ---------- */

function cause(w, p) {
  const s = pageStory(w, p);
  if (s.seen >= 0) return "";
  const top = Object.entries(s.b).sort((a, b) => a[1] - b[1])[0];
  if (!top || top[1] > -1) return "";
  if (top[0] === "shift") {
    const t = [...s.shiftBy.entries()].sort((a, b) => a[1] - b[1])[0];
    return t ? `${t[0]} is taking its clicks` : "another page is taking its clicks";
  }
  return { demand: "fewer people are searching", rank: "it's ranking lower", ctr: "fewer people are clicking" }[top[0]] || "";
}

export function priorityRows(c) {
  const w = c.work, h = c.h;
  const { paths } = prioritySettings(w);
  const hasPrev = w.queries.some((q) => q.ppages);
  const order = { red: 0, amber: 1, grey: 2, green: 3 };
  return paths.map((path) => {
    const pr = priorityOf(w, path), me = npath(path);
    const p = pageOf(c.data, path);
    const hp = (w.health?.pages || []).find((x) => npath(x.path) === me) || null;
    const tq = pr.target ? w.queries.find((q) => q.q.toLowerCase() === pr.target.toLowerCase()) || null : null;
    const now = tq ? tq.pages.find((x) => npath(x.path) === me) || null : null;
    const was = tq ? (tq.ppages || []).find((x) => npath(x.path) === me) || null : null;
    const other = tq && tq.pages[0] && npath(tq.pages[0].path) !== me ? tq.pages[0] : null;
    const pos = now?.pos ?? null, ppos = was?.pos ?? null;
    const [, goalLabel, goalMax] = goalOf(pr.goal);
    const goalMet = goalMax == null || !pr.target ? null : pos != null && pos <= goalMax;
    const g = hp?.google;
    const issues = (hp?.issues || []).filter((i) => i.status !== "ignored" && (i.sev === "high" || i.sev === "medium"));
    const lost = p ? p.prev28.clicks - p.m28.clicks : 0;

    let tone = "green", label = "On track";
    const why = [];
    if (!p) { tone = "grey"; label = "No data yet"; why.push("No Google search data for this page in the last 28 days."); }
    if (g && !g.err && g.v !== "PASS") {
      tone = "red"; label = "Not in Google"; why.push(g.cs || "Google hasn't indexed it.");
    } else if (p && ((lost >= 10 && p.m28.clicks <= p.prev28.clicks * 0.85) || (pos != null && ppos != null && pos - ppos >= 1))) {
      tone = "red"; label = "Dropping";
      const cz = hasPrev ? cause(w, p) : "";
      why.push(cz ? cz.charAt(0).toUpperCase() + cz.slice(1) + "." : "Clicks or position are down.");
    } else if (p) {
      if (goalMet === false) {
        why.push(pos == null ? `Not showing for “${pr.target}” yet (goal: ${goalLabel}).`
          : `Position ${h.fmtPos(pos)} for the target search (goal: ${goalLabel}).`);
      }
      if (other) why.push(`${other.path} shows for the target search more than this page.`);
      if (issues.length) why.push(`${issues.length} Site health issue${issues.length === 1 ? "" : "s"} to fix.`);
      if (why.length) { tone = "amber"; label = "Needs work"; }
    }
    if (p && tone !== "grey") {
      const bw = bounceWhy(p);
      if (bw) { why.push(bw); if (tone === "green") { tone = "amber"; label = "Needs work"; } }
    }
    if (!hp && !why.length) why.push("Site health checks it from the next nightly run.");
    return { path, pr, p, pos, ppos, goalLabel, goalMax, goalMet, tone, label, why, rank: order[tone] };
  }).sort((a, b) => a.rank - b.rank || (b.p?.m28.clicks || 0) - (a.p?.m28.clicks || 0));
}

const pill = (r) => `<span class="seo-pr-pill is-${r.tone}">${esc(r.label)}</span>`;

// High bounce rate (Seo12.gs engagement, last 28 days): a reason, or ""
function bounceWhy(p) {
  const e = p && p.eng;
  if (!e || e.c[0] < 20) return "";
  const b = 1 - e.c[1] / e.c[0];
  if (b <= 0.65) return "";
  const mob = e.m[0] >= 10 ? 1 - e.m[1] / e.m[0] : null;
  const desk = e.d[0] >= 10 ? 1 - e.d[1] / e.d[0] : null;
  return `High bounce: ${Math.round(b * 100)}% of Google visitors leave straight away${
    mob != null && desk != null && mob - desk >= 0.1 ? ` (${Math.round(mob * 100)}% on phones)` : ""}.`;
}

/* ---------- Overview card ---------- */

// opt: { open, filter: '' | 'red' | 'amber' | 'green' | 'grey', all }
export function priorityCardHtml(c, opt = {}) {
  injectCss();
  const h = c.h;
  const rows = priorityRows(c);
  if (!rows.length) {
    return c.isAdmin ? `<div class="seo-card"><h3>★ Priority pages</h3>
      <p class="seo-note">Star (☆) the pages that matter most, like your main treatment pages, in the Pages tab or a page's panel.
        They show here with how they're doing, appear first across SEO, and Site health checks them every night.</p></div>` : "";
  }
  const open = !!opt.open, f = opt.filter || "";
  const num = new Map(prioritySettings(c.work).paths.map((p, i) => [npath(p), i + 1]));
  const n = (t) => rows.filter((r) => r.tone === t).length;
  const pill = (t, label) => (n(t) ? `<button type="button" class="seo-pr-pill is-${t} seo-pr-fbtn${f === t ? " is-on" : ""}" data-prf="${t}"
      title="${f === t ? "Show all" : "Show only these"}">${n(t)} ${label}</button>` : "");
  const head = `<div class="seo-row seo-pr-head">
      <button type="button" class="seo-pr-tog" data-prtoggle aria-expanded="${open}"><span class="seo-pr-car">${open ? "▾" : "▸"}</span>★ Priority pages</button>
      ${pill("red", "dropping or not in Google")}${pill("amber", "need work")}${pill("green", "on track")}${pill("grey", "no data yet")}
      <span class="seo-sp"></span><span class="seo-note">Last 28 days vs the 28 before</span></div>`;

  if (!open) {
    const urgent = rows.filter((r) => r.tone === "red").slice(0, 3);
    return `<div class="seo-card seo-pr-card">${head}
      ${urgent.length ? `<div class="seo-pr-mini"><span class="seo-note">Most urgent:</span> ${urgent.map((r) => r.p
        ? `<button type="button" class="seo-w-link" data-open="${esc(r.p.id)}">${esc(titleOf(c.work, c.data, r.path))}</button>`
        : esc(titleOf(c.work, c.data, r.path))).join(`<span class="seo-note"> · </span>`)}</div>` : ""}</div>`;
  }

  const list = f ? rows.filter((r) => r.tone === f) : rows;
  const shown = opt.all ? list : list.slice(0, 10);
  const posCell = (r) => {
    if (!r.pr.target) return c.isAdmin ? `<span class="seo-note">Set a target</span>` : "—";
    if (r.pos == null) return `<span class="seo-note">not showing</span>`;
    return `${h.fmtPos(r.pos)} ${h.delta(r.pos, r.ppos, { invert: true, abs: true })}${
      r.goalMax ? `<div class="seo-note">${r.goalMet ? "✓ " : "goal: "}${h.esc(r.goalLabel)}</div>` : ""}`;
  };
  return `<div class="seo-card seo-pr-card">${head}
    ${f ? `<p class="seo-note" style="margin:0 0 6px">Showing only these ${list.length}. Click the label again to see all.</p>` : ""}
    <div class="seo-table-wrap" style="max-height:none"><table class="seo-table seo-pr-t">
      <thead><tr><th>Page</th><th>Target search</th><th>Position</th><th>Clicks</th><th>12 weeks</th><th>Status</th></tr></thead>
      <tbody>${shown.map((r) => `<tr${r.p ? ` data-open="${esc(r.p.id)}"` : ""}>
        <td><div class="seo-path" title="${esc(r.path)}"><span class="seo-pr-num">#${num.get(npath(r.path)) || "–"}</span>${esc(titleOf(c.work, c.data, r.path))}</div>
          <div class="seo-note seo-path">${esc(r.path)}</div>
          ${r.pr.note ? `<div class="seo-pr-why">${esc(r.pr.note)}</div>` : ""}</td>
        <td>${r.pr.target ? esc(r.pr.target) : "—"}</td>
        <td>${posCell(r)}</td>
        <td>${r.p ? `${h.fmtInt(r.p.m28.clicks)} ${h.delta(r.p.m28.clicks, r.p.prev28.clicks)}` : "—"}</td>
        <td>${r.p && Array.isArray(r.p.weekly) ? h.sparkline(r.p.weekly) : ""}</td>
        <td>${pill2(r)}${r.why.length ? `<div class="seo-pr-why">${esc(r.why.join(" "))}</div>` : ""}</td>
      </tr>`).join("")}</tbody></table></div>
    ${list.length > 10 ? `<div class="seo-pr-more"><button class="seo-btn" type="button" data-prall>${opt.all ? "Show fewer" : `Show all ${list.length}`}</button></div>` : ""}
  </div>`;
}
const pill2 = (r) => `<span class="seo-pr-pill is-${r.tone}">${esc(r.label)}</span>`;


/* ---------- Page panel ---------- */

export function panelPriorityHtml(c, p, editing) {
  injectCss();
  const h = c.h, w = c.work;
  const pr = priorityOf(w, p.path);
  if (!pr) {
    return c.isAdmin ? `<div class="seo-pr-box is-off">
      <button class="seo-btn" type="button" data-star="${esc(p.path)}">☆ Star as a priority page</button>
      <span class="seo-note">Shown first across SEO, and checked by Site health every night.</span></div>` : "";
  }
  if (editing && c.isAdmin) return formHtml(c, p, pr);
  const row = priorityRows(c).find((r) => npath(r.path) === npath(p.path));
  const sid = pr.support ? h.idOf?.(pr.support) : "";
  return `<div class="seo-pr-box">
    <div class="seo-row" style="margin:0">
      <strong>★ Priority page</strong>${row ? pill(row) : ""}<span class="seo-sp"></span>
      ${c.isAdmin ? `<button class="seo-btn" type="button" data-pedit="${esc(p.path)}">Edit</button>
        <button class="seo-btn" type="button" data-star="${esc(p.path)}">Unstar</button>` : ""}
    </div>
    <dl class="seo-pr-dl">
      <dt>Target search</dt><dd>${pr.target ? `“${esc(pr.target)}”` : `<span class="seo-note">Not set</span>`}</dd>
      <dt>Goal</dt><dd>${esc(goalOf(pr.goal)[1])}${row && row.pos != null && pr.target ? ` · now ${h.fmtPos(row.pos)}` : ""}</dd>
      <dt>Supporting page</dt><dd>${pr.support
        ? (sid ? `<button class="seo-w-link" data-open="${esc(sid)}">${esc(pr.support)}</button>` : esc(pr.support))
        : `<span class="seo-note">None</span>`}</dd>
      ${pr.note ? `<dt>Note</dt><dd>${esc(pr.note)}</dd>` : ""}
    </dl>
    ${row && row.why.length ? `<p class="seo-note" style="margin:6px 0 0">${esc(row.why.join(" "))}</p>` : ""}
  </div>`;
}

function formHtml(c, p, pr) {
  const w = c.work, me = npath(p.path);
  const qs = w.queries.filter((q) => q.topic !== "__brand")
    .map((q) => ({ q: q.q, x: q.pages.find((y) => npath(y.path) === me) }))
    .filter((r) => r.x).sort((a, b) => b.x.i - a.x.i).slice(0, 15);
  const pages = c.data.pages.filter((x) => npath(x.path) !== me && x.m28.impressions > 0)
    .sort((a, b) => b.m28.clicks - a.m28.clicks).slice(0, 200);
  return `<div class="seo-pr-box seo-pr-form">
    <strong>★ Priority page details</strong>
    <label>Target search <small>(the search this page should win)</small>
      <input class="seo-input" data-pf="target" list="seo-pr-q" maxlength="120" value="${esc(pr.target)}" placeholder="e.g. neck pigmentation perth"></label>
    <datalist id="seo-pr-q">${qs.map((r) => `<option value="${esc(r.q)}">${c.h.fmtInt(r.x.i)} impressions · pos ${c.h.fmtPos(r.x.pos)}</option>`).join("")}</datalist>
    <label>Goal
      <select class="seo-input" data-pf="goal">${GOALS.map(([k, l]) => `<option value="${k}"${(pr.goal || "") === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
    <label>Supporting page <small>(e.g. the guide that should link here)</small>
      <input class="seo-input" data-pf="support" list="seo-pr-p" maxlength="300" value="${esc(pr.support)}" placeholder="/neck-pigmentation-treatment-guide/"></label>
    <datalist id="seo-pr-p">${pages.map((x) => `<option value="${esc(x.path)}">`).join("")}</datalist>
    <label>Note <small>(why it matters)</small>
      <textarea class="seo-input" data-pf="note" rows="2" maxlength="300">${esc(pr.note)}</textarea></label>
    <p class="seo-note" style="margin:6px 0 0">Don't use prescription medicine names as the target search: the Action plan won't put them in titles or headings.</p>
    <div class="seo-w-acts">
      <button class="seo-btn on" type="button" data-psave="${esc(p.path)}">Save</button>
      <button class="seo-btn" type="button" data-pcancel>Cancel</button>
    </div>
  </div>`;
}

/* ---------- styles ---------- */

const CSS = `
.seo-star{border:0;background:none;padding:0 5px 0 0;font:inherit;font-size:15px;line-height:1;color:#cbd5e1;cursor:pointer;vertical-align:-1px}
.seo-star:hover{color:#f59e0b}
.seo-star.is-on{color:#f59e0b}
span.seo-star{cursor:default}
.seo-pr-t th,.seo-pr-t td{text-align:left;vertical-align:top}
.seo-pr-head{margin:0 0 8px;gap:6px}
.seo-pr-card .seo-pr-head:last-child{margin-bottom:0}
.seo-pr-tog{display:inline-flex;align-items:center;gap:6px;padding:2px 6px 2px 0;border:0;background:none;color:inherit;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
.seo-pr-car{display:inline-block;width:14px;color:var(--text-muted,#6b7280)}
.seo-pr-fbtn{border:1px solid transparent;font:inherit;font-size:11px;font-weight:600;cursor:pointer}
.seo-pr-fbtn:hover{filter:brightness(.96)}
.seo-pr-fbtn.is-on{border-color:currentColor}
.seo-pr-mini{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;font-size:13px}
.seo-pr-num{display:inline-block;min-width:26px;margin-right:4px;font-size:12px;font-weight:700;color:#b45309}
.seo-pr-more{padding:10px 0 0;text-align:center}
.seo-pr-t td:first-child{white-space:normal}
.seo-pr-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
.seo-pr-pill.is-red{background:#fef2f2;color:#b91c1c}
.seo-pr-pill.is-amber{background:#fffbeb;color:#b45309}
.seo-pr-pill.is-green{background:#ecfdf5;color:#047857}
.seo-pr-pill.is-grey{background:#f1f5f9;color:#475569}
.seo-pr-why{margin-top:3px;max-width:300px;font-size:12px;line-height:1.4;white-space:normal;color:var(--text-muted,#6b7280)}
.seo-pr-box{margin:12px 0;padding:10px 12px;border:1px solid #fcd34d;border-radius:10px;background:#fffbeb;font-size:13px}
.seo-pr-box.is-off{display:flex;align-items:center;flex-wrap:wrap;gap:8px;border-color:var(--border,#e5e7eb);background:#f8fafc}
.seo-pr-dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:4px 10px;margin:8px 0 0}
.seo-pr-dl dt{color:var(--text-muted,#6b7280)}
.seo-pr-dl dd{margin:0;word-break:break-word}
.seo-pr-form label{display:flex;flex-direction:column;gap:3px;margin:8px 0 0;font-size:12px;font-weight:600;color:var(--text-muted,#6b7280)}
.seo-pr-form label small{font-weight:400}
.seo-pr-form .seo-input{width:100%;min-width:0;box-sizing:border-box;font-weight:400;color:var(--text,#1e293b)}
`;

function injectCss() {
  if (document.getElementById("seo-priority-css")) return;
  const s = document.createElement("style");
  s.id = "seo-priority-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}