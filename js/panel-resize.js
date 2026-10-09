// Drag handles to widen or narrow Form Builder's field panel and settings panel.
// Widths are remembered on this computer. Double-click a handle to reset it.
const KEY = "fe-panel-widths";
const LIMITS = { pal: [150, 420], insp: [260, 720] };
const isWide = () => window.matchMedia("(min-width: 1281px)").matches;

export function makeResizable(root) {
  const pal = root.querySelector(".fe-palette");
  const insp = root.querySelector(".fe-inspector");
  if (!pal || !insp) return;

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { /* ignore */ }
  const widths = { pal: Number(saved.pal) || null, insp: Number(saved.insp) || null };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(widths)); } catch { /* private mode */ } };

  function apply() {
    const parent = pal.parentElement;
    const sameParent = parent && parent === insp.parentElement;
    if (sameParent) parent.style.gridTemplateColumns = "";
    [["pal", pal], ["insp", insp]].forEach(([k, el]) => {
      const w = isWide() ? widths[k] : null;
      el.style.width = w ? `${w}px` : "";
      el.style.flex = w ? `0 0 ${w}px` : "";
    });
    if (!isWide() || !sameParent || getComputedStyle(parent).display !== "grid") return;

    // Grid layout: rewrite the column sizes, keeping the middle flexible
    const kids = [...parent.children].filter((c) => {
      const cs = getComputedStyle(c);
      return cs.display !== "none" && cs.position !== "absolute" && cs.position !== "fixed";
    });
    const cols = getComputedStyle(parent).gridTemplateColumns.split(" ").filter(Boolean);
    if (cols.length !== kids.length) return;
    parent.style.gridTemplateColumns = kids.map((c, i) => {
      if (c === pal) return widths.pal ? `${widths.pal}px` : cols[i];
      if (c === insp) return widths.insp ? `${widths.insp}px` : cols[i];
      return "minmax(0, 1fr)";
    }).join(" ");
  }

  function set(key, w) {
    const [lo, hi] = LIMITS[key];
    widths[key] = Math.round(Math.max(lo, Math.min(hi, w)));
    apply();
  }

  function addHandle(el, key, side) {
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    const h = document.createElement("div");
    h.className = `fe-resize is-${side}`;
    h.setAttribute("role", "separator");
    h.setAttribute("aria-orientation", "vertical");
    h.setAttribute("aria-label", key === "pal" ? "Resize the field panel" : "Resize the settings panel");
    h.title = "Drag to resize. Double-click to reset.";
    h.tabIndex = 0;
    el.appendChild(h);
    // The panel's contents get redrawn often; keep the handle in place
    new MutationObserver(() => { if (!h.isConnected && el.isConnected) el.appendChild(h); })
      .observe(el, { childList: true });

    h.addEventListener("pointerdown", (e) => {
      if (!isWide()) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      document.body.classList.add("is-resizing");
      const move = (ev) => {
        const dx = ev.clientX - startX;
        set(key, side === "right" ? startW + dx : startW - dx);
      };
      const up = () => {
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
        document.body.classList.remove("is-resizing");
        save();
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
    h.addEventListener("dblclick", () => { widths[key] = null; apply(); save(); });
    h.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const grow = (e.key === "ArrowRight") === (side === "right");
      set(key, el.getBoundingClientRect().width + (grow ? 16 : -16));
      save();
    });
  }

  addHandle(pal, "pal", "right");
  addHandle(insp, "insp", "left");
  apply();

  const onResize = () => {
    if (!root.isConnected) { window.removeEventListener("resize", onResize); return; }
    apply();
  };
  window.addEventListener("resize", onResize);
}