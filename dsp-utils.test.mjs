import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRawProsody, computeProsodyScore, pitchHzToPosition } from './dsp-utils.js';

test('computeRawProsody applies weighted sum', () => {
  const metrics = { bounce: 1, tempo: 0.5, vowel: 0.5, articulation: 0.5, syllable: 0.5 };
  const got = computeRawProsody(metrics);
  assert.equal(got, 0.35 + 0.1 + 0.1 + 0.075 + 0.05);
});

test('computeProsodyScore smooths toward target', () => {
  const metrics = { bounce: 1, tempo: 0, vowel: 0, articulation: 0, syllable: 0 };
  const score = computeProsodyScore(0, metrics, 0.2);
  assert.ok(Math.abs(score - 0.07) < 1e-9);
});

test('pitchHzToPosition clamps to [0,1]', () => {
  assert.equal(pitchHzToPosition(80), 0);
  assert.equal(pitchHzToPosition(300), 1);
  assert.equal(pitchHzToPosition(190), 0.5);
  assert.equal(pitchHzToPosition(30), 0);
  assert.equal(pitchHzToPosition(500), 1);
});
