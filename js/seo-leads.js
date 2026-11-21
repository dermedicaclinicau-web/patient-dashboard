// seo-leads.js — website enquiries by the page people came in on (seo_state/leads, from SeoLeads.gs)
// Each row: [enquiry date, landing page, how, first page found, outcome bits, date came in, form page, revenue, ad campaign]
// Revenue: what they paid (SALES RECORD, inc GST, whole dollars) from the day they enquired, up to 12 months after.
// It sits on the same row as the outcome, so each patient counts once.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const KIND = { g: "Google search", s: "Other search engines", a: "Google Ads", i: "AI assistants",
  o: "Social media", e: "Email", r: "Other websites", d: "Direct",
  c: "Online chat", b: "Booked directly", p: "Phone call", w: "Web form", x: "Other" };
const FREE = ["g", "s"];
const store = { data: null, job: null };
const np = (p) => {
  let s = String(p || "").split("?")[0].split("#")[0].trim();
  try { s = decodeURIComponent(s); } catch { /* as is */ }
  return s.toLowerCase().replace(/\/+$/, "") || "/";
};
const iso = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(d);
const longDate = (k) => (k ? new Date(k + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");

// "$1,234" (whole dollars)
export const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-AU");

export async function loadLeads() {
  if (store.data) return store.data;
  if (!store.job) {
    store.job = getDoc(doc(db, "seo_state", "leads")).then((s) => {
      if (!s.exists()) return (store.data = { none: true, rows: [] });
      const d = s.data();
      let raw = [];
      try { raw = JSON.parse(d.rows || "[]"); } catch { raw = []; }
      store.data = {
        from: d.from || "", trackFrom: d.trackFrom || "", at: d.at || "",
        revenue: d.revenue === true, through: d.salesThrough || "",
        rows: raw.map((r) => ({
          date: r[0], path: r[1] || "", k: r[2], first: r[3] || "", bits: Number(r[4]) || 0,
          came: r[5] || "", form: r[6] || "", rev: Number(r[7]) || 0, camp: r[8] || "",
        })),
      };
      return store.data;
    }).finally(() => { store.job = null; });
  }
  return store.job;
}
export const peekLeads = () => store.data;
export function clearLeads() { store.data = null; }

function tally(rows) {
  const t = { enq: 0, consult: 0, came: 0, treated: 0, patients: 0, rev: 0, payers: 0, by: {} };
  rows.forEach((r) => {
    t.enq++;
    if (r.bits & 1) t.consult++;
    if (r.bits & 2) t.came++;
    if (r.bits & 4) t.treated++;
    if (r.bits & 8) t.patients++;
    if (r.rev > 0) { t.rev += r.rev; t.payers++; }
    t.by[r.k] = (t.by[r.k] || 0) + 1;
  });
  return t;
}

// The Pages tab: { enq, consult, came, treated, patients, rev, payers } for every page over the last `days` days.
// The Map also carries .revenue (false when the invoice history isn't loaded) and .through (invoices up to this date).
export function leadsByPage(L, days = 365) {
  if (!L || L.none || !L.rows.length) return null;
  const since = iso(new Date(Date.now() - days * 864e5));
  const m = new Map();
  L.rows.forEach((r) => {
    if (!r.path || r.date < since) return;
    const x = m.get(r.path) || { enq: 0, consult: 0, came: 0, treated: 0, patients: 0, rev: 0, payers: 0 };
    x.enq++;
    if (r.bits & 1) x.consult++;
    if (r.bits & 2) x.came++;
    if (r.bits & 4) x.treated++;
    if (r.bits & 8) x.patients++;
    if (r.rev > 0) { x.rev += r.rev; x.payers++; }
    m.set(r.path, x);
  });
  m.revenue = L.revenue === true;
  m.through = L.through || "";
  return m;
}

// For the Overview: enquiries from free search between two dates (null until loaded, or before tracking began)
export function leadsTotals(from, to) {
  const L = store.data;
  if (!L || L.none || !L.rows.length || to < L.from) return null;
  const rows = L.rows.filter((r) => r.path && r.date >= from && r.date <= to && FREE.includes(r.k));
  const t = tally(rows);
  const by = {};
  rows.forEach((r) => { by[r.path] = (by[r.path] || 0) + 1; });
  const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0] || null;
  return { ...t, google: t.by.g || 0, other: t.by.s || 0, top: top ? { path: top[0], n: top[1] } : null, first: L.from };
}

// For the Overview: what people who enquired from a page between two dates have spent since.
// null until loaded, when the invoice history isn't loaded, or when nobody enquired in those dates.
// { rev, payers, enq, ads (spent by people from Google Ads), adsPayers, through }
export function leadsRevenue(from, to) {
  const L = store.data;
  if (!L || L.none || !L.revenue || !L.rows.length) return null;
  const rows = L.rows.filter((r) => r.path && r.date >= from && r.date <= to);
  if (!rows.length) return null;
  const t = tally(rows);
  const ads = rows.filter((r) => r.k === "a" && r.rev > 0);
  return {
    rev: t.rev, payers: t.payers, enq: t.enq,
    ads: ads.reduce((s, r) => s + r.rev, 0), adsPayers: ads.length,
    through: L.through || "",
  };
}

// For the Overview: enquiries no page gets the credit for (chats, bookings, calls, untracked forms), from when tracking began
export function leadsNoPage(from, to) {
  const L = store.data;
  if (!L || L.none || !L.trackFrom) return null;
  const a = from < L.trackFrom ? L.trackFrom : from;
  if (a > to) return null;
  const rows = L.rows.filter((r) => !r.path && r.date >= a && r.date <= to);
  if (!rows.length) return null;
  const t = tally(rows);
  const parts = Object.entries(t.by).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${KIND[k] || k} ${n}`);
  return { n: t.enq, from: a, parts, patients: t.patients };
}

// The page panel: enquiries from people who came in on this page (last 12 months), and what they've spent
export function leadsPageHtml(L, path, h) {
  if (!L || L.none || !L.rows.length) return "";
  const k = np(path);
  const since = iso(new Date(Date.now() - 365 * 864e5));
  const recent = L.rows.filter((r) => r.path && r.date >= since);
  const rows = recent.filter((r) => r.path === k);
  const firstHere = recent.filter((r) => r.first === k && r.path !== k).length;
  const formHere = recent.filter((r) => r.form === k && r.path !== k).length;
  if (!rows.length && !firstHere && !formHere) return "";
  const t = tally(rows);
  const from = L.from > since ? L.from : since;
  const by = Object.entries(t.by).sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${h.esc(KIND[key] || key)} ${n}`).join(" · ");
  const pct = (n) => (t.enq ? ` (${Math.round((n / t.enq) * 100)}%)` : "");
  const ppl = (n) => `${n} ${n === 1 ? "person" : "people"}`;

  let money3 = "";
  if (rows.length && L.revenue) {
    const ads = rows.filter((r) => r.k === "a" && r.rev > 0);
    const adsRev = ads.reduce((s, r) => s + r.rev, 0);
    money3 = `
      <tr><td>Spent so far</td><td><strong>${money(t.rev)}</strong>${t.payers ? ` from ${ppl(t.payers)}` : ""}</td></tr>
      ${t.payers ? `<tr><td>Average per paying patient</td><td>${money(t.rev / t.payers)}</td></tr>` : ""}
      ${adsRev ? `<tr><td>From Google Ads visitors</td><td>${money(adsRev)} from ${ppl(ads.length)}</td></tr>` : ""}`;
  }
  const revNote = !rows.length ? ""
    : L.revenue
      ? `<p class="seo-note" style="margin:6px 0 0">Spent: what they paid from the day they enquired, up to 12 months after (inc GST)${L.through ? `, invoices to ${h.esc(longDate(L.through))}` : ""}.</p>`
      : `<p class="seo-note" style="margin:6px 0 0">What they've spent isn't shown because the invoice history isn't loaded. Load it in Task Manager → Daily uploads → Load invoice history.</p>`;

  return `<div class="seo-ld-panel">
    <div class="seo-row" style="margin:0"><strong>Enquiries from this page</strong>
      <span class="seo-note">people who arrived here, then sent a website enquiry · since ${h.esc(longDate(from))}</span></div>
    ${rows.length ? `<table class="seo-kv">
      <tr><td>Enquiries</td><td><strong>${t.enq}</strong></td></tr>
      <tr><td>Booked a consultation</td><td>${t.consult}${pct(t.consult)}</td></tr>
      <tr><td>Came in</td><td>${t.came}${pct(t.came)}</td></tr>
      <tr><td>Treated</td><td>${t.treated}${pct(t.treated)}</td></tr>
      <tr><td>Became patients</td><td>${t.patients}${pct(t.patients)}</td></tr>${money3}</table>
      <p class="seo-note" style="margin:6px 0 0">How they came: ${by}</p>${revNote}` : ""}
    ${formHere ? `<p class="seo-note" style="margin:6px 0 0">${ppl(formHere)} enquired from this page (a form or the chat) after arriving on another page.</p>` : ""}
    ${firstHere ? `<p class="seo-note" style="margin:6px 0 0">This was also the first page ${ppl(firstHere)} found before enquiring from another page.</p>` : ""}
  </div>`;
}