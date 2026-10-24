// Dermedica Scan (scan.html): the Scanner on its own, for phones and tablets.
// PIN, then straight to the camera. The same scanner, login and access as the portal.
// Shared iPads lock after 10 minutes without use; "Keep me signed in" (your own phone) stays signed in.
import "./force-refresh.js";   // first: "Update everyone's portal" refreshes this app too (never mid-scan)
import { auth } from "./firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { loginWithPin, watchAuth, warmUpLogin } from "./auth.js";
import { setPerms, can, refreshAccess } from "./perms.js";
import { mountScanner } from "./scanner.js";
import { getInitials } from "./utils.js";

const REMEMBER_KEY = "dm.scanRemember";
const LOCK_MIN = 10;
const $ = (id) => document.getElementById(id);
const remembered = () => { try { return localStorage.getItem(REMEMBER_KEY) === "1"; } catch { return false; } };
const setRemember = (on) => { try { localStorage.setItem(REMEMBER_KEY, on ? "1" : "0"); } catch { /* private mode */ } };
const views = { boot: $("sa-boot"), login: $("sa-login"), app: $("sa-app") };
const show = (name) => Object.entries(views).forEach(([k, el]) => { el.hidden = k !== name; });

let staff = null;
let lastActive = Date.now();
let timers = [];
let pin = "";
let busy = false;

/* ---------- PIN ---------- */
function drawPin() {
  $("sa-dots").innerHTML = Array.from({ length: Math.max(4, pin.length) },
    (_, i) => `<span class="${i < pin.length ? "is-on" : ""}"></span>`).join("");
  $("sa-go").disabled = busy || pin.length < 4;
}
const setErr = (t) => { $("sa-err").textContent = t || ""; };
function shake() {
  const c = $("sa-card");
  c.classList.remove("shake");
  void c.offsetWidth;
  c.classList.add("shake");
}
function key(k) {
  if (busy) return;
  setErr("");
  if (k === "del") pin = pin.slice(0, -1);
  else if (k === "go") { submit(); return; }
  else if (/^\d$/.test(k) && pin.length < 8) pin += k;
  drawPin();
}
async function submit() {
  if (busy || pin.length < 4) return;
  busy = true;
  drawPin();
  $("sa-go").textContent = "Checking…";
  const keep = $("sa-keep").checked;
  setRemember(keep);
  try {
    await loginWithPin(pin, { remember: keep });   // watchAuth opens the scanner
  } catch (err) {
    setErr((err && err.message) || "Couldn't log in. Try again.");
    shake();
  } finally {
    pin = "";
    busy = false;
    $("sa-go").textContent = "Unlock";
    drawPin();
  }
}
$("sa-keys").addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) key(b.dataset.k); });
document.addEventListener("keydown", (e) => {
  if (views.login.hidden) return;
  if (/^\d$/.test(e.key)) key(e.key);
  else if (e.key === "Backspace") key("del");
  else if (e.key === "Enter") key("go");
});

function showLogin(note = "") {
  $("sa-note").textContent = note || "Enter your PIN";
  $("sa-keep").checked = remembered();
  pin = "";
  setErr("");
  drawPin();
  show("login");
  warmUpLogin();   // wakes Apps Script while the PIN is typed
}

/* ---------- The scanner ---------- */
function openScanner() {
  show("app");
  $("sa-name").textContent = staff.name;
  $("sa-av").textContent = getInitials(staff.name);
  history.replaceState(null, "", "#/scanner");   // the scanner switches the camera off if this changes
  const main = $("sa-main");
  if (!can("menu.scanner")) {
    main.innerHTML = `<section class="page"><div class="state"><strong>No scanner access</strong>
      Ask an Admin to tick “Scanner” for your role in Staff → Roles &amp; access.</div></section>`;
  } else {
    mountScanner(main, { staff, kindPicker: false });
  }
  startTimers();
}

// The scanner lets go of the camera, then the app goes back to the PIN
async function lock(note = "") {
  stopTimers();
  history.replaceState(null, "", "#/locked");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  $("sa-main").innerHTML = "";
  staff = null;
  setRemember(false);
  sessionStorage.removeItem("appSession");
  showLogin(note);
  await signOut(auth).catch(() => {});   // this app only: open portal tabs stay logged in
}
$("sa-switch").addEventListener("click", () => lock());

/* ---------- Locking and access ---------- */
const scanning = () => !!document.querySelector(".scan-busy");
const idle = () => Date.now() - lastActive > LOCK_MIN * 60000;
["pointerdown", "keydown", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true, capture: true }));
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !staff) return;
  if (!remembered() && idle()) lock(`Locked after ${LOCK_MIN} minutes without use.`);
  else checkAccess();
});

const scanSig = () => ["menu.scanner", "scanner.billing", "scanner.docket", "scanner.rx"].map((p) => (can(p) ? 1 : 0)).join("");
async function checkAccess() {
  if (!staff) return;
  try {
    const before = scanSig();
    const r = await refreshAccess();   // also keeps the Apps Script session renewed
    if (!r.changed || !staff) return;
    staff = { ...staff, role: r.role || staff.role, perms: r.perms, injector: r.injector };
    setPerms(staff);
    if (scanSig() !== before && !scanning()) openScanner();
  } catch (err) {
    console.warn("Access check failed:", err);
  }
}

function stopTimers() { timers.forEach(clearInterval); timers = []; }
function startTimers() {
  stopTimers();
  lastActive = Date.now();
  timers.push(setInterval(checkAccess, 5 * 60000));
  timers.push(setInterval(() => {
    if (staff && !remembered() && idle() && !scanning()) lock(`Locked after ${LOCK_MIN} minutes without use.`);
  }, 30000));
}

// Receiving a delivery happens in the full portal (same device, still logged in, with the docket filled in)
window.addEventListener("hashchange", () => {
  if (/^#\/inventory\/receive\//.test(location.hash)) location.replace(`index.html${location.hash}`);
});

/* ---------- Start ---------- */
watchAuth((s) => {
  if (!s) {
    if (staff) { stopTimers(); staff = null; $("sa-main").innerHTML = ""; }
    showLogin();
    return;
  }
  const same = staff && staff.uid === s.uid;
  staff = s;
  setPerms(s);
  if (!same) openScanner();   // the same person with a refreshed login token: nothing to redraw
});