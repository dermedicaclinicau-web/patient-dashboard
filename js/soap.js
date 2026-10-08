// Sections of the recorder's SOAP format, in the order they're DISPLAYED (matches your screenshot)
export const SECTIONS = [
  { key: "clinical", title: "Clinical Notes", heading: "CLINICAL NOTES", aliases: ["CLINICAL NOTES"], tone: "blue", icon: "steth", full: true },
  { key: "social", title: "Social History", heading: "SOCIAL HISTORY", aliases: ["SOCIAL HISTORY"], tone: "teal", icon: "users" },
  { key: "personality", title: "Personality", heading: "PERSONALITY", aliases: ["PERSONALITY"], tone: "purple", icon: "brain" },
  { key: "medication", title: "Medication", heading: "MEDICATION", aliases: ["MEDICATION", "MEDICATIONS", "CURRENT MEDICATIONS"], tone: "amber", icon: "pill" },
  { key: "conditions", title: "Medical Conditions", heading: "MEDICAL CONDITIONS", aliases: ["MEDICAL CONDITIONS", "MEDICAL CONDITION"], tone: "red", icon: "heart" },
  { key: "plan", title: "Treatment Plan (In-Clinic)", heading: "TREATMENT PLAN", aliases: ["TREATMENT PLAN"], tone: "green", icon: "clipboard", full: true },
  { key: "allergies", title: "Allergies", heading: "ALLERGIES", aliases: ["ALLERGIES", "ALLERGY"], tone: "red", icon: "alert" },
  { key: "email", title: "Treatment Info to Email", heading: "TREATMENT INFORMATION TO EMAIL", aliases: ["TREATMENT INFORMATION TO EMAIL", "TREATMENT INFO TO EMAIL"], tone: "indigo", icon: "mail" },
  { key: "booking", title: "Book Next Appointment", heading: "BOOK NEXT APPOINTMENT", aliases: ["BOOK NEXT APPOINTMENT"], tone: "slate", icon: "calendar", full: true },
];

// The order sections are SAVED in, the same as the recorder's formatSoapFromJSON
const SAVE_ORDER = ["clinical", "social", "personality", "medication", "conditions", "allergies", "email", "plan", "booking"];

const SIDECAR_RE = /\s*<!--STRUCTURED_SIDECAR:[\s\S]*?-->\s*$/;
const HEADING_RE = /^!!\s*([^:\n]+?)\s*:\s*$/;

function keyFor(heading) {
  const h = heading.toUpperCase().replace(/\s+/g, " ").trim();
  const s = SECTIONS.find((sec) => sec.aliases.includes(h));
  return s ? s.key : null;
}

// SOAP text -> { preamble, sections: {key: text}, headings: {key: original heading}, extras: [{heading, text}], sidecar }
export function parseSoap(raw) {
  let text = String(raw || "");
  const sm = text.match(SIDECAR_RE);
  const sidecar = sm ? sm[0].trim() : "";
  if (sm) text = text.slice(0, sm.index);

  const out = { preamble: [], sections: {}, headings: {}, extras: [], sidecar };
  const buckets = {};
  let current = null;

  text.split(/\r?\n/).forEach((line) => {
    const m = HEADING_RE.exec(line.trim());
    if (m) {
      const heading = m[1].trim();
      const key = keyFor(heading);
      if (key) {
        if (!buckets[key]) { buckets[key] = []; out.headings[key] = heading; }
        current = buckets[key];
      } else {
        const extra = { heading, lines: [] };
        out.extras.push(extra);
        current = extra.lines;
      }
      return;
    }
    if (current) current.push(line);
    else out.preamble.push(line);
  });

  Object.keys(buckets).forEach((k) => { out.sections[k] = buckets[k].join("\n").trim(); });
  out.extras = out.extras.map((x) => ({ heading: x.heading, text: x.lines.join("\n").trim() }));
  out.preamble = out.preamble.join("\n").trim();
  return out;
}

// Edited values -> SOAP text in the recorder's format
export function assembleSoap(parsed, values, extras, { keepSidecar }) {
  const parts = [];
  if (parsed.preamble) parts.push(parsed.preamble);

  SAVE_ORDER.forEach((key) => {
    const v = String(values[key] || "").trim();
    if (!v) return;
    const heading = parsed.headings[key] || SECTIONS.find((s) => s.key === key).heading;
    parts.push(`!!${heading}:\n${v}`);
  });

  (extras || []).forEach((x) => {
    const v = String(x.text || "").trim();
    if (v) parts.push(`!!${x.heading}:\n${v}`);
  });

  let out = parts.join("\n\n");
  if (keepSidecar && parsed.sidecar) out += "\n\n" + parsed.sidecar;
  return out.trim();
}

// The stored transcript is HTML (speaker blocks). Rebuild it SAFELY as plain text with labels.
export function transcriptHtml(raw, escapeHtml) {
  const str = String(raw || "").trim();
  if (!str) return `<p class="sp-empty">No transcript saved for this record.</p>`;
  if (!/<\w/.test(str)) return `<p class="sp-line">${escapeHtml(str).replace(/\n/g, "<br>")}</p>`;

  // DOMParser builds an inert document: nothing in it runs
  const doc = new DOMParser().parseFromString(`<div id="root">${str}</div>`, "text/html");
  const blocks = [...doc.getElementById("root").children].filter((el) => el.tagName === "DIV");
  if (!blocks.length) return `<p class="sp-line">${escapeHtml(doc.body.textContent.trim())}</p>`;

  return blocks.map((div) => {
    const b = div.querySelector("b");
    if (!b) return `<p class="sp-sep">${escapeHtml(div.textContent.trim())}</p>`;
    const label = b.textContent.replace(/:\s*$/, "").trim();
    const span = div.querySelector("span");
    const text = (span ? span.textContent : div.textContent.replace(b.textContent, "")).trim();
    const who = /^patient$/i.test(label) ? "patient" : "staff";
    return `<p class="sp-line ${who}"><b>${escapeHtml(label)}</b>${escapeHtml(text)}</p>`;
  }).join("");
}

// Hides lines that are ONLY a placeholder ("Nil", "Not discussed", "N/A"…).
// Real answers such as "Smoking: None" are kept.
const PLACEHOLDER_RE = /^(?:nil|none|n\/?a|nkda|nkfa|unknown|not (?:discussed|mentioned|stated|applicable|recorded|provided|specified)|no (?:known )?(?:drug )?(?:allergies|medications?|(?:medical )?conditions?)(?: reported| known)?|nothing (?:to report|recorded|discussed|noted))\.?$/i;

export function cleanPlaceholders(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => {
      const t = line.replace(/^\s*[-•*]\s*/, "").trim();
      return !t || !PLACEHOLDER_RE.test(t);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}