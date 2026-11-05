// seo-advisor.js — SEO → Advisor: ask about a goal, a page or anything else, and get a visual, step-by-step answer.
// Questions go to seo_advisor_msgs (status 'new'). Seo10.gs answers them (about a minute), using read-only lookups,
// and writes its progress and the answer back to the same message, which this page shows live.
// Conversations: seo_advisor/{id} { title, kind, page, createdBy, byName, createdAt, updatedAt, status, tracked, busy, goal }

import { db, auth } from "./firebase-config.js";
import {
  doc, collection, query, where, orderBy, limit, onSnapshot, writeBatch, updateDoc, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { npath, titleOf, pageIndex, pageOf } from "./seo-work.js?v=17";
import { stashPostDraft } from "./seo-post.js?v=1";

const MODES = [["auto", "Anything"], ["goal", "A goal"], ["page", "A page"], ["question", "A question"]];
const EXAMPLES = [
  ["goal", "Boost our skin lifting pages for December"],
  ["goal", "Rank in the top 3 for “wrinkle treatment perth” by March"],
  ["page", "How do I improve the neck pigmentation page?"],
  ["page", "Why is the Ultherapy page dropping, and what should we do?"],
  ["question", "Why did clicks change over the last 2 weeks?"],
  ["question", "Which pages should we merge or improve first?"],
];
const KIND = { goal: ["Goal", "goal"], page: ["Page review", "page"], question: ["Question", "q"] };

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const uid = () => auth.currentUser?.uid || "";
const myName = (c) => c.staff?.name || c.staff?.displayName || auth.currentUser?.displayName || "";
const roleOf = (c) => String(c.staff?.role || c.staff?.staffRole || (c.isAdmin ? "Admin" : ""));
const canAsk = (c) => !!c.isAdmin || /^seo$/i.test(roleOf(c));
const tsDate = (t) => (t?.toDate ? t.toDate() : t ? new Date(t) : null);
const when = (t) => { const d = tsDate(t); return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fmtDay = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
function addYears(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y + n, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}
function copyText(txt) {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(txt).then(() => true).catch(fallback);
  return Promise.resolve(fallback());
}

/* ---------- drafts: show and copy ---------- */

function richText(text) {   // "## " headings, "- " bullets, paragraphs
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`); list = []; } };
  String(text || "").split(/\n+/).forEach((l) => {
    const t = l.trim();
    if (!t) return;
    if (/^#{1,3}\s/.test(t)) { flush(); out.push(`<h4>${esc(t.replace(/^#{1,3}\s*/, ""))}</h4>`); }
    else if (/^[-•*]\s/.test(t)) list.push(t.replace(/^[-•*]\s*/, ""));
    else { flush(); out.push(`<p>${esc(t)}</p>`); }
  });
  flush();
  return out.join("");
}
function draftPlain(d) {
  if (d.type === "faq") return (d.items || []).map((x) => `${x.q}\n${x.a}`).join("\n\n");
  if (d.type === "title_meta") return `Title: ${d.title || ""}\nDescription: ${d.description || ""}`;
  if (d.type === "email") return `Subject: ${d.subject || ""}\n\n${d.text || ""}`;
  return String(d.text || "").replace(/^#{1,3}\s*/gm, "").replace(/^[-•*]\s*/gm, "• ");
}
function draftHtml(d) {
  if (d.type === "faq") return (d.items || []).map((x) => `<h3>${esc(x.q)}</h3>\n<p>${esc(x.a)}</p>`).join("\n");
  if (d.type === "title_meta") return `<title>${esc(d.title || "")}</title>\n<meta name="description" content="${esc(d.description || "")}">`;
  if (d.type === "email") return `<p><strong>${esc(d.subject || "")}</strong></p>\n${richText(d.text).replace(/<h4>/g, "<h3>").replace(/<\/h4>/g, "</h3>")}`;
  return richText(d.text).replace(/<h4>/g, "<h3>").replace(/<\/h4>/g, "</h3>");
}
function faqSchema(d) {
  return `<script type="application/ld+json">\n${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: (d.items || []).map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) }, null, 2)}\n</script>`;
}

// Drafts that can start a blog post in SEO → Website
const POSTABLE = new Set(["faq", "section", "outline", "text"]);

// "# " / "## " headings, "### " subheadings, "- " bullets, "1. " numbered lists, **bold**, paragraphs
function mdToHtml(text) {
  const inl = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const out = [];
  let list = null, kind = "";
  const flush = () => { if (list) { out.push(`<${kind}>${list.map((x) => `<li>${inl(x)}</li>`).join("")}</${kind}>`); list = null; } };
  String(text || "").split(/\n/).forEach((l) => {
    const t = l.trim();
    let m;
    if (!t) { flush(); return; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(t))) { flush(); const lv = m[1].length === 3 ? 3 : 2; out.push(`<h${lv}>${inl(m[2])}</h${lv}>`); }
    else if ((m = /^[-•*]\s+(.*)$/.exec(t))) { if (kind !== "ul") flush(); kind = "ul"; (list ||= []).push(m[1]); }
    else if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) { if (kind !== "ol") flush(); kind = "ol"; (list ||= []).push(m[1]); }
    else { flush(); out.push(`<p>${inl(t)}</p>`); }
  });
  flush();
  return out.join("");
}

// An Advisor draft → a new blog post (title, words, and the answer's title + description if it has one)
function postFromDraft(d, a, thTitle) {
  let text = String(d.text || "");
  let title = "";
  const m = /^\s*#\s+(.+)\n?/.exec(text);
  if (m) { title = m[1].trim(); text = text.slice(m[0].length); }
  const html = d.type === "faq"
    ? `<h2>Frequently asked questions</h2>${(d.items || []).map((x) => `<h3>${esc(x.q)}</h3><p>${esc(x.a)}</p>`).join("")}`
    : mdToHtml(text);
  const tm = (a.drafts || []).find((x) => x && x.type === "title_meta");
  return {
    title: title || (d.type === "faq" ? `${thTitle}: your questions answered` : d.label || thTitle),
    html, seoTitle: tm ? tm.title || "" : "", desc: tm ? tm.description || "" : "",
    note: [`From the Advisor: “${thTitle}” (${d.label}).`,
      d.type === "outline" ? "It's an outline: write each section before publishing." : "",
      d.clinical ? "It states clinical facts, so a clinician needs to check it." : "",
      d.warn ? `Advertising check: ${d.warn}` : "",
      "Check every fact before publishing."].filter(Boolean).join(" "),
  };
}

function draftHtmlView(d, msgId, canWp = false) {
  let bodyHtml;
  if (d.type === "faq") {
    bodyHtml = (d.items || []).map((x) => `<h4>${esc(x.q)}</h4><p>${esc(x.a)}</p>`).join("");
  } else if (d.type === "title_meta") {
    const tl = (d.title || "").length, dl = (d.description || "").length;
    bodyHtml = `<div class="seo-adv-tm"><span class="seo-note">Title · <b class="${tl > 60 ? "is-bad" : ""}">${tl}/60</b></span><p>${esc(d.title)}</p></div>
      <div class="seo-adv-tm"><span class="seo-note">Description · <b class="${dl > 160 || dl < 120 ? "is-bad" : ""}">${dl}/155</b></span><p>${esc(d.description)}</p></div>`;
  } else if (d.type === "email") {
    bodyHtml = `<div class="seo-adv-tm"><span class="seo-note">Subject</span><p><strong>${esc(d.subject)}</strong></p></div>${richText(d.text)}`;
  } else bodyHtml = richText(d.text);
  return `<div class="seo-adv-draft">
    <div class="seo-adv-dhead"><strong>${esc(d.label)}</strong>
      ${d.clinical ? `<span class="seo-pr-pill is-amber" title="States clinical facts: have a doctor check it">Needs clinician review</span>` : ""}
      ${d.warn ? "" : `<span class="seo-pr-pill is-green">Checked against advertising rules</span>`}</div>
    ${d.warn ? `<p class="seo-adv-warn">${esc(d.warn)}</p>` : ""}
    <div class="seo-adv-dbody">${bodyHtml}</div>
    <div class="seo-w-acts">
      <button class="seo-btn" type="button" data-adv-copy="${msgId}|${d.i}|text">Copy text</button>
      <button class="seo-btn" type="button" data-adv-copy="${msgId}|${d.i}|html">Copy HTML</button>
      ${d.type === "faq" ? `<button class="seo-btn" type="button" data-adv-copy="${msgId}|${d.i}|schema">Copy FAQ schema</button>` : ""}
      ${canWp && POSTABLE.has(d.type) ? `<button class="seo-btn seo-fixit" type="button" data-adv-wp="${msgId}|${d.i}">Send to WordPress as a draft</button>` : ""}
      ${canWp && d.type === "title_meta" ? `<button class="seo-btn seo-fixit" type="button" data-adv-tm="${msgId}|${d.i}">Use on the page</button>` : ""}
      <span class="seo-note">Draft from Claude: check before publishing.${d.type === "faq" ? " Paste each question into your SEO plugin's FAQ block for the schema." : ""}</span>
    </div></div>`;
}

/* ---------- the tab ---------- */

export function renderAdvisor(body, c) {
  injectCss();
  const w = c.work;
  (w.advUnsub || []).forEach((f) => { try { f(); } catch { /* already stopped */ } });
  w.advUnsub = [];
  const ui = w.aui || (w.aui = { thread: "", mode: "auto", page: "", text: "", ex: {} });
  if (w.advPrefill) {
    ui.thread = ""; ui.mode = w.advPrefill.mode || "page"; ui.page = w.advPrefill.page || ""; ui.text = w.advPrefill.text || "";
    w.advPrefill = null;
  }
  const can = canAsk(c);
  const canWp = typeof c.can === "function" && c.can("seo.pages");   // Website: edit pages
  const idx = pageIndex(w, c.data);
  const S = { threads: [], msgs: [], threadsReady: false, msgsReady: false };

  const wrap = document.createElement("div");
  wrap.className = "seo-adv";
  body.replaceChildren(wrap);
  wrap.innerHTML = `<div class="seo-adv-grid"><aside class="seo-adv-side" data-adv-side></aside><section class="seo-adv-main" data-adv-main></section></div>`;
  const side = wrap.querySelector("[data-adv-side]"), main = wrap.querySelector("[data-adv-main]");
  const stop = () => { (w.advUnsub || []).forEach((f) => { try { f(); } catch { /* */ } }); w.advUnsub = []; };
  const thread = () => S.threads.find((t) => t.id === ui.thread) || null;

  /* --- conversations list --- */
  w.advUnsub.push(onSnapshot(query(collection(db, "seo_advisor"), orderBy("updatedAt", "desc"), limit(40)), (snap) => {
    if (!wrap.isConnected) return stop();
    S.threads = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.status !== "archived");
    S.threadsReady = true;
    drawSide();
    if (ui.thread) drawHead();
  }, (e) => { side.innerHTML = `<p class="seo-note seo-err">${esc(/permission/i.test(e.message || "") ? "The Advisor needs the new database rules." : e.message)}</p>`; }));

  function goalProgress(g) {
    if (!g || !g.from || !g.to) return null;
    const last = c.data.days[c.data.days.length - 1]?.date || g.to;
    const keys = new Set((g.pages || []).map(npath));
    const sum = (from, to) => {
      let s = 0;
      for (const p of c.data.pages) {
        if (!keys.has(npath(p.path)) || !Array.isArray(p.dailyArr) || !p.dailyFrom) continue;
        const i0 = Math.max(0, daysBetween(p.dailyFrom, from)), i1 = Math.min(p.dailyArr.length - 1, daysBetween(p.dailyFrom, to));
        for (let i = i0; i <= i1; i++) s += p.dailyArr[i] || 0;
      }
      return s;
    };
    const started = g.from <= last;
    const through = g.to < last ? g.to : last;
    return {
      started, through, now: started ? sum(g.from, through) : 0,
      lastYear: started ? sum(addYears(g.from, -1), addYears(through, -1)) : 0,
      lastYearFull: sum(addYears(g.from, -1), addYears(g.to, -1)), target: g.clicks || 0,
    };
  }

  function drawSide() {
    const goals = S.threads.filter((t) => t.goal && t.tracked);
    const rest = S.threads.filter((t) => !(t.goal && t.tracked));
    const item = (t) => {
      const k = KIND[t.kind] || ["Conversation", "q"];
      const gp = t.goal && t.tracked ? goalProgress(t.goal) : null;
      const pct = gp && gp.target ? Math.min(100, Math.round((gp.now / gp.target) * 100)) : 0;
      return `<button type="button" class="seo-adv-item${t.id === ui.thread ? " is-on" : ""}" data-adv-th="${esc(t.id)}">
        <span class="seo-adv-ico is-${k[1]}" aria-hidden="true"></span>
        <span class="seo-adv-it"><span class="t">${esc(t.title || "New question")}</span>
          <span class="seo-note">${t.busy ? `<i class="seo-adv-pulse"></i>Thinking…` : `${esc(k[0])} · ${esc(when(t.updatedAt))}`}</span>
          ${gp ? `<span class="seo-adv-mini"><i style="width:${pct}%"></i></span>` : ""}</span></button>`;
    };
    side.innerHTML = `
      ${can ? `<button class="seo-btn on seo-adv-newbtn" type="button" data-adv-new>+ New question</button>` : ""}
      ${goals.length ? `<h4>Goals</h4>${goals.map(item).join("")}` : ""}
      <h4>Conversations</h4>
      ${!S.threadsReady ? `<p class="seo-note">Loading…</p>` : rest.length ? rest.map(item).join("") : `<p class="seo-note">Nothing asked yet.</p>`}`;
  }

  /* --- asking --- */
  function newHtml() {
    const opts = idx.list.slice(0, 400);
    return `<div class="seo-adv-hero">
      <h2>What would you like to work on?</h2>
      <p class="seo-note">Ask about a goal, a page or anything in your SEO. The Advisor looks at your real numbers and answers with what's happening and what to do, step by step.</p>
      <div class="seo-adv-modes" role="radiogroup">${MODES.map(([k, l]) => `<button type="button" class="seo-adv-mode${ui.mode === k ? " is-on" : ""}" data-adv-mode="${k}" role="radio" aria-checked="${ui.mode === k}">${l}</button>`).join("")}</div>
      ${ui.mode === "page" ? `<label class="seo-adv-pick"><span class="seo-note">Which page?</span>
        <input class="seo-input" list="seo-adv-pages" data-adv-page placeholder="Start typing a page title" value="${esc(ui.page ? `${titleOf(w, c.data, ui.page)} — ${ui.page}` : "")}">
        <datalist id="seo-adv-pages">${opts.map((x) => `<option value="${esc((x.title || x.path) + " — " + x.path)}">`).join("")}</datalist></label>` : ""}
      <textarea class="seo-input seo-adv-q" data-adv-q rows="3" maxlength="2000" placeholder="${esc(
        ui.mode === "goal" ? "e.g. December is coming and I want to boost our skin lifting pages"
        : ui.mode === "page" ? "e.g. How do I get this page into the top 3?" : "e.g. Why did clicks drop last week?")}">${esc(ui.text)}</textarea>
      <div class="seo-adv-askrow"><span class="seo-note">Answers take about a minute. You can leave this page: the answer is saved here.</span>
        <span class="seo-sp"></span><button class="seo-btn on" type="button" data-adv-ask${can ? "" : " disabled"}>Ask the Advisor</button></div>
      ${can ? "" : `<p class="seo-note">Only the SEO team and admins can ask. You can read every conversation.</p>`}
      <h4>Try one of these</h4>
      <div class="seo-adv-exs">${EXAMPLES.map(([m, t], i) => `<button type="button" class="seo-adv-ex" data-adv-ex="${i}">
        <span class="seo-adv-ico is-${m === "goal" ? "goal" : m === "page" ? "page" : "q"}" aria-hidden="true"></span>${esc(t)}</button>`).join("")}</div>
    </div>`;
  }

  async function ask(text, opts = {}) {
    text = String(text || "").trim();
    if (!text) { toast("Write your question first.", true); return; }
    if (!can) { toast("Only the SEO team and admins can ask.", true); return; }
    const b = writeBatch(db);
    let tid = opts.thread;
    if (!tid) {
      const ref = doc(collection(db, "seo_advisor"));
      tid = ref.id;
      b.set(ref, { title: text.slice(0, 80), titleAuto: true, kind: opts.mode && opts.mode !== "auto" ? opts.mode : "", page: opts.page || "",
        createdBy: uid(), byName: myName(c), createdAt: serverTimestamp(), updatedAt: serverTimestamp(), status: "open", tracked: false });
    } else {
      b.update(doc(db, "seo_advisor", tid), { updatedAt: serverTimestamp(), lastBy: uid() });
    }
    b.set(doc(collection(db, "seo_advisor_msgs")), { threadId: tid, role: "user", status: "new", text: text.slice(0, 2000),
      mode: opts.mode || "auto", page: opts.page || "", by: uid(), byName: myName(c), at: serverTimestamp() });
    try {
      await b.commit();
      ui.text = "";
      if (ui.thread !== tid) { ui.thread = tid; drawMain(); } else drawFoot();
    } catch (e) { toast(/permission/i.test(e.message || "") ? "You don't have permission to ask the Advisor." : e.message, true); }
  }

  /* --- a conversation --- */
  function listenThread() {
    S.msgs = []; S.msgsReady = false;
    w.advUnsub.push(onSnapshot(query(collection(db, "seo_advisor_msgs"), where("threadId", "==", ui.thread)), (snap) => {
      if (!wrap.isConnected) return stop();
      const before = S.msgs.length;
      S.msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (tsDate(a.at)?.getTime() || Date.now()) - (tsDate(b.at)?.getTime() || Date.now()));
      S.msgsReady = true;
      drawConv();
      drawFoot();
      if (S.msgs.length > before) main.querySelector("[data-adv-conv]")?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function drawHead() {
    const box = main.querySelector("[data-adv-head]");
    const t = thread();
    if (!box || !t) return;
    const k = KIND[t.kind] || ["Conversation", "q"];
    const gp = t.goal ? goalProgress(t.goal) : null;
    box.innerHTML = `<div class="seo-row" style="margin:0">
        <span class="seo-adv-ico is-${k[1]}" aria-hidden="true"></span>
        <h2 style="margin:0;font-size:18px">${esc(t.title || "New question")}</h2>
        <span class="seo-note">${esc(k[0])} · ${esc(t.byName || "")} · ${esc(when(t.createdAt))}</span><span class="seo-sp"></span>
        ${can && t.goal ? `<button class="seo-btn${t.tracked ? " on" : ""}" type="button" data-adv-track>${t.tracked ? "Tracking this goal ✓" : "Track this goal"}</button>` : ""}
        ${can ? `<button class="seo-btn" type="button" data-adv-archive>Archive</button>` : ""}</div>
      ${gp ? `<div class="seo-adv-goal">
        <div class="seo-row" style="margin:0 0 6px"><strong>Goal: ${esc(fmtDay(t.goal.from))} – ${esc(fmtDay(t.goal.to))}</strong>
          <span class="seo-note">${plural((t.goal.pages || []).length, "page")}</span></div>
        ${gp.started ? `<div class="seo-adv-gbar"><i style="width:${gp.target ? Math.min(100, Math.round((gp.now / gp.target) * 100)) : 0}%"></i>
            ${gp.lastYear && gp.target ? `<b style="left:${Math.min(100, Math.round((gp.lastYear / gp.target) * 100))}%" title="Same point last year"></b>` : ""}</div>
          <p class="seo-note" style="margin:6px 0 0"><strong>${c.h.fmtInt(gp.now)}</strong> clicks so far (to ${esc(fmtDay(gp.through))}) ·
            same point last year ${c.h.fmtInt(gp.lastYear)}${gp.target ? ` · target ${c.h.fmtInt(gp.target)}` : ""}</p>`
          : `<p class="seo-note" style="margin:0">Starts ${esc(fmtDay(t.goal.from))}. Last year these pages had <strong>${c.h.fmtInt(gp.lastYearFull)}</strong> clicks in the same dates${
            gp.target ? `; the target is <strong>${c.h.fmtInt(gp.target)}</strong>` : ""}.</p>`}
      </div>` : ""}`;
  }

  function stepsByWhen(steps) {
    const groups = [];
    steps.forEach((s, i) => {
      const g = groups.find((x) => x.when === (s.when || "Next"));
      (g || (groups[groups.length] = { when: s.when || "Next", items: [] })).items.push([s, i]);
    });
    return groups;
  }

  function answerHtml(m, a) {
    const k = KIND[a.kind] || KIND.question;
    const used = new Set(a.steps.flatMap((s) => s.drafts || []));
    const ex = ui.ex[m.id] || new Set();
    const nSel = a.steps.length - [...ex].filter((i) => i < a.steps.length).length;
    const pageBtn = (path, label) => {
      const p = pageOf(c.data, path);
      return p ? `<button class="seo-w-link" type="button" data-open="${esc(p.id)}">${esc(label || titleOf(w, c.data, path))}</button>` : esc(label || path);
    };
    return `<div class="seo-adv-ans">
      <div class="seo-adv-head is-${k[1]}"><span class="seo-adv-kind">${esc(k[0])}</span><p>${esc(a.headline)}</p></div>

      ${a.now.length ? `<div class="seo-adv-nums">${a.now.map((n) => `<div class="seo-adv-num">
        <span class="seo-note">${esc(n.label)}</span><strong>${esc(n.value)}</strong>
        <span class="seo-adv-tone is-${n.tone}">${n.tone === "up" ? "▲ " : n.tone === "down" ? "▼ " : ""}${esc(n.note)}</span></div>`).join("")}</div>` : ""}

      ${a.findings.length ? `<div class="seo-adv-sec"><h4>What's happening</h4>
        <ul class="seo-adv-finds">${a.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}

      ${a.pages.length ? `<div class="seo-adv-sec"><h4>Pages involved</h4><div class="seo-adv-pages">${a.pages.map((p) => `<div class="seo-adv-prow">
        <i class="seo-adv-dot is-${p.status}" title="${p.status === "good" ? "Working" : p.status === "problem" ? "Problem" : "Watch"}"></i>
        <div style="min-width:0">${pageBtn(p.path, p.title)}<div class="seo-note">${esc(p.note)}</div></div>
        <span class="seo-pr-pill is-grey">${esc(p.role || "Related")}</span></div>`).join("")}</div></div>` : ""}

      ${a.steps.length ? `<div class="seo-adv-sec"><h4>What to do</h4>
        <div class="seo-adv-tl">${stepsByWhen(a.steps).map((g) => `<div class="seo-adv-tg">
          <div class="seo-adv-when">${esc(g.when)}</div>
          <div>${g.items.map(([s, i]) => `<div class="seo-adv-step">
            ${can ? `<input type="checkbox" class="seo-adv-ck" data-adv-step="${m.id}|${i}"${ex.has(i) ? "" : " checked"} aria-label="Include in tasks">` : ""}
            <div style="min-width:0;flex:1">
              <div class="seo-adv-stitle"><span class="seo-pr-pill ${s.area === "marketing" ? "is-violet" : "is-blue"}">${s.area === "marketing" ? "Marketing" : "Website"}</span>
                <span class="seo-w-eff is-${s.effort.toLowerCase()}">${esc(s.effort)}</span> ${esc(s.title)}</div>
              ${s.detail ? `<div class="seo-note">${esc(s.detail)}</div>` : ""}
              <div class="seo-note">${s.page ? `On ${pageBtn(s.page)}` : ""}${s.check ? `${s.page ? " · " : ""}<span class="seo-adv-chk">✓ Checked on the website</span>` : ""}</div>
              ${(s.drafts || []).map((di) => a.drafts[di]).filter(Boolean).map((d) => `<details class="seo-adv-dd"${(s.drafts || [])[0] === d.i && i === 0 ? " open" : ""}>
                <summary>Draft ready: ${esc(d.label)}</summary>${draftHtmlView(d, m.id, canWp)}</details>`).join("")}
            </div></div>`).join("")}</div></div>`).join("")}</div></div>` : ""}

      ${a.drafts.filter((d) => !used.has(d.i)).length ? `<div class="seo-adv-sec"><h4>Drafts</h4>
        ${a.drafts.filter((d) => !used.has(d.i)).map((d) => draftHtmlView(d, m.id, canWp)).join("")}</div>` : ""}

      ${a.targets.length ? `<div class="seo-adv-sec"><h4>Targets</h4><div class="seo-adv-targets">${a.targets.map((t) =>
        `<div class="seo-adv-target"><span class="seo-note">${esc(t.label)}</span><strong>${esc(t.value)}</strong></div>`).join("")}</div></div>` : ""}

      ${a.honest ? `<div class="seo-adv-honest"><strong>Honest check:</strong> ${esc(a.honest)}</div>` : ""}

      <div class="seo-w-acts">
        ${can && a.steps.length ? `<button class="seo-btn on" type="button" data-adv-tasks="${m.id}"${nSel ? "" : " disabled"}>Add ${plural(nSel, "step")} to Tasks</button>` : ""}
        <span class="seo-note">${esc(when(m.doneAt))}</span>
      </div>
    </div>`;
  }

  function msgHtml(m) {
    const q = `<div class="seo-adv-you"><span class="seo-note">${esc(m.by === uid() ? "You" : m.byName || "Someone")} · ${esc(when(m.at))}</span><p>${esc(m.text)}</p></div>`;
    if (m.status === "done") {
      let a = null;
      try { a = JSON.parse(m.answer || "{}"); } catch { a = null; }
      return q + (a ? answerHtml(m, a) : `<div class="seo-adv-err">The answer couldn't be read.</div>`);
    }
    if (m.status === "error") {
      return q + `<div class="seo-adv-err"><strong>The Advisor couldn't answer this time.</strong> <span class="seo-note">${esc(m.error || "")}</span>
        ${can ? `<button class="seo-btn" type="button" data-adv-retry="${m.id}">Ask again</button>` : ""}</div>`;
    }
    const waited = (Date.now() - (tsDate(m.at)?.getTime() || Date.now())) / 1000;
    const steps = Array.isArray(m.progress) && m.progress.length ? m.progress : [m.status === "new" ? "Waiting to start" : "Starting"];
    return q + `<div class="seo-adv-work">
      <div class="seo-row" style="margin:0 0 6px"><span class="seo-adv-spin" aria-hidden="true"></span><strong>${m.status === "new" ? "Waiting for the Advisor…" : "Working on it…"}</strong></div>
      <ol class="seo-adv-prog">${steps.map((s, i) => `<li class="${i === steps.length - 1 ? "is-now" : "is-done"}">${esc(s)}</li>`).join("")}</ol>
      ${m.status === "new" && waited > 150 ? `<p class="seo-note">It checks for new questions every minute between 6am and 10pm. If this keeps waiting, check the runSeoAdvisor trigger in Apps Script.</p>` : ""}
    </div>`;
  }

  function drawConv() {
    const box = main.querySelector("[data-adv-conv]");
    if (!box) return;
    box.innerHTML = !S.msgsReady ? `<p class="seo-note">Loading…</p>`
      : S.msgs.length ? S.msgs.map((m) => `<div class="seo-adv-turn" data-adv-turn="${m.id}">${msgHtml(m)}</div>`).join("")
      : `<p class="seo-note">No questions yet.</p>`;
  }

  function drawFoot() {
    const box = main.querySelector("[data-adv-foot]");
    if (!box || !can) { if (box) box.innerHTML = ""; return; }
    const busy = S.msgs.some((m) => m.status === "new" || m.status === "working");
    const last = [...S.msgs].reverse().find((m) => m.status === "done");
    let fu = [];
    try { fu = last ? JSON.parse(last.answer || "{}").followups || [] : []; } catch { fu = []; }
    const keep = box.querySelector("[data-adv-fq]")?.value || "";
    box.innerHTML = `
      ${fu.length && !busy ? `<div class="seo-adv-fus">${fu.map((f) => `<button type="button" class="seo-adv-fu" data-adv-fu="${esc(f)}">${esc(f)}</button>`).join("")}</div>` : ""}
      <div class="seo-adv-fbox">
        <textarea class="seo-input" data-adv-fq rows="2" maxlength="2000" placeholder="${busy ? "The Advisor is still answering…" : "Ask a follow-up, e.g. “make the FAQ answers shorter” or “write the email to past patients”"}"${busy ? " disabled" : ""}>${esc(keep)}</textarea>
        <button class="seo-btn on" type="button" data-adv-send${busy ? " disabled" : ""}>Send</button>
      </div>
      <p class="seo-note" style="margin:4px 0 0">Ctrl + Enter to send.</p>`;
  }

  function drawMain() {
    (w.advUnsub || []).splice(1).forEach((f) => { try { f(); } catch { /* */ } });   // keep the list listener, stop the old conversation
    if (!ui.thread) { main.innerHTML = newHtml(); drawSide(); return; }
    main.innerHTML = `<div class="seo-adv-thead" data-adv-head></div><div class="seo-adv-conv" data-adv-conv></div><div class="seo-adv-foot" data-adv-foot></div>`;
    drawHead();
    drawSide();
    listenThread();
  }

  /* --- turning steps into tasks --- */
  async function toTasks(m) {
    let a;
    try { a = JSON.parse(m.answer || "{}"); } catch { return; }
    const ex = ui.ex[m.id] || new Set();
    const chosen = a.steps.map((s, i) => [s, i]).filter(([, i]) => !ex.has(i));
    if (!chosen.length) return;
    const t = thread() || {};
    const home = t.page || a.pages[0]?.path || "/";
    const groups = new Map();
    for (const [s, i] of chosen) {
      const key = s.area === "marketing" ? "marketing" : "web:" + npath(s.page || home);
      if (!groups.has(key)) groups.set(key, { area: s.area, path: s.area === "marketing" ? home : (s.page || home), steps: [] });
      groups.get(key).steps.push([s, i]);
    }
    // Steps that are already tasks (same check on the same page) aren't added again
    const sig = (k) => (k ? [k.k, npath(k.page || ""), k.has || "", k.to ? npath(k.to) : "", (k.any || []).join(","), k.min || ""].join("|") : "");
    const have = new Set();
    for (const g of groups.values()) {
      if (g.area === "marketing") continue;
      const snap = await getDocs(query(collection(db, "seo_tasks"), where("path", "==", g.path)));
      snap.docs.forEach((d) => { const st = d.data().steps || {}; Object.values(st).forEach((x) => x?.check && have.add(sig(x.check))); });
    }
    const b = writeBatch(db);
    let added = 0, skipped = 0;
    for (const [key, g] of groups) {
      const id = "t_adv" + hash(m.id + "|" + key) + hash(key + "#" + m.id);
      const steps = {}, order = [];
      g.steps.forEach(([s, i]) => {
        if (s.check && have.has(sig(s.check))) { skipped++; return; }
        const sid = "s_" + hash(id + "|" + i) + hash(i + "#" + id);
        const drafts = (s.drafts || []).map((di) => a.drafts[di]).filter(Boolean).map((d) => d.label);
        steps[sid] = { text: s.title, detail: [s.detail, drafts.length ? `Draft ready in the Advisor: ${drafts.join(", ")}` : ""].filter(Boolean).join(" · ").slice(0, 600),
          effort: s.effort, check: s.check || { k: "manual" }, status: "todo", by: "", byName: "", at: "" };
        order.push(sid);
        added++;
      });
      if (!order.length) continue;
      b.set(doc(db, "seo_tasks", id), {
        path: g.path, group: g.area === "marketing" ? "marketing" : "advisor", source: "advisor", threadId: ui.thread,
        title: g.area === "marketing" ? `Marketing: ${a.title}` : a.title, gain: 0, order, steps, status: "open", skipUntil: "", skipNote: "",
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }, { merge: true });
      b.set(doc(collection(db, "seo_task_log")), { taskId: id, path: g.path, taskTitle: a.title, stepId: "", text: "",
        note: `From the Advisor: ${plural(order.length, "step")}`.slice(0, 500), action: "add", by: uid(), byName: myName(c), role: roleOf(c),
        day: new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(new Date()), at: serverTimestamp() });
    }
    if (!added) { toast("These steps are already in Tasks."); return; }
    try {
      await b.commit();
      toast(`Added ${plural(added, "step")} to Tasks${skipped ? ` (${skipped} already there)` : ""}`);
    } catch (e) { toast(/permission/i.test(e.message || "") ? "You don't have permission to add tasks." : e.message, true); }
  }

  /* --- events --- */
  wrap.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t || t.dataset.open !== undefined) return;   // seo.js opens page details
    const d = t.dataset;
    if (d.advNew !== undefined) { ui.thread = ""; ui.mode = "auto"; ui.page = ""; drawMain(); main.querySelector("[data-adv-q]")?.focus(); return; }
    if (d.advTh) { ui.thread = d.advTh; drawMain(); return; }
    if (d.advMode) { ui.text = main.querySelector("[data-adv-q]")?.value || ""; ui.mode = d.advMode; main.innerHTML = newHtml(); main.querySelector("[data-adv-q]")?.focus(); return; }
    if (d.advEx !== undefined) {
      const [m, text] = EXAMPLES[+d.advEx];
      ui.mode = m; ui.text = text;
      main.innerHTML = newHtml();
      main.querySelector("[data-adv-q]")?.focus();
      return;
    }
    if (d.advAsk !== undefined) {
      const text = main.querySelector("[data-adv-q]")?.value || "";
      if (ui.mode === "page" && !ui.page) { toast("Choose the page first.", true); return; }
      t.disabled = true;
      await ask(text, { mode: ui.mode, page: ui.mode === "page" ? ui.page : "" });
      t.disabled = false;
      return;
    }
    if (d.advSend !== undefined || d.advFu) {
      const text = d.advFu || main.querySelector("[data-adv-fq]")?.value || "";
      t.disabled = true;
      await ask(text, { thread: ui.thread, mode: "auto", page: thread()?.page || "" });
      return;
    }
    if (d.advRetry) {
      const m = S.msgs.find((x) => x.id === d.advRetry);
      if (m) await ask(m.text, { thread: ui.thread, mode: m.mode || "auto", page: m.page || "" });
      return;
    }
    if (d.advTasks) {
      const m = S.msgs.find((x) => x.id === d.advTasks);
      if (!m) return;
      t.disabled = true;
      await toTasks(m);
      t.disabled = false;
      return;
    }
    if (d.advWp || d.advTm) {
      const [mid, di] = (d.advWp || d.advTm).split("|");
      const m = S.msgs.find((x) => x.id === mid);
      let a = null;
      try { a = JSON.parse(m?.answer || "{}"); } catch { a = null; }
      const dr = a?.drafts?.[+di];
      if (!dr) return;
      const th = thread() || {};
      if (d.advWp) {   // a new blog post with this draft in it
        stashPostDraft(postFromDraft(dr, a, th.title || "Advisor draft"));
        location.hash = "#/seo/website/new";
        return;
      }
      // Title + description → the page it was written for
      const step = (a.steps || []).find((s) => (s.drafts || []).includes(+di) && s.page);
      const path = (step && step.page) || th.page || (a.pages && a.pages[0] && a.pages[0].path) || "";
      if (!path) { toast("This draft isn't linked to a page. Open the page in SEO → Website and paste it in.", true); return; }
      try { sessionStorage.setItem("dm.seo.setmeta", JSON.stringify({ path, seoTitle: dr.title || "", desc: dr.description || "" })); }
      catch { toast("Couldn't pass it on. Copy it instead.", true); return; }
      location.hash = "#/seo/website/set";
      return;
    }
    if (d.advCopy) {
      const [mid, di, fmt] = d.advCopy.split("|");
      const m = S.msgs.find((x) => x.id === mid);
      let a = null;
      try { a = JSON.parse(m?.answer || "{}"); } catch { a = null; }
      const dr = a?.drafts?.[+di];
      if (!dr) return;
      const ok = await copyText(fmt === "html" ? draftHtml(dr) : fmt === "schema" ? faqSchema(dr) : draftPlain(dr));
      const was = t.textContent;
      t.textContent = ok ? "Copied ✓" : "Couldn't copy";
      setTimeout(() => { if (t.isConnected) t.textContent = was; }, 1800);
      return;
    }
    if (d.advTrack !== undefined) {
      const th = thread();
      if (!th) return;
      try { await updateDoc(doc(db, "seo_advisor", th.id), { tracked: !th.tracked, updatedAt: serverTimestamp() }); }
      catch (err) { toast(err.message, true); }
      return;
    }
    if (d.advArchive !== undefined) {
      const th = thread();
      if (!th || !confirm(`Archive “${th.title}”? It's hidden from the list, not deleted.`)) return;
      try { await updateDoc(doc(db, "seo_advisor", th.id), { status: "archived", updatedAt: serverTimestamp() }); ui.thread = ""; drawMain(); }
      catch (err) { toast(err.message, true); }
    }
  });

  wrap.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.advStep) {
      const [mid, i] = t.dataset.advStep.split("|");
      const set = ui.ex[mid] || (ui.ex[mid] = new Set());
      if (t.checked) set.delete(+i); else set.add(+i);
      const m = S.msgs.find((x) => x.id === mid);
      let a = null;
      try { a = JSON.parse(m?.answer || "{}"); } catch { a = null; }
      const btn = wrap.querySelector(`[data-adv-tasks="${mid}"]`);
      if (btn && a) {
        const n = a.steps.length - [...set].filter((x) => x < a.steps.length).length;
        btn.textContent = `Add ${plural(n, "step")} to Tasks`;
        btn.disabled = !n;
      }
    }
    if (t.matches("[data-adv-page]")) {
      const m = /—\s*(\/\S*)$/.exec(t.value);
      ui.page = m ? m[1] : "";
    }
  });

  wrap.addEventListener("input", (e) => {
    if (e.target.matches("[data-adv-q]")) ui.text = e.target.value;
    if (e.target.matches("[data-adv-page]")) {
      const m = /—\s*(\/\S*)$/.exec(e.target.value);
      ui.page = m ? m[1] : "";
    }
  });

  wrap.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      if (e.target.matches("[data-adv-q]")) { e.preventDefault(); wrap.querySelector("[data-adv-ask]")?.click(); }
      if (e.target.matches("[data-adv-fq]")) { e.preventDefault(); wrap.querySelector("[data-adv-send]")?.click(); }
    }
  });

  drawSide();
  drawMain();
}

/* ---------- styles ---------- */

const CSS = `
.seo-adv-grid{display:grid;grid-template-columns:260px minmax(0,1fr);gap:18px;align-items:start}
.seo-adv-side{position:sticky;top:12px;display:flex;flex-direction:column;gap:4px;max-height:calc(100vh - 40px);overflow:auto;padding-right:4px}
.seo-adv-side h4{margin:12px 0 4px;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#6b7280)}
.seo-adv-newbtn{width:100%}
.seo-adv-item{display:flex;gap:8px;align-items:flex-start;width:100%;padding:8px 10px;border:1px solid transparent;border-radius:10px;background:none;font:inherit;text-align:left;cursor:pointer;color:inherit}
.seo-adv-item:hover{background:#f8fafc}
.seo-adv-item.is-on{background:#eff6ff;border-color:#bfdbfe}
.seo-adv-it{display:flex;flex-direction:column;min-width:0;flex:1}
.seo-adv-it .t{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-adv-mini{display:block;height:4px;margin-top:4px;border-radius:2px;background:#e5e7eb;overflow:hidden}
.seo-adv-mini i{display:block;height:100%;background:#16a34a}
.seo-adv-ico{flex:none;width:22px;height:22px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
.seo-adv-ico.is-goal{background:#ecfdf5;color:#047857}.seo-adv-ico.is-goal::before{content:"◎"}
.seo-adv-ico.is-page{background:#eff6ff;color:#1d4ed8}.seo-adv-ico.is-page::before{content:"▤"}
.seo-adv-ico.is-q{background:#f5f3ff;color:#6d28d9}.seo-adv-ico.is-q::before{content:"?"}
.seo-adv-pulse{display:inline-block;width:7px;height:7px;margin-right:5px;border-radius:50%;background:#f59e0b;animation:seoAdvPulse 1.2s infinite}
@keyframes seoAdvPulse{0%,100%{opacity:1}50%{opacity:.3}}
.seo-adv-hero{max-width:820px;margin:10px auto 30px;padding:24px;border:1px solid var(--border,#e5e7eb);border-radius:16px;background:var(--card,#fff)}
.seo-adv-hero h2{margin:0 0 4px;font-size:22px}
.seo-adv-hero h4{margin:20px 0 8px;font-size:13px;color:var(--text-muted,#6b7280)}
.seo-adv-modes{display:inline-flex;gap:4px;margin:14px 0 10px;padding:4px;border-radius:12px;background:#f1f5f9}
.seo-adv-mode{border:0;background:none;padding:7px 14px;border-radius:9px;font:inherit;font-size:13px;cursor:pointer;color:inherit}
.seo-adv-mode.is-on{background:var(--card,#fff);box-shadow:0 1px 3px rgba(0,0,0,.1);font-weight:600}
.seo-adv-pick{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.seo-adv-pick .seo-input,.seo-adv-q{width:100%;min-width:0;box-sizing:border-box}
.seo-adv-q{font-size:15px;padding:12px;resize:vertical}
.seo-adv-askrow{display:flex;align-items:center;gap:10px;margin-top:10px}
.seo-adv-exs{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
.seo-adv-ex{display:flex;gap:8px;align-items:center;padding:10px 12px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:#fafbfc;font:inherit;font-size:13px;text-align:left;cursor:pointer;color:inherit}
.seo-adv-ex:hover{border-color:#93c5fd;background:#eff6ff}
.seo-adv-thead{padding:4px 0 10px;border-bottom:1px solid var(--border,#e5e7eb);margin-bottom:12px}
.seo-adv-goal{margin-top:10px;padding:12px 14px;border:1px solid #bbf7d0;border-radius:12px;background:#f0fdf4}
.seo-adv-gbar{position:relative;height:10px;border-radius:5px;background:#dcfce7;overflow:visible}
.seo-adv-gbar i{display:block;height:100%;border-radius:5px;background:#16a34a}
.seo-adv-gbar b{position:absolute;top:-3px;width:2px;height:16px;background:#64748b}
.seo-adv-turn{margin-bottom:18px}
.seo-adv-you{margin:0 0 8px auto;max-width:80%;padding:10px 14px;border-radius:14px 14px 4px 14px;background:#eff6ff}
.seo-adv-you p{margin:2px 0 0;font-size:14px;white-space:pre-wrap}
.seo-adv-ans{padding:16px;border:1px solid var(--border,#e5e7eb);border-radius:14px;background:var(--card,#fff)}
.seo-adv-head{padding:12px 14px;border-left:4px solid #6d28d9;border-radius:0;background:#faf5ff}
.seo-adv-head.is-goal{border-left-color:#16a34a;background:#f0fdf4}
.seo-adv-head.is-page{border-left-color:#2563eb;background:#eff6ff}
.seo-adv-head p{margin:4px 0 0;font-size:16px;font-weight:600;line-height:1.45}
.seo-adv-kind{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#6b7280)}
.seo-adv-nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:12px}
.seo-adv-num{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:10px;background:#f8fafc}
.seo-adv-num strong{font-size:22px}
.seo-adv-tone{font-size:12px;font-weight:600;color:var(--text-muted,#6b7280)}
.seo-adv-tone.is-up{color:#16a34a}.seo-adv-tone.is-down{color:#dc2626}
.seo-adv-sec{margin-top:16px}
.seo-adv-sec > h4{margin:0 0 8px;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#6b7280)}
.seo-adv-finds{margin:0;padding:0;list-style:none}
.seo-adv-finds li{position:relative;padding:5px 0 5px 20px;font-size:14px;line-height:1.5}
.seo-adv-finds li::before{content:"";position:absolute;left:4px;top:13px;width:7px;height:7px;border-radius:50%;background:#94a3b8}
.seo-adv-pages{border:1px solid var(--border,#e5e7eb);border-radius:10px}
.seo-adv-prow{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:10px;align-items:start;padding:8px 12px;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-adv-prow:first-child{border-top:0}
.seo-adv-dot{width:10px;height:10px;margin-top:4px;border-radius:50%;background:#f59e0b}
.seo-adv-dot.is-good{background:#16a34a}.seo-adv-dot.is-problem{background:#dc2626}
.seo-adv-tl{border-left:2px solid #e5e7eb;margin-left:6px}
.seo-adv-tg{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;padding:0 0 12px 14px;position:relative}
.seo-adv-tg::before{content:"";position:absolute;left:-7px;top:4px;width:12px;height:12px;border-radius:50%;background:var(--card,#fff);border:2px solid var(--accent,#2563eb)}
.seo-adv-when{font-size:13px;font-weight:700;padding-top:1px}
.seo-adv-step{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;margin-bottom:6px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--card,#fff);font-size:13px}
.seo-adv-ck{margin-top:3px}
.seo-adv-stitle{font-weight:600;line-height:1.45}
.seo-adv-chk{color:#047857;font-weight:600}
.seo-adv-dd{margin-top:6px}
.seo-adv-dd summary{cursor:pointer;font-size:12.5px;font-weight:600;color:#1d4ed8}
.seo-adv-draft{margin-top:8px;padding:10px 12px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:#fafbfc;font-size:13px}
.seo-adv-dhead{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
.seo-adv-dbody{line-height:1.55}
.seo-adv-dbody h4{margin:8px 0 2px;font-size:13px}
.seo-adv-dbody p{margin:0 0 6px}
.seo-adv-dbody ul{margin:0 0 6px;padding-left:18px}
.seo-adv-tm{margin-bottom:6px}
.seo-adv-tm p{margin:2px 0 0}
.seo-adv-tm b.is-bad{color:#dc2626}
.seo-adv-warn{margin:0 0 6px;padding:6px 8px;border-radius:6px;background:#fef2f2;color:#b91c1c;font-size:12.5px}
.seo-adv-targets{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
.seo-adv-target{display:flex;flex-direction:column;padding:10px 12px;border:1px dashed #86efac;border-radius:10px;background:#f0fdf4}
.seo-adv-target strong{font-size:18px}
.seo-adv-honest{margin-top:14px;padding:10px 12px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.5}
.seo-adv-work{padding:14px 16px;border:1px dashed #cbd5e1;border-radius:14px;background:#f8fafc}
.seo-adv-spin{width:16px;height:16px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:seoAdvSpin .8s linear infinite}
@keyframes seoAdvSpin{to{transform:rotate(360deg)}}
.seo-adv-prog{margin:0;padding-left:20px;font-size:13px}
.seo-adv-prog li{padding:2px 0}
.seo-adv-prog li.is-done{color:var(--text-muted,#6b7280)}
.seo-adv-prog li.is-now{font-weight:600}
.seo-adv-err{padding:12px 14px;border:1px solid #fecaca;border-radius:12px;background:#fef2f2;font-size:13px}
.seo-adv-foot{position:sticky;bottom:0;padding:10px 0 4px;background:var(--bg,#f6f7f9)}
.seo-adv-fus{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.seo-adv-fu{padding:6px 12px;border:1px solid #c7d2fe;border-radius:999px;background:#eef2ff;color:#3730a3;font:inherit;font-size:12.5px;cursor:pointer}
.seo-adv-fbox{display:flex;gap:8px;align-items:flex-end}
.seo-adv-fbox textarea{flex:1;min-width:0;resize:vertical}
.seo-pr-pill.is-violet{background:#f5f3ff;color:#6d28d9}
.seo-pr-pill.is-blue{background:#eff6ff;color:#1d4ed8}
@media (max-width:900px){.seo-adv-grid{grid-template-columns:1fr}.seo-adv-side{position:static;max-height:none}.seo-adv-tg{grid-template-columns:1fr}}
`;

function injectCss() {
  if (document.getElementById("seo-advisor-css")) return;
  const s = document.createElement("style");
  s.id = "seo-advisor-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}