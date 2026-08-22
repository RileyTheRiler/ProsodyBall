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
} from './dsp-utils.js';
import {
  BENCH_SET, FULL_SET, formantsOf, mean, dPrime, scoreV1, scoreV2,
  sensitivity, v1SensitivityViaDeltaFOnly, SENSITIVITY_REF,
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
