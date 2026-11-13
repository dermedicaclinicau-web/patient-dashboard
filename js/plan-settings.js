// System configuration → Treatment plans: concern colours/names, services → concerns + downtime, patient copy (Admins).
import { listServicesSeen, serviceKey } from "./inventory-api.js";
import {
  getPlanSettings, saveServiceConcerns, suggestServiceConcerns,
  getPlanDocSettings, savePlanDocSettings, PLAN_DOC_DEFAULTS,
} from "./plan-api.js";
import { showToast } from "./utils.js";
import { canonicalCategory } from "./plan-editor.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const errText = (err, fb) => (err && err.code === "permission-denied"
  ? "Only Admins can change treatment plan settings. Check the plan_settings Firestore rule has been published."
  : err && err.code === "GEMINI_FAILED" ? "Gemini couldn't make suggestions just now. Try again in a minute."
  : err && err.code === "FORBIDDEN" ? "Only Admins can use Suggest with AI."
  : err && err.message && !err.code ? err.message : fb);

// part: "services" (Appointment services), "copy" (Patient copy), or "all" (both)
export async function renderPlanSettings(body, { staff, part = "all" } = {}) {
  const showSvc = part !== "copy";
  const showCopy = part !== "services";
  body.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
  let cfg;
  let seen;
  let docCfg;
  try {
    [cfg, seen, docCfg] = await Promise.all([
      getPlanSettings(),
      showSvc ? listServicesSeen(180).catch(() => []) : [],
      showCopy ? getPlanDocSettings().catch(() => ({ ...PLAN_DOC_DEFAULTS })) : null,
    ]);
  } catch (err) {
    console.error("Plan settings failed:", err);
    if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the settings. Try again."))}</div>`;
    return;
  }
  if (!body.isConnected) return;

  // One row per service: seen in bookings, already set up, or both
  const blank = (service, n = 0) => ({ service, n, concerns: [], notTreatment: false, downtimeDays: 0, downtimeNote: "", source: "" });
  const rows = new Map();
  seen.forEach((s) => rows.set(serviceKey(s.service), blank(s.service, s.n)));
  cfg.services.forEach((r) => {
    const k = serviceKey(r.service);
    rows.set(k, { ...(rows.get(k) || blank(r.service)), ...r });
  });
  const st = { q: "", view: "todo", busy: false };
  const isSet = (r) => r.concerns.length > 0 || r.notTreatment;
  const con = (name) => cfg.concerns.find((c) => c.name === name) || { label: name, colour: "#888780" };
  const chip = (name) => `<span class="ps-chip" style="--c:${esc(con(name).colour)}">${esc(con(name).label)}</span>`;

  const svcHtml = () => `
    <section class="tb-card">
      <h4>Services and concerns</h4>
      <p class="muted ps-note">Which concerns each appointment service treats. The treatment plan uses this to tick off steps when a
        matching visit happens, and downtime to warn about patient events (weddings, holidays). Consultations and reviews:
        mark them <strong>Not a treatment</strong>. To group services into the treatments staff pick on a plan, open a concern in
        <strong>Concerns and treatments</strong>.</p>
      <div class="inv-tools">
        <label class="ib-search inv-find">${SEARCH}<input type="search" data-ps-q placeholder="Search services" aria-label="Search services" /></label>
        <div class="fe-seg">${[["todo", "Not set up"], ["done", "Set up"], ["all", "All"]].map(([v, l]) =>
          `<label class="fe-seg-btn"><input type="radio" name="ps-v" value="${v}"${v === st.view ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
        <span class="inv-spacer"></span>
        <span class="muted" data-role="pscount"></span>
        <button type="button" class="lh-btn is-primary" data-ps="ai">Suggest with AI</button>
      </div>
      <div class="sl-list" data-role="pslist"></div>
    </section>`;

  const copyHtml = () => `
    <section class="tb-card">
      <h4>Patient copy</h4>
      <p class="muted ps-note">How a treatment plan looks when it's printed or emailed to a patient. The logo and clinic details
        come from the Form Builder letterhead. {First name} is replaced with the patient's first name. Clinicians' notes are never included.</p>
      <div class="inv-two">
        <label class="lh-field"><span class="lh-label">Title</span><input class="fe-input" data-pd="title" maxlength="80" value="${esc(docCfg.title)}" /></label>
        <label class="lh-field"><span class="lh-label">Colour</span><input type="color" data-pd="colour" value="${esc(docCfg.colour)}" /></label>
        <label class="lh-field inv-span"><span class="lh-label">Welcome</span><textarea data-pd="welcome" rows="3" maxlength="2000">${esc(docCfg.welcome)}</textarea></label>
        <label class="lh-field inv-span"><span class="lh-label">Closing</span><textarea data-pd="closing" rows="2" maxlength="2000">${esc(docCfg.closing)}</textarea></label>
        <label class="lh-field inv-span"><span class="lh-label">Small print</span><textarea data-pd="disclaimer" rows="2" maxlength="1000">${esc(docCfg.disclaimer)}</textarea></label>
        <label class="fe-check inv-span"><input type="checkbox" data-pd="prices"${docCfg.showPrices ? " checked" : ""} /> Show quotes by default (staff can untick each time)</label>
        <label class="lh-field inv-span"><span class="lh-label">Email subject</span><input class="fe-input" data-pd="emailSubject" maxlength="200" value="${esc(docCfg.emailSubject)}" /></label>
        <label class="lh-field inv-span"><span class="lh-label">Email message</span><textarea data-pd="emailMessage" rows="5" maxlength="3000">${esc(docCfg.emailMessage)}</textarea></label>
      </div>
      <div class="lh-actions"><button type="button" class="lh-btn is-primary" data-ps="save-doc">Save patient copy</button></div>
    </section>`;

  body.innerHTML = (showSvc ? svcHtml() : "") + (showCopy ? copyHtml() : "");

  const listEl = body.querySelector('[data-role="pslist"]');

  function visible() {
    const q = st.q.trim().toLowerCase();
    return [...rows.entries()]
      .filter(([, r]) => (st.view === "all" || (st.view === "todo" ? !isSet(r) : isSet(r)))
        && (!q || r.service.toLowerCase().includes(q) || r.concerns.some((c) => con(c).label.toLowerCase().includes(q))))
      .sort(([, a], [, b]) => b.n - a.n || a.service.localeCompare(b.service, "en-AU"));
  }

  function drawList() {
    if (!listEl) return;   // the Patient copy tab has no list
    const list = visible();
    listEl.innerHTML = list.length ? list.map(([k, r]) => `
      <div class="sl-row${isSet(r) ? "" : " is-unlinked"}">
        <div class="sl-name"><strong>${esc(r.service)}</strong>
          <small>${r.n ? `${r.n} booking${r.n === 1 ? "" : "s"} in the last 6 months` : "No recent bookings"}${r.source === "ai" ? " · suggested by AI" : ""}</small></div>
        <div class="sl-prods">${r.notTreatment ? '<span class="ps-chip is-none">Not a treatment</span>'
          : r.concerns.length ? r.concerns.map(chip).join("") : '<span class="muted">Not set up yet</span>'}
          ${r.downtimeDays ? `<span class="ps-dt">${r.downtimeDays} day${r.downtimeDays === 1 ? "" : "s"} downtime${r.downtimeNote ? ` · ${esc(r.downtimeNote)}` : ""}</span>` : ""}</div>
        <button type="button" class="lh-btn" data-ps-edit="${esc(k)}">${isSet(r) ? "Change" : "Set up"}</button>
      </div>`).join("")
      : `<div class="tm-empty">${rows.size ? (st.view === "todo" ? "Every service is set up. 👍" : "No services match.") : "No bookings in the last 6 months to take services from."}</div>`;
    const done = [...rows.values()].filter(isSet).length;
    body.querySelector('[data-role="pscount"]').textContent = `${done} of ${rows.size} set up`;
  }
  drawList();

  // The Concerns and treatments card above changed a concern: the chips and tick lists here follow
  const onConcerns = (e) => {
    if (!body.isConnected) { window.removeEventListener("plan-concerns-changed", onConcerns); return; }
    cfg.concerns = (e.detail || []).map((c) => ({ ...c }));
    const names = new Set(cfg.concerns.map((c) => c.name));
    // A concern moved into another follows it; a deleted one comes off its services
    rows.forEach((r) => { r.concerns = [...new Set(r.concerns.map((n) => canonicalCategory(n) || n))].filter((n) => names.has(n)); });
    drawList();
  };
  if (showSvc) window.addEventListener("plan-concerns-changed", onConcerns);

  async function persist() {
    await saveServiceConcerns([...rows.values()], staff);
    window.dispatchEvent(new CustomEvent("plan-services-changed", { detail: [...rows.values()] }));
  }

  /* ---------- One service ---------- */
  function edit(k) {
    const r = rows.get(k);
    if (!r) return;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${esc(r.service)}</h3>
          <p>Tick every concern this service treats. A visit for it can then complete a step in that concern of a patient's plan.</p></div>
        <div class="ps-ticks">${cfg.concerns.filter((c) => !c.hidden || r.concerns.includes(c.name)).map((c) => `
          <label class="fe-check"><input type="checkbox" name="con" value="${esc(c.name)}"${r.concerns.includes(c.name) ? " checked" : ""} />
            <i class="ps-dot" style="--c:${esc(c.colour)}"></i> ${esc(c.label)}</label>`).join("")}</div>
        <label class="fe-check"><input type="checkbox" name="none"${r.notTreatment ? " checked" : ""} /> Not a treatment (consultation, review, follow-up)</label>
        <div class="inv-two">
          <label class="lh-field"><span class="lh-label">Downtime</span>
            <div class="fe-num"><input name="days" type="number" min="0" max="60" step="1" value="${r.downtimeDays || ""}" placeholder="None" /><span>days</span></div></label>
          <label class="lh-field"><span class="lh-label">What to expect (optional)</span>
            <input name="note" maxlength="80" placeholder="e.g. redness and peeling" value="${esc(r.downtimeNote)}" /></label>
        </div>
        <small class="fe-note">Days a patient may not look their best afterwards. Used to warn when a step lands just before a patient's event.</small>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    // "Not a treatment" and concerns can't both be ticked
    form.addEventListener("change", (e) => {
      if (e.target.name === "none" && e.target.checked) form.querySelectorAll('[name="con"]').forEach((x) => { x.checked = false; });
      if (e.target.name === "con" && e.target.checked) form.elements.none.checked = false;
    });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const before = { ...r };
      Object.assign(r, {
        concerns: [...form.querySelectorAll('[name="con"]:checked')].map((x) => x.value),
        notTreatment: form.elements.none.checked,
        downtimeDays: Math.min(60, Math.max(0, parseInt(form.elements.days.value, 10) || 0)),
        downtimeNote: form.elements.note.value.trim(),
        source: "staff",
      });
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await persist();
        dlg.close();
        showToast(`${r.service} saved`);
        drawList();
      } catch (ex) {
        console.error("Save service failed:", ex);
        Object.assign(r, before);
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  /* ---------- Suggest with AI: review, then apply ---------- */
  async function suggest(btn) {
    if (st.busy) return;
    const todo = [...rows.values()].filter((r) => !isSet(r)).sort((a, b) => b.n - a.n).slice(0, 120);
    if (!todo.length) { showToast("Every service is already set up."); return; }
    st.busy = true;
    btn.disabled = true;
    btn.textContent = `Asking Gemini about ${todo.length}…`;
    let items;
    try {
      items = await suggestServiceConcerns(todo.map((r) => r.service));
    } catch (ex) {
      console.error("Suggest failed:", ex);
      showToast(errText(ex, "Couldn't get suggestions. Try again."));
      return;
    } finally {
      st.busy = false;
      btn.disabled = false;
      btn.textContent = "Suggest with AI";
    }
    const sugg = items.filter((it) => rows.has(serviceKey(it.service)) && (it.concerns.length || it.notTreatment || it.downtimeDays));
    if (!sugg.length) { showToast("No suggestions came back. Set these up by hand."); return; }

    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg ps-ai-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Suggestions for ${sugg.length} service${sugg.length === 1 ? "" : "s"}</h3>
          <p>Untick anything that's wrong, then apply. You can change any service afterwards.</p></div>
        <label class="fe-check"><input type="checkbox" data-all checked /> Tick all</label>
        <div class="ps-ai-list">${sugg.map((it, i) => `
          <label class="ps-ai-row"><input type="checkbox" name="ok" value="${i}" checked />
            <span><strong>${esc(it.service)}</strong>
              <span class="sl-prods">${it.notTreatment ? '<span class="ps-chip is-none">Not a treatment</span>' : it.concerns.map(chip).join("")}
                ${it.downtimeDays ? `<span class="ps-dt">${it.downtimeDays} day${it.downtimeDays === 1 ? "" : "s"} downtime</span>` : ""}</span></span>
          </label>`).join("")}</div>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Apply ticked</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
    const form = dlg.querySelector("form");
    form.querySelector("[data-all]").addEventListener("change", (e) => {
      form.querySelectorAll('[name="ok"]').forEach((x) => { x.checked = e.target.checked; });
    });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const picked = [...form.querySelectorAll('[name="ok"]:checked')].map((x) => sugg[Number(x.value)]);
      if (!picked.length) { dlg.close(); return; }
      const backup = picked.map((it) => [serviceKey(it.service), { ...rows.get(serviceKey(it.service)) }]);
      picked.forEach((it) => {
        const r = rows.get(serviceKey(it.service));
        Object.assign(r, { concerns: it.concerns, notTreatment: it.notTreatment, downtimeDays: it.downtimeDays, downtimeNote: "", source: "ai" });
      });
      const ok = form.querySelector('[type="submit"]');
      ok.disabled = true;
      try {
        await persist();
        dlg.close();
        showToast(`${picked.length} service${picked.length === 1 ? "" : "s"} set up`);
        drawList();
      } catch (ex) {
        console.error("Apply suggestions failed:", ex);
        backup.forEach(([k, r]) => rows.set(k, r));
        const err = dlg.querySelector(".lh-error");
        err.textContent = errText(ex, "Couldn't save. Try again.");
        err.hidden = false;
        ok.disabled = false;
      }
    });
  }

  /* ---------- Events ---------- */
  body.addEventListener("input", (e) => {
    if (e.target.matches("[data-ps-q]")) { st.q = e.target.value; drawList(); }
  });
  body.addEventListener("change", (e) => {
    if (e.target.name === "ps-v") { st.view = e.target.value; drawList(); }
  });
  body.addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-ps-edit]");
    if (ed) { edit(ed.dataset.psEdit); return; }
    const ai = e.target.closest('[data-ps="ai"]');
    if (ai) { suggest(ai); return; }
    const sd = e.target.closest('[data-ps="save-doc"]');
    if (sd) {
      const v = (k) => body.querySelector(`[data-pd="${k}"]`);
      sd.disabled = true;
      try {
        await savePlanDocSettings({
          title: v("title").value, colour: v("colour").value, welcome: v("welcome").value, closing: v("closing").value,
          disclaimer: v("disclaimer").value, showPrices: v("prices").checked,
          emailSubject: v("emailSubject").value, emailMessage: v("emailMessage").value,
        }, staff);
        showToast("Patient copy saved");
      } catch (ex) {
        console.error("Save patient copy failed:", ex);
        showToast(errText(ex, "Couldn't save. Try again."));
      } finally {
        sd.disabled = false;
      }
      return;
    }
  });
}