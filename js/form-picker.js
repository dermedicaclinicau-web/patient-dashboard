// Dropdowns of published forms on the patient dashboard:
// - the Consent record / Treatment record / Prescription tiles
// - "+ Create Consent" / "+ Create Tx" on each treatment group (only that group's forms)
import { listPublishedForms, categoryLabel, formGroup, rxKindOf } from "./form-templates.js";
import { CATEGORIES } from "./records.js";
import { esc } from "./form-fields.js";
import { listTaskTypes } from "./task-types.js";
import { listTaskEmails } from "./mkt-task-run.js";
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

// Opens the form in a new tab, so the patient dashboard stays open behind it.
// The new tab shares the login. If the browser blocks the new tab, the form opens in this tab instead.
function openFill(pid, id) {
  const href = fillHref(pid, id);
  const w = window.open(`${location.pathname}${location.search}${href}`, "_blank");
  if (w) {
    try { w.focus(); } catch { /* ignore */ }
    return;
  }
  location.hash = href;
}

export function closeFormPicker(returnFocus = false) {
  if (menu) { menu.remove(); menu = null; }
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    if (returnFocus) anchor.focus();
    anchor = null;
  }
}

// Each menu sets its size and side when it opens
let layout = { width: 300, align: "left", maxH: 440 };

// The patient bar redraws itself (e.g. when tags or allergies load): follow the new Email button
function liveAnchor() {
  if (anchor && !anchor.isConnected && anchor.dataset.taskPicker) {
    const again = document.querySelector(`[data-task-picker="${CSS.escape(anchor.dataset.taskPicker)}"]`);
    if (again) {
      again.setAttribute("aria-expanded", "true");
      again.setAttribute("aria-haspopup", "true");
      anchor = again;
    }
  }
  return anchor && anchor.isConnected ? anchor : null;
}

function position() {
  if (!menu || !anchor) return;
  const a = liveAnchor();
  if (!a) { closeFormPicker(); return; }
  const r = a.getBoundingClientRect();
  const w = Math.min(Math.max(r.width, layout.width), window.innerWidth - 24);
  const want = layout.align === "right" ? r.right - w : r.left;   // "right": the menu's right edge lines up with the button
  const left = Math.max(12, Math.min(want, window.innerWidth - w - 12));
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  menu.style.width = w + "px";
  menu.style.left = left + "px";
  if (below >= 260 || below >= above) {
    menu.style.top = r.bottom + 8 + "px";
    menu.style.bottom = "auto";
    menu.style.maxHeight = Math.max(160, Math.min(layout.maxH, below - 8)) + "px";
  } else {
    menu.style.top = "auto";
    menu.style.bottom = window.innerHeight - r.top + 8 + "px";
    menu.style.maxHeight = Math.max(160, Math.min(layout.maxH, above - 8)) + "px";
  }
}

// Another script adds a search box to long lists. This menu has its own, so any other one is removed
// (whenever it appears), and the menu's own search keeps the focus.
function keepOwnSearch(el) {
  const tidy = () => {
    const extra = [...el.querySelectorAll("input")].filter((i) => !i.classList.contains("fp-search"));
    if (!extra.length) return;
    const refocus = extra.includes(document.activeElement);
    extra.forEach((i) => {
      const box = i.parentElement;
      i.remove();
      // Its wrapper too, if that's all the wrapper held
      if (box && box !== el && !box.matches(".fp-body, .fp-list, .fp-head") && !box.children.length && !box.textContent.trim()) box.remove();
    });
    const own = el.querySelector(".fp-search");
    if (refocus && own) own.focus();
  };
  new MutationObserver(tidy).observe(el, { childList: true, subtree: true });
}

function items() {
  return menu ? [...menu.querySelectorAll(".fp-item:not([hidden])")] : [];
}

async function open(trigger, category, staff, group, rxKind = "") {
  closeFormPicker();
  layout = { width: 300, align: "left", maxH: 440 };
  const patientId = patientIdFromHash();
  if (!patientId) return;

  anchor = trigger;
  trigger.setAttribute("aria-expanded", "true");
  const isAdmin = /^admin$/i.test(String((staff && staff.role) || ""));
  const groupInfo = group ? CATEGORIES.find((c) => c.key === group) || { key: "other", title: "Other" } : null;
  const kind = category === "consent" ? "consent forms"
    : category === "treatment" ? "treatment records" : categoryLabel(category).toLowerCase();
  const rxLabel = { product: "Product prescriptions", treatment: "Treatment prescriptions" };
  const label = rxKind && rxLabel[rxKind] ? rxLabel[rxKind] : groupInfo ? `${groupInfo.title}: ${kind}` : categoryLabel(category);

  const thisMenu = document.createElement("div");
  menu = thisMenu;
  menu.className = "fp-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", label);
  menu.dataset.noAutoSearch = "true";   // this menu has its own search
  keepOwnSearch(thisMenu);
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
      openFill(patientId, inGroup[0].id);
      return;
    }
    if (inGroup.length) forms = inGroup;
    else if (forms.length) note = `No ${groupInfo.title} ${kind} are published yet. Choose from all ${kind}:`;
  }

  // From a section's "+ Add": only that kind of prescription. Just one? Open it straight away.
  let grouped = category === "prescription";
  if (category === "prescription" && rxKind) {
    const mine = forms.filter((t) => rxKindOf(t) === rxKind);
    if (mine.length === 1) {
      closeFormPicker();
      openFill(patientId, mine[0].id);
      return;
    }
    if (mine.length) { forms = mine; grouped = false; }
    else if (forms.length) note = `No ${rxLabel[rxKind].toLowerCase()} are published yet. Choose from all prescriptions:`;
  }

  const body = menu.querySelector(".fp-body");
  if (!forms.length) {
    body.innerHTML = `<div class="fp-empty">No ${esc(kind)} are published yet.${
      isAdmin ? ' <a href="#/forms">Open Form Builder</a>' : " Ask an admin to publish one in Form Builder."}</div>`;
    position();
    return;
  }

  const itemHtml = (t) => `
        <button type="button" class="fp-item" role="menuitem" data-fill="${esc(t.id)}" data-find="${esc(t.name.toLowerCase())}">
          <span>${esc(t.name)}</span><small>Version ${t.version}</small>
        </button>`;
  // The Prescription tile: treatment and product prescriptions under their own headings
  const sections = grouped
    ? [["treatment", "Treatment prescriptions"], ["product", "Product prescriptions"]]
        .map(([k, title]) => [title, forms.filter((t) => rxKindOf(t) === k)]).filter(([, list]) => list.length)
    : [["", forms]];
  body.innerHTML = `
    ${note ? `<div class="fp-note">${esc(note)}</div>` : ""}
    ${forms.length > 6 ? `<input type="search" class="fp-search" placeholder="Search ${esc(kind)}" aria-label="Search ${esc(kind)}" />` : ""}
    <div class="fp-list" role="menu">
      ${sections.map(([title, list]) => `<div class="fp-group">${title ? `<div class="fp-group-h">${esc(title)}</div>` : ""}${
        list.map(itemHtml).join("")}</div>`).join("")}
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
      body.querySelectorAll(".fp-group").forEach((g) => { g.hidden = !g.querySelector(".fp-item:not([hidden])"); });
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
    openFill(patientId, id);
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

const emSvg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const EM_IC = {
  mail: emSvg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  mkt: emSvg('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
  pen: emSvg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  chev: emSvg('<polyline points="9 18 15 12 9 6"/>'),
  search: emSvg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
};

// The patient page's Email button: published "To Patient" email tasks and the marketing emails
// switched on for Task Manager, in two groups, plus "Write my own email" pinned at the bottom
async function openTasks(trigger, staff) {
  closeFormPicker();
  const patientId = patientIdFromHash();
  if (!patientId) return;
  anchor = trigger;
  layout = { width: 440, align: "right", maxH: 560 };
  trigger.setAttribute("aria-expanded", "true");
  const isAdmin = /^admin$/i.test(String((staff && staff.role) || ""));
  const email = trigger.dataset.email || "";
  const who = trigger.dataset.name || "the patient";

  const thisMenu = document.createElement("div");
  menu = thisMenu;
  menu.className = "fp-menu em-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", `Email ${who}`);
  menu.dataset.noAutoSearch = "true";   // it has its own search
  keepOwnSearch(thisMenu);
  menu.innerHTML = `
    <div class="em-head">
      <span class="em-head-ic">${EM_IC.mail}</span>
      <div class="em-head-t">
        <strong>Email ${esc(who)}</strong>
        <small${email ? ` title="${esc(email)}"` : ' class="is-none"'}>${
          email ? esc(email) : "No email on file. You can type one in on the next screen."}</small>
      </div>
    </div>
    <div class="em-scroll"><div class="fp-loading">Loading emails…</div></div>`;
  document.body.appendChild(menu);
  position();

  let tasks = [];
  const [types, emails] = await Promise.allSettled([listTaskTypes({ isAdmin: false }), listTaskEmails()]);
  if (types.status === "fulfilled") tasks = types.value.filter((t) => t.category === "patient" && t.channel === "email");
  else console.error("Couldn't load tasks:", types.reason);
  if (emails.status === "fulfilled") tasks = tasks.concat(emails.value);   // ids start with "mkt_"
  if (menu !== thisMenu) return;   // closed while loading

  const byName = (a, b) => String(a.name).localeCompare(String(b.name), "en-AU");
  const groups = [
    ["Patient emails", tasks.filter((t) => !t.mkt).sort(byName)],
    ["Marketing emails", tasks.filter((t) => t.mkt).sort(byName)],
  ].filter(([, list]) => list.length);

  const row = (t) => `
    <button type="button" class="em-item${t.mkt ? " is-mkt" : ""}" role="menuitem" data-runtask="${esc(t.id)}"
      data-find="${esc(`${t.name} ${t.description || ""}`.toLowerCase())}">
      <span class="em-ic">${t.mkt ? EM_IC.mkt : EM_IC.mail}</span>
      <span class="em-t"><b>${esc(t.name)}</b>${t.description ? `<small>${esc(t.description)}</small>` : ""}</span>
      <span class="em-go">${EM_IC.chev}</span>
    </button>`;

  thisMenu.querySelector(".em-scroll").innerHTML = `
    ${tasks.length > 6 ? `<div class="em-search">${EM_IC.search}
      <input type="search" class="fp-search" placeholder="Search emails" aria-label="Search emails" autocomplete="off" spellcheck="false" /></div>` : ""}
    <div role="menu">
      ${groups.map(([title, list]) => `<div class="em-group">
        <div class="em-group-h">${esc(title)}<span>${list.length}</span></div>${list.map(row).join("")}</div>`).join("")}
    </div>
    ${tasks.length
      ? '<p class="em-none" hidden>No emails match that search.</p>'
      : `<p class="em-empty">No patient emails are published yet.${isAdmin ? ' <a href="#/tasks/types">Set them up in Task types</a>' : ""}</p>`}`;
  if (email) {
    thisMenu.insertAdjacentHTML("beforeend", `
      <a class="em-own" role="menuitem" href="mailto:${esc(email)}">
        <span class="em-ic">${EM_IC.pen}</span>
        <span class="em-t"><b>Write my own email</b><small>Opens your email app</small></span>
      </a>`);
  }
  position();

  const search = thisMenu.querySelector(".fp-search");
  const navItems = () => [...thisMenu.querySelectorAll(".em-item:not([hidden]), .em-own")];
  if (search) {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      let any = false;
      thisMenu.querySelectorAll(".em-item").forEach((b) => {
        b.hidden = !words.every((w) => b.dataset.find.includes(w));
        if (!b.hidden) any = true;
      });
      thisMenu.querySelectorAll(".em-group").forEach((g) => { g.hidden = !g.querySelector(".em-item:not([hidden])"); });
      thisMenu.querySelector(".em-none").hidden = any;
    });
  }

  thisMenu.addEventListener("click", (e) => {
    if (e.target.closest(".em-own")) { setTimeout(() => closeFormPicker(), 0); return; }   // the email app opens
    const item = e.target.closest("[data-runtask]");
    if (!item) return;
    const id = item.dataset.runtask;
    closeFormPicker();
    location.hash = `#/tasks/run/${encodeURIComponent(id)}/${encodeURIComponent(patientId)}`;
  });

  thisMenu.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === search) {
      e.preventDefault();
      const first = navItems()[0];
      if (first) first.click();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = navItems();
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement);
    const next = e.key === "ArrowDown"
      ? list[i < 0 ? 0 : Math.min(i + 1, list.length - 1)]
      : i <= 0 ? (search || list[0]) : list[i - 1];
    next.focus();
  });

  // The cursor goes in the search box on a computer, not on the iPad (the keyboard would pop up)
  const fine = window.matchMedia && matchMedia("(pointer: fine)").matches;
  if (search && fine) search.focus();
  else { const first = navItems()[0]; if (first) first.focus({ preventScroll: true }); }
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
    open(trigger, category, getStaff(), create ? create.dataset.group || "" : "", create ? create.dataset.rxkind || "" : "");
    }, true);

  document.addEventListener("pointerdown", (e) => {
    const a = menu ? liveAnchor() : null;
    if (menu && !menu.contains(e.target) && !(a && a.contains(e.target))) closeFormPicker();
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