import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  memoryLocalCache, terminate, clearIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// PUBLIC web config: safe to commit.
// This is NOT the service account key. That stays in Apps Script only.
const firebaseConfig = {
  apiKey: "AIzaSyCHGXFwaFmJFrSPgts2qxTOZxhpZVMd_I8",
  authDomain: "disco-serenity-428708-t8.firebaseapp.com",
  projectId: "disco-serenity-428708-t8",
  storageBucket: "disco-serenity-428708-t8.firebasestorage.app",
  appId: "1:827152098304:web:2d038feb11a1eedec2e4e5",
};

// Apps Script web app URL (ends with /exec)
export const LOGIN_ENDPOINT = "https://script.google.com/a/macros/dermedica.com.au/s/AKfycbzb4J7itwDNblPVtBbbZoxdcd2DOqmiZTMXeI7lnRIKuCV92YjJ6hHgS74wz3G9uqOuSA/exec";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// A copy of what's been read is kept on the device, shared by every open tab
// (the Consultation tab, the patient page...). Falls back to memory where that isn't allowed
// (Safari private browsing, very old iPads).
function makeDb() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (err) {
    console.warn("Device copy not available, using memory only:", err);
    try { return initializeFirestore(app, { localCache: memoryLocalCache() }); }
    catch { return getFirestore(app); }   // something else already set Firestore up
  }
}
export const db = makeDb();
export const storage = getStorage(app);

// Call on sign-out, then reload the page: removes the patient data kept on this device.
export async function clearLocalData() {
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (err) {
    console.warn("Couldn't clear the device copy:", err);
  }
}