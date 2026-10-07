// App-shell service worker. Firestore's own persistent local cache (see
// js/firebase-init.js) handles offline data; this worker only makes the
// static shell (markup, styles, script, icons) work offline, and — since
// this app ships new features frequently — always prefers a fresh network
// copy over the cached one when online (see the fetch handler below), only
// falling back to cache when there's no network at all.
const CACHE_VERSION = 'tapas-turiya-v7';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/firebase-init.js',
  './js/firebase-config.js',
  './js/auth-ui.js',
  './js/cloud-store.js',
  './js/ui.js',
  './js/journal.js',
  './js/dhyana.js',
  './js/chalisa.js',
  './js/kumbhak.js',
  './js/nishkaam.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
  './icons/logo.svg',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Audio seeking uses Range requests (206 responses can't be cached) — let the network handle them.
  if (req.headers.has('range')) return;

  const url = new URL(req.url);
  // Only manage same-origin app-shell requests; let Firebase/Firestore and
  // font requests go straight to the network (and their own caching).
  if (url.origin !== self.location.origin) return;

  // Network-first: always try to fetch the latest deployed version first,
  // so a change that's live on the server shows up on the very next load
  // (not "one reload behind," which is what a cache-first strategy gives
  // you — that's exactly the bug this replaced: after a deploy, returning
  // visitors kept seeing the previous version until a second reload).
  // Only fall back to the cached copy when there's genuinely no network.
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
  );
});

// Reminder notifications (see js/app.js "Reminders") are shown via
// registration.showNotification(); this focuses an existing app window (or
// opens one) when the user taps the notification.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
