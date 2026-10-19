// End of Day: the questions staff are asked (app_settings/end_of_day), managed in Task Manager → End of day.
import { db, auth } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const EOD_TYPES = [
  { key: "mood", label: "Faces (how was your day)" },
  { key: "rating", label: "Rating 1 to 5" },
  { key: "yesno", label: "Yes / No" },
  { key: "choice", label: "Pick one" },
  { key: "short", label: "Short answer" },
  { key: "long", label: "Long answer" },
  { key: "number", label: "Number" },
];
export const MOODS = [[1, "😞", "Rough"], [2, "🙁", "Not great"], [3, "😐", "Okay"], [4, "🙂", "Good"], [5, "😄", "Great"]];

export const DEFAULT_EOD = {
  who: "all",
  kitCheck: true,
  prompt: true,
  remindBefore: 15,
  finishTime: "17:30",
  questions: [
    { id: "q_mood", type: "mood", label: "How was your day?", help: "", required: true, options: [] },
    { id: "q_good", type: "long", label: "Anything good happen today?", help: "", required: false, options: [] },
    { id: "q_flag", type: "long", label: "Anything we should know about?", help: "Stock, equipment, patients, anything at all.", required: false, options: [] },
  ],
};

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
export const newQid = () => `q_${Math.random().toString(36).slice(2, 9)}`;

export function cleanQuestion(q = {}) {
  const type = EOD_TYPES.some((t) => t.key === q.type) ? q.type : "short";
  return {
    id: clip(q.id, 40) || newQid(),
    type,
    label: clip(q.label, 200),
    help: clip(q.help, 300),
    required: q.required === true,
    options: type === "choice"
      ? [...new Set((Array.isArray(q.options) ? q.options : []).map((o) => clip(o, 120)).filter(Boolean))].slice(0, 12) : [],
  };
}

export function cleanEodSettings(s = {}) {
  return {
    who: s.who === "injectors" ? "injectors" : "all",
    kitCheck: s.kitCheck !== false,
    prompt: s.prompt !== false,
    remindBefore: [0, 5, 10, 15, 30, 45, 60].includes(Number(s.remindBefore)) ? Number(s.remindBefore) : 15,
    finishTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.finishTime || "") ? s.finishTime : "17:30",
    questions: (Array.isArray(s.questions) ? s.questions : []).map(cleanQuestion).filter((q) => q.label).slice(0, 30),
  };
}

export async function getEndOfDaySettings() {
  const s = await getDoc(doc(db, "app_settings", "end_of_day"));
  return cleanEodSettings(s.exists() ? s.data() : DEFAULT_EOD);
}

export async function saveEndOfDaySettings(cfg, staff) {
  const list = Array.isArray(cfg && cfg.questions) ? cfg.questions : [];
  list.forEach((q, i) => {
    const c = cleanQuestion(q);
    if (!c.label) throw new Error(`Question ${i + 1} needs its wording.`);
    if (c.type === "choice" && c.options.length < 2) throw new Error(`Question ${i + 1} (“${c.label}”) needs at least 2 choices.`);
  });
  const clean = cleanEodSettings(cfg);
  await setDoc(doc(db, "app_settings", "end_of_day"), {
    ...clean,
    updatedAt: serverTimestamp(),
    updatedBy: String((staff && staff.name) || "").slice(0, 120),
    updatedByUid: (auth.currentUser && auth.currentUser.uid) || "",
  });
  return clean;
}

// How an answer reads in summaries and Reporting
export function answerText(q, v) {
  if (v === "" || v === null || v === undefined) return "";
  if (q.type === "mood") { const m = MOODS.find(([n]) => n === Number(v)); return m ? `${m[1]} ${m[2]}` : String(v); }
  if (q.type === "rating") return `${v} / 5`;
  return String(v);
}