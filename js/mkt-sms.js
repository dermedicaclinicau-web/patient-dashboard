// Task Manager → Marketing → Campaigns: SMS campaigns (mkt_campaigns with channel "sms").
// Who it goes to comes from Recall (Code.gs → smscBuild_): open recall cards that match the filters, one text per mobile.
// Scheduling hands it to Apps Script, which makes the list when it's time and texts in batches through Textmagic,
// 8 am to 8 pm Perth. Every text ends with "Reply STOP to opt out." Results (delivered, replies, opt-outs, bookings)
// are added up by Apps Script (smscTally_) about every 20 minutes, or now with "Update now".
import { db, auth } from "./firebase-config.js";
import { collection, doc, addDoc, updateDoc, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { esc } from "./mkt-email.js";

const COL = "mkt_campaigns";
const LIST_HREF = "#/tasks/marketing/campaigns";
const BACK = `<a class="back-link" href="${LIST_HREF}">← Campaigns</a>`;
const STOP_LINE = "Reply STOP to opt out.";
const MAX_TEXT = 560;
const PACE_MINS = [[10, "10 minutes"], [20, "20 minutes"], [30, "30 minutes"], [60, "1 hour"]];
const PACE_DEFAULT = { n: 25, mins: 30 };
const DUE = [["any", "Any time"], ["just", "Just due · last 30 days"], ["over", "Overdue · 1 to 6 months"],
  ["lapsed", "Lapsed · over 6 months"], ["dates", "Choose dates…"]];
const SPEND = [["", "Any"], ["platinum", "Platinum"], ["gold", "Gold"], ["silver", "Silver"], ["pg", "Platinum or Gold"], ["none", "No tier"]];
const UNITS = [["days", "days"], ["weeks", "weeks"], ["months", "months"]];
const FILLS = [["{First name}", "Their first name"], ["{Treatment}", "Everything they're due for, e.g. anti-wrinkle and filler treatment"],
  ["{Months}", "Months since their last visit"], ["{Due date}", "When they were due"], ["{Last seen with}", "Who they last saw"],
  ["{Clinic phone}", "The clinic's number (Recall settings → Texts)"]];
const KNOWN = ["first name", "full name", "treatment", "main treatment", "months", "due date", "last visit", "last seen with", "clinic phone"];
// Why people weren't included, in the order Apps Script checks them
const OUT = [["hold", "on hold"], ["dnc", "on the do-not-contact list"], ["noMobile", "no mobile"], ["optedOut", "opted out of texts"],
  ["appt", "have an appointment booked"], ["flow", "in the Recall flow"], ["texted", "texted recently"],
  ["shared", "share a mobile with someone on the list"], ["leftOut", "left out by you"]];
const STATUS = {
  draft: ["Draft", "is-draft"], scheduled: ["Scheduled", "is-sched"], building: ["Getting ready", "is-live"],
  sending: ["Sending", "is-live"], paused: ["Paused", "is-paused"], sent: ["Sent", "is-sent"], cancelled: ["Cancelled", "is-cancel"],
};

/* ---------- Helpers ---------- */
const n0 = (v) => Number(v || 0).toLocaleString("en-AU");
const pct = (a, b) => (Number(b) > 0 ? Math.min(100, Math.round((Number(a || 0) / Number(b)) * 100)) : 0);
const rate = (n, of) => (Number(of) > 0 ? `${(Math.round((Number(n || 0) / Number(of)) * 1000) / 10).toLocaleString("en-AU")}%` : "–");
const toDate = (v) => {
  if (v && typeof v.toDate === "function") return v.toDate();
  if (typeof v === "string" && v) { const d = new Date(v); return isNaN(d) ? null : d; }
  return null;
};
const when = (d) => (d && !isNaN(d) ? d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const shortWhen = (v) => { const d = toDate(v); return d ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""; };
const dayText = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const mobileText = (m) => { const d = String(m || "").replace(/\D/g, ""); return /^04\d{8}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : String(m || ""); };
const minsText = (m) => (PACE_MINS.find(([x]) => x === m) || [0, `${m} minutes`])[1];
const whoOf = (staff) => String((staff && staff.name) || "").slice(0, 120);
const me = () => {
  const u = auth.currentUser && auth.currentUser.uid;
  if (!u) throw new Error("Your session has ended. Log in again.");
  return u;
};
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to campaigns. Check Marketing access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);
const pill = (s) => `<span class="mc-pill ${(STATUS[s] || STATUS.draft)[1]}">${esc((STATUS[s] || [s])[0])}</span>`;
const isDay = (k) => /^\d{4}-\d{2}-\d{2}$/.test(String(k || ""));

/* ---------- The text ---------- */
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";
export const withStop = (t) => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return /reply\s+stop/i.test(s) ? s : `${s}${s ? " " : ""}${STOP_LINE}`;
};
// How long it is, and how many texts it takes. One curly quote or emoji makes the whole text Unicode (70 a text).
export function smsLength(t) {
  let len = 0;
  const odd = [];
  for (const ch of t) {
    if (GSM.includes(ch)) len += 1;
    else if (GSM_EXT.includes(ch)) len += 2;
    else if (!odd.includes(ch)) odd.push(ch);
  }
  const uni = odd.length > 0;
  if (uni) len = t.length;
  const parts = len <= (uni ? 70 : 160) ? 1 : Math.ceil(len / (uni ? 67 : 153));
  return { len, parts, uni, odd };
}
const fill = (t, vals) => String(t || "").replace(/\{\s*([A-Za-z][A-Za-z ]{0,40}?)\s*\}/g, (m, k) => {
  const key = k.toLowerCase().replace(/\s+/g, " ");
  return vals && key in vals ? String(vals[key] ?? "") : m;
});
const unknownTags = (t) => [...String(t || "").matchAll(/\{\s*([^{}]{1,40}?)\s*\}/g)].map((m) => m[1])
  .filter((k) => !KNOWN.includes(k.toLowerCase().replace(/\s+/g, " ")) && !/^today\b/i.test(k));
const sampleVals = (phone) => ({
  "first name": "Sarah", "full name": "Sarah Smith", treatment: "anti-wrinkle treatment", "main treatment": "anti-wrinkle treatment",
  months: "5", "due date": dayText(new Date(Date.now() - 20 * 864e5).toISOString()), "last visit": "", "last seen with": "Dr Teh",
  "clinic phone": phone || "08 9000 0000",
});

/* ---------- The campaign ---------- */
export function cleanAud(a) {
  a = a || {};
  const d = a.due || {};
  const q = a.quiet || {};
  return {
    source: "recall",
    cats: [...new Set((Array.isArray(a.cats) ? a.cats : []).map(String))].slice(0, 20),
    due: { mode: DUE.some(([k]) => k === d.mode) ? d.mode : "any", from: isDay(d.from) ? d.from : "", to: isDay(d.to) ? d.to : "" },
    later: a.later === true,
    who: String(a.who || "any"), whoName: String(a.whoName || ""),
    spend: SPEND.some(([k]) => k === a.spend) ? a.spend : "",
    tag: String(a.tag || ""), tagName: String(a.tagName || ""),
    skipAppt: a.skipAppt !== false,
    skipFlow: a.skipFlow !== false,
    quiet: { on: q.on !== false, n: Math.max(1, Math.min(365, Math.floor(Number(q.n) || 30))),
      unit: UNITS.some(([k]) => k === q.unit) ? q.unit : "days" },
    exclude: (Array.isArray(a.exclude) ? a.exclude : []).filter((x) => x && x.m).slice(0, 500)
      .map((x) => ({ m: String(x.m), n: String(x.n || "").slice(0, 120) })),
  };
}
const cleanPace = (p) => {
  const n = Math.floor(Number(p && p.n) || 0);
  const mins = Number(p && p.mins) || 0;
  return n >= 10 && n <= 100 && PACE_MINS.some(([m]) => m === mins) ? { n, mins } : { ...PACE_DEFAULT };
};

export function normSms(snap) {
  const x = snap.data() || {};
  const st = x.stats && typeof x.stats === "object" ? x.stats : {};
  const num = (v) => Number(v) || 0;
  return {
    id: snap.id, channel: "sms", name: String(x.name || "Untitled campaign"),
    status: STATUS[x.status] ? String(x.status) : "draft",
    text: String(x.text || ""), audience: cleanAud(x.audience), pace: cleanPace(x.pace), weekdaysOnly: x.weekdaysOnly === true,
    sendAtMs: num(x.sendAtMs), total: num(x.total), sent: num(x.sent), skipped: num(x.skipped), failed: num(x.failed),
    stats: { delivered: num(st.delivered), undelivered: num(st.undelivered), pending: num(st.pending), replied: num(st.replied),
      yes: num(st.yes), other: num(st.other), optedOut: num(st.optedOut), booked: num(st.booked), tallyAt: String(st.tallyAt || "") },
    buildStats: x.buildStats && typeof x.buildStats === "object" ? x.buildStats : null,
    waiting: String(x.waiting || ""), lastError: String(x.lastError || ""), note: String(x.note || ""),
    startedAt: toDate(x.startedAt), finishedAt: toDate(x.finishedAt), updatedAt: toDate(x.updatedAt),
    createdBy: String(x.createdBy || ""), scheduledBy: String(x.scheduledBy || ""),
  };
}

export async function createSmsCampaign(base, staff) {
  const uid = me();
  const ref = await addDoc(collection(db, COL), {
    name: String(base.name || "").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled campaign",
    status: "draft", channel: "sms", text: String(base.text || "").slice(0, MAX_TEXT),
    audience: cleanAud(base.audience), pace: cleanPace(base.pace), weekdaysOnly: base.weekdaysOnly === true,
    createdAt: serverTimestamp(), createdBy: whoOf(staff), createdByUid: uid,
    updatedAt: serverTimestamp(), updatedBy: whoOf(staff), updatedByUid: uid,
  });
  return ref.id;
}

async function saveSms(c, staff) {
  await updateDoc(doc(db, COL, c.id), {
    name: String(c.name || "").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled campaign",
    text: String(c.text || "").slice(0, MAX_TEXT), audience: cleanAud(c.audience), pace: cleanPace(c.pace),
    weekdaysOnly: c.weekdaysOnly === true,
    updatedAt: serverTimestamp(), updatedBy: whoOf(staff), updatedByUid: me(),
  });
}

export function smsAudText(a) {
  const bits = [a.cats.length ? a.cats.join(", ") : "every recalled treatment"];
  if (a.due.mode === "dates") bits.push(`due ${[a.due.from && dayText(a.due.from), a.due.to && dayText(a.due.to)].filter(Boolean).join(" to ")}`);
  else if (a.due.mode !== "any") bits.push((DUE.find(([k]) => k === a.due.mode) || ["", ""])[1].toLowerCase());
  if (a.who === "none") bits.push("nobody given yet");
  else if (a.who !== "any") bits.push(`given to ${a.whoName || "someone"}`);
  if (a.spend) bits.push(`spend: ${(SPEND.find(([k]) => k === a.spend) || ["", ""])[1]}`);
  if (a.tag) bits.push(`tag: ${a.tagName || "a tag"}`);
  if (a.quiet.on) bits.push(`not texted in ${a.quiet.n} ${a.quiet.n === 1 ? a.quiet.unit.replace(/s$/, "") : a.quiet.unit}`);
  if (a.later) bits.push("including call-backs");
  if (!a.skipAppt) bits.push("including people with a booking");
  return `Recall · ${bits.join(" · ")}`;
}

function outText(s, leftOut) {
  const parts = OUT.filter(([k]) => (k === "leftOut" ? leftOut : s[k])).map(([k, l]) => `${n0(k === "leftOut" ? leftOut : s[k])} ${l}`);
  return parts.join(" · ");
}

/* ===================== A draft ===================== */

export function mountSmsDraft(page, c, staff) {
  const root = document.createElement("div");
  page.replaceChildren(root);
  let opts = null;
  let sample = null;
  let timer = 0;
  let dirty = false;
  let saving = null;
  let lastCount = null;
  let showWho = false;
  let whoQ = "";
  let whoShown = 100;
  let testTo = "";
  try { testTo = localStorage.getItem("mkt.smsTestTo") || ""; } catch { /* private mode */ }
  const stepHead = (key, title) => `<div class="mc-step-h"><span class="mc-tick" data-tick="${key}" aria-hidden="true"></span>
    <div><h4>${title}</h4><small class="muted" data-sum="${key}"></small></div></div>`;

  root.innerHTML = `
    ${BACK}
    <div class="mc-head">
      <input class="fe-name mc-name" data-role="name" maxlength="120" value="${esc(c.name)}" aria-label="Campaign name" />
      <span class="mc-pill is-sms">SMS</span>
      <span class="fe-state is-saved" data-role="state">All changes saved</span>
      <span class="inv-spacer"></span>
      <button type="button" class="btn-ghost" data-act="dup">Duplicate</button>
      <button type="button" class="btn-ghost" data-act="delete">Delete</button>
    </div>
    <div class="sc-warn" data-role="warn" hidden></div>

    <section class="tb-card mc-step">
      ${stepHead("to", "To: patients on Recall")}
      <div data-role="filters"><p class="muted">Loading Recall…</p></div>
      <div class="mc-count"><button type="button" class="lh-btn" data-act="count">Count patients</button><span data-role="count"></span></div>
      <div data-role="excl"></div>
      <div class="mc-who" data-role="who" hidden></div>
      <p class="fe-note">Always left out: anyone booked, on hold, on the do-not-contact list, with no mobile, or who replied STOP or
        opted out in Textmagic. People who share a mobile get one text between them, to whoever is most overdue. The list is made
        again when it starts sending, so anyone who books or opts out before then is left out.</p>
    </section>

    <section class="tb-card mc-step">
      ${stepHead("msg", "Message")}
      <div class="sc-msg">
        <div>
          <textarea class="fe-input sc-text" data-role="text" rows="5" maxlength="${MAX_TEXT}" aria-label="Text message"
            placeholder="Hi {First name}, it's Dermedica. You're due for your {Treatment}. Reply YES and we'll call you to book.">${esc(c.text)}</textarea>
          <div class="mb-tags"><small class="muted">Insert:</small>${FILLS.map(([t, h]) =>
            `<button type="button" class="ch-chip" data-fill="${esc(t)}" title="${esc(h)}">${esc(t)}</button>`).join("")}</div>
          <small class="fe-note" data-role="len"></small>
          <p class="fe-note">“${STOP_LINE}” is added to the end of every text. Replies go onto their recall card for the recall team,
            and YES replies are flagged “Wants to book”.</p>
          <div class="sc-test">
            <input class="fe-input" data-role="testTo" inputmode="tel" placeholder="Your mobile" value="${esc(testTo)}" aria-label="Send a test to" />
            <button type="button" class="lh-btn" data-act="test">Send a test</button>
          </div>
        </div>
        <div class="sc-phone"><div class="sc-phone-top" data-role="pvName"></div><div class="sc-bubble" data-role="pv"></div>
          <small class="muted" data-role="pvNote"></small></div>
      </div>
    </section>

    <section class="tb-card mc-step">
      ${stepHead("send", "Send")}
      <div class="mc-opts">
        <label class="mc-opt"><input type="radio" name="sc-when" value="now" checked />
          <span><strong>Send now</strong><small>Starts within 10 minutes, between 8 am and 8 pm</small></span></label>
        <label class="mc-opt"><input type="radio" name="sc-when" value="later" />
          <span><strong>Schedule</strong><small>Choose a day and time</small></span></label>
      </div>
      <input type="datetime-local" class="fe-input mc-at" data-role="at" hidden aria-label="Send on" />
      <div class="lh-field mc-pace"><span class="lh-label">Send in batches</span>
        <div class="mc-pace-row">
          <input type="number" class="fe-input" data-role="pace-n" min="10" max="100" step="5" inputmode="numeric" value="${c.pace.n}" aria-label="Texts in each batch" />
          <span>texts every</span>
          <select class="fb-select" data-role="pace-mins" aria-label="How often">${PACE_MINS.map(([m, l]) =>
            `<option value="${m}"${c.pace.mins === m ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        </div>
        <small class="fe-note" data-role="pace-note"></small></div>
      <label class="fe-check"><input type="checkbox" data-role="weekdays"${c.weekdaysOnly ? " checked" : ""} /> Weekdays only</label>
      <p class="fe-note">Texts only go out between 8 am and 8 pm Perth time. Anything left at 8 pm carries on at 8 am.</p>
      <div data-role="checks"></div>
      <div class="lh-actions"><button type="button" class="btn-primary" data-act="schedule">Send now</button></div>
    </section>`;

  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const later = () => root.querySelector('input[name="sc-when"]:checked').value === "later";

  /* ---------- Saving ---------- */
  const stateEl = $("state");
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
    saving = saveSms(c, staff)
      .then(() => { setState(dirty ? "dirty" : "saved"); return true; })
      .catch((err) => {
        console.error("Save SMS campaign failed:", err);
        dirty = true;
        setState("error", err && err.code === "permission-denied" ? "Not saved: no access" : "Not saved. Check your connection.");
        return false;
      })
      .finally(() => { saving = null; });
    return saving;
  }
  const touch = () => { dirty = true; setState("dirty"); clearTimeout(timer); timer = setTimeout(save, 900); refresh(); };

  /* ---------- Who it goes to ---------- */
  function drawFilters() {
    if (!opts) return;
    const a = c.audience;
    const opt = (list, cur) => list.map(([k, l]) => `<option value="${esc(k)}"${k === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
    $("filters").innerHTML = `
      <div class="sc-f"><span class="sc-f-l">Treatments</span><div class="sc-chips">
        <button type="button" class="rc-chip${!a.cats.length ? " is-on" : ""}" data-cat="">All</button>
        ${opts.categories.map((x) => `<button type="button" class="rc-chip${a.cats.includes(x.key) ? " is-on" : ""}" data-cat="${esc(x.key)}">${esc(x.key)}</button>`).join("")}
      </div></div>
      <div class="sc-grid">
        <div class="sc-f"><span class="sc-f-l">Due</span>
          <select class="fb-select" data-a="due.mode" aria-label="Due">${opt(DUE, a.due.mode)}</select>
          ${a.due.mode === "dates" ? `<span class="sc-dates">
            <input type="date" class="fe-input" data-a="due.from" value="${esc(a.due.from)}" aria-label="Due from" /><span>to</span>
            <input type="date" class="fe-input" data-a="due.to" value="${esc(a.due.to)}" aria-label="Due to" /></span>` : ""}</div>
        <label class="sc-f"><span class="sc-f-l">Given to</span>
          <select class="fb-select" data-a="who">${opt([["any", "Anyone"], ["none", "Nobody yet (waiting)"],
            ...opts.staff.map((s) => [s.id, s.team ? s.name : `${s.name} (not in the recall team)`])], a.who)}</select></label>
        <label class="sc-f"><span class="sc-f-l">Spend</span><select class="fb-select" data-a="spend">${opt(SPEND, a.spend)}</select></label>
        <label class="sc-f"><span class="sc-f-l">Tag</span>
          <select class="fb-select" data-a="tag">${opt([["", "Any"], ...opts.tags.map((t) => [t.id, t.label])], a.tag)}</select></label>
      </div>
      <div class="sc-quiet">
        <label class="fe-check"><input type="checkbox" data-a="quiet.on"${a.quiet.on ? " checked" : ""} /> Not texted in the last</label>
        <input type="number" class="fe-input sc-num" data-a="quiet.n" min="1" max="365" value="${a.quiet.n}" aria-label="How many" />
        <select class="fb-select" data-a="quiet.unit" aria-label="Days, weeks or months">${opt(UNITS, a.quiet.unit)}</select>
      </div>
      <small class="fe-note">Counts every text from the portal: Recall, the Recall flow, patient pages and other SMS campaigns.</small>
      <div class="sc-ticks">
        <label class="fe-check"><input type="checkbox" data-a="skipAppt"${a.skipAppt ? " checked" : ""} /> Leave out anyone with an appointment booked</label>
        <label class="fe-check"><input type="checkbox" data-a="skipFlow"${a.skipFlow ? " checked" : ""} /> Leave out anyone the Recall flow is texting</label>
        <label class="fe-check"><input type="checkbox" data-a="later"${a.later ? " checked" : ""} /> Include call-backs and paused recalls</label>
      </div>`;
  }

  const exSet = () => new Set(c.audience.exclude.map((x) => x.m));
  const people = () => (lastCount && Array.isArray(lastCount.people) ? lastCount.people : null);
  const leftOutOf = () => { const p = people(); if (!p) return 0; const s = exSet(); return p.filter((x) => s.has(x.m)).length; };
  const sendCount = () => (lastCount ? Math.max(0, Number(lastCount.count || 0) - leftOutOf()) : 0);
  const textParts = () => smsLength(withStop(fill(c.text, sample || sampleVals(opts && opts.phone)))).parts;

  function drawCount() {
    const out = $("count");
    if (lastCount) {
      const s = lastCount.stats || {};
      const rest = outText(s, leftOutOf());
      const parts = textParts();
      out.innerHTML = `<strong>${n0(s.matched)} on Recall match</strong>${rest ? ` · ${esc(rest)}` : ""} →
        <strong class="sc-will">${n0(sendCount())} will get it</strong>
        <button type="button" class="lh-btn is-quiet" data-act="who">${showWho ? "Hide the list" : "See who"}</button>
        <small class="muted mc-excl">About ${n0(sendCount() * parts)} texts from your Textmagic credit (${parts} per person).</small>`;
    } else {
      out.textContent = "";
    }
    const ex = c.audience.exclude;
    $("excl").innerHTML = ex.length && !showWho
      ? `<p class="mc-exnote">${n0(ex.length)} ${ex.length === 1 ? "person" : "people"} left out by you · <button type="button" class="lh-btn is-quiet" data-act="who">Manage</button></p>` : "";
    drawWho();
  }

  const personHtml = (x, out) => `<li class="mc-person${out ? " is-out" : ""}">
    <span class="mc-person-main"><strong>${esc(x.n || "Unknown patient")}</strong>
      <small>${esc([mobileText(x.m), x.cat && [x.cat, ...(x.also || [])].join(", "), x.due && `due ${dayText(x.due)}`].filter(Boolean).join(" · "))}</small></span>
    <button type="button" class="lh-btn${out ? "" : " is-quiet"}" data-${out ? "incl" : "excl"}="${esc(x.m)}">${out ? "Include again" : "Leave out"}</button></li>`;

  function drawWho() {
    const box = $("who");
    box.hidden = !showWho;
    if (!showWho) { box.innerHTML = ""; return; }
    if (!box.querySelector('[data-role="who-q"]')) {
      box.innerHTML = `<div class="mc-who-head">
          <input type="search" class="fe-input" data-role="who-q" placeholder="Find a patient by name or mobile" aria-label="Find a patient" value="${esc(whoQ)}" />
          <button type="button" class="lh-btn is-quiet" data-act="who">Close</button></div>
        <div data-role="who-list"></div>`;
    }
    drawWhoList();
  }
  function drawWhoList() {
    const list = $("who").querySelector('[data-role="who-list"]');
    if (!list) return;
    const q = whoQ.trim().toLowerCase();
    const qd = q.replace(/\D/g, "");
    const hit = (x) => !q || String(x.n || "").toLowerCase().includes(q) || (qd.length >= 3 && String(x.m).includes(qd));
    const s = exSet();
    const out = c.audience.exclude.filter(hit);
    const p = people();
    const rows = p ? p.filter((x) => !s.has(x.m) && hit(x)) : [];
    const more = rows.length - whoShown;
    list.innerHTML = `
      ${out.length ? `<h5 class="mc-who-h">Left out by you (${n0(c.audience.exclude.length)})</h5>
        <ul class="mc-people">${out.map((x) => personHtml(x, true)).join("")}</ul>` : ""}
      ${p ? `<h5 class="mc-who-h">Will get it (${n0(p.length - leftOutOf())}${lastCount.more ? "+" : ""})</h5>
        ${rows.length ? `<ul class="mc-people">${rows.slice(0, whoShown).map((x) => personHtml(x, false)).join("")}</ul>`
          : `<p class="muted">${q ? "Nobody matches that search." : "Nobody left on the list."}</p>`}
        ${more > 0 ? `<button type="button" class="lh-btn is-quiet" data-act="who-more">Show ${n0(Math.min(100, more))} more · ${n0(more)} not shown yet</button>` : ""}
        ${lastCount.more ? `<p class="fe-note">Another ${n0(lastCount.more)} match but aren't listed here.</p>` : ""}`
        : '<p class="fe-note">Press Count patients to see everyone who matches.</p>'}`;
  }

  async function count() {
    const a = c.audience;
    if (a.due.mode === "dates" && !a.due.from && !a.due.to) { showToast("Choose the due dates."); return; }
    const btn = root.querySelector('[data-act="count"]');
    const out = $("count");
    btn.disabled = true;
    out.innerHTML = '<span class="muted">Counting…</span>';
    try {
      const res = await callApi({ action: "marketing", op: "smsCount", audience: cleanAud(a) });
      if (res.problem) { out.innerHTML = `<span class="du-warn">${esc(res.problem)}</span>`; return; }
      lastCount = res;
      if (res.sample) sample = res.sample;
      whoShown = 100;
      drawCount();
      drawPreview();
      drawPace();
      refresh();
    } catch (err) {
      out.innerHTML = `<span class="du-warn">${esc(errText(err, "Couldn't count. Try again."))}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- The message ---------- */
  function drawPreview() {
    const vals = sample || sampleVals(opts && opts.phone);
    const full = withStop(fill(c.text, vals));
    $("pv").textContent = c.text.trim() ? full : "Your message appears here.";
    $("pvName").textContent = vals["full name"] || "";
    $("pvNote").textContent = sample ? "As the first person on the list gets it. Each person gets their own name and treatment."
      : "An example. Press Count patients to see it for a real patient.";
    const L = smsLength(full);
    const bad = unknownTags(c.text);
    $("len").innerHTML = `${n0(L.len)} characters · ${L.parts} text${L.parts === 1 ? "" : "s"} each (names vary a little)` +
      (L.uni ? ` · <span class="du-warn">${esc(L.odd.slice(0, 5).join(" "))} ${L.odd.length === 1 ? "isn't" : "aren't"} a standard text
        character, so each text holds 70 characters, not 160. Straight quotes ' " are fine.</span>` : "") +
      (bad.length ? ` · <span class="du-warn">{${esc(bad.join("}, {"))}} can't be filled in</span>` : "");
  }

  async function sendTest() {
    const to = $("testTo").value.trim();
    if (!to) { showToast("Type your mobile number first."); return; }
    try { localStorage.setItem("mkt.smsTestTo", to); } catch { /* private mode */ }
    const btn = root.querySelector('[data-act="test"]');
    btn.disabled = true;
    try {
      const res = await callApi({ action: "marketing", op: "smsTest", to, text: c.text, vals: sample || sampleVals(opts && opts.phone) });
      if (res.problem) { showToast(res.problem); return; }
      showToast(`Test sent to ${to}`);
    } catch (err) { showToast(errText(err, "Couldn't send the test.")); }
    finally { btn.disabled = false; }
  }

  /* ---------- Sending ---------- */
  function drawPace() {
    const perHour = Math.round((c.pace.n * 60) / c.pace.mins);
    const will = lastCount ? sendCount() : 0;
    const hrs = will ? Math.ceil(will / perHour) : 0;
    $("pace-note").textContent = `About ${n0(perHour)} texts an hour.` +
      (will ? ` ${n0(will)} people take about ${hrs <= 1 ? "an hour" : `${hrs} hours`} of sending${hrs > 12 ? `, over about ${Math.ceil(hrs / 12)} days` : ""}.` : "") +
      " Smaller batches mean replies come in at a pace the team can call back.";
  }

  function problems() {
    const out = [];
    const a = c.audience;
    const t = c.text.trim();
    if (opts && !opts.ready) out.push("Textmagic isn't set up yet. Add the Textmagic details in Apps Script → Script Properties.");
    if (opts && !opts.canSend) out.push('You can\'t send texts. Ask an admin to tick "Text patients from their page" for you in Staff.');
    if (a.due.mode === "dates" && !a.due.from && !a.due.to) out.push("To: choose the due dates.");
    if (t.length < 10) out.push("Message: write the message.");
    else if (!/dermedica/i.test(t)) out.push("Message: say it's from Dermedica. Every marketing text has to say who sent it.");
    const bad = unknownTags(t);
    if (bad.length) out.push(`Message: {${bad.join("}, {")}} isn't a tag it can fill in.`);
    return out;
  }

  function refresh() {
    const p = problems();
    const done = { to: !p.some((x) => x.startsWith("To")), msg: !p.some((x) => x.startsWith("Message")), send: !p.length };
    Object.keys(done).forEach((k) => { const el = root.querySelector(`[data-tick="${k}"]`); if (el) el.classList.toggle("is-done", done[k]); });
    const sum = (k, v) => { const el = root.querySelector(`[data-sum="${k}"]`); if (el) el.textContent = v; };
    sum("to", smsAudText(c.audience) + (lastCount ? ` · ${n0(sendCount())} people` : ""));
    sum("msg", c.text.trim() ? c.text.trim().slice(0, 90) + (c.text.trim().length > 90 ? "…" : "") : "No message yet");
    sum("send", `${later() ? "Scheduled" : "Now"} · ${c.pace.n} every ${minsText(c.pace.mins)}${c.weekdaysOnly ? " · weekdays only" : ""}`);
    $("checks").innerHTML = p.length
      ? `<div class="mb-checks"><strong>Before sending</strong><ul>${p.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
      : `<div class="mb-checks is-ok">Ready to send${lastCount ? ` to ${n0(sendCount())} people` : ""}. Send yourself a test first.</div>`;
    const warn = $("warn");
    warn.hidden = !(opts && !opts.ready);
    if (!warn.hidden) warn.textContent = "Textmagic isn't set up, so texts can't be sent yet. You can still build the campaign.";
  }

  async function schedule() {
    const p = problems();
    if (p.length) { showToast(p[0]); return; }
    let sendAt = "";
    if (later()) {
      const ms = $("at").value ? new Date($("at").value).getTime() : NaN;
      if (!(ms > Date.now() + 5 * 60000)) { showToast("Choose a time at least 5 minutes from now."); return; }
      sendAt = new Date(ms).toISOString();
    }
    if (!(await save())) { showToast("The latest changes couldn't be saved. Try again."); return; }
    const howMany = lastCount ? `about ${n0(sendCount())} people` : "everyone who matches when it's time";
    const ok = await confirmDialog({
      title: later() ? `Schedule "${c.name}"?` : `Send "${c.name}" now?`,
      message: `It texts ${howMany}, ${later() ? `starting ${when(new Date(sendAt))}` : "starting within 10 minutes"}, ` +
        `${c.pace.n} every ${minsText(c.pace.mins)}, between 8 am and 8 pm${c.weekdaysOnly ? " on weekdays" : ""}. ` +
        "Replies go to the recall team. You can pause or cancel it while it's sending.",
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
  const setA = (path, v) => {
    const ks = path.split(".");
    let o = c.audience;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = v;
  };
  const audChanged = (redraw) => { lastCount = null; showWho = false; if (redraw) drawFilters(); drawCount(); drawPace(); touch(); };

  root.addEventListener("input", (e) => {
    const el = e.target;
    const r = el.dataset.role;
    if (r === "name") { c.name = el.value; touch(); return; }
    if (r === "text") { c.text = el.value; drawPreview(); if (lastCount) drawCount(); touch(); return; }
    if (r === "who-q") { whoQ = el.value; whoShown = 100; drawWhoList(); return; }
    if (r === "pace-n") {
      const n = Math.round(Number(el.value));
      if (n >= 10 && n <= 100) { c.pace = { ...c.pace, n }; drawPace(); touch(); }
      return;
    }
    if (el.dataset.a === "quiet.n") {
      const n = Math.floor(Number(el.value));
      if (n >= 1 && n <= 365) { c.audience.quiet.n = n; audChanged(false); }
    }
  });
  root.addEventListener("change", (e) => {
    const el = e.target;
    const a = el.dataset.a;
    if (a) {
      if (a === "quiet.n") { el.value = c.audience.quiet.n; return; }
      setA(a, el.type === "checkbox" ? el.checked : el.value);
      if (a === "who") {
        const s = opts && opts.staff.find((x) => x.id === el.value);
        c.audience.whoName = s ? s.name : "";
      }
      if (a === "tag") {
        const t = opts && opts.tags.find((x) => x.id === el.value);
        c.audience.tagName = t ? t.label : "";
      }
      audChanged(a === "due.mode");
      return;
    }
    const r = el.dataset.role;
    if (r === "pace-mins") { c.pace = { ...c.pace, mins: Number(el.value) }; drawPace(); touch(); return; }
    if (r === "pace-n") {
      if (!(Number(el.value) >= 10 && Number(el.value) <= 100)) showToast("A batch can be 10 to 100 texts.");
      el.value = c.pace.n;
      return;
    }
    if (r === "weekdays") { c.weekdaysOnly = el.checked; touch(); return; }
    if (el.name === "sc-when") {
      $("at").hidden = !later();
      root.querySelector('[data-act="schedule"]').textContent = later() ? "Schedule" : "Send now";
      if (later() && !$("at").value) {
        const d = new Date(Date.now() + 86400000);
        $("at").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T10:00`;
      }
      refresh();
    }
  });
  root.addEventListener("mousedown", (e) => { if (e.target.closest("[data-fill]")) e.preventDefault(); });
  root.addEventListener("click", async (e) => {
    const cat = e.target.closest("[data-cat]");
    if (cat) {
      const k = cat.dataset.cat;
      const s = new Set(c.audience.cats);
      if (!k) s.clear(); else if (s.has(k)) s.delete(k); else s.add(k);
      c.audience.cats = [...s];
      audChanged(true);
      return;
    }
    const fl = e.target.closest("[data-fill]");
    if (fl) {
      const ta = $("text");
      const at = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, at) + fl.dataset.fill + ta.value.slice(ta.selectionEnd ?? at);
      ta.focus();
      ta.setSelectionRange(at + fl.dataset.fill.length, at + fl.dataset.fill.length);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const exb = e.target.closest("[data-excl]");
    if (exb) {
      if (c.audience.exclude.length >= 500) { showToast("Up to 500 people can be left out. Use a filter instead."); return; }
      const p = (people() || []).find((x) => x.m === exb.dataset.excl);
      if (p) { c.audience.exclude = [...c.audience.exclude, { m: p.m, n: p.n || "" }]; touch(); drawCount(); drawPace(); }
      return;
    }
    const inb = e.target.closest("[data-incl]");
    if (inb) { c.audience.exclude = c.audience.exclude.filter((x) => x.m !== inb.dataset.incl); touch(); drawCount(); drawPace(); return; }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const a = act.dataset.act;
    if (a === "who") { showWho = !showWho; whoShown = 100; drawCount(); return; }
    if (a === "who-more") { whoShown += 100; drawWhoList(); return; }
    if (a === "count") { count(); return; }
    if (a === "test") { sendTest(); return; }
    if (a === "schedule") { schedule(); return; }
    if (a === "dup") {
      try {
        await save();
        const nid = await createSmsCampaign({ ...c, name: `Copy of ${c.name}`.slice(0, 120) }, staff);
        location.hash = `${LIST_HREF}/${encodeURIComponent(nid)}`;
      } catch (err) { showToast(errText(err, "Couldn't duplicate it.")); }
      return;
    }
    if (a === "delete") {
      const ok = await confirmDialog({ title: `Delete "${c.name}"?`, message: "The draft is removed from the list.", confirmLabel: "Delete", tone: "danger" });
      if (!ok) return;
      try {
        clearTimeout(timer);
        dirty = false;
        await updateDoc(doc(db, COL, c.id), { status: "archived", updatedAt: serverTimestamp(), updatedBy: whoOf(staff), updatedByUid: me() });
        location.hash = LIST_HREF;
      } catch (err) { showToast(errText(err, "Couldn't delete it.")); }
    }
  });

  callApi({ action: "marketing", op: "smsOptions" })
    .then((r) => {
      if (!root.isConnected) return;
      if (r.problem) throw new Error(r.problem);
      opts = r;
      drawFilters();
      drawPreview();
      refresh();
    })
    .catch((err) => {
      if (root.isConnected) $("filters").innerHTML = `<p class="du-warn">${esc(errText(err, "Couldn't load Recall's treatments and team."))}</p>`;
    });
  drawPreview();
  drawPace();
  drawCount();
  refresh();
  return { close() { if (dirty) save(); clearTimeout(timer); } };
}

/* ===================== Scheduled, sending or sent ===================== */

const WHO = [
  ["sent", "Sent", (x) => x.st === "sent"],
  ["delivered", "Delivered", (x) => x.dl === "Delivered"],
  ["undelivered", "Not delivered", (x) => x.st === "failed" || x.dl === "Failed"],
  ["replied", "Replied", (x) => !!x.rp],
  ["yes", "Wants to book", (x) => !!x.rp && x.rp.kind === "yes"],
  ["stop", "Opted out", (x) => !!x.out],
  ["booked", "Booked", (x) => !!x.bk],
  ["skipped", "Skipped", (x) => x.st === "skipped"],
  ["queued", "Still to go", (x) => x.st === "queued" || x.st === "sending"],
];
const REPLY_NAME = { yes: "Wants to book", stop: "Replied STOP", other: "Replied" };

const statBox = (label, val, help = "") => `<div class="mc-stat"><small>${esc(label)}</small><strong>${val}</strong>${help ? `<em>${esc(help)}</em>` : ""}</div>`;
const statLink = (label, val, help, f) => `<button type="button" class="mc-stat is-link" data-whof="${f}" title="See who">` +
  `<small>${esc(label)}</small><strong>${val}</strong>${help ? `<em>${esc(help)}</em>` : ""}</button>`;

function whoCsv(c, rows) {
  const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const lines = [["Name", "Mobile", "Treatment", "Sent", "Delivery", "Reply", "Opted out", "Booked", "Note"],
    ...rows.map((x) => [x.n, mobileText(x.m), [x.cat, ...(x.also || [])].filter(Boolean).join(", "), shortWhen(x.at),
      x.st === "sent" ? x.dl || "Sent" : x.st, x.rp ? x.rp.text : "", x.out ? "Yes" : "", x.bk || "", x.why || ""])];
  const blob = new Blob(["\ufeff" + lines.map((l) => l.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${c.name.replace(/[\\/:*?"<>|]+/g, "-")} - texts.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function mountSmsView(page, c0, staff) {
  const root = document.createElement("div");
  page.replaceChildren(root);
  root.innerHTML = `
    ${BACK}
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
      <section class="tb-card"><h4 class="mc-h">The text</h4>
        <div class="sc-phone"><div class="sc-bubble" data-v="text"></div></div>
        <small class="fe-note">Tags like {First name} are filled in for each person.</small></section>
    </div>
    <section class="tb-card mc-whobox" data-v="whobox" hidden></section>`;
  const v = (k) => root.querySelector(`[data-v="${k}"]`);
  let c = c0;
  const who = { rows: null, f: "sent", q: "", busy: false, tried: false, shown: 200 };

  /* ---------- Who ---------- */
  async function loadWho() {
    if (who.busy) return;
    who.busy = true;
    who.tried = true;
    try {
      const snap = await getDocs(collection(db, COL, c.id, "sms"));
      who.rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.i || 0) - (b.i || 0));
    } catch (err) {
      console.error("SMS recipients failed:", err);
      showToast(errText(err, "Couldn't load who it went to."));
    } finally {
      who.busy = false;
    }
    drawWho();
  }
  function drawWho() {
    const box = v("whobox");
    if (!who.rows) {
      box.innerHTML = `<h4 class="mc-h">Who</h4><button type="button" class="lh-btn" data-act="who-load"${who.busy ? " disabled" : ""}>${who.busy ? "Loading…" : "See who"}</button>`;
      return;
    }
    if (!box.querySelector('[data-role="who-q"]')) {
      box.innerHTML = `<div class="mc-who-top"><h4 class="mc-h">Who</h4><span class="inv-spacer"></span>
          <button type="button" class="lh-btn is-quiet" data-act="who-load">Refresh</button>
          <button type="button" class="lh-btn is-quiet" data-act="who-csv">Download CSV</button></div>
        <div class="pt-tabs mc-filters" data-role="who-f" role="group" aria-label="Show"></div>
        <div class="mc-who-head"><input type="search" class="fe-input" data-role="who-q" placeholder="Find a patient by name or mobile" aria-label="Find a patient" /></div>
        <div data-role="who-list"></div>`;
    }
    drawWhoList();
  }
  const whoRows = () => {
    const fn = (WHO.find((x) => x[0] === who.f) || WHO[0])[2];
    const q = who.q.trim().toLowerCase();
    const qd = q.replace(/\D/g, "");
    return who.rows.filter((x) => fn(x) && (!q || String(x.n || "").toLowerCase().includes(q) || (qd.length >= 3 && String(x.m).includes(qd))));
  };
  function drawWhoList() {
    const box = v("whobox");
    box.querySelector('[data-role="who-f"]').innerHTML = WHO.map(([k, l, fn]) => {
      const n = who.rows.filter(fn).length;
      return n || k === "sent" ? `<button type="button" data-whof="${k}" class="${who.f === k ? "active" : ""}">${esc(l)} <em>${n0(n)}</em></button>` : "";
    }).join("");
    const rows = whoRows();
    const dash = '<span class="muted">–</span>';
    const delivery = (x) => (x.st === "failed" ? '<span class="mc-pill is-cancel">Not sent</span>'
      : x.st === "skipped" ? '<span class="mc-pill is-draft">Skipped</span>'
      : x.st === "queued" || x.st === "sending" ? '<span class="muted">Still to go</span>'
      : x.dl === "Delivered" ? '<span class="mc-pill is-sent">Delivered</span>'
      : x.dl === "Failed" ? '<span class="mc-pill is-cancel">Not delivered</span>' : '<span class="muted">Sent</span>');
    box.querySelector('[data-role="who-list"]').innerHTML = rows.length ? `
      <div class="mk-scroll"><table class="inv-table mc-whotable">
        <thead><tr><th>Patient</th><th>Sent</th><th>Delivery</th><th>Reply</th><th>Booked</th></tr></thead>
        <tbody>${rows.slice(0, who.shown).map((x) => `<tr>
          <td>${x.p ? `<a href="#/patient/${encodeURIComponent(x.p)}"><strong>${esc(x.n || "Patient")}</strong></a>` : `<strong>${esc(x.n || "Patient")}</strong>`}
            <small>${esc([mobileText(x.m), [x.cat, ...(x.also || [])].filter(Boolean).join(", ")].filter(Boolean).join(" · "))}</small></td>
          <td>${x.at ? esc(shortWhen(x.at)) : dash}</td>
          <td>${delivery(x)}${x.why ? `<small>${esc(x.why)}</small>` : ""}</td>
          <td>${x.rp ? `<span class="mc-pill ${x.rp.kind === "yes" ? "is-yes" : x.rp.kind === "stop" ? "is-cancel" : "is-sched"}">${esc(REPLY_NAME[x.rp.kind] || "Replied")}</span>
            <small class="sc-rp">${esc(x.rp.text || "")}</small>` : x.out ? '<span class="mc-pill is-cancel">Opted out</span>' : dash}</td>
          <td>${x.bk ? `✓ ${esc(dayText(x.bk))}` : dash}</td></tr>`).join("")}</tbody></table></div>
      ${rows.length > who.shown ? `<button type="button" class="lh-btn is-quiet" data-act="who-more">Show ${n0(Math.min(200, rows.length - who.shown))} more</button>` : ""}`
      : `<p class="muted">${who.q ? "Nobody matches that search." : "Nobody here yet."}</p>`;
    root.querySelectorAll(".mc-stat[data-whof]").forEach((b) => b.classList.toggle("is-active", b.dataset.whof === who.f));
  }

  /* ---------- Pause, cancel, update ---------- */
  const control = async (act) => {
    const msgs = {
      cancel: ["Cancel this campaign?", "It stops now. Texts already sent can't be taken back.", "Cancel campaign", "danger"],
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

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ctl]");
    if (b) { b.disabled = true; await control(b.dataset.ctl); if (b.isConnected) b.disabled = false; return; }
    const wf = e.target.closest("[data-whof]");
    if (wf) {
      who.f = wf.dataset.whof;
      who.shown = 200;
      if (who.rows) drawWhoList(); else await loadWho();
      v("whobox").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const a = act.dataset.act;
    if (a === "who-load") { loadWho(); return; }
    if (a === "who-csv") { if (who.rows) whoCsv(c, whoRows()); return; }
    if (a === "who-more") { who.shown += 200; drawWhoList(); return; }
    if (a === "tally") {
      act.disabled = true;
      try {
        const res = await callApi({ action: "marketing", op: "smsRefresh", campaignId: c.id });
        showToast(res.recent ? "Updated a moment ago. Try again in a couple of minutes." : "Results updated");
        if (who.rows) loadWho();
      } catch (err) { showToast(errText(err, "Couldn't update the results.")); }
      finally { if (act.isConnected) act.disabled = false; }
      return;
    }
    if (a === "dup") {
      try {
        const nid = await createSmsCampaign({ ...c, name: `Copy of ${c.name}`.slice(0, 120) }, staff);
        location.hash = `${LIST_HREF}/${encodeURIComponent(nid)}`;
      } catch (err) { showToast(errText(err, "Couldn't duplicate it.")); }
    }
  });
  root.addEventListener("input", (e) => {
    if (e.target.dataset.role === "who-q") { who.q = e.target.value; who.shown = 200; drawWhoList(); }
  });

  function update(next) {
    c = next;
    v("name").textContent = c.name;
    const sub = c.status === "scheduled" ? `Sends ${when(new Date(c.sendAtMs))}`
      : c.status === "sent" ? (c.finishedAt ? `Finished ${when(c.finishedAt)}` : "Finished")
      : c.status === "cancelled" ? "Cancelled" : c.startedAt ? `Started ${when(c.startedAt)}` : "";
    v("sub").innerHTML = `${pill(c.status)} <span class="mc-pill is-sms">SMS</span> <span class="muted">${esc(sub)}</span>`;
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

    const done = c.sent + c.skipped + c.failed;
    const left = c.total - done;
    const hrs = left > 0 ? Math.ceil(left / ((c.pace.n * 60) / c.pace.mins)) : 0;
    v("prog").innerHTML = c.status === "scheduled"
      ? `<p class="mc-big">Scheduled for <strong>${esc(when(new Date(c.sendAtMs)))}</strong>. The list is made then, so anyone who books or opts out before then is left out.</p>`
      : c.status === "building" ? '<p class="mc-big">Making the list…</p>'
      : `<div class="mc-bar"><span style="width:${pct(done, c.total)}%"></span></div>
        <small class="muted">${n0(c.sent)} of ${n0(c.total)} sent</small>
        <div class="mc-stats">
          ${statBox("People", n0(c.total))}
          ${c.sent ? statLink("Sent", n0(c.sent), "", "sent") : statBox("Sent", "0")}
          ${c.skipped ? statLink("Skipped", n0(c.skipped), "Booked, opted out or texted since the list was made", "skipped") : statBox("Skipped", "0")}
          ${c.failed ? statLink("Couldn't send", n0(c.failed), "", "undelivered") : statBox("Couldn't send", "0")}
        </div>
        ${["sending", "paused"].includes(c.status) && left > 0 ? `<p class="muted mc-eta">${n0(left)} still to go: about ${hrs <= 1 ? "an hour" : `${hrs} hours`}
          of sending at ${c.pace.n} every ${esc(minsText(c.pace.mins))}, between 8 am and 8 pm${c.weekdaysOnly ? " on weekdays" : ""}.</p>` : ""}`;

    const s = c.stats;
    const rep = v("report");
    rep.hidden = !(c.sent > 0);
    if (c.sent > 0) {
      rep.innerHTML = `<h4 class="mc-h">Results</h4>
        <div class="mc-stats">
          ${statLink("Delivered", rate(s.delivered, c.sent), `${n0(s.delivered)} texts${s.pending ? ` · ${n0(s.pending)} not confirmed yet` : ""}`, "delivered")}
          ${statLink("Replied", rate(s.replied, c.sent), `${n0(s.replied)} people`, "replied")}
          ${statLink("Wants to book", rate(s.yes, c.sent), `${n0(s.yes)} replied YES`, "yes")}
          ${statLink("Opted out", rate(s.optedOut, c.sent), `${n0(s.optedOut)} people`, "stop")}
          ${statLink("Booked", rate(s.booked, c.sent), `${n0(s.booked)} within 60 days`, "booked")}
          ${s.undelivered ? statLink("Not delivered", n0(s.undelivered), "Wrong or old numbers", "undelivered") : ""}
        </div>
        <p class="fe-note">${s.tallyAt ? `Updated ${esc(shortWhen(s.tallyAt))}.` : "The first results come within about 20 minutes."}
          <button type="button" class="lh-btn is-quiet" data-act="tally">Update now</button>
          A reply counts if it comes within 14 days of the text. Booked counts bookings within 60 days, from the appointment book or booked by phone in Recall.</p>`;
    }

    v("text").textContent = withStop(c.text);
    const b = c.buildStats;
    const row = (k, val) => (val ? `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>` : "");
    v("dl").innerHTML = row("To", smsAudText(c.audience)) +
      row("When the list was made", b ? `${n0(b.matched)} matched${outText(b, b.leftOut || 0) ? ` · ${outText(b, b.leftOut || 0)}` : ""} → ${n0(c.total)} texted` : "") +
      row("Left out by you", c.audience.exclude.length ? `${n0(c.audience.exclude.length)} people` : "") +
      row("Batches", `${c.pace.n} every ${minsText(c.pace.mins)}`) +
      row("Hours", `8 am to 8 pm${c.weekdaysOnly ? ", weekdays only" : ""}`) +
      row("Scheduled by", c.scheduledBy) + row("Made by", c.createdBy);

    const wb = v("whobox");
    const any = c.sent + c.skipped + c.failed > 0;
    wb.hidden = !any;
    if (any && !wb.innerHTML) drawWho();
    if (any && !who.rows && !who.busy && !who.tried) loadWho();
  }
  return { update };
}