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
    else if (typeof cur === 'number') this.config[key] = Number(value);
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
