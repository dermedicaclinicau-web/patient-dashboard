import { LOGIN_ENDPOINT, db } from "./firebase-config.js";
import { doc, getDoc, collection, query, where, limit, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
    const [snap, meta] = await Promise.all([
      getDoc(doc(db, "appts_by_day", dateKey)),
      getSyncMeta(),
    ]);
    return {
      ok: true,
      date: dateKey,
      lastUpdated: meta.sheetUpdatedAt || null,
      appointments: snap.exists() ? (snap.data().appointments || []) : [],
    };
  } catch (err) {
    console.error("Appointments load failed:", err);
    throw friendlyError(err, "Couldn't load appointments. Please try again.");
  }
}

// Shared Apps Script caller
export async function callApi(payload) {
  const session = sessionStorage.getItem("appSession");
  if (!session) throw unauthorized();

  let res;
  try {
    res = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, session }),
    });
  } catch {
    throw new Error("Can't reach the server. Check your internet connection.");
  }

  const data = await res.json().catch(() => null);
  if (!data) throw new Error("Unexpected response from the server.");
  if (!data.ok) {
    if (data.error === "UNAUTHORIZED") throw unauthorized();
    throw new Error("Couldn't load data. Please try again.");
  }
  return data;
}

// Pre-consultation record from Firestore 'pcn_results' (matched by Patient ID, then unique name)
export async function fetchPreconsult(patient) {
  try {
    const ids = [...new Set([patient.pttId, patient.id].map(toDocId).filter(Boolean))];

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