// Marking sets: the values staff can place on a picture (e.g. wrinkle relaxer units 0.5, 1, 2…).
// One list in form_settings/marking_sets, shared by every form. Saved forms keep their own copy
// of each mark's value, so editing a set later never changes a saved record.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const MARK_COLOURS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#db2777", "#0891b2", "#4b5563"];
const HEX = /^#[0-9a-f]{6}$/i;
export const fmtMark = (n) => String(+Number(n || 0).toFixed(2));

const DEFAULT_SETS = [{
  id: "wr_units", name: "Wrinkle relaxer units", unit: "units",
  values: [0.5, 1, 2, 3, 4, 5, 10].map((v, i) => ({ v, colour: MARK_COLOURS[i % MARK_COLOURS.length] })),
  tagMarks: false, tags: ["Treatment", "Touch-up"],
}];

export function cleanSet(s = {}, i = 0) {
  const seen = new Set();
  const values = (Array.isArray(s.values) ? s.values : [])
    .map((x, j) => ({
      v: Math.round(Number(x && x.v) * 100) / 100,
      colour: HEX.test((x && x.colour) || "") ? x.colour.toLowerCase() : MARK_COLOURS[j % MARK_COLOURS.length],
    }))
    .filter((x) => Number.isFinite(x.v) && x.v > 0 && x.v <= 1000 && !seen.has(x.v) && seen.add(x.v))
    .sort((a, b) => a.v - b.v)
    .slice(0, 20);
  const tags = (Array.isArray(s.tags) ? s.tags : [])
    .map((t) => String(t || "").trim().slice(0, 30)).filter(Boolean).slice(0, 4);
  return {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(s.id || "") ? s.id : `ms_${i}`,
    name: String(s.name || "").trim().slice(0, 60),
    unit: String(s.unit || "").trim().slice(0, 20),
    values,
    tagMarks: s.tagMarks === true,
    tags: tags.length ? tags : ["Treatment", "Touch-up"],
  };
}

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

// "Total 23.5 units · 9 marks · Treatment 20 · Touch-up 3.5" (or "" when there are no marks)
export function markSummary(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.marks) || !v.marks.length) return "";
  const n = v.marks.length;
  const tags = v.byTag && typeof v.byTag === "object" ? Object.entries(v.byTag).filter(([, x]) => Number(x) > 0) : [];
  return `Total ${fmtMark(v.total)}${v.unit ? ` ${v.unit}` : ""} · ${n} mark${n === 1 ? "" : "s"}${
    tags.length ? ` · ${tags.map(([t, x]) => `${t} ${fmtMark(x)}`).join(" · ")}` : ""}`;
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
          <p>The values staff tap onto a picture, like wrinkle relaxer units. Shared by every form. Forms already saved keep their own marks.</p></div>
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

    const setHtml = (s, i) => `
      <section class="ms-set" data-set="${i}">
        <div class="ms-head">
          <input class="fe-input" data-sk="name" maxlength="60" placeholder="e.g. Wrinkle relaxer units" value="${esc(s.name)}" aria-label="Name" />
          <input class="fe-input" data-sk="unit" maxlength="20" placeholder="units" value="${esc(s.unit)}" aria-label="Unit" />
          <button type="button" class="hx-x" data-setdel aria-label="Delete this marking set" title="Delete">×</button>
        </div>
        <div class="ms-vals">${s.values.map((x, j) => `
          <span class="ms-val" data-v="${j}">
            <input type="color" data-vk="colour" value="${esc(x.colour)}" aria-label="Colour" />
            <input class="fe-input" type="number" min="0" step="any" data-vk="v" value="${x.v ?? ""}" aria-label="Value" />
            <button type="button" class="hx-x" data-vdel aria-label="Remove this value">×</button>
          </span>`).join("")}
          <button type="button" class="hx-add" data-vadd>+ Value</button>
        </div>
        <label class="fe-check"><input type="checkbox" data-sk="tagMarks"${s.tagMarks ? " checked" : ""} /> Tag each mark (e.g. Treatment or Touch-up)</label>
        ${s.tagMarks ? `<label class="lh-field"><span class="lh-label">Tags, separated by commas (the first is the default)</span>
          <input class="fe-input" data-sk="tags" maxlength="120" placeholder="Treatment, Touch-up" value="${esc(s.tags.join(", "))}" /></label>` : ""}
      </section>`;
    const draw = () => {
      list.innerHTML = sets.length ? sets.map(setHtml).join("") : '<p class="tb-none">No marking sets yet.</p>';
    };
    draw();

    dlg.addEventListener("input", (e) => {
      const t = e.target;
      const box = t.closest("[data-set]");
      if (!box) return;
      const s = sets[Number(box.dataset.set)];
      if (t.dataset.sk === "tagMarks") { s.tagMarks = t.checked; draw(); return; }
      if (t.dataset.sk === "tags") { s.tags = t.value.split(",").map((x) => x.trim()).filter(Boolean); return; }
      if (t.dataset.sk) { s[t.dataset.sk] = t.value; return; }
      const vb = t.closest("[data-v]");
      if (vb && t.dataset.vk) s.values[Number(vb.dataset.v)][t.dataset.vk] = t.value;
    });

    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]')) { if (!busy) dlg.close(); return; }
      if (e.target.closest('[data-act="ms-new"]')) {
        sets.push({ id: `ms_${Date.now().toString(36)}`, name: "", unit: "units",
          values: [{ v: 1, colour: MARK_COLOURS[0] }], tagMarks: false, tags: ["Treatment", "Touch-up"] });
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
        s.values.push({ v: "", colour: MARK_COLOURS[s.values.length % MARK_COLOURS.length] });
        draw();
        const vals = list.querySelectorAll(`[data-set="${box.dataset.set}"] [data-vk="v"]`);
        if (vals.length) vals[vals.length - 1].focus();
        return;
      }
      const vd = e.target.closest("[data-vdel]");
      if (vd) { s.values.splice(Number(vd.closest("[data-v]").dataset.v), 1); draw(); }
    });

    dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dlg.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const clean = sets.map(cleanSet);
      const bad = clean.find((s) => !s.name) ? "Give every marking set a name."
        : (clean.find((s) => !s.values.length) ? `“${clean.find((s) => !s.values.length).name}” needs at least one value above 0.` : "");
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