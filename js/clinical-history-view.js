import { extractAny, toBullets } from "./transcripts.js";
import { escapeHtml } from "./utils.js";

const svg = (p, cls = "") =>
  `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  chev: svg('<polyline points="6 9 12 15 18 9"/>', "sum-chev"),
  chevRight: svg('<polyline points="9 18 15 12 9 6"/>', "rc-chev"),
  social: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  meds: svg('<path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>'),
  conditions: svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  allergies: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
};

// Heading aliases are tried in order (plural first)
const SECTIONS = {
  social: { title: "Social History", aliases: ["SOCIAL HISTORY"], tone: "teal", empty: "No social history recorded." },
  meds: { title: "Medication", aliases: ["CURRENT MEDICATIONS", "MEDICATIONS", "MEDICATION"], tone: "blue", empty: "No medications recorded." },
  conditions: { title: "Medical Conditions", aliases: ["MEDICAL CONDITIONS", "MEDICAL CONDITION"], tone: "amber", empty: "No medical conditions recorded." },
  allergies: { title: "Allergies", aliases: ["ALLERGIES", "ALLERGY"], tone: "red", empty: "No allergies recorded." },
};

const ROWS = [["social", "meds", "hx-row1"], ["conditions", "allergies", "hx-row2"]];

const NONE_RE = /^(nil\b|none\b|no known|nkda|nkfa|n\/a|not applicable|denies|no\s+(allerg|medic|condition|significant))/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (r) => (r.date ? `${MONTHS[r.date.getMonth()]} ${r.date.getDate()}, ${r.date.getFullYear()}` : (r.dateText || "Undated"));
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

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
        <span class="sk-badge hx-count">–</span>
      </summary>
      <div class="rc-body hx-body"><div class="skeleton sm"></div></div>
    </details>`;
}

/* ===================== Behaviour ===================== */

// Cards in the same row open/close together
export function mountClinicalHistory(root) {
  root.querySelectorAll(".hx-grid").forEach((grid) => {
    const cards = [...grid.querySelectorAll(".hx-card")];
    grid.addEventListener("toggle", (e) => {
      const card = e.target;
      if (!card.classList || !card.classList.contains("hx-card")) return;
      cards.forEach((c) => { if (c !== card && c.open !== card.open) c.open = card.open; });
    }, true);
  });
}

// Called with the transcript records the dashboard already fetched
export function renderClinicalHistory(root, records) {
  root.querySelectorAll(".hx-card").forEach((card) => {
    const key = card.dataset.hx;
    const s = SECTIONS[key];
    const list = records
      .map((r) => ({ ...r, text: extractAny(r.soap, s.aliases) }))
      .filter((r) => r.text);

    card.querySelector(".hx-count").textContent = list.length;
    card.querySelector(".hx-body").innerHTML = list.length
      ? bodyHtml(key, list)
      : `<p class="rc-empty pad">${escapeHtml(s.empty)}</p>`;
  });
}

export function renderClinicalHistoryError(root) {
  root.querySelectorAll(".hx-card").forEach((card) => {
    card.querySelector(".hx-count").textContent = "!";
    card.querySelector(".hx-body").innerHTML = `<p class="rc-empty pad">Couldn't load consultation records.</p>`;
  });
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

  // "Nil", "NKDA", "No known allergies"…
  if (bullets.length === 1 && NONE_RE.test(bullets[0])) {
    return `<span class="hx-none">${escapeHtml(bullets[0])}</span>`;
  }

  if (key === "allergies") {
    return `<div class="hx-chips">${bullets.map((b) =>
      `<span class="hx-chip${NONE_RE.test(b) ? " none" : ""}">${escapeHtml(b)}</span>`).join("")}</div>`;
  }

  return `<ul class="hx-list">${bullets.map((b) => `<li>${labelled(b)}</li>`).join("")}</ul>`;
}

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