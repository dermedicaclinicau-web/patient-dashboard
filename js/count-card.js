// Task Manager → Opening count card: today's progress, who has counted, recounts waiting, and a button to start.
// Uses the same "due" and "done" rules as stock-count.js and My dashboard, so all three always agree.
import {
  listProducts, listKits, listCountsOn, getCountSettings, listInvestigations,
  countDue, countLocs, isKitProduct, dayKey, myUid, COUNT_DUE_DEFAULT,
} from "./inventory-api.js";
import { can, isInjector } from "./perms.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clock = (t) => { const [h, m] = String(t || COUNT_DUE_DEFAULT).split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };
const timeOf = (d) => d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });

export async function renderCountCard(host, { staff = null } = {}) {
  if (!host) return;
  const canCount = can("inventory.count") || can("inventory.order") || can("inventory.manage");
  const canKit = isInjector();
  if (!canCount && !canKit) { host.innerHTML = ""; return; }
  host.innerHTML = '<section class="tb-card cc"><div class="skeleton" style="height:110px;border-radius:10px"></div></section>';

  let products, kits, todays, cfg, invs;
  try {
    [products, kits, todays, cfg, invs] = await Promise.all([
      listProducts(),
      listKits().catch(() => []),
      listCountsOn(dayKey()),
      getCountSettings().catch(() => ({ dueBy: COUNT_DUE_DEFAULT })),
      canCount ? listInvestigations({ open: true }).catch(() => []) : [],
    ]);
  } catch (err) {
    console.warn("Opening count card failed:", err);
    if (host.isConnected) host.innerHTML = `<section class="tb-card cc"><h4>Opening count</h4>
      <p class="tb-none tb-bad">Couldn't load today's count.</p><a class="ff-btn" href="#/tasks/count">Open the count</a></section>`;
    return;
  }
  if (!host.isConnected) return;

  const me = myUid();
  // Counted today by anyone: Shelf / JT per product, kits per lot
  const done = new Set(todays.flatMap((c) => c.lines.map((l) =>
    l.loc === "kit" ? `kit|${l.ref}` : c.kind === "opening" ? `${l.productId}|${l.loc}` : "")).filter(Boolean));

  // Due today, by where it's counted. JT storage is optional for products also counted on the Shelf.
  const groups = { shelf: [], jt: [], kit: [] };
  const optJt = [];
  products.filter((p) => countDue(p)).forEach((p) => {
    const locs = countLocs(p);
    locs.forEach((loc) => {
      const key = `${p.id}|${loc}`;
      if (loc === "jt" && locs.includes("shelf")) optJt.push(key); else groups[loc].push(key);
    });
    if (isKitProduct(p)) kits.filter((k) => k.productId === p.id).forEach((k) => groups.kit.push(`kit|${k.id}`));
  });
  const left = (keys) => keys.filter((k) => !done.has(k)).length;
  const all = [...groups.shelf, ...groups.jt, ...groups.kit];
  const total = all.length;
  const remaining = left(all);
  const counted = total - remaining;
  const optDone = optJt.length - left(optJt);
  const [h, m] = String(cfg.dueBy || COUNT_DUE_DEFAULT).split(":").map(Number);
  const now = new Date();
  const late = now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
  const state = !total ? "none" : !remaining ? "done" : late ? "late" : "due";
  const pill = { none: "Nothing due today", done: "Done today ✓", late: `Overdue · was due ${clock(cfg.dueBy)}`, due: `Due by ${clock(cfg.dueBy)}` }[state];

  // Who counted today (each person once, at their first count)
  const who = new Map();
  todays.filter((c) => c.kind === "opening").forEach((c) => {
    const t = c.at ? c.at.getTime() : 0;
    if (c.by && (!who.has(c.by) || t < who.get(c.by))) who.set(c.by, t);
  });
  const whoText = [...who].sort((a, b) => a[1] - b[1])
    .map(([n, t]) => `${n}${t ? ` (${timeOf(new Date(t))})` : ""}`).join(", ");

  const myKitLeft = canKit ? kits.filter((k) => k.staffUid === me && groups.kit.includes(`kit|${k.id}`) && !done.has(`kit|${k.id}`)).length : 0;
  const recounts = invs.filter((v) => v.status === "recount" && (v.openedByUid !== me || v.aloneApproved === true));
  const setUp = products.some((p) => p.active && p.countFreq && p.countFreq !== "never");
  const pct = total ? Math.round((counted / total) * 100) : 0;
  const locs = [["shelf", "Shelf"], ["jt", "JT storage"], ["kit", "Kits"]].filter(([k]) => groups[k].length).map(([k, l]) => {
    const n = left(groups[k]);
    return `<span class="cc-loc${n ? "" : " is-done"}">${l}: ${n ? `${n} left` : "done ✓"}</span>`;
  }).join("") + (optJt.length
    ? `<span class="cc-loc${optDone ? " is-done" : ""}">JT storage (optional): ${optDone} of ${optJt.length}</span>` : "");
  const mainLabel = state === "done" ? "Count more" : counted ? "Continue the count" : "Start the count";

  host.innerHTML = `<section class="tb-card cc is-${state}">
    <div class="cc-head">
      <div><h4>Opening count</h4>
        <p class="muted">Count what's physically there. It's a blind count: the system's numbers aren't shown.</p></div>
      <span class="cc-pill">${esc(pill)}</span>
    </div>
    ${total ? `
      <div class="cc-bar" role="progressbar" aria-label="Opening count progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <p class="cc-sum"><strong>${counted} of ${total}</strong> counted ${locs}</p>`
      : !setUp && can("inventory.manage") ? `<p class="muted">No products are set to be counted yet. Choose how often each one is counted in
          Inventory → Products → Edit → <strong>Opening count</strong>.</p>` : ""}
    ${whoText ? `<p class="muted cc-who">Counted today by ${esc(whoText)}</p>` : ""}
    ${recounts.length ? `<p class="cc-warn">${recounts.length === 1
      ? `A recount is needed: <strong>${esc(recounts[0].productName)}</strong> (${recounts[0].loc === "jt" ? "JT storage" : "Shelf"}).`
      : `<strong>${recounts.length} recounts</strong> are needed.`} Someone other than the first counter does it.</p>` : ""}
    <div class="cc-acts">
      ${canCount ? `<a class="ff-btn${state === "due" || state === "late" ? " is-primary" : ""}" href="#/tasks/count">${mainLabel}</a>` : ""}
      ${canKit ? `<a class="ff-btn${!canCount && myKitLeft ? " is-primary" : ""}" href="#/tasks/count/kit">Check my kit${myKitLeft ? ` (${myKitLeft})` : ""}</a>` : ""}
      ${recounts.length ? `<a class="ff-btn" href="${recounts.length === 1
        ? `#/inventory/investigations/${encodeURIComponent(recounts[0].id)}` : "#/inventory/investigations"}">Recount</a>` : ""}
      ${can("menu.reports") ? '<a class="cc-link" href="#/reports/variance">Count differences →</a>' : ""}
    </div>
  </section>`;
}