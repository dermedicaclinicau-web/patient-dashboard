// Task Manager → Marketing → Campaigns: the list (#/tasks/marketing/campaigns) and one campaign (…/campaigns/<id>).
// A draft is saved here. "Send now" or "Schedule" hands it to Apps Script (Code.gs → Marketing: campaigns),
// which chooses the patients when it's time and sends in batches. The page follows it live, with its results
// (opens, clicks, unsubscribes, bounces) and "Make a list from this" for a follow-up campaign.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, addDoc, updateDoc, onSnapshot, serverTimestamp, getDoc, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { listTemplates, setBuilderBack } from "./mkt-templates.js";
import { esc, renderEmail, MERGE_TAGS } from "./mkt-email.js";
import { mountRuleBuilder, cleanGroup, groupProblem, describeGroup, blankGroup, loadProductNames } from "./flow-rules.js";

const COL = "mkt_campaigns";
const LIST_HREF = "#/tasks/marketing/campaigns";
const BACK = `<a class="back-link" href="${LIST_HREF}">← Campaigns</a>`;
// Rules that make sense without a purchase or visit (the same list as MKT_RULE_FIELDS_ in Code.gs)
export const CAMPAIGN_FIELDS = ["hist.bought", "hist.days_since", "appt.has_future", "appt.next_days", "appt.last_days",
  "appt.visits", "appt.future_service", "appt.past_service", "appt.visit_between", "appt.last_between", "ssp.active", "ssp.age_days", "ssp.expiry_days",
  "plan.status", "plan.due", "plan.overdue", "form.saved", "pt.age", "pt.email", "pt.mobile"];
const STATUS = {
  draft: ["Draft", "is-draft"], scheduled: ["Scheduled", "is-sched"], building: ["Getting ready", "is-live"],
  sending: ["Sending", "is-live"], paused: ["Paused", "is-paused"], sent: ["Sent", "is-sent"], cancelled: ["Cancelled", "is-cancel"],
};
const CAPS = [[200, "200 a day"], [400, "400 a day"], [800, "800 a day (recommended)"], [1200, "1,200 a day"]];
const FILTERS = [
  ["all", "All", () => true], ["draft", "Drafts", (s) => s === "draft"], ["scheduled", "Scheduled", (s) => s === "scheduled"],
  ["sending", "Sending", (s) => ["building", "sending", "paused"].includes(s)], ["sent", "Sent", (s) => ["sent", "cancelled"].includes(s)],
];
const LIST_SHORT = { opened: "opened", notOpened: "didn't open", clicked: "clicked", notClicked: "didn't click" };
const EMAIL_RE = /[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+/g;

const n0 = (v) => Number(v || 0).toLocaleString("en-AU");
const pct = (a, b) => (Number(b) > 0 ? Math.min(100, Math.round((Number(a || 0) / Number(b)) * 100)) : 0);
const rate = (n, of) => (Number(of) > 0 ? `${(Math.round((Number(n || 0) / Number(of)) * 1000) / 10).toLocaleString("en-AU")}%` : "–");
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const toDate = (v) => {
  if (v && typeof v.toDate === "function") return v.toDate();
  if (typeof v === "string" && v) { const d = new Date(v); return isNaN(d) ? null : d; }
  return null;
};
const when = (d) => (d && !isNaN(d) ? d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const who = (staff) => String((staff && staff.name) || "").slice(0, 120);
const me = () => {
  const u = auth.currentUser && auth.currentUser.uid;
  if (!u) throw new Error("Your session has ended. Log in again.");
  return u;
};
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to campaigns. Check Marketing access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);
const pill = (s) => `<span class="mc-pill ${(STATUS[s] || STATUS.draft)[1]}">${esc((STATUS[s] || [s])[0])}</span>`;
const statBox = (label, val, help = "") => `<div class="mc-stat"><small>${esc(label)}</small><strong>${val}</strong>${help ? `<em>${esc(help)}</em>` : ""}</div>`;
// The same box, but clicking it shows who (f: a WHO_FILTERS key)
const statLink = (label, val, help, f) => `<button type="button" class="mc-stat is-link" data-whof="${f}" title="See who">` +
  `<small>${esc(label)}</small><strong>${val}</strong>${help ? `<em>${esc(help)}</em>` : ""}</button>`;

/* ---------- Who it goes to ---------- */
const audMode = (m) => (m === "rules" || m === "list" ? m : "all");
const cleanList = (l) => {
  const x = l || {};
  return { campaignId: String(x.campaignId || ""), kind: String(x.kind || "opened"), link: Number(x.link) || 0,
    name: String(x.name || "").slice(0, 120), label: String(x.label || "").slice(0, 80) };
};
// Patients left out by hand. Kept with the campaign; their email address is left out too (it can be shared).
const MAX_EXCLUDE = 500;
const cleanExclude = (l) => (Array.isArray(l) ? l : []).filter((x) => x && x.id).slice(0, MAX_EXCLUDE)
  .map((x) => ({ id: String(x.id).slice(0, 80), name: String(x.name || "").slice(0, 120),
    email: String(x.email || "").trim().toLowerCase().slice(0, 254) }));
function listText(l) {
  const n = `“${l.name || "an earlier campaign"}”`;
  if (l.kind === "link") return `Clicked “${l.label || "a link"}” in ${n}`;
  return ({ opened: `Opened ${n}`, notOpened: `Didn't open ${n}`, clicked: `Clicked a link in ${n}`,
    notClicked: `Didn't click a link in ${n}` })[l.kind] || `From ${n}`;
}
function audText(c) {
  const a = c.audience;
  if (a.mode === "rules") return describeGroup(a.rules);
  if (a.mode === "list") return listText(a.list) + (a.rules.rules.length ? ` · and ${describeGroup(a.rules)}` : "");
  return "Everyone who can receive marketing emails";
}

function openDialog(html, cls = "") {
  const dlg = document.createElement("dialog");
  dlg.className = `lh-dialog mk-dlg ${cls}`;
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

/* ===================== Firestore ===================== */

function normC(snap) {
  const x = snap.data() || {};
  const a = x.audience || {};
  const st = x.stats || {};
  const status = x.status === "archived" || STATUS[x.status] ? String(x.status) : "draft";
  return {
    id: snap.id, name: String(x.name || "Untitled campaign"), status,
    templateId: String(x.templateId || ""), templateName: String(x.templateName || ""),
    subject: String(x.subject || ""), fromName: String(x.fromName || "Dermedica Clinic"), replyTo: String(x.replyTo || ""),
    audience: { mode: audMode(a.mode), rules: cleanGroup(a.rules || blankGroup()), list: cleanList(a.list), exclude: cleanExclude(a.exclude) },
    // Drafts track by default; a scheduled campaign shows what it was actually sent with
    track: status === "draft" ? x.track !== false : x.track === true,
    links: (Array.isArray(x.links) ? x.links : []).map((l) => ({ url: String((l && l.url) || ""), text: String((l && l.text) || "") })),
    linkClicks: x.linkClicks && typeof x.linkClicks === "object" ? x.linkClicks : {},
    stats: {
      opens: Number(st.opens) || 0, opensTotal: Number(st.opensTotal) || 0, clicks: Number(st.clicks) || 0,
      clicksTotal: Number(st.clicksTotal) || 0, unsubscribes: Number(st.unsubscribes) || 0, bounces: Number(st.bounces) || 0,
      forms: Number(st.forms) || 0,
    },
    dailyCap: Number(x.dailyCap) || 800, sendAtMs: Number(x.sendAtMs) || 0,
    total: Number(x.total || 0), sent: Number(x.sent || 0), skipped: Number(x.skipped || 0), failed: Number(x.failed || 0),
    chunks: Number(x.chunks || 0), cursor: Number(x.cursor || 0),
    buildChecked: Number(x.buildChecked || 0), buildTotal: Number(x.buildTotal || 0),
    failures: Array.isArray(x.failures) ? x.failures : [], waiting: String(x.waiting || ""), lastError: String(x.lastError || ""),
    note: String(x.note || ""), html: String(x.html || ""),
    startedAt: toDate(x.startedAt), finishedAt: toDate(x.finishedAt), updatedAt: toDate(x.updatedAt),
    createdBy: String(x.createdBy || ""), scheduledBy: String(x.scheduledBy || ""),
  };
}

async function createCampaign(base, staff) {
  const uid = me();
  const a = base.audience || {};
  const ref = await addDoc(collection(db, COL), {
    name: String(base.name || "").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled campaign",
    status: "draft", templateId: base.templateId || "", templateName: base.templateName || "", subject: base.subject || "",
    fromName: base.fromName || "Dermedica Clinic", replyTo: base.replyTo || "",
    audience: { mode: audMode(a.mode), rules: cleanGroup(a.rules || blankGroup()), list: cleanList(a.list), exclude: cleanExclude(a.exclude) },
    dailyCap: Number(base.dailyCap) || 800, track: base.track !== false,
    createdAt: serverTimestamp(), createdBy: who(staff), createdByUid: uid,
    updatedAt: serverTimestamp(), updatedBy: who(staff), updatedByUid: uid,
  });
  return ref.id;
}

async function saveDraft(c, staff) {
  await updateDoc(doc(db, COL, c.id), {
    name: String(c.name || "").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled campaign",
    templateId: c.templateId, templateName: c.templateName, subject: String(c.subject || "").slice(0, 200),
    fromName: String(c.fromName || "").slice(0, 80), replyTo: String(c.replyTo || "").trim().slice(0, 254),
    audience: { mode: c.audience.mode, rules: cleanGroup(c.audience.rules), list: cleanList(c.audience.list),
      exclude: cleanExclude(c.audience.exclude) },
    dailyCap: Number(c.dailyCap) || 800, track: c.track !== false,
    updatedAt: serverTimestamp(), updatedBy: who(staff), updatedByUid: me(),
  });
}

function progressHtml(c) {
  if (c.status === "building") {
    return `<div class="mc-bar"><span style="width:${pct(c.buildChecked, c.buildTotal)}%"></span></div>
      <small class="muted">Choosing patients: ${n0(c.buildChecked)} of ${n0(c.buildTotal || "…")} checked</small>`;
  }
  if (!c.total) return "";
  const done = c.sent + c.skipped + c.failed;
  return `<div class="mc-bar"><span style="width:${pct(done, c.total)}%"></span></div>
    <small class="muted">${n0(c.sent)} of ${n0(c.total)} sent</small>`;
}
function eta(c) {
  const left = c.total - (c.sent + c.skipped + c.failed);
  if (!["sending", "paused"].includes(c.status) || left <= 0) return "";
  const days = Math.ceil(left / Math.max(1, c.dailyCap));
  return days <= 1 ? "Should finish today or tomorrow" : `About ${days} more sending days`;
}

/* ===================== The list ===================== */

function newDialog(staff, templates) {
  const dlg = openDialog(`
    <form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>New campaign</h3><p>You'll choose who it goes to and when on the next page.</p></div>
      <label class="lh-field"><span class="lh-label">Name</span>
        <input name="name" maxlength="120" placeholder="October newsletter" autocomplete="off" /></label>
      <label class="lh-field"><span class="lh-label">Email (optional for now)</span>
        <select class="fb-select" name="tpl"><option value="">Choose later</option>${templates.map((t) =>
          `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Create</button>
      </div>
    </form>`);
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) { err.textContent = "Give the campaign a name."; err.hidden = false; return; }
    const t = templates.find((x) => x.id === form.elements.tpl.value);
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const id = await createCampaign({ name, templateId: t ? t.id : "", templateName: t ? t.name : "" }, staff);
      dlg.close();
      location.hash = `${LIST_HREF}/${encodeURIComponent(id)}`;
    } catch (ex) {
      console.error("Create campaign failed:", ex);
      err.textContent = errText(ex, "Couldn't create it. Try again.");
      err.hidden = false;
      btn.disabled = false;
    }
  });
  form.elements.name.focus();
}

function rowWhen(c) {
  if (c.status === "draft") return c.updatedAt ? `Edited ${when(c.updatedAt)}` : "";
  if (c.status === "scheduled") return `Sends ${when(new Date(c.sendAtMs))}`;
  if (c.status === "building") return "Choosing patients…";
  if (c.status === "sending" || c.status === "paused") return `${n0(c.sent)} of ${n0(c.total)} sent`;
  if (c.status === "sent") {
    const opened = c.track && c.sent ? ` · ${rate(c.stats.opens, c.sent)} opened` : "";
    return `${n0(c.sent)} sent${opened}${c.finishedAt ? ` · ${when(c.finishedAt)}` : ""}`;
  }
  return "Cancelled";
}

export function mountCampaignList(box, { staff = null } = {}) {
  const ui = { f: "all" };
  let list = null;
  let templates = [];
  box.innerHTML = `
    <div class="mk-tools">
      <div class="pt-tabs mc-filters" data-role="filters" role="group" aria-label="Show"></div>
      <span class="inv-spacer"></span>
      <button type="button" class="ff-btn is-primary" data-act="new">+ New campaign</button>
    </div>
    <div data-role="list"><div class="skeleton" style="height:180px;border-radius:14px"></div></div>`;
  const listEl = box.querySelector('[data-role="list"]');
  const filtersEl = box.querySelector('[data-role="filters"]');
  listTemplates().then((l) => { templates = l; }).catch(() => {});

  function draw() {
    if (!list) return;
    filtersEl.innerHTML = FILTERS.map(([k, l, fn]) => {
      const n = list.filter((c) => fn(c.status)).length;
      return `<button type="button" data-f="${k}" class="${ui.f === k ? "active" : ""}">${esc(l)}${k !== "all" && n ? ` <em>${n}</em>` : ""}</button>`;
    }).join("");
    if (!list.length) {
      listEl.innerHTML = `<div class="tm-empty"><strong>Send your first campaign</strong><br>Choose an email template, who it goes to and when.
        <div class="tm-empty-act"><button type="button" class="ff-btn is-primary" data-act="new">+ New campaign</button></div></div>`;
      return;
    }
    const fn = FILTERS.find((x) => x[0] === ui.f)[2];
    const rows = list.filter((c) => fn(c.status));
    listEl.innerHTML = rows.length ? `<div class="mc-list">${rows.map((c) => `
      <a class="mc-row" href="${LIST_HREF}/${encodeURIComponent(c.id)}">
        <span class="mc-row-main">
          <strong>${esc(c.name)}</strong>
          <small>${esc([c.templateName || "No email chosen yet", c.subject].filter(Boolean).join(" · "))}</small>
          ${["building", "sending", "paused"].includes(c.status) ? `<span class="mc-row-bar">${progressHtml(c)}</span>` : ""}
        </span>
        <span class="mc-row-when">${esc(rowWhen(c))}</span>
        ${pill(c.status)}
      </a>`).join("")}</div>` : '<div class="tm-empty">No campaigns here.</div>';
  }

  const stop = onSnapshot(collection(db, COL), (snap) => {
    if (!box.isConnected) { stop(); return; }
    list = snap.docs.map(normC).filter((c) => c.status !== "archived")
      .sort((a, b) => (b.updatedAt ? b.updatedAt.getTime() : 0) - (a.updatedAt ? a.updatedAt.getTime() : 0));
    draw();
  }, (err) => {
    if (!box.isConnected) return;   // left the page (or logged out): nothing to show
    console.error("Campaigns failed:", err);
    listEl.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the campaigns."))}</div>`;
  });
  // Stops listening as soon as you leave the list
  window.addEventListener("hashchange", function off() {
    setTimeout(() => { if (!box.isConnected) { stop(); window.removeEventListener("hashchange", off); } }, 0);
  });

  box.addEventListener("click", (e) => {
    const f = e.target.closest("[data-f]");
    if (f) { ui.f = f.dataset.f; draw(); return; }
    if (e.target.closest('[data-act="new"]')) newDialog(staff, templates);
  });
}

/* ===================== One campaign ===================== */

export async function mountCampaignEditor(container, { id, staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page mc";
  root.innerHTML = `${BACK}<div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);
  let mode = "";
  let draft = null;
  let view = null;
  let stop = null;
  const end = () => { if (stop) { stop(); stop = null; } if (draft) { draft.close(); draft = null; } };
  window.addEventListener("hashchange", function off() {
    setTimeout(() => { if (!root.isConnected) { end(); window.removeEventListener("hashchange", off); } }, 0);
  });

  stop = onSnapshot(doc(db, COL, id), (snap) => {
    if (!root.isConnected) { end(); return; }
    if (!snap.exists() || (snap.data() || {}).status === "archived") {
      mode = "gone";
      root.innerHTML = `${BACK}<div class="state"><strong>Campaign not found</strong>It may have been deleted.</div>`;
      return;
    }
    const c = normC(snap);
    if (c.status === "draft") {
      // A draft isn't redrawn while it's being typed in (its own saves come back here too)
      if (mode !== "draft") { mode = "draft"; view = null; draft = mountDraft(root, c, staff); }
      return;
    }
    if (draft) { draft.close(); draft = null; }
    if (mode !== "view") { mode = "view"; view = mountView(root, c, staff); }
    view.update(c);
  }, (err) => {
    if (!root.isConnected) return;
    console.error("Campaign failed:", err);
    root.innerHTML = `${BACK}<div class="state error"><strong>Couldn't open the campaign</strong>${esc(errText(err, "Try again."))}</div>`;
  });
}

/* ---------- A draft: the five steps ---------- */
// Each mode gets its own fresh element, so its listeners go when it does

function mountDraft(page, c, staff) {
  const root = document.createElement("div");
  page.replaceChildren(root);
  let timer = 0;
  let dirty = false;
  let saving = null;
  let lastCount = null;
  let showWho = false;   // the list of patients is open
  let whoQ = "";         // its search box
  let whoShown = 100;
  let templates = null;
  let tagTarget = null;
  const stepHead = (key, title) => `<div class="mc-step-h"><span class="mc-tick" data-tick="${key}" aria-hidden="true"></span>
    <div><h4>${title}</h4><small class="muted" data-sum="${key}"></small></div></div>`;
  const hasList = !!c.audience.list.campaignId;

  root.innerHTML = `
    ${BACK}
    <div class="mc-head">
      <input class="fe-name mc-name" data-role="name" maxlength="120" value="${esc(c.name)}" aria-label="Campaign name" />
      <span class="fe-state is-saved" data-role="state">All changes saved</span>
      <span class="inv-spacer"></span>
      <button type="button" class="btn-ghost" data-act="dup">Duplicate</button>
      <button type="button" class="btn-ghost" data-act="delete">Delete</button>
    </div>

    <section class="tb-card mc-step">
      ${stepHead("to", "To")}
      <div class="mc-opts">
        ${hasList ? `<label class="mc-opt"><input type="radio" name="mc-aud" value="list"${c.audience.mode === "list" ? " checked" : ""} />
          <span><strong>${esc(listText(c.audience.list))}</strong><small>Worked out when it sends, from that campaign's results so far</small></span></label>` : ""}
        <label class="mc-opt"><input type="radio" name="mc-aud" value="all"${c.audience.mode === "all" ? " checked" : ""} />
          <span><strong>Everyone</strong><small>Every patient who can receive marketing emails</small></span></label>
        <label class="mc-opt"><input type="radio" name="mc-aud" value="rules"${c.audience.mode === "rules" ? " checked" : ""} />
          <span><strong>Patients who match rules</strong><small>The same rules as Email flows, for example last visit more than 180 days ago</small></span></label>
      </div>
      <p class="fe-note mc-rules-hint" data-role="ruleshint"${c.audience.mode === "list" ? "" : " hidden"}>
        Optional: only those on the list who also match these rules.</p>
      <div class="mc-rules" data-role="rules"${c.audience.mode === "all" ? " hidden" : ""}><p class="muted">Loading…</p></div>
      <div class="mc-count"><button type="button" class="lh-btn" data-act="count">Count patients</button><span data-role="count"></span></div>
      <div data-role="excl"></div>
      <div class="mc-who" data-role="who" hidden></div>
      <p class="fe-note">Always left out: anyone on the do-not-contact list, patients with no email address and merged duplicates.
        Patients who share an email address get one email between them.</p>
    </section>

    <section class="tb-card mc-step">
      ${stepHead("from", "From")}
      <div class="fe-two">
        <label class="lh-field"><span class="lh-label">From name</span>
          <input class="fe-input" data-k="fromName" maxlength="80" value="${esc(c.fromName)}" /></label>
        <label class="lh-field"><span class="lh-label">Replies go to (optional)</span>
          <input class="fe-input" data-k="replyTo" type="email" maxlength="254" placeholder="info@dermedica.com.au" value="${esc(c.replyTo)}" /></label>
      </div>
      <p class="fe-note">It's sent from the clinic's email account. Leave "Replies go to" empty to get replies there.</p>
    </section>

    <section class="tb-card mc-step">
      ${stepHead("subject", "Subject")}
      <label class="lh-field"><span class="lh-label">Subject</span>
        <input class="fe-input" data-k="subject" maxlength="150" value="${esc(c.subject)}" /></label>
      <div class="mb-tags"><small class="muted">Insert:</small>${MERGE_TAGS.map(([tag, help]) =>
        `<button type="button" class="ch-chip" data-tag="${esc(tag)}" title="${esc(help)}">${esc(tag)}</button>`).join("")}</div>
      <p class="fe-note">Leave it empty to use the template's subject. The preview text comes from the template.</p>
    </section>

    <section class="tb-card mc-step">
      ${stepHead("content", "Content")}
      <label class="lh-field"><span class="lh-label">Email</span>
        <select class="fb-select" data-role="tpl"><option value="">Loading templates…</option></select></label>
      <div class="mc-prev" data-role="prev"></div>
      <div class="mc-acts">
        <a class="lh-btn" data-role="edit" hidden>Edit this email</a>
        <button type="button" class="lh-btn" data-act="test">Send a test</button>
        <a class="lh-btn is-quiet" href="#/tasks/marketing/templates">All templates</a>
      </div>
    </section>

    <section class="tb-card mc-step">
      ${stepHead("send", "Send")}
      <div class="mc-opts">
        <label class="mc-opt"><input type="radio" name="mc-when" value="now" checked />
          <span><strong>Send now</strong><small>Starts within 10 minutes, between 9 am and 6 pm</small></span></label>
        <label class="mc-opt"><input type="radio" name="mc-when" value="later" />
          <span><strong>Schedule</strong><small>Choose a day and time</small></span></label>
      </div>
      <input type="datetime-local" class="fe-input mc-at" data-role="at" hidden aria-label="Send on" />
      <label class="lh-field"><span class="lh-label">Most emails a day</span>
        <select class="fb-select" data-k="dailyCap">${CAPS.map(([v, l]) =>
          `<option value="${v}"${Number(c.dailyCap) === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <small class="fe-note">Big lists go out over several days. 300 of the clinic's daily emails are always kept free for appointments, forms and tasks.</small></label>
      <label class="fe-check mc-track"><input type="checkbox" data-role="track"${c.track ? " checked" : ""} /> Track opens and clicks</label>
      <small class="fe-note">Shows who opened it and which links they clicked, and lets you make a follow-up list from them.</small>
      <div data-role="checks"></div>
      <div class="lh-actions"><button type="button" class="btn-primary" data-act="schedule">Send now</button></div>
    </section>`;

  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const stateEl = $("state");
  const rulesHost = $("rules");
  const tplOf = () => (templates || []).find((t) => t.id === c.templateId) || null;
  const later = () => root.querySelector('input[name="mc-when"]:checked').value === "later";

  /* ---------- Saving ---------- */
  const setState = (s, msg = "") => {
    stateEl.className = `fe-state is-${s}`;
    stateEl.textContent = s === "saving" ? "Saving…" : s === "dirty" ? "Unsaved changes" : s === "error" ? msg : "All changes saved";
  };
  async function save() {
    clearTimeout(timer);
    if (saving) await saving;
    if (!dirty) return true;
    dirty = false;
    setState("saving");
    saving = saveDraft(c, staff)
      .then(() => { setState(dirty ? "dirty" : "saved"); return true; })
      .catch((err) => {
        console.error("Save campaign failed:", err);
        dirty = true;
        setState("error", err && err.code === "permission-denied" ? "Not saved: no access" : "Not saved. Check your connection.");
        return false;
      })
      .finally(() => { saving = null; });
    return saving;
  }
  const touch = () => { dirty = true; setState("dirty"); clearTimeout(timer); timer = setTimeout(save, 900); refresh(); };

  /* ---------- What's done, and what's still needed ---------- */
  function problems() {
    const out = [];
    if (c.audience.mode !== "all") {
      const p = groupProblem(c.audience.rules, c.audience.mode === "rules");
      if (p) out.push(`To: ${p}.`);
    }
    if (!String(c.fromName || "").trim()) out.push("From: add a from name.");
    if (c.replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.replyTo.trim())) out.push("From: check the reply-to address.");
    if (!c.templateId || (templates && !tplOf())) out.push("Content: choose the email it sends.");
    const t = tplOf();
    if (!String(c.subject || "").trim() && !(t && t.subject)) out.push("Subject: add a subject line.");
    return out;
  }
  function refresh() {
    const t = tplOf();
    const p = problems();
    const done = {
      to: !p.some((x) => x.startsWith("To")), from: !p.some((x) => x.startsWith("From")),
      subject: !p.some((x) => x.startsWith("Subject")), content: !p.some((x) => x.startsWith("Content")), send: !p.length,
    };
    Object.keys(done).forEach((k) => {
      const el = root.querySelector(`[data-tick="${k}"]`);
      if (el) el.classList.toggle("is-done", done[k]);
    });
    const sum = (k, v) => { const el = root.querySelector(`[data-sum="${k}"]`); if (el) el.textContent = v; };
    const nOut = c.audience.exclude.length;
    sum("to", audText(c) + (lastCount ? ` · ${n0(sendCount())} patients` : "") + (nOut ? ` · ${n0(nOut)} left out by you` : ""));
    sum("from", `${c.fromName || "No name yet"}${c.replyTo ? ` · replies to ${c.replyTo}` : ""}`);
    sum("subject", c.subject || (t && t.subject ? `${t.subject} (from the template)` : "No subject yet"));
    sum("content", t ? t.name : c.templateId ? "That template has been deleted" : "No email chosen yet");
    sum("send", `${later() ? "Scheduled" : "Now"}${c.track ? " · tracking opens and clicks" : ""}`);
    const subj = root.querySelector('[data-k="subject"]');
    subj.placeholder = t && t.subject ? t.subject : "What's new at Dermedica";
    $("checks").innerHTML = p.length
      ? `<div class="mb-checks"><strong>Before sending</strong><ul>${p.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
      : `<div class="mb-checks is-ok">Ready to send${lastCount ? ` to ${n0(sendCount())} patients` : ""}. Send yourself a test first.</div>`;
  }

  /* ---------- The email ---------- */
  function drawTemplates() {
    const sel = $("tpl");
    const list = templates || [];
    const missing = c.templateId && !tplOf() ? `<option value="${esc(c.templateId)}" selected>${esc(c.templateName || "Deleted template")} (deleted)</option>` : "";
    sel.innerHTML = `<option value="">${list.length ? "Choose an email template…" : "No templates yet: make one in Email templates"}</option>${missing}${
      list.map((t) => `<option value="${esc(t.id)}"${t.id === c.templateId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}`;
    const t = tplOf();
    $("prev").innerHTML = t ? `<div class="mt-thumb mc-thumb"><div class="mt-thumb-in">${renderEmail(t)}</div></div>` : "";
    const edit = $("edit");
    edit.hidden = !t;
    if (t) edit.href = `#/tasks/marketing/templates/${encodeURIComponent(t.id)}`;
    refresh();
  }
  listTemplates()
    .then((l) => { templates = l; if (root.isConnected) drawTemplates(); })
    .catch((err) => { console.error(err); $("tpl").innerHTML = '<option value="">Couldn\'t load the templates</option>'; });

  /* ---------- Who it goes to ---------- */
  loadProductNames().catch(() => []).then((names) => {
    if (!root.isConnected) return;
    mountRuleBuilder(rulesHost, c.audience.rules, {
      names, only: CAMPAIGN_FIELDS, empty: c.audience.mode === "list" ? "No extra rules: the whole list." : "Add a rule to choose who it goes to.",
      onChange: () => { lastCount = null; drawCount(); touch(); },
    });
  });

  /* ---------- Who it goes to: count, see who, leave people out ---------- */
  const exIds = () => new Set(c.audience.exclude.map((x) => x.id));
  const people = () => (lastCount && Array.isArray(lastCount.people) ? lastCount.people : null);
  const leftOutOf = () => { const p = people(); if (!p) return 0; const s = exIds(); return p.filter((x) => s.has(x.id)).length; };
  const sendCount = () => (lastCount ? Math.max(0, Number(lastCount.count || 0) - leftOutOf()) : 0);
  const niceIso = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
  };
  const personHtml = (x, out) => `<li class="mc-person${out ? " is-out" : ""}">
    <span class="mc-person-main"><strong>${esc(x.name || "Unknown patient")}</strong>
      <small>${esc([x.email, x.last ? `last visit ${niceIso(x.last)}` : ""].filter(Boolean).join(" · "))}</small></span>
    <button type="button" class="lh-btn${out ? "" : " is-quiet"}" data-${out ? "incl" : "excl"}="${esc(x.id)}">${out ? "Include again" : "Leave out"}</button></li>`;

  function drawCount() {
    const out = $("count");
    const ex = c.audience.exclude;
    if (lastCount) {
      const res = lastCount;
      const x = res.excluded || {};
      const left = leftOutOf();
      const send = sendCount();
      const p = people();
      out.innerHTML = `<strong>${n0(send)} patient${send === 1 ? "" : "s"} will get this</strong>` +
        (left ? ` <span class="muted">· ${n0(res.count)} match, ${n0(left)} left out by you</span>` : "") +
        (res.partial ? ` <span class="muted">(checked ${n0(res.checked)} of ${n0(res.total)}; the full list is worked out when it sends)</span>` : "") +
        (p ? ` <button type="button" class="lh-btn is-quiet" data-act="who">${showWho ? "Hide the list" : "See who"}</button>` : "") +
        `<small class="muted mc-excl">Not included: ${n0(x.optedOut)} on the do-not-contact list, ${n0(x.noEmail)} with no email address${
          x.shared ? `, ${n0(x.shared)} sharing an address with another patient` : ""}.${
          !p && res.sample && res.sample.length ? ` For example: ${esc(res.sample.slice(0, 6).join(", "))}.` : ""}${
          !p ? " (Seeing everyone by name needs the latest Apps Script version.)" : ""}</small>`;
    } else {
      out.textContent = "";
    }
    // Left out by hand: shown even before counting
    $("excl").innerHTML = ex.length && !showWho
      ? `<p class="mc-exnote">${n0(ex.length)} patient${ex.length === 1 ? "" : "s"} left out by you · <button type="button" class="lh-btn is-quiet" data-act="who">Manage</button></p>`
      : "";
    drawWho();
  }

  function drawWho() {
    const box = $("who");
    box.hidden = !showWho;
    if (!showWho) { box.innerHTML = ""; return; }
    if (!box.querySelector('[data-role="who-q"]')) {   // built once, so the search box keeps its place while you type
      box.innerHTML = `<div class="mc-who-head">
          <input type="search" class="fe-input" data-role="who-q" placeholder="Find a patient by name or email" aria-label="Find a patient" value="${esc(whoQ)}" />
          <button type="button" class="lh-btn is-quiet" data-act="who">Close</button></div>
        <div data-role="who-list"></div>`;
    }
    drawWhoList();
  }

  function drawWhoList() {
    const list = $("who").querySelector('[data-role="who-list"]');
    if (!list) return;
    const q = whoQ.trim().toLowerCase();
    const hit = (x) => !q || `${x.name || ""} ${x.email || ""}`.toLowerCase().includes(q);
    const s = exIds();
    const out = c.audience.exclude.filter(hit);
    const p = people();
    const rows = p ? p.filter((x) => !s.has(x.id) && hit(x)) : [];
    const more = rows.length - whoShown;
    list.innerHTML = `
      ${out.length ? `<h5 class="mc-who-h">Left out by you (${n0(c.audience.exclude.length)})</h5>
        <ul class="mc-people">${out.map((x) => personHtml(x, true)).join("")}</ul>` : ""}
      ${p ? `<h5 class="mc-who-h">Will get this (${n0(p.length - leftOutOf())}${lastCount.peopleMore ? "+" : ""})</h5>
        ${rows.length ? `<ul class="mc-people">${rows.slice(0, whoShown).map((x) => personHtml(x, false)).join("")}</ul>`
          : `<p class="muted">${q ? "Nobody matches that search." : "Nobody left on the list."}</p>`}
        ${more > 0 ? `<button type="button" class="lh-btn is-quiet" data-act="who-more">Show ${n0(Math.min(100, more))} more · ${n0(more)} not shown yet</button>` : ""}
        ${lastCount.peopleMore ? `<p class="fe-note">Another ${n0(lastCount.peopleMore)} match but aren't listed here. Narrow the rules to see them.</p>` : ""}`
      : '<p class="fe-note">Press Count patients to see everyone who matches.</p>'}`;
  }

  function leaveOut(id) {
    if (c.audience.exclude.some((x) => x.id === id)) return;
    if (c.audience.exclude.length >= MAX_EXCLUDE) { showToast(`Up to ${MAX_EXCLUDE} patients can be left out. Use a rule instead.`); return; }
    const p = (people() || []).find((x) => x.id === id);
    if (!p) return;
    c.audience.exclude = [...c.audience.exclude, { id: p.id, name: p.name || "", email: String(p.email || "").toLowerCase() }];
    touch();
    drawCount();
  }
  function includeAgain(id) {
    c.audience.exclude = c.audience.exclude.filter((x) => x.id !== id);
    touch();
    drawCount();
  }

  async function count() {
    const p = c.audience.mode !== "all" ? groupProblem(c.audience.rules, c.audience.mode === "rules") : "";
    if (p) { showToast(p); return; }
    const btn = root.querySelector('[data-act="count"]');
    const out = $("count");
    btn.disabled = true;
    out.innerHTML = '<span class="muted">Counting… this can take a minute with rules</span>';
    try {
      const res = await callApi({ action: "marketing", op: "campaignCount", campaignId: c.id, withPeople: true,
        audience: { mode: c.audience.mode, rules: cleanGroup(c.audience.rules), list: cleanList(c.audience.list) } });
      if (res.problem) { out.innerHTML = `<span class="du-warn">${esc(res.problem)}</span>`; return; }
      lastCount = res;
      whoShown = 100;
      drawCount();
      refresh();
    } catch (err) {
      out.innerHTML = `<span class="du-warn">${esc(errText(err, "Couldn't count. Try again."))}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Test ---------- */
  function sendTest() {
    const t = tplOf();
    if (!t) { showToast("Choose the email first."); return; }
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Send a test</h3><p>With this campaign's subject, starting with [Test]. Tests aren't tracked.</p></div>
        <label class="lh-field"><span class="lh-label">Send to</span>
          <textarea name="to" rows="3" placeholder="you@dermedica.com.au">${esc((staff && staff.email) || "")}</textarea>
          <small class="fe-note">Up to 5 addresses, one per line.</small></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Send test</button></div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const to = [...new Set((form.elements.to.value.match(EMAIL_RE) || []).map((x) => x.toLowerCase()))];
      if (!to.length || to.length > 5) { err.textContent = "Add 1 to 5 email addresses."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const res = await callApi({ action: "marketing", op: "testTemplate", templateId: t.id, to, subject: c.subject || "" });
        if (res.problem) throw new Error(res.problem);
        dlg.close();
        showToast(`Test sent to ${to.join(", ")}`);
      } catch (ex) {
        err.textContent = errText(ex, "Couldn't send the test.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  /* ---------- Send now / Schedule ---------- */
  async function schedule() {
    const p = problems();
    if (p.length) { showToast(p[0]); return; }
    let sendAt = "";
    if (later()) {
      const v = $("at").value;
      const ms = v ? new Date(v).getTime() : NaN;
      if (!(ms > Date.now() + 5 * 60000)) { showToast("Choose a time at least 5 minutes from now."); return; }
      sendAt = new Date(ms).toISOString();
    }
    if (!(await save())) { showToast("The latest changes couldn't be saved. Try again."); return; }
    const nOut = c.audience.exclude.length;
    const howMany = (lastCount ? `${n0(sendCount())} patients${lastCount.partial ? " or more" : ""}` : "everyone who matches when it's time") +
      (nOut ? ` (leaving out the ${n0(nOut)} you chose)` : "");
    const ok = await confirmDialog({
      title: later() ? `Schedule "${c.name}"?` : `Send "${c.name}" now?`,
      message: `It goes to ${howMany}, ${later() ? `starting ${when(new Date(sendAt))}` : "starting within 10 minutes"}, ` +
        `between 9 am and 6 pm, up to ${n0(c.dailyCap)} a day. You can pause or cancel it while it's sending.`,
      confirmLabel: later() ? "Schedule" : "Send now", tone: "primary",
    });
    if (!ok) return;
    const btn = root.querySelector('[data-act="schedule"]');
    btn.disabled = true;
    try {
      const res = await callApi({ action: "marketing", op: "campaignSchedule", campaignId: c.id, now: !later(), sendAt });
      if (res.problem) { showToast(res.problem); btn.disabled = false; return; }
      showToast(later() ? `Scheduled for ${when(new Date(res.sendAt))}` : "Sending starts within 10 minutes");
    } catch (err) {
      showToast(errText(err, "Couldn't schedule it. Try again."));
      btn.disabled = false;
    }
  }

  /* ---------- Events ---------- */
  root.addEventListener("input", (e) => {
    const el = e.target;
    if (el.closest(".mc-rules")) return; // the rule builder saves itself
    if (el.dataset.role === "who-q") { whoQ = el.value; whoShown = 100; drawWhoList(); return; }
    if (el.dataset.role === "name") { c.name = el.value; touch(); return; }
    if (el.dataset.k && el.tagName !== "SELECT") { c[el.dataset.k] = el.value; touch(); }
  });
  root.addEventListener("change", (e) => {
    const el = e.target;
    if (el.closest(".mc-rules")) return;
    if (el.name === "mc-aud") {
      c.audience.mode = audMode(el.value);
      rulesHost.hidden = c.audience.mode === "all";
      $("ruleshint").hidden = c.audience.mode !== "list";
      lastCount = null;
      drawCount();
      touch();
      return;
    }
    if (el.name === "mc-when") {
      $("at").hidden = !later();
      root.querySelector('[data-act="schedule"]').textContent = later() ? "Schedule" : "Send now";
      if (later() && !$("at").value) {
        const d = new Date(Date.now() + 86400000);
        $("at").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T09:00`;
      }
      refresh();
      return;
    }
    if (el.dataset.role === "track") { c.track = el.checked; touch(); return; }
    if (el.dataset.role === "tpl") {
      const t = (templates || []).find((x) => x.id === el.value);
      c.templateId = t ? t.id : "";
      c.templateName = t ? t.name : "";
      drawTemplates();
      touch();
      return;
    }
    if (el.dataset.k === "dailyCap") { c.dailyCap = Number(el.value) || 800; touch(); }
  });
  root.addEventListener("focusin", (e) => { if (e.target.dataset && e.target.dataset.k === "subject") tagTarget = e.target; });
  root.addEventListener("mousedown", (e) => { if (e.target.closest("[data-tag]")) e.preventDefault(); });
  root.addEventListener("click", async (e) => {
    const tag = e.target.closest("[data-tag]");
    if (tag) {
      const inp = tagTarget || root.querySelector('[data-k="subject"]');
      const at = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, at) + tag.dataset.tag + inp.value.slice(inp.selectionEnd ?? at);
      inp.focus();
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (e.target.closest('[data-role="edit"]')) { setBuilderBack(`${LIST_HREF}/${encodeURIComponent(c.id)}`); return; }
    if (e.target.closest('[data-act="who"]')) {
      showWho = !showWho;
      whoShown = 100;
      drawCount();
      if (showWho) { const f = root.querySelector('[data-role="who-q"]'); if (f) f.focus(); }
      return;
    }
    if (e.target.closest('[data-act="who-more"]')) { whoShown += 100; drawWhoList(); return; }
    const exb = e.target.closest("[data-excl]");
    if (exb) { leaveOut(exb.dataset.excl); return; }
    const inb = e.target.closest("[data-incl]");
    if (inb) { includeAgain(inb.dataset.incl); return; }
    if (e.target.closest('[data-act="count"]')) { count(); return; }
    if (e.target.closest('[data-act="test"]')) { sendTest(); return; }
    if (e.target.closest('[data-act="schedule"]')) { schedule(); return; }
    if (e.target.closest('[data-act="dup"]')) {
      try {
        await save();
        const nid = await createCampaign({ ...c, name: `Copy of ${c.name}`.slice(0, 120) }, staff);
        location.hash = `${LIST_HREF}/${encodeURIComponent(nid)}`;
      } catch (err) { showToast(errText(err, "Couldn't duplicate it.")); }
      return;
    }
    if (e.target.closest('[data-act="delete"]')) {
      const ok = await confirmDialog({ title: `Delete "${c.name}"?`, message: "The draft is removed from the list.", confirmLabel: "Delete", tone: "danger" });
      if (!ok) return;
      try {
        clearTimeout(timer);
        dirty = false;
        await updateDoc(doc(db, COL, c.id), { status: "archived", updatedAt: serverTimestamp(), updatedBy: who(staff), updatedByUid: me() });
        location.hash = LIST_HREF;
      } catch (err) { showToast(errText(err, "Couldn't delete it.")); }
    }
  });

  drawCount();
  refresh();
  return { close() { if (dirty) save(); clearTimeout(timer); } };
}

/* ---------- Scheduled, sending or sent: followed live ---------- */
const hasForm = (c) => /\/form\.html#f=/.test(c.html) || c.links.some((l) => /\/form\.html#f=/.test(l.url));
function reportHtml(c) {
  const s = c.stats;
  const sent = c.sent;
  const lists = [["opened", "Opened"], ["notOpened", "Didn't open"], ["clicked", "Clicked"], ["notClicked", "Didn't click"]];
  return `<h4 class="mc-h">Results</h4>
    <div class="mc-stats">
      ${c.track ? statLink("Opened", rate(s.opens, sent), `${n0(s.opens)} patients`, "opened") +
        statLink("Clicked", rate(s.clicks, sent), `${n0(s.clicks)} patients${s.opens ? ` · ${pct(s.clicks, s.opens)}% of those who opened` : ""}`, "clicked") : ""}
      ${hasForm(c) ? statLink("Filled in the form", rate(s.forms, sent), `${n0(s.forms)} patients`, "forms") : ""}
      ${statLink("Unsubscribed", rate(s.unsubscribes, sent), `${n0(s.unsubscribes)} patients`, "unsub")}
      ${statLink("Bounced", rate(s.bounces, sent), `${n0(s.bounces)} addresses`, "bounced")}
    </div>
    ${c.track
      ? '<p class="fe-note">Opens are a guide, not exact. Apple Mail loads every email\'s pictures by itself, which counts as an open, and some email apps block pictures, so those people only count once they click.</p>'
      : '<p class="fe-note">Opens and clicks weren\'t tracked for this campaign.</p>'}
    ${c.track && c.links.length ? `<h4 class="mc-h">Links</h4>
      <p class="fe-note">Click a link to see who clicked it.</p>
      <div class="mk-scroll"><table class="inv-table mc-links">
        <thead><tr><th>Link</th><th>Clicks</th><th></th></tr></thead>
        <tbody>${c.links.map((l, i) => `<tr class="mc-linkrow" data-wholink="${i}" title="See who clicked this">
          <td><strong>${esc(l.text || "Link")}</strong><small>${esc(host(l.url))}</small></td>
          <td><span class="mc-num">${n0(c.linkClicks[`l${i}`])}</span></td>
          <td class="mk-act"><button type="button" class="lh-btn" data-mklist="link" data-link="${i}">Make a list</button></td>
        </tr>`).join("")}</tbody></table></div>` : ""}
    ${c.track ? `<h4 class="mc-h">Make a list from this</h4>
      <p class="fe-note">Starts a new campaign for these patients. Its list is worked out when it sends, so anyone who opens or clicks before then is included.</p>
      <div class="mc-acts">${lists.map(([k, l]) => `<button type="button" class="lh-btn" data-mklist="${k}">${esc(l)}</button>`).join("")}</div>` : ""}`;
}
/* ---------- Who opened, clicked… (read when asked, from the campaign's results) ---------- */
const QUEUE_CHUNK = 250; // the same as MKT_CHUNK_ in Code.gs
const WHO_FILTERS = [
  ["sent", "Everyone sent", () => true],
  ["opened", "Opened", (x) => !!x.open],
  ["clicked", "Clicked", (x, link) => x.clicks.length > 0 && (link < 0 || x.clicks.includes(link))],
  ["forms", "Filled in the form", (x) => !!x.form],
  ["notOpened", "Didn't open", (x) => !x.open && !x.failed],
  ["unsub", "Unsubscribed", (x) => !!x.unsub],
  ["bounced", "Bounced", (x) => !!x.bounce],
];
const isoWhen = (v) => { const d = toDate(v); return d ? when(d) : ""; };
// "20 Oct, 1:58 pm" for the Who table
const shortWhen = (v) => {
  const d = toDate(v);
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
};

// Everyone the campaign reached, with what each of them did
async function loadWho(c) {
  const chunks = await Promise.all(Array.from({ length: c.chunks }, (_, i) => getDoc(doc(db, COL, c.id, "queue", `q${i}`))));
  const [opens, clicks, forms, unsubs, bounces] = await Promise.all(
    ["opens", "clicks", "forms", "unsubs", "bounces"].map(async (name) => {
      const m = new Map();
      (await getDocs(collection(db, COL, c.id, name))).forEach((d) => m.set(d.id, d.data() || {}));
      return m;
    }));
  const failed = new Set(c.failures.map((f) => String(f.patientId || "")));
  const rows = [];
  chunks.forEach((s, q) => {
    ((s.exists() && s.data().list) || []).forEach((r, j) => {
      if (q * QUEUE_CHUNK + j >= c.cursor) return;   // not reached yet
      const id = String(r.p || "");
      rows.push({
        id, name: String(r.n || "") || "Unknown patient", email: String(r.e || ""),
        open: opens.has(id) ? opens.get(id).at || "yes" : "",
        clicks: ((clicks.get(id) || {}).links || []).map(Number).sort((a, b) => a - b),
        form: forms.has(id), unsub: unsubs.has(id), bounce: bounces.has(id), failed: failed.has(id),
      });
    });
  });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function whoCsv(c, rows) {
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`;   // so Excel never runs it as a formula
    return `"${s.replace(/"/g, '""')}"`;
  };
  const link = (i) => (c.links[i] || {}).text || `Link ${i + 1}`;
  const lines = [["Name", "Email", "Opened", "Clicked", "Filled in the form", "Unsubscribed", "Bounced"],
    ...rows.map((x) => [x.name, x.email, x.open ? isoWhen(x.open) || "Yes" : "", x.clicks.map(link).join("; "),
      x.form ? "Yes" : "", x.unsub ? "Yes" : "", x.bounce ? "Yes" : ""])];
  const blob = new Blob(["\ufeff" + lines.map((l) => l.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${c.name.replace(/[\\/:*?"<>|]+/g, "-")} - results.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function mountView(page, c0, staff) {
  const root = document.createElement("div");
  page.replaceChildren(root);
  root.innerHTML = `
    ${BACK}
    <div class="mc-view">
      <div class="mc-main">
        <div class="mc-head">
          <div class="mc-title"><h2 data-v="name"></h2><div class="mc-sub" data-v="sub"></div></div>
          <span class="inv-spacer"></span>
          <div class="mc-acts" data-v="acts"></div>
        </div>
        <p class="mc-wait" data-v="wait" hidden></p>
        <section class="tb-card mc-prog" data-v="prog"></section>
        <section class="tb-card mc-report" data-v="report" hidden></section>
        <div class="mc-grid">
          <section class="tb-card"><h4 class="mc-h">Details</h4><dl class="mc-dl" data-v="dl"></dl></section>
          <section class="tb-card"><h4 class="mc-h">The email</h4>
            <iframe class="mc-frame" sandbox title="The email this campaign sends"></iframe>
            <small class="fe-note">Tags like {First name} are filled in for each patient.</small></section>
        </div>
        <section class="tb-card" data-v="fails" hidden></section>
      </div>
      <aside class="tb-card mc-whobox mc-side" data-v="whobox" aria-label="Who" hidden></aside>
    </div>`;
  const v = (k) => root.querySelector(`[data-v="${k}"]`);
  let c = c0;
  let frameSet = false;

  /* ---------- Who ---------- */
  const SIDE = window.matchMedia("(min-width: 1500px)");   // the list sits beside the page
  const who = { rows: null, f: c0.track ? "opened" : "sent", link: -1, q: "", busy: false, tried: false, shown: 200 };
  const whoRows = () => {
    const fn = (WHO_FILTERS.find((x) => x[0] === who.f) || WHO_FILTERS[0])[2];
    const q = who.q.trim().toLowerCase();
    return who.rows.filter((x) => fn(x, who.link) && (!q || `${x.name} ${x.email}`.toLowerCase().includes(q)));
  };
  // The result box or link row for what's showing is highlighted
  function markActive() {
    const on = !!who.rows;
    root.querySelectorAll(".mc-stat[data-whof]").forEach((b) =>
      b.classList.toggle("is-active", on && b.dataset.whof === who.f && who.link < 0));
    root.querySelectorAll("tr[data-wholink]").forEach((r) =>
      r.classList.toggle("is-active", on && who.f === "clicked" && Number(r.dataset.wholink) === who.link));
  }
  function drawWho() {
    const box = v("whobox");
    if (!who.rows) {
      box.innerHTML = `<h4 class="mc-h">Who</h4>
        <p class="fe-note">Click a result or a link to see each patient.</p>
        <button type="button" class="lh-btn" data-act="who-load"${who.busy ? " disabled" : ""}>${who.busy ? "Loading…" : "See who"}</button>`;
      return;
    }
    if (!box.querySelector('[data-role="who-q"]')) {   // built once, so the search box keeps its place while you type
      box.innerHTML = `<div class="mc-who-top"><h4 class="mc-h">Who</h4><span class="inv-spacer"></span>
          <button type="button" class="lh-btn is-quiet" data-act="who-load">Refresh</button>
          <button type="button" class="lh-btn is-quiet" data-act="who-csv">Download CSV</button></div>
        <div class="pt-tabs mc-filters" data-role="who-f" role="group" aria-label="Show"></div>
        <div class="mc-who-head">
          <select class="fb-select" data-role="who-link" aria-label="Which link" hidden></select>
          <input type="search" class="fe-input" data-role="who-q" placeholder="Find a patient by name or email" aria-label="Find a patient" />
        </div>
        <div class="mc-who-list" data-role="who-list"></div>`;
    }
    drawWhoList();
  }
  function drawWhoList() {
    const box = v("whobox");
    const form = hasForm(c);
    box.querySelector('[data-role="who-f"]').innerHTML = WHO_FILTERS
      .filter(([k]) => k !== "forms" || form)
      .map(([k, l, fn]) => `<button type="button" data-whof="${k}" class="${who.f === k ? "active" : ""}">${esc(l)} <em>${
        n0(who.rows.filter((x) => fn(x, -1)).length)}</em></button>`).join("");
    const sel = box.querySelector('[data-role="who-link"]');
    sel.hidden = !(who.f === "clicked" && c.links.length);
    sel.innerHTML = `<option value="-1">Any link</option>${c.links.map((l, i) =>
      `<option value="${i}"${who.link === i ? " selected" : ""}>${esc(l.text || `Link ${i + 1}`)}</option>`).join("")}`;
    const rows = whoRows();
    const linkText = (i) => esc((c.links[i] || {}).text || `Link ${i + 1}`);
    const dash = '<span class="muted">–</span>';
    const flags = (x) => [x.failed && "Couldn't send", x.bounce && "Bounced", x.unsub && "Unsubscribed"]
      .filter(Boolean).map((t) => `<span class="mc-pill is-cancel">${t}</span>`).join(" ");
    box.querySelector('[data-role="who-list"]').innerHTML = rows.length ? `
      <div class="mk-scroll"><table class="inv-table mc-whotable">
        <thead><tr><th>Patient</th><th>Opened</th><th>Clicked</th>${form ? "<th>Form</th>" : ""}<th></th></tr></thead>
        <tbody>${rows.slice(0, who.shown).map((x) => `<tr>
          <td><a href="#/patient/${encodeURIComponent(x.id)}"><strong>${esc(x.name)}</strong></a><small>${esc(x.email)}</small></td>
          <td>${x.open ? esc(shortWhen(x.open) || "Yes") : dash}</td>
          <td>${x.clicks.length ? x.clicks.map(linkText).join(", ") : dash}</td>
          ${form ? `<td>${x.form ? "✓" : ""}</td>` : ""}
          <td>${flags(x)}</td></tr>`).join("")}</tbody></table></div>
      ${rows.length > who.shown ? `<button type="button" class="lh-btn is-quiet" data-act="who-more">Show ${n0(Math.min(200, rows.length - who.shown))} more</button>` : ""}
      ${c.skipped ? `<p class="fe-note">${n0(c.skipped)} on this list unsubscribed before it reached them, so weren't sent it.</p>` : ""}`
      : `<p class="muted">${who.q ? "Nobody matches that search." : "Nobody here yet."}</p>`;
    markActive();
  }
  async function loadWhoNow() {
    if (who.busy) return;
    who.busy = true;
    who.tried = true;
    const btn = v("whobox").querySelector('[data-act="who-load"]');
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    try { who.rows = await loadWho(c); }
    catch (err) { console.error("Who failed:", err); showToast(errText(err, "Couldn't load the list. Try again.")); }
    finally {
      who.busy = false;
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = who.rows ? "Refresh" : "See who"; }
    }
    drawWho();
  }
  // A result box, a link row or a filter: show those patients
  async function showWho(f, link = -1) {
    who.f = f;
    who.link = link;
    who.shown = 200;
    if (who.rows) drawWhoList(); else await loadWhoNow();
    if (!SIDE.matches) v("whobox").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- Pause, cancel, make a list ---------- */
  const control = async (act) => {
    const msgs = {
      cancel: ["Cancel this campaign?", "It stops now. Emails already sent can't be taken back.", "Cancel campaign", "danger"],
      unschedule: ["Change this campaign?", "It goes back to a draft so you can change it, then schedule it again.", "Back to a draft", "primary"],
    };
    if (msgs[act]) {
      const [title, message, confirmLabel, tone] = msgs[act];
      if (!(await confirmDialog({ title, message, confirmLabel, tone }))) return;
    }
    try {
      const res = await callApi({ action: "marketing", op: "campaignControl", campaignId: c.id, act });
      if (res.problem) showToast(res.problem);
    } catch (err) { showToast(errText(err, "Couldn't do that. Try again.")); }
  };

  async function makeList(btn) {
    const kind = btn.dataset.mklist;
    const link = Number(btn.dataset.link) || 0;
    const label = kind === "link" ? ((c.links[link] || {}).text || "a link") : "";
    const resend = kind === "notOpened"; // usually the same email again
    btn.disabled = true;
    try {
      const nid = await createCampaign({
        name: `${c.name}: ${kind === "link" ? `clicked ${label}` : LIST_SHORT[kind]}`.slice(0, 120),
        templateId: resend ? c.templateId : "", templateName: resend ? c.templateName : "", subject: resend ? c.subject : "",
        fromName: c.fromName, replyTo: c.replyTo, dailyCap: c.dailyCap, track: true,
        audience: { mode: "list", rules: blankGroup(), list: { campaignId: c.id, kind, link, name: c.name, label } },
      }, staff);
      showToast("New campaign made from the list");
      location.hash = `${LIST_HREF}/${encodeURIComponent(nid)}`;
    } catch (err) {
      showToast(errText(err, "Couldn't make the list."));
      btn.disabled = false;
    }
  }

  /* ---------- Events ---------- */
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ctl]");
    if (b) { b.disabled = true; await control(b.dataset.ctl); if (b.isConnected) b.disabled = false; return; }
    const ml = e.target.closest("[data-mklist]");   // before the link row, so "Make a list" doesn't also open the list
    if (ml) { makeList(ml); return; }
    if (e.target.closest('[data-act="dup"]')) {
      try {
        const nid = await createCampaign({ ...c, track: true, name: `Copy of ${c.name}`.slice(0, 120) }, staff);
        location.hash = `${LIST_HREF}/${encodeURIComponent(nid)}`;
      } catch (err) { showToast(errText(err, "Couldn't duplicate it.")); }
      return;
    }
    if (e.target.closest('[data-act="who-load"]')) { loadWhoNow(); return; }
    if (e.target.closest('[data-act="who-csv"]')) { if (who.rows) whoCsv(c, whoRows()); return; }
    if (e.target.closest('[data-act="who-more"]')) { who.shown += 200; drawWhoList(); return; }
    const wf = e.target.closest("[data-whof]");
    if (wf) { showWho(wf.dataset.whof); return; }
    const wl = e.target.closest("[data-wholink]");
    if (wl) { showWho("clicked", Number(wl.dataset.wholink)); return; }
  });
  root.addEventListener("input", (e) => {
    if (e.target.dataset.role === "who-q") { who.q = e.target.value; who.shown = 200; drawWhoList(); }
  });
  root.addEventListener("change", (e) => {
    if (e.target.dataset.role === "who-link") { who.link = Number(e.target.value); who.shown = 200; drawWhoList(); }
  });

  function update(next) {
    c = next;
    v("name").textContent = c.name;
    const sub = c.status === "scheduled" ? `Sends ${when(new Date(c.sendAtMs))}`
      : c.status === "sent" ? (c.finishedAt ? `Finished ${when(c.finishedAt)}` : "Finished")
      : c.status === "cancelled" ? "Cancelled" : c.startedAt ? `Started ${when(c.startedAt)}` : "";
    v("sub").innerHTML = `${pill(c.status)} <span class="muted">${esc(sub)}</span>`;
    const btn = (act, label, cls = "btn-ghost") => `<button type="button" class="${cls}" data-ctl="${act}">${label}</button>`;
    v("acts").innerHTML = [
      c.status === "scheduled" ? btn("unschedule", "Change it") : "",
      ["scheduled", "building", "sending"].includes(c.status) ? btn("pause", "Pause") : "",
      c.status === "paused" ? btn("resume", "Resume", "btn-primary") : "",
      !["sent", "cancelled"].includes(c.status) ? btn("cancel", "Cancel") : "",
      '<button type="button" class="btn-ghost" data-act="dup">Duplicate</button>',
    ].join("");

    const wait = c.lastError ? `Problem: ${c.lastError}` : c.note || (["building", "sending"].includes(c.status) ? c.waiting : "");
    v("wait").textContent = wait;
    v("wait").hidden = !wait;
    v("wait").classList.toggle("is-bad", !!c.lastError);

    v("prog").innerHTML = c.status === "scheduled"
      ? `<p class="mc-big">Scheduled for <strong>${esc(when(new Date(c.sendAtMs)))}</strong>. The patients are chosen then, so anyone who unsubscribes before it goes is left out.</p>`
      : `${progressHtml(c)}<div class="mc-stats">
          ${statBox("Patients", n0(c.total || (c.status === "building" ? "…" : 0)))}
          ${c.sent ? statLink("Sent", n0(c.sent), "", "sent") : statBox("Sent", n0(c.sent))}
          ${statBox("Skipped", n0(c.skipped), "Unsubscribed before it reached them")}
          ${statBox("Couldn't send", n0(c.failed))}
        </div>${eta(c) ? `<p class="muted mc-eta">${esc(eta(c))}, sending up to ${n0(c.dailyCap)} a day between 9 am and 6 pm.</p>` : ""}`;

    const rep = v("report");
    rep.hidden = !(c.sent > 0);
    if (c.sent > 0) rep.innerHTML = reportHtml(c);

    // The Who list: shown (and loaded once) as soon as anything has been sent
    const wb = v("whobox");
    wb.hidden = !(c.sent > 0);
    if (c.sent > 0 && !wb.innerHTML) drawWho();
    if (c.sent > 0 && !who.rows && !who.busy && !who.tried) loadWhoNow();
    markActive();

    const row = (k, val) => (val ? `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>` : "");
    v("dl").innerHTML = row("To", audText(c)) + row("Email", c.templateName) + row("Subject", c.subject) +
      row("From", c.fromName) + row("Replies go to", c.replyTo) + row("Most a day", n0(c.dailyCap)) +
      row("Tracking", c.track ? "Opens and clicks" : "Off") +
      row("Left out by you", c.audience.exclude.length ? `${n0(c.audience.exclude.length)} patients` : "") +
      row("Scheduled by", c.scheduledBy) + row("Made by", c.createdBy);

    if (!frameSet && c.html) {
      // The links are swapped for each patient's own when it's sent; here they just don't go anywhere
      root.querySelector(".mc-frame").srcdoc = `<!doctype html><html><body style="margin:0">${c.html.replace(/__MKTL\d+__/g, "#")}</body></html>`;
      frameSet = true;
    }

    const fails = v("fails");
    fails.hidden = !c.failures.length;
    fails.innerHTML = c.failures.length ? `<h4 class="mc-h">Couldn't send (${n0(c.failed)})</h4>
      <ul class="mc-fails">${c.failures.slice().reverse().slice(0, 30).map((f) =>
        `<li><a href="#/patient/${encodeURIComponent(f.patientId || "")}">${esc(f.email || "")}</a> <span class="muted">${esc(f.error || "")}</span></li>`).join("")}</ul>` : "";
  }
  return { update };
}