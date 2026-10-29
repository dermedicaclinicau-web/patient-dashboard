// seo-health.js — SEO Phase 3: the Site health tab, and speed + issues in the page panel.
// Reads seo_state/health, seo_health (current build) and seo_issues (what staff have ignored).

import { db, auth } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SEV = {
  high: { label: "High", tone: "red", rank: 0 },
  medium: { label: "Medium", tone: "amber", rank: 1 },
  low: { label: "Low", tone: "grey", rank: 2 },
};
const GROUPS = { speed: "Speed", index: "Indexing", content: "Titles & content", links: "Links", images: "Images", wording: "Advertising wording" };
const LOG_TYPE = { speed: "Technical", index: "Technical", links: "Links", images: "Content", content: "Title / meta", wording: "Content" };
const HELP = {
  fetch: "Check the page opens in a browser. If it does, the website may be blocking automated checks.",
  blocked: "Ask whoever looks after the website to allow requests from Google's servers (Google Apps Script), or turn off bot blocking for these pages.",
  status: "Fix the page. If it's gone on purpose, remove it from Key pages and redirect the old address to the best page.",
  redirect: "Change the key page in Settings to the address it ends up at, and point menus and links straight there.",
  noindex: "Turn off 'noindex' in the page's SEO settings (in Yoast: Advanced → Allow search engines to show this page). Only leave it on pages that should stay out of Google.",
  no_canonical: "Set a canonical tag that points to the page itself. SEO plugins like Yoast do this automatically.",
  canonical: "The canonical should normally point to the page itself. When it points elsewhere, Google may ignore this page.",
  no_title: "Add a title that says what the page is about, e.g. 'Melasma Treatment Perth | Dermedica'.",
  title_long: "Keep titles to about 60 characters so Google doesn't cut them off. Put the most important words first.",
  title_short: "Make the title more descriptive: the treatment, the place and the clinic name.",
  dup_title: "Give each page its own title, so Google knows which page to show for which search.",
  no_desc: "Add a meta description of 120–155 characters that sums up the page and gives a reason to click.",
  desc_long: "Trim the description to about 155 characters so it isn't cut off.",
  desc_short: "Expand the description to 120–155 characters.",
  dup_desc: "Write a different description for each page.",
  no_h1: "Give the page one main heading (H1) that says what it's about.",
  many_h1: "Keep one H1 for the main heading and change the others to H2 or H3.",
  alt: "Add short alt text describing each image. It helps Google Images and people using screen readers. Decorative images can have empty alt text.",
  broken_link: "Fix or remove the link, or redirect the missing address to the right page.",
  redirect_links: "Update these links to point straight at the final address.",
  wording: "Reword this. Prescription medicine names can't be used in advertising to the public, and AHPRA's guidelines don't allow wording that promises results or downplays risk. Check with your compliance adviser if unsure.",
  cwv_lcp: "Usually the main image or banner is too big. Compress it, use WebP, and make sure the top image isn't lazy-loaded.",
  cwv_inp: "Too much JavaScript is running. Remove unused plugins, sliders and chat widgets, or load them later.",
  cwv_cls: "Give images, embeds and banners a fixed size so the page doesn't shift while they load.",
  score: "Open the page in pagespeed.web.dev to see the biggest problems. Large images and too many plugins are the usual causes.",
};
const LIMITS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] };

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const uid = () => auth.currentUser?.uid || "";
const myName = (c) => c.staff?.name || c.staff?.displayName || auth.currentUser?.displayName || "";
const tsDate = (t) => (t?.toDate ? t.toDate() : t ? new Date(t) : null);
const errText = (m) => (/permission/i.test(String(m)) ? "You don't have permission to do that." : String(m));
const when = (t) => {
  const d = tsDate(t);
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
};
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const issueId = (path, key) => "i_" + hash(path + "|" + key) + hash("#" + key + path);

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}

const rate = (k, v) => {
  if (v == null) return "";
  if (k === "score") return v >= 90 ? "good" : v >= 50 ? "ni" : "poor";
  return v <= LIMITS[k][0] ? "good" : v <= LIMITS[k][1] ? "ni" : "poor";
};
const fmtM = { lcp: (v) => (v / 1000).toFixed(1) + " s", inp: (v) => Math.round(v) + " ms", cls: (v) => Number(v).toFixed(2), score: (v) => String(v) };
const val = (k, v) => (v == null ? "—" : `<span class="seo-h-${rate(k, v)}">${fmtM[k](v)}</span>`);

// What to show for a page: real-visitor data for the page if Google has it, otherwise its lab test
function metricsOf(sp) {
  if (!sp) return null;
  const f = sp.field && sp.field.src === "page" ? sp.field : null;
  return {
    score: sp.score ?? null,
    lcp: f?.lcp?.v ?? sp.lab?.lcp ?? null,
    inp: f?.inp?.v ?? null,
    cls: f?.cls?.v ?? sp.lab?.cls ?? null,
    from: f ? "Real visitors" : "Google's test",
    pass: f ? ["lcp", "inp", "cls"].every((k) => !f[k] || f[k].c === "FAST") : null,
  };
}

/* ---------- data ---------- */

export async function loadHealth() {
  injectCss();
  const out = { state: null, pages: [], status: {} };
  const s = await getDoc(doc(db, "seo_state", "health"));
  if (!s.exists()) return out;
  out.state = s.data();
  const jobs = [
    getDocs(collection(db, "seo_issues"))
      .then((snap) => snap.docs.forEach((d) => { out.status[d.id] = d.data(); }))
      .catch((e) => console.warn("SEO issue statuses not read:", e)),
  ];
  if (out.state.build) {
    jobs.push(getDocs(query(collection(db, "seo_health"), where("build", "==", out.state.build)))
      .then((snap) => { out.pages = snap.docs.map((d) => ({ id: d.id, ...d.data() })); }));
  }
  await Promise.all(jobs);
  for (const p of out.pages) {
    for (const i of p.issues || []) {
      i.path = p.path;
      i.url = p.url;
      i.id = issueId(p.path, i.key);
      i.st = out.status[i.id] || null;
      i.status = i.st?.status === "ignored" ? "ignored" : "open";
    }
  }
  return out;
}

async function setStatus(c, i, status, note) {
  const d = {
    key: i.key, label: (i.msg + (i.detail ? " · " + i.detail : "")).slice(0, 300), path: i.path,
    status, note: String(note || "").slice(0, 1000), by: uid(), byName: myName(c), at: serverTimestamp(),
  };
  await setDoc(doc(db, "seo_issues", i.id), d);
  i.st = { ...d, at: new Date() };
  i.status = status === "ignored" ? "ignored" : "open";
  c.work.health.status[i.id] = i.st;
}

/* ---------- the page panel (seo-work.js → pagePanelExtras) ---------- */

export function healthPanelHtml(H, p) {
  if (!H || !H.state) return "";
  const k = H.pages.find((x) => x.path === p.path);
  if (!k) return `<p class="seo-note" style="margin-top:14px">Site health doesn't check this page. Add it under Settings → Key pages to check its speed, titles, links and wording every night.</p>`;
  const m = metricsOf(k.speed);
  const open = (k.issues || []).filter((i) => i.status === "open").sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank);
  return `<h3>Site health</h3>
    ${m ? `<p class="seo-note">Mobile score ${val("score", m.score)} · LCP ${val("lcp", m.lcp)} · INP ${val("inp", m.inp)} · CLS ${val("cls", m.cls)} · ${esc(m.from)}</p>`
      : `<p class="seo-note">Speed not checked yet.</p>`}
    ${open.length
      ? `<ul class="seo-h-plist">${open.map((i) => `<li><span class="seo-w-pill is-${SEV[i.sev].tone}">${SEV[i.sev].label}</span> ${esc(i.msg)}</li>`).join("")}</ul>`
      : `<p class="seo-note">No open issues.</p>`}
    <p><a class="seo-w-link" href="#/seo/health">Open Site health</a></p>`;
}

/* ---------- the tab ---------- */

export function viewHealth(wrap, c, ui) {
  const H = c.work.health;
  if (!H || !H.state) {
    const err = c.work.errors?.health;
    wrap.innerHTML = `<div class="seo-empty">${err ? esc(errText(err))
      : "No site health data yet. In Apps Script, run <code>runSeoHealth()</code> once (it takes a few minutes), then <code>installSeoHealthTrigger()</code>."}</div>`;
    return;
  }
  if (!ui.hview) Object.assign(ui, { hview: "issues", hsev: "all", hgroup: "all", hstatus: "open" });
  const canWork = c.can("seo.work");
  let byId = new Map();

  function tiles(all) {
    const open = all.filter((i) => i.status === "open");
    const n = (s) => open.filter((i) => i.sev === s).length;
    const ms = H.pages.map((p) => metricsOf(p.speed)).filter(Boolean);
    const scores = ms.map((m) => m.score).filter((v) => v != null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const real = ms.filter((m) => m.pass !== null);
    const tile = (l, v, p) => `<div class="seo-kpi"><div class="l">${l}</div><div class="v">${v}</div>${p ? `<div class="p">${p}</div>` : ""}</div>`;
    return `<div class="seo-kpis">
      ${tile("Key pages checked", H.pages.length, when(H.state.at))}
      ${tile("High", `<span class="seo-h-poor">${n("high")}</span>`, "open issues")}
      ${tile("Medium", `<span class="seo-h-ni">${n("medium")}</span>`, "open issues")}
      ${tile("Low", n("low"), "open issues")}
      ${tile("Avg mobile score", avg == null ? "—" : val("score", avg), "out of 100")}
      ${tile("Core Web Vitals", real.length ? `${real.filter((m) => m.pass).length}/${real.length}` : "—",
        real.length ? "pages passing (real visitors)" : "not enough visits yet")}
    </div>`;
  }

  function issueRow(i) {
    const pg = c.byPath.get(i.path);
    const where = pg ? `<button class="seo-w-link" data-open="${pg.id}">${esc(i.path)}</button>`
      : `<a class="seo-w-link" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.path)}</a>`;
    const ignored = i.status === "ignored";
    return `<div class="seo-h-issue is-${SEV[i.sev].tone}">
      <div class="seo-h-ihead"><span class="seo-w-pill is-${SEV[i.sev].tone}">${SEV[i.sev].label}</span>
        <span class="seo-note">${esc(GROUPS[i.group] || i.group)}</span> · ${where}</div>
      <div><strong>${esc(i.msg)}</strong>${i.detail ? `<div class="seo-note seo-h-detail">${esc(i.detail)}</div>` : ""}</div>
      ${HELP[i.code] ? `<details class="seo-h-help"><summary>How to fix</summary><p>${esc(HELP[i.code])}</p></details>` : ""}
      ${ignored ? `<p class="seo-note">Ignored by ${esc(i.st?.byName || "someone")}${i.st?.at ? " · " + esc(when(i.st.at)) : ""}${i.st?.note ? ": " + esc(i.st.note) : ""}</p>` : ""}
      ${canWork ? `<div class="seo-w-acts">${ignored
        ? `<button class="seo-btn" data-h-undo="${i.id}">Back to open</button>`
        : `<button class="seo-btn" data-h-log="${i.id}">Log a fix</button><button class="seo-btn" data-h-ignore="${i.id}">Ignore</button>`}</div>` : ""}
    </div>`;
  }

  function issuesHtml(all) {
    const inStatus = all.filter((i) => i.status === ui.hstatus);
    const counts = { open: all.filter((i) => i.status === "open").length, ignored: all.filter((i) => i.status === "ignored").length };
    const gcount = {};
    for (const i of inStatus) gcount[i.group] = (gcount[i.group] || 0) + 1;
    const shown = inStatus
      .filter((i) => (ui.hsev === "all" || i.sev === ui.hsev) && (ui.hgroup === "all" || i.group === ui.hgroup))
      .sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank || a.path.localeCompare(b.path));
    const chip = (attr, k, l, on, n) =>
      `<button class="seo-w-chip ${on ? "is-on" : ""}" ${attr}="${k}">${esc(l)}${n != null ? ` <em>${n}</em>` : ""}</button>`;
    return `
      <div class="seo-row">
        <button class="seo-btn ${ui.hstatus === "open" ? "on" : ""}" data-h-status="open">Open <span class="seo-w-n">${counts.open}</span></button>
        <button class="seo-btn ${ui.hstatus === "ignored" ? "on" : ""}" data-h-status="ignored">Ignored <span class="seo-w-n">${counts.ignored}</span></button>
        <span class="seo-sp"></span>
        ${chip("data-h-sev", "all", "All", ui.hsev === "all")}
        ${Object.entries(SEV).map(([k, v]) => chip("data-h-sev", k, v.label, ui.hsev === k, inStatus.filter((i) => i.sev === k).length)).join("")}
      </div>
      <div class="seo-row">
        ${chip("data-h-group", "all", "All types", ui.hgroup === "all")}
        ${Object.entries(GROUPS).map(([k, l]) => chip("data-h-group", k, l, ui.hgroup === k, gcount[k] || 0)).join("")}
      </div>
      ${shown.length ? shown.map(issueRow).join("") : `<div class="seo-empty">${ui.hstatus === "open" ? "Nothing to fix here. 👍" : "Nothing ignored."}</div>`}
      <p class="seo-note" style="margin-top:8px">Fixed something? It disappears after the next nightly check (about 8am).</p>`;
  }

  function speedHtml() {
    const rows = H.pages.slice().sort((a, b) => (a.speed?.score ?? 999) - (b.speed?.score ?? 999));
    return `<div class="seo-table-wrap"><table class="seo-table">
      <thead><tr><th>Page</th><th>Mobile score</th><th>Loading (LCP)</th><th>Responding (INP)</th><th>Shifting (CLS)</th><th>Measured from</th><th>Trend</th><th>Checked</th></tr></thead>
      <tbody>${rows.map((p) => {
        const m = metricsOf(p.speed);
        const pg = c.byPath.get(p.path);
        const scores = (p.history || []).map((r) => r.s).filter((v) => v != null);
        return `<tr ${pg ? `data-open="${pg.id}"` : ""}>
          <td><div class="seo-path" title="${esc(p.url)}">${esc(p.path)}</div></td>
          ${m ? `<td>${val("score", m.score)}</td><td>${val("lcp", m.lcp)}</td><td>${val("inp", m.inp)}</td><td>${val("cls", m.cls)}</td><td>${esc(m.from)}</td>`
            : `<td colspan="5" class="seo-note">${p.speedError ? esc(p.speedError) : "Not checked yet"}</td>`}
          <td>${scores.length > 1 ? c.h.sparkline(scores, 90, 22) : ""}</td>
          <td class="seo-note">${p.speedAt ? esc(when(p.speedAt)) : "—"}</td>
        </tr>`;
      }).join("")}</tbody></table></div>
      <p class="seo-note" style="margin-top:8px">Mobile, from Google PageSpeed Insights. Good: LCP under 2.5 s, INP under 200 ms, CLS under 0.1, score 90+.
        “Real visitors” is Chrome data from the last 28 days. Pages without enough visits show Google's lab test instead (no INP).</p>`;
  }

  function draw() {
    const all = H.pages.flatMap((p) => p.issues || []);
    byId = new Map(all.map((i) => [i.id, i]));
    const st = H.state;
    wrap.innerHTML = `
      ${st.ok === false ? `<div class="seo-warn">The last site health check failed, so this may be out of date: ${esc(st.error || "")}</div>` : ""}
      ${st.blocked ? `<div class="seo-warn">${st.blocked} key page${st.blocked === 1 ? "" : "s"} couldn't be read. The website may be blocking automated checks.</div>` : ""}
      ${st.speedProblem ? `<div class="seo-warn">${esc(st.speedProblem)}</div>` : ""}
      ${tiles(all)}
      <div class="seo-row">
        <button class="seo-btn ${ui.hview === "issues" ? "on" : ""}" data-h-view="issues">Issues</button>
        <button class="seo-btn ${ui.hview === "speed" ? "on" : ""}" data-h-view="speed">Speed</button>
        <span class="seo-sp"></span>
        <span class="seo-note">${st.linksChecked != null ? `${st.linksChecked} of ${st.linksFound} internal links checked · ` : ""}${c.can("seo.manage") ? `Choose pages in <a href="#/seo/settings">Settings</a>` : ""}</span>
      </div>
      ${ui.hview === "speed" ? speedHtml() : issuesHtml(all)}`;
  }

  wrap.onclick = async (e) => {
    if (e.target.closest("[data-open]")) return;   // seo.js opens the page panel
    const t = e.target.closest("[data-h-view],[data-h-sev],[data-h-group],[data-h-status],[data-h-log],[data-h-ignore],[data-h-undo]");
    if (!t) return;
    const d = t.dataset;
    if (d.hView) { ui.hview = d.hView; draw(); return; }
    if (d.hSev) { ui.hsev = d.hSev; draw(); return; }
    if (d.hGroup) { ui.hgroup = d.hGroup; draw(); return; }
    if (d.hStatus) { ui.hstatus = d.hStatus; draw(); return; }
    const i = byId.get(d.hLog || d.hIgnore || d.hUndo);
    if (!i) return;
    if (d.hLog) {
      c.work.prefill = { url: i.path, title: ("Fixed: " + i.msg).slice(0, 200), type: LOG_TYPE[i.group] || "Technical" };
      c.setTab("log");
      return;
    }
    let note = "";
    if (d.hIgnore) {
      note = prompt("Why ignore this? (optional)", "");
      if (note === null) return;
    }
    t.disabled = true;
    try {
      await setStatus(c, i, d.hIgnore ? "ignored" : "open", note);
      toast(d.hIgnore ? "Ignored" : "Back on the list");
      draw();
    } catch (err) { t.disabled = false; toast(errText(err.message || err), true); }
  };
  draw();
}

/* ---------- styles ---------- */

const CSS = `
.seo-h-issue{padding:12px 14px;margin-bottom:8px;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-left:3px solid var(--tone,#94a3b8);border-radius:10px;font-size:13px}
.seo-h-issue.is-red{--tone:#dc2626}.seo-h-issue.is-amber{--tone:#d97706}
.seo-h-ihead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:4px}
.seo-h-detail{margin-top:2px;word-break:break-word}
.seo-h-help summary{cursor:pointer;margin-top:6px;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-h-help p{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:#f8fafc;line-height:1.45}
.seo-h-good{color:#16a34a;font-weight:600}.seo-h-ni{color:#d97706;font-weight:600}.seo-h-poor{color:#dc2626;font-weight:600}
.seo-h-plist{list-style:none;margin:0 0 8px;padding:0;font-size:13px}
.seo-h-plist li{padding:5px 0;border-top:1px solid var(--border,#e5e7eb)}
.seo-w-ta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;resize:vertical}
`;

function injectCss() {
  if (document.getElementById("seo-health-css")) return;
  const s = document.createElement("style");
  s.id = "seo-health-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}