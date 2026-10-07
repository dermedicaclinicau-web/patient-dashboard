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
};

const fmt = (it) => (it.date ? `${MONTHS[it.date.getMonth()]} ${it.date.getDate()}, ${it.date.getFullYear()}` : (it.dateText || "Undated"));
const byDateDesc = (a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
const isArchived = (v) => /^(true|yes|y|1|archived)$/i.test(String(v || "").trim());
const driveLink = (id) => (/^[\w-]{10,}$/.test(String(id || "")) ? `https://drive.google.com/file/d/${id}/view` : "");

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
  return { billing, rx, errors: [scanRes, rxRes].filter((r) => r.status === "rejected").map((r) => r.reason) };
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
  const [billCard, rxCard] = grid.querySelectorAll(".rc-card");
  const billBody = grid.querySelector(".bp-billing-body");
  const rxBody = grid.querySelector(".bp-rx-body");

  let data = null;
  let loading = false;
  const shown = { billing: PAGE, rx: PAGE };

  async function load() {
    if (data || loading) return;
    loading = true;
    try {
      data = await fetchBillingAndRx(patient);
      if (!grid.isConnected) return;
      render("billing");
      render("rx");
    } finally {
      loading = false;
    }
  }

  function render(kind) {
    const items = data[kind];
    const body = kind === "billing" ? billBody : rxBody;
    grid.querySelector(kind === "billing" ? ".bp-billing-count" : ".bp-rx-count").textContent = items ? items.length : "!";

    if (!items) {
      body.innerHTML = `<p class="rc-empty">Couldn't load ${kind === "billing" ? "billing sheets" : "prescriptions"}. Check the Firestore rules.</p>`;
      return;
    }
    if (!items.length) {
      body.innerHTML = `<p class="rc-empty">${kind === "billing" ? "No billing sheets on file." : "No prescriptions on file."}</p>`;
      return;
    }

    const remaining = items.length - shown[kind];
    body.innerHTML =
      items.slice(0, shown[kind]).map((it) => (kind === "billing" ? billingHtml(it) : rxHtml(it))).join("") +
      (remaining > 0
        ? `<button type="button" class="bp-more" data-bp-more="${kind}">Load ${Math.min(PAGE, remaining)} more · ${remaining} remaining</button>`
        : "");
  }

  // Opening/closing one card does the same to the other
  grid.addEventListener("toggle", (e) => {
    const card = e.target;
    if (!card.classList || !card.classList.contains("rc-card")) return;
    const other = card === billCard ? rxCard : billCard;
    if (other.open !== card.open) other.open = card.open;
    if (card.open) load();
  }, true);

  grid.addEventListener("click", (e) => {
    const more = e.target.closest("[data-bp-more]");
    if (!more) return;
    const kind = more.dataset.bpMore;
    shown[kind] += PAGE;
    render(kind);
  });

  if (billCard.open) load();
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