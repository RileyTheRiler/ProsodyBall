#!/usr/bin/env node
// Resonance v1 vs v2 divergence + formant yield, over the Rainbow Passage fixture at the
// app's live frame rate. docs/RESONANCE_REDESIGN.md §5: "Instrument both; log divergence."
//
// This is the measurement that has to happen BEFORE anything switches over. v1 is the
// displayed metric through Phase 1; v2 is computed beside it. What this reports:
//
//   - where the two disagree and by how much, frame by frame and in aggregate
//   - the frame yield of each formant, which is §6's risk made into a number: F3 and F4
//     are lower-amplitude than F1/F2, so a more valid construct is a less available one.
//     v2's scale-fit yield is printed next to v1's dispersion-fit yield for exactly that.
//
// Usage:  node tools/resonance-v1-v2-divergence.mjs [--method=lpc|harmonic|cepstral|centroid|auto]
//                                                   [--frames]   (per-frame CSV to stdout)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wav from 'node-wav';
// Importing the harness installs its real-FFT mock Web Audio context and the document/window
// globals app.js expects. Same rig the golden eval runs on, so these numbers and the golden
// ranges describe the same pipeline.
import { MockAudioContext } from './run-eval-harness.mjs';

const LIVE_HOP_SAMPLES = 735; // 60 fps at 44.1 kHz — the rate users actually run at
const CHUNK = 4096;

const args = process.argv.slice(2);
const methodArg = (args.find((a) => a.startsWith('--method=')) || '--method=lpc').split('=')[1];
const perFrame = args.includes('--frames');

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

export async function measure(method = 'lpc') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const wavPath = path.join(__dirname, '..', 'fixtures', 'audio-eval', 'rainbow_passage.wav');
  const decoded = wav.decode(fs.readFileSync(wavPath));
  const audio = decoded.channelData[0];

  const { VoiceAnalyzer } = await import('../app.js');
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = decoded.sampleRate;
  a.isCalibrated = true;
  a.noiseFloor = 0.01;
  a.hfNoiseFloor = 0.001;
  a.micTiltBaselineDb = 0;
  a.resonanceMethod = method;

  const dt = LIVE_HOP_SAMPLES / decoded.sampleRate;
  const rows = [];
  let frames = 0, estimatorFrames = 0;
  const yieldCount = { f1: 0, f2: 0, f3: 0, f4: 0 };
  let v1FitFrames = 0, v2FitFrames = 0, v2ScaleFrames = 0;
  // Phase 2: how often the vowel is named and f2Position therefore exists. §6 requires the
  // abstentions to be counted and reported, not quietly treated as missing data.
  let vowelFrames = 0, f2PosFrames = 0;
  const abstainReasons = {};
  const vowelCounts = {};

  for (let i = 0; i + CHUNK <= audio.length; i += LIVE_HOP_SAMPLES) {
    a.audioCtx._currentChunk = audio.subarray(i, i + CHUNK);
    a.update(dt);
    frames++;
    // "Estimator frame" = a frame the resonance stage actually ran on (voiced, vowel-like).
    // Yield is reported against these, not against every frame of the file, because silence
    // is not a missed formant.
    const ran = a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25;
    if (!ran) continue;
    estimatorFrames++;
    if (a._f1Age === 0) yieldCount.f1++;
    if (a._f2Age === 0) yieldCount.f2++;
    if (a._f3Age === 0) yieldCount.f3++;
    if (a._f4Age === 0) yieldCount.f4++;
    if (a.dispersionFormantsUsed >= 2) v1FitFrames++;
    if (a.formantScaleFormantsUsed >= 2) v2FitFrames++;
    if (a.formantScaleHz > 0) v2ScaleFrames++;
    if (a.vowelId) { vowelFrames++; vowelCounts[a.vowelId] = (vowelCounts[a.vowelId] || 0) + 1; }
    else abstainReasons[a.vowelAbstainReason] = (abstainReasons[a.vowelAbstainReason] || 0) + 1;
    if (a.f2PositionRatio > 0) f2PosFrames++;
    rows.push({
      t: +(i / decoded.sampleRate).toFixed(3),
      v1: a.smoothResonance,
      v2: a.resonanceAbsolute != null ? a.resonanceAbsolute : 0,
      f1: a.smoothF1, f2: a.smoothF2, f3: a.smoothF3, f4: a.smoothF4,
      dfV1: a.formantDispersionHz,
      dfV2: a.formantScaleHz,
      dfV2Frame: a.formantScaleFrameHz,
      nV1: a.dispersionFormantsUsed,
      nV2: a.formantScaleFormantsUsed,
      r: a.formantPattern.slice(),
    });
  }

  // Divergence is only meaningful once v2 has a pooled scale at all; before that v2 is
  // reporting "no reading yet" (0), which is not a disagreement with v1.
  const both = rows.filter((r) => r.dfV2 > 0);
  const diff = both.map((r) => r.v2 - r.v1);
  const absDiff = diff.map(Math.abs);

  return {
    method,
    frames,
    estimatorFrames,
    yieldPct: {
      f1: +(100 * yieldCount.f1 / Math.max(1, estimatorFrames)).toFixed(1),
      f2: +(100 * yieldCount.f2 / Math.max(1, estimatorFrames)).toFixed(1),
      f3: +(100 * yieldCount.f3 / Math.max(1, estimatorFrames)).toFixed(1),
      f4: +(100 * yieldCount.f4 / Math.max(1, estimatorFrames)).toFixed(1),
    },
    fitYieldPct: {
      v1DispersionFit: +(100 * v1FitFrames / Math.max(1, estimatorFrames)).toFixed(1),
      v2ScaleFit: +(100 * v2FitFrames / Math.max(1, estimatorFrames)).toFixed(1),
      v2PooledScale: +(100 * v2ScaleFrames / Math.max(1, estimatorFrames)).toFixed(1),
      // Phase 2. f2Position exists exactly where the classifier named a vowel, by design:
      // §6 forbids a reading on a frame whose vowel is unknown.
      vowelClassified: +(100 * vowelFrames / Math.max(1, estimatorFrames)).toFixed(1),
      f2Position: +(100 * f2PosFrames / Math.max(1, estimatorFrames)).toFixed(1),
    },
    vowelAbstention: {
      ratePct: +(100 * (estimatorFrames - vowelFrames) / Math.max(1, estimatorFrames)).toFixed(1),
      reasons: abstainReasons,
      vowelCounts,
    },
    v1: { mean: +mean(both.map((r) => r.v1)).toFixed(4), sd: +sd(both.map((r) => r.v1)).toFixed(4),
          min: +Math.min(...both.map((r) => r.v1)).toFixed(4), max: +Math.max(...both.map((r) => r.v1)).toFixed(4) },
    v2: { mean: +mean(both.map((r) => r.v2)).toFixed(4), sd: +sd(both.map((r) => r.v2)).toFixed(4),
          min: +Math.min(...both.map((r) => r.v2)).toFixed(4), max: +Math.max(...both.map((r) => r.v2)).toFixed(4) },
    deltaFHz: {
      v1Mean: +mean(both.map((r) => r.dfV1)).toFixed(1),
      v2PooledMean: +mean(both.map((r) => r.dfV2)).toFixed(1),
      // Unpooled, so the effect of §5's rolling window is visible rather than assumed: the
      // per-frame scale scatters across vowels, the pooled one should not.
      v2FrameMean: +mean(both.map((r) => r.dfV2Frame)).toFixed(1),
      v2FrameSd: +sd(both.map((r) => r.dfV2Frame)).toFixed(1),
      v2PooledSd: +sd(both.map((r) => r.dfV2)).toFixed(1),
    },
    divergence: {
      comparedFrames: both.length,
      meanSignedPts: +(100 * mean(diff)).toFixed(2),
      meanAbsPts: +(100 * mean(absDiff)).toFixed(2),
      p50AbsPts: +(100 * pct(absDiff, 50)).toFixed(2),
      p95AbsPts: +(100 * pct(absDiff, 95)).toFixed(2),
      maxAbsPts: +(100 * Math.max(...absDiff, 0)).toFixed(2),
      // Range each metric travels over the clip. One speaker, one passage: a metric that
      // travels far here is being moved by something other than the speaker's tract size.
      v1SwingPts: +(100 * (Math.max(...both.map((r) => r.v1)) - Math.min(...both.map((r) => r.v1)))).toFixed(1),
      v2SwingPts: +(100 * (Math.max(...both.map((r) => r.v2)) - Math.min(...both.map((r) => r.v2)))).toFixed(1),
    },
    worst: both.slice().sort((x, y) => Math.abs(y.v2 - y.v1) - Math.abs(x.v2 - x.v1)).slice(0, 8)
      .map((r) => ({ t: r.t, v1: +r.v1.toFixed(3), v2: +r.v2.toFixed(3), dPts: +(100 * (r.v2 - r.v1)).toFixed(1),
                     f1: Math.round(r.f1), f2: Math.round(r.f2), f3: Math.round(r.f3), f4: Math.round(r.f4),
                     dFv1: Math.round(r.dfV1), dFv2: Math.round(r.dfV2) })),
    rows,
  };
}

// §5's frame-yield floor, and §6's risk stated as a pass/fail: "construct validity and
// measurement reliability pull opposite ways" — F3/F4 are lower-amplitude than F1/F2, so a
// more valid scale could easily be a scale that is available on fewer frames. v2 must not
// buy its d′ with yield. Checked under every estimator, because three of the four produce no
// F4 at all and v2 has to hold up on the F1-F3 fallback too.
const YIELD_FLOOR = {
  // v2's scale fit must be available on at least as many frames as v1's dispersion fit. Not
  // "close to": the fits admit the same formants, so any shortfall is a real regression.
  scaleFitVsV1Pts: 0,
  // Measured 92.4% under 'lpc' on this fixture. The floor is set well below that so a real
  // extraction regression trips it while ordinary numerical drift does not; F4 is optional
  // by design, so this gates the claim that it is *available*, not that it is required.
  f4UnderLpcPct: 80,
};

async function check() {
  let failed = false;
  for (const m of ['lpc', 'cepstral', 'harmonic', 'centroid']) {
    const r = await measure(m);
    const line = `${m}: F1 ${r.yieldPct.f1}%  F2 ${r.yieldPct.f2}%  F3 ${r.yieldPct.f3}%  F4 ${r.yieldPct.f4}%  |  `
      + `v1 ΔF fit ${r.fitYieldPct.v1DispersionFit}%  v2 scale fit ${r.fitYieldPct.v2ScaleFit}%  `
      + `v2 pooled ${r.fitYieldPct.v2PooledScale}%  vowel ${r.fitYieldPct.vowelClassified}%  `
      + `f2Position ${r.fitYieldPct.f2Position}%  |  divergence mean ${r.divergence.meanAbsPts} pts, `
      + `p95 ${r.divergence.p95AbsPts}, max ${r.divergence.maxAbsPts}  |  `
      + `swing v1 ${r.divergence.v1SwingPts} pts, v2 ${r.divergence.v2SwingPts} pts`;
    const gap = r.fitYieldPct.v2ScaleFit - r.fitYieldPct.v1DispersionFit;
    if (gap < YIELD_FLOOR.scaleFitVsV1Pts) {
      console.error(`FAIL ${m}: v2 scale-fit yield ${r.fitYieldPct.v2ScaleFit}% is below v1's ${r.fitYieldPct.v1DispersionFit}%`);
      failed = true;
    }
    if (m === 'lpc' && r.yieldPct.f4 < YIELD_FLOOR.f4UnderLpcPct) {
      console.error(`FAIL: F4 yield under lpc is ${r.yieldPct.f4}%, floor ${YIELD_FLOOR.f4UnderLpcPct}%`);
      failed = true;
    }
    console.log(line);
  }
  if (failed) process.exit(1);
  console.log('SUCCESS: v2 formant yield does not regress against v1 on the Rainbow Passage fixture.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (args.includes('--check')) { await check(); process.exit(0); }
  const methods = methodArg === 'all' ? ['lpc', 'cepstral', 'harmonic', 'centroid'] : [methodArg];
  for (const m of methods) {
    const out = await measure(m);
    const { rows, ...summary } = out;
    console.log(`\n=== resonance v1 vs v2 — Rainbow Passage, live rate, estimator '${m}' ===`);
    console.log(JSON.stringify(summary, null, 2));
    if (perFrame) {
      console.log('\nt,v1,v2,f1,f2,f3,f4,dFv1,dFv2pooled,dFv2frame,nV1,nV2,r1,r2,r3,r4');
      for (const r of rows) {
        console.log([r.t, r.v1.toFixed(4), r.v2.toFixed(4), Math.round(r.f1), Math.round(r.f2),
          Math.round(r.f3), Math.round(r.f4), Math.round(r.dfV1), Math.round(r.dfV2), Math.round(r.dfV2Frame), r.nV1, r.nV2,
          ...[0, 1, 2, 3].map((i) => (r.r[i] == null ? '' : r.r[i].toFixed(3)))].join(','));
      }
    }
  }
}
