// The patient's copy of their treatment plan: choose what to include, adjust the design, then download, print or email.
import { db } from "./firebase-config.js";
import { doc, getDoc, getDocs, collection, query, orderBy, limit }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getPlanDocSettings, savePlanDocSettings, deliverPlanDoc, phaseOf, cleanWorkflow, PLAN_DOC_DEFAULTS, DOC_FONTS } from "./plan-api.js";
import { lineOff, sharesWord } from "./master-plan-api.js";
import { thisMonth, addMonths } from "./plan-track.js";
import { showToast } from "./utils.js";
import { listPublishedForms, getFormTemplate, getFormVersion, categoryLabel } from "./form-templates.js";
import { buildFormDocument } from "./form-document.js";
import { patientAnswers, docToPdf } from "./form-delivery.js";
import { tagValues, fillTags } from "./form-tags.js";
import { bankImage } from "./image-bank-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ACTIVE = ["active", "maintenance"];
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const HEX = /^#[0-9a-f]{6}$/i;

// Merge tags, the same ones as Form Builder: {Patient name}, {First name}, {Today}, {Record date}, {My name}…
// A tag that isn't known is left as typed.
function fillIn(t, p, staff = null) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const vals = tagValues({ patient: p, staff, recordDate: today, today });
  vals["full name"] = vals["patient name"];   // the older tag still works
  return fillTags(t, vals, "");
}
const paras = (t, style = "margin:0 0 10px") => esc(t).trim().split(/\n{2,}/).filter(Boolean)
  .map((x) => `<p style="${style}">${x.replace(/\n/g, "<br>")}</p>`).join("");
const monthLong = (k) => {
  const m = /^(\d{4})-(\d{2})/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, 1).toLocaleDateString("en-AU", { month: "long", year: "numeric" }) : "";
};
const dayLong = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "";
};
const shortPhase = (name) => String(name || "").split("·").pop().trim();   // "Priority 1 · Now" → "Now"

/* ---------- The plan's treatments, in the order the list shows them ---------- */

// Treatments still going ahead (declined ones, and resolved or not-pursued concerns, never go to the patient)
function docItems(master, wf) {
  const out = [];
  master.concerns.forEach((c, ci) => c.lines.forEach((l, li) => {
    if (!ACTIVE.includes(c.status) || lineOff(l)) return;
    out.push({ c, l, ci, li, ph: phaseOf(wf, l.priority || c.priority) });
  }));
  const pr = (x) => wf.phases.findIndex((p) => p.id === x.ph.id);
  return out.sort((a, b) => pr(a) - pr(b) || (a.l.rank ? 0 : 1) - (b.l.rank ? 0 : 1)
    || (a.l.rank || 0) - (b.l.rank || 0) || a.ci - b.ci || a.li - b.li);
}

// A treatment's quote: its own, otherwise the line of its concern's quote that names it
function quoteOf(c, l) {
  if (l.quote) return l.quote;
  const lines = String(c.quote || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const hit = lines.find((q) => sharesWord(q, l.treatment));
  if (hit) { const i = hit.lastIndexOf(" - "); return i > -1 ? hit.slice(i + 3) : hit; }
  return c.lines.length === 1 ? lines.join("; ") : "";
}

/* ---------- Plain-English wording for patients ---------- */

function gapText(w) {
  if (w % 52 === 0) return w === 52 ? "a year" : `${w / 52} years`;
  if (w >= 9) return `${Math.round(w / 4.345)} months`;
  return `${w} week${w === 1 ? "" : "s"}`;
}

function scheduleText(l, lt) {
  if (l.pattern === "course") {
    const n = l.sessions || lt.total || 1;
    return `${n} session${n === 1 ? "" : "s"}${l.intervalWeeks ? `, about ${gapText(l.intervalWeeks)} apart` : ""}`;
  }
  if (l.pattern === "maintenance") return l.intervalWeeks ? `Every ${gapText(l.intervalWeeks)}` : "Ongoing, as needed";
  if (l.pattern === "once") return "One treatment";
  return l.frequency || "";
}

function progressText(lt) {
  if (lt.complete) return "Completed";
  const bits = [];
  if (lt.total && lt.done) bits.push(`${lt.done} of ${lt.total} done`);
  else if (!lt.total && lt.done) {
    const last = lt.slots.filter((s) => s.state === "done" && s.date).pop();
    if (last) bits.push(`Last treatment ${monthLong(last.date)}`);
  }
  const s = lt.next;
  if (s) {
    if (s.state === "booked") bits.push(`Booked for ${dayLong(s.date)}`);
    else if (s.state === "due" || s.state === "overdue") bits.push("Next: now, when you're ready to book");
    else if (s.state === "planned") bits.push(`Next: ${monthLong(s.month)}`);
    else if (s.state === "waiting") bits.push("Later in your plan");
    else bits.push("Timing to be confirmed");
  }
  return bits.join(" · ");
}

/* ---------- The document (inline styles, so the PDF looks the same everywhere) ---------- */

function letterheadHtml(lh, colour) {
  const logo = lh && /^data:image\/(png|jpeg);base64,/.test(lh.logo || "")
    ? `<img src="${lh.logo}" alt="" style="max-height:70px;max-width:240px" />` : "";
  const name = lh && lh.showName !== false && lh.name ? `<div style="font-size:16px;font-weight:bold;color:#0f172a">${esc(lh.name)}</div>` : "";
  const lines = lh ? [lh.line1, lh.line2].filter(Boolean).map((x) => `<div style="font-size:11px;color:#64748b">${esc(x)}</div>`).join("") : "";
  if (!logo && !name && !lines) return `<div style="border-bottom:3px solid ${colour}"></div>`;
  return `<table style="width:100%;border-collapse:collapse;border-bottom:3px solid ${colour}"><tr>
    ${logo ? `<td style="padding:0 0 12px;vertical-align:middle">${logo}</td>` : ""}
    <td style="padding:0 0 12px;vertical-align:middle;text-align:${logo ? "right" : "left"}">${name}${lines}</td></tr></table>`;
}

// Adds up the dollar amounts in some quotes ("$650", "$1,240.50")
function quoteTotal(texts) {
  let t = 0;
  texts.forEach((q) => (String(q || "").match(/\$\s?[\d,]+(?:\.\d{2})?/g) || [])
    .forEach((m) => { t += Number(m.replace(/[$,\s]/g, "")) || 0; }));
  return Math.round(t * 100) / 100;
}
const money = (n) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

// pick = { lines: Set(treatment ids to include), message }   d = the design (plan_settings/document)
// The copy is d.blocks, top to bottom: title, text, the personal message, concerns, treatments, timeline.
// parts: true returns the plan's pieces on their own ({ treatments, concerns, timeline, message }), for a Form Builder design
export function planDocHtml({ patient, master, track, labelOf, d, lh, pick, staff, wf = cleanWorkflow({}), parts = false,
  descOf = (c, l) => l.description || "" }) {
  const colour = HEX.test(d.colour || "") ? d.colour : PLAN_DOC_DEFAULTS.colour;
  const base = Number(d.fontSize) || 13;
  const px = { s: base - 2, m: base, l: base + 3, xl: base + 8 };
  const font = (DOC_FONTS[d.font] || DOC_FONTS.arial)[1];
  const blocks = Array.isArray(d.blocks) ? d.blocks : [];
  const has = (type) => blocks.some((b) => b.type === type);
  const items = docItems(master, wf).filter((x) => pick.lines.has(x.l.id));
  const ltOf = (x) => track.get(x.c.id).lines.get(x.l.id);
  const todayText = new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

  const small = `font-size:${base - 1}px;color:#64748b`;
  // A Form Builder design has its own headings
  const h2 = (t) => (parts ? "" : `<h2 style="margin:16px 0 8px;font-size:${base + 2}px;color:#0f172a">${t}</h2>`);

  // One treatment as a table row: Treatment | Frequency | Description | Quote
  const td = `padding:8px 10px;border:1px solid #e2e8f0;vertical-align:top`;
  const th = `padding:7px 10px;border:1px solid #e2e8f0;background:#f8fafc;text-align:left;font-size:${base - 1}px;color:#475569`;
  const headHtml = `<tr><th style="${th};width:28%">Treatment</th><th style="${th};width:24%">Frequency</th>
    <th style="${th}">Description</th>${d.showPrices ? `<th style="${th};width:15%;text-align:right">Quote</th>` : ""}</tr>`;
  const rowHtml = (x) => {
    const lt = ltOf(x);
    const prog = progressText(lt);
    const what = [labelOf(x.c.key).label, x.l.area || x.c.area].filter(Boolean).join(" · ");
    const desc = descOf(x.c, x.l);
    // With a description: the concern and area sit under the name. Without one: they are the description.
    return `<tr>
      <td style="${td}"><strong style="color:#0f172a">${esc(x.l.treatment)}</strong>${desc && what ? `<div style="${small}">${esc(what)}</div>` : ""}</td>
      <td style="${td};color:#334155">${esc(scheduleText(x.l, lt))}${prog ? `<div style="${small}">${esc(prog)}</div>` : ""}</td>
      <td style="${td};color:#334155">${esc(desc || what)}</td>
      ${d.showPrices ? `<td style="${td};text-align:right;white-space:nowrap;color:#0f172a">${esc(quoteOf(x.c, x.l))}</td>` : ""}</tr>`;
  };

  // Under each priority, in the order to book them, with a quote total (when switched on in the plan workflow)
  function treatmentsHtml() {
    const many = wf.phases.length > 1;
    let grand = 0;
    let priced = 0;
    const out = wf.phases.map((ph) => {
      const list = items.filter((x) => x.ph.id === ph.id);
      if (!list.length) return "";
      const total = d.showPrices && wf.docPhaseTotals ? quoteTotal(list.map((x) => quoteOf(x.c, x.l))) : 0;
      if (total) { grand += total; priced++; }
      return `<div style="margin:0 0 16px;page-break-inside:avoid">
        ${many ? `<div style="margin:0 0 4px;padding-left:10px;border-left:4px solid ${colour}">
          <div style="font-size:${base + 2}px;font-weight:bold;color:#0f172a">${esc(shortPhase(ph.name))}</div>
          ${ph.note ? `<div style="${small}">${esc(ph.note)}</div>` : ""}</div>` : ""}
        <table style="width:100%;border-collapse:collapse;font-size:${base}px;margin-top:6px">${headHtml}${list.map(rowHtml).join("")}</table>
        ${total ? `<div style="padding-top:6px;border-top:1px solid #e2e8f0;text-align:right;font-size:${base - 1}px;color:#334155">Quoted${
          many ? ` for ${esc(shortPhase(ph.name))}` : ""}: <strong>${esc(money(total))}</strong></div>` : ""}
      </div>`;
    }).join("");
    if (!out) return "";
    return `${h2("Your treatments")}${out}${priced > 1 ? `<div style="margin:0 0 14px;padding:8px 10px;background:#f8fafc;text-align:right">
      Full plan as quoted: <strong>${esc(money(grand))}</strong></div>` : ""}`;
  }

  // Each concern in the copy that has a description
  function concernsHtml() {
    const seen = new Set();
    const list = items.map((x) => x.c).filter((c) => c.description && !seen.has(c.id) && seen.add(c.id));
    return list.length ? `${h2("What we're working on")}${list.map((c) =>
      `<p style="margin:0 0 6px"><strong style="color:#0f172a">${esc(labelOf(c.key).label)}</strong>: ${esc(c.description)}</p>`).join("")}` : "";
  }

  // The coming 12 months: planned and booked treatments, and the patient's events
  function timelineHtml() {
    const cur = thisMonth();
    const months = Array.from({ length: 12 }, (_, i) => addMonths(cur, i));
    const byMonth = new Map(months.map((k) => [k, []]));
    items.forEach((x) => ltOf(x).slots.forEach((s) => {
      let k = s.month;
      if (s.state === "due" || s.state === "overdue") k = cur;
      else if (s.state !== "planned" && s.state !== "booked") return;
      if (!byMonth.has(k)) return;
      byMonth.get(k).push(`${esc(x.l.treatment)}${s.state === "booked" ? ` <span style="color:#64748b">(booked ${esc(dayLong(s.date))})</span>` : ""}`);
    }));
    master.events.forEach((e) => {
      if (byMonth.has(e.month)) byMonth.get(e.month).push(`<strong style="color:#92400e">★ ${esc(e.name)}</strong>`);
    });
    const rows = months.filter((k) => byMonth.get(k).length).map((k) => `<tr>
      <td style="padding:6px 10px 6px 0;border-top:1px solid #f1f5f9;vertical-align:top;width:130px;font-weight:bold;color:#0f172a">${esc(monthLong(k))}</td>
      <td style="padding:6px 0;border-top:1px solid #f1f5f9;vertical-align:top">${byMonth.get(k).join(", ")}</td></tr>`).join("");
    return rows ? `<div style="page-break-inside:avoid">${h2("Your next 12 months")}
      <table style="width:100%;border-collapse:collapse;font-size:${base}px">${rows}</table></div>` : "";
  }

  function blockHtml(b) {
    if (b.type === "title") {
      return `<h1 style="margin:18px 0 2px;font-size:${base + 9}px;color:${colour}">${esc(fillIn(b.text || d.title || PLAN_DOC_DEFAULTS.title, patient, staff))}</h1>
        <div style="margin:0 0 14px;${small}">For ${esc(patient.name || "")} · ${esc(todayText)}</div>`;
    }
    if (b.type === "text") {
      const t = fillIn(b.text, patient, staff);
      if (!t.trim()) return "";
      const big = b.size === "l" || b.size === "xl";
      return paras(t, `margin:${big ? "14px 0 6px" : "0 0 10px"};font-size:${px[b.size] || base}px;${b.bold ? "font-weight:bold;" : ""}${
        b.tint ? `color:${colour};` : b.size === "s" ? "color:#64748b;" : big ? "color:#0f172a;" : ""}${big ? "line-height:1.25;" : ""}text-align:${
        b.align === "center" ? "center" : "left"}`);
    }
    if (b.type === "message") {
      return pick.message ? `<div style="margin:4px 0 14px;padding:10px 12px;background:#f8fafc;border-left:3px solid ${colour}">${
        paras(pick.message, "margin:0 0 6px")}</div>` : "";
    }
    if (b.type === "concerns") return concernsHtml();
    if (b.type === "treatments") return treatmentsHtml();
    if (b.type === "timeline") return timelineHtml();
    return "";
  }

  if (parts) {
    return { treatments: treatmentsHtml(), concerns: concernsHtml(), timeline: timelineHtml(), message: blockHtml({ type: "message" }) };
  }
  return `<div style="width:703px;box-sizing:border-box;padding:0 4px;background:#fff;font-family:${font};font-size:${base}px;line-height:1.5;color:#1e293b">
    ${letterheadHtml(lh, colour)}
    ${has("title") ? "" : '<div style="height:16px"></div>'}
    ${blocks.map(blockHtml).join("")}
    <p style="margin:12px 0 0;font-size:${base - 2}px;color:#94a3b8">Prepared${staff && staff.name ? ` by ${esc(staff.name)}` : ""}${lh && lh.name ? ` · ${esc(lh.name)}` : ""}</p>
  </div>`;
}

/* ---------- The window ---------- */

const SEND_ERRORS = {
  NO_PRINTER: "No printer email is set. Add it in Form Builder → Printing.",
  BAD_EMAIL: "Check the email address.",
  RATE_LIMITED: "You've sent a lot of emails in the last hour. Try again a little later.",
  QUOTA: "The clinic's daily email limit has been reached.",
  PDF_FAILED: "The PDF couldn't be attached. Try again.",
  FORBIDDEN: "You don't have access to send things to patients.",
  NOT_FOUND: "This patient's plan couldn't be found. Reload the page.",
  UNAUTHORIZED: "Your session has ended. Log in again.",
};

// labelOf(key) → { label, colour } (the patient-facing concern names)
export async function openPlanDocument({ patient, master, track, labelOf, staff, onSent, workflow, descOf }) {
  const wf = workflow || cleanWorkflow({});
  let d;
  let lh = null;
  let sends = [];
  try {
    [d, lh, sends] = await Promise.all([
      getPlanDocSettings(),
      getDoc(doc(db, "form_settings", "letterhead")).then((s) => (s.exists() ? s.data() : null)).catch(() => null),
      getDocs(query(collection(db, "treatment_plans", patient.id, "sends"), orderBy("sentAt", "desc"), limit(3)))
        .then((s) => s.docs.map((x) => x.data())).catch(() => []),
    ]);
  } catch (err) {
    console.error("Patient copy failed:", err);
    showToast("Couldn't open the treatment plan copy. Try again.");
    return;
  }

  const all = docItems(master, wf);
  const pick = {
    lines: new Set(all.filter((x) => wf.docShowWaiting || x.ph.tracked).map((x) => x.l.id)),
    message: "",
  };
  const fileName = `Treatment plan - ${patient.name || "Patient"}.pdf`;
  /* ---------- A Form Builder form as the design ---------- */
  const forms = await listPublishedForms().catch(() => []);
  let tpl = null;      // { inner, css } once the chosen form is loaded
  let tplMsg = "";
  async function loadTpl() {
    const want = d.formId;
    tpl = null;
    tplMsg = "";
    if (!want) return;
    try {
      const t = await getFormTemplate(want);
      if (!t || t.status !== "live" || !t.version) throw new Error("not published");
      const ver = await getFormVersion(want, t.version);
      if (!ver) throw new Error("version missing");
      const images = {};
      await Promise.all([...new Set(ver.fields.filter((f) => f && f.type === "image" && f.source !== "staff" && f.fileId).map((f) => f.fileId))]
        .map((id) => bankImage(id).then((src) => { images[id] = src; }).catch(() => {})));
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const sub = {
        answers: { ...patientAnswers(ver, patient), __tags: tagValues({ patient, staff, recordDate: today, today }) },
        signatures: {}, templateName: ver.name, patientName: patient.name || "", recordDate: today, version: ver.version,
        createdBy: (staff && staff.name) || "",
      };
      // The "patient · date" line under the title is left off: the design says who it's for in its own words
      const doc = buildFormDocument({ sub, ver: { ...ver, settings: { ...(ver.settings || {}), showMeta: false } },
        letterhead: lh, images, blank: true });
      if (want === d.formId) tpl = { inner: doc.inner, css: doc.css };
    } catch (ex) {
      console.warn("Plan design form not loaded:", ex);
      tplMsg = "That form couldn't be opened (is it still published?), so the standard design is shown.";
    }
  }
  // The form's page, with the plan's parts put where their tags are
  function formHtml() {
    const p = planDocHtml({ patient, master, track, labelOf, d: { ...d, fontSize: 14 }, lh, pick, staff, wf, parts: true, descOf });
    let inner = tpl.inner;
    let placed = false;
    Object.entries(p).forEach(([name, block]) => {
      const tag = `\\{\\s*Plan\\s+${name}\\s*\\}`;
      const put = () => { if (name === "treatments") placed = true; return block; };
      inner = inner.replace(new RegExp(`<p[^>]*>\\s*${tag}\\s*</p>`, "gi"), put).replace(new RegExp(tag, "gi"), put);
    });
    if (!placed) inner += p.treatments;   // no {Plan treatments} on the form: they go at the end
    return inner;
  }
  await loadTpl();
  const stdHtml = () => planDocHtml({ patient, master, track, labelOf, d, lh, pick, staff, wf, descOf });
  // The preview
  const html = () => (tpl ? `<style>${tpl.css}</style><div class="pdfdoc">${formHtml()}</div>` : stdHtml());
  // The PDF: made by the same PDF maker as forms, which copes with the page being scrolled behind the window
  const makePdf = () => docToPdf(tpl ? { css: tpl.css, inner: formHtml(), fileName } : { css: "", inner: stdHtml(), fileName });
  const lastSent = sends.map((s) => `${s.kind === "print" ? "Printed" : `Emailed to ${s.to}`} ${
    s.sentAt ? new Date(s.sentAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""}${s.sentBy ? ` by ${s.sentBy}` : ""}`);


  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog pd-dlg";
  dlg.innerHTML = `
    <form class="pd-grid" novalidate>
      <div class="pd-opts">
        <div class="lh-dialog-head"><h3>Print or email the treatment plan</h3>
          <p>Choose what to include. Clinicians' notes and treatments that aren't going ahead are never included.</p></div>
        <div class="pd-cons">${all.length ? wf.phases.map((ph) => {
          const list = all.filter((x) => x.ph.id === ph.id);
          return list.length ? `<div class="pd-con"><strong class="pd-con-name">${esc(shortPhase(ph.name))}</strong>
            ${list.map((x) => `<label class="fe-check pd-line"><input type="checkbox" data-line="${esc(x.l.id)}"${pick.lines.has(x.l.id) ? " checked" : ""} />
              ${esc(x.l.treatment)} <small class="muted">${esc(labelOf(x.c.key).label)}</small></label>`).join("")}</div>` : "";
        }).join("") : '<p class="tb-none">There are no treatments going ahead in this plan.</p>'}</div>
        <label class="lh-field"><span class="lh-label">Message to the patient (optional)</span>
          <textarea name="message" rows="3" maxlength="1500" placeholder="A personal note, shown near the top"></textarea></label>
        <details class="pd-design">
          <summary>Design</summary>
          <p class="fe-note">Changes here are saved as the clinic's default for every patient. <span data-role="saved"></span></p>
          <label class="lh-field"><span class="lh-label">Page design</span>
            <select class="fb-select" data-d="formId">
              <option value="">Standard design</option>
              ${forms.map((t) => `<option value="${esc(t.id)}"${d.formId === t.id ? " selected" : ""}>${esc(t.name)} (${esc(categoryLabel(t.category))})</option>`).join("")}
              ${d.formId && !forms.some((t) => t.id === d.formId) ? `<option value="${esc(d.formId)}" selected>A form that isn't published now</option>` : ""}
            </select></label>
          <div class="pd-tpl" data-role="tplhelp" hidden>
            <p class="fe-note">This page comes from Form Builder. In a Text block, put these on their own line:
              <code>{Plan treatments}</code> <code>{Plan concerns}</code> <code>{Plan timeline}</code> <code>{Plan message}</code>.
              <code>{First name}</code>, <code>{Patient name}</code> and <code>{Today}</code> work too.</p>
            <div class="pd-add">
              <a class="lh-btn" data-role="tpledit" target="_blank" rel="noopener">Edit in Form Builder</a>
              <button type="button" class="lh-btn" data-tplreload>Reload the design</button>
            </div>
            <p class="fe-note fe-bad" data-role="tplmsg"></p>
          </div>
          <div class="pd-d3">
            <label class="lh-field"><span class="lh-label">Font</span>
              <select class="fb-select" data-d="font">${Object.entries(DOC_FONTS).map(([k, v]) =>
                `<option value="${k}"${d.font === k ? " selected" : ""}>${v[0]}</option>`).join("")}</select></label>
            <label class="lh-field"><span class="lh-label">Text size</span>
              <select class="fb-select" data-d="fontSize">${[[11, "Small"], [12, "Smaller"], [13, "Normal"], [14, "Large"], [15, "Larger"], [16, "Largest"]].map(([n, t]) =>
                `<option value="${n}"${Number(d.fontSize) === n ? " selected" : ""}>${t}</option>`).join("")}</select></label>
            <label class="lh-field"><span class="lh-label">Colour</span><input type="color" data-d="colour" value="${esc(d.colour)}" /></label>
          </div>
          <label class="fe-check"><input type="checkbox" data-d="showPrices"${d.showPrices ? " checked" : ""} /> Show quotes</label>
          <div data-role="std">
          <p class="lh-label pd-blk-title">What's on the page, top to bottom</p>
          <div data-role="blocks"></div>
          <div class="pd-add" data-role="addblock"></div>
          <small class="fe-note">Tags are filled in for each patient: {Patient name}, {First name}, {Last name}, {Date of birth},
            {Patient ID}, {Today}, {My name}.</small>
          </div>
        </details>
        
        ${lastSent.length ? `<p class="pd-last">Last sent: ${lastSent.map(esc).join("<br>")}</p>` : ""}
        <div class="pd-acts">
          <button type="button" class="lh-btn" data-act="download">Download PDF</button>
          <button type="button" class="lh-btn" data-act="print">Send to printer</button>
          <button type="button" class="lh-btn is-primary" data-act="email-open">Email to patient</button>
        </div>

        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>
      </div>
      <div class="pd-preview"><div class="pd-page" data-role="preview"></div></div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  const preview = dlg.querySelector('[data-role="preview"]');

  const savedNote = dlg.querySelector('[data-role="saved"]');
  let busy = false;
  let drawTimer = 0;
  let saveTimer = 0;
  let dirty = false;

  const draw = () => { preview.innerHTML = html(); };
  const drawSoon = () => { clearTimeout(drawTimer); drawTimer = setTimeout(draw, 250); };
  draw();

  // A design change is saved as the clinic's default shortly after typing stops (and when the window closes)
  async function saveDesign() {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    try {
      await savePlanDocSettings(d, staff);
      if (savedNote.isConnected) savedNote.textContent = "Saved.";
    } catch (ex) {
      console.warn("Plan design not saved:", ex);
      const msg = ex && ex.code === "permission-denied"
        ? "You don't have access to save the default, so it's used for this copy only."
        : "Couldn't save the default. It's used for this copy.";
      if (savedNote.isConnected) savedNote.textContent = msg; else showToast(msg);
    }
  }
  dlg.addEventListener("close", () => { saveDesign(); dlg.remove(); });

  form.addEventListener("submit", (e) => e.preventDefault());
  /* ---------- Design: the blocks on the page ---------- */

  const BLOCK_NAME = { title: "Title and date", text: "Text", message: "Your message to the patient",
    concerns: "What we're working on", treatments: "The treatments", timeline: "The next 12 months" };
  const blocksEl = dlg.querySelector('[data-role="blocks"]');
  const addEl = dlg.querySelector('[data-role="addblock"]');
  const newBlock = (type, extra = {}) => ({ id: Math.random().toString(36).slice(2, 10), type, text: "", size: "m", bold: false,
    tint: false, align: "left", ...extra });

  function drawBlocks() {
    const n = d.blocks.length;
    blocksEl.innerHTML = d.blocks.map((b, i) => `<div class="pd-blk" data-b="${esc(b.id)}">
      <div class="pd-blk-head"><strong>${esc(BLOCK_NAME[b.type] || "Block")}</strong>
        <button type="button" class="po-mini" data-bact="up" aria-label="Move up" title="Move up"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="po-mini" data-bact="down" aria-label="Move down" title="Move down"${i === n - 1 ? " disabled" : ""}>↓</button>
        <button type="button" class="po-mini" data-bact="remove" aria-label="Remove" title="Remove">×</button></div>
      ${b.type === "title" ? `<input data-bf="text" maxlength="80" value="${esc(b.text)}" aria-label="Title" />` : ""}
      ${b.type === "text" ? `<textarea data-bf="text" rows="2" maxlength="2000" aria-label="Text">${esc(b.text)}</textarea>
        <div class="pd-blk-opts">
          <select class="fb-select" data-bf="size" aria-label="Size">${[["s", "Small"], ["m", "Normal"], ["l", "Large"], ["xl", "Extra large"]].map(([v, t]) =>
            `<option value="${v}"${b.size === v ? " selected" : ""}>${t}</option>`).join("")}</select>
          <label class="pd-tog" title="Bold"><input type="checkbox" data-bf="bold"${b.bold ? " checked" : ""} /><span><b>B</b></span></label>
          <label class="pd-tog" title="Use the design colour"><input type="checkbox" data-bf="tint"${b.tint ? " checked" : ""} /><span>Colour</span></label>
          <label class="pd-tog" title="Centre on the page"><input type="checkbox" data-bf="center"${b.align === "center" ? " checked" : ""} /><span>Centre</span></label>
        </div>` : ""}
      ${b.type === "message" ? '<small class="fe-note">Shows what you type in "Message to the patient" above.</small>' : ""}
    </div>`).join("");
    const missing = ["title", "message", "concerns", "treatments", "timeline"].filter((t) => !d.blocks.some((b) => b.type === t));
    addEl.innerHTML = `<button type="button" class="lh-btn" data-badd="heading">+ Heading</button>
      <button type="button" class="lh-btn" data-badd="text">+ Text</button>
      ${missing.map((t) => `<button type="button" class="lh-btn" data-badd="${t}">+ ${esc(BLOCK_NAME[t])}</button>`).join("")}`;
  }
  drawBlocks();

  // Standard design: the blocks list. A Form Builder design: its tags and an Edit link.
  function syncDesign() {
    dlg.querySelector('[data-role="std"]').hidden = !!d.formId;
    dlg.querySelector('[data-role="tplhelp"]').hidden = !d.formId;
    dlg.querySelector('[data-role="tpledit"]').href = `${location.pathname}${location.search}#/forms/${encodeURIComponent(d.formId || "")}`;
    const msg = dlg.querySelector('[data-role="tplmsg"]');
    msg.textContent = tplMsg;
    msg.hidden = !tplMsg;
  }
  syncDesign();

  const touched = () => {
    dirty = true;
    savedNote.textContent = "";
    drawSoon();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDesign, 1200);
  };

  dlg.querySelector(".pd-design").addEventListener("click", (e) => {
    if (e.target.closest("[data-tplreload]")) { loadTpl().then(() => { syncDesign(); draw(); }); return; }
    const add = e.target.closest("[data-badd]");
    if (add) {
      const t = add.dataset.badd;
      // Headings and text go at the top (move them with the arrows); the others go at the end
      if (t === "heading") d.blocks.unshift(newBlock("text", { text: "New heading", size: "l", bold: true }));
      else if (t === "text") d.blocks.unshift(newBlock("text", { text: "New text" }));
      else d.blocks.push(newBlock(t, t === "title" ? { text: d.title } : {}));
      drawBlocks();
      touched();
      if (t === "heading" || t === "text") { const box = blocksEl.querySelector("textarea"); if (box) { box.focus(); box.select(); } }
      return;
    }
    const act = e.target.closest("[data-bact]");
    if (!act || act.disabled) return;
    const i = d.blocks.findIndex((b) => b.id === act.closest("[data-b]").dataset.b);
    if (i < 0) return;
    if (act.dataset.bact === "remove") d.blocks.splice(i, 1);
    else {
      const j = i + (act.dataset.bact === "up" ? -1 : 1);
      if (j < 0 || j >= d.blocks.length) return;
      [d.blocks[i], d.blocks[j]] = [d.blocks[j], d.blocks[i]];
    }
    drawBlocks();
    touched();
  });

  form.addEventListener("input", (e) => {
    const t = e.target;
    if (t.name === "message") { pick.message = t.value.trim(); drawSoon(); return; }
    const row = t.dataset.bf ? t.closest("[data-b]") : null;
    if (row) {
      const b = d.blocks.find((y) => y.id === row.dataset.b);
      if (!b) return;
      const f = t.dataset.bf;
      if (f === "center") b.align = t.checked ? "center" : "left";
      else if (f === "bold" || f === "tint") b[f] = t.checked;
      else b[f] = t.value;
      if (b.type === "title" && f === "text") d.title = t.value;
      touched();
      return;
    }
    const key = t.dataset.d;
    if (!key) return;
    d[key] = t.type === "checkbox" ? t.checked : key === "fontSize" ? Number(t.value) : t.value;
    if (key === "formId") { syncDesign(); loadTpl().then(() => { syncDesign(); draw(); }); }
    touched();
  });
  form.addEventListener("change", (e) => {
    const t = e.target;
    if (!t.dataset.line) return;
    if (t.checked) pick.lines.add(t.dataset.line); else pick.lines.delete(t.dataset.line);
    draw();
  });

  const nothing = () => !all.some((x) => pick.lines.has(x.l.id));
  const fail = (t) => { err.textContent = t; err.hidden = false; };

  async function run(btn, label, job) {
    if (busy) return;
    if (nothing()) { fail("Tick at least one treatment to include."); return; }
    err.hidden = true;
    busy = true;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try {
      await job();
    } catch (ex) {
      console.error("Patient copy failed:", ex);
      fail(SEND_ERRORS[ex && ex.code] || (ex && ex.message && !ex.code ? ex.message : "Couldn't send. Try again."));
    } finally {
      busy = false;
      if (btn.isConnected) { btn.disabled = false; btn.textContent = was; }
    }
  }

  /* ---------- Email: its own window on top ---------- */

  // What's typed is kept if the window is closed and opened again
  const mail = { to: patient.email || "", cc: "", subject: fillIn(d.emailSubject, patient, staff), body: fillIn(d.emailMessage, patient, staff) };

  function openEmail() {
    if (busy) return;
    if (nothing()) { fail("Tick at least one treatment to include."); return; }
    err.hidden = true;
    const onFile = String(patient.email || "").trim().toLowerCase();
    const box = document.createElement("dialog");
    box.className = "lh-dialog pd-mail";
    box.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Email the treatment plan</h3>
        <p>The plan is attached as a PDF, exactly as it looks in the preview.</p></div>
      <label class="lh-field"><span class="lh-label">To</span>
        <input name="to" type="email" maxlength="254" autocomplete="off" value="${esc(mail.to)}" /></label>
      <p class="fe-note fe-bad" data-role="warn" hidden></p>
      <label class="lh-field"><span class="lh-label">CC (optional)</span>
        <input name="cc" type="email" maxlength="254" autocomplete="off" value="${esc(mail.cc)}" /></label>
      <label class="lh-field"><span class="lh-label">Subject</span>
        <input name="subject" maxlength="200" value="${esc(mail.subject)}" /></label>
      <label class="lh-field"><span class="lh-label">Message</span>
        <textarea name="body" rows="9" maxlength="3000">${esc(mail.body)}</textarea></label>
      <p class="pd-attach">Attached: ${esc(fileName)}</p>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Send email</button>
      </div></form>`;
    const f = box.querySelector("form");
    const el = f.elements;
    const bad = box.querySelector(".lh-error");
    const warn = box.querySelector('[data-role="warn"]');
    const send = f.querySelector('[type="submit"]');
    let sending = false;

    const checkTo = () => {
      const v = el.to.value.trim().toLowerCase();
      warn.textContent = !onFile ? "There's no email address on this patient's record. Type one in."
        : "This isn't the email address on the patient's record.";
      warn.hidden = !!onFile && (!v || v === onFile);
    };
    el.to.addEventListener("input", checkTo);
    checkTo();

    const keep = () => Object.assign(mail, { to: el.to.value.trim(), cc: el.cc.value.trim(), subject: el.subject.value.trim(), body: el.body.value.trim() });
    box.addEventListener("cancel", (e) => { if (sending) e.preventDefault(); });
    box.addEventListener("close", () => { keep(); box.remove(); });
    box.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!sending) box.close(); });

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (sending) return;
      keep();
      const show = (t) => { bad.textContent = t; bad.hidden = false; };
      bad.hidden = true;
      if (!EMAIL_RE.test(mail.to)) { show("Enter a valid email address in To."); el.to.focus(); return; }
      if (mail.cc && !EMAIL_RE.test(mail.cc)) { show("Check the CC email address."); el.cc.focus(); return; }
      if (!mail.subject || !mail.body) { show("Add a subject and a message."); return; }
      sending = true;
      busy = true;
      send.disabled = true;
      send.textContent = "Preparing the PDF…";
      try {
        const { pdf } = await makePdf();
        send.textContent = "Sending…";
        await deliverPlanDoc({
          patientId: patient.id, kind: "email", pdf, fileName, to: mail.to, cc: mail.cc, subject: mail.subject,
          html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1e293b">${paras(mail.body)}</div>`,
        });
        sending = false;
        busy = false;
        box.close();
        showToast(`Emailed to ${mail.to}`);
        dlg.close();
        if (onSent) onSent("email");
      } catch (ex) {
        console.error("Plan email failed:", ex);
        show(SEND_ERRORS[ex && ex.code] || (ex && ex.message && !ex.code ? ex.message : "Couldn't send. Try again."));
        sending = false;
        busy = false;
        send.disabled = false;
        send.textContent = "Send email";
      }
    });

    document.body.appendChild(box);
    box.showModal();
    (mail.to ? el.body : el.to).focus();
  }

  form.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "close") { if (!busy) dlg.close(); return; }
    if (act === "email-open") { openEmail(); return; }
    if (act === "download") {
      run(b, "Making the PDF…", async () => {
        const { blob } = await makePdf();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
    } else if (act === "print") {
      run(b, "Sending…", async () => {
        await deliverPlanDoc({ patientId: patient.id, kind: "print", pdf: (await makePdf()).pdf, fileName });
        showToast("Sent to the printer");
        if (onSent) onSent("print");
      });
    }
  });
}