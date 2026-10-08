import { extractAny, toBullets } from "./transcripts.js";
import { fetchClinicalProfile, saveClinicalSection } from "./clinical-profile.js";
import { escapeHtml, showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";

const svg = (p, cls = "") =>
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  chev: svg('<polyline points="6 9 12 15 18 9"/>', "sum-chev"),
  chevRight: svg('<polyline points="9 18 15 12 9 6"/>', "rc-chev"),
  social: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  meds: svg('<path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>'),
  conditions: svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  allergies: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  sparkle: svg('<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>'),
};

// Heading aliases are tried in order (plural first)
const SECTIONS = {
  social: { title: "Social History", aliases: ["SOCIAL HISTORY"], tone: "teal",
    empty: "No social history recorded.", item: "detail", placeholder: "e.g. Smoker: No" },
  meds: { title: "Medication", aliases: ["CURRENT MEDICATIONS", "MEDICATIONS", "MEDICATION"], tone: "blue",
    empty: "No medications recorded.", item: "medication", placeholder: "e.g. Roaccutane 20 mg daily" },
  conditions: { title: "Medical Conditions", aliases: ["MEDICAL CONDITIONS", "MEDICAL CONDITION"], tone: "amber",
    empty: "No medical conditions recorded.", item: "condition", placeholder: "e.g. Hypothyroidism" },
  allergies: { title: "Allergies", aliases: ["ALLERGIES", "ALLERGY"], tone: "red",
    empty: "No allergies recorded.", item: "allergy", placeholder: "e.g. Penicillin (rash)" },
};

const ROWS = [["social", "meds", "hx-row1"], ["conditions", "allergies", "hx-row2"]];

const NONE_RE = /^(nil\b|none\b|no known|nkda|nkfa|n\/a|not applicable|denies|no\s+(allerg|medic|condition|significant))/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (d) => (d && !isNaN(d) ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : "");
const fmt = (r) => (r.date ? fmtDate(r.date) : (r.dateText || "Undated"));
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
// For matching items: "- Smoker: No." == "smoker: no"
const normItem = (s) => norm(String(s || "").replace(/^\s*[-•*]\s*/, "")).replace(/[.;,\s]+$/, "");
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ===================== Per-page state ===================== */

const STATES = new WeakMap();
function stateFor(root) {
  let st = STATES.get(root);
  if (!st) {
    st = {
      patient: null, staff: null,
      profile: null,        // null = loading, {} = nothing edited yet
      profileError: null,
      records: null,        // consultation records (from the dashboard)
      editing: null,        // section key being edited
      draft: [],
      seed: null,           // { through, texts, recordId } when editing for the first time
      focusIndex: null,
      suggestions: {},
      busy: false,
    };
    STATES.set(root, st);
  }
  return st;
}

function isOpenSaved(key, fallback) {
  try {
    const s = JSON.parse(localStorage.getItem("pd-open-sections")) || {};
    return key in s ? !!s[key] : fallback;
  } catch { return fallback; }
}

/* ===================== Layout ===================== */

export function clinicalHistorySectionHtml() {
  return ROWS.map(([a, b, rowKey]) => {
    const open = isOpenSaved(rowKey, true) ? "open" : "";
    return `<div class="hx-grid">${cardHtml(a, rowKey, open)}${cardHtml(b, rowKey, open)}</div>`;
  }).join("");
}

function cardHtml(key, rowKey, open) {
  const s = SECTIONS[key];
  return `
    <details class="rc-card hx-card hx-${s.tone}" data-key="${rowKey}" data-hx="${key}" ${open}>
      <summary>
        <span class="rc-title">${ICONS.chev}<span class="hx-icon">${ICONS[key]}</span>${escapeHtml(s.title)}</span>
        <span class="hx-sum-right">
          <button type="button" class="hx-edit-btn" data-hx-act="edit" disabled>${ICONS.edit}<span>Edit</span></button>
          <span class="sk-badge hx-count">–</span>
        </span>
      </summary>
      <div class="rc-body hx-body"><div class="skeleton sm"></div></div>
    </details>`;
}

/* ===================== Behaviour ===================== */

export function mountClinicalHistory(root, patient, staff) {
  const st = stateFor(root);
  st.patient = patient;
  st.staff = staff;

  // Cards in the same row open/close together
  root.querySelectorAll(".hx-grid").forEach((grid) => {
    const cards = [...grid.querySelectorAll(".hx-card")];
    grid.addEventListener("toggle", (e) => {
      const card = e.target;
      if (!card.classList || !card.classList.contains("hx-card")) return;
      cards.forEach((c) => { if (c !== card && c.open !== card.open) c.open = card.open; });
    }, true);
  });

  root.addEventListener("click", (e) => onClick(root, e));
  root.addEventListener("input", (e) => {
    if (e.target.matches && e.target.matches(".hx-input")) st.draft[Number(e.target.dataset.i)] = e.target.value;
  });
  root.addEventListener("keydown", (e) => {
    if (!e.target.matches || !e.target.matches(".hx-input")) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const i = Number(e.target.dataset.i);
      st.draft.splice(i + 1, 0, "");
      st.focusIndex = i + 1;
      renderAll(root);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit(root);
    }
  });

  loadProfile(root);
}

async function loadProfile(root) {
  const st = stateFor(root);
  try {
    st.profile = await fetchClinicalProfile(st.patient);
    st.profileError = null;
  } catch (err) {
    console.warn("Clinical profile failed:", err);
    st.profile = {};
    st.profileError = err;
  }
  if (root.isConnected) renderAll(root);
}

// Called with the transcript records the dashboard already fetched
export function renderClinicalHistory(root, records) {
  const st = stateFor(root);
  st.records = records;
  renderAll(root);
}

export function renderClinicalHistoryError(root) {
  root.querySelectorAll(".hx-card").forEach((card) => {
    card.querySelector(".hx-count").textContent = "!";
    card.querySelector(".hx-body").innerHTML = `<p class="rc-empty pad">Couldn't load consultation records.</p>`;
  });
}

/* ===================== Rendering ===================== */

function entriesFor(st, key) {
  const s = SECTIONS[key];
  return (st.records || [])
    .map((r) => ({ ...r, text: extractAny(r.soap, s.aliases) }))
    .filter((r) => r.text);
}

function curatedFor(st, key) {
  const sec = st.profile && st.profile[key];
  return sec && Array.isArray(sec.items) ? sec : null;
}

function renderAll(root) {
  const st = stateFor(root);
  if (st.records === null) return; // wait for consultation records
  root.querySelectorAll(".hx-card").forEach((card) => renderCard(root, card));
  syncPreconsultSocial(root);
}

function renderCard(root, card) {
  const st = stateFor(root);
  const key = card.dataset.hx;
  const s = SECTIONS[key];
  const list = entriesFor(st, key);
  const section = curatedFor(st, key);
  const countEl = card.querySelector(".hx-count");
  const body = card.querySelector(".hx-body");
  const editBtn = card.querySelector('[data-hx-act="edit"]');

  if (editBtn) {
    editBtn.disabled = st.profile === null || !!st.profileError;
    editBtn.title = st.profileError ? "Editing isn't available (check the Firestore rules)" : "";
    editBtn.hidden = st.editing === key;
    const hasAny = (section && section.items.length) || list.length;
    editBtn.querySelector("span").textContent = hasAny ? "Edit" : "Add";
  }

  if (st.editing === key) {
    countEl.textContent = st.draft.filter((t) => t.trim()).length;
    body.innerHTML = editorHtml(st, key);
    const i = st.focusIndex !== null ? st.focusIndex : st.draft.length - 1;
    const input = body.querySelector(`.hx-input[data-i="${i}"]`);
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    st.focusIndex = null;
    return;
  }

  if (section) {
    const sugs = suggestionsFor(section, list);
    st.suggestions[key] = sugs;
    countEl.textContent = section.items.length;
    body.innerHTML = suggestionsHtml(sugs) + curatedHtml(key, section) + (list.length ? consultHistoryHtml(key, list) : "");
  } else {
    st.suggestions[key] = [];
    countEl.textContent = list.length;
    body.innerHTML = list.length ? bodyHtml(key, list) : `<p class="rc-empty pad">${escapeHtml(s.empty)}</p>`;
  }
}

// New items in consultations AFTER the list was last reconciled
function suggestionsFor(section, list) {
  const since = Number(section.syncedThrough || 0);
  const have = new Set(section.items.map((i) => normItem(i.text)));
  const dismissed = new Set((section.dismissed || []).map(normItem));
  const seen = new Set();
  const out = [];

  list.forEach((r) => {
    const t = r.date ? r.date.getTime() : 0;
    if (!t || t <= since) return;
    toBullets(r.text).forEach((b) => {
      const k = normItem(b);
      if (!k || NONE_RE.test(b) || have.has(k) || dismissed.has(k) || seen.has(k)) return;
      seen.add(k);
      out.push({ text: b.replace(/[.;,\s]+$/, ""), date: r.date, recordId: r.id });
    });
  });
  return out;
}

/* ===================== Actions ===================== */

async function onClick(root, e) {
  const btn = e.target.closest("[data-hx-act]");
  if (!btn) return;
  const card = btn.closest(".hx-card");
  if (!card || !root.contains(card)) return;
  if (btn.closest("summary")) e.preventDefault();

  const st = stateFor(root);
  const key = card.dataset.hx;
  const act = btn.dataset.hxAct;
  const i = Number(btn.dataset.i);

  if (act === "edit") return startEdit(root, key, card);
  if (act === "cancel") return cancelEdit(root);
  if (act === "save") return saveEdit(root, key, btn);
  if (act === "add-row") { st.draft.push(""); st.focusIndex = st.draft.length - 1; renderAll(root); return; }
  if (act === "del") {
    st.draft.splice(i, 1);
    if (!st.draft.length) st.draft.push("");
    st.focusIndex = Math.min(i, st.draft.length - 1);
    renderAll(root);
    return;
  }
  if (act === "sug-add") return applySuggestions(root, key, [st.suggestions[key][i]], "add");
  if (act === "sug-dismiss") return applySuggestions(root, key, [st.suggestions[key][i]], "dismiss");
  if (act === "sug-add-all") return applySuggestions(root, key, st.suggestions[key] || [], "add");
}

async function startEdit(root, key, card) {
  const st = stateFor(root);
  if (st.profile === null || st.profileError) return;

  if (st.editing && st.editing !== key && !(await confirmDialog({
    title: "Discard unsaved changes?",
    message: `You're editing ${SECTIONS[st.editing].title}. Your changes there haven't been saved.`,
    confirmLabel: "Discard changes",
    tone: "warning",
  }))) return;

  const section = curatedFor(st, key);
  const list = entriesFor(st, key);

  if (section) {
    st.draft = section.items.map((it) => it.text);
    st.seed = null;
  } else {
    // First edit: start from the latest consultation
    const latest = list[0];
    st.draft = latest ? toBullets(latest.text).map((b) => b.replace(/[.;,\s]+$/, "")) : [];
    st.seed = {
      through: latest && latest.date ? latest.date.getTime() : 0,
      texts: new Set(st.draft.map(normItem)),
      recordId: latest ? latest.id : "",
    };
  }
  if (!st.draft.length) st.draft = [""];

  st.editing = key;
  st.focusIndex = st.draft.length - 1;
  card.open = true;
  renderAll(root);
}

function cancelEdit(root) {
  const st = stateFor(root);
  st.editing = null;
  st.draft = [];
  st.seed = null;
  renderAll(root);
}

async function saveEdit(root, key, btn) {
  const st = stateFor(root);
  if (st.busy) return;

  // Clean up: trim, drop empty lines and duplicates
  const texts = [];
  const seen = new Set();
  st.draft.forEach((t) => {
    const v = String(t || "").trim();
    const k = normItem(v);
    if (v && !seen.has(k)) { seen.add(k); texts.push(v); }
  });

  const section = curatedFor(st, key);
  const prev = section ? section.items : [];
  const prevByKey = new Map(prev.map((it) => [normItem(it.text), it]));
  const now = new Date().toISOString();
  const by = (st.staff && st.staff.name) || "";

  const items = texts.map((t) => {
    const old = prevByKey.get(normItem(t));
    if (old) return { ...old, text: t };
    const fromSeed = st.seed && st.seed.texts.has(normItem(t));
    return {
      id: newId(), text: t,
      source: fromSeed ? "consultation" : "manual",
      recordId: fromSeed ? st.seed.recordId : "",
      addedAt: now, addedBy: by,
    };
  });

  const added = texts.filter((t) => !prevByKey.has(normItem(t)));
  const removed = prev.filter((it) => !seen.has(normItem(it.text))).map((it) => it.text);

  if (section && !added.length && !removed.length && prev.length === items.length &&
      prev.every((it, idx) => it.text === items[idx].text)) {
    cancelEdit(root); // nothing changed
    return;
  }

  const log = [
    ...((section && section.log) || []),
    ...(section ? [] : [{ at: now, by, action: "started list" }]),
    ...added.map((t) => ({ at: now, by, action: "added", text: t })),
    ...removed.map((t) => ({ at: now, by, action: "removed", text: t })),
  ].slice(-100);

  const next = {
    items,
    syncedThrough: section ? Number(section.syncedThrough || 0) : (st.seed ? st.seed.through : 0),
    dismissed: section ? (section.dismissed || []) : [],
    log,
  };

  st.busy = true;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await saveClinicalSection(st.patient, key, next, st.staff);
    st.profile = { ...(st.profile || {}), [key]: next };
    st.editing = null;
    st.draft = [];
    st.seed = null;
    renderAll(root);
    showToast(`${SECTIONS[key].title} updated`);
  } catch (err) {
    console.error("Saving clinical section failed:", err);
    showToast(err.code === "permission-denied"
      ? "You don't have permission to edit this. Check the Firestore rules."
      : "Couldn't save. Please try again.");
    btn.disabled = false;
    btn.textContent = "Save";
  } finally {
    st.busy = false;
  }
}

async function applySuggestions(root, key, sugs, mode) {
  const st = stateFor(root);
  const section = curatedFor(st, key);
  sugs = (sugs || []).filter(Boolean);
  if (!section || !sugs.length || st.busy) return;

  const now = new Date().toISOString();
  const by = (st.staff && st.staff.name) || "";
  const next = {
    ...section,
    items: [...section.items],
    dismissed: [...(section.dismissed || [])],
    log: [...(section.log || [])],
  };

  sugs.forEach((sg) => {
    if (mode === "add") {
      next.items.push({
        id: newId(), text: sg.text, source: "consultation", recordId: sg.recordId || "",
        addedAt: now, addedBy: by,
      });
      next.log.push({ at: now, by, action: "added from consultation", text: sg.text });
    } else {
      next.dismissed.push(normItem(sg.text));
      next.log.push({ at: now, by, action: "dismissed", text: sg.text });
    }
  });
  next.log = next.log.slice(-100);

  st.busy = true;
  try {
    await saveClinicalSection(st.patient, key, next, st.staff);
    st.profile = { ...st.profile, [key]: next };
    renderAll(root);
    showToast(mode === "add"
      ? (sugs.length === 1 ? "Added to the list" : `${sugs.length} items added`)
      : "Dismissed");
  } catch (err) {
    console.error("Updating suggestions failed:", err);
    showToast(err.code === "permission-denied" ? "You don't have permission to edit this." : "Couldn't save. Please try again.");
  } finally {
    st.busy = false;
  }
}

/* ===================== Pre-Consultation "Social history" card ===================== */

// Once Social History has been edited, the Pre-Consultation card shows the same Current list
function syncPreconsultSocial(root) {
  const st = stateFor(root);
  const section = curatedFor(st, "social");
  const card = root.querySelector('details[data-key="social-history"]');
  if (!section || !card) return;

  const n = section.items.length;
  const hint = card.querySelector(".hint");
  if (hint) { hint.hidden = false; hint.textContent = `${n} ${n === 1 ? "item" : "items"}`; }
  card.classList.toggle("is-empty", !n);

  const d = section.updatedAt ? new Date(section.updatedAt) : null;
  card.querySelector(".sub-body").innerHTML = `
    <p class="hx-meta"><span class="hx-tag edited">Current</span>
      <strong>Updated ${escapeHtml(fmtDate(d))}</strong>
      ${section.updatedBy ? `<span>· ${escapeHtml(section.updatedBy)}</span>` : ""}</p>
    ${n ? `<ul class="hx-list">${section.items.map((it) => `<li>${labelled(it.text)}</li>`).join("")}</ul>`
        : `<p class="empty-note">No social history recorded.</p>`}
    <p class="hx-foot-note">Edit in the Social History section below.</p>`;
}

/* ===================== Templates ===================== */

function metaHtml(r, extra = "") {
  return `
    <p class="hx-meta">
      ${extra}
      <strong>${escapeHtml(fmt(r))}</strong>
      ${r.staff ? `<span>· ${escapeHtml(r.staff)}</span>` : ""}
      ${r.matchedByName ? `<span class="task-flag neutral">Matched by name</span>` : ""}
    </p>`;
}

// "Smoker: No" -> <b>Smoker:</b> No
function labelled(text) {
  const m = /^([^:]{2,30}):\s*(.+)$/.exec(text);
  return m ? `<b>${escapeHtml(m[1])}:</b> ${escapeHtml(m[2])}` : escapeHtml(text);
}

function itemsHtml(key, text) {
  const bullets = toBullets(text);
  if (!bullets.length) return "";

  if (bullets.length === 1 && NONE_RE.test(bullets[0])) {
    return `<span class="hx-none">${escapeHtml(bullets[0])}</span>`;
  }

  if (key === "allergies") {
    return `<div class="hx-chips">${bullets.map((b) =>
      `<span class="hx-chip${NONE_RE.test(b) ? " none" : ""}">${escapeHtml(b)}</span>`).join("")}</div>`;
  }

  return `<ul class="hx-list">${bullets.map((b) => `<li>${labelled(b)}</li>`).join("")}</ul>`;
}

// Before anyone has edited: latest consultation + earlier ones
function bodyHtml(key, list) {
  const [latest, ...older] = list;

  const olderHtml = older.map((e, i) => {
    const newer = i === 0 ? latest : older[i - 1];
    const same = norm(e.text) === norm(newer.text);
    return `
      <div class="hx-entry">
        ${metaHtml(e, same ? `<span class="hx-same">No change</span>` : "")}
        ${same ? "" : itemsHtml(key, e.text)}
      </div>`;
  }).join("");

  return `
    <div class="hx-latest">
      ${metaHtml(latest, `<span class="hx-tag">Latest</span>`)}
      ${itemsHtml(key, latest.text)}
    </div>
    ${older.length ? `
      <details class="hx-older">
        <summary>${ICONS.chevRight}Earlier records (${older.length})</summary>
        <div class="hx-older-list">${olderHtml}</div>
      </details>` : ""}`;
}

// After editing: the team's Current list
function curatedHtml(key, section) {
  const d = section.updatedAt ? new Date(section.updatedAt) : null;
  const texts = section.items.map((it) => it.text);
  return `
    <div class="hx-latest">
      <p class="hx-meta">
        <span class="hx-tag edited">Current</span>
        <strong>Updated ${escapeHtml(fmtDate(d))}</strong>
        ${section.updatedBy ? `<span>· ${escapeHtml(section.updatedBy)}</span>` : ""}
      </p>
      ${texts.length ? itemsHtml(key, texts.join("\n")) : `<p class="rc-empty">${escapeHtml(SECTIONS[key].empty)}</p>`}
    </div>`;
}

function consultHistoryHtml(key, list) {
  return `
    <details class="hx-older">
      <summary>${ICONS.chevRight}From consultations (${list.length})</summary>
      <div class="hx-older-list">${list.map((e) => `
        <div class="hx-entry">${metaHtml(e)}${itemsHtml(key, e.text)}</div>`).join("")}
      </div>
    </details>`;
}

function suggestionsHtml(sugs) {
  if (!sugs.length) return "";
  return `
    <div class="hx-suggest">
      <p class="hx-suggest-head">${ICONS.sparkle}<span>New from consultations</span>
        ${sugs.length > 1 ? `<button type="button" class="hx-sug-all" data-hx-act="sug-add-all">Add all</button>` : ""}</p>
      <ul>${sugs.map((sg, i) => `
        <li>
          <span class="hx-sug-text">${labelled(sg.text)}<small>${escapeHtml(fmtDate(sg.date))}</small></span>
          <span class="hx-sug-btns">
            <button type="button" class="hx-sug-add" data-hx-act="sug-add" data-i="${i}">Add</button>
            <button type="button" class="hx-sug-no" data-hx-act="sug-dismiss" data-i="${i}">Dismiss</button>
          </span>
        </li>`).join("")}
      </ul>
    </div>`;
}

function editorHtml(st, key) {
  const s = SECTIONS[key];
  return `
    <div class="hx-editor">
      ${st.seed && st.seed.texts.size ? `<p class="hx-edit-hint">Started from the latest consultation. Check and update it.</p>` : ""}
      <ul class="hx-edit-list">${st.draft.map((t, i) => `
        <li>
          <input type="text" class="hx-input" data-i="${i}" value="${escapeHtml(t)}" maxlength="300"
                 placeholder="${escapeHtml(s.placeholder)}" aria-label="${escapeHtml(s.item)} ${i + 1}" />
          <button type="button" class="hx-x" data-hx-act="del" data-i="${i}" aria-label="Remove">${ICONS.x}</button>
        </li>`).join("")}
      </ul>
      <button type="button" class="hx-add" data-hx-act="add-row">+ Add ${escapeHtml(s.item)}</button>
      <p class="hx-edit-hint">Enter adds a new line · Esc cancels</p>
      <div class="hx-edit-btns">
        <button type="button" class="pn-btn" data-hx-act="cancel">Cancel</button>
        <button type="button" class="pn-btn primary" data-hx-act="save">Save</button>
      </div>
    </div>`;
}