// System configuration → Browser tabs: the icon, colour and name of each kind of browser tab,
// so staff can tell their open tabs apart at a glance. Admins only.
// Saved in ui_settings/tabs as { kinds: { "menu:calendar": { icon, text, bg, bg2, title }, tx: {...} } }.
// Only what's been changed from the standard is kept.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { escapeHtml, showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";
import { TAB_PRESETS, TAB_COLOURS, TAB_RECORD_KINDS, tabSpecOf, tabIconUrl, fillTabTitle, cleanTabKinds, applyTabSettings }
  from "./tab-icon.js";

const esc = (s) => escapeHtml(String(s ?? ""));
const VAR_LABEL = { Page: "Page name", Patient: "Patient's name", Form: "Form name", Time: "Recording time" };
const SYMBOLS = ["●", "✓", "⚠", "⏸", "★", "📝", "🎙"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A darker shade, for "Blend into a second colour"
function darker(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.round(v * 0.72)).toString(16).padStart(2, "0");
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`.toUpperCase();
}
const initials = (label) => String(label || "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "A";

export async function mountTabSettings(host, { staff = null } = {}) {
  if (!/^admin$/i.test(String((staff && staff.role) || ""))) {
    host.innerHTML = '<p class="sds-empty">Only Admins can change the browser tabs.</p>';
    return;
  }
  host.innerHTML = '<div class="skeleton" style="height:420px;border-radius:14px"></div>';

  // The pages in the menu on the left, in the same order, each with its own icon
  const seen = new Set();
  const menu = [...document.querySelectorAll(".nav-item[data-page]")].map((a) => {
    const label = ((a.querySelector(".nav-label") || a).textContent || "").trim();
    return { key: `menu:${a.dataset.page}`, label, desc: "Menu page", svg: a.querySelector("svg"),
      vars: ["Page"], sample: { page: label }, group: "menu" };
  }).filter((x) => x.label && x.svg && /^menu:[a-z0-9-]{1,40}$/.test(x.key) && !seen.has(x.key) && seen.add(x.key));
  const patientsSvg = (menu.find((m) => m.key === "menu:patients") || {}).svg || null;
  const kinds = TAB_RECORD_KINDS.map((k) => ({ ...k, group: k.group || "records", svg: k.menuIcon === "patients" ? patientsSvg : null }));
  const records = kinds.filter((k) => k.group === "records");
  const consults = kinds.filter((k) => k.group === "consult");
  const items = [...menu, ...records, ...consults];

  const st = { kinds: {}, open: "", dirty: false, saving: false, savedBy: "", savedAt: null };
  try {
    const snap = await getDoc(doc(db, "ui_settings", "tabs"));
    if (snap.exists()) {
      const d = snap.data() || {};
      st.kinds = cleanTabKinds(d.kinds);
      st.savedBy = String(d.updatedBy || "");
      st.savedAt = d.updatedAt && d.updatedAt.toDate ? d.updatedAt.toDate() : null;
    }
  } catch (err) {
    console.error("Tab settings failed:", err);
    host.innerHTML = '<p class="sds-empty">The browser tab settings couldn\'t be loaded. Check your connection and try again.</p>';
    return;
  }

  const item = (key) => items.find((i) => i.key === key);
  const spec = (key) => tabSpecOf(key, st.kinds);
  const isChanged = (key) => !same(spec(key), tabSpecOf(key, {}));
  const titleOf = (it, s) => fillTabTitle(s.title, it.sample, it.label);
  const menuKey = (it) => (it.group === "menu" ? it.key.slice(5) : it.key);
  const iconOf = (it, s) => tabIconUrl(s, it.svg, menuKey(it));
  const lettersFor = (it, s) => s.text || initials(it.label);
  const set = (key, patch) => { st.kinds[key] = { ...spec(key), ...patch }; st.dirty = true; status(); };

  function status() {
    const el = host.querySelector(".sds-status");
    if (!el) return;
    el.className = "sds-status" + (st.dirty ? " is-dirty" : "");
    el.textContent = st.dirty ? "Unsaved changes"
      : st.savedAt ? `Saved${st.savedBy ? ` by ${st.savedBy}` : ""} · ${st.savedAt.toLocaleString("en-AU",
        { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`
      : "The standard tabs (nothing changed yet)";
  }

  const tabChip = (it, s, pv = true) => `<span class="tbs-tab${pv ? " is-on" : " is-dim"}">
      <img alt=""${pv ? " data-pv-icon" : ""} src="${iconOf(it, s)}">
      <span${pv ? " data-pv-title" : ""}>${esc(titleOf(it, s))}</span><i aria-hidden="true">×</i></span>`;

  function editorHtml(it, s) {
    const i = items.indexOf(it);
    const before = items[(i - 1 + items.length) % items.length];
    const after = items[(i + 1) % items.length];
    const tile = (icon, label) => {
      const t = { ...s, icon, text: icon === "letters" ? lettersFor(it, s) : s.text };
      const on = s.icon === icon;
      return `<button type="button" class="tbs-ic${on ? " is-on" : ""}" data-icon="${icon}" aria-pressed="${on}" title="${esc(label)}">
        <img alt="" data-tile="${icon}" src="${tabIconUrl(t, it.svg, menuKey(it))}"><span>${esc(label)}</span></button>`;
    };
    return `<div class="tbs-editor">
      <div class="tbs-preview" aria-label="Preview">
        <div class="tbs-strip">${tabChip(before, spec(before.key), false)}${tabChip(it, s)}${tabChip(after, spec(after.key), false)}</div>
        <div class="tbs-bar"></div>
      </div>
      <div class="tbs-grid">
        <section>
          <h4>Icon</h4>
          <div class="tbs-icons">
            ${it.svg ? tile("menu", it.group === "menu" ? "Menu icon" : "Patients icon") : ""}
            ${tile("letters", "Letters")}
            ${tile("dot", "Dot")}
            ${Object.entries(TAB_PRESETS).map(([k, p]) => tile(k, p.label)).join("")}
          </div>
          ${s.icon === "letters" ? `<label class="sds-f tbs-letters"><span>Letters (up to 3)</span>
            <input type="text" maxlength="3" data-f="text" value="${esc(lettersFor(it, s))}" placeholder="e.g. TxR"></label>` : ""}
        </section>
        <div class="tbs-side">
          <section>
            <h4>Colour</h4>
            <div class="tbs-swatches">${TAB_COLOURS.map((c) => `<button type="button" class="tbs-sw${s.bg === c ? " is-on" : ""}"
                data-colour="${c}" style="--c:${c}" aria-label="Colour ${c}" aria-pressed="${s.bg === c}"></button>`).join("")}
              <label class="tbs-custom"><input type="color" data-f="bg" value="${s.bg.toLowerCase()}"> Custom</label>
            </div>
            ${s.icon === "dot" ? "" : `<label class="tbs-chk"><input type="checkbox" data-f="grad"${s.bg2 ? " checked" : ""}> Blend into a second colour</label>
            ${s.bg2 ? `<label class="tbs-custom tbs-second"><input type="color" data-f="bg2" value="${s.bg2.toLowerCase()}"> Second colour</label>` : ""}`}
          </section>
          <section>
            <h4>Tab name</h4>
            <label class="sds-f"><span class="sr-only">Tab name</span>
              <input type="text" maxlength="80" data-f="title" value="${esc(s.title)}" placeholder="${esc(it.label)}"></label>
            <div class="tbs-vars">${it.vars.map((v) => `<button type="button" class="tbs-var" data-var="${v}">+ ${VAR_LABEL[v]}</button>`).join("")}${
              SYMBOLS.map((sym) => `<button type="button" class="tbs-var is-sym" data-sym="${sym}" title="Add ${sym}" aria-label="Add ${sym}">${sym}</button>`).join("")}</div>
            <small class="sds-muted">Staff will see: <b data-pv-example>${esc(titleOf(it, s))}</b></small>
          </section>
        </div>
      </div>
      <div class="tbs-acts">
        <button type="button" class="sds-btn is-quiet" data-act="reset"${isChanged(it.key) ? "" : " disabled"}>Back to standard</button>
        <button type="button" class="sds-btn" data-act="edit">Done</button>
      </div>
    </div>`;
  }

  function rowHtml(it) {
    const s = spec(it.key);
    const open = st.open === it.key;
    return `<div class="tbs-row${open ? " is-open" : ""}" data-key="${esc(it.key)}">
      <div class="tbs-head">
        <span class="tbs-chrome">${tabChip(it, s)}</span>
        <div class="tbs-name"><b>${esc(it.label)}</b><small>${esc(it.desc)}${isChanged(it.key) ? " · <em>Changed</em>" : ""}</small></div>
        <button type="button" class="sds-btn is-quiet" data-act="edit" aria-expanded="${open}">${open ? "Close" : "Edit"}</button>
      </div>
      ${open ? editorHtml(it, s) : ""}
    </div>`;
  }

  const groupHtml = (title, sub, list) => list.length ? `<section class="tbs-group">
      <h3>${title}</h3><p class="sds-hint">${sub}</p>
      <div class="tbs-list">${list.map(rowHtml).join("")}</div></section>` : "";

  function render() {
    const y = window.scrollY;
    host.innerHTML = `<div class="sds tbs">
      <div class="sds-head">
        <div><h2 class="sds-h">Browser tabs</h2>
          <p class="sds-sub">How each page looks in the browser's tab bar, so staff can tell their open tabs apart at a glance.</p></div>
        <div class="sds-top-acts">
          <span class="sds-status"></span>
          <button type="button" class="sds-btn is-primary" data-act="save"${st.saving ? " disabled" : ""}>${st.saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
      ${groupHtml("Menu pages", "The pages in the menu on the left.", menu)}
      ${groupHtml("Patients and records", "A patient's page, and records that open in their own tab.", records)}
      ${groupHtml("Consultation and notes", "The Consultation tab while it records and writes the notes, and notes opened in their own tab.", consults)}
    </div>`;
    status();
    window.scrollTo(0, y);
  }

  // Updates the previews without redrawing (so typing and colour picking stay smooth)
  function refresh(key) {
    const row = host.querySelector(`.tbs-row[data-key="${CSS.escape(key)}"]`);
    const it = item(key);
    if (!row || !it) return;
    const s = spec(key);
    row.querySelectorAll("[data-pv-icon]").forEach((img) => { img.src = iconOf(it, s); });
    row.querySelectorAll("[data-pv-title]").forEach((el) => { el.textContent = titleOf(it, s); });
    row.querySelectorAll("[data-pv-example]").forEach((el) => { el.textContent = titleOf(it, s); });
    row.querySelectorAll("[data-tile]").forEach((img) => {
      const icon = img.dataset.tile;
      img.src = tabIconUrl({ ...s, icon, text: icon === "letters" ? lettersFor(it, s) : s.text }, it.svg, menuKey(it));
    });
    const small = row.querySelector(".tbs-name small");
    if (small) small.innerHTML = `${esc(it.desc)}${isChanged(key) ? " · <em>Changed</em>" : ""}`;
    const reset = row.querySelector('[data-act="reset"]');
    if (reset) reset.disabled = !isChanged(key);
  }

  async function save() {
    if (st.saving) return;
    const kinds = {};
    items.forEach((it) => { if (isChanged(it.key)) kinds[it.key] = spec(it.key); });
    const clean = cleanTabKinds(kinds);
    st.saving = true;
    render();
    try {
      const u = getAuth().currentUser;
      const name = String((staff && staff.name) || "").slice(0, 120);
      await setDoc(doc(db, "ui_settings", "tabs"), {
        kinds: clean, updatedAt: serverTimestamp(), updatedBy: name, updatedByUid: u ? u.uid : "",
      });
      st.kinds = clean;
      st.dirty = false;
      st.savedBy = name;
      st.savedAt = new Date();
      applyTabSettings(clean);   // this tab updates straight away
      showToast("Browser tabs saved. Everyone's tabs update within 5 minutes.");
    } catch (err) {
      console.error("Tab settings not saved:", err);
      showToast(err && err.code === "permission-denied"
        ? "Couldn't save: only Admins can change the browser tabs."
        : "Couldn't save. Check your connection and try again.");
    }
    st.saving = false;
    render();
  }

  /* ----- Events ----- */
  host.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.act === "save") { save(); return; }
    const row = b.closest(".tbs-row");
    const key = row ? row.dataset.key : "";
    const it = key ? item(key) : null;
    if (!it) return;

    if (b.dataset.act === "edit") {
      st.open = st.open === key ? "" : key;
      render();
      if (st.open) host.querySelector(`.tbs-row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if (b.dataset.icon) {
      const s = spec(key);
      set(key, { icon: b.dataset.icon, ...(b.dataset.icon === "letters" && !s.text ? { text: initials(it.label) } : {}) });
      render();
      return;
    }
    if (b.dataset.colour) { set(key, { bg: b.dataset.colour }); render(); return; }
    if (b.dataset.var || b.dataset.sym) {
      const inp = row.querySelector('[data-f="title"]');
      if (!inp) return;
      const tok = b.dataset.var ? `{${b.dataset.var}}` : b.dataset.sym;
      const a = inp.selectionStart ?? inp.value.length;
      const z = inp.selectionEnd ?? a;
      const sep = a > 0 && !/\s$/.test(inp.value.slice(0, a)) ? " " : "";
      inp.value = (inp.value.slice(0, a) + sep + tok + inp.value.slice(z)).slice(0, 80);
      const pos = Math.min(80, a + sep.length + tok.length);
      inp.focus();
      inp.setSelectionRange(pos, pos);
      set(key, { title: inp.value });
      refresh(key);
      return;
    }
    if (b.dataset.act === "reset") {
      if (!(await confirmDialog({ title: `Put "${it.label}" back to standard?`,
        message: "Its icon, colour and tab name go back to how the portal had them. Nothing changes for staff until you save.",
        confirmLabel: "Back to standard", tone: "warning" }))) return;
      delete st.kinds[key];
      st.dirty = true;
      render();
    }
  });

  host.addEventListener("input", (e) => {
    const el = e.target;
    const row = el.closest(".tbs-row");
    if (!row || !el.dataset.f) return;
    const key = row.dataset.key;
    const f = el.dataset.f;
    if (f === "title") set(key, { title: el.value });
    else if (f === "text") set(key, { text: el.value.replace(/\s+/g, "").slice(0, 3) });
    else if (f === "bg" || f === "bg2") set(key, { [f]: el.value.toUpperCase() });
    else return;
    refresh(key);
  });

  host.addEventListener("change", (e) => {
    const el = e.target;
    const row = el.closest(".tbs-row");
    if (!row) return;
    const key = row.dataset.key;
    if (el.dataset.f === "grad") {
      const s = spec(key);
      set(key, { bg2: el.checked ? (s.bg2 || darker(s.bg)) : "" });
      render();
    } else if (el.dataset.f === "bg") render();   // the chosen swatch shows as picked
  });

  // Leaving with unsaved changes: ask first, in the portal's own dialog
  const guard = (e) => {
    if (!host.isConnected) { window.removeEventListener("hashchange", guard, true); return; }
    if (!st.dirty || /^#\/settings\/tabs\/?$/.test(location.hash)) return;
    e.stopImmediatePropagation();
    const to = location.hash;
    history.replaceState(null, "", e.oldURL);
    confirmDialog({ title: "Leave without saving?", message: "Your browser tab changes haven't been saved.",
      confirmLabel: "Leave", tone: "warning" }).then((ok) => { if (ok) { st.dirty = false; location.hash = to; } });
  };
  window.addEventListener("hashchange", guard, true);

  render();
}