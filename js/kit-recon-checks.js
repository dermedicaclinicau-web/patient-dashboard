// Reporting → Kit reconciliation: explain a difference from the appointment book, and mark it as checked (with history)
import { db, auth } from "./firebase-config.js";
import { collection, getDocs, doc, writeBatch, query, orderBy }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { escapeHtml as esc, showToast } from "./utils.js";

const COL = "kit_recon_checks";
export const CHECK_REASONS = [
  "Explained by the appointment book", "Record added afterwards", "Counting error", "JT storage",
  "Wasted or dropped", "Borrowed or lent, not recorded", "Other",
];

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const signed = (n) => `${r1(n) > 0 ? "+" : ""}${r1(n)}`;
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const niceDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : ""; };
const shortDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""; };
const niceAt = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); };
const ptLink = (pid, name) => pid
  ? `<a href="#/patient/${encodeURIComponent(pid)}" target="_blank" rel="noopener">${esc(name || "Patient")}</a>`
  : esc(name || "Unknown patient");

// One difference = one injector, from one start count to the next
export const checkId = (staffKey, from, to) =>
  `${String(staffKey || "x").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}__${from}__${to || "open"}`;

/* ---------- Saved checks (load once, before drawing) ---------- */

let memo = null;
export async function loadChecks(force = false) {
  if (memo && !force) return memo;
  const snap = await getDocs(collection(db, COL));
  const m = new Map();
  snap.forEach((d) => m.set(d.id, { id: d.id, ...d.data() }));
  memo = m;
  return m;
}
export const checkOf = (seg) => (memo ? memo.get(checkId(seg.staffKey, seg.from, seg.to)) || null : null);

/* ---------- What goes on each difference ---------- */

export function checkBadgeHtml(seg) {
  const c = checkOf(seg);
  if (!c) return "";
  if (c.status !== "checked") return `<span class="kc-badge is-open" title="${esc(`Reopened by ${c.by}: ${c.note}`)}">Reopened</span>`;
  const changed = r1(c.gap) !== r1(seg.gap);
  return `<span class="kc-badge is-ok" title="${esc(`${c.reason}: ${c.note}`)}">✓ Checked · ${esc(c.reason)} · ${esc(c.by)}</span>${
    changed ? `<span class="kc-badge is-warn" title="It was ${esc(signed(c.gap))} when it was checked">Changed since it was checked</span>` : ""}`;
}

// The buttons for one difference. Nothing for a stretch with no later count, or no difference.
export function checkToolsHtml(seg) {
  if (!seg || !seg.to || r1(seg.gap) === 0) return "";
  const c = checkOf(seg);
  const data = esc(JSON.stringify({ k: seg.staffKey, n: seg.staffName, o: seg.oldNames || [], f: seg.from, t: seg.to, g: r1(seg.gap) }));
  return `<div class="kc-tools" data-kc-seg="${data}">
    <div class="kc-row">${checkBadgeHtml(seg)}
      <span class="kc-btns">
        <button type="button" class="lh-btn is-quiet" data-kc="explain">Explain</button>
        <button type="button" class="lh-btn${c && c.status === "checked" ? " is-quiet" : ""}" data-kc="check">${
          c && c.status === "checked" ? "Reopen" : "Mark as checked"}</button>
        ${c ? '<button type="button" class="rc-link" data-kc="history">History</button>' : ""}
      </span></div>
    <div class="kc-out" hidden></div>
  </div>`;
}

/* ---------- Explain (the appointment book) ---------- */

const explained = new Map();

export async function explainSegment(seg) {
  const r = await callApi({ action: "inventory", op: "oldKitExplain", names: seg.oldNames || [], staffName: seg.staffName,
    from: seg.from, to: seg.to });
  if (r.problem) throw new Error(r.problem);
  return r;
}

// One line for the saved check
export function explainSummary(r, gap) {
  if (!r) return "";
  const parts = [`${r.appts} booked Wrinkle Relaxer visit${r.appts === 1 ? "" : "s"}, ${r.records} record${r.records === 1 ? "" : "s"}`];
  if (r.missing.length) parts.push(`${r.missing.length} booked with no record (about ${r1(r.estTotal)} units${r.unknown ? `, ${r.unknown} not estimated` : ""})`);
  if (r.moved.length) parts.push(`${r.moved.length} recorded on a different day`);
  if (r.unbooked.length) parts.push(`${r.unbooked.length} recorded but not booked`);
  if (r1(gap) < 0 && r.missing.length) parts.push(`explains about ${Math.min(r1(r.estTotal), r1(-gap))} of ${r1(-gap)} missing`);
  return parts.join(" · ").slice(0, 600);
}

export function explainHtml(r, gap) {
  const lack = r1(-gap);
  let head;
  if (!r.missing.length && !r.moved.length && !r.unbooked.length) {
    head = `Every booked Wrinkle Relaxer visit (${r.appts}) has a record, so the appointment book doesn't explain it.
      Check for a counting error, waste, JT storage or units lent without being recorded.`;
  } else if (lack > 0 && r.missing.length) {
    const est = r1(r.estTotal);
    head = `${r.missing.length} booked visit${r.missing.length === 1 ? " has" : "s have"} no record in the old app, about
      <strong>${est} units</strong>${r.unknown ? ` (${r.unknown} couldn't be estimated)` : ""}.
      ${est >= lack * 0.8 && est <= lack * 1.25 ? `That explains about all of the ${lack} missing units.`
        : `That explains about ${Math.min(est, lack)} of the ${lack} missing units.`}`;
  } else if (lack < 0) {
    head = `There are ${r1(gap)} more units than expected.${r.unbooked.length
      ? " Records for patients who weren't booked with them may belong to someone else's kit." : ""}`;
  } else {
    head = "The appointment book and the records don't match exactly. See below.";
  }
  const list = (title, rows) => rows.length ? `<p class="kc-sub">${esc(title)}</p><ul class="kc-list">${rows.join("")}</ul>` : "";
  return `<p class="kc-head">${head}</p>
    ${list("Booked, but no record", r.missing.map((m) => `<li><b>${esc(shortDay(m.date))}</b> ${ptLink(m.pid, m.name)}
      <small>${esc(m.services.join(", "))}</small>
      <span class="kc-est">${m.est === null ? "no earlier records to estimate" : `about ${r1(m.est)} units`}${m.touchUp ? " (touch up)" : ""}</span></li>`))}
    ${list("Recorded on a different day", r.moved.map((m) => `<li>${ptLink(m.pid, m.name)}: booked <b>${esc(shortDay(m.apptDate))}</b>,
      recorded <b>${esc(shortDay(m.recDate))}</b> <span class="kc-est">${r1(m.units)} units</span></li>`))}
    ${list("Recorded, but not booked with them", r.unbooked.map((m) => `<li><b>${esc(shortDay(m.date))}</b> ${ptLink(m.pid, m.name)}
      <small>${esc(m.areas || "")}</small> <span class="kc-est">${r1(m.units)} units</span></li>`))}
    <p class="kc-foot">${r.appts} booked visit${r.appts === 1 ? "" : "s"} · ${r.records} record${r.records === 1 ? "" : "s"} ·
      ${r.matched} matched. From ${esc(niceDay(r.from))} up to the count on ${esc(niceDay(r.to))}.</p>`;
}

/* ---------- Mark as checked / Reopen ---------- */

export function openCheckDialog({ seg, explain = "", staff, onSaved }) {
  const id = checkId(seg.staffKey, seg.from, seg.to);
  const cur = memo && memo.get(id);
  const reopening = !!(cur && cur.status === "checked");
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg";
  dlg.innerHTML = `<form class="lh-form" novalidate>
    <div class="lh-dialog-head"><h3>${reopening ? "Reopen this difference?" : "Mark as checked"}</h3>
      <p>${esc(seg.staffName)} · ${esc(niceDay(seg.from))} to ${esc(niceDay(seg.to))} · difference <strong>${esc(signed(seg.gap))}</strong></p></div>
    ${reopening ? `<p class="fe-note">Checked by ${esc(cur.by)} on ${esc(niceAt(cur.at))}: ${esc(cur.reason)}. “${esc(cur.note)}”</p>` : `
    <label class="lh-field"><span class="lh-label">What was it?</span>
      <select class="fb-select" name="reason">${CHECK_REASONS.map((r) =>
        `<option${r === (explain ? CHECK_REASONS[0] : "") ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>`}
    ${explain && !reopening ? `<p class="fe-note">From the appointment book: ${esc(explain)}</p>` : ""}
    <label class="lh-field"><span class="lh-label">${reopening ? "Why is it being reopened?" : "What did you find?"}</span>
      <textarea class="fe-input" name="note" rows="3" maxlength="500" placeholder="${reopening
        ? "e.g. The missing record turned out to be someone else's" : "e.g. Two patients on 14 Oct weren't recorded. Added to their files."}"></textarea></label>
    <p class="lh-error" role="alert" hidden></p>
    <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
      <button type="submit" class="lh-btn is-primary">${reopening ? "Reopen" : "Mark as checked"}</button></div></form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => dlg.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = form.elements.note.value.trim();
    if (note.length < 3) { err.textContent = "Add a short note."; err.hidden = false; return; }
    const user = auth.currentUser;
    if (!user || !staff) { err.textContent = "Please log in again."; err.hidden = false; return; }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    const status = reopening ? "open" : "checked";
    const reason = reopening ? (cur.reason || "") : form.elements.reason.value;
    const now = new Date().toISOString();
    const logRef = doc(collection(db, COL, id, "log"));
    const entry = { action: reopening ? "reopened" : "checked", reason, note, gap: r1(seg.gap), explain: reopening ? "" : explain,
      by: staff.name, byUid: user.uid, at: now };
    const state = { staffKey: String(seg.staffKey || ""), staffName: String(seg.staffName || ""), from: seg.from, to: seg.to,
      gap: r1(seg.gap), status, reason, note, explain: reopening ? "" : explain, logId: logRef.id,
      by: staff.name, byUid: user.uid, at: now, count: Number((cur && cur.count) || 0) + 1 };
    try {
      const b = writeBatch(db);
      b.set(logRef, entry);
      b.set(doc(db, COL, id), state);
      await b.commit();
      if (memo) memo.set(id, { id, ...state });
      dlg.close();
      showToast(reopening ? "Reopened" : "Marked as checked");
      if (onSaved) onSaved();
    } catch (ex) {
      console.error("Kit check not saved:", ex);
      err.textContent = ex.code === "permission-denied" ? "You don't have access to mark differences as checked." : "Couldn't save. Try again.";
      err.hidden = false;
      btn.disabled = false;
    }
  });
  dlg.showModal();
  form.elements.note.focus();
}

/* ---------- History ---------- */

export async function openHistory(seg) {
  const id = checkId(seg.staffKey, seg.from, seg.to);
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg";
  dlg.innerHTML = `<div class="lh-form"><div class="lh-dialog-head"><h3>History</h3>
    <p>${esc(seg.staffName)} · ${esc(niceDay(seg.from))} to ${esc(niceDay(seg.to))}</p></div>
    <div data-role="list"><div class="skeleton sm"></div></div>
    <div class="lh-actions"><button type="button" class="lh-btn" data-act="close">Close</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  const box = dlg.querySelector('[data-role="list"]');
  try {
    const snap = await getDocs(query(collection(db, COL, id, "log"), orderBy("at")));
    const rows = snap.docs.map((d) => d.data());
    box.innerHTML = rows.length ? `<ol class="kc-hist">${rows.map((x) => `<li>
      <b>${x.action === "checked" ? "Checked" : "Reopened"}</b> by ${esc(x.by)} · ${esc(niceAt(x.at))}
      ${x.reason && x.action === "checked" ? `<span class="kc-badge is-ok">${esc(x.reason)}</span>` : ""}
      <p>“${esc(x.note)}”</p>
      <small>Difference then: ${esc(signed(x.gap))}${x.explain ? ` · ${esc(x.explain)}` : ""}</small></li>`).join("")}</ol>`
      : '<p class="bk-none">Nothing yet.</p>';
  } catch (ex) {
    console.error("Kit check history:", ex);
    box.innerHTML = '<p class="lh-error">Couldn\'t load the history.</p>';
  }
}

/* ---------- Wiring: one listener on the page ---------- */

export function bindKitChecks(root, { staff, onChange } = {}) {
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-kc]");
    const box = b && b.closest("[data-kc-seg]");
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();   // so the row's own click doesn't fire too
    const s = JSON.parse(box.dataset.kcSeg);
    const seg = { staffKey: s.k, staffName: s.n, oldNames: s.o, from: s.f, to: s.t, gap: s.g };
    const id = checkId(seg.staffKey, seg.from, seg.to);
    const redraw = () => {
      const keepOpen = box.querySelector(".kc-out:not([hidden])");
      const html = keepOpen ? keepOpen.innerHTML : "";
      box.outerHTML = checkToolsHtml(seg);
      if (onChange) onChange(seg);
      if (html) {
        const fresh = root.querySelector(`[data-kc-seg="${CSS.escape(box.dataset.kcSeg)}"] .kc-out`);
        if (fresh) { fresh.innerHTML = html; fresh.hidden = false; }
      }
    };
    const act = b.dataset.kc;
    if (act === "explain") {
      const out = box.querySelector(".kc-out");
      if (!out.hidden && out.dataset.done) { out.hidden = true; return; }
      out.hidden = false;
      if (out.dataset.done) return;
      out.innerHTML = '<p class="bk-none">Checking the appointment book…</p>';
      b.disabled = true;
      try {
        const r = await explainSegment(seg);
        explained.set(id, r);
        out.innerHTML = explainHtml(r, seg.gap);
        out.dataset.done = "1";
      } catch (ex) {
        out.innerHTML = `<p class="lh-error">${esc(ex.message || "Couldn't check the appointment book.")}</p>`;
      }
      b.disabled = false;
      return;
    }
    if (act === "check") {
      let summary = "";
      if (explained.has(id)) summary = explainSummary(explained.get(id), seg.gap);
      openCheckDialog({ seg, explain: summary, staff, onSaved: redraw });
      return;
    }
    if (act === "history") openHistory(seg);
  });
}