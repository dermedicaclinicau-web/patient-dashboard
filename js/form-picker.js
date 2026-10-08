// Dropdowns of published forms on the patient dashboard:
// - the Consent record / Treatment record / Prescription tiles
// - "+ Create Consent" / "+ Create Tx" on each treatment group (only that group's forms)
import { listPublishedForms, categoryLabel, formGroup } from "./form-templates.js";
import { CATEGORIES } from "./records.js";
import { esc } from "./form-fields.js";
import { listTaskTypes } from "./task-types.js";

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

const fillHref = (pid, id) => `#/fill/${encodeURIComponent(pid)}/${encodeURIComponent(id)}`;

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

async function open(trigger, category, staff, group) {
  closeFormPicker();
  const patientId = patientIdFromHash();
  if (!patientId) return;

  anchor = trigger;
  trigger.setAttribute("aria-expanded", "true");
  const isAdmin = /^admin$/i.test(String((staff && staff.role) || ""));
  const groupInfo = group ? CATEGORIES.find((c) => c.key === group) || { key: "other", title: "Other" } : null;
  const kind = category === "consent" ? "consent forms"
    : category === "treatment" ? "treatment records" : categoryLabel(category).toLowerCase();
  const label = groupInfo ? `${groupInfo.title}: ${kind}` : categoryLabel(category);

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

  // From a treatment group: only that group's forms. Just one? Open it straight away.
  let note = "";
  if (groupInfo) {
    const inGroup = forms.filter((t) => formGroup(t) === groupInfo.key);
    if (inGroup.length === 1) {
      closeFormPicker();
      location.hash = fillHref(patientId, inGroup[0].id);
      return;
    }
    if (inGroup.length) forms = inGroup;
    else if (forms.length) note = `No ${groupInfo.title} ${kind} are published yet. Choose from all ${kind}:`;
  }

  const body = menu.querySelector(".fp-body");
  if (!forms.length) {
    body.innerHTML = `<div class="fp-empty">No ${esc(kind)} are published yet.${
      isAdmin ? ' <a href="#/forms">Open Form Builder</a>' : " Ask an admin to publish one in Form Builder."}</div>`;
    position();
    return;
  }

  body.innerHTML = `
    ${note ? `<div class="fp-note">${esc(note)}</div>` : ""}
    ${forms.length > 6 ? `<input type="search" class="fp-search" placeholder="Search ${esc(kind)}" aria-label="Search ${esc(kind)}" />` : ""}
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
    location.hash = fillHref(patientId, id);
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

// The patient page's Email button: published "To Patient" tasks, plus "Write my own email"
async function openTasks(trigger, staff) {
  closeFormPicker();
  const patientId = patientIdFromHash();
  if (!patientId) return;
  anchor = trigger;
  trigger.setAttribute("aria-expanded", "true");
  const isAdmin = /^admin$/i.test(String((staff && staff.role) || ""));
  const email = trigger.dataset.email || "";

  const thisMenu = document.createElement("div");
  menu = thisMenu;
  menu.className = "fp-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Email the patient");
  menu.innerHTML = '<div class="fp-head">Email the patient</div><div class="fp-body"><div class="fp-loading">Loading tasks…</div></div>';
  document.body.appendChild(menu);
  position();

  let tasks = [];
  try {
    tasks = (await listTaskTypes({ isAdmin: false })).filter((t) => t.category === "patient" && t.channel === "email");
  } catch (err) {
    console.error("Couldn't load tasks:", err);
  }
  if (menu !== thisMenu) return;

  menu.querySelector(".fp-body").innerHTML = `
    <div class="fp-list" role="menu">
      ${tasks.map((t) => `
        <button type="button" class="fp-item" role="menuitem" data-runtask="${esc(t.id)}">
          <span>${esc(t.name)}</span>${t.description ? `<small>${esc(t.description)}</small>` : ""}
        </button>`).join("")}
      ${tasks.length ? "" : `<div class="fp-empty">No patient email tasks are published yet.${
        isAdmin ? ' <a href="#/tasks/types">Set them up in Task types</a>' : ""}</div>`}
      ${email ? `<a class="fp-item fp-plain" role="menuitem" href="mailto:${esc(email)}">
        <span>Write my own email</span><small>Opens your email app</small></a>` : ""}
    </div>`;
  position();

  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-runtask]");
    if (!item) return;
    const id = item.dataset.runtask;
    closeFormPicker();
    location.hash = `#/tasks/run/${encodeURIComponent(id)}/${encodeURIComponent(patientId)}`;
  });
  const first = menu.querySelector(".fp-item");
  if (first) first.focus();
}

export function initFormPicker(contentEl, { getStaff }) {
  // Capture phase, so the old "coming soon" handlers never run
  contentEl.addEventListener("click", (e) => {
    const taskBtn = e.target.closest("[data-task-picker]");
    if (taskBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (menu && anchor === taskBtn) { closeFormPicker(); return; }
      taskBtn.setAttribute("aria-haspopup", "true");
      openTasks(taskBtn, getStaff());
      return;
    }
    const create = e.target.closest("[data-create]");
    const tile = create ? null : e.target.closest(".doc-tile[data-soon]");
    const trigger = create || tile;
    if (!trigger) return;
    const category = create ? create.dataset.create : TILE_CATEGORY[tile.dataset.soon];
    if (!category) return;
    e.preventDefault();  // also stops the group from opening/closing
    e.stopPropagation();
    if (menu && anchor === trigger) { closeFormPicker(); return; }
    trigger.setAttribute("aria-haspopup", "true");
    open(trigger, category, getStaff(), create ? create.dataset.group || "" : "");
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