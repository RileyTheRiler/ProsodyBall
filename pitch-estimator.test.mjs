import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePitchYin } from './pitch-estimator.js';

function sine(frequency, sampleRate = 48000, length = 4096) {
  return Float32Array.from({ length }, (_, index) => Math.sin(2 * Math.PI * frequency * index / sampleRate));
}

for (const frequency of [90, 160, 260, 420]) {
  test(`estimates a ${frequency} Hz tone`, () => {
    const result = estimatePitchYin(sine(frequency), { sampleRate: 48000, minHz: 40, maxHz: 600 });
    assert.ok(Math.abs(result.hz - frequency) < 3, `${result.hz} should be near ${frequency}`);
    assert.ok(result.confidence > 0.8);
  });
}

test('rejects invalid input', () => {
  assert.deepEqual(estimatePitchYin(null, { sampleRate: 48000 }), { hz: 0, confidence: 0 });
});
