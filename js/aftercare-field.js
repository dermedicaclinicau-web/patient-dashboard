// The Aftercare field on a live form (and on a saved form).
import { listAftercare, aftercarePanel, bindPanels } from "./aftercare-api.js";
import { openAftercarePicker } from "./aftercare-bank.js";
import { cleanRichHtml } from "./rich-html.js";
import { emailAftercare, printAftercare } from "./aftercare-send.js";
import { deliveryError } from "./form-delivery.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
const PRINT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>';
// saved: the saved answer ({ items: [...] }) when viewing a saved form; leave out when filling in
export function mountAftercareField(w, f, { saved, onChange = () => {}, patient = null, staff = null, actions = false } = {}) {
  const host = w && w.querySelector("[data-ac-host]");
  if (!host) return;
  bindPanels(host);

  // A saved form: exactly what was included at the time
  if (saved !== undefined) {
    const items = saved && Array.isArray(saved.items) ? saved.items : [];
    host.innerHTML = items.length
      ? `<div class="ac-list">${items.map((it) => aftercarePanel(
          { id: it.id || "", title: it.title || "Aftercare", treatment: "", html: cleanRichHtml(it.html || "") },
          { control: '<span class="ac-tag">Sent &amp; printed with this form</span>' })).join("")}</div>`
      : '<p class="fe-help">No aftercare was included with this form.</p>';
    return;
  }

  const choose = f.mode === "choose";
  const st = { byId: new Map(), picked: [], include: new Set() };

  // What gets saved: a copy of each ticked aftercare, so the record shows exactly what was sent
  w.acRead = () => ({
    items: st.picked.filter((id) => st.include.has(id) && st.byId.has(id)).map((id) => {
      const a = st.byId.get(id);
      return { id, title: a.title, html: a.html };
    }),
  });

  function render() {
    const rows = st.picked.map((id) => st.byId.get(id)).filter(Boolean).map((a) => aftercarePanel(a, { control: `
      <label class="ac-send"><input type="checkbox" data-ac-include="${esc(a.id)}"${st.include.has(a.id) ? " checked" : ""} /> Send &amp; print</label>
      ${choose ? `<button type="button" class="ac-x" data-ac-remove="${esc(a.id)}" aria-label="Remove ${esc(a.title)}" title="Remove">×</button>` : ""}` })).join("");
    host.innerHTML = (rows
      ? `<div class="ac-list">${rows}</div>`
      : `<p class="fe-help">${choose ? "No aftercare added yet." : "This form's aftercare couldn't be found. It may have been removed from the aftercare list."}</p>`)
      + (choose ? '<button type="button" class="lh-btn ac-add" data-ac-add>+ Add aftercare</button>' : "")
      + (actions && st.picked.length ? `
        <div class="ac-actions">
          <button type="button" class="ff-btn" data-ac-email>${MAIL}<span>Email aftercare</span></button>
          <button type="button" class="ff-btn" data-ac-print>${PRINT}<span>Print aftercare</span></button>
          <small class="muted">Uses the aftercare ticked “Send &amp; print”.</small>
        </div>` : "");
  }

  host.addEventListener("change", (e) => {
    const id = e.target.dataset && e.target.dataset.acInclude;
    if (id === undefined) return;
    if (e.target.checked) st.include.add(id); else st.include.delete(id);
    onChange();
  });
  host.addEventListener("click", async (e) => {
    const mailBtn = e.target.closest("[data-ac-email]");
    const printBtn = e.target.closest("[data-ac-print]");
    if (mailBtn || printBtn) {
      const items = w.acRead().items;
      if (!items.length) { showToast("Tick “Send & print” on at least one aftercare first."); return; }
      const btn = mailBtn || printBtn;
      if (btn.disabled) return;
      if (mailBtn) {
        await emailAftercare({ items, patient, staff, templateId: f.emailTemplate || "" });
        return;
      }
      const label = btn.querySelector("span");
      btn.disabled = true;
      label.textContent = "Preparing…";
      try {
        await printAftercare({ items, patient });
        showToast("Aftercare sent to the printer");
      } catch (err) {
        console.error("Print aftercare failed:", err);
        showToast(deliveryError(err));
      } finally {
        btn.disabled = false;
        label.textContent = "Print aftercare";
      }
      return;
    }
    const rm = e.target.closest("[data-ac-remove]");
    if (rm) {
      st.picked = st.picked.filter((x) => x !== rm.dataset.acRemove);
      st.include.delete(rm.dataset.acRemove);
      render();
      onChange();
      return;
    }
    if (e.target.closest("[data-ac-add]")) {
      const ids = await openAftercarePicker({ selected: st.picked });
      if (!ids || !host.isConnected) return;
      ids.forEach((id) => { if (!st.picked.includes(id)) st.include.add(id); });
      st.picked.forEach((id) => { if (!ids.includes(id)) st.include.delete(id); });
      st.picked = ids;
      render();
      onChange();
    }
  });

  host.innerHTML = '<p class="fe-help">Loading aftercare…</p>';
  listAftercare()
    .then((list) => {
      st.byId = new Map(list.map((a) => [a.id, a]));
      st.picked = (f.items || []).filter((id) => st.byId.has(id));
      if (f.preselect !== false) st.picked.forEach((id) => st.include.add(id));
      if (host.isConnected) render();
      onChange();
    })
    .catch((err) => {
      console.error("Aftercare load failed:", err);
      if (host.isConnected) host.innerHTML = '<p class="fe-help tb-bad">Couldn\'t load the aftercare instructions. Check your connection and refresh.</p>';
    });
}