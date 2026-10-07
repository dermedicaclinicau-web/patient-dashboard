import { fetchPatients } from "./patients.js";
import { escapeHtml, getInitials, formatDob, hueFromString } from "./utils.js";

const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const ICON_CHEVRON = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

const PLACEHOLDERS = {
  name: "Search by surname, e.g. Cooney",
  email: "Search by email address",
};

export function mountPatientList(container) {
  container.innerHTML = `
    <section class="page">
      <div class="page-head">
        <h2>Patients</h2>
        <p class="muted">Search for a patient to review their profile.</p>
      </div>

      <div class="toolbar">
        <label class="search-box">
          ${ICON_SEARCH}
          <input type="search" placeholder="${PLACEHOLDERS.name}" autocomplete="off"
                 spellcheck="false" aria-label="Search patients" />
        </label>
        <div class="segmented" role="group" aria-label="Search by">
          <button type="button" data-mode="name" class="active" aria-pressed="true">Name</button>
          <button type="button" data-mode="email" aria-pressed="false">Email</button>
        </div>
      </div>

      <p class="result-meta" aria-live="polite"></p>
      <ul class="patient-list"></ul>

      <div class="list-footer">
        <button type="button" class="btn-ghost load-more" hidden>Load more</button>
      </div>
    </section>`;

  const input = container.querySelector(".search-box input");
  const modeBtns = container.querySelectorAll(".segmented button");
  const meta = container.querySelector(".result-meta");
  const list = container.querySelector(".patient-list");
  const moreBtn = container.querySelector(".load-more");

  const state = { mode: "name", term: "", activeTerm: "", cursor: null, count: 0, loading: false, seq: 0 };

  async function load(reset) {
    if (!reset && state.loading) return;

    // seq makes sure a slow, outdated search can't overwrite newer results
    const seq = reset ? ++state.seq : state.seq;
    if (reset) {
      state.cursor = null;
      state.count = 0;
      state.activeTerm = state.term;
      list.innerHTML = skeletons(5);
      moreBtn.hidden = true;
      meta.textContent = "";
    }

    state.loading = true;
    moreBtn.disabled = true;
    moreBtn.textContent = "Loading…";

    try {
      const res = await fetchPatients({ mode: state.mode, term: state.activeTerm, cursor: state.cursor });
      if (seq !== state.seq) return;

      if (reset) list.innerHTML = "";
      state.activeTerm = res.term;
      state.cursor = res.cursor;
      state.count += res.patients.length;

      list.insertAdjacentHTML("beforeend", res.patients.map(patientCard).join(""));
      if (state.count === 0) list.innerHTML = emptyState(state.term, state.mode);

      moreBtn.hidden = !res.hasMore;
      meta.textContent = metaText(state.count, state.term);
    } catch (err) {
      if (seq !== state.seq) return;
      console.error("Patient list failed:", err);
      if (state.count === 0) list.innerHTML = errorState(err);
      else meta.textContent = "Couldn't load more patients. Please try again.";
    } finally {
      if (seq === state.seq) {
        state.loading = false;
        moreBtn.disabled = false;
        moreBtn.textContent = "Load more";
      }
    }
  }

  // Search as you type (waits 300ms after the last keystroke)
  let debounce;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const term = input.value.trim();
      if (term === state.term) return;
      state.term = term;
      load(true);
    }, 300);
  });

  // Name / Email toggle
  modeBtns.forEach((btn) =>
    btn.addEventListener("click", () => {
      if (btn.dataset.mode === state.mode) return;
      state.mode = btn.dataset.mode;
      modeBtns.forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      });
      input.placeholder = PLACEHOLDERS[state.mode];
      input.focus();
      load(true);
    })
  );

  // Open a patient / retry after an error
  list.addEventListener("click", (e) => {
    if (e.target.closest("[data-action='retry']")) return load(true);
    const card = e.target.closest(".patient-card");
    if (card) location.hash = `#/patient/${encodeURIComponent(card.dataset.id)}`;
  });

  moreBtn.addEventListener("click", () => load(false));

  load(true);
}

/* ---------- templates ---------- */

function patientCard(p) {
  const details = [p.email, formatDob(p.dobKey) || p.dob]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" – ");

  return `
    <li>
      <button type="button" class="patient-card" data-id="${escapeHtml(p.id)}">
        <span class="p-avatar" style="--h:${hueFromString(p.name)}">${escapeHtml(getInitials(p.name))}</span>
        <span class="p-info">
          <span class="p-name">${escapeHtml(p.name)}</span>
          <span class="p-sub">${details || "No contact details"}</span>
        </span>
        ${ICON_CHEVRON}
      </button>
    </li>`;
}

function skeletons(n) {
  return Array.from({ length: n }, () => `<li class="skeleton"></li>`).join("");
}

function metaText(count, term) {
  const s = count === 1 ? "" : "s";
  return term ? `${count} result${s} for “${term}”` : `Showing ${count} patient${s}`;
}

function emptyState(term, mode) {
  if (!term) {
    return `<li class="state"><strong>No patients yet</strong>Patients added to the system will appear here.</li>`;
  }
  const tip = mode === "name" ? "Try the surname first, e.g. “Cooney”." : "Check the spelling of the email address.";
  return `<li class="state"><strong>No patients found</strong>No match for “${escapeHtml(term)}”. ${tip}</li>`;
}

function errorState(err) {
  const msg = err && err.code === "permission-denied"
    ? "You don't have permission to view patients. Check the Firestore rules."
    : "Couldn't load patients. Check your connection and try again.";
  return `<li class="state error"><strong>Something went wrong</strong>${msg}<br>
    <button type="button" class="btn-ghost sm retry" data-action="retry">Try again</button></li>`;
}