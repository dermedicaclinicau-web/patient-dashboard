// Reporting → Retention: how many patients come back. Filter by dates, clinician, treatment and patient type.
// Apps Script sends every patient's visits from the last 3 years in a compact form (action "reports", op "retention"),
// and everything is worked out here, so changing a filter is instant. Numbers only, no patient details.
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 864e5;
const D0 = Date.UTC(2000, 0, 1);
const toKey = (n) => new Date(D0 + n * DAY).toISOString().slice(0, 10);
const toN = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - D0) / DAY) : null; };
const monthOf = (n) => toKey(n).slice(0, 7);
const addMonths = (k, n) => {
  const [y, m, d] = k.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  t.setUTCDate(Math.min(d, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()));
  return t.toISOString().slice(0, 10);
};
const niceN = (n) => new Date(D0 + n * DAY).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthName = (m, long) => {
  const [y, mo] = String(m).split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-AU", { timeZone: "UTC", ...(long ? { month: "long", year: "numeric" } : { month: "short" }) });
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const pctText = (p) => (p === null ? "—" : `${p}%`);
const num = (n) => Number(n || 0).toLocaleString("en-AU");
const tone = (p) => (p === null ? "is-wait" : p >= 50 ? "is-good" : p >= 35 ? "is-mid" : "is-low");
const heat = (p) => `style="background:hsl(174 55% ${Math.round(96 - p * 0.55)}%);color:${p > 55 ? "#fff" : "#0f172a"}"`;

const PRESETS = [["last12", "Last 12 months"], ["last6", "Last 6 months"], ["last3", "Last 3 months"], ["thisYear", "This year"],
  ["lastYear", "Last year"], ["thisFy", "This financial year"], ["lastFy", "Last financial year"], ["custom", "Choose dates"]];
const WINS = [[90, "3 months"], [180, "6 months"], [365, "12 months"]];
const TYPES = [["all", "All patients"], ["new", "New patients"], ["returning", "Returning patients"]];
const DEFAULTS = { preset: "last12", from: "", to: "", staff: -1, cat: -1, type: "all", win: 90 };

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  users: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  spark: ic('<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>'),
  repeat: ic('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  star: ic('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  cal: ic('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  alert: ic('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  back: ic('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
};

// [from, to] as day numbers, never before the 3 years of visits sent
function rangeOf(F, todayN, minN) {
  const t = toKey(todayN);
  const [y, m] = t.split("-").map(Number);
  const fy = m >= 7 ? y : y - 1;   // the financial year starts on 1 July
  let r;
  switch (F.preset) {
    case "last6": r = [toN(addMonths(t, -6)) + 1, todayN]; break;
    case "last3": r = [toN(addMonths(t, -3)) + 1, todayN]; break;
    case "thisYear": r = [toN(`${y}-01-01`), todayN]; break;
    case "lastYear": r = [toN(`${y - 1}-01-01`), toN(`${y - 1}-12-31`)]; break;
    case "thisFy": r = [toN(`${fy}-07-01`), todayN]; break;
    case "lastFy": r = [toN(`${fy - 1}-07-01`), toN(`${fy}-06-30`)]; break;
    case "custom": {
      let a = toN(F.from), b = toN(F.to);
      if (a === null) a = todayN - 364;
      if (b === null) b = todayN;
      if (b < a) [a, b] = [b, a];
      r = [a, b];
      break;
    }
    default: r = [toN(addMonths(t, -12)) + 1, todayN];
  }
  return [Math.max(r[0], minN), Math.min(r[1], todayN)];
}

function decode(d) {
  return (d.pts || []).map((r) => {
    const p = { first: r[0], v: [] };
    for (let i = 2; i < r.length; i += 4) {
      const s = r[i + 1];
      p.v.push({ d: r[i], s: Array.isArray(s) ? s : s >= 0 ? [s] : [], c: r[i + 2], k: r[i + 3] });
    }
    return p;
  });
}

// Everything on the page for one set of filters
function compute(pts, F, from, to, todayN) {
  const win = F.win;
  const ok = (v) => v.d >= from && v.d <= to && (F.staff < 0 || v.s.includes(F.staff)) && (F.cat < 0 || (v.c & (1 << F.cat)));
  const back = (p, i, n) => i + 1 < p.v.length && p.v[i + 1].d - p.v[i].d <= n;   // a next visit (any) within n days
  const done = (d, n) => d <= todayN - n;                                             // enough time has passed to tell
  const res = { seen: 0, fresh: 0, visits: 0, meas: 0, ret: 0, nMeas: 0, nRet: 0,
    months: new Map(), coh: new Map(), staff: new Map(), kinds: new Map() };
  pts.forEach((p) => {
    const idx = [];
    p.v.forEach((v, i) => { if (ok(v)) idx.push(i); });
    if (!idx.length) return;
    const isNew = p.v[0].d === p.first && idx[0] === 0;   // their first visit ever is in the range and matches
    if (F.type === "new" && !isNew) return;
    if (F.type === "returning" && isNew) return;
    res.seen++;
    if (isNew) res.fresh++;
    res.visits += idx.length;
    const li = idx[idx.length - 1];
    if (done(p.v[li].d, win)) { res.meas++; if (back(p, li, win)) res.ret++; }
    if (isNew && done(p.first, win)) { res.nMeas++; if (back(p, 0, win)) res.nRet++; }

    const lastIn = new Map();
    idx.forEach((i) => lastIn.set(monthOf(p.v[i].d), i));
    lastIn.forEach((i, m) => {
      const x = res.months.get(m) || { seen: 0, fresh: 0, meas: 0, ret: 0 };
      x.seen++;
      if (isNew && monthOf(p.first) === m) x.fresh++;
      if (done(p.v[i].d, win)) { x.meas++; if (back(p, i, win)) x.ret++; }
      res.months.set(m, x);
    });

    if (isNew) {
      const m = monthOf(p.first);
      const c = res.coh.get(m) || { n: 0, r: [[0, 0], [0, 0], [0, 0]] };
      c.n++;
      [90, 180, 365].forEach((n, j) => { if (done(p.first, n)) { c.r[j][0]++; if (back(p, 0, n)) c.r[j][1]++; } });
      res.coh.set(m, c);
      const kx = res.kinds.get(p.v[0].k) || { n: 0, meas: 0, ret: 0 };
      kx.n++;
      if (done(p.first, win)) { kx.meas++; if (back(p, 0, win)) kx.ret++; }
      res.kinds.set(p.v[0].k, kx);
    }

    // Each clinician: the patient's last visit with them in the range
    const lastWith = new Map();
    idx.forEach((i) => p.v[i].s.forEach((s) => lastWith.set(s, i)));
    lastWith.forEach((i, s) => {
      const x = res.staff.get(s) || { pts: 0, meas: 0, ret: 0, nNew: 0, nMeas: 0, nRet: 0 };
      x.pts++;
      if (done(p.v[i].d, win)) { x.meas++; if (back(p, i, win)) x.ret++; }
      if (isNew && p.v[0].s.includes(s)) {
        x.nNew++;
        if (done(p.first, win)) { x.nMeas++; if (back(p, 0, win)) x.nRet++; }
      }
      res.staff.set(s, x);
    });
  });
  return res;
}

const cardHtml = (c) => `<div class="pr-card is-${c.tone}"><span class="pr-card-i">${c.icon}</span>
  <div><strong>${esc(String(c.v))}</strong><span>${esc(c.l)}</span><small>${esc(c.sub)}</small></div></div>`;
const pbar = (p) => `<div class="rt-pcell"><span class="rt-pbar ${tone(p)}"><span style="width:${p || 0}%"></span></span><strong>${pctText(p)}</strong></div>`;

export function mountRetention(body) {
  const st = { data: null, pts: [], F: { ...DEFAULTS } };
  body.innerHTML = `<p class="muted rp-range">How many patients come back. From the appointment book: cancellations and no-shows don't count as visits.</p>
    <div data-role="tools"></div><div data-role="out"></div>`;
  const toolsEl = body.querySelector('[data-role="tools"]');
  const out = body.querySelector('[data-role="out"]');

  function drawTools() {
    const d = st.data;
    const F = st.F;
    if (!d) { toolsEl.innerHTML = ""; return; }
    const minKey = toKey(d.keepN);
    const maxKey = toKey(d.todayN);
    const staff = d.staff.map((n, i) => [i, n]).sort((a, b) => a[1].localeCompare(b[1], "en-AU"));
    const cats = d.cats.map((n, i) => [i, n]).filter(([i]) => i < 30).sort((a, b) => a[1].localeCompare(b[1], "en-AU"));
    const opt = (v, l, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(l)}</option>`;
    toolsEl.innerHTML = `<div class="inv-tools rp-tools rt-tools">
      <label class="rp-from">Dates <select class="fb-select" data-f="preset">${PRESETS.map(([v, l]) => opt(v, l, F.preset)).join("")}</select></label>
      ${F.preset === "custom" ? `
        <label class="rp-from">From <input class="fe-in" type="date" data-f="from" min="${minKey}" max="${maxKey}" value="${esc(F.from)}" /></label>
        <label class="rp-from">To <input class="fe-in" type="date" data-f="to" min="${minKey}" max="${maxKey}" value="${esc(F.to)}" /></label>` : ""}
      <label class="rp-from">Clinician <select class="fb-select" data-f="staff">${opt(-1, "All clinicians", F.staff)}${staff.map(([i, n]) => opt(i, n, F.staff)).join("")}</select></label>
      <label class="rp-from">Treatment <select class="fb-select" data-f="cat">${opt(-1, "All treatments", F.cat)}${cats.map(([i, n]) => opt(i, n, F.cat)).join("")}</select></label>
      <label class="rp-from">Patients <select class="fb-select" data-f="type">${TYPES.map(([v, l]) => opt(v, l, F.type)).join("")}</select></label>
      <label class="rp-from">Came back within <select class="fb-select" data-f="win">${WINS.map(([v, l]) => opt(v, l, F.win)).join("")}</select></label>
      <button type="button" class="rc-link" data-act="reset">Reset</button>
      <span class="inv-spacer"></span>
      <button type="button" class="ff-btn" data-act="refresh">Refresh</button>
    </div>`;
  }

  function draw() {
    const d = st.data;
    const F = st.F;
    const [from, to] = rangeOf(F, d.todayN, d.keepN);
    const r = compute(st.pts, F, from, to, d.todayN);
    const wl = (WINS.find(([v]) => v === F.win) || WINS[0])[1];
    const summary = [`${niceN(from)} – ${niceN(to)}`, F.staff >= 0 ? d.staff[F.staff] : "", F.cat >= 0 ? d.cats[F.cat] : "",
      F.type !== "all" ? (TYPES.find(([v]) => v === F.type) || [])[1] : ""].filter(Boolean).join(" · ");

    const cards = [
      { v: num(r.seen), l: "Patients seen", sub: "in these dates", tone: "teal", icon: I.users },
      { v: num(r.fresh), l: "New patients", sub: "first visit in these dates", tone: "violet", icon: I.spark },
      { v: num(r.seen - r.fresh), l: "Returning patients", sub: "had been before", tone: "slate", icon: I.back },
      { v: pctText(pct(r.ret, r.meas)), l: `Came back within ${wl}`, sub: r.meas ? `${num(r.ret)} of ${num(r.meas)} patients` : "too early to tell", tone: "amber", icon: I.repeat },
      { v: pctText(pct(r.nRet, r.nMeas)), l: `New patients back within ${wl}`, sub: r.nMeas ? `${num(r.nRet)} of ${num(r.nMeas)}` : "too early to tell", tone: "rose", icon: I.star },
      { v: r.seen ? (r.visits / r.seen).toFixed(1) : "—", l: "Visits per patient", sub: "in these dates", tone: "teal", icon: I.cal },
      { v: num(d.lapsed), l: "Lapsed regulars", sub: "3+ visits, not seen in 6–12 months, nothing booked (not filtered)", tone: "rose", icon: I.alert },
    ];

    // Months in the range (the last 36 if it's longer)
    const months = [];
    for (let m = monthOf(from); m <= monthOf(to); m = addMonths(`${m}-01`, 1).slice(0, 7)) months.push(m);
    const shownMonths = months.slice(-36);
    const max = Math.max(1, ...shownMonths.map((m) => (r.months.get(m) || {}).seen || 0));
    const chart = `<section class="tb-card rt-sec"><h4>Patients seen each month</h4>
      <div class="rt-legend"><span class="is-new">New patients</span><span class="is-ret">Returning patients</span></div>
      <div class="rt-chart" style="grid-template-columns:repeat(${shownMonths.length}, minmax(26px, 1fr))">${shownMonths.map((m) => {
        const x = r.months.get(m) || { seen: 0, fresh: 0, meas: 0, ret: 0 };
        const p = x.seen && x.meas === x.seen ? pct(x.ret, x.meas) : null;
        return `<div class="rt-col" title="${esc(monthName(m, true))}: ${x.seen} patients, ${x.fresh} new${p !== null ? `. ${p}% came back within ${wl}` : ""}">
          <span class="rt-n">${x.seen || ""}</span>
          <div class="rt-bar"><span class="is-new" style="height:${(x.fresh / max) * 100}%"></span><span class="is-ret" style="height:${((x.seen - x.fresh) / max) * 100}%"></span></div>
          <span class="rt-m">${esc(monthName(m))}${m.endsWith("-01") || m === shownMonths[0] ? `<b>${m.slice(0, 4)}</b>` : ""}</span>
          <span class="rt-p ${tone(p)}">${p === null ? (x.seen ? "…" : "") : `${p}%`}</span></div>`;
      }).join("")}</div>
      <p class="muted rt-note">Under each month: of the patients seen, how many came back within ${esc(wl)}. “…” means it's too early to tell.${
        months.length > 36 ? " Showing the last 36 months." : ""}</p></section>`;

    const staffRows = [...r.staff.entries()].filter(([, x]) => x.pts >= 5).sort((a, b) => b[1].pts - a[1].pts);
    const stTbl = `<section class="tb-card rt-sec"><h4>By clinician</h4>
      <p class="muted rt-note">Each patient's last visit with them in these dates. Only visits at least ${esc(wl)} ago count towards “came back”.</p>
      <div class="rp-scroll"><table class="inv-table rt-tbl">
        <thead><tr><th>Clinician</th><th>Patients</th><th>Came back within ${esc(wl)}</th><th>New patients</th><th>New patients back</th></tr></thead>
        <tbody>${staffRows.map(([s, x]) => `<tr><td><strong>${esc(d.staff[s])}</strong></td><td>${num(x.pts)}</td>
          <td>${x.meas ? pbar(pct(x.ret, x.meas)) : '<span class="muted">too early</span>'}</td><td>${num(x.nNew)}</td>
          <td>${x.nMeas >= 5 ? pbar(pct(x.nRet, x.nMeas)) : '<span class="muted">too few</span>'}</td></tr>`).join("")
          || '<tr><td colspan="5">No clinicians with 5 or more patients in these dates.</td></tr>'}</tbody>
      </table></div></section>`;

    const kindRows = [...r.kinds.entries()].sort((a, b) => b[1].n - a[1].n);
    const kdTbl = `<section class="tb-card rt-sec"><h4>New patients: by what the first visit was for</h4>
      <p class="muted rt-note">New patients who started in these dates, and how many came back within ${esc(wl)}.</p>
      <div class="rp-scroll"><table class="inv-table rt-tbl">
        <thead><tr><th>First visit was for</th><th>New patients</th><th>Came back within ${esc(wl)}</th></tr></thead>
        <tbody>${kindRows.map(([k, x]) => `<tr><td><strong>${esc(d.kinds[k] || "Other")}</strong></td><td>${num(x.n)}</td>
          <td>${x.meas ? pbar(pct(x.ret, x.meas)) : '<span class="muted">too early</span>'}</td></tr>`).join("")
          || '<tr><td colspan="3">No new patients in these dates.</td></tr>'}</tbody>
      </table></div></section>`;

    const cohRows = [...r.coh.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const coh = `<section class="tb-card rt-sec"><h4>New patients: how many came back</h4>
      <p class="muted rt-note">Each row is the patients who first came in that month, and how many had a second visit within 3, 6 and 12 months.</p>
      <div class="rp-scroll"><table class="inv-table rt-coh">
        <thead><tr><th>Started</th><th>New patients</th><th>Back within 3 months</th><th>Within 6 months</th><th>Within 12 months</th></tr></thead>
        <tbody>${cohRows.map(([m, c]) => `<tr><td><strong>${esc(monthName(m, true))}</strong></td><td>${c.n}</td>${c.r.map((z) => {
          const p = c.n && z[0] === c.n ? pct(z[1], z[0]) : null;
          return p === null ? '<td class="rt-wait">too early</td>'
            : `<td class="rt-heat" ${heat(p)}><strong>${p}%</strong><small>${z[1]} of ${z[0]}</small></td>`;
        }).join("")}</tr>`).join("") || '<tr><td colspan="5">No new patients in these dates.</td></tr>'}</tbody>
      </table></div></section>`;

    out.innerHTML = `<div class="rt-summary"><strong>${esc(summary)}</strong></div>
      <div class="pr-cards">${cards.map(cardHtml).join("")}</div>${chart}<div class="rt-two">${stTbl}${kdTbl}</div>${coh}
      <p class="muted rt-note">Worked out at ${esc(new Date(st.data.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }))}.
        Visits go back 3 years. “Rebooked before leaving” isn't shown: the appointment book export doesn't say when each booking was made.</p>`;
  }

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
      if (!Array.isArray(res.pts)) { out.innerHTML = '<div class="tm-empty is-error">The server hasn\'t been updated yet. In Apps Script, deploy a new version.</div>'; return; }
      st.data = res;
      st.pts = decode(res);
      drawTools();
      draw();
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

  body.addEventListener("change", (e) => {
    const k = e.target.dataset.f;
    if (!k || !st.data) return;
    const F = st.F;
    if (k === "preset") {
      // Choosing dates starts from the range that was showing
      if (e.target.value === "custom" && F.preset !== "custom") {
        const [a, b] = rangeOf(F, st.data.todayN, st.data.keepN);
        F.from = toKey(a);
        F.to = toKey(b);
      }
      F.preset = e.target.value;
      drawTools();
    } else if (k === "from" || k === "to") {
      F[k] = e.target.value;
    } else if (k === "staff" || k === "cat" || k === "win") {
      F[k] = Number(e.target.value);
    } else {
      F[k] = e.target.value;
    }
    draw();
  });
  body.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="refresh"]')) { load(true); return; }
    if (e.target.closest('[data-act="reset"]') && st.data) { st.F = { ...DEFAULTS }; drawTools(); draw(); }
  });

  load();
}