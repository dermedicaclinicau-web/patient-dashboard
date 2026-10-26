// My dashboard → Visits without a record: my own Day Sheet visits that still need a treatment record
import { callApi } from "./appointments.js";
import { escapeHtml as esc, showToast } from "./utils.js";

const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const niceDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : k; };
const ago = (k) => {
  const d = keyDate(k);
  if (!d) return "";
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const n = Math.round((t - d) / 864e5);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : n < 14 ? `${n} days ago` : n < 70 ? `${Math.round(n / 7)} weeks ago` : `${Math.round(n / 30.4)} months ago`;
};
const RES = { none: "No treatment given", elsewhere: "Recorded somewhere else" };

// host: an empty element on the dashboard. onCount(n) lets the dashboard show a number on its heading.
export function mountMyVisits(host, { onCount = null, max = 8 } = {}) {
  const st = { rows: null, count: 0, problem: "", all: false };

  function draw() {
    if (!host.isConnected) return;
    if (!st.rows) {
      host.innerHTML = `<div class="mv-loading"><span class="mv-spin" aria-hidden="true"></span>Loading your visits…</div>`;
      return;
    }
    if (st.problem) {
      host.innerHTML = `<p class="mv-problem">${esc(st.problem)} <button type="button" class="rc-link" data-mv="retry">Try again</button></p>`;
      return;
    }
    if (!st.rows.length) {
      host.innerHTML = '<p class="mv-empty">Every visit of yours has a treatment record. 👍</p>';
      return;
    }
    const list = st.all ? st.rows : st.rows.slice(0, max);
    host.innerHTML = `
      <p class="mv-intro">${st.count === 1 ? "This visit has" : `These ${st.count} visits have`} no treatment record yet.
        Record it, or say why it doesn't need one.</p>
      <ul class="mv-list">${list.map((v) => `<li class="mv-row">
        <div class="mv-date"><b>${esc(niceDay(v.date))}</b><small>${esc(ago(v.date))}</small></div>
        <div class="mv-main">${v.pid
          ? `<a href="#/patient/${encodeURIComponent(v.pid)}" target="_blank" rel="noopener"><strong>${esc(v.name)}</strong></a>`
          : `<strong>${esc(v.name)}</strong>`}
          <small>${esc((v.services || []).join(", "))}</small></div>
        <div class="mv-acts">
          ${v.pid ? `<button type="button" class="lh-btn" data-mv="record" data-pid="${esc(v.pid)}">Record now</button>` : ""}
          <button type="button" class="lh-btn is-quiet" data-mv="sort" data-key="${esc(v.key)}">No record needed…</button>
        </div></li>`).join("")}</ul>
      ${st.rows.length > max ? `<button type="button" class="rc-link mv-more" data-mv="all">${st.all ? "Show fewer" : `Show all ${st.rows.length}`}</button>` : ""}
      ${st.count > st.rows.length ? `<p class="mv-intro">Showing the newest ${st.rows.length} of ${st.count}.</p>` : ""}`;
  }

  async function load() {
    st.rows = null;
    st.problem = "";
    draw();
    try {
      const r = await callApi({ action: "paper", op: "mine" });
      if (r && r.problem) throw new Error(r.problem);
      st.rows = (r && r.rows) || [];
      st.count = (r && r.count) || st.rows.length;
    } catch (e) {
      st.rows = [];
      st.problem = (e && e.message) || "Your visits couldn't be checked.";
    }
    if (onCount) onCount(st.problem ? null : st.count);
    draw();
  }

  function sortVisit(key) {
    const v = (st.rows || []).find((x) => x.key === key);
    if (!v) return;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog inv-dlg";
    dlg.innerHTML = `<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>${esc(v.name)}</h3><p>${esc(niceDay(v.date))} · ${esc((v.services || []).join(", "))}</p></div>
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
      btn.textContent = "Saving…";
      try {
        const r = await callApi({ action: "paper", op: "mineResolve", key, status: why, note });
        if (r && r.problem) throw new Error(r.problem);
        st.rows = st.rows.filter((x) => x.key !== key);
        st.count = Math.max(0, st.count - 1);
        if (onCount) onCount(st.count);
        dlg.close();
        showToast("Saved");
        draw();
      } catch (ex) {
        err.textContent = (ex && ex.message) || "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Save";
      }
    });
    dlg.showModal();
  }

  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mv]");
    if (!b) return;
    const a = b.dataset.mv;
    if (a === "retry") load();
    else if (a === "all") { st.all = !st.all; draw(); }
    else if (a === "record") window.open(`${location.pathname}${location.search}#/patient/${encodeURIComponent(b.dataset.pid)}`, "_blank");
    else if (a === "sort") sortVisit(b.dataset.key);
  });

  load();
  return { reload: load };
}