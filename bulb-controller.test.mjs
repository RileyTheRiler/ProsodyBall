import test from 'node:test';
import assert from 'node:assert/strict';
import { BulbController, hslToHueApi } from './bulb-controller.js';

// In-memory localStorage stand-in
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

// A transport that records every send, with a controllable clock.
function makeController({ now, transport, transportName = 'fake', throttleMs = 150 } = {}) {
  const storage = fakeStorage();
  const ctrl = new BulbController({
    storage,
    now,
    fetchImpl: null,
    transports: { mock: { send: async () => {}, test: async () => {} }, [transportName]: transport },
  });
  ctrl.config.enabled = true;
  ctrl.config.transport = transportName;
  ctrl.config.throttleMs = throttleMs;
  return ctrl;
}

test('hslToHueApi maps HSL into Hue integer ranges', () => {
  assert.deepEqual(hslToHueApi(0, 0, 0), { hue: 0, sat: 0, bri: 1 });
  assert.deepEqual(hslToHueApi(360, 100, 100), { hue: 0, sat: 254, bri: 254 });
  assert.deepEqual(hslToHueApi(180, 50, 50), { hue: 32768, sat: 127, bri: 127 });
  // bri is clamped to a minimum of 1 so the bulb never goes fully dark unexpectedly
  assert.equal(hslToHueApi(0, 0, 0).bri, 1);
});

test('update throttles many frames into a single send per interval', async () => {
  let t = 1000;
  let sends = 0;
  const transport = { send: async () => { sends += 1; }, test: async () => {} };
  const ctrl = makeController({ now: () => t, transport, throttleMs: 150 });

  // First call sends immediately (no prior send)
  ctrl.update(220, 80, 50, 0.016);
  // 9 more calls within the same 150ms window, each shifting color a lot
  for (let i = 0; i < 9; i++) { t += 10; ctrl.update(220 + i * 10, 80, 50, 0.016); }
  await Promise.resolve();
  assert.equal(sends, 1, 'only one send within the throttle window');

  // Cross the throttle boundary -> one more send allowed
  t += 200;
  ctrl.update(340, 80, 50, 0.016);
  await Promise.resolve();
  assert.equal(sends, 2);
});

test('update suppresses near-identical colors', async () => {
  let t = 1000;
  let sends = 0;
  const transport = { send: async () => { sends += 1; }, test: async () => {} };
  const ctrl = makeController({ now: () => t, transport, throttleMs: 100 });

  ctrl.update(220, 80, 50, 1); // dt=1 forces cur to snap to target; first send
  await Promise.resolve();
  assert.equal(sends, 1);

  // Past the throttle window but the color barely moved -> no send
  t += 500;
  ctrl.update(220.5, 80, 50, 1);
  await Promise.resolve();
  assert.equal(sends, 1, 'sub-threshold change is skipped');
});

test('mock transport never dispatches over the network', async () => {
  let t = 1000;
  let sends = 0;
  const ctrl = makeController({
    now: () => t,
    transport: { send: async () => { sends += 1; }, test: async () => {} },
    transportName: 'fake',
  });
  ctrl.config.transport = 'mock';
  for (let i = 0; i < 5; i++) { t += 200; ctrl.update(220 + i * 30, 80, 50, 1); }
  await Promise.resolve();
  assert.equal(sends, 0);
});

test('repeated failures auto-disable the controller', async () => {
  let t = 1000;
  const transport = { send: async () => { throw new Error('boom'); }, test: async () => {} };
  const ctrl = makeController({ now: () => t, transport, throttleMs: 50 });

  for (let i = 0; i < 6; i++) {
    t += 100;
    ctrl.update(200 + i * 25, 80, 50, 1);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(ctrl.config.enabled, false, 'auto-disabled after MAX_FAILURES');
});

test('config persists to and reloads from storage', () => {
  const storage = fakeStorage();
  const a = new BulbController({ storage, now: () => 0, fetchImpl: null });
  a.set('transport', 'hue');
  a.set('hueBridge', '192.168.1.50');
  a.setEnabled(true);

  const b = new BulbController({ storage, now: () => 0, fetchImpl: null });
  assert.equal(b.config.transport, 'hue');
  assert.equal(b.config.hueBridge, '192.168.1.50');
  assert.equal(b.config.enabled, true);
});

test('disabled controller does nothing on update', async () => {
  let sends = 0;
  const ctrl = makeController({
    now: () => 1000,
    transport: { send: async () => { sends += 1; }, test: async () => {} },
  });
  ctrl.setEnabled(false);
  ctrl.update(220, 80, 50, 1);
  await Promise.resolve();
  assert.equal(sends, 0);
});
