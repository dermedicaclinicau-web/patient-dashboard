// seo-audience.js — SEO Phase 4: the Audience tab (areas, where visitors are, who they are)
// Reads seo_state/audience and seo_audience/{geo, months, tech, areas, patients}

import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const DOCS = ["geo", "months", "tech", "areas", "patients"];
// Same as SEO4_AREAS_ in Seo4.gs (used until areas are saved)
const SUGGESTED_AREAS = [
  ["Western suburbs", "subiaco, claremont, nedlands, dalkeith, cottesloe, mosman park, peppermint grove, swanbourne, city beach, floreat, wembley, shenton park, 6008, 6009, 6010, 6011, 6012, 6014, 6015"],
  ["Perth CBD & inner north", "perth cbd, northbridge, east perth, west perth, north perth, leederville, mount lawley, highgate, inglewood, 6000, 6003, 6004, 6005, 6006, 6007, 6050, 6052"],
  ["Northern beaches", "scarborough, trigg, karrinyup, doubleview, innaloo, north beach, sorrento, hillarys, duncraig, 6018, 6019, 6020, 6023, 6025"],
  ["Joondalup & north", "joondalup, edgewater, currambine, ocean reef, wanneroo, clarkson, 6027, 6065"],
  ["South of the river", "south perth, como, applecross, mount pleasant, ardross, booragoon, bull creek, 6151, 6152, 6153, 6154"],
  ["Fremantle", "fremantle, east fremantle, north fremantle, south fremantle, 6158, 6159, 6160"],
  ["Rockingham & Mandurah", "rockingham, baldivis, mandurah, 6168, 6171, 6210"],
  ["Perth Hills", "kalamunda, mundaring, darlington, 6073, 6076"],
  ["Regional WA", "bunbury, busselton, margaret river, geraldton, albany, kalgoorlie, broome, karratha"],
].map(([name, w]) => ({ name, words: w.split(",").map((s) => s.trim()) }));

/* ---------- helpers ---------- */

const tsDate = (t) => (t?.toDate ? t.toDate() : t ? new Date(t) : null);
const when = (t) => {
  const d = tsDate(t);
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
};
const monthLabel = (ym) => new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" });

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "seo-w-toast" + (bad ? " is-bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2500);
}

// Rows end with [0/1 date range, sessions, engaged, key events]
function agg(rows, keyFn, chanFn, organic) {
  const by = new Map();
  for (const r of rows || []) {
    if (organic && chanFn(r) !== "Organic Search") continue;
    const k = keyFn(r);
    if (k == null || k === "") continue;
    const n = r.length, range = r[n - 4];
    const x = by.get(k) || { k, s: [0, 0], e: [0, 0], ev: [0, 0] };
    x.s[range] += r[n - 3]; x.e[range] += r[n - 2]; x.ev[range] += r[n - 1];
    by.set(k, x);
  }
  return [...by.values()].sort((a, b) => b.s[0] - a.s[0]);
}

function monthBars(list, h, title) {
  const max = Math.max(1, ...list.map((x) => x[1]));
  return `<div class="seo-a-months">${list.map(([m, n]) =>
    `<span title="${h.esc(monthLabel(m))}: ${h.fmtInt(n)}${title ? " " + h.esc(title) : ""}" style="height:${Math.max(2, (n / max) * 100)}%"></span>`).join("")}</div>
    <div class="seo-a-mlab"><span>${list.length ? h.esc(monthLabel(list[0][0])) : ""}</span><span>${list.length ? h.esc(monthLabel(list[list.length - 1][0])) : ""}</span></div>`;
}

/* ---------- data ---------- */

export async function loadAudience() {
  injectCss();
  const s = await getDoc(doc(db, "seo_state", "audience"));
  if (!s.exists()) return null;
  const A = { state: s.data(), mixed: false };
  const snaps = await Promise.all(DOCS.map((k) => getDoc(doc(db, "seo_audience", k))));
  snaps.forEach((d, i) => {
    const x = d.exists() ? d.data() : null;
    if (x && A.state.build && x.build !== A.state.build) A.mixed = true;
    try { A[DOCS[i]] = x && x.json ? JSON.parse(x.json) : null; } catch { A[DOCS[i]] = null; }
  });
  return A;
}

/* ---------- the tab ---------- */

export function viewAudience(wrap, c, ui) {
  const A = c.work.audience;
  const h = c.h;
  if (!A || !A.state) {
    const err = c.work.errors?.audience;
    wrap.innerHTML = `<div class="seo-empty">${err ? h.esc(/permission/i.test(err) ? "You don't have permission to see this." : err)
      : "No audience data yet. In Apps Script, run <code>runSeoAudience()</code> once, then <code>installSeoAudienceTrigger()</code>."}</div>`;
    return;
  }
  if (!ui.aview) Object.assign(ui, { aview: "areas", achan: "organic", aarea: "", aedit: false });
  const st = A.state;
  const areas = A.areas || [];
  const canManage = c.can("seo.manage");

  /* ----- tables ----- */

  function table(title, list, limit, opts = {}) {
    const tot = list.reduce((t, x) => t + x.s[0], 0) || 1;
    const rows = list.slice(0, limit);
    return `<div class="seo-card"><h3>${h.esc(title)}</h3>
      ${rows.length ? `<table class="seo-table seo-a-t"><thead><tr><th>${h.esc(opts.col || "")}</th><th>Sessions</th><th>vs prev</th>
        <th>Engaged</th><th>Key events</th><th>vs prev</th><th>Share</th></tr></thead><tbody>${rows.map((x) => {
          const pct = Math.round((x.s[0] / tot) * 100);
          return `<tr><td>${h.esc(opts.label ? opts.label(x.k) : x.k)}</td><td>${h.fmtInt(x.s[0])}</td><td>${h.delta(x.s[0], x.s[1])}</td>
            <td>${x.s[0] ? Math.round((x.e[0] / x.s[0]) * 100) + "%" : "—"}</td><td>${h.fmtInt(x.ev[0])}</td><td>${h.delta(x.ev[0], x.ev[1])}</td>
            <td><span class="seo-a-bar"><i style="width:${pct}%"></i></span>${pct}%</td></tr>`;
        }).join("")}</tbody></table>${list.length > limit ? `<p class="seo-note">and ${list.length - limit} more</p>` : ""}`
        : `<p class="seo-note">${h.esc(opts.empty || "No data.")}</p>`}
      ${opts.note ? `<p class="seo-note" style="margin-top:6px">${opts.note}</p>` : ""}</div>`;
  }

  /* ----- Areas ----- */

  function areaRow(a) {
    const s = a.search, v = a.visitors, p = a.patients;
    const imp = (s?.weeks || []).map((w) => w[1]);
    return `<tr data-a-area="${h.esc(a.name)}" class="${ui.aarea === a.name ? "is-on" : ""}">
      <td><strong>${h.esc(a.name)}</strong></td>
      <td>${s ? `${h.fmtInt(s.cur.c)} ${h.delta(s.cur.c, s.prev.c)}` : "—"}</td>
      <td>${s ? `${h.fmtInt(s.cur.i)} ${h.delta(s.cur.i, s.prev.i)}` : "—"}</td>
      <td>${s ? h.fmtPos(s.cur.pos) : "—"}</td>
      <td>${v && v.cities.length ? `${h.fmtInt(v.cur[0])} ${h.delta(v.cur[0], v.prev[0])}` : `<span class="seo-note">not separate</span>`}</td>
      <td>${p ? h.fmtInt(p.active) : "—"}</td>
      <td>${p ? h.fmtInt(p.new12) : "—"}</td>
      <td>${imp.length > 1 ? h.sparkline(imp, 90, 22) : ""}</td></tr>`;
  }

  function areaDetail(a) {
    const s = a.search, v = a.visitors, p = a.patients;
    const qrows = (s?.queries || []).map(([q, cl, im, pos, page]) => {
      const pg = c.byPath.get(page);
      return `<tr><td>${h.esc(q)}</td><td>${h.fmtInt(cl)}</td><td>${h.fmtInt(im)}</td><td>${h.fmtPos(pos)}</td>
        <td>${pg ? `<button class="seo-w-link" data-open="${pg.id}">${h.esc(page)}</button>` : h.esc(page || "")}</td></tr>`;
    }).join("");
    return `<div class="seo-card">
      <div class="seo-row"><h3 style="margin:0">${h.esc(a.name)}</h3><span class="seo-sp"></span>
        <span class="seo-note">Matches: ${h.esc(a.words.join(", "))}</span></div>
      <div class="seo-grid2">
        <div>
          <h4 class="seo-a-h">Searches that mention this area</h4>
          ${s ? `<p class="seo-note">${h.fmtInt(s.queryCount)} different searches in the last 28 days.
              Google hides very rare searches, so the real number is a bit higher.</p>
            <div class="seo-a-spark"><span class="seo-note">Impressions per week (16 months)</span>${h.sparkline(s.weeks.map((w) => w[1]), 360, 50)}</div>
            <div class="seo-a-spark"><span class="seo-note">Clicks per week</span>${h.sparkline(s.weeks.map((w) => w[0]), 360, 50)}</div>
            ${qrows ? `<table class="seo-w-mini"><thead><tr><th>Search</th><th>Clicks</th><th>Impr.</th><th>Pos.</th><th>Page</th></tr></thead>
              <tbody>${qrows}</tbody></table>` : `<p class="seo-note">No searches mentioning this area in the last 28 days.</p>`}`
            : `<p class="seo-note">${h.esc(a.searchError || "No search data.")}</p>`}
        </div>
        <div>
          <h4 class="seo-a-h">Visitors (Google Analytics)</h4>
          ${v && v.cities.length ? `
            <p class="seo-note">Counted from: ${h.esc(v.cities.join(", "))}</p>
            <table class="seo-kv"><tr><th></th><th>Last 28d</th><th>Prev 28d</th><th></th></tr>
              <tr><td>Sessions</td><td>${h.fmtInt(v.cur[0])}</td><td>${h.fmtInt(v.prev[0])}</td><td>${h.delta(v.cur[0], v.prev[0])}</td></tr>
              <tr><td>From Google search</td><td>${h.fmtInt(v.curO[0])}</td><td>${h.fmtInt(v.prevO[0])}</td><td>${h.delta(v.curO[0], v.prevO[0])}</td></tr>
              <tr><td>Key events</td><td>${h.fmtInt(v.cur[2])}</td><td>${h.fmtInt(v.prev[2])}</td><td>${h.delta(v.cur[2], v.prev[2])}</td></tr>
            </table>
            ${v.months.length ? `<p class="seo-note">Sessions per month</p>${monthBars(v.months.map((m) => [m[0], m[1]]), h, "sessions")}` : ""}`
            : `<p class="seo-note">Google Analytics doesn't show these suburbs separately: most of Perth shows as “Perth”.
                If a larger centre (Joondalup, Mandurah, Rockingham, Fremantle…) belongs in this area, add it to the area's words.</p>`}
          <h4 class="seo-a-h" style="margin-top:14px">Patients</h4>
          ${p ? `<p><strong>${h.fmtInt(p.active)}</strong> seen in the last 12 months · ${h.fmtInt(p.total)} in total ·
              <strong>${h.fmtInt(p.new12)}</strong> new in the last 12 months</p>
            <p class="seo-note">New patients per month (first visit)</p>${monthBars(p.months, h, "new patients")}`
            : `<p class="seo-note">${h.esc(st.patientsError || "Patient counts aren't available.")}</p>`}
        </div>
      </div></div>`;
  }

  function editor() {
    const cur = Array.isArray(c.work.settings?.areas) ? c.work.settings.areas : SUGGESTED_AREAS;
    const text = cur.map((a) => `${a.name}: ${(a.words || []).join(", ")}`).join("\n");
    return `<div class="seo-card">
      <h3 style="margin:0 0 4px">Edit areas</h3>
      <p class="seo-note">One area per line: <code>Name: suburb, suburb, postcode…</code>. Words match whole words in searches,
        GA4 city names and patients' suburbs and postcodes. Up to 20 areas. Changes show after the next run (about 9am),
        or run <code>runSeoAudience()</code> in Apps Script.</p>
      <textarea class="seo-input seo-w-full seo-w-ta" rows="12" data-a-text>${h.esc(text)}</textarea>
      <div class="seo-w-acts">
        <button class="seo-btn on" data-a-save>Save areas</button>
        <button class="seo-btn" data-a-suggest>Reset to suggested</button>
        <button class="seo-btn" data-a-cancel>Cancel</button>
      </div></div>`;
  }

  function areasHtml() {
    const sel = areas.find((a) => a.name === ui.aarea);
    const pt = A.patients?.totals;
    return `
      ${ui.aedit ? editor() : ""}
      <div class="seo-table-wrap" style="max-height:none"><table class="seo-table">
        <thead><tr><th>Area</th><th>Search clicks</th><th>Impressions</th><th>Avg position</th><th>Visitors</th>
          <th>Active patients</th><th>New patients (12m)</th><th>Search trend</th></tr></thead>
        <tbody>${areas.map(areaRow).join("")}</tbody></table></div>
      <p class="seo-note" style="margin:8px 0 14px">Click an area for its searches, visitors and patients.
        Search clicks and impressions are only searches that include the area's words (e.g. “skin clinic subiaco”).
        ${pt ? `Patients: ${h.fmtInt(pt.wa)} with a WA postcode, ${h.fmtInt(pt.other)} with another address, ${h.fmtInt(pt.unknown)} with no address on file.` : ""}</p>
      ${sel ? areaDetail(sel) : ""}`;
  }

  /* ----- Where ----- */

  function whereHtml() {
    const G = A.geo || { rows: [], channels: [] };
    const org = ui.achan === "organic";
    const ch = (r) => G.channels[r[3]];
    const countries = agg(G.rows, (r) => r[0], ch, org);
    const states = agg(G.rows, (r) => (r[0] === "Australia" ? r[1] || "(not set)" : null), ch, org);
    const cities = agg(G.rows, (r) => (r[1] === "Western Australia" ? r[2] || "(not set)" : null), ch, org);
    const P = A.patients;
    return `
      <div class="seo-grid2">${table("Countries", countries, 12, { col: "Country" })}${table("Australian states", states, 10, { col: "State" })}</div>
      ${table("Western Australia, by city", cities, 30, { col: "City",
        note: "Location comes from each visitor's internet connection, so it's approximate. Most of Perth shows as “Perth”." })}
      <div class="seo-card"><h3>Where patients live</h3>
        ${P && P.postcodes?.length ? `<table class="seo-table seo-a-t"><thead><tr><th>Postcode</th><th>Suburb</th><th>Seen in last 12 months</th>
            <th>All patients</th><th>New in last 12 months</th></tr></thead><tbody>${P.postcodes.slice(0, 40).map(([pc, sub, total, active, nw]) =>
            `<tr><td>${h.esc(pc)}</td><td>${h.esc(sub)}</td><td>${h.fmtInt(active)}</td><td>${h.fmtInt(total)}</td><td>${h.fmtInt(nw)}</td></tr>`).join("")}</tbody></table>
          <p class="seo-note" style="margin-top:6px">From patients' addresses and the appointment book. Counts only, postcodes with 3 or more patients.
            ${P.postcodes.length > 40 ? `Top 40 of ${P.postcodes.length}.` : ""}</p>
          <p class="seo-note">New patients per month (first visit), whole clinic</p>${monthBars(P.months, h, "new patients")}`
          : `<p class="seo-note">${h.esc(st.patientsError || "No patient data.")}</p>`}
      </div>`;
  }

  /* ----- Who ----- */

  function whoHtml() {
    const T = A.tech || {};
    const org = ui.achan === "organic";
    const devices = agg(T.device, (r) => r[0], (r) => r[1], org);
    const visitor = agg(T.visitor, (r) => r[0], (r) => r[1], org);
    const channels = agg(T.device, (r) => r[1], (r) => r[1], false);
    const age = agg(T.demo, (r) => (r[0] === "unknown" ? null : r[0]), (r) => r[2], org);
    const gender = agg(T.demo, (r) => (r[1] === "unknown" ? null : r[1]), (r) => r[2], org);
    const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    const demoNote = "GA4 only shows age and gender when Google signals is on (GA4 → Admin → Data collection) and there are enough visitors. Small groups are hidden for privacy.";
    return `
      <div class="seo-grid2">
        ${table("Device", devices, 5, { col: "Device", label: cap })}
        ${table("New or returning", visitor, 5, { col: "", label: (k) => (k === "new" ? "New visitors" : k === "returning" ? "Returning visitors" : cap(k)) })}
      </div>
      ${table("How visitors found the site (all visitors)", channels, 12, { col: "Channel",
        note: "AI Assistant is ChatGPT, Perplexity, Gemini and similar." })}
      <div class="seo-grid2">
        ${table("Age", age.sort((a, b) => String(a.k).localeCompare(String(b.k))), 10, { col: "Age", empty: demoNote })}
        ${table("Gender", gender, 5, { col: "Gender", label: cap, empty: demoNote })}
      </div>`;
  }

  /* ----- draw ----- */

  function draw() {
    wrap.innerHTML = `
      ${st.ok === false ? `<div class="seo-warn">The last audience update failed, so this may be out of date: ${h.esc(st.error || "")}</div>` : ""}
      ${A.mixed ? `<div class="seo-warn">The audience data is being updated right now. Press Refresh in a minute.</div>` : ""}
      <p class="seo-note">Last 28 days, ${h.fmtDate(st.from, false)} – ${h.fmtDate(st.to)}, vs the 28 days before · updated ${h.esc(when(st.at))}</p>
      <div class="seo-row">
        <button class="seo-btn ${ui.aview === "areas" ? "on" : ""}" data-a-view="areas">Areas</button>
        <button class="seo-btn ${ui.aview === "where" ? "on" : ""}" data-a-view="where">Where</button>
        <button class="seo-btn ${ui.aview === "who" ? "on" : ""}" data-a-view="who">Who</button>
        <span class="seo-sp"></span>
        ${ui.aview === "areas"
          ? (canManage && !ui.aedit ? `<button class="seo-btn" data-a-edit>Edit areas</button>` : "")
          : `<button class="seo-w-chip ${ui.achan === "organic" ? "is-on" : ""}" data-a-chan="organic">From Google search</button>
             <button class="seo-w-chip ${ui.achan === "all" ? "is-on" : ""}" data-a-chan="all">All visitors</button>`}
      </div>
      ${ui.aview === "where" ? whereHtml() : ui.aview === "who" ? whoHtml() : areasHtml()}`;
  }

  wrap.onclick = async (e) => {
    if (e.target.closest("[data-open]")) return;   // seo.js opens the page panel
    const t = e.target.closest("[data-a-view],[data-a-chan],[data-a-area],[data-a-edit],[data-a-cancel],[data-a-suggest],[data-a-save]");
    if (!t) return;
    const d = t.dataset;
    if (d.aView) { ui.aview = d.aView; draw(); return; }
    if (d.aChan) { ui.achan = d.aChan; draw(); return; }
    if (d.aArea !== undefined) { ui.aarea = ui.aarea === d.aArea ? "" : d.aArea; draw(); return; }
    if (d.aEdit !== undefined) { ui.aedit = true; draw(); return; }
    if (d.aCancel !== undefined) { ui.aedit = false; draw(); return; }
    if (d.aSuggest !== undefined) {
      wrap.querySelector("[data-a-text]").value = SUGGESTED_AREAS.map((a) => `${a.name}: ${a.words.join(", ")}`).join("\n");
      return;
    }
    if (d.aSave !== undefined) {
      const list = [];
      for (const line of wrap.querySelector("[data-a-text]").value.split(/\n+/)) {
        const i = line.indexOf(":");
        if (i < 1) continue;
        const name = line.slice(0, i).trim().slice(0, 60);
        const words = [...new Set(line.slice(i + 1).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 60);
        if (name && words.length) list.push({ name, words });
      }
      if (!list.length) { toast("Add at least one area, like “Western suburbs: subiaco, claremont, 6008”.", true); return; }
      if (list.length > 20) { toast(`That's ${list.length} areas. Keep it to 20.`, true); return; }
      t.disabled = true;
      try {
        await setDoc(doc(db, "seo_settings", "main"),
          { areas: list, updatedBy: auth.currentUser?.uid || "", updatedAt: serverTimestamp() }, { merge: true });
        c.work.settings = { ...(c.work.settings || {}), areas: list };
        ui.aedit = false;
        toast("Areas saved. They update after the next run (about 9am).");
        draw();
      } catch (err) {
        t.disabled = false;
        toast(/permission/i.test(err.message) ? "You don't have permission to do that." : err.message, true);
      }
    }
  };
  draw();
}

/* ---------- styles ---------- */

const CSS = `
.seo-a-t{font-size:13px}
.seo-a-bar{display:inline-block;width:64px;height:6px;margin-right:6px;border-radius:3px;background:#e5e7eb;vertical-align:middle;overflow:hidden}
.seo-a-bar i{display:block;height:100%;background:var(--accent,#2563eb)}
.seo-a-h{margin:4px 0 6px;font-size:14px}
.seo-a-spark{display:flex;flex-direction:column;gap:2px;margin:6px 0}
.seo-a-spark svg{width:100%;height:auto}
.seo-a-months{display:flex;align-items:flex-end;gap:3px;height:60px;margin-top:4px}
.seo-a-months span{flex:1;min-height:2px;border-radius:2px 2px 0 0;background:var(--accent,#2563eb);opacity:.8}
.seo-a-mlab{display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted,#6b7280)}
.seo-w-card.is-green{--tone:#059669}
.seo-w-pill.is-green{--pbg:#ecfdf5;--pfg:#047857}
`;

function injectCss() {
  if (document.getElementById("seo-audience-css")) return;
  const s = document.createElement("style");
  s.id = "seo-audience-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}