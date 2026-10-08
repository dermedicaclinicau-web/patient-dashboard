import { fetchPreconsult, fetchDayAppointments } from "./appointments.js";
import { fetchPatientRecords } from "./records.js";
import { fetchTranscriptRecords, extractSection } from "./transcripts.js";
import { fetchSkincare } from "./skincare.js";
import { escapeHtml, toDateKey, parseDateKey } from "./utils.js";
import { showSoapPanel } from "./soap-panel.js";

const PAGE = 10;
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const svg = (p, cls = "") =>
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  chev: svg('<polyline points="6 9 12 15 18 9"/>', "sum-chev"),
  clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  cal: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
  doc: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
  consent: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>'),
  summary: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  plan: svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  ssp: svg('<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>'),
};

function isOpenSaved(key, fallback) {
  try {
    const s = JSON.parse(localStorage.getItem("pd-open-sections")) || {};
    return key in s ? !!s[key] : fallback;
  } catch { return fallback; }
}

const pad = (n) => String(n).padStart(2, "0");

/* ===================== Parsing pcn_results visit lines ===================== */

// "21/6/2025 - ..." | "May 10, 2025 - ..." | "2025-06-21 - ..."  ->  { key: "2025-06-21", rest }
function leadingDate(line) {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[-–—:]?\s*(.*)$/.exec(line);
  if (m) return { key: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, rest: m[4] }; // Australian day/month/year
  m = /^([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s*[-–—:]?\s*(.*)$/.exec(line);
  if (m) {
    const t = Date.parse(m[1].replace(".", ""));
    if (!isNaN(t)) return { key: toDateKey(new Date(t)), rest: m[2] };
  }
  m = /^(\d{4}-\d{2}-\d{2})\s*[-–—:]?\s*(.*)$/.exec(line);
  if (m) return { key: m[1], rest: m[2] };
  return null;
}

// "Medifacial (LW) (Jess), Review 15 (Dr Teh)" -> [{name:"Medifacial (LW)", staff:"Jess"}, {name:"Review 15", staff:"Dr Teh"}]
function splitServices(rest) {
  return String(rest || "")
    .split(/,\s*(?![^()]*\))/) // commas outside brackets
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(s);
      return m
        ? { name: m[1].replace(/^\*+/, "").trim(), staff: m[2].trim() }
        : { name: s.replace(/^\*+/, "").trim(), staff: "" };
    });
}

function parseVisitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const d = leadingDate(line);
      return d && parseDateKey(d.key) ? { key: d.key, services: splitServices(d.rest) } : null;
    })
    .filter(Boolean);
}

/* ===================== Build the visit list ===================== */

async function buildVisits(patient) {
  const todayKey = toDateKey();
  const results = await Promise.allSettled([
    fetchPreconsult(patient),
    fetchDayAppointments(todayKey),
    fetchPatientRecords(patient),
    fetchTranscriptRecords(patient),
    fetchSkincare(patient),
  ]);
  results.forEach((r) => { if (r.status === "rejected") console.error("History source failed:", r.reason); });
  const [pre, day, recs, transcripts, skincare] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
  const failed = results.some((r) => r.status === "rejected");

  const map = new Map();
  const visit = (key) => {
    if (!map.has(key)) map.set(key, { key, services: [], badges: [] });
    return map.get(key);
  };
  const addService = (key, s) => {
    const v = visit(key);
    if (!v.services.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) v.services.push(s);
  };

  // Past + future visits from pcn_results
  const preData = pre && pre.found ? pre.data : null;
  if (preData) {
    [preData.other, preData.futureVisits].forEach((text) =>
      parseVisitLines(text).forEach(({ key, services }) => {
        visit(key);
        services.forEach((s) => addService(key, s));
      })
    );
  }

  // Today's appointment from the live schedule
  const ids = [patient.pttId, patient.id].filter(Boolean).map((s) => s.toLowerCase());
  ((day && day.appointments) || [])
    .filter((a) => a.patientId
      ? ids.includes(a.patientId.toLowerCase())
      : (a.patientName || "").toLowerCase() === patient.name.toLowerCase())
    .forEach((a) => {
      const names = a.services && a.services.length ? a.services : ["Appointment"];
      names.forEach((name) => addService(todayKey, { name, staff: a.staff || "", time: a.time || "" }));
    });

  // Badges
  if (recs) {
    recs.treatments.forEach((t) => {
      if (t.date) visit(toDateKey(t.date)).badges.push({ type: "tx", label: "Treatment record", link: t.link });
    });
    recs.consents.forEach((c) => {
      if (c.date) visit(toDateKey(c.date)).badges.push({ type: "consent", label: `Consent Form · ${c.title}`, link: c.link });
    });
  }
  (transcripts || []).forEach((t) => {
    if (!t.date) return;
    const v = visit(toDateKey(t.date));
    v.badges.push({ type: "summary", label: `Summary${t.staff ? ` · ${t.staff}` : ""}`, id: t.id });
    if (extractSection(t.soap, "TREATMENT PLAN")) v.badges.push({ type: "plan", label: "Treatment plan" });
  });
  ((skincare && skincare.protocols) || []).forEach((p) => {
    if (!parseDateKey(p.date)) return;
    const v = visit(p.date);
    if (!v.badges.some((b) => b.type === "ssp")) v.badges.push({ type: "ssp", label: "Skin Script Protocol" });
  });

  // Status, display date, search text
  const all = [...map.values()].map((v) => {
    const d = parseDateKey(v.key);
    v.status = v.key > todayKey ? "upcoming" : v.key === todayKey ? "today" : "past";
    v.dateLabel = `${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
    v.search = [v.dateLabel, v.key, ...v.services.map((s) => `${s.name} ${s.staff}`), ...v.badges.map((b) => b.label)]
      .join(" ").toLowerCase();
    return v;
  });

  const upcoming = all.filter((v) => v.status === "upcoming").sort((a, b) => a.key.localeCompare(b.key));
  const todayList = all.filter((v) => v.status === "today");
  const past = all.filter((v) => v.status === "past").sort((a, b) => b.key.localeCompare(a.key));

  return { all: [...upcoming, ...todayList, ...past], upcoming, todayList, past, failed };
}

/* ===================== Layout ===================== */

export function historySectionHtml() {
  const open = isOpenSaved("history", true) ? "open" : "";
  return `
    <details class="hv-section" data-key="history" ${open}>
      <summary>
        <span class="hv-head-left">
          <span class="hv-icon">${ICONS.clock}</span>
          <span class="hv-title">Appointment History / Notes</span>
          <span class="hv-count">…</span>
        </span>
        ${ICONS.chev}
      </summary>
      <div class="hv-body">
        <label class="hv-search">
          ${ICONS.search}
          <input type="search" placeholder="Search appointments or notes…" aria-label="Search appointments or notes" autocomplete="off" />
        </label>
        <div class="hv-list"><div class="skeleton sm"></div></div>
      </div>
    </details>`;
}

/* ===================== Behaviour ===================== */

export function mountHistory(root, patient) {
  const section = root.querySelector(".hv-section");
  if (!section) return;
  const list = section.querySelector(".hv-list");
  const input = section.querySelector(".hv-search input");
  const count = section.querySelector(".hv-count");

  let data = null;
  let loading = false;
  let shown = PAGE;
  let term = "";

  async function load() {
    if (data || loading) return;
    loading = true;
    try {
      data = await buildVisits(patient);
      if (!section.isConnected) return;
      count.textContent = data.all.length;
      render();
    } catch (err) {
      if (!section.isConnected) return;
      console.error("History load failed:", err);
      list.innerHTML = `<p class="hv-empty">Couldn't load appointment history.</p>`;
    } finally {
      loading = false;
    }
  }

  function render() {
    const items = term
      ? data.all.filter((v) => v.search.includes(term))
      : [...data.upcoming, ...data.todayList, ...data.past.slice(0, shown)];
    const remaining = term ? 0 : Math.max(0, data.past.length - shown);

    list.innerHTML =
      (data.failed ? `<p class="hv-note">Some records couldn't be loaded, so badges may be incomplete.</p>` : "") +
      (items.length
        ? `<div class="hv-grid">${items.map(visitCard).join("")}</div>`
        : `<p class="hv-empty">${term ? "No appointments match your search." : "No appointment history yet."}</p>`) +
      (remaining
        ? `<button type="button" class="hv-more" data-hv-action="more">Load more (${remaining} remaining)</button>`
        : "");
  }

  section.addEventListener("toggle", () => { if (section.open) load(); });

  let debounce;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      term = input.value.trim().toLowerCase();
      if (data) render();
    }, 200);
  });

  section.addEventListener("click", (e) => {
    if (e.target.closest("[data-hv-action='more']")) {
      shown += PAGE;
      render();
      return;
    }
    const summary = e.target.closest("[data-hv-summary]");
    if (summary && summary.dataset.hvSummary) { showSoapPanel(summary.dataset.hvSummary); return; }
    const jump = e.target.closest("[data-hv-jump]");
    if (jump) jumpTo(root, jump.dataset.hvJump);
  });

  if (section.open) load();
}

function jumpTo(root, target) {
  if (target === "plan") {
    const d = root.querySelector('details[data-key="tp-section"]');
    if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
  if (target === "ssp") {
    const grid = root.querySelector(".sk-grid");
    const card = grid && grid.querySelector(".sk-card");
    if (card) { card.open = true; grid.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
}

/* ===================== Templates ===================== */

const STATUS_LABEL = { past: "Past visit", today: "Today's visit", upcoming: "Upcoming" };

function badgeHtml(b) {
  const icon = { tx: ICONS.doc, consent: ICONS.consent, summary: ICONS.summary, plan: ICONS.plan, ssp: ICONS.ssp }[b.type];
  const inner = `${icon}<span>${escapeHtml(b.label)}</span>`;

  if ((b.type === "tx" || b.type === "consent") && /^https:\/\//i.test(b.link || "")) {
    return `<a class="hv-badge b-${b.type}" href="${escapeHtml(b.link)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  }
  if (b.type === "plan") return `<button type="button" class="hv-badge b-plan" data-hv-jump="plan">${inner}</button>`;
  if (b.type === "ssp") return `<button type="button" class="hv-badge b-ssp" data-hv-jump="ssp">${inner}</button>`;
  if (b.type === "summary") return `<button type="button" class="hv-badge b-summary" data-hv-summary="${escapeHtml(b.id || "")}">${inner}</button>`;
  return `<span class="hv-badge b-${b.type}">${inner}</span>`;
}

function visitCard(v) {
  const services = v.services.map((s) => `
    <li>${ICONS.cal}
      <span class="hv-svc">${s.time ? `${escapeHtml(s.time)} · ` : ""}<b>${escapeHtml(s.name)}</b>${
        s.staff ? `<span class="hv-staff"> · ${escapeHtml(s.staff)}</span>` : ""}</span>
    </li>`).join("");

  return `
    <article class="hv-card hv-${v.status}">
      <header class="hv-head">
        <h4>${escapeHtml(v.dateLabel)}</h4>
        <span class="hv-tag hv-tag-${v.status}">${STATUS_LABEL[v.status]}</span>
        <button type="button" class="hv-edit" data-soon="Edit visit notes" aria-label="Edit visit notes">${ICONS.edit}</button>
      </header>
      ${services ? `<ul class="hv-services">${services}</ul>` : ""}
      ${v.badges.length ? `<div class="hv-badges">${v.badges.map(badgeHtml).join("")}</div>` : ""}
    </article>`;
}