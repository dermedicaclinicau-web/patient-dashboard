// Choosing when a scheduled Task Manager email goes (Perth time). Used by the task screen and Task history.
import { fmtSlot, fmtTime } from "./task-schedule.js";

const PERTH = 8 * 3600000;   // Perth is UTC+8 all year
const MAX_DAYS = 90;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const partsOf = (ms) => {
  const t = new Date(ms + PERTH);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
};
const keyOf = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
const toMs = (key, time) => {
  const [y, m, d] = key.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - PERTH;
};
const addDays = (key, n) => keyOf(partsOf(toMs(key, "12:00") + n * 86400000));
const TIMES = [];
for (let h = 6; h <= 21; h++) for (const m of [0, 15, 30, 45]) TIMES.push(`${pad(h)}:${pad(m)}`);

export const fmtSendTime = (ms) => fmtSlot(Number(ms));

// Resolves with { ms } or null if cancelled
export function pickSendTime({ title = "Schedule this email", intro = "", warning = "", confirmLabel = "Schedule", current = 0 } = {}) {
  return new Promise((resolve) => {
    const now = Date.now();
    const today = keyOf(partsOf(now));
    const tomorrow = addDays(today, 1);
    const monday = addDays(today, ((8 - partsOf(now).dow) % 7) || 7);
    let day = tomorrow;
    let time = "08:00";
    if (current) {
      const p = partsOf(Number(current));
      day = keyOf(p);
      time = `${pad(p.h)}:${pad(p.mi - (p.mi % 15))}`;
    }
    const times = TIMES.includes(time) ? TIMES : [...TIMES, time].sort();
    const quick = [[tomorrow, "08:00", "Tomorrow, 8:00 am"], [tomorrow, "09:00", "Tomorrow, 9:00 am"]];
    if (monday !== tomorrow) quick.push([monday, "08:00", "Monday, 8:00 am"]);

    let result = null;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog fe-confirm";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>${esc(title)}</h3>${intro ? `<p>${esc(intro)}</p>` : ""}</div>
        <div class="tl-quick">${quick.map(([k, t, l]) => `<button type="button" class="ch-chip" data-q="${k}|${t}">${esc(l)}</button>`).join("")}</div>
        <div class="lh-two">
          <label class="lh-field"><span class="lh-label">Date</span>
            <input type="date" name="day" min="${today}" max="${addDays(today, MAX_DAYS)}" value="${day}" /></label>
          <label class="lh-field"><span class="lh-label">Time (Perth)</span>
            <select class="fb-select" name="time">${times.map((t) =>
              `<option value="${t}"${t === time ? " selected" : ""}>${esc(fmtTime(t))}</option>`).join("")}</select></label>
        </div>
        <p class="tl-when" data-role="when"></p>
        ${warning ? `<p class="tl-warn">${esc(warning)}</p>` : ""}
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">${esc(confirmLabel)}</button>
        </div>
      </form>`;
    const form = dlg.querySelector("form");
    const whenEl = dlg.querySelector('[data-role="when"]');
    const err = dlg.querySelector(".lh-error");
    const chosen = () => {
      const k = form.elements.day.value;
      return KEY_RE.test(k) ? toMs(k, form.elements.time.value) : 0;
    };
    const update = () => {
      const ms = chosen();
      whenEl.textContent = ms ? `Sends ${fmtSendTime(ms)}` : "Choose a date";
      err.hidden = true;
    };
    form.addEventListener("input", update);
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]')) { dlg.close(); return; }
      const q = e.target.closest("[data-q]");
      if (q) {
        const [k, t] = q.dataset.q.split("|");
        form.elements.day.value = k;
        form.elements.time.value = t;
        update();
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const ms = chosen();
      const problem = !ms ? "Choose a date."
        : ms < Date.now() + 5 * 60000 ? "Choose a time at least 5 minutes from now."
        : ms > Date.now() + MAX_DAYS * 86400000 ? `Emails can be scheduled up to ${MAX_DAYS} days ahead.` : "";
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      result = { ms };
      dlg.close();
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    update();
    dlg.showModal();
  });
}