// Any staff member: upload, take or remove their own profile photo.
import { callApi } from "./appointments.js";
import { auth } from "./firebase-config.js";
import { showToast, escapeHtml as esc, getInitials, hueFromString } from "./utils.js";
import { uploadStaffPhoto, photoErrText } from "./staff-photo.js";

// onChange(url) runs after it's saved ("" = removed), so the top bar can redraw the avatar
export function openMyPhoto(staff, onChange = () => {}) {
  const name = (staff && staff.name) || "";
  let photo = (staff && staff.photo) || "";
  let busy = false;
  const dlg = document.createElement("dialog");
  dlg.className = "lh-dialog mp-dlg";
  dlg.innerHTML = `
    <div class="lh-form">
      <div class="lh-dialog-head"><h3>My photo</h3><p>Shown next to your name in the portal and in chat.</p></div>
      <span class="st-avatar st-avatar-lg" data-role="pv" style="--h:${hueFromString(name)}"></span>
      <div class="st-photo-btns mp-btns">
        <label class="lh-btn is-primary">Upload photo<input type="file" accept="image/*" hidden data-role="file" /></label>
        <label class="lh-btn mp-cam">Take photo<input type="file" accept="image/*" capture="user" hidden data-role="cam" /></label>
        <button type="button" class="lh-btn is-quiet" data-act="remove">Remove photo</button>
      </div>
      <p class="fe-note mp-note" data-role="note" role="status"></p>
      <div class="lh-actions"><button type="button" class="lh-btn" data-act="close">Done</button></div>
    </div>`;
  const pv = dlg.querySelector('[data-role="pv"]');
  const note = dlg.querySelector('[data-role="note"]');
  const say = (t, bad = false) => { note.textContent = t; note.classList.toggle("is-bad", bad); };
  const draw = () => {
    pv.innerHTML = (photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />` : "")
      + `<b>${esc(getInitials(name))}</b>`;
    dlg.querySelector('[data-act="remove"]').hidden = !photo;
  };
  const lock = (on) => {
    busy = on;
    dlg.querySelectorAll("label.lh-btn, button").forEach((b) => b.classList.toggle("is-busy", on));
    dlg.querySelectorAll("input, button").forEach((b) => { b.disabled = on; });
  };

  async function save(url, doneText) {
    await callApi({ action: "staff", op: "setPhoto", photo: url });
    photo = url;
    if (staff) staff.photo = url;
    draw();
    onChange(url);
    say("");
    showToast(doneText);
  }

  async function upload(file) {
    if (!file || busy) return;
    lock(true);
    say("Uploading your photo…");
    try {
      const url = await uploadStaffPhoto(auth.currentUser && auth.currentUser.uid, file);
      say("Saving…");
      await save(url, "Photo updated");
    } catch (ex) {
      console.error("My photo failed:", ex);
      say(ex && ex.code === "BAD_PHOTO" ? "That photo couldn't be used. Upload it again." : photoErrText(ex), true);
    } finally { lock(false); }
  }

  ["file", "cam"].forEach((r) => {
    const inp = dlg.querySelector(`[data-role="${r}"]`);
    inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.value = ""; upload(f); });
  });
  dlg.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="close"]') && !busy) { dlg.close(); return; }
    if (e.target.closest('[data-act="remove"]') && !busy) {
      lock(true);
      say("Removing…");
      try { await save("", "Photo removed"); }
      catch (ex) { say(photoErrText(ex), true); }
      finally { lock(false); }
    }
  });
  dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
  dlg.addEventListener("close", () => dlg.remove());
  draw();
  document.body.appendChild(dlg);
  dlg.showModal();
}