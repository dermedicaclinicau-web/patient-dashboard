// Task Manager → Marketing: the do-not-contact list (campaigns come next).
// Every patient can receive marketing emails unless they're on this list.
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { mountTemplateList } from "./mkt-templates.js";
import { mountCampaignList } from "./mkt-campaigns.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL_RE = /[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+/g;
const REASONS = ["Asked not to be contacted", "Opted out", "Complained", "Other"];
const WHY = { unsubscribed: "Unsubscribed from an email", dnc: "Added by staff", bounced: "Email bounced" };
const day = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};
const born = (key) => (key ? day(`${key}T12:00:00`) : "");
const num = (n) => Number(n || 0).toLocaleString("en-AU");
const errText = (err) => (err && err.code === "FORBIDDEN"
  ? "You don't have access to Marketing. An admin can turn it on in Staff → Roles & access."
  : (err && err.message) || "Something went wrong. Try again.");

function openDialog(html) {
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog mk-dlg";
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

const MK_HEAD = `
    <div class="tb-head">
      <div>
        <h3 class="tm-h">Marketing</h3>
        <p class="muted tm-sub">Every patient can receive marketing emails unless they're on the do-not-contact list.
          Emails about appointments and treatments always go out.</p>
      </div>
    </div>`;
const mkTabs = (on) => `<nav class="mk-tabs" aria-label="Marketing">${[
  ["dnc", "#/tasks/marketing", "Do not contact"],
  ["templates", "#/tasks/marketing/templates", "Email templates"],
  ["campaigns", "#/tasks/marketing/campaigns", "Campaigns"],
].map(([k, href, label]) => `<a href="${href}"${k === on ? ' class="is-on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;

export function mountMarketing(main, { sub = "", staff = null } = {}) {
  if (sub === "templates") {
    main.innerHTML = `${MK_HEAD}${mkTabs("templates")}<div data-role="tpl"></div>`;
    mountTemplateList(main.querySelector('[data-role="tpl"]'), { staff });
    return;
  }
  if (sub === "campaigns") {
    main.innerHTML = `${MK_HEAD}${mkTabs("campaigns")}<div data-role="camp"></div>`;
    mountCampaignList(main.querySelector('[data-role="camp"]'), { staff });
    return;
  }
  main.innerHTML = `
    ${MK_HEAD}${mkTabs("dnc")}
    <section class="tb-card mk-card">
      <div class="mk-head">
        <h4>Do not contact <em class="mk-n" data-role="n"></em></h4>
        <div class="mk-acts">
          <button type="button" class="ff-btn" data-act="add-emails">+ Paste email addresses</button>
          <button type="button" class="ff-btn is-primary" data-act="add">+ Add a patient</button>
        </div>
      </div>
      <div class="mk-tools">
        <input type="search" class="fe-input" data-role="q" placeholder="Search names or email addresses" aria-label="Search" />
        <select class="fb-select" data-role="why" aria-label="Why">
          <option value="">Every reason</option>
          ${Object.entries(WHY).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}
        </select>
      </div>
      <div data-role="list"><div class="skeleton" style="height:160px;border-radius:12px"></div></div>
    </section>`;


  const listEl = main.querySelector('[data-role="list"]');
  const nEl = main.querySelector('[data-role="n"]');
  const qEl = main.querySelector('[data-role="q"]');
  const whyEl = main.querySelector('[data-role="why"]');
  let rows = [];

  async function load() {
    try {
      const res = await callApi({ action: "marketing", op: "list" });
      rows = res.rows || [];
      draw();
    } catch (err) {
      console.error("Do not contact list failed:", err);
      listEl.innerHTML = `<div class="tm-empty is-error">${esc(errText(err))}</div>`;
    }
  }

  function draw() {
    if (!main.isConnected) return;
    nEl.textContent = rows.length ? num(rows.length) : "";
    const q = qEl.value.trim().toLowerCase();
    const why = whyEl.value;
    const shown = rows.filter((r) => (!why || r.reason === why)
      && (!q || `${r.name} ${r.email}`.toLowerCase().includes(q)));
    if (!rows.length) {
      listEl.innerHTML = '<div class="tm-empty">Nobody is on the list. Everyone in the Patient List can receive marketing emails.</div>';
      return;
    }
    if (!shown.length) { listEl.innerHTML = '<div class="tm-empty">Nobody matches.</div>'; return; }
    listEl.innerHTML = `
      <div class="mk-scroll"><table class="inv-table mk-table">
        <thead><tr><th>Patient</th><th>Email</th><th>Why</th><th>When</th><th></th></tr></thead>
        <tbody>${shown.slice(0, 500).map((r) => `
          <tr>
            <td>${r.patientId ? `<a href="#/patient/${encodeURIComponent(r.patientId)}">${esc(r.name || "Patient")}</a>` : '<span class="muted">Not matched to a patient</span>'}</td>
            <td>${esc(r.email || "No email on file")}</td>
            <td><span class="mk-why is-${esc(r.reason)}">${esc(WHY[r.reason] || r.reason)}</span>
              ${r.why || r.note ? `<small>${esc([r.why, r.note].filter((x, i, a) => x && a.indexOf(x) === i).join(" · "))}</small>` : ""}</td>
            <td>${esc(day(r.at))}${r.by ? `<small>${esc(r.by)}</small>` : ""}</td>
            <td class="mk-act">${r.reason === "bounced"
              ? '<small class="muted">Update their email to remove</small>'
              : `<button type="button" class="lh-btn" data-remove="${esc(r.key)}">Remove</button>`}</td>
          </tr>`).join("")}</tbody></table></div>
      ${shown.length > 500 ? `<p class="muted">Showing 500 of ${num(shown.length)}. Search to narrow it down.</p>` : ""}`;
  }

  /* ---------- Add a patient ---------- */
  function addPatient() {
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Add to do not contact</h3>
          <p>They won't receive any marketing emails. Appointment and treatment emails still go out.</p></div>
        <label class="lh-field"><span class="lh-label">Patient</span>
          <input type="search" class="fe-input" data-role="q" placeholder="Search by name" autocomplete="off" /></label>
        <div class="mk-hits" data-role="hits"></div>
        <p class="mk-picked" data-role="picked" hidden></p>
        <label class="lh-field"><span class="lh-label">Why</span>
          <select class="fb-select" name="why">${REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
        <label class="lh-field"><span class="lh-label">Note (optional)</span>
          <input name="note" maxlength="300" placeholder="e.g. Rang reception on 19 Oct" /></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary" disabled>Add to the list</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const q = dlg.querySelector('[data-role="q"]');
    const hits = dlg.querySelector('[data-role="hits"]');
    const picked = dlg.querySelector('[data-role="picked"]');
    const err = dlg.querySelector(".lh-error");
    const btn = form.querySelector('[type="submit"]');
    let chosen = null;
    let timer = 0;
    let asked = "";

    const search = async (text) => {
      asked = text;
      if (text.length < 2) { hits.innerHTML = ""; return; }
      hits.innerHTML = '<p class="muted">Searching…</p>';
      try {
        const res = await callApi({ action: "marketing", op: "search", q: text });
        if (asked !== text) return;
        const list = res.results || [];
        hits.innerHTML = list.length ? list.map((r) => `
          <button type="button" class="du-fixhit" data-id="${esc(r.id)}" data-label="${esc(r.name)}">
            <strong>${esc(r.name)}</strong>
            <small>ID ${esc(r.id)}${r.dob ? ` · born ${esc(born(r.dob))}` : ""}${r.mobile ? ` · ${esc(r.mobile)}` : ""}</small>
          </button>`).join("") : '<p class="muted">No patients found.</p>';
      } catch (e) { hits.innerHTML = `<p class="du-warn">${esc(errText(e))}</p>`; }
    };
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(q.value.trim()), 300); });
    hits.addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (!b) return;
      chosen = { id: b.dataset.id, name: b.dataset.label };
      picked.innerHTML = `✓ <strong>${esc(chosen.name)}</strong> <small class="muted">ID ${esc(chosen.id)}</small>`;
      picked.hidden = false;
      hits.innerHTML = "";
      btn.disabled = false;
    });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!chosen) return;
      err.hidden = true;
      btn.disabled = true;
      try {
        const res = await callApi({ action: "marketing", op: "block", patientId: chosen.id,
          why: form.elements.why.value, note: form.elements.note.value });
        dlg.close();
        showToast(res.noEmail ? `${chosen.name} added. They have no email address on file anyway.` : `${chosen.name} added to do not contact`);
        load();
      } catch (ex) {
        err.textContent = errText(ex);
        err.hidden = false;
        btn.disabled = false;
      }
    });
    q.focus();
  }

  /* ---------- Paste email addresses ---------- */
  function addEmails() {
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Paste email addresses</h3>
          <p>Paste a list from anywhere (a spreadsheet column, an old opt-out list). Each address goes on the list,
            and any patient with that address is turned off too.</p></div>
        <label class="lh-field"><span class="lh-label">Email addresses</span>
          <textarea name="list" rows="8" placeholder="jane@example.com&#10;sam@example.com"></textarea></label>
        <p class="muted" data-role="count">No addresses yet.</p>
        <label class="lh-field"><span class="lh-label">Why</span>
          <select class="fb-select" name="why">${REASONS.map((r) => `<option${r === "Opted out" ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary" disabled>Add to the list</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const cnt = dlg.querySelector('[data-role="count"]');
    const err = dlg.querySelector(".lh-error");
    const btn = form.querySelector('[type="submit"]');
    const found = () => [...new Set((form.elements.list.value.match(EMAIL_RE) || []).map((x) => x.toLowerCase()))];
    form.elements.list.addEventListener("input", () => {
      const n = found().length;
      cnt.textContent = n ? `${num(n)} address${n === 1 ? "" : "es"} found.` : "No addresses yet.";
      btn.disabled = !n;
      btn.textContent = n ? `Add ${num(n)} to the list` : "Add to the list";
    });
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const emails = found();
      if (!emails.length) return;
      if (emails.length > 1000) { err.textContent = "Paste up to 1,000 at a time."; err.hidden = false; return; }
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = "Adding…";
      try {
        const res = await callApi({ action: "marketing", op: "blockMany", emails, why: form.elements.why.value });
        dlg.close();
        showToast(`${num(res.added)} added · ${num(res.matched)} matched to patients`);
        load();
      } catch (ex) {
        err.textContent = errText(ex);
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = `Add ${num(emails.length)} to the list`;
      }
    });
    form.elements.list.focus();
  }

  /* ---------- Remove ---------- */
  function remove(r) {
    const dlg = openDialog(`
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Remove from do not contact?</h3>
          <p>${esc(r.name || r.email)} will receive marketing emails again.
            ${r.reason === "unsubscribed" ? "<strong>They unsubscribed themselves</strong>, so only do this if they've asked to be added back." : ""}</p></div>
        <label class="lh-field"><span class="lh-label">Why can they be contacted again?</span>
          <input name="note" maxlength="300" placeholder="e.g. Asked to rejoin at reception" /></label>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Remove from the list</button>
        </div>
      </form>`);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const note = form.elements.note.value.trim();
      if (!note) { err.textContent = "Add a note saying why."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const res = await callApi({ action: "marketing", op: "unblock", patientId: r.patientId, email: r.email, note });
        if (res.problem) throw new Error(res.problem);
        dlg.close();
        showToast("Removed from do not contact");
        load();
      } catch (ex) {
        err.textContent = errText(ex);
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.elements.note.focus();
  }

  main.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="add"]')) { addPatient(); return; }
    if (e.target.closest('[data-act="add-emails"]')) { addEmails(); return; }
    const rm = e.target.closest("[data-remove]");
    if (rm) { const r = rows.find((x) => x.key === rm.dataset.remove); if (r) remove(r); }
  });
  qEl.addEventListener("input", draw);
  whyEl.addEventListener("change", draw);
  load();
}