import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeUrl,
  computeRawProsody, computeProsodyScore, pitchHzToPosition, correctOctaveError,
  computeFrameReliability, aPosterioriSnrDb, snrToConfidence, snrTier, adaptiveOverSubtraction,
  steadyStateWeight, selectResonanceMethod, formantEstimateConfidence,
  SNR_GREEN_DB, SNR_YELLOW_DB, OVERSUB_MIN, OVERSUB_MAX, STEADY_WEIGHT_FLOOR
} from './dsp-utils.js';

test('sanitizeUrl protects against arbitrary protocols', (t) => {
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com');
  assert.equal(sanitizeUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(sanitizeUrl('javascript:alert(1)'), 'about:blank');
  assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), 'about:blank');
  assert.equal(sanitizeUrl('://invalid'), 'about:blank');

  // Safe relative paths should work based on our fallback dummy base URL
  assert.equal(sanitizeUrl('/relative/path'), '/relative/path');
  assert.equal(sanitizeUrl('?q=1'), '?q=1');
  assert.equal(sanitizeUrl('#hash'), '#hash');
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

test('selectResonanceMethod holds the incumbent until the SNR clears the edge by the margin', () => {
  // Without hysteresis the thresholds are exact equalities, so an SNR resting on a tier edge —
  // an ordinary room — reselects every frame. The estimators carry different biases, so each
  // flip steps the reported resonance while the speaker does nothing.
  const H = 2;
  // Sitting just above green: a running 'cepstral' is NOT promoted until greenDb + margin.
  assert.equal(selectResonanceMethod(20.5, { current: 'cepstral', hysteresisDb: H }), 'cepstral');
  assert.equal(selectResonanceMethod(22.0, { current: 'cepstral', hysteresisDb: H }), 'lpc');
  // Sitting just below green: a running 'lpc' is NOT demoted until greenDb - margin.
  assert.equal(selectResonanceMethod(19.5, { current: 'lpc', hysteresisDb: H }), 'lpc');
  assert.equal(selectResonanceMethod(18.0, { current: 'lpc', hysteresisDb: H }), 'cepstral');
  // Same at the yellow edge, in both directions.
  assert.equal(selectResonanceMethod(9.5, { current: 'cepstral', hysteresisDb: H }), 'cepstral');
  assert.equal(selectResonanceMethod(8.0, { current: 'cepstral', hysteresisDb: H }), 'centroid');
  assert.equal(selectResonanceMethod(10.5, { current: 'centroid', hysteresisDb: H }), 'centroid');
  assert.equal(selectResonanceMethod(12.0, { current: 'centroid', hysteresisDb: H }), 'cepstral');
  // An unknown incumbent (e.g. a manual 'harmonic' selection before switching to auto) must not
  // wedge the ladder — it falls through to the memoryless mapping.
  assert.equal(selectResonanceMethod(30, { current: 'harmonic', hysteresisDb: H }), 'lpc');
});

test('a dithering SNR selects once with hysteresis where it would flip every frame without', () => {
  // 21 frames oscillating across the green edge.
  const trace = Array.from({ length: 21 }, (_, i) => 20 + (i % 2 ? 0.4 : -0.4));
  const count = (useHysteresis) => {
    let cur = null, switches = 0;
    for (const snr of trace) {
      const next = selectResonanceMethod(snr, useHysteresis ? { current: cur } : {});
      if (cur !== null && next !== cur) switches++;
      cur = next;
    }
    return switches;
  };
  assert.ok(count(false) >= 10, `expected the memoryless ladder to chatter, got ${count(false)} switches`);
  assert.equal(count(true), 0, 'hysteresis should hold one estimator across the dither');
});

test('formantEstimateConfidence puts the four estimators on one scale', () => {
  // Same frame quality, different native structure scales: the gain is what makes them
  // comparable, and it is the only place that calibration lives.
  const frame = { pitchConfidence: 0.9, vowelLikelihood: 0.7 };
  const harmonic = formantEstimateConfidence({ ...frame, structure: 0.70, gain: 1.0 });
  const centroid = formantEstimateConfidence({ ...frame, structure: 0.23, gain: 3.0 });
  assert.ok(Math.abs(harmonic - centroid) < 0.05,
    `calibrated estimators should agree: harmonic=${harmonic} centroid=${centroid}`);
  // Bounded, and zero periodicity means zero confidence however much structure is claimed.
  assert.equal(formantEstimateConfidence({ structure: 5, gain: 5, pitchConfidence: 1, vowelLikelihood: 1 }), 1);
  assert.equal(formantEstimateConfidence({ structure: 1, gain: 1, pitchConfidence: 0, vowelLikelihood: 1 }), 0);
  assert.equal(formantEstimateConfidence({ structure: 0, gain: 1, pitchConfidence: 1, vowelLikelihood: 1 }), 0);
  // Monotonic in structure.
  const lo = formantEstimateConfidence({ ...frame, structure: 0.2, gain: 1 });
  const hi = formantEstimateConfidence({ ...frame, structure: 0.6, gain: 1 });
  assert.ok(hi > lo);
});

test('selectResonanceMethod picks LPC clean, cepstral mid, centroid noisy', () => {
  assert.equal(selectResonanceMethod(30), 'lpc');               // well above green
  assert.equal(selectResonanceMethod(SNR_GREEN_DB), 'lpc');     // green edge inclusive
  assert.equal(selectResonanceMethod(15), 'cepstral');          // between the tiers
  assert.equal(selectResonanceMethod(SNR_YELLOW_DB), 'cepstral');// yellow edge inclusive
  assert.equal(selectResonanceMethod(5), 'centroid');           // below yellow
});
