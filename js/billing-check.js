// Inventory → Billing check: scanned billing sheets (what was given) against Timely invoices (what was charged).
import { billingCheck, markBillingChecked, BC_TYPES } from "./billing-check-api.js";
import { dayKey } from "./inventory-api.js";
import { can } from "./perms.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const niceKey = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "";
};
const addDays = (k, n) => { const [y, m, d] = k.split("-").map(Number); return dayKey(new Date(y, m - 1, d + n)); };
const flagTone = (t) => (t === "bad" ? "bad" : t === "warn" ? "warn" : "info");

export function renderBillingCheck(body, { staff } = {}) {
  const canCheck = can("inventory.manage") || can("inventory.order") || can("menu.reports");
  const today = dayKey();
  const st = { from: addDays(today, -7), to: addDays(today, -1), view: "open", type: "", data: null, err: "", loading: false };
  const wrap = document.createElement("div");
  wrap.className = "bc-wrap";
  body.replaceChildren(wrap);

  async function load() {
    if (st.from > st.to) [st.from, st.to] = [st.to, st.from];
    if ((new Date(st.to) - new Date(st.from)) / 864e5 > 92) { st.err = "Choose up to 3 months at a time."; st.data = null; draw(); return; }
    st.loading = true;
    st.err = "";
    draw();
    try { st.data = await billingCheck({ fromKey: st.from, toKey: st.to }); }
    catch (err) {
      console.error("Billing check failed:", err);
      st.data = null;
      st.err = err && err.code === "permission-denied"
        ? "No access. Check the Firestore rules have been published, and your Inventory access in Staff."
        : "Couldn't load the billing check. Try again.";
    }
    st.loading = false;
    if (wrap.isConnected) draw();
  }

  function notes(d) {
    const out = [`Comparing ${niceKey(d.from)} to ${niceKey(d.to)}.`];
    if (d.from > st.from) out.push(`Invoices take stock off from ${niceKey(d.startDate)}, so earlier days aren't compared.`);
    if (d.upTo) out.push(`Invoices uploaded up to ${niceKey(d.upTo)}.`);
    if (d.waiting) out.push(`${d.waiting} billing sheet line${d.waiting === 1 ? " is" : "s are"} waiting for their invoice upload.`);
    return out.join(" ");
  }

  const rowHtml = (r) => {
    const t = BC_TYPES[r.type];
    const sheet = r.sheets.find((s) => s.photoUrl);
    const by = [...new Set(r.sheets.map((s) => s.by).filter(Boolean))];
    const meta = [
      r.staff.length && `Staff ${r.staff.join(", ")}`,
      r.invoiceIds.length && `Invoice ${r.invoiceIds.join(", ")}`,
      by.length && `Sheet scanned by ${by.join(", ")}`,
      r.sheets.length > 1 && `${r.sheets.length} sheets scanned`,
    ].filter(Boolean).join(" · ");
    return `<div class="bc-row is-${t.tone}">
      <div class="bc-main">
        <span><strong>${esc(r.patientName)}</strong> · ${esc(r.productName)}</span>
        ${meta ? `<small>${esc(meta)}</small>` : ""}
        <span><span class="inv-flag is-${flagTone(t.tone)}">${esc(t.label)}</span></span>
        ${r.check ? `<small class="bc-checked">✓ Checked by ${esc(r.check.by || "—")}: “${esc(r.check.note)}”</small>` : ""}
      </div>
      <div class="bc-nums">
        <span><small>Sheet</small><b>${r.sheets.length ? r.given : "—"}</b></span>
        <span><small>Invoice</small><b>${r.invoiced}</b></span>
      </div>
      <div class="bc-acts">
        ${sheet ? `<a class="lh-btn" href="${esc(sheet.photoUrl)}" target="_blank" rel="noopener">Sheet ↗</a>` : ""}
        ${canCheck && !r.check ? `<button type="button" class="lh-btn" data-bccheck="${esc(r.key)}">Mark checked</button>` : ""}
      </div>
    </div>`;
  };

  function draw() {
    const d = st.data;
    const items = d ? d.items : [];
    const n = (t) => items.filter((i) => i.type === t && !i.check).length;
    const rows = items.filter((i) => (st.view === "all" || (st.view === "open" ? !i.check : !!i.check)) && (!st.type || i.type === st.type));
    const days = [...new Set(rows.map((r) => r.day))];
    wrap.innerHTML = `
      <div class="inv-tools">
        <label class="bc-date">From <input type="date" class="fe-input" data-bc="from" value="${esc(st.from)}" max="${today}" /></label>
        <label class="bc-date">To <input type="date" class="fe-input" data-bc="to" value="${esc(st.to)}" max="${today}" /></label>
        <select class="fb-select" data-bc="type" aria-label="Kind">
          <option value="">Every kind</option>${Object.entries(BC_TYPES).map(([k, t]) =>
            `<option value="${k}"${st.type === k ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
        <div class="fe-seg">${[["open", "To check"], ["checked", "Checked"], ["all", "All"]].map(([v, l]) =>
          `<label class="fe-seg-btn"><input type="radio" name="bc-v" value="${v}"${st.view === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
      </div>
      ${st.loading ? '<div class="skeleton" style="height:220px;border-radius:14px"></div>'
        : st.err ? `<div class="tm-empty is-error">${esc(st.err)}</div>`
        : !d ? ""
        : !d.started ? `<div class="tm-empty">Invoices don't take stock off yet, so there's nothing to compare.
            Set the start date in Inventory → Products → Invoice links.</div>`
        : `<div class="inv-stats">
            ${["given", "qty", "invoiced", "nosheet"].map((t) => `<div class="inv-stat${n(t) ? (BC_TYPES[t].tone === "bad" ? " is-bad" : " is-warn") : ""}">
              <strong>${n(t)}</strong><span>${esc(BC_TYPES[t].label)}</span></div>`).join("")}
            <div class="inv-stat"><strong>${d.okCount}</strong><span>Matched</span></div>
          </div>
          <p class="muted rp-range">${esc(notes(d))}</p>
          ${rows.length ? days.map((day) => {
            const list = rows.filter((r) => r.day === day);
            return `<section class="inv-group"><h3>${esc(niceKey(day))}<em>${list.length}</em></h3>
              <div class="bc-list">${list.map(rowHtml).join("")}</div></section>`;
          }).join("") : `<div class="tm-empty">${st.view === "open" ? "Nothing to check. Every sheet matches its invoice. 👍" : "Nothing here."}</div>`}`}`;
  }

  function checkDialog(item) {
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Mark as checked</h3>
        <p>${esc(item.patientName)} · ${esc(item.productName)} · ${esc(niceKey(item.day))}.
          Billing sheet: ${item.sheets.length ? item.given : "none"} · Invoice: ${item.invoiced}.</p></div>
      <p class="inv-hint">${esc(BC_TYPES[item.type].help)}</p>
      <label class="lh-field"><span class="lh-label">What you found</span>
        <textarea name="note" rows="3" maxlength="500" placeholder="e.g. Given as a sample, no charge · Added to the invoice in Timely"></textarea></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button>
      </div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const note = form.elements.note.value.trim();
      if (!note) { err.textContent = "Add a note saying what you found."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await markBillingChecked(item, note, staff);
        item.check = { by: (staff && staff.name) || "", note };
        dlg.close();
        showToast("Marked as checked");
        draw();
      } catch (ex) {
        console.error("Mark checked failed:", ex);
        err.textContent = ex && ex.code === "permission-denied"
          ? "Couldn't save. It may already have been checked by someone else. Reload to see it."
          : (ex && ex.message) || "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.elements.note.focus();
  }

  wrap.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "bc-v") { st.view = t.value; draw(); return; }
    const k = t.dataset.bc;
    if (k === "type") { st.type = t.value; draw(); return; }
    if ((k === "from" || k === "to") && /^\d{4}-\d{2}-\d{2}$/.test(t.value)) { st[k] = t.value; load(); }
  });
  wrap.addEventListener("click", (e) => {
    const b = e.target.closest("[data-bccheck]");
    if (!b || !st.data) return;
    const item = st.data.items.find((i) => i.key === b.dataset.bccheck);
    if (item) checkDialog(item);
  });

  load();
}