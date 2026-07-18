import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeUrl, computeRawProsody, computeProsodyScore, pitchHzToPosition, correctOctaveError,
  computeFrameReliability, aPosterioriSnrDb, snrToConfidence, snrTier, adaptiveOverSubtraction,
  steadyStateWeight, selectResonanceMethod,
  SNR_GREEN_DB, SNR_YELLOW_DB, OVERSUB_MIN, OVERSUB_MAX, STEADY_WEIGHT_FLOOR
} from './dsp-utils.js';

test('sanitizeUrl handles safe and dangerous protocols correctly', () => {
  assert.equal(sanitizeUrl('https://example.com/foo'), 'https://example.com/foo');
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com/');

  // XSS Vectors
  assert.equal(sanitizeUrl('javascript:alert(1)'), 'about:blank');
  assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), 'about:blank');
  assert.equal(sanitizeUrl('vbscript:msgbox("hello")'), 'about:blank');

  // Safe relative/blob URLs
  assert.equal(sanitizeUrl('/relative/path').endsWith('/relative/path'), true);
  assert.equal(sanitizeUrl('blob:https://example.com/12345'), 'blob:https://example.com/12345');
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

// ---------- per-frame SNR / noise trust ----------

test('aPosterioriSnrDb is 0 dB when signal equals noise, +10 dB per 10x power', () => {
  assert.ok(Math.abs(aPosterioriSnrDb(1, 1)) < 1e-6);
  assert.ok(Math.abs(aPosterioriSnrDb(10, 1) - 10) < 1e-6);
  assert.ok(Math.abs(aPosterioriSnrDb(100, 1) - 20) < 1e-6);
});

test('aPosterioriSnrDb does not divide by zero on a silent noise estimate', () => {
  assert.ok(Number.isFinite(aPosterioriSnrDb(1, 0)));
});

test('snrToConfidence ramps red→green over the tier window', () => {
  assert.equal(snrToConfidence(SNR_YELLOW_DB), 0);            // red edge → no trust
  assert.equal(snrToConfidence(SNR_GREEN_DB), 1);             // green edge → full trust
  assert.equal(snrToConfidence(0), 0);                        // below red clamps to 0
  assert.equal(snrToConfidence(40), 1);                       // above green clamps to 1
  assert.ok(Math.abs(snrToConfidence(15) - 0.5) < 1e-9);      // midpoint
});

test('snrTier classifies green/yellow/red at the edges', () => {
  assert.equal(snrTier(25), 'green');
  assert.equal(snrTier(SNR_GREEN_DB), 'green');
  assert.equal(snrTier(15), 'yellow');
  assert.equal(snrTier(SNR_YELLOW_DB), 'yellow');
  assert.equal(snrTier(5), 'red');
});

test('adaptiveOverSubtraction is gentle in clean SNR and stronger when noisy', () => {
  assert.ok(Math.abs(adaptiveOverSubtraction(30) - OVERSUB_MIN) < 1e-9);  // clean → min
  assert.ok(Math.abs(adaptiveOverSubtraction(0) - OVERSUB_MAX) < 1e-9);   // noisy → max
  const mid = adaptiveOverSubtraction(15);
  assert.ok(mid > OVERSUB_MIN && mid < OVERSUB_MAX);                      // monotonic between
  // Never below the floor that historically worked well, even at the clean end.
  assert.ok(adaptiveOverSubtraction(50) >= OVERSUB_MIN);
});

test('computeFrameReliability is unchanged when snrConfidence is omitted (fixture contract)', () => {
  const inputs = { pitchConfidence: 0.9, formantConfidence: 0.8, voicedStrength: 0.85, spectralTiltConfidence: 0.8 };
  const withoutSnr = computeFrameReliability(inputs);
  const withFullSnr = computeFrameReliability({ ...inputs, snrConfidence: 1 });
  assert.equal(withoutSnr.confidenceGate, withFullSnr.confidenceGate);
  assert.equal(withoutSnr.voicedGate, withFullSnr.voicedGate);
});

test('computeFrameReliability lets low SNR pull confidence below the 0.2 floor', () => {
  const inputs = { pitchConfidence: 0.9, formantConfidence: 0.8, voicedStrength: 0.85, spectralTiltConfidence: 0.8 };
  const clean = computeFrameReliability({ ...inputs, snrConfidence: 1 });
  const noisy = computeFrameReliability({ ...inputs, snrConfidence: 0.1 });
  assert.ok(noisy.confidenceGate < clean.confidenceGate);
  assert.ok(noisy.confidenceGate < 0.2); // the old hard floor no longer hides noise
});

// ---------- steady-state weighting ----------

test('steadyStateWeight is 1 for a perfectly held vowel (no pitch or formant motion)', () => {
  assert.ok(Math.abs(steadyStateWeight({ pitchSemitoneDev: 0, formantRelDelta: 0 }) - 1) < 1e-9);
});

test('steadyStateWeight collapses to the floor on a full transition (either term saturates)', () => {
  // Pitch glide past tolerance alone is enough to floor it (terms multiply).
  assert.ok(Math.abs(steadyStateWeight({ pitchSemitoneDev: 5, formantRelDelta: 0 }) - STEADY_WEIGHT_FLOOR) < 1e-9);
  // Likewise a big formant jump alone.
  assert.ok(Math.abs(steadyStateWeight({ pitchSemitoneDev: 0, formantRelDelta: 1 }) - STEADY_WEIGHT_FLOOR) < 1e-9);
});

test('steadyStateWeight is monotonic: more motion → less weight, bounded to [floor,1]', () => {
  const held = steadyStateWeight({ pitchSemitoneDev: 0.2, formantRelDelta: 0.02 });
  const moving = steadyStateWeight({ pitchSemitoneDev: 0.9, formantRelDelta: 0.15 });
  assert.ok(held > moving);
  assert.ok(held <= 1 && moving >= STEADY_WEIGHT_FLOOR);
});

test('steadyStateWeight treats sign of deviation symmetrically', () => {
  const up = steadyStateWeight({ pitchSemitoneDev: 0.7, formantRelDelta: -0.1 });
  const down = steadyStateWeight({ pitchSemitoneDev: -0.7, formantRelDelta: 0.1 });
  assert.ok(Math.abs(up - down) < 1e-9);
});

// ---------- SNR-driven method selection ----------

test('selectResonanceMethod picks LPC clean, cepstral mid, centroid noisy', () => {
  assert.equal(selectResonanceMethod(30), 'lpc');               // well above green
  assert.equal(selectResonanceMethod(SNR_GREEN_DB), 'lpc');     // green edge inclusive
  assert.equal(selectResonanceMethod(15), 'cepstral');          // between the tiers
  assert.equal(selectResonanceMethod(SNR_YELLOW_DB), 'cepstral');// yellow edge inclusive
  assert.equal(selectResonanceMethod(5), 'centroid');           // below yellow
});
