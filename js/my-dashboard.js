// My dashboard (#/home): a personal summary for whoever is logged in.
// Only reads existing data: kits, borrows, JT releases, requests, treatment usage and saved forms.
import { can, isInjector } from "./perms.js";
import {
  listProducts, listAllLots, listKits, listLoans, listReleases, listRequests, listMyUsage, listShortUsage, listPos,
  isKitProduct, kitUnits, expiryState, plural, unitPlural, lowAt, myUid, reqNumber, REQ_STATUS, REL_STATUS,countDue, countLocs, dayKey, listCountsOn,
} from "./inventory-api.js";
import { listMySubmissions } from "./form-submissions.js";
import { db } from "./firebase-config.js";
import { doc, getDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
  ["attention", "Needs my attention"], ["appts", "My appointments today"], ["tasks", "Open staff tasks"],
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

// Open staff tasks (from patient pages) due today or overdue
async function dueTasks(key) {
  const snap = await getDocs(query(collection(db, "staff-task-list"), where("status", "==", "Open")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => t.dueDate && t.dueDate <= key)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
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
  const safe = (p, fallback) => Promise.resolve(p).catch((err) => { console.warn("Dashboard:", err); return fallback; });

  async function load() {
    const me0 = myUid();
    const hidden = readHidden(me0);
    const show = (k) => can(`dash.${k}`) && !hidden.has(k);
    const todayKey = dayKey();
    const [products, lots, kits, loans, rels, myReqs, usage, records, shorts, pos, allReqs, countsToday, appts, tasks] = await Promise.all([
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
      show("tasks") ? safe(dueTasks(todayKey), []) : [],
    ]);
    if (!root.isConnected) return;

    const me = myUid();
    const now = Date.now();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const myKits = kits.filter((k) => k.staffUid === me);
    const byId = new Map(products.map((p) => [p.id, p]));
    const lotsOf = (pid) => lots.filter((l) => l.productId === pid);

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
      if (left) att.push({ tone: "warn", text: `Opening count: ${left} still to count today`, href: "#/tasks/count", act: "Count now" });
    }
    // My kit: lots due today that nobody has counted yet
    if (canKit) {
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
    usage.filter((u) => u.short && now - u.at < 14 * DAY).forEach((u) => att.push({
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
          <a class="lh-btn" href="${a.href}">${esc(a.act)}</a></li>`).join("")}</ul>`
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
        [shorts.length, "Saved short (30 days)", "#/inventory/kits", "bad"],
      ];
      overviewHtml = card("Clinic overview", `<div class="md-tiles">${tiles.map(([n, label, href, tone]) => `
        <a class="md-tile${n ? ` is-${tone}` : ""}" href="${href}"><strong>${n}</strong><span>${esc(label)}</span></a>`).join("")}</div>`, "md-wide");
    }

    /* ---------- My appointments today ---------- */
    const apptHtml = card("My appointments today", appts.length
      ? `<ul class="md-list md-appts">${appts.map((a) => `<li><a href="#/calendar">
          <strong>${esc(a.time || "")}</strong><span>${esc(a.patientName || "")}</span><small>${esc((a.services || []).join(", "))}</small></a></li>`).join("")}</ul>`
      : '<p class="tb-none">No appointments for you today.</p>', "", '<a class="md-link" href="#/calendar">Open Calendar</a>');

    /* ---------- Open staff tasks ---------- */
    const tasksHtml = card("Open staff tasks", tasks.length
      ? `<ul class="md-list">${tasks.slice(0, 10).map((t) => `<li><a href="#/patient/${encodeURIComponent(t.patientId || "")}">
          <span>${esc(t.taskText || "")}</span><strong>${esc(t.patientName || "")}</strong>
          <small class="${t.dueDate < todayKey ? "md-overdue" : ""}">${t.dueDate < todayKey ? "Overdue · " : ""}${esc(niceKey(t.dueDate))}</small></a></li>`).join("")}</ul>
        ${tasks.length > 10 ? `<small class="muted">and ${tasks.length - 10} more</small>` : ""}`
      : '<p class="tb-none">No open tasks due today.</p>');

    const CARDS = [["attention", attentionHtml], ["appts", apptHtml], ["tasks", tasksHtml], ["kit", kitHtml],
      ["records", recordsHtml], ["usage", usedHtml], ["requests", reqHtml], ["stock", stockHtml], ["overview", overviewHtml]];
    const shown = CARDS.filter(([k, h]) => h && show(k));
    body.innerHTML = shown.length
      ? `<div class="md-grid">${shown.map(([, h]) => h).join("")}</div>`
      : '<div class="tm-empty">Nothing to show yet. Use <strong>Customise</strong> to choose your cards, or ask an Admin to turn some on for you.</div>';
  }
  
  root.addEventListener("click", (e) => {
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
  load().catch((err) => {
    console.error("Dashboard failed:", err);
    if (root.isConnected) body.innerHTML = '<div class="tm-empty is-error">Couldn\'t load your dashboard. Check your connection and try again.</div>';
  });
}