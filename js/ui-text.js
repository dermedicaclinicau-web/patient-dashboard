// Admin-editable wording in dialogs: labels, instruction notes and heading descriptions.
// Edits live in ui_settings/text as { texts: { "<scope>:<code of the original wording>": "new wording" } }.
// The original wording stays in the code, so "Use original" always works, and if the original is
// ever changed in the code its old edit simply stops matching.
// Text the portal fills in as you type (anything with data-role) and text containing other elements is never editable.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, deleteField, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { showToast } from "./utils.js";

const SEL = ".lh-dialog-head p, .lh-label, .fe-note, .inv-hint";
const REF = doc(db, "ui_settings", "text");
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

let cache = null;
let job = null;
export function loadUiText() {
  if (cache) return Promise.resolve(cache);
  if (!job) {
    job = getDoc(REF)
      .then((s) => { cache = (s.exists() && s.data().texts) || {}; return cache; })
      .catch((err) => { console.warn("Couldn't load edited wording:", err); job = null; return {}; });
  }
  return job;
}

// value "" goes back to the original wording
export async function saveUiText(key, value, staff) {
  const v = norm(value).slice(0, 600);
  await setDoc(REF, {
    texts: { [key]: v || deleteField() },
    updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120),
  }, { merge: true });
  cache = { ...(cache || {}) };
  if (v) cache[key] = v; else delete cache[key];
  return cache;
}

const editable = (root) => [...root.querySelectorAll(SEL)].filter((el) =>
  !el.children.length && !el.dataset.role && !el.closest(".uit-ed") && (el.dataset.uitKey || norm(el.textContent)));

function apply(root, scope, texts) {
  editable(root).forEach((el) => {
    if (!el.dataset.uitKey) {
      el.dataset.uitOrig = norm(el.textContent);
      el.dataset.uitKey = `${scope}:${hash(el.dataset.uitOrig)}`;
    }
    const want = texts[el.dataset.uitKey] || el.dataset.uitOrig;
    if (el.textContent !== want) el.textContent = want;
    el.classList.toggle("uit-changed", !!texts[el.dataset.uitKey]);
  });
}

// Call once a dialog is open. Everyone sees edited wording; admins also get "Edit wording".
export function enableUiText(dlg, { scope = "ui", admin = false, staff = null } = {}) {
  let texts = cache || {};
  let running = false;
  const run = () => {
    if (running || !dlg.isConnected) return;
    running = true;
    apply(dlg, scope, texts);
    running = false;
  };
  run();
  loadUiText().then((t) => { texts = t; run(); });
  // Parts of some windows are redrawn (e.g. the stock window): keep the wording applied
  const mo = new MutationObserver(run);
  mo.observe(dlg, { childList: true, subtree: true });
  dlg.addEventListener("close", () => mo.disconnect());
  if (!admin) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "uit-toggle";
  toggle.textContent = "✎ Edit wording";
  toggle.title = "Admins: change the labels and instructions in this window";
  toggle.setAttribute("aria-pressed", "false");
  dlg.appendChild(toggle);
  const closeEditors = () => dlg.querySelectorAll(".uit-ed").forEach((x) => x.remove());
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    const on = dlg.classList.toggle("is-uit-edit");
    toggle.textContent = on ? "Done editing" : "✎ Edit wording";
    toggle.setAttribute("aria-pressed", String(on));
    if (!on) closeEditors();
  });

  function openEditor(el) {
    closeEditors();
    const key = el.dataset.uitKey;
    const orig = el.dataset.uitOrig;
    const ed = document.createElement("div");
    ed.className = "uit-ed";
    ed.innerHTML = `
      <textarea rows="${Math.min(6, Math.max(2, Math.ceil(orig.length / 60)))}" maxlength="600" aria-label="New wording"></textarea>
      <div class="uit-acts">
        <small>Original: <span></span></small>
        <button type="button" class="lh-btn is-quiet" data-uit="cancel">Cancel</button>
        <button type="button" class="lh-btn" data-uit="reset">Use original</button>
        <button type="button" class="lh-btn is-primary" data-uit="save">Save</button>
      </div>`;
    const ta = ed.querySelector("textarea");
    ta.value = el.textContent;
    ed.querySelector("small span").textContent = orig;
    el.after(ed);
    ta.focus();
    ta.select();
    ed.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-uit]");
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.uit === "cancel") { ed.remove(); return; }
      const value = b.dataset.uit === "reset" ? "" : norm(ta.value);
      const save = value === orig ? "" : value;
      b.disabled = true;
      try {
        texts = await saveUiText(key, save, staff);
        ed.remove();
        run();
        showToast(save ? "Wording saved" : "Back to the original wording");
      } catch (err) {
        console.error("Save wording failed:", err);
        b.disabled = false;
        showToast(err && err.code === "permission-denied"
          ? "Only Admins can change wording. Check the ui_settings Firestore rule has been published."
          : "Couldn't save. Try again.");
      }
    });
  }

  // In edit mode, clicking wording opens its editor instead of doing what it normally does
  dlg.addEventListener("click", (e) => {
    if (!dlg.classList.contains("is-uit-edit")) return;
    if (e.target.closest(".uit-ed, .uit-toggle")) return;
    const el = e.target.closest("[data-uit-key]");
    if (!el || !dlg.contains(el)) return;
    e.preventDefault();
    e.stopPropagation();
    openEditor(el);
  }, true);
}