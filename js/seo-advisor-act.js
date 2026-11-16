// seo-advisor-act.js — SEO Advisor: changes you can make right from an answer (title, meta description, wording, links)
import { fixApi, fixErr, askConfirm, injectCss } from "./seo-content.js?v=10";

const S = new Map();     // "msgId|actionId" → { edit, text, busy, err, show }
const REG = new Map();   // msgId → the answer's actions
const ACTS = new Map();  // msgId → the newest status we've seen
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const spin = `<span class="seo-aa-spin" aria-hidden="true"></span>`;
const ICON = { title: "🏷️", description: "📝", wording: "✏️", link: "🔗" };
const LIMIT = { title: [30, 60, 70], description: [120, 155, 170] };
const when = (iso) => { try { return new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); } catch { return ""; } };

function parseActs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
// The saved status (from Firestore) or our own newer one, whichever is newer
function actsOf(msgId, raw) {
  const a = parseActs(raw), b = ACTS.get(msgId);
  return b && (b._v || 0) >= (a._v || 0) ? b : a;
}

// The words that differ, so the card can highlight them
function diff(a, b) {
  const A = String(a).split(" "), B = String(b).split(" ");
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return { pre: A.slice(0, p).join(" "), from: A.slice(p, A.length - s).join(" "), to: B.slice(p, B.length - s).join(" "), suf: A.slice(A.length - s).join(" ") };
}
const join = (...p) => p.filter((x) => x !== "").join(" ");

function counter(kind, text) {
  const L = LIMIT[kind];
  if (!L) return "";
  const n = text.length, good = n >= L[0] && n <= L[1];
  return `<span class="seo-aa-cnt${good ? " is-ok" : ""}">${n} characters${good ? " ✓" : ` · best ${L[0]}–${L[1]}`}</span>`;
}

export function actionsHtml(msgId, ans, actsRaw, can) {
  const list = Array.isArray(ans?.actions) ? ans.actions : [];
  if (!list.length || !msgId) return "";
  injectCss();
  css();
  REG.set(msgId, list);
  const acts = actsOf(msgId, actsRaw);
  const done = list.filter((a) => acts[a.id]?.st === "done").length;
  return `<section class="seo-aa" aria-label="Changes you can make now">
    <div class="seo-aa-head"><span class="seo-aa-ico" aria-hidden="true">⚡</span>
      <div><strong>Changes you can make now</strong>
        <div class="seo-note">Checked against the live page. Nothing changes until you press Apply, and every change can be undone.</div></div>
      <span class="seo-sp"></span><span class="seo-aa-tally">${done} of ${list.length} done</span></div>
    ${list.map((a) => card(msgId, a, acts[a.id], can)).join("")}
  </section>`;
}

function card(msgId, a, st, can) {
  const key = `${msgId}|${a.id}`, ref = esc(key);
  const F = S.get(key) || {};
  const canDo = typeof can === "function" ? can(a.kind === "title" || a.kind === "description" ? "seo.pages" : "seo.fix") : false;
  const errBox = F.err ? `<div class="seo-fx-err"><span>⚠</span><div>${esc(F.err)}</div></div>` : "";
  const head = `<div class="seo-aa-top"><span class="seo-aa-kind">${ICON[a.kind] || "•"} ${esc(a.label)}</span>
    <b class="seo-aa-page">${esc(a.pageTitle || a.page)}</b><span class="seo-note seo-w-mono">${esc(a.page)}</span></div>`;

  if (st?.st === "skipped" && !F.show) {
    return `<div class="seo-aa-card is-min"><span>${ICON[a.kind] || "•"} ${esc(a.label)} on ${esc(a.pageTitle || a.page)}</span>
      <span class="seo-note">· Not now${st.by ? ` (${esc(st.by)})` : ""}</span><span class="seo-sp"></span>
      <button class="seo-w-link" type="button" data-aa-again="${ref}"${F.busy ? " disabled" : ""}>${F.busy ? "…" : "Show again"}</button></div>`;
  }

  if (st?.st === "done") {
    return `<div class="seo-aa-card is-done" data-aa-card>${head}
      ${view(a, st.text || a.text || "", st.before ?? a.before, true)}
      <div class="seo-fx-bar"><span class="seo-aa-ok">✓ Done${st.by ? ` by ${esc(st.by)}` : ""}${st.at ? ` · ${esc(when(st.at))}` : ""}</span>
        ${st.verified === false ? `<span class="seo-note">Not on the live page yet: it may be cached for a few minutes.</span>` : ""}
        <span class="seo-sp"></span>
        ${st.link ? `<a class="seo-fx-b is-ghost" href="${esc(st.link)}" target="_blank" rel="noopener">View live ↗</a>` : ""}
        ${canDo ? `<button class="seo-fx-b is-ghost" type="button" data-aa-undo="${ref}"${F.busy ? " disabled" : ""}>${F.busy === "undo" ? spin + "Undoing…" : "↶ Undo"}</button>` : ""}
      </div>${errBox}</div>`;
  }

  const text = F.text != null ? F.text : (a.text || "");
  const editable = a.kind !== "link";
  return `<div class="seo-aa-card" data-aa-card>${head}
    ${a.why ? `<div class="seo-aa-why">💡 ${esc(a.why)}</div>` : ""}
    ${st?.st === "undone" ? `<div class="seo-note">Undone${st.undoneBy ? ` by ${esc(st.undoneBy)}` : ""}. You can apply it again.</div>` : ""}
    ${F.edit && editable ? editView(a, key, text) : view(a, text, a.before, false)}
    ${a.warn ? `<small class="seo-fx-flag">⚠ ${esc(a.warn)}</small>` : ""}
    <div class="seo-fx-bar">
      ${canDo ? `<button class="seo-fx-b is-accept" type="button" data-aa-apply="${ref}"${F.busy ? " disabled" : ""}>${F.busy === "apply" ? spin + "Applying…" : "✓ Apply"}</button>
        ${editable ? `<button class="seo-fx-b is-ghost" type="button" data-aa-edit="${ref}"${F.busy ? " disabled" : ""}>${F.edit ? "Done editing" : "✎ Edit first"}</button>` : ""}`
        : `<span class="seo-note">You don't have permission to change ${a.kind === "title" || a.kind === "description" ? "page titles" : "website wording"}. An admin can turn it on in Staff → Roles and access.</span>`}
      <span class="seo-sp"></span>
      <button class="seo-fx-b is-ghost" type="button" data-aa-skip="${ref}"${F.busy ? " disabled" : ""}>${F.busy === "skip" ? spin : ""}Not now</button>
    </div>${errBox}</div>`;
}

// Now → After, with the changed words highlighted
function view(a, text, before, done) {
  if (a.kind === "link") {
    const i = String(a.ctx || "").indexOf(a.find);
    const s = i < 0 ? esc(a.ctx || a.find) : `${esc(a.ctx.slice(0, i))}<u class="seo-fx-a">${esc(a.find)}</u>${esc(a.ctx.slice(i + a.find.length))}`;
    return `<div class="seo-aa-link"><div class="seo-fx-lab">${done ? "Now a link" : "These words become a link"}</div>
      <div class="seo-aa-ctx">${s}</div><div class="seo-aa-to">→ goes to <b>${esc(a.toTitle || a.to)}</b> <span class="seo-note seo-w-mono">${esc(a.to)}</span></div></div>`;
  }
  const d = diff(before || "", text);
  return `<div class="seo-fx-ba">
    <div class="seo-fx-col is-now"><div class="seo-fx-lab">${done ? "Before" : "Now"}</div>
      <div class="seo-fx-txt">${before ? `${esc(join(d.pre))} <del>${esc(d.from)}</del> ${esc(join(d.suf))}` : `<i class="seo-note">(none set)</i>`}</div></div>
    <div class="seo-fx-arrow" aria-hidden="true">→</div>
    <div class="seo-fx-col is-new"><div class="seo-fx-lab">${done ? "Now on the page" : "After"} ${counter(a.kind, text)}</div>
      <div class="seo-fx-txt">${before ? `${esc(join(d.pre))} <ins>${esc(d.to)}</ins> ${esc(join(d.suf))}` : esc(text)}</div></div>
  </div>`;
}

function editView(a, key, text) {
  const big = a.kind === "wording" || a.kind === "description";
  return `<div class="seo-fx-ba">
    <div class="seo-fx-col is-now"><div class="seo-fx-lab">Now</div><div class="seo-fx-txt">${a.before ? esc(a.before) : `<i class="seo-note">(none set)</i>`}</div></div>
    <div class="seo-fx-arrow" aria-hidden="true">→</div>
    <div class="seo-fx-col is-new"><div class="seo-fx-lab">After ${counter(a.kind, text)}</div>
      ${big ? `<textarea class="seo-input seo-aa-in" data-aa-text="${esc(key)}" rows="${a.kind === "wording" ? 5 : 3}">${esc(text)}</textarea>`
        : `<input class="seo-input seo-aa-in" data-aa-text="${esc(key)}" value="${esc(text)}" maxlength="70">`}</div>
  </div>`;
}

// Returns true when the click was one of ours. ctx: { redraw, toast? }
export async function actionsClick(e, ctx = {}) {
  const t = e.target.closest("[data-aa-apply],[data-aa-edit],[data-aa-skip],[data-aa-undo],[data-aa-again]");
  if (!t) return false;
  e.preventDefault();
  const d = t.dataset;
  const key = d.aaApply || d.aaEdit || d.aaSkip || d.aaUndo || d.aaAgain;
  const [msgId, aid] = key.split("|");
  const a = (REG.get(msgId) || []).find((x) => x.id === aid);
  if (!a) return true;
  const F = S.get(key) || {};
  S.set(key, F);
  const redraw = () => (ctx.redraw ? ctx.redraw() : null);
  const say = (m) => (ctx.toast ? ctx.toast(m) : null);
  const box = t.closest("[data-aa-card]")?.querySelector("[data-aa-text]");
  if (box) F.text = box.value.replace(/\s+/g, " ").trim();
  const run = async (busy, op, body, msg) => {
    F.busy = busy; F.err = ""; redraw();
    try {
      const r = await fixApi(op, Object.assign({ msgId, actionId: aid }, body));
      if (r.acts) ACTS.set(msgId, r.acts);
      if (msg) say(msg);
      return true;
    } catch (err) { F.err = fixErr(err); return false; }
    finally { F.busy = ""; redraw(); }
  };

  if (d.aaEdit) { F.edit = !F.edit; F.err = ""; redraw(); return true; }
  if (d.aaAgain) { if (await run("again", "advSkip", { again: true })) F.show = false; return true; }
  if (d.aaSkip) {
    if (await run("skip", "advSkip", {}, "Hidden. The Advisor won't suggest this again for that page.")) { F.edit = false; F.show = false; }
    return true;
  }
  if (d.aaUndo) {
    const yes = await askConfirm({ title: `Undo: ${a.label} on “${a.pageTitle || a.page}”?`, ok: "↶ Yes, undo it", tone: "reject",
      body: `<ul class="seo-fx-mlist"><li>The page goes back to how it was before this change.</li>
        <li>If someone has edited the page in WordPress since, it can't be undone from here.</li></ul>` });
    if (yes) await run("undo", "advUndo", {}, "Undone");
    return true;
  }
  if (d.aaApply) {
    const text = a.kind === "link" ? null : (F.text != null ? F.text : a.text || "");
    const yes = await askConfirm({ title: `${a.label} on “${a.pageTitle || a.page}”?`, ok: "✓ Yes, apply it",
      body: `${view(a, text || "", a.before, false)}
        <ul class="seo-fx-mlist"><li>Live on the website straight away.</li>
          <li>Added to the Change log (from the SEO Advisor), and you can <b>Undo</b> it from this card.</li>
          ${a.kind === "title" || a.kind === "description" ? "<li>Google usually shows the new version within a few days to two weeks.</li>" : ""}</ul>` });
    if (!yes) return true;
    if (await run("apply", "advApply", { text }, "Done ✓")) { F.edit = false; F.text = null; }
    return true;
  }
  return true;
}

let cssDone = false;
function css() {
  if (cssDone) return;
  cssDone = true;
  const s = document.createElement("style");
  s.textContent = `
.seo-aa{margin:14px 0 4px;padding:14px;border:1px solid #c7d2fe;border-radius:14px;background:linear-gradient(180deg,#f5f7ff,#fff)}
.seo-aa-head{display:flex;gap:10px;align-items:flex-start;margin:0 0 10px}
.seo-aa-ico{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:#eef2ff;font-size:16px;flex:none}
.seo-aa-tally{font-size:12.5px;font-weight:600;color:#4338ca;background:#eef2ff;border-radius:999px;padding:3px 10px;white-space:nowrap}
.seo-aa-card{margin:8px 0 0;padding:12px 14px;border:1px solid var(--border,#e5e7eb);border-radius:12px;background:var(--card,#fff)}
.seo-aa-card.is-done{border-color:#bbf7d0;background:#f6fef9}
.seo-aa-card.is-min{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;font-size:13px;opacity:.8}
.seo-aa-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:0 0 6px}
.seo-aa-kind{font-size:12px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#4338ca;background:#eef2ff;border-radius:6px;padding:2px 8px}
.seo-aa-page{font-size:14.5px}
.seo-aa-why{font-size:13px;line-height:1.5;margin:0 0 8px;color:inherit;opacity:.85}
.seo-aa-card del{background:#fee2e2;color:#991b1b;text-decoration:line-through;border-radius:3px;padding:0 2px}
.seo-aa-card ins,.seo-fx-ov ins{background:#dcfce7;color:#166534;text-decoration:none;border-radius:3px;padding:0 2px}
.seo-aa-cnt{font-weight:500;text-transform:none;letter-spacing:0;color:#b45309;margin-left:6px}
.seo-aa-cnt.is-ok{color:#15803d}
.seo-aa-in{display:block;width:100%;box-sizing:border-box;line-height:1.5;resize:vertical}
.seo-aa-link{padding:8px 10px;border-radius:10px;background:#f8fafc;border:1px solid var(--border,#e5e7eb)}
.seo-aa-ctx{font-size:13.5px;line-height:1.6;margin:2px 0 4px}
.seo-aa-to{font-size:13px}
.seo-aa-ok{font-size:13px;font-weight:600;color:#15803d}
.seo-aa-spin{display:inline-block;width:12px;height:12px;margin-right:6px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;
  vertical-align:-2px;animation:seoAaSpin .7s linear infinite}
@keyframes seoAaSpin{to{transform:rotate(360deg)}}
@media (max-width:640px){.seo-aa{padding:10px}.seo-aa-card{padding:10px}}
`;
  document.head.appendChild(s);
}