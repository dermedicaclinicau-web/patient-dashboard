import { fetchDayAppointments } from "./appointments.js";
import { escapeHtml, getInitials, toDateKey, showToast } from "./utils.js";
import { listProducts, listKits, isKitProduct, getMyKitDay, saveKitDayStart, plural } from "./inventory-api.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const SUN = svg('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>');
const MOON = svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');
const esc = escapeHtml;
const niceDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "No expiry";
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

// Injectors holding a kit product right now, who haven't done today's count: { products: [{ p }] }, otherwise null
async function kitToday(staff) {
  if (!staff || staff.injector !== true) return null;
  const [products, kits, day] = await Promise.all([listProducts(), listKits({ mine: true }), getMyKitDay()]);
  if (day && day.start) return null;
  const kp = products.filter((p) => p.active && isKitProduct(p) && kits.some((k) => k.productId === p.id));
  return kp.length ? { products: kp.map((p) => ({ p })) } : null;
}
// The welcome once per day. The kit count until it's done (it comes back at the next login if put off).
export async function maybeShowStartOfDay(staff) {
  if (!staff) return;
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

export function showStartOfDay(staff, { kit = null, kitOnly = false } = {}) {
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
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });                  // Esc: kit step = remind me later
  dlg.addEventListener("click", (e) => { if (e.target === dlg && !kitMode) close(); });     // click outside (welcome only)

  // The kit check loads while they read the welcome
  const kitP = kit ? Promise.resolve(kit) : kitToday(staff).catch((err) => { console.warn("Kit check failed:", err); return null; });

  const startBtn = dlg.querySelector('[data-act="start"]');
  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startBtn.textContent = "One moment…";
    const k = await kitP;
    if (!dlg.isConnected || mine !== session) return;
    if (k) { kitMode = true; renderKit(dlg, staff, k, close); }
    else close();
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

  loadStats(dlg);
}

/* ---------- Your kit: a blind count, typed from the labels ---------- */

function renderKit(dlg, staff, kit, close) {
  dlg.classList.add("is-kit");
  const card = dlg.querySelector(".sod-card");
  const byId = new Map(kit.products.map(({ p }) => [p.id, p]));
  const bl = (p) => (p.batchLabel || "Batch");

  const rowHtml = (p) => `<tr>
      ${p.tracked ? `<td><input class="fe-input sod-batch" data-f="batch" maxlength="40" autocomplete="off" spellcheck="false"
          aria-label="${esc(bl(p))} number" placeholder="From the label" /></td>
        <td><input class="fe-input sod-exp" type="date" data-f="expiry" aria-label="Expiry date" /></td>` : ""}
      <td><input class="fe-input" type="number" min="0" step="1" inputmode="numeric" data-f="sealed" aria-label="Unopened" /></td>
      <td><div class="fe-num"><input class="fe-input" type="number" min="0" step="0.5" inputmode="decimal" data-f="open"
          aria-label="${esc(p.doseUnit)} left in the opened ${esc(p.stockUnit)}" /><span>${esc(p.doseUnit)}</span></div></td>
      <td class="sod-use"><input type="radio" name="use-${esc(p.id)}" value="row" data-f="use" aria-label="Using this one today" /></td>
      <td><button type="button" class="hx-x" data-act="rm" aria-label="Remove this row" title="Remove">×</button></td>
    </tr>`;

  const productHtml = (p) => `
    <section class="sod-kp" data-pid="${esc(p.id)}">
      <h3>${esc(p.name)} <small>${esc(`${p.dosePer} ${p.doseUnit} per ${p.stockUnit}`)}</small></h3>
      <p class="sod-k-hint">${p.tracked
        ? `Read the ${esc(bl(p).toLowerCase())} number and expiry off each ${esc(p.stockUnit)} in your kit. One row per ${esc(bl(p).toLowerCase())}.`
        : `Count what's in your kit.`}</p>
      <div class="sod-kscroll"><table class="sod-ktable">
        <thead><tr>${p.tracked ? `<th>${esc(bl(p))} #</th><th>Expiry</th>` : ""}<th>Unopened</th>
          <th>Left in the opened ${esc(p.stockUnit)}</th><th>Using today</th><th></th></tr></thead>
        <tbody>${rowHtml(p)}</tbody></table></div>
      <div class="sod-krow-acts">
        ${p.tracked ? `<button type="button" class="ff-btn is-quiet" data-act="add">+ Add another ${esc(bl(p).toLowerCase())}</button>` : "<span></span>"}
        <label class="fe-check"><input type="radio" name="use-${esc(p.id)}" value="none" /> Not using this today</label>
      </div>
    </section>`;

  card.innerHTML = `
    <form class="sod-kitform" novalidate>
      <p class="sod-eyebrow">Start of day</p>
      <h2 id="sod-title" class="sod-title serif">Your kit</h2>
      <p class="sod-sub">Count what's physically in your kit and type in each ${esc(kit.products.some(({ p }) => p.tracked) ? "batch" : "item")}.
        Put 0 where there's none, and choose the one you're using today.</p>
      ${kit.products.map(({ p }) => productHtml(p)).join("")}
      <label class="fe-check sod-none"><input type="checkbox" name="none" /> I'm not injecting today</label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="sod-kit-acts">
        <button type="button" class="lh-btn is-quiet" data-act="later">Remind me later</button>
        <button type="submit" class="sod-btn">Save and start my day</button>
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
  card.querySelector('[data-act="later"]').addEventListener("click", () => {
    close();
    showToast("No problem. Count your kit from My dashboard → Needs my attention when you're ready.");
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
      const notes = [];
      if (r.overnight) notes.push(`${plural(r.overnight, "overnight difference")} sent to an admin`);
      if (r.unknown) notes.push(`${plural(r.unknown, "batch")} not found in your kit records`);
      showToast(r.notInjecting ? "Noted: not injecting today. Have a great day!"
        : notes.length ? `Kit count saved. ${notes.join(" · ")}.`
        : r.differences ? `Kit count saved. ${plural(r.differences, "difference")} will be reviewed.`
        : "Kit count saved. Everything matched. Have a great day!");
    } catch (ex) {
      console.error("Start of day kit count failed:", ex);
      showErr(ex && ex.code === "permission-denied"
        ? "Couldn't save. Check the Firestore rules for inv_kitdays and inv_investigations have been published."
        : (ex && ex.message && !ex.code) ? ex.message : "Couldn't save. Check your connection and try again.");
      btn.disabled = false;
      btn.textContent = "Save and start my day";
    }
  });

  const first = card.querySelector('[data-f="batch"], [data-f="sealed"]');
  if (first) setTimeout(() => first.focus(), 50);
}


async function loadStats(dlg) {
  const wrap = dlg.querySelector(".sod-stats");
  if (!wrap) return;
  try {
    const data = await fetchDayAppointments(toDateKey());
    if (!dlg.isConnected || !wrap.isConnected) return;

    const appts = data.appointments || [];
    if (!appts.length) {
      wrap.innerHTML = `<p class="sod-note">No appointments are scheduled today.</p>`;
      return;
    }
    const clinicians = new Set(appts.map((a) => a.staff).filter(Boolean)).size;
    wrap.querySelector('[data-stat="appts"]').textContent = appts.length;
    wrap.querySelector('[data-stat="staff"]').textContent = clinicians;
  } catch (err) {
    console.warn("Start of Day stats failed:", err);
    if (dlg.isConnected && wrap.isConnected) wrap.hidden = true;
  }
}