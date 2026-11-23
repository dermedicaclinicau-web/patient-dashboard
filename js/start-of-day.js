import { fetchDayAppointments } from "./appointments.js";
import { escapeHtml, getInitials, toDateKey, showToast } from "./utils.js";
import { listProducts, isKitProduct, getMyKitDay, saveKitDayStart, saveDayStart, plural, unitPlural,
  getServiceLinks, serviceKey, listOpenContainers, listAllLots, listRequests, lowAt, batchText, locLabel,
  reqNumber, awaitingApproval } from "./inventory-api.js";
import { loadSodLayout, sodBands, sodColumnsCss } from "./sod-settings.js";
import { listMyAnnouncements, markSeen, annCardHtml, wireAnnouncements, watchAnnouncements, stopAnnouncements } from "./sod-announcements.js";
import { can } from "./perms.js";
import { db } from "./firebase-config.js";
import { collection, getDocs, query, where, FieldPath, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { kitCountHtml, wireKitCount, readKitCount, kitBatchOptions } from "./kit-count.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Staff → Start of Day Off: the login token says so (applies after the next refresh)
export async function isStartOfDayOff() {
  try {
    const u = getAuth().currentUser;
    if (!u) return false;
    const r = await u.getIdTokenResult();
    return r.claims.sodOff === true;
  } catch { return false; }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const SUN = svg('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>');
const MOON = svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');
const EDIT = svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>');
const ICO = {
  cal: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  task: svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  note: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
  box: svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
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
/* ---------- Not started yet: it comes back until it's done ---------- */
const SNOOZE_MIN = 15;
const snoozeKey = (staff) => `sod-snooze:${staff.uid}:${toDateKey()}`;
const snoozedNow = (staff) => {
  try { return Date.now() < Number(localStorage.getItem(snoozeKey(staff)) || 0); } catch { return false; }
};
const snooze = (staff) => {
  try { localStorage.setItem(snoozeKey(staff), String(Date.now() + SNOOZE_MIN * 60000)); } catch { /* ignore */ }
};

let watchStaff = null;
let watching = false;
let checking = false;
let startedKey = "";   // "<uid>:<date>" once today is known to be started (no more checks today)

/* ---------- Other windows of this browser: only one welcome at a time ---------- */
// Started or put off in one window closes the welcome in the others. A window opening while another one's
// welcome is up waits its turn. Started on another device: checked again when this window comes back into view.
const chan = (() => {
  try { return "BroadcastChannel" in window ? new BroadcastChannel("dm-start-of-day") : null; } catch { return null; }
})();
function tellOthers(type, staff) {
  if (!chan || !staff || !staff.uid) return;
  try { chan.postMessage({ type, uid: staff.uid, day: toDateKey() }); } catch { /* ignore */ }
}
// The welcome is on screen (not the preview, and not "Edit start of day")
const welcomeUp = () => !!current && !current.dataset.preview && !current.dataset.edit;
function dayStartedHere(staff) {
  startedKey = `${staff.uid}:${toDateKey()}`;
  if (welcomeUp()) closeStartOfDay();
  window.dispatchEvent(new Event("kitday:changed"));   // the top bar follows
}
if (chan) chan.addEventListener("message", (e) => {
  const m = e.data || {};
  const s = watchStaff || btnStaff;
  if (!s || m.uid !== s.uid || m.day !== toDateKey()) return;
  if (m.type === "started") dayStartedHere(s);
  else if (m.type === "snoozed") { if (welcomeUp()) closeStartOfDay(); }
  else if (m.type === "ask" && welcomeUp()) tellOthers("showing", s);
});
// Is the welcome already open in another window of this browser?
function otherWindowShowing(staff) {
  if (!chan) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const on = (e) => {
      const m = e.data || {};
      if (m.type !== "showing" || m.uid !== staff.uid) return;
      done = true;
      chan.removeEventListener("message", on);
      resolve(true);
    };
    chan.addEventListener("message", on);
    tellOthers("ask", staff);
    setTimeout(() => { if (!done) { chan.removeEventListener("message", on); resolve(false); } }, 400);
  });
}
// Started on another device while this welcome was open: it closes when this window comes back into view
document.addEventListener("visibilitychange", async () => {
  const s = watchStaff || btnStaff;
  if (document.visibilityState !== "visible" || !s || !welcomeUp()) return;
  const dlg = current;
  const day = await getMyKitDay().catch(() => null);
  if (day && (day.start || day.end) && current === dlg) dayStartedHere(s);
});
// Pressing start in a welcome that's out of date: nothing is saved twice
async function startedElsewhere(staff) {
  const day = await getMyKitDay().catch(() => null);
  if (!day || !(day.start || day.end)) return false;
  dayStartedHere(staff);
  showToast("You've already started today, in another window or device.");
  return true;
}

function watchStartOfDay(staff) {
  watchStaff = staff;
  if (watching) return;
  watching = true;
  const again = () => { if (watchStaff && document.visibilityState === "visible") checkStartOfDay(watchStaff); };
  setInterval(again, 5 * 60000);
  document.addEventListener("visibilitychange", again);
  window.addEventListener("hashchange", again);
}

async function checkStartOfDay(staff) {
  const today = `${staff.uid}:${toDateKey()}`;
  if (checking || current || startedKey === today || snoozedNow(staff)) return;
  checking = true;
  try {
    if (await isStartOfDayOff()) { startedKey = today; return; }   // turned off for them: no more checks today
    const mine = session;
    const [st] = await Promise.all([
      dayState(staff).catch((err) => { console.warn("Day check failed:", err); return undefined; }),
      getLayout(staff),   // the welcome's layout, ready before it opens (so it doesn't change size)
    ]);
    if (mine !== session || current || watchStaff !== staff) return;
    if (st === null) { startedKey = today; return; }   // started today
    if (st === undefined) return;                        // couldn't check: try again later
    if (await otherWindowShowing(staff)) return;   // already open in another window of this browser
    if (mine !== session || current) return;
    showStartOfDay(staff, st.kit ? { kit: st.kit } : { noKit: true });
  } finally {
    checking = false;
  }
}
/* ---------- Kit ---------- */

// Everyone ticked as carrying a kit counts every active kit product (e.g. Xeomin), whatever the system thinks
// is in their kit. alsoIds: products counted this morning that have since been made inactive (for corrections).
async function kitProductsFor(staff, alsoIds = []) {
  if (!staff || staff.injector !== true) return [];
  const products = await listProducts();
  return products.filter((p) => isKitProduct(p) && (p.active || alsoIds.includes(p.id)));
}

// Injectors holding a kit product right now, who haven't started today: { products: [{ p }] }, otherwise null
async function kitToday(staff) {
  if (!staff || staff.injector !== true) return null;
  const [kp, day] = await Promise.all([kitProductsFor(staff), getMyKitDay()]);
  if (day && (day.start || day.end)) return null;
  return kp.length ? { products: kp.map((p) => ({ p })) } : null;
}

// The batches to choose from (in my kit, then on the Shelf), added just before the count is shown
const normB = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const isoKey = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "");
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The batch each kit product was last counted with, looking back 14 days (newest first):
// that day's End of Day, or its Start of Day if it wasn't ended. Ended with 0 left → null (the vial was finished).
async function lastCountedBatches(staff) {
  const out = new Map();
  if (!staff || !staff.uid) return out;
  const keys = [];
  for (let i = 1; i <= 14; i++) { const d = new Date(); d.setDate(d.getDate() - i); keys.push(keyOf(d)); }
  const snaps = await Promise.all(keys.map((k) =>
    getDoc(doc(db, "inv_kitdays", `${staff.uid}__${k}`)).catch(() => null)));
  for (const s of snaps) {
    if (!s || !s.exists()) continue;
    const day = s.data() || {};
    const seenToday = new Set();
    for (const part of [day.end, day.start]) {
      ((part && part.items) || []).forEach((it) => {
        if (!it || out.has(it.productId) || seenToday.has(it.productId)) return;
        seenToday.add(it.productId);
        const rows = it.rows || [];
        const r = rows.find((x) => x.inUse) || rows[0];
        out.set(it.productId, r && r.batch ? { batch: String(r.batch), expiry: isoKey(r.expiry) } : null);
      });
    }
  }
  return out;
}

// The batches to choose from (in my kit, then on the Shelf), with the one to pre-select:
// editing → this morning's batch; otherwise → the batch last counted
async function addBatchOptions(kit, staff) {
  if (!kit || kit.error || kit.withOptions) return kit;
  const warn = (what) => (err) => { console.warn(`${what} not loaded:`, err); return new Map(); };
  const products = kit.products.map(({ p }) => p);
  const [opts, last] = await Promise.all([
    kitBatchOptions(products).catch(warn("Batch list")),
    kit.edit ? Promise.resolve(new Map()) : lastCountedBatches(staff).catch(warn("Last batches")),
  ]);
  const editRow = (pid) => {
    const it = ((kit.edit && kit.edit.items) || []).find((x) => x.productId === pid);
    const rows = (it && it.rows) || [];
    const r = rows.find((x) => x.inUse) || rows[0];
    return r && r.batch ? { batch: String(r.batch), expiry: isoKey(r.expiry) } : null;
  };
  kit.products = kit.products.map((x) => {
    const options = [...(opts.get(x.p.id) || [])];
    const prev = x.p.tracked ? (kit.edit ? editRow(x.p.id) : last.get(x.p.id)) : null;
    // Always in the list, even if the records say it's used up
    if (prev && !options.some((o) => normB(o.batch) === normB(prev.batch))) {
      options.unshift({ batch: prev.batch, expiry: prev.expiry, where: "kit" });
    }
    return { ...x, options, batch: prev ? prev.batch : "", expiry: prev ? prev.expiry : "" };
  });
  kit.withOptions = true;
  return kit;
}
// ?sod=preview#/ : the full welcome any time, for any staff member. Nothing is saved or snoozed.
export async function previewStartOfDay(staff) {
  if (current || !staff) return;
  const kp = await kitProductsFor(staff).catch(() => []);
  if (current) return;
  const kit = kp.length ? { products: kp.map((p) => ({ p })) } : null;
  showStartOfDay(staff, kit ? { kit, preview: true } : { noKit: true, preview: true });
}
// Until today's start is saved, the welcome comes back (after login, between pages, on waking, every 5 minutes).
// It can be put off for 15 minutes, never just dismissed.
export async function maybeShowStartOfDay(staff) {
  if (!staff) return;
  refreshStartOfDayButton(staff);
  if (new URLSearchParams(location.search).get("sod") === "preview") { previewStartOfDay(staff); return; }
  watchAnnouncements(staff, { ready: dayStartedOrOff });   // must-read announcements, once their day has started
  if (await isStartOfDayOff()) return;   // Staff → Start of Day Off
  watchStartOfDay(staff);
  checkStartOfDay(staff);
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
  if (await isStartOfDayOff()) {
    showToast("Start of Day is turned off for you.");
    return false;
  }
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

// What the toast says after the kit count is saved
function kitToast(r, edit = false) {
  const lead = edit ? "Start of day updated." : "Kit count saved.";
  const notes = [];
  if (r.overnight) notes.push(`${plural(r.overnight, "overnight difference")} sent to an admin`);
  if (r.unknown) notes.push(`${plural(r.unknown, "batch")} not in your kit records yet (an admin will check)`);
  return notes.length ? `${lead} ${notes.join(" · ")}.`
    : r.differences ? `${lead} ${plural(r.differences, "difference")} will be reviewed.`
    : edit ? "Start of day updated. Everything matched." : "Kit count saved. Everything matched. Have a great day!";
}
const saveErrText = (ex) => (ex && ex.code === "permission-denied"
  ? "Couldn't save. Check the Firestore rules for inv_kitdays, inv_counts and inv_investigations have been published."
  : (ex && ex.message && !ex.code) ? ex.message : "Couldn't save. Check your connection and try again.");

export function showStartOfDay(staff, { kit = null, kitOnly = false, noKit = false, preview = false } = {}) {
  closeStartOfDay();
  const mine = session;

  const now = new Date();
  const hour = now.getHours();
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const dateText = `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  const name = friendlyName(staff.name);

  const dlg = document.createElement("dialog");
  dlg.className = "sod";
  if (preview) dlg.dataset.preview = "1";
  if (kit && kit.edit) dlg.dataset.edit = "1";
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
      <p class="sod-sub">${preview ? "Preview · nothing is saved" : "Have a great day today!"}</p>

      <div data-role="kit"></div>

      <div class="sod-cards" data-role="cards"><div class="skeleton" style="height:96px;border-radius:14px"></div></div>

      <button type="button" class="sod-btn" data-act="start">Start my day</button>
      ${preview ? "" : `<button type="button" class="sod-later" data-act="later">Remind me in ${SNOOZE_MIN} minutes</button>`}
    </div>`;

  const lay0 = !kitOnly && layoutCache.uid === staff.uid ? layoutCache.value : null;   // already loaded: open at the right size
  if (lay0) { dlg.dataset.size = lay0.size; dlg.classList.add(`size-${lay0.size}`); }
  document.body.appendChild(dlg);
  current = dlg;
  let kitMode = false;    // the kit count is on screen: clicking outside doesn't close it (nothing typed is lost)
  let kitShown = null;    // the kit products being counted in the welcome

  const img = dlg.querySelector(".sod-avatar img");
  if (img) img.addEventListener("error", () => img.remove());

  const close = () => {
    if (dlg.classList.contains("closing")) return;
    dlg.classList.add("closing");
    setTimeout(() => { if (current === dlg) closeStartOfDay(); }, 180);
  };
  // Not started yet: it can only be put off (back in 15 minutes), never just clicked away
  const later = () => { if (!preview) { snooze(staff); tellOthers("snoozed", staff); } close(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); later(); });
  dlg.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="later"]')) { later(); return; }
    if (e.target.closest('a[href^="#/"]')) later();   // a task or My dashboard: go there, the welcome comes back
  });

  // The kit check loads while they read the welcome (an error means "don't know": the day isn't started without the count)
  const kitP = (kit || noKit ? Promise.resolve(kit)
    : kitToday(staff).catch((err) => { console.warn("Kit check failed:", err); return { error: true }; }))
    .then((k) => addBatchOptions(k, staff));

  const startBtn = dlg.querySelector('[data-act="start"]');
  const kitBox = dlg.querySelector('[data-role="kit"]');

  // Injectors: "How many units remaining?" right here in the welcome
  const showKitHere = (k) => {
    if (kitShown || !k || k.error || !dlg.isConnected || mine !== session) return;
    kitShown = k.products.map(({ p }) => p);
    kitMode = true;
    kitBox.innerHTML = `<section class="sod-you sod-kitq">
        <p class="sod-you-h">Your kit</p>
        <p class="sod-note">How much is left in your kit? Put 0 if you have none.</p>
        <div class="kc-list">${kitCountHtml(k.products)}</div>
        <p class="lh-error" role="alert" hidden></p>
      </section>`;
    wireKitCount(kitBox);
    kitBox.addEventListener("input", () => { kitBox.querySelector(".lh-error").hidden = true; });
    startBtn.textContent = "Save and start my day";
  };

  startBtn.addEventListener("click", async () => {
    if (startBtn.disabled) return;
    const label = startBtn.textContent;
    startBtn.disabled = true;
    startBtn.textContent = "One moment…";
    const k = await kitP;
    if (!dlg.isConnected || mine !== session) return;
    if (k && k.error) { close(); return; }   // the button stays at the top to try again

    // A kit that hadn't appeared yet: show the question first
    if (k && !kitShown) {
      showKitHere(k);
      startBtn.disabled = false;
      return;
    }
    // Preview: the kit question can be tried out, but nothing is saved
    if (preview) {
      close();
      showToast("Preview only. Nothing was saved.");
      return;
    }
    if (await startedElsewhere(staff)) return;   // started in another window or device meanwhile
    // Kit count + start of day, together
    if (kitShown) {
      const errEl = kitBox.querySelector(".lh-error");
      const fail = (m, focus) => {
        errEl.textContent = m;
        errEl.hidden = false;
        if (focus) focus.focus();
        startBtn.disabled = false;
        startBtn.textContent = label;
      };
      const r0 = readKitCount(kitBox, kitShown);
      if (r0.error) { fail(r0.error, r0.focus); return; }
      startBtn.textContent = "Saving…";
      try {
        const r = await saveKitDayStart({ items: r0.items }, staff);
        window.dispatchEvent(new Event("kitday:changed"));
        tellOthers("started", staff);
        close();
        showToast(kitToast(r));
      } catch (ex) {
        console.error("Start of day kit count failed:", ex);
        fail(saveErrText(ex));
      }
      return;
    }

    // No kit to count: starting the day is just recorded
    try {
      await saveDayStart(staff);
      window.dispatchEvent(new Event("kitday:changed"));
      tellOthers("started", staff);
    } catch (err) {
      console.warn("Start of day not saved:", err);
      showToast("Couldn't record your start. Press “Start my day” at the top to try again.");
    }
    close();
  });

  dlg.showModal();

  if (kitOnly && kit) {
    kitMode = true;
    dlg.classList.add("is-kit");
    dlg.querySelector(".sod-card").innerHTML = '<div class="skeleton" style="height:220px;border-radius:14px"></div>';
    kitP.then((k) => { if (dlg.isConnected && mine === session) renderKit(dlg, staff, k, close); });
    return;
  }
  setTimeout(() => startBtn.focus(), 50);
  kitP.then(showKitHere);   // the kit question appears as soon as it's known

  // Remember the welcome has been shown today (and tidy up older days for this staff member)
  try {
    const prefix = `sod:${staff.uid}:`;
    Object.keys(localStorage)
      .filter((k) => k.startsWith(prefix) && k !== seenKey(staff))
      .forEach((k) => localStorage.removeItem(k));
    localStorage.setItem(seenKey(staff), "1");
  } catch { /* ignore */ }

  renderLayout(dlg, staff, { preview });
}
/* ---------- Your kit: "How many units remaining?" (blind: nothing is filled in) ---------- */
// Every clinician ticked as carrying a kit counts it, every day, whether or not they're injecting.
// kit.edit (correcting today's start): this morning's batch and expiry are filled in again; the units never are.

function renderKit(dlg, staff, kit, close) {
  dlg.classList.add("is-kit");
  const card = dlg.querySelector(".sod-card");
  const edit = kit.edit || null;
  const products = kit.products.map(({ p }) => p);
  const submitLabel = edit ? "Save changes" : "Save and start my day";


  card.innerHTML = `
    <form class="sod-kitform" novalidate>
      <p class="sod-eyebrow">Start of day${edit && edit.at ? ` · started ${esc(timeOf(edit.at))}` : ""}</p>
      <h2 id="sod-title" class="sod-title serif">${edit ? "Edit start of day" : "Your kit"}</h2>
      <p class="sod-sub">${edit
        ? "Enter what's left in your kit right now. This replaces this morning's count (it stays on record)."
        : "How much is left in your kit? Put 0 if you have none."}</p>
      <div class="kc-list">${kitCountHtml(kit.products)}</div>
      <p class="lh-error" role="alert" hidden></p>
      <div class="sod-kit-acts">
        <button type="button" class="lh-btn is-quiet" data-act="later">${edit ? "Cancel" : "Remind me later"}</button>
        <button type="submit" class="sod-btn">${submitLabel}</button>
      </div>
    </form>`;

  const form = card.querySelector("form");
  const err = card.querySelector(".lh-error");
  const showErr = (m, focus) => { err.textContent = m; err.hidden = !m; if (focus) focus.focus(); };
  wireKitCount(card);
  card.addEventListener("input", () => showErr(""));
  card.querySelector('[data-act="later"]').addEventListener("click", () => {
    if (!edit) { snooze(staff); tellOthers("snoozed", staff); }
    close();
    if (!edit) showToast(`No problem. I'll remind you again in ${SNOOZE_MIN} minutes.`);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r0 = readKitCount(card, products);
    if (r0.error) { showErr(r0.error, r0.focus); return; }
    if (!edit && await startedElsewhere(staff)) return;   // started in another window or device meanwhile

    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    showErr("");
    try {
      const r = await saveKitDayStart({ items: r0.items }, staff);
      window.dispatchEvent(new Event("kitday:changed"));
      if (!edit) tellOthers("started", staff);
      close();
      showToast(kitToast(r, !!edit));
    } catch (ex) {
      console.error("Start of day kit count failed:", ex);
      showErr(saveErrText(ex));
      btn.disabled = false;
      btn.textContent = submitLabel;
    }
  });

  const first = card.querySelector('[data-f="units"]');
  if (first) setTimeout(() => first.focus(), 50);
}


/* ---------- The welcome: the clinic today, and what's waiting for you ---------- */

// My open tasks due today or earlier, oldest first
async function myTasksDue(staff, key, all = false) {
  const snap = await getDocs(query(collection(db, "staff-task-list"), where("status", "==", "Open")));
  const ids = [staff.uid, staff.id, staff.staffId].filter(Boolean).map(String);
  const nm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => (t.assignedToId && ids.includes(String(t.assignedToId))) || (t.assignedToName && nm(t.assignedToName) === nm(staff.name)))
    .filter((t) => all || (t.dueDate && t.dueDate <= key))
    .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
}

// A note's date, from whichever date field it has (YYYY-MM-DD, DD/MM/YYYY, a Firestore Timestamp or a number)
function noteDate(x) {
  const v = x["Appointment Date"] ?? x["Date"] ?? x.date ?? x.appointmentDate ?? x["Created At"] ?? x.createdAt ?? x.timestamp;
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// My Draft consultation notes: from the last 7 days (to review now), and older ones
const NOTE_DAYS = 7;
async function myDraftNotes(staff) {
  const name = String(staff.name || "").trim();
  if (!name) return { recent: 0, older: 0 };
  const snap = await getDocs(query(collection(db, "appointment_transcripts"), where(new FieldPath("Staff Name"), "==", name)));
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - NOTE_DAYS);
  let recent = 0, older = 0;
  snap.docs.forEach((d) => {
    const x = d.data() || {};
    if (!/^draft$/i.test(String(x.Status || "").trim())) return;   // Reviewed, deleted, old imports: not counted
    const when = noteDate(x);
    if (when && when >= from) recent++; else older++;
  });
  return { recent, older };
}
// Managers: stock for today's bookings, through Inventory → Service links.
// Services linked to the same products are one group, and each booking counts once per group.
// Returns null when no service links are set up.
const NOT_SEEN = /cancel|no.?show|did not (attend|arrive)|\bdna\b|resched/i;
async function stockForToday(appts) {
  const live = (appts || []).filter((a) => !NOT_SEEN.test(String(a.status || "")));
  if (!live.length) return [];
  const links = await getServiceLinks();
  if (!links.length) return null;
  const byService = new Map(links.map((l) => [serviceKey(l.service), l]));
  const groups = new Map();
  live.forEach((a) => {
    const seen = new Set();
    (a.services || []).forEach((s) => {
      const l = byService.get(serviceKey(s));
      if (!l) return;
      const k = [...l.productIds].sort().join(",");
      if (seen.has(k)) return;
      seen.add(k);
      const g = groups.get(k) || { pids: l.productIds, services: new Set(), bookings: 0 };
      g.services.add(l.service);
      g.bookings++;
      groups.set(k, g);
    });
  });
  if (!groups.size) return [];

  const [products, opens] = await Promise.all([listProducts(), listOpenContainers().catch(() => [])]);
  const byId = new Map(products.map((p) => [p.id, p]));
  return [...groups.values()].map((g) => {
    const ps = g.pids.map((id) => byId.get(id)).filter((p) => p && p.active);
    if (!ps.length) return null;
    const kit = ps.every(isKitProduct);
    const shelf = ps.reduce((a, p) => a + p.stock.shelf, 0);
    const jt = ps.reduce((a, p) => a + p.stock.jt, 0);
    const vialUnits = Math.round(opens.filter((c) => c.kind === "vial" && g.pids.includes(c.productId))
      .reduce((a, c) => a + Math.max(0, (c.size || 0) - c.used), 0) * 10) / 10;
    return {
      name: ps.length === 1 ? ps[0].name : [...g.services][0],
      bookings: g.bookings, shelf, jt, unit: ps[0].stockUnit, doseUnit: ps[0].doseUnit || "units",
      kit, vialUnits, low: !kit && shelf + jt < g.bookings, cats: [...new Set(ps.map((p) => p.category))],
    };
  }).filter(Boolean).sort((a, b) => (b.low - a.low) || b.bookings - a.bookings);
}
/* ---------- The welcome: the cards set up in Settings → Start of Day ---------- */
// Each person's preset (or Everyone's). Kept for 10 minutes, so it's ready before the welcome opens.
const LAYOUT_TTL = 10 * 60000;
let layoutCache = { uid: "", at: 0, p: null, value: null };
function getLayout(staff) {
  const id = (staff && staff.uid) || "";
  if (layoutCache.p && layoutCache.uid === id && Date.now() - layoutCache.at < LAYOUT_TTL) return layoutCache.p;
  const entry = { uid: id, at: Date.now(), p: null, value: null };
  entry.p = loadSodLayout(staff).then((l) => { entry.value = l; return l; });
  layoutCache = entry;
  return entry.p;
}

// Started today, or Start of Day is off for them: announcements to confirm can pop up
async function dayStartedOrOff() {
  if (await isStartOfDayOff()) return true;
  const day = await getMyKitDay().catch(() => null);
  return !!(day && (day.start || day.end));
}

const CARD_ICO = {
  clinic: svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  appts: ICO.cal, tasks: ICO.task, notes: ICO.note, inventory: ICO.box,
  announcements: svg('<path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6"/><path d="M19 6a7 7 0 0 1 0 12"/>'),
  links: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  message: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
};
const sodNone = (t) => `<p class="sod-c-none">${esc(t)}</p>`;
const sodRow = (inner, href = "") => (href ? `<a class="sod-row" href="${href}">${inner}</a>` : `<div class="sod-row">${inner}</div>`);
const sodMore = (n, href, where) => (n > 0 ? `<a class="sod-c-more" href="${href}">${n} more on ${where} →</a>` : "");
const sodS = (n) => (n === 1 ? "" : "s");
const daysUntil = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  if (!m) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((new Date(+m[1], +m[2] - 1, +m[3]) - t) / 864e5);
};

function clinicBody({ appts }) {
  if (!appts) return sodNone("Couldn't load today's appointments.");
  if (!appts.length) return sodNone("No appointments are scheduled today.");
  const clin = new Set(appts.map((a) => a.staff).filter(Boolean)).size;
  return `<div class="sod-stats">
    <div class="sod-stat"><strong>${appts.length}</strong><span>appointments today</span></div>
    <div class="sod-stat"><strong>${clin}</strong><span>clinicians on</span></div></div>`;
}

function apptsBody(c, { appts, staff }) {
  if (!appts) return sodNone("Couldn't load your appointments.");
  const mine = appts.filter((a) => sameStaff(a.staff, staff.name) && !NOT_SEEN.test(String(a.status || "")))
    .sort((a, b) => (Number(a.sortMinutes) || 0) - (Number(b.sortMinutes) || 0));
  if (!mine.length) return sodNone("No appointments with you today.");
  const rows = mine.slice(0, c.cfg.max).map((a) => sodRow(
    `<b>${esc(a.time || "")}</b><span>${esc(a.patientName || "Patient")}<small>${esc((a.services || []).join(", "))}</small></span>`,
    a.patientId ? `#/patient/${encodeURIComponent(a.patientId)}` : ""));
  return `<div class="sod-rows">${rows.join("")}</div>${sodMore(mine.length - c.cfg.max, "#/calendar", "the Calendar")}`;
}

function tasksBody(c, { tasks, key }) {
  if (!tasks) return sodNone("Couldn't load your tasks.");
  if (!tasks.length) return sodNone(c.cfg.show === "all" ? "No open tasks." : "Nothing due today.");
  const when = (t) => (!t.dueDate ? "No due date" : t.dueDate < key ? `Overdue (${niceDate(t.dueDate)})`
    : t.dueDate === key ? "Due today" : `Due ${niceDate(t.dueDate)}`);
  const rows = tasks.slice(0, c.cfg.max).map((t) => sodRow(
    `<span>${esc(t.taskText || "Reminder")}<small>${esc([t.patientName, when(t)].filter(Boolean).join(" · "))}</small></span>${
      t.dueDate && t.dueDate < key ? '<em class="is-bad">Overdue</em>' : ""}`,
    t.patientId ? `#/patient/${encodeURIComponent(t.patientId)}` : ""));
  return `<div class="sod-rows">${rows.join("")}</div>${sodMore(tasks.length - c.cfg.max, "#/home", "My dashboard")}`;
}

function notesBody({ notes }) {
  if (!notes) return sodNone("Couldn't load your consultation notes.");
  if (!notes.recent && !notes.older) return sodNone("No consultation notes waiting for review.");
  return `<div class="sod-rows">${sodRow(`<span>${notes.recent
    ? `${notes.recent} consultation note${sodS(notes.recent)} from the last week` : "None from the last week"}${
    notes.older ? `<small>and ${notes.older} older</small>` : ""}</span>`, "#/home")}</div>`;
}

function linksBody(c) {
  const list = c.cfg.links || [];
  if (!list.length) return "";
  return `<div class="sod-links">${list.map((l) => (/^https:/i.test(l.href)
    ? `<a class="sod-link" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}</a>`
    : `<a class="sod-link" href="${esc(l.href)}">${esc(l.label)}</a>`)).join("")}</div>`;
}

const messageBody = (c) => {
  const t = String(c.cfg.text || "").trim();
  return t ? `<div class="sod-msg">${esc(t).replace(/\n/g, "<br>")}</div>` : "";
};

// Inventory highlights: only what the card is set to show, in its categories and place
async function inventoryBody(cfg, appts) {
  const want = new Set(cfg.show);
  const locs = cfg.loc === "any" ? ["shelf", "jt"] : [cfg.loc];
  const catOk = (cat) => !cfg.cats.length || cfg.cats.includes(cat);
  const quiet = (what) => (err) => { console.warn(`Start of Day ${what} failed:`, err); return undefined; };
  const [products, lots, reqs, today] = await Promise.all([
    want.has("low") || want.has("expiring") ? listProducts().catch(quiet("products")) : null,
    want.has("expiring") ? listAllLots().catch(quiet("batches")) : null,
    want.has("requests") ? listRequests().catch(quiet("order requests")) : null,
    want.has("today") && appts ? stockForToday(appts).catch(quiet("stock for today")) : null,
  ]);
  const byId = new Map((products || []).map((p) => [p.id, p]));
  const secs = [];
  const fail = (what) => sodNone(`Couldn't load ${what}.`);

  if (want.has("today")) {
    if (!appts || today === undefined) secs.push({ title: "Stock for today", body: fail("stock for today") });
    else if (today === null) secs.push({ title: "Stock for today", body: sodNone("Link services to products in Inventory → Service links to see this.") });
    else {
      const list = today.filter((s) => !s.cats || !s.cats.length || s.cats.some(catOk));
      if (list.length) {
        const rows = list.slice(0, cfg.max).map((s) => {
          const where = locs.map((l) => (l === "shelf" ? s.shelf && `${plural(s.shelf, s.unit)} on the Shelf`
            : s.jt && `${plural(s.jt, s.unit)} in JT storage`)).filter(Boolean).join(", ") || `No ${unitPlural(s.unit)} in stock`;
          const vial = s.kit && s.vialUnits ? `Opened vial ${s.vialUnits} ${s.doseUnit} · ` : "";
          return sodRow(`<span>${esc(s.name)}<small>${esc(vial + where)}</small></span><em class="${s.low ? "is-bad" : ""}">${
            s.bookings} booking${sodS(s.bookings)}</em>`);
        });
        secs.push({ title: "Stock for today", body: `<div class="sod-rows">${rows.join("")}</div>${sodMore(list.length - cfg.max, "#/inventory", "Inventory")}` });
      }
    }
  }
  if (want.has("low")) {
    if (!products) secs.push({ title: "Low stock", body: fail("stock levels") });
    else {
      const low = products.filter((p) => p.active && catOk(p.category))
        .flatMap((p) => locs.filter((l) => lowAt(p, l)).map((l) => ({ p, l })));
      if (low.length) {
        const rows = low.slice(0, cfg.max).map(({ p, l }) => sodRow(
          `<span>${esc(p.name)}<small>${esc(locLabel(l))}</small></span><em class="is-bad">${esc(plural(p.stock[l], p.stockUnit))} left</em>`));
        secs.push({ title: `Low stock · ${low.length}`, body: `<div class="sod-rows">${rows.join("")}</div>${sodMore(low.length - cfg.max, "#/inventory", "Inventory")}` });
      }
    }
  }
  if (want.has("expiring")) {
    if (!products || !lots) secs.push({ title: "Expiring soon", body: fail("expiry dates") });
    else {
      const soon = lots.filter((l) => locs.includes(l.loc) && l.qty > 0 && l.expiry)
        .map((l) => ({ l, p: byId.get(l.productId), d: daysUntil(l.expiry) }))
        .filter((x) => x.p && x.p.active && catOk(x.p.category) && x.d !== null && x.d <= cfg.days)
        .sort((a, b) => a.d - b.d);
      if (soon.length) {
        const rows = soon.slice(0, cfg.max).map(({ l, p, d }) => sodRow(
          `<span>${esc(p.name)}<small>${esc([batchText(p, l.batch), plural(l.qty, p.stockUnit), locLabel(l.loc)].filter(Boolean).join(" · "))}</small></span>`
          + `<em class="${d < 0 ? "is-bad" : "is-warn"}">${d < 0 ? "Expired" : d === 0 ? "Today" : `${d} day${sodS(d)}`}</em>`));
        secs.push({ title: `Expiring soon · ${soon.length}`, body: `<div class="sod-rows">${rows.join("")}</div>${sodMore(soon.length - cfg.max, "#/inventory", "Inventory")}` });
      }
    }
  }
  if (want.has("requests")) {
    if (!reqs) secs.push({ title: "Order requests", body: fail("order requests") });
    else {
      const open = reqs.filter((r) => r.status === "open");
      if (open.length) {
        const rows = open.slice(0, cfg.max).map((r) => {
          const tag = r.urgency === "urgent" ? ["is-bad", "Urgent"] : awaitingApproval(r) ? ["is-warn", "Needs approval"] : ["", "Open"];
          const names = r.items.map((i) => i.name);
          return sodRow(`<span>${esc(reqNumber(r))}${r.requestedBy ? ` · ${esc(r.requestedBy)}` : ""}<small>${
            esc(names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : ""))}</small></span><em class="${tag[0]}">${tag[1]}</em>`);
        });
        secs.push({ title: `Order requests · ${open.length}`, body: `<div class="sod-rows">${rows.join("")}</div>${sodMore(open.length - cfg.max, "#/inventory", "Inventory")}` });
      }
    }
  }
  if (!secs.length) return sodNone("Nothing to flag. Stock looks fine.");
  const heads = want.size > 1;
  return secs.map((s) => `${heads ? `<p class="sod-c-h">${esc(s.title)}</p>` : ""}${s.body}`).join("");
}

async function renderLayout(dlg, staff, { preview = false } = {}) {
  const box = dlg.querySelector('[data-role="cards"]');
  if (!box) return;
  const lay = await getLayout(staff);
  if (!box.isConnected) return;
  if (!dlg.dataset.size) { dlg.dataset.size = lay.size; dlg.classList.add(`size-${lay.size}`); }

  const cards = lay.cards.filter((c) => c.type !== "inventory" || !c.cfg.stockOnly || can("menu.inventory"));
  const has = (t) => cards.some((c) => c.type === t);
  const inv = cards.find((c) => c.type === "inventory");
  const tasksCard = cards.find((c) => c.type === "tasks");
  const key = toDateKey();
  const [apR, tkR, ntR] = await Promise.allSettled([
    has("clinic") || has("appts") || (inv && inv.cfg.show.includes("today")) ? fetchDayAppointments(key) : Promise.resolve(null),
    tasksCard ? myTasksDue(staff, key, tasksCard.cfg.show === "all") : Promise.resolve(null),
    has("notes") ? myDraftNotes(staff) : Promise.resolve(null),
  ]);
  [apR, tkR, ntR].forEach((r) => { if (r.status === "rejected") console.warn("Start of Day card failed:", r.reason); });
  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  const appts = val(apR) ? val(apR).appointments || [] : null;
  const invHtml = inv ? await inventoryBody(inv.cfg, appts) : "";
  // Announcements: still to confirm always show, then the newest up to the card's limit
  const annCard = cards.find((c) => c.type === "announcements");
  const anns = annCard
    ? await listMyAnnouncements(staff).catch((err) => { console.warn("Start of Day announcements failed:", err); return null; })
    : [];
  let annShown = [];
  let annHtml = "";
  if (annCard) {
    const manage = can("sod.manage") ? '<a class="sod-c-more" href="#/settings/sod/announcements">Post or manage announcements →</a>' : "";
    if (!anns) annHtml = sodNone("Couldn't load announcements.") + manage;
    else {
      const must = anns.filter((a) => a.confirm && !a.confirmed);
      const rest = anns.filter((a) => !(a.confirm && !a.confirmed));
      annShown = [...must, ...rest.slice(0, Math.max(0, annCard.cfg.max - must.length))];
      annHtml = annShown.length ? annShown.map(annCardHtml).join("") + manage
        : manage ? sodNone("No announcements right now.") + manage : "";
    }
  }
  if (!box.isConnected) return;

  const ctx = { staff, key, appts, tasks: val(tkR), notes: val(ntR) };
  const body = (c) => {
    switch (c.type) {
      case "clinic": return clinicBody(ctx);
      case "appts": return apptsBody(c, ctx);
      case "tasks": return tasksBody(c, ctx);
      case "notes": return notesBody(ctx);
      case "inventory": return invHtml;
      case "links": return linksBody(c);
      case "message": return messageBody(c);
      case "announcements": return annHtml;
      default: return "";
    }
  };
  const cardHtml = (c) => {
    const b = body(c);
    return b ? `<section class="sod-c is-${c.type}${c.type === "message" ? ` tone-${c.cfg.tone}` : ""}">
      <header><span class="sod-c-ic">${CARD_ICO[c.type] || ""}</span><h3>${esc(c.title)}</h3></header>${b}</section>` : "";
  };
  const n = lay.arrange === "grid" ? 3 : lay.arrange === "split" ? 2 : 1;
  box.innerHTML = sodBands(cards, n).map((band) => (band.full
    ? `<div class="sod-band">${cardHtml(band.cards[0])}</div>`
    : `<div class="sod-band${n > 1 ? " is-cols" : ""}" style="--sod-cols:${sodColumnsCss(lay.arrange, lay.split)}">${
      Array.from({ length: n }, (_, i) => `<div class="sod-col">${
        band.cards.filter((c) => n === 1 || c.col === i + 1).map(cardHtml).join("")}</div>`).join("")}</div>`)).join("");
  if (annShown.length) {
    wireAnnouncements(box, annShown, staff, { preview });
    if (!preview) markSeen(annShown, staff);
  }
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
  if (await isStartOfDayOff()) { showToast("Start of Day is turned off for you."); return; }
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

// "Edit start of day": a pill beside "End my day", and the item in the profile menu.
// Shown from the moment the day is started until it's ended.
function editPill() {
  let b = document.getElementById("sod-edit-btn");
  if (!b) {
    const host = document.querySelector(".tb-day");
    if (!host) return null;
    b = document.createElement("button");
    b.type = "button";
    b.id = "sod-edit-btn";
    b.hidden = true;
    host.insertBefore(b, document.getElementById("eod-btn"));
  }
  if (!b.dataset.wired) {
    b.dataset.wired = "1";
    b.className = "tb-pill is-edit";
    b.title = "Got this morning's kit count wrong? Fix it here";
    b.innerHTML = `${EDIT}<span>Edit start of day</span>`;
    b.addEventListener("click", async () => {
      if (!btnStaff || b.disabled) return;
      b.disabled = true;
      try { await openStartOfDayEdit(btnStaff); } finally { b.disabled = false; }
    });
  }
  return b;
}

function setEditable(on) {
  const pill = editPill();
  if (pill) pill.hidden = !on;
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
  const [info, off] = await Promise.all([
    dayInfo(staff).catch((err) => { console.warn("Day check failed:", err); return null; }),
    isStartOfDayOff(),
  ]);
  if (mine !== btnCheck || btnStaff !== staff) return;
  setPending(!off && !!info && !info.started);   // off: no "Start my day", and "End my day" shows straight away
  setEditable(!!info && info.canEdit);
}

// On logout
export function hideStartOfDayButton() {
  watchStaff = null;
  stopAnnouncements();
  startedKey = "";
  btnStaff = null;
  btnCheck++;
  setPending(false);
  setEditable(false);
  // Until the next person's day has been checked, "End my day" stays hidden
  const dayBar = document.querySelector(".tb-day");
  if (dayBar) dayBar.classList.add("sod-pending");
}
// Started, corrected or ended: refresh the top bar
window.addEventListener("kitday:changed", () => { if (btnStaff) refreshStartOfDayButton(btnStaff); });