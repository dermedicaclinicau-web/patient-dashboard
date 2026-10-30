import { fetchSkincare, lastPurchaseMap, purchaseStatus, normProduct, monthsSince } from "./skincare.js";
import { escapeHtml, formatDobLong, showToast } from "./utils.js";
import { listSspRecords, createSspRecord } from "./ssp-api.js";
import { openSspPreview, emailSspRecord } from "./ssp-send.js";
import { getSspSettings } from "./ssp-settings.js";
import { patientIds } from "./patients.js";
import { setSspIntent } from "./ssp-edit.js";
import { confirmDialog } from "./dialog.js";
import { can } from "./perms.js";

const PAGE = 10;

const STEPS = [
  ["A", "Step A - Preparing your Skin"],
  ["BOOST", "Boost"],
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
  eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
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
            <button type="button" class="sk-btn" data-action="create-ssp">Create new SSP</button>
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

/* ===================== Data: sheet protocols + portal protocols ===================== */

// A protocol saved in the portal, in the same shape as the sheet ones
function portalProtocol(r) {
  return {
    recordId: r.recordId || r.id,
    date: r.recordDate || "",
    dateText: "",
    createdMs: r.createdMs || 0,
    portal: r,
    items: (r.items || []).map((it) => ({
      product: it.name,
      step: it.step,
      am: it.amText || "",
      pm: it.pmText || "",
      slotAm: !!it.am,
      slotPm: !!it.pm,
      when: [(it.days || []).join(", "), it.notes].filter(Boolean).join(" · "),
      maintenance: it.maint ? "Yes" : "",
    })),
  };
}

async function fetchAllSkincare(patient) {
  const [res, portal] = await Promise.all([
    fetchSkincare(patient),
    listSspRecords([patient.id, ...patientIds(patient)]).catch((err) => {
      console.warn("Portal Skin Scripts unavailable:", err);
      return [];
    }),
  ]);
  const portalIds = new Set(portal.map((r) => r.recordId).filter(Boolean));
  const fromSheet = (res.protocols || []).filter((p) => !portalIds.has(p.recordId)); // no duplicates
  const protocols = [...portal.map(portalProtocol), ...fromSheet].sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")) || (b.createdMs || 0) - (a.createdMs || 0));
  return { ...res, protocols };
}

/* ===================== Sheet protocols: saved into the portal so they can be sent ===================== */

const isoAddMonths = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1 + n, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};
const todayIso = () => isoAddMonths(new Date().toISOString().slice(0, 10), 0);

// The portal version of an SSP_NEW protocol. Keeps the sheet's record ID, so the patient page shows it once
// and the sheet isn't written to again.
async function sheetRecord(p, patient) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || "")) {
    throw new Error("This protocol has no date, so it can't be sent. Use Duplicate to make a new one.");
  }
  const settings = await getSspSettings().catch(() => null);
  const months = (settings && settings.validMonths) || 3;
  const items = sheetItems(p)
    .map((it) => ({ ...it, productId: "", size: "", step: it.step || "F", name: String(it.name || "").slice(0, 150),
      amText: String(it.amText || "").slice(0, 3000), pmText: String(it.pmText || "").slice(0, 3000) }))
    .filter((it) => it.name && (it.am || it.pm));
  if (!items.length) throw new Error("This protocol has no products on it, so there's nothing to send.");
  return {
    recordId: p.recordId || `SSP-${p.date.replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    patientId: patient.id,
    patientPttId: patient.pttId || "",
    patientName: patient.name || "",
    recordDate: p.date,
    validUntil: isoAddMonths(p.date, months),
    items: items.slice(0, 150),
  };
}

const sendErr = (err) => (err && err.code === "permission-denied"
  ? "Only staff who can create Skin Scripts can send older protocols. Ask an admin, or check the ssp_records rule."
  : err && err.code ? "Couldn't do that. Check your connection and try again."
  : (err && err.message) || "Something went wrong. Try again.");

/* ===================== Behaviour ===================== */

export function mountSkincare(root, patient, staff = null) {
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
        const res = await fetchAllSkincare(patient);
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
      ? data.protocols.map((p, i) => protocolHtml(p, i === 0, lastMap, i)).join("") + legendHtml() +
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

    // One action at a time per button, with a readable message if it fails
  async function busyBtn(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } catch (err) {
      console.error("Skin Script action failed:", err);
      showToast(sendErr(err));
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }

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
      return;
    }
    // Edit (portal protocols) / Duplicate (any protocol): open the builder with it filled in
    const ed = e.target.closest("[data-sk-ed]");
    if (ed) {
      const p = data && data.protocols[Number(ed.dataset.idx)];
      if (!p) return;
      if (ed.dataset.skEd === "edit" && p.portal) {
        setSspIntent({ mode: "edit", patientId: patient.id, recordId: p.portal.id });
      } else if (ed.dataset.skEd === "edit") {
        // Old protocol from the sheet: saved into the portal once (same record ID and date), then edited there
        busyBtn(ed, async () => {
          const rec = await sheetRecord(p, patient);
          const id = await createSspRecord(rec, staff);
          setSspIntent({ mode: "edit", patientId: patient.id, recordId: id });
          location.hash = `#/ssp/new/${encodeURIComponent(patient.id)}`;
        });
        return;
      } else {
        setSspIntent({
          mode: "copy", patientId: patient.id,
          recordId: p.portal ? p.portal.id : "",
          items: p.portal ? null : sheetItems(p),
          fromDate: p.date || p.dateText || "",
        });
      }
      location.hash = `#/ssp/new/${encodeURIComponent(patient.id)}`;
      return;
    }
    // Email / Print on an older protocol from the sheet: saved into the portal once, then sent
    const sh = e.target.closest("[data-sk-sheet]");
    if (sh) {
      const p = data && data.protocols[Number(sh.dataset.idx)];
      if (!p || p.portal) return;
      busyBtn(sh, async () => {
        const rec = await sheetRecord(p, patient);
        if (rec.validUntil < todayIso() && !(await confirmDialog({
          title: "This protocol has expired",
          message: `It was valid until ${formatDobLong(rec.validUntil)}. Send it anyway, or use Duplicate to make an up-to-date one.`,
          confirmLabel: "Send anyway", tone: "warning",
        }))) return;
        const id = await createSspRecord(rec, staff);
        const saved = { id, ...rec, createdBy: (staff && staff.name) || "" };
        if (sh.dataset.skSheet === "email") await emailSspRecord({ record: saved, patient, staff });
        else await openSspPreview({ record: saved, patient, staff, autoAction: "print" });
        if (grid.isConnected) load(true);   // now shows as a portal protocol, with any email / print
      });
      return;
    }
    // View / Email / Print on a protocol saved in the portal. Email goes straight to the email window.
    const act = e.target.closest("[data-sk-ssp]");
    if (act) {
      const p = data && data.protocols.find((x) => x.portal && x.portal.id === act.dataset.id);
      if (!p) return;
      const kind = act.dataset.skSsp;
      busyBtn(act, async () => {
        if (kind === "email") await emailSspRecord({ record: p.portal, patient, staff });
        else await openSspPreview({ record: p.portal, patient, staff, autoAction: kind === "print" ? "print" : "" });
        if (grid.isConnected) load(true);   // shows any new email / print
      });
    }
  });

  if (sspCard.open) load();
}

/* ===================== Skin Script Protocol ===================== */

function stepLetter(step) {
  const s = String(step || "").trim();
  if (/boost/i.test(s)) return "BOOST";
  const m = /step\s*([A-F])\b/i.exec(s) || /^([A-F])\b/i.exec(s);
  return m ? m[1].toUpperCase() : "";
}

// Morning / evening placement: portal protocols say exactly; sheet ones are worked out
function slots(item) {
  if (item.slotAm !== undefined) return { am: item.slotAm, pm: item.slotPm };
  // Old sheet protocols: the PROTOCOL column ("AM", "PM", "AM/PM") says when, the AM/PM cells hold any wording
  const when = String(item.protocol || item.whenToUse || item.when || "").toLowerCase();
  const has = (v) => String(v || "").trim() !== "";   // a tick (✓, Y, x) counts, not just wording
  let am = has(item.am) || /\b(am|morning|day|both)\b/.test(when);
  const pm = has(item.pm) || /\b(pm|evening|night|both)\b/.test(when);
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
      ${item.when ? `<div class="ssp-when-note">${escapeHtml(item.when)}</div>` : ""}
    </div>`;
}

function portalMeta(r) {
  const sent = (r.deliveries || []).slice(-2).reverse()
    .map((d) => (d.kind === "print" ? "Sent to printer" : `Emailed to ${d.to}`));
  return [
    r.validUntil ? `Valid until ${formatDobLong(r.validUntil)}` : "",
    r.createdBy ? `by ${r.createdBy}` : "",
    r.editCount ? `Edited${r.editCount > 1 ? ` ${r.editCount}×` : ""}${r.editedBy ? ` · last by ${r.editedBy}` : ""}` : "",
    ...sent,
  ].filter(Boolean).map(escapeHtml).join(" · ");
}

// An SSP_NEW protocol, ready to copy into the builder (products are matched by name there)
function sheetItems(p) {
  return (p.items || []).map((it) => {
    const s = slots(it);
    return {
      name: it.product, step: stepLetter(it.step),
      am: s.am, pm: s.pm,
      amText: s.am ? it.am || "" : "", pmText: s.pm ? it.pm || "" : "",
      maint: /^y/i.test(String(it.maintenance || "")),
      days: [], notes: String(it.when || it.whenToUse || "").slice(0, 300),
    };
  });
}

function protocolHtml(p, isLatest, lastMap, idx = 0) {
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
  const id = p.portal ? escapeHtml(p.portal.id) : "";

  const canEdit = can("ssp.create");
  const editBtns = canEdit
    ? `<button type="button" class="ssp-btn" data-sk-ed="edit" data-idx="${idx}" title="${p.portal ? "Change this protocol" : "Saves this older protocol into the portal, then opens it for editing"}">${ICONS.edit}Edit</button>
       <button type="button" class="ssp-btn" data-sk-ed="copy" data-idx="${idx}" title="Start a new protocol from this one">${ICONS.copy}Duplicate</button>`
    : "";
  const actions = p.portal
    ? `<button type="button" class="ssp-btn" data-sk-ssp="view" data-id="${id}">${ICONS.eye}View</button>
       <button type="button" class="ssp-btn" data-sk-ssp="email" data-id="${id}">${ICONS.mail}Email to Patient</button>
       <button type="button" class="ssp-btn" data-sk-ssp="print" data-id="${id}">${ICONS.print}Print</button>${editBtns}`
    : `<button type="button" class="ssp-btn" data-sk-sheet="email" data-idx="${idx}">${ICONS.mail}Email to Patient</button>
       <button type="button" class="ssp-btn" data-sk-sheet="print" data-idx="${idx}">${ICONS.print}Print</button>${editBtns}`;

  return `
    <details class="ssp-protocol" ${isLatest ? "open" : ""}>
      <summary>
        <span class="ssp-title">Protocol from ${escapeHtml(dateLabel)}</span>
        <span class="ssp-actions">${actions}${ICONS.chev}</span>
      </summary>
      ${p.portal ? `<p class="sk-ssp-meta">${portalMeta(p.portal)}</p>` : ""}
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