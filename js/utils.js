const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// "Johnny Cooney" -> "JC", "Mary Anne Smith" -> "MS"
export function getInitials(name = "") {
  // Ignore numbers/symbols, so "Ashley Hanna #1" -> "AH"
  const parts = name.replace(/[^\p{L}\s'-]/gu, " ").trim().split(/\s+/).filter(Boolean);
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

// "1992-11-23" -> "November 23, 1992"
export function formatDobLong(dobKey) {
  const d = parseDateKey(dobKey);
  return d ? `${MONTHS_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : "";
}

// Age in whole years (accounts for birthdays not yet reached this year)
export function calcAge(dobKey, today = new Date()) {
  const d = parseDateKey(dobKey);
  if (!d) return null;
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age >= 0 ? age : null;
}

// "409401995" -> "0409 401 995" (restores the leading 0 spreadsheets often drop)
export function formatMobile(raw = "") {
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("61") && d.length === 11) d = "0" + d.slice(2);
  if (d.length === 9 && d.startsWith("4")) d = "0" + d;
  if (d.length === 10 && d.startsWith("04")) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  return String(raw).trim();
}

// Phone number for tel:/sms: links, in international format
export function toTelHref(raw = "") {
  const d = String(raw).replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("61")) return `+${d}`;
  if (d.startsWith("0")) return `+61${d.slice(1)}`;
  if (d.length === 9) return `+61${d}`; // e.g. 409401995
  return d;
}

// Small pop-up message at the bottom of the screen.
// Open windows sit above everything else, so while one is open
// the message is placed inside the top window to stay visible.
let toastTimer;
let toastEl = null;
export function showToast(message) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
  }
  const open = [...document.querySelectorAll("dialog[open]")];
  const host = open.length ? open[open.length - 1] : document.body; // the most recently opened window
  if (toastEl.parentNode !== host) {
    toastEl.classList.remove("show");
    host.appendChild(toastEl);
    void toastEl.offsetWidth; // lets the slide-in play after moving
  }
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function validKey(y, mo, d) {
  const key = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return parseDateKey(key) ? key : ""; // rejects impossible dates like 1986-02-31
}

// Any common date format -> "YYYY-MM-DD" (or "" if it can't be read safely)
export function toDateKeyLoose(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value.toDate === "function") value = value.toDate(); // Firestore Timestamp
  if (value instanceof Date) return isNaN(value) ? "" : toDateKey(value);

  const s = String(value).trim();
  let m;

  // ISO timestamp with timezone, e.g. "1986-02-06T16:00:00.000Z" -> LOCAL date (7 Feb in Perth)
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? "" : toDateKey(d);
  }

  // 1986-02-07 / 1986-2-7 / 1986/02/07 / "1986-02-07 00:00:00"
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return validKey(m[1], m[2], m[3]);

  // 07/02/1986 -> Australian day/month/year
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) return validKey(m[3], m[2], m[1]);

  // February 7, 1986 / Feb 7 1986
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    const mo = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
    return mo === undefined ? "" : validKey(m[3], mo + 1, m[2]);
  }

  // 7 February 1986 / 7 Feb, 1986
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
    const mo = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()];
    return mo === undefined ? "" : validKey(m[3], mo + 1, m[1]);
  }

  return "";
}