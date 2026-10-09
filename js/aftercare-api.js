// The Aftercare Bank: aftercare instructions from Firestore 'Aftercare-instruction' (read-only).
import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { cleanRichHtml } from "./rich-html.js";

const COL = "Aftercare-instruction";
const FRESH_MS = 5 * 60 * 1000;
let cache = null;
let job = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CHEV = '<svg class="ac-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

// The aftercare editor (Quill) writes bullet lists as <ol><li data-list="bullet">.
// Turn those into real lists, drop its helper markup, then keep only safe HTML.
export function quillToHtml(raw) {
  const doc = new DOMParser().parseFromString(`<div>${String(raw || "")}</div>`, "text/html");
  const box = doc.body.firstElementChild;
  if (!box) return "";
  box.querySelectorAll("span.ql-ui").forEach((s) => s.remove());
  box.querySelectorAll("ol").forEach((ol) => {
    const items = [...ol.children].filter((c) => c.tagName === "LI");
    if (!items.some((li) => li.hasAttribute("data-list"))) return;
    // Consecutive items of the same kind become one list
    const frag = doc.createDocumentFragment();
    let list = null;
    let kind = "";
    items.forEach((li) => {
      const k = li.getAttribute("data-list") === "bullet" ? "UL" : "OL";
      if (k !== kind) { list = doc.createElement(k); frag.appendChild(list); kind = k; }
      list.appendChild(li);
    });
    ol.replaceWith(frag);
  });
  return cleanRichHtml(box.innerHTML);
}

function toAftercare(d) {
  const x = d.data() || {};
  return {
    id: d.id,
    title: String(x["Aftercare Title"] || "").trim(),
    treatment: String(x["Associated Treatment"] || "").trim(),
    html: quillToHtml(x["Instruction"]),
    updated: String(x["Updated As of"] || x["Created TimeStamp"] || ""),
  };
}

export async function listAftercare({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < FRESH_MS) return cache.list;
  if (!job) {
    job = getDocs(collection(db, COL))
      .then((snap) => {
        const list = snap.docs.map(toAftercare).filter((a) => a.title)
          .sort((a, b) => a.treatment.localeCompare(b.treatment, "en-AU") || a.title.localeCompare(b.title, "en-AU"));
        cache = { at: Date.now(), list };
        return list;
      })
      .finally(() => { job = null; });
  }
  return job;
}

// One collapsible aftercare panel. control = extra buttons beside the title (e.g. a tick box).
export function aftercarePanel(a, { control = "" } = {}) {
  return `
    <div class="ac-item" data-acid="${esc(a.id)}">
      <div class="ac-head">
        <button type="button" class="ac-toggle" aria-expanded="false">${CHEV}<span class="ac-title">${esc(a.title)}</span>${
          a.treatment ? `<small>${esc(a.treatment)}</small>` : ""}</button>
        ${control}
      </div>
      <div class="ac-body fe-rich" hidden>${a.html || '<p class="fe-help">No instructions written yet.</p>'}</div>
    </div>`;
}

// Opening and closing panels inside an element (safe to call more than once)
export function bindPanels(el) {
  if (!el || el.dataset.acBound) return;
  el.dataset.acBound = "1";
  el.addEventListener("click", (e) => {
    const t = e.target.closest(".ac-toggle");
    if (!t || !el.contains(t)) return;
    const item = t.closest(".ac-item");
    const body = item && item.querySelector(".ac-body");
    if (!body) return;
    const open = body.hidden;
    body.hidden = !open;
    t.setAttribute("aria-expanded", String(open));
    item.classList.toggle("is-open", open);
  });
}