// Service worker: makes MK Prod installable as an app (Windows, macOS, Android, iOS) and lets the
// app shell open while offline. Workspace data is never cached here: it lives, encrypted, in
// IndexedDB and is handled by the page. API calls always go to the network.
const SHELL = 'mkprod-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: network first (always the newest build), the cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put('/index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Built assets carry a content hash in their name, so a cached copy is always correct.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || /\.(svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      })),
    );
  }
});
