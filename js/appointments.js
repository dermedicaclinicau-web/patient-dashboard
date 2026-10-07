import { LOGIN_ENDPOINT } from "./firebase-config.js";

function unauthorized() {
  const err = new Error("Your session has expired. Please log in again.");
  err.code = "UNAUTHORIZED";
  return err;
}

// Fetch all appointments for one day ("2026-10-07") from the Google Sheet via Apps Script
export async function fetchDayAppointments(dateKey) {
  const session = sessionStorage.getItem("appSession");
  if (!session) throw unauthorized();

  let res;
  try {
    res = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight
      body: JSON.stringify({ action: "appointments", session, date: dateKey }),
    });
  } catch {
    throw new Error("Can't reach the server. Check your internet connection.");
  }

  const data = await res.json().catch(() => null);
  if (!data) throw new Error("Unexpected response from the server.");
  if (!data.ok) {
    if (data.error === "UNAUTHORIZED") throw unauthorized();
    throw new Error("Couldn't load appointments. Please try again.");
  }
  return data;
}

// Shared Apps Script caller
async function callApi(payload) {
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

// Pre-consultation row from 'pcn_results' (matched by Patient ID, then unique name)
export function fetchPreconsult(patient) {
  return callApi({
    action: "preconsult",
    ids: [patient.pttId, patient.id].filter(Boolean),
    name: patient.name,
  });
}