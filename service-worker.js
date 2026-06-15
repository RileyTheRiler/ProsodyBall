/* Vox Arcade service worker — cache-first app shell for offline + installable PWA.
 * Bump CACHE_VERSION on any shell change to invalidate old caches. */
const CACHE_VERSION = 'vox-arcade-v1';
const PRECACHE = `${CACHE_VERSION}-precache`;
const RUNTIME = `${CACHE_VERSION}-runtime`;

// Same-origin shell assets. Microphone/audio streams are never cached.
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './dsp-utils.js',
  './calibration-wizard.js',
  './bulb-controller.js',
  './performance-monitor.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // Cache individually so one 404 doesn't abort the whole install.
      await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== PRECACHE && k !== RUNTIME)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Allow the page to trigger an immediate update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Navigations: network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(PRECACHE);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          return (
            (await caches.match('./index.html')) ||
            (await caches.match('./')) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // Google Fonts: stale-while-revalidate in a runtime cache.
  if (
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com'
  ) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME));
    return;
  }

  // Same-origin shell: cache-first, then network (and cache the result).
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok && fresh.type === 'basic') {
            const cache = await caches.open(RUNTIME);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          return cached || Response.error();
        }
      })()
    );
  }
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}
