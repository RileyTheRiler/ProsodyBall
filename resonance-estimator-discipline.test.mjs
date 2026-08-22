// Phase 3 — estimator discipline. docs/RESONANCE_REDESIGN.md §5.
//
// What this pins, in one line each:
//   - the canonical value does not depend on which estimator the room's noise selected;
//   - the refactored LPC is byte-identical to the pre-Phase-3 arithmetic at the default ceiling,
//     which is what lets v1 stay frozen while the canonical path moves to a chosen one;
//   - the validity gates reject what they claim to and admit what they claim to;
//   - F0 raises the measurement noise and nothing else;
//   - below the floor the app produces NO reading rather than a stale or substituted one.
//
// The pure functions are tested as pure functions. The numbers that require driving the whole
// analyzer live in tools/ — estimator-discipline.mjs, frame-validity.mjs, lpc-ceiling.mjs,
// rho-rhotic.mjs — because they take minutes, not milliseconds, and because a report that has
// to be READ is not the same artefact as a test that has to PASS.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MockAudioContext } from './tools/run-eval-harness.mjs';
import { synthVowel } from './tools/synth-vowel.mjs';
import {
  frameValidity, formantMeasurementNoise, crossEstimatorAgreement, resonanceConfidence,
  spectralBrightness, windowHomogeneity, rhoticFromRho, scoreLpcCeiling, selectLpcCeiling,
  fitFormantScale, residualScaleFactor, formantPatternResiduals,
  FORMANT_MAX_STEP_HZ_PER_SEC, FORMANT_MAX_BW_FLOOR_HZ, LPC_MAX_RESIDUAL,
  LPC_DEFAULT_CEILING_HZ, LPC_CEILING_CANDIDATES_HZ, RESONANCE_CONFIDENCE_FLOOR,
  FORMANT_NOISE_F0_REF_HZ, VOWEL_POOLED_RHO, RHOTIC_RHO_THRESHOLD, ESTIMATOR_DELTA_F_BIAS,
} from './dsp-utils.js';

const { VoiceAnalyzer } = await import('./app.js');

const SAMPLE_RATE = 44100;
const WINDOW = 4096;
const HOP = Math.round(SAMPLE_RATE / 60);
const DT = HOP / SAMPLE_RATE;
const BASE_FORMANTS = [570, 1710, 2850];

async function newAnalyzer(method = 'lpc') {
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = SAMPLE_RATE;
  a.isCalibrated = true;
  a.noiseFloor = 0.005;
  a.hfNoiseFloor = 0.001;
  a.micTiltBaselineDb = 0;
  a.resonanceMethod = method;
  return a;
}

// ---------------------------------------------------------------------------
// The headline: estimator identity no longer reaches the canonical value.
// ---------------------------------------------------------------------------

test('§5: the canonical value is IDENTICAL under every estimator setting', async () => {
  // Not "close". Identical. §3.4's whole argument is that the four estimators carry systematic
  // bias, not just noise, and that the `auto` ladder swaps between three of them mid-session on
  // room noise — so any dependence at all is a step in the reported number that the speaker did
  // not cause. The canonical path has no branch for the estimator identity to take, and this is
  // the assertion that catches a future change routing part of it back through one.
  const signal = synthVowel({ formants: BASE_FORMANTS });
  const results = {};
  for (const method of ['lpc', 'cepstral', 'harmonic', 'centroid']) {
    const a = await newAnalyzer(method);
    const vals = [];
    for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
      a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
      a.update(DT);
      if (!a.resonanceSuppressed) vals.push(a.resonanceAbsoluteV2);
    }
    assert.ok(vals.length > 20, `${method}: only ${vals.length} unsuppressed frames`);
    results[method] = vals;
  }
  const ref = results.lpc;
  for (const [method, vals] of Object.entries(results)) {
    assert.equal(vals.length, ref.length, `${method}: different frame count from lpc`);
    for (let i = 0; i < ref.length; i++) {
      assert.equal(vals[i], ref[i],
        `${method} frame ${i}: ${vals[i]} vs lpc ${ref[i]} — the estimator reached the canonical value`);
    }
  }
});

test('§5: v1 still moves with the estimator, and that is the rule, not a miss', async () => {
  // v1 is the DISPLAYED metric and its output must stay byte-identical until Phase 4 retires it.
  // Its between-method spread is therefore unchanged by design. Asserting that it still varies
  // is the other half of the test above: if this ever went to zero, something had changed v1.
  const signal = synthVowel({ formants: BASE_FORMANTS });
  const scores = [];
  for (const method of ['lpc', 'harmonic']) {
    const a = await newAnalyzer(method);
    const vals = [];
    for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
      a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
      a.update(DT);
      if (a.formantConfidence > 0.2) vals.push(a.smoothResonance);
    }
    const back = vals.slice(Math.floor(vals.length / 2));
    scores.push(back.reduce((s, x) => s + x, 0) / back.length);
  }
  assert.ok(Math.abs(scores[0] - scores[1]) > 0.05,
    `v1 spread between lpc and harmonic is ${Math.abs(scores[0] - scores[1]).toFixed(4)} — `
    + 'v1 was expected to be untouched by Phase 3');
});

// ---------------------------------------------------------------------------
// The refactor that makes the above possible without moving v1.
// ---------------------------------------------------------------------------

test('the parameterised ceiling is byte-identical to the old decimation at the default', async () => {
  // 5512.5 Hz is 44100/4/2, so the resampler's targets land exactly on the samples the old
  // decimation loop took (including its offset of dsFactor−1), the anti-alias cutoff
  // 0.9·ceiling is the old 0.45·dsRate, and the order rule is unchanged. That identity is the
  // whole reason a per-user ceiling can exist without disturbing the displayed metric.
  assert.equal(LPC_DEFAULT_CEILING_HZ, 44100 / 4 / 2);
  const a = await newAnalyzer('lpc');
  const signal = synthVowel({ formants: BASE_FORMANTS });
  a.audioCtx._currentChunk = signal.subarray(0, WINDOW);
  a.update(DT);
  a.timeDomainData = signal.subarray(WINDOW, 2 * WINDOW);
  const explicit = a._resonanceLPC({ ceilingHz: LPC_DEFAULT_CEILING_HZ });
  const implicit = a._resonanceLPC();
  for (const k of ['f1', 'f2', 'f3', 'f4', 'confidence', 'modelResidual']) {
    assert.equal(explicit[k], implicit[k], `${k} differs between explicit and default ceiling`);
  }
});

test('a different ceiling actually changes the analysis', async () => {
  // The converse of the test above: if every ceiling gave the same answer, the search would be
  // choosing between identical options and the whole feature would be theatre.
  const a = await newAnalyzer('lpc');
  const signal = synthVowel({ formants: [...BASE_FORMANTS, 3990] });
  a.audioCtx._currentChunk = signal.subarray(0, WINDOW);
  a.update(DT);
  a.timeDomainData = signal.subarray(WINDOW, 2 * WINDOW);
  const low = a._resonanceLPC({ ceilingHz: 4500 });
  const high = a._resonanceLPC({ ceilingHz: 6500 });
  assert.notEqual(low.f3, high.f3, 'F3 identical at 4500 and 6500 Hz ceilings');
});

test('the LPC solve is shared, so the common case costs what it always did', async () => {
  // §3.4: three LPC solves per frame at 60 fps is not affordable. An uncalibrated user on `lpc`
  // — every user today, every fixture, every golden test — must pay for exactly one, because
  // v1's branch and the canonical path want the same ceiling and share the solve.
  const a = await newAnalyzer('lpc');
  const signal = synthVowel({ formants: BASE_FORMANTS });
  let frames = 0;
  for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
    a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
    a.update(DT);
    frames++;
  }
  assert.ok(a._lpcSolveCount <= frames,
    `${a._lpcSolveCount} LPC solves over ${frames} frames — the cache is not sharing`);
});

// ---------------------------------------------------------------------------
// Frame validity gates.
// ---------------------------------------------------------------------------

test('validity: a clean, well-ordered, narrow-banded frame passes every gate', () => {
  const v = frameValidity([500, 1500, 2500, 3500], {
    bandwidths: [80, 110, 170, 200], residual: 0.1,
    previous: [505, 1490, 2510, 3490], previousAgeFrames: [1, 1, 1, 1],
  });
  assert.ok(v.valid, `rejected a clean frame: ${v.failed.join(',')} ${JSON.stringify(v.perFormant)}`);
  assert.deepEqual(v.accepted, [500, 1500, 2500, 3500]);
});

test('validity: out-of-order formants reject the FRAME, not one formant', () => {
  // There is no single pole to blame when F2 sits below F1 + 150 Hz: either could be the wrong
  // one, and the honest answer is that the assignment failed.
  const v = frameValidity([1500, 1550, 2500, 0], { bandwidths: [80, 110, 170, 0], residual: 0.1 });
  assert.ok(!v.valid);
  assert.ok(v.failed.includes('order'), `failed: ${v.failed.join(',')}`);
});

test('validity: bandwidth rejects ONE pole and keeps the rest of the frame', () => {
  // The per-formant half of the gate, and the reason it is per-formant: measured on the Rainbow
  // Passage, rejecting whole frames for one bad pole cost 10 points of vowel yield and rejected
  // nothing extra that was actually wrong.
  const v = frameValidity([500, 1500, 2500, 3500], {
    bandwidths: [80, 110, 1200, 200], residual: 0.1,
  });
  assert.deepEqual(v.perFormant[2], ['bandwidth']);
  assert.deepEqual(v.accepted, [500, 1500, 0, 3500]);
  assert.ok(v.valid, 'the frame still has three good formants and must survive');
});

test("validity: the bandwidth bound is never tighter than Praat's published 400 Hz", () => {
  // The first draft dropped the floor and used the proportional part alone, which made the gate
  // stricter than the established rule at F1 and rejected ordinary read speech. Being stricter
  // than the published criterion is not conservatism — it is a different rule with no evidence.
  for (const f of [200, 400, 600, 900]) {
    const v = frameValidity([f, f + 900, f + 1900, 0], {
      bandwidths: [FORMANT_MAX_BW_FLOOR_HZ - 1, 100, 150, 0], residual: 0.1,
    });
    assert.deepEqual(v.perFormant[0], [], `a ${FORMANT_MAX_BW_FLOOR_HZ - 1} Hz bandwidth at F1=${f} was rejected`);
  }
});

test('validity: continuity is a VELOCITY, so it means the same thing at any frame rate', () => {
  // Stated in Hz/s and multiplied by the caller's own frame interval. The app's harnesses do not
  // all run at 60 fps — the only real-audio fixture is 22.05 kHz, where the 735-sample hop the
  // reporting tools use is 33 ms — so a bound expressed per frame silently means two different
  // things. This is the same class of defect DSP_CONTRACT's frame-rate section documents.
  const step = 0.6 * FORMANT_MAX_STEP_HZ_PER_SEC / 60;   // 60% of one 60 fps frame's allowance
  const prev = [500, 1500, 2500, 0];
  const at60 = frameValidity([500, 1500 + step, 2500, 0], { previous: prev, frameSec: 1 / 60, residual: 0.1 });
  const at30 = frameValidity([500, 1500 + step, 2500, 0], { previous: prev, frameSec: 1 / 30, residual: 0.1 });
  assert.deepEqual(at60.perFormant[1], [], 'a 60%-of-budget step was rejected at 60 fps');
  assert.deepEqual(at30.perFormant[1], [], 'the same step was rejected at 30 fps');
  const big = 1.5 * FORMANT_MAX_STEP_HZ_PER_SEC / 60;
  const rejected = frameValidity([500, 1500 + big, 2500, 0], { previous: prev, frameSec: 1 / 60, residual: 0.1 });
  assert.deepEqual(rejected.perFormant[1], ['continuity']);
  // ...and the same absolute step is fine over twice the elapsed time.
  const slower = frameValidity([500, 1500 + big, 2500, 0], { previous: prev, frameSec: 1 / 30, residual: 0.1 });
  assert.deepEqual(slower.perFormant[1], []);
});

test('validity: a stale reference is judged over the time it was actually stale', () => {
  // Without this the tracker gets permanently stuck: a reference the gate would not let it
  // replace keeps rejecting every later frame against a one-frame bound. Measured before the
  // fix, that alone rejected half the Rainbow Passage's frames.
  const prev = [500, 1500, 2500, 0];
  const step = 1.5 * FORMANT_MAX_STEP_HZ_PER_SEC / 60;
  const fresh = frameValidity([500, 1500 + step, 2500, 0], { previous: prev, previousAgeFrames: [1, 1, 1, 1], residual: 0.1 });
  const stale = frameValidity([500, 1500 + step, 2500, 0], { previous: prev, previousAgeFrames: [1, 5, 1, 1], residual: 0.1 });
  assert.deepEqual(fresh.perFormant[1], ['continuity']);
  assert.deepEqual(stale.perFormant[1], []);
});

test('validity: a one-slot formant shift is caught even though every pole looks plausible', () => {
  // The swap gate, stated as a comparison rather than a threshold: the current set matches the
  // previous one better shifted by one than in place. The first draft additionally required each
  // formant's move to exceed the continuity bound, which made it incapable of rejecting anything
  // continuity had not already rejected.
  const prev = [500, 1500, 2500, 3500];
  const shifted = frameValidity([1500, 2500, 3500, 0], { previous: prev, residual: 0.1 });
  assert.ok(shifted.failed.includes('swap'), `failed: ${shifted.failed.join(',')}`);
});

test('validity: a frame the all-pole model cannot describe is rejected outright', () => {
  const bad = frameValidity([500, 1500, 2500, 0], { bandwidths: [80, 110, 170, 0], residual: LPC_MAX_RESIDUAL + 0.1 });
  assert.ok(bad.failed.includes('residual'));
  const ok = frameValidity([500, 1500, 2500, 0], { bandwidths: [80, 110, 170, 0], residual: LPC_MAX_RESIDUAL - 0.1 });
  assert.ok(ok.valid);
});

test('validity: fewer than two surviving formants is not a fit, whatever the reason', () => {
  const v = frameValidity([500, 0, 0, 0], { bandwidths: [80, 0, 0, 0], residual: 0.1 });
  assert.ok(!v.valid, 'one formant cannot separate tract length from vowel identity');
});

// ---------------------------------------------------------------------------
// F0 in the measurement noise.
// ---------------------------------------------------------------------------

test('§5: F0 raises the measurement noise as the square of the harmonic spacing', () => {
  // The physics: LPC places a formant from the harmonics near it, and as F0 rises the pole is
  // pulled toward whichever single harmonic is nearest. Variance goes as F0².
  const at = (f0Hz) => formantMeasurementNoise({ confidence: 1, steadiness: 1, methodTrust: 1, f0Hz });
  const ref = at(FORMANT_NOISE_F0_REF_HZ);
  assert.equal(at(FORMANT_NOISE_F0_REF_HZ / 2), ref, 'below the reference F0 there is no extra penalty');
  assert.ok(Math.abs(at(2 * FORMANT_NOISE_F0_REF_HZ) / ref - 4) < 1e-9,
    'doubling F0 must quadruple the measurement variance');
  assert.ok(at(300) > at(200) && at(200) > at(150) && at(150) > at(100));
});

test('§5: F0 enters the noise and NOT the score', async () => {
  // A score that moved with pitch would be reporting pitch twice — §1.4's double count in a
  // different costume. Same tract, three pitches, same reading.
  const scores = [];
  for (const f0 of [110, 165, 220]) {
    const a = await newAnalyzer('lpc');
    const signal = synthVowel({ f0, formants: BASE_FORMANTS });
    const vals = [];
    for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
      a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
      a.update(DT);
      if (!a.resonanceSuppressed) vals.push(a.resonanceAbsoluteV2);
    }
    const back = vals.slice(Math.floor(vals.length / 2));
    scores.push(back.reduce((s, x) => s + x, 0) / back.length);
  }
  const spread = Math.max(...scores) - Math.min(...scores);
  assert.ok(spread < 0.05,
    `doubling F0 moved the canonical score by ${spread.toFixed(4)} on a fixed tract: ${scores.map((s) => s.toFixed(4)).join(' ')}`);
});

// ---------------------------------------------------------------------------
// Confidence and suppression.
// ---------------------------------------------------------------------------

test('§4: confidence is a geometric mean, so six ordinary terms are not a failure', () => {
  // The first implementation read the diagram's dots as multiplication. Measured on the Rainbow
  // Passage the six terms sit around 0.7 and their product is 0.137 — nothing has failed and the
  // app would have suppressed half a clean recording. They are correlated views of one frame's
  // quality, not independent failure probabilities.
  const nominal = { snrConfidence: 0.9, formantConfidence: 0.7, validityRate: 0.7, fitQuality: 0.7, agreement: 0.7, f0Hz: 100 };
  const c = resonanceConfidence(nominal);
  assert.ok(c > 0.6 && c < 0.9, `six terms near 0.7 gave ${c.toFixed(4)}`);
});

test('§4: any collapsed term collapses the whole reading', () => {
  // The property the product was chosen for, kept. A frame with perfect cross-estimator
  // agreement and no SNR is not half-good.
  assert.equal(resonanceConfidence({ snrConfidence: 0, formantConfidence: 1, validityRate: 1, fitQuality: 1, f0Hz: 100 }), 0);
  assert.equal(resonanceConfidence({ snrConfidence: 1, formantConfidence: 0, validityRate: 1, fitQuality: 1, f0Hz: 100 }), 0);
  assert.equal(resonanceConfidence({ snrConfidence: 1, formantConfidence: 1, validityRate: 0, fitQuality: 1, f0Hz: 100 }), 0);
});

test('§4: an unmeasured cross-check is excluded, not counted as agreement', () => {
  const base = { snrConfidence: 0.8, formantConfidence: 0.8, validityRate: 0.8, fitQuality: 0.8, f0Hz: 100 };
  const without = resonanceConfidence(base);
  const withPerfect = resonanceConfidence({ ...base, agreement: 1 });
  assert.ok(withPerfect > without,
    'a cross-check that agreed perfectly must raise confidence above never having run one');
});

test('§5: below the floor the app produces NO reading, not a stale or substituted one', async () => {
  const a = await newAnalyzer('lpc');
  const signal = synthVowel({ formants: BASE_FORMANTS });
  for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
    a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
    a.update(DT);
  }
  assert.ok(!a.resonanceSuppressed, 'a clean held vowel must not be suppressed');
  assert.ok(a.resonanceAbsoluteV2 > 0 && a.formantScaleHz > 0);
  // Now silence. Everything the v2 stream reports must go to "no reading" — not freeze.
  const quiet = new Float32Array(WINDOW);
  for (let k = 0; k < 200; k++) {
    a.audioCtx._currentChunk = quiet;
    a.update(DT);
  }
  assert.ok(a.resonanceSuppressed, 'silence did not suppress the reading');
  assert.equal(a.resonanceAbsoluteV2, 0, 'the score was frozen rather than cleared');
  assert.equal(a.formantScaleHz, 0, 'the pooled scale was frozen rather than cleared');
  assert.equal(a.apparentVtlV2Cm, 0, 'the apparent tract length was frozen rather than cleared');
  assert.equal(a.vowelId, null);
  assert.equal(a.f2PositionRatio, 0);
});

test('§5: the suppression reason names the term that collapsed', async () => {
  const a = await newAnalyzer('lpc');
  const quiet = new Float32Array(WINDOW);
  for (let k = 0; k < 50; k++) { a.audioCtx._currentChunk = quiet; a.update(DT); }
  assert.ok(typeof a.resonanceSuppressReason === 'string' && a.resonanceSuppressReason.length > 0);
  // "estimators-disagree" must NOT be reachable as a suppression reason: the cross-check feeds
  // the reported confidence but never the suppression decision, because a coarse second opinion
  // cannot establish that the primary measurement failed.
  assert.notEqual(a.resonanceSuppressReason, 'estimators-disagree');
});

// ---------------------------------------------------------------------------
// Cross-estimator agreement.
// ---------------------------------------------------------------------------

test('§3.4: a known estimator bias is not read as disagreement', () => {
  // The harmonic envelope quantises F2/F3 to the nearest harmonic and reports ΔF ~4% low BY
  // CONSTRUCTION. Uncorrected, a correctly-working harmonic estimator could never agree with a
  // correctly-working LPC.
  const primary = 1000;
  const harmonicExact = primary * (1 + ESTIMATOR_DELTA_F_BIAS.harmonic);
  const corrected = crossEstimatorAgreement(primary, harmonicExact, { checkMethod: 'harmonic' });
  const uncorrected = crossEstimatorAgreement(primary, harmonicExact);
  assert.ok(corrected > 0.99, `bias-corrected agreement was ${corrected.toFixed(3)}`);
  assert.ok(corrected > uncorrected);
});

test('§3.4: agreement falls to zero at a whole formant slot of disagreement', () => {
  assert.equal(crossEstimatorAgreement(1000, 1400), 0);
  assert.ok(crossEstimatorAgreement(1000, 1070) > 0.7, 'ordinary precision differences are not a failure');
  assert.equal(crossEstimatorAgreement(1000, 0), null, 'a check that did not run is null, not zero');
});

// ---------------------------------------------------------------------------
// The demoted centroid.
// ---------------------------------------------------------------------------

test('§5, D1: the centroid is a brightness feature and never a resonance substitute', async () => {
  assert.ok(spectralBrightness(700) === 0 && spectralBrightness(2200) === 1);
  assert.ok(spectralBrightness(1450) > 0.4 && spectralBrightness(1450) < 0.6);
  // And selecting it changes nothing about the canonical reading — asserted above by the
  // identity test, checked here at the field level so the intent is legible.
  const a = await newAnalyzer('centroid');
  const signal = synthVowel({ formants: BASE_FORMANTS });
  for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
    a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
    a.update(DT);
  }
  assert.ok(a.spectralBrightness >= 0 && a.spectralBrightness <= 1);
  assert.ok(a.resonanceAbsoluteV2 > 0, 'the canonical reading exists even under the centroid setting');
});

// ---------------------------------------------------------------------------
// The ceiling search.
// ---------------------------------------------------------------------------

test('the ceiling cost cannot be improved by finding FEWER formants', () => {
  // The bias that broke the first version: a uniform-tube fit of three points is always better
  // than of four, so a ceiling scored better for losing F4. Both replacement terms are per-pole.
  const frames = (n, count) => Array.from({ length: n }, () => ({
    formants: [500, 1500, 2500, 3500].map((f, i) => (i < count ? f : 0)),
    bandwidths: [80, 110, 170, 200].map((b, i) => (i < count ? b : 0)),
    valid: true,
  }));
  const withF4 = scoreLpcCeiling({ ceilingHz: 6000, frames: frames(40, 4) });
  const withoutF4 = scoreLpcCeiling({ ceilingHz: 4500, frames: frames(40, 3) });
  assert.ok(withF4.cost < withoutF4.cost,
    `losing F4 scored better: ${withoutF4.cost.toFixed(4)} vs ${withF4.cost.toFixed(4)}`);
});

test('the ceiling search prefers smooth tracks over jumpy ones', () => {
  const steady = Array.from({ length: 40 }, () => ({
    formants: [500, 1500, 2500, 3500], bandwidths: [80, 110, 170, 200], valid: true,
  }));
  const jumpy = Array.from({ length: 40 }, (_, k) => ({
    formants: [500, 1500 + (k % 2) * 600, 2500, 3500], bandwidths: [80, 110, 170, 200], valid: true,
  }));
  const a = scoreLpcCeiling({ ceilingHz: 5000, frames: steady });
  const b = scoreLpcCeiling({ ceilingHz: 5500, frames: jumpy });
  assert.ok(a.cost < b.cost, `smooth ${a.cost.toFixed(4)} vs jumpy ${b.cost.toFixed(4)}`);
  const chosen = selectLpcCeiling([{ ceilingHz: 5000, frames: steady }, { ceilingHz: 5500, frames: jumpy }]);
  assert.equal(chosen.ceilingHz, 5000);
  assert.ok(chosen.selected);
});

test('the ceiling search declines rather than guessing from too little audio', () => {
  const chosen = selectLpcCeiling([{ ceilingHz: 5000, frames: [] }]);
  assert.equal(chosen.selected, false);
  assert.equal(chosen.ceilingHz, LPC_DEFAULT_CEILING_HZ, 'it must fall back to the published default');
});

test('calibration treats a vowel SET as separate productions, not one utterance', async () => {
  // Running one continuity tracker across the boundary between two productions measures the
  // boundary. Worse, it rigged the search: the tracker got stuck on the previous vowel and the
  // ceiling that had found FEWER formants (so had fewer to fail) scored best.
  const a = await newAnalyzer('lpc');
  const windowsOf = (sig) => {
    const out = [];
    for (let i = 0; i + WINDOW <= sig.length; i += HOP) out.push(sig.subarray(i, i + WINDOW));
    return out;
  };
  const segments = [[270, 2290, 3010], [730, 1090, 2440], [300, 870, 2240]].map((f) => {
    const deltaF = fitFormantScale([...f, 0]).deltaF;
    return windowsOf(synthVowel({ f0: 120, formants: [...f, 3.5 * deltaF], seconds: 0.6, sampleRate: SAMPLE_RATE }));
  });
  const chosen = a.calibrateLpcCeiling(segments);
  assert.ok(chosen.selected, `search declined: ${chosen.reason}`);
  assert.ok(LPC_CEILING_CANDIDATES_HZ.includes(chosen.ceilingHz));
  assert.equal(a.lpcCeilingHz, chosen.ceilingHz);
  assert.equal(a.lpcCeilingSource, 'calibrated');
  // Every candidate must have been scored on the same amount of audio.
  const counts = new Set(chosen.scored.map((s) => s.n));
  assert.equal(counts.size, 1, `candidates scored on different frame counts: ${[...counts].join(',')}`);
});

test('a per-user ceiling does not reach v1', async () => {
  // v1's `lpc` branch is pinned to the default ceiling. Calibration must be invisible to the
  // displayed metric until Phase 4 retires it.
  const signal = synthVowel({ formants: BASE_FORMANTS });
  const run = async (ceilingHz) => {
    const a = await newAnalyzer('lpc');
    if (ceilingHz) a.lpcCeilingHz = ceilingHz;
    const vals = [];
    for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
      a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
      a.update(DT);
      vals.push(a.smoothResonance);
    }
    return vals;
  };
  const base = await run(null);
  const calibrated = await run(6500);
  for (let i = 0; i < base.length; i++) {
    assert.equal(calibrated[i], base[i], `v1 frame ${i} moved when a ceiling was calibrated`);
  }
});

// ---------------------------------------------------------------------------
// ρ, and the /ɝ/ hand-off from Phase 2.
// ---------------------------------------------------------------------------

test('ρ separates the rhotic from every other vowel in the published norms', () => {
  const nonRhotic = Object.entries(VOWEL_POOLED_RHO).filter(([v]) => v !== 'ɝ').map(([, r]) => r);
  assert.ok(VOWEL_POOLED_RHO['ɝ'] < Math.min(...nonRhotic) * 0.9,
    `/ɝ/ ρ = ${VOWEL_POOLED_RHO['ɝ']} against a minimum non-rhotic ${Math.min(...nonRhotic)}`);
  assert.ok(RHOTIC_RHO_THRESHOLD > VOWEL_POOLED_RHO['ɝ'] && RHOTIC_RHO_THRESHOLD < Math.min(...nonRhotic),
    'the threshold must sit between the rhotic and the nearest non-rhotic');
});

test('ρ declines on every window it cannot be read from', () => {
  const rho = 0.72;
  const good = { windowMedianRho: 1, heterogeneous: true, frameValid: true, windowFrames: 100, windowVowels: 5 };
  assert.equal(rhoticFromRho(rho, good).rhotic, true);
  // A sustained hold: the window has collapsed onto one vowel, ρ → 1 by construction, and it
  // carries no vowel information at all — so a hold on /ɝ/ is invisible in ρ and must not be
  // guessed at from it either.
  assert.equal(rhoticFromRho(rho, { ...good, heterogeneous: false }).reason, 'homogeneous-window');
  // A frame whose F3 the gates rejected: a mis-assigned F3 lowers ρ exactly the way a rhotic
  // does, which is the whole reason Phase 2 refused to use it.
  assert.equal(rhoticFromRho(rho, { ...good, frameValid: false }).reason, 'invalid-frame');
  // Too few distinct vowels for a median to mean anything. Measured: it holds down to three and
  // breaks at two, where the median is simply the larger of the pair.
  assert.equal(rhoticFromRho(rho, { ...good, windowVowels: 2 }).reason, 'window-too-uniform');
});

test('ρ is INSTRUMENTED and does not override the classifier', async () => {
  // Phase 3's measured answer to Phase 2's hand-off is "no, and here is why" — see the note in
  // app.js's _updateResonanceV2 and tools/rho-rhotic.mjs. ρ works on the norms and does not
  // survive the live path; the blocker turned out to be the formant assignment, not ρ. This
  // pins that it is exposed and not acted on, so a later phase turning it on is a deliberate
  // change rather than a drift.
  const a = await newAnalyzer('lpc');
  const signal = synthVowel({ formants: BASE_FORMANTS });
  for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
    a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
    a.update(DT);
  }
  assert.ok('rhoticDetected' in a && 'rhoRelative' in a && 'rhoReason' in a);
  assert.ok(!a.rhoticDetected, 'a held non-rhotic vowel must not read as a rhotic');
  assert.notEqual(a.vowelId, 'ɝ');
});

test('window homogeneity tells a sustained hold from connected speech', () => {
  const hold = Array.from({ length: 60 }, () => ({ deltaF: 1000, weight: 1 }));
  const speech = Array.from({ length: 60 }, (_, k) => ({ deltaF: 850 + (k % 7) * 50, weight: 1 }));
  assert.ok(windowHomogeneity(hold).homogeneous);
  assert.ok(!windowHomogeneity(speech).homogeneous);
  assert.ok(windowHomogeneity([]).n === 0);
});

// ---------------------------------------------------------------------------
// The fabricated formant Phases 1-2 were consuming.
// ---------------------------------------------------------------------------

test('the canonical path never sees a defaulted formant', async () => {
  // _resonanceLPC substitutes F1 = 500 Hz and F2 = 1500 Hz when it finds none — v1's behaviour,
  // unchanged. Phases 1 and 2 fed those substitutes straight into the v2 stream, because v1's
  // age counters reset on the defaulted value, so a fabricated F1 looked freshly measured.
  // Measured: the LPC finds no F1 on 4.9% of Rainbow Passage frames and 10.0% of a synthesized
  // vowel set at F0 180. The canonical path reads the pre-default vector and abstains instead.
  const a = await newAnalyzer('lpc');
  // A signal with energy but no pole in the F1 admission band (150-1200 Hz): two resonators
  // well above it, so the solve succeeds and the F1 slot goes unfilled. That is the case the
  // defaults exist for, and the case Phases 1-2 fed straight into the v2 stream.
  const signal = synthVowel({ formants: [1800, 2600], seconds: 1.0 });
  a.audioCtx._currentChunk = signal.subarray(0, WINDOW);
  a.update(DT);
  a.timeDomainData = signal.subarray(WINDOW, 2 * WINDOW);
  const r = a._resonanceLPC();
  assert.ok(Array.isArray(r.measured), 'the pre-default vector must be returned');
  // Wherever the default fired, the reported value and the measured one must disagree — that
  // disagreement IS the fabrication being withheld from the canonical path.
  if (r.measured[0] === 0) assert.equal(r.f1, 500, "v1's F1 default is unchanged");
  if (r.measured[1] === 0) assert.equal(r.f2, 1500, "v1's F2 default is unchanged");
  assert.ok(r.measured[0] === 0 || r.measured[0] === r.f1);
  assert.ok(r.measured[1] === 0 || r.measured[1] === r.f2);
  assert.equal(r.measured[0], 0,
    `a signal with no F1-band pole reported F1 = ${r.measured[0]} as measured`);
});

test('the rhotic-capable assignment exists, costs no extra solve, and is not v1s', async () => {
  const a = await newAnalyzer('lpc');
  const signal = synthVowel({ formants: [490, 1350, 1690, 3000] });
  a.audioCtx._currentChunk = signal.subarray(0, WINDOW);
  a.update(DT);
  a.timeDomainData = signal.subarray(WINDOW, 2 * WINDOW);
  const before = a._lpcSolveCount;
  const r = a._resonanceLPC();
  assert.equal(a._lpcSolveCount, before, 'the second assignment must not trigger another solve');
  assert.ok(Array.isArray(r.measuredRhotic) && r.measuredRhotic.length === 4);
  // On a synthesized rhotic the widened slot finds an F3 the standard assignment cannot.
  assert.ok(r.measuredRhotic[2] > 0, 'the rhotic-capable assignment found no F3 on a rhotic');
  assert.ok(r.measuredRhotic[2] < 2000, `rhotic F3 came out at ${r.measuredRhotic[2].toFixed(0)} Hz`);
  // v1's assignment cannot put a pole below 2000 Hz in the F3 slot. Left to itself it either
  // finds nothing there or skips past the rhotic to the next resonance up — which is precisely
  // why, before Phase 3, the live path read a synthesized /ɝ/ as /ʊ/ on 64 frames in 67.
  assert.ok(r.measured[2] === 0 || r.measured[2] >= 2000,
    `v1's assignment admitted a ${r.measured[2].toFixed(0)} Hz F3`);
  assert.notEqual(r.measured[2], r.measuredRhotic[2],
    'the two assignments found the same F3 — the rhotic pole was not the one being withheld');
});
