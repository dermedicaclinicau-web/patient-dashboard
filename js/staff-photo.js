// Staff profile photos: cropped to a square in the browser, uploaded to Firebase Storage (staff_photos/<folder>/).
import { auth } from "./firebase-config.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const SIZE = 400;

// A centred square JPEG (400 × 400), so a phone photo becomes about 40 KB
async function squareJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That file can't be opened as a photo. Try a JPG or PNG."));
      i.src = url;
    });
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    if (!s) throw new Error("That photo looks empty. Try another one.");
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";                     // transparent PNGs get a white background
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, SIZE, SIZE);
    return await new Promise((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't prepare the photo. Try again."))), "image/jpeg", 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// folder: the staff member's id (Admins can also use a "new_…" folder for someone not saved yet). Returns the photo's web address.
export async function uploadStaffPhoto(folder, file) {
  if (!file || !/^image\//.test(file.type || "image/")) throw new Error("Choose a photo (JPG or PNG).");
  if (file.size > 25 * 1024 * 1024) throw new Error("That photo is too big (over 25 MB).");
  if (!auth.currentUser) throw new Error("Your session has ended. Log out and back in.");
  const blob = await squareJpeg(file);
  const r = ref(getStorage(auth.app), `staff_photos/${folder}/p_${Date.now()}.jpg`);
  await uploadBytes(r, blob, { contentType: "image/jpeg", cacheControl: "public,max-age=31536000" });
  return getDownloadURL(r);
}

export const photoErrText = (ex) => (ex && ex.code === "storage/unauthorized"
  ? "Photo uploads are blocked. Check the staff_photos Storage rule has been published."
  : ex && ex.code && /^storage\//.test(ex.code) ? "Couldn't upload the photo. Check your connection and try again."
  : (ex && ex.message) || "Couldn't upload the photo. Try again.");