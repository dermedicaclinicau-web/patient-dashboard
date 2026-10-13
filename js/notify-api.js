// Notifications: email rules (Inventory → Notifications), the event outbox and the email log.
import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, query, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";

// conds: which "Only if" options apply. involved: who "the people involved" are for that event.
export const NOTIFY_EVENTS = [
  { key: "request.created", label: "A new order request is sent", involved: "The person who asked", conds: ["urgentOnly", "loc", "categories"] },
  { key: "request.updated", label: "An order request is ordered or declined", involved: "The person who asked", conds: ["statuses"] },
  { key: "stock.arrived", label: "Stock arrives (a delivery is received)", involved: "Whoever requested it", conds: ["loc", "categories"] },
  { key: "stock.low", label: "A product drops to its reorder level", conds: ["loc", "categories"], involved: "" },
  { key: "count.overdue", label: "The opening count isn't finished by its due time", conds: ["loc", "categories"], involved: "" },
  { key: "count.difference", label: "A stock count finds differences", involved: "Whoever did the count", conds: [] },
  { key: "usage.short", label: "A treatment is saved short (not enough stock)", involved: "The clinician who saved it", conds: ["categories"] },
  { key: "loan.disputed", label: "A borrow between injectors is disputed", involved: "Both injectors", conds: [] },
  { key: "investigation.opened", label: "A count doesn't match digital (a recount is needed)", conds: ["loc", "categories"], involved: "" },
  { key: "investigation.confirmed", label: "A recount confirms a difference (admin review needed)", conds: ["loc", "categories"],
    involved: "The people who counted it" },
    
];
export const DIGEST_SECTIONS = [
  ["low", "Low stock"], ["expiring", "Expiring soon"], ["requests", "Open order requests"],
  ["deliveries", "Deliveries waiting"], ["counts", "Count differences to review"],
  ["short", "Saved short to resolve"], ["loans", "Borrows to confirm or disputed"],
];
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/* ---------- Events from the portal ---------- */

// Asks Apps Script to send anything waiting now (otherwise it goes within 5 minutes)
export function pingNotify() {
  callApi({ action: "notify", op: "process" }).catch(() => {});
}

// Queues an event (never blocks or breaks the action that caused it)
export async function queueNotify(event, data) {
  try {
    await addDoc(collection(db, "notify_outbox"), {
      event, data, status: "new", createdAt: serverTimestamp(), createdByUid: auth.currentUser ? auth.currentUser.uid : "",
    });
    pingNotify();
  } catch (err) {
    console.warn("Notification not queued:", err);
  }
}

/* ---------- Rules ---------- */

export function cleanRule(r = {}) {
  const kind = r.kind === "digest" ? "digest" : "event";
  const c = r.conditions || {};
  const rc = r.recipients || {};
  const s = r.schedule || {};
  const sec = r.sections || {};
  const strs = (a, n, max) => (Array.isArray(a) ? a : []).map((x) => String(x || "").trim().slice(0, n)).filter(Boolean).slice(0, max);
  const day = parseInt(s.day, 10);
  return {
    name: String(r.name || "").trim().slice(0, 100),
    enabled: r.enabled !== false,
    kind,
    event: kind === "event" && NOTIFY_EVENTS.some((e) => e.key === r.event) ? r.event : "",
    conditions: {
      urgentOnly: c.urgentOnly === true,
      loc: ["shelf", "jt"].includes(c.loc) ? c.loc : "any",
      categories: strs(c.categories, 30, 10),
      statuses: strs(c.statuses, 20, 2).filter((x) => ["ordered", "declined"].includes(x)),
    },
    recipients: {
      involved: kind === "event" && rc.involved === true,
      staffIds: strs(rc.staffIds, 60, 50),
      roles: strs(rc.roles, 40, 20),
      emails: strs(rc.emails, 254, 10),
      skipActor: rc.skipActor !== false,
    },
    schedule: {
      freq: ["daily", "weekdays", "weekly"].includes(s.freq) ? s.freq : "weekly",
      day: day >= 0 && day <= 6 ? day : 1,
      time: /^\d{2}:\d{2}$/.test(s.time || "") ? s.time : "08:00",
    },
    sections: Object.fromEntries(DIGEST_SECTIONS.map(([k]) => [k, sec[k] === true])),
    expiringDays: Math.min(180, Math.max(7, parseInt(r.expiringDays, 10) || 60)),
    skipEmpty: r.skipEmpty !== false,
    message: String(r.message || "").trim().slice(0, 1000),
  };
}

export async function listRules() {
  const snap = await getDocs(collection(db, "notify_rules"));
  return snap.docs.map((d) => ({ id: d.id, ...cleanRule(d.data()) }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1) || a.name.localeCompare(b.name, "en-AU"));
}

export async function saveRule(id, data, staff) {
  const r = cleanRule(data);
  if (!r.name) throw new Error("Give the rule a name.");
  if (r.kind === "event" && !r.event) throw new Error("Choose when it sends.");
  if (r.kind === "digest" && !Object.values(r.sections).some(Boolean)) throw new Error("Tick at least one thing for the digest to include.");
  const bad = (data.recipients && Array.isArray(data.recipients.emails) ? data.recipients.emails : [])
    .map((e) => String(e).trim()).filter((e) => e && !EMAIL_RE.test(e));
  if (bad.length) throw new Error(`Check these email addresses: ${bad.join(", ")}`);
  const rc = r.recipients;
  if (!rc.involved && !rc.staffIds.length && !rc.roles.length && !rc.emails.length) throw new Error("Choose who it goes to.");
  const who = String((staff && staff.name) || "").slice(0, 120);
  const uid = auth.currentUser ? auth.currentUser.uid : "";
  if (id) {
    await updateDoc(doc(db, "notify_rules", id), { ...r, updatedAt: serverTimestamp(), updatedBy: who, updatedByUid: uid });
    return id;
  }
  const ref = doc(collection(db, "notify_rules"));
  await setDoc(ref, { ...r, createdAt: serverTimestamp(), createdBy: who, updatedAt: serverTimestamp(), updatedBy: who, updatedByUid: uid });
  return ref.id;
}

export function setRuleEnabled(id, enabled, staff) {
  return updateDoc(doc(db, "notify_rules", id), {
    enabled: !!enabled, updatedAt: serverTimestamp(), updatedBy: String((staff && staff.name) || "").slice(0, 120),
  });
}
export const deleteRule = (id) => deleteDoc(doc(db, "notify_rules", id));
export const testRule = (id) => callApi({ action: "notify", op: "test", ruleId: id });

export async function listNotifyLog(max = 40) {
  const snap = await getDocs(query(collection(db, "notify_log"), orderBy("at", "desc"), limit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}