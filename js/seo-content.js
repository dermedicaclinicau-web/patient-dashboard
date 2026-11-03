// seo-content.js — Site health → Content: spelling and grammar, duplicate content, FAQs, advertising rules, freshness.
// Reads what Seo9.gs saves each night (loaded by seo-health.js into work.health.content).
// Ignoring uses seo_issues, like the rest of Site health. "Add to my words" adds to seo_settings/main.spellWords.
// Used by seo-health.js (the view) and seo-tasks.js (tasks). Imports nothing from seo-work.js.

import { db, auth } from "./firebase-config.js";
import { doc, setDoc, serverTimestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const TYPE = { spelling: ["Spelling", "red"], grammar: ["Grammar", "amber"], au: ["Australian English", "blue"], compliance: ["Advertising rules", "red"] };
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
  return d.ai.issues
    .filter((i) => !((i.type === "spelling" || i.type === "au") && ok.has(String(i.text).toLowerCase())))
    .map((i) => {
      const id = contentIssueId(d.path || path, i);
      const st = w.health.status?.[id] || null;
      return { ...i, id, path: d.path || path, st, ignored: st?.status === "ignored" };
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
      (it takes a few minutes), then <code>installSeoContentTrigger()</code>.</div>`;
  }
  const cat = ui.ccat || "spell";
  const showIgn = !!ui.cign;
  const canWork = c.can("seo.work"), canManage = c.can("seo.manage");
  const deep = Object.values(C.deep || {}).filter((d) => d && d.path);
  const issues = deep.flatMap((d) => contentIssues(w, d.path));
  const dupsAll = (C.dups || []).map((x) => {
    const id = dupId(x.a, x.b);
    const st = H.status?.[id] || null;
    return { ...x, id, st, ignored: st?.status === "ignored" };
  });
  const noFaq = deep.filter((d) => !d.faq || !d.faqSchema);
  const fresh = deep.map((d) => ({ d, why: freshWhy(d) })).filter((x) => x.why.length);
  const openSpell = issues.filter((i) => !i.ignored && i.type !== "compliance");
  const openAds = issues.filter((i) => !i.ignored && i.type === "compliance");
  const tiles = [
    ["spell", "Spelling and grammar", openSpell.length, `on ${plural(new Set(openSpell.map((i) => npath(i.path))).size, "page")}`],
    ["dup", "Duplicate content", dupsAll.filter((x) => !x.ignored).length, "pairs of pages"],
    ["faq", "FAQs", noFaq.length, "pages to improve"],
    ["ads", "Advertising rules", openAds.length, "TGA and AHPRA"],
    ["fresh", "Freshness and trust", fresh.length, "pages"],
  ];

  let body = "";
  if (cat === "spell" || cat === "ads") {
    const list = issues.filter((i) => (cat === "ads" ? i.type === "compliance" : i.type !== "compliance") && i.ignored === showIgn);
    body = issuesHtml(c, list, canWork, canManage, cat);
  } else if (cat === "dup") {
    body = dupsHtml(c, dupsAll.filter((x) => x.ignored === showIgn), canWork);
  } else if (cat === "faq") {
    body = faqHtml(c, noFaq);
  } else {
    body = freshHtml(c, fresh);
  }

  const st = C.state || {};
  const when = (t) => { const d = t?.toDate ? t.toDate() : t ? new Date(t) : null; return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""; };
  return `
    ${st.ok === false ? `<div class="seo-warn">The last content check failed, so this may be out of date: ${esc(st.error || "")}</div>` : ""}
    <div class="seo-ct-tiles">${tiles.map(([k, l, n, s]) => `<button type="button" class="seo-ct-tile${cat === k ? " is-on" : ""}" data-ch-cat="${k}">
      <span class="seo-note">${l}</span><strong>${h.fmtInt(n)}</strong><span class="seo-note">${s}</span></button>`).join("")}</div>
    ${["spell", "ads", "dup"].includes(cat) ? `<div class="seo-row"><span class="seo-sp"></span>
      <button type="button" class="seo-w-chip ${showIgn ? "is-on" : ""}" data-ch-showign>${showIgn ? "Show open" : "Show ignored"}</button></div>` : ""}
    ${body}
    <p class="seo-note" style="margin-top:10px">Checked ${esc(when(st.at))} · ${st.deepRead || 0} of ${st.deepTotal || 0} priority and cluster pages read ·
      ${st.siteIndexed || 0} of ${st.siteTotal || 0} pages compared for duplicates (about 60 more each night) ·
      ${st.aiLeft ? `${st.aiLeft} page${st.aiLeft === 1 ? "" : "s"} waiting to be proofread` : "all proofread"}.
      Menus, footers and text repeated on many pages aren't checked.</p>`;
}

function issuesHtml(c, list, canWork, canManage, cat) {
  if (!list.length) {
    return `<div class="seo-empty">${cat === "ads" ? "No advertising rule problems found." : "No spelling or grammar mistakes found."}</div>`;
  }
  const by = new Map();
  list.forEach((i) => { const k = npath(i.path); if (!by.has(k)) by.set(k, []); by.get(k).push(i); });
  return [...by.values()].map((arr) => {
    const pid = pageId(c, arr[0].path);
    return `<div class="seo-card seo-ct-page">
      <div class="seo-row" style="margin:0 0 2px"><strong>${esc(titleIn(c.work, arr[0].path))}</strong>
        <span class="seo-note">${plural(arr.length, "thing")} to fix</span><span class="seo-sp"></span>
        ${pid ? `<button class="seo-btn" type="button" data-open="${esc(pid)}">Open page details</button>` : ""}</div>
      <div class="seo-note seo-w-mono">${esc(arr[0].path)}</div>
      ${arr.map((i) => {
        const [lab, tone] = TYPE[i.type] || ["Check", "grey"];
        return `<div class="seo-ct-row">
          <span class="seo-pr-pill is-${tone}">${lab}</span>
          <div class="seo-ct-q">${mark(i.ctx, i.text)}</div>
          <div class="seo-note">${i.type === "compliance"
            ? `${esc(i.why)}${i.fix ? ` Suggested: <b class="seo-ct-fix">${esc(i.fix)}</b>` : ""}`
            : `Change to <b class="seo-ct-fix">${esc(i.fix)}</b>${i.why ? ` · ${esc(i.why)}` : ""}`}</div>
          ${i.ignored ? `<div class="seo-note">Ignored by ${esc(i.st?.byName || "someone")}${i.st?.note ? `: ${esc(i.st.note)}` : ""}</div>` : ""}
          <div class="seo-w-acts">
            ${(i.type === "spelling" || i.type === "au") && canManage && !i.ignored ? `<button class="seo-btn" type="button" data-ch-word="${esc(i.text)}">Add to my words</button>` : ""}
            ${canWork ? (i.ignored ? `<button class="seo-btn" type="button" data-ch-undo="${esc(i.id)}">Back to open</button>`
              : `<button class="seo-btn" type="button" data-ch-ign="${esc(i.id)}">Ignore</button>`) : ""}
          </div></div>`;
      }).join("")}
    </div>`;
  }).join("") + `<p class="seo-note">On priority pages these are also steps in Tasks. A fix disappears after the next nightly check.</p>`;
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
  const t = e.target.closest("[data-ch-cat],[data-ch-ign],[data-ch-undo],[data-ch-word],[data-ch-showign]");
  if (!t) return false;
  const d = t.dataset, w = c.work, H = w.health;
  if (d.chCat) { ui.ccat = d.chCat; ui.cign = false; redraw(); return true; }
  if (d.chShowign !== undefined) { ui.cign = !ui.cign; redraw(); return true; }

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
    if (!dd) return true;
    key = "dup:" + npath(dd.a) + "|" + npath(dd.b); label = `Duplicate content: ${dd.a} and ${dd.b}`; path = dd.a;
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
@media (max-width:640px){.seo-ct-pair{grid-template-columns:1fr}}
`;

function injectCss() {
  if (document.getElementById("seo-content-css")) return;
  const s = document.createElement("style");
  s.id = "seo-content-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}