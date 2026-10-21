// The kit question at Start and End of Day, one per kit product: "How many units remaining?"
// 0 (or nothing in the kit) → that's all. More than 0 → which batch, chosen from the kit records (not typed),
// and its expiry, filled in from the batch as DD/MM/YYYY (editable as DD/MM/YYYY or MM/YYYY).
// The units are never filled in, and the list never shows how many units the system thinks are left (a blind count).
import { escapeHtml } from "./utils.js";
import { listKits, listAllLots } from "./inventory-api.js";

const esc = (s) => escapeHtml(String(s ?? ""));
const bl = (p) => (p && p.batchLabel) || "Batch";
const normB = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const KEY = /^\d{4}-\d{2}-\d{2}$/;
const OTHER = "other";
const q = (kc, s) => kc.querySelector(s);
const show = (el, on) => { if (el) el.style.display = on ? "" : "none"; };
const shown = (el) => !!el && el.style.display !== "none";
const byExp = (a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999");
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// "2027-03-31" → "31/03/2027"
export const expText = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

// "31/03/2027", "31-3-27" or "03/2027" (→ the last day of that month) → "2027-03-31".
// "" when empty, null when it can't be read or the date doesn't exist (e.g. 31/09/2027)
export function parseExpiry(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  const ok = (y, mo, d) => {
    const dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d
      ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  };
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) return ok(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) {
    const mo = +m[1];
    return mo >= 1 && mo <= 12 ? ok(+m[2], mo, new Date(+m[2], mo, 0).getDate()) : null;
  }
  return null;
}
const monthOnly = (s) => /^\d{1,2}[/.-]\d{4}$/.test(String(s || "").trim());

// Each tracked kit product's batches: the ones in my kit first (oldest expiry first), then the ones on the Shelf.
// Map productId → [{ batch, expiry, where: "kit" | "shelf" }]
export async function kitBatchOptions(products) {
  const tracked = (products || []).filter((p) => p && p.tracked);
  const out = new Map();
  if (!tracked.length) return out;
  const [kits, lots] = await Promise.all([
    listKits({ mine: true }).catch(() => []),
    listAllLots().catch(() => []),
  ]);
  tracked.forEach((p) => {
    const list = [];
    const seen = new Set();
    const add = (batch, expiry, where) => {
      const k = `${normB(batch)}|${expiry || ""}`;
      if (!normB(batch) || seen.has(k)) return;
      seen.add(k);
      list.push({ batch: String(batch), expiry: KEY.test(expiry || "") ? expiry : "", where });
    };
    kits.filter((k) => k.productId === p.id).sort(byExp).forEach((k) => add(k.batch, k.expiry, "kit"));
    lots.filter((l) => l.productId === p.id && l.loc === "shelf").sort(byExp).forEach((l) => add(l.batch, l.expiry, "shelf"));
    out.set(p.id, list);
  });
  return out;
}

// The batch and expiry part, for products tracked by batch
function batchHtml(p, options, batch, expiry) {
  const lbl = bl(p);
  // Start on this morning's batch (or the one from the kit records); with nothing to go on, the oldest in the kit
  let pick = batch ? options.findIndex((o) => normB(o.batch) === normB(batch)) : (options.length ? 0 : -1);
  const other = pick === -1;
  const cur = other ? { batch, expiry: KEY.test(expiry || "") ? expiry : "" } : options[pick];
  const opt = (o, i) => `<option value="${i}"${i === pick ? " selected" : ""}>${esc(`${lbl} ${o.batch}`)} · Exp ${
    esc(expText(o.expiry) || "not recorded")}</option>`;
  const group = (where, title) => {
    const list = options.map((o, i) => [o, i]).filter(([o]) => o.where === where);
    return list.length ? `<optgroup label="${esc(title)}">${list.map(([o, i]) => opt(o, i)).join("")}</optgroup>` : "";
  };
  const hide = (on) => (on ? ' style="display:none"' : "");
  return `<div class="kc-batch" hidden>
      ${options.length ? `<label class="lh-field"><span class="lh-label">${esc(lbl)}</span>
        <select class="fb-select" data-f="batchpick" aria-label="${esc(p.name)}: ${esc(lbl)}">
          ${group("kit", "In your kit")}${group("shelf", "On the Shelf (not in your kit yet)")}
          <option value="${OTHER}"${other ? " selected" : ""}>Not in the list…</option>
        </select></label>` : ""}
      <label class="lh-field" data-role="typed"${hide(!other)}><span class="lh-label">${esc(lbl)} # <small>(from the label)</small></span>
        <input class="fe-input sod-batch" data-f="batch" maxlength="40" autocomplete="off" spellcheck="false"
          placeholder="From the label" value="${esc(cur.batch || "")}" /></label>
      <div class="lh-field"><span class="lh-label">Expiry date</span>
        <span class="kc-exp" data-role="expshow"${hide(!cur.expiry || other)}>
          <strong data-role="exptext">${esc(expText(cur.expiry))}</strong>
          <button type="button" class="rc-link" data-act="exp-edit">Edit</button></span>
        <input class="fe-input kc-exp-in" data-f="expirytext" inputmode="numeric" maxlength="10" autocomplete="off"
          placeholder="DD/MM/YYYY or MM/YYYY" aria-label="${esc(p.name)}: expiry date"
          value="${esc(expText(cur.expiry))}"${hide(!!cur.expiry && !other)} />
        <small class="kc-exp-note" data-role="expnote" aria-live="polite"></small>
      </div>
      <input type="hidden" data-f="expiry" value="${esc(cur.expiry || "")}" />
      <small class="muted kc-other-note" data-role="othernote"${hide(!(other && options.length))}>A ${esc(lbl.toLowerCase())} that isn't
        in your kit records is checked by an admin.</small>
    </div>`;
}

// items: [{ p, batch, expiry, options }]. batch / expiry pre-select a batch; the units are never filled in.
export function kitCountHtml(items) {
  return items.map(({ p, batch = "", expiry = "", options = [] }) => `
    <div class="kc" data-pid="${esc(p.id)}" data-opts="${esc(JSON.stringify(options.map((o) => ({ b: o.batch, e: o.expiry }))))}">
      <label class="kc-q">
        <span><strong>${esc(p.name)}</strong><small>How many ${esc(p.doseUnit)} remaining?</small></span>
        <span class="fe-num kc-units"><input class="fe-input" type="number" min="0" step="0.5" inputmode="decimal" data-f="units"
          aria-label="${esc(p.name)}: ${esc(p.doseUnit)} remaining" /><span>${esc(p.doseUnit)}</span></span>
      </label>
      ${p.tracked ? batchHtml(p, options, batch, expiry) : ""}
    </div>`).join("");
}

function note(kc, msg, tone = "") {
  const n = q(kc, '[data-role="expnote"]');
  if (!n) return;
  n.textContent = msg;
  n.className = `kc-exp-note${tone ? ` is-${tone}` : ""}`;
}

// A batch chosen from the list: its number and expiry are filled in. "Not in the list…": typed from the label.
function pickBatch(kc, v) {
  let opts = [];
  try { opts = JSON.parse(kc.dataset.opts || "[]"); } catch { opts = []; }
  const o = v === OTHER ? null : opts[Number(v)] || null;
  const batchEl = q(kc, '[data-f="batch"]');
  const txt = q(kc, '[data-f="expirytext"]');
  const iso = o && KEY.test(o.e || "") ? o.e : "";
  show(q(kc, '[data-role="typed"]'), !o);
  show(q(kc, '[data-role="othernote"]'), !o);
  batchEl.value = o ? o.b : "";
  q(kc, '[data-f="expiry"]').value = iso;
  q(kc, '[data-role="exptext"]').textContent = expText(iso);
  txt.value = expText(iso);
  show(q(kc, '[data-role="expshow"]'), !!iso);
  show(txt, !iso);
  note(kc, o && !iso ? "This batch has no expiry recorded. Enter it from the label." : "", o && !iso ? "warn" : "");
  if (!o) batchEl.focus();
}

// The expiry typed in: checked as it's typed, and saved as YYYY-MM-DD
function readExpText(kc) {
  const raw = q(kc, '[data-f="expirytext"]').value;
  const v = parseExpiry(raw);
  q(kc, '[data-f="expiry"]').value = v || "";
  if (v === null) note(kc, "Use DD/MM/YYYY (e.g. 31/03/2027) or MM/YYYY (e.g. 03/2027).", "bad");
  else if (v && v < todayKey()) note(kc, `${expText(v)} has already passed. Check the label.`, "warn");
  else if (v && monthOnly(raw)) note(kc, `Saved as ${expText(v)}, the last day of that month.`);
  else note(kc, "");
}

// Shows the batch and expiry once the units are more than 0, and handles choosing and editing them
export function wireKitCount(root) {
  root.addEventListener("input", (e) => {
    const t = e.target;
    const kc = t.closest && t.closest(".kc");
    if (!kc) return;
    if (t.dataset.f === "units") {
      const box = q(kc, ".kc-batch");
      if (box) box.hidden = !(Number(t.value) > 0);
    } else if (t.dataset.f === "expirytext") readExpText(kc);
  });
  root.addEventListener("change", (e) => {
    if (e.target.dataset.f === "batchpick") pickBatch(e.target.closest(".kc"), e.target.value);
  });
  root.addEventListener("click", (e) => {
    const b = e.target.closest('[data-act="exp-edit"]');
    if (!b) return;
    const kc = b.closest(".kc");
    const txt = q(kc, '[data-f="expirytext"]');
    show(q(kc, '[data-role="expshow"]'), false);
    show(txt, true);
    note(kc, "Only change it if the label shows a different date.", "warn");
    txt.focus();
    txt.select();
  });
}

// { items: [{ productId, rows }] } (rows: [] when 0), or { error, focus }
export function readKitCount(root, products) {
  const items = [];
  for (const p of products) {
    const kc = root.querySelector(`.kc[data-pid="${CSS.escape(p.id)}"]`);
    if (!kc) continue;
    const f = (k) => q(kc, `[data-f="${k}"]`);
    const raw = f("units").value.trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n) || n < 0) {
      return { error: `${p.name}: enter how many ${p.doseUnit} remaining (0 if none).`, focus: f("units") };
    }
    if (!(n > 0)) { items.push({ productId: p.id, rows: [] }); continue; }
    let batch = "", expiry = "";
    if (p.tracked) {
      const lbl = bl(p).toLowerCase();
      const pick = f("batchpick");
      const txt = f("expirytext");
      const fromList = !!pick && pick.value !== OTHER;
      batch = f("batch").value.trim();
      if (!batch) {
        return { error: fromList ? `${p.name}: choose the ${lbl}.` : `${p.name}: type the ${lbl} number from the label.`,
          focus: fromList ? pick : f("batch") };
      }
      if (shown(txt)) {
        const v = parseExpiry(txt.value);
        if (v === null) return { error: `${p.name}: check the expiry date. Use DD/MM/YYYY or MM/YYYY.`, focus: txt };
        f("expiry").value = v;
      }
      expiry = f("expiry").value;
      if (!KEY.test(expiry)) {
        show(q(kc, '[data-role="expshow"]'), false);
        show(txt, true);
        return { error: `${p.name}: enter the expiry date (DD/MM/YYYY or MM/YYYY).`, focus: txt };
      }
    }
    items.push({ productId: p.id, rows: [{ batch, expiry, units: Math.round(n * 10) / 10, inUse: true }] });
  }
  return { items };
}