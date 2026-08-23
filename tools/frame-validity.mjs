#!/usr/bin/env node
// Frame validity gates: precision, recall, and what each one costs.
// docs/RESONANCE_REDESIGN.md §5 Phase 3 — "report precision/recall against frames you can
// label (the synthetic vowels have ground truth; the Rainbow Passage does not)".
//
// The gates exist to reject frames whose formants are wrong. Whether they do is answerable
// only where "wrong" is defined, which is on synthesized vowels whose F1/F2/F3 are known by
// construction. The Rainbow Passage has no ground truth, so it appears here only as a COST
// measurement — how much yield each gate takes on real connected speech — never as evidence
// that a gate is right.
//
// A frame is labelled BAD when the ΔF fitted to its RAW formants deviates from the ΔF of the
// synthesized formants by more than BAD_DELTA_F_FRACTION. ΔF is the quantity the measurement
// actually reports, and DSP_CONTRACT records that a 1% ΔF error moves v1's displayed score by
// ~5 points, so 5% is a quarter of the meter — unambiguously an error rather than scatter.
//
// The report now follows the gate through to the live pooled output and includes every target
// frame. Precision, accurate-frame recall, abstention, wrong-output rate, and each vowel/F0
// subgroup are asserted separately. `--check` is strict; CI may name the current noisy-speech
// quarantine explicitly with `--allow-known-validity-failures`, but the failures still print.
//
// Usage: node tools/frame-validity.mjs [--check] [--allow-known-validity-failures]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wav from 'node-wav';
import { MockAudioContext } from './run-eval-harness.mjs';
import { synthVowel } from './synth-vowel.mjs';
import { fitFormantScale } from '../dsp-utils.js';

const SAMPLE_RATE = 44100;
const WINDOW = 4096;
const HOP = Math.round(SAMPLE_RATE / 60);
const DT = HOP / SAMPLE_RATE;
export const BAD_DELTA_F_FRACTION = 0.05;
// Raw gate discrimination is asserted through 12 dB. At 6 dB the whole analyzer is expected to
// abstain, and that user-facing behavior has its own exact assertion below.
const ASSERTED_SNR_DB = [Infinity, 20, 12];

// Five Peterson & Barney vowels at a range of tract scales, so the gates are measured across
// vowel identity and speaker size rather than on one signal. Formants are the male P&B means
// rescaled; ΔF is whatever the weighted fit makes of them, which is the same arithmetic the
// app uses, so the label and the measurement are on one ruler.
const VOWEL_FORMANTS = {
  i: [270, 2290, 3010],
  'ɛ': [530, 1840, 2480],
  'ɑ': [730, 1090, 2440],
  u: [300, 870, 2240],
  'ʌ': [640, 1190, 2390],
};
const SCALES = [0.90, 1.00, 1.12];
const F0S = [100, 150, 200, 260];

async function analyzerFor(calibrationNoise = null) {
  const { VoiceAnalyzer } = await import('../app.js');
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = SAMPLE_RATE;
  if (calibrationNoise) {
    // The live analyzer knows the room noise because users calibrate before practice. Feeding
    // noisy speech while leaving the analyzer's noise profile at a clean-room fallback tests a
    // deliberately misconfigured product and prevents the SNR abstention path from doing its
    // job. Calibrate on noise of the same power, but a different deterministic draw.
    a.noiseCalibrationDuration = 0.5;
    const log = console.log;
    console.log = () => {};
    try {
      for (let i = 0; i + WINDOW <= calibrationNoise.length && !a.isCalibrated; i += HOP) {
        a.audioCtx._currentChunk = calibrationNoise.subarray(i, i + WINDOW);
        a.update(DT);
      }
      if (!a.isCalibrated) a.finalizeNoiseCalibration();
    } finally {
      console.log = log;
    }
  } else {
    a.isCalibrated = true;
    a.noiseFloor = 0.005;
    a.hfNoiseFloor = 0.001;
    a.micTiltBaselineDb = 0;
  }
  a.resonanceMethod = 'lpc';
  return a;
}

// Additive white noise at a given SNR, so the gates are exercised on frames that are actually
// hard rather than only on frames that are easy. Deterministic generator: a reported curve has
// to be reproducible.
function gaussianNoise(length, rms, seed) {
  let st = seed >>> 0;
  const uni = () => ((st = (st * 1664525 + 1013904223) >>> 0) + 1) / 4294967297;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const g = Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni());
    out[i] = rms * g;
  }
  return out;
}

function addNoise(sig, snrDb, seed = 3) {
  if (!Number.isFinite(snrDb)) return { signal: sig, calibrationNoise: null };
  let p = 0;
  for (let i = 0; i < sig.length; i++) p += sig[i] * sig[i];
  const sigRms = Math.sqrt(p / sig.length);
  const noiseRms = sigRms / Math.pow(10, snrDb / 20);
  const noise = gaussianNoise(sig.length, noiseRms, seed);
  const signal = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) signal[i] = sig[i] + noise[i];
  return { signal, calibrationNoise: gaussianNoise(sig.length, noiseRms, seed + 1009) };
}

export async function collect({ snrDb = Infinity } = {}) {
  const rows = [];
  for (const [vowel, base] of Object.entries(VOWEL_FORMANTS)) {
    for (const k of SCALES) {
      const formants = base.map((f) => f * k);
      const trueDeltaF = fitFormantScale([...formants, 0]).deltaF;
      for (const f0 of F0S) {
        const noisy = addNoise(synthVowel({ f0, formants, seconds: 1.2, sampleRate: SAMPLE_RATE }), snrDb);
        const signal = noisy.signal;
        const a = await analyzerFor(noisy.calibrationNoise);
        for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
          a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
          a.update(DT);
          const analyzerRan = a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25;
          const raw = a.canonicalRaw;
          const rawDeltaF = analyzerRan && raw && raw.filter((x) => x > 0).length >= 2
            ? fitFormantScale(raw).deltaF : 0;
          const err = rawDeltaF > 0 ? Math.abs(rawDeltaF - trueDeltaF) / trueDeltaF : null;
          const acceptedDeltaF = analyzerRan && a.frameValid
            ? fitFormantScale(a.canonicalAccepted).deltaF : 0;
          const acceptedErr = acceptedDeltaF > 0
            ? Math.abs(acceptedDeltaF - trueDeltaF) / trueDeltaF : null;
          const outputDeltaF = !a.resonanceSuppressed ? a.formantScaleHz : 0;
          const outputErr = outputDeltaF > 0
            ? Math.abs(outputDeltaF - trueDeltaF) / trueDeltaF : null;
          rows.push({
            vowel, f0, scale: k, trueDeltaF, rawDeltaF, err,
            bad: err == null ? null : err > BAD_DELTA_F_FRACTION,
            analyzerRan,
            valid: a.frameValid,
            acceptedDeltaF,
            acceptedErr,
            outputDeltaF,
            outputErr,
            reasons: a.frameInvalidReasons.slice(),
            agreement: a.crossEstimatorAgreement,
            confidence: a.resonanceConfidenceV2,
            canonicalRaw: Array.isArray(raw) ? raw.slice() : [0, 0, 0, 0],
            canonicalAccepted: Array.isArray(a.canonicalAccepted)
              ? a.canonicalAccepted.slice() : [0, 0, 0, 0],
          });
        }
      }
    }
  }
  return rows;
}

// Precision = of the frames a gate rejected, what fraction were actually bad.
// Recall    = of the frames that were actually bad, what fraction did it reject.
function pr(rows, rejects) {
  const rejected = rows.filter(rejects);
  const bad = rows.filter((r) => r.bad);
  const tp = rejected.filter((r) => r.bad).length;
  return {
    n: rows.length,
    badRate: +(100 * bad.length / Math.max(1, rows.length)).toFixed(1),
    rejected: rejected.length,
    rejectRate: +(100 * rejected.length / Math.max(1, rows.length)).toFixed(1),
    precision: rejected.length ? +(100 * tp / rejected.length).toFixed(1) : null,
    recall: bad.length ? +(100 * tp / bad.length).toFixed(1) : null,
  };
}

// User-facing accuracy for a stage that may abstain. Precision answers "when the stage emits,
// how often is it within the documented 5% ΔF tolerance?" Recall answers "of all eligible
// voiced/vowel-like frames, how often does it emit an accurate value?" Reporting both prevents
// an always-abstaining gate from claiming perfect precision and an always-emitting gate from
// hiding wrong values in coverage.
export function outputMetrics(rows, errorKey) {
  const emitted = rows.filter((r) => r[errorKey] != null);
  const correct = emitted.filter((r) => r[errorKey] <= BAD_DELTA_F_FRACTION).length;
  const wrong = emitted.length - correct;
  const n = rows.length || 1;
  return {
    n: rows.length,
    correct,
    wrong,
    abstain: rows.length - emitted.length,
    precision: +(100 * correct / Math.max(1, emitted.length)).toFixed(1),
    recall: +(100 * correct / n).toFixed(1),
    wrongRate: +(100 * wrong / n).toFixed(1),
    abstainRate: +(100 * (rows.length - emitted.length) / n).toFixed(1),
  };
}

const GATES = ['order', 'residual', 'swap', 'bandwidth', 'continuity'];
const fires = (r, gate) => r.reasons.some((x) => x === gate || x.endsWith(`:${gate}`));
const gateIntervened = (r) => !r.valid || [0, 1, 2, 3]
  .some((i) => (r.canonicalAccepted?.[i] || 0) !== (r.canonicalRaw?.[i] || 0));

// These floors describe minimally usable feedback, not the current implementation. A value
// outside 5% ΔF error can move v1 by roughly a quarter of its full meter, so emitting it is a
// material false reading. Clean precision is held to 90%; noisy conditions may abstain more,
// but at least four of five emitted readings still need to be accurate. Recall floors prevent
// an always-abstaining gate from claiming perfect precision. Gate false positives are capped at
// 5% clean and 25–30% in noise so validity filtering cannot discard more than a small clean
// minority or roughly one noisy frame in four. The subgroup floor prevents an average from
// hiding a vowel or F0 with no accurate output at all.
export const FRAME_LIVE_ACCEPTANCE = new Map([
  [Infinity, { minPrecision: 90, minRecall: 50, maxWrongRate: 10, maxAbstainRate: 50,
    maxInterventionFalsePositiveRate: 5, minSubgroupRecall: 10 }],
  [20,       { minPrecision: 80, minRecall: 20, maxWrongRate: 20, maxAbstainRate: 70,
    maxInterventionFalsePositiveRate: 25, minSubgroupRecall: 5 }],
  [12,       { minPrecision: 80, minRecall: 10, maxWrongRate: 20, maxAbstainRate: 85,
    maxInterventionFalsePositiveRate: 30, minSubgroupRecall: 5 }],
]);

export function frameAcceptanceFailures(condition, floor = FRAME_LIVE_ACCEPTANCE.get(condition?.snrDb)) {
  if (!condition || !floor) return ['missing acceptance condition'];
  const failures = [];
  const live = condition.live || {};
  if (live.precision < floor.minPrecision) failures.push(`precision ${live.precision}% < ${floor.minPrecision}%`);
  if (live.recall < floor.minRecall) failures.push(`recall ${live.recall}% < ${floor.minRecall}%`);
  if (live.wrongRate > floor.maxWrongRate) failures.push(`wrong ${live.wrongRate}% > ${floor.maxWrongRate}%`);
  if (live.abstainRate > floor.maxAbstainRate) failures.push(`abstain ${live.abstainRate}% > ${floor.maxAbstainRate}%`);
  const interventionFp = condition.intervention?.falsePositiveRate;
  if (interventionFp == null) failures.push('missing intervention false-positive rate');
  else if (interventionFp > floor.maxInterventionFalsePositiveRate) {
    failures.push(`intervention false positives ${interventionFp}% > ${floor.maxInterventionFalsePositiveRate}%`);
  }
  for (const [vowel, m] of Object.entries(condition.perVowel || {})) {
    if (m.recall < floor.minSubgroupRecall) failures.push(`/${vowel}/ recall ${m.recall}% < ${floor.minSubgroupRecall}%`);
  }
  for (const [f0, m] of Object.entries(condition.perF0 || {})) {
    if (m.recall < floor.minSubgroupRecall) failures.push(`${f0} Hz recall ${m.recall}% < ${floor.minSubgroupRecall}%`);
  }
  return failures;
}

export async function report() {
  const out = { conditions: [] };
  console.log('Frame validity gates — precision and recall on labelled frames\n');
  console.log(`A frame is BAD when its raw-formant ΔF is more than ${100 * BAD_DELTA_F_FRACTION}% from the`);
  console.log('synthesized truth. 5 vowels x 3 tract scales x 4 F0s per condition.\n');

  for (const snrDb of [Infinity, 20, 12, 6]) {
    const rows = await collect({ snrDb });
    const labelled = rows.filter((r) => r.bad != null);
    const label = Number.isFinite(snrDb) ? `${snrDb} dB SNR` : 'clean';
    const all = pr(labelled, (r) => !r.valid);
    const intervention = pr(labelled, gateIntervened);
    const good = labelled.filter((r) => !r.bad);
    intervention.falsePositiveRate = +(100 * good.filter(gateIntervened).length
      / Math.max(1, good.length)).toFixed(1);
    const accepted = outputMetrics(rows, 'acceptedErr');
    const live = outputMetrics(rows, 'outputErr');
    const perVowel = Object.fromEntries(Object.keys(VOWEL_FORMANTS)
      .map((vowel) => [vowel, outputMetrics(rows.filter((r) => r.vowel === vowel), 'outputErr')]));
    const perF0 = Object.fromEntries(F0S
      .map((f0) => [f0, outputMetrics(rows.filter((r) => r.f0 === f0), 'outputErr')]));
    out.conditions.push({ snrDb, rows: rows.length, labelledRows: labelled.length,
      all, intervention, accepted, live, perVowel, perF0, gates: {} });
    console.log(`--- ${label} — ${rows.length} target frames, ${labelled.length} with raw formants, `
      + `${all.badRate}% of those bad ---`);
    console.log('   gate         reject%  precision  recall');
    for (const gate of GATES) {
      const g = pr(labelled, (r) => fires(r, gate));
      out.conditions[out.conditions.length - 1].gates[gate] = g;
      console.log(`   ${gate.padEnd(12)} ${String(g.rejectRate).padStart(6)}%  `
        + `${g.precision == null ? '    —' : String(g.precision).padStart(6) + '%'}  `
        + `${g.recall == null ? '    —' : String(g.recall).padStart(5) + '%'}`);
    }
    console.log(`   ${'ALL (frame)'.padEnd(12)} ${String(all.rejectRate).padStart(6)}%  `
      + `${all.precision == null ? '    —' : String(all.precision).padStart(6) + '%'}  `
      + `${all.recall == null ? '    —' : String(all.recall).padStart(5) + '%'}`);
    console.log(`   any intervention: precision ${intervention.precision ?? '—'}%, `
      + `recall ${intervention.recall ?? '—'}%, false-positive rate ${intervention.falsePositiveRate}%`);
    console.log(`   post-gate accepted: precision ${accepted.precision}%, recall ${accepted.recall}%, `
      + `wrong ${accepted.wrongRate}%, abstain ${accepted.abstainRate}%`);
    console.log(`   live pooled output: precision ${live.precision}%, recall ${live.recall}%, `
      + `wrong ${live.wrongRate}%, abstain ${live.abstainRate}%`);
    console.log(`   live by vowel (correct/wrong/abstain): ${Object.entries(perVowel)
      .map(([vowel, m]) => `/${vowel}/ ${m.recall}/${m.wrongRate}/${m.abstainRate}%`).join('  ')}`);
    console.log(`   live by F0 (correct/wrong/abstain): ${Object.entries(perF0)
      .map(([f0, m]) => `${f0} Hz ${m.recall}/${m.wrongRate}/${m.abstainRate}%`).join('  ')}`);

    // Does the cross-estimator agreement term predict error? §5 is explicit that a gate which
    // costs more than it buys is reported and left off, and this is the number that decides it.
    const withAg = labelled.filter((r) => r.agreement != null);
    if (withAg.length > 20) {
      const sorted = withAg.slice().sort((a, b) => a.agreement - b.agreement);
      const q = Math.max(1, Math.floor(sorted.length / 4));
      const lowAg = sorted.slice(0, q), highAg = sorted.slice(-q);
      const badPct = (xs) => +(100 * xs.filter((r) => r.bad).length / xs.length).toFixed(1);
      const line = { lowQuartileBad: badPct(lowAg), highQuartileBad: badPct(highAg) };
      out.conditions[out.conditions.length - 1].agreement = line;
      console.log(`   cross-estimator agreement: bad-frame rate in its lowest quartile `
        + `${line.lowQuartileBad}% vs highest ${line.highQuartileBad}%`);
    }
    console.log();
  }

  // COST on real connected speech. No ground truth here, so this is not evidence a gate is
  // right — only how much it takes.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const decoded = wav.decode(fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'audio-eval', 'rainbow_passage.wav')));
  const { VoiceAnalyzer } = await import('../app.js');
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = decoded.sampleRate;
  a.isCalibrated = true; a.noiseFloor = 0.01; a.hfNoiseFloor = 0.001; a.micTiltBaselineDb = 0;
  a.resonanceMethod = 'lpc';
  const audio = decoded.channelData[0];
  const hop = 735;
  const cost = { frames: 0, invalid: 0, byGate: {} };
  for (let i = 0; i + WINDOW <= audio.length; i += hop) {
    a.audioCtx._currentChunk = audio.subarray(i, i + WINDOW);
    a.update(hop / decoded.sampleRate);
    if (!(a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25)) continue;
    cost.frames++;
    if (!a.frameValid) cost.invalid++;
    for (const gate of GATES) if (fires({ reasons: a.frameInvalidReasons }, gate)) {
      cost.byGate[gate] = (cost.byGate[gate] || 0) + 1;
    }
  }
  out.cost = cost;
  console.log('--- Cost on the Rainbow Passage (no ground truth: cost only, not evidence) ---');
  console.log(`   ${cost.frames} estimator frames, ${(100 * cost.invalid / cost.frames).toFixed(1)}% frame-invalid`);
  for (const gate of GATES) {
    console.log(`   ${gate.padEnd(12)} fires on ${(100 * (cost.byGate[gate] || 0) / cost.frames).toFixed(1)}% of frames`);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('frame-validity.mjs')) {
  const r = await report();
  if (process.argv.includes('--check')) {
    let failed = false;
    let quarantinedFailure = false;
    // The one claim the gates make: the frames they reject are worse than the frames they
    // admit. Stated as precision above the base rate, which is the weakest form of the claim
    // that is still a claim — a gate rejecting frames at the base rate is rejecting at random.
    //
    // ASSERTED DOWN TO 12 dB AND NOT BELOW, because at 6 dB the gates measurably stop
    // discriminating: 82.6% of frames are bad and they reject at 82.7% precision, which is the
    // base rate. That is not a gate failure, it is the SNR floor doing its job instead — below
    // it the app shows no resonance at all, so there is nothing for a validity gate to select
    // from. Asserting it anyway would be a knife-edge test dressed up as a claim.
    for (const c of r.conditions) {
      if (!ASSERTED_SNR_DB.includes(c.snrDb)) continue;
      if (c.all.rejected < 10) continue;
      if (!(c.all.precision > c.all.badRate + 2)) {
        console.error(`FAIL at ${c.snrDb} dB: gates reject at ${c.all.precision}% precision `
          + `against a ${c.all.badRate}% base rate — no better than at random`);
        failed = true;
      }
    }
    // The bandwidth gate on clean audio, where the label is unambiguous: it must not be
    // rejecting good frames. This is the gate with the clearest physical meaning (a pole whose
    // bandwidth is most of its own frequency is not a resonance) and the one most likely to be
    // quietly loosened by a future change.
    const clean = r.conditions.find((c) => !Number.isFinite(c.snrDb));
    if (clean && clean.gates.bandwidth.rejected >= 10 && !(clean.gates.bandwidth.precision >= 90)) {
      console.error(`FAIL: bandwidth gate precision on clean audio is `
        + `${clean.gates.bandwidth.precision}%, expected >= 90%`);
      failed = true;
    }

    for (const c of r.conditions) {
      if (c.snrDb === 6) {
        // The contract says the app must emit no resonance below its usable SNR floor. At 6 dB
        // silence is the correct result, so this is an abstention assertion rather than an
        // accuracy assertion over values the analyzer correctly refused to produce.
        if (!(c.live.abstainRate === 100 && c.live.wrongRate === 0)) {
          console.error(`FAIL at 6 dB: expected 100% abstention and 0% wrong output, got `
            + `${c.live.abstainRate}% abstain and ${c.live.wrongRate}% wrong`);
          failed = true;
        }
        continue;
      }
      const floor = FRAME_LIVE_ACCEPTANCE.get(c.snrDb);
      if (!floor) continue;
      const failures = frameAcceptanceFailures(c, floor);
      if (failures.length) {
        const label = Number.isFinite(c.snrDb) ? `${c.snrDb} dB` : 'clean';
        console.error(`FAIL live output at ${label}: ${failures.join('; ')}`);
        // Clean regressions are never quarantined. The existing 20/12 dB failures are allowed
        // only by the explicit CI quarantine flag below, so the strict command stays red.
        if (c.snrDb === 20 || c.snrDb === 12) quarantinedFailure = true;
        else failed = true;
      }
    }

    const allowQuarantine = process.argv.includes('--allow-known-validity-failures');
    if (quarantinedFailure && allowQuarantine) {
      console.warn('QUARANTINED: noisy-speech ΔF output is below the documented acceptance floors.');
      console.warn('Remove the quarantine only when every 20/12 dB aggregate and vowel/F0 subgroup passes.');
    }
    process.exit(failed || (quarantinedFailure && !allowQuarantine) ? 1 : 0);
  }
}
