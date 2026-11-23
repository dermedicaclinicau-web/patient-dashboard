// Settings → Start of Day → Announcements: clinic news on each person's Start of Day.
// sod_announcements/{id}: { title, body, from, until, everyone, roles, staffIds, confirm, important, round,
//   ended, deleted, createdBy, updatedBy… }. Deleting only hides it (deleted: true), so its history stays.
// sod_announcements/{id}/reads/{uid}: { uid, name, round, seenAt, confirmedAt }, written by each person for themselves.
// "round" goes up when an admin asks everyone to read it again: reads from an earlier round no longer count.

import { db } from "./firebase-config.js";
import { collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { escapeHtml, showToast, toDateKey } from "./utils.js";
import { can } from "./perms.js";
import { callApi } from "./appointments.js";
import { confirmDialog } from "./dialog.js";

const COL = "sod_announcements";
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const esc = (s) => escapeHtml(String(s ?? ""));
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const me = () => getAuth().currentUser;
const nameOf = (staff) => String((staff && staff.name) || "").slice(0, 120);
const niceKey = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const when = (d) => (d ? d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const time = (d) => (d ? d.getTime() : 0);

function normAnn(d) {
  const x = d.data() || {};
  return {
    id: d.id, title: String(x.title || ""), body: String(x.body || ""),
    from: KEY_RE.test(x.from || "") ? x.from : "", until: KEY_RE.test(x.until || "") ? x.until : "",
    everyone: x.everyone !== false,
    roles: Array.isArray(x.roles) ? x.roles.map(String) : [],
    staffIds: Array.isArray(x.staffIds) ? x.staffIds.map(String) : [],
    confirm: x.confirm === true, important: x.important === true, round: Number(x.round) || 0,
    ended: x.ended === true, deleted: x.deleted === true,
    createdBy: String(x.createdBy || ""), createdAt: toDate(x.createdAt),
    endedBy: String(x.endedBy || ""), endedAt: toDate(x.endedAt),
  };
}

// "live", "scheduled" (starts later) or "ended" (ended by hand, or past its end date)
export function annState(a, today = toDateKey()) {
  if (a.ended || (a.until && a.until < today)) return "ended";
  if (a.from && a.from > today) return "scheduled";
  return "live";
}

// Is this announcement for this person?
export function annFor(a, { uid = "", role = "" } = {}) {
  if (a.everyone) return true;
  const r = String(role || "").toLowerCase();
  return (!!uid && a.staffIds.includes(uid)) || (!!r && a.roles.some((x) => x.toLowerCase() === r));
}

async function listAll() {
  const snap = await getDocs(collection(db, COL));
  return snap.docs.map(normAnn).filter((a) => !a.deleted);
}

/* ===================== For staff: Start of Day and the pop-up ===================== */

// The live announcements for this person, newest first, each with seen / confirmed (this round)
export async function listMyAnnouncements(staff) {
  const u = me();
  if (!u || !staff) return [];
  const list = (await listAll())
    .filter((a) => annState(a) === "live" && annFor(a, { uid: staff.uid || u.uid, role: staff.role || staff.staffRole }))
    .sort((a, b) => b.from.localeCompare(a.from) || time(b.createdAt) - time(a.createdAt));
  const reads = await Promise.all(list.map((a) => getDoc(doc(db, COL, a.id, "reads", u.uid)).catch(() => null)));
  return list.map((a, i) => {
    const r = reads[i] && reads[i].exists() ? reads[i].data() : null;
    const now = !!r && (Number(r.round) || 0) === a.round;
    return { ...a, seen: now && !!r.seenAt, confirmed: now && !!r.confirmedAt };
  });
}

// Shown to them: counts as seen (only the first time each round)
export async function markSeen(list, staff) {
  const u = me();
  if (!u) return;
  await Promise.all(list.filter((a) => !a.seen).map((a) => {
    a.seen = true;
    return setDoc(doc(db, COL, a.id, "reads", u.uid), {
      uid: u.uid, name: nameOf(staff), round: a.round, seenAt: serverTimestamp(), confirmedAt: null,
    }, { merge: true }).catch((err) => console.warn("Announcement not marked as seen:", err));
  }));
  window.dispatchEvent(new Event("sod:announcements"));   // the number on My day follows
}

export async function confirmRead(a, staff) {
  const u = me();
  if (!u) throw new Error("Your session has ended. Log in again.");
  await setDoc(doc(db, COL, a.id, "reads", u.uid), {
    uid: u.uid, name: nameOf(staff), round: a.round, confirmedAt: serverTimestamp(),
    ...(a.seen ? {} : { seenAt: serverTimestamp() }),
  }, { merge: true });
}

export function annCardHtml(a) {
  return `<article class="sda-item${a.important ? " is-important" : ""}" data-ann="${esc(a.id)}">
    <b>${esc(a.title)}</b>
    <div class="sda-body">${esc(a.body).replace(/\n/g, "<br>")}</div>
    ${a.confirm ? (a.confirmed ? '<p class="sda-done">You\'ve confirmed you read this.</p>'
      : '<button type="button" class="sda-confirm" data-ann-confirm>I\'ve read this</button>') : ""}
  </article>`;
}

// The "I've read this" buttons inside root
export function wireAnnouncements(root, list, staff, { preview = false } = {}) {
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ann-confirm]");
    if (!b || b.disabled) return;
    const item = b.closest("[data-ann]");
    const a = item && list.find((x) => x.id === item.dataset.ann);
    if (!a) return;
    if (preview) { showToast("Preview only. Nothing was saved."); return; }
    b.disabled = true;
    b.textContent = "Saving…";
    try {
      await confirmRead(a, staff);
      a.seen = a.confirmed = true;
      window.dispatchEvent(new Event("sod:announcements"));
      b.outerHTML = '<p class="sda-done">Thanks. You\'ve confirmed you read this.</p>';
    } catch (err) {
      console.warn("Announcement not confirmed:", err);
      b.disabled = false;
      b.textContent = "I've read this";
      showToast(err && err.code === "permission-denied"
        ? "Couldn't save: check the sod_announcements Firestore rule has been published."
        : "Couldn't save. Check your connection and try again.");
    }
  });
}

/* ---------- The pop-up: announcements to confirm, posted after someone has started their day ---------- */
let popStaff = null;
let popReady = null;
let popWired = false;
let popBusy = false;
let popLast = 0;
const popped = new Set();   // shown in this tab already

// ready(): true once their day has started (or Start of Day is off for them)
export function watchAnnouncements(staff, { ready }) {
  popStaff = staff;
  popReady = ready;
  if (!popWired) {
    popWired = true;
    const go = () => { if (document.visibilityState === "visible") checkPopups(); };
    window.addEventListener("hashchange", go);
    document.addEventListener("visibilitychange", go);
    setInterval(go, 5 * 60000);
  }
  setTimeout(checkPopups, 4000);
}

export function stopAnnouncements() {
  popStaff = null;
  popLast = 0;
  popped.clear();
}

async function checkPopups() {
  const staff = popStaff;
  if (!staff || popBusy || Date.now() - popLast < 90000) return;
  if (document.querySelector("dialog[open]")) return;   // never on top of another window
  popBusy = true;
  popLast = Date.now();
  try {
    if (!(await popReady())) return;   // not started yet: their Start of Day shows it
    const list = (await listMyAnnouncements(staff)).filter((a) => a.confirm && !a.confirmed && !a.seen && !popped.has(a.id));
    if (!list.length || popStaff !== staff || document.querySelector("dialog[open]")) return;
    list.forEach((a) => popped.add(a.id));
    showPopup(list, staff);
  } catch (err) {
    console.warn("Announcements not checked:", err);
  } finally {
    popBusy = false;
  }
}

function showPopup(list, staff) {
  const d = document.createElement("dialog");
  d.className = "sda-pop";
  d.setAttribute("aria-label", "New announcement");
  d.innerHTML = `<div class="sda-pop-card">
      <p class="sda-pop-eyebrow">${list.length === 1 ? "New announcement" : `${list.length} new announcements`}</p>
      ${list.map(annCardHtml).join("")}
      <p class="sda-pop-note">Not now? ${list.length === 1 ? "It stays" : "They stay"} on your Start of Day until you confirm.</p>
      <div class="sda-pop-acts"><button type="button" class="sds-btn is-quiet" data-close>Close</button></div>
    </div>`;
  wireAnnouncements(d, list, staff);
  d.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === d) d.close(); });
  d.addEventListener("close", () => d.remove());
  document.body.appendChild(d);
  d.showModal();
  markSeen(list, staff);
}

/* ===================== Settings → Start of Day → Announcements ===================== */

export async function mountSodAnnouncements(host, { staff = null } = {}) {
  if (!can("sod.manage")) {
    host.innerHTML = `<section class="page"><div class="state"><strong>No access</strong>
      Posting announcements needs "Start of Day: set up the overlay and post announcements". Ask an admin.</div></section>`;
    return;
  }
  host.innerHTML = '<section class="page"><div class="sds sda"><div class="skeleton" style="height:320px;border-radius:14px"></div></div></section>';
  const root = host.querySelector(".sda");
  const st = { list: [], reads: new Map(), people: [], roles: [], view: "list", filter: "live", openId: "",
    f: null, dirty: false, busy: false, peopleOpen: false };

  async function load() {
    const [list, people] = await Promise.all([
      listAll(),
      st.people.length ? Promise.resolve(null)
        : callApi({ action: "staffList" }).then((r) => r.staff || []).catch((err) => { console.warn("Staff list not loaded:", err); return []; }),
    ]);
    st.list = list;
    if (people) {
      st.people = people.map((p) => ({ id: String(p.id || ""), name: String(p.name || ""), role: String(p.role || "") }))
        .filter((p) => p.id).sort((a, b) => a.name.localeCompare(b.name));
    }
    const roles = new Set(["Admin", ...st.people.map((p) => p.role).filter(Boolean), ...list.flatMap((a) => a.roles)]);
    st.roles = [...roles].sort((a, b) => (a === "Admin" ? -1 : b === "Admin" ? 1 : a.localeCompare(b)));
    const snaps = await Promise.all(list.filter((a) => annState(a) !== "scheduled").map((a) =>
      getDocs(collection(db, COL, a.id, "reads")).then((s) => [a.id, s]).catch(() => [a.id, null])));
    st.reads = new Map(snaps.map(([id, s]) => [id, new Map((s ? s.docs : []).map((d) => {
      const x = d.data() || {};
      return [d.id, { round: Number(x.round) || 0, seenAt: toDate(x.seenAt), confirmedAt: toDate(x.confirmedAt) }];
    }))]));
  }

  const byId = (id) => st.list.find((a) => a.id === id) || null;
  const audience = (a) => st.people.filter((p) => annFor(a, { uid: p.id, role: p.role }));
  const readOf = (a, uid) => {
    const r = (st.reads.get(a.id) || new Map()).get(uid);
    return r && r.round === a.round ? r : null;
  };
  const doneBy = (a, p) => { const r = readOf(a, p.id); return !!r && !!(a.confirm ? r.confirmedAt : r.seenAt); };
  const statText = (a) => {
    const who = audience(a);
    return `${a.confirm ? "Confirmed" : "Seen"} by ${who.filter((p) => doneBy(a, p)).length} of ${who.length}`;
  };
  const audText = (a) => (a.everyone ? "Everyone"
    : [...a.roles, a.staffIds.length ? `${a.staffIds.length} ${a.staffIds.length === 1 ? "person" : "people"}` : ""]
      .filter(Boolean).join(", ") || "No one");
  const dates = (a) => `${niceKey(a.from) || "From today"}${a.until ? ` to ${niceKey(a.until)}` : ", no end date"}`;
  const endText = (a) => (a.ended ? `Ended ${when(a.endedAt)}${a.endedBy ? ` by ${a.endedBy}` : ""}` : `Ended ${niceKey(a.until)}`);
  const blank = () => ({ id: "", title: "", body: "", from: toDateKey(), until: "", everyone: true, roles: [], staffIds: [],
    confirm: false, important: false, again: false });
  const fromAnn = (a) => ({ id: a.id, title: a.title, body: a.body, from: a.from || toDateKey(), until: a.until,
    everyone: a.everyone, roles: [...a.roles], staffIds: [...a.staffIds], confirm: a.confirm, important: a.important, again: false });

  function groups() {
    const g = { live: [], scheduled: [], ended: [] };
    st.list.forEach((a) => g[annState(a)].push(a));
    g.live.sort((a, b) => b.from.localeCompare(a.from) || time(b.createdAt) - time(a.createdAt));
    g.scheduled.sort((a, b) => a.from.localeCompare(b.from));
    const endT = (a) => time(a.endedAt) || (a.until ? new Date(`${a.until}T23:59:00`).getTime() : 0);
    g.ended.sort((a, b) => endT(b) - endT(a));
    return g;
  }

  /* ----- The list ----- */
  function listHtml() {
    const g = groups();
    const tabs = [["live", "Live"], ["scheduled", "Scheduled"], ["ended", "Ended"]];
    const rows = g[st.filter];
    const row = (a) => {
      const s = annState(a);
      return `<button type="button" class="sda-row${a.important ? " is-important" : ""}" data-open="${esc(a.id)}">
        <span class="sda-row-main"><b>${esc(a.title)}</b><small>${esc(s === "ended" ? endText(a) : dates(a))} · ${esc(audText(a))}</small></span>
        <span class="sda-tags">${a.confirm ? '<em class="sda-tag">Asks to confirm</em>' : ""}${a.important ? '<em class="sda-tag is-imp">Important</em>' : ""}</span>
        <span class="sda-row-stat">${esc(s === "scheduled" ? `Starts ${niceKey(a.from)}` : statText(a))}</span>
      </button>`;
    };
    const empty = { live: "No live announcements.", scheduled: "Nothing scheduled.", ended: "No ended announcements yet." }[st.filter];
    return `<a class="sda-back" href="#/settings/sod">← Start of Day</a>
      <div class="sds-head">
        <div><h2 class="sds-h">Announcements</h2>
          <p class="sds-sub">Clinic news on Start of Day, for everyone or the roles and people you choose.
            They show in the Announcements card, so add that card to the presets that should see them.</p></div>
        <div class="sds-top-acts"><button type="button" class="sds-btn is-primary" data-act="new">New announcement</button></div>
      </div>
      <div class="sds-seg sda-filter" role="group">${tabs.map(([k, l]) =>
        `<button type="button" data-filter="${k}" class="${st.filter === k ? "is-on" : ""}" aria-pressed="${st.filter === k}">${l} · ${g[k].length}</button>`).join("")}</div>
      <div class="sda-list">${rows.length ? rows.map(row).join("") : `<p class="sda-empty">${empty}</p>`}</div>`;
  }

  /* ----- One announcement, and who has read it ----- */
  function detailHtml(a) {
    const s = annState(a);
    const label = { live: "Live", scheduled: "Scheduled", ended: "Ended" }[s];
    const who = audience(a).map((p) => ({ p, r: readOf(a, p.id) }));
    const grp = (title, list, at) => `<div class="sda-grp"><h3>${title}<span>${list.length}</span></h3>${list.length
      ? `<ul>${list.map(({ p, r }) => `<li><b>${esc(p.name)}</b><small>${esc([p.role, at && r ? when(at(r)) : ""].filter(Boolean).join(" · "))}</small></li>`).join("")}</ul>`
      : '<p class="sds-muted">No one.</p>'}</div>`;
    const notSeen = who.filter((x) => !x.r || !x.r.seenAt);
    const reads = a.confirm
      ? grp("Confirmed", who.filter((x) => x.r && x.r.confirmedAt), (r) => r.confirmedAt)
        + grp("Seen, not confirmed yet", who.filter((x) => x.r && x.r.seenAt && !x.r.confirmedAt), (r) => r.seenAt)
        + grp("Not seen yet", notSeen)
      : grp("Seen", who.filter((x) => x.r && x.r.seenAt), (r) => r.seenAt) + grp("Not seen yet", notSeen);
    return `<button type="button" class="sda-back" data-act="list">← All announcements</button>
      <div class="sda-card${a.important ? " is-important" : ""}">
        <h3>${esc(a.title)}</h3>
        <p class="sda-meta">${esc([label, s === "ended" ? endText(a) : dates(a), audText(a), a.confirm ? "Asks to confirm" : "",
          a.important ? "Important" : "", a.createdBy ? `Posted by ${a.createdBy}` : ""].filter(Boolean).join(" · "))}</p>
        <div class="sda-text">${esc(a.body).replace(/\n/g, "<br>")}</div>
        <div class="sda-acts">
          ${s !== "ended" ? `<button type="button" class="sds-btn" data-act="edit">Edit</button>
            <button type="button" class="sds-btn is-quiet" data-act="end">End now</button>`
          : '<button type="button" class="sds-btn" data-act="again">Post again</button>'}
          <button type="button" class="sds-btn is-quiet is-dangertext" data-act="delete">Delete</button>
        </div>
      </div>
      ${s === "scheduled" ? `<p class="sds-hint">It starts on ${esc(niceKey(a.from))}. Who has read it shows from then.</p>`
        : `<div class="sda-groups">${reads}</div>`}`;
  }

  /* ----- Writing or editing one ----- */
  function editHtml() {
    const f = st.f;
    const who = audience(f);
    const chip = (attr, val, label, on, sub = "") => `<label class="sds-chip${on ? " is-on" : ""}">
      <input type="checkbox" ${attr}="${esc(val)}"${on ? " checked" : ""}><span>${esc(label)}</span>${sub ? `<em>${esc(sub)}</em>` : ""}</label>`;
    return `<button type="button" class="sda-back" data-act="cancel">← ${f.id ? "Back" : "All announcements"}</button>
      <div class="sds-head"><div><h2 class="sds-h">${f.id ? "Edit announcement" : "New announcement"}</h2>
        <p class="sds-sub">It shows on Start of Day for the people you choose, from the day it starts.</p></div></div>
      <div class="sda-form">
        <label class="sds-f"><span>Title</span>
          <input type="text" maxlength="120" data-f="title" placeholder="e.g. New refund process" value="${esc(f.title)}"></label>
        <label class="sds-f"><span>Message</span>
          <textarea rows="6" maxlength="2000" data-f="body" placeholder="What staff need to know.">${esc(f.body)}</textarea></label>
        <div class="sda-dates">
          <label class="sds-f"><span>Show from</span><input type="date" data-f="from" value="${esc(f.from)}"></label>
          <label class="sds-f"><span>Until (optional)</span><input type="date" data-f="until" min="${esc(f.from)}" value="${esc(f.until)}"></label>
        </div>
        <div class="sds-f"><span>Who gets it</span>
          <div class="sda-radio">
            <label><input type="radio" name="sda-aud" data-aud="everyone"${f.everyone ? " checked" : ""}> Everyone</label>
            <label><input type="radio" name="sda-aud" data-aud="choose"${f.everyone ? "" : " checked"}> Choose roles or people</label>
          </div>
          ${f.everyone ? "" : `<div class="sds-chips2">${st.roles.map((r) => chip("data-role-chip", r, r, f.roles.includes(r))).join("")}</div>
            <details class="sds-people"${f.staffIds.length || st.peopleOpen ? " open" : ""}>
              <summary>And these people <small>${f.staffIds.length ? `${f.staffIds.length} chosen · ` : ""}whatever their role</small></summary>
              <div class="sds-chips2">${st.people.map((p) => chip("data-person", p.id, p.name, f.staffIds.includes(p.id), p.role)).join("")
                || '<small class="sds-muted">The staff list couldn\'t be loaded.</small>'}</div>
            </details>`}
          <small class="sds-muted">${who.length} ${who.length === 1 ? "person gets" : "people get"} this</small>
        </div>
        <label class="sda-chk"><input type="checkbox" data-f="confirm"${f.confirm ? " checked" : ""}>
          Ask them to confirm they've read it <small>It stays on their Start of Day until they do</small></label>
        <label class="sda-chk"><input type="checkbox" data-f="important"${f.important ? " checked" : ""}>
          Important <small>Shown with an amber edge</small></label>
        ${f.id ? `<label class="sda-chk"><input type="checkbox" data-f="again"${f.again ? " checked" : ""}>
          Everyone reads it again <small>For a change that matters: who has seen and confirmed it starts from zero</small></label>` : ""}
        <div class="sda-acts">
          <button type="button" class="sds-btn is-primary" data-act="save">${f.id ? "Save changes" : "Post"}</button>
          <button type="button" class="sds-btn is-quiet" data-act="cancel">Cancel</button>
        </div>
      </div>`;
  }

  function render() {
    const y = window.scrollY;
    const a = st.openId ? byId(st.openId) : null;
    if (st.view === "detail" && !a) st.view = "list";
    root.innerHTML = st.view === "edit" ? editHtml() : st.view === "detail" ? detailHtml(a) : listHtml();
    window.scrollTo(0, st.view === "edit" ? y : 0);
  }
  const show = (view, id = st.openId) => { st.view = view; st.openId = id; render(); window.scrollTo(0, 0); };

  async function leaveEdit() {
    if (st.dirty && !(await confirmDialog({ title: "Discard this announcement?",
      message: "Your changes haven't been saved.", confirmLabel: "Discard", tone: "warning" }))) return;
    st.dirty = false;
    st.f = null;
    show(st.openId && byId(st.openId) ? "detail" : "list");
  }

  async function save() {
    if (st.busy) return;
    const f = st.f;
    const title = f.title.replace(/\s+/g, " ").trim().slice(0, 120);
    const body = f.body.replace(/\r/g, "").trim().slice(0, 2000);
    const bad = (m, sel) => { showToast(m); const el = root.querySelector(sel); if (el) el.focus(); };
    if (!title) return bad("Give it a title.", '[data-f="title"]');
    if (!body) return bad("Write the message.", '[data-f="body"]');
    if (!KEY_RE.test(f.from)) return bad("Choose the day it starts.", '[data-f="from"]');
    if (f.until && !KEY_RE.test(f.until)) return bad("Check the end date.", '[data-f="until"]');
    if (f.until && f.until < f.from) return bad("The end date is before the start date.", '[data-f="until"]');
    if (f.until && f.until < toDateKey()) return bad("That end date has already passed.", '[data-f="until"]');
    if (!f.everyone && !f.roles.length && !f.staffIds.length) {
      return bad("Choose who gets it: tick a role or a person, or choose Everyone.", '[data-aud="choose"]');
    }
    const u = me();
    const by = nameOf(staff);
    const data = {
      title, body, from: f.from, until: f.until || "", everyone: f.everyone,
      roles: f.everyone ? [] : f.roles.slice(0, 20), staffIds: f.everyone ? [] : f.staffIds.slice(0, 150),
      confirm: f.confirm, important: f.important,
      updatedAt: serverTimestamp(), updatedBy: by, updatedByUid: u ? u.uid : "",
    };
    st.busy = true;
    const btn = root.querySelector('[data-act="save"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      let id = f.id;
      if (id) {
        const a = byId(id);
        if (f.again && a) data.round = a.round + 1;
        await updateDoc(doc(db, COL, id), data);
      } else {
        const ref = await addDoc(collection(db, COL), {
          ...data, round: 0, ended: false, deleted: false,
          createdAt: serverTimestamp(), createdBy: by, createdByUid: u ? u.uid : "",
        });
        id = ref.id;
      }
      st.dirty = false;
      st.f = null;
      await load();
      const a = byId(id);
      if (a) st.filter = annState(a);
      show("detail", id);
      showToast(f.from > toDateKey() ? `Saved. It starts on ${niceKey(f.from)}.`
        : f.id ? "Saved." : "Posted. Staff see it the next time their Start of Day opens.");
    } catch (err) {
      console.error("Announcement not saved:", err);
      showToast(err && err.code === "permission-denied"
        ? "Couldn't save: check the sod_announcements Firestore rule is published, and that you have the Start of Day tick."
        : "Couldn't save. Check your connection and try again.");
      const b = root.querySelector('[data-act="save"]');
      if (b) { b.disabled = false; b.textContent = f.id ? "Save changes" : "Post"; }
    } finally {
      st.busy = false;
    }
  }

  async function update(a, fields, done) {
    try {
      const u = me();
      await updateDoc(doc(db, COL, a.id), { ...fields, updatedAt: serverTimestamp(), updatedBy: nameOf(staff), updatedByUid: u ? u.uid : "" });
      await load();
      showToast(done);
      return true;
    } catch (err) {
      console.error("Announcement not changed:", err);
      showToast(err && err.code === "permission-denied"
        ? "Couldn't save: check the sod_announcements Firestore rule is published."
        : "Couldn't save. Check your connection and try again.");
      return false;
    }
  }

  /* ----- Events ----- */
  root.addEventListener("click", async (e) => {
    const fb = e.target.closest("[data-filter]");
    if (fb) { st.filter = fb.dataset.filter; render(); return; }
    const ob = e.target.closest("[data-open]");
    if (ob) { show("detail", ob.dataset.open); return; }
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const a = st.openId ? byId(st.openId) : null;
    const act = b.dataset.act;
    if (act === "new") { st.f = blank(); st.dirty = false; st.peopleOpen = false; show("edit", ""); }
    else if (act === "list") show("list", "");
    else if (act === "cancel") leaveEdit();
    else if (act === "save") save();
    else if (act === "edit" && a) { st.f = fromAnn(a); st.dirty = false; st.peopleOpen = false; show("edit"); }
    else if (act === "again" && a) {
      st.f = { ...fromAnn(a), id: "", from: toDateKey(), until: "" };
      st.dirty = true;
      st.peopleOpen = false;
      show("edit", "");
      showToast("A copy of it. Check the dates, then post it.");
    } else if (act === "end" && a) {
      if (!(await confirmDialog({ title: `End "${a.title}"?`,
        message: "It comes off everyone's Start of Day now. Who read it stays on record.",
        confirmLabel: "End now", tone: "warning" }))) return;
      if (await update(a, { ended: true, endedAt: serverTimestamp(), endedBy: nameOf(staff) }, "Ended.")) {
        st.filter = "ended";
        show("detail");
      }
    } else if (act === "delete" && a) {
      if (!(await confirmDialog({ title: `Delete "${a.title}"?`,
        message: "It comes off Start of Day and out of this list.",
        confirmLabel: "Delete", tone: "warning" }))) return;
      if (await update(a, { deleted: true, deletedAt: serverTimestamp(), deletedBy: nameOf(staff) }, "Deleted.")) show("list", "");
    }
  });

  root.addEventListener("input", (e) => {
    const k = e.target.dataset.f;
    if (!st.f || !["title", "body"].includes(k)) return;
    st.f[k] = e.target.value;
    st.dirty = true;
  });

  root.addEventListener("change", (e) => {
    const el = e.target;
    const f = st.f;
    if (!f) return;
    if (el.dataset.aud) { f.everyone = el.dataset.aud === "everyone"; st.dirty = true; render(); return; }
    if (el.dataset.roleChip !== undefined) {
      const r = el.dataset.roleChip;
      f.roles = el.checked ? [...f.roles, r] : f.roles.filter((x) => x !== r);
      st.dirty = true; render(); return;
    }
    if (el.dataset.person !== undefined) {
      const id = el.dataset.person;
      f.staffIds = el.checked ? [...f.staffIds, id] : f.staffIds.filter((x) => x !== id);
      st.dirty = true; render(); return;
    }
    const k = el.dataset.f;
    if (["confirm", "important", "again"].includes(k)) { f[k] = el.checked; st.dirty = true; return; }
    if (["from", "until"].includes(k)) { f[k] = el.value; st.dirty = true; if (k === "from") render(); }
  });

  // Remember whether "And these people" is open between redraws
  root.addEventListener("toggle", (e) => { if (e.target.matches && e.target.matches(".sds-people")) st.peopleOpen = e.target.open; }, true);

  // Leaving the page with an unsaved announcement: ask first (in the portal's own dialog)
  const guard = (e) => {
    if (!root.isConnected) { window.removeEventListener("hashchange", guard, true); return; }
    if (!st.dirty || st.view !== "edit") return;
    e.stopImmediatePropagation();
    const to = location.hash;
    history.replaceState(null, "", e.oldURL);
    confirmDialog({ title: "Leave without saving?", message: "Your announcement hasn't been saved.",
      confirmLabel: "Leave", tone: "warning" }).then((ok) => { if (ok) { st.dirty = false; location.hash = to; } });
  };
  window.addEventListener("hashchange", guard, true);

  try {
    await load();
  } catch (err) {
    console.error("Announcements failed:", err);
    root.innerHTML = `<a class="sda-back" href="#/settings/sod">← Start of Day</a>
      <p class="sds-empty">Announcements couldn't be loaded. Check your connection and the sod_announcements Firestore rule.</p>`;
    return;
  }
  render();
}