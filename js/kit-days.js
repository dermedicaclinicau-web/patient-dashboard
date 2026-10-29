// Inventory → Kits → Kit days: one injector's day, from the start count to the end count.
// Everything that went into and out of their kit, who each unit was used on, and whether it adds up.
// The portal's records and the old app's (StartOfDayLog sheet + wr_treatment_record) are shown together.
import { listProducts, isKitProduct, kitDayLedger, dayKey } from "./inventory-api.js";
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const fmt = (n) => String(r1(n));
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (k, n) => { const d = keyDate(k); d.setDate(d.getDate() + n); return dayKey(d); };
const niceDay = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : ""; };
const timeOf = (d) => (d instanceof Date && !isNaN(d) ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
const atTime = (key, hhmm) => { if (!/^\d{2}:\d{2}$/.test(hhmm || "")) return null; const d = new Date(`${key}T${hhmm}:00`); return isNaN(d) ? null : d; };
const OLD = '<span class="kd-tag">Old app</span>';

// canAll: choose any injector (Admins and JT approvers). Otherwise only the person logged in.
export async function openKitDays({ staff, canAll = false, staffUid = "", date = "" } = {}) {
  const st = { uid: staffUid || staff.uid, key: date || dayKey(), products: null, seq: 0 };
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog kd-dlg";
  dlg.innerHTML = `
    <div class="kd-head"><h3>Kit days</h3><span class="inv-spacer"></span>
      <button type="button" class="hx-x" data-act="close" aria-label="Close">×</button></div>
    <div class="kd-tools">
      ${canAll ? '<select class="fb-select" data-f="who" aria-label="Injector"><option>Loading staff…</option></select>' : ""}
      <button type="button" class="lh-btn is-quiet" data-act="prev" aria-label="Previous day">‹</button>
      <input type="date" class="fe-input" data-f="date" max="${dayKey()}" value="${st.key}" aria-label="Day" />
      <button type="button" class="lh-btn is-quiet" data-act="next" aria-label="Next day">›</button>
      <button type="button" class="rc-link" data-act="today">Today</button>
    </div>
    <div data-role="body"><div class="skeleton sm"></div></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  const body = dlg.querySelector('[data-role="body"]');
  const dateIn = dlg.querySelector('[data-f="date"]');

  if (canAll) {
    callApi({ action: "staffList" }).then((r) => {
      const list = (r && Array.isArray(r.staff) ? r.staff : []).filter((s) => s.name);
      const opt = (s) => `<option value="${esc(s.id)}"${s.id === st.uid ? " selected" : ""}>${esc(s.name)}</option>`;
      const inj = list.filter((s) => s.injector), rest = list.filter((s) => !s.injector);
      dlg.querySelector('[data-f="who"]').innerHTML =
        `${inj.length ? `<optgroup label="Injectors">${inj.map(opt).join("")}</optgroup>` : ""}${
          rest.length ? `<optgroup label="Everyone else">${rest.map(opt).join("")}</optgroup>` : ""}`;
    }).catch(() => {});
  }

  function go(key) {
    if (!key || key > dayKey()) return;
    st.key = key;
    dateIn.value = key;
    load();
  }
  dlg.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "close") dlg.close();
    if (a.dataset.act === "prev") go(addDays(st.key, -1));
    if (a.dataset.act === "next") go(addDays(st.key, 1));
    if (a.dataset.act === "today") go(dayKey());
  });
  dlg.addEventListener("change", (e) => {
    if (e.target.dataset.f === "date") go(e.target.value);
    if (e.target.dataset.f === "who") { st.uid = e.target.value; load(); }
  });

  async function load() {
    const my = ++st.seq;
    body.innerHTML = '<div class="skeleton sm"></div>';
    try {
      if (!st.products) st.products = (await listProducts()).filter((p) => isKitProduct(p));
      const [mine, old] = await Promise.all([
        kitDayLedger(st.uid, st.key),
        callApi({ action: "inventory", op: "kitDay", staffUid: st.uid, date: st.key })
          .catch((e) => ({ problem: (e && e.message) || "The old app's records couldn't be read." })),
      ]);
      if (my !== st.seq || !dlg.isConnected) return;
      body.innerHTML = draw(mine, old || {});
    } catch (err) {
      console.error("Kit day failed:", err);
      if (my === st.seq) {
        body.innerHTML = `<div class="tm-empty is-error">${esc(err && err.code === "permission-denied"
          ? "Your access doesn't include this injector's kit." : "Couldn't load this day. Try again.")}</div>`;
      }
    }
  }

  function draw(mine, old) {
    const kitPs = st.products || [];
    const legacyP = kitPs.find((p) => /xeomin/i.test(p.name)) || kitPs[0] || null;
    const groups = new Map();
    const g = (pid) => {
      if (!groups.has(pid)) {
        groups.set(pid, { p: kitPs.find((x) => x.id === pid) || { id: pid, name: "Product", doseUnit: "units" },
          lines: [], start: null, end: null });
      }
      return groups.get(pid);
    };

    // The portal: Start / End of Day counts, and everything in between
    const day = mine.day;
    if (day && day.start) (day.start.items || []).forEach((it) => {
      g(it.productId).start = { value: Number(it.counted) || 0, at: day.start.at, batches: (it.rows || []).map((x) => x.batch).filter(Boolean) };
    });
    if (day && day.end) (day.end.items || []).forEach((it) => {
      g(it.productId).end = { value: Number(it.counted) || 0, at: day.end.at };
    });
    (mine.events || []).forEach((e) => g(e.productId).lines.push(e));

    // The old app: StartOfDayLog and its Wrinkle Relaxer records
    const sheet = Array.isArray(old.sheet) ? old.sheet : [];
    const wr = Array.isArray(old.wr) ? old.wr : [];
    if (legacyP && (sheet.length || wr.length)) {
      const L = g(legacyP.id);
      const sod = sheet.filter((r) => r.kind === "SOD");
      if (!L.start && sod.length) {
        L.start = { value: sod.reduce((a, r) => a + r.count, 0), old: true,
          batches: [...new Set(sod.map((r) => r.batch).filter((b) => b && b !== "N/A"))] };
      }
      sheet.forEach((r) => {
        const at = r.at ? new Date(r.at) : null;
        const base = { at, batch: r.batch && r.batch !== "N/A" ? r.batch : "", old: true, countsInKit: true };
        if (r.kind === "RESTOCK") L.lines.push({ ...base, units: r.count, text: "Restock: new vial" });
        else if (r.kind === "BORROW-IN") L.lines.push({ ...base, units: r.count, text: `Taken from a colleague${r.note ? ` (${r.note})` : ""}` });
        else if (r.kind === "BORROW-OUT") L.lines.push({ ...base, units: -r.count, text: `Taken by a colleague${r.note ? ` (${r.note})` : ""}` });
        else if (r.kind === "VOID") L.lines.push({ ...base, units: 0, info: true, text: r.note || "A restock was voided" });
      });
      wr.forEach((w) => L.lines.push({
        at: atTime(st.key, w.time), units: -w.units, kind: "use", old: true, countsInKit: true,
        patientName: w.patientName, formName: "Wrinkle Relaxer record",
        areas: w.lines.map((d) => `${d.area} ${fmt(d.units)}`).join(", "),
        batch: [...new Set(w.lines.map((d) => d.batch).filter(Boolean))].join(", "),
      }));
      if (!L.end && old.next) L.end = { value: old.next.count, old: true, nextDate: old.next.date };
    }

    const name = old.staffName || "This injector";
    const notes = [
      day && day.start && day.start.notInjecting ? `<p class="kd-note">${esc(name)} said they weren't injecting today.</p>` : "",
      old.problem ? `<p class="kd-note is-warn">Old app: ${esc(old.problem)}</p>` : "",
    ].join("");
    if (!groups.size) {
      return `${notes}<div class="tm-empty">Nothing recorded for ${esc(name)} on ${esc(niceDay(st.key))}.</div>`;
    }
    return notes + [...groups.values()].map((G) => section(G, name)).join("");
  }

  function lineHtml(x, u) {
    const tags = [
      x.old ? OLD : "", x.paper ? '<span class="kd-tag">Paper</span>' : "",
      x.batch ? `<span class="kd-tag">Batch ${esc(x.batch)}</span>` : "",
      x.status ? `<span class="kd-tag">${esc(x.status === "unconfirmed" ? "Waiting for confirmation" : x.status === "disputed" ? "Disputed" : "Confirmed")}</span>` : "",
      x.short > 0 ? `<span class="kd-tag is-warn">Saved short by ${fmt(x.short)}</span>` : "",
      x.fromOtherKit ? '<span class="kd-tag">From a colleague\'s kit, not this one</span>'
        : x.countsInKit === false ? `<span class="kd-tag">From ${x.from === "shelf" ? "the Shelf's" : "JT storage's"} opened vial, not a kit</span>` : "",
    ].join("");
    let main;
    if (x.kind === "use") {
      const who = x.patientId
        ? `<a href="#/patient/${encodeURIComponent(x.patientId)}" target="_blank" rel="noopener">${esc(x.patientName || "a patient")}</a>`
        : `<strong>${esc(x.patientName || "a patient")}</strong>`;
      const form = x.submissionId
        ? `<a href="#/form-record/${encodeURIComponent(x.submissionId)}" target="_blank" rel="noopener">${esc(x.formName || "record")}</a>`
        : esc(x.formName || "");
      main = `Used on ${who}${form ? ` · ${form}` : ""}${x.areas ? `<small>${esc(x.areas)}</small>` : ""}`;
    } else {
      main = esc(x.text || "");
    }
    const amt = x.info ? "" : `<span class="kd-n ${x.units > 0 ? "is-in" : "is-out"}${x.countsInKit === false ? " is-off" : ""}">${signed(x.units)}</span>`;
    return `<div class="kd-row${x.info ? " is-info" : ""}"><span class="kd-t">${esc(timeOf(x.at))}</span>
      <span class="kd-main">${main}${tags ? `<span class="kd-tags">${tags}</span>` : ""}</span>${amt}</div>`;
  }

  function section(G, name) {
    const u = G.p.doseUnit || "units";
    const lines = G.lines.slice().sort((a, b) => (a.at ? a.at.getTime() : 9e15) - (b.at ? b.at.getTime() : 9e15));
    const counted = lines.filter((x) => !x.info && x.countsInKit !== false && x.units);
    const sum = r1(counted.reduce((a, x) => a + x.units, 0));
    const expected = G.start ? r1(G.start.value + sum) : null;
    const diff = expected !== null && G.end ? r1(G.end.value - expected) : null;
    const usedOn = lines.filter((x) => x.kind === "use");
    const usedTotal = r1(-usedOn.reduce((a, x) => a + x.units, 0));
    const patients = new Set(usedOn.map((x) => x.patientName)).size;

    const startRow = G.start
      ? `<div class="kd-row is-count"><span class="kd-t">${esc(timeOf(G.start.at))}</span>
          <span class="kd-main"><strong>Start of day count</strong><span class="kd-tags">${G.start.old ? OLD : ""}${
            G.start.batches && G.start.batches.length ? `<span class="kd-tag">Batch ${esc(G.start.batches.join(", "))}</span>` : ""}</span></span>
          <span class="kd-n">${fmt(G.start.value)} ${esc(u)}</span></div>`
      : '<div class="kd-row is-count"><span class="kd-t"></span><span class="kd-main muted">No start of day count</span><span class="kd-n">—</span></div>';
    const sumRow = expected !== null
      ? `<div class="kd-row is-sum"><span class="kd-t"></span><span class="kd-main">Should be left: ${fmt(G.start.value)}${
          counted.map((x) => ` ${x.units > 0 ? "+" : "−"} ${fmt(Math.abs(x.units))}`).join("")}</span>
          <span class="kd-n">${fmt(expected)} ${esc(u)}</span></div>` : "";
    const endRow = G.end
      ? `<div class="kd-row is-count"><span class="kd-t">${esc(timeOf(G.end.at))}</span>
          <span class="kd-main"><strong>${G.end.nextDate ? `Next start count (${esc(niceDay(G.end.nextDate))})` : "End of day count"}</strong>${
            G.end.old ? `<span class="kd-tags">${OLD}</span>` : ""}</span>
          <span class="kd-n">${fmt(G.end.value)} ${esc(u)}</span></div>`
      : '<div class="kd-row is-count"><span class="kd-t"></span><span class="kd-main muted">No end of day count yet</span><span class="kd-n">—</span></div>';

    const verdict = diff === null
      ? `<p class="kd-verdict">Can't check this day: ${!G.start ? "there's no start count" : "there's no end count yet"}.</p>`
      : Math.abs(diff) < 0.05 ? '<p class="kd-verdict is-ok">✓ Adds up.</p>'
      : diff < 0 ? `<p class="kd-verdict is-warn">${fmt(-diff)} ${esc(u)} not accounted for.</p>`
      : `<p class="kd-verdict is-warn">${fmt(diff)} ${esc(u)} more than expected.</p>`;

    return `<section class="kd-sec">
      <div class="kd-sec-head"><strong>${esc(name)} · ${esc(G.p.name)}</strong>
        <span class="muted">${esc(niceDay(st.key))}${usedOn.length ? ` · ${fmt(usedTotal)} ${esc(u)} on ${patients} patient${patients === 1 ? "" : "s"}` : ""}</span></div>
      ${startRow}${lines.map((x) => lineHtml(x, u)).join("")}${sumRow}${endRow}${verdict}
    </section>`;
  }

  load();
}