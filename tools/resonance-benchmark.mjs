#!/usr/bin/env node
// The Peterson & Barney d′ benchmark, as a library plus a printable report.
//
// docs/RESONANCE_REDESIGN.md §1.3's table is the primary regression net for every phase after
// Phase 1, so it lives here as code rather than as a number in a document. The assertions are
// in resonance-dprime.test.mjs, which imports these same functions — there is one
// implementation of the benchmark, not one for the test and one for the report.
//
//   d′ = (female mean − male mean) / pooled within-sex across-vowel SD
//
// P&B adult male and female MEAN formants go straight into the scoring functions: no
// estimator, no noise, no smoothing, no pooling. Whatever a microphone adds can only make a
// measure score worse than it does here.
//
// Usage:  node tools/resonance-benchmark.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitFormantDispersion, fitFormantScale, formantPatternResiduals,
  resonanceScoreV1, resonanceAbsoluteV2, RESONANCE_V2_REFERENCE_DELTA_F_HZ,
  poolFormantScale, classifyVowel, f2PositionFromResidual, VOWEL_TEMPLATES, VOWEL_RESIDUAL_SD,
  VOWEL_SPEAKER_SCATTER, findVowelNuclei, normalizeResidualScale, residualScaleFactor,
  clamp01,
} from '../dsp-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PB = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'peterson-barney-1952.json'), 'utf8'));

export const BENCH_SET = PB.benchmarkVowelSet;
export const FULL_SET = Object.keys(PB.vowels);

// [F1, F2, F3, F4] — F4 is 0 throughout because P&B published none, which makes the whole
// benchmark the F4-unavailable operating point v2 has to clear without help.
export function formantsOf(vowel, sex) {
  const f = PB.vowels[vowel][sex];
  return [f.f1, f.f2, f.f3, 0];
}

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

export const scoreV1 = (f) => resonanceScoreV1({
  deltaFHz: fitFormantDispersion([f[0], f[1], f[2]]).deltaF,
  f1: f[0], f2: f[1], vowelLike: true,
}).score;

export const scoreV2 = (f) => resonanceAbsoluteV2(fitFormantScale(f).deltaF);

export function dPrime(scoreFn, vowels = BENCH_SET) {
  const M = vowels.map((v) => scoreFn(formantsOf(v, 'male')));
  const F = vowels.map((v) => scoreFn(formantsOf(v, 'female')));
  return {
    d: (mean(F) - mean(M)) / Math.sqrt((sd(M) ** 2 + sd(F) ** 2) / 2),
    maleSwingPts: 100 * (Math.max(...M) - Math.min(...M)),
    femaleSwingPts: 100 * (Math.max(...F) - Math.min(...F)),
    shiftPts: 100 * (mean(F) - mean(M)),
    maleMeanPts: 100 * mean(M),
    femaleMeanPts: 100 * mean(F),
    M, F,
  };
}

// §1.4's method: numerically differentiate the scoring function. The operating point is the
// reference synthesized vowel F1/F2/F3 = 570/1710/2850 Hz (ΔF = 1140 Hz) that DSP_CONTRACT's
// per-estimator accuracy table also uses; units are score points (0..1) per kHz, as published.
export const SENSITIVITY_REF = [570, 1710, 2850, 0];
export function sensitivity(scoreFn, ref = SENSITIVITY_REF, h = 1) {
  return [0, 1, 2, 3].map((i) => {
    if (!(ref[i] > 0)) return 0;
    const a = ref.slice(), b = ref.slice();
    a[i] += h; b[i] -= h;
    return (scoreFn(a) - scoreFn(b)) / (2 * h) * 1000;
  });
}

// The double-count probe. Perturb F_i but freeze the direct F1/F2 terms at their unperturbed
// values, so only the ΔF path can respond. Whatever the full derivative has beyond that is a
// second path — which is what §1.4 found in v1 and what v2 must not have.
export function v1SensitivityViaDeltaFOnly(ref = SENSITIVITY_REF, h = 1) {
  return [0, 1, 2].map((i) => {
    const perturb = (dh) => {
      const g = ref.slice(); g[i] += dh;
      return resonanceScoreV1({
        deltaFHz: fitFormantDispersion([g[0], g[1], g[2]]).deltaF,
        f1: ref[0], f2: ref[1], vowelLike: true,
      }).score;
    };
    return (perturb(h) - perturb(-h)) / (2 * h) * 1000;
  });
}

// ============================================================================
// PHASE 2 — vowel conditioning (docs/RESONANCE_REDESIGN.md §5)
// ============================================================================

// A "speaker" in this benchmark is a whole vowel inventory, not one vowel, because the app's
// scale is POOLED over a rolling window that spans several vowels (Phase 1, §5). Fitting a
// scale to one vowel and then normalising that same vowel by it is the §1.1 error in
// miniature — and, per the rank identity in dsp-utils.js, it also destroys the third
// dimension of the residual vector. So the P&B analogue of the app's operating point is: pool
// the speaker's ΔF over the vowels they produced, exactly as poolFormantScale does live.
//
// `f2Gain` multiplies F2 throughout, which is how a within-speaker articulatory change is
// modelled: same tract, different tongue and lip posture. Used for the training-shift contrast.
export function pbSpeaker(sex, vowels = FULL_SET, { f2Gain = 1 } = {}) {
  const formants = vowels.map((v) => {
    const f = formantsOf(v, sex).slice();
    f[1] *= f2Gain;
    return f;
  });
  const scaleHz = poolFormantScale(
    formants.map((f) => ({ deltaF: fitFormantScale(f).deltaF, weight: 1 })),
    { minSamples: 4 },
  ).deltaF;
  const pooled = formants.map((f) => formantPatternResiduals(f, scaleHz).slice(0, 3));
  return {
    sex, vowels, scaleHz, formants,
    // Against the speaker's POOLED scale — what a frame of connected speech carries, and the
    // frame /ɝ/ is visible in.
    pooledResiduals: pooled,
    // The scale-invariant frame the classifier actually matches in. Identical to the residuals
    // of a scale fitted to each vowel alone, which is why it is also what a sustained hold
    // produces — the one frame that means the same thing in both operating points.
    residuals: pooled.map((r) => normalizeResidualScale(r).residuals),
    // ρ per vowel: how far that vowel's own apparent scale sits from the speaker's pooled one.
    // The rhotic signal, and the pooling-window artefact, in one number. Phase 3's inheritance.
    rho: pooled.map((r) => residualScaleFactor(r)),
  };
}

// Templates rebuilt from the fixture at the requested operating point. `sexes` is what makes
// the held-out test possible: build from ['male'] and classify the female norms, and the
// classifier has never seen a speaker anywhere near the tract length it is being tested on.
export function buildTemplates(vowels = FULL_SET, { sexes = ['male', 'female'], f2Gain = 1, frame = 'invariant' } = {}) {
  const spk = sexes.map((s) => pbSpeaker(s, vowels, { f2Gain }));
  const key = frame === 'pooled' ? 'pooledResiduals' : 'residuals';
  const out = {};
  vowels.forEach((v, i) => {
    out[v] = [0, 1, 2].map((k) => mean(spk.map((sp) => sp[key][i][k])));
  });
  return out;
}

// Classification over the P&B norms. `heldOut` is the honest setting: templates from one sex,
// test points from the other. Speaker-independence demonstrated across a 16.5% difference in
// pooled tract scale rather than asserted from the fact that the input was normalised.
export function classifierEval(vowels = FULL_SET, { heldOut = true, dims = null, jitter = 0, seed = 1 } = {}) {
  // Deterministic LCG + Box-Muller, so a reported robustness curve is reproducible.
  // `jitter` is the SD of the added noise as a fraction of each dimension's across-vowel SD.
  let st = seed >>> 0;
  const uni = () => ((st = (st * 1664525 + 1013904223) >>> 0) + 1) / 4294967297;
  const rnd = () => Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni());
  const pairs = heldOut
    ? [['male', 'female'], ['female', 'male']]
    : [[null, 'male'], [null, 'female']];
  const perVowel = {}, confusion = {};
  // matrix[trueVowel][predicted | '—'] — the acceptance criterion asks for this explicitly,
  // with abstention as its own column rather than folded into the errors.
  const matrix = {};
  let correct = 0, wrong = 0, abstain = 0;
  const abstainReasons = {};
  for (const v of vowels) { perVowel[v] = { correct: 0, wrong: 0, abstain: 0, got: [] }; matrix[v] = {}; }
  for (const [trainSex, testSex] of pairs) {
    const templates = buildTemplates(vowels, { sexes: trainSex ? [trainSex] : ['male', 'female'] });
    const spk = pbSpeaker(testSex, vowels);
    vowels.forEach((v, i) => {
      const r = spk.residuals[i].map((x, k) => x + jitter * rnd() * VOWEL_RESIDUAL_SD[k]);
      const c = classifyVowel(r, { templates, dims, preNormalized: true });
      const cell = c.vowel || '—';
      matrix[v][cell] = (matrix[v][cell] || 0) + 1;
      if (c.vowel === null) {
        abstain++; perVowel[v].abstain++; perVowel[v].got.push(`—/${c.reason}`);
        abstainReasons[c.reason] = (abstainReasons[c.reason] || 0) + 1;
      } else if (c.vowel === v) {
        correct++; perVowel[v].correct++; perVowel[v].got.push('ok');
      } else {
        wrong++; perVowel[v].wrong++; perVowel[v].got.push(`→${c.vowel}`);
        confusion[`${v}→${c.vowel}`] = (confusion[`${v}→${c.vowel}`] || 0) + 1;
      }
    });
  }
  const n = correct + wrong + abstain;
  return {
    n, correct, wrong, abstain, confusion, perVowel, abstainReasons, matrix,
    accuracy: n ? correct / n : 0,                             // over ALL frames
    accuracyDecided: correct + wrong ? correct / (correct + wrong) : 0, // over frames it answered
    abstentionRate: n ? abstain / n : 0,
  };
}

// --- Does F4 help? -----------------------------------------------------------
//
// §5's requirement is that the classifier work on a 3-element vector (P&B publishes no F4) and
// "improve, or at least not degrade, when F4 is present". F4 cannot add a template dimension —
// there is no measured r₄ to build one from, and inventing one would be exactly the fabrication
// §6 forbids. What it can do is make the SCALE better determined, and the residuals are all
// divided by that scale, so a steadier scale is a steadier residual.
//
// That is the claim this measures, under realistic formant-estimator error in Hz rather than
// in residual units. F4 is supplied model-consistently (3.5·ΔF of the unperturbed vowel), which
// is the same F4 Phase 1's test uses, and is then perturbed like every other formant.
export function f4Eval(vowels = FULL_SET, { formantNoiseHz = 60, seed = 1, trials = 200 } = {}) {
  let st = seed >>> 0;
  const uni = () => ((st = (st * 1664525 + 1013904223) >>> 0) + 1) / 4294967297;
  const rnd = () => Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni());
  const out = { withF4: { correct: 0, wrong: 0, abstain: 0 }, withoutF4: { correct: 0, wrong: 0, abstain: 0 }, n: 0 };
  for (let t = 0; t < trials; t++) {
    for (const [trainSex, testSex] of [['male', 'female'], ['female', 'male']]) {
      const templates = buildTemplates(vowels, { sexes: [trainSex] });
      for (const v of vowels) {
        const clean = formantsOf(v, testSex).slice(0, 3);
        const f4 = 3.5 * fitFormantScale([...clean, 0]).deltaF;
        // One noise draw, shared between the two conditions, so the comparison is paired and
        // the difference is F4's presence rather than a different roll of the dice.
        const eps = [rnd(), rnd(), rnd(), rnd()].map((z) => z * formantNoiseHz);
        const noisy = clean.map((f, i) => f + eps[i]);
        const variants = {
          withoutF4: [...noisy, 0],
          withF4: [...noisy, f4 + eps[3]],
        };
        for (const [key, formants] of Object.entries(variants)) {
          const df = fitFormantScale(formants).deltaF;
          const r = formantPatternResiduals(formants, df).slice(0, 3);
          const c = classifyVowel(r, { templates, preNormalized: true, dims: 2 });
          if (c.vowel === null) out[key].abstain++;
          else if (c.vowel === v) out[key].correct++;
          else out[key].wrong++;
        }
        out.n++;
      }
    }
  }
  return out;
}

// Per-vowel residual fitted to that vowel ALONE — Phase 1's operating point. It is
// ALGEBRAICALLY the same as the scale-invariant frame (both satisfy Σ L_i r_i = 1), which is
// the compact statement of what Phase 2 gave up: the frame that survives a sustained hold is
// the frame in which the residuals do not flag /ɝ/. Kept as its own function so the equality
// is asserted rather than assumed.
// Per-NUCLEUS classification under the same noise, which is what the app actually consumes.
//
// The frame-level curve above is not the whole story, because no feature is read off one
// frame: findVowelNuclei only opens a nucleus after `minFrames` CONSECUTIVE frames agree on
// the same vowel, and takes the median over it. An isolated frame thrown onto a neighbouring
// template by noise therefore never becomes a nucleus — it breaks the run instead. This
// measures how much of the frame-level error that removes, rather than assuming it removes any.
export function nucleusEval(vowels = FULL_SET, { jitter = 0, seed = 1, frames = 12, minFrames = 3, dims = null } = {}) {
  let st = seed >>> 0;
  const uni = () => ((st = (st * 1664525 + 1013904223) >>> 0) + 1) / 4294967297;
  const rnd = () => Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni());
  let correct = 0, wrong = 0, abstain = 0;
  for (const [trainSex, testSex] of [['male', 'female'], ['female', 'male']]) {
    const templates = buildTemplates(vowels, { sexes: [trainSex] });
    const spk = pbSpeaker(testSex, vowels);
    vowels.forEach((v, i) => {
      // One steady production of /v/: `frames` consecutive frames of the same vowel, each
      // carrying independent estimator noise.
      const samples = [];
      for (let k = 0; k < frames; k++) {
        const r = spk.residuals[i].map((x, d) => x + jitter * rnd() * VOWEL_RESIDUAL_SD[d]);
        const c = classifyVowel(r, { templates, dims, preNormalized: true });
        samples.push({ value: 1, weight: 1, vowel: c.vowel, index: k });
      }
      const nuclei = findVowelNuclei(samples, { minFrames });
      if (!nuclei.length) { abstain++; return; }
      // The production is scored by the longest nucleus it produced.
      const best = nuclei.slice().sort((a, b) => b.frames - a.frames)[0];
      if (best.vowel === v) correct++; else wrong++;
    });
  }
  const n = correct + wrong + abstain;
  return { n, correct, wrong, abstain, accuracy: correct / n, abstentionRate: abstain / n };
}

export function perVowelResiduals(vowel, sex) {
  const f = formantsOf(vowel, sex);
  return formantPatternResiduals(f, fitFormantScale(f).deltaF).slice(0, 3);
}

// Distance in the classifier's own metric, so isolation figures below are the numbers the
// classifier actually sees.
export function templateDistance(a, b, dims = 3, sdVec = VOWEL_RESIDUAL_SD) {
  let s = 0, n = 0;
  for (let i = 0; i < dims; i++) {
    if (a[i] == null || b[i] == null) continue;
    s += ((a[i] - b[i]) / sdVec[i]) ** 2; n++;
  }
  return n ? Math.sqrt(s / n) : Infinity;
}

// Across-vowel SD per dimension in a given frame. The shipped constant VOWEL_RESIDUAL_SD is
// this computed on the invariant frame; the pooled frame needs its own, or distances measured
// in the two frames are not on the same ruler and cannot be compared.
export function residualSdFor(frame = 'invariant', vowels = FULL_SET) {
  const key = frame === 'pooled' ? 'pooledResiduals' : 'residuals';
  const rows = ['male', 'female'].flatMap((s) => pbSpeaker(s, vowels)[key]);
  return [0, 1, 2].map((i) => sd(rows.map((r) => r[i])));
}

// --- f2Position ------------------------------------------------------------
//
// Raw F2 normalised over 1000–2400 Hz, exactly as §1.3's table scores it: the measure
// f2Position has to beat, and the reason §3.1 says the conditioning is the whole feature.
export const rawF2Score = (f) => (f[1] - 1000) / 1400;

// f2Position with the vowel supplied by the classifier rather than by an oracle, so what is
// measured is the shipped pipeline including its mistakes and its abstentions. Returns null
// when the classifier declined — those frames are counted, not silently filled in.
export function f2PositionFor(spk, i, templates, { oracleVowel = null, dims = null } = {}) {
  const vowel = oracleVowel
    || classifyVowel(spk.residuals[i], { templates, dims, preNormalized: true }).vowel;
  if (!vowel) return null;
  return f2PositionFromResidual(spk.residuals[i], vowel, templates);
}

// The benchmark's d′ arithmetic, over an arbitrary two-group contrast. Phase 1 only ever
// needed male-vs-female; Phase 2 needs untrained-vs-trained on the same speaker as well,
// and using one function for both is what makes the two numbers comparable.
export function dPrimeOf(groupA, groupB) {
  const A = groupA.filter((x) => x != null), B = groupB.filter((x) => x != null);
  if (A.length < 2 || B.length < 2) return { d: NaN, nA: A.length, nB: B.length };
  return {
    d: (mean(B) - mean(A)) / Math.sqrt((sd(A) ** 2 + sd(B) ** 2) / 2),
    meanA: mean(A), meanB: mean(B), sdA: sd(A), sdB: sd(B), nA: A.length, nB: B.length,
  };
}

// CONTRAST 1 — the literal §5 acceptance criterion: female norms vs male norms.
export function f2PositionSexDPrime(vowels = FULL_SET, opts = {}) {
  const templates = buildTemplates(vowels);
  const M = pbSpeaker('male', vowels), F = pbSpeaker('female', vowels);
  return {
    f2Position: dPrimeOf(vowels.map((v, i) => f2PositionFor(M, i, templates, opts)),
      vowels.map((v, i) => f2PositionFor(F, i, templates, opts))),
    rawF2: dPrimeOf(vowels.map((v) => rawF2Score(formantsOf(v, 'male'))),
      vowels.map((v) => rawF2Score(formantsOf(v, 'female')))),
  };
}

// CONTRAST 2 — the same arithmetic on the contrast f2Position is actually for.
//
// §1.5 cites a published GAVT outcome: F2 rising 1847 → 1961 Hz with training. That is a
// WITHIN-speaker articulatory change at a fixed tract length, which is what an F2 biofeedback
// target is for and what a user can actually move. The ratio is a published effect size, not
// a number chosen here.
export const GAVT_F2_HZ = [1847, 1961];
export const GAVT_F2_GAIN = GAVT_F2_HZ[1] / GAVT_F2_HZ[0];

export function f2PositionTrainingDPrime(vowels = FULL_SET, { gain = GAVT_F2_GAIN, ...opts } = {}) {
  const templates = buildTemplates(vowels);
  const pre = [], post = [], preRaw = [], postRaw = [];
  for (const sex of ['male', 'female']) {
    const a = pbSpeaker(sex, vowels), b = pbSpeaker(sex, vowels, { f2Gain: gain });
    vowels.forEach((v, i) => {
      pre.push(f2PositionFor(a, i, templates, opts));
      post.push(f2PositionFor(b, i, templates, opts));
      preRaw.push(rawF2Score(a.formants[i]));
      postRaw.push(rawF2Score(b.formants[i]));
    });
  }
  return { f2Position: dPrimeOf(pre, post), rawF2: dPrimeOf(preRaw, postRaw), gain };
}

// The knob that would have made contrast 1 pass, measured so that not turning it is a
// recorded decision rather than an omission.
//
//   f2Position(α) = F2 / (r₂_template · 1.5 · ΔF_speaker^α · ΔF_ref^(1−α))
//
// α = 1 is the shipped definition — scale-relative, the trainable quantity, carrying no tract
// length. α = 0 divides by a fixed population reference instead, which puts tract length back
// in and sends the male-vs-female d′ up to ~5.8 — at the cost of correlating r ≈ 0.95 with
// resonanceAbsoluteV2, i.e. re-reporting what formantScale already reports. That is §1.4's
// double count coming back through a different door, so α stays at 1.
export function f2PositionAlphaSweep(vowels = FULL_SET, alphas = [0, 0.25, 0.5, 0.75, 1]) {
  const templates = buildTemplates(vowels);
  const M = pbSpeaker('male', vowels), F = pbSpeaker('female', vowels);
  // α = 1: the SHIPPED denominator — r₂_template · 1.5 · ΔF_frame, i.e. the speaker's own scale.
  const denomShipped = (spk, i) => templates[vowels[i]][1] * 1.5 * spk.scaleHz * spk.rho[i];
  // α = 0: the population's expected F2 for this vowel in Hz, with no scale normalisation at
  // all — the "vowel-conditioned but tract-size-preserving" alternative.
  const denomPop = (i) => mean(['male', 'female'].map((sx) => formantsOf(vowels[i], sx)[1]));
  const at = (spk, i, a) => spk.formants[i][1]
    / ((denomShipped(spk, i) ** a) * (denomPop(i) ** (1 - a)));
  return alphas.map((a) => ({
    alpha: a,
    d: dPrimeOf(vowels.map((v, i) => at(M, i, a)), vowels.map((v, i) => at(F, i, a))).d,
    // Correlation with the tract-size measure formantScale already publishes. A feature that
    // scores well here by correlating with that one is not adding information, it is repeating it.
    redundancy: pearson(
      vowels.flatMap((v, i) => [at(M, i, a), at(F, i, a)]),
      vowels.flatMap(() => [resonanceAbsoluteV2(M.scaleHz), resonanceAbsoluteV2(F.scaleHz)]),
    ),
  }));
}

export function pearson(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return den > 0 ? num / den : 0;
}

function fmtRow(cells, widths) {
  return cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const W = [6, 8, 8, 9, 8, 8];
  console.log('\n=== Peterson & Barney (1952) d′ benchmark — ground-truth means, no estimator ===\n');

  console.log('Per-vowel scores (0-100), adult male / adult female means:');
  console.log(fmtRow(['vowel', 'ΔF v1', 'ΔF v2', 'aVTL v2', 'v1 M', 'v1 F', 'v2 M', 'v2 F'], [...W, 8, 8]));
  for (const v of BENCH_SET) {
    const m = formantsOf(v, 'male'), f = formantsOf(v, 'female');
    console.log(fmtRow([
      `/${v}/`,
      fitFormantDispersion([m[0], m[1], m[2]]).deltaF.toFixed(0),
      fitFormantScale(m).deltaF.toFixed(0),
      (35000 / (2 * fitFormantScale(m).deltaF)).toFixed(1) + 'cm',
      (100 * scoreV1(m)).toFixed(1),
      (100 * scoreV1(f)).toFixed(1),
      (100 * scoreV2(m)).toFixed(1),
      (100 * scoreV2(f)).toFixed(1),
    ], [...W, 8, 8]));
  }

  console.log('\nAcceptance criteria (§5):');
  const sets = [
    ['seven-vowel §1.1 set (the ruler v1 is quoted on)', BENCH_SET],
    ['all ten P&B vowels', FULL_SET],
    ['all ten less /ɝ/ (rhotic F3 is not a tract length)', FULL_SET.filter((v) => v !== 'ɝ')],
  ];
  for (const [name, keys] of sets) {
    const a = dPrime(scoreV1, keys), b = dPrime(scoreV2, keys);
    console.log(`\n  ${name}  (n=${keys.length})`);
    console.log(`    v1  d′ ${a.d.toFixed(3)}   across-vowel swing ${a.maleSwingPts.toFixed(1)} pts (M) / ${a.femaleSwingPts.toFixed(1)} (F)   M→F shift ${a.shiftPts.toFixed(1)} pts   means ${a.maleMeanPts.toFixed(1)} → ${a.femaleMeanPts.toFixed(1)}`);
    console.log(`    v2  d′ ${b.d.toFixed(3)}   across-vowel swing ${b.maleSwingPts.toFixed(1)} pts (M) / ${b.femaleSwingPts.toFixed(1)} (F)   M→F shift ${b.shiftPts.toFixed(1)} pts   means ${b.maleMeanPts.toFixed(1)} → ${b.femaleMeanPts.toFixed(1)}`);
  }

  console.log(`\nPer-formant sensitivity — numerically differentiated at F1/F2/F3 = ${SENSITIVITY_REF.slice(0, 3).join('/')} Hz`);
  console.log('(§1.4\'s method and operating point; score points per kHz, score in 0..1)');
  const s1 = sensitivity(scoreV1), s2 = sensitivity(scoreV2);
  const via = v1SensitivityViaDeltaFOnly();
  const t1 = s1.slice(0, 3).reduce((a, b) => a + b, 0);
  const t2 = s2.slice(0, 3).reduce((a, b) => a + b, 0);
  console.log(fmtRow(['', 'v1 ∂', 'share', 'via ΔF', '2nd path', 'v2 ∂', 'share'], [6, 8, 7, 8, 9, 8, 7]));
  for (const i of [0, 1, 2]) {
    console.log(fmtRow([
      `F${i + 1}`,
      s1[i].toFixed(3), (100 * s1[i] / t1).toFixed(0) + '%',
      via[i].toFixed(3), (s1[i] - via[i]).toFixed(3),
      s2[i].toFixed(3), (100 * s2[i] / t2).toFixed(0) + '%',
    ], [6, 8, 7, 8, 9, 8, 7]));
  }
  console.log('  "2nd path" is the sensitivity that survives freezing the ΔF route. Nonzero = the');
  console.log('  formant enters the score twice. v2 is zero on every row, by construction.');
  const withF4 = [570, 1710, 2850, 3990];
  const s2f4 = sensitivity(scoreV2, withF4);
  const t2f4 = s2f4.reduce((a, b) => a + b, 0);
  console.log(`\n  v2 with F4 present (${withF4[3]} Hz): ` +
    s2f4.map((v, i) => `F${i + 1} ${v.toFixed(3)} (${(100 * v / t2f4).toFixed(0)}%)`).join('  '));

  console.log('\nFormant pattern residuals r_i = F_i / ((i-0.5)·ΔF) — the Phase 2 input');
  console.log(fmtRow(['vowel', 'r1 M', 'r2 M', 'r3 M', 'r1 F', 'r2 F', 'r3 F', 'max |Δ|'], [6, 7, 7, 7, 7, 7, 7, 8]));
  for (const v of FULL_SET) {
    const m = formantsOf(v, 'male'), f = formantsOf(v, 'female');
    const rm = formantPatternResiduals(m, fitFormantScale(m).deltaF);
    const rf = formantPatternResiduals(f, fitFormantScale(f).deltaF);
    const maxD = Math.max(...[0, 1, 2].map((i) => Math.abs(rm[i] - rf[i])));
    console.log(fmtRow([`/${v}/`, ...rm.slice(0, 3).map((x) => x.toFixed(3)),
      ...rf.slice(0, 3).map((x) => x.toFixed(3)), maxD.toFixed(3)], [6, 7, 7, 7, 7, 7, 7, 8]));
  }
  console.log('  Vowel identity moves r₁ by ~1.0; speaker sex moves it by ~0.05. That inversion is');
  console.log('  what makes a vowel classifier built on these speaker-independent (Phase 2).');
  console.log(`\n  v2 reference dispersion: ${RESONANCE_V2_REFERENCE_DELTA_F_HZ} Hz ` +
    `(P&B grand mean over the benchmark set, both sexes: ` +
    `${mean(BENCH_SET.flatMap((v) => ['male', 'female'].map((s) => fitFormantScale(formantsOf(v, s)).deltaF))).toFixed(1)} Hz)`);

  // ======================= PHASE 2 =======================
  console.log('\n\n=== PHASE 2 — vowel conditioning (§5) ===');

  console.log('\n--- How many dimensions the residual vector has ---');
  console.log('  Phase 1 warned: r₃ ≈ 1.0 everywhere, so measure the dimensionality rather than');
  console.log('  assuming three. The answer is exact, and it depends on where ΔF came from.');
  {
    let worst = 0;
    for (const v of FULL_SET) {
      const f = formantsOf(v, 'male');
      const fit = fitFormantScale(f);
      const r = formantPatternResiduals(f, fit.deltaF);
      const acc = [0, 1, 2].reduce((a, i) => a + fit.leverage[i] * ((2 * (i + 1) - 1) / 2) * r[i], 0);
      worst = Math.max(worst, Math.abs(acc - 1));
    }
    console.log(`\n  Σ L_i·r_i ≡ 1 whenever ΔF is fitted to the same frame's formants.`);
    console.log(`  max |Σ L_i·r_i − 1| over all ten vowels = ${worst.toExponential(2)} — an identity, not an approximation.`);
    console.log('  So n formants carry exactly n−1 free residual dimensions: F1–F3 gives TWO.');
    const spread = (rows, i) => {
      const xs = rows.map((r) => r[i]);
      return `${Math.min(...xs).toFixed(3)}–${Math.max(...xs).toFixed(3)}`;
    };
    const inv = ['male', 'female'].flatMap((s) => pbSpeaker(s).residuals);
    const pooled = ['male', 'female'].flatMap((s) => pbSpeaker(s).pooledResiduals);
    console.log(`\n  r₃, scale-invariant frame (what the classifier matches): ${spread(inv, 2)}`);
    console.log(`  r₃, pooled-window frame (a frame of connected speech) : ${spread(pooled, 2)}`);
    console.log('  Pooling ΔF over several vowels breaks the identity and opens a third dimension.');
    console.log(`  ρ = Σ L_i·r_i per vowel at the pooled scale: ` +
      FULL_SET.map((v, i) => `${v} ${pbSpeaker('male').rho[i].toFixed(2)}`).join(' '));
    console.log('  But a SUSTAINED HOLD collapses the window onto one vowel, so ρ → 1 and the third');
    console.log('  dimension closes again. Held vowels are the exercise mode the ball runs, so the');
    console.log('  classifier has to work in both — which means matching in the invariant frame and');
    console.log('  living with two dimensions. Measured cost of getting this wrong: a held /i/ sits');
    console.log('  1.011 from a pooled-frame /i/ template, against a 0.585 gate — mass abstention');
    console.log('  through an entire sustained vowel.');
  }

  console.log('\n--- Is /ɝ/ separable? ---');
  {
    const invT = buildTemplates();
    const poolT = buildTemplates(FULL_SET, { frame: 'pooled' });
    const invSd = residualSdFor('invariant'), poolSd = residualSdFor('pooled');
    const iso = (T, v, dims, sdv) => Math.min(...FULL_SET.filter((u) => u !== v).map((u) => templateDistance(T[v], T[u], dims, sdv)));
    console.log('  In the POOLED frame (3-d), distance to the nearest other vowel template:');
    console.log('   ' + FULL_SET.map((v) => [v, iso(poolT, v, 3, poolSd)]).sort((a, b) => b[1] - a[1])
      .map(([v, d]) => `/${v}/ ${d.toFixed(2)}`).join('  '));
    console.log(`  /ɝ/ is the MOST isolated vowel in the set at ${iso(poolT, 'ɝ', 3, poolSd).toFixed(2)} — its r₃ is ${poolT['ɝ'][2].toFixed(3)} against`);
    console.log('  0.94–1.24 for everything else. The rhotic F3 that Phase 1 found absorbed INTO the');
    console.log("  scale cannot be absorbed when the scale comes from the speaker's other vowels.");
    console.log('\n  In the SCALE-INVARIANT frame (2-d), which is what ships:');
    console.log('   ' + FULL_SET.map((v) => [v, iso(invT, v, 2, invSd)]).sort((a, b) => b[1] - a[1])
      .map(([v, d]) => `/${v}/ ${d.toFixed(2)}`).join('  '));
    console.log(`  /ɝ/ drops to ${iso(invT, 'ɝ', 2, invSd).toFixed(2)}, tied with the closest pairs in the set, and its nearest`);
    console.log(`  neighbour is /æ/ — exactly the confusion Phase 1 predicted.`);
    console.log('\n  ANSWER: /ɝ/ is separable in principle and NOT separable by what Phase 2 ships.');
    console.log('  The dimension that separates it (ρ) is the same dimension a pooling-window');
    console.log('  mismatch moves; they are literally the same number, so using it requires knowing');
    console.log('  what the window contained. That is a frame-validity / estimator-discipline');
    console.log('  question — Phase 3 — and it is left there rather than smuggled in. The cost is');
    console.log('  one confusion in twenty held-out P&B classifications, reported below.');
  }

  console.log('\n--- Vowel classification on P&B means ---');
  console.log('  HELD OUT ACROSS SPEAKERS: templates built from one sex, tested on the other, whose');
  console.log(`  pooled tract scale differs by ${(100 * (pbSpeaker('female').scaleHz / pbSpeaker('male').scaleHz - 1)).toFixed(1)}%. Speaker-independence demonstrated, not asserted.`);
  for (const [name, keys, dims] of [
    ['all ten, 2-d (r₁,r₂) — THE SHIPPED CONFIGURATION', FULL_SET, 2],
    ['all ten, 3-d (r₃ included — not shipped, and worse: see below)', FULL_SET, 3],
    ['seven-vowel §1.1 set, 2-d', BENCH_SET, 2],
  ]) {
    const e = classifierEval(keys, { dims });
    console.log(`\n  ${name}  n=${e.n}`);
    console.log(`    correct ${e.correct} (${(100 * e.accuracy).toFixed(1)}%)   misclassified ${e.wrong} (${(100 * e.wrong / e.n).toFixed(1)}%)   abstained ${e.abstain} (${(100 * e.abstentionRate).toFixed(1)}%)`);
    console.log(`    accuracy among frames it answered: ${(100 * e.accuracyDecided).toFixed(1)}%`);
    if (e.wrong) console.log(`    confusions: ${Object.entries(e.confusion).map(([k, c]) => `${k} ×${c}`).join(', ')}`);
    console.log(`    per vowel (M-trained→F, F-trained→M): ${keys.map((v) => `/${v}/ ${e.perVowel[v].got.join(',')}`).join('  ')}`);
  }
  {
    const e = classifierEval(FULL_SET, { dims: 3, heldOut: false });
    console.log(`\n  For reference, templates built from both sexes (NOT held out): ${(100 * e.accuracy).toFixed(1)}% correct, ${(100 * e.abstentionRate).toFixed(1)}% abstained`);
  }
  console.log('\n  Robustness — the same held-out test with Gaussian noise added to the residuals, SD');
  console.log("  given as a fraction of each dimension's across-vowel SD. 100% on 20 clean points is");
  console.log('  not a claim about noisy frames, so here is how it actually degrades. Per FRAME, and');
  console.log('  per NUCLEUS (12 consecutive noisy frames of one vowel through findVowelNuclei):\n');
  console.log('    noise      per frame                        per nucleus');
  console.log('      SD    correct   wrong  abstain      correct   wrong  abstain');
  for (const j of [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0]) {
    let c = 0, w = 0, a = 0, n = 0, nc = 0, nw = 0, na = 0, nn = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const e = classifierEval(FULL_SET, { jitter: j, seed });
      c += e.correct; w += e.wrong; a += e.abstain; n += e.n;
      const u = nucleusEval(FULL_SET, { jitter: j, seed });
      nc += u.correct; nw += u.wrong; na += u.abstain; nn += u.n;
    }
    const p = (x, t) => (100 * x / t).toFixed(1).padStart(5) + '%';
    console.log(`    ${j.toFixed(2)}   ${p(c, n)}  ${p(w, n)}  ${p(a, n)}       ${p(nc, nn)}  ${p(nw, nn)}  ${p(na, nn)}`);
  }
  console.log('\n  Read the per-frame columns honestly: below ~0.5 SD of noise the classifier');
  console.log('  MISCLASSIFIES more often than it abstains. The two gates catch a frame thrown away');
  console.log('  from every template, or landing between two — neither catches one thrown squarely');
  console.log('  onto a neighbour, and at low noise that is the likeliest way to be wrong. Taken');
  console.log('  frame by frame the classifier does not meet §6.');
  console.log('  What meets §6 is the nucleus rule, which is why f2Position is aggregated and never');
  console.log('  read off a single frame: findVowelNuclei opens a nucleus only after three');
  console.log('  consecutive frames agree, so a lone frame thrown onto a neighbour breaks the run');
  console.log('  instead of becoming one. The per-nucleus columns are what a session statistic');
  console.log('  actually sees. The error that survives there is the honest residual risk, and');
  console.log("  reducing it further is Phase 3's frame-validity work, not a threshold to move here.");

  console.log('\n--- Confusion matrix, held out across speakers (rows = spoken, cols = reported) ---');
  for (const [label, jitter, reps] of [['clean P&B means', 0, 1], ['with 0.2 SD residual noise, 60 draws', 0.2, 60]]) {
    const agg = {};
    for (const v of FULL_SET) agg[v] = {};
    for (let seed = 1; seed <= reps; seed++) {
      const e = classifierEval(FULL_SET, { jitter, seed });
      for (const v of FULL_SET) {
        for (const [k, c] of Object.entries(e.matrix[v])) agg[v][k] = (agg[v][k] || 0) + c;
      }
    }
    const cols = [...FULL_SET, '—'];
    console.log(`\n  ${label}:`);
    console.log('        ' + cols.map((c) => String(c).padStart(5)).join(''));
    for (const v of FULL_SET) {
      const total = Object.values(agg[v]).reduce((a, b) => a + b, 0) || 1;
      console.log(`   /${v}/`.padEnd(8) + cols.map((c) => {
        const n = agg[v][c] || 0;
        return (n ? (100 * n / total).toFixed(0) : '·').padStart(5);
      }).join(''));
    }
    console.log('        (% of that vowel\'s trials; last column is abstention)');
  }

  console.log('\n--- Does F4 help? (§5: work on 3 elements, improve or at least not degrade on 4) ---');
  console.log('    formant noise   F1-F3 correct / wrong / abstain    F1-F4 correct / wrong / abstain');
  for (const nz of [0, 30, 60, 100]) {
    const r = f4Eval(FULL_SET, { formantNoiseHz: nz });
    const fmt = (o) => `${(100 * o.correct / r.n).toFixed(1)}% / ${(100 * o.wrong / r.n).toFixed(1)}% / ${(100 * o.abstain / r.n).toFixed(1)}%`;
    console.log(`      ${String(nz).padStart(3)} Hz       ${fmt(r.withoutF4).padEnd(28)}      ${fmt(r.withF4)}`);
  }
  console.log('    NOT DEGRADED — identical within sampling error — and not improved either. The');
  console.log('    reason is structural rather than disappointing: F4 improves the SCALE (Phase 1');
  console.log('    measured that, and resonanceAbsoluteV2 still benefits), but the classifier matches');
  console.log('    in the scale-invariant frame, so the very normalisation that lets it survive a');
  console.log('    sustained hold also divides out what F4 contributes. A classifier that USED F4');
  console.log('    would need a measured r₄ template, and P&B publishes no F4 to build one from —');
  console.log('    Phase 5\'s real-vowel validation is where that could come from honestly.');

  console.log('\n--- f2Position vs raw F2 ---');
  console.log('  ACCEPTANCE CRITERION AS WRITTEN: female-vs-male d′ on the P&B norms.');
  for (const [name, keys] of [['seven-vowel §1.1 set', BENCH_SET], ['all ten', FULL_SET]]) {
    const r = f2PositionSexDPrime(keys);
    console.log(`    ${name.padEnd(22)} raw F2 d′ ${r.rawF2.d.toFixed(3).padStart(7)}    f2Position d′ ${r.f2Position.d.toFixed(3).padStart(7)}`);
  }
  console.log('    f2Position DOES NOT CLEAR raw F2 on this contrast, and the reason is structural:');
  console.log('    P&B\'s two populations differ in tract SIZE and barely in vowel POSTURE, and');
  console.log('    f2Position has size divided out by construction. The sweep below is the proof —');
  console.log('    d′ here is purely a function of how much tract length is allowed back in:\n');
  console.log('      α      d′ (F vs M)   r with resonanceAbsoluteV2');
  for (const a of f2PositionAlphaSweep(BENCH_SET)) {
    console.log(`      ${a.alpha.toFixed(2)}   ${a.d.toFixed(3).padStart(9)}        ${a.redundancy.toFixed(3)}`);
  }
  console.log('    α=0 would "pass" at d′ 5.8 by re-measuring tract length through F2 (r≈0.95 with');
  console.log('    the scale the app already publishes). That is the §1.4 double count rebuilt, so');
  console.log('    the shipped definition stays at α=1 and the criterion is reported as missed.');

  console.log('\n  WHAT THE CONDITIONING DID ACHIEVE — §3.1\'s actual claim, that raw F2 is the worst');
  console.log('  measure because it reports which vowel was spoken. The benchmark\'s d′ denominator');
  console.log('  IS that vowel variance:');
  {
    const tmpl = buildTemplates(BENCH_SET);
    const M = pbSpeaker('male', BENCH_SET);
    const rawVals = BENCH_SET.map((v) => formantsOf(v, 'male')[1]);
    const posVals = BENCH_SET.map((v, i) => f2PositionFor(M, i, tmpl));
    const rel = (xs) => 100 * sd(xs) / mean(xs);
    console.log(`    across-vowel SD of raw F2      ${sd(rawVals).toFixed(1)} Hz  = ${rel(rawVals).toFixed(1)}% of its mean`);
    console.log(`    across-vowel SD of f2Position           = ${rel(posVals).toFixed(2)}% of its mean`);
    console.log(`    vowel variance removed: ${(rel(rawVals) / rel(posVals)).toFixed(1)}×`);
  }
  console.log('\n  CONTRAST THE FEATURE IS FOR — the same d′ arithmetic on a published within-speaker');
  console.log(`  training shift (§1.5, GAVT: F2 ${GAVT_F2_HZ[0]} → ${GAVT_F2_HZ[1]} Hz, +${(100 * (GAVT_F2_GAIN - 1)).toFixed(1)}%), same tract length:`);
  for (const [name, keys] of [['seven-vowel §1.1 set', BENCH_SET], ['all ten', FULL_SET]]) {
    const r = f2PositionTrainingDPrime(keys);
    console.log(`    ${name.padEnd(22)} raw F2 d′ ${r.rawF2.d.toFixed(3).padStart(7)}    f2Position d′ ${r.f2Position.d.toFixed(3).padStart(7)}   (${(r.f2Position.d / r.rawF2.d).toFixed(1)}×)`);
  }
  console.log('    Raw F2 detects the very shift it is promoted as a training target for at d′ 0.16 —');
  console.log('    worse than it separates the two P&B populations — because a 6% F2 change is small');
  console.log('    against a 35% across-vowel spread. Conditioning on the vowel is what makes it');
  console.log('    visible. Note these numbers use the classifier\'s own vowel decisions, not oracle');
  console.log('    labels, so classifier errors and abstentions are already priced in.');
  console.log('');
}

// =============================================================================================
// PHASE 5 — REAL SPEAKERS (docs/RESONANCE_REDESIGN.md §5)
// =============================================================================================
//
// Everything above this line is measured on Peterson & Barney's TWO population MEANS. That is
// the whole limitation Phase 5 exists to remove: two mean speakers cannot tell you whether a
// classifier is speaker-independent, cannot give you an across-SPEAKER standard deviation, and
// (P&B published no F4) cannot give you a measured r₄ at all.
//
// The functions below are the SAME machinery pointed at fixtures/hillenbrand-1995.json —
// 139 individual speakers × 12 vowels, hand-corrected F0 and F1–F4. `pbSpeaker` and
// `realSpeaker` build the identical object shape, so every routine above (templates,
// classifier evaluation, f2Position, the d′ arithmetic) runs on either corpus unchanged.
//
// The report front-end is tools/real-speaker-benchmark.mjs; the assertions are in
// resonance-dprime.test.mjs. There is one implementation of the benchmark, not two.

export const HB = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hillenbrand-1995.json'), 'utf8'));

// The ten vowels Hillenbrand shares with P&B. Every cross-corpus number runs on exactly this
// set, so a difference between the corpora is never the two of them covering different vowels.
export const HB_SET = HB.petersonBarneyOverlap;
// /e/ ("hayed") and /o/ ("hoed") — real vowels of the language that the SHIPPED templates have
// no entry for. Never folded into an accuracy figure; reported as its own out-of-inventory line.
export const HB_EXTRA = HB.hillenbrandOnly;
export const HB_FULL = [...HB_SET, ...HB_EXTRA];

export const HB_GROUPS = ['men', 'women', 'boys', 'girls'];
export const HB_ADULT_GROUPS = ['men', 'women'];
export const HB_CHILD_GROUPS = HB.childGroups;

// app.js's two F3 admission floors, duplicated here as data rather than imported because app.js
// is a browser module. The rhotic question in §5's Phase 4 entry is entirely about these two
// numbers, and this is the first corpus that can say how many REAL /ɝ/ productions fall below
// each of them.
export const F3_FLOOR_HZ = 2000;
export const F3_RHOTIC_FLOOR_HZ = 1500;

export const hbSpeakers = (groups = HB_GROUPS) => HB.speakers.filter((s) => groups.includes(s.group));

// [F1, F2, F3, F4] for one token, in the array-position-is-the-formant-number convention
// fitFormantScale requires. A formant the author could not measure is 0 — "not measured",
// which fitFormantScale skips — never an invented value.
//
// `includeF4: false` is the DEFAULT and it is deliberate: it is the F4-unavailable operating
// point every number in Phases 1–4 was measured at, so a Hillenbrand-vs-P&B comparison is a
// comparison of corpora rather than of how many formants each had. F4 gets its own section.
export function hbFormants(token, { includeF4 = false, f2Gain = 1 } = {}) {
  if (!token) return null;
  return [
    token.f1 || 0,
    (token.f2 || 0) * f2Gain,
    token.f3 || 0,
    includeF4 ? (token.f4 || 0) : 0,
  ];
}

// One real speaker, in exactly the shape `pbSpeaker` returns, so everything downstream is
// corpus-agnostic.
//
// The scale is POOLED over the speaker's own vowel inventory by `poolFormantScale` — the same
// weighted median the live rolling window uses — because a frame is one vowel and one vowel's
// apparent tract length is not the speaker's (§1.1). A token whose fit failed (fewer than two
// measurable formants) is dropped from `vowels` rather than filled in.
export function realSpeaker(speaker, { vowels = HB_SET, includeF4 = false, f2Gain = 1 } = {}) {
  const kept = [], formants = [];
  for (const v of vowels) {
    const f = hbFormants(speaker.tokens[v], { includeF4, f2Gain });
    if (!f) continue;
    if (fitFormantScale(f).deltaF <= 0) continue;
    kept.push(v); formants.push(f);
  }
  const scaleHz = poolFormantScale(
    formants.map((f) => ({ deltaF: fitFormantScale(f).deltaF, weight: 1 })),
    { minSamples: 4 },
  ).deltaF;
  const pooled = formants.map((f) => formantPatternResiduals(f, scaleHz).slice(0, includeF4 ? 4 : 3));
  return {
    id: speaker.id, group: speaker.group, sex: speaker.sex, adult: speaker.adult,
    vowels: kept, formants, scaleHz, includeF4,
    pooledResiduals: pooled,
    residuals: pooled.map((r) => normalizeResidualScale(r).residuals),
    rho: pooled.map((r) => residualScaleFactor(r)),
    // Index by vowel, because a real speaker can be missing one and the arrays are no longer
    // positionally aligned with the requested vowel list the way P&B's always are.
    index: Object.fromEntries(kept.map((v, i) => [v, i])),
  };
}

export const realSpeakers = (opts = {}) =>
  hbSpeakers(opts.groups || HB_GROUPS).map((s) => realSpeaker(s, opts));

// ---------------------------------------------------------------------------------------------
// (c) THE d′ DENOMINATOR
// ---------------------------------------------------------------------------------------------
//
// §1.3 defines d′ = (female mean − male mean) ÷ pooled within-sex ACROSS-VOWEL SD. With two mean
// speakers there was no alternative: the only variance P&B exposes within a sex is variance
// across vowels. But that denominator is why conditioning on the vowel inflates d′ almost
// tautologically — a measure that removes across-vowel variance shrinks its own denominator, and
// §5's Phase 2 α-sweep is that effect isolated in one parameter.
//
// 139 speakers give the denominator this was always supposed to be: the SD across SPEAKERS
// within a sex. Both are returned from one function, on one numerator, so the historical number
// stays comparable and the honest one sits beside it.
//
//   acrossVowel   — collapse to one value per VOWEL within the group, then SD over vowels.
//                   §1.3's denominator, reproduced exactly on P&B's two mean speakers.
//   acrossSpeaker — collapse to one value per SPEAKER within the group, then SD over speakers.
//                   What "can this measure tell two people apart" actually asks.
//   token         — no collapsing: SD over every token. Carries both sources at once; reported
//                   for context because it is the variance a single live frame really faces.
//
// `values` is a list of {group, speaker, vowel, value}. One shape for every measure, so no
// measure gets a denominator computed a different way from another's.
export function dPrimeDenominators(values, groupA, groupB) {
  const clean = values.filter((v) => v && v.value != null && Number.isFinite(v.value));
  const of = (g) => clean.filter((v) => v.group === g);
  const collapse = (rows, key) => {
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r[key])) by.set(r[key], []);
      by.get(r[key]).push(r.value);
    }
    return [...by.values()].filter((xs) => xs.length).map(mean);
  };
  const A = of(groupA), B = of(groupB);
  const raw = { A: A.map((r) => r.value), B: B.map((r) => r.value) };
  if (!raw.A.length || !raw.B.length) return null;
  const shift = mean(raw.B) - mean(raw.A);
  const pooled = (a, b) =>
    (a.length > 1 && b.length > 1) ? Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / 2) : NaN;
  const den = {
    acrossVowel: pooled(collapse(A, 'vowel'), collapse(B, 'vowel')),
    acrossSpeaker: pooled(collapse(A, 'speaker'), collapse(B, 'speaker')),
    token: pooled(raw.A, raw.B),
  };
  // AUC over per-SPEAKER means, reported beside the d′ it corresponds to. d′ assumes two normal
  // distributions with equal variance and blows up when a measure's own clamping compresses the
  // denominator; AUC is the rank statistic and makes no such assumption, so a large d′ next to an
  // AUC of 0.99 says "these are both near-perfect and d′ is magnifying the difference between
  // them", which is a thing this phase measured and needed to be able to say.
  const perSpeaker = (rows) => {
    const by = new Map();
    for (const r of rows) { if (!by.has(r.speaker)) by.set(r.speaker, []); by.get(r.speaker).push(r.value); }
    return [...by.values()].map(mean);
  };
  const sA = perSpeaker(A), sB = perSpeaker(B);
  let pairs = 0, wins = 0;
  for (const a of sA) for (const b of sB) { pairs++; if (b > a) wins++; else if (b === a) wins += 0.5; }
  return {
    shift, meanA: mean(raw.A), meanB: mean(raw.B),
    nA: raw.A.length, nB: raw.B.length,
    nSpeakersA: sA.length, nSpeakersB: sB.length,
    sd: den,
    dAcrossVowel: shift / den.acrossVowel,
    dAcrossSpeaker: shift / den.acrossSpeaker,
    dToken: shift / den.token,
    aucSpeaker: pairs ? wins / pairs : NaN,
  };
}

// The §1.3 measure ladder, as code.
//
// READ THIS BEFORE COMPARING TO §1.3's TABLE. Only two of these rows were ever committed:
// `v1` is `resonanceScoreV1` and `v2` is `resonanceAbsoluteV2`, and both reproduce §1.3
// exactly (0.858 and 1.734 on the seven-vowel set). The other six are THIS FILE'S restatement
// of §1.3's one-line descriptions — that table was prose, not code, so the normalisation ranges
// and clamping it used are not recoverable. They reproduce §1.3's ordering and not its values,
// and the report prints the published number beside the recomputed one so the discrepancy is
// visible rather than absorbed. Nothing in Phase 5 depends on the six matching; what the ladder
// is for is RANK under two different denominators, and rank is unaffected by which affine
// restatement of a measure is used.
export const MEASURE_LADDER = [
  { key: 'f3Norm', label: 'F3 normalised (2200–3300 Hz)', published: 1.98, committed: false,
    fn: (f) => clamp01((f[2] - 2200) / 1100) },
  { key: 'v2', label: 'resonanceAbsolute v2', published: 1.73, committed: true,
    fn: (f) => scoreV2(f) },
  { key: 'dfF3', label: 'ΔF from F3 alone', published: 1.67, committed: false,
    fn: (f) => (f[2] > 0 ? resonanceAbsoluteV2(f[2] / 2.5) : null) },
  { key: 'meanF123', label: 'mean(F1,F2,F3) normalised', published: 0.96, committed: false,
    fn: (f) => clamp01(((f[0] + f[1] + f[2]) / 3 - 1000) / 1000) },
  { key: 'v1', label: 'current app score (v1)', published: 0.85, committed: true,
    fn: (f) => scoreV1(f) },
  { key: 'dfF123', label: 'ΔF(F1,F2,F3) alone', published: 0.81, committed: false,
    fn: (f) => resonanceAbsoluteV2(fitFormantDispersion([f[0], f[1], f[2]]).deltaF) },
  { key: 'dfF23', label: 'ΔF(F2,F3)', published: 0.73, committed: false,
    fn: (f) => resonanceAbsoluteV2(fitFormantDispersion([0, f[1], f[2]]).deltaF) },
  { key: 'f2Norm', label: 'F2 normalised (1000–2400 Hz)', published: 0.38, committed: false,
    fn: (f) => rawF2Score(f) },
];

// Every ladder measure scored token by token over a set of speakers, in the {group, speaker,
// vowel, value} shape `dPrimeDenominators` consumes. `groupOf` lets the same speakers be split
// by sex, by age, or by anything else without re-scoring them.
export function ladderValues(speakers, { vowels = HB_SET, groupOf = (s) => s.group } = {}) {
  const out = {};
  for (const m of MEASURE_LADDER) out[m.key] = [];
  for (const sp of speakers) {
    for (const v of vowels) {
      const i = sp.index[v];
      if (i == null) continue;
      const f = sp.formants[i];
      for (const m of MEASURE_LADDER) {
        const value = m.fn(f);
        out[m.key].push({ group: groupOf(sp), speaker: sp.id, vowel: v, value });
      }
    }
  }
  return out;
}

// The same ladder on P&B, so the two corpora are compared on one arithmetic. P&B has one
// "speaker" per sex, so its acrossSpeaker denominator is undefined by construction — which is
// the point, and the report says so rather than printing NaN as if it were a result.
export function pbLadderValues(vowels = FULL_SET) {
  const out = {};
  for (const m of MEASURE_LADDER) out[m.key] = [];
  for (const sex of ['male', 'female']) {
    for (const v of vowels) {
      const f = formantsOf(v, sex);
      for (const m of MEASURE_LADDER) {
        out[m.key].push({ group: sex === 'male' ? 'men' : 'women', speaker: sex, vowel: v, value: m.fn(f) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// (d) THE SHIPPED CONSTANTS, RE-DERIVED FROM REAL SPEAKERS
// ---------------------------------------------------------------------------------------------
//
// VOWEL_TEMPLATES, VOWEL_RESIDUAL_SD and VOWEL_SPEAKER_SCATTER are all derived from P&B's two
// means. This re-derives each from 139 real speakers by the identical definition and reports the
// distance. NOTHING IS SWAPPED — §3.5's versioning applies to any change that moves a displayed
// number, so the output is a proposal with numbers attached, not an edit.
export function realTemplates(speakers, { vowels = HB_SET, dims = 3 } = {}) {
  const out = {};
  for (const v of vowels) {
    const rows = [];
    for (const sp of speakers) {
      const i = sp.index[v];
      if (i == null) continue;
      const r = sp.residuals[i];
      if (r && r.slice(0, dims).every((x) => x != null && x > 0)) rows.push(r);
    }
    if (rows.length) out[v] = Array.from({ length: dims }, (_, k) => mean(rows.map((r) => r[k])));
  }
  return out;
}

// VOWEL_RESIDUAL_SD's definition: the across-vowel SD of each residual dimension over the
// template set. Recomputed here on real-speaker templates.
export function realResidualSd(templates, dims = 3) {
  const rows = Object.values(templates);
  return Array.from({ length: dims }, (_, i) => sd(rows.map((r) => r[i])));
}

// VOWEL_SPEAKER_SCATTER's definition: "the mean distance, in the classifier's metric, between
// two speakers' productions of THE SAME vowel". P&B could only offer one such pair — male norm
// vs female norm — so the shipped 0.195 is a single difference. With 139 speakers it is the
// mean distance from each speaker's own residual to the population template for that vowel,
// which is the quantity the posterior actually needs: how far a genuine production sits from
// the template because the speaker is a different person.
//
// Reported per group as well as pooled, because the shipped constant was derived from two ADULT
// means and the children are the population it was never shown.
export function realSpeakerScatter(speakers, { templates, vowels = HB_SET, dims = 2, sdVec = VOWEL_RESIDUAL_SD } = {}) {
  const all = [], byGroup = {};
  for (const sp of speakers) {
    for (const v of vowels) {
      const i = sp.index[v];
      if (i == null || !templates[v]) continue;
      const d = templateDistance(sp.residuals[i], templates[v], dims, sdVec);
      if (!Number.isFinite(d)) continue;
      all.push(d);
      (byGroup[sp.group] ||= []).push(d);
    }
  }
  return {
    mean: all.length ? mean(all) : NaN,
    median: all.length ? all.slice().sort((a, b) => a - b)[Math.floor(all.length / 2)] : NaN,
    n: all.length,
    byGroup: Object.fromEntries(Object.entries(byGroup).map(([g, xs]) => [g, { mean: mean(xs), n: xs.length }])),
  };
}

// ---------------------------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION: classification held out across REAL SPEAKERS
// ---------------------------------------------------------------------------------------------
//
// The Phase 2 claim is 95% correct at 0% abstention "held out across sexes" — which is n = 20
// decisions over TWO mean speakers. This is the same test where the held-out unit is a person.
//
// `templates: 'shipped'` runs VOWEL_TEMPLATES, i.e. the constants the app ships, against
// speakers they have never seen. That is the number that says whether the app works.
// `templates: 'derived'` rebuilds them from the training speakers of each fold, which separates
// "the shipped constants are wrong" from "the method does not generalise".
//
// `trainGroups` / `testGroups` are what makes children a stress test rather than a footnote:
// train on adults only, test on children, and the classifier faces tract lengths outside the
// range every template was built from.
export function speakerHeldOutEval({
  vowels = HB_SET,
  templates: mode = 'shipped',
  folds = 5,
  trainGroups = HB_GROUPS,
  testGroups = HB_GROUPS,
  dims = null,
  includeF4 = false,
  seed = 1,
} = {}) {
  const all = realSpeakers({ vowels, includeF4 });
  const train = all.filter((s) => trainGroups.includes(s.group));
  const test = all.filter((s) => testGroups.includes(s.group));
  const disjointGroups = testGroups.some((g) => !trainGroups.includes(g));

  const perVowel = {}, confusion = {}, matrix = {}, byGroup = {};
  for (const v of vowels) { perVowel[v] = { correct: 0, wrong: 0, abstain: 0 }; matrix[v] = {}; }
  let correct = 0, wrong = 0, abstain = 0;
  const abstainReasons = {};

  // Deterministic speaker assignment to folds: sorted ids, round robin offset by `seed`.
  // Round robin over the sorted list keeps every group represented in every fold, so a fold is
  // never accidentally all-men.
  const foldOf = new Map();
  test.slice().sort((a, b) => a.id.localeCompare(b.id))
    .forEach((s, i) => foldOf.set(s.id, (i + seed) % folds));

  const score = (sp, templatesForFold) => {
    for (const v of vowels) {
      const i = sp.index[v];
      if (i == null) continue;
      const c = classifyVowel(sp.residuals[i], { templates: templatesForFold, dims, preNormalized: true });
      const cell = c.vowel || '—';
      matrix[v][cell] = (matrix[v][cell] || 0) + 1;
      const g = (byGroup[sp.group] ||= { correct: 0, wrong: 0, abstain: 0 });
      if (c.vowel === null) {
        abstain++; perVowel[v].abstain++; g.abstain++;
        abstainReasons[c.reason] = (abstainReasons[c.reason] || 0) + 1;
      } else if (c.vowel === v) { correct++; perVowel[v].correct++; g.correct++; } else {
        wrong++; perVowel[v].wrong++; g.wrong++;
        confusion[`${v}→${c.vowel}`] = (confusion[`${v}→${c.vowel}`] || 0) + 1;
      }
    }
  };

  if (mode === 'shipped') {
    // No folds needed: the templates come from P&B and have seen none of these speakers.
    for (const sp of test) score(sp, VOWEL_TEMPLATES);
  } else if (disjointGroups) {
    // Train and test populations are already disjoint (adults → children); one split, no folds.
    const t = realTemplates(train, { vowels, dims: 3 });
    for (const sp of test) score(sp, t);
  } else {
    for (let k = 0; k < folds; k++) {
      const trainFold = train.filter((s) => foldOf.get(s.id) !== k);
      const t = realTemplates(trainFold, { vowels, dims: 3 });
      for (const sp of test.filter((s) => foldOf.get(s.id) === k)) score(sp, t);
    }
  }

  const n = correct + wrong + abstain;
  return {
    mode, n, correct, wrong, abstain, confusion, perVowel, matrix, abstainReasons, byGroup,
    nSpeakers: test.length,
    accuracy: n ? correct / n : 0,
    accuracyDecided: (correct + wrong) ? correct / (correct + wrong) : 0,
    abstentionRate: n ? abstain / n : 0,
  };
}

// Vowels the shipped inventory has no template for — /e/ and /o/. Every decision here is by
// construction either an abstention or an error; reported on its own so it can neither flatter
// nor deflate the accuracy above.
export function outOfInventoryEval({ vowels = HB_EXTRA, dims = null } = {}) {
  const all = realSpeakers({ vowels: HB_FULL });
  const got = {};
  let abstain = 0, named = 0;
  for (const sp of all) {
    for (const v of vowels) {
      const i = sp.index[v];
      if (i == null) continue;
      const c = classifyVowel(sp.residuals[i], { templates: VOWEL_TEMPLATES, dims, preNormalized: true });
      if (c.vowel === null) abstain++;
      else { named++; (got[v] ||= {}); got[v][c.vowel] = (got[v][c.vowel] || 0) + 1; }
    }
  }
  return { n: abstain + named, abstain, named, abstentionRate: (abstain + named) ? abstain / (abstain + named) : 0, got };
}

// ---------------------------------------------------------------------------------------------
// F4 — THE FIRST MEASURED ONE
// ---------------------------------------------------------------------------------------------
//
// §7's open question 2 ("Is F4 worth its miss rate?") has been open since Phase 2 and every
// datum against it was synthetic: P&B published no F4, so Phase 1's yield figure came from the
// live extractor and Phase 2's classifier test supplied F4 model-consistently at 3.5·ΔF of the
// vowel's own fit. A synthetic F4 placed from the vowel's own fit cannot answer whether F4 helps,
// because it was constructed to agree with the other three formants.
//
// Hillenbrand measured F4 by hand on 85.4% of tokens. Three questions, three measurements:
//
//   1. Does F4 make the SCALE better determined? The test is not "does ΔF change" — it will —
//      but whether the speaker's scale becomes less dependent on which vowel they happened to
//      say. That is the within-speaker across-vowel SD of per-token ΔF, relative to the
//      speaker's own pooled ΔF. Lower is better and it is the property Phase 1 claims for the
//      upper-formant weighting.
//   2. Does it move d′? Both denominators, F1–F3 against F1–F4, on the same speakers.
//   3. Is there a measured r₄ TEMPLATE — the thing Phase 2 said "Phase 5's real-vowel validation
//      is where that could come from honestly"? A template exists if r₄ separates vowels by more
//      than it scatters across speakers. That ratio is the answer, and it is reported whether or
//      not it is flattering.
export function f4ScaleStability({ vowels = HB_SET } = {}) {
  const rows = [];
  for (const sp of hbSpeakers()) {
    const out = {};
    for (const includeF4 of [false, true]) {
      // Only tokens where ALL FOUR formants were measurable, so the comparison is paired: the
      // same tokens with and without F4, never "F4 present" versus a different token set.
      const usable = vowels.filter((v) => {
        const t = sp.tokens[v];
        return t && t.f1 > 0 && t.f2 > 0 && t.f3 > 0 && t.f4 > 0;
      });
      if (usable.length < 4) { out.skip = true; continue; }
      const dfs = usable.map((v) => fitFormantScale(hbFormants(sp.tokens[v], { includeF4 })).deltaF);
      const pooled = poolFormantScale(dfs.map((d) => ({ deltaF: d, weight: 1 })), { minSamples: 4 }).deltaF;
      out[includeF4 ? 'withF4' : 'withoutF4'] = {
        pooled, n: usable.length,
        // Across-vowel scatter of the per-token scale, as a fraction of the speaker's own
        // pooled scale. Scale-free, so men and children are on one ruler.
        cv: pooled > 0 ? sd(dfs) / pooled : NaN,
      };
    }
    if (!out.skip && out.withF4 && out.withoutF4) rows.push({ id: sp.id, group: sp.group, ...out });
  }
  const cvOf = (k) => rows.map((r) => r[k].cv).filter(Number.isFinite);
  const improved = rows.filter((r) => r.withF4.cv < r.withoutF4.cv).length;
  return {
    n: rows.length,
    meanCvWithoutF4: mean(cvOf('withoutF4')),
    meanCvWithF4: mean(cvOf('withF4')),
    improved, improvedRate: rows.length ? improved / rows.length : 0,
    byGroup: Object.fromEntries(HB_GROUPS.map((g) => {
      const sub = rows.filter((r) => r.group === g);
      return [g, sub.length ? {
        n: sub.length,
        withoutF4: mean(sub.map((r) => r.withoutF4.cv)),
        withF4: mean(sub.map((r) => r.withF4.cv)),
      } : null];
    })),
    rows,
  };
}

// Is there a measured r₄ template? Four formants carry THREE free residual dimensions (the rank
// identity in dsp-utils.js), so r₄ is a real observation rather than r₁–r₃ rearranged — provided
// it separates vowels.
//
// The criterion is the same one VOWEL_RESIDUAL_SD and VOWEL_SPEAKER_SCATTER express for r₁ and
// r₂: across-vowel SD (signal) against across-speaker scatter within a vowel (noise). A template
// is worth having when the first is comfortably larger than the second.
export function r4TemplateEvidence({ vowels = HB_SET } = {}) {
  const speakers = realSpeakers({ includeF4: true });
  const byVowel = {};
  for (const v of vowels) byVowel[v] = { r1: [], r2: [], r3: [], r4: [] };
  for (const sp of speakers) {
    for (const v of vowels) {
      const i = sp.index[v];
      if (i == null) continue;
      const r = sp.residuals[i];
      if (!r || r.length < 4 || r.slice(0, 4).some((x) => x == null || !(x > 0))) continue;
      byVowel[v].r1.push(r[0]); byVowel[v].r2.push(r[1]);
      byVowel[v].r3.push(r[2]); byVowel[v].r4.push(r[3]);
    }
  }
  const present = vowels.filter((v) => byVowel[v].r4.length >= 10);
  const dim = (k) => {
    const templates = present.map((v) => mean(byVowel[v][k]));
    const withinSd = mean(present.map((v) => sd(byVowel[v][k])));   // across-speaker, within vowel
    const acrossSd = sd(templates);                                  // across-vowel
    return {
      template: Object.fromEntries(present.map((v, i) => [v, templates[i]])),
      acrossVowelSd: acrossSd,
      acrossSpeakerSd: withinSd,
      // How many across-speaker scatters apart the vowels sit. Above ~1 the dimension carries
      // vowel identity; at or below it, it is mostly reporting who is talking.
      separability: withinSd > 0 ? acrossSd / withinSd : NaN,
    };
  };
  return { n: present.length, vowels: present, r1: dim('r1'), r2: dim('r2'), r3: dim('r3'), r4: dim('r4') };
}

// Does a 4-dimension classifier actually beat the shipped 2-dimension one on real speakers?
// Templates and the distance metric are both re-derived from the training speakers, because the
// shipped VOWEL_TEMPLATES has three dimensions and VOWEL_RESIDUAL_SD three entries — a 4-d test
// cannot borrow either. Held out by speaker, same folds as everything else.
export function f4ClassifierEval({ vowels = HB_SET, folds = 5, seed = 1 } = {}) {
  const speakers = realSpeakers({ vowels, includeF4: true });
  const foldOf = new Map();
  speakers.slice().sort((a, b) => a.id.localeCompare(b.id))
    .forEach((s, i) => foldOf.set(s.id, (i + seed) % folds));
  const out = {};
  for (const dims of [2, 3, 4]) out[dims] = { correct: 0, wrong: 0, n: 0 };
  for (let k = 0; k < folds; k++) {
    const train = speakers.filter((s) => foldOf.get(s.id) !== k);
    const templates = realTemplates(train, { vowels, dims: 4 });
    const keys = Object.keys(templates);
    const sdVec = [0, 1, 2, 3].map((i) => sd(keys.map((v) => templates[v][i])));
    for (const sp of speakers.filter((s) => foldOf.get(s.id) === k)) {
      for (const v of vowels) {
        const i = sp.index[v];
        if (i == null) continue;
        const r = sp.residuals[i];
        if (!r || r.length < 4 || r.slice(0, 4).some((x) => x == null || !(x > 0))) continue;
        for (const dims of [2, 3, 4]) {
          const ranked = keys.map((u) => [u, templateDistance(r, templates[u], dims, sdVec)])
            .sort((a, b) => a[1] - b[1]);
          out[dims].n++;
          if (ranked[0][0] === v) out[dims].correct++; else out[dims].wrong++;
        }
      }
    }
  }
  // Nearest-template with no abstention gate, because the gates are calibrated in
  // VOWEL_RESIDUAL_SD units and a re-derived 4-d metric is not on that ruler. Reported as
  // "which dimensionality wins", not as an accuracy comparable to the shipped classifier's.
  return out;
}

// ---------------------------------------------------------------------------------------------
// /ɝ/ — WHAT REAL SPEAKERS CAN AND CANNOT SETTLE
// ---------------------------------------------------------------------------------------------
//
// The brief for this phase said Hillenbrand's set does not include /ɝ/. It does: the author's
// own key maps `er` to "heard", and there are 139 tokens, one per speaker. That makes this the
// real-speaker evidence Phase 4 named as its remaining blocker — "validated against real rhotic
// recordings rather than a Klatt cascade" — at the FORMANT level.
//
// What it settles: where a real rhotic's F3 actually sits, in 139 mouths spanning men, women and
// children, against the two F3 admission floors in app.js; whether the shipped classifier can
// name a real /ɝ/ from hand-corrected formants; and whether ρ separates it across real speakers.
//
// What it CANNOT settle: whether the live LPC extractor can FIND that F3 in audio. The floors are
// a property of the pole-assignment loop, and this corpus supplies formants rather than poles.
// That is Tier 2 and it is out of scope, so the report says so instead of implying coverage.
export function rhoticReal({ vowel = 'ɝ', vowels = HB_SET } = {}) {
  const f3 = { all: [], byGroup: {} };
  for (const sp of hbSpeakers()) {
    const t = sp.tokens[vowel];
    if (!t || !(t.f3 > 0)) continue;
    f3.all.push(t.f3);
    (f3.byGroup[sp.group] ||= []).push(t.f3);
  }
  const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const summary = (xs) => ({
    n: xs.length, mean: mean(xs), sd: sd(xs), min: Math.min(...xs), max: Math.max(...xs),
    p05: q(xs, 0.05), median: q(xs, 0.5), p95: q(xs, 0.95),
    belowStandardFloor: xs.filter((x) => x < F3_FLOOR_HZ).length,
    belowRhoticFloor: xs.filter((x) => x < F3_RHOTIC_FLOOR_HZ).length,
  });

  // The false-positive surface the widened floor opens: NON-rhotic tokens whose F3 sits in
  // [1500, 2000). Those are the productions a 1500 Hz floor newly admits, and the only ones the
  // rhotic assignment can be wrong about at the formant level.
  let nonRhoticInBand = 0, nonRhoticTotal = 0;
  const bandByVowel = {};
  for (const sp of hbSpeakers()) {
    for (const v of vowels) {
      if (v === vowel) continue;
      const t = sp.tokens[v];
      if (!t || !(t.f3 > 0)) continue;
      nonRhoticTotal++;
      if (t.f3 >= F3_RHOTIC_FLOOR_HZ && t.f3 < F3_FLOOR_HZ) {
        nonRhoticInBand++; bandByVowel[v] = (bandByVowel[v] || 0) + 1;
      }
    }
  }

  // ρ, held out across 139 speakers. §5's Phase 3 entry measured /ɝ/ at ρ 0.7212 against
  // 0.9053–1.1882 for every other vowel, on the norms. Same statistic, real speakers.
  const speakers = realSpeakers({ vowels });
  const rhoBy = {};
  for (const sp of speakers) {
    for (const v of vowels) {
      const i = sp.index[v];
      if (i == null) continue;
      const r = sp.rho[i];
      if (Number.isFinite(r) && r > 0) (rhoBy[v] ||= []).push(r);
    }
  }
  const rho = Object.fromEntries(Object.entries(rhoBy).map(([v, xs]) => [v, { mean: mean(xs), sd: sd(xs), n: xs.length, p05: q(xs, 0.05), p95: q(xs, 0.95) }]));
  // The shipped threshold, √(0.7212·0.9053) = 0.8080, applied to real speakers.
  const threshold = Math.sqrt(0.7212 * 0.9053);
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const sp of speakers) {
    for (const v of vowels) {
      const i = sp.index[v];
      if (i == null) continue;
      const flagged = sp.rho[i] < threshold;
      if (v === vowel) { if (flagged) tp++; else fn++; } else if (flagged) fp++; else tn++;
    }
  }

  return {
    f3: { all: summary(f3.all), byGroup: Object.fromEntries(Object.entries(f3.byGroup).map(([g, xs]) => [g, summary(xs)])) },
    nonRhoticInBand, nonRhoticTotal,
    nonRhoticInBandRate: nonRhoticTotal ? nonRhoticInBand / nonRhoticTotal : 0,
    bandByVowel, rho, rhoThreshold: threshold,
    rhoDetector: {
      recall: (tp + fn) ? tp / (tp + fn) : 0,
      falsePositiveRate: (fp + tn) ? fp / (fp + tn) : 0,
      tp, fn, fp, tn,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// f2Position, ON REAL SPEAKERS
// ---------------------------------------------------------------------------------------------
//
// Both §5 contrasts, re-run. Contrast 1 (women vs men) is the descriptive figure Phase 4 demoted
// from an acceptance gate; contrast 2 (the published GAVT within-speaker F2 shift) is the one the
// feature is scored on. Vowels come from the SHIPPED classifier's own decisions, not from oracle
// labels, so its mistakes and abstentions are priced in exactly as they are in the P&B version.
// `oracle: true` supplies the true vowel label instead of the classifier's decision. It is not
// a shippable configuration — nothing knows the vowel in advance — but it is the only way to
// tell "the conditioning is weak on real speakers" apart from "the classifier is weak on real
// speakers", and after the classification result above that distinction is the whole question.
export function f2PositionReal({ vowels = HB_SET, groupsA = ['men'], groupsB = ['women'], templates = VOWEL_TEMPLATES, oracle = false } = {}) {
  const rows = (speakers, groupLabel) => {
    const out = { f2Position: [], rawF2: [] };
    for (const sp of speakers) {
      for (const v of vowels) {
        const i = sp.index[v];
        if (i == null) continue;
        const named = oracle
          ? (templates[v] ? v : null)
          : classifyVowel(sp.residuals[i], { templates, preNormalized: true }).vowel;
        out.f2Position.push({
          group: groupLabel, speaker: sp.id, vowel: v,
          value: named ? f2PositionFromResidual(sp.residuals[i], named, templates) : null,
        });
        out.rawF2.push({ group: groupLabel, speaker: sp.id, vowel: v, value: rawF2Score(sp.formants[i]) });
      }
    }
    return out;
  };
  const A = rows(realSpeakers({ vowels, groups: groupsA }), 'A');
  const B = rows(realSpeakers({ vowels, groups: groupsB }), 'B');
  const sex = {
    f2Position: dPrimeDenominators([...A.f2Position, ...B.f2Position], 'A', 'B'),
    rawF2: dPrimeDenominators([...A.rawF2, ...B.rawF2], 'A', 'B'),
  };

  // Contrast 2: the same speakers before and after §1.5's published F2 increment. Same tract,
  // different posture — a paired within-speaker change, which is what an F2 target trains.
  const pre = rows(realSpeakers({ vowels }), 'A');
  const post = rows(realSpeakers({ vowels, f2Gain: GAVT_F2_GAIN }), 'B');
  const training = {
    f2Position: dPrimeDenominators([...pre.f2Position, ...post.f2Position], 'A', 'B'),
    rawF2: dPrimeDenominators([...pre.rawF2, ...post.rawF2], 'A', 'B'),
  };

  // §3.1's actual claim: how much across-vowel variance the conditioning removes.
  const men = realSpeakers({ vowels, groups: ['men'] });
  const rawVals = [], posVals = [];
  for (const sp of men) {
    for (const v of vowels) {
      const i = sp.index[v];
      if (i == null) continue;
      rawVals.push(sp.formants[i][1]);
      const named = oracle
        ? (templates[v] ? v : null)
        : classifyVowel(sp.residuals[i], { templates, preNormalized: true }).vowel;
      if (named) posVals.push(f2PositionFromResidual(sp.residuals[i], named, templates));
    }
  }
  const rel = (xs) => 100 * sd(xs) / mean(xs);
  return {
    sex, training,
    varianceRemoved: { rawPct: rel(rawVals), positionPct: rel(posVals), ratio: rel(rawVals) / rel(posVals) },
  };
}
