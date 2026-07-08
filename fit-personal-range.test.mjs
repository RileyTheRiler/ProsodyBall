import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPersonalRange, normalizeAgainstRange } from './dsp-utils.js';

test('fitPersonalRange: empty / all-invalid input returns null', () => {
  assert.equal(fitPersonalRange([]), null);
  assert.equal(fitPersonalRange(null), null);
  assert.equal(fitPersonalRange([NaN, Infinity, -Infinity]), null);
});

test('fitPersonalRange: pads the observed p05–p95 band outward by pad×spread', () => {
  // 0..100 inclusive: p05≈5, p95≈95, spread≈90, pad 0.25 → min≈5-22.5, max≈95+22.5.
  const vals = Array.from({ length: 101 }, (_, i) => i);
  const r = fitPersonalRange(vals, {});
  const lo = vals[Math.floor(101 * 0.05)]; // 5
  const hi = vals[Math.floor(101 * 0.95)]; // 95
  const spread = hi - lo;
  assert.ok(Math.abs(r.min - (lo - spread * 0.25)) < 1e-9);
  assert.ok(Math.abs(r.max - (hi + spread * 0.25)) < 1e-9);
});

test('fitPersonalRange: natural range lands in the middle of the meter, ends have headroom', () => {
  // The whole point of the padding: p05 should map to ~0.17 and p95 to ~0.83, so the user
  // can still travel toward 0 and 1 by pushing past their setup voice.
  const vals = Array.from({ length: 101 }, (_, i) => 200 + i); // 200..300
  const r = fitPersonalRange(vals, {});
  const p05 = 200 + Math.floor(101 * 0.05);
  const p95 = 200 + Math.floor(101 * 0.95);
  const loPos = normalizeAgainstRange(p05, r.min, r.max);
  const hiPos = normalizeAgainstRange(p95, r.min, r.max);
  assert.ok(loPos > 0.1 && loPos < 0.25, `p05 maps to ${loPos}, expected ~0.17`);
  assert.ok(hiPos > 0.75 && hiPos < 0.9, `p95 maps to ${hiPos}, expected ~0.83`);
});

test('fitPersonalRange: floorSpread prevents a monotone speaker collapsing the scale', () => {
  // Everyone spoke at ~exactly 500 Hz — without a floor the range would be a single point.
  const vals = new Array(50).fill(500);
  const r = fitPersonalRange(vals, { floorSpread: 300 });
  // spread forced to 300, pad 0.25 each side → total width 300*1.5 = 450 centered on 500.
  assert.ok(Math.abs((r.max - r.min) - 450) < 1e-6, `width ${r.max - r.min}`);
  assert.ok(r.min < 500 && r.max > 500);
});

test('fitPersonalRange: clamps to absMin / absMax', () => {
  const vals = Array.from({ length: 101 }, (_, i) => i * 40); // 0..4000, wide spread
  const r = fitPersonalRange(vals, { absMin: 700, absMax: 3200 });
  assert.ok(r.min >= 700);
  assert.ok(r.max <= 3200);
});

test('fitPersonalRange: robust to outliers — a single wild sample does not set the end', () => {
  const vals = [...new Array(99).fill(0).map((_, i) => 400 + i), 9000]; // one 9 kHz octave-jump
  const r = fitPersonalRange(vals, { absMax: 3200 });
  // p95 of 100 sorted values ignores the lone outlier at the top.
  assert.ok(r.max < 700, `max ${r.max} should ignore the 9 kHz outlier`);
});

test('fitPersonalRange: custom percentiles widen the band', () => {
  const vals = Array.from({ length: 100 }, (_, i) => i);
  const tight = fitPersonalRange(vals, { loPct: 0.25, hiPct: 0.75 });
  const wide = fitPersonalRange(vals, { loPct: 0.05, hiPct: 0.95 });
  assert.ok(wide.max - wide.min > tight.max - tight.min);
});
