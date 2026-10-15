// Specialist Bank: specialists for referral letters.
// As a page (#/specialist-bank), or as an overlay from the form editor (openSpecialistBankDialog).
import { listSpecialists, setSpecialistActive, specialitiesOf } from "./specialists-api.js";
import { openSpecialistDialog } from "./specialist-field.js";
import { esc } from "./form-fields.js";
import { confirmDialog } from "./dialog.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

// embedded: inside the overlay (no back link or page title)
export function mountSpecialistBank(container, { staff = null, embedded = false } = {}) {
  const canArchive = can("forms.build");
  const st = { list: [], q: "", spec: "", archived: false };
  const root = document.createElement("section");
  root.className = embedded ? "sp-bank is-embedded" : "page wide sp-bank";
  root.innerHTML = `
    ${embedded ? "" : '<a class="back-link" href="#/forms">← Form Builder</a>'}
    <div class="fb-head">
      <div>${embedded ? "" : "<h2>Specialist Bank</h2>"}
        <p class="muted">Specialists for referral letters. Staff can also add new ones while filling in a form.</p></div>
      <div class="fb-head-actions"><button type="button" class="btn-primary" data-act="new">+ New specialist</button></div>
    </div>
    <div class="inv-tools">
      <label class="ib-search inv-find"><input type="search" data-f="q" placeholder="Search name, practice or speciality" aria-label="Search specialists" /></label>
      <select class="fb-select" data-f="spec" aria-label="Speciality"></select>
      ${canArchive ? '<label class="fe-check"><input type="checkbox" data-f="archived" /> Show archived</label>' : ""}
    </div>
    <div data-role="list"><div class="skeleton" style="height:220px;border-radius:14px"></div></div>`;
  container.replaceChildren(root);
  const box = root.querySelector('[data-role="list"]');
  const specSel = root.querySelector('[data-f="spec"]');

  const card = (s) => `
    <article class="sp-item${s.active ? "" : " is-off"}">
      <div class="sp-item-head"><strong>${esc(s.name)}</strong>
        ${s.speciality ? `<span class="inv-flag is-info">${esc(s.speciality)}</span>` : ""}
        ${s.active ? "" : '<em class="inv-off">Archived</em>'}</div>
      ${s.practice ? `<p>${esc(s.practice)}</p>` : ""}
      ${s.address ? `<p class="muted">${esc(s.address).replace(/\n/g, "<br>")}</p>` : ""}
      <p class="sp-contact">${[
        s.phone && `<a href="tel:${esc(s.phone.replace(/\s+/g, ""))}">${esc(s.phone)}</a>`,
        s.email && `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`,
      ].filter(Boolean).join(" · ")}</p>
      ${s.notes ? `<p class="sp-notes">${esc(s.notes).replace(/\n/g, "<br>")}</p>` : ""}
      <div class="sp-item-foot">
        <small class="muted">${s.updatedBy ? `Updated by ${esc(s.updatedBy)}` : ""}</small>
        <span>${s.active ? `<button type="button" class="lh-btn" data-edit="${esc(s.id)}">Edit</button>` : ""}
          ${canArchive ? `<button type="button" class="lh-btn is-quiet" data-arch="${esc(s.id)}">${s.active ? "Archive" : "Restore"}</button>` : ""}</span>
      </div>
    </article>`;

  function draw() {
    const shown = st.list.filter((s) => st.archived || s.active);
    const specs = specialitiesOf(shown);
    if (st.spec && !specs.includes(st.spec)) st.spec = "";
    specSel.innerHTML = `<option value="">All specialities</option>${specs.map((s) =>
      `<option value="${esc(s)}"${st.spec === s ? " selected" : ""}>${esc(s)}</option>`).join("")}`;
    const q = st.q.trim().toLowerCase();
    const rows = shown.filter((s) => (!st.spec || s.speciality === st.spec)
      && (!q || `${s.name} ${s.speciality} ${s.practice} ${s.address}`.toLowerCase().includes(q)));
    box.innerHTML = !st.list.length
      ? '<div class="tm-empty"><strong>No specialists yet.</strong><br>Add the specialists you refer to, so staff can choose them on referral letters.</div>'
      : rows.length ? `<div class="sp-grid">${rows.map(card).join("")}</div>` : '<div class="tm-empty">No specialists match.</div>';
  }

  async function load() {
    try {
      st.list = await listSpecialists({ force: true, includeInactive: true });
      if (root.isConnected) draw();
    } catch (err) {
      console.error("Specialist Bank failed:", err);
      if (root.isConnected) box.innerHTML = `<div class="tm-empty is-error">${err && err.code === "permission-denied"
        ? "The Specialist Bank is blocked. Check the specialists Firestore rule has been published."
        : "Couldn't load the Specialist Bank. Check your connection and try again."}</div>`;
    }
  }

  root.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="new"]')) {
      const s = await openSpecialistDialog({ list: st.list, staff, speciality: st.spec });
      if (s) { showToast(`${s.name} added`); load(); }
      return;
    }
    const ed = e.target.closest("[data-edit]");
    if (ed) {
      const cur = st.list.find((x) => x.id === ed.dataset.edit);
      if (cur && await openSpecialistDialog({ specialist: cur, list: st.list, staff })) { showToast("Saved"); load(); }
      return;
    }
    const ar = e.target.closest("[data-arch]");
    if (ar) {
      const cur = st.list.find((x) => x.id === ar.dataset.arch);
      if (!cur) return;
      if (cur.active && !(await confirmDialog({
        title: `Archive ${cur.name}?`,
        message: "They won't be offered on forms any more. Letters already saved keep their details, and you can restore them later.",
        confirmLabel: "Archive", tone: "warning",
      }))) return;
      try {
        await setSpecialistActive(cur.id, !cur.active, staff);
        showToast(cur.active ? "Archived" : "Restored");
        load();
      } catch (err) {
        console.error("Archive specialist failed:", err);
        showToast(err && err.code === "permission-denied" ? "Only staff with Form Builder access can archive specialists." : "Couldn't save. Try again.");
      }
    }
  });
  root.addEventListener("input", (e) => {
    const k = e.target.dataset.f;
    if (!k) return;
    st[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    draw();
  });

  load();
}

// The Specialist Bank as an overlay. Resolves when it's closed.
export function openSpecialistBankDialog({ staff = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog sp-bank-dlg";
    dlg.setAttribute("aria-label", "Specialist Bank");
    dlg.innerHTML = `
      <div class="sp-bank-dlg-head">
        <h3>Specialist Bank</h3>
        <button type="button" class="ib-tool" data-act="close-bank" aria-label="Close" title="Close">×</button>
      </div>
      <div data-role="bank"></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('[data-act="close-bank"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { dlg.remove(); resolve(); });
    mountSpecialistBank(dlg.querySelector('[data-role="bank"]'), { staff, embedded: true });
    dlg.showModal();
  });
}