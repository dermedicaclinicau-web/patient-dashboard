// Marking sets: what staff can place on a picture.
//   Numbers: values that add up to a total (e.g. wrinkle relaxer units 0.5, 1, 2…).
//   Labels: short codes that are counted (e.g. depth of placement SD, PO).
// Every value has a colour and a shape. A picture can use one number set plus any label sets;
// each mark combines a value from each. One list in form_settings/marking_sets, shared by every form.
// Saved forms keep their own copy of each mark, so editing a set later never changes a saved record.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const MARK_COLOURS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#db2777", "#0891b2", "#4b5563"];
export const MARK_SHAPES = [["circle", "Circle"], ["square", "Square"], ["diamond", "Diamond"], ["triangle", "Triangle"],
  ["hexagon", "Hexagon"], ["star", "Star"]];
const SHAPE_KEYS = MARK_SHAPES.map(([k]) => k);
const HEX = /^#[0-9a-f]{6}$/i;
export const fmtMark = (n) => String(+Number(n || 0).toFixed(2));

// Where the text sits in each shape (dy × radius) and how big it is (fs × radius)
export const SHAPE_TEXT = {
  circle: { dy: 0.06, fs: 1 }, square: { dy: 0.06, fs: 1 }, hexagon: { dy: 0.06, fs: 0.95 },
  diamond: { dy: 0.06, fs: 0.8 }, triangle: { dy: 0.35, fs: 0.7 }, star: { dy: 0.1, fs: 0.6 },
};
export const textSize = (text, shape) => {
  const t = String(text || "");
  return (t.length > 3 ? 0.62 : t.length > 2 ? 0.78 : 1) * (SHAPE_TEXT[shape] || SHAPE_TEXT.circle).fs;
};

const DEFAULT_SETS = [{
  id: "wr_units", name: "Wrinkle relaxer units", type: "number", unit: "units",
  values: [0.5, 1, 2, 3, 4, 5, 10].map((v, i) => ({ v, colour: MARK_COLOURS[i % MARK_COLOURS.length], shape: "circle" })),
  tagMarks: false, tags: ["Treatment", "Touch-up"],
}];

export function cleanSet(s = {}, i = 0) {
  const type = s.type === "label" ? "label" : "number";
  const seen = new Set();
  const colourOf = (x, j) => (HEX.test((x && x.colour) || "") ? x.colour.toLowerCase() : MARK_COLOURS[j % MARK_COLOURS.length]);
  const shapeOf = (x) => (SHAPE_KEYS.includes(x && x.shape) ? x.shape : "circle");
  const raw = Array.isArray(s.values) ? s.values : [];
  const values = type === "label"
    ? raw.map((x, j) => ({
        code: String((x && x.code) || "").trim().slice(0, 5),
        name: String((x && x.name) || "").trim().slice(0, 40),
        colour: colourOf(x, j), shape: shapeOf(x),
      }))
      .filter((x) => x.code && !seen.has(x.code.toLowerCase()) && seen.add(x.code.toLowerCase()))
      .slice(0, 12)
    : raw.map((x, j) => ({ v: Math.round(Number(x && x.v) * 100) / 100, colour: colourOf(x, j), shape: shapeOf(x) }))
      .filter((x) => Number.isFinite(x.v) && x.v > 0 && x.v <= 1000 && !seen.has(x.v) && seen.add(x.v))
      .sort((a, b) => a.v - b.v)
      .slice(0, 20);
  const tags = (Array.isArray(s.tags) ? s.tags : [])
    .map((t) => String(t || "").trim().slice(0, 30)).filter(Boolean).slice(0, 4);
  return {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(s.id || "") ? s.id : `ms_${i}`,
    name: String(s.name || "").trim().slice(0, 60),
    type,
    unit: type === "label" ? "" : String(s.unit || "").trim().slice(0, 20),
    values,
    tagMarks: type === "number" && s.tagMarks === true,
    tags: tags.length ? tags : ["Treatment", "Touch-up"],
  };
}

/* ---------- Shapes: drawn on the picture (canvas) and shown in buttons (SVG) ---------- */

export function traceShape(g, shape, x, y, r) {
  g.beginPath();
  const poly = (pts) => { pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); };
  const ring = (n, rot, rr, dy = 0) => Array.from({ length: n }, (_, i) => {
    const a = rot + i * 2 * Math.PI / n;
    return [x + rr * Math.cos(a), y + dy + rr * Math.sin(a)];
  });
  switch (shape) {
    case "square": {
      const s = r * 0.88;
      if (g.roundRect) g.roundRect(x - s, y - s, 2 * s, 2 * s, r * 0.2); else g.rect(x - s, y - s, 2 * s, 2 * s);
      break;
    }
    case "diamond": poly(ring(4, -Math.PI / 2, r * 1.18)); break;
    case "triangle": poly(ring(3, -Math.PI / 2, r * 1.3, r * 0.2)); break;
    case "hexagon": poly(ring(6, 0, r * 1.06)); break;
    case "star": poly(Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const rr = i % 2 ? r * 0.62 : r * 1.3;
      return [x + rr * Math.cos(a), y + rr * Math.sin(a)];
    })); break;
    default: g.arc(x, y, r, 0, Math.PI * 2);
  }
}

export function shapeSvg(shape, colour, text = "", { size = 30, outline = false } = {}) {
  const r = 12, c = 20;
  const col = HEX.test(colour || "") ? colour : "#4b5563";
  const pts = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const ring = (n, rot, rr, dy = 0) => Array.from({ length: n }, (_, i) => {
    const a = rot + i * 2 * Math.PI / n;
    return [c + rr * Math.cos(a), c + dy + rr * Math.sin(a)];
  });
  let el;
  switch (shape) {
    case "square": el = `<rect x="${c - r * 0.88}" y="${c - r * 0.88}" width="${r * 1.76}" height="${r * 1.76}" rx="${r * 0.2}"/>`; break;
    case "diamond": el = `<polygon points="${pts(ring(4, -Math.PI / 2, r * 1.18))}"/>`; break;
    case "triangle": el = `<polygon points="${pts(ring(3, -Math.PI / 2, r * 1.3, r * 0.2))}"/>`; break;
    case "hexagon": el = `<polygon points="${pts(ring(6, 0, r * 1.06))}"/>`; break;
    case "star": el = `<polygon points="${pts(Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const rr = i % 2 ? r * 0.62 : r * 1.3;
      return [c + rr * Math.cos(a), c + rr * Math.sin(a)];
    }))}"/>`; break;
    default: el = `<circle cx="${c}" cy="${c}" r="${r}"/>`;
  }
  const t = String(text || "");
  const st = SHAPE_TEXT[shape] || SHAPE_TEXT.circle;
  return `<svg class="ms-shape" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">` +
    `<g fill="${outline ? "#fff" : col}" stroke="${outline ? col : "#fff"}" stroke-width="2" stroke-linejoin="round">${el}</g>` +
    (t ? `<text x="${c}" y="${(c + r * st.dy).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif"` +
      ` font-weight="700" font-size="${(r * textSize(t, shape)).toFixed(1)}" fill="${outline ? col : "#fff"}">${esc(t)}</text>` : "") +
    "</svg>";
}

/* ---------- Loading and saving ---------- */

let cache = null;
export async function listMarkingSets({ force = false } = {}) {
  if (cache && !force) return cache;
  const snap = await getDoc(doc(db, "form_settings", "marking_sets"));
  const raw = snap.exists() && Array.isArray(snap.data().sets) ? snap.data().sets : DEFAULT_SETS;
  cache = raw.map(cleanSet);
  return cache;
}

export async function saveMarkingSets(sets, staff) {
  const clean = sets.map(cleanSet);
  await setDoc(doc(db, "form_settings", "marking_sets"), {
    sets: clean, updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120),
  });
  cache = clean;
  return clean;
}

// "Total 1.2 mL · 9 marks · Treatment 1 · Depth: SD 0.8 (5), PO 0.4 (4)" (or "" when there are no marks)
export function markSummary(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.marks) || !v.marks.length) return "";
  const n = v.marks.length;
  const hasTotal = typeof v.total === "number";
  const parts = [];
  if (hasTotal) parts.push(`Total ${fmtMark(v.total)}${v.unit ? ` ${v.unit}` : ""}`);
  parts.push(`${n} mark${n === 1 ? "" : "s"}`);
  const tags = v.byTag && typeof v.byTag === "object" ? Object.entries(v.byTag).filter(([, x]) => Number(x) > 0) : [];
  tags.forEach(([t, x]) => parts.push(`${t} ${fmtMark(x)}`));
  (Array.isArray(v.labelSets) ? v.labelSets : []).forEach((ls) => {
    const counts = (Array.isArray(ls.counts) ? ls.counts : []).filter((c) => Number(c.n) > 0);
    if (!counts.length) return;
    parts.push(`${ls.name}: ${counts.map((c) => (hasTotal
      ? `${c.code} ${fmtMark(c.total)} (${c.n})` : `${c.code} × ${c.n}`)).join(", ")}`);
  });
  return parts.join(" · ");
}

/* ---------- Managing the sets (Form Builder) ---------- */

// Resolves with the saved sets, or null if cancelled
export async function openMarkingSetsDialog({ staff } = {}) {
  let sets;
  try {
    sets = JSON.parse(JSON.stringify(await listMarkingSets({ force: true })));
  } catch (err) {
    console.error("Marking sets failed:", err);
    showToast("Couldn't load the marking sets. Try again.");
    return null;
  }
  return new Promise((resolve) => {
    let result = null;
    let busy = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog ms-dlg";
    dlg.innerHTML = `
      <form class="lh-form" novalidate>
        <div class="lh-dialog-head"><h3>Marking sets</h3>
          <p>What staff tap onto a picture. <strong>Numbers</strong> add up to a total (units, mL). <strong>Labels</strong> are codes that
            are counted, like depth of placement (SD, PO). A picture can use one number set plus any label sets, and each mark combines them.
            Shared by every form; forms already saved keep their own marks.</p></div>
        <div class="ms-list" data-role="list"></div>
        <button type="button" class="hx-add" data-act="ms-new">+ New marking set</button>
        <p class="lh-error" role="alert" hidden></p>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
          <button type="submit" class="lh-btn is-primary">Save</button>
        </div>
      </form>`;
    const list = dlg.querySelector('[data-role="list"]');
    const err = dlg.querySelector(".lh-error");
    const textOf = (s, x) => (s.type === "label" ? x.code || "" : x.v === "" || x.v === null || x.v === undefined ? "" : fmtMark(x.v));

    const shapeSel = (cur) => `<select class="fb-select ms-shape-sel" data-vk="shape" aria-label="Shape">${MARK_SHAPES.map(([k, l]) =>
      `<option value="${k}"${k === cur ? " selected" : ""}>${l}</option>`).join("")}</select>`;
    const valHtml = (s, x, j) => {
      const label = s.type === "label";
      return `<span class="ms-val${label ? " is-label" : ""}" data-v="${j}">
        <span class="ms-prev">${shapeSvg(x.shape || "circle", x.colour, textOf(s, x), { size: 30 })}</span>
        <input type="color" data-vk="colour" value="${esc(x.colour)}" aria-label="Colour" />
        ${shapeSel(x.shape || "circle")}
        ${label
          ? `<input class="fe-input ms-code" data-vk="code" maxlength="5" placeholder="SD" value="${esc(x.code || "")}" aria-label="Code" />
             <input class="fe-input ms-name" data-vk="name" maxlength="40" placeholder="Meaning (optional)" value="${esc(x.name || "")}" aria-label="Meaning" />`
          : `<input class="fe-input" type="number" min="0" step="any" data-vk="v" value="${x.v ?? ""}" aria-label="Value" />`}
        <button type="button" class="hx-x" data-vdel aria-label="Remove this value">×</button>
      </span>`;
    };
    const setHtml = (s, i) => {
      const label = s.type === "label";
      return `
      <section class="ms-set" data-set="${i}">
        <div class="ms-head${label ? " is-label" : ""}">
          <input class="fe-input" data-sk="name" maxlength="60" placeholder="${label ? "e.g. Depth of placement" : "e.g. Wrinkle relaxer units"}" value="${esc(s.name)}" aria-label="Name" />
          ${label ? "" : `<input class="fe-input" data-sk="unit" maxlength="20" placeholder="units" value="${esc(s.unit)}" aria-label="Unit" />`}
          <button type="button" class="hx-x" data-setdel aria-label="Delete this marking set" title="Delete">×</button>
        </div>
        <div class="fe-seg ms-type">${[["number", "Numbers (add up)"], ["label", "Labels (e.g. SD, PO)"]].map(([v, l]) =>
          `<label class="fe-seg-btn"><input type="radio" name="ms-type-${i}" data-sk="type" value="${v}"${s.type === v ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
        <div class="ms-vals">${s.values.map((x, j) => valHtml(s, x, j)).join("")}
          <button type="button" class="hx-add" data-vadd>+ ${label ? "Label" : "Value"}</button>
        </div>
        ${label ? "" : `<label class="fe-check"><input type="checkbox" data-sk="tagMarks"${s.tagMarks ? " checked" : ""} /> Tag each mark (e.g. Treatment or Touch-up)</label>
        ${s.tagMarks ? `<label class="lh-field"><span class="lh-label">Tags, separated by commas (the first is the default)</span>
          <input class="fe-input" data-sk="tags" maxlength="120" placeholder="Treatment, Touch-up" value="${esc(s.tags.join(", "))}" /></label>` : ""}`}
      </section>`;
    };
    const draw = () => {
      list.innerHTML = sets.length ? sets.map(setHtml).join("") : '<p class="tb-none">No marking sets yet.</p>';
    };
    draw();

    dlg.addEventListener("input", (e) => {
      const t = e.target;
      const box = t.closest("[data-set]");
      if (!box) return;
      const s = sets[Number(box.dataset.set)];
      if (t.dataset.sk === "type") {
        if (s.type !== t.value) {
          s.type = t.value;
          s.tagMarks = false;
          s.values = t.value === "label"
            ? [{ code: "", name: "", colour: MARK_COLOURS[0], shape: "circle" }]
            : [{ v: 1, colour: MARK_COLOURS[0], shape: "circle" }];
        }
        draw();
        return;
      }
      if (t.dataset.sk === "tagMarks") { s.tagMarks = t.checked; draw(); return; }
      if (t.dataset.sk === "tags") { s.tags = t.value.split(",").map((x) => x.trim()).filter(Boolean); return; }
      if (t.dataset.sk) { s[t.dataset.sk] = t.value; return; }
      const vb = t.closest("[data-v]");
      if (!vb || !t.dataset.vk) return;
      const x = s.values[Number(vb.dataset.v)];
      x[t.dataset.vk] = t.value;
      const prev = vb.querySelector(".ms-prev");
      if (prev) prev.innerHTML = shapeSvg(x.shape || "circle", x.colour, textOf(s, x), { size: 30 });
    });

    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]')) { if (!busy) dlg.close(); return; }
      if (e.target.closest('[data-act="ms-new"]')) {
        sets.push({ id: `ms_${Date.now().toString(36)}`, name: "", type: "number", unit: "units",
          values: [{ v: 1, colour: MARK_COLOURS[0], shape: "circle" }], tagMarks: false, tags: ["Treatment", "Touch-up"] });
        draw();
        const names = list.querySelectorAll('[data-sk="name"]');
        if (names.length) names[names.length - 1].focus();
        return;
      }
      const box = e.target.closest("[data-set]");
      if (!box) return;
      const s = sets[Number(box.dataset.set)];
      if (e.target.closest("[data-setdel]")) { sets.splice(Number(box.dataset.set), 1); draw(); return; }
      if (e.target.closest("[data-vadd]")) {
        const colour = MARK_COLOURS[s.values.length % MARK_COLOURS.length];
        s.values.push(s.type === "label" ? { code: "", name: "", colour, shape: "circle" } : { v: "", colour, shape: "circle" });
        draw();
        const inputs = list.querySelectorAll(`[data-set="${box.dataset.set}"] [data-vk="${s.type === "label" ? "code" : "v"}"]`);
        if (inputs.length) inputs[inputs.length - 1].focus();
        return;
      }
      const vd = e.target.closest("[data-vdel]");
      if (vd) { s.values.splice(Number(vd.closest("[data-v]").dataset.v), 1); draw(); }
    });

    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const clean = sets.map(cleanSet);
      const noName = clean.find((s) => !s.name);
      const empty = clean.find((s) => !s.values.length);
      const bad = noName ? "Give every marking set a name."
        : empty ? (empty.type === "label" ? `“${empty.name}” needs at least one label code (e.g. SD).`
          : `“${empty.name}” needs at least one value above 0.`) : "";
      if (bad) { err.textContent = bad; err.hidden = false; return; }
      err.hidden = true;
      busy = true;
      const btn = dlg.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        result = await saveMarkingSets(clean, staff);
        busy = false;
        dlg.close();
        showToast("Marking sets saved");
      } catch (ex) {
        console.error("Save marking sets failed:", ex);
        busy = false;
        err.textContent = ex && ex.code === "permission-denied"
          ? "You don't have access. Check the marking_sets Firestore rule has been published."
          : "Couldn't save. Try again.";
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Save";
      }
    });

    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}