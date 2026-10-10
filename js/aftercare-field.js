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
const fmtDay = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};
const discText = (by, at) => `Discussed with the patient${by ? ` by ${esc(by)}` : ""}${at ? ` on ${esc(fmtDay(at))}` : ""}`;

// saved: the saved answer ({ items: [...] }) when viewing a saved form; leave out when filling in
export function mountAftercareField(w, f, { saved, onChange = () => {}, patient = null, staff = null, actions = false } = {}) {
  const host = w && w.querySelector("[data-ac-host]");
  if (!host) return;
  bindPanels(host);

  // A saved form: exactly what was included at the time, and whether it was discussed
  if (saved !== undefined) {
    const items = saved && Array.isArray(saved.items) ? saved.items : [];
    const all = saved && saved.discussed;
    host.innerHTML = items.length
      ? `<div class="ac-list">${items.map((it) => aftercarePanel(
          { id: it.id || "", title: it.title || "Aftercare", treatment: "", html: cleanRichHtml(it.html || "") },
          { control: `${it.discussed ? `<span class="ac-tag is-disc" title="${discText(it.discussedBy, it.discussedAt)}">✓ Discussed${
              it.discussedBy ? ` · ${esc(it.discussedBy)}` : ""}</span>` : ""}<span class="ac-tag">Sent &amp; printed with this form</span>` })).join("")}</div>${
          all ? `<p class="ac-disc-saved">✓ All the aftercare above was ${discText(all.by, all.at).toLowerCase()}.</p>` : ""}`
      : '<p class="fe-help">No aftercare was included with this form.</p>';
    return;
  }

  const choose = f.mode === "choose";
  const confirmMode = ["each", "all", "off"].includes(f.confirm) ? f.confirm : "each";
  const who = (staff && staff.name) || "";
  // disc: aftercare id -> when it was ticked as discussed; discAll: when "all discussed" was ticked
  const st = { byId: new Map(), picked: [], include: new Set(), disc: new Map(), discAll: "" };
  const included = () => st.picked.filter((id) => st.include.has(id) && st.byId.has(id));

  // What gets saved: a copy of each ticked aftercare, so the record shows exactly what was sent
  w.acRead = () => {
    const items = included().map((id) => {
      const a = st.byId.get(id);
      const out = { id, title: a.title, html: a.html };
      if (confirmMode === "each" && st.disc.has(id)) {
        out.discussed = true;
        out.discussedBy = who;
        out.discussedAt = st.disc.get(id);
      }
      return out;
    });
    const res = { items };
    if (confirmMode === "all" && st.discAll && items.length) res.discussed = { by: who, at: st.discAll };
    return res;
  };

  // Why the form can't be saved yet, or ""
  w.acProblem = () => {
    if (confirmMode === "off") return "";
    const inc = included();
    if (!inc.length) return "";
    if (confirmMode === "all") return st.discAll ? "" : "Tick that the aftercare was discussed with the patient.";
    const missing = inc.filter((id) => !st.disc.has(id));
    if (!missing.length) return "";
    return missing.length === 1
      ? `Tick that “${st.byId.get(missing[0]).title}” was discussed with the patient.`
      : `Tick that each aftercare was discussed with the patient (${missing.length} still to tick).`;
  };

  function render() {
    const rows = st.picked.map((id) => st.byId.get(id)).filter(Boolean).map((a) => aftercarePanel(a, { control: `
      ${confirmMode === "each" ? `<label class="ac-disc${st.disc.has(a.id) ? " is-on" : ""}"><input type="checkbox" data-ac-disc="${esc(a.id)}"${
        st.disc.has(a.id) ? " checked" : ""} /> Discussed</label>` : ""}
      <label class="ac-send"><input type="checkbox" data-ac-include="${esc(a.id)}"${st.include.has(a.id) ? " checked" : ""} /> Send &amp; print</label>
      ${choose ? `<button type="button" class="ac-x" data-ac-remove="${esc(a.id)}" aria-label="Remove ${esc(a.title)}" title="Remove">×</button>` : ""}` })).join("");
    host.innerHTML = (rows
      ? `<div class="ac-list">${rows}</div>`
      : `<p class="fe-help">${choose ? "No aftercare added yet." : "This form's aftercare couldn't be found. It may have been removed from the aftercare list."}</p>`)
      + (confirmMode === "all" && rows
        ? `<label class="ac-disc-all${st.discAll ? " is-on" : ""}"><input type="checkbox" data-ac-disc-all${st.discAll ? " checked" : ""} />
            All the aftercare above was discussed with the patient</label>` : "")
      + (choose ? '<button type="button" class="lh-btn ac-add" data-ac-add>+ Add aftercare</button>' : "")
      + (actions && st.picked.length ? `
        <div class="ac-actions">
          <button type="button" class="ff-btn" data-ac-email>${MAIL}<span>Email aftercare</span></button>
          <button type="button" class="ff-btn" data-ac-print>${PRINT}<span>Print aftercare</span></button>
          <small class="muted">Uses the aftercare ticked “Send &amp; print”.</small>
        </div>` : "");
  }

  host.addEventListener("change", (e) => {
    const d = e.target.dataset || {};
    if (d.acDisc !== undefined) {
      if (e.target.checked) st.disc.set(d.acDisc, new Date().toISOString()); else st.disc.delete(d.acDisc);
      const pill = e.target.closest(".ac-disc");
      if (pill) pill.classList.toggle("is-on", e.target.checked);
      onChange();
      return;
    }
    if (d.acDiscAll !== undefined) {
      st.discAll = e.target.checked ? new Date().toISOString() : "";
      const box = e.target.closest(".ac-disc-all");
      if (box) box.classList.toggle("is-on", e.target.checked);
      onChange();
      return;
    }
    if (d.acInclude === undefined) return;
    if (e.target.checked) st.include.add(d.acInclude); else st.include.delete(d.acInclude);
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
      const id = rm.dataset.acRemove;
      st.picked = st.picked.filter((x) => x !== id);
      st.include.delete(id);
      st.disc.delete(id);
      render();
      onChange();
      return;
    }
    if (e.target.closest("[data-ac-add]")) {
      const ids = await openAftercarePicker({ selected: st.picked });
      if (!ids || !host.isConnected) return;
      ids.forEach((id) => { if (!st.picked.includes(id)) st.include.add(id); });
      st.picked.forEach((id) => { if (!ids.includes(id)) { st.include.delete(id); st.disc.delete(id); } });
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