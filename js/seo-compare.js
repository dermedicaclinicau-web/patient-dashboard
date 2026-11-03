// seo-compare.js — Trend card: head to head for 2 pages. Which one to keep when they compete.
// Uses data the portal already has: daily page numbers, search data (28 days), GA4 per page (28 days), WordPress,
// Site health, content checks (duplicates, links in), priority pages and clusters.

import { titleOf } from "./seo-work.js?v=16";

const key = (p) => {
  let s = String(p || "").trim().replace(/^https?:\/\/[^/]+/i, "").split("#")[0].split("?")[0];
  try { s = decodeURIComponent(s); } catch { /* as is */ }
  if (!s.startsWith("/")) s = "/" + s;
  return s.replace(/\/+$/, "").toLowerCase() || "/";
};
const short = (s, n = 38) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const fmtDay = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtMonth = (iso) => { const d = iso ? new Date(String(iso).slice(0, 10) + "T00:00:00Z") : null; return d && !isNaN(d) ? d.toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" }) : "—"; };

/** o: { a, b, r: { from, to }, colors, pageVal(pages, from, to, metric), hasPI } */
export function compareHtml(c, o) {
  injectCss();
  const h = c.h, esc = h.esc, w = c.work, D = c.data;

  const P = [o.a, o.b].map((path, i) => {
    const k = key(path);
    const pages = D.pages.filter((p) => key(p.path) === k);
    const best = pages.slice().sort((x, y) => (y.m28?.impressions || 0) - (x.m28?.impressions || 0))[0] || null;
    const sum = (f) => pages.reduce((a, p) => a + Number(p.m28?.[f] || 0), 0);
    const wp = (w.wp?.pages || []).find((x) => key(x.path || x.url || x.link || "") === k) || null;
    const deep = w.health?.content?.deep?.[k] || null;
    const hp = (w.health?.pages || []).find((x) => key(x.path) === k) || null;
    const priIdx = (w.settings?.keyPages || []).findIndex((x) => key(x) === k);
    const cl = (w.settings?.clusters || []).find((x) => x && x.main && (key(x.main) === k || (x.pages || []).some((p) => key(p.path) === k))) || null;
    return {
      k, path: best?.path || path, id: best?.id || "", color: o.colors[i], title: titleOf(w, D, path),
      clicks: o.pageVal(pages, o.r.from, o.r.to, "clicks"),
      impr: o.hasPI ? o.pageVal(pages, o.r.from, o.r.to, "impressions") : sum("impressions"),
      avgPos: best?.m28?.position ?? null,
      sessions: sum("sessions"), engaged: sum("engaged"), bookings: sum("conversions"),
      words: deep?.words || hp?.words || null, mod: wp?.mod || deep?.mod || "", inbound: deep ? deep.inbound ?? null : null,
      pri: priIdx >= 0 ? priIdx + 1 : null,
      role: cl ? (key(cl.main) === k ? "Main page" : (cl.pages || []).find((p) => key(p.path) === k)?.role === "merge" ? "Merge into main" : "Supporting") : "",
      cluster: cl?.name || "",
      target: (w.settings?.priorityInfo || []).find((x) => key(x.path) === k)?.target || "",
    };
  });
  const [A, B] = P;

  // Searches each page gets, and the ones they share (last 28 days, brand searches left out)
  const pick = (q, k) => {
    const m = (q.pages || []).filter((p) => key(p.path) === k);
    if (!m.length) return null;
    return { i: m.reduce((s, p) => s + (p.i || 0), 0), c: m.reduce((s, p) => s + (p.c || 0), 0), pos: m.slice().sort((x, y) => (y.i || 0) - (x.i || 0))[0].pos };
  };
  const shared = [], onlyB = [];
  let aTot = 0, bTot = 0, aSh = 0, bSh = 0;
  for (const q of w.queries || []) {
    if (q.topic === "__brand") continue;
    const a = pick(q, A.k), b = pick(q, B.k);
    if (a) aTot += a.i;
    if (b) bTot += b.i;
    if (a && b) { aSh += a.i; bSh += b.i; shared.push({ q: q.q, a, b, i: a.i + b.i }); }
    else if (b) onlyB.push({ q: q.q, i: b.i });
  }
  shared.sort((x, y) => y.i - x.i);
  const onlyA = aTot - aSh, onlyBi = bTot - bSh, all = onlyA + onlyBi + aSh + bSh || 1;
  const ovA = aTot ? aSh / aTot : 0, ovB = bTot ? bSh / bTot : 0, ov = Math.max(ovA, ovB);
  const dup = (w.health?.content?.dups || []).find((d) => { const x = key(d.a), y = key(d.b); return (x === A.k && y === B.k) || (x === B.k && y === A.k); });
  const sim = dup ? dup.sim : null;

  // The main search: a priority page's target search, or the biggest search they share
  const main = A.target || B.target || shared[0]?.q || "";
  const mainRow = main ? (w.queries || []).find((q) => String(q.q).toLowerCase() === main.toLowerCase()) : null;
  const mainA = mainRow ? pick(mainRow, A.k) : null, mainB = mainRow ? pick(mainRow, B.k) : null;

  // Which to keep: bookings first, then priority, then clicks
  const reasons = [];
  let keep;
  if (A.bookings !== B.bookings && Math.max(A.bookings, B.bookings) >= 1) {
    keep = A.bookings > B.bookings ? A : B;
    reasons.push(`“${short(keep.title)}” brings the bookings and enquiries (${keep.bookings} vs ${(keep === A ? B : A).bookings} in the last 28 days).`);
  } else if (!!A.pri !== !!B.pri) {
    keep = A.pri ? A : B;
    reasons.push(`“${short(keep.title)}” is priority page #${keep.pri}.`);
  } else if (A.clicks !== B.clicks) {
    keep = A.clicks > B.clicks ? A : B;
    reasons.push(`“${short(keep.title)}” gets more clicks (${h.fmtInt(keep.clicks)} vs ${h.fmtInt((keep === A ? B : A).clicks)}).`);
  } else keep = A;
  const other = keep === A ? B : A;
  const stay = (p) => (p.sessions >= 20 ? p.engaged / p.sessions : null);
  if (stay(keep) != null && stay(other) != null && stay(keep) > stay(other) + 0.05) {
    reasons.push(`It keeps visitors better (${Math.round(stay(keep) * 100)}% stay vs ${Math.round(stay(other) * 100)}%).`);
  }
  const otherBetter = shared.filter((r) => {
    const kp = keep === A ? r.a : r.b, op = keep === A ? r.b : r.a;
    return op.pos != null && (kp.pos == null || op.pos + 1 <= kp.pos);
  }).slice(0, 3).map((r) => r.q);

  const quiet = aTot + bTot < 150 && A.clicks + B.clicks < 10;
  const kind = quiet ? "data"
    : (ov >= 0.5 && (sim == null || sim >= 40)) || (sim != null && sim >= 60) ? "merge"
    : ov >= 0.2 || (sim != null && sim >= 40) ? "support" : "both";
  const overlapLine = shared.length
    ? `They share ${shared.length} search${shared.length === 1 ? "" : "es"}: ${Math.round(ovA * 100)}% of “${short(A.title, 30)}”'s impressions and ${Math.round(ovB * 100)}% of “${short(B.title, 30)}”'s.`
    : "They don't share any searches.";

  let vTitle, bullets = [], actions = "";
  const cluBtn = (role) => `<button class="seo-btn" type="button" data-cmpcl="${esc(keep.path)}|${esc(other.path)}|${role}">Set up in Clusters</button>`;
  const askBtn = (txt, label) => `<button class="seo-btn on" type="button" data-drask="${esc(txt)}">${label}</button>`;
  if (kind === "merge") {
    vTitle = `Suggested: keep “${short(keep.title)}”, merge “${short(other.title)}” into it`;
    bullets.push(overlapLine + (sim != null ? ` Their text is ${sim}% the same.` : ""), "When two pages chase the same searches, Google splits its attention and neither ranks as well as one strong page.", ...reasons);
    if (otherBetter.length) bullets.push(`“${short(other.title)}” ranks better for ${otherBetter.map((q) => `“${q}”`).join(", ")}: move those sections into the page you keep before redirecting.`);
    bullets.push(`Then redirect ${other.path} to ${keep.path} (301), so its links and history count for the page you keep.`);
    actions = askBtn(`Make a plan to merge “${other.title}” (${other.path}) into “${keep.title}” (${keep.path}): which sections to move across, the redirect, and drafts for anything that needs rewriting.`, "Ask the Advisor for a merge plan") + cluBtn("merge");
  } else if (kind === "support") {
    const own = onlyB.length && other === B ? onlyB.sort((x, y) => y.i - x.i).slice(0, 3).map((x) => x.q) : [];
    vTitle = `Suggested: keep both, make “${short(other.title)}” support “${short(keep.title)}”`;
    bullets.push(overlapLine + (sim != null ? ` Their text is ${sim}% the same.` : ""), ...reasons);
    if (own.length) bullets.push(`“${short(other.title)}” also answers its own questions (${own.map((q) => `“${q}”`).join(", ")}), so it's worth keeping.`);
    bullets.push(`Link “${short(other.title)}” to “${short(keep.title)}” near the top${main ? `, and take “${main}” out of its title` : ""}, so Google knows which page is the main one.`);
    actions = askBtn(`How should “${other.title}” (${other.path}) support “${keep.title}” (${keep.path}) without competing with it? Include title and heading changes, and where to link.`, "Ask the Advisor how") + cluBtn("sup");
  } else if (kind === "both") {
    vTitle = "They don't really compete";
    bullets.push(overlapLine, "Each page gets mostly its own searches. Keep both as they are, and link between them where it helps visitors.");
    actions = askBtn(`Compare “${A.title}” (${A.path}) and “${B.title}” (${B.path}): what should we improve on each?`, "Ask the Advisor about both");
  } else {
    vTitle = "Not enough data yet to judge";
    bullets.push("These pages get very few searches so far. Check again in a few weeks, or compare them by content in Site health.");
    actions = askBtn(`Compare “${A.title}” (${A.path}) and “${B.title}” (${B.path}): do they overlap, and what should we do with each?`, "Ask the Advisor about both");
  }

  // Scorecard: [label, A, B, which is better: 'hi' | 'lo' | '' , raw A, raw B]
  const rate = (p) => (stay(p) == null ? "—" : Math.round(stay(p) * 100) + "%");
  const rows = [
    [`Clicks <span class="seo-note">${esc(fmtDay(o.r.from))} – ${esc(fmtDay(o.r.to))}</span>`, h.fmtInt(A.clicks), h.fmtInt(B.clicks), "hi", A.clicks, B.clicks],
    [`Impressions${o.hasPI ? "" : ` <span class="seo-note">last 28 days</span>`}`, h.fmtInt(A.impr), h.fmtInt(B.impr), "hi", A.impr, B.impr],
    ...(main ? [[`Position for “${esc(short(main, 30))}”`, h.fmtPos(mainA?.pos ?? null), h.fmtPos(mainB?.pos ?? null), "lo", mainA?.pos ?? null, mainB?.pos ?? null]] : []),
    [`Average position <span class="seo-note">last 28 days</span>`, h.fmtPos(A.avgPos), h.fmtPos(B.avgPos), "lo", A.avgPos, B.avgPos],
    [`Bookings and enquiries <span class="seo-note">GA4, 28 days</span>`, h.fmtInt(A.bookings), h.fmtInt(B.bookings), "hi", A.bookings, B.bookings],
    [`Visitors who stay <span class="seo-note">GA4, 28 days</span>`, rate(A), rate(B), "hi", stay(A), stay(B)],
    ["Words · last updated", `${A.words ? h.fmtInt(A.words) : "—"} · ${fmtMonth(A.mod)}`, `${B.words ? h.fmtInt(B.words) : "—"} · ${fmtMonth(B.mod)}`, "", null, null],
    ["Other pages linking in", A.inbound == null ? "—" : h.fmtInt(A.inbound), B.inbound == null ? "—" : h.fmtInt(B.inbound), "hi", A.inbound, B.inbound],
    ["Role", esc([A.pri ? `★ #${A.pri}` : "", A.role].filter(Boolean).join(" · ") || "—"), esc([B.pri ? `★ #${B.pri}` : "", B.role].filter(Boolean).join(" · ") || "—"), "", null, null],
  ];
  const win = (r, side) => {
    const [, , , dir, a, b] = r;
    if (!dir || a == null || b == null || a === b) return false;
    return dir === "hi" ? (side === "a" ? a > b : b > a) : (side === "a" ? a < b : b < a);
  };
  const head = (p) => `<span class="seo-cmp-pg"><i style="background:${p.color}"></i>${p.id
    ? `<button class="seo-w-link" type="button" data-open="${esc(p.id)}" title="${esc(p.path)}">${esc(short(p.title, 34))}</button>` : esc(short(p.title, 34))}</span>`;
  const prefers = (r) => {
    if (r.a.pos == null && r.b.pos == null) return "—";
    const aWins = r.b.pos == null || (r.a.pos != null && r.a.pos <= r.b.pos);
    const p = aWins ? A : B;
    return `<span class="seo-cmp-pref"><i style="background:${p.color}"></i>${esc(short(p.title, 18))}</span>`;
  };

  return `<div class="seo-cmp">
    <div class="seo-row" style="margin:0 0 6px"><h3 style="margin:0">Head to head</h3>
      <span class="seo-note">Which page to keep when two compete</span></div>
    <div class="seo-cmp-t">
      <div class="seo-cmp-r is-h"><span></span>${head(A)}${head(B)}</div>
      ${rows.map((r) => `<div class="seo-cmp-r"><span>${r[0]}</span>
        <span>${win(r, "a") ? `<b class="seo-cmp-win">${r[1]}</b>` : r[1]}</span>
        <span>${win(r, "b") ? `<b class="seo-cmp-win">${r[2]}</b>` : r[2]}</span></div>`).join("")}
    </div>

    <h4 class="seo-cmp-h4">Do they compete?</h4>
    <p class="seo-note" style="margin:0">${esc(overlapLine)}${sim != null ? ` Their text is <b>${sim}% the same</b>.` : " Their text hasn't been compared yet (Site health → Content compares pages each night)."}</p>
    ${aTot + bTot ? `<div class="seo-cmp-bar" title="Impressions: only A · shared · only B">
        <i style="width:${(onlyA / all) * 100}%;background:${A.color}"></i><i style="width:${((aSh + bSh) / all) * 100}%;background:#94a3b8"></i><i style="width:${(onlyBi / all) * 100}%;background:${B.color}"></i></div>
      <div class="seo-note">Impressions: only “${esc(short(A.title, 24))}” · <b>shared</b> · only “${esc(short(B.title, 24))}”</div>` : ""}
    ${shared.length ? `<div class="seo-cmp-t" style="margin-top:8px">
      <div class="seo-cmp-s is-h"><span>Shared search</span><span>${esc(short(A.title, 14))}</span><span>${esc(short(B.title, 14))}</span><span>Google prefers</span></div>
      ${shared.slice(0, 8).map((r) => `<div class="seo-cmp-s"><span><button class="seo-w-link" type="button" data-kq="${esc(r.q)}">${esc(r.q)}</button></span>
        <span>${h.fmtPos(r.a.pos)}</span><span>${h.fmtPos(r.b.pos)}</span><span>${prefers(r)}</span></div>`).join("")}
    </div>${shared.length > 8 ? `<p class="seo-note" style="margin:4px 0 0">${shared.length - 8} more shared searches.</p>` : ""}` : ""}

    <div class="seo-cmp-v is-${kind}">
      <div class="seo-cmp-vt">${esc(vTitle)}</div>
      <ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
      <div class="seo-w-acts">${actions}</div>
    </div>
  </div>`;
}

const CSS = `
.seo-cmp{margin-top:14px;padding-top:14px;border-top:1px dashed var(--border,#e5e7eb)}
.seo-cmp-t{border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow:hidden}
.seo-cmp-r{display:grid;grid-template-columns:minmax(0,1fr) 190px 190px;gap:10px;align-items:center;padding:7px 12px;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-cmp-r:first-child{border-top:0}
.seo-cmp-r > span:not(:first-child){text-align:right}
.seo-cmp-r.is-h{background:#f8fafc}
.seo-cmp-pg{display:inline-flex;align-items:center;justify-content:flex-end;gap:6px;font-weight:600;min-width:0;max-width:100%}
.seo-cmp-pg i,.seo-cmp-pref i{flex:none;width:10px;height:10px;border-radius:50%}
.seo-cmp-pg .seo-w-link{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-cmp-win{display:inline-block;padding:1px 8px;border-radius:6px;background:#ecfdf5;color:#047857}
.seo-cmp-h4{margin:14px 0 4px;font-size:14px}
.seo-cmp-bar{display:flex;height:12px;margin:8px 0 4px;border-radius:6px;overflow:hidden;background:#f1f5f9}
.seo-cmp-bar i{display:block;height:100%}
.seo-cmp-s{display:grid;grid-template-columns:minmax(0,1fr) 110px 110px 150px;gap:10px;align-items:center;padding:6px 12px;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-cmp-s:first-child{border-top:0}
.seo-cmp-s.is-h{background:#f8fafc;font-size:12px;font-weight:600;color:var(--text-muted,#6b7280)}
.seo-cmp-s > span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-cmp-s > span:not(:first-child){text-align:right}
.seo-cmp-pref{display:inline-flex;align-items:center;gap:6px;justify-content:flex-end}
.seo-cmp-v{margin-top:14px;padding:12px 14px;border-radius:12px;border:1.5px solid #86efac;background:#f0fdf4}
.seo-cmp-v.is-support{border-color:#93c5fd;background:#eff6ff}
.seo-cmp-v.is-both,.seo-cmp-v.is-data{border-color:var(--border,#e5e7eb);background:#f8fafc}
.seo-cmp-vt{font-size:15px;font-weight:700}
.seo-cmp-v ul{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.6}
@media (max-width:760px){
  .seo-cmp-r{grid-template-columns:minmax(0,1fr) 110px 110px}
  .seo-cmp-s{grid-template-columns:minmax(0,1fr) 60px 60px}.seo-cmp-s > span:nth-child(4){display:none}
}
`;

function injectCss() {
  if (document.getElementById("seo-compare-css")) return;
  const s = document.createElement("style");
  s.id = "seo-compare-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}