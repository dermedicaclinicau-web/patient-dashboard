import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, FieldPath }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { escapeHtml } from "./utils.js";
import { parseRecordDate } from "./transcripts.js";

const PAGE = 6;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const svg = (p, cls = "") =>
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  chev: svg('<polyline points="6 9 12 15 18 9"/>', "sum-chev"),
  receipt: svg('<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .7V2l-1 .7-3-2-3 2-3-2-3 2-3-2z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/>'),
  rx: svg('<path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>'),
  view: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  file: svg('<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  syringe: svg('<path d="m18 2 4 4"/><path d="m17 7 3-3"/><path d="M19 9 8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5"/><path d="m9 11 4 4"/><path d="m5 19-3 3"/><path d="m14 4 6 6"/>'),
  send: svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  star: svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  message: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
};

const fmt = (it) => (it.date ? `${MONTHS[it.date.getMonth()]} ${it.date.getDate()}, ${it.date.getFullYear()}` : (it.dateText || "Undated"));
const byDateDesc = (a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
const isArchived = (v) => /^(true|yes|y|1|archived)$/i.test(String(v || "").trim());
const driveLink = (id) => (/^[\w-]{10,}$/.test(String(id || "")) ? `https://drive.google.com/file/d/${id}/view` : "");
// Injectable prescription types (everything else stays in the "Prescription" card)
const INJECTABLE_RE = /xeomin|botox|dysport|letybo|relatox|wrinkle|toxin|\bha\b|hyaluronic|filler|radiesse|sculptra|rejuran|profhilo|skin\s?booster|hyalase|polynucleotide|injectable/i;
const isInjectable = (r) => INJECTABLE_RE.test(r.title);

function isOpenSaved(key, fallback) {
  try {
    const s = JSON.parse(localStorage.getItem("pd-open-sections")) || {};
    return key in s ? !!s[key] : fallback;
  } catch { return fallback; }
}

/* ===================== Data ===================== */

async function fetchBillingAndRx(patient) {
  const ids = [...new Set([patient.pttId, patient.id].filter(Boolean))];
  if (!ids.length) return { billing: [], rx: [], errors: [] };

  const [scanRes, rxRes] = await Promise.allSettled([
    getDocs(query(collection(db, "scanned_file_log"), where("PatientID", "in", ids))),
    getDocs(query(collection(db, "prescription_record"), where(new FieldPath("Patient ID"), "in", ids))),
  ]);

  const billing = scanRes.status === "fulfilled"
    ? scanRes.value.docs
        .map((d) => ({ docId: d.id, ...d.data() }))
        .filter((f) => String(f.FileType || "").trim().toLowerCase() === "billing sheet")
        .filter((f) => !isArchived(f.Archived))
        .map((f) => ({
          title: "Billing Sheet",
          // ISO timestamps are UTC; parsing gives the correct LOCAL date (e.g. 22 Sep in Perth)
          date: parseRecordDate(f.RecordDate) || parseRecordDate(f.Timestamp),
          dateText: String(f.RecordDate || ""),
          staff: String(f.AssignedBy || ""),
          fileName: String(f.StoredName || f.OriginalName || ""),
          link: driveLink(f.FileID),
        }))
        .sort(byDateDesc)
    : null;

  const rx = rxRes.status === "fulfilled"
    ? rxRes.value.docs
        .map((d) => d.data())
        .map((r) => ({
          title: String(r["Prescription Type"] || "Prescription"),
          date: parseRecordDate(r["Record Date"]),
          dateText: String(r["Record Date"] || ""),
          staff: String(r.Staff || ""),
          recordId: String(r["Record ID"] || ""),
          link: String(r["PDF Link"] || ""),
        }))
        .sort(byDateDesc)
    : null;

  [scanRes, rxRes].forEach((r) => { if (r.status === "rejected") console.error("Billing/Rx load failed:", r.reason); });
  return {
    billing,
    rx: rx ? rx.filter((r) => !isInjectable(r)) : null,
    injectables: rx ? rx.filter(isInjectable) : null,
  };
}

/* ===================== Layout ===================== */

export function billingRxSectionHtml() {
  const open = isOpenSaved("billing-rx", true) ? "open" : "";
  return `
    <div class="bp-grid">
      <details class="rc-card" data-key="billing-rx" ${open}>
        <summary>
          <span class="rc-title">${ICONS.chev}<span class="bp-icon billing">${ICONS.receipt}</span>Billing Sheet</span>
          <span class="sk-badge bp-billing-count">–</span>
        </summary>
        <div class="rc-body"><div class="bp-list bp-billing-body"><div class="skeleton sm"></div></div></div>
      </details>

      <details class="rc-card" data-key="billing-rx" ${open}>
        <summary>
          <span class="rc-title">${ICONS.chev}<span class="bp-icon rx">${ICONS.rx}</span>Prescription</span>
          <span class="sk-badge bp-rx-count">–</span>
        </summary>
        <div class="rc-body"><div class="bp-list bp-rx-body"><div class="skeleton sm"></div></div></div>
      </details>
    </div>`;
}

/* ===================== Behaviour ===================== */

export function mountBillingRx(root, patient) {
  const grid = root.querySelector(".bp-grid");
  if (!grid) return;
  const irGrid = root.querySelector(".ir-grid");
  const phGrid = root.querySelector(".ph-grid");

  const VIEWS = {
    billing: { scope: grid, body: ".bp-billing-body", count: ".bp-billing-count", item: billingHtml,
               empty: "No billing sheets on file.", what: "billing sheets" },
    rx: { scope: grid, body: ".bp-rx-body", count: ".bp-rx-count", item: rxHtml,
          empty: "No other prescriptions on file.", what: "prescriptions" },
    injectables: irGrid && { scope: irGrid, body: ".ir-body", count: ".ir-count", item: rxHtml,
                             empty: "No injectable prescriptions on file.", what: "injectable prescriptions" },
  };

  let data = null;
  let loading = false;
  const shown = { billing: PAGE, rx: PAGE, injectables: PAGE };

  async function load() {
    if (data || loading) return;
    loading = true;
    try {
      data = await fetchBillingAndRx(patient);
      if (!grid.isConnected) return;
      Object.keys(VIEWS).forEach((k) => { if (VIEWS[k]) render(k); });
    } finally {
      loading = false;
    }
  }

  function render(kind) {
    const v = VIEWS[kind];
    const items = data[kind];
    const body = v.scope.querySelector(v.body);
    v.scope.querySelector(v.count).textContent = items ? items.length : "!";

    if (!items) {
      body.innerHTML = `<p class="rc-empty">Couldn't load ${v.what}. Check the Firestore rules.</p>`;
      return;
    }
    if (!items.length) {
      body.innerHTML = `<p class="rc-empty">${v.empty}</p>`;
      return;
    }

    const remaining = items.length - shown[kind];
    body.innerHTML =
      items.slice(0, shown[kind]).map(v.item).join("") +
      (remaining > 0
        ? `<button type="button" class="bp-more" data-bp-more="${kind}">Load ${Math.min(PAGE, remaining)} more · ${remaining} remaining</button>`
        : "");
  }

  // Each row opens/closes together; opening a data row loads the data
  syncRow(grid, load);
  if (irGrid) syncRow(irGrid, load);
  if (phGrid) syncRow(phGrid);

  [grid, irGrid].filter(Boolean).forEach((g) =>
    g.addEventListener("click", (e) => {
      const more = e.target.closest("[data-bp-more]");
      if (!more) return;
      const kind = more.dataset.bpMore;
      shown[kind] += PAGE;
      render(kind);
    })
  );

  const anyOpen = [grid, irGrid].filter(Boolean).some((g) => g.querySelector(":scope > details[open]"));
  if (anyOpen) load();
}

// Cards in the same row open/close together; onOpen runs when the row is opened
function syncRow(row, onOpen) {
  const cards = [...row.querySelectorAll(":scope > details")];
  row.addEventListener("toggle", (e) => {
    const card = e.target;
    if (!cards.includes(card)) return;
    cards.forEach((c) => { if (c !== card && c.open !== card.open) c.open = card.open; });
    if (card.open && onOpen) onOpen();
  }, true);
}

/* ===================== New rows: Injectables + Referral, Interests + Communication ===================== */

function placeholderCard(rowKey, open, icon, iconClass, title, message, addLabel) {
  return `
    <details class="rc-card" data-key="${rowKey}" ${open}>
      <summary>
        <span class="rc-title">${ICONS.chev}<span class="bp-icon ${iconClass}">${ICONS[icon]}</span>${title}</span>
        <span class="sk-tools">
          ${addLabel ? `<button type="button" class="rc-link" data-soon="${addLabel}">+ Add</button>` : ""}
          <span class="ph-badge">Soon</span>
        </span>
      </summary>
      <div class="rc-body"><p class="rc-empty pad">${message}</p></div>
    </details>`;
}

export function injectableReferralSectionHtml() {
  const open = isOpenSaved("inj-referral", true) ? "open" : "";
  return `
    <div class="ir-grid">
      <details class="rc-card ir-card" data-key="inj-referral" ${open}>
        <summary>
          <span class="rc-title">${ICONS.chev}<span class="bp-icon inj">${ICONS.syringe}</span>Injectable Prescription Records</span>
          <span class="sk-badge ir-count">–</span>
        </summary>
        <div class="rc-body"><div class="bp-list ir-body"><div class="skeleton sm"></div></div></div>
      </details>
      ${placeholderCard("inj-referral", open, "send", "ref", "Referral Letter",
        "Referral letters will appear here once connected.", "Add referral letter")}
    </div>`;
}

export function interestsCommsSectionHtml() {
  const open = isOpenSaved("interests-comms", true) ? "open" : "";
  return `
    <div class="ph-grid">
      ${placeholderCard("interests-comms", open, "star", "interest", "Treatment Interested In",
        "Treatments the patient is interested in will appear here once connected.", "Add treatment interest")}
      ${placeholderCard("interests-comms", open, "message", "comms", "Communication Log",
        "Calls, emails and SMS with this patient will appear here once connected.", "Log communication")}
    </div>`;
}

/* ===================== Templates ===================== */

function viewLink(link) {
  return /^https:\/\//i.test(link || "")
    ? `<a class="rc-act" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${ICONS.view}View</a>`
    : `<span class="rc-act is-disabled" title="No file attached">${ICONS.view}View</span>`;
}

function billingHtml(b) {
  return `
    <article class="rc-item">
      <div class="rc-item-top"><h4>${escapeHtml(b.title)}</h4><span class="rc-date">${escapeHtml(fmt(b))}</span></div>
      ${b.staff ? `<p class="rc-staff">Assigned by ${escapeHtml(b.staff)}</p>` : ""}
      ${b.fileName ? `<p class="bp-file">${ICONS.file}${escapeHtml(b.fileName)}</p>` : ""}
      <div class="rc-actions">
        ${viewLink(b.link)}
        <button type="button" class="rc-act danger" data-soon="Delete billing sheet">${ICONS.trash}Delete</button>
      </div>
    </article>`;
}

function rxHtml(r) {
  return `
    <article class="rc-item">
      <div class="rc-item-top"><h4>${escapeHtml(r.title)}</h4><span class="rc-date">${escapeHtml(fmt(r))}</span></div>
      ${r.staff ? `<p class="rc-staff">${escapeHtml(r.staff)}</p>` : ""}
      ${r.recordId ? `<p class="bp-id">${escapeHtml(r.recordId)}</p>` : ""}
      <div class="rc-actions">
        ${viewLink(r.link)}
        <button type="button" class="rc-act" data-soon="Edit prescription">${ICONS.edit}Edit</button>
        <button type="button" class="rc-act danger" data-soon="Delete prescription">${ICONS.trash}Delete</button>
      </div>
    </article>`;
}