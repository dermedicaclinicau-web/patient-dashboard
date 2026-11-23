// Settings → Start of Day: what staff see when they start their day.
// Presets work like End of Day's question sets: Everyone, plus presets given to roles or to particular people.
// A person gets the preset given to them by name, then their role's preset, otherwise Everyone's.
// Saved in sod_settings/layout: Everyone's layout at the top level, the presets in "sets".
// Injectors always count their kit first: that card is fixed at the top and can't be removed.

import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { escapeHtml, showToast } from "./utils.js";
import { can } from "./perms.js";
import { listProducts } from "./inventory-api.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";

const esc = (s) => escapeHtml(String(s ?? ""));
const svg = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  chart: svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  cal: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  task: svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  note: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/>'),
  mega: svg('<path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6"/><path d="M19 6a7 7 0 0 1 0 12"/>'),
  box: svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  msg: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  grip: svg('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>'),
  up: svg('<polyline points="18 15 12 9 6 15"/>'),
  down: svg('<polyline points="6 9 12 15 18 9"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
};

/* ---------- The cards ---------- */

export const SOD_CARD_TYPES = {
  clinic: { label: "Clinic today", desc: "How many appointments and clinicians are on today.", icon: I.chart,
    title: "Clinic today", cfg: {} },
  appts: { label: "My appointments", desc: "Their own appointments today, with times.", icon: I.cal,
    title: "My appointments today", cfg: { max: 6 } },
  tasks: { label: "My tasks", desc: "Tasks given to them on the task list.", icon: I.task,
    title: "My tasks", cfg: { show: "due", max: 5 } },
  notes: { label: "Notes to review", desc: "Their Draft consultation notes.", icon: I.note,
    title: "Notes to review", cfg: {} },
  announcements: { label: "Announcements", desc: "Clinic news you post (Stage 3).", icon: I.mega,
    title: "Announcements", cfg: { max: 3 } },
  inventory: { label: "Inventory highlights", desc: "Low stock, expiring, today's stock, requests.", icon: I.box,
    title: "Inventory highlights", cfg: { show: ["low"], days: 60, cats: [], loc: "any", max: 6, stockOnly: true } },
  links: { label: "Quick links", desc: "Buttons to the pages they use most.", icon: I.link, multi: true,
    title: "Quick links", cfg: { links: [{ label: "My dashboard", href: "#/home" }] } },
  message: { label: "Message", desc: "Your own words, like a reminder or welcome.", icon: I.msg, multi: true,
    title: "A note from the team", cfg: { text: "", tone: "info" } },
};
const INV_SHOW = [["low", "Low stock"], ["expiring", "Expiring soon"], ["today", "Stock for today's bookings"],
  ["requests", "Open order requests"]];
const TONES = [["info", "Plain"], ["highlight", "Highlighted"], ["warning", "Important"]];
const SIZES = [["compact", "Compact"], ["wide", "Wide"], ["full", "Full screen"]];
const ARRANGE = [["stack", "Stacked"], ["split", "Split screen"], ["grid", "Three columns"]];
const SPLIT = [["left", "Left wider"], ["even", "Even"], ["right", "Right wider"]];
const PAGES = [["#/home", "My dashboard"], ["#/patients", "Patient List"], ["#/calendar", "Calendar"],
  ["#/tasks", "Task Manager"], ["#/inventory", "Inventory"], ["#/refunds", "Refunds"], ["#/recall", "Recall"],
  ["#/prospects", "Prospects"], ["#/scanner", "Scanner"]];
const MAX_CARDS = 16;
const MAX_SETS = 12;
const EVERYONE = "all";

// What everyone sees until a layout is saved: the same as today's Start of Day
export const SOD_DEFAULT_LAYOUT = {
  size: "compact", arrange: "stack", split: "left",
  cards: [
    { id: "c_clinic", type: "clinic", title: "Clinic today", col: 1, full: false, cfg: {} },
    { id: "c_appts", type: "appts", title: "My appointments today", col: 1, full: false, cfg: { max: 6 } },
    { id: "c_tasks", type: "tasks", title: "My tasks", col: 1, full: false, cfg: { show: "due", max: 5 } },
    { id: "c_stock", type: "inventory", title: "Stock for today", col: 1, full: false,
      cfg: { show: ["today"], days: 60, cats: [], loc: "any", max: 4, stockOnly: true } },
    { id: "c_notes", type: "notes", title: "Notes to review", col: 1, full: false, cfg: {} },
  ],
};

/* ---------- Checking layouts (used when saving here, and when start-of-day.js reads them) ---------- */

const pick = (v, list, def) => (list.some((x) => x[0] === v) ? v : def);
const int = (v, lo, hi, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};
const text = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const cleanList = (a, max, len) => [...new Set((Array.isArray(a) ? a : []).map((x) => text(x, len)).filter(Boolean))].slice(0, max);
const colsOf = (arrange) => (arrange === "grid" ? 3 : arrange === "split" ? 2 : 1);
const newId = () => "c_" + Math.random().toString(36).slice(2, 10);
const newPid = () => "p_" + Math.random().toString(36).slice(2, 10);
const copy = (o) => JSON.parse(JSON.stringify(o));

function cleanCfg(type, c) {
  c = c && typeof c === "object" ? c : {};
  switch (type) {
    case "appts": return { max: int(c.max, 1, 20, 6) };
    case "tasks": return { show: c.show === "all" ? "all" : "due", max: int(c.max, 1, 20, 5) };
    case "announcements": return { max: int(c.max, 1, 10, 3) };
    case "inventory": {
      const show = (Array.isArray(c.show) ? c.show : []).filter((k) => INV_SHOW.some((x) => x[0] === k));
      return {
        show: show.length ? [...new Set(show)] : ["low"],
        days: int(c.days, 7, 365, 60),
        cats: cleanList(c.cats, 40, 60),
        loc: ["shelf", "jt"].includes(c.loc) ? c.loc : "any",
        max: int(c.max, 1, 20, 6),
        stockOnly: c.stockOnly !== false,
      };
    }
    case "links": return {
      links: (Array.isArray(c.links) ? c.links : []).slice(0, 8).map((l) => ({
        label: text(l && l.label, 30), href: String((l && l.href) || "").trim().slice(0, 200),
      })).filter((l) => l.label && (/^#\/[A-Za-z0-9/_?=&%.-]*$/.test(l.href) || /^https:\/\/\S+$/.test(l.href))),
    };
    case "message": return {
      text: String(c.text == null ? "" : c.text).replace(/\r/g, "").slice(0, 1500),
      tone: pick(c.tone, TONES, "info"),
    };
    default: return {};
  }
}

// One layout: { size, arrange, split, cards }
export function cleanSodLayout(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const arrange = pick(r.arrange, ARRANGE, "stack");
  const cols = colsOf(arrange);
  const once = new Set();
  const ids = new Set();
  const cards = (Array.isArray(r.cards) ? r.cards : []).map((c) => {
    if (!c || !SOD_CARD_TYPES[c.type]) return null;
    const t = SOD_CARD_TYPES[c.type];
    if (!t.multi) { if (once.has(c.type)) return null; once.add(c.type); }
    let id = /^c_[a-z0-9_]{3,20}$/.test(String(c.id || "")) ? String(c.id) : newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    return {
      id, type: c.type, title: text(c.title, 60) || t.title,
      col: cols === 1 ? 1 : int(c.col, 1, cols, 1),
      full: cols > 1 && c.full === true,
      cfg: cleanCfg(c.type, c.cfg),
    };
  }).filter(Boolean).slice(0, MAX_CARDS);
  return { size: pick(r.size, SIZES, "compact"), arrange, split: pick(r.split, SPLIT, "left"), cards };
}

// Everything: Everyone's layout, plus the presets. A role or person belongs to one preset only (the first keeps them).
export function cleanSodSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const base = cleanSodLayout(Array.isArray(r.cards) ? r : SOD_DEFAULT_LAYOUT);
  const takenRoles = new Set();
  const takenPeople = new Set();
  const ids = new Set();
  const sets = (Array.isArray(r.sets) ? r.sets : []).slice(0, MAX_SETS).map((x) => {
    x = x && typeof x === "object" ? x : {};
    let id = /^p_[a-z0-9]{4,20}$/.test(String(x.id || "")) ? String(x.id) : newPid();
    if (ids.has(id)) id = newPid();
    ids.add(id);
    return {
      id, name: text(x.name, 60),
      roles: cleanList(x.roles, 20, 40).filter((y) => !takenRoles.has(y.toLowerCase()) && takenRoles.add(y.toLowerCase())),
      staffIds: cleanList(x.staffIds, 80, 80).filter((y) => !takenPeople.has(y) && takenPeople.add(y)),
      ...cleanSodLayout(Array.isArray(x.cards) ? x : SOD_DEFAULT_LAYOUT),
    };
  });
  return { ...base, sets };
}

// Which layout a person gets: a preset given to them by name, then their role's, otherwise Everyone's
export function sodLayoutFor(cfg, { uid = "", role = "" } = {}) {
  const sets = (cfg && cfg.sets) || [];
  const r = String(role || "").toLowerCase();
  const set = sets.find((x) => uid && x.staffIds.includes(uid))
    || sets.find((x) => r && x.roles.some((y) => y.toLowerCase() === r)) || null;
  const lay = set || cfg;
  return {
    size: lay.size, arrange: lay.arrange, split: lay.split, cards: lay.cards,
    presetId: set ? set.id : EVERYONE, presetName: set ? set.name : "Everyone",
  };
}

export async function loadSodSettings() {
  const s = await getDoc(doc(db, "sod_settings", "layout"));
  return { ...cleanSodSettings(s.exists() ? s.data() : null), saved: s.exists() };
}

// The layout for this person's Start of Day (the standard one if nothing is saved or it can't be read)
export async function loadSodLayout(staff) {
  try {
    const cfg = await loadSodSettings();
    return { ...sodLayoutFor(cfg, { uid: staff && staff.uid, role: staff && (staff.role || staff.staffRole) }), saved: cfg.saved };
  } catch (err) {
    console.warn("Start of Day layout not read:", err);
    return { ...cleanSodLayout(SOD_DEFAULT_LAYOUT), presetId: EVERYONE, presetName: "Everyone", saved: false };
  }
}

// Cards in rows: full-width cards are a row of their own; the rest share the columns until the next one
export function sodBands(cards, cols) {
  const out = [];
  let cur = null;
  cards.forEach((c) => {
    if (cols > 1 && c.full) { out.push({ full: true, cards: [c] }); cur = null; return; }
    if (!cur) { cur = { full: false, cards: [] }; out.push(cur); }
    cur.cards.push(c);
  });
  return out;
}

export function sodColumnsCss(arrange, split) {
  if (arrange === "grid") return "repeat(3, minmax(0, 1fr))";
  if (arrange !== "split") return "minmax(0, 1fr)";
  return split === "even" ? "repeat(2, minmax(0, 1fr))"
    : split === "right" ? "minmax(0, 1fr) minmax(0, 1.5fr)" : "minmax(0, 1.5fr) minmax(0, 1fr)";
}

/* ---------- The builder ---------- */

export async function mountSodSettings(host, { staff = null } = {}) {
  if (!can("sod.manage")) {
    host.innerHTML = `<p class="sds-empty">You don't have access to set up Start of Day. Ask an admin to tick
      "Start of Day: set up the overlay and post announcements" for you in Staff → Roles and access.</p>`;
    return;
  }
  host.innerHTML = '<div class="skeleton" style="height:420px;border-radius:14px"></div>';

  const st = { cfg: null, tab: EVERYONE, version: 0, saved: false, savedBy: "", savedAt: null,
    dirty: false, open: "", cats: [], people: [], roles: [], saving: false };
  try {
    const [snap, products, people] = await Promise.all([
      getDoc(doc(db, "sod_settings", "layout")),
      listProducts().catch(() => []),
      callApi({ action: "staffList" }).then((r) => r.staff || []).catch((err) => { console.warn("Staff list not loaded:", err); return []; }),
    ]);
    st.cfg = cleanSodSettings(snap.exists() ? snap.data() : null);
    if (snap.exists()) {
      const d = snap.data();
      st.version = Number(d.version || 0);
      st.saved = true;
      st.savedBy = d.updatedBy || "";
      st.savedAt = d.updatedAt && d.updatedAt.toDate ? d.updatedAt.toDate() : null;
    }
    st.cats = [...new Set(products.filter((p) => p.active !== false).map((p) => String(p.category || "").trim())
      .filter(Boolean))].sort((a, b) => a.localeCompare(b));
    st.people = people.map((p) => ({ id: p.id, name: p.name, role: p.role || "" }));
    const roles = new Set(["Admin", ...st.people.map((p) => p.role).filter(Boolean)]);
    st.cfg.sets.forEach((x) => x.roles.forEach((r) => roles.add(r)));
    st.roles = [...roles].sort((a, b) => (a === "Admin" ? -1 : b === "Admin" ? 1 : a.localeCompare(b)));
  } catch (err) {
    console.error("Start of Day settings failed:", err);
    host.innerHTML = `<p class="sds-empty">Start of Day settings couldn't be loaded. Check your connection and the sod_settings Firestore rule.</p>`;
    return;
  }

  const sets = () => st.cfg.sets;
  const curSet = () => (st.tab === EVERYONE ? null : sets().find((x) => x.id === st.tab) || null);
  const L = () => curSet() || st.cfg;   // the layout being edited
  const cols = () => colsOf(L().arrange);
  const card = (id) => L().cards.find((c) => c.id === id);
  const changed = () => { st.dirty = true; status(); };
  const gets = (id) => st.people.filter((p) => sodLayoutFor(st.cfg, { uid: p.id, role: p.role }).presetId === id);
  const roleOwner = (r) => sets().find((x) => x.roles.some((y) => y.toLowerCase() === r.toLowerCase())) || null;
  const personOwner = (id) => sets().find((x) => x.staffIds.includes(id)) || null;
  const givenText = (x) => {
    const bits = [...x.roles];
    if (x.staffIds.length) bits.push(`${x.staffIds.length} ${x.staffIds.length === 1 ? "person" : "people"}`);
    return bits.join(" · ") || "Not given to anyone yet";
  };

  function status() {
    const el = host.querySelector(".sds-status");
    if (!el) return;
    el.className = "sds-status" + (st.dirty ? " is-dirty" : "");
    el.textContent = st.dirty ? "Unsaved changes"
      : st.saved ? `Saved${st.savedBy ? " by " + st.savedBy : ""}${st.savedAt
        ? " · " + st.savedAt.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""}`
      : "Standard layout (not saved yet)";
  }

  const seg = (name, list, val) => `<div class="sds-seg" role="group">${list.map(([k, l]) =>
    `<button type="button" data-seg="${name}" data-v="${k}" class="${k === val ? "is-on" : ""}" aria-pressed="${k === val}">${esc(l)}</button>`).join("")}</div>`;

  /* ----- Presets ----- */
  function tabsHtml() {
    const tab = (id, title, sub, n) => {
      const who = gets(id).length;
      return `<button type="button" role="tab" class="sds-tab${st.tab === id ? " is-on" : ""}" data-tab="${esc(id)}" aria-selected="${st.tab === id}">
        <b>${esc(title)}</b><small>${esc(sub)}</small>
        <span>${n} card${n === 1 ? "" : "s"} · ${who} ${who === 1 ? "person" : "people"}</span></button>`;
    };
    return tab(EVERYONE, "Everyone", "Anyone not in a preset", st.cfg.cards.length) +
      sets().map((x) => tab(x.id, x.name || "New preset", givenText(x), x.cards.length)).join("") +
      (sets().length < MAX_SETS ? `<button type="button" class="sds-tab is-add" data-act="add-set">
        <b>${I.plus} New preset</b><small>For a role or particular people</small></button>` : "");
  }

  function whoHtml(id) {
    const list = gets(id);
    return `<div class="sds-who"><b>${list.length} ${list.length === 1 ? "person gets" : "people get"} this</b>${list.length
      ? `<div class="sds-who-names">${list.map((p) => `<span title="${esc(p.role)}">${esc(p.name)}</span>`).join("")}</div>`
      : `<small class="sds-muted">${id === EVERYONE ? "Everyone is in a preset." : "Tick a role or a person above."}</small>`}</div>`;
  }

  function presetHtml() {
    const x = curSet();
    if (!x) {
      return `<div class="sds-setbox is-all"><p class="sds-hint">Everyone who isn't in a preset gets this layout.
        Someone given a preset by name gets it whatever their role.</p>${whoHtml(EVERYONE)}</div>`;
    }
    const chip = (attr, val, label, own, sub) => {
      const mine = !!own && own.id === x.id;
      const taken = !!own && !mine;
      return `<label class="sds-chip${taken ? " is-taken" : ""}${mine ? " is-on" : ""}">
        <input type="checkbox" ${attr}="${esc(val)}"${mine ? " checked" : ""}${taken ? " disabled" : ""}>
        <span>${esc(label)}</span>${taken ? `<em>in ${esc(own.name || "another preset")}</em>` : sub ? `<em>${esc(sub)}</em>` : ""}</label>`;
    };
    return `<div class="sds-setbox">
      <div class="sds-setgrid">
        <label class="sds-f"><span>Preset name</span>
          <input type="text" data-set="name" maxlength="60" placeholder="e.g. Booking team" value="${esc(x.name)}"></label>
        <div class="sds-f"><span>Given to these roles</span>
          <div class="sds-chips2">${st.roles.map((r) => chip("data-role-chip", r, r, roleOwner(r))).join("")
            || '<small class="sds-muted">No roles found.</small>'}</div></div>
      </div>
      <details class="sds-people"${x.staffIds.length ? " open" : ""}>
        <summary>And these people <small>${x.staffIds.length ? `${x.staffIds.length} chosen · ` : ""}they get this preset whatever their role</small></summary>
        <div class="sds-chips2">${st.people.map((p) => chip("data-person", p.id, p.name, personOwner(p.id), p.role)).join("")
          || '<small class="sds-muted">The staff list couldn\'t be loaded.</small>'}</div>
      </details>
      ${whoHtml(x.id)}
      <div class="sds-setacts">
        <button type="button" class="sds-btn is-quiet" data-act="copy-all">Copy Everyone's layout</button>
        <button type="button" class="sds-btn is-quiet" data-act="dup-set">Duplicate</button>
        <button type="button" class="sds-btn is-quiet is-dangertext" data-act="del-set">Delete this preset</button>
      </div>
    </div>`;
  }

  /* ----- What each card looks like ----- */
  function summary(c) {
    const f = c.cfg;
    switch (c.type) {
      case "appts": return `Up to ${f.max}`;
      case "tasks": return `${f.show === "all" ? "All open" : "Due and overdue"} · up to ${f.max}`;
      case "announcements": return `Up to ${f.max}`;
      case "inventory": return [f.show.map((k) => INV_SHOW.find((x) => x[0] === k)[1]).join(", "),
        f.cats.length ? f.cats.join(", ") : "", f.loc === "shelf" ? "Shelf" : f.loc === "jt" ? "JT storage" : "",
        f.stockOnly ? "stock staff only" : "everyone"].filter(Boolean).join(" · ");
      case "links": return `${f.links.length} link${f.links.length === 1 ? "" : "s"}`;
      case "message": return TONES.find((t) => t[0] === f.tone)[1];
      default: return SOD_CARD_TYPES[c.type].desc;
    }
  }
  function sample(c) {
    const row = (a, b, cls = "") => `<div class="sds-srow"><span>${a}</span><span class="${cls}">${b}</span></div>`;
    const f = c.cfg;
    switch (c.type) {
      case "clinic": return `<div class="sds-stats"><span><b>24</b>appointments</span><span><b>6</b>clinicians on</span></div>`;
      case "appts": return row("9:00 am · Jane Smith", "Anti-wrinkle") + row("10:30 am · Mark Lee", "Filler");
      case "tasks": return row("Call Elva about her package", "Overdue", "is-bad") + row("Order Radiesse", "Today", "is-warn");
      case "notes": return row("3 consultation notes", "to review");
      case "announcements": return `<div class="sds-ann"><b>New refund process</b><span>All refunds now go through the portal.</span></div>`;
      case "inventory": {
        const s = { low: row("Belotero Balance", "2 left", "is-bad"), expiring: row("Xeomin · batch 2611", "14 days", "is-warn"),
          today: row("Xeomin · 6 bookings", "1 opened vial"), requests: row("Order requests waiting", "2") };
        return f.show.map((k) => s[k]).join("");
      }
      case "links": return `<div class="sds-chips">${f.links.map((l) => `<span>${esc(l.label)}</span>`).join("") ||
        '<em>Add links in the settings</em>'}</div>`;
      case "message": return f.text
        ? `<div class="sds-msg tone-${f.tone}">${esc(f.text.slice(0, 220)).replace(/\n/g, "<br>")}${f.text.length > 220 ? "…" : ""}</div>`
        : '<em class="sds-muted">Write your message in the settings.</em>';
      default: return "";
    }
  }

  /* ----- A card's settings (the gear) ----- */
  function panel(c) {
    const f = c.cfg;
    const num = (k, lo, hi, label) =>
      `<label class="sds-f"><span>${label}</span><input type="number" min="${lo}" max="${hi}" step="1" data-k="${k}" value="${f[k]}"></label>`;
    let body = "";
    switch (c.type) {
      case "appts": body = num("max", 1, 20, "Show up to"); break;
      case "announcements": body = num("max", 1, 10, "Show up to"); break;
      case "tasks": body = `<label class="sds-f"><span>Show</span><select data-k="show">
          <option value="due"${f.show === "due" ? " selected" : ""}>Due today and overdue</option>
          <option value="all"${f.show === "all" ? " selected" : ""}>All their open tasks</option></select></label>
        ${num("max", 1, 20, "Show up to")}`; break;
      case "inventory": body = `
        <fieldset class="sds-fs"><legend>Show</legend>${INV_SHOW.map(([k, l]) =>
          `<label class="sds-chk"><input type="checkbox" data-show="${k}"${f.show.includes(k) ? " checked" : ""}> ${esc(l)}</label>`).join("")}</fieldset>
        ${f.show.includes("expiring") ? num("days", 7, 365, "Expiring within (days)") : ""}
        <fieldset class="sds-fs"><legend>Categories <small>(none ticked = all)</small></legend>${st.cats.length
          ? st.cats.map((k) => `<label class="sds-chk"><input type="checkbox" data-cat="${esc(k)}"${f.cats.includes(k) ? " checked" : ""}> ${esc(k)}</label>`).join("")
          : '<em class="sds-muted">No product categories found.</em>'}</fieldset>
        <label class="sds-f"><span>Where</span><select data-k="loc">
          <option value="any"${f.loc === "any" ? " selected" : ""}>Shelf and JT storage</option>
          <option value="shelf"${f.loc === "shelf" ? " selected" : ""}>Shelf only</option>
          <option value="jt"${f.loc === "jt" ? " selected" : ""}>JT storage only</option></select></label>
        ${num("max", 1, 20, "Show up to")}
        <label class="sds-chk"><input type="checkbox" data-k="stockOnly"${f.stockOnly ? " checked" : ""}>
          Only show to staff who can see stock (Inventory access)</label>`; break;
      case "links": body = `<div class="sds-links">${f.links.map((l, i) => `
          <div class="sds-link" data-li="${i}">
            <input type="text" maxlength="30" placeholder="Button label" data-lk="label" value="${esc(l.label)}">
            <input type="text" maxlength="200" placeholder="#/inventory" list="sds-pages" data-lk="href" value="${esc(l.href)}">
            <button type="button" class="sds-ib" data-lrm="${i}" aria-label="Remove link">${I.x}</button>
          </div>`).join("")}</div>
        ${f.links.length < 8 ? `<button type="button" class="sds-btn is-quiet" data-ladd>${I.plus} Add a link</button>` : ""}
        <p class="sds-hint">Pick a page from the list, or type a portal address starting with #/ (or a full https:// link).</p>`; break;
      case "message": body = `<label class="sds-f is-wide"><span>Message</span>
          <textarea rows="4" maxlength="1500" data-k="text" placeholder="Welcome to the week! Remember the team lunch at 12:30.">${esc(f.text)}</textarea></label>
        <label class="sds-f"><span>Look</span><select data-k="tone">${TONES.map(([k, l]) =>
          `<option value="${k}"${f.tone === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>`; break;
      default: body = `<p class="sds-hint">${esc(SOD_CARD_TYPES[c.type].desc)} Nothing else to set.</p>`;
    }
    const n = cols();
    const place = n > 1 ? `<label class="sds-f"><span>Column</span><select data-col${c.full ? " disabled" : ""}>${Array.from({ length: n }, (_, i) =>
        `<option value="${i + 1}"${c.col === i + 1 ? " selected" : ""}>Column ${i + 1}</option>`).join("")}</select></label>
      <label class="sds-chk sds-fullchk"><input type="checkbox" data-full${c.full ? " checked" : ""}> Full width (across all columns)</label>` : "";
    return `<div class="sds-panel">
        <label class="sds-f is-wide"><span>Card title</span><input type="text" maxlength="60" data-k="title" value="${esc(c.title)}"></label>
        ${place}
        ${body}
        <div class="sds-done"><button type="button" class="sds-btn" data-edit>Done</button></div>
      </div>`;
  }

  /* ----- One card in the builder ----- */
  function tile(c) {
    const t = SOD_CARD_TYPES[c.type];
    const open = st.open === c.id;
    return `<div class="sds-tile${open ? " is-open" : ""}${c.full ? " is-full" : ""}" data-id="${c.id}">
      <div class="sds-tile-top">
        <button type="button" class="sds-grip" data-grip aria-label="Drag to move">${I.grip}</button>
        <span class="sds-ico">${t.icon}</span>
        <div class="sds-tt"><strong data-title>${esc(c.title)}</strong><small>${c.full ? "Full width · " : ""}${esc(summary(c))}</small></div>
        <div class="sds-acts">
          <button type="button" class="sds-ib" data-up aria-label="Move up">${I.up}</button>
          <button type="button" class="sds-ib" data-down aria-label="Move down">${I.down}</button>
          <button type="button" class="sds-ib${open ? " is-on" : ""}" data-edit aria-label="Card settings" aria-expanded="${open}">${I.gear}</button>
          <button type="button" class="sds-ib is-danger" data-del aria-label="Remove card">${I.x}</button>
        </div>
      </div>
      ${open ? panel(c) : `<div class="sds-sample">${sample(c)}</div>`}
    </div>`;
  }

  /* ----- The whole page ----- */
  function render() {
    const lay = L();
    const n = cols();
    const bands = sodBands(lay.cards, n);
    const used = new Set(lay.cards.map((c) => c.type));
    const full = lay.cards.length >= MAX_CARDS;
    const y = window.scrollY;
    const x = curSet();

    host.innerHTML = `<div class="sds">
      <div class="sds-head">
        <div>
          <h2 class="sds-h">Start of Day</h2>
          <p class="sds-sub">What staff see when they start their day. Each card shows that person's own information.</p>
        </div>
        <div class="sds-top-acts">
          <span class="sds-status"></span>
          <button type="button" class="sds-btn is-quiet" data-act="preview">Preview</button>
          <button type="button" class="sds-btn is-primary" data-act="save">Save</button>
        </div>
      </div>

      <div class="sds-tabs" role="tablist" data-role="tabs">${tabsHtml()}</div>
      ${presetHtml()}

      <div class="sds-opts">
        <div class="sds-opt"><span>Size</span>${seg("size", SIZES, lay.size)}</div>
        <div class="sds-opt"><span>Arrangement</span>${seg("arrange", ARRANGE, lay.arrange)}</div>
        ${lay.arrange === "split" ? `<div class="sds-opt"><span>Columns</span>${seg("split", SPLIT, lay.split)}</div>` : ""}
        <button type="button" class="sds-btn is-quiet sds-reset" data-act="reset">Reset to the standard layout</button>
      </div>

      <div class="sds-main">
        <aside class="sds-pal">
          <h3>Add a card${x ? ` to ${esc(x.name || "this preset")}` : ""}</h3>
          ${Object.entries(SOD_CARD_TYPES).map(([k, t]) => {
            const added = !t.multi && used.has(k);
            return `<button type="button" class="sds-add${added ? " is-added" : ""}" data-add="${k}"${added || full ? " disabled" : ""}>
              <span class="sds-ico">${t.icon}</span>
              <span><strong>${esc(t.label)}</strong><small>${added ? "Added" : esc(t.desc)}</small></span>
            </button>`;
          }).join("")}
          ${full ? `<p class="sds-hint">That's the most cards a layout can have (${MAX_CARDS}).</p>` : ""}
        </aside>

        <section class="sds-stage">
          <div class="sds-frame size-${lay.size}">
            <div class="sds-hello">
              <span class="sds-av">AB</span>
              <div><small>Good morning · ${esc(new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" }))}</small>
              <strong>Welcome, [their name]</strong></div>
            </div>
            <div class="sds-kit"><span class="sds-ico">${I.lock}</span>
              <div><strong>Your kit</strong><small>Injectors only. Always first, and always counted before they can start.</small></div></div>
            ${bands.length ? bands.map((b) => b.full
              ? `<div class="sds-band is-full">${tile(b.cards[0])}</div>`
              : `<div class="sds-band" style="grid-template-columns:${sodColumnsCss(lay.arrange, lay.split)}">${Array.from({ length: n }, (_, i) => {
                  const mine = b.cards.filter((c) => (n === 1 ? true : c.col === i + 1));
                  return `<div class="sds-colbox${n > 1 ? " is-multi" : ""}" data-col="${i + 1}" data-ids="${b.cards.map((c) => c.id).join(",")}">${
                    n > 1 ? `<span class="sds-collabel">Column ${i + 1}</span>` : ""}${
                    mine.map(tile).join("") || '<div class="sds-drop-here">Drag a card here</div>'}</div>`;
                }).join("")}</div>`).join("")
              : `<div class="sds-band"><div class="sds-colbox" data-col="1" data-ids="">
                  <div class="sds-drop-here">Add cards from the list</div></div></div>`}
            <div class="sds-startbtn">Start my day</div>
          </div>
          <p class="sds-hint">Drag cards by their handle to move them, or use the arrows. On a phone, the cards are always stacked.</p>
        </section>
      </div>
      <datalist id="sds-pages">${PAGES.map(([h, l]) => `<option value="${h}">${esc(l)}</option>`).join("")}</datalist>
    </div>`;
    status();
    window.scrollTo(0, y);
  }

  const drawTabs = () => { const el = host.querySelector('[data-role="tabs"]'); if (el) el.innerHTML = tabsHtml(); };

  /* ----- Moving cards ----- */
  function step(id, dir) {
    const cs = L().cards;
    const i = cs.findIndex((c) => c.id === id);
    const me = cs[i];
    const n = cols();
    const same = (c) => n === 1 || me.full || c.full || c.col === me.col;
    let j = i + dir;
    while (j >= 0 && j < cs.length && !same(cs[j])) j += dir;
    if (j < 0 || j >= cs.length) return;
    const other = cs[j];
    cs.splice(i, 1);
    const k = cs.indexOf(other);
    cs.splice(dir < 0 ? k : k + 1, 0, me);
    changed();
    render();
  }

  function drop(id, target) {
    const cs = L().cards;
    const i = cs.findIndex((c) => c.id === id);
    if (i < 0) return;
    const me = cs[i];
    cs.splice(i, 1);
    if (target.kind === "tile") {
      const t = cs.find((c) => c.id === target.id);
      if (!t) { cs.splice(i, 0, me); return; }
      if (!t.full && !me.full) me.col = t.col;
      const j = cs.indexOf(t);
      cs.splice(target.before ? j : j + 1, 0, me);
    } else {
      me.full = false;
      me.col = cols() === 1 ? 1 : target.col;
      const others = target.ids.filter((x) => x !== id);
      if (!others.length) cs.splice(target.ids.length ? i : cs.length, 0, me);
      else cs.splice(cs.findIndex((c) => c.id === others[others.length - 1]) + 1, 0, me);
    }
    changed();
    render();
  }

  // Pointer dragging (works with touch on the iPad, unlike browser drag-and-drop)
  function startDrag(e, id) {
    const tileEl = host.querySelector(`.sds-tile[data-id="${id}"]`);
    if (!tileEl) return;
    e.preventDefault();
    const r = tileEl.getBoundingClientRect();
    const ghost = tileEl.cloneNode(true);
    ghost.classList.add("sds-ghost");
    ghost.style.width = r.width + "px";
    document.body.appendChild(ghost);
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    tileEl.classList.add("is-dragging");
    let target = null;
    const clear = () => host.querySelectorAll(".drop-before,.drop-after,.drop-in")
      .forEach((x) => x.classList.remove("drop-before", "drop-after", "drop-in"));
    const move = (ev) => {
      ghost.style.transform = `translate(${ev.clientX - dx}px, ${ev.clientY - dy}px)`;
      if (ev.clientY < 70) window.scrollBy(0, -14);
      else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
      clear();
      target = null;
      ghost.style.visibility = "hidden";
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      ghost.style.visibility = "";
      if (!el || !host.contains(el)) return;
      const t = el.closest(".sds-tile");
      if (t && t !== tileEl) {
        const tr = t.getBoundingClientRect();
        const before = ev.clientY < tr.top + tr.height / 2;
        t.classList.add(before ? "drop-before" : "drop-after");
        target = { kind: "tile", id: t.dataset.id, before };
        return;
      }
      const box = el.closest(".sds-colbox");
      if (box && !t) {
        box.classList.add("drop-in");
        target = { kind: "col", col: Number(box.dataset.col) || 1, ids: (box.dataset.ids || "").split(",").filter(Boolean) };
      }
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      ghost.remove();
      tileEl.classList.remove("is-dragging");
      clear();
      if (target) drop(id, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    move(e);
  }

  /* ----- Preview: the preset being edited, as staff will see it (unsaved changes included) ----- */
  function openPreview() {
    const lay = cleanSodLayout(L());
    const who = gets(st.tab);
    const first = who[0] ? String(who[0].name || "").replace(/^(dr|prof)\.?\s+/i, "").split(/\s+/)[0] : "";
    const d = document.createElement("dialog");
    d.className = "sds-pv";
    let phone = false;
    const h = new Date().getHours();
    const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    const day = new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
    const pvCard = (c) => `<article class="sds-pv-card">
        <header><span class="sds-ico">${SOD_CARD_TYPES[c.type].icon}</span><strong>${esc(c.title)}</strong></header>
        <div class="sds-sample">${sample(c)}</div>
      </article>`;

    const draw = () => {
      const n = phone ? 1 : colsOf(lay.arrange);
      const colCss = phone ? "minmax(0, 1fr)" : sodColumnsCss(lay.arrange, lay.split);
      const bands = sodBands(lay.cards, n).map((b) => b.full
        ? `<div class="sds-pv-band">${pvCard(b.cards[0])}</div>`
        : `<div class="sds-pv-band" style="grid-template-columns:${colCss}">${Array.from({ length: n }, (_, i) =>
            `<div class="sds-pv-col">${b.cards.filter((c) => n === 1 || c.col === i + 1).map(pvCard).join("")}</div>`).join("")}</div>`)
        .join("");
      d.innerHTML = `
        <div class="sds-pv-bar">
          <span><strong>Preview: ${esc(curSet() ? curSet().name || "New preset" : "Everyone")}</strong> · sample information, including unsaved changes</span>
          <div class="sds-seg" role="group">
            <button type="button" data-pv="set" class="${phone ? "" : "is-on"}">As set</button>
            <button type="button" data-pv="phone" class="${phone ? "is-on" : ""}">Phone</button>
          </div>
          <button type="button" class="sds-btn" data-pv="close">Close preview</button>
        </div>
        <div class="sds-pv-sheet size-${phone ? "phone" : lay.size}">
          <div class="sds-pv-hero">
            <span class="sds-av">${esc(first ? first.slice(0, 2).toUpperCase() : "AB")}</span>
            <div><small>Good ${part} · ${esc(day)}</small><h2>Welcome, ${esc(first || "[their name]")}</h2><p>Have a great day today!</p></div>
          </div>
          <article class="sds-pv-card is-kit">
            <header><span class="sds-ico">${I.box}</span><strong>Your kit</strong><em>Injectors only</em></header>
            <div class="sds-srow"><span>Xeomin · batch 2611</span><span class="sds-pv-input">units left</span></div>
          </article>
          ${bands || '<p class="sds-hint">No cards yet. Add some from the list.</p>'}
          <button type="button" class="sds-startbtn" data-pv="start">Start my day</button>
          <p class="sds-pv-note" hidden>This is a preview, so nothing happens. For staff, this saves their start and closes.</p>
        </div>`;
    };

    draw();
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pv]");
      if (!b) { if (e.target === d) d.close(); return; }
      const k = b.dataset.pv;
      if (k === "close") d.close();
      else if (k === "phone" || k === "set") { phone = k === "phone"; draw(); }
      else if (k === "start") d.querySelector(".sds-pv-note").hidden = false;
    });
    d.addEventListener("close", () => d.remove());
    document.body.appendChild(d);
    d.showModal();
  }

  /* ----- Saving ----- */
  async function save() {
    if (st.saving) return;
    for (const x of sets()) {
      if (!x.name.trim()) { st.tab = x.id; render(); showToast("Give this preset a name."); host.querySelector('[data-set="name"]')?.focus(); return; }
      if (!x.roles.length && !x.staffIds.length) {
        st.tab = x.id; render(); showToast(`"${x.name}" isn't given to anyone yet. Tick a role or a person.`); return;
      }
    }
    for (const lay of [st.cfg, ...sets()]) {
      const bad = lay.cards.find((c) => c.type === "message" && !String(c.cfg.text || "").trim());
      if (bad) {
        st.tab = lay === st.cfg ? EVERYONE : lay.id;
        st.open = bad.id;
        render();
        showToast(`Write the message for "${bad.title}", or remove that card.`);
        return;
      }
    }
    const clean = cleanSodSettings(st.cfg);
    st.saving = true;
    const btn = host.querySelector('[data-act="save"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      const u = getAuth().currentUser;
      const name = String((staff && staff.name) || "").slice(0, 120);
      await setDoc(doc(db, "sod_settings", "layout"), {
        size: clean.size, arrange: clean.arrange, split: clean.split, cards: clean.cards, sets: clean.sets,
        version: st.version + 1, updatedAt: serverTimestamp(), updatedBy: name, updatedByUid: u ? u.uid : "",
      });
      st.cfg = clean;
      if (st.tab !== EVERYONE && !sets().some((x) => x.id === st.tab)) st.tab = EVERYONE;
      st.version += 1;
      st.saved = true;
      st.savedBy = name;
      st.savedAt = new Date();
      st.dirty = false;
      render();
      showToast("Start of Day saved. Staff see it the next time their Start of Day opens.");
    } catch (err) {
      console.error("Start of Day not saved:", err);
      showToast(err && err.code === "permission-denied"
        ? "Couldn't save: check the sod_settings Firestore rule is published, and that you have the Start of Day tick."
        : "Couldn't save. Check your connection and try again.");
    } finally {
      st.saving = false;
      const b = host.querySelector('[data-act="save"]');
      if (b) { b.disabled = false; b.textContent = "Save"; }
    }
  }

  /* ----- Events ----- */
  host.addEventListener("pointerdown", (e) => {
    const g = e.target.closest("[data-grip]");
    if (g) startDrag(e, g.closest(".sds-tile").dataset.id);
  });

  host.addEventListener("click", async (e) => {
    const tb = e.target.closest("[data-tab]");
    if (tb) { st.tab = tb.dataset.tab; st.open = ""; render(); return; }
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    const tileEl = b.closest(".sds-tile");
    const c = tileEl ? card(tileEl.dataset.id) : null;

    if (b.dataset.seg) {
      L()[b.dataset.seg] = b.dataset.v;
      if (b.dataset.seg === "arrange") {
        const n = cols();
        L().cards.forEach((x) => { x.col = Math.min(x.col, n); if (n === 1) x.full = false; });
        // Two or three columns need room
        if (n === 2 && L().size === "compact") L().size = "wide";
        if (n === 3) L().size = "full";
        // Everything still in column 1: share the cards out so the columns show straight away
        if (n > 1 && L().cards.every((x) => x.col === 1 && !x.full)) L().cards.forEach((x, i) => { x.col = (i % n) + 1; });
      }
      changed(); render(); return;
    }
    if (b.dataset.add) {
      const t = SOD_CARD_TYPES[b.dataset.add];
      const nc = { id: newId(), type: b.dataset.add, title: t.title, col: 1, full: false, cfg: copy(t.cfg) };
      L().cards.push(nc);
      if (["message", "links", "inventory"].includes(b.dataset.add)) st.open = nc.id;
      changed(); render();
      const el = host.querySelector(`.sds-tile[data-id="${nc.id}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (c && "up" in b.dataset) { step(c.id, -1); return; }
    if (c && "down" in b.dataset) { step(c.id, 1); return; }
    if (c && "edit" in b.dataset) { st.open = st.open === c.id ? "" : c.id; render(); return; }
    if (c && "del" in b.dataset) {
      if (!(await confirmDialog({ title: `Remove "${c.title}"?`,
        message: "It comes off this layout when you save. You can add it again from the list.",
        confirmLabel: "Remove", tone: "warning" }))) return;
      L().cards = L().cards.filter((x) => x.id !== c.id);
      if (st.open === c.id) st.open = "";
      changed(); render(); return;
    }
    if (c && "ladd" in b.dataset) { c.cfg.links.push({ label: "", href: "" }); changed(); render(); return; }
    if (c && b.dataset.lrm != null) { c.cfg.links.splice(Number(b.dataset.lrm), 1); changed(); render(); return; }

    const act = b.dataset.act;
    const x = curSet();
    if (act === "save") save();
    else if (act === "preview") openPreview();
    else if (act === "add-set") {
      const nx = { id: newPid(), name: "", roles: [], staffIds: [], ...copy(cleanSodLayout(st.cfg)) };
      sets().push(nx);
      st.tab = nx.id;
      st.open = "";
      changed(); render();
      host.querySelector('[data-set="name"]')?.focus();
    }
    else if (act === "dup-set" && x) {
      const nx = { ...copy(x), id: newPid(), name: `${x.name || "Preset"} (copy)`.slice(0, 60), roles: [], staffIds: [] };
      nx.cards.forEach((k) => { k.id = newId(); });
      sets().splice(sets().indexOf(x) + 1, 0, nx);
      st.tab = nx.id;
      changed(); render();
      showToast("Copied. Give it a name and choose who gets it.");
    }
    else if (act === "del-set" && x) {
      if (!(await confirmDialog({ title: `Delete "${x.name || "this preset"}"?`,
        message: "Its staff will get their role's preset, or Everyone's, once you save.",
        confirmLabel: "Delete preset", tone: "warning" }))) return;
      st.cfg.sets = sets().filter((y) => y.id !== x.id);
      st.tab = EVERYONE;
      st.open = "";
      changed(); render();
    }
    else if (act === "copy-all" && x) {
      if (x.cards.length && !(await confirmDialog({ title: "Replace this preset's layout?",
        message: "Its cards, size and arrangement are replaced with a copy of Everyone's.",
        confirmLabel: "Replace", tone: "warning" }))) return;
      Object.assign(x, copy(cleanSodLayout(st.cfg)));
      x.cards.forEach((k) => { k.id = newId(); });
      st.open = "";
      changed(); render();
    }
    else if (act === "reset") {
      if (!(await confirmDialog({ title: "Reset to the standard layout?",
        message: `This replaces the cards and arrangement of ${x ? `"${x.name || "this preset"}"` : "Everyone's layout"}. Nothing changes for staff until you save.`,
        confirmLabel: "Reset", tone: "warning" }))) return;
      Object.assign(L(), copy(cleanSodLayout(SOD_DEFAULT_LAYOUT)));
      st.open = "";
      changed(); render();
    }
  });

  // Typing: kept without redrawing, so the cursor stays put
  host.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.set === "name" && curSet()) { curSet().name = el.value; changed(); drawTabs(); return; }
    const tileEl = el.closest(".sds-tile");
    const c = tileEl ? card(tileEl.dataset.id) : null;
    if (!c) return;
    if (el.dataset.k === "title") {
      c.title = el.value;
      const t = tileEl.querySelector("[data-title]");
      if (t) t.textContent = el.value || SOD_CARD_TYPES[c.type].title;
    } else if (el.dataset.k === "text") {
      c.cfg.text = el.value;
    } else if (el.dataset.lk) {
      const row = c.cfg.links[Number(el.closest("[data-li]").dataset.li)];
      if (row) row[el.dataset.lk] = el.value;
    } else return;
    changed();
  });

  // Choices: saved and redrawn
  host.addEventListener("change", (e) => {
    const el = e.target;
    const x = curSet();
    if (x && el.dataset.roleChip !== undefined) {
      const r = el.dataset.roleChip;
      x.roles = el.checked ? [...x.roles, r] : x.roles.filter((y) => y !== r);
      changed(); render(); return;
    }
    if (x && el.dataset.person !== undefined) {
      const id = el.dataset.person;
      x.staffIds = el.checked ? [...x.staffIds, id] : x.staffIds.filter((y) => y !== id);
      changed(); render(); return;
    }
    const tileEl = el.closest(".sds-tile");
    const c = tileEl ? card(tileEl.dataset.id) : null;
    if (!c) return;
    if ("col" in el.dataset) c.col = Number(el.value) || 1;
    else if ("full" in el.dataset) c.full = el.checked;
    else if (el.dataset.show) {
      const s = new Set(c.cfg.show);
      if (el.checked) s.add(el.dataset.show); else s.delete(el.dataset.show);
      c.cfg.show = INV_SHOW.map((k) => k[0]).filter((k) => s.has(k));
    } else if (el.dataset.cat != null) {
      const s = new Set(c.cfg.cats);
      if (el.checked) s.add(el.dataset.cat); else s.delete(el.dataset.cat);
      c.cfg.cats = [...s];
    } else if (el.dataset.k === "stockOnly") c.cfg.stockOnly = el.checked;
    else if (["max", "days"].includes(el.dataset.k)) c.cfg[el.dataset.k] = Number(el.value);
    else if (["show", "loc", "tone"].includes(el.dataset.k)) c.cfg[el.dataset.k] = el.value;
    else return;   // titles, messages and links are kept as they're typed
    c.cfg = cleanCfg(c.type, c.cfg);
    changed();
    render();
  });

  // Leaving with unsaved changes: ask first (as End of Day does)
  const guard = (e) => {
    if (!st.dirty || !host.isConnected) { window.removeEventListener("hashchange", guard, true); return; }
    if (location.hash.startsWith("#/settings/sod")) return;
    if (!confirm("You have unsaved Start of Day changes. Leave without saving?")) {
      history.replaceState(null, "", e.oldURL);
      e.stopImmediatePropagation();
    } else window.removeEventListener("hashchange", guard, true);
  };
  window.addEventListener("hashchange", guard, true);

  render();
}