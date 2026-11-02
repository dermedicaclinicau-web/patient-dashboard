// seo-tasks.js — SEO → Tasks: a short daily list for the SEO team, made from the priority pages' action plans.
// Firestore:
//   seo_tasks/{t_…}            one job on one priority page, with steps { s_…: { text, detail, effort, check, status, by, byName, at, … } }
//                              step status: todo → ticked (checked on the website tonight) → confirmed (permanent).
//                              'done' is for steps that can't be checked (marked by a person).
//   seo_task_days/{yyyy-mm-dd} that day's list { day, ids, perDay, builtBy, builtByName, builtAt }
//   seo_task_log/{auto}        every tick, untick, skip, check and plan. Never changed or deleted.
// Seo6.gs checks the website each night and confirms steps.

import { db, auth } from "./firebase-config.js";
import {
  doc, getDoc, getDocs, collection, query, where, orderBy, limit, writeBatch, runTransaction, serverTimestamp, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { npath, pageStory, priorityOf, prioritySettings, titleOf, complianceWords, renderOppsInto, taskConfig, pageOf, makeSortable }
  from "./seo-work.js?v=13";

const GROUPS = {
  basics:  { order: 0, factor: 1,   title: () => "Fix what's holding it back" },
  match:   { order: 1, factor: 0.6, title: (m) => (m ? `Make it match “${m}”` : "Tidy the title and description") },
  connect: { order: 2, factor: 0.3, title: (m, r) => `Link it with ${r}` },
  content: { order: 3, factor: 0.4, title: () => "Add what people search for" },
  speed:   { order: 4, factor: 0.1, title: () => "Speed and images" },
  off:     { order: 5, factor: 0.1, title: () => "Promote it off the site" },
  ai:      { order: 1.5, factor: 1, title: () => "" },   // made by Seo7.gs (Claude), after "match", before "connect"
};
const CHECK = {
  title: "Page title", titleMax: "Page title", titleNot: "Other page's title", h1: "Main heading", desc: "Description",
  heading: "Headings", headingAny: "Headings", text: "Page text", words: "Word count", link: "Links", absent: "Page text",
  alt: "Images", speed: "Speed", index: "In Google", manual: "Not checked",
};
const STOPW = new Set(["in", "for", "the", "a", "an", "of", "and", "to", "on", "with", "near", "me", "my", "is", "are", "what", "how", "best"]);
const QUESTION = /\b(how|what|why|when|does|do|can|is|are|should|which|vs|or|safe|hurt|last|long)\b/;
const PRICE = /\b(cost|costs|price|prices|pricing|how much|cheap|fee|fees)\b/;
const SMALLW = new Set(["in", "for", "and", "of", "the", "to", "with", "on", "a", "or", "vs"]);

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const uid = () => auth.currentUser?.uid || "";
const myName = (c) => c.staff?.name || c.staff?.displayName || auth.currentUser?.displayName || "";
const roleOf = (c) => String(c.staff?.role || c.staff?.staffRole || (c.isAdmin ? "Admin" : ""));
const canDo = (c) => !!c.isAdmin || /^seo$/i.test(roleOf(c));
const todayPerth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "");
const tsDate = (t) => (t?.toDate ? t.toDate() : t ? new Date(t) : null);
const when = (t) => {
  const d = tsDate(t);
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const errMsg = (e) => (/permission/i.test(e?.message || "") ? "You don't have permission to do that." : e?.message || String(e));
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const tid = (path, group) => "t_" + hash(npath(path) + "|" + group) + hash(group + "#" + npath(path));
const sid = (taskId, key) => "s_" + hash(taskId + "|" + key) + hash(key + "#");
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOPW.has(t));
const hasWords = (text, phrase) => {
  const t = String(text || "").toLowerCase();
  const ws = words(phrase);
  return ws.length > 0 && ws.every((x) => t.includes(x.replace(/s$/, "")));
};
const titleCase = (s) => String(s).replace(/[a-z0-9']+/gi, (m, i) =>
  (i && SMALLW.has(m.toLowerCase()) ? m.toLowerCase() : m.charAt(0).toUpperCase() + m.slice(1)));

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}
function copyText(txt) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(txt).then(() => true).catch(() => fallback());
  return Promise.resolve(fallback());
  function fallback() {
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ---------- making tasks from a priority page's action plan ---------- */

function planTasks(c, path) {
  const w = c.work, me = npath(path);
  const pri = priorityOf(w, path) || {};
  const p = c.data.pages.find((x) => npath(x.path) === me) || null;
  const hpOf = (x) => (w.health?.pages || []).find((y) => npath(y.path) === npath(x)) || null;
  const hp = hpOf(path);
  const banned = complianceWords(w);
  const flagged = (t) => banned.find((b) =>
    new RegExp(`(^|[^a-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(t)) || "";

  const mine = [];
  for (const q of w.queries) {
    if (q.topic === "__brand") continue;
    const x = q.pages.find((y) => npath(y.path) === me);
    if (x) mine.push({ q: q.q, i: x.i, c: x.c, pos: x.pos });
  }
  mine.sort((a, b) => b.i - a.i);
  const usable = mine.filter((m) => !flagged(m.q));
  const main = pri.target && !flagged(pri.target) ? pri.target : (usable[0] || {}).q || "";
  const questions = usable.filter((m) => m.q !== main && QUESTION.test(m.q)).slice(0, 2);
  const priceQ = usable.find((m) => PRICE.test(m.q));

  const s = p && w.queries.some((q) => q.ppages) ? pageStory(w, p) : null;
  let rival = pri.support || "";
  if (!rival && s) {
    const shifts = [...s.shiftBy.entries()].filter(([, v]) => v <= -1).sort((a, b) => a[1] - b[1]);
    const r0 = s.related[0];
    rival = shifts[0] ? shifts[0][0] : r0 && r0.thPi && r0.myPi && r0.thPw / r0.thPi < r0.myPw / r0.myPi ? r0.path : "";
  }
  if (rival && npath(rival) === me) rival = "";
  const rTitle = rival ? titleOf(w, c.data, rival) : "";
  const rhp = rival ? hpOf(rival) : null;

  let gain = 0;
  for (const m of mine) if (m.pos != null && m.pos > 3 && m.pos <= 20) gain += Math.max(0, m.i * 0.11 - m.c);

  const g = {};
  const add = (k, key, text, effort, check, detail) => (g[k] || (g[k] = [])).push({ key, text, effort, check, detail: detail || "" });
  const pg = { page: path };

  /* Fix the basics */
  const goo = hp?.google;
  if (goo && !goo.err && goo.v !== "PASS") {
    add("basics", "index", "Get it into Google: open URL Inspection in Search Console and press Request indexing", "Quick", { k: "index", ...pg },
      `Google says: ${goo.cs || "not indexed"}`);
  }
  for (const i of (hp?.issues || []).filter((x) => x.group === "wording" && x.status !== "ignored")) {
    const word = String(i.key || "").replace(/^word:/, "");
    if (word) add("basics", "absent:" + word, `Remove or reword “${word}” (advertising rules)`, "Quick", { k: "absent", ...pg, word }, i.detail);
  }

  /* Match the target search */
  if (main) {
    const tc = titleCase(main);
    const sug = (tc + " | Dermedica").length <= 60 ? tc + " | Dermedica" : tc;
    if (!hp || !hasWords(hp.title, main)) {
      add("match", "title", `Start the page title with “${main}”`, "Quick", { k: "title", ...pg, has: main },
        `${hp?.title ? `Now: “${hp.title}” · ` : ""}Try: “${sug}”`);
    } else if (hp.title.length > 60) {
      add("match", "titleMax", "Shorten the title to under 60 characters", "Quick", { k: "titleMax", ...pg, max: 60 }, `Now ${hp.title.length}: “${hp.title}”`);
    }
    if (!hp || !hp.h1 || !hasWords(hp.h1Text, main)) {
      add("match", "h1", `Make the main heading (H1) say “${tc}”`, "Quick", { k: "h1", ...pg, has: main }, hp?.h1Text ? `Now: “${hp.h1Text}”` : "");
    }
    const d = String(hp?.desc || "");
    if (!hp || !d || !hasWords(d, main) || d.length > 160 || d.length < 70) {
      add("match", "desc", `Rewrite the meta description (120–155 characters) using “${main}”`, "Quick",
        { k: "desc", ...pg, min: 70, max: 160, has: main },
        (d ? `Now (${d.length} characters): “${d}” · ` : "") + "Who it's for, what it does, how to book. No promises of results.");
    }
  }

  /* Link pages */
  if (rival) {
    add("connect", "link:" + npath(rival), `On “${rTitle}”, add a link to this page with the words “${main || "the treatment name"}”`, "Quick",
      { k: "link", page: rival, to: path }, "Near the top, and again at the end with “Book a consultation”.");
    if (rhp?.title && main && hasWords(rhp.title, main)) {
      add("connect", "rivaltitle", `Take “${main}” out of “${rTitle}”'s title, and aim it at the question instead`, "Quick",
        { k: "titleNot", page: rival, has: main }, `Now: “${rhp.title}”`);
    }
    add("connect", "back:" + npath(rival), `Link from this page back to “${rTitle}” (e.g. “Read our full guide”)`, "Quick", { k: "link", ...pg, to: rival });
  }

  /* Content */
  for (const q of questions) {
    add("content", "faq:" + q.q, `Add an FAQ heading that answers “${q.q}”`, "Medium", { k: "heading", ...pg, has: q.q }, "2–3 sentences under the heading.");
  }
  if (priceQ) {
    add("content", "cost", "Add a “Cost” section", "Medium", { k: "headingAny", ...pg, any: ["cost", "price", "pricing", "fee", "investment"] },
      `People search “${priceQ.q}”. A price range or “from $…”, what changes the price, and whether a consultation is needed.`);
  }
  if (hp && hp.words && hp.words < 600) {
    const target = Math.max(800, Math.round(((rhp?.words || 0) * 0.9) / 100) * 100);
    add("content", "words", `Add depth: about ${hp.words} words now, aim for ${target}+`, "Bigger", { k: "words", ...pg, min: target },
      "What it is, who it suits, sessions, downtime, results, risks, cost, FAQs.");
  }
  add("content", "reviewed", "Show who medically reviewed the page, and when", "Quick",
    { k: "text", ...pg, any: ["reviewed by", "medically reviewed", "written by"] }, "e.g. “Medically reviewed by Dr …, [month year]”");

  /* Speed and images */
  if (hp?.speed?.score != null && hp.speed.score < 50) {
    add("speed", "speed", `Speed it up: mobile score ${hp.speed.score}/100`, "Bigger", { k: "speed", ...pg, min: 50 },
      "Compress and resize the top image, use WebP, remove sliders or plugins it doesn't need.");
  }
  if (hp?.noAlt) add("speed", "alt", `Add alt text to ${plural(hp.noAlt, "image")}`, "Quick", { k: "alt", ...pg });

  /* Off the site */
  const term = main ? titleCase(main.replace(/\bperth\b/gi, "").replace(/\s+/g, " ").trim()) || titleCase(main) : titleOf(w, c.data, path);
  add("off", "gbp", `Add “${term}” as a service on Google Business Profile, with a link to this page`, "Quick", { k: "manual" });

  return Object.entries(g).map(([k, steps]) => ({
    id: tid(path, k), path, group: k, title: GROUPS[k].title(main, rTitle), main,
    gain: Math.round(gain * GROUPS[k].factor), steps,
  }));
}

/* ---------- data ---------- */

async function load(S) {
  const [ts, lg] = await Promise.all([
    getDocs(collection(db, "seo_tasks")),
    getDocs(query(collection(db, "seo_task_log"), orderBy("at", "desc"), limit(800))),
  ]);
  S.tasks = new Map(ts.docs.map((d) => [d.id, { steps: {}, order: [], ...d.data(), id: d.id }]));
  S.log = lg.docs.map((d) => ({ id: d.id, ...d.data() }));
}

const isPri = (c, path) => !!priorityOf(c.work, path);
const started = (t) => (t.order || []).some((id) => t.steps[id] && t.steps[id].status !== "todo");
const isLive = (c, t) => t.status !== "done" && t.status !== "dismissed" && (isPri(c, t.path) || started(t));

// Priority number first (#1 before #2), then the kind of job, then the expected gain
function rankOf(c) {
  const num = new Map(prioritySettings(c.work).paths.map((p, i) => [npath(p), i]));
  return (a, b) => (num.get(npath(a.path)) ?? 999) - (num.get(npath(b.path)) ?? 999)
    || GROUPS[a.group].order - GROUPS[b.group].order || (b.gain || 0) - (a.gain || 0);
}
const priNum = (c, path) => {
  const i = prioritySettings(c.work).paths.findIndex((p) => npath(p) === npath(path));
  return i >= 0 ? i + 1 : 0;
};

// Comments you haven't seen yet (remembered on this device)
const seenKey = () => "dm.seo.seen." + uid();
const seenMap = () => { try { return JSON.parse(localStorage.getItem(seenKey()) || "{}") || {}; } catch { return {}; } };
const markSeen = (k) => { try { const m = seenMap(); m[k] = Date.now(); localStorage.setItem(seenKey(), JSON.stringify(m)); } catch { /* private mode */ } };
const isNew = (l, seen) => l.action === "comment" && l.by !== uid() && (tsDate(l.at)?.getTime() || 0) > (seen[npath(l.path || "")] || 0);

// Keeps the ranking, but takes each page's best task first, then each page's second, and so on
function spread(list) {
  const seen = new Map();
  return list.map((t, i) => {
    const k = npath(t.path);
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    return { t, i, n };
  }).sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.t);
}

// New tasks and new steps are added; existing steps (and anything ticked) are never touched
async function syncTasks(c, S, light) {   // light: only new tasks and steps (no estimate refresh)
  const { paths } = prioritySettings(c.work);
  let batch = writeBatch(db), n = 0;
  const flush = async () => { if (n) { await batch.commit(); batch = writeBatch(db); n = 0; } };
  for (const path of paths) {
    for (const t of planTasks(c, path)) {
      const ex = S.tasks.get(t.id);
      if (ex && ex.status === "done") continue;
      const order = ex ? [...(ex.order || [])] : [];
      const fresh = {};
      for (const st of t.steps) {
        const id = sid(t.id, st.key);
        if (ex?.steps?.[id]) continue;
        fresh[id] = { text: st.text, detail: st.detail, effort: st.effort, check: st.check, status: "todo", by: "", byName: "", at: "" };
        order.push(id);
      }
      const hasNew = Object.keys(fresh).length > 0;
      if (ex && !hasNew && ex.title === t.title && (light || ex.gain === t.gain)) continue;
      const d = { path, group: t.group, title: t.title, gain: t.gain, order, updatedAt: serverTimestamp() };
      if (hasNew) d.steps = fresh;
      if (!ex) Object.assign(d, { status: "open", skipUntil: "", skipNote: "", createdAt: serverTimestamp() });
      batch.set(doc(db, "seo_tasks", t.id), d, { merge: true });
      if (++n >= 400) await flush();
      S.tasks.set(t.id, { ...(ex || { status: "open", skipUntil: "" }), ...d, id: t.id, steps: { ...(ex?.steps || {}), ...fresh }, order });
    }
  }
  await flush();
}

async function ensureToday(c, S) {
  const day = todayPerth();
  const ref = doc(db, "seo_task_days", day);
  const snap = await getDoc(ref);
  if (snap.exists()) { S.day = snap.data(); return; }
  if (!S.canDo) { S.day = null; return; }
  await syncTasks(c, S);
  const cfg = taskConfig(c.work);
  const perDay = cfg.perDay;
  const prev = await getDocs(query(collection(db, "seo_task_days"), orderBy("day", "desc"), limit(1)));
  const prevIds = new Set(prev.docs[0]?.data().ids || []);
  const open = [...S.tasks.values()].filter((t) => isLive(c, t) && (!t.skipUntil || t.skipUntil <= day));
  const rank = rankOf(c);
  const carry = open.filter((t) => prevIds.has(t.id) || started(t)).sort(rank);
  const ranked = open.filter((t) => !carry.includes(t)).sort(rank);
  const rest = cfg.spread ? spread(ranked) : ranked;
  const ids = carry.concat(rest).slice(0, Math.min(30, Math.max(perDay, carry.length))).map((t) => t.id);
  let made = false;
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (s.exists()) { S.day = s.data(); return; }   // someone else made it a moment ago
    const d = { day, ids, perDay, builtBy: uid(), builtByName: myName(c), builtAt: serverTimestamp() };
    tx.set(ref, d);
    S.day = { ...d, builtAt: new Date() };
    made = true;
  });
  if (made) await logOnly(c, S, { action: "plan", note: `${plural(ids.length, "task")} for ${fmtDay(day)}${carry.length ? `, ${carry.length} carried over` : ""}` });
}

/* ---------- actions (every change is logged with who and when) ---------- */

function applyLocal(t, changes) {
  for (const [k, v] of Object.entries(changes)) {
    const parts = k.split(".");
    let o = t;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] || (o[parts[i]] = {});
    o[parts[parts.length - 1]] = v;
  }
}

async function act(c, S, t, changes, log) {
  const b = writeBatch(db);
  b.update(doc(db, "seo_tasks", t.id), { ...changes, updatedAt: serverTimestamp() });
  const entry = {
    taskId: t.id, path: t.path, taskTitle: t.title, stepId: "", text: "", note: "",
    by: uid(), byName: myName(c), role: roleOf(c), day: todayPerth(), at: serverTimestamp(), ...log,
  };
  b.set(doc(collection(db, "seo_task_log")), entry);
  await b.commit();
  applyLocal(t, changes);
  S.log.unshift({ ...entry, at: new Date() });
}

async function logOnly(c, S, log) {
  const entry = {
    taskId: "", path: "", taskTitle: "", stepId: "", text: "", note: "",
    by: uid(), byName: myName(c), role: roleOf(c), day: todayPerth(), at: serverTimestamp(), ...log,
  };
  const b = writeBatch(db);
  b.set(doc(collection(db, "seo_task_log")), entry);
  await b.commit();
  S.log.unshift({ ...entry, at: new Date() });
}

/* ---------- the tab ---------- */

export async function renderTasks(body, c) {
  injectCss();
  const wrap = document.createElement("div");
  wrap.className = "seo-t";
  body.replaceChildren(wrap);
  wrap.innerHTML = `<div class="seo-empty">Loading tasks…</div>`;
  const ui = c.work.tui || (c.work.tui = { view: "today", skip: "", expand: "" });
  const S = { tasks: new Map(), log: [], day: null, canDo: canDo(c), trail: {} };
  try {
    await load(S);
    if (S.canDo) await syncTasks(c, S, true);   // new priority pages and plan steps show up straight away
    await ensureToday(c, S);
  } catch (e) {
    console.error("Tasks not loaded:", e);
    wrap.innerHTML = `<div class="seo-empty seo-err">${esc(/permission/i.test(e.message || "")
      ? "Tasks need the new database rules (seo_tasks, seo_task_days, seo_task_log)." : e.message || String(e))}</div>`;
    return;
  }

  const day = todayPerth();
  const pageId = (path) => pageOf(c.data, path)?.id || "";
  const stepsOf = (t) => (t.order || []).map((id) => ({ id, ...t.steps[id] })).filter((s) => s.text);
  const doneish = (s) => s.status === "confirmed" || s.status === "done";
  const todayTasks = () => (S.day?.ids || []).map((id) => S.tasks.get(id)).filter(Boolean);

  function ring(t) {
    const st = stepsOf(t), n = st.length || 1;
    const a = st.filter(doneish).length / n, b = st.filter((s) => s.status === "ticked").length / n;
    const r = 15, L = 2 * Math.PI * r;
    return `<svg class="seo-t-ring" viewBox="0 0 38 38" aria-hidden="true">
      <circle cx="19" cy="19" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="4"/>
      <circle cx="19" cy="19" r="${r}" fill="none" stroke="#16a34a" stroke-width="4" stroke-dasharray="${L * a} ${L}" transform="rotate(-90 19 19)" stroke-linecap="round"/>
      <circle cx="19" cy="19" r="${r}" fill="none" stroke="#f59e0b" stroke-width="4" stroke-dasharray="0 ${L * a} ${L * b} ${L}" transform="rotate(-90 19 19)" stroke-linecap="round"/>
    </svg>`;
  }

  function stepRow(t, s) {
    const icon = s.status === "confirmed" ? "✓" : s.status === "done" ? "✓" : s.status === "ticked" ? "◷" : "";
    const who = s.status === "confirmed" ? `Confirmed on the website${s.confirmedAt ? " " + esc(when(s.confirmedAt)) : ""}${s.byName ? ` · ticked by ${esc(s.byName)}` : ""}`
      : s.status === "done" ? `${esc(s.byName || "Someone")} · ${esc(when(s.at))} · marked done (can't be checked)`
      : s.status === "ticked" ? `${esc(s.byName || "Someone")} · ${esc(when(s.at))} · checked on the website tonight`
      : s.missing ? `<span class="seo-t-miss">⚠ Ticked before, but not found on the website. Check the change was published.</span>` : "";
    return `<div class="seo-t-step is-${s.status || "todo"}">
      <button type="button" class="seo-t-ck is-${s.status || "todo"}" data-t-ck="${t.id}|${s.id}"
        title="${s.status === "confirmed" ? "Confirmed on the website: stays done" : s.status === "todo" ? "Mark done" : "Undo the tick"}"
        aria-label="${s.status === "todo" ? "Mark done" : "Step status"}">${icon}</button>
      <div class="seo-t-sm">
        <div>${esc(s.text)} <span class="seo-w-eff is-${String(s.effort || "quick").toLowerCase()}">${esc(s.effort || "Quick")}</span></div>
        ${s.detail ? `<div class="seo-note">${esc(s.detail)}</div>` : ""}
        ${who ? `<div class="seo-note">${who}</div>` : ""}
      </div>
      <span class="seo-note seo-t-chk" title="What tonight's website check looks at">${esc(CHECK[s.check?.k] || "")}</span>
    </div>`;
  }

  function taskCard(t) {
    const st = stepsOf(t);
    const n = st.filter(doneish).length;
    const skipped = t.skipUntil && t.skipUntil > day;
    const title = titleOf(c.work, c.data, t.path);
    const head = `<div class="seo-t-chead">${ring(t)}
      <div style="min-width:0">
        <div class="seo-t-page">${priNum(c, t.path) ? `<span class="seo-t-num">#${priNum(c, t.path)}</span>` : ""}${esc(title)}</div>
        <div class="seo-t-title">${t.source === "ai" ? `<span class="seo-t-ai" title="Suggested by Claude${t.score ? `, quality ${t.score}/5` : ""}">AI</span>` : ""}${esc(t.title)}</div>
        ${t.why ? `<div class="seo-note">${esc(t.why)}</div>` : ""}
      </div>
      <div class="seo-t-side">${t.gain ? `<div class="seo-t-gain">≈ +${t.gain} clicks</div>` : ""}<div class="seo-note">${n}/${st.length} steps</div></div>
    </div>`;
    if (t.status === "done") {
      return `<div class="seo-t-card is-done">${head}<p class="seo-note">Finished ${esc(when(t.doneAt))}. In the Change log, so its effect shows there.</p></div>`;
    }
    if (t.status === "dismissed") {
      return `<div class="seo-t-card is-skipped">${head}
        <p class="seo-note"><span class="seo-pr-pill is-grey">Dismissed</span> ${esc(t.dismissNote || "")} · by ${esc(t.dismissByName || "someone")}</p></div>`;
    }
    if (skipped) {
      return `<div class="seo-t-card is-skipped">${head}
        <p class="seo-note"><span class="seo-pr-pill is-red">Skipped</span> ${esc(t.skipNote || "")} · by ${esc(t.skipByName || "someone")} · back ${esc(fmtDay(t.skipUntil))}</p>
        ${S.canDo ? `<div class="seo-w-acts"><button class="seo-btn" type="button" data-t-unskip="${t.id}">Bring it back today</button></div>` : ""}</div>`;
    }
    const pid = pageId(t.path);
    return `<div class="seo-t-card">${head}
      <div class="seo-t-steps">${st.map((s) => stepRow(t, s)).join("")}</div>
      ${ui.skip === t.id ? `<div class="seo-t-skip">
          <input class="seo-input" data-t-why placeholder="Why skip? e.g. waiting for the doctor to review" maxlength="300">
          <label class="seo-note">Back on <input class="seo-input" type="date" data-t-until min="${addDays(day, 1)}" value="${addDays(day, 1)}"></label>
          <button class="seo-btn on" type="button" data-t-skipok="${t.id}">Skip</button>
          <button class="seo-btn" type="button" data-t-skipno>Cancel</button>
          <div class="seo-t-err" data-t-err></div></div>`
        : `<div class="seo-w-acts">
          <button class="seo-btn" type="button" data-t-copy="${t.id}">Copy brief</button>
          ${(() => {
            const seen = seenMap();
            const cm = S.log.filter((l) => l.action === "comment" && npath(l.path || "") === npath(t.path));
            const nw = cm.filter((l) => isNew(l, seen)).length;
            return `<button class="seo-btn${nw ? " seo-t-newbtn" : ""}" type="button" data-t-cmts="${esc(t.path)}">${
              nw ? `${nw} new comment${nw === 1 ? "" : "s"}` : cm.length ? `Comments (${cm.length})` : "Comment"}</button>`;
          })()}
          ${pid ? `<button class="seo-btn" type="button" data-open="${esc(pid)}">Open the page's plan</button>` : ""}
          <span class="seo-sp"></span>
          ${S.canDo && t.source === "ai" ? `<button class="seo-btn" type="button" data-t-dismiss="${t.id}">Dismiss</button>` : ""}
          ${S.canDo ? `<button class="seo-btn" type="button" data-t-skip="${t.id}">Skip for today</button>` : ""}</div>`}
    </div>`;
  }

  /* views */

  // Priority pages with nothing on today's list, and the tasks that would fill it to the daily limit
  function todayGaps() {
    if (!S.day || !S.canDo) return { missing: [], fill: [] };
    const inToday = new Set(S.day.ids || []);
    const skippedNow = (t) => t.skipUntil && t.skipUntil > day;
    const active = todayTasks().filter((t) => t.status !== "done" && !skippedNow(t)).length;
    const cand = spread([...S.tasks.values()]
      .filter((t) => isLive(c, t) && !inToday.has(t.id) && !skippedNow(t)).sort(rankOf(c)));
    const covered = new Set(todayTasks().map((t) => npath(t.path)));
    const first = new Map();
    for (const t of cand) {
      const k = npath(t.path);
      if (!covered.has(k) && !first.has(k) && isPri(c, t.path)) first.set(k, t);
    }
    return { missing: [...first.values()], fill: cand.slice(0, Math.max(0, taskConfig(c.work).perDay - active)) };
  }

  function todayHtml() {
    if (!S.day) {
      return `<div class="seo-empty">Today's list is made when someone in the SEO team opens Tasks.</div>`;
    }
    const list = todayTasks();
    const st = list.flatMap(stepsOf);
    const a = st.filter(doneish).length, b = st.filter((s) => s.status === "ticked").length;
    return `
      <div class="seo-t-prog">
        <div class="seo-t-hb"><i class="g" style="width:${st.length ? (a / st.length) * 100 : 0}%"></i><i class="y" style="width:${st.length ? (b / st.length) * 100 : 0}%"></i></div>
        <span class="seo-note">${a} done · ${b} checking tonight · ${st.length - a - b} to do</span>
      </div>
      <p class="seo-note">${plural(list.length, "task")} · up to ${taskConfig(c.work).perDay} a day · list made by ${esc(S.day.builtByName || "the SEO team")}.
        Unfinished tasks carry over to tomorrow. ${S.canDo ? "" : "Only the SEO team and admins can tick steps."}</p>
      ${(() => {
        const g = todayGaps();
        if (g.missing.length) {
          const names = g.missing.slice(0, 4).map((t) => esc(titleOf(c.work, c.data, t.path))).join(", ") + (g.missing.length > 4 ? "…" : "");
          return `<div class="seo-w-tip">${plural(g.missing.length, "priority page")} ${g.missing.length === 1 ? "isn't" : "aren't"} on today's list yet: ${names}.
            <button class="seo-btn" type="button" data-t-addmissing>Add a task for each</button></div>`;
        }
        return g.fill.length ? `<div class="seo-w-tip">Today's list has room for ${plural(g.fill.length, "more task")}.
          <button class="seo-btn" type="button" data-t-topup>Fill it up</button></div>` : "";
      })()}
      ${list.length ? list.map(taskCard).join("") : `<div class="seo-empty">No tasks today. Star more priority pages, or add tasks from Up next.</div>`}`;
  }

  function nextHtml() {
    const inToday = new Set(S.day?.ids || []);
    const list = [...S.tasks.values()].filter((t) => isLive(c, t) && !inToday.has(t.id)).sort(rankOf(c));
    if (!list.length) return `<div class="seo-empty">Nothing waiting. Every priority page's plan is on today's list or done.</div>`;
    const tone = new Map((c.prRows ? c.prRows() : []).map((r) => [npath(r.path), r]));
    const byPage = new Map();
    for (const t of list) (byPage.get(npath(t.path)) || byPage.set(npath(t.path), []).get(npath(t.path))).push(t);
    return `<p class="seo-note">${plural(list.length, "task")} waiting, in the order they'll come up. Dropping pages first.</p>` +
      [...byPage.values()].map((ts) => {
        const r = tone.get(npath(ts[0].path));
        return `<div class="seo-t-group">
          <div class="seo-t-ghead"><span class="seo-star is-on">★</span><strong>${esc(titleOf(c.work, c.data, ts[0].path))}</strong>
            ${r ? `<span class="seo-pr-pill is-${r.tone}">${esc(r.label)}</span>` : ""}</div>
          ${ts.map((t) => {
            const st = stepsOf(t);
            const skipped = t.skipUntil && t.skipUntil > day;
            return `<div class="seo-t-row">
              <div style="min-width:0"><div>${t.source === "ai" ? `<span class="seo-t-ai">AI</span>` : ""}${esc(t.title)}</div>
                <div class="seo-note">${plural(st.length, "step")}${st.filter(doneish).length ? ` · ${st.filter(doneish).length} done` : ""}${
                  skipped ? ` · skipped until ${esc(fmtDay(t.skipUntil))}: ${esc(t.skipNote || "")}` : ""}</div></div>
              ${t.gain ? `<span class="seo-t-gain">≈ +${t.gain}</span>` : "<span></span>"}
              ${S.canDo && S.day ? `<button class="seo-btn" type="button" data-t-add="${t.id}">Add to today</button>` : "<span></span>"}
            </div>`;
          }).join("")}</div>`;
      }).join("");
  }

  function checkingHtml() {
    const rows = [];
    for (const t of S.tasks.values()) for (const s of stepsOf(t)) if (s.status === "ticked") rows.push({ t, s });
    if (!rows.length) return `<div class="seo-empty">Nothing waiting for the website check.</div>`;
    return `<p class="seo-note">Ticked steps are checked on the website tonight (about 9pm). Not found two nights running, they go back on the list.</p>
      <div class="seo-t-card">${rows.map(({ t, s }) => `<div class="seo-t-step is-ticked">
        <span class="seo-t-ck is-ticked">◷</span>
        <div class="seo-t-sm"><div>${esc(s.text)}</div>
          <div class="seo-note">${esc(titleOf(c.work, c.data, t.path))} · ${esc(s.byName || "")} · ${esc(when(s.at))}${s.misses ? " · not found last night" : ""}</div></div>
        <span class="seo-note seo-t-chk">${esc(CHECK[s.check?.k] || "")}</span></div>`).join("")}</div>`;
  }

  function doneHtml() {
    const list = [...S.tasks.values()].filter((t) => t.status === "done").sort((a, b) => (tsDate(b.doneAt) || 0) - (tsDate(a.doneAt) || 0));
    if (!list.length) return `<div class="seo-empty">No finished tasks yet. A task finishes when the website check confirms every step.</div>`;
    return `<div class="seo-t-card">${list.map((t) => {
      const who = [...new Set(stepsOf(t).map((s) => s.byName).filter(Boolean))];
      return `<div class="seo-t-row">
        <span class="seo-t-ck is-confirmed">✓</span>
        <div style="min-width:0"><div>${esc(t.title)}</div>
          <div class="seo-note">${esc(titleOf(c.work, c.data, t.path))} · finished ${esc(when(t.doneAt))}${who.length ? ` · by ${esc(who.join(", "))}` : ""}</div></div>
        <button class="seo-w-link" type="button" data-t-log>See the effect in the Change log</button>
      </div>`;
    }).join("")}</div>`;
  }

  function trailRow(l) {
    const at = esc(when(l.at));
    if (l.action === "comment") {
      return `<div class="seo-t-cmt${l.by === uid() ? " is-me" : ""}">
        <div class="seo-t-cmeta"><strong>${esc(l.byName || "Someone")}</strong>${l.role ? ` <span class="seo-note">${esc(l.role)}</span>` : ""}
          <span class="seo-note">· ${at}</span></div>
        <div class="seo-t-ctext">${esc(l.text)}</div></div>`;
    }
    const q = (s) => `“${esc(s)}”`;
    const what = {
      priority: esc(l.note), tick: `ticked ${q(l.text)}`, done: `marked done ${q(l.text)}`,
      untick: `undid the tick on ${q(l.text)}${l.note ? ": " + esc(l.note) : ""}`, confirm: `Website confirmed ${q(l.text)}`,
      missing: `Not found on the website: ${q(l.text)}`, skip: `skipped ${q(l.taskTitle)}: ${esc(l.note)}`,
      unskip: `brought back ${q(l.taskTitle)}`, add: `added ${q(l.taskTitle)} to the day's list`,
      taskdone: `Task finished: ${q(l.taskTitle)}`, dismiss: `dismissed the AI task ${q(l.taskTitle)}: ${esc(l.note)}`,
    }[l.action] || esc(l.action);
    const system = l.by === "website" || ["confirm", "missing", "taskdone"].includes(l.action);
    return `<div class="seo-t-ev"><span class="seo-note">${at}</span> ${system ? "" : `<strong>${esc(l.byName || "Someone")}</strong> `}${what}</div>`;
  }

  function trailHtml(p) {
    const k = npath(p);
    const list = (S.trail[k] || S.log.filter((l) => npath(l.path || "") === k)).slice()
      .sort((a, b) => (tsDate(b.at)?.getTime() || 0) - (tsDate(a.at)?.getTime() || 0));
    const shown = list.slice(0, ui.trailAll ? 500 : 25);
    return `<div class="seo-t-trail">
      ${S.canDo ? `<div class="seo-t-cbox">
          <textarea class="seo-input" data-t-ctext rows="2" maxlength="1000"
            placeholder="Add a comment for the SEO team, e.g. “Jasper, the doctors want this page updated before the spring promo”"></textarea>
          <div class="seo-w-acts"><button class="seo-btn on" type="button" data-t-cadd="${esc(p)}">Add comment</button>
            <span class="seo-note">Comments can't be edited or deleted.</span></div>
          <div class="seo-t-err" data-t-cerr></div></div>` : ""}
      ${S.trail[k] ? "" : `<p class="seo-note">Loading the full history…</p>`}
      ${shown.length ? shown.map(trailRow).join("") : `<p class="seo-note">No comments or activity yet.</p>`}
      ${list.length > shown.length ? `<button class="seo-w-link" type="button" data-t-trailall>Show all ${list.length}</button>` : ""}
    </div>`;
  }

  function pagesHtml() {
    const paths = prioritySettings(c.work).paths;
    if (!paths.length) return `<div class="seo-empty">No priority pages yet. Star pages in the Pages tab or Settings → ★ Priority pages.</div>`;
    const rows = new Map((c.prRows ? c.prRows() : []).map((r) => [npath(r.path), r]));
    const seen = seenMap();
    return `<p class="seo-note">Tasks follow this order, #1 first. ${c.isAdmin ? "Use the arrows to change it." : "Admins can change the order."}
        Click a page for its comments and history.</p>
      <div class="seo-t-plist">${paths.map((p, i) => {
        const k = npath(p);
        const r = rows.get(k);
        const st = [...S.tasks.values()].filter((t) => npath(t.path) === k && t.status !== "dismissed").flatMap(stepsOf);
        const d = st.filter(doneish).length, y = st.filter((s) => s.status === "ticked").length;
        const cm = S.log.filter((l) => l.action === "comment" && npath(l.path || "") === k);
        const nw = cm.filter((l) => isNew(l, seen)).length;
        const open = ui.page === k;
        return `<div class="seo-t-pp${open ? " is-open" : ""}" data-sort-key="${esc(p)}">
          <div class="seo-t-pph" data-t-page="${esc(p)}" role="button" tabindex="0" aria-expanded="${open}">
            <span class="seo-t-num is-big">${c.isAdmin ? `<span class="seo-t-grip" data-sort-grip title="Drag to change the order" aria-hidden="true">⋮⋮</span>` : ""}#${i + 1}</span>
            ${c.isAdmin ? `<span class="seo-t-move">
              <button class="seo-btn" type="button" data-t-mv="${i}|-1" title="Move up" aria-label="Move up"${i ? "" : " disabled"}>↑</button>
              <button class="seo-btn" type="button" data-t-mv="${i}|1" title="Move down" aria-label="Move down"${i < paths.length - 1 ? "" : " disabled"}>↓</button></span>` : ""}
            <div style="min-width:0"><strong class="seo-path" style="display:block">${esc(titleOf(c.work, c.data, p))}</strong>
              <span class="seo-note seo-path" style="display:block">${esc(p)}</span></div>
            ${r ? `<span class="seo-pr-pill is-${r.tone}">${esc(r.label)}</span>` : "<span></span>"}
            <div class="seo-t-ppbar"><div class="seo-t-hb"><i class="g" style="width:${st.length ? (d / st.length) * 100 : 0}%"></i><i class="y" style="width:${st.length ? (y / st.length) * 100 : 0}%"></i></div>
              <span class="seo-note">${d}/${st.length} steps</span></div>
            <span class="seo-t-cm${nw ? " is-new" : ""}">${nw ? `${nw} new` : cm.length ? `${cm.length} comment${cm.length === 1 ? "" : "s"}` : ""}</span>
          </div>
          ${open ? trailHtml(p) : ""}
        </div>`;
      }).join("")}</div>`;
  }

  async function openPage(p) {
    const k = npath(p);
    ui.page = ui.page === k ? "" : k;
    ui.trailAll = false;
    draw();
    if (!ui.page) return;
    markSeen(k);
    if (!S.trail[k]) {
      try {
        const snap = await getDocs(query(collection(db, "seo_task_log"), where("path", "==", p)));
        S.trail[k] = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
      } catch (e) { console.warn("Trail not loaded:", e); S.trail[k] = S.log.filter((l) => npath(l.path || "") === k); }
      if (ui.page === k && ui.view === "pages") draw();
    }
  }

  function reviewHtml() {
    const since = addDays(day, -6);
    const recent = S.log.filter((l) => (l.day || "") >= since);
    const cnt = (...a) => recent.filter((l) => a.includes(l.action)).length;
    const waiting = [...S.tasks.values()].flatMap(stepsOf).filter((s) => s.status === "ticked").length;
    const days = Array.from({ length: 7 }, (_, i) => addDays(since, i));
    const per = days.map((d) => {
      const L = recent.filter((l) => l.day === d);
      const k = (...a) => L.filter((l) => a.includes(l.action)).length;
      return { d, g: k("confirm"), y: k("tick", "done"), r: k("skip"), m: k("missing") };
    });
    const max = Math.max(1, ...per.map((x) => x.g + x.y + x.r + x.m));
    const bar = (v, cls) => (v ? `<i class="${cls}" style="height:${(v / max) * 110}px" title="${v}"></i>` : "");

    const rows = c.prRows ? c.prRows() : [];
    const pages = rows.map((r) => {
      const st = [...S.tasks.values()].filter((t) => npath(t.path) === npath(r.path)).flatMap(stepsOf);
      const d = st.filter(doneish).length, y = st.filter((s) => s.status === "ticked").length;
      return `<div class="seo-t-prow">
        <span class="seo-path"><span class="seo-star is-on">★</span>${esc(titleOf(c.work, c.data, r.path))}</span>
        <div class="seo-t-hb"><i class="g" style="width:${st.length ? (d / st.length) * 100 : 0}%"></i><i class="y" style="width:${st.length ? (y / st.length) * 100 : 0}%"></i></div>
        <span class="seo-note">${d}/${st.length}</span>
        <span class="seo-pr-pill is-${r.tone}">${esc(r.label)}</span></div>`;
    }).join("");

    const ICON = {
      tick: ["◷", "is-y"], done: ["✓", "is-b"], untick: ["↺", ""], confirm: ["✓", "is-g"], missing: ["⚠", "is-y"], skip: ["⏭", "is-r"],
      unskip: ["↩", ""], add: ["+", ""], plan: ["☰", ""], taskdone: ["★", "is-g"], dismiss: ["✕", "is-r"],
    };
    const line = (l) => {
      const q = (s) => `“${esc(s)}”`;
      const who = esc(l.byName || "Someone");
      return {
        tick: `${who} ticked ${q(l.text)}`, done: `${who} marked done ${q(l.text)} (can't be checked)`,
        untick: `${who} undid the tick on ${q(l.text)}`, confirm: `Website confirmed ${q(l.text)}`,
        missing: `Not found on the website: ${q(l.text)}`, skip: `${who} skipped ${q(l.taskTitle)}`,
        unskip: `${who} brought back ${q(l.taskTitle)}`,
        add: l.taskTitle ? `${who} added ${q(l.taskTitle)} to today` : `${who} topped up today's list`,
        plan: `${who} made the day's list`, taskdone: `Task finished: ${q(l.taskTitle)}`,
        dismiss: `${who} dismissed the AI task ${q(l.taskTitle)}`,
      }[l.action] || esc(l.action);
    };
    const feed = S.log.slice(0, 80).map((l) => {
      const [ic, cls] = ICON[l.action] || ["•", ""];
      return `<div class="seo-t-frow"><span class="seo-t-fi ${cls}">${ic}</span>
        <div style="min-width:0">${line(l)}${l.path ? ` <span class="seo-note">· ${esc(titleOf(c.work, c.data, l.path))}</span>` : ""}
          <div class="seo-note">${esc(when(l.at))}${l.note ? " · " + esc(l.note) : ""}</div></div></div>`;
    }).join("");

    return `
      <div class="seo-t-mets">
        <div><span>Ticked this week</span><strong>${cnt("tick", "done")}</strong></div>
        <div><span>Confirmed on the website</span><strong class="is-g">${cnt("confirm")}</strong></div>
        <div><span>Checking tonight</span><strong class="is-y">${waiting}</strong></div>
        <div><span>Skipped</span><strong class="is-r">${cnt("skip")}</strong></div>
        <div><span>Not found</span><strong class="is-y">${cnt("missing")}</strong></div>
      </div>
      <div class="seo-card">
        <div class="seo-row" style="margin:0"><h3 style="margin:0">Last 7 days</h3><span class="seo-sp"></span>
          <span class="seo-note"><i class="seo-t-lg g"></i>confirmed <i class="seo-t-lg y"></i>ticked <i class="seo-t-lg r"></i>skipped <i class="seo-t-lg m"></i>not found</span></div>
        <div class="seo-t-week">${per.map((x) => `<div title="${esc(fmtDay(x.d))}: ${x.g} confirmed, ${x.y} ticked, ${x.r} skipped, ${x.m} not found">
          <div class="seo-t-stack">${bar(x.m, "m")}${bar(x.r, "r")}${bar(x.y, "y")}${bar(x.g, "g")}</div>
          <span class="seo-note">${esc(fmtDay(x.d).split(",")[0])}</span></div>`).join("")}</div>
      </div>
      <div class="seo-card"><h3>Priority pages: how far through their plans</h3>${pages || `<p class="seo-note">No priority pages yet.</p>`}</div>
      ${(() => {
        const all = [...S.tasks.values()];
        const sum = (L) => ({ n: L.length, done: L.filter((t) => t.status === "done").length, dis: L.filter((t) => t.status === "dismissed").length });
        const a = sum(all.filter((t) => t.source === "ai")), r = sum(all.filter((t) => t.source !== "ai"));
        if (!a.n) return `<div class="seo-card"><h3>AI suggestions</h3><p class="seo-note">None yet. Claude reviews a few priority pages each night (Settings → Tasks).</p></div>`;
        const pct = (x, n) => (n ? Math.round((x / n) * 100) + "%" : "—");
        const reasons = S.log.filter((l) => l.action === "dismiss").slice(0, 5);
        return `<div class="seo-card"><h3>AI suggestions vs rule-based tasks</h3>
          <table class="seo-w-mini"><thead><tr><th></th><th>Made</th><th>Finished</th><th>Dismissed</th></tr></thead><tbody>
            <tr><td><span class="seo-t-ai">AI</span> Claude</td><td>${a.n}</td><td>${a.done} (${pct(a.done, a.n)})</td><td>${a.dis} (${pct(a.dis, a.n)})</td></tr>
            <tr><td>Rule-based</td><td>${r.n}</td><td>${r.done} (${pct(r.done, r.n)})</td><td>—</td></tr></tbody></table>
          ${reasons.length ? `<p class="seo-note" style="margin-top:8px">Recent reasons for dismissing: ${reasons.map((l) => `“${esc(l.note || "")}”`).join(" · ")}</p>` : ""}
          <p class="seo-note">Each finished task has a Change log entry, which shows its effect on clicks.</p></div>`;
      })()}
      <div class="seo-card"><h3>Activity</h3>${feed || `<p class="seo-note">Nothing yet.</p>`}</div>`;
  }

  function draw() {
    const counts = {
      today: todayTasks().filter((t) => t.status !== "done").length,
      next: [...S.tasks.values()].filter((t) => isLive(c, t) && !(S.day?.ids || []).includes(t.id)).length,
      checking: [...S.tasks.values()].flatMap(stepsOf).filter((s) => s.status === "ticked").length,
      done: [...S.tasks.values()].filter((t) => t.status === "done").length,
    };
    const seen = seenMap();
    const newCm = S.log.filter((l) => isNew(l, seen) && isPri(c, l.path || "")).length;
    const tabs = [["today", "Today", counts.today], ["pages", newCm ? `★ Pages <span class="seo-t-dot">${newCm} new</span>` : "★ Pages", null],
      ["next", "Up next", counts.next], ["checking", "Checking", counts.checking],
      ["done", "Done", counts.done], ["review", "Review", null], ["ideas", "All ideas", null]];
    wrap.innerHTML = `
      <div class="seo-row seo-t-head">
        <h2 style="margin:0;font-size:18px">${ui.view === "today" ? `Today · ${esc(fmtDay(day))}` : "SEO tasks"}</h2>
        <span class="seo-note">SEO team</span><span class="seo-sp"></span>
        ${tabs.map(([k, l, n]) => `<button class="seo-w-stab ${ui.view === k ? "is-on" : ""}" type="button" data-t-view="${k}">${l}${n != null ? ` <span class="seo-w-n">${n}</span>` : ""}</button>`).join("")}
      </div>
      <div data-t-body>${ui.view === "pages" ? pagesHtml() : ui.view === "next" ? nextHtml() : ui.view === "checking" ? checkingHtml() : ui.view === "done" ? doneHtml()
        : ui.view === "review" ? reviewHtml() : ui.view === "ideas" ? "" : todayHtml()}</div>`;
    if (ui.view === "ideas") {
      const box = wrap.querySelector("[data-t-body]");
      box.innerHTML = `<p class="seo-note">Every opportunity from the search data, including pages that aren't priority pages. Star a page to turn its ideas into tasks.</p><div></div>`;
      renderOppsInto(box.lastElementChild, c);
    }
  }

  wrap.addEventListener("click", async (e) => {
    const t0 = e.target.closest("button");
    if (!t0) {
      const ph = e.target.closest("[data-t-page]");
      if (ph) openPage(ph.dataset.tPage);
      return;
    }
    if (t0.dataset.open !== undefined) return;   // seo.js opens the page panel
    const d = t0.dataset;

    if (d.tCmts) { ui.view = "pages"; ui.page = ""; openPage(d.tCmts); return; }
    if (d.tTrailall !== undefined) { ui.trailAll = true; draw(); return; }

    if (d.tMv) {
      if (!c.isAdmin) { toast("Only admins can change the order.", true); return; }
      const [i, dir] = d.tMv.split("|").map(Number);
      const paths = prioritySettings(c.work).paths.slice();
      const j = i + dir;
      if (j < 0 || j >= paths.length) return;
      [paths[i], paths[j]] = [paths[j], paths[i]];
      t0.disabled = true;
      await saveOrder(paths, i, j);
      return;
    }
    if (false) {
      const paths = [], i = 0, j = 0;   // (old code below, kept unreachable so nothing else needs moving)
      try {
        const b = writeBatch(db);
        b.set(doc(db, "seo_settings", "main"), { keyPages: paths, updatedBy: uid(), updatedAt: serverTimestamp() }, { merge: true });
        const entry = { taskId: "", path: paths[j], taskTitle: "", stepId: "", text: "", note: `moved to #${j + 1} (was #${i + 1})`,
          action: "priority", by: uid(), byName: myName(c), role: roleOf(c), day, at: serverTimestamp() };
        b.set(doc(collection(db, "seo_task_log")), entry);
        await b.commit();
        c.work.settings = { ...(c.work.settings || {}), keyPages: paths };
        const local = { ...entry, at: new Date() };
        S.log.unshift(local);
        if (S.trail[npath(paths[j])]) S.trail[npath(paths[j])].unshift(local);
        draw();
      } catch (e2) { t0.disabled = false; toast(errMsg(e2), true); }
      return;
    }

    if (d.tCadd) {
      if (!S.canDo) { toast("Only the SEO team and admins can comment.", true); return; }
      const box = wrap.querySelector("[data-t-ctext]");
      const txt = (box?.value || "").trim();
      if (txt.length < 2) { const er = wrap.querySelector("[data-t-cerr]"); if (er) er.textContent = "Write a comment first."; return; }
      t0.disabled = true;
      try {
        const entry = { taskId: "", path: d.tCadd, taskTitle: "", stepId: "", text: txt.slice(0, 1000), note: "",
          action: "comment", by: uid(), byName: myName(c), role: roleOf(c), day, at: serverTimestamp() };
        const b = writeBatch(db);
        b.set(doc(collection(db, "seo_task_log")), entry);
        await b.commit();
        const local = { ...entry, at: new Date() };
        S.log.unshift(local);
        const k = npath(d.tCadd);
        (S.trail[k] || (S.trail[k] = [])).unshift(local);
        markSeen(k);
        toast("Comment added");
        draw();
      } catch (e2) { t0.disabled = false; toast(errMsg(e2), true); }
      return;
    }
    if (d.tView) { ui.view = d.tView; ui.skip = ""; draw(); return; }
    if (d.tLog !== undefined) { c.setTab("log"); return; }
    if (d.tCopy) {
      const t = S.tasks.get(d.tCopy);
      const txt = [`${t.title} — ${titleOf(c.work, c.data, t.path)}`, `Page: ${t.path}`, ""]
        .concat(stepsOf(t).filter((s) => !doneish(s)).map((s, i) => `${i + 1}. ${s.text}${s.detail ? `\n   ${s.detail}` : ""}`)).join("\n");
      const ok = await copyText(txt);
      toast(ok ? "Brief copied" : "Couldn't copy", !ok);
      return;
    }
    if (!S.canDo && (d.tCk || d.tSkip || d.tAdd || d.tUnskip || d.tAddmissing !== undefined || d.tTopup !== undefined)) {
      toast("Only the SEO team and admins can change tasks.", true); return;
    }

    if (d.tAddmissing !== undefined || d.tTopup !== undefined) {
      const g = todayGaps();
      const add = (d.tTopup !== undefined ? g.fill : g.missing).map((t) => t.id).slice(0, Math.max(0, 40 - (S.day.ids || []).length));
      if (!add.length) return;
      const note = `${plural(add.length, "task")} added: ${add.map((id) => S.tasks.get(id)?.title || "").join(", ")}`.slice(0, 500);
      t0.disabled = true;
      try {
        const b = writeBatch(db);
        b.update(doc(db, "seo_task_days", day), { ids: arrayUnion(...add) });
        b.set(doc(collection(db, "seo_task_log")), { taskId: "", path: "", taskTitle: "", stepId: "", text: "", action: "add", note,
          by: uid(), byName: myName(c), role: roleOf(c), day, at: serverTimestamp() });
        await b.commit();
        S.day.ids = [...(S.day.ids || []), ...add];
        S.log.unshift({ action: "add", note, byName: myName(c), at: new Date(), day });
        toast(`Added ${plural(add.length, "task")} to today`);
        draw();
      } catch (e2) { t0.disabled = false; toast(errMsg(e2), true); }
      return;
    }

    if (d.tCk) {
      const [taskId, stepId] = d.tCk.split("|");
      const t = S.tasks.get(taskId), s = t?.steps[stepId];
      if (!s) return;
      if (s.status === "confirmed") { toast("Confirmed on the website, so it stays done."); return; }
      const P = `steps.${stepId}.`;
      t0.disabled = true;
      try {
        if (s.status === "todo" || !s.status) {
          const manual = s.check?.k === "manual";
          await act(c, S, t, { [P + "status"]: manual ? "done" : "ticked", [P + "by"]: uid(), [P + "byName"]: myName(c),
            [P + "at"]: new Date().toISOString(), [P + "misses"]: 0, [P + "missing"]: false },
            { action: manual ? "done" : "tick", stepId, text: s.text });
          toast(manual ? "Marked done" : "Ticked. Checked on the website tonight.");
        } else {
          const note = prompt(`Undo the tick on “${s.text}”? This is logged. Reason (optional):`, "");
          if (note === null) { t0.disabled = false; return; }
          await act(c, S, t, { [P + "status"]: "todo", [P + "by"]: "", [P + "byName"]: "", [P + "at"]: "" },
            { action: "untick", stepId, text: s.text, note: note.trim().slice(0, 300) });
        }
        draw();
      } catch (err) { t0.disabled = false; toast(errMsg(err), true); }
      return;
    }
    if (d.tDismiss) {
      if (!S.canDo) { toast("Only the SEO team and admins can change tasks.", true); return; }
      const t = S.tasks.get(d.tDismiss);
      const why = prompt(`Dismiss “${t.title}”? Claude is told the reason next time. Why?`, "");
      if (why === null) return;
      if (why.trim().length < 3) { toast("Add a short reason.", true); return; }
      t0.disabled = true;
      try {
        await act(c, S, t, { status: "dismissed", dismissNote: why.trim().slice(0, 300), dismissBy: uid(), dismissByName: myName(c),
          dismissAt: new Date().toISOString() }, { action: "dismiss", note: why.trim().slice(0, 300) });
        toast("Dismissed");
        draw();
      } catch (e2) { t0.disabled = false; toast(errMsg(e2), true); }
      return;
    }
    if (d.tSkip) { ui.skip = d.tSkip; draw(); wrap.querySelector("[data-t-why]")?.focus(); return; }
    if (d.tSkipno !== undefined) { ui.skip = ""; draw(); return; }
    if (d.tSkipok) {
      const t = S.tasks.get(d.tSkipok);
      const why = wrap.querySelector("[data-t-why]").value.trim();
      const until = wrap.querySelector("[data-t-until]").value;
      const err = wrap.querySelector("[data-t-err]");
      if (!why) { err.textContent = "Add a reason first."; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= day) { err.textContent = "Choose a day after today."; return; }
      t0.disabled = true;
      try {
        await act(c, S, t, { skipUntil: until, skipNote: why.slice(0, 300), skipBy: uid(), skipByName: myName(c), skipAt: new Date().toISOString() },
          { action: "skip", note: `${why.slice(0, 300)} · back ${fmtDay(until)}` });
        ui.skip = "";
        toast(`Skipped until ${fmtDay(until)}`);
        draw();
      } catch (e2) { t0.disabled = false; toast(errMsg(e2), true); }
      return;
    }
    if (d.tUnskip) {
      const t = S.tasks.get(d.tUnskip);
      t0.disabled = true;
      try { await act(c, S, t, { skipUntil: "", skipNote: "" }, { action: "unskip" }); draw(); }
      catch (e2) { t0.disabled = false; toast(errMsg(e2), true); }
      return;
    }
    if (d.tAdd) {
      const t = S.tasks.get(d.tAdd);
      t0.disabled = true;
      try {
        const b = writeBatch(db);
        b.update(doc(db, "seo_task_days", day), { ids: arrayUnion(t.id) });
        b.set(doc(collection(db, "seo_task_log")), { taskId: t.id, path: t.path, taskTitle: t.title, stepId: "", text: "", note: "",
          action: "add", by: uid(), byName: myName(c), role: roleOf(c), day, at: serverTimestamp() });
        if (t.skipUntil) b.update(doc(db, "seo_tasks", t.id), { skipUntil: "", skipNote: "", updatedAt: serverTimestamp() });
        await b.commit();
        S.day.ids = [...(S.day.ids || []), t.id];
        t.skipUntil = "";
        S.log.unshift({ taskId: t.id, path: t.path, taskTitle: t.title, action: "add", byName: myName(c), at: new Date(), day });
        toast("Added to today");
        draw();
      } catch (e2) { t0.disabled = false; toast(errMsg(e2), true); }
    }
  });

  // Save a new priority order, and log the page that moved in its trail
  async function saveOrder(paths, from, to) {
    try {
      const b = writeBatch(db);
      b.set(doc(db, "seo_settings", "main"), { keyPages: paths, updatedBy: uid(), updatedAt: serverTimestamp() }, { merge: true });
      const entry = { taskId: "", path: paths[to], taskTitle: "", stepId: "", text: "", note: `moved to #${to + 1} (was #${from + 1})`,
        action: "priority", by: uid(), byName: myName(c), role: roleOf(c), day, at: serverTimestamp() };
      b.set(doc(collection(db, "seo_task_log")), entry);
      await b.commit();
      c.work.settings = { ...(c.work.settings || {}), keyPages: paths };
      const local = { ...entry, at: new Date() };
      S.log.unshift(local);
      if (S.trail[npath(paths[to])]) S.trail[npath(paths[to])].unshift(local);
    } catch (e2) { toast(errMsg(e2), true); }
    draw();
  }

  makeSortable(wrap, (keys, from, to) => { if (c.isAdmin) saveOrder(keys, from, to); });

  wrap.addEventListener("keydown", (e) => {   // open a page with the keyboard too
    const ph = e.target.closest?.("[data-t-page]");
    if (ph && e.target === ph && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPage(ph.dataset.tPage); }
  });
  
  draw();
}

/* ---------- styles ---------- */

const CSS = `
.seo-t-head{gap:6px;margin-bottom:12px}
.seo-t-prog{display:flex;align-items:center;gap:10px;margin:2px 0 6px}
.seo-t-hb{flex:1;display:flex;height:8px;border-radius:4px;background:#e5e7eb;overflow:hidden;min-width:60px}
.seo-t-hb i{display:block;height:100%}
.seo-t-hb .g,.seo-t-stack .g,.seo-t-lg.g{background:#16a34a}
.seo-t-hb .y,.seo-t-stack .y,.seo-t-lg.y{background:#f59e0b}
.seo-t-stack .r,.seo-t-lg.r{background:#dc2626}
.seo-t-stack .m,.seo-t-lg.m{background:#fde68a}
.seo-t-card{margin:0 0 10px;padding:12px 14px;border:1px solid var(--border,#e5e7eb);border-radius:12px;background:var(--card,#fff)}
.seo-t-card.is-skipped{opacity:.7}
.seo-t-card.is-done{background:#f0fdf4;border-color:#bbf7d0}
.seo-t-chead{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:12px;align-items:center}
.seo-t-ring{width:38px;height:38px}
.seo-t-page{font-size:12px;color:var(--text-muted,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seo-t-title{font-size:15px;font-weight:600;margin-top:1px}
.seo-t-side{text-align:right}
.seo-t-gain{font-size:12px;font-weight:600;color:#16a34a;white-space:nowrap}
.seo-t-num{display:inline-block;margin-right:6px;font-weight:700;color:#b45309}
.seo-t-num.is-big{min-width:34px;margin:0;font-size:16px}
.seo-t-newbtn{border-color:#f59e0b !important;background:#fffbeb !important;color:#b45309 !important;font-weight:600}
.seo-t-dot{margin-left:4px;padding:0 6px;border-radius:999px;background:#f59e0b;color:#fff;font-size:11px;font-weight:700}
.seo-t-plist{border:1px solid var(--border,#e5e7eb);border-radius:12px;background:var(--card,#fff);overflow:hidden}
.seo-t-pp{border-top:1px solid var(--border,#e5e7eb)}
.seo-t-pp:first-child{border-top:0}
.seo-t-pp.is-open{background:#fafbff}
.seo-t-pph{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto 170px 90px;gap:12px;align-items:center;padding:10px 14px;cursor:pointer}
.seo-t-pph:hover{background:#f8fafc}
.seo-t-move{display:flex;gap:2px}
.seo-t-move .seo-btn{padding:2px 8px}
.seo-t-ppbar{display:flex;align-items:center;gap:8px}
.seo-t-cm{font-size:12px;color:var(--text-muted,#6b7280);text-align:right}
.seo-t-cm.is-new{color:#b45309;font-weight:700}
.seo-t-trail{padding:4px 14px 14px 60px}
.seo-t-cbox{margin:4px 0 10px}
.seo-t-cbox textarea{width:100%;min-width:0;box-sizing:border-box;resize:vertical}
.seo-t-cmt{margin:8px 0;padding:8px 12px;border-radius:10px;background:#eff6ff;max-width:640px}
.seo-t-cmt.is-me{background:#f1f5f9}
.seo-t-cmeta{font-size:12px}
.seo-t-ctext{margin-top:3px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.seo-t-ev{padding:5px 0;font-size:12.5px;border-top:1px dashed var(--border,#e5e7eb)}
@media (max-width:760px){
  .seo-t-pph{grid-template-columns:auto minmax(0,1fr) auto}
  .seo-t-pph .seo-t-move,.seo-t-ppbar{grid-column:2}
  .seo-t-trail{padding-left:14px}
}
.seo-t-ai{display:inline-block;margin-right:6px;padding:0 6px;border-radius:999px;background:#f5f3ff;color:#6d28d9;font-size:10.5px;font-weight:700;letter-spacing:.03em;vertical-align:2px}
.seo-t-steps{margin-top:8px}
.seo-t-step{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;align-items:start;padding:8px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-t-step.is-confirmed .seo-t-sm > div:first-child{color:var(--text-muted,#6b7280)}
.seo-t-sm{min-width:0;line-height:1.45}
.seo-t-sm .seo-note{margin-top:2px}
.seo-t-ck{width:20px;height:20px;margin-top:1px;padding:0;border:1.5px solid #94a3b8;border-radius:6px;background:var(--card,#fff);color:#fff;font-size:12px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.seo-t-ck:hover{border-color:var(--accent,#2563eb)}
.seo-t-ck.is-ticked{background:#fffbeb;border-color:#f59e0b;color:#b45309}
.seo-t-ck.is-done{background:#2563eb;border-color:#2563eb}
.seo-t-ck.is-confirmed{background:#16a34a;border-color:#16a34a;cursor:default}
.seo-t-chk{white-space:nowrap}
.seo-t-miss{color:#b45309;font-weight:600}
.seo-t-skip{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}
.seo-t-skip [data-t-why]{flex:1;min-width:220px}
.seo-t-skip label{display:flex;align-items:center;gap:6px}
.seo-t-skip input[type=date]{min-width:0}
.seo-t-err{flex-basis:100%;font-size:12px;color:#dc2626}
.seo-t-group{margin:0 0 10px;padding:10px 14px;border:1px solid var(--border,#e5e7eb);border-radius:12px;background:var(--card,#fff)}
.seo-t-ghead{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:14px}
.seo-t-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-t-card .seo-t-row{grid-template-columns:24px minmax(0,1fr) auto}
.seo-t-card .seo-t-row:first-child{border-top:0}
.seo-t-mets{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px}
.seo-t-mets div{padding:10px 12px;border-radius:10px;background:#f8fafc;border:1px solid var(--border,#e5e7eb)}
.seo-t-mets span{display:block;font-size:12px;color:var(--text-muted,#6b7280)}
.seo-t-mets strong{font-size:22px}
.seo-t-mets .is-g{color:#16a34a}.seo-t-mets .is-y{color:#d97706}.seo-t-mets .is-r{color:#dc2626}
.seo-t-week{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;align-items:end;height:150px;margin-top:10px}
.seo-t-week > div{display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end}
.seo-t-stack{display:flex;flex-direction:column;gap:2px;width:60%;max-width:46px}
.seo-t-stack i{display:block;border-radius:3px}
.seo-t-lg{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 3px 0 10px;vertical-align:-1px}
.seo-t-prow{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) 48px 110px;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-t-frow{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;padding:7px 0;border-top:1px solid var(--border,#e5e7eb);font-size:13px}
.seo-t-fi{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#f1f5f9;font-size:11px}
.seo-t-fi.is-g{background:#dcfce7;color:#15803d}.seo-t-fi.is-y{background:#fef3c7;color:#b45309}
.seo-t-fi.is-r{background:#fee2e2;color:#b91c1c}.seo-t-fi.is-b{background:#dbeafe;color:#1d4ed8}
@media (max-width:640px){
  .seo-t-step{grid-template-columns:24px minmax(0,1fr)}
  .seo-t-chk{grid-column:2}
  .seo-t-prow{grid-template-columns:1fr 1fr}
}
`;

function injectCss() {
  if (document.getElementById("seo-tasks-css")) return;
  const s = document.createElement("style");
  s.id = "seo-tasks-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}