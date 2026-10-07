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