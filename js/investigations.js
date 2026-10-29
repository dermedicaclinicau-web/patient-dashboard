// Inventory → Investigations (#/inventory/investigations and #/inventory/investigations/<id>).
// Opened when a count doesn't match the digital count.
// Opening count: Counted → Recount (someone else, without seeing the numbers) → Admin review → Closed.
// Overnight kit (Start of Day vs last End of Day): Start of Day count → Admin review → Closed.
import {
  INV_OUTCOMES, MOVE_TYPES, PO_STATUS, KIT_FLOW_LABELS, listInvestigations, getInvestigation, investigationEvidence,
  kitOvernightEvidence, saveRecount, allowAloneRecount, closeInvestigation, peekInvestigation,
  listProducts, plural, unitPlural, myUid, dayKey,
} from "./inventory-api.js";
import { can } from "./perms.js";
import { billingCheck, BC_TYPES } from "./billing-check-api.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SKEL = '<div class="skeleton" style="height:260px;border-radius:14px"></div>';
const LOC = { shelf: "Shelf", jt: "JT storage" };
const when = (d) => (d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const day = (d) => (d && !isNaN(d) ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const time = (d) => (d && !isNaN(d) ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const niceKey = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? day(new Date(+m[1], +m[2] - 1, +m[3])) : ""; };
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const money = (n) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const isCounter = () => can("inventory.count") || can("inventory.order") || can("inventory.manage");
const isOvernight = (x) => !!x && x.kind === "kit-overnight";
const peekedBy = (x, uid) => (Array.isArray(x.peekedByUids) ? x.peekedByUids : []).includes(uid);
const whereText = (x) => (x.loc === "kit"
  ? `${x.staffName || "Injector"}'s kit`
  : `${LOC[x.loc] || x.loc}${x.batch ? ` · ${x.batchLabel || "Batch"} ${x.batch}` : ""}`);
const diffOf = (x) => Number(x.recount ? x.recount.variance : x.variance) || 0;
// "3 vials" / "1 vial"; kit amounts are already in units ("12.5 units")
const unitWord = (x, n) => (isOvernight(x) ? (x.unit || "units") : Math.abs(n) === 1 ? (x.unit || "item") : unitPlural(x.unit || "item"));
const ageDays = (d) => (d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 864e5)) : 0);
const ageText = (d) => { const n = ageDays(d); return n === 0 ? "Today" : n === 1 ? "1 day" : `${n} days`; };
const ageTone = (x) => (x.status === "closed" ? "" : ageDays(x.openedAt) >= 7 ? "bad" : ageDays(x.openedAt) >= 3 ? "warn" : "");
const errText = (err, fb) => (err && err.code === "permission-denied"
  ? "You don't have access. Check the inv_investigations Firestore rule has been published, and your Inventory access in Staff."
  : err && err.message && !err.code ? err.message : fb);

/* ---------- Icons ---------- */
const I = (p, cls = "") => `<svg class="ivx-ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  kit: '<path d="M18 2l4 4"/><path d="M17 7l3-3"/><path d="M19 9L8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5"/><path d="M9 11l4 4"/><path d="M5 19l-3 3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  truck: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  patient: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
};

/* ---------- What happened: plain words, and the questions an admin answers ---------- */
const OUT_TEXT = {
  "count-error": ["Miscounted", "The first count was wrong. Nothing changes."],
  found: ["Found or misplaced", "It turned up, e.g. put away in the wrong place. Nothing changes."],
  "fixed-record": ["The treatment record has been fixed", "You've already corrected the patient's record, which updated the stock. Nothing more changes."],
  "not-recorded": ["Used, with no treatment record", "Used on a patient but never recorded. It's taken off stock. Name the patient in the note."],
  receiving: ["Delivery entered wrong", "Put away or entered wrongly. Name the purchase order in the note."],
  missing: ["Missing or lost", "Can't be found or explained. It's written off."],
  extra: ["Extra stock found", "More is there than the portal knew about. It's added to stock."],
};
const outLabel = (k) => (OUT_TEXT[k] || [])[0] || (INV_OUTCOMES[k] || {}).label || "Closed";

const GROUPS_SHORT = [
  { key: "there", icon: "check", label: "It's there after all", help: "Miscounted, or it turned up somewhere else", outcomes: ["count-error", "found"] },
  { key: "used", icon: "patient", label: "It was used on a patient", help: "On a treatment, recorded or not", outcomes: ["fixed-record", "not-recorded"] },
  { key: "delivery", icon: "truck", label: "A delivery was entered wrong", help: "Not put away, or entered wrongly", outcomes: ["receiving"] },
  { key: "lost", icon: "alert", label: "It can't be found", help: "Lost, taken or thrown out", outcomes: ["missing"] },
];
const GROUPS_EXTRA = [
  { key: "there", icon: "check", label: "It was counted wrong", help: "There isn't really more", outcomes: ["count-error"] },
  { key: "delivery", icon: "truck", label: "A delivery was entered wrong", help: "More arrived than was entered", outcomes: ["receiving"] },
  { key: "extra", icon: "plus", label: "There really is more", help: "Stock the portal didn't know about", outcomes: ["extra", "found"] },
];
function groupsFor(diff) {
  const ok = (k) => { const o = INV_OUTCOMES[k]; return !!o && !o.system && (!o.sign || Math.sign(diff) === o.sign); };
  return (diff < 0 ? GROUPS_SHORT : GROUPS_EXTRA).map((g) => ({ ...g, outcomes: g.outcomes.filter(ok) })).filter((g) => g.outcomes.length);
}

/* ---------- Where it's up to, and who's next ---------- */
const canRecountX = (x, me) => !isOvernight(x) && x.status === "recount" && isCounter()
  && (x.openedByUid !== me || x.aloneApproved === true) && !peekedBy(x, me);

function nextOf(x, me, canManage) {
  if (x.status === "closed") return { tone: "done", icon: "check", who: "", text: `Closed: ${outLabel(x.outcome)}` };
  if (x.status === "recount") {
    if (canRecountX(x, me)) return { tone: "you", icon: "clipboard", who: "You:", text: "recount it", act: "recount",
      hint: "Count it without checking the portal first." };
    if (x.openedByUid === me && !x.aloneApproved) return { tone: "wait", icon: "user", who: "Someone else", text: "needs to recount it",
      hint: "You did the first count. If you're the only one on site today, ask an admin to let you recount." };
    if (peekedBy(x, me)) return { tone: "wait", icon: "user", who: "Someone else", text: "needs to recount it",
      hint: "You've seen the numbers, so you can't recount it yourself." };
    return { tone: "wait", icon: "user", who: "Someone on site", text: "needs to recount it",
      hint: "Anyone who does the opening count can, except the person who counted it first." };
  }
  if (canManage) return { tone: "you", icon: "search", who: "You:", text: "review it and close it", act: "review",
    hint: "Check what the records show, then choose what happened." };
  return { tone: "wait", icon: "user", who: "An admin", text: "needs to review it", hint: "They check the records and CCTV, then close it." };
}

function stepsOf(x) {
  const closed = x.status === "closed";
  const sys = closed && !!(INV_OUTCOMES[x.outcome] || {}).system;
  const byRecount = closed && x.outcome === "count-error" && x.recount && !Number(x.recount.variance);
  if (isOvernight(x)) {
    return [
      { label: "Start of Day count", sub: x.staffName || x.openedBy || "", state: "done" },
      { label: "Admin review", sub: closed && !sys ? x.closedBy || "" : "", state: closed ? (sys ? "skip" : "done") : "now" },
      { label: "Closed", sub: closed ? day(x.closedAt) : "", state: closed ? "done" : "todo" },
    ];
  }
  return [
    { label: "Counted", sub: x.openedBy || "", state: "done" },
    { label: "Recount", sub: x.recount ? x.recount.by || "" : "", state: x.recount ? "done" : x.status === "recount" ? "now" : closed ? "skip" : "todo" },
    { label: "Admin review", sub: closed && !byRecount && !sys ? x.closedBy || "" : "",
      state: x.status === "review" ? "now" : closed ? (byRecount || sys ? "skip" : "done") : "todo" },
    { label: "Closed", sub: closed ? day(x.closedAt) : "", state: closed ? "done" : "todo" },
  ];
}
const miniSteps = (x) => `<span class="ivx-mini" aria-hidden="true">${stepsOf(x).map((s) => `<i class="is-${s.state}"></i>`).join("")}</span>`;

function valueOf(x, p) {
  if (!p || p.cost === null || p.cost === undefined) return null;
  const per = p.cost / Math.max(1, p.packSize);
  const each = isOvernight(x) ? (p.dosePer ? per / p.dosePer : null) : per;
  return each === null ? null : Math.round(each * diffOf(x) * 100) / 100;
}
const pill = (x) => `<span class="ivx-pill is-${x.status}">${esc(x.status === "closed" ? "Closed"
  : x.status === "review" ? "Admin review" : "Recount")}</span>`;

/* ===================== The list (Inventory → Investigations) ===================== */

export async function renderInvestigations(body, { staff = null } = {}) {
  body.innerHTML = SKEL;
  let list, products;
  try {
    [list, products] = await Promise.all([listInvestigations(), listProducts().catch(() => [])]);
  } catch (err) {
    console.error("Investigations failed:", err);
    if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the investigations."))}</div>`;
    return;
  }
  if (!body.isConnected) return;
  const me = myUid();
  const canManage = can("inventory.manage");
  const pById = new Map(products.map((p) => [p.id, p]));
  const st = { kind: "all", q: "", allClosed: false };
  const wrap = document.createElement("div");
  wrap.className = "ivx-list-wrap";
  body.replaceChildren(wrap);

  const open = list.filter((x) => x.status !== "closed");
  const needMe = open.filter((x) => nextOf(x, me, canManage).tone === "you");
  // Recounts are blind, so their value isn't added up until they've been recounted
  const risk = open.filter((x) => isOvernight(x) || x.status !== "recount")
    .reduce((a, x) => { const v = valueOf(x, pById.get(x.productId)); return v !== null && v < 0 ? a + v : a; }, 0);
  const oldest = open.reduce((a, x) => Math.max(a, ageDays(x.openedAt)), 0);
  const tile = (icon, val, label, tone) => `<div class="ivx-sum is-${tone}">${I(IC[icon])}<div><strong>${esc(val)}</strong><span>${esc(label)}</span></div></div>`;

  function card(x) {
    const kit = isOvernight(x);
    const n = nextOf(x, me, canManage);
    const blind = !kit && x.status === "recount";
    const d = blind ? null : r1(diffOf(x));
    const v = blind ? null : valueOf(x, pById.get(x.productId));
    return `<a class="ivx-card is-${n.tone}" href="#/inventory/investigations/${encodeURIComponent(x.id)}">
      <span class="ivx-card-ic is-${kit ? "kit" : "count"}">${I(kit ? IC.kit : IC.box)}</span>
      <span class="ivx-card-main">
        <strong>${esc(x.productName)}</strong>
        <small>${esc(whereText(x))} · ${kit ? `Overnight kit check, ${niceKey(x.dateKey) || day(x.openedAt)}` : `Opening count, ${day(x.openedAt)}`}</small>
        <span class="ivx-card-line">${miniSteps(x)}<span class="ivx-next is-${n.tone}">${I(IC[n.icon])}${n.who ? `<b>${esc(n.who)}</b> ` : ""}${esc(n.text)}</span></span>
      </span>
      <span class="ivx-card-side">
        ${d === null
          ? `<span class="ivx-diff is-hidden" title="Hidden until it's recounted">${I(IC.eyeOff)}<small>Hidden</small></span>`
          : `<span class="ivx-diff is-${d < 0 ? "neg" : "pos"}">${esc(signed(d))}<small>${esc(unitWord(x, d))}</small></span>`}
        ${v !== null && canManage ? `<small class="ivx-val">${esc(money(v))}</small>` : ""}
        ${x.status !== "closed"
          ? `<span class="ivx-age is-${ageTone(x)}">${I(IC.clock)}${esc(ageText(x.openedAt))}</span>`
          : `<small class="muted">${esc(day(x.closedAt))}</small>`}
      </span></a>`;
  }

  const matches = (x) => (st.kind === "all" || (st.kind === "kit") === isOvernight(x))
    && (!st.q || `${x.productName} ${whereText(x)} ${x.openedBy || ""} ${x.staffName || ""}`.toLowerCase().includes(st.q));
  const byAge = (a, b) => (a.openedAt ? a.openedAt.getTime() : 0) - (b.openedAt ? b.openedAt.getTime() : 0);

  function drawSecs() {
    const shown = list.filter(matches);
    const mine = shown.filter((x) => x.status !== "closed" && nextOf(x, me, canManage).tone === "you").sort(byAge);
    const others = shown.filter((x) => x.status !== "closed" && nextOf(x, me, canManage).tone !== "you").sort(byAge);
    const closed = shown.filter((x) => x.status === "closed")
      .sort((a, b) => (b.closedAt ? b.closedAt.getTime() : 0) - (a.closedAt ? a.closedAt.getTime() : 0));
    const cutoff = Date.now() - 30 * 864e5;
    const recent = closed.filter((x) => x.closedAt && x.closedAt.getTime() > cutoff);
    const closedShown = st.allClosed ? closed : recent;
    const recountable = mine.filter((x) => canRecountX(x, me));
    const sec = (title, icon, items, extra, empty) => `<section class="ivx-group-sec">
      <div class="ivx-sec-head"><h3>${I(IC[icon])}${esc(title)} <em>${items.length}</em></h3>${extra || ""}</div>
      ${items.length ? `<div class="ivx-cards">${items.map(card).join("")}</div>` : `<p class="ivx-empty">${empty}</p>`}</section>`;
    wrap.querySelector('[data-role="secs"]').innerHTML = [
      sec("Needs you", "user", mine, recountable.length > 1
        ? `<button type="button" class="lh-btn is-primary" data-act="recount-all">${I(IC.clipboard)} Recount all ${recountable.length}</button>` : "",
        "Nothing needs you right now. 👍"),
      others.length ? sec("Waiting on someone else", "clock", others, "", "") : "",
      sec(st.allClosed ? "Closed" : "Closed in the last 30 days", "check", closedShown,
        closed.length > recent.length ? `<button type="button" class="lh-btn is-quiet" data-act="older">${st.allClosed ? "Last 30 days only" : `Show all ${closed.length}`}</button>` : "",
        "None yet."),
    ].join("");
  }

  wrap.innerHTML = `
    <div class="ivx-summary">
      ${tile("alert", open.length, "Open", open.length ? "warn" : "ok")}
      ${tile("user", needMe.length, "Need you", needMe.length ? "you" : "ok")}
      ${canManage ? tile("dollar", risk ? money(risk) : "$0.00", "Missing so far, at cost", risk < 0 ? "bad" : "ok") : ""}
      ${tile("clock", open.length ? (oldest === 1 ? "1 day" : `${oldest} days`) : "—", "Oldest still open", oldest >= 7 ? "bad" : oldest >= 3 ? "warn" : "ok")}
    </div>
    <div class="ivx-how">
      <span class="ivx-how-t">How it works</span>
      <span class="ivx-how-flow">${I(IC.box)}<b>Opening count</b> doesn't match ${I(IC.arrow, "is-sm")} <b>Recount</b> by someone else, without seeing the numbers
        ${I(IC.arrow, "is-sm")} <b>Admin review</b> of the records and CCTV ${I(IC.arrow, "is-sm")} <b>Closed</b></span>
      <span class="ivx-how-flow">${I(IC.kit)}<b>Kit</b> doesn't match last night's End of Day ${I(IC.arrow, "is-sm")} <b>Admin review</b> ${I(IC.arrow, "is-sm")} <b>Closed</b></span>
    </div>
    <div class="inv-tools">
      <div class="fe-seg">${[["all", "All"], ["count", "Opening counts"], ["kit", "Kits"]].map(([v, l]) =>
        `<label class="fe-seg-btn"><input type="radio" name="ivx-kind" value="${v}"${st.kind === v ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>
      <label class="ib-search inv-find">${I(IC.search)}<input type="search" data-role="q" placeholder="Search products or people" aria-label="Search" /></label>
    </div>
    <div data-role="secs"></div>`;
  drawSecs();

  wrap.addEventListener("change", (e) => { if (e.target.name === "ivx-kind") { st.kind = e.target.value; drawSecs(); } });
  wrap.addEventListener("input", (e) => { if (e.target.dataset.role === "q") { st.q = e.target.value.trim().toLowerCase(); drawSecs(); } });
  wrap.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "older") { st.allClosed = !st.allClosed; drawSecs(); return; }
    if (a.dataset.act === "recount-all") {
      const items = list.filter((x) => matches(x) && canRecountX(x, me)).sort(byAge);
      recountAllDialog(items, staff, () => renderInvestigations(body, { staff }));
    }
  });
}

// Several recounts on one screen. Each is saved on its own, so one problem doesn't stop the rest.
function recountAllDialog(items, staff, onDone) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog inv-dlg ivx-rall";
  dlg.innerHTML = `<form class="lh-form" novalidate>
    <div class="lh-dialog-head"><h3>${I(IC.clipboard)} Recount ${items.length} products</h3>
      <p>Count each one without checking the portal. Leave a box empty to skip it. Enter moves to the next one.</p></div>
    <div class="ivx-rall-list">${items.map((x, i) => `<div class="ivx-rall-row">
      <span class="ivx-card-ic is-count">${I(IC.box)}</span>
      <span class="ivx-rall-name"><strong>${esc(x.productName)}</strong><small>${esc(whereText(x))}</small></span>
      <div class="fe-num"><input class="fe-input inv-num" type="number" min="0" step="1" inputmode="numeric" data-rc="${i}"
        placeholder="?" aria-label="${esc(`How many ${x.productName}`)}" /><span>${esc(unitPlural(x.unit || "item"))}</span></div>
      <span class="ivx-rall-res" data-res="${i}"></span></div>`).join("")}</div>
    <p class="lh-error" role="alert" hidden></p>
    <div class="lh-actions">
      <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
      <button type="submit" class="lh-btn is-primary">Save recounts</button>
    </div></form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".lh-error");
  const btn = form.querySelector('[type="submit"]');
  let saved = 0;
  let finished = false;
  let busy = false;
  dlg.addEventListener("close", () => { dlg.remove(); if (saved) onDone(); });
  dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { if (!busy) dlg.close(); });
  form.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("[data-rc]")) return;
    e.preventDefault();
    const all = [...form.querySelectorAll("[data-rc]:not(:disabled)")];
    const next = all[all.indexOf(e.target) + 1];
    if (next) next.focus(); else btn.focus();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (finished) { dlg.close(); return; }
    err.hidden = true;
    const todo = [...form.querySelectorAll("[data-rc]")].filter((el) => !el.disabled && el.value.trim() !== "");
    if (!todo.length) { err.textContent = "Enter at least one count."; err.hidden = false; return; }
    const bad = todo.find((el) => !(Number(el.value) >= 0) || !Number.isInteger(Number(el.value)));
    if (bad) { err.textContent = "Counts need to be whole numbers of 0 or more."; err.hidden = false; bad.focus(); return; }
    busy = true;
    btn.disabled = true;
    for (const el of todo) {
      const i = Number(el.dataset.rc);
      const res = form.querySelector(`[data-res="${i}"]`);
      res.className = "ivx-rall-res";
      res.textContent = "Saving…";
      try {
        const r = await saveRecount(items[i].id, el.value, staff);
        saved++;
        el.disabled = true;
        res.className = `ivx-rall-res is-${r.matched ? "ok" : "warn"}`;
        res.innerHTML = r.matched ? `${I(IC.check)} Matched: closed` : `${I(IC.alert)} Different: goes to an admin`;
      } catch (ex) {
        console.error("Recount failed:", ex);
        res.className = "ivx-rall-res is-bad";
        res.textContent = errText(ex, "Couldn't save");
      }
    }
    busy = false;
    btn.disabled = false;
    const left = form.querySelectorAll("[data-rc]:not(:disabled)").length;
    if (!left) { finished = true; btn.textContent = "Done"; dlg.querySelector('[data-act="cancel"]').hidden = true; }
    showToast(`${saved} recount${saved === 1 ? "" : "s"} saved`);
  });
  dlg.showModal();
  const first = form.querySelector("[data-rc]");
  if (first) first.focus();
}

/* ===================== One investigation ===================== */

export async function mountInvestigation(container, { id, staff } = {}) {
  const back = "#/inventory/investigations";
  const root = document.createElement("section");
  root.className = "page wide";
  container.replaceChildren(root);
  const canManage = can("inventory.manage");
  const me = myUid();
  let x = null;
  let products = [];
  let ev = null;
  let evErr = "";
  let showNums = false;
  let busy = false;
  let likely = [];   // "Could explain it", for the Use this buttons

  async function load() {
    root.innerHTML = `<a class="back-link" href="${back}">← Investigations</a>${SKEL}`;
    try {
      [x, products] = await Promise.all([getInvestigation(id), listProducts().catch(() => [])]);
    } catch (err) {
      console.error("Investigation load failed:", err);
      if (root.isConnected) root.innerHTML = `<a class="back-link" href="${back}">← Investigations</a>
        <div class="state"><strong>Couldn't open the investigation</strong>${esc(errText(err, "Check your connection and try again."))}</div>`;
      return;
    }
    if (!root.isConnected) return;
    if (!x) {
      root.innerHTML = `<a class="back-link" href="${back}">← Investigations</a><div class="state"><strong>Not found</strong>This investigation no longer exists.</div>`;
      return;
    }
    showNums = peekedBy(x, me);
    ev = null;
    evErr = "";
    draw();
    (isOvernight(x) ? kitOvernightEvidence(x) : investigationEvidence(x).then(async (r) => {
      // Shelf products: billing sheets against Timely invoices over the same days
      if (x.loc === "shelf") {
        r.billing = await billingCheck({ fromKey: dayKey(r.since), toKey: dayKey(r.countAt), productId: x.productId })
          .catch((err) => { console.warn("Billing check failed:", err); return null; });
      }
      return r;
    }))
      .then((r) => { ev = r; })
      .catch((err) => { console.warn("Record check failed:", err); evErr = "Couldn't check the records. Reload to try again."; })
      .finally(() => { if (root.isConnected) drawEvidence(); });
  }

  const blindNow = () => !isOvernight(x) && x.status === "recount" && !showNums;

  function ctx() {
    const kit = isOvernight(x);
    const p = products.find((q) => q.id === x.productId) || null;
    const unit = x.unit || (p && (kit ? p.doseUnit : p.stockUnit)) || (kit ? "units" : "item");
    const diff = kit ? r1(diffOf(x)) : diffOf(x);
    return {
      kit, p, unit, diff, blind: blindNow(), value: valueOf(x, p),
      amt: (n) => (kit ? `${r1(n)} ${unit}` : plural(n, unit)),
      word: (n) => unitWord({ ...x, unit }, n),
    };
  }

  /* ---------- Pieces of the page ---------- */

  const headHtml = (c) => `<div class="ivx-head">
    <span class="ivx-card-ic is-${c.kit ? "kit" : "count"} is-lg">${I(c.kit ? IC.kit : IC.box)}</span>
    <div><h2>${esc(x.productName)}</h2>
      <p class="muted">${esc(whereText(x))} · ${c.kit
        ? `Overnight kit check, Start of Day ${esc(niceKey(x.dateKey) || day(x.openedAt))}`
        : `Opening count ${esc(day(x.openedAt))} by ${esc(x.openedBy || "—")}`}${x.countNote ? ` · “${esc(x.countNote)}”` : ""}</p></div>
    ${pill(x)}</div>`;

  const stepperHtml = () => `<ol class="ivx-steps">${stepsOf(x).map((s, i) => `<li class="is-${s.state}">
    <span class="ivx-dot">${s.state === "done" ? I(IC.check) : s.state === "skip" ? "–" : i + 1}</span>
    <span class="ivx-step-t"><b>${esc(s.label)}</b><small>${esc(s.state === "skip" ? "Not needed" : s.state === "now" ? "Now" : s.sub)}</small></span></li>`).join("")}</ol>`;

  function nextHtml() {
    const n = nextOf(x, me, canManage);
    return `<div class="ivx-banner is-${n.tone}">
      <span class="ivx-banner-ic">${I(IC[n.icon])}</span>
      <div class="ivx-banner-t"><small>${n.tone === "done" ? "Finished" : "What happens next"}</small>
        <strong>${n.who ? `${esc(n.who)} ` : ""}${esc(n.text)}</strong>${n.hint ? `<p>${esc(n.hint)}</p>` : ""}</div>
      ${n.act ? `<button type="button" class="lh-btn is-primary" data-go="${n.act}">${n.act === "recount" ? "Recount now" : "Review now"}</button>` : ""}
    </div>`;
  }

  const diffTile = (c) => `<div class="ivx-tile is-diff is-${c.diff < 0 ? "neg" : c.diff > 0 ? "pos" : "zero"}">
    <span>Difference</span><strong>${esc(signed(c.diff))}</strong>
    <small>${esc(c.word(c.diff))}${c.value !== null ? ` · ${esc(money(c.value))} at cost` : ""}</small></div>`;

  function compareHtml(c) {
    const rc = x.recount;
    const portal = rc ? rc.digital : x.digital;
    const latest = rc ? rc.counted : x.counted;
    const max = Math.max(1, x.digital, x.counted, rc ? rc.counted : 0, rc ? rc.digital : 0);
    const bar = (label, n, cls) => `<div class="ivx-bar ${cls}"><span>${esc(label)}</span>
      <span class="ivx-bar-track"><i style="width:${Math.max(3, Math.round((n / max) * 100))}%"></i></span><b>${n}</b></div>`;
    return `<div class="ivx-tiles">
        <div class="ivx-tile is-portal"><span>The portal said</span><strong>${x.digital}</strong><small>at the opening count</small></div>
        <div class="ivx-tile is-count"><span>Counted</span><strong>${x.counted}</strong><small>by ${esc(x.openedBy || "—")}</small></div>
        ${rc ? `<div class="ivx-tile is-count"><span>Recounted</span><strong>${rc.counted}</strong><small>by ${esc(rc.by || "—")} · portal ${rc.digital} then</small></div>` : ""}
        ${diffTile(c)}
      </div>
      <div class="ivx-bars">
        ${bar("The portal said", portal, "is-portal")}
        ${bar(rc ? "Recounted" : "Counted", latest, "is-count")}
      </div>`;
  }

  function kitFlowHtml(c) {
    const o = x.overnight || {};
    const moved = r1(o.moved);
    const tile = (label, n, cls, sub) => `<div class="ivx-tile ${cls || ""}"><span>${esc(label)}</span><strong>${esc(n)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
    return `<div class="ivx-flow">
      ${tile("End of Day count", r1(o.endCounted), "", niceKey(o.fromDateKey))}
      <span class="ivx-op">${moved < 0 ? "−" : "+"}</span>
      ${tile("Recorded since", Math.abs(moved), "", "used, restocked, lent or borrowed")}
      <span class="ivx-op">=</span>
      ${tile("Should have had", r1(o.expected), "is-portal")}
      <span class="ivx-op">vs</span>
      ${tile("Counted at Start of Day", r1(x.counted), "is-count", niceKey(x.dateKey))}
      <span class="ivx-op">→</span>
      ${diffTile(c)}
    </div>`;
  }

  const blindHtml = () => `<div class="ivx-blind">${I(IC.eyeOff)}<div>
    <strong>The numbers are hidden until it's recounted</strong>
    <p>So whoever recounts it isn't influenced by what the portal says.</p>
    ${canManage ? `<button type="button" class="lh-btn" data-act="show">Show me the numbers</button>
      <small>You then can't do the recount yourself.</small>` : ""}</div></div>`;

  function recountHtml(c) {
    if (c.kit || x.status !== "recount") return "";
    if (canRecountX(x, me)) {
      return `<section class="ivx-sec" id="ivx-recount"><h3>${I(IC.clipboard)} Recount it</h3>
        <div class="ivx-recount">
          <div class="ivx-recount-what">
            <p>Count every <strong>${esc(c.unit)}</strong> of</p>
            <strong class="ivx-big">${esc(x.productName)}</strong>
            <div class="ivx-chips"><span class="ivx-chip">${esc(LOC[x.loc] || x.loc)}</span>${
              x.batch ? `<span class="ivx-chip">${esc(x.batchLabel || "Batch")} ${esc(x.batch)}</span>` : ""}</div>
            <ul class="ivx-tips">
              <li>Don't check the portal first.</li>
              <li>Look everywhere it could be: ${x.loc === "jt" ? "every shelf and box in JT storage" : "the shelf, the fridge and any open boxes"}.</li>
              ${x.batch ? "<li>Only count this batch: check the number on each one.</li>" : ""}
            </ul>
          </div>
          <form data-role="recount" class="ivx-recount-form" novalidate>
            <span class="lh-label">How many did you count?</span>
            <div class="ivx-qty">
              <button type="button" data-step="-1" aria-label="One less">${I(IC.minus)}</button>
              <input name="n" type="number" min="0" step="1" inputmode="numeric" placeholder="?" aria-label="How many" />
              <button type="button" data-step="1" aria-label="One more">${I(IC.plus)}</button>
            </div>
            <small class="muted">${esc(unitPlural(c.unit))}. Enter 0 if there are none.</small>
            <button type="submit" class="lh-btn is-primary ivx-wide">Save recount</button>
            <p class="lh-error" role="alert" hidden></p>
          </form>
        </div></section>`;
    }
    const opener = x.openedByUid === me;
    const msg = opener && !x.aloneApproved
      ? "You did the first count, so <strong>someone else needs to recount it</strong>. If you're the only one on site today, ask an admin to let you."
      : peekedBy(x, me) ? "You've seen the numbers, so <strong>someone else needs to recount it</strong>."
      : `Waiting for someone on site to recount it${x.aloneApproved ? ` (${esc(x.openedBy || "the first counter")} has been allowed to)` : ""}.`;
    return `<section class="ivx-sec"><h3>${I(IC.clipboard)} Recount</h3>
      <div class="ivx-wait">${I(IC.user)}<p>${msg}</p></div>
      ${canManage && !x.aloneApproved ? `<button type="button" class="lh-btn" data-act="alone">Let ${esc(x.openedBy || "the first counter")} recount (only one on site)</button>` : ""}
    </section>`;
  }

  const evShell = (c) => `<section class="ivx-sec" id="ivx-ev"><h3>${I(IC.search)} What the records show</h3>
    <div data-role="ev">${c.blind ? '<p class="muted">Shown after the recount, so the recount stays blind.</p>'
      : '<div class="skeleton" style="height:140px;border-radius:12px"></div>'}</div></section>`;

  function reviewHtml(c) {
    if (x.status !== "review") return "";
    if (!canManage) {
      return `<section class="ivx-sec"><h3>${I(IC.search)} Admin review</h3>
        <div class="ivx-wait">${I(IC.user)}<p>Waiting for an admin to check the records and CCTV, and close it.</p></div></section>`;
    }
    const groups = groupsFor(c.diff);
    const q1 = c.diff < 0
      ? `${c.amt(-c.diff)} fewer than the portal said. Where did ${-c.diff === 1 && !c.kit ? "it" : "they"} go?`
      : `${c.amt(c.diff)} more than the portal said. Why?`;
    return `<section class="ivx-sec ivx-review" id="ivx-review"><h3>${I(IC.check)} What happened?</h3>
      <form data-role="review" novalidate>
        <div class="ivx-q"><span class="ivx-q-n">1</span><div class="ivx-q-body"><strong>${esc(q1)}</strong>
          <div class="ivx-groups">${groups.map((g) => `<label class="ivx-group">
            <input type="radio" name="grp" value="${g.key}" />
            <span class="ivx-group-ic">${I(IC[g.icon])}</span>
            <span><b>${esc(g.label)}</b><small>${esc(g.help)}</small></span></label>`).join("")}</div></div></div>
        <div class="ivx-q" data-role="q2" hidden><span class="ivx-q-n">2</span><div class="ivx-q-body"><strong>Which one?</strong>
          <div class="ivx-outs" data-role="outs"></div></div></div>
        <div class="ivx-q" data-role="q3" hidden><span class="ivx-q-n" data-role="q3n">3</span><div class="ivx-q-body">
          <strong>Check it, then close</strong>
          <div data-role="preview"></div>
          <label class="fe-check ivx-cctv-tick"><input type="checkbox" name="cctv" /> ${I(IC.camera)} CCTV checked</label>
          <label class="lh-field"><span class="lh-label">CCTV notes (optional)</span>
            <input name="cctvNote" maxlength="500" placeholder="e.g. 14 Oct 6:10pm, kit left in treatment room 2" /></label>
          <label class="lh-field"><span class="lh-label">What you found</span>
            <textarea name="note" rows="3" maxlength="500" placeholder="A sentence is enough. It's kept with the investigation."></textarea></label>
          <p class="lh-error" role="alert" hidden></p>
          <div class="lh-actions"><button type="submit" class="lh-btn is-primary">Close investigation</button></div>
        </div></div>
      </form></section>`;
  }

  function previewHtml(k, c) {
    const o = INV_OUTCOMES[k] || {};
    const label = outLabel(k);
    if (c.kit) {
      return `<div class="ivx-prev is-none">${I(IC.kit)}<div><strong>The kit isn't changed from here.</strong>
        <small>Logged as “${esc(label)}”. If ${esc(x.staffName || "their")}'s kit numbers need fixing, accept the difference in
        <a href="#/reports/variance">Reporting → Count differences</a>.</small></div></div>`;
    }
    if (!o.adjust || !c.diff) {
      const recs = k === "fixed-record" ? likely.filter((l) => l.link && (l.icon === "clipboard" || l.icon === "patient")) : [];
      return `<div class="ivx-prev is-none">${I(IC.check)}<div><strong>Stock doesn't change.</strong>
        <small>Logged as “${esc(label)}”.${k === "fixed-record"
          ? " Fix the patient's record first (Reporting → Usage → Correct), so the stock is right." : ""}</small>
        ${recs.length ? `<span class="ivx-prev-links">${recs.map((l) => `<a class="lh-btn is-quiet" href="${esc(l.link)}">${esc(l.linkText)}: ${esc(l.text.split(" · ")[0])}</a>`).join("")}</span>` : ""}
      </div></div>`;
    }
    const where = LOC[x.loc] || x.loc;
    const cost = c.value !== null ? ` ${money(c.value)} at cost.` : "";
    if (c.p && !c.p.tracked) {
      const now = Number(c.p.stock[x.loc]) || 0;
      const after = Math.max(0, now + c.diff);
      return `<div class="ivx-prev is-${c.diff < 0 ? "neg" : "pos"}">
        <span class="ivx-prev-n">${now}</span>${I(IC.arrow)}<span class="ivx-prev-n is-to">${after}</span>
        <div><strong>${esc(where)}: ${esc(signed(c.diff))} ${esc(c.word(c.diff))}</strong>
          <small>Logged in Activity as “${esc(o.label)}”.${esc(cost)}</small></div></div>`;
    }
    return `<div class="ivx-prev is-${c.diff < 0 ? "neg" : "pos"}">${I(c.diff < 0 ? IC.minus : IC.plus)}
      <div><strong>${esc(where)}${x.batch ? `, ${esc(x.batchLabel || "Batch")} ${esc(x.batch)}` : ""}: ${esc(signed(c.diff))} ${esc(c.word(c.diff))}</strong>
        <small>Logged in Activity as “${esc(o.label)}”.${esc(cost)}</small></div></div>`;
  }

  function closedHtml(c) {
    if (x.status !== "closed") return "";
    const stock = x.applied ? `${LOC[x.loc] || x.loc} ${signed(x.applied)} ${c.word(x.applied)}`
      : c.kit ? "Kit not changed from here" : "Stock not changed";
    return `<section class="ivx-sec ivx-done">
      <div class="ivx-done-head"><span class="ivx-done-ic">${I(IC.check)}</span>
        <div><small>Closed ${esc(day(x.closedAt))} by ${esc(x.closedBy || "—")}</small><strong>${esc(outLabel(x.outcome))}</strong></div></div>
      ${x.outcomeNote ? `<p class="ivx-done-note">“${esc(x.outcomeNote)}”</p>` : ""}
      <div class="ivx-chips">
        <span class="ivx-chip ${x.applied ? "is-warn" : ""}">${I(IC.box)}${esc(stock)}</span>
        ${x.cctv && (x.cctv.checked || x.cctv.note) ? `<span class="ivx-chip">${I(IC.camera)}${x.cctv.checked ? "CCTV checked" : "CCTV not checked"}${
          x.cctv.note ? `: ${esc(x.cctv.note)}` : ""}</span>` : ""}
      </div></section>`;
  }

  function historyHtml(c) {
    const list = (x.events || []).slice().reverse();
    if (!list.length) return "";
    return `<section class="ivx-sec"><h3>${I(IC.clock)} History</h3><ol class="ivx-tl is-history">${list.map((e) => `<li>
      <span class="ivx-tl-dot"></span><div><strong>${esc(e.action)}</strong>
      <small>${esc([when(new Date(e.at)), e.by, !c.blind && e.note ? e.note : ""].filter(Boolean).join(" · "))}</small></div></li>`).join("")}</ol></section>`;
  }

  function draw() {
    const c = ctx();
    const numbers = c.kit ? kitFlowHtml(c) : c.blind ? blindHtml() : compareHtml(c);
    const parts = [
      headHtml(c), stepperHtml(), nextHtml(), closedHtml(c),
      `<section class="ivx-sec"><h3>${I(IC.box)} The numbers</h3>${numbers}</section>`,
    ];
    if (x.status === "recount") parts.push(recountHtml(c), evShell(c));
    else parts.push(evShell(c), reviewHtml(c));
    parts.push(historyHtml(c));
    root.innerHTML = `<div class="ivx-wrap"><a class="back-link" href="${back}">← Investigations</a>${parts.join("")}</div>`;
    drawEvidence();
  }

  /* ---------- What the records show ---------- */

  function drawEvidence() {
    const box = root.querySelector('[data-role="ev"]');
    if (!box || blindNow()) return;
    if (evErr) box.innerHTML = `<p class="tb-none tb-bad">${esc(evErr)}</p>`;
    else if (ev) box.innerHTML = isOvernight(x) ? overnightHtml(ev) : evidenceHtml(ev);
  }

  const likelyCard = (l, i) => `<div class="ivx-likely is-${l.tone}">
    <span class="ivx-likely-ic">${I(IC[l.icon])}</span>
    <div><strong>${esc(l.title)}</strong><small>${esc(l.text)}</small></div>
    <span class="ivx-likely-acts">${l.link ? `<a class="lh-btn is-quiet" href="${esc(l.link)}">${esc(l.linkText)}</a>` : ""}${
      canManage && x.status === "review" && l.use ? `<button type="button" class="lh-btn" data-use="${i}">Use this</button>` : ""}</span></div>`;

  const likelyBlock = (title) => (likely.length
    ? `<h4 class="ivx-h4">${esc(title)}</h4><div class="ivx-likelys">${likely.map(likelyCard).join("")}</div>`
    : `<div class="ivx-none">${I(IC.question)}<div><strong>Nothing in the records explains it</strong>
        <small>Check other places it could be, deliveries that haven't been unpacked, and CCTV.</small></div></div>`);

  const cctvHtml = (e) => `<div class="ivx-cctv">${I(IC.camera)}<div><strong>CCTV to check</strong>
    <small>${esc(when(e.since))} → ${esc(when(e.countAt))}</small>
    ${e.people.length ? `<span class="ivx-people">${e.people.map((p) => `<span class="ivx-chip">${I(IC.user)}${esc(p)}</span>`).join("")}</span>` : ""}
  </div></div>`;

  function likelyOf(e) {
    const out = [];
    ((e.booked && e.booked.items) || []).forEach((b) => out.push({
      icon: "patient", tone: "warn", title: "Booked, but no treatment record",
      text: [b.patientName || "Patient", (b.services || []).join(", "), b.staff, `${niceKey(b.dateKey)}${b.time ? ` ${b.time}` : ""}`].filter(Boolean).join(" · "),
      use: "not-recorded", note: `Used on ${b.patientName || "a patient"} on ${niceKey(b.dateKey)} (${(b.services || []).join(", ")}), with no treatment record.`,
      link: b.patientId ? `#/patient/${encodeURIComponent(b.patientId)}` : "", linkText: "Open patient",
    }));
    (e.short || []).forEach((u) => out.push({
      icon: "clipboard", tone: "warn", title: `Saved without enough stock${u.resolved ? " (resolved)" : ""}`,
      text: [u.patientName, u.formName, u.by, day(u.at)].filter(Boolean).join(" · "),
      use: "not-recorded", note: `Saved short on ${u.patientName || "a patient"}'s ${u.formName || "treatment record"} (${day(u.at)}).`,
      link: u.submissionId ? `#/form-record/${encodeURIComponent(u.submissionId)}` : "", linkText: "Open record",
    }));
    (e.pos || []).forEach((po) => out.push({
      icon: "truck", tone: "info", title: "Delivery not fully put away", text: `${po.number} · ${PO_STATUS[po.status] || po.status}`,
      use: "receiving", note: `Delivery on ${po.number}.`, link: `#/inventory/po/${encodeURIComponent(po.id)}`, linkText: "Open order",
    }));
    (e.rels || []).forEach((r) => out.push({
      icon: "box", tone: "info", title: "JT storage release waiting", text: `${plural(r.qty, r.unit)} for ${r.requestedBy || ""}`,
    }));
    ((e.billing && e.billing.items) || []).filter((b) => b.type !== "nosheet").forEach((b) => out.push({
      icon: "receipt", tone: "warn", title: (BC_TYPES[b.type] || {}).label || "Billing sheet and invoice don't match",
      text: [b.patientName, niceKey(b.day), `billing sheet ${b.given}, invoice ${b.invoiced}`, (b.staff || []).join(", "),
        b.check ? `checked: “${b.check.note}”` : ""].filter(Boolean).join(" · "),
    }));
    return out;
  }

  function evidenceHtml(e) {
    likely = likelyOf(e);
    const unit = x.unit || "item";
    let bal = e.digitalAtSince;
    const nodes = [`<li class="is-edge"><span class="ivx-tl-dot is-ok">${I(IC.check)}</span><div>
      <strong>${e.sinceCount ? "Last count that matched" : "30 days before the count"}</strong>
      <small>${esc(when(e.since))} · the portal had ${esc(plural(e.digitalAtSince, unit))}</small></div><span class="ivx-tl-bal">${e.digitalAtSince}</span></li>`];
    e.ledger.forEach((m) => {
      bal += m.delta;
      nodes.push(`<li><span class="ivx-tl-dot is-${m.delta < 0 ? "neg" : "pos"}">${m.delta < 0 ? "−" : "+"}</span><div>
        <strong>${esc(MOVE_TYPES[m.type] || m.type)} <em class="ivx-delta is-${m.delta < 0 ? "neg" : "pos"}">${esc(signed(m.delta))}</em></strong>
        <small>${esc([when(m.at), m.by, m.note].filter(Boolean).join(" · "))}</small></div><span class="ivx-tl-bal">${bal}</span></li>`);
    });
    nodes.push(`<li class="is-edge is-end"><span class="ivx-tl-dot is-bad">${I(IC.alert)}</span><div>
      <strong>Opening count: counted ${esc(x.counted)}</strong>
      <small>${esc(when(e.countAt))} · the portal said ${esc(x.digital)} (${esc(signed(x.variance))})</small></div><span class="ivx-tl-bal">${x.digital}</span></li>`);
    const n = e.ledger.length;
    const notes = [
      e.booked && !e.booked.configured ? "Bookings aren't checked yet. Link services to products in Inventory → Service links." : "",
      e.booked && e.booked.failed ? "Bookings couldn't be checked this time. Reload to try again." : "",
      e.billing && !e.billing.started ? "Billing sheets aren't compared with invoices yet. Set the start date in Inventory → Products → Invoice links." : "",
      e.billing && e.billing.waiting ? `${e.billing.waiting} billing sheet line${e.billing.waiting === 1 ? " is" : "s are"} waiting for their invoice upload.` : "",
    ].filter(Boolean);
    return `${likelyBlock("Could explain it")}
      ${cctvHtml(e)}
      <details class="ivx-tl-wrap"${n <= 6 ? " open" : ""}>
        <summary>Every stock change since then <em>${n}</em><span class="ivx-tl-legend">Portal after</span></summary>
        <ol class="ivx-tl">${nodes.join("")}</ol></details>
      ${notes.map((t) => `<p class="muted ivx-note">${esc(t)}</p>`).join("")}`;
  }

  function overnightHtml(e) {
    const u = x.unit || "units";
    const o = x.overnight || {};
    const who = x.staffName || x.openedBy || "The injector";
    const moved = r1(o.moved);
    const label = (v) => KIT_FLOW_LABELS[v.type] || MOVE_TYPES[v.type] || v.type;

    likely = [];
    if (Math.abs(r1(e.total) - moved) >= 0.05) {
      likely.push({ icon: "alert", tone: "warn", title: "The records changed after the count",
        text: `They now come to ${signed(r1(e.total))} ${u}, but the morning check used ${signed(moved)}. Something was saved, corrected or removed afterwards.` });
    }
    e.events.filter((v) => v.type === "kit-use" && o.fromDateKey && v.at && dayKey(v.at) === o.fromDateKey).forEach((v) => likely.push({
      icon: "clipboard", tone: "warn", title: "Treatment saved after End of Day",
      text: `${v.note} · saved ${time(v.at)}. If it was done before the End of Day count, those ${-v.units} ${u} were taken off twice.` }));
    e.events.filter((v) => (v.type === "kit-in" || v.type === "kit-out") && v.status !== "confirmed").forEach((v) => likely.push({
      icon: "user", tone: v.status === "disputed" ? "bad" : "warn", title: `${v.status === "disputed" ? "Disputed" : "Unconfirmed"} borrow`,
      text: `${label(v)} · ${signed(v.units)} ${u} · ${v.note} · ${when(v.at)}` }));
    if (e.correctedAt && e.startItem && Math.abs(r1(e.startItem.counted) - r1(x.counted)) >= 0.05) {
      likely.push({ icon: "clipboard", tone: "info", title: "Start of Day was corrected",
        text: `At ${time(e.correctedAt)} · the latest count is ${r1(e.startItem.counted)} ${u} (this check used ${r1(x.counted)}).` });
    }
    const unknown = (e.startItem && e.startItem.unknown) || [];
    if (unknown.length) {
      likely.push({ icon: "question", tone: "warn", title: `${unknown.length} batch${unknown.length === 1 ? " isn't" : "es aren't"} in the kit records`,
        text: `${unknown.map((b) => `${b.batch || "No batch"} (${r1(b.units)} ${u})`).join(", ")}. Often a typo in the batch number.` });
    }
    const expMis = ((e.startItem && e.startItem.rows) || []).filter((r) => r.expiryMismatch);
    if (expMis.length) {
      likely.push({ icon: "question", tone: "info", title: "Expiry typed differently to the kit records", text: expMis.map((r) => r.batch).join(", ") });
    }

    let bal = r1(o.endCounted);
    const nodes = [`<li class="is-edge"><span class="ivx-tl-dot is-ok">${I(IC.check)}</span><div>
      <strong>End of Day count: ${esc(r1(o.endCounted))} ${esc(u)}</strong><small>${esc(when(e.since))} · ${esc(who)}</small></div>
      <span class="ivx-tl-bal">${esc(bal)}</span></li>`];
    e.events.forEach((v) => {
      bal = r1(bal + v.units);
      const flag = v.status === "disputed" ? ' <span class="inv-flag is-bad">Disputed</span>' : v.status === "unconfirmed" ? ' <span class="inv-flag is-warn">Not confirmed</span>' : "";
      nodes.push(`<li><span class="ivx-tl-dot is-${v.units < 0 ? "neg" : "pos"}">${v.units < 0 ? "−" : "+"}</span><div>
        <strong>${esc(label(v))} <em class="ivx-delta is-${v.units < 0 ? "neg" : "pos"}">${esc(signed(v.units))}</em>${flag}</strong>
        <small>${esc([when(v.at), v.by, v.note].filter(Boolean).join(" · "))}</small></div><span class="ivx-tl-bal">${esc(bal)}</span></li>`);
    });
    nodes.push(`<li class="is-edge is-end"><span class="ivx-tl-dot is-bad">${I(IC.alert)}</span><div>
      <strong>Counted at Start of Day: ${esc(r1(x.counted))} ${esc(u)}</strong>
      <small>${esc(when(e.countAt))} · should have had ${esc(r1(o.expected))} (${esc(signed(r1(x.variance)))})</small></div>
      <span class="ivx-tl-bal">${esc(r1(o.expected))}</span></li>`);
    return `${likelyBlock("Could explain it")}
      ${cctvHtml(e)}
      ${!e.exactSince ? `<p class="muted ivx-note">The exact End of Day time couldn't be read, so this shows everything from the start of ${esc(niceKey(o.fromDateKey) || "that day")}.</p>` : ""}
      <details class="ivx-tl-wrap"${e.events.length <= 6 ? " open" : ""}>
        <summary>Everything in or out of the kit since End of Day <em>${e.events.length}</em><span class="ivx-tl-legend">Should have</span></summary>
        <ol class="ivx-tl">${nodes.join("")}</ol></details>`;
  }

  /* ---------- The review form ---------- */

  const outcomeOf = (form) => {
    const r = form.querySelector('[name="outcome"]:checked') || form.querySelector('input[type="hidden"][name="outcome"]');
    return r ? r.value : "";
  };

  function syncReview(form, pick = "") {
    const c = ctx();
    const grp = (form.querySelector('[name="grp"]:checked') || {}).value || "";
    const g = groupsFor(c.diff).find((q) => q.key === grp);
    const q2 = form.querySelector('[data-role="q2"]');
    const q3 = form.querySelector('[data-role="q3"]');
    const outs = form.querySelector('[data-role="outs"]');
    if (!g) { q2.hidden = true; q3.hidden = true; return; }
    if (form.dataset.grp !== grp) {
      form.dataset.grp = grp;
      outs.innerHTML = g.outcomes.length > 1
        ? g.outcomes.map((k) => `<label class="ivx-out"><input type="radio" name="outcome" value="${k}" />
            <span><b>${esc(outLabel(k))}</b><small>${esc((OUT_TEXT[k] || [])[1] || "")}</small></span></label>`).join("")
        : `<input type="hidden" name="outcome" value="${g.outcomes[0]}" />`;
    }
    if (pick) { const r = form.querySelector(`[name="outcome"][value="${pick}"]`); if (r && r.type === "radio") r.checked = true; }
    q2.hidden = g.outcomes.length < 2;
    const k = outcomeOf(form);
    q3.hidden = !k;
    form.querySelector('[data-role="q3n"]').textContent = g.outcomes.length > 1 ? "3" : "2";
    if (k) form.querySelector('[data-role="preview"]').innerHTML = previewHtml(k, c);
  }

  /* ---------- Events ---------- */

  root.addEventListener("change", (e) => {
    const form = e.target.closest('[data-role="review"]');
    if (form && (e.target.name === "grp" || e.target.name === "outcome")) syncReview(form);
  });

  root.addEventListener("click", async (e) => {
    const go = e.target.closest("[data-go]");
    if (go) {
      const sec = root.querySelector(go.dataset.go === "recount" ? "#ivx-recount" : "#ivx-review");
      if (sec) {
        sec.scrollIntoView({ behavior: "smooth", block: "start" });
        const f = sec.querySelector('input[name="n"], input[name="grp"]');
        if (f) setTimeout(() => f.focus({ preventScroll: true }), 300);
      }
      return;
    }
    const step = e.target.closest("[data-step]");
    if (step) {
      const input = step.closest("form").elements.n;
      input.value = Math.max(0, (parseInt(input.value, 10) || 0) + Number(step.dataset.step));
      return;
    }
    const use = e.target.closest("[data-use]");
    if (use) {
      const l = likely[Number(use.dataset.use)];
      const form = root.querySelector('[data-role="review"]');
      if (!l || !form) return;
      const g = groupsFor(ctx().diff).find((q) => q.outcomes.includes(l.use));
      if (!g) { showToast("That doesn't fit this difference."); return; }
      form.querySelector(`[name="grp"][value="${g.key}"]`).checked = true;
      syncReview(form, l.use);
      if (!form.elements.note.value.trim() && l.note) form.elements.note.value = l.note;
      form.closest("section").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const a = e.target.closest("[data-act]");
    if (!a || busy) return;
    if (a.dataset.act === "show") {
      busy = true;
      a.disabled = true;
      try {
        await peekInvestigation(x.id, staff);
        x.peekedByUids = [...(x.peekedByUids || []), me];
        showNums = true;
        draw();
      } catch (err) {
        console.error("Show numbers failed:", err);
        showToast(errText(err, "Couldn't show them. Try again."));
        a.disabled = false;
      } finally { busy = false; }
      return;
    }
    if (a.dataset.act === "alone") {
      busy = true;
      a.disabled = true;
      try {
        await allowAloneRecount(x.id, staff);
        showToast(`${x.openedBy || "They"} can now do the recount`);
        await load();
      } catch (err) {
        console.error("Allow recount failed:", err);
        showToast(errText(err, "Couldn't save. Try again."));
        a.disabled = false;
      } finally { busy = false; }
    }
  });

  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const form = e.target;
    const err = form.querySelector(".lh-error");
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const btn = form.querySelector('[type="submit"]');
    if (form.dataset.role === "recount") {
      const v = form.elements.n.value;
      if (v === "" || !(Number(v) >= 0) || !Number.isInteger(Number(v))) { fail("Enter how many you counted, as a whole number (0 if there are none)."); return; }
      busy = true;
      btn.disabled = true;
      err.hidden = true;
      try {
        const r = await saveRecount(x.id, v, staff);
        showToast(r.matched ? "It matched the portal, so the first count was wrong. Closed." : "Recount saved. The difference is confirmed, so an admin will review it.");
        await load();
      } catch (ex) {
        console.error("Recount failed:", ex);
        fail(errText(ex, "Couldn't save. Try again."));
        btn.disabled = false;
      } finally { busy = false; }
    } else if (form.dataset.role === "review") {
      const f = form.elements;
      const outcome = outcomeOf(form);
      if (!outcome) { fail("Choose what happened."); return; }
      if (!f.note.value.trim()) { fail("Add a note saying what you found."); f.note.focus(); return; }
      busy = true;
      btn.disabled = true;
      err.hidden = true;
      try {
        await closeInvestigation(x.id, { outcome, note: f.note.value, cctvChecked: f.cctv.checked, cctvNote: f.cctvNote.value }, staff);
        showToast("Investigation closed");
        await load();
      } catch (ex) {
        console.error("Close investigation failed:", ex);
        fail(errText(ex, "Couldn't close it. Try again."));
        btn.disabled = false;
      } finally { busy = false; }
    }
  });

  load();
}