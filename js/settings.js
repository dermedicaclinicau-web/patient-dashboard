// System configuration (#/settings/<tab>): clinic-wide settings. Admins only.
// Email flows (#/settings/flows) has its own page (email-flows.js), but shares this tab bar.
import { mountRecordingSettings } from "./recording-settings.js";
import { renderPlanSettings } from "./plan-settings.js";
import { renderUiTextSettings } from "./ui-text-settings.js";
import { renderPlanWorkflowSettings } from "./plan-workflow-settings.js";

const TABS = [
  ["recording", "Recording rules"],
  ["plans", "Treatment plans"],
  ["workflow", "Plan workflow"],
  ["wording", "Wording"],
  ["flows", "Email flows"],
];
const isAdmin = (s) => /^admin$/i.test(String((s && s.role) || ""));

// The page heading and tab bar, with `tab` highlighted (also used by Email flows)
export function settingsHeaderHtml(tab) {
  return `
    <div class="fb-head">
      <div><h2>System configuration</h2><p class="muted">Clinic-wide settings. Only Admins can see this page.</p></div>
    </div>
    <nav class="pt-tabs inv-tabs" aria-label="System configuration">${TABS.map(([k, l]) =>
      `<a href="#/settings/${k}"${k === tab ? ' class="active" aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;
}

export function mountSettings(container, { param = "", staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page wide";
  container.replaceChildren(root);
  if (!isAdmin(staff)) {
    root.innerHTML = '<div class="state"><strong>No access</strong>Only Admins can change the system configuration.</div>';
    return;
  }

  const first = String(param || "").split("/")[0];
  // "flows" is opened by app.js straight into email-flows.js, so it never reaches here
  const tab = TABS.some(([k]) => k === first && k !== "flows") ? first : "recording";

  root.innerHTML = settingsHeaderHtml(tab) + '<div data-role="body"></div>';
  const body = root.querySelector('[data-role="body"]');

  if (tab === "plans") renderPlanSettings(body, { staff });
  else if (tab === "workflow") renderPlanWorkflowSettings(body, { staff });
  else if (tab === "wording") renderUiTextSettings(body, { staff });
  else mountRecordingSettings(body, { staff, embedded: true });
}