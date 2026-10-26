import { LOGIN_ENDPOINT, db, auth } from "./firebase-config.js";
import { doc, getDoc, collection, query, where, limit, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { patientIds } from "./patients.js";
import { listManualAppts, mergeDay } from "./manual-appts.js";

// "Data last uploaded" info, cached for 60 seconds
let syncMeta = null;
let syncMetaAt = 0;
async function getSyncMeta() {
  if (syncMeta && Date.now() - syncMetaAt < 60_000) return syncMeta;
  const snap = await getDoc(doc(db, "sync_meta", "pcn"));
  syncMeta = snap.exists() ? snap.data() : {};
  syncMetaAt = Date.now();
  return syncMeta;
}

function friendlyError(err, fallback) {
  const e = new Error(err.code === "permission-denied"
    ? "You don't have access to this data. Check the Firestore rules."
    : fallback);
  e.code = err.code;
  return e;
}

// Must match docId_() in Apps Script
const toDocId = (s) => String(s || "").trim().replace(/\//g, "_");

function unauthorized() {
  const err = new Error("Your session has expired. Please log in again.");
  err.code = "UNAUTHORIZED";
  return err;
}

// All appointments for one day ("2026-10-07"), from Firestore (synced from the sheet)
export async function fetchDayAppointments(dateKey) {
  try {
    const [snap, meta, manual] = await Promise.all([
      getDoc(doc(db, "appts_by_day", dateKey)),
      getSyncMeta(),
      // Bookings added on the calendar. If they can't be read, the Day Sheet still shows.
      listManualAppts(dateKey).catch((err) => { console.warn("Calendar bookings not loaded:", err); return []; }),
    ]);
    const sheet = snap.exists() ? (snap.data().appointments || []) : [];
    return {
      ok: true,
      date: dateKey,
      lastUpdated: meta.sheetUpdatedAt || null,
      appointments: mergeDay(sheet, manual, meta.sheetUpdatedAt),
    };
  } catch (err) {
    console.error("Appointments load failed:", err);
    throw friendlyError(err, "Couldn't load appointments. Please try again.");
  }
}

// One request to Apps Script → its answer, or an error you can show
async function postApi(body) {
  let res;
  try {
    res = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },   // avoids a CORS preflight
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the server. Check your internet connection.");
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("Unexpected response from the server.");
  return data;
}

// The Apps Script session lasts 12 hours. When it has run out but the person is still signed in
// (e.g. an iPad left asleep overnight), a new one is made from their Firebase login.
// Several requests failing at once share one renewal.
let renewing = null;
function renewSession() {
  if (!renewing) {
    renewing = (async () => {
      const user = auth.currentUser;
      if (!user) return false;
      let idToken = "";
      try { idToken = await user.getIdToken(); } catch { return false; }   // refreshed by Firebase if needed
      const data = await postApi({ action: "renewSession", idToken }).catch(() => null);
      if (!data || !data.ok || !data.session) return false;
      sessionStorage.setItem("appSession", data.session);
      console.info("Session renewed.");
      return true;
    })().finally(() => { renewing = null; });
  }
  return renewing;
}

// Shared Apps Script caller
export async function callApi(payload, retried = false) {
  if (!sessionStorage.getItem("appSession") && !(await renewSession())) throw unauthorized();
  const data = await postApi({ ...payload, session: sessionStorage.getItem("appSession") });

  // A renewed session (the access check every 5 minutes sends one): kept, so it never runs out while in use
  if (typeof data.session === "string" && /^s1\./.test(data.session)) sessionStorage.setItem("appSession", data.session);

  if (!data.ok) {
    if (data.error === "UNAUTHORIZED") {
      // Refused before anything ran, so trying again once is safe
      if (!retried && await renewSession()) return callApi(payload, true);
      throw unauthorized();
    }
    const e = new Error(data.detail ? String(data.detail) : "Couldn't load data. Please try again.");
    e.code = data.error;
    e.detail = data.detail || "";
    console.warn("Apps Script said no:", payload.action, payload.op || "", data.error, data.detail || "");
    throw e;
  }
  return data;
}

// Pre-consultation record from Firestore 'pcn_results' (matched by Patient ID, then unique name)
export async function fetchPreconsult(patient) {
  try {
          const ids = [...new Set(patientIds(patient).map(toDocId).filter(Boolean))];

    const [snaps, meta] = await Promise.all([
      Promise.all(ids.map((id) => getDoc(doc(db, "pcn_results", id)))),
      getSyncMeta(),
    ]);

    let hit = snaps.find((s) => s.exists()) || null;

    // Fallback: exact name, ONLY if exactly one patient has it
    if (!hit && patient.name) {
      const nameKey = patient.name.toLowerCase().replace(/\s+/g, " ").trim();
      const res = await getDocs(
        query(collection(db, "pcn_results"), where("nameKey", "==", nameKey), limit(2))
      );
      if (res.size === 1) hit = res.docs[0];
    }

    return {
      ok: true,
      found: !!hit,
      data: hit ? hit.data() : null,
      lastUpdated: meta.sheetUpdatedAt || null,
    };
  } catch (err) {
    console.error("Pre-consultation load failed:", err);
    throw friendlyError(err, "Couldn't load pre-consultation data.");
  }
}