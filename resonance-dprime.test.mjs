// The d′ benchmark — docs/RESONANCE_REDESIGN.md §1.3, promoted from a number in a document
// to a committed regression net (§5: "The d′ benchmark from §1.3 is the primary regression
// net; it becomes a committed test.").
//
// What it does, and nothing more: it takes Peterson & Barney (1952) adult male and female
// MEAN formant frequencies as ground truth and feeds them straight into the scoring
// functions. No estimator, no noise, no smoothing, no pooling. Anything a real microphone
// adds can only make a measure worse than it scores here, so this is a ceiling on construct
// validity, measured on published norms.
//
//     d′ = (female mean − male mean) / pooled within-sex across-vowel SD
//
// Below 1.0 means the measure separates two vowels in one mouth more reliably than it
// separates two speakers — which is the finding that started the redesign.
//
// The benchmark itself lives in tools/resonance-benchmark.mjs, which is also its report
// (`node tools/resonance-benchmark.mjs`). One implementation, so the printed table and the
// asserted numbers cannot drift apart.
//
// This test has to survive Phases 2-6. It therefore pins v1's score at both ends (the
// per-vowel table AND the d′) so that "v1 is unchanged" is asserted rather than asserted-about,
// and states v2's criteria as inequalities against the §5 thresholds rather than as
// equalities against whatever v2 happens to produce today.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitFormantDispersion, fitFormantScale, formantPatternResiduals,
  resonanceAbsoluteV2, RESONANCE_V2_REFERENCE_DELTA_F_HZ,
  classifyVowel, normalizeResidualScale, residualScaleFactor, f2PositionFromResidual,
  VOWEL_TEMPLATES, VOWEL_RESIDUAL_SD, VOWEL_SPEAKER_SCATTER, VOWEL_TEMPLATE_FORMANTS,
  vowelDimsFor, expectedF2Hz, f2Position, f2PositionToDisplay,
} from './dsp-utils.js';
import {
  BENCH_SET, FULL_SET, formantsOf, mean, sd, dPrime, scoreV1, scoreV2,
  sensitivity, v1SensitivityViaDeltaFOnly, SENSITIVITY_REF,
  pbSpeaker, buildTemplates, classifierEval, nucleusEval, f4Eval, templateDistance,
  residualSdFor, f2PositionSexDPrime, f2PositionTrainingDPrime, f2PositionAlphaSweep,
  f2PositionFor, GAVT_F2_GAIN,
} from './tools/resonance-benchmark.mjs';

const NON_RHOTIC = FULL_SET.filter((v) => v !== 'ɝ');   // see the /ɝ/ note below

test('benchmark fixture reproduces §1.1 exactly — the ruler itself is pinned', () => {
  // If these move, the fixture has been edited and every number below means something
  // different. §1.1's published table, to the two decimals it publishes.
  const expected = { i: 0.73, ɪ: 0.36, ɛ: 0.29, æ: 0.25, ɑ: 0.19, ʊ: 0.06, u: 0.00 };
  const expectedDeltaF = { i: 1268, ɪ: 1092, ɛ: 1054, æ: 1021, ɑ: 926, ʊ: 840, u: 806 };
  const expectedVtlCm = { i: 13.8, ɪ: 16.0, ɛ: 16.6, æ: 17.1, ɑ: 18.9, ʊ: 20.8, u: 21.7 };
  for (const v of BENCH_SET) {
    const f = formantsOf(v, 'male');
    const deltaF = fitFormantDispersion([f[0], f[1], f[2]]).deltaF;
    assert.equal(Math.round(deltaF), expectedDeltaF[v], `ΔF for /${v}/`);
    assert.equal(+(35000 / (2 * deltaF)).toFixed(1), expectedVtlCm[v], `apparent VTL for /${v}/`);
    assert.equal(+scoreV1(f).toFixed(2), expected[v], `v1 score for /${v}/`);
  }
});

test("§1.3 anchor: v1's d′ on the benchmark is 0.86, and its across-vowel swing is 73 points", () => {
  const r = dPrime(scoreV1);
  // 0.858. The redesign quotes 0.85; the per-vowel scores above match its table exactly, so
  // the 0.008 is reporting precision in the document, not a different measurement.
  assert.ok(Math.abs(r.d - 0.858) < 0.005, `v1 d′ = ${r.d.toFixed(3)}, expected 0.858`);
  // §1.1: one nominal tract, 73 points of travel. This is the number v2 has to beat.
  assert.ok(Math.abs(r.maleSwingPts - 73.4) < 0.5, `v1 male swing = ${r.maleSwingPts.toFixed(1)} pts`);
  // And v1 is below 1.0: it separates two vowels in one mouth better than two speakers.
  assert.ok(r.d < 1.0);
});

test('§5 acceptance: v2 reaches d′ ≥ 1.5 on the P&B benchmark', () => {
  const v2 = dPrime(scoreV2);
  const v1 = dPrime(scoreV1);
  assert.ok(v2.d >= 1.5, `v2 d′ = ${v2.d.toFixed(3)}, §5 requires ≥ 1.5`);
  assert.ok(v2.d > v1.d, `v2 d′ (${v2.d.toFixed(3)}) must beat v1 (${v1.d.toFixed(3)})`);
  // Not a floor that can be met by an F3-only measure and then quietly regressed to one:
  // §1.3 puts ΔF-from-F3-alone at 1.67 and F3-normalised at 1.98, so a scale that uses
  // F1/F2 at all lands below those. Assert v2 is in that band rather than above it, so a
  // future change that silently drops F1/F2 entirely shows up here.
  assert.ok(v2.d < 2.0, `v2 d′ = ${v2.d.toFixed(3)}`);
});

test('§5 acceptance: v2 across-vowel swing for a single speaker is under 25 points', () => {
  const v2 = dPrime(scoreV2);
  assert.ok(v2.maleSwingPts < 25, `v2 male across-vowel swing = ${v2.maleSwingPts.toFixed(1)} pts`);
  assert.ok(v2.femaleSwingPts < 25, `v2 female across-vowel swing = ${v2.femaleSwingPts.toFixed(1)} pts`);
  // The criterion that actually matters is the ratio: how much of the meter's travel is the
  // speaker and how much is which vowel they happened to be on. v1 swings ~2.7x its own
  // male→female shift; v2 must swing less than twice its own.
  assert.ok(v2.maleSwingPts / v2.shiftPts < 2.0,
    `v2 swing/shift = ${(v2.maleSwingPts / v2.shiftPts).toFixed(2)}`);
});

test('v2 holds up outside the seven vowels §1.1 tabulated', () => {
  // The benchmark set is the one the redesign's acceptance numbers are stated on. If v2 only
  // worked there, it would be an artefact of the subset, so the other three P&B vowels are
  // scored too and the result is recorded rather than hidden.
  const full = dPrime(scoreV2, FULL_SET);
  const fullV1 = dPrime(scoreV1, FULL_SET);
  assert.ok(full.d > fullV1.d, `v2 ${full.d.toFixed(3)} vs v1 ${fullV1.d.toFixed(3)} over all ten vowels`);
  assert.ok(full.maleSwingPts < 25, `v2 male swing over all ten = ${full.maleSwingPts.toFixed(1)} pts`);
  // On the full set v2 lands at 1.22, below the 1.5 the seven-vowel set gives. One vowel is
  // responsible: /ɝ/, whose F3 drops to 1690 Hz (male) because a rhotic constriction lowers
  // F3 by ~800 Hz. An upper-formant-weighted tract-*length* estimate has no defence against
  // that — the third formant of a rhotic is not a statement about tract length. Excluding it
  // recovers most of the loss, which is what identifies it as the cause rather than a guess.
  // The fix is not a wider weight vector, it is Phase 2 and Phase 3: /ɝ/ announces itself as
  // an apparent tract 24.9 cm long (asserted below), which no adult has, and a vowel-
  // conditioned scale can decline to read tract length off a rhotic F3 at all.
  const noRhotic = dPrime(scoreV2, NON_RHOTIC);
  assert.ok(noRhotic.d > full.d + 0.2,
    `dropping /ɝ/ moves v2 from ${full.d.toFixed(3)} to ${noRhotic.d.toFixed(3)}`);
});

test('§1.4: the per-formant sensitivity table shows no formant entering v2 twice', () => {
  // Numerically differentiate the actual scoring functions, the way §1.4 did, at the same
  // operating point: the reference synthesized vowel F1/F2/F3 = 570/1710/2850 Hz (ΔF = 1140 Hz)
  // that DSP_CONTRACT's per-estimator accuracy table is also measured on. Units are score
  // points (0..1) per kHz, as published.
  const sensV1 = sensitivity(scoreV1);
  const sensV2 = sensitivity(scoreV2);

  // v1, reproducing §1.4 exactly: F1 0.558, F2 0.566, F3 0.705 → 30% / 31% / 39%, against a
  // published weighting of 55/25/20. The nominal weights describe nothing that exists.
  assert.ok(Math.abs(sensV1[0] - 0.558) < 0.01, `v1 ∂/∂F1 = ${sensV1[0].toFixed(3)}`);
  assert.ok(Math.abs(sensV1[1] - 0.566) < 0.01, `v1 ∂/∂F2 = ${sensV1[1].toFixed(3)}`);
  assert.ok(Math.abs(sensV1[2] - 0.705) < 0.01, `v1 ∂/∂F3 = ${sensV1[2].toFixed(3)}`);

  // The double count, isolated. v1's only route from a formant to the score that the acoustic
  // model sanctions is through ΔF. Freeze that route's inputs and differentiate again: what
  // is left over is a second path. For F3 there is none; for F1 and F2 it is the 0.25 and
  // 0.20 terms, and for F1 it is three quarters of the total.
  const via = v1SensitivityViaDeltaFOnly();
  const secondPathV1 = [0, 1, 2].map((i) => sensV1[i] - via[i]);
  assert.ok(Math.abs(secondPathV1[0] - 0.4167) < 0.01, `v1 F1 second path = ${secondPathV1[0].toFixed(3)} pts/kHz`);
  assert.ok(Math.abs(secondPathV1[1] - 0.1429) < 0.01, `v1 F2 second path = ${secondPathV1[1].toFixed(3)} pts/kHz`);
  assert.ok(Math.abs(secondPathV1[2]) < 1e-9, 'v1 F3 has no second path');

  // v2: every formant's second path must be exactly zero. Rather than freezing a route that
  // does not exist, compare the numeric derivative against the analytic derivative of the
  // single sanctioned path. Any discrepancy IS a second path.
  // `leverage` is ∂ΔF/∂F_i as the fit itself reports it, so this compares the score's
  // measured derivative against the regression's own arithmetic rather than a restatement
  // of it. The only step between them is the score's 2·ΔF_ref denominator.
  const { leverage } = fitFormantScale(SENSITIVITY_REF);
  const analytic = (i) => leverage[i] / (2 * RESONANCE_V2_REFERENCE_DELTA_F_HZ) * 1000;
  // Sanity: the leverage vector is the weight vector's, upper-formant dominated.
  assert.ok(leverage[2] > leverage[0] * 3 && leverage[2] > leverage[1] * 10,
    `leverage = ${leverage.map((l) => l.toExponential(2)).join(', ')}`);
  for (const i of [0, 1, 2]) {
    assert.ok(Math.abs(sensV2[i] - analytic(i)) < 1e-9,
      `v2 ∂/∂F${i + 1}: numeric ${sensV2[i].toFixed(9)} vs single-path analytic ${analytic(i).toFixed(9)} — a difference is a second path`);
  }

  // The shares are the weight vector's, upper-formant-dominated as §3.2 requires:
  // F1 23%, F2 5%, F3 72% without F4; F1 15%, F2 4%, F3 48%, F4 34% with it.
  const total = sensV2.slice(0, 3).reduce((a, b) => a + b, 0);
  assert.ok(sensV2[2] / total > 0.6, `v2 F3 share = ${(100 * sensV2[2] / total).toFixed(0)}%`);
  assert.ok(sensV2[0] / total < 0.3, `v2 F1 share = ${(100 * sensV2[0] / total).toFixed(0)}%`);
  assert.ok(sensV2[1] / total < 0.1, `v2 F2 share = ${(100 * sensV2[1] / total).toFixed(0)}%`);
  const withF4 = sensitivity(scoreV2, [570, 1710, 2850, 3990]);
  const totalF4 = withF4.reduce((a, b) => a + b, 0);
  assert.ok(withF4[3] / totalF4 > 0.25, `v2 F4 share = ${(100 * withF4[3] / totalF4).toFixed(0)}%`);
  assert.ok((withF4[2] + withF4[3]) / totalF4 > 0.75,
    `v2 upper-formant share with F4 = ${(100 * (withF4[2] + withF4[3]) / totalF4).toFixed(0)}%`);
});

test('formantPattern residuals are speaker-independent by construction', () => {
  // The Phase 2 precondition. r_i must move with the vowel and stay put across speakers of
  // different tract length — otherwise a vowel classifier built on them is really a speaker
  // classifier. Measured over P&B: r₁ travels ~1.0 across vowels and ~0.05 across sexes.
  let maxAcrossSex = 0, minR1 = Infinity, maxR1 = -Infinity;
  for (const v of BENCH_SET) {
    const m = formantsOf(v, 'male'), f = formantsOf(v, 'female');
    const rm = formantPatternResiduals(m, fitFormantScale(m).deltaF);
    const rf = formantPatternResiduals(f, fitFormantScale(f).deltaF);
    for (let i = 0; i < 3; i++) maxAcrossSex = Math.max(maxAcrossSex, Math.abs(rm[i] - rf[i]));
    minR1 = Math.min(minR1, rm[0]); maxR1 = Math.max(maxR1, rm[0]);
  }
  assert.ok(maxAcrossSex < 0.2, `largest male↔female residual difference = ${maxAcrossSex.toFixed(3)}`);
  assert.ok(maxR1 - minR1 > 0.8, `r₁ across-vowel travel = ${(maxR1 - minR1).toFixed(3)}`);
  // A vector, not a scalar: Phase 2 classifies the vowel from all of it.
  assert.equal(formantPatternResiduals([500, 1500, 2500, 3500], 1000).length, 4);
  // Unmeasured formants stay null rather than becoming a fabricated residual.
  assert.deepEqual(formantPatternResiduals([500, 0, 2500, 0], 1000).map((r) => r === null), [false, true, false, true]);

  // What the residuals do NOT do, recorded so nobody builds on the opposite assumption:
  // they do not flag /ɝ/, the vowel that costs v2 d′ on the full set. Its residual vector
  // (1.396, 1.282, 0.963) sits 0.14 from /æ/'s in a space where vowels span ~1.0 — separable
  // by a classifier, but nowhere near an outlier. A rhotic's lowered F3 is absorbed *into the
  // scale*, not left in the shape, precisely because F3 carries the scale.
  const rhotic = formantsOf('ɝ', 'male');
  const rRhotic = formantPatternResiduals(rhotic, fitFormantScale(rhotic).deltaF);
  assert.ok(Math.abs(rRhotic[2] - 1) < 0.1, `/ɝ/ r₃ = ${rRhotic[2].toFixed(3)} — the rhotic is not visible here`);
  // Where it IS visible is the scale it implies: an apparent vocal tract of ~25 cm, longer
  // than any adult's. That is a frame-validity gate (Phase 3) and a vowel-conditioning
  // problem (Phase 2), not something the residual vector solves.
  const rhoticVtlCm = 35000 / (2 * fitFormantScale(rhotic).deltaF);
  assert.ok(rhoticVtlCm > 23, `/ɝ/ implies an apparent VTL of ${rhoticVtlCm.toFixed(1)} cm`);
  for (const v of BENCH_SET) {
    const cm = 35000 / (2 * fitFormantScale(formantsOf(v, 'male')).deltaF);
    assert.ok(cm > 13 && cm < 22, `/${v}/ implies ${cm.toFixed(1)} cm`);
  }
});

test('the v2 reference dispersion is the fixture\'s own grand mean, not a free parameter', () => {
  // RESONANCE_V2_REFERENCE_DELTA_F_HZ sets the scale of the whole v2 axis. Recompute it from
  // the committed norms so it cannot drift into a tuning knob.
  const all = BENCH_SET.flatMap((v) => ['male', 'female'].map((s) => fitFormantScale(formantsOf(v, s)).deltaF));
  assert.ok(Math.abs(mean(all) - RESONANCE_V2_REFERENCE_DELTA_F_HZ) < 5,
    `P&B grand-mean weighted ΔF = ${mean(all).toFixed(1)} Hz, constant is ${RESONANCE_V2_REFERENCE_DELTA_F_HZ}`);
});

test('F4, when present, is used and does not destabilise the scale', () => {
  // The benchmark runs without F4 because P&B published none. This checks the other branch:
  // adding a plausible F4 must move the score a little (it carries real weight) and not a
  // lot (the scale is a scale, not a fourth-formant readout).
  for (const v of BENCH_SET) {
    const f = formantsOf(v, 'male');
    // Uniform-tube prediction for F4 at this vowel's own fitted scale — i.e. an F4 that
    // agrees with the tract the other three formants describe.
    const withF4 = f.slice();
    withF4[3] = 3.5 * fitFormantScale(f).deltaF;
    const delta = Math.abs(scoreV2(withF4) - scoreV2(f));
    assert.ok(delta < 0.02, `/${v}/ moved ${(100 * delta).toFixed(2)} pts on a model-consistent F4`);
  }
  // And a genuinely different tract length, seen only through F4, does move it.
  const base = [500, 1500, 2500, 0];
  assert.ok(scoreV2([500, 1500, 2500, 4200]) > scoreV2(base));
  assert.ok(scoreV2([500, 1500, 2500, 3000]) < scoreV2(base));
});

test('the scale fit refuses to invent a reading it does not have', () => {
  assert.equal(fitFormantScale([500, 0, 0, 0]).deltaF, 0, 'one formant is not a tract length');
  assert.equal(fitFormantScale([]).deltaF, 0);
  assert.equal(fitFormantScale(null).deltaF, 0);
  assert.equal(resonanceAbsoluteV2(0), 0);
  // Array position is the formant number, as in fitFormantDispersion: a dropped F2 must not
  // promote F3 into F2's slot. [F1, 0, F3] and [F1, F3] are different statements.
  const dropped = fitFormantScale([500, 0, 2500, 0]).deltaF;
  const miscompacted = fitFormantScale([500, 2500, 0, 0]).deltaF;
  assert.ok(Math.abs(dropped - 1000) < 1, `ΔF with F2 dropped = ${dropped.toFixed(1)}`);
  // 1277 Hz vs 1000 Hz: reading F3 as though it were F2 shortens the apparent tract by 22%.
  assert.ok(miscompacted > dropped * 1.2, 'compacting the list must not silently produce the same ΔF');
});

// ============================================================================
// PHASE 2 — vowel conditioning (docs/RESONANCE_REDESIGN.md §5)
//
// Same discipline as above: the numbers Phase 2 claims are asserted here, INCLUDING the ones
// it did not achieve, so a later phase cannot quietly inherit an unearned result.
// ============================================================================

test('the residual vector has exactly n−1 free dimensions — an identity, not an approximation', () => {
  // Phase 1 handed over a warning: r₃ ≈ 1.0 everywhere, so measure the dimensionality rather
  // than assuming three. The answer is exact. ΔF = Σ(w_i x_i F_i)/Σ(w_j x_j²) and
  // r_i = F_i/(x_i ΔF) together force Σ L_i r_i ≡ 1 with L_i = w_i x_i²/Σ(w_j x_j²).
  for (const v of FULL_SET) {
    for (const sex of ['male', 'female']) {
      const f = formantsOf(v, sex);
      const fit = fitFormantScale(f);
      const r = formantPatternResiduals(f, fit.deltaF);
      // leverage is w_i x_i / sxx, so L_i = leverage_i · x_i.
      const acc = [0, 1, 2].reduce((a, i) => a + fit.leverage[i] * ((2 * (i + 1) - 1) / 2) * r[i], 0);
      assert.ok(Math.abs(acc - 1) < 1e-12, `/${v}/ ${sex}: Σ L_i·r_i = ${acc}`);
    }
  }
  // Which is what residualScaleFactor computes, and why it is exactly 1 on a self-fitted frame.
  const f = formantsOf('ɑ', 'male');
  const own = formantPatternResiduals(f, fitFormantScale(f).deltaF);
  assert.ok(Math.abs(residualScaleFactor(own) - 1) < 1e-12);
  // Three formants, two free dimensions. Four formants, three. This is the classifier's
  // dimension count, derived rather than chosen.
  assert.equal(vowelDimsFor(3), 2);
  assert.equal(vowelDimsFor(4), 3);
  assert.equal(vowelDimsFor(1), 0);
  // And it shows up in the data as r₃'s across-vowel SD being two orders below r₁'s.
  const sdInv = residualSdFor('invariant');
  assert.ok(sdInv[2] < sdInv[0] / 10, `r₃ SD ${sdInv[2].toFixed(4)} vs r₁ ${sdInv[0].toFixed(4)}`);
});

test('pooling ΔF opens a third dimension; a sustained hold closes it again', () => {
  // The operating-point problem Phase 2 had to solve, stated as numbers. Against a scale
  // pooled over several vowels the identity above does NOT hold, and r₃ becomes informative.
  const pooledSd = residualSdFor('pooled');
  const invSd = residualSdFor('invariant');
  assert.ok(pooledSd[2] > 5 * invSd[2],
    `r₃ SD: pooled ${pooledSd[2].toFixed(4)} vs invariant ${invSd[2].toFixed(4)}`);
  // ρ per vowel at the pooled scale spans a real range...
  const rho = pbSpeaker('male').rho;
  assert.ok(Math.max(...rho) - Math.min(...rho) > 0.4, `ρ range ${Math.min(...rho)}–${Math.max(...rho)}`);
  // ...but during a sustained hold the window holds one vowel, ΔF_pooled becomes that vowel's
  // own fit, and ρ collapses to exactly 1 for every vowel. Both are first-class operating
  // points — a held vowel is the exercise mode the ball runs.
  for (const v of FULL_SET) {
    const f = formantsOf(v, 'male');
    const held = formantPatternResiduals(f, fitFormantScale(f).deltaF);
    assert.ok(Math.abs(residualScaleFactor(held) - 1) < 1e-12, `held /${v}/ ρ`);
  }
  // Which is why the classifier normalises: a held /i/ is ~1.0 away from a pooled-frame /i/
  // template, far outside the gate. The number is asserted so the regression cannot come back.
  const pooledT = buildTemplates(FULL_SET, { frame: 'pooled' });
  const fi = formantsOf('i', 'male');
  const heldI = formantPatternResiduals(fi, fitFormantScale(fi).deltaF).slice(0, 3);
  const dPooled = templateDistance(heldI, pooledT.i, 3, residualSdFor('pooled'));
  assert.ok(dPooled > 0.9, `held /i/ to pooled-frame /i/ template = ${dPooled.toFixed(3)}`);
  // Against the shipped (invariant) templates the same held vowel is right on top of its own.
  const dInv = templateDistance(heldI, VOWEL_TEMPLATES.i, 2, invSd);
  assert.ok(dInv < 0.3, `held /i/ to shipped /i/ template = ${dInv.toFixed(3)}`);
});

test('the shipped vowel templates are the fixture\'s own residuals, not free parameters', () => {
  // Same discipline as RESONANCE_V2_REFERENCE_DELTA_F_HZ: recompute from the committed norms.
  const rebuilt = buildTemplates();
  for (const v of FULL_SET) {
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(VOWEL_TEMPLATES[v][i] - rebuilt[v][i]) < 5e-4,
        `/${v}/ r${i + 1}: constant ${VOWEL_TEMPLATES[v][i]}, fixture gives ${rebuilt[v][i].toFixed(4)}`);
    }
  }
  const sdVec = residualSdFor('invariant');
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(VOWEL_RESIDUAL_SD[i] - sdVec[i]) < 5e-4,
      `VOWEL_RESIDUAL_SD[${i}] = ${VOWEL_RESIDUAL_SD[i]}, fixture gives ${sdVec[i].toFixed(4)}`);
  }
  // The scatter that sets the posterior width is the measured male↔female distance per vowel.
  const scatter = mean(FULL_SET.map((v, i) => templateDistance(
    pbSpeaker('male').residuals[i], pbSpeaker('female').residuals[i], 2, sdVec)));
  assert.ok(Math.abs(VOWEL_SPEAKER_SCATTER - scatter) < 0.01,
    `VOWEL_SPEAKER_SCATTER = ${VOWEL_SPEAKER_SCATTER}, measured ${scatter.toFixed(4)}`);
});

test('§5 acceptance: vowel classification is speaker-independent, held out across speakers', () => {
  // The classification is speaker-independent BY CONSTRUCTION because the input is
  // scale-normalised — but "by construction" is an argument, not a measurement. This is the
  // measurement: templates built from ONE sex, tested on the other, across a 16.5% difference
  // in pooled tract scale.
  const scaleGap = pbSpeaker('female').scaleHz / pbSpeaker('male').scaleHz - 1;
  assert.ok(scaleGap > 0.15, `pooled scale gap = ${(100 * scaleGap).toFixed(1)}%`);

  const e = classifierEval(FULL_SET);
  assert.equal(e.n, 20, 'ten vowels, both directions');
  // 95%: nineteen of twenty, both directions, with no abstentions on clean norms.
  assert.ok(e.accuracy >= 0.95, `held-out accuracy = ${(100 * e.accuracy).toFixed(1)}%`);
  assert.ok(e.abstentionRate <= 0.05, `abstention = ${(100 * e.abstentionRate).toFixed(1)}%`);
  // On the seven-vowel §1.1 set — the ruler the rest of the benchmark is quoted on — it is
  // perfect, which locates the entire remaining error in the three vowels outside it.
  const bench = classifierEval(BENCH_SET);
  assert.equal(bench.correct, bench.n, `seven-vowel set: ${bench.correct}/${bench.n}`);
});

test('§5 + §6: /ɝ/ is the one confusion, and the dimension that would fix it is Phase 3\'s', () => {
  // Phase 1 handed this over explicitly, and the answer has two halves that must both be
  // recorded or the next phase will inherit a false premise.
  const e = classifierEval(FULL_SET);
  // HALF ONE — /ɝ/ is the only error the shipped classifier makes, and it goes to /æ/,
  // exactly as Phase 1 predicted from the residual geometry.
  assert.equal(e.wrong, 1, `errors: ${JSON.stringify(e.confusion)}`);
  assert.ok(e.confusion['ɝ→æ'] === 1, `the one error is ɝ→æ: ${JSON.stringify(e.confusion)}`);

  const invSd = residualSdFor('invariant'), poolSd = residualSdFor('pooled');
  const invT = buildTemplates(), poolT = buildTemplates(FULL_SET, { frame: 'pooled' });
  const iso = (T, v, dims, sdv) => Math.min(...FULL_SET.filter((u) => u !== v)
    .map((u) => templateDistance(T[v], T[u], dims, sdv)));
  // HALF TWO — in the POOLED frame /ɝ/ is not marginal, it is the most isolated vowel in the
  // set: the rhotic F3 that Phase 1 found absorbed into the scale cannot be absorbed when the
  // scale comes from the speaker's other vowels.
  const isoPooled = iso(poolT, 'ɝ', 3, poolSd);
  assert.ok(isoPooled > 1.0, `/ɝ/ isolation in the pooled frame = ${isoPooled.toFixed(2)}`);
  assert.ok(FULL_SET.every((v) => v === 'ɝ' || iso(poolT, v, 3, poolSd) < isoPooled),
    '/ɝ/ is the most isolated vowel in the pooled frame');
  // In the shipped frame it collapses to the crowd.
  assert.ok(iso(invT, 'ɝ', 2, invSd) < 0.5, `/ɝ/ isolation, shipped frame = ${iso(invT, 'ɝ', 2, invSd).toFixed(2)}`);

  // And the reason the pooled frame cannot simply be used: the dimension that isolates /ɝ/ is
  // ρ, and ρ is ALSO exactly what a pooling-window mismatch moves. They are the same number.
  // Using it therefore requires knowing what the window contained — a frame-validity and
  // estimator-discipline question, which is Phase 3. Asserted here so that "leave it for
  // Phase 3" is a recorded decision rather than an omission.
  const rhoRhotic = pbSpeaker('male').rho[FULL_SET.indexOf('ɝ')];
  assert.ok(rhoRhotic < 0.8, `/ɝ/ ρ = ${rhoRhotic.toFixed(3)} — the rhotic signal`);
  const fi = formantsOf('i', 'male');
  const heldRho = residualScaleFactor(formantPatternResiduals(fi, fitFormantScale(fi).deltaF));
  assert.ok(Math.abs(heldRho - 1) < 1e-12, 'a sustained hold pins ρ at 1 regardless of vowel');
});

test('§6: the classifier abstains rather than guessing, and the nucleus rule is what makes it', () => {
  // Two independent ways to decline, both reachable. A residual whose SHAPE is outside the
  // vowel space — not merely scaled oddly, which the classifier is designed to forgive.
  assert.equal(classifyVowel([2.5, 0.3, 1.0]).vowel, null, 'nothing like a vowel');
  assert.equal(classifyVowel([2.5, 0.3, 1.0]).reason, 'not-a-vowel');
  // The invariance itself, asserted as a property: multiplying the whole vector by a constant
  // is exactly what a pooling-window mismatch does, and it must not change the answer.
  const ref = [0.4663, 1.3595, 1.0174];
  for (const k of [0.7, 1, 1.4]) {
    assert.equal(classifyVowel(ref.map((x) => x * k)).vowel, 'i', `uniform ×${k} changed the identity`);
  }
  assert.equal(classifyVowel([1.0]).vowel, null, 'one residual is not a vowel');
  assert.equal(classifyVowel([1.0]).reason, 'insufficient-dimensions');
  assert.equal(classifyVowel(null).vowel, null);
  // A point placed midway between two templates is refused, not assigned to the nearer one.
  const mid = [0, 1, 2].map((i) => (VOWEL_TEMPLATES['ɑ'][i] + VOWEL_TEMPLATES['ʌ'][i]) / 2);
  const c = classifyVowel(mid, { preNormalized: true });
  assert.equal(c.vowel, null, `midpoint of /ɑ/ and /ʌ/ classified as ${c.vowel}`);
  assert.equal(c.reason, 'ambiguous');
  // Never a fabricated reading on an unnamed frame.
  assert.equal(f2PositionFromResidual([1, 1.2, 1], null), 0);
  assert.equal(f2Position({ f2Hz: 1800, vowel: null, deltaFFrameHz: 1100 }), 0);
  assert.equal(f2Position({ f2Hz: 0, vowel: 'i', deltaFFrameHz: 1100 }), 0);
  assert.equal(expectedF2Hz('not-a-vowel', 1100), 0);

  // THE HONEST PART. Frame by frame the two gates are NOT sufficient: they catch a residual
  // thrown away from every template, or landing between two, but not one thrown squarely onto
  // a neighbour — and at low noise that is the likeliest way to be wrong. Measured, per frame,
  // misclassification exceeds abstention.
  const frame = [1, 2, 3].map((s) => classifierEval(FULL_SET, { jitter: 0.3, seed: s }))
    .reduce((a, e) => ({ wrong: a.wrong + e.wrong, abstain: a.abstain + e.abstain, n: a.n + e.n }),
      { wrong: 0, abstain: 0, n: 0 });
  assert.ok(frame.wrong > frame.abstain,
    `per frame at 0.3 SD noise: ${frame.wrong} wrong vs ${frame.abstain} abstained`);

  // What makes §6 hold is the nucleus rule — three consecutive frames must agree before any
  // nucleus exists — which is why f2Position is aggregated and never read off one frame. Same
  // noise, same classifier, ~an order of magnitude less misclassification.
  const nuc = [1, 2, 3].map((s) => nucleusEval(FULL_SET, { jitter: 0.3, seed: s }))
    .reduce((a, e) => ({ wrong: a.wrong + e.wrong, abstain: a.abstain + e.abstain, n: a.n + e.n }),
      { wrong: 0, abstain: 0, n: 0 });
  assert.ok(nuc.wrong / nuc.n < frame.wrong / frame.n / 2,
    `per nucleus ${(100 * nuc.wrong / nuc.n).toFixed(1)}% wrong vs per frame ${(100 * frame.wrong / frame.n).toFixed(1)}%`);
  assert.ok(nuc.abstain >= nuc.wrong,
    `per nucleus it must decline more often than it guesses wrong: ${nuc.abstain} vs ${nuc.wrong}`);
});

test('§5: the classifier works on three formants and does not degrade on four', () => {
  // P&B publishes no F4, so the whole classification result above is already the
  // F4-unavailable operating point. This checks the other branch.
  const r = f4Eval(FULL_SET, { formantNoiseHz: 60 });
  const acc = (o) => o.correct / r.n;
  assert.ok(acc(r.withF4) >= acc(r.withoutF4) - 0.02,
    `with F4 ${(100 * acc(r.withF4)).toFixed(1)}% vs without ${(100 * acc(r.withoutF4)).toFixed(1)}%`);
  // It does not IMPROVE either, and the reason is structural rather than a shortfall: the
  // classifier matches in the scale-invariant frame, so the very normalisation that lets it
  // survive a sustained hold divides out what F4 contributes to the scale. Recorded so the
  // next phase does not expect F4 to have helped here.
  assert.ok(Math.abs(acc(r.withF4) - acc(r.withoutF4)) < 0.02, 'F4 is neutral for classification');
  // The classifier's frame is F1-F3 and is pinned there. Feeding a 4-element residual must not
  // silently renormalise onto a different constraint surface — that regression cost 47 points
  // of frame yield under `lpc` when it was live.
  assert.equal(VOWEL_TEMPLATE_FORMANTS, 3);
  const three = [0.4663, 1.3595, 1.0174];
  assert.equal(classifyVowel(three).vowel, 'i');
  assert.equal(classifyVowel([...three, 1.4]).vowel, 'i', 'a fourth residual must not change the identity');
});

test('§5 acceptance, as written: f2Position does NOT beat raw F2 on the male-vs-female contrast', () => {
  // Reported as a miss, with the number, because it is one. §5 asks f2Position to beat raw
  // F2's d′ 0.38 on the P&B benchmark; measured on that contrast it does not come close.
  const bench = f2PositionSexDPrime(BENCH_SET);
  const all = f2PositionSexDPrime(FULL_SET);
  assert.ok(bench.rawF2.d > bench.f2Position.d,
    `raw F2 ${bench.rawF2.d.toFixed(3)} vs f2Position ${bench.f2Position.d.toFixed(3)}`);
  assert.ok(bench.f2Position.d < 0.4, `f2Position d′ (F vs M, seven-vowel) = ${bench.f2Position.d.toFixed(3)}`);
  assert.ok(all.f2Position.d < 0.4, `f2Position d′ (F vs M, all ten) = ${all.f2Position.d.toFixed(3)}`);

  // WHY, measured rather than argued. d′ on this contrast is a monotone function of how much
  // tract length the feature is allowed to keep, and keeping it means duplicating what
  // formantScale already reports.
  const sweep = f2PositionAlphaSweep(BENCH_SET);
  const at0 = sweep.find((x) => x.alpha === 0), at1 = sweep.find((x) => x.alpha === 1);
  assert.ok(at0.d > 4, `α=0 (population-relative) would score d′ ${at0.d.toFixed(3)}`);
  assert.ok(at0.redundancy > 0.9,
    `...but correlates r = ${at0.redundancy.toFixed(3)} with resonanceAbsoluteV2 — the §1.4 double count rebuilt`);
  assert.ok(Math.abs(at1.redundancy) < 0.2,
    `the shipped α=1 is independent of the scale: r = ${at1.redundancy.toFixed(3)}`);
  // Monotone throughout: there is no α that scores well and stays independent.
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(sweep[i].d < sweep[i - 1].d, `d′ must fall monotonically with α: ${JSON.stringify(sweep.map((x) => +x.d.toFixed(2)))}`);
  }
});

test('§3.1, measured: the conditioning removes the vowel variance that made raw F2 the worst measure', () => {
  // §3.1's claim is that raw F2 scores badly "because it is mostly reporting which vowel was
  // spoken". The benchmark's d′ denominator IS that vowel variance, so the claim is directly
  // checkable: condition on the vowel and the denominator should collapse.
  const templates = buildTemplates(BENCH_SET);
  const M = pbSpeaker('male', BENCH_SET);
  const raw = BENCH_SET.map((v) => formantsOf(v, 'male')[1]);
  const pos = BENCH_SET.map((v, i) => f2PositionFor(M, i, templates));
  const rel = (xs) => sd(xs) / mean(xs);
  assert.ok(rel(raw) > 0.3, `raw F2 across-vowel SD = ${(100 * rel(raw)).toFixed(1)}% of its mean`);
  assert.ok(rel(pos) < 0.05, `f2Position across-vowel SD = ${(100 * rel(pos)).toFixed(2)}% of its mean`);
  assert.ok(rel(raw) / rel(pos) > 8,
    `vowel variance removed: ${(rel(raw) / rel(pos)).toFixed(1)}×`);
});

test('§5, on the contrast the feature is for: f2Position beats raw F2 by ~12× on a published training shift', () => {
  // The same d′ arithmetic, the same data, the same classifier — the only change is the
  // contrast. §1.5 cites a GAVT outcome of F2 1847 → 1961 Hz: a WITHIN-speaker articulatory
  // change at a fixed tract length, which is what an F2 biofeedback target is for and what a
  // user can actually move. Tract length is not trainable; this is.
  assert.ok(Math.abs(GAVT_F2_GAIN - 1961 / 1847) < 1e-9, 'the gain is the published one');
  for (const keys of [BENCH_SET, FULL_SET]) {
    const r = f2PositionTrainingDPrime(keys);
    assert.ok(r.f2Position.d > 1.8,
      `f2Position d′ on the training shift = ${r.f2Position.d.toFixed(3)} (n=${keys.length})`);
    assert.ok(r.rawF2.d < 0.25, `raw F2 d′ on the same shift = ${r.rawF2.d.toFixed(3)}`);
    assert.ok(r.f2Position.d / r.rawF2.d > 10,
      `margin = ${(r.f2Position.d / r.rawF2.d).toFixed(1)}×`);
  }
  // Raw F2 detects the very shift it is promoted as a training target for WORSE than it
  // separates the two P&B populations — 0.16 against 0.48 — because a 6% F2 change is small
  // against a 35% across-vowel spread. That is §3.1's point restated as a measurement.
  const train = f2PositionTrainingDPrime(BENCH_SET);
  const sex = f2PositionSexDPrime(BENCH_SET);
  assert.ok(train.rawF2.d < sex.rawF2.d, `raw F2: ${train.rawF2.d.toFixed(3)} on training vs ${sex.rawF2.d.toFixed(3)} on sex`);
});

test('f2Position is a ratio to the vowel\'s own norm, and carries no tract length', () => {
  // 1.0 = exactly where the published norms put this vowel for a tract of your size.
  for (const v of FULL_SET) {
    const onNorm = VOWEL_TEMPLATES[v][1] * 1.5 * 1100;
    assert.ok(Math.abs(f2Position({ f2Hz: onNorm, vowel: v, deltaFFrameHz: 1100 }) - 1) < 1e-9, `/${v}/`);
  }
  // Scaling the whole tract leaves it alone — that is the point.
  for (const k of [0.85, 1.0, 1.2]) {
    const f = formantsOf('ɛ', 'male').slice(0, 3).map((x) => x * k);
    const df = fitFormantScale([...f, 0]).deltaF;
    const r = formantPatternResiduals([...f, 0], df).slice(0, 3);
    const p = f2PositionFromResidual(normalizeResidualScale(r).residuals, 'ɛ');
    assert.ok(Math.abs(p - f2PositionFromResidual(
      normalizeResidualScale(formantPatternResiduals(
        [...formantsOf('ɛ', 'male').slice(0, 3), 0],
        fitFormantScale(formantsOf('ɛ', 'male')).deltaF).slice(0, 3)).residuals, 'ɛ')) < 1e-9,
      `tract scaled ×${k} moved f2Position`);
  }
  // Raising F2 alone raises it, monotonically and by about the amount F2 moved.
  const base = formantsOf('ɛ', 'male');
  const posFor = (gain) => {
    const f = [base[0], base[1] * gain, base[2], 0];
    const r = formantPatternResiduals(f, fitFormantScale(f).deltaF).slice(0, 3);
    return f2PositionFromResidual(normalizeResidualScale(r).residuals, 'ɛ');
  };
  assert.ok(posFor(1.1) > posFor(1.0) && posFor(1.0) > posFor(0.9));
  const sensitivityPct = (posFor(1.1) - posFor(1.0)) / posFor(1.0) / 0.1;
  assert.ok(sensitivityPct > 0.9 && sensitivityPct <= 1.02,
    `a 10% F2 rise moves f2Position by ${(100 * sensitivityPct * 0.1).toFixed(1)}%`);
});

test('the f2Position display mapping does not clamp on any real reading', () => {
  // Nothing displays this in Phase 2 — §6 is explicit that the user still sees one ring — but
  // the span has to be wide enough now, because a clamped axis is the defect §5 recorded
  // against v1 (five of seven P&B male vowels on a rail). d′ is invariant to any affine
  // rescaling that does not clamp, so this mapping cannot flatter a benchmark number; it can
  // only ruin one by railing. Asserted over every P&B vowel, both sexes, untrained AND after
  // the published training shift.
  for (const gain of [1, GAVT_F2_GAIN]) {
    for (const sex of ['male', 'female']) {
      const spk = pbSpeaker(sex, FULL_SET, { f2Gain: gain });
      const templates = buildTemplates();
      FULL_SET.forEach((v, i) => {
        const ratio = f2PositionFor(spk, i, templates, { oracleVowel: v });
        const shown = f2PositionToDisplay(ratio);
        assert.ok(shown > 0.02 && shown < 0.98,
          `/${v}/ ${sex} gain ${gain}: ratio ${ratio.toFixed(4)} → ${shown.toFixed(4)} is on a rail`);
      });
    }
  }
  // 1.0 sits at the centre, and the mapping is monotone.
  assert.equal(f2PositionToDisplay(1), 0.5);
  assert.ok(f2PositionToDisplay(1.1) > f2PositionToDisplay(1) && f2PositionToDisplay(0.9) < f2PositionToDisplay(1));
  // "No reading" is not a position on the axis.
  assert.equal(f2PositionToDisplay(0), 0);
});
