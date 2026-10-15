// The patient's copy of their treatment plan: choose what to include, preview it, then download, print or email.
import { db } from "./firebase-config.js";
import { doc, getDoc, getDocs, collection, query, orderBy, limit }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getPlanDocSettings, deliverPlanDoc, phaseOf, cleanWorkflow } from "./plan-api.js";
import { thisMonth, addMonths } from "./plan-track.js";
import { showToast } from "./utils.js";


const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PDF_LIB = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
const ACTIVE = ["active", "maintenance"];
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const firstName = (p) => p.firstName || String(p.name || "").split(" ")[0] || "";
const fillIn = (t, p) => String(t || "").replace(/\{\s*first name\s*\}/gi, firstName(p)).replace(/\{\s*full name\s*\}/gi, p.name || "");
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

// Adds up the dollar amounts in the quotes ("$650", "$1,240.50")
function quoteTotal(list) {
  let t = 0;
  list.forEach((c) => (String(c.quote || "").match(/\$\s?[\d,]+(?:\.\d{2})?/g) || [])
    .forEach((m) => { t += Number(m.replace(/[$,\s]/g, "")) || 0; }));
  return Math.round(t * 100) / 100;
}
const money = (n) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

// pick = { concerns: Set(keys), lines: Set(line ids), prices: Set(keys), message }
export function planDocHtml({ patient, master, track, labelOf, d, lh, pick, staff, wf = cleanWorkflow({}) }) {
  const colour = d.colour;
  const concerns = master.concerns.filter((c) => pick.concerns.has(c.key) && c.lines.some((l) => pick.lines.has(l.id)));
  const today = new Date();
  const todayText = today.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

  const sectionHtml = (c) => {
    const lab = labelOf(c.key);
    const lines = c.lines.filter((l) => pick.lines.has(l.id));
    return `<div style="margin:0 0 14px;padding:12px 14px;border:1px solid #e2e8f0;border-left:5px solid ${lab.colour};page-break-inside:avoid">
      <div style="font-size:15px;font-weight:bold;color:#0f172a">${esc(lab.label)}</div>
      ${c.area ? `<div style="font-size:12px;color:#64748b">Areas: ${esc(c.area)}</div>` : ""}
      ${c.description ? `<p style="margin:6px 0 8px">${esc(c.description)}</p>` : ""}
      <table style="width:100%;border-collapse:collapse;font-size:13px">${lines.map((l) => {
        const lt = track.get(c.key).lines.get(l.id);
        return `<tr>
          <td style="padding:7px 10px 7px 0;border-top:1px solid #f1f5f9;vertical-align:top;width:48%"><strong>${esc(l.treatment)}</strong>
            <div style="color:#64748b;font-size:12px">${esc(scheduleText(l, lt))}</div></td>
          <td style="padding:7px 0;border-top:1px solid #f1f5f9;vertical-align:top;color:#334155">${esc(progressText(lt))}</td></tr>`;
      }).join("")}</table>
      ${pick.prices.has(c.key) && c.quote ? `<div style="margin-top:8px;padding:8px 10px;background:#f8fafc;font-size:12px;color:#334155">
        <strong style="color:#0f172a">Quote</strong><br>${esc(c.quote).replace(/\n/g, "<br>")}</div>` : ""}
    </div>`;
  };

  // Grouped by priority, with a quote total under each (when switched on in the plan workflow)
  const many = wf.phases.length > 1;
  let grand = 0;
  let priced = 0;
  const sections = wf.phases.map((ph) => {
    const list = concerns.filter((c) => phaseOf(wf, c.priority).id === ph.id);
    if (!list.length) return "";
    const total = wf.docPhaseTotals ? quoteTotal(list.filter((c) => pick.prices.has(c.key))) : 0;
    if (total) { grand += total; priced++; }
    return `${many ? `<div style="margin:18px 0 8px;padding-left:10px;border-left:4px solid ${esc(ph.colour)};page-break-after:avoid">
        <div style="font-size:15px;font-weight:bold;color:#0f172a">${esc(ph.name)}</div>
        ${ph.note ? `<div style="font-size:12px;color:#64748b">${esc(ph.note)}</div>` : ""}</div>` : ""}
      ${list.map(sectionHtml).join("")}
      ${total ? `<div style="margin:-6px 0 14px;text-align:right;font-size:12px;color:#334155">Quoted${
        many ? ` for ${esc(ph.name)}` : ""}: <strong>${esc(money(total))}</strong></div>` : ""}`;
  }).join("") + (priced > 1 ? `<div style="margin:4px 0 14px;padding:8px 10px;background:#f8fafc;text-align:right;font-size:13px">
    Full plan as quoted: <strong>${esc(money(grand))}</strong></div>` : "");

  // The coming 12 months: planned and booked treatments, and the patient's events
  const cur = thisMonth();
  const months = Array.from({ length: 12 }, (_, i) => addMonths(cur, i));
  const byMonth = new Map(months.map((k) => [k, []]));
  concerns.forEach((c) => c.lines.filter((l) => pick.lines.has(l.id)).forEach((l) => {
    track.get(c.key).lines.get(l.id).slots.forEach((s) => {
      let k = s.month;
      if (s.state === "due" || s.state === "overdue") k = cur;
      else if (s.state !== "planned" && s.state !== "booked") return;
      if (!byMonth.has(k)) return;
      byMonth.get(k).push(`<span style="display:inline-block;margin:0 10px 2px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${
        labelOf(c.key).colour};margin-right:5px"></span>${esc(l.treatment)}${s.state === "booked" ? ` <span style="color:#64748b">(booked ${esc(dayLong(s.date))})</span>` : ""}</span>`);
    });
  }));
  master.events.forEach((e) => {
    if (byMonth.has(e.month)) byMonth.get(e.month).push(`<span style="display:inline-block;margin:0 10px 2px 0;color:#92400e;font-weight:bold">★ ${esc(e.name)}</span>`);
  });
  const timeline = months.filter((k) => byMonth.get(k).length).map((k) => `<tr>
    <td style="padding:6px 10px 6px 0;border-top:1px solid #f1f5f9;vertical-align:top;width:130px;font-weight:bold;color:#0f172a">${esc(monthLong(k))}</td>
    <td style="padding:6px 0;border-top:1px solid #f1f5f9;vertical-align:top">${byMonth.get(k).join("")}</td></tr>`).join("");

  return `<div style="width:720px;padding:4px;background:#fff;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#1e293b">
    ${letterheadHtml(lh, colour)}
    <h1 style="margin:18px 0 2px;font-size:22px;color:${colour}">${esc(d.title)}</h1>
    <div style="margin:0 0 14px;color:#64748b;font-size:12px">For ${esc(patient.name || "")} · ${esc(todayText)}</div>
    ${d.welcome ? paras(fillIn(d.welcome, patient)) : ""}
    ${pick.message ? `<div style="margin:4px 0 14px;padding:10px 12px;background:#f8fafc;border-left:3px solid ${colour}">${paras(pick.message, "margin:0 0 6px")}</div>` : ""}
    ${sections ? `<h2 style="margin:16px 0 8px;font-size:15px;color:#0f172a">Your concerns and treatments</h2>${sections}` : ""}
    ${timeline ? `<div style="page-break-inside:avoid"><h2 style="margin:16px 0 6px;font-size:15px;color:#0f172a">Your next 12 months</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">${timeline}</table></div>` : ""}
    ${d.closing ? `<div style="margin-top:16px">${paras(fillIn(d.closing, patient))}</div>` : ""}
    ${d.disclaimer ? `<p style="margin:12px 0 0;font-size:11px;color:#64748b">${esc(d.disclaimer).replace(/\n/g, "<br>")}</p>` : ""}
    <p style="margin:12px 0 0;font-size:11px;color:#94a3b8">Prepared${staff && staff.name ? ` by ${esc(staff.name)}` : ""}${lh && lh.name ? ` · ${esc(lh.name)}` : ""}</p>
  </div>`;
}

/* ---------- PDF (made in the browser, so it matches the preview) ---------- */

function loadPdfLib() {
  if (window.html2pdf) return Promise.resolve(window.html2pdf);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDF_LIB;
    s.onload = () => (window.html2pdf ? resolve(window.html2pdf) : reject(new Error("The PDF maker didn't start.")));
    s.onerror = () => reject(new Error("The PDF maker couldn't load. Check your connection."));
    document.head.appendChild(s);
  });
}

async function pdfWorker(html, fileName) {
  const h2p = await loadPdfLib();
  return h2p().set({
    margin: [12, 12, 14, 12],
    filename: fileName,
    image: { type: "jpeg", quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak: { mode: ["css", "legacy"] },
  }).from(html, "string");
}

async function pdfBase64(html, fileName) {
  const uri = await (await pdfWorker(html, fileName)).outputPdf("datauristring");
  const i = uri.indexOf("base64,");
  if (i < 0) throw new Error("Couldn't make the PDF.");
  return uri.slice(i + 7);
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
export async function openPlanDocument({ patient, master, track, labelOf, staff, onSent, workflow }) {
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
    showToast("Couldn't open the patient copy. Try again.");
    return;
  }

  const pick = {
    concerns: new Set(master.concerns.filter((c) => ACTIVE.includes(c.status) &&
      (wf.docShowWaiting || phaseOf(wf, c.priority).tracked)).map((c) => c.key)),
    lines: new Set(master.concerns.flatMap((c) => c.lines.map((l) => l.id))),
    prices: new Set(d.showPrices ? master.concerns.filter((c) => c.quote).map((c) => c.key) : []),
    message: "",
  };
  const fileName = `Treatment plan - ${patient.name || "Patient"}.pdf`;
  const html = () => planDocHtml({ patient, master, track, labelOf, d, lh, pick, staff, wf });
  const lastSent = sends.map((s) => `${s.kind === "print" ? "Printed" : `Emailed to ${s.to}`} ${
    s.sentAt ? new Date(s.sentAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""}${s.sentBy ? ` by ${s.sentBy}` : ""}`);

  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog pd-dlg";
  dlg.innerHTML = `
    <form class="pd-grid" novalidate>
      <div class="pd-opts">
        <div class="lh-dialog-head"><h3>Patient copy</h3>
          <p>Choose what to include. Clinicians' notes are never included.</p></div>
        <div class="pd-cons">${master.concerns.map((c) => {
          const lab = labelOf(c.key);
          return `<div class="pd-con" style="--c:${esc(lab.colour)}">
            <label class="fe-check pd-con-name"><input type="checkbox" data-con="${esc(c.key)}"${pick.concerns.has(c.key) ? " checked" : ""} />
              <strong>${esc(lab.label)}</strong>${wf.phases.length > 1 ? ` <small class="muted">${esc(phaseOf(wf, c.priority).name)}</small>` : ""}${
                ACTIVE.includes(c.status) ? "" : ' <small class="muted">(not active)</small>'}</label>
            ${c.lines.map((l) => `<label class="fe-check pd-line"><input type="checkbox" data-line="${esc(l.id)}" data-of="${esc(c.key)}"${
              pick.lines.has(l.id) ? " checked" : ""} /> ${esc(l.treatment)}</label>`).join("")}
            ${c.quote ? `<label class="fe-check pd-line pd-price"><input type="checkbox" data-price="${esc(c.key)}"${
              pick.prices.has(c.key) ? " checked" : ""} /> Show the quote</label>` : ""}
          </div>`;
        }).join("")}</div>
        <label class="lh-field"><span class="lh-label">Message to the patient (optional)</span>
          <textarea name="message" rows="3" maxlength="1500" placeholder="A personal note, shown near the top"></textarea></label>
        ${lastSent.length ? `<p class="pd-last">Last sent: ${lastSent.map(esc).join("<br>")}</p>` : ""}
        <div class="pd-acts">
          <button type="button" class="lh-btn" data-act="download">Download PDF</button>
          <button type="button" class="lh-btn" data-act="print">Send to printer</button>
          <button type="button" class="lh-btn is-primary" data-act="email-open">Email to patient</button>
        </div>
        <div class="pd-email" data-role="email" hidden>
          <label class="lh-field"><span class="lh-label">To</span><input name="to" type="email" maxlength="254" value="${esc(patient.email || "")}" /></label>
          <label class="lh-field"><span class="lh-label">CC (optional)</span><input name="cc" type="email" maxlength="254" /></label>
          <label class="lh-field"><span class="lh-label">Subject</span><input name="subject" maxlength="200" value="${esc(fillIn(d.emailSubject, patient))}" /></label>
          <label class="lh-field"><span class="lh-label">Message</span><textarea name="body" rows="6" maxlength="3000">${esc(fillIn(d.emailMessage, patient))}</textarea></label>
          <div class="pd-acts">
            <button type="button" class="lh-btn is-quiet" data-act="email-cancel">Cancel</button>
            <button type="button" class="lh-btn is-primary" data-act="email-send">Send email</button>
          </div>
        </div>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Close</button></div>
      </div>
      <div class="pd-preview"><div class="pd-page" data-role="preview"></div></div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  const preview = dlg.querySelector('[data-role="preview"]');
  const emailBox = dlg.querySelector('[data-role="email"]');
  let busy = false;
  let timer = 0;

  const syncLines = () => form.querySelectorAll("[data-line], [data-price]").forEach((x) => {
    x.disabled = !pick.concerns.has(x.dataset.of || x.dataset.price);
  });
  const draw = () => { preview.innerHTML = html(); };
  syncLines();
  draw();

  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("change", (e) => {
    const t = e.target;
    const flip = (set, k) => { if (t.checked) set.add(k); else set.delete(k); };
    if (t.dataset.con) { flip(pick.concerns, t.dataset.con); syncLines(); }
    else if (t.dataset.line) flip(pick.lines, t.dataset.line);
    else if (t.dataset.price) flip(pick.prices, t.dataset.price);
    else return;
    draw();
  });
  form.elements.message.addEventListener("input", () => {
    pick.message = form.elements.message.value.trim();
    clearTimeout(timer);
    timer = setTimeout(draw, 250);
  });

  const nothing = () => !master.concerns.some((c) => pick.concerns.has(c.key) && c.lines.some((l) => pick.lines.has(l.id)));
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

  form.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "close") { if (!busy) dlg.close(); return; }
    if (act === "email-open") { emailBox.hidden = false; form.elements.to.focus(); return; }
    if (act === "email-cancel") { emailBox.hidden = true; return; }

    if (act === "download") {
      run(b, "Making the PDF…", async () => { await (await pdfWorker(html(), fileName)).save(); });
    } else if (act === "print") {
      run(b, "Sending…", async () => {
        await deliverPlanDoc({ patientId: patient.id, kind: "print", pdf: await pdfBase64(html(), fileName), fileName });
        showToast("Sent to the printer");
        if (onSent) onSent("print");
      });
    } else if (act === "email-send") {
      const to = form.elements.to.value.trim();
      const cc = form.elements.cc.value.trim();
      const subject = form.elements.subject.value.trim();
      const message = form.elements.body.value.trim();
      if (!EMAIL_RE.test(to) || (cc && !EMAIL_RE.test(cc))) { fail("Check the email address."); return; }
      if (!subject || !message) { fail("Add a subject and a message."); return; }
      run(b, "Sending…", async () => {
        await deliverPlanDoc({
          patientId: patient.id, kind: "email", pdf: await pdfBase64(html(), fileName), fileName, to, cc, subject,
          html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1e293b">${paras(message)}</div>`,
        });
        showToast(`Emailed to ${to}`);
        dlg.close();
        if (onSent) onSent("email");
      });
    }
  });
}