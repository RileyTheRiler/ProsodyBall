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
// Usage: node tools/frame-validity.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wav from 'node-wav';
import { MockAudioContext } from './run-eval-harness.mjs';
import { synthVowel } from './synth-vowel.mjs';
import { fitFormantScale, frameValidity } from '../dsp-utils.js';

const SAMPLE_RATE = 44100;
const WINDOW = 4096;
const HOP = Math.round(SAMPLE_RATE / 60);
const DT = HOP / SAMPLE_RATE;
export const BAD_DELTA_F_FRACTION = 0.05;
// Conditions the --check gate asserts on. 6 dB is measured and printed but not asserted; see
// the note at the assertion for why.
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

async function analyzerFor(signal) {
  const { VoiceAnalyzer } = await import('../app.js');
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = SAMPLE_RATE;
  a.isCalibrated = true;
  a.noiseFloor = 0.005;
  a.hfNoiseFloor = 0.001;
  a.micTiltBaselineDb = 0;
  a.resonanceMethod = 'lpc';
  return a;
}

// Additive white noise at a given SNR, so the gates are exercised on frames that are actually
// hard rather than only on frames that are easy. Deterministic generator: a reported curve has
// to be reproducible.
function addNoise(sig, snrDb, seed = 3) {
  if (!Number.isFinite(snrDb)) return sig;
  let st = seed >>> 0;
  const uni = () => ((st = (st * 1664525 + 1013904223) >>> 0) + 1) / 4294967297;
  let p = 0;
  for (let i = 0; i < sig.length; i++) p += sig[i] * sig[i];
  const sigRms = Math.sqrt(p / sig.length);
  const noiseRms = sigRms / Math.pow(10, snrDb / 20);
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    const g = Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni());
    out[i] = sig[i] + noiseRms * g;
  }
  return out;
}

export async function collect({ snrDb = Infinity } = {}) {
  const rows = [];
  for (const [vowel, base] of Object.entries(VOWEL_FORMANTS)) {
    for (const k of SCALES) {
      const formants = base.map((f) => f * k);
      const trueDeltaF = fitFormantScale([...formants, 0]).deltaF;
      for (const f0 of F0S) {
        const signal = addNoise(synthVowel({ f0, formants, seconds: 1.2, sampleRate: SAMPLE_RATE }), snrDb);
        const a = await analyzerFor(signal);
        for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
          a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
          a.update(DT);
          if (!(a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25)) continue;
          const raw = a.canonicalRaw;
          if (!raw || raw.filter((x) => x > 0).length < 2) continue;
          const rawDeltaF = fitFormantScale(raw).deltaF;
          const err = rawDeltaF > 0 ? Math.abs(rawDeltaF - trueDeltaF) / trueDeltaF : 1;
          rows.push({
            vowel, f0, scale: k, err,
            bad: err > BAD_DELTA_F_FRACTION,
            valid: a.frameValid,
            reasons: a.frameInvalidReasons.slice(),
            agreement: a.crossEstimatorAgreement,
            confidence: a.resonanceConfidenceV2,
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

const GATES = ['order', 'residual', 'swap', 'bandwidth', 'continuity'];
const fires = (r, gate) => r.reasons.some((x) => x === gate || x.endsWith(`:${gate}`));

export async function report() {
  const out = { conditions: [] };
  console.log('Frame validity gates — precision and recall on labelled frames\n');
  console.log(`A frame is BAD when its raw-formant ΔF is more than ${100 * BAD_DELTA_F_FRACTION}% from the`);
  console.log('synthesized truth. 5 vowels x 3 tract scales x 4 F0s per condition.\n');

  for (const snrDb of [Infinity, 20, 12, 6]) {
    const rows = await collect({ snrDb });
    const label = Number.isFinite(snrDb) ? `${snrDb} dB SNR` : 'clean';
    const all = pr(rows, (r) => !r.valid);
    out.conditions.push({ snrDb, rows: rows.length, all, gates: {} });
    console.log(`--- ${label} — ${rows.length} frames, ${all.badRate}% of them bad ---`);
    console.log('   gate         reject%  precision  recall');
    for (const gate of GATES) {
      const g = pr(rows, (r) => fires(r, gate));
      out.conditions[out.conditions.length - 1].gates[gate] = g;
      console.log(`   ${gate.padEnd(12)} ${String(g.rejectRate).padStart(6)}%  `
        + `${g.precision == null ? '    —' : String(g.precision).padStart(6) + '%'}  `
        + `${g.recall == null ? '    —' : String(g.recall).padStart(5) + '%'}`);
    }
    console.log(`   ${'ALL (frame)'.padEnd(12)} ${String(all.rejectRate).padStart(6)}%  `
      + `${all.precision == null ? '    —' : String(all.precision).padStart(6) + '%'}  `
      + `${all.recall == null ? '    —' : String(all.recall).padStart(5) + '%'}`);

    // Does the cross-estimator agreement term predict error? §5 is explicit that a gate which
    // costs more than it buys is reported and left off, and this is the number that decides it.
    const withAg = rows.filter((r) => r.agreement != null);
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
    process.exit(failed ? 1 : 0);
  }
}
