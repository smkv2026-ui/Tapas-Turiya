// Initializes the Firebase app, Auth and Firestore (with offline persistence)
// and exposes them for the rest of the app. Every other module that needs
// Firebase imports from here rather than re-initializing.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(e => console.error("auth persistence failed", e));

export const googleProvider = new GoogleAuthProvider();

// Offline-first Firestore cache so the app keeps working (reads from the
// last-synced snapshot) while a device is offline, then syncs writes once
// connectivity returns.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
