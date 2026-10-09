// The Skin Script Protocol builder: #/ssp/new/<patientId>
import { SSP_STEPS, listSspProducts } from "./ssp-products-api.js";
import { createProductsConfig } from "./ssp-products.js";
import { createSspRecord, listSspRecords, syncSspToSheet } from "./ssp-api.js";
import { getPatient, patientIds } from "./patients.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { openSspPreview } from "./ssp-send.js";
import { getSspSettings, openSspSettings, SSP_DEFAULTS } from "./ssp-settings.js";

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => isoOf(new Date());
function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1 + n, d);
  return isoOf(dt);
}
const niceDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  check: ic('<polyline points="20 6 9 17 4 12"/>'),
  eye: ic('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
};

export async function mountSspBuilder(container, { patientId, staff = null, isAdmin = false } = {}) {
  const backHref = `#/patient/${encodeURIComponent(patientId)}`;
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `<a class="back-link" href="${backHref}">← Back to patient</a><div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);
  const fail = (title, msg) => {
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${backHref}">← Back to patient</a><div class="state"><strong>${esc(title)}</strong>${esc(msg)}</div>`;
  };

  let patient, products, settings;
  try {
    [patient, products, settings] = await Promise.all([
      getPatient(patientId),
      listSspProducts({ force: true }),
      getSspSettings().catch(() => ({ ...SSP_DEFAULTS })),
    ]);
  } catch (err) {
    console.error("SSP builder load failed:", err);
    fail("Couldn't open the Skin Script", err && err.code === "permission-denied"
      ? "Check the ssp_products Firestore rule has been published." : "Check your connection and try again.");
    return;
  }
  if (!root.isConnected) return;
  if (!patient) { fail("Patient not found", "Go back to the patient list and try again."); return; }

  const VALID_MONTHS = settings.validMonths || 3;
  let savedRecord = null; // once saved (from Save or from the preview)

  /* ---------- State: one row per product per step ---------- */
  const rows = new Map(); // "STEP:productId" -> row
  const byId = () => new Map(products.map((p) => [p.id, p]));
  let productMap = byId();
  const baseText = (r) => {
    const p = productMap.get(r.productId) || {};
    return (r.maint ? (p.maintenanceInstruction || p.defaultInstruction) : p.defaultInstruction) || "";
  };
  function ensureRows() {
    products.forEach((p) => p.steps.forEach((step) => {
      const key = `${step}:${p.id}`;
      if (rows.has(key)) return;
      const r = { key, step, productId: p.id, am: false, pm: false, maint: false, split: false, edited: false, days: new Set(), notes: "" };
      r.text = r.amText = r.pmText = baseText(r);
      rows.set(key, r);
    }));
  }
  ensureRows();
  const selected = (r) => r.am || r.pm;

  const draftKey = `ssp-draft:${patient.id}`;
  const meta = { recordDate: todayIso(), validUntil: addMonths(todayIso(), VALID_MONTHS) };
  let saving = false;

  /* ---------- Page ---------- */
  root.innerHTML = `
    <div class="ssp-wrap">
      <div class="ff-bar" role="region" aria-label="Skin Script actions">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${backHref}" aria-label="Back to patient" title="Back to patient">${I.back}</a>
          <div class="ff-bar-title">
            <strong>Skin Script Protocol</strong>
            <span>${esc(patient.name)} · <span data-role="count">Nothing ticked yet</span></span>
          </div>
          <div class="ff-bar-actions">
            <a class="ff-btn is-quiet" href="${backHref}">Cancel</a>
            <button type="button" class="ff-btn" data-act="preview">${I.eye}<span>Preview protocol</span></button>
            <button type="button" class="ff-btn is-primary" data-act="save">${I.check}<span>Save protocol</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>

      <div class="ssp-head">
        <div class="ssp-meta">
          <label><span>Record date</span><input type="date" class="fe-input" data-meta="recordDate" value="${meta.recordDate}" /></label>
          <label><span>Valid until</span><input type="date" class="fe-input" data-meta="validUntil" value="${meta.validUntil}" /></label>
        </div>
        <div class="ssp-tools">
          <input type="search" class="fe-input ssp-filter" data-role="q" placeholder="Filter products…" aria-label="Filter products" />
          <label class="ssp-toggle"><input type="checkbox" data-role="selonly" /> Show selected only</label>
          <button type="button" class="btn-ghost" data-act="clear">Clear all</button>
          ${isAdmin ? `<button type="button" class="btn-ghost" data-act="settings">SSP Settings</button>
            <button type="button" class="ssp-config" data-act="config">${I.gear}<span>Products Config</span></button>` : ""}
        </div>
      </div>
      <div data-role="banner"></div>
      <p class="ssp-hint">Tick AM / PM for the protocol. Tick Maint. to switch to the maintenance instruction.</p>

      <div class="ssp-table">
        <div class="ssp-thead"><span>Step</span><span>Product</span><span>Instruction</span><span>AM</span><span>PM</span><span>Maint.</span></div>
        <div data-role="body"></div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const body = $('[data-role="body"]');
  const qEl = $('[data-role="q"]');
  const selOnly = $('[data-role="selonly"]');
  const msgEl = $('[data-role="msg"]');
  const countEl = $('[data-role="count"]');
  const banner = $('[data-role="banner"]');

  /* ---------- Drawing ---------- */
  function rowHtml(r) {
    const p = productMap.get(r.productId);
    if (!p) return "";
    const ta = (f, v, label) => `${label ? `<span class="ssp-sublbl">${label}</span>` : ""}<textarea class="ssp-text" data-f="${f}" rows="2" aria-label="${label || "Instruction"} for ${esc(p.name)}">${esc(v)}</textarea>`;
    return `
      <div class="ssp-row${selected(r) ? " is-sel" : ""}" data-key="${esc(r.key)}" data-find="${esc((p.name + " " + p.size).toLowerCase())}">
        <div class="ssp-prod"><strong>${esc(p.name)}</strong>${p.size ? `<small>${esc(p.size)}</small>` : ""}</div>
        <div class="ssp-ins">
          <div class="ssp-ins-main">
            <div class="ssp-ins-texts">${r.split ? ta("amText", r.amText, "AM") + ta("pmText", r.pmText, "PM") : ta("text", r.text, "")}</div>
            <div class="ssp-ins-tools">
              <button type="button" class="ssp-mini" data-act="split" title="${r.split ? "Use one instruction for AM and PM" : "Separate AM and PM instructions"}">⇆ ${r.split ? "Join" : "Split"}</button>
              ${r.edited ? '<button type="button" class="ssp-mini" data-act="reset" title="Put the catalogue wording back">Reset</button>' : ""}
            </div>
          </div>
          <div class="ssp-when">
            <div class="ssp-days" role="group" aria-label="Days">${DAYS.map((d) =>
              `<button type="button" class="ssp-day${r.days.has(d) ? " is-on" : ""}" data-day="${d}" aria-pressed="${r.days.has(d)}">${d}</button>`).join("")}</div>
            <input class="ssp-notes" data-f="notes" maxlength="300" placeholder="time or notes (e.g. after cleansing)" value="${esc(r.notes)}" />
          </div>
        </div>
        <label class="ssp-tick"><input type="checkbox" data-f="am"${r.am ? " checked" : ""} aria-label="AM" /></label>
        <label class="ssp-tick"><input type="checkbox" data-f="pm"${r.pm ? " checked" : ""} aria-label="PM" /></label>
        <label class="ssp-tick"><input type="checkbox" data-f="maint"${r.maint ? " checked" : ""} aria-label="Maintenance" /></label>
      </div>`;
  }

  function renderAll() {
    body.innerHTML = SSP_STEPS.map((s) => {
      const inStep = products.filter((p) => p.steps.includes(s.key));
      if (!inStep.length) return "";
      return `
        <section class="ssp-group" data-step="${s.key}" style="--tone:${s.tone};--ink:${s.ink}">
          <div class="ssp-step"><strong>${esc(s.label)}</strong>${s.sub ? `<small>${esc(s.sub)}</small>` : ""}</div>
          <div class="ssp-rows">${inStep.map((p) => rowHtml(rows.get(`${s.key}:${p.id}`))).join("")}</div>
        </section>`;
    }).join("") || '<div class="tm-empty">No published products yet. An admin can add them in Products Config.</div>';
    applyFilter();
    updateCount();
  }

  function redrawRow(key) {
    const el = body.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (el) el.outerHTML = rowHtml(rows.get(key));
    applyFilter();
  }

  function applyFilter() {
    const q = qEl.value.trim().toLowerCase();
    body.querySelectorAll(".ssp-group").forEach((g) => {
      let any = false;
      g.querySelectorAll(".ssp-row").forEach((el) => {
        const r = rows.get(el.dataset.key);
        const show = (!q || el.dataset.find.includes(q)) && (!selOnly.checked || (r && selected(r)));
        el.hidden = !show;
        if (show) any = true;
      });
      g.hidden = !any;
    });
  }

  function updateCount() {
    const n = [...rows.values()].filter(selected).length;
    countEl.textContent = n ? `${n} product${n === 1 ? "" : "s"} selected` : "Nothing ticked yet";
  }

  /* ---------- Drafts (on this computer) ---------- */
  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const changed = [...rows.values()].filter((r) => selected(r) || r.maint || r.edited || r.days.size || r.notes || r.split)
        .map((r) => ({ key: r.key, am: r.am, pm: r.pm, maint: r.maint, split: r.split, edited: r.edited,
          text: r.text, amText: r.amText, pmText: r.pmText, days: [...r.days], notes: r.notes }));
      try {
        if (changed.length) localStorage.setItem(draftKey, JSON.stringify({ savedAt: Date.now(), ...meta, rows: changed }));
        else localStorage.removeItem(draftKey);
      } catch { /* storage full or private mode */ }
    }, 400);
  }
  function applySaved(list) {
    list.forEach((d) => {
      const r = rows.get(d.key);
      if (!r) return;
      Object.assign(r, { am: !!d.am, pm: !!d.pm, maint: !!d.maint, split: !!d.split, edited: !!d.edited,
        text: d.text ?? r.text, amText: d.amText ?? r.amText, pmText: d.pmText ?? r.pmText, notes: d.notes || "" });
      r.days = new Set(Array.isArray(d.days) ? d.days : []);
    });
  }
  function clearRows() {
    rows.forEach((r) => {
      Object.assign(r, { am: false, pm: false, maint: false, split: false, edited: false, notes: "" });
      r.days = new Set();
      r.text = r.amText = r.pmText = baseText(r);
    });
  }

  // A saved protocol's choices, ticked on this one
  function applyRecord(rec) {
    clearRows();
    (rec.items || []).forEach((it) => {
      const r = rows.get(`${it.step}:${it.productId}`);
      if (!r) return;
      r.am = !!it.am; r.pm = !!it.pm; r.maint = !!it.maint;
      r.amText = it.amText || ""; r.pmText = it.pmText || "";
      r.split = !!(it.am && it.pm && r.amText !== r.pmText);
      r.text = it.am ? r.amText : r.pmText;
      r.edited = r.split || r.text !== baseText(r);
      r.days = new Set(Array.isArray(it.days) ? it.days : []);
      r.notes = it.notes || "";
    });
  }

  /* ---------- Events ---------- */
  body.addEventListener("change", (e) => {
    const el = e.target;
    const rowEl = el.closest(".ssp-row");
    if (!rowEl || el.type !== "checkbox") return;
    const r = rows.get(rowEl.dataset.key);
    r[el.dataset.f] = el.checked;
    if (el.dataset.f === "maint" && !r.edited) {
      r.text = r.amText = r.pmText = baseText(r);
      redrawRow(r.key);
    } else {
      rowEl.classList.toggle("is-sel", selected(r));
      if (selOnly.checked) applyFilter();
    }
    updateCount();
    saveDraft();
  });
  body.addEventListener("input", (e) => {
    const el = e.target;
    const rowEl = el.closest(".ssp-row");
    if (!rowEl || !el.dataset.f || el.type === "checkbox") return;
    const r = rows.get(rowEl.dataset.key);
    r[el.dataset.f] = el.value;
    if (el.dataset.f !== "notes" && !r.edited) {
      r.edited = true;
      const tools = rowEl.querySelector(".ssp-ins-tools");
      if (tools && !tools.querySelector('[data-act="reset"]')) {
        tools.insertAdjacentHTML("beforeend", '<button type="button" class="ssp-mini" data-act="reset" title="Put the catalogue wording back">Reset</button>');
      }
    }
    saveDraft();
  });
  body.addEventListener("click", (e) => {
    const rowEl = e.target.closest(".ssp-row");
    if (!rowEl) return;
    const r = rows.get(rowEl.dataset.key);
    const day = e.target.closest("[data-day]");
    if (day) {
      const d = day.dataset.day;
      if (r.days.has(d)) r.days.delete(d); else r.days.add(d);
      day.classList.toggle("is-on", r.days.has(d));
      day.setAttribute("aria-pressed", String(r.days.has(d)));
      saveDraft();
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "split") {
      if (r.split) { r.text = r.amText; r.split = false; }
      else { r.amText = r.pmText = r.text; r.split = true; }
      redrawRow(r.key);
      saveDraft();
    } else if (act.dataset.act === "reset") {
      r.edited = false;
      r.split = false;
      r.text = r.amText = r.pmText = baseText(r);
      redrawRow(r.key);
      saveDraft();
    }
  });

  root.querySelectorAll("[data-meta]").forEach((el) => el.addEventListener("input", () => {
    meta[el.dataset.meta] = el.value;
    if (el.dataset.meta === "recordDate" && /^\d{4}-\d{2}-\d{2}$/.test(el.value)) {
      meta.validUntil = addMonths(el.value, VALID_MONTHS);
      $('[data-meta="validUntil"]').value = meta.validUntil;
    }
    saveDraft();
  }));
  qEl.addEventListener("input", applyFilter);
  selOnly.addEventListener("change", applyFilter);

  root.addEventListener("click", async (e) => {
    const act = e.target.closest(".ssp-head [data-act], .ff-bar [data-act], [data-role='banner'] [data-act]");
    if (!act) return;
    const a = act.dataset.act;
    if (a === "clear") {
      if (![...rows.values()].some((r) => selected(r) || r.edited || r.days.size || r.notes)) return;
      const ok = await confirmDialog({ title: "Clear everything?", message: "All ticks, edited instructions, days and notes on this protocol are cleared.", confirmLabel: "Clear all", tone: "warning" });
      if (!ok) return;
      clearRows(); renderAll(); saveDraft();
    } else if (a === "config") {
      openProductsConfig();
    } else if (a === "preview") {
      openPreview();
    } else if (a === "settings") {
      openSspSettings({ staff });
    } else if (a === "save") {
      save();
    } else if (a === "use-last") {
      applyRecord(lastRecord); renderAll(); saveDraft();
      banner.innerHTML = `<div class="ssp-banner is-ok">Started from the protocol saved ${esc(niceDate(lastRecord.recordDate))}. Adjust anything that's changed.</div>`;
    } else if (a === "fresh") {
      clearRows();
      meta.recordDate = todayIso();
      meta.validUntil = addMonths(meta.recordDate, VALID_MONTHS);
      $('[data-meta="recordDate"]').value = meta.recordDate;
      $('[data-meta="validUntil"]').value = meta.validUntil;
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      renderAll();
      banner.innerHTML = "";
    } else if (a === "dismiss") {
      banner.innerHTML = "";
    }
  });

  /* ---------- Products Config (admins) ---------- */
  function openProductsConfig() {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ssp-cfg-dlg";
    dlg.innerHTML = `
      <div class="ssp-cfg-head"><div><h3>Product Configuration</h3><p class="muted">Edit, add, or unpublish products in your catalogue.</p></div>
        <button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>
      <div data-role="cfg"></div>`;
    document.body.appendChild(dlg);
    const cfg = createProductsConfig(dlg.querySelector('[data-role="cfg"]'), { staff, isAdmin });
    const close = async () => {
      if (cfg.isDirty() && !(await confirmDialog({ title: "Discard your changes?", message: "The product you're editing hasn't been saved.", confirmLabel: "Discard changes", tone: "warning" }))) return;
      dlg.close();
    };
    dlg.querySelector('[data-act="close"]').addEventListener("click", close);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    dlg.addEventListener("close", async () => {
      dlg.remove();
      try {
        products = await listSspProducts({ force: true });
        productMap = byId();
        ensureRows();
        rows.forEach((r) => { if (!r.edited) r.text = r.amText = r.pmText = baseText(r); });
        if (root.isConnected) renderAll();
      } catch (err) { console.warn("Couldn't refresh products:", err); }
    });
    dlg.showModal();
  }

  /* ---------- Saving ---------- */
  function items() {
    const order = SSP_STEPS.map((s) => s.key);
    return [...rows.values()].filter(selected)
      .sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step) ||
        (productMap.get(a.productId) || {}).name.localeCompare((productMap.get(b.productId) || {}).name, "en-AU"))
      .map((r) => {
        const p = productMap.get(r.productId) || {};
        const am = r.split ? r.amText : r.text;
        const pm = r.split ? r.pmText : r.text;
        return {
          productId: r.productId, name: String(p.name || "").slice(0, 150), size: String(p.size || "").slice(0, 60),
          step: r.step, am: r.am, pm: r.pm, maint: r.maint,
          amText: r.am ? String(am || "").trim().slice(0, 3000) : "",
          pmText: r.pm ? String(pm || "").trim().slice(0, 3000) : "",
          days: DAYS.filter((d) => r.days.has(d)),
          notes: String(r.notes || "").trim().slice(0, 300),
        };
      });
  }

  // Saves to Firestore and SSP_NEW. Returns the saved protocol; throws with a readable message.
  async function doSave() {
    if (savedRecord) return savedRecord;
    const list = items();
    if (!list.length) throw new Error("Tick AM or PM on at least one product.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.recordDate) || !/^\d{4}-\d{2}-\d{2}$/.test(meta.validUntil)) {
      throw new Error("Check the record date and valid until date.");
    }
    if (meta.validUntil < meta.recordDate) throw new Error("Valid until must be after the record date.");
    const data = {
      recordId: `SSP-${meta.recordDate.replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      patientId: patient.id,
      patientPttId: patient.pttId || "",
      patientName: patient.name || "",
      recordDate: meta.recordDate,
      validUntil: meta.validUntil,
      items: list,
    };
    try {
      const id = await createSspRecord(data, staff);
      savedRecord = { id, ...data, createdBy: (staff && staff.name) || "" };
    } catch (err) {
      throw new Error(err.code === "permission-denied"
        ? "Couldn't save. Check the ssp_records Firestore rule has been published."
        : err.code ? "Couldn't save. Check your connection and try again." : err.message);
    }
    try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
    syncSspToSheet(savedRecord.id).catch((err) => console.warn("Saved, but SSP_NEW wasn't updated:", err));
    return savedRecord;
  }

  async function save() {
    if (saving) return;
    if (savedRecord) { location.hash = backHref; return; }
    saving = true;
    msgEl.textContent = "";
    const btn = $('[data-act="save"]');
    const lbl = btn.querySelector("span");
    btn.disabled = true;
    lbl.textContent = "Saving…";
    try {
      const rec = await doSave();
      showToast(`Skin Script Protocol saved (${rec.items.length} product${rec.items.length === 1 ? "" : "s"})`);
      location.hash = backHref;
    } catch (err) {
      console.error("SSP save failed:", err);
      msgEl.textContent = err.message;
      btn.disabled = false;
      lbl.textContent = "Save protocol";
    } finally {
      saving = false;
    }
  }

  async function openPreview() {
    const list = items();
    if (!list.length) { msgEl.textContent = "Tick AM or PM on at least one product to preview."; return; }
    msgEl.textContent = "";
    const res = await openSspPreview({
      record: savedRecord || {
        patientId: patient.id, patientName: patient.name || "",
        recordDate: meta.recordDate, validUntil: meta.validUntil, items: list,
      },
      patient, staff,
      onSave: savedRecord ? null : doSave,
    });
    if (res && res.saved) location.hash = backHref; // saved from the preview: back to the patient
  }
  
  /* ---------- Start ---------- */
  let lastRecord = null;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(draftKey) || "null"); } catch { draft = null; }
  if (draft && Array.isArray(draft.rows) && draft.rows.length) {
    applySaved(draft.rows);
    if (draft.recordDate) { meta.recordDate = draft.recordDate; $('[data-meta="recordDate"]').value = meta.recordDate; }
    if (draft.validUntil) { meta.validUntil = draft.validUntil; $('[data-meta="validUntil"]').value = meta.validUntil; }
    const when = new Date(draft.savedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    banner.innerHTML = `<div class="ssp-banner">Your unsaved draft from ${esc(when)} has been restored.
      <button type="button" class="lh-btn is-quiet" data-act="fresh">Start fresh</button></div>`;
  }
  renderAll();

  listSspRecords([patient.id, ...patientIds(patient)])
    .then((list) => {
      lastRecord = list[0] || null;
      if (!lastRecord || !root.isConnected || (draft && draft.rows && draft.rows.length)) return;
      banner.innerHTML = `<div class="ssp-banner">${esc(patient.firstName || patient.name)} has a protocol from ${esc(niceDate(lastRecord.recordDate))}
        (${(lastRecord.items || []).length} products).
        <button type="button" class="lh-btn is-primary" data-act="use-last">Use their last protocol</button>
        <button type="button" class="lh-btn is-quiet" data-act="dismiss">Start blank</button></div>`;
    })
    .catch((err) => console.warn("Couldn't load earlier protocols:", err));
}