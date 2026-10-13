// My dashboard (#/home): a personal summary for whoever is logged in.
// Only reads existing data: kits, borrows, JT releases, requests, treatment usage and saved forms.
import { can, isInjector } from "./perms.js";
import {
  listProducts, listAllLots, listKits, listLoans, listReleases, listRequests, listMyUsage, listShortUsage, listPos,
  isKitProduct, kitUnits, expiryState, plural, unitPlural, lowAt, myUid, reqNumber, REQ_STATUS, REL_STATUS, countDue, countLocs, dayKey, listCountsOn,
  listCounts, listShortAll, listInvestigations, listUnrecordedTreatments, getCountSettings, getMyKitDay,
} from "./inventory-api.js";
import { listMySubmissions } from "./form-submissions.js";
import { db } from "./firebase-config.js";
import { doc, getDoc, getDocs, collection, query, where, FieldPath } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showSoapPanel } from "./soap-panel.js";
import { parseRecordDate } from "./transcripts.js";
import { completeReminder } from "./reminders.js";
import { showToast } from "./utils.js";
import { renderDayCard } from "./staff-days.js";
import { openStartOfDayKit } from "./start-of-day.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(+Number(n || 0).toFixed(1));
const DAY = 864e5;
const niceKey = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const shortDay = (d) => (d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : "");
const ICON = {
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  ok: '<polyline points="20 6 9 17 4 12"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
};
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const card = (title, inner, cls = "", link = "") => `
  <section class="md-card ${cls}">
    <div class="md-card-head"><h3>${esc(title)}</h3>${link}</div>
    ${inner}
  </section>`;

const DASH_CARDS = [
  ["attention", "Needs my attention"], ["days", "Start & end of day"], ["appts", "My appointments & notes"], ["tasks", "Tasks"],
  ["kit", "My kit"], ["records", "My records"], ["usage", "What I used"],
  ["requests", "My requests"], ["stock", "Stock I use"], ["overview", "Clinic overview"],
];
const hideKey = (uid) => `dm.dash.hidden.${uid}`;
const readHidden = (uid) => { try { return new Set(JSON.parse(localStorage.getItem(hideKey(uid)) || "[]")); } catch { return new Set(); } };
const writeHidden = (uid, set) => { try { localStorage.setItem(hideKey(uid), JSON.stringify([...set])); } catch { /* private mode */ } };

// Today's appointments for this staff member (matched on their name in the schedule)
async function myAppointments(staff, key) {
  const snap = await getDoc(doc(db, "appts_by_day", key));
  const list = snap.exists() && Array.isArray(snap.data().appointments) ? snap.data().appointments : [];
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const full = norm(staff && staff.name);
  const first = full.split(" ")[0];
  if (!first) return [];
  return list.filter((a) => {
    const n = norm(a.staff);
    return n && (n === full || n.includes(full) || full.includes(n) || n.split(" ")[0] === first);
  }).sort((a, b) => (a.sortMinutes || 0) - (b.sortMinutes || 0));
}

// Every open staff task (reminders from patient pages), soonest due first
async function openTasks() {
  const snap = await getDocs(query(collection(db, "staff-task-list"), where("status", "==", "Open")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
}
const TASK_TAB_KEY = "dm.dash.tasktab";
const readTaskTab = () => { try { return localStorage.getItem(TASK_TAB_KEY) || "mine"; } catch { return "mine"; } };
const saveTaskTab = (v) => { try { localStorage.setItem(TASK_TAB_KEY, v); } catch { /* private mode */ } };  

// My consultation notes (from recordings), newest first. Reviewed or still a Draft.
async function myNotes(staff) {
  const name = String((staff && staff.name) || "").trim();
  if (!name) return [];
  const snap = await getDocs(query(collection(db, "appointment_transcripts"), where(new FieldPath("Staff Name"), "==", name)));
  return snap.docs.map((d) => {
    const x = d.data() || {};
    return {
      id: d.id,
      patientName: String(x["Patient Name"] || ""),
      patientId: String(x["Patient ID"] || ""),
      patientDocId: String(x["Patient Doc ID"] || ""),
      reviewed: /^reviewed$/i.test(String(x.Status || "")),
      date: parseRecordDate(x["Record Date and Time"]),
      dateText: String(x["Record Date and Time"] || ""),
    };
  }).sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
}

// Forms saved today (any staff), to show which of my patients have their forms done
async function formsToday(key) {
  const snap = await getDocs(query(collection(db, "form_submissions"), where("recordDate", "==", key)));
  return snap.docs.map((d) => {
    const x = d.data() || {};
    return { patientId: String(x.patientId || ""), pttId: String(x.patientPttId || ""), name: String(x.patientName || "") };
  });
}

export async function mountMyDashboard(container, { staff } = {}) {
  const first = String((staff && staff.name) || "").split(" ")[0];
  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";

  const root = document.createElement("section");
  root.className = "page wide md";
  root.innerHTML = `
    <div class="fb-head">
      <div><h2>${greet}${first ? `, ${esc(first)}` : ""}</h2>
        <p class="muted">${esc(new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</p></div>
      <div class="fb-head-actions">
        <button type="button" class="btn-ghost" data-act="customise">Customise</button>
        <button type="button" class="btn-ghost" data-act="refresh">${svg(ICON.refresh)} Refresh</button>
      </div>
    </div>
    <div data-role="body"><div class="skeleton" style="height:320px;border-radius:14px"></div></div>`;
  container.replaceChildren(root);
  const body = root.querySelector('[data-role="body"]');

  const canKit = isInjector();
  const canManage = can("inventory.manage");
  const canOrder = canManage || can("inventory.order");
  const canJt = canManage || can("inventory.jt");
  const canReq = can("inventory.request");
  const canReport = can("menu.reports");
  const safe = (p, fallback) => Promise.resolve(p).catch((err) => { console.warn("Dashboard:", err); return fallback; });
  
  let drawTasks = () => {};

  async function load() {
    const me0 = myUid();
    const hidden = readHidden(me0);
    const show = (k) => can(`dash.${k}`) && !hidden.has(k);
    const todayKey = dayKey();
    const [products, lots, kits, loans, rels, myReqs, usage, records, shorts, pos, allReqs, countsToday, appts, tasks, openCounts, allShorts, notes, formsT, invs, unrec, countCfg, myDay] = await Promise.all([
      safe(listProducts(), []),
      safe(listAllLots(), []),
      safe(listKits(), []),
      safe(listLoans(), []),
      safe(listReleases(), []),
      canReq ? safe(listRequests({ mine: true }), []) : [],
      safe(listMyUsage(31), []),
      safe(listMySubmissions(31), []),
      canOrder || canJt ? safe(listShortUsage(), []) : [],
      canOrder ? safe(listPos(), []) : [],
      canOrder ? safe(listRequests({ max: 300 }), []) : [],
      safe(listCountsOn(todayKey), []),
      show("appts") ? safe(myAppointments(staff, todayKey), []) : [],
      safe(openTasks(), []),
      canReport ? safe(listCounts({ openOnly: true }), []) : [],
      canReport ? safe(listShortAll(), []) : [],
      show("appts") ? safe(myNotes(staff), []) : [],
      show("appts") ? safe(formsToday(todayKey), []) : [],
      can("inventory.count") || canOrder || canReport ? safe(listInvestigations({ open: true }), []) : [],
      show("attention") && (can("consult.record") || canReport)
        ? safe(listUnrecordedTreatments({ fromKey: dayKey(new Date(Date.now() - 7 * DAY)), toKey: dayKey(new Date(Date.now() - DAY)) }), { items: [] })
        : { items: [] },
      safe(getCountSettings(), { dueBy: "10:00" }),
      canKit ? safe(getMyKitDay(), null) : null,
    ]);
    if (!root.isConnected) return;

    const me = myUid();
    const now = Date.now();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const myKits = kits.filter((k) => k.staffUid === me);
    const byId = new Map(products.map((p) => [p.id, p]));
    const lotsOf = (pid) => lots.filter((l) => l.productId === pid);
    // Tasks assigned to me: by staff ID (whichever ID the staff list uses) or, failing that, by name
    const nmT = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const myIds = [me, staff && staff.id, staff && staff.staffId, staff && staff.uid].filter(Boolean).map(String);
    const isMine = (t) => (!!t.assignedToId && myIds.includes(String(t.assignedToId)))
      || (!!t.assignedToName && nmT(t.assignedToName) === nmT(staff && staff.name));

    /* ---------- Needs my attention ---------- */
    const att = [];
    // What's been counted today (by anyone): Shelf/JT per product, kits per lot
    const doneKeys = new Set(countsToday.flatMap((c) => c.lines.map((l) =>
      l.loc === "kit" ? `kit|${l.ref}` : c.kind === "opening" ? `${l.productId}|${l.loc}` : "")));
    // Opening count: Shelf / JT storage, plus every injector's kit for kit products due today
    if (can("inventory.count") || canOrder) {
      const dueKeys = products.filter((p) => countDue(p)).flatMap((p) => [
        ...countLocs(p).map((loc) => `${p.id}|${loc}`),
        ...(isKitProduct(p) ? kits.filter((k) => k.productId === p.id).map((k) => `kit|${k.id}`) : []),
      ]);
      const left = dueKeys.filter((k) => !doneKeys.has(k)).length;
           if (left) {
        const [dh, dm] = String(countCfg.dueBy || "10:00").split(":").map(Number);
        const nowD = new Date();
        const late = nowD.getHours() * 60 + nowD.getMinutes() >= dh * 60 + dm;
        const dueText = `${((dh + 11) % 12) + 1}:${String(dm).padStart(2, "0")}${dh < 12 ? "am" : "pm"}`;
        att.push({ tone: late ? "bad" : "warn",
          text: late ? `Opening count overdue (due ${dueText}): ${left} still to count` : `Opening count: ${left} still to count (due ${dueText})`,
          href: "#/tasks/count", act: "Count now" });
      }
    }  
    // Reporting: differences and saved-short records waiting for someone
    if (canReport) {
      const diffs = openCounts.reduce((a, c) => a + (Number(c.openCount) || 0), 0);
      if (diffs) att.push({ tone: "warn", text: `${diffs} count difference${diffs === 1 ? "" : "s"} to review`,
        href: "#/reports/variance", act: "Review" });
      const shortOpen = allShorts.filter((u) => !u.resolved).length;
      if (shortOpen) att.push({ tone: "bad", text: `${shortOpen} saved short record${shortOpen === 1 ? "" : "s"} to resolve`,
        href: "#/reports/short", act: "Resolve" });
    }
    // Investigations: recounts for the onsite team (never the first counter, unless allowed), reviews for admins
    if (invs.length) {
      const counter = can("inventory.count") || canOrder;
      const recounts = counter ? invs.filter((v) => v.status === "recount" && (v.openedByUid !== me || v.aloneApproved === true)) : [];
      if (recounts.length === 1) {
        att.push({ tone: "warn", text: `Recount needed: ${recounts[0].productName} (${recounts[0].loc === "jt" ? "JT storage" : "Shelf"})`,
          href: `#/inventory/investigations/${encodeURIComponent(recounts[0].id)}`, act: "Recount" });
      } else if (recounts.length) {
        att.push({ tone: "warn", text: `${recounts.length} recounts needed`, href: "#/inventory/investigations", act: "Recount" });
      }
      if (canManage) {
        const reviews = invs.filter((v) => v.status === "review").length;
        if (reviews) att.push({ tone: "bad", text: `${reviews} investigation${reviews === 1 ? " needs" : "s need"} your review`,
          href: "#/inventory/investigations", act: "Review" });
        const stuck = invs.filter((v) => v.status === "recount" && v.aloneApproved !== true && v.openedAt && now - v.openedAt > DAY).length;
        if (stuck) att.push({ tone: "info", text: `${stuck} recount${stuck === 1 ? " has" : "s have"} been waiting over a day`,
          href: "#/inventory/investigations", act: "Open" });
      }
    }

    // Booked for a service that uses stock, but no treatment record used it (the last 7 days, up to yesterday)
    if (unrec.items.length) {
      const nmS = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
      const meFull = nmS(staff && staff.name);
      const meFirst = meFull.split(" ")[0];
      const isMineAppt = (b) => {
        const n = nmS(b.staff);
        return !!n && !!meFull && (n === meFull || n.includes(meFull) || meFull.includes(n) || n.split(" ")[0] === meFirst);
      };
      if (can("consult.record")) {
        const mine = unrec.items.filter(isMineAppt);
        mine.slice(0, 3).forEach((b) => att.push({
          tone: "warn", text: `No products recorded for ${b.patientName || "a patient"} (${niceKey(b.dateKey)}, ${b.services.join(", ")})`,
          href: b.patientId ? `#/patient/${encodeURIComponent(b.patientId)}` : "#/calendar", act: "Open",
        }));
        if (mine.length > 3) att.push({ tone: "warn", text: `…and ${mine.length - 3} more of your bookings with no products recorded`,
          href: canReport ? "#/reports/notrecorded" : "#/calendar", act: "View" });
      }
      if (canReport) att.push({ tone: "info", text: `${unrec.items.length} booking${unrec.items.length === 1 ? "" : "s"} in the last week with no products recorded`,
        href: "#/reports/notrecorded", act: "Review" });
    }
    // My consultation notes still in Draft (oldest first, so the longest-waiting opens first)
    const drafts = notes.filter((n) => !n.reviewed);
    if (drafts.length) {
      const oldest = drafts[drafts.length - 1];
      att.push({ tone: "warn", notesId: oldest.id,
        text: `${drafts.length} consultation note${drafts.length === 1 ? "" : "s"} to review${
          drafts.length > 1 ? ` (oldest: ${oldest.patientName || "patient"}${oldest.date ? `, ${shortDay(oldest.date)}` : ""})` : ` (${oldest.patientName || "patient"})`}`,
        act: "Review" });
    }
    const myOverdue = tasks.filter((t) => isMine(t) && t.dueDate && t.dueDate < todayKey).length;
    if (myOverdue) att.push({ tone: "bad", ttab: "mine",
      text: `${myOverdue} of your task${myOverdue === 1 ? " is" : "s are"} overdue`, act: "View" });
    // Start of Day: injectors holding a kit who haven't done today's count (e.g. pressed "Remind me later")
    const sodPending = canKit && !(myDay && (myDay.start || myDay.end))
      && myKits.some((k) => { const p = byId.get(k.productId); return p && p.active && isKitProduct(p); });
    if (sodPending) att.unshift({ tone: "warn", sod: true, text: "Start of Day: your kit count isn't done yet", act: "Count my kit" });
    // My kit: lots due today that nobody has counted yet (not repeated while the Start of Day count is waiting)
    if (canKit && !sodPending) {
      const mineDue = myKits.filter((k) => countDue(byId.get(k.productId)) && !doneKeys.has(`kit|${k.id}`));
      if (mineDue.length) att.push({
        tone: "info", text: `Your kit hasn't been counted today (${[...new Set(mineDue.map((k) => k.productName))].join(", ")})`,
        href: "#/tasks/count/kit", act: "Check kit",
      });
    }
    loans.filter((l) => l.fromUid === me && l.status === "unconfirmed").forEach((l) => att.push({
      tone: "warn", text: `${l.toName} took ${fmt(l.units)} ${l.doseUnit} of ${l.productName} from your opened vial`,
      href: "#/inventory/kits", act: "Confirm",
    }));
    if (canJt) rels.filter((r) => r.status === "pending").forEach((r) => att.push({
      tone: "info", text: `${r.requestedBy} asked for ${plural(r.qty, r.unit)} of ${r.productName} from JT storage`,
      href: "#/inventory/kits", act: "Review",
    }));
    rels.filter((r) => r.requestedByUid === me && r.status === "approved" && r.handledAt && now - r.handledAt < 3 * DAY).forEach((r) => att.push({
      tone: "ok", text: `${plural(r.qty, r.unit)} of ${r.productName} is on the Shelf for you`,
      href: "#/inventory/kits", act: "Take it",
    }));
    usage.filter((u) => u.short && u.resolved !== true && now - u.at < 14 * DAY).forEach((u) => att.push({
      tone: "bad", text: `Saved short for ${u.patientName}: ${u.lines.filter((l) => l.short > 0).map((l) => `${l.name} by ${fmt(l.short)} ${l.unit}`).join(", ")}`,
      href: `#/form-record/${encodeURIComponent(u.submissionId)}`, act: "Open",
    }));
    myKits.forEach((k) => {
      const s = expiryState(k.expiry);
      if (s) att.push({
        tone: s === "expired" ? "bad" : "warn",
        text: `${k.productName} in your kit ${s === "expired" ? "has expired" : "expires soon"} (${niceKey(k.expiry)})`,
        href: "#/inventory/kits", act: "Kit",
      });
    });
    myReqs.filter((r) => r.status === "declined" && r.handledAt && now - r.handledAt < 14 * DAY).forEach((r) => att.push({
      tone: "warn", text: `Your request ${reqNumber(r)} was declined${r.response ? `: ${r.response}` : ""}`,
      href: "#/inventory/requests", act: "View",
    }));
    const attentionHtml = card("Needs my attention", att.length
      ? `<ul class="md-att">${att.map((a) => `<li class="is-${a.tone}"><span>${esc(a.text)}</span>
          ${a.sod
            ? `<button type="button" class="lh-btn is-primary" data-sod="1">${esc(a.act)}</button>`
            : a.notesId
            ? `<button type="button" class="lh-btn" data-notes="${esc(a.notesId)}">${esc(a.act)}</button>`
            : a.ttab
              ? `<button type="button" class="lh-btn" data-ttab="${esc(a.ttab)}" data-goto="tasks">${esc(a.act)}</button>`
              : `<a class="lh-btn" href="${a.href}">${esc(a.act)}</a>`}</li>`).join("")}</ul>`
      : `<p class="md-clear">${svg(ICON.ok)} Nothing needs you right now.</p>`, "md-wide");
    /* ---------- My kit ---------- */
    const kitProducts = products.filter((p) => p.active && isKitProduct(p));
    const kitHtml = !canKit || !kitProducts.length ? "" : card("My kit", `<div class="md-kits">${kitProducts.map((p) => {
      const ks = myKits.filter((k) => k.productId === p.id);
      const total = ks.reduce((a, k) => a + kitUnits(k), 0);
      const open = ks.reduce((a, k) => a + k.open, 0);
      const sealed = ks.reduce((a, k) => a + k.sealed, 0);
      return `<div class="md-kit${total ? "" : " is-empty"}">
        <strong>${fmt(total)}</strong><span>${esc(p.doseUnit)} of ${esc(p.name)}</span>
        <small>${esc([open ? `${fmt(open)} in the opened ${p.stockUnit}` : "", sealed ? `${plural(sealed, p.stockUnit)} unopened` : "",
          !total ? `Shelf has ${plural(p.stock.shelf, p.stockUnit)}` : ""].filter(Boolean).join(" · "))}</small></div>`;
    }).join("")}</div>`, "", '<a class="md-link" href="#/inventory/kits">Open Kits</a>');

    /* ---------- My records ---------- */
    const todayN = records.filter((s) => s.createdAt >= today).length;
    const weekN = records.filter((s) => now - s.createdAt < 7 * DAY).length;
    const recordsHtml = card("My records", `
      <div class="md-stats"><div><strong>${todayN}</strong><span>Today</span></div><div><strong>${weekN}</strong><span>Last 7 days</span></div></div>
      ${records.length ? `<ul class="md-list">${records.slice(0, 6).map((s) => `<li><a href="#/form-record/${encodeURIComponent(s.id)}">
          <strong>${esc(s.patientName)}</strong><span>${esc(s.templateName)}</span><small>${esc(shortDay(s.createdAt))}</small></a></li>`).join("")}</ul>`
        : '<p class="tb-none">No forms saved in the last month.</p>'}`);

    /* ---------- What I used ---------- */
    const agg = new Map();
    usage.forEach((u) => u.lines.forEach((l) => {
      const key = l.productId || l.name;
      const dosedLine = l.kind !== "kit" && !!l.doseUnit;
      const a = agg.get(key) || { name: l.name, unit: l.kind === "kit" ? l.unit : dosedLine ? l.doseUnit : l.unit, plain: l.kind !== "kit" && !dosedLine, week: 0, month: 0, waste: 0 };
      const v = dosedLine ? Number(l.doseTotal) || 0 : Number(l.total) || 0;
      a.month += v;
      if (now - u.at < 7 * DAY) a.week += v;
      a.waste += Number(l.waste) || 0;
      agg.set(key, a);
    }));
    const amt = (a, n) => (a.plain ? plural(+fmt(n), a.unit) : `${fmt(n)} ${a.unit}`);
    const usedRows = [...agg.values()].sort((a, b) => a.name.localeCompare(b.name));
    const usedHtml = !usedRows.length ? "" : card("What I used", `<table class="inv-table md-used">
      <thead><tr><th>Product</th><th>Last 7 days</th><th>Last 30 days</th><th>Discarded</th></tr></thead><tbody>${usedRows.map((a) => `
        <tr><td>${esc(a.name)}</td><td>${a.week ? esc(amt(a, a.week)) : "—"}</td><td>${esc(amt(a, a.month))}</td>
          <td>${a.waste ? esc(`${fmt(a.waste)} ${a.unit}`) : "—"}</td></tr>`).join("")}</tbody></table>`);

    /* ---------- My requests ---------- */
    const myRels = rels.filter((r) => r.requestedByUid === me).slice(0, 4);
    const reqItems = [
      ...myReqs.slice(0, 6).map((r) => ({ at: r.createdAt, label: `${reqNumber(r)} · ${r.items.map((it) => it.name).join(", ")}`,
        status: r.status, statusText: REQ_STATUS[r.status], href: "#/inventory/requests" })),
      ...myRels.map((r) => ({ at: r.createdAt, label: `JT storage · ${plural(r.qty, r.unit)} of ${r.productName}`,
        status: r.status, statusText: REL_STATUS[r.status], href: "#/inventory/kits" })),
    ].sort((a, b) => (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0)).slice(0, 8);
    const reqHtml = !reqItems.length ? "" : card("My requests", `<ul class="md-list">${reqItems.map((r) => `<li><a href="${r.href}">
        <span>${esc(r.label)}</span><span class="rq-status is-${esc(r.status)}">${esc(r.statusText)}</span><small>${esc(shortDay(r.at))}</small></a></li>`).join("")}</ul>`,
      "", canReq ? '<a class="md-link" href="#/tasks/order">+ Request order</a>' : "");

    /* ---------- Stock I use ---------- */
    const usedIds = [...new Set(usage.flatMap((u) => u.lines.map((l) => l.productId)).filter(Boolean))];
    const stockRows = usedIds.map((id) => byId.get(id)).filter((p) => p && p.active).map((p) => {
      const ex = lotsOf(p.id).map((l) => expiryState(l.expiry));
      const flag = lowAt(p, "shelf") ? ["warn", "Low on Shelf"] : ex.includes("expired") ? ["bad", "Expired stock"] : ex.includes("soon") ? ["warn", "Expires soon"] : null;
      return `<tr><td>${esc(p.name)}</td><td>${esc(plural(p.stock.shelf, p.stockUnit))}</td><td>${esc(plural(p.stock.jt, p.stockUnit))}</td>
        <td>${flag ? `<span class="inv-flag is-${flag[0]}">${esc(flag[1])}</span>` : ""}</td></tr>`;
    });
    const stockHtml = !stockRows.length ? "" : card("Stock I use", `<table class="inv-table">
      <thead><tr><th>Product</th><th>Shelf</th><th>JT storage</th><th></th></tr></thead><tbody>${stockRows.join("")}</tbody></table>`,
      "", '<a class="md-link" href="#/inventory/stock">Open Inventory</a>');

    /* ---------- Clinic overview ---------- */
    let overviewHtml = "";
    if (canOrder || canJt) {
      const active = products.filter((p) => p.active);
      const low = active.filter((p) => lowAt(p, "shelf") || lowAt(p, "jt")).length;
      const expSoon = active.filter((p) => lotsOf(p.id).some((l) => expiryState(l.expiry) === "soon")).length;
      const expired = active.filter((p) => lotsOf(p.id).some((l) => expiryState(l.expiry) === "expired")).length;
      const tiles = [
        [low, "Low stock", "#/inventory/stock", "warn"],
        [expSoon, "Expiring within 60 days", "#/inventory/stock", "warn"],
        [expired, "With expired stock", "#/inventory/stock", "bad"],
        ...(canOrder ? [
          [allReqs.filter((r) => r.status === "open").length, "Open requests", "#/inventory/requests", "info"],
          [pos.filter((p) => ["sent", "part"].includes(p.status)).length, "Deliveries waiting", "#/inventory/orders", "info"],
        ] : []),
        [loans.filter((l) => l.status === "unconfirmed").length, "Borrows to confirm", "#/inventory/kits", "info"],
        [loans.filter((l) => l.status === "disputed").length, "Disputed borrows", "#/inventory/kits", "bad"],
        [shorts.length, "Saved short (30 days)", canReport ? "#/reports/short" : "#/inventory/kits", "bad"],
      ];
      overviewHtml = card("Clinic overview", `<div class="md-tiles">${tiles.map(([n, label, href, tone]) => `
        <a class="md-tile${n ? ` is-${tone}` : ""}" href="${href}"><strong>${n}</strong><span>${esc(label)}</span></a>`).join("")}</div>`, "md-wide");
    }

    /* ---------- My appointments & notes ---------- */
    const low = (s) => String(s || "").trim().toLowerCase();
    const nm = (s) => low(s).replace(/\s+/g, " ");
    // Same patient: by ID when the appointment has one, otherwise (or as well) by exact name
    const samePatient = (a, ids, name) => {
      const aid = low(a.patientId);
      return (aid && ids.map(low).includes(aid)) || (!!nm(a.patientName) && nm(a.patientName) === nm(name));
    };
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const todayNotes = notes.filter((n) => n.date && dayKey(n.date) === todayKey);

    const apptRow = (a) => {
      const forms = formsT.filter((f) => samePatient(a, [f.patientId, f.pttId], f.name));
      const note = todayNotes.find((n) => samePatient(a, [n.patientId, n.patientDocId], n.patientName));
      const past = Number.isFinite(Number(a.sortMinutes)) && Number(a.sortMinutes) + 15 < nowMin;
      const chips = [
        forms.length
          ? `<span class="md-chip is-ok">✓ ${forms.length} form${forms.length === 1 ? "" : "s"}</span>`
          : '<span class="md-chip">No forms yet</span>',
        note
          ? (note.reviewed
            ? '<span class="md-chip is-ok">✓ Notes reviewed</span>'
            : `<button type="button" class="md-chip is-warn" data-notes="${esc(note.id)}">Notes to review</button>`)
          : past ? '<span class="md-chip">No notes recorded</span>' : "",
      ].join("");
      const href = a.patientId ? `#/patient/${encodeURIComponent(a.patientId)}` : "#/calendar";
      return `<li class="md-appt">
        <a href="${href}"><strong>${esc(a.time || "")}</strong><span>${esc(a.patientName || "")}</span>
          <small>${esc((a.services || []).join(", "))}</small></a>
        <div class="md-chips">${chips}</div></li>`;
    };

    const draftList = notes.filter((n) => !n.reviewed);
    const notesBlock = draftList.length ? `
      <div class="md-sub">
        <h4>Notes to review <em>${draftList.length}</em></h4>
        <ul class="md-list md-notes">${draftList.slice(0, 6).map((n) => `<li>
          <button type="button" data-notes="${esc(n.id)}"><strong>${esc(n.patientName || "Patient")}</strong>
            <span>${esc(n.date ? shortDay(n.date) : n.dateText)}</span><small>Review →</small></button></li>`).join("")}</ul>
        ${draftList.length > 6 ? `<small class="muted">and ${draftList.length - 6} more</small>` : ""}
      </div>` : "";

    const apptHtml = card("My appointments & notes", `
      ${appts.length ? `<ul class="md-list md-appts">${appts.map(apptRow).join("")}</ul>` : '<p class="tb-none">No appointments for you today.</p>'}
      ${notesBlock || (notes.length ? '<p class="md-clear md-sub">✓ All your consultation notes are reviewed.</p>' : "")}`,
      "", '<a class="md-link" href="#/calendar">Open Calendar</a>');

    /* ---------- Tasks: mine, ones I assigned, everyone ---------- */
    const in7 = dayKey(new Date(Date.now() + 7 * DAY));
    const sortDue = (a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999"));
    const mineList = tasks.filter(isMine).sort(sortDue);
    const createdList = tasks.filter((t) => t.createdByUid === me && !isMine(t)).sort(sortDue);
    const dueNowList = tasks.filter((t) => t.dueDate && t.dueDate <= todayKey).sort(sortDue);

    const taskLi = (t, who) => {
      const overdue = !!t.dueDate && t.dueDate < todayKey;
      const whoText = who === "to"
        ? (t.assignedToName ? `For ${t.assignedToName}` : "For anyone")
        : (t.createdBy ? `From ${t.createdBy}` : "");
      return `<li class="md-task${overdue ? " is-overdue" : ""}">
        <a href="#/patient/${encodeURIComponent(t.patientId || "")}">
          <span>${esc(t.taskText || "Untitled reminder")}</span><strong>${esc(t.patientName || "")}</strong>
          <small class="${overdue ? "md-overdue" : ""}">${overdue ? "Overdue · " : t.dueDate === todayKey ? "Today · " : ""}${
            esc(niceKey(t.dueDate) || "No due date")}${whoText ? ` · ${esc(whoText)}` : ""}</small></a>
        <button type="button" class="lh-btn md-done" data-task-done="${esc(t.id)}" title="Mark as done">✓ Done</button></li>`;
    };
    const group = (title, list, who) => (list.length ? `
      <p class="md-grp">${esc(title)} <em>${list.length}</em></p>
      <ul class="md-list md-tasks">${list.slice(0, 10).map((t) => taskLi(t, who)).join("")}</ul>
      ${list.length > 10 ? `<small class="muted">and ${list.length - 10} more</small>` : ""}` : "");

    const tasksInner = () => {
      const tab = readTaskTab();
      const tabs = `<div class="md-ttabs">${[["mine", `Mine (${mineList.length})`], ["created", `I assigned (${createdList.length})`], ["all", "Everyone"]]
        .map(([k, l]) => `<button type="button" class="md-ttab${tab === k ? " is-on" : ""}" data-ttab="${k}">${esc(l)}</button>`).join("")}</div>`;
      if (tab === "created") {
        return tabs + (createdList.length ? group("Waiting on others", createdList, "to")
          : '<p class="tb-none">No open tasks you\'ve assigned to others.</p>');
      }
      if (tab === "all") {
        return tabs + (dueNowList.length ? group("Due today or overdue", dueNowList, "to") : '<p class="tb-none">No open tasks due today.</p>');
      }
      const od = mineList.filter((t) => t.dueDate && t.dueDate < todayKey);
      const td = mineList.filter((t) => t.dueDate === todayKey);
      const soon = mineList.filter((t) => !t.dueDate || (t.dueDate > todayKey && t.dueDate <= in7));
      const later = mineList.filter((t) => t.dueDate && t.dueDate > in7);
      return tabs + (mineList.length
        ? group("Overdue", od, "from") + group("Today", td, "from") + group("Next 7 days", soon, "from")
          + (later.length ? `<small class="muted">${later.length} more due later</small>` : "")
          + (!od.length && !td.length && !soon.length ? '<p class="tb-none">Nothing due this week. 👍</p>' : "")
        : '<p class="tb-none">Nothing assigned to you. 👍</p>');
    };
    drawTasks = () => {
      const el = body.querySelector('[data-role="tasks-card"]');
      if (el) el.innerHTML = tasksInner();
    };
    const tasksHtml = card("Tasks", `<div data-role="tasks-card">${tasksInner()}</div>`, "md-tasks-card");
    
    /* ---------- Start & end of day (Admins): filled in by staff-days.js ---------- */
    const daysHtml = '<section class="md-card md-wide" data-role="days"></section>';
    const CARDS = [["attention", attentionHtml], ["days", daysHtml], ["appts", apptHtml], ["tasks", tasksHtml], ["kit", kitHtml],
      ["records", recordsHtml], ["usage", usedHtml], ["requests", reqHtml], ["stock", stockHtml], ["overview", overviewHtml]];
    const shown = CARDS.filter(([k, h]) => h && show(k));
    body.innerHTML = shown.length
      ? `<div class="md-grid">${shown.map(([, h]) => h).join("")}</div>`
      : '<div class="tm-empty">Nothing to show yet. Use <strong>Customise</strong> to choose your cards, or ask an Admin to turn some on for you.</div>';
    renderDayCard(body.querySelector('[data-role="days"]')); // Admins only; does nothing if the card is hidden
  }

  root.addEventListener("click", (e) => {
    const sb = e.target.closest("[data-sod]");
    if (sb) {
      sb.disabled = true;
      openStartOfDayKit(staff).finally(() => { sb.disabled = false; });
      return;
    }
    const nb = e.target.closest("[data-notes]");
    if (nb) { showSoapPanel(nb.dataset.notes, { mode: "open" }); return; }
    const tt = e.target.closest("[data-ttab]");
    if (tt) {
      saveTaskTab(tt.dataset.ttab);
      drawTasks();
      if (tt.dataset.goto) {
        const el = body.querySelector(".md-tasks-card");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
    const td = e.target.closest("[data-task-done]");
    if (td) {
      td.disabled = true;
      td.textContent = "Saving…";
      completeReminder(td.dataset.taskDone, staff)
        .then(() => { showToast("Task marked as done"); load(); })
        .catch((err) => {
          console.error("Completing task failed:", err);
          showToast(err && err.code === "permission-denied" ? "You don't have permission to update tasks." : "Couldn't update the task.");
          td.disabled = false;
          td.textContent = "✓ Done";
        });
      return;
    }
    if (e.target.closest('[data-act="refresh"]')) {
      body.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
      load();
      return;
    }
    if (e.target.closest('[data-act="customise"]')) {
      const me = myUid();
      const hidden = readHidden(me);
      const allowed = DASH_CARDS.filter(([k]) => can(`dash.${k}`));
      const dlg = document.createElement("dialog");
      dlg.className = "lh-dialog";
      dlg.innerHTML = `<form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Customise my dashboard</h3>
          <p>Choose which cards you see. Cards not listed here are turned off for you by an Admin.</p></div>
        ${allowed.length ? allowed.map(([k, label]) => `<label class="fe-check"><input type="checkbox" name="card" value="${k}"${hidden.has(k) ? "" : " checked"} /> ${esc(label)}</label>`).join("")
          : '<p class="tb-none">No cards are turned on for you yet. Ask an Admin.</p>'}
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save</button>
        </div></form>`;
      document.body.appendChild(dlg);
      dlg.addEventListener("close", () => dlg.remove());
      dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
      dlg.querySelector("form").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const on = new Set([...dlg.querySelectorAll('[name="card"]:checked')].map((x) => x.value));
        writeHidden(me, new Set(allowed.map(([k]) => k).filter((k) => !on.has(k))));
        dlg.close();
        body.innerHTML = '<div class="skeleton" style="height:320px;border-radius:14px"></div>';
        load();
      });
      dlg.showModal();
    }
  });
  // Start of Day saved (or found already done): reload so the reminder goes away
  const onKitDay = () => {
    if (!root.isConnected) { window.removeEventListener("kitday:changed", onKitDay); return; }
    load();
  };
  window.addEventListener("kitday:changed", onKitDay);
  load().catch((err) => {
    console.error("Dashboard failed:", err);
    if (root.isConnected) body.innerHTML = '<div class="tm-empty is-error">Couldn\'t load your dashboard. Check your connection and try again.</div>';
  });
}