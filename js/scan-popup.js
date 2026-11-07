// Big, simple pop-ups with one OK button, for things staff need to notice.
// One at a time: a second waits until the first is closed.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let chain = Promise.resolve();

// { tone: "ok" | "warn", title, text: [lines], photo (a Blob: shown instead of the tick), skipKey (offers "Don't show this again") }
export function okPopup(o) {
  const next = chain.then(() => show(o));
  chain = next.catch(() => {});
  return next;
}

// A pop-up someone ticked "Don't show this again" on, on this device
export const popupOff = (key) => { try { return localStorage.getItem(key) === "off"; } catch { return false; } };

function show({ tone = "ok", title = "", text = [], photo = null, skipKey = "" }) {
  return new Promise((resolve) => {
    const url = photo ? URL.createObjectURL(photo) : "";
    const dlg = document.createElement("dialog");
    dlg.className = `lh-dialog scan-saved-dlg is-${tone}`;
    dlg.innerHTML = `<form method="dialog" class="lh-form">
      ${url ? `<img class="scan-saved-photo" src="${url}" alt="The photo" />`
        : `<div class="scan-saved-icon" aria-hidden="true">${tone === "warn" ? "!" : "✓"}</div>`}
      <h3>${esc(title)}</h3>
      ${text.map((t) => `<p>${esc(t)}</p>`).join("")}
      ${skipKey ? '<label class="scan-saved-skip"><input type="checkbox" data-role="skip" /> Don\'t show this again on this device</label>' : ""}
      <div class="lh-actions"><button type="submit" class="lh-btn is-primary" autofocus>OK</button></div>
    </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => {
      const skip = dlg.querySelector('[data-role="skip"]');
      if (skip && skip.checked) { try { localStorage.setItem(skipKey, "off"); } catch { /* private mode */ } }
      if (url) URL.revokeObjectURL(url);
      dlg.remove();
      resolve();
    });
    dlg.showModal();
  });
}