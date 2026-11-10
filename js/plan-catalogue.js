// System configuration → Treatment plans: the clinic's concerns, and the treatments offered for each one.
// Every change saves by itself.
import { getPlanSettings, savePlanConcernList, savePlanTreatments } from "./plan-api.js";
import { catKey } from "./plan-editor.js";
import { patternText } from "./master-plan-api.js";
import { serviceKey } from "./inventory-api.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

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
    const s = await getPlanSettings();
    st = {
      concerns: s.concerns.map((c) => ({ ...c })),
      treatments: (s.treatments || []).map((t) => ({ ...t })),
      services: s.services || [],
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
        if (k === "concerns") await savePlanConcernList(st.concerns, staff);
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
          <input class="fe-input" data-f="label" maxlength="60" value="${esc(c.label)}" aria-label="Name staff and patients see" />
          <small>${esc(c.name)}${c.custom ? " · added by the clinic" : ""}</small>
        </span>
        ${c.hidden ? '<span class="pcg-tag">Hidden</span>' : ""}
        <button type="button" class="pcg-count" data-pcg="toggle">${list.length} treatment${list.length === 1 ? "" : "s"}</button>
        <span class="pcg-acts">
          <button type="button" class="sc-ar-mv" data-pcg="up"${i === 0 ? " disabled" : ""} aria-label="Move ${esc(c.label)} up">▲</button>
          <button type="button" class="sc-ar-mv" data-pcg="down"${i === st.concerns.length - 1 ? " disabled" : ""} aria-label="Move ${esc(c.label)} down">▼</button>
          <button type="button" class="po-mini" data-pcg="hide">${c.hidden ? "Show" : "Hide"}</button>
          ${c.custom && c.hidden ? '<button type="button" class="po-mini pcg-del" data-pcg="del-concern">Delete</button>' : ""}
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
        The name in grey is how plans remember a concern, so it never changes.</p>
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
      : { id: newId(), concern: c.name, name: "", services: [], areas: [], quote: "", pattern: "course", sessions: 3, intervalWeeks: 4 };
    const uniq = (arr) => [...new Map(arr.map((s) => [serviceKey(s), s])).values()];
    const byName = (a, b) => a.localeCompare(b, "en-AU");
    const mine = uniq(st.services.filter((r) => r.concerns.includes(c.name)).map((r) => r.service)).sort(byName);
    const mineKeys = new Set(mine.map(serviceKey));
    const other = uniq([...x.services, ...st.services.filter((r) => !r.notTreatment).map((r) => r.service)])
      .filter((s) => !mineKeys.has(serviceKey(s))).sort(byName);
    const linked = new Set(x.services.map(serviceKey));
    const svcRow = (s, on) => `<label class="fe-check" data-find="${esc(s.toLowerCase())}">
      <input type="checkbox" name="svc" value="${esc(s)}"${on ? " checked" : ""} /> ${esc(s)}</label>`;

    const dlg = openDlg(`
      <div class="lh-dialog-head"><h3>${isNew ? "Add a treatment" : "Edit treatment"}</h3>
        <p><span class="ps-chip" style="--c:${esc(c.colour)}">${esc(c.label)}</span></p></div>
      <label class="lh-field"><span class="lh-label">Treatment</span>
        <input name="txname" maxlength="120" value="${esc(x.name)}" placeholder="e.g. Rejuran" /></label>
      <div class="inv-two">
        <label class="lh-field"><span class="lh-label">How often</span><select class="fb-select" name="pattern">${
          Object.entries(PATTERN_LABEL).map(([v, l]) => `<option value="${v}"${v === x.pattern ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="lh-field" data-role="sess"><span class="lh-label">Sessions</span>
          <input name="sessions" type="number" min="1" max="52" step="1" value="${x.sessions || ""}" /></label>
        <label class="lh-field" data-role="iv"><span class="lh-label">Every (weeks)</span>
          <input name="interval" type="number" min="1" max="520" step="1" value="${x.intervalWeeks || ""}" placeholder="e.g. 4" /></label>
        <label class="lh-field"><span class="lh-label">Quote</span>
          <input name="quote" maxlength="200" value="${esc(x.quote)}" placeholder="e.g. $899 per session" /></label>
      </div>
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

    const sync = () => {
      const p = form.elements.pattern.value;
      dlg.querySelector('[data-role="sess"]').style.display = p === "course" ? "" : "none";
      dlg.querySelector('[data-role="iv"]').style.display = p === "once" ? "none" : "";
    };
    sync();
    form.elements.pattern.addEventListener("change", sync);

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
        areas: x.areas, quote: f.quote.value.trim(), pattern,
        sessions: pattern === "course" ? sessions : 0,
        intervalWeeks: pattern === "once" ? 0 : parseInt(f.interval.value, 10) || 0,
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

  /* ---------- Events ---------- */

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pcg]");
    if (!b) return;
    const act = b.dataset.pcg;
    if (act === "add-concern") { addConcern(); return; }
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
      const n = txOf(c.name).length;
      const ok = await confirmDialog({
        title: `Delete ${c.label}?`,
        message: `It's removed from this list${n ? `, along with its ${n} treatment${n === 1 ? "" : "s"}` : ""}. ` +
          "Patient plans that already use it keep it, shown in grey. This can't be undone.",
        confirmLabel: "Delete", tone: "danger",
      });
      if (!ok) return;
      st.concerns = st.concerns.filter((y) => y !== c);
      st.treatments = st.treatments.filter((y) => y.concern !== c.name);
      st.open.delete(c.name);
      draw();
      persist("concerns", "treatments");
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

  draw();
}