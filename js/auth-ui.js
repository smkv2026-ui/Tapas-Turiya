// Drives the sign-in / create-account screen and the account panel: wires
// Firebase Auth to the shared-workspace model in cloud-store.js, and tells
// app.js when it's safe to load tracker data (via DOM CustomEvents, so this
// module and app.js don't need to import each other directly).
import { auth, googleProvider } from "./firebase-init.js";
import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  setActiveWorkspace,
  getActiveWorkspace,
  findUserWorkspace,
  createWorkspace,
  joinWorkspace
} from "./cloud-store.js";

const $ = id => document.getElementById(id);

const authScreen = $("authScreen");
const userSelectScreen = $("userSelectScreen");
const appScreen = $("appScreen");
const authError = $("authError");
const authStatus = $("authStatus");

function showError(msg) {
  authStatus.style.display = "none";
  authError.textContent = msg;
  authError.style.display = "";
}
function showStatus(msg) {
  authError.style.display = "none";
  authStatus.textContent = msg;
  authStatus.style.display = "";
}
function clearMessages() {
  authError.style.display = "none";
  authStatus.style.display = "none";
}

function friendlyAuthError(err) {
  const code = err && err.code || "";
  if (code.includes("email-already-in-use")) return "That email already has an account — try signing in instead.";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Email or password is incorrect.";
  if (code.includes("weak-password")) return "Please choose a password with at least 6 characters.";
  if (code.includes("invalid-email")) return "That doesn't look like a valid email address.";
  if (code.includes("popup-closed-by-user")) return "Google sign-in was closed before completing.";
  return err && err.message ? err.message : "Something went wrong — please try again.";
}

/* ---------- Tabs: sign in / create account ---------- */
document.querySelectorAll(".auth-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const isLogin = btn.dataset.authtab === "login";
    $("loginForm").style.display = isLogin ? "" : "none";
    $("signupForm").style.display = isLogin ? "none" : "";
    clearMessages();
  });
});

$("wsModeNew").addEventListener("change", updateJoinCodeVisibility);
$("wsModeJoin").addEventListener("change", updateJoinCodeVisibility);
function updateJoinCodeVisibility() {
  $("joinCodeInput").style.display = $("wsModeJoin").checked ? "" : "none";
}

/* ---------- Sign in ---------- */
// Admin dashboard (see "Admin module" in CLAUDE.md): there is no separate
// Admin UI — signing in with this exact email/password on the ordinary
// sign-in form opens it instead of a normal account. It's a real Firebase
// Auth account (auto-created the first time anyone signs in with it, since
// it needs no manual setup beyond Email/Password already being enabled —
// unlike an earlier version of this that used Anonymous sign-in and
// required enabling that separately). The check is entirely client-side
// (Firestore rules can't see what was typed into a page), so this is a UI
// convenience, not a real access boundary — see CLAUDE.md for the full
// trade-off before changing who can reach this.
const ADMIN_EMAIL = "admin@sadhana.local";
const ADMIN_PASSWORD = "SriGuruBabaJi";

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  clearMessages();
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  $("loginSubmit").disabled = true;
  try {
    if (email.toLowerCase() === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      try {
        await signInWithEmailAndPassword(auth, ADMIN_EMAIL, ADMIN_PASSWORD);
      } catch (err) {
        // First time this exact account is used: it doesn't exist yet in
        // this Firebase project, so create it once. From then on it's a
        // normal account and this branch won't run again.
        await createUserWithEmailAndPassword(auth, ADMIN_EMAIL, ADMIN_PASSWORD);
      }
      // onAuthStateChanged (below) recognizes this email and routes
      // straight to the Admin dashboard instead of the normal sign-in flow.
      return;
    }
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    showError(friendlyAuthError(err));
  } finally {
    $("loginSubmit").disabled = false;
  }
});

$("forgotPasswordBtn").addEventListener("click", async () => {
  clearMessages();
  const email = $("loginEmail").value.trim();
  if (!email) { showError("Enter your email above first, then tap “Forgot password?” again."); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    showStatus("Password reset email sent — check your inbox.");
  } catch (err) {
    showError(friendlyAuthError(err));
  }
});

// Set by the signup form just before creating the account, and consumed
// exactly once by the onAuthStateChanged handler below — that handler is
// the *only* place that calls attachWorkspace(), so a signup and the auth
// state change it triggers can never race each other into creating two
// separate workspaces for the same brand-new user.
let pendingJoinCode = null;

/* ---------- Create account ---------- */
$("signupForm").addEventListener("submit", async e => {
  e.preventDefault();
  clearMessages();
  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;
  const joinCode = $("joinCodeInput").value.trim();
  const wantsJoin = $("wsModeJoin").checked;
  if (wantsJoin && !joinCode) { showError("Enter the invite code you were given."); return; }
  $("signupSubmit").disabled = true;
  try {
    pendingJoinCode = wantsJoin ? joinCode : null;
    await createUserWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged (below) picks up pendingJoinCode and attaches the
    // workspace once Firebase confirms the new session.
  } catch (err) {
    pendingJoinCode = null;
    showError(friendlyAuthError(err));
  } finally {
    $("signupSubmit").disabled = false;
  }
});

/* ---------- Google sign-in ---------- */
$("googleSignInBtn").addEventListener("click", async () => {
  clearMessages();
  try {
    pendingJoinCode = null; // Google sign-in has no join-code step; new users get a fresh workspace.
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    showError(friendlyAuthError(err));
  }
});

// Ensures the given (freshly authenticated) user is attached to a
// workspace: reuses one they already belong to, joins the given invite
// code, or creates a brand-new shared space as the default.
async function attachWorkspace(user, joinCode) {
  let wsId = await findUserWorkspace(user.uid);
  if (!wsId) {
    wsId = joinCode
      ? await joinWorkspace(user.uid, user.email, joinCode)
      : await createWorkspace(user.uid, user.email);
  }
  setActiveWorkspace(wsId);
}

/* ---------- Account panel ---------- */
$("accountBtn").addEventListener("click", () => openAccountPanel());
$("backToAccountBtn").addEventListener("click", () => openAccountPanel());
$("accountCloseBtn").addEventListener("click", () => $("accountModal").classList.remove("open"));

function openAccountPanel() {
  $("accountEmail").textContent = (auth.currentUser && auth.currentUser.email) || "—";
  $("workspaceCodeText").textContent = getActiveWorkspace() || "—";
  $("switchWorkspaceNote").textContent = "Moves this account to another shared space's data.";
  $("accountModal").classList.add("open");
}

$("copyWorkspaceCodeBtn").addEventListener("click", async () => {
  const code = getActiveWorkspace();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    $("copyWorkspaceCodeBtn").textContent = "Copied!";
    setTimeout(() => { $("copyWorkspaceCodeBtn").textContent = "Copy"; }, 1500);
  } catch (e) { /* clipboard unavailable, ignore */ }
});

$("switchWorkspaceBtn").addEventListener("click", async () => {
  const code = $("switchWorkspaceInput").value.trim();
  if (!code || !auth.currentUser) return;
  $("switchWorkspaceNote").textContent = "Joining…";
  try {
    const wsId = await joinWorkspace(auth.currentUser.uid, auth.currentUser.email, code);
    setActiveWorkspace(wsId);
    $("switchWorkspaceInput").value = "";
    $("accountModal").classList.remove("open");
    document.dispatchEvent(new CustomEvent("sadhana-workspace-changed"));
  } catch (err) {
    $("switchWorkspaceNote").textContent = friendlyAuthError(err);
  }
});

$("signOutBtn").addEventListener("click", async () => {
  document.dispatchEvent(new CustomEvent("sadhana-before-signout"));
  $("accountModal").classList.remove("open");
  await signOut(auth);
});

/* ---------- Auth state machine ---------- */
onAuthStateChanged(auth, async user => {
  clearMessages();
  if (!user) {
    setActiveWorkspace(null);
    authScreen.style.display = "";
    userSelectScreen.style.display = "none";
    appScreen.style.display = "none";
    delete document.documentElement.dataset.sadhanaSession;
    document.dispatchEvent(new CustomEvent("sadhana-signed-out"));
    return;
  }
  // The Admin account (see ADMIN_EMAIL above and "Admin module" in
  // CLAUDE.md) isn't a "real" sign-in from this screen's point of view —
  // it has no profile or workspace of its own. Route it to the Admin
  // dashboard instead of the normal attach-a-workspace /
  // show-user-select-screen flow, and let app.js's Admin code manage the
  // screen from here.
  if (user.email && user.email.toLowerCase() === ADMIN_EMAIL) {
    // Recorded as well as dispatched: app.js may still be loading its own
    // (larger) module graph when a restored session resolves this fast, and
    // checks this flag on startup so it never misses the handoff.
    document.documentElement.dataset.sadhanaSession = "admin";
    document.dispatchEvent(new CustomEvent("sadhana-admin-ready"));
    return;
  }
  try {
    if (!getActiveWorkspace()) {
      const joinCode = pendingJoinCode;
      pendingJoinCode = null;
      await attachWorkspace(user, joinCode);
    }
    authScreen.style.display = "none";
    userSelectScreen.style.display = "";
    document.documentElement.dataset.sadhanaSession = "ready";
    document.dispatchEvent(new CustomEvent("sadhana-auth-ready"));
  } catch (err) {
    showError(friendlyAuthError(err));
    authScreen.style.display = "";
  }
});
