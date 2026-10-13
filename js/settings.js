// System configuration (#/settings/<tab>): clinic-wide settings. Admins only.
import { mountRecordingSettings } from "./recording-settings.js";
import { renderPlanSettings } from "./plan-settings.js";

const TABS = [["recording", "Recording rules"], ["plans", "Treatment plans"]];
const isAdmin = (s) => /^admin$/i.test(String((s && s.role) || ""));

export function mountSettings(container, { param = "", staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide";
  container.replaceChildren(root);
  if (!isAdmin(staff)) {
    root.innerHTML = '<div class="state"><strong>No access</strong>Only Admins can change the system configuration.</div>';
    return;
  }

  const first = String(param || "").split("/")[0];
  const tab = TABS.some(([k]) => k === first) ? first : "recording";

  root.innerHTML = `
    <div class="fb-head">
      <div><h2>System configuration</h2><p class="muted">Clinic-wide settings. Only Admins can see this page.</p></div>
    </div>
    <nav class="pt-tabs inv-tabs" aria-label="System configuration">${TABS.map(([k, l]) =>
      `<a href="#/settings/${k}"${k === tab ? ' class="active" aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    <div data-role="body"></div>`;
  const body = root.querySelector('[data-role="body"]');

  if (tab === "plans") renderPlanSettings(body, { staff });
  else mountRecordingSettings(body, { staff, embedded: true });
}