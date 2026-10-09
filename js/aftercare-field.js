// The Aftercare field on a live form (and on a saved form).
import { listAftercare, aftercarePanel, bindPanels } from "./aftercare-api.js";
import { openAftercarePicker } from "./aftercare-bank.js";
import { cleanRichHtml } from "./rich-html.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// saved: the saved answer ({ items: [...] }) when viewing a saved form; leave out when filling in
export function mountAftercareField(w, f, { saved, onChange = () => {} } = {}) {
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
      + (choose ? '<button type="button" class="lh-btn ac-add" data-ac-add>+ Add aftercare</button>' : "");
  }

  host.addEventListener("change", (e) => {
    const id = e.target.dataset && e.target.dataset.acInclude;
    if (id === undefined) return;
    if (e.target.checked) st.include.add(id); else st.include.delete(id);
    onChange();
  });
  host.addEventListener("click", async (e) => {
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