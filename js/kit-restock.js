// "My kit" restocking: without opening a treatment record.
// Same rules as Restock on a treatment record: from the Shelf when it has stock, otherwise ask JT storage
// (an approver releases it to the Shelf), or take units from a colleague's opened vial.
// bare: inside a dashboard card (no title of its own). onChange: called after a restock, instead of reloading itself.
import {
  listProducts, listKits, listReleases, listAllLots, listOpenContainers, openContainer, fefo,
  isKitProduct, kitUnits, plural, myUid, expiryState, batchText,
} from "./inventory-api.js";
import { takeFromShelfDialog, borrowDialog, jtReleaseDialog } from "./inventory-kits.js";
import { restockDialog, chooseVialDialog } from "./consumables-field.js";
import { isInjector, isAdmin, can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(+Number(n || 0).toFixed(1));
const niceDate = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  kit: ic('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M12 11v6M9 14h6"/>'),
  shelf: ic('<path d="M3 6h18M3 12h18M3 18h18"/><rect x="6" y="2.5" width="4" height="3.5" rx=".5"/><rect x="13" y="8.5" width="4" height="3.5" rx=".5"/>'),
  jt: ic('<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1.5"/>'),
  people: ic('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  refresh: ic('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/>'),
};

function injectStyles() {
  if (document.getElementById("kr-styles-4")) return;
  document.getElementById("kr-styles-3")?.remove();
  document.getElementById("kr-styles-2")?.remove();
  document.getElementById("kr-styles-1")?.remove();
  const s = document.createElement("style");
  s.id = "kr-styles-4";
  s.textContent = `
.kr-card{background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:18px 20px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.kr-card svg,.kr-bare svg{width:18px;height:18px;flex:none}
.kr-bare{container-type:inline-size}
.kr-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.kr-logo{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none;background:linear-gradient(135deg,#14b8a6,#0f766e);color:#fff;box-shadow:0 6px 14px rgba(15,118,110,.25)}
.kr-logo svg{width:20px;height:20px}
.kr-head-t{flex:1;min-width:0}
.kr-head h3{margin:0;font-size:16px;color:#0f172a}
.kr-head p{margin:2px 0 0;font-size:12.5px;color:#64748b}
.kr-tool{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;color:#475569;font:inherit;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer}
.kr-tool:hover{border-color:#14b8a6;color:#0f766e}
.kr-prod{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px 16px;align-items:center;padding:16px;border:1px solid #eef2f6;border-radius:16px;background:linear-gradient(#fff,#fbfdfd)}
.kr-prod+.kr-prod{margin-top:12px}
.kr-ring{--c:#14b8a6;width:84px;height:84px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--c) calc(var(--p) * 1%),#eef2f6 0)}
.kr-ring.is-low{--c:#f59e0b}.kr-ring.is-empty{--c:#ef4444}
.kr-ring>div{width:66px;height:66px;border-radius:50%;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.05}
.kr-ring b{font-size:19px;color:#0f172a}
.kr-ring span{font-size:11px;color:#64748b}
.kr-info{min-width:0}
.kr-name{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.kr-name strong{font-size:15px;color:#0f172a}
.kr-pill{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700}
.kr-pill.is-ok{background:#dcfce7;color:#166534}.kr-pill.is-low{background:#fef3c7;color:#92400e}.kr-pill.is-empty{background:#fee2e2;color:#b91c1c}
.kr-info small{display:block;margin-top:4px;font-size:12.5px;color:#64748b}
.kr-info small b{color:#334155;font-weight:600}
.kr-exp{color:#b45309!important}.kr-exp.is-bad{color:#b91c1c!important}
.kr-acts{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.kr-act{display:flex;align-items:center;gap:10px;min-height:56px;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:14px;background:#fff;text-align:left;font:inherit;color:#0f172a;cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .1s}
.kr-act:hover:not(:disabled){border-color:#14b8a6;box-shadow:0 0 0 3px rgba(20,184,166,.12)}
.kr-act:active:not(:disabled){transform:translateY(1px)}
.kr-act-ic{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;flex:none;background:#f1f5f9;color:#475569}
.kr-act-t{display:flex;flex-direction:column;min-width:0}
.kr-act-t strong{font-size:13.5px}
.kr-act-t small{font-size:12px;color:#64748b}
.kr-act.is-primary{border-color:#0f766e;background:linear-gradient(135deg,#14b8a6,#0f766e);color:#fff;box-shadow:0 6px 16px rgba(15,118,110,.25)}
.kr-act.is-primary .kr-act-ic{background:rgba(255,255,255,.2);color:#fff}
.kr-act.is-primary small{color:rgba(255,255,255,.85)}
.kr-act.is-wait{border-color:#bfdbfe;background:#eff6ff}
.kr-act.is-wait .kr-act-ic{background:#dbeafe;color:#1d4ed8}
.kr-act:disabled{cursor:default;opacity:.6}
.kr-act.is-wait:disabled{opacity:1}
.kr-msg{padding:12px;border-radius:12px;background:#fef2f2;color:#991b1b;font-size:13px}
.kr-restock{grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;border:0;border-radius:14px;
  background:linear-gradient(135deg,#14b8a6,#0f766e);color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 6px 16px rgba(15,118,110,.25)}
.kr-restock:hover:not(:disabled){filter:brightness(1.06)}
.kr-restock:disabled{opacity:.6;cursor:default}
.kr-info small.kr-wait{color:#1d4ed8}
.kr-bare .kr-prod{padding:14px}
.kr-bare .kr-acts{grid-template-columns:1fr}
.kr-bare .kr-act{min-height:48px}
@container (min-width:560px){.kr-bare .kr-acts{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:720px){.kr-acts{grid-template-columns:1fr}.kr-card{padding:16px}.kr-head p{display:none}}`;
  document.head.appendChild(s);
}

export function mountKitRestock(el, { staff, bare = false, onChange = null } = {}) {
  if (!el) return;
  if (!isInjector()) { el.hidden = true; return; }
  injectStyles();
  el.classList.add(bare ? "kr-bare" : "kr-card");
  let products = [], kits = [], rels = [], lots = [], open = [];
  let lastLoad = 0;
  let loading = false;

  const action = (kind, pid, icon, title, sub, { primary = false, wait = false, off = false } = {}) => `
    <button type="button" class="kr-act${primary ? " is-primary" : ""}${wait ? " is-wait" : ""}" data-kr="${kind}" data-pid="${esc(pid)}"${off ? " disabled" : ""}>
      <span class="kr-act-ic">${icon}</span><span class="kr-act-t"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span></button>`;

  function productHtml(p, kits, rels, me) {
    const ks = kits.filter((k) => k.productId === p.id);
    const total = ks.reduce((a, k) => a + kitUnits(k), 0);
    const sealed = ks.reduce((a, k) => a + k.sealed, 0);
    const opened = ks.filter((k) => k.open > 0).sort((a, b) => (a.expiry || "9").localeCompare(b.expiry || "9"))[0] || null;
    const tone = total <= 0 ? "empty" : total < p.dosePer ? "low" : "ok";
    const pct = Math.max(total > 0 ? 4 : 0, Math.min(100, Math.round((total / Math.max(1, p.dosePer)) * 100)));
    const pending = rels.find((r) => r.productId === p.id && r.requestedByUid === me && r.status === "pending");
    const unit = p.stockUnit;
    const exp = opened ? expiryState(opened.expiry) : "";

    return `<div class="kr-prod">
      <div class="kr-ring is-${tone}" style="--p:${pct}" aria-label="${esc(`${fmt(total)} ${p.doseUnit} in your kit`)}">
        <div><b>${fmt(total)}</b><span>${esc(p.doseUnit)}</span></div></div>
      <div class="kr-info">
        <div class="kr-name"><strong>${esc(p.name)}</strong>
          <span class="kr-pill is-${tone}">${tone === "empty" ? "Empty" : tone === "low" ? "Running low" : "Good"}</span></div>
        <small>${opened
          ? `Opened vial: <b>${fmt(opened.open)} ${esc(p.doseUnit)}</b> left${opened.batch ? ` · ${esc(batchText(p, opened.batch))}` : ""}`
          : "No opened vial"}${sealed ? ` · <b>${esc(plural(sealed, unit))}</b> unopened` : ""}</small>
        ${opened && opened.expiry ? `<small class="${exp ? `kr-exp${exp === "expired" ? " is-bad" : ""}` : ""}">Expires ${esc(niceDate(opened.expiry))}${
          exp === "expired" ? " · expired" : exp === "soon" ? " · soon" : ""}</small>` : ""}
        ${pending ? `<small class="kr-wait">Asked JT storage for ${esc(plural(pending.qty, unit))} · waiting for approval</small>` : ""}
      </div>
      <button type="button" class="kr-restock" data-kr="restock" data-pid="${esc(p.id)}">${IC.kit}<span>Restock</span></button>
    </div>`;
  }

  async function load() {
    if (loading) return;
    loading = true;
    lastLoad = Date.now();
    if (!el.innerHTML) el.innerHTML = '<div class="skeleton" style="height:150px;border-radius:14px"></div>';
    try {
      [products, kits, rels, lots, open] = await Promise.all([
        listProducts(), listKits({ mine: true }), listReleases(50).catch(() => []),
        isAdmin() ? listAllLots().catch(() => []) : [],
        isAdmin() ? listOpenContainers().catch(() => []) : [],
      ]);
    } catch (err) {
      console.error("My kit not loaded:", err);
      loading = false;
      if (el.isConnected) el.innerHTML = '<div class="kr-msg">Couldn\'t load your kit. Check your connection, then refresh.</div>';
      return;
    }
    loading = false;
    if (!el.isConnected) return;
    const list = products.filter((p) => p.active && isKitProduct(p));
    if (!list.length) { el.hidden = true; return; }
    el.hidden = false;
    const me = myUid();
    el.innerHTML = `${bare ? "" : `
      <div class="kr-head">
        <span class="kr-logo">${IC.kit}</span>
        <div class="kr-head-t"><h3>My kit</h3><p>Restock any time, without opening a treatment record.</p></div>
        ${can("menu.inventory") ? '<a class="kr-tool" href="#/inventory/kits">Details</a>' : ""}
        <button type="button" class="kr-tool" data-kr="refresh" aria-label="Refresh" title="Refresh">${IC.refresh}</button>
      </div>`}
      ${list.map((p) => productHtml(p, kits, rels, me)).join("")}`;
  }

  // Where Restock can take it from: the same rules as Restock on a treatment record (consumables-field.js),
  // without "Use my kit" (there's no treatment here). Admins open a vial in JT storage; everyone else asks for a release.
  function restockOptions(p) {
    const seeStock = can("inventory.manage");
    const admin = isAdmin();
    const shelfN = Number(p.stock.shelf) || 0;
    const jtN = Number(p.stock.jt) || 0;
    const opts = [{ k: "shelf", icon: "shelf", title: "From the Shelf", off: shelfN <= 0,
      sub: shelfN > 0 ? `Into your kit${seeStock ? ` · ${plural(shelfN, p.stockUnit)} left` : ""}` : "None left on the Shelf" }];
    if (admin) {
      opts.push({ k: "vial", icon: "lock", admin: true, title: `Open a new ${p.stockUnit} from JT storage`, off: jtN <= 0,
        sub: jtN > 0 ? `Choose the batch${seeStock ? ` · ${plural(jtN, p.stockUnit)} left` : ""}` : "None left in JT storage" });
    }
    opts.push({ k: "take", icon: "users", title: "Take from a colleague",
      sub: `Into your kit, from their opened ${p.stockUnit}. They're asked to confirm.` });
    if (!admin && shelfN <= 0 && jtN > 0) {
      const pend = rels.find((r) => r.productId === p.id && r.requestedByUid === myUid() && r.status === "pending");
      opts.push({ k: "release", icon: "send", title: "Ask for a JT storage release", off: !!pend,
        sub: pend ? `Asked for ${plural(pend.qty, pend.unit || p.stockUnit)} · waiting for approval`
          : "Sends a request to the approvers. Once it's approved, it goes on the Shelf." });
    }
    if (seeStock && shelfN <= 0 && jtN <= 0) {
      opts.push({ k: "order", icon: "send", title: "Ask the ordering team for more", sub: "None left on the Shelf or in JT storage" });
    }
    return opts;
  }

  // Admins: open a new vial in JT storage (its units are used from there, not from a kit)
  async function openJtVial(p) {
    const jtLots = lots.filter((x) => x.productId === p.id && x.loc === "jt" && x.qty > 0).sort(fefo);
    if (!jtLots.length) { showToast("None left in JT storage."); return false; }
    const left = open.filter((c) => c.productId === p.id && c.kind === "vial" && c.from === "jt")
      .reduce((a, c) => a + Math.max(0, (c.size || p.dosePer) - c.used), 0);
    const lot = await chooseVialDialog(p, jtLots, { where: "JT storage", openLeft: Math.round(left * 10) / 10 });
    if (!lot) return false;
    try {
      await openContainer(p, lot, staff);
      showToast(`New ${p.stockUnit} opened in JT storage (${batchText(p, lot.batch) || "no batch number"}): ${fmt(p.dosePer)} ${p.doseUnit} ready.`);
      return true;
    } catch (err) {
      console.error("Open vial failed:", err);
      showToast(err && err.message && !err.code ? err.message : "Couldn't open it. Try again.");
      return false;
    }
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-kr]");
    if (!b || b.disabled) return;
    if (b.dataset.kr === "refresh") { load(); return; }
    const p = products.find((x) => x.id === b.dataset.pid);
    if (!p) return;
    b.disabled = true;
    try {
      const k = await restockDialog(p, restockOptions(p));
      if (k === "order") { location.hash = `#/tasks/order/${encodeURIComponent(p.id)}`; return; }
      const done = k === "shelf" ? await takeFromShelfDialog(p, staff)
        : k === "take" ? await borrowDialog(p, staff)
        : k === "release" ? await jtReleaseDialog(p, staff)
        : k === "vial" ? await openJtVial(p)
        : false;
      if (done && el.isConnected) { if (onChange) onChange(); else await load(); }
    } finally {
      if (b.isConnected) b.disabled = false;
    }
  });

  // Back on this tab (e.g. JT storage approved the release): fresh numbers, at most once a minute
  const onFocus = () => {
    if (!el.isConnected) { window.removeEventListener("focus", onFocus); return; }
    if (Date.now() - lastLoad > 60000) load();
  };
  window.addEventListener("focus", onFocus);

  load();
}