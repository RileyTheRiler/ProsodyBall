// Unit tests for the watch haptic/gate/settings helpers (wear/assets-overlay/watch-haptics.cjs).
// These cover the pure logic the Wear OS overlay relies on: directional pattern
// selection, discreet-mode collapse, intensity->amplitude clamping, confidence
// gating, and settings merge. DOM/engine wiring in watch-boot.js is verified manually.
import test from 'node:test';
import assert from 'node:assert/strict';
import VW from './wear/assets-overlay/watch-haptics.cjs';

test('patternFor returns distinct contours for pitch directions in practice', () => {
  const below = VW.patternFor('pitch', 'below', 'practice');
  const above = VW.patternFor('pitch', 'above', 'practice');
  assert.deepEqual(below, [30, 40, 30, 40, 80]); // rising: short-short-LONG
  assert.deepEqual(above, [80, 40, 30, 40, 30]); // falling: LONG-short-short
  assert.notDeepEqual(below, above);
});

test('patternFor resonance feels categorically different from pitch', () => {
  const resFlutter = VW.patternFor('resonance', 'below', 'practice'); // signals "brighten"
  const resSustain = VW.patternFor('resonance', 'above', 'practice'); // signals "darken"
  assert.deepEqual(resSustain, [120]);             // one long sustain
  assert.ok(resFlutter.length > 3);                // fast flutter
  assert.notDeepEqual(resFlutter, resSustain);
});

test('discreet mode collapses every alert to a single short tap', () => {
  for (const [metric, dir] of [['pitch', 'below'], ['pitch', 'above'], ['resonance', 'below'], ['resonance', 'above']]) {
    const p = VW.patternFor(metric, dir, 'discreet');
    assert.equal(p.length, 1, `${metric}_${dir} should be a single pulse in discreet`);
    assert.ok(p[0] <= 40, 'discreet pulse should be short');
  }
});

test('patternFor falls back metric -> generic for unknown alerts', () => {
  assert.deepEqual(VW.patternFor('tempo', 'above', 'practice'), VW.PATTERNS.generic.practice);
  assert.deepEqual(VW.patternFor('nonsense', 'below', 'discreet'), VW.PATTERNS.generic.discreet);
});

test('patternFor returns a copy, not the shared array', () => {
  const a = VW.patternFor('pitch', 'below', 'practice');
  a[0] = 999;
  assert.equal(VW.PATTERNS.pitch_below.practice[0], 30, 'mutation must not leak into the table');
});

test('intensityToAmp: discreet is always gentle regardless of level', () => {
  assert.equal(VW.intensityToAmp('strong', 'discreet'), VW.intensityToAmp('gentle', 'discreet'));
});

test('intensityToAmp: practice scales with level and clamps to 1..255', () => {
  assert.ok(VW.intensityToAmp('gentle', 'practice') < VW.intensityToAmp('strong', 'practice'));
  for (const lvl of ['gentle', 'medium', 'strong', 'bogus']) {
    const amp = VW.intensityToAmp(lvl, 'practice');
    assert.ok(amp >= 1 && amp <= 255, `${lvl} amplitude in range`);
  }
});

const baseConf = { reliable: true, pitchConfidence: 0.9, formantConfidence: 0.9, frameConfidence: 0.9, energy: 0.3 };
const tuning = { pitchConfMin: 0.4, resConfMin: 0.4, farMic: false };

test('gatePasses requires a reliable, speaking frame', () => {
  assert.equal(VW.gatePasses('pitch', baseConf, tuning), true);
  assert.equal(VW.gatePasses('pitch', { ...baseConf, reliable: false }, tuning), false);
  assert.equal(VW.gatePasses('pitch', { ...baseConf, energy: 0.01 }, tuning), false);
});

test('gatePasses uses metric-specific confidence floors', () => {
  assert.equal(VW.gatePasses('pitch', { ...baseConf, pitchConfidence: 0.3 }, tuning), false);
  assert.equal(VW.gatePasses('resonance', { ...baseConf, formantConfidence: 0.3 }, tuning), false);
  assert.equal(VW.gatePasses('resonance', { ...baseConf, formantConfidence: 0.5 }, tuning), true);
  // energy/other metrics gate on overall frame confidence
  assert.equal(VW.gatePasses('energy', { ...baseConf, frameConfidence: 0.2 }, tuning), false);
  assert.equal(VW.gatePasses('energy', { ...baseConf, frameConfidence: 0.4 }, tuning), true);
});

test('mergeSettings fills defaults and accepts partial overrides', () => {
  const merged = VW.mergeSettings({ mode: 'practice', tuning: { pitchConfMin: 0.6 } }, VW.DEFAULT_SETTINGS);
  assert.equal(merged.mode, 'practice');
  assert.equal(merged.intensity, VW.DEFAULT_SETTINGS.intensity); // untouched default
  assert.equal(merged.tuning.pitchConfMin, 0.6);                 // overridden
  assert.equal(merged.tuning.resConfMin, VW.DEFAULT_SETTINGS.tuning.resConfMin); // default kept
  assert.equal(merged.rules.length, VW.DEFAULT_SETTINGS.rules.length);
});

test('mergeSettings is null-tolerant and deep-copies rules', () => {
  const merged = VW.mergeSettings(null, VW.DEFAULT_SETTINGS);
  merged.rules[0].threshold = 999;
  assert.equal(VW.DEFAULT_SETTINGS.rules[0].threshold, 150, 'defaults must not be mutated');
});
