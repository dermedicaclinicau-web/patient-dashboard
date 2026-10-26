// My dashboard → Arrange: drag a card by its ⠿ handle to move it (across to the other column too),
// and give each card a colour with its ● dot. Pointer events, so it works with a finger on an iPad as well as a mouse.
// Keyboard: focus a handle, then ↑ ↓ to move it, ← → to change column.
import { DASH_COLORS, getDashPrefs } from "./dash-prefs.js";

const GRIP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LIFT = 160;   // a card being dragged shows at most this much, so tall cards are easy to place
const EDGE = 80;    // near the top or bottom of the screen, the page scrolls

export function enableDashArrange(root, { uid, onMove, onColor }) {
  const hint = document.createElement("div");
  hint.className = "md-arr-hint";
  hint.hidden = true;
  hint.innerHTML = "Drag a card by its <strong>⠿</strong> handle to move it, including across to the other column. "
    + "Tap its <strong>●</strong> to change the colour. Press <strong>Done</strong> when you've finished.";
  const head = root.querySelector(".fb-head");
  if (head) head.after(hint);

  const arranging = () => root.classList.contains("is-arranging");
  function setMode(on) {
    root.classList.toggle("is-arranging", on);
    hint.hidden = !on;
    const b = root.querySelector('[data-act="arrange"]');
    if (b) {
      b.textContent = on ? "Done" : "Arrange";
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    if (!on) closePicker();
  }

  /* ---------- The handle and colour dot on each card ---------- */
  function decorate(scope = root) {
    const colors = getDashPrefs(uid()).colors;
    scope.querySelectorAll(".md-col > [data-card]").forEach((el) => {
      const k = el.dataset.card;
      if (colors[k]) el.dataset.mdc = colors[k]; else delete el.dataset.mdc;
      if (el.querySelector(".md-arr")) return;
      const title = (el.querySelector("h3, strong") || {}).textContent || "card";
      const box = document.createElement("span");
      box.className = "md-arr";
      box.innerHTML = `<button type="button" class="md-grip" aria-label="Move ${esc(title)}" title="Drag to move">${GRIP}</button>
        <button type="button" class="md-cdot" data-mdcolor="${esc(k)}" aria-label="Colour for ${esc(title)}" title="Colour"></button>`;
      const h = el.querySelector(".md-card-head");
      if (h) h.prepend(box); else el.prepend(box);
    });
  }

  // Tells the dashboard where everything is now
  function report(grid) {
    const list = (sel) => [...grid.querySelectorAll(`:scope > ${sel} > [data-card]`)].map((c) => c.dataset.card);
    const main = list(".md-main");
    const side = list(".md-side");
    grid.classList.toggle("is-single", !side.length && !grid.querySelector(":scope > .md-side > .md-qa-card"));
    onMove({ main, side });
  }

  /* ---------- Clicks (capture, so a handle inside a link card never opens the link) ---------- */
  root.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="arrange"]')) { setMode(!arranging()); return; }
    const dot = e.target.closest("[data-mdcolor]");
    if (dot) { e.preventDefault(); e.stopPropagation(); openPicker(dot); return; }
    if (e.target.closest(".md-grip")) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  /* ---------- Dragging ---------- */
  let drag = null;

  root.addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".md-grip");
    if (!g || !arranging() || e.button > 0 || drag) return;
    const card = g.closest("[data-card]");
    const grid = card && card.closest(".md-layout");
    if (!grid) return;
    e.preventDefault();
    closePicker();
    const r = card.getBoundingClientRect();
    const ph = document.createElement("div");
    ph.className = "md-drop";
    ph.style.height = `${Math.min(r.height, LIFT)}px`;
    card.parentNode.insertBefore(ph, card);
    Object.assign(card.style, {
      position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`,
      maxHeight: `${LIFT}px`, zIndex: "1000", pointerEvents: "none",
    });
    card.classList.add("is-dragging");
    grid.classList.add("is-dragging");
    document.body.classList.add("md-noselect");
    drag = {
      card, ph, grid, id: e.pointerId, x: e.clientX, y: e.clientY,
      dx: e.clientX - r.left, dy: Math.min(e.clientY - r.top, LIFT - 20), raf: 0,
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    tick();
  });

  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    place();
  }

  // The space opens up where the card would land
  function place() {
    const { card, ph, grid, x, y } = drag;
    card.style.left = `${x - drag.dx}px`;
    card.style.top = `${y - drag.dy}px`;
    const cols = [...grid.querySelectorAll(":scope > .md-col")];
    if (!cols.length) return;
    const dist = (c) => {
      const b = c.getBoundingClientRect();
      const ox = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
      const oy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
      return ox * ox + oy * oy;
    };
    const col = cols.reduce((a, c) => (dist(c) < dist(a) ? c : a));
    const items = [...col.querySelectorAll(":scope > [data-card]")].filter((c) => c !== card);
    const before = items.find((c) => { const b = c.getBoundingClientRect(); return y < b.top + b.height / 2; });
    if (before) {
      if (ph.nextElementSibling !== before) col.insertBefore(ph, before);
    } else if (ph.parentNode !== col || ph.nextElementSibling) {
      col.appendChild(ph);
    }
  }

  function tick() {
    if (!drag) return;
    let s = 0;
    if (drag.y < EDGE) s = -Math.ceil((EDGE - drag.y) / 4);
    else if (drag.y > window.innerHeight - EDGE) s = Math.ceil((drag.y - (window.innerHeight - EDGE)) / 4);
    if (s) { window.scrollBy(0, s); place(); }
    drag.raf = requestAnimationFrame(tick);
  }

  function end(e) {
    if (!drag || e.pointerId !== drag.id) return;
    cancelAnimationFrame(drag.raf);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    const { card, ph, grid } = drag;
    drag = null;
    ph.replaceWith(card);
    ["position", "left", "top", "width", "maxHeight", "zIndex", "pointerEvents"].forEach((p) => { card.style[p] = ""; });
    card.classList.remove("is-dragging");
    grid.classList.remove("is-dragging");
    document.body.classList.remove("md-noselect");
    card.classList.add("is-dropped");
    setTimeout(() => card.classList.remove("is-dropped"), 600);
    report(grid);
  }

  /* ---------- Keyboard: ↑ ↓ move, ← → change column ---------- */
  root.addEventListener("keydown", (e) => {
    const g = e.target.closest && e.target.closest(".md-grip");
    if (!g || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const card = g.closest("[data-card]");
    const col = card.parentNode;
    const grid = col.closest(".md-layout");
    if (!grid) return;
    const items = [...col.querySelectorAll(":scope > [data-card]")];
    const i = items.indexOf(card);
    let moved = false;
    if (e.key === "ArrowUp" && i > 0) { col.insertBefore(card, items[i - 1]); moved = true; }
    else if (e.key === "ArrowDown" && i < items.length - 1) { items[i + 1].after(card); moved = true; }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const other = grid.querySelector(e.key === "ArrowLeft" ? ":scope > .md-main" : ":scope > .md-side");
      if (other && other !== col) {
        const os = [...other.querySelectorAll(":scope > [data-card]")];
        const t = os[Math.min(i, os.length)];
        if (t) other.insertBefore(card, t); else other.appendChild(card);
        moved = true;
      }
    }
    if (!moved) return;
    e.preventDefault();
    g.focus();
    report(grid);
  });

  /* ---------- Colour picker ---------- */
  let pick = null;
  function outside(e) {
    if (pick && !pick.contains(e.target) && !e.target.closest("[data-mdcolor]")) closePicker();
  }
  function onKey(e) { if (e.key === "Escape") closePicker(); }
  function closePicker() {
    if (!pick) return;
    pick.remove();
    pick = null;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey);
  }
  function openPicker(btn) {
    const k = btn.dataset.mdcolor;
    if (pick && pick.dataset.k === k) { closePicker(); return; }
    closePicker();
    const cur = getDashPrefs(uid()).colors[k] || "";
    pick = document.createElement("div");
    pick.className = "md-cpick";
    pick.dataset.k = k;
    pick.setAttribute("role", "dialog");
    pick.setAttribute("aria-label", "Card colour");
    pick.innerHTML = `<p>Card colour</p><div>${[["", "No colour"], ...DASH_COLORS].map(([c, l]) => `
      <button type="button" class="md-sw" data-c="${c}" data-mdc="${c}" title="${esc(l)}" aria-label="${esc(l)}"
        aria-pressed="${c === cur}"></button>`).join("")}</div>`;
    document.body.appendChild(pick);
    const r = btn.getBoundingClientRect();
    const w = pick.offsetWidth;
    pick.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pick.offsetHeight - 8)}px`;
    pick.style.left = `${Math.max(8, Math.min(r.left - 10, window.innerWidth - w - 8))}px`;
    pick.addEventListener("click", (e) => {
      const s = e.target.closest("[data-c]");
      if (!s) return;
      const c = s.dataset.c;
      onColor(k, c);
      const card = root.querySelector(`.md-col > [data-card="${CSS.escape(k)}"]`);
      if (card) { if (c) card.dataset.mdc = c; else delete card.dataset.mdc; }
      closePicker();
    });
    const first = pick.querySelector('[aria-pressed="true"]') || pick.querySelector("[data-c]");
    if (first) first.focus();
    setTimeout(() => document.addEventListener("pointerdown", outside, true));
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", closePicker, { once: true });
  }

  return { decorate, setMode };
}