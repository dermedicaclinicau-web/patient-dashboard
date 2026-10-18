// Task Manager → Daily uploads: Timely CSVs go straight into the clinic spreadsheets.
// The file is read here in pieces and only the columns needed are sent. Nothing is saved anywhere.
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
const KEEP = 13;                      // columns A–M
const BATCH = 8000;                   // Day Sheet rows per request
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const num = (n) => Number(n || 0).toLocaleString("en-AU");
const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};
const day = (key) => {
  const d = new Date(`${key}T12:00:00`);
  return isNaN(d) ? key : d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
};
const pause = () => new Promise((r) => setTimeout(r, 0));

const KINDS = [
  { key: "daysheet", title: "Day Sheet (all time)", ready: true, sniff: [/status/, /service/],
    blurb: "Every appointment from Timely, including cancelled. Replaces everything in alltimeappts, then fills in the PCN category (N) and Patient ID (O)." },
  { key: "invoices", title: "Invoice Record (yesterday)", ready: true, sniff: [/invoice/, /customer/, /description|product/],
    blurb: "Yesterday's invoices from Timely. Added to the bottom of INVOICE RECORD (invoices already there are skipped), with Patient IDs and tidy product names." },
  { key: "packages", title: "Customer Packages", ready: true, sniff: [/customer/, /package/],
    blurb: "Patients' packages from Timely. Replaces everything in customer_packages (A to M), then fills in the Patient ID (M)." },
];

/* ---------- Reading the CSV ---------- */

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
      if (afterQ) {
        afterQ = false;
        if (c === '"') { if (keep) field += '"'; continue; }
        inQ = false;
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
      if (++pieces % 20 === 0) await pause();
    }
  } else {
    eat(await file.text());
  }
  if (field !== "" || row.length || !fresh) endRow();
  return rows;
}

const colList = (r) => (r || []).slice(0, 20).map((c, i) => `${LETTERS[i]}: ${String(c || "").slice(0, 30) || "(blank)"}`).join(" · ");
function headerError(all, delim, expect) {
  const sep = delim === "," ? "commas" : delim === ";" ? "semicolons" : "tabs";
  return new Error(`Couldn't find the header row (expected ${expect}; separated by ${sep}). The file starts with ${colList(all[0])}. ` +
    "Nothing was changed. Copy this message for whoever looks after the portal.");
}

/* ---------- Sending (compressed where the browser can) ---------- */

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

function lastLine(d, k) {
  if (d.status === "running" && d.startedAt && (!d.at || d.startedAt > d.at)) {
    return Date.now() - Date.parse(d.startedAt) > 15 * 60000
      ? `⚠ The last upload (started ${when(d.startedAt)}${d.startedBy ? ` by ${d.startedBy}` : ""}) didn't finish, so alltimeappts may be incomplete. Upload the file again.`
      : `An upload started ${when(d.startedAt)}${d.startedBy ? ` by ${d.startedBy}` : ""} is still running.`;
  }
  if (!d.at) return "Not uploaded from the portal yet.";
  const what = k.key === "invoices" ? `${num(d.rows)} lines added${d.to ? ` (to ${day(d.to)})` : ""}`
    : k.key === "packages" ? `${num(d.rows)} package lines` : `${num(d.rows)} rows`;
  return `Last uploaded ${when(d.at)}${d.by ? ` by ${d.by}` : ""} · ${what}${d.unmatchedNames ? ` · ${num(d.unmatchedNames)} patients not matched` : ""}`;
}

/* ---------- 4) Run PCN update ---------- */

const PCN_STEPS = [
  ["visits", "Today's, past and future visits"],
  ["overdue", "Overdue list and cancelled appointments"],
  ["results1", "Pre-consult: today, future visits, overdue, Skin Script, packages"],
  ["results2", "Pre-consult: Wrinkle Relaxer, Filler, RestoraGlow, Laser, Firm"],
  ["results3", "Pre-consult: all past visits, Other Injectables, Body, Hydra, Collagen"],
  ["sync", "Send it to the portal"],
];

function pcnCardHtml(n) {
  return `
    <section class="tb-card du-card" data-kind="pcn">
      <h4><span class="tb-num">${n}</span>Run PCN update</h4>
      <p class="muted">Rebuilds pcn_appts_today, past_visits, future-visits, overduecategory, cancelled_appointments and pcn_results
        from alltimeappts, then sends it to the portal. Upload today's Day Sheet and Customer Packages first.</p>
      <ol class="du-steps">${PCN_STEPS.map(([k, label]) =>
        `<li data-step="${k}"><span class="du-step-dot"></span><span>${esc(label)}</span><small class="muted" data-role="t"></small></li>`).join("")}</ol>
      <div class="du-acts"><button type="button" class="ff-btn is-primary" data-act="pcn">Run PCN update</button></div>
      <p class="du-msg" data-role="msg" aria-live="polite"></p>
      <small class="muted" data-role="last"></small>
    </section>`;
}

function wirePcn(card) {
  const btn = card.querySelector('[data-act="pcn"]');
  const msg = card.querySelector('[data-role="msg"]');
  const lastEl = card.querySelector('[data-role="last"]');
  const items = [...card.querySelectorAll("[data-step]")];
  let running = false;
  const setMsg = (t, bad = false) => { msg.textContent = t || ""; msg.classList.toggle("is-bad", bad); };
  const guard = (e) => { e.preventDefault(); e.returnValue = ""; };
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Perth" });
  const keyOf = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Perth" }) : "");

  const showLast = () => Promise.all([getDoc(doc(db, "data_uploads", "pcn")), getDoc(doc(db, "data_uploads", "daysheet"))])
    .then(([p, ds]) => {
      if (!card.isConnected) return;
      const d = p.exists() ? p.data() : {};
      const parts = [];
      if (d.status === "running" && d.startedAt && Date.now() - Date.parse(d.startedAt) < 15 * 60000) {
        parts.push(`Running now (started ${when(d.startedAt)}${d.startedBy ? ` by ${d.startedBy}` : ""}).`);
      } else if (d.status === "failed") {
        parts.push(`⚠ The last run stopped ${when(d.failedAt)}: ${d.error || "it failed"}.`);
      } else if (d.at) {
        parts.push(`Last run ${when(d.at)}${d.by ? ` by ${d.by}` : ""} · ${Math.max(1, Math.round((d.ms || 0) / 1000))} seconds.`);
      } else {
        parts.push("Not run from the portal yet.");
      }
      const dsAt = ds.exists() ? ds.data().at : "";
      if (keyOf(dsAt) !== todayKey) parts.push("⚠ Today's Day Sheet hasn't been uploaded yet.");
      lastEl.textContent = parts.join(" ");
    })
    .catch(() => { lastEl.textContent = ""; });

  async function run() {
    if (running) return;
    running = true;
    btn.disabled = true;
    btn.textContent = "Running…";
    items.forEach((li) => { li.className = ""; li.querySelector('[data-role="t"]').textContent = ""; });
    setMsg("Keep this page open. It usually takes a few minutes.");
    window.addEventListener("beforeunload", guard);
    let token = "";
    let cur = null;
    try {
      for (const [step] of PCN_STEPS) {
        cur = card.querySelector(`[data-step="${step}"]`);
        cur.classList.add("is-run");
        const res = await callApi({ action: "upload", op: "pcnStep", step, token });
        if (res.problem) throw new Error(res.problem);
        token = res.token || token;
        cur.classList.remove("is-run");
        cur.classList.add("is-done");
        const later = step === "sync" && res.info && res.info.later;
        cur.querySelector('[data-role="t"]').textContent =
          later ? "at the next sync" : `${Math.max(1, Math.round((res.ms || 0) / 1000))}s`;
        if (res.done) {
          setMsg(`Done in ${Math.max(1, Math.round((res.totalMs || 0) / 1000))} seconds.` +
            (later ? " Another job was running, so the portal gets it at the next sync." : " The portal is up to date."));
          showToast("PCN update finished");
        }
      }
    } catch (err) {
      console.error("PCN update failed:", err);
      if (cur) { cur.classList.remove("is-run"); cur.classList.add("is-bad"); }
      setMsg(errText(err), true);
    } finally {
      running = false;
      btn.disabled = false;
      btn.textContent = "Run PCN update";
      window.removeEventListener("beforeunload", guard);
      showLast();
    }
  }

  btn.addEventListener("click", run);
  showLast();
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
  let file = null, running = false, wroteSome = false;

  const setMsg = (t, bad = false) => { msg.textContent = t || ""; msg.classList.toggle("is-bad", bad); };
  const setBar = (p) => { bar.hidden = p === null; if (p !== null) bar.firstElementChild.style.width = `${Math.round(p * 100)}%`; };
  const guard = (e) => { e.preventDefault(); e.returnValue = ""; };
  const showLast = () => getDoc(doc(db, "data_uploads", k.key))
    .then((s) => { if (card.isConnected) lastEl.textContent = s.exists() ? lastLine(s.data(), k) : "Not uploaded from the portal yet."; })
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
    if (f.size > MAX_BYTES) { setMsg("That file is over 1 GB. Check it's the right export.", true); return; }
    const head = (await f.slice(0, 6000).text()).toLowerCase();
    if (!k.sniff.every((re) => re.test(head))) {
      setMsg(`This doesn't look like the Timely ${k.title.replace(/\s*\(.*\)$/, "")} export. Check you exported the right report.`, true);
      return;
    }
    file = f;
    fname.textContent = `${f.name} · ${f.size > 1048576 ? `${(f.size / 1048576).toFixed(0)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}`;
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

  async function readFile(share) {
    setMsg("Reading the file…");
    setBar(0);
    const delim = await sniffDelim(file);
    const all = await readCsv(file, delim, (p) => { setBar(p * share); setMsg(`Reading the file… ${Math.round(p * 100)}%`); });
    return { all, delim };
  }

  /* ---------- 1) Day Sheet ---------- */

  async function runDaySheet() {
    const { all, delim } = await readFile(0.3);
    // Timely names some columns "Textbox14" etc., so the header is found by the ones with real names (G, H and J)
    const isHeader = (r) => /^\s*start\s*time\s*$/i.test(r[6] || "") && /^\s*status\s*$/i.test(r[7] || "") && /service/i.test(r[9] || "");
    const h = all.slice(0, 30).findIndex(isHeader);
    if (h < 0) throw headerError(all, delim, "StartTime in G, Status in H, ServiceName in J");
    const sample = all.slice(h + 1, h + 21).filter((r) => String(r[0] || "").trim());
    const datey = sample.filter((r) => /\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(String(r[0]))).length;
    if (sample.length && datey < sample.length / 2) {
      throw new Error(`Column A doesn't look like appointment dates (it starts with "${String(sample[0][0]).slice(0, 30)}"). ` +
        `The header row has ${colList(all[h])}. Nothing was changed. Copy this message for whoever looks after the portal.`);
    }
    const rows = all.slice(h + 1).map((r) => { r = r.slice(0, KEEP); while (r.length < KEEP) r.push(""); return r; });
    all.length = 0;
    if (!rows.length) throw new Error("The file has no appointments in it.");

    setMsg(`Found ${num(rows.length)} appointments. Getting alltimeappts ready…`);
    let start = await send({ action: "upload", op: "daysheetStart", total: rows.length, fileName: file.name });
    if (start.needsForce) {
      const ok = await confirmDialog({ title: "Replace alltimeappts?", message: start.problem, confirmLabel: "Replace it", tone: "warning" });
      if (!ok) { setMsg("Nothing was changed."); setBar(null); return; }
      start = await send({ action: "upload", op: "daysheetStart", total: rows.length, fileName: file.name, force: true });
    }
    if (start.problem) throw new Error(start.problem);
    wroteSome = true;

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

    const fin = await send({ action: "upload", op: "daysheetFinish", token: start.token,
      summary: { badDates: sum.badDates, unmatchedNames: sum.unmatchedNames, unmatchedRows: sum.unmatchedRows } });
    if (fin.problem) throw new Error(fin.problem);
    setMsg("");
    setBar(null);
    doneDaySheet(fin, sum);
    clearFile();
  }

  function doneDaySheet(res, sum) {
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

  /* ---------- 2) Invoice Record ---------- */

  async function runInvoices() {
    const { all, delim } = await readFile(0.4);
    const isHeader = (r) => /invoice/i.test(r[0] || "") && /customer/i.test(r[2] || "") && /description|product/i.test(r[6] || "");
    const h = all.slice(0, 30).findIndex(isHeader);
    if (h < 0) throw headerError(all, delim, "InvoiceIdSequential in A, CustomerName in C, Description in G");
    // CSV A, B, C, E, G → INVOICE RECORD A, B, C, E, F (D, the Patient ID, is filled in by Apps Script)
    const rows = all.slice(h + 1)
      .map((r) => [r[0], r[1], r[2], r[4], r[6]].map((c) => String(c ?? "").trim()))
      .filter((r) => r.some(Boolean));
    if (!rows.length) throw new Error("The file has no invoices in it.");

    setMsg(`Found ${num(rows.length)} lines. Adding the new ones to INVOICE RECORD…`);
    setBar(0.5);
    const packed = await packJson(rows);
    const payload = { action: "upload", op: "invoices", fileName: file.name, gzip: packed.gzip, data: packed.data };
    let res = await send(payload);
    if (res.needsForce) {
      const ok = await confirmDialog({ title: "Add these invoices?", message: res.problem, confirmLabel: "Add them", tone: "warning" });
      if (!ok) { setMsg("Nothing was changed."); setBar(null); return; }
      res = await send(Object.assign({}, payload, { force: true }));
    }
    if (res.problem) throw new Error(res.problem);

    res.synced = "none";
    if (res.rows) {
      setMsg("Updating the portal's skincare records…");
      setBar(0.8);
      try {
        const s = await send({ action: "upload", op: "invoicesSync" });
        res.synced = s.later ? "later" : "done";
      } catch (e) {
        console.warn("Skincare sync after upload failed:", e);
        res.synced = "failed";
      }
    }
    setMsg("");
    setBar(null);
    doneInvoices(res);
    clearFile();
  }

  function doneInvoices(res) {
    const range = res.from ? (res.from === res.to ? day(res.from) : `${day(res.from)} to ${day(res.to)}`) : "";
    const list = (o) => ((o && o.sample) || []).map((x) => `<li>${esc(x.name)} <small class="muted">(${num(x.rows)})</small></li>`).join("");
    const plural = (n, w) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
    const sync = {
      done: "The portal's skincare records are updated, so purchases and Email Flows can see them now.",
      later: "Another job was running, so the portal will pick these up at the next sync.",
      failed: "The portal couldn't be updated just now. The daily sync will pick these up.",
    }[res.synced] || "";
    result.innerHTML = `
      <div class="du-result">
        ${res.rows
          ? `<strong>Done. ${plural(res.rows, "product line")} added to INVOICE RECORD (rows ${num(res.startRow)}–${num(res.endRow)}).</strong>`
          : "<strong>Nothing new to add. Every invoice in this file is already in INVOICE RECORD.</strong>"}
        ${range ? `<div>Invoices from ${esc(range)}.</div>` : ""}
        ${res.skippedInvoices ? `<div>${plural(res.skippedInvoices, "invoice")} already in the sheet, so skipped.</div>` : ""}
        ${res.noProduct ? `<div class="muted">${plural(res.noProduct, "line")} had no product (services and the like), so left out.</div>` : ""}
        ${res.badDates ? `<div class="du-warn">${plural(res.badDates, "line")} had a date that couldn't be read, so it was kept as text.</div>` : ""}
        ${res.rows ? `<div>Patient IDs filled in for ${num(res.matched)} of ${num(res.rows)} lines.</div>` : ""}
        ${res.ambiguous && res.ambiguous.names ? `<details><summary>${plural(res.ambiguous.names, "name")} matched more than one patient, so Patient ID was left blank</summary><ul>${list(res.ambiguous)}</ul></details>` : ""}
        ${res.unmatched && res.unmatched.names ? `<details><summary>${plural(res.unmatched.names, "name")} weren't found in PTT LIST</summary><ul>${list(res.unmatched)}</ul></details>` : ""}
        ${sync ? `<div class="muted">${esc(sync)}</div>` : ""}
      </div>`;
    showToast(res.rows ? "Invoices added to INVOICE RECORD" : "No new invoices to add");
  }

  /* ---------- 3) Customer Packages ---------- */

  async function runPackages() {
    const { all, delim } = await readFile(0.5);
    const isHeader = (r) => /customer/i.test(r[0] || "") && /package/i.test(r[1] || "") && /service/i.test(r[6] || "");
    const h = all.slice(0, 30).findIndex(isHeader);
    if (h < 0) throw headerError(all, delim, "CustomerName in A, PackageName in B, Service Name in G");
    const rows = all.slice(h + 1)
      .map((r) => { r = r.slice(0, 12).map((c) => String(c ?? "").trim()); while (r.length < 12) r.push(""); return r; })
      .filter((r) => r.some(Boolean));
    if (!rows.length) throw new Error("The file has no packages in it.");

    setMsg(`Found ${num(rows.length)} package lines. Replacing customer_packages…`);
    setBar(0.6);
    const packed = await packJson(rows);
    const payload = { action: "upload", op: "packages", fileName: file.name, gzip: packed.gzip, data: packed.data };
    let res = await send(payload);
    if (res.needsForce) {
      const ok = await confirmDialog({ title: "Replace customer_packages?", message: res.problem, confirmLabel: "Replace it", tone: "warning" });
      if (!ok) { setMsg("Nothing was changed."); setBar(null); return; }
      res = await send(Object.assign({}, payload, { force: true }));
    }
    if (res.problem) throw new Error(res.problem);
    setMsg("");
    setBar(null);
    donePackages(res);
    clearFile();
  }

  function donePackages(res) {
    const list = (o) => ((o && o.sample) || []).map((x) => `<li>${esc(x.name)} <small class="muted">(${num(x.rows)})</small></li>`).join("");
    const plural = (n, w) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
    result.innerHTML = `
      <div class="du-result">
        <strong>Done. ${plural(res.rows, "package line")} are in customer_packages.</strong>
        <div>Took ${Math.max(1, Math.round((res.ms || 0) / 1000))} seconds${res.before ? ` · it had ${num(res.before)} rows before` : ""}.</div>
        <div>Patient IDs filled in for ${num(res.matched)} of ${num(res.rows)} lines.</div>
        ${res.badDates ? `<div class="du-warn">${plural(res.badDates, "line")} had an expiry date that couldn't be read, so it was kept as text.</div>` : ""}
        ${res.ambiguous && res.ambiguous.names ? `<details><summary>${plural(res.ambiguous.names, "name")} matched more than one patient, so Patient ID was left blank</summary><ul>${list(res.ambiguous)}</ul></details>` : ""}
        ${res.unmatched && res.unmatched.names ? `<details><summary>${plural(res.unmatched.names, "name")} weren't found in patientlist</summary><ul>${list(res.unmatched)}</ul></details>` : ""}
      </div>`;
    showToast("Customer Packages uploaded");
  }
  
  /* ---------- Run ---------- */

  async function run() {
    if (!file || running) return;
    running = true;
    wroteSome = false;
    btn.disabled = true;
    input.disabled = true;
    btn.textContent = "Working…";
    result.innerHTML = "";
    window.addEventListener("beforeunload", guard);
    try {
      if (k.key === "daysheet") await runDaySheet();
      else if (k.key === "invoices") await runInvoices();
      else if (k.key === "packages") await runPackages();
    } catch (err) {
      console.error(`${k.key} upload failed:`, err);
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
        <p class="muted tm-sub">Upload the Timely exports here. Each file goes straight into the clinic spreadsheets and isn't kept.</p>
      </div>
    </div>
    <div class="du-grid">
      ${KINDS.map(cardHtml).join("")}
      ${pcnCardHtml(KINDS.length + 1)}
    </div>`;
  KINDS.filter((k) => k.ready).forEach((k) => wire(card(main, k), k));
  wirePcn(main.querySelector('[data-kind="pcn"]'));
}
const card = (main, k) => main.querySelector(`[data-kind="${k.key}"]`);