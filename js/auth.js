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
  INACTIVE: "This account is turned off. Please contact an admin.",
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
  sessionStorage.setItem("appSession", data.session || "");

  // Session-only login: closing the tab/browser logs out (safer on shared clinic PCs)
  await setPersistence(auth, browserSessionPersistence);
  await signInWithCustomToken(auth, data.token);
}

export function logout() {
  sessionStorage.clear();
  if (TAB_CH) TAB_CH.postMessage({ t: "logout" });   // every other portal tab logs out too
  return signOut(auth);
}

/* ---------- Sharing the login between tabs ----------
   A new tab asks the open portal tabs for their login and uses it. Nothing is stored on the computer,
   so once every portal tab is closed, the next one asks for a PIN again. */
const TAB_CH = typeof BroadcastChannel === "function" ? new BroadcastChannel("dermedica-portal-login") : null;

if (TAB_CH) {
  TAB_CH.addEventListener("message", (e) => {
    const m = e.data || {};
    const user = auth.currentUser;
    if (m.t === "ask" && user) {
      const session = sessionStorage.getItem("appSession");
      if (session) {
        TAB_CH.postMessage({ t: "give", id: m.id, session, uid: user.uid,
          name: sessionStorage.getItem(`staffName:${user.uid}`) || "" });
      }
    } else if (m.t === "logout" && user) {
      sessionStorage.clear();
      signOut(auth);
    }
  });
}

// The login from another open portal tab, or null if none answers in time
function askOtherTabs(ms = 800) {
  if (!TAB_CH) return Promise.resolve(null);
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise((resolve) => {
    const finish = (v) => { clearTimeout(timer); TAB_CH.removeEventListener("message", onMsg); resolve(v); };
    const onMsg = (e) => { const m = e.data || {}; if (m.t === "give" && m.id === id && m.session) finish(m); };
    const timer = setTimeout(() => finish(null), ms);
    TAB_CH.addEventListener("message", onMsg);
    TAB_CH.postMessage({ t: "ask", id });
  });
}

// Signs this tab in with another tab's login. true if it worked.
async function loginFromOtherTab() {
  const got = await askOtherTabs();
  if (!got) return false;
  try {
    const res = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "staff", op: "me", session: got.session }),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok || !data.token) return false;   // expired or turned off: the PIN screen shows
    sessionStorage.setItem("appSession", data.session || got.session);
    if (got.uid && got.name) sessionStorage.setItem(`staffName:${got.uid}`, got.name);
    await setPersistence(auth, browserSessionPersistence);
    await signInWithCustomToken(auth, data.token);
    return true;
  } catch (err) {
    console.warn("Login from another tab failed:", err);
    return false;
  }
}

// The claims inside the login token already on this computer (used when the network is briefly down)
function cachedClaims(user) {
  try {
    const part = String(user.accessToken || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

// Calls back with a staff profile (from the token's custom claims), or null if logged out.
// A network blip never logs anyone out: it retries, then uses the token already on this computer.
let firstCheck = true;   // only a tab that has just opened borrows another tab's login
export function watchAuth(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      const tryTabs = firstCheck;
      firstCheck = false;
      if (tryTabs && await loginFromOtherTab()) return;   // signing in: this runs again with the user
      return callback(null);
    }
    firstCheck = false;
    let claims = null;
    for (let i = 0; i < 3 && !claims; i++) {
      try {
        claims = (await user.getIdTokenResult()).claims;
      } catch (err) {
        if (/user-disabled|user-token-expired|invalid-user-token|user-not-found/.test(String(err && err.code))) {
          console.warn("Sign-in is no longer valid:", err);
          await signOut(auth);
          return;
        }
        console.warn(`Couldn't read the login token (try ${i + 1} of 3):`, err);
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    if (!claims) claims = cachedClaims(user);
    if (auth.currentUser !== user) return; // signed out or switched user while retrying
    if (!claims) {
      console.error("Login token couldn't be read; signing out.");
      await signOut(auth);
      return;
    }
    callback({
      uid: user.uid,
      name: sessionStorage.getItem(`staffName:${user.uid}`) || claims.staffName || "Staff",
      role: claims.staffRole || "",
      photo: claims.staffPhoto || "",
      email: claims.staffEmail || "",
      injector: claims.injector === true,
      perms: Array.isArray(claims.perms) ? claims.perms : [],
    });
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

// Wakes the Apps Script up (and pre-loads the staff list) while the PIN is being typed.
// Fire-and-forget: errors are ignored, the real login still works without it.
let warmedAt = 0;
export function warmUpLogin() {
  if (Date.now() - warmedAt < 60_000) return; // at most once a minute
  warmedAt = Date.now();
  fetch(`${LOGIN_ENDPOINT}?warm=1`, { method: "GET" }).catch(() => {});
}