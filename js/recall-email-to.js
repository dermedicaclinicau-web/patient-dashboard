// Recall email window: the "To" address can be changed for this email, and optionally saved to the patient record
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(s || "").trim());
const norm = (s) => String(s || "").trim().toLowerCase();

export function toRowHtml(name, email) {
  const has = isEmail(email);
  return `
    <div class="rem-to" data-to-row>
      <span class="rem-to-label">To</span>
      <div class="rem-to-field">
        <button type="button" class="rem-to-chip" data-to-chip title="Change the address"${has ? "" : " hidden"}>
          <strong>${esc(name)}</strong> <span data-to-show>&lt;${esc(email)}&gt;</span>
          <span class="rem-to-pen" aria-hidden="true">✎</span>
        </button>
        <input type="email" class="rem-to-input" data-to-input value="${esc(has ? email : "")}"
          placeholder="${has ? "" : "No email on their record: type one"}" autocomplete="off" spellcheck="false"${has ? " hidden" : ""} />
        <label class="rem-to-save" data-to-save hidden>
          <input type="checkbox" data-to-save-box /> Also update their email on the patient record
        </label>
        <small class="rem-to-err" data-to-err hidden></small>
      </div>
    </div>`;
}

export function wireToRow(root, original) {
  const row = root.querySelector("[data-to-row]");
  if (!row) return;
  const chip = row.querySelector("[data-to-chip]");
  const input = row.querySelector("[data-to-input]");
  const show = row.querySelector("[data-to-show]");
  const save = row.querySelector("[data-to-save]");
  const err = row.querySelector("[data-to-err]");
  const orig = norm(original);
  const setErr = (t) => { err.textContent = t || ""; err.hidden = !t; input.classList.toggle("is-bad", !!t); };
  const edit = () => { chip.hidden = true; input.hidden = false; input.focus(); input.select(); };
  const done = () => {
    const v = input.value.trim();
    if (!v) { setErr("Type an email address."); return; }
    if (!isEmail(v)) { setErr("That doesn't look like an email address."); return; }
    setErr("");
    input.value = v;
    show.innerHTML = `&lt;${esc(v)}&gt;`;
    chip.classList.toggle("is-changed", norm(v) !== orig);
    save.hidden = !orig || norm(v) === orig;           // nothing on file: it's simply the address to use
    if (save.hidden) save.querySelector("[data-to-save-box]").checked = false;
    chip.hidden = false;
    input.hidden = true;
  };
  chip.addEventListener("click", edit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); done(); }
    if (e.key === "Escape" && orig) { e.preventDefault(); e.stopPropagation(); input.value = original; done(); }
  });
  input.addEventListener("blur", () => { if (input.value.trim()) done(); });
  input.addEventListener("input", () => setErr(""));
}

// { to, saveEmail } or { error }
export function readToRow(root) {
  const row = root.querySelector("[data-to-row]");
  if (!row) return { error: "The address couldn't be read." };
  const to = row.querySelector("[data-to-input]").value.trim();
  if (!isEmail(to)) {
    row.querySelector("[data-to-chip]").hidden = true;
    const input = row.querySelector("[data-to-input]");
    input.hidden = false;
    input.focus();
    return { error: to ? "Check the email address." : "Add an email address." };
  }
  const box = row.querySelector("[data-to-save-box]");
  return { to, saveEmail: !row.querySelector("[data-to-save]").hidden && !!(box && box.checked) };
}