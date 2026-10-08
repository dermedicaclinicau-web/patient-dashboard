// "Completed forms" section on the patient dashboard
import { listSubmissionsForPatient } from "./form-submissions.js";
import { categoryLabel } from "./form-templates.js";
import { patientIds } from "./patients.js";
import { escapeHtml } from "./utils.js";

const OPEN_KEY = "pd-open-sections"; // same layout memory as the rest of the dashboard
const icon = (p, cls = "") =>
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

function startsOpen() {
  try {
    const s = JSON.parse(localStorage.getItem(OPEN_KEY)) || {};
    return "form-records" in s ? s["form-records"] : true;
  } catch { return true; }
}

function niceDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return key || "";
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export function formRecordsSectionHtml() {
  return `
    <details class="section-card fr-card" data-key="form-records" ${startsOpen() ? "open" : ""}>
      <summary>
        <span class="pc-head">${icon('<polyline points="6 9 12 15 18 9"/>', "sum-chev")}<span class="pc-title">Completed forms</span><span class="hint fr-count">…</span></span>
      </summary>
      <div class="section-body fr-body"><div class="skeleton sm"></div></div>
    </details>`;
}

export async function mountFormRecords(root, patient) {
  const section = root.querySelector('details[data-key="form-records"]');
  if (!section) return;
  const count = section.querySelector(".fr-count");
  const body = section.querySelector(".fr-body");

  try {
    const list = await listSubmissionsForPatient([patient.id, ...patientIds(patient)]);
    if (!section.isConnected) return;
    count.textContent = list.length ? `${list.length} ${list.length === 1 ? "form" : "forms"}` : "None yet";
    body.innerHTML = list.length
      ? `<div class="fr-list">${list.map((s) => `
          <a class="fr-row" href="#/form-record/${encodeURIComponent(s.id)}">
            <span class="fr-main">
              <span class="fr-name">${escapeHtml(s.templateName)}</span>
              <span class="fr-meta">${escapeHtml([categoryLabel(s.category), niceDate(s.recordDate), s.createdBy && `by ${s.createdBy}`].filter(Boolean).join(" · "))}</span>
            </span>
            ${icon('<polyline points="9 18 15 12 9 6"/>')}
          </a>`).join("")}</div>`
      : '<p class="empty-note">No forms filled in yet. Use Consent record, Treatment record or Prescription above to start one.</p>';
  } catch (err) {
    if (!section.isConnected) return;
    console.error("Completed forms failed:", err);
    count.textContent = "—";
    body.innerHTML = `<p class="empty-note error">${err.code === "permission-denied"
      ? "Completed forms aren't accessible. Check the Firestore rules."
      : "Couldn't load completed forms."}</p>`;
  }
}