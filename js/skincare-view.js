import { fetchSkincare, lastPurchaseMap, purchaseStatus, normProduct, monthsSince } from "./skincare.js";
import { escapeHtml, formatDobLong } from "./utils.js";

const PAGE = 10;

const STEPS = [
  ["A", "Step A - Preparing your Skin"],
  ["B", "Step B - Prevent & Correct"],
  ["C", "Step C - Hydrating"],
  ["D", "Step D - Eye Care"],
  ["E", "Step E - Sunscreen"],
  ["F", "Step F - Prescriptions & Other Products"],
];

const svg = (p, cls = "") =>
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  chev: svg('<polyline points="6 9 12 15 18 9"/>', "sum-chev"),
  mail: svg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  print: svg('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
};

// Shares the dashboard's "remember open sections" storage
function wasOpen() {
  try { return !!(JSON.parse(localStorage.getItem("pd-open-sections")) || {}).skincare; } catch { return false; }
}

/* ===================== Layout ===================== */

export function skincareSectionHtml() {
  const open = wasOpen() ? "open" : "";
  return `
    <div class="sk-grid">
      <details class="sk-card" data-key="skincare" ${open}>
        <summary>
          <span class="sk-title">${ICONS.chev}Skin Script Protocol</span>
          <span class="sk-tools">
            <button type="button" class="sk-btn" data-sk-action="refresh">Refresh</button>
            <button type="button" class="sk-btn" data-soon="Create new SSP">Create new SSP</button>
            <span class="sk-badge sk-ssp-count">–</span>
          </span>
        </summary>
        <div class="sk-body sk-ssp-body"><div class="skeleton sm"></div></div>
      </details>

      <details class="sk-card" data-key="skincare" ${open}>
        <summary>
          <span class="sk-title">${ICONS.chev}Product Purchase Records</span>
          <span class="sk-tools"><span class="sk-badge sk-pur-count">–</span></span>
        </summary>
        <div class="sk-body sk-pur-body"><div class="skeleton sm"></div></div>
      </details>
    </div>`;
}

/* ===================== Behaviour ===================== */

export function mountSkincare(root, patient) {
  const grid = root.querySelector(".sk-grid");
  if (!grid) return;
  const [sspCard, purCard] = grid.querySelectorAll(".sk-card");
  const sspBody = grid.querySelector(".sk-ssp-body");
  const purBody = grid.querySelector(".sk-pur-body");

  let data = null;
  let loading = null;
  let shown = PAGE;
  let sspProducts = new Set();

  function load(force = false) {
    if (loading) return loading;
    if (data && !force) return Promise.resolve();

    loading = (async () => {
      try {
        const res = await fetchSkincare(patient);
        if (!grid.isConnected) return;
        data = res;
        shown = PAGE;
        render();
      } catch (err) {
        if (!grid.isConnected) return;
        console.error("Skincare load failed:", err);
        const msg = err.code === "permission-denied"
          ? "Skincare records aren't accessible. Check the Firestore rules."
          : "Couldn't load skincare records.";
        sspBody.innerHTML = purBody.innerHTML = `<p class="empty-note error">${msg}</p>`;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  function render() {
    const lastMap = lastPurchaseMap(data.purchases);
    sspProducts = new Set(((data.protocols[0] || {}).items || []).map((i) => normProduct(i.product)));

    grid.querySelector(".sk-ssp-count").textContent = data.protocols.length;
    grid.querySelector(".sk-pur-count").textContent = data.purchases.length;

    sspBody.innerHTML = data.protocols.length
      ? data.protocols.map((p, i) => protocolHtml(p, i === 0, lastMap)).join("") + legendHtml() +
        (data.matchedByName ? `<p class="sk-note">Some records were matched by patient name.</p>` : "")
      : `<p class="sk-empty">No skin script protocol on record.</p>`;

    renderPurchases();
  }

  function renderPurchases() {
    purBody.innerHTML = purchasesHtml(data.purchases, sspProducts, shown);
  }

  // Opening/closing one card does the same to the other, and loads both
  grid.addEventListener("toggle", (e) => {
    const card = e.target;
    if (!card.classList || !card.classList.contains("sk-card")) return;
    const other = card === sspCard ? purCard : sspCard;
    if (other.open !== card.open) other.open = card.open;
    if (card.open) load();
  }, true);

  grid.addEventListener("click", (e) => {
    const refresh = e.target.closest("[data-sk-action='refresh']");
    if (refresh) {
      if (!sspCard.open) { sspCard.open = true; return; } // opening triggers the load
      refresh.disabled = true;
      load(true).finally(() => { refresh.disabled = false; });
      return;
    }
    if (e.target.closest("[data-sk-action='more']")) {
      shown += PAGE;
      renderPurchases();
    }
  });

  if (sspCard.open) load();
}

/* ===================== Skin Script Protocol ===================== */

function stepLetter(step) {
  const s = String(step || "").trim();
  const m = /step\s*([A-F])\b/i.exec(s) || /^([A-F])\b/i.exec(s);
  return m ? m[1].toUpperCase() : "";
}

// Morning / evening placement from the instructions + "WHEN TO USE"
function slots(item) {
  const when = String(item.whenToUse || "").toLowerCase();
  let am = !!item.am || /\b(am|morning|day|both)\b/.test(when);
  const pm = !!item.pm || /\b(pm|evening|night|both)\b/.test(when);
  if (!am && !pm) am = true; // unknown: show in morning with "no instruction"
  return { am, pm };
}

function statusTitle(status, date) {
  if (status === "none") return "Not yet purchased";
  const when = formatDobLong(date);
  return { green: `Last purchased ${when} (within 6 months)`,
           yellow: `Last purchased ${when} (over 6 months ago)`,
           red: `Last purchased ${when} (over 12 months ago)` }[status];
}

function productHtml(item, which, lastMap) {
  const last = lastMap.get(normProduct(item.product)) || "";
  const status = purchaseStatus(last);
  const instr = which === "am" ? item.am : item.pm;
  return `
    <div class="ssp-prod">
      <div class="ssp-name">
        <span class="ssp-dot dot-${status}" title="${escapeHtml(statusTitle(status, last))}"></span>
        <b>${escapeHtml(item.product)}</b>
        ${last ? `<span class="ssp-last">(${escapeHtml(formatDobLong(last))})</span>` : ""}
      </div>
      ${instr
        ? `<div class="ssp-instr">${escapeHtml(instr)}</div>`
        : `<div class="ssp-instr none">(No instruction available)</div>`}
    </div>`;
}

function protocolHtml(p, isLatest, lastMap) {
  const rows = {};
  (p.items || []).forEach((item) => {
    const key = stepLetter(item.step) || "other";
    rows[key] = rows[key] || { am: [], pm: [] };
    const s = slots(item);
    if (s.am) rows[key].am.push(productHtml(item, "am", lastMap));
    if (s.pm) rows[key].pm.push(productHtml(item, "pm", lastMap));
  });

  const ordered = STEPS.filter(([l]) => rows[l]);
  if (rows.other) ordered.push(["other", "Other products"]);

  const cell = (list) => (list.length ? list.join("") : `<span class="missing">—</span>`);
  const dateLabel = p.date ? formatDobLong(p.date) : (p.dateText || "Undated");

  return `
    <details class="ssp-protocol" ${isLatest ? "open" : ""}>
      <summary>
        <span class="ssp-title">Protocol from ${escapeHtml(dateLabel)}</span>
        <span class="ssp-actions">
          <button type="button" class="ssp-btn" data-soon="Email to patient">${ICONS.mail}Email to Patient</button>
          <button type="button" class="ssp-btn" data-soon="Print protocol">${ICONS.print}Print</button>
          ${ICONS.chev}
        </span>
      </summary>
      <div class="ssp-table-wrap">
        <table class="ssp-table">
          <thead><tr><th>Step</th><th>Morning</th><th>Evening</th></tr></thead>
          <tbody>
            ${ordered.map(([l, label]) => `
              <tr>
                <td class="ssp-step">${escapeHtml(label)}</td>
                <td>${cell(rows[l].am)}</td>
                <td>${cell(rows[l].pm)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </details>`;
}

function legendHtml() {
  return `
    <div class="ssp-legend">
      <span><i class="ssp-dot dot-green"></i>Purchased within 6 months</span>
      <span><i class="ssp-dot dot-yellow"></i>Over 6 months ago</span>
      <span><i class="ssp-dot dot-red"></i>Over 12 months ago</span>
      <span><i class="ssp-dot dot-none"></i>Not yet purchased</span>
    </div>`;
}

/* ===================== Product Purchase Records ===================== */

function timeAgo(dateKey) {
  const m = monthsSince(dateKey);
  if (m === null) return "";
  if (m < 1) return "this month";
  if (m < 12) return `${m} mo ago`;
  const y = Math.floor(m / 12);
  return `${y} yr${y === 1 ? "" : "s"} ago`;
}

function purchasesHtml(purchases, sspProducts, shown) {
  if (!purchases.length) return `<p class="sk-empty">No product purchases on record.</p>`;

  const counts = new Map();
  purchases.forEach((p) => {
    const key = normProduct(p.product);
    const c = counts.get(key) || { name: p.product, n: 0 };
    c.n++;
    counts.set(key, c);
  });
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  const notInSsp = purchases.filter((p) => !sspProducts.has(normProduct(p.product))).length;
  const samples = purchases.filter((p) => /sample/i.test(p.product)).length;
  const last = purchases[0];
  const remaining = purchases.length - shown;

  return `
    <div class="pur-chips">
      <span class="pur-chip">${purchases.length} purchase${purchases.length === 1 ? "" : "s"}</span>
      <span class="pur-chip">${counts.size} product${counts.size === 1 ? "" : "s"}</span>
      ${notInSsp ? `<span class="pur-chip warn">${notInSsp} not in SSP</span>` : ""}
    </div>

    <div class="pur-stats">
      <div class="pur-stat"><small>Most purchased</small>
        <strong>${escapeHtml(top.name)}${top.n > 1 ? ` <em>×${top.n}</em>` : ""}</strong></div>
      <div class="pur-stat"><small>Last purchase</small>
        <strong>${escapeHtml(last.date ? formatDobLong(last.date) : last.dateText)}${last.date ? ` · <span class="muted">${timeAgo(last.date)}</span>` : ""}</strong></div>
      <div class="pur-stat"><small>Samples given</small>
        <strong>${samples || "None"}</strong></div>
    </div>

    <ul class="pur-list">
      ${purchases.slice(0, shown).map((p) => `
        <li class="pur-row">
          <span class="pur-date">${escapeHtml(p.date ? formatDobLong(p.date) : p.dateText)}</span>
          <span class="pur-prod">${escapeHtml(p.product)}
            ${sspProducts.has(normProduct(p.product)) ? "" : `<span class="tag-notssp">Not in SSP</span>`}</span>
          <span class="pur-staff">${escapeHtml(p.staff || "")}</span>
        </li>`).join("")}
    </ul>

    ${remaining > 0
      ? `<button type="button" class="pur-more" data-sk-action="more">Load ${Math.min(PAGE, remaining)} more · ${remaining} remaining</button>`
      : ""}`;
}