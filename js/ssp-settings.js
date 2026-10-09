// Skin Script design (Firestore form_settings/ssp): the PDF's look, the wording and the patient email,
// with a live preview.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { listTaskTypes } from "./task-types.js";
import { getLetterhead } from "./form-templates.js";
import { createRichEditor } from "./rich-editor.js";
import { cleanRichHtml } from "./rich-html.js";
import { emailShell, fillTemplate, fillTemplateHtml, clinicDetails } from "./task-tokens.js";
import { SSP_STEPS } from "./ssp-products-api.js";
import { SSP_DEFAULTS, PDF_DEFAULTS, FONTS, CLOSING_HTML } from "./ssp-defaults.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { buildSspDocument, marginPx } from "./ssp-document.js";

export { SSP_DEFAULTS };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COLOR = /^#[0-9a-f]{6}$/i;
const col = (v, d) => (COLOR.test(v || "") ? v : d);
const clip = (v, n) => String(v ?? "").slice(0, n);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
const copy = (o) => JSON.parse(JSON.stringify(o));
let cache = null;

function cleanPdf(p = {}) {
  const D = PDF_DEFAULTS;
  const steps = {};
  SSP_STEPS.forEach((s) => {
    const o = (p.steps || {})[s.key] || {};
    steps[s.key] = {
      label: clip(o.label ?? s.label, 40).trim() || s.label,
      sub: clip(o.sub ?? s.sub, 60),
      tone: col(o.tone, s.tone),
      ink: col(o.ink, s.ink),
    };
  });
  return {
    title: clip(p.title ?? D.title, 80).trim() || D.title,
    margin: num(p.margin, 8, 30, D.margin),
    titleSize: num(p.titleSize, 12, 28, D.titleSize),
    titleColor: col(p.titleColor, D.titleColor),
    font: FONTS[p.font] ? p.font : D.font,
    fontSize: num(p.fontSize, 8, 13, D.fontSize),
    accent: col(p.accent, D.accent),
    headerBg: col(p.headerBg, D.headerBg),
    logo: ["right", "left", "none"].includes(p.logo) ? p.logo : D.logo,
    logoSize: num(p.logoSize, 24, 80, D.logoSize),
    morning: clip(p.morning ?? D.morning, 30),
    evening: clip(p.evening ?? D.evening, 30),
    icons: p.icons !== false,
    showPatient: p.showPatient !== false,
    showRecordDate: p.showRecordDate !== false,
    showValidUntil: p.showValidUntil !== false,
    showSize: p.showSize === true,
    showWhen: p.showWhen !== false,
    stepColours: p.stepColours !== false,
    footer: clip(p.footer ?? "", 300),
    steps,
  };
}

const linesToHtml = (text) => String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean)
  .map((l) => `<p>${esc(l)}</p>`).join("");

export async function getSspSettings({ force = false } = {}) {
  if (cache && !force) return cache;
  const snap = await getDoc(doc(db, "form_settings", "ssp"));
  const d = snap.exists() ? snap.data() : {};
  cache = {
    validMonths: num(d.validMonths, 1, 24, SSP_DEFAULTS.validMonths),
    closing: typeof d.closing === "string" ? d.closing : SSP_DEFAULTS.closing,
    closingHtml: typeof d.closingHtml === "string" && d.closingHtml
      ? d.closingHtml
      : (typeof d.closing === "string" && d.closing !== SSP_DEFAULTS.closing ? linesToHtml(d.closing) : CLOSING_HTML),
    signature: typeof d.signature === "string" ? d.signature : SSP_DEFAULTS.signature,
    emailTemplate: typeof d.emailTemplate === "string" ? d.emailTemplate : "",
    emailSource: d.emailSource === "template" || d.emailSource === "custom"
      ? d.emailSource : (d.emailTemplate ? "template" : "custom"),
    emailSubject: typeof d.emailSubject === "string" && d.emailSubject ? d.emailSubject : SSP_DEFAULTS.emailSubject,
    emailHtml: typeof d.emailHtml === "string" && d.emailHtml ? d.emailHtml : SSP_DEFAULTS.emailHtml,
    emailStyle: {
      background: col(d.emailStyle && d.emailStyle.background, SSP_DEFAULTS.emailStyle.background),
      accent: col(d.emailStyle && d.emailStyle.accent, SSP_DEFAULTS.emailStyle.accent),
    },
    pdf: cleanPdf(d.pdf || {}),
  };
  return cache;
}

export async function saveSspSettings(s, staff) {
  const clean = {
    validMonths: num(s.validMonths, 1, 24, 3),
    closing: clip(s.closing, 3000),
    closingHtml: cleanRichHtml(s.closingHtml || "").slice(0, 20000),
    signature: clip(s.signature, 500),
    emailTemplate: /^[A-Za-z0-9]{10,40}$/.test(s.emailTemplate || "") ? s.emailTemplate : "",
    emailSource: s.emailSource === "template" ? "template" : "custom",
    emailSubject: clip(s.emailSubject, 200).trim() || SSP_DEFAULTS.emailSubject,
    emailHtml: cleanRichHtml(s.emailHtml || "").slice(0, 60000),
    emailStyle: {
      background: col(s.emailStyle && s.emailStyle.background, SSP_DEFAULTS.emailStyle.background),
      accent: col(s.emailStyle && s.emailStyle.accent, SSP_DEFAULTS.emailStyle.accent),
    },
    pdf: cleanPdf(s.pdf || {}),
  };
  if (clean.emailSource === "template" && !clean.emailTemplate) clean.emailSource = "custom";
  await setDoc(doc(db, "form_settings", "ssp"), {
    ...clean, updatedAt: new Date().toISOString(), updatedBy: clip((staff && staff.name) || "", 120),
  });
  cache = clean;
  return clean;
}

/* ===================== The design window ===================== */

function addMonthsIso(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function sampleRecord(months) {
  const it = (o) => ({ size: "", am: false, pm: false, amText: "", pmText: "", days: [], notes: "", ...o });
  return {
    patientName: "Jane Sample",
    recordDate: addMonthsIso(0),
    validUntil: addMonthsIso(months || 3),
    items: [
      it({ name: "Dermedica Essential Cleanser", size: "125mL", step: "A", am: true, pm: true,
        amText: "Apply a pea-sized amount, massage gently, then rinse off.", pmText: "Apply a pea-sized amount, massage gently, then rinse off." }),
      it({ name: "ZO Complexion Renewal Pads", size: "30 pads", step: "BOOST", pm: true,
        pmText: "Wipe over the face after cleansing.", days: ["Mo", "We", "Fr"], notes: "after cleansing" }),
      it({ name: "Dermedica Bright C", size: "30mL", step: "B", am: true, amText: "Apply a pea size amount." }),
      it({ name: "ZO Retinol Skin Brightener 1%", size: "50mL", step: "B", pm: true,
        pmText: "Apply a pea size amount. Stop for 3 days before your treatment." }),
      it({ name: "Dermedica Hyaluronic Serum", size: "50mL", step: "C", pm: true, pmText: "Apply a pea size amount." }),
      it({ name: "ZO Intense Eye Cream", size: "15mL", step: "D", am: true, amText: "Apply half a pea size amount." }),
      it({ name: "Dermedica Sunscreen", size: "60mL", step: "E", am: true, amText: "Apply 2 large pea size amounts to the face." }),
    ],
  };
}

const field = (label, control, note = "") =>
  `<label class="ssd-f"><span>${label}</span>${control}${note ? `<small class="fe-note">${note}</small>` : ""}</label>`;
const text = (path, v, max = 80, ph = "") =>
  `<input class="fe-input" data-p="${path}" maxlength="${max}" value="${esc(v)}"${ph ? ` placeholder="${esc(ph)}"` : ""} />`;
const color = (path, v) => `<input type="color" class="ssd-color" data-p="${path}" value="${esc(v)}" />`;
const select = (path, items, cur, numeric = false) =>
  `<select class="fb-select" data-p="${path}"${numeric ? ' data-num=""' : ""}>${items.map(([v, l]) =>
    `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const check = (path, on, label) =>
  `<label class="fe-check"><input type="checkbox" data-p="${path}"${on ? " checked" : ""} /> ${label}</label>`;

function pdfSection(st) {
  const p = st.pdf;
  return `
    <section data-sec="pdf">
      <h4>Page</h4>
      ${field("Page margin", select("pdf.margin", [[10, "Narrow (10 mm)"], [15, "Normal (15 mm)"], [20, "Wide (20 mm)"], [25, "Extra wide (25 mm)"]], p.margin, true),
        "Space around the edge of the printed page.")}
      <h4>Title</h4>
      ${field("Title", text("pdf.title", p.title, 80))}
      <div class="ssd-two">
        ${field("Size", select("pdf.titleSize", [14, 16, 17, 18, 20, 22, 24].map((n) => [n, `${n}pt`]), p.titleSize, true))}
        ${field("Colour", color("pdf.titleColor", p.titleColor))}
      </div>
      <h4>Text</h4>
      <div class="ssd-two">
        ${field("Font", select("pdf.font", Object.keys(FONTS).map((f) => [f, f]), p.font))}
        ${field("Text size", select("pdf.fontSize", [8, 9, 10, 11, 12, 13].map((n) => [n, `${n}pt`]), p.fontSize, true))}
      </div>
      <div class="ssd-two">
        ${field("Accent colour", color("pdf.accent", p.accent), "Links and the line under the header.")}
        ${field("Table header", color("pdf.headerBg", p.headerBg))}
      </div>
      <h4>Logo</h4>
      <div class="ssd-two">
        ${field("Position", select("pdf.logo", [["right", "Right"], ["left", "Left"], ["none", "Hidden"]], p.logo))}
        ${field("Size", select("pdf.logoSize", [[30, "Small"], [40, "Medium"], [55, "Large"], [70, "Extra large"]], p.logoSize, true))}
      </div>
      <h4>Show</h4>
      <div class="ssd-checks">
        ${check("pdf.showPatient", p.showPatient, "Patient name")}
        ${check("pdf.showRecordDate", p.showRecordDate, "Record date")}
        ${check("pdf.showValidUntil", p.showValidUntil, "Valid until")}
        ${check("pdf.showSize", p.showSize, "Product sizes")}
        ${check("pdf.showWhen", p.showWhen, "Days &amp; notes")}
        ${check("pdf.icons", p.icons, "☀ ✨ icons")}
        ${check("pdf.stepColours", p.stepColours, "Step colours")}
      </div>
      <h4>Column titles</h4>
      <div class="ssd-two">
        ${field("Morning", text("pdf.morning", p.morning, 30, "Morning"))}
        ${field("Evening", text("pdf.evening", p.evening, 30, "Evening"))}
      </div>
      <h4>Steps</h4>
      <div class="ssd-steps">
        <div class="ssd-step ssd-step-head"><span>Name</span><span>Subtitle</span><span>Fill</span><span>Text</span></div>
        ${SSP_STEPS.map((s) => {
          const o = p.steps[s.key] || {};
          return `<div class="ssd-step">
            ${text(`pdf.steps.${s.key}.label`, o.label, 40)}
            ${text(`pdf.steps.${s.key}.sub`, o.sub, 60, "Subtitle")}
            ${color(`pdf.steps.${s.key}.tone`, o.tone)}
            ${color(`pdf.steps.${s.key}.ink`, o.ink)}
          </div>`;
        }).join("")}
      </div>
      <h4>Footer</h4>
      ${field("Footer line", text("pdf.footer", p.footer, 300, "e.g. Unit 4/91 Scarborough Beach Rd · 9205 1995"), "Optional. Small, centred, at the bottom.")}
    </section>`;
}

function textSection(st) {
  return `
    <section data-sec="text">
      ${field("Valid for", select("validMonths", Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1} month${i ? "s" : ""}`]), st.validMonths, true),
        "Sets the Valid until date on new protocols.")}
      <div class="ssd-f"><span>Closing message</span><div class="ssd-ed" data-ed="closing"></div>
        <small class="fe-note">Blanks: {Valid until}, {Record date}, {First name}, {Patient name}.</small></div>
      ${field("Signature", `<textarea class="fe-input" data-p="signature" rows="3" maxlength="500">${esc(st.signature)}</textarea>`,
        "The last line is printed in bold.")}
    </section>`;
}

function emailSection(st, templates) {
  const pick = st.emailSource === "template" && st.emailTemplate ? `tpl:${st.emailTemplate}` : "custom";
  return `
    <section data-sec="email">
      ${field("Email to use", `<select class="fb-select" data-p="emailPick">
          <option value="custom"${pick === "custom" ? " selected" : ""}>Written here</option>
          ${templates.map((t) => `<option value="tpl:${esc(t.id)}"${pick === `tpl:${t.id}` ? " selected" : ""}>Task Manager: ${esc(t.name)}${
            t.status === "live" ? "" : " (draft)"}</option>`).join("")}
        </select>`)}
      <div data-custom>
        ${field("Subject", text("emailSubject", st.emailSubject, 200))}
        <div class="ssd-f"><span>Message</span><div class="ssd-ed" data-ed="email"></div>
          <small class="fe-note">Blanks: {First name}, {Full name}, {Valid until}, {Record date}, {Staff name}, {Clinic phone}, {Clinic email}, {Clinic address}. The protocol PDF is attached automatically.</small></div>
        <div class="ssd-two">
          ${field("Background", color("emailStyle.background", st.emailStyle.background))}
          ${field("Accent", color("emailStyle.accent", st.emailStyle.accent))}
        </div>
      </div>
      <p class="fe-note" data-tplonly>This email uses a Task Manager template. Change its wording and design in Task Manager → Task types.</p>
    </section>`;
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  parts.slice(0, -1).forEach((k) => { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; });
  o[parts[parts.length - 1]] = value;
}

// Admins: the design window. Resolves true if saved.
export async function openSspSettings({ staff = null } = {}) {
  const [saved, tasks, letterhead] = await Promise.all([
    getSspSettings({ force: true }).catch(() => copy(SSP_DEFAULTS)),
    listTaskTypes({ isAdmin: true }).catch(() => []),
    getLetterhead().catch(() => null),
  ]);
  const templates = tasks.filter((t) => t.category === "patient" && t.channel === "email");
  const clinic = clinicDetails(letterhead);
  let st = copy(saved);

  return new Promise((resolve) => {
    let didSave = false;
    let tab = "pdf";
    let timer = null;
    const eds = {};
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ssd";
    dlg.innerHTML = `
      <div class="ssd-head">
        <div><h3>Skin Script design</h3><p class="muted">How the protocol PDF and the patient email look.</p></div>
        <div class="ssd-acts">
          <button type="button" class="lh-btn is-quiet" data-act="reset">Reset to default</button>
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="button" class="lh-btn is-primary" data-act="save">Save</button>
        </div>
      </div>
      <div class="ssd-tabs" role="tablist">
        <button type="button" data-tab="pdf" role="tab">PDF</button>
        <button type="button" data-tab="text" role="tab">Wording</button>
        <button type="button" data-tab="email" role="tab">Email</button>
      </div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="ssd-body">
        <form class="ssd-form" data-role="form" novalidate></form>
        <div class="ssd-preview"><div class="ssd-prev-label" data-role="plabel">Preview</div><div class="ssd-stage" data-role="stage"></div></div>
      </div>`;
    document.body.appendChild(dlg);
    const $ = (s) => dlg.querySelector(s);
    const formEl = $('[data-role="form"]');
    const stage = $('[data-role="stage"]');
    const errEl = $(".lh-error");

    function render() {
      formEl.innerHTML = pdfSection(st) + textSection(st) + emailSection(st, templates);
      eds.closing = createRichEditor(formEl.querySelector('[data-ed="closing"]'), { accent: () => st.pdf.accent });
      eds.closing.setHtml(st.closingHtml || "");
      eds.email = createRichEditor(formEl.querySelector('[data-ed="email"]'), { accent: () => st.emailStyle.accent });
      eds.email.setHtml(st.emailHtml || "");
      showTab(tab);
    }
    function syncEmailMode() {
      const custom = st.emailSource !== "template";
      formEl.querySelectorAll("[data-custom]").forEach((x) => { x.hidden = !custom; });
      formEl.querySelectorAll("[data-tplonly]").forEach((x) => { x.hidden = custom; });
    }
    function showTab(t) {
      tab = t;
      dlg.querySelectorAll("[data-tab]").forEach((b) => {
        b.classList.toggle("is-on", b.dataset.tab === t);
        b.setAttribute("aria-selected", String(b.dataset.tab === t));
      });
      formEl.querySelectorAll("[data-sec]").forEach((s) => { s.hidden = s.dataset.sec !== t; });
      $('[data-role="plabel"]').textContent = t === "email" ? "Email preview" : "PDF preview (sample patient)";
      syncEmailMode();
      refresh(true);
    }
    function collect() {
      if (eds.closing) st.closingHtml = eds.closing.getHtml();
      if (eds.email) st.emailHtml = eds.email.getHtml();
    }
    function refresh(now = false) {
      clearTimeout(timer);
      timer = setTimeout(draw, now ? 0 : 200);
    }
    function fit() {
      const fitEl = stage.querySelector(".ssd-fit");
      const paper = stage.querySelector(".ssd-paper");
      if (!fitEl || !paper) return;
      const k = Math.min(1, (stage.clientWidth - 8) / 793);
      paper.style.transform = `scale(${k})`;
      fitEl.style.width = `${Math.round(793 * k)}px`;
      fitEl.style.height = `${Math.round(paper.offsetHeight * k)}px`;
    }
    function drawPdf() {
      const d = buildSspDocument({ record: sampleRecord(st.validMonths), letterhead, settings: st });
      stage.innerHTML = `<div class="ssd-fit"><div class="ssd-paper" style="padding:${marginPx(d.margin)}px;"><style>${d.css}</style><div class="pdfdoc">${d.inner}</div></div></div>`;
      requestAnimationFrame(fit);
    }
    function drawEmail() {
      if (st.emailSource === "template") {
        const t = templates.find((x) => x.id === st.emailTemplate);
        stage.innerHTML = `<div class="ssd-note">Uses the Task Manager template “${esc(t ? t.name : "Template")}”. Its preview is in Task Manager.</div>`;
        return;
      }
      const vals = new Map();
      const set = (k, v) => vals.set(k.toLowerCase(), v || "");
      set("First name", "Jane"); set("Full name", "Jane Sample");
      set("Valid until", new Date(addMonthsIso(st.validMonths)).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }));
      set("Record date", new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }));
      set("Today", new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }));
      set("Staff name", (staff && staff.name) || "Staff name");
      set("Clinic phone", clinic.phone); set("Clinic email", clinic.email); set("Clinic address", clinic.address);
      let html = emailShell(fillTemplateHtml(st.emailHtml, vals), st.emailStyle, { clinic, hasLogo: !!(letterhead && letterhead.logo) });
      if (letterhead && letterhead.logo) html = html.replace(/<img\b([^>]*?)\bdata-logo\b([^>]*)>/gi, `<img$1$2 src="${letterhead.logo}">`);
      stage.innerHTML = `
        <div class="ssd-subject"><small>Subject</small><strong>${esc(fillTemplate(st.emailSubject, vals))}</strong></div>
        <iframe class="ssd-mail" title="Email preview"></iframe>
        <div class="ssd-attach">📎 ${esc(`${st.pdf.title || "Skin Script Protocol"} - Jane Sample.pdf`)}</div>`;
      const fr = stage.querySelector("iframe");
      fr.addEventListener("load", () => {
        try { fr.style.height = `${fr.contentDocument.body.scrollHeight + 24}px`; } catch { /* ignore */ }
      });
      fr.srcdoc = html;
    }
    function draw() {
      collect();
      if (tab === "email") drawEmail(); else drawPdf();
    }

    formEl.addEventListener("input", (e) => {
      const el = e.target;
      if (el.dataset && el.dataset.p) {
        const p = el.dataset.p;
        if (p === "emailPick") {
          if (el.value.startsWith("tpl:")) { st.emailSource = "template"; st.emailTemplate = el.value.slice(4); }
          else { st.emailSource = "custom"; }
          syncEmailMode();
        } else {
          const v = el.type === "checkbox" ? el.checked : el.dataset.num !== undefined ? Number(el.value) : el.value;
          setPath(st, p, v);
        }
      }
      refresh();
    });
    formEl.addEventListener("change", (e) => { if (e.target.matches("select, input[type=checkbox], input[type=color]")) formEl.dispatchEvent(new Event("input")); });
    formEl.addEventListener("click", () => refresh()); // editor toolbar buttons
    formEl.addEventListener("submit", (e) => e.preventDefault());
    const onResize = () => fit();
    window.addEventListener("resize", onResize);

    dlg.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) { collect(); showTab(t.dataset.tab); return; }
      const a = e.target.closest("[data-act]");
      if (!a) return;
      if (a.dataset.act === "cancel") dlg.close();
      if (a.dataset.act === "reset") {
        const ok = await confirmDialog({
          title: "Reset to the default design?",
          message: "The PDF design, wording and email go back to how they started. Nothing changes until you click Save.",
          confirmLabel: "Reset", tone: "warning",
        });
        if (ok) { st = copy(SSP_DEFAULTS); render(); }
      }
      if (a.dataset.act === "save") {
        collect();
        a.disabled = true;
        a.textContent = "Saving…";
        errEl.hidden = true;
        try {
          await saveSspSettings(st, staff);
          didSave = true;
          dlg.close();
          showToast("Skin Script design saved");
        } catch (ex) {
          console.error("SSP design save failed:", ex);
          errEl.textContent = ex.code === "permission-denied"
            ? "Only admins can change this. Check the form_settings/ssp rule has been published."
            : "Couldn't save. Try again.";
          errEl.hidden = false;
          a.disabled = false;
          a.textContent = "Save";
        }
      }
    });
    dlg.addEventListener("close", () => {
      window.removeEventListener("resize", onResize);
      dlg.remove();
      resolve(didSave);
    });
    dlg.showModal();
    render();
  });
}