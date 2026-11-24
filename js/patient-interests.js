// Treatment Interested In (patient page): quotes read from billing sheets by the Scan Inbox, and ones added by hand.
// Stored in scan_followups (type "quote"). Staff read and update them here directly (Firestore rules);
// Apps Script makes the ones from billing sheets and closes them when the treatment shows up in the calendar.
import { db, auth } from "./firebase-config.js";
import {
  collection, query, where, getDocs, doc, setDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { patientIds } from "./patients.js";
import { escapeHtml as esc, showToast } from "./utils.js";
import { can } from "./perms.js";

const COL = "scan_followups";
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  tag: svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  ext: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
};
const pad = (n) => String(n).padStart(2, "0");
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDay = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const dayOf = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const money = (s) => esc(s).replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g, (m) => `<b>${m}</b>`);
const randId = () => { const a = new Uint8Array(20); crypto.getRandomValues(a); return [...a].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); };

// The "Treatment Interested In" card already on the page (drawn by billing-rx-view.js), or a new one
function findCard(root) {
  // The card drawn by billing-rx-view.js: the count goes in its badge, the list in .pi-host
  const host = root.querySelector(".bp-interest .pi-host");
  if (host) {
    const card = host.closest("details");
    return { card, hint: card.querySelector(".pi-count"), body: host, badge: true };
  }
  const sum = [...root.querySelectorAll("details > summary")].find((s) => /treatment\s+interested\s+in/i.test(s.textContent || ""));
  let card = sum ? sum.parentElement : null;
  if (!card) {
    card = document.createElement("details");
    card.className = "sub-card pi-own";
    card.dataset.key = "interests";
    card.innerHTML = `<summary><span class="sum-left"><span class="sum-icon">${IC.tag}</span><span class="sum-label">Treatment Interested In</span>
      <span class="hint">…</span></span><span class="sum-right"><button type="button" class="sum-action">+ Add</button>
      <svg class="sum-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></span></summary>
      <div class="sub-body"></div>`;
    root.insertBefore(card, root.querySelector(".patient-dialog"));
  }
  const summary = card.querySelector(":scope > summary");
  // No more "Soon": the placeholder's labels go, and its button becomes + Add
  summary.querySelectorAll("*").forEach((el) => {
    if (!el.children.length && /^(coming\s+)?soon$/i.test((el.textContent || "").trim())) el.remove();
  });
  card.querySelectorAll("[data-soon]").forEach((el) => {
    el.removeAttribute("data-soon");
    if (summary.contains(el)) { el.dataset.pi = "add"; el.textContent = "+ Add"; }
  });
  let hint = summary.querySelector(".hint");
  if (!hint) {
    hint = document.createElement("span");
    hint.className = "hint";
    (summary.querySelector(".sum-left") || summary).appendChild(hint);
  }
  hint.hidden = false;
  let body = card.querySelector(":scope > .sub-body");
  if (!body) {
    [...card.children].forEach((el) => { if (el !== summary) el.remove(); });
    body = document.createElement("div");
    body.className = "sub-body";
    card.appendChild(body);
  }
  const add = summary.querySelector('[data-pi="add"], .sum-action');
  if (add) add.dataset.pi = "add";
  return { card, hint, body };
}

export function mountPatientInterests(root, patient, staff) {
  injectStyles();
  const { card, hint, body, badge } = findCard(root);
  const canEdit = can("menu.patients");
  const ids = [...new Set([patient.id, ...patientIds(patient)].filter(Boolean))].slice(0, 30);
  const st = { items: null, adding: false, editing: "", busy: "", error: "" };

  async function load() {
    try {
      const snap = await getDocs(query(collection(db, COL), where("patientId", "in", ids), where("type", "==", "quote")));
      st.items = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((q) => q.status !== "cancelled")
        .sort((a, b) => String(b.sheetDate || "").localeCompare(String(a.sheetDate || "")));
      st.error = "";
    } catch (err) {
      console.error("Treatment Interested In not loaded:", err);
      st.items = st.items || [];
      st.error = err && err.code === "permission-denied" ? "The Firestore rules don't allow this yet. Ask an Admin." : "Couldn't load. Refresh to try again.";
    }
    if (card.isConnected) render();
  }

  function sourceLine(q) {
    if (q.status === "booked") {
      return q.foundBy === "calendar" ? `Found in the calendar${q.bookedFor ? ` · ${esc(fmtDay(q.bookedFor))}` : ""}`
        : `Booked${q.closedBy ? ` · ${esc(q.closedBy)}` : ""}${q.closedAt ? ` · ${esc(fmtDay(dayOf(q.closedAt)))}` : ""}`;
    }
    if (q.status === "notneeded") return `Not going ahead${q.closedBy ? ` · ${esc(q.closedBy)}` : ""}${q.closedAt ? ` · ${esc(fmtDay(dayOf(q.closedAt)))}` : ""}`;
    if (q.source === "manual") return `Added by ${esc(q.createdBy || "staff")} · ${esc(fmtDay(q.sheetDate))}`;
    return `From the billing sheet on ${esc(fmtDay(q.sheetDate))}${q.scanId
      ? ` · <a href="https://drive.google.com/file/d/${encodeURIComponent(q.scanId)}/view" target="_blank" rel="noopener">See the sheet${IC.ext}</a>` : ""}`;
  }
  const formHtml = (q) => `<div class="pi-form" data-form="${q ? esc(q.id) : "new"}">
      <label class="pi-f"><span>What they're interested in</span><input data-in="text" maxlength="300" value="${esc(q ? q.text : "")}" placeholder="e.g. Back fat, muffin top, inner thighs"></label>
      <label class="pi-f"><span>Quote <em>optional</em></span><input data-in="price" maxlength="150" value="${esc(q ? q.price : "")}" placeholder="e.g. TS Flex ×4 = $1,595"></label>
      <div class="pi-form-acts"><button type="button" class="btn-ghost sm" data-pi="cancel">Cancel</button>
        <button type="button" class="btn-primary sm" data-pi="${q ? "save" : "create"}" ${st.busy ? "disabled" : ""}>${st.busy ? "Saving…" : "Save"}</button></div>
    </div>`;
  function rowHtml(q) {
    if (st.editing === q.id) return `<li class="pi-item is-editing">${formHtml(q)}</li>`;
    const open = q.status === "info";
    const busy = st.busy === q.id;
    return `<li class="pi-item ${open ? "" : "is-closed"}">
      <span class="pi-ic">${IC.tag}</span>
      <div class="pi-main">
        <strong>${esc(q.text || "Treatment")}</strong>
        ${q.price ? `<span class="pi-price">${money(q.price)}</span>` : ""}
        <small>${sourceLine(q)}</small>
      </div>
      ${canEdit ? `<div class="pi-acts">${open
        ? `<button type="button" class="pi-btn is-pri" data-pi="booked" data-id="${esc(q.id)}" ${busy ? "disabled" : ""}>Booked</button>
           <button type="button" class="pi-btn" data-pi="notneeded" data-id="${esc(q.id)}" ${busy ? "disabled" : ""}>Not going ahead</button>
           <button type="button" class="pi-icon" data-pi="edit" data-id="${esc(q.id)}" aria-label="Change it" title="Change it">${IC.edit}</button>`
        : `<span class="pi-pill ${q.status === "booked" ? "is-ok" : ""}">${q.status === "booked" ? "Booked" : "Not going ahead"}</span>
           ${q.foundBy === "calendar" ? "" : `<button type="button" class="pi-link" data-pi="reopen" data-id="${esc(q.id)}">Reopen</button>`}`}</div>` : ""}
    </li>`;
  }
  function render() {
    const items = st.items || [];
    const open = items.filter((q) => q.status === "info");
    const done = items.filter((q) => q.status !== "info");
    hint.textContent = badge ? (st.items === null ? "–" : String(open.length))
      : st.items === null ? "…" : open.length ? `${open.length} interested` : items.length ? "None open" : "None yet";
    card.classList.toggle("is-empty", !items.length);
    card.classList.toggle("has-items", open.length > 0);
    body.innerHTML = st.items === null ? '<div class="skeleton xs"></div>' : `<div class="pi">
      ${st.error ? `<p class="empty-note error">${esc(st.error)}</p>` : ""}
      ${st.adding ? formHtml(null) : ""}
      ${open.length ? `<ul class="pi-list">${open.map(rowHtml).join("")}</ul>`
        : st.adding || st.error ? "" : '<p class="empty-note">Nothing recorded yet. Quotes written on billing sheets show up here by themselves.</p>'}
      ${done.length ? `<details class="pi-done"><summary>Booked or not going ahead · ${done.length}</summary>
        <ul class="pi-list">${done.map(rowHtml).join("")}</ul></details>` : ""}
      ${canEdit && !st.adding ? '<button type="button" class="pi-add" data-pi="add">+ Add what they\'re interested in</button>' : ""}
    </div>`;
    const first = body.querySelector('[data-form] [data-in="text"]');
    if (first && (st.adding || st.editing)) first.focus();
  }

  const who = () => String((staff && staff.name) || "Staff");
  const uid = () => (auth.currentUser ? auth.currentUser.uid : "");
  const logWith = (q, what) => [...(Array.isArray(q.log) ? q.log : []), { at: new Date().toISOString(), by: who(), what, note: "" }].slice(-29);

  async function save(fn, id, done) {
    st.busy = id || "new";
    render();
    try { await fn(); showToast(done); st.adding = false; st.editing = ""; }
    catch (err) {
      console.error("Treatment Interested In not saved:", err);
      showToast(err && err.code === "permission-denied" ? "You can't change this. Ask an Admin." : "That didn't save. Try again.");
    }
    st.busy = "";
    await load();
  }
  const readForm = () => {
    const f = body.querySelector("[data-form]");
    return { text: f.querySelector('[data-in="text"]').value.replace(/\s+/g, " ").trim(), price: f.querySelector('[data-in="price"]').value.replace(/\s+/g, " ").trim() };
  };

  card.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pi]");
    if (!b || !card.contains(b) || st.busy) return;
    e.preventDefault();
    const act = b.dataset.pi;
    const q = (st.items || []).find((x) => x.id === b.dataset.id);
    if (act === "add") { if (!canEdit) return; card.open = true; st.adding = true; st.editing = ""; render(); }
    else if (act === "cancel") { st.adding = false; st.editing = ""; render(); }
    else if (act === "edit" && q) { st.editing = q.id; st.adding = false; render(); }
    else if (act === "create") {
      const v = readForm();
      if (!v.text) { showToast("Say what they're interested in."); return; }
      save(() => setDoc(doc(db, COL, `fu_manual_${randId()}`), {
        type: "quote", source: "manual", scanId: "", patientId: patient.id, patientName: String(patient.name || ""),
        sheetDate: todayKey(), text: v.text, price: v.price, status: "info",
        createdAt: new Date().toISOString(), createdBy: who(), createdByUid: uid(),
        log: [{ at: new Date().toISOString(), by: who(), what: "Added on the patient page", note: "" }],
      }), "", "Added");
    }
    else if (act === "save" && q) {
      const v = readForm();
      if (!v.text) { showToast("Say what they're interested in."); return; }
      save(() => updateDoc(doc(db, COL, q.id), { text: v.text, price: v.price, log: logWith(q, "Changed") }), q.id, "Saved");
    }
    else if ((act === "booked" || act === "notneeded") && q) {
      save(() => updateDoc(doc(db, COL, q.id), { status: act, closedAt: new Date().toISOString(), closedBy: who(), closedByUid: uid(),
        foundBy: "", bookedFor: "", log: logWith(q, act === "booked" ? "Booked" : "Not going ahead") }), q.id,
        act === "booked" ? "Marked as booked" : "Marked as not going ahead");
    }
    else if (act === "reopen" && q) {
      save(() => updateDoc(doc(db, COL, q.id), { status: "info", closedAt: "", closedBy: "", closedByUid: "", foundBy: "", bookedFor: "",
        log: logWith(q, "Reopened") }), q.id, "Back on the list");
    }
  });
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.closest("[data-form] input")) return;
    e.preventDefault();
    body.querySelector('[data-form] [data-pi="create"], [data-form] [data-pi="save"]')?.click();
  });

  render();
  load();
  return { reload: load };
}

function injectStyles() {
  if (document.getElementById("pi-styles-1")) return;
  const s = document.createElement("style");
  s.id = "pi-styles-1";
  s.textContent = `
.pi{display:flex;flex-direction:column;gap:10px}
.pi-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.pi-item{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 14px;border:1px solid #e2e8f0;border-radius:14px;background:#fff}
.pi-item.is-closed{background:#f8fafc}
.pi-item.is-closed strong{color:#64748b}
.pi-item.is-editing{display:block}
.pi-ic{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#fdf4ff;color:#a21caf}
.pi-item.is-closed .pi-ic{background:#f1f5f9;color:#94a3b8}
.pi-ic svg{width:17px;height:17px}
.pi-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.pi-main strong{font-size:14.5px;color:#0f172a;font-weight:600;line-height:1.35}
.pi-price{font-size:13.5px;color:#334155}
.pi-price b{color:#0f766e;font-weight:700}
.pi-main small{font-size:12.5px;color:#64748b}
.pi-main small a{display:inline-flex;align-items:center;gap:3px;color:#0f766e;font-weight:600;text-decoration:none}
.pi-main small a svg{width:12px;height:12px}
.pi-acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.pi-btn{height:34px;padding:0 12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;font:inherit;font-size:13px;font-weight:600;color:#334155;cursor:pointer;white-space:nowrap}
.pi-btn:hover:not(:disabled){border-color:#14b8a6;color:#0f766e}
.pi-btn.is-pri{background:#0f766e;border-color:#0f766e;color:#fff}
.pi-btn.is-pri:hover:not(:disabled){background:#115e59;color:#fff}
.pi-btn:disabled{opacity:.55;cursor:progress}
.pi-icon{width:34px;height:34px;display:grid;place-items:center;border:1px solid #e2e8f0;border-radius:10px;background:#fff;color:#64748b;cursor:pointer}
.pi-icon:hover{color:#0f766e;border-color:#14b8a6}
.pi-icon svg{width:15px;height:15px}
.pi-pill{font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;background:#f1f5f9;color:#64748b;white-space:nowrap}
.pi-pill.is-ok{background:#ecfdf5;color:#047857}
.pi-link{border:0;background:none;padding:4px;color:#0f766e;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.pi-add{align-self:flex-start;padding:9px 14px;border:1.5px dashed #99f6e4;border-radius:12px;background:#f0fdfa;color:#0f766e;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer}
.pi-add:hover{border-color:#14b8a6}
.pi-form{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:10px;padding:12px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0}
.pi-f{display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:600;color:#475569;min-width:0}
.pi-f em{font-style:normal;font-weight:400;color:#94a3b8}
.pi-f input{height:40px;padding:0 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;font:inherit;font-size:14px;color:#0f172a;min-width:0}
.pi-f input:focus{outline:none;border-color:#14b8a6;box-shadow:0 0 0 3px rgba(20,184,166,.15)}
.pi-form-acts{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px}
.pi-done summary{cursor:pointer;font-size:13px;font-weight:600;color:#64748b;padding:4px 2px;list-style:none}
.pi-done summary::-webkit-details-marker{display:none}
.pi-done summary::before{content:"▸ "}
.pi-done[open] summary::before{content:"▾ "}
.pi-done[open] summary{margin-bottom:8px}
@media (max-width:640px){.pi-item{grid-template-columns:30px minmax(0,1fr)}.pi-acts{grid-column:1/-1;justify-content:flex-start}
  .pi-form{grid-template-columns:1fr}.pi-f input{font-size:16px}}`;
  document.head.appendChild(s);
}