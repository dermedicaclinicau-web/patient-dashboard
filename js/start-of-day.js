import { fetchDayAppointments } from "./appointments.js";
import { escapeHtml, getInitials, toDateKey, showToast } from "./utils.js";
import { listProducts, listKits, isKitProduct, getMyKitDay, saveKitDayStart, saveDayStart, plural } from "./inventory-api.js";
import { db } from "./firebase-config.js";
import { collection, getDocs, query, where, FieldPath } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const SUN = svg('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>');
const MOON = svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');
const ICO = {
  cal: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  task: svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  note: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
};
const esc = escapeHtml;
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "No expiry";
};
const timeOf = (d) => (d ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) : "");
// Same matching as My dashboard: appointments by name (first name is enough), tasks by staff ID or exact name
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const sameStaff = (a, b) => {
  const x = normName(a), y = normName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x) || x.split(" ")[0] === y.split(" ")[0]);
};

let current = null;
let session = 0; // bumps on close/logout, so a slow kit check never opens a pop-up for someone who has gone

// "Bethany" -> "Bethany", "Dr Joanna Teh" -> "Dr Teh"
function friendlyName(name) {
  const n = String(name || "").trim();
  const m = /^(dr|prof)\.?\s+(.+)$/i.exec(n);
  if (m) {
    const parts = m[2].trim().split(/\s+/);
    const title = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return `${title} ${parts[parts.length - 1]}`;
  }
  return n.split(/\s+/)[0] || "there";
}

function seenKey(staff) {
  return `sod:${staff.uid}:${toDateKey()}`;
}

/* ---------- Kit ---------- */

// Active kit products this injector holds now (plus any listed in alsoIds, e.g. counted this morning)
async function kitProductsFor(staff, alsoIds = []) {
  if (!staff || staff.injector !== true) return [];
  const [products, kits] = await Promise.all([listProducts(), listKits({ mine: true })]);
  return products.filter((p) => p.active && isKitProduct(p)
    && (kits.some((k) => k.productId === p.id) || alsoIds.includes(p.id)));
}

// Injectors holding a kit product right now, who haven't started today: { products: [{ p }] }, otherwise null
async function kitToday(staff) {
  if (!staff || staff.injector !== true) return null;
  const [kp, day] = await Promise.all([kitProductsFor(staff), getMyKitDay()]);
  if (day && (day.start || day.end)) return null;
  return kp.length ? { products: kp.map((p) => ({ p })) } : null;
}

// The welcome once per day. The kit count until it's done (it comes back at the next login if put off).
export async function maybeShowStartOfDay(staff) {
  if (!staff) return;
  refreshStartOfDayButton(staff);
  let seen = false;
  try { seen = !!localStorage.getItem(seenKey(staff)); } catch { /* storage blocked: show it */ }
  if (!seen) { showStartOfDay(staff); return; }
  const mine = session;
  const kit = await kitToday(staff).catch((err) => { console.warn("Kit check failed:", err); return null; });
  if (kit && mine === session && !current) showStartOfDay(staff, { kit, kitOnly: true });
}

export function closeStartOfDay() {
  session++;
  if (!current) return;
  if (current.open) current.close();
  current.remove();
  current = null;
}

// Opens the kit count on demand (My dashboard → Needs my attention). Returns false if there's nothing to count.
export async function openStartOfDayKit(staff) {
  if (current) return true;   // already open
  const kit = await kitToday(staff).catch((err) => { console.warn("Kit check failed:", err); return null; });
  if (!kit) {
    showToast("Nothing to count: today's kit count is done, or your kit is empty.");
    window.dispatchEvent(new Event("kitday:changed"));   // the dashboard reminder is out of date
    return false;
  }
  if (!current) showStartOfDay(staff, { kit, kitOnly: true });
  return true;
}

// Correct today's start of day (until End of Day): a fresh blind count of the kit as it is now
export async function openStartOfDayEdit(staff) {
  if (current || !staff) return;
  try {
    const day = await getMyKitDay();
    if (!day || !day.start) { showToast("You haven't started today yet."); return; }
    if (day.end) {
      showToast("You've already ended today, so your start of day can't be changed.");
      window.dispatchEvent(new Event("kitday:changed"));
      return;
    }
    const kp = await kitProductsFor(staff, (day.start.items || []).map((it) => it.productId));
    if (current) return;
    if (!kp.length) { showToast("There's no kit to count."); return; }
    showStartOfDay(staff, { kit: { products: kp.map((p) => ({ p })), edit: day.start }, kitOnly: true });
  } catch (err) {
    console.warn("Edit start of day failed:", err);
    showToast("Couldn't open your start of day. Check your connection and try again.");
  }
}

export function showStartOfDay(staff, { kit = null, kitOnly = false, noKit = false } = {}) {
  closeStartOfDay();
  const mine = session;

  const now = new Date();
  const hour = now.getHours();
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const dateText = `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  const name = friendlyName(staff.name);

  const dlg = document.createElement("dialog");
  dlg.className = "sod";
  dlg.setAttribute("aria-labelledby", "sod-title");
  dlg.innerHTML = `
    <div class="sod-card">
      <div class="sod-hero ${part === "evening" ? "evening" : ""}">
        <span class="sod-sky">${part === "evening" ? MOON : SUN}</span>
      </div>

      <div class="sod-avatar">
        <span>${esc(getInitials(staff.name))}</span>
        ${staff.photo ? `<img src="${esc(staff.photo)}" alt="" referrerpolicy="no-referrer" />` : ""}
      </div>

      <p class="sod-eyebrow">Good ${part} · ${esc(dateText)}</p>
      <h2 id="sod-title" class="sod-title serif">Welcome, ${esc(name)}</h2>
      <p class="sod-sub">Have a great day today!</p>

      <div class="sod-stats">
        <div class="sod-stat"><strong data-stat="appts">–</strong><span>appointments today</span></div>
        <div class="sod-stat"><strong data-stat="staff">–</strong><span>clinicians on</span></div>
      </div>

      <div class="sod-you" data-role="foryou">
        <p class="sod-you-h">For you today</p>
        <div class="skeleton" style="height:48px;border-radius:10px"></div>
      </div>

      <button type="button" class="sod-btn" data-act="start">Start my day</button>
    </div>`;

  document.body.appendChild(dlg);
  current = dlg;
  let kitMode = false;

  const img = dlg.querySelector(".sod-avatar img");
  if (img) img.addEventListener("error", () => img.remove());

  const close = () => {
    if (dlg.classList.contains("closing")) return;
    dlg.classList.add("closing");
    setTimeout(() => { if (current === dlg) closeStartOfDay(); }, 180);
  };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });   // Esc: kit step = remind me later
  // Welcome only: click outside, or follow a link (a task, My dashboard) to close
  dlg.addEventListener("click", (e) => {
    if (kitMode) return;
    if (e.target === dlg || e.target.closest('a[href^="#/"]')) close();
  });

  // The kit check loads while they read the welcome (an error means "don't know": the day isn't started without the count)
  const kitP = kit || noKit ? Promise.resolve(kit)
    : kitToday(staff).catch((err) => { console.warn("Kit check failed:", err); return { error: true }; });

  const startBtn = dlg.querySelector('[data-act="start"]');
  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startBtn.textContent = "One moment…";
    const k = await kitP;
    if (!dlg.isConnected || mine !== session) return;
    if (k && k.error) { close(); return; }   // the button stays at the top to try again
    if (k) { kitMode = true; renderKit(dlg, staff, k, close); return; }
    // No kit to count: starting the day is just recorded
    try {
      await saveDayStart(staff);
      window.dispatchEvent(new Event("kitday:changed"));
    } catch (err) {
      console.warn("Start of day not saved:", err);
      showToast("Couldn't record your start. Press “Start my day” at the top to try again.");
    }
    close();
  });

  dlg.showModal();

  if (kitOnly && kit) {
    kitMode = true;
    renderKit(dlg, staff, kit, close);
    return;
  }
  setTimeout(() => startBtn.focus(), 50);

  // Remember the welcome has been shown today (and tidy up older days for this staff member)
  try {
    const prefix = `sod:${staff.uid}:`;
    Object.keys(localStorage)
      .filter((k) => k.startsWith(prefix) && k !== seenKey(staff))
      .forEach((k) => localStorage.removeItem(k));
    localStorage.setItem(seenKey(staff), "1");
  } catch { /* ignore */ }

  loadStats(dlg, staff);
}

/* ---------- Your kit: a blind count, typed from the labels ---------- */
// kit.edit (correcting today's start): batch, expiry and "using today" are carried over; the counts never are.

function renderKit(dlg, staff, kit, close) {
  dlg.classList.add("is-kit");
  const card = dlg.querySelector(".sod-card");
  const byId = new Map(kit.products.map(({ p }) => [p.id, p]));
  const bl = (p) => (p.batchLabel || "Batch");
  const edit = kit.edit || null;
  const earlier = (pid) => (edit && !edit.notInjecting ? (edit.items || []).find((it) => it.productId === pid) : null) || null;
  const submitLabel = edit ? "Save changes" : "Save and start my day";

  const rowHtml = (p, r = null) => `<tr>
      ${p.tracked ? `<td><input class="fe-input sod-batch" data-f="batch" maxlength="40" autocomplete="off" spellcheck="false"
          aria-label="${esc(bl(p))} number" placeholder="From the label" value="${esc((r && r.batch) || "")}" /></td>
        <td><input class="fe-input sod-exp" type="date" data-f="expiry" aria-label="Expiry date" value="${esc((r && r.expiry) || "")}" /></td>` : ""}
      <td><input class="fe-input" type="number" min="0" step="1" inputmode="numeric" data-f="sealed" aria-label="Unopened" /></td>
      <td><div class="fe-num"><input class="fe-input" type="number" min="0" step="0.5" inputmode="decimal" data-f="open"
          aria-label="${esc(p.doseUnit)} left in the opened ${esc(p.stockUnit)}" /><span>${esc(p.doseUnit)}</span></div></td>
      <td class="sod-use"><input type="radio" name="use-${esc(p.id)}" value="row" data-f="use" aria-label="Using this one today"${r && r.inUse ? " checked" : ""} /></td>
      <td><button type="button" class="hx-x" data-act="rm" aria-label="Remove this row" title="Remove">×</button></td>
    </tr>`;

  const productHtml = (p) => {
    const e = earlier(p.id);
    const rows = e && Array.isArray(e.rows) && e.rows.length ? e.rows : [null];
    const noneOn = !!(e && !e.inUse);
    return `
    <section class="sod-kp" data-pid="${esc(p.id)}">
      <h3>${esc(p.name)} <small>${esc(`${p.dosePer} ${p.doseUnit} per ${p.stockUnit}`)}</small></h3>
      <p class="sod-k-hint">${p.tracked
        ? `Read the ${esc(bl(p).toLowerCase())} number and expiry off each ${esc(p.stockUnit)} in your kit. One row per ${esc(bl(p).toLowerCase())}.`
        : `Count what's in your kit.`}</p>
      <div class="sod-kscroll"><table class="sod-ktable">
        <thead><tr>${p.tracked ? `<th>${esc(bl(p))} #</th><th>Expiry</th>` : ""}<th>Unopened</th>
          <th>Left in the opened ${esc(p.stockUnit)}</th><th>Using today</th><th></th></tr></thead>
        <tbody>${rows.map((r) => rowHtml(p, r)).join("")}</tbody></table></div>
      <div class="sod-krow-acts">
        ${p.tracked ? `<button type="button" class="ff-btn is-quiet" data-act="add">+ Add another ${esc(bl(p).toLowerCase())}</button>` : "<span></span>"}
        <label class="fe-check"><input type="radio" name="use-${esc(p.id)}" value="none"${noneOn ? " checked" : ""} /> Not using this today</label>
      </div>
    </section>`;
  };

  card.innerHTML = `
    <form class="sod-kitform" novalidate>
      <p class="sod-eyebrow">Start of day${edit && edit.at ? ` · started ${esc(timeOf(edit.at))}` : ""}</p>
      <h2 id="sod-title" class="sod-title serif">${edit ? "Edit start of day" : "Your kit"}</h2>
      <p class="sod-sub">${edit
        ? "Count what's in your kit right now and save. This replaces this morning's count (it stays on record), and treatments since this morning are taken into account."
        : `Count what's physically in your kit and type in each ${esc(kit.products.some(({ p }) => p.tracked) ? "batch" : "item")}.
        Put 0 where there's none, and choose the one you're using today.`}</p>
      ${kit.products.map(({ p }) => productHtml(p)).join("")}
      <label class="fe-check sod-none"><input type="checkbox" name="none" /> I'm not injecting today</label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="sod-kit-acts">
        <button type="button" class="lh-btn is-quiet" data-act="later">${edit ? "Cancel" : "Remind me later"}</button>
        <button type="submit" class="sod-btn">${submitLabel}</button>
      </div>
    </form>`;

  const form = card.querySelector("form");
  const err = card.querySelector(".lh-error");
  const showErr = (m, focus) => { err.textContent = m; err.hidden = !m; if (focus) focus.focus(); };
  const syncRm = (sec) => {
    const rows = sec.querySelectorAll("tbody tr");
    rows.forEach((tr) => { tr.querySelector('[data-act="rm"]').hidden = rows.length < 2; });
  };
  card.querySelectorAll(".sod-kp").forEach(syncRm);

  const none = form.elements.none;
  none.addEventListener("change", () => {
    card.querySelectorAll(".sod-kp").forEach((s) => s.classList.toggle("is-off", none.checked));
    card.querySelectorAll(".sod-kp input, .sod-kp button").forEach((i) => { i.disabled = none.checked; });
    showErr("");
  });
  if (edit && edit.notInjecting) { none.checked = true; none.dispatchEvent(new Event("change")); }

  card.querySelector('[data-act="later"]').addEventListener("click", () => {
    close();
    if (!edit) showToast("No problem. Press “Start my day” at the top when you're ready to count your kit.");
  });
  card.addEventListener("input", () => showErr(""));
  card.addEventListener("click", (e) => {
    const add = e.target.closest('[data-act="add"]');
    if (add) {
      const sec = add.closest(".sod-kp");
      const tb = sec.querySelector("tbody");
      tb.insertAdjacentHTML("beforeend", rowHtml(byId.get(sec.dataset.pid)));
      syncRm(sec);
      tb.lastElementChild.querySelector("input").focus();
      return;
    }
    const rm = e.target.closest('[data-act="rm"]');
    if (rm) {
      const sec = rm.closest(".sod-kp");
      rm.closest("tr").remove();
      syncRm(sec);
      return;
    }
    if (e.target.closest('a[href^="#/"]')) close();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const notInjecting = none.checked;
    const items = [];
    if (!notInjecting) {
      for (const { p } of kit.products) {
        const sec = card.querySelector(`[data-pid="${CSS.escape(p.id)}"]`);
        const trs = [...sec.querySelectorAll("tbody tr")];
        const rows = [];
        let chosen = sec.querySelector('input[value="none"]').checked;
        for (const tr of trs) {
          const f = (k) => tr.querySelector(`[data-f="${k}"]`);
          const batch = p.tracked ? f("batch").value.trim() : "";
          const expiry = p.tracked ? f("expiry").value : "";
          const s = f("sealed").value.trim();
          const o = f("open").value.trim();
          if (trs.length > 1 && !batch && !expiry && s === "" && o === "") continue; // an empty extra row
          if (p.tracked && !batch) { showErr(`${p.name}: type the ${bl(p).toLowerCase()} number from the label.`, f("batch")); return; }
          if (p.tracked && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) { showErr(`${p.name} ${batch}: enter the expiry date from the label.`, f("expiry")); return; }
          const sn = Number(s), on = Number(o);
          if (s === "" || !Number.isInteger(sn) || sn < 0) { showErr(`${p.name}${batch ? ` ${batch}` : ""}: enter how many unopened (0 if none).`, f("sealed")); return; }
          if (o === "" || !(on >= 0)) { showErr(`${p.name}${batch ? ` ${batch}` : ""}: enter the ${p.doseUnit} left in the opened ${p.stockUnit} (0 if none).`, f("open")); return; }
          if (on > (Number(p.dosePer) || Infinity)) { showErr(`${p.name}: an opened ${p.stockUnit} holds ${p.dosePer} ${p.doseUnit} at most.`, f("open")); return; }
          const inUse = f("use").checked;
          if (inUse) chosen = true;
          rows.push({ batch, expiry, sealed: sn, open: on, inUse });
        }
        if (!rows.length) { showErr(`${p.name}: count at least one ${p.tracked ? bl(p).toLowerCase() : "row"}.`); return; }
        if (!chosen) { showErr(`${p.name}: tick the ${p.stockUnit} you're using today, or “Not using this today”.`); return; }
        items.push({ productId: p.id, rows });
      }
    }

    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    showErr("");
    try {
      const r = await saveKitDayStart({ notInjecting, items }, staff);
      window.dispatchEvent(new Event("kitday:changed"));
      close();
      const lead = edit ? "Start of day updated." : "Kit count saved.";
      const notes = [];
      if (r.overnight) notes.push(`${plural(r.overnight, "overnight difference")} sent to an admin`);
      if (r.unknown) notes.push(`${plural(r.unknown, "batch")} not found in your kit records`);
      showToast(r.notInjecting ? (edit ? "Start of day updated: not injecting today." : "Noted: not injecting today. Have a great day!")
        : notes.length ? `${lead} ${notes.join(" · ")}.`
        : r.differences ? `${lead} ${plural(r.differences, "difference")} will be reviewed.`
        : edit ? "Start of day updated. Everything matched." : "Kit count saved. Everything matched. Have a great day!");
    } catch (ex) {
      console.error("Start of day kit count failed:", ex);
      showErr(ex && ex.code === "permission-denied"
        ? "Couldn't save. Check the Firestore rules for inv_kitdays, inv_counts and inv_investigations have been published."
        : (ex && ex.message && !ex.code) ? ex.message : "Couldn't save. Check your connection and try again.");
      btn.disabled = false;
      btn.textContent = submitLabel;
    }
  });

  const first = card.querySelector(edit ? '[data-f="sealed"]' : '[data-f="batch"], [data-f="sealed"]');
  if (first) setTimeout(() => first.focus(), 50);
}

/* ---------- The welcome: the clinic today, and what's waiting for you ---------- */

// My open tasks due today or earlier, oldest first
async function myTasksDue(staff, key) {
  const snap = await getDocs(query(collection(db, "staff-task-list"), where("status", "==", "Open")));
  const ids = [staff.uid, staff.id, staff.staffId].filter(Boolean).map(String);
  const nm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => (t.assignedToId && ids.includes(String(t.assignedToId))) || (t.assignedToName && nm(t.assignedToName) === nm(staff.name)))
    .filter((t) => t.dueDate && t.dueDate <= key)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
}

// How many of my consultation notes are still a Draft
async function myDraftNotes(staff) {
  const name = String(staff.name || "").trim();
  if (!name) return 0;
  const snap = await getDocs(query(collection(db, "appointment_transcripts"), where(new FieldPath("Staff Name"), "==", name)));
  return snap.docs.filter((d) => !/^reviewed$/i.test(String((d.data() || {}).Status || ""))).length;
}

async function loadStats(dlg, staff) {
  const wrap = dlg.querySelector(".sod-stats");
  const you = dlg.querySelector('[data-role="foryou"]');
  const key = toDateKey();
  const [apR, tkR, ntR] = await Promise.allSettled([fetchDayAppointments(key), myTasksDue(staff, key), myDraftNotes(staff)]);
  if (!dlg.isConnected) return;

  // The clinic today
  const appts = apR.status === "fulfilled" ? (apR.value.appointments || []) : null;
  if (wrap && wrap.isConnected) {
    if (!appts) { console.warn("Start of Day stats failed:", apR.reason); wrap.hidden = true; }
    else if (!appts.length) wrap.innerHTML = `<p class="sod-note">No appointments are scheduled today.</p>`;
    else {
      wrap.querySelector('[data-stat="appts"]').textContent = appts.length;
      wrap.querySelector('[data-stat="staff"]').textContent = new Set(appts.map((a) => a.staff).filter(Boolean)).size;
    }
  }

  // For you today
  if (!you || !you.isConnected) return;
  if (tkR.status === "rejected") console.warn("Start of Day tasks failed:", tkR.reason);
  if (ntR.status === "rejected") console.warn("Start of Day notes failed:", ntR.reason);
  const lines = [];

  const mine = (appts || []).filter((a) => sameStaff(a.staff, staff.name))
    .sort((a, b) => (Number(a.sortMinutes) || 0) - (Number(b.sortMinutes) || 0));
  if (mine.length) {
    lines.push(`<li>${ICO.cal}<span><strong>${mine.length} appointment${mine.length === 1 ? "" : "s"}</strong> with you${
      mine[0].time ? ` · first at ${esc(mine[0].time)}` : ""}</span></li>`);
  }

  const tasks = tkR.status === "fulfilled" ? tkR.value : [];
  if (tasks.length) {
    const overdue = tasks.filter((t) => t.dueDate < key).length;
    const item = (t) => {
      const inner = `${esc(t.taskText || "Reminder")}<small>${esc(t.patientName || "")}${t.patientName ? " · " : ""}${
        t.dueDate < key ? `Overdue (${esc(niceDate(t.dueDate))})` : "Due today"}</small>`;
      return t.patientId ? `<a href="#/patient/${encodeURIComponent(t.patientId)}">${inner}</a>` : `<span>${inner}</span>`;
    };
    lines.push(`<li class="${overdue ? "is-bad" : ""}">${ICO.task}<span><strong>${tasks.length} task${tasks.length === 1 ? "" : "s"} due</strong>${
      overdue ? ` · ${overdue} overdue` : ""}
      <span class="sod-you-tasks">${tasks.slice(0, 3).map(item).join("")}${tasks.length > 3 ? `<small>and ${tasks.length - 3} more</small>` : ""}</span></span></li>`);
  }

  const drafts = ntR.status === "fulfilled" ? ntR.value : 0;
  if (drafts) lines.push(`<li>${ICO.note}<span><strong>${drafts} consultation note${drafts === 1 ? "" : "s"}</strong> to review</span></li>`);

  you.innerHTML = `<p class="sod-you-h">For you today</p>
    ${lines.length ? `<ul>${lines.join("")}</ul>` : '<p class="sod-note">Nothing waiting for you. Enjoy your day!</p>'}
    <a class="sod-you-more" href="#/home">Open My dashboard →</a>`;
}

/* ---------- The top bar: "Start my day" until started, and "Edit start of day" until ended ---------- */
let btnStaff = null;
let btnCheck = 0;

async function dayInfo(staff) {
  const [day, kit] = await Promise.all([getMyKitDay(), kitToday(staff)]);
  return {
    started: !!(day && (day.start || day.end)),
    kit,
    canEdit: staff.injector === true && !!(day && day.start && !day.end),
  };
}

// null = already started today. Otherwise { kit }: the kit to count, or null if there's nothing to count.
async function dayState(staff) {
  if (!staff) return null;
  const info = await dayInfo(staff);
  return info.started ? null : { kit: info.kit };
}

// The top bar button: the kit count for injectors with a kit, otherwise the welcome
export async function openStartOfDay(staff) {
  if (current || !staff) return;
  const st = await dayState(staff).catch((err) => { console.warn("Day check failed:", err); return undefined; });
  if (current) return;
  if (st === undefined) { showToast("Couldn't check your day. Check your connection and try again."); return; }
  if (!st) {
    showToast("You've already started today.");
    window.dispatchEvent(new Event("kitday:changed"));
    return;
  }
  if (st.kit) showStartOfDay(staff, { kit: st.kit, kitOnly: true });
  else showStartOfDay(staff, { noKit: true });
}

function sodButton() {
  let b = document.getElementById("sod-btn");
  if (!b) {
    const eod = document.getElementById("eod-btn");
    const stack = eod ? eod.parentElement : document.querySelector(".tb-day, .topbar-right");
    if (!stack) return null;
    b = document.createElement("button");
    b.type = "button";
    b.id = "sod-btn";
    b.hidden = true;
    stack.insertBefore(b, eod || null);
  }
  if (!b.dataset.wired) {
    b.dataset.wired = "1";
    b.className = "tb-pill is-start";
    b.title = "Start your day";
    b.innerHTML = `${SUN}<span>Start my day</span>`;
    b.addEventListener("click", async () => {
      if (!btnStaff || b.disabled) return;
      b.disabled = true;
      try { await openStartOfDay(btnStaff); } finally { b.disabled = false; }
    });
  }
  return b;
}

function setPending(on) {
  const b = sodButton();
  if (!b) return;
  b.hidden = !on;
  if (b.parentElement) b.parentElement.classList.toggle("sod-pending", on);   // "End my day" waits until the day has started
}

// "Edit start of day" in the profile menu
function setEditable(on) {
  const it = document.getElementById("me-sod-edit");
  if (!it) return;
  if (!it.dataset.wired) {
    it.dataset.wired = "1";
    it.addEventListener("click", () => { if (btnStaff) openStartOfDayEdit(btnStaff); });
  }
  it.hidden = !on;
}

// Shows "Start my day" until this person has started today, and "Edit start of day" until they've ended it
export async function refreshStartOfDayButton(staff) {
  btnStaff = staff || null;
  const mine = ++btnCheck;
  if (!staff) { setPending(false); setEditable(false); return; }
  const info = await dayInfo(staff).catch((err) => { console.warn("Day check failed:", err); return null; });
  if (mine !== btnCheck || btnStaff !== staff) return;
  setPending(!!info && !info.started);
  setEditable(!!info && info.canEdit);
}

// On logout
export function hideStartOfDayButton() {
  btnStaff = null;
  btnCheck++;
  setPending(false);
  setEditable(false);
}

// Started, corrected or ended: refresh the top bar
window.addEventListener("kitday:changed", () => { if (btnStaff) refreshStartOfDayButton(btnStaff); });