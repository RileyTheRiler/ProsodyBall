// BLE companion for the ProsodyBall Necklace (hardware/prosody_necklace).
//
// The necklace is a standalone haptic trainer: it decides on its own, on-device, when to
// buzz. This controller's only jobs are (1) push a one-time calibration packet (which metric
// to train, plus its target band/threshold) and (2) listen for periodic session-status
// notifications so the web app can show a live readout. It never streams live audio or
// per-frame control data, unlike bulb-controller.js's Esp32BleTransport.
//
// Mirrors Esp32BleTransport's method names/shapes (bulb-controller.js) so a future
// unification is easy, despite the different lifecycle.

export const NECKLACE_SERVICE_UUID = '5b1e0010-8a0e-4f1b-9c5a-2f3d4e5a6b7c';
export const NECKLACE_CALIB_CHAR_UUID = '5b1e0011-8a0e-4f1b-9c5a-2f3d4e5a6b7c';
export const NECKLACE_STATUS_CHAR_UUID = '5b1e0012-8a0e-4f1b-9c5a-2f3d4e5a6b7c';
const NECKLACE_NAME_PREFIX = 'ProsodyBall-Necklace';

export const HapticSrc = { PITCH: 0, RESONANCE: 1, WEIGHT: 2 };

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Look up a device the user already granted in a previous session (identical helper to
// bulb-controller.js's) so we can reconnect after a page reload without another picker
// gesture. Uses Web Bluetooth's getDevices() (Chromium).
async function findGrantedDevice(bluetooth, deviceId) {
  if (!bluetooth || !deviceId || typeof bluetooth.getDevices !== 'function') return null;
  try {
    const devices = await bluetooth.getDevices();
    return (devices || []).find((d) => d && d.id === deviceId) || null;
  } catch { return null; }
}

export class NecklaceController {
  constructor({ bluetooth, onStatus } = {}) {
    this.bluetooth = bluetooth !== undefined
      ? bluetooth
      : (typeof navigator !== 'undefined' ? navigator.bluetooth : null);
    this.device = null;
    this.calibCh = null;
    this.statusCh = null;
    this.onStatus = onStatus || null;
    this._onNotify = this._onNotify.bind(this);
  }

  isReady() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected && this.calibCh);
  }

  async connect() {
    if (!this.bluetooth) {
      throw new Error('Web Bluetooth not supported — use Chrome, Edge, or Opera.');
    }
    this.device = await this.bluetooth.requestDevice({
      filters: [{ services: [NECKLACE_SERVICE_UUID] }, { namePrefix: NECKLACE_NAME_PREFIX }],
      optionalServices: [NECKLACE_SERVICE_UUID],
    });
    this._bindDisconnect();
    await this._openGatt();
  }

  _bindDisconnect() {
    if (this.device && this.device.addEventListener) {
      this.device.addEventListener('gattserverdisconnected', () => {
        this.calibCh = null;
        this.statusCh = null;
      });
    }
  }

  getDeviceId() { return this.device && this.device.id ? this.device.id : null; }

  // Re-link to the previously-granted necklace after a reload — no picker gesture.
  async reconnect(deviceId) {
    const dev = await findGrantedDevice(this.bluetooth, deviceId);
    if (!dev) return false;
    this.device = dev;
    this._bindDisconnect();
    await this._openGatt();
    return this.isReady();
  }

  async _openGatt() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(NECKLACE_SERVICE_UUID);
    this.calibCh = await svc.getCharacteristic(NECKLACE_CALIB_CHAR_UUID);
    this.statusCh = await svc.getCharacteristic(NECKLACE_STATUS_CHAR_UUID);
    if (this.statusCh.addEventListener) this.statusCh.addEventListener('characteristicvaluechanged', this._onNotify);
    if (typeof this.statusCh.startNotifications === 'function') await this.statusCh.startNotifications();
  }

  _onNotify(event) {
    const dv = event && event.target ? event.target.value : null;
    if (dv) this._onStatusPacket(dv);
  }

  // Decodes the firmware's 8-byte status notification:
  // [flags, onTargetPct, voicedSeconds LE u16, currentMetricVal, batteryPct, reserved x2].
  _onStatusPacket(dataView) {
    if (!dataView || dataView.byteLength < 8) return;
    const flags = dataView.getUint8(0);
    const battery = dataView.getUint8(5);
    const status = {
      micOk: !!(flags & 0x01),
      calibrating: !!(flags & 0x02),
      sessionActive: !!(flags & 0x04),
      onTargetPct: dataView.getUint8(1),
      voicedSeconds: dataView.getUint16(2, true),
      metricVal: dataView.getUint8(4),
      batteryPct: battery === 0xff ? null : battery,
    };
    if (typeof this.onStatus === 'function') this.onStatus(status);
  }

  // Builds and writes the firmware's 6-byte calibration packet:
  // [hapticSrc, hapticThrPct, targetLoHz LE u16, targetHiHz LE u16].
  async sendCalibration({ hapticSrc, hapticThrPct, targetLoHz, targetHiHz }) {
    if (!this.isReady()) throw new Error('Not connected — click Connect first.');
    const src = clamp(Math.round(hapticSrc), 0, 2);
    const thr = clamp(Math.round(hapticThrPct), 0, 100);
    const lo = clamp(Math.round(targetLoHz), 0, 65535);
    const hi = clamp(Math.round(targetHiHz), 0, 65535);
    const pkt = Uint8Array.of(src, thr, lo & 0xff, (lo >> 8) & 0xff, hi & 0xff, (hi >> 8) & 0xff);
    const write = (data) => (this.calibCh.writeValueWithoutResponse
      ? this.calibCh.writeValueWithoutResponse(data)
      : this.calibCh.writeValue(data));
    await write(pkt);
  }

  // Manual connection test (mirrors Esp32BleTransport.test()) — connects if needed and
  // confirms the GATT round-trip without side effects on the necklace's saved settings.
  async test() {
    if (!this.isReady()) await this.connect();
    return true;
  }
}
