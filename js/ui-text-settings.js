// System configuration → Wording: every label and instruction Admins have changed in the portal's windows.
import { loadUiTextAll, saveUiText } from "./ui-text.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SCOPES = { inv: "Inventory windows", ui: "Other windows" };
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
};
const errText = (err) => (err && err.code === "permission-denied"
  ? "Only Admins can change wording. Check the ui_settings Firestore rule has been published."
  : "Couldn't save. Try again.");

export async function renderUiTextSettings(body, { staff } = {}) {
  body.innerHTML = '<div class="skeleton" style="height:240px;border-radius:14px"></div>';
  let data;
  try {
    data = await loadUiTextAll();
  } catch (err) {
    console.error("Wording failed:", err);
    if (body.isConnected) body.innerHTML = '<div class="tm-empty is-error">Couldn\'t load the wording. Try again.</div>';
    return;
  }
  if (!body.isConnected) return;

  const st = { q: "", editing: "" };
  body.innerHTML = `
    <section class="tb-card">
      <h4>Edited wording</h4>
      <p class="muted ps-note">Labels and instructions Admins have changed in the portal's windows. Everyone sees the new wording.
        To change more, open the window (for example a product in Inventory) and click <strong>✎ Edit wording</strong> at the bottom.</p>
      <div class="inv-tools">
        <label class="ib-search inv-find">${SEARCH}<input type="search" data-ut-q placeholder="Search wording or windows" aria-label="Search wording" /></label>
        <span class="inv-spacer"></span>
        <span class="muted" data-role="utcount"></span>
      </div>
      <div data-role="utlist"></div>
    </section>`;
  const listEl = body.querySelector('[data-role="utlist"]');

  const entries = () => Object.keys(data.texts).map((key) => {
    const m = data.meta[key] || {};
    const scope = key.split(":")[0];
    return { key, scope, value: data.texts[key], orig: m.orig || "", where: m.where || "", by: m.by || "", at: m.at || "" };
  });

  function rowHtml(e) {
    const editing = st.editing === e.key;
    return `
      <div class="ut-row${editing ? " is-editing" : ""}" data-key="${esc(e.key)}">
        <div class="ut-main">
          <small class="ut-where">${esc(e.where || "Window not recorded")}</small>
          ${editing
            ? `<textarea class="fe-input ut-ta" maxlength="600" rows="3">${esc(e.value)}</textarea>`
            : `<p class="ut-new">${esc(e.value)}</p>`}
          <p class="ut-orig"><span>Original:</span> ${e.orig ? esc(e.orig) : "<em>not recorded (changed before this list existed)</em>"}</p>
          ${e.by || e.at ? `<small class="muted">Changed${e.by ? ` by ${esc(e.by)}` : ""}${e.at ? ` · ${esc(when(e.at))}` : ""}</small>` : ""}
        </div>
        <div class="ut-acts">${editing
          ? `<button type="button" class="lh-btn is-quiet" data-ut="cancel">Cancel</button>
             <button type="button" class="lh-btn is-primary" data-ut="save">Save</button>`
          : `<button type="button" class="lh-btn" data-ut="edit">Edit</button>
             <button type="button" class="lh-btn is-quiet" data-ut="reset">Use original</button>`}</div>
      </div>`;
  }

  function draw() {
    const q = st.q.trim().toLowerCase();
    const all = entries();
    const list = all.filter((e) => !q || `${e.value} ${e.orig} ${e.where}`.toLowerCase().includes(q))
      .sort((a, b) => a.where.localeCompare(b.where, "en-AU") || a.value.localeCompare(b.value, "en-AU"));
    body.querySelector('[data-role="utcount"]').textContent = `${all.length} change${all.length === 1 ? "" : "s"}`;
    if (!list.length) {
      listEl.innerHTML = `<div class="tm-empty">${all.length ? "Nothing matches." : "No wording has been changed yet."}</div>`;
      return;
    }
    const scopes = [...new Set(list.map((e) => e.scope))];
    listEl.innerHTML = scopes.map((s) => `
      <section class="ut-group"><h5>${esc(SCOPES[s] || s)}</h5>
        ${list.filter((e) => e.scope === s).map(rowHtml).join("")}
      </section>`).join("");
    const ta = listEl.querySelector(".ut-ta");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  draw();

  async function save(key, value) {
    const m = data.meta[key] || {};
    const v = norm(value);
    const back = !v || (m.orig && v === m.orig); // empty or same as the original: go back to it
    await saveUiText(key, back ? "" : v, staff, { orig: m.orig, where: m.where });
    if (back) { delete data.texts[key]; delete data.meta[key]; }
    else { data.texts[key] = v; data.meta[key] = { ...m, by: (staff && staff.name) || "", at: new Date().toISOString() }; }
    return back;
  }

  body.addEventListener("input", (e) => {
    if (e.target.matches("[data-ut-q]")) { st.q = e.target.value; draw(); }
  });
  body.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ut]");
    if (!b) return;
    const row = b.closest(".ut-row");
    const key = row && row.dataset.key;
    if (!key) return;
    const act = b.dataset.ut;

    if (act === "edit") { st.editing = key; draw(); return; }
    if (act === "cancel") { st.editing = ""; draw(); return; }

    if (act === "reset") {
      const m = data.meta[key] || {};
      const ok = await confirmDialog({
        title: "Go back to the original wording?",
        message: m.orig ? `It will read: “${m.orig}”` : "The window will show its original wording again.",
        confirmLabel: "Use original",
      });
      if (!ok) return;
    }

    b.disabled = true;
    try {
      const value = act === "save" ? row.querySelector(".ut-ta").value : "";
      const back = await save(key, value);
      st.editing = "";
      draw();
      showToast(back ? "Back to the original wording" : "Wording saved");
    } catch (err) {
      console.error("Save wording failed:", err);
      showToast(errText(err));
      b.disabled = false;
    }
  });
}