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
  console.log('');
}
