const CACHE_NAME = 'prosodyball-shell-v2';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './dsp-utils.js',
  './dsp-constants.generated.js',
  './phrase-coach.js',
  './speech-feedback.js',
  './performance-monitor.js',
  './calibration-wizard.js',
  './bulb-controller.js',
  './necklace-controller.js',
  './vibration-preferences.js',
  './ui-dialog-manager.js',
  './settings-transfer.js',
  './pitch-estimator.js',
  './pitch-analysis-worker.js',
  './pwa.js',
  './manifest.webmanifest',
  './icons/app-icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});
