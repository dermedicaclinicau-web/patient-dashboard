import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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
export const LOGIN_ENDPOINT = "https://script.google.com/macros/s/AKfycbzKmMFcYHcGZ2xOZdOaONyH4sNzeGOEntzhl76BjuaIpCFmTTpudcrBJi9SgUX3to3abg/exec";
export const FORM_BUILDER_URL = "https://script.google.com/macros/s/AKfycbz9zMmfaSwAEmnnbLby1TFxyce48SlwbQCcv-hwZl0CKpjvyF33FZg2R-LcNsCeY6wR/exec";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
