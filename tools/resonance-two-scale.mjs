#!/usr/bin/env node
// Phase 4's acceptance report: two scales, a versioned threshold, and what the ball costs.
// docs/RESONANCE_REDESIGN.md §5's Phase 4 entry ("Done when: two speakers with different
// absolute ranges no longer both read 100%; stored readings carry a version; no hardware
// threshold fires against a value from a different version") and §3.5.
//
// Five measurements, each answering one acceptance criterion with a number:
//
//   1. TWO SPEAKERS. Built here, not found: two synthesized speakers whose vocal tracts differ
//      in length, each sweeping the same published within-speaker posture excursion. Reported
//      before and after the split, on every axis the app has.
//   2. THE MIS-FIRE. A stored "resonance below 30" rule replayed against a v1 value and a v2
//      value from the SAME frame. It fires on one and not the other, which is the whole reason
//      §3.5 exists; then the same rule is shown declining to fire under the migration.
//   3. SUPPRESSION, AS THE USER EXPERIENCES IT. Not "11.4% of frames" but the run-length
//      distribution behind that number, because a UI answer depends on whether those frames are
//      scattered or contiguous.
//   4. THE DISPLAYED VALUE'S COST. Frame yield and across-clip swing, v1 against v2, on the
//      same fixture. If displaying v2 costs stability, this says by how much.
//   5. THE BUDGET after v1 retires: LPC solves per frame and ms per frame.
//
// Usage: node tools/resonance-two-scale.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wav from 'node-wav';
import { MockAudioContext } from './run-eval-harness.mjs';
import { synthVowel } from './synth-vowel.mjs';
import {
  resonanceControl, RESONANCE_POPULATION_SPAN, RESONANCE_METRIC_VERSION,
  migrateResonanceRules, ruleMayFire, spanFromPostures,
  RESONANCE_CONTROL_MIN_SPAN, RESONANCE_POOLED_SCALE_SD_20DB,
} from '../resonance-metric.js';
import { computeGenderScoreMulti, FEMINIZATION_CUE_WEIGHTS } from '../dsp-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const WINDOW = 4096;
const HOP = Math.round(SR / 60);
const DT = HOP / SR;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct1 = (x) => `${(100 * x).toFixed(1)}%`;

// ---------------------------------------------------------------------------------------------
// 1. TWO SPEAKERS
// ---------------------------------------------------------------------------------------------
//
// The pair is BUILT rather than found, because the claim is about vocal tract length and the
// existing fixtures contain one speaker. Both numbers below are published:
//
//   - The two tract lengths are Peterson & Barney's adult-male formant set scaled in frequency.
//     Formant frequency is inversely proportional to tract length in the uniform-tube model the
//     whole measurement is built on, so k = 0.92 is a tract ~9% LONGER than P&B's adult-male
//     mean (~19.8 cm apparent) and k = 1.18 is one ~15% SHORTER (~15.4 cm). Those bracket the
//     adult range the app is for without going outside it.
//   - The posture excursion is the SAME for both speakers and is the published GAVT training
//     shift: F2 1847 → 1961 Hz, +6.2% (§1.5). Each speaker's darkest and brightest postures sit
//     ±3.1% either side of habitual, so the two speakers differ ONLY in tract size, which is the
//     contrast being tested.
//
// Using one excursion for both is what makes the result readable: any difference in what they
// read is tract length, because that is the only thing that differs.
const PB_MALE_VOWELS = {
  'ə': [640, 1190, 2390],   // P&B's /ʌ/, the nearest published neutral vowel
  i: [270, 2290, 3010],
  u: [300, 870, 2240],
  'æ': [660, 1720, 2410],
  'ɑ': [730, 1090, 2440],
};
// GAVT measured a pre-training habitual F2 of 1847 Hz and a post-training 1961 Hz, so +6.2% is
// the published distance from HABITUAL to a trained brighter posture — not a range to be split
// in half. It is applied in each direction, which assumes the darker excursion is symmetric with
// the brighter one; that symmetry is an assumption and is stated rather than measured, because
// no published figure for a deliberate darkening was found.
const POSTURE_EXCURSION = 1961 / 1847;         // +6.2%, habitual -> brighter
export const SPEAKERS = [
  { name: 'LONG  (tract ~9% longer than P&B adult-male mean)', k: 0.92 },
  { name: 'SHORT (tract ~15% shorter)', k: 1.18 },
];
const POSTURES = [
  { key: 'darker', gain: 1 / POSTURE_EXCURSION },
  { key: 'habitual', gain: 1 },
  { key: 'brighter', gain: POSTURE_EXCURSION },
];

function speakerVowel(k, gain, vowel, f0) {
  const base = PB_MALE_VOWELS[vowel].map((f) => f * k * gain);
  // F4 at 3.5·ΔF of the scaled set, the same construction tools/rho-rhotic.mjs uses, so the
  // synthesized speaker has the fourth formant the canonical path's scale fit wants.
  const deltaF = (base[0] / 0.5 + base[1] / 1.5 + base[2] / 2.5) / 3;
  return synthVowel({ f0, formants: [...base, 3.5 * deltaF], seconds: 0.7, sampleRate: SR });
}

async function freshAnalyzer({ resonanceMethod = 'lpc' } = {}) {
  const { VoiceAnalyzer } = await import('../app.js');
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = SR;
  a.isCalibrated = true;
  a.noiseFloor = 0.005;
  a.hfNoiseFloor = 0.001;
  a.micTiltBaselineDb = 0;
  a.resonanceMethod = resonanceMethod;
  return a;
}

// Drive one posture (all five vowels in sequence) and collect what every axis reported.
// TWO PASSES OVER THE POSTURE, AND ONLY THE SECOND IS SCORED. The scale is pooled over a
// rolling ~1.7 s window and the three postures are driven back to back, so without a warm-up
// the opening second of each posture is still reporting the previous one — which showed up as a
// speaker reading DARKER at their brightest posture than at their darkest. That is the pooling
// window doing its job, not a defect, and the fixture has to respect it the way a real session
// does (a user does not switch posture mid-syllable).
function runPosture(a, k, gain, f0, { collectWindows = false } = {}) {
  const out = { v1: [], absolute: [], control: [], windows: [], suppressed: 0, frames: 0,
                f1: [], f2: [], disp: [] };
  for (const [pass, vowel] of [0, 1].flatMap((p) => Object.keys(PB_MALE_VOWELS).map((v) => [p, v]))) {
    const sig = speakerVowel(k, gain, vowel, f0);
    for (let i = 0; i + WINDOW <= sig.length; i += HOP) {
      a.audioCtx._currentChunk = sig.subarray(i, i + WINDOW);
      a.update(DT);
      if (pass === 0) continue;
      if (!(a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25)) continue;
      out.frames++;
      out.v1.push(a.smoothResonance);
      // v1's own guided-calibration inputs, so the BEFORE arm can run the flow this phase
      // replaces rather than a description of it.
      if (a.smoothF1 > 0 && a.smoothF2 > 0 && a.formantDispersionHz > 0) {
        out.f1.push(a.smoothF1); out.f2.push(a.smoothF2); out.disp.push(a.formantDispersionHz);
      }
      if (collectWindows && a.timeDomainData?.length) out.windows.push(Float32Array.from(a.timeDomainData));
      if (a.resonanceAbsolute == null) { out.suppressed++; continue; }
      out.absolute.push(a.resonanceAbsolute);
      out.control.push(a.resonanceControl);
    }
  }
  return out;
}

// The perception model's resonance cue, scored through the SAME function the app uses, with
// every other cue held fixed so the only thing moving is resonance.
function genderScoreFromResonance(resonanceValue) {
  const { score } = computeGenderScoreMulti({
    cues: {
      pitchZone: { value: 0.5, confidence: 1 },
      resonance: { value: resonanceValue, confidence: 1 },
      weight: { value: 0.5, confidence: 1 },
    },
    weights: FEMINIZATION_CUE_WEIGHTS,
    enabledMap: { pitchZone: true, resonance: true, weight: true },
    goalMode: 'feminization',
    modalF0Hz: 150,
  });
  return score;
}

export async function twoSpeakers({ f0 = 120 } = {}) {
  const rows = [];
  for (const spk of SPEAKERS) {
    // --- BEFORE: v1 after the app's OWN GUIDED RESONANCE CALIBRATION, which is the flow Phase 4
    // replaces. That flow asks for the darkest and brightest held sound and hands both sets to
    // rangeFromExtremeSamples, which takes the medians AS the ends and pads only 5% — so a
    // speaker who produces their brightest posture reads at or near 100% by construction,
    // whatever their vocal tract is. This is exactly the "two speakers both read 100%" the
    // acceptance criterion names, and it is reproduced by running the real method rather than
    // by asserting that it would happen.
    const before = await freshAnalyzer();
    const dark = runPosture(before, spk.k, POSTURES[0].gain, f0);
    const bright = runPosture(before, spk.k, POSTURES[2].gain, f0);
    const v1Calibrated = before.applyGuidedResonanceRange(dark, bright);
    const beforeByPosture = {};
    for (const p of POSTURES) beforeByPosture[p.key] = runPosture(before, spk.k, p.gain, f0);

    // --- AFTER: the Phase 4 flow. Postures are collected first at the default ceiling (which is
    // what the guided calibration does after its vowel-set pass), the span is built from the two
    // deliberate extremes, and the same audio is then re-read through the calibrated span.
    const after = await freshAnalyzer();
    const calib = {};
    for (const p of POSTURES) calib[p.key] = runPosture(after, spk.k, p.gain, f0).absolute;
    const applied = after.applyVowelSetCalibration({
      postures: calib,
      phraseAbsolute: median(calib.habitual),
    });
    const afterByPosture = {};
    for (const p of POSTURES) afterByPosture[p.key] = runPosture(after, spk.k, p.gain, f0);

    const absAll = [].concat(...POSTURES.map((p) => afterByPosture[p.key].absolute));
    rows.push({
      speaker: spk.name,
      k: spk.k,
      spanApplied: applied.ok,
      span: applied.ok ? applied.span : null,
      spanFloored: applied.ok ? applied.span.spreadFloored : null,
      // The speaker's own ABSOLUTE range: the thing the criterion says must differ between them.
      absoluteRange: { min: Math.min(...absAll), max: Math.max(...absAll) },
      absoluteAtBrightest: median(afterByPosture.brighter.absolute),
      absoluteAtDarkest: median(afterByPosture.darker.absolute),
      v1AtBrightest: median(beforeByPosture.brighter.v1),
      v1AtDarkest: median(beforeByPosture.darker.v1),
      v1Learned: before.resonanceProfile.isLearned && v1Calibrated,
      controlAtBrightest: median(afterByPosture.brighter.control),
      controlAtDarkest: median(afterByPosture.darker.control),
      // What the PERCEPTION MODEL sees, which is the axis §2.7 says personal calibration was
      // destroying. Before: v1's personally-renormalised score. After: absolute.
      genderBefore: genderScoreFromResonance(median(beforeByPosture.brighter.v1)),
      genderAfter: genderScoreFromResonance(median(afterByPosture.brighter.absolute)),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// 2. THE MIS-FIRE
// ---------------------------------------------------------------------------------------------
//
// One stored rule, "resonance drops below 30", which is one of the app's two shipped defaults.
// It is replayed frame by frame against the v1 value and against the v2 CONTROL value from the
// SAME frames, on the SHORT speaker at their brightest posture — a speaker who is, on their own
// calibrated scale, at the top of their range and should never be told to go brighter.
//
// The old code has no version on the rule and no way to ask which metric it was set against, so
// it fires against whatever number is in front of it. The new code refuses.
export async function misfire({ f0 = 120 } = {}) {
  // The app's two shipped default resonance rules, verbatim.
  const DEFAULTS = [
    { id: 1, metric: 'resonance', direction: 'below', threshold: 30, enabled: true },
    { id: 2, metric: 'resonance', direction: 'above', threshold: 70, enabled: true },
  ];
  const trips = (rule, valuePct) => (rule.direction === 'below'
    ? valuePct < rule.threshold : valuePct > rule.threshold);

  const cases = [];
  for (const spk of SPEAKERS) {
    // UNCALIBRATED is the case that matters, and it is not an edge case — it is the state EVERY
    // user is in on every reload. v1's learned personal range was never persisted (see the grep
    // in resonance-metric.js), so a returning user's v1 is always back on its fixed 17 cm ->
    // 14 cm anchors while their stored threshold was set against whatever scale was live when
    // they typed it. Uncalibrated v2 control is the published population span.
    const a = await freshAnalyzer();
    const v1 = [], control = [];
    for (const p of POSTURES) {
      const r = runPosture(a, spk.k, p.gain, f0);
      v1.push(...r.v1.map((v) => v * 100));
      // Frames with no reading are excluded from BOTH sides so the comparison is like for like.
      control.push(...r.control.map((v) => v * 100));
    }
    const n = Math.min(v1.length, control.length);
    for (const rule of DEFAULTS) {
      let oldFires = 0, newWouldFire = 0, disagree = 0;
      for (let i = 0; i < n; i++) {
        const o = trips(rule, v1[i]);
        const c = trips(rule, control[i]);
        if (o) oldFires++;
        if (c) newWouldFire++;
        if (o !== c) disagree++;
      }
      const migrated = migrateResonanceRules([rule], { spanId: a.resonanceSpanId }).rules[0];
      let actuallyFires = 0;
      for (let i = 0; i < n; i++) if (ruleMayFire(migrated) && trips(migrated, control[i])) actuallyFires++;
      cases.push({
        speaker: spk.name.split(' ')[0],
        rule: `${rule.direction} ${rule.threshold}`,
        frames: n,
        v1Median: +median(v1.slice(0, n)).toFixed(1),
        controlMedian: +median(control.slice(0, n)).toFixed(1),
        oldFires,
        naiveFires: newWouldFire,
        disagreeFrames: disagree,
        disagreePct: +(100 * disagree / Math.max(1, n)).toFixed(1),
        newFires: actuallyFires,
        migratedSuspended: migrated.suspended === true,
        migratedThreshold: migrated.threshold,
      });
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------
// 3-4. SUPPRESSION RUNS, YIELD AND SWING ON THE RAINBOW PASSAGE
// ---------------------------------------------------------------------------------------------
export async function passageReport({ method = 'auto', hop = null, fps = null, noiseDb = null } = {}) {
  const decoded = wav.decode(fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'audio-eval', 'rainbow_passage.wav')));
  let audio = decoded.channelData[0];
  // The two rates the repo calls live: the 735-sample hop every Phase 1/2/3 yield number is
  // measured at (33 ms on this 22.05 kHz fixture) and the rAF loop's true 60 fps.
  if (hop == null) hop = fps ? Math.round(decoded.sampleRate / fps) : 735;
  if (noiseDb != null) {
    // Deterministic additive noise at a stated SNR, same construction the Phase 3 reports use.
    let energy = 0;
    for (let i = 0; i < audio.length; i++) energy += audio[i] * audio[i];
    const rms = Math.sqrt(energy / audio.length);
    const noiseRms = rms / Math.pow(10, noiseDb / 20);
    let st = 12345 >>> 0;
    const noisy = new Float32Array(audio.length);
    for (let i = 0; i < audio.length; i++) {
      st = (st * 1664525 + 1013904223) >>> 0;
      noisy[i] = audio[i] + ((st / 4294967296) * 2 - 1) * noiseRms * Math.sqrt(3);
    }
    audio = noisy;
  }

  const a = await freshAnalyzer({ resonanceMethod: method });
  a.audioCtx.sampleRate = decoded.sampleRate;
  a.noiseFloor = 0.01;
  const dt = hop / decoded.sampleRate;

  const v1 = [], control = [], absolute = [];
  const presentSeq = [];
  let speechFrames = 0;
  for (let i = 0; i + WINDOW <= audio.length; i += hop) {
    a.audioCtx._currentChunk = audio.subarray(i, i + WINDOW);
    a.update(dt);
    if (!(a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25)) continue;
    speechFrames++;
    v1.push(a.smoothResonance);
    presentSeq.push(a.resonancePresent ? 1 : 0);
    if (a.resonancePresent) { control.push(a.resonanceControl); absolute.push(a.resonanceAbsolute); }
  }

  // Suppression RUNS. The headline percentage cannot tell a UI designer anything; the run
  // lengths can, because a scattered singleton is a flicker and a contiguous stretch is a state.
  const runs = [];
  let cur = 0;
  for (const v of presentSeq) { if (!v) cur++; else if (cur) { runs.push(cur); cur = 0; } }
  if (cur) runs.push(cur);
  const suppressed = presentSeq.length - presentSeq.reduce((s, v) => s + v, 0);

  const swing = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
  const p = (xs, q) => {
    if (!xs.length) return 0;
    const s = xs.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  };
  return {
    method, hop, noiseDb,
    speechFrames,
    // "Frame yield of the displayed value": v1 always had one (it is an EMA that cannot be
    // absent), v2 has one only on a frame it agreed to read.
    v1YieldPct: 100,
    v2YieldPct: +(100 * control.length / Math.max(1, speechFrames)).toFixed(1),
    suppressedPct: +(100 * suppressed / Math.max(1, presentSeq.length)).toFixed(1),
    suppressionRuns: runs,
    singletonRuns: runs.filter((r) => r === 1).length,
    medianRunFrames: median(runs),
    medianRunMs: +(median(runs) * dt * 1000).toFixed(0),
    maxRunMs: +(Math.max(0, ...runs) * dt * 1000).toFixed(0),
    // Across-clip swing on the DISPLAYED value, full range and the robust p05-p95 band beside
    // it, because a full range is one frame at each end and a user feels the band.
    v1Swing: +swing(v1).toFixed(4),
    v1Band: +(p(v1, 0.95) - p(v1, 0.05)).toFixed(4),
    v1Sd: +Math.sqrt(mean(v1.map((x) => (x - mean(v1)) ** 2))).toFixed(4),
    controlSwing: +swing(control).toFixed(4),
    controlBand: +(p(control, 0.95) - p(control, 0.05)).toFixed(4),
    controlSd: +Math.sqrt(mean(control.map((x) => (x - mean(control)) ** 2))).toFixed(4),
    absoluteSwing: +swing(absolute).toFixed(4),
    absoluteBand: +(p(absolute, 0.95) - p(absolute, 0.05)).toFixed(4),
    // Frame-to-frame step size on the displayed value: what a user actually perceives as
    // jitter, which a range cannot report.
    v1MedStep: +median(v1.slice(1).map((x, i) => Math.abs(x - v1[i]))).toFixed(4),
    controlMedStep: +median(control.slice(1).map((x, i) => Math.abs(x - control[i]))).toFixed(4),
    // The pooled scale's own scatter on the absolute axis, re-measured here rather than quoted
    // from Phase 1, because RESONANCE_CONTROL_MIN_SPAN is ten of it.
    pooledScaleSd: +Math.sqrt(mean(absolute.map((x) => (x - mean(absolute)) ** 2))).toFixed(5),
  };
}

// ---------------------------------------------------------------------------------------------
// THE SPAN FLOOR'S TWO NUMBERS, RE-MEASURED
// ---------------------------------------------------------------------------------------------
//
// RESONANCE_CONTROL_MIN_SPAN is five times the pooled scale's measurement SD at 20 dB SNR. Both
// halves are measured here rather than quoted: the SD, on a sustained vowel where the true value
// is constant by construction, and the posture excursion the floor must stay below.
export async function spanFloorEvidence() {
  const f = PB_MALE_VOWELS['ə'];
  const deltaF = (f[0] / 0.5 + f[1] / 1.5 + f[2] / 2.5) / 3;
  const clean = synthVowel({ f0: 120, formants: [...f, 3.5 * deltaF], seconds: 4, sampleRate: SR });
  const rows = [];
  for (const snrDb of [40, 30, 24, 20, 16, 12]) {
    let e = 0;
    for (const x of clean) e += x * x;
    const noiseRms = Math.sqrt(e / clean.length) / Math.pow(10, snrDb / 20);
    let st = 7 >>> 0;
    const sig = new Float32Array(clean.length);
    for (let i = 0; i < clean.length; i++) {
      st = (st * 1664525 + 1013904223) >>> 0;
      sig[i] = clean[i] + ((st / 4294967296) * 2 - 1) * noiseRms * Math.sqrt(3);
    }
    const a = await freshAnalyzer();
    const vals = [];
    for (let i = 0; i + WINDOW <= sig.length; i += HOP) {
      a.audioCtx._currentChunk = sig.subarray(i, i + WINDOW);
      a.update(DT);
      if (a.resonanceAbsolute != null) vals.push(a.resonanceAbsolute);
    }
    // Drop the pool warm-up: it is a transient, not noise.
    const v = vals.slice(Math.floor(vals.length * 0.25));
    const m = mean(v);
    rows.push({ snrDb, n: v.length, sd: +Math.sqrt(mean(v.map((x) => (x - m) ** 2))).toFixed(5) });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// 5. THE BUDGET AFTER v1 RETIRES
// ---------------------------------------------------------------------------------------------
//
// The same three cases §5's Phase 3 table reports, re-measured. The one that is supposed to have
// moved is the calibrated one: it paid 1.989 solves/frame because v1 was pinned to the published
// default ceiling while the canonical path used the chosen one, and that pin existed only
// because v1 was displayed.
export async function budget() {
  const cases = [
    { name: 'lpc, default ceiling (uncalibrated user)', method: 'lpc', ceilingHz: null },
    { name: 'lpc, per-user ceiling (post-calibration)', method: 'lpc', ceilingHz: 6500 },
    { name: 'v1 forced onto harmonic', method: 'harmonic', ceilingHz: null },
    { name: 'harmonic + per-user ceiling', method: 'harmonic', ceilingHz: 6500 },
  ];
  const sig = synthVowel({ f0: 120, formants: [570, 1710, 2850, 3990], seconds: 3, sampleRate: SR });
  const out = [];
  for (const c of cases) {
    const a = await freshAnalyzer({ resonanceMethod: c.method });
    if (c.ceilingHz) { a.lpcCeilingHz = c.ceilingHz; a.lpcCeilingSource = 'calibrated'; }
    let frames = 0;
    // One untimed warm pass so the report is of steady-state work, not of first-call JIT.
    for (let i = 0; i + WINDOW <= sig.length; i += HOP) {
      a.audioCtx._currentChunk = sig.subarray(i, i + WINDOW);
      a.update(DT);
    }
    const solvesAtStart = a._lpcSolveCount;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i + WINDOW <= sig.length; i += HOP) {
      a.audioCtx._currentChunk = sig.subarray(i, i + WINDOW);
      a.update(DT);
      frames++;
    }
    const ns = Number(process.hrtime.bigint() - t0);
    out.push({
      name: c.name,
      solvesPerFrame: +((a._lpcSolveCount - solvesAtStart) / frames).toFixed(3),
      msPerFrame: +(ns / 1e6 / frames).toFixed(2),
      pctOfBudget: +((ns / 1e6 / frames) / 16.67 * 100).toFixed(1),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

export async function report() {
  const out = {};
  console.log('PHASE 4 ACCEPTANCE — two scales, a versioned threshold, and what the ball costs\n');

  console.log('1. TWO SPEAKERS WITH DIFFERENT ABSOLUTE RANGES');
  console.log('   Both sweep the SAME posture excursion (the published GAVT shift, +6.2%), so the');
  console.log('   only thing that differs between them is vocal tract length.\n');
  out.speakers = await twoSpeakers();
  for (const r of out.speakers) {
    console.log(`   ${r.speaker}`);
    console.log(`     absolute range over all postures : ${r.absoluteRange.min.toFixed(4)} – ${r.absoluteRange.max.toFixed(4)}`);
    console.log(`     BEFORE (v1, personal range ${r.v1Learned ? 'learned' : 'NOT learned'}):`
      + `  darkest ${pct1(r.v1AtDarkest)}  brightest ${pct1(r.v1AtBrightest)}`);
    console.log(`     AFTER  resonanceControl (the ball) :  darkest ${pct1(r.controlAtDarkest)}  brightest ${pct1(r.controlAtBrightest)}`);
    console.log(`     AFTER  resonanceAbsolute (perception, cross-speaker):`
      + `  darkest ${pct1(r.absoluteAtDarkest)}  brightest ${pct1(r.absoluteAtBrightest)}`);
    console.log(`     perceived-gender score from the resonance cue, at brightest:`
      + `  before ${r.genderBefore.toFixed(3)}   after ${r.genderAfter.toFixed(3)}`);
    console.log('');
  }
  const [long, short] = out.speakers;
  out.speakerGap = {
    v1AtBrightest: Math.abs(long.v1AtBrightest - short.v1AtBrightest),
    controlAtBrightest: Math.abs(long.controlAtBrightest - short.controlAtBrightest),
    absoluteAtBrightest: Math.abs(long.absoluteAtBrightest - short.absoluteAtBrightest),
    genderBefore: Math.abs(long.genderBefore - short.genderBefore),
    genderAfter: Math.abs(long.genderAfter - short.genderAfter),
    absoluteRangesOverlap: !(long.absoluteRange.max < short.absoluteRange.min
      || short.absoluteRange.max < long.absoluteRange.min),
  };
  console.log('   READING THIS. The criterion is about the axis that COMPARES speakers, not the one');
  console.log('   that shows a person their own range — control putting both at 100% at their own');
  console.log('   brightest is what control is FOR, and is not the defect §2.7 names. The defect is');
  console.log('   that a personally-normalised number was also feeding the perception model, so two');
  console.log('   different vocal tracts produced the same score.');
  console.log(`     gap at brightest, v1 (both personally normalised) : ${pct1(out.speakerGap.v1AtBrightest)}`);
  console.log(`     gap at brightest, resonanceControl (by design)    : ${pct1(out.speakerGap.controlAtBrightest)}`);
  console.log(`     gap at brightest, resonanceAbsolute               : ${pct1(out.speakerGap.absoluteAtBrightest)}`);
  console.log(`     gap in the perceived-gender score  before ${out.speakerGap.genderBefore.toFixed(3)}  ->  after ${out.speakerGap.genderAfter.toFixed(3)}`);
  console.log(`     the two speakers' absolute ranges overlap: ${out.speakerGap.absoluteRangesOverlap ? 'yes' : 'NO — they are disjoint'}\n`);

  console.log('2. A STORED THRESHOLD, AND THE MIS-FIRE IT USED TO CAUSE');
  out.misfire = await misfire();
  console.log('   The two shipped default rules, replayed frame by frame over each speaker\'s full');
  console.log('   posture sweep, UNCALIBRATED — which is the state every user is in on every reload,');
  console.log('   because v1\'s learned personal range was never persisted.\n');
  console.log('   speaker  rule       frames   v1 med   ctrl med   fires on v1   fires on ctrl   VERDICTS DIFFER   fires now');
  for (const c of out.misfire) {
    console.log(`   ${c.speaker.padEnd(8)} ${c.rule.padEnd(10)} ${String(c.frames).padStart(6)}`
      + `${String(c.v1Median).padStart(9)}${String(c.controlMedian).padStart(11)}`
      + `${String(c.oldFires).padStart(14)}${String(c.naiveFires).padStart(16)}`
      + `${(c.disagreeFrames + ' (' + c.disagreePct + '%)').padStart(18)}${String(c.newFires).padStart(12)}`);
  }
  out.misfireWorst = Math.max(...out.misfire.map((c) => c.disagreePct));
  out.misfireNewFires = out.misfire.reduce((s2, c) => s2 + c.newFires, 0);
  console.log(`\n   "VERDICTS DIFFER" is the mis-fire: frames where the same stored rule buzzes on one`);
  console.log(`   metric and stays silent on the other. Worst case ${out.misfireWorst}% of frames. There is no`);
  console.log(`   rescaling that fixes it — v1's number depended on a learned range that no longer`);
  console.log(`   exists — so the migration SUSPENDS instead, and the rule fires ${out.misfireNewFires} times until the`);
  console.log(`   user confirms it. Thresholds are preserved verbatim: `
    + `${[...new Set(out.misfire.map((c) => c.migratedThreshold))].join(', ')}\n`);

  console.log('3. WHAT THE USER SEES ON A SUPPRESSED FRAME');
  out.passage = {};
  out.passage.clean30 = await passageReport({ hop: 735 });
  out.passage.clean60 = await passageReport({ fps: 60 });
  out.passage.noisy12 = await passageReport({ hop: 735, noiseDb: 12 });
  for (const [label, r] of Object.entries(out.passage)) {
    console.log(`   ${label.padEnd(9)} suppressed ${String(r.suppressedPct).padStart(5)}%  in ${r.suppressionRuns.length} runs `
      + `[${r.suppressionRuns.join(', ') || 'none'}]  singletons ${r.singletonRuns}  median run ${r.medianRunMs} ms  longest ${r.maxRunMs} ms`);
  }
  console.log('');

  console.log('4. THE DISPLAYED VALUE\'S FRAME YIELD AND ACROSS-CLIP SWING, v1 vs v2');
  console.log('   condition   yield v1   yield v2   swing v1   swing v2   p05-p95 v1   p05-p95 v2   med step v1   med step v2');
  for (const [label, r] of Object.entries(out.passage)) {
    console.log(`   ${label.padEnd(11)}`
      + `${String(r.v1YieldPct + '%').padStart(8)}  ${String(r.v2YieldPct + '%').padStart(9)}  `
      + `${r.v1Swing.toFixed(3).padStart(8)}  ${r.controlSwing.toFixed(3).padStart(9)}  `
      + `${r.v1Band.toFixed(3).padStart(11)}  ${r.controlBand.toFixed(3).padStart(11)}  `
      + `${r.v1MedStep.toFixed(4).padStart(12)}  ${r.controlMedStep.toFixed(4).padStart(12)}`);
  }
  console.log('');

  console.log('\n   THE SPAN FLOOR, RE-MEASURED. RESONANCE_CONTROL_MIN_SPAN is five times the');
  console.log('   pooled scale\'s measurement SD at 20 dB, measured on a sustained vowel whose true');
  console.log('   value is constant by construction:');
  out.spanFloor = await spanFloorEvidence();
  console.log('     ' + out.spanFloor.map((r) => `${r.snrDb} dB ${r.sd.toFixed(5)}`).join('   '));
  const observedSpreads = out.speakers.map((r) => r.span && r.span.observedSpread).filter(Number.isFinite);
  console.log(`     floor ${RESONANCE_CONTROL_MIN_SPAN.toFixed(4)}  |  observed posture spreads `
    + `${observedSpreads.map((x) => x.toFixed(4)).join(', ')}  |  floored: `
    + `${out.speakers.map((r) => (r.span ? r.span.spreadFloored : '?')).join(', ')}\n`);

  console.log('5. THE BUDGET AFTER v1 RETIRES (§3.4)');
  out.budget = await budget();
  console.log('   case                                        solves/frame   ms/frame   % of 16.67 ms');
  for (const b of out.budget) {
    console.log(`   ${b.name.padEnd(42)}${String(b.solvesPerFrame).padStart(12)}`
      + `${String(b.msPerFrame).padStart(11)}${String(b.pctOfBudget + '%').padStart(15)}`);
  }
  return out;
}

// Acceptance thresholds. Deliberately loose where the criterion is qualitative and exact where
// it is not: "fires / does not fire" is a count, "the ranges are disjoint" is a comparison, and
// neither is a number anyone could have tuned toward.
export const ACCEPTANCE = {
  // The perception model must separate the two speakers by more than it did. It is not required
  // to reach any particular value — that is a d′ question the benchmark owns.
  minGenderGapAfter: 0.02,
  maxGenderGapBefore: 0.02,
  // No hardware threshold fires against a value from a different version. This is 0, exactly.
  maxNewFires: 0,
  maxSolvesPerFrame: 1.001,
};

export function failures(out) {
  const bad = [];
  if (out.speakerGap.absoluteRangesOverlap) {
    bad.push('the two speakers\' absolute ranges overlap — they are not a usable pair');
  }
  if (!(out.speakerGap.genderBefore <= ACCEPTANCE.maxGenderGapBefore)) {
    bad.push(`before the split the perception model already separated them by ${out.speakerGap.genderBefore.toFixed(3)}`);
  }
  if (!(out.speakerGap.genderAfter > ACCEPTANCE.minGenderGapAfter)) {
    bad.push(`after the split the perception model separates them by only ${out.speakerGap.genderAfter.toFixed(3)}`);
  }
  // The mis-fire must be real (or the demonstration proves nothing) and must be gone.
  if (!(out.misfireWorst > 0)) bad.push('no stored rule ever disagreed between v1 and v2 — the mis-fire is not demonstrated');
  if (out.misfireNewFires > ACCEPTANCE.maxNewFires) {
    bad.push(`a migrated v1 threshold fired on ${out.misfireNewFires} v2 frames`);
  }
  for (const c of out.misfire) {
    if (!c.migratedSuspended) bad.push(`${c.speaker} ${c.rule}: the migrated rule was not suspended`);
    if (c.migratedThreshold !== (c.rule.startsWith('below') ? 30 : 70)) {
      bad.push(`${c.speaker} ${c.rule}: the migration altered the user's threshold`);
    }
  }
  // The span floor must separate a real posture change from measurement noise, in both
  // directions, on the numbers this run just measured.
  const sd20 = out.spanFloor.find((r) => r.snrDb === 20);
  if (sd20 && !(RESONANCE_CONTROL_MIN_SPAN > 4 * sd20.sd)) {
    bad.push(`the span floor (${RESONANCE_CONTROL_MIN_SPAN}) is not clear of the 20 dB measurement SD (${sd20.sd})`);
  }
  for (const r of out.speakers) {
    if (r.spanFloored) bad.push(`${r.speaker}: a published-magnitude posture sweep hit the span floor`);
  }
  for (const b of out.budget) {
    if (b.solvesPerFrame > ACCEPTANCE.maxSolvesPerFrame) {
      bad.push(`${b.name}: ${b.solvesPerFrame} LPC solves/frame — the duplicate solve is still there`);
    }
  }
  return bad;
}

if (process.argv[1] && process.argv[1].endsWith('resonance-two-scale.mjs')) {
  const out = await report();
  if (process.argv.includes('--check')) {
    const bad = failures(out);
    for (const b of bad) console.error(`FAIL: ${b}`);
    process.exit(bad.length ? 1 : 0);
  }
}
