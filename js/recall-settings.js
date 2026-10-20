// System configuration → Recall (#/settings/recall): intervals, the recall team and the reasons for stopping.
// Saved in recall_settings/config. Apps Script (Code.gs → Recall) reads it every time it checks.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";

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

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return v !== "" && v != null && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const when = (v) => {
  const d = v && typeof v.toDate === "function" ? v.toDate() : new Date(v || "");
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to Recall settings. Check Recall access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);

export function normRecallSettings(x = {}) {
  const seen = new Set();
  const saved = Array.isArray(x.categories) && x.categories.length ? x.categories
    : RECALL_CATEGORIES.map(([key, months, on]) => ({ key, months, on }));
  const categories = saved
    .map((c) => ({ key: String((c && c.key) || "").trim().slice(0, 80), months: int(c && c.months, 1, 36, 6), on: !(c && c.on === false) }))
    .filter((c) => c.key && !seen.has(c.key) && seen.add(c.key));
  RECALL_CATEGORIES.forEach(([key, months]) => { if (!seen.has(key)) { seen.add(key); categories.push({ key, months, on: false }); } });
  const reasons = (Array.isArray(x.reasons) && x.reasons.length ? x.reasons : RECALL_REASONS)
    .map((r) => ({ label: String((r && r.label) || "").trim().slice(0, 60), askDate: !!(r && r.askDate), dnc: !!(r && r.dnc) }))
    .filter((r) => r.label).slice(0, 20);
  return {
    categories, maxAgeMonths: int(x.maxAgeMonths, 3, 60, 24), leadDays: int(x.leadDays, 0, 60, 0),
    anyFuturePauses: x.anyFuturePauses === true,
    team: Array.isArray(x.team) ? x.team.map(String).slice(0, 30) : [],
    perDay: int(x.perDay, 1, 100, 15), skipLeave: x.skipLeave !== false,
    reasons: reasons.length ? reasons : RECALL_REASONS.slice(),
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

  let set, status, people;
  try {
    const [a, b, c] = await Promise.all([
      getDoc(doc(db, "recall_settings", "config")),
      getDoc(doc(db, "recall_settings", "status")),
      callApi({ action: "staffList" }).catch(() => ({ staff: [] })),
    ]);
    set = normRecallSettings(a.exists() ? a.data() : {});
    status = b.exists() ? b.data() : null;
    people = (c && Array.isArray(c.staff) ? c.staff : []).filter((s) => s && s.id);
  } catch (err) {
    console.error("Recall settings failed:", err);
    root.innerHTML = `<div class="state error"><strong>Couldn't open Recall settings</strong>${esc(errText(err, "Try again."))}</div>`;
    return;
  }
  let dirty = false;
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);

  const statusText = () => (status && status.at
    ? `Last checked ${when(status.at)}: ${Number(status.made || 0)} new, ${Number(status.booked || 0)} booked, ` +
      `${Number(status.visited || 0)} came in, ${Number(status.assigned || 0)} shared out.`
    : 'Not checked yet. Run installRecall once in Apps Script, or press "Check for due patients now".');

  // What's on screen. keepEmpty keeps a new reason row while it's being typed.
  function collect(keepEmpty) {
    const seen = new Set();
    return {
      categories: [...root.querySelectorAll("[data-cat]")].map((r) => ({
        key: r.dataset.cat, on: r.querySelector('[data-f="on"]').checked, months: Number(r.querySelector('[data-f="months"]').value) || 6,
      })),
      maxAgeMonths: Number($("maxAge").value) || 24,
      leadDays: Number($("lead").value) || 0,
      anyFuturePauses: $("pause").checked,
      team: [...root.querySelectorAll("[data-team]")].filter((i) => i.checked).map((i) => i.dataset.team),
      perDay: Number($("perDay").value) || 15,
      skipLeave: $("skipLeave").checked,
      reasons: [...root.querySelectorAll("[data-reason]")].map((r) => ({
        label: r.querySelector('[data-f="label"]').value.replace(/\s+/g, " ").trim().slice(0, 60),
        askDate: r.querySelector('[data-f="ask"]').checked, dnc: r.querySelector('[data-f="dnc"]').checked,
      })).filter((r) => keepEmpty || (r.label && !seen.has(r.label.toLowerCase()) && seen.add(r.label.toLowerCase()))),
    };
  }

  function setState() {
    const el = $("state");
    el.className = `fe-state is-${dirty ? "dirty" : "saved"}`;
    el.textContent = dirty ? "Unsaved changes" : "All changes saved";
  }

  function draw() {
    const team = new Set(set.team);
    root.innerHTML = `
      <a class="back-link" href="#/recall">← Recall</a>
      <div class="mc-head">
        <h2 style="margin:0">Recall settings</h2>
        <span class="fe-state is-saved" data-role="state"></span>
        <span class="inv-spacer"></span>
        <button type="button" class="lh-btn" data-act="check">Check for due patients now</button>
        <button type="button" class="btn-primary" data-act="save">Save</button>
      </div>
      <p class="muted" data-role="status">${esc(statusText())}</p>
      <div class="rs-grid">
        <section class="tb-card">
          <h4 class="mc-h">Treatments</h4>
          <p class="fe-note">A patient is due this long after their last visit for that treatment, unless one is already booked.
            The PCN overdue list uses the same intervals.</p>
          <table class="inv-table rs-cats"><thead><tr><th>Recall</th><th>Treatment</th><th>Every</th></tr></thead>
            <tbody>${set.categories.map((c) => `<tr data-cat="${esc(c.key)}">
              <td><input type="checkbox" data-f="on"${c.on ? " checked" : ""} aria-label="Recall ${esc(c.key)}" /></td>
              <td>${esc(c.key)}</td>
              <td><select class="fb-select" data-f="months" aria-label="Every">${opts(Array.from({ length: 24 }, (_, i) => i + 1), c.months,
                (m) => `${m} month${m === 1 ? "" : "s"}`)}</select></td></tr>`).join("")}</tbody></table>
          <div class="rc-row">Not recalled if their last visit was more than
            <select class="fb-select" data-role="maxAge">${opts([6, 12, 18, 24, 36, 48], set.maxAgeMonths, (m) => `${m} months`)}</select> ago</div>
          <div class="rc-row">Cards appear
            <select class="fb-select" data-role="lead">${opts([0, 7, 14, 30], set.leadDays,
              (d) => (d ? `${d} days before they're due` : "on the day they're due"))}</select></div>
          <label class="fe-check"><input type="checkbox" data-role="pause"${set.anyFuturePauses ? " checked" : ""} />
            Don't recall anyone who has any appointment booked (they'll be in soon)</label>
        </section>

        <section class="tb-card">
          <h4 class="mc-h">Recall team</h4>
          <p class="fe-note">New cards are shared between these people in turn, oldest due first. Anyone with Recall access can still pick up any card.</p>
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
          <h4 class="mc-h">Texts and emails</h4>
          <p class="fe-note">Coming next: on the due date a text through Textmagic, an email a week later, then the recall team.
            Until then, due patients go straight to the team.</p>
        </section>
      </div>`;
    setState();
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
        showToast(`Done: ${Number(res.made || 0)} new cards, ${Number(res.assigned || 0)} shared out`);
      }
    } catch (err) {
      showToast(errText(err, "Couldn't check. Try again."));
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = "Check for due patients now"; }
    }
  }

  root.addEventListener("input", () => { dirty = true; setState(); });
  root.addEventListener("change", () => { dirty = true; setState(); });
  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="save"]')) { save(); return; }
    const ck = e.target.closest('[data-act="check"]');
    if (ck) { check(ck); return; }
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
}