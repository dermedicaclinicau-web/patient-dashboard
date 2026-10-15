// My dashboard → My notes: a private scratchpad. Firestore staff_notes; only the person who wrote a note can see or change it.
// Plain notes or checklists (every line starting with "-"), five colours, pin to the top.
import { db, auth } from "./firebase-config.js";
import {
  collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from "./utils.js";
import { confirmDialog } from "./dialog.js";

const COLORS = ["yellow", "green", "blue", "pink", "grey"];
const SHOW = 6;
const LIST_RE = /^\s*(?:-|\*|•|\[\s?\]|\[x\])\s*/i;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  pin: svg('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>'),
  palette: svg('<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  list: svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><polyline points="3 6 4 7 6 5"/><polyline points="3 12 4 13 6 11"/><polyline points="3 18 4 19 6 17"/>'),
};
const myUid = () => (auth.currentUser && auth.currentUser.uid) || "";

// "- Order gloves\n- Chase PO" → a checklist; anything else → plain text
function parse(raw) {
  const lines = String(raw || "").replace(/\r/g, "").split("\n").map((s) => s.trimEnd()).filter((l) => l.trim());
  if (lines.length && lines.every((l) => LIST_RE.test(l))) {
    return { text: "", items: lines.map((l) => ({ t: l.replace(LIST_RE, "").trim().slice(0, 200), done: /^\s*\[x\]/i.test(l) }))
      .filter((i) => i.t).slice(0, 30) };
  }
  return { text: lines.join("\n").slice(0, 2000), items: [] };
}
const toRaw = (n) => (n.items.length ? n.items.map((i) => `${i.done ? "[x]" : "-"} ${i.t}`).join("\n") : n.text);

/* ---------- Data ---------- */
async function listNotes() {
  const snap = await getDocs(query(collection(db, "staff_notes"), where("ownerUid", "==", myUid())));
  const t = (n) => (n.at ? n.at.getTime() : Date.now());
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, text: String(x.text || ""), items: Array.isArray(x.items) ? x.items : [],
      color: COLORS.includes(x.color) ? x.color : "yellow", pinned: x.pinned === true,
      at: x.updatedAt && x.updatedAt.toDate ? x.updatedAt.toDate() : null,
    };
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || t(b) - t(a));
}
const addNote = (raw, color) => addDoc(collection(db, "staff_notes"), {
  ownerUid: myUid(), ...parse(raw), color, pinned: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
});
const patchNote = (id, data) => updateDoc(doc(db, "staff_notes", id), { ...data, updatedAt: serverTimestamp() });

/* ---------- The card ---------- */
export function mountMyNotes(host) {
  if (!host) return;
  const st = { notes: [], all: false, editing: "", color: "yellow", loading: true, error: "" };

  host.innerHTML = `<div class="mn">
    <div class="md-card-head"><h3>My notes</h3><small class="muted">Only you can see these</small></div>
    <div class="mn-add">
      <textarea class="fe-input mn-in" data-role="in" rows="1" maxlength="2000" placeholder="Write a note and press Enter"></textarea>
      <div class="mn-tools">
        ${COLORS.map((c) => `<button type="button" class="mn-sw mn-c-${c}${c === st.color ? " is-on" : ""}" data-color="${c}"
          aria-label="${c} note" aria-pressed="${c === st.color}"></button>`).join("")}
        <button type="button" class="mn-listbtn" data-act="list" title="Make it a checklist">${I.list}<span>Checklist</span></button>
      </div>
      <small class="muted mn-hint">Shift+Enter starts a new line. Start each line with “-” for a checklist.</small>
    </div>
    <div data-role="list"><div class="skeleton sm"></div></div>
  </div>`;
  const $in = host.querySelector('[data-role="in"]');
  const $list = host.querySelector('[data-role="list"]');
  const grow = (el) => { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 220)}px`; };

  const when = (d) => {
    if (!d) return "Just now";
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  };

  function noteHtml(n) {
    const editing = st.editing === n.id;
    const done = n.items.filter((i) => i.done).length;
    const body = editing
      ? `<textarea class="fe-input mn-edit" data-role="edit" maxlength="2000">${esc(toRaw(n))}</textarea>
         <small class="mn-edit-hint">Ctrl+Enter or click away to save · Esc to cancel</small>`
      : n.items.length
        ? `<ul class="mn-items">${n.items.map((it, i) => `<li><label><input type="checkbox" data-tick="${i}"${it.done ? " checked" : ""} />
            <span${it.done ? ' class="is-done"' : ""}>${esc(it.t)}</span></label></li>`).join("")}</ul>`
        : `<p class="mn-text" data-act="edit" title="Click to edit">${esc(n.text)}</p>`;
    return `<article class="mn-note mn-c-${n.color}${n.pinned ? " is-pinned" : ""}" data-id="${esc(n.id)}">
      ${body}
      <div class="mn-foot">
        <small>${n.pinned ? "Pinned · " : ""}${esc(when(n.at))}${n.items.length ? ` · ${done}/${n.items.length} done` : ""}</small>
        <span class="mn-acts">
          <button type="button" data-act="pin" class="${n.pinned ? "is-on" : ""}" aria-label="${n.pinned ? "Unpin" : "Pin to the top"}" title="${n.pinned ? "Unpin" : "Pin to the top"}">${I.pin}</button>
          <button type="button" data-act="color" aria-label="Change colour" title="Change colour">${I.palette}</button>
          <button type="button" data-act="edit" aria-label="Edit" title="Edit">${I.edit}</button>
          <button type="button" data-act="del" aria-label="Delete" title="Delete">${I.trash}</button>
        </span>
      </div>
    </article>`;
  }

  function draw() {
    if (st.loading) return;
    if (st.error) { $list.innerHTML = `<p class="rc-empty">${esc(st.error)}</p>`; return; }
    if (!st.notes.length) { $list.innerHTML = '<p class="mn-empty">Jot down anything you need to remember today. Your notes stay here until you delete them.</p>'; return; }
    const shown = st.all ? st.notes : st.notes.slice(0, SHOW);
    $list.innerHTML = `<div class="mn-grid">${shown.map(noteHtml).join("")}</div>${st.notes.length > SHOW
      ? `<button type="button" class="cs-link mn-more" data-act="more">${st.all ? "Show fewer" : `Show all ${st.notes.length} notes`}</button>` : ""}`;
    if (st.editing) {
      const ed = $list.querySelector('[data-role="edit"]');
      if (ed) { grow(ed); ed.focus(); ed.setSelectionRange(ed.value.length, ed.value.length); }
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

  async function saveEdit(n, raw) {
    st.editing = "";
    const p = parse(raw);
    if (!p.text && !p.items.length) { draw(); return; }        // emptied: keep the note as it was
    if (p.text === n.text && JSON.stringify(p.items) === JSON.stringify(n.items)) { draw(); return; }
    Object.assign(n, p, { at: new Date() });
    draw();
    try { await patchNote(n.id, p); } catch (err) { fail(err, "save the note"); load(); }
  }

  /* ---------- Adding ---------- */
  $in.addEventListener("input", () => grow($in));
  $in.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    const raw = $in.value;
    if (!raw.trim()) return;
    $in.disabled = true;
    try {
      await addNote(raw, st.color);
      $in.value = "";
      grow($in);
      await load();
    } catch (err) { fail(err, "add the note"); }
    finally { $in.disabled = false; $in.focus(); }
  });

  host.addEventListener("click", async (e) => {
    const sw = e.target.closest("[data-color]");
    if (sw) {
      st.color = sw.dataset.color;
      host.querySelectorAll("[data-color]").forEach((b) => {
        const on = b.dataset.color === st.color;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", String(on));
      });
      $in.focus();
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "list") {   // turn what's typed into checklist lines
      const lines = $in.value.split("\n").map((l) => l.trim());
      $in.value = lines.filter(Boolean).length ? lines.filter(Boolean).map((l) => (LIST_RE.test(l) ? l : `- ${l}`)).join("\n") + "\n- " : "- ";
      grow($in);
      $in.focus();
      return;
    }
    if (act === "more") { st.all = !st.all; draw(); return; }

    const card = b.closest("[data-id]");
    const n = card && st.notes.find((x) => x.id === card.dataset.id);
    if (!n) return;
    if (act === "edit") { if (st.editing !== n.id) { st.editing = n.id; draw(); } return; }
    if (act === "pin") {
      n.pinned = !n.pinned;
      st.notes.sort((a, c) => Number(c.pinned) - Number(a.pinned));
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
      st.notes = st.notes.filter((x) => x.id !== n.id);
      draw();
      try { await deleteDoc(doc(db, "staff_notes", n.id)); } catch (err) { fail(err, "delete the note"); load(); }
    }
  });

  // Ticking a checklist item
  host.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.tick === undefined) return;
    const n = st.notes.find((x) => x.id === t.closest("[data-id]").dataset.id);
    if (!n) return;
    n.items = n.items.map((it, i) => (i === Number(t.dataset.tick) ? { ...it, done: t.checked } : it));
    t.nextElementSibling.classList.toggle("is-done", t.checked);
    const sm = t.closest(".mn-note").querySelector(".mn-foot small");
    if (sm) sm.textContent = `${n.pinned ? "Pinned · " : ""}${when(new Date())} · ${n.items.filter((i) => i.done).length}/${n.items.length} done`;
    try { await patchNote(n.id, { items: n.items }); } catch (err) { fail(err, "tick the item"); load(); }
  });

  // Editing: Ctrl+Enter or clicking away saves, Esc cancels
  host.addEventListener("keydown", (e) => {
    if (e.target.dataset.role !== "edit") return;
    const n = st.notes.find((x) => x.id === st.editing);
    if (e.key === "Escape") { st.editing = ""; draw(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && n) { e.preventDefault(); saveEdit(n, e.target.value); }
  });
  host.addEventListener("input", (e) => { if (e.target.dataset.role === "edit") grow(e.target); });
  host.addEventListener("focusout", (e) => {
    if (e.target.dataset.role !== "edit") return;
    const n = st.notes.find((x) => x.id === st.editing);
    if (n) saveEdit(n, e.target.value);
  });

  load();
}