import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeFromExtremeSamples, normalizeAgainstRange } from './dsp-utils.js';

test('rangeFromExtremeSamples: empty set returns null', () => {
  assert.equal(rangeFromExtremeSamples([], [500]), null);
  assert.equal(rangeFromExtremeSamples([300], []), null);
  assert.equal(rangeFromExtremeSamples([NaN], [Infinity]), null);
});

test('rangeFromExtremeSamples: medians become the range ends (with slight padding)', () => {
  // dark median 400, bright median 700 → spread 300, pad 5% each side.
  const r = rangeFromExtremeSamples([390, 400, 410], [690, 700, 710], {});
  assert.ok(Math.abs(r.min - (400 - 300 * 0.05)) < 1e-9, `min ${r.min}`);
  assert.ok(Math.abs(r.max - (700 + 300 * 0.05)) < 1e-9, `max ${r.max}`);
  // The extremes the user produced map very close to 0 and 1.
  assert.ok(normalizeAgainstRange(400, r.min, r.max) < 0.06);
  assert.ok(normalizeAgainstRange(700, r.min, r.max) > 0.94);
});

test('rangeFromExtremeSamples: swap-guard when the "dark" sound read brighter', () => {
  // User's dark set is actually higher than the bright set (estimator quirk) — still ordered.
  const r = rangeFromExtremeSamples([800], [500], {});
  assert.ok(r.min < r.max);
  assert.ok(r.min <= 500 && r.max >= 800); // ends bracket the two extremes regardless of order
});

test('rangeFromExtremeSamples: minSpread prevents a too-narrow range', () => {
  // Dark and bright almost identical — floor the usable width.
  const r = rangeFromExtremeSamples([500], [510], { minSpread: 200 });
  // spread forced to 200, pad 5% each side → width 200 * 1.1 = 220 centered on 505.
  assert.ok(Math.abs((r.max - r.min) - 220) < 1e-6, `width ${r.max - r.min}`);
});

test('rangeFromExtremeSamples: clamps to absMin/absMax', () => {
  const r = rangeFromExtremeSamples([100], [5000], { absMin: 600, absMax: 1800 });
  assert.ok(r.min >= 600);
  assert.ok(r.max <= 1800);
});

test('rangeFromExtremeSamples: even-length sets average the two middle values', () => {
  const r = rangeFromExtremeSamples([400, 420], [700, 720], { pad: 0, minSpread: 0 });
  assert.equal(r.min, 410); // median of [400,420]
  assert.equal(r.max, 710); // median of [700,720]
});
