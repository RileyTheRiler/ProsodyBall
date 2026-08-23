import test from 'node:test';
import assert from 'node:assert/strict';

const handlers = new Map();
const cachedWrites = [];

globalThis.self = {
  location: { origin: 'https://prosodyball.test' },
  clients: { claim: async () => {} },
  skipWaiting: () => {},
  addEventListener: (type, handler) => handlers.set(type, handler),
};

globalThis.caches = {
  open: async () => ({
    addAll: async () => {},
    put: async (request, response) => { cachedWrites.push({ request, response }); },
  }),
  keys: async () => [],
  delete: async () => true,
  match: async () => null,
};

await import('./service-worker.js');

function dispatchFetch(request) {
  let responsePromise;
  handlers.get('fetch')({
    request,
    respondWith: (promise) => { responsePromise = promise; },
  });
  return responsePromise;
}

test('service worker prefers fresh same-origin assets and refreshes the cache', async () => {
  cachedWrites.length = 0;
  globalThis.fetch = async () => new Response('fresh');
  caches.match = async () => new Response('stale');
  const request = { method: 'GET', mode: 'cors', url: 'https://prosodyball.test/app.js' };

  const response = await dispatchFetch(request);

  assert.equal(await response.text(), 'fresh');
  assert.equal(cachedWrites.length, 1);
  assert.equal(cachedWrites[0].request, request);
});

test('service worker falls back to a cached asset while offline', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  caches.match = async () => new Response('cached');
  const request = { method: 'GET', mode: 'cors', url: 'https://prosodyball.test/app.js' };

  const response = await dispatchFetch(request);

  assert.equal(await response.text(), 'cached');
});
