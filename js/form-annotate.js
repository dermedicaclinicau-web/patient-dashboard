// Drawing and marks on a picture while filling in a form (face charts, injection points).
// A picture can use several marking sets. Each is placed on its own: staff pick a value from any set,
// then tap the picture. Number sets add up; label sets (e.g. SD, PO) are counted.
// Erase removes one mark, dot or line. Undo steps back through every change (including Erase and Clear).
// The markings are kept separately from the picture, so the Image Bank picture never changes.
import { bankImage } from "./image-bank-api.js";
import { traceShape, valueSvg, valueText, SHAPE_TEXT, textSize } from "./marking-sets.js";

const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  pen: ic('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  dot: ic('<circle cx="12" cy="12" r="5" fill="currentColor"/>'),
  mark: ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  erase: ic('<path d="M20 20H8l-4.3-4.3a2 2 0 0 1 0-2.8L13.2 3.4a2 2 0 0 1 2.8 0l4.6 4.6a2 2 0 0 1 0 2.8L11 20"/><line x1="7.5" y1="9.5" x2="14.5" y2="16.5"/>'),
  undo: ic('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
};
const COLOURS = [["#dc2626", "Red"], ["#2563eb", "Blue"], ["#16a34a", "Green"], ["#111827", "Black"]];
const MAX_W = 1200; // drawing resolution (wide enough for print, small enough to save)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(+Number(n || 0).toFixed(2));
const sum = (list) => Math.round(list.reduce((a, o) => a + Number(o.v || 0), 0) * 100) / 100;
// Distance from a point to a line segment
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const u = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
};

// sets: the marking sets staff can use on this picture (in the order they were ticked).
// marks: the older single-set option, still accepted.
export function createAnnotator(box, src, { base = "", sets = null, marks = null } = {}) {
  const order = (Array.isArray(sets) ? sets : marks ? [marks] : [])
    .filter((s) => s && Array.isArray(s.values) && s.values.length);
  const marking = order.length > 0;
  // The first number set: its total feeds Calculations and Consumables
  const primary = order.find((s) => s.type !== "label") || null;
  const tagsOf = (s) => (s.type !== "label" && s.tagMarks ? (s.tags || []).filter(Boolean) : []);
  const sel = order.map(() => 0);      // chosen value in each set
  const tagSel = order.map(() => 0);   // chosen tag in each set (Treatment / Touch-up)
  let active = 0;                      // the set the next tap places

  const rowHtml = (s, si) => `<div class="an-setrow${si === active ? " is-active" : ""}" data-setrow="${si}">
      <span class="an-setname">${esc(s.name || (s.type === "label" ? "Labels" : "Values"))}${s.type !== "label" && s.unit ? ` <small>${esc(s.unit)}</small>` : ""}</span>
      <div class="an-vals" role="group" aria-label="${esc(s.name || "Values")}">${s.values.map((x, i) =>
        `<button type="button" class="an-pick${i === 0 ? " is-on" : ""}" data-pick="${si}:${i}" aria-pressed="${i === 0}"
          title="${esc(s.type === "label" ? (x.name ? `${x.code}: ${x.name}` : x.code) : `${fmt(x.v)} ${s.unit || ""}`)}">${
          valueSvg(s, x, 34)}${s.type === "label" && x.name ? `<small>${esc(x.name)}</small>` : ""}</button>`).join("")}</div>
      ${tagsOf(s).length ? `<div class="an-seg an-tags" role="group" aria-label="Tag">${tagsOf(s).map((t, i) =>
        `<button type="button" class="an-btn${i === 0 ? " is-on" : ""}" data-tag="${si}:${i}" aria-pressed="${i === 0}">${esc(t)}</button>`).join("")}</div>` : ""}
    </div>`;

  box.classList.add("is-drawing");
  box.innerHTML = `
    <div class="an-tools" role="toolbar" aria-label="Drawing tools">
      <div class="an-seg">
        ${marking ? `<button type="button" class="an-btn is-on" data-tool="mark" aria-pressed="true">${I.mark}<span>Mark</span></button>` : ""}
        <button type="button" class="an-btn${marking ? "" : " is-on"}" data-tool="pen" aria-pressed="${!marking}">${I.pen}<span>Draw</span></button>
        <button type="button" class="an-btn" data-tool="dot" aria-pressed="false">${I.dot}<span>Dot</span></button>
        <button type="button" class="an-btn" data-tool="erase" aria-pressed="false" title="Tap one mark, dot or line to remove it">${I.erase}<span>Erase</span></button>
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
    ${marking ? `<div class="an-marks${order.length === 1 ? " has-one" : ""}" data-role="marks">${order.map(rowHtml).join("")}</div>` : ""}
    <div class="an-stage"><img alt="" draggable="false" /><canvas aria-label="${marking
      ? "Marking area. Tap to place the chosen value." : "Drawing area. Draw or tap to mark the picture."}"></canvas></div>
    ${marking ? '<div class="an-total" data-role="total" aria-live="polite"></div>' : ""}`;

  const img = box.querySelector(".an-stage img");
  const stage = box.querySelector(".an-stage");
  const canvas = box.querySelector("canvas");
  const g = canvas.getContext("2d");
  const undoBtn = box.querySelector('[data-act="undo"]');
  const clearBtn = box.querySelector('[data-act="clear"]');
  const totalEl = box.querySelector('[data-role="total"]');
  const marksRow = box.querySelector('[data-role="marks"]');
  let W = 0, H = 0;
  let tool = marking ? "mark" : "pen", colour = COLOURS[0][0], size = "thin";
  const ops = [];
  // Every change, so Undo can step back through them:
  // { add: op } · { removed: op, at } · { replaced: oldOp, by: newOp } · { cleared: [...ops], base }
  const history = [];
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
  // n screen pixels, in drawing pixels (the picture may be shown smaller or bigger than it's drawn)
  const px = (n) => n * W / (canvas.getBoundingClientRect().width || W);
  // Marks are about 13px on screen, whatever size the picture is shown at
  const markRadius = () => Math.max(10, px(13));
  const markOps = () => ops.filter((o) => o.type === "mark");
  const marksOf = (s) => markOps().filter((o) => o.setId === s.id);

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

  // A mark from the active set's chosen value, carrying its own look
  function makeMark(at) {
    const s = order[active];
    const x = s.values[sel[active]];
    const label = s.type === "label";
    return {
      ...at, type: "mark", si: active, setId: s.id, label,
      v: label ? null : x.v, code: label ? x.code : "", text: valueText(s, x),
      shape: x.shape || "circle", colour: x.colour, fill: x.fill || "solid", tcolour: x.text, tsize: x.tsize || "m",
      tag: tagsOf(s).length ? tagSel[active] : 0,
    };
  }

  function drawMark(op) {
    const shape = op.shape || "circle";
    const see = op.fill === "none";
    const dashed = (op.tag || 0) > 0; // second and later tags (e.g. Touch-up) are dashed
    traceShape(g, shape, op.x, op.y, op.r);
    if (!see) { g.fillStyle = dashed ? "#ffffff" : op.colour; g.fill(); }
    g.lineWidth = see ? Math.max(2.5, op.r / 4.5) : Math.max(2, op.r / 6);
    g.lineJoin = "round";
    g.strokeStyle = see || dashed ? op.colour : "#ffffff";
    if (dashed) g.setLineDash([op.r / 3, op.r / 4]);
    g.stroke();
    g.setLineDash([]);

    const fs = Math.round(op.r * textSize(op.text, shape, op.tsize));
    const ty = op.y + op.r * (SHAPE_TEXT[shape] || SHAPE_TEXT.circle).dy;
    g.font = `bold ${fs}px Arial, Helvetica, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (see) { // a soft white halo so the text reads on any skin tone
      g.lineWidth = Math.max(2, fs / 4);
      g.strokeStyle = "rgba(255,255,255,0.9)";
      g.strokeText(op.text, op.x, ty);
    }
    g.fillStyle = dashed && !see ? op.colour : (op.tcolour || (see ? op.colour : "#ffffff"));
    g.fillText(op.text, op.x, ty);
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

  // One set's figures: a number set's total (and tags), or a label set's counts
  function setFigures(s) {
    const mine = marksOf(s);
    if (s.type === "label") {
      return { id: s.id, name: s.name, type: "label", n: mine.length,
        counts: s.values.map((x) => ({ code: x.code, name: x.name || "", n: mine.filter((o) => o.code === x.code).length })).filter((c) => c.n) };
    }
    const tags = tagsOf(s);
    const out = { id: s.id, name: s.name, type: "number", unit: s.unit || "", n: mine.length, total: sum(mine) };
    if (tags.length) {
      out.byTag = {};
      tags.forEach((t, i) => { out.byTag[t] = sum(mine.filter((o) => (o.tag || 0) === i)); });
    }
    return out;
  }

  function showTotal() {
    if (!totalEl) return;
    if (tool === "erase") {
      totalEl.innerHTML = "<span>Tap a mark, dot or line to remove it. Undo brings it back.</span>";
      return;
    }
    if (!markOps().length) {
      totalEl.innerHTML = `<span>${order.length > 1 ? "Choose a value from any set, then tap the picture." : "Tap the picture to place the chosen value."}
        To remove one mark, use Erase.</span>`;
      return;
    }
    totalEl.innerHTML = order.map((s) => {
      const f = setFigures(s);
      if (!f.n) return "";
      if (f.type === "label") return `<span><b>${esc(s.name)}:</b> ${esc(f.counts.map((c) => `${c.code} × ${c.n}`).join(", "))}</span>`;
      const tags = f.byTag ? Object.entries(f.byTag).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${fmt(n)}`) : [];
      return `<span><b>${esc(s.name)}:</b> <strong>${esc(fmt(f.total))}${s.unit ? ` ${esc(s.unit)}` : ""}</strong> (${f.n} mark${f.n === 1 ? "" : "s"})${
        tags.length ? ` · ${esc(tags.join(" · "))}` : ""}</span>`;
    }).join("");
  }

  function redraw() {
    g.clearRect(0, 0, W, H);
    if (baseImg && W) g.drawImage(baseImg, 0, 0, W, H);
    ops.forEach(drawOp);
    undoBtn.disabled = !history.length;
    clearBtn.disabled = !ops.length && !baseImg;
    showTotal();
  }
  const changed = () => { redraw(); box.dispatchEvent(new Event("input", { bubbles: true })); };

  function undo() {
    const h = history.pop();
    if (!h) return;
    if (h.add) { const i = ops.indexOf(h.add); if (i >= 0) ops.splice(i, 1); }
    else if (h.removed) ops.splice(Math.min(h.at, ops.length), 0, h.removed);
    else if (h.replaced) { const i = ops.indexOf(h.by); if (i >= 0) ops[i] = h.replaced; }
    else if (h.cleared) { ops.splice(0, ops.length, ...h.cleared); baseImg = h.base; }
    changed();
  }

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height];
  };
  // The active set's mark under the finger (the top one if they overlap), or -1
  const hitMark = (x, y, setId) => {
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i];
      if (o.type === "mark" && o.setId === setId && Math.hypot(o.x - x, o.y - y) <= o.r * 1.2) return i;
    }
    return -1;
  };
  // Anything under the finger (the top one first): a mark, a dot or a pen line. About a fingertip wide.
  const hitAny = (x, y) => {
    const tol = px(10);
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i];
      if (o.type === "mark" && Math.hypot(o.x - x, o.y - y) <= o.r * 1.2 + tol * 0.3) return i;
      if (o.type === "dot" && Math.hypot(o.x - x, o.y - y) <= o.r + tol) return i;
      if (o.type === "pen") {
        const lim = o.width / 2 + tol;
        const pts = o.points;
        for (let k = 0; k < pts.length; k++) {
          const [ax, ay] = pts[k];
          const [bx, by] = pts[Math.min(k + 1, pts.length - 1)];
          if (segDist(x, y, ax, ay, bx, by) <= lim) return i;
        }
      }
    }
    return -1;
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!W) return;
    e.preventDefault();
    const [x, y] = pos(e);
    if (tool === "erase") {
      const i = hitAny(x, y);
      if (i >= 0) {
        history.push({ removed: ops[i], at: i });
        ops.splice(i, 1);
        changed();
      }
      return;
    }
    if (tool === "mark") {
      const next = makeMark({ x, y, r: markRadius() });
      const hit = hitMark(x, y, next.setId);
      if (hit >= 0) {
        const m = ops[hit];
        const same = (m.label ? m.code === next.code : m.v === next.v) && (m.tag || 0) === (next.tag || 0);
        if (same) { history.push({ removed: m, at: hit }); ops.splice(hit, 1); }
        else { const by = { ...next, x: m.x, y: m.y, r: m.r }; ops[hit] = by; history.push({ replaced: m, by }); }
      } else {
        ops.push(next);
        history.push({ add: next });
      }
      changed();
      return;
    }
    if (tool === "dot") {
      const d = { type: "dot", colour, r: dotRadius(), x, y };
      ops.push(d);
      history.push({ add: d });
      changed();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    current = { type: "pen", colour, width: penWidth(), points: [[x, y]] };
    ops.push(current);
    history.push({ add: current });
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
  const setActive = (si) => {
    active = si;
    box.querySelectorAll("[data-setrow]").forEach((r) => r.classList.toggle("is-active", Number(r.dataset.setrow) === si));
  };
  const setTool = (t) => {
    tool = t;
    pickOne(box.querySelectorAll("[data-tool]"), box.querySelector(`[data-tool="${t}"]`));
    const plain = t === "pen" || t === "dot";   // colour and size only matter for drawing
    box.querySelector(".an-colours").hidden = !plain;
    box.querySelector('[data-role="sizes"]').hidden = !plain;
    if (marksRow) marksRow.classList.toggle("is-idle", t !== "mark");
    stage.classList.toggle("is-erasing", t === "erase");
    showTotal();
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
      setActive(si);
      setTool("mark");
    } else if (b.dataset.tag !== undefined) {
      const [si, i] = b.dataset.tag.split(":").map(Number);
      tagSel[si] = i;
      pickOne(b.closest("[data-setrow]").querySelectorAll("[data-tag]"), b);
      setActive(si);
      setTool("mark");
    } else if (b.dataset.act === "undo") undo();
    else if (b.dataset.act === "clear") {
      if (!ops.length && !baseImg) return;
      history.push({ cleared: ops.slice(), base: baseImg });
      ops.length = 0;
      baseImg = null;
      changed();
    }
  });
  showTotal();

  return {
    isEmpty: () => !ops.length && !baseImg,
    toDataURL: () => ((ops.length || baseImg) && W ? canvas.toDataURL("image/png") : ""),
    // The first number set's total (for Calculations and Consumables)
    total: primary ? () => sum(marksOf(primary)) : null,
    markData: marking ? () => {
      const setsOut = order.map(setFigures);
      const prim = primary ? setsOut.find((x) => x.id === primary.id) : null;
      return {
        marks: markOps().map((o) => {
          const s = order[o.si];
          const tags = tagsOf(s);
          return {
            x: +(o.x / W).toFixed(4), y: +(o.y / H).toFixed(4), set: s.name, setId: o.setId,
            ...(o.label ? { code: o.code } : { v: o.v }),
            ...(tags.length ? { tag: tags[o.tag || 0] } : {}),
          };
        }),
        sets: setsOut,
        ...(prim ? { total: prim.total, byTag: prim.byTag || {}, unit: prim.unit, setName: prim.name, setId: prim.id } : {}),
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