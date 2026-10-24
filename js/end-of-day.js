// "End my day": the day pill in the top bar. Injectors count their kit (blind, typed from the labels);
// everyone answers the admin's questions.
import { getEndOfDaySettings, MOODS, answerText } from "./end-of-day-api.js";
import { listProducts, listKits, isKitProduct, getMyKitDay, saveKitDayEnd, listMyUsage, dayKey, plural } from "./inventory-api.js";
import { can } from "./perms.js";
import { escapeHtml, showToast } from "./utils.js";
import { openStartOfDayEdit } from "./start-of-day.js";
import { kitCountHtml, wireKitCount, readKitCount, kitBatchOptions } from "./kit-count.js";
import { isRecorderBusy } from "./recorder.js";
import { myFinish, minToText, hhmmToMin } from "./shift.js";
import { callApi } from "./appointments.js";

const esc = (s) => escapeHtml(String(s ?? "")); // always text (ratings are numbers)
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const fmt = (n) => String(+Number(n || 0).toFixed(1));
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const normB = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const bl = (p) => p.batchLabel || "Batch";
const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const todayText = () => new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
const firstName = (n) => String(n || "").trim().replace(/^(dr|prof)\.?\s+/i, "").split(/\s+/)[0] || "there";
const off = (n) => Math.abs(Number(n) || 0) > 0.001;
const errText = (ex, fallback) => (ex && ex.code === "permission-denied"
  ? "Couldn't save. Check the Firestore rules for inv_kitdays have been published."
  : ex && ex.message && !ex.code ? ex.message : fallback);

let btn = null;
let me = null;
let onLogout = null;
let gen = 0;
let tick = null;
// started / ended today, and when this person finishes (minutes after midnight)
const st = { cfg: null, show: false, started: false, ended: false, finish: null, remind: 15, prompt: true, popup: true, planAt: 0, dayKey: "" };

const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const nudgeFrom = () => {
  const f = st.finish ?? hhmmToMin(st.cfg && st.cfg.finishTime) ?? 17 * 60 + 30;
  return f - st.remind;
};
// Closed without ending: asked again in a while (kept through a page refresh)
const snoozeKey = () => (me ? `eod-snooze:${me.uid}:${dayKey()}` : "");
const snoozedUntil = () => { try { return Number(localStorage.getItem(snoozeKey())) || 0; } catch { return 0; } };
function snooze(mins = 15) {
  if (!me) return;
  try { localStorage.setItem(snoozeKey(), String(Date.now() + mins * 60000)); } catch { /* storage blocked */ }
}

// Started today and not ended yet (for the logout check)
export const endOfDayPending = () => !!me && st.show && !st.ended;

// Pulse "End my day" from shortly before they finish, until the day is ended
function syncNudge() {
  if (!btn) return;
  const on = !st.ended && nowMin() >= nudgeFrom();
  btn.classList.toggle("is-nudge", on);
  if (!st.ended) btn.title = on ? "Time to end your day" : "Finish your day";
}

async function refreshDay() {
  st.dayKey = dayKey();
  st.planAt = 0;
  try {
    const day = await getMyKitDay();
    st.started = !!(day && (day.start || day.end));
    setLabel(!!(day && day.end), day && day.end ? day.end.at : null);
  } catch (err) { console.warn("Day check failed:", err); }
}

async function plan() {
  st.planAt = Date.now() + 15 * 60000;   // worked out again every 15 minutes (appointments and settings change)
  try { st.finish = (await myFinish(me, st.cfg)).finish; }
  catch (err) { console.warn("Finish time not worked out:", err); }
  try { const r = await callApi({ action: "staff", op: "mySchedule" }); st.popup = r.popup !== false; }
  catch (err) { console.warn("Pop-up setting not read:", err); }
}

// Opens End of day by itself once it's time, but never on top of another window or during a recording
function maybePrompt() {
  if (!endOfDayPending() || !st.prompt || !st.popup) return;   // clinic-wide setting, then this person's
  if (nowMin() < nudgeFrom() || Date.now() < snoozedUntil()) return;
  if (document.visibilityState !== "visible" || document.querySelector("dialog[open]")) return;
  if (isRecorderBusy()) return;
  openEndOfDay({ prompted: true });
}

async function tickFn() {
  const g = gen;
  if (!me) return;
  if (st.dayKey !== dayKey()) await refreshDay();   // after midnight
  if (Date.now() > st.planAt) await plan();
  if (g !== gen || !me) return;
  syncNudge();
  maybePrompt();
}

/* ---------- The day pill in the top bar ---------- */
// The button in index.html (#eod-btn), or one added to the top bar if it isn't there. Click handler bound once.
function getButton() {
  let b = document.getElementById("eod-btn");
  if (!b) {
    const host = document.querySelector(".tb-day, .topbar-right");
    if (!host) return null;
    b = document.createElement("button");
    b.type = "button";
    b.id = "eod-btn";
    b.className = "tb-pill";
    b.hidden = true;
    host.appendChild(b);
  }
  if (!b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", () => openEndOfDay()); }
  return b;
}

export async function initEndOfDay(staff, { onLogout: lo } = {}) {
  me = staff;
  if (lo) onLogout = lo;
  const g = ++gen;
  btn = getButton();
  if (!btn || !staff) return;
  clearInterval(tick);
  tick = setInterval(tickFn, 60 * 1000);   // checked every minute
  try {
    const [cfg, day] = await Promise.all([getEndOfDaySettings(), getMyKitDay().catch(() => null)]);
    if (g !== gen) return;
    Object.assign(st, {
      cfg, show: true, prompt: cfg.prompt !== false,   // End of day is for everyone; injectors also count their kit
      remind: Number(cfg.remindBefore) || 0, started: !!(day && (day.start || day.end)), dayKey: dayKey(), planAt: 0,
    });
    btn.hidden = !st.show;
    setLabel(!!(day && day.end), day && day.end ? day.end.at : null);
    tickFn();
  } catch (err) {
    console.warn("End of day setup failed:", err);
    if (g === gen) { btn.hidden = false; setLabel(false); }
  }
}

function setLabel(ended, at = null) {
  st.ended = ended;
  if (!btn) return;
  btn.classList.toggle("is-done", ended);
  btn.innerHTML = ended
    ? `${CHECK}<span>Day ended${at ? ` ${esc(timeOf(at))}` : ""}</span>`
    : `${MOON}<span>End my day</span>`;
  btn.title = ended ? "See what you entered today" : "Finish your day";
  syncNudge();
}

// Logging out before the day is ended: "end" | "logout" | "stay"
export function askEndBeforeLogout() {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog eod-ask";
    dlg.innerHTML = `<div class="lh-form">
      <div class="lh-dialog-head"><h3>You haven't ended your day</h3>
        <p>End it now before you log out? It only takes a minute${me && me.injector === true ? ", and tomorrow's kit count is checked against it" : ""}.</p></div>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-v="stay">Cancel</button>
        <button type="button" class="lh-btn" data-v="logout">Log out anyway</button>
        <button type="button" class="lh-btn is-primary" data-v="end">End my day</button>
      </div></div>`;
    let v = "stay";
    dlg.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) { v = b.dataset.v; dlg.close(); } });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(v); });
    document.body.appendChild(dlg);
    dlg.showModal();
    setTimeout(() => dlg.querySelector('[data-v="end"]').focus(), 30);
  });
}

// On logout: hide (not remove) the button, so the next person to log in still has it
export function teardownEndOfDay() {
  gen++;
  me = null;
  clearInterval(tick);
  tick = null;
  Object.assign(st, { cfg: null, show: false, started: false, ended: false, finish: null, popup: true, planAt: 0, dayKey: "" });
  if (btn) { btn.hidden = true; btn.innerHTML = ""; btn.classList.remove("is-done", "is-nudge"); }
  btn = null;
  document.querySelectorAll("dialog.eod-dlg, dialog.eod-ask").forEach((d) => d.remove());
}

window.addEventListener("kitday:changed", () => { if (me) refreshDay(); });

/* ---------- The window ---------- */

// Every active kit product (as at Start of Day). The batch and expiry are filled in from this morning
// (or the kit records), in case there are units left; the units are never filled in.
async function kitForEnd(day) {
  const [products, kits, usage] = await Promise.all([listProducts(), listKits({ mine: true }), listMyUsage(2).catch(() => [])]);
  const key = dayKey();
  const used = new Map();
  usage.filter((u) => u.at && dayKey(u.at) === key).forEach((u) => u.lines.forEach((l) => {
    if (l.kind === "kit") used.set(l.productId, (used.get(l.productId) || 0) + (Number(l.total) || 0));
  }));
  const start = new Map(((day && day.start && !day.start.notInjecting && day.start.items) || []).map((it) => [it.productId, it]));
  const list = products.filter((p) => isKitProduct(p) && (p.active || start.has(p.id))).map((p) => {
    const s = start.get(p.id) || null;
    const rows = (s && s.rows) || [];
    const r = rows.find((x) => x.inUse) || rows[0] || kits.find((k) => k.productId === p.id) || {};
    return { p, used: r1(used.get(p.id) || 0), start: s,
      batch: p.tracked ? r.batch || "" : "", expiry: p.tracked ? r.expiry || "" : "" };
  });
  // The batches to choose from (in my kit, then on the Shelf)
  const opts = await kitBatchOptions(list.map((k) => k.p))
    .catch((err) => { console.warn("Batch list not loaded:", err); return new Map(); });
  // This morning's batch is always in the list, even if the records say it's used up
  const norm = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return list.map((k) => {
    const options = [...(opts.get(k.p.id) || [])];
    if (k.p.tracked && k.batch && !options.some((o) => norm(o.batch) === norm(k.batch))) {
      options.unshift({ batch: k.batch, expiry: k.expiry || "", where: "kit" });
    }
    return { ...k, options };
  });
}



export async function openEndOfDay({ prompted = false } = {}) {
  const staff = me;
  if (!staff || document.querySelector("dialog.eod-dlg")) return; // one window at a time
  const lead = prompted
    ? (st.finish !== null && nowMin() < st.finish ? `You finish at ${minToText(st.finish)}. Time to end your day.` : "Time to end your day.")
    : "";
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog eod-dlg";
  dlg.innerHTML = `<div class="lh-form"><div class="lh-dialog-head"><h3>End of day</h3><p>${esc(lead || todayText())}</p></div>
    <div class="skeleton" style="height:220px;border-radius:12px"></div></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => {
    if (!st.ended) snooze(15);   // closed without ending: asked again in 15 minutes
    dlg.remove();
  });
  dlg.showModal();

  let cfg, day, kit = [];
  try {
    [cfg, day] = await Promise.all([getEndOfDaySettings(), getMyKitDay()]);
    setLabel(!!(day && day.end), day && day.end ? day.end.at : null); // also resets the label after midnight
    if (day && day.end) { if (dlg.open) summary(dlg, day); return; }
    if (cfg.kitCheck && staff.injector === true) kit = await kitForEnd(day);
  } catch (err) {
    console.error("End of day failed to load:", err);
    if (dlg.open) dlg.innerHTML = `<div class="lh-form"><div class="lh-dialog-head"><h3>End of day</h3></div>
      <p class="lh-error">${esc(errText(err, "Couldn't load. Check your connection and try again."))}</p>
      <div class="lh-actions"><button type="button" class="lh-btn" data-act="close">Close</button></div></div>`;
    dlg.querySelector('[data-act="close"]')?.addEventListener("click", () => dlg.close());
    return;
  }
  if (dlg.open) renderForm(dlg, staff, cfg, day, kit, lead);
}

// One row: batch and expiry (filled in, editable), and the counts (always empty)
const rowHtml = (p, r = null) => `<tr>
    ${p.tracked ? `<td><input class="fe-input sod-batch" data-f="batch" maxlength="40" autocomplete="off" spellcheck="false"
        aria-label="${esc(bl(p))} number" placeholder="From the label" value="${esc((r && r.batch) || "")}" /></td>
      <td><input class="fe-input sod-exp" type="date" data-f="expiry" aria-label="Expiry date" value="${esc((r && r.expiry) || "")}" /></td>` : ""}
    <td><input class="fe-input" type="number" min="0" step="1" inputmode="numeric" data-f="sealed" aria-label="Unopened" /></td>
    <td><div class="fe-num"><input class="fe-input" type="number" min="0" step="0.5" inputmode="decimal" data-f="open"
        aria-label="${esc(p.doseUnit)} left in the opened ${esc(p.stockUnit)}" /><span>${esc(p.doseUnit)}</span></div></td>
    <td><button type="button" class="hx-x" data-act="rm" aria-label="Remove this row" title="Remove">×</button></td>
  </tr>`;

// Blind: no start count, no units used. Those show after saving.
function kitHtml(kit) {
  if (!kit.length) return "";
  return `<section class="eod-sec"><h4>Your kit</h4>
    <p class="muted">Make sure every treatment today is saved first. Put 0 if you have none left.</p>
    <div class="kc-list">${kitCountHtml(kit)}</div></section>`;
}

function questionHtml(q, i) {
  const name = `q-${i}`;
  const head = `<legend class="eod-q-label">${esc(q.label)}${q.required ? ' <span class="eod-req" aria-label="required">*</span>' : ""}</legend>
    ${q.help ? `<small class="muted eod-q-help">${esc(q.help)}</small>` : ""}`;
  const pills = (vals) => `<div class="eod-pills">${vals.map(([v, l]) =>
    `<label class="eod-pill"><input type="radio" name="${name}" value="${esc(v)}" /><span>${esc(l)}</span></label>`).join("")}</div>`;
  let input;
  switch (q.type) {
    case "mood":
      input = `<div class="eod-moods">${MOODS.map(([v, e, l]) => `<label class="eod-mood"><input type="radio" name="${name}" value="${v}" />
        <span class="eod-face" aria-hidden="true">${e}</span><small>${esc(l)}</small></label>`).join("")}</div>`;
      break;
    case "rating": input = pills([1, 2, 3, 4, 5].map((n) => [n, n])); break;
    case "yesno": input = pills([["Yes", "Yes"], ["No", "No"]]); break;
    case "choice": input = `<div class="eod-choices">${q.options.map((o) =>
      `<label class="fe-check"><input type="radio" name="${name}" value="${esc(o)}" /> ${esc(o)}</label>`).join("")}</div>`; break;
    case "long": input = `<textarea class="fe-input" name="${name}" rows="3" maxlength="2000"></textarea>`; break;
    case "number": input = `<input class="fe-input eod-num" type="number" name="${name}" inputmode="decimal" />`; break;
    default: input = `<input class="fe-input" name="${name}" maxlength="300" />`;
  }
  return `<fieldset class="eod-q" data-q="${i}">${head}${input}</fieldset>`;
}

function readAnswer(form, q, i) {
  const name = `q-${i}`;
  if (["mood", "rating", "yesno", "choice"].includes(q.type)) {
    const c = form.querySelector(`input[name="${name}"]:checked`);
    if (!c) return "";
    return ["mood", "rating"].includes(q.type) ? Number(c.value) : c.value;
  }
  const el = form.elements[name];
  const v = el ? el.value.trim() : "";
  if (q.type === "number") return v === "" ? "" : Number(v);
  return v;
}

function renderForm(dlg, staff, cfg, day, kit, lead = "") {
  const editLink = can("tasks.build") ? '<a class="eod-edit" href="#/tasks/end-of-day">Edit these questions</a>' : "";
  dlg.innerHTML = `<form class="lh-form eod-form" novalidate>
    <div class="lh-dialog-head"><h3>End of day</h3><p>${esc(lead || `${todayText()} · Thanks for today, ${firstName(staff.name)}.`)}</p></div>
    ${staff.injector === true && day && day.start ? `<p class="eod-fix">Wrong count this morning?
      <button type="button" class="rc-link" data-act="sod-edit">Edit start of day</button></p>` : ""}
    ${kitHtml(kit)}
    ${cfg.questions.length ? `<section class="eod-sec">${kit.length ? "<h4>Your day</h4>" : ""}${cfg.questions.map(questionHtml).join("")}</section>` : ""}
    ${!kit.length && !cfg.questions.length ? '<p class="muted">Nothing to fill in. Just finish your day.</p>' : ""}
    <p class="lh-error" role="alert" hidden></p>
    <div class="lh-actions">
      ${editLink}
      <button type="button" class="lh-btn is-quiet" data-act="cancel">${lead ? "Remind me in 15 minutes" : "Not yet"}</button>
      <button type="submit" class="lh-btn" value="save">Save</button>
      ${onLogout ? '<button type="submit" class="lh-btn is-primary" value="logout">Save and log out</button>' : ""}
    </div></form>`;

  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  const showErr = (m, focus) => { err.textContent = m; err.hidden = !m; if (focus) focus.focus(); };
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  dlg.querySelector('[data-act="sod-edit"]')?.addEventListener("click", () => {
    dlg.close();
    setTimeout(() => openStartOfDayEdit(staff), 0);
  });
  dlg.querySelector(".eod-edit")?.addEventListener("click", () => dlg.close());
  form.addEventListener("input", () => showErr(""));
  wireKitCount(form);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const andLogout = e.submitter && e.submitter.value === "logout";

    // Kit: units remaining (and the batch and expiry when there are some)
    let items = [];
    if (kit.length) {
      const r = readKitCount(form, kit.map((k) => k.p));
      if (r.error) { showErr(r.error, r.focus); return; }
      items = r.items.map((it) => {
        const k = kit.find((x) => x.p.id === it.productId);
        return { ...it, productName: k.p.name, doseUnit: k.p.doseUnit, usedToday: k.used };
      });
    }

    // Questions
    const answers = [];
    for (let i = 0; i < cfg.questions.length; i++) {
      const q = cfg.questions[i];
      const v = readAnswer(form, q, i);
      if (q.required && (v === "" || (typeof v === "number" && !Number.isFinite(v)))) {
        showErr(`Please answer “${q.label}”.`, form.querySelector(`[data-q="${i}"] input, [data-q="${i}"] textarea`));
        return;
      }
      answers.push({ id: q.id, label: q.label, type: q.type, value: v, text: answerText(q, v) });
    }

    const btns = form.querySelectorAll('button[type="submit"]');
    btns.forEach((b) => { b.disabled = true; });
    if (e.submitter) e.submitter.textContent = "Saving…";
    try {
      const r = await saveKitDayEnd({ items, answers }, staff);
      setLabel(true, new Date());
      window.dispatchEvent(new Event("kitday:changed"));
      done(dlg, r, andLogout, day);
    } catch (ex) {
      console.error("End of day save failed:", ex);
      showErr(errText(ex, "Couldn't save. Check your connection and try again."));
      btns.forEach((b) => { b.disabled = false; b.textContent = b.value === "logout" ? "Save and log out" : "Save"; });
    }
  });

  const first = form.querySelector('[data-f="units"], .eod-q input, .eod-q textarea');
  if (first) setTimeout(() => first.focus(), 50);
}

// Shown after saving: now the numbers can be seen
function recapHtml(items, day) {
  if (!items.length) return "";
  const startOf = new Map(((day && day.start && day.start.items) || []).map((it) => [it.productId, it]));
  return `<ul class="eod-facts eod-recap">${items.map((it) => {
    const s = startOf.get(it.productId);
    return `<li><strong>${esc(it.productName)}</strong>: ${s ? `started with ${esc(fmt(s.counted))}, ` : ""}treatment records used ${
      esc(fmt(it.usedToday))}, ${esc(fmt(it.counted))} ${esc(it.doseUnit)} left now${
      off(it.variance) ? ' <span class="inv-flag is-warn">Difference sent for review</span>' : " ✓"}</li>`;
  }).join("")}</ul>`;
}

function done(dlg, r, andLogout, day) {
  if (andLogout) {
    dlg.close();
    showToast(r.differences ? "Day ended. A kit difference will be reviewed." : "Day ended. Have a lovely evening!");
    if (onLogout) onLogout();
    return;
  }
  dlg.innerHTML = `<div class="lh-form eod-done">
    <div class="lh-dialog-head"><h3>All done 🌙</h3><p>Thanks for today. Have a lovely evening!</p></div>
    ${r.items.length ? `<section class="eod-sec"><h4>Your kit today</h4>${recapHtml(r.items, day)}
      ${r.differences ? `<p class="tb-info">${esc(plural(r.differences, "difference"))} will be reviewed by an admin.</p>` : ""}</section>` : ""}
    <div class="lh-actions">
      <button type="button" class="lh-btn" data-act="close">Close</button>
      ${onLogout ? '<button type="button" class="lh-btn is-primary" data-act="logout">Log out</button>' : ""}
    </div></div>`;
  dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
  dlg.querySelector('[data-act="logout"]')?.addEventListener("click", () => { dlg.close(); onLogout(); });
}

// Already ended today: what they entered
function summary(dlg, day) {
  const e = day.end;
  const answers = e.answers.filter((a) => String(a.text || "").trim());
  dlg.innerHTML = `<div class="lh-form">
    <div class="lh-dialog-head"><h3>Day ended ✓</h3><p>${esc(todayText())}${e.at ? ` · at ${esc(timeOf(e.at))}` : ""}</p></div>
    ${e.items.length ? `<section class="eod-sec"><h4>Your kit today</h4>${recapHtml(e.items, day)}</section>` : ""}
    ${answers.length ? `<section class="eod-sec"><h4>Your answers</h4><dl class="eod-answers">${answers.map((a) =>
      `<dt>${esc(a.label)}</dt><dd>${esc(a.text)}</dd>`).join("")}</dl></section>` : ""}
    <div class="lh-actions"><button type="button" class="lh-btn" data-act="close">Close</button></div></div>`;
  dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
}