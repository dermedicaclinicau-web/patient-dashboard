// Drawing and marks on a picture while filling in a form (face charts, injection points).
// A picture can use one number set (values that add up) plus any label sets (codes like SD, PO).
// Each tap places one mark combining the chosen value from each set.
// The markings are kept separately from the picture, so the Image Bank picture never changes.
import { bankImage } from "./image-bank-api.js";
import { traceShape, shapeSvg, SHAPE_TEXT, textSize } from "./marking-sets.js";

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

// sets: the marking sets for this picture (one number set at most, plus label sets).
// marks: the older single-set option, still accepted.
export function createAnnotator(box, src, { base = "", sets = null, marks = null } = {}) {
  const usable = (Array.isArray(sets) ? sets : marks ? [marks] : [])
    .filter((s) => s && Array.isArray(s.values) && s.values.length);
  const numSet = usable.find((s) => s.type !== "label") || null;
  const labSets = usable.filter((s) => s.type === "label");
  const order = [numSet, ...labSets].filter(Boolean);   // the number set always comes first
  const marking = order.length > 0;
  const tags = numSet && numSet.tagMarks ? (numSet.tags || []).filter(Boolean) : [];
  const sel = order.map(() => 0);   // the chosen value in each set (-1 = no label)
  let tagIdx = 0;

  const valText = (s, x) => (s.type === "label" ? x.code : fmt(x.v));
  const rowHtml = (s, si) => `<div class="an-setrow" data-setrow="${si}">
      <span class="an-setname">${esc(s.name || (s.type === "label" ? "Label" : "Value"))}${s.type !== "label" && s.unit ? ` <small>${esc(s.unit)}</small>` : ""}</span>
      <div class="an-vals" role="group" aria-label="${esc(s.name || "Values")}">${s.values.map((x, i) =>
        `<button type="button" class="an-pick${i === 0 ? " is-on" : ""}" data-pick="${si}:${i}" aria-pressed="${i === 0}"
          title="${esc(s.type === "label" ? (x.name ? `${x.code}: ${x.name}` : x.code) : `${fmt(x.v)} ${s.unit || ""}`)}">${
          shapeSvg(x.shape, x.colour, valText(s, x), { size: 34 })}${s.type === "label" && x.name ? `<small>${esc(x.name)}</small>` : ""}</button>`).join("")}
        ${s.type === "label" ? `<button type="button" class="an-pick is-none" data-pick="${si}:-1" aria-pressed="false">None</button>` : ""}
      </div></div>`;

  box.classList.add("is-drawing");
  box.innerHTML = `
    <div class="an-tools" role="toolbar" aria-label="Drawing tools">
      <div class="an-seg">
        ${marking ? `<button type="button" class="an-btn is-on" data-tool="mark" aria-pressed="true">${I.mark}<span>Mark</span></button>` : ""}
        <button type="button" class="an-btn${marking ? "" : " is-on"}" data-tool="pen" aria-pressed="${!marking}">${I.pen}<span>Draw</span></button>
        <button type="button" class="an-btn" data-tool="dot" aria-pressed="false">${I.dot}<span>Dot</span></button>
      </div>
      <div class="an-colours"${marking ? " hidden" : ""}>${COLOURS.map(([c, l], i) =>
        `<button type="button" class="an-swatch${i === 0 ? " is-on" : ""}" data-colour="${c}" style="--c:${c}" aria-label="${l}" aria-pressed="${i === 0}"></button>`).join("")}</div>
      <div class="an-seg" data-role="sizes"${marking ? " hidden" : ""}>
        <button type="button" class="an-btn is-on" data-size="thin" aria-pressed="true">Thin</button>
        <button type="button" class="an-btn" data-size="thick" aria-pressed="false">Thick</button>
      </div>
      <span class="an-spacer"></span>
      <button type="button" class="an-btn" data-act="undo" disabled>${I.undo}<span>Undo</span></button>
      <button type="button" class="an-btn" data-act="clear" disabled>Clear</button>
    </div>
    ${marking ? `<div class="an-marks" data-role="marks">
      ${order.map(rowHtml).join("")}
      ${tags.length ? `<div class="an-setrow"><span class="an-setname">Tag</span><div class="an-seg an-tags" role="group" aria-label="Tag">${tags.map((t, i) =>
        `<button type="button" class="an-btn${i === 0 ? " is-on" : ""}" data-tag="${i}" aria-pressed="${i === 0}">${esc(t)}</button>`).join("")}</div></div>` : ""}
    </div>` : ""}
    <div class="an-stage"><img alt="" draggable="false" /><canvas aria-label="${marking
      ? "Marking area. Tap to place the chosen values." : "Drawing area. Draw or tap to mark the picture."}"></canvas></div>
    ${marking ? '<div class="an-total" data-role="total" aria-live="polite"></div>' : ""}`;

  const img = box.querySelector(".an-stage img");
  const canvas = box.querySelector("canvas");
  const g = canvas.getContext("2d");
  const undoBtn = box.querySelector('[data-act="undo"]');
  const clearBtn = box.querySelector('[data-act="clear"]');
  const totalEl = box.querySelector('[data-role="total"]');
  const marksRow = box.querySelector('[data-role="marks"]');
  let W = 0, H = 0;
  let tool = marking ? "mark" : "pen", colour = COLOURS[0][0], size = "thin";
  const ops = [];
  let current = null;
  let hint = "";
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

  // What a tap places right now
  function chosen() {
    const num = numSet ? numSet.values[sel[0]] || null : null;
    const labels = [];
    order.forEach((s, si) => {
      if (s.type !== "label" || sel[si] < 0) return;
      const x = s.values[sel[si]];
      if (x) labels.push({ set: s.name, setId: s.id, code: x.code, name: x.name || "", colour: x.colour, shape: x.shape });
    });
    return { num, labels };
  }
  const keyOf = (v, tag, labels) => `${v ?? ""}|${tag || 0}|${labels.map((l) => `${l.setId}:${l.code}`).join(",")}`;
  const buildMark = (c, base0) => ({
    ...base0,
    type: "mark",
    v: c.num ? c.num.v : null,
    colour: c.num ? c.num.colour : c.labels[0].colour,
    shape: c.labels.length ? c.labels[0].shape : (c.num ? c.num.shape : "circle"),
    labels: c.labels,
    tag: tagIdx,
  });

  function drawMark(op) {
    const outlined = (op.tag || 0) > 0; // second and later tags (e.g. Touch-up) are outlined
    const hasNum = op.v !== null && op.v !== undefined;
    const text = hasNum ? fmt(op.v) : ((op.labels && op.labels[0]) || {}).code || "";
    const shape = op.shape || "circle";
    traceShape(g, shape, op.x, op.y, op.r);
    g.fillStyle = outlined ? "#ffffff" : op.colour;
    g.fill();
    g.lineWidth = Math.max(2, op.r / 6);
    g.lineJoin = "round";
    g.strokeStyle = outlined ? op.colour : "#ffffff";
    if (outlined) g.setLineDash([op.r / 3, op.r / 4]);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = outlined ? op.colour : "#ffffff";
    g.font = `bold ${Math.round(op.r * textSize(text, shape))}px Arial, Helvetica, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, op.x, op.y + op.r * (SHAPE_TEXT[shape] || SHAPE_TEXT.circle).dy);

    // The label codes in a small tag beside a number (e.g. "SD")
    if (hasNum && op.labels && op.labels.length) {
      const tagText = op.labels.map((l) => l.code).join("·");
      const fs = Math.round(op.r * 0.72);
      g.font = `bold ${fs}px Arial, Helvetica, sans-serif`;
      const w = g.measureText(tagText).width + fs * 0.7;
      const h = fs * 1.35;
      const bx = op.x + op.r * 0.55, by = op.y + op.r * 0.45;
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, by, w, h, h / 2); else g.rect(bx, by, w, h);
      g.fillStyle = "#ffffff";
      g.fill();
      g.lineWidth = Math.max(1.5, op.r / 9);
      g.strokeStyle = op.labels[0].colour;
      g.stroke();
      g.fillStyle = op.labels[0].colour;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(tagText, bx + fs * 0.35, by + h / 2 + fs * 0.04);
    }
  }

  function drawOp(op) {
    if (op.type === "mark") { drawMark(op); return; }
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

  // Each label of a set: how many marks have it, and their total
  const labelCounts = (s, ms) => s.values.map((x) => {
    const hits = ms.filter((o) => (o.labels || []).some((l) => l.setId === s.id && l.code === x.code));
    return { code: x.code, name: x.name || "", n: hits.length, total: sum(hits) };
  }).filter((c) => c.n > 0);

  function showTotal() {
    if (!totalEl) return;
    const ms = markOps();
    if (hint) { totalEl.innerHTML = `<span class="an-hint">${esc(hint)}</span>`; return; }
    if (!ms.length) {
      totalEl.innerHTML = '<span>Tap the picture to place the chosen values. Tap a mark again to remove it, or choose other values and tap it to change it.</span>';
      return;
    }
    const bits = [];
    if (numSet) bits.push(`Total <strong>${esc(fmt(sum(ms)))}${numSet.unit ? ` ${esc(numSet.unit)}` : ""}</strong>`);
    bits.push(`<span>${ms.length} mark${ms.length === 1 ? "" : "s"}</span>`);
    tags.forEach((t, i) => {
      const n = sum(ms.filter((o) => (o.tag || 0) === i));
      if (n > 0) bits.push(`<span>${esc(t)} ${esc(fmt(n))}</span>`);
    });
    labSets.forEach((s) => {
      const c = labelCounts(s, ms);
      if (c.length) bits.push(`<span>${esc(s.name)}: ${c.map((x) => esc(numSet ? `${x.code} ${fmt(x.total)} (${x.n})` : `${x.code} × ${x.n}`)).join(", ")}</span>`);
    });
    totalEl.innerHTML = bits.join("");
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
      if (o.type === "mark" && Math.hypot(o.x - x, o.y - y) <= o.r * 1.2) return i;
    }
    return -1;
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!W) return;
    e.preventDefault();
    const [x, y] = pos(e);
    if (tool === "mark") {
      const c = chosen();
      if (!c.num && !c.labels.length) {
        hint = "Choose a label first (everything is set to None).";
        showTotal();
        return;
      }
      hint = "";
      const hit = hitMark(x, y);
      if (hit >= 0) {
        const m = ops[hit];
        if (keyOf(m.v, m.tag, m.labels || []) === keyOf(c.num ? c.num.v : null, tagIdx, c.labels)) ops.splice(hit, 1);
        else ops[hit] = buildMark(c, { x: m.x, y: m.y, r: m.r });
      } else {
        ops.push(buildMark(c, { x, y, r: markRadius() }));
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

  const pickOne = (list, b) => list.forEach((x) => {
    const on = x === b;
    x.classList.toggle("is-on", on);
    x.setAttribute("aria-pressed", String(on));
  });
  const setTool = (t) => {
    tool = t;
    pickOne(box.querySelectorAll("[data-tool]"), box.querySelector(`[data-tool="${t}"]`));
    const isMark = t === "mark";
    box.querySelector(".an-colours").hidden = isMark;
    box.querySelector('[data-role="sizes"]').hidden = isMark;
    if (marksRow) marksRow.classList.toggle("is-idle", !isMark);
  };

  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !box.contains(b)) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    else if (b.dataset.colour) { colour = b.dataset.colour; pickOne(box.querySelectorAll("[data-colour]"), b); }
    else if (b.dataset.size) { size = b.dataset.size; pickOne(box.querySelectorAll("[data-size]"), b); }
    else if (b.dataset.pick !== undefined) {
      const [si, i] = b.dataset.pick.split(":").map(Number);
      sel[si] = i;
      pickOne(b.closest("[data-setrow]").querySelectorAll("[data-pick]"), b);
      hint = "";
      setTool("mark");
      showTotal();
    } else if (b.dataset.tag !== undefined) {
      tagIdx = Number(b.dataset.tag);
      pickOne(box.querySelectorAll("[data-tag]"), b);
      setTool("mark");
    } else if (b.dataset.act === "undo") { ops.pop(); changed(); }
    else if (b.dataset.act === "clear") { ops.length = 0; baseImg = null; changed(); }
  });
  showTotal();

  return {
    isEmpty: () => !ops.length && !baseImg,
    toDataURL: () => ((ops.length || baseImg) && W ? canvas.toDataURL("image/png") : ""),
    // The running total (for Calculations and Consumables): only when a number set is used
    total: numSet ? () => sum(markOps()) : null,
    markData: marking ? () => {
      const ms = markOps();
      const byTag = {};
      tags.forEach((t, i) => { byTag[t] = sum(ms.filter((o) => (o.tag || 0) === i)); });
      return {
        marks: ms.map((o) => ({
          x: +(o.x / W).toFixed(4), y: +(o.y / H).toFixed(4),
          ...(o.v !== null && o.v !== undefined ? { v: o.v } : {}),
          ...(tags.length ? { tag: tags[o.tag || 0] } : {}),
          ...((o.labels || []).length ? { labels: o.labels.map((l) => ({ set: l.set, code: l.code })) } : {}),
        })),
        ...(numSet ? { total: sum(ms), byTag, unit: numSet.unit || "", setName: numSet.name || "", setId: numSet.id || "" } : {}),
        labelSets: labSets.map((s) => ({ id: s.id, name: s.name, counts: labelCounts(s, ms) })),
      };
    } : null,
  };
}

// Sets up drawing (and marks) on every drawable picture on a page. Returns { fieldId: annotator }.
export function attachAnnotators(root, fields, { markSets = [] } = {}) {
  const map = {};
  (fields || []).forEach((f) => {
    if (f.type !== "image" || !f.annotate || f.source === "staff" || !f.fileId) return;
    const box = root.querySelector(`[data-annot-img="${CSS.escape(f.id)}"]`);
    if (!box) return;
    const wantsMarks = f.markMode === "marks";
    const ids = Array.isArray(f.markSetIds) && f.markSetIds.length ? f.markSetIds : f.markSetId ? [f.markSetId] : [];
    const sets = wantsMarks ? ids.map((id) => (markSets || []).find((s) => s.id === id)).filter(Boolean) : [];
    bankImage(f.fileId)
      .then((src) => {
        if (!box.isConnected) return;
        map[f.id] = createAnnotator(box, src, { sets });
        if (wantsMarks && sets.length < ids.length) {
          box.insertAdjacentHTML("afterbegin", `<p class="an-warn">${sets.length
            ? "One of this picture's marking sets has been deleted."
            : "This picture's marking sets have been deleted, so only drawing is available."} Choose sets again in Form Builder.</p>`);
        }
      })
      .catch(() => {
        if (box.isConnected) box.innerHTML = '<span class="fe-img-missing">This picture is missing from the Image Bank</span>';
      });
  });
  return map;
}