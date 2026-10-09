// Drawing on a picture while filling in a form (face charts, injection points).
// The markings are kept separately from the picture, so the Image Bank picture never changes.
import { bankImage } from "./image-bank-api.js";

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  pen: ic('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  dot: ic('<circle cx="12" cy="12" r="5" fill="currentColor"/>'),
  undo: ic('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
};
const COLOURS = [["#dc2626", "Red"], ["#2563eb", "Blue"], ["#16a34a", "Green"], ["#111827", "Black"]];
const MAX_W = 1200; // drawing resolution (wide enough for print, small enough to save)

export function createAnnotator(box, src, { base = "" } = {}) {
  box.classList.add("is-drawing");
  box.innerHTML = `
    <div class="an-tools" role="toolbar" aria-label="Drawing tools">
      <div class="an-seg">
        <button type="button" class="an-btn is-on" data-tool="pen" aria-pressed="true">${I.pen}<span>Draw</span></button>
        <button type="button" class="an-btn" data-tool="dot" aria-pressed="false">${I.dot}<span>Dot</span></button>
      </div>
      <div class="an-colours">${COLOURS.map(([c, l], i) =>
        `<button type="button" class="an-swatch${i === 0 ? " is-on" : ""}" data-colour="${c}" style="--c:${c}" aria-label="${l}" aria-pressed="${i === 0}"></button>`).join("")}</div>
      <div class="an-seg">
        <button type="button" class="an-btn is-on" data-size="thin" aria-pressed="true">Thin</button>
        <button type="button" class="an-btn" data-size="thick" aria-pressed="false">Thick</button>
      </div>
      <span class="an-spacer"></span>
      <button type="button" class="an-btn" data-act="undo" disabled>${I.undo}<span>Undo</span></button>
      <button type="button" class="an-btn" data-act="clear" disabled>Clear</button>
    </div>
    <div class="an-stage"><img alt="" draggable="false" /><canvas aria-label="Drawing area. Draw or tap to mark the picture."></canvas></div>`;

  const img = box.querySelector(".an-stage img");
  const canvas = box.querySelector("canvas");
  const g = canvas.getContext("2d");
  const undoBtn = box.querySelector('[data-act="undo"]');
  const clearBtn = box.querySelector('[data-act="clear"]');
  let W = 0, H = 0;
  let tool = "pen", colour = COLOURS[0][0], size = "thin";
  const ops = [];
  let current = null;
  

  const scale = () => (W || 1000) / 1000;
  const penWidth = () => (size === "thick" ? 7 : 3) * scale();
  const dotRadius = () => (size === "thick" ? 12 : 7) * scale();

  function setup() {
    const nw = img.naturalWidth || 1000, nh = img.naturalHeight || 750;
    W = Math.min(nw, MAX_W);
    H = Math.round(W * nh / nw);
    canvas.width = W;
    canvas.height = H;
    redraw();
  }
  img.addEventListener("load", setup);
  img.src = src;
  if (img.complete && img.naturalWidth) setup();

  function drawOp(op) {
    g.fillStyle = g.strokeStyle = op.colour;
    if (op.type === "dot") {
      g.beginPath();
      g.arc(op.x, op.y, op.r, 0, Math.PI * 2);
      g.fill();
      return;
    }
    g.lineWidth = op.width;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    op.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (op.points.length === 1) g.lineTo(op.points[0][0] + 0.1, op.points[0][1]);
    g.stroke();
  }
    function redraw() {
    g.clearRect(0, 0, W, H);
    if (baseImg && W) g.drawImage(baseImg, 0, 0, W, H);
    ops.forEach(drawOp);
    undoBtn.disabled = !ops.length;
    clearBtn.disabled = !ops.length && !baseImg;
  }
  const changed = () => { redraw(); box.dispatchEvent(new Event("input", { bubbles: true })); };

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height];
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!W) return;
    e.preventDefault();
    const [x, y] = pos(e);
    if (tool === "dot") {
      ops.push({ type: "dot", colour, r: dotRadius(), x, y });
      changed();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    current = { type: "pen", colour, width: penWidth(), points: [[x, y]] };
    ops.push(current);
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!current) return;
    current.points.push(pos(e));
    redraw();
  });
  const finish = () => { if (current) { current = null; changed(); } };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  box.querySelector(".an-tools").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const pickOne = (sel, attr) => box.querySelectorAll(sel).forEach((x) => {
      const on = x === b;
      x.classList.toggle("is-on", on);
      x.setAttribute("aria-pressed", String(on));
    });
    if (b.dataset.tool) { tool = b.dataset.tool; pickOne("[data-tool]"); }
    else if (b.dataset.colour) { colour = b.dataset.colour; pickOne("[data-colour]"); }
    else if (b.dataset.size) { size = b.dataset.size; pickOne("[data-size]"); }
    else if (b.dataset.act === "undo") { ops.pop(); changed(); }
    else if (b.dataset.act === "clear") { ops.length = 0; baseImg = null; changed(); }
  });

  return {
    isEmpty: () => !ops.length && !baseImg,
    toDataURL: () => ((ops.length || baseImg) && W ? canvas.toDataURL("image/png") : ""),
  };
}

// Sets up drawing on every "Staff can draw on it" picture on a page. Returns { fieldId: annotator }.
export function attachAnnotators(root, fields) {
  const map = {};
  (fields || []).forEach((f) => {
    if (f.type !== "image" || !f.annotate || f.source === "staff" || !f.fileId) return;
    const box = root.querySelector(`[data-annot-img="${CSS.escape(f.id)}"]`);
    if (!box) return;
    bankImage(f.fileId)
      .then((src) => { if (box.isConnected) map[f.id] = createAnnotator(box, src); })
      .catch(() => {
        if (box.isConnected) box.innerHTML = '<span class="fe-img-missing">This picture is missing from the Image Bank</span>';
      });
  });
  return map;
}