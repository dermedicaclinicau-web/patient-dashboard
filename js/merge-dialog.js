import { countLinkedRecords, mergePatients, LINKED } from "./merge-patients.js";
import { escapeHtml, formatDobLong, formatMobile } from "./utils.js";
import { confirmDialog } from "./dialog.js";

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  merge: svg('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

const FIELDS = [
  { key: "name", label: "Name", raw: (p) => ({ firstName: p.firstName, lastName: p.lastName }),
    id: (p) => `${p.firstName}|${p.lastName}`.toLowerCase().trim(), show: (p) => p.name, has: (p) => p.firstName || p.lastName },
  { key: "dobKey", label: "Date of birth", raw: (p) => p.dobKey, id: (p) => p.dobKey, show: (p) => formatDobLong(p.dobKey), has: (p) => p.dobKey },
  { key: "mobile", label: "Mobile", raw: (p) => p.mobile, id: (p) => String(p.mobile || "").replace(/\D/g, ""), show: (p) => formatMobile(p.mobile), has: (p) => p.mobile },
  { key: "email", label: "Email", raw: (p) => p.email, id: (p) => String(p.email || "").toLowerCase().trim(), show: (p) => p.email, has: (p) => p.email },
  { key: "address", label: "Address", raw: (p) => p.address, id: (p) => String(p.address || "").toLowerCase().trim(), show: (p) => p.address, has: (p) => p.address },
];

let dlg = null;
let ctx = null;

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement("dialog");
  dlg.className = "em-dialog mg-dialog";
  dlg.setAttribute("aria-label", "Merge patient records");
  document.body.appendChild(dlg);

  dlg.addEventListener("click", (e) => { if (e.target.closest("[data-mg='close']")) dlg.close(); });
  dlg.addEventListener("change", (e) => {
    if (!ctx) return;
    if (e.target.name === "keep") { ctx.keepId = e.target.value; resetChoices(); render(); }
    else if (e.target.name && e.target.name.startsWith("f-")) ctx.choice[e.target.name.slice(2)] = e.target.value;
  });
  dlg.addEventListener("submit", onSubmit);
  dlg.addEventListener("close", () => { if (ctx) ctx.resolve(ctx.merged); ctx = null; dlg.innerHTML = ""; });
}

// Resolves true if the records were merged
export function openMergeDialog(patients) {
  ensureDialog();
  if (dlg.open) dlg.close();

  return new Promise((resolve) => {
    ctx = { resolve, merged: false, patients, keepId: patients[0].id, counts: {}, choice: {}, ready: false };
    const myCtx = ctx;
    resetChoices();
    render();
    dlg.showModal();

    Promise.all(patients.map((p) => countLinkedRecords(p).catch(() => null))).then((list) => {
      if (ctx !== myCtx) return;
      patients.forEach((p, i) => { myCtx.counts[p.id] = list[i]; });
      // Default: keep the record with the most history
      const best = [...patients].sort((a, b) =>
        ((list[patients.indexOf(b)] || {}).total || 0) - ((list[patients.indexOf(a)] || {}).total || 0))[0];
      myCtx.keepId = best.id;
      myCtx.ready = true;
      resetChoices();
      render();
    });
  });
}

const keeper = () => ctx.patients.find((p) => p.id === ctx.keepId);
const others = () => ctx.patients.filter((p) => p.id !== ctx.keepId);

function optionsFor(f) {
  const seen = new Map();
  ctx.patients.forEach((p) => { if (f.has(p) && !seen.has(f.id(p))) seen.set(f.id(p), p); });
  return [...seen.entries()].map(([id, p]) => ({ id, p }));
}

function resetChoices() {
  const k = keeper();
  FIELDS.forEach((f) => {
    const opts = optionsFor(f);
    ctx.choice[f.key] = f.has(k) ? f.id(k) : (opts[0] ? opts[0].id : "");
  });
}

function countsText(c, short) {
  if (!c) return ctx.ready ? "Couldn't count records" : "Counting…";
  const parts = LINKED.filter(([col]) => c[col]).map(([col, , one, many]) => `${c[col]} ${c[col] === 1 ? one : many}`);
  if (short) return c.total ? `${c.total} linked record${c.total === 1 ? "" : "s"}` : "No linked records";
  return parts.length ? parts.join(", ") : "no linked records";
}

function render() {
  const k = keeper();
  const rest = others();

  const recordCards = ctx.patients.map((p) => {
    const keep = p.id === ctx.keepId;
    return `
      <label class="mg-rec${keep ? " is-keep" : ""}">
        <input type="radio" name="keep" value="${escapeHtml(p.id)}" ${keep ? "checked" : ""} />
        <span class="mg-rec-main">
          <strong>${escapeHtml(p.name)}</strong>
          <small>ID ${escapeHtml(p.pttId || p.id)}${p.dobKey ? ` · ${escapeHtml(formatDobLong(p.dobKey))}` : ""}</small>
          <small>${escapeHtml(countsText(ctx.counts[p.id], true))}</small>
        </span>
        <span class="mg-pill">${keep ? "Keep" : "Merge in"}</span>
      </label>`;
  }).join("");

  const fieldRows = FIELDS.map((f) => {
    const opts = optionsFor(f);
    if (!opts.length) return `<div class="mg-field"><span class="mg-fl">${f.label}</span><span class="mg-none">Not on file</span></div>`;
    if (opts.length === 1) return `<div class="mg-field"><span class="mg-fl">${f.label}</span><span>${escapeHtml(f.show(opts[0].p))}</span></div>`;
    return `
      <div class="mg-field"><span class="mg-fl">${f.label}</span>
        <span class="mg-opts">${opts.map((o) => `
          <label class="mg-opt"><input type="radio" name="f-${f.key}" value="${escapeHtml(o.id)}" ${ctx.choice[f.key] === o.id ? "checked" : ""} />
            ${escapeHtml(f.show(o.p))}</label>`).join("")}
        </span>
      </div>`;
  }).join("");

  const moving = rest.map((p) => `<li><strong>${escapeHtml(p.name)}</strong> (${escapeHtml(p.pttId || p.id)}): ${escapeHtml(countsText(ctx.counts[p.id], false))}</li>`).join("");

  dlg.innerHTML = `
    <form class="em-form mg-form" novalidate>
      <header class="em-head">
        ${I.merge}<h2>Merge patient records</h2>
        <button type="button" class="em-close" data-mg="close" aria-label="Close">${I.x}</button>
      </header>

      <section class="mg-sec">
        <p class="mg-label">1. Record to keep</p>
        <div class="mg-recs">${recordCards}</div>
      </section>

      <section class="mg-sec">
        <p class="mg-label">2. Details to keep</p>
        <div class="mg-fields">${fieldRows}</div>
      </section>

      <section class="mg-sec">
        <p class="mg-label">3. What comes across to ${escapeHtml(k.name)}</p>
        <ul class="mg-move">${moving}</ul>
        <p class="mg-note">Pre-consultation details, visit history, skincare, billing and audio from the merged record${rest.length > 1 ? "s" : ""}
          will also show. Medication, allergy, condition and social history lists are combined.</p>
      </section>

      <p class="mg-warn">If these patients are also duplicated in your practice system, merge them there too, so new bookings arrive under one ID.</p>
      <p class="em-error" role="alert"></p>

      <footer class="em-foot">
        <button type="button" class="btn-ghost" data-mg="close">Cancel</button>
        <button type="submit" class="em-send mg-go" ${ctx.ready ? "" : "disabled"}>${I.merge}Merge records</button>
      </footer>
    </form>`;
}

async function onSubmit(e) {
  e.preventDefault();
  if (!ctx || !ctx.ready) return;
  const myCtx = ctx;
  const errEl = dlg.querySelector(".em-error");
  const btn = dlg.querySelector(".mg-go");
  const k = keeper();
  const rest = others();

  // Build the chosen details
  const pick = (f) => {
    const o = optionsFor(f).find((x) => x.id === myCtx.choice[f.key]);
    return o ? f.raw(o.p) : f.raw(k);
  };
  const name = pick(FIELDS[0]);
  const details = {
    firstName: name.firstName, lastName: name.lastName,
    dobKey: pick(FIELDS[1]) || "", mobile: pick(FIELDS[2]) || "", email: pick(FIELDS[3]) || "", address: pick(FIELDS[4]) || "",
  };

  const ok = await confirmDialog({
    title: `Merge ${rest.length} record${rest.length > 1 ? "s" : ""} into ${k.name}?`,
    message: `${rest.map((p) => `${p.name} (${p.pttId || p.id})`).join(", ")} will be hidden from the patient list. ` +
      `Opening ${rest.length > 1 ? "them" : "it"} will show ${k.name} instead.\n\n` +
      "An Admin can undo this from the patient's page.",
    confirmLabel: "Merge records",
    tone: "warning",
  });
  if (!ok || ctx !== myCtx) return;

  btn.disabled = true;
  btn.textContent = "Merging…";
  errEl.textContent = "";
  try {
    await mergePatients({ survivor: k, duplicates: rest, details });
    myCtx.merged = true;
    dlg.close();
  } catch (err) {
    console.error("Merge failed:", err);
    errEl.textContent = err.code === "not-admin" || err.code === "permission-denied"
      ? "Only Admins can merge patients. Check your role and the Firestore rules."
      : err.code ? "Couldn't merge the records. Nothing was changed. Please try again." : err.message;
    btn.disabled = false;
    btn.innerHTML = `${I.merge}Merge records`;
  }
}