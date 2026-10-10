// Task Manager → Opening count (#/tasks/count) and My kit check (#/tasks/count/kit).
// Blind count: the system's numbers only appear after saving. Nothing here changes stock;
// differences go to Reporting → Variance for review.
// The opening count covers the Shelf, JT storage and every injector's kit (for products due today).
import {
  INV_CATEGORIES, unitPlural, fefo, batchName, batchText, isKitProduct,
  listProducts, listAllLots, listKits, countDue, countLocs, dayKey, listCountsOn, saveCount, myUid,
} from "./inventory-api.js";
import { can, isInjector } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  check: ic('<polyline points="20 6 9 17 4 12"/>'),
};
const fmt = (n) => String(+Number(n || 0).toFixed(1));
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const LOC = { shelf: "Shelf", jt: "JT storage" };
const whereOf = (l) => (l.loc === "kit" ? `${l.staffName || "Injector"}'s kit` : LOC[l.loc] || l.loc);
const diffText = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));

export async function mountStockCount(container, { param = "", staff = null } = {}) {
  const backHref = "#/tasks/new";
  const canCount = can("inventory.count") || can("inventory.order") || can("inventory.manage");
  const canKit = isInjector();
  const mode = param === "kit" && canKit ? "kit" : canCount ? "opening" : canKit ? "kit" : "";
  const root = document.createElement("section");
  root.className = "page wide";
  root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="skeleton" style="height:420px;border-radius:14px"></div>`;
  container.replaceChildren(root);
  if (!mode) {
    root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="state"><strong>No access</strong>Ask an Admin to give you counting access in Staff.</div>`;
    return;
  }

  let products, lots, todays, allKits;
  try {
    [products, lots, todays, allKits] = await Promise.all([
      listProducts(), listAllLots(), listCountsOn(dayKey()), listKits().catch(() => []),
    ]);
  } catch (err) {
    console.error("Count load failed:", err);
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="state"><strong>Couldn't open the count</strong>${
      err && err.code === "permission-denied" ? "Check the Firestore rules for inv_counts have been published." : "Check your connection and try again."}</div>`;
    return;
  }
  if (!root.isConnected) return;

  const me = myUid();
  const byId = new Map(products.map((p) => [p.id, p]));
  const dueKitIds = new Set(products.filter((p) => isKitProduct(p) && countDue(p)).map((p) => p.id));

  // Already counted today (by anyone): Shelf/JT per product, kits per lot
  const done = new Map();
  todays.forEach((c) => c.lines.forEach((l) => {
    const key = l.loc === "kit" ? `kit|${l.ref}` : c.kind === "opening" ? `${l.productId}|${l.loc}` : "";
    if (key) done.set(key, { by: c.by, at: c.at, name: l.productName, where: whereOf(l) });
  }));

  const today = new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
  const title = mode === "kit" ? "My kit check" : "Opening count";
  const switcher = canCount && canKit
    ? `<div class="fe-seg sc-mode"><a class="fe-seg-btn${mode === "opening" ? " is-on" : ""}" href="#/tasks/count"><span>Opening count</span></a>
        <a class="fe-seg-btn${mode === "kit" ? " is-on" : ""}" href="#/tasks/count/kit"><span>My kit</span></a></div>` : "";

  root.innerHTML = `
    <div class="ff-wrap tb-wrap">
      <div class="ff-bar" role="region" aria-label="${esc(title)}">
        <div class="ff-bar-inner">
          <a class="ff-back" href="${backHref}" aria-label="Back" title="Back">${I.back}</a>
          <div class="ff-bar-title"><strong>${esc(title)}</strong><span>${esc(today)} · count what's physically there</span></div>
          <span class="ff-progress" data-role="progress"></span>
          <div class="ff-bar-actions">
            <a class="ff-btn is-quiet" href="${backHref}">Cancel</a>
            <button type="button" class="ff-btn is-primary" data-act="save">${I.check}<span>Save count</span></button>
          </div>
        </div>
        <p class="ff-msg" data-role="msg" aria-live="polite"></p>
      </div>
      ${switcher}
      <div data-role="body"></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const body = $('[data-role="body"]');
  const msgEl = $('[data-role="msg"]');
  const saveBtn = $('[data-act="save"]');
  let busy = false;

  // Kit lots: unopened + units left in the opened one
  const kitFilled = (r) => r.sealed !== "" && r.open !== "";
  const kitRowHtml = (r, i) => {
    const p = byId.get(r.k.productId);
    return `<div class="sc-item${kitFilled(r) ? " is-done" : ""}" data-ki="${i}">
      <div class="sc-head"><strong>${esc(r.k.productName)}</strong>
        <small>${esc(batchText(p, r.k.batch) || "No number")} · Exp ${esc(niceDate(r.k.expiry))}</small>
        ${r.due ? '<span class="inv-flag is-info">Due today</span>' : ""}</div>
      <div class="sc-row sc-kitrow">
        <label><small>Unopened</small><div class="fe-num"><input class="fe-in" type="number" min="0" step="1" inputmode="numeric" data-k="sealed"
          value="${esc(r.sealed)}" placeholder="?" /><span>${esc(unitPlural((p && p.stockUnit) || "vial"))}</span></div></label>
        <label><small>Left in the opened one</small><div class="fe-num"><input class="fe-in" type="number" min="0" step="0.5" inputmode="decimal" data-k="open"
          value="${esc(r.open)}" placeholder="?" /><span>${esc(r.k.doseUnit)}</span></div></label>
      </div></div>`;
  };

  /* ===================== Opening count: Shelf, JT storage and injectors' kits ===================== */
  if (mode === "opening") {
    const lotsAt = (pid, loc) => lots.filter((l) => l.productId === pid && l.loc === loc && l.qty > 0).sort(fefo);
    const makeBlock = (p, loc, extra = false) => ({
      key: `${p.id}|${loc}`, p, loc, extra,
      rows: p.tracked
        ? lotsAt(p.id, loc).map((l) => ({ batch: l.batch, expiry: l.expiry, counted: "", found: false }))
        : [{ batch: "", expiry: "", counted: "", found: false }],
    });
    const blocks = [];
    products.filter((p) => countDue(p)).forEach((p) => countLocs(p).forEach((loc) => {
      if (!done.has(`${p.id}|${loc}`)) blocks.push(makeBlock(p, loc));
    }));
    const kitRows = allKits.filter((k) => dueKitIds.has(k.productId) && !done.has(`kit|${k.id}`))
      .sort((a, b) => a.staffName.localeCompare(b.staffName) || a.productName.localeCompare(b.productName) || (a.expiry || "").localeCompare(b.expiry || ""))
      .map((k) => ({ k, due: false, sealed: "", open: "" }));

    const filled = (b) => b.rows.length > 0 && b.rows.every((r) => r.counted !== "");
    const started = (b) => b.rows.some((r) => r.counted !== "");

    function rowHtml(b, r, j) {
      const label = batchName(b.p);
      const lot = !b.p.tracked ? `<span class="sc-lot">${esc(LOC[b.loc])}</span>`
        : r.found
          ? `<span class="sc-found"><input class="fe-in" data-f="batch" maxlength="40" autocapitalize="characters" placeholder="${esc(label)} #" value="${esc(r.batch)}" />
              <input class="fe-in" type="date" data-f="expiry" value="${esc(r.expiry)}" aria-label="Expiry" /></span>`
          : `<span class="sc-lot">${esc(batchText(b.p, r.batch) || "No number")} · Exp ${esc(niceDate(r.expiry))}</span>`;
      return `<div class="sc-row" data-j="${j}">${lot}
        <div class="fe-num"><input class="fe-in" type="number" min="0" step="1" inputmode="numeric" data-f="counted"
          value="${esc(r.counted)}" placeholder="?" aria-label="Counted" /><span>${esc(unitPlural(b.p.stockUnit))}</span></div>
        ${r.found ? '<button type="button" class="hx-x" data-act="rm" aria-label="Remove">×</button>' : "<span></span>"}</div>`;
    }
    function blockHtml(b, i) {
      const bn = batchName(b.p).toLowerCase();
      return `<div class="sc-item${filled(b) ? " is-done" : ""}" data-i="${i}">
        <div class="sc-head"><strong>${esc(b.p.name)}</strong>
          <small>Count ${esc(unitPlural(b.p.stockUnit))}${b.p.dosePer ? ` (each ${fmt(b.p.dosePer)} ${esc(b.p.doseUnit)})` : ""}</small>
          ${b.extra ? '<button type="button" class="hx-x" data-act="rm-block" aria-label="Remove">×</button>' : ""}</div>
        ${b.rows.map((r, j) => rowHtml(b, r, j)).join("") || `<p class="tb-none">No ${esc(bn)}s on record here. Use “+ Another ${esc(bn)} found”.</p>`}
        ${b.p.tracked ? `<button type="button" class="cs-link" data-act="found">+ Another ${esc(bn)} found</button>` : ""}
      </div>`;
    }
    function progress() {
      const total = blocks.length + kitRows.length;
      const n = blocks.filter(filled).length + kitRows.filter(kitFilled).length;
      $('[data-role="progress"]').textContent = total ? `${n} of ${total} counted` : "";
    }
    function draw() {
      const section = (loc) => {
        const list = blocks.map((b, i) => [b, i]).filter(([b]) => b.loc === loc);
        if (!list.length) return "";
        return `<section class="tb-card"><h4>${esc(LOC[loc])}</h4>${INV_CATEGORIES.map((c) => {
          const items = list.filter(([b]) => b.p.category === c.key);
          return items.length ? `<div class="sc-cat">${esc(c.label)}</div>${items.map(([b, i]) => blockHtml(b, i)).join("")}` : "";
        }).join("")}</section>`;
      };
      const people = [...new Set(kitRows.map((r) => r.k.staffName))];
      const kitSection = kitRows.length ? `<section class="tb-card"><h4>Injectors' kits</h4>
        <p class="muted">For each injector: count the unopened ones, and check how much is left in the opened one.</p>
        ${people.map((name) => `<div class="sc-cat">${esc(name)}</div>${kitRows.map((r, i) => [r, i])
          .filter(([r]) => r.k.staffName === name).map(([r, i]) => kitRowHtml(r, i)).join("")}`).join("")}</section>` : "";
      const listed = new Set(blocks.map((b) => b.key));
      const addable = products.filter((p) => p.active && (!listed.has(`${p.id}|shelf`) || !listed.has(`${p.id}|jt`)));
      const doneHtml = done.size ? `<section class="tb-card"><h4>Done today</h4><ul class="sc-done">${[...done.values()].map((v) =>
        `<li>${I.check}<span>${esc(v.name)} · ${esc(v.where)}</span><small>${esc(v.by)} · ${esc(timeOf(v.at))}</small></li>`).join("")}</ul></section>` : "";
      body.innerHTML = `
        ${blocks.length || kitRows.length ? section("shelf") + section("jt") + kitSection
          : `<div class="tm-empty">${done.size ? "Everything due today has been counted. 👍" : "Nothing is due for counting today."}</div>`}
        <section class="tb-card"><h4>Add another product</h4>
          <div class="sc-add"><select class="fb-select" data-role="addp"><option value="">Choose a product…</option>${INV_CATEGORIES.map((c) => {
            const items = addable.filter((p) => p.category === c.key);
            return items.length ? `<optgroup label="${esc(c.label)}">${items.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</optgroup>` : "";
          }).join("")}</select>
          <select class="fb-select" data-role="addloc"><option value="shelf">Shelf</option><option value="jt">JT storage</option></select>
          <button type="button" class="lh-btn" data-act="add">Add</button></div></section>
        ${doneHtml}`;
      progress();
    }

    body.addEventListener("input", (e) => {
      const kitEl = e.target.closest("[data-ki]");
      if (kitEl && e.target.dataset.k) {
        const r = kitRows[Number(kitEl.dataset.ki)];
        r[e.target.dataset.k] = e.target.value;
        kitEl.classList.toggle("is-done", kitFilled(r));
        msgEl.textContent = "";
        progress();
        return;
      }
      const f = e.target.dataset.f;
      const item = e.target.closest(".sc-item[data-i]");
      if (!f || !item) return;
      const b = blocks[Number(item.dataset.i)];
      const r = b.rows[Number(e.target.closest(".sc-row").dataset.j)];
      r[f] = f === "counted" ? (e.target.value === "" ? "" : String(Math.max(0, parseInt(e.target.value, 10) || 0))) : e.target.value;
      item.classList.toggle("is-done", filled(b));
      msgEl.textContent = "";
      progress();
    });
    body.addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]");
      if (!a) return;
      const item = a.closest(".sc-item[data-i]");
      const b = item ? blocks[Number(item.dataset.i)] : null;
      if (a.dataset.act === "found" && b) { b.rows.push({ batch: "", expiry: "", counted: "", found: true }); draw(); }
      else if (a.dataset.act === "rm" && b) { b.rows.splice(Number(a.closest(".sc-row").dataset.j), 1); draw(); }
      else if (a.dataset.act === "rm-block" && b) { blocks.splice(blocks.indexOf(b), 1); draw(); }
      else if (a.dataset.act === "add") {
        const p = byId.get($('[data-role="addp"]').value);
        const loc = $('[data-role="addloc"]').value;
        if (!p) { showToast("Choose a product."); return; }
        if (blocks.some((x) => x.key === `${p.id}|${loc}`)) { showToast("That's already on the list."); return; }
        blocks.push(makeBlock(p, loc, true));
        draw();
      }
    });

    saveBtn.addEventListener("click", async () => {
      if (busy) return;
      const partial = blocks.find((b) => started(b) && !filled(b));
      if (partial) { msgEl.textContent = `${partial.p.name} (${LOC[partial.loc]}): fill in every box, or leave them all empty to count it later.`; return; }
      const partialKit = kitRows.find((r) => (r.sealed !== "" || r.open !== "") && !kitFilled(r));
      if (partialKit) { msgEl.textContent = `${partialKit.k.staffName}'s ${partialKit.k.productName}: fill in both boxes (enter 0 if there's none).`; return; }
      const ready = blocks.filter(filled);
      const readyKits = kitRows.filter(kitFilled);
      if (!ready.length && !readyKits.length) { msgEl.textContent = "Count at least one item first."; return; }
      for (const b of ready) {
        for (const r of b.rows.filter((x) => x.found)) {
          if (!r.batch.trim()) { msgEl.textContent = `${b.p.name}: enter the ${batchName(b.p).toLowerCase()} number you found.`; return; }
          if (!r.expiry) { msgEl.textContent = `${b.p.name}: enter a real expiry date for the ${batchName(b.p).toLowerCase()} you found (check the day).`; return; }
        }
      }
      busy = true;
      saveBtn.disabled = true;
      saveBtn.querySelector("span").textContent = "Saving…";
      try {
        const res = await saveCount({
          kind: "opening",
          lines: [
            ...ready.flatMap((b) => b.rows.map((r) => ({ productId: b.p.id, loc: b.loc, batch: r.batch, expiry: r.expiry, counted: r.counted }))),
            ...readyKits.map((r) => ({ kit: true, ref: r.k.id, sealed: r.sealed, open: r.open })),
          ],
        }, staff);
        showResults(res);
      } catch (err) {
        console.error("Save count failed:", err);
        msgEl.textContent = err && err.code === "permission-denied"
          ? "You don't have access to save counts. Ask an Admin to check your access in Staff."
          : err && err.message && !err.code ? err.message : "Couldn't save. Try again.";
      } finally {
        busy = false;
        saveBtn.disabled = false;
        saveBtn.querySelector("span").textContent = "Save count";
      }
    });
    draw();
  }

  /* ===================== My kit check (the injector, any time) ===================== */
  if (mode === "kit") {
    const rows = allKits.filter((k) => k.staffUid === me && !done.has(`kit|${k.id}`))
      .map((k) => ({ k, due: dueKitIds.has(k.productId), sealed: "", open: "" }))
      .sort((a, b) => Number(b.due) - Number(a.due) || a.k.productName.localeCompare(b.k.productName));
    const checkedToday = allKits.some((k) => k.staffUid === me && done.has(`kit|${k.id}`));

    function draw() {
      body.innerHTML = rows.length ? `<section class="tb-card"><h4>What's in your kit</h4>
          <p class="muted">Count the unopened ones and check how much is left in each opened one.</p>
          ${rows.map((r, i) => kitRowHtml(r, i)).join("")}</section>`
        : `<div class="tm-empty">${checkedToday ? "Your kit has been checked today. 👍" : "There's nothing in your kit to check."}</div>`;
      $('[data-role="progress"]').textContent = rows.length ? `${rows.filter(kitFilled).length} of ${rows.length} checked` : "";
    }
    body.addEventListener("input", (e) => {
      const el = e.target.closest("[data-ki]");
      if (!el || !e.target.dataset.k) return;
      const r = rows[Number(el.dataset.ki)];
      r[e.target.dataset.k] = e.target.value;
      el.classList.toggle("is-done", kitFilled(r));
      $('[data-role="progress"]').textContent = `${rows.filter(kitFilled).length} of ${rows.length} checked`;
      msgEl.textContent = "";
    });
    saveBtn.addEventListener("click", async () => {
      if (busy) return;
      if (rows.some((r) => (r.sealed !== "" || r.open !== "") && !kitFilled(r))) {
        msgEl.textContent = "Fill in both boxes for each item you check (enter 0 if there's none).";
        return;
      }
      const ready = rows.filter(kitFilled);
      if (!ready.length) { msgEl.textContent = "Check at least one item first."; return; }
      busy = true;
      saveBtn.disabled = true;
      try {
        const res = await saveCount({ kind: "kit", lines: ready.map((r) => ({ ref: r.k.id, sealed: r.sealed, open: r.open })) }, staff);
        showResults(res);
      } catch (err) {
        console.error("Save kit check failed:", err);
        msgEl.textContent = err && err.message && !err.code ? err.message : "Couldn't save. Try again.";
      } finally {
        busy = false;
        saveBtn.disabled = false;
      }
    });
    draw();
  }

  /* ===================== After saving: reveal the system's numbers ===================== */
  function showResults(res) {
    const diffs = res.lines.filter((l) => l.status === "open");
    const qty = (l, n) => `${fmt(n)}${l.loc === "kit" ? ` ${l.unit}` : ""}`;
    $('[data-role="progress"]').textContent = "";
    saveBtn.hidden = true;
    body.innerHTML = `<section class="tb-card sc-results">
      <h4>${I.check} Count saved</h4>
      <p>${res.lines.length} line${res.lines.length === 1 ? "" : "s"} counted.${diffs.length
        ? ` <strong>${diffs.length} difference${diffs.length === 1 ? "" : "s"}</strong> sent to Reporting for review. Stock hasn't been changed.`
        : " Everything matched. 👍"}</p>
      <table class="inv-table"><thead><tr><th>Product</th><th>Where</th><th>Batch / Lot</th><th>Counted</th><th>System</th><th>Difference</th></tr></thead><tbody>${
        res.lines.map((l) => `<tr class="${l.status === "open" ? "is-diff" : ""}">
          <td>${esc(l.productName)}</td><td>${esc(whereOf(l))}</td>
          <td>${esc(l.batch ? `${l.batchLabel || batchName(byId.get(l.productId))} ${l.batch}` : "—")}</td>
          <td>${esc(qty(l, l.counted))}</td><td>${esc(qty(l, l.system))}</td>
          <td>${l.status === "open" ? `<strong>${esc(diffText(l.variance))}</strong>` : "✓"}</td></tr>`).join("")}</tbody></table>
      <div class="sc-after"><a class="ff-btn" href="${backHref}">Back to tasks</a>
        <button type="button" class="ff-btn is-primary" data-act="again">Count more</button></div>
    </section>`;
    body.querySelector('[data-act="again"]').addEventListener("click", () => mountStockCount(container, { param, staff }));
    showToast(diffs.length ? `Saved. ${diffs.length} difference${diffs.length === 1 ? "" : "s"} to review.` : "Saved. Everything matched.");
  }
}