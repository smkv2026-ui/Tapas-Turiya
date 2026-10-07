# Tapas Turiya — Practice Tracker

A daily sādhanā tracker packaged as an installable, responsive PWA. It keeps
everything from the original *Sādhanā* app (profiles, japa counters, timed
practice, reading, learning, Routine scheduler, Calendar, Guru's Teachings,
reminders, shared-space sign-in, export/import, Admin) and adds:

| Tab | What it does |
|---|---|
| **Journal** | A simpler journal: type an entry or tap 🎙️ to record a voice note. Entries are saved per day and searchable. The 📝 icons next to japa/practice/books/activities pre-fill a note. |
| **Hanuman Chalisa** | Comes with Krishna Das's Hanuman Chalisa built in; add your own audio files too. Plays on repeat (repeat one / repeat all / off) with a 0.5×–2× speed control (pitch preserved), seek, next/prev and lock-screen controls. |
| **Kumbhak Pranayama** | Choose the length of "1" (e.g. 5 s) and breathe 1 : 4 : 2 : 2 (5 · 20 · 10 · 10 s). A temple bell marks each phase change; press **Done** to see how many rounds you completed. Sessions are logged. |
| **Nishkaam Karma** | Record selfless acts you have done, or plan to do; tick planned ones off when done. |

Removed compared with the original: Chakra Dharana, Kriya Practice, Journey Logs.

No build step — plain HTML/CSS/JS ES modules, backed by Firebase Auth +
Firestore for sync.

## Setup

1. **Firebase.** `js/firebase-config.js` currently holds the config copied
   from the original app. Replace it with your own Firebase web-app config
   (Firebase console → Project settings → Your apps) if you want Tapas Turiya
   to have its own accounts and data instead of sharing the original's.
2. Enable **Email/Password** and **Google** sign-in (Build ▸ Authentication).
3. Create a Firestore database and deploy the rules:
   `firebase deploy --only firestore:rules`.
4. Serve it: `python3 -m http.server 8080` and open http://localhost:8080 —
   or deploy to GitHub Pages (workflow included, runs on pushes to `main`) or
   Firebase Hosting.

## Notes

- **Voice notes** are stored in Firestore (one document each, ~4 minute cap
  because of the 1 MiB document limit).
- **Hanuman Chalisa audio** is stored in the browser's IndexedDB on the device
  where you add it (files are too large for Firestore), so add them on each
  device you use.
- **Bell sound** is synthesised with the Web Audio API — no audio files. Keep
  the screen on during a session (the app requests a wake lock where supported).
- **Admin** works as in the original (sign in with the admin credential —
  see the original project's README). Anyone who knows that credential can
  read all accounts' data; change it in `js/auth-ui.js` before real use.

See `CLAUDE.md` for a file-by-file architecture overview.
