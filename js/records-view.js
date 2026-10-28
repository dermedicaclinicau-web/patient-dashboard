import { fetchPatientRecords, CATEGORIES, OTHER_CATEGORY } from "./records.js";
import { escapeHtml, parseDateKey } from "./utils.js";
import { getSubmission, listSubmissionsForPatient } from "./form-submissions.js";
import { fetchBillingAndRx } from "./billing-rx-view.js";
import { patientIds } from "./patients.js";
import { getFormVersion, listPublishedForms } from "./form-templates.js";
import { openMoveRecordDialog, canMoveRecords } from "./record-move.js";

const svg = (p, cls = "") =>
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  chev: svg('<polyline points="6 9 12 15 18 9"/>', "sum-chev"),
  chevRight: svg('<polyline points="9 18 15 12 9 6"/>', "rc-chev"),
  view: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  rename: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  move: svg('<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
};

const ALL_CATS = [...CATEGORIES, OTHER_CATEGORY];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (r) => (r.date ? `${MONTHS[r.date.getMonth()]} ${r.date.getDate()}, ${r.date.getFullYear()}` : (r.dateText || "Undated"));

function isOpenSaved(key, fallback) {
  try {
    const s = JSON.parse(localStorage.getItem("pd-open-sections")) || {};
    return key in s ? !!s[key] : fallback;
  } catch { return fallback; }
}
/* ===================== Prescriptions on consent records ===================== */
// Portal consents: the form's Prescription check (set in Form Builder) decides. Its result was saved with the consent;
// if no prescription was on file then, one saved since still counts.
// Old-app consents (PDFs) aren't linked to a form, so injectables consents look for any prescription close to the day.

const RX_AFTER_DAYS = 3;    // a prescription up to this many days after the consent still counts
const RX_LEGACY_DAYS = 3;   // old-app consents: this many days either side
const DAY_MS = 864e5;
const dayNo = (d) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
const isDate = (d) => d instanceof Date && !isNaN(d);

// The meaningful part of a form name, the same way the live form's Prescription check matches them
// ("2026 S4 Xeomin Prescription" and "Xeomin" both become "xeomin")
const NAME_NOISE = new Set(["consent", "consents", "form", "forms", "record", "records", "version", "new", "updated",
  "copy", "of", "for", "and", "the", "patient", "prescription", "prescriptions", "script", "scripts", "rx", "s4"]);
function coreName(s) {
  return String(s || "").toLowerCase()
    .replace(/\bwr\b/g, "wrinkle relaxer")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NAME_NOISE.has(w) && !/^(19|20)\d{2}$/.test(w) && !/^v\d+$/.test(w))
    .join(" ");
}

// Old-app consents only: injectables need a prescription
function legacyNeedsRx(c) {
  if (c.category === "wr") return true;
  const cat = ALL_CATS.find((x) => x.key === c.category);
  return /wrinkle|filler|radiesse|injectable/i.test(cat ? cat.title : "");
}

// A published form version's questions (null if it couldn't be read), fetched once each
const verCache = new Map();
function versionFields(templateId, version) {
  const k = `${templateId}|${version}`;
  if (!verCache.has(k)) {
    verCache.set(k, getFormVersion(templateId, version).then((v) => (v ? v.fields : [])).catch(() => null));
  }
  return verCache.get(k);
}

// Every prescription for this patient, the patient's saved forms (for the consents' saved checks), and the published forms
async function fetchPrescriptions(patient) {
  const [scripts, subs, forms] = await Promise.allSettled([
    fetchBillingAndRx(patient),
    listSubmissionsForPatient([patient.id, ...patientIds(patient)]),
    listPublishedForms(),
  ]);
  const list = [];
  if (scripts.status === "fulfilled") {
    // Portal ones come from the saved forms below, so they aren't counted twice
    [...(scripts.value.rx || []), ...(scripts.value.injectables || [])].filter((r) => !r.portalId).forEach((r) => {
      if (!isDate(r.date)) return;
      list.push({ date: r.date, title: r.title || "Prescription", templateId: "",
        href: /^https:\/\//i.test(r.link || "") ? r.link : "" });
    });
  } else {
    console.warn("Consent prescriptions: older records failed:", scripts.reason);
  }
  const allSubs = subs.status === "fulfilled" ? subs.value : [];
  if (subs.status !== "fulfilled") console.warn("Consent prescriptions: portal forms failed:", subs.reason);
  allSubs.forEach((s) => {
    const cat = String(s.category || "").toLowerCase();
    const isRx = cat === "rx" || cat === "prescription" || /prescription/i.test(s.templateName || "");
    const d = isRx ? parseDateKey(s.recordDate) : null;
    if (d) list.push({ date: d, title: s.templateName || "Prescription", templateId: s.templateId,
      href: `#/form-record/${encodeURIComponent(s.id)}` });
  });
  return {
    list,
    subs: allSubs,
    forms: forms.status === "fulfilled" ? forms.value : [],
    ok: scripts.status === "fulfilled" && subs.status === "fulfilled",
  };
}

// The prescription closest to the consent day, from `monthsBefore` months before it up to RX_AFTER_DAYS after
function closestRx(list, date, monthsBefore, daysAfter = RX_AFTER_DAYS) {
  const from = new Date(date);
  from.setMonth(from.getMonth() - monthsBefore);
  const lo = dayNo(from);
  const hi = dayNo(date) + daysAfter;
  const day = dayNo(date);
  let best = null;
  let gap = Infinity;
  list.forEach((p) => {
    const n = dayNo(p.date);
    if (n < lo || n > hi) return;
    const g = Math.abs(n - day);
    if (g < gap) { best = p; gap = g; }
  });
  return best;
}

// Sets c.rxState ("ok" | "none" | "unknown") and c.rx on the consents that need a prescription
async function markPrescriptions(consents, rx) {
  const subById = new Map(rx.subs.map((s) => [s.id, s]));
  const formById = new Map(rx.forms.map((t) => [t.id, t]));

  await Promise.all(consents.map(async (c) => {
    if (c.portalId) {
      const sub = subById.get(c.portalId);
      if (!sub) return;   // couldn't be read: no tag rather than a wrong one
      // The Prescription check on the version it was filled in on, or on the form as it is now (older consents)
      const saved = await versionFields(sub.templateId, sub.version);
      const now = formById.get(sub.templateId);
      const isCheck = (x) => x && x.type === "prescription_status";
      const f = (saved || []).find(isCheck) || ((now && now.fields) || []).find(isCheck);
      if (!f) {
        if (saved === null && !now) c.rxState = "unknown";
        return;   // this consent form doesn't ask for a prescription
      }

      // Found when the consent was saved
      const a = sub.answers && sub.answers[f.id];
      if (a && a.found) {
        c.rxState = "ok";
        c.rx = {
          date: parseDateKey(a.date) || c.date,
          title: a.name || "Prescription",
          href: a.submissionId ? `#/form-record/${encodeURIComponent(a.submissionId)}`
            : /^https:\/\//i.test(a.link || "") ? a.link : "",
        };
        return;
      }

      // Not on file then: one of that prescription form saved since?
      if (!isDate(c.date)) { c.rxState = "unknown"; return; }
      const tpl = formById.get(f.consentFormId);
      const want = tpl ? coreName(tpl.name) : "";
      const mine = rx.list.filter((p) => (f.consentFormId && p.templateId === f.consentFormId) || (want && coreName(p.title) === want));
      c.rx = closestRx(mine, c.date, Number(f.months) || 6);
      c.rxState = c.rx ? "ok" : rx.ok ? "none" : "unknown";
      return;
    }

    // Old-app consents: the prescription closest to the day, up to RX_LEGACY_DAYS either side
    if (!legacyNeedsRx(c)) return;
    if (!isDate(c.date)) { c.rxState = "unknown"; return; }
    const day = dayNo(c.date);
    const gap = (p) => Math.abs(dayNo(p.date) - day);
    c.rx = rx.list.filter((p) => gap(p) <= RX_LEGACY_DAYS).sort((a, b) => gap(a) - gap(b))[0] || null;
    c.rxState = c.rx ? "ok" : rx.ok ? "none" : "unknown";
  }));
}

// Set by the fill-in page after saving, so the new record is opened and highlighted
let highlightId = null;
export function highlightRecord(submissionId) { highlightId = submissionId; }

/* ===================== Layout ===================== */

export function recordsSectionHtml() {
  const open = isOpenSaved("records", true) ? "open" : "";
  return `
    <div class="rc-grid">
      <details class="rc-card" data-key="records" ${open}>
        <summary>
          <span class="rc-title">${ICONS.chev}Treatment Records</span>
          <span class="sk-badge rc-tx-count">–</span>
        </summary>
        <div class="rc-body rc-tx-body"><div class="skeleton sm"></div></div>
      </details>

      <details class="rc-card" data-key="records" ${open}>
        <summary>
          <span class="rc-title">${ICONS.chev}Consent Records</span>
          <span class="sk-badge rc-cs-count">–</span>
        </summary>
        <div class="rc-body rc-cs-body"><div class="skeleton sm"></div></div>
      </details>
    </div>`;
}

/* ===================== Behaviour ===================== */

export function mountRecords(root, patient) {
  const grid = root.querySelector(".rc-grid");
  if (!grid) return;
  const [txCard, csCard] = grid.querySelectorAll(".rc-card");
  const txBody = grid.querySelector(".rc-tx-body");
  const csBody = grid.querySelector(".rc-cs-body");

  let loaded = false;
  let loading = null;
  let lists = { treatment: [], consent: [] }; // the loaded records, for the Move button

  function showHighlight() {
    const id = highlightId;
    highlightId = null;
    if (!id) return;
    const item = grid.querySelector(`[data-sub="${CSS.escape(id)}"]`);
    if (!item) return;
    const cat = item.closest("details.rc-cat");
    if (cat) cat.open = true;
    requestAnimationFrame(() => {
      item.scrollIntoView({ block: "center", behavior: "smooth" });
      item.classList.add("is-new");
    });
  }

  function load() {
    if (loaded || loading) return loading;
    loading = (async () => {
      try {
        const [{ treatments, consents }, rx] = await Promise.all([
          fetchPatientRecords(patient),
          fetchPrescriptions(patient).catch((err) => {
            console.warn("Consent prescriptions failed:", err);
            return { list: [], subs: [], forms: [], ok: false };
          }),
        ]);
        await markPrescriptions(consents, rx).catch((err) => console.warn("Consent prescriptions not marked:", err));
        // TEMPORARY: which category each record went into (remove once checked)
        try {
          const ds = (d) => (d instanceof Date && !isNaN(d) ? d.toDateString() : "(no date)");
          console.log("TREATMENT RECORDS");
          console.table(treatments.map((t) => ({
            record: t.title, date: ds(t.date), from: t.portalId ? "portal" : "old app",
            savedGroup: t.portalId ? (t.group || "(none)") : "", shownUnder: t.category,
          })));
          console.log("CONSENT RECORDS");
          console.table(consents.map((c) => ({
            consent: c.title, date: ds(c.date), from: c.portalId ? "portal" : "old app",
            savedGroup: c.portalId ? (c.group || "(none)") : "", shownUnder: c.category,
            prescription: c.rxState || "not checked",
          })));
        } catch (e) { console.warn("Records debug failed:", e); }
        if (!grid.isConnected) return;
        loaded = true;
        lists = { treatment: treatments, consent: consents };
        grid.querySelector(".rc-tx-count").textContent = treatments.length;
        grid.querySelector(".rc-cs-count").textContent = consents.length;
        txBody.innerHTML = treatmentsHtml(treatments);
        csBody.innerHTML = consentsHtml(consents);
        showHighlight();
      } catch (err) {
        if (!grid.isConnected) return;
        console.error("Records load failed:", err);
        const msg = err.code === "permission-denied"
          ? "Records aren't accessible. Check the Firestore rules."
          : "Couldn't load records.";
        txBody.innerHTML = csBody.innerHTML = `<p class="rc-empty">${msg}</p>`;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // Opening/closing one card does the same to the other
  grid.addEventListener("toggle", (e) => {
    const card = e.target;
    if (!card.classList || !card.classList.contains("rc-card")) return;
    const other = card === txCard ? csCard : txCard;
    if (other.open !== card.open) other.open = card.open;
    if (card.open) load();
  }, true);

  // Move a record to another patient (portal forms and older records), then reload this patient's records
  grid.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-move-sub], [data-move-legacy]");
    if (!b || b.disabled) return;
    e.preventDefault();
    b.disabled = true;
    try {
      let res = null;
      if (b.dataset.moveSub) {
        const sub = await getSubmission(b.dataset.moveSub);
        if (sub) res = await openMoveRecordDialog({ sub });
      } else {
        const kind = b.dataset.moveLegacy;
        const r = (lists[kind] || []).find((x) => !x.portalId && x.id === b.dataset.id);
        if (r) {
          res = await openMoveRecordDialog({ legacy: {
            kind, id: r.id, title: r.title, dateText: r.dateText,
            patientName: r.patientName || patient.name, patientId: patient.id, matchedByName: r.matchedByName,
          } });
        }
      }
      if (res && grid.isConnected) {
        loaded = false;
        txBody.innerHTML = csBody.innerHTML = '<div class="skeleton sm"></div>';
        load();
      }
    } catch (err) {
      console.error("Move failed:", err);
    } finally {
      b.disabled = false;
    }
  });
  if (highlightId && !txCard.open) txCard.open = true; // just saved a record: show it
  if (txCard.open) load();

  // Loads the records again, e.g. after a form is saved in another tab.
  // Waits for a load already in progress, so the newer record isn't missed.
  async function reload() {
    if (!grid.isConnected) return;
    if (loading) await loading;
    loaded = false;
    txBody.innerHTML = csBody.innerHTML = '<div class="skeleton sm"></div>';
    return load();
  }
  return { reload };
}

/* ===================== Templates ===================== */

function groupBy(items) {
  const map = new Map(ALL_CATS.map((c) => [c.key, []]));
  items.forEach((it) => (map.get(it.category) || map.get("other")).push(it));
  return map;
}

function viewLink(link) {
  return /^https:\/\//i.test(link)
    ? `<a class="rc-act" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${ICONS.view}View</a>`
    : `<span class="rc-act is-disabled" title="No file attached">${ICONS.view}View</span>`;
}

function portalView(r) {
  const id = encodeURIComponent(r.portalId);
  let html = '<a class="rc-act" href="#/form-record/' + id + '" target="_blank" rel="noopener">' + ICONS.view + 'View</a>';
  if (canMoveRecords()) {
    html += '<button type="button" class="rc-act" data-move-sub="' + escapeHtml(r.portalId) + '">' + ICONS.move + 'Move</button>';
  }
  return html;
}

const legacyMove = (kind, r) => (canMoveRecords()
  ? `<button type="button" class="rc-act" data-move-legacy="${kind}" data-id="${escapeHtml(r.id)}">${ICONS.move}Move</button>` : "");
// Old-app Wrinkle Relaxer records: start a new portal record with the same markings
const wrCopyBtn = (t) => (t.category === "wr" && t.recordId
  ? `<button type="button" class="rc-act" data-wrcopy="${escapeHtml(t.recordId)}" title="Open a new Wrinkle Relaxer record with these markings">${ICONS.copy}Copy and create new</button>`
  : "");
function movedNote(r) {
  const m = r.moves && r.moves[r.moves.length - 1];
  if (!m) return "";
  const d = new Date(m.at);
  return `<p class="rc-moved">Moved here from ${escapeHtml(m.fromName || "another patient")}${
    isNaN(d) ? "" : ` · ${escapeHtml(d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }))}`}</p>`;
}

function categoryHtml(cat, items, inner, actions = "") {
  return `
    <details class="rc-cat">
      <summary>
        <span class="rc-cat-left">
          ${ICONS.chevRight}
          <span class="rc-dot" style="background:${cat.color}"></span>
          <span class="rc-cat-name">${escapeHtml(cat.title)}</span>
          ${items.length ? `<span class="rc-cat-count">· ${items.length}</span>` : ""}
        </span>
        ${actions}
      </summary>
      <div class="rc-cat-body">${items.length ? items.map(inner).join("") : `<p class="rc-empty">No records yet.</p>`}</div>
    </details>`;
}

function treatmentsHtml(treatments) {
  const groups = groupBy(treatments);
  return ALL_CATS
    .filter((c) => c.key !== "other" || groups.get("other").length) // "Other" only when used
    .map((cat) => categoryHtml(cat, groups.get(cat.key), txItemHtml, `
      <span class="rc-cat-actions">
        <button type="button" class="rc-link" data-create="consent" data-group="${cat.key}">${ICONS.plus}Create Consent</button>
        <span class="rc-sep">|</span>
        <button type="button" class="rc-link" data-create="treatment" data-group="${cat.key}">${ICONS.plus}Create Tx</button>
      </span>`))
    .join("");
}

function consentsHtml(consents) {
  if (!consents.length) return `<p class="rc-empty pad">No consent records on file.</p>`;
  const groups = groupBy(consents);
  return ALL_CATS
    .filter((c) => groups.get(c.key).length) // only categories with consents
    .map((cat) => categoryHtml(cat, groups.get(cat.key), consentItemHtml))
    .join("");
}
function rxBadge(c) {
  if (!c.rxState) return "";   // this consent doesn't need a prescription
  if (c.rxState === "unknown") return `<span class="rc-badge warn">Prescription status unknown</span>`;
  if (c.rxState === "none") return `<span class="rc-badge warn">⚠ No prescription found</span>`;
  const text = `✓ Prescription on file · ${escapeHtml(fmt(c.rx))}`;
  return c.rx.href
    ? `<a class="rc-badge ok" href="${escapeHtml(c.rx.href)}" target="_blank" rel="noopener" title="${escapeHtml(c.rx.title)}">${text}</a>`
    : `<span class="rc-badge ok" title="${escapeHtml(c.rx.title)} (no file attached)">${text}</span>`;
}
function consentBadge(t) {
  if (t.consent === undefined) return `<span class="rc-badge warn">Consent status unknown (no record date)</span>`;
  if (t.consent) return `<span class="rc-badge ok">✓ Consent on file · ${escapeHtml(fmt(t.consent))}</span>`;
  return `<span class="rc-badge warn">⚠ No consent found</span>`;
}

function txItemHtml(t) {
  if (t.portalId) {
    return `
      <article class="rc-item" data-sub="${escapeHtml(t.portalId)}">
        <div class="rc-item-top"><h4>${escapeHtml(t.title)}</h4><span class="rc-date">${escapeHtml(fmt(t))}</span></div>
        <div class="rc-badges"><span class="rc-badge portal">Portal form</span>${consentBadge(t)}</div>
        ${t.staff ? `<p class="rc-staff">${escapeHtml(t.staff)}</p>` : ""}
        <div class="rc-actions">${portalView(t)}</div>
      </article>`;
  }
  return `
    <article class="rc-item">
      <div class="rc-item-top"><h4>${escapeHtml(t.title)}</h4><span class="rc-date">${escapeHtml(fmt(t))}</span></div>
      ${consentBadge(t)}
      ${t.staff ? `<p class="rc-staff">${escapeHtml(t.staff)}</p>` : ""}
      ${t.matchedByName ? `<span class="task-flag neutral">Matched by name</span>` : ""}
      ${movedNote(t)}
      <div class="rc-actions">
        ${viewLink(t.link)}
        ${wrCopyBtn(t)}
        ${legacyMove("treatment", t)}
        <button type="button" class="rc-act" data-soon="Edit record">${ICONS.edit}Edit Record</button>
        <button type="button" class="rc-act" data-soon="Rename record">${ICONS.rename}Rename</button>
        <button type="button" class="rc-act danger" data-soon="Delete record">${ICONS.trash}Delete</button>
      </div>
    </article>`;
}

function consentItemHtml(c) {
  if (c.portalId) {
    return `
      <article class="rc-item" data-sub="${escapeHtml(c.portalId)}">
        <div class="rc-item-top"><h4>${escapeHtml(c.title)}</h4><span class="rc-date">${escapeHtml(fmt(c))}</span></div>
        <div class="rc-badges"><span class="rc-badge portal">Portal form</span>${rxBadge(c)}</div>
        ${c.staff ? `<p class="rc-staff">${escapeHtml(c.staff)}</p>` : ""}
        <div class="rc-actions">${portalView(c)}</div>
      </article>`;
  }
  return `
    <article class="rc-item">
      <div class="rc-item-top"><h4>${escapeHtml(c.title)}</h4><span class="rc-date">${escapeHtml(fmt(c))}</span></div>
      ${rxBadge(c)}
      ${c.staff ? `<p class="rc-staff">${escapeHtml(c.staff)}</p>` : ""}
      ${movedNote(c)}
      <div class="rc-actions">
        ${viewLink(c.link)}
        ${legacyMove("consent", c)}
        <button type="button" class="rc-act" data-soon="Edit consent">${ICONS.edit}Edit</button>
        <button type="button" class="rc-act danger" data-soon="Delete consent">${ICONS.trash}Delete</button>
      </div>
    </article>`;
}