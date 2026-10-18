// Task Manager → Daily uploads: Timely CSVs go straight into the PCN spreadsheet.
// The file is read here in pieces, only columns A–M are kept, and the rows go to Apps Script in batches.
// Nothing is saved anywhere.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
const KEEP = 13;                      // columns A–M (the CSV's column N is dropped)
const BATCH = 8000;                   // rows per request
const num = (n) => Number(n || 0).toLocaleString("en-AU");
const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};
const pause = () => new Promise((r) => setTimeout(r, 0));

const KINDS = [
  { key: "daysheet", title: "Day Sheet (all time)", ready: true,
    blurb: "Every appointment from Timely, including cancelled. Replaces everything in alltimeappts, then fills in the PCN category (N) and Patient ID (O)." },
  { key: "invoices", title: "Invoice Record (yesterday)", ready: false, blurb: "Yesterday's invoices from Timely." },
  { key: "packages", title: "Customer Packages", ready: false, blurb: "Patients' active packages from Timely." },
];

/* ---------- Reading the CSV in pieces (quotes, commas and new lines inside quotes) ---------- */

// Which character separates the columns (comma, semicolon or tab), from the first lines
async function sniffDelim(file) {
  const head = (await file.slice(0, 65536).text()).replace(/^\uFEFF/, "");
  const lines = head.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
  const most = (ch) => Math.max(0, ...lines.map((l) => l.split(ch).length - 1));
  const best = [",", ";", "\t"].map((ch) => [ch, most(ch)]).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : ",";
}

// Reads the CSV in pieces (quotes, separators and new lines inside quotes).
// The first 30 rows keep every column (to find the header); after that only A–M are kept.
async function readCsv(file, delim, onProgress) {
  const rows = [];
  let field = "", row = [], col = 0, fresh = true, inQ = false, afterQ = false, seen = 0, first = true, pieces = 0;
  let keep = true;
  const setKeep = () => { keep = col < KEEP || rows.length < 30; };
  const endField = () => { if (keep) row.push(field); col++; field = ""; fresh = true; setKeep(); };
  const endRow = () => {
    endField();
    if (row.some((x) => x !== "")) rows.push(row);
    row = []; col = 0; setKeep();
  };
  const eat = (text) => {
    if (first) { first = false; if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); }
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (afterQ) {                                  // just saw a quote inside quotes
        afterQ = false;
        if (c === '"') { if (keep) field += '"'; continue; } // "" = a quote mark
        inQ = false;                                 // otherwise the quoted part has ended
      }
      if (inQ) {
        if (c === '"') afterQ = true;
        else if (keep) field += c;
        continue;
      }
      if (c === '"' && fresh) { inQ = true; fresh = false; continue; }
      if (c === delim) { endField(); continue; }
      if (c === "\n") { endRow(); continue; }
      if (c === "\r") continue;
      fresh = false;
      if (keep) field += c;
    }
    seen += text.length;
    if (onProgress) onProgress(Math.min(1, seen / Math.max(1, file.size)));
  };

  if (file.stream && typeof TextDecoderStream !== "undefined") {
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      eat(value);
      if (++pieces % 20 === 0) await pause(); // lets the progress bar move
    }
  } else {
    eat(await file.text());
  }
  if (field !== "" || row.length || !fresh) endRow();
  return rows;
}

/* ---------- Sending a batch (compressed where the browser can) ---------- */

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function packJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (typeof CompressionStream === "undefined") return { gzip: false, data: toB64(bytes) };
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return { gzip: true, data: toB64(new Uint8Array(buf)) };
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
  if (d.status === "running" && d.startedAt && (!d.at || d.startedAt > d.at)) {
    return Date.now() - Date.parse(d.startedAt) > 15 * 60000
      ? `⚠ The last upload (started ${when(d.startedAt)}${d.startedBy ? ` by ${d.startedBy}` : ""}) didn't finish, so alltimeappts may be incomplete. Upload the file again.`
      : `An upload started ${when(d.startedAt)}${d.startedBy ? ` by ${d.startedBy}` : ""} is still running.`;
  }
  return d.at ? `Last uploaded ${when(d.at)}${d.by ? ` by ${d.by}` : ""} · ${num(d.rows)} rows${
    d.unmatchedNames ? ` · ${num(d.unmatchedNames)} patients not matched` : ""}` : "Not uploaded from the portal yet.";
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
        <small>The file is read here and written to the sheet. It isn't saved anywhere.</small>
      </label>
      <div class="du-acts"><button type="button" class="ff-btn is-primary" data-act="run" disabled>Upload and run</button></div>
      <div class="du-bar" data-role="bar" hidden><span></span></div>
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
  const bar = card.querySelector('[data-role="bar"]');
  const msg = card.querySelector('[data-role="msg"]');
  const result = card.querySelector('[data-role="result"]');
  const lastEl = card.querySelector('[data-role="last"]');
  let file = null, running = false;

  const setMsg = (t, bad = false) => { msg.textContent = t || ""; msg.classList.toggle("is-bad", bad); };
  const setBar = (p) => { bar.hidden = p === null; if (p !== null) bar.firstElementChild.style.width = `${Math.round(p * 100)}%`; };
  const guard = (e) => { e.preventDefault(); e.returnValue = ""; };
  const showLast = () => getDoc(doc(db, "data_uploads", k.key))
    .then((s) => { if (card.isConnected) lastEl.textContent = s.exists() ? lastLine(s.data()) : "Not uploaded from the portal yet."; })
    .catch(() => { lastEl.textContent = ""; });
  const clearFile = () => {
    file = null; input.value = "";
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
    if (f.size > MAX_BYTES) { setMsg("That file is over 1 GB. Check it's the Day Sheet export.", true); return; }
    const head = (await f.slice(0, 6000).text()).toLowerCase();
    if (!/date/.test(head) || !/status/.test(head) || !/service/.test(head)) {
      setMsg("This doesn't look like the Timely Day Sheet. Check you exported the right report.", true);
      return;
    }
    file = f;
    fname.textContent = `${f.name} · ${(f.size / 1048576).toFixed(0)} MB`;
    drop.classList.add("has-file");
    btn.disabled = false;
  }

  // One request, tried twice if the connection drops
  async function send(payload) {
    try { return await callApi(payload); }
    catch (err) {
      if (err && err.code) throw err;
      await new Promise((r) => setTimeout(r, 2000));
      return callApi(payload);
    }
  }

  function done(res, sum) {
    const sample = Object.keys(sum.unmatched).sort((a, b) => sum.unmatched[b] - sum.unmatched[a]).slice(0, 20);
    result.innerHTML = `
      <div class="du-result">
        <strong>Done. ${num(res.rows)} appointments are in alltimeappts.</strong>
        <div>Took ${Math.max(1, Math.round((res.ms || 0) / 1000))} seconds${res.before ? ` · it had ${num(res.before)} rows before` : ""}.</div>
        ${sum.badDates ? `<div class="du-warn">${num(sum.badDates)} rows had a date that couldn't be read, so it was kept as text.</div>` : ""}
        ${sum.unmatchedNames ? `<details><summary>${num(sum.unmatchedNames)} patients weren't found in patientlist (${num(sum.unmatchedRows)} rows)</summary>
          <ul>${sample.map((n) => `<li>${esc(n)} <small class="muted">(${num(sum.unmatched[n])})</small></li>`).join("")}</ul>
          ${sum.unmatchedNames > sample.length ? '<small class="muted">Showing the ones with the most appointments.</small>' : ""}</details>` : ""}
        <div class="muted">Categories (N) and Patient IDs (O) are filled in, so you don't need to run runPrerequisite. Run the rest of your PCN scripts as usual.</div>
      </div>`;
    showToast("Day Sheet uploaded to alltimeappts");
  }

  async function run() {
    if (!file || running) return;
    running = true;
    btn.disabled = true;
    input.disabled = true;
    btn.textContent = "Working…";
    result.innerHTML = "";
    window.addEventListener("beforeunload", guard);
    let wroteSome = false;
    try {
      // 1. Read the file (only A–M kept)
      setMsg("Reading the file…");
      setBar(0);
      const delim = await sniffDelim(file);
      const all = await readCsv(file, delim, (p) => { setBar(p * 0.3); setMsg(`Reading the file… ${Math.round(p * 100)}%`); });

      // The header: the first row (of 30) that has a date, a status and a service column, wherever they are
      // Timely names some columns "Textbox14" etc., so the header is found by the ones with real names (G, H and J)
      const isHeader = (r) => /^\s*start\s*time\s*$/i.test(r[6] || "") && /^\s*status\s*$/i.test(r[7] || "") && /service/i.test(r[9] || "");
      const h = all.slice(0, 30).findIndex(isHeader);
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const list = (r) => r.slice(0, 20).map((c, i) => `${letters[i]}: ${String(c || "").slice(0, 30) || "(blank)"}`).join(" · ");
      const sepName = delim === "," ? "commas" : delim === ";" ? "semicolons" : "tabs";
      if (h < 0) {
        throw new Error(`Couldn't find the header row (separated by ${sepName}). The file starts with ${list(all[0] || [])}. ` +
          "Nothing was changed. Copy this message for whoever looks after the portal.");
      }
      // Column A must hold dates: check the first few appointments rather than the header's name
      const sample = all.slice(h + 1, h + 21).filter((r) => String(r[0] || "").trim());
      const datey = sample.filter((r) => /\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(String(r[0]))).length;
      if (sample.length && datey < sample.length / 2) {
        throw new Error(`Column A doesn't look like appointment dates (it starts with "${String(sample[0][0]).slice(0, 30)}"). ` +
          `The header row has ${list(all[h])}. Nothing was changed. Copy this message for whoever looks after the portal.`);
      }
      const rows = all.slice(h + 1).map((r) => { r = r.slice(0, KEEP); while (r.length < KEEP) r.push(""); return r; });
      all.length = 0;
      if (!rows.length) throw new Error("The file has no appointments in it.");

      // 2. Start (clears A2:R)
      setMsg(`Found ${num(rows.length)} appointments. Getting alltimeappts ready…`);
      let start = await send({ action: "upload", op: "daysheetStart", total: rows.length, fileName: file.name });
      if (start.needsForce) {
        const ok = await confirmDialog({ title: "Replace alltimeappts?", message: start.problem, confirmLabel: "Replace it", tone: "warning" });
        if (!ok) { setMsg("Nothing was changed."); setBar(null); return; }
        start = await send({ action: "upload", op: "daysheetStart", total: rows.length, fileName: file.name, force: true });
      }
      if (start.problem) throw new Error(start.problem);
      wroteSome = true;

      // 3. The rows, in batches
      const sum = { unmatched: {}, badDates: 0 };
      for (let i = 0; i < rows.length; i += BATCH) {
        const part = rows.slice(i, i + BATCH);
        setMsg(`Writing ${num(Math.min(i + part.length, rows.length))} of ${num(rows.length)}… keep this page open.`);
        const packed = await packJson(part);
        const res = await send({ action: "upload", op: "daysheetChunk", token: start.token, offset: i, gzip: packed.gzip, data: packed.data });
        if (res.problem) throw new Error(res.problem);
        sum.badDates += Number(res.badDates || 0);
        Object.entries(res.unmatched || {}).forEach(([n, c]) => { sum.unmatched[n] = (sum.unmatched[n] || 0) + Number(c || 0); });
        setBar(0.3 + 0.7 * ((i + part.length) / rows.length));
      }
      sum.unmatchedNames = Object.keys(sum.unmatched).length;
      sum.unmatchedRows = Object.values(sum.unmatched).reduce((a, b) => a + b, 0);

      // 4. Finish
      const fin = await send({ action: "upload", op: "daysheetFinish", token: start.token,
        summary: { badDates: sum.badDates, unmatchedNames: sum.unmatchedNames, unmatchedRows: sum.unmatchedRows } });
      if (fin.problem) throw new Error(fin.problem);
      setMsg("");
      setBar(null);
      done(fin, sum);
      clearFile();
    } catch (err) {
      console.error("Day sheet upload failed:", err);
      setBar(null);
      setMsg(errText(err) + (wroteSome ? " alltimeappts is only partly filled, so upload the file again." : ""), true);
    } finally {
      running = false;
      input.disabled = false;
      btn.textContent = "Upload and run";
      btn.disabled = !file;
      window.removeEventListener("beforeunload", guard);
      showLast();
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
  btn.addEventListener("click", run);
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