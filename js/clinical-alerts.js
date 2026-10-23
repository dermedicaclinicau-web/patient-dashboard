// Allergies, medical conditions and medications for the banner at the top of a form.
// Worked out exactly like Clinical history on the patient page: the team's Current list when there is one,
// otherwise the latest consultation. Newer consultation items not yet on the list are flagged.
import { fetchClinicalProfile } from "./clinical-profile.js";
import { fetchTranscriptRecords, extractAny, toBullets } from "./transcripts.js";
import { SECTIONS, NONE_RE, normItem } from "./clinical-history-view.js";
import { escapeHtml } from "./utils.js";

const KEYS = ["allergies", "conditions", "meds"];
const LABEL = { allergies: "Allergies", conditions: "Medical conditions", meds: "Medications" };
const clean = (t) => String(t || "").replace(/^\s*[-•*]\s*/, "").replace(/[.;,\s]+$/, "").trim();
const fmtDate = (d) => (d && !isNaN(d) ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");

// { allergies, conditions, meds: { items, nil, source, date, by, pending }, partial }
export async function loadClinicalAlerts(patient) {
  const [profile, records] = await Promise.all([
    fetchClinicalProfile(patient).catch((err) => { console.warn("Clinical profile not loaded:", err); return null; }),
    fetchTranscriptRecords(patient).catch((err) => { console.warn("Consultations not loaded:", err); return null; }),
  ]);
  if (profile === null && records === null) throw new Error("Clinical history couldn't be loaded.");

  const out = { partial: profile === null || records === null };
  KEYS.forEach((key) => {
    const s = SECTIONS[key];
    // Consultations that mention this section, newest first (the same order as the patient page)
    const list = (records || [])
      .map((r) => ({ r, text: extractAny(r.soap, s.aliases) }))
      .filter((x) => x.text);
    const sec = profile && profile[key] && Array.isArray(profile[key].items) ? profile[key] : null;

    let texts = [], source = "none", date = null, by = "";
    if (sec) {
      texts = sec.items.map((it) => it.text);
      source = "list";
      date = sec.updatedAt ? new Date(sec.updatedAt) : null;
      by = sec.updatedBy || "";
    } else if (list.length) {
      texts = toBullets(list[0].text);
      source = "consult";
      date = list[0].r.date || null;
      by = list[0].r.staff || "";
    }
    const cleaned = texts.map(clean).filter(Boolean);
    const items = cleaned.filter((t) => !NONE_RE.test(t));
    const nil = !items.length && cleaned.some((t) => NONE_RE.test(t));

    // Newer consultations mention something that isn't on the Current list yet
    const pending = [];
    if (sec) {
      const since = Number(sec.syncedThrough || 0);
      const have = new Set(sec.items.map((it) => normItem(it.text)));
      const dismissed = new Set((sec.dismissed || []).map(normItem));
      const seen = new Set();
      list.forEach(({ r, text }) => {
        const t = r.date ? r.date.getTime() : 0;
        if (!t || t <= since) return;
        toBullets(text).forEach((b) => {
          const k = normItem(b);
          if (!k || NONE_RE.test(b) || have.has(k) || dismissed.has(k) || seen.has(k)) return;
          seen.add(k);
          pending.push(clean(b));
        });
      });
    }
    out[key] = { items, nil, source, date, by, pending };
  });
  return out;
}

function sourceText(x) {
  if (x.source === "list") return `Current list${x.date ? `, updated ${fmtDate(x.date)}` : ""}${x.by ? ` by ${x.by}` : ""}`;
  if (x.source === "consult") return `From the consultation${x.date ? ` on ${fmtDate(x.date)}` : ""}${x.by ? ` · ${x.by}` : ""}`;
  return "";
}

// a: from loadClinicalAlerts, or null while loading
export function clinicalBannerHtml(a, { error = false } = {}) {
  if (error) {
    return `<section class="ca-banner is-unknown" role="region" aria-label="Allergies and medical history">
      <p class="ca-foot"><strong>Allergies and medical history couldn't be loaded.</strong>
        Check the patient's page, and ask the patient before treating.</p></section>`;
  }
  if (!a) return '<section class="ca-banner is-loading">Checking allergies and medical history…</section>';

  const al = a.allergies;
  const tone = al.items.length || al.pending.length ? "is-alert" : al.nil ? "is-clear" : "is-unknown";
  const row = (key) => {
    const x = a[key];
    const none = key === "allergies"
      ? (x.nil ? "No known allergies" : "None recorded. Ask the patient before treating.")
      : (x.nil ? "None" : "Nothing recorded");
    const val = x.items.length
      ? (key === "allergies"
        ? `<span class="ca-chips">${x.items.map((t) => `<span class="ca-chip">${escapeHtml(t)}</span>`).join("")}</span>`
        : `<span>${x.items.map(escapeHtml).join(" · ")}</span>`)
      : `<span class="ca-none">${escapeHtml(none)}</span>`;
    const src = sourceText(x);
    return `<div class="ca-row is-${key}"><span class="ca-label">${LABEL[key]}</span><div class="ca-val">${val}${
      x.pending.length ? `<small class="ca-pending">A newer consultation also mentions: ${escapeHtml(x.pending.join(", "))}
        (not on the list yet)</small>` : ""}${
      src ? `<small class="ca-src">${escapeHtml(src)}</small>` : ""}</div></div>`;
  };
  return `<section class="ca-banner ${tone}" role="region" aria-label="Allergies and medical history">
    ${KEYS.map(row).join("")}
    ${a.partial ? `<p class="ca-foot">Part of the history couldn't be loaded. Check the patient's page.</p>` : ""}
  </section>`;
}

// The red chip in the form's top bar ("" when there are no allergies)
export function allergyChipText(a) {
  const list = a ? [...a.allergies.items, ...a.allergies.pending] : [];
  return list.length ? `⚠ Allergies: ${list.join(", ")}` : "";
}