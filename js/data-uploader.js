// Task Manager → Daily uploads: Timely CSVs go straight into the PCN spreadsheet.
// The file is read in the browser, sent compressed to Apps Script and written to the sheet. It isn't saved anywhere.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAX_BYTES = 80 * 1024 * 1024;
const num = (n) => Number(n || 0).toLocaleString("en-AU");
const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};

const KINDS = [
  { key: "daysheet", title: "Day Sheet (all time)", ready: true,
    blurb: "Every appointment from Timely, including cancelled. Replaces everything in alltimeappts, then fills in the PCN category (N) and Patient ID (O)." },
  { key: "invoices", title: "Invoice Record (yesterday)", ready: false, blurb: "Yesterday's invoices from Timely." },
  { key: "packages", title: "Customer Packages", ready: false, blurb: "Patients' active packages from Timely." },
];

// The file, compressed (gzip) where the browser can, as base64
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function pack(file) {
  if (typeof CompressionStream === "undefined") return { gzip: false, data: toB64(await file.arrayBuffer()) };
  const buf = await new Response(file.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return { gzip: true, data: toB64(buf) };
}

function errText(err) {
  switch (err && err.code) {
    case "FORBIDDEN": return "You don't have access to Daily uploads. An admin can turn it on in Staff → Roles & access.";
    case "UNAUTHORIZED": return "Your session has expired. Log out and back in, then try again.";
    case "INVALID_PIN": case "BAD_REQUEST": return "The server hasn't been updated yet. In Apps Script, deploy a new version.";
  }
  if (err && /Unexpected response/.test(err.message || "")) {
    return "The server took too long or stopped. Check Apps Script → Executions, then try again.";
  }
  return (err && err.message) || "Couldn't upload. Try again.";
}

function lastLine(d) {
  return `Last uploaded ${when(d.at)}${d.by ? ` by ${d.by}` : ""} · ${num(d.rows)} rows${
    d.unmatchedNames ? ` · ${num(d.unmatchedNames)} patients not matched` : ""}`;
}

function cardHtml(k, i) {
  const head = `<h4><span class="tb-num">${i + 1}</span>${esc(k.title)}${k.ready ? "" : ' <small class="muted du-soon">Coming next</small>'}</h4>`;
  if (!k.ready) return `<section class="tb-card du-card is-soon">${head}<p class="muted">${esc(k.blurb)}</p></section>`;
  return `
    <section class="tb-card du-card" data-kind="${k.key}">
      ${head}
      <p class="muted">${esc(k.blurb)}</p>
      <label class="du-drop">
        <input type="file" accept=".csv,text/csv" data-file hidden />
        <strong data-role="fname">Choose the CSV, or drop it here</strong>
        <small>The file is read and written to the sheet. It isn't saved anywhere.</small>
      </label>
      <div class="du-acts"><button type="button" class="ff-btn is-primary" data-act="run" disabled>Upload and run</button></div>
      <p class="du-msg" data-role="msg" aria-live="polite"></p>
      <div data-role="result"></div>
      <small class="muted" data-role="last"></small>
    </section>`;
}

function wire(card, k) {
  const input = card.querySelector("[data-file]");
  const drop = card.querySelector(".du-drop");
  const fname = card.querySelector('[data-role="fname"]');
  const btn = card.querySelector('[data-act="run"]');
  const msg = card.querySelector('[data-role="msg"]');
  const result = card.querySelector('[data-role="result"]');
  const lastEl = card.querySelector('[data-role="last"]');
  let file = null, packed = null, running = false;

  const setMsg = (t, bad = false) => { msg.textContent = t || ""; msg.classList.toggle("is-bad", bad); };
  const guard = (e) => { e.preventDefault(); e.returnValue = ""; };
  const showLast = () => getDoc(doc(db, "data_uploads", k.key))
    .then((s) => { if (card.isConnected) lastEl.textContent = s.exists() ? lastLine(s.data()) : "Not uploaded from the portal yet."; })
    .catch(() => { lastEl.textContent = ""; });
  const clearFile = () => {
    file = null; packed = null; input.value = "";
    fname.textContent = "Choose the CSV, or drop it here";
    drop.classList.remove("has-file");
    btn.disabled = true;
  };

  async function choose(f) {
    if (running) return;
    clearFile();
    result.innerHTML = "";
    setMsg("");
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { setMsg("Choose the CSV file Timely exported (its name ends in .csv).", true); return; }
    if (f.size > MAX_BYTES) { setMsg("That file is too big to upload in one go.", true); return; }
    const head = (await f.slice(0, 6000).text()).toLowerCase();
    if (!/date/.test(head) || !/status/.test(head) || !/service/.test(head)) {
      setMsg("This doesn't look like the Timely Day Sheet. Check you exported the right report.", true);
      return;
    }
    file = f;
    fname.textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
    drop.classList.add("has-file");
    btn.disabled = false;
  }

  function done(res) {
    const u = res.unmatched || {};
    result.innerHTML = `
      <div class="du-result">
        <strong>Done. ${num(res.rows)} appointments are in alltimeappts.</strong>
        <div>Took ${Math.max(1, Math.round((res.ms || 0) / 1000))} seconds${res.before ? ` · it had ${num(res.before)} rows before` : ""}.</div>
        ${res.badDates ? `<div class="du-warn">${num(res.badDates)} rows had a date that couldn't be read, so it was kept as text.</div>` : ""}
        ${u.names ? `<details><summary>${num(u.names)} patients weren't found in patientlist (${num(u.rows)} rows)</summary>
          <ul>${(u.sample || []).map((x) => `<li>${esc(x.name)} <small class="muted">(${num(x.rows)})</small></li>`).join("")}</ul>
          ${u.names > (u.sample || []).length ? '<small class="muted">Showing the ones with the most appointments.</small>' : ""}</details>` : ""}
        <div class="muted">Categories (N) and Patient IDs (O) are filled in, so you don't need to run runPrerequisite. Run the rest of your PCN scripts as usual.</div>
      </div>`;
    showToast("Day Sheet uploaded to alltimeappts");
  }

  async function run(force) {
    if (!file || running) return;
    running = true;
    let again = false;
    btn.disabled = true;
    input.disabled = true;
    btn.textContent = "Working…";
    window.addEventListener("beforeunload", guard);
    try {
      if (!packed) { setMsg("Reading the file…"); packed = await pack(file); }
      setMsg("Uploading and updating alltimeappts. This can take a couple of minutes, so keep this page open.");
      const res = await callApi({ action: "upload", op: "daysheet", fileName: file.name, gzip: packed.gzip, data: packed.data, force: force === true });
      if (res.problem) {
        setMsg(res.problem, true);
        if (res.needsForce) {
          again = await confirmDialog({ title: "Replace alltimeappts?", message: res.problem, confirmLabel: "Replace it", tone: "warning" });
        }
        return;
      }
      setMsg("");
      done(res);
      clearFile();
      showLast();
    } catch (err) {
      console.error("Day sheet upload failed:", err);
      setMsg(errText(err), true);
    } finally {
      running = false;
      input.disabled = false;
      btn.textContent = "Upload and run";
      btn.disabled = !file;
      window.removeEventListener("beforeunload", guard);
      if (again) run(true);
    }
  }

  input.addEventListener("change", () => choose(input.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("is-over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("is-over");
    if (e.dataTransfer && e.dataTransfer.files[0]) choose(e.dataTransfer.files[0]);
  });
  btn.addEventListener("click", () => run(false));
  showLast();
}

export function mountDataUploader(main) {
  main.innerHTML = `
    <div class="tb-head">
      <div>
        <h3 class="tm-h">Daily uploads</h3>
        <p class="muted tm-sub">Upload the Timely exports here. Each file goes straight into the PCN spreadsheet and isn't kept.</p>
      </div>
    </div>
    <div class="du-grid">
      ${KINDS.map(cardHtml).join("")}
      <section class="tb-card du-card is-soon">
        <h4><span class="tb-num">4</span>Run PCN update <small class="muted du-soon">Coming next</small></h4>
        <p class="muted">Updates the PCN sheet (today, past, future, cancelled, overdue and pcn_results), then syncs it to the portal.</p>
      </section>
    </div>`;
  KINDS.filter((k) => k.ready).forEach((k) => wire(main.querySelector(`[data-kind="${k.key}"]`), k));
}