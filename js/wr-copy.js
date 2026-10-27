// "Copy and create new" for old-app Wrinkle Relaxer records (wr_treatment_record).
// Layout: treatment_details_map[] (one per vial) → Areas[] (Area, Type, Markers[]) → Markers[] { Area, Units, X, Y },
// with X / Y as a percentage of that area's picture. Only the markings are copied: batch, expiry, vial and answers are today's.
import { db } from "./firebase-config.js";
import { doc, getDoc, getDocs, collection, query, where, limit, FieldPath } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { listPublishedForms, getFormVersion } from "./form-templates.js";
import { listMarkingSets } from "./marking-sets.js";
import { markSetIdsOf, iqHasOptions } from "./form-fields.js";
import { showToast } from "./utils.js";

const COPY_KEY = "dm.copyInto";   // read once by form-fill.js (takeCopy)
const WR_FORM_RE = /wrinkle|relaxer|anti[\s-]?wrinkle|toxin|botox|xeomin|dysport|letybo/i;

const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const letters = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");   // "Touch-up" = "Touchup"
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const list = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);
const clamp = (n) => Math.max(0, Math.min(1, n));
const fmt = (n) => String(+Number(n || 0).toFixed(2));

// Other names an old-app area might go by on the portal form. Add to these as needed.
const ALIASES = {
  "forehead": ["frontalis"],
  "frown": ["glabella", "frown lines"],
  "crows feet": ["crows", "lateral canthal"],
  "dao chin": ["dao", "chin", "mentalis"],
  "bunny lines": ["nasalis", "nose"],
  "lip flip": ["lip", "orbicularis"],
  "masseter": ["jaw", "masseters"],
  "neck": ["platysma"],
};

// Only needed if a portal picture isn't the same image file as the old app's:
// where the old picture starts (x0, y0) and how much of it is used (xs, ys), all 0 to 1.
const ADJUST = {
  // "forehead": { x0: 0.094, y0: 0.085, xs: 0.823, ys: 0.859 },
};

/* ---------- Reading the old record ---------- */

export function oldWrPoints(d) {
  const out = [];
  list(d && d.treatment_details_map).forEach((vial) => {
    list(vial && vial.Areas).forEach((a) => {
      const area = String((a && a.Area) || "").trim();
      const type = String((a && a.Type) || "").trim();
      list(a && a.Markers).forEach((m) => {
        const x = num(m && m.X), y = num(m && m.Y);
        if (x === null || y === null) return;
        out.push({ area: String(m.Area || area).trim(), units: num(m.Units) || 0, x, y, type });
      });
    });
  });
  return out;
}

export function oldWrTotal(d) {
  const said = list(d && d.treatment_details_map).map((v) => num(v && v["Total Units"])).filter((n) => n !== null);
  return said.length ? said.reduce((a, n) => a + n, 0) : null;
}

export function wrCopyLabel(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String((d && d["Record Date"]) || ""));
  const when = m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
  return `the old app's record${when ? ` on ${when}` : ""}${d && d.Staff ? ` by ${d.Staff}` : ""}`;
}

/* ---------- Matching areas to the portal form's pictures ---------- */

const picsOf = (fields) => (fields || []).filter((f) => f && f.type === "image" && f.source !== "staff" && f.annotate && f.markMode === "marks");

function pictureFor(area, pics) {
  const a = norm(area);
  const words = [a, ...(ALIASES[a] || [])];
  const nameOf = (f) => norm(`${f.label || ""} ${f.fileName || ""}`);
  return pics.find((f) => norm(f.label) === a)
    || pics.find((f) => words.some((w) => w && nameOf(f).includes(w)))
    || pics.find((f) => a.split(" ").some((w) => w.length > 3 && nameOf(f).includes(w)))
    || null;
}

function place(area, x, y) {
  const k = ADJUST[norm(area)];
  const px = x / 100, py = y / 100;
  return k ? { x: clamp((px - k.x0) / k.xs), y: clamp((py - k.y0) / k.ys) } : { x: clamp(px), y: clamp(py) };
}

// Can this picture keep the area's Treatment / Touch-up? On the marks (tagged set), or in a question under the picture.
function typeHome(f, type, sets) {
  if (!type) return { ok: true };
  const t = letters(type);
  const tagged = markSetIdsOf(f).map((id) => sets.find((s) => s.id === id)).filter(Boolean)
    .some((s) => s.type !== "label" && s.tagMarks && (s.tags || []).some((x) => letters(x) === t));
  if (tagged) return { ok: true };
  for (const q of f.questions || []) {
    if (!iqHasOptions(q)) continue;
    const opt = (q.options || []).find((o) => letters(o) === t);
    if (opt) return { ok: true, q: { id: q.id, label: q.label, value: opt, ...(q.type === "checks" ? { values: [opt] } : {}) } };
  }
  return { ok: false };
}

// What form-fill.js needs: { marks: { fieldId: [...] }, imageQs: { fieldId: [...] }, notes }
export function buildWrCopy(d, fields, sets = []) {
  const pics = picsOf(fields);
  const points = oldWrPoints(d);
  const marks = {}, imageQs = {}, missing = new Map(), lostType = new Set(), typed = new Set();

  points.forEach((p) => {
    const f = pictureFor(p.area, pics);
    if (!f) {
      const m = missing.get(p.area) || { n: 0, units: 0 };
      m.n++; m.units += p.units;
      missing.set(p.area, m);
      return;
    }
    (marks[f.id] = marks[f.id] || []).push({ ...place(p.area, p.x, p.y), v: p.units, tag: p.type });
    if (p.type && !typed.has(f.id)) {
      typed.add(f.id);
      const h = typeHome(f, p.type, sets);
      if (h.q) imageQs[f.id] = [h.q];
      if (!h.ok) lostType.add(`${p.area} (${p.type})`);
    }
  });

  const notes = [];
  missing.forEach((m, area) => notes.push(
    `${area}: ${m.n} mark${m.n === 1 ? "" : "s"} (${fmt(m.units)} units) weren't copied, because this form has no ${area} picture.`));
  if (lostType.size) notes.push(`Treatment / Touch-up wasn't copied for ${[...lostType].join(", ")}. `
    + "Turn on “Tag each mark” in Form Builder → Marking sets, or set it on the form.");
  const total = points.reduce((a, p) => a + p.units, 0);
  const said = oldWrTotal(d);
  if (said !== null && Math.abs(said - total) > 0.001) {
    notes.push(`The old record says ${fmt(said)} units in total, but its marks add up to ${fmt(total)}. Check the areas.`);
  }
  if (!points.length) notes.push("The old record has no marks to copy.");
  return { marks, imageQs, notes, total };
}

/* ---------- The button ---------- */

async function readOld(record) {
  if (record && typeof record === "object" && record.treatment_details_map) return record;
  const id = String((typeof record === "string" ? record : record && (record.recordId || record.id)) || "").trim();
  if (!id) return null;
  const snap = await getDoc(doc(db, "wr_treatment_record", id));
  if (snap.exists()) return snap.data();
  const found = await getDocs(query(collection(db, "wr_treatment_record"),
    where(new FieldPath("Record ID"), "==", id), limit(1)));
  return found.empty ? null : found.docs[0].data();
}

// The published Wrinkle Relaxer treatment record whose pictures match the most old areas
async function pickForm(old) {
  const forms = (await listPublishedForms()).filter((t) => t.category === "treatment" && WR_FORM_RE.test(t.name));
  const areas = [...new Set(oldWrPoints(old).map((p) => p.area))];
  let best = null, score = -1;
  for (const t of forms) {
    const ver = await getFormVersion(t.id, t.version).catch(() => null);
    if (!ver) continue;
    const pics = picsOf(ver.fields);
    const s = areas.filter((a) => pictureFor(a, pics)).length;
    if (s > score) { best = { t, ver }; score = s; }
  }
  return best;
}

// record: the old Firestore document (or its id). Opens the portal form in a new tab with the marks in place.
export async function copyOldWrRecord({ patientId, record }) {
  // Opened now, while it still counts as a click, so the browser doesn't block it
  const tab = window.open("", "_blank");
  const fail = (msg) => { if (tab) tab.close(); showToast(msg); };
  try {
    const old = await readOld(record);
    if (!old) { fail("This record's markings couldn't be found in the old app's data."); return; }
    const [pick, sets] = await Promise.all([pickForm(old), listMarkingSets().catch(() => [])]);
    if (!pick) { fail("There's no published Wrinkle Relaxer treatment record. Publish one in Form Builder first."); return; }
    const c = buildWrCopy(old, pick.ver.fields, sets);
    localStorage.setItem(COPY_KEY, JSON.stringify({
      p: patientId, t: pick.t.id, at: Date.now(), fromLabel: wrCopyLabel(old),
      marks: c.marks, imageQs: c.imageQs, answers: {}, notes: c.notes,
    }));
    const hash = `#/fill/${encodeURIComponent(patientId)}/${encodeURIComponent(pick.t.id)}`;
    if (tab) tab.location.href = `${location.pathname}${location.search}${hash}`;
    else location.hash = hash;
  } catch (err) {
    console.error("Copy and create new failed:", err);
    fail(err && err.code === "permission-denied" ? "You don't have access to that record." : "Couldn't copy the record. Try again.");
  }
}