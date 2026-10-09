// Tells open portals when a new version has been deployed (version.json, written by deploy.ps1).
const CHECK_EVERY = 5 * 60 * 1000;
let loaded = null;     // the version this page started with
let lastCheck = 0;
let banner = null;
let autoReload = () => false;

async function fetchVersion() {
  const res = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

// Fetches every file fresh (so nothing old comes from the browser's cache), then reloads
async function refreshNow(v) {
  if (banner) {
    const btn = banner.querySelector('[data-act="refresh"]');
    if (btn) { btn.disabled = true; btn.textContent = "Updating…"; }
  }
  const files = Array.isArray(v && v.files) ? v.files : [];
  await Promise.allSettled(files.map((f) => fetch(f, { cache: "reload" })));
  location.reload();
}

function showBanner(v) {
  if (banner) return;
  banner = document.createElement("div");
  banner.className = "upd-bar";
  banner.setAttribute("role", "status");
  banner.innerHTML = `
    <span>✨ <strong>A new version of the portal is ready.</strong> Finish what you're doing, then refresh.</span>
    <span class="upd-acts">
      <button type="button" class="upd-btn is-primary" data-act="refresh">Refresh now</button>
      <button type="button" class="upd-btn" data-act="later">Later</button>
    </span>`;
  banner.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "refresh") refreshNow(v);
    if (b.dataset.act === "later") { banner.remove(); banner = null; }
  });
  document.body.appendChild(banner);
}

async function check(force = false) {
  if (!force && Date.now() - lastCheck < 60000) return; // at most once a minute
  lastCheck = Date.now();
  let v = null;
  try { v = await fetchVersion(); } catch { return; }
  if (!v || !v.version) return;
  if (!loaded) { loaded = v.version; return; }
  if (v.version === loaded || banner) return;
  if (autoReload()) { refreshNow(v); return; }  // e.g. on the login screen: nothing to lose
  showBanner(v);
}

// canAutoReload: returns true when it's safe to refresh without asking
export function initUpdateCheck({ canAutoReload } = {}) {
  if (typeof canAutoReload === "function") autoReload = canAutoReload;
  check(true);
  setInterval(() => check(true), CHECK_EVERY);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  window.addEventListener("focus", () => check());
}