import test from 'node:test';
import assert from 'node:assert/strict';
import { BulbController, GenericBleTransport, Esp32BleTransport, ESP32_SERVICE_UUID, ESP32_COLOR_UUID, hslToHueApi, hslToRgb, hslToXy } from './bulb-controller.js';

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

test('hslToXy returns in-range CIE coords and brightness', () => {
  const red = hslToXy(0, 100, 50);
  const blue = hslToXy(240, 100, 50);
  for (const c of [red, blue]) {
    assert.ok(c.x >= 0 && c.x <= 65535);
    assert.ok(c.y >= 0 && c.y <= 65535);
    assert.ok(c.bri >= 1 && c.bri <= 254);
  }
  // In CIE 1931, red sits at a high x with moderate y; blue sits at a low x and
  // a very low y. So red has both a higher x and a higher y than blue.
  assert.ok(red.x > blue.x);
  assert.ok(red.y > blue.y);
});

test('dispatch waits for transports that report not ready', async () => {
  let t = 1000;
  let sends = 0;
  let ready = false;
  const transport = {
    isReady: () => ready,
    send: async () => { sends += 1; },
    test: async () => {},
  };
  const ctrl = makeController({ now: () => t, transport, throttleMs: 100 });

  ctrl.update(220, 80, 50, 1);
  await Promise.resolve();
  assert.equal(sends, 0, 'no send while not ready, and no failure counted');
  assert.equal(ctrl._failCount, 0);

  ready = true;
  t += 200;
  ctrl.update(220, 80, 50, 1);
  await Promise.resolve();
  assert.equal(sends, 1, 'sends once the transport is ready');
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

test('set coerces values to the existing config type', () => {
  const ctrl = new BulbController({ storage: fakeStorage(), now: () => 0, fetchImpl: null });
  ctrl.set('enabled', 'true');
  assert.equal(ctrl.config.enabled, true);
  ctrl.set('enabled', '0');
  assert.equal(ctrl.config.enabled, false);
  ctrl.set('throttleMs', '250');
  assert.equal(ctrl.config.throttleMs, 250);
  ctrl.set('hueBridge', '10.0.0.5');
  assert.equal(ctrl.config.hueBridge, '10.0.0.5');
});

test('onChange fires when the controller changes config (e.g. auto-disable)', () => {
  let calls = 0;
  const ctrl = new BulbController({ storage: fakeStorage(), now: () => 0, fetchImpl: null });
  ctrl.onChange = () => { calls += 1; };
  ctrl.setEnabled(true);
  ctrl.set('transport', 'hue');
  assert.equal(calls, 2);
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

test('hslToRgb maps HSL to 8-bit RGB primaries', () => {
  assert.deepEqual(hslToRgb(0, 100, 50), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hslToRgb(120, 100, 50), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hslToRgb(240, 100, 50), { r: 0, g: 0, b: 255 });
  assert.deepEqual(hslToRgb(0, 0, 100), { r: 255, g: 255, b: 255 });
  assert.deepEqual(hslToRgb(0, 0, 0), { r: 0, g: 0, b: 0 });
});

// A minimal in-memory Web Bluetooth GATT stack. `available` lists the
// {service, write} characteristic combos the fake bulb exposes (values matched
// exactly as GenericBleTransport requests them). Records every write.
function fakeBle(available, deviceId = 'dev-1') {
  const writes = [];
  let connected = false;
  const server = {
    get connected() { return connected; },
    async getPrimaryService(svc) {
      if (!available.some((a) => a.service === svc)) throw new Error(`no service ${svc}`);
      return {
        async getCharacteristic(ch) {
          if (!available.some((a) => a.service === svc && a.write === ch)) throw new Error(`no char ${ch}`);
          return { writeValueWithoutResponse: async (d) => { writes.push(Array.from(d)); } };
        },
      };
    },
  };
  const gatt = {
    get connected() { return connected; },
    async connect() { connected = true; return server; },
  };
  const device = { id: deviceId, gatt, addEventListener() {} };
  const bluetooth = {
    requestArgs: null,
    async requestDevice(opts) { this.requestArgs = opts; return device; },
    async getDevices() { return [device]; },  // previously-granted devices (for reconnect)
  };
  return { bluetooth, writes, device };
}

test('GenericBleTransport probes the Triones family and writes the 0x56 color packet', async () => {
  const { bluetooth, writes } = fakeBle([{ service: 0xffd5, write: 0xffd9 }]);
  const t = new GenericBleTransport({ bluetooth, getConfig: () => ({}) });
  await t.connect();
  assert.equal(t.profile.name, 'triones');
  assert.ok(t.isReady());
  await t.send({ on: true, h: 0, s: 100, l: 50 }); // pure red
  assert.deepEqual(writes[0], [0xcc, 0x23, 0x33], 'power-on frame on the off->on edge');
  assert.deepEqual(writes[1], [0x56, 0xff, 0x00, 0x00, 0x00, 0xf0, 0xaa], 'red color packet');
});

test('GenericBleTransport falls back to the Magic Blue UUID family', async () => {
  const { bluetooth } = fakeBle([{ service: 0xffe5, write: 0xffe9 }]);
  const t = new GenericBleTransport({ bluetooth, getConfig: () => ({}) });
  await t.connect();
  assert.equal(t.profile.name, 'magicblue');
});

test('GenericBleTransport drives ELK-BLEDOM strips with the 0x7e frame', async () => {
  const { bluetooth, writes } = fakeBle([{ service: 0xfff0, write: 0xfff3 }]);
  const t = new GenericBleTransport({ bluetooth, getConfig: () => ({}) });
  await t.connect();
  assert.equal(t.profile.name, 'elkbledom');
  await t.send({ on: true, h: 0, s: 100, l: 50 }); // pure red
  assert.deepEqual(writes[0], [0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef], 'power-on edge');
  assert.deepEqual(writes[1], [0x7e, 0x00, 0x05, 0x03, 0xff, 0x00, 0x00, 0x00, 0xef], 'red color frame');
});

test('GenericBleTransport tries the manual UUID override first', async () => {
  const svc = '0000abcd-0000-1000-8000-00805f9b34fb';
  const wr = '0000ef01-0000-1000-8000-00805f9b34fb';
  const { bluetooth, writes } = fakeBle([{ service: svc, write: wr }]);
  const cfg = { bleServiceUuid: svc.toUpperCase(), bleWriteUuid: wr.toUpperCase() };
  const t = new GenericBleTransport({ bluetooth, getConfig: () => cfg });
  await t.connect();
  assert.equal(t.profile.name, 'custom');
  await t.send({ on: false });
  assert.deepEqual(writes[0], [0xcc, 0x24, 0x33], 'power-off frame');
});

test('GenericBleTransport reports a helpful error when no known service matches', async () => {
  const { bluetooth } = fakeBle([{ service: 0x1234, write: 0x5678 }]);
  const t = new GenericBleTransport({ bluetooth, getConfig: () => ({}) });
  await assert.rejects(() => t.connect(), /advanced UUID fields/);
  assert.equal(t.isReady(), false);
});

test('Esp32BleTransport writes raw 3-byte RGB to the custom service', async () => {
  const { bluetooth, writes } = fakeBle([{ service: ESP32_SERVICE_UUID, write: ESP32_COLOR_UUID }]);
  const t = new Esp32BleTransport({ bluetooth });
  await t.connect();
  assert.ok(t.isReady());
  await t.send({ on: true, h: 0, s: 100, l: 50 }); // pure red
  assert.deepEqual(writes[0], [0xff, 0x00, 0x00], 'red as [R,G,B]');
  await t.send({ on: false });
  assert.deepEqual(writes[1], [0x00, 0x00, 0x00], 'off == black');
});

test('BLE transport reconnects to a saved device id without a new picker', async () => {
  const { bluetooth } = fakeBle([{ service: ESP32_SERVICE_UUID, write: ESP32_COLOR_UUID }], 'orb-42');
  // First session: pair and remember the id.
  const first = new Esp32BleTransport({ bluetooth });
  await first.connect();
  assert.equal(first.getDeviceId(), 'orb-42');
  // Next session (fresh transport, no requestDevice gesture): reconnect by id.
  const next = new Esp32BleTransport({ bluetooth });
  const ok = await next.reconnect('orb-42');
  assert.equal(ok, true);
  assert.ok(next.isReady());
});

test('reconnect returns false when the saved device is no longer granted', async () => {
  const { bluetooth } = fakeBle([{ service: ESP32_SERVICE_UUID, write: ESP32_COLOR_UUID }], 'orb-42');
  const t = new Esp32BleTransport({ bluetooth });
  assert.equal(await t.reconnect('some-other-id'), false);
  assert.equal(t.isReady(), false);
});
