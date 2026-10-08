import { escapeHtml } from "./utils.js";

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  warning: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  danger: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
};

let dlg = null;
let resolver = null;

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement("dialog");
  dlg.className = "cd-dialog";
  document.body.appendChild(dlg);

  dlg.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cd]");
    if (btn) finish(btn.dataset.cd === "ok");
    else if (e.target === dlg) finish(false); // clicked the dimmed background
  });
  // Esc key
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
}

function finish(result) {
  if (!resolver) return;
  const resolve = resolver;
  resolver = null;
  dlg.close();
  resolve(result);
}

/**
 * Nice replacement for window.confirm(). Resolves true (confirmed) or false (cancelled).
 * tone: "warning" (amber) | "danger" (red) | "info" (indigo)
 */
export function confirmDialog({
  title = "Are you sure?",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "warning",
} = {}) {
  ensureDialog();
  if (resolver) finish(false); // only one question at a time

  const paragraphs = String(message || "")
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");

  dlg.className = `cd-dialog cd-tone-${ICONS[tone] ? tone : "warning"}`;
  dlg.setAttribute("aria-label", title);
  dlg.innerHTML = `
    <div class="cd-box">
      <div class="cd-icon">${ICONS[tone] || ICONS.warning}</div>
      <h2 class="cd-title">${escapeHtml(title)}</h2>
      ${paragraphs ? `<div class="cd-message">${paragraphs}</div>` : ""}
      <div class="cd-actions">
        ${cancelLabel ? `<button type="button" class="cd-btn cd-cancel" data-cd="cancel">${escapeHtml(cancelLabel)}</button>` : ""}
        <button type="button" class="cd-btn cd-ok" data-cd="ok">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;

  dlg.showModal();
  // Risky actions: Cancel gets the focus so Enter never confirms by accident
  const focusBtn = tone === "danger" || tone === "warning"
    ? dlg.querySelector(".cd-cancel") || dlg.querySelector(".cd-ok")
    : dlg.querySelector(".cd-ok");
  if (focusBtn) focusBtn.focus();

  return new Promise((resolve) => { resolver = resolve; });
}

// Nice replacement for window.alert()
export function alertDialog({ title = "", message = "", okLabel = "OK", tone = "info" } = {}) {
  return confirmDialog({ title, message, confirmLabel: okLabel, cancelLabel: "", tone }).then(() => undefined);
}