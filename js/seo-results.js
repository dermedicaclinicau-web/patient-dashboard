// seo-results.js — SEO → Results: did each change help?
// Seo13.gs measures every change in the Change log each morning (seo_fix_tracks): the 28 days before vs 7, 14 and 28 days
// after, allowing for the season (the rest of the site) and the page's own ups and downs. This tab shows the verdicts, and why.
import { pageOf, titleOf, npath, prioritySettings, VERDICT, KIND_LABEL, trackChip } from "./seo-work.js";

const FILTERS = [["", "All"], ["helped", "Helped"], ["flat", "No clear change"], ["worse", "Worse"],
  ["thin", "Not enough visits"], ["measuring", "Still measuring"], ["undone", "Changed back"]];
const METRICS = { clicks: "Clicks", impressions: "Impressions", ctr: "Click rate", position: "Position" };
const groupOf = (T) => (T.status === "undone" ? "undone" : T.status === "final" ? T.verdict : "measuring");
const defMetric = (T) => (T.kind === "snippet" ? "ctr"
  : (T.kind === "content" || T.kind === "links") && (T.base?.gsc?.c || 0) < 28 ? "impressions" : "clicks");
const fmtDur = (s) => (s == null || !isFinite(s) ? "—" : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`);

// Clicks, impressions, click rate or position for a page (with and without the end slash) over [from, to]
function pageVal(pages, from, to, metric, daysBetween) {
  let c = 0, i = 0, pw = 0;
  for (const p of pages) {
    const i0 = Math.max(0, daysBetween(p.dailyFrom, from)), i1 = daysBetween(p.dailyFrom, to);
    for (let d = i0; d <= i1; d++) {
      c += p.dailyArr[d] || 0;
      const imp = p.dailyIArr ? p.dailyIArr[d] || 0 : 0;
      i += imp;
      if (p.dailyPArr && imp) pw += (p.dailyPArr[d] || 0) * imp;
    }
  }
  return metric === "clicks" ? c : metric === "impressions" ? i : metric === "ctr" ? (i ? c / i : null) : (i ? pw / i : null);
}

export function renderResults(body, c) {
  injectCss();
  const { work: w, h } = c;
  const ui = w.rui || (w.rui = { v: "", kind: "", q: "", pri: false, open: "", limit: 40, metric: {} });
  ui.metric = ui.metric || {};
  ui.limit = ui.limit || 40;
  const wrap = document.createElement("div");
  wrap.className = "seo-rs";
  body.replaceChildren(wrap);

  if (w.errors.tracks) {
    wrap.innerHTML = `<div class="seo-empty seo-err">${/permission/i.test(w.errors.tracks)
      ? "Results can't be read yet: publish the Firestore rule for seo_fix_tracks." : h.esc(w.errors.tracks)}</div>`;
    return;
  }
  const tracks = (w.tracks || []).slice().sort((a, b) => b.date.localeCompare(a.date) || String(a.id).localeCompare(String(b.id)));
  if (!tracks.length) {
    wrap.innerHTML = `<div class="seo-empty">Nothing measured yet. In Apps Script, run <code>installSeoFixTrackerTrigger</code> once:
      it measures every change in the Change log from the last 4 months, then checks again each morning.</div>`;
    return;
  }
  const end = c.data.ov.periodEnd;
  const days = c.kit.daysBetween;
  const pri = new Set(prioritySettings(w).paths.map(npath));
  const byId = new Map(tracks.map((T) => [T.id, T]));

  /* ----- the summary ----- */

  function summaryHtml() {
    const fin = tracks.filter((T) => T.status === "final");
    const n = (v) => fin.filter((T) => T.verdict === v).length;
    const judged = n("helped") + n("flat") + n("worse");
    const measuring = tracks.filter((T) => T.status === "waiting" || T.status === "tracking").length;
    const tile = (k, label, val, note, tone) => `<button type="button" class="seo-kpi seo-rs-tile is-${tone}${ui.v === k ? " is-on" : ""}" data-rs-v="${k}">
      <div class="l">${label}</div><div class="v">${h.fmtInt(val)}</div><div class="p">${note}</div></button>`;
    const kinds = Object.keys(KIND_LABEL).map((k) => {
      const all = tracks.filter((T) => T.kind === k);
      const j = all.filter((T) => T.status === "final" && ["helped", "flat", "worse"].includes(T.verdict));
      return { k, total: all.length, judged: j.length, helped: j.filter((T) => T.verdict === "helped").length,
        worse: j.filter((T) => T.verdict === "worse").length };
    }).filter((x) => x.total);
    const m = w.trackSum?.month;
    const at = w.trackSum?.at?.toDate ? w.trackSum.at.toDate() : null;
    return `<div class="seo-kpis">
        ${tile("helped", "Helped", n("helped"), judged ? `${Math.round((n("helped") / judged) * 100)}% of judged changes` : "after 28 days", "good")}
        ${tile("flat", "No clear change", n("flat"), "after 28 days", "grey")}
        ${tile("worse", "Worse", n("worse"), "worth a look", "bad")}
        ${tile("measuring", "Still measuring", measuring, "readings at 7, 14 and 28 days", "blue")}
      </div>
      <div class="seo-grid2">
        <div class="seo-card"><h3>What kind of change works</h3>
          <table class="seo-rs-kinds"><thead><tr><th>Change</th><th>Made</th><th>Helped (after 28 days)</th><th>Worse</th></tr></thead>
          <tbody>${kinds.map((x) => `<tr><td>${h.esc(KIND_LABEL[x.k])}</td><td>${h.fmtInt(x.total)}</td>
            <td>${x.judged ? `<span class="seo-rs-bar is-good"><i style="width:${Math.round((x.helped / x.judged) * 100)}%"></i></span>${x.helped} of ${x.judged}`
              : `<span class="seo-note">none finished yet</span>`}</td><td>${x.worse || "—"}</td></tr>`).join("")}</tbody></table>
          ${m && m.changes ? `<p class="seo-note" style="margin:8px 0 0">Last 30 days: ${h.fmtInt(m.changes)} change${m.changes === 1 ? "" : "s"} made${
            m.judged ? `; ${m.judged} finished measuring: ${m.helped} helped, ${m.flat} no clear change, ${m.worse} worse` : ""}.</p>` : ""}
        </div>
        <div class="seo-card"><h3>How it's judged</h3>
          <ul class="seo-rs-how">
            <li><strong>Before</strong>: the 28 days before the change, fixed the first time it's measured.</li>
            <li><strong>After</strong>: readings 7, 14 and 28 days later. Search Console is about 3 days behind, so readings wait for settled data.</li>
            <li><strong>Season</strong>: the page is compared with the rest of the site over the same dates. If the whole site rose 20%, the page has to beat that.</li>
            <li><strong>Noise</strong>: a page's numbers go up and down every day. A change only counts as Helped or Worse when it clearly stands out from that.</li>
            <li>Changes to the same page within 4 weeks of each other share the result: they're flagged.</li>
          </ul>
          ${at ? `<p class="seo-note" style="margin:8px 0 0">Checked ${h.esc(at.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}${
            w.trackSum?.ok === false ? ` · <span class="seo-err">the last check failed: ${h.esc(w.trackSum.error || "")}</span>` : ""}</p>` : ""}
        </div>
      </div>`;
  }

  /* ----- one change ----- */

  function progHtml(T) {
    if (T.status === "undone") return `<span class="seo-note">Changed back${T.undone ? " " + h.fmtDate(T.undone, false) : ""}</span>`;
    if (T.status === "final") return `<span class="seo-note">Final reading</span>`;
    const d = Math.min(28, Math.max(0, T.day || 0));
    return `<span class="seo-rs-bar"><i style="width:${Math.round((d / 28) * 100)}%"></i></span>
      <span class="seo-note">Day ${d} of 28${T.next ? ` · next reading ${h.fmtDate(T.next, false)}` : ""}</span>`;
  }

  function chartHtml(T) {
    const pages = c.data.pages.filter((p) => npath(p.path) === npath(T.path) && Array.isArray(p.dailyArr) && p.dailyFrom);
    if (!pages.length) return `<p class="seo-note">No daily Google numbers for this page, so there's no chart.</p>`;
    const metric = ui.metric[T.id] || defMetric(T);
    const f = T.date, add = h.addDays;
    const bks = [];
    for (let i = 0; i < 4; i++) { const s = add(f, -28 + 7 * i); bks.push({ start: s, end: add(s, 6), after: false }); }
    for (let i = 0; i < 4; i++) { const s = add(f, 1 + 7 * i), e = add(s, 6); if (e > end) break; bks.push({ start: s, end: e, after: true }); }
    const val = (a, b) => pageVal(pages, a, b, metric, days);
    const bFrom = add(f, -28), bTo = add(f, -1);
    const pageB = val(bFrom, bTo), siteB = h.sumRange(c.data.days, bFrom, bTo);
    const label = (b) => `${h.fmtDate(b.start, false)} – ${h.fmtDate(b.end)} (${b.after ? "after" : "before"})`;
    const points = bks.map((b) => ({ start: b.start, end: b.end, label: label(b), v: val(b.start, b.end) }));
    // If nothing had changed: the page's weekly average before, moved the way the rest of the site moved
    const expect = (b) => {
      if (!b.after || pageB == null || metric === "position") return null;
      const s = h.sumRange(c.data.days, b.start, b.end);
      if (metric === "ctr") return siteB.ctr ? pageB * (s.ctr / siteB.ctr) : null;
      const sb = siteB[metric] / 4;
      return sb ? (pageB / 4) * (s[metric] / sb) : null;
    };
    const cmp = bks.map((b, i) => ({ label: points[i].label + " · if nothing had changed", v: expect(b) }));
    const hasCmp = cmp.some((x) => x.v != null);
    const fmt = metric === "ctr" ? (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%") : metric === "position" ? h.fmtPos : h.fmtInt;
    const nAfter = bks.filter((b) => b.after).length;
    return `<div class="seo-row seo-rs-mets">${Object.entries(METRICS).map(([k, l]) =>
        `<button class="seo-w-chip ${metric === k ? "is-on" : ""}" type="button" data-rs-metric="${h.esc(T.id)}|${k}">${l}</button>`).join("")}</div>
      <div class="seo-chart">${c.kit.lineChart(points, { fmt, invert: metric === "position", gran: "week", labels: true,
        cmp: hasCmp ? cmp : null, marks: [{ date: add(f, 1), title: `${h.fmtDate(f)}: ${T.title || "the change"}` }] })}</div>
      <div class="seo-legend"><span></span>This page, week by week${hasCmp ? `<span class="is-cmp"></span>If nothing had changed (the rest of the site's trend)` : ""}</div>
      <p class="seo-note">4 weeks before and up to 4 weeks after ${h.fmtDate(f)}. The day of the change is left out.${
        nAfter < 4 ? " More weeks appear as Search Console catches up." : ""}</p>`;
  }

  function numbersHtml(T) {
    const r = T.cps && T.cps[T.cp];
    if (!r) return "";
    const rows = [];
    const pct = (v) => (v == null ? "—" : v + "%");
    if (r.gsc) {
      const b = r.gsc.before, a = r.gsc.after;
      rows.push(["Clicks from Google a week", h.fmtInt(b.clicks), h.fmtInt(a.clicks), h.delta(a.clicks, b.clicks)]);
      rows.push(["Impressions a week", h.fmtInt(b.impressions), h.fmtInt(a.impressions), h.delta(a.impressions, b.impressions)]);
      rows.push(["Click rate", pct(b.ctr), pct(a.ctr), h.delta(a.ctr, b.ctr)]);
      rows.push(["Average position", h.fmtPos(b.position), h.fmtPos(a.position), h.delta(a.position, b.position, { invert: true, abs: true })]);
    }
    if (r.ga) {
      const b = r.ga.before, a = r.ga.after;
      const wb = b.visits / 4, wa = r.n ? a.visits / (r.n / 7) : null;
      rows.push(["Visits from Google a week", h.fmtInt(wb), wa == null ? "—" : h.fmtInt(wa), wa == null ? "" : h.delta(wa, wb)]);
      rows.push(["Bounce", pct(b.bounce), pct(a.bounce), h.delta(a.bounce, b.bounce, { invert: true, abs: true, digits: 0 })]);
      if (b.phones != null || a.phones != null) rows.push(["Bounce on phones", pct(b.phones), pct(a.phones), h.delta(a.phones, b.phones, { invert: true, abs: true, digits: 0 })]);
      rows.push(["Engaged time a visit", fmtDur(b.secs), fmtDur(a.secs), ""]);
    }
    if (r.speed) rows.push(["Mobile speed score", String(r.speed.before), String(r.speed.after), h.delta(r.speed.after, r.speed.before, { abs: true, digits: 0 })]);
    if (r.searches) rows.push(["Different searches finding it", h.fmtInt(r.searches.before), h.fmtInt(r.searches.after), h.delta(r.searches.after, r.searches.before)]);
    if (!rows.length) return "";
    return `<h4>The numbers</h4><table class="seo-kv"><tr><th></th><th>28 days before</th><th>${r.n} days after</th><th></th></tr>
      ${rows.map((x) => `<tr><td>${x[0]}</td><td>${x[1]}</td><td>${x[2]}</td><td>${x[3]}</td></tr>`).join("")}</table>
      ${r.mixed ? `<p class="seo-note">The position moved too, which changes the click rate on its own, so read the click rate with care.</p>` : ""}`;
  }

  function detailHtml(T) {
    const pg = pageOf(c.data, T.path);
    const ks = Object.keys(T.cps || {}).map(Number).sort((a, b) => a - b);
    return `<div class="seo-rs-detail">
      ${T.kind === "index" ? "" : chartHtml(T)}
      ${numbersHtml(T)}
      ${ks.length ? `<h4>Readings</h4><ol class="seo-rs-reads">${ks.map((k) => {
        const r = T.cps[k];
        const [l, tone] = VERDICT[r.v] || VERDICT.early;
        return `<li><span class="seo-fx is-${tone}">Day ${k}: ${h.esc(l)}</span> ${h.esc(r.why || "")}</li>`;
      }).join("")}</ol>` : ""}
      <h4>What was changed</h4>
      <ul class="seo-rs-list">${(T.logs || []).map((l) => `<li>${h.esc(l.title)}${l.by ? ` <span class="seo-note">· ${h.esc(l.by)}</span>` : ""}${
        l.undone ? ` <span class="seo-fx is-grey">changed back ${h.fmtDate(l.undone, false)}</span>` : ""}</li>`).join("")}</ul>
      ${(T.overlap || []).length ? `<h4>Other changes to this page within 4 weeks</h4>
        <ul class="seo-rs-list">${T.overlap.map((o) => `<li>${h.fmtDate(o.date)} · ${h.esc(KIND_LABEL[o.kind] || o.kind)}:
          ${byId.has(o.id) ? `<button class="seo-w-link" type="button" data-rs-goto="${h.esc(o.id)}">${h.esc(o.title || "a change")}</button>` : h.esc(o.title || "a change")}</li>`).join("")}</ul>` : ""}
      <div class="seo-w-acts">
        <button class="seo-btn" type="button" data-rs-ask="${h.esc(T.id)}">Ask the Advisor ${T.verdict === "worse" ? "why" : "what's next"}</button>
        ${pg ? `<button class="seo-btn" type="button" data-open="${h.esc(pg.id)}">Open page details</button>` : ""}
        <button class="seo-btn" type="button" data-tab="log">Open the Change log</button>
      </div></div>`;
  }

  function cardHtml(T) {
    const open = ui.open === T.id;
    return `<article class="seo-rs-card${open ? " is-open" : ""}" data-rs-card="${h.esc(T.id)}">
      <button type="button" class="seo-rs-head" data-rs-open="${h.esc(T.id)}" aria-expanded="${open}">
        <span>${trackChip(T, h)}</span>
        <span class="seo-rs-main"><strong>${h.esc(T.title || "Change")}</strong>
          <small>${pri.has(npath(T.path)) ? "★ " : ""}${h.esc(titleOf(w, c.data, T.path))} · ${h.esc(KIND_LABEL[T.kind] || T.kind)} · ${h.fmtDate(T.date)}</small></span>
        <span class="seo-rs-prog">${progHtml(T)}</span>
      </button>
      ${T.reason ? `<p class="seo-rs-why">${h.esc(T.reason)}</p>` : ""}
      ${T.shared && T.status !== "undone" && T.verdict !== "early" ? `<p class="seo-rs-shared">⚠ ${h.esc(T.shared)}</p>` : ""}
      ${T.status === "final" && T.verdict === "worse" ? `<p class="seo-rs-act">This made things worse over 4 weeks. Think about undoing it where it was made
        (Site health, the Advisor's answer or the Website tab), or ask the Advisor why first.</p>` : ""}
      ${open ? detailHtml(T) : ""}
    </article>`;
  }

  /* ----- the list ----- */

  function filtered() {
    const q = ui.q.trim().toLowerCase();
    return tracks.filter((T) => (!ui.v || groupOf(T) === ui.v) && (!ui.kind || T.kind === ui.kind)
      && (!ui.pri || pri.has(npath(T.path)))
      && (!q || `${T.title} ${T.path} ${titleOf(w, c.data, T.path)}`.toLowerCase().includes(q)));
  }

  function drawList() {
    const box = wrap.querySelector("[data-rs-list]");
    if (!box) return;
    const all = filtered();
    if (ui.scroll && ui.open) { const at = all.findIndex((T) => T.id === ui.open); if (at >= ui.limit) ui.limit = at + 1; }
    const show = all.slice(0, ui.limit);
    box.innerHTML = show.length ? show.map(cardHtml).join("")
      + (all.length > ui.limit ? `<div style="padding:10px;text-align:center"><button class="seo-btn" type="button" data-rs-more>Show all ${h.fmtInt(all.length)}</button></div>` : "")
      : `<div class="seo-empty">No changes match.</div>`;
    if (ui.scroll && ui.open) {
      ui.scroll = false;
      box.querySelector(`[data-rs-card="${CSS.escape(ui.open)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function draw() {
    const counts = {};
    tracks.forEach((T) => { const g = groupOf(T); counts[g] = (counts[g] || 0) + 1; });
    wrap.innerHTML = `${summaryHtml()}
      <div class="seo-card">
        <div class="seo-row" style="margin:0 0 8px"><h3 style="margin:0">Changes</h3><span class="seo-sp"></span>
          <select class="seo-input seo-select" data-rs-kind aria-label="Kind of change"><option value="">Every kind</option>
            ${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}"${ui.kind === k ? " selected" : ""}>${l}</option>`).join("")}</select>
          <input class="seo-input" type="search" data-rs-q placeholder="Find a page or change" value="${h.esc(ui.q)}">
          ${pri.size ? `<label class="seo-check"><input type="checkbox" data-rs-pri${ui.pri ? " checked" : ""}> ★ Priority pages only</label>` : ""}
        </div>
        <div class="seo-row">${FILTERS.map(([k, l]) => `<button class="seo-w-chip ${ui.v === k ? "is-on" : ""}" type="button" data-rs-v="${k}">${l}
          <em>${h.fmtInt(k ? counts[k] || 0 : tracks.length)}</em></button>`).join("")}</div>
        <div data-rs-list></div>
      </div>`;
    drawList();
  }

  wrap.onclick = (e) => {
    if (e.target.closest("[data-open],[data-tab]")) return;   // seo.js opens pages and tabs
    const t = e.target.closest("[data-rs-v],[data-rs-open],[data-rs-goto],[data-rs-metric],[data-rs-ask],[data-rs-more]");
    if (!t) return;
    const d = t.dataset;
    if (d.rsV !== undefined) { ui.v = ui.v === d.rsV ? "" : d.rsV; ui.limit = 40; draw(); return; }
    if (d.rsOpen !== undefined) { ui.open = ui.open === d.rsOpen ? "" : d.rsOpen; ui.scroll = !!ui.open; drawList(); return; }
    if (d.rsGoto !== undefined) { Object.assign(ui, { v: "", kind: "", q: "", pri: false, open: d.rsGoto, scroll: true }); draw(); return; }
    if (d.rsMetric !== undefined) {
      const [id, m] = d.rsMetric.split("|");
      ui.metric[id] = m;
      drawList();
      return;
    }
    if (d.rsMore !== undefined) { ui.limit = Infinity; drawList(); return; }
    if (d.rsAsk !== undefined) {
      const T = byId.get(d.rsAsk);
      if (!T) return;
      w.advPrefill = { mode: "question", text: (`On ${T.date} we changed ${T.path}: “${T.title}”. The results check says: ${T.reason || "no result yet"} ` +
        (T.verdict === "worse" ? "Why might it have made things worse, and should we undo it or change something else?"
          : "What should we do next on this page to build on it?")).slice(0, 1900) };
      c.setTab("advisor");
    }
  };
  wrap.onchange = (e) => {
    if (e.target.matches("[data-rs-kind]")) { ui.kind = e.target.value; ui.limit = 40; draw(); }
    else if (e.target.matches("[data-rs-pri]")) { ui.pri = e.target.checked; ui.limit = 40; draw(); }
  };
  wrap.oninput = (e) => {
    if (e.target.matches("[data-rs-q]")) { ui.q = e.target.value; ui.limit = 40; drawList(); }
  };
  draw();
}

const CSS = `
.seo-rs-tile.is-good .v{color:#047857}.seo-rs-tile.is-bad .v{color:#b91c1c}.seo-rs-tile.is-blue .v{color:#1d4ed8}
.seo-rs-kinds{width:100%;border-collapse:collapse;font-size:13px}
.seo-rs-kinds th,.seo-rs-kinds td{padding:6px 4px;border-top:1px solid var(--border,#e5e7eb);text-align:left;font-weight:400}
.seo-rs-kinds th{color:var(--text-muted,#6b7280);font-size:12px;border-top:0}
.seo-rs-bar{display:inline-block;width:90px;height:6px;border-radius:3px;background:#e5e7eb;overflow:hidden;vertical-align:middle;margin-right:6px}
.seo-rs-bar i{display:block;height:100%;background:var(--accent,#2563eb)}
.seo-rs-bar.is-good i{background:#16a34a}
.seo-rs-how{margin:0;padding-left:18px;font-size:13px;line-height:1.5}
.seo-rs-card{border-top:1px solid var(--border,#e5e7eb);padding:10px 0}
.seo-rs-card:first-child{border-top:0}
.seo-rs-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;width:100%;padding:0;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.seo-rs-head:hover strong{text-decoration:underline}
.seo-rs-main{min-width:0}
.seo-rs-main strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.seo-rs-main small{display:block;color:var(--text-muted,#6b7280);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-rs-prog{display:flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:150px}
.seo-rs-why{margin:6px 0 0;font-size:13px;line-height:1.45}
.seo-rs-shared{margin:4px 0 0;font-size:12.5px;color:#b45309}
.seo-rs-act{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:#fef2f2;font-size:13px;line-height:1.45}
.seo-rs-detail{margin-top:10px;padding:12px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:#fbfdff}
.seo-rs-detail h4{margin:14px 0 6px;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#6b7280)}
.seo-rs-reads,.seo-rs-list{margin:0;padding-left:18px;font-size:13px;line-height:1.5}
.seo-rs-reads li,.seo-rs-list li{margin-bottom:4px}
.seo-rs-mets{gap:4px;margin:0 0 6px}
@media (max-width:640px){.seo-rs-head{grid-template-columns:1fr}.seo-rs-prog{align-items:flex-start}}
`;

function injectCss() {
  if (document.getElementById("seo-results-css")) return;
  const s = document.createElement("style");
  s.id = "seo-results-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}