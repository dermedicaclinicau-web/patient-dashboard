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
export const LOGIN_ENDPOINT = "https://script.google.com/a/macros/dermedica.com.au/s/AKfycbzb4J7itwDNblPVtBbbZoxdcd2DOqmiZTMXeI7lnRIKuCV92YjJ6hHgS74wz3G9uqOuSA/exec";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
