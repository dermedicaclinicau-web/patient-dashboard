// Reporting → Retention: how many patients come back, month by month, by clinician and by first visit.
// Worked out by Apps Script from the appointment book (action "reports", op "retention"). Numbers only, no patient details.
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const pctText = (p) => (p === null ? "—" : `${p}%`);
const num = (n) => Number(n || 0).toLocaleString("en-AU");
const monthName = (m, long) => {
  const [y, mo] = String(m).split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString("en-AU", long ? { month: "long", year: "numeric" } : { month: "short" });
};
const tone = (p) => (p === null ? "is-wait" : p >= 50 ? "is-good" : p >= 35 ? "is-mid" : "is-low");
const heat = (p) => `style="background:hsl(174 55% ${Math.round(96 - p * 0.55)}%);color:${p > 55 ? "#fff" : "#0f172a"}"`;

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  users: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  spark: ic('<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>'),
  repeat: ic('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  star: ic('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  cal: ic('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  alert: ic('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
};

const cardHtml = (c) => `<div class="pr-card is-${c.tone}"><span class="pr-card-i">${c.icon}</span>
  <div><strong>${esc(String(c.v))}</strong><span>${esc(c.l)}</span><small>${esc(c.sub)}</small></div></div>`;
const pbar = (p) => `<div class="rt-pcell"><span class="rt-pbar ${tone(p)}"><span style="width:${p || 0}%"></span></span><strong>${pctText(p)}</strong></div>`;

function draw(out, d) {
  const k = d.kpis || {};
  const cards = [
    { v: num(k.active), l: "Active patients", sub: "seen in the last 12 months", tone: "teal", icon: I.users },
    { v: num(k.newYear), l: "New patients", sub: "first visit in the last 12 months", tone: "violet", icon: I.spark },
    { v: pctText(pct(k.kRet, k.kMeas)), l: "Come back within 3 months", sub: "after any visit", tone: "amber", icon: I.repeat },
    { v: pctText(pct(k.nRet, k.nMeas)), l: "New patients back within 3 months", sub: "after their first visit", tone: "rose", icon: I.star },
    { v: k.active ? (k.visitsYear / k.active).toFixed(1) : "—", l: "Visits per patient", sub: "in the last 12 months", tone: "slate", icon: I.cal },
    { v: num(k.lapsed), l: "Lapsed regulars", sub: "3+ visits, not seen in 6–12 months, nothing booked", tone: "rose", icon: I.alert },
  ];

  // The last 24 months: new and returning patients, and how many came back within 3 months
  const months = d.months || [];
  const max = Math.max(1, ...months.map((m) => m.seen));
  const chart = `<section class="tb-card rt-sec"><h4>Patients seen each month</h4>
    <div class="rt-legend"><span class="is-new">New patients</span><span class="is-ret">Returning patients</span></div>
    <div class="rt-chart">${months.map((m) => {
      const ret = m.seen - m.fresh;
      const p = m.seen && m.meas === m.seen ? pct(m.ret, m.meas) : null;
      return `<div class="rt-col" title="${esc(monthName(m.m, true))}: ${m.seen} patients, ${m.fresh} new${p !== null ? `. ${p}% came back within 3 months` : ""}">
        <span class="rt-n">${m.seen || ""}</span>
        <div class="rt-bar"><span class="is-new" style="height:${(m.fresh / max) * 100}%"></span><span class="is-ret" style="height:${(ret / max) * 100}%"></span></div>
        <span class="rt-m">${esc(monthName(m.m))}${m.m.endsWith("-01") ? `<b>${m.m.slice(0, 4)}</b>` : ""}</span>
        <span class="rt-p ${tone(p)}">${p === null ? "…" : `${p}%`}</span></div>`;
    }).join("")}</div>
    <p class="muted rt-note">The percentage under each month: of the patients seen that month, how many came back within 3 months.
      “…” means it's too early to tell.</p></section>`;

  // New patients by the month they started
  const cohorts = (d.cohorts || []).slice().reverse();
  const coh = `<section class="tb-card rt-sec"><h4>New patients: how many came back</h4>
    <p class="muted rt-note">Each row is the patients who first came in that month, and how many had a second visit within 3, 6 and 12 months.</p>
    <div class="rp-scroll"><table class="inv-table rt-coh">
      <thead><tr><th>Started</th><th>New patients</th><th>Back within 3 months</th><th>Within 6 months</th><th>Within 12 months</th></tr></thead>
      <tbody>${cohorts.map((c) => `<tr><td><strong>${esc(monthName(c.m, true))}</strong></td><td>${c.n}</td>${["r90", "r180", "r365"].map((key) => {
        const z = c[key] || [0, 0];
        const p = c.n && z[0] === c.n ? pct(z[1], z[0]) : null;
        return p === null ? '<td class="rt-wait">too early</td>'
          : `<td class="rt-heat" ${heat(p)}><strong>${p}%</strong><small>${z[1]} of ${z[0]}</small></td>`;
      }).join("")}</tr>`).join("") || '<tr><td colspan="5">No new patients yet.</td></tr>'}</tbody>
    </table></div></section>`;

  // Clinicians
  const staff = d.staff || [];
  const st = `<section class="tb-card rt-sec"><h4>By clinician</h4>
    <p class="muted rt-note">Visits from 3 to 15 months ago, so everyone has had time to come back. Clinicians with fewer than 10 visits aren't shown.</p>
    <div class="rp-scroll"><table class="inv-table rt-tbl">
      <thead><tr><th>Clinician</th><th>Visits</th><th>Came back within 3 months</th><th>New patients</th><th>New patients back within 3 months</th></tr></thead>
      <tbody>${staff.map((x) => `<tr><td><strong>${esc(x.name)}</strong></td><td>${num(x.visits)}</td><td>${pbar(pct(x.ret, x.visits))}</td>
        <td>${num(x.nNew)}</td><td>${x.nNew >= 5 ? pbar(pct(x.nRet, x.nNew)) : '<span class="muted">too few</span>'}</td></tr>`).join("")
        || '<tr><td colspan="5">Not enough visits yet.</td></tr>'}</tbody>
    </table></div></section>`;

  // What new patients first came for
  const kinds = d.kinds || [];
  const kd = `<section class="tb-card rt-sec"><h4>By what the first visit was for</h4>
    <p class="muted rt-note">New patients who started 3 to 15 months ago, and how many came back within 3 months.</p>
    <div class="rp-scroll"><table class="inv-table rt-tbl">
      <thead><tr><th>First visit was for</th><th>New patients</th><th>Came back within 3 months</th></tr></thead>
      <tbody>${kinds.map((x) => `<tr><td><strong>${esc(x.kind)}</strong></td><td>${num(x.n)}</td><td>${pbar(pct(x.ret, x.n))}</td></tr>`).join("")
        || '<tr><td colspan="3">Not enough new patients yet.</td></tr>'}</tbody>
    </table></div></section>`;

  out.innerHTML = `<div class="pr-cards">${cards.map(cardHtml).join("")}</div>${chart}<div class="rt-two">${st}${kd}</div>${coh}
    <p class="muted rt-note">Worked out at ${esc(new Date(d.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }))}.
      “Rebooked before leaving” isn't shown: the appointment book export doesn't say when each booking was made.</p>`;
}

export function mountRetention(body) {
  body.innerHTML = `<p class="muted rp-range">How many patients come back. From the appointment book: cancellations and no-shows don't count as visits.</p>
    <div class="inv-tools rp-tools"><span class="inv-spacer"></span><button type="button" class="ff-btn" data-act="refresh">Refresh</button></div>
    <div data-role="out"></div>`;
  const out = body.querySelector('[data-role="out"]');

  async function load(fresh = false) {
    const t0 = Date.now();
    const note = "The first time can take up to a minute or two: it reads the whole appointment book. After that it's quick for 10 minutes.";
    out.innerHTML = `<div class="tm-empty"><strong>Working it out…</strong><br><small class="muted" data-role="secs">${esc(note)}</small></div>`;
    const tick = setInterval(() => {
      const el = out.querySelector('[data-role="secs"]');
      if (!el) { clearInterval(tick); return; }
      const s = Math.round((Date.now() - t0) / 1000);
      if (s >= 5) el.textContent = `${s} seconds… ${note}`;
    }, 1000);
    try {
      const res = await callApi({ action: "reports", op: "retention", fresh });
      if (!out.isConnected) return;
      if (res.problem) { out.innerHTML = `<div class="tm-empty is-error">${esc(res.problem)}</div>`; return; }
      draw(out, res);
    } catch (err) {
      console.error("Retention report failed:", err);
      if (!out.isConnected) return;
      out.innerHTML = `<div class="tm-empty is-error">${esc(err && (err.code === "INVALID_PIN" || err.code === "BAD_REQUEST")
        ? "The server hasn't been updated yet. In Apps Script, deploy a new version."
        : (err && err.message) || "Couldn't load the report. Try again.")}</div>`;
    } finally {
      clearInterval(tick);
    }
  }

  body.addEventListener("click", (e) => { if (e.target.closest('[data-act="refresh"]')) load(true); });
  load();
}