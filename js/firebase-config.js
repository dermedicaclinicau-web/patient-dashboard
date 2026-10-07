import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// PUBLIC web config: safe to commit.
// This is NOT the service account key. That stays in Apps Script only.
const firebaseConfig = {
  apiKey: "AIzaSyCHGXFwaFmJFrSPgts2qxTOZxhpZVMd_I8",
  authDomain: "disco-serenity-428708-t8.firebaseapp.com",
  projectId: "disco-serenity-428708-t8",
  appId: "1:827152098304:web:2d038feb11a1eedec2e4e5",
};

// Apps Script web app URL (ends with /exec)
export const LOGIN_ENDPOINT = "https://script.google.com/macros/s/AKfycbzKmMFcYHcGZ2xOZdOaONyH4sNzeGOEntzhl76BjuaIpCFmTTpudcrBJi9SgUX3to3abg/exec";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);