// Help & how-to (#/help, #/help/<section>, #/help/<section>/<guide>): only what this person's role can use.
import { can, isAdmin, isInjector } from "./perms.js";
import { auth } from "./firebase-config.js";
import { GUIDE } from "./knowledge-content.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// **bold** and [text](#/page) only. Everything else is shown as plain text.
const fmt = (s) => esc(s)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/\[([^\]]+)\]\((#\/[^)\s"]*)\)/g, '<a href="$2">$1</a>');
const plain = (s) => String(s || "").replace(/\*\*|\[|\]\([^)]*\)/g, "");

const allowed = (x) => {
  if (x.admin && !isAdmin()) return false;
  if (x.injector && !(isInjector() || isAdmin())) return false;
  if (Array.isArray(x.need) && x.need.length && !x.need.some((p) => can(p))) return false;
  return true;
};

export function mountKnowledge(container, { param = "", staff = null } = {}) {
  const sections = GUIDE.filter(allowed)
    .map((s) => ({ ...s, topics: (s.topics || []).filter(allowed) }))
    .filter((s) => s.topics.length);
  const words = (s, t) => [s.title, s.intro, t.q, ...(t.steps || []), ...(t.tips || [])].map(plain).join(" ").toLowerCase();
  const uid = auth.currentUser && auth.currentUser.uid;
  const role = (staff && staff.role) || "";

  const root = document.createElement("section");
  root.className = "page wide kb";
  root.innerHTML = `
    <div class="fb-head">
      <div><h2>Help &amp; how-to</h2>
        <p class="muted">Step-by-step guides for everything you can do in the portal${role ? ` as ${esc(role)}` : ""}.</p></div>
      <div class="fb-head-actions"><button type="button" class="btn-ghost" data-act="print">Print</button></div>
    </div>
    <label class="ib-search kb-search"><input type="search" data-role="q" placeholder="Search, e.g. docket, PIN, urgent" aria-label="Search the guides" /></label>
    <nav class="kb-chips" aria-label="Sections">${sections.map((s) =>
      `<button type="button" class="kb-chip" data-jump="${esc(s.id)}">${s.icon || ""} ${esc(s.title)}</button>`).join("")}</nav>
    <div data-role="body"></div>
    <div class="kb-foot">
      <strong>Still stuck?</strong>
      ${uid && !isAdmin()
        ? `<span>Message the Admins in your <a href="#/home/chat/help__${encodeURIComponent(uid)}">Help chat</a>. They'll get back to you.</span>`
        : "<span>Staff can message you from their Help chat. Anything confusing here can be reworded in <code>js/knowledge-content.js</code>.</span>"}
    </div>`;
  container.replaceChildren(root);
  const body = root.querySelector('[data-role="body"]');

  const topicHtml = (s, t, open) => `
    <details class="kb-topic" id="kb-${esc(s.id)}-${esc(t.id)}"${open ? " open" : ""}>
      <summary>${fmt(t.q)}</summary>
      <div class="kb-a">
        ${t.intro ? `<p>${fmt(t.intro)}</p>` : ""}
        ${(t.steps || []).length > 1 ? `<ol class="kb-steps">${t.steps.map((x) => `<li>${fmt(x)}</li>`).join("")}</ol>`
          : (t.steps || []).map((x) => `<p>${fmt(x)}</p>`).join("")}
        ${(t.tips || []).length ? `<div class="kb-tip"><strong>Good to know</strong><ul>${t.tips.map((x) => `<li>${fmt(x)}</li>`).join("")}</ul></div>` : ""}
      </div>
    </details>`;

  function render(q = "") {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s, t) => terms.every((w) => words(s, t).includes(w));
    const html = sections.map((s) => {
      const list = terms.length ? s.topics.filter((t) => hit(s, t)) : s.topics;
      if (!list.length) return "";
      return `<section class="kb-sec" id="kb-${esc(s.id)}">
        <h3><span aria-hidden="true">${s.icon || ""}</span> ${esc(s.title)}</h3>
        ${s.intro && !terms.length ? `<p class="muted kb-intro">${fmt(s.intro)}</p>` : ""}
        ${list.map((t) => topicHtml(s, t, terms.length > 0)).join("")}
      </section>`;
    }).join("");
    body.innerHTML = html || `<div class="tm-empty">Nothing matches “${esc(q)}”. Try another word, or ask in your Help chat.</div>`;
    root.querySelector(".kb-chips").hidden = terms.length > 0;
  }

  const jump = (secId, topicId) => {
    const el = root.querySelector(topicId ? `#kb-${CSS.escape(secId)}-${CSS.escape(topicId)}` : `#kb-${CSS.escape(secId)}`);
    if (!el) return;
    if (el.tagName === "DETAILS") el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  root.querySelector('[data-role="q"]').addEventListener("input", (e) => render(e.target.value));
  root.addEventListener("click", (e) => {
    const j = e.target.closest("[data-jump]");
    if (j) { jump(j.dataset.jump); return; }
    if (e.target.closest('[data-act="print"]')) window.print();
  });
  // Print what's showing, with every guide opened
  const before = () => root.querySelectorAll(".kb-topic").forEach((d) => { d.dataset.wasOpen = d.open ? "1" : ""; d.open = true; });
  const after = () => root.querySelectorAll(".kb-topic").forEach((d) => { d.open = d.dataset.wasOpen === "1"; });
  window.addEventListener("beforeprint", before);
  window.addEventListener("afterprint", after);
  new MutationObserver((_, obs) => {
    if (!root.isConnected) { window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); obs.disconnect(); }
  }).observe(container, { childList: true });

  render();
  const [secId, topicId] = String(param || "").split("/");
  if (secId) requestAnimationFrame(() => jump(decodeURIComponent(secId), topicId && decodeURIComponent(topicId)));
}