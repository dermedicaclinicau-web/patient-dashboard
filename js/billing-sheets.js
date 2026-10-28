// Billing sheets: one sheet per patient booked on a day (Calendar → Print billing sheets).
// Staff tick the patients, preview every sheet (and can change any text on it), then make one PDF,
// grouped by clinician then time, to open, download, send to the clinic printer or email to staff.
// The look is set in Billing sheet design (Firestore form_settings/billing_sheet).
// The Scanner reads these sheets once they're scanned, so the headings it relies on never change:
// the name and date at the top, SERVICES DONE TODAY, FEE, Purchase Status and Prov.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, collection, query, where, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getPatient, patientIds } from "./patients.js";
import { listSspRecords } from "./ssp-api.js";
import { callApi } from "./appointments.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SET = ["form_settings", "billing_sheet"];

/* ===================== Design settings ===================== */

export const BS_DEFAULTS = {
  headerNote: "!SCAN THIS INTO BILLING SHEET FOLDER AT THE END OF DAY",
  font: "poppins",     // "poppins" (like the original sheet) or "arial"
  fontSize: 8,
  serviceRows: 5,      // rows under Services done today (more if they have more services)
  sspRows: 2,          // blank rows under their Skin Script products
  nextRows: 5,         // Next appt rows (the first is always blank)
  showSsp: true, fillAmPm: true, showPayment: true, showNext: true, showTicks: true,
  buyingLabel: "BUYING PKG TODAY",
  sideLabel: "LED/ANAESTHETIC APPS/ROOM & TIME",
  consumablesLabel: "CONSUMABLE USED:",
  payLine: "PINPYMNT ZIP EFT CASH TYRO REF#:",
  ticks: ["TO REBOOK", "SEND REBOOKED SCHEDULE"],
};

const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const line = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function cleanBs(x = {}) {
  const D = BS_DEFAULTS;
  const pick = (k, n) => (x[k] === undefined ? D[k] : line(x[k], n));
  return {
    headerNote: pick("headerNote", 150),
    font: x.font === "arial" ? "arial" : "poppins",
    fontSize: int(x.fontSize, 7, 12, D.fontSize),
    serviceRows: int(x.serviceRows, 1, 12, D.serviceRows),
    sspRows: int(x.sspRows, 0, 12, D.sspRows),
    nextRows: int(x.nextRows, 1, 10, D.nextRows),
    showSsp: x.showSsp !== false, fillAmPm: x.fillAmPm !== false, showPayment: x.showPayment !== false,
    showNext: x.showNext !== false, showTicks: x.showTicks !== false,
    buyingLabel: pick("buyingLabel", 60), sideLabel: pick("sideLabel", 80),
    consumablesLabel: pick("consumablesLabel", 60), payLine: pick("payLine", 120),
    ticks: (Array.isArray(x.ticks) ? x.ticks : D.ticks).map((t) => line(t, 60)).filter(Boolean).slice(0, 6),
  };
}

let cache = null;
export async function getBillingSheetSettings(force = false) {
  if (cache && !force) return cache;
  const s = await getDoc(doc(db, ...SET));
  cache = cleanBs(s.exists() ? s.data() : {});
  return cache;
}

export async function saveBillingSheetSettings(x, staff) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const clean = cleanBs(x);
  await setDoc(doc(db, ...SET), {
    ...clean, updatedAt: new Date().toISOString(), updatedBy: String((staff && staff.name) || "").slice(0, 120), updatedByUid: uid,
  });
  cache = clean;
  return clean;
}

/* ===================== The sheet ===================== */

// 7 columns, measured from the clinic's original sheet, so every section lines up
const COLS = "<colgroup>" + [23.5, 7.5, 18.9, 10.8, 6.8, 8.8, 23.7]
  .map((w) => `<col style="width:${w}%">`).join("") + "</colgroup>";
const POPPINS = "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap";

function css(s) {
  const f = s.fontSize;
  const font = s.font === "arial" ? "Arial, Helvetica, sans-serif" : "'Poppins', Arial, Helvetica, sans-serif";
  return `
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${font}; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bs-page { width: 210mm; min-height: 297mm; padding: 5mm 6mm; font-size: ${f}pt; line-height: 1.2;
    break-after: page; page-break-after: always; }
  .bs-page:last-child { break-after: auto; page-break-after: auto; }
  .bs-note { font-size: ${f - 3}pt; font-weight: 700; line-height: 1.1; }
  .bs-head { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm;
    font-weight: 700; font-size: ${f + 3}pt; line-height: 1.15; margin: 0 0 0.3mm; }
  table.bs { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .bs td, .bs th { border: 0.75pt solid #000; padding: 0.4mm 1mm; vertical-align: middle;
    overflow-wrap: break-word; word-break: normal; }
  .bs th { font-weight: 700; text-align: center; font-size: ${f}pt; line-height: 1.1; }
  .bs th.nw { white-space: nowrap; font-size: ${f - 1}pt; padding-left: 0.3mm; padding-right: 0.3mm; }
  .bs tr.r td { height: 7mm; }
  .bs tr.p td { height: 5.2mm; }
  .bs tr.o td { height: 7.5mm; }
  .bs tr.y td { height: 5.6mm; }
  .bs .c { text-align: center; }
  .bs .notes { vertical-align: top; text-align: left; font-size: ${f - 0.5}pt; }
  .bs .prod { text-align: center; font-size: ${f - 1.5}pt; font-weight: 600; line-height: 1.1; }
  .bs .st { text-align: center; font-size: ${f - 2}pt; line-height: 1.1; }
  .bs .side { vertical-align: top; font-size: ${f - 3.5}pt; line-height: 1.2; }
  .bs .owe { text-align: right; vertical-align: bottom; font-weight: 700; font-size: ${f - 0.5}pt; }
  .bs .lab { text-align: right; vertical-align: bottom; font-weight: 700; font-size: ${f - 1.5}pt; }
  .bs .dol { vertical-align: top; font-weight: 700; font-size: ${f - 2.5}pt; }
  .bs .pay { vertical-align: bottom; font-weight: 700; font-size: ${f - 2.5}pt; word-spacing: 3.5mm; }
  .bs .pref { font-weight: 700; font-size: ${f - 2.5}pt; padding-top: 0.2mm; padding-bottom: 0.2mm; }
  .bs .who { font-size: ${f - 2}pt; line-height: 1.1; }
  table.bs.nx { margin-top: -0.75pt; }
  .bs.nx tr.n td { height: 20mm; }
  .bs-ticks { margin-top: 3mm; font-weight: 700; font-size: ${f - 1.5}pt; line-height: 1.9; }
  .bs-ticks i { display: inline-block; width: 2.6mm; height: 2.6mm; border: 0.75pt solid #000;
    margin-right: 1.5mm; vertical-align: -0.2mm; }
  .bs-foot { margin-top: 0.5mm; font-weight: 700; font-size: ${f - 1.5}pt; }
  @media screen {
    body { background: #e2e8f0; padding: 12px; }
    .bs-page { margin: 0 auto 12px; background: #fff; box-shadow: 0 4px 18px rgba(15, 23, 42, .15); }
  }
  body.cap { background: #fff; padding: 0; }
  body.cap .bs-page { margin: 0; box-shadow: none; }`;
}

// d: { patientName, whenText, notes, services[], ssp: { dateText, items[{ name, ampm, status }] } | null,
//      next[{ when, service, staff, dur }] }
function sheetHtml(d, s) {
  const svcN = Math.max(s.serviceRows, d.services.length);
  let t = `<tr><th>APPT NOTES</th><th colspan="2">SERVICES DONE TODAY</th><th>PKG #</th><th>PROV</th><th>FEE</th>` +
    `<th>${esc(s.buyingLabel)}</th></tr>`;
  for (let i = 0; i < svcN; i++) {
    t += `<tr class="r">${i === 0 ? `<td rowspan="${svcN}" class="notes">${esc(d.notes).replace(/\n/g, "<br>")}</td>` : ""}` +
      `<td colspan="2" class="c">${esc(d.services[i] || "")}</td><td></td><td></td><td></td><td></td></tr>`;
  }

  const owing = ["o", `<td colspan="5" class="owe">Owing (To Pay today):</td><td></td>`];
  if (s.showSsp) {
    const items = d.ssp ? d.ssp.items : [];
    const rows = Math.max(1, items.length + s.sspRows);
    t += `<tr><th>${esc(d.ssp ? `SSP ${d.ssp.dateText}` : "SSP: none on file")}</th><th class="nw">AM/PM</th>` +
      `<th colspan="2">Purchase Status</th><th>Prov</th><th>Fee</th>` +
      `<td rowspan="${rows + 2}" class="side">${esc(s.sideLabel)}</td></tr>`;
    for (let i = 0; i < rows; i++) {
      const it = items[i];
      t += `<tr class="p"><td class="prod">${esc(it ? it.name : "")}</td><td class="st">${esc(it && s.fillAmPm ? it.ampm : "")}</td>` +
        `<td colspan="2" class="st">${esc(it ? it.status : "")}</td><td></td><td></td></tr>`;
    }
    t += `<tr class="${owing[0]}">${owing[1]}</tr>`;
  }

  if (s.showPayment) {
    const rows = s.showSsp ? [] : [owing];
    ["GRAND TOTAL:", "USE ACCOUNT'S CREDIT (minus from total amount to pay):", "TOTAL AMOUNT TO PAY:"]
      .forEach((l) => rows.push(["y", `<td colspan="4" class="lab">${esc(l)}</td><td colspan="2" class="dol">$</td>`]));
    for (let i = 0; i < 2; i++) rows.push(["y", `<td colspan="4" class="pay">${esc(s.payLine)}</td><td colspan="2" class="dol">$</td>`]);
    const side = `<td rowspan="${rows.length}" class="side"><b>${esc(s.consumablesLabel)}</b></td>`;
    t += rows.map(([cls, r], i) => `<tr class="${cls}">${r}${i === 0 ? side : ""}</tr>`).join("");
    t += `<tr><td colspan="7" class="pref">PREFERRED TIME/DAY:</td></tr>`;
  }

  let next = "";
  if (s.showNext) {
    next = `<table class="bs nx">${COLS}<tr><th>NEXT APPT (DATE/TIME)</th><th colspan="3">SERVICE</th><th>PROV</th><th>DUR</th>` +
      `<th>APPT. NOTES</th></tr>`;
    const rows = Math.max(s.nextRows, 1 + d.next.length);
    for (let i = 0; i < rows; i++) {
      const x = i === 0 ? null : d.next[i - 1];   // the first row is always left blank
      next += `<tr class="n"><td class="c">${x ? esc(x.when).replace(/\n/g, "<br>") : ""}</td>` +
        `<td colspan="3" class="c">${esc(x ? x.service : "")}</td><td class="c who">${esc(x ? x.staff : "")}</td>` +
        `<td class="c who">${esc(x ? x.dur || "" : "")}</td><td></td></tr>`;
    }
    next += "</table>";
  }

  const ticks = s.showTicks && s.ticks.length
    ? `<div class="bs-ticks">${s.ticks.map((x) => `<div><i></i>${esc(x)}</div>`).join("")}</div>` : "";
  return `<div class="bs-page">
    <div class="bs-note">${esc(s.headerNote)}</div>
    <div class="bs-head"><span>${esc(d.patientName)}</span><span>${esc(d.whenText)}</span></div>
    <table class="bs">${COLS}${t}</table>${next}${ticks}
    <div class="bs-foot">PATIENT NAME: ${esc(String(d.patientName || "").toUpperCase())}</div></div>`;
}

export function buildBillingSheetsHtml(list, s) {
  const font = s.font === "arial" ? "" :
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${POPPINS}">`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Billing sheets</title>${font}<style>${css(s)}</style></head>` +
    `<body>${list.map((d) => sheetHtml(d, s)).join("")}</body></html>`;
}

/* ===================== The data ===================== */

const CANCELLED = /cancel|no.?show|\bdna\b|did not attend/i;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const docKey = (s) => String(s || "").trim().replace(/\//g, "_");
const isKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || "");
const keyDate = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const toKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dmy = (k) => (isKey(k) ? `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)}` : "");
const usDate = (k, month) => (isKey(k) ? keyDate(k).toLocaleDateString("en-US", { month, day: "numeric", year: "numeric" }) : "");
const staffName = (v) => String(v.staff || "").trim() || "Unassigned";

// 840 → "2:00PM"
function hm(min) {
  if (min == null || !Number.isFinite(min)) return "";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "AM" : "PM"}`;
}
// 75 → "1hr 15mins"
function durText(mins) {
  if (!mins || mins <= 0) return "";
  if (mins < 60) return `${mins}mins`;
  return `${Math.floor(mins / 60)}hr${mins % 60 ? ` ${mins % 60}mins` : ""}`;
}
// A date in any of the shapes the older records use → "YYYY-MM-DD"
function anyKey(v) {
  if (!v) return "";
  if (typeof v.toDate === "function") return toKey(v.toDate());
  if (v instanceof Date) return isNaN(v) ? "" : toKey(v);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);   // Australian: day first
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d) ? "" : toKey(d);
}

// "Dermedica Pro B Plus" = "Dermedica Pro B Plus." = "Dermedica Pro B Plus 30ml"
function sameProduct(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.startsWith(`${s} `);
}

// One sheet per patient: all their bookings that day. Their first booking decides the clinician and time.
export function visitsOfDay(appts) {
  const by = new Map();
  [...(appts || [])].sort((a, b) => (a.sortMinutes || 0) - (b.sortMinutes || 0)).forEach((a) => {
    if (CANCELLED.test(String(a.status || ""))) return;
    const id = String(a.patientId || "").trim();
    const name = String(a.patientName || "").trim();
    if (!id && (!name || /^unknown patient$/i.test(name))) return;
    const k = id ? `id:${id}` : `n:${norm(name)}`;
    const v = by.get(k) || { key: k, patientId: id, patientName: name, time: a.time || "", staff: a.staff || "",
      sortMinutes: Number(a.sortMinutes) || 0, services: [], notes: [] };
    (a.services || []).forEach((s) => { s = String(s || "").trim(); if (s && !v.services.includes(s)) v.services.push(s); });
    if (a.note) v.notes.push(String(a.note));
    by.set(k, v);
  });
  return [...by.values()];
}

// Clinician A to Z (Unassigned last), then time, then name
function byStaffThenTime(a, b) {
  const ua = staffName(a) === "Unassigned" ? 1 : 0;
  const ub = staffName(b) === "Unassigned" ? 1 : 0;
  return ua - ub || staffName(a).localeCompare(staffName(b)) || a.sortMinutes - b.sortMinutes ||
    String(a.patientName).localeCompare(String(b.patientName));
}

async function firstDoc(col, ids) {
  for (const id of ids) {
    if (!id) continue;
    try { const s = await getDoc(doc(db, col, id)); if (s.exists()) return s.data(); }
    catch (e) { console.warn(`Billing sheet: ${col}/${id} not read`, e); }
  }
  return null;
}

// Their newest Skin Script: portal protocols first, then the older ones from the SSP sheet
function latestSsp(portal, sk) {
  const list = [];
  (portal || []).forEach((r) => {
    if (!isKey(r.recordDate)) return;
    list.push({ date: r.recordDate, validUntil: String(r.validUntil || ""), items: (r.items || []).map((it) => ({
      name: String(it.name || ""), ampm: it.am && it.pm ? "AM & PM" : it.am ? "AM" : it.pm ? "PM" : "" })) });
  });
  ((sk && sk.protocols) || []).forEach((p) => {
    if (!isKey(p.date)) return;
    list.push({ date: p.date, validUntil: "", items: (p.items || []).map((it) => ({
      name: String(it.product || ""),
      ampm: String(it.protocol || "") || [it.am && "AM", it.pm && "PM"].filter(Boolean).join(" & ") })) });
  });
  list.sort((a, b) => b.date.localeCompare(a.date));   // a portal one wins a tie
  return list[0] || null;
}

// Prescriptions given to them: Scanner prescriptions, the old app's records and portal prescription forms.
// → [{ name, date, loose }]  (loose: a form name, matched if it contains the product's name)
async function prescriptionsOf(ids, dateKey) {
  const list = ids.slice(0, 10);
  const out = [];
  if (!list.length) return out;
  const add = (name, date, loose = false) => { if (name && isKey(date) && date <= dateKey) out.push({ name: String(name), date, loose }); };
  await Promise.all([
    getDocs(query(collection(db, "scans"), where("patientIds", "array-contains-any", list))).then((snap) => snap.forEach((x) => {
      const r = x.data();
      if (r.kind !== "rx" || r.status === "deleted") return;
      const date = anyKey(r.recordDate || r.dateKey);
      (r.items || []).forEach((it) => { add(it.product, date); add(it.medicine, date); });
    })).catch((e) => console.warn("Billing sheet: scanned prescriptions not read", e)),
    getDocs(query(collection(db, "prescription_record"), where("Patient ID", "in", list))).then((snap) => snap.forEach((x) => {
      const r = x.data();
      const date = anyKey(r["Record Date"] || r["Prescription Date"] || r.Date || r["Created At"]);
      ["Prescription Type", "Product", "Product Name", "Medication", "Item"].forEach((k) => add(r[k], date));
    })).catch((e) => console.warn("Billing sheet: older prescriptions not read", e)),
    getDocs(query(collection(db, "form_submissions"), where("patientId", "in", list), where("category", "==", "prescription")))
      .then((snap) => snap.forEach((x) => { const r = x.data(); add(r.templateName, anyKey(r.recordDate), true); }))
      .catch((e) => console.warn("Billing sheet: prescription forms not read", e)),
  ]);
  return out;
}

function givenDate(rx, name) {
  const n = norm(name);
  return rx.filter((p) => (p.loose ? n.length >= 5 && norm(p.name).includes(n) : sameProduct(p.name, name)))
    .map((p) => p.date).sort().pop() || "";
}

// Fallback when the booking times can't be read: the pre-consultation list (no times or lengths)
function nextVisitsFallback(pre, dateKey) {
  return String((pre && pre.futureVisits) || "").split(/\r?\n/).map((l) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(.*)$/.exec(l.trim());
    if (!m) return null;
    const key = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (key <= dateKey) return null;
    const parts = m[4].split(/\)\s*,\s*/).map((p, i, a) => (i < a.length - 1 ? `${p})` : p).trim()).filter(Boolean);
    const svcs = [], who = [];
    parts.forEach((p) => {
      const w = /^(.*\S)\s+\(([^()]*)\)$/.exec(p);
      const n = (w ? w[1] : p).trim();
      if (n) svcs.push(n);
      if (w && w[2].trim() && !who.includes(w[2].trim())) who.push(w[2].trim());
    });
    return { key, when: dmy(key), service: svcs.join(", "), staff: who.join(", "), dur: "" };
  }).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key));
}

// nextMap: { pttId (lower case): [{ date, start, mins, services, staff }] } from Apps Script, or null if it couldn't be read
async function sheetData(v, dateKey, nextMap) {
  const time = String(v.time || "").replace(/\s*(am|pm)\b/i, (x, ap) => ap.toUpperCase()).replace(/\s+/g, "");
  const d = {
    patientName: v.patientName || "Patient",
    whenText: [`${usDate(dateKey, "short")} ${time}`.trim(), v.staff].filter(Boolean).join(" | "),
    notes: v.notes.join("\n"), services: v.services, ssp: null, next: [],
  };
  if (!v.patientId) return d;   // no Patient ID: their records can't be found safely
  let patient = null;
  try { patient = await getPatient(v.patientId); } catch (e) { console.warn("Billing sheet: patient not read", e); }
  const ids = [...new Set([v.patientId, ...(patient ? [patient.id, ...patientIds(patient)] : [])].filter(Boolean))];
  const keys = [...new Set(ids.map(docKey))];
  const [portal, sk, pre, rx] = await Promise.all([
    listSspRecords(ids).catch(() => []), firstDoc("skincare", keys),
    nextMap ? null : firstDoc("pcn_results", keys), prescriptionsOf(ids, dateKey),
  ]);
  if (patient && patient.name) d.patientName = patient.name;

  const ssp = latestSsp(portal, sk);
  if (ssp) {
    const buys = ((sk && sk.purchases) || []).filter((p) => isKey(p.date) && p.date <= dateKey);
    const seen = new Set();
    d.ssp = {
      dateText: usDate(ssp.date, "long") + (isKey(ssp.validUntil) && ssp.validUntil < dateKey ? " (expired)" : ""),
      items: ssp.items.filter((it) => it.name && !seen.has(norm(it.name)) && seen.add(norm(it.name))).map((it) => {
        const given = givenDate(rx, it.name);
        const bought = buys.filter((p) => sameProduct(p.product, it.name)).map((p) => p.date).sort().pop() || "";
        const status = given && given >= bought ? `Given ${dmy(given)}`
          : bought ? `Purchased ${dmy(bought)}` : "Not Purchased";
        return { ...it, status };
      }),
    };
  }

  d.next = nextMap
    ? (nextMap[String(v.patientId).toLowerCase()] || []).filter((x) => x.date > dateKey).map((x) => ({
      when: dmy(x.date) + (x.start != null ? `\n${hm(x.start)}` : ""),
      service: (x.services || []).join(", "), staff: (x.staff || []).join(", "), dur: durText(x.mins),
    }))
    : nextVisitsFallback(pre, dateKey);
  return d;
}

/* ===================== One PDF ===================== */

const loaded = {};
function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((res, rej) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = res;
      el.onerror = () => { delete loaded[src]; rej(new Error("The PDF maker couldn't load. Check the internet connection.")); };
      document.head.appendChild(el);
    });
  }
  return loaded[src];
}
async function pdfTools() {
  await Promise.all([
    window.jspdf || loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"),
    window.html2canvas || loadScript("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"),
  ]);
  return { jsPDF: window.jspdf.jsPDF, html2canvas: window.html2canvas };
}

async function fontsReady(d, font) {
  if (font !== "arial" && d.fonts && d.fonts.load) {
    await Promise.all(["400", "600", "700"].map((w) => d.fonts.load(`${w} 10px Poppins`).catch(() => null)));
  }
  if (d.fonts && d.fonts.ready) await d.fonts.ready;
}

// html: the sheets (as previewed and edited). Each sheet becomes one A4 page (shrunk only if it ran long).
async function makePdf(html, font, onPage) {
  const { jsPDF, html2canvas } = await pdfTools();
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true");
  f.style.cssText = "position:fixed;left:-10000px;top:0;width:820px;height:1200px;border:0;";
  document.body.appendChild(f);
  try {
    await new Promise((res) => { f.onload = res; f.srcdoc = html; });
    const d = f.contentDocument;
    d.body.classList.add("cap");
    await fontsReady(d, font);
    const pages = [...d.querySelectorAll(".bs-page")];
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    for (let i = 0; i < pages.length; i++) {
      const c = await html2canvas(pages[i], { scale: 1.6, backgroundColor: "#ffffff", logging: false, windowWidth: 820 });
      const ratio = c.height / c.width;
      let w = 210, h = 210 * ratio;
      if (h > 297) { h = 297; w = 297 / ratio; }
      if (i) pdf.addPage("a4", "portrait");
      pdf.addImage(c.toDataURL("image/jpeg", 0.88), "JPEG", (210 - w) / 2, 0, w, h, undefined, "FAST");
      c.width = 0; c.height = 0;   // frees the memory (iPads run out on long days)
      if (onPage) onPage(i + 1, pages.length);
    }
    return pdf;
  } finally {
    f.remove();
  }
}

const SEND_ERR = {
  NO_PRINTER: "No printer email address is saved yet. Add it in Form Builder → Printing.",
  FORBIDDEN: "You don't have access to send to the printer or email. Ask an Admin for “Email and print to patients”.",
  RATE_LIMITED: "Too many emails were sent in the last hour. Try again a bit later.",
  QUOTA: "The clinic's daily email limit has been reached. Download it instead.",
  PDF_FAILED: "The PDF didn't arrive properly. Make it again.",
};
const sendErr = (e) => SEND_ERR[e && e.code] || (e && e.message) || "Couldn't send it. Try again.";
const MAX_SEND = 19000000;   // Apps Script accepts PDFs up to about 15 MB

// Shown only in the preview (not in the PDF)
const EDIT_CSS = `
  body[contenteditable] { outline: none; }
  .bs-page { position: relative; cursor: text; }
  .bs-page[data-skip] { opacity: .3; }
  .bs-page[data-skip]::before { content: "Left out of the PDF"; position: absolute; top: 40%; left: 0; right: 0;
    text-align: center; font: 700 22pt Arial, sans-serif; color: #b91c1c; opacity: 1; }
  .bs-page.is-on { outline: 3px solid #0f766e; outline-offset: 4px; }
  .bs td:focus, .bs th:focus { outline: 2px solid #0f766e; }`;

/* ===================== Calendar → Print billing sheets ===================== */

export function openBillingSheets({ dateKey, appts, staff = null }) {
  const visits = visitsOfDay(appts).sort(byStaffThenTime);
  if (!visits.length) { showToast("Nobody is booked on this day."); return; }
  const day = keyDate(dateKey);
  const dayLong = day.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const dayShort = day.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  const fileName = `Billing sheets ${dayShort}.pdf`;
  const groupsOf = (list) => {
    const out = [];
    list.forEach((v, i) => {
      let g = out[out.length - 1];
      if (!g || g.name !== staffName(v)) { g = { name: staffName(v), list: [] }; out.push(g); }
      g.list.push([v, i]);
    });
    return out;
  };

  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog bs-dlg";
  dlg.innerHTML = `
    <form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Print billing sheets</h3>
        <p>${esc(dayLong)} · one sheet per patient, merged into one PDF by clinician, then time.</p></div>
      <div data-view="pick">
        <label class="fe-check"><input type="checkbox" data-role="all" checked /> All ${visits.length} patients</label>
        <div class="bs-pick">${groupsOf(visits).map((g) => `
          <div class="bs-grp"><h4>${esc(g.name)} · ${g.list.length}</h4>${g.list.map(([v, i]) => `
            <label class="fe-check"><input type="checkbox" name="v" value="${i}" checked />
              <span>${esc(v.time)} · ${esc(v.patientName)}</span><small>${esc(v.services.join(", "))}</small></label>`).join("")}</div>`).join("")}</div>
      </div>
      <div data-view="review" hidden>
        <div class="bs-review">
          <div class="bs-rlist" data-role="rlist"></div>
          <div class="bs-rprev">
            <p class="bs-rtip">Click any text on a sheet to change it, or untick <b>Print</b> to leave a sheet out.
              Changes are only made on this PDF, not on the patient's records.</p>
            <iframe title="Billing sheets preview"></iframe>
          </div>
        </div>
      </div>
      <div data-view="done" hidden>
        <div class="bs-file">
          <span class="bs-file-ico" aria-hidden="true">PDF</span>
          <div><b>${esc(fileName)}</b><small data-role="finfo"></small></div>
        </div>
        <div class="bs-opts">
          <button type="button" class="lh-btn" data-act="open">Open</button>
          <button type="button" class="lh-btn" data-act="download">Download</button>
          <button type="button" class="lh-btn" data-act="printer">Send to printer</button>
          <button type="button" class="lh-btn" data-act="email">Email…</button>
        </div>
        <div class="bs-mail" hidden>
          <p class="bs-mail-h">Send it to</p>
          <div class="bs-mail-staff" data-role="staff">Loading staff…</div>
          <label class="f"><span>Another email address (optional)</span><input type="email" data-role="to" maxlength="254" /></label>
          <label class="f"><span>Message (optional)</span><textarea data-role="note" rows="2" maxlength="2000"></textarea></label>
          <div><button type="button" class="lh-btn is-primary" data-act="sendmail">Send email</button></div>
        </div>
      </div>
      <p class="bs-msg" data-role="msg" aria-live="polite"></p>
      <div class="lh-actions">
        ${can("forms.build") ? '<button type="button" class="lh-btn is-quiet" data-act="design">Design…</button>' : ""}
        <button type="button" class="lh-btn is-quiet" data-act="back" hidden>Back</button>
        <span style="flex:1"></span>
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Close</button>
        <button type="submit" class="lh-btn is-primary" data-role="next">Preview sheets</button>
        <button type="button" class="lh-btn is-primary" data-act="makepdf" hidden>Make PDF</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);

  const form = dlg.querySelector("form");
  const q = (sel) => dlg.querySelector(sel);
  const msg = q('[data-role="msg"]');
  const all = q('[data-role="all"]');
  const frame = q(".bs-rprev iframe");
  const boxes = () => [...form.querySelectorAll('[name="v"]')];
  let current = "pick";
  let busy = false;
  let s = null;
  let chosen = [];
  let edited = false;
  let result = null;   // { blob, b64, url, count }
  let staffLoaded = false;

  const view = (name) => {
    current = name;
    ["pick", "review", "done"].forEach((v) => { q(`[data-view="${v}"]`).hidden = v !== name; });
    q('[data-role="next"]').hidden = name !== "pick";
    q('[data-act="makepdf"]').hidden = name !== "review";
    q('[data-act="back"]').hidden = name === "pick";
    const design = q('[data-act="design"]');
    if (design) design.hidden = name !== "pick";
    dlg.classList.toggle("is-wide", name === "review");
    msg.textContent = "";
  };
  const setBusy = (on) => {
    busy = on;
    form.querySelectorAll("button, input, textarea").forEach((el) => { if (el.dataset.act !== "cancel") el.disabled = on; });
  };

  all.addEventListener("change", () => boxes().forEach((b) => { b.checked = all.checked; }));
  form.addEventListener("change", (e) => {
    if (e.target.name === "v") {
      const n = boxes().filter((b) => b.checked).length;
      all.checked = n === boxes().length;
      all.indeterminate = n > 0 && n < boxes().length;
    }
    if (e.target.dataset.keep !== undefined) {
      const page = frame.contentDocument && frame.contentDocument.querySelector(`.bs-page[data-i="${e.target.dataset.keep}"]`);
      if (page) page.toggleAttribute("data-skip", !e.target.checked);
    }
  });

  // Step 1 → 2: get everyone's details and show the sheets
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || current !== "pick") return;
    chosen = boxes().filter((b) => b.checked).map((b) => visits[Number(b.value)]);
    if (!chosen.length) { msg.textContent = "Tick at least one patient."; return; }
    setBusy(true);
    try {
      s = await getBillingSheetSettings(true).catch(() => cleanBs({}));
      let nextMap = null;
      msg.textContent = "Checking their booked visits…";
      try {
        const r = await callApi({ action: "billingSheets", op: "next", from: dateKey,
          patientIds: [...new Set(chosen.map((v) => v.patientId).filter(Boolean))] });
        if (!r.problem) nextMap = r.next || {};
        else console.warn("Booked visits not read:", r.problem);
      } catch (err) { console.warn("Booked visits not read:", err); }

      const out = new Array(chosen.length);
      let done = 0;
      const queue = chosen.map((v, i) => [v, i]);
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const [v, i] = queue.shift();
          try { out[i] = await sheetData(v, dateKey, nextMap); }
          catch (err) {
            console.warn("Billing sheet details failed for", v.patientName, err);
            out[i] = await sheetData({ ...v, patientId: "" }, dateKey, nextMap);
          }
          msg.textContent = `Getting details ${++done} of ${chosen.length}…`;
        }
      }));
      await showReview(out);
      view("review");
      if (!nextMap) msg.textContent = "Booked visit times couldn't be checked, so DUR is blank. You can type it in.";
    } catch (err) {
      console.error("Billing sheets preview failed:", err);
      msg.textContent = (err && err.message) || "Couldn't prepare the sheets. Try again.";
    } finally {
      setBusy(false);
    }
  });

  async function showReview(out) {
    edited = false;
    q('[data-role="rlist"]').innerHTML = groupsOf(chosen).map((g) => `
      <h4>${esc(g.name)}</h4>${g.list.map(([v, i]) => `
        <div class="bs-ritem" data-i="${i}">
          <button type="button" class="bs-rgo" data-go="${i}"><b>${esc(v.patientName)}</b>
            <small>${esc(v.time)}<em data-edited hidden>Edited</em></small></button>
          <label class="bs-rkeep"><input type="checkbox" data-keep="${i}" checked /> Print</label>
        </div>`).join("")}`).join("");
    await new Promise((res) => {
      frame.onload = res;
      frame.srcdoc = buildBillingSheetsHtml(out, s).replace("</style>", `${EDIT_CSS}</style>`);
    });
    const fd = frame.contentDocument;
    fd.querySelectorAll(".bs-page").forEach((p, i) => { p.dataset.i = String(i); });
    fd.body.setAttribute("contenteditable", "true");
    fd.body.spellcheck = false;
    fd.addEventListener("input", () => {
      const sel = fd.getSelection();
      const node = sel && sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const page = el && el.closest(".bs-page");
      if (!page) return;
      edited = true;
      const tag = q(`.bs-ritem[data-i="${page.dataset.i}"] [data-edited]`);
      if (tag) tag.hidden = false;
    });
    await fontsReady(fd, s.font).catch(() => null);
  }

  function goTo(i) {
    const fd = frame.contentDocument;
    if (!fd) return;
    fd.querySelectorAll(".bs-page.is-on").forEach((p) => p.classList.remove("is-on"));
    const page = fd.querySelector(`.bs-page[data-i="${i}"]`);
    if (page) { page.classList.add("is-on"); page.scrollIntoView({ behavior: "smooth", block: "start" }); }
    dlg.querySelectorAll(".bs-ritem").forEach((r) => r.classList.toggle("is-on", r.dataset.i === String(i)));
  }

  // Step 2 → 3: the PDF, from the sheets as they are now (with any changes)
  async function makeTheHtmlPdf() {
    const fd = frame.contentDocument;
    if (!fd) return;
    const clone = fd.documentElement.cloneNode(true);
    clone.querySelector("body").removeAttribute("contenteditable");
    clone.querySelectorAll(".bs-page[data-skip]").forEach((p) => p.remove());
    clone.querySelectorAll(".bs-page.is-on").forEach((p) => p.classList.remove("is-on"));
    const kept = [...clone.querySelectorAll(".bs-page")].map((p) => chosen[Number(p.dataset.i)]).filter(Boolean);
    if (!kept.length) { msg.textContent = "Tick Print on at least one sheet."; return; }
    setBusy(true);
    try {
      const pdf = await makePdf(`<!DOCTYPE html>${clone.outerHTML}`, s.font, (n, t) => { msg.textContent = `Making page ${n} of ${t}…`; });
      if (result) URL.revokeObjectURL(result.url);
      const blob = pdf.output("blob");
      result = { blob, url: URL.createObjectURL(blob), b64: pdf.output("datauristring").split(",")[1], count: kept.length };
      const counts = {};
      kept.forEach((v) => { counts[staffName(v)] = (counts[staffName(v)] || 0) + 1; });
      q('[data-role="finfo"]').textContent =
        `${kept.length} sheet${kept.length === 1 ? "" : "s"} · ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · ")} · ` +
        `${(blob.size / 1048576).toFixed(1)} MB`;
      view("done");
    } catch (err) {
      console.error("Billing sheets PDF failed:", err);
      msg.textContent = (err && err.message) || "Couldn't make the PDF. Try again.";
    } finally {
      setBusy(false);
      if (result && current === "done") {
        const tooBig = result.b64.length > MAX_SEND;
        q('[data-act="printer"]').disabled = tooBig;
        q('[data-act="email"]').disabled = tooBig;
        if (tooBig) msg.textContent = "It's too big to send. Download it, or make it with fewer patients at a time.";
      }
    }
  }

  async function loadStaff() {
    if (staffLoaded) return;
    const box = q('[data-role="staff"]');
    const me = auth.currentUser && auth.currentUser.uid;
    try {
      const r = await callApi({ action: "staffList" });
      const list = (r.staff || []).filter((p) => p.hasEmail)
        .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : String(a.name).localeCompare(String(b.name))));
      box.innerHTML = list.length ? list.map((p) => `
        <label class="fe-check"><input type="checkbox" name="to" value="${esc(p.id)}" ${p.id === me ? "checked" : ""} />
          ${esc(p.name)}${p.id === me ? " (me)" : ""}</label>`).join("")
        : "<small>No staff have an email address saved. Type one below.</small>";
      staffLoaded = true;
    } catch (err) {
      console.warn("Staff list not loaded:", err);
      box.innerHTML = "<small>The staff list couldn't load. Type an email address below.</small>";
    }
  }

  dlg.addEventListener("click", async (e) => {
    const go = e.target.closest("[data-go]");
    if (go) { goTo(go.dataset.go); return; }
    const a = e.target.closest("[data-act]");
    if (!a || a.disabled) return;
    const act = a.dataset.act;
    if (act === "cancel") {
      if (busy) return;
      if (edited && current !== "done" && !confirm("Close without making the PDF? Your changes to the sheets will be lost.")) return;
      dlg.close();
      return;
    }
    if (busy) return;
    if (act === "design") { openBillingSheetDesign({ staff }); return; }
    if (act === "back") {
      if (current === "done") { view("review"); return; }
      if (edited && !confirm("Go back to the patient list? Your changes to the sheets will be lost.")) return;
      view("pick");
      return;
    }
    if (act === "makepdf") { makeTheHtmlPdf(); return; }
    if (!result) return;

    if (act === "open") {
      if (!window.open(result.url, "_blank")) msg.textContent = "Your browser blocked the new tab. Use Download instead.";
    } else if (act === "download") {
      const link = document.createElement("a");
      link.href = result.url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } else if (act === "printer") {
      setBusy(true);
      msg.textContent = "Sending to the printer…";
      try {
        await callApi({ action: "printPdf", pdf: result.b64, fileName });
        msg.textContent = `Sent to the printer: ${result.count} sheet${result.count === 1 ? "" : "s"}.`;
      } catch (err) {
        console.error("Billing sheets to printer failed:", err);
        msg.textContent = sendErr(err);
      } finally { setBusy(false); }
    } else if (act === "email") {
      const box = q(".bs-mail");
      box.hidden = !box.hidden;
      if (!box.hidden) loadStaff();
    } else if (act === "sendmail") {
      const staffIds = [...form.querySelectorAll('[name="to"]:checked')].map((b) => b.value);
      const to = q('[data-role="to"]').value.trim();
      if (!staffIds.length && !to) { msg.textContent = "Tick someone, or type an email address."; return; }
      setBusy(true);
      msg.textContent = "Sending the email…";
      try {
        const r = await callApi({
          action: "billingSheets", op: "email", pdf: result.b64, fileName, staffIds, to,
          note: q('[data-role="note"]').value, dayText: dayLong, count: result.count,
        });
        if (r.problem) msg.textContent = r.problem;
        else {
          msg.textContent = `Emailed to ${(r.to || []).join(", ")}.`;
          q(".bs-mail").hidden = true;
        }
      } catch (err) {
        console.error("Billing sheets email failed:", err);
        msg.textContent = sendErr(err);
      } finally { setBusy(false); }
    }
  });

  dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
  dlg.addEventListener("close", () => { if (result) URL.revokeObjectURL(result.url); dlg.remove(); });
  view("pick");
  dlg.showModal();
}

/* ===================== Billing sheet design ===================== */

const SAMPLE = {
  patientName: "Jane Sample", whenText: "Oct 29, 2026 11:30AM | Dr Teh", notes: "To Rv Dg + Radiesse",
  services: ["Review 15(post treatment)"],
  ssp: { dateText: "August 6, 2026", items: [
    { name: "Dermedica Essential Cleanser", ampm: "AM & PM", status: "Not Purchased" },
    { name: "Dermedica Vitamin A Plus serum", ampm: "PM", status: "Not Purchased" },
    { name: "Dermedica Pro B Plus", ampm: "AM", status: "Purchased 17/09/2026" },
    { name: "Dermedica Sunscreen", ampm: "AM", status: "Purchased 30/04/2026" },
    { name: "Fading cream", ampm: "PM", status: "Given 12/10/2026" },
  ] },
  next: [
    { when: "05/11/2026\n2:00PM", service: "Wrinkle Relaxer Frown", staff: "Dr Teh", dur: "15mins" },
    { when: "19/11/2026\n10:30AM", service: "Clear Complexion Laser LITE Face, Review 15(post treatment)", staff: "Jacquie", dur: "1hr 15mins" },
  ],
};

export async function openBillingSheetDesign({ staff = null } = {}) {
  let st = await getBillingSheetSettings(true).catch(() => cleanBs({}));
  const canSave = can("forms.build");
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog bs-design";
  const text = (k, label, max) => `<label class="f"><span>${label}</span><input data-k="${k}" maxlength="${max}" /></label>`;
  const num = (k, label, lo, hi) => `<label class="f"><span>${label}</span><input data-k="${k}" type="number" min="${lo}" max="${hi}" step="1" /></label>`;
  const tick = (k, label) => `<label class="fe-check"><input type="checkbox" data-k="${k}" /> ${label}</label>`;
  dlg.innerHTML = `<div class="bs-design-wrap">
    <div class="lh-dialog-head"><h3>Billing sheet design</h3>
      <p>How the sheets made from the Calendar look. The preview shows a sample patient.</p></div>
    <div class="bs-design-body">
      <form class="bs-design-form" novalidate>
        ${text("headerNote", "Line at the very top", 150)}
        <label class="f"><span>Font</span><select data-k="font">
          <option value="poppins">Poppins (like the original sheet)</option><option value="arial">Arial</option></select></label>
        <label class="f"><span>Text size</span><select data-k="fontSize">${[7, 8, 9, 10, 11, 12].map((n) => `<option value="${n}">${n} pt${n === 8 ? " (original)" : ""}</option>`).join("")}</select></label>
        <h4>Rows</h4>
        ${num("serviceRows", "Services done today (at least)", 1, 12)}
        ${num("sspRows", "Blank rows under the Skin Script", 0, 12)}
        ${num("nextRows", "Next appt rows (the first is always blank)", 1, 10)}
        <h4>Show</h4>
        ${tick("showSsp", "Skin Script products and purchase status")}
        ${tick("fillAmPm", "Fill in AM/PM from their Skin Script")}
        ${tick("showPayment", "Totals and payment")}
        ${tick("showNext", "Next appointments")}
        ${tick("showTicks", "Tick boxes at the bottom")}
        <h4>Wording</h4>
        ${text("buyingLabel", "Last column heading", 60)}
        ${text("sideLabel", "Box beside the Skin Script", 80)}
        ${text("consumablesLabel", "Box beside the totals", 60)}
        ${text("payLine", "Payment line", 120)}
        <label class="f"><span>Tick boxes (one per line)</span><textarea data-k="ticks" rows="3"></textarea></label>
        <p class="fe-note">The Scanner reads the patient name and date at the top, SERVICES DONE TODAY, FEE, Prov and
          Purchase Status, so those always stay the same.</p>
      </form>
      <div class="bs-design-prev"><iframe title="Billing sheet preview"></iframe></div>
    </div>
    <p class="lh-error" role="alert" hidden></p>
    <div class="lh-actions">
      <button type="button" class="lh-btn is-quiet" data-act="reset">Reset to default</button>
      <span style="flex:1"></span>
      <button type="button" class="lh-btn is-quiet" data-act="cancel">${canSave ? "Cancel" : "Close"}</button>
      ${canSave ? '<button type="button" class="lh-btn is-primary" data-act="save">Save</button>' : ""}
    </div></div>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form");
  const frame = dlg.querySelector("iframe");
  const err = dlg.querySelector(".lh-error");
  let timer = null;

  const fill = () => form.querySelectorAll("[data-k]").forEach((el) => {
    const v = st[el.dataset.k];
    if (el.type === "checkbox") el.checked = v !== false;
    else if (el.dataset.k === "ticks") el.value = (v || []).join("\n");
    else el.value = v ?? "";
  });
  const read = () => {
    const x = {};
    form.querySelectorAll("[data-k]").forEach((el) => {
      x[el.dataset.k] = el.type === "checkbox" ? el.checked : el.dataset.k === "ticks" ? el.value.split(/\n+/) : el.value;
    });
    return cleanBs(x);
  };
  const draw = () => { frame.srcdoc = buildBillingSheetsHtml([SAMPLE], st); };
  fill();
  draw();
  form.addEventListener("input", () => { st = read(); clearTimeout(timer); timer = setTimeout(draw, 200); });
  form.addEventListener("submit", (e) => e.preventDefault());
  if (!canSave) form.querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = true; });

  dlg.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "cancel") dlg.close();
    if (a.dataset.act === "reset" && canSave) { st = cleanBs({}); fill(); draw(); }
    if (a.dataset.act === "save") {
      a.disabled = true;
      err.hidden = true;
      try {
        await saveBillingSheetSettings(read(), staff);
        dlg.close();
        showToast("Billing sheet design saved");
      } catch (ex) {
        console.error("Billing sheet design save failed:", ex);
        err.textContent = ex.code === "permission-denied"
          ? "Saving is blocked. Check the form_settings/billing_sheet Firestore rule has been published."
          : "Couldn't save. Try again.";
        err.hidden = false;
        a.disabled = false;
      }
    }
  });
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}