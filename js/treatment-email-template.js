// Treatment Info to Email (consultation notes): the email written in Task types, if one is published.
// The composer builds the treatments block as it does now; this puts it into the template.
import { getTreatmentEmailTask } from "./task-types.js";
import { getLetterhead } from "./form-templates.js";
import { fillTemplate, fillTemplateHtml, emailShell, clinicDetails } from "./task-tokens.js";
import { hydrateRichImages } from "./rich-html.js";
import { parseRecordDate } from "./transcripts.js";
import { formatMobile, formatDobLong } from "./utils.js";

let cache = null;

// The published template, or null. Remembered for a minute.
export async function treatmentEmailTemplate({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < 60000) return cache.task;
  let task = null;
  try { task = await getTreatmentEmailTask(); }
  catch (err) { console.warn("Treatment Info template not read, using the built-in email:", err); }
  cache = { at: Date.now(), task };
  return task;
}

// {Treatment details} on its own line: the whole paragraph is replaced (a block can't sit inside a paragraph)
const TOKEN_P = /<p[^>]*>\s*(?:<[^>]+>\s*)*\{\s*treatment details\s*\}\s*(?:<\/[^>]+>\s*)*<\/p>/gi;
const TOKEN = /\{\s*treatment details\s*\}/gi;
const MARK = "\u0004TXD\u0004";

// → { subject, html, logo }. blockHtml: the treatments block the composer already makes.
// patient: { name, firstName, email, mobile, dobKey } if known; otherwise the name on the record is used.
export async function buildTreatmentEmail({ task, blockHtml, record = {}, staff = null, patient = {} }) {
  const lh = await getLetterhead().catch(() => null);
  const c = clinicDetails(lh);
  const name = String(patient.name || record["Patient Name"] || "").trim();
  const when = parseRecordDate(record["Record Date and Time"]);
  const vals = new Map();
  const set = (k, v) => vals.set(k.toLowerCase(), v == null ? "" : String(v));
  set("First name", patient.firstName || name.split(" ")[0] || "there");
  set("Full name", name);
  set("Email", patient.email || "");
  set("Mobile", patient.mobile ? formatMobile(patient.mobile) : "");
  set("Date of birth", patient.dobKey ? formatDobLong(patient.dobKey) : "");
  set("Today", new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }));
  set("Staff name", (staff && staff.name) || "");
  set("Clinician", record["Staff Name"] || (staff && staff.name) || "");
  set("Consultation date", when ? when.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "");
  set("Clinic phone", c.phone); set("Clinic email", c.email); set("Clinic address", c.address);
  ["Upcoming appointments", "Treatment plan", "Treatment info", "Aftercare", "Skin Script"].forEach((k) => set(k, ""));

  const body = fillTemplateHtml(String(task.body || "").replace(TOKEN_P, MARK).replace(TOKEN, MARK), vals)
    .split(MARK).join(blockHtml || "");
  const subject = fillTemplate(String(task.subject || "").replace(TOKEN, ""), vals)
    .replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1").replace(/\s{2,}/g, " ").trim();
  return {
    subject,
    html: emailShell(body, task.style, { clinic: c, hasLogo: !!(lh && lh.logo) }),
    logo: (lh && lh.logo) || "",
  };
}

// For showing it on screen: the logo and Image Bank pictures filled in. Send the html WITHOUT this (Apps Script attaches them).
export function showTreatmentEmail(el, html, logo) {
  el.innerHTML = html;
  hydrateRichImages(el, { logo: logo || "" });
}