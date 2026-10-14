// A patient's scanned billing sheets, for the Billing sheet section of the patient dashboard.
// Found by the booking's Patient ID. Scans saved without one are found by the exact patient name.
import { db } from "./firebase-config.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { money } from "./scanner-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : 0);

// Newest first
export async function listBillingScans({ pttId = "", name = "" } = {}) {
  const col = collection(db, "scans");
  const jobs = [];
  if (pttId) jobs.push(getDocs(query(col, where("patientPttId", "==", String(pttId)))));
  if (name) jobs.push(getDocs(query(col, where("patientName", "==", String(name)))));
  const found = new Map();
  (await Promise.all(jobs)).forEach((snap, i) => snap.forEach((d) => {
    const x = d.data();
    if (x.kind !== "billing") return;
    // A name match only counts for scans not linked to anyone (never another patient with the same name)
    if (pttId && i > 0 && x.patientPttId && x.patientPttId !== String(pttId)) return;
    found.set(d.id, { id: d.id, ...x });
  }));
  return [...found.values()].sort((a, b) =>
    String(b.apptDate || b.dateKey || "").localeCompare(String(a.apptDate || a.dateKey || "")) || ms(b.at) - ms(a.at));
}

const scanHtml = (s) => {
  const when = [niceDate(s.apptDate || s.dateKey), s.bookedAt || s.apptTime, s.provider || s.bookedWith].filter(Boolean).join(" · ");
  const taken = (s.lines || []).reduce((a, l) => a + (Number(l.take) || 0), 0);
  return `<details class="bs-item">
    <summary>
      <span class="bs-when">${esc(when || "Date not read")}</span>
      <span class="bs-total">${esc(money(s.productsTotal || 0))}</span>
      ${s.flagCount ? `<span class="bs-chip is-warn">${s.flagCount} to check</span>` : '<span class="bs-chip is-ok">All matched</span>'}
    </summary>
    <div class="bs-body">
      <table class="bs-table">
        <thead><tr><th>Product</th><th>Written</th><th>Off Shelf</th><th class="bs-num">Fee</th></tr></thead>
        <tbody>${(s.lines || []).map((l) => `<tr>
          <td>${esc(l.productName || "Not matched")}${(l.flags || []).map((f) => `<span class="bs-flag">${esc(f)}</span>`).join("")}</td>
          <td>${l.written ? esc(l.written) : '<span class="bs-muted">not written</span>'}</td>
          <td>${Number(l.take) || 0}</td>
          <td class="bs-num">${l.fee !== null && l.fee !== undefined ? esc(money(l.fee)) : "–"}${
            l.feeFrom === "price" ? '<small>retail</small>' : l.feeFrom === "edited" ? '<small>changed</small>' : ""}</td>
        </tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="3">Products total · ${taken} taken off the Shelf</td><td class="bs-num">${esc(money(s.productsTotal || 0))}</td></tr></tfoot>
      </table>
      ${s.note ? `<p class="bs-note">“${esc(s.note)}”</p>` : ""}
      <div class="bs-foot">
        ${s.photo && s.photo.url ? `<a href="${esc(s.photo.url)}" target="_blank" rel="noopener" class="bs-photo"><img src="${esc(s.photo.url)}" alt="The scanned billing sheet" loading="lazy" /></a>` : ""}
        <small>Scanned by ${esc(s.by || "staff")}${s.readName && s.readName !== s.patientName ? ` · read as “${esc(s.readName)}”` : ""}</small>
      </div>
    </div>
  </details>`;
};

// Draws the list into el. Returns how many scans there are (for the section's heading).
export async function renderBillingScans(el, { pttId = "", name = "" } = {}) {
  el.innerHTML = '<p class="bs-muted">Loading billing sheets…</p>';
  try {
    const scans = await listBillingScans({ pttId, name });
    el.innerHTML = scans.length ? `<div class="bs-list">${scans.map(scanHtml).join("")}</div>`
      : '<p class="bs-muted">No scanned billing sheets yet.</p>';
    return scans.length;
  } catch (err) {
    console.error("Billing sheets didn't load:", err);
    el.innerHTML = '<p class="bs-muted">Couldn\'t load the billing sheets. Try again.</p>';
    return 0;
  }
}