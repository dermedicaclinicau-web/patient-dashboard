// What the logged-in staff member can see and do (from their login token, kept up to date with the server).
import { auth } from "./firebase-config.js";
import { signInWithCustomToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { callApi } from "./appointments.js";

export const PERM_KEYS = [
  "menu.patients", "menu.calendar", "menu.forms", "menu.tasks",
  "patients.edit", "patients.merge", "clinical.view", "billing.view",
  "consult.record", "consult.delete", "send.patients", "tasks.run",
  "tasks.build", "forms.build", "ssp.create", "ssp.config",
  "menu.inventory", "inventory.request", "inventory.order", "inventory.manage",
  "inventory.kit", "inventory.jt", "inventory.count", "menu.reports",
];

let admin = false;
let role = "";
let current = new Set();

export const isAdmin = () => admin;
export const can = (p) => admin || current.has(p);

// Body classes like "no-billing-view" let the CSS hide what someone can't use
export function setPerms(staff) {
  role = String((staff && staff.role) || "");
  admin = /^admin$/i.test(role);
  current = new Set(Array.isArray(staff && staff.perms) ? staff.perms : []);
  PERM_KEYS.forEach((k) => document.body.classList.toggle(`no-${k.replace(/\./g, "-")}`, !can(k)));
}

const same = (list) => list.length === current.size && list.every((p) => current.has(p));

// Asks the server for this person's current access. If it changed, swaps in a fresh login token
// (so the Firestore rules see the change too). Returns { changed, role, perms }.
export async function refreshAccess() {
  const res = await callApi({ action: "staff", op: "me" });
  const perms = Array.isArray(res.perms) ? res.perms : [];
  const changed = String(res.role || "") !== role || !same(perms);
  if (changed && res.token) await signInWithCustomToken(auth, res.token);
  return { changed, role: res.role || "", perms };
}