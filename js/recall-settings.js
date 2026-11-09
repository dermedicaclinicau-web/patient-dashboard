// System configuration → Recall (#/settings/recall): intervals, the recall team, reasons for stopping and texts.
// Saved in recall_settings/config. Apps Script (Code.gs → Recall) reads it every time it checks.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";
import { loadTagLib, setTagLib, TAG_COLORS } from "./patient-tags.js";

// The same defaults as RECALL_CATS_ / RECALL_REASONS_ in Code.gs
export const RECALL_CATEGORIES = [["Wrinkle Relaxer", 4, true], ["Filler/Radiesse", 9, true], ["Laser/OPL/Peel", 6, true],
  ["RestoraGlow/RF/DermaGlow/Skin Needling", 6, true], ["Firm/Ulthera/eST", 9, true], ["Body Sculpting", 10, true],
  ["Other Injectables", 9, true], ["Hydrarepair/SkinRemod/CG", 6, false], ["Collagen activator", 6, false]];
export const RECALL_REASONS = [
  { label: "Not interested", askDate: false, dnc: false },
  { label: "Treated elsewhere", askDate: false, dnc: false },
  { label: "Pregnant or breastfeeding", askDate: true, dnc: false },
  { label: "Moved away", askDate: false, dnc: false },
  { label: "Don't contact again", askDate: false, dnc: true },
];

// Services that never count as a treatment visit (the same default as RECALL_SKIP_ in Code.gs)
export const RECALL_SKIP = ["Review", "Consult", "Touch up", "Top up", "Follow up"];

// What each treatment is called in texts (the same as RECALL_SMS_NAMES_ in Code.gs).
// Kept general on purpose: Australian advertising rules don't allow prescription medicines to be named.
export const RECALL_SMS_NAMES = {
  "Wrinkle Relaxer": "anti-wrinkle treatment", "Filler/Radiesse": "filler treatment", "Laser/OPL/Peel": "laser or peel treatment",
  "RestoraGlow/RF/DermaGlow/Skin Needling": "skin treatment", "Firm/Ulthera/eST": "skin tightening treatment",
  "Body Sculpting": "body sculpting treatment", "Other Injectables": "skin booster treatment",
  "Hydrarepair/SkinRemod/CG": "skin treatment", "Collagen activator": "collagen treatment",
};
export const RECALL_SMS_TEMPLATE = "Hi {First name}, it's Dermedica. It's been about {Months} months since your {Treatment}, " +
  "so you're due for your next one. Reply YES and we'll call you to book.";
// Offered on the Recall page straight after a call is logged as No answer or Left voicemail
export const RECALL_MISSED_TEMPLATE = "Hi {First name}, it's Dermedica. Sorry we missed you. You're due for your next {Treatment}. Reply YES to book.";
const SMS_TOKENS = ["{First name}", "{Treatment}", "{Months}", "{Clinic phone}"];
// The Settings | Flow | Email templates tabs (recall-flow.js and recall-emails.js use them too)
export const recallTabsHtml = (active) => `<nav class="mk-tabs" aria-label="Recall settings">${[
  ["settings", "#/settings/recall", "Settings"],
  ["flow", "#/settings/recall/flow", "Flow"],
  ["emails", "#/settings/recall/emails", "Email templates"],
].map(([k, href, l]) => `<a href="${href}"${active === k ? ' class="is-on" aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;

const STOP_LINE = "Reply STOP to opt out.";

export const skipNorm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const skipWords = (list) => {
  const seen = new Set();
  return list.map((w) => String(w ?? "").replace(/\s+/g, " ").trim().slice(0, 40))
    .filter((w) => { const k = skipNorm(w); return k.length >= 3 && !seen.has(k) && seen.add(k); })
    .slice(0, 40);
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return v !== "" && v != null && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const when = (v) => {
  const d = v && typeof v.toDate === "function" ? v.toDate() : new Date(v || "");
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to Recall settings. Check Recall access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);
const smsName = (key, v) => String(v || RECALL_SMS_NAMES[key] || "treatment").replace(/\s+/g, " ").trim().slice(0, 60);

export function normRecallSettings(x = {}) {
  const seen = new Set();
  const saved = Array.isArray(x.categories) && x.categories.length ? x.categories
    : RECALL_CATEGORIES.map(([key, months, on]) => ({ key, months, on }));
  const categories = saved
    .map((c) => {
      const key = String((c && c.key) || "").trim().slice(0, 80);
      return { key, months: int(c && c.months, 1, 36, 6), on: !(c && c.on === false), smsName: smsName(key, c && c.smsName) };
    })
    .filter((c) => c.key && !seen.has(c.key) && seen.add(c.key));
  RECALL_CATEGORIES.forEach(([key, months]) => {
    if (!seen.has(key)) { seen.add(key); categories.push({ key, months, on: false, smsName: smsName(key) }); }
  });
  const reasons = (Array.isArray(x.reasons) && x.reasons.length ? x.reasons : RECALL_REASONS)
    .map((r) => ({ label: String((r && r.label) || "").trim().slice(0, 60), askDate: !!(r && r.askDate), dnc: !!(r && r.dnc) }))
    .filter((r) => r.label).slice(0, 20);
  const sm = x.sms && typeof x.sms === "object" ? x.sms : {};
  const sp = x.spend && typeof x.spend === "object" ? x.spend : {};
  return {
    categories, maxAgeMonths: int(x.maxAgeMonths, 3, 60, 24), leadDays: int(x.leadDays, 0, 60, 0),
    anyFuturePauses: x.anyFuturePauses === true,
    team: Array.isArray(x.team) ? x.team.map(String).slice(0, 30) : [],
    perDay: int(x.perDay, 1, 100, 15), skipLeave: x.skipLeave !== false,
    reasons: reasons.length ? reasons : RECALL_REASONS.slice(),
    skipServices: skipWords(Array.isArray(x.skipServices) ? x.skipServices : RECALL_SKIP),
    // Spend tiers (Code.gs → recallSpend_): the top X% by spend in the last 12 months
    spend: {
      platinum: int(sp.platinum, 1, 50, 10), gold: int(sp.gold, 1, 60, 20), silver: int(sp.silver, 1, 80, 30),
      shareFirst: sp.shareFirst !== false,
    },
    sms: {
      on: sm.on === true,
      template: String(sm.template || RECALL_SMS_TEMPLATE).slice(0, 560),
      phone: String(sm.phone || "").slice(0, 30),
      waitDays: int(sm.waitDays, 1, 30, 7),
      perDay: int(sm.perDay, 1, 300, 30),
      missedMode: ["ask", "auto", "off"].includes(sm.missedMode) ? sm.missedMode : "ask",
      missedTemplate: String(sm.missedTemplate || RECALL_MISSED_TEMPLATE).slice(0, 560),
      missedQuiet: int(sm.missedQuiet, 1, 60, 7),
      saved: (Array.isArray(sm.saved) ? sm.saved : [])
        .map((m) => ({ name: String((m && m.name) || "").replace(/\s+/g, " ").trim().slice(0, 40), text: String((m && m.text) || "").slice(0, 560) }))
        .filter((m) => m.name && m.text.trim()).slice(0, 10),
    },
  };
}

const opts = (list, cur, label) => {
  const vals = list.includes(cur) ? list : [...list, cur].sort((a, b) => a - b);
  return vals.map((v) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(label(v))}</option>`).join("");
};

export async function mountRecallSettings(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page rs";
  root.innerHTML = '<div class="skeleton" style="height:420px;border-radius:14px"></div>';
  container.replaceChildren(root);

  let set, status, people, spendStatus, tagList;
  try {
    const [a, b, c, d, e] = await Promise.all([
      getDoc(doc(db, "recall_settings", "config")),
      getDoc(doc(db, "recall_settings", "status")),
      callApi({ action: "staffList" }).catch(() => ({ staff: [] })),
      getDoc(doc(db, "recall_settings", "spend_status")).catch(() => null),
      loadTagLib(true),
    ]);
    tagList = e;
    set = normRecallSettings(a.exists() ? a.data() : {});
    status = b.exists() ? b.data() : null;
    spendStatus = d && d.exists() ? d.data() : null;
    people = (c && Array.isArray(c.staff) ? c.staff : []).filter((s) => s && s.id);
  } catch (err) {
    console.error("Recall settings failed:", err);
    root.innerHTML = `<div class="state error"><strong>Couldn't open Recall settings</strong>${esc(errText(err, "Try again."))}</div>`;
    return;
  }
  let dirty = false;
  let services = null;      // the appointment book's services, loaded when asked
  let servicesBusy = false;
  let smsState = { text: "Checking Textmagic…", ok: null };
  let lastTpl = "smsTpl";   // the message box the blanks go into
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);

  const statusText = () => (status && status.at
    ? `Last checked ${when(status.at)}: ${Number(status.made || 0)} new, ${Number(status.booked || 0)} booked, ` +
      `${Number(status.visited || 0)} came in, ${Number(status.paused || 0)} paused (appointment booked), ${Number(status.texted || 0)} texted, ${Number(status.assigned || 0)} shared out.`
    : 'Not checked yet. Run installRecall once in Apps Script, or press "Check for due patients now".');

  const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-AU")}`;
  const spendText = () => {
    const s = spendStatus;
    if (!s || !s.at) return 'Not worked out yet. Press "Check for due patients now".';
    const c = s.counts || {}, f = s.from || {};
    const part = (k, l) => (c[k] ? `${l} from ${money(f[k])} (${Number(c[k]).toLocaleString()} patients)` : `${l}: nobody yet`);
    return `Last worked out ${when(s.at)}: ${part("platinum", "Platinum")} · ${part("gold", "Gold")} · ${part("silver", "Silver")}, ` +
      `out of ${Number(s.patients || 0).toLocaleString()} patients who spent anything in the last 12 months.`;
  };

  // What's on screen. keepEmpty keeps a new reason row while it's being typed.
  function collect(keepEmpty) {
    const seen = new Set();
    return {
      categories: [...root.querySelectorAll("[data-cat]")].map((r) => ({
        key: r.dataset.cat, on: r.querySelector('[data-f="on"]').checked, months: Number(r.querySelector('[data-f="months"]').value) || 6,
        smsName: smsName(r.dataset.cat, r.querySelector('[data-f="smsName"]').value),
      })),
      maxAgeMonths: Number($("maxAge").value) || 24,
      leadDays: Number($("lead").value) || 0,
      anyFuturePauses: $("pause").checked,
      team: [...root.querySelectorAll("[data-team]")].filter((i) => i.checked).map((i) => i.dataset.team),
      perDay: Number($("perDay").value) || 15,
      skipLeave: $("skipLeave").checked,
      spend: {
        platinum: Number($("spPlat").value) || 10, gold: Number($("spGold").value) || 20,
        silver: Number($("spSilver").value) || 30, shareFirst: $("spFirst").checked,
      },
      skipServices: [...root.querySelectorAll("[data-skip]")].map((el) => el.dataset.skip),
      reasons: [...root.querySelectorAll("[data-reason]")].map((r) => ({
        label: r.querySelector('[data-f="label"]').value.replace(/\s+/g, " ").trim().slice(0, 60),
        askDate: r.querySelector('[data-f="ask"]').checked, dnc: r.querySelector('[data-f="dnc"]').checked,
      })).filter((r) => keepEmpty || (r.label && !seen.has(r.label.toLowerCase()) && seen.add(r.label.toLowerCase()))),
      sms: {
        on: false,
        template: $("smsTpl").value.slice(0, 560) || RECALL_SMS_TEMPLATE,
        phone: $("smsPhone").value.replace(/[^\d +()-]/g, "").trim().slice(0, 30),
        waitDays: set.sms.waitDays,
        perDay: set.sms.perDay,
        missedMode: $("missedMode").value,
        missedTemplate: $("missedTpl").value.slice(0, 560) || RECALL_MISSED_TEMPLATE,
        missedQuiet: Number($("missedQuiet").value) || 7,
        saved: [...root.querySelectorAll("[data-saved]")].map((r) => ({
          name: r.querySelector('[data-f="sname"]').value.replace(/\s+/g, " ").trim().slice(0, 40),
          text: r.querySelector('[data-f="stext"]').value.slice(0, 560),
        })).filter((m) => keepEmpty || (m.name && m.text.trim())),
      },
    };
  }

  function setState() {
    const el = $("state");
    el.className = `fe-state is-${dirty ? "dirty" : "saved"}`;
    el.textContent = dirty ? "Unsaved changes" : "All changes saved";
  }

  /* ---------- Texts ---------- */
  function smsSample(role = "smsTpl") {
    const tpl = $(role) ? $(role).value : role === "missedTpl" ? set.sms.missedTemplate : set.sms.template;
    const phone = $("smsPhone") ? $("smsPhone").value.trim() : set.sms.phone;
    const firstOn = set.categories.find((c) => c.on) || set.categories[0];
    const nameInput = firstOn && root.querySelector(`[data-cat="${CSS.escape(firstOn.key)}"] [data-f="smsName"]`);
    let t = String(tpl || "")
      .replace(/\{\s*first name\s*\}/gi, "Sarah")
      .replace(/\{\s*treatment\s*\}/gi, smsName(firstOn ? firstOn.key : "", nameInput ? nameInput.value : firstOn && firstOn.smsName))
      .replace(/\{\s*months\s*\}/gi, String(firstOn ? firstOn.months : 4))
      .replace(/\{\s*clinic phone\s*\}/gi, phone || "")
      .replace(/\s+/g, " ").trim();
    if (!/reply\s+stop/i.test(t)) t += `${t ? " " : ""}${STOP_LINE}`;
    const parts = t.length <= 160 ? 1 : Math.ceil(t.length / 153);
    return { text: t, info: `${t.length} characters · ${parts} text${parts === 1 ? "" : "s"} each` };
  }
  function drawPreview() {
    [["smsTpl", "smsPreview"], ["missedTpl", "missedPreview"]].forEach(([tpl, out]) => {
      const el = $(out);
      if (!el) return;
      const p = smsSample(tpl);
      el.innerHTML = `<strong>Preview:</strong> ${esc(p.text)}<br><small>${esc(p.info)}</small>`;
    });
  }
  function drawSmsState() {
    const el = $("smsStatus");
    if (!el) return;
    el.className = `fe-note${smsState.ok === false ? " du-warn" : ""}`;
    el.textContent = smsState.text;
  }
  async function checkSms() {
    try {
      const r = await callApi({ action: "recall", op: "smsStatus" });
      if (r.ready) {
        smsState = { ok: true, text: `Textmagic connected as ${r.user}` +
          (r.from ? `, sending from ${r.from}` : "") +
          (r.balance != null ? ` · credit ${r.balance}${r.currency ? ` ${r.currency}` : ""}` : "") +
          (r.from ? "." : ". Add TextMagicFrom in Script Properties so texts come from your dedicated number and replies come back.") };
      } else {
        smsState = { ok: false, text: r.problem || "Textmagic isn't set up yet." };
      }
    } catch (err) {
      smsState = { ok: false, text: errText(err, "Couldn't check Textmagic.") };
    }
    if (root.isConnected) drawSmsState();
  }
  async function testSms(btn) {
    const to = $("smsTestTo").value.trim();
    if (!to) { showToast("Type the mobile to send the test to."); return; }
    btn.disabled = true;
    try {
      const r = await callApi({ action: "recall", op: "smsTest", to, text: smsSample().text });
      showToast(r.problem || "Test sent. It should arrive in a few seconds.");
    } catch (err) {
      showToast(errText(err, "Couldn't send the test."));
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }
  function insertTok(tok) {
    const ta = $(lastTpl) || $("smsTpl");
    const a = ta.selectionStart ?? ta.value.length;
    const b = ta.selectionEnd ?? a;
    ta.value = ta.value.slice(0, a) + tok + ta.value.slice(b);
    ta.focus();
    ta.setSelectionRange(a + tok.length, a + tok.length);
    dirty = true;
    setState();
    drawPreview();
  }

  /* ---------- Not recalled from these services ---------- */
  function matchesHtml() {
    if (!services) {
      return `<button type="button" class="lh-btn is-quiet" data-act="load-svcs"${servicesBusy ? " disabled" : ""}>${
        servicesBusy ? "Looking through the appointment book…" : "Show which services these match"}</button>`;
    }
    if (!set.skipServices.length) return "";
    return `<div class="rs-match">${set.skipServices.map((w) => {
      const k = skipNorm(w);
      const hits = services.filter((s) => skipNorm(s.service).includes(k));
      const n = hits.reduce((a, s) => a + s.n, 0);
      return `<div><strong>${esc(w)}</strong> <small>${hits.length
        ? `${hits.length} service${hits.length === 1 ? "" : "s"}, ${n.toLocaleString()} visits`
        : "matches nothing in the appointment book"}</small>${hits.length ? `<ul>${hits.slice(0, 6).map((s) =>
          `<li>${esc(s.service)} <em>${esc(s.category)} · ${s.n.toLocaleString()}</em></li>`).join("")}${
          hits.length > 6 ? `<li class="muted">and ${hits.length - 6} more</li>` : ""}</ul>` : ""}</div>`;
    }).join("")}</div>`;
  }

  function addSkip() {
    const w = $("skipNew").value.replace(/\s+/g, " ").trim();
    if (skipNorm(w).length < 3) { showToast("Use at least 3 letters."); return; }
    set = { ...set, ...collect(true) };
    if (set.skipServices.some((x) => skipNorm(x) === skipNorm(w))) { showToast("That's already on the list."); return; }
    if (set.skipServices.length >= 40) { showToast("The list is full."); return; }
    set.skipServices.push(w.slice(0, 40));
    dirty = true;
    draw();
    $("skipNew").focus();
  }

  async function loadServices() {
    if (servicesBusy) return;
    servicesBusy = true;
    $("skipMatches").innerHTML = matchesHtml();
    try {
      const res = await callApi({ action: "recall", op: "services" });
      services = Array.isArray(res.services) ? res.services : [];
    } catch (err) {
      showToast(errText(err, "Couldn't read the appointment book. Try again."));
    } finally {
      servicesBusy = false;
      if (root.isConnected) $("skipMatches").innerHTML = matchesHtml();
    }
  }

  function draw() {
    const team = new Set(set.team);
    root.innerHTML = `
      <a class="back-link" href="#/recall">← Recall</a>
      ${recallTabsHtml("settings")}
      <div class="mc-head">
        <h2 style="margin:0">Recall settings</h2>
        <span class="fe-state is-saved" data-role="state"></span>
        <span class="inv-spacer"></span>
        <button type="button" class="lh-btn" data-act="check">Check for due patients now</button>
        <button type="button" class="btn-primary" data-act="save">Save</button>
      </div>
      <p class="muted" data-role="status">${esc(statusText())}</p>
      <div class="rs-grid">
        <section class="tb-card rs-wide">
          <div class="rs-card-head">
            <h4 class="mc-h">Treatments</h4>
            <p class="fe-note">A patient is due this long after their last visit for that treatment, unless one is already booked.
              The PCN overdue list uses the same intervals. "Called in texts" is how the treatment is named in recall texts:
              keep it general, without brand or medicine names.</p>
          </div>
          <div class="rs-table-wrap">
            <table class="rs-cats">
              <thead><tr><th>Recall</th><th>Treatment</th><th>Every</th><th>Called in texts</th></tr></thead>
              <tbody>${set.categories.map((c) => `<tr data-cat="${esc(c.key)}">
                <td><input type="checkbox" data-f="on"${c.on ? " checked" : ""} aria-label="Recall ${esc(c.key)}" /></td>
                <td class="rs-cat-name">${esc(c.key)}</td>
                <td><select class="fb-select" data-f="months" aria-label="Every">${opts(Array.from({ length: 24 }, (_, i) => i + 1), c.months,
                  (m) => `${m} month${m === 1 ? "" : "s"}`)}</select></td>
                <td><input class="fe-input" data-f="smsName" maxlength="60" value="${esc(c.smsName)}" aria-label="Called in texts" /></td>
              </tr>`).join("")}</tbody>
            </table>
          </div>
          <div class="rs-opts">
            <label class="rs-opt"><span>Not recalled if their last visit was more than</span>
              <select class="fb-select" data-role="maxAge">${opts([6, 12, 18, 24, 36, 48], set.maxAgeMonths, (m) => `${m} months ago`)}</select></label>
            <label class="rs-opt"><span>Cards appear</span>
              <select class="fb-select" data-role="lead">${opts([0, 7, 14, 30], set.leadDays,
                (d) => (d ? `${d} days before they're due` : "on the day they're due"))}</select></label>
            <label class="fe-check rs-opt-check"><input type="checkbox" data-role="pause"${set.anyFuturePauses ? " checked" : ""} />
              <span>Don't recall anyone with an appointment booked, for any treatment. Their card is paused until the day after it.</span></label>
          </div>
        </section>

        <section class="tb-card">
          <h4 class="mc-h">Recall team</h4>
          <p class="fe-note">New cards are shared between these people in turn, most recently due first, and nobody gets more than two days' worth waiting. Anyone with Recall access can still pick up any card.</p>
          <div class="rs-team">${people.length ? people.map((s) => `<label class="rs-person">
              <input type="checkbox" data-team="${esc(s.id)}"${team.has(s.id) ? " checked" : ""} />
              <span>${esc(s.name)}</span><small>${esc(s.role || "")}</small></label>`).join("")
            : '<p class="muted">Couldn\'t load the staff list.</p>'}</div>
          <div class="rc-row">Up to <select class="fb-select" data-role="perDay">${opts([5, 10, 15, 20, 30, 50], set.perDay, (n) => String(n))}</select> new calls for each person a day</div>
          <label class="fe-check"><input type="checkbox" data-role="skipLeave"${set.skipLeave ? " checked" : ""} />
            Skip anyone on leave or not rostered that day (Staff → Work schedule)</label>
          ${set.team.length ? "" : '<p class="fe-note du-warn">Nobody in the team yet: new cards wait until you choose someone.</p>'}
        </section>

        <section class="tb-card">
          <h4 class="mc-h">Spend tiers</h4>
          <p class="fe-note">Each patient's spend is added up from the Day Sheet price of every appointment they came to in the
            last 12 months, leaving out cancellations, no-shows and future bookings, then everyone is ranked. It's the listed price,
            so discounts, products and packages aren't exact. The tiers update with the daily check.</p>
          <div class="rs-opts">
            <label class="rs-opt"><span>Platinum: the top</span>
              <select class="fb-select" data-role="spPlat">${opts([5, 10, 15, 20], set.spend.platinum, (n) => `${n}%`)}</select></label>
            <label class="rs-opt"><span>Gold: the next</span>
              <select class="fb-select" data-role="spGold">${opts([10, 15, 20, 25, 30], set.spend.gold, (n) => `${n}%`)}</select></label>
            <label class="rs-opt"><span>Silver: the next</span>
              <select class="fb-select" data-role="spSilver">${opts([20, 25, 30, 40, 50], set.spend.silver, (n) => `${n}%`)}</select></label>
            <label class="fe-check rs-opt-check"><input type="checkbox" data-role="spFirst"${set.spend.shareFirst ? " checked" : ""} />
              <span>Share out higher tiers first, so Platinum patients reach someone's calls before Gold and Silver.</span></label>
          </div>
          <p class="fe-note">${esc(spendText())}</p>
        </section>

        <section class="tb-card">
          <h4 class="mc-h">Patient tags</h4>
          <p class="fe-note">Short labels staff add to a patient, shown on their recall cards and patient page. Staff can add new
            ones as they go. Rename, recolour or remove them here. Removing a tag takes it off every patient.</p>
          <div class="rs-tags">${tagList.map((t) => `<div class="rs-tagrow" data-tagrow="${esc(t.id)}">
              <span class="pt-tag is-${t.color}" data-role="tpill">${esc(t.label || "New tag")}</span>
              <input class="fe-input" data-f="tlabel" maxlength="40" value="${esc(t.label)}" placeholder="Doesn't live in Perth" aria-label="Tag" />
              <select class="fb-select" data-f="tcolor" aria-label="Colour">${TAG_COLORS.map((col) =>
                `<option value="${col}"${col === t.color ? " selected" : ""}>${col[0].toUpperCase()}${col.slice(1)}</option>`).join("")}</select>
              <button type="button" class="lh-btn is-quiet" data-rm-tag aria-label="Remove ${esc(t.label || "this tag")}">×</button>
            </div>`).join("")}</div>
          <div class="rc-row">
            ${tagList.length < 60 ? '<button type="button" class="lh-btn is-quiet" data-act="add-tag">+ Add a tag</button>' : ""}
            <span class="inv-spacer"></span>
            <button type="button" class="lh-btn" data-act="save-tags">Save tags</button>
          </div>
        </section>

        <section class="tb-card">
          <h4 class="mc-h">Texts</h4>
          <p class="fe-note" data-role="smsStatus"></p>
          <p class="fe-note">This is the message staff start from when they press Send text on a card. Automatic texts and emails
            are set up in the <a href="#/settings/recall/flow">Flow</a> tab. Replies go onto the card, and STOP puts them on the do-not-contact list.</p>
          <label class="lh-field"><span class="lh-label">Clinic phone (for {Clinic phone})</span>
            <input class="fe-input" data-role="smsPhone" maxlength="30" value="${esc(set.sms.phone)}" placeholder="08 9000 0000" /></label>
          <label class="lh-field"><span class="lh-label">The message</span>
            <textarea class="fe-input" data-role="smsTpl" rows="5" maxlength="560">${esc(set.sms.template)}</textarea></label>
          <div class="rs-skip">${SMS_TOKENS.map((t) => `<button type="button" class="ch-chip" data-tok="${esc(t)}">${esc(t)}</button>`).join("")}</div>
          <p class="fe-note" data-role="smsPreview"></p>
          <div class="rc-row"><input class="fe-input" data-role="smsTestTo" maxlength="20" placeholder="Your mobile, 04…" aria-label="Send a test to" />
            <button type="button" class="lh-btn" data-act="sms-test">Send a test</button></div>

          <h4 class="mc-h rs-subhead">After a missed call</h4>
          <label class="lh-field"><span class="lh-label">When a call is logged as No answer or Left voicemail</span>
            <select class="fb-select" data-role="missedMode">${[["ask", "Offer a text (staff press Send)"],
              ["auto", "Send the text automatically (Undo stops it)"], ["off", "Don't offer a text"]].map(([v, l]) =>
              `<option value="${v}"${set.sms.missedMode === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
          <label class="lh-field"><span class="lh-label">The message</span>
            <textarea class="fe-input" data-role="missedTpl" rows="4" maxlength="560">${esc(set.sms.missedTemplate)}</textarea></label>
          <p class="fe-note" data-role="missedPreview"></p>
          <label class="lh-field"><span class="lh-label">Not offered if they were texted in the last</span>
            <select class="fb-select" data-role="missedQuiet">${opts([1, 3, 7, 14, 30], set.sms.missedQuiet,
              (d) => `${d} day${d === 1 ? "" : "s"}`)}</select></label>
          <p class="fe-note">Never offered to anyone on the do-not-contact list. With no mobile on file, staff are offered an email
            instead. The blanks above work here too: click in this message first, then on a blank.</p>

          <h4 class="mc-h rs-subhead">More messages to choose from</h4>
          <p class="fe-note">Staff choose these in the Text window on a recall card, as well as the two above. Up to 10.</p>
          <div class="rs-saved">${set.sms.saved.map((m, i) => `<div class="rs-saved-row" data-saved="${i}">
              <div class="rc-row"><input class="fe-input" data-f="sname" maxlength="40" value="${esc(m.name)}" placeholder="Gentle follow-up" aria-label="Message name" />
                <button type="button" class="lh-btn is-quiet" data-rm-saved="${i}" aria-label="Remove ${esc(m.name || "this message")}">×</button></div>
              <textarea class="fe-input" data-f="stext" data-role="saved-${i}" rows="3" maxlength="560" aria-label="Message">${esc(m.text)}</textarea>
            </div>`).join("")}</div>
          ${set.sms.saved.length < 10 ? '<button type="button" class="lh-btn is-quiet" data-act="add-saved">+ Add a message</button>' : ""}
        </section>

        <section class="tb-card">
          <h4 class="mc-h">Reasons for stopping</h4>
          <p class="fe-note">"Ask for a date" pauses the card until then instead of closing it.
            "Do not contact" also puts them on the do-not-contact list.</p>
          <div class="rs-reasons">${set.reasons.map((r, i) => `<div class="rs-reason" data-reason="${i}">
              <input class="fe-input" data-f="label" maxlength="60" value="${esc(r.label)}" placeholder="Moved interstate" aria-label="Reason" />
              <label class="fe-check"><input type="checkbox" data-f="ask"${r.askDate ? " checked" : ""} /> Ask for a date</label>
              <label class="fe-check"><input type="checkbox" data-f="dnc"${r.dnc ? " checked" : ""} /> Do not contact</label>
              <button type="button" class="lh-btn is-quiet" data-rm="${i}" aria-label="Remove ${esc(r.label)}">×</button></div>`).join("")}</div>
          ${set.reasons.length < 20 ? '<button type="button" class="lh-btn is-quiet" data-act="add-reason">+ Add a reason</button>' : ""}
        </section>

        <section class="tb-card">
          <h4 class="mc-h">Not recalled from these services</h4>
          <p class="fe-note">A visit for a service with any of these words in its name doesn't count as a treatment, so it doesn't start or reset a recall. Capitals and spaces are ignored.</p>
          <div class="rs-skip">${set.skipServices.length ? set.skipServices.map((w, i) => `<span class="rs-word" data-skip="${esc(w)}">${esc(w)}
            <button type="button" data-rm-skip="${i}" aria-label="Remove ${esc(w)}">×</button></span>`).join("") : '<span class="muted">None yet.</span>'}</div>
          <div class="rc-row"><input class="fe-input" data-role="skipNew" maxlength="40" placeholder="Touch up" aria-label="Add a word" />
            <button type="button" class="lh-btn" data-act="add-skip">Add</button></div>
          <div data-role="skipMatches">${matchesHtml()}</div>
        </section>
      </div>`;
    setState();
    drawSmsState();
    drawPreview();
  }

  async function save() {
    const s = collect(false);
    const btn = root.querySelector('[data-act="save"]');
    btn.disabled = true;
    try {
      const uid = auth.currentUser && auth.currentUser.uid;
      if (!uid) throw new Error("Your session has ended. Log in again.");
      await setDoc(doc(db, "recall_settings", "config"), {
        ...s, updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120), updatedByUid: uid,
      });
      set = normRecallSettings(s);
      dirty = false;
      draw();
      showToast("Recall settings saved. The next check uses them.");
    } catch (err) {
      console.error("Save recall settings failed:", err);
      showToast(errText(err, "Couldn't save. Try again."));
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function check(btn) {
    if (dirty) { showToast("Save your changes first."); return; }
    btn.disabled = true;
    btn.textContent = "Checking… this can take a minute";
    try {
      const res = await callApi({ action: "recall", op: "refresh" });
      if (res.problem) showToast(res.problem);
      else if (res.later) showToast(res.why || "Recall is busy. Try again in a minute.");
      else {
        status = { ...res, at: new Date().toISOString() };
        $("status").textContent = statusText();
        getDoc(doc(db, "recall_settings", "spend_status"))
          .then((s) => { if (s.exists()) spendStatus = s.data(); if (root.isConnected && !dirty) draw(); })
          .catch(() => {});
        showToast(`Done: ${Number(res.made || 0)} new cards, ${Number(res.texted || 0)} texted, ${Number(res.assigned || 0)} shared out`);
      }
    } catch (err) {
      showToast(errText(err, "Couldn't check. Try again."));
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = "Check for due patients now"; }
    }
  }

  root.addEventListener("focusin", (e) => {
    const r = e.target.dataset.role;
    if (r === "smsTpl" || r === "missedTpl" || /^saved-\d+$/.test(r || "")) lastTpl = r;
  });
  root.addEventListener("input", (e) => {
    if (e.target.closest(".rs-tags")) {   // saved with Save tags, not Save
      const row = e.target.closest("[data-tagrow]");
      if (row && e.target.dataset.f === "tlabel") row.querySelector('[data-role="tpill"]').textContent = e.target.value.trim() || "New tag";
      return;
    }
    if (e.target.dataset.role === "smsTestTo") return;   // not a setting
    dirty = true;
    setState();
    const r = e.target.dataset.role;
    if (r === "smsTpl" || r === "missedTpl" || r === "smsPhone" || e.target.dataset.f === "smsName") drawPreview();
  });
  root.addEventListener("change", (e) => {
    if (e.target.closest(".rs-tags")) {
      const row = e.target.closest("[data-tagrow]");
      if (row && e.target.dataset.f === "tcolor") row.querySelector('[data-role="tpill"]').className = `pt-tag is-${e.target.value}`;
      return;
    }
    if (e.target.dataset.role === "smsTestTo") return;
    dirty = true;
    setState();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.role === "skipNew") { e.preventDefault(); addSkip(); }
  });
  const collectTags = () => [...root.querySelectorAll("[data-tagrow]")].map((r) => ({
    id: r.dataset.tagrow,
    label: r.querySelector('[data-f="tlabel"]').value.replace(/\s+/g, " ").trim().slice(0, 40),
    color: r.querySelector('[data-f="tcolor"]').value,
  }));
  async function saveTags(btn) {
    const list = collectTags().filter((t) => t.label.length >= 2);
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const r = await callApi({ action: "recall", op: "tagLibSave", tags: list });
      if (r.problem) { showToast(r.problem); return; }
      tagList = r.tags || list;
      setTagLib(tagList);
      set = { ...set, ...collect(true) };
      draw();
      showToast(r.stripped ? `Tags saved. Removed tags were taken off ${r.stripped} patient${r.stripped === 1 ? "" : "s"}.` : "Tags saved");
    } catch (err) {
      showToast(errText(err, "Couldn't save the tags."));
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = "Save tags"; }
    }
  }

  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="add-tag"]')) {
      set = { ...set, ...collect(true) };
      tagList = [...collectTags(), { id: "", label: "", color: "teal" }];
      draw();
      const rows = root.querySelectorAll('[data-f="tlabel"]');
      if (rows.length) rows[rows.length - 1].focus();
      return;
    }
    const rmTag = e.target.closest("[data-rm-tag]");
    if (rmTag) {
      set = { ...set, ...collect(true) };
      const row = rmTag.closest("[data-tagrow]");
      const rows = [...root.querySelectorAll("[data-tagrow]")];
      tagList = collectTags().filter((_, i) => rows[i] !== row);
      draw();
      return;
    }
    const st = e.target.closest('[data-act="save-tags"]');
    if (st) { saveTags(st); return; }
    if (e.target.closest('[data-act="save"]')) { save(); return; }
    if (e.target.closest('[data-act="add-skip"]')) { addSkip(); return; }
    if (e.target.closest('[data-act="load-svcs"]')) { loadServices(); return; }
    const tk = e.target.closest("[data-tok]");
    if (tk) { insertTok(tk.dataset.tok); return; }
    const st = e.target.closest('[data-act="sms-test"]');
    if (st) { testSms(st); return; }
    const rs = e.target.closest("[data-rm-skip]");
    if (rs) {
      set = { ...set, ...collect(true) };
      set.skipServices.splice(Number(rs.dataset.rmSkip), 1);
      dirty = true;
      draw();
      return;
    }
    const ck = e.target.closest('[data-act="check"]');
    if (ck) { check(ck); return; }
    if (e.target.closest('[data-act="add-saved"]')) {
      set = { ...set, ...collect(true) };
      set.sms.saved.push({ name: "", text: "" });
      dirty = true;
      draw();
      const names = root.querySelectorAll('[data-f="sname"]');
      if (names.length) names[names.length - 1].focus();
      return;
    }
    const rmSaved = e.target.closest("[data-rm-saved]");
    if (rmSaved) {
      set = { ...set, ...collect(true) };
      set.sms.saved.splice(Number(rmSaved.dataset.rmSaved), 1);
      dirty = true;
      draw();
      return;
    }
    if (e.target.closest('[data-act="add-reason"]')) {
      set = { ...set, ...collect(true) };
      set.reasons.push({ label: "", askDate: false, dnc: false });
      dirty = true;
      draw();
      const rows = root.querySelectorAll('[data-f="label"]');
      if (rows.length) rows[rows.length - 1].focus();
      return;
    }
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      set = { ...set, ...collect(true) };
      set.reasons.splice(Number(rm.dataset.rm), 1);
      dirty = true;
      draw();
    }
  });
  window.addEventListener("beforeunload", (e) => { if (dirty && root.isConnected) e.preventDefault(); });
  draw();
  checkSms();
}