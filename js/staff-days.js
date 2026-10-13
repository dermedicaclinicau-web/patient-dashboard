// My dashboard → Start & end of day (Admins only): today at a glance, and the full report at #/home/days
import { listKitDays } from "./inventory-api.js";
import { MOODS } from "./end-of-day-api.js";
import { isAdmin } from "./perms.js";
import { mountDayReport } from "./reports.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const face = (v) => { const m = MOODS.find(([n]) => n === Math.round(v)); return m ? m[1] : ""; };
const off = (n) => Math.abs(Number(n) || 0) > 0.001;

/* ---------- The full report page ---------- */

export function mountStaffDays(container) {
  const root = document.createElement("section");
  root.className = "page wide";
  container.replaceChildren(root);
  if (!isAdmin()) {
    root.innerHTML = '<div class="state"><strong>Admins only</strong>Start and End of Day reports are for Admins.</div>';
    return;
  }
  root.innerHTML = `
    <a class="back-link" href="#/home">← My dashboard</a>
    <div class="fb-head">
      <div><h2>Start &amp; end of day</h2>
        <p class="muted">Each person's Start of Day kit count, End of Day count and answers.
          An overnight kit difference opens an investigation automatically.</p></div>
      <div class="fb-head-actions"><a class="btn-ghost" href="#/tasks/end-of-day">Edit End of day questions</a></div>
    </div>
    <div data-role="body"></div>`;
  mountDayReport(root.querySelector('[data-role="body"]'));
}

/* ---------- Today at a glance (a card on My dashboard) ---------- */

export async function renderDayCard(host) {
  if (!host) return;
  if (!isAdmin()) { host.remove(); return; }
  host.innerHTML = `<div class="md-card-head"><h3>Start &amp; end of day</h3><a class="md-link" href="#/home/days">Full report →</a></div>
    <div class="skeleton" style="height:90px;border-radius:10px"></div>`;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const days = await listKitDays(today, tomorrow);
    if (!host.isConnected) return;

    const rows = days.map((d) => {
      const s = d.start, e = d.end;
      const items = [...((s && !s.notInjecting && s.items) || []), ...((e && e.items) || [])];
      const overnight = ((s && s.items) || []).some((it) => it.overnight && it.overnight.compared && off(it.overnight.gap));
      const diff = items.some((it) => off(it.variance));
      const unknown = ((s && s.items) || []).some((it) => Array.isArray(it.unknown) && it.unknown.length);
      const moodA = e ? e.answers.find((a) => a.type === "mood" && Number(a.value)) : null;
      const kit = s && s.notInjecting ? ["info", "Not injecting"]
        : overnight ? ["bad", "Overnight difference"]
        : diff || unknown ? ["warn", "Kit difference"]
        : items.length ? ["ok", "Kit matched"] : null;
      return { name: d.staffName || "—", start: s ? s.at : null, end: e ? e.at : null, mood: moodA ? Number(moodA.value) : null, kit, overnight };
    }).sort((a, b) => Number(b.overnight) - Number(a.overnight) || a.name.localeCompare(b.name, "en-AU"));

    const moods = rows.map((r) => r.mood).filter((m) => m !== null);
    const avg = moods.length ? moods.reduce((a, n) => a + n, 0) / moods.length : null;
    const nOvernight = rows.filter((r) => r.overnight).length;

    host.innerHTML = `
      <div class="md-card-head"><h3>Start &amp; end of day</h3><a class="md-link" href="#/home/days">Full report →</a></div>
      ${rows.length ? `
        <div class="md-stats">
          <div><strong>${rows.filter((r) => r.start).length}</strong><span>Started</span></div>
          <div><strong>${rows.filter((r) => r.end).length}</strong><span>Ended</span></div>
          <div><strong>${avg === null ? "—" : `${face(avg)} ${avg.toFixed(1)}`}</strong><span>How the day went</span></div>
          <div><strong class="${nOvernight ? "rp-neg" : ""}">${nOvernight}</strong><span>Overnight differences</span></div>
        </div>
        <div class="rp-scroll"><table class="inv-table sd-table">
          <thead><tr><th>Staff</th><th>Started</th><th>Ended</th><th>Day</th><th>Kit</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td><strong>${esc(r.name)}</strong></td>
            <td>${esc(timeOf(r.start) || "—")}</td>
            <td>${r.end ? esc(timeOf(r.end)) : '<span class="muted">Not yet</span>'}</td>
            <td class="rp-mood">${r.mood !== null ? `<span title="${r.mood} of 5">${face(r.mood)}</span>` : ""}</td>
            <td>${r.kit ? `<span class="inv-flag is-${r.kit[0]}">${esc(r.kit[1])}</span>` : "—"}</td></tr>`).join("")}</tbody>
        </table></div>`
        : '<p class="tb-none">Nobody has logged a Start or End of Day yet today.</p>'}`;
  } catch (err) {
    console.error("Start & end of day card failed:", err);
    if (host.isConnected) host.innerHTML = `<div class="md-card-head"><h3>Start &amp; end of day</h3></div>
      <p class="tb-none tb-bad">${err && err.code === "permission-denied"
        ? "Blocked. Check the inv_kitdays Firestore rule has been published." : "Couldn't load today's days."}</p>`;
  }
}