// Refunds: a patient asks for money back. The request lists what's refunded and how it's paid back,
// and each person gets their step (and a task on their dashboard) until it's all done.
// Routes: #/refunds[/mine|open|done] · #/refunds/new[/<patientId>] · #/refunds/r/<id> · #/refunds/settings
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, onSnapshot, writeBatch, runTransaction,
  serverTimestamp, arrayUnion, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";
import { can, isAdmin } from "./perms.js";
import { findPatientsById, getPatient } from "./patients.js";
import { searchPatients, warmPatients } from "./patient-list.js";
import { loadServicePrices, priceLookup } from "./service-prices.js";
import {
  listProducts, appointmentsBetween, dayKey, listLotsForProduct, listSuppliers, recordPatientReturn, createRequest,
  isKitProduct, isSharedProduct, batchName, reqNumber,
} from "./inventory-api.js";

/* ===================== Helpers ===================== */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  plus: ic('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  refund: ic('<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/><path d="M12 8v8M14.5 9.5c-.4-.8-1.3-1.2-2.5-1.2-1.4 0-2.4.7-2.4 1.7 0 2.5 5 1.3 5 3.9 0 1.1-1.1 1.8-2.6 1.8-1.3 0-2.3-.5-2.7-1.4"/>'),
  service: ic('<path d="M12 3l1.9 4.6 5.1.7-3.8 3.4 1.1 5L12 14.3l-4.3 2.4 1.1-5L5 8.3l5.1-.7z"/>'),
  package: ic('<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>'),
  product: ic('<path d="M9 2h6v3H9z"/><path d="M8 5h8l1 4v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9z"/><line x1="7" y1="12" x2="17" y2="12"/>'),
  cash: ic('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>'),
  bank: ic('<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><line x1="3" y1="21" x2="21" y2="21"/>'),
  credit: ic('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>'),
  check: ic('<polyline points="20 6 9 17 4 12"/>'),
  lock: ic('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  search: ic('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.6" y2="16.6"/>'),
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? round2(n) : 0; };
const money = (n) => `$${round2(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const refundNo = (r) => `RF-${String((r && r.id) || "").slice(0, 6).toUpperCase()}`;
const myUid = () => (auth.currentUser && auth.currentUser.uid) || "";
const boss = () => isAdmin() || can("refunds.manage");
const canSeeBank = () => isAdmin() || can("refunds.bank");
const keyPlus = (n) => dayKey(new Date(Date.now() + n * 864e5));
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v ? new Date(v) : null);
const ms = (v) => { const d = toDate(v); return d && !isNaN(d) ? d.getTime() : 0; };
const niceDay = (d) => (d && !isNaN(d) ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const niceKey = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? niceDay(new Date(+m[1], +m[2] - 1, +m[3])) : ""; };
const initials = (n) => String(n || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
const hue = (s) => [...String(s || "")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (n) => `<span class="tk-av" style="--h:${hue(n)}">${esc(initials(n))}</span>`;
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const nameOf = (staff) => String((staff && staff.name) || "").slice(0, 120);

const KINDS = {
  service: { label: "Service", icon: I.service, blurb: "A treatment they paid for" },
  package: { label: "Package", icon: I.package, blurb: "A package or course of treatments" },
  product: { label: "Product", icon: I.product, blurb: "Something they bought to take home" },
};
const METHODS = {
  cash: { label: "Cash", icon: I.cash, blurb: () => "Given at the desk" },
  bank: { label: "Bank transfer", icon: I.bank, blurb: (s) => `${s.bankName || "Dr Joanna"} transfers it` },
  credit: { label: "Account credit", icon: I.credit, blurb: () => "Added to their Timely account" },
};
const REASONS = {
  service: ["Not happy with the result", "Reaction or side effect", "Treatment wasn't done", "Charged twice or by mistake", "Other"],
  package: ["Changed their mind", "Medical reason", "Moving away", "Charged twice or by mistake", "Other"],
  product: ["Changed their mind", "Wrong product bought", "Reaction to the product", "Other"],
};
const RETURNED = [["unopened", "Returned unopened"], ["opened", "Returned opened"], ["no", "Not returned"]];

// What happens to each returned product (the onsite team's step)
const HOW = {
  shelf: { label: "Back into stock", done: "Back in stock" },
  tester: { label: "Keep as a tester", done: "Kept as a tester" },
  bin: { label: "Throw it out", done: "Thrown out" },
  supplier: { label: "Back to the supplier", done: "Set aside for the supplier" },
};
const howOpts = (it) => (it.condition === "faulty" ? ["supplier", "tester", "bin"]
  : it.returned === "unopened" ? ["shelf", "tester", "bin"] : ["tester", "bin"]);
const defaultHow = (it) => (it.condition === "faulty" ? (it.action === "supplier" ? "supplier" : "tester")
  : it.returned === "unopened" ? "shelf" : "tester");
const stockItems = (items) => (items || []).map((it, idx) => ({ it, idx })).filter(({ it }) => it.kind === "product" && it.returned !== "no");

/* ===================== Staff and settings ===================== */
let staffCache = null;
async function staffList() {
  if (staffCache && Date.now() - staffCache.at < 10 * 60000) return staffCache.list;
  const res = await callApi({ action: "staffList" });
  staffCache = { at: Date.now(), list: (res.staff || []).map((s) => ({ id: String(s.id || ""), name: String(s.name || "") })).filter((s) => s.id) };
  return staffCache.list;
}

const SET_DEFAULT = { bankId: "", bankName: "", timelyId: "", timelyName: "", cashId: "", cashName: "",
  onsiteId: "", onsiteName: "", approverId: "", approverName: "", approveOver: null, recordBank: true };
async function loadSettings() {
  try {
    const s = await getDoc(doc(db, "refund_settings", "config"));
    return { ...SET_DEFAULT, ...(s.exists() ? s.data() : {}) };
  } catch (err) {
    console.warn("Refund settings not read:", err);
    return { ...SET_DEFAULT };
  }
}

/* ===================== The steps ===================== */
const waiting = (steps, s) => s.key !== "approve" && steps.some((x) => x.key === "approve" && !x.done);

function stockLines(items) {
  return (items || []).filter((i) => i.kind === "product" && i.returned !== "no").map((i) => {
    const what = i.condition === "faulty"
      ? (i.action === "supplier" ? "set it aside to send back to the supplier for a replacement" : "keep it as a tester")
      : i.returned === "unopened" ? "put it back on the Shelf" : "it's opened, so it can't be resold: keep it as a tester or throw it out";
    return `${i.qty > 1 ? `${i.qty} × ` : ""}${i.name}: ${what}`;
  });
}

function buildSteps(r, set) {
  const out = [];
  const add = (key, title, id, name, need, help) => out.push({ key, title, whoId: id || "", whoName: name || "",
    need, help, done: false, value: "", taskId: "", dueDate: "" });
  const timely = [set.timelyId, set.timelyName || "Timely"];
  if (set.approveOver !== null && set.approveOver !== "" && r.total > Number(set.approveOver)) {
    add("approve", `Approve the refund (over ${money(set.approveOver)})`, set.approverId, set.approverName || "An Admin", "none",
      "Check the details. Approving starts everyone else's steps.");
  }
  if (r.method === "cash" && !r.cashGiven) {
    add("cash", "Give the cash refund", set.cashId, set.cashName, "amount", "Give the cash to the patient, then enter how much was given.");
  }
  if (r.method === "bank") {
    add("bank", "Transfer the refund", set.bankId, set.bankName || "Dr Joanna", "ref",
      "Transfer the money to the patient's account (details on the right), then enter the transfer reference.");
  }
  if (r.method === "credit") {
    add("credit", "Add the account credit in Timely", ...timely, "invoice", "Add the credit to the patient's Timely account, then enter the invoice number.");
  }
  if (r.method === "cash" || (r.method === "bank" && set.recordBank !== false)) {
    add("timely", "Record the refund in Timely", ...timely, "invoice", "Record the refund on the patient's Timely account, then enter the invoice number.");
  }
  if (r.items.some((i) => i.kind === "product")) {
    add("void", "Void the product sale in Timely", ...timely, "invoice", "Void the product on the original sale in Timely, then enter the invoice number.");
  }
  if (r.items.some((i) => i.kind === "product" && i.returned !== "no")) {
    add("stock", "Deal with the returned products", set.onsiteId, set.onsiteName, "none", "");
  }
  return out;
}

// Who can act on the refund right now (used by the Firestore rules and the Needs me tab)
function recompute(steps) {
  const open = steps.filter((s) => !s.done);
  const live = open.filter((s) => !waiting(steps, s));
  return { stepsOpen: open.length, ownerIds: [...new Set(live.map((s) => s.whoId).filter(Boolean))], openToAll: live.some((s) => !s.whoId) };
}
const canDo = (s) => boss() || s.whoId === myUid() || (!s.whoId && s.key !== "approve");
const nextFor = (r) => (r.steps || []).find((s) => !s.done && !waiting(r.steps, s)) || null;

function taskData(base, refundId, s, by) {
  return {
    patientId: String(base.patientId || ""), patientName: String(base.patientName || ""),
    taskText: `Refund ${refundNo({ id: refundId })} · ${s.title} · ${money(base.total)}. Open Refunds to finish it.`.slice(0, 500),
    dueDate: s.dueDate, status: "Open", assignedToId: s.whoId || "", assignedToName: s.whoId ? s.whoName : "",
    createdAt: serverTimestamp(), createdBy: by, createdByUid: myUid(), notes: [],
    history: [{ at: new Date().toISOString(), by, what: "Added from a refund request" }],
  };
}

const valueText = (s) => (!s.value ? "" : s.need === "ref" ? `Reference ${s.value}` : s.need === "invoice" ? `Invoice ${s.value}`
  : s.need === "amount" ? `${money(s.value)} given` : "");
const methodText = (r) => (r.method === "cash" ? (r.cashGiven ? `Cash, ${money(r.cashAmount)} already given` : "Cash, not given yet")
  : r.method === "bank" ? `Bank transfer to the account ending ${r.bankLast3 || "…"}` : "Account credit in Timely");
function itemSub(it) {
  if (it.kind !== "product") {
    return [it.reason, it.kind === "package" && it.visitsAll ? `${it.visitsLeft} of ${it.visitsAll} visits left` : "",
      it.invoiceId && `Invoice ${it.invoiceId}`, it.note].filter(Boolean).join(" · ");
  }
  const cond = it.condition === "faulty" ? `Faulty · ${it.action === "supplier" ? "back to the supplier" : "keep as a tester"}` : it.reason;
  const back = (RETURNED.find(([k]) => k === it.returned) || [, ""])[1];
  return [cond, back, it.invoiceId && `Invoice ${it.invoiceId}`, it.note].filter(Boolean).join(" · ");
}
// How a package refund was worked out (saved on the refund, so later price changes don't alter it)
function calcHtml(it) {
  const c = it && it.calc;
  if (!c || !c.method) return "";
  const byHand = c.worked !== null && c.worked !== undefined && round2(c.worked) !== round2(it.amount)
    ? ` · worked out as ${money(c.worked)}, changed by hand` : "";
  if (c.method === "share") return `<small class="rf-calc">Paid ${money(c.paid)} · a share for the visits left${byHand}</small>`;
  return `<small class="rf-calc">Paid ${money(c.paid)}${(c.used || []).map((u) =>
    ` · less ${u.used} × ${esc(u.service)} at ${money(u.price)}`).join("")}${byHand}</small>`;
}

/* ===================== Page ===================== */
export async function mountRefunds(container, { param = "", staff = null } = {}) {
  const parts = String(param || "").split("/").filter(Boolean);
  if (parts[0] === "new") return mountForm(container, { staff, patientId: parts[1] ? decodeURIComponent(parts[1]) : "" });
  if (parts[0] === "r" && parts[1]) return mountRefund(container, { id: decodeURIComponent(parts[1]), staff });
  if (parts[0] === "settings") return mountSettings(container, { staff });
  if (parts[0] === "report") return mountReport(container);
  if (parts[0] === "emails") return mountEmails(container);
  return mountList(container, { tab: parts[0] || "mine" });
}

/* ===================== The list ===================== */
const canReport = () => boss() || can("menu.reports");
const tabsHtml = (tab) => `<nav class="rf-tabs" aria-label="Refunds">${[["mine", "Needs me"], ["open", "All open"], ["done", "Completed"],
  ...(canReport() ? [["report", "Reports"]] : [])].map(([k, l]) =>
  `<a href="#/refunds/${k}" class="${tab === k ? "is-on" : ""}"${tab === k ? ' aria-current="page"' : ""}>${l}<em data-n="${k}"></em></a>`).join("")}</nav>`;
const headHtml = () => `<div class="fb-head">
    <div><h2>Refunds</h2><p class="muted">Every refund request, and the steps still to do.</p></div>
    <div class="fb-head-actions">
      ${boss() ? `<a class="btn-ghost" href="#/refunds/emails"><span>Patient emails</span></a>
        <a class="btn-ghost" href="#/refunds/settings">${I.gear}<span>Settings</span></a>` : ""}
      <a class="btn-primary" href="#/refunds/new">${I.plus}<span>New refund request</span></a>
    </div>
  </div>`;

async function mountList(container, { tab }) {
  if (!["mine", "open", "done"].includes(tab)) tab = "mine";
  const root = document.createElement("section");
  root.className = "page wide rf";
  root.innerHTML = `
    ${headHtml()}
    ${tabsHtml(tab)}
    <div class="rf-list" data-role="list"><div class="skeleton" style="height:86px"></div><div class="skeleton" style="height:86px"></div></div>`;
  container.replaceChildren(root);
  const list = root.querySelector('[data-role="list"]');
  const col = collection(db, "refunds");
  const get = (q) => getDocs(q).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })));
  try {
    const [mine, open, done] = await Promise.all([
      get(query(col, where("ownerIds", "array-contains", myUid()))).then((l) => l.filter((r) => r.status === "open")),
      get(query(col, where("status", "==", "open"))),
      tab === "done" ? get(query(col, where("status", "in", ["done", "cancelled"]))) : [],
    ]);
    if (!root.isConnected) return;
    const nMine = root.querySelector('[data-n="mine"]');
    nMine.textContent = mine.length || "";
    nMine.classList.toggle("is-hot", mine.length > 0);
    root.querySelector('[data-n="open"]').textContent = open.length || "";
    const show = tab === "done"
      ? done.sort((a, b) => ms(b.completedAt || b.cancelledAt || b.updatedAt) - ms(a.completedAt || a.cancelledAt || a.updatedAt)).slice(0, 100)
      : (tab === "mine" ? mine : open).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    list.innerHTML = show.length ? show.map(cardHtml).join("")
      : `<div class="rf-empty"><strong>${tab === "mine" ? "Nothing needs you" : tab === "open" ? "No open refunds" : "No completed refunds yet"}</strong>${
        tab === "mine" ? "Refund steps given to you show here." : "New requests are made in Task Manager → Refund request."}</div>`;
  } catch (err) {
    console.error("Refunds not loaded:", err);
    list.innerHTML = `<div class="rf-empty"><strong>Couldn't load refunds</strong>${err.code === "permission-denied"
      ? "The Firestore rules for refunds haven't been added yet." : "Check your connection and try again."}</div>`;
  }
}

function cardHtml(r) {
  const steps = r.steps || [];
  const doneN = steps.filter((s) => s.done).length;
  const nx = nextFor(r);
  const late = r.status === "open" && steps.some((s) => !s.done && !waiting(steps, s) && s.dueDate && s.dueDate < dayKey());
  const pct = steps.length ? Math.round((doneN / steps.length) * 100) : 0;
  return `<a class="rf-card is-${esc(r.status)}${late ? " is-late" : ""}" href="#/refunds/r/${encodeURIComponent(r.id)}">
    <span class="rf-card-ic is-${esc(r.method)}">${(METHODS[r.method] || {}).icon || I.refund}</span>
    <span class="rf-card-main">
      <span class="rf-card-top"><strong>${esc(r.patientName)}</strong><span class="rf-no">${refundNo(r)}</span></span>
      <small>${esc((r.items || []).map((i) => i.name).join(", "))}</small>
      <span class="rf-card-next">${r.status === "open" ? (nx ? `${esc(nx.title)} · ${esc(nx.whoName || "Anyone")}` : "")
        : r.status === "done" ? "Completed" : "Cancelled"}</span>
    </span>
    <span class="rf-card-side">
      <b>${money(r.total)}</b><small>${esc((METHODS[r.method] || {}).label || "")}</small>
      <span class="rf-prog"><i style="width:${pct}%"></i></span>
      <small>${doneN} of ${steps.length} done${late ? ' · <em class="is-late">Overdue</em>' : ""}</small>
    </span>
  </a>`;
}

/* ===================== The request form ===================== */
// The same search as the Patient List: name in any order, part words, email or mobile,
// plus an exact patient ID
async function findPatientsAny(q) {
  const t = q.trim();
  const [byName, byId] = await Promise.all([
    searchPatients(t, 12).catch((err) => { console.warn("Patient search failed:", err); return []; }),
    findPatientsById(t).catch(() => []),
  ]);
  const m = new Map();
  [...byId, ...byName].forEach((p) => { if (p && p.id && !p.mergedInto) m.set(p.id, p); });
  return [...m.values()].slice(0, 12);
}
async function salesFor(p) {
  try {
    const snap = await getDocs(query(collection(db, "inv_sales"), where("patientName", "==", p.name)));
    return snap.docs.flatMap((d) => {
      const x = d.data() || {};
      if (x.voided) return [];
      const date = String(x.apptDate || x.dateKey || "");
      return (Array.isArray(x.lines) ? x.lines : []).map((l) => ({
        key: `${d.id}|${l.productId}`, saleId: d.id, invoiceId: String(x.invoiceId || ""), date,
        productId: String(l.productId || ""), name: String(l.name || "Product"), qty: Number(l.qty) || 1,
        fee: l.fee === null || l.fee === undefined ? null : Number(l.fee),
      }));
    }).sort((a, b) => b.date.localeCompare(a.date));
  } catch (err) { console.warn("Purchases not read:", err); return []; }
}

async function visitsFor(p) {
  try {
    const list = await appointmentsBetween(keyPlus(-120), dayKey());
    const ids = new Set([p.id, p.pttId].filter(Boolean).map((s) => String(s).toLowerCase()));
    const nm = normName(p.name);
    const seen = new Set();
    const out = [];
    list.filter((a) => (ids.has(String(a.patientId || "").toLowerCase()) || (nm && normName(a.patientName) === nm))
      && !/cancel|no.?show|resched/i.test(String(a.status || "")))
      .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
      .forEach((a) => (a.services || []).forEach((s) => {
        const k = `${a.dateKey}|${s}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ name: String(s), date: a.dateKey, staff: String(a.staff || "") });
      }));
    return out.slice(0, 40);
  } catch (err) { console.warn("Visits not read:", err); return []; }
}

// Paid services (SALES RECORD) and packages (Customer Packages), from Refunds.gs
async function sourcesFor(p) {
  try {
    const res = await callApi({ action: "refunds", op: "sources", patientId: p.id });
    if (!res || res.ok === false) throw new Error((res && res.error) || "No answer");
    return { services: res.services || [], packages: res.packages || [], problem: res.problem || "",
      problems: res.problems || [], salesAt: res.salesAt || "", packagesAt: res.packagesAt || "" };
  } catch (err) {
    console.warn("Services and packages not read:", err);
    return { services: [], packages: [], problem: "Their invoices and packages couldn't be loaded.", problems: [], salesAt: "", packagesAt: "" };
  }
}
// What's already in one of their refunds (not cancelled): source key → refund number
async function refundedKeys(p) {
  try {
    const snap = await getDocs(query(collection(db, "refunds"), where("patientId", "==", p.id)));
    const m = new Map();
    snap.docs.forEach((d) => {
      const r = d.data() || {};
      if (r.status === "cancelled") return;
      (r.items || []).forEach((it) => { if (it && it.srcKey) m.set(it.srcKey, refundNo({ id: d.id })); });
    });
    return m;
  } catch (err) { console.warn("Earlier refunds not read:", err); return new Map(); }
}

async function mountForm(container, { staff, patientId }) {
  const root = document.createElement("section");
  root.className = "page wide rf";
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
  container.replaceChildren(root);
  warmPatients();   // the Patient List's search: ready by the time someone types
  const [set, prices] = await Promise.all([
    loadSettings(),
    loadServicePrices().catch((err) => { console.warn("Service prices not read:", err); return []; }),
  ]);
  if (!root.isConnected) return;
  const lookupPrice = priceLookup(prices);   // Settings → Services and pricing

  const blank = () => ({ name: "", amount: "", reason: "", note: "", srcKey: "", invoiceId: "", date: "", left: 0, of: 0, paid: 0,
    method: "", used: [], auto: false });
  const st = { patient: null, hits: [], sales: null, visits: null, src: null, prodList: null, tried: false,
    kinds: { service: false, package: false, product: false }, services: [], packages: [], products: [],
    total: null, method: "", cashGiven: "", cashAmount: "", bank: { name: "", bsb: "", acct: "" }, note: "",
    notifyPatient: true, notifyStaff: true };

  root.innerHTML = `
    <a class="tm-back" href="#/tasks/new">${I.back}<span>Task Manager</span></a>
    <div class="rf-formhead"><h2>Refund request</h2>
      <p class="muted">Fill this in with the patient. The right people are given a step to finish it.</p></div>
    <div class="rf-form">
      <div class="rf-form-main" data-role="main"></div>
      <aside class="rf-sum"><div class="rf-sum-card">
        <h3>Summary</h3>
        <div data-role="sum-pt"></div>
        <ul class="rf-sum-items" data-role="sum-items"></ul>
        <label class="rf-total"><span>Total to refund</span>
          <span class="rf-money is-big"><em>$</em><input class="fe-input" inputmode="decimal" data-role="total" placeholder="0.00"></span></label>
        <small class="rf-total-note" data-role="total-note"></small>
        <div data-role="sum-method"></div>
        <div class="rf-next" data-role="sum-next"></div>
        <ul class="rf-probs" data-role="probs" hidden></ul>
        <button type="button" class="btn-primary rf-send" data-act="send">Send refund request</button>
      </div></aside>
    </div>`;
  const main = root.querySelector('[data-role="main"]');
  const sum = root.querySelector(".rf-sum");

  const setPath = (path, v) => { const k = path.split("."); let o = st; while (k.length > 1) o = o[k.shift()]; o[k[0]] = v; };
  const fmtBsb = (d) => (d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d);
  const seg = (path, opts, cur) => `<div class="rf-seg" role="group">${opts.map(([v, l]) =>
    `<button type="button" class="${cur === v ? "is-on" : ""}" data-act="set" data-f="${path}" data-v="${v}" aria-pressed="${cur === v}">${esc(l)}</button>`).join("")}</div>`;
  const reasonSelect = (path, kind, cur) => `<select class="fb-select" data-f="${path}"><option value="">Choose…</option>${REASONS[kind].map((x) =>
    `<option${x === cur ? " selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
  const sec = (n, title, body, sub = "") => `<section class="rf-sec"><header><span class="rf-n">${n}</span>
    <div><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}</div></header>${body}</section>`;
  const moneyIn = (path, val, ph = "0.00") => `<span class="rf-money"><em>$</em><input class="fe-input" inputmode="decimal" data-f="${path}" value="${esc(val)}" placeholder="${ph}"></span>`;

  function patientHtml() {
    if (st.patient) {
      const p = st.patient;
      return `<div class="rf-chosen">${avatar(p.name)}<span><strong>${esc(p.name)}</strong>
        <small>${esc([p.pttId, p.mobile, p.email].filter(Boolean).join(" · "))}</small></span>
        <button type="button" class="lh-btn is-quiet" data-act="unpick">Change</button></div>`;
    }
    return `<label class="rf-search">${I.search}<input class="fe-input" type="search" data-role="pq" placeholder="Search by name, mobile or patient ID"
      autocomplete="off" aria-label="Find the patient"></label><div class="rf-hits" data-role="presults"></div>`;
  }

  // Package refunds: what they paid, less each used visit at its regular price (Settings → Services and pricing),
  // or a share of what they paid (visits left ÷ all visits)
  const usedRowsOf = (x) => (x.lines || []).filter((l) => l.used > 0).map((l) => {
    const sp = lookupPrice(l.service);
    return { service: l.service, used: l.used, price: sp ? round2(sp.price).toFixed(2) : "", known: !!sp };
  });
  function pkgCalc(s) {
    const paid = round2(s.paid);
    if (s.method === "share") return { ok: true, usedTotal: null, refund: s.of > 0 ? round2((paid * s.left) / s.of) : 0, over: false };
    const missing = (s.used || []).filter((u) => String(u.price ?? "").trim() === "").length;
    const usedTotal = round2((s.used || []).reduce((a, u) => a + u.used * num(u.price), 0));
    return { ok: !missing, missing, usedTotal, refund: round2(Math.max(0, paid - usedTotal)), over: !missing && usedTotal > paid };
  }
  const pkgSave = (s) => {
    const c = pkgCalc(s);
    return {
      method: s.method, paid: round2(s.paid),
      used: s.method === "regular" ? (s.used || []).map((u) => ({ service: String(u.service || "").slice(0, 150), used: Number(u.used) || 0, price: num(u.price) })) : [],
      usedTotal: c.usedTotal === null ? null : round2(c.usedTotal), worked: c.ok ? c.refund : null,
    };
  };
  function pkgSumHtml(s, i) {
    const c = pkgCalc(s);
    const rows = [["Paid", money(s.paid)],
      s.method === "share" ? [`Share for ${s.left} of ${s.of} visits left`, money(c.refund)]
        : ["Used visits at the regular price", c.ok ? `− ${money(c.usedTotal)}` : "Price needed"]];
    return `<dl class="rf-pk-sum">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}
        <div class="is-total"><dt>Refund</dt><dd>${c.ok ? money(c.refund) : "—"}</dd></div></dl>
      ${c.over ? "<p class=\"rf-warn\">The visits used cost more than they paid, so there's nothing to refund at the regular price.</p>" : ""}
      ${!s.auto ? `<p class="rf-hint">The amount to refund was changed by hand.
        <button type="button" class="rf-linkbtn" data-act="pkgauto" data-i="${i}">Use ${c.ok ? money(c.refund) : "the worked-out amount"}</button></p>` : ""}`;
  }
  function pkgHtml(s, i) {
    if (!s.srcKey || !s.method) return "";
    const used = s.used || [];
    const table = used.length ? `<table class="rf-pk-used"><thead><tr><th>Used</th><th>Regular price</th><th>Total</th></tr></thead><tbody>${used.map((u, j) => `<tr>
        <td>${u.used} × ${esc(u.service || "Visit")}${u.known ? "" : '<small class="rf-pk-need">Not in Services and pricing</small>'}</td>
        <td>${moneyIn(`packages.${i}.used.${j}.price`, u.price)}</td>
        <td class="rf-pk-num" data-role="pkline-${i}-${j}">${String(u.price ?? "").trim() === "" ? "—" : money(u.used * num(u.price))}</td></tr>`).join("")}</tbody></table>`
      : '<p class="rf-hint">No visits used yet.</p>';
    return `<div class="rf-pk">
      <div class="rf-q"><span>Work out the refund</span>${seg(`packages.${i}.method`,
        [["regular", "Used visits at the regular price"], ["share", "Share of what they paid"]], s.method)}</div>
      ${s.method === "regular" ? table : ""}
      <div data-role="pkgsum-${i}">${pkgSumHtml(s, i)}</div>
      ${s.method === "regular" && used.some((u) => !u.known)
        ? '<p class="rf-hint">Add the missing services in Settings → Services and pricing, so their prices fill in next time.</p>' : ""}
    </div>`;
  }
  // A price or the method changed: the refund is worked out again (unless the amount was typed by hand)
  function recalcPkg(i) {
    const s = st.packages[i];
    if (!s || !s.srcKey || !s.method) return;
    const c = pkgCalc(s);
    if (s.auto) s.amount = c.ok ? c.refund.toFixed(2) : "";
    const a = main.querySelector(`[data-f="packages.${i}.amount"]`);
    if (a && document.activeElement !== a) a.value = s.amount;
    (s.used || []).forEach((u, j) => {
      const td = main.querySelector(`[data-role="pkline-${i}-${j}"]`);
      if (td) td.textContent = String(u.price ?? "").trim() === "" ? "—" : money(u.used * num(u.price));
    });
    const box = main.querySelector(`[data-role="pkgsum-${i}"]`);
    if (box) box.innerHTML = pkgSumHtml(s, i);
  }

  // Their paid services and packages from Timely: ticking one fills in a row
  const srcFor = (list) => (st.src && st.src[list]) || [];
  function srcRow(list, x, on) {
    const was = st.src.was && st.src.was.get(x.key);
    const tag = (t, grey) => `<span class="rf-tag${grey ? " is-grey" : ""}">${esc(t)}</span>`;
    let sub, right, off, dim = false, tags = "";
    if (list === "services") {
      off = !(x.net > 0);
      sub = [niceKey(x.date), x.staff, x.invoiceId && `Invoice ${x.invoiceId}`, x.qty > 1 && `${x.qty} ×`].filter(Boolean).join(" · ");
      if (off) tags += tag("Paid with a package: refund the package", true);
      else if (x.net < x.paid) tags += tag(x.byPackage ? "Part paid with a package" : "Discounted", true);
      right = `<b>${money(x.net)}${x.net < x.paid ? `<small>was ${money(x.paid)}</small>` : ""}</b>`;
    } else {
      off = !(x.left > 0);
      dim = !!x.expired;
      sub = [`${x.left} of ${x.left + x.used} visits left`, x.expires ? `${x.expired ? "Expired" : "Expires"} ${niceKey(x.expires)}` : "No expiry",
        `Paid ${money(x.paid)}${x.paidFrom === "price" ? " (list price)" : ""}`, x.invoiceId && `Invoice ${x.invoiceId}`].filter(Boolean).join(" · ");
      if (off) tags += tag("All used", true); else if (x.expired) tags += tag("Expired", true);
      const wc = pkgCalc({ method: "regular", paid: x.paid, left: x.left, of: x.left + x.used, used: usedRowsOf(x) });
      right = wc.ok ? `<b>${money(wc.refund)}<small>to refund</small></b>` : "<b>—<small>price needed</small></b>";
    }
    if (was) tags += tag(`Already in ${was}`);
    const lines = list === "packages" && (x.lines || []).length > 1
      ? `<small>${esc(x.lines.map((l) => `${l.service || "Visit"}: ${l.left} left`).join(" · "))}</small>` : "";
    return `<li><label class="rf-buy${on ? " is-on" : ""}${off ? " is-off" : dim ? " is-dim" : ""}">
      <input type="checkbox" data-act="src" data-list="${list}" data-key="${esc(x.key)}"${on ? " checked" : ""}${off && !on ? " disabled" : ""}>
      <span><strong>${esc(x.name)}${tags}</strong><small>${esc(sub)}</small>${lines}</span>${right}</label></li>`;
  }
  function srcHtml(list) {
    if (!st.patient) return "";
    const what = list === "services" ? "paid services" : "packages";
    if (st.src === null) return `<p class="muted rf-wait">Loading their ${what} from Timely…</p>`;
    const rows = srcFor(list);
    const on = new Set(st[list].map((s) => s.srcKey).filter(Boolean));
    const probs = [st.src.problem, ...(st.src.problems || [])].filter(Boolean).map((p) => `<p class="rf-warn">${esc(p)}</p>`).join("");
    const at = new Date(list === "services" ? st.src.salesAt : st.src.packagesAt);
    const when = !isNaN(at) ? `<p class="rf-srcwhen">From the Timely upload on ${esc(niceDay(at))}. Anything newer isn't here yet: type it in below.</p>` : "";
    if (!rows.length) {
      return `${probs}<p class="rf-hint">${list === "services" ? "No paid services found on their Timely invoices in the last 18 months."
        : "No packages found for them in Timely."} Type it in below.</p>`;
    }
    return `${probs}<p class="rf-hint">Tick what's being refunded. ${list === "services" ? "Amounts are what they paid, after any discount."
      : "The refund is what they paid, less the visits already used at their regular price."}</p>
      <ul class="rf-buys">${rows.slice(0, 40).map((x) => srcRow(list, x, on.has(x.key))).join("")}</ul>${when}`;
  }
  const refreshSrc = () => ["services", "packages"].forEach((l) => {
    const w = main.querySelector(`[data-role="src-${l}"]`);
    if (w) w.innerHTML = srcHtml(l);
  });
  const fromHtml = (list, s) => (!s.srcKey ? "" : `<p class="rf-from">${esc(list === "services"
    ? [`From invoice ${s.invoiceId}`, niceKey(s.date)].filter(Boolean).join(" · ")
    : [`${s.left} of ${s.of} visits left`, `paid ${money(s.paid)}`, s.invoiceId && `invoice ${s.invoiceId}`].filter(Boolean).join(" · "))}</p>`);
  // Another patient chosen: rows ticked from the last one's lists go
  const dropSrc = () => ["services", "packages"].forEach((l) => {
    st[l] = st[l].filter((s) => !s.srcKey);
    if (!st[l].length && st.kinds[l === "services" ? "service" : "package"]) st[l].push(blank());
  });

  const itemHtml = (list, label, s, i) => `<div class="rf-item">
    <div class="rf-item-head"><strong>${KINDS[list === "services" ? "service" : "package"].icon}${label}${st[list].length > 1 ? ` ${i + 1}` : ""}</strong>
      ${st[list].length > 1 ? `<button type="button" class="rf-x" data-act="rm" data-list="${list}" data-i="${i}" aria-label="Remove">×</button>` : ""}</div>
    ${fromHtml(list, s)}
    <div class="rf-grid">
      <label class="rf-f rf-span2"><span>Which ${label.toLowerCase()}?</span><input class="fe-input" data-f="${list}.${i}.name" value="${esc(s.name)}"
        ${list === "services" ? 'list="rf-visits"' : ""} autocomplete="off" placeholder="${list === "services"
          ? (st.visits && st.visits.length ? "Pick a recent visit or type it" : "e.g. Anti-wrinkle, 3 areas") : "e.g. Skin peel, course of 6"}"></label>
      <label class="rf-f"><span>Amount to refund</span>${moneyIn(`${list}.${i}.amount`, s.amount)}</label>
      <label class="rf-f"><span>Reason</span>${reasonSelect(`${list}.${i}.reason`, list === "services" ? "service" : "package", s.reason)}</label>
      <label class="rf-f rf-span2"><span>Details <small>(needed for "Other")</small></span>
        <input class="fe-input" data-f="${list}.${i}.note" value="${esc(s.note)}" placeholder="What happened, in a few words"></label>
    </div>${list === "packages" ? pkgHtml(s, i) : ""}</div>`;

  const productCard = (p, i) => `<div class="rf-item">
    <div class="rf-item-head"><strong>${I.product}${esc(p.name)}</strong>
      <button type="button" class="rf-x" data-act="rm" data-list="products" data-i="${i}" aria-label="Remove">×</button></div>
    <div class="rf-grid">
      <label class="rf-f"><span>How many</span><input class="fe-input" type="number" min="1" max="99" data-f="products.${i}.qty" value="${esc(p.qty)}"></label>
      <label class="rf-f"><span>Amount to refund</span>${moneyIn(`products.${i}.amount`, p.amount)}</label>
    </div>
    <div class="rf-q"><span>Is it faulty?</span>${seg(`products.${i}.condition`, [["faulty", "Yes, it's faulty"], ["ok", "No"]], p.condition)}</div>
    ${p.condition === "faulty" ? `<div class="rf-q"><span>What happens to it?</span>${seg(`products.${i}.action`,
      [["supplier", "Send back to the supplier for a replacement"], ["tester", "Keep as a tester"]], p.action)}</div>` : ""}
    ${p.condition === "ok" ? `<div class="rf-q"><span>Why are they returning it?</span>${reasonSelect(`products.${i}.reason`, "product", p.reason)}</div>` : ""}
    <div class="rf-q"><span>Did they bring it back?</span>${seg(`products.${i}.returned`, RETURNED, p.returned)}</div>
    <label class="rf-f"><span>Details <small>(optional)</small></span><input class="fe-input" data-f="products.${i}.note" value="${esc(p.note)}"></label>
  </div>`;

  function productInner() {
    const picked = new Set(st.products.map((p) => p.key));
    const buys = !st.patient ? '<p class="rf-hint">Choose the patient first to see what they bought.</p>'
      : st.sales === null ? '<p class="muted rf-wait">Loading what they bought…</p>'
      : !st.sales.length ? '<p class="rf-hint">No purchases found on their Timely invoices. Add the product below.</p>'
      : `<p class="rf-hint">Tick what's being refunded. These are their purchases from Timely invoices.</p>
        <ul class="rf-buys">${st.sales.slice(0, 40).map((b) => `<li><label class="rf-buy${picked.has(b.key) ? " is-on" : ""}">
          <input type="checkbox" data-act="buy" data-key="${esc(b.key)}"${picked.has(b.key) ? " checked" : ""}>
          <span><strong>${esc(b.name)}</strong><small>${esc([niceKey(b.date), b.invoiceId && `Invoice ${b.invoiceId}`, b.qty > 1 && `${b.qty} bought`].filter(Boolean).join(" · "))}</small></span>
          ${b.fee !== null ? `<b>${money(b.fee)}</b>` : ""}</label></li>`).join("")}</ul>`;
    return `<div class="rf-subh">${I.product}<strong>Products</strong></div>${buys}
      <select class="fb-select" data-act="addprod" aria-label="Add another product">
        <option value="">${st.prodList ? "+ Add a product that isn't listed…" : "Loading products…"}</option>
        ${(st.prodList || []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>
      ${st.products.map(productCard).join("")}`;
  }
  const refreshProd = () => { const w = main.querySelector('[data-role="prodwrap"]'); if (w) w.innerHTML = productInner(); };

  function methodHtml() {
    const b = st.bank;
    return `<div class="rf-methods">${Object.entries(METHODS).map(([k, m]) => `<button type="button" class="rf-method${st.method === k ? " is-on" : ""}"
        data-act="set" data-f="method" data-v="${k}" aria-pressed="${st.method === k}">${m.icon}<strong>${m.label}</strong><small>${esc(m.blurb(set))}</small></button>`).join("")}</div>
      ${st.method === "cash" ? `<div class="rf-box">
        <div class="rf-q"><span>Has the cash been given to the patient?</span>${seg("cashGiven", [["yes", "Yes, already given"], ["no", "Not yet"]], st.cashGiven)}</div>
        ${st.cashGiven === "yes" ? `<label class="rf-f"><span>How much was given?</span>${moneyIn("cashAmount", st.cashAmount, "Same as the total")}</label>`
          : st.cashGiven === "no" ? `<p class="rf-hint">${esc(set.cashName || "Someone at the desk")} is given a step to hand it over.</p>` : ""}</div>` : ""}
      ${st.method === "bank" ? `<div class="rf-box">
        <p class="rf-lock">${I.lock}Only ${esc(set.bankName || "Dr Joanna")} and Admins can see these. They're removed once the transfer is done.</p>
        <div class="rf-grid">
          <label class="rf-f rf-span2"><span>Account name</span><input class="fe-input" data-f="bank.name" value="${esc(b.name)}" autocomplete="off"></label>
          <label class="rf-f"><span>BSB</span><input class="fe-input" inputmode="numeric" maxlength="7" data-f="bank.bsb" value="${esc(fmtBsb(b.bsb))}" placeholder="123-456" autocomplete="off"></label>
          <label class="rf-f"><span>Account number</span><input class="fe-input" inputmode="numeric" maxlength="10" data-f="bank.acct" value="${esc(b.acct)}" autocomplete="off"></label>
        </div><p class="rf-hint">Read the numbers back to the patient to check them.</p></div>` : ""}
      ${st.method === "credit" ? `<div class="rf-box"><p class="rf-hint">${esc(set.timelyName || "The Timely team")} adds the credit to their Timely account.</p></div>` : ""}`;
  }

  const patientEmail = () => String((st.patient && st.patient.email) || "").trim();
  function notifyHtml() {
    const email = patientEmail();
    const onP = !!email && st.notifyPatient;
    const pNote = !st.patient ? "Choose the patient first."
      : !email ? "No email on file for this patient. Add one on their patient page to email them."
      : st.method === "cash" && st.cashGiven === "yes" ? `To ${email}. Cash was already given, so there's no "request received" email.`
      : `To ${email}. One now, and one when the money is sent or the credit is added.`;
    return `<div class="rf-notify">
      <label class="prs-toggle${email ? "" : " is-off"}"><input type="checkbox" data-act="np"${onP ? " checked" : ""}${email ? "" : " disabled"}>
        <span class="prs-sw"></span><span><b>Email the patient</b><small>${esc(pNote)}</small></span></label>
      <label class="prs-toggle"><input type="checkbox" data-act="ns"${st.notifyStaff ? " checked" : ""}>
        <span class="prs-sw"></span><span><b>Email the staff now</b><small>Each person gets an email with their step. Their task is on their dashboard either way.</small></span></label>
    </div>`;
  }

  function draw() {
    main.innerHTML = `
      ${sec(1, "Patient", patientHtml())}
      ${sec(2, "What's being refunded?", `<div class="rf-kinds">${Object.entries(KINDS).map(([k, v]) =>
        `<button type="button" class="rf-kind${st.kinds[k] ? " is-on" : ""}" data-act="kind" data-k="${k}" aria-pressed="${st.kinds[k]}">
          ${v.icon}<strong>${v.label}</strong><small>${v.blurb}</small><span class="rf-tick">${I.check}</span></button>`).join("")}</div>
        ${st.kinds.service ? `<div class="rf-group"><div data-role="src-services">${srcHtml("services")}</div>${st.services.map((s, i) => itemHtml("services", "Service", s, i)).join("")}
          <button type="button" class="rf-add" data-act="addrow" data-list="services">+ Another service</button></div>` : ""}
        ${st.kinds.package ? `<div class="rf-group"><div data-role="src-packages">${srcHtml("packages")}</div>${st.packages.map((s, i) => itemHtml("packages", "Package", s, i)).join("")}
          <button type="button" class="rf-add" data-act="addrow" data-list="packages">+ Another package</button></div>` : ""}
        ${st.kinds.product ? `<div class="rf-group" data-role="prodwrap">${productInner()}</div>` : ""}`, "Tick everything that applies.")}
      ${sec(3, "How do they want the money back?", methodHtml())}
      ${sec(4, "Anything else?", `${notifyHtml()}<textarea class="fe-input rf-notein" rows="3" maxlength="1000" data-f="note"
        placeholder="Optional. Anything the team should know.">${esc(st.note)}</textarea>`)}
      <datalist id="rf-visits">${(st.visits || []).map((v) => `<option value="${esc(v.name)}">${esc(niceKey(v.date))}${v.staff ? ` · ${esc(v.staff)}` : ""}</option>`).join("")}</datalist>`;
  }

  function draftRefund() {
    const items = [];
    const plain = (kind, s) => ({ kind, name: s.name.trim().slice(0, 150), amount: num(s.amount), reason: s.reason || "", note: s.note.trim().slice(0, 300),
      ...(s.srcKey ? { srcKey: String(s.srcKey).slice(0, 200), source: kind === "service" ? "invoice" : "package",
        invoiceId: String(s.invoiceId || "").slice(0, 40), date: String(s.date || "").slice(0, 10),
        ...(kind === "package" ? { visitsLeft: Number(s.left) || 0, visitsAll: Number(s.of) || 0, paid: round2(s.paid),
          ...(s.method ? { calc: pkgSave(s) } : {}) } : {}) } : {}) });
    if (st.kinds.service) st.services.forEach((s) => items.push(plain("service", s)));
    if (st.kinds.package) st.packages.forEach((s) => items.push(plain("package", s)));
    if (st.kinds.product) st.products.forEach((p) => items.push({
      kind: "product", name: p.name.slice(0, 150), productId: p.productId, saleId: p.saleId, invoiceId: p.invoiceId,
      qty: Math.max(1, parseInt(p.qty, 10) || 1), amount: num(p.amount), condition: p.condition,
      action: p.condition === "faulty" ? p.action : "", reason: p.condition === "faulty" ? "Faulty" : p.reason,
      returned: p.returned, note: p.note.trim().slice(0, 300),
    }));
    const itemsTotal = round2(items.reduce((a, i) => a + i.amount, 0));
    const total = st.total === null ? itemsTotal : round2(st.total);
    return {
      items, itemsTotal, total, method: st.method,
      cashGiven: st.method === "cash" && st.cashGiven === "yes",
      cashAmount: st.method === "cash" && st.cashGiven === "yes" ? num(st.cashAmount) || total : 0,
      bankLast3: st.method === "bank" ? st.bank.acct.slice(-3) : "", note: st.note.trim().slice(0, 1000),
      notifyPatient: !!patientEmail() && st.notifyPatient, notifyStaff: !!st.notifyStaff,
    };
  }

  function problems() {
    const out = [];
    const r = draftRefund();
    if (!st.patient) out.push("Choose the patient.");
    if (!Object.values(st.kinds).some(Boolean)) out.push("Tick what's being refunded.");
    if (st.kinds.product && !st.products.length) out.push("Choose the product being refunded.");
    r.items.forEach((it) => {
      const lbl = it.name || KINDS[it.kind].label;
      if (!it.name) out.push(`${KINDS[it.kind].label}: say what it was.`);
      if (!(it.amount > 0)) out.push(`${lbl}: enter the amount.`);
      if (it.kind !== "product" && !it.reason) out.push(`${lbl}: choose a reason.`);
      if (it.kind === "product" && !it.condition) out.push(`${lbl}: is it faulty?`);
      if (it.condition === "faulty" && !it.action) out.push(`${lbl}: choose what happens to it.`);
      if (it.condition === "ok" && !it.reason) out.push(`${lbl}: choose why it's being returned.`);
      if (it.reason === "Other" && !it.note) out.push(`${lbl}: add the details for "Other".`);
    });
    if (st.kinds.package) st.packages.forEach((s) => {
      if (s.srcKey && s.method === "regular" && !pkgCalc(s).ok) out.push(`${s.name || "Package"}: enter the regular price of each used visit.`);
    });
    if (r.items.length && !(r.total > 0)) out.push("Enter the total to refund.");
    if (!st.method) out.push("Choose how they get the money back.");
    if (st.method === "cash" && !st.cashGiven) out.push("Say whether the cash has been given.");
    if (st.method === "bank") {
      if (st.bank.name.trim().length < 2) out.push("Enter the name on the bank account.");
      if (!/^\d{6}$/.test(st.bank.bsb)) out.push("The BSB is 6 numbers.");
      if (!/^\d{5,10}$/.test(st.bank.acct)) out.push("Check the account number (5 to 10 numbers).");
    }
    return out;
  }

  function drawSum() {
    const r = draftRefund();
    sum.querySelector('[data-role="sum-pt"]').innerHTML = st.patient
      ? `<p class="rf-sum-pt">${avatar(st.patient.name)}<strong>${esc(st.patient.name)}</strong></p>` : '<p class="muted rf-sum-pt">No patient chosen yet</p>';
    sum.querySelector('[data-role="sum-items"]').innerHTML = r.items.length
      ? r.items.map((i) => `<li><span>${i.qty > 1 ? `${i.qty} × ` : ""}${esc(i.name || KINDS[i.kind].label)}</span><b>${money(i.amount)}</b></li>`).join("")
      : '<li class="muted">Nothing added yet</li>';
    const t = sum.querySelector('[data-role="total"]');
    if (document.activeElement !== t) t.value = r.total > 0 ? r.total.toFixed(2) : "";
    sum.querySelector('[data-role="total-note"]').innerHTML = st.total !== null && round2(st.total) !== r.itemsTotal
      ? `The items add up to ${money(r.itemsTotal)}. <button type="button" data-act="resettotal">Use that</button>` : "";
    sum.querySelector('[data-role="sum-method"]').innerHTML = (st.method
      ? `<p class="rf-methodline">${METHODS[st.method].icon}<span>${esc(methodText({ ...r, cashGiven: st.cashGiven === "yes" }))}</span></p>` : "")
      + (st.patient ? `<p class="rf-mailline">${r.notifyPatient ? "Patient is emailed" : "No emails to the patient"} · ${
        r.notifyStaff ? "staff are emailed now" : "staff not emailed"}</p>` : "");
    const steps = r.items.length && st.method ? buildSteps(r, set) : [];
    sum.querySelector('[data-role="sum-next"]').innerHTML = steps.length ? `<h4>What happens next</h4><ol>${steps.map((s) =>
      `<li class="${waiting(steps, s) ? "is-wait" : ""}">${avatar(s.whoName || "?")}<span><strong>${esc(s.title)}</strong>
        <small>${esc(s.whoName || "Anyone on the team")}${waiting(steps, s) ? " · after approval" : ""}</small></span></li>`).join("")}</ol>
      ${steps.some((s) => !s.whoId) && boss() ? '<p class="rf-warn">Some steps have no one set. Choose who in Refunds → Settings.</p>' : ""}` : "";
    const probsEl = sum.querySelector('[data-role="probs"]');
    const probs = st.tried ? problems() : [];
    probsEl.hidden = !probs.length;
    probsEl.innerHTML = probs.map((p) => `<li>${esc(p)}</li>`).join("");
  }

  async function loadSources(p) {
    st.src = null;
    refreshSrc();
    const [src, was] = await Promise.all([sourcesFor(p), refundedKeys(p)]);
    if (st.patient !== p || !root.isConnected) return;
    st.src = { ...src, was };
    refreshSrc();
  }

  async function loadPatientBits() {
    const p = st.patient;
    if (!p) return;
    loadSources(p);
    const [sales, visits] = await Promise.all([salesFor(p), visitsFor(p)]);
    if (st.patient !== p || !root.isConnected) return;
    st.sales = sales;
    st.visits = visits;
    refreshProd();
    const dl = main.querySelector("#rf-visits");
    if (dl) dl.innerHTML = visits.map((v) => `<option value="${esc(v.name)}">${esc(niceKey(v.date))}${v.staff ? ` · ${esc(v.staff)}` : ""}</option>`).join("");
  }

  const priceOf = (pid) => { const p = (st.prodList || []).find((x) => x.id === pid); return p && p.price !== null ? p.price : null; };
  const newProduct = (o) => ({ key: o.key, saleId: o.saleId || "", invoiceId: o.invoiceId || "", productId: o.productId || "", name: o.name,
    qty: "1", unit: o.unit ?? null, amount: o.unit != null ? round2(o.unit).toFixed(2) : "", auto: o.unit != null,
    condition: "", action: "", reason: "", returned: "unopened", note: "" });

  let qTimer = 0, qSeq = 0;
  function search(q) {
    clearTimeout(qTimer);
    const box = main.querySelector('[data-role="presults"]');
    if (!box) return;
    if (q.trim().length < 2) { box.innerHTML = ""; return; }
    box.innerHTML = '<p class="muted rf-wait">Searching…</p>';
    qTimer = setTimeout(async () => {
      const seq = ++qSeq;
      const list = await findPatientsAny(q).catch(() => []);
      if (seq !== qSeq || !box.isConnected) return;
      st.hits = list;
      box.innerHTML = list.length ? list.map((p, i) => `<button type="button" class="rf-hit" data-act="pick" data-i="${i}">${avatar(p.name)}
        <span><strong>${esc(p.name)}</strong><small>${esc([p.dobKey && niceKey(p.dobKey), p.mobile, p.email].filter(Boolean).join(" · "))}</small></span></button>`).join("")
        : '<p class="muted rf-wait">No patients found.</p>';
    }, 280);
  }

  async function send(btn) {
    st.tried = true;
    drawSum();
    if (problems().length) { sum.querySelector('[data-role="probs"]').scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const id = await saveRefund(draftRefund());
      Promise.resolve(callApi({ action: "refunds", op: "notify", id })).catch(() => {});   // emails now, not at the next 5-minute check
      showToast("Refund request sent");
      location.hash = `#/refunds/r/${encodeURIComponent(id)}`;
    } catch (err) {
      console.error("Refund not saved:", err);
      btn.disabled = false;
      btn.textContent = "Send refund request";
      showToast(err.code === "permission-denied" ? "Refunds aren't set up in the Firestore rules yet." : "Couldn't send. Try again.");
    }
  }

  async function saveRefund(r) {
    const ref = doc(collection(db, "refunds"));
    const by = nameOf(staff);
    const p = st.patient;
    const base = { patientId: p.id, patientPttId: p.pttId || "", patientName: p.name, patientEmail: p.email || "", patientMobile: p.mobile || "", total: r.total };
    const steps = buildSteps(r, set);
    const batch = writeBatch(db);
    steps.forEach((s) => {
      s.dueDate = keyPlus(s.key === "approve" ? 1 : 2);
      if (waiting(steps, s)) return;
      const t = doc(collection(db, "staff-task-list"));
      batch.set(t, taskData(base, ref.id, s, by));
      s.taskId = t.id;
    });
    batch.set(ref, {
      ...base, items: r.items, itemsTotal: r.itemsTotal, method: r.method, cashGiven: r.cashGiven, cashAmount: r.cashAmount,
      bankLast3: r.bankLast3, note: r.note, notifyPatient: r.notifyPatient, notifyStaff: r.notifyStaff,
      steps, ...recompute(steps), status: "open",
      events: [{ at: new Date().toISOString(), by, action: "Requested", note: `${money(r.total)} · ${METHODS[r.method].label}` }],
      createdAt: serverTimestamp(), createdBy: by, createdByUid: myUid(), updatedAt: serverTimestamp(),
    });
    if (r.method === "bank") {
      batch.set(doc(db, "refund_bank", ref.id), { accountName: st.bank.name.trim().slice(0, 120), bsb: st.bank.bsb,
        accountNumber: st.bank.acct, createdByUid: myUid(), createdAt: serverTimestamp() });
    }
    await batch.commit();
    return ref.id;
  }

  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.role === "pq") { search(t.value); return; }
    if (t.dataset.role === "total") { const v = t.value.trim(); st.total = v === "" ? null : num(v); drawSum(); return; }
    const f = t.dataset.f;
    if (!f || t.tagName === "BUTTON" || t.tagName === "SELECT") return;
    let v = t.value;
    if (f === "bank.bsb") { v = v.replace(/\D/g, "").slice(0, 6); t.value = fmtBsb(v); }
    if (f === "bank.acct") { v = v.replace(/\D/g, "").slice(0, 10); t.value = v; }
    setPath(f, v);
    const m = /^products\.(\d+)\.(qty|amount)$/.exec(f);
    if (m) {
      const p = st.products[+m[1]];
      if (m[2] === "amount") p.auto = false;
      else if (p.auto && p.unit != null) {
        p.amount = round2(p.unit * (parseInt(v, 10) || 1)).toFixed(2);
        const a = main.querySelector(`[data-f="products.${m[1]}.amount"]`);
        if (a) a.value = p.amount;
      }
    }
    const pk = /^packages\.(\d+)\.(amount|used\.\d+\.price)$/.exec(f);
    if (pk && st.packages[+pk[1]] && st.packages[+pk[1]].srcKey) {
      if (pk[2] === "amount") st.packages[+pk[1]].auto = false;
      recalcPkg(+pk[1]);
    }
    drawSum();
  });

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.act === "src") {
      const list = t.dataset.list;
      const x = srcFor(list).find((y) => y.key === t.dataset.key);
      if (!x) return;
      if (t.checked) {
        const row = list === "services"
          ? { name: x.name, amount: round2(x.net).toFixed(2), srcKey: x.key, invoiceId: x.invoiceId || "", date: x.date || "" }
          : (() => {
            const p = { name: x.name, srcKey: x.key, invoiceId: x.invoiceId || "", date: x.boughtOn || "",
              left: x.left, of: x.left + x.used, paid: x.paid, method: "regular", auto: true, used: usedRowsOf(x) };
            const c = pkgCalc(p);
            return { ...p, amount: c.ok ? c.refund.toFixed(2) : "" };
          })();
        const i = st[list].findIndex((s) => !s.srcKey && !s.name.trim() && !String(s.amount).trim());
        if (i !== -1) st[list][i] = { ...st[list][i], ...row };
        else st[list].push({ ...blank(), ...row });
      } else {
        st[list] = st[list].filter((s) => s.srcKey !== x.key);
        if (!st[list].length) st[list].push(blank());
      }
      draw(); drawSum();
      return;
    }
    if (t.dataset.act === "buy") {
      const b = (st.sales || []).find((x) => x.key === t.dataset.key);
      if (!b) return;
      if (t.checked) st.products.push(newProduct({ ...b, unit: b.fee !== null ? b.fee / Math.max(1, b.qty) : priceOf(b.productId) }));
      else st.products = st.products.filter((p) => p.key !== b.key);
      refreshProd(); drawSum();
      return;
    }
    if (t.dataset.act === "np") { st.notifyPatient = t.checked; drawSum(); return; }
    if (t.dataset.act === "ns") { st.notifyStaff = t.checked; drawSum(); return; }
    if (t.dataset.act === "addprod") {
      const p = (st.prodList || []).find((x) => x.id === t.value);
      if (p) st.products.push(newProduct({ key: `p_${p.id}_${Date.now()}`, productId: p.id, name: p.name, unit: p.price }));
      refreshProd(); drawSum();
      return;
    }
    if (t.tagName === "SELECT" && t.dataset.f) { setPath(t.dataset.f, t.value); drawSum(); }
  });

  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a || a.dataset.act === "buy" || a.dataset.act === "src") return;
    const act = a.dataset.act;
    if (act === "pick") {
      st.patient = st.hits[+a.dataset.i] || null; st.sales = null; st.visits = null; st.src = null; dropSrc();
      draw(); drawSum(); loadPatientBits();
    } else if (act === "unpick") {
      st.patient = null; st.sales = null; st.visits = null; st.src = null; dropSrc();
      draw(); drawSum();
      const q = main.querySelector('[data-role="pq"]'); if (q) q.focus();
    } else if (act === "kind") {
      const k = a.dataset.k;
      st.kinds[k] = !st.kinds[k];
      if (st.kinds[k] && k === "service" && !st.services.length) st.services.push(blank());
      if (st.kinds[k] && k === "package" && !st.packages.length) st.packages.push(blank());
      if (st.kinds[k] && k === "product" && !st.prodList) {
        listProducts().then((l) => {
          st.prodList = l.filter((p) => p.active).sort((x, y) => (x.category === "retail" ? 0 : 1) - (y.category === "retail" ? 0 : 1) || x.name.localeCompare(y.name, "en-AU"));
          refreshProd();
        }).catch(() => { st.prodList = []; refreshProd(); });
      }
      draw(); drawSum();
    } else if (act === "addrow") {
      st[a.dataset.list].push(blank()); draw(); drawSum();
    } else if (act === "rm") {
      st[a.dataset.list].splice(+a.dataset.i, 1);
      if (a.dataset.list === "products") refreshProd(); else draw();
      drawSum();
    } else if (act === "pkgauto") {
      const i = +a.dataset.i;
      if (st.packages[i]) { st.packages[i].auto = true; recalcPkg(i); }
      drawSum();
    } else if (act === "set") {
      setPath(a.dataset.f, a.dataset.v);
      const pm = /^packages\.(\d+)\.method$/.exec(a.dataset.f);
      if (pm && st.packages[+pm[1]]) { st.packages[+pm[1]].auto = true; recalcPkg(+pm[1]); }
      if (a.dataset.f.startsWith("products.")) refreshProd(); else draw();
      drawSum();
    } else if (act === "resettotal") {
      st.total = null; drawSum();
    } else if (act === "send") {
      send(a);
    }
  });

  if (patientId) {
    const p = await getPatient(patientId).catch(() => null);
    if (p) { st.patient = p; loadPatientBits(); }
  }
  draw();
  drawSum();
}

/* ===================== One refund ===================== */
function askReason({ title, intro = "", label, ok }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog fe-confirm";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>${esc(title)}</h3>${intro ? `<p>${esc(intro)}</p>` : ""}</div>
      <label class="lh-field"><span class="lh-label">${esc(label)}</span><textarea name="v" rows="3" maxlength="300"></textarea></label>
      <p class="lh-error" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="no">Back</button>
        <button type="submit" class="lh-btn is-danger">${esc(ok)}</button></div></form>`;
    let out = null;
    const f = dlg.querySelector("form");
    dlg.querySelector('[data-act="no"]').addEventListener("click", () => dlg.close());
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = f.elements.v.value.trim();
      if (v.length < 3) { const er = dlg.querySelector(".lh-error"); er.textContent = "Add a reason."; er.hidden = false; return; }
      out = v;
      dlg.close();
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

async function mountRefund(container, { id, staff }) {
  const root = document.createElement("section");
  root.className = "page wide rf";
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
  container.replaceChildren(root);
  const by = nameOf(staff);
  let r = null, bank = null, bankState = "idle";
  const drafts = {};
  const inv = { state: "idle", products: null, lots: {} };   // for the returned-products step
  const picks = {};                                           // what's chosen for each returned product

  const stop = onSnapshot(doc(db, "refunds", id), (snap) => {
    if (!root.isConnected) { stop(); return; }
    if (!snap.exists()) { root.innerHTML = '<div class="rf-empty"><strong>Refund not found</strong>It may have been removed.</div>'; return; }
    r = { id, ...snap.data() };
    draw();
  }, (err) => {
    console.error("Refund not loaded:", err);
    root.innerHTML = '<div class="rf-empty"><strong>Couldn\'t load this refund</strong>Check your connection and try again.</div>';
  });
  window.addEventListener("hashchange", () => stop(), { once: true });

  function stepHtml(s, i) {
    const steps = r.steps || [];
    const wait = waiting(steps, s);
    const late = !s.done && !wait && s.dueDate && s.dueDate < dayKey();
    const act = r.status === "open" && !s.done && !wait && canDo(s);
    const cls = s.done ? "is-done" : wait ? "is-wait" : act ? "is-mine" : "is-todo";
    const noFill = 'autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other"';
    const field = s.need === "ref" ? `<input class="fe-input" data-sv="${s.key}" placeholder="Transfer reference" ${noFill}>`
      : s.need === "invoice" ? `<input class="fe-input" data-sv="${s.key}" placeholder="Timely invoice number" ${noFill}>`
      : s.need === "amount" ? `<span class="rf-money"><em>$</em><input class="fe-input" inputmode="decimal" data-sv="${s.key}" value="${round2(r.total).toFixed(2)}"></span>` : "";
    const help = s.key === "stock" ? `<ul class="rf-stock">${stockLines(r.items).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`
      : `<p class="rf-step-help">${esc(s.help)}</p>`;
    const btns = s.key === "approve"
      ? `<button type="button" class="btn-primary" data-act="done" data-k="${s.key}">${I.check}Approve</button>
         <button type="button" class="lh-btn is-quiet" data-act="decline">Decline</button>`
      : `<button type="button" class="btn-primary" data-act="done" data-k="${s.key}">${I.check}Done</button>`;
    return `<article class="rf-step ${cls}${late ? " is-late" : ""}">
      <span class="rf-step-n">${s.done ? I.check : i + 1}</span>
      <div class="rf-step-main">
        <div class="rf-step-top"><strong>${esc(s.title)}</strong><span class="rf-who">${avatar(s.whoName || "?")}${esc(s.whoName || "Anyone")}</span></div>
        ${s.done ? `<p class="rf-step-done">${esc([valueText(s), s.doneBy, s.doneAt && niceDay(new Date(s.doneAt))].filter(Boolean).join(" · "))}</p>`
          : wait ? '<p class="rf-step-wait">Waiting for approval</p>'
          : r.status === "open" ? `<p class="rf-step-due${late ? " is-late" : ""}">${late ? "Overdue · " : ""}Due ${esc(niceKey(s.dueDate))}${
            s.whoId && s.whoId !== myUid() && (boss() || r.createdByUid === myUid())
              ? ` · <button type="button" class="rf-resend" data-act="resend" data-k="${s.key}">Email ${esc(String(s.whoName || "them").split(" ")[0])} again</button>` : ""}</p>` : ""}
        ${s.key === "stock" && (act || s.lines) ? stockAct(s, act)
          : act ? `<div class="rf-step-act">${help}<div class="rf-step-row">${field}${btns}</div><p class="rf-err" data-err="${s.key}" hidden></p></div>` : ""}
      </div></article>`;
  }

  /* ---------- Returned products: each one into stock, kept as a tester, thrown out, or back to the supplier ---------- */
  function pickFor(idx, it) {
    if (!picks[idx]) picks[idx] = { how: defaultHow(it), loc: "shelf", lot: "", batch: "", expiry: "" };
    return picks[idx];
  }
  const seg2 = (idx, field, opts, cur) => `<div class="rf-seg">${opts.map(([v, l]) =>
    `<button type="button" class="${cur === v ? "is-on" : ""}" data-act="pk" data-pk="${idx}.${field}" data-v="${v}" aria-pressed="${cur === v}">${esc(l)}</button>`).join("")}</div>`;

  function lotSelect(p, pk, idx) {
    const lots = (inv.lots[p.id] || []).filter((l) => l.loc === pk.loc);
    if (!pk.lot) pk.lot = (lots.find((l) => l.qty > 0) || lots[0] || { id: "__new" }).id;
    return `<select class="fb-select" data-pk="${idx}.lot" aria-label="${esc(batchName(p))}">${lots.map((l) =>
      `<option value="${esc(l.id)}"${l.id === pk.lot ? " selected" : ""}>${esc(`${batchName(p)} ${l.batch || "-"} · exp ${niceKey(l.expiry) || "-"} · ${l.qty} there now`)}</option>`).join("")}
      <option value="__new"${pk.lot === "__new" ? " selected" : ""}>Another ${esc(batchName(p).toLowerCase())}…</option></select>`;
  }

  function stockAct(s, act) {
    const lines = s.lines || {};
    const rows = stockItems(r.items).map(({ it, idx }) => {
      const head = `<span class="rf-put-main"><strong>${it.qty > 1 ? `${it.qty} × ` : ""}${esc(it.name)}</strong><small>${esc(itemSub(it))}</small></span>`;
      const done = lines[idx];
      if (done) {
        return `<li class="rf-put is-done">${head}<span class="rf-put-res">${I.check}${esc((HOW[done.how] || {}).done || "")}${
          done.loc ? ` (${done.loc === "jt" ? "JT storage" : "Shelf"})` : ""}${done.requestId ? ` · replacement on order request ${esc(reqNumber({ id: done.requestId }))}` : ""}${
          done.note ? ` · ${esc(done.note)}` : ""}<small>${esc(done.by || "")}</small></span></li>`;
      }
      if (!act) return `<li class="rf-put">${head}<span class="rf-put-res muted">Not done yet</span></li>`;
      const pk = pickFor(idx, it);
      const p = inv.products ? inv.products.get(it.productId) : null;
      const special = !!p && (isKitProduct(p) || isSharedProduct(p));
      let extra = "";
      if (pk.how === "shelf" && p && !special) {
        extra = `<div class="rf-put-where">${seg2(idx, "loc", [["shelf", "Shelf"], ["jt", "JT storage"]], pk.loc)}
          ${p.tracked ? lotSelect(p, pk, idx) : ""}
          ${p.tracked && pk.lot === "__new" ? `<input class="fe-input" data-pk="${idx}.batch" value="${esc(pk.batch)}" placeholder="${esc(batchName(p))} number" autocomplete="off">
            <input class="fe-input" type="date" data-pk="${idx}.expiry" value="${esc(pk.expiry)}" aria-label="Expiry">` : ""}</div>`;
      } else if (pk.how === "supplier") {
        extra = '<p class="rf-hint">An order request for a replacement is made. Keep the faulty one aside to send back.</p>';
      } else if (pk.how === "tester" || pk.how === "bin") {
        extra = "<p class=\"rf-hint\">Recorded as returned. Stock doesn't change: it came off when it was sold.</p>";
      }
      return `<li class="rf-put">${head}
        ${inv.state === "ok" && !p ? "<p class=\"rf-hint\">This product isn't in Inventory any more, so it's recorded on the refund only.</p>" : ""}
        ${special ? '<p class="rf-hint">Kit and shared products are recorded on the refund only.</p>' : ""}
        ${seg2(idx, "how", howOpts(it).map((k) => [k, HOW[k].label]), pk.how)}
        ${extra}
        <div class="rf-step-row"><button type="button" class="btn-primary" data-act="put" data-i="${idx}"${inv.state !== "ok" ? " disabled" : ""}>${I.check}Done</button></div>
        <p class="rf-err" data-err="put${idx}" hidden></p></li>`;
    }).join("");
    return `<div class="rf-step-act">
      ${act && inv.state !== "ok" ? `<p class="muted rf-wait">${inv.state === "failed" ? "Couldn't load the products. Reload to try again." : "Loading the products…"}</p>` : ""}
      <ul class="rf-puts">${rows}</ul></div>`;
  }

  async function loadInv() {
    inv.state = "loading";
    try {
      const list = await listProducts();
      inv.products = new Map(list.map((p) => [p.id, p]));
      const tracked = [...new Set(stockItems(r.items).map(({ it }) => inv.products.get(it.productId)).filter((p) => p && p.tracked).map((p) => p.id))];
      await Promise.all(tracked.map(async (pid) => { inv.lots[pid] = await listLotsForProduct(pid).catch(() => []); }));
      inv.state = "ok";
    } catch (err) {
      console.warn("Products not loaded:", err);
      inv.state = "failed";
    }
    if (root.isConnected && r) draw();
  }

  async function saveLine(idx, btn) {
    const it = r.items[idx];
    const pk = pickFor(idx, it);
    const err = root.querySelector(`[data-err="put${idx}"]`);
    const say = (m) => { err.textContent = m; err.hidden = false; };
    if (inv.state !== "ok") { say("Still loading the products."); return; }
    const p = inv.products.get(it.productId) || null;
    const special = !!p && (isKitProduct(p) || isSharedProduct(p));
    const tag = `Refund ${refundNo(r)}`;
    const result = { how: pk.how, at: new Date().toISOString(), by, byUid: myUid(), returnId: "", requestId: "", loc: "", note: "" };

    let lot = { batch: "", expiry: "" };
    if (p && !special && p.tracked && pk.how === "shelf") {
      if (pk.lot === "__new") lot = { batch: String(pk.batch || "").trim(), expiry: pk.expiry || "" };
      else { const l = (inv.lots[p.id] || []).find((x) => x.id === pk.lot); if (l) lot = { batch: l.batch, expiry: l.expiry }; }
      if (!lot.batch || !/^\d{4}-\d{2}-\d{2}$/.test(lot.expiry)) { say(`Choose the ${batchName(p).toLowerCase()} and its expiry.`); return; }
    }
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      if (!p) result.note = "Not in Inventory: recorded on the refund only";
      else if (special) result.note = "Recorded on the refund only";
      else {
        // 1. The return, linked to the Timely sale when there is one (dated the day of the request)
        const date = dayKey(toDate(r.createdAt) || new Date());
        const fromInvoice = String(it.saleId || "").startsWith("invoice__") ? it.invoiceId : "";
        const base = { date, qty: it.qty, patientId: r.patientId, patientName: r.patientName, resell: pk.how === "shelf",
          loc: pk.loc === "jt" ? "jt" : "shelf", batch: lot.batch, expiry: lot.expiry, note: `${tag} · ${HOW[pk.how].done}`.slice(0, 300) };
        let res;
        try {
          res = await recordPatientReturn(p, { ...base, invoiceId: fromInvoice });
        } catch (ex) {
          // The sale can't take it (already returned, or the invoice changed): recorded without the link
          if (!fromInvoice || !/invoice|sale/i.test(String(ex.message || ""))) throw ex;
          res = await recordPatientReturn(p, { ...base, invoiceId: "" });
        }
        result.returnId = res.id;
        if (pk.how === "shelf") result.loc = base.loc;
        // 2. A replacement from the supplier
        if (pk.how === "supplier") {
          try {
            result.requestId = await createRequest({
              items: [{ productId: p.id, name: p.name, supplierId: p.supplierId || "", qty: it.qty, unitKind: "stock", unit: p.stockUnit, stockQty: it.qty }],
              loc: "shelf", urgency: "normal",
              note: `Replacement for a faulty ${p.name} returned by ${r.patientName} (${tag}). The faulty one is set aside to go back to the supplier.`,
            }, staff);
          } catch (ex) {
            console.warn("Replacement not requested:", ex);
            result.note = "The order request couldn't be made: ask the ordering team for a replacement";
          }
        }
      }

      // 3. On the refund; the step finishes itself once every product is done
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "refunds", id);
        const cur = (await tx.get(ref)).data();
        if (!cur || cur.status !== "open") throw new Error("This refund has already been closed.");
        const steps = (cur.steps || []).map((x) => ({ ...x }));
        const k = steps.findIndex((x) => x.key === "stock");
        if (k === -1) throw new Error("This refund has no returned products step.");
        const lines = { ...(steps[k].lines || {}), [idx]: result };
        steps[k] = { ...steps[k], lines };
        if (!steps[k].done && stockItems(cur.items).every(({ idx: i }) => lines[i])) {
          steps[k] = { ...steps[k], done: true, doneAt: result.at, doneBy: by, doneByUid: myUid() };
          if (steps[k].taskId) {
            tx.update(doc(db, "staff-task-list", steps[k].taskId), { status: "Completed", completedAt: serverTimestamp(), completedBy: by, completedByUid: myUid() });
          }
        }
        const rc = recompute(steps);
        const allDone = rc.stepsOpen === 0;
        tx.update(ref, {
          steps, ...rc, status: allDone ? "done" : "open", ...(allDone ? { completedAt: serverTimestamp() } : {}),
          updatedAt: serverTimestamp(), updatedBy: by,
          events: arrayUnion({ at: result.at, by, action: `${it.name}: ${HOW[pk.how].done}`, note: result.note }),
        });
      });
      delete picks[idx];
      Promise.resolve(callApi({ action: "refunds", op: "notify", id })).catch(() => {});
      showToast(pk.how === "shelf" ? "Back in stock" : pk.how === "supplier" ? "Recorded, and a replacement requested" : "Recorded");
    } catch (ex) {
      console.error("Returned product not saved:", ex);
      btn.disabled = false;
      btn.innerHTML = `${I.check}Done`;
      say(ex.code === "permission-denied" ? "You don't have access to change stock. Ask someone with Inventory access." : ex.message || "Couldn't save. Try again.");
    }
  }

  function bankCard() {
    const head = `<h4>${I.lock}Bank details</h4>`;
    if (!canSeeBank()) return `<section class="rf-box2">${head}<p class="muted">Only the person paying it and Admins can see the bank details.</p></section>`;
    if (bankState === "idle" || bankState === "loading") return `<section class="rf-box2">${head}<p class="muted">Loading…</p></section>`;
    if (bankState !== "ok" || !bank) return `<section class="rf-box2">${head}<p class="muted">${bankState === "denied" ? "You don't have access to the bank details." : "The bank details couldn't be loaded."}</p></section>`;
    if (bank.masked) return `<section class="rf-box2">${head}<p class="muted">Removed after the transfer (account ending ${esc(String(bank.accountNumber || "").slice(-3))}).</p></section>`;
    const row = (l, v) => `<div class="rf-bankrow"><span>${l}</span><b>${esc(v)}</b><button type="button" class="rf-copy" data-act="copy" data-v="${esc(v)}">Copy</button></div>`;
    return `<section class="rf-box2">${head}${row("Account name", bank.accountName)}${row("BSB", String(bank.bsb || "").replace(/^(\d{3})(\d{3})$/, "$1-$2"))}${row("Account number", bank.accountNumber)}${row("Amount", round2(r.total).toFixed(2))}</section>`;
  }

  async function loadBank() {
    bankState = "loading";
    try {
      const s = await getDoc(doc(db, "refund_bank", id));
      bank = s.exists() ? s.data() : null;
      bankState = "ok";
    } catch (ex) {
      bankState = ex.code === "permission-denied" ? "denied" : "failed";
    }
    if (root.isConnected && r) draw();
  }

  async function maskBank() {
    if (!canSeeBank()) return;
    const ref = doc(db, "refund_bank", id);
    const b = bank || ((await getDoc(ref)).data());
    if (!b || b.masked) return;
    const masked = { accountNumber: `••••${String(b.accountNumber || "").slice(-3)}`, bsb: "", masked: true };
    await updateDoc(ref, masked);
    bank = { ...b, ...masked };
  }

  const canCancel = () => r.status === "open" && (boss() || r.createdByUid === myUid()
    || (r.steps || []).some((s) => s.key === "approve" && !s.done && s.whoId === myUid()));

  function draw() {
    root.querySelectorAll("[data-sv]").forEach((i) => { drafts[i.dataset.sv] = i.value; });
    const steps = r.steps || [];
    const doneN = steps.filter((s) => s.done).length;
    const created = toDate(r.createdAt);
    root.innerHTML = `
      <a class="tm-back" href="#/refunds">${I.back}<span>Refunds</span></a>
      <header class="rf-head">
        <div><span class="rf-no">${refundNo(r)}</span>
          <h2>${money(r.total)} to ${esc(r.patientName)}</h2>
          <p class="muted">${esc((METHODS[r.method] || {}).label || "")} · requested by ${esc(r.createdBy || "")}${created ? ` on ${esc(niceDay(created))}` : ""}${
            r.patientId ? ` · <a href="#/patient/${encodeURIComponent(r.patientId)}">Open patient</a>` : ""}</p></div>
        <span class="rf-status is-${esc(r.status)}">${r.status === "open" ? `${doneN} of ${steps.length} done` : r.status === "done" ? "Completed" : "Cancelled"}</span>
      </header>
      ${r.status === "open" ? `<div class="rf-prog is-lg"><i style="width:${steps.length ? Math.round((doneN / steps.length) * 100) : 0}%"></i></div>` : ""}
      ${r.status === "cancelled" ? `<p class="rf-cancelled">Cancelled by ${esc(r.cancelledBy || "")}: ${esc(r.cancelReason || "")}</p>` : ""}
      <div class="rf-detail">
        <div class="rf-steps">${steps.map(stepHtml).join("")}</div>
        <aside class="rf-side">
          <section class="rf-box2"><h4>What's refunded</h4>
            <ul class="rf-items">${(r.items || []).map((it) => `<li><span class="rf-ik">${KINDS[it.kind].icon}</span>
              <span><strong>${it.qty > 1 ? `${it.qty} × ` : ""}${esc(it.name)}</strong><small>${esc(itemSub(it))}</small>${calcHtml(it)}</span><b>${money(it.amount)}</b></li>`).join("")}</ul>
            ${r.itemsTotal !== undefined && round2(r.itemsTotal) !== round2(r.total) ? `<p class="rf-note">The items add up to ${money(r.itemsTotal)}.</p>` : ""}
            <div class="rf-totalrow"><span>Total</span><b>${money(r.total)}</b></div>
            <p class="rf-methodline">${(METHODS[r.method] || {}).icon || ""}<span>${esc(methodText(r))}</span></p>
            ${r.note ? `<p class="rf-note">${esc(r.note)}</p>` : ""}
            <p class="rf-mailline">${r.notifyPatient === false ? "No emails to the patient" : "The patient is emailed"} · ${
              r.notifyStaff === false ? "staff weren't emailed when it was made" : "staff were emailed their steps"}</p>
          </section>
          ${r.method === "bank" ? bankCard() : ""}
          <section class="rf-box2"><h4>History</h4><ul class="rf-tl">${[...(r.events || [])].reverse().map((ev) =>
            `<li>${esc(ev.action)}${ev.note ? ` · ${esc(ev.note)}` : ""}<small>${esc(ev.by || "")}${ev.at ? ` · ${esc(new Date(ev.at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}` : ""}</small></li>`).join("")}</ul></section>
          ${canCancel() ? '<button type="button" class="lh-btn is-danger" data-act="cancel">Cancel this refund</button>' : ""}
        </aside>
      </div>`;
    Object.entries(drafts).forEach(([k, v]) => { const i = root.querySelector(`[data-sv="${k}"]`); if (i) i.value = v; });
    if (r.method === "bank" && bankState === "idle" && canSeeBank()) loadBank();
    if (inv.state === "idle" && r.status === "open"
      && (r.steps || []).some((s) => s.key === "stock" && !s.done && canDo(s) && !waiting(r.steps, s))) loadInv();
  }

  async function complete(key, btn) {
    const s = (r.steps || []).find((x) => x.key === key);
    if (!s) return;
    const inp = root.querySelector(`[data-sv="${key}"]`);
    const err = root.querySelector(`[data-err="${key}"]`);
    let value = inp ? inp.value.trim() : "";
    const bad = s.need === "ref" && value.length < 3 ? "Enter the transfer reference."
      : s.need === "invoice" && !value ? "Enter the Timely invoice number."
      : s.need === "amount" && !(num(value) > 0) ? "Enter how much was given." : "";
    if (bad) { err.textContent = bad; err.hidden = false; if (inp) inp.focus(); return; }
    if (s.need === "amount") value = String(num(value));
    value = value.slice(0, 80);
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "refunds", id);
        const snap = await tx.get(ref);
        const cur = snap.data();
        if (!cur || cur.status !== "open") throw new Error("This refund has already been closed.");
        const steps = (cur.steps || []).map((x) => ({ ...x }));
        const k = steps.findIndex((x) => x.key === key);
        if (k === -1 || steps[k].done) throw new Error("Someone has just done this step.");
        const wasWaiting = steps.filter((x) => !x.done && waiting(steps, x)).map((x) => x.key);
        const at = new Date().toISOString();
        steps[k] = { ...steps[k], done: true, value, doneAt: at, doneBy: by, doneByUid: myUid() };
        if (steps[k].taskId) {
          tx.update(doc(db, "staff-task-list", steps[k].taskId), { status: "Completed", completedAt: serverTimestamp(), completedBy: by, completedByUid: myUid() });
        }
        // Just approved: everyone else gets their task now
        steps.forEach((x) => {
          if (x.done || x.taskId || !wasWaiting.includes(x.key) || waiting(steps, x)) return;
          x.dueDate = keyPlus(2);
          const t = doc(collection(db, "staff-task-list"));
          tx.set(t, taskData(cur, id, x, by));
          x.taskId = t.id;
        });
        const rc = recompute(steps);
        const allDone = rc.stepsOpen === 0;
        tx.update(ref, {
          steps, ...rc, status: allDone ? "done" : "open", ...(allDone ? { completedAt: serverTimestamp() } : {}),
          updatedAt: serverTimestamp(), updatedBy: by,
          events: arrayUnion({ at, by, action: key === "approve" ? "Approved" : `${steps[k].title}: done`, note: valueText(steps[k]) }),
        });
      });
      delete drafts[key];
      showToast(key === "approve" ? "Approved. Everyone else has their steps now." : "Step done");
      if (key === "bank") maskBank().catch((ex) => console.warn("Bank details not removed:", ex));
    } catch (ex) {
      console.error("Step not saved:", ex);
      btn.disabled = false;
      btn.innerHTML = `${I.check}${key === "approve" ? "Approve" : "Done"}`;
      err.textContent = ex.code === "permission-denied" ? "This step isn't yours to complete." : ex.message || "Couldn't save. Try again.";
      err.hidden = false;
    }
  }

  async function cancel(declined) {
    const reason = await askReason(declined
      ? { title: "Decline this refund?", intro: "Everyone's steps are closed.", label: "Why is it declined?", ok: "Decline" }
      : { title: "Cancel this refund?", intro: "Everyone's steps are closed. This can't be undone.", label: "Why is it cancelled?", ok: "Cancel refund" });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "refunds", id);
        const snap = await tx.get(ref);
        const cur = snap.data();
        if (!cur || cur.status !== "open") throw new Error("This refund has already been closed.");
        (cur.steps || []).forEach((x) => {
          if (!x.done && x.taskId) tx.update(doc(db, "staff-task-list", x.taskId), { status: "Completed", completedAt: serverTimestamp(), completedBy: by, completedByUid: myUid() });
        });
        tx.update(ref, {
          status: "cancelled", cancelReason: reason, cancelledBy: by, cancelledAt: serverTimestamp(),
          stepsOpen: 0, ownerIds: [], openToAll: false, updatedAt: serverTimestamp(), updatedBy: by,
          events: arrayUnion({ at: new Date().toISOString(), by, action: declined ? "Declined" : "Cancelled", note: reason }),
        });
      });
      showToast(declined ? "Refund declined" : "Refund cancelled");
      if (r.method === "bank") maskBank().catch(() => {});
    } catch (ex) {
      console.error("Refund not cancelled:", ex);
      showToast(ex.code === "permission-denied" ? "Only the person who asked, the approver or an Admin can cancel it." : ex.message || "Couldn't cancel. Try again.");
    }
  }

  async function resend(key, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const res = await callApi({ action: "refunds", op: "resendStep", id, key });
      if (!res || res.problem) throw new Error((res && res.problem) || "Not sent.");
      showToast(`Emailed ${res.to}`);
      btn.textContent = "Sent ✓";
    } catch (ex) {
      console.warn("Resend failed:", ex);
      showToast(ex.code === "FORBIDDEN" ? "Only the person who asked for the refund, or an Admin, can resend it."
        : ex.message || "Couldn't send. Try again.");
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a || !r) return;
    if (a.dataset.act === "pk") {
      const [i, f] = a.dataset.pk.split(".");
      const pk = pickFor(+i, r.items[+i]);
      pk[f] = a.dataset.v;
      if (f === "loc") pk.lot = "";
      draw();
      return;
    }
    if (a.dataset.act === "put") { saveLine(+a.dataset.i, a); return; }
    if (a.dataset.act === "done") complete(a.dataset.k, a);
    else if (a.dataset.act === "decline") cancel(true);
    else if (a.dataset.act === "cancel") cancel(false);
    else if (a.dataset.act === "resend") resend(a.dataset.k, a);
    else if (a.dataset.act === "copy") navigator.clipboard.writeText(a.dataset.v).then(() => showToast("Copied")).catch(() => showToast("Couldn't copy"));
  });
  // Batch typed in, or a batch chosen, for a returned product
  root.addEventListener("input", (e) => {
    const k = e.target.dataset.pk;
    if (!k || e.target.tagName === "SELECT" || !r) return;
    const [i, f] = k.split(".");
    pickFor(+i, r.items[+i])[f] = e.target.value;
  });
  root.addEventListener("change", (e) => {
    const k = e.target.dataset.pk;
    if (!k || !r) return;
    const [i, f] = k.split(".");
    pickFor(+i, r.items[+i])[f] = e.target.value;
    if (e.target.tagName === "SELECT") draw();
  });

  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.dataset.sv) return;
    const btn = root.querySelector(`[data-act="done"][data-k="${e.target.dataset.sv}"]`);
    if (btn) { e.preventDefault(); btn.click(); }
  });
}

/* ===================== Settings ===================== */
async function mountSettings(container, { staff }) {
  const root = document.createElement("section");
  root.className = "page wide rf";
  container.replaceChildren(root);
  if (!boss()) { root.innerHTML = '<div class="rf-empty"><strong>No access</strong>Only Admins can change refund settings.</div>'; return; }
  root.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
  const [set, people] = await Promise.all([loadSettings(), staffList().catch(() => [])]);
  if (!root.isConnected) return;
  const guess = (cur, re) => cur || ((people.find((p) => re.test(p.name)) || {}).id || "");
  const pick = (name, cur, anyText) => `<select class="fb-select" name="${name}"><option value="">${esc(anyText)}</option>${people.map((p) =>
    `<option value="${esc(p.id)}"${p.id === cur ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;
  const row = (title, sub, control) => `<div class="rf-setrow"><div><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ""}</div>${control}</div>`;
  root.innerHTML = `
    <a class="tm-back" href="#/refunds">${I.back}<span>Refunds</span></a>
    <div class="fb-head"><div><h2>Refund settings</h2><p class="muted">Who does each step. They get a task on their dashboard for every refund.</p></div></div>
    <form class="rf-set" novalidate>
      <section class="rf-box2"><h4>Who does what</h4>
        ${row("Bank transfers", "Pays bank transfer refunds and enters the reference.", pick("bankId", guess(set.bankId, /joanna/i), "Choose someone"))}
        ${row("Timely", "Adds account credit, records refunds and voids product sales.", pick("timelyId", guess(set.timelyId, /bethany/i), "Choose someone"))}
        ${row("Cash refunds", "Hands over the cash when it wasn't given at the time.", pick("cashId", set.cashId, "Anyone at the desk"))}
        ${row("Returned products", "Puts returned products back, or sets them aside.", pick("onsiteId", set.onsiteId, "Anyone onsite"))}
      </section>
      <section class="rf-box2"><h4>Checks</h4>
        ${row("Record bank transfers in Timely too", "After the transfer, Timely gets a step to record it.",
          `<label class="fe-check"><input type="checkbox" name="recordBank"${set.recordBank !== false ? " checked" : ""}> Yes</label>`)}
        ${row("Refunds that need approval", "Refunds over this amount wait for approval first. Leave it empty for no approval.",
          `<span class="rf-money"><em>$</em><input class="fe-input" name="approveOver" inputmode="decimal" value="${esc(set.approveOver ?? "")}" placeholder="No approval"></span>`)}
        ${row("Approved by", "", pick("approverId", set.approverId, "Choose someone"))}
      </section>
      <p class="lh-error" hidden></p>
      <div class="lh-actions"><button class="btn-primary" type="submit">Save</button></div>
    </form>`;
  const form = root.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form.elements;
    const err = form.querySelector(".lh-error");
    const nm = (v) => (people.find((p) => p.id === v) || {}).name || "";
    const over = f.approveOver.value.trim() === "" ? null : num(f.approveOver.value);
    if (over !== null && !f.approverId.value) { err.textContent = "Choose who approves refunds over that amount."; err.hidden = false; return; }
    err.hidden = true;
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await setDoc(doc(db, "refund_settings", "config"), {
        bankId: f.bankId.value, bankName: nm(f.bankId.value), timelyId: f.timelyId.value, timelyName: nm(f.timelyId.value),
        cashId: f.cashId.value, cashName: nm(f.cashId.value), onsiteId: f.onsiteId.value, onsiteName: nm(f.onsiteId.value),
        approverId: f.approverId.value, approverName: nm(f.approverId.value), approveOver: over, recordBank: f.recordBank.checked,
        updatedAt: serverTimestamp(), updatedBy: nameOf(staff),
      }, { merge: true });
      showToast("Refund settings saved");
    } catch (ex) {
      console.error("Settings not saved:", ex);
      err.textContent = "Couldn't save. Try again.";
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ===================== Reports ===================== */
const PERIODS = { month: "This month", last: "Last month", d90: "Last 90 days", year: "This year" };
function periodRange(k) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const end = new Date(Date.now() + 60000);
  if (k === "last") return [new Date(y, m - 1, 1), new Date(y, m, 1)];
  if (k === "d90") return [new Date(Date.now() - 90 * 864e5), end];
  if (k === "year") return [new Date(y, 0, 1), end];
  return [new Date(y, m, 1), end];
}
function groupSum(list, keyFn, valFn) {
  const m = new Map();
  list.forEach((x) => {
    const k = keyFn(x);
    if (!k) return;
    const g = m.get(k) || { k, v: 0, n: 0, x };
    g.v = round2(g.v + valFn(x));
    g.n += 1;
    m.set(k, g);
  });
  return [...m.values()].sort((a, b) => b.v - a.v);
}
const bars = (rows, fmt) => {
  if (!rows.length) return '<p class="muted rf-wait">Nothing in this period.</p>';
  const max = Math.max(1, ...rows.map((r) => r.v));
  return `<div class="rf-bars">${rows.slice(0, 10).map((r) => `<div class="rf-bar"><span title="${esc(r.k)}">${esc(r.k)}</span>
    <i><b style="width:${Math.max(3, Math.round((r.v / max) * 100))}%"></b></i><em>${fmt(r)}</em></div>`).join("")}</div>`;
};

async function mountReport(container) {
  const root = document.createElement("section");
  root.className = "page wide rf";
  container.replaceChildren(root);
  if (!canReport()) { root.innerHTML = '<div class="rf-empty"><strong>No access</strong>Ask an Admin for Reporting access.</div>'; return; }
  let period = "month";
  root.innerHTML = `${headHtml()}${tabsHtml("report")}
    <div class="rf-rtools"><select class="fb-select" data-role="period" aria-label="Period">${Object.entries(PERIODS).map(([k, l]) =>
      `<option value="${k}">${l}</option>`).join("")}</select></div>
    <div data-role="body"><div class="skeleton" style="height:240px;border-radius:14px"></div></div>`;
  const body = root.querySelector('[data-role="body"]');
  const [products, suppliers] = await Promise.all([listProducts().catch(() => []), listSuppliers().catch(() => [])]);
  const prodBy = new Map(products.map((p) => [p.id, p]));
  const supName = new Map(suppliers.map((s) => [s.id, s.name]));
  const supplierOf = (it) => supName.get((prodBy.get(it.productId) || {}).supplierId) || "No supplier set";

  async function load() {
    const [from, to] = periodRange(period);
    body.innerHTML = '<div class="skeleton" style="height:240px;border-radius:14px"></div>';
    try {
      const col = collection(db, "refunds");
      const [snap, openSnap] = await Promise.all([
        getDocs(query(col, where("createdAt", ">=", Timestamp.fromDate(from)))),
        getDocs(query(col, where("status", "==", "open"))),
      ]);
      if (!root.isConnected) return;
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => ms(r.createdAt) < to.getTime());
      const live = all.filter((r) => r.status !== "cancelled");
      const openNow = openSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const total = round2(live.reduce((a, r) => a + (Number(r.total) || 0), 0));
      const finished = all.filter((r) => r.status === "done" && r.completedAt && r.createdAt);
      const avgDays = finished.length
        ? Math.round((finished.reduce((a, r) => a + (ms(r.completedAt) - ms(r.createdAt)), 0) / finished.length / 864e5) * 10) / 10 : null;
      const items = live.flatMap((r) => (r.items || []).map((it) => ({ ...it })));
      const faulty = items.filter((it) => it.kind === "product" && it.condition === "faulty");
      const overdue = openNow.flatMap((r) => (r.steps || []).filter((s) => !s.done && !waiting(r.steps, s) && s.dueDate && s.dueDate < dayKey()));
      const cancelled = all.length - live.length;

      const tile = (label, value, sub = "", tone = "") => `<div class="rf-tile${tone ? ` is-${tone}` : ""}"><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
      const card = (title, inner, wide = false) => `<section class="rf-box2${wide ? " rf-span2" : ""}"><h4>${title}</h4>${inner}</section>`;
      const faultyRows = groupSum(faulty, (it) => it.name, (it) => it.qty || 1);

      body.innerHTML = `
        <div class="rf-tiles">
          ${tile("Refunds", live.length, cancelled ? `${cancelled} cancelled or declined` : "")}
          ${tile("Total refunded", money(total))}
          ${tile("Average refund", live.length ? money(total / live.length) : "—")}
          ${tile("Open now", openNow.length, overdue.length ? `${overdue.length} step${overdue.length === 1 ? "" : "s"} overdue` : "", overdue.length ? "bad" : "")}
          ${tile("Average days to finish", avgDays === null ? "—" : avgDays)}
        </div>
        <div class="rf-rgrid">
          ${card("How it was paid back", bars(groupSum(live, (r) => (METHODS[r.method] || {}).label, (r) => r.total), (g) => `${money(g.v)} · ${g.n}`))}
          ${card("What was refunded", bars(groupSum(items, (it) => (KINDS[it.kind] || {}).label, (it) => it.amount), (g) => `${money(g.v)} · ${g.n}`))}
          ${card("Reasons", bars(groupSum(items, (it) => it.reason || "Not given", (it) => it.amount), (g) => `${g.n} · ${money(g.v)}`))}
          ${card("Faulty products by supplier", bars(groupSum(faulty, supplierOf, (it) => it.qty || 1), (g) => `${g.v} item${g.v === 1 ? "" : "s"}`))}
          ${card("Faulty products", faultyRows.length ? `<table class="inv-table rf-rtable"><thead><tr><th>Product</th><th>Supplier</th><th>Items</th></tr></thead><tbody>${
            faultyRows.slice(0, 15).map((g) => `<tr><td>${esc(g.k)}</td><td>${esc(supplierOf(g.x))}</td><td>${g.v}</td></tr>`).join("")}</tbody></table>`
            : '<p class="muted rf-wait">No faulty products in this period.</p>')}
          ${card("Steps overdue now", bars(groupSum(overdue, (s) => s.whoName || "Anyone", () => 1), (g) => `${g.v}`))}
        </div>
        <h3 class="rf-rh">Refunds in this period</h3>
        <div class="rf-list">${all.length ? all.sort((a, b) => ms(b.createdAt) - ms(a.createdAt)).map(cardHtml).join("")
          : '<div class="rf-empty"><strong>No refunds in this period</strong></div>'}</div>`;
    } catch (err) {
      console.error("Refund report not loaded:", err);
      body.innerHTML = '<div class="rf-empty"><strong>Couldn\'t load the report</strong>Check your connection and try again.</div>';
    }
  }
  root.querySelector('[data-role="period"]').addEventListener("change", (e) => { period = e.target.value; load(); });
  load();
}

/* ===================== Patient emails (Settings) ===================== */
// Rich text: headings, bold, lists, colours, links and pictures. The top of each email is the clinic letterhead
// (Form Builder → Letterhead), the logo, or nothing. Pictures are kept inside the email and sent with it.
const LOOKS = [
  ["letterhead", "Clinic letterhead", "The logo, name and lines from Form Builder → Letterhead"],
  ["logo", "Logo only", "The clinic logo at the top"],
  ["none", "Nothing", "Starts with your message"],
];
const TB = {
  ul: ic('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  ol: ic('<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><path d="M4 5h1v4"/><path d="M4 14.5a1 1 0 0 1 2 .5c0 .8-2 1.5-2 3h2"/>'),
  left: ic('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>'),
  center: ic('<line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>'),
  right: ic('<line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>'),
  link: ic('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  image: ic('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  line: ic('<line x1="3" y1="12" x2="21" y2="12"/>'),
  clear: ic('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/><line x1="3" y1="21" x2="21" y2="3"/>'),
};

// The same look as Refunds.gs (rfStyled_ / rfLetterheadHtml_ / rfPatientHtml_), for the preview
const MAIL_STYLE = {
  h1: "margin:0 0 12px;font-size:24px;line-height:1.3;color:#0f172a", h2: "margin:0 0 10px;font-size:20px;line-height:1.3;color:#0f172a",
  h3: "margin:0 0 8px;font-size:17px;line-height:1.35;color:#0f172a", p: "margin:0 0 12px",
  ul: "margin:0 0 12px;padding-left:22px", ol: "margin:0 0 12px;padding-left:22px",
  blockquote: "margin:0 0 12px;padding-left:12px;border-left:3px solid #cbd5e1;color:#475569",
  hr: "border:0;border-top:1px solid #e2e8f0;margin:18px 0", img: "max-width:100%;height:auto",
};
const mailStyled = (html) => String(html || "").replace(/<(h1|h2|h3|p|ul|ol|blockquote|hr|img)\b([^>]*)>/gi, (m, tag, attrs) => {
  const st = MAIL_STYLE[tag.toLowerCase()];
  const a = attrs.replace(/\s*\/\s*$/, "");
  return /\sstyle\s*=\s*"/i.test(a) ? `<${tag}${a.replace(/style\s*=\s*"([^"]*)"/i, (x, v) => `style="${st};${v}"`)}>` : `<${tag}${a} style="${st}">`;
});
function letterheadHtml(lh) {
  if (!lh) return "";
  const center = /center/i.test(String(lh.layout || ""));
  const size = Math.min(120, Math.max(30, Number(lh.logoSize) || 60));
  const logo = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(String(lh.logo || ""))
    ? `<img src="${lh.logo}" alt="" style="max-height:${size}px;max-width:260px;display:block;margin:${center ? "0 auto 8px" : "0 0 8px"}">` : "";
  const name = lh.showName !== false && lh.name ? `<div style="font-size:20px;font-weight:bold;color:#0f172a">${esc(lh.name)}</div>` : "";
  const lines = [lh.line1, lh.line2].filter(Boolean).map((l) => `<div style="font-size:12px;color:#64748b">${esc(l)}</div>`).join("");
  return logo || name || lines
    ? `<div style="text-align:${center ? "center" : "left"};padding-bottom:14px;margin-bottom:20px;border-bottom:1px solid #e2e8f0">${logo}${name}${lines}</div>` : "";
}
function mailPage(inner, look, lh) {
  let head = look === "letterhead" ? letterheadHtml(lh) : "";
  if (!head && look !== "none") {
    head = '<p style="margin:0 0 18px"><span style="display:inline-block;padding:10px 16px;border:1px dashed #cbd5e1;border-radius:8px;color:#94a3b8;font-size:12px">Clinic logo</span></p>';
  }
  return `<div style="margin:0;padding:24px 12px;background:#f1f5f9"><div style="max-width:600px;margin:0 auto;padding:28px 30px;background:#fff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1e293b">${head}${mailStyled(inner)}</div></div>`;
}
const SAMPLE = {
  "first name": "Sarah", "full name": "Sarah Smith", "refund number": "RF-TEST01", amount: "$120.00",
  items: "• Product: ZO Daily Power Defense ($120.00)", "refund method": "Bank transfer", reference: "123456789", "clinic phone": "(08) 9000 0000",
  "refund breakdown": "Package: Skin Peel Course x4\nPaid $1,998.00\nLess 1 × Clear Complexion Lite (regular price $450.00): −$450.00\n"
    + "Less 2 × Brightening peel (regular price $330.00 each): −$660.00\nRefund: $888.00",
};
const sampleOf = (k) => SAMPLE[String(k).replace(/&nbsp;|\s+/g, " ").trim().toLowerCase()];
const fillSampleHtml = (html) => String(html).replace(/\{([^{}<>]{1,40})\}/g, (m, k) => { const v = sampleOf(k); return v === undefined ? "" : esc(v).replace(/\n/g, "<br>"); });
const fillSampleText = (s) => String(s).replace(/\{([^{}]{1,40})\}/g, (m, k) => sampleOf(k) ?? "");

// A picture from the device, made small enough to send (800 px wide at most)
function readPicture(file, maxW = 800) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { reject(new Error("Choose a PNG or JPG picture.")); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.naturalWidth);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const draw = (bg) => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const g = c.getContext("2d");
        if (bg) { g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); }
        g.drawImage(img, 0, 0, w, h);
        return c;
      };
      let src = file.type === "image/png" ? draw(false).toDataURL("image/png") : "";
      if (!src || src.length > 250000) src = draw(true).toDataURL("image/jpeg", 0.82);   // big PNGs become JPGs on white
      URL.revokeObjectURL(url);
      resolve({ src, w });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That picture couldn't be read.")); };
    img.src = url;
  });
}

const toolbarHtml = (blanks) => {
  const b = (cmd, inner, title) => `<button type="button" class="rf-tb" data-cmd="${cmd}" title="${title}" aria-label="${title}">${inner}</button>`;
  return `<div class="rf-tbar" role="toolbar" aria-label="Formatting">
    <select class="fb-select rf-tb-sel" data-cmd="block" aria-label="Text style">
      <option value="">Text style…</option><option value="h1">Big heading</option><option value="h2">Heading</option>
      <option value="h3">Small heading</option><option value="p">Normal text</option></select>
    <span class="rf-tb-sep"></span>
    ${b("bold", "<b>B</b>", "Bold")}${b("italic", "<i>I</i>", "Italic")}${b("underline", "<u>U</u>", "Underline")}
    <label class="rf-tb rf-tb-color" title="Text colour"><span>A</span><input type="color" data-cmd="color" value="#0f766e" aria-label="Text colour"></label>
    <span class="rf-tb-sep"></span>
    ${b("insertUnorderedList", TB.ul, "Bulleted list")}${b("insertOrderedList", TB.ol, "Numbered list")}
    ${b("justifyLeft", TB.left, "Align left")}${b("justifyCenter", TB.center, "Centre")}${b("justifyRight", TB.right, "Align right")}
    <span class="rf-tb-sep"></span>
    ${b("link", TB.link, "Add a link")}
    <label class="rf-tb" title="Add a picture" aria-label="Add a picture">${TB.image}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-cmd="image" hidden></label>
    ${b("insertHorizontalRule", TB.line, "Dividing line")}${b("removeFormat", TB.clear, "Clear formatting")}
    <span class="rf-tb-sep"></span>
    <select class="fb-select rf-tb-sel" data-cmd="blank" aria-label="Insert a blank"><option value="">Insert a blank…</option>${
      blanks.map((x) => `<option value="${esc(x)}">{${esc(x)}}</option>`).join("")}</select>
  </div>
  <div class="rf-imgbar" data-role="imgbar" hidden><span>Picture:</span>
    <button type="button" class="lh-btn is-quiet" data-img="30">Small</button>
    <button type="button" class="lh-btn is-quiet" data-img="60">Medium</button>
    <button type="button" class="lh-btn is-quiet" data-img="100">Full width</button>
    <button type="button" class="lh-btn is-quiet" data-img="center">Centre</button>
    <button type="button" class="lh-btn is-quiet" data-img="left">Left</button>
    <button type="button" class="lh-btn is-quiet" data-img="remove">Remove</button>
  </div>`;
};

async function mountEmails(container) {
  const root = document.createElement("section");
  root.className = "page rf";
  container.replaceChildren(root);
  if (!boss()) { root.innerHTML = '<div class="rf-empty"><strong>No access</strong>Ask an Admin for Refunds settings access.</div>'; return; }
  root.innerHTML = `${headHtml()}<div data-role="body"><div class="skeleton" style="height:240px;border-radius:14px"></div></div>`;
  const body = root.querySelector('[data-role="body"]');
  let data, lh = null;
  try {
    [data, lh] = await Promise.all([
      callApi({ action: "refunds", op: "emails" }),
      getDoc(doc(db, "form_settings", "letterhead")).then((s) => (s.exists() ? s.data() : null)).catch(() => null),
    ]);
    if (!data || !data.templates) throw new Error((data && data.problem) || "");
  } catch (err) {
    body.innerHTML = `<div class="rf-empty"><strong>Couldn't load the emails</strong>${esc(err.message || "Try again.")}</div>`;
    return;
  }
  if (!root.isConnected) return;
  const keys = ["received", "transfer", "credit"];
  const when = {
    received: "Sent when a refund request is saved. Not sent when cash was already handed over.",
    transfer: "Sent when the bank transfer is marked done. {Reference} is the transfer reference.",
    credit: "Sent when the account credit is marked done in Timely.",
  };
  const t = data.templates;
  let look = data.look || "logo";
  let dirty = false;
  const hasLh = !!letterheadHtml(lh);

  body.innerHTML = `
    <section class="rf-box2"><h4>Top of every email</h4>
      <div class="rf-looks">${LOOKS.map(([k, l, s]) => `<button type="button" class="rf-lookbtn${look === k ? " is-on" : ""}" data-act="look" data-v="${k}"
        aria-pressed="${look === k}"><strong>${l}</strong><small>${esc(s)}</small></button>`).join("")}</div>
      <p class="rf-hint" data-role="lhnote"${look === "letterhead" && !hasLh ? "" : " hidden"}>No letterhead is set up yet, so the logo is used for now.
        Set one up in Form Builder → Letterhead.</p>
    </section>
    <p class="muted rf-mh">These go to the patient. Use <strong>Insert a blank</strong> to add their name, the amount and so on.</p>
    ${keys.map((k) => `<section class="rf-box2 rf-mail" data-k="${k}">
      <div class="rf-mail-head"><h4>${esc(t[k].label)}</h4>
        <label class="rf-mail-on"><input type="checkbox" data-f="on"${t[k].on ? " checked" : ""}> Send it</label></div>
      <p class="muted">${esc(when[k])}</p>
      <label class="rf-mail-f">Subject<input class="fe-input" data-f="subject" maxlength="200" value="${esc(t[k].subject)}"></label>
      ${toolbarHtml(data.blanks || [])}
      <div class="rf-ed" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="${esc(t[k].label)} message"></div>
      <div class="rf-step-row">
        <button type="button" class="btn-ghost" data-act="preview">Preview</button>
        <button type="button" class="btn-ghost" data-act="test">Send a test to me</button>
        <button type="button" class="btn-ghost" data-act="reset">Use the original wording</button>
      </div>
    </section>`).join("")}
    <div class="rf-savebar"><span class="rf-dirty" data-role="dirty" hidden>Unsaved changes</span>
      <button type="button" class="btn-primary" data-act="save">Save</button></div>`;

  const box = (k) => body.querySelector(`[data-k="${k}"]`);
  keys.forEach((k) => { box(k).querySelector(".rf-ed").innerHTML = t[k].html || ""; });
  const setDirty = (v = true) => { dirty = v; body.querySelector('[data-role="dirty"]').hidden = !v; };
  const read = (k) => {
    const ed = box(k).querySelector(".rf-ed").cloneNode(true);
    ed.querySelectorAll(".is-sel").forEach((n) => n.classList.remove("is-sel"));
    ed.querySelectorAll('[class=""]').forEach((n) => n.removeAttribute("class"));
    return {
      on: box(k).querySelector('[data-f="on"]').checked,
      subject: box(k).querySelector('[data-f="subject"]').value,
      html: ed.innerHTML.trim(),
    };
  };

  // Where the cursor was in each editor, so toolbar buttons, menus and pictures go in the right place
  let saved = null;
  const onSel = () => {
    if (!root.isConnected) { document.removeEventListener("selectionchange", onSel); return; }
    const s = document.getSelection();
    if (!s || !s.rangeCount) return;
    const r0 = s.getRangeAt(0);
    const node = r0.commonAncestorContainer.nodeType === 1 ? r0.commonAncestorContainer : r0.commonAncestorContainer.parentElement;
    const ed = node && node.closest ? node.closest(".rf-ed") : null;
    if (ed && body.contains(ed)) saved = { ed, range: r0.cloneRange() };
  };
  document.addEventListener("selectionchange", onSel);
  const restore = (ed) => {
    ed.focus({ preventScroll: true });
    const s = document.getSelection();
    s.removeAllRanges();
    if (saved && saved.ed === ed && ed.contains(saved.range.commonAncestorContainer)) s.addRange(saved.range);
    else { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); s.addRange(r); }
  };
  const exec = (ed, cmd, val = null) => {
    restore(ed);
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older browsers */ }
    document.execCommand("styleWithCSS", false, cmd === "foreColor" || /^justify/.test(cmd));
    document.execCommand(cmd, false, val);
    onSel();
    setDirty();
  };

  // A picture tapped in the editor: its size bar shows
  let selImg = null;
  const selectImg = (img) => {
    body.querySelectorAll(".rf-ed img.is-sel").forEach((i) => i.classList.remove("is-sel"));
    body.querySelectorAll('[data-role="imgbar"]').forEach((b) => { b.hidden = true; });
    selImg = img;
    if (!img) return;
    img.classList.add("is-sel");
    img.closest(".rf-mail").querySelector('[data-role="imgbar"]').hidden = false;
  };

  function addLink(ed) {
    const url = (window.prompt("Link address (https://…, mailto: or tel:)", "https://") || "").trim();
    if (!url || url === "https://") return;
    if (!/^(https?:\/\/|mailto:|tel:)\S+$/i.test(url)) { showToast("Links start with https://, mailto: or tel:"); return; }
    restore(ed);
    const s = document.getSelection();
    if (s.isCollapsed) exec(ed, "insertHTML", `<a href="${esc(url)}">${esc(url.replace(/^(mailto:|tel:)/i, ""))}</a>`);
    else exec(ed, "createLink", url);
  }

  function preview(k) {
    const x = read(k);
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog rf-prev-dlg";
    dlg.innerHTML = `<div class="lh-form">
      <div class="lh-dialog-head"><h3>${esc(fillSampleText(x.subject) || "No subject")}</h3><p>How it looks to the patient, with example details.</p></div>
      <iframe class="rf-prev-frame" sandbox="" title="Email preview"></iframe>
      <div class="lh-actions"><button type="button" class="lh-btn is-primary" data-act="close">Close</button></div></div>`;
    dlg.querySelector('[data-act="close"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.querySelector("iframe").srcdoc = `<!doctype html><html><body style="margin:0">${mailPage(fillSampleHtml(x.html), look, lh)}</body></html>`;
    dlg.showModal();
  }

  // Toolbar buttons keep the cursor in the editor
  body.addEventListener("mousedown", (e) => { if (e.target.closest("button[data-cmd], [data-img]")) e.preventDefault(); });
  // Pasting from Word or a website: the words only, so the email keeps its own look
  body.addEventListener("paste", (e) => {
    if (!e.target.closest(".rf-ed")) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, text);
  });
  body.addEventListener("drop", (e) => { if (e.target.closest(".rf-ed")) e.preventDefault(); });
  body.addEventListener("input", (e) => {
    if (e.target.closest(".rf-ed") || e.target.dataset.f === "subject") setDirty();
  });

  body.addEventListener("change", async (e) => {
    const t2 = e.target;
    const mail = t2.closest(".rf-mail");
    if (t2.dataset.f === "on") { setDirty(); return; }
    if (!mail || !t2.dataset.cmd) return;
    const ed = mail.querySelector(".rf-ed");
    if (t2.dataset.cmd === "block") { if (t2.value) exec(ed, "formatBlock", `<${t2.value}>`); t2.value = ""; return; }
    if (t2.dataset.cmd === "blank") { if (t2.value) exec(ed, "insertText", `{${t2.value}}`); t2.value = ""; return; }
    if (t2.dataset.cmd === "color") {
      t2.closest(".rf-tb-color").style.setProperty("--rf-c", t2.value);
      exec(ed, "foreColor", t2.value);
      return;
    }
    if (t2.dataset.cmd === "image") {
      const file = t2.files && t2.files[0];
      t2.value = "";
      if (!file) return;
      try {
        const pic = await readPicture(file);
        exec(ed, "insertHTML", `<img src="${pic.src}" alt="" style="width:${Math.min(pic.w, 560)}px;max-width:100%;height:auto">`);
      } catch (ex) { showToast(ex.message || "That picture couldn't be added."); }
    }
  });

  body.addEventListener("click", async (e) => {
    const img = e.target.closest(".rf-ed img");
    if (img) { selectImg(img); return; }
    const ib = e.target.closest("[data-img]");
    if (ib && selImg) {
      const v = ib.dataset.img;
      if (v === "remove") { selImg.remove(); selectImg(null); }
      else if (v === "center") { selImg.style.display = "block"; selImg.style.margin = "0 auto 12px"; }
      else if (v === "left") { selImg.style.display = ""; selImg.style.margin = ""; }
      else { selImg.style.width = `${v}%`; selImg.style.maxWidth = "100%"; selImg.style.height = "auto"; }
      setDirty();
      return;
    }
    if (e.target.closest(".rf-ed")) { if (selImg) selectImg(null); return; }

    const cb = e.target.closest("button[data-cmd]");
    if (cb) {
      const ed = cb.closest(".rf-mail").querySelector(".rf-ed");
      if (cb.dataset.cmd === "link") addLink(ed);
      else exec(ed, cb.dataset.cmd);
      return;
    }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const k = a.closest("[data-k]")?.dataset.k;
    if (a.dataset.act === "look") {
      look = a.dataset.v;
      body.querySelectorAll('[data-act="look"]').forEach((b) => {
        b.classList.toggle("is-on", b === a);
        b.setAttribute("aria-pressed", String(b === a));
      });
      body.querySelector('[data-role="lhnote"]').hidden = !(look === "letterhead" && !hasLh);
      setDirty();
      return;
    }
    if (a.dataset.act === "preview") { preview(k); return; }
    if (a.dataset.act === "reset") {
      if (!(await confirmDialog({
        title: "Use the original wording?", message: "This email's subject and message go back to how they first were. Nothing is saved until you press Save.",
        confirmLabel: "Use the original", tone: "warning",
      }))) return;
      box(k).querySelector('[data-f="subject"]').value = data.defaults[k].subject;
      box(k).querySelector(".rf-ed").innerHTML = data.defaults[k].html;
      setDirty();
      return;
    }
    a.disabled = true;
    const label = a.textContent;
    try {
      if (a.dataset.act === "test") {
        a.textContent = "Sending…";
        const x = read(k);
        const r = await callApi({ action: "refunds", op: "testEmail", key: k, subject: x.subject, html: x.html, look });
        if (!r || r.problem) throw new Error((r && r.problem) || "The test wasn't sent.");
        showToast(`Test sent to ${r.to}`);
      } else if (a.dataset.act === "save") {
        a.textContent = "Saving…";
        const emails = {};
        keys.forEach((x) => { emails[x] = read(x); });
        const size = keys.reduce((n, x) => n + emails[x].html.length, 0);
        if (size > 850000) throw new Error("The emails have too many pictures between them. Remove one or two, or use smaller ones.");
        const r = await callApi({ action: "refunds", op: "saveEmails", emails, look });
        if (!r || r.problem) throw new Error((r && r.problem) || "Not saved.");
        setDirty(false);
        showToast("Patient emails saved");
      }
    } catch (err) {
      showToast(err.message || "Couldn't do that. Try again.");
    } finally {
      a.disabled = false;
      a.textContent = label;
    }
  });

  // Leaving with unsaved changes: the browser asks first
  const onUnload = (e) => {
    if (!root.isConnected) { window.removeEventListener("beforeunload", onUnload); return; }
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  };
  window.addEventListener("beforeunload", onUnload);
}