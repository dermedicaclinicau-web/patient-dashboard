// seo-social.js — SEO › Social: plan, write, approve and schedule posts for Facebook, Instagram and Google.
// Firestore: social_posts/{id} (and /comments), social_ideas/{id}, social_settings/main (settings), social_settings/connect (Apps Script).
// Pictures: the Image Bank, or uploads in Storage (social_media/<postId>/).
// Posting: by hand until a channel is connected. After that, Apps Script (SeoSocial.gs) posts approved posts at their time.
import { db, auth, storage } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, query, where, orderBy, onSnapshot,
  serverTimestamp, arrayUnion, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref as sref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { callApi } from "./appointments.js";
import { complianceWords } from "./seo-work.js";
import { bankList, bankSearch, thumbFor } from "./image-bank-api.js";

const CH = { fb: { label: "Facebook", icon: "f" }, ig: { label: "Instagram", icon: "◎" }, gbp: { label: "Google", icon: "G" } };
const CH_ORDER = ["fb", "ig", "gbp"];
const LIMIT = { fb: 5000, ig: 2200, gbp: 1500 };
const STATUS = {
  draft: { label: "Draft", tone: "grey", icon: "✎" },
  waiting: { label: "Waiting for approval", tone: "amber", icon: "◐" },
  scheduled: { label: "Scheduled", tone: "blue", icon: "●" },
  publishing: { label: "Posting…", tone: "blue", icon: "●" },
  posted: { label: "Posted", tone: "green", icon: "✓" },
  failed: { label: "Didn't post", tone: "red", icon: "✕" },
  rejected: { label: "Rejected", tone: "red", icon: "✕" },
  deleted: { label: "Deleted", tone: "grey", icon: "✕" },
};
const BTN = { LEARN_MORE: "Learn more", BOOK: "Book", CALL: "Call now", "": "No button" };
const MAX_PICS = 10;
const DEFAULT_TIME = "10:00";
const RISKY = [
  [/\bbefore\b[\s\S]{0,80}\bafter\b/i, "Before-and-after: check AHPRA's rules, and that you have the patient's written consent."],
  [/\b(testimonials?|our (patients|clients) (say|love)|5[- ]star)\b/i, "Patient testimonials and reviews can't be used in advertising (AHPRA)."],
  [/(\bfree\b|% off|\bdiscount|\bspecial offer|\bdeal\b|\blimited time\b|\bthis week only\b|\bhurry\b)/i, "An offer or discount: make the terms clear, with no pressure to book."],
  [/\b(guarantee[ds]?|permanent|pain[- ]?free|painless|no downtime|risk[- ]?free|100% safe)\b/i, "Promises a result or plays down risk (AHPRA)."],
  [/(\bbest\b|\bnumber one\b|#1\b|\bleading\b)/i, "“Best” or “leading” claims need proof (AHPRA)."],
];

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const uid = () => auth.currentUser?.uid || "";
const pad = (n) => String(n).padStart(2, "0");
const perthNow = () => { const d = new Date(Date.now() + 8 * 3600e3).toISOString(); return { day: d.slice(0, 10), time: d.slice(11, 16) }; };
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monday = (iso) => addDays(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
const whenMs = (w) => Date.parse(`${w}:00+08:00`);
const niceDay = (iso, o) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { ...o, timeZone: "UTC" });
const niceTime = (hm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hm || "");
  if (!m) return "";
  const h = +m[1], mm = +m[2];
  return `${((h + 11) % 12) + 1}${mm ? ":" + pad(mm) : ""} ${h < 12 ? "am" : "pm"}`;
};
const tsDate = (t) => (t?.toDate ? t.toDate() : t ? new Date(t) : null);
const when = (t) => {
  const d = tsDate(t);
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Australia/Perth" }) : "";
};
const timeOf = (p) => String(p.when || "").slice(11, 16);
const byWhen = (a, b) => String(a.when || "").localeCompare(String(b.when || ""));
const chIcon = (k) => `<i class="sc-chi is-${k}" title="${esc(CH[k]?.label || k)}">${esc(CH[k]?.icon || "?")}</i>`;
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const errText = (e) => (/permission/i.test(e?.message || e?.code || "")
  ? "You don't have permission to do that, or Social's new database rules aren't published yet." : e?.message || String(e));
function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "sc-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2600);
}
async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); return true; } catch { /* below */ }
  const ta = document.createElement("textarea");
  ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
// Comments seen on this device
const seenKey = () => "dm.social.seen." + uid();
const seenMap = () => { try { return JSON.parse(localStorage.getItem(seenKey()) || "{}") || {}; } catch { return {}; } };
const markSeen = (id) => { try { const m = seenMap(); m[id] = Date.now(); localStorage.setItem(seenKey(), JSON.stringify(m)); } catch { /* private mode */ } };

// A smaller copy of a photo (longest side 2048 px)
async function shrinkImg(file, max = 2048) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    const png = file.type === "image/png" && file.size < 1500000;
    const type = png ? "image/png" : "image/jpeg";
    const blob = await new Promise((r) => cv.toBlob(r, type, 0.88));
    return { blob, type, ext: png ? "png" : "jpg", w: cv.width, h: cv.height };
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- screen state (kept while the portal is open) ---------- */

const UI = { view: "month", month: "", week: "", ch: "", mine: false, ideas: false, lstatus: "" };

/* ===================== The tab ===================== */

export function renderSocial(body, c) {
  injectCss();
  const wrap = document.createElement("div");
  wrap.className = "sc";
  body.replaceChildren(wrap);
  const canApprove = !!c.can("social.approve");
  const canPlan = canApprove || !!c.can("social.plan");
  if (!canPlan) {
    wrap.innerHTML = `<div class="seo-empty">You don't have access to Social. Ask an Admin to tick a Social permission for you in Staff.</div>`;
    return;
  }
  const me = { uid: uid(), name: String(c.staff?.name || c.staff?.displayName || auth.currentUser?.displayName || "") };
  const today = () => perthNow().day;
  if (!UI.month) UI.month = today().slice(0, 7);
  if (!UI.week) UI.week = monday(today());
  const S = { posts: new Map(), waiting: [], ideas: [], settings: {}, connect: {}, banned: [], staff: [] };
  const usualTime = () => (/^\d{2}:\d{2}$/.test(S.settings.time || "") ? S.settings.time : DEFAULT_TIME);
  const defaultDay = () => { const n = perthNow(); return n.time < usualTime() ? n.day : addDays(n.day, 1); };
  const handLeft = (p) => (p.channels || []).filter((k) => !(p.published || {})[k] && !S.connect[k]);
  const canDrag = (p) => !["posted", "publishing", "deleted"].includes(p.status)
    && (canApprove || ["draft", "waiting", "rejected"].includes(p.status));
  const shown = (p) => p.status !== "deleted" && (!UI.ch || (p.channels || []).includes(UI.ch)) && (!UI.mine || p.createdBy === me.uid);

  /* ----- data ----- */

  function range() {
    const t = today();
    if (UI.view === "list") return { from: addDays(t, -30), to: addDays(t, 120) };
    if (UI.view === "week") return { from: UI.week, to: addDays(UI.week, 6) };
    const [y, m] = UI.month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from: monday(UI.month + "-01"), to: addDays(monday(last), 6) };
  }
  async function loadSettings() {
    const [st, cn, seo] = await Promise.all([
      getDoc(doc(db, "social_settings", "main")).catch(() => null),
      getDoc(doc(db, "social_settings", "connect")).catch(() => null),
      c.work && c.work.settings ? null : getDoc(doc(db, "seo_settings", "main")).catch(() => null),
    ]);
    S.settings = st && st.exists() ? st.data() : {};
    S.connect = cn && cn.exists() ? cn.data() : {};
    S.banned = complianceWords(c.work && c.work.settings ? c.work : { settings: seo && seo.exists() ? seo.data() : {} });
  }
  async function loadPosts() {
    const r = range();
    const [snap, wait] = await Promise.all([
      getDocs(query(collection(db, "social_posts"), where("day", ">=", r.from), where("day", "<=", r.to))),
      canApprove ? getDocs(query(collection(db, "social_posts"), where("status", "==", "waiting"))) : null,
    ]);
    S.posts = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    S.waiting = wait ? wait.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
  }
  async function loadIdeas() {
    const snap = await getDocs(query(collection(db, "social_ideas"), where("used", "==", false)));
    S.ideas = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => !i.archived)
      .sort((a, b) => (tsDate(b.at) || 0) - (tsDate(a.at) || 0));
  }
  const reload = () => loadPosts().then(() => { if (wrap.isConnected) draw(); })
    .catch((e) => { if (wrap.isConnected) wrap.innerHTML = `<div class="seo-empty seo-err">${esc(errText(e))}</div>`; });

  /* ----- the calendar ----- */

  const postsOn = (day) => [...S.posts.values()].filter((p) => p.day === day && shown(p)).sort(byWhen);

  function cardHtml(p) {
    const st = STATUS[p.status] || STATUS.draft;
    const lc = tsDate(p.lastCommentAt)?.getTime() || 0;
    const fresh = p.commentCount && lc > (seenMap()[p.id] || 0) && p.lastCommentBy !== me.uid;
    const forMe = fresh && p.lastCommentTo && p.lastCommentTo === me.name;
    const hand = p.status === "scheduled" && whenMs(p.when) <= Date.now() && handLeft(p).length;
    const cap = String(p.caption || Object.values(p.captions || {})[0] || p.topic || "Untitled").replace(/\s+/g, " ");
    const pic = (p.pictures || [])[0];
    return `<div class="sc-card is-${hand ? "hand" : st.tone}" role="button" tabindex="0" data-sc-open="${esc(p.id)}"${
      canDrag(p) ? ` draggable="true" data-sc-drag="${esc(p.id)}"` : ""}>
      <span class="sc-ctop">${(p.channels || []).map(chIcon).join("")}<b>${esc(niceTime(timeOf(p)))}</b></span>
      ${pic ? `<img class="sc-cimg" src="${esc(pic.url)}" alt="" loading="lazy" draggable="false">` : ""}
      <span class="sc-ccap">${esc(cap.slice(0, 80))}</span>
      <span class="sc-cst">${hand ? "☝ Post by hand" : `${st.icon} ${esc(st.label)}`}${p.commentCount ? ` <i class="sc-cm${fresh ? " is-new" : ""}">💬 ${p.commentCount}${forMe ? " · for you" : ""}</i>` : ""}</span>
    </div>`;
  }

  function calHtml() {
    const r = range(), t = today();
    let cells = "";
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) {
      const out = UI.view === "month" && d.slice(0, 7) !== UI.month;
      cells += `<div class="sc-day${out ? " is-out" : ""}${d === t ? " is-today" : ""}${d < t ? " is-past" : ""}" data-sc-day="${d}">
        <div class="sc-dnum"><span>${UI.view === "week" ? esc(niceDay(d, { weekday: "short", day: "numeric" })) : Number(d.slice(8))}</span>${
          d >= t ? `<button type="button" class="sc-add" data-sc-new="${d}" aria-label="New post on ${esc(niceDay(d, { weekday: "long", day: "numeric", month: "long" }))}">+</button>` : ""}</div>
        ${postsOn(d).map(cardHtml).join("")}</div>`;
    }
    const head = UI.view === "week" ? "" : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => `<div class="sc-dow">${x}</div>`).join("");
    return `<div class="sc-cal${UI.view === "week" ? " is-week" : ""}">${head}${cells}</div>`;
  }

  function listHtml() {
    const src = UI.lstatus === "waiting" ? S.waiting : [...S.posts.values()];
    const rows = src.filter(shown).filter((p) => !UI.lstatus || p.status === UI.lstatus).sort(byWhen);
    const chips = [["", "All"], ["draft", "Drafts"], ["waiting", "Waiting"], ["scheduled", "Scheduled"], ["posted", "Posted"], ["rejected", "Rejected"]]
      .map(([k, l]) => `<button type="button" class="sc-chip${UI.lstatus === k ? " is-on" : ""}" data-sc-ls="${k}">${l}</button>`).join("");
    return `<div class="sc-row">${chips}</div>${rows.length ? `<div class="seo-table-wrap" style="max-height:none"><table class="seo-table sc-list">
      <thead><tr><th>When</th><th>Channels</th><th>Post</th><th>Status</th><th>By</th><th>Comments</th></tr></thead>
      <tbody>${rows.map((p) => {
        const st = STATUS[p.status] || STATUS.draft;
        return `<tr data-sc-open="${esc(p.id)}"><td>${esc(niceDay(p.day, { weekday: "short", day: "numeric", month: "short" }))} ${esc(niceTime(timeOf(p)))}</td>
          <td>${(p.channels || []).map(chIcon).join("")}</td>
          <td class="sc-lcap">${esc(String(p.caption || p.topic || "Untitled").replace(/\s+/g, " ").slice(0, 90))}</td>
          <td><span class="sc-pill is-${st.tone}">${st.icon} ${esc(st.label)}</span></td>
          <td>${esc(p.createdByName || "")}</td><td>${p.commentCount ? `💬 ${p.commentCount}` : ""}</td></tr>`;
      }).join("")}</tbody></table></div>` : `<div class="seo-empty">Nothing here.</div>`}`;
  }

  function ideasHtml() {
    return `<aside class="sc-ideas">
      <div class="sc-ihead"><strong>Ideas</strong><span class="seo-note">Drag one onto a day, or press Make a post.</span></div>
      <form class="sc-iform" data-sc-iform>
        <input class="seo-input" name="title" maxlength="150" placeholder="An idea, e.g. Christmas hours" required>
        <textarea class="seo-input" name="note" rows="2" maxlength="2000" placeholder="Notes (optional)"></textarea>
        <input class="seo-input" name="link" maxlength="300" placeholder="Link (optional)">
        <button class="sc-b is-go" type="submit">Add idea</button>
      </form>
      ${S.ideas.length ? S.ideas.map((i) => `<div class="sc-idea" draggable="true" data-sc-idea="${esc(i.id)}">
          <strong>${esc(i.title)}</strong>${i.note ? `<p>${esc(i.note)}</p>` : ""}${i.link ? `<small class="sc-ilink">${esc(i.link)}</small>` : ""}
          <small class="seo-note">${esc(i.byName || "")}${i.at ? " · " + esc(when(i.at)) : ""}</small>
          <div class="sc-iacts"><button class="sc-b" type="button" data-sc-iuse="${esc(i.id)}">Make a post</button>
            <button class="seo-btn" type="button" data-sc-iarch="${esc(i.id)}">Archive</button></div></div>`).join("")
        : `<p class="seo-note">No ideas yet.</p>`}
    </aside>`;
  }

  function title() {
    if (UI.view === "list") return "Last 30 days and the next 4 months";
    if (UI.view === "week") return `${niceDay(UI.week, { day: "numeric", month: "short" })} – ${niceDay(addDays(UI.week, 6), { day: "numeric", month: "short", year: "numeric" })}`;
    return niceDay(UI.month + "-01", { month: "long", year: "numeric" });
  }

  function draw() {
    const nWait = S.waiting.length;
    const manual = CH_ORDER.filter((k) => !S.connect[k]);
    wrap.innerHTML = `
      <div class="sc-head">
        ${UI.view !== "list" ? `<div class="sc-nav"><button class="seo-btn" type="button" data-sc-move="-1" aria-label="Earlier">◀</button>
          <strong>${esc(title())}</strong><button class="seo-btn" type="button" data-sc-move="1" aria-label="Later">▶</button>
          <button class="seo-btn" type="button" data-sc-today>Today</button></div>` : `<strong class="sc-ltitle">${esc(title())}</strong>`}
        <span class="sc-sp"></span>
        <select class="seo-input seo-select" data-sc-ch aria-label="Channel"><option value="">All channels</option>${
          CH_ORDER.map((k) => `<option value="${k}"${UI.ch === k ? " selected" : ""}>${CH[k].label}</option>`).join("")}</select>
        <label class="seo-check"><input type="checkbox" data-sc-mine${UI.mine ? " checked" : ""}> Mine only</label>
        <span class="seo-seg">${[["month", "Month"], ["week", "Week"], ["list", "List"]].map(([k, l]) =>
          `<button type="button" class="${UI.view === k ? "on" : ""}" data-sc-view="${k}">${l}</button>`).join("")}</span>
        <button class="seo-btn${UI.ideas ? " on" : ""}" type="button" data-sc-ideas>Ideas <span class="sc-n">${S.ideas.length}</span></button>
        ${canApprove ? `<button class="seo-btn" type="button" data-sc-settings title="Social settings" aria-label="Social settings">⚙</button>` : ""}
        <button class="sc-b is-go" type="button" data-sc-new="">+ New post</button>
      </div>
      ${canApprove && nWait ? `<button type="button" class="sc-wait" data-sc-waiting>◐ ${nWait} post${nWait === 1 ? "" : "s"} waiting for your approval ›</button>` : ""}
      ${manual.length ? `<p class="seo-note sc-handnote">${manual.map((k) => CH[k].label).join(", ")} ${manual.length === 1 ? "isn't" : "aren't"} connected yet,
        so approved posts are posted by hand: at the time, the card says <b>Post by hand</b>.</p>` : ""}
      <div class="sc-body${UI.ideas ? " has-ideas" : ""}">
        <div class="sc-main">${UI.view === "list" ? listHtml() : calHtml()}</div>
        ${UI.ideas ? ideasHtml() : ""}
      </div>
      <div class="sc-legend">${CH_ORDER.map((k) => `<span>${chIcon(k)} ${CH[k].label}</span>`).join("")}<span class="sc-sp"></span>${
        ["draft", "waiting", "scheduled", "posted"].map((s) => `<span class="sc-lg is-${STATUS[s].tone}">${STATUS[s].icon} ${STATUS[s].label}</span>`).join("")}</div>`;
  }

  async function movePost(id, day) {
    const p = S.posts.get(id);
    if (!p || p.day === day || !canDrag(p)) return;
    if (day < today()) { toast("Choose today or a later day.", true); return; }
    const w = `${day}T${timeOf(p) || usualTime()}`;
    try {
      await updateDoc(doc(db, "social_posts", id), { day, when: w, updatedBy: me.uid, updatedByName: me.name, updatedAt: serverTimestamp(),
        history: arrayUnion({ at: new Date().toISOString(), by: me.name, what: `Moved to ${niceDay(day, { weekday: "short", day: "numeric", month: "short" })}`, note: "" }) });
      Object.assign(p, { day, when: w });
      draw();
      toast("Moved");
    } catch (err) { toast(errText(err), true); }
  }

  /* ----- events ----- */

  wrap.addEventListener("click", async (e) => {
    const t = e.target.closest("button,[data-sc-open]");
    if (!t || !wrap.contains(t)) return;
    const d = t.dataset;
    if (d.scMove) {
      const n = Number(d.scMove);
      if (UI.view === "week") UI.week = addDays(UI.week, 7 * n);
      else { const [y, m] = UI.month.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1 + n, 1)); UI.month = x.toISOString().slice(0, 7); }
      reload();
      return;
    }
    if (d.scToday !== undefined) { UI.month = today().slice(0, 7); UI.week = monday(today()); reload(); return; }
    if (d.scView) { UI.view = d.scView; reload(); return; }
    if (d.scIdeas !== undefined) { UI.ideas = !UI.ideas; draw(); return; }
    if (d.scWaiting !== undefined) { UI.view = "list"; UI.lstatus = "waiting"; reload(); return; }
    if (d.scLs !== undefined) { UI.lstatus = d.scLs; draw(); return; }
    if (d.scSettings !== undefined) { openSettings(); return; }
    if (d.scNew !== undefined) { openEditor({ day: d.scNew || defaultDay() }); return; }
    if (d.scIuse) { const idea = S.ideas.find((i) => i.id === d.scIuse); if (idea) openEditor({ day: defaultDay(), idea }); return; }
    if (d.scIarch) {
      try {
        await updateDoc(doc(db, "social_ideas", d.scIarch), { archived: true });
        S.ideas = S.ideas.filter((i) => i.id !== d.scIarch);
        draw();
      } catch (err) { toast(errText(err), true); }
      return;
    }
    if (d.scOpen) openEditor({ id: d.scOpen });
  });
  wrap.addEventListener("keydown", (e) => {
    const card = e.target.closest?.("[data-sc-open]");
    if (card && e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openEditor({ id: card.dataset.scOpen }); }
  });
  wrap.addEventListener("change", (e) => {
    if (e.target.matches("[data-sc-ch]")) { UI.ch = e.target.value; draw(); }
    else if (e.target.matches("[data-sc-mine]")) { UI.mine = e.target.checked; draw(); }
  });
  wrap.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-sc-iform]");
    if (!f) return;
    e.preventDefault();
    const fd = new FormData(f);
    const titleTxt = String(fd.get("title") || "").trim().slice(0, 150);
    if (!titleTxt) return;
    const d = { title: titleTxt, note: String(fd.get("note") || "").trim().slice(0, 2000), link: String(fd.get("link") || "").trim().slice(0, 300),
      picture: "", by: me.uid, byName: me.name, at: serverTimestamp(), used: false, postId: "", archived: false };
    try {
      const ref = await addDoc(collection(db, "social_ideas"), d);
      S.ideas.unshift({ ...d, id: ref.id, at: new Date() });
      draw();
      toast("Idea added");
    } catch (err) { toast(errText(err), true); }
  });
  // Drag a post or an idea onto a day
  wrap.addEventListener("dragstart", (e) => {
    const el = e.target.closest && e.target.closest("[data-sc-drag],[data-sc-idea]");
    if (!el) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", el.dataset.scDrag ? "post:" + el.dataset.scDrag : "idea:" + el.dataset.scIdea);
    el.classList.add("is-dragging");
  });
  const clearDrop = () => wrap.querySelectorAll(".is-drop,.is-dragging").forEach((x) => x.classList.remove("is-drop", "is-dragging"));
  wrap.addEventListener("dragend", clearDrop);
  wrap.addEventListener("dragover", (e) => {
    const day = e.target.closest?.("[data-sc-day]");
    if (!day) return;
    e.preventDefault();
    wrap.querySelectorAll(".is-drop").forEach((x) => { if (x !== day) x.classList.remove("is-drop"); });
    day.classList.add("is-drop");
  });
  wrap.addEventListener("drop", (e) => {
    const day = e.target.closest?.("[data-sc-day]");
    if (!day) return;
    e.preventDefault();
    clearDrop();
    const v = e.dataTransfer.getData("text/plain");
    const cut = v.indexOf(":");
    const kind = v.slice(0, cut), id = v.slice(cut + 1);
    if (kind === "post") movePost(id, day.dataset.scDay);
    else if (kind === "idea") {
      const idea = S.ideas.find((i) => i.id === id);
      if (!idea) return;
      if (day.dataset.scDay < today()) { toast("Choose today or a later day.", true); return; }
      openEditor({ day: day.dataset.scDay, idea });
    }
  });

  /* ===================== Social settings (approvers) ===================== */

  function openSettings() {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog";
    const sets = (S.settings.hashtagSets || []).map((s) => `${s.name}: ${(s.tags || []).map((x) => "#" + x).join(" ")}`).join("\n");
    dlg.innerHTML = `<form class="lh-form sc-set">
      <div class="lh-dialog-head"><h3>Social settings</h3></div>
      <label class="sc-lab">Usual posting time (Perth) <input class="seo-input" type="time" name="time" value="${esc(usualTime())}" step="300"></label>
      <label class="sc-lab">Saved hashtag sets <small>One per line, like: Skin: #perthskin #skinclinic</small>
        <textarea class="seo-input" name="sets" rows="6">${esc(sets)}</textarea></label>
      <div class="sc-conn">${CH_ORDER.map((k) => `<div>${chIcon(k)} ${CH[k].label}: ${S.connect[k] ? '<b class="sc-good">connected</b>' : "not connected yet (posted by hand)"}</div>`).join("")}</div>
      <p class="seo-note">The advertising word list is in SEO › Settings › Brand and wording.</p>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-x>Cancel</button><button type="submit" class="lh-btn is-primary">Save</button></div>
    </form>`;
    dlg.querySelector("[data-x]").addEventListener("click", () => dlg.close());
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const time = String(fd.get("time") || DEFAULT_TIME);
      const hashtagSets = String(fd.get("sets") || "").split(/\n+/).map((l) => {
        const i = l.indexOf(":");
        if (i < 1) return null;
        const tags = [...new Set(l.slice(i + 1).split(/[\s,]+/).map((x) => x.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean))].slice(0, 30);
        return tags.length ? { name: l.slice(0, i).trim().slice(0, 40), tags } : null;
      }).filter(Boolean).slice(0, 20);
      try {
        await setDoc(doc(db, "social_settings", "main"), { time: /^\d{2}:\d{2}$/.test(time) ? time : DEFAULT_TIME, hashtagSets,
          updatedBy: me.uid, updatedByName: me.name, updatedAt: serverTimestamp() }, { merge: true });
        S.settings = { ...S.settings, time, hashtagSets };
        dlg.close();
        toast("Saved");
      } catch (err) {
        const el = dlg.querySelector(".lh-error");
        el.textContent = errText(err);
        el.hidden = false;
      }
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  /* ===================== The post editor ===================== */

  async function openEditor(opts) {
    let p = opts.id ? S.posts.get(opts.id) || S.waiting.find((x) => x.id === opts.id) || null : null;
    if (opts.id && !p) {
      try {
        const s = await getDoc(doc(db, "social_posts", opts.id));
        if (!s.exists()) { toast("That post isn't there any more.", true); return; }
        p = { id: s.id, ...s.data() };
      } catch (err) { toast(errText(err), true); return; }
    }
    const idea = opts.idea || null;
    const E = {
      id: p ? p.id : doc(collection(db, "social_posts")).id, isNew: !p, status: p ? p.status : "draft",
      channels: p ? [...(p.channels || [])] : ["fb", "ig"],
      caption: p ? p.caption || "" : idea ? idea.note || "" : "",
      captions: { ...(p?.captions || {}) },
      hashtags: [...(p?.hashtags || [])],
      link: p ? p.link || "" : idea ? idea.link || "" : "",
      gbpButton: p && p.gbpButton !== undefined ? p.gbpButton : "LEARN_MORE",
      pictures: (p?.pictures || []).map((x) => ({ ...x })),
      day: p ? p.day : opts.day || defaultDay(), time: p ? timeOf(p) || usualTime() : usualTime(),
      topic: p ? p.topic || "" : idea ? idea.title : "",
      ideaId: p ? p.ideaId || "" : idea ? idea.id : "",
      prev: "", busy: "", err: "", comments: [], cTo: "", cDraft: "",
    };
    E.prev = E.channels[0] || "fb";
    const sigOf = () => JSON.stringify([E.channels, E.caption, E.captions, E.hashtags, E.link, E.gbpButton,
      E.pictures.map((x) => [x.url, x.alt || ""]), E.day, E.time, E.topic]);
    let base = sigOf();
    const dirty = () => sigOf() !== base;
    const readOnly = () => ["posted", "publishing", "deleted"].includes(E.status);
    const capFor = (k) => (k in E.captions ? String(E.captions[k] || "") : E.caption);
    const tagText = (k) => (k === "gbp" || !E.hashtags.length ? "" : "\n\n" + E.hashtags.map((x) => "#" + x).join(" "));
    let unsub = null;

    const ov = document.createElement("div");
    ov.className = "sc-ed";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "Social post");
    document.body.appendChild(ov);
    document.body.classList.add("sc-ed-open");
    if (!E.isNew) markSeen(E.id);

    /* --- checks --- */
    function checks() {
      const out = [];
      const add = (tone, msg) => out.push({ tone, msg });
      if (!E.channels.length) add("stop", "Choose at least one channel.");
      if (!E.channels.some((k) => capFor(k).trim())) add("stop", "Write the caption.");
      if (E.channels.includes("ig")) {
        if (!E.pictures.length) add("stop", "Instagram needs at least 1 picture.");
        const n = capFor("ig").length + tagText("ig").length;
        if (n > LIMIT.ig) add("stop", `The Instagram caption is ${n.toLocaleString("en-AU")} characters. 2,200 at most.`);
        if (E.hashtags.length > 30) add("stop", "Instagram allows 30 hashtags at most.");
        if (/https?:\/\/|www\./i.test(capFor("ig"))) add("warn", "Links in Instagram captions can't be tapped. Say “link in bio” instead.");
      }
      if (E.channels.includes("gbp")) {
        if (capFor("gbp").length > LIMIT.gbp) add("stop", `The Google post is ${capFor("gbp").length.toLocaleString("en-AU")} characters. 1,500 at most.`);
        if (["BOOK", "LEARN_MORE"].includes(E.gbpButton) && !E.link.trim()) add("stop", "Add the link the Google button opens, or choose No button.");
        if (E.hashtags.length) add("ok", "Hashtags are left off the Google post.");
      }
      if (E.channels.includes("fb") && capFor("fb").length + tagText("fb").length > LIMIT.fb) add("stop", "The Facebook caption is too long.");
      if (E.pictures.length) {
        if (E.pictures.some((x) => !String(x.alt || "").trim())) add("warn", "Add a description (alt text) to every picture.");
        else add("ok", "Every picture has a description.");
      }
      const text = [...new Set(E.channels.map(capFor))].join("\n") + " " + E.hashtags.join(" ") + " " + E.pictures.map((x) => x.alt || "").join(" ");
      const hits = S.banned.filter((w) => w && new RegExp(`(^|[^a-z0-9])${escRe(w)}([^a-z0-9]|$)`, "i").test(text));
      if (hits.length) add("bad", `Advertising rules: “${hits.slice(0, 4).join("”, “")}” can't be used.`);
      else add("ok", "No words from your advertising list.");
      RISKY.forEach(([re, msg]) => { if (re.test(text)) add("bad", msg); });
      if (E.day && E.time && !readOnly() && whenMs(`${E.day}T${E.time}`) < Date.now()) add("warn", "This time has passed. Change it, or it's due as soon as it's approved.");
      const rank = { stop: 0, bad: 1, warn: 2, ok: 3 };
      return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
    }
    function ready(label) {
      const list = checks();
      const stop = list.filter((x) => x.tone === "stop");
      if (stop.length) { E.err = stop.map((x) => x.msg).join(" "); drawEd(); return false; }
      const worry = list.filter((x) => x.tone === "bad");
      return !worry.length || confirm(`${label}?\n\nStill to look at:\n• ${worry.map((x) => x.msg).join("\n• ")}`);
    }

    /* --- the preview --- */
    function previewHtml(k) {
      const cap = capFor(k);
      const text = cap + tagText(k);
      const pics = E.pictures;
      const pic = pics[0];
      const img = pic ? `<img src="${esc(pic.url)}" alt="${esc(pic.alt || "")}">` : "";
      if (k === "ig") {
        const short = text.length > 125;
        return `<div class="sc-pv sc-pv-ig"><div class="sc-pv-h"><span class="sc-av">D</span><b>dermedica_perth</b></div>
          <div class="sc-pv-sq">${img || "<span>Instagram needs a picture</span>"}${pics.length > 1 ? `<span class="sc-pv-n">1/${pics.length}</span>` : ""}</div>
          <div class="sc-pv-act">♡ &nbsp;💬 &nbsp;➤</div>
          <p class="sc-pv-t"><b>dermedica_perth</b> ${esc(short ? text.slice(0, 125) : text)}${short ? ' <span class="sc-more">… more</span>' : ""}</p></div>`;
      }
      if (k === "fb") {
        const host = (/^https?:\/\/([^/]+)/i.exec(E.link) || [])[1] || (E.link.trim() ? "dermedica.com.au" : "");
        return `<div class="sc-pv sc-pv-fb"><div class="sc-pv-h"><span class="sc-av">D</span><div><b>Dermedica</b><small>${esc(niceDay(E.day, { day: "numeric", month: "long" }))} · ${esc(niceTime(E.time))}</small></div></div>
          <p class="sc-pv-t">${esc(text.length > 480 ? text.slice(0, 480) + "… See more" : text)}</p>${img ? `<div class="sc-pv-wide">${img}</div>` : ""}
          ${host ? `<div class="sc-pv-link">${esc(host.toUpperCase())}</div>` : ""}</div>`;
      }
      return `<div class="sc-pv sc-pv-g">${img ? `<div class="sc-pv-wide">${img}</div>` : ""}
        <p class="sc-pv-t">${esc(cap.length > 300 ? cap.slice(0, 300) + "…" : cap)}</p>
        ${E.gbpButton ? `<span class="sc-pv-btn">${esc(BTN[E.gbpButton] || "")}</span>` : ""}<small class="seo-note">Dermedica · on Google</small></div>`;
    }

    /* --- comments --- */
    function commentsHtml() {
      if (E.isNew) return `<p class="seo-note">Save the post first, then talk about it here.</p>`;
      const list = E.comments.map((cm) => `<div class="sc-cmt${cm.by === me.uid ? " is-me" : ""}">
        <div class="sc-cmeta"><b>${esc(cm.by === me.uid ? "You" : cm.byName || "Someone")}</b>${
          cm.toName ? ` <span class="seo-note">to ${esc(cm.toName === me.name ? "you" : cm.toName)}</span>` : ""} <span class="seo-note">· ${esc(when(cm.at))}</span></div>
        <div class="sc-ctext">${esc(cm.text)}</div></div>`).join("");
      return `<div class="sc-thread">${list || `<p class="seo-note">No comments yet. Use this to brainstorm, or tell someone what to change in the caption or design.</p>`}</div>
        <div class="sc-cbox"><textarea class="seo-input" data-e-cmt rows="2" maxlength="2000" placeholder="Write a comment…">${esc(E.cDraft)}</textarea>
          <div class="sc-row"><select class="seo-input seo-select" data-e-cto aria-label="Who it's for"><option value="">For everyone</option>${
            S.staff.filter((s) => s && s.name && s.name !== me.name).map((s) => `<option value="${esc(s.name)}"${E.cTo === s.name ? " selected" : ""}>For ${esc(s.name)}</option>`).join("")}</select>
          <span class="sc-sp"></span><button class="sc-b is-go" type="button" data-e="comment"${E.busy === "comment" ? " disabled" : ""}>${E.busy === "comment" ? "Sending…" : "Send"}</button></div></div>`;
    }
    const scrollThread = () => { const t = ov.querySelector(".sc-thread"); if (t) t.scrollTop = t.scrollHeight; };
    function startComments() {
      if (E.isNew || unsub) return;
      unsub = onSnapshot(query(collection(db, "social_posts", E.id, "comments"), orderBy("at")), (snap) => {
        E.comments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const box = ov.querySelector("[data-e-comments]");
        if (box) {
          const ta = box.querySelector("[data-e-cmt]");
          if (ta) E.cDraft = ta.value;
          box.innerHTML = commentsHtml();
          scrollThread();
        }
        markSeen(E.id);
      }, (err) => console.warn("Comments not loaded:", err));
    }
    async function addComment(text, to) {
      await addDoc(collection(db, "social_posts", E.id, "comments"), { text: text.slice(0, 2000), by: me.uid, byName: me.name, to: to || "", toName: to || "", at: serverTimestamp() });
      await updateDoc(doc(db, "social_posts", E.id), { commentCount: increment(1), lastCommentAt: serverTimestamp(), lastCommentBy: me.uid, lastCommentTo: to || "" });
      const cached = S.posts.get(E.id);
      if (cached) Object.assign(cached, { commentCount: (cached.commentCount || 0) + 1, lastCommentAt: new Date(), lastCommentBy: me.uid, lastCommentTo: to || "" });
      if (to) callApi({ action: "seoSocial", op: "notifyComment", id: E.id, to }).catch(() => { /* next part */ });
    }

    /* --- drawing --- */
    function publishedHtml() {
      const pub = (p && p.published) || {};
      const due = whenMs(`${E.day}T${E.time}`) <= Date.now();
      return `<section class="sc-sec sc-pub"><h4>Posting</h4>${(p?.channels || E.channels).map((k) => {
        const x = pub[k];
        if (x) return `<div>${chIcon(k)} <b>Posted on ${CH[k].label}</b> <span class="seo-note">${esc(x.by || "")}${x.at ? " · " + esc(when(x.at)) : ""}${x.manual ? " · by hand" : ""}</span>${
          x.link ? ` <a class="sc-link" href="${esc(x.link)}" target="_blank" rel="noopener">View ↗</a>` : ""}</div>`;
        if (S.connect[k]) return `<div>${chIcon(k)} ${CH[k].label}: ${E.status === "failed" ? `<span class="sc-bad">didn't post${p?.error ? ": " + esc(p.error) : ""}</span>` : "posts itself at the time"}</div>`;
        return `<div>${chIcon(k)} ${CH[k].label}: ${due ? "<b>post it by hand now</b>" : "post it by hand at the time"}
          <button class="seo-btn" type="button" data-e-copy="${k}">Copy caption</button>
          ${E.status === "scheduled" ? `<button class="seo-btn" type="button" data-e-mark="${k}">Mark posted</button>` : ""}</div>`;
      }).join("")}</section>`;
    }

    function actsHtml() {
      if (readOnly()) return "";
      const b = E.busy ? " disabled" : "";
      const st = E.status;
      const out = [];
      if (E.isNew || st === "draft" || st === "rejected") {
        if (!E.isNew && (canApprove || p?.createdBy === me.uid)) out.push(`<button class="seo-btn" type="button" data-e="delete"${b}>Delete</button>`);
        out.push(`<button class="seo-btn" type="button" data-e="save"${b}>Save draft</button>`);
        out.push(`<button class="sc-b${canApprove ? "" : " is-go"}" type="button" data-e="send"${b}>Send for approval</button>`);
        if (canApprove) out.push(`<button class="sc-b is-go" type="button" data-e="approve"${b}>✓ Approve and schedule</button>`);
      } else if (st === "waiting") {
        out.push(`<button class="seo-btn" type="button" data-e="save"${b}>Save changes</button>`);
        if (canApprove) {
          out.push(`<button class="seo-btn" type="button" data-e="changes"${b}>Request changes</button>`);
          out.push(`<button class="seo-btn" type="button" data-e="reject"${b}>Reject</button>`);
          out.push(`<button class="sc-b is-go" type="button" data-e="approve"${b}>✓ Approve and schedule</button>`);
        } else out.push(`<button class="seo-btn" type="button" data-e="unsend"${b}>Back to draft</button>`);
      } else if (st === "scheduled") {
        if (canApprove) {
          out.push(`<button class="seo-btn" type="button" data-e="unschedule"${b}>Take off the schedule</button>`);
          out.push(`<button class="sc-b is-go" type="button" data-e="approve"${b}>Save changes</button>`);
        } else out.push(`<button class="sc-b is-go" type="button" data-e="send"${b}>Save and send for approval again</button>`);
      } else if (st === "failed" && canApprove) {
        out.push(`<button class="sc-b is-go" type="button" data-e="retry"${b}>Try again now</button>`);
      }
      return out.join("");
    }

    function formHtml() {
      const ro = readOnly() ? " disabled" : "";
      const sets = S.settings.hashtagSets || [];
      return `
        ${E.err ? `<div class="sc-err" role="alert">⚠ ${esc(E.err)}</div>` : ""}
        ${p && p.reviewNote && ["draft", "rejected"].includes(E.status) ? `<div class="sc-review"><b>${E.status === "rejected" ? "Rejected" : "Changes requested"}:</b> ${esc(p.reviewNote)}</div>` : ""}
        ${["scheduled", "posted", "failed", "publishing"].includes(E.status) ? publishedHtml() : ""}
        <section class="sc-sec"><h4>Channels</h4><div class="sc-chs">${CH_ORDER.map((k) =>
          `<button type="button" class="sc-chb${E.channels.includes(k) ? " is-on" : ""}" data-e-ch="${k}" aria-pressed="${E.channels.includes(k)}"${ro}>${chIcon(k)} ${CH[k].label}</button>`).join("")}</div></section>
        <section class="sc-sec"><h4>Pictures <small>${E.pictures.length} of ${MAX_PICS}</small></h4>
          <div class="sc-pics">${E.pictures.map((x, i) => `<div class="sc-pic"><img src="${esc(x.url)}" alt="">
            <input class="seo-input" data-e-alt="${i}" value="${esc(x.alt || "")}" placeholder="Describe it (alt text)" maxlength="300"${ro}>
            ${ro ? "" : `<div class="sc-picb"><button type="button" data-e-pl="${i}" aria-label="Earlier"${i ? "" : " disabled"}>←</button>
              <button type="button" data-e-pr="${i}" aria-label="Later"${i < E.pictures.length - 1 ? "" : " disabled"}>→</button>
              <button type="button" data-e-px="${i}" aria-label="Remove">×</button></div>`}</div>`).join("")}</div>
          ${ro || E.pictures.length >= MAX_PICS ? "" : `<div class="sc-row"><button class="seo-btn" type="button" data-e="bank">+ Image Bank</button>
            <button class="seo-btn" type="button" data-e="upload"${E.busy === "upload" ? " disabled" : ""}>${E.busy === "upload" ? "Uploading…" : "+ Upload"}</button>
            <input type="file" accept="image/*" multiple hidden data-e-file></div>`}
          <p class="seo-note">Before-and-after photos and patients' faces: check you have written consent, and AHPRA's rules.</p></section>
        <section class="sc-sec"><h4>What's it about?</h4><div class="sc-row">
          <input class="seo-input sc-grow" data-e-topic value="${esc(E.topic)}" maxlength="300" placeholder="e.g. Melasma in summer"${ro}>
          ${ro ? "" : `<button class="seo-btn" type="button" data-e="draftai"${E.busy ? " disabled" : ""}>${E.busy === "draft" ? "Writing… (about 15 seconds)" : "✨ Draft it"}</button>`}</div></section>
        <section class="sc-sec"><h4>Caption <small data-e-count></small></h4>
          <textarea class="seo-input sc-ta" data-e-cap rows="7" maxlength="5000" placeholder="Write the caption…"${ro}>${esc(E.caption)}</textarea>
          ${E.channels.map((k) => (k in E.captions
            ? `<div class="sc-lab">${chIcon(k)} ${CH[k].label} only ${ro ? "" : `<button type="button" class="sc-link" data-e-unsplit="${k}">Use the main caption</button>`}
                <textarea class="seo-input sc-ta" data-e-capk="${k}" rows="4" maxlength="5000"${ro}>${esc(E.captions[k])}</textarea></div>`
            : ro ? "" : `<button type="button" class="sc-link sc-split" data-e-split="${k}">Change it for ${CH[k].label} only</button>`)).join(" ")}
        </section>
        <section class="sc-sec"><h4>Hashtags <small>${E.hashtags.length} of 30 · not used on Google</small></h4>
          <div class="sc-tags">${E.hashtags.map((x, i) => `<span class="sc-tag">#${esc(x)}${ro ? "" : `<button type="button" data-e-tx="${i}" aria-label="Remove #${esc(x)}">×</button>`}</span>`).join("")}
            ${ro ? "" : `<input data-e-tag placeholder="Add a hashtag, then Enter" maxlength="60" aria-label="Add a hashtag">`}</div>
          ${!ro && sets.length ? `<select class="seo-input seo-select" data-e-tset aria-label="Add a saved hashtag set"><option value="">Add a saved set…</option>${
            sets.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("")}</select>` : ""}</section>
        ${E.channels.includes("fb") || E.channels.includes("gbp") ? `<section class="sc-sec"><h4>Link <small>Facebook and Google</small></h4>
          <input class="seo-input sc-grow" data-e-link value="${esc(E.link)}" placeholder="/melasma-treatment-perth/ or a full address" maxlength="300"${ro}>
          ${E.channels.includes("gbp") ? `<label class="sc-lab">Google button <select class="seo-input seo-select" data-e-btn${ro}>${
            Object.entries(BTN).map(([k, l]) => `<option value="${k}"${E.gbpButton === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}</section>` : ""}
        <section class="sc-sec"><h4>When <small>Perth time</small></h4><div class="sc-row">
          <input class="seo-input" type="date" data-e-day value="${esc(E.day)}" min="${today()}"${ro}>
          <input class="seo-input" type="time" data-e-time value="${esc(E.time)}" step="300"${ro}></div></section>`;
    }

    function sideHtml() {
      return `${E.channels.length ? `<div class="seo-seg sc-pvtabs" role="tablist">${E.channels.map((k) =>
          `<button type="button" role="tab" class="${E.prev === k ? "on" : ""}" data-e-pv="${k}" aria-selected="${E.prev === k}">${chIcon(k)} ${CH[k].label}</button>`).join("")}</div>` : ""}
        <div data-e-preview></div>
        <h4 class="sc-h">Checks</h4><ul class="sc-checks" data-e-checks></ul>
        <h4 class="sc-h">Comments</h4><div data-e-comments>${commentsHtml()}</div>
        ${p && (p.history || []).length ? `<details class="sc-hist"><summary>History</summary><ul>${p.history.slice().reverse().map((h) =>
          `<li><b>${esc(h.what)}</b> · ${esc(h.by || "")} · ${esc(when(h.at))}${h.note ? `<br><span class="seo-note">${esc(h.note)}</span>` : ""}</li>`).join("")}</ul></details>` : ""}`;
    }

    function drawSide() {
      if (!E.channels.includes(E.prev)) E.prev = E.channels[0] || "";
      const pv = ov.querySelector("[data-e-preview]");
      if (pv) pv.innerHTML = E.prev ? previewHtml(E.prev) : `<p class="seo-note">Choose a channel to see a preview.</p>`;
      const ck = ov.querySelector("[data-e-checks]");
      if (ck) ck.innerHTML = checks().map((x) => `<li class="is-${x.tone}">${esc(x.msg)}</li>`).join("");
      const ct = ov.querySelector("[data-e-count]");
      if (ct) ct.textContent = E.channels.map((k) => `${CH[k].label} ${(capFor(k).length + tagText(k).length).toLocaleString("en-AU")}${
        k === "fb" ? "" : ` of ${LIMIT[k].toLocaleString("en-AU")}`}`).join(" · ");
      ov.querySelectorAll("[data-e-pv]").forEach((b) => { b.classList.toggle("on", b.dataset.ePv === E.prev); b.setAttribute("aria-selected", String(b.dataset.ePv === E.prev)); });
    }

    function drawEd() {
      if (!ov.isConnected) return;
      const ta = ov.querySelector("[data-e-cmt]");
      if (ta) E.cDraft = ta.value;
      const st = STATUS[E.status] || STATUS.draft;
      ov.innerHTML = `
        <div class="sc-ed-bar">
          <button class="seo-btn" type="button" data-e="close">← ${UI.view === "list" ? "List" : "Calendar"}</button>
          <strong>${E.isNew ? "New post" : "Post"}</strong>
          <span class="sc-pill is-${st.tone}">${st.icon} ${esc(E.isNew ? "Not saved yet" : st.label)}</span>
          ${E.busy === "save" ? `<span class="seo-note">Saving…</span>` : ""}
          <span class="sc-sp"></span>
          <span class="sc-acts">${actsHtml()}</span>
        </div>
        <div class="sc-ed-grid">
          <main class="sc-ed-main">${formHtml()}</main>
          <aside class="sc-ed-side">${sideHtml()}</aside>
        </div>`;
      drawSide();
      scrollThread();
    }

    /* --- saving --- */
    function payload(status, what, note = "", extra = {}) {
      return {
        status, channels: E.channels, caption: E.caption.trim(),
        captions: Object.fromEntries(Object.entries(E.captions).filter(([k]) => E.channels.includes(k)).map(([k, v]) => [k, String(v || "").trim()])),
        hashtags: E.hashtags, link: E.link.trim(), gbpButton: E.gbpButton,
        pictures: E.pictures.map((x) => ({ url: x.url, path: x.path || "", alt: String(x.alt || "").trim().slice(0, 300), w: x.w || 0, h: x.h || 0, from: x.from || "" })),
        when: `${E.day}T${E.time}`, day: E.day, topic: E.topic.trim().slice(0, 300), ideaId: E.ideaId || "",
        updatedBy: me.uid, updatedByName: me.name, updatedAt: serverTimestamp(),
        history: arrayUnion({ at: new Date().toISOString(), by: me.name, what, note: String(note || "").slice(0, 500) }),
        ...extra,
      };
    }
    async function write(d) {
      const ref = doc(db, "social_posts", E.id);
      if (E.isNew) {
        await setDoc(ref, { approvedBy: "", approvedByName: "", approvedAt: null, approvedSig: "", reviewNote: "", ...d,
          createdBy: me.uid, createdByName: me.name, createdAt: serverTimestamp(), published: {}, commentCount: 0 });
        if (E.ideaId) {
          updateDoc(doc(db, "social_ideas", E.ideaId), { used: true, postId: E.id })
            .then(() => { S.ideas = S.ideas.filter((i) => i.id !== E.ideaId); }).catch(() => { /* stays in the list */ });
        }
      } else await updateDoc(ref, d);
      const s = await getDoc(ref);
      p = { id: E.id, ...s.data() };
      S.posts.set(E.id, p);
      S.waiting = S.waiting.filter((x) => x.id !== E.id).concat(p.status === "waiting" ? [p] : []);
      E.isNew = false;
      E.status = p.status;
      base = sigOf();
      startComments();
    }
    async function run(fn) {
      if (E.busy) return;
      E.busy = "save"; E.err = ""; drawEd();
      try { await fn(); } catch (err) { console.error("Social post not saved:", err); E.err = errText(err); }
      finally { E.busy = ""; drawEd(); }
    }
    const approval = () => ({ approvedBy: me.uid, approvedByName: me.name, approvedAt: serverTimestamp(), approvedSig: hash(sigOf()), reviewNote: "" });
    const soonIfPast = () => {
      if (whenMs(`${E.day}T${E.time}`) > Date.now()) return true;
      if (!confirm("The time has passed. Make it due in 10 minutes?")) return false;
      const d = new Date(Date.now() + 10 * 60e3 + 8 * 3600e3);
      d.setUTCMinutes(Math.ceil(d.getUTCMinutes() / 5) * 5, 0, 0);
      const iso = d.toISOString();
      E.day = iso.slice(0, 10); E.time = iso.slice(11, 16);
      return true;
    };
    function close(force) {
      if (!force && !readOnly() && dirty() && !confirm("Close without saving your changes?")) return;
      if (unsub) unsub();
      ov.remove();
      document.body.classList.remove("sc-ed-open");
      document.removeEventListener("keydown", onKey);
      if (wrap.isConnected) reload();
    }
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector("dialog[open]")) close(); };
    document.addEventListener("keydown", onKey);

    async function doAction(a) {
      if (a === "close") { close(); return; }
      if (a === "bank") { const pic = await pickFromBank(); if (pic) { E.pictures.push(pic); drawEd(); } return; }
      if (a === "upload") { ov.querySelector("[data-e-file]")?.click(); return; }
      if (a === "draftai") { draftAi(); return; }
      if (a === "comment") {
        const ta = ov.querySelector("[data-e-cmt]");
        const text = (ta?.value || "").trim();
        if (!text) return;
        const to = ov.querySelector("[data-e-cto]")?.value || "";
        E.busy = "comment"; drawEd();
        try { await addComment(text, to); E.cDraft = ""; E.cTo = ""; }
        catch (err) { E.err = errText(err); }
        finally { E.busy = ""; drawEd(); }
        return;
      }
      if (a === "save") {
        const status = E.isNew || E.status === "rejected" ? "draft" : E.status;
        await run(async () => { await write(payload(status, status === "waiting" ? "Changed while waiting for approval" : "Saved")); toast("Saved"); });
        return;
      }
      if (a === "send") {
        if (!ready("Send for approval")) return;
        if (E.status === "scheduled" && !confirm("This post is approved. Changing it sends it back for approval, and it won't be due until it's approved again. Carry on?")) return;
        const again = E.status === "scheduled";
        await run(async () => {
          await write(payload("waiting", again ? "Changed after approval: sent for approval again" : "Sent for approval"));
          callApi({ action: "seoSocial", op: "notify", id: E.id }).catch(() => { /* next part */ });
          toast("Sent for approval");
          close(true);
        });
        return;
      }
      if (a === "approve") {
        if (!ready("Approve and schedule") || !soonIfPast()) return;
        const again = E.status === "scheduled";
        await run(async () => {
          await write(payload("scheduled", again ? "Changed and approved again" : "Approved and scheduled", "", approval()));
          toast(`Scheduled for ${niceDay(E.day, { weekday: "short", day: "numeric", month: "short" })}, ${niceTime(E.time)}`);
          close(true);
        });
        return;
      }
      if (a === "changes" || a === "reject") {
        const why = prompt(a === "reject" ? "Why is it rejected? The reason goes in the comments." : "What needs changing? It goes in the comments, for the person who wrote it.", "");
        if (why === null) return;
        if (why.trim().length < 3) { E.err = "Add a short reason."; drawEd(); return; }
        await run(async () => {
          await write(payload(a === "reject" ? "rejected" : "draft", a === "reject" ? "Rejected" : "Changes requested", why.trim(), { reviewNote: why.trim().slice(0, 500) }));
          await addComment(`${a === "reject" ? "Rejected" : "Changes requested"}: ${why.trim()}`, p?.createdBy !== me.uid ? p?.createdByName || "" : "");
          toast(a === "reject" ? "Rejected" : "Sent back with your comments");
          close(true);
        });
        return;
      }
      if (a === "unsend") { await run(async () => { await write(payload("draft", "Taken back to draft")); toast("Back to draft"); }); return; }
      if (a === "unschedule") { await run(async () => { await write(payload("draft", "Taken off the schedule")); toast("Taken off the schedule"); }); return; }
      if (a === "delete") {
        if (!confirm("Delete this post? It's taken off the calendar.")) return;
        await run(async () => { await write(payload("deleted", "Deleted")); toast("Deleted"); close(true); });
        return;
      }
      if (a === "retry") {
        E.day = perthNow().day; E.time = perthNow().time;
        if (!soonIfPast()) return;
        await run(async () => { await write(payload("scheduled", "Trying again", "", { ...approval(), error: "" })); toast("It'll try again in a few minutes"); });
      }
    }

    async function markPosted(k) {
      const link = prompt(`Posted on ${CH[k].label}? Paste the post's link if you have it (optional).`, "");
      if (link === null) return;
      const pub = { ...((p && p.published) || {}), [k]: { at: new Date().toISOString(), by: me.name, link: /^https:\/\/\S+$/.test(link.trim()) ? link.trim().slice(0, 500) : "", manual: true } };
      const done = (p.channels || []).every((ch) => pub[ch]);
      try {
        await updateDoc(doc(db, "social_posts", E.id), { published: pub, status: done ? "posted" : "scheduled",
          updatedBy: me.uid, updatedByName: me.name, updatedAt: serverTimestamp(),
          history: arrayUnion({ at: new Date().toISOString(), by: me.name, what: `Posted on ${CH[k].label} by hand`, note: "" }) });
        p.published = pub;
        if (done) { p.status = "posted"; E.status = "posted"; }
        toast(done ? "All posted ✓" : `Marked posted on ${CH[k].label}`);
        drawEd();
      } catch (err) { toast(errText(err), true); }
    }

    async function draftAi() {
      if (E.topic.trim().length < 3) { E.err = "Say what the post is about first."; drawEd(); return; }
      E.busy = "draft"; E.err = ""; drawEd();
      try {
        const r = await callApi({ action: "seoSocial", op: "draft", topic: E.topic.trim(), link: E.link.trim(), channels: E.channels });
        if (!r || r.ok === false || r.problem) throw new Error((r && (r.problem || r.error)) || "No answer came back");
        E.caption = String(r.caption || "").trim();
        (Array.isArray(r.hashtags) ? r.hashtags : []).forEach(addTag);
      } catch (err) {
        E.err = `Claude couldn't draft it (${err.message || err}). If Social's Apps Script part isn't installed yet, that's expected: write it yourself for now.`;
      } finally { E.busy = ""; drawEd(); }
    }
    function addTag(raw) {
      const t = String(raw || "").replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 60);
      if (t && !E.hashtags.some((x) => x.toLowerCase() === t.toLowerCase())) E.hashtags.push(t);
    }

    async function upload(files) {
      const list = [...files].filter((f) => /^image\//.test(f.type)).slice(0, MAX_PICS - E.pictures.length);
      if (!list.length) return;
      E.busy = "upload"; E.err = ""; drawEd();
      try {
        for (const f of list) {
          const sh = await shrinkImg(f);
          const path = `social_media/${E.id}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${sh.ext}`;
          const r = sref(storage, path);
          await uploadBytes(r, sh.blob, { contentType: sh.type, cacheControl: "public, max-age=31536000" });
          E.pictures.push({ url: await getDownloadURL(r), path, alt: "", w: sh.w, h: sh.h, from: "upload" });
        }
      } catch (err) { console.error("Upload failed:", err); E.err = "A picture didn't upload. " + errText(err); }
      finally { E.busy = ""; drawEd(); }
    }

    /* --- events --- */
    ov.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !ov.contains(b)) return;
      const d = b.dataset;
      if (d.e) { doAction(d.e); return; }
      if (d.ePv) { E.prev = d.ePv; drawSide(); return; }
      if (d.eCopy) {
        copyText(capFor(d.eCopy) + tagText(d.eCopy)).then((ok) => toast(ok ? `${CH[d.eCopy].label} caption copied` : "Couldn't copy", !ok));
        return;
      }
      if (d.eMark) { markPosted(d.eMark); return; }
      if (readOnly()) return;
      if (d.eCh) {
        E.channels = E.channels.includes(d.eCh) ? E.channels.filter((k) => k !== d.eCh) : CH_ORDER.filter((k) => k === d.eCh || E.channels.includes(k));
        drawEd(); return;
      }
      if (d.eSplit) { E.captions[d.eSplit] = E.caption; drawEd(); ov.querySelector(`[data-e-capk="${d.eSplit}"]`)?.focus(); return; }
      if (d.eUnsplit) { delete E.captions[d.eUnsplit]; drawEd(); return; }
      if (d.ePx !== undefined) { E.pictures.splice(+d.ePx, 1); drawEd(); return; }
      if (d.ePl !== undefined) { const i = +d.ePl; [E.pictures[i - 1], E.pictures[i]] = [E.pictures[i], E.pictures[i - 1]]; drawEd(); return; }
      if (d.ePr !== undefined) { const i = +d.ePr; [E.pictures[i + 1], E.pictures[i]] = [E.pictures[i], E.pictures[i + 1]]; drawEd(); return; }
      if (d.eTx !== undefined) { E.hashtags.splice(+d.eTx, 1); drawEd(); }
    });
    ov.addEventListener("input", (e) => {
      const t = e.target, d = t.dataset;
      if (d.eCap !== undefined) { E.caption = t.value; drawSide(); }
      else if (d.eCapk) { E.captions[d.eCapk] = t.value; drawSide(); }
      else if (d.eTopic !== undefined) E.topic = t.value;
      else if (d.eLink !== undefined) { E.link = t.value; drawSide(); }
      else if (d.eAlt !== undefined) { const x = E.pictures[+d.eAlt]; if (x) x.alt = t.value; drawSide(); }
      else if (d.eDay !== undefined) { E.day = t.value; drawSide(); }
      else if (d.eTime !== undefined) { E.time = t.value; drawSide(); }
    });
    ov.addEventListener("change", (e) => {
      const t = e.target, d = t.dataset;
      if (d.eBtn !== undefined) { E.gbpButton = t.value; drawSide(); }
      else if (d.eTset !== undefined && t.value !== "") { ((S.settings.hashtagSets || [])[+t.value]?.tags || []).forEach(addTag); drawEd(); }
      else if (d.eFile !== undefined) { upload(t.files); }
      else if (d.eCto !== undefined) E.cTo = t.value;
    });
    ov.addEventListener("keydown", (e) => {
      const t = e.target;
      if (!t.matches || !t.matches("[data-e-tag]")) return;
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        t.value.split(/[\s,]+/).forEach(addTag);
        drawEd();
        ov.querySelector("[data-e-tag]")?.focus();
      } else if (e.key === "Backspace" && !t.value && E.hashtags.length) {
        E.hashtags.pop(); drawEd(); ov.querySelector("[data-e-tag]")?.focus();
      }
    });

    drawEd();
    startComments();
  }

  /* ===================== Image Bank picker ===================== */

  function pickFromBank() {
    return new Promise((resolve) => {
      let result = null, folder = "", q = "", timer = 0, imgs = new Map();
      const dlg = document.createElement("dialog");
      dlg.className = "sc-bank";
      dlg.innerHTML = `<div class="sc-bank-h"><strong>Image Bank</strong>
          <input class="seo-input" type="search" placeholder="Search pictures" data-bq aria-label="Search pictures">
          <button class="seo-btn" type="button" data-bx>Close</button></div>
        <div class="sc-bank-path" data-bp></div><p class="sc-bank-msg" data-bm hidden></p><div class="sc-bank-grid" data-bg></div>`;
      const grid = dlg.querySelector("[data-bg]"), pathEl = dlg.querySelector("[data-bp]");
      const say = function (t) { const el = dlg.querySelector("[data-bm]"); el.textContent = t || ""; el.hidden = !t; };
      async function show() {
        say("");
        grid.innerHTML = `<p class="seo-note">Loading…</p>`;
        try {
          const searching = q.trim().length >= 2;
          const r = searching ? await bankSearch(q) : await bankList(folder);
          imgs = new Map((r.images || []).map((m) => [m.id, m]));
          pathEl.innerHTML = searching ? `Results for “${esc(q.trim())}”`
            : (r.path || []).map((x) => `<button type="button" class="sc-link" data-bf="${esc(x.id)}">${esc(x.name)}</button>`).join(" › ");
          grid.innerHTML = (r.folders || []).map((f) => `<button type="button" class="sc-bf" data-bf="${esc(f.id)}">📁 ${esc(f.name)}</button>`).join("")
            + (r.images || []).map((m) => `<button type="button" class="sc-bi" data-bi="${esc(m.id)}" title="${esc(m.name)}"><img alt="" data-bt="${esc(m.id)}"><span>${esc(m.name)}</span></button>`).join("")
            || `<p class="seo-note">Nothing here.</p>`;
          grid.querySelectorAll("[data-bt]").forEach((img) => {
            const m = imgs.get(img.dataset.bt);
            if (m) thumbFor(m).then((u) => { if (img.isConnected) img.src = u; }).catch(() => { /* no thumbnail */ });
          });
        } catch (err) { grid.innerHTML = `<p class="seo-err">Couldn't open the Image Bank. ${esc(errText(err))}</p>`; }
      }
      dlg.addEventListener("click", async (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.bx !== undefined) { dlg.close(); return; }
        if (b.dataset.bf !== undefined) { folder = b.dataset.bf; q = ""; dlg.querySelector("[data-bq]").value = ""; show(); return; }
        if (b.dataset.bi) {
          const m = imgs.get(b.dataset.bi);
          if (!m) return;
          if (!m.fullPath) { say("That picture is still in the old Google Drive Image Bank, so it can't be posted. Upload it instead, or move it to the new Image Bank first."); return; }
          say("");
          b.disabled = true;
          try {
            const url = await getDownloadURL(sref(storage, m.fullPath));
            result = { url, path: m.fullPath, alt: m.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " "), w: m.width || 0, h: m.height || 0, from: "bank" };
            dlg.close();
          } catch (err) { b.disabled = false; say("Couldn't use that picture. " + errText(err)); }
        }
      });
      dlg.addEventListener("input", (e) => {
        if (!e.target.matches("[data-bq]")) return;
        q = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(show, 300);
      });
      dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
      document.body.appendChild(dlg);
      dlg.showModal();
      show();
    });
  }

  /* ----- start ----- */
  wrap.innerHTML = `<div class="seo-empty">Loading…</div>`;
  Promise.all([loadSettings(), loadPosts(), loadIdeas()])
    .then(() => { if (wrap.isConnected) draw(); })
    .catch((e) => { console.error("Social not loaded:", e); if (wrap.isConnected) wrap.innerHTML = `<div class="seo-empty seo-err">${esc(errText(e))}</div>`; });
  callApi({ action: "staffList" }).then((r) => { S.staff = (r && r.staff) || []; }).catch(() => { /* comments go to everyone */ });
}

/* ===================== Styles ===================== */

const CSS = `
.sc-sp{flex:1}
.sc-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px}
.sc-nav{display:flex;align-items:center;gap:6px}
.sc-nav strong{min-width:170px;text-align:center;font-size:16px}
.sc-ltitle{font-size:16px}
.sc-n{display:inline-block;min-width:18px;margin-left:4px;padding:0 6px;border-radius:999px;background:rgba(0,0,0,.08);font-size:11px}
.sc-b{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:6px 14px;border:1px solid #0f766e;border-radius:8px;background:#fff;color:#0f766e;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.sc-b.is-go{background:#0f766e;color:#fff}
.sc-b:disabled{opacity:.5;cursor:not-allowed}
.sc-link{border:0;background:none;padding:0;color:#0f766e;font:inherit;font-size:13px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.sc-wait{display:block;width:100%;margin:0 0 10px;padding:10px 14px;border:1px solid #fde68a;border-radius:10px;background:#fffbeb;color:#92400e;font:inherit;font-weight:600;text-align:left;cursor:pointer}
.sc-handnote{margin:0 0 10px}
.sc-body.has-ideas{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px;align-items:start}
.sc-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;background:#e5e7eb;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}
.sc-dow{padding:6px 8px;background:#f8fafc;font-size:12px;font-weight:600;color:#64748b}
.sc-day{min-height:118px;padding:6px;background:#fff;min-width:0;transition:background .1s}
.sc-cal.is-week .sc-day{min-height:340px}
.sc-day.is-out{background:#f8fafc}
.sc-day.is-out .sc-dnum span{color:#cbd5e1}
.sc-day.is-today{box-shadow:inset 0 0 0 2px #0f766e}
.sc-day.is-past .sc-dnum span{color:#94a3b8}
.sc-day.is-drop{background:#f0fdfa}
.sc-dnum{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;color:#334155}
.sc-add{width:22px;height:22px;border:1px solid #e5e7eb;border-radius:50%;background:#fff;color:#0f766e;font-size:15px;line-height:1;cursor:pointer;opacity:.55}
.sc-day:hover .sc-add,.sc-add:focus-visible{opacity:1}
.sc-card{display:flex;flex-direction:column;gap:3px;margin-top:6px;padding:6px 7px;border:1px solid #e5e7eb;border-left:3px solid var(--t,#94a3b8);border-radius:8px;background:#fff;font-size:12px;cursor:pointer;min-width:0}
.sc-card:hover{border-color:#94a3b8}
.sc-card:focus-visible{outline:2px solid #0f766e;outline-offset:1px}
.sc-card.is-dragging{opacity:.4}
.sc-card.is-grey{--t:#94a3b8}.sc-card.is-amber{--t:#d97706}.sc-card.is-blue{--t:#2563eb}.sc-card.is-green{--t:#16a34a}.sc-card.is-red{--t:#dc2626}
.sc-card.is-hand{--t:#7c3aed;background:#faf5ff}
.sc-ctop{display:flex;align-items:center;gap:3px}
.sc-ctop b{margin-left:auto;font-weight:600;color:#475569}
.sc-cimg{width:100%;height:60px;object-fit:cover;border-radius:6px}
.sc-ccap{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.35;color:#0f172a}
.sc-cst{color:#64748b;font-size:11.5px}
.sc-cm{font-style:normal}
.sc-cm.is-new{color:#b45309;font-weight:700}
.sc-chi{display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;color:#fff;font-size:10px;font-weight:800;font-style:normal;vertical-align:-3px}
.sc-chi.is-fb{background:#1877f2}.sc-chi.is-ig{background:linear-gradient(45deg,#f58529,#dd2a7b,#8134af)}.sc-chi.is-gbp{background:#16a34a}
.sc-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-top:10px;font-size:12px;color:#64748b}
.sc-lg.is-amber{color:#b45309}.sc-lg.is-blue{color:#1d4ed8}.sc-lg.is-green{color:#15803d}
.sc-pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#f1f5f9;color:#475569;white-space:nowrap}
.sc-pill.is-amber{background:#fef3c7;color:#92400e}.sc-pill.is-blue{background:#dbeafe;color:#1d4ed8}
.sc-pill.is-green{background:#dcfce7;color:#166534}.sc-pill.is-red{background:#fee2e2;color:#b91c1c}
.sc-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0}
.sc-chip{border:1px solid #e5e7eb;background:#fff;border-radius:999px;padding:4px 12px;font:inherit;font-size:12.5px;cursor:pointer}
.sc-chip.is-on{border-color:#0f766e;background:#f0fdfa;color:#0f766e;font-weight:600}
.sc-list td{text-align:left !important}
.sc-lcap{white-space:normal !important;max-width:420px}
.sc-ideas{padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;max-height:78vh;overflow:auto}
.sc-ihead{display:flex;flex-direction:column;gap:2px;margin-bottom:8px}
.sc-iform{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.sc-iform .seo-input{min-width:0;width:100%;box-sizing:border-box}
.sc-idea{padding:10px;margin-bottom:8px;border:1px solid #e5e7eb;border-radius:10px;background:#fafafa;cursor:grab;font-size:13px}
.sc-idea p{margin:4px 0;line-height:1.4;white-space:pre-wrap}
.sc-idea small{display:block;margin-top:2px}
.sc-ilink{color:#0f766e;word-break:break-all}
.sc-iacts{display:flex;gap:6px;margin-top:8px}
.sc-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:3000;padding:10px 16px;border-radius:999px;background:#0f172a;color:#fff;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.2)}
.sc-toast.is-bad{background:#b91c1c}
body.sc-ed-open{overflow:hidden}
.sc-ed{position:fixed;inset:0;z-index:1200;overflow:auto;background:#f8fafc}
.sc-ed-bar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;background:#fff;border-bottom:1px solid #e5e7eb}
.sc-acts{display:flex;flex-wrap:wrap;gap:6px}
.sc-ed-grid{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:16px;max-width:1280px;margin:0 auto;padding:16px}
.sc-sec{margin-bottom:12px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
.sc-sec h4,.sc-h{margin:0 0 8px;font-size:13.5px}
.sc-sec h4 small,.sc-h small{font-weight:400;color:#64748b;margin-left:4px}
.sc-h{margin:14px 0 8px}
.sc-err{margin-bottom:12px;padding:10px 12px;border-radius:10px;background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d;font-size:13px}
.sc-review{margin-bottom:12px;padding:10px 12px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;font-size:13px}
.sc-pub div{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 0;font-size:13px}
.sc-bad{color:#b91c1c;font-weight:600}
.sc-good{color:#15803d}
.sc-chs{display:flex;flex-wrap:wrap;gap:8px}
.sc-chb{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid #e5e7eb;border-radius:999px;background:#fff;font:inherit;font-size:13px;cursor:pointer;opacity:.6}
.sc-chb.is-on{opacity:1;border-color:#0f766e;background:#f0fdfa;font-weight:600}
.sc-pics{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:6px}
.sc-pic{display:flex;flex-direction:column;gap:4px}
.sc-pic img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb}
.sc-pic .seo-input{min-width:0;width:100%;box-sizing:border-box;font-size:12px}
.sc-picb{display:flex;gap:4px}
.sc-picb button{flex:1;border:1px solid #e5e7eb;border-radius:6px;background:#fff;cursor:pointer;font:inherit}
.sc-grow{flex:1;min-width:0}
.sc-ta{display:block;width:100%;min-width:0;box-sizing:border-box;resize:vertical;line-height:1.5}
.sc-lab{display:flex;flex-direction:column;gap:4px;margin-top:8px;font-size:12.5px;font-weight:600;color:#475569}
.sc-lab small{font-weight:400}
.sc-split{margin:8px 10px 0 0}
.sc-tags{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-height:38px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px}
.sc-tags input{flex:1;min-width:150px;border:0;outline:0;font:inherit;font-size:13px}
.sc-tag{display:inline-flex;align-items:center;gap:2px;padding:1px 8px;border-radius:999px;background:#f0fdfa;color:#115e59;font-size:12.5px}
.sc-tag button{border:0;background:none;padding:0 0 0 3px;font:inherit;cursor:pointer;opacity:.6}
.sc-ed-side{position:sticky;top:64px;align-self:start;max-height:calc(100vh - 80px);overflow:auto}
.sc-pvtabs{display:flex;margin-bottom:8px}
.sc-pv{border:1px solid #e5e7eb;border-radius:12px;background:#fff;overflow:hidden;font-size:13px}
.sc-pv-h{display:flex;align-items:center;gap:8px;padding:10px}
.sc-pv-h small{display:block;color:#64748b;font-size:11.5px}
.sc-av{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#0f766e;color:#fff;font-weight:700}
.sc-pv-sq{position:relative;display:grid;place-items:center;aspect-ratio:1;background:#f1f5f9;color:#94a3b8}
.sc-pv-sq img{width:100%;height:100%;object-fit:cover}
.sc-pv-n{position:absolute;top:8px;right:8px;padding:2px 8px;border-radius:999px;background:rgba(15,23,42,.7);color:#fff;font-size:11px}
.sc-pv-wide img{display:block;width:100%;max-height:300px;object-fit:cover}
.sc-pv-act{padding:8px 10px 0;font-size:15px}
.sc-pv-t{margin:0;padding:8px 10px 10px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.sc-more{color:#64748b}
.sc-pv-link{padding:8px 10px;background:#f1f5f9;font-size:11.5px;color:#64748b}
.sc-pv-btn{display:inline-block;margin:0 10px 8px;padding:6px 14px;border-radius:999px;border:1px solid #1a73e8;color:#1a73e8;font-weight:600}
.sc-pv-g small{display:block;padding:0 10px 10px}
.sc-checks{list-style:none;margin:0;padding:0;font-size:13px}
.sc-checks li{position:relative;padding:5px 0 5px 22px;line-height:1.4}
.sc-checks li::before{position:absolute;left:2px;top:5px;font-weight:700}
.sc-checks li.is-ok::before{content:"✓";color:#16a34a}
.sc-checks li.is-warn::before{content:"!";color:#d97706}
.sc-checks li.is-bad::before{content:"⚠";color:#dc2626}
.sc-checks li.is-stop{color:#b91c1c;font-weight:600}
.sc-checks li.is-stop::before{content:"✕";color:#dc2626}
.sc-thread{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto;margin-bottom:8px}
.sc-cmt{align-self:flex-start;max-width:88%;padding:8px 11px;border-radius:12px;background:#f1f5f9;font-size:13px}
.sc-cmt.is-me{align-self:flex-end;background:#ccfbf1}
.sc-cmeta{font-size:12px}
.sc-ctext{margin-top:2px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.sc-cbox textarea{width:100%;min-width:0;box-sizing:border-box;resize:vertical}
.sc-hist{margin-top:12px;font-size:12.5px}
.sc-hist summary{cursor:pointer;color:#64748b}
.sc-hist ul{margin:6px 0 0;padding-left:18px;line-height:1.5}
.sc-set .seo-input{min-width:0;width:100%;box-sizing:border-box}
.sc-conn{margin:10px 0;font-size:13px;line-height:1.8}
.sc-bank{position:fixed;inset:0;margin:auto;width:min(900px,95vw);height:min(720px,88vh);max-height:88vh;padding:0;border:0;border-radius:14px;
  box-shadow:0 24px 60px rgba(15,23,42,.25);overflow:hidden}
.sc-bank[open]{display:flex;flex-direction:column}
.sc-bank-msg{margin:0 14px 8px;padding:8px 12px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d;font-size:13px}
.sc-bank-msg[hidden]{display:none}
.sc-bank::backdrop{background:rgba(15,23,42,.45)}
.sc-bank-h{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #e5e7eb}
.sc-bank-h .seo-input{flex:1;min-width:0}
.sc-bank-path{padding:8px 14px;font-size:13px}
.sc-bank-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));grid-auto-rows:max-content;
  gap:8px;padding:0 14px 14px;overflow:auto}
.sc-bf{padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.sc-bi{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;font:inherit;font-size:11.5px;cursor:pointer;text-align:left}
.sc-bi img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;background:#f1f5f9}
.sc-bi span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-bi:hover,.sc-bf:hover{border-color:#0f766e}
@media (max-width:1000px){.sc-body.has-ideas{grid-template-columns:1fr}.sc-ed-grid{grid-template-columns:1fr}.sc-ed-side{position:static;max-height:none}}
@media (max-width:700px){.sc-day{min-height:84px;padding:4px}.sc-cimg{display:none}.sc-ccap{-webkit-line-clamp:1}}
`;

function injectCss() {
  if (document.getElementById("seo-social-css")) return;
  const s = document.createElement("style");
  s.id = "seo-social-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}