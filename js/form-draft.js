// Unsaved answers kept on this device while a form is filled in, so a refresh, a flat battery
// or an accidental Back doesn't lose them. Signatures, photos, drawings, aftercare and products
// are never kept. Drafts expire after 12 hours, and are removed when the form is saved or on log-out.
const PREFIX = "dm.formDraft.";
const MAX_AGE = 12 * 3600000;
const MAX_DRAFTS = 15;
const keyOf = (pid, tid) => `${PREFIX}${pid}|${tid}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

function allKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k);
    }
  } catch { /* storage blocked */ }
  return out;
}

// Removes expired drafts, and the oldest ones beyond the limit
export function pruneDrafts() {
  const now = Date.now();
  const list = allKeys().map((k) => {
    let at = 0;
    try { at = Number(JSON.parse(localStorage.getItem(k)).at) || 0; } catch { /* broken: removed below */ }
    return { k, at };
  });
  list.filter((x) => now - x.at > MAX_AGE).forEach((x) => remove(x.k));
  list.filter((x) => now - x.at <= MAX_AGE).sort((a, b) => b.at - a.at)
    .slice(MAX_DRAFTS).forEach((x) => remove(x.k));
}

export function readDraft(pid, tid) {
  try {
    const d = JSON.parse(localStorage.getItem(keyOf(pid, tid)) || "null");
    if (!d || typeof d !== "object" || !d.answers || Date.now() - Number(d.at || 0) > MAX_AGE) {
      remove(keyOf(pid, tid));
      return null;
    }
    return d;
  } catch {
    remove(keyOf(pid, tid));
    return null;
  }
}

export function writeDraft(pid, tid, draft) {
  const s = JSON.stringify({ ...draft, at: Date.now() });
  try { localStorage.setItem(keyOf(pid, tid), s); return true; }
  catch {
    pruneDrafts(); // storage full: make room and try once more
    try { localStorage.setItem(keyOf(pid, tid), s); return true; } catch { return false; }
  }
}

export function clearDraft(pid, tid) { remove(keyOf(pid, tid)); }

// Call on log-out, so the next person on a shared iPad never sees them
export function clearAllDrafts() { allKeys().forEach(remove); }

function whenText(at) {
  const d = new Date(Number(at));
  const t = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `${t} today`
    : `${d.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} at ${t}`;
}

// Resolves true for "Carry on", false for "Start fresh". Escape can't dismiss it by accident.
export function askResumeDraft(draft, { updated = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = document.createElement("dialog");
    dlg.className = "lh-dialog fe-confirm";
    dlg.innerHTML = `
      <div class="lh-form">
        <div class="lh-dialog-head">
          <h3>Carry on where you left off?</h3>
          <p>This form has answers that weren't saved, from ${esc(whenText(draft.at))}${draft.by ? ` by ${esc(draft.by)}` : ""}.
            ${updated ? "The form has been updated since, so check the answers before saving." : ""}
            Signatures, photos and drawings need adding again. Start fresh removes these answers.</p>
        </div>
        <div class="lh-actions">
          <button type="button" class="lh-btn is-quiet" data-act="fresh">Start fresh</button>
          <button type="button" class="lh-btn is-primary" data-act="resume">Carry on</button>
        </div>
      </div>`;
    dlg.addEventListener("cancel", (e) => e.preventDefault());
    dlg.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="resume"]')) { result = true; dlg.close(); }
      else if (e.target.closest('[data-act="fresh"]')) dlg.close();
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector('[data-act="resume"]').focus();
  });
}