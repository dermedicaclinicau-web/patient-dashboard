// Settings → Services and pricing: each service's regular price (inc GST).
// Package refunds charge the visits already used at these prices.
// Firestore: service_prices/{id}. Hidden, never deleted. Admins and Refunds managers edit; all staff read.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, setDoc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from "./utils.js";
import { can, isAdmin } from "./perms.js";

const COL = "service_prices";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${round2(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const myUid = () => (auth.currentUser && auth.currentUser.uid) || "";
const canEdit = () => isAdmin() || can("refunds.manage");
const niceDate = (v) => {
  const d = v && typeof v.toDate === "function" ? v.toDate() : v ? new Date(v) : null;
  return d && !isNaN(d) ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);

// "Brightening Peel & LED" and "brightening peel and led" are the same service
export const priceKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const keysOf = (s) => [s.nameKey || priceKey(s.name), ...(s.aliasKeys || [])].filter(Boolean);

let cache = null;
export async function loadServicePrices(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 5 * 60000) return cache.list;
  const snap = await getDocs(collection(db, COL));
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  cache = { at: Date.now(), list };
  return list;
}

// A service name (as Timely writes it) → its shown service, by name first, then by its other names. null if none.
export function priceLookup(list) {
  const live = (list || []).filter((s) => s.active !== false);
  const m = new Map();
  live.forEach((s) => { const k = s.nameKey || priceKey(s.name); if (k && !m.has(k)) m.set(k, s); });
  live.forEach((s) => (s.aliasKeys || []).forEach((k) => { if (k && !m.has(k)) m.set(k, s); }));
  return (name) => m.get(priceKey(name)) || null;
}

// Rows pasted from a spreadsheet: "Name <tab> Price <tab> Category" or "Name, Price, Category"
function parseList(text) {
  const rows = new Map();
  let bad = 0;
  String(text || "").replace(/\r/g, "").split("\n").forEach((line) => {
    const l = line.replace(/"/g, "").trim();
    if (!l) return;
    let name = "", price = "", category = "";
    if (l.includes("\t")) {
      [name = "", price = "", category = ""] = l.split("\t").map((x) => x.trim());
    } else {
      const m = /^(.*?)\s*,\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:,\s*(.*))?$/.exec(l);
      if (m) { name = m[1]; price = m[2]; category = m[3] || ""; }
    }
    const n = Number(String(price).replace(/[$,\s]/g, ""));
    name = clean(name, 150);
    if (!name || !String(price).trim() || !Number.isFinite(n) || n < 0 || n > 100000) { bad++; return; }
    rows.set(priceKey(name), { name, price: round2(n), category: clean(category, 60) });
  });
  return { rows: [...rows.values()], bad };
}

function openDialog(html, cls = "") {
  const dlg = document.createElement("dialog");
  dlg.className = `lh-dialog svp-dlg ${cls}`.trim();
  dlg.innerHTML = html;
  dlg.addEventListener("click", (e) => { if (e.target.closest('[data-act="close"]')) dlg.close(); });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

export async function mountServicePrices(container, { staff = null } = {}) {
  const by = clean(staff && staff.name, 120);
  const edit = canEdit();
  const root = document.createElement("div");
  root.className = "svp";
  root.innerHTML = '<div class="skeleton" style="height:240px;border-radius:14px"></div>';
  container.replaceChildren(root);
  let list = [];
  try {
    list = await loadServicePrices(true);
  } catch (err) {
    console.error("Service prices not loaded:", err);
    root.innerHTML = `<div class="rf-empty"><strong>Couldn't load the services</strong>${err.code === "permission-denied"
      ? "The Firestore rules for service_prices haven't been added yet." : "Check your connection and try again."}</div>`;
    return;
  }
  if (!root.isConnected) return;
  const ui = { q: "", cat: "", hidden: false };

  root.innerHTML = `
    <div class="svp-head">
      <div><h3>Services and pricing</h3>
        <p class="muted">Each service's regular price, including GST. When a package is refunded, the visits already used are charged at these prices.
          Use the names exactly as they are in Timely.</p></div>
      ${edit ? `<div class="svp-acts"><button type="button" class="btn-ghost" data-act="paste">Paste a list</button>
        <button type="button" class="btn-primary" data-act="add">+ Add a service</button></div>` : ""}
    </div>
    <div class="svp-tools">
      <input class="fe-input" type="search" data-role="q" placeholder="Search services" aria-label="Search services" autocomplete="off">
      <select class="fb-select" data-role="cat" aria-label="Category"></select>
      <label class="fe-check"><input type="checkbox" data-role="hidden"> Show hidden</label>
      <span class="muted svp-count" data-role="count"></span>
    </div>
    <div data-role="table"></div>`;
  const tableEl = root.querySelector('[data-role="table"]');
  const cats = () => [...new Set(list.map((s) => s.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en-AU"));

  function drawCats() {
    if (ui.cat && !cats().includes(ui.cat)) ui.cat = "";
    root.querySelector('[data-role="cat"]').innerHTML = `<option value="">All categories</option>${cats().map((c) =>
      `<option${c === ui.cat ? " selected" : ""}>${esc(c)}</option>`).join("")}`;
  }

  function drawTable() {
    const q = priceKey(ui.q);
    const rows = list.filter((s) => (ui.hidden || s.active !== false) && (!ui.cat || s.category === ui.cat)
      && (!q || keysOf(s).some((k) => k.includes(q))))
      .sort((a, b) => String(a.category || "~").localeCompare(String(b.category || "~"), "en-AU") || String(a.name).localeCompare(String(b.name), "en-AU"));
    const live = list.filter((s) => s.active !== false).length;
    root.querySelector('[data-role="count"]').textContent =
      `${live} service${live === 1 ? "" : "s"}${list.length > live ? ` · ${list.length - live} hidden` : ""}`;
    tableEl.innerHTML = !list.length
      ? `<div class="rf-empty"><strong>No services yet</strong>${edit ? "Add them one at a time, or paste a list from a spreadsheet." : "An Admin adds them here."}</div>`
      : !rows.length ? '<p class="muted rf-wait">No services match.</p>'
      : `<table class="inv-table svp-table"><thead><tr><th>Service</th><th>Category</th><th class="svp-num">Price</th><th>Last changed</th>${edit ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows.map((s) => `<tr class="${s.active === false ? "is-hidden" : ""}">
          <td><strong>${esc(s.name)}</strong>${(s.aliases || []).length ? `<small>Also: ${esc(s.aliases.join(" · "))}</small>` : ""}${
            s.note ? `<small>${esc(s.note)}</small>` : ""}${s.active === false ? '<small class="svp-hid">Hidden</small>' : ""}</td>
          <td>${esc(s.category || "")}</td>
          <td class="svp-num">${money(s.price)}</td>
          <td><small>${esc([s.updatedBy, niceDate(s.updatedAt)].filter(Boolean).join(" · "))}</small></td>
          ${edit ? `<td class="svp-num"><button type="button" class="lh-btn is-quiet" data-act="edit" data-id="${esc(s.id)}">Edit</button></td>` : ""}
        </tr>`).join("")}</tbody></table>`;
  }

  async function reload() {
    list = await loadServicePrices(true);
    if (!root.isConnected) return;
    drawCats();
    drawTable();
  }

  /* ---------- Add or edit one ---------- */
  function openEdit(s) {
    const isNew = !s;
    const dlg = openDialog(`<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>${isNew ? "Add a service" : "Edit service"}</h3><p>Use the name exactly as it is in Timely, so packages find its price.</p></div>
      <label class="lh-field"><span class="lh-label">Service name</span>
        <input class="fe-input" name="name" maxlength="150" value="${esc(s ? s.name : "")}" autocomplete="off"></label>
      <div class="svp-two">
        <label class="lh-field"><span class="lh-label">Regular price (inc GST)</span>
          <span class="rf-money"><em>$</em><input class="fe-input" name="price" inputmode="decimal" value="${s ? round2(s.price).toFixed(2) : ""}" placeholder="0.00"></span></label>
        <label class="lh-field"><span class="lh-label">Category <small>(optional)</small></span>
          <input class="fe-input" name="category" maxlength="60" list="svp-cats" value="${esc(s ? s.category || "" : "")}" autocomplete="off"></label>
      </div>
      <datalist id="svp-cats">${cats().map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <label class="lh-field"><span class="lh-label">Other names Timely uses for it <small>(one per line, optional)</small></span>
        <textarea class="fe-input" name="aliases" rows="2">${esc(s ? (s.aliases || []).join("\n") : "")}</textarea></label>
      <label class="lh-field"><span class="lh-label">Note <small>(optional)</small></span>
        <input class="fe-input" name="note" maxlength="300" value="${esc(s ? s.note || "" : "")}"></label>
      ${isNew ? "" : `<label class="fe-check"><input type="checkbox" name="active"${s.active !== false ? " checked" : ""}> Shown (untick to hide it)</label>`}
      ${!isNew && (s.history || []).length ? `<details class="svp-hist"><summary>Price changes</summary><ul>${[...s.history].reverse().map((h) =>
        `<li>${money(h.from)} → ${money(h.to)}<small>${esc([h.by, niceDate(h.at)].filter(Boolean).join(" · "))}</small></li>`).join("")}</ul></details>` : ""}
      <p class="lh-error" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div>
    </form>`);
    const f = dlg.querySelector("form");
    const err = f.querySelector(".lh-error");
    const say = (m) => { err.textContent = m; err.hidden = false; };
    f.elements.name.focus();
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = clean(f.elements.name.value, 150);
      const key = priceKey(name);
      const priceTxt = f.elements.price.value.replace(/[$,\s]/g, "");
      const price = round2(Number(priceTxt));
      const aliases = [...new Set(f.elements.aliases.value.split("\n").map((x) => clean(x, 150)).filter(Boolean))].slice(0, 10);
      const aliasKeys = [...new Set(aliases.map(priceKey).filter((k) => k && k !== key))].slice(0, 10);
      if (!key) { say("Enter the service name."); return; }
      if (!priceTxt || !Number.isFinite(Number(priceTxt)) || price < 0 || price > 100000) { say("Enter the regular price, for example 330 or 330.00."); return; }
      const clash = list.find((x) => x.id !== (s && s.id) && keysOf(x).some((k) => k === key || aliasKeys.includes(k)));
      if (clash) { say(`"${clash.name}" already uses that name${clash.active === false ? " (it's hidden: tick Show hidden to find it)" : ""}.`); return; }
      const history = Array.isArray(s && s.history) ? s.history.slice(-19) : [];
      if (!isNew && round2(s.price) !== price) history.push({ from: round2(s.price), to: price, at: new Date().toISOString(), by });
      const data = {
        name, nameKey: key, category: clean(f.elements.category.value, 60), price, aliases, aliasKeys,
        note: String(f.elements.note.value || "").trim().slice(0, 300), active: isNew ? true : f.elements.active.checked, history,
        updatedAt: serverTimestamp(), updatedBy: by, updatedByUid: myUid(),
        ...(isNew ? { createdAt: serverTimestamp(), createdBy: by, createdByUid: myUid() } : {}),
      };
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        await setDoc(isNew ? doc(collection(db, COL)) : doc(db, COL, s.id), data, { merge: true });
        dlg.close();
        showToast(isNew ? "Service added" : "Service saved");
        await reload();
      } catch (ex) {
        console.error("Service not saved:", ex);
        btn.disabled = false;
        btn.textContent = "Save";
        say(ex.code === "permission-denied" ? "Only Admins and Refunds managers can change prices." : "Couldn't save. Try again.");
      }
    });
  }

  /* ---------- Paste a list from a spreadsheet ---------- */
  function openPaste() {
    const dlg = openDialog(`<form class="lh-form" novalidate>
      <div class="lh-dialog-head"><h3>Paste a list</h3>
        <p>Copy the rows from a spreadsheet: service name, price, and category if you have it. One service per line. Nothing is saved until you press Import.</p></div>
      <textarea class="fe-input" name="text" rows="8" placeholder="Brightening peel&#9;330&#9;Peels&#10;Clear Complexion Lite, 450, Peels"></textarea>
      <div data-role="prev"></div>
      <label class="fe-check"><input type="checkbox" name="upd" checked> Change the price of services already in the list</label>
      <p class="lh-error" hidden></p>
      <div class="lh-actions"><button type="button" class="lh-btn is-quiet" data-act="close">Cancel</button>
        <button type="submit" class="btn-primary" disabled>Import</button></div>
    </form>`, "is-wide");
    const f = dlg.querySelector("form");
    const prev = f.querySelector('[data-role="prev"]');
    const btn = f.querySelector('[type="submit"]');
    let items = [];
    const TAGS = { new: "New", change: "Price changes", same: "Already the same", alias: "Another name of a service" };

    function check() {
      const { rows, bad } = parseList(f.elements.text.value);
      const byName = new Map(list.map((s) => [s.nameKey || priceKey(s.name), s]));
      const byAlias = new Map();
      list.forEach((s) => (s.aliasKeys || []).forEach((k) => byAlias.set(k, s)));
      items = rows.map((r) => {
        const k = priceKey(r.name);
        const ex = byName.get(k) || null;
        const al = !ex ? byAlias.get(k) || null : null;
        const st = al ? "alias" : !ex ? "new"
          : round2(ex.price) !== r.price || (r.category && r.category !== (ex.category || "")) ? "change" : "same";
        return { ...r, ex, al, st };
      });
      const n = (st) => items.filter((x) => x.st === st).length;
      const upd = f.elements.upd.checked;
      const todo = n("new") + (upd ? n("change") : 0);
      btn.disabled = !todo;
      btn.textContent = todo ? `Import ${todo}` : "Import";
      prev.innerHTML = !items.length && !bad ? "" : `
        <p class="svp-sum">${[n("new") && `${n("new")} new`, n("change") && `${n("change")} with a new price`, n("same") && `${n("same")} already the same`,
          n("alias") && `${n("alias")} matching another name of a service (skipped)`,
          bad && `${bad} line${bad === 1 ? "" : "s"} couldn't be read (a heading row is fine)`].filter(Boolean).join(" · ")}</p>
        ${items.length ? `<div class="svp-prev"><table class="inv-table"><tbody>${items.slice(0, 300).map((x) => `<tr>
          <td>${esc(x.name)}${x.al ? `<small class="svp-sub">Another name of ${esc(x.al.name)}</small>` : ""}</td>
          <td>${esc(x.category || (x.ex && x.ex.category) || "")}</td>
          <td class="svp-num">${x.st === "change" ? `<small class="svp-sub">${money(x.ex.price)} →</small>` : ""}${money(x.price)}</td>
          <td><span class="svp-tag is-${x.st}">${TAGS[x.st]}</span></td></tr>`).join("")}</tbody></table></div>` : ""}`;
    }
    f.addEventListener("input", check);
    f.addEventListener("change", check);

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const upd = f.elements.upd.checked;
      const todo = items.filter((x) => x.st === "new" || (upd && x.st === "change"));
      if (!todo.length) return;
      btn.disabled = true;
      btn.textContent = "Importing…";
      const now = new Date().toISOString();
      try {
        for (let i = 0; i < todo.length; i += 400) {
          const b = writeBatch(db);
          todo.slice(i, i + 400).forEach((x) => {
            const stamp = { updatedAt: serverTimestamp(), updatedBy: by, updatedByUid: myUid() };
            if (x.st === "new") {
              b.set(doc(collection(db, COL)), {
                name: x.name, nameKey: priceKey(x.name), category: x.category, price: x.price, aliases: [], aliasKeys: [], note: "",
                active: true, history: [], ...stamp, createdAt: serverTimestamp(), createdBy: by, createdByUid: myUid(),
              });
            } else {
              const history = (Array.isArray(x.ex.history) ? x.ex.history.slice(-19) : []);
              if (round2(x.ex.price) !== x.price) history.push({ from: round2(x.ex.price), to: x.price, at: now, by });
              b.set(doc(db, COL, x.ex.id), { price: x.price, category: x.category || x.ex.category || "", history, ...stamp }, { merge: true });
            }
          });
          await b.commit();
        }
        const added = todo.filter((x) => x.st === "new").length;
        dlg.close();
        showToast([added && `${added} added`, todo.length - added && `${todo.length - added} updated`].filter(Boolean).join(", "));
        await reload();
      } catch (ex) {
        console.error("Price list not imported:", ex);
        btn.disabled = false;
        btn.textContent = "Import";
        const er = f.querySelector(".lh-error");
        er.textContent = ex.code === "permission-denied" ? "Only Admins and Refunds managers can change prices." : "Couldn't import. Some rows may have saved: close this and check the list.";
        er.hidden = false;
      }
    });
    f.elements.text.focus();
  }

  root.addEventListener("input", (e) => {
    if (e.target.dataset.role === "q") { ui.q = e.target.value; drawTable(); }
  });
  root.addEventListener("change", (e) => {
    if (e.target.dataset.role === "cat") { ui.cat = e.target.value; drawTable(); }
    if (e.target.dataset.role === "hidden") { ui.hidden = e.target.checked; drawTable(); }
  });
  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a || !edit) return;
    if (a.dataset.act === "add") openEdit(null);
    else if (a.dataset.act === "paste") openPaste();
    else if (a.dataset.act === "edit") openEdit(list.find((s) => s.id === a.dataset.id));
  });

  drawCats();
  drawTable();
}