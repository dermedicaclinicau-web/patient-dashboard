// Billing check: each scanned billing sheet (what staff wrote was given) against that patient's Timely invoice
// the same day (what was charged, and taken off the Shelf). Only from the invoice start date on.
import { db, auth } from "./firebase-config.js";
import { collection, doc, getDoc, getDocs, query, where, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getInvoiceSettings, dayKey } from "./inventory-api.js";

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const nameWords = (s) => String(s || "").toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter((w) => w.length > 1);
// "Smith Jane" = "Jane Smith"; the short key ignores middle names ("Jane A Smith" = "Jane Smith")
const fullKey = (s) => nameWords(s).sort().join(" ");
const shortKey = (s) => { const w = nameWords(s); return (w.length > 2 ? [w[0], w[w.length - 1]] : w).sort().join(" "); };
const addDays = (k, n) => { const [y, m, d] = k.split("-").map(Number); return dayKey(new Date(y, m - 1, d + n)); };
const slugKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

export const BC_TYPES = {
  given: { label: "Given, not invoiced", tone: "bad",
    help: "On the billing sheet but not on the invoice: it left the Shelf without being charged, and stock wasn't taken off. Add it to the invoice in Timely, or note why (e.g. a sample)." },
  qty: { label: "Quantity differs", tone: "warn",
    help: "The billing sheet and the invoice have different quantities. Check which is right." },
  invoiced: { label: "Invoiced, not on the sheet", tone: "warn",
    help: "Charged on the invoice but not written on the billing sheet. Check the patient got it, and that the sheet was filled in." },
  nosheet: { label: "No billing sheet scanned", tone: "info",
    help: "Products were invoiced, but no billing sheet was scanned for this patient that day." },
};

// fromKey / toKey: "YYYY-MM-DD" (both included). productId: only that product (the investigation page).
// Returns { started, startDate, from, to, upTo, items, okCount, waiting }
export async function billingCheck({ fromKey, toKey, productId = "" }) {
  const cfg = await getInvoiceSettings();
  const out = { started: !!cfg.startDate, startDate: cfg.startDate, from: fromKey, to: toKey, upTo: "", items: [], okCount: 0, waiting: 0 };
  if (!cfg.startDate || !KEY_RE.test(fromKey || "") || !KEY_RE.test(toKey || "")) return out;
  const from = fromKey < cfg.startDate ? cfg.startDate : fromKey;
  out.from = from;
  if (toKey < from) return out;

  const [up, saleSnap, scanSnap, checkSnap] = await Promise.all([
    getDoc(doc(db, "data_uploads", "invoices")).catch(() => null),
    getDocs(query(collection(db, "inv_sales"), where("apptDate", ">=", from), where("apptDate", "<=", toKey))),
    getDocs(query(collection(db, "scans"), where("dateKey", ">=", from), where("dateKey", "<=", addDays(toKey, 7)))),
    getDocs(query(collection(db, "inv_billing_checks"), where("day", ">=", from), where("day", "<=", toKey))).catch(() => ({ docs: [] })),
  ]);
  const sales = saleSnap.docs.map((d) => d.data()).filter((s) => (s.source === "invoice" || s.source === "manual") && !s.voided);
  const upData = up && up.exists() ? up.data() : {};
  // The latest invoice day uploaded (hand-recorded sales don't count): sheets after it are still waiting for their invoice
  out.upTo = [KEY_RE.test(upData.to || "") ? upData.to : "",
    ...sales.filter((s) => s.source === "invoice").map((s) => s.apptDate || "")].sort().pop() || "";
  const checks = new Map(checkSnap.docs.map((d) => [d.id, d.data()]));

  // One group per day + patient
  const groups = new Map();
  const group = (day, name) => {
    let g = groups.get(`${day}|${fullKey(name)}`);
    if (!g) { const sk = shortKey(name); g = sk ? [...groups.values()].find((x) => x.day === day && x.short === sk) || null : null; }
    if (!g) {
      g = { day, name: String(name || ""), key: fullKey(name), short: shortKey(name), sheets: [],
        given: new Map(), invoiced: new Map(), invoiceIds: new Set(), staff: new Set() };
      groups.set(`${day}|${g.key}`, g);
    }
    return g;
  };
  const add = (map, pid, name, qty) => { const c = map.get(pid) || { name: "", qty: 0 }; c.qty += qty; c.name = c.name || name || ""; map.set(pid, c); };

  sales.forEach((s) => {
    const g = group(s.apptDate, s.patientName);
    if (s.invoiceId) g.invoiceIds.add(String(s.invoiceId));
    else if (s.source === "manual") g.invoiceIds.add("recorded by hand");
    if (s.provider) g.staff.add(String(s.provider));
    (s.lines || []).forEach((l) => { if (l.productId) add(g.invoiced, l.productId, l.name, Number(l.qty) || 0); });
  });
  scanSnap.docs.forEach((d) => {
    const s = d.data();
    if (s.kind !== "billing" || s.status === "deleted") return;
    const day = KEY_RE.test(s.apptDate || "") ? s.apptDate : s.dateKey;
    if (!day || day < from || day > toKey) return;
    const g = group(day, s.patientName || s.readName);
    g.sheets.push({ id: d.id, by: String(s.by || ""), photoUrl: (s.photo && s.photo.url) || "" });
    if (s.bookedWith) g.staff.add(String(s.bookedWith));
    (s.lines || []).forEach((l) => { const n = Number(l.take) || 0; if (l.productId && n > 0) add(g.given, l.productId, l.productName, n); });
  });

  groups.forEach((g) => {
    new Set([...g.given.keys(), ...g.invoiced.keys()]).forEach((pid) => {
      if (productId && pid !== productId) return;
      const gv = g.given.get(pid), iv = g.invoiced.get(pid);
      const given = gv ? gv.qty : 0, invoiced = iv ? iv.qty : 0;
      let type;
      if (!g.sheets.length) type = "nosheet";
      else if (given && !invoiced) {
        if (!out.upTo || g.day > out.upTo) { out.waiting++; return; }   // that day's invoices aren't uploaded yet
        type = "given";
      } else if (!given && invoiced) type = "invoiced";
      else if (given !== invoiced) type = "qty";
      else { out.okCount++; return; }
      const key = `${g.day}__${slugKey(g.key || g.name)}__${pid}`;
      const c = checks.get(key);
      out.items.push({
        key, type, day: g.day, patientName: g.name || "Name not read", pid,
        productName: (gv && gv.name) || (iv && iv.name) || "Product", given, invoiced,
        sheets: g.sheets, invoiceIds: [...g.invoiceIds], staff: [...g.staff],
        check: c ? { by: String(c.by || ""), note: String(c.note || "") } : null,
      });
    });
  });
  const order = { given: 0, qty: 1, invoiced: 2, nosheet: 3 };
  out.items.sort((a, b) => b.day.localeCompare(a.day) || order[a.type] - order[b.type] || a.patientName.localeCompare(b.patientName));
  return out;
}

// "Mark checked": a note, once per mismatch
export async function markBillingChecked(item, note, staff) {
  const text = String(note || "").trim().slice(0, 500);
  if (!text) throw new Error("Add a note saying what you found.");
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  await setDoc(doc(db, "inv_billing_checks", item.key), {
    day: item.day, productId: item.pid, productName: item.productName, patientName: item.patientName, type: item.type,
    given: item.given, invoiced: item.invoiced, note: text,
    by: String((staff && staff.name) || "").slice(0, 120), byUid: uid, at: serverTimestamp(),
  });
}