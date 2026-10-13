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

// Injectors holding kit products who haven't done today's kit count: { products: [{ p, lots }] }, otherwise null
async function kitToday(staff) {
  if (!staff || staff.injector !== true) return null;
  const [products, kits, day] = await Promise.all([listProducts(), listKits({ mine: true }), getMyKitDay()]);
  if (day && day.start) return null;
  const kp = products.filter((p) => p.active && isKitProduct(p));
  if (!kp.length) return null;
  return { products: kp.map((p) => ({ p, lots: kits.filter((k) => k.productId === p.id) })) };
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

/* ---------- Your kit: the vial in use today and a blind count ---------- */

function renderKit(dlg, staff, kit, close) {
  dlg.classList.add("is-kit");
  const card = dlg.querySelector(".sod-card");
  const withLots = kit.products.filter((x) => x.lots.length);
  const empty = kit.products.filter((x) => !x.lots.length);

  const productHtml = ({ p, lots }) => `
    <section class="sod-kp" data-pid="${esc(p.id)}">
      <h3>${esc(p.name)} <small>${esc(`${p.dosePer} ${p.doseUnit} per ${p.stockUnit}`)}</small></h3>
      <div class="sod-k-label">${esc(p.stockUnit[0].toUpperCase() + p.stockUnit.slice(1))} you're using today</div>
      <div class="sod-uses">${lots.map((k) => `
        <label class="fe-check"><input type="radio" name="use-${esc(p.id)}" value="${esc(k.id)}"${lots.length === 1 ? " checked" : ""} />
          ${esc([k.batch ? `${p.batchLabel || "Batch"} ${k.batch}` : "No batch number", `Exp ${niceDate(k.expiry)}`].join(" · "))}</label>`).join("")}
        <label class="fe-check"><input type="radio" name="use-${esc(p.id)}" value="" /> Not using this today</label>
      </div>
      <div class="sod-k-label">Count what's in your kit</div>
      <table class="sod-ktable">
        <thead><tr><th>${esc(p.batchLabel || "Batch")}</th><th>Unopened</th><th>Left in the opened ${esc(p.stockUnit)}</th></tr></thead>
        <tbody>${lots.map((k) => `<tr data-ref="${esc(k.id)}">
          <td>${esc(k.batch || "—")}<br><small class="muted">Exp ${esc(niceDate(k.expiry))}</small></td>
          <td><input class="fe-input" type="number" min="0" step="1" inputmode="numeric" data-f="sealed" aria-label="Unopened ${esc(p.stockUnit)}s" /></td>
          <td><div class="fe-num"><input class="fe-input" type="number" min="0" step="0.5" inputmode="decimal" data-f="open" aria-label="${esc(p.doseUnit)} left" /><span>${esc(p.doseUnit)}</span></div></td>
        </tr>`).join("")}</tbody>
      </table>
    </section>`;

  card.innerHTML = `
    <form class="sod-kitform" novalidate>
      <p class="sod-eyebrow">Start of day</p>
      <h2 id="sod-title" class="sod-title serif">Your kit</h2>
      <p class="sod-sub">Choose the ${withLots.length === 1 ? esc(withLots[0].p.stockUnit) : "vial"} you're using today and count what's in your kit.
        Put 0 where there's none.</p>
      ${withLots.length ? withLots.map(productHtml).join("") : `
        <p class="tb-info">Your kit is empty. <a href="#/inventory/kits">Take from the Shelf</a> first, or tick below if you're not injecting today.</p>`}
      ${withLots.length && empty.length ? `<p class="muted sod-k-empty">Not in your kit: ${esc(empty.map((x) => x.p.name).join(", "))}.
        <a href="#/inventory/kits">Take from the Shelf</a></p>` : ""}
      <label class="fe-check sod-none"><input type="checkbox" name="none" /> I'm not injecting today</label>
      <p class="lh-error" role="alert" hidden></p>
      <div class="sod-kit-acts">
        <button type="button" class="lh-btn is-quiet" data-act="later">Remind me later</button>
        <button type="submit" class="sod-btn">Save and start my day</button>
      </div>
    </form>`;

  const form = card.querySelector("form");
  const err = card.querySelector(".lh-error");
  const showErr = (m) => { err.textContent = m; err.hidden = !m; };
  const none = form.elements.none;
  none.addEventListener("change", () => {
    card.querySelectorAll(".sod-kp").forEach((s) => { s.classList.toggle("is-off", none.checked); });
    card.querySelectorAll(".sod-kp input").forEach((i) => { i.disabled = none.checked; });
    showErr("");
  });
  card.querySelector('[data-act="later"]').addEventListener("click", close);
  card.addEventListener("click", (e) => { if (e.target.closest('a[href^="#/"]')) close(); }); // going to Kits: come back later
  card.addEventListener("input", () => showErr(""));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const notInjecting = none.checked;
    let items = [];
    if (!notInjecting) {
      if (!withLots.length) { showErr("Take vials into your kit first, or tick “I'm not injecting today”."); return; }
      for (const { p, lots } of withLots) {
        const sec = card.querySelector(`[data-pid="${CSS.escape(p.id)}"]`);
        const use = sec.querySelector(`input[name="use-${CSS.escape(p.id)}"]:checked`);
        if (!use) { showErr(`${p.name}: choose the ${p.stockUnit} you're using today, or “Not using this today”.`); return; }
        const rows = [];
        for (const k of lots) {
          const row = sec.querySelector(`[data-ref="${CSS.escape(k.id)}"]`);
          const s = row.querySelector('[data-f="sealed"]').value.trim();
          const o = row.querySelector('[data-f="open"]').value.trim();
          const sn = Number(s), on = Number(o);
          if (s === "" || o === "" || !Number.isInteger(sn) || sn < 0 || !(on >= 0)) {
            showErr(`${p.name}${k.batch ? ` (${p.batchLabel || "Batch"} ${k.batch})` : ""}: enter both counts. Put 0 where there's none.`);
            (s === "" ? row.querySelector('[data-f="sealed"]') : row.querySelector('[data-f="open"]')).focus();
            return;
          }
          if (on > (Number(p.dosePer) || Infinity)) {
            showErr(`${p.name}: an opened ${p.stockUnit} holds ${p.dosePer} ${p.doseUnit} at most.`);
            row.querySelector('[data-f="open"]').focus();
            return;
          }
          rows.push({ ref: k.id, batch: k.batch, expiry: k.expiry, sealed: sn, open: on });
        }
        items.push({ productId: p.id, productName: p.name, doseUnit: p.doseUnit, inUse: use.value, lots: rows });
      }
    }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    showErr("");
    try {
      const r = await saveKitDayStart({ notInjecting, items }, staff);
      close();
      showToast(r.notInjecting ? "Noted: not injecting today. Have a great day!"
        : r.differences ? `Kit count saved. ${plural(r.differences, "difference")} will be reviewed. Have a great day!`
        : "Kit count saved. Everything matched. Have a great day!");
    } catch (ex) {
      console.error("Start of day kit count failed:", ex);
      showErr(ex && ex.code === "permission-denied"
        ? "Couldn't save. Check the inv_kitdays Firestore rule has been published."
        : (ex && ex.message && !ex.code) ? ex.message : "Couldn't save. Check your connection and try again.");
      btn.disabled = false;
      btn.textContent = "Save and start my day";
    }
  });

  const first = card.querySelector('[data-f="sealed"]') || card.querySelector('[name="none"]');
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