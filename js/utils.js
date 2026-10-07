const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// "Johnny Cooney" -> "JC", "Mary Anne Smith" -> "MS"
export function getInitials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

// "1992-11-23" -> "Nov 23, 1992"
// Parsed manually on purpose: new Date("1992-11-23") is treated as UTC
// and can display the wrong day in some timezones.
export function formatDob(dobKey = "") {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobKey);
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`;
}

// Stable colour per patient for the avatar circle
export function hueFromString(str = "") {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// Local date -> "2026-10-07".
// Don't use toISOString() for this: it's UTC, so in Australia it returns
// YESTERDAY's date for the first 8–11 hours of each day.
export function toDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "2026-10-07" -> local Date (null if invalid, e.g. "2026-02-31")
export function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return toDateKey(d) === key ? d : null;
}

export function addDays(key, n) {
  const d = parseDateKey(key) || new Date();
  d.setDate(d.getDate() + n);
  return toDateKey(d);
}

// "Wednesday 7 October 2026"
export function formatLongDate(d) {
  return `${WEEKDAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

// "07 Oct 2026"
export function formatShortDate(d) {
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// "Wed, 7 Oct, 8:12 am"
export function formatUpdated(d) {
  const h = d.getHours() % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, "0");
  const ampm = d.getHours() < 12 ? "am" : "pm";
  return `${WEEKDAYS_LONG[d.getDay()].slice(0, 3)}, ${d.getDate()} ${MONTHS[d.getMonth()]}, ${h}:${mins} ${ampm}`;
}