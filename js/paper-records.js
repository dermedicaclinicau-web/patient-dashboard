// Paper records (#/paper): scanned treatment records from the Google Drive folder, and Day Sheet visits with no record
import { callApi } from "./appointments.js";
import { searchPatients, warmPatients } from "./patient-list.js";
import { listPublishedForms, getFormTemplate, getFormVersion } from "./form-templates.js";
import { normaliseField } from "./form-fields.js";
import { mountConsumablesField, consumableAmountText } from "./consumables-field.js";
import { consumeInTx, backdateCounts, getBaseline, listProducts, listMoves, undoMove, dayKey, isKitProduct, kitId,
  getUsage, correctUsage } from "./inventory-api.js";
import { db } from "./firebase-config.js";
import { runTransaction, collection, query, where, getDocs, getDoc, doc, limit }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { escapeHtml as esc, showToast, formatDobLong, formatMobile } from "./utils.js";
import { confirmDialog } from "./dialog.js";
import { rxProductList } from "./rx-products.js";
import { can } from "./perms.js";

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (k, n) => { const d = keyDate(k); if (!d) return ""; d.setDate(d.getDate() + n); return keyOf(d); };
const niceDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : ""; };
const shortDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""; };
const niceAt = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); };
const ago = (k) => {
  const d = keyDate(k);
  if (!d) return "";
  const n = Math.round((keyDate(todayKey()) - d) / 864e5);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : n < 14 ? `${n} days ago` : n < 70 ? `${Math.round(n / 7)} weeks ago` : `${Math.round(n / 30.4)} months ago`;
};

const STATUS = { todo: ["To enter", "warn"], help: ["Need help", "bad"], skip: ["Not a record", "muted"], entered: ["Entered", "ok"],
  filed: ["Filed", "ok"] };
const SKIP_REASONS = ["Already on the patient's file", "Blank or unreadable page", "Duplicate scan", "Not a patient record", "Other"];
const FILE_TYPES = [["treatment", "Treatment record"], ["consent", "Consent"], ["rx", "Prescription"], ["billing", "Billing sheet"]];
const FILE_NAME = Object.fromEntries(FILE_TYPES);
const FILE_WHERE = { treatment: "Treatment Records", consent: "Consent Records", rx: "Product Prescriptions", billing: "Billing" };
const DONE = ["entered", "skip", "filed"];
const OTHER = "__other";
// A reply that isn't a real save → a message saying why
const notSaved = (r) => (r && r.error === "BAD_REQUEST"
  ? "It wasn't saved: the portal's Apps Script doesn't have Paper records filing yet. Deploy the latest Code.gs as a new version, then try again."
  : r && r.error === "FORBIDDEN" ? "It wasn't saved: your access doesn't include Paper records."
  : r && r.error === "UNAUTHORIZED" ? "It wasn't saved: your login has expired. Refresh the page and log in again."
  : `It wasn't saved${r && r.error ? ` (${r.error})` : ""}. Try again.`);
const LINK_KIND = { treatment: "Treatment record", consent: "Consent" };
const linkText = (l) => `${LINK_KIND[l.kind] || "Record"}${l.title ? `: ${l.title}` : ""} · ${l.patientName || "Unknown patient"}${
  l.date ? ` · ${niceDay(l.date)}` : ""}`;
const isLinked = (f) => !!(f.linked && f.linked.length);
const dupText = (d) => [d.kind ? FILE_NAME[d.kind] : (STATUS[d.status] || STATUS.todo)[0], d.patientName,
  d.recordDate && niceDay(d.recordDate), d.by].filter(Boolean).join(" · ");
const RES = { none: "No treatment given", elsewhere: "Recorded somewhere else" };
const RANGES = [["7", "Last 7 days"], ["30", "Last 30 days"], ["month", "This month"], ["lastmonth", "Last month"]];
// [from, to] for a quick choice ("" = any time)
function rangeDates(k) {
  const t = new Date();
  if (k === "7" || k === "30") return [addDays(todayKey(), -(Number(k) - 1)), todayKey()];
  if (k === "month") return [keyOf(new Date(t.getFullYear(), t.getMonth(), 1)), todayKey()];
  if (k === "lastmonth") return [keyOf(new Date(t.getFullYear(), t.getMonth() - 1, 1)), keyOf(new Date(t.getFullYear(), t.getMonth(), 0))];
  return ["", ""];
}
const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

// Products used on a paper treatment record: linked to the scan, so it's never taken off twice
const paperSubId = (fileId) => `paper_${fileId}`;
// The stock change already made for this scan: { id, lines }, or null
async function usageOf(subId) {
  const s = await getDocs(query(collection(db, "inv_usage"), where("submissionId", "==", subId), limit(1)));
  if (s.empty) return null;
  const d = s.docs[0];
  return { id: d.id, lines: Array.isArray(d.data().lines) ? d.data().lines : [] };
}

/* ---------- Batches that are no longer in stock (backdated records) ---------- */

// Inventory's products, once per page
let prodMemo = null;
const productsOnce = () => (prodMemo = prodMemo || listProducts().catch((e) => { prodMemo = null; throw e; }));

// Every batch a product has ever had, empty ones too, oldest expiry first
async function batchesEver(pid) {
  const s = await getDocs(query(collection(db, "inv_lots"), where("productId", "==", pid)));
  return s.docs.map((d) => {
    const x = d.data() || {};
    return { id: d.id, loc: x.loc === "jt" ? "jt" : "shelf", batch: String(x.batch || ""), expiry: String(x.expiry || ""), qty: Number(x.qty) || 0 };
  }).sort((a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999") || a.loc.localeCompare(b.loc));
}
const normBatch = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

// Why a batch is empty now, for stock used on `date` and recorded later.
// → { plan: "writeoff" | "counted" | "short" | "unknown", move, text }
const COUNT_TYPES = ["count", "baseline", "investigation"];
async function whyEmpty(p, lot, qty, date) {
  if (!lot.id) return { plan: "unknown", text: "This batch was never in the inventory, so it's noted on the record only." };
  const outs = (await listMoves({ productId: p.id, max: 1000 }))          // newest first
    .filter((m) => m.at && dayKey(m.at) >= date)
    .map((m) => ({ m, n: (m.lines || [])
      .filter((l) => l.loc === lot.loc && (l.batch || "") === lot.batch && (l.expiry || "") === lot.expiry)
      .reduce((a, l) => a + (Number(l.delta) || 0), 0) }))
    .filter((x) => x.n < 0);
  // The whole write-off was this one (undoing a bigger one would put the rest back too)
  const wo = outs.find((x) => x.m.type === "writeoff" && !x.m.undone && -x.n === qty);
  if (wo) {
    return { plan: "writeoff", move: wo.m, text: `Written off on ${niceDay(dayKey(wo.m.at))}${wo.m.by ? ` by ${wo.m.by}` : ""}${
      wo.m.note ? ` (${wo.m.note})` : ""}. The write-off is undone and becomes this patient's usage, so stock doesn't change.` };
  }
  const cnt = outs.find((x) => COUNT_TYPES.includes(x.m.type));
  if (cnt) return { plan: "counted", move: cnt.m, text: `A count on ${niceDay(dayKey(cnt.m.at))} already took it off the digital count, so it's noted on the record only.` };
  return { plan: "short", text: "Nothing in the activity explains why it ran out, so it's saved short for the ordering team to check. Nothing goes below zero." };
}
// Every batch of this product in anyone's kit, empty ones too
async function kitBatchesEver(pid) {
  const s = await getDocs(query(collection(db, "inv_kits"), where("productId", "==", pid)));
  return s.docs.map((d) => {
    const x = d.data() || {};
    const sealed = Math.max(0, parseInt(x.sealed, 10) || 0);
    const open = Math.max(0, Number(x.open) || 0);
    return { id: d.id, staffUid: String(x.staffUid || ""), staffName: String(x.staffName || ""),
      batch: String(x.batch || ""), expiry: String(x.expiry || ""),
      units: Math.round((sealed * (Number(x.dosePer) || 0) + open) * 10) / 10 };
  }).sort((a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999"));
}

// A kit batch from the paper that isn't in the clinician's kit now: what happened to it?
// → { plan: "stop" | "counted" | "colleague" | "unknown" | "short", text, kit, kitUid, ref, batch, expiry, other }
async function whyNotInKit(p, owner, batch, expiry, units, date) {
  const nb = normBatch(batch);
  const same = (x) => normBatch(x.batch) === nb && (!expiry || !x.expiry || x.expiry === expiry);
  const [kits, lots, counted, moves] = await Promise.all([
    kitBatchesEver(p.id), batchesEver(p.id),
    countsAfter(date, owner.uid).catch(() => ({})),
    listMoves({ productId: p.id, max: 1000 }).catch(() => []),
  ]);
  const where = `${owner.name}'s kit`;
  const mine = kits.find((k) => k.staffUid === owner.uid && same(k));
  if (mine && mine.units > 0) {
    return { plan: "stop", text: `That batch is still in ${where} (${mine.units} ${p.doseUnit}). Choose it in the products list instead.` };
  }
  const base = { kit: true, kitUid: owner.uid, ref: mine ? mine.id : kitId(owner.uid, p.id, batch, expiry),
    batch: mine ? mine.batch : batch, expiry: mine ? mine.expiry : expiry };

  // The kit was already brought down after the treatment: an accepted kit difference, or an admin set it
  const c = counted[`${p.id}|kit`];
  const set = moves.find((m) => m.type === "kit-count" && m.staffUid === owner.uid && m.at
    && dayKey(m.at) >= date && (Number(m.deltaUnits) || 0) < 0);
  if ((c && c.adjusted) || set) {
    const when = set ? dayKey(set.at) : c.adjDate;
    return { ...base, plan: "counted", text: `${where} was ${set ? `set by ${set.by || "an admin"}` : "counted and the shortfall accepted"} on ${
      niceDay(when)}, after this treatment. The kit already has it off, so it's noted on the record only.` };
  }

  // Used a colleague's vial
  const other = kits.find((k) => k.staffUid !== owner.uid && same(k) && k.units >= units);
  if (other) return { ...base, plan: "colleague", other, batch: other.batch, expiry: other.expiry, text: "" };

  // It's in storage, not a kit
  const store = lots.find((l) => same(l) && l.qty > 0);
  if (store) {
    const from = store.loc === "jt" ? "JT storage" : "the Shelf";
    return { plan: "stop", text: `That batch is in ${from}, not in a kit. If it came from there, change ${p.name} in the products list: Restock → From ${from} (Admins).` };
  }

  if (!kits.some(same) && !lots.some(same)) {
    return { ...base, plan: "unknown", text: "This batch was never in the inventory, so it's noted on the record only. Check it's read right off the paper." };
  }
  return { ...base, plan: "short", text: `Nothing in the activity explains why it isn't in ${where}, so it's saved short for the ordering team to check. Nothing goes below zero.${
    c && c.open ? ` It may explain ${owner.name}'s kit difference from ${niceDay(c.openDate)}: mention this record when you review it in Count differences.` : ""}` };
}
// One of these as a products-used line (the same shape the products field gives consumeInTx)
function extraLine(x, fid) {
  if (x.kit) {   // from a kit: kitUid says whose (the clinician's, or a colleague's)
    return {
      fid, productId: x.p.id, name: x.p.name, kind: "kit", unit: x.p.doseUnit, doseUnit: x.p.doseUnit, dosePer: 0,
      batchLabel: x.p.batchLabel, loc: "kit", block: false, kitUid: x.kitUid,
      rows: [{ ref: x.ref, batch: x.batch, expiry: x.expiry, amount: x.qty, dose: x.qty }],
      extra: x,
    };
  }
  return {
    fid, productId: x.p.id, name: x.p.name, kind: "storage", unit: x.p.stockUnit, stockUnit: x.p.stockUnit,
    loc: x.lot.loc, dosePer: x.p.dosePer, doseUnit: x.p.doseUnit, batchLabel: x.p.batchLabel, block: false,
    rows: [{ ref: x.lot.id || "", batch: x.lot.batch, expiry: x.lot.expiry, amount: x.qty, dose: x.dose }],
    extra: x,
  };
}

// Counts after a day, per "productId|loc": { date, adjusted, open }
//   adjusted: a shortfall there was accepted, so the digital count already has it off
//   open: a shortfall there hasn't been reviewed yet (the digital count still includes it)
// Kit checks: only this person's kit.
const countMemo = {};
function countsAfter(dateKey, uid) {
  const k = `${dateKey}|${uid}`;
  if (!countMemo[k]) {
    countMemo[k] = getDocs(query(collection(db, "inv_counts"), where("dateKey", ">", dateKey))).then((snap) => {
      const out = {};
      snap.forEach((d) => {
        const c = d.data();
        if (c.superseded === true || (c.kind === "kit" && c.byUid !== uid)) return;
        (c.lines || []).forEach((l) => {
          const key = `${l.productId}|${c.kind === "kit" ? "kit" : l.loc}`;
          const x = out[key] || (out[key] = { date: c.dateKey, adjusted: false, adjDate: "", open: false, openDate: "" });
          if (c.dateKey < x.date) x.date = c.dateKey;
          if (!((Number(l.variance) || 0) < 0)) return;   // only a shortfall matters
          // Accepted, or set as starting stock: the digital count was lowered then, so it's already off
          if (["accepted", "baseline"].includes(l.status)) {
            x.adjusted = true;
            if (!x.adjDate || c.dateKey < x.adjDate) x.adjDate = c.dateKey;
          } else if (["open", "investigating"].includes(l.status)) {
            // Still waiting: taking it off now and correcting the count explains it
            x.open = true;
            if (!x.openDate || c.dateKey < x.openDate) x.openDate = c.dateKey;
          }
        });
      });
      return out;
    });
    countMemo[k].catch(() => { delete countMemo[k]; });
  }
  return countMemo[k];
}

const LOC_NAME = { kit: "Your kit", shelf: "The Shelf", jt: "JT storage" };
// "Radiesse: 1.5 mL (1 syringe) (Lot A00263050)"
const csSummary = (lines) => lines.map((l) => `${l.name}: ${l.rows.map((r) =>
  `${consumableAmountText(l, r, false)}${r.batch ? ` (${l.batchLabel || "Batch"} ${r.batch})` : ""}`).join(" + ")}`);



// The last lists loaded, so coming back to the page shows them straight away while they update
const keep = { files: null, visits: null, vMeta: null, thumbs: {} };

export function mountPaperRecords(container, { staff } = {}) {
  const isAdmin = /^admin$/i.test(String((staff && staff.role) || ""));
  const st = { tab: "scans", files: keep.files, visits: keep.visits, vMeta: keep.vMeta || { from: "", cats: [] },
    q: "", vq: "", vStaff: "all", vCat: "all", fBusy: false, vBusy: false,
    showSorted: false, thumbs: keep.thumbs, sFrom: "", sTo: "", sort: "old", sLink: "all", cfg: null };
  let cfgJob = null;
  let staffJob = null;
  const loadStaff = () => staffJob || (staffJob = callApi({ action: "staffList" })
    .then((r) => (r && Array.isArray(r.staff) ? r.staff.filter((s) => s.name) : []))
    .catch((e) => { staffJob = null; throw e; }));
  const loadCfg = () => cfgJob || (cfgJob = callApi({ action: "paper", op: "settings" })
    .then((r) => { st.cfg = r && !r.problem ? r : null; return st.cfg; })
    .catch((e) => { cfgJob = null; throw e; }));

  container.innerHTML = `
    <section class="page wide ppr-page">
      <div class="ppr-head">
        <h2>Paper records</h2>
        <span class="inv-spacer"></span>
        <a class="rc-link" data-role="folder" target="_blank" rel="noopener" hidden>Open the Drive folder ↗</a>
        ${isAdmin ? '<button type="button" class="ff-btn" data-act="settings">Settings</button>' : ""}
        <button type="button" class="ff-btn" data-act="refresh">Refresh</button>
      </div>
      <div class="ppr-tabs" role="tablist"></div>
      <div data-role="body"><div class="skeleton sm"></div></div>
    </section>`;
  const tabsEl = container.querySelector(".ppr-tabs");
  const body = container.querySelector('[data-role="body"]');
  // Still showing this page? (The container is reused by other pages, so isConnected isn't enough)
  const alive = () => body.isConnected;

  /* ---------- Drawing ---------- */

  function counts() {
    const f = st.files || [];
    const n = (s) => f.filter((x) => x.status === s).length;
    return { todo: n("todo"), help: n("help"), done: n("entered") + n("skip") + n("filed"),
      visits: st.visits ? st.visits.filter((x) => !x.res).length : null };
  }
  function drawTabs() {
    const c = counts();
    const busy = (v) => (v == null ? "…" : String(v));
    tabsEl.innerHTML = [
      ["scans", "Scans to enter", st.files ? c.todo : null], ["visits", "Visits without a record", c.visits],
      ["help", "Need help", st.files ? c.help : null], ["done", "Done", st.files ? c.done : null],
    ].map(([k, l, n]) => `<button type="button" class="ppr-tab${st.tab === k ? " is-on" : ""}" role="tab"
      aria-selected="${st.tab === k}" data-tab="${k}">${esc(l)} <em>${esc(busy(n))}</em></button>`).join("");
  }

  function rowHtml(f) {
    const [label, tone] = STATUS[f.status] || STATUS.todo;
    const th = st.thumbs[f.id];
    const prodLine = f.status === "filed" && f.filedKind === "treatment"
      ? (f.productsDone ? (f.products && f.products.length
          ? `Products${f.productsFor ? ` (${f.productsFor})` : ""}: ${f.products.join(" · ")}` : "Products: not written on the paper")
        : "Products used not saved yet") : "";
    const sub = [`Uploaded ${niceAt(f.created)}`, f.folder, f.kind === "pdf" ? "PDF" : "Photo"].filter(Boolean).join(" · ");
    const extra = f.status === "filed" ? `${FILE_NAME[f.filedKind] || "Filed"}${f.filedTitle ? `: ${f.filedTitle}` : ""} · ${f.patientName} · ${niceDay(f.recordDate)}`
      : f.status === "entered" ? `${f.patientName} · treatment on ${niceDay(f.recordDate)}`
      : f.status === "skip" ? f.reason : f.status === "help" ? `“${f.note}”` : "";
    return `<li class="ppr-row">
      <button type="button" class="ppr-thumb" data-open="${esc(f.id)}" data-thumb="${esc(f.id)}" aria-label="Open ${esc(f.name)}">${
        th ? `<img src="${esc(th)}" alt="" loading="lazy" />` : ICON_FILE}</button>
      <div class="ppr-main"><strong>${esc(f.name)}</strong><small>${esc(sub)}</small>${
        extra ? `<small class="ppr-extra">${esc(extra)}${f.by ? ` · ${esc(f.by)}` : ""}</small>` : ""}${
        prodLine ? `<small class="ppr-extra ppr-prodline${f.productsDone ? "" : " is-warn"}">${esc(prodLine)}</small>` : ""}${
        isLinked(f) && f.status === "todo" ? `<small class="ppr-linked">On file: ${esc(linkText(f.linked[0]))}${
          f.linked.length > 1 ? ` (+${f.linked.length - 1} more)` : ""}</small>` : ""}${
        f.dupOf && f.status === "todo" ? `<small class="ppr-linked is-dup">Same file as one already sorted: ${esc(dupText(f.dupOf))}</small>` : ""}</div>
      <span class="ppr-pill is-${f.dupOf && f.status === "todo" ? "warn" : isLinked(f) && f.status === "todo" ? "ok" : tone}">${esc(
        f.dupOf && f.status === "todo" ? "Possible duplicate" : isLinked(f) && f.status === "todo" ? "Already on file" : label)}</span>
      <button type="button" class="lh-btn" data-open="${esc(f.id)}">${f.status === "todo" || f.status === "help" ? "Enter" : "View"}</button>
    </li>`;
  }

  function visitHtml(v) {
    const day = v.dayName || v.name;
    const nameEl = v.pid
      ? `<a href="#/patient/${encodeURIComponent(v.pid)}" target="_blank" rel="noopener">${esc(v.name)}</a>`
      : `<strong>${esc(v.name)}</strong>`;
    const tag = v.how === "link"
      ? `<span class="ppr-pill is-ok" title="${esc(`“${day}” on the Day Sheet is linked to this patient.`)}">Linked</span>`
      : v.how === "name"
        ? `<span class="ppr-pill is-info" title="${esc(`The Day Sheet says “${day}” with no Patient ID. Matched by name: check it's the right person.`)}">Matched by name</span>`
        : !v.pid
          ? `<span class="ppr-pill is-warn">${v.many ? `${v.many} patients with this name` : "No Patient ID"}</span>`
          : "";
    const linkBtn = v.res ? ""
      : v.how === "link" ? `<button type="button" class="rc-link" data-vunlink="${esc(v.key)}">Unlink</button>`
      : !v.pid || v.how === "name"
        ? `<button type="button" class="lh-btn is-quiet" data-vlink="${esc(v.key)}">${v.pid ? "Wrong patient?" : "Link to a patient…"}</button>`
        : "";
    return `<li class="ppr-row ppr-vrow${v.res ? " is-sorted" : ""}">
      <div class="ppr-vdate"><b>${esc(shortDay(v.date))}</b><small>${esc(ago(v.date))}</small></div>
      <div class="ppr-main">
        <div class="ppr-vname">${nameEl}${tag}</div>
        ${v.how && v.how !== "id" && day !== v.name ? `<small class="ppr-dayname">On the Day Sheet as “${esc(day)}”</small>` : ""}
        <small>${esc([v.services.join(", "), v.staff.join(" and ")].filter(Boolean).join(" · "))}</small>
        ${v.res ? `<small class="ppr-extra">${esc(RES[v.res.status] || "Sorted")}: “${esc(v.res.note)}” · ${esc(v.res.by)}</small>` : ""}</div>
      <div class="ppr-acts">${v.res
        ? `<button type="button" class="rc-link" data-vundo="${esc(v.key)}">Undo</button>`
        : `${linkBtn}${v.pid ? `<button type="button" class="lh-btn" data-vrecord="${esc(v.pid)}">Record now</button>` : ""}
           <button type="button" class="lh-btn is-quiet" data-vsort="${esc(v.key)}">No record needed…</button>`}</div>
    </li>`;
  }

  function drawScans() {
    if (!st.files) { body.innerHTML = '<div class="skeleton sm"></div>'; return; }
    const want = st.tab === "scans" ? ["todo"] : st.tab === "help" ? ["help"] : DONE;
    const qq = st.q.trim().toLowerCase();
    const dated = !!(st.sFrom || st.sTo);
    const inDates = (f) => (!st.sFrom || f.day >= st.sFrom) && (!st.sTo || f.day <= st.sTo);
    const linkOk = (f) => st.tab !== "scans" || st.sLink === "all" || (st.sLink === "on" ? isLinked(f) : !isLinked(f));
    const list = st.files.filter((f) => want.includes(f.status) && inDates(f) && linkOk(f)
      && (!qq || [f.name, f.folder, f.patientName].join(" ").toLowerCase().includes(qq)));
    // Done: most recently sorted first. Otherwise by the date scanned, the way chosen.
    if (st.tab === "done") list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    else if (st.sort === "new") list.reverse();
    const total = st.files.length;
    const done = st.files.filter((f) => DONE.includes(f.status)).length;
    const days = st.files.map((f) => f.day).filter(Boolean).sort();
    const first = days[0] || "";
    const last = days[days.length - 1] || todayKey();
    const range = st.sFrom && st.sTo ? `between ${niceDay(st.sFrom)} and ${niceDay(st.sTo)}`
      : st.sFrom ? `from ${niceDay(st.sFrom)}` : `up to ${niceDay(st.sTo)}`;
    body.innerHTML = `
      ${st.tab === "scans" ? `<div class="ppr-progress" aria-hidden="true"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></div>
        <p class="muted ppr-sum">${done} of ${total} scan${total === 1 ? "" : "s"} sorted${st.fBusy ? " · Updating…" : ""}</p>` : ""}
      <div class="ppr-tools">
        <input type="search" class="fe-input" data-f="q" placeholder="Filter by file name or patient" value="${esc(st.q)}" />
        <select class="fb-select" data-f="sRange" aria-label="Uploaded">
          <option value="">Uploaded any time</option>
          ${RANGES.map(([k, l]) => { const [a, b] = rangeDates(k);
            return `<option value="${k}"${dated && st.sFrom === a && st.sTo === b ? " selected" : ""}>${esc(l)}</option>`; }).join("")}
          ${dated && !RANGES.some(([k]) => { const [a, b] = rangeDates(k); return st.sFrom === a && st.sTo === b; })
            ? '<option value="custom" selected disabled>Your own dates</option>' : ""}
        </select>
        <label class="ppr-date">Uploaded from <input type="date" class="fe-input" data-f="sFrom" min="${esc(first)}" max="${esc(st.sTo || last)}" value="${esc(st.sFrom)}" /></label>
        <label class="ppr-date">to <input type="date" class="fe-input" data-f="sTo" min="${esc(st.sFrom || first)}" max="${esc(last)}" value="${esc(st.sTo)}" /></label>
        ${dated ? '<button type="button" class="rc-link" data-act="clear-dates">Clear dates</button>' : ""}
        ${st.tab === "scans" ? `<select class="fb-select" data-f="sLink" aria-label="On a patient's file">
          <option value="all"${st.sLink === "all" ? " selected" : ""}>All scans</option>
          <option value="on"${st.sLink === "on" ? " selected" : ""}>Already on a patient's file (${st.files.filter((f) => f.status === "todo" && isLinked(f)).length})</option>
          <option value="off"${st.sLink === "off" ? " selected" : ""}>Not on file yet</option></select>` : ""}
        ${st.tab === "scans" && st.sLink === "on" && list.length
          ? `<button type="button" class="lh-btn is-primary" data-act="bulk-linked">Mark ${Math.min(list.length, 500)} as already on file</button>` : ""}
        ${st.tab !== "done" ? `<select class="fb-select" data-f="sort" aria-label="Sort">
          <option value="old"${st.sort === "old" ? " selected" : ""}>Oldest first</option>
          <option value="new"${st.sort === "new" ? " selected" : ""}>Newest first</option></select>` : ""}
      </div>
      ${dated ? `<p class="muted ppr-sum">${list.length} scan${list.length === 1 ? "" : "s"} uploaded ${esc(range)}</p>` : ""}
      ${list.length ? `<ul class="ppr-list">${list.slice(0, 300).map(rowHtml).join("")}</ul>${
        list.length > 300 ? `<p class="muted ppr-sum">Showing 300 of ${list.length}. Filter to find the others.</p>` : ""}`
        : `<div class="tm-empty">${st.tab === "scans" ? (total ? "Every scan is sorted. 👍" : "No scans in the folder yet.")
          : st.tab === "help" ? "Nothing needs help. 👍" : "Nothing done yet."}</div>`}`;
    loadThumbs(list.slice(0, 60));
  }

  function drawVisits() {
    if (!st.visits) {
      body.innerHTML = '<div class="tm-empty"><strong>Checking the Day Sheet…</strong><br><small class="muted">The first time can take up to a minute.</small></div>';
      return;
    }
    const all = st.visits;
    const staffs = [...new Set(all.flatMap((v) => v.staff))].sort();
    const cats = [...new Set(all.flatMap((v) => v.cats))].sort();
    const qq = st.vq.trim().toLowerCase();
    const list = all.filter((v) => (st.showSorted || !v.res)
      && (st.vStaff === "all" || v.staff.includes(st.vStaff))
      && (st.vCat === "all" || v.cats.includes(st.vCat))
      && (!qq || v.name.toLowerCase().includes(qq)));
    const open = all.filter((v) => !v.res).length;
    const noId = all.filter((v) => !v.res && !v.pid).length;
    const byName = all.filter((v) => !v.res && (v.how === "name" || v.how === "link")).length;
    const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`;
    body.innerHTML = `
      <p class="muted ppr-sum">${open} visit${open === 1 ? "" : "s"} since ${esc(niceDay(st.vMeta.from))} with no treatment record${
        noId ? ` · ${noId} with no Patient ID on the Day Sheet` : ""}${
        byName ? ` · ${byName} matched by name` : ""}. Checking: ${esc((st.vMeta.cats || []).join(", "))}.${
        st.vBusy ? " <strong>Updating…</strong>" : ""}</p>
      <div class="ppr-tools">
        <input type="search" class="fe-input" data-f="vq" placeholder="Filter by patient" value="${esc(st.vq)}" />
        <select class="fb-select" data-f="vStaff" aria-label="Clinician"><option value="all">Any clinician</option>${staffs.map((s) => opt(s, st.vStaff)).join("")}</select>
        <select class="fb-select" data-f="vCat" aria-label="Treatment"><option value="all">Any treatment</option>${cats.map((s) => opt(s, st.vCat)).join("")}</select>
        <label class="fe-check"><input type="checkbox" data-f="showSorted"${st.showSorted ? " checked" : ""} /> Show sorted ones</label>
      </div>
      ${list.length ? `<ul class="ppr-list">${list.slice(0, 400).map(visitHtml).join("")}</ul>${
        list.length > 400 ? `<p class="muted ppr-sum">Showing 400 of ${list.length}. Filter to find the others.</p>` : ""}`
        : `<div class="tm-empty">${open ? "Nothing matches the filters." : "Every visit has a record. 👍"}</div>`}`;
  }

  function draw() {
    Object.assign(keep, { files: st.files, visits: st.visits, vMeta: st.vMeta, thumbs: st.thumbs });
    drawTabs();
    if (st.tab === "visits") drawVisits(); else drawScans();
  }

  /* ---------- Loading ---------- */

  let thumbJob = 0;
  async function loadThumbs(list) {
    const my = ++thumbJob;
    const need = list.map((f) => f.id).filter((id) => !(id in st.thumbs));
    for (let i = 0; i < need.length; i += 12) {
      if (my !== thumbJob || !alive()) return;
      try {
        const r = await callApi({ action: "paper", op: "thumbs", ids: need.slice(i, i + 12) });
        Object.entries(r.thumbs || {}).forEach(([id, url]) => {
          st.thumbs[id] = url || "";
          const el = body.querySelector(`[data-thumb="${CSS.escape(id)}"]`);
          if (el && url) el.innerHTML = `<img src="${esc(url)}" alt="" />`;
        });
      } catch (err) { console.warn("Scan thumbnails:", err); return; }
    }
  }

  async function loadScans(fresh = false) {
    st.fBusy = true;
    if (st.files && alive()) draw();
    try {
      const r = await callApi({ action: "paper", op: "list", fresh });
      if (r.problem) throw new Error(r.problem);
      st.files = (r.files || []).map((f) => ({ ...f, day: f.created ? keyOf(new Date(f.created)) : "" }));
      const a = container.querySelector('[data-role="folder"]');
      if (r.folderUrl && a) {
        a.href = r.folderUrl;
        a.hidden = false;
      }
    } catch (err) {
      console.error("Paper scans:", err);
      st.files = st.files || [];
      if (alive()) showToast(err.message || "Couldn't load the scans.");
    }
    st.fBusy = false;
    if (alive()) draw();
  }
  
  async function loadVisits(fresh = false) {
    st.vBusy = true;
    if (st.visits && alive() && st.tab === "visits") draw();
    try {
      const r = await callApi({ action: "paper", op: "visits", fresh });
      if (r.problem) throw new Error(r.problem);
      st.visits = r.rows || [];
      st.vMeta = r;
    } catch (err) {
      console.error("Visits without a record:", err);
      if (!st.visits) st.visits = [];
      if (alive()) showToast(err.message || "Couldn't check the visits.");
    }
    st.vBusy = false;
    if (alive()) draw();
  }

  /* ---------- A scan: view it and sort it ---------- */

  function openScan(fileId) {
    const f = (st.files || []).find((x) => x.id === fileId);
    if (!f) return;
    warmPatients();
    let chosen = f.patientId ? { id: f.patientId, name: f.patientName, meta: "" } : null;
    let found = [], seq = 0, timer = 0, url = "", rot = 0, saving = false, isImage = false;
    const [label, tone] = STATUS[f.status] || STATUS.todo;

    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ppr-dlg";
    dlg.innerHTML = `
      <div class="ppr-dlg-head">
        <strong>${esc(f.name)}</strong><span class="ppr-pill is-${tone}">${esc(label)}</span>
        <span class="inv-spacer"></span>
        <button type="button" class="lh-btn is-quiet" data-act="next">Next scan →</button>
        <button type="button" class="hx-x" data-act="close" aria-label="Close">×</button>
      </div>
      <div class="ppr-split">
        <div class="ppr-view">
          <div class="ppr-view-tools">
            <button type="button" class="lh-btn is-quiet" data-act="rotate" hidden>Rotate</button>
            <button type="button" class="lh-btn is-quiet" data-act="zoom" hidden>Zoom</button>
            <span class="inv-spacer"></span>
            <a class="rc-link" data-role="drive" target="_blank" rel="noopener" hidden>Open in Drive ↗</a>
          </div>
          <div class="ppr-canvas" data-role="canvas"><div class="skeleton sm"></div></div>
        </div>
        <div class="ppr-side">
          ${f.dupOf && f.status === "todo" ? `<div class="ppr-onfile is-dup"><strong>Looks like a duplicate</strong>
            <span>The same file (same name and size) was already sorted: ${esc(dupText(f.dupOf))}.</span>
            <button type="button" class="lh-btn" data-act="dup">Mark as a duplicate</button></div>` : ""}
          ${isLinked(f) ? `<div class="ppr-onfile"><strong>Already on file</strong>${f.linked.map((l) => `<span>${esc(linkText(l))}${
            l.patientId ? ` · <a href="#/patient/${encodeURIComponent(l.patientId)}" target="_blank" rel="noopener">Open their page ↗</a>` : ""}</span>`).join("")}
            ${f.status === "todo" ? '<button type="button" class="lh-btn" data-act="onfile">Mark as already on file</button>' : ""}</div>` : ""}
          <div class="lh-field"><span class="lh-label">Patient</span><div data-role="pt"></div></div>
          <div data-role="pvisits"></div>
          <label class="lh-field"><span class="lh-label">Date of treatment</span>
            <input type="date" class="fe-input" name="date" max="${todayKey()}" value="${esc(f.recordDate || "")}" /></label>
          <label class="lh-field"><span class="lh-label">Clinician</span>
            <select class="fb-select" name="whoId"><option value="">Loading staff…</option></select>
            <input class="fe-input" name="who" maxlength="80" placeholder="Their name, as written on the paper" hidden />
            <small class="fe-note" data-role="who-note">Products used are recorded under this person.</small></label>
          <div class="lh-field"><span class="lh-label">What is it?</span>
            <div class="ppr-types">${FILE_TYPES.map(([k, l]) =>
              `<button type="button" class="ppr-type" data-type="${k}" aria-pressed="false">${esc(l)}</button>`).join("")}</div></div>
          <div data-role="typebody"></div>
          <p class="lh-error" role="alert" hidden></p>
          <p class="ppr-prog" data-role="prog" aria-live="polite" hidden></p>
          <details class="ppr-more"${f.status === "help" ? " open" : ""}><summary>Not a treatment record, or need help?</summary>
            <label class="lh-field"><span class="lh-label">It isn't a record</span>
              <select class="fb-select" name="reason"><option value="">Choose why…</option>${SKIP_REASONS.map((r) =>
                `<option${r === f.reason ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
            <button type="button" class="lh-btn" data-act="skip">Mark as not a record</button>
            <label class="lh-field"><span class="lh-label">Note</span>
              <textarea class="fe-input" name="note" rows="2" maxlength="500" placeholder="e.g. Can't read the batch number">${
                esc(f.status === "help" ? f.note : "")}</textarea></label>
            <button type="button" class="lh-btn" data-act="help">Ask for help</button>
            ${f.status !== "todo" ? '<button type="button" class="rc-link" data-act="todo">Put it back on the list</button>' : ""}
          </details>
        </div>
      </div>`;

    const $ = (s) => dlg.querySelector(s);
    const err = $(".lh-error");
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const ptHost = $('[data-role="pt"]');
    const pvHost = $('[data-role="pvisits"]');
    const dateIn = $('[name="date"]');

    function drawPt() {
      if (chosen) {
        ptHost.innerHTML = `<div class="bk-chosen"><span><strong>${esc(chosen.name)}</strong>${chosen.meta ? `<small>${esc(chosen.meta)}</small>` : ""}</span>
          <button type="button" class="lh-btn is-quiet" data-act="pt-change">Change</button></div>`;
      } else {
        ptHost.innerHTML = `<input class="fe-input" type="search" data-role="q" placeholder="Name or mobile on the paper" autocomplete="off" />
          <div class="bk-results" data-role="results"></div>`;
      }
      drawPatientVisits();
    }
    function drawResults(msg) {
      const box = $('[data-role="results"]');
      if (!box) return;
      box.innerHTML = msg ? `<p class="bk-none">${esc(msg)}</p>` : found.map((p, i) => `
        <button type="button" class="bk-res" data-pick="${i}"><strong>${esc(p.name)}</strong>
          <small>${esc([formatDobLong(p.dobKey), p.mobile && formatMobile(p.mobile), p.pttId].filter(Boolean).join(" · "))}</small></button>`).join("");
    }
    // That patient's visits with no record: tap one to fill in the date
    function drawPatientVisits() {
      if (!chosen) { pvHost.innerHTML = ""; return; }
      if (!st.visits) { pvHost.innerHTML = '<p class="bk-none">Looking for their visits…</p>'; return; }
      const mine = st.visits.filter((v) => v.pid === chosen.id && !v.res);
      pvHost.innerHTML = mine.length
        ? `<div class="lh-field"><span class="lh-label">Their visits with no record</span><div class="ppr-chips">${mine.slice(0, 8).map((v) =>
            `<button type="button" class="ppr-chip${dateIn.value === v.date ? " is-on" : ""}" data-vdate="${esc(v.date)}">${esc(shortDay(v.date))} · ${
              esc(v.cats.join(", "))}${v.staff.length ? ` · ${esc(v.staff.join(" and "))}` : ""}</button>`).join("")}</div></div>`
        : '<p class="bk-none">No visits without a record for them.</p>';
    }

    // The scan itself
    (async () => {
      const canvas = $('[data-role="canvas"]');
      try {
        const r = await callApi({ action: "paper", op: "file", fileId: f.id });
        if (r.url) { const a = $('[data-role="drive"]'); a.href = r.url; a.hidden = false; }
        if (r.problem) { canvas.innerHTML = `<p class="tm-empty">${esc(r.problem)}</p>`; return; }
        const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
        isImage = r.mime !== "application/pdf";
        canvas.innerHTML = isImage
          ? `<img src="${url}" alt="The scanned record" data-role="img" />`
          : `<iframe src="${url}#view=FitH" title="The scanned record"></iframe>`;
        $('[data-act="rotate"]').hidden = !isImage;
        $('[data-act="zoom"]').hidden = !isImage;
      } catch (ex) {
        console.error("Scan not loaded:", ex);
        canvas.innerHTML = `<p class="tm-empty">${esc(ex.message || "Couldn't load the scan.")}</p>`;
      }
    })();

    // Progress while saving: the button says what's happening, and a line underneath counts the seconds.
    // Everything in the window is locked until it's done, so nothing is clicked twice.
    function startProgress(btn, steps, hint = "") {
      const prog = $('[data-role="prog"]');
      const label = btn ? btn.innerHTML : "";
      const locked = [...dlg.querySelectorAll("button, select, input, textarea")].filter((x) => !x.disabled);
      locked.forEach((x) => { x.disabled = true; });
      dlg.classList.add("is-saving");
      const t0 = Date.now();
      let text = steps[0][1];
      const show = () => {
        if (btn) btn.innerHTML = `<span class="ppr-spin" aria-hidden="true"></span>${esc(text)}`;
        const s = Math.round((Date.now() - t0) / 1000);
        prog.textContent = [hint, s >= 3 ? `${s} s` : ""].filter(Boolean).join(" · ");
        prog.hidden = !prog.textContent;
      };
      if (btn) btn.classList.add("is-busy");
      const timers = steps.slice(1).map(([ms, t]) => setTimeout(() => { text = t; show(); }, ms));
      const tick = setInterval(show, 1000);
      show();
      const stop = () => { timers.forEach(clearTimeout); clearInterval(tick); dlg.classList.remove("is-saving"); };
      return {
        // Success: a tick on the button, then what happens next
        done(msg, next) {
          stop();
          if (btn) { btn.classList.remove("is-busy"); btn.classList.add("is-done"); btn.innerHTML = `✓ ${esc(msg)}`; }
          prog.textContent = next || "";
          prog.hidden = !next;
        },
        // The next step (e.g. "Taking the products off stock…")
        say(t) { timers.forEach(clearTimeout); text = t; show(); },
        // A problem: everything back as it was
        fail() {
          stop();
          locked.forEach((x) => { x.disabled = false; });
          if (btn) { btn.classList.remove("is-busy"); btn.innerHTML = label; }
          prog.hidden = true;
        },
      };
    }
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));

    // What it's filed as
    let rxList = [];
    try { rxList = rxProductList() || []; } catch { rxList = []; }
    const ft = { type: f.filedKind || "treatment", formId: "", consent: "", ctitle: "",
      rx: [{ product: "", custom: !rxList.length, name: "" }] };
    let forms = null;

    /* ---------- Who did the treatment ---------- */
    let staffList = [];
    const whoSel = () => $('[name="whoId"]');
    const whoTxt = () => $('[name="who"]');
    const normName = (s) => String(s || "").toLowerCase().replace(/^dr\.?\s+/, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
    // "Nicole", "Dr Teh", "Nicole Smith" → one staff member, or null if it isn't clear
    function matchStaff(name) {
      const n = normName(name);
      if (!n) return null;
      const exact = staffList.filter((s) => normName(s.name) === n);
      if (exact.length === 1) return exact[0];
      const first = staffList.filter((s) => normName(s.name).split(" ")[0] === n.split(" ")[0]);
      if (first.length === 1) return first[0];
      const part = staffList.filter((s) => normName(s.name).split(" ").includes(n));
      return part.length === 1 ? part[0] : null;
    }
    const whoId = () => (whoSel() && whoSel().value !== OTHER ? whoSel().value : "");
    const whoName = () => {
      const sel = whoSel();
      if (!sel) return "";
      if (sel.value === OTHER) return whoTxt().value.trim();
      const s = staffList.find((x) => x.id === sel.value);
      return s ? s.name : "";
    };
    // The chosen clinician, for their kit. null = you (nobody chosen, or someone not on the staff list)
    const kitOwner = () => {
      const s = staffList.find((x) => x.id === whoId());
      return s ? { uid: s.id, name: s.name, injector: s.injector === true } : null;
    };
    const ownerUid = () => (kitOwner() || { uid: staff.uid }).uid;
    function syncWho() {
      const sel = whoSel();
      // A different clinician: the products field is rebuilt for them (their kit, their kit checks)
      if (typeof cs !== "undefined" && cs.owner !== ownerUid() && !f.productsDone && cs.fields.length) {
        cs.owner = ownerUid();
        cs.counted = {};
        cs.extra = cs.extra.filter((x) => !x.kit);   // checked against the previous clinician's kit
        drawProducts();
        drawType();
      }
      whoTxt().hidden = !sel || sel.value !== OTHER;
      const note = $('[data-role="who-note"]');
      if (note) note.textContent = sel && sel.value === OTHER
        ? "Someone not on the staff list: products used stay recorded under you."
        : "Products used (and their kit) are shown and recorded for this person. Choose them before entering products.";
    }
    function drawWho() {
      const sel = whoSel();
      if (!sel) return;
      const keep = sel.value;
      sel.innerHTML = `<option value="">Choose who did the treatment…</option>${staffList.map((s) =>
        `<option value="${esc(s.id)}">${esc(s.name)}${s.role ? ` · ${esc(s.role)}` : ""}</option>`).join("")}
        <option value="${OTHER}">Someone not on the staff list…</option>`;
      sel.value = keep;
      syncWho();
    }
    // From the Day Sheet ("Nicole", "Dr Teh") or the paper: the first name that matches a staff member
    function setWho(names) {
      const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
      const sel = whoSel();
      if (!sel || !list.length) return;
      const hit = list.map(matchStaff).find(Boolean);
      if (hit) sel.value = hit.id;
      else { sel.value = OTHER; whoTxt().value = list.join(" and "); }
      syncWho();
    }
    loadStaff().then((list) => {
      staffList = list;
      if (!dlg.isConnected) return;
      drawWho();
      // Their visit that day on the Day Sheet says who it was with
      const v = chosen && (st.visits || []).find((x) => x.pid === chosen.id && x.date === dateIn.value);
      if (!whoSel().value && v && v.staff.length) setWho(v.staff);
    }).catch((ex) => {
      console.warn("Staff list not loaded:", ex);
      const sel = whoSel();
      if (sel) { sel.innerHTML = `<option value="${OTHER}" selected>Type the name</option>`; syncWho(); }
    });

    /* ---------- Products used (treatment records) ---------- */
    // The form's own Consumables fields, mounted into prodEl (which moves with the treatment section)
    const cs = { formId: "", fields: [], loading: false, err: "", mode: "stock", force: {}, counted: {}, extra: [], owner: "" };
    const prodEl = document.createElement("div");
    prodEl.className = "ppr-cs-wrap";
    let csSeq = 0, csTimer = 0, lastType = "";
    const csWraps = () => [...prodEl.querySelectorAll("[data-csf]")];
    const csPlanAll = () => (cs.mode === "none" ? [] : csWraps().flatMap((w) => (w.csPlan ? w.csPlan() : [])));
    const csProblemAny = () => { for (const w of csWraps()) { const m = w.csProblem && w.csProblem(); if (m) return m; } return ""; };
    // Inventory's "Starting stock set" date wins; the Paper records setting is only used if it was never set
    const stockFrom = () => (st.baseline && st.baseline.dateKey) || (st.cfg && st.cfg.stockFrom) || "";
    const beforeStock = (date) => !!(stockFrom() && date && date < stockFrom());
    const noteCsSoon = () => { clearTimeout(csTimer); csTimer = setTimeout(noteCs, 250); };

    async function loadProducts(tid) {
      cs.formId = tid; cs.fields = []; cs.err = ""; cs.loading = !!tid; cs.force = {};
      drawProducts();
      if (!tid) { drawType(); return; }
      try {
        const tpl = await getFormTemplate(tid);
        const ver = tpl && tpl.version ? await getFormVersion(tid, tpl.version) : null;
        if (cs.formId !== tid) return;
        cs.fields = ver ? (ver.fields || []).map(normaliseField).filter((x) => x && x.type === "consumables") : [];
      } catch (ex) {
        console.warn("Form products not loaded:", ex);
        if (cs.formId === tid) cs.err = "Couldn't load this form's products. Close and open the scan again.";
      }
      if (cs.formId !== tid || !dlg.isConnected) return;
      cs.loading = false;
      drawProducts();
      drawType();
    }

    function drawProducts() {
      if (f.productsDone) {
        const list = f.products || [];
        prodEl.innerHTML = `<div class="ppr-cs is-done"><div class="ppr-cs-head"><strong>Products used</strong>
          <span class="ppr-pill is-ok">${f.productsTaken ? "Taken off stock" : "Saved"}</span></div>
          ${list.length ? `<ul class="ppr-cs-list">${list.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
            : '<p class="fe-note">Not written on the paper.</p>'}
          ${f.productsFor ? `<small class="fe-note">Recorded as used by <strong>${esc(f.productsFor)}</strong>.</small>` : ""}
          ${f.productsTaken ? (can("inventory.manage")
            ? '<button type="button" class="lh-btn" data-act="fix-products">Correct the amounts</button>'
            : '<small class="fe-note">To change these, ask someone with Manage inventory to correct them.</small>') : ""}</div>`;
        if (f.productsTaken) liveProducts();   // what the record says now, corrections included
        return;
      }
      if (!cs.formId) { prodEl.innerHTML = ""; return; }
      if (cs.loading) { prodEl.innerHTML = '<div class="ppr-cs"><p class="bk-none">Loading the products on this form…</p></div>'; return; }
      if (cs.err) { prodEl.innerHTML = `<div class="ppr-cs"><p class="lh-error">${esc(cs.err)}</p></div>`; return; }
      if (!cs.fields.length) { prodEl.innerHTML = '<p class="fe-note ppr-cs-none">This form has no Products used, so stock isn\'t changed.</p>'; return; }
      prodEl.innerHTML = `<div class="ppr-cs">
        <div class="ppr-cs-head"><strong>Products used</strong>
          <div class="ppr-seg" role="group" aria-label="Products used">
            <button type="button" data-csmode="stock" aria-pressed="${cs.mode === "stock"}">Take off stock</button>
            <button type="button" data-csmode="none" aria-pressed="${cs.mode === "none"}">Not written on the paper</button>
          </div></div>
        <p class="fe-note" data-role="cs-when"></p>
        <div class="ppr-cs-fields"${cs.mode === "none" ? " hidden" : ""}>${cs.fields.map((x) => `<div class="ppr-cs-field" data-csf="${esc(x.id)}">
          ${cs.fields.length > 1 && x.label ? `<span class="lh-label">${esc(x.label)}</span>` : ""}<div data-cs-host></div></div>`).join("")}
          <div data-role="extra"></div></div>
        <div data-role="cs-notes"></div>
      </div>`;
      cs.owner = ownerUid();
      cs.fields.forEach((x) => mountConsumablesField(prodEl.querySelector(`[data-csf="${CSS.escape(x.id)}"]`), x,
        { staff, kitFor: kitOwner(), onChange: noteCsSoon }));
      noteCs();
      drawExtra();
    }

    // The usage record as it is now (the scan's saved summary doesn't change when it's corrected)
    async function liveProducts() {
      try {
        const x = await usageOf(paperSubId(f.id));
        const u = x && await getUsage(x.id);
        const ul = prodEl.querySelector(".ppr-cs-list");
        if (!u || !dlg.isConnected) return;
        const list = csSummary(u.lines.filter((l) => (Number(l.total) || 0) > 0));
        if (ul) ul.innerHTML = list.map((t) => `<li>${esc(t)}</li>`).join("");
        if (u.corrected && !prodEl.querySelector('[data-role="corrected"]')) {
          const c = (u.corrections || [])[u.corrections.length - 1] || {};
          prodEl.querySelector(".ppr-cs-head").insertAdjacentHTML("beforeend",
            `<span class="ppr-pill is-info" data-role="corrected" title="${esc(c.reason || "")}">Corrected${c.by ? ` by ${esc(c.by)}` : ""}</span>`);
        }
      } catch (ex) { console.warn("Products used not loaded:", ex); }
    }

    // Correct what was entered: the difference goes back into (or comes out of) the same kit or batch
    async function fixProducts() {
      if (saving) return;
      let u = null;
      try {
        const x = await usageOf(paperSubId(f.id));
        u = x && await getUsage(x.id);
      } catch (ex) { console.error("Usage not loaded:", ex); }
      if (!u) { showToast("Couldn't find the products used for this scan."); return; }
      const m = await import("./reports.js");
      m.openCorrection(u.id, staff, async () => {
        try {
          const nu = await getUsage(u.id);
          f.products = csSummary(nu.lines.filter((l) => (Number(l.total) || 0) > 0));   // this session's list row
        } catch (ex) { console.warn("Products used not reloaded:", ex); }
        drawProducts();
        draw();
      });
    }
    function syncCsMode() {
      prodEl.querySelectorAll("[data-csmode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.csmode === cs.mode)));
      const box = prodEl.querySelector(".ppr-cs-fields");
      if (box) box.hidden = cs.mode === "none";
    }

    // When it comes off, and anything that was counted since (the count already took it off)
    async function noteCs() {
      const host = prodEl.querySelector('[data-role="cs-notes"]');
      const when = prodEl.querySelector('[data-role="cs-when"]');
      if (!host) return;
      const date = dateIn.value;
      if (when) {
        when.textContent = cs.mode === "none" ? "Nothing is taken off stock. The record notes that no products were written."
          : !date ? "Choose the date of treatment first."
          : beforeStock(date) ? `Before the portal's stock started (${niceDay(stockFrom())}): noted on the record, stock isn't changed.`
          : `Taken off stock as used on ${niceDay(date)}.`;
      }
      const plan = csPlanAll();
      if (!date || !plan.length || beforeStock(date)) { host.innerHTML = ""; return; }
      const my = ++csSeq;
      let counted;
      try { counted = await countsAfter(date, ownerUid()); }
      catch (ex) {
        console.warn("Counts not checked:", ex);
        if (my === csSeq) { cs.counted = null; host.innerHTML = '<p class="ppr-cs-note is-warn">Couldn\'t check the stock counts since then. Check your connection.</p>'; }
        return;
      }
      if (my !== csSeq || !host.isConnected) return;
      cs.counted = counted;
      host.innerHTML = plan.map((l) => {
        const k = `${l.productId}|${l.loc}`;
        const c = counted[k];
        const where = esc(l.loc === "kit" && kitOwner() ? `${kitOwner().name}'s kit` : LOC_NAME[l.loc] || "Stock");
        if (c && c.adjusted) {
          return `<div class="ppr-cs-note"><span><strong>${esc(l.name)}</strong>: ${where} was counted on ${esc(niceDay(c.adjDate))},
            after this treatment, and the shortfall was accepted. The digital count already has it off, so it's noted on the record only.</span>
            <label class="fe-check"><input type="checkbox" data-csforce="${esc(k)}"${cs.force[k] ? " checked" : ""} /> Take it off the digital count anyway</label></div>`;
        }
        if (c && c.open) {
          return `<div class="ppr-cs-note is-info"><span><strong>${esc(l.name)}</strong>: the ${where} count on ${esc(niceDay(c.openDate))}
            came up short. This record explains it: the count is corrected, and if it's being investigated, that closes by itself as "Used before the count".</span></div>`;
        }
        return "";
      }).join("");
    }

    /* ---------- A batch that's no longer in stock ---------- */
    const usedOn = () => dateIn.value;
    const XTAG = { writeoff: "is-info", colleague: "is-info", counted: "", short: "is-warn", unknown: "" };
    function drawExtra() {
      const host = prodEl.querySelector('[data-role="extra"]');
      if (!host) return;
      host.innerHTML = `${cs.extra.map((x, i) => `
        <div class="ppr-cs-note ${XTAG[x.plan]}"><span><strong>${esc(x.p.name)}</strong> · ${esc(x.lot.batch || "No number")}${
          x.lot.expiry ? ` · Exp ${esc(niceDay(x.lot.expiry))}` : ""} · ${x.qty} ${esc(x.kit ? x.p.doseUnit : x.p.stockUnit)}${
          x.dose ? ` (${esc(x.dose)} ${esc(x.p.doseUnit)} given)` : ""}<br><small>${esc(x.text)}</small></span>
          <button type="button" class="lh-btn is-quiet" data-xrm="${i}">Remove</button></div>`).join("")}
        <button type="button" class="hx-add" data-act="x-add">+ A batch that's no longer in stock or in the kit</button>`;
    }
    prodEl.addEventListener("click", (e) => {
      if (saving) return;
      const rm = e.target.closest("[data-xrm]");
      if (rm) { cs.extra.splice(Number(rm.dataset.xrm), 1); drawExtra(); return; }
      if (e.target.closest('[data-act="x-add"]')) addExtraDialog();
    });

    async function addExtraDialog() {
      const date = usedOn();
      if (!date) { fail("Choose the date of treatment first."); return; }
      let ps;
      try { ps = (await productsOnce()).filter((p) => p.active && (p.usage === "storage" || isKitProduct(p))); }
      catch { showToast("Couldn't load the products. Try again."); return; }
      const owner = kitOwner();
      let batches = [];
      const d2 = document.createElement("dialog");
      d2.className = "lh-dialog inv-dlg";
      d2.innerHTML = `
        <form class="lh-form" novalidate>
          <div class="lh-dialog-head"><h3>A batch that's no longer in stock or in the kit</h3>
            <p>Used on ${esc(niceDay(date))}. Enter it as it's written on the paper. The portal checks what happened to that batch.</p></div>
          <label class="lh-field"><span class="lh-label">Product</span>
            <select class="fb-select" name="pid"><option value="">Choose…</option>${ps.map((p) =>
              `<option value="${esc(p.id)}">${esc(p.name)}${isKitProduct(p) ? " (kit)" : ""}</option>`).join("")}</select></label>
          <label class="lh-field" data-role="lotrow" hidden><span class="lh-label">Batch</span><select class="fb-select" name="lot"></select></label>
          <div class="inv-two" data-role="typed" hidden>
            <label class="lh-field"><span class="lh-label">Batch number</span><input class="fe-input" name="batch" maxlength="40" autocomplete="off" /></label>
            <label class="lh-field"><span class="lh-label">Expiry date</span><input class="fe-input" name="expiry" type="date" /></label>
          </div>
          <div class="inv-two">
            <label class="lh-field"><span class="lh-label" data-role="qtylbl">How many</span>
              <input class="fe-input" name="qty" type="number" min="0" max="20" step="1" value="1" inputmode="decimal" /></label>
            <label class="lh-field" data-role="doserow" hidden><span class="lh-label" data-role="doselbl">Amount given</span>
              <input class="fe-input" name="dose" type="number" min="0" step="any" inputmode="decimal" /></label>
          </div>
          <p class="lh-error" role="alert" hidden></p>
          <div class="lh-actions">
            <button type="button" class="lh-btn is-quiet" data-act="x-cancel">Cancel</button>
            <button type="submit" class="lh-btn is-primary">Add</button>
          </div>
        </form>`;
      document.body.appendChild(d2);
      d2.addEventListener("close", () => d2.remove());
      d2.showModal();
      const form = d2.querySelector("form");
      const fe = form.elements;
      const e2 = d2.querySelector(".lh-error");
      const $2 = (r) => d2.querySelector(`[data-role="${r}"]`);
      const prod = () => ps.find((p) => p.id === fe.pid.value) || null;
      const syncTyped = () => { $2("typed").hidden = fe.lot.value !== "typed"; };
      const typedOpt = '<option value="typed">Not listed: type it in</option>';

      fe.pid.addEventListener("change", async () => {
        const p = prod();
        const kit = !!p && isKitProduct(p);
        $2("lotrow").hidden = !p;
        $2("doserow").hidden = !(p && p.doseUnit && !kit);
        if (!p) return;
        $2("qtylbl").textContent = kit ? `${p.doseUnit} used` : `How many (${p.stockUnit})`;
        $2("doselbl").textContent = `Amount given (${p.doseUnit})`;
        fe.qty.step = kit ? "0.5" : "1";
        fe.qty.max = kit ? "1000" : "20";
        fe.lot.innerHTML = "<option>Loading…</option>";
        if (kit) {
          if (!owner) {
            fe.lot.innerHTML = '<option value="">Choose who did the treatment first</option>';
            return;
          }
          try { batches = (await kitBatchesEver(p.id)).filter((k) => k.staffUid === owner.uid && !(k.units > 0)); }
          catch { batches = []; }
          fe.lot.innerHTML = batches.map((k, i) => `<option value="${i}">${esc(`${owner.name}'s kit · ${k.batch || "No number"}${
            k.expiry ? ` · Exp ${niceDay(k.expiry)}` : ""} · none left`)}</option>`).join("") + typedOpt;
        } else {
          try { batches = (await batchesEver(p.id)).filter((l) => l.qty === 0); } catch { batches = []; }
          fe.lot.innerHTML = batches.map((l, i) => `<option value="${i}">${esc(`${l.loc === "jt" ? "JT storage" : "Shelf"} · ${
            l.batch || "No number"}${l.expiry ? ` · Exp ${niceDay(l.expiry)}` : ""} · none left`)}</option>`).join("") + typedOpt;
        }
        syncTyped();
      });
      fe.lot.addEventListener("change", syncTyped);
      d2.querySelector('[data-act="x-cancel"]').addEventListener("click", () => d2.close());

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        e2.hidden = true;
        const p = prod();
        const kit = !!p && isKitProduct(p);
        const qty = kit ? Math.round((Number(fe.qty.value) || 0) * 10) / 10 : parseInt(fe.qty.value, 10);
        const dose = !kit && p && p.doseUnit && fe.dose.value !== "" ? Math.max(0, Number(fe.dose.value) || 0) : 0;
        let lot = null, pick = null;
        try {
          if (!p) throw new Error("Choose the product.");
          if (!(qty > 0)) throw new Error("Enter how much was used.");
          const typed = fe.lot.value === "typed";
          if (kit) {
            if (!owner) throw new Error("Choose who did the treatment first. Kit products come out of their kit.");
            if (!can("inventory.manage")) throw new Error("Recording from someone's kit needs Manage inventory access.");
            const k = typed ? null : batches[Number(fe.lot.value)];
            if (!typed && !k) throw new Error("Choose the batch.");
            pick = typed ? { batch: fe.batch.value.trim(), expiry: fe.expiry.value || "" } : { batch: k.batch, expiry: k.expiry };
            if (typed && (!pick.batch || (p.tracked && !pick.expiry))) throw new Error("Enter the batch number and expiry date from the paper.");
          } else if (typed) {
            const b = fe.batch.value.trim();
            if (p.tracked && (!b || !fe.expiry.value)) throw new Error("Enter the batch number and expiry date from the paper.");
            const all = await batchesEver(p.id);
            lot = all.find((l) => normBatch(l.batch) === normBatch(b) && (!fe.expiry.value || l.expiry === fe.expiry.value))
              || { id: "", loc: "shelf", batch: b, expiry: fe.expiry.value || "", qty: 0 };
            if (lot.qty > 0) throw new Error("That batch still has stock. Choose it in the products list instead.");
          } else {
            lot = batches[Number(fe.lot.value)];
            if (!lot) throw new Error("Choose the batch.");
          }
        } catch (ex) { e2.textContent = ex.message; e2.hidden = false; return; }

        const btn = form.querySelector('[type="submit"]');
        const reset = () => { btn.disabled = false; btn.textContent = "Add"; };
        btn.disabled = true;
        btn.textContent = "Checking…";
        try {
          let why;
          if (kit) {
            why = await whyNotInKit(p, owner, pick.batch, pick.expiry, qty, date);
            if (why.plan === "stop") { e2.textContent = why.text; e2.hidden = false; reset(); return; }
            if (why.plan === "colleague") {
              const o = why.other;
              const yes = await confirmDialog({
                title: `Take it from ${o.staffName}'s kit?`,
                message: `${o.batch || "That batch"} is in ${o.staffName}'s kit (${o.units} ${p.doseUnit}), not ${owner.name}'s. `
                  + `If ${owner.name} used ${o.staffName}'s vial, take it from there. Otherwise it's saved short against ${owner.name}'s kit.`,
                confirmLabel: `Take from ${o.staffName}'s kit`, tone: "info",
              });
              why = yes
                ? { ...why, kitUid: o.staffUid, ref: o.id, text: `Taken from ${o.staffName}'s kit: ${owner.name} used a vial from it.` }
                : { ...why, plan: "short", ref: kitId(owner.uid, p.id, pick.batch, pick.expiry), batch: pick.batch, expiry: pick.expiry,
                    text: `Saved short against ${owner.name}'s kit for the ordering team to check. Nothing goes below zero.` };
            }
            lot = { id: why.ref, loc: "kit", batch: why.batch, expiry: why.expiry, qty: 0 };
          } else {
            why = await whyEmpty(p, lot, qty, date);
          }
          cs.extra.push({ p, lot, qty, dose, ...why });
          d2.close();
          drawExtra();
        } catch (ex) {
          console.error("Batch check failed:", ex);
          e2.textContent = "Couldn't check that batch's history. Try again.";
          e2.hidden = false;
          reset();
        }
      });
    }

    // Ready to save? "" or what to fix
    async function csReady() {
      if (cs.mode === "none") return "";
      const m = csProblemAny();
      if (m) return m;
      if (csPlanAll().length || cs.extra.length) {
        if (!whoId()) return whoSel() && whoSel().value === OTHER
          ? "Products have to be recorded under someone on the staff list. Choose them, or if they've left, choose who's entering it."
          : "Choose who did the treatment, so the products are recorded under them.";
        const kitLine = csPlanAll().find((l) => l.loc === "kit");
        if (kitLine && whoId() !== staff.uid && !can("inventory.manage")) {
          return `${kitLine.name} comes from ${whoName()}'s kit, which needs Manage inventory access. Choose the Shelf or JT storage, or ask ${whoName()} to enter it.`;
        }
      }
      if (!st.cfg) { try { await loadCfg(); } catch { return "Couldn't load the Paper records settings. Try again."; } }
      await noteCs();
      if (csPlanAll().length && !beforeStock(dateIn.value) && cs.counted === null) {
        return "Couldn't check the stock counts since the treatment. Check your connection and try again.";
      }
      return "";
    }
    // What comes off stock, and what's only noted (counted since, or before the stock started)
    function splitPlan(date) {
      const take = [], note = [];
      csPlanAll().forEach((l) => {
        const k = `${l.productId}|${l.loc}`;
        const c = cs.counted && cs.counted[k];
        (beforeStock(date) || (c && c.adjusted && !cs.force[k]) ? note : take).push(l);
      });
      // Batches no longer in stock: a write-off becomes this usage, unexplained ones are saved short, the rest are noted
      if (cs.mode !== "none") {
        const fid = (cs.fields[0] && cs.fields[0].id) || "products";
        cs.extra.forEach((x) => {
          (beforeStock(date) || x.plan === "counted" || x.plan === "unknown" ? note : take).push(extraLine(x, fid));
        });
      }
      return { take, note };
    }
    // 1. Takes it off stock (once), dated the treatment day. 2. Corrects opening counts done since.
    // 3. Tells Apps Script, which checks it's there and puts the usage under the clinician.
    async function saveCs(split, { formName, patientId, patientName, recordDate }) {
      const subId = paperSubId(f.id);
      let corrected = null;
      if (split.take.length) {
        let u = await usageOf(subId);   // a retry never takes it off twice
        if (!u) {
          // Write-offs that were really this treatment: undone first, so their stock is back in the batch to take
          for (const l of split.take.filter((x) => x.extra && x.extra.plan === "writeoff")) {
            const done = await getDoc(doc(db, "inv_moves", `undo__${l.extra.move.id}`));
            if (done.exists()) continue;
            try {
              await undoMove(l.extra.move, `Used on ${patientName} on ${recordDate} instead (paper record)`, staff);
            } catch (ex) {
              throw new Error(ex && ex.code === "permission-denied"
                ? `${l.name}: turning its write-off into usage needs Inventory access. Ask someone with it to press Save products used.`
                : `${l.name}: couldn't undo its write-off. ${(ex && ex.message) || "Try again."}`);
            }
          }
          const res = await runTransaction(db, (tx) => consumeInTx(tx, {
            submissionId: subId, lines: split.take, patientId, patientName, formName, recordDate, staff, paper: true,
          }));
          u = { id: res.usageId, lines: res.lines };
        }
        // What left the Shelf / JT storage, per batch (kit lines aren't in opening counts).
        // A former write-off: counts after it already had it off, so only counts before it are corrected.
        const groups = new Map();   // "" = normal; a move id = counts only up to that write-off
        u.lines.forEach((l, li) => (l.rows || []).forEach((row, ri) => {
          const n = l.kind === "storage" ? Number(row.taken) || 0
            : (l.kind === "vial" || l.kind === "shared") && row.opened ? 1 : 0;
          if (!n || !["shelf", "jt"].includes(row.from)) return;
          const src = split.take[li] && split.take[li].extra;
          const key = src && src.plan === "writeoff" ? src.move.id : "";
          const g = groups.get(key) || { before: key ? src.move.at : null, list: [] };
          g.list.push({ saleId: `${u.id}:${li}:${ri}`, productId: l.productId, date: recordDate, loc: row.from,
            rows: [{ batch: row.batch || "", expiry: row.expiry || "", taken: n }] });
          groups.set(key, g);
        }));
        if (groups.size && recordDate < todayKey()) {
          corrected = { lines: 0, closed: 0, skipped: [], failed: 0 };
          for (const g of groups.values()) {
            const c = await backdateCounts(g.list, staff, { kind: "use", before: g.before })
              .catch((ex) => { console.warn("Counts not corrected:", ex); return null; });
            if (c) { corrected.lines += c.lines; corrected.closed += c.closed; corrected.skipped.push(...c.skipped); }
          }
        }
      }
      const r = await callApi({ action: "paper", op: "products", fileId: f.id, clinicianId: whoId(),
        taken: csSummary(split.take), noted: csSummary(split.note), none: cs.mode === "none" });
      if (r.problem) throw new Error(r.problem);
      if (!r || r.ok !== true || r.status !== "products") throw new Error(notSaved(r));
      Object.assign(f, { productsDone: true, productsTaken: !!r.taken, products: r.products || [], productsAt: r.at || "",
        productsFor: r.clinician || "" });
      return { ...r, corrected };
    }
    // "2 count lines corrected, 1 investigation closed"
    const correctedText = (c) => (c && c.lines
      ? ` · ${c.lines} count line${c.lines === 1 ? "" : "s"} corrected${c.closed ? `, ${c.closed} investigation${c.closed === 1 ? "" : "s"} closed` : ""}`
      : "");

    // Already filed: just the products
    async function saveProducts(btn) {
      if (saving) return;
      err.hidden = true;
      const t = (forms || []).find((x) => x.id === ft.formId);
      if (!t || !cs.fields.length) { fail("Choose the treatment record it was filed as."); return; }
      if (!chosen || chosen.id !== f.patientId) { fail(`This scan was filed for ${f.patientName}. Choose them, or file it again.`); return; }
      if (dateIn.value !== f.recordDate) { fail(`This scan was filed for ${niceDay(f.recordDate)}. Change the date back, or file it again.`); return; }
      const p = await csReady();
      if (p) { fail(p); return; }
      const split = splitPlan(f.recordDate);
      saving = true;
      const prog = startProgress(btn, [[0, split.take.length ? "Taking the products off stock…" : "Saving…"], [8000, "Still working…"]]);
      try {
        const cr = await saveCs(split, { formName: t.name, patientId: f.patientId, patientName: f.patientName, recordDate: f.recordDate });
        const msg = (split.take.length ? `${split.take.length} product${split.take.length === 1 ? "" : "s"} taken off stock`
          : "Products used saved") + correctedText(cr.corrected);
        prog.done("Saved", `${msg}. Opening the next scan…`);
        showToast(msg);
        draw();
        await pause(900);
        goNext();
      } catch (ex) {
        console.error("Products not saved:", ex);
        prog.fail();
        fail(ex.message || "Couldn't save the products. Try again.");
      } finally {
        saving = false;
      }
    }
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));

    function typeBody() {
      if (ft.type === "treatment") {
        const tx = (forms || []).filter((t) => t.category === "treatment").sort(byName);
        const filedTx = f.status === "filed" && f.filedKind === "treatment";
        const needProducts = filedTx && !f.productsDone && cs.fields.length > 0 && cs.formId === ft.formId;
        const action = f.productsTaken
          ? '<small class="fe-note">Products were taken off stock for this scan, so it can\'t be filed again here.</small>'
          : needProducts
            ? `<button type="button" class="lh-btn is-primary ppr-wide" data-act="stock">Save products used</button>
               <small class="fe-note">The scan is already filed. This saves what was used${cs.mode === "stock" ? " and takes it off stock" : ""}.</small>`
            : '<button type="button" class="lh-btn is-primary ppr-wide" data-act="file">File the scan as the record</button>';
        return `<label class="lh-field"><span class="lh-label">Which treatment record</span>
            <select class="fb-select" name="form" data-ft="formId"${f.productsTaken ? " disabled" : ""}>${!forms ? '<option value="">Loading forms…</option>'
              : `<option value="">Choose…</option>${tx.map((t) => `<option value="${esc(t.id)}"${t.id === ft.formId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}`}</select></label>
          <div data-role="prod-slot"></div>
          ${action}
          ${f.productsTaken ? "" : `<small class="fe-note">Or type it in instead:</small>
          <div class="ppr-formrow"><button type="button" class="lh-btn" data-act="openform">Enter it on the form ↗</button>
            <button type="button" class="lh-btn" data-act="entered">Mark as entered</button></div>
          <small class="fe-note">On the form, set the record date to the date of treatment and add the products there, then press Mark as entered.</small>`}`;
      }
      if (ft.type === "consent") {
        const cs = (forms || []).filter((t) => t.category === "consent").sort(byName);
        return `<label class="lh-field"><span class="lh-label">Which consent</span>
            <select class="fb-select" data-ft="consent">${!forms ? '<option value="">Loading forms…</option>'
              : `<option value="">Choose…</option>${cs.map((t) => `<option${t.name === ft.consent ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
                <option value="${OTHER}"${ft.consent === OTHER ? " selected" : ""}>Not on the list: type it…</option>`}</select></label>
          ${ft.consent === OTHER ? `<input class="fe-input" data-ft="ctitle" maxlength="150" value="${esc(ft.ctitle)}"
            placeholder="e.g. Wrinkle Relaxer consent" aria-label="Consent name" />` : ""}
          <button type="button" class="lh-btn is-primary ppr-wide" data-act="file">File as a consent</button>`;
      }
      if (ft.type === "rx") {
        return `<div class="lh-field"><span class="lh-label">What was prescribed</span>
            ${ft.rx.map((it, i) => `<div class="ppr-rx" data-rx="${i}">
              ${rxList.length ? `<select class="fb-select" data-rxf="product" aria-label="Product"><option value="">Choose…</option>${
                rxList.map((n) => `<option${!it.custom && n === it.product ? " selected" : ""}>${esc(n)}</option>`).join("")}
                <option value="${OTHER}"${it.custom ? " selected" : ""}>Not on the list: type it…</option></select>` : ""}
              ${it.custom ? `<input class="fe-input" data-rxf="name" maxlength="150" value="${esc(it.name)}" placeholder="Product name" aria-label="Product name" />` : ""}
              ${ft.rx.length > 1 ? `<button type="button" class="hx-x" data-act="rx-x" aria-label="Remove">×</button>` : ""}</div>`).join("")}
            <button type="button" class="rc-link" data-act="rx-add">+ Add another</button></div>
          <button type="button" class="lh-btn is-primary ppr-wide" data-act="file">File as a prescription</button>`;
      }
      return `<p class="fe-note">It shows under Billing on their page, with the scan. Stock isn't changed.</p>
        <button type="button" class="lh-btn is-primary ppr-wide" data-act="file">File as a billing sheet</button>`;
    }
    function drawType() {
      dlg.querySelectorAll("[data-type]").forEach((b) => {
        const on = b.dataset.type === ft.type;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", String(on));
      });
      $('[data-role="typebody"]').innerHTML = typeBody();
      const slot = $('[data-role="prod-slot"]');
      if (slot) slot.replaceWith(prodEl);   // the same element: what's been typed stays
      if (ft.type === "treatment" && lastType && lastType !== "treatment") drawProducts();   // back from another type
      lastType = ft.type;
    }
    listPublishedForms().then((list) => {
      forms = list || [];
      // Filed as a treatment record before: that form, so its products can be saved
      if (ft.type === "treatment" && !ft.formId && f.filedKind === "treatment" && f.filedTitle) {
        const hit = forms.find((x) => x.category === "treatment" && x.name === f.filedTitle);
        if (hit) { ft.formId = hit.id; loadProducts(hit.id); }
      }
      if (f.productsDone) drawProducts();
      if (dlg.isConnected) drawType();
    })
      .catch(() => { forms = []; if (dlg.isConnected) drawType(); showToast("Couldn't load the forms."); });

    async function fileAs(btn) {
      if (saving) return;
      err.hidden = true;
      if (!chosen) { fail("Choose the patient."); return; }
      if (!dateIn.value) { fail("Choose the date on the paper."); return; }
      const body = { action: "paper", op: "fileAs", fileId: f.id, as: ft.type, patientId: chosen.id, recordDate: dateIn.value,
        clinician: whoName(), note: $('[name="note"]').value };
      let formName = "";
      if (ft.type === "treatment") {
        const t = (forms || []).find((x) => x.id === ft.formId);
        if (!t) { fail("Choose which treatment record it is."); return; }
        body.title = formName = t.name;
      } else if (ft.type === "consent") {
        body.title = (ft.consent === OTHER ? ft.ctitle : ft.consent).trim();
        if (!body.title) { fail("Choose which consent it is."); return; }
      } else if (ft.type === "rx") {
        body.items = ft.rx.map((it) => ({ product: String(it.custom ? it.name : it.product).trim(), custom: !!it.custom }))
          .filter((it) => it.product);
        if (!body.items.length) { fail("Choose what was prescribed."); return; }
      }
      // Products used: checked before anything is saved
      const withCs = ft.type === "treatment" && cs.formId === ft.formId && cs.fields.length > 0;
      let split = { take: [], note: [] };
      if (withCs) {
        if (cs.loading) { fail("The form's products are still loading. Try again in a moment."); return; }
        const p = await csReady();
        if (p) { fail(p); return; }
        split = splitPlan(dateIn.value);
      }
      saving = true;
      const pic = ft.type === "billing" || ft.type === "rx";
      const prog = startProgress(btn, pic
        ? [[0, "Saving…"], [1500, "Making a picture of the scan…"], [5000, `Adding it to ${chosen.name}'s page…`],
           [12000, "Still working. Big scans take a little longer…"]]
        : [[0, "Filing…"], [2500, `Adding it to ${chosen.name}'s page…`], [10000, "Still working…"]],
        pic ? "Usually 3 to 8 seconds. Keep this window open." : "");
      let ok = false;
      try {
        const r = await callApi(body);
        if (r.problem) { prog.fail(); fail(r.problem); return; }
        if (!r || r.ok !== true || r.status !== "filed") { console.warn("Filing reply:", r); prog.fail(); fail(notSaved(r)); return; }
        ok = true;
        if (r.name) {
          f.name = r.name;                                          // renamed in Drive
          const head = dlg.querySelector(".ppr-dlg-head strong");
          if (head) head.textContent = r.name;
        }
        Object.assign(f, { status: "filed", filedKind: ft.type, filedTitle: (r.filedAs && r.filedAs.title) || "", reason: "",
          note: body.note.trim(), patientId: r.patientId, patientName: r.patientName, recordDate: r.recordDate, by: r.by || "", at: r.at || "",
          productsDone: false, productsTaken: false, products: [] });
        if (ft.type === "treatment" && st.visits) {
          st.visits = st.visits.filter((v) => !(v.pid === r.patientId && v.date <= r.recordDate && r.recordDate <= addDays(v.date, 3)));
        }
        draw();
        if (withCs) {
          prog.say(split.take.length ? "Taking the products off stock…" : "Saving the products used…");
          try {
            const cr = await saveCs(split, { formName, patientId: r.patientId, patientName: r.patientName, recordDate: r.recordDate });
            split.corrected = cr.corrected;
          } catch (ex) {
            console.error("Products not saved:", ex);
            prog.fail();
            drawType();   // shows Save products used
            fail(`It's filed, but the products used weren't saved (${ex.message || "try again"}). Press Save products used to try again.`);
            draw();
            return;
          }
          draw();
        }
        const taken = split.take.filter((l) => !(l.extra && l.extra.plan === "short")).length;
        const where = `Filed under ${FILE_WHERE[ft.type]} on ${r.patientName}'s page${
          taken ? `, ${taken} product${taken === 1 ? "" : "s"} taken off stock` : ""}${correctedText(split.corrected)}`;
        prog.done("Filed", `${where}. Opening the next scan…`);
        showToast(where);
        await pause(900);   // long enough to see it worked
        goNext();
      } catch (ex) {
        console.error("Scan not filed:", ex);
        if (!ok) prog.fail();
        fail(ex.message || "Couldn't file it. Try again.");
      } finally {
        saving = false;
      }
    }

    if (!st.visits) loadVisits().then(() => { if (dlg.open) drawPatientVisits(); });

    // The next scan still to sort (after this one, in the list's order)
    const nextFile = () => {
      const list = (st.files || []).filter((x) => x.status === "todo" && x.id !== f.id
        && (!st.sFrom || x.day >= st.sFrom) && (!st.sTo || x.day <= st.sTo));
      const at = (st.files || []).indexOf(f);
      return list.find((x) => st.files.indexOf(x) > at) || list[0] || null;
    };
    const goNext = () => {
      const n = nextFile();
      dlg.close();
      if (n) openScan(n.id); else showToast("That was the last scan to sort. 👍");
    };

    async function mark(status, extra = {}, btn = null) {
      if (saving) return;
      err.hidden = true;
      saving = true;
      const prog = startProgress(btn, [[0, "Saving…"], [6000, "Still working…"]]);
      let ok = false;
      try {
        const r = await callApi({ action: "paper", op: "mark", fileId: f.id, status, ...extra });
        if (r.problem) { prog.fail(); fail(r.problem); return; }
        if (!r || r.ok !== true || r.status !== status) { console.warn("Save reply:", r); prog.fail(); fail(notSaved(r)); return; }
        ok = true;
        if (r.name) f.name = r.name;   // Drive name restored after unfiling
        Object.assign(f, { status, filedKind: "", filedTitle: "", note: extra.note || "", reason: extra.reason || "", patientId: r.patientId || "",
          patientName: r.patientName || "", recordDate: r.recordDate || "", by: r.by || "", at: r.at || "" });
        // An entered scan counts as that visit's record
        if (status === "entered" && st.visits) {
          st.visits = st.visits.filter((v) => !(v.pid === r.patientId && v.date <= r.recordDate && r.recordDate <= addDays(v.date, 3)));
        }
        const msg = { entered: "Marked as entered", skip: "Marked as not a record", help: "Flagged for help", todo: "Back on the list" }[status];
        prog.done("Saved", status === "todo" ? msg : `${msg}. Opening the next scan…`);
        showToast(msg);
        draw();
        await pause(700);
        if (status === "todo") dlg.close(); else goNext();
      } catch (ex) {
        console.error("Scan not saved:", ex);
        if (!ok) prog.fail();
        fail(ex.message || "Couldn't save. Try again.");
      } finally {
        saving = false;
      }
    }

    dlg.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.ft === "formId") { ft.formId = t.value; loadProducts(t.value); return; }
      if (t.dataset.csforce) { cs.force[t.dataset.csforce] = t.checked; return; }
      if (t.name === "whoId") { syncWho(); if (t.value === OTHER) whoTxt().focus(); return; }
      if (t.dataset.ft === "consent") { ft.consent = t.value; drawType(); return; }
      if (t.dataset.rxf === "product") {
        const it = ft.rx[Number(t.closest("[data-rx]").dataset.rx)];
        if (t.value === OTHER) Object.assign(it, { custom: true, product: "" });
        else Object.assign(it, { custom: false, product: t.value });
        drawType();
      }
    });
    dlg.addEventListener("input", (e) => {
      err.hidden = true;
      if (e.target.dataset.ft === "ctitle") { ft.ctitle = e.target.value; return; }
      if (e.target.dataset.rxf === "name") { ft.rx[Number(e.target.closest("[data-rx]").dataset.rx)].name = e.target.value; return; }
      if (e.target.dataset.role !== "q") return;
      clearTimeout(timer);
      const t = e.target.value;
      if (t.trim().length < 2) { found = []; drawResults(""); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        drawResults("Searching…");
        try {
          const r = await searchPatients(t, 8);
          if (my !== seq) return;
          found = r;
          drawResults(r.length ? "" : "No patients match. Check the spelling, or try their mobile.");
        } catch (ex) {
          if (my !== seq) return;
          console.warn("Patient search failed:", ex);
          drawResults("Couldn't search. Try again.");
        }
      }, 250);
    });
    dateIn.addEventListener("change", () => { drawPatientVisits(); noteCsSoon(); });

    dlg.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        const p = found[Number(pick.dataset.pick)];
        chosen = { id: p.id, name: p.name, meta: [formatDobLong(p.dobKey), p.mobile && formatMobile(p.mobile)].filter(Boolean).join(" · ") };
        drawPt();
        return;
      }
      const vd = e.target.closest("[data-vdate]");
      if (vd) {
        dateIn.value = vd.dataset.vdate;
        const v = (st.visits || []).find((x) => x.pid === (chosen && chosen.id) && x.date === vd.dataset.vdate);
        if (v && whoSel() && !whoSel().value) setWho(v.staff);   // the clinician from the Day Sheet
        noteCsSoon();
        drawPatientVisits();
        return;
      }
      const csm = e.target.closest("[data-csmode]");
      if (csm) { cs.mode = csm.dataset.csmode; syncCsMode(); noteCsSoon(); drawType(); return; }
      const ty = e.target.closest("[data-type]");
      if (ty) { ft.type = ty.dataset.type; err.hidden = true; drawType(); return; }
      const actEl = e.target.closest("[data-act]");
      const act = actEl && actEl.dataset.act;
      if (!act || saving) return;
      if (act === "close") { dlg.close(); return; }
      if (act === "file") { fileAs(actEl); return; }
      if (act === "stock") { saveProducts(actEl); return; }
      if (act === "fix-products") { fixProducts(); return; }
      if (act === "rx-add") { ft.rx.push({ product: "", custom: !rxList.length, name: "" }); drawType(); return; }
      if (act === "rx-x") { ft.rx.splice(Number(e.target.closest("[data-rx]").dataset.rx), 1); drawType(); return; }
      if (act === "next") { goNext(); return; }
      if (act === "pt-change") { chosen = null; found = []; drawPt(); $('[data-role="q"]').focus(); return; }
      if (act === "rotate") {
        rot = (rot + 90) % 360;
        const img = $('[data-role="img"]');
        if (img) img.style.transform = `rotate(${rot}deg)`;
        return;
      }
      if (act === "zoom") { $('[data-role="canvas"]').classList.toggle("is-zoom"); return; }
      if (act === "openform") {
        const tid = $('[name="form"]').value;
        if (!chosen) { fail("Choose the patient first."); return; }
        if (!tid) { fail("Choose the form."); return; }
        window.open(`${location.pathname}${location.search}#/fill/${encodeURIComponent(chosen.id)}/${encodeURIComponent(tid)}`, "_blank");
        return;
      }
      if (act === "entered") {
        if (!chosen) { fail("Choose the patient."); return; }
        if (!dateIn.value) { fail("Choose the date of the treatment."); return; }
        mark("entered", { patientId: chosen.id, recordDate: dateIn.value }, actEl);
        return;
      }
      if (act === "skip") mark("skip", { reason: $('[name="reason"]').value, note: $('[name="note"]').value }, actEl);
      if (act === "onfile") mark("skip", { reason: "Already on the patient's file", note: linkText(f.linked[0]) }, actEl);
      if (act === "help") mark("help", { note: $('[name="note"]').value }, actEl);
      if (act === "todo") mark("todo", {}, actEl);
      if (act === "dup") mark("skip", { reason: "Duplicate scan", note: "Same file as: " + dupText(f.dupOf) }, actEl);
    });
    dlg.addEventListener("cancel", (e) => { if (saving) e.preventDefault(); });
    dlg.addEventListener("close", () => { if (url) URL.revokeObjectURL(url); dlg.remove(); });
    document.body.appendChild(dlg);
    drawPt();
    drawType();
    dlg.showModal();
    const first = $('[data-role="q"]');
    if (first) first.focus();
  }

  // Every scan in the list that an older record already links to: sorted in one go
  async function bulkLinked(btn) {
    const qq = st.q.trim().toLowerCase();
    const ids = st.files.filter((f) => f.status === "todo" && isLinked(f)
      && (!st.sFrom || f.day >= st.sFrom) && (!st.sTo || f.day <= st.sTo)
      && (!qq || [f.name, f.folder, f.patientName].join(" ").toLowerCase().includes(qq)))
      .map((f) => f.id).slice(0, 500);
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `Mark ${ids.length} scan${ids.length === 1 ? "" : "s"} as already on file?`,
      message: "Each one is the same Google Drive file an existing treatment record or consent links to. They move to Done, and can be put back at any time.",
      confirmLabel: "Mark as already on file", tone: "info",
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const r = await callApi({ action: "paper", op: "markLinked", ids });
      const done = new Set(r.done || []);
      st.files.forEach((f) => {
        if (!done.has(f.id)) return;
        const l = f.linked[0];
        Object.assign(f, { status: "skip", reason: "Already on the patient's file", note: linkText(l),
          patientId: l.patientId || "", patientName: l.patientName || "", recordDate: l.date || "", by: r.by || "", at: r.at || "" });
      });
      showToast(`${done.size} scan${done.size === 1 ? "" : "s"} marked as already on file`);
      draw();
    } catch (ex) {
      showToast(ex.message || "Couldn't save. Try again.");
      btn.disabled = false;
    }
  }
  /* ---------- Visits: link a Day Sheet name to a patient ---------- */

  function linkVisit(key) {
    const v = (st.visits || []).find((x) => x.key === key);
    if (!v) return;
    const day = v.dayName || v.name;
    warmPatients();
    let found = [], seq = 0, timer = 0, busy = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<div class="lh-form">
      <div class="lh-dialog-head"><h3>Link to a patient</h3>
        <p>The Day Sheet says <strong>“${esc(day)}”</strong>${v.ptt ? "" : " with no Patient ID"}. Choose who it is.
          Every visit under this name is linked, and future Day Sheet uploads fill in their Patient ID.</p></div>
      <input class="fe-input" type="search" data-role="q" autocomplete="off" placeholder="Name or mobile"
        value="${esc(day.replace(/[\s\-–—:|/]*\(?\b(staff|stf|employee)\b\)?\.?/gi, " ").replace(/\s+/g, " ").trim())}" />
      <div class="bk-results" data-role="results"></div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button></div></div>`;
    document.body.appendChild(dlg);
    const q = dlg.querySelector('[data-role="q"]');
    const box = dlg.querySelector('[data-role="results"]');
    const err = dlg.querySelector(".lh-error");
    const show = (msg) => {
      box.innerHTML = msg ? `<p class="bk-none">${esc(msg)}</p>` : found.map((p, i) => `
        <button type="button" class="bk-res" data-pick="${i}"><strong>${esc(p.name)}</strong>
          <small>${esc([formatDobLong(p.dobKey), p.mobile && formatMobile(p.mobile), p.pttId].filter(Boolean).join(" · "))}</small></button>`).join("");
    };
    const search = () => {
      clearTimeout(timer);
      const t = q.value.trim();
      if (t.length < 2) { found = []; show("Type at least 2 letters."); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        show("Searching…");
        try {
          const r = await searchPatients(t, 8);
          if (my !== seq) return;
          found = r;
          show(r.length ? "" : "No patients match. Try their surname or mobile.");
        } catch (ex) {
          if (my === seq) show("Couldn't search. Try again.");
        }
      }, 250);
    };
    q.addEventListener("input", search);
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.addEventListener("close", () => dlg.remove());
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-pick]");
      const p = b && found[Number(b.dataset.pick)];
      if (!p || busy) return;
      busy = true;
      err.hidden = true;
      box.querySelectorAll("button").forEach((x) => { x.disabled = true; });
      b.querySelector("small").textContent = "Linking…";
      try {
        const r = await callApi({ action: "paper", op: "linkName", name: day, patientId: p.id });
        if (r.problem) throw new Error(r.problem);
        // Every visit under this name, straight away (the full list is worked out again below)
        (st.visits || []).forEach((x) => {
          if ((x.dayName || x.name) === day && (!x.pid || x.how === "name")) Object.assign(x, { pid: p.id, name: p.name, how: "link", many: 0 });
        });
        dlg.close();
        showToast(`“${day}” is linked to ${p.name}`);
        draw();
        loadVisits();
      } catch (ex) {
        busy = false;
        err.textContent = ex.message || "Couldn't link. Try again.";
        err.hidden = false;
        show();
      }
    });
    dlg.showModal();
    q.focus();
    q.select();
    search();
  }

  async function unlinkVisit(key) {
    const v = (st.visits || []).find((x) => x.key === key);
    if (!v) return;
    const day = v.dayName || v.name;
    const ok = await confirmDialog({
      title: `Unlink “${day}”?`,
      message: `It won't be linked to ${v.name} any more, here or in future Day Sheet uploads. Patient IDs already filled in on the Day Sheet stay as they are.`,
      confirmLabel: "Unlink", tone: "warning",
    });
    if (!ok) return;
    try {
      const r = await callApi({ action: "paper", op: "linkName", name: day, remove: true });
      if (r.problem) throw new Error(r.problem);
      showToast("Unlinked");
      loadVisits();
    } catch (ex) { showToast(ex.message || "Couldn't unlink. Try again."); }
  }
  /* ---------- Visits: no record needed ---------- */

  function sortVisit(key) {
    const v = (st.visits || []).find((x) => x.key === key);
    if (!v) return;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>${esc(v.name)}</h3><p>${esc(niceDay(v.date))} · ${esc(v.services.join(", "))}</p></div>
      <div class="lh-field"><span class="lh-label">Why isn't there a treatment record?</span>
        ${Object.entries(RES).map(([k, l]) => `<label class="fe-check"><input type="radio" name="why" value="${k}" /> ${esc(l)}</label>`).join("")}</div>
      <label class="lh-field"><span class="lh-label">Note</span>
        <textarea class="fe-input" name="note" rows="2" maxlength="500" placeholder="e.g. Consult only, decided not to go ahead"></textarea></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button></div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => dlg.remove());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const why = (form.querySelector('[name="why"]:checked') || {}).value;
      const note = form.elements.note.value.trim();
      if (!why) { err.textContent = "Choose why."; err.hidden = false; return; }
      if (!note) { err.textContent = "Add a note saying what happened."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const r = await callApi({ action: "paper", op: "resolve", key, status: why, note });
        if (r.problem) { err.textContent = r.problem; err.hidden = false; btn.disabled = false; return; }
        v.res = r.res;
        dlg.close();
        showToast("Saved");
        draw();
      } catch (ex) {
        err.textContent = ex.message || "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.showModal();
  }

  async function undoVisit(key) {
    const v = (st.visits || []).find((x) => x.key === key);
    if (!v) return;
    try {
      await callApi({ action: "paper", op: "resolve", key, status: "clear" });
      v.res = null;
      showToast("Back on the list");
      draw();
    } catch (ex) { showToast(ex.message || "Couldn't undo. Try again."); }
  }

  /* ---------- Settings (Admins) ---------- */

  async function openSettings() {
    let s;
    try { s = await callApi({ action: "paper", op: "settings" }); }
    catch (ex) { showToast(ex.message || "Couldn't load the settings."); return; }
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Visits without a record</h3><p>Which Day Sheet visits should have a treatment record.</p></div>
      <label class="lh-field"><span class="lh-label">Check visits from</span><input type="date" class="fe-input" name="from" value="${esc(s.from)}" /></label>
      <label class="lh-field"><span class="lh-label">Take products off stock for treatments from</span>
        <input type="date" class="fe-input" name="stockFrom" value="${esc(s.stockFrom || "")}" />
        <small class="fe-note">The day the portal's stock counts started. Paper records from before this note the products but never change stock.</small></label>
      <div class="lh-field"><span class="lh-label">Treatments that need a record</span>
        <div class="ppr-cats">${(s.allCats || []).map((c) => `<label class="fe-check"><input type="checkbox" name="cat" value="${esc(c)}"${
          (s.cats || []).includes(c) ? " checked" : ""} /> ${esc(c)}</label>`).join("")}</div></div>
      <label class="lh-field"><span class="lh-label">Services that don't need one (any service containing these words)</span>
        <input class="fe-input" name="skip" value="${esc((s.skip || []).join(", "))}" placeholder="Review, Consult" /></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button></div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => dlg.remove());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const r = await callApi({
          action: "paper", op: "saveSettings", from: form.elements.from.value, stockFrom: form.elements.stockFrom.value,
          cats: [...form.querySelectorAll('[name="cat"]:checked')].map((x) => x.value),
          skip: form.elements.skip.value.split(",").map((x) => x.trim()).filter(Boolean),
        });
        if (r.problem) { err.textContent = r.problem; err.hidden = false; btn.disabled = false; return; }
        dlg.close();
        cfgJob = null;
        loadCfg().catch(() => {});
        showToast("Saved. Checking the visits again…");
        st.visits = null;
        draw();
        loadVisits(true);
      } catch (ex) {
        err.textContent = ex.message || "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.showModal();
  }

  /* ---------- Events ---------- */

  container.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { st.tab = tab.dataset.tab; draw(); return; }
    const op = e.target.closest("[data-open]");
    if (op) { openScan(op.dataset.open); return; }
    const rec = e.target.closest("[data-vrecord]");
    if (rec) { window.open(`${location.pathname}${location.search}#/patient/${encodeURIComponent(rec.dataset.vrecord)}`, "_blank"); return; }
    const vs = e.target.closest("[data-vsort]");
    if (vs) { sortVisit(vs.dataset.vsort); return; }
    const vu = e.target.closest("[data-vundo]");
    if (vu) { undoVisit(vu.dataset.vundo); return; }
    const vl = e.target.closest("[data-vlink]");
    if (vl) { linkVisit(vl.dataset.vlink); return; }
    const vn = e.target.closest("[data-vunlink]");
    if (vn) { unlinkVisit(vn.dataset.vunlink); return; }
    const act = e.target.closest("[data-act]");
    if (act && act.dataset.act === "refresh") {
      loadScans(true); loadVisits(true);
      return;
    }
    if (act && act.dataset.act === "settings") openSettings();
    if (act && act.dataset.act === "clear-dates") { st.sFrom = ""; st.sTo = ""; draw(); }
    if (act && act.dataset.act === "bulk-linked") bulkLinked(act);
  });

  let qt = 0;
  body.addEventListener("input", (e) => {
    const k = e.target.dataset.f;
    if (k !== "q" && k !== "vq") return;
    st[k] = e.target.value;
    clearTimeout(qt);
    qt = setTimeout(() => {
      const pos = e.target.selectionStart;
      draw();
      const el = body.querySelector(`[data-f="${k}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not a text box */ } }
    }, 200);
  });
  body.addEventListener("change", (e) => {
    const k = e.target.dataset.f;
    if (k === "vStaff" || k === "vCat" || k === "sort" || k === "sLink") { st[k] = e.target.value; draw(); }
    if (k === "sRange") {
      [st.sFrom, st.sTo] = rangeDates(e.target.value);
      if (st.sFrom) st.sort = "new";   // recent scans: newest first
      draw();
      return;
    }
    if (k === "sFrom" || k === "sTo") {
      st[k] = e.target.value;
      if (st.sFrom && st.sTo && st.sFrom > st.sTo) st[k === "sFrom" ? "sTo" : "sFrom"] = e.target.value;   // dates the wrong way round
      draw();
    }
    if (k === "showSorted") { st.showSorted = e.target.checked; draw(); }
  });

  draw();
  loadScans();
  loadVisits();
  loadCfg().catch(() => {});
  getBaseline().then((b) => { st.baseline = b; }).catch(() => {});
}

