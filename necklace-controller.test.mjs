import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NecklaceController,
  NECKLACE_SERVICE_UUID,
  NECKLACE_CALIB_CHAR_UUID,
  NECKLACE_STATUS_CHAR_UUID,
} from './necklace-controller.js';

// In-memory Web Bluetooth GATT stack with a writable calibration characteristic and a
// notifying status characteristic. Extends bulb-controller.test.mjs's fakeBle() pattern
// with a notify stub so _onStatusPacket can be exercised end-to-end.
function fakeBle(deviceId = 'dev-1') {
  const writes = [];
  let connected = false;
  let notifyListener = null;

  const calibCh = {
    writeValueWithoutResponse: async (d) => { writes.push(Array.from(d)); },
  };
  const statusCh = {
    addEventListener(evt, fn) { if (evt === 'characteristicvaluechanged') notifyListener = fn; },
    removeEventListener() { notifyListener = null; },
    async startNotifications() { return statusCh; },
    // Test helper: simulate the firmware pushing a status notification.
    _emit(bytes) {
      const value = new DataView(new Uint8Array(bytes).buffer);
      if (notifyListener) notifyListener({ target: { value } });
    },
  };

  const server = {
    get connected() { return connected; },
    async getPrimaryService(svc) {
      if (svc !== NECKLACE_SERVICE_UUID) throw new Error(`no service ${svc}`);
      return {
        async getCharacteristic(ch) {
          if (ch === NECKLACE_CALIB_CHAR_UUID) return calibCh;
          if (ch === NECKLACE_STATUS_CHAR_UUID) return statusCh;
          throw new Error(`no char ${ch}`);
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
    async getDevices() { return [device]; }, // previously-granted devices (for reconnect)
  };
  return { bluetooth, writes, device, statusCh };
}

test('connect() opens GATT and fetches both characteristics', async () => {
  const { bluetooth } = fakeBle();
  const ctrl = new NecklaceController({ bluetooth });
  await ctrl.connect();
  assert.ok(ctrl.isReady());
});

test('sendCalibration writes the exact 6-byte packet layout', async () => {
  const { bluetooth, writes } = fakeBle();
  const ctrl = new NecklaceController({ bluetooth });
  await ctrl.connect();
  await ctrl.sendCalibration({ hapticSrc: 1, hapticThrPct: 60, targetLoHz: 145, targetHiHz: 175 });
  // 145 = 0x0091, 175 = 0x00AF (little-endian)
  assert.deepEqual(writes[0], [1, 60, 0x91, 0x00, 0xaf, 0x00]);
});

test('sendCalibration clamps out-of-range values instead of sending garbage', async () => {
  const { bluetooth, writes } = fakeBle();
  const ctrl = new NecklaceController({ bluetooth });
  await ctrl.connect();
  await ctrl.sendCalibration({ hapticSrc: 9, hapticThrPct: 250, targetLoHz: -5, targetHiHz: 999999 });
  assert.deepEqual(writes[0], [2, 100, 0, 0, 0xff, 0xff]);
});

test('sendCalibration throws when not connected', async () => {
  const { bluetooth } = fakeBle();
  const ctrl = new NecklaceController({ bluetooth });
  await assert.rejects(
    () => ctrl.sendCalibration({ hapticSrc: 0, hapticThrPct: 50, targetLoHz: 145, targetHiHz: 175 }),
    /Connect first/,
  );
});

test('decodes an 8-byte status notification and forwards it via onStatus', async () => {
  const { bluetooth, statusCh } = fakeBle();
  const statuses = [];
  const ctrl = new NecklaceController({ bluetooth, onStatus: (s) => statuses.push(s) });
  await ctrl.connect();

  // flags = micOk|calibrating (0x03), onTargetPct=72, voicedSeconds=300 (0x012C LE),
  // metricVal=55, battery=0xFF (n/a), reserved x2.
  statusCh._emit([0x03, 72, 0x2c, 0x01, 55, 0xff, 0, 0]);

  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0], {
    micOk: true,
    calibrating: true,
    sessionActive: false,
    onTargetPct: 72,
    voicedSeconds: 300,
    metricVal: 55,
    batteryPct: null,
  });
});

test('decodes a battery percentage when present (not 0xFF)', async () => {
  const { bluetooth, statusCh } = fakeBle();
  const statuses = [];
  const ctrl = new NecklaceController({ bluetooth, onStatus: (s) => statuses.push(s) });
  await ctrl.connect();

  statusCh._emit([0x07, 10, 5, 0, 20, 88, 0, 0]); // all flags set, battery 88%
  assert.equal(statuses[0].sessionActive, true);
  assert.equal(statuses[0].batteryPct, 88);
});

test('getDeviceId / reconnect re-links a previously granted device without a picker', async () => {
  const { bluetooth } = fakeBle('necklace-7');
  const first = new NecklaceController({ bluetooth });
  await first.connect();
  assert.equal(first.getDeviceId(), 'necklace-7');

  const next = new NecklaceController({ bluetooth });
  const ok = await next.reconnect('necklace-7');
  assert.equal(ok, true);
  assert.ok(next.isReady());
});

test('reconnect returns false when the saved device id is no longer granted', async () => {
  const { bluetooth } = fakeBle('necklace-7');
  const ctrl = new NecklaceController({ bluetooth });
  assert.equal(await ctrl.reconnect('some-other-id'), false);
  assert.equal(ctrl.isReady(), false);
});
