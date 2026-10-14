// Task Manager → Opening count (#/tasks/count) and My kit check (#/tasks/count/kit).
// Blind count: the system's numbers only appear after saving. Nothing here changes stock;
// differences go to Reporting → Count differences, or open an investigation.
// Each line remembers when it was counted, so stock used while counting doesn't show as a difference.
// The opening count is one table: a row per product (a line per batch), with Shelf, JT storage and a comment.
// Walking order: products are listed in the order they sit (Arrange order), shared by the whole clinic.
// Save and finish later: progress is kept on this device as it's typed, and can be saved for anyone to carry on.
import {
  INV_CATEGORIES, unitPlural, batchName, batchText, isKitProduct, isSharedProduct, plural, catLabel,
  listProducts, listAllLots, listKits, countDue, countLocs, dayKey, listCountsOn, saveCount, myUid,
  listOpenContainers, finishContainer, getCountSettings, saveCountSettings, COUNT_DUE_DEFAULT,
  getCountOrder, saveCountOrder, getCountDraft, saveCountDraft, deleteCountDraft,
} from "./inventory-api.js";
import { can, isInjector } from "./perms.js";
import { showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  back: ic('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  check: ic('<polyline points="20 6 9 17 4 12"/>'),
  search: ic('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  pause: ic('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
};
const fmt = (n) => String(+Number(n || 0).toFixed(1));
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const shortDate = (d) => (d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "");
const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const clock = (t) => { const [h, m] = String(t || COUNT_DUE_DEFAULT).split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };
const LOC = { shelf: "Shelf", jt: "JT storage" };
const LOCS = ["shelf", "jt"];
const whereOf = (l) => (l.loc === "kit" ? `${l.staffName || "Injector"}'s kit` : LOC[l.loc] || l.loc);
const diffText = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const whole = (v) => (v === "" ? "" : String(Math.max(0, parseInt(v, 10) || 0)));
const filled = (v) => v !== undefined && v !== null && String(v) !== "";

export async function mountStockCount(container, { param = "", staff = null } = {}) {
  const backHref = "#/tasks/new";
  const canCount = can("inventory.count") || can("inventory.order") || can("inventory.manage");
  const canManage = can("inventory.manage");
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

  let products, lots, todays, allKits, openNow, countCfg, countOrder, serverDraft;
  try {
    [products, lots, todays, allKits, openNow, countCfg, countOrder, serverDraft] = await Promise.all([
      listProducts(), listAllLots(), listCountsOn(dayKey()), listKits().catch(() => []),
      listOpenContainers().catch(() => []), getCountSettings().catch(() => ({ dueBy: COUNT_DUE_DEFAULT })),
      mode === "opening" ? getCountOrder().catch(() => ({ shelf: [], jt: [] })) : null,
      mode === "opening" ? getCountDraft().catch(() => null) : null,
    ]);
  } catch (err) {
    console.error("Count load failed:", err);
    if (root.isConnected) root.innerHTML = `<a class="back-link" href="${backHref}">← Back</a><div class="state"><strong>Couldn't open the count</strong>${
      err && err.code === "permission-denied" ? "Check the Firestore rules for inv_counts have been published." : "Check your connection and try again."}</div>`;
    return;
  }
  if (!root.isConnected) return;
  let dueBy = countCfg.dueBy;

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
          <div class="ff-bar-title"><strong>${esc(title)}</strong><span>${esc(today)} · count what's physically there${mode === "opening"
            ? ` · <span data-role="dueby">due by ${esc(clock(dueBy))}</span>${canManage ? ' <button type="button" class="cs-link" data-act="dueby">Change</button>' : ""}` : ""}</span></div>
          <span class="ff-progress" data-role="progress"></span>
          <div class="ff-bar-actions">
            <a class="ff-btn is-quiet" href="${backHref}">Close</a>
            ${mode === "opening" ? `<button type="button" class="ff-btn" data-act="later">${I.pause}<span>Save and finish later</span></button>` : ""}
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
  const laterBtn = $('[data-act="later"]');
  let busy = false;

  // Enter moves to the next box in the same column (walk the Shelf, then JT storage)
  body.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key === "Enter" && t.dataset && t.dataset.arName !== undefined) { e.preventDefault(); t.blur(); return; }
    if (e.key !== "Enter" || !t.dataset || !t.dataset.col) return;
    e.preventDefault();
    const all = [...body.querySelectorAll(`input[data-col="${t.dataset.col}"]`)];
    const next = all[all.indexOf(t) + 1];
    if (next) { next.focus(); next.select(); } else t.blur();
  });

  // Manage inventory: when the opening count should be done by (for the dashboard, the card and the reminder email)
  root.addEventListener("click", (e) => {
    if (!e.target.closest('[data-act="dueby"]')) return;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Opening count due by</h3>
        <p>After this time the dashboard shows it as overdue, and the "Opening count not done" notification is sent (Inventory → Notifications).</p></div>
      <label class="lh-field"><span class="lh-label">Time</span><input type="time" name="t" value="${esc(dueBy)}" step="900" /></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button></div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const t = dlg.querySelector('[name="t"]').value;
      try {
        await saveCountSettings({ dueBy: t }, staff);
        dueBy = t;
        const el = $('[data-role="dueby"]');
        if (el) el.textContent = `due by ${clock(dueBy)}`;
        dlg.close();
        showToast("Saved");
      } catch (err) {
        const er = dlg.querySelector(".lh-error");
        er.textContent = err && err.code === "permission-denied" ? "Only Manage inventory can change this." : (err.message || "Couldn't save.");
        er.hidden = false;
      }
    });
    dlg.showModal();
  });

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

  /* ===================== Opening count: one place at a time ===================== */
  if (mode === "opening") {
    const newRow = (batch, expiry, found, both = false) => ({
      batch, expiry, found, at: { shelf: both, jt: both }, counted: { shelf: "", jt: "" }, countedAt: { shelf: 0, jt: 0 },
    });
    // One item per product: untracked = one line; tracked = a line per batch held on the Shelf or in JT storage
    function makeItem(p, locs, extra = false) {
      let rows;
      if (p.tracked) {
        const m = new Map();
        lots.filter((l) => l.productId === p.id && l.qty > 0 && LOCS.includes(l.loc)).forEach((l) => {
          const k = `${l.batch}|${l.expiry}`;
          const r = m.get(k) || newRow(l.batch, l.expiry, false);
          r.at[l.loc] = true;
          m.set(k, r);
        });
        rows = [...m.values()].sort((a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999"));
      } else {
        rows = [newRow("", "", false, true)];
      }
      return { p, locs, extra, rows, none: { shelf: "", jt: "" }, noneAt: { shelf: 0, jt: 0 }, note: "" };
    }

    const items = [];
    products.filter((p) => countDue(p)).forEach((p) => {
      const locs = countLocs(p).filter((loc) => !done.has(`${p.id}|${loc}`));
      if (locs.length) items.push(makeItem(p, locs));
    });
    const kitRows = allKits.filter((k) => dueKitIds.has(k.productId) && !done.has(`kit|${k.id}`))
      .sort((a, b) => a.staffName.localeCompare(b.staffName) || a.productName.localeCompare(b.productName) || (a.expiry || "").localeCompare(b.expiry || ""))
      .map((k) => ({ k, due: false, sealed: "", open: "" }));
    const openChecks = new Map();   // opened container id → "there" | "missing"

    // The clinic's walking order, per storage place
    const order = { shelf: countOrder.shelf || [], jt: countOrder.jt || [] };
    const hasOrder = (loc) => order[loc].some((e) => e.p);
    const st = {
      q: "", left: false, place: "", arrange: null, resumed: null,
      order: hasOrder("shelf") || hasOrder("jt") ? "walk" : products.some((p) => p.shelfPos || p.jtPos) ? "position" : "category",
    };

    // What has to be filled for a product + storage to count as done
    const needRows = (it, loc) => it.rows.filter((r) => !r.found && r.at[loc]);
    const noneAt = (it, loc) => it.p.tracked && !needRows(it, loc).length;   // tracked, nothing on record there
    const foundAt = (it, loc) => it.rows.filter((r) => r.found && r.counted[loc] !== "");
    const locFilled = (it, loc) => (noneAt(it, loc)
      ? it.none[loc] !== "" || foundAt(it, loc).length > 0
      : needRows(it, loc).every((r) => r.counted[loc] !== ""));
    const locStarted = (it, loc) => (noneAt(it, loc) && it.none[loc] !== "")
      || it.rows.some((r) => (r.found || r.at[loc]) && r.counted[loc] !== "");

    /* ---------- The places: Shelf → JT storage → Injectors' kits ---------- */
    const PLACES = [
      ["shelf", "Shelf", "Go to the Shelf and count each product. Type the number you see, then press Enter."],
      ["jt", "JT storage", "Go to JT storage and count each product. Type the number you see, then press Enter."],
      ["kits", "Injectors' kits", "For each injector's kit: count the unopened ones, and check how much is left in the opened one."],
    ];
    const placeTotal = (pl) => (pl === "kits" ? kitRows.length : items.filter((it) => it.locs.includes(pl)).length);
    const placeLeft = (pl) => (pl === "kits" ? kitRows.filter((r) => !kitFilled(r)).length
      : items.filter((it) => it.locs.includes(pl) && !locFilled(it, pl)).length);
    const places = () => PLACES.filter(([k]) => placeTotal(k) > 0);
    const placeName = (pl) => (PLACES.find(([k]) => k === pl) || ["", ""])[1];
    st.place = (places()[0] || ["shelf"])[0];

    /* ---------- Saved progress: on this device as it's typed, and "Save and finish later" for anyone ---------- */
    const LOCAL_KEY = `sc_draft_${me}_${dayKey()}`;
    const myName = String((staff && staff.name) || "");

    // Everything typed so far (only what's been touched, so it stays small)
    function snapshot() {
      return {
        place: st.place,
        items: items.filter((it) => it.extra || it.note || LOCS.some((l) => it.none[l] !== "")
          || it.rows.some((r) => r.found || LOCS.some((l) => r.counted[l] !== "")))
          .map((it) => ({
            pid: it.p.id, locs: [...it.locs], extra: !!it.extra, note: it.note,
            none: { ...it.none }, noneAt: { ...it.noneAt },
            rows: it.rows.filter((r) => r.found || LOCS.some((l) => r.counted[l] !== "")).map((r) => ({
              batch: r.batch, expiry: r.expiry, found: !!r.found, counted: { ...r.counted }, countedAt: { ...r.countedAt },
            })),
          })),
        kits: kitRows.filter((r) => r.sealed !== "" || r.open !== "").map((r) => ({ ref: r.k.id, sealed: r.sealed, open: r.open })),
        open: [...openChecks].map(([id, v]) => ({ id, v })),
      };
    }
    const draftCount = (d) => (d.items || []).reduce((a, x) => a
      + LOCS.filter((l) => x.none && filled(x.none[l])).length
      + (x.rows || []).reduce((b, r) => b + LOCS.filter((l) => r.counted && filled(r.counted[l])).length, 0), 0)
      + (d.kits || []).length;

    // Puts saved numbers back. Only fills what the saved copy has, so it can also combine two copies.
    function applyDraft(d) {
      (d.items || []).forEach((x) => {
        const p = byId.get(x.pid);
        if (!p) return;
        const locs = (Array.isArray(x.locs) ? x.locs : []).filter((l) => LOCS.includes(l) && !done.has(`${p.id}|${l}`));
        let it = items.find((i) => i.p.id === p.id);
        if (!it) {
          if (!locs.length) return;
          it = makeItem(p, locs, true);
          items.push(it);
        } else if (x.extra) {
          it.locs = LOCS.filter((l) => it.locs.includes(l) || locs.includes(l));
        }
        if (x.note) it.note = String(x.note);
        LOCS.forEach((l) => {
          if (x.none && filled(x.none[l])) { it.none[l] = whole(String(x.none[l])); it.noneAt[l] = Number((x.noneAt || {})[l]) || 0; }
        });
        (x.rows || []).forEach((r) => {
          const batch = String(r.batch || ""), expiry = String(r.expiry || "");
          let row = r.found
            ? it.rows.find((y) => y.found && y.batch === batch && y.expiry === expiry)
            : it.rows.find((y) => !y.found && y.batch === batch && y.expiry === expiry);
          if (!row) {   // a batch that has since run out on record: keep the line that was counted
            row = newRow(batch, expiry, !!r.found);
            if (!r.found) LOCS.forEach((l) => { row.at[l] = filled((r.counted || {})[l]); });
            it.rows.push(row);
          }
          LOCS.forEach((l) => {
            const v = (r.counted || {})[l];
            if (filled(v)) { row.counted[l] = whole(String(v)); row.countedAt[l] = Number((r.countedAt || {})[l]) || 0; }
          });
        });
      });
      (d.kits || []).forEach((k) => {
        const r = kitRows.find((x) => x.k.id === k.ref);
        if (!r) return;
        if (filled(k.sealed)) r.sealed = String(k.sealed);
        if (filled(k.open)) r.open = String(k.open);
      });
      (d.open || []).forEach((o) => { if (o && openNow.some((c) => c.id === o.id)) openChecks.set(o.id, o.v); });
      if (d.place) st.place = d.place;
    }

    // Older saved copies first, so the newest wins
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(`sc_draft_${me}_`) && k !== LOCAL_KEY).forEach((k) => localStorage.removeItem(k));
    } catch { /* storage unavailable */ }
    let localDraft = null;
    try { localDraft = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch { localDraft = null; }
    let loadedAt = Date.now();
    const drafts = [serverDraft, localDraft].filter((d) => d && Array.isArray(d.items)).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    drafts.forEach(applyDraft);
    const latest = drafts[drafts.length - 1];
    if (latest && draftCount(latest)) st.resumed = { by: latest.byUid === me ? "" : (latest.by || "Someone"), at: latest.savedAt || 0 };

    let saveTimer = 0;
    const autosave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...snapshot(), savedAt: Date.now(), by: myName, byUid: me })); }
        catch { /* full or unavailable: Save and finish later still works */ }
      }, 500);
    };
    const clearLocal = () => { clearTimeout(saveTimer); try { localStorage.removeItem(LOCAL_KEY); } catch { /* fine */ } };

    // Someone saved more counts after this page opened: theirs fill the gaps, what's typed here wins
    async function mergeNewer() {
      const cur = await getCountDraft().catch(() => null);
      if (!cur || !Array.isArray(cur.items) || (cur.savedAt || 0) <= loadedAt) return "";
      const mine = snapshot();
      applyDraft(cur);
      applyDraft(mine);
      loadedAt = Date.now();
      return cur.byUid === me ? "You (on another device)" : (cur.by || "Someone");
    }

    function placesHtml() {
      const ps = places();
      return `<div class="sc-places" role="tablist" aria-label="Where you're counting">${ps.map(([k, l], n) => {
        const left = placeLeft(k);
        return `<button type="button" class="sc-place${st.place === k ? " is-on" : ""}${left ? "" : " is-done"}" data-place="${k}"
            role="tab" aria-selected="${st.place === k}">
          <span class="sc-place-n">${left ? n + 1 : "✓"}</span>
          <span class="sc-place-t"><strong>${esc(l)}</strong><small>${left ? `${left} of ${placeTotal(k)} to count` : "All counted"}</small></span>
        </button>`;
      }).join("")}</div>`;
    }

    // Updates the step buttons and the "Next" bar without redrawing (so typing isn't interrupted)
    function updatePlaces() {
      const ps = places();
      ps.forEach(([k], n) => {
        const btn = body.querySelector(`.sc-place[data-place="${k}"]`);
        if (!btn) return;
        const left = placeLeft(k);
        btn.classList.toggle("is-done", !left);
        btn.querySelector(".sc-place-n").textContent = left ? String(n + 1) : "✓";
        btn.querySelector("small").textContent = left ? `${left} of ${placeTotal(k)} to count` : "All counted";
      });
      const nb = body.querySelector('[data-role="next"]');
      if (!nb) return;
      if (!ps.length || placeLeft(st.place)) { nb.hidden = true; return; }
      const next = ps.find(([k]) => k !== st.place && placeLeft(k));
      nb.hidden = false;
      nb.innerHTML = next
        ? `<span>✓ <strong>${esc(placeName(st.place))}</strong> is done.</span>
           <button type="button" class="ff-btn is-primary" data-place="${next[0]}">Next: ${esc(next[1])} →</button>`
        : "<span>✓ <strong>Everything is counted.</strong> Press <strong>Save count</strong> at the top.</span>";
    }

    function progress() {
      const total = items.reduce((a, it) => a + it.locs.length, 0) + kitRows.length;
      const n = items.reduce((a, it) => a + it.locs.filter((l) => locFilled(it, l)).length, 0) + kitRows.filter(kitFilled).length;
      $('[data-role="progress"]').textContent = total ? `${n} of ${total} counted` : "";
      updatePlaces();
    }

    /* ---------- The table for one place ---------- */
    const posOf = (p, loc) => String((loc === "jt" ? p.jtPos : p.shelfPos) || "").trim();
    const byPosP = (loc) => (a, b) => {
      const pa = posOf(a, loc), pb = posOf(b, loc);
      if (!pa !== !pb) return pa ? -1 : 1;
      return pa.localeCompare(pb, "en-AU", { numeric: true, sensitivity: "base" }) || a.name.localeCompare(b.name);
    };
    const byPos = (loc) => (a, b) => byPosP(loc)(a.p, b.p);
    const numIn = (attrs, v, loc, label) => `<input class="fe-in sc-in" type="number" min="0" step="1" inputmode="numeric" ${attrs}
      data-col="${loc}" value="${esc(v)}" placeholder="?" aria-label="${esc(label)}" />`;

    function prodCell(it, x, k, n, loc) {
      const p = it.p;
      const bn = batchName(p);
      const pos = posOf(p, loc);
      const head = k === 0 ? `<div class="sc-pname">${pos && st.order === "position" ? `<span class="sc-pos">${esc(pos)}</span>` : ""}<strong>${esc(p.name)}</strong>${
        it.extra ? '<button type="button" class="hx-x" data-act="rm-item" aria-label="Remove from this count">×</button>' : ""}</div>
        ${isSharedProduct(p) ? '<small>Only count the sealed ones, not the opened one</small>' : ""}` : "";
      let lot = "";
      if (p.tracked && x.r) {
        lot = x.r.found
          ? `<div class="sc-found"><input class="fe-in" data-r="${x.ri}" data-f="batch" maxlength="40" autocapitalize="characters"
                placeholder="${esc(bn)} number" value="${esc(x.r.batch)}" aria-label="${esc(bn)} number" />
              <input class="fe-in" type="date" data-r="${x.ri}" data-f="expiry" value="${esc(x.r.expiry)}" aria-label="Expiry" />
              <button type="button" class="hx-x" data-act="rm" data-r="${x.ri}" aria-label="Remove">×</button></div>`
          : `<div class="sc-lot">${esc(batchText(p, x.r.batch) || "No number")} · Exp ${esc(niceDate(x.r.expiry))}</div>`;
      }
      const add = p.tracked && k === n - 1 ? `<button type="button" class="cs-link" data-act="found">+ A ${esc(bn.toLowerCase())} that isn't listed</button>` : "";
      return `<td class="sc-prod">${head}${lot}${add}</td>`;
    }

    function itemHtml(it, i, loc) {
      const lines = it.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => r.found || r.at[loc]);
      if (noneAt(it, loc)) lines.unshift({ none: true });
      const n = lines.length;
      const unit = esc(unitPlural(it.p.stockUnit));
      return `<tbody class="sc-tb${locFilled(it, loc) ? " is-done" : ""}" data-it="${i}">${lines.map((x, k) => {
        const label = `${it.p.name}${x.r && x.r.batch ? `, ${batchName(it.p)} ${x.r.batch}` : ""}`;
        const count = x.none
          ? `<div class="sc-cell">${numIn(`data-none="${loc}"`, it.none[loc], loc, label)}<span>${unit}</span></div>
             <small class="sc-hint">None on record here. Type 0 if there are none.</small>`
          : `<div class="sc-cell">${numIn(`data-r="${x.ri}" data-loc="${loc}"`, x.r.counted[loc], loc, label)}<span>${unit}</span></div>`;
        return `<tr>${prodCell(it, x, k, n, loc)}<td class="sc-count">${count}</td>${k === 0
          ? `<td rowspan="${n}" class="sc-note-td"><input class="fe-in sc-note" data-note maxlength="300" placeholder="Optional"
              value="${esc(it.note)}" aria-label="Comment on ${esc(it.p.name)}" /></td>` : ""}</tr>`;
      }).join("")}</tbody>`;
    }

    const groupHead = (name, n, extra = "", cls = "") =>
      `<tbody class="sc-grp${cls}"><tr><th colspan="3">${esc(name)} <em>${n}</em>${extra}</th></tr></tbody>`;

    function drawTable() {
      const box = body.querySelector('[data-role="table"]');
      if (!box || st.place === "kits" || st.arrange) return;
      const loc = st.place;
      const q = st.q.trim().toLowerCase();
      const list = items.map((it, i) => [it, i]).filter(([it]) => it.locs.includes(loc)
        && (!q || `${it.p.name} ${posOf(it.p, loc)}`.toLowerCase().includes(q))
        && (!st.left || !locFilled(it, loc)));
      let rows;
      if (st.order === "walk") {
        // In the order they sit, under their headings. Anything not arranged yet goes last.
        const left = new Map(list.map((x) => [x[0].p.id, x]));
        const groups = [];
        let g = { name: "", rows: [] };
        groups.push(g);
        order[loc].forEach((e) => {
          if (e.s !== undefined) { g = { name: e.s, rows: [] }; groups.push(g); return; }
          const x = left.get(e.p);
          if (x) { g.rows.push(x); left.delete(e.p); }
        });
        const placed = groups.some((x) => x.rows.length);
        const rest = [...left.values()].sort(([a], [b]) => byPos(loc)(a, b));
        if (rest.length) groups.push({ name: placed ? "Not placed yet" : "", rows: rest, unplaced: placed });
        const tip = list.length && !hasOrder(loc) && !q && !st.left
          ? `<tbody><tr><td colspan="3" class="tb-none">There's no ${esc(LOC[loc])} order yet. Press <strong>Arrange order</strong> once to put the products in the order they sit.</td></tr></tbody>`
          : "";
        rows = tip + groups.filter((x) => x.rows.length).map((x) => (x.name
          ? groupHead(x.name, x.rows.length, x.unplaced ? " <small>· press Arrange order to put these in place</small>" : "", x.unplaced ? " sc-unplaced" : "")
          : "") + x.rows.map(([it, i]) => itemHtml(it, i, loc)).join("")).join("");
      } else if (st.order === "category") {
        rows = INV_CATEGORIES.map((c) => {
          const g = list.filter(([it]) => it.p.category === c.key).sort(([a], [b]) => a.p.name.localeCompare(b.p.name));
          return g.length ? groupHead(c.label, g.length) + g.map(([it, i]) => itemHtml(it, i, loc)).join("") : "";
        }).join("");
      } else {
        const sorter = st.order === "position" ? byPos(loc) : (a, b) => a.p.name.localeCompare(b.p.name);
        rows = list.sort(([a], [b]) => sorter(a, b)).map(([it, i]) => itemHtml(it, i, loc)).join("");
      }
      box.innerHTML = `<section class="tb-card sc-card"><div class="sc-scroll"><table class="sc-table">
        <thead><tr><th>Product</th><th>How many?</th><th>Comment <small>(optional)</small></th></tr></thead>
        ${rows || `<tbody><tr><td colspan="3" class="tb-none">${st.left ? "Everything here has been counted. 👍" : "No products match."}</td></tr></tbody>`}
      </table></div></section>`;
    }

    /* ---------- Arrange order (the whole clinic's walking order) ---------- */
    // Every product counted at this place (not only today's), so weekly and monthly ones get a place too
    function startArrange(loc) {
      const pool = new Map();
      products.filter((p) => p.active && (p.countFreq || "never") !== "never" && countLocs(p).includes(loc)).forEach((p) => pool.set(p.id, p));
      items.filter((it) => it.locs.includes(loc)).forEach((it) => pool.set(it.p.id, it.p));
      const list = [];
      order[loc].forEach((e) => {
        if (e.s !== undefined) list.push({ s: e.s });
        else if (pool.has(e.p)) { list.push({ p: e.p }); pool.delete(e.p); }
      });
      const rest = [...pool.values()].sort(byPosP(loc));
      if (rest.length && list.length) list.push({ s: "Not placed yet", tmp: true });
      rest.forEach((p) => list.push({ p: p.id }));
      st.arrange = { loc, list, dirty: false };
    }

    function drawArrange() {
      const box = body.querySelector('[data-role="table"]');
      const a = st.arrange;
      if (!box || !a) return;
      const last = a.list.length - 1;
      const mv = (i) => `<button type="button" class="sc-ar-mv" data-ar-act="up" aria-label="Move up"${i === 0 ? " disabled" : ""}>▲</button>
        <button type="button" class="sc-ar-mv" data-ar-act="down" aria-label="Move down"${i === last ? " disabled" : ""}>▼</button>`;
      box.innerHTML = `<section class="tb-card sc-arr">
        <div class="sc-arr-head">
          <div><h4>Arrange the ${esc(LOC[a.loc])} order</h4>
            <p class="muted">Put the products in the order they sit, so the count follows your walk. Drag ⠿, or use ▲ ▼.
              Add a heading for each fridge, cabinet or shelf. Everyone's count uses this order.</p></div>
          <button type="button" class="lh-btn" data-act="ar-sec">+ Add heading</button>
        </div>
        ${a.list.length ? `<ol class="sc-arr-list" data-role="arlist">${a.list.map((e, i) => {
          if (e.s !== undefined) {
            return `<li class="sc-ar is-sec${e.tmp ? " is-tmp" : ""}" data-ar="${i}">
              <span class="sc-grip" data-grip title="Drag to move" aria-hidden="true">⠿</span>
              <input class="fe-input sc-ar-name" data-ar-name value="${esc(e.s)}" maxlength="60" placeholder="e.g. Fridge" aria-label="Heading" />
              <span class="sc-ar-btns">${mv(i)}<button type="button" class="hx-x" data-ar-act="del" aria-label="Remove heading">×</button></span></li>`;
          }
          const p = byId.get(e.p);
          return `<li class="sc-ar" data-ar="${i}">
            <span class="sc-grip" data-grip title="Drag to move" aria-hidden="true">⠿</span>
            <span class="sc-ar-name"><strong>${esc(p ? p.name : "Removed product")}</strong><small>${esc(p ? catLabel(p.category) : "")}</small></span>
            <span class="sc-ar-btns">${mv(i)}</span></li>`;
        }).join("")}</ol>` : '<p class="tb-none">Nothing is counted here.</p>'}
        <div class="sc-arr-foot">
          <button type="button" class="lh-btn is-quiet" data-act="ar-cancel">Cancel</button>
          <button type="button" class="lh-btn is-primary" data-act="ar-save">Save order</button>
        </div>
      </section>`;
    }

    // Drag with a finger or the mouse (works on the iPad, unlike the browser's own drag and drop)
    let drag = null;
    body.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest("[data-grip]");
      if (!grip || !st.arrange) return;
      e.preventDefault();
      drag = { li: grip.closest("[data-ar]"), id: e.pointerId };
      drag.li.classList.add("is-dragging");
      document.body.classList.add("is-arranging");
      try { grip.setPointerCapture(e.pointerId); } catch { /* fine */ }
    });
    body.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const li = over && over.closest(".sc-arr-list > [data-ar]");
      if (li && li !== drag.li) {
        const r = li.getBoundingClientRect();
        li.parentNode.insertBefore(drag.li, e.clientY < r.top + r.height / 2 ? li : li.nextSibling);
      }
      if (e.clientY < 90) window.scrollBy(0, -14);
      else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
    });
    const endDrag = () => {
      if (!drag) return;
      drag.li.classList.remove("is-dragging");
      document.body.classList.remove("is-arranging");
      const ol = body.querySelector('[data-role="arlist"]');
      if (ol && st.arrange) {
        const next = [...ol.children].map((li) => st.arrange.list[Number(li.dataset.ar)]);
        if (next.some((x, i) => x !== st.arrange.list[i])) st.arrange.dirty = true;
        st.arrange.list = next;
      }
      drag = null;
      drawArrange();
    };
    body.addEventListener("pointerup", endDrag);
    body.addEventListener("pointercancel", endDrag);

    const leaveArrange = async () => {
      if (!st.arrange || !st.arrange.dirty) return true;
      return confirmDialog({
        title: "Leave without saving the order?", message: "The changes to the order haven't been saved.",
        confirmLabel: "Leave", tone: "warning",
      });
    };

    function kitsHtml() {
      if (!kitRows.length) return "";
      return `<section class="tb-card sc-card"><div class="sc-scroll"><table class="sc-table">
          <thead><tr><th>Injector</th><th>Product</th><th>Unopened</th><th>Left in the opened one</th></tr></thead>
          <tbody>${kitRows.map((r, i) => {
            const p = byId.get(r.k.productId);
            return `<tr class="${kitFilled(r) ? "is-done" : ""}" data-ki="${i}">
              <td><strong>${esc(r.k.staffName)}</strong></td>
              <td>${esc(r.k.productName)}<br><small class="muted">${esc(batchText(p, r.k.batch) || "No number")} · Exp ${esc(niceDate(r.k.expiry))}</small></td>
              <td><div class="sc-cell"><input class="fe-in sc-in" type="number" min="0" step="1" inputmode="numeric" data-k="sealed" data-col="ks"
                value="${esc(r.sealed)}" placeholder="?" aria-label="Unopened" /><span>${esc(unitPlural((p && p.stockUnit) || "vial"))}</span></div></td>
              <td><div class="sc-cell"><input class="fe-in sc-in" type="number" min="0" step="0.5" inputmode="decimal" data-k="open" data-col="ko"
                value="${esc(r.open)}" placeholder="?" aria-label="Left in the opened one" /><span>${esc(r.k.doseUnit)}</span></div></td></tr>`;
          }).join("")}</tbody></table></div></section>`;
    }

    // Shared products: the opened ones aren't counted, just checked they're still there (Shelf only)
    function openHtml() {
      const list = items.filter((it) => isSharedProduct(it.p) && it.locs.includes("shelf"))
        .flatMap((it) => openNow.filter((c) => c.productId === it.p.id).map((c) => ({ p: it.p, c })));
      if (!list.length) return "";
      return `<section class="tb-card"><h4>Opened ones</h4>
        <p class="sc-intro">These are already open, so they're not counted above. Just check each one is still there.</p>
        <div class="sc-scroll"><table class="sc-table">
          <thead><tr><th>Product</th><th>Opened</th><th>Is it still there?</th></tr></thead>
          <tbody>${list.map(({ p, c }) => {
            const v = openChecks.get(c.id) || "";
            return `<tr data-open="${esc(c.id)}">
              <td><strong>${esc(p.name)}</strong><br><small class="muted">${esc(batchText(p, c.batch) || "No number")}</small></td>
              <td>${esc([c.openedAt ? shortDate(c.openedAt) : "", plural(c.uses, "use")].filter(Boolean).join(" · "))}</td>
              <td><div class="fe-seg">${[["there", "Yes"], ["missing", "No, it's missing"]].map(([k, l]) =>
                `<label class="fe-seg-btn"><input type="radio" name="op-${esc(c.id)}" value="${k}" data-open-ck${v === k ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div></td></tr>`;
          }).join("")}</tbody></table></div></section>`;
    }

    function addInner() {
      const addable = products.filter((p) => {
        if (!p.active) return false;
        const it = items.find((x) => x.p.id === p.id);
        return !it || it.locs.length < 2;
      });
      return `<p class="sc-intro">Found a product that isn't on the list? Add it here.</p>
        <div class="sc-add"><select class="fb-select" data-role="addp"><option value="">Choose a product…</option>${INV_CATEGORIES.map((c) => {
          const g = addable.filter((p) => p.category === c.key);
          return g.length ? `<optgroup label="${esc(c.label)}">${g.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</optgroup>` : "";
        }).join("")}</select>
        <select class="fb-select" data-role="addloc"><option value="both">Shelf and JT storage</option><option value="shelf">Shelf</option><option value="jt">JT storage</option></select>
        <button type="button" class="lh-btn" data-act="add">Add</button></div>`;
    }

    function resumeHtml() {
      if (!st.resumed) return "";
      const when = st.resumed.at ? ` (saved ${esc(timeOf(new Date(st.resumed.at)))})` : "";
      return `<div class="sc-resume" role="status"><span>↻ ${st.resumed.by
        ? `Carrying on from <strong>${esc(st.resumed.by)}</strong>'s count${when}.`
        : `Carrying on from where you left off${when}.`}</span>
        <button type="button" class="cs-link" data-act="restart">Start again</button></div>`;
    }

    function draw() {
      const ps = places();
      if (ps.length && !ps.some(([k]) => k === st.place)) st.place = ps[0][0];
      if (st.arrange) {
        body.innerHTML = `${placesHtml()}<div data-role="table"></div>`;
        drawArrange();
        progress();
        return;
      }
      const intro = (PLACES.find(([k]) => k === st.place) || [])[2] || "";
      const orders = [["walk", "Walking order"], ["position", "Position code"], ["category", "Category"], ["name", "A–Z"]];
      const tools = st.place !== "kits" ? `<div class="sc-tools">
          <label class="ib-search sc-find">${I.search}<input type="search" data-role="q" placeholder="Find a product" value="${esc(st.q)}" aria-label="Find a product" /></label>
          <label class="sc-ord">Order <select class="fb-select" data-role="order">${orders
            .map(([v, l]) => `<option value="${v}"${st.order === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="fe-check"><input type="checkbox" data-role="left"${st.left ? " checked" : ""} /> Only show what's left</label>
          <button type="button" class="ff-btn" data-act="arrange">Arrange order</button>
        </div>` : "";
      const doneList = done.size ? `<details class="tb-card sc-more"><summary>Done today (${done.size})</summary><ul class="sc-done">${[...done.values()].map((v) =>
        `<li>${I.check}<span>${esc(v.name)} · ${esc(v.where)}</span><small>${esc(v.by)} · ${esc(timeOf(v.at))}</small></li>`).join("")}</ul></details>` : "";
      body.innerHTML = ps.length ? `
          ${resumeHtml()}
          ${placesHtml()}
          <p class="sc-intro">${esc(intro)}</p>
          ${tools}
          <div data-role="table"></div>
          ${st.place === "kits" ? kitsHtml() : ""}
          ${st.place === "shelf" ? openHtml() : ""}
          <div class="sc-next" data-role="next" hidden></div>
          <details class="tb-card sc-more"><summary>Something missing from the list?</summary>${addInner()}</details>
          ${doneList}`
        : `<div class="tm-empty">${done.size ? "Everything due today has been counted. 👍" : "Nothing is due for counting today."}</div>
          <details class="tb-card sc-more"><summary>Count something anyway</summary>${addInner()}</details>
          ${doneList}`;
      drawTable();
      progress();
    }

    /* ---------- Typing ---------- */
    body.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.arName !== undefined && st.arrange) {
        const entry = st.arrange.list[Number(t.closest("[data-ar]").dataset.ar)];
        if (entry) { entry.s = t.value; entry.tmp = false; st.arrange.dirty = true; }
        return;
      }
      if (t.dataset.role === "q") { st.q = t.value; drawTable(); return; }
      if (t.dataset.openCk !== undefined) { openChecks.set(t.closest("[data-open]").dataset.open, t.value); autosave(); return; }
      const kitEl = t.closest("[data-ki]");
      if (kitEl && t.dataset.k) {
        const r = kitRows[Number(kitEl.dataset.ki)];
        r[t.dataset.k] = t.value;
        kitEl.classList.toggle("is-done", kitFilled(r));
        msgEl.textContent = "";
        progress();
        autosave();
        return;
      }
      const tb = t.closest("tbody[data-it]");
      if (!tb) return;
      const it = items[Number(tb.dataset.it)];
      if (t.dataset.note !== undefined) { it.note = t.value; autosave(); return; }
      if (t.dataset.none) {
        const loc = t.dataset.none;
        it.none[loc] = whole(t.value);
        it.noneAt[loc] = it.none[loc] === "" ? 0 : Date.now();
      } else if (t.dataset.loc) {
        const r = it.rows[Number(t.dataset.r)];
        const loc = t.dataset.loc;
        r.counted[loc] = whole(t.value);
        r.countedAt[loc] = r.counted[loc] === "" ? 0 : Date.now();   // the moment this line was counted
      } else if (t.dataset.f) {
        it.rows[Number(t.dataset.r)][t.dataset.f] = t.value;
        autosave();
        return;
      } else {
        return;
      }
      tb.classList.toggle("is-done", locFilled(it, st.place));
      msgEl.textContent = "";
      progress();
      autosave();
    });
    body.addEventListener("change", (e) => {
      const r = e.target.dataset.role;
      if (r === "order") { st.order = e.target.value; drawTable(); }
      else if (r === "left") { st.left = e.target.checked; drawTable(); }
    });
    body.addEventListener("click", async (e) => {
      // Arrange order: ▲ ▼ and remove heading
      const arb = e.target.closest("[data-ar-act]");
      if (arb && st.arrange) {
        const i = Number(arb.closest("[data-ar]").dataset.ar);
        const act = arb.dataset.arAct;
        const L = st.arrange.list;
        if (act === "del") {
          L.splice(i, 1);
          st.arrange.dirty = true;
          drawArrange();
          return;
        }
        const j = i + (act === "up" ? -1 : 1);
        if (j < 0 || j >= L.length) return;
        [L[i], L[j]] = [L[j], L[i]];
        st.arrange.dirty = true;
        drawArrange();
        const again = body.querySelector(`[data-ar="${j}"] [data-ar-act="${act}"]`);
        const other = body.querySelector(`[data-ar="${j}"] [data-ar-act="${act === "up" ? "down" : "up"}"]`);
        (again && !again.disabled ? again : other).focus();
        return;
      }

      const pl = e.target.closest("[data-place]");
      if (pl) {
        if (!(await leaveArrange())) return;
        st.arrange = null;
        st.place = pl.dataset.place;
        st.q = "";
        draw();
        autosave();
        root.scrollIntoView({ behavior: "smooth", block: "start" });
        const first = body.querySelector("input.sc-in");
        if (first) setTimeout(() => first.focus({ preventScroll: true }), 300);
        return;
      }
      const a = e.target.closest("[data-act]");
      if (!a) return;
      const act = a.dataset.act;

      if (act === "arrange") {
        startArrange(st.place);
        draw();
        root.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (act === "ar-sec") {
        st.arrange.list.unshift({ s: "" });
        st.arrange.dirty = true;
        drawArrange();
        const inp = body.querySelector('[data-ar="0"] [data-ar-name]');
        if (inp) inp.focus();
        return;
      }
      if (act === "ar-cancel") {
        if (!(await leaveArrange())) return;
        st.arrange = null;
        draw();
        return;
      }
      if (act === "ar-save") {
        const ar = st.arrange;
        const list = ar.list.filter((x) => x.p || (x.s !== undefined && !x.tmp && x.s.trim()))
          .map((x) => (x.p ? { p: x.p } : { s: x.s.trim() }));
        a.disabled = true;
        a.textContent = "Saving…";
        try {
          await saveCountOrder(ar.loc, list, staff);
          order[ar.loc] = list;
          st.arrange = null;
          st.order = "walk";
          draw();
          showToast(`${LOC[ar.loc]} order saved. Everyone's count now follows it.`);
        } catch (err) {
          console.error("Save order failed:", err);
          showToast(err && err.code === "permission-denied"
            ? "You don't have access to change the order. Ask an Admin to check the Firestore rules."
            : "Couldn't save the order. Try again.");
          a.disabled = false;
          a.textContent = "Save order";
        }
        return;
      }
      if (act === "restart") {
        const ok = await confirmDialog({
          title: "Start the count again?",
          message: "Everything typed in so far is cleared, including anything saved to finish later. Counts already saved aren't affected.",
          confirmLabel: "Start again", tone: "warning",
        });
        if (!ok) return;
        clearLocal();
        await deleteCountDraft().catch(() => {});
        mountStockCount(container, { param, staff });
        return;
      }

      const tb = a.closest("tbody[data-it]");
      const idx = tb ? Number(tb.dataset.it) : -1;
      const it = idx >= 0 ? items[idx] : null;
      if (act === "found" && it) {
        it.rows.push(newRow("", "", true));
        drawTable();
        autosave();
        const ins = body.querySelectorAll(`tbody[data-it="${idx}"] [data-f="batch"]`);
        if (ins.length) ins[ins.length - 1].focus();
      } else if (act === "rm" && it) {
        it.rows.splice(Number(a.dataset.r), 1);
        drawTable();
        progress();
        autosave();
      } else if (act === "rm-item" && it) {
        items.splice(idx, 1);
        draw();
        autosave();
      } else if (act === "add") {
        const p = byId.get(body.querySelector('[data-role="addp"]').value);
        if (!p) { showToast("Choose a product."); return; }
        const v = body.querySelector('[data-role="addloc"]').value;
        const want = v === "both" ? ["shelf", "jt"] : [v];
        const cur = items.find((x) => x.p.id === p.id);
        if (cur) {
          const extra = want.filter((l) => !cur.locs.includes(l));
          if (!extra.length) { showToast("That's already on the list."); return; }
          cur.locs = LOCS.filter((l) => cur.locs.includes(l) || extra.includes(l));
          cur.extra = true;
        } else {
          items.push(makeItem(p, want, true));
        }
        st.q = "";
        st.left = false;
        st.place = want[0];
        draw();
        autosave();
        showToast(`${p.name} added`);
      }
    });

    /* ---------- Save and finish later ---------- */
    laterBtn.addEventListener("click", async () => {
      if (busy) return;
      if (st.arrange) { msgEl.textContent = "Save or cancel the new order first."; return; }
      if (!draftCount(snapshot()) && !snapshot().items.length) { msgEl.textContent = "Nothing has been counted yet."; return; }
      busy = true;
      laterBtn.disabled = true;
      laterBtn.querySelector("span").textContent = "Saving…";
      try {
        const merged = await mergeNewer();
        await saveCountDraft(snapshot(), staff);
        clearLocal();
        showToast(`Saved${merged ? ` (with ${merged}'s counts too)` : ""}. Open Task Manager → Opening count to carry on.`);
        location.hash = backHref;
      } catch (err) {
        console.error("Save for later failed:", err);
        msgEl.textContent = err && err.code === "permission-denied"
          ? "Saving for later is blocked. Ask an Admin to publish the Firestore rule for inv_count_drafts."
          : err && err.message && !err.code ? err.message : "Couldn't save. Your numbers are still kept on this device. Try again.";
      } finally {
        busy = false;
        laterBtn.disabled = false;
        laterBtn.querySelector("span").textContent = "Save and finish later";
      }
    });

    /* ---------- Save ---------- */
    saveBtn.addEventListener("click", async () => {
      if (busy) return;
      if (st.arrange) { msgEl.textContent = "Save or cancel the new order first."; return; }

      // Someone saved more counts for later while this was open: add them in first
      busy = true;
      let merged = "";
      try { merged = await mergeNewer(); } finally { busy = false; }
      if (merged) {
        draw();
        msgEl.textContent = `${merged} saved more counts while you were counting. They've been added: check them, then press Save count again.`;
        return;
      }

      const label = (it, loc) => `${it.p.name} (${LOC[loc]})`;
      const goTo = (loc) => { if (st.place !== loc) { st.place = loc; draw(); } };
      for (const it of items) {
        for (const loc of it.locs) {
          if (locStarted(it, loc) && !locFilled(it, loc)) {
            goTo(loc);
            msgEl.textContent = `${label(it, loc)}: fill in every ${batchName(it.p).toLowerCase()}, or leave them all empty to count it later.`;
            return;
          }
          if (noneAt(it, loc) && Number(it.none[loc]) > 0) {
            goTo(loc);
            msgEl.textContent = `${label(it, loc)}: there are none on record, so use “+ A ${batchName(it.p).toLowerCase()} that isn't listed” to enter what's there.`;
            return;
          }
        }
        for (const r of it.rows.filter((x) => x.found && LOCS.some((l) => x.counted[l] !== ""))) {
          if (!r.batch.trim()) { msgEl.textContent = `${it.p.name}: enter the ${batchName(it.p).toLowerCase()} number you found.`; return; }
          if (!r.expiry) { msgEl.textContent = `${it.p.name}: enter a real expiry date for the ${batchName(it.p).toLowerCase()} you found (check the day).`; return; }
        }
      }
      const partialKit = kitRows.find((r) => (r.sealed !== "" || r.open !== "") && !kitFilled(r));
      if (partialKit) {
        goTo("kits");
        msgEl.textContent = `${partialKit.k.staffName}'s ${partialKit.k.productName}: fill in both boxes (enter 0 if there's none).`;
        return;
      }

      const lines = [];
      items.forEach((it) => it.locs.filter((loc) => locFilled(it, loc)).forEach((loc) => {
        if (noneAt(it, loc) && it.none[loc] !== "") {
          lines.push({ productId: it.p.id, loc, batch: "", expiry: "", counted: it.none[loc], countedAt: it.noneAt[loc] || 0, note: it.note });
        }
        it.rows.filter((r) => (r.found || r.at[loc]) && r.counted[loc] !== "").forEach((r) => lines.push({
          productId: it.p.id, loc, batch: r.batch, expiry: r.expiry, counted: r.counted[loc], countedAt: r.countedAt[loc] || 0, note: it.note,
        }));
      }));
      const readyKits = kitRows.filter(kitFilled);
      if (!lines.length && !readyKits.length) { msgEl.textContent = "Count at least one item first."; return; }

      busy = true;
      saveBtn.disabled = true;
      laterBtn.disabled = true;
      saveBtn.querySelector("span").textContent = "Saving…";
      try {
        const res = await saveCount({
          kind: "opening",
          lines: [...lines, ...readyKits.map((r) => ({ kit: true, ref: r.k.id, sealed: r.sealed, open: r.open }))],
        }, staff);
        // The count is saved: nothing is waiting to be finished any more
        clearLocal();
        deleteCountDraft().catch((err) => console.warn("Saved progress not cleared:", err));
        // Opened containers that weren't there are closed, so treatment records stop offering them
        let missing = 0;
        for (const [id, v] of openChecks) {
          const c = v === "missing" ? openNow.find((x) => x.id === id) : null;
          if (!c) continue;
          try {
            await finishContainer(c, { reason: "Missing at the opening count", note: `Not found at the opening count by ${(staff && staff.name) || "staff"}` }, staff);
            missing++;
          } catch (err) { console.warn("Couldn't close a missing container:", err); }
        }
        showResults(res, missing);
      } catch (err) {
        console.error("Save count failed:", err);
        msgEl.textContent = err && err.code === "permission-denied"
          ? "You don't have access to save counts. Ask an Admin to check your access in Staff."
          : err && err.message && !err.code ? err.message : "Couldn't save. Try again.";
      } finally {
        busy = false;
        saveBtn.disabled = false;
        laterBtn.disabled = false;
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
        showResults(res, 0);
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
  function showResults(res, missingOpened) {
    const diffs = res.lines.filter((l) => l.status === "open");
    const invs = res.lines.filter((l) => l.status === "investigating");
    const qty = (l, n) => `${fmt(n)}${l.loc === "kit" ? ` ${l.unit}` : ""}`;
    const movedNote = (l) => (Number(l.movedSince)
      ? `<br><small class="muted">${fmt(Math.abs(l.movedSince))} ${l.movedSince < 0 ? "used" : "added"} after you counted</small>` : "");
    $('[data-role="progress"]').textContent = "";
    saveBtn.hidden = true;
    if (laterBtn) laterBtn.hidden = true;
    body.innerHTML = `<section class="tb-card sc-results">
      <h4>${I.check} Count saved</h4>
      <p>${res.lines.length} line${res.lines.length === 1 ? "" : "s"} counted.${
        invs.length ? ` <strong>${invs.length} didn't match the digital count</strong>, so an investigation has been opened:
          someone else will recount ${invs.length === 1 ? "it" : "them"}.` : ""}${
        diffs.length ? ` <strong>${diffs.length} small difference${diffs.length === 1 ? "" : "s"}</strong> sent to Reporting for review.` : ""}${
        !invs.length && !diffs.length ? " Everything matched. 👍" : " Stock hasn't been changed."}${
        missingOpened ? ` ${missingOpened} opened container${missingOpened === 1 ? " was" : "s were"} marked missing.` : ""}</p>
      <div class="sc-scroll"><table class="inv-table"><thead><tr><th>Product</th><th>Where</th><th>Batch / Lot</th><th>Counted</th><th>Digital</th><th>Difference</th></tr></thead><tbody>${
        res.lines.map((l) => `<tr class="${l.status !== "ok" ? "is-diff" : ""}">
          <td>${esc(l.productName)}${l.countNote ? `<br><small class="muted">“${esc(l.countNote)}”</small>` : ""}</td><td>${esc(whereOf(l))}</td>
          <td>${esc(l.batch ? `${l.batchLabel || batchName(byId.get(l.productId))} ${l.batch}` : "—")}</td>
          <td>${esc(qty(l, l.counted))}</td>
          <td>${l.status === "investigating" ? '<span class="muted">Hidden until the recount</span>' : esc(qty(l, l.system)) + movedNote(l)}</td>
          <td>${l.status === "investigating" ? '<span class="inv-flag is-bad">Investigating</span>'
            : l.status === "open" ? `<strong>${esc(diffText(l.variance))}</strong>` : "✓"}</td></tr>`).join("")}</tbody></table></div>
      <div class="sc-after"><a class="ff-btn" href="${backHref}">Back to tasks</a>
        <button type="button" class="ff-btn is-primary" data-act="again">Count more</button></div>
    </section>`;
    body.querySelector('[data-act="again"]').addEventListener("click", () => mountStockCount(container, { param, staff }));
    showToast(invs.length ? `Saved. ${invs.length} investigation${invs.length === 1 ? "" : "s"} opened.`
      : diffs.length ? `Saved. ${diffs.length} difference${diffs.length === 1 ? "" : "s"} to review.` : "Saved. Everything matched.");
  }
}