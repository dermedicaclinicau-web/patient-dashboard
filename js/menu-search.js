// A search box at the top of long pop-up menus (.fp-menu), e.g. Email the patient on the patient dashboard.
// Works on any .fp-menu with 6 or more items, however and whenever the menu is opened.
const MIN_ITEMS = 6;
const ITEM = 'button, a[href], [role="menuitem"]';
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const finePointer = () => window.matchMedia && matchMedia("(pointer: fine)").matches;

// The clickable items (not the search box, and not buttons nested inside another item)
function itemsOf(menu) {
  return [...menu.querySelectorAll(ITEM)].filter((el) =>
    !el.closest(".fpm-search") && !(el.parentElement && el.parentElement.closest(ITEM) && menu.contains(el.parentElement.closest(ITEM))));
}
// What to hide for an item: its list row if it has one, otherwise the item itself
const rowOf = (menu, el) => { const li = el.closest("li"); return li && menu.contains(li) ? li : el; };

function filter(menu) {
  const input = menu.querySelector(".fpm-search input");
  const none = menu.querySelector(".fpm-none");
  if (!input) return;
  const words = norm(input.value).split(" ").filter(Boolean);
  let shown = 0;
  itemsOf(menu).forEach((el) => {
    const ok = words.every((w) => norm(el.textContent).includes(w));
    rowOf(menu, el).style.display = ok ? "" : "none";
    if (ok) shown++;
  });
  none.hidden = shown > 0;
}

const firstShown = (menu) => itemsOf(menu).find((el) => rowOf(menu, el).style.display !== "none");

function enhance(menu) {
  if (menu.dataset.searchable || itemsOf(menu).length < MIN_ITEMS) return false;
  menu.dataset.searchable = "1";
  const box = document.createElement("div");
  box.className = "fpm-search";
  box.innerHTML = `<input type="search" class="fe-input" placeholder="Search…" aria-label="Search this list"
      autocomplete="off" spellcheck="false" enterkeyhint="go" />
    <p class="fpm-none" hidden>No matches</p>`;

  // Under the heading ("Email the patient") if there is one, otherwise at the top
  const first = menu.firstElementChild;
  if (first && !first.matches(ITEM) && !first.querySelector(ITEM)) first.after(box);
  else menu.prepend(box);

  const input = box.querySelector("input");
  input.addEventListener("input", () => filter(menu));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (input.value) { e.preventDefault(); e.stopPropagation(); input.value = ""; filter(menu); }
      return;   // empty: Esc closes the menu as before
    }
    e.stopPropagation();   // typing never triggers the menu's own shortcuts
    if (e.key === "Enter") { e.preventDefault(); const b = firstShown(menu); if (b) b.click(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); const b = firstShown(menu); if (b) b.focus(); }
  });
  return true;
}

// Each time a menu opens: a fresh, empty search (and the cursor in it on a computer, not on the iPad)
function opened(menu) {
  const input = menu.querySelector(".fpm-search input");
  if (!input) return;
  input.value = "";
  filter(menu);
  if (finePointer()) setTimeout(() => input.focus(), 30);
}

let queued = false;
function scan() {
  queued = false;
  document.querySelectorAll(".fp-menu").forEach((m) => {
    const visible = m.getClientRects().length > 0;
    if (!visible) { m._fpmOpen = false; return; }
    const added = enhance(m);   // also catches items that load a moment after the menu opens
    if (!m._fpmOpen || added) { m._fpmOpen = true; opened(m); }
  });
}
new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } })
  .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style", "open"] });