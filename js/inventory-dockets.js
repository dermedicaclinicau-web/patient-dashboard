// Inventory → Dockets: delivery dockets the Scan Inbox has kept (any scan kind with "Show in Inventory" on).
// Read only. Sorting happens in the Scan Inbox; the files stay in Google Drive → Other scans → [kind].
// Apps Script: action "scanInbox", ops "dockets", "docketFile" and "docketThumbs" (ScanInbox.gs).
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = (op, body = {}) => callApi({ action: "scanInbox", op, ...body });
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const keyDate = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const niceDate = (k) => (KEY_RE.test(k || "") ? keyDate(k).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const monthName = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString("en-AU", { month: "long", year: "numeric" }); };
const dayOf = (d) => (KEY_RE.test(d.date) ? d.date : d.createdKey || "");   // the date on the docket, else the day it was scanned
const keptText = (d) => (!d.keptBy ? "" : d.keptBy === "Scan Inbox" ? "kept by itself" : `kept by ${d.keptBy}`);
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';

export async function renderDockets(body, { canScanInbox = false } = {}) {
  injectCss();
  const box = document.createElement("div");
  box.className = "dk";
  box.innerHTML = '<div class="skeleton" style="height:280px;border-radius:14px"></div>';
  body.replaceChildren(box);
  const st = { data: null, err: "", q: "", month: "", kind: "" };
  const thumbs = new Map();
  let thumbBusy = false;

  async function load() {
    try {
      const res = await api("dockets");
      if (!box.isConnected) return;
      if (res && res.problem) st.err = res.problem;
      else { st.data = res; st.err = ""; }
    } catch (err) {
      console.error("Dockets not loaded:", err);
      if (!box.isConnected) return;
      st.err = /FORBIDDEN/.test(String((err && err.message) || err))
        ? "Ask an Admin to check your Inventory access in Staff." : "Couldn't load the dockets. Check your connection and try again.";
    }
    draw();
  }

  const all = () => (st.data && st.data.dockets) || [];
  const kinds = () => (st.data && st.data.kinds) || [];
  const shown = () => {
    const q = st.q.trim().toLowerCase();
    return all().filter((d) => (!st.month || dayOf(d).startsWith(st.month)) && (!st.kind || d.kind === st.kind)
      && (!q || `${d.supplier} ${d.docNo} ${d.title} ${d.notes} ${d.kindName}`.toLowerCase().includes(q)));
  };

  function rowHtml(d) {
    const t = thumbs.get(d.id);
    const sub = [d.docNo && `No. ${d.docNo}`, d.supplier && d.title && d.title !== d.supplier ? d.title : "",
      kinds().length > 1 ? d.kindName : "", keptText(d)].filter(Boolean);
    return `<button type="button" class="dk-row" data-dk-open="${esc(d.id)}">
      <span class="dk-th" data-dk-thumb="${esc(d.id)}">${t ? `<img alt="" src="${esc(t)}">` : DOC}</span>
      <span class="dk-date">${esc(niceDate(dayOf(d)))}${d.date ? "" : "<small>scanned</small>"}</span>
      <span class="dk-main"><strong>${esc(d.supplier || d.title || d.kindName)}</strong><small>${esc(sub.join(" · "))}</small></span>
      <span class="dk-go">View</span></button>`;
  }

  function drawList() {
    const el = box.querySelector('[data-dk-role="list"]');
    if (!el) return;
    const list = shown();
    box.querySelector('[data-dk-role="count"]').textContent = `${list.length} of ${all().length}`;
    el.innerHTML = list.length ? `<div class="dk-list">${list.map(rowHtml).join("")}</div>`
      : `<div class="tm-empty">${all().length ? "No dockets match." : "No dockets kept yet. They show here once the Scan Inbox keeps one."}</div>`;
    loadThumbs();
  }

  function draw() {
    if (!box.isConnected) return;
    if (st.err && !st.data) { box.innerHTML = `<div class="tm-empty is-error">${esc(st.err)}</div>`; return; }
    if (!kinds().length) {
      box.innerHTML = `<div class="tm-empty"><strong>No dockets here yet.</strong><br>In the Scan Inbox, keep delivery dockets as their own kind of scan.
        Then an Admin turns on <strong>Show in Inventory → Dockets</strong> for that kind in Scan Inbox → Settings.</div>`;
      return;
    }
    const months = [...new Set(all().map((d) => dayOf(d).slice(0, 7)).filter(Boolean))].sort().reverse();
    const waiting = (st.data && st.data.waiting) || 0;
    box.innerHTML = `
      ${waiting ? `<div class="dk-wait"><span><strong>${waiting}</strong> ${waiting === 1 ? "docket is" : "dockets are"} waiting in the Scan Inbox to be checked.</span>
        ${canScanInbox ? '<a href="#/scan-inbox/all">Open the Scan Inbox</a>' : "<span>They show here once someone keeps them.</span>"}</div>` : ""}
      <div class="inv-tools">
        <label class="ib-search inv-find">${SEARCH}<input type="search" data-dk-f="q" placeholder="Search supplier or docket number" value="${esc(st.q)}" aria-label="Search dockets" /></label>
        <select class="fb-select" data-dk-f="month" aria-label="Month"><option value="">Any month</option>${months.map((m) =>
          `<option value="${m}"${m === st.month ? " selected" : ""}>${esc(monthName(m))}</option>`).join("")}</select>
        ${kinds().length > 1 ? `<select class="fb-select" data-dk-f="kind" aria-label="Kind"><option value="">All kinds</option>${kinds().map((k) =>
          `<option value="${esc(k.id)}"${k.id === st.kind ? " selected" : ""}>${esc(k.name)}</option>`).join("")}</select>` : ""}
        <span class="inv-spacer"></span>
        <span class="muted" data-dk-role="count"></span>
      </div>
      <div data-dk-role="list"></div>`;
    drawList();
  }

  async function loadThumbs() {
    if (thumbBusy || !box.isConnected) return;
    const want = [...box.querySelectorAll("[data-dk-thumb]")].map((e) => e.dataset.dkThumb).filter((id) => !thumbs.has(id)).slice(0, 12);
    if (!want.length) return;
    thumbBusy = true;
    want.forEach((id) => thumbs.set(id, ""));
    try {
      const res = await api("docketThumbs", { ids: want });
      Object.entries((res && res.thumbs) || {}).forEach(([id, u]) => thumbs.set(id, u || ""));
    } catch (err) { console.warn("Docket pictures not loaded:", err); }
    thumbBusy = false;
    box.querySelectorAll("[data-dk-thumb]").forEach((el) => {
      const u = thumbs.get(el.dataset.dkThumb);
      if (u && !el.querySelector("img")) el.innerHTML = `<img alt="" src="${esc(u)}">`;
    });
    loadThumbs();
  }

  async function openDocket(id) {
    const d = all().find((x) => x.id === id);
    if (!d) return;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog dk-dlg";
    dlg.setAttribute("aria-label", "Docket");
    dlg.innerHTML = `<div class="dk-dlg-h">
        <div><h3>${esc(d.supplier || d.title || d.kindName)}</h3>
          <p>${esc([d.docNo && `No. ${d.docNo}`, d.date && `Dated ${niceDate(d.date)}`, d.createdKey && `Scanned ${niceDate(d.createdKey)}`, keptText(d)]
            .filter(Boolean).join(" · "))}</p></div>
        <div class="dk-dlg-acts">${d.link ? `<a class="lh-btn" href="${esc(d.link)}" target="_blank" rel="noopener">Open in Drive</a>` : ""}
          <button type="button" class="ib-tool" data-dk-x aria-label="Close" title="Close">×</button></div></div>
      <div class="dk-view" data-dk-role="view"><span class="dk-spin"></span></div>
      ${d.notes ? `<p class="dk-notes">${esc(d.notes)}</p>` : ""}`;
    document.body.appendChild(dlg);
    let url = "";
    const close = () => { if (url) URL.revokeObjectURL(url); if (dlg.open) dlg.close(); dlg.remove(); };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    dlg.addEventListener("click", (e) => { if (e.target.closest("[data-dk-x]")) close(); });
    dlg.showModal();
    const view = dlg.querySelector('[data-dk-role="view"]');
    try {
      const res = await api("docketFile", { fileId: id });
      if (!dlg.isConnected) return;
      if (!res || res.problem || !res.data) { view.innerHTML = `<p class="dk-msg">${esc((res && res.problem) || "The docket couldn't be shown.")}</p>`; return; }
      const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: res.mime }));
      view.innerHTML = res.mime === "application/pdf" ? `<iframe title="Docket" src="${url}#view=FitH"></iframe>`
        : /heic|heif/i.test(res.mime) ? '<p class="dk-msg">This photo type can\'t be shown here. Open it in Drive.</p>'
        : `<img alt="The docket" src="${url}" title="Tap to zoom">`;
      const img = view.querySelector("img");
      if (img) img.addEventListener("click", () => view.classList.toggle("is-zoom"));
    } catch (err) {
      console.error("Docket not shown:", err);
      if (dlg.isConnected) view.innerHTML = '<p class="dk-msg">The docket couldn\'t be shown. Check your connection.</p>';
    }
  }

  box.addEventListener("click", (e) => {
    const o = e.target.closest("[data-dk-open]");
    if (o) openDocket(o.dataset.dkOpen);
  });
  box.addEventListener("input", (e) => {
    const k = e.target.dataset.dkF;
    if (!k) return;
    st[k] = e.target.value;
    drawList();
  });

  await load();
}

function injectCss() {
  if (document.getElementById("inv-dockets-css")) return;
  const s = document.createElement("style");
  s.id = "inv-dockets-css";
  s.textContent = `
.dk-wait{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:10px 14px;margin:0 0 12px;border-radius:12px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:13.5px}
.dk-wait a{color:#0f766e;font-weight:600}
.dk-list{border:1px solid #e5e7eb;border-radius:14px;background:#fff;overflow:hidden}
.dk-row{display:grid;grid-template-columns:48px 110px minmax(0,1fr) auto;gap:14px;align-items:center;width:100%;padding:10px 14px;border:0;border-top:1px solid #eef0f3;background:#fff;text-align:left;font:inherit;cursor:pointer}
.dk-row:first-child{border-top:0}
.dk-row:hover{background:#f8fafc}
.dk-row:focus-visible{outline:2px solid #0f766e;outline-offset:-2px}
.dk-th{width:48px;height:60px;border-radius:8px;border:1px solid #e5e7eb;background:#f8fafc;display:grid;place-items:center;color:#94a3b8;overflow:hidden}
.dk-th img{width:100%;height:100%;object-fit:cover}
.dk-th svg{width:20px;height:20px}
.dk-date{display:flex;flex-direction:column;font-size:13px;color:#334155}
.dk-date small{font-size:11.5px;color:#94a3b8}
.dk-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dk-main strong{font-size:14.5px;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dk-main small{font-size:12.5px;color:#64748b}
.dk-go{font-size:13px;font-weight:600;color:#0f766e}
.lh-dialog.dk-dlg{width:min(980px,calc(100vw - 24px));max-width:none;height:min(860px,calc(100vh - 24px));max-height:none;padding:0;overflow:hidden}
.lh-dialog.dk-dlg[open]{display:flex;flex-direction:column}
.dk-dlg-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid #e5e7eb}
.dk-dlg-h h3{margin:0;font-size:18px}
.dk-dlg-h p{margin:2px 0 0;font-size:13px;color:#64748b}
.dk-dlg-acts{display:flex;gap:8px;align-items:center}
.dk-view{flex:1;min-height:0;background:#1e293b;display:grid;place-items:center;overflow:auto}
.dk-view img{max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-in}
.dk-view.is-zoom{place-items:start}
.dk-view.is-zoom img{max-width:none;max-height:none;width:160%;cursor:zoom-out}
.dk-view iframe{width:100%;height:100%;border:0;background:#fff}
.dk-msg{color:#cbd5e1;padding:20px;text-align:center;font-size:14px}
.dk-notes{margin:0;padding:10px 18px;border-top:1px solid #e5e7eb;font-size:13px;color:#475569}
.dk-spin{width:18px;height:18px;border:2px solid #334155;border-top-color:#5eead4;border-radius:50%;animation:dkspin .8s linear infinite}
@keyframes dkspin{to{transform:rotate(360deg)}}
@media (max-width:640px){.dk-row{grid-template-columns:44px 72px minmax(0,1fr);gap:10px}.dk-go{display:none}
  .lh-dialog.dk-dlg{width:100vw;height:100vh;border-radius:0}}`;
  document.head.appendChild(s);
}