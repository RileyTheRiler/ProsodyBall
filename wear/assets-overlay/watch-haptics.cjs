/*
 * Pure, dependency-free helpers for the ProsodyBall watch layer: the haptic
 * pattern vocabulary, intensity->amplitude mapping, confidence gating, and the
 * settings-merge logic. Kept in one small module so the logic is unit-testable
 * in Node (imported by watch-haptics.test.mjs) AND usable in the WebView as a
 * plain global `window.VoxWatch` (loaded as a classic <script> before
 * watch-boot.js — see MainActivity.injectWatchLayer).
 *
 * No DOM, no engine, no browser APIs are touched here on purpose.
 */
(function (global) {
  'use strict';

  // Directional haptic vocabulary. Each alert has a rich "practice" (private)
  // pattern whose rhythm encodes the correction direction, and a single short
  // "discreet" (public) tap. Arrays are navigator.vibrate-style [on, off, ...] ms.
  //   pitch_below  -> raise: short-short-LONG (ascending feel)
  //   pitch_above  -> lower: LONG-short-short (descending feel)
  //   resonance_below -> brighten: fast flutter (texture, not pitch)
  //   resonance_above -> darken: one long sustain
  var PATTERNS = {
    pitch_below:     { practice: [30, 40, 30, 40, 80], discreet: [35] },
    pitch_above:     { practice: [80, 40, 30, 40, 30], discreet: [35] },
    resonance_below: { practice: [20, 30, 20, 30, 20, 30, 20], discreet: [25] },
    resonance_above: { practice: [120], discreet: [40] },
    energy:          { practice: [60, 80, 60], discreet: [30] },
    generic:         { practice: [50, 50, 50], discreet: [30] }
  };

  // Per-mode/intensity amplitude (1..255) handed to navigator.vibrateAmp. Discreet
  // is always gentle regardless of the intensity setting — a privacy guarantee.
  var PRACTICE_AMP = { gentle: 90, medium: 160, strong: 230 };
  var DISCREET_AMP = 70;

  var DEFAULT_SETTINGS = {
    mode: 'discreet',          // 'discreet' (public) | 'practice' (private)
    intensity: 'gentle',       // gentle | medium | strong
    theme: 'aqua',             // aqua | violet | amber | mono
    brightness: 'auto',        // auto | dim | bright
    resonanceMethod: 'harmonic',
    tuning: { pitchConfMin: 0.4, resConfMin: 0.4, farMic: false },
    rules: [
      { metric: 'pitch',     direction: 'below', threshold: 150, enabled: true },
      { metric: 'pitch',     direction: 'above', threshold: 250, enabled: true },
      { metric: 'resonance', direction: 'below', threshold: 30,  enabled: true },
      { metric: 'resonance', direction: 'above', threshold: 70,  enabled: true }
    ],
    alertsEnabled: true
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Resolve the timing array for a metric+direction in the given mode, falling
  // back metric -> generic so an unknown metric still buzzes something sensible.
  function patternFor(metric, direction, mode) {
    var m = mode === 'practice' ? 'practice' : 'discreet';
    var entry = PATTERNS[metric + '_' + direction] || PATTERNS[metric] || PATTERNS.generic;
    return entry[m].slice();
  }

  // Amplitude for a buzz given the user's intensity level and the active mode.
  function intensityToAmp(level, mode) {
    if (mode !== 'practice') return DISCREET_AMP;
    var amp = PRACTICE_AMP[level] || PRACTICE_AMP.medium;
    return clamp(amp | 0, 1, 255);
  }

  // Confidence gate: only let a metric trip on a reliable, confidently-voiced
  // frame so the watch never buzzes on breath, room noise, or transient garbage.
  // `conf` carries the live analyzer fields; `tuning` carries the user's floors.
  function gatePasses(metric, conf, tuning) {
    if (!conf || !conf.reliable) return false;
    if (!(conf.energy > 0.05)) return false;           // must actually be speaking
    var t = tuning || DEFAULT_SETTINGS.tuning;
    if (metric === 'pitch') return conf.pitchConfidence >= t.pitchConfMin;
    if (metric === 'resonance') return conf.formantConfidence >= t.resConfMin;
    return conf.frameConfidence >= 0.3;                 // energy + everything else
  }

  // Shallow-with-nested merge of stored settings over the defaults. Tolerant of
  // partial/old payloads; `rules` is taken wholesale when present (it's an array).
  function mergeSettings(stored, defaults) {
    var base = defaults || DEFAULT_SETTINGS;
    var out = {
      mode: base.mode, intensity: base.intensity, theme: base.theme,
      brightness: base.brightness, resonanceMethod: base.resonanceMethod,
      tuning: { pitchConfMin: base.tuning.pitchConfMin, resConfMin: base.tuning.resConfMin, farMic: base.tuning.farMic },
      rules: base.rules.map(function (r) { return Object.assign({}, r); }),
      alertsEnabled: base.alertsEnabled
    };
    if (!stored || typeof stored !== 'object') return out;
    ['mode', 'intensity', 'theme', 'brightness', 'resonanceMethod', 'alertsEnabled'].forEach(function (k) {
      if (stored[k] !== undefined) out[k] = stored[k];
    });
    if (stored.tuning && typeof stored.tuning === 'object') {
      ['pitchConfMin', 'resConfMin', 'farMic'].forEach(function (k) {
        if (stored.tuning[k] !== undefined) out.tuning[k] = stored.tuning[k];
      });
    }
    if (Array.isArray(stored.rules) && stored.rules.length) {
      out.rules = stored.rules.map(function (r) { return Object.assign({}, r); });
    }
    return out;
  }

  var api = {
    PATTERNS: PATTERNS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    patternFor: patternFor,
    intensityToAmp: intensityToAmp,
    gatePasses: gatePasses,
    mergeSettings: mergeSettings
  };

  if (global) global.VoxWatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
