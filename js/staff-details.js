// Staff registration details (Staff → Edit → Registration), for filling in forms.
// Comes from the staff list in Apps Script (not the login token, which has a size limit). Kept for 5 minutes.
import { callApi } from "./appointments.js";

let cache = null;
let cachedAt = 0;

export async function listStaffDetails({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < 5 * 60000) return cache;
  const res = await callApi({ action: "staffList" });
  cache = (Array.isArray(res.staff) ? res.staff : []).map((s) => ({
    id: String(s.id || ""), name: String(s.name || ""), role: String(s.role || ""),
    providerNo: String(s.providerNo || ""), prescriberNo: String(s.prescriberNo || ""),
    ahpraNo: String(s.ahpraNo || ""), quals: String(s.quals || ""),
  }));
  cachedAt = Date.now();
  return cache;
}

// The logged-in staff member's entry (by ID, then by name)
export function staffDetailsFor(list, staff) {
  if (!staff || !Array.isArray(list)) return null;
  const ids = [staff.uid, staff.id].filter(Boolean).map(String);
  const nm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  return list.find((s) => ids.includes(s.id)) || list.find((s) => nm(s.name) && nm(s.name) === nm(staff.name)) || null;
}