// Recall → Texts & emails (#/recall/messages): what went out and what came back.
// Texts and replies come straight from Textmagic (Code.gs → recallMessages_), so this is the real record.
// Emails come from recall_messages, written when each one is sent.
import { db } from "./firebase-config.js";
import { collection, query, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Textmagic sends "+0000" without a colon, which some browsers can't read
const toDate = (s) => { const d = new Date(String(s || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")); return isNaN(d) ? null : d; };
const when = (s) => {
  const d = toDate(s);
  return d ? d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
};
const mob = (k) => (/^04\d{8}$/.test(k) ? `${k.slice(0, 4)} ${k.slice(4, 7)} ${k.slice(7)}` : String(k || ""));
const initials = (n) => {
  const w = String(n || "").replace(/\([^)]*\)/g, " ").split(/\s+/).filter((x) => /[A-Za-z]/.test(x));
  return w.length ? (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase() : "#";
};
const STATUS = {
  d: ["Delivered", "is-ok"], s: ["Sent", "is-sent"], q: ["Queued", "is-wait"], a: ["Queued", "is-wait"], r: ["Queued", "is-wait"],
  f: ["Failed", "is-bad"], e: ["Failed", "is-bad"], j: ["Rejected", "is-bad"], i: ["Failed", "is-bad"], u: ["Unknown", ""],
};
const replyKind = (t) => (/^\s*stop\b/i.test(t) ? ["Opted out", "is-stop"] : /^\s*(yes|y|yep|yeah)\b/i.test(t) ? ["Wants to book", "is-yes"] : null);
const TABS = [["sent", "Texts sent"], ["replies", "Replies"], ["emails", "Emails sent"]];

export function mountRecallMessages(container) {
  const root = document.createElement("section");
  root.className = "page rc rm";
  root.innerHTML = `
    <a class="back-link" href="#/recall">← Recall</a>
    <div class="rc-top"><h2>Texts & emails</h2></div>
    <p class="muted rm-intro">Texts and replies come straight from Textmagic, with the delivery status from the phone network.
      Emails are everything sent from Recall: by the flow, and by staff from a card.</p>
    <div class="rc-bar">
      <div class="rc-tabs" data-role="tabs" role="tablist"></div>
      <span class="inv-spacer"></span>
      <input type="search" class="fe-input rc-q" data-role="q" placeholder="Search by name, number or message" aria-label="Search" />
      <button type="button" class="lh-btn is-quiet" data-act="refresh">Refresh</button>
    </div>
    <div data-role="list"></div>`;
  container.replaceChildren(root);
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);

  let tab = "sent", q = "";
  const st = {
    sent: { rows: [], page: 0, pageCount: 1, loading: false, error: "" },
    replies: { rows: [], page: 0, pageCount: 1, loading: false, error: "" },
    emails: { rows: [], n: 0, more: false, loading: false, error: "" },
  };

  async function load(k, more) {
    const s = st[k];
    if (s.loading) return;
    s.loading = true;
    s.error = "";
    draw();
    try {
      if (k === "emails") {
        s.n = more ? s.n + 50 : 50;
        const snap = await getDocs(query(collection(db, "recall_messages"), orderBy("at", "desc"), limit(s.n)));
        s.rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.kind === "email");
        s.more = snap.size >= s.n;
      } else {
        const page = more ? s.page + 1 : 1;
        const res = await callApi({ action: "recall", op: "messages", kind: k === "replies" ? "replies" : "sent", page });
        if (res.problem) { s.error = res.problem; return; }
        s.rows = more ? s.rows.concat(res.rows || []) : res.rows || [];
        s.page = res.page;
        s.pageCount = res.pageCount;
      }
    } catch (err) {
      console.error("Texts & emails failed:", err);
      s.error = err && err.code === "UNAUTHORIZED" ? "Your login has timed out. Log out and back in, then try again."
        : err && err.code === "permission-denied" ? "Blocked. Check the recall_messages Firestore rule is published."
        : "Couldn't load. Press Refresh to try again.";
    } finally {
      s.loading = false;
      if (root.isConnected) draw();
    }
  }

  const who = (r) => (r.patientId
    ? `<a href="#/patient/${encodeURIComponent(r.patientId)}">${esc(r.name || mob(r.phone))}</a>`
    : `<strong>${esc(r.name || mob(r.phone) || "Unknown")}</strong>`);

  function rowHtml(r) {
    if (tab === "emails") {
      return `<div class="rm-row">
        <span class="rc-av" aria-hidden="true">${esc(initials(r.patientName))}</span>
        <div class="rm-main">
          <div class="rm-top">${r.patientId ? `<a href="#/patient/${encodeURIComponent(r.patientId)}">${esc(r.patientName || r.to)}</a>`
            : `<strong>${esc(r.patientName || r.to)}</strong>`}
            <span class="rm-pill is-sent">Sent</span><span class="rm-when">${esc(when(r.at))}</span></div>
          <small>${esc([r.to, r.category, r.auto ? "by the Recall flow" : r.by ? `by ${r.by}` : ""].filter(Boolean).join(" · "))}</small>
          <p class="rm-text"><strong>${esc(r.subject || "(no subject)")}</strong></p>
        </div></div>`;
    }
    const s = tab === "sent" ? STATUS[r.status] || [r.status || "Unknown", ""] : replyKind(r.text);
    return `<div class="rm-row">
      <span class="rc-av" aria-hidden="true">${esc(initials(r.name))}</span>
      <div class="rm-main">
        <div class="rm-top">${who(r)}
          ${s ? `<span class="rm-pill ${s[1]}">${esc(s[0])}</span>` : ""}
          <span class="rm-when">${esc(when(r.at))}</span></div>
        <small>${esc([r.name ? mob(r.phone) : "", r.category,
          tab === "sent" && r.parts > 1 ? `${r.parts} parts` : ""].filter(Boolean).join(" · "))}</small>
        <p class="rm-text">${esc(r.text)}</p>
      </div></div>`;
  }

  function draw() {
    $("tabs").innerHTML = TABS.map(([k, l]) =>
      `<button type="button" class="rc-tab${tab === k ? " is-on" : ""}" data-tab="${k}" role="tab" aria-selected="${tab === k}">${esc(l)}</button>`).join("");
    const s = st[tab];
    const box = $("list");
    if (s.error) { box.innerHTML = `<p class="rc-empty">${esc(s.error)}</p>`; return; }
    if (s.loading && !s.rows.length) { box.innerHTML = '<div class="skeleton" style="height:220px;border-radius:12px"></div>'; return; }
    const ql = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    const rows = !q ? s.rows : s.rows.filter((r) =>
      [r.name, r.patientName, r.text, r.subject, r.to, r.category].some((v) => String(v || "").toLowerCase().includes(ql))
      || (digits.length >= 3 && String(r.phone || "").includes(digits)));
    const canMore = tab === "emails" ? s.more : s.page < s.pageCount;
    const empty = q ? "Nothing matches in what's loaded. Press Load more to search further back."
      : { sent: "No texts sent yet.", replies: "No replies yet.", emails: "No recall emails yet. They appear here from today." }[tab];
    box.innerHTML = `${rows.length ? `<div class="rm-list">${rows.map(rowHtml).join("")}</div>` : `<p class="rc-empty">${esc(empty)}</p>`}
      ${canMore ? `<button type="button" class="lh-btn is-quiet rc-more" data-act="more"${s.loading ? " disabled" : ""}>${s.loading ? "Loading…" : "Load more"}</button>` : ""}`;
  }

  root.addEventListener("input", (e) => { if (e.target.dataset.role === "q") { q = e.target.value.trim(); draw(); } });
  root.addEventListener("click", (e) => {
    const tb = e.target.closest("[data-tab]");
    if (tb) {
      tab = tb.dataset.tab;
      const s = st[tab];
      if (!s.rows.length && !s.loading && !s.error) load(tab, false); else draw();
      return;
    }
    if (e.target.closest('[data-act="more"]')) { load(tab, true); return; }
    if (e.target.closest('[data-act="refresh"]')) load(tab, false);
  });

  draw();
  load("sent", false);
}