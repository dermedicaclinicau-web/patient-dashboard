// Tells open portals when a new version has been deployed (version.json, written by deploy.ps1).
import { freshReload } from "./fresh-reload.js";
const CHECK_EVERY = 5 * 60 * 1000;
const CDN_WAIT = 11 * 60 * 1000;   // GitHub Pages can hand out the old files for up to 10 minutes after a deploy
let loaded = null;     // the version this page started with
let lastCheck = 0;
let banner = null;
let autoReload = () => false;
let seen = { version: "", at: 0 };   // a newer version, and when this tab first saw it
let waitTimer = null;

// When it was deployed: "20261028-083123" from deploy.ps1 (Perth time), or 0
function deployedAt(v) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String((v && v.version) || ""));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600000 : 0;
}

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
  // The files deploy.ps1 listed, then every file this tab has loaded (freshReload reloads the page when done)
  const files = Array.isArray(v && v.files) ? v.files : [];
  await Promise.allSettled(files.map((f) => fetch(f, { cache: "reload" })));
  await freshReload();
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

  // Wait until GitHub Pages is handing out the new files, so a refresh really gets them
  if (seen.version !== v.version) seen = { version: v.version, at: Date.now() };
  const d = deployedAt(v);
  const since = d && d <= seen.at && seen.at - d < 2 * 3600000 ? d : seen.at;   // the deploy time, if it looks right
  const wait = since + CDN_WAIT - Date.now();
  if (wait > 0) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => check(true), Math.min(wait + 1000, CHECK_EVERY));
    return;
  }

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