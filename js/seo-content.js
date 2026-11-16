// seo-content.js — Site health → Content: spelling and grammar, duplicate content, FAQs, advertising rules, freshness.
// Reads what Seo9.gs saves each night (loaded by seo-health.js into work.health.content).
// Ignoring uses seo_issues, like the rest of Site health. "Add to my words" adds to seo_settings/main.spellWords.
// Used by seo-health.js (the view) and seo-tasks.js (tasks). Imports nothing from seo-work.js.

import { db, auth } from "./firebase-config.js";
import { doc, setDoc, serverTimestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";

// Accept / Reject / Regenerate state per issue while the page is open: { opts, pick, busy, err, editUrl, reject }
const FX = new Map();
async function fixApi(op, data) {
  const r = await callApi({ action: "wordpress", op, ...data });
  if (r && r.problem) { const e = new Error(r.problem); e.editUrl = r.editUrl || ""; throw e; }
  return r;
}
const fixErr = (e) => (e?.code === "FORBIDDEN" || /FORBIDDEN/.test(e?.message || "")
  ? "You don't have access to fix wording on the website. Ask an Admin to turn on “Site health: fix wording on the website”."
  : e?.message || "Something went wrong. Try again.");

const TYPE = { spelling: ["Spelling", "red"], grammar: ["Grammar", "amber"], au: ["Australian English", "blue"],
  compliance: ["Advertising rules", "red"], consistency: ["Consistency", "violet"] };
const isProof = (t) => t === "spelling" || t === "grammar" || t === "au";
const QUESTION = /\b(how|what|why|when|does|do|can|is|are|should|which|vs|safe|hurt|last|long|cost|price|much)\b/;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const npath = (s) => String(s || "").split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase() || "/";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
export const contentIssueId = (path, i) => {
  const t = String(i.text || "").toLowerCase();
  return "c_" + hash(npath(path) + "|" + i.type + "|" + t) + hash(i.type + "#" + t);
};
const dupId = (a, b) => { const [x, y] = [npath(a), npath(b)].sort(); return "d_" + hash(x + "|" + y) + hash(y + "#" + x); };
const groupId = (key) => "k_" + hash("consist|" + key) + hash(key + "#consist");
const toD = (t) => { const d = t?.toDate ? t.toDate() : t ? new Date(t) : null; return d && !isNaN(d) ? d : null; };
const whenC = (t) => { const d = toD(t); return d ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""; };
const hoursAgo = (t) => { const d = toD(t); return d ? (Date.now() - d.getTime()) / 36e5 : null; };

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}
const pretty = (p) => {
  let s = String(p || "").split("?")[0].replace(/\/+$/, "").split("/").pop();
  if (!s) return "Home page";
  try { s = decodeURIComponent(s); } catch { /* as is */ }
  s = s.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const titleIn = (w, path) => (w?.wp?.pages || []).find((p) => npath(p.path) === npath(path))?.title || pretty(path);
const pageId = (c, path) => (c.data?.pages || []).filter((x) => npath(x.path) === npath(path))
  .sort((a, b) => (b.m28?.impressions || 0) - (a.m28?.impressions || 0))[0]?.id || "";

// A page's proofreading problems (words you've accepted left out), with whether each was ignored
export function contentIssues(w, path) {
  const d = w?.health?.content?.deep?.[npath(path)];
  if (!d || !d.ai || !Array.isArray(d.ai.issues)) return [];
  const ok = new Set((Array.isArray(w.settings?.spellWords) ? w.settings.spellWords : []).map((x) => String(x).toLowerCase()));
  // "Never flag this again" from Reject (seo_settings/main.proofIgnore: "type|text")
  const skip = new Set((Array.isArray(w.settings?.proofIgnore) ? w.settings.proofIgnore : []).map((x) => String(x).toLowerCase()));
  return d.ai.issues
    .filter((i) => !((i.type === "spelling" || i.type === "au") && ok.has(String(i.text).toLowerCase())))
    .filter((i) => !skip.has(i.type + "|" + String(i.text).toLowerCase()))
    .map((i) => {
      const id = contentIssueId(d.path || path, i);
      const st = w.health.status?.[id] || null;
      let rejects = [];
      try { rejects = st?.rejects ? JSON.parse(st.rejects) : []; } catch { rejects = []; }
      return { ...i, id, path: d.path || path, st, rejects,
        ignored: st?.status === "ignored", fixed: st?.status === "fixed" };
    });
}

function freshWhy(d) {
  const out = [];
  if (d.mod) {
    const months = Math.floor((Date.now() - Date.parse(d.mod + "T00:00:00Z")) / (30.4 * 864e5));
    if (months >= 12) out.push(`Not updated in WordPress for ${months} months`);
  }
  if (!d.reviewed) out.push("No “medically reviewed by” line");
  if ((d.inbound || 0) < 3) out.push(`Only ${plural(d.inbound || 0, "other page")} link${(d.inbound || 0) === 1 ? "s" : ""} here`);
  if (d.words && d.words < 300) out.push(`Only about ${d.words} words`);
  return out;
}

function mark(ctx, text) {
  const s = String(ctx || ""), t = String(text || "");
  const at = s.toLowerCase().indexOf(t.toLowerCase());
  if (at < 0 || !t) return esc(s);
  return esc(s.slice(0, at)) + `<mark class="seo-ct-hi">${esc(s.slice(at, at + t.length))}</mark>` + esc(s.slice(at + t.length));
}

/* ---------- the view ---------- */

export function contentHtml(c, ui) {
  injectCss();
  const w = c.work, H = w.health, h = c.h;
  const C = H?.content;
  if (!C) {
    return `<div class="seo-empty">Content checks haven't run yet. In Apps Script, run <code>runSeoContent()</code> once
      (it takes a minute or two), then <code>installSeoContentTrigger()</code>.</div>`;
  }
  const cat = ui.ccat || "spell";
  const showIgn = !!ui.cign;
  const canWork = c.can("seo.work"), canManage = c.can("seo.manage");
  const st = C.state || {};
  const deep = Object.values(C.deep || {}).filter((d) => d && d.path);
  const issues = deep.flatMap((d) => contentIssues(w, d.path));
  const dupsAll = (C.dups || []).map((x) => {
    const id = dupId(x.a, x.b);
    const s = H.status?.[id] || null;
    return { ...x, id, st: s, ignored: s?.status === "ignored" };
  });
  const consistAll = (C.consist || []).map((g) => {
    const id = groupId(g.key);
    const s = H.status?.[id] || null;
    return { ...g, id, st: s, ignored: s?.status === "ignored" };
  });
  const noFaq = deep.filter((d) => !d.faq || !d.faqSchema);
  const fresh = deep.map((d) => ({ d, why: freshWhy(d) })).filter((x) => x.why.length);

  // Pages proofread so far. Before any are, the counts are unknown, not 0.
  const proofed = deep.filter((d) => d.ai).length;
  const open = (test) => issues.filter((i) => !i.ignored && !i.fixed && test(i.type));
  const openSpell = open(isProof), openAds = open((t) => t === "compliance"), openCons = open((t) => t === "consistency");
  const groupsOpen = consistAll.filter((g) => !g.ignored).length;
  const pagesIn = (list) => new Set(list.map((i) => npath(i.path))).size;
  const tiles = [
    ["spell", "Spelling and grammar", proofed ? openSpell.length : null,
      proofed ? `on ${plural(pagesIn(openSpell), "page")} · ${proofed} of ${deep.length} proofread` : `not proofread yet · ${deep.length} waiting`],
    ["dup", "Duplicate content", dupsAll.filter((x) => !x.ignored).length, "pairs of pages"],
    ["consist", "Consistency", proofed || consistAll.length ? groupsOpen + openCons.length : null,
      proofed || consistAll.length ? `${groupsOpen} across pages · ${openCons.length} within pages` : "not checked yet"],
    ["faq", "FAQs", noFaq.length, "pages to improve"],
    ["ads", "Advertising rules", proofed ? openAds.length : null, proofed ? "TGA and AHPRA" : "not proofread yet"],
    ["fresh", "Freshness and trust", fresh.length, "pages"],
  ];

  let body = "";
  if (cat === "spell" || cat === "ads") {
    const list = issues.filter((i) => (cat === "ads" ? i.type === "compliance" : isProof(i.type)) && i.ignored === showIgn);
    body = issuesHtml(c, list, canWork, canManage, cat, proofed);
  } else if (cat === "consist") {
    body = consistHtml(c, consistAll.filter((g) => g.ignored === showIgn),
      issues.filter((i) => i.type === "consistency" && i.ignored === showIgn), canWork, canManage, proofed);
  } else if (cat === "dup") {
    body = dupsHtml(c, dupsAll.filter((x) => x.ignored === showIgn), canWork);
  } else if (cat === "faq") {
    body = faqHtml(c, noFaq);
  } else {
    body = freshHtml(c, fresh);
  }

  // Warnings when the data is old: the nightly read (about 1am) or the proofreading (every 20 minutes)
  const readAge = hoursAgo(st.at), proofAge = hoursAgo(st.proofAt);
  const warns = [];
  if (st.ok === false) warns.push(`The last content check failed, so this may be out of date: ${esc(st.error || "")}`);
  else if (readAge != null && readAge > 36) {
    warns.push(`Pages were last read ${esc(whenC(st.at))}. This runs every night at about 1am, so it may be failing:
      in Apps Script, check Executions → runSeoContent.`);
  }
  if (st.aiLeft && (proofAge == null ? readAge != null && readAge > 3 : proofAge > 3)) {
    warns.push(`${plural(st.aiLeft, "page")} ${st.aiLeft === 1 ? "is" : "are"} waiting to be proofread, but proofreading hasn't run
      ${st.proofAt ? "since " + esc(whenC(st.proofAt)) : "yet"}. In Apps Script, check that runSeoProofread is in runPortalJobs.`);
  }

  return `
    ${warns.map((x) => `<div class="seo-warn">${x}</div>`).join("")}
    <div class="seo-ct-tiles">${tiles.map(([k, l, n, s]) => `<button type="button" class="seo-ct-tile${cat === k ? " is-on" : ""}" data-ch-cat="${k}">
      <span class="seo-note">${l}</span><strong>${n == null ? "—" : h.fmtInt(n)}</strong><span class="seo-note">${s}</span></button>`).join("")}</div>
    ${["spell", "ads", "dup", "consist"].includes(cat) ? `<div class="seo-row"><span class="seo-sp"></span>
      <button type="button" class="seo-w-chip ${showIgn ? "is-on" : ""}" data-ch-showign>${showIgn ? "Show open" : "Show ignored"}</button></div>` : ""}
    ${body}
    <p class="seo-note" style="margin-top:10px">Pages read ${esc(whenC(st.at))} (${st.deepRead || 0} of ${st.deepTotal || 0} priority and cluster pages) ·
      proofread ${st.proofAt ? esc(whenC(st.proofAt)) : "not yet"}${st.proofModel ? ` (${esc(st.proofModel)})` : ""} ·
      ${st.aiLeft ? `${plural(st.aiLeft, "page")} waiting (done every 20 minutes)` : proofed ? "all proofread" : "proofreading not started"} ·
      ${st.siteIndexed || 0} of ${st.siteTotal || 0} pages compared for duplicates (about 60 more each night).
      Menus, footers and text repeated on many pages aren't checked.</p>`;
}

// Terms written different ways across pages, then pages that contradict themselves
function consistHtml(c, groups, pageIssues, canWork, canManage, proofed) {
  if (!groups.length && !pageIssues.length) {
    return `<div class="seo-empty">${proofed ? "Nothing written different ways, and no page contradicts itself." : "Not checked yet."}</div>`;
  }
  const links = (paths) => paths.slice(0, 4).map((p) => {
    const pid = pageId(c, p);
    return pid ? `<button class="seo-w-link" type="button" data-open="${esc(pid)}">${esc(titleIn(c.work, p))}</button>` : esc(titleIn(c.work, p));
  }).join(", ") + (paths.length > 4 ? ` and ${paths.length - 4} more` : "");
  let out = "";
  if (groups.length) {
    out += `<div class="seo-card"><h3 style="margin:0 0 4px">Written different ways across your pages</h3>
      <p class="seo-note">Pick one way and use it everywhere. The most used is first (green). Hover a form to see its pages.</p>
      ${groups.map((g) => `<div class="seo-ct-row">
        <div class="seo-ct-forms">${g.forms.map((f, n) => `<span class="seo-pr-pill is-${n ? "amber" : "green"}" title="${esc(f.pages.join(", "))}">${esc(f.f)} <em>×${f.n}</em></span>`).join("")}</div>
        <div class="seo-note">Suggested: use <b class="seo-ct-fix">${esc(g.forms[0].f)}</b> everywhere.
          ${g.forms.slice(1).map((f) => `“${esc(f.f)}” is on ${links(f.pages)}`).join(" · ")}</div>
        ${g.ignored ? `<div class="seo-note">Ignored by ${esc(g.st?.byName || "someone")}${g.st?.note ? `: ${esc(g.st.note)}` : ""}</div>` : ""}
        ${canWork ? `<div class="seo-w-acts">${g.ignored ? `<button class="seo-btn" type="button" data-ch-undo="${esc(g.id)}">Back to open</button>`
          : `<button class="seo-btn" type="button" data-ch-ign="${esc(g.id)}">Ignore</button>`}</div>` : ""}
      </div>`).join("")}</div>`;
  }
  if (pageIssues.length) {
    out += `<h3 style="margin:16px 0 8px;font-size:14px">Pages that contradict themselves</h3>` + issuesHtml(c, pageIssues, canWork, canManage, "consist", proofed);
  }
  return out;
}


function issuesHtml(c, list, canWork, canManage, cat, proofed = 1) {
  if (!list.length) {
    if (!proofed) {
      return `<div class="seo-empty">These pages haven't been proofread yet. Proofreading runs every 20 minutes until every priority and cluster page is done.</div>`;
    }
    return `<div class="seo-empty">${cat === "ads" ? "No advertising rule problems found." : cat === "consist" ? "No page contradicts itself."
      : "No spelling or grammar mistakes found."}</div>`;
  }
  const by = new Map();
  list.forEach((i) => { const k = npath(i.path); if (!by.has(k)) by.set(k, []); by.get(k).push(i); });
  return [...by.values()].map((arr) => {
    const pid = pageId(c, arr[0].path);
    const left = arr.filter((i) => !i.fixed).length;
    return `<div class="seo-card seo-ct-page">
      <div class="seo-row" style="margin:0 0 2px"><strong>${esc(titleIn(c.work, arr[0].path))}</strong>
        <span class="seo-note">${left ? `${plural(left, "thing")} to fix` : "all fixed ✓"}</span><span class="seo-sp"></span>
        ${pid ? `<button class="seo-btn" type="button" data-open="${esc(pid)}">Open page details</button>` : ""}</div>
      <div class="seo-note seo-w-mono">${esc(arr[0].path)}</div>
      ${arr.map((i) => fixRow(c, i, canWork, canManage)).join("")}
    </div>`;
  }).join("") + `<p class="seo-note">Accept changes the wording on the live website straight away and adds it to the Change log.
    Elementor and normal pages both work. If the words are in a header, footer or template, or have bold or a link inside them,
    it tells you to change them in WordPress instead.</p>`;
}

// One problem: what's wrong, the fix, and Accept / Reject / Regenerate (or the result)
function fixRow(c, i, canWork, canManage) {
  const [lab, tone] = TYPE[i.type] || ["Check", "grey"];
  const canFix = c.can("seo.fix");
  const isWord = i.type === "spelling" || i.type === "au";
  const f = FX.get(i.id) || {};
  const fix = f.pick != null ? f.pick : i.fix || "";
  const head = `<span class="seo-pr-pill is-${tone}">${lab}</span><div class="seo-ct-q">${mark(i.ctx, i.text)}</div>`;
  const errBox = f.err ? `<div class="seo-ct-err">${esc(f.err)}${f.editUrl
    ? ` <a class="seo-w-link" href="${esc(f.editUrl)}" target="_blank" rel="noopener">Edit in WordPress ↗</a>` : ""}</div>` : "";

  // Done: changed on the website
  if (i.fixed) {
    const s = i.st || {};
    const seen = s.checked === false ? "" : s.verified ? " · seen on the live page"
      : " · not showing on the live page yet (the page cache can take a minute)";
    return `<div class="seo-ct-row is-fixed">${head}
      <div class="seo-ct-done">✓ Updated on the website: “${esc(s.from || i.text)}” → <b class="seo-ct-fix">${esc(s.to || "")}</b>${
        Number(s.count) > 1 ? ` <span class="seo-note">(${s.count} places)</span>` : ""}
        <div class="seo-note">${esc(s.byName || "")}${s.at ? " · " + esc(whenC(s.at)) : ""}${seen}</div>
        <div class="seo-w-acts">
          ${s.link ? `<a class="seo-btn on" href="${esc(s.link)}" target="_blank" rel="noopener">View live page ↗</a>` : ""}
          ${canFix ? `<button class="seo-btn" type="button" data-ch-fundo="${esc(i.id)}"${f.busy ? " disabled" : ""}>${
            f.busy === "undo" ? "Undoing…" : "Undo"}</button>` : ""}
        </div>${errBox}
        <p class="seo-note" style="margin:4px 0 0">It drops off this list after tonight's check.</p></div></div>`;
  }

  // Ignored: as before
  if (i.ignored) {
    return `<div class="seo-ct-row">${head}
      <div class="seo-note">Ignored by ${esc(i.st?.byName || "someone")}${i.st?.note ? `: ${esc(i.st.note)}` : ""}</div>
      ${canWork || canFix ? `<div class="seo-w-acts"><button class="seo-btn" type="button" data-ch-undo="${esc(i.id)}">Back to open</button></div>` : ""}</div>`;
  }

  const sug = fix
    ? `${i.type === "compliance" ? "Suggested" : "Change to"}: <b class="seo-ct-fix">${esc(fix)}</b>${i.why ? ` · ${esc(i.why)}` : ""}`
    : `${i.why ? esc(i.why) + " · " : ""}No wording suggested yet: press Regenerate.`;
  const rej = i.rejects.length ? `<div class="seo-note">Rejected before: ${i.rejects.slice(-2).map((r) =>
    `“${esc(r.text)}” (${esc(r.reason)}${r.byName ? `, ${esc(r.byName)}` : ""})`).join(" · ")}</div>` : "";
  const opts = (f.opts || []).length ? `<div class="seo-ct-opts"><div class="seo-note">Pick the wording to use:</div>
    ${f.opts.map((o, n) => `<button type="button" class="seo-ct-opt${fix === o.text ? " is-on" : ""}${(o.flags || []).length ? " is-flag" : ""}"
        data-ch-pick="${esc(i.id)}|${n}"><span>${esc(o.text)}</span>${o.why ? `<small>${esc(o.why)}</small>` : ""}${
        (o.flags || []).map((x) => `<small class="seo-ct-flagt">⚠ ${esc(x)}</small>`).join("")}</button>`).join("")}
    ${i.fix ? `<button type="button" class="seo-ct-opt${fix === i.fix ? " is-on" : ""}" data-ch-pick="${esc(i.id)}|orig">
      <span>${esc(i.fix)}</span><small>The first suggestion</small></button>` : ""}</div>` : "";
  const rejForm = f.reject ? `<div class="seo-ct-rej">
    <label class="seo-note" style="display:block">Why are you rejecting it? (Claude is told, so it learns)
      <textarea class="seo-input" rows="2" maxlength="300" data-ch-why placeholder="e.g. we always write skin care as two words"></textarea></label>
    ${[["keep", "Keep it on the list, just not this suggestion"], ["here", "Ignore it on this page"],
      ["everywhere", isWord ? `Never flag “${esc(i.text)}” again (adds it to your words)` : "Never flag this again, on any page"]]
      .map(([v, l]) => `<label class="seo-check"><input type="radio" name="sc_${esc(i.id)}" value="${v}"${v === "here" ? " checked" : ""}> ${l}</label>`).join("")}
    <div class="seo-w-acts"><button class="seo-btn on" type="button" data-ch-rejok="${esc(i.id)}"${f.busy ? " disabled" : ""}>${
      f.busy === "reject" ? "Saving…" : "Reject"}</button>
      <button class="seo-btn" type="button" data-ch-rejno="${esc(i.id)}">Cancel</button></div></div>` : "";

  const acts = canFix ? `
      <button class="seo-btn on" type="button" data-ch-accept="${esc(i.id)}"${!fix || f.busy ? " disabled" : ""}
        title="${fix ? "Change it on the live website now" : "Press Regenerate for wording to use"}">${f.busy === "accept" ? "Updating the website…" : "✓ Accept change"}</button>
      <button class="seo-btn" type="button" data-ch-rej="${esc(i.id)}"${f.busy ? " disabled" : ""}>✕ Reject</button>
      <button class="seo-btn" type="button" data-ch-regen="${esc(i.id)}"${f.busy ? " disabled" : ""}>${
        f.busy === "regen" ? "Writing options…" : "↻ Regenerate"}</button>`
    : canWork ? `<button class="seo-btn" type="button" data-ch-ign="${esc(i.id)}">Ignore</button>` : "";

  return `<div class="seo-ct-row">${head}
    <div class="seo-note">${sug}</div>${rej}${opts}
    <div class="seo-w-acts">${acts}
      ${isWord && canManage && !canFix ? `<button class="seo-btn" type="button" data-ch-word="${esc(i.text)}">Add to my words</button>` : ""}
    </div>${rejForm}${errBox}</div>`;
}


function dupsHtml(c, list, canWork) {
  if (!list.length) return `<div class="seo-empty">No pages that say nearly the same thing, among the pages compared so far.</div>`;
  const line = (p) => {
    const pid = pageId(c, p);
    return `<div class="seo-ct-pp"><strong>${esc(titleIn(c.work, p))}</strong><div class="seo-note seo-w-mono">${esc(p)}</div>
      ${pid ? `<button class="seo-w-link" type="button" data-open="${esc(pid)}">Open page details</button>` : ""}</div>`;
  };
  return list.map((x) => `<div class="seo-card">
    <div class="seo-row" style="margin:0 0 6px"><span class="seo-pr-pill is-${x.sim >= 70 ? "red" : "amber"}">${x.sim}% the same</span>
      <strong>${plural(x.shared, "paragraph")} repeat</strong></div>
    <div class="seo-ct-pair">${line(x.a)}${line(x.b)}</div>
    ${x.sample ? `<div class="seo-ct-q">“${esc(x.sample)}…”</div>` : ""}
    <p class="seo-note" style="margin:6px 0 0">Google usually shows only one of two near-identical pages. Make one the main page and merge the other
      into it (SEO → Pages → Clusters), or rewrite one so it answers a different question.</p>
    ${x.ignored ? `<p class="seo-note">Ignored by ${esc(x.st?.byName || "someone")}${x.st?.note ? `: ${esc(x.st.note)}` : ""}</p>` : ""}
    <div class="seo-w-acts"><button class="seo-btn on" type="button" data-cmp2="${esc(x.a)}|${esc(x.b)}">Compare them head to head</button></div>
    ${canWork ? `<div class="seo-w-acts">${x.ignored ? `<button class="seo-btn" type="button" data-ch-undo="${esc(x.id)}">Back to open</button>`
      : `<button class="seo-btn" type="button" data-ch-ign="${esc(x.id)}">Ignore</button>`}</div>` : ""}
  </div>`).join("");
}

function faqHtml(c, list) {
  if (!list.length) return `<div class="seo-empty">Every priority and cluster page has an FAQ section with FAQ schema.</div>`;
  const w = c.work;
  return list.map((d) => {
    const me = npath(d.path);
    const qs = (w.queries || []).filter((q) => q.topic !== "__brand" && QUESTION.test(q.q))
      .map((q) => ({ q: q.q, x: q.pages.find((p) => npath(p.path) === me) })).filter((r) => r.x)
      .sort((a, b) => b.x.i - a.x.i).slice(0, 4);
    const pid = pageId(c, d.path);
    return `<div class="seo-card">
      <div class="seo-row" style="margin:0 0 2px"><span class="seo-pr-pill is-amber">${d.faq ? "No FAQ schema" : "No FAQ section"}</span>
        <strong>${esc(titleIn(w, d.path))}</strong><span class="seo-sp"></span>
        ${pid ? `<button class="seo-btn" type="button" data-open="${esc(pid)}">Open page details</button>` : ""}</div>
      ${d.faq ? `<p class="seo-note" style="margin:4px 0 0">The page has questions, but no FAQ schema. Rebuild them with your SEO plugin's FAQ block
          (Yoast or Rank Math), so Google can read them and show them in search.</p>`
        : qs.length ? `<p class="seo-note" style="margin:4px 0 2px">People search these, so they make good FAQ questions:</p>
          <ul class="seo-ct-qs">${qs.map((r) => `<li>${esc(r.q)} <span class="seo-note">(${c.h.fmtInt(r.x.i)} impressions)</span></li>`).join("")}</ul>
          <p class="seo-note" style="margin:0">Answer each in 2–3 sentences, using your SEO plugin's FAQ block so the page also gets FAQ schema.</p>`
        : `<p class="seo-note" style="margin:4px 0 0">Add 3–5 questions patients ask at consultations (cost, sessions, downtime, results), using your SEO
          plugin's FAQ block so the page also gets FAQ schema.</p>`}
    </div>`;
  }).join("") + `<p class="seo-note">On priority pages these are also steps in Tasks.</p>`;
}

function freshHtml(c, list) {
  if (!list.length) return `<div class="seo-empty">Every priority and cluster page looks current and well supported.</div>`;
  return `<div class="seo-card">${list.map(({ d, why }) => {
    const pid = pageId(c, d.path);
    return `<div class="seo-ct-row">
      <div class="seo-row" style="margin:0"><strong>${esc(titleIn(c.work, d.path))}</strong><span class="seo-sp"></span>
        ${pid ? `<button class="seo-w-link" type="button" data-open="${esc(pid)}">Open page details</button>` : ""}</div>
      <div>${why.map((x) => `<span class="seo-pr-pill is-grey" style="margin:2px 4px 0 0">${esc(x)}</span>`).join("")}</div></div>`;
  }).join("")}</div>
  <p class="seo-note">Links counted from the pages compared so far, so the numbers grow over the first week.</p>`;
}

/* ---------- clicks (called by seo-health.js) ---------- */

export async function contentClick(e, c, ui, redraw) {
  const t = e.target.closest("[data-ch-cat],[data-ch-ign],[data-ch-undo],[data-ch-word],[data-ch-showign]," +
    "[data-ch-accept],[data-ch-rej],[data-ch-rejok],[data-ch-rejno],[data-ch-regen],[data-ch-pick],[data-ch-fundo]");
  if (!t) return false;
  const d = t.dataset, w = c.work, H = w.health;
  if (d.chCat) { ui.ccat = d.chCat; ui.cign = false; redraw(); return true; }
  if (d.chShowign !== undefined) { ui.cign = !ui.cign; redraw(); return true; }
  const fxId = d.chAccept || d.chRej || d.chRejok || d.chRejno || d.chRegen || d.chFundo || (d.chPick ? d.chPick.split("|")[0] : "");
  if (fxId) { await fixClick(t, d, fxId, c, redraw); return true; }

  if (d.chWord) {
    const word = d.chWord.toLowerCase().slice(0, 40);
    t.disabled = true;
    try {
      await setDoc(doc(db, "seo_settings", "main"),
        { spellWords: arrayUnion(word), updatedBy: auth.currentUser?.uid || "", updatedAt: serverTimestamp() }, { merge: true });
      w.settings = { ...(w.settings || {}), spellWords: [...new Set([...(w.settings?.spellWords || []), word])] };
      toast(`“${word}” won't be flagged again`);
      redraw();
    } catch (err) { t.disabled = false; toast(/permission/i.test(err.message || "") ? "You need SEO settings access to add words." : err.message, true); }
    return true;
  }

  const id = d.chIgn || d.chUndo;
  const deep = Object.values(H?.content?.deep || {});
  let item = deep.flatMap((x) => contentIssues(w, x.path)).find((i) => i.id === id);
  let key, label, path;
  if (item) { key = item.type + ":" + item.text; label = `${(TYPE[item.type] || ["Check"])[0]}: ${item.text}`; path = item.path; }
  else {
    const dd = (H?.content?.dups || []).find((x) => dupId(x.a, x.b) === id);
    const g = dd ? null : (H?.content?.consist || []).find((x) => groupId(x.key) === id);
    if (dd) { key = "dup:" + npath(dd.a) + "|" + npath(dd.b); label = `Duplicate content: ${dd.a} and ${dd.b}`; path = dd.a; }
    else if (g) {
      key = "consist:" + g.key; label = `Written different ways: ${g.forms.map((f) => f.f).join(" / ")}`;
      path = g.forms[0]?.pages?.[0] || "/";
    } else return true;
  }
  let note = "";
  if (d.chIgn) {
    note = prompt("Why ignore this? (optional)", "");
    if (note === null) return true;
  }
  t.disabled = true;
  try {
    const data = {
      key: key.slice(0, 300), label: label.slice(0, 300), path, status: d.chIgn ? "ignored" : "open",
      note: String(note || "").slice(0, 1000), by: auth.currentUser?.uid || "",
      byName: c.staff?.name || c.staff?.displayName || auth.currentUser?.displayName || "", at: serverTimestamp(),
    };
    await setDoc(doc(db, "seo_issues", id), data);
    H.status = H.status || {};
    H.status[id] = { ...data, at: new Date() };
    toast(d.chIgn ? "Ignored" : "Back on the list");
    redraw();
  } catch (err) { t.disabled = false; toast(/permission/i.test(err.message || "") ? "You don't have permission to do that." : err.message, true); }
  return true;
}
/* ---------- Accept, Reject, Regenerate, Undo (Apps Script: wordpress → fixApply / fixReject / fixRegen / fixUndo) ---------- */

async function fixClick(t, d, id, c, redraw) {
  const w = c.work, H = w.health;
  H.status = H.status || {};
  const item = Object.values(H?.content?.deep || {}).flatMap((x) => contentIssues(w, x.path)).find((i) => i.id === id);
  if (!item) return;
  const f = FX.get(id) || {};
  FX.set(id, f);
  const base = { issueId: id, path: item.path, text: item.text, type: item.type };
  const fail = (err) => { f.err = fixErr(err); f.editUrl = err?.editUrl || ""; };
  const fixNow = f.pick != null ? f.pick : item.fix || "";

  if (d.chPick) {
    const n = d.chPick.split("|")[1];
    f.pick = n === "orig" ? item.fix : (f.opts || [])[Number(n)]?.text ?? f.pick;
    f.err = "";
    redraw();
    return;
  }
  if (d.chRej) { f.reject = !f.reject; f.err = ""; redraw(); return; }
  if (d.chRejno) { f.reject = false; redraw(); return; }

  if (d.chAccept) {
    if (!fixNow) return;
    const many = item.type === "spelling" || item.type === "au";
    if (!confirm(`Change “${item.text}” to “${fixNow}” on the live website now?${many ? "\n\nEvery place this spelling appears on the page is changed." : ""}`)) return;
    f.busy = "accept"; f.err = ""; redraw();
    try {
      const r = await fixApi("fixApply", { ...base, fix: fixNow });
      H.status[id] = r.rec;
      FX.delete(id);
      toast("Updated on the website ✓");
    } catch (err) { fail(err); }
    finally { f.busy = ""; redraw(); }
    return;
  }

  if (d.chRegen) {
    f.busy = "regen"; f.err = ""; redraw();
    try {
      const r = await fixApi("fixRegen", base);
      f.opts = Array.isArray(r.options) ? r.options : [];
      const firstOk = f.opts.find((o) => !(o.flags || []).length);
      if (firstOk) f.pick = firstOk.text;
      if (!f.opts.length) f.err = "No new wording came back. Try again.";
    } catch (err) { fail(err); }
    finally { f.busy = ""; redraw(); }
    return;
  }

  if (d.chRejok) {
    const box = t.closest(".seo-ct-rej");
    const reason = String(box?.querySelector("[data-ch-why]")?.value || "").trim();
    const scope = box?.querySelector('input[type="radio"]:checked')?.value || "here";
    if (reason.length < 3) { f.err = "Add a short reason, so Claude knows not to suggest it again."; redraw(); return; }
    f.busy = "reject"; f.err = ""; redraw();
    try {
      const r = await fixApi("fixReject", { ...base, reason, scope, fix: fixNow });
      H.status[id] = r.rec;
      if (r.settings) w.settings = { ...(w.settings || {}), ...r.settings };
      FX.delete(id);
      toast(scope === "keep" ? "Rejected. It stays on the list: press Regenerate for other wording."
        : scope === "everywhere" ? "It won't be flagged again" : "Ignored on this page");
    } catch (err) { fail(err); }
    finally { f.busy = ""; redraw(); }
    return;
  }

  if (d.chFundo) {
    if (!confirm("Put the old wording back on the live website?")) return;
    f.busy = "undo"; f.err = ""; redraw();
    try {
      const r = await fixApi("fixUndo", { issueId: id });
      H.status[id] = r.rec;
      toast("Put back");
    } catch (err) { fail(err); }
    finally { f.busy = ""; redraw(); }
  }
}
/* ---------- styles ---------- */

const CSS = `
.seo-ct-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px}
.seo-ct-tile{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--card,#fff);font:inherit;text-align:left;cursor:pointer;color:inherit}
.seo-ct-tile strong{font-size:22px}
.seo-ct-tile:hover{border-color:#93c5fd}
.seo-ct-tile.is-on{border-color:var(--accent,#2563eb);box-shadow:0 0 0 1px var(--accent,#2563eb)}
.seo-ct-page .seo-ct-row:first-of-type{margin-top:6px}
.seo-ct-row{padding:9px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-ct-q{margin:6px 0;padding:8px 10px;border-radius:8px;background:#f8fafc;font-size:13px;line-height:1.55}
.seo-ct-hi{background:#fee2e2;color:#991b1b;border-radius:3px;padding:0 2px}
.seo-ct-fix{background:#dcfce7;color:#166534;border-radius:3px;padding:0 3px;font-weight:600}
.seo-ct-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.seo-ct-pp{padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;font-size:13px;min-width:0}
.seo-ct-qs{margin:2px 0 6px;padding-left:18px;font-size:13px}
.seo-pr-pill.is-blue{background:#eff6ff;color:#1d4ed8}
.seo-pr-pill.is-violet{background:#f5f3ff;color:#6d28d9}
.seo-pr-pill.is-green{background:#ecfdf5;color:#047857}
.seo-ct-forms{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
.seo-ct-forms .seo-pr-pill{cursor:help}
.seo-ct-forms em{font-style:normal;opacity:.7;margin-left:2px}
.seo-ct-row.is-fixed .seo-ct-q{opacity:.6}
.seo-ct-done{margin:6px 0 0;padding:10px 12px;border-radius:8px;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;font-size:13px}
.seo-ct-done .seo-w-acts a.seo-btn{text-decoration:none}
.seo-ct-err{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;font-size:13px}
.seo-ct-opts{display:grid;gap:6px;margin:8px 0 0}
.seo-ct-opt{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;
  background:var(--card,#fff);font:inherit;font-size:13px;text-align:left;cursor:pointer;color:inherit}
.seo-ct-opt:hover{border-color:#93c5fd}
.seo-ct-opt.is-on{border-color:#16a34a;background:#f0fdf4;box-shadow:0 0 0 1px #16a34a}
.seo-ct-opt.is-flag{border-color:#fcd34d}
.seo-ct-opt small{font-size:11.5px;color:var(--text-muted,#6b7280)}
.seo-ct-opt small.seo-ct-flagt{color:#b45309}
.seo-ct-rej{margin:8px 0 0;padding:10px 12px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:#f8fafc}
.seo-ct-rej textarea{display:block;width:100%;min-width:0;margin:4px 0 6px;box-sizing:border-box;resize:vertical}
.seo-ct-rej .seo-check{margin:2px 0}

@media (max-width:640px){.seo-ct-pair{grid-template-columns:1fr}}
`;

function injectCss() {
  if (document.getElementById("seo-content-css")) return;
  const s = document.createElement("style");
  s.id = "seo-content-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}