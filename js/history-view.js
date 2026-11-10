import { fetchPreconsult, fetchDayAppointments } from "./appointments.js";
import { fetchPatientRecords } from "./records.js";
import { fetchTranscriptRecords, extractSection } from "./transcripts.js";
import { fetchSkincare } from "./skincare.js";
import { escapeHtml, toDateKey, parseDateKey, showToast } from "./utils.js";
import { showSoapPanel } from "./soap-panel.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { patientIds } from "./patients.js";
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
  consent: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 14l2 2 4-4"/>'),
  alert: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  summary: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  plan: svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  ssp: svg('<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>'),
  merge: svg('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),
};

function isOpenSaved(key, fallback) {
  try {
    const s = JSON.parse(localStorage.getItem("pd-open-sections")) || {};
    return key in s ? !!s[key] : fallback;
  } catch { return fallback; }
}

const pad = (n) => String(n).padStart(2, "0");
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Injectables visits should have a treatment record (reviews don't)
const INJ_RE = /wrinkle relaxer|\bWR\b|\bfiller\b|radiesse|belotero|juvederm|profhilo|sculptra|skin ?booster|hydra repair|collagen growth|xeomin|botox|dysport|hyalase/i;
const REVIEW_RE = /^review\b/i;

// Words that don't say which treatment it was: left out before shortening
const TX_FILLER = /^(treatment|treatments|record|records|form|forms|consent|tx|txr|the|and|of|for|new|old|v\d+|\d+)$/i;

// A treatment record's form name, shortened for its badge:
// one word → its first 3 letters ("Ultherapy" → "Ult"); several → their initials ("Wrinkle Relaxer" → "WR").
// Short capitals stay as written ("OPL", "IPL"). "" when only filler words are left.
export function txShort(title) {
  const words = String(title || "")
    .split(/[\s/&+,·()[\]\-–—]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter((w) => w && !TX_FILLER.test(w));
  if (!words.length) return "";
  if (words.length === 1) {
    const w = words[0];
    if (/^[A-Z0-9]{2,4}$/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1, 3).toLowerCase();
  }
  return words.slice(0, 3).map((w) => w.charAt(0).toUpperCase()).join("");
}

// "No treatment record" only from this day: the same setting as Past appointments (ui_settings/records → txCheckFrom, "" = off)
const TX_CHECK_DEFAULT = "2026-07-01";
let txCheckLoad = null;
function loadTxCheckFrom() {
  if (!txCheckLoad) {
    txCheckLoad = getDoc(doc(db, "ui_settings", "records"))
      .then((snap) => {
        const v = snap.exists() ? snap.data().txCheckFrom : undefined;
        return v === "" || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : TX_CHECK_DEFAULT;
      })
      .catch(() => TX_CHECK_DEFAULT);
  }
  return txCheckLoad;
}

// "4 months ago", "in 2 weeks", "Yesterday"
function relDay(key, todayKey) {
  const days = Math.round((parseDateKey(key) - parseDateKey(todayKey)) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const n = Math.abs(days);
  const y = Math.floor(n / 365.25);
  const txt = n < 14 ? `${n} days`
    : n < 63 ? `${Math.round(n / 7)} weeks`
    : n < 365 ? `${Math.max(2, Math.round(n / 30.4))} months`
    : `${y} year${y === 1 ? "" : "s"}`;
  return days > 0 ? `in ${txt}` : `${txt} ago`;
}

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
    loadTxCheckFrom(),
  ]);
  results.forEach((r) => { if (r.status === "rejected") console.error("History source failed:", r.reason); });
  const [pre, day, recs, transcripts, skincare, txFrom] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
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
      const ids = patientIds(patient).map((s) => s.toLowerCase());
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
      if (!t.date) return;
      const short = txShort(t.title);
      visit(toDateKey(t.date)).badges.push({
        type: "tx", label: short ? `Txr - ${short}` : "Treatment record",
        full: short ? `Treatment record · ${t.title}` : "Treatment record",   // shown on hover
        link: t.link, portalId: t.portalId || "",
      });
    });
    recs.consents.forEach((c) => {
      if (c.date) visit(toDateKey(c.date)).badges.push({ type: "consent", label: `Consent Form · ${c.title}`, link: c.link, portalId: c.portalId || "" });
    });
  }
  // Consultation summaries, grouped by day + clinician so same-day recordings can be merged.
  // Clinician = staff UID when the record has one; older records fall back to the first name.
  const groups = new Map();
  (transcripts || []).forEach((t) => {
    if (!t.date) return;
    const key = toDateKey(t.date);
    const clin = t.staffUid || String(t.staff || "").trim().split(/\s+/)[0].toLowerCase();
    const gk = `${key}|${clin}`;
    if (!groups.has(gk)) groups.set(gk, { key, items: [] });
    groups.get(gk).items.push(t);
  });
  groups.forEach(({ key, items }) => {
    const v = visit(key);
    items.sort((a, b) => a.date.getTime() - b.date.getTime()); // earliest recording first
    items.forEach((t) => {
      const n = (t.mergedFrom || []).length + 1;
      v.badges.push({
        type: "summary", id: t.id,
        status: /^reviewed$/i.test(String(t.status || "")) ? "reviewed" : "draft",   // anything not Reviewed is still a Draft
        label: `Summary${t.staff ? ` · ${t.staff}` : ""}${n > 1 ? ` (${n} recordings)` : ""}`,
      });
    });
    // Only Drafts can be merged (the server refuses Reviewed notes)
    const allDraft = items.every((t) => !/^reviewed$/i.test(t.status || "Draft"));
    if (items.length > 1 && allDraft) {
      v.badges.push({ type: "merge", label: `Merge ${items.length} summaries`, ids: items.map((t) => t.id) });
    }
    if (items.some((t) => extractSection(t.soap, "TREATMENT PLAN")) && !v.badges.some((b) => b.type === "plan")) {
      v.badges.push({ type: "plan", label: "Treatment plan" });
    }
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
    v.day = d.getDate();
    v.mon = MONTHS_SHORT[d.getMonth()];
    v.year = d.getFullYear();
    v.weekday = WEEKDAYS[d.getDay()];
    v.rel = relDay(v.key, todayKey);
    v.inj = v.services.some((s) => INJ_RE.test(s.name) && !REVIEW_RE.test(s.name));
    v.notes = v.badges.some((b) => b.type === "summary");
    // Only when the treatment records actually loaded, so a failed load never shows false warnings
    v.missing = !!recs && !!txFrom && v.status === "past" && v.key >= txFrom && v.inj && !v.badges.some((b) => b.type === "tx");
    v.search = [v.dateLabel, v.key, v.weekday, ...v.services.map((s) => `${s.name} ${s.staff}`),
      ...v.badges.map((b) => `${b.label} ${b.full || ""} ${b.status || ""}`), v.missing ? "missing no treatment record" : ""]
      .join(" ").toLowerCase();
    return v;
  });

  const upcoming = all.filter((v) => v.status === "upcoming").sort((a, b) => a.key.localeCompare(b.key));
  const todayList = all.filter((v) => v.status === "today");
  const past = all.filter((v) => v.status === "past").sort((a, b) => b.key.localeCompare(a.key));

  return { all: [...todayList, ...upcoming, ...past], upcoming, todayList, past, failed };
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
        <div class="hv-filters" role="group" aria-label="Show"></div>
        <div class="hv-list"><div class="skeleton sm"></div></div>
      </div>
    </details>`;
}

/* ===================== Behaviour ===================== */

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "notes", label: "With notes", test: (v) => v.notes },
  { id: "inj", label: "Injectables", test: (v) => v.inj },
  { id: "missing", label: "Missing records", test: (v) => v.missing, bad: true },
];

export function mountHistory(root, patient) {
  const section = root.querySelector(".hv-section");
  if (!section) return;
  const list = section.querySelector(".hv-list");
  const input = section.querySelector(".hv-search input");
  const count = section.querySelector(".hv-count");
  const filters = section.querySelector(".hv-filters");

  let data = null;
  let loading = false;
  let shown = PAGE;
  let term = "";
  let filter = "all";

  async function load() {
    if (data || loading) return;
    loading = true;
    try {
      data = await buildVisits(patient);
      if (!section.isConnected) return;
      count.textContent = data.all.length;
      renderFilters();
      render();
    } catch (err) {
      if (!section.isConnected) return;
      console.error("History load failed:", err);
      list.innerHTML = `<p class="hv-empty">Couldn't load appointment history.</p>`;
    } finally {
      loading = false;
    }
  }

  // Only chips with something in them (and the one chosen) show; just "All" on its own isn't shown
  function renderFilters() {
    if (!filters || !data) return;
    const chips = FILTERS.map((f) => {
      const n = f.id === "all" ? data.all.length : data.all.filter(f.test).length;
      if (f.id !== "all" && !n && f.id !== filter) return "";
      return `<button type="button" class="hv-chip${f.bad && n ? " is-bad" : ""}" data-hv-filter="${f.id}"
        aria-pressed="${f.id === filter}">${escapeHtml(f.label)}<em>${n}</em></button>`;
    }).filter(Boolean);
    filters.innerHTML = chips.length > 1 ? chips.join("") : "";
  }

  function render() {
    const test = (FILTERS.find((f) => f.id === filter) || FILTERS[0]).test;
    const ok = (v) => test(v) && (!term || v.search.includes(term));
    const soon = [...data.todayList, ...data.upcoming].filter(ok);
    const pastAll = data.past.filter(ok);
    const past = term ? pastAll : pastAll.slice(0, shown);
    const remaining = pastAll.length - past.length;

    // Past visits by year (newest first); the count is the whole year, not just what's shown
    const perYear = new Map();
    pastAll.forEach((v) => perYear.set(v.year, (perYear.get(v.year) || 0) + 1));
    const groups = [];
    past.forEach((v) => {
      const g = groups[groups.length - 1];
      if (g && g.year === v.year) g.items.push(v);
      else groups.push({ year: v.year, items: [v] });
    });

    const head = (title, n) => `<h5 class="hv-ghead"><span>${escapeHtml(title)}</span><em>${n} visit${n === 1 ? "" : "s"}</em></h5>`;
    const grid = (items) => `<div class="hv-grid">${items.map(visitCard).join("")}</div>`;
    const html = [
      soon.length ? `<section class="hv-group is-soon">${
        head(data.todayList.some(ok) ? "Today & coming up" : "Coming up", soon.length)}${grid(soon)}</section>` : "",
      ...groups.map((g) => `<section class="hv-group">${head(String(g.year), perYear.get(g.year))}${grid(g.items)}</section>`),
    ].join("");

    const none = term ? "No appointments match your search."
      : filter !== "all" ? "No visits match this filter." : "No appointment history yet.";
    list.innerHTML =
      (data.failed ? `<p class="hv-note">Some records couldn't be loaded, so badges may be incomplete.</p>` : "") +
      (html ? `<div class="hv-groups">${html}</div>` : `<p class="hv-empty">${none}</p>`) +
      (remaining > 0 ? `<button type="button" class="hv-more" data-hv-action="more">Load more (${remaining} remaining)</button>` : "");
  }

  section.addEventListener("toggle", () => { if (section.open) load(); });

  // Notes saved in their own tab: this badge changes to Draft / Reviewed straight away
  let notesBc = null;
  try { notesBc = new BroadcastChannel("dm-notes"); } catch { notesBc = null; }
  if (notesBc) notesBc.onmessage = (e) => {
    if (!section.isConnected) { notesBc.close(); return; }
    const m = e.data || {};
    if (m.type !== "notes-saved" || !data) return;
    let hit = false;
    data.all.forEach((v) => v.badges.forEach((b) => {
      if (b.type === "summary" && b.id === m.id && b.status !== m.status) { b.status = m.status; hit = true; }
    }));
    if (hit) render();
  };

  let debounce;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      term = input.value.trim().toLowerCase();
      if (data) render();
    }, 200);
  });

  section.addEventListener("click", (e) => {
    const fb = e.target.closest("[data-hv-filter]");
    if (fb) {
      const hadFocus = document.activeElement === fb;
      filter = fb.dataset.hvFilter;
      shown = PAGE;
      renderFilters();
      render();
      if (hadFocus) {
        const again = filters.querySelector(`[data-hv-filter="${filter}"]`);
        if (again) again.focus({ preventScroll: true });   // keyboard users stay on the chip
      }
      return;
    }
    if (e.target.closest("[data-hv-action='more']")) {
      shown += PAGE;
      render();
      return;
    }
    const merge = e.target.closest("[data-hv-merge]");
    if (merge) { mergeSummaries(merge); return; }
    const summary = e.target.closest("[data-hv-summary]");
    if (summary && summary.dataset.hvSummary) { showSoapPanel(summary.dataset.hvSummary); return; }
    const jump = e.target.closest("[data-hv-jump]");
    if (jump) jumpTo(root, jump.dataset.hvJump);
  });

  if (section.open) load();
}

// Same patient, same day, same clinician: one set of notes from all the transcripts
async function mergeSummaries(btn) {
  let ids = [];
  try { ids = JSON.parse(btn.dataset.hvMerge || "[]"); } catch { /* malformed */ }
  if (ids.length < 2) return;

  if (!(await confirmDialog({
    title: `Merge ${ids.length} consultation summaries?`,
    message: "The transcripts will be combined and the notes written again as one Draft.\n\n" +
      "Nothing is deleted: the later recordings are kept and marked as merged into the first one.",
    confirmLabel: "Merge",
    tone: "info",
  }))) return;

  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Merging…";

  const run = async (force) => {
    try {
      const res = await callApi({ action: "mergeConsults", recordIds: ids, force: !!force });
      showToast("Summaries merged");
      // Reload the patient page so every section (history, plans, social history) picks up the kept record
      if (location.hash.startsWith("#/patient/")) window.dispatchEvent(new HashChangeEvent("hashchange"));
      if (res && res.transcriptId) showSoapPanel(res.transcriptId, { mode: "open" });
    } catch (err) {
      console.error("Merge failed:", err.code || "(no code)", err.detail || "", err);
      if (err.code === "DIFFERENT_DAY_OR_STAFF" && !force && await confirmDialog({
        title: "Not the same day or clinician",
        message: "The server doesn't see these as the same consultation (different day, or the clinician name doesn't match).\n\nMerge them anyway?",
        confirmLabel: "Merge anyway",
        tone: "warning",
      })) { await run(true); return; }
      const messages = {
        REVIEWED: "Reviewed notes can't be merged. Save them as Draft first.",
        DIFFERENT_DAY_OR_STAFF: "These recordings aren't from the same day and clinician.",
        BUSY: "One of these records is being worked on. Please try again in a moment.",
        NOT_FOUND: "One of these records no longer exists.",
        GEMINI_FAILED: "Gemini couldn't write the merged notes just now. Please try again.",
        UNAUTHORIZED: "Your session has expired. Please log in again.",
      };
      showToast(messages[err.code] || `Couldn't merge${err.detail ? `: ${err.detail}` : ""}. Please try again.`);
      if (btn.isConnected) { btn.disabled = false; btn.innerHTML = label; }
    }
  };
  await run(false);
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

const STATUS_LABEL = { today: "Today", upcoming: "Upcoming" };   // past visits sit under their year, so they don't need a tag

function badgeHtml(b) {
  
  const icon = { tx: ICONS.doc, consent: ICONS.consent, summary: ICONS.summary, plan: ICONS.plan, ssp: ICONS.ssp, merge: ICONS.merge }[b.type];
  const inner = `${icon}<span>${escapeHtml(b.label)}</span>`;
  // Shortened badges: the full name on hover, and read out in full by screen readers
  const tip = b.full ? ` title="${escapeHtml(b.full)}" aria-label="${escapeHtml(b.full)}"` : "";

  if (b.type === "tx" || b.type === "consent") {
    // Made in the portal: open the saved form (same as the Past appointments badges)
    if (b.portalId) {
      return `<a class="hv-badge b-${b.type}" href="#/form-record/${encodeURIComponent(b.portalId)}" target="_blank" rel="noopener"${tip}>${inner}</a>`;
    }
    // From the old app: open its PDF in a new tab
    if (/^https:\/\//i.test(b.link || "")) {
      return `<a class="hv-badge b-${b.type}" href="${escapeHtml(b.link)}" target="_blank" rel="noopener noreferrer"${tip}>${inner}</a>`;
    }
  }
  if (b.type === "plan") return `<button type="button" class="hv-badge b-plan" data-hv-jump="plan">${inner}</button>`;
  if (b.type === "ssp") return `<button type="button" class="hv-badge b-ssp" data-hv-jump="ssp">${inner}</button>`;
  if (b.type === "summary") {
    const reviewed = b.status === "reviewed";
    // Drafts are shown by their brown colour, so only Reviewed gets a word
    return `<button type="button" class="hv-badge b-summary ${reviewed ? "is-reviewed" : "is-draft"}" data-hv-summary="${escapeHtml(b.id || "")}"
      title="${reviewed ? "Reviewed notes" : "Draft: these notes haven't been reviewed yet"}">${inner}</button>`;
  }
  if (b.type === "merge") return `<button type="button" class="hv-badge b-merge" data-hv-merge="${escapeHtml(JSON.stringify(b.ids || []))}" title="Combine these recordings into one set of notes">${inner}</button>`;
  return `<span class="hv-badge b-${b.type}"${tip}>${inner}</span>`;
}

function visitCard(v) {
  const services = v.services.map((s) => `
    <li>${ICONS.cal}
      <span class="hv-svc">${s.time ? `${escapeHtml(s.time)} · ` : ""}<b>${escapeHtml(s.name)}</b>${
        s.staff ? `<span class="hv-staff"> · ${escapeHtml(s.staff)}</span>` : ""}</span>
    </li>`).join("");

  // The year is only needed when the group header doesn't already say it
  const year = v.status !== "past" && v.year !== new Date().getFullYear() ? `<small>${v.year}</small>` : "";
  const rel = v.status === "today" ? "" : v.rel;
  const missing = v.missing
    ? `<span class="hv-badge b-missing" title="Injectables were booked but there's no treatment record for this day">${ICONS.alert}<span>No treatment record</span></span>`
    : "";
  const badges = v.badges.map(badgeHtml).join("") + missing;

  return `
    <article class="hv-card hv-${v.status}${v.missing ? " is-missing" : ""}" aria-label="${escapeHtml(v.dateLabel)}">
      <div class="hv-date" title="${escapeHtml(v.dateLabel)}"><b>${v.day}</b><span>${v.mon}</span>${year}</div>
      <div class="hv-main">
        <header class="hv-head">
          <span class="hv-when"><b>${escapeHtml(v.weekday)}</b>${rel ? `<small>${escapeHtml(rel)}</small>` : ""}</span>
          ${STATUS_LABEL[v.status] ? `<span class="hv-tag hv-tag-${v.status}">${STATUS_LABEL[v.status]}</span>` : ""}
          <button type="button" class="hv-edit" data-soon="Edit visit notes" aria-label="Edit visit notes">${ICONS.edit}</button>
        </header>
        ${services ? `<ul class="hv-services">${services}</ul>` : ""}
        ${badges ? `<div class="hv-badges">${badges}</div>` : ""}
      </div>
    </article>`;
}