// Drawing and unit marks on a picture while filling in a form (face charts, injection points).
// The markings are kept separately from the picture, so the Image Bank picture never changes.
import { bankImage } from "./image-bank-api.js";

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  pen: ic('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  dot: ic('<circle cx="12" cy="12" r="5" fill="currentColor"/>'),
  mark: ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  undo: ic('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
};
const COLOURS = [["#dc2626", "Red"], ["#2563eb", "Blue"], ["#16a34a", "Green"], ["#111827", "Black"]];
const MAX_W = 1200; // drawing resolution (wide enough for print, small enough to save)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(+Number(n || 0).toFixed(2));
const sum = (list) => Math.round(list.reduce((a, o) => a + Number(o.v || 0), 0) * 100) / 100;

// marks: a marking set ({ id, name, unit, values: [{ v, colour }], tagMarks, tags }) to place unit marks
export function createAnnotator(box, src, { base = "", marks = null } = {}) {
  const set = marks && Array.isArray(marks.values) && marks.values.length ? marks : null;
  const tags = set && set.tagMarks ? (set.tags || []).filter(Boolean) : [];
  box.classList.add("is-drawing");
  box.innerHTML = `
    <div class="an-tools" role="toolbar" aria-label="Drawing tools">
      <div class="an-seg">
        ${set ? `<button type="button" class="an-btn is-on" data-tool="mark" aria-pressed="true">${I.mark}<span>Mark</span></button>` : ""}
        <button type="button" class="an-btn${set ? "" : " is-on"}" data-tool="pen" aria-pressed="${!set}">${I.pen}<span>Draw</span></button>
        <button type="button" class="an-btn" data-tool="dot" aria-pressed="false">${I.dot}<span>Dot</span></button>
      </div>
      <div class="an-colours"${set ? " hidden" : ""}>${COLOURS.map(([c, l], i) =>
        `<button type="button" class="an-swatch${i === 0 ? " is-on" : ""}" data-colour="${c}" style="--c:${c}" aria-label="${l}" aria-pressed="${i === 0}"></button>`).join("")}</div>
      <div class="an-seg" data-role="sizes"${set ? " hidden" : ""}>
        <button type="button" class="an-btn is-on" data-size="thin" aria-pressed="true">Thin</button>
        <button type="button" class="an-btn" data-size="thick" aria-pressed="false">Thick</button>
      </div>
      <span class="an-spacer"></span>
      <button type="button" class="an-btn" data-act="undo" disabled>${I.undo}<span>Undo</span></button>
      <button type="button" class="an-btn" data-act="clear" disabled>Clear</button>
    </div>
    ${set ? `<div class="an-marks" data-role="marks">
      <div class="an-vals" role="group" aria-label="Value to place">${set.values.map((x, i) =>
        `<button type="button" class="an-chip${i === 0 ? " is-on" : ""}" data-mark="${i}" style="--c:${esc(x.colour)}" aria-pressed="${i === 0}">${esc(fmt(x.v))}</button>`).join("")}
        ${set.unit ? `<span class="an-unit">${esc(set.unit)}</span>` : ""}</div>
      ${tags.length ? `<div class="an-seg an-tags" role="group" aria-label="Tag">${tags.map((t, i) =>
        `<button type="button" class="an-btn${i === 0 ? " is-on" : ""}" data-tag="${i}" aria-pressed="${i === 0}">${esc(t)}</button>`).join("")}</div>` : ""}
    </div>` : ""}
    <div class="an-stage"><img alt="" draggable="false" /><canvas aria-label="${set
      ? "Marking area. Tap to place the chosen value." : "Drawing area. Draw or tap to mark the picture."}"></canvas></div>
    ${set ? '<div class="an-total" data-role="total" aria-live="polite"></div>' : ""}`;

  const img = box.querySelector(".an-stage img");
  const canvas = box.querySelector("canvas");
  const g = canvas.getContext("2d");
  const undoBtn = box.querySelector('[data-act="undo"]');
  const clearBtn = box.querySelector('[data-act="clear"]');
  const totalEl = box.querySelector('[data-role="total"]');
  const marksRow = box.querySelector('[data-role="marks"]');
  let W = 0, H = 0;
  let tool = set ? "mark" : "pen", colour = COLOURS[0][0], size = "thin";
  let markIdx = 0, tagIdx = 0;
  const ops = [];
  let current = null;
  // Earlier markings to keep drawing on top of
  let baseImg = null;
  if (base) {
    const b = new Image();
    b.onload = () => { baseImg = b; redraw(); };
    b.src = base;
  }

  const scale = () => (W || 1000) / 1000;
  const penWidth = () => (size === "thick" ? 7 : 3) * scale();
  const dotRadius = () => (size === "thick" ? 12 : 7) * scale();
  // Marks are about 13px on screen, whatever size the picture is shown at
  const markRadius = () => {
    const shown = canvas.getBoundingClientRect().width || W;
    return Math.max(10, 13 * W / shown);
  };
  const markOps = () => ops.filter((o) => o.type === "mark");

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
    if (op.type === "mark") {
      const outlined = (op.tag || 0) > 0; // second and later tags (e.g. Touch-up) are outlined
      const label = fmt(op.v);
      g.beginPath();
      g.arc(op.x, op.y, op.r, 0, Math.PI * 2);
      g.fillStyle = outlined ? "#ffffff" : op.colour;
      g.fill();
      g.lineWidth = Math.max(2, op.r / 6);
      g.strokeStyle = outlined ? op.colour : "#ffffff";
      if (outlined) g.setLineDash([op.r / 3, op.r / 4]);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = outlined ? op.colour : "#ffffff";
      g.font = `bold ${Math.round(op.r * (label.length > 2 ? 0.78 : 1))}px Arial, Helvetica, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(label, op.x, op.y + op.r * 0.06);
      return;
    }
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

  function showTotal() {
    if (!totalEl) return;
    const ms = markOps();
    if (!ms.length) {
      totalEl.innerHTML = '<span>Tap the picture to place the chosen value. Tap a mark again to remove it, or choose another value and tap it to change it.</span>';
      return;
    }
    const parts = tags.length
      ? tags.map((t, i) => [t, sum(ms.filter((o) => (o.tag || 0) === i))]).filter(([, n]) => n > 0) : [];
    totalEl.innerHTML = `Total <strong>${esc(fmt(sum(ms)))}${set.unit ? ` ${esc(set.unit)}` : ""}</strong>` +
      `<span>${ms.length} mark${ms.length === 1 ? "" : "s"}</span>` +
      parts.map(([t, n]) => `<span>${esc(t)} ${esc(fmt(n))}</span>`).join("");
  }

  function redraw() {
    g.clearRect(0, 0, W, H);
    if (baseImg && W) g.drawImage(baseImg, 0, 0, W, H);
    ops.forEach(drawOp);
    undoBtn.disabled = !ops.length;
    clearBtn.disabled = !ops.length && !baseImg;
    showTotal();
  }
  const changed = () => { redraw(); box.dispatchEvent(new Event("input", { bubbles: true })); };

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height];
  };
  // The mark under the finger (the top one if they overlap), or -1
  const hitMark = (x, y) => {
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i];
      if (o.type === "mark" && Math.hypot(o.x - x, o.y - y) <= o.r * 1.15) return i;
    }
    return -1;
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!W) return;
    e.preventDefault();
    const [x, y] = pos(e);
    if (tool === "mark") {
      const val = set.values[markIdx];
      const hit = hitMark(x, y);
      if (hit >= 0) {
        const m = ops[hit];
        if (m.v === val.v && (m.tag || 0) === tagIdx) ops.splice(hit, 1);
        else ops[hit] = { ...m, v: val.v, colour: val.colour, tag: tagIdx };
      } else {
        ops.push({ type: "mark", x, y, r: markRadius(), v: val.v, colour: val.colour, tag: tagIdx });
      }
      changed();
      return;
    }
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

  const pickOne = (sel, b) => box.querySelectorAll(sel).forEach((x) => {
    const on = x === b;
    x.classList.toggle("is-on", on);
    x.setAttribute("aria-pressed", String(on));
  });
  const setTool = (t) => {
    tool = t;
    pickOne("[data-tool]", box.querySelector(`[data-tool="${t}"]`));
    const marking = t === "mark";
    box.querySelector(".an-colours").hidden = marking;
    box.querySelector('[data-role="sizes"]').hidden = marking;
    if (marksRow) marksRow.classList.toggle("is-idle", !marking);
  };

  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !box.contains(b)) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    else if (b.dataset.colour) { colour = b.dataset.colour; pickOne("[data-colour]", b); }
    else if (b.dataset.size) { size = b.dataset.size; pickOne("[data-size]", b); }
    else if (b.dataset.mark !== undefined) { markIdx = Number(b.dataset.mark); pickOne("[data-mark]", b); setTool("mark"); }
    else if (b.dataset.tag !== undefined) { tagIdx = Number(b.dataset.tag); pickOne("[data-tag]", b); setTool("mark"); }
    else if (b.dataset.act === "undo") { ops.pop(); changed(); }
    else if (b.dataset.act === "clear") { ops.length = 0; baseImg = null; changed(); }
  });
  showTotal();

  return {
    isEmpty: () => !ops.length && !baseImg,
    toDataURL: () => ((ops.length || baseImg) && W ? canvas.toDataURL("image/png") : ""),
    // Marking pictures only: the running total (for Calculations) and what gets saved
    total: set ? () => sum(markOps()) : null,
    markData: set ? () => {
      const ms = markOps();
      const byTag = {};
      tags.forEach((t, i) => { byTag[t] = sum(ms.filter((o) => (o.tag || 0) === i)); });
      return {
        marks: ms.map((o) => ({
          x: +(o.x / W).toFixed(4), y: +(o.y / H).toFixed(4), v: o.v,
          ...(tags.length ? { tag: tags[o.tag || 0] } : {}),
        })),
        total: sum(ms), byTag, unit: set.unit || "", setName: set.name || "", setId: set.id || "",
      };
    } : null,
  };
}

// Sets up drawing (and unit marks) on every drawable picture on a page. Returns { fieldId: annotator }.
export function attachAnnotators(root, fields, { markSets = [] } = {}) {
  const map = {};
  (fields || []).forEach((f) => {
    if (f.type !== "image" || !f.annotate || f.source === "staff" || !f.fileId) return;
    const box = root.querySelector(`[data-annot-img="${CSS.escape(f.id)}"]`);
    if (!box) return;
    const wantsMarks = f.markMode === "marks";
    const set = wantsMarks ? (markSets || []).find((s) => s.id === f.markSetId) || null : null;
    bankImage(f.fileId)
      .then((src) => {
        if (!box.isConnected) return;
        map[f.id] = createAnnotator(box, src, { marks: set });
        if (wantsMarks && !set) {
          box.insertAdjacentHTML("afterbegin", '<p class="an-warn">This picture\'s marking set has been deleted, so only drawing is available. Choose another set in Form Builder.</p>');
        }
      })
      .catch(() => {
        if (box.isConnected) box.innerHTML = '<span class="fe-img-missing">This picture is missing from the Image Bank</span>';
      });
  });
  return map;
}