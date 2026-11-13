// System configuration → Treatment plans → Patient copy: how every patient's copy of their plan looks,
// and the email it's sent with. The preview uses a sample patient and the clinic's own concerns and treatments.
// The page design is edited in the same designer as a patient's Print or email window (plan-designer.js).
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getPlanSettings, getPlanDocSettings, savePlanDocSettings, getPlanWorkflow, cleanWorkflow, phaseOf, DOC_FONTS,
} from "./plan-api.js";
import { planDocHtml } from "./plan-doc.js";
import { openPlanDesigner } from "./plan-designer.js";
import { listPublishedForms, categoryLabel } from "./form-templates.js";
import { bankImage } from "./image-bank-api.js";
import { thisMonth, addMonths } from "./plan-track.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Stops password managers offering to fill these boxes
const NO_FILL = 'autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore';

const SAMPLE_PATIENT = {
  id: "sample", pttId: "SAMPLE", name: "Jane Sample", firstName: "Jane", lastName: "Sample",
  dobKey: "1988-05-14", email: "jane@example.com", mobile: "", address: "",
};
const SAMPLE_MESSAGE = "Lovely to see you today. Here's the plan we talked about.";

// Two concerns from the clinic's list, with their own treatments when there are some
function samplePlan(settings, wf) {
  const cons = settings.concerns.filter((c) => !c.hidden).slice(0, 2);
  const fallback = [
    { treatment: "Wrinkle Relaxer", pattern: "maintenance", intervalWeeks: 13, quote: "$395", area: "Frown, Crow's feet" },
    { treatment: "Skin Needling", pattern: "course", sessions: 3, intervalWeeks: 4, quote: "$450 per session", area: "Full face" },
  ];
  const concerns = cons.map((c, i) => {
    const mine = (settings.treatments || []).filter((t) => t.concern === c.name && !t.hidden).slice(0, 2);
    const base = mine.length
      ? mine.map((t) => ({ treatment: t.name, pattern: t.pattern, sessions: t.sessions, intervalWeeks: t.intervalWeeks,
          intervalUnit: t.intervalUnit, quote: t.quote, area: t.areas[0] || "", description: t.description }))
      : [fallback[i] || fallback[0]];
    return {
      id: `sample-${i}`, key: c.name, status: "active",
      priority: wf.phases[Math.min(i, wf.phases.length - 1)].id,
      description: "A sample description of what the patient would like to improve.",
      area: "", quote: "", comments: "", sourceRecordId: "",
      lines: base.map((l, j) => ({ id: `s${i}${j}`, status: "active", priority: "", rank: 0, overrides: {}, services: [],
        note: "", frequency: "", startMonth: "", countFrom: "", afterN: 0, afterUnit: "m", afterService: "", ...l })),
    };
  });
  return { concerns, events: [{ id: "e1", name: "Daughter's wedding", month: addMonths(thisMonth(), 4), avoidDowntime: true }] };
}

// Made-up sessions: the first one booked, the rest planned (or waiting, in a waiting priority)
function sampleTrack(master, wf) {
  const cur = thisMonth();
  const track = new Map();
  master.concerns.forEach((c, ci) => {
    const lines = new Map();
    c.lines.forEach((l, li) => {
      const waiting = !phaseOf(wf, l.priority || c.priority).tracked;
      const n = l.pattern === "course" ? Math.max(1, Math.min(l.sessions || 1, 6)) : l.pattern === "once" ? 1 : 2;
      const gap = Math.max(1, Math.round((l.intervalWeeks || 4) / 4.345));
      const slots = Array.from({ length: n }, (_, k) => (waiting
        ? { n: k + 1, state: "waiting", month: "" }
        : { n: k + 1, state: "planned", month: addMonths(cur, 1 + ci + li + k * gap) }));
      if (!waiting && ci === 0 && li === 0) Object.assign(slots[0], { state: "booked", date: `${slots[0].month}-15` });
      lines.set(l.id, { total: l.pattern === "course" ? n : 0, done: 0, complete: false, slots, next: slots[0] || null });
    });
    track.set(c.id, { lines });
  });
  return track;
}

export async function renderPlanCopySettings(el, { staff = null } = {}) {
  el.innerHTML = '<div class="skeleton" style="height:420px;border-radius:14px"></div>';
  let d;
  let settings;
  let wf;
  let lh;
  let forms;
  try {
    [d, settings, wf, lh, forms] = await Promise.all([
      getPlanDocSettings(),
      getPlanSettings().catch(() => ({ concerns: [], treatments: [] })),
      getPlanWorkflow().catch(() => cleanWorkflow({})),
      getDoc(doc(db, "form_settings", "letterhead")).then((s) => (s.exists() ? s.data() : null)).catch(() => null),
      listPublishedForms().catch(() => []),
    ]);
  } catch (err) {
    console.error("Patient copy settings failed:", err);
    if (el.isConnected) el.innerHTML = '<div class="tm-empty is-error">Couldn\'t load the patient copy. Check your connection and try again.</div>';
    return;
  }
  if (!el.isConnected) return;

  // Pictures already on the page (the designer adds to this as pictures are chosen)
  const images = {};
  await Promise.all([...new Set(d.blocks.filter((b) => b.type === "image" && b.fileId).map((b) => b.fileId))]
    .map((id) => bankImage(id).then((src) => { images[id] = src; }).catch(() => {})));
  if (!el.isConnected) return;

  const master = samplePlan(settings, wf);
  const track = sampleTrack(master, wf);
  const look = new Map(settings.concerns.map((c) => [c.name, c]));
  const labelOf = (k) => look.get(k) || { label: k, colour: "#888780" };
  const pick = { lines: new Set(master.concerns.flatMap((c) => c.lines.map((l) => l.id))), message: SAMPLE_MESSAGE };
  const render = (mark = false) => planDocHtml({
    patient: SAMPLE_PATIENT, master, track, labelOf, d, lh, pick, staff, wf, images, mark,
    descOf: (c, l) => l.description || "",
  });
  const formName = () => (forms.find((t) => t.id === d.formId) || { name: "a form that isn't published now" }).name;

  el.innerHTML = `
    <div class="pcs">
      <div class="pcs-side">
        <section class="tb-card">
          <h4>Page design</h4>
          <p class="muted ps-note">How every patient's copy of their plan looks when it's printed, downloaded or emailed.
            Changes save by themselves and apply to every patient.</p>
          <small class="pcs-status" role="status" aria-live="polite"></small>
          <label class="lh-field"><span class="lh-label">Design</span>
            <select class="fb-select" data-d="formId">
              <option value="">Standard design</option>
              ${forms.map((t) => `<option value="${esc(t.id)}"${d.formId === t.id ? " selected" : ""}>${esc(t.name)} (${esc(categoryLabel(t.category))})</option>`).join("")}
              ${d.formId && !forms.some((t) => t.id === d.formId) ? `<option value="${esc(d.formId)}" selected>A form that isn't published now</option>` : ""}
            </select></label>
          <div data-role="std">
            <button type="button" class="lh-btn is-primary pcs-edit" data-act="design">Edit the page design</button>
            <small class="fe-note">Headings, text, pictures, a signature line and the plan's parts, arranged on the page.</small>
          </div>
          <div data-role="form" hidden>
            <p class="fe-note">The page comes from a Form Builder form. In a Text block, put these on their own line:
              <code>{Plan treatments}</code> <code>{Plan concerns}</code> <code>{Plan timeline}</code> <code>{Plan message}</code>.</p>
            <a class="lh-btn" data-role="formlink" target="_blank" rel="noopener">Edit in Form Builder</a>
          </div>
          <div class="pcs-row">
            <label class="lh-field"><span class="lh-label">Font</span>
              <select class="fb-select" data-d="font">${Object.entries(DOC_FONTS).map(([k, v]) =>
                `<option value="${k}"${d.font === k ? " selected" : ""}>${esc(v[0])}</option>`).join("")}</select></label>
            <label class="lh-field"><span class="lh-label">Text size</span>
              <select class="fb-select" data-d="fontSize">${[[11, "Small"], [12, "Smaller"], [13, "Normal"], [14, "Large"], [15, "Larger"], [16, "Largest"]]
                .map(([n, t]) => `<option value="${n}"${Number(d.fontSize) === n ? " selected" : ""}>${t}</option>`).join("")}</select></label>
            <label class="lh-field"><span class="lh-label">Colour</span>
              <input type="color" data-d="colour" value="${esc(d.colour)}" /></label>
          </div>
          <label class="fe-check"><input type="checkbox" data-d="showPrices"${d.showPrices ? " checked" : ""} /> Show quotes</label>
        </section>

        <section class="tb-card">
          <h4>Email</h4>
          <p class="muted ps-note">Used when staff press <strong>Email to patient</strong>. They can change it before sending.
            <code>{First name}</code>, <code>{Patient name}</code> and <code>{Today}</code> are filled in.</p>
          <label class="lh-field"><span class="lh-label">Subject</span>
            <input class="fe-input" data-d="emailSubject" maxlength="200" ${NO_FILL} value="${esc(d.emailSubject)}" /></label>
          <label class="lh-field"><span class="lh-label">Message</span>
            <textarea class="fe-input" data-d="emailMessage" rows="8" maxlength="3000" ${NO_FILL}>${esc(d.emailMessage)}</textarea></label>
          <small class="fe-note">The plan is attached as a PDF.</small>
        </section>
      </div>

      <div class="pcs-preview">
        <p class="pcs-preview-h">Preview <span>with a sample patient</span></p>
        <div class="pcs-page" data-role="preview"></div>
      </div>
    </div>`;

  const preview = el.querySelector('[data-role="preview"]');
  const status = el.querySelector(".pcs-status");
  const setStatus = (t, bad = false) => { if (status.isConnected) { status.textContent = t; status.classList.toggle("is-bad", bad); } };

  function draw() {
    if (!preview.isConnected) return;
    preview.innerHTML = d.formId
      ? `<div class="pcs-formnote"><strong>This page comes from the Form Builder form "${esc(formName())}".</strong>
          To see it with a real plan, open a patient's Treatment Plan and press <strong>Print or email</strong>.</div>`
      : render();
  }
  function syncDesign() {
    el.querySelector('[data-role="std"]').hidden = !!d.formId;
    el.querySelector('[data-role="form"]').hidden = !d.formId;
    el.querySelector('[data-role="formlink"]').href = `${location.pathname}${location.search}#/forms/${encodeURIComponent(d.formId || "")}`;
  }

  // Saved a moment after the last change. The whole design is saved, so nothing made in the designer is lost.
  let saveTimer = 0;
  let drawTimer = 0;
  let dirty = false;
  async function save() {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    try {
      await savePlanDocSettings(d, staff);
      setStatus("All changes saved");
    } catch (ex) {
      console.error("Patient copy not saved:", ex);
      dirty = true;
      setStatus(ex && ex.code === "permission-denied"
        ? "Not saved: only Admins can change the patient copy."
        : "Not saved. Check your connection and make the change again.", true);
    }
  }
  const touched = () => {
    dirty = true;
    setStatus("Saving…");
    clearTimeout(drawTimer);
    drawTimer = setTimeout(draw, 250);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1000);
  };

  el.addEventListener("input", (e) => {
    const key = e.target.dataset.d;
    if (!key) return;
    const t = e.target;
    d[key] = t.type === "checkbox" ? t.checked : key === "fontSize" ? Number(t.value) : t.value;
    if (key === "formId") syncDesign();
    touched();
  });

  el.addEventListener("click", (e) => {
    if (!e.target.closest('[data-act="design"]')) return;
    openPlanDesigner({
      d, images, staff,
      render: () => render(true),
      onChange: touched,
      onClose: () => {
        const sp = el.querySelector('[data-d="showPrices"]');
        if (sp) sp.checked = !!d.showPrices;   // the Quote column can be switched in the designer too
        draw();
      },
    });
  });

  syncDesign();
  draw();
}