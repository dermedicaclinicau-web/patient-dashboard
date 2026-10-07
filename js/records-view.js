import { fetchPatientRecords, CATEGORIES, OTHER_CATEGORY } from "./records.js";
import { escapeHtml } from "./utils.js";

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

  function load() {
    if (loaded || loading) return loading;
    loading = (async () => {
      try {
        const { treatments, consents } = await fetchPatientRecords(patient);
        if (!grid.isConnected) return;
        loaded = true;
        grid.querySelector(".rc-tx-count").textContent = treatments.length;
        grid.querySelector(".rc-cs-count").textContent = consents.length;
        txBody.innerHTML = treatmentsHtml(treatments);
        csBody.innerHTML = consentsHtml(consents);
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

  if (txCard.open) load();
}

/* ===================== Templates ===================== */

function groupBy(items) {
  const map = new Map(ALL_CATS.map((c) => [c.key, []]));
  items.forEach((it) => map.get(it.category).push(it));
  return map;
}

function viewLink(link) {
  return /^https:\/\//i.test(link)
    ? `<a class="rc-act" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${ICONS.view}View</a>`
    : `<span class="rc-act is-disabled" title="No file attached">${ICONS.view}View</span>`;
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
        <button type="button" class="rc-link" data-soon="Create consent: ${escapeHtml(cat.title)}">${ICONS.plus}Create Consent</button>
        <span class="rc-sep">|</span>
        <button type="button" class="rc-link" data-soon="Create treatment record: ${escapeHtml(cat.title)}">${ICONS.plus}Create Tx</button>
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

function txItemHtml(t) {
  let badge;
  if (t.consent === undefined) badge = `<span class="rc-badge warn">Consent status unknown (no record date)</span>`;
  else if (t.consent) badge = `<span class="rc-badge ok">✓ Consent on file · ${escapeHtml(fmt(t.consent))}</span>`;
  else badge = `<span class="rc-badge warn">⚠ No consent found</span>`;

  return `
    <article class="rc-item">
      <div class="rc-item-top"><h4>${escapeHtml(t.title)}</h4><span class="rc-date">${escapeHtml(fmt(t))}</span></div>
      ${badge}
      ${t.staff ? `<p class="rc-staff">${escapeHtml(t.staff)}</p>` : ""}
      ${t.matchedByName ? `<span class="task-flag neutral">Matched by name</span>` : ""}
      <div class="rc-actions">
        ${viewLink(t.link)}
        <button type="button" class="rc-act" data-soon="Edit record">${ICONS.edit}Edit Record</button>
        <button type="button" class="rc-act" data-soon="Rename record">${ICONS.rename}Rename</button>
        <button type="button" class="rc-act" data-soon="Move record">${ICONS.move}Move</button>
        <button type="button" class="rc-act danger" data-soon="Delete record">${ICONS.trash}Delete</button>
      </div>
    </article>`;
}

function consentItemHtml(c) {
  return `
    <article class="rc-item">
      <div class="rc-item-top"><h4>${escapeHtml(c.title)}</h4><span class="rc-date">${escapeHtml(fmt(c))}</span></div>
      ${c.staff ? `<p class="rc-staff">${escapeHtml(c.staff)}</p>` : ""}
      <div class="rc-actions">
        ${viewLink(c.link)}
        <button type="button" class="rc-act" data-soon="Edit consent">${ICONS.edit}Edit</button>
        <button type="button" class="rc-act danger" data-soon="Delete consent">${ICONS.trash}Delete</button>
      </div>
    </article>`;
}