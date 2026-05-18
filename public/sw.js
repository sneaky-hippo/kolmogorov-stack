// Recipe service worker · keeps the registry available offline.
const CACHE = 'kolm-v7-2026-05-18-wave386-w380d-tests-green';
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
  if (PRECACHE.includes(url.pathname) || url.pathname.match(/\.(css|js|svg|png|woff2-)$/)) {
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

// W215: WebPush handler — receive a threshold alert and surface it as a
// notification. The /v1/notifications/test route fires the same payload shape.
self.addEventListener('push', (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch (_) { payload = { title: 'kolm.ai', body: e.data ? e.data.text() : '' }; }
  const title = payload.title || 'kolm.ai capture threshold crossed';
  const body = payload.body || (payload.namespace ? (payload.namespace + ': ' + (payload.count || 0) + ' captures — distill is ready') : '');
  const url = payload.url || '/captures';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url },
      tag: payload.tag || ('kolm-' + (payload.namespace || 'default')),
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  const url = (e.notification.data && e.notification.data.url) || '/captures';
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) { w.navigate(url); return w.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
