// Phones: a bottom bar with four shortcuts and More (a sheet with every other page).
// Built from the sidebar's links, so access (hidden pages), the active page and badges always match it.
// Each person can choose their own four shortcuts; they're saved on that phone.
import { showToast } from "./utils.js";

const PREF_KEY = "dm.mnav";
const MAX = 5;
// The default shortcuts, best first (only pages the person can open are used)
const DEFAULT = ["home", "patients", "calendar", "scanner", "tasks", "inventory", "recall", "reports", "forms", "help", "staff", "settings"];
const SHORT = {
  home: "Dashboard", patients: "Patients", calendar: "Calendar", forms: "Forms", tasks: "Tasks", recall: "Recall",
  inventory: "Inventory", scanner: "Scanner", reports: "Reports", staff: "Staff", settings: "Settings", help: "Help",
};
const MORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const readPins = () => {
  try {
    const a = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
    return Array.isArray(a) ? a.filter((k) => SHORT[k]).slice(0, MAX) : null;
  } catch { return null; }
};
const savePins = (a) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(a)); } catch { /* private mode */ } };

const sidebar = document.querySelector(".sidebar");
const shell = document.getElementById("dashboard-view");
if (sidebar && shell) init();

function init() {
  const bar = document.createElement("nav");
  bar.className = "mnav";
  bar.setAttribute("aria-label", "Main");
  shell.appendChild(bar);

  const sheet = document.createElement("dialog");
  sheet.className = "mnav-sheet";
  sheet.setAttribute("aria-label", "All pages");
  document.body.appendChild(sheet);
  let editing = false;

  // The pages this person can open, in menu order
  const items = () => [...sidebar.querySelectorAll(".nav-item")].filter((a) => !a.hidden && a.dataset.page);
  const iconOf = (a) => { const s = a.querySelector("svg"); return s ? s.outerHTML : ""; };
  const badgeOf = (a) => { const b = a.querySelector(".nav-badge"); return b && !b.hidden && b.textContent.trim() ? b.outerHTML : ""; };
  const fullName = (a) => { const s = a.querySelector("span:not(.nav-badge)"); return (s ? s.textContent : a.textContent).trim(); };
  const shortName = (a) => SHORT[a.dataset.page] || fullName(a);
  const isOn = (a) => a.classList.contains("active");

  // The shortcuts: everything if 5 or fewer pages; otherwise the person's own choice, or the defaults
  function shortcuts(list) {
    const keys = list.map((a) => a.dataset.page);
    if (keys.length <= MAX + 1) return keys;
    const pins = (readPins() || []).filter((k) => keys.includes(k));
    if (pins.length) return pins;
    return [...DEFAULT, ...keys].filter((k, i, all) => keys.includes(k) && all.indexOf(k) === i).slice(0, MAX);
  }

  function render() {
    const list = items();
    if (!list.length) { bar.innerHTML = ""; return; }
    const byKey = new Map(list.map((a) => [a.dataset.page, a]));
    const top = shortcuts(list);
    const rest = list.filter((a) => !top.includes(a.dataset.page));
    const activeRest = rest.find(isOn);
    const link = (a) => `<a class="mnav-item${isOn(a) ? " is-on" : ""}" href="${esc(a.getAttribute("href"))}"${
      isOn(a) ? ' aria-current="page"' : ""}>${iconOf(a)}<span>${esc(shortName(a))}</span>${badgeOf(a)}</a>`;
    bar.innerHTML = top.map((k) => link(byKey.get(k))).join("") + (rest.length
      ? `<button type="button" class="mnav-item${activeRest ? " is-on" : ""}" data-act="more" aria-haspopup="dialog">
          ${MORE_ICON}<span>${esc(activeRest ? shortName(activeRest) : "More")}</span>${
          rest.some((a) => badgeOf(a)) ? '<em class="mnav-dot" aria-hidden="true"></em>' : ""}</button>`
      : "");
    bar.style.setProperty("--n", String(top.length + (rest.length ? 1 : 0)));
    if (sheet.open) renderSheet();
  }

  function renderSheet() {
    const list = items();
    const top = shortcuts(list);
    const shown = editing ? list : list.filter((a) => !top.includes(a.dataset.page));
    const canEdit = list.length > MAX + 1;
    sheet.innerHTML = `<div class="mnav-sheet-in">
      <div class="mnav-sheet-head">
        <strong>${editing ? "Choose your shortcuts" : "All pages"}</strong>
        ${canEdit ? `<button type="button" class="lh-btn is-quiet" data-act="${editing ? "done" : "edit"}">${editing ? "Done" : "Edit shortcuts"}</button>` : ""}
      </div>
      ${editing ? `<p class="mnav-hint">Tick up to ${MAX} pages for the bar at the bottom. They're saved on this phone.</p>` : ""}
      <div class="mnav-grid">${shown.map((a) => {
        const k = a.dataset.page;
        if (editing) {
          const pinned = top.includes(k);
          return `<button type="button" class="mnav-tile${pinned ? " is-pinned" : ""}" data-pin="${esc(k)}" aria-pressed="${pinned}">
            ${iconOf(a)}<span>${esc(fullName(a))}</span>${pinned ? '<em class="mnav-check" aria-hidden="true">✓</em>' : ""}</button>`;
        }
        return `<a class="mnav-tile${isOn(a) ? " is-on" : ""}" href="${esc(a.getAttribute("href"))}">
          ${iconOf(a)}<span>${esc(fullName(a))}</span>${badgeOf(a)}</a>`;
      }).join("")}</div>
    </div>`;
  }

  function openSheet() {
    editing = false;
    renderSheet();
    if (!sheet.open) sheet.showModal();
  }

  bar.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="more"]')) openSheet();
  });

  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) { sheet.close(); return; }   // tapped the dimmed area
    const act = e.target.closest("[data-act]");
    if (act) {
      editing = act.dataset.act === "edit";
      renderSheet();
      if (!editing) render();
      return;
    }
    const pin = e.target.closest("[data-pin]");
    if (pin) {
      const k = pin.dataset.pin;
      let p = (readPins() || shortcuts(items())).slice();
      if (p.includes(k)) p = p.filter((x) => x !== k);
      else if (p.length >= MAX) { showToast(`Up to ${MAX} shortcuts. Untick one first.`); return; }
      else p.push(k);
      savePins(p);
      render();
      renderSheet();
      return;
    }
    if (e.target.closest("a[href]")) sheet.close();   // going to a page
  });

  window.addEventListener("hashchange", () => { if (sheet.open) sheet.close(); });

  // Keep in step with the sidebar: access changes, the active page, badges
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  };
  new MutationObserver(schedule).observe(sidebar, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden"],
  });
  render();
}