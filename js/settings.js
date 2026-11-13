// System configuration (#/settings/<tab>): clinic-wide settings. Admins only.
// Email flows (#/settings/flows) has its own page (email-flows.js), but shares this tab bar.
import { mountRecordingSettings } from "./recording-settings.js";
import { renderPlanSettings } from "./plan-settings.js";
import { renderPlanCatalogue } from "./plan-catalogue.js";
import { renderUiTextSettings } from "./ui-text-settings.js";
import { renderPlanWorkflowSettings } from "./plan-workflow-settings.js";

const TABS = [
  ["recording", "Recording rules"],
  ["plans", "Treatment plans"],
  ["workflow", "Plan workflow"],
  ["wording", "Wording"],
  ["flows", "Email flows"],
];

// Treatment plans: three sub-tabs (the last one used is remembered for this browser tab)
const PLAN_TABS = [
  ["concerns", "Concerns and treatments"],
  ["services", "Appointment services"],
  ["copy", "Patient copy"],
];
const PLAN_TAB_KEY = "settings-plans-tab";

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

  if (tab === "plans") {
    const asked = String(param || "").split("/")[1];
    let sub = PLAN_TABS.some(([k]) => k === asked) ? asked
      : (() => { try { return sessionStorage.getItem(PLAN_TAB_KEY) || ""; } catch { return ""; } })();
    if (!PLAN_TABS.some(([k]) => k === sub)) sub = "concerns";
    body.innerHTML = `<div class="ps-subtabs" role="tablist" aria-label="Treatment plans">${PLAN_TABS.map(([k, l]) =>
      `<button type="button" role="tab" data-sub="${k}" aria-selected="${k === sub}">${l}</button>`).join("")}</div>
      <div data-role="sub"></div>`;
    const show = (k) => {
      sub = k;
      try { sessionStorage.setItem(PLAN_TAB_KEY, k); } catch { /* not essential */ }
      body.querySelectorAll("[data-sub]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.sub === k)));
      const el = document.createElement("div");   // a fresh box each time, so the last tab's listeners go with it
      body.querySelector('[data-role="sub"]').replaceChildren(el);
      if (k === "concerns") renderPlanCatalogue(el, { staff });
      else renderPlanSettings(el, { staff, part: k });
    };
    body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sub]");
      if (b && b.dataset.sub !== sub) show(b.dataset.sub);
    });
    show(sub);
  }
  else if (tab === "workflow") renderPlanWorkflowSettings(body, { staff });
  else if (tab === "wording") renderUiTextSettings(body, { staff });
  else mountRecordingSettings(body, { staff, embedded: true });
}