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
  { key: "tasks", label: "Task list (one per line)" },
  { key: "taskflags", label: "Challenging or need help (from their task list)" },
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
export const newSetId = () => `set_${Math.random().toString(36).slice(2, 9)}`;
const cleanList = (a, max, len) => [...new Set((Array.isArray(a) ? a : []).map((x) => clip(x, len)).filter(Boolean))].slice(0, max);

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

// A question set: given to roles and/or particular people
export function cleanSet(x = {}) {
  return {
    id: clip(x.id, 40) || newSetId(),
    name: clip(x.name, 60),
    roles: cleanList(x.roles, 20, 40),
    staffIds: cleanList(x.staffIds, 60, 80),
    questions: (Array.isArray(x.questions) ? x.questions : []).map(cleanQuestion).filter((q) => q.label).slice(0, 30),
  };
}

export function cleanEodSettings(s = {}) {
  // A role or person belongs to one set only (the first one keeps them)
  const takenRoles = new Set();
  const takenPeople = new Set();
  const sets = (Array.isArray(s.sets) ? s.sets : []).map(cleanSet).slice(0, 12).map((x) => {
    x.roles = x.roles.filter((r) => !takenRoles.has(r.toLowerCase()) && takenRoles.add(r.toLowerCase()));
    x.staffIds = x.staffIds.filter((id) => !takenPeople.has(id) && takenPeople.add(id));
    return x;
  });
  return {
    who: "all",   // End of day is always for everyone
    kitCheck: s.kitCheck !== false,
    prompt: s.prompt !== false,
    remindBefore: [0, 5, 10, 15, 30, 45, 60].includes(Number(s.remindBefore)) ? Number(s.remindBefore) : 15,
    finishTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.finishTime || "") ? s.finishTime : "17:30",
    questions: (Array.isArray(s.questions) ? s.questions : []).map(cleanQuestion).filter((q) => q.label).slice(0, 30),
    sets,
  };
}

// Which set a person gets: one given to them by name, then their role's, otherwise none (Everyone's questions)
export function setFor(cfg, { uid = "", role = "" } = {}) {
  const sets = (cfg && cfg.sets) || [];
  const r = String(role || "").toLowerCase();
  return sets.find((x) => uid && x.staffIds.includes(uid))
    || sets.find((x) => r && x.roles.some((y) => y.toLowerCase() === r))
    || null;
}

export function questionsFor(cfg, staff) {
  const set = setFor(cfg, { uid: staff && staff.uid, role: staff && (staff.role || staff.staffRole) });
  return set ? set.questions : (cfg.questions || []);
}

export async function getEndOfDaySettings() {
  const s = await getDoc(doc(db, "app_settings", "end_of_day"));
  return cleanEodSettings(s.exists() ? s.data() : DEFAULT_EOD);
}

export async function saveEndOfDaySettings(cfg, staff) {
  const check = (list, where) => {
    let hasTasks = false;
    (Array.isArray(list) ? list : []).forEach((q, i) => {
      const c = cleanQuestion(q);
      if (!c.label) throw new Error(`${where}: question ${i + 1} needs its wording.`);
      if (c.type === "choice" && c.options.length < 2) throw new Error(`${where}: question ${i + 1} (“${c.label}”) needs at least 2 choices.`);
      if (c.type === "tasks") hasTasks = true;
      if (c.type === "taskflags" && !hasTasks) throw new Error(`${where}: “${c.label}” needs a Task list question above it.`);
    });
  };
  check(cfg && cfg.questions, "Everyone");
  ((cfg && cfg.sets) || []).forEach((x, i) => {
    const name = clip(x.name, 60);
    if (!name) throw new Error(`Question set ${i + 1} needs a name.`);
    if (!(x.roles || []).length && !(x.staffIds || []).length) throw new Error(`“${name}” isn't given to anyone yet. Tick a role or a person.`);
    check(x.questions, name);
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
  if (q.type === "tasks") return String(v).split("\n").map((s) => s.trim()).filter(Boolean).join(" · ");
  return String(v);
}