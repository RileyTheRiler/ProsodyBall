import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp01,
  normalizeAgainstRange,
  normalizeAgainstPercentiles,
  computeFrameReliability,
  computeWeightTarget,
  computeAttackHardness
} from './voice-analyzer-core.js';

test('clamp01 clamps values', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.25), 0.25);
  assert.equal(clamp01(5), 1);
});

test('normalizeAgainstRange is bounded and monotonic', () => {
  assert.equal(normalizeAgainstRange(5, 0, 10), 0.5);
  assert.equal(normalizeAgainstRange(-10, 0, 10), 0);
  assert.equal(normalizeAgainstRange(100, 0, 10), 1);
});

test('normalizeAgainstPercentiles maps p50-p90 spread', () => {
  assert.equal(normalizeAgainstPercentiles(0.2, 0.2, 0.6), 0);
  assert.equal(normalizeAgainstPercentiles(0.6, 0.2, 0.6), 1);
  assert.ok(normalizeAgainstPercentiles(0.4, 0.2, 0.6) > 0.49);
});

test('computeFrameReliability lowers confidence on weak signal', () => {
  const weak = computeFrameReliability({ pitchConfidence: 0.1, formantConfidence: 0.1, voicedStrength: 0.1, spectralTiltConfidence: 0.1 });
  const strong = computeFrameReliability({ pitchConfidence: 0.9, formantConfidence: 0.7, voicedStrength: 0.8, spectralTiltConfidence: 0.8 });

  assert.equal(weak.reliableFrame, false);
  assert.equal(strong.reliableFrame, true);
  assert.ok(strong.confidenceGate > weak.confidenceGate);
  assert.ok(strong.voicedGate > weak.voicedGate);
});

test('computeWeightTarget falls back to spectral tilt alone when other cues are absent', () => {
  // No H1-H2 or F2 weight → result is exactly the tilt heaviness.
  assert.equal(computeWeightTarget({ tiltHeaviness: 0.8, tiltWeight: 0.55 }), 0.8);
  assert.equal(computeWeightTarget({ tiltHeaviness: 0.2, tiltWeight: 0.55 }), 0.2);
});

test('computeWeightTarget reads pressed/heavy vs breathy/light voices in the right direction', () => {
  // Pressed/heavy: dark tilt + low H1-H2 (heavy) + low F2 (dark).
  const heavy = computeWeightTarget({
    tiltHeaviness: 0.85, tiltWeight: 0.55,
    h1h2Heaviness: 0.9, h1h2Weight: 0.30,
    f2Heaviness: 0.8, f2Weight: 0.15
  });
  // Breathy/light: bright tilt + high H1-H2 (light) + high F2 (bright).
  const light = computeWeightTarget({
    tiltHeaviness: 0.15, tiltWeight: 0.55,
    h1h2Heaviness: 0.1, h1h2Weight: 0.30,
    f2Heaviness: 0.2, f2Weight: 0.15
  });
  assert.ok(heavy > 0.7, `expected heavy > 0.7, got ${heavy}`);
  assert.ok(light < 0.3, `expected light < 0.3, got ${light}`);
  assert.ok(heavy > light);
});

test('computeWeightTarget: the H1-H2 breathiness cue nudges weight when blended in', () => {
  const base = { tiltHeaviness: 0.5, tiltWeight: 0.55, f2Weight: 0 };
  const withHeavyH1H2 = computeWeightTarget({ ...base, h1h2Heaviness: 1, h1h2Weight: 0.30 });
  const withLightH1H2 = computeWeightTarget({ ...base, h1h2Heaviness: 0, h1h2Weight: 0.30 });
  assert.ok(withHeavyH1H2 > 0.5, 'pressed H1-H2 should pull weight heavier');
  assert.ok(withLightH1H2 < 0.5, 'breathy H1-H2 should pull weight lighter');
  // Output stays within [0,1].
  for (const v of [withHeavyH1H2, withLightH1H2]) assert.ok(v >= 0 && v <= 1);
});

test('computeAttackHardness separates a hard onset from a soft onset', () => {
  // Hard/glottal: peak rise at/above the ceiling, peaks immediately, clean voiced core.
  const hard = computeAttackHardness({
    risePeak: 0.6, riseCeiling: 0.5, cleanliness: 1, onsetAbruptness: 1, abruptWeight: 0.3
  });
  // Soft/breathy: small slow rise, peaks late, poor pitch lock.
  const soft = computeAttackHardness({
    risePeak: 0.05, riseCeiling: 0.5, cleanliness: 0.4, onsetAbruptness: 0, abruptWeight: 0.3
  });
  assert.ok(hard > 0.8, `expected hard > 0.8, got ${hard}`);
  assert.ok(soft < 0.2, `expected soft < 0.2, got ${soft}`);
});

test('computeAttackHardness: abruptness raises and breathiness lowers hardness', () => {
  const mid = { risePeak: 0.25, riseCeiling: 0.5, cleanliness: 1 }; // riseHardness = 0.5
  const abrupt = computeAttackHardness({ ...mid, onsetAbruptness: 1, abruptWeight: 0.3 });
  const gradual = computeAttackHardness({ ...mid, onsetAbruptness: 0, abruptWeight: 0.3 });
  assert.ok(abrupt > gradual, 'an earlier rise peak should read harder');

  const clean = computeAttackHardness({ risePeak: 0.6, riseCeiling: 0.5, cleanliness: 1 });
  const breathy = computeAttackHardness({ risePeak: 0.6, riseCeiling: 0.5, cleanliness: 0 });
  assert.ok(clean > breathy, 'a breathy onset should read softer');
  assert.ok(breathy >= 0 && clean <= 1);
});
