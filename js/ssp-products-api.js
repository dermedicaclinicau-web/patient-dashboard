// Skin Script Protocol: the product catalogue (Firestore ssp_products, mirrored to the product_info sheet).
import { db, auth } from "./firebase-config.js";
import { collection, getDocs, doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { callApi } from "./appointments.js";

export const SSP_STEPS = [
  { key: "A", label: "Step A", sub: "Preparing your skin", tone: "#ede9fe", ink: "#6d28d9" },
  { key: "BOOST", label: "Boost", sub: "", tone: "#dcfce7", ink: "#047857" },
  { key: "B", label: "Step B", sub: "Prevent & Correct", tone: "#ffedd5", ink: "#c2410c" },
  { key: "C", label: "Step C", sub: "Hydrating", tone: "#dbeafe", ink: "#1d4ed8" },
  { key: "D", label: "Step D", sub: "Eye care", tone: "#fce7f3", ink: "#be185d" },
  { key: "E", label: "Step E", sub: "Sunscreen", tone: "#fef3c7", ink: "#b45309" },
  { key: "F", label: "Step F", sub: "Prescriptions & Other Products", tone: "#f1f5f9", ink: "#475569" },
];
const KEYS = SSP_STEPS.map((s) => s.key);
const COL = "ssp_products";
const FRESH_MS = 2 * 60 * 1000;
let cache = null;

const clip = (v, n) => String(v ?? "").slice(0, n);

function toProduct(d) {
  const x = d.data() || {};
  return {
    id: d.id,
    name: String(x.name || "").trim(),
    steps: (Array.isArray(x.steps) ? x.steps : []).filter((k) => KEYS.includes(k)),
    defaultInstruction: String(x.defaultInstruction || ""),
    maintenanceInstruction: String(x.maintenanceInstruction || ""),
    size: String(x.size || ""),
    price: String(x.price ?? ""),
    details: String(x.details || ""),
    shopLink: String(x.shopLink || ""),
    published: x.published !== false,
    sheetRow: Number(x.sheetRow || 0),
    updatedAt: String(x.updatedAt || ""),
    updatedBy: String(x.updatedBy || ""),
  };
}

// all: include unpublished products (Products Config); otherwise only published (the builder)
export async function listSspProducts({ force = false, all = false } = {}) {
  if (force || !cache || Date.now() - cache.at > FRESH_MS) {
    const snap = await getDocs(collection(db, COL));
    cache = {
      at: Date.now(),
      list: snap.docs.map(toProduct).filter((p) => p.name)
        .sort((a, b) => a.name.localeCompare(b.name, "en-AU", { numeric: true }) || a.size.localeCompare(b.size, "en-AU", { numeric: true })),
    };
  }
  return all ? cache.list : cache.list.filter((p) => p.published);
}

export function cleanProduct(p) {
  return {
    name: clip(p.name, 150).replace(/\s+/g, " ").trim(),
    steps: KEYS.filter((k) => (p.steps || []).includes(k)),
    defaultInstruction: clip(p.defaultInstruction, 3000).trim(),
    maintenanceInstruction: clip(p.maintenanceInstruction, 3000).trim(),
    size: clip(p.size, 60).trim(),
    price: clip(p.price, 30).trim(),
    details: clip(p.details, 3000).trim(),
    shopLink: clip(p.shopLink, 500).trim(),
    published: p.published !== false,
  };
}

// Saves to Firestore, then keeps the product_info sheet in step (in the background)
export async function saveSspProduct(p, staff, original = null) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error("Your session has ended. Log in again.");
  const clean = cleanProduct(p);
  if (!clean.name) throw new Error("Give the product a name.");
  const now = new Date().toISOString();
  const who = (staff && staff.name) || "";
  const data = { ...clean, updatedAt: now, updatedBy: who, updatedByUid: uid };
  let id = p.id;
  if (id) {
    await updateDoc(doc(db, COL, id), data);
  } else {
    const ref = doc(collection(db, COL));
    id = ref.id;
    await setDoc(ref, { ...data, sheetRow: 0, createdAt: now, createdBy: who });
  }
  cache = null;

  callApi({
    action: "ssp", op: "productToSheet",
    product: {
      ...clean,
      sheetRow: (original && original.sheetRow) || 0,
      oldName: original ? original.name : clean.name,
      oldSize: original ? original.size : clean.size,
    },
  })
    .then((r) => {
      if (r && r.row && (!original || r.row !== original.sheetRow)) {
        updateDoc(doc(db, COL, id), { sheetRow: r.row }).catch(() => {});
      }
    })
    .catch((err) => console.warn("Saved, but the product_info sheet wasn't updated:", err));

  return id;
}

export async function importSspProducts() {
  const r = await callApi({ action: "ssp", op: "importProducts" });
  cache = null;
  return r;
}