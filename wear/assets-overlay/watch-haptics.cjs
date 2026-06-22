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
    resonanceMethod: 'harmonic',       // how resonance is MEASURED: harmonic|cepstral|lpc|centroid
    pitchDisplayMode: 'hz',            // how pitch is REPRESENTED: hz|note|range
    resonanceDisplayMode: 'percent',   // how resonance is REPRESENTED: percent|formants
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

  // ---- live-readout value formatting (mirrors the desktop meter selectors) ----
  // The desktop app lets you choose how pitch and resonance are *represented* (Hz vs
  // Note, % vs raw formants) independently of how resonance is *measured*
  // (resonanceMethod). These pure formatters give the watch the same control.

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function hzToNote(hz) {
    if (!hz || !isFinite(hz) || hz <= 0) return '—';
    var midi = Math.round(69 + 12 * Math.log2(hz / 440));
    var name = NOTE_NAMES[((midi % 12) + 12) % 12];
    var octave = Math.floor(midi / 12) - 1;
    return name + octave;
  }

  // Format a live pitch value the way the user chose to represent it — mirroring the
  // desktop Pitch selector (Hz / Note / Range). 'range' shows semitones away from the
  // centre of the target band (refHz): the per-frame analog of the desktop's semitone
  // range, doubling as a "how far off, which way" cue for eyes-free practice.
  function formatPitch(hz, mode, refHz) {
    if (!hz || !isFinite(hz) || hz <= 0) return '—';
    if (mode === 'note') return hzToNote(hz);
    if (mode === 'range') {
      if (!refHz || refHz <= 0) return Math.round(hz) + ' Hz';
      var st = 12 * Math.log2(hz / refHz);
      return (st >= 0 ? '+' : '') + st.toFixed(1) + ' st';
    }
    return Math.round(hz) + ' Hz';
  }

  // Format a live resonance value: 'percent' (the 0–100 brightness score the alerts
  // act on) or 'formants' (raw F1/F2 Hz, the desktop HUD representation).
  function formatResonance(pct, f1, f2, mode) {
    if (mode === 'formants') {
      if (!f1 || !f2) return '—';
      return Math.round(f1) + '/' + Math.round(f2);
    }
    return Math.round(pct) + '%';
  }

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

  // Live-readout state for one metric, so the necklace screen can show that the
  // value is genuinely being measured (not just buzz or stay silent). `confOk` is
  // whether the metric is currently on a confidently-measured frame (same gate the
  // alert loop uses); when false the value is shown but flagged `weak` so the user
  // learns it won't trigger on low-confidence audio. Otherwise it reports whether
  // the value sits below the min rule (`low`), above the max rule (`high`), or in
  // range (`ok`) — the visual mirror of the directional haptics.
  function readoutMetric(value, confOk, loRule, hiRule) {
    if (!confOk) return { value: value, state: 'weak' };
    if (loRule && loRule.enabled && value < loRule.threshold) return { value: value, state: 'low' };
    if (hiRule && hiRule.enabled && value > hiRule.threshold) return { value: value, state: 'high' };
    return { value: value, state: 'ok' };
  }

  // Shallow-with-nested merge of stored settings over the defaults. Tolerant of
  // partial/old payloads; `rules` is taken wholesale when present (it's an array).
  function mergeSettings(stored, defaults) {
    var base = defaults || DEFAULT_SETTINGS;
    var out = {
      mode: base.mode, intensity: base.intensity, theme: base.theme,
      brightness: base.brightness, resonanceMethod: base.resonanceMethod,
      pitchDisplayMode: base.pitchDisplayMode, resonanceDisplayMode: base.resonanceDisplayMode,
      tuning: { pitchConfMin: base.tuning.pitchConfMin, resConfMin: base.tuning.resConfMin, farMic: base.tuning.farMic },
      rules: base.rules.map(function (r) { return Object.assign({}, r); }),
      alertsEnabled: base.alertsEnabled
    };
    if (!stored || typeof stored !== 'object') return out;
    ['mode', 'intensity', 'theme', 'brightness', 'resonanceMethod', 'pitchDisplayMode', 'resonanceDisplayMode', 'alertsEnabled'].forEach(function (k) {
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
    readoutMetric: readoutMetric,
    hzToNote: hzToNote,
    formatPitch: formatPitch,
    formatResonance: formatResonance,
    mergeSettings: mergeSettings
  };

  if (global) global.VoxWatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
