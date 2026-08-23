#!/usr/bin/env node
// Is ρ usable for /ɝ/? — Phase 3's answer to Phase 2's hand-off.
// docs/RESONANCE_REDESIGN.md §5 Phase 2 ("/ɝ/: separable in principle, not by what Phase 2
// ships") and §5 Phase 3 ("including whether ρ becomes usable once you can tell a valid frame
// from an invalid one").
//
// Phase 2 measured both halves and refused to act on either:
//   - in the POOLED frame /ɝ/ is the most isolated vowel in the set (1.18 to its nearest
//     neighbour, against 0.35–0.81 for everything else), because a rhotic's lowered F3 cannot
//     be absorbed by a scale fitted to the speaker's OTHER vowels;
//   - in the SCALE-INVARIANT frame that ships it is tied with the closest pairs (0.40), and the
//     dimension that was separating it — ρ = Σ L_i r_i — is the same dimension a pooling-window
//     mismatch moves.
//
// Phase 3 has three things Phase 2 did not: frame validity gates (so a swapped F3, which lowers
// ρ exactly the way a rhotic does, can be rejected instead of believed), a window-homogeneity
// measure (so a sustained hold, where ρ → 1 by construction and carries nothing, can be told
// from connected speech), and the observation that window composition scales every vowel's ρ by
// a COMMON factor, so a running median divides it out.
//
// This tool measures what that buys and what it costs, over five conditions:
//   1. clean P&B norms, held out across speakers
//   2. formant noise sweep, 0–150 Hz per formant
//   3. WINDOW COMPOSITION: pools built from random subsets of the vowel set, which is the
//      failure mode Phase 2 named and the one an absolute ρ threshold would walk into
//   4. threshold sweep, so the cost of moving the threshold is visible without moving it
//   5. the real VoiceAnalyzer at three F0s, with every vowel reported separately
//
// `--check` is strict and fails while the live target is broken. CI may name the temporary
// quarantine explicitly with `--allow-known-live-rhotic-failure`; the failure still prints.
// Usage: node tools/rho-rhotic.mjs [--check] [--allow-known-live-rhotic-failure]
import {
  classifyVowel, rhoticFromRho, RHOTIC_RHO_THRESHOLD, VOWEL_POOLED_RHO,
  fitFormantScale, formantPatternResiduals, normalizeResidualScale, residualScaleFactor,
  poolFormantScale,
} from '../dsp-utils.js';
import { FULL_SET, formantsOf, buildTemplates, pbSpeaker, mean } from './resonance-benchmark.mjs';

const median = (xs) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Deterministic LCG + Box-Muller, same generator the rest of the benchmark uses, so a reported
// robustness curve is reproducible rather than "about that".
function rng(seed = 1) {
  let st = seed >>> 0;
  const uni = () => ((st = (st * 1664525 + 1013904223) >>> 0) + 1) / 4294967297;
  return () => Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni());
}

// One "speaker in a window": the vowels the pooling window actually held, each measured with
// `noiseHz` of independent per-formant error. Noise is applied at the FORMANT level rather than
// in residual-SD units, because that is where a real estimator's error enters and because ρ and
// the residuals must then carry the SAME noise draw — adding independent noise to each would
// make ρ look more reliable than it is.
function windowSample({ vowels, sex, noiseHz, rnd, testVowel }) {
  const measured = vowels.map((v) => formantsOf(v, sex).slice(0, 3).map((f) => f + noiseHz * rnd()));
  const scaleHz = poolFormantScale(
    measured.map((f) => ({ deltaF: fitFormantScale(f).deltaF, weight: 1 })),
    { minSamples: 2 },
  ).deltaF;
  if (!(scaleHz > 0)) return null;
  const rhos = measured.map((f) => residualScaleFactor(formantPatternResiduals(f, scaleHz).slice(0, 3)));
  // The frame under test is a fresh production of `testVowel` by the same speaker, measured
  // against the scale that window produced.
  const probe = formantsOf(testVowel, sex).slice(0, 3).map((f) => f + noiseHz * rnd());
  const pooledR = formantPatternResiduals(probe, scaleHz).slice(0, 3);
  const rho = residualScaleFactor(pooledR);
  return { residuals: normalizeResidualScale(pooledR).residuals, rho, windowMedianRho: median(rhos), n: vowels.length };
}

function evaluate({ vowels = FULL_SET, noiseHz = 0, trials = 1, seed = 1, threshold = RHOTIC_RHO_THRESHOLD,
                    windowSize = null, useRho = true } = {}) {
  const rnd = rng(seed);
  const tally = { base: { ok: 0, wrong: 0, abstain: 0 }, rho: { ok: 0, wrong: 0, abstain: 0 } };
  const confusion = {};
  const rhoticFalsePositives = {};
  for (const [train, test] of [['male', 'female'], ['female', 'male']]) {
    const templates = buildTemplates(FULL_SET, { sexes: [train] });
    for (let t = 0; t < trials; t++) {
      for (const v of vowels) {
        // The window holds `windowSize` vowels drawn without replacement, always including at
        // least enough to fit a scale. `null` = the whole set, which is the easy case.
        let held = vowels;
        if (windowSize && windowSize < vowels.length) {
          const shuffled = vowels.slice();
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.abs(Math.round(rnd() * 1000)) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          held = shuffled.slice(0, windowSize);
        }
        const s = windowSample({ vowels: held, sex: test, noiseHz, rnd, testVowel: v });
        if (!s) continue;
        const c = classifyVowel(s.residuals, { templates, preNormalized: true });
        const rh = rhoticFromRho(s.rho, {
          windowMedianRho: s.windowMedianRho, heterogeneous: true, frameValid: true,
          windowFrames: 100, windowVowels: s.n, threshold,
        });
        const final = useRho && rh.rhotic ? 'ɝ' : c.vowel;
        const bucket = (got) => (got === null ? 'abstain' : got === v ? 'ok' : 'wrong');
        tally.base[bucket(c.vowel)]++;
        tally.rho[bucket(final)]++;
        if (final !== null && final !== v) confusion[`${v}→${final}`] = (confusion[`${v}→${final}`] || 0) + 1;
        if (rh.rhotic && v !== 'ɝ') rhoticFalsePositives[v] = (rhoticFalsePositives[v] || 0) + 1;
      }
    }
  }
  const pct = (o) => {
    const n = o.ok + o.wrong + o.abstain || 1;
    return { correct: +(100 * o.ok / n).toFixed(1), wrong: +(100 * o.wrong / n).toFixed(1), abstain: +(100 * o.abstain / n).toFixed(1), n };
  };
  return { base: pct(tally.base), withRho: pct(tally.rho), confusion, rhoticFalsePositives };
}

export function report() {
  const out = {};
  console.log('ρ as a rhotic detector — Phase 3 answering Phase 2\'s hand-off\n');

  console.log('The measurement ρ rests on: /ɝ/\'s ρ against every other vowel, both sexes.');
  const male = pbSpeaker('male', FULL_SET), female = pbSpeaker('female', FULL_SET);
  FULL_SET.forEach((v, i) => {
    console.log(`  /${v}/  male ${male.rho[i].toFixed(4)}  female ${female.rho[i].toFixed(4)}  `
      + `mean ${VOWEL_POOLED_RHO[v].toFixed(4)}${v === 'ɝ' ? '   <- rhotic' : ''}`);
  });
  const nonRhotic = FULL_SET.filter((v) => v !== 'ɝ').map((v) => VOWEL_POOLED_RHO[v]);
  out.gapToNearest = Math.min(...nonRhotic) / VOWEL_POOLED_RHO['ɝ'];
  out.sexAgreement = Math.abs(male.rho[FULL_SET.indexOf('ɝ')] - female.rho[FULL_SET.indexOf('ɝ')]);
  console.log(`\n  nearest non-rhotic is ${(100 * (out.gapToNearest - 1)).toFixed(1)}% above /ɝ/; `
    + `the two sexes differ on /ɝ/ by ${(100 * out.sexAgreement / VOWEL_POOLED_RHO['ɝ']).toFixed(1)}%`);
  console.log(`  threshold ${RHOTIC_RHO_THRESHOLD} = √(0.7212·0.9053), the geometric midpoint\n`);

  console.log('1. Clean P&B norms, templates from one sex and test points from the other:');
  const clean = evaluate();
  out.clean = clean;
  console.log(`   without ρ: ${clean.base.correct}% correct, ${clean.base.wrong}% wrong, ${clean.base.abstain}% abstain`);
  console.log(`   with    ρ: ${clean.withRho.correct}% correct, ${clean.withRho.wrong}% wrong, ${clean.withRho.abstain}% abstain`);
  console.log(`   remaining confusions: ${JSON.stringify(clean.confusion)}\n`);

  console.log('2. Formant noise sweep (Hz per formant, 40 windows per point, full-set window):');
  console.log('   noise |  without ρ (ok/wrong/ab)  |  with ρ (ok/wrong/ab)  | ρ false positives');
  out.noise = [];
  for (const noiseHz of [0, 25, 50, 75, 100, 150]) {
    const r = evaluate({ noiseHz, trials: 40, seed: 7 });
    out.noise.push({ noiseHz, ...r });
    const fp = Object.values(r.rhoticFalsePositives).reduce((a, b) => a + b, 0);
    console.log(`   ${String(noiseHz).padStart(5)} |  ${String(r.base.correct).padStart(5)} / ${String(r.base.wrong).padStart(5)} / ${String(r.base.abstain).padStart(5)}   |  `
      + `${String(r.withRho.correct).padStart(5)} / ${String(r.withRho.wrong).padStart(5)} / ${String(r.withRho.abstain).padStart(5)}  | ${fp}`);
  }
  console.log();

  console.log('3. WINDOW COMPOSITION — the failure mode Phase 2 named. The pooling window holds');
  console.log('   only `size` of the ten vowels, so ΔF_pooled and every ρ move together:');
  console.log("   The ≥3-distinct-vowel gate is what stops size 2; it is shown firing, not hidden.");
  console.log('   size |  without ρ (ok/wrong/ab)  |  with ρ (ok/wrong/ab)  | ρ false positives');
  out.window = [];
  for (const size of [10, 7, 5, 4, 3, 2]) {
    const r = evaluate({ windowSize: size, noiseHz: 50, trials: 40, seed: 11 });
    out.window.push({ size, ...r });
    const fp = Object.values(r.rhoticFalsePositives).reduce((a, b) => a + b, 0);
    console.log(`   ${String(size).padStart(4)} |  ${String(r.base.correct).padStart(5)} / ${String(r.base.wrong).padStart(5)} / ${String(r.base.abstain).padStart(5)}   |  `
      + `${String(r.withRho.correct).padStart(5)} / ${String(r.withRho.wrong).padStart(5)} / ${String(r.withRho.abstain).padStart(5)}  | ${fp}`
      + (Object.keys(r.rhoticFalsePositives).length ? `  ${JSON.stringify(r.rhoticFalsePositives)}` : ''));
  }
  console.log();

  console.log('4. Threshold sweep at 50 Hz of formant noise, full window. The shipped value is');
  console.log('   NOT the argmax here — it is the geometric midpoint of two published norms:');
  console.log('   thresh |  with ρ correct / wrong / abstain  | ρ false positives');
  out.threshold = [];
  for (const threshold of [0.70, 0.75, 0.808, 0.85, 0.90, 0.95]) {
    const r = evaluate({ threshold, noiseHz: 50, trials: 40, seed: 13 });
    out.threshold.push({ threshold, ...r });
    const fp = Object.values(r.rhoticFalsePositives).reduce((a, b) => a + b, 0);
    console.log(`   ${threshold.toFixed(3)} |  ${String(r.withRho.correct).padStart(5)} / ${String(r.withRho.wrong).padStart(5)} / ${String(r.withRho.abstain).padStart(5)}            | ${fp}`
      + (threshold === 0.808 ? '   <- shipped' : ''));
  }
  return out;
}

// --- 5. THROUGH THE LIVE PATH ------------------------------------------------------------
//
// Everything above is arithmetic on the P&B norms. This runs the real VoiceAnalyzer over
// synthesized vowels whose identity is known by construction, at the live frame rate, so the
// claim is about the app rather than about the templates.
//
// It is also the measurement that found the thing ρ could not fix. Phase 2 handed over /ɝ/ as
// "separable but not reachable" and named ρ as the dimension that separates it. That is true on
// the norms — §1 above takes the classifier from 95% to 100% held out across speakers. On
// connected speech the rule fired on ZERO frames, and the reason turned out to have nothing to
// do with ρ: the LPC assignment loop admitted a pole as F3 only above 2000 Hz, and Peterson &
// Barney's adult-male /ɝ/ has F3 = 1690 Hz. The extractor could not resolve a rhotic F3 at all.
// The lowest F3 the canonical path ever reported on the Rainbow Passage was 2091 Hz.
//
// The rhotic-capable assignment (app.js F3_RHOTIC_FLOOR_HZ) is a second pass over the poles the
// same solve already produced, so it leaves displayed v1 untouched. It is instrumented only:
// the standard classifier still names /ɝ/ on 0% of frames at every tested F0. The detector
// itself reaches 0%, 3%, and 11.9% recall at F0 110/130/180 while false positives rise from
// 4.3% to 12.6%. Turning it on would therefore trade one systematic miss for wrong feedback on
// other vowels. The strict check remains red until the live path clears both recall and false-
// positive criteria; the published-norm calculation cannot cover that failure.
import { MockAudioContext } from './run-eval-harness.mjs';
import { synthVowel } from './synth-vowel.mjs';

const PB_MALE = {
  i: [270, 2290, 3010], 'ɪ': [390, 1990, 2550], 'ɛ': [530, 1840, 2480], 'æ': [660, 1720, 2410],
  'ɑ': [730, 1090, 2440], 'ɔ': [570, 840, 2410], 'ʊ': [440, 1020, 2240], u: [300, 870, 2240],
  'ʌ': [640, 1190, 2390], 'ɝ': [490, 1350, 1690],
};

const LIVE_F0S = [110, 130, 180];
// Completion conditions for removing the quarantine. Fifty-percent /ɝ/ recall is deliberately
// below the 92.5% produced by the unsafe widened assignment: it catches total target failure
// without demanding a tuned benchmark optimum. The 5% detector false-positive ceiling prevents
// that recall from being bought by calling every low-F3 vowel rhotic. Every vowel must also
// produce at least one correct frame at every F0 so an overall average cannot hide a dead class.
export const RHOTIC_LIVE_ACCEPTANCE = {
  minOverallCorrect: 60,
  maxOverallWrong: 35,
  maxOverallAbstain: 20,
  minRhoticRecall: 50,
  maxDetectorFalsePositiveRate: 5,
};

export function rhoticLiveFailures(result, acceptance = RHOTIC_LIVE_ACCEPTANCE) {
  if (!result) return ['missing live result'];
  const reasons = [];
  if (result.correct < acceptance.minOverallCorrect) reasons.push(`overall correct ${result.correct}%`);
  if (result.wrong > acceptance.maxOverallWrong) reasons.push(`overall wrong ${result.wrong}%`);
  if (result.abstain > acceptance.maxOverallAbstain) reasons.push(`overall abstain ${result.abstain}%`);
  if (result.rhoticRecall < acceptance.minRhoticRecall) reasons.push(`/ɝ/ recall ${result.rhoticRecall}%`);
  if (result.detectorFalsePositiveRate > acceptance.maxDetectorFalsePositiveRate) {
    reasons.push(`rhotic false positives ${result.detectorFalsePositiveRate}%`);
  }
  for (const [vowel, m] of Object.entries(result.perVowel || {})) {
    if (m.correct === 0) reasons.push(`/${vowel}/ has zero correct frames`);
  }
  return reasons;
}

export async function livePath({ f0 = 130, seconds = 1.2 } = {}) {
  const { VoiceAnalyzer } = await import('../app.js');
  const SR = 44100, W = 4096, HOP = Math.round(SR / 60);
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = SR;
  a.isCalibrated = true; a.noiseFloor = 0.005; a.hfNoiseFloor = 0.001; a.micTiltBaselineDb = 0;
  a.resonanceMethod = 'lpc';
  const tally = { correct: 0, wrong: 0, abstain: 0, rhoticDetected: 0 };
  const perVowel = {};
  // One continuous pass over all ten vowels in sequence, so the pooling window holds several
  // vowels — which is the operating point ρ needs and the one connected speech actually is.
  const order = Object.keys(PB_MALE);
  const clips = order.map((v) => {
    const base = PB_MALE[v];
    const df = fitFormantScale([...base, 0]).deltaF;
    return { v, sig: synthVowel({ f0, formants: [...base, 3.5 * df], seconds, sampleRate: SR }) };
  });
  // Two passes: the first fills the pooling window, the second is scored. Scoring the first
  // would be scoring the warm-up.
  for (const pass of [0, 1]) {
    for (const { v, sig } of clips) {
      perVowel[v] = perVowel[v] || {
        correct: 0, wrong: 0, abstain: 0, rhoticDetected: 0, got: {}, rhoReasons: {},
      };
      for (let i = 0; i + W <= sig.length; i += HOP) {
        a.audioCtx._currentChunk = sig.subarray(i, i + W);
        a.update(HOP / SR);
        if (pass === 0) continue;
        if (!(a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25)) continue;
        const got = a.vowelId;
        const bucket = got == null ? 'abstain' : got === v ? 'correct' : 'wrong';
        tally[bucket]++; perVowel[v][bucket]++;
        perVowel[v].got[got || '—'] = (perVowel[v].got[got || '—'] || 0) + 1;
        if (a.rhoticDetected) { tally.rhoticDetected++; perVowel[v].rhoticDetected++; }
        perVowel[v].rhoReasons[a.rhoReason] = (perVowel[v].rhoReasons[a.rhoReason] || 0) + 1;
      }
    }
  }
  const n = tally.correct + tally.wrong + tally.abstain || 1;
  const rhotic = perVowel['ɝ'] || { correct: 0, wrong: 0, abstain: 0, rhoticDetected: 0 };
  const rhoticN = rhotic.correct + rhotic.wrong + rhotic.abstain || 1;
  const nonRhotic = Object.entries(perVowel).filter(([v]) => v !== 'ɝ').map(([, x]) => x);
  const nonRhoticN = nonRhotic.reduce((sum, x) => sum + x.correct + x.wrong + x.abstain, 0) || 1;
  const rhoticFalsePositives = nonRhotic.reduce((sum, x) => sum + x.rhoticDetected, 0);
  return {
    n,
    correct: +(100 * tally.correct / n).toFixed(1),
    wrong: +(100 * tally.wrong / n).toFixed(1),
    abstain: +(100 * tally.abstain / n).toFixed(1),
    rhoticRecall: +(100 * rhotic.correct / rhoticN).toFixed(1),
    detectorRecall: +(100 * rhotic.rhoticDetected / rhoticN).toFixed(1),
    detectorFalsePositiveRate: +(100 * rhoticFalsePositives / nonRhoticN).toFixed(1),
    perVowel,
  };
}

if (process.argv[1] && process.argv[1].endsWith('rho-rhotic.mjs')) {
  const r = report();
  console.log('\n5. THROUGH THE LIVE PATH — the real VoiceAnalyzer over synthesized vowels');
  console.log('   whose identity is known by construction, ten vowels in sequence so the pooling');
  console.log('   window holds several of them (which is what connected speech is):\n');
  r.live = [];
  for (const f0 of LIVE_F0S) {
    const lp = await livePath({ f0 });
    r.live.push({ f0, ...lp });
    console.log(`   F0 ${f0} Hz: ${lp.correct}% correct, ${lp.wrong}% wrong, ${lp.abstain}% abstain `
      + `over ${lp.n} frames`);
    const rho = lp.perVowel['ɝ'];
    if (rho) {
      const tot = rho.correct + rho.wrong + rho.abstain || 1;
      console.log(`     /ɝ/ specifically: ${(100 * rho.correct / tot).toFixed(1)}% correct, `
        + `read as ${JSON.stringify(rho.got)}`);
    }
    console.log(`     detector: ${lp.detectorRecall}% /ɝ/ recall, `
      + `${lp.detectorFalsePositiveRate}% false positives on non-rhotics`);
    console.log(`     per vowel (correct/wrong/abstain): ${Object.entries(lp.perVowel).map(([v, m]) => {
      const vn = m.correct + m.wrong + m.abstain || 1;
      return `/${v}/ ${(100 * m.correct / vn).toFixed(1)}/${(100 * m.wrong / vn).toFixed(1)}/${(100 * m.abstain / vn).toFixed(1)}%`;
    }).join('  ')}`);
  }
  r.livePathRun = true;
  if (process.argv.includes('--check')) {
    let failed = false;
    let quarantinedFailure = false;
    // The one claim this makes: on clean norms held out across speakers, admitting ρ removes
    // the /ɝ/→/æ/ confusion and introduces no other error. If it ever costs one, this fails and
    // the trade has to be re-argued rather than re-tuned.
    if (!(r.clean.withRho.correct > r.clean.base.correct)) {
      console.error(`FAIL: ρ did not improve clean classification (${r.clean.base.correct}% -> ${r.clean.withRho.correct}%)`);
      failed = true;
    }
    if (r.clean.withRho.wrong > 0) {
      console.error(`FAIL: ρ leaves ${r.clean.withRho.wrong}% wrong on clean norms: ${JSON.stringify(r.clean.confusion)}`);
      failed = true;
    }
    // At 50 Hz/formant of deterministic measurement noise, the detector must remain useful
    // across the full vowel set. This is the stress point used by the threshold and window
    // sweeps, and 80% correct / <=20% wrong prevents a clean-only result from passing.
    const noisy50 = r.noise.find((x) => x.noiseHz === 50);
    if (!noisy50 || noisy50.withRho.correct < 80 || noisy50.withRho.wrong > 20) {
      console.error(`FAIL: ρ at 50 Hz/formant noise is ${noisy50?.withRho.correct ?? 'missing'}% correct, `
        + `${noisy50?.withRho.wrong ?? 'missing'}% wrong; expected >=80% correct and <=20% wrong`);
      failed = true;
    }

    for (const lp of r.live) {
      const reasons = rhoticLiveFailures(lp);
      if (reasons.length) {
        console.error(`FAIL live path at F0 ${lp.f0} Hz: ${reasons.join('; ')}`);
        quarantinedFailure = true;
      }
    }

    const allowQuarantine = process.argv.includes('--allow-known-live-rhotic-failure');
    if (quarantinedFailure && allowQuarantine) {
      console.warn('QUARANTINED: VoiceAnalyzer does not meet the live /ɝ/ acceptance criteria.');
      console.warn('Remove the quarantine only after every tested F0 reaches >=50% /ɝ/ recall, <=5% detector false positives, and no vowel has zero correct frames.');
    }
    process.exit(failed || (quarantinedFailure && !allowQuarantine) ? 1 : 0);
  }
}
