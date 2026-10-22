// Recall → Results (#/recall/results): how recall is going, for managers.
// Worked out in Apps Script (Code.gs → recallResults_) from every card that became due in the period and its History.
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const can = (staff, p) => !!staff && (/^admin$/i.test(String(staff.role || "")) || (Array.isArray(staff.perms) && staff.perms.includes(p)));
const PERIODS = [["30", "Last 30 days"], ["90", "Last 3 months"], ["180", "Last 6 months"], ["365", "Last 12 months"], ["custom", "Choose dates…"]];
const VIA = [["call", "Phone call"], ["reply", "Replied to a text"], ["text", "Text"], ["email", "Email"], ["self", "No contact needed"]];
const TRIES = [["t0", "Without a phone call"], ["t1", "On the 1st call"], ["t2", "On the 2nd call"], ["t3", "After 3 or more calls"]];
const WAIT = [["early", "Before they were due"], ["w1", "Within a week of being due"], ["m1", "8 to 30 days"],
  ["m3", "1 to 3 months"], ["later", "Over 3 months"]];

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const num = (n) => Number(n || 0).toLocaleString();
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const nice = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const monthName = (k) => {
  const m = /^(\d{4})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "numeric" }) : k;
};
const dayText = (n) => (n == null ? "–" : n < 0 ? `${-n} day${n === -1 ? "" : "s"} early` : `${n} day${n === 1 ? "" : "s"}`);
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// One labelled bar: n out of total
const bar = (label, n, total) => `<div class="rr-row"><span class="rr-label">${esc(label)}</span>
  <span class="rr-bar"><i style="width:${pct(n, total)}%"></i></span>
  <span class="rr-val"><b>${num(n)}</b> · ${pct(n, total)}%</span></div>`;
const card = (title, inner, wide = false) =>
  `<section class="tb-card rr-card${wide ? " rr-wide" : ""}"><h4 class="mc-h">${esc(title)}</h4>${inner}</section>`;

export function mountRecallResults(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page rc rr";
  if (!can(staff, "recall.manage")) {
    root.innerHTML = `<a class="back-link" href="#/recall">← Recall</a>
      <div class="state"><strong>Recall results</strong>You need Recall settings access to see this page.</div>`;
    container.replaceChildren(root);
    return;
  }
  const t = todayKey();
  root.innerHTML = `
    <a class="back-link" href="#/recall">← Recall</a>
    <div class="rc-top"><h2>Recall results</h2><span class="inv-spacer"></span>
      <select class="fb-select" data-role="period" aria-label="Period">${PERIODS.map(([v, l]) =>
        `<option value="${v}"${v === "90" ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <span class="rr-dates" data-role="dates" hidden>
        <input type="date" class="fe-input" data-role="from" max="${t}" aria-label="From" />
        <span>to</span>
        <input type="date" class="fe-input" data-role="to" max="${t}" value="${t}" aria-label="To" />
      </span>
      <button type="button" class="lh-btn is-quiet" data-act="refresh">Refresh</button>
    </div>
    <p class="muted rr-intro">Every recall card that became due in this period, and what happened to it, worked out from each card's History.</p>
    <div class="rr-body" data-role="body"></div>`;
  container.replaceChildren(root);
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  let data = null;
  let seq = 0;

  async function load(fresh) {
    const p = $("period").value;
    const req = { action: "recall", op: "results", fresh: !!fresh };
    if (p === "custom") {
      const from = $("from").value, to = $("to").value;
      if (!from || !to) { $("body").innerHTML = '<p class="rc-empty">Choose both dates.</p>'; return; }
      Object.assign(req, { from, to });
    } else {
      req.days = Number(p);
    }
    const my = ++seq;
    const box = $("body");
    if (data) box.classList.add("is-loading");
    else box.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
    try {
      const res = await callApi(req);
      if (my !== seq || !root.isConnected) return;
      box.classList.remove("is-loading");
      if (res.problem) { box.innerHTML = `<p class="rc-empty">${esc(res.problem)}</p>`; return; }
      data = res;
      draw();
    } catch (err) {
      if (my !== seq || !root.isConnected) return;
      console.error("Recall results failed:", err);
      box.classList.remove("is-loading");
      box.innerHTML = `<p class="rc-empty">${esc(err && err.code === "UNAUTHORIZED"
        ? "Your login has timed out. Log out and back in, then try again."
        : "Couldn't work out the results. Press Refresh to try again.")}</p>`;
    }
  }

  function draw() {
    const d = data;
    const box = $("body");
    if (!d.total) {
      box.innerHTML = `<p class="rc-empty">No recall cards became due between ${esc(nice(d.from))} and ${esc(nice(d.to))}.</p>`;
      return;
    }
    const stat = (label, val, sub, cls = "") => `<div class="rc-stat"><small>${esc(label)}</small>
      <strong class="${cls}">${esc(val)}</strong>${sub ? `<span class="rr-sub">${esc(sub)}</span>` : ""}</div>`;
    const rate = (n, total) => `<td><div class="rr-rate"><span class="rr-bar"><i style="width:${pct(n, total)}%"></i></span><b>${pct(n, total)}%</b></div></td>`;
    const f = d.flow;
    const dy = d.days;

    const treatments = `<div class="rr-scroll"><table class="rr-table">
      <thead><tr><th>Treatment</th><th class="n">Due</th><th class="n">Came back</th><th>Rate</th>
        <th class="n">Still open</th><th class="n">Didn't book</th><th class="n">Typical time to book</th></tr></thead>
      <tbody>${d.cats.map((c) => `<tr><td>${esc(c.key)}</td><td class="n">${num(c.due)}</td><td class="n">${num(c.booked)}</td>
        ${rate(c.booked, c.due)}<td class="n">${num(c.open)}</td><td class="n">${num(c.lost)}</td>
        <td class="n">${esc(dayText(c.median))}</td></tr>`).join("")}</tbody></table></div>`;

    const viaHtml = d.booked ? VIA.map(([k, l]) => bar(l, d.via[k] || 0, d.booked)).join("")
      : '<p class="rc-empty">Nobody has booked yet.</p>';
    const triesHtml = d.booked ? TRIES.map(([k, l]) => bar(l, d.tries[k] || 0, d.booked)).join("")
      : '<p class="rc-empty">Nobody has booked yet.</p>';

    const flowHtml = f.cards
      ? `<p class="rr-big"><b>${pct(f.noCall, f.cards)}%</b>booked from the flow before anyone had to call</p>
        ${bar("Booked with no phone call", f.noCall, f.cards)}
        ${bar("Booked after a call", f.afterCall, f.cards)}
        ${bar("Still in progress", f.open, f.cards)}
        ${bar("Didn't book", f.lost, f.cards)}
        <p class="rr-help-line">${num(f.cards)} card${f.cards === 1 ? "" : "s"} went through the flow
          (${pct(f.cards, d.total)}% of everyone due).</p>`
      : '<p class="rc-empty">No cards went through the Recall flow in this period.</p>';

    const waitHtml = dy.n
      ? `<p class="rr-big"><b>${esc(dayText(dy.median))}</b>typical time from due to booked</p>
        ${WAIT.map(([k, l]) => bar(l, dy[k] || 0, dy.n)).join("")}
        <p class="rr-help-line">Average ${esc(dayText(dy.avg))}. The typical time (median) isn't thrown off by a few very late bookings.</p>`
      : '<p class="rc-empty">Nobody has booked yet.</p>';

    const teamHtml = d.people.length
      ? `<div class="rr-scroll"><table class="rr-table">
        <thead><tr><th>Team member</th><th class="n">Calls</th><th class="n">Texts</th><th class="n">Emails</th>
          <th class="n">Bookings</th><th class="n">Calls per booking</th></tr></thead>
        <tbody>${d.people.map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${num(p.calls)}</td><td class="n">${num(p.texts)}</td>
          <td class="n">${num(p.emails)}</td><td class="n"><b>${num(p.booked)}</b></td>
          <td class="n">${p.booked ? (p.calls / p.booked).toFixed(1) : "–"}</td></tr>`).join("")}</tbody></table></div>
        ${f.booked ? `<p class="rr-help-line">The Recall flow booked ${num(f.noCall)} more on its own.</p>` : ""}`
      : '<p class="rc-empty">Nobody on the team has worked these cards yet.</p>';

    box.innerHTML = `
      <div class="rc-stats">
        ${stat("Became due", num(d.total), `${nice(d.from)} to ${nice(d.to)}`)}
        ${stat("Came back", `${pct(d.booked, d.total)}%`, `${num(d.booked)} booked or came in`, "rc-good")}
        ${stat("Still being worked", num(d.open), `${pct(d.open, d.total)}% of them`)}
        ${stat("Didn't book", num(d.lost), `${pct(d.lost, d.total)}% of them`)}
      </div>
      ${d.open / d.total > 0.25 ? `<p class="rr-note">${num(d.open)} of these are still being worked, so the rates will go up as
        they're followed up. Older periods give the truest picture.</p>` : ""}
      <div class="rr-grid">
        ${card("Booking rate by treatment", treatments, true)}
        ${card("What led to the booking", viaHtml)}
        ${card("How many calls it took", triesHtml)}
        ${card("The Recall flow", flowHtml)}
        ${card("Time to book", waitHtml)}
        ${card("The team", teamHtml, true)}
        ${d.reasons.length ? card("Why they didn't book", d.reasons.map((r) => bar(r.label, r.n, d.lost)).join("")) : ""}
        ${d.months.length > 1 ? card("By the month they were due", `<div class="rr-scroll"><table class="rr-table">
          <thead><tr><th>Month</th><th class="n">Due</th><th class="n">Came back</th><th>Rate</th></tr></thead>
          <tbody>${d.months.map((m) => `<tr><td>${esc(monthName(m.month))}</td><td class="n">${num(m.due)}</td>
            <td class="n">${num(m.booked)}</td>${rate(m.booked, m.due)}</tr>`).join("")}</tbody></table></div>`) : ""}
      </div>
      <details class="rr-help"><summary>How these are worked out</summary><ul>
        <li>Each recall card that became due in the period counts once. Duplicates, treatments that are turned off, and visits that weren't a treatment aren't counted.</li>
        <li><strong>Came back</strong>: the card was booked (in the appointment book, or marked as booked) or closed because they came in.</li>
        <li><strong>What led to the booking</strong>: the last text, email, call or reply in the 30 days before it was booked.
          "No contact needed" means they booked with none of those in the 30 days before.</li>
        <li><strong>Calls</strong> are logged calls (no answer, voicemail, spoke to them) plus the call where it was booked.</li>
        <li><strong>Team bookings</strong> go to whoever logged it as booked, otherwise whoever last called, texted or emailed them in the 30 days before.</li>
        <li><strong>Time to book</strong> runs from the due date to the day it was booked or they came in.</li>
      </ul><p class="rr-help-line">Worked out ${esc(new Date(d.checkedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}.
        Refresh works it out again.</p></details>`;
  }

  root.addEventListener("change", (e) => {
    const r = e.target.dataset.role;
    if (r === "period") {
      $("dates").hidden = e.target.value !== "custom";
      if (e.target.value !== "custom") load(false);
      else if ($("from").value) load(false);
      return;
    }
    if (r === "from" || r === "to") load(false);
  });
  root.addEventListener("click", (e) => { if (e.target.closest('[data-act="refresh"]')) load(true); });
  load(false);
}