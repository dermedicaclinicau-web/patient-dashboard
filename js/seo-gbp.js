// seo-gbp.js — SEO → Google Business: the clinic's Google Business Profile (one location).
// Reads seo_state/gbp, gbp_kw, gbp_profile, gbp_reviews, gbp_posts, gbp_run and seo_gbp_reviews (SeoGbp.gs).
// Admins reply to reviews and publish posts through Apps Script (action "seoGbp").
// Nothing goes to Google until a person presses Send or Publish.

import { db } from "./firebase-config.js";
import { doc, getDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { askConfirm, injectCss as fxCss } from "./seo-content.js";

const COLS = ["date", "searchDesktop", "searchMobile", "mapsDesktop", "mapsMobile", "calls", "website", "directions", "bookings", "messages"];
const METRIC = { views: "Views on Google", calls: "Calls", website: "Website clicks", directions: "Directions" };
const BTN = { LEARN_MORE: "Learn more", BOOK: "Book", CALL: "Call now", "": "No button" };
const PSTATE = { LIVE: ["Live", "green"], PROCESSING: ["Google is checking it", "amber"], REJECTED: ["Rejected by Google", "red"] };
const POST_MAX = 1500, POST_BEST = 1400, REPLY_BEST = 600;

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const json = (s, def) => { try { return typeof s === "string" && s ? JSON.parse(s) : def; } catch { return def; } };
const plural = (n, w) => `${Number(n || 0).toLocaleString("en-AU")} ${w}${n === 1 ? "" : "s"}`;
const dDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Perth" }) : "";
};
const tsWhen = (t) => {
  const d = t?.toDate ? t.toDate() : t ? new Date(t) : null;
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Australia/Perth" }) : "";
};
const monthName = (ym) => new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
const stars = (n) => {
  n = Math.max(0, Math.min(5, Number(n) || 0));
  return `<span class="seo-gb-stars" aria-label="${n} out of 5 stars">${"★".repeat(n)}<i>${"☆".repeat(5 - n)}</i></span>`;
};
const spin = '<span class="seo-gb-spin" aria-hidden="true"></span>';

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

async function api(op, data = {}) {
  const r = await callApi({ action: "seoGbp", op, ...data });
  if (r && r.ok === false) { const e = new Error(r.error || "Something went wrong."); e.code = r.error; throw e; }
  if (r && r.problem) throw new Error(r.problem);
  return r || {};
}
const errText = (e) => (e && e.code === "FORBIDDEN" ? "Only Admins can do that."
  : e && e.code === "UNAUTHORIZED" ? "You've been signed out. Sign in again, then try again."
  : /permission/i.test(e?.message || "") ? "You don't have access to Google Business data (needs the SEO menu permission)."
  : (e && e.message) || "Something went wrong. Try again.");

function sumDays(days, from, to) {
  const o = { search: 0, maps: 0, calls: 0, website: 0, directions: 0, bookings: 0, messages: 0, n: 0 };
  for (const d of days) {
    if (d.date < from || d.date > to) continue;
    o.n++;
    o.search += d.searchDesktop + d.searchMobile;
    o.maps += d.mapsDesktop + d.mapsMobile;
    o.calls += d.calls; o.website += d.website; o.directions += d.directions; o.bookings += d.bookings; o.messages += d.messages;
  }
  o.views = o.search + o.maps;
  return o;
}

/* ---------- data (cached for the session; Refresh reloads) ---------- */

const cache = { v: null, pending: null };
let countV = null, countP = null, profP = null;

export function clearGbp() { cache.v = null; countV = null; profP = null; }

export async function loadGbp(force) {
  if (cache.v && !force) return cache.v;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const get = (id) => getDoc(doc(db, "seo_state", id)).then((s) => (s.exists() ? s.data() : null));
    const soft = (id) => get(id).catch((e) => { console.warn("Google Business " + id + " not read:", e); return null; });
    let reviewsErr = "";
    const [g, kw, prof, rs, posts, run, revSnap] = await Promise.all([
      get("gbp"), soft("gbp_kw"), soft("gbp_profile"), soft("gbp_reviews"), soft("gbp_posts"), soft("gbp_run"),
      getDocs(collection(db, "seo_gbp_reviews")).catch((e) => { reviewsErr = errText(e); return null; }),
    ]);
    if (!g) return { none: true, run };
    const cols = Array.isArray(g.cols) && g.cols.length ? g.cols : COLS;
    const days = json(g.days, []).map((r) => Object.fromEntries(cols.map((k, i) => [k, k === "date" ? String(r[i]) : Number(r[i]) || 0])))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)).sort((a, b) => a.date.localeCompare(b.date));
    const reviews = revSnap ? revSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.gone !== true)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))) : [];
    return {
      none: false, days, from: g.from, to: g.to,
      kw: json(kw?.months, []).filter((m) => Array.isArray(m) && m[0]),
      profile: prof?.summary || null,
      changes: (Array.isArray(prof?.changes) ? prof.changes : []).slice().reverse(),
      rstate: rs, posts: json(posts?.list, []).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))),
      run, reviews, reviewsErr,
    };
  })();
  try { cache.v = await cache.pending; return cache.v; } finally { cache.pending = null; }
}

// For the tab label in seo.js: reviews without a reply (Admins only)
export function loadGbpCount() {
  if (cache.v || countV != null) return Promise.resolve();
  return (countP ||= getDoc(doc(db, "seo_state", "gbp_reviews"))
    .then((s) => { countV = s.exists() ? Number(s.data().unreplied) || 0 : 0; })
    .finally(() => { countP = null; }));
}
export function gbpTabHtml(admin) {
  const n = !admin ? 0 : cache.v && !cache.v.none ? cache.v.reviews.filter((r) => !r.replied).length : countV || 0;
  return `Google Business${n ? ` <span class="seo-tab-n" title="${n} review${n === 1 ? "" : "s"} without a reply">${n}</span>` : ""}`;
}
// For the Overview, Audience and Results: what's loaded (null when not connected or not loaded yet)
export const peekGbp = () => (cache.v && !cache.v.none ? cache.v : null);

const perthDay = (iso) => { const d = new Date(iso || ""); return isNaN(d) ? "" : d.toLocaleDateString("en-CA", { timeZone: "Australia/Perth" }); };

// Totals over [from, to], cut at the last day Google has given. null when there's nothing in those dates.
export function gbpTotals(from, to) {
  const G = peekGbp();
  if (!G || !G.days.length) return null;
  const first = G.days[0].date, last = G.days[G.days.length - 1].date;
  const end = to > last ? last : to;
  if (end < from) return null;
  const s = sumDays(G.days, from, end);
  const reviews = G.reviews.filter((r) => { const d = perthDay(r.createdAt); return d >= from && d <= to; }).length;
  return { ...s, actions: s.calls + s.website + s.directions + s.bookings + s.messages, from, to: end, first, last, reviews };
}

// Just the profile (services, categories…), for Tasks. Doesn't read the reviews.
export function loadGbpProfile() {
  if (cache.v) return Promise.resolve(cache.v.none ? null : cache.v.profile);
  return (profP ||= getDoc(doc(db, "seo_state", "gbp_profile"))
    .then((s) => (s.exists() ? s.data().summary || null : null))
    .catch(() => { profP = null; return null; }));
}

function syncTab(admin) {
  const b = document.querySelector('.seo-tabs [data-tab="gbp"]');
  if (b) b.innerHTML = gbpTabHtml(admin);
}

/* ---------- screen state (kept while the portal is open) ---------- */

const ui = { view: "reviews", rf: null, metric: "views", month: "", kq: "" };
const RX = new Map();   // review id → { open, text, ask, flags, note, busy, err }
const P = { open: false, topic: "", url: "", button: "LEARN_MORE", text: "", flags: [], photo: "", busy: "", err: "" };

/* ---------- the tab ---------- */

export function renderGbp(body, c) {
  injectCss();
  fxCss();
  const wrap = document.createElement("div");
  wrap.className = "seo-gb";
  body.replaceChildren(wrap);
  wrap.innerHTML = `<div class="seo-empty">Loading…</div>`;
  loadGbp(false).then((G) => { if (wrap.isConnected) mount(wrap, c, G); })
    .catch((e) => { if (wrap.isConnected) wrap.innerHTML = `<div class="seo-empty seo-err">${esc(errText(e))}</div>`; });
}

function mount(wrap, c, G0) {
  let G = G0;
  const h = c.h;
  const admin = c.isAdmin === true;
  const me = c.staff?.name || c.staff?.displayName || "";
  let rShow = 30, kShow = 50, refreshing = false;

  /* --- web addresses for posts --- */
  const origin = () => {
    const u = (c.data?.pages || []).find((p) => /^https?:\/\//i.test(p.url || ""))?.url || "";
    const m = /^https?:\/\/[^/]+/i.exec(u);
    return m ? m[0].replace(/^http:/i, "https:") : "https://dermedica.com.au";
  };
  const fullUrl = (s) => {
    s = String(s || "").trim();
    if (!s) return "";
    if (/^https:\/\//i.test(s)) return s;
    if (/^http:\/\//i.test(s)) return s.replace(/^http:/i, "https:");
    return origin() + (s.startsWith("/") ? s : "/" + s);
  };
  const pathOpts = () => {
    const pri = Array.isArray(c.work?.settings?.keyPages) ? c.work.settings.keyPages : [];
    const top = (c.data?.pages || []).slice().sort((a, b) => (b.m28?.clicks || 0) - (a.m28?.clicks || 0)).slice(0, 40).map((p) => p.path);
    return [...new Set(pri.concat(top))].filter((p) => p && !p.includes("?"));
  };

  /* --- not connected --- */
  function notConnected() {
    const err = G.run && G.run.ok === false ? G.run.error : "";
    return `<div class="seo-empty">${err ? `The last update failed: ${esc(err)}<br><br>` : ""}
      Google Business isn't connected yet. In Apps Script, run <code>gbpSetup</code>, then <code>testGbp</code>, then <code>runSeoGbp</code> once.</div>`;
  }

  /* --- headline numbers --- */
  const lastDay = () => (G.days.length ? G.days[G.days.length - 1].date : G.to);
  function headHtml() {
    const end = lastDay();
    if (!end) return "";
    const from = h.addDays(end, -27), pTo = h.addDays(from, -1), pFrom = h.addDays(pTo, -27);
    const cur = sumDays(G.days, from, end), prev = sumDays(G.days, pFrom, pTo);
    const has = prev.n >= 20;
    const kpi = (l, v, p, note) => `<div class="seo-kpi"><div class="l">${l}</div><div class="v">${h.fmtInt(v)}</div>${has ? h.delta(v, p) : ""}
      <div class="p">${[has ? `vs ${h.fmtInt(p)}` : "", note].filter(Boolean).join(" · ")}</div></div>`;
    const R = G.rstate || {};
    return `<p class="seo-note" style="margin:0 0 6px">${esc(h.fmtDate(from, false))} – ${esc(h.fmtDate(end))} vs the 28 days before.
        Google Business numbers settle a few days after each day.</p>
      <div class="seo-kpis">
        ${kpi("Views on Google", cur.views, prev.views, `${h.fmtInt(cur.search)} search · ${h.fmtInt(cur.maps)} maps`)}
        ${kpi("Calls", cur.calls, prev.calls, "from the profile")}
        ${kpi("Website clicks", cur.website, prev.website, "")}
        ${kpi("Directions", cur.directions, prev.directions, "")}
        ${cur.bookings || prev.bookings ? kpi("Bookings", cur.bookings, prev.bookings, "") : ""}
        <div class="seo-kpi"><div class="l">Google rating</div><div class="v">${R.avg != null ? Number(R.avg).toFixed(1) + " ★" : "—"}</div>
          <div class="p">${plural(R.total || 0, "review")} · ${h.fmtInt(R.new28 || 0)} new in 28 days${R.newPrev28 != null ? ` (was ${h.fmtInt(R.newPrev28)})` : ""}</div></div>
      </div>`;
  }

  function trendHtml() {
    if (G.days.length < 14) return "";
    const end = lastDay(), first = G.days[0].date;
    let from = h.addDays(end, -181);
    if (from < first) from = first;
    const bks = c.kit.buckets(from, end, "week");
    const pts = bks.map((b) => ({ ...b, label: c.kit.bucketLabel(b, "week"), v: sumDays(G.days, b.start, b.end)[ui.metric] }));
    return `<div class="seo-card">
      <div class="seo-row"><h3 style="margin:0">Week by week</h3><span class="seo-note">last 6 months</span><span class="seo-sp"></span>
        ${Object.entries(METRIC).map(([k, l]) => `<button class="seo-btn ${ui.metric === k ? "on" : ""}" type="button" data-gb-metric="${k}">${l}</button>`).join("")}</div>
      <div class="seo-chart">${c.kit.lineChart(pts, { fmt: h.fmtInt, gran: "week", labels: true, name: METRIC[ui.metric] })}</div>
    </div>`;
  }

  /* --- reviews --- */
  function reviewCard(rv) {
    const X = RX.get(rv.id) || {};
    const low = rv.stars && rv.stars <= 3;
    const b = X.busy ? " disabled" : "";
    const reply = rv.replied ? `<div class="seo-gb-reply"><div class="seo-gb-lab">Your reply${rv.repliedBy ? ` · ${esc(rv.repliedBy)}` : ""}${
      rv.replyAt ? ` · ${esc(dDate(rv.replyAt))}` : ""}</div><div>${esc(rv.reply)}</div></div>` : "";
    let acts = "";
    if (admin && X.open) acts = editorHtml(rv, X);
    else if (admin && !rv.replied) {
      acts = `<div class="seo-gb-acts">
        ${rv.draft ? `<button class="seo-gb-b is-go" type="button" data-gb-saved="${rv.id}"${b}>Open the saved draft</button>` : ""}
        <button class="seo-gb-b ${rv.draft ? "" : "is-go"}" type="button" data-gb-draft="${rv.id}"${b}>${X.busy === "draft" ? spin + "Writing… (about 10 seconds)" : rv.draft ? "✨ Write a new one" : "✨ Draft a reply"}</button>
        <button class="seo-btn" type="button" data-gb-own="${rv.id}"${b}>Write my own</button>
        ${rv.draft && rv.draftBy ? `<span class="seo-note">Draft by ${esc(rv.draftBy)}${rv.draftAt ? " · " + esc(dDate(rv.draftAt)) : ""}</span>` : ""}
      </div>${X.err ? `<div class="seo-gb-err">⚠ ${esc(X.err)}</div>` : ""}`;
    } else if (admin && rv.replied) {
      acts = `<div class="seo-gb-acts"><button class="seo-btn" type="button" data-gb-edit="${rv.id}"${b}>Change the reply</button>
        <button class="seo-btn" type="button" data-gb-del="${rv.id}"${b}>${X.busy === "del" ? spin + "Deleting…" : "Delete the reply"}</button></div>
        ${X.err ? `<div class="seo-gb-err">⚠ ${esc(X.err)}</div>` : ""}`;
    }
    const hist = Array.isArray(rv.history) && rv.history.length ? `<details class="seo-gb-hist"><summary>History</summary><ul>${rv.history.slice().reverse().map((x) =>
      `<li><b>${esc(x.what || "")}</b> · ${esc(x.by || "")} · ${esc(dDate(x.at))}${x.text ? `<br><span class="seo-note">${esc(x.text)}</span>` : ""}</li>`).join("")}</ul></details>` : "";
    return `<div class="seo-gb-rv${low ? " is-low" : ""}${rv.replied ? "" : " is-todo"}">
      <div class="seo-gb-rh">${stars(rv.stars)} <b>${esc(rv.author || "A Google user")}</b>
        <span class="seo-note">· ${esc(dDate(rv.createdAt))}</span>
        ${rv.replied ? "" : `<span class="seo-gb-pill is-amber">Needs a reply</span>`}</div>
      <p class="seo-gb-rc">${rv.comment ? esc(rv.comment) : `<i class="seo-note">Stars only, no written review.</i>`}</p>
      ${low && !rv.replied && admin ? `<p class="seo-gb-tip">Reply calmly: say sorry they're unhappy and invite them to call the clinic.
        Don't mention their treatment, and don't argue the details in public.</p>` : ""}
      ${reply}${acts}${hist}
    </div>`;
  }

  function editorHtml(rv, X) {
    const b = X.busy ? " disabled" : "";
    const n = (X.text || "").length;
    return `<div class="seo-gb-ed">
      <div class="seo-gb-lab">${rv.replied ? "Change the reply" : "Your reply"}
        <span class="seo-gb-cnt${n > REPLY_BEST ? " is-warn" : ""}" data-gb-cnt="${rv.id}">${n} characters</span></div>
      <textarea class="seo-input seo-gb-ta" rows="5" maxlength="4000" data-gb-text="${rv.id}"
        placeholder="Thank them, and sign off from The Dermedica team.">${esc(X.text || "")}</textarea>
      ${X.flags?.length ? `<div class="seo-gb-flags"><b>Check before sending</b><ul>${X.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      ${X.note ? `<p class="seo-gb-tip">💡 ${esc(X.note)}</p>` : ""}
      <div class="seo-gb-ask">
        <input class="seo-input" data-gb-ask="${rv.id}" maxlength="300" value="${esc(X.ask || "")}" placeholder="Ask Claude for a change (optional), e.g. shorter or warmer">
        <button class="seo-btn" type="button" data-gb-draft="${rv.id}"${b}>${X.busy === "draft" ? spin + "Writing…" : "✨ Write again"}</button></div>
      ${X.err ? `<div class="seo-gb-err">⚠ ${esc(X.err)}</div>` : ""}
      <div class="seo-gb-acts">
        <button class="seo-gb-b is-go" type="button" data-gb-send="${rv.id}"${b}>${X.busy === "send" ? spin + "Sending…" : rv.replied ? "✓ Save the change on Google" : "✓ Send the reply"}</button>
        <button class="seo-btn" type="button" data-gb-cancel="${rv.id}"${b}>Cancel</button>
        <span class="seo-note">Public on Google straight away. Checked for privacy and advertising rules when you send.</span></div>
    </div>`;
  }

  function reviewsHtml() {
    const all = G.reviews;
    const todo = all.filter((r) => !r.replied), low = all.filter((r) => r.stars && r.stars <= 3);
    if (ui.rf == null) ui.rf = todo.length ? "todo" : "all";
    const list = ui.rf === "todo" ? todo : ui.rf === "low" ? low : all;
    const chip = (k, l, n) => `<button class="seo-w-chip ${ui.rf === k ? "is-on" : ""}" type="button" data-gb-rf="${k}">${l} <em>${n}</em></button>`;
    return `
      ${G.reviewsErr ? `<div class="seo-warn">Reviews couldn't be read: ${esc(G.reviewsErr)}</div>` : ""}
      ${admin ? "" : `<p class="seo-note">Only Admins can reply to reviews.</p>`}
      <div class="seo-row">${chip("todo", "Needs a reply", todo.length)}${chip("low", "1–3 stars", low.length)}${chip("all", "All", all.length)}</div>
      ${list.length ? list.slice(0, rShow).map(reviewCard).join("")
        : `<div class="seo-empty">${ui.rf === "todo" ? "Every review has a reply. 👍" : "No reviews here."}</div>`}
      ${list.length > rShow ? `<div style="text-align:center"><button class="seo-btn" type="button" data-gb-rmore>Show ${h.fmtInt(list.length - rShow)} more</button></div>` : ""}
      <p class="seo-note" style="margin-top:8px">New reviews are checked every 3 hours from 7am to 9pm, and Admins get an email when one comes in without a reply.</p>`;
  }

  /* --- posts --- */
  function composerHtml() {
    if (!admin) return "";
    if (!P.open) {
      return `<div class="seo-row"><button class="seo-gb-b is-go" type="button" data-gb-pnew>✍️ Write a post</button>
        <span class="seo-note">Posts show on your Google profile. One or two a month keeps it active.</span></div>`;
    }
    const b = P.busy ? " disabled" : "";
    const n = P.text.length;
    return `<div class="seo-card seo-gb-comp">
      <h3 style="margin:0 0 8px">Write a post</h3>
      <div class="seo-gb-grid">
        <label class="seo-gb-f is-wide">What's it about?
          <input class="seo-input" data-gb-ptopic maxlength="300" value="${esc(P.topic)}" placeholder="e.g. treating melasma in winter"></label>
        <label class="seo-gb-f">Page the button opens
          <input class="seo-input" data-gb-purl list="seo-gb-paths" value="${esc(P.url)}" placeholder="/melasma-treatment-perth/"></label>
        <label class="seo-gb-f">Button
          <select class="seo-input" data-gb-pbtn>${Object.entries(BTN).map(([k, l]) => `<option value="${k}"${P.button === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <datalist id="seo-gb-paths">${pathOpts().map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
      <div class="seo-gb-acts" style="margin:8px 0"><button class="seo-btn" type="button" data-gb-pdraft${b}>${P.busy === "draft" ? spin + "Writing… (about 15 seconds)" : P.text ? "✨ Write it again" : "✨ Draft it with Claude"}</button>
        <span class="seo-note">Or write it yourself below.</span></div>
      <div class="seo-gb-lab">The post <span class="seo-gb-cnt${n > POST_BEST ? " is-warn" : ""}" data-gb-pcnt>${n} of ${POST_MAX} characters</span></div>
      <textarea class="seo-input seo-gb-ta" rows="8" maxlength="${POST_MAX}" data-gb-ptext placeholder="60 to 200 words, plain text. No hashtags or emojis.">${esc(P.text)}</textarea>
      ${P.flags.length ? `<div class="seo-gb-flags"><b>Check before publishing</b><ul>${P.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      <details class="seo-gb-more"${P.photo ? " open" : ""}><summary>Add a photo (optional)</summary>
        <label class="seo-gb-f">Photo address
          <input class="seo-input" data-gb-pphoto value="${esc(P.photo)}" placeholder="https://dermedica.com.au/wp-content/uploads/…jpg"></label>
        <p class="seo-note">Copy the image's address from the WordPress Media Library. It must start with https://.</p></details>
      ${P.err ? `<div class="seo-gb-err">⚠ ${esc(P.err)}</div>` : ""}
      <div class="seo-gb-acts">
        <button class="seo-gb-b is-go" type="button" data-gb-ppub${b}>${P.busy === "pub" ? spin + "Publishing…" : "✓ Publish on Google"}</button>
        <button class="seo-btn" type="button" data-gb-pcancel${b}>Cancel</button>
        <span class="seo-note">Checked for the advertising rules when you publish.</span></div>
    </div>`;
  }

  function postsHtml() {
    const end = lastDay() || "";
    const recent = G.posts.filter((p) => String(p.at || "").slice(0, 10) >= h.addDays(end || new Date().toISOString().slice(0, 10), -90)).length;
    return `${composerHtml()}
      <p class="seo-note">${plural(recent, "post")} in the last 90 days.</p>
      ${G.posts.length ? G.posts.map((p) => {
        const [sl, tone] = PSTATE[p.state] || [p.state ? p.state.toLowerCase() : "", "grey"];
        return `<div class="seo-gb-post">
          <div class="seo-gb-rh"><span class="seo-note">${esc(dDate(p.at))}</span>${sl ? `<span class="seo-gb-pill is-${tone}">${esc(sl)}</span>` : ""}
            ${p.button ? `<span class="seo-note">· Button: ${esc(BTN[p.button] || p.button)}</span>` : ""}</div>
          <div class="seo-gb-ptxt">${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy">` : ""}<p>${esc(p.text)}</p></div>
          <div class="seo-gb-acts">
            ${p.link ? `<a class="seo-btn" href="${esc(p.link)}" target="_blank" rel="noopener">View on Google ↗</a>` : ""}
            ${p.url ? `<a class="seo-w-link" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\/[^/]+/i, "") || "/")}</a>` : ""}
            <span class="seo-sp"></span>
            ${admin ? `<button class="seo-btn" type="button" data-gb-pdel="${esc(p.name)}">Delete</button>` : ""}</div>
        </div>`;
      }).join("") : `<div class="seo-empty">No posts yet.</div>`}`;
  }

  /* --- searches --- */
  function kTable() {
    const months = G.kw || [];
    if (!months.length) return `<p class="seo-note">No searches yet. They're read each morning.</p>`;
    const i = Math.max(0, months.findIndex((m) => m[0] === ui.month));
    const rows = Array.isArray(months[i][1]) ? months[i][1] : [];
    const before = months[i + 1];
    const prev = new Map((before && Array.isArray(before[1]) ? before[1] : []).map((r) => [String(r[0]).toLowerCase(), r]));
    const f = ui.kq.trim().toLowerCase();
    const list = rows.filter((r) => !f || String(r[0]).toLowerCase().includes(f));
    const views = (r) => (r[2] ? `<span title="Google only says it's fewer than ${r[1]}">under ${h.fmtInt(r[1])}</span>` : h.fmtInt(r[1]));
    const vs = (r) => {
      if (!before) return "—";
      const p = prev.get(String(r[0]).toLowerCase());
      if (!p) return `<span class="seo-note">new</span>`;
      if (r[2] || p[2]) return `<span class="seo-note">${p[2] ? "under " : ""}${h.fmtInt(p[1])}</span>`;
      return h.delta(r[1], p[1]);
    };
    if (!list.length) return `<div class="seo-empty">No searches match.</div>`;
    return `<div class="seo-table-wrap" style="max-height:none"><table class="seo-table">
      <thead><tr><th>Search</th><th>Views</th><th>vs ${before ? esc(monthName(before[0])) : "the month before"}</th></tr></thead>
      <tbody>${list.slice(0, kShow).map((r) => `<tr><td>${esc(r[0])}</td><td>${views(r)}</td><td>${vs(r)}</td></tr>`).join("")}</tbody></table></div>
      ${list.length > kShow ? `<div style="padding:10px;text-align:center"><button class="seo-btn" type="button" data-gb-kmore>Show all ${h.fmtInt(list.length)}</button></div>` : ""}`;
  }
  function searchesHtml() {
    const months = G.kw || [];
    if (months.length && !months.some((m) => m[0] === ui.month)) ui.month = months[0][0];
    return `<div class="seo-row">
        ${months.length ? `<label class="seo-note">Month <select class="seo-input seo-select" data-gb-month>${months.map((m) =>
          `<option value="${esc(m[0])}"${m[0] === ui.month ? " selected" : ""}>${esc(monthName(m[0]))}</option>`).join("")}</select></label>` : ""}
        <span class="seo-sp"></span>
        <input class="seo-input" type="search" data-gb-kq placeholder="Filter searches, e.g. melasma" value="${esc(ui.kq)}"></div>
      <div data-gb-ktable>${kTable()}</div>
      <p class="seo-note" style="margin-top:8px">Searches on Google Search and Maps that showed your profile. Google only gives a range for small numbers ("under 15").</p>`;
  }

  /* --- profile --- */
  function profileHtml() {
    const p = G.profile;
    if (!p) return `<div class="seo-empty">The profile hasn't been read yet. It's read each morning.</div>`;
    const row = (l, v) => `<tr><td>${l}</td><td>${v || `<span class="seo-note">Not set</span>`}</td></tr>`;
    const dl = (p.description || "").length;
    return `<div class="seo-card">
        <div class="seo-row" style="margin:0 0 6px"><h3 style="margin:0">${esc(p.title || "Your profile")}</h3><span class="seo-sp"></span>
          ${p.mapsUrl ? `<a class="seo-btn" href="${esc(p.mapsUrl)}" target="_blank" rel="noopener">Open on Google Maps ↗</a>` : ""}</div>
        ${p.status && p.status !== "OPEN" ? `<div class="seo-warn">Google shows the clinic as ${esc(p.status.toLowerCase().replace(/_/g, " "))}.</div>` : ""}
        <table class="seo-kv seo-gb-kv">
          ${row("Main category", esc(p.primary))}
          ${row("Other categories", esc((p.additional || []).join(", ")))}
          ${row("Phone", esc(p.phone))}
          ${row("Website", p.website ? `<a class="seo-w-link" href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website)}</a>` : "")}
          ${row("Address", esc(p.address))}
          ${row("Opening hours", esc(p.hours) + (p.specialHours ? ` <span class="seo-note">· ${plural(p.specialHours, "special day")}</span>` : ""))}
          ${row("Description", p.description ? `${esc(p.description)}<div class="seo-note">${dl} of 750 characters</div>` : "")}
          ${row(`Services <span class="seo-note">(${(p.services || []).length})</span>`, (p.services || []).map((s) => `<span class="seo-gb-tag">${esc(s)}</span>`).join(""))}
        </table>
        <p class="seo-note">To change these, edit the profile on Google. Changes show here the morning after.</p>
      </div>
      ${p.reviewUrl ? `<div class="seo-card"><h3>Ask patients for a review</h3>
        <div class="seo-row" style="margin:0"><code class="seo-gb-code">${esc(p.reviewUrl)}</code>
          <button class="seo-btn" type="button" data-gb-copy="${esc(p.reviewUrl)}">Copy the link</button></div>
        <p class="seo-note" style="margin-top:6px">Send it after a visit by email or text. Don't offer anything in return, and don't copy reviews onto the website or into ads (AHPRA).</p></div>` : ""}
      <div class="seo-card"><h3>Changes to the profile</h3>
        ${G.changes.length ? `<ul class="seo-gb-chg">${G.changes.map((x) => `<li><span class="seo-note">${esc(h.fmtDate(x.date))}</span> <b>${esc(x.field)}</b>
          <div>${x.from ? `<del>${esc(x.from)}</del> → ` : ""}${esc(x.to)}</div></li>`).join("")}</ul>`
          : `<p class="seo-note">No changes seen yet. Changes made on Google, by you or by Google, show here and in the Change log.</p>`}</div>`;
  }

  /* --- the page --- */
  function draw() {
    if (G.none) { wrap.innerHTML = notConnected(); return; }
    const run = G.run || {};
    const todo = G.reviews.filter((r) => !r.replied).length;
    const tab = (v, l, n) => `<button type="button" class="seo-gb-tab${ui.view === v ? " is-on" : ""}" data-gb-view="${v}" aria-selected="${ui.view === v}">${l}${
      n ? ` <span class="seo-gb-n">${n}</span>` : ""}</button>`;
    wrap.innerHTML = `
      ${run.ok === false ? `<div class="seo-warn">The last Google Business update failed, so this may be out of date: ${esc(run.error || "")}</div>` : ""}
      <div class="seo-row">
        <span class="seo-note">${G.profile?.title ? `<b>${esc(G.profile.title)}</b> · ` : ""}${G.rstate?.at ? `Reviews checked ${esc(tsWhen(G.rstate.at))}` : ""}</span>
        <span class="seo-sp"></span>
        ${admin ? `<button class="seo-btn" type="button" data-gb-refresh${refreshing ? " disabled" : ""}>${refreshing ? spin + "Checking…" : "↻ Check for new reviews"}</button>` : ""}
      </div>
      ${Array.isArray(run.warnings) && run.warnings.length ? `<details class="seo-gb-warns"><summary>${plural(run.warnings.length, "part")} didn't update last time</summary>
        <ul>${run.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}
      ${headHtml()}
      ${trendHtml()}
      <div class="seo-gb-tabs" role="tablist" aria-label="Google Business">
        ${tab("reviews", "Reviews", admin ? todo : 0)}${tab("posts", "Posts")}${tab("searches", "Searches")}${tab("profile", "Profile")}
      </div>
      ${ui.view === "posts" ? postsHtml() : ui.view === "searches" ? searchesHtml() : ui.view === "profile" ? profileHtml() : reviewsHtml()}`;
  }

  /* --- actions: reviews --- */
  const rvOf = (id) => G.reviews.find((x) => x.id === id);
  const xOf = (id) => { let X = RX.get(id); if (!X) { X = {}; RX.set(id, X); } return X; };

  async function draftReply(rv) {
    const X = xOf(rv.id);
    X.busy = "draft"; X.err = ""; draw();
    try {
      const r = await api("draftReply", { id: rv.id, ask: X.open ? X.ask || "" : "", current: X.open ? X.text || "" : "" });
      Object.assign(X, { open: true, text: r.draft || "", flags: r.flags || [], note: r.note || "", ask: "" });
      Object.assign(rv, { draft: r.draft || "", draftFlags: r.flags || [], draftNote: r.note || "", draftAt: new Date().toISOString(), draftBy: me });
    } catch (err) { X.err = errText(err); }
    finally { X.busy = ""; draw(); }
  }

  async function sendReply(rv) {
    const X = xOf(rv.id);
    const text = String(X.text || "").replace(/\r/g, "").trim();
    if (text.length < 2) { X.err = "Write the reply first."; draw(); return; }
    const yes = await askConfirm({ title: rv.replied ? "Change the reply on Google?" : "Send this reply to Google?",
      ok: rv.replied ? "✓ Yes, change it" : "✓ Yes, send it",
      body: `<div class="seo-gb-quote">${esc(text)}</div><ul class="seo-fx-mlist"><li>It's public on Google straight away.</li>
        <li>You can change or delete it later from here.</li></ul>` });
    if (!yes) return;
    X.busy = "send"; X.err = ""; draw();
    try {
      let r = await api("reply", { id: rv.id, text });
      if (r.needsConfirm) {
        X.flags = r.flags || [];
        X.busy = ""; draw();
        const go = await askConfirm({ title: "Send it anyway?", ok: "Send anyway", tone: "reject",
          body: `<p>The privacy and advertising check found:</p><ul class="seo-fx-mlist">${X.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
            <p class="seo-note">Press Cancel to change the wording first.</p>` });
        if (!go) return;
        X.busy = "send"; draw();
        r = await api("reply", { id: rv.id, text, confirm: true });
      }
      Object.assign(rv, { reply: text, replied: true, replyAt: r.at || new Date().toISOString(), repliedBy: me, draft: "", draftNote: "", draftFlags: [] });
      RX.delete(rv.id);
      toast(rv.replied ? "Reply saved on Google ✓" : "Reply sent ✓");
      syncTab(admin);
    } catch (err) { X.err = errText(err); }
    finally { const Y = RX.get(rv.id); if (Y) Y.busy = ""; draw(); }
  }

  async function deleteReply(rv) {
    const yes = await askConfirm({ title: "Delete the reply on Google?", ok: "Yes, delete it", tone: "reject",
      body: `<div class="seo-gb-quote">${esc(rv.reply || "")}</div><ul class="seo-fx-mlist"><li>The review stays. Only your reply is removed.</li></ul>` });
    if (!yes) return;
    const X = xOf(rv.id);
    X.busy = "del"; X.err = ""; draw();
    try {
      await api("deleteReply", { id: rv.id });
      Object.assign(rv, { reply: "", replied: false, replyAt: "", repliedBy: "" });
      RX.delete(rv.id);
      toast("Reply deleted");
      syncTab(admin);
    } catch (err) { X.err = errText(err); }
    finally { const Y = RX.get(rv.id); if (Y) Y.busy = ""; draw(); }
  }

  /* --- actions: posts --- */
  async function draftPost() {
    if (P.topic.trim().length < 3) { P.err = "Say what the post is about first."; draw(); return; }
    P.busy = "draft"; P.err = ""; draw();
    try {
      const r = await api("draftPost", { topic: P.topic, url: fullUrl(P.url) });
      P.text = r.text || ""; P.flags = r.flags || [];
      if (r.button && BTN[r.button] !== undefined) P.button = r.button;
    } catch (err) { P.err = errText(err); }
    finally { P.busy = ""; draw(); }
  }

  async function publishPost() {
    const text = P.text.replace(/\r/g, "").trim();
    const url = fullUrl(P.url), photo = P.photo.trim();
    if (text.length < 10) { P.err = "Write the post first."; draw(); return; }
    if ((P.button === "BOOK" || P.button === "LEARN_MORE") && !url) { P.err = "Add the page the button opens, or choose No button."; draw(); return; }
    if (photo && !/^https:\/\//i.test(photo)) { P.err = "The photo address must start with https://"; draw(); return; }
    const yes = await askConfirm({ title: "Publish this post on Google?", ok: "✓ Yes, publish it",
      body: `<div class="seo-gb-quote">${esc(text)}</div>
        <ul class="seo-fx-mlist"><li>Button: ${esc(BTN[P.button] || "No button")}${url && P.button !== "CALL" && P.button ? ` → ${esc(url)}` : ""}</li>
        <li>Google checks posts before showing them, usually within a few minutes.</li><li>It's added to the Change log.</li></ul>` });
    if (!yes) return;
    P.busy = "pub"; P.err = ""; draw();
    const body = { text, button: P.button, url: P.button === "CALL" ? "" : url, photo };
    try {
      let r = await api("post", body);
      if (r.needsConfirm) {
        P.flags = r.flags || [];
        P.busy = ""; draw();
        const go = await askConfirm({ title: "Publish it anyway?", ok: "Publish anyway", tone: "reject",
          body: `<p>The advertising check found:</p><ul class="seo-fx-mlist">${P.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
            <p class="seo-note">Press Cancel to change the wording first.</p>` });
        if (!go) return;
        P.busy = "pub"; draw();
        r = await api("post", { ...body, confirm: true });
      }
      Object.assign(P, { open: false, topic: "", url: "", button: "LEARN_MORE", text: "", flags: [], photo: "", err: "" });
      toast("Published ✓ Google checks it before it shows.");
      G = await loadGbp(true).catch(() => G);
    } catch (err) { P.err = errText(err); }
    finally { P.busy = ""; draw(); }
  }

  async function deletePost(name) {
    const p = G.posts.find((x) => x.name === name);
    if (!p) return;
    const yes = await askConfirm({ title: "Delete this post from Google?", ok: "Yes, delete it", tone: "reject",
      body: `<div class="seo-gb-quote">${esc(p.text)}</div>` });
    if (!yes) return;
    try {
      await api("deletePost", { name });
      G.posts = G.posts.filter((x) => x.name !== name);
      toast("Post deleted");
      draw();
    } catch (err) { toast(errText(err), true); }
  }

  async function copy(txt) {
    try { await navigator.clipboard.writeText(txt); toast("Link copied"); }
    catch { prompt("Copy the link:", txt); }
  }

  /* --- events --- */
  wrap.onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t || !wrap.contains(t)) return;
    const d = t.dataset;
    if (d.gbView) { ui.view = d.gbView; draw(); return; }
    if (d.gbRf) { ui.rf = d.gbRf; rShow = 30; draw(); return; }
    if (d.gbMetric) { ui.metric = d.gbMetric; draw(); return; }
    if (d.gbRmore !== undefined) { rShow = Infinity; draw(); return; }
    if (d.gbKmore !== undefined) { kShow = Infinity; const box = wrap.querySelector("[data-gb-ktable]"); if (box) box.innerHTML = kTable(); return; }
    if (d.gbCopy) { copy(d.gbCopy); return; }
    if (d.gbRefresh !== undefined) {
      refreshing = true; draw();
      try {
        const r = await api("refresh");
        if (r.recent) toast("Checked in the last 5 minutes. Showing the latest.");
        G = await loadGbp(true);
        if (!r.recent) toast("Up to date ✓");
        syncTab(admin);
      } catch (err) { toast(errText(err), true); }
      finally { refreshing = false; draw(); }
      return;
    }
    const id = d.gbDraft || d.gbOwn || d.gbSaved || d.gbSend || d.gbEdit || d.gbDel || d.gbCancel;
    if (id) {
      const rv = rvOf(id);
      if (!rv) return;
      if (d.gbDraft) { draftReply(rv); return; }
      if (d.gbOwn) { Object.assign(xOf(id), { open: true, text: "", flags: [], note: "", err: "" }); draw(); wrap.querySelector(`[data-gb-text="${id}"]`)?.focus(); return; }
      if (d.gbSaved) { Object.assign(xOf(id), { open: true, text: rv.draft || "", flags: rv.draftFlags || [], note: rv.draftNote || "", err: "" }); draw(); return; }
      if (d.gbEdit) { Object.assign(xOf(id), { open: true, text: rv.reply || "", flags: [], note: "", err: "" }); draw(); return; }
      if (d.gbCancel) { RX.delete(id); draw(); return; }
      if (d.gbSend) { sendReply(rv); return; }
      if (d.gbDel) { deleteReply(rv); return; }
    }
    if (d.gbPnew !== undefined) { P.open = true; P.err = ""; draw(); wrap.querySelector("[data-gb-ptopic]")?.focus(); return; }
    if (d.gbPcancel !== undefined) {
      if (P.text && !confirm("Close the post without publishing it?")) return;
      Object.assign(P, { open: false, err: "" }); draw(); return;
    }
    if (d.gbPdraft !== undefined) { draftPost(); return; }
    if (d.gbPpub !== undefined) { publishPost(); return; }
    if (d.gbPdel) { deletePost(d.gbPdel); }
  };

  wrap.oninput = (e) => {
    const t = e.target;
    if (t.matches("[data-gb-text]")) {
      const id = t.dataset.gbText, X = RX.get(id);
      if (X) X.text = t.value;
      const cnt = wrap.querySelector(`[data-gb-cnt="${id}"]`);
      if (cnt) { cnt.textContent = `${t.value.length} characters`; cnt.classList.toggle("is-warn", t.value.length > REPLY_BEST); }
    } else if (t.matches("[data-gb-ask]")) { const X = RX.get(t.dataset.gbAsk); if (X) X.ask = t.value; }
    else if (t.matches("[data-gb-ptopic]")) P.topic = t.value;
    else if (t.matches("[data-gb-purl]")) P.url = t.value;
    else if (t.matches("[data-gb-pphoto]")) P.photo = t.value;
    else if (t.matches("[data-gb-ptext]")) {
      P.text = t.value;
      const cnt = wrap.querySelector("[data-gb-pcnt]");
      if (cnt) { cnt.textContent = `${t.value.length} of ${POST_MAX} characters`; cnt.classList.toggle("is-warn", t.value.length > POST_BEST); }
    } else if (t.matches("[data-gb-kq]")) {
      ui.kq = t.value; kShow = 50;
      const box = wrap.querySelector("[data-gb-ktable]");
      if (box) box.innerHTML = kTable();
    }
  };

  wrap.onchange = (e) => {
    const t = e.target;
    if (t.matches("[data-gb-month]")) { ui.month = t.value; kShow = 50; const box = wrap.querySelector("[data-gb-ktable]"); if (box) box.innerHTML = kTable(); }
    else if (t.matches("[data-gb-pbtn]")) P.button = t.value;
  };

  draw();
  syncTab(admin);
}

/* ---------- styles ---------- */

const CSS = `
.seo-gb-tabs{display:flex;gap:2px;margin:4px 0 14px;border-bottom:1px solid #e5e7eb;overflow-x:auto;scrollbar-width:none}
.seo-gb-tabs::-webkit-scrollbar{display:none}
.seo-gb-tab{flex:none;display:inline-flex;align-items:center;gap:6px;height:44px;margin-bottom:-1px;padding:0 14px;border:0;border-bottom:2px solid transparent;
  background:none;font:inherit;font-size:14px;font-weight:600;color:#64748b;white-space:nowrap;cursor:pointer}
.seo-gb-tab:hover{color:#0f172a}
.seo-gb-tab.is-on{color:#0f766e;border-bottom-color:#0f766e}
.seo-gb-n{min-width:20px;padding:0 6px;border-radius:999px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;line-height:20px;text-align:center}
.seo-gb-rv,.seo-gb-post{padding:12px 14px;margin-bottom:8px;background:#fff;border:1px solid #e5e7eb;border-left:3px solid #cbd5e1;border-radius:10px;font-size:13.5px}
.seo-gb-rv.is-todo{border-left-color:#d97706}
.seo-gb-rv.is-todo.is-low{border-left-color:#dc2626}
.seo-gb-rh{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.seo-gb-stars{color:#f59e0b;letter-spacing:1px;font-size:14px}
.seo-gb-stars i{font-style:normal;color:#cbd5e1}
.seo-gb-rc{margin:6px 0 0;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.seo-gb-reply{margin-top:10px;padding:8px 12px;border-radius:8px;background:#f0fdfa;border:1px solid #ccfbf1;line-height:1.5;white-space:pre-wrap}
.seo-gb-lab{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;font-weight:600;color:#64748b}
.seo-gb-cnt{font-weight:400}.seo-gb-cnt.is-warn{color:#b45309;font-weight:600}
.seo-gb-ed{margin-top:10px;padding-top:10px;border-top:1px solid #f1f5f9}
.seo-gb-ta{display:block;width:100%;min-width:0;box-sizing:border-box;resize:vertical;line-height:1.5}
.seo-gb-ask{display:flex;gap:6px;margin-top:8px}
.seo-gb-ask .seo-input{flex:1;min-width:0}
.seo-gb-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}
.seo-gb-acts a.seo-btn{text-decoration:none}
.seo-gb-b{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:6px 14px;border:1px solid #0f766e;border-radius:8px;background:#fff;color:#0f766e;
  font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.seo-gb-b.is-go{background:#0f766e;color:#fff}
.seo-gb-b:disabled,.seo-gb-b[disabled]{opacity:.55;cursor:not-allowed}
.seo-gb-tip{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.45}
.seo-gb-flags{margin-top:8px;padding:8px 12px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d;font-size:13px}
.seo-gb-flags ul{margin:4px 0 0;padding-left:18px}
.seo-gb-err{margin-top:8px;color:#b91c1c;font-size:13px}
.seo-gb-pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#f1f5f9;color:#475569}
.seo-gb-pill.is-amber{background:#fef3c7;color:#92400e}.seo-gb-pill.is-green{background:#dcfce7;color:#166534}.seo-gb-pill.is-red{background:#fee2e2;color:#b91c1c}
.seo-gb-hist{margin-top:8px;font-size:12.5px}
.seo-gb-hist summary{cursor:pointer;color:#64748b}
.seo-gb-hist ul{margin:6px 0 0;padding-left:18px;line-height:1.5}
.seo-gb-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.seo-gb-f{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:#64748b}
.seo-gb-f .seo-input{width:100%;min-width:0;box-sizing:border-box;font-weight:400}
.seo-gb-f.is-wide{grid-column:1/-1}
.seo-gb-more{margin-top:8px;font-size:13px}
.seo-gb-more summary{cursor:pointer;color:#64748b;margin-bottom:6px}
.seo-gb-ptxt{display:flex;gap:12px;align-items:flex-start;margin-top:6px}
.seo-gb-ptxt img{width:96px;height:72px;object-fit:cover;border-radius:6px;flex:none}
.seo-gb-ptxt p{margin:0;line-height:1.5;white-space:pre-wrap}
.seo-gb-quote{margin:0 0 10px;padding:10px 12px;border-radius:8px;background:#f8fafc;border:1px solid #e5e7eb;white-space:pre-wrap;line-height:1.5;font-size:13.5px}
.seo-gb-kv td:last-child{text-align:left;white-space:normal}
.seo-gb-tag{display:inline-block;margin:0 4px 4px 0;padding:1px 8px;border-radius:999px;background:#f0fdfa;color:#115e59;font-size:12px}
.seo-gb-code{padding:4px 8px;border-radius:6px;background:#f1f5f9;font-size:12px;word-break:break-all}
.seo-gb-chg{list-style:none;margin:0;padding:0;font-size:13px}
.seo-gb-chg li{padding:7px 0;border-top:1px solid #e5e7eb}
.seo-gb-chg li:first-child{border-top:0}
.seo-gb-chg del{color:#94a3b8}
.seo-gb-warns{margin:0 0 10px;font-size:12.5px;color:#92400e}
.seo-gb-warns summary{cursor:pointer}
.seo-gb-spin{width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;animation:seoGbSpin .8s linear infinite}
@keyframes seoGbSpin{to{transform:rotate(360deg)}}
@media (max-width:640px){
  .seo-gb-grid{grid-template-columns:1fr}
  .seo-gb-ask{flex-direction:column}
  .seo-gb-acts .seo-gb-b,.seo-gb-acts .seo-btn{flex:1 1 auto;min-height:40px;justify-content:center}
}
`;

function injectCss() {
  if (document.getElementById("seo-gbp-css")) return;
  const s = document.createElement("style");
  s.id = "seo-gbp-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}