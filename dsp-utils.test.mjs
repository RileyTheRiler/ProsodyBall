import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRawProsody, computeProsodyScore, pitchHzToPosition, correctOctaveError, sanitizeUrl } from './dsp-utils.js';

test('sanitizeUrl allows safe URLs and blob protocols', () => {
  assert.equal(sanitizeUrl('https://example.com'), 'https://example.com');
  assert.equal(sanitizeUrl('blob:http://localhost/1234'), 'blob:http://localhost/1234');
  assert.equal(sanitizeUrl('/path/to/file'), '/path/to/file');
});

test('sanitizeUrl blocks dangerous protocols', () => {
  assert.equal(sanitizeUrl('javascript:alert(1)'), 'about:blank');
  assert.equal(sanitizeUrl('  javascript:alert(1)'), 'about:blank');
  assert.equal(sanitizeUrl('data:text/html,<html>'), 'about:blank');
  assert.equal(sanitizeUrl('vbscript:msgbox(1)'), 'about:blank');
});

test('sanitizeUrl handles empty or null inputs', () => {
  assert.equal(sanitizeUrl(null), 'about:blank');
  assert.equal(sanitizeUrl(undefined), 'about:blank');
  assert.equal(sanitizeUrl(''), 'about:blank');
});

test('computeRawProsody applies weighted sum', () => {
  const metrics = { bounce: 1, vowel: 0.5, articulation: 0.5 };
  const got = computeRawProsody(metrics);
  assert.equal(got, 0.50 + 0.15 + 0.10);
});

test('computeProsodyScore smooths toward target', () => {
  const metrics = { bounce: 1, vowel: 0, articulation: 0 };
  const score = computeProsodyScore(0, metrics, 0.2);
  assert.ok(Math.abs(score - 0.10) < 1e-9);
});

test('pitchHzToPosition clamps to [0,1]', () => {
  assert.equal(pitchHzToPosition(80), 0);
  assert.equal(pitchHzToPosition(300), 1);
  assert.equal(pitchHzToPosition(190), 0.5);
  assert.equal(pitchHzToPosition(30), 0);
  assert.equal(pitchHzToPosition(500), 1);
});

// ---------- YIN octave-up correction ----------
// CMND is indexed by period (tau). Build one with explicit dips; everything else is a
// non-periodic 0.9, and cmnd[0] = 1.0 by YIN convention.
function makeCmnd(len, dips) {
  const c = new Float32Array(len).fill(0.9);
  c[0] = 1.0;
  for (const [i, v] of Object.entries(dips)) c[Number(i)] = v;
  return c;
}

test('correctOctaveError recovers the fundamental when YIN latched onto the 2x harmonic', () => {
  // bestTau=50 is the harmonic YIN picked (dip 0.12); the true period at tau=100 is a deeper dip
  // the greedy first-below-threshold scan skipped because it is longer. Recover 100.
  const cmnd = makeCmnd(201, { 50: 0.12, 100: 0.06 });
  assert.equal(correctOctaveError(cmnd, 50, { maxPeriod: 200 }), 100);
});

test('correctOctaveError leaves a confident (deep) dip alone — no octave-down', () => {
  // A very deep dip (<0.05) at bestTau is confidently the fundamental; a sub-harmonic dip at
  // 2x must NOT pull it an octave down.
  const cmnd = makeCmnd(201, { 100: 0.03, 200: 0.04 });
  assert.equal(correctOctaveError(cmnd, 100, { maxPeriod: 200 }), 100);
});

test('correctOctaveError ignores a clearly shallower longer-period dip', () => {
  // tau=200 is below the relaxed gate (0.35) but much shallower than the chosen dip, so it is a
  // sub-harmonic, not the fundamental — keep bestTau.
  const cmnd = makeCmnd(201, { 100: 0.08, 200: 0.30 });
  assert.equal(correctOctaveError(cmnd, 100, { maxPeriod: 200 }), 100);
});

test('correctOctaveError is safe on invalid input', () => {
  assert.equal(correctOctaveError(null, 50, { maxPeriod: 100 }), 50);
  assert.equal(correctOctaveError(makeCmnd(10, {}), 0, { maxPeriod: 5 }), 0);
});
