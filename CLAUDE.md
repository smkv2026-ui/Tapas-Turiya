# CLAUDE.md

Tapas Turiya is a no-build PWA (plain ES modules) derived from the Sādhanā
tracker. Firebase Auth + Firestore provide sync via a shared "workspace".

```
index.html            Markup: auth/profile screens, app shell, tab containers
css/styles.css        All styling (new-tab styles are at the bottom)
js/app.js             Core tracker: profiles, japa, practice, reading, learning,
                      routine scheduler, calendar, gurus, reminders, admin,
                      export/import, tab switching
js/journal.js         Simple journal + voice notes (MediaRecorder)
js/chalisa.js         Hanuman Chalisa player; audio blobs in IndexedDB
js/kumbhak.js         1:4:2:2 breathing timer, synthesised temple bell
js/nishkaam.js        Nishkaam Karma log (done / planned)
js/ui.js              toast + small formatters
js/auth-ui.js, cloud-store.js, firebase-*.js   Auth + Firestore layer
service-worker.js     Network-first app-shell cache (bump CACHE_VERSION on release)
```

## Data (per profile, `sadhana-data-<profileId>` kv key)

- `journal[date].entries[]` — `{id, ts, text, audio:{dur,mime}|null}`; audio in kv `journal-audio-<id>`
- `nishkaam[]` — `{id, text, note, date, status:'done'|'planned', createdAt, doneAt}`
- `kumbhak[]` — `{id, date, ts, unit, rounds, seconds}`; `kumbhakUnit` remembers the last unit

New tab modules are initialised in `app.js` with a small context object
(`getData`, `save`, `uid`, …). Always read data via `ctx.getData()` — `data` is
reassigned when switching profiles. Modules expose a reset (`stopJournalRecording`,
`stopChalisa`, `resetKumbhak`) called on switch-user / sign-out.

Kumbhak timing is derived from wall-clock time (`Date.now() - t0`), and bells are
scheduled ahead on the Web Audio clock, so throttled timers don't drift the bells.
