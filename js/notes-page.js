// Consultation notes full page, in their own tab (#/notes/<id>): opened from a Summary badge, a recording or My dashboard
import { showSoapPanel, detachSoapPanel } from "./soap-panel.js";
import { setTabIcon } from "./tab-icon.js";

const stateHtml = (title, text) => `<div class="cs-state"><strong>${title}</strong><p>${text}</p></div>`;

export function mountNotesPage(container, id = "") {
  const root = document.createElement("section");
  root.className = "page wide cs-page";
  container.replaceChildren(root);
  if (!id) { root.innerHTML = stateHtml("No notes chosen", "Open notes from a patient's page."); return; }

  root.innerHTML = '<div class="cs-notes" data-role="notes"></div>';
  const host = root.querySelector('[data-role="notes"]');
  document.title = "Consultation notes";
  setTabIcon("notes");
  showSoapPanel(id, { mode: "page", host });

  // Deleted in this tab: say so rather than leave an empty page
  const onDeleted = (e) => {
    if (root.isConnected && e.detail && e.detail.id === id) {
      root.innerHTML = stateHtml("These notes were deleted", "You can close this tab.");
    }
  };
  window.addEventListener("recording-deleted", onDeleted);

  // Left this page in the same tab: the notes go back to being the usual panel
  const onHash = () => setTimeout(() => {
    if (root.isConnected) return;
    window.removeEventListener("recording-deleted", onDeleted);
    window.removeEventListener("hashchange", onHash);
    detachSoapPanel();
  }, 0);
  window.addEventListener("hashchange", onHash);
}