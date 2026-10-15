// Printing in the background: the PDF is emailed to the clinic printer (once per copy) while staff carry on.
// A small panel (bottom left) shows each print until it's sent. Failed ones can be retried from any page.
import { callApi } from "./appointments.js";
import { pdfPayload, deliveryError } from "./form-delivery.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const CHECK = ic('<polyline points="20 6 9 17 4 12"/>');
const WARN = ic('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>');

const jobs = [];   // { id, title, copies, state: preparing | sending | done | failed, error, run }
let box = null;
let seq = 0;
const busy = () => jobs.some((j) => j.state === "preparing" || j.state === "sending");
const copiesText = (n) => `${n} cop${n === 1 ? "y" : "ies"}`;

function remove(j) {
  const i = jobs.indexOf(j);
  if (i > -1) jobs.splice(i, 1);
  render();
}

function render() {
  if (!jobs.length) {
    if (box) { box.remove(); box = null; }
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.className = "pq";
    box.setAttribute("aria-live", "polite");
    box.addEventListener("click", (e) => {
      const r = e.target.closest("[data-pq-retry]");
      const x = e.target.closest("[data-pq-close]");
      const j = jobs.find((y) => String(y.id) === ((r || x) && (r || x).dataset[r ? "pqRetry" : "pqClose"]));
      if (!j) return;
      if (r) j.run(); else remove(j);
    });
    document.body.appendChild(box);
  }
  box.innerHTML = jobs.map((j) => {
    const status = j.state === "preparing" ? "Preparing the PDF…"
      : j.state === "sending" ? `Sending ${copiesText(j.copies)} to the printer…`
      : j.state === "done" ? `Sent ${copiesText(j.sent || j.copies)} to the printer`
      : j.error;
    const icon = j.state === "done" ? CHECK : j.state === "failed" ? WARN : '<span class="rec-spin"></span>';
    const finished = j.state === "done" || j.state === "failed";
    return `<div class="pq-item is-${j.state}">
      <span class="pq-ic">${icon}</span>
      <span class="pq-main"><strong>${esc(j.title)}</strong><small>${esc(status)}</small></span>
      ${j.state === "failed" ? `<button type="button" class="lh-btn pq-btn" data-pq-retry="${j.id}">Retry</button>` : ""}
      ${finished ? `<button type="button" class="pq-x" data-pq-close="${j.id}" aria-label="Close">×</button>` : ""}
    </div>`;
  }).join("");
}

// job: from formPrintJob (its PDF is usually already made). request: what Apps Script needs, without the PDF.
export function queuePrint({ title, copies, job, request }) {
  const j = { id: ++seq, title: title || "Form", copies, state: "preparing", error: "", sent: 0 };
  j.run = async () => {
    j.state = "preparing";
    j.error = "";
    render();
    try {
      const payload = await pdfPayload(job);
      j.state = "sending";
      render();
      const res = await callApi({ ...request, ...payload });
      j.state = "done";
      j.sent = Number(res && res.sent) || copies;
      render();
      setTimeout(() => { if (j.state === "done") remove(j); }, 6000);
    } catch (err) {
      console.error("Background print failed:", err);
      j.state = "failed";
      j.error = deliveryError(err);
      render();
    }
  };
  jobs.push(j);
  j.run();
  return j;
}

// Closing the tab mid-send would lose the print, so the browser asks first
window.addEventListener("beforeunload", (e) => {
  if (busy()) { e.preventDefault(); e.returnValue = ""; }
});