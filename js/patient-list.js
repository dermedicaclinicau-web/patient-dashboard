import { countPatients, fetchAllPatients, phoneCore } from "./patients.js";
import {
  escapeHtml, getInitials, hueFromString, formatDobLong, calcAge, formatMobile, showToast, parseDateKey,
} from "./utils.js";

const CLIENT_PAGE = 24;
const GROUP_PAGE = 15;

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  refresh: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  mail: svg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  phone: svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>'),
};

const PLACEHOLDERS = {
  name: "Search by name or email…",
  dupes: "Filter duplicates by name or email…",
};

/* ===================== In-memory cache (cleared on logout, refresh, or a patient edit) ===================== */

let allCache = null;
let allPromise = null;
let countCache = null;
let cacheGen = 0;

export function clearPatientCache() {
  cacheGen++;
  allCache = null;
  allPromise = null;
  countCache = null;
}

// A patient's name or email was edited somewhere in the app: reload the list next time
window.addEventListener("patient-updated", clearPatientCache);

function loadAll() {
  if (allCache) return Promise.resolve(allCache);
  if (!allPromise) {
    const gen = cacheGen;
    allPromise = fetchAllPatients()
      .then((list) => {
        list.forEach(indexPatient);
        if (gen === cacheGen) allCache = list;
        return list;
      })
      .catch((err) => { allPromise = null; throw err; });
  }
  return allPromise;
}

/* ===================== Search ===================== */

// "  O'Brien-Smith, Zoë " -> "obrien smith zoe"
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // accents
    .replace(/['’`.]/g, "")                             // apostrophes, full stops
    .replace(/[^a-z0-9]+/g, " ")                        // commas, hyphens, etc. -> space
    .trim();
}

// Pre-computed once per patient so typing stays instant
function indexPatient(p) {
  p._name = normName(p.name);                                       // "tamara poletti"
  p._alt = normName(p.nameKey) || normName(`${p.lastName} ${p.firstName}`); // "poletti tamara"
  p._words = [...new Set(`${p._name} ${p._alt}`.split(" ").filter(Boolean))];
  p._email = String(p.email || "").toLowerCase().replace(/\s+/g, "");
}

function buildQuery(term) {
  const text = normName(term);
  return {
    text,
    tokens: text ? text.split(" ") : [],
    email: String(term || "").toLowerCase().replace(/\s+/g, ""),
  };
}

// Lower = better match. Infinity = no match.
function scorePatient(p, q) {
  if (!q.text && !q.email) return 0;

  if (q.text) {
    if (p._name === q.text || p._alt === q.text) return 0;                         // exact name
    if (p._name.startsWith(q.text) || p._alt.startsWith(q.text)) return 1;         // starts with
    if (q.tokens.every((t) => p._words.some((w) => w.startsWith(t)))) return 2;    // "tam pol", any order
    if (q.tokens.every((t) => p._name.includes(t) || p._alt.includes(t))) return 3; // anywhere in the name
  }
  if (q.email.length >= 2 && p._email && p._email.includes(q.email)) return 4;     // any part of the email
  return Infinity;
}

/* ===================== Page ===================== */

export function mountPatientList(container) {
  container.innerHTML = `
    <section class="page wide pt-page">
      <div class="pt-head">
        <div class="pt-title"><h2>Patients</h2><span class="pt-total"></span></div>
        <div class="pt-actions">
          <button type="button" class="icon-btn pt-refresh" title="Refresh" aria-label="Refresh">${ICONS.refresh}</button>
          <button type="button" class="pt-new">${ICONS.plus}New Patient</button>
        </div>
      </div>

      <div class="pt-toolbar">
        <label class="pt-search">${ICONS.search}
          <input type="search" placeholder="${PLACEHOLDERS.name}" autocomplete="off" spellcheck="false" aria-label="Search patients" />
        </label>
        <div class="pt-tabs" role="group" aria-label="Search mode">
          <button type="button" data-mode="name" class="active" aria-pressed="true">Name / Email</button>
          <button type="button" data-mode="dupes" class="dupes" aria-pressed="false">Duplicates</button>
        </div>
        <select class="pt-select" data-filter="birthday" aria-label="Birthday filter">
          <option value="all">All Birthdays</option>
          <option value="today">Birthdays today</option>
          <option value="week">Next 7 days</option>
          <option value="month">This month</option>
        </select>
        <select class="pt-select" data-filter="age" aria-label="Age filter">
          <option value="all">All Ages</option>
          <option value="0-24">Under 25</option>
          <option value="25-34">25–34</option>
          <option value="35-44">35–44</option>
          <option value="45-54">45–54</option>
          <option value="55-200">55+</option>
        </select>
      </div>

      <p class="pt-meta" aria-live="polite"></p>
      <div class="pt-results"></div>
      <div class="pt-footer"><button type="button" class="btn-ghost pt-more" hidden>Load more</button></div>
    </section>`;

  const q = (s) => container.querySelector(s);
  const input = q(".pt-search input");
  const tabs = container.querySelectorAll(".pt-tabs button");
  const selects = container.querySelectorAll(".pt-select");
  const total = q(".pt-total");
  const meta = q(".pt-meta");
  const results = q(".pt-results");
  const moreBtn = q(".pt-more");
  const refreshBtn = q(".pt-refresh");

  const state = {
    mode: "name", term: "", birthday: "all", age: "all", seq: 0,
    client: { list: [], shown: CLIENT_PAGE, groups: null, shownGroups: GROUP_PAGE },
  };

  /* ---------- total count ---------- */
  async function loadCount() {
    try {
      if (countCache === null) countCache = await countPatients();
      if (total.isConnected) total.textContent = `${countCache.toLocaleString()} patients`;
    } catch (err) {
      console.warn("Patient count failed:", err);
    }
  }

  /* ---------- main loader ---------- */
  async function run() {
    const seq = ++state.seq;
    if (!allCache) {
      results.innerHTML = skeletonGrid(8);
      moreBtn.hidden = true;
      meta.textContent = "Loading patients…";
    }

    try {
      const all = await loadAll();
      if (seq !== state.seq || !results.isConnected) return;
      render(all);
    } catch (err) {
      if (seq !== state.seq) return;
      console.error("Patient list failed:", err);
      meta.textContent = "";
      results.innerHTML = errorState(err);
    }
  }

  function render(all) {
    const today = new Date();
    const query = buildQuery(state.term);
    let list = all.filter((p) => birthdayOk(p, state.birthday, today) && ageOk(p, state.age));

    if (state.mode === "dupes") {
      let groups = findDuplicates(list);
      if (state.term) groups = groups.filter((g) => g.list.some((p) => scorePatient(p, query) < Infinity));
      state.client.groups = groups;
      state.client.shownGroups = GROUP_PAGE;
      renderGroups();
      return;
    }

    if (state.term) {
      // Best matches first, then A–Z by surname
      list = list
        .map((p) => ({ p, s: scorePatient(p, query) }))
        .filter((x) => x.s < Infinity)
        .sort((a, b) => a.s - b.s || a.p._alt.localeCompare(b.p._alt))
        .map((x) => x.p);
    } else if (state.birthday !== "all") {
      list.sort((a, b) => nextBirthday(a, today) - nextBirthday(b, today));
    }

    state.client.list = list;
    state.client.shown = CLIENT_PAGE;
    renderClientPage();
  }

  function renderClientPage() {
    const { list, shown } = state.client;
    results.innerHTML = list.length
      ? `<ul class="pt-grid">${list.slice(0, shown).map(cardHtml).join("")}</ul>`
      : emptyState();
    moreBtn.hidden = list.length <= shown;

    const n = list.length.toLocaleString();
    const filtered = state.birthday !== "all" || state.age !== "all";
    meta.textContent = state.term
      ? `${n} result${list.length === 1 ? "" : "s"} for “${state.term}”`
      : filtered ? `${n} patient${list.length === 1 ? "" : "s"} match` : "";
  }

  function renderGroups() {
    const { groups, shownGroups } = state.client;
    results.innerHTML = groups.length
      ? groups.slice(0, shownGroups).map((g) => `
          <section class="pt-dupe">
            <p class="pt-dupe-head">
              <span class="pt-dupe-tag">${escapeHtml(g.label)}</span>
              <span>${escapeHtml(g.display)}</span>
              <span class="pt-dupe-count">· ${g.list.length} records</span>
            </p>
            <ul class="pt-grid">${g.list.map(cardHtml).join("")}</ul>
          </section>`).join("")
      : `<div class="state"><strong>No duplicates found</strong>No patients share the same name and date of birth, email or phone.</div>`;
    moreBtn.hidden = groups.length <= shownGroups;
    meta.textContent = `${groups.length} possible duplicate group${groups.length === 1 ? "" : "s"}`;
  }

  function emptyState() {
    const tip = state.term
      ? "Check the spelling, or try part of the first name, surname or email."
      : "Try a different filter.";
    return `<div class="state"><strong>No patients found</strong>${tip}</div>`;
  }

  /* ---------- events ---------- */
  let debounce;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const term = input.value.trim();
      if (term === state.term) return;
      state.term = term;
      run();
    }, 150);
  });

  tabs.forEach((btn) => btn.addEventListener("click", () => {
    if (btn.dataset.mode === state.mode) return;
    state.mode = btn.dataset.mode;
    tabs.forEach((b) => {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    input.placeholder = PLACEHOLDERS[state.mode];
    input.focus();
    run();
  }));

  selects.forEach((sel) => sel.addEventListener("change", () => {
    state[sel.dataset.filter] = sel.value;
    sel.classList.toggle("active", sel.value !== "all");
    run();
  }));

  moreBtn.addEventListener("click", () => {
    if (state.mode === "dupes") { state.client.shownGroups += GROUP_PAGE; renderGroups(); }
    else { state.client.shown += CLIENT_PAGE; renderClientPage(); }
  });

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.classList.add("is-loading");
    refreshBtn.disabled = true;
    clearPatientCache();
    await Promise.allSettled([loadCount(), run()]);
    refreshBtn.classList.remove("is-loading");
    refreshBtn.disabled = false;
  });

  q(".pt-new").addEventListener("click", () => showToast("New patient: coming soon"));

  results.addEventListener("click", (e) => {
    if (e.target.closest("[data-action='retry']")) run();
  });

  loadCount();
  run();
}

/* ===================== Filters ===================== */

function nextBirthday(p, today) {
  const d = parseDateKey(p.dobKey);
  if (!d) return Infinity;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let b = new Date(today.getFullYear(), d.getMonth(), d.getDate());
  if (b < start) b = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
  return b.getTime();
}

function birthdayOk(p, filter, today) {
  if (filter === "all") return true;
  const d = parseDateKey(p.dobKey);
  if (!d) return false;
  if (filter === "today") return d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (filter === "month") return d.getMonth() === today.getMonth();
  if (filter === "week") {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const days = (nextBirthday(p, today) - start) / 86_400_000;
    return days >= 0 && days < 7;
  }
  return true;
}

function ageOk(p, filter) {
  if (filter === "all") return true;
  const [lo, hi] = filter.split("-").map(Number);
  const age = calcAge(p.dobKey);
  return age !== null && age >= lo && age <= hi;
}

function findDuplicates(list) {
  const rules = [
    ["Same name & date of birth", (p) => (p.nameKey && p.dobKey ? `${p.nameKey}|${p.dobKey}` : ""),
      (p) => `${p.name} · ${formatDobLong(p.dobKey)}`],
    ["Same email", (p) => String(p.email || "").trim().toLowerCase(), (p) => p.email],
    ["Same phone", (p) => { const c = phoneCore(p.mobile); return c.length >= 8 ? c : ""; },
      (p) => formatMobile(p.mobile)],
  ];

  const groups = [];
  rules.forEach(([label, keyFn, displayFn]) => {
    const map = new Map();
    list.forEach((p) => {
      const k = keyFn(p);
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    });
    map.forEach((members) => {
      if (members.length > 1) groups.push({ label, display: displayFn(members[0]), list: members });
    });
  });
  return groups;
}

/* ===================== Templates ===================== */

function cardHtml(p) {
  const age = calcAge(p.dobKey);
  const dob = p.dobKey ? `${formatDobLong(p.dobKey)}${age !== null ? ` · ${age} yrs` : ""}` : "";
  return `
    <li>
      <a class="pt-card" href="#/patient/${encodeURIComponent(p.id)}">
        <div class="pt-card-top">
          <span class="pt-avatar" style="--h:${hueFromString(p.name)}">${escapeHtml(getInitials(p.name))}</span>
          <div class="pt-ident">
            <span class="pt-name">${escapeHtml(p.name)}</span>
            <span class="pt-id">ID ${escapeHtml(p.pttId || p.id)}</span>
          </div>
        </div>
        <div class="pt-contact">
          <span>${ICONS.mail}<span class="t">${p.email ? escapeHtml(p.email) : "<em>No email</em>"}</span></span>
          <span>${ICONS.phone}<span class="t">${p.mobile ? escapeHtml(formatMobile(p.mobile)) : "<em>No mobile</em>"}</span></span>
        </div>
        <div class="pt-foot">${escapeHtml(dob)}</div>
      </a>
    </li>`;
}

function skeletonGrid(n) {
  return `<ul class="pt-grid">${`<li class="skeleton pt-skel"></li>`.repeat(n)}</ul>`;
}

function errorState(err) {
  const msg = err && err.code === "permission-denied"
    ? "You don't have permission to view patients. Check the Firestore rules."
    : "Couldn't load patients. Check your connection and try again.";
  return `<div class="state error"><strong>Something went wrong</strong>${msg}<br>
    <button type="button" class="btn-ghost sm retry" data-action="retry">Try again</button></div>`;
}