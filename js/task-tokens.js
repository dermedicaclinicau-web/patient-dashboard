// The "blanks" a task message can use, the checks before publishing, and filling them in.
import { TASK_CHOICE_TYPES } from "./task-types.js";

export const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const OPEN = "\u0001";  // marks a field's sample in the preview
const CLOSE = "\u0002";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const todayLong = () => new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

// Phone, email and address from the letterhead
export function clinicDetails(lh) {
  const line1 = String((lh && lh.line1) || "");
  const line2 = String((lh && lh.line2) || "");
  const phone = (line2.match(/(?:tel|phone|ph)\.?\s*:?\s*([+\d][\d\s()-]{5,})/i) || [])[1] || "";
  const email = (line2.match(/[^\s|,;<>]+@[^\s|,;<>]+\.[^\s|,;<>]+/) || [])[0] || "";
  return { address: line1.trim(), phone: phone.trim(), email };
}

const SMART = {
  "Upcoming appointments": {
    hint: "Their upcoming appointments, from the appointment book",
    sample: "• Tue 14 Oct 2026, 10:00 am: Wrinkle Relaxer\n• Tue 11 Nov 2026, 2:30 pm: Review",
  },
  "Treatment plan": {
    hint: "Their latest treatment plan, from the consultation notes",
    sample: "Visit 1 (Oct 2026): Wrinkle Relaxer, forehead\nVisit 2 (Jan 2027): Review",
  },
  "Treatment info": {
    hint: "Information and links for the treatments ticked in the Treatments field",
    sample: "Wrinkle Relaxer\nhttps://www.dermedica.com.au/\n\nSkin Needling\nhttps://www.dermedica.com.au/",
  },
};

const BUILT_IN = ["first name", "full name", "email", "mobile", "date of birth", "patient name", "patient first name",
  "patient mobile", "patient email", "today", "staff name", "clinic phone", "clinic email", "clinic address",
  ...Object.keys(SMART).map((k) => k.toLowerCase())];

// The blanks available to a task, in groups, each with a sample value for the preview
export function tokenGroups(task, { staffName = "", letterhead = null } = {}) {
  const c = clinicDetails(letterhead);
  const tok = (name, sample, kind = "", hint = "") => ({ name, sample, kind, hint });
  const aboutPatient = task.category === "patient" || (task.recipients && task.recipients.aboutPatient);
  const groups = [];

  if (task.category === "patient") {
    groups.push({ title: "Patient", tokens: [
      tok("First name", "Jane"), tok("Full name", "Jane Citizen"), tok("Email", "jane@example.com"),
      tok("Mobile", "0400 000 000"), tok("Date of birth", "1 January 1990"),
    ] });
  } else {
    groups.push({ title: "Staff member it goes to", tokens: [tok("First name", "Sam"), tok("Full name", "Sam Nguyen")] });
    if (aboutPatient) {
      groups.push({ title: "Patient it's about", tokens: [
        tok("Patient name", "Jane Citizen"), tok("Patient first name", "Jane"),
        tok("Patient mobile", "0400 000 000"), tok("Patient email", "jane@example.com"),
      ] });
    }
  }
  groups.push({ title: "General", tokens: [
    tok("Today", todayLong()), tok("Staff name", staffName || "Your name"),
    tok("Clinic phone", c.phone || "9205 1995"), tok("Clinic email", c.email || "info@dermedica.com.au"),
    tok("Clinic address", c.address || "Scarborough WA"),
  ] });

  const fields = (task.fields || []).filter((f) => String(f.label || "").trim());
  if (fields.length) {
    groups.push({ title: "Your fields", tokens: fields.map((f) => tok(f.label.trim(), OPEN + f.label.trim() + CLOSE, "field")) });
  }
  if (aboutPatient) {
    const hasTx = (task.fields || []).some((f) => f.type === "treatments");
    groups.push({ title: "Smart blocks", tokens: Object.entries(SMART)
      .filter(([n]) => n !== "Treatment info" || hasTx)
      .map(([n, s]) => tok(n, s.sample, "smart", s.hint)) });
  }
  return groups;
}

export function tokensIn(text) {
  const out = [];
  String(text || "").replace(/\{([^{}\n]{1,80})\}/g, (_, n) => { out.push(n.trim()); return ""; });
  return out;
}

// Problems to fix before a task can be published ([] when it's ready)
export function taskProblems(task) {
  const out = [];
  if (!String(task.name || "").trim()) out.push("Give the task a name.");
  if (task.channel === "sms") out.push("SMS is still being built. Choose Email for now.");
  const r = task.recipients || {};
  if (task.category === "staff" && r.mode === "fixed" && !(r.staffIds || []).length) {
    out.push("Choose at least one staff member to send it to.");
  }
  if (r.cc && !EMAIL_RE.test(r.cc)) out.push("Check the CC email address.");

  const seen = new Set();
  (task.fields || []).forEach((f, i) => {
    const l = String(f.label || "").trim();
    const lower = l.toLowerCase();
    if (!l) out.push(`Field ${i + 1} needs a name.`);
    else if (seen.has(lower)) out.push(`Two fields are called “${l}”. Give each field its own name.`);
    else if (BUILT_IN.includes(lower)) out.push(`“${l}” is already a built-in blank. Choose a different field name.`);
    seen.add(lower);
    if (TASK_CHOICE_TYPES.includes(f.type) && !(f.options || []).length) out.push(`“${l || `Field ${i + 1}`}” needs at least one choice.`);
  });

  if (!String(task.subject || "").trim()) out.push("Add a subject.");
  if (!String(task.body || "").trim()) out.push("Write the message.");

  const known = new Set(tokenGroups(task).flatMap((g) => g.tokens.map((t) => t.name.toLowerCase())));
  [...tokensIn(task.subject), ...tokensIn(task.body)].forEach((n) => {
    if (known.has(n.toLowerCase())) return;
    if (n.toLowerCase() === "treatment info") out.push("Add a Treatments field so staff can choose which treatments {Treatment info} lists.");
    else if (BUILT_IN.includes(n.toLowerCase()) && task.category === "staff") {
      out.push(`{${n}} needs a patient. Tick “This is about a patient” in step 2, or remove it.`);
    } else out.push(`The message uses {${n}}, which isn't a blank this task has.`);
  });
  return [...new Set(out)];
}

// name (lower case) -> value
export function sampleValues(task, opts) {
  const map = new Map();
  tokenGroups(task, opts).forEach((g) => g.tokens.forEach((t) => map.set(t.name.toLowerCase(), t.sample)));
  return map;
}

export function fillTemplate(text, values) {
  return String(text || "").replace(/\{([^{}\n]{1,80})\}/g, (whole, n) => {
    const v = values.get(n.trim().toLowerCase());
    return v === undefined ? whole : String(v);
  });
}

const marks = (html) => html.replace(/\u0001([^\u0002]*)\u0002/g, '<mark class="tb-mark">$1</mark>');

// Plain text -> email HTML (paragraphs, line breaks, clickable links)
export function emailBodyHtml(text) {
  let h = esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  h = marks(h);
  return h.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

export const subjectHtml = (text) => marks(esc(text));