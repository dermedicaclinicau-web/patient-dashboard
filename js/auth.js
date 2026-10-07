import { auth, db, LOGIN_ENDPOINT } from "./firebase-config.js";
import { doc, updateDoc, FieldPath } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const ERROR_MESSAGES = {
  INVALID_PIN: "Incorrect PIN. Please try again.",
  LOCKED: "Too many attempts. Please wait 15 minutes or contact an admin.",
  SERVER_ERROR: "Something went wrong. Please try again.",
};

export async function loginWithPin(pin) {
  let res;
  try {
    res = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      // text/plain avoids a CORS preflight, which Apps Script can't answer
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ pin }),
    });
  } catch {
    throw new Error("Can't reach the server. Check your internet connection.");
  }

  const data = await res.json().catch(() => ({ ok: false, error: "SERVER_ERROR" }));
  if (!data.ok) throw new Error(ERROR_MESSAGES[data.error] || ERROR_MESSAGES.SERVER_ERROR);

  // Session-only login: closing the tab/browser logs out (safer on shared clinic PCs)
  await setPersistence(auth, browserSessionPersistence);
  await signInWithCustomToken(auth, data.token);
}

export function logout() {
  sessionStorage.clear();
  return signOut(auth);
}

// Calls back with a staff profile (from the token's custom claims), or null if logged out
export function watchAuth(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) return callback(null);
    try {
      const { claims } = await user.getIdTokenResult();
      callback({
        uid: user.uid,
        name: sessionStorage.getItem(`staffName:${user.uid}`) || claims.staffName || "Staff",
        role: claims.staffRole || "",
        photo: claims.staffPhoto || "",
        email: claims.staffEmail || "",
      });
    } catch (err) {
      console.error("Failed to read staff profile:", err);
      await signOut(auth);
    }
  });
}

// Updates ONLY this staff member's 'Staff Name' (enforced by Firestore rules)
export async function updateStaffName(newName) {
  const user = auth.currentUser;
  if (!user) throw new Error("You're not signed in.");

  const name = String(newName || "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Please enter a name.");
  if (name.length > 60) throw new Error("Name must be 60 characters or fewer.");

  // FieldPath is needed because the field name contains a space
  await updateDoc(doc(db, "staff_access", user.uid), new FieldPath("Staff Name"), name);
  sessionStorage.setItem(`staffName:${user.uid}`, name);
  return name;
}