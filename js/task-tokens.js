// The "blanks" a task message can use, the checks before publishing, and filling them in.
import { TASK_CHOICE_TYPES } from "./task-types.js";
import { richText } from "./rich-html.js";

export const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
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

// How chosen options appear in a message. Links are written as [[name|https://…]].
export function formatChoice(field, chosen) {
  const items = (chosen || []).filter((o) => o && o.label);
  if (!items.length) return "";
  const safe = (s) => String(s).replace(/[|\]]/g, " ");
  const display = field.display || "inline";
  if (display === "links") {
    return items.map((o) => "• " + (o.link && URL_RE.test(o.link) ? `[[${safe(o.label)}|${o.link}]]` : o.label)).join("\n");
  }
  if (display === "bullets") return items.map((o) => "• " + o.label).join("\n");
  const n = items.map((o) => o.label);
  return n.length < 2 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

const SMART = {
  "Upcoming appointments": {
    hint: "Their bookings from today onwards, from the appointment book. Staff choose how far ahead when sending.",
    sample: {
      html: "• <strong>Thu 22 Oct 2026, 10:30 am</strong>: Anti-wrinkle injections with Dr Joanna Teh<br>• <strong>Tue 17 Nov 2026, 2:00 pm</strong>: Skin review",
      text: "• Thu 22 Oct 2026, 10:30 am: Anti-wrinkle injections\n• Tue 17 Nov 2026, 2:00 pm: Skin review",
    },
  },
  "Treatment plan": {
    hint: "Their latest treatment plan, from the consultation notes",
    sample: "Visit 1 (Oct 2026): Wrinkle Relaxer, forehead\nVisit 2 (Jan 2027): Review",
  },
  "Treatment info": {
    hint: "The treatments ticked in your Treatment information field, as clickable links",
    sample: "",
  },
  "Aftercare": {
    hint: "The aftercare ticked on a form (filled in when using Email aftercare on a form)",
    sample: {
      html: "<h2>IPL Hair Removal Aftercare Instructions</h2><p>Proper aftercare helps your skin heal well:</p><ul><li>Avoid sun exposure for 2 weeks.</li><li>Don't pick any scabs.</li></ul>",
      text: "IPL Hair Removal Aftercare Instructions",
    },
  },
  "Skin Script": {
    hint: "The patient's Skin Script Protocol as a table in the email. Staff choose which one and can preview the email before sending.",
    sample: {
      html: '<p style="margin:0 0 10px"><strong>Skin Script record date:</strong> 12 October 2026</p>' +
        '<table width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #ece9e2;margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px">' +
        '<tr><th style="padding:8px 10px;background:#f4f2ed;text-align:left;font-size:11px">STEP</th><th style="padding:8px 10px;background:#f4f2ed;text-align:left;font-size:11px">☀ MORNING</th><th style="padding:8px 10px;background:#f4f2ed;text-align:left;font-size:11px">✨ EVENING</th></tr>' +
        '<tr><td style="padding:9px 10px;background:#ede9fe;color:#6d28d9;font-weight:bold">Step A</td><td style="padding:9px 10px"><b>Dermedica Essential Cleanser</b><br>Apply a pea-sized amount, then rinse off</td><td style="padding:9px 10px;background:#faf9f6"></td></tr>' +
        '<tr><td style="padding:9px 10px;background:#fef3c7;color:#b45309;font-weight:bold">Step E</td><td style="padding:9px 10px"><b>Dermedica Sunscreen</b><br>Apply 2 large pea size amounts</td><td style="padding:9px 10px;background:#faf9f6"></td></tr>' +
        '</table><p style="margin:0 0 14px">This Skin Script Protocol is valid until <strong>12 January 2027</strong>.</p>',
      text: "Skin Script record date: 12 October 2026 (table)",
    },
  },
};

const SPECIALIST_TOKENS = ["Specialist name", "Specialist speciality", "Specialist practice", "Specialist email", "Specialist phone", "Specialist address"];
const BUILT_IN = ["first name", "full name", "email", "mobile", "date of birth", "patient name", "patient first name",
  "patient mobile", "patient email", "today", "staff name", "clinic phone", "clinic email", "clinic address",
  ...Object.keys(SMART).map((k) => k.toLowerCase()), ...SPECIALIST_TOKENS.map((k) => k.toLowerCase())];
const fillsForms = (task) => (task.attachments || []).some((a) => /^(fill|saved):/.test(String(a)));
const treatmentsField = (task) => (task.fields || []).find((f) => TASK_CHOICE_TYPES.includes(f.type) && f.source === "treatments");

// A field's sample for the preview: real choices where we have them
function fieldSample(f, sources) {
  if (TASK_CHOICE_TYPES.includes(f.type)) {
    const opts = f.source === "list" ? (f.options || []) : ((sources && sources[f.source]) || []);
    const pick = f.type === "checkboxes" ? opts.slice(0, 2) : opts.slice(0, 1);
    const text = formatChoice(f, pick);
    if (text) return OPEN + text + CLOSE;
  }
  return OPEN + f.label.trim() + CLOSE;
}

// The blanks available to a task, in groups, each with a sample value for the preview
export function tokenGroups(task, { staffName = "", letterhead = null, sources = {} } = {}) {
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

  if (fillsForms(task)) {
    const samples = ["Dr Sarah Lee", "Dermatologist", "Perth Skin Specialists", "reception@example.com", "08 9000 0000", "12 Example St, Perth WA 6000"];
    groups.push({ title: "From the attached form", tokens: SPECIALIST_TOKENS.map((n, i) =>
      tok(n, samples[i], "", "From the Referral specialist on the attached form, once it's filled in")) });
  }
  
  const fields = (task.fields || []).filter((f) => String(f.label || "").trim());
  if (fields.length) {
    groups.push({ title: "Your fields", tokens: fields.map((f) => tok(f.label.trim(), fieldSample(f, sources), "field")) });
  }
  if (aboutPatient) {
    const tx = treatmentsField(task);
    groups.push({ title: "Smart blocks", tokens: Object.entries(SMART)
      .filter(([n]) => (n !== "Treatment info" || tx) && (!["Aftercare", "Skin Script"].includes(n) || task.category === "patient"))
      .map(([n, s]) => tok(n, n === "Treatment info" ? fieldSample({ ...tx, display: "links" }, sources) : s.sample, "smart", s.hint)) });
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
  if (task.category === "staff" && !r.aboutPatient && fillsForms(task)) {
    out.push("Attachments filled in by staff (or saved copies) need a patient. Tick “This is about a patient”, or set them to Blank.");
  }
  const seen = new Set();
  (task.fields || []).forEach((f, i) => {
    const l = String(f.label || "").trim();
    const lower = l.toLowerCase();
    const name = l || `Field ${i + 1}`;
    if (!l) out.push(`Field ${i + 1} needs a name.`);
    else if (seen.has(lower)) out.push(`Two fields are called “${l}”. Give each field its own name.`);
    else if (BUILT_IN.includes(lower)) out.push(`“${l}” is already a built-in blank. Choose a different field name.`);
    seen.add(lower);
    if (TASK_CHOICE_TYPES.includes(f.type) && (f.source || "list") === "list") {
      const opts = (f.options || []).filter((o) => String(o.label || "").trim());
      if (!opts.length) out.push(`“${name}” needs at least one choice.`);
      (f.options || []).forEach((o) => {
        if (o.link && !URL_RE.test(String(o.link).trim())) {
          out.push(`In “${name}”, the link for “${o.label || "a choice"}” should start with https://`);
        }
      });
    }
  });

  if (!String(task.subject || "").trim()) out.push("Add a subject.");
  if (!richText(task.body)) out.push("Write the message.");

  const known = new Set(tokenGroups(task).flatMap((g) => g.tokens.map((t) => t.name.toLowerCase())));
  const about = !!(task.recipients && task.recipients.aboutPatient);
  const STAFF_SWAP = { email: "Patient email", mobile: "Patient mobile" }; // patient-task blanks with a staff-task version
  [...tokensIn(task.subject), ...tokensIn(task.body)].forEach((n) => {
    const lower = n.toLowerCase();
    if (known.has(lower)) return;
    if (lower === "treatment info") {
      out.push("Add a Treatments field (connected to Treatment information) to use {Treatment info}.");
    } else if (task.category === "staff" && STAFF_SWAP[lower]) {
      out.push(`{${n}} only works in To Patient tasks. For the patient's details use {${STAFF_SWAP[lower]}}${about ? "" : " (and tick “This is about a patient”)"}.`);
    } else if (task.category === "staff" && lower === "date of birth") {
      out.push("{Date of birth} only works in To Patient tasks. Remove it from this staff task.");
    } else if (task.category === "staff" && lower === "skin script") {
      out.push("{Skin Script} only works in To Patient tasks. Remove it from this staff task.");
    } else if (task.category === "staff" && lower === "aftercare") {
      out.push("{Aftercare} only works in To Patient tasks. Add an Aftercare field in step 3 and use {Aftercare instructions}.");
    } else if (task.category === "staff" && !about && BUILT_IN.includes(lower)) {
      out.push(`{${n}} needs a patient. Tick “This is about a patient” in step 2, or remove it.`);
    } else {
      out.push(`The message uses {${n}}, which isn't a blank this task has.`);
    }
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
    return v === undefined ? whole : (v && typeof v === "object" ? String(v.text || "") : String(v));
  });
}

const marks = (html) => html.replace(/\u0001([^\u0002]*)\u0002/g, '<mark class="tb-mark">$1</mark>');

// Plain text -> email HTML: paragraphs, line breaks, [[name|link]] as clickable names, bare links clickable
export function emailBodyHtml(text) {
  const links = [];
  const withSlots = String(text || "").replace(/\[\[([^|\]]{1,200})\|(https?:\/\/[^\]\s]{1,500})\]\]/g, (_, label, url) => {
    links.push([label, url]);
    return `\u0003${links.length - 1}\u0003`;
  });
  let h = esc(withSlots).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  h = h.replace(/\u0003(\d+)\u0003/g, (_, i) => {
    const [label, url] = links[Number(i)];
    return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  });
  h = marks(h);
  return h.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

export const subjectHtml = (text) => marks(esc(String(text || "").replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1")));

/* ===================== Rich (designed) emails ===================== */

export const EMAIL_BACKGROUNDS = ["#f1f5f9", "#ffffff", "#f0fdfa", "#fdf2f8", "#fefce8", "#eef2ff", "#f5f5f4"];
export const EMAIL_ACCENTS = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#b45309", "#1e293b"];

// A filled-in value as HTML: links clickable, line breaks kept
export function valueToHtml(v) {
  if (v && typeof v === "object") return String(v.html || ""); // already-safe HTML (e.g. aftercare)
  const links = [];
  const t = String(v ?? "").replace(/\[\[([^|\]]{1,200})\|(https?:\/\/[^\]\s]{1,500})\]\]/g, (_, l, u) => {
    links.push([l, u]);
    return `\u0003${links.length - 1}\u0003`;
  });
  let h = esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  h = h.replace(/\u0003(\d+)\u0003/g, (_, i) => `<a href="${esc(links[+i][1])}" target="_blank" rel="noopener">${esc(links[+i][0])}</a>`);
  return marks(h).replace(/\n/g, "<br>");
}

// A filled-in value as plain text (preview highlights and [[name|link]] markers removed)
function plainValue(v) {
  if (v && typeof v === "object") v = v.text || "";
  return String(v ?? "").replace(/[\u0001\u0002]/g, "");
}

// A value inside a link's address. At the start: the whole address (must be a web, email or phone link).
// Anywhere else: made URL-safe, e.g. "Mary-Jane O'Brien" → "Mary-Jane%20O'Brien".
function hrefPart(v, atStart) {
  const s = plainValue(v).trim();
  if (atStart) {
    const m = /\[\[[^|\]]+\|(https?:\/\/[^\]\s]+)\]\]/.exec(s);
    const u = m ? m[1] : s.replace(/^•\s*/, "").split(/\s+/)[0] || "";
    if (/^(https?:\/\/|mailto:|tel:)/i.test(u)) return u;
    return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(u) ? `https://${u}` : "#";
  }
  return encodeURIComponent(s.replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1").replace(/^•\s*/gm, "").replace(/\n+/g, ", "));
}

// Fills {blanks} in rich HTML: in the text, and inside links (href); never anywhere else in a tag
export function fillTemplateHtml(html, values) {
  const fillHref = (url) => url.replace(/\{([^{}\n]{1,80})\}/g, (whole, n, offset) => {
    const v = values.get(n.trim().toLowerCase());
    if (v === undefined || plainValue(v) === whole) return whole; // left for the server, e.g. {First name} in staff tasks
    return esc(hrefPart(v, offset === 0));
  });
  return String(html || "").split(/(<[^>]*>)/).map((part) => (part.startsWith("<")
    ? part.replace(/(\shref\s*=\s*")([^"]*)(")/gi, (m, a, url, c) => a + fillHref(url) + c)
    : part.replace(/\{([^{}\n]{1,80})\}/g, (whole, n) => {
        const v = values.get(n.trim().toLowerCase());
        return v === undefined ? whole : valueToHtml(v);
      }))).join("");
}

// The designed email: background, white card, optional logo and clinic footer
export function emailShell(inner, style = {}, { clinic = {}, hasLogo = false, clinicName = "Dermedica" } = {}) {
  const s = { background: "#f1f5f9", width: 600, logo: true, footer: true, accent: "#0f766e", ...style };
  const doc = new DOMParser().parseFromString(`<div>${inner || ""}</div>`, "text/html");
  const box = doc.body.firstElementChild;
  const add = (sel, css) => box.querySelectorAll(sel).forEach((el) => {
    el.setAttribute("style", `${css};${el.getAttribute("style") || ""}`);
  });
  add("p", "margin:0 0 14px");
  add("h1", `margin:0 0 14px;font-size:26px;line-height:1.25;color:${s.accent}`);
  add("h2", `margin:18px 0 10px;font-size:20px;line-height:1.3;color:${s.accent}`);
  add("h3", "margin:16px 0 8px;font-size:16px;line-height:1.35;color:#1e293b");
  add("ul,ol", "margin:0 0 14px;padding-left:22px");
  add("li", "margin:0 0 4px");
  add("img", "max-width:100%;height:auto");
  box.querySelectorAll("a").forEach((a) => {
    if (!/background-color/i.test(a.getAttribute("style") || "")) a.setAttribute("style", `color:${s.accent};${a.getAttribute("style") || ""}`);
  });
  const font = "font-family:Arial,Helvetica,sans-serif";
  const logo = s.logo && hasLogo
    ? `<p style="margin:0 0 22px;text-align:center"><img data-logo="1" alt="${esc(clinicName)}" width="170" style="max-width:170px;height:auto"></p>`
    : "";
  const footText = [clinicName, clinic.address, clinic.phone && `Tel ${clinic.phone}`, clinic.email].filter(Boolean).join("  ·  ");
  const foot = s.footer
    ? `<tr><td style="padding:16px 34px 22px;border-top:1px solid #e2e8f0;${font};font-size:12px;line-height:1.5;color:#64748b;text-align:center">${esc(footText)}</td></tr>`
    : "";
  return `<div style="margin:0;padding:24px 12px;background-color:${s.background}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${s.width}px;margin:0 auto;background-color:#ffffff;border-radius:12px">` +
    `<tr><td style="padding:30px 34px;${font};font-size:15px;line-height:1.6;color:#1e293b">${logo}${box.innerHTML}</td></tr>${foot}</table></div>`;
}