// print-done.js: "Sent to the printer" popup. Stays until the user presses Close.
// A modal dialog, so it shows above other dialogs (like the Skin Script preview).
// Usage: showPrintedPopup({ what: "Skin Script Protocol", patient: "Jane Smith", to: "printer@…" })

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
.pd-dlg{border:0;padding:0;background:transparent;max-width:calc(100vw - 32px)}
.pd-dlg::backdrop{background:rgba(15,23,42,.45)}
.pd-box{width:400px;max-width:100%;box-sizing:border-box;padding:26px 24px 20px;border-radius:16px;background:#fff;box-shadow:0 20px 50px rgba(15,23,42,.25);text-align:center;font-family:inherit}
.pd-ico{display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;margin-bottom:10px;border-radius:50%;background:#dcfce7;color:#15803d;font-size:30px;font-weight:700}
.pd-box h2{margin:0 0 6px;font-size:20px;color:#0f172a}
.pd-box p{margin:0 0 6px;font-size:14px;line-height:1.5;color:#475569}
.pd-meta{margin:12px 0 14px;padding:10px 12px;border-radius:10px;background:#f8fafc;font-size:13px;color:#334155;text-align:left}
.pd-meta div{display:flex;justify-content:space-between;gap:10px;padding:2px 0}
.pd-meta span{color:#64748b}
.pd-meta strong{overflow-wrap:anywhere;text-align:right}
.pd-close{width:100%;margin-top:8px;padding:11px 16px;border:0;border-radius:10px;background:#0f766e;color:#fff;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
.pd-close:hover{background:#115e59}
`;

function injectCss() {
  if (document.getElementById("pd-css")) return;
  const s = document.createElement("style");
  s.id = "pd-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function showPrintedPopup({ what = "Document", patient = "", to = "", copies = 1 } = {}) {
  injectCss();
  document.querySelector(".pd-dlg")?.remove();   // never two at once
  const time = new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  const dlg = document.createElement("dialog");
  dlg.className = "pd-dlg";
  dlg.setAttribute("aria-labelledby", "pd-h");
  dlg.innerHTML = `<div class="pd-box">
    <div class="pd-ico" aria-hidden="true">✓</div>
    <h2 id="pd-h">Sent to the printer</h2>
    <p>${esc(what)}${patient ? ` for <strong>${esc(patient)}</strong>` : ""} has been sent to the clinic printer.</p>
    <div class="pd-meta">
      <div><span>Sent at</span><strong>${esc(time)}</strong></div>
      ${copies > 1 ? `<div><span>Copies</span><strong>${copies}</strong></div>` : ""}
      ${to ? `<div><span>Printer</span><strong>${esc(to)}</strong></div>` : ""}
    </div>
    <p>Collect it from the printer. There's no need to send it again.</p>
    <button type="button" class="pd-close">Close</button>
  </div>`;
  document.body.appendChild(dlg);
  dlg.querySelector(".pd-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  dlg.querySelector(".pd-close").focus();
}