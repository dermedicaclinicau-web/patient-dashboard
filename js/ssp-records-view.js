// The patient page's "Skin Script Protocols" section (straight from Firestore ssp_records).
import { listSspRecords } from "./ssp-api.js";
import { openSspPreview } from "./ssp-send.js";
import { longDate } from "./ssp-document.js";
import { patientIds } from "./patients.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CHEV = '<svg class="sum-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function sspSectionHtml() {
  return `
    <details class="section-card ssp-sec" data-key="ssp-records" open>
      <summary>
        <span class="pc-head">${CHEV}<span class="pc-title">Skin Script Protocols</span><span class="hint" data-role="ssp-count">…</span></span>
        <button type="button" class="pc-refresh" data-action="create-ssp">+ New SSP</button>
      </summary>
      <div class="section-body" data-role="ssp-body"><div class="skeleton sm"></div></div>
    </details>`;
}

export function mountSspRecords(root, patient, staff) {
  const sec = root.querySelector('details[data-key="ssp-records"]');
  if (!sec) return;
  const body = sec.querySelector('[data-role="ssp-body"]');
  const count = sec.querySelector('[data-role="ssp-count"]');
  let list = [];

  function render() {
    count.textContent = list.length ? `${list.length} protocol${list.length === 1 ? "" : "s"}` : "None yet";
    if (!list.length) {
      body.innerHTML = '<p class="empty-note">No Skin Script Protocols created in the portal yet.</p>';
      return;
    }
    const today = todayIso();
    body.innerHTML = `<div class="ssp-list">${list.map((r, i) => {
      const expired = r.validUntil && r.validUntil < today;
      const sent = (r.deliveries || []).slice(-2).reverse().map((d) =>
        d.kind === "print" ? "Sent to printer" : `Emailed to ${d.to}`).join(" · ");
      return `
        <div class="ssp-item">
          <div class="ssp-item-main">
            <strong>${esc(longDate(r.recordDate))}</strong>
            ${i === 0 && !expired ? '<span class="tp-latest">Current</span>' : ""}
            ${expired ? '<span class="task-flag neutral">Expired</span>' : ""}
            <small>Valid until ${esc(longDate(r.validUntil))} · ${(r.items || []).length} products${r.createdBy ? ` · by ${esc(r.createdBy)}` : ""}</small>
            ${sent ? `<small class="ssp-sent">${esc(sent)}</small>` : ""}
          </div>
          <button type="button" class="btn-ghost sm" data-ssp-view="${esc(r.id)}">View</button>
        </div>`;
    }).join("")}</div>`;
  }

  async function load() {
    try {
      list = await listSspRecords([patient.id, ...patientIds(patient)]);
      if (body.isConnected) render();
    } catch (err) {
      console.error("SSP records failed:", err);
      count.textContent = "—";
      body.innerHTML = `<p class="empty-note error">${err && err.code === "permission-denied"
        ? "Skin Script Protocols aren't accessible. Check the ssp_records Firestore rule."
        : "Couldn't load Skin Script Protocols."}</p>`;
    }
  }

  body.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ssp-view]");
    if (!b) return;
    const rec = list.find((r) => r.id === b.dataset.sspView);
    if (!rec) return;
    await openSspPreview({ record: rec, patient, staff });
    load(); // shows any new email / print
  });

  load();
}