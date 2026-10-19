// The live form: signature pads, reading answers, which questions show, and answers as tags.
// Shared by the portal (form-fill.js) and the patient's online form (form.html), so both behave exactly the same.
import { choiceList, otherLabel, tableCols, syncChoiceExtras, readExtras, FIELD_TYPES } from "./form-fields.js";
import { conditionPasses } from "./form-conditions.js";
import { formatCalc } from "./form-calc.js";
import { fillTags, formFieldTags } from "./form-tags.js";

const LAYOUT = ["text_block", "space", "letterhead", "watermark", "button"]; // nothing is saved for these
const $all = (el, s) => [...el.querySelectorAll(s)];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => isoOf(new Date());

/* ===================== Signature pad ===================== */

export function signaturePad(host) {
  host.className = "sig-pad";
  host.innerHTML = `
    <canvas class="sig-canvas" aria-label="Signature pad. Sign with a finger, stylus or mouse"></canvas>
    <div class="sig-bar"><span>Sign above</span><button type="button" class="sig-clear">Clear</button></div>`;
  const canvas = host.querySelector("canvas");
  const g = canvas.getContext("2d");
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  let empty = true, drawing = false, last = null;

  function setup() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const keep = empty ? null : canvas.toDataURL("image/png");
    canvas.width = Math.round(r.width * scale);
    canvas.height = Math.round(r.height * scale);
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.lineWidth = 2.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = g.fillStyle = "#0f172a";
    if (keep) {
      const img = new Image();
      img.onload = () => g.drawImage(img, 0, 0, r.width, r.height);
      img.src = keep;
    }
  }
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const mark = () => {
    if (!empty) return;
    empty = false;
    host.classList.add("is-signed");
    host.dispatchEvent(new Event("input", { bubbles: true }));
  };

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    g.beginPath();
    g.arc(last.x, last.y, 1.1, 0, Math.PI * 2);
    g.fill();
    mark();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    g.beginPath();
    g.moveTo(last.x, last.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last = p;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);

  host.querySelector(".sig-clear").addEventListener("click", () => {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.restore();
    empty = true;
    host.classList.remove("is-signed");
    host.dispatchEvent(new Event("input", { bubbles: true }));
  });

  new ResizeObserver(setup).observe(canvas);
  return {
    isEmpty: () => empty,
    toDataURL: () => (empty ? "" : canvas.toDataURL("image/png")),
  };
}

/* ===================== Reading answers ===================== */

export function readField(f, w, { pads = {}, calc = {}, consent = {}, annots = {} } = {}) {
  switch (f.type) {
    case "short_text": case "long_text": case "email": case "date": case "record_date": {
      const el = w.querySelector(".fe-in");
      return el ? String(el.value || "").trim().slice(0, 5000) : "";
    }
    case "number": {
      const el = w.querySelector("input[data-in]");
      if (!el || el.value === "") return null;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : null;
    }
    case "dropdown": {
      const el = w.querySelector("select");
      return el ? el.value : "";
    }
    case "single_choice": {
      const i = $all(w, 'input[type="radio"]').findIndex((x) => x.checked);
      return i < 0 ? "" : (choiceList(f)[i] ?? "");
    }
    case "checkboxes": {
      const list = choiceList(f);
      return $all(w, 'input[type="checkbox"]').flatMap((x, i) => (x.checked ? [list[i] ?? ""] : []));
    }
    case "checkbox_notes": {
      const list = choiceList(f);
      return $all(w, ".fe-optnote").flatMap((row, i) => {
        const box = row.querySelector('input[type="checkbox"]');
        if (!box || !box.checked) return [];
        const note = row.querySelector(".fe-note-in");
        return [{ option: list[i] ?? "", note: note ? note.value.trim().slice(0, 1000) : "" }];
      });
    }
    case "sub_checks":
      return $all(w, ".fe-sub").flatMap((row, i) => {
        const boxes = $all(row, 'input[type="checkbox"]');
        if (!boxes[0] || !boxes[0].checked) return [];
        if (row.classList.contains("is-other")) {
          const o = row.querySelector("[data-other]");
          return [{ option: otherLabel(f), subs: [], other: o ? o.value.trim().slice(0, 500) : "" }];
        }
        const grp = f.groups[i] || { label: "", subs: [] };
        const subList = [...(grp.subs || []), ...(grp.other ? [otherLabel(f)] : [])];
        const out = { option: grp.label, subs: boxes.slice(1).flatMap((b, j) => (b.checked ? [subList[j] ?? ""] : [])) };
        const so = row.querySelector("[data-subother]");
        if (so && !so.hidden && so.value.trim()) out.subOther = so.value.trim().slice(0, 300);
        const notes = $all(row, "[data-subcmt]").flatMap((c) => {
          if (c.hidden || !c.value.trim()) return [];
          const s = (grp.subs || [])[Number(c.dataset.subcmt)];
          return s && out.subs.includes(s) ? [{ sub: s, note: c.value.trim().slice(0, 300) }] : [];
        });
        if (notes.length) out.subNotes = notes;
        return [out];
      });
    case "table": { // Firestore can't store lists inside lists, so each row is { cells: [...] }
      const cols = tableCols(f);
      return $all(w, "tbody tr").map((tr) => ({
        cells: cols.map((c, ci) => {
          const el = tr.querySelector(`[data-c="${ci}"]`);
          if (!el) return c.type === "check" ? false : "";
          if (c.type === "check") return el.checked;
          if (c.type === "calc") return el.dataset.v === "" || el.dataset.v === undefined ? "" : Number(el.dataset.v);
          if (c.type === "number") {
            if (el.value === "") return "";
            const n = Number(el.value);
            return Number.isFinite(n) ? n : "";
          }
          return String(el.value || "").trim().slice(0, 500);
        }),
      }));
    }
    case "calculation": {
      const v = calc[f.id];
      return Number.isFinite(v) ? v : null;
    }
    case "signature": {
      const p = pads[f.id];
      if (!p || p.isEmpty()) return "";
      const n = w.querySelector("[data-sig-name]");
      const d = w.querySelector("[data-sig-date]");
      return { signed: true, name: n ? n.value.trim().slice(0, 120) : "", date: d ? d.value : todayIso() };
    }
    case "clinician": {
      const out = {};
      const sel = w.querySelector("[data-clin-pick]");
      if (sel && sel.value) out.staffId = sel.value;
      $all(w, "[data-cpart]").forEach((el) => { out[el.dataset.cpart] = el.value.trim().slice(0, 150); });
      return Object.keys(out).some((k) => k !== "staffId" && out[k]) ? out : "";
    }
    case "patient": {
      const out = {};
      $all(w, "[data-part]").forEach((el) => { out[el.dataset.part] = el.value; });
      return out;
    }
    case "image": {
      if (f.source === "staff") return w.photoRead ? w.photoRead() : { photos: [] };
      const a = annots[f.id];
      return a && !a.isEmpty() ? { drawn: true } : "";
    }
    case "rich_text":
      return w.rtRead ? w.rtRead() : "";
    case "specialist":
      return w.spRead ? w.spRead() : "";
    case "consumables":
      return w.csRead ? w.csRead() : { lines: [] };
    case "aftercare":
      return w.acRead ? w.acRead() : { items: [] };
    case "consent_status":
    case "prescription_status":
      return consent[f.id] || { found: false, date: "", submissionId: "", name: "" };
  }
  return null;
}

// Hides / shows questions on a live page from the current answers. Returns the shown ids.
// Questions are worked out top to bottom, so each one only depends on answers above it.
export function applyVisibility(sheet, fields, ctx) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const answers = {};
  const shown = new Set();
  fields.forEach((f) => {
    const w = sheet.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
    const ok = conditionPasses(f, answers, byId, shown);
    if (ok) shown.add(f.id);
    if (!w) return;
    w.hidden = !ok;
    syncChoiceExtras(f, w);
    if (ok && !LAYOUT.includes(f.type) && f.type !== "photo") answers[f.id] = readField(f, w, ctx);
  });
  return shown;
}

export function isBlank(v) {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) {
    return v.length === 0 ||
      v.every((r) => r && Array.isArray(r.cells) && r.cells.every((c) => c === "" || c === false));
  }
  return false;
}

/* ===================== Answers as merge tags ===================== */

const tagDate = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : String(k || "");
};

// An answer as text, for its tag
export function answerTagText(f, v, x) {
  if (v === null || v === undefined || v === "") return "";
  const other = (o) => (f.allowOther && o === otherLabel(f) && x && x.other ? x.other : String(o));
  switch (f.type) {
    case "number": return `${v}${f.unit ? ` ${f.unit}` : ""}`;
    case "date": case "record_date": return tagDate(v);
    case "dropdown": case "single_choice": return other(v);
    case "checkboxes": return (Array.isArray(v) ? v : []).map(other).join(", ");
    case "calculation": return formatCalc(v, f) || "";
    case "clinician": return v && typeof v === "object" ? String(v.name || "") : "";
    default: return typeof v === "string" ? v : "";
  }
}

// Every answer's tag, then the pre-fills that use tags, top to bottom (so a chain fills in one go).
// A pre-filled box stops following once someone types in it. Form Builder's Preview uses this too.
export function fieldTagValues(sheet, fields, base, ctx) {
  const vals = { ...base };
  const owners = formFieldTags(fields);
  const ownerKey = new Map(owners.map((t) => [t.f.id, t.key]));
  const wrapOf = (f) => sheet.querySelector(`[data-fid="${CSS.escape(f.id)}"]`);
  const text = (f) => {
    const w = wrapOf(f);
    return w && !w.hidden ? answerTagText(f, readField(f, w, ctx), readExtras(f, w)) : "";
  };
  owners.forEach((t) => { vals[t.key] = text(t.f); });
  fields.forEach((f) => {
    const w = wrapOf(f);
    const el = w && w.querySelector("[data-linked]");
    if (!el || el.dataset.touched) return;
    const k = ownerKey.get(f.id);
    const v = fillTags(f.prefill, k ? { ...vals, [k]: "" } : vals, ""); // a box can't follow itself
    if (el.value !== v) el.value = v;
    if (k) vals[k] = text(f);
  });
  return vals;
}

/* ===================== Online forms: which forms patients can fill in themselves ===================== */
// The same list as PF_OK_TYPES_ in Code.gs

export const ONLINE_TYPES = ["patient", "short_text", "long_text", "email", "number", "date", "record_date", "dropdown",
  "single_choice", "checkboxes", "checkbox_notes", "sub_checks", "table", "calculation", "signature", "image",
  "text_block", "space", "letterhead", "watermark", "button"];
export const ONLINE_NO_CATS = ["treatment", "prescription"];

// What stops a form being filled in online: [] if nothing
export function onlineBlockers(fields) {
  const out = [];
  (fields || []).forEach((f) => {
    if (!f) return;
    if (!ONLINE_TYPES.includes(f.type)) out.push((FIELD_TYPES[f.type] && FIELD_TYPES[f.type].name) || "Photos");
    else if (f.type === "image" && (f.source === "staff" || f.annotate === true)) out.push("A picture staff draw on, or photos staff take");
    else if (f.type === "signature" && f.signer === "practitioner") out.push("A practitioner signature");
  });
  return [...new Set(out)];
}