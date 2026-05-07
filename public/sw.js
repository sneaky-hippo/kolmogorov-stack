// Recipe service worker — keeps the registry available offline.
const CACHE = 'kolm-v5-2026-05-07-4';
const PRECACHE = [
  '/device',
  '/styles.css',
  '/sdk.js',
  '/v1/registry/export',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate for the registry export.
  if (url.pathname === '/v1/registry/export') {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        const fetchPromise = fetch(e.request).then((res) => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        }).catch(() => hit);
        return hit || fetchPromise;
      })
    );
    return;
  }

  // Cache-first for static assets and the device shell.
  if (PRECACHE.includes(url.pathname) || url.pathname.match(/\.(css|js|svg|png|woff2?)$/)) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) => hit || fetch(e.request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        })
      )
    );
    return;
  }
});
