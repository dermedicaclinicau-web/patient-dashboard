// Paper records (#/paper): scanned treatment records from the Google Drive folder, and Day Sheet visits with no record
import { callApi } from "./appointments.js";
import { searchPatients, warmPatients } from "./patient-list.js";
import { listPublishedForms } from "./form-templates.js";
import { escapeHtml as esc, showToast, formatDobLong, formatMobile } from "./utils.js";

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (k, n) => { const d = keyDate(k); if (!d) return ""; d.setDate(d.getDate() + n); return keyOf(d); };
const niceDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : ""; };
const shortDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""; };
const niceAt = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); };
const ago = (k) => {
  const d = keyDate(k);
  if (!d) return "";
  const n = Math.round((keyDate(todayKey()) - d) / 864e5);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : n < 14 ? `${n} days ago` : n < 70 ? `${Math.round(n / 7)} weeks ago` : `${Math.round(n / 30.4)} months ago`;
};

const STATUS = { todo: ["To enter", "warn"], help: ["Need help", "bad"], skip: ["Not a record", "muted"], entered: ["Entered", "ok"] };
const SKIP_REASONS = ["Blank or unreadable page", "Duplicate scan", "Consent form, not a treatment record", "Not a patient record", "Other"];
const RES = { none: "No treatment given", elsewhere: "Recorded somewhere else" };
const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

export function mountPaperRecords(container, { staff } = {}) {
  const isAdmin = /^admin$/i.test(String((staff && staff.role) || ""));
  const st = { tab: "scans", files: null, visits: null, vMeta: { from: "", cats: [] }, q: "", vq: "", vStaff: "all", vCat: "all",
    showSorted: false, thumbs: {} };

  container.innerHTML = `
    <section class="page wide ppr-page">
      <div class="ppr-head">
        <h2>Paper records</h2>
        <span class="inv-spacer"></span>
        <a class="rc-link" data-role="folder" target="_blank" rel="noopener" hidden>Open the Drive folder ↗</a>
        ${isAdmin ? '<button type="button" class="ff-btn" data-act="settings">Settings</button>' : ""}
        <button type="button" class="ff-btn" data-act="refresh">Refresh</button>
      </div>
      <div class="ppr-tabs" role="tablist"></div>
      <div data-role="body"><div class="skeleton sm"></div></div>
    </section>`;
  const tabsEl = container.querySelector(".ppr-tabs");
  const body = container.querySelector('[data-role="body"]');

  /* ---------- Drawing ---------- */

  function counts() {
    const f = st.files || [];
    const n = (s) => f.filter((x) => x.status === s).length;
    return { todo: n("todo"), help: n("help"), done: n("entered") + n("skip"),
      visits: st.visits ? st.visits.filter((x) => !x.res).length : null };
  }
  function drawTabs() {
    const c = counts();
    const busy = (v) => (v == null ? "…" : String(v));
    tabsEl.innerHTML = [
      ["scans", "Scans to enter", st.files ? c.todo : null], ["visits", "Visits without a record", c.visits],
      ["help", "Need help", st.files ? c.help : null], ["done", "Done", st.files ? c.done : null],
    ].map(([k, l, n]) => `<button type="button" class="ppr-tab${st.tab === k ? " is-on" : ""}" role="tab"
      aria-selected="${st.tab === k}" data-tab="${k}">${esc(l)} <em>${esc(busy(n))}</em></button>`).join("");
  }

  function rowHtml(f) {
    const [label, tone] = STATUS[f.status] || STATUS.todo;
    const th = st.thumbs[f.id];
    const sub = [`Scanned ${niceAt(f.created)}`, f.folder, f.kind === "pdf" ? "PDF" : "Photo"].filter(Boolean).join(" · ");
    const extra = f.status === "entered" ? `${f.patientName} · treatment on ${niceDay(f.recordDate)}`
      : f.status === "skip" ? f.reason : f.status === "help" ? `“${f.note}”` : "";
    return `<li class="ppr-row">
      <button type="button" class="ppr-thumb" data-open="${esc(f.id)}" data-thumb="${esc(f.id)}" aria-label="Open ${esc(f.name)}">${
        th ? `<img src="${esc(th)}" alt="" loading="lazy" />` : ICON_FILE}</button>
      <div class="ppr-main"><strong>${esc(f.name)}</strong><small>${esc(sub)}</small>${
        extra ? `<small class="ppr-extra">${esc(extra)}${f.by ? ` · ${esc(f.by)}` : ""}</small>` : ""}</div>
      <span class="ppr-pill is-${tone}">${esc(label)}</span>
      <button type="button" class="lh-btn" data-open="${esc(f.id)}">${f.status === "todo" || f.status === "help" ? "Enter" : "View"}</button>
    </li>`;
  }

  function visitHtml(v) {
    return `<li class="ppr-row ppr-vrow${v.res ? " is-sorted" : ""}">
      <div class="ppr-vdate"><b>${esc(shortDay(v.date))}</b><small>${esc(ago(v.date))}</small></div>
      <div class="ppr-main">${v.pid
        ? `<a href="#/patient/${encodeURIComponent(v.pid)}" target="_blank" rel="noopener">${esc(v.name)}</a>`
        : `<strong>${esc(v.name)}</strong> <span class="ppr-pill is-warn">No Patient ID</span>`}
        <small>${esc([v.services.join(", "), v.staff.join(" and ")].filter(Boolean).join(" · "))}</small>
        ${v.res ? `<small class="ppr-extra">${esc(RES[v.res.status] || "Sorted")}: “${esc(v.res.note)}” · ${esc(v.res.by)}</small>` : ""}</div>
      <div class="ppr-acts">${v.res
        ? `<button type="button" class="rc-link" data-vundo="${esc(v.key)}">Undo</button>`
        : `${v.pid ? `<button type="button" class="lh-btn" data-vrecord="${esc(v.pid)}">Record now</button>` : ""}
           <button type="button" class="lh-btn is-quiet" data-vsort="${esc(v.key)}">No record needed…</button>`}</div>
    </li>`;
  }

  function drawScans() {
    if (!st.files) { body.innerHTML = '<div class="skeleton sm"></div>'; return; }
    const want = st.tab === "scans" ? ["todo"] : st.tab === "help" ? ["help"] : ["entered", "skip"];
    const qq = st.q.trim().toLowerCase();
    const list = st.files.filter((f) => want.includes(f.status)
      && (!qq || [f.name, f.folder, f.patientName].join(" ").toLowerCase().includes(qq)));
    if (st.tab === "done") list.reverse();   // most recent first
    const total = st.files.length;
    const done = st.files.filter((f) => f.status === "entered" || f.status === "skip").length;
    body.innerHTML = `
      ${st.tab === "scans" ? `<div class="ppr-progress" aria-hidden="true"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></div>
        <p class="muted ppr-sum">${done} of ${total} scan${total === 1 ? "" : "s"} sorted</p>` : ""}
      <div class="ppr-tools"><input type="search" class="fe-input" data-f="q" placeholder="Filter by file name or patient" value="${esc(st.q)}" /></div>
      ${list.length ? `<ul class="ppr-list">${list.slice(0, 300).map(rowHtml).join("")}</ul>${
        list.length > 300 ? `<p class="muted ppr-sum">Showing 300 of ${list.length}. Filter to find the others.</p>` : ""}`
        : `<div class="tm-empty">${st.tab === "scans" ? (total ? "Every scan is sorted. 👍" : "No scans in the folder yet.")
          : st.tab === "help" ? "Nothing needs help. 👍" : "Nothing done yet."}</div>`}`;
    loadThumbs(list.slice(0, 60));
  }

  function drawVisits() {
    if (!st.visits) {
      body.innerHTML = '<div class="tm-empty"><strong>Checking the Day Sheet…</strong><br><small class="muted">The first time can take up to a minute.</small></div>';
      return;
    }
    const all = st.visits;
    const staffs = [...new Set(all.flatMap((v) => v.staff))].sort();
    const cats = [...new Set(all.flatMap((v) => v.cats))].sort();
    const qq = st.vq.trim().toLowerCase();
    const list = all.filter((v) => (st.showSorted || !v.res)
      && (st.vStaff === "all" || v.staff.includes(st.vStaff))
      && (st.vCat === "all" || v.cats.includes(st.vCat))
      && (!qq || v.name.toLowerCase().includes(qq)));
    const open = all.filter((v) => !v.res).length;
    const noId = all.filter((v) => !v.res && !v.pid).length;
    const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`;
    body.innerHTML = `
      <p class="muted ppr-sum">${open} visit${open === 1 ? "" : "s"} since ${esc(niceDay(st.vMeta.from))} with no treatment record${
        noId ? ` · ${noId} with no Patient ID on the Day Sheet` : ""}. Checking: ${esc((st.vMeta.cats || []).join(", "))}.</p>
      <div class="ppr-tools">
        <input type="search" class="fe-input" data-f="vq" placeholder="Filter by patient" value="${esc(st.vq)}" />
        <select class="fb-select" data-f="vStaff" aria-label="Clinician"><option value="all">Any clinician</option>${staffs.map((s) => opt(s, st.vStaff)).join("")}</select>
        <select class="fb-select" data-f="vCat" aria-label="Treatment"><option value="all">Any treatment</option>${cats.map((s) => opt(s, st.vCat)).join("")}</select>
        <label class="fe-check"><input type="checkbox" data-f="showSorted"${st.showSorted ? " checked" : ""} /> Show sorted ones</label>
      </div>
      ${list.length ? `<ul class="ppr-list">${list.slice(0, 400).map(visitHtml).join("")}</ul>${
        list.length > 400 ? `<p class="muted ppr-sum">Showing 400 of ${list.length}. Filter to find the others.</p>` : ""}`
        : `<div class="tm-empty">${open ? "Nothing matches the filters." : "Every visit has a record. 👍"}</div>`}`;
  }

  function draw() {
    drawTabs();
    if (st.tab === "visits") drawVisits(); else drawScans();
  }

  /* ---------- Loading ---------- */

  let thumbJob = 0;
  async function loadThumbs(list) {
    const my = ++thumbJob;
    const need = list.map((f) => f.id).filter((id) => !(id in st.thumbs));
    for (let i = 0; i < need.length; i += 12) {
      if (my !== thumbJob || !container.isConnected) return;
      try {
        const r = await callApi({ action: "paper", op: "thumbs", ids: need.slice(i, i + 12) });
        Object.entries(r.thumbs || {}).forEach(([id, url]) => {
          st.thumbs[id] = url || "";
          const el = body.querySelector(`[data-thumb="${CSS.escape(id)}"]`);
          if (el && url) el.innerHTML = `<img src="${esc(url)}" alt="" />`;
        });
      } catch (err) { console.warn("Scan thumbnails:", err); return; }
    }
  }

  async function loadScans(fresh = false) {
    try {
      const r = await callApi({ action: "paper", op: "list", fresh });
      if (r.problem) throw new Error(r.problem);
      st.files = r.files || [];
      if (r.folderUrl) {
        const a = container.querySelector('[data-role="folder"]');
        a.href = r.folderUrl;
        a.hidden = false;
      }
    } catch (err) {
      console.error("Paper scans:", err);
      st.files = st.files || [];
      if (container.isConnected) showToast(err.message || "Couldn't load the scans.");
    }
    if (container.isConnected) draw();
  }

  async function loadVisits(fresh = false) {
    try {
      const r = await callApi({ action: "paper", op: "visits", fresh });
      if (r.problem) throw new Error(r.problem);
      st.visits = r.rows || [];
      st.vMeta = r;
    } catch (err) {
      console.error("Visits without a record:", err);
      if (!st.visits) st.visits = [];
      if (container.isConnected) showToast(err.message || "Couldn't check the visits.");
    }
    if (container.isConnected) draw();
  }

  /* ---------- A scan: view it and sort it ---------- */

  function openScan(fileId) {
    const f = (st.files || []).find((x) => x.id === fileId);
    if (!f) return;
    warmPatients();
    let chosen = f.patientId ? { id: f.patientId, name: f.patientName, meta: "" } : null;
    let found = [], seq = 0, timer = 0, url = "", rot = 0, saving = false, isImage = false;
    const [label, tone] = STATUS[f.status] || STATUS.todo;

    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ppr-dlg";
    dlg.innerHTML = `
      <div class="ppr-dlg-head">
        <strong>${esc(f.name)}</strong><span class="ppr-pill is-${tone}">${esc(label)}</span>
        <span class="inv-spacer"></span>
        <button type="button" class="lh-btn is-quiet" data-act="next">Next scan →</button>
        <button type="button" class="hx-x" data-act="close" aria-label="Close">×</button>
      </div>
      <div class="ppr-split">
        <div class="ppr-view">
          <div class="ppr-view-tools">
            <button type="button" class="lh-btn is-quiet" data-act="rotate" hidden>Rotate</button>
            <button type="button" class="lh-btn is-quiet" data-act="zoom" hidden>Zoom</button>
            <span class="inv-spacer"></span>
            <a class="rc-link" data-role="drive" target="_blank" rel="noopener" hidden>Open in Drive ↗</a>
          </div>
          <div class="ppr-canvas" data-role="canvas"><div class="skeleton sm"></div></div>
        </div>
        <div class="ppr-side">
          <div class="lh-field"><span class="lh-label">Patient</span><div data-role="pt"></div></div>
          <div data-role="pvisits"></div>
          <label class="lh-field"><span class="lh-label">Date of treatment</span>
            <input type="date" class="fe-input" name="date" max="${todayKey()}" value="${esc(f.recordDate || "")}" /></label>
          <div class="lh-field"><span class="lh-label">Enter it on</span>
            <div class="ppr-formrow"><select class="fb-select" name="form"><option value="">Loading forms…</option></select>
              <button type="button" class="lh-btn" data-act="openform">Open the form</button></div>
            <small class="fe-note">Opens in a new tab. Set the form's record date to the date of treatment. For now, write the
              batch and units in the notes and leave Products used empty: it isn't backdated yet, and kit products would come off your own kit.</small></div>
          <p class="lh-error" role="alert" hidden></p>
          <button type="button" class="lh-btn is-primary ppr-wide" data-act="entered">Mark as entered</button>
          <details class="ppr-more"${f.status === "help" ? " open" : ""}><summary>Not a treatment record, or need help?</summary>
            <label class="lh-field"><span class="lh-label">It isn't a record</span>
              <select class="fb-select" name="reason"><option value="">Choose why…</option>${SKIP_REASONS.map((r) =>
                `<option${r === f.reason ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
            <button type="button" class="lh-btn" data-act="skip">Mark as not a record</button>
            <label class="lh-field"><span class="lh-label">Note</span>
              <textarea class="fe-input" name="note" rows="2" maxlength="500" placeholder="e.g. Can't read the batch number">${
                esc(f.status === "help" ? f.note : "")}</textarea></label>
            <button type="button" class="lh-btn" data-act="help">Ask for help</button>
            ${f.status !== "todo" ? '<button type="button" class="rc-link" data-act="todo">Put it back on the list</button>' : ""}
          </details>
        </div>
      </div>`;

    const $ = (s) => dlg.querySelector(s);
    const err = $(".lh-error");
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const ptHost = $('[data-role="pt"]');
    const pvHost = $('[data-role="pvisits"]');
    const dateIn = $('[name="date"]');

    function drawPt() {
      if (chosen) {
        ptHost.innerHTML = `<div class="bk-chosen"><span><strong>${esc(chosen.name)}</strong>${chosen.meta ? `<small>${esc(chosen.meta)}</small>` : ""}</span>
          <button type="button" class="lh-btn is-quiet" data-act="pt-change">Change</button></div>`;
      } else {
        ptHost.innerHTML = `<input class="fe-input" type="search" data-role="q" placeholder="Name or mobile on the paper" autocomplete="off" />
          <div class="bk-results" data-role="results"></div>`;
      }
      drawPatientVisits();
    }
    function drawResults(msg) {
      const box = $('[data-role="results"]');
      if (!box) return;
      box.innerHTML = msg ? `<p class="bk-none">${esc(msg)}</p>` : found.map((p, i) => `
        <button type="button" class="bk-res" data-pick="${i}"><strong>${esc(p.name)}</strong>
          <small>${esc([formatDobLong(p.dobKey), p.mobile && formatMobile(p.mobile), p.pttId].filter(Boolean).join(" · "))}</small></button>`).join("");
    }
    // That patient's visits with no record: tap one to fill in the date
    function drawPatientVisits() {
      if (!chosen) { pvHost.innerHTML = ""; return; }
      if (!st.visits) { pvHost.innerHTML = '<p class="bk-none">Looking for their visits…</p>'; return; }
      const mine = st.visits.filter((v) => v.pid === chosen.id && !v.res);
      pvHost.innerHTML = mine.length
        ? `<div class="lh-field"><span class="lh-label">Their visits with no record</span><div class="ppr-chips">${mine.slice(0, 8).map((v) =>
            `<button type="button" class="ppr-chip${dateIn.value === v.date ? " is-on" : ""}" data-vdate="${esc(v.date)}">${esc(shortDay(v.date))} · ${
              esc(v.cats.join(", "))}${v.staff.length ? ` · ${esc(v.staff.join(" and "))}` : ""}</button>`).join("")}</div></div>`
        : '<p class="bk-none">No visits without a record for them.</p>';
    }

    // The scan itself
    (async () => {
      const canvas = $('[data-role="canvas"]');
      try {
        const r = await callApi({ action: "paper", op: "file", fileId: f.id });
        if (r.url) { const a = $('[data-role="drive"]'); a.href = r.url; a.hidden = false; }
        if (r.problem) { canvas.innerHTML = `<p class="tm-empty">${esc(r.problem)}</p>`; return; }
        const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
        isImage = r.mime !== "application/pdf";
        canvas.innerHTML = isImage
          ? `<img src="${url}" alt="The scanned record" data-role="img" />`
          : `<iframe src="${url}#view=FitH" title="The scanned record"></iframe>`;
        $('[data-act="rotate"]').hidden = !isImage;
        $('[data-act="zoom"]').hidden = !isImage;
      } catch (ex) {
        console.error("Scan not loaded:", ex);
        canvas.innerHTML = `<p class="tm-empty">${esc(ex.message || "Couldn't load the scan.")}</p>`;
      }
    })();

    // The treatment record forms
    listPublishedForms().then((list) => {
      const forms = list.filter((t) => t.category === "treatment").sort((a, b) => String(a.name).localeCompare(String(b.name)));
      $('[name="form"]').innerHTML = forms.length
        ? `<option value="">Choose the form…</option>${forms.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}`
        : '<option value="">No treatment record forms are published</option>';
    }).catch(() => { $('[name="form"]').innerHTML = '<option value="">Couldn\'t load the forms</option>'; });

    if (!st.visits) loadVisits().then(() => { if (dlg.open) drawPatientVisits(); });

    // The next scan still to sort (after this one, in the list's order)
    const nextFile = () => {
      const list = (st.files || []).filter((x) => x.status === "todo" && x.id !== f.id);
      const at = (st.files || []).indexOf(f);
      return list.find((x) => st.files.indexOf(x) > at) || list[0] || null;
    };
    const goNext = () => {
      const n = nextFile();
      dlg.close();
      if (n) openScan(n.id); else showToast("That was the last scan to sort. 👍");
    };

    async function mark(status, extra = {}) {
      if (saving) return;
      err.hidden = true;
      saving = true;
      dlg.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try {
        const r = await callApi({ action: "paper", op: "mark", fileId: f.id, status, ...extra });
        if (r.problem) { fail(r.problem); return; }
        Object.assign(f, { status, note: extra.note || "", reason: extra.reason || "", patientId: r.patientId || "",
          patientName: r.patientName || "", recordDate: r.recordDate || "", by: r.by || "", at: r.at || "" });
        // An entered scan counts as that visit's record
        if (status === "entered" && st.visits) {
          st.visits = st.visits.filter((v) => !(v.pid === r.patientId && v.date <= r.recordDate && r.recordDate <= addDays(v.date, 3)));
        }
        showToast({ entered: "Marked as entered", skip: "Marked as not a record", help: "Flagged for help", todo: "Back on the list" }[status]);
        draw();
        if (status === "todo") dlg.close(); else goNext();
      } catch (ex) {
        console.error("Scan not saved:", ex);
        fail(ex.message || "Couldn't save. Try again.");
      } finally {
        saving = false;
        dlg.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      }
    }

    dlg.addEventListener("input", (e) => {
      err.hidden = true;
      if (e.target.dataset.role !== "q") return;
      clearTimeout(timer);
      const t = e.target.value;
      if (t.trim().length < 2) { found = []; drawResults(""); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        drawResults("Searching…");
        try {
          const r = await searchPatients(t, 8);
          if (my !== seq) return;
          found = r;
          drawResults(r.length ? "" : "No patients match. Check the spelling, or try their mobile.");
        } catch (ex) {
          if (my !== seq) return;
          console.warn("Patient search failed:", ex);
          drawResults("Couldn't search. Try again.");
        }
      }, 250);
    });
    dateIn.addEventListener("change", drawPatientVisits);

    dlg.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        const p = found[Number(pick.dataset.pick)];
        chosen = { id: p.id, name: p.name, meta: [formatDobLong(p.dobKey), p.mobile && formatMobile(p.mobile)].filter(Boolean).join(" · ") };
        drawPt();
        return;
      }
      const vd = e.target.closest("[data-vdate]");
      if (vd) { dateIn.value = vd.dataset.vdate; drawPatientVisits(); return; }
      const act = (e.target.closest("[data-act]") || {}).dataset?.act;
      if (!act) return;
      if (act === "close") { dlg.close(); return; }
      if (act === "next") { goNext(); return; }
      if (act === "pt-change") { chosen = null; found = []; drawPt(); $('[data-role="q"]').focus(); return; }
      if (act === "rotate") {
        rot = (rot + 90) % 360;
        const img = $('[data-role="img"]');
        if (img) img.style.transform = `rotate(${rot}deg)`;
        return;
      }
      if (act === "zoom") { $('[data-role="canvas"]').classList.toggle("is-zoom"); return; }
      if (act === "openform") {
        const tid = $('[name="form"]').value;
        if (!chosen) { fail("Choose the patient first."); return; }
        if (!tid) { fail("Choose the form."); return; }
        window.open(`${location.pathname}${location.search}#/fill/${encodeURIComponent(chosen.id)}/${encodeURIComponent(tid)}`, "_blank");
        return;
      }
      if (act === "entered") {
        if (!chosen) { fail("Choose the patient."); return; }
        if (!dateIn.value) { fail("Choose the date of the treatment."); return; }
        mark("entered", { patientId: chosen.id, recordDate: dateIn.value });
        return;
      }
      if (act === "skip") mark("skip", { reason: $('[name="reason"]').value, note: $('[name="note"]').value });
      if (act === "help") mark("help", { note: $('[name="note"]').value });
      if (act === "todo") mark("todo");
    });
    dlg.addEventListener("cancel", (e) => { if (saving) e.preventDefault(); });
    dlg.addEventListener("close", () => { if (url) URL.revokeObjectURL(url); dlg.remove(); });
    document.body.appendChild(dlg);
    drawPt();
    dlg.showModal();
    const first = $('[data-role="q"]');
    if (first) first.focus();
  }

  /* ---------- Visits: no record needed ---------- */

  function sortVisit(key) {
    const v = (st.visits || []).find((x) => x.key === key);
    if (!v) return;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>${esc(v.name)}</h3><p>${esc(niceDay(v.date))} · ${esc(v.services.join(", "))}</p></div>
      <div class="lh-field"><span class="lh-label">Why isn't there a treatment record?</span>
        ${Object.entries(RES).map(([k, l]) => `<label class="fe-check"><input type="radio" name="why" value="${k}" /> ${esc(l)}</label>`).join("")}</div>
      <label class="lh-field"><span class="lh-label">Note</span>
        <textarea class="fe-input" name="note" rows="2" maxlength="500" placeholder="e.g. Consult only, decided not to go ahead"></textarea></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button></div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => dlg.remove());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const why = (form.querySelector('[name="why"]:checked') || {}).value;
      const note = form.elements.note.value.trim();
      if (!why) { err.textContent = "Choose why."; err.hidden = false; return; }
      if (!note) { err.textContent = "Add a note saying what happened."; err.hidden = false; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const r = await callApi({ action: "paper", op: "resolve", key, status: why, note });
        if (r.problem) { err.textContent = r.problem; err.hidden = false; btn.disabled = false; return; }
        v.res = r.res;
        dlg.close();
        showToast("Saved");
        draw();
      } catch (ex) {
        err.textContent = ex.message || "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.showModal();
  }

  async function undoVisit(key) {
    const v = (st.visits || []).find((x) => x.key === key);
    if (!v) return;
    try {
      await callApi({ action: "paper", op: "resolve", key, status: "clear" });
      v.res = null;
      showToast("Back on the list");
      draw();
    } catch (ex) { showToast(ex.message || "Couldn't undo. Try again."); }
  }

  /* ---------- Settings (Admins) ---------- */

  async function openSettings() {
    let s;
    try { s = await callApi({ action: "paper", op: "settings" }); }
    catch (ex) { showToast(ex.message || "Couldn't load the settings."); return; }
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Visits without a record</h3><p>Which Day Sheet visits should have a treatment record.</p></div>
      <label class="lh-field"><span class="lh-label">Check visits from</span><input type="date" class="fe-input" name="from" value="${esc(s.from)}" /></label>
      <div class="lh-field"><span class="lh-label">Treatments that need a record</span>
        <div class="ppr-cats">${(s.allCats || []).map((c) => `<label class="fe-check"><input type="checkbox" name="cat" value="${esc(c)}"${
          (s.cats || []).includes(c) ? " checked" : ""} /> ${esc(c)}</label>`).join("")}</div></div>
      <label class="lh-field"><span class="lh-label">Services that don't need one (any service containing these words)</span>
        <input class="fe-input" name="skip" value="${esc((s.skip || []).join(", "))}" placeholder="Review, Consult" /></label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="submit" class="lh-btn is-primary">Save</button></div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector("form");
    const err = dlg.querySelector(".lh-error");
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => dlg.remove());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const r = await callApi({
          action: "paper", op: "saveSettings", from: form.elements.from.value,
          cats: [...form.querySelectorAll('[name="cat"]:checked')].map((x) => x.value),
          skip: form.elements.skip.value.split(",").map((x) => x.trim()).filter(Boolean),
        });
        if (r.problem) { err.textContent = r.problem; err.hidden = false; btn.disabled = false; return; }
        dlg.close();
        showToast("Saved. Checking the visits again…");
        st.visits = null;
        draw();
        loadVisits(true);
      } catch (ex) {
        err.textContent = ex.message || "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
      }
    });
    dlg.showModal();
  }

  /* ---------- Events ---------- */

  container.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { st.tab = tab.dataset.tab; draw(); return; }
    const op = e.target.closest("[data-open]");
    if (op) { openScan(op.dataset.open); return; }
    const rec = e.target.closest("[data-vrecord]");
    if (rec) { window.open(`${location.pathname}${location.search}#/patient/${encodeURIComponent(rec.dataset.vrecord)}`, "_blank"); return; }
    const vs = e.target.closest("[data-vsort]");
    if (vs) { sortVisit(vs.dataset.vsort); return; }
    const vu = e.target.closest("[data-vundo]");
    if (vu) { undoVisit(vu.dataset.vundo); return; }
    const act = e.target.closest("[data-act]");
    if (act && act.dataset.act === "refresh") {
      st.files = null; st.visits = null; draw();
      loadScans(true); loadVisits(true);
      return;
    }
    if (act && act.dataset.act === "settings") openSettings();
  });

  let qt = 0;
  body.addEventListener("input", (e) => {
    const k = e.target.dataset.f;
    if (k !== "q" && k !== "vq") return;
    st[k] = e.target.value;
    clearTimeout(qt);
    qt = setTimeout(() => {
      const pos = e.target.selectionStart;
      draw();
      const el = body.querySelector(`[data-f="${k}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not a text box */ } }
    }, 200);
  });
  body.addEventListener("change", (e) => {
    const k = e.target.dataset.f;
    if (k === "vStaff" || k === "vCat") { st[k] = e.target.value; draw(); }
    if (k === "showSorted") { st.showSorted = e.target.checked; draw(); }
  });

  draw();
  loadScans();
  loadVisits();
}