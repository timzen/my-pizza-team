// Minimal service worker for PWA installability
// Caches the app shell for offline support

const CACHE_NAME = 'ppt-v1';
const SHELL_ASSETS = [
  '/',
  '/board',
  '/assistant',
  '/memory',
  '/css/theme.css',
  '/css/nav.css',
  '/js/shared.js',
  '/js/nav.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first strategy for API calls
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }
  // Cache-first for shell assets, network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
