// System configuration → Treatment plans: the clinic's concerns, and the treatments offered for each one.
// Every change saves by itself.
import { getPlanSettings, savePlanConcernList, savePlanTreatments, deletePlanConcern } from "./plan-api.js";
import { catKey } from "./plan-editor.js";
import { patternText, countPlansWith, syncPlanConcerns } from "./master-plan-api.js";
import { listServicesSeen, serviceKey } from "./inventory-api.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { freqHtml, mountFreq } from "./plan-frequency.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const PATTERN_LABEL = { course: "A course", maintenance: "Ongoing (maintenance)", once: "Once", unknown: "Not set" };
const NEW_COLOURS = ["#0F766E", "#9333EA", "#DB2777", "#0891B2", "#CA8A04", "#4F46E5"];
const MAX_CONCERNS = 40;
const MAX_TREATMENTS = 300;
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

function openDlg(html) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg pcg-dlg";
  dlg.innerHTML = `<form class="lh-form" novalidate>${html}</form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

export async function renderPlanCatalogue(el, { staff = null } = {}) {
  el.innerHTML = '<section class="tb-card pcg"><div class="skeleton sm"></div></section>';
  let st;
  try {
    const [s, seen] = await Promise.all([getPlanSettings(), listServicesSeen(180).catch(() => [])]);
    st = {
      concerns: s.concerns.map((c) => ({ ...c })),
      treatments: (s.treatments || []).map((t) => ({ ...t })),
      services: s.services || [],
      moved: s.moved || [],                // concerns deleted and moved into another
      seen: seen.map((x) => x.service),   // every service booked in the last 6 months, set up or not
      open: new Set(), status: "", bad: false,
    };
  } catch (err) {
    console.error("Concerns and treatments failed:", err);
    if (el.isConnected) el.innerHTML = '<section class="tb-card pcg"><p class="empty-note error">Couldn\'t load the concerns. Check your connection and reload the page.</p></section>';
    return;
  }
  if (!el.isConnected) return;

  const txOf = (name) => st.treatments.filter((t) => t.concern === name);
  const conOf = (node) => {
    const art = node.closest(".pcg-con");
    return art ? st.concerns[Number(art.dataset.i)] || null : null;
  };

  /* ---------- Saving: one change after another, in order ---------- */

  let chain = Promise.resolve();
  function setStatus(text, bad = false) {
    st.status = text;
    st.bad = bad;
    const n = el.querySelector(".pcg-status");
    if (n) { n.textContent = text; n.classList.toggle("is-bad", bad); }
  }
  function persist(...kinds) {
    setStatus("Saving…");
    chain = chain.then(async () => {
      for (const k of kinds) {
        if (k === "concerns") {
          await savePlanConcernList(st.concerns, staff);
          window.dispatchEvent(new CustomEvent("plan-concerns-changed", { detail: st.concerns }));
        }
        else await savePlanTreatments(st.treatments, staff);
      }
      setStatus("All changes saved");
    }).catch((err) => {
      console.error("Concerns and treatments not saved:", err);
      setStatus(err && err.code === "permission-denied"
        ? "Not saved: you don't have access, or the Firestore rules haven't been published yet."
        : "Not saved. Check your connection and make the change again.", true);
    });
  }

  /* ---------- Drawing ---------- */

  function txHtml(t) {
    const sub = [patternText(t) || "No schedule set",
      t.services.length ? `${t.services.length} service${t.services.length === 1 ? "" : "s"} linked` : "no services linked"].join(" · ");
    return `<li class="pcg-tx-row" data-id="${esc(t.id)}">
      <span class="pcg-tx-main"><strong>${esc(t.name)}</strong><small>${esc(sub)}</small></span>
      <span class="pcg-tx-chips">${t.areas.map((a) => `<span class="pcg-area">${esc(a)}</span>`).join("")}${
        t.quote ? `<span class="pcg-price">${esc(t.quote)}</span>` : ""}</span>
      <button type="button" class="po-mini" data-pcg="edit-tx">Edit</button>
      <button type="button" class="po-x" data-pcg="del-tx" aria-label="Remove ${esc(t.name)}">×</button>
    </li>`;
  }

  function rowHtml(c, i) {
    const list = txOf(c.name);
    const open = st.open.has(c.name);
    return `<article class="pcg-con${c.hidden ? " is-hidden" : ""}${open ? " is-open" : ""}" style="--c:${esc(c.colour)}" data-i="${i}">
      <header class="pcg-con-head">
        <button type="button" class="pcg-toggle" data-pcg="toggle" aria-expanded="${open}"
          aria-label="${open ? "Close" : "Open"} ${esc(c.label)}">${CHEV}</button>
        <input type="color" value="${esc(c.colour)}" data-f="colour" aria-label="Colour for ${esc(c.label)}" />
        <span class="pcg-con-name">
          <input class="fe-input" data-f="label" maxlength="60" value="${esc(c.label)}" aria-label="Name staff and patients see"
            ${c.label !== c.name ? `title="Saved in plans as ${esc(c.name)}"` : ""} />
        </span>
        ${c.hidden ? '<span class="pcg-tag">Hidden</span>' : ""}
        <button type="button" class="pcg-count" data-pcg="toggle">${list.length} treatment${list.length === 1 ? "" : "s"}</button>
        <span class="pcg-acts">
          <button type="button" class="sc-ar-mv" data-pcg="up"${i === 0 ? " disabled" : ""} aria-label="Move ${esc(c.label)} up">▲</button>
          <button type="button" class="sc-ar-mv" data-pcg="down"${i === st.concerns.length - 1 ? " disabled" : ""} aria-label="Move ${esc(c.label)} down">▼</button>
          <button type="button" class="po-mini" data-pcg="hide">${c.hidden ? "Show" : "Hide"}</button>
          <button type="button" class="po-mini pcg-del" data-pcg="del-concern">Delete</button>
        </span>
      </header>
      ${open ? `<div class="pcg-body">
        ${list.length ? `<ul class="pcg-tx">${list.map(txHtml).join("")}</ul>`
          : '<p class="tb-none">No treatments yet. Add the ones you offer for this concern, so staff can pick them on a patient\'s plan.</p>'}
        <button type="button" class="lh-btn" data-pcg="add-tx">+ Add a treatment</button>
      </div>` : ""}
    </article>`;
  }

  function draw() {
    if (!el.isConnected) return;
    el.innerHTML = `<section class="tb-card pcg">
      <div class="pcg-head">
        <div>
          <h4>Concerns and treatments</h4>
          <p class="muted">The concerns every treatment plan is organised by, in the order staff see them. Open a concern to set up its treatments:
            the services that count as it, the areas it's offered for, and a quote. Changes save by themselves.</p>
          <small class="pcg-status${st.bad ? " is-bad" : ""}" role="status" aria-live="polite">${esc(st.status)}</small>
        </div>
        <button type="button" class="lh-btn is-primary" data-pcg="add-concern">+ Add a concern</button>
      </div>
      <div class="pcg-list">${st.concerns.map(rowHtml).join("")}</div>
      <p class="fe-note">Hidden concerns can't be chosen for new plans. Plans that already use one keep it.
        Renaming a concern changes what staff and patients see. Plans keep using it as before.</p>
      ${st.moved.length ? `<p class="fe-note pcg-moved">Deleted and moved: ${st.moved.map((m) =>
        `${esc(m.from)} → ${esc((st.concerns.find((y) => y.name === m.to) || { label: m.to }).label)}`).join(" · ")}.
        Older consultations read these as the new concern.
        <button type="button" class="po-mini" data-pcg="sync-plans">Check patient plans</button></p>` : ""}
    </section>`;
  }

  /* ---------- Add a concern ---------- */

  function addConcern() {
    if (st.concerns.length >= MAX_CONCERNS) { showToast(`You can have up to ${MAX_CONCERNS} concerns. Delete one you no longer use first.`); return; }
    const colour = NEW_COLOURS[st.concerns.filter((c) => c.custom).length % NEW_COLOURS.length];
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>Add a concern</h3><p>It's added to the end of the list. You can move it afterwards.</p></div>
      <label class="lh-field"><span class="lh-label">Name</span>
        <input name="cname" maxlength="60" placeholder="e.g. Hair Thinning" /></label>
      <label class="lh-field"><span class="lh-label">Colour</span>
        <input type="color" name="colour" value="${colour}" class="pcg-colour" /></label>
      <small class="fe-note">This name is permanent: it's how plans remember the concern. What staff and patients see can be changed at any time.</small>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Add concern</button>
      </div>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = form.elements.cname.value.trim().replace(/\s+/g, " ");
      const fail = (t) => { err.textContent = t; err.hidden = false; };
      if (!catKey(name)) { fail("Enter a name for the concern."); return; }
      if (st.concerns.some((c) => catKey(c.name) === catKey(name) || catKey(c.label) === catKey(name))) {
        fail("There's already a concern with that name. If it's hidden, press Show on it instead."); return;
      }
      st.concerns.push({ name, label: name, colour: form.elements.colour.value, hidden: false, custom: true });
      st.open.add(name);
      dlg.close();
      draw();
      persist("concerns");
      const last = el.querySelector(".pcg-con:last-child");
      if (last) last.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    form.elements.cname.focus();
  }

  /* ---------- Add / edit a treatment ---------- */

  function editTreatment(c, t) {
    const isNew = !t;
    if (isNew && st.treatments.length >= MAX_TREATMENTS) { showToast(`You can have up to ${MAX_TREATMENTS} treatments in total.`); return; }
    const x = t ? { ...t, services: [...t.services], areas: [...t.areas] }
      : { id: newId(), concern: c.name, name: "", services: [], areas: [], quote: "", description: "", pattern: "course", sessions: 3, intervalWeeks: 4 };
    const uniq = (arr) => [...new Map(arr.map((s) => [serviceKey(s), s])).values()];
    const byName = (a, b) => a.localeCompare(b, "en-AU");
    const mine = uniq(st.services.filter((r) => r.concerns.includes(c.name)).map((r) => r.service)).sort(byName);
    const mineKeys = new Set(mine.map(serviceKey));
    const notTx = new Set(st.services.filter((r) => r.notTreatment).map((r) => serviceKey(r.service)));
    const other = uniq([...x.services, ...[...st.services.map((r) => r.service), ...st.seen].filter((s) => !notTx.has(serviceKey(s)))])
      .filter((s) => !mineKeys.has(serviceKey(s))).sort(byName);
    const linked = new Set(x.services.map(serviceKey));
    const svcRow = (s, on) => `<label class="fe-check" data-find="${esc(s.toLowerCase())}">
      <input type="checkbox" name="svc" value="${esc(s)}"${on ? " checked" : ""} /> ${esc(s)}</label>`;

    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${isNew ? "Add a treatment" : "Edit treatment"}</h3>
        <p><span class="ps-chip" style="--c:${esc(c.colour)}">${esc(c.label)}</span></p></div>
      <label class="lh-field"><span class="lh-label">Treatment</span>
        <input name="txname" maxlength="120" value="${esc(x.name)}" placeholder="e.g. Rejuran" /></label>
      ${freqHtml(x)}
      <label class="lh-field"><span class="lh-label">Quote</span>
        <input name="quote" maxlength="200" value="${esc(x.quote)}" placeholder="e.g. $899 per session" /></label>
      <label class="lh-field"><span class="lh-label">Description for the patient (optional)</span>
        <textarea name="desc" rows="2" maxlength="300" placeholder="e.g. Stimulates your own collagen to firm and smooth the skin">${esc(x.description || "")}</textarea>
        <small class="fe-note">Shown in the Description column on the patient's copy of their plan.</small></label>
      <div class="lh-field"><span class="lh-label">Areas it's offered for</span>
        <div class="pcg-chips" data-role="areas"></div>
        <div class="pcg-addrow">
          <input class="fe-input" data-role="areanew" maxlength="60" placeholder="e.g. Full face" aria-label="Add an area" />
          <button type="button" class="lh-btn" data-act="areaadd">Add</button></div>
        <small class="fe-note">Staff choose from these when adding the treatment to a plan. Leave it empty if areas don't apply.</small></div>
      <div class="lh-field"><span class="lh-label">Appointment services that count as this treatment</span>
        <input type="search" class="fe-input" data-role="find" placeholder="Search services" aria-label="Search services" />
        <div class="po-svcs" data-role="svcs">
          ${mine.length ? `<p class="pcg-svc-h">Set up for ${esc(c.label)}</p>${mine.map((s) => svcRow(s, linked.has(serviceKey(s)))).join("")}` : ""}
          ${other.length ? `<p class="pcg-svc-h">Other services</p>${other.map((s) => svcRow(s, linked.has(serviceKey(s)))).join("")}` : ""}
        </div>
        <div class="pcg-addrow">
          <input class="fe-input" data-role="svcnew" maxlength="150" placeholder="Not in the list? Type the service name exactly" aria-label="Add a service by name" />
          <button type="button" class="lh-btn" data-act="svcadd">Add</button></div>
        <small class="fe-note">When a visit has one of these services, the next session of this treatment is ticked off on the patient's plan.</small></div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">${isNew ? "Add treatment" : "Save"}</button>
      </div>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const areasEl = dlg.querySelector('[data-role="areas"]');
    const areaNew = dlg.querySelector('[data-role="areanew"]');
    const svcsEl = dlg.querySelector('[data-role="svcs"]');
    const svcNew = dlg.querySelector('[data-role="svcnew"]');
    const find = dlg.querySelector('[data-role="find"]');
    const fail = (text) => { err.textContent = text; err.hidden = false; };

    const freq = mountFreq(dlg);

    const drawAreas = () => {
      areasEl.innerHTML = x.areas.map((a, i) => `<span class="pcg-area">${esc(a)}
        <button type="button" data-area="${i}" aria-label="Remove ${esc(a)}">×</button></span>`).join("")
        || '<span class="muted pcg-none">None added</span>';
    };
    const addArea = () => {
      areaNew.value.split(",").map((s) => s.trim().slice(0, 60)).filter(Boolean).forEach((a) => {
        if (x.areas.length < 12 && !x.areas.some((y) => y.toLowerCase() === a.toLowerCase())) x.areas.push(a);
      });
      areaNew.value = "";
      drawAreas();
    };
    drawAreas();

    const addService = () => {
      const name = svcNew.value.trim().slice(0, 150);
      if (!name) return;
      const have = [...svcsEl.querySelectorAll('[name="svc"]')].find((b) => serviceKey(b.value) === serviceKey(name));
      if (have) { have.checked = true; have.closest("[data-find]").hidden = false; }
      else svcsEl.insertAdjacentHTML("afterbegin", svcRow(name, true));
      svcNew.value = "";
    };

    find.addEventListener("input", () => {
      const q = find.value.trim().toLowerCase();
      svcsEl.querySelectorAll("[data-find]").forEach((r) => {
        r.hidden = !!q && !r.dataset.find.includes(q) && !r.querySelector("input").checked;
      });
    });
    // Enter in the small boxes adds to the list instead of saving the whole window
    [[areaNew, addArea], [svcNew, addService], [find, () => {}]].forEach(([input, fn]) => {
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fn(); } });
    });
    form.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-area]");
      if (rm) { x.areas.splice(Number(rm.dataset.area), 1); drawAreas(); return; }
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "cancel") dlg.close();
      else if (b.dataset.act === "areaadd") { addArea(); areaNew.focus(); }
      else if (b.dataset.act === "svcadd") { addService(); svcNew.focus(); }
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      err.hidden = true;
      addArea();   // an area typed but not yet added still counts
      const f = form.elements;
      const name = f.txname.value.trim();
      const pattern = f.pattern.value;
      const sessions = parseInt(f.sessions.value, 10);
      if (!name) { fail("Enter the treatment."); return; }
      if (pattern === "course" && !(sessions >= 1)) { fail("Enter how many sessions the course has."); return; }
      if (st.treatments.some((y) => y.id !== x.id && y.concern === c.name && y.name.trim().toLowerCase() === name.toLowerCase())) {
        fail(`${name} is already in this concern's list.`); return;
      }
      const next = {
        id: x.id, concern: c.name, name,
        services: [...form.querySelectorAll('[name="svc"]:checked')].map((b) => b.value).slice(0, 20),
        areas: x.areas, quote: f.quote.value.trim(), description: f.desc.value.trim(), ...freq.read(),
        hidden: false,
      };
      const i = st.treatments.findIndex((y) => y.id === x.id);
      if (i > -1) st.treatments[i] = next; else st.treatments.push(next);
      st.open.add(c.name);
      dlg.close();
      draw();
      persist("treatments");
    });
    form.elements.txname.focus();
  }

  /* ---------- Delete a concern (and move what uses it) ---------- */

  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const failText = (err, fb) => (err && err.code === "permission-denied"
    ? "Not saved: you don't have access, or the Firestore rules don't allow it yet."
    : err && err.message && !err.code ? err.message : fb);

  // Saves patient plans still under a moved concern's old name, with a progress bar in the window
  function runSync(dlg) {
    const box = dlg.querySelector(".pcg-progress");
    const prog = dlg.querySelector('[data-role="prog"]');
    const bar = dlg.querySelector(".pcg-bar i");
    box.hidden = false;
    return syncPlanConcerns(staff, (done, total) => {
      prog.textContent = total ? `Updating patient plans: ${done} of ${total}` : "Every patient plan is up to date.";
      bar.style.width = `${total ? Math.round((done / total) * 100) : 100}%`;
    });
  }

  function deleteConcern(c) {
    if (!c.hidden && st.concerns.filter((y) => !y.hidden).length <= 1) { showToast("Keep at least one concern showing."); return; }
    const targets = st.concerns.filter((y) => y !== c && !y.hidden);
    const txN = txOf(c.name).length;
    const svcN = st.services.filter((r) => r.concerns.includes(c.name)).length;
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>Delete ${esc(c.label)}?</h3>
        <p>It comes off this list and can't be chosen for plans any more.</p></div>
      <ul class="pcg-uses">
        <li>${plural(txN, "treatment")} in its list</li>
        <li>${plural(svcN, "appointment service")} set up for it</li>
        <li data-role="plans">Checking patient plans…</li>
      </ul>
      ${targets.length ? `<label class="pcg-opt"><input type="radio" name="how" value="move" checked />
        <span><strong>Move everything to another concern</strong>
          <small>Its treatments and services move across, and every patient plan that uses it is updated (each plan's history keeps the old version). Older consultations read as the new concern too.</small></span></label>
      <label class="lh-field pcg-to"><span class="lh-label">Move into</span>
        <select class="fb-select" name="to"><option value="">Choose a concern…</option>${
          targets.map((y) => `<option value="${esc(y.name)}">${esc(y.label)}</option>`).join("")}</select></label>` : ""}
      <label class="pcg-opt"><input type="radio" name="how" value="drop"${targets.length ? "" : " checked"} />
        <span><strong>Delete without moving</strong>
          <small>Its treatments are deleted and its services are unlinked. Patient plans that use it keep it, shown in grey.
            If a new consultation picks it, staff are asked to choose a concern.</small></span></label>
      <div class="pcg-progress" hidden><div class="pcg-bar"><i></i></div><small data-role="prog"></small></div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn pcg-danger">Delete</button>
      </div>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    const fail = (t) => { err.textContent = t; err.hidden = false; };
    const sel = form.elements.to;
    let busy = false;

    countPlansWith(c.name)
      .then((n) => { const li = dlg.querySelector('[data-role="plans"]'); if (li) li.textContent = `${plural(n, "patient plan")} use it`; })
      .catch((ex) => {
        console.warn("Plans not counted:", ex);
        const li = dlg.querySelector('[data-role="plans"]');
        if (li) li.textContent = "Patient plans couldn't be checked";
      });

    form.addEventListener("change", () => { if (sel) sel.disabled = form.elements.how.value !== "move"; });
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });   // Esc can't close it mid-way
    form.addEventListener("click", (e) => { if (!busy && e.target.closest('[data-act="cancel"]')) dlg.close(); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      err.hidden = true;
      const to = form.elements.how.value === "move" && sel ? sel.value : "";
      if (form.elements.how.value === "move" && !to) { fail("Choose the concern to move it into."); return; }
      const toLabel = to ? (st.concerns.find((y) => y.name === to) || { label: to }).label : "";
      const inputs = [...form.querySelectorAll("input, select, button")];
      const btn = form.querySelector('[type="submit"]');
      busy = true;
      inputs.forEach((x) => { x.disabled = true; });
      btn.textContent = "Deleting…";
      try {
        const job = chain.then(() => deletePlanConcern(c.name, to, staff));   // after any change still saving
        chain = job.catch(() => {});
        const s = await job;
        Object.assign(st, {
          concerns: s.concerns.map((x) => ({ ...x })), treatments: s.treatments.map((x) => ({ ...x })),
          services: s.services, moved: s.moved || [],
        });
        st.open.delete(c.name);
        if (to) st.open.add(to);
        draw();
        setStatus("All changes saved");
        window.dispatchEvent(new CustomEvent("plan-concerns-changed", { detail: st.concerns }));
        if (!to) { busy = false; dlg.close(); showToast(`${c.label} deleted`); return; }

        btn.textContent = "Updating plans…";
        const r = await runSync(dlg);
        busy = false;
        if (!r.failed.length) {
          dlg.close();
          showToast(`${c.label} moved into ${toLabel}${r.total ? ` · ${plural(r.total, "patient plan")} updated` : ""}`);
          return;
        }
        fail(`${plural(r.failed.length, "patient plan")} couldn't be updated. They already show ${toLabel}. Press Check patient plans under the list to try them again.`);
        dlg.querySelector(".lh-actions").innerHTML = '<button type="button" class="lh-btn is-primary" data-act="cancel">Close</button>';
      } catch (ex) {
        console.error("Delete concern failed:", ex);
        busy = false;
        inputs.forEach((x) => { x.disabled = false; });
        if (sel) sel.disabled = form.elements.how.value !== "move";
        btn.textContent = "Delete";
        fail(failText(ex, "Couldn't delete it. Check your connection and try again."));
      }
    });
  }

  // "Check patient plans": any plan still under a moved concern's old name (e.g. a sync that was interrupted)
  function syncDialog() {
    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>Check patient plans</h3>
        <p>Plans still saved under a concern that was moved are saved again under the new one. Each plan's history keeps the old version.</p></div>
      <div class="pcg-progress"><div class="pcg-bar"><i></i></div><small data-role="prog">Checking…</small></div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel" disabled>Close</button></div>`);
    const close = dlg.querySelector('[data-act="cancel"]');
    const err = dlg.querySelector(".lh-error");
    let busy = true;
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.querySelector("form").addEventListener("submit", (e) => e.preventDefault());
    close.addEventListener("click", () => dlg.close());
    runSync(dlg).then((r) => {
      dlg.querySelector('[data-role="prog"]').textContent = r.total
        ? `${plural(r.total - r.failed.length, "patient plan")} updated` : "Every patient plan is up to date.";
      if (r.failed.length) {
        err.textContent = `${plural(r.failed.length, "plan")} couldn't be updated. They still show the new concern. Try again later.`;
        err.hidden = false;
      }
    }).catch((ex) => {
      console.error("Plan check failed:", ex);
      err.textContent = failText(ex, "Couldn't check the patient plans. Try again.");
      err.hidden = false;
    }).finally(() => { busy = false; close.disabled = false; });
  }

  /* ---------- Events ---------- */

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pcg]");
    if (!b) return;
    const act = b.dataset.pcg;
    if (act === "add-concern") { addConcern(); return; }
    if (act === "sync-plans") { syncDialog(); return; }
    const c = conOf(b);
    if (!c) return;
    const i = st.concerns.indexOf(c);

    if (act === "toggle") {
      if (st.open.has(c.name)) st.open.delete(c.name); else st.open.add(c.name);
      draw();
    } else if (act === "up" || act === "down") {
      const j = i + (act === "up" ? -1 : 1);
      if (j < 0 || j >= st.concerns.length) return;
      [st.concerns[i], st.concerns[j]] = [st.concerns[j], st.concerns[i]];
      draw();
      persist("concerns");
    } else if (act === "hide") {
      if (!c.hidden && st.concerns.filter((y) => !y.hidden).length <= 1) { showToast("Keep at least one concern showing."); return; }
      c.hidden = !c.hidden;
      draw();
      persist("concerns");
    } else if (act === "del-concern") {
      deleteConcern(c);
    } else if (act === "add-tx") {
      editTreatment(c, null);
    } else if (act === "edit-tx" || act === "del-tx") {
      const row = b.closest("[data-id]");
      const t = row && st.treatments.find((y) => y.id === row.dataset.id);
      if (!t) return;
      if (act === "edit-tx") { editTreatment(c, t); return; }
      const ok = await confirmDialog({
        title: `Remove ${t.name}?`,
        message: "It's taken off the list staff pick from. Patient plans that already have it aren't changed.",
        confirmLabel: "Remove", tone: "danger",
      });
      if (!ok) return;
      st.treatments = st.treatments.filter((y) => y !== t);
      draw();
      persist("treatments");
    }
  });

  // The colour follows the picker straight away; it's saved when the picker closes
  el.addEventListener("input", (e) => {
    if (e.target.dataset.f !== "colour") return;
    const art = e.target.closest(".pcg-con");
    if (art) art.style.setProperty("--c", e.target.value);
  });

  el.addEventListener("change", (e) => {
    const f = e.target.dataset.f;
    const c = f ? conOf(e.target) : null;
    if (!c) return;
    if (f === "label") {
      c.label = e.target.value.trim().slice(0, 60) || c.name;
      e.target.value = c.label;
    } else if (f === "colour") {
      c.colour = e.target.value;
    } else return;
    persist("concerns");
  });

  // A service was set up in "Services and concerns" below: the treatment window offers it straight away
  const onServices = (e) => {
    if (!el.isConnected) { window.removeEventListener("plan-services-changed", onServices); return; }
    st.services = (e.detail || []).filter((r) => r.service);
  };
  window.addEventListener("plan-services-changed", onServices);

  draw();
}