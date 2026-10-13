// Top bar: the profile menu (name, Start / End my day, Edit my name, Log out)
const $ = (id) => document.getElementById(id);
let wired = false;

// Whichever day button is showing in the bar right now (Start my day, End my day or Day ended)
function visibleDayBtn() {
  return ["sod-btn", "eod-btn"].map($).find((b) => b && !b.hidden && getComputedStyle(b).display !== "none") || null;
}

function setOpen(open) {
  const btn = $("me-btn");
  const menu = $("me-menu");
  if (!btn || !menu) return;
  if (open) {
    menu.querySelector('[data-tb="name"]').textContent = ($("staff-name") || {}).textContent || "";
    menu.querySelector('[data-tb="role"]').textContent = ($("staff-role") || {}).textContent || "";
    const day = visibleDayBtn();
    const item = $("me-day");
    if (item) { item.hidden = !day; if (day) item.innerHTML = day.innerHTML; }
  }
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open) { const first = menu.querySelector(".tb-mi:not([hidden])"); if (first) first.focus(); }
}

export function initTopbar() {
  if (wired) return;
  const btn = $("me-btn");
  const menu = $("me-menu");
  if (!btn || !menu) return;
  wired = true;
  btn.addEventListener("click", () => setOpen(menu.hidden));
  // Any menu item closes the menu. Edit my name and Log out keep their own handlers in app.js.
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".tb-mi");
    if (!item) return;
    setOpen(false);
    if (item.id === "me-day") { const d = visibleDayBtn(); if (d) d.click(); }
  });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".tb-me")) setOpen(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { setOpen(false); btn.focus(); }
  });
}

export function closeTopbarMenu() { setOpen(false); }