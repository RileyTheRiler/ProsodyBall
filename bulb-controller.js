// Smart Bulb sync for ProsodyBall.
//
// Mirrors the on-screen ball's color onto a real (or simulated) smart lightbulb.
// The game already computes ballHue/ballSat/ballLit every frame; this controller
// reads those values, smooths them, throttles them to a hardware-friendly rate,
// and dispatches them through a pluggable transport.
//
// Design notes:
//  - Pure-frontend: only HTTP-based transports (browsers can't send raw UDP/TCP),
//    which keeps ProsodyBall a static, backend-free app.
//  - DOM and network access are guarded so this module is unit-testable in Node.

const STORAGE_PREFIX = 'vox:bulb:';
const DEFAULT_THROTTLE_MS = 150;   // max one wire command per this interval
const SMOOTH_PER_SEC = 7;          // extra exponential smoothing on top of the analyzer
const COLOR_DELTA_H = 2;           // min hue change (deg) worth re-sending
const COLOR_DELTA_SL = 2;          // min sat/lit change (%) worth re-sending
const MAX_FAILURES = 5;            // consecutive failures before auto-disable
const REQUEST_TIMEOUT_MS = 2500;

// Philips Hue BLE GATT (community-reverse-engineered; see philble / hue-ble-ctl).
const HUE_FE0F_SERVICE = 0xfe0f;                                   // advertised service, used for the device-picker filter
const HUE_LIGHT_SERVICE = '932c32bd-0000-47a2-835a-a8d455b859dd';  // control service
const HUE_CHAR_ONOFF = '932c32bd-0002-47a2-835a-a8d455b859dd';     // 1 byte: 0 off / 1 on
const HUE_CHAR_BRIGHT = '932c32bd-0003-47a2-835a-a8d455b859dd';    // 1 byte: 1-254
const HUE_CHAR_COLOR = '932c32bd-0005-47a2-835a-a8d455b859dd';     // 4 bytes: CIE x,y as uint16 LE

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Convert HSL (h:0-360, s/l:0-100) to the Philips Hue Bridge integer ranges.
export function hslToHueApi(h, s, l) {
  const hue = Math.round(((((h % 360) + 360) % 360) / 360) * 65535);
  const sat = Math.round((clamp(s, 0, 100) / 100) * 254);
  const bri = Math.max(1, Math.round((clamp(l, 0, 100) / 100) * 254));
  return { hue, sat, bri };
}

// Convert HSL (h:0-360, s/l:0-100) to sRGB components in the 0..1 range.
// Shared by hslToRgb (8-bit) and hslToXy (CIE) so there is a single conversion.
function hslToRgb01(h, s, l) {
  const sat = clamp(s, 0, 100) / 100;
  const lit = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const hp = ((((h % 360) + 360) % 360)) / 60;
  const x1 = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x1; }
  else if (hp < 2) { r = x1; g = c; }
  else if (hp < 3) { g = c; b = x1; }
  else if (hp < 4) { g = x1; b = c; }
  else if (hp < 5) { r = x1; b = c; }
  else { r = c; b = x1; }
  const m = lit - c / 2;
  return { r: clamp(r + m, 0, 1), g: clamp(g + m, 0, 1), b: clamp(b + m, 0, 1) };
}

// Convert HSL to 8-bit RGB (0-255) — the format generic BLE bulbs expect.
export function hslToRgb(h, s, l) {
  const { r, g, b } = hslToRgb01(h, s, l);
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// Convert HSL to the CIE 1931 xy color point (as uint16 0-65535) + brightness
// (1-254) that the Hue BLE color characteristic expects.
export function hslToXy(h, s, l) {
  const lit = clamp(l, 0, 100) / 100;
  const { r, g, b } = hslToRgb01(h, s, l);
  // sRGB gamma -> linear, then Philips' Wide-RGB D65 matrix
  const gamma = (ch) => (ch > 0.04045 ? Math.pow((ch + 0.055) / 1.055, 2.4) : ch / 12.92);
  const R = gamma(r), G = gamma(g), B = gamma(b);
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.072310 + B * 0.986039;
  const total = X + Y + Z;
  const cx = total > 0 ? X / total : 0;
  const cy = total > 0 ? Y / total : 0;
  return {
    x: Math.round(clamp(cx, 0, 1) * 65535),
    y: Math.round(clamp(cy, 0, 1) * 65535),
    bri: Math.max(1, Math.round(lit * 254)),
  };
}

async function httpJson(fetchImpl, url, method, body) {
  if (!fetchImpl) throw new Error('fetch unavailable');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- Transports -----------------------------------------------------------
// Each transport implements: async send({on, h, s, l}) and async test().

// The on-screen simulated bulb. The visible swatch is painted by the controller
// every frame for smooth feedback, so the transport itself is a no-op.
export class MockTransport {
  async send() { /* visual handled by BulbController._paintMock */ }
  async test() { return true; }
}

// Philips Hue Bridge local HTTP API.
export class HueTransport {
  constructor({ fetchImpl, getConfig }) {
    this.fetchImpl = fetchImpl;
    this.getConfig = getConfig;
  }
  _url() {
    const c = this.getConfig();
    if (!c.hueBridge || !c.hueUser) throw new Error('Bridge IP and user required');
    return `http://${c.hueBridge}/api/${c.hueUser}/lights/${c.hueLightId || '1'}/state`;
  }
  async send({ on, h, s, l }) {
    const { hue, sat, bri } = hslToHueApi(h, s, l);
    await httpJson(this.fetchImpl, this._url(), 'PUT', { on, hue, sat, bri, transitiontime: 1 });
  }
  async test() {
    await httpJson(this.fetchImpl, this._url(), 'PUT', { on: true });
  }
}

// Generic JSON POST (Home Assistant webhook or any custom endpoint).
export class HttpTransport {
  constructor({ fetchImpl, getUrl }) {
    this.fetchImpl = fetchImpl;
    this.getUrl = getUrl;
  }
  async send({ on, h, s, l }) {
    await this._post({ on, h: Math.round(h), s: Math.round(s), l: Math.round(l) });
  }
  async test() {
    await this._post({ on: true, h: 220, s: 80, l: 50 });
  }
  async _post(body) {
    const url = this.getUrl && this.getUrl();
    if (!url) throw new Error('No URL configured');
    await httpJson(this.fetchImpl, url, 'POST', body);
  }
}

// Look up a device the user already granted in a previous session, so we can
// reconnect after a page reload *without* another picker gesture. Uses Web
// Bluetooth's getDevices() (Chromium). Returns null if the API is unavailable
// or no granted device matches — callers fall back to a manual connect.
async function findGrantedDevice(bluetooth, deviceId) {
  if (!bluetooth || !deviceId || typeof bluetooth.getDevices !== 'function') return null;
  try {
    const devices = await bluetooth.getDevices();
    return (devices || []).find((d) => d && d.id === deviceId) || null;
  } catch { return null; }
}

// Drives a Philips Hue bulb directly over Bluetooth from the browser — no Bridge
// and no router. Requires a Chromium-based browser (Web Bluetooth) and a one-time
// user gesture to pick the bulb. connect() must be called from a click handler.
export class WebBluetoothTransport {
  constructor({ bluetooth } = {}) {
    this.bluetooth = bluetooth !== undefined
      ? bluetooth
      : (typeof navigator !== 'undefined' ? navigator.bluetooth : null);
    this.device = null;
    this.chars = null;
  }

  isReady() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected && this.chars);
  }

  async connect() {
    if (!this.bluetooth) {
      throw new Error('Web Bluetooth not supported — use Chrome, Edge, or Opera.');
    }
    this.device = await this.bluetooth.requestDevice({
      filters: [{ services: [HUE_FE0F_SERVICE] }, { namePrefix: 'Hue' }],
      optionalServices: [HUE_LIGHT_SERVICE],
    });
    this._bindDisconnect();
    await this._openGatt();
  }

  _bindDisconnect() {
    if (this.device && this.device.addEventListener) {
      this.device.addEventListener('gattserverdisconnected', () => { this.chars = null; });
    }
  }

  getDeviceId() { return this.device && this.device.id ? this.device.id : null; }

  // Re-link to a previously-granted device after a reload — no picker gesture.
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
    const svc = await server.getPrimaryService(HUE_LIGHT_SERVICE);
    this.chars = {
      onoff: await svc.getCharacteristic(HUE_CHAR_ONOFF),
      bright: await svc.getCharacteristic(HUE_CHAR_BRIGHT),
      color: await svc.getCharacteristic(HUE_CHAR_COLOR),
    };
  }

  async test() {
    if (!this.isReady()) await this.connect();
    await this.send({ on: true, h: 210, s: 90, l: 55 });
    return true;
  }

  async send({ on, h, s, l }) {
    if (!this.isReady()) {
      if (this.device && this.device.gatt) await this._openGatt(); // reconnect after a drop
      else throw new Error('Not connected — click Connect first.');
    }
    const write = (ch, data) => (ch.writeValueWithoutResponse
      ? ch.writeValueWithoutResponse(data)
      : ch.writeValue(data));
    if (!on) { await write(this.chars.onoff, Uint8Array.of(0)); return; }
    const { x, y, bri } = hslToXy(h, s, l);
    await write(this.chars.onoff, Uint8Array.of(1));
    await write(this.chars.color, Uint8Array.of(x & 0xff, (x >> 8) & 0xff, y & 0xff, (y >> 8) & 0xff));
    await write(this.chars.bright, Uint8Array.of(bri));
  }
}

// Known protocol families for cheap, unencrypted RGB(W) Bluetooth bulbs (the
// "16M colors + remote + music sync" class sold under generic/no-name brands,
// e.g. Triones / HappyLighting / Magic Blue / Zengge / briturn). They expose
// open GATT with no bonding, so a browser can write color directly.
//
// `encodeColor(r,g,b)` builds the wire packet for a solid color. The Triones and
// Magic Blue families share the 7-byte 0x56 command and differ only by UUID, so
// we probe them in order on connect and use whichever the bulb actually exposes.
const TRIONES_POWER_ON = Uint8Array.of(0xcc, 0x23, 0x33);
const TRIONES_POWER_OFF = Uint8Array.of(0xcc, 0x24, 0x33);
const trionesColor = (r, g, b) => Uint8Array.of(0x56, r, g, b, 0x00, 0xf0, 0xaa);

const BLE_BULB_PROFILES = [
  // Triones / HappyLighting
  { name: 'triones', service: 0xffd5, writeChar: 0xffd9, encodeColor: trionesColor,
    powerOn: TRIONES_POWER_ON, powerOff: TRIONES_POWER_OFF },
  // Magic Blue / MagicLight / classic Zengge BLE (same 0x56 command, different UUID)
  { name: 'magicblue', service: 0xffe5, writeChar: 0xffe9, encodeColor: trionesColor,
    powerOn: TRIONES_POWER_ON, powerOff: TRIONES_POWER_OFF },
  // ELK-BLEDOM / MELK / LED-BLE / duoCo Strip — the cheap USB RGB strips. Distinct
  // family: different UUID *and* a different 0x7e…0xef frame (NOT the 0x56 command).
  { name: 'elkbledom', service: 0xfff0, writeChar: 0xfff3,
    encodeColor: (r, g, b) => Uint8Array.of(0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef),
    powerOn: Uint8Array.of(0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef),
    powerOff: Uint8Array.of(0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef) },
  // ffb0 family: 4-byte B,G,R,W (no dedicated power command — black == off)
  { name: 'ffb0', service: 0xffb0, writeChar: 0xffb2,
    encodeColor: (r, g, b) => Uint8Array.of(b, g, r, 0x00), powerOn: null, powerOff: null },
];

// Drives a generic unencrypted RGB(W) bulb directly over Bluetooth — no hub, no
// router. Auto-detects the protocol family on connect, with optional manual
// UUID/name overrides (read from config) as a fallback for unusual bulbs.
// Requires a Chromium-based browser; connect() must run from a user gesture.
export class GenericBleTransport {
  constructor({ bluetooth, getConfig } = {}) {
    this.bluetooth = bluetooth !== undefined
      ? bluetooth
      : (typeof navigator !== 'undefined' ? navigator.bluetooth : null);
    this.getConfig = getConfig || (() => ({}));
    this.device = null;
    this.writeCh = null;
    this.profile = null;
    this._poweredOn = false;
  }

  isReady() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected
      && this.writeCh && this.profile);
  }

  // Custom service+write UUIDs from the advanced fields, if both are set.
  // Assumes the common 0x56 command set, which covers most rebranded bulbs.
  _customProfile() {
    const cfg = this.getConfig() || {};
    const svc = (cfg.bleServiceUuid || '').trim().toLowerCase();
    const wr = (cfg.bleWriteUuid || '').trim().toLowerCase();
    if (!svc || !wr) return null;
    return { name: 'custom', service: svc, writeChar: wr, encodeColor: trionesColor,
      powerOn: TRIONES_POWER_ON, powerOff: TRIONES_POWER_OFF };
  }

  async connect() {
    if (!this.bluetooth) {
      throw new Error('Web Bluetooth not supported — use Chrome, Edge, or Opera.');
    }
    const cfg = this.getConfig() || {};
    // These bulbs often don't advertise their service UUID, so a service filter
    // finds nothing; accept all devices (or a user name filter) and probe later.
    const optionalServices = BLE_BULB_PROFILES.map((p) => p.service);
    const custom = this._customProfile();
    if (custom) optionalServices.push(custom.service);
    const namePrefix = (cfg.bleNamePrefix || '').trim();
    this.device = await this.bluetooth.requestDevice(namePrefix
      ? { filters: [{ namePrefix }], optionalServices }
      : { acceptAllDevices: true, optionalServices });
    this._bindDisconnect();
    await this._openGatt();
  }

  _bindDisconnect() {
    if (this.device && this.device.addEventListener) {
      this.device.addEventListener('gattserverdisconnected', () => {
        this.writeCh = null; this.profile = null; this._poweredOn = false;
      });
    }
  }

  getDeviceId() { return this.device && this.device.id ? this.device.id : null; }

  // Re-link to a previously-granted bulb after a reload — no picker gesture.
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
    this._poweredOn = false;
    const custom = this._customProfile();
    const candidates = custom ? [custom, ...BLE_BULB_PROFILES] : BLE_BULB_PROFILES;
    let lastErr = null;
    for (const profile of candidates) {
      try {
        const svc = await server.getPrimaryService(profile.service);
        this.writeCh = await svc.getCharacteristic(profile.writeChar);
        this.profile = profile;
        return;
      } catch (err) { lastErr = err; }
    }
    this.writeCh = null;
    this.profile = null;
    const detail = lastErr && lastErr.message ? ` (${lastErr.message})` : '';
    throw new Error(`No known bulb service found${detail}. Try the advanced UUID fields.`);
  }

  async test() {
    if (!this.isReady()) await this.connect();
    await this.send({ on: true, h: 210, s: 90, l: 55 });
    return true;
  }

  async send({ on, h, s, l }) {
    if (!this.isReady()) {
      if (this.device && this.device.gatt) await this._openGatt(); // reconnect after a drop
      else throw new Error('Not connected — click Connect first.');
    }
    const write = (data) => (this.writeCh.writeValueWithoutResponse
      ? this.writeCh.writeValueWithoutResponse(data)
      : this.writeCh.writeValue(data));
    if (!on) {
      this._poweredOn = false;
      if (this.profile.powerOff) { await write(this.profile.powerOff); return; }
      await write(this.profile.encodeColor(0, 0, 0)); // no power frame: black == off
      return;
    }
    // Send the power-on frame only on the off->on edge so we don't spam it every frame.
    if (this.profile.powerOn && !this._poweredOn) await write(this.profile.powerOn);
    this._poweredOn = true;
    const { r, g, b } = hslToRgb(h, s, l);
    await write(this.profile.encodeColor(r, g, b));
  }
}

// DIY ESP32 orb: ProsodyBall's *own* open BLE service. Because we control both
// ends — the ESP32 firmware (hardware/prosodyball_orb) and this browser code —
// there is no protocol to reverse-engineer and nothing to bond: a fixed custom
// 128-bit service with one writable characteristic that takes a 3-byte [R,G,B].
// The matching UUIDs live in the firmware sketch; keep them in sync.
export const ESP32_SERVICE_UUID = '5b1e0001-8a0e-4f1b-9c5a-2f3d4e5a6b7c';
export const ESP32_COLOR_UUID = '5b1e0002-8a0e-4f1b-9c5a-2f3d4e5a6b7c';
const ESP32_NAME_PREFIX = 'ProsodyBall';

export class Esp32BleTransport {
  constructor({ bluetooth } = {}) {
    this.bluetooth = bluetooth !== undefined
      ? bluetooth
      : (typeof navigator !== 'undefined' ? navigator.bluetooth : null);
    this.device = null;
    this.colorCh = null;
  }

  isReady() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected && this.colorCh);
  }

  async connect() {
    if (!this.bluetooth) {
      throw new Error('Web Bluetooth not supported — use Chrome, Edge, or Opera.');
    }
    // Our firmware advertises the service UUID, so we can filter on it directly
    // (unlike the no-name bulbs that hide their service).
    this.device = await this.bluetooth.requestDevice({
      filters: [{ services: [ESP32_SERVICE_UUID] }, { namePrefix: ESP32_NAME_PREFIX }],
      optionalServices: [ESP32_SERVICE_UUID],
    });
    this._bindDisconnect();
    await this._openGatt();
  }

  _bindDisconnect() {
    if (this.device && this.device.addEventListener) {
      this.device.addEventListener('gattserverdisconnected', () => { this.colorCh = null; });
    }
  }

  getDeviceId() { return this.device && this.device.id ? this.device.id : null; }

  // Re-link to the previously-granted orb after a reload — no picker gesture.
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
    const svc = await server.getPrimaryService(ESP32_SERVICE_UUID);
    this.colorCh = await svc.getCharacteristic(ESP32_COLOR_UUID);
  }

  async test() {
    if (!this.isReady()) await this.connect();
    await this.send({ on: true, h: 210, s: 90, l: 55 });
    return true;
  }

  async send({ on, h, s, l }) {
    if (!this.isReady()) {
      if (this.device && this.device.gatt) await this._openGatt(); // reconnect after a drop
      else throw new Error('Not connected — click Connect first.');
    }
    const write = (data) => (this.colorCh.writeValueWithoutResponse
      ? this.colorCh.writeValueWithoutResponse(data)
      : this.colorCh.writeValue(data));
    if (!on) { await write(Uint8Array.of(0, 0, 0)); return; }
    const { r, g, b } = hslToRgb(h, s, l);
    await write(Uint8Array.of(r, g, b));
  }
}

// ---- Controller -----------------------------------------------------------

export class BulbController {
  constructor({
    swatchId = 'bulbSimSwatch',
    statusId = 'bulbStatus',
    storage,
    now,
    fetchImpl,
    transports,
  } = {}) {
    const hasWindow = typeof window !== 'undefined';
    const hasDoc = typeof document !== 'undefined';
    this.storage = storage !== undefined ? storage : (hasWindow ? window.localStorage : null);
    this.now = now || (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
    this.fetchImpl = fetchImpl !== undefined
      ? fetchImpl
      : (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.swatch = hasDoc ? document.getElementById(swatchId) : null;
    this.statusEl = hasDoc ? document.getElementById(statusId) : null;

    this.config = {
      enabled: false,
      transport: 'mock',
      hueBridge: '',
      hueUser: '',
      hueLightId: '1',
      webhookUrl: '',
      httpUrl: '',
      bleNamePrefix: '',    // generic-BLE: optional device-name filter
      bleServiceUuid: '',   // generic-BLE: optional service UUID override
      bleWriteUuid: '',     // generic-BLE: optional write-characteristic UUID override
      autoReconnect: true,  // BLE: silently re-link the saved device on reload
      bleDeviceId: '',      // BLE: id of the last-connected device (for auto-reconnect)
      throttleMs: DEFAULT_THROTTLE_MS,
    };
    this._loadConfig();

    // Smoothing + dispatch state
    this.cur = { h: 220, s: 50, l: 50 };
    this.target = { ...this.cur };
    this._lastSentColor = null;
    this._lastSendTs = -Infinity;
    this._failCount = 0;
    this._sending = false;
    this.onChange = null; // optional listener invoked when config changes

    this.transports = transports || {
      mock: new MockTransport(),
      hue: new HueTransport({ fetchImpl: this.fetchImpl, getConfig: () => this.config }),
      homeassistant: new HttpTransport({ fetchImpl: this.fetchImpl, getUrl: () => this.config.webhookUrl }),
      http: new HttpTransport({ fetchImpl: this.fetchImpl, getUrl: () => this.config.httpUrl }),
      webbluetooth: new WebBluetoothTransport(),
      genericble: new GenericBleTransport({ getConfig: () => this.config }),
      esp32: new Esp32BleTransport(),
    };
  }

  // ---- Config persistence ----
  _loadConfig() {
    if (!this.storage) return;
    for (const key of Object.keys(this.config)) {
      const raw = this.storage.getItem(STORAGE_PREFIX + key);
      if (raw === null || raw === undefined) continue;
      const cur = this.config[key];
      if (typeof cur === 'boolean') this.config[key] = raw === '1' || raw === 'true';
      else if (typeof cur === 'number') { const n = Number(raw); if (Number.isFinite(n)) this.config[key] = n; }
      else this.config[key] = raw;
    }
  }

  _saveConfig() {
    if (!this.storage) return;
    for (const key of Object.keys(this.config)) {
      const v = this.config[key];
      this.storage.setItem(STORAGE_PREFIX + key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
  }

  set(key, value) {
    if (!(key in this.config)) return;
    const cur = this.config[key];
    if (typeof cur === 'boolean') this.config[key] = value === true || value === 'true' || value === '1' || value === 1;
    else if (typeof cur === 'number') { const n = Number(value); if (Number.isFinite(n)) this.config[key] = n; }
    else this.config[key] = value;
    this._saveConfig();
    this._emitChange();
  }

  setEnabled(on) {
    this.config.enabled = !!on;
    this._failCount = 0;
    this._saveConfig();
    if (!on) this._clearMock();
    this._emitChange();
  }

  // Notify any listener (e.g. the settings UI) that config changed so it can
  // re-hydrate — important when the controller auto-disables itself.
  _emitChange() {
    if (typeof this.onChange === 'function') {
      try { this.onChange(this.config); } catch { /* listener errors shouldn't break the loop */ }
    }
  }

  // ---- Per-frame entry point ----
  // hue:0-360, sat:0-100, lit:0-100 (the ball's current HSL), dt in seconds.
  update(hue, sat, lit, dt = 0.016) {
    if (!this.config.enabled) return;

    this.target.h = hue;
    this.target.s = sat;
    this.target.l = lit;

    const k = clamp((dt || 0.016) * SMOOTH_PER_SEC, 0, 1);
    this.cur.h += (this.target.h - this.cur.h) * k;
    this.cur.s += (this.target.s - this.cur.s) * k;
    this.cur.l += (this.target.l - this.cur.l) * k;

    // Local simulated bulb updates every frame for smooth visual feedback.
    this._paintMock();

    // Real transports are throttled + change-gated so we never flood hardware.
    if (this.config.transport === 'mock') return;

    // Some transports (e.g. Bluetooth) need an explicit user-gesture connect
    // first. Bail before recording any "sent" bookkeeping, and without counting
    // a failure, so dispatch resumes cleanly once the user connects.
    const transport = this.transports[this.config.transport];
    if (transport && typeof transport.isReady === 'function' && !transport.isReady()) {
      this._setStatus('Click "Connect bulb" to pair over Bluetooth.', '');
      return;
    }

    const now = this.now();
    if (now - this._lastSendTs < this.config.throttleMs) return;
    if (!this._colorChangedEnough()) return;

    this._lastSendTs = now;
    this._lastSentColor = { ...this.cur };
    this._dispatch();
  }

  _colorChangedEnough() {
    const last = this._lastSentColor;
    if (!last) return true;
    return Math.abs(this.cur.h - last.h) > COLOR_DELTA_H
      || Math.abs(this.cur.s - last.s) > COLOR_DELTA_SL
      || Math.abs(this.cur.l - last.l) > COLOR_DELTA_SL;
  }

  async _dispatch() {
    if (this._sending) return;
    const transport = this.transports[this.config.transport];
    if (!transport) return;
    const color = { ...this.cur };
    this._sending = true;
    try {
      await transport.send({ on: true, h: color.h, s: color.s, l: color.l });
      this._failCount = 0;
      this._setStatus('Connected', 'ok');
    } catch (err) {
      this._failCount += 1;
      this._setStatus(`Error: ${err && err.message ? err.message : 'send failed'} (${this._failCount})`, 'err');
      if (this._failCount >= MAX_FAILURES) {
        this.setEnabled(false);
        this._setStatus('Auto-disabled after repeated failures', 'err');
      }
    } finally {
      this._sending = false;
    }
  }

  // ---- Manual connection test (from the Test button) ----
  async test() {
    const transport = this.transports[this.config.transport];
    if (!transport) { this._setStatus('No transport selected', 'err'); return false; }
    this._setStatus('Testing…', '');
    try {
      await transport.test();
      this._failCount = 0;
      this._setStatus('Test OK', 'ok');
      return true;
    } catch (err) {
      this._setStatus(`Test failed: ${err && err.message ? err.message : err}`, 'err');
      return false;
    }
  }

  // Pair a transport that needs an explicit connect step (Web Bluetooth).
  // MUST be called from a user gesture (e.g. a click handler).
  async connect() {
    const transport = this.transports[this.config.transport];
    if (!transport || typeof transport.connect !== 'function') {
      this._setStatus('This connection type needs no pairing step.', '');
      return false;
    }
    this._setStatus('Opening device picker…', '');
    try {
      await transport.connect();
      this._failCount = 0;
      this._rememberDevice(transport);
      this._setStatus('Bluetooth bulb connected.', 'ok');
      return true;
    } catch (err) {
      this._setStatus(`Connect failed: ${err && err.message ? err.message : err}`, 'err');
      return false;
    }
  }

  // Save the granted device id so we can silently re-link it next session.
  _rememberDevice(transport) {
    if (typeof transport.getDeviceId !== 'function') return;
    const id = transport.getDeviceId();
    if (id && id !== this.config.bleDeviceId) this.set('bleDeviceId', id);
  }

  // Clinic convenience: on load, re-link the previously-paired BLE device without
  // a picker click, so staff just open the app. No-op for non-BLE transports, when
  // disabled, or when the browser lacks getDevices() (falls back to manual Connect).
  async restore() {
    if (!this.config.enabled || !this.config.autoReconnect || !this.config.bleDeviceId) return false;
    const transport = this.transports[this.config.transport];
    if (!transport || typeof transport.reconnect !== 'function') return false;
    try {
      const ok = await transport.reconnect(this.config.bleDeviceId);
      if (ok) { this._failCount = 0; this._setStatus('Reconnected to saved bulb.', 'ok'); }
      return ok;
    } catch { return false; }
  }

  // Does the active transport require an explicit connect (for UI affordances)?
  needsConnect() {
    const transport = this.transports[this.config.transport];
    return !!(transport && typeof transport.connect === 'function');
  }

  // ---- DOM helpers (no-ops when headless) ----
  _paintMock() {
    if (!this.swatch) return;
    const h = this.cur.h.toFixed(0);
    const s = this.cur.s.toFixed(0);
    const l = this.cur.l.toFixed(0);
    this.swatch.style.background = `hsl(${h}, ${s}%, ${l}%)`;
    this.swatch.style.boxShadow = `0 0 24px 6px hsla(${h}, ${s}%, ${l}%, 0.85)`;
  }

  _clearMock() {
    if (!this.swatch) return;
    this.swatch.style.background = '';
    this.swatch.style.boxShadow = '';
  }

  _setStatus(text, kind) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.dataset.kind = kind || '';
  }
}
