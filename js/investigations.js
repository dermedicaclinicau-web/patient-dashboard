// Inventory → Investigations (#/inventory/investigations and #/inventory/investigations/<id>).
// Opened when a count doesn't match the digital count.
// Step 1: the portal checks its own records. Step 2: someone else recounts, without seeing the numbers.
// Step 3: an admin reviews what's left, checks CCTV, and closes it with what happened.
// Overnight kit differences (Start of Day vs last End of Day) have no recount: they go straight to admin review.
import {
  INV_STATUS, INV_OUTCOMES, MOVE_TYPES, PO_STATUS, KIT_FLOW_LABELS, listInvestigations, getInvestigation, investigationEvidence,
  kitOvernightEvidence, saveRecount, allowAloneRecount, closeInvestigation, listProducts, plural, unitPlural, myUid, dayKey,
} from "./inventory-api.js";
import { can } from "./perms.js";
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
const whereText = (x) => (x.loc === "kit"
  ? `${x.staffName || "Injector"}'s kit`
  : `${LOC[x.loc] || x.loc}${x.batch ? ` · ${x.batchLabel || "Batch"} ${x.batch}` : ""}`);
const diffOf = (x) => Number(x.recount ? x.recount.variance : x.variance) || 0;
const statusText = (x) => (x.status === "closed" ? (INV_OUTCOMES[x.outcome] || {}).label || "Closed" : INV_STATUS[x.status] || x.status);
const pill = (x) => `<span class="rq-status is-${x.status === "closed" ? "received" : x.status === "review" ? "declined" : "open"}">${esc(statusText(x))}</span>`;
const errText = (err, fb) => (err && err.code === "permission-denied"
  ? "You don't have access. Check the inv_investigations Firestore rule has been published, and your Inventory access in Staff."
  : err && err.message && !err.code ? err.message : fb);

/* ===================== The list (Inventory → Investigations) ===================== */

export async function renderInvestigations(body) {
  body.innerHTML = SKEL;
  let list;
  try { list = await listInvestigations(); } catch (err) {
    console.error("Investigations failed:", err);
    if (body.isConnected) body.innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load the investigations."))}</div>`;
    return;
  }
  if (!body.isConnected) return;
  const me = myUid();
  const canManage = can("inventory.manage");
  let view = "open";

  const draw = () => {
    const nOpen = list.filter((x) => x.status !== "closed").length;
    const rows = list.filter((x) => view === "all" || (view === "open" ? x.status !== "closed" : x.status === "closed"));
    body.innerHTML = `
      <div class="inv-tools"><div class="fe-seg">${[["open", `Open (${nOpen})`], ["closed", "Closed"], ["all", "All"]].map(([v, l]) =>
        `<label class="fe-seg-btn"><input type="radio" name="ivx-v" value="${v}"${view === v ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div></div>
      <p class="muted rp-range">Opened when a count doesn't match the digital count. Someone else recounts it without seeing the numbers,
        then an admin reviews anything that's still different. Overnight kit differences go straight to admin review.</p>
      ${rows.length ? `<div class="po-list">${rows.map((x) => {
        const kit = isOvernight(x);
        const blind = !kit && x.status === "recount" && !canManage;
        const canDo = !kit && x.status === "recount" && isCounter() && (x.openedByUid !== me || x.aloneApproved === true);
        const what = kit ? `${whereText(x)} · overnight · Start of Day ${niceKey(x.dateKey) || day(x.openedAt)}`
          : `${whereText(x)} · opened ${when(x.openedAt)} by ${x.openedBy || "—"}`;
        return `<a class="po-row" href="#/inventory/investigations/${encodeURIComponent(x.id)}">
          <span class="inv-name"><strong>${esc(x.productName)}</strong><small>${esc(what)}</small></span>
          <span>${pill(x)}${canDo ? ' <span class="inv-flag is-warn">You can recount</span>' : ""}</span>
          <strong class="po-amt">${blind ? "—" : esc(signed(r1(diffOf(x))))}</strong></a>`;
      }).join("")}</div>` : `<div class="tm-empty">${view === "open" ? "No open investigations. 👍" : "Nothing here yet."}</div>`}`;
  };
  body._ivxView = (v) => { view = v; draw(); };
  if (!body.dataset.ivx) {
    body.dataset.ivx = "1";
    body.addEventListener("change", (e) => { if (e.target.name === "ivx-v" && body._ivxView) body._ivxView(e.target.value); });
  }
  draw();
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
    ev = null;
    evErr = "";
    draw();
    (isOvernight(x) ? kitOvernightEvidence(x) : investigationEvidence(x))
      .then((r) => { ev = r; })
      .catch((err) => { console.warn("Record check failed:", err); evErr = "Couldn't check the records. Reload to try again."; })
      .finally(() => { if (root.isConnected) drawEvidence(); });
  }

  const blindNow = () => !isOvernight(x) && x.status === "recount" && !showNums;

  function draw() {
    const kit = isOvernight(x);
    const p = products.find((q) => q.id === x.productId) || null;
    const unit = x.unit || (p && (kit ? p.doseUnit : p.stockUnit)) || "item";
    const amt = (n) => plural(n, unit);
    const blind = blindNow();
    const diff = kit ? r1(diffOf(x)) : diffOf(x);
    const perItem = p && p.cost !== null && p.cost !== undefined ? p.cost / Math.max(1, p.packSize) : null;
    const each = perItem === null ? null : kit ? (p.dosePer ? perItem / p.dosePer : null) : perItem;
    const value = each === null ? null : Math.round(each * diff * 100) / 100;
    const opener = x.openedByUid === me;
    const canRecount = !kit && x.status === "recount" && isCounter() && (!opener || x.aloneApproved === true) && !showNums;
    const who = x.staffName || x.openedBy || "The injector";
    const o = x.overnight || {};
    const diffStat = `<div class="inv-stat ${diff < 0 ? "is-bad" : diff > 0 ? "is-warn" : ""}"><strong>${esc(signed(diff))}</strong>
      <span>${esc(kit ? unit : unitPlural(unit))}${value !== null ? ` · ${esc(money(value))} at cost` : ""}</span></div>`;

    const numbers = kit
      ? `<div class="inv-stats ivx-ov">
          <div class="inv-stat"><strong>${esc(r1(o.endCounted))}</strong><span>End of Day count${o.fromDateKey ? ` · ${esc(niceKey(o.fromDateKey))}` : ""}</span></div>
          <div class="inv-stat"><strong>${esc(signed(r1(o.moved)))}</strong><span>Recorded since</span></div>
          <div class="inv-stat"><strong>${esc(r1(o.expected))}</strong><span>Should have had</span></div>
          <div class="inv-stat"><strong>${esc(r1(x.counted))}</strong><span>Counted at Start of Day</span></div>
          ${diffStat}
        </div>`
      : blind
        ? `<div class="ivx-blind"><strong>The numbers are hidden until the recount is done</strong>, so the recount stays blind.${
            canManage ? ' <button type="button" class="lh-btn" data-act="show">Show them</button> <small>(you then can\'t do the recount yourself)</small>' : ""}</div>`
        : `<div class="inv-stats">
            <div class="inv-stat"><strong>${x.digital}</strong><span>Digital at the count</span></div>
            <div class="inv-stat"><strong>${x.counted}</strong><span>Counted by ${esc(x.openedBy || "—")}</span></div>
            ${x.recount ? `<div class="inv-stat"><strong>${x.recount.counted}</strong><span>Recounted by ${esc(x.recount.by || "—")} (digital ${x.recount.digital})</span></div>` : ""}
            ${diffStat}
          </div>`;

    // Step 2
    let step2;
    if (kit) {
      step2 = `<p class="muted">Kit differences don't have a recount. ${esc(who)} counted their own kit at Start of Day without seeing the numbers,
        so it goes straight to admin review.</p>`;
    } else if (x.recount) {
      const rc = x.recount;
      step2 = `<p>Recounted <strong>${esc(amt(rc.counted))}</strong> by ${esc(rc.by || "—")} on ${esc(when(new Date(rc.at)))}.
        Digital was ${esc(amt(rc.digital))} at the time: ${rc.variance
          ? `<strong class="rp-neg">the difference is confirmed (${esc(signed(rc.variance))})</strong>.`
          : '<strong class="rp-ok">it matched, so the first count was wrong</strong>.'}</p>`;
    } else if (x.status === "recount") {
      step2 = canRecount
        ? `<form class="ivx-recount" data-role="recount" novalidate>
            <p>Count every ${esc(unit)} of <strong>${esc(x.productName)}</strong> in <strong>${esc(whereText(x))}</strong>${
              x.batch ? " (this batch only)" : ""}. Don't check the system first.</p>
            <div class="ivx-row"><div class="fe-num"><input class="fe-in" name="n" type="number" min="0" step="1" inputmode="numeric" placeholder="?" aria-label="How many" />
              <span>${esc(unitPlural(unit))}</span></div>
              <button type="submit" class="lh-btn is-primary">Save recount</button></div>
            <p class="lh-error" role="alert" hidden></p></form>`
        : opener && !x.aloneApproved
          ? "<p>You did the first count, so <strong>someone else needs to do the recount</strong>. If you're the only one on site today, ask an admin to allow you.</p>"
          : `<p class="muted">Waiting for someone on site to recount${x.aloneApproved ? ` (${esc(x.openedBy || "the first counter")} has been allowed to)` : ""}.</p>`;
      if (canManage && !x.aloneApproved) {
        step2 += `<button type="button" class="lh-btn" data-act="alone">Allow ${esc(x.openedBy || "the first counter")} to recount (only one on site)</button>`;
      }
    } else {
      step2 = '<p class="muted">No recount was done.</p>';
    }

    // Step 3
    let step3;
    if (x.status === "closed") {
      const oc = INV_OUTCOMES[x.outcome] || {};
      step3 = `<div class="ivx-closed">
        <p><strong>${esc(oc.label || "Closed")}</strong> · closed by ${esc(x.closedBy || "—")}${x.closedAt ? ` on ${esc(when(x.closedAt))}` : ""}</p>
        ${x.outcomeNote ? `<p>${esc(x.outcomeNote)}</p>` : ""}
        ${x.cctv && (x.cctv.checked || x.cctv.note) ? `<p><strong>CCTV:</strong> ${x.cctv.checked ? "checked" : "not checked"}${x.cctv.note ? ` · ${esc(x.cctv.note)}` : ""}</p>` : ""}
        <p class="muted">${x.applied ? `${esc(LOC[x.loc] || x.loc)} adjusted by ${esc(signed(x.applied))} ${esc(unitPlural(unit))} (logged in Activity).`
          : kit ? "The kit wasn't changed from here." : "Stock wasn't changed."}</p></div>`;
    } else if (x.status === "review" && canManage) {
      const opts = Object.entries(INV_OUTCOMES).filter(([, oc]) => !oc.system && (!oc.sign || Math.sign(diff) === oc.sign));
      step3 = `<form class="lh-form ivx-review" data-role="review" novalidate>
        <div data-role="cctv"></div>
        ${kit ? `<p class="inv-hint">Closing records what happened. ${esc(who)}'s kit isn't changed from here. If its numbers need fixing,
          accept the difference in <a href="#/reports/variance">Reporting → Count differences</a>.</p>` : ""}
        <div class="lh-field"><span class="lh-label">What happened?</span><div class="ivx-outcomes">${opts.map(([k, oc]) => `
          <label class="ivx-outcome"><input type="radio" name="outcome" value="${k}" />
            <span><strong>${esc(oc.label)}</strong><small>${esc(oc.help)}${!kit && oc.adjust && diff
              ? ` Changes ${esc(LOC[x.loc] || x.loc)} by ${esc(signed(diff))}.` : ""}</small></span></label>`).join("")}</div></div>
        <label class="fe-check"><input type="checkbox" name="cctv" /> CCTV checked</label>
        <label class="lh-field"><span class="lh-label">CCTV notes (optional)</span>
          <input name="cctvNote" maxlength="500" placeholder="e.g. 14 Oct 6:10pm, kit left in treatment room 2" /></label>
        <label class="lh-field"><span class="lh-label">What you found</span><textarea name="note" rows="3" maxlength="500"></textarea></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions"><button type="submit" class="lh-btn is-primary">Close investigation</button></div>
      </form>`;
    } else if (x.status === "review") {
      step3 = '<p class="muted">Waiting for an admin to check the records and CCTV.</p>';
    } else {
      step3 = '<p class="muted">Only needed if the recount confirms the difference.</p>';
    }

    const events = (x.events || []).slice().reverse().map((e) => `<li>
      <span class="inv-m-when">${esc(when(new Date(e.at)))}</span>
      <span class="inv-m-main"><strong>${esc(e.action)}</strong>${!blind && e.note ? `<small>${esc(e.note)}</small>` : ""}</span>
      <span class="inv-m-by">${esc(e.by || "")}</span></li>`).join("");

    const sub = kit
      ? `${esc(whereText(x))} · overnight difference found at Start of Day on ${esc(niceKey(x.dateKey) || day(x.openedAt))}`
      : `${esc(whereText(x))} · opening count on ${esc(day(x.openedAt))} by ${esc(x.openedBy || "—")}${x.countNote ? ` · “${esc(x.countNote)}”` : ""}`;

    root.innerHTML = `<div class="ivx-wrap">
      <a class="back-link" href="${back}">← Investigations</a>
      <div class="fb-head"><div><h2>${esc(x.productName)}</h2><p class="muted">${sub}</p></div>${pill(x)}</div>
      ${numbers}
      <section class="tb-card"><h4><span class="tb-num">1</span> ${kit
        ? "Overnight check <small>from the last End of Day to this morning's count</small>"
        : "Record check <small>since the last count that matched</small>"}</h4>
        <div data-role="ev">${blind ? '<p class="muted">Shown after the recount, so the recount stays blind.</p>'
          : '<div class="skeleton" style="height:120px;border-radius:10px"></div>'}</div></section>
      <section class="tb-card"><h4><span class="tb-num">2</span> Recount <small>${kit ? "not needed for kits" : "by someone else, without seeing the numbers"}</small></h4>${step2}</section>
      <section class="tb-card"><h4><span class="tb-num">3</span> Admin review <small>records, CCTV and what happened</small></h4>${step3}</section>
      ${events ? `<section class="tb-card"><h4>History</h4><ul class="inv-moves">${events}</ul></section>` : ""}
    </div>`;
    drawEvidence();
  }

  // Step 1 and the CCTV window fill in as soon as the records have been checked
  function drawEvidence() {
    const box = root.querySelector('[data-role="ev"]');
    const cctv = root.querySelector('[data-role="cctv"]');
    if (box && !blindNow()) {
      if (evErr) box.innerHTML = `<p class="tb-none tb-bad">${esc(evErr)}</p>`;
      else if (ev) box.innerHTML = isOvernight(x) ? overnightHtml(ev) : evidenceHtml(ev);
    }
    if (cctv) {
      cctv.innerHTML = ev
        ? `<div class="ivx-cctv"><strong>CCTV to check:</strong> ${esc(when(ev.since))} to ${esc(when(ev.countAt))}${
            ev.people.length ? `<br><strong>${isOvernight(x) ? "People involved" : "People who moved it"} in that time:</strong> ${esc(ev.people.join(", "))}` : ""}</div>`
        : evErr ? "" : '<div class="skeleton" style="height:48px;border-radius:10px"></div>';
    }
  }

  // Overnight kit difference: End of Day count → each thing recorded since → this morning's count
  function overnightHtml(e) {
    const u = x.unit || "units";
    const o = x.overnight || {};
    const who = x.staffName || x.openedBy || "The injector";
    const diff = r1(x.variance);
    const label = (v) => KIT_FLOW_LABELS[v.type] || MOVE_TYPES[v.type] || v.type;
    const loanFlag = (v) => (v.status === "disputed" ? ' <span class="inv-flag is-bad">Disputed</span>'
      : v.status === "unconfirmed" ? ' <span class="inv-flag is-warn">Not confirmed</span>' : "");
    const endLots = ((e.endItem && (e.endItem.rows || e.endItem.lots)) || [])
      .map((l) => `${l.batch || "No batch"}: ${l.sealed} unopened, ${r1(l.open)} left`).join(" · ");
    const startLots = !e.correctedAt ? ((e.startItem && e.startItem.rows) || [])
      .map((r) => `${r.batch || "No batch"}: ${r.sealed} unopened, ${r1(r.open)} left`).join(" · ") : "";

    let bal = r1(o.endCounted);
    const rows = [
      `<tr class="ivx-ov-edge"><td>${esc(when(e.since))}</td><td><strong>End of Day count</strong></td><td></td>
        <td><strong>${esc(bal)}</strong></td><td>${esc(who)}</td><td>${esc(endLots)}</td></tr>`,
      ...e.events.map((v) => {
        bal = r1(bal + v.units);
        return `<tr><td>${esc(when(v.at))}</td><td>${esc(label(v))}${loanFlag(v)}</td>
          <td class="${v.units < 0 ? "rp-neg" : "rp-pos"}">${esc(signed(v.units))}</td><td>${esc(bal)}</td>
          <td>${esc(v.by)}</td><td>${esc(v.note)}</td></tr>`;
      }),
      `<tr class="ivx-ov-edge"><td>${esc(when(e.countAt))}</td><td><strong>Counted at Start of Day</strong></td>
        <td class="${diff < 0 ? "rp-neg" : "rp-pos"}"><strong>${esc(signed(diff))}</strong></td>
        <td><strong>${esc(r1(x.counted))}</strong></td><td>${esc(who)}</td><td>${esc(startLots)}</td></tr>`,
    ].join("");

    const moved = r1(o.moved);
    const summary = `<p class="ivx-sum">${esc(who)} counted <strong>${esc(r1(o.endCounted))} ${esc(u)}</strong> at End of Day${
        o.fromDateKey ? ` on ${esc(niceKey(o.fromDateKey))}` : ""}${e.exactSince ? ` (${esc(time(e.since))})` : ""}.
      ${Math.abs(moved) >= 0.05 ? `The records since then come to <strong>${esc(signed(moved))} ${esc(u)}</strong>` : "Nothing was recorded since then"},
      so the kit should have held <strong>${esc(r1(o.expected))} ${esc(u)}</strong>.
      At Start of Day ${esc(who)} counted <strong>${esc(r1(x.counted))}</strong>: ${diff < 0
        ? `<strong class="rp-neg">${esc(-diff)} ${esc(u)} fewer than expected</strong>`
        : `<strong class="rp-pos">${esc(diff)} ${esc(u)} more than expected</strong>`}.</p>`;

    const flags = [];
    if (Math.abs(r1(e.total) - moved) >= 0.05) {
      flags.push(`<li><strong>The records have changed since the count</strong> · they now come to ${esc(signed(r1(e.total)))} ${esc(u)},
        but the morning check used ${esc(signed(moved))}. Something was saved, corrected or removed afterwards.</li>`);
    }
    e.events.filter((v) => v.type === "kit-use" && o.fromDateKey && v.at && dayKey(v.at) === o.fromDateKey).forEach((v) => {
      flags.push(`<li><strong>Treatment saved after End of Day</strong> · ${esc(v.note)} · saved ${esc(time(v.at))}.
        If it was done before the End of Day count, those ${esc(-v.units)} ${esc(u)} have been taken off twice.</li>`);
    });
    e.events.filter((v) => (v.type === "kit-in" || v.type === "kit-out") && v.status !== "confirmed").forEach((v) => {
      flags.push(`<li><strong>${v.status === "disputed" ? "Disputed" : "Unconfirmed"} borrow</strong> · ${esc(label(v))} · ${
        esc(signed(v.units))} ${esc(u)} · ${esc(v.note)} · ${esc(when(v.at))}</li>`);
    });
    if (e.correctedAt && e.startItem && Math.abs(r1(e.startItem.counted) - r1(x.counted)) >= 0.05) {
      flags.push(`<li><strong>Start of Day was corrected</strong> at ${esc(time(e.correctedAt))} · the latest count is ${
        esc(r1(e.startItem.counted))} ${esc(u)} (this check used ${esc(r1(x.counted))}).</li>`);
    }
    const unknown = (e.startItem && e.startItem.unknown) || [];
    if (unknown.length) {
      flags.push(`<li><strong>${unknown.length} batch${unknown.length === 1 ? "" : "es"} typed at Start of Day ${unknown.length === 1 ? "isn't" : "aren't"} in the kit records</strong> · ${
        esc(unknown.map((b) => `${b.batch || "No batch"} (${r1(b.units)} ${u})`).join(", "))}. Often a typo in the batch number.</li>`);
    }
    const expMis = ((e.startItem && e.startItem.rows) || []).filter((r) => r.expiryMismatch);
    if (expMis.length) {
      flags.push(`<li><strong>Expiry typed differently to the kit records</strong> · ${esc(expMis.map((r) => r.batch).join(", "))}</li>`);
    }

    return `${summary}
      ${!e.exactSince ? `<p class="muted ivx-note">The exact End of Day time couldn't be read, so this shows everything from the start of ${esc(niceKey(o.fromDateKey) || "that day")}.</p>` : ""}
      <div class="rp-scroll"><table class="inv-table"><thead><tr><th>When</th><th>What</th><th>Change</th><th>Should have</th><th>By</th><th>Details</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      ${flags.length ? `<div class="ivx-flags"><strong>Could explain it</strong><ul>${flags.join("")}</ul></div>`
        : '<p class="ivx-none">Nothing in the records explains the difference.</p>'}`;
  }

  function evidenceHtml(e) {
    const unit = x.unit || "item";
    let bal = e.digitalAtSince;
    const rows = e.ledger.map((m) => {
      bal += m.delta;
      return `<tr><td>${esc(when(m.at))}</td><td>${esc(MOVE_TYPES[m.type] || m.type)}</td>
        <td class="${m.delta < 0 ? "rp-neg" : "rp-pos"}">${esc(signed(m.delta))}</td><td>${bal}</td>
        <td>${esc(m.by)}</td><td>${esc(m.note)}</td></tr>`;
    }).join("");
    const flags = [
      ...((e.booked && e.booked.items) || []).map((b) => `<li><strong>Booked, nothing recorded</strong> · ${esc(b.patientName || "Patient")} · ${
        esc(b.services.join(", "))} · ${esc(b.staff || "")} · ${esc(niceKey(b.dateKey))}${b.time ? ` ${esc(b.time)}` : ""}:
        no treatment record uses this product.</li>`),
      ...e.short.map((u) => `<li><strong>Saved short</strong> · ${esc(u.patientName || "")} · ${esc(u.formName || "")} · ${esc(u.by || "")} · ${
        esc(day(u.at))}${u.resolved ? " (resolved)" : ""}: stock was used that the system didn't have.</li>`),
      ...e.pos.map((po) => `<li><strong>Delivery not fully put away</strong> · <a href="#/inventory/po/${encodeURIComponent(po.id)}">${esc(po.number)}</a> · ${
        esc(PO_STATUS[po.status] || po.status)}</li>`),
      ...e.rels.map((r) => `<li><strong>JT storage release waiting</strong> · ${esc(plural(r.qty, r.unit))} for ${esc(r.requestedBy || "")}</li>`),
    ];
    return `<p class="muted">${e.sinceCount ? `Last count that matched: <strong>${esc(day(e.since))}</strong>`
        : "No matching count in the last 120 days, so this covers the 30 days before the count"}. Digital was <strong>${esc(plural(e.digitalAtSince, unit))}</strong> then.</p>
      ${rows ? `<div class="rp-scroll"><table class="inv-table"><thead><tr><th>When</th><th>What</th><th>Change</th><th>Digital after</th><th>By</th><th>Details</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="tb-none">No stock movements in that time.</p>'}
      ${flags.length ? `<div class="ivx-flags"><strong>Could explain it</strong><ul>${flags.join("")}</ul></div>`
        : '<p class="ivx-none">Nothing in the records explains the difference.</p>'}
      ${e.booked && !e.booked.configured ? '<p class="muted ivx-note">Bookings aren\'t checked yet. Link services to products in Inventory → Service links.</p>' : ""}
      ${e.booked && e.booked.failed ? '<p class="muted ivx-note">Bookings couldn\'t be checked this time. Reload to try again.</p>' : ""}`;
  }

  root.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-act]");
    if (!a || busy) return;
    if (a.dataset.act === "show") { showNums = true; draw(); return; }
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
      if (v === "" || !(Number(v) >= 0)) { fail("Enter how many you counted (0 if there are none)."); return; }
      busy = true;
      btn.disabled = true;
      err.hidden = true;
      try {
        const r = await saveRecount(x.id, v, staff);
        showToast(r.matched ? "The recount matched digital, so the first count was wrong. Closed." : "Recount saved. The difference is confirmed, so an admin will review it.");
        await load();
      } catch (ex) {
        console.error("Recount failed:", ex);
        fail(errText(ex, "Couldn't save. Try again."));
        btn.disabled = false;
      } finally { busy = false; }
    } else if (form.dataset.role === "review") {
      const f = form.elements;
      const outcome = (form.querySelector('[name="outcome"]:checked') || {}).value;
      if (!outcome) { fail("Choose what happened."); return; }
      if (!f.note.value.trim()) { fail("Add a note saying what you found."); return; }
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