import { escapeHtml } from "./utils.js";

// Form Builder page, portal version.
// Step 1: the page shell, so the menu item and routing can be tested.
export function mountFormBuilder(container, { isAdmin = false } = {}) {
  const message = isAdmin
    ? "You'll be able to create forms, organise them into categories and publish them for the team."
    : "Published forms will be listed here for you to fill in with patients.";

  container.innerHTML = `
    <section class="page">
      <div class="page-head"><h2>Form Builder</h2></div>
      <div class="state"><strong>Your forms will appear here</strong>${escapeHtml(message)}</div>
    </section>`;
}