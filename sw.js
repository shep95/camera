// Service worker: makes True Vision Camera work offline after the first visit.
// Everything the app needs is first-party and precached; there are no network calls at runtime.
const VERSION = 'tv-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/manifest.webmanifest', '/assets/icon.svg',
  '/src/app.js', '/src/engine/scene.js', '/src/engine/decision.js', '/src/engine/aura.js',
  '/src/engine/renderer.js', '/src/engine/capture.js', '/src/engine/principles.js', '/src/platform.js', '/src/features.js',
  '/src/engine/vision.js', '/src/engine/focus.js', '/src/engine/observations.js', '/src/engine/devices.js', '/src/engine/screenrec.js', '/src/engine/workspace.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // stale-while-revalidate: answer from cache immediately, refresh the cache from the network when online
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => { if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await network) || (req.mode === 'navigate' ? cache.match('/index.html') : Response.error());
  }));
});
