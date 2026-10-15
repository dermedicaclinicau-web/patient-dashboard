// My dashboard → My notes: a private scratchpad. Firestore staff_notes; only the person who wrote a note can see or change it.
// Built for tapping: a big "Add a note" tile opens a sticky-note editor with Note / Checklist, colours, and Save / Cancel buttons.
import { db, auth } from "./firebase-config.js";
import {
  collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";

const COLORS = ["yellow", "green", "blue", "pink", "grey"];
const COLOR_NAMES = { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", grey: "Grey" };
const SHOW = 6;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  note: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="14" x2="15" y2="14"/>'),
  list: svg('<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><polyline points="3 6 5 8 8 4"/><polyline points="3 12 5 14 8 10"/><polyline points="3 18 5 20 8 16"/>'),
  pin: svg('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>'),
  palette: svg('<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
};
const myUid = () => (auth.currentUser && auth.currentUser.uid) || "";

/* ---------- Data ---------- */
async function listNotes() {
  const snap = await getDocs(query(collection(db, "staff_notes"), where("ownerUid", "==", myUid())));
  return sortNotes(snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, text: String(x.text || ""),
      items: Array.isArray(x.items) ? x.items.map((i) => ({ t: String(i.t || ""), done: i.done === true })) : [],
      color: COLORS.includes(x.color) ? x.color : "yellow", pinned: x.pinned === true,
      at: x.updatedAt && x.updatedAt.toDate ? x.updatedAt.toDate() : null,
    };
  }));
}
const sortNotes = (list) => {
  const t = (n) => (n.at ? n.at.getTime() : Date.now());
  return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || t(b) - t(a));
};
const addNote = (data) => addDoc(collection(db, "staff_notes"), {
  ownerUid: myUid(), ...data, pinned: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
});
const patchNote = (id, data) => updateDoc(doc(db, "staff_notes", id), { ...data, updatedAt: serverTimestamp() });

/* ---------- The card ---------- */
export function mountMyNotes(host) {
  if (!host) return;
  // draft: the note being written or edited ({ id: "" } = a new one), or null
  const st = { notes: [], all: false, draft: null, saving: false, loading: true, error: "", lastColor: "yellow" };

  host.innerHTML = `<div class="mn">
    <div class="md-card-head"><h3>My notes</h3><small class="muted">🔒 Only you can see these</small></div>
    <div data-role="list"><div class="skeleton sm"></div></div>
  </div>`;
  const $list = host.querySelector('[data-role="list"]');
  const grow = (el) => { el.style.height = "auto"; el.style.height = `${Math.min(Math.max(el.scrollHeight, 90), 320)}px`; };

  const when = (d) => {
    if (!d) return "Just now";
    const today = new Date().toDateString() === d.toDateString();
    return today ? `Today ${d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}`
      : d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  };

  /* ---------- HTML ---------- */
  const addTileHtml = () => `<button type="button" class="mn-addtile" data-act="new">
      <span class="mn-addtile-plus">${I.plus}</span>
      <strong>Add a note</strong>
      <small>${st.notes.length ? "A reminder, a to-do list, a phone number…" : "Tap here to write your first note: a reminder, a to-do list, a phone number…"}</small>
    </button>`;

  const composerHtml = (d) => `<article class="mn-note mn-compose mn-c-${d.color}" data-compose="1">
      <div class="mn-mode" role="group" aria-label="Type of note">
        <button type="button" data-mode="text" class="${d.mode === "text" ? "is-on" : ""}" aria-pressed="${d.mode === "text"}">${I.note}<span>Note</span></button>
        <button type="button" data-mode="list" class="${d.mode === "list" ? "is-on" : ""}" aria-pressed="${d.mode === "list"}">${I.list}<span>Checklist</span></button>
      </div>
      ${d.mode === "text"
        ? `<textarea class="mn-ctext" data-f="text" maxlength="2000" placeholder="What do you want to remember?" aria-label="Note">${esc(d.text)}</textarea>`
        : `<ul class="mn-citems">${d.items.map((it, i) => `<li>
            <span class="mn-cbox${it.done ? " is-done" : ""}" aria-hidden="true"></span>
            <input type="text" class="mn-citem" data-item="${i}" maxlength="200" value="${esc(it.t)}"
              placeholder="${i === 0 ? "First thing to do" : "Next thing to do"}" aria-label="Checklist item ${i + 1}" />
            <button type="button" class="mn-cdel" data-del="${i}" aria-label="Remove item ${i + 1}" title="Remove">×</button></li>`).join("")}</ul>
          <button type="button" class="mn-cadd" data-act="add-item">${I.plus}<span>Add item</span></button>`}
      <div class="mn-ccolors"><span>Colour</span>${COLORS.map((c) => `<button type="button" class="mn-sw mn-c-${c}${c === d.color ? " is-on" : ""}"
        data-color="${c}" aria-label="${COLOR_NAMES[c]}" aria-pressed="${c === d.color}" title="${COLOR_NAMES[c]}"></button>`).join("")}</div>
      <div class="mn-cbtns">
        <button type="button" class="lh-btn is-quiet" data-act="cancel">Cancel</button>
        <button type="button" class="lh-btn is-primary" data-act="save"${st.saving ? " disabled" : ""}>${st.saving ? "Saving…" : d.id ? "Save changes" : "Save note"}</button>
      </div>
    </article>`;

  const noteHtml = (n) => {
    const done = n.items.filter((i) => i.done).length;
    const body = n.items.length
      ? `<ul class="mn-items">${n.items.map((it, i) => `<li><label><input type="checkbox" data-tick="${i}"${it.done ? " checked" : ""} />
          <span${it.done ? ' class="is-done"' : ""}>${esc(it.t)}</span></label></li>`).join("")}</ul>`
      : `<p class="mn-text" data-act="edit" title="Tap to edit">${esc(n.text)}</p>`;
    return `<article class="mn-note mn-c-${n.color}${n.pinned ? " is-pinned" : ""}" data-id="${esc(n.id)}">
      ${n.pinned ? `<span class="mn-pinmark" title="Pinned">${I.pin}</span>` : ""}
      ${body}
      <div class="mn-foot">
        <small>${esc(when(n.at))}${n.items.length ? ` · ${done} of ${n.items.length} done` : ""}</small>
        <span class="mn-acts">
          <button type="button" data-act="pin" class="${n.pinned ? "is-on" : ""}" aria-label="${n.pinned ? "Unpin" : "Pin to the top"}" title="${n.pinned ? "Unpin" : "Pin to the top"}">${I.pin}</button>
          <button type="button" data-act="color" aria-label="Change colour" title="Change colour">${I.palette}</button>
          <button type="button" data-act="edit" aria-label="Edit" title="Edit">${I.edit}</button>
          <button type="button" data-act="del" aria-label="Delete" title="Delete">${I.trash}</button>
        </span>
      </div>
    </article>`;
  };

  function draw(focusSel = "") {
    if (st.loading) return;
    if (st.error) { $list.innerHTML = `<p class="rc-empty">${esc(st.error)}</p>`; return; }
    const d = st.draft;
    let shown = st.all ? st.notes : st.notes.slice(0, SHOW);
    // Keep the note being edited on screen even if it's past the first few
    if (d && d.id && !shown.some((n) => n.id === d.id)) shown = [...shown, ...st.notes.filter((n) => n.id === d.id)];
    $list.innerHTML = `<div class="mn-grid">
        ${d && !d.id ? composerHtml(d) : addTileHtml()}
        ${shown.map((n) => (d && d.id === n.id ? composerHtml(d) : noteHtml(n))).join("")}
      </div>${st.notes.length > SHOW
        ? `<button type="button" class="cs-link mn-more" data-act="more">${st.all ? "Show fewer" : `Show all ${st.notes.length} notes`}</button>` : ""}`;
    $list.querySelectorAll('[data-f="text"]').forEach(grow);
    if (focusSel) {
      const el = $list.querySelector(focusSel);
      if (el) {
        el.focus({ preventScroll: true });
        if (typeof el.setSelectionRange === "function") el.setSelectionRange(el.value.length, el.value.length);
        const box = el.closest(".mn-compose");
        if (box) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }

  const fail = (err, what) => {
    console.error(`My notes: ${what} failed`, err);
    showToast(err && err.code === "permission-denied"
      ? "Notes are blocked. Ask an Admin to publish the Firestore rule for staff_notes."
      : `Couldn't ${what}. Try again.`);
  };

  async function load() {
    try { st.notes = await listNotes(); st.error = ""; }
    catch (err) {
      console.error("My notes: load failed", err);
      st.error = err && err.code === "permission-denied"
        ? "Notes aren't switched on yet. Ask an Admin to publish the Firestore rule for staff_notes."
        : "Couldn't load your notes. Check your connection.";
    }
    st.loading = false;
    if (host.isConnected) draw();
  }

  /* ---------- Writing ---------- */
  const draftHasContent = (d) => !!(d && (d.text.trim() || d.items.some((i) => i.t.trim())));
  const focusFor = (d) => (d.mode === "text" ? '[data-f="text"]' : `[data-item="${d.items.length - 1}"]`);

  function openNew() {
    if (st.draft && !st.draft.id) { draw(focusFor(st.draft)); return; }   // already writing one
    st.draft = { id: "", mode: "text", text: "", items: [{ t: "", done: false }], color: st.lastColor };
    draw('[data-f="text"]');
  }
  function openEdit(n) {
    st.draft = {
      id: n.id, mode: n.items.length ? "list" : "text", text: n.text,
      items: n.items.length ? n.items.map((i) => ({ ...i })) : [{ t: "", done: false }], color: n.color,
    };
    draw(focusFor(st.draft));
  }
  async function cancel() {
    const d = st.draft;
    if (!d) return;
    if (!d.id && draftHasContent(d)) {
      const ok = await confirmDialog({ title: "Throw away this note?", message: "What you've written won't be saved.", confirmLabel: "Throw away", tone: "danger" });
      if (!ok) return;
    }
    st.draft = null;
    draw();
  }
  async function save() {
    const d = st.draft;
    if (!d || st.saving) return;
    const data = d.mode === "list"
      ? { text: "", items: d.items.map((i) => ({ t: i.t.trim().slice(0, 200), done: !!i.done })).filter((i) => i.t).slice(0, 30) }
      : { text: d.text.trim().slice(0, 2000), items: [] };
    if (!data.text && !data.items.length) {
      showToast(d.mode === "list" ? "Add at least one item first." : "Write something first.");
      draw(focusFor(d));
      return;
    }
    data.color = d.color;
    st.saving = true;
    draw();
    try {
      if (d.id) {
        await patchNote(d.id, data);
        const n = st.notes.find((x) => x.id === d.id);
        if (n) Object.assign(n, data, { at: new Date() });
        sortNotes(st.notes);
      } else {
        await addNote(data);
      }
      st.lastColor = d.color;
      st.draft = null;
      st.saving = false;
      if (d.id) draw(); else await load();
      showToast(d.id ? "Note updated" : "Note saved");
    } catch (err) {
      st.saving = false;
      draw();
      fail(err, "save the note");
    }
  }

  /* ---------- Clicks ---------- */
  host.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act], [data-mode], [data-color], [data-del]");
    if (!b) return;
    const d = st.draft;

    // Inside the editor
    if (b.closest("[data-compose]") && d) {
      if (b.dataset.mode && b.dataset.mode !== d.mode) {
        if (b.dataset.mode === "list") {
          const lines = d.text.split("\n").map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
          d.items = lines.length ? lines.slice(0, 30).map((t) => ({ t: t.slice(0, 200), done: false })) : [{ t: "", done: false }];
        } else {
          d.text = d.items.map((i) => i.t.trim()).filter(Boolean).join("\n");
        }
        d.mode = b.dataset.mode;
        draw(focusFor(d));
        return;
      }
      if (b.dataset.color) {
        d.color = b.dataset.color;
        const box = b.closest("[data-compose]");
        box.className = box.className.replace(/mn-c-\w+/, `mn-c-${d.color}`);
        box.querySelectorAll("[data-color]").forEach((x) => {
          const on = x.dataset.color === d.color;
          x.classList.toggle("is-on", on);
          x.setAttribute("aria-pressed", String(on));
        });
        return;
      }
      if (b.dataset.del !== undefined) {
        d.items.splice(Number(b.dataset.del), 1);
        if (!d.items.length) d.items.push({ t: "", done: false });
        draw(`[data-item="${Math.max(0, Number(b.dataset.del) - 1)}"]`);
        return;
      }
      if (b.dataset.act === "add-item") {
        if (d.items.length >= 30) { showToast("A checklist can have up to 30 items."); return; }
        d.items.push({ t: "", done: false });
        draw(`[data-item="${d.items.length - 1}"]`);
        return;
      }
      if (b.dataset.act === "cancel") { cancel(); return; }
      if (b.dataset.act === "save") { save(); return; }
      return;
    }

    const act = b.dataset.act;
    if (act === "new") { openNew(); return; }
    if (act === "more") { st.all = !st.all; draw(); return; }

    const card = b.closest("[data-id]");
    const n = card && st.notes.find((x) => x.id === card.dataset.id);
    if (!n) return;
    if (act === "edit") { openEdit(n); return; }
    if (act === "pin") {
      n.pinned = !n.pinned;
      sortNotes(st.notes);
      draw();
      try { await patchNote(n.id, { pinned: n.pinned }); } catch (err) { fail(err, "pin the note"); load(); }
      return;
    }
    if (act === "color") {
      n.color = COLORS[(COLORS.indexOf(n.color) + 1) % COLORS.length];
      card.className = card.className.replace(/mn-c-\w+/, `mn-c-${n.color}`);
      try { await patchNote(n.id, { color: n.color }); } catch (err) { fail(err, "change the colour"); load(); }
      return;
    }
    if (act === "del") {
      const ok = await confirmDialog({ title: "Delete this note?", message: "It can't be brought back.", confirmLabel: "Delete", tone: "danger" });
      if (!ok) return;
      if (st.draft && st.draft.id === n.id) st.draft = null;
      st.notes = st.notes.filter((x) => x.id !== n.id);
      draw();
      try { await deleteDoc(doc(db, "staff_notes", n.id)); } catch (err) { fail(err, "delete the note"); load(); }
    }
  });

  /* ---------- Typing in the editor ---------- */
  host.addEventListener("input", (e) => {
    const d = st.draft;
    if (!d) return;
    if (e.target.dataset.f === "text") { d.text = e.target.value; grow(e.target); return; }
    if (e.target.dataset.item !== undefined) { const it = d.items[Number(e.target.dataset.item)]; if (it) it.t = e.target.value; }
  });
  host.addEventListener("keydown", (e) => {
    const d = st.draft;
    if (!d || !e.target.closest("[data-compose]")) return;
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); return; }
    if (e.target.dataset.item === undefined) return;
    const i = Number(e.target.dataset.item);
    // Enter: a new item underneath. Backspace on an empty item: remove it.
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (d.items.length >= 30) { showToast("A checklist can have up to 30 items."); return; }
      d.items.splice(i + 1, 0, { t: "", done: false });
      draw(`[data-item="${i + 1}"]`);
    } else if (e.key === "Backspace" && !e.target.value && d.items.length > 1) {
      e.preventDefault();
      d.items.splice(i, 1);
      draw(`[data-item="${Math.max(0, i - 1)}"]`);
    }
  });

  // Ticking an item on a saved checklist
  host.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.tick === undefined) return;
    const n = st.notes.find((x) => x.id === t.closest("[data-id]").dataset.id);
    if (!n) return;
    n.items = n.items.map((it, i) => (i === Number(t.dataset.tick) ? { ...it, done: t.checked } : it));
    t.nextElementSibling.classList.toggle("is-done", t.checked);
    const sm = t.closest(".mn-note").querySelector(".mn-foot small");
    if (sm) sm.textContent = `${when(new Date())} · ${n.items.filter((i) => i.done).length} of ${n.items.length} done`;
    try { await patchNote(n.id, { items: n.items }); } catch (err) { fail(err, "tick the item"); load(); }
  });

  load();
}