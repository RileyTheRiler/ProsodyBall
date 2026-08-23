#!/usr/bin/env node
// Phase 3's two headline acceptance numbers, measured: does estimator identity still move the
// value, and what does the discipline cost in real time?
// docs/RESONANCE_REDESIGN.md §5 Phase 3.
//
// 1. ESTIMATOR IDENTITY. Phase 1 measured the between-method spread on a clean synthetic vowel
//    at 0.111 of the 0-1 scale — the three estimators the `auto` ladder can select disagreeing
//    by eleven points on identical audio, swapped mid-session on room noise, with the user
//    watching the ball and unable to tell a handover from a posture change. This reports the
//    spread again, for v1 and for the v2 stream separately, because they are now different
//    answers: v1 is frozen by the same rule that froze it through Phases 1 and 2 and its spread
//    is unchanged BY DESIGN, while v2 is defined by one estimator and cannot vary at all.
//
// 2. BUDGET. §3.4: "three LPC solves per frame at 60 fps on a phone, a watch and an ESP32 is
//    not affordable", and the scope note is explicit that the budget is a constraint and must
//    be measured rather than assumed. Reported as LPC solves per frame and as wall-clock
//    milliseconds per frame against the 16.7 ms the 60 fps loop has.
//
// 3. SUPPRESSION. §5: "below the SNR floor the app shows NO resonance rather than a substitute."
//    Reported as the rate and, for each frame suppressed, which confidence term collapsed.
//
// Usage: node tools/estimator-discipline.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wav from 'node-wav';
import { MockAudioContext } from './run-eval-harness.mjs';
import { synthVowel } from './synth-vowel.mjs';
import { LPC_DEFAULT_CEILING_HZ } from '../dsp-utils.js';

const SAMPLE_RATE = 44100;
const WINDOW = 4096;
const HOP = Math.round(SAMPLE_RATE / 60);
const DT = HOP / SAMPLE_RATE;
const METHODS = ['lpc', 'cepstral', 'harmonic', 'centroid'];
// The three the `auto` ladder can actually select. Phase 1's 0.111 is measured over these.
const AUTO_METHODS = ['lpc', 'cepstral', 'centroid'];
// The reference vowel DSP_CONTRACT's per-estimator accuracy table is measured on.
const BASE_FORMANTS = [570, 1710, 2850];

async function analyze(signal, method, { ceilingHz = null } = {}) {
  const { VoiceAnalyzer } = await import('../app.js');
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = SAMPLE_RATE;
  a.isCalibrated = true;
  a.noiseFloor = 0.005;
  a.hfNoiseFloor = 0.001;
  a.micTiltBaselineDb = 0;
  a.resonanceMethod = method;
  if (ceilingHz) a.lpcCeilingHz = ceilingHz;
  const v1 = [], v2 = [];
  let frames = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
    a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
    a.update(DT);
    frames++;
    if (a.formantConfidence > 0.2) v1.push(a.smoothResonance);
    if (!a.resonanceSuppressed && a.resonanceAbsolute != null) v2.push(a.resonanceAbsolute);
  }
  const msTotal = Number(process.hrtime.bigint() - t0) / 1e6;
  const back = (xs) => xs.slice(Math.floor(xs.length / 2));
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  return {
    v1: mean(back(v1)), v2: mean(back(v2)),
    v1n: v1.length, v2n: v2.length,
    frames, msPerFrame: msTotal / Math.max(1, frames),
    lpcSolves: a._lpcSolveCount, solvesPerFrame: a._lpcSolveCount / Math.max(1, frames),
  };
}

export async function spread() {
  const signal = synthVowel({ formants: BASE_FORMANTS });
  const per = {};
  for (const m of METHODS) per[m] = await analyze(signal, m);
  const range = (keys, field) => {
    const vals = keys.map((k) => per[k][field]);
    return Math.max(...vals) - Math.min(...vals);
  };
  return {
    per,
    v1All: range(METHODS, 'v1'),
    v1Auto: range(AUTO_METHODS, 'v1'),
    v2All: range(METHODS, 'v2'),
    v2Auto: range(AUTO_METHODS, 'v2'),
  };
}

export async function budget() {
  const signal = synthVowel({ formants: BASE_FORMANTS, seconds: 3.0 });
  const cases = [
    ['lpc, default ceiling (every user today)', 'lpc', null],
    ['lpc, per-user ceiling (post-calibration)', 'lpc', 6000],
    ['harmonic (v1 forced off LPC)', 'harmonic', null],
    ['centroid (v1 forced off LPC)', 'centroid', null],
  ];
  const out = [];
  for (const [label, method, ceilingHz] of cases) {
    const r = await analyze(signal, method, { ceilingHz });
    out.push({ label, method, ceilingHz: ceilingHz || LPC_DEFAULT_CEILING_HZ, ...r });
  }
  return out;
}

// Two hop sizes, because the repo has two "live rates" and they are not the same thing. The
// reporting tools use a 735-sample hop and call it 60 fps, which it is at 44.1 kHz — but the
// only real-audio fixture is 22.05 kHz, where 735 samples is 33 ms, i.e. 30 fps. Every Phase 1
// and Phase 2 yield number on this fixture is at that 30 fps rate, so it is reported here for
// comparability, alongside the rate the rAF loop actually runs at.
export async function suppression({ hopSamples = 0 } = {}) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const decoded = wav.decode(fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'audio-eval', 'rainbow_passage.wav')));
  const { VoiceAnalyzer } = await import('../app.js');
  const out = [];
  // Three noise conditions on the same passage. The clean case says how often the app declines
  // when nothing is wrong; the noisy ones say whether it declines when something is.
  for (const [label, noiseGain] of [['clean', 0], ['+noise (12 dB)', 0.25], ['+noise (3 dB)', 0.71]]) {
    const a = new VoiceAnalyzer();
    await a.start(null, { deviceId: 'mock' });
    a.audioCtx.sampleRate = decoded.sampleRate;
    a.isCalibrated = true; a.noiseFloor = 0.01; a.hfNoiseFloor = 0.001; a.micTiltBaselineDb = 0;
    a.resonanceMethod = 'auto';
    const src = decoded.channelData[0];
    let signal = src;
    if (noiseGain > 0) {
      let st = 17;
      const uni = () => ((st = (st * 1664525 + 1013904223) >>> 0) + 1) / 4294967297;
      let p = 0;
      for (let i = 0; i < src.length; i++) p += src[i] * src[i];
      const rms = Math.sqrt(p / src.length);
      signal = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) {
        signal[i] = src[i] + noiseGain * rms * Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni());
      }
    }
    const hop = hopSamples || Math.round(decoded.sampleRate / 60);
    let frames = 0, suppressed = 0;
    const reasons = {};
    for (let i = 0; i + WINDOW <= signal.length; i += hop) {
      a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
      a.update(hop / decoded.sampleRate);
      if (!(a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25)) continue;
      frames++;
      if (a.resonanceSuppressed) {
        suppressed++;
        reasons[a.resonanceSuppressReason] = (reasons[a.resonanceSuppressReason] || 0) + 1;
      }
    }
    out.push({ label, frames, suppressed, rate: suppressed / Math.max(1, frames), reasons });
  }
  return out;
}

export async function report() {
  const s = await spread();
  console.log('1. DOES ESTIMATOR IDENTITY STILL MOVE THE VALUE?\n');
  console.log('   Same synthesized vowel (F1/F2/F3 = 570/1710/2850), each estimator forced.\n');
  console.log('   method      v1 (displayed)   v2 (canonical)');
  for (const m of METHODS) {
    console.log(`   ${m.padEnd(10)}  ${s.per[m].v1.toFixed(4).padStart(12)}   ${s.per[m].v2.toFixed(4).padStart(12)}`);
  }
  console.log(`\n   spread over all four:            v1 ${s.v1All.toFixed(4)}   v2 ${s.v2All.toFixed(4)}`);
  console.log(`   spread over the 'auto' ladder:   v1 ${s.v1Auto.toFixed(4)}   v2 ${s.v2Auto.toFixed(4)}`);
  console.log('\n   Phase 1 measured the ladder spread at 0.111. v1 is UNCHANGED and that is the');
  console.log('   rule, not a failure: v1 is the displayed metric and its output must stay');
  console.log('   byte-identical until Phase 4 retires it. v2 is exactly 0 — not small, zero,');
  console.log('   because the canonical path has no branch for the estimator identity to take.');

  const b = await budget();
  console.log('\n\n2. REAL-TIME BUDGET (§3.4 — "measure the budget, don\'t assume it")\n');
  console.log('   3 s of held vowel at the live 60 fps rate. The frame budget is 16.67 ms.\n');
  console.log('   case                                        LPC solves/frame   ms/frame   % of budget');
  for (const r of b) {
    console.log(`   ${r.label.padEnd(42)}  ${r.solvesPerFrame.toFixed(3).padStart(14)}   `
      + `${r.msPerFrame.toFixed(3).padStart(8)}   ${(100 * r.msPerFrame / 16.67).toFixed(1).padStart(9)}%`);
  }
  console.log('\n   One solve per frame in the case every user is in today: v1\'s `lpc` branch and the');
  console.log('   canonical path want the same ceiling, so they share the solve. Two only where v1');
  console.log('   is forced onto a different estimator or the user has calibrated a non-default');
  console.log('   ceiling — and that second solve exists ONLY because v1 must not move while it is');
  console.log('   still displayed. Phase 4 retires v1 and takes it with it. §3.4\'s three solves per');
  console.log('   frame is never reached at any setting.');

  console.log('\n\n3. SUPPRESSION — what the user sees below the floor (§5, D1)\n');
  console.log('   Rainbow Passage (22.05 kHz), `auto`, at three noise levels, at both rates the');
  console.log('   repo calls live: the 735-sample hop every Phase 1/2 yield number is measured at');
  console.log('   (33 ms on this fixture, 30 fps) and the rAF loop\'s true 60 fps.\n');
  const sup = {};
  for (const [rateLabel, hopSamples] of [['30 fps (735-sample hop)', 735], ['60 fps (rAF rate)', 0]]) {
    sup[rateLabel] = await suppression({ hopSamples });
    console.log(`   ${rateLabel}`);
    console.log('     condition        frames   suppressed   what collapsed');
    for (const r of sup[rateLabel]) {
      console.log(`     ${r.label.padEnd(15)}  ${String(r.frames).padStart(6)}   `
        + `${(100 * r.rate).toFixed(1).padStart(9)}%   ${JSON.stringify(r.reasons)}`);
    }
  }
  console.log('\n   WHAT THE USER SEES: nothing. A suppressed frame clears resonanceAbsolute, the');
  console.log('   pooled scale, the apparent tract length, the vowel and f2Position — it does not');
  console.log('   freeze them at their last value and it does not substitute a brightness number');
  console.log('   that is computable from noise but wrong, which is the trap D1 names. It also');
  console.log('   closes any open vowel nucleus, because a frame the app declined to read is not');
  console.log('   a frame of a vowel.');
  return { spread: s, budget: b, suppression: sup };
}

if (process.argv[1] && process.argv[1].endsWith('estimator-discipline.mjs')) {
  const r = await report();
  if (process.argv.includes('--check')) {
    let failed = false;
    // §5's first acceptance criterion, as an equality rather than an inequality: the canonical
    // value must be IDENTICAL under every estimator setting. Not "close" — identical. If a
    // future change routes any part of the v2 stream back through the active estimator, this is
    // the assertion that catches it.
    if (!(r.spread.v2All === 0)) {
      console.error(`FAIL: v2 spread across estimators is ${r.spread.v2All}, must be exactly 0`);
      failed = true;
    }
    // The budget, as the constraint §3.4 states: never three solves per frame.
    for (const b of r.budget) {
      if (b.solvesPerFrame > 2.001) {
        console.error(`FAIL: ${b.label} costs ${b.solvesPerFrame.toFixed(3)} LPC solves per frame`);
        failed = true;
      }
    }
    // And the suppression must actually engage as noise rises, at every rate, or it is
    // decoration.
    for (const [rateLabel, rows] of Object.entries(r.suppression)) {
      const clean = rows[0], noisy = rows[rows.length - 1];
      if (!(noisy.rate > clean.rate)) {
        console.error(`FAIL: at ${rateLabel} suppression does not rise with noise `
          + `(${clean.rate} -> ${noisy.rate})`);
        failed = true;
      }
    }
    process.exit(failed ? 1 : 0);
  }
}
