// Lists a choice field can take its options from, instead of typing them.
// Each option is { label, link }. Add new sources here.
import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { fetchStaffList } from "./task-types.js";
import { listPublishedForms } from "./form-templates.js";

export const SOURCES = {
  list: { name: "My own list" },
  treatments: { name: "Treatment information" },
  staff: { name: "Staff members" },
  printables: { name: "Printables (Form Builder)" },
};

const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || "").trim());

// TREATMENT-CONFIGURATIONS: the name is "Treatment Name"; the link is the first web address,
// preferring fields whose name mentions link, url or info
async function loadTreatments() {
  const snap = await getDocs(collection(db, "TREATMENT-CONFIGURATIONS"));
  const out = [];
  snap.forEach((d) => {
    const x = d.data() || {};
    const label = String(x["Treatment Name"] || x.name || x.Name || "").trim();
    if (!label) return;
    const entries = Object.entries(x).filter(([, v]) => typeof v === "string" && isUrl(v));
    const preferred = entries.find(([k]) => /link|url|info/i.test(k)) || entries[0];
    out.push({ label, link: preferred ? preferred[1].trim() : "" });
  });
  return out.sort((a, b) => a.label.localeCompare(b.label, "en-AU"));
}

const LOADERS = {
  treatments: loadTreatments,
  staff: async () => (await fetchStaffList()).map((s) => ({ label: s.name, link: "", id: s.id })),
  printables: async () => (await listPublishedForms())
    .filter((t) => t.category === "printable")
    .map((t) => ({ label: t.name, link: "", id: t.id })),
};

const jobs = new Map();
export function loadSource(key) {
  if (!LOADERS[key]) return Promise.resolve([]);
  if (!jobs.has(key)) {
    jobs.set(key, LOADERS[key]().catch((err) => { jobs.delete(key); throw err; }));
  }
  return jobs.get(key);
}