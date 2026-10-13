// Recording rules: set by Admins in System configuration, read by Apps Script when notes are written.
import { db, auth } from "./firebase-config.js";
import {
  doc, collection, getDoc, getDocs, query, orderBy, limit, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const RULES_REF = () => doc(db, "recording_config", "rules");
const MAX_RULES = 100;

export const RULE_TYPES = [
  ["words", "When it hears…", "Exact words or phrases. Checked word for word, so it's predictable."],
  ["topic", "When the conversation is about…", "Gemini judges the meaning, so it catches things said in different ways."],
  ["instruction", "Note-writing instructions", "Added to the instructions Gemini follows when it writes the notes."],
  ["spelling", "Words and spellings", "Fixes names and products that are often misheard."],
];
export const typeName = (t) => (RULE_TYPES.find(([k]) => k === t) || [null, "Rule"])[1];

// Note sections, matching Soap.gs (formatSoapFromJSON). "plan" was the old name for Assessment & Plan.
export const NOTE_SECTIONS = [
  ["", "Wherever it fits"], ["subjective", "Clinical notes"], ["objective", "Objective"],
  ["assessment", "Assessment & Plan"], ["treatment_plan", "Treatment plan"], ["social", "Social history"],
];
// Where "Add a line to the notes" can write (the treatment plan is built from structured data)
export const NOTE_TARGETS = NOTE_SECTIONS.filter(([k]) => k !== "treatment_plan");
export const ACTION_TYPES = [
  ["flag", "Highlight it at the top of the notes"],
  ["reminder", "Create a reminder"],
  ["note", "Add a line to the notes"],
];
export const TOKENS_HELP = "You can use {Patient name}, {Words heard} and {What was said}.";

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const sectionKey = (v) => (v === "plan" ? "assessment" : NOTE_SECTIONS.some(([k]) => k === v) ? v : "");
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);

export function newRuleId() {
  const r = window.crypto && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return "r_" + r.slice(0, 10);
}

function cleanAction(a) {
  if (!a || !ACTION_TYPES.some(([k]) => k === a.type)) return null;
  const out = { type: a.type, text: clip(a.text, 300) };
  if (a.type === "reminder") {
    out.assign = ["clinician", "anyone", "staff"].includes(a.assign) ? a.assign : "clinician";
    out.staffId = out.assign === "staff" ? clip(a.staffId, 80) : "";
    out.staffName = out.assign === "staff" ? clip(a.staffName, 120) : "";
    const d = parseInt(a.dueDays, 10);
    out.dueDays = Number.isFinite(d) ? Math.max(0, Math.min(365, d)) : 0;
  }
  if (a.type === "note") { const s = sectionKey(a.section); out.section = s === "treatment_plan" ? "assessment" : s; }
  return out;
}

// The exact shape that's saved (and read by Apps Script). Only known keys, never undefined.
export function cleanRule(r = {}) {
  const type = RULE_TYPES.some(([k]) => k === r.type) ? r.type : "words";
  const out = {
    id: /^r_[A-Za-z0-9]{4,20}$/.test(r.id || "") ? r.id : newRuleId(),
    type,
    name: clip(r.name, 100) || typeName(type),
    enabled: r.enabled !== false,
  };
  if (type === "words") {
    out.words = [...new Set((Array.isArray(r.words) ? r.words : []).map((w) => clip(w, 80)).filter(Boolean))].slice(0, 50);
  }
  if (type === "topic") out.topic = clip(r.topic, 600);
  if (type === "instruction") { out.section = sectionKey(r.section); out.instruction = clip(r.instruction, 1000); }
  if (type === "spelling") {
    out.pairs = (Array.isArray(r.pairs) ? r.pairs : [])
      .map((p) => ({ heard: clip(p && p.heard, 80), correct: clip(p && p.correct, 80) }))
      .filter((p) => p.heard && p.correct).slice(0, 100);
  }
  if (type === "words" || type === "topic") {
    const seen = new Set();
    out.actions = (Array.isArray(r.actions) ? r.actions : []).map(cleanAction)
      .filter((a) => a && !seen.has(a.type) && seen.add(a.type)).slice(0, 3);
  }
  return out;
}

// What stops a rule being saved ("" if nothing)
export function ruleProblem(r) {
  if (r.type === "words" && !r.words.length) return "Add at least one word or phrase.";
  if (r.type === "topic" && r.topic.length < 10) return "Describe what the conversation needs to be about.";
  if (r.type === "instruction" && !r.instruction) return "Write the instruction.";
  if (r.type === "spelling" && !r.pairs.length) return "Add at least one line, as heard = correct.";
  if (r.type === "words" || r.type === "topic") {
    if (!r.actions.length) return "Choose at least one thing for the rule to do.";
    const rem = r.actions.find((a) => a.type === "reminder");
    if (rem && !rem.text) return "Write what the reminder should say.";
    if (rem && rem.assign === "staff" && !rem.staffId) return "Choose who gets the reminder.";
    const note = r.actions.find((a) => a.type === "note");
    if (note && !note.text) return "Write the line to add to the notes.";
  }
  return "";
}

export async function getRules() {
  const snap = await getDoc(RULES_REF());
  const d = snap.exists() ? snap.data() : {};
  return {
    rules: Array.isArray(d.rules) ? d.rules.map(cleanRule) : [],
    version: Number(d.version || 0),
    updatedAt: toDate(d.updatedAt),
    updatedBy: d.updatedBy || "",
  };
}

// change(currentRules) -> newRules. Runs on the latest saved rules, so two Admins never overwrite each other.
// Every save keeps a copy in history/{version}.
export async function saveRules(change, staff, note = "") {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const by = clip((staff && staff.name) || "", 120);
  return runTransaction(db, async (tx) => {
    const ref = RULES_REF();
    const snap = await tx.get(ref);
    const cur = snap.exists() ? snap.data() : null;
    const before = cur && Array.isArray(cur.rules) ? cur.rules.map(cleanRule) : [];
    const rules = change(before).map(cleanRule).slice(0, MAX_RULES);
    const version = Number((cur && cur.version) || 0) + 1;
    tx.set(doc(db, "recording_config", "rules", "history", String(version)), {
      version, rules, note: clip(note, 200), by, byUid: uid, at: serverTimestamp(),
    });
    tx.set(ref, {
      rules, version, updatedAt: serverTimestamp(), updatedBy: by, updatedByUid: uid,
      createdAt: (cur && cur.createdAt) || serverTimestamp(),
    });
    return { rules, version };
  });
}

export async function listRuleHistory() {
  const snap = await getDocs(query(collection(db, "recording_config", "rules", "history"), orderBy("version", "desc"), limit(25)));
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      version: Number(x.version || 0), rules: Array.isArray(x.rules) ? x.rules.map(cleanRule) : [],
      note: x.note || "", by: x.by || "", at: toDate(x.at),
    };
  });
}

/* ---------- Matching (the same logic goes into Apps Script in Part 2) ---------- */

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole words or phrases, any capitals, any spacing between words
const phraseRe = (p, flags) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])(${escRe(p).replace(/\s+/g, "\\s+")})(?=$|[^\\p{L}\\p{N}])`, flags + "u");

export function wordsHeard(rule, text) {
  return (rule.words || []).filter((w) => phraseRe(w, "i").test(String(text || "")));
}

export function applySpellings(rules, text) {
  let out = String(text || "");
  let fixes = 0;
  rules.filter((r) => r.enabled && r.type === "spelling").forEach((r) => r.pairs.forEach((p) => {
    out = out.replace(phraseRe(p.heard, "gi"), (m, pre) => { fixes++; return pre + p.correct; });
  }));
  return { text: out, fixes };
}

export function fillTokens(s, vals) {
  return String(s || "").replace(/\{\s*([a-z ]+?)\s*\}/gi, (m, k) => {
    const key = k.toLowerCase().replace(/\s+/g, " ");
    return key in vals ? vals[key] : m;
  });
}

/* ---------- The Recorder's built-in spellings (Soap.gs applyTranscriptCorrections_) ---------- */
// Importing them makes them editable here. While this rule exists, Apps Script stops using the built-in list.
export const BUILTIN_ID = "r_builtin";
const BUILTIN_PAIRS = [
  ["add on firm and contour", "Add-on Firm & Contour Treatment"], ["add-on firm and contour", "Add-on Firm & Contour Treatment"],
  ["add on firm and fresh", "Add-on Firm & Fresh Treatment"], ["add-on firm and fresh", "Add-on Firm & Fresh Treatment"],
  ["add on firm and hydrate", "Add-on Firm & Hydrate Treatment"], ["add-on firm and hydrate", "Add-on Firm & Hydrate Treatment"],
  ["fomenclanto", "Firm & Contour"], ["femm and contour", "Firm & Contour"],
  ["firm and contour", "Firm & Contour Treatment"], ["firm and fresh", "Firm & Fresh Treatment"],
  ["firm and hydrate", "Firm & Hydrate Treatment"],
  ["middle line", "marionette line"], ["middle lines", "marionette lines"],
  ["exilis", "eSkin Tight"], ["e skin tightening", "eSkin Tight"], ["e-skin tightening", "eSkin Tight"],
  ["eskin tightening", "eSkin Tight"], ["e skin tight", "eSkin Tight"], ["e-skin tight", "eSkin Tight"],
  ["hydro repair", "HydraRepair"], ["clear complexion light laser", "Clear complexion Lite Laser"],
  ["botox", "Wrinkle Relaxer"], ["masseter muscle hypertrophy", "Wrinkle Relaxer for Jaw Muscle"],
  ["high intensity ultrasound", "Skin Lifting"], ["high-intensity ultrasound", "Skin Lifting"], ["hifu", "Skin Lifting"],
  ["stimulating peel and led", "Stimulating Peel + LED"],
];
export function builtinRule() {
  return cleanRule({
    id: BUILTIN_ID, type: "spelling", name: "Built-in spellings (from the Recorder)", enabled: true,
    pairs: BUILTIN_PAIRS.map(([heard, correct]) => ({ heard, correct })),
  });
}