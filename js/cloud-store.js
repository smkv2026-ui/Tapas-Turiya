// Cloud persistence layer, backed by Firestore.
//
// The original app used a `window.storage.get/set(key, shared)` key-value
// API (provided by the environment it was first built in). That API never
// existed outside that environment, so nothing actually persisted once the
// app ran on its own. This module implements the same shape — get/set by
// string key — on top of Firestore, scoped to a "workspace" (a shared
// space every signed-in family member can join with an invite code), so
// every device signed into that workspace reads and writes the same data.
import {
  doc,
  getDoc,
  getDocs,
  collection,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { db } from "./firebase-init.js";

let workspaceId = null;

export function setActiveWorkspace(id) {
  workspaceId = id;
}

export function getActiveWorkspace() {
  return workspaceId;
}

function requireWorkspace() {
  if (!workspaceId) throw new Error("No active workspace — sign in first.");
  return workspaceId;
}

function kvDoc(key) {
  return doc(db, "workspaces", requireWorkspace(), "kv", key);
}

// Matches the shape of the original window.storage.get(key, shared): a
// promise resolving to { value } (a JSON string) or a falsy value.
export async function cloudGet(key) {
  const snap = await getDoc(kvDoc(key));
  if (!snap.exists()) return null;
  return { value: snap.data().value };
}

export async function cloudSet(key, value) {
  await setDoc(kvDoc(key), { value, updatedAt: serverTimestamp() });
}

// Live-updates a key's value across every device in the workspace. Calls
// back with the raw stored string (or null) whenever it changes, including
// once immediately with the current value.
export function subscribeKey(key, onChange) {
  return onSnapshot(kvDoc(key), snap => {
    onChange(snap.exists() ? snap.data().value : null);
  }, err => console.error("subscribeKey failed for " + key, err));
}

// --- Global (cross-workspace) kv — data meant to be shared across every
// account/household, not scoped to the caller's workspace. Currently used
// for the Guru's Teachings library so a quote added by anyone shows up for
// every signed-in account, new or existing. ---
function globalDoc(key) {
  return doc(db, "globalKv", key);
}

export async function globalGet(key) {
  const snap = await getDoc(globalDoc(key));
  if (!snap.exists()) return null;
  return { value: snap.data().value };
}

export async function globalSet(key, value) {
  await setDoc(globalDoc(key), { value, updatedAt: serverTimestamp() });
}

export function subscribeGlobalKey(key, onChange) {
  return onSnapshot(globalDoc(key), snap => {
    onChange(snap.exists() ? snap.data().value : null);
  }, err => console.error("subscribeGlobalKey failed for " + key, err));
}

// --- Admin: read-only access across every account and workspace, backing
// the in-app Admin view. See firestore.rules for why this is allowed for
// any signed-in caller (a UI-only password gate, not a Firestore-enforced
// one) and CLAUDE.md "Admin module" for the full rationale. ---
export async function adminListAllUsers() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

export async function adminGetWorkspaceKv(workspaceCode, key) {
  const snap = await getDoc(doc(db, "workspaces", workspaceCode, "kv", key));
  if (!snap.exists()) return null;
  return { value: snap.data().value };
}

export async function cloudDelete(key) {
  await deleteDoc(kvDoc(key));
}

// --- Journey Logs: read-only access to another workspace's kv doc (a
// Journey Circle collaborator in a different household). firestore.rules
// already allows any signed-in user to read any workspace's kv (see the
// Admin trade-off), while writes stay limited to your own workspace — so a
// collaborator can see, but never modify, someone else's journey log. ---
export async function getWorkspaceKv(workspaceCode, key) {
  const snap = await getDoc(doc(db, "workspaces", workspaceCode, "kv", key));
  if (!snap.exists()) return null;
  return { value: snap.data().value };
}

export function subscribeWorkspaceKey(workspaceCode, key, onChange) {
  return onSnapshot(doc(db, "workspaces", workspaceCode, "kv", key), snap => {
    onChange(snap.exists() ? snap.data().value : null);
  }, err => console.error("subscribeWorkspaceKey failed for " + workspaceCode + "/" + key, err));
}

// A Journey Circle's membership list lives in globalKv (readable/writable by
// any signed-in account, so members from different households can join the
// same circle) as a real Firestore array rather than a JSON string, so
// concurrent joins merge via arrayUnion instead of overwriting each other.
// It only ever holds {ws, pid, name} tuples — never journey content.
function circleDoc(code) {
  return doc(db, "globalKv", "journey-circle-" + code);
}

export async function journeyCircleExists(code) {
  const snap = await getDoc(circleDoc(code));
  return snap.exists();
}

export async function journeyCircleCreate(member) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const ref = circleDoc(code);
    const existing = await getDoc(ref);
    if (existing.exists()) continue;
    await setDoc(ref, { kind: "journey-circle", members: [member], createdAt: serverTimestamp() });
    return code;
  }
  throw new Error("Could not allocate a circle code, please try again.");
}

export async function journeyCircleJoin(code, member) {
  const ref = circleDoc(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("That circle code doesn't match any Journey Circle.");
  await updateDoc(ref, { members: arrayUnion(member) });
}

export async function journeyCircleRemove(code, memberObjects) {
  if (!memberObjects.length) return;
  await updateDoc(circleDoc(code), { members: arrayRemove(...memberObjects) });
}

export function subscribeJourneyCircle(code, onChange) {
  return onSnapshot(circleDoc(code), snap => {
    onChange(snap.exists() ? (snap.data().members || []) : null);
  }, err => console.error("subscribeJourneyCircle failed for " + code, err));
}

function randomCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Looks up which workspace this signed-in user already belongs to, if any.
export async function findUserWorkspace(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (snap.exists() && snap.data().workspaceId) return snap.data().workspaceId;
  return null;
}

// Creates a brand-new shared workspace and attaches this user to it as its
// first member. Retries on the rare event a random code collides.
export async function createWorkspace(uid, email) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const wsRef = doc(db, "workspaces", code);
    const existing = await getDoc(wsRef);
    if (existing.exists()) continue;
    await setDoc(wsRef, { members: [uid], createdAt: serverTimestamp(), createdBy: uid });
    await setDoc(doc(db, "users", uid), { email, workspaceId: code, updatedAt: serverTimestamp() });
    return code;
  }
  throw new Error("Could not allocate a shared-space code, please try again.");
}

// Joins an existing workspace by its invite code.
export async function joinWorkspace(uid, email, code) {
  const normalized = code.trim().toUpperCase();
  const wsRef = doc(db, "workspaces", normalized);
  const snap = await getDoc(wsRef);
  if (!snap.exists()) throw new Error("That invite code doesn't match any shared space.");
  await updateDoc(wsRef, { members: arrayUnion(uid) });
  await setDoc(doc(db, "users", uid), { email, workspaceId: normalized, updatedAt: serverTimestamp() });
  return normalized;
}
