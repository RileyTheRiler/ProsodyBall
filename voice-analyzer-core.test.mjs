import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp01,
  normalizeAgainstRange,
  normalizeAgainstPercentiles,
  computeFrameReliability
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
