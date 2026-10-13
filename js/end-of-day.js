// "End my day": the day pill in the top bar. Injectors count their kit (blind, typed from the labels);
// everyone answers the admin's questions.
import { getEndOfDaySettings, MOODS, answerText } from "./end-of-day-api.js";
import { listProducts, listKits, isKitProduct, getMyKitDay, saveKitDayEnd, listMyUsage, dayKey, plural } from "./inventory-api.js";
import { can } from "./perms.js";
import { escapeHtml, showToast } from "./utils.js";
import { openStartOfDayEdit } from "./start-of-day.js";
import { kitCountHtml, wireKitCount, readKitCount } from "./kit-count.js";

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
// "End my day" starts pulsing from this time (minutes after midnight): 17 * 60 = 5:00 pm
const NUDGE_FROM = 17 * 60;
let nudgeTimer = null;

// Pulse "End my day" in the evening, until the day is ended
function syncNudge() {
  if (!btn) return;
  const now = new Date();
  const on = !btn.classList.contains("is-done") && now.getHours() * 60 + now.getMinutes() >= NUDGE_FROM;
  btn.classList.toggle("is-nudge", on);
  if (!btn.classList.contains("is-done")) btn.title = on ? "Time to end your day" : "Finish your day";
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
  if (!b.dataset.bound) { b.dataset.bound = "1"; b.addEventListener("click", openEndOfDay); }
  return b;
}

export async function initEndOfDay(staff, { onLogout: lo } = {}) {
  me = staff;
  if (lo) onLogout = lo;
  const g = ++gen;
  btn = getButton();
  if (!btn || !staff) return;
  btn = getButton();
  if (!btn || !staff) return;
  clearInterval(nudgeTimer);
  nudgeTimer = setInterval(syncNudge, 60 * 1000);   // checked every minute
  try {
    const [cfg, day] = await Promise.all([getEndOfDaySettings(), getMyKitDay().catch(() => null)]);
    if (g !== gen) return;
    btn.hidden = !(cfg.who === "all" || staff.injector === true);
    setLabel(!!(day && day.end), day && day.end ? day.end.at : null);
  } catch (err) {
    console.warn("End of day setup failed:", err);
    if (g === gen) { btn.hidden = false; setLabel(false); }
  }
}

function setLabel(ended, at = null) {
  if (!btn) return;
  btn.classList.toggle("is-done", ended);
  btn.innerHTML = ended
    ? `${CHECK}<span>Day ended${at ? ` ${esc(timeOf(at))}` : ""}</span>`
    : `${MOON}<span>End my day</span>`;
  btn.title = ended ? "See what you entered today" : "Finish your day";
  syncNudge();
}
// On logout: hide (not remove) the button, so the next person to log in still has it
export function teardownEndOfDay() {
  gen++;
  me = null;
  clearInterval(nudgeTimer);
  nudgeTimer = null;
  if (btn) { btn.hidden = true; btn.innerHTML = ""; btn.classList.remove("is-done", "is-nudge"); }
  btn = null;
  document.querySelectorAll("dialog.eod-dlg").forEach((d) => d.remove());
}

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
  return products.filter((p) => isKitProduct(p) && (p.active || start.has(p.id))).map((p) => {
    const s = start.get(p.id) || null;
    const rows = (s && s.rows) || [];
    const r = rows.find((x) => x.inUse) || rows[0] || kits.find((k) => k.productId === p.id) || {};
    return { p, used: r1(used.get(p.id) || 0), start: s,
      batch: p.tracked ? r.batch || "" : "", expiry: p.tracked ? r.expiry || "" : "" };
  });
}



async function openEndOfDay() {
  const staff = me;
  if (!staff || document.querySelector("dialog.eod-dlg")) return; // one window at a time
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog eod-dlg";
  dlg.innerHTML = `<div class="lh-form"><div class="lh-dialog-head"><h3>End of day</h3><p>${esc(todayText())}</p></div>
    <div class="skeleton" style="height:220px;border-radius:12px"></div></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
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
  if (dlg.open) renderForm(dlg, staff, cfg, day, kit);
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

function renderForm(dlg, staff, cfg, day, kit) {
  const editLink = can("tasks.build") ? '<a class="eod-edit" href="#/tasks/end-of-day">Edit these questions</a>' : "";
  dlg.innerHTML = `<form class="lh-form eod-form" novalidate>
    <div class="lh-dialog-head"><h3>End of day</h3><p>${esc(todayText())} · Thanks for today, ${esc(firstName(staff.name))}.</p></div>
    ${staff.injector === true && day && day.start ? `<p class="eod-fix">Wrong count this morning?
      <button type="button" class="rc-link" data-act="sod-edit">Edit start of day</button></p>` : ""}
    ${kitHtml(kit)}
    ${cfg.questions.length ? `<section class="eod-sec">${kit.length ? "<h4>Your day</h4>" : ""}${cfg.questions.map(questionHtml).join("")}</section>` : ""}
    ${!kit.length && !cfg.questions.length ? '<p class="muted">Nothing to fill in. Just finish your day.</p>' : ""}
    <p class="lh-error" role="alert" hidden></p>
    <div class="lh-actions">
      ${editLink}
      <button type="button" class="lh-btn is-quiet" data-act="cancel">Not yet</button>
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