import { createPatient, findPossibleDuplicates, phoneCore } from "./patients.js";
import { escapeHtml, formatDobLong, formatMobile, toDateKey } from "./utils.js";
import { confirmDialog } from "./dialog.js";

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  userPlus: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  alert: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
};

/* ===================== Matching ===================== */

// "  O'Brien-Smith, Zoë " -> "obrien smith zoe"
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Same person regardless of order: "Jane Smith" == "Smith Jane"
const personKey = (...parts) => normName(parts.join(" ")).split(" ").filter(Boolean).sort().join(" ");

function candidateKey(p) {
  return p.firstName || p.lastName ? personKey(p.firstName, p.lastName) : personKey(p.name);
}

// "jane SMITH" -> "Jane Smith"; "McDonald" stays as typed
function tidyName(s) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  if (t && (t === t.toLowerCase() || t === t.toUpperCase())) {
    return t.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
  }
  return t;
}

function readInput(form) {
  const f = form.elements;
  const first = tidyName(f.firstName.value);
  const last = tidyName(f.lastName.value);
  return {
    first, last,
    personKey: first && last ? personKey(first, last) : "",
    dobKey: f.dobKey.value,
    phone: phoneCore(f.mobile.value),
    email: f.email.value.trim().toLowerCase(),
  };
}

// Which details match, and how strongly
function compare(p, inp) {
  const hits = {
    name: !!inp.personKey && candidateKey(p) === inp.personKey,
    dob: !!inp.dobKey && p.dobKey === inp.dobKey,
    phone: inp.phone.length >= 8 && phoneCore(p.mobile) === inp.phone,
    email: !!inp.email && String(p.email || "").trim().toLowerCase() === inp.email,
  };
  if (!hits.name && !hits.phone && !hits.email) return null;
  return { patient: p, hits, strong: hits.name && (hits.dob || hits.phone || hits.email) };
}

function findMatches(list, inp) {
  const out = [];
  (list || []).forEach((p) => { const m = compare(p, inp); if (m) out.push(m); });
  return out.sort((a, b) => Number(b.strong) - Number(a.strong) ||
    Object.values(b.hits).filter(Boolean).length - Object.values(a.hits).filter(Boolean).length);
}

const REASON = { name: "name", dob: "date of birth", phone: "mobile", email: "email" };
const reasonText = (hits) => Object.keys(REASON).filter((k) => hits[k]).map((k) => REASON[k]);
const joinWords = (w) => (w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0] || "");

/* ===================== Dialog ===================== */

let dlg = null;
let ctx = null;

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement("dialog");
  dlg.className = "em-dialog np-dialog";
  dlg.setAttribute("aria-label", "New patient");
  document.body.appendChild(dlg);

  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-np='close']")) { dlg.close(); return; }
    if (e.target.closest(".np-open")) dlg.close(); // let the link open the existing patient
  });
  dlg.addEventListener("input", () => {
    clearTimeout(ctx && ctx.timer);
    if (ctx) ctx.timer = setTimeout(liveCheck, 200);
  });
  dlg.addEventListener("submit", onSubmit);
  dlg.addEventListener("close", () => {
    if (ctx) { clearTimeout(ctx.timer); ctx.resolve(ctx.created); }
    ctx = null;
    dlg.innerHTML = "";
  });
}

// Resolves the new patient { id, pttId, name }, or null if cancelled
export function openNewPatientDialog({ loadAll }) {
  ensureDialog();
  if (dlg.open) dlg.close();

  return new Promise((resolve) => {
    ctx = { resolve, created: null, all: null, matches: [], timer: null };
    const myCtx = ctx;

    dlg.innerHTML = `
      <form class="em-form np-form" novalidate>
        <header class="em-head">
          ${I.userPlus}<h2>New patient</h2>
          <button type="button" class="em-close" data-np="close" aria-label="Close">${I.x}</button>
        </header>

        <div class="np-grid">
          <label class="em-field"><span>First name *</span><input name="firstName" maxlength="60" autocomplete="off" /></label>
          <label class="em-field"><span>Last name *</span><input name="lastName" maxlength="60" autocomplete="off" /></label>
          <label class="em-field"><span>Date of birth</span><input name="dobKey" type="date" max="${toDateKey()}" /></label>
          <label class="em-field"><span>Mobile *</span><input name="mobile" type="tel" maxlength="20" placeholder="04xx xxx xxx" autocomplete="off" /></label>
          <label class="em-field full"><span>Email</span><input name="email" type="email" maxlength="120" autocomplete="off" /></label>
          <label class="em-field full"><span>Address</span><input name="address" maxlength="200" autocomplete="off" /></label>
        </div>
        <p class="np-note">The patient ID is created automatically. Adding a date of birth helps spot duplicates.</p>

        <div class="np-dupes-slot" aria-live="polite"></div>
        <p class="em-error" role="alert"></p>

        <footer class="em-foot">
          <button type="button" class="btn-ghost" data-np="close">Cancel</button>
          <button type="submit" class="em-send">${I.userPlus}Add patient</button>
        </footer>
      </form>`;

    dlg.showModal();
    dlg.querySelector("input[name='firstName']").focus();

    // The whole patient list (usually already in memory) for the live duplicate check
    loadAll()
      .then((list) => { if (ctx === myCtx) { myCtx.all = list; liveCheck(); } })
      .catch((err) => console.warn("Duplicate check list unavailable:", err));
  });
}

function liveCheck() {
  if (!ctx || !ctx.all) return;
  const form = dlg.querySelector("form");
  if (!form) return;
  ctx.matches = findMatches(ctx.all, readInput(form));
  renderMatches(ctx.matches);
}

function renderMatches(matches) {
  const slot = dlg.querySelector(".np-dupes-slot");
  if (!slot) return;
  if (!matches.length) { slot.innerHTML = ""; return; }

  const strong = matches.some((m) => m.strong);
  const shown = matches.slice(0, 5);
  slot.innerHTML = `
    <div class="np-dupes ${strong ? "is-strong" : "is-possible"}">
      <p class="np-dupes-head">${I.alert}<span>${strong
        ? "This patient already exists"
        : `Possible duplicate${matches.length > 1 ? "s" : ""}: check before adding`}</span></p>
      <ul>${shown.map(({ patient: p, hits, strong: s }) => `
        <li class="np-dupe">
          <div class="np-dupe-main">
            <p class="np-dupe-name">
              <span class="${hits.name ? "hit" : ""}">${escapeHtml(p.name)}</span>
              <small>ID ${escapeHtml(p.pttId || p.id)}</small>
              ${s ? `<em class="np-tag">Same person</em>` : ""}
            </p>
            <p class="np-dupe-meta">
              <span class="${hits.dob ? "hit" : ""}">${p.dobKey ? escapeHtml(formatDobLong(p.dobKey)) : "No DOB"}</span>
              <span class="${hits.phone ? "hit" : ""}">${p.mobile ? escapeHtml(formatMobile(p.mobile)) : "No mobile"}</span>
              <span class="${hits.email ? "hit" : ""}">${p.email ? escapeHtml(p.email) : "No email"}</span>
            </p>
            <p class="np-dupe-why">Same ${escapeHtml(joinWords(reasonText(hits)))}</p>
          </div>
          <a class="np-open" href="#/patient/${encodeURIComponent(p.id)}">Open</a>
        </li>`).join("")}
      </ul>
      ${matches.length > shown.length ? `<p class="np-more">+ ${matches.length - shown.length} more</p>` : ""}
    </div>`;
}

async function onSubmit(e) {
  e.preventDefault();
  if (!ctx) return;
  const myCtx = ctx;
  const form = e.target;
  const f = form.elements;
  const errEl = dlg.querySelector(".em-error");
  const btn = dlg.querySelector(".em-send");
  const inp = readInput(form);

  errEl.textContent = "";
  if (!inp.first) { errEl.textContent = "Please enter the first name."; f.firstName.focus(); return; }
  if (!inp.last) { errEl.textContent = "Please enter the last name."; f.lastName.focus(); return; }
  if (inp.phone.length < 8 || inp.phone.length > 11) { errEl.textContent = "Please enter a valid mobile number."; f.mobile.focus(); return; }
  if (inp.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inp.email)) { errEl.textContent = "Please enter a valid email address."; f.email.focus(); return; }

  const reset = () => { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${I.userPlus}Add patient`; } };
  btn.disabled = true;
  btn.textContent = "Checking…";

  try {
    // Re-check Firestore directly, then merge with the in-memory check
    const fresh = await findPossibleDuplicates({
      nameKey: `${inp.last} ${inp.first}`.toLowerCase(), email: inp.email, mobile: f.mobile.value,
    });
    if (ctx !== myCtx) return;

    const byId = new Map(findMatches(myCtx.all || [], inp).map((m) => [m.patient.id, m]));
    findMatches(fresh, inp).forEach((m) => { if (!byId.has(m.patient.id)) byId.set(m.patient.id, m); });
    const matches = [...byId.values()].sort((a, b) => Number(b.strong) - Number(a.strong));
    myCtx.matches = matches;
    renderMatches(matches);

    // Same name + same DOB / mobile / email: block
    if (matches.some((m) => m.strong)) {
      errEl.textContent = "This patient is already in the system. Open the existing record instead.";
      reset();
      return;
    }

    // Only one detail matches: could be family or a common name, so ask first
    if (matches.length) {
      const reasons = [...new Set(matches.flatMap((m) => reasonText(m.hits)))];
      const ok = await confirmDialog({
        title: "Possible duplicate",
        message: `${matches.length} existing patient${matches.length > 1 ? "s share" : " shares"} the same ${joinWords(reasons)}.\n\n` +
          "Only add a new record if this is a different person, for example a family member sharing a phone or email.",
        confirmLabel: "Add new patient",
        tone: "warning",
      });
      if (!ok || ctx !== myCtx) { reset(); return; }
    }

    btn.textContent = "Saving…";
    myCtx.created = await createPatient({
      firstName: inp.first, lastName: inp.last, dobKey: inp.dobKey,
      mobile: f.mobile.value, email: f.email.value, address: f.address.value,
    });
    dlg.close();
  } catch (err) {
    console.error("Adding patient failed:", err);
    errEl.textContent = err.code === "permission-denied"
      ? "You don't have permission to add patients. Check the Firestore rules."
      : err.code ? "Couldn't add the patient. Please try again." : err.message;
    reset();
  }
}