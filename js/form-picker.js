// Turns the Consent record / Treatment record / Prescription tiles on the
// patient dashboard into dropdowns of published forms.
import { listPublishedForms, categoryLabel } from "./form-templates.js";
import { esc } from "./form-fields.js";

// Tile label (its data-soon value) -> form category
const TILE_CATEGORY = {
  "Consent record": "consent",
  "Treatment record": "treatment",
  "Prescription": "prescription",
};

let menu = null;
let anchor = null;

function patientIdFromHash() {
  const m = location.hash.match(/^#\/patient\/(.+)$/);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return ""; }
}

export function closeFormPicker(returnFocus = false) {
  if (menu) { menu.remove(); menu = null; }
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    if (returnFocus) anchor.focus();
    anchor = null;
  }
}

function position() {
  if (!menu || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(Math.max(r.width, 300), window.innerWidth - 24);
  const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  menu.style.width = w + "px";
  menu.style.left = left + "px";
  if (below >= 260 || below >= above) {
    menu.style.top = r.bottom + 6 + "px";
    menu.style.bottom = "auto";
    menu.style.maxHeight = Math.max(160, Math.min(440, below - 6)) + "px";
  } else {
    menu.style.top = "auto";
    menu.style.bottom = window.innerHeight - r.top + 6 + "px";
    menu.style.maxHeight = Math.max(160, Math.min(440, above - 6)) + "px";
  }
}

function items() {
  return menu ? [...menu.querySelectorAll(".fp-item:not([hidden])")] : [];
}

async function open(tile, category, staff) {
  closeFormPicker();
  const patientId = patientIdFromHash();
  if (!patientId) return;

  anchor = tile;
  tile.setAttribute("aria-expanded", "true");
  const label = categoryLabel(category);
  const isAdmin = /^admin$/i.test(String((staff && staff.role) || ""));

  const thisMenu = document.createElement("div");
  menu = thisMenu;
  menu.className = "fp-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", label);
  menu.innerHTML = `<div class="fp-head">${esc(label)}</div><div class="fp-body"><div class="fp-loading">Loading forms…</div></div>`;
  document.body.appendChild(menu);
  position();

  let forms;
  try {
    forms = (await listPublishedForms()).filter((t) => t.category === category);
  } catch (err) {
    console.error("Couldn't load published forms:", err);
    if (menu !== thisMenu) return;
    menu.querySelector(".fp-body").innerHTML =
      '<div class="fp-empty">Couldn\'t load the forms. Check your connection and try again.</div>';
    return;
  }
  if (menu !== thisMenu) return; // closed or replaced while loading

  const body = menu.querySelector(".fp-body");
  if (!forms.length) {
    body.innerHTML = `<div class="fp-empty">No ${esc(label.toLowerCase())} are published yet.${
      isAdmin ? ' <a href="#/forms">Open Form Builder</a>' : " Ask an admin to publish one in Form Builder."}</div>`;
    position();
    return;
  }

  body.innerHTML = `
    ${forms.length > 6 ? `<input type="search" class="fp-search" placeholder="Search ${esc(label.toLowerCase())}" aria-label="Search ${esc(label.toLowerCase())}" />` : ""}
    <div class="fp-list" role="menu">
      ${forms.map((t) => `
        <button type="button" class="fp-item" role="menuitem" data-fill="${esc(t.id)}" data-find="${esc(t.name.toLowerCase())}">
          <span>${esc(t.name)}</span><small>Version ${t.version}</small>
        </button>`).join("")}
      <div class="fp-empty" data-role="nomatch" hidden>No forms match that search.</div>
    </div>`;
  position();

  const search = body.querySelector(".fp-search");
  if (search) {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let any = false;
      body.querySelectorAll(".fp-item").forEach((b) => {
        b.hidden = !!q && !b.dataset.find.includes(q);
        if (!b.hidden) any = true;
      });
      body.querySelector('[data-role="nomatch"]').hidden = any;
    });
    search.focus();
  } else {
    const first = items()[0];
    if (first) first.focus();
  }

  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-fill]");
    if (!item) return;
    const id = item.dataset.fill;
    closeFormPicker();
    location.hash = `#/fill/${encodeURIComponent(patientId)}/${encodeURIComponent(id)}`;
  });

  menu.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = items();
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement);
    const next = e.key === "ArrowDown"
      ? list[i < 0 ? 0 : Math.min(i + 1, list.length - 1)]
      : i <= 0 ? (search || list[0]) : list[i - 1];
    next.focus();
  });
}

export function initFormPicker(contentEl, { getStaff }) {
  // Capture phase, so the tiles' old "coming soon" handler never runs
  contentEl.addEventListener("click", (e) => {
    const tile = e.target.closest(".doc-tile[data-soon]");
    if (!tile) return;
    const category = TILE_CATEGORY[tile.dataset.soon];
    if (!category) return;
    e.preventDefault();
    e.stopPropagation();
    if (menu && anchor === tile) { closeFormPicker(); return; }
    tile.setAttribute("aria-haspopup", "true");
    open(tile, category, getStaff());
  }, true);

  document.addEventListener("pointerdown", (e) => {
    if (menu && !menu.contains(e.target) && !(anchor && anchor.contains(e.target))) closeFormPicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu) closeFormPicker(true);
  });
  window.addEventListener("hashchange", () => closeFormPicker());
  window.addEventListener("resize", position);
  window.addEventListener("scroll", (e) => {
    if (menu && !menu.contains(e.target)) position();
  }, true);
}