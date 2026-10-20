// Recall (#/recall): patients due for their next treatment, worked by the recall team.
// The cards (recalls/{id}) are made, booked and closed by Apps Script (Code.gs → Recall) from the appointment book.
// Every change here goes through Apps Script (action "recall"), so each card keeps a full history.
import { db, auth } from "./firebase-config.js";
import { collection, query, where, onSnapshot, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";
import { showToast } from "./utils.js";
import { normRecallSettings } from "./recall-settings.js";

const COL = "recalls";
const COLS = [
  ["due", "Waiting", "Shared out to the team each day"],
  ["call", "To call", ""],
  ["later", "Call back later", ""],
  ["booked", "Booked", "Closes when they come in"],
];
const OUTCOMES = [["no_answer", "No answer"], ["voicemail", "Left voicemail"], ["spoke", "Spoke to them"],
  ["texted", "Sent a text"], ["booked", "Booked"]];
const PAGE = 40;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayKey = () => fmtKey(new Date());
const keyDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (k, n) => { const d = keyDate(k); d.setDate(d.getDate() + n); return fmtKey(d); };
const nice = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; };
const short = (k) => { const d = keyDate(k); return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""; };
const daysFrom = (a, b) => { const x = keyDate(a), y = keyDate(b); return x && y ? Math.round((y - x) / 86400000) : 0; };
const when = (iso) => { const d = new Date(iso || ""); return isNaN(d) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
const first = (n) => String(n || "").split(" ")[0];
const tagClass = (cat) => { let h = 0; for (const ch of String(cat)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `rc-t${h % 6}`; };
const colOf = (c) => (c.status === "booked" ? "booked" : c.stage === "call" || c.stage === "later" ? c.stage : "due");
const me = () => (auth.currentUser && auth.currentUser.uid) || "";
const can = (staff, p) => !!staff && (/^admin$/i.test(String(staff.role || "")) || (Array.isArray(staff.perms) && staff.perms.includes(p)));
const errText = (err, fallback) => (err && err.code === "permission-denied"
  ? "You don't have access to Recall. Check Recall access in Staff, and that the Firestore rules are published."
  : (err && err.message) || fallback);

function norm(snap) {
  const x = snap.data() || {};
  const s = (k) => String(x[k] || "");
  return {
    id: snap.id, patientId: s("patientId"), patientName: s("patientName"), mobile: s("mobile"), email: s("email"),
    category: s("category"), lastVisit: s("lastVisit"), lastStaff: s("lastStaff"),
    lastServices: Array.isArray(x.lastServices) ? x.lastServices.map(String) : [],
    dueDate: s("dueDate"), status: s("status") || "open", stage: s("stage") || "due",
    assignedToId: s("assignedToId"), assignedToName: s("assignedToName"), remindOn: s("remindOn"), pauseReason: s("pauseReason"),
    attempts: Number(x.attempts) || 0, bookedFor: s("bookedFor"), bookedAt: s("bookedAt"),
    closeReason: s("closeReason"), closedAt: s("closedAt"), closedBy: s("closedBy"),
    log: Array.isArray(x.log) ? x.log : [], updatedAt: s("updatedAt"),
  };
}

export function mountRecall(container, { staff = null } = {}) {
  const root = document.createElement("section");
  root.className = "page rc";
  root.innerHTML = `
    <div class="rc-top"><h2>Recall</h2><span class="inv-spacer"></span>
      ${can(staff, "recall.manage") ? '<a class="lh-btn is-quiet" href="#/settings/recall">Recall settings</a>' : ""}</div>
    <div class="rc-stats" data-role="stats"></div>
    <div class="rc-tools">
      <input type="search" class="fe-input" data-role="q" placeholder="Find a patient by name, mobile or email" aria-label="Find a patient" />
      <select class="fb-select" data-role="cat" aria-label="Treatment"><option value="">All treatments</option></select>
      <select class="fb-select" data-role="who" aria-label="Whose">
        <option value="all">Everyone's</option><option value="mine">Mine</option><option value="nobody">Not given to anyone</option></select>
    </div>
    <div class="rc-layout">
      <div class="rc-board" data-role="board"><div class="skeleton" style="height:320px;border-radius:14px"></div></div>
      <aside class="tb-card rc-panel" data-role="panel" aria-label="Recall card" hidden></aside>
    </div>`;
  container.replaceChildren(root);
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const WIDE = window.matchMedia("(min-width: 1400px)");   // the card sits beside the board (same as styles.css)

  let cards = null;
  const extra = new Map();   // cards no longer on the board (closed), still open in the panel
  const ui = { q: "", cat: "", who: "all", shown: {} };
  let sel = "";
  let panelSig = "";
  let draft = { out: "", note: "", remind: "", reason: "", until: "" };
  let busy = false;
  let back = null;
  let people = [];
  let settings = normRecallSettings({});

  getDoc(doc(db, "recall_settings", "config")).then((s) => { settings = normRecallSettings(s.exists() ? s.data() : {}); drawPanel(true); }).catch(() => {});
  callApi({ action: "staffList" }).then((r) => { people = (r && r.staff) || []; drawPanel(true); }).catch(() => {});

  async function loadBack() {
    const start = `${todayKey().slice(0, 8)}01`;
    try {
      const [a, b] = await Promise.all([
        getDocs(query(collection(db, COL), where("bookedAt", ">=", keyDate(start).toISOString()))),
        getDocs(query(collection(db, COL), where("visitedOn", ">=", start))),
      ]);
      const ids = new Set();
      a.forEach((d) => ids.add(d.id));
      b.forEach((d) => ids.add(d.id));
      back = ids.size;
    } catch (err) { console.warn("Recall: this month's count failed:", err); back = null; }
    drawStats();
  }
  loadBack();

  /* ---------- The board ---------- */
  function visible() {
    const q = ui.q.trim().toLowerCase();
    const uid = me();
    return [...cards.values()].filter((c) =>
      (!ui.cat || c.category === ui.cat) &&
      (ui.who === "all" || (ui.who === "mine" ? c.assignedToId === uid : !c.assignedToId)) &&
      (!q || `${c.patientName} ${c.mobile} ${c.email}`.toLowerCase().includes(q)));
  }
  const sorter = {
    due: (a, b) => a.dueDate.localeCompare(b.dueDate),
    call: (a, b) => a.dueDate.localeCompare(b.dueDate),
    later: (a, b) => a.remindOn.localeCompare(b.remindOn),
    booked: (a, b) => (a.bookedFor || "9").localeCompare(b.bookedFor || "9"),
  };

  function cardHtml(c) {
    const t = todayKey();
    const over = daysFrom(c.dueDate, t);
    const line = c.status === "booked" ? esc(c.bookedFor ? `Booked for ${short(c.bookedFor)}` : "Booked by phone")
      : c.stage === "later" ? esc(`${c.pauseReason ? "Paused until" : "Call"} ${short(c.remindOn)}`)
      : over > 0 ? `<span class="rc-late">${over} day${over === 1 ? "" : "s"} overdue</span>`
      : esc(`Due ${short(c.dueDate)}`);
    const right = [first(c.assignedToName), c.attempts ? `${c.attempts} tr${c.attempts === 1 ? "y" : "ies"}` : ""].filter(Boolean).join(" · ");
    return `<button type="button" class="rc-card${c.id === sel ? " is-on" : ""}" data-card="${esc(c.id)}">
      <strong>${esc(c.patientName || "Unknown patient")}</strong>
      <span class="rc-tag ${tagClass(c.category)}">${esc(c.category)}</span>
      <span class="rc-meta"><span>${line}</span><span>${esc(right)}</span></span></button>`;
  }

  function drawStats() {
    if (!cards) return;
    const uid = me();
    const open = [...cards.values()].filter((c) => c.status === "open");
    const box = (label, val, cls = "") => `<div class="rc-stat"><small>${esc(label)}</small><strong class="${cls}">${esc(String(val))}</strong></div>`;
    $("stats").innerHTML = box("Due now", open.length) +
      box("Waiting for the team", open.filter((c) => colOf(c) === "due").length) +
      box("Mine to call", open.filter((c) => c.stage === "call" && c.assignedToId === uid).length) +
      box("Booked or came in this month", back == null ? "–" : back, "rc-good");
  }

  function drawBoard() {
    if (!cards) return;
    const cats = [...new Set([...cards.values()].map((c) => c.category))].sort();
    const catSel = $("cat");
    if (ui.cat && !cats.includes(ui.cat)) cats.push(ui.cat);
    catSel.innerHTML = `<option value="">All treatments</option>${cats.map((c) =>
      `<option value="${esc(c)}"${c === ui.cat ? " selected" : ""}>${esc(c)}</option>`).join("")}`;
    const rows = visible();
    $("board").innerHTML = COLS.map(([k, label, help]) => {
      const list = rows.filter((c) => colOf(c) === k).sort(sorter[k]);
      const n = ui.shown[k] || PAGE;
      return `<div class="rc-col">
        <div class="rc-col-h"><strong>${esc(label)}</strong><em>${list.length}</em></div>
        ${help ? `<small class="rc-col-help">${esc(help)}</small>` : ""}
        ${list.length ? list.slice(0, n).map(cardHtml).join("") : '<p class="muted rc-none">Nobody here.</p>'}
        ${list.length > n ? `<button type="button" class="lh-btn is-quiet rc-more" data-more="${k}">Show ${Math.min(PAGE, list.length - n)} more</button>` : ""}
      </div>`;
    }).join("");
  }

  /* ---------- One card ---------- */
  function drawPanel(force) {
    const p = $("panel");
    const c = sel ? (cards && cards.get(sel)) || extra.get(sel) : null;
    if (!c) { p.hidden = true; p.innerHTML = ""; panelSig = ""; return; }
    const sig = `${c.id}|${c.updatedAt}|${c.status}`;
    if (!force && sig === panelSig) return;
    panelSig = sig;
    p.hidden = false;

    const t = todayKey();
    const over = daysFrom(c.dueDate, t);
    const team = new Set(settings.team);
    const ppl = [...people].sort((a, b) => (team.has(b.id) - team.has(a.id)) || String(a.name).localeCompare(String(b.name)));
    if (c.assignedToId && !ppl.some((s) => s.id === c.assignedToId)) ppl.unshift({ id: c.assignedToId, name: c.assignedToName || "Someone" });
    const reason = settings.reasons.find((r) => r.label === draft.reason);
    const sub = [
      c.category,
      `due ${nice(c.dueDate)}${over > 0 ? ` (${over} day${over === 1 ? "" : "s"} ago)` : ""}`,
      c.lastVisit ? `last visit ${nice(c.lastVisit)}${c.lastStaff ? ` with ${c.lastStaff}` : ""}` : "",
    ].filter(Boolean).join(" · ");

    let work;
    if (c.status === "closed") {
      work = `<div class="rc-state">Closed: ${esc(c.closeReason)}${c.closedBy ? ` · ${esc(c.closedBy)}` : ""}${c.closedAt ? ` · ${esc(when(c.closedAt))}` : ""}</div>
        ${c.closeReason === "Came in" ? "" : '<button type="button" class="lh-btn" data-act="reopen">Reopen</button>'}`;
    } else if (c.status === "booked") {
      work = `<div class="rc-state is-ok">${c.bookedFor
        ? `Booked for ${esc(nice(c.bookedFor))}. The card closes by itself when they come in.`
        : "Marked as booked by phone. If it isn't in the appointment book within 3 days, the card goes back to To call."}</div>
        <button type="button" class="lh-btn" data-act="reopen">Not booked after all</button>`;
    } else {
      work = `
        <h4 class="rc-h">Log a call</h4>
        <div class="rc-outs">${OUTCOMES.map(([k, l]) => `<button type="button" class="ch-chip${draft.out === k ? " is-on" : ""}" data-out="${k}">${esc(l)}</button>`).join("")}</div>
        <textarea class="fe-input rc-note" data-role="note" rows="2" maxlength="1000" placeholder="Prefers Thursday mornings">${esc(draft.note)}</textarea>
        <div class="rc-row">
          <label>Call back on <input type="date" class="fe-input" data-role="remind" min="${addDays(t, 1)}" value="${esc(draft.remind)}" /></label>
          <span class="inv-spacer"></span>
          <button type="button" class="btn-primary" data-act="save">Save</button>
        </div>
        <h4 class="rc-h">Stop recall</h4>
        <div class="rc-row">
          <select class="fb-select" data-role="reason" aria-label="Reason">
            <option value="">Choose a reason</option>${settings.reasons.map((r) =>
              `<option value="${esc(r.label)}"${r.label === draft.reason ? " selected" : ""}>${esc(r.label)}</option>`).join("")}</select>
          ${reason && reason.askDate ? `<label>until <input type="date" class="fe-input" data-role="until" min="${addDays(t, 1)}" value="${esc(draft.until)}" /></label>` : ""}
          <button type="button" class="lh-btn" data-act="close">${reason && reason.askDate ? "Pause" : "Stop"}</button>
        </div>
        ${reason && reason.dnc ? '<small class="fe-note">This also puts them on the do-not-contact list.</small>' : ""}`;
    }

    p.innerHTML = `
      <div class="rc-p-top"><h3>${esc(c.patientName || "Unknown patient")}</h3>
        <button type="button" class="lh-btn is-quiet" data-act="deselect" aria-label="Close">×</button></div>
      <p class="rc-sub">${esc(sub)}${c.lastServices.length ? `<br>${esc(c.lastServices.join(", "))}` : ""}</p>
      <div class="rc-links">
        ${c.mobile ? `<a class="lh-btn" href="tel:${esc(c.mobile.replace(/[^\d+]/g, ""))}">Call ${esc(c.mobile)}</a>` : ""}
        ${c.email ? `<a class="lh-btn is-quiet" href="mailto:${esc(c.email)}">Email</a>` : ""}
        ${c.patientId ? `<a class="lh-btn is-quiet" href="#/patient/${encodeURIComponent(c.patientId)}">Patient page</a>` : ""}
      </div>
      ${c.status === "closed" ? "" : `<div class="rc-row">Given to
        <select class="fb-select" data-role="assign" aria-label="Given to">
          <option value="">Nobody yet (waiting)</option>${ppl.map((s) =>
            `<option value="${esc(s.id)}"${s.id === c.assignedToId ? " selected" : ""}>${esc(s.name)}${team.size && !team.has(s.id) ? " (not in the recall team)" : ""}</option>`).join("")}
        </select></div>`}
      ${work}
      <h4 class="rc-h">History</h4>
      <ul class="rc-log">${c.log.slice().reverse().map((l) => `<li><strong>${esc(l.what)}</strong>
        ${l.note ? `<p>${esc(l.note)}</p>` : ""}<small>${esc(when(l.at))}${l.by ? ` · ${esc(l.by)}` : ""}</small></li>`).join("")}</ul>`;
  }

  function select(id) {
    sel = id;
    draft = { out: "", note: "", remind: "", reason: "", until: "" };
    drawBoard();
    drawPanel(true);
    if (!WIDE.matches) $("panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function act(op, extraBody, btn) {
    if (busy) return false;
    busy = true;
    if (btn) btn.disabled = true;
    try {
      const res = await callApi({ action: "recall", op, id: sel, ...extraBody });
      if (res && res.problem) { showToast(res.problem); return false; }
      return true;
    } catch (err) {
      showToast(errText(err, "Couldn't save. Try again."));
      return false;
    } finally {
      busy = false;
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  // A card that's left the board (closed) stays open in the panel
  async function keepOpen(id) {
    try { const s = await getDoc(doc(db, COL, id)); if (s.exists()) extra.set(id, norm(s)); } catch { /* the panel just closes */ }
    if (sel === id) drawPanel(true);
  }

  /* ---------- Live ---------- */
  const stop = onSnapshot(query(collection(db, COL), where("status", "in", ["open", "booked"])), (snap) => {
    if (!root.isConnected) { stop(); return; }
    cards = new Map(snap.docs.map((d) => [d.id, norm(d)]));
    if (sel && !cards.has(sel) && !extra.has(sel)) keepOpen(sel);
    drawStats();
    drawBoard();
    drawPanel(false);
  }, (err) => {
    if (!root.isConnected) return;
    console.error("Recall failed:", err);
    $("board").innerHTML = `<div class="tm-empty is-error">${esc(errText(err, "Couldn't load Recall."))}</div>`;
  });
  window.addEventListener("hashchange", function off() {
    setTimeout(() => { if (!root.isConnected) { stop(); window.removeEventListener("hashchange", off); } }, 0);
  });

  /* ---------- Events ---------- */
  root.addEventListener("input", (e) => {
    const r = e.target.dataset.role;
    if (r === "q") { ui.q = e.target.value; ui.shown = {}; drawBoard(); }
    else if (r === "note") draft.note = e.target.value;
  });
  root.addEventListener("change", async (e) => {
    const el = e.target;
    const r = el.dataset.role;
    if (r === "cat") { ui.cat = el.value; ui.shown = {}; drawBoard(); return; }
    if (r === "who") { ui.who = el.value; ui.shown = {}; drawBoard(); return; }
    if (r === "remind") { draft.remind = el.value; return; }
    if (r === "until") { draft.until = el.value; return; }
    if (r === "reason") { draft.reason = el.value; drawPanel(true); return; }
    if (r === "assign") {
      if (!(await act("assign", { toId: el.value }, el))) drawPanel(true);
    }
  });
  root.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-card]");
    if (card) { select(card.dataset.card); return; }
    const more = e.target.closest("[data-more]");
    if (more) { ui.shown[more.dataset.more] = (ui.shown[more.dataset.more] || PAGE) + PAGE; drawBoard(); return; }
    const out = e.target.closest("[data-out]");
    if (out) { draft.out = draft.out === out.dataset.out ? "" : out.dataset.out; drawPanel(true); return; }
    if (e.target.closest('[data-act="deselect"]')) { sel = ""; drawBoard(); drawPanel(true); return; }

    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "save") {
      if (!draft.out && !draft.note.trim() && !draft.remind) { showToast("Choose what happened, or write a note."); return; }
      if (await act("log", { outcome: draft.out, note: draft.note, remindOn: draft.remind }, b)) {
        draft = { ...draft, out: "", note: "", remind: "" };
        drawPanel(true);
        showToast("Saved");
      }
      return;
    }
    if (b.dataset.act === "close") {
      const r = settings.reasons.find((x) => x.label === draft.reason);
      if (!r) { showToast("Choose a reason."); return; }
      if (r.askDate && !draft.until) { showToast("Choose when to start recalling them again."); return; }
      if (r.dnc && !(await confirmDialog({ title: "Don't contact again?", message: "Recall stops, and they go on the do-not-contact list for marketing emails.", confirmLabel: "Stop and add to the list", tone: "danger" }))) return;
      const id = sel;
      if (await act("close", { reason: r.label, until: draft.until, note: draft.note }, b)) {
        draft = { out: "", note: "", remind: "", reason: "", until: "" };
        drawPanel(true);
        showToast(r.askDate ? "Paused" : "Recall stopped");
        if (!r.askDate) keepOpen(id);
      }
      return;
    }
    if (b.dataset.act === "reopen") {
      if (await act("reopen", {}, b)) { extra.delete(sel); showToast("Reopened"); }
    }
  });
}