#!/usr/bin/env node
// The two aggregation modes (docs/RESONANCE_REDESIGN.md §5, §2.9), measured on the clip that
// separates them: ONE LONG HELD VOWEL FOLLOWED BY RUNNING SPEECH.
//
//   EXERCISE mode — steady-state weighted, the app's current behaviour. Every frame counts,
//   scaled by how held it is. A four-second hold is four seconds of frames at near-maximum
//   steadiness, so it dominates. That is correct for an exercise: holding the target IS the
//   task, and the ball keeps this mode.
//
//   SPEECH mode — one value per vowel nucleus, nuclei weighted equally. The same four-second
//   hold is ONE nucleus, exactly like the 80 ms /ɪ/ in "the rain". §2.9's ecological
//   aggregation, and what session statistics read.
//
// If the two modes did not differ on this clip, one of them would be redundant. This reports
// both numbers so the difference is a measurement rather than a design intention.
//
// THE FIXTURE is built here rather than committed as audio, so it is reproducible from source
// and reviewable as code: a synthesized held vowel (tools/synth-vowel.mjs, the same generator
// resonance-reliability.test.mjs uses for its ground-truth vowels) concatenated with the real
// Rainbow Passage recording already in fixtures/audio-eval/. The hold is a textbook /i/ placed
// at the passage speaker's own measured scale, with F2 raised by the published GAVT training
// increment (+6.2%, §1.5) — i.e. a speaker holding the trained target, which is what an
// exercise-mode reading is supposed to reward and a speech-mode reading is not.
//
// Usage:  node tools/resonance-aggregation.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wav from 'node-wav';
import { MockAudioContext } from './run-eval-harness.mjs';
import { synthVowel } from './synth-vowel.mjs';
import { aggregateExercise, aggregateSpeech, findVowelNuclei } from '../dsp-utils.js';
import { GAVT_F2_GAIN, pbSpeaker } from './resonance-benchmark.mjs';

const LIVE_HOP_SAMPLES = 735;   // 60 fps at 44.1 kHz — the rate users actually run at
const CHUNK = 4096;

// Measured on the Rainbow Passage by tools/resonance-v1-v2-divergence.mjs: the pooled v2
// formant scale this speaker reads at. Placing the hold here rather than at a population
// average is what makes the clip one speaker rather than two.
export const PASSAGE_SCALE_HZ = 1015;
export const HOLD_SECONDS = 4.0;
export const HOLD_VOWEL = 'i';

// Peterson & Barney's published adult-male /i/, uniformly rescaled from that population's
// pooled ΔF to the passage speaker's — a real vowel moved to a real tract, rather than a
// vowel assembled out of template arithmetic. Then F2 ALONE is raised by the GAVT increment,
// holding F1 and F3: an articulatory change at a fixed tract length, which is precisely what
// f2Position is defined to report and precisely what a user practising a held target is doing.
export function holdFormants(scaleHz = PASSAGE_SCALE_HZ, f2Gain = GAVT_F2_GAIN) {
  const pb = pbSpeaker('male', [HOLD_VOWEL]);
  const k = scaleHz / pbSpeaker('male').scaleHz;   // pooled-to-pooled, so the vowel is unchanged in shape
  return pb.formants[0].slice(0, 3).map((f, i) => f * k * (i === 1 ? f2Gain : 1));
}

export function buildClip(sampleRate, passage) {
  const hold = synthVowel({
    f0: 110,                    // near the passage speaker's measured ~96-104 Hz
    formants: holdFormants(),
    seconds: HOLD_SECONDS,
    sampleRate,
  });
  const clip = new Float32Array(hold.length + passage.length);
  clip.set(hold, 0);
  clip.set(passage, hold.length);
  return { clip, holdSamples: hold.length };
}

export async function measure({ method = 'lpc' } = {}) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const decoded = wav.decode(fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'audio-eval', 'rainbow_passage.wav')));
  const { clip, holdSamples } = buildClip(decoded.sampleRate, decoded.channelData[0]);

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
  const samples = { f2: [], v2: [] };
  let frames = 0, estimatorFrames = 0, f2Frames = 0, classifiedFrames = 0;
  const abstainReasons = {};
  const holdVowels = {}, holdAbstainReasons = {};
  let holdEstimatorFrames = 0, holdClassified = 0;
  let index = 0;

  for (let i = 0; i + CHUNK <= clip.length; i += LIVE_HOP_SAMPLES) {
    a.audioCtx._currentChunk = clip.subarray(i, i + CHUNK);
    a.update(dt);
    frames++;
    const inHold = i + CHUNK <= holdSamples;
    const ran = a.lastPitch > 0 && a.pitchConfidence > 0.4 && a.vowelLikelihood > 0.25;
    if (!ran) { index++; continue; }
    estimatorFrames++;
    if (inHold) holdEstimatorFrames++;
    if (a.vowelId) {
      classifiedFrames++;
      if (inHold) { holdClassified++; holdVowels[a.vowelId] = (holdVowels[a.vowelId] || 0) + 1; }
    } else {
      abstainReasons[a.vowelAbstainReason] = (abstainReasons[a.vowelAbstainReason] || 0) + 1;
      if (inHold) holdAbstainReasons[a.vowelAbstainReason] = (holdAbstainReasons[a.vowelAbstainReason] || 0) + 1;
    }
    if (a.f2PositionRatio > 0) f2Frames++;
    const weight = Math.max(0, a.formantConfidence * a.formantSteadiness);
    const base = { weight, vowel: a.vowelId, index, inHold };
    samples.f2.push({ ...base, value: a.f2PositionRatio });
    samples.v2.push({ ...base, value: a.resonanceAbsolute != null ? a.resonanceAbsolute : 0 });
    index++;
  }

  const summarise = (rows) => {
    const ex = aggregateExercise(rows);
    const sp = aggregateSpeech(rows);
    const nuclei = findVowelNuclei(rows);
    const holdRows = rows.filter((r) => r.inHold && r.value > 0 && r.weight > 0);
    const holdWeight = holdRows.reduce((s, r) => s + r.weight, 0);
    const totalWeight = rows.reduce((s, r) => s + (r.value > 0 ? r.weight : 0), 0);
    const holdNuclei = findVowelNuclei(rows.filter((r) => r.inHold));
    const passageRows = rows.filter((r) => !r.inHold);
    return {
      exercise: +ex.value.toFixed(4),
      speech: +sp.value.toFixed(4),
      // What each mode is actually averaging over, so the two headline numbers can be checked
      // against their parts rather than taken on trust.
      holdOnly: +aggregateExercise(holdRows).value.toFixed(4),
      passageOnly: +aggregateExercise(passageRows).value.toFixed(4),
      differencePct: +(100 * (ex.value - sp.value) / (sp.value || 1)).toFixed(2),
      nuclei: nuclei.length,
      // The mechanism, stated as two numbers: what share of each mode the hold commands.
      holdShareOfExerciseWeight: +(100 * holdWeight / Math.max(1e-9, totalWeight)).toFixed(1),
      holdShareOfSpeechNuclei: +(100 * holdNuclei.length / Math.max(1, nuclei.length)).toFixed(1),
      holdFrames: holdRows.length,
      longestNucleusFrames: nuclei.reduce((m, n) => Math.max(m, n.frames), 0),
    };
  };

  return {
    method,
    frames,
    estimatorFrames,
    holdSeconds: HOLD_SECONDS,
    holdFormantsHz: holdFormants().map((f) => Math.round(f)),
    classifiedPct: +(100 * classifiedFrames / Math.max(1, estimatorFrames)).toFixed(1),
    abstentionPct: +(100 * (estimatorFrames - classifiedFrames) / Math.max(1, estimatorFrames)).toFixed(1),
    abstainReasons,
    // The hold split, because "the classifier works on connected speech" and "the classifier
    // works on a sustained vowel" are different claims and the whole point of this clip is
    // that the second one used to be false.
    hold: {
      estimatorFrames: holdEstimatorFrames,
      classifiedPct: +(100 * holdClassified / Math.max(1, holdEstimatorFrames)).toFixed(1),
      vowels: holdVowels,
      abstainReasons: holdAbstainReasons,
    },
    passage: {
      estimatorFrames: estimatorFrames - holdEstimatorFrames,
      classifiedPct: +(100 * (classifiedFrames - holdClassified) / Math.max(1, estimatorFrames - holdEstimatorFrames)).toFixed(1),
    },
    f2PositionYieldPct: +(100 * f2Frames / Math.max(1, estimatorFrames)).toFixed(1),
    f2Position: summarise(samples.f2),
    resonanceAbsoluteV2: summarise(samples.v2),
  };
}

// The §5 acceptance criterion as a pass/fail. Two conditions, because the interesting one is
// not the size of the gap:
//
//   MECHANISM — the hold must command a far larger share of exercise-mode weight than of
//   speech-mode nuclei. This is what the two modes ARE, and it does not depend on how
//   different the held posture happens to be from the running speech.
//
//   EFFECT — the two modes must land on measurably different numbers for at least one of the
//   two features. How large that gap is depends on the fixture: the hold here is Peterson &
//   Barney's /i/ plus the published GAVT increment, both fixed by publication rather than
//   chosen, and it happens to sit near the passage's own mean f2Position — so f2Position shows
//   the smaller gap and resonanceAbsoluteV2 the larger. Requiring BOTH to be large would be
//   satisfied by shopping for a hold that flatters the result, which is not a measurement.
const MIN_MODE_DIFFERENCE_PCT = 2.0;
const MIN_WEIGHT_TO_NUCLEUS_RATIO = 5.0;

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await measure();
  const check = process.argv.includes('--check');
  if (!check) {
    console.log('\n=== Aggregation modes — one 4 s hold + the Rainbow Passage, live frame rate ===\n');
    console.log(JSON.stringify(r, null, 2));
    console.log('\nRead it this way: the hold commands '
      + `${r.f2Position.holdShareOfExerciseWeight}% of exercise-mode weight and `
      + `${r.f2Position.holdShareOfSpeechNuclei}% of speech-mode nuclei (1 of ${r.f2Position.nuclei}).`);
    console.log('That asymmetry is the whole difference between the two modes, and it is why');
    console.log('session statistics must not use the mode the ball uses.');
  }
  let failed = false;
  const ratio = r.f2Position.holdShareOfExerciseWeight / Math.max(1e-9, r.f2Position.holdShareOfSpeechNuclei);
  if (ratio < MIN_WEIGHT_TO_NUCLEUS_RATIO) {
    console.error(`FAIL: the hold commands ${r.f2Position.holdShareOfExerciseWeight}% of exercise weight `
      + `but ${r.f2Position.holdShareOfSpeechNuclei}% of speech nuclei — ratio ${ratio.toFixed(1)}, `
      + `floor ${MIN_WEIGHT_TO_NUCLEUS_RATIO}. The two modes are not weighting the hold differently.`);
    failed = true;
  }
  const biggest = Math.max(Math.abs(r.f2Position.differencePct), Math.abs(r.resonanceAbsoluteV2.differencePct));
  if (biggest < MIN_MODE_DIFFERENCE_PCT) {
    console.error(`FAIL: neither feature's exercise and speech values differ by more than `
      + `${biggest.toFixed(2)}% (floor ${MIN_MODE_DIFFERENCE_PCT}%).`);
    failed = true;
  }
  if (r.hold.classifiedPct < 80) {
    // The regression this guards is the one that was actually there: a classifier calibrated to
    // connected speech abstains through a sustained vowel, which is the mode the ball runs in.
    console.error(`FAIL: the vowel was named on only ${r.hold.classifiedPct}% of the sustained hold's frames.`);
    failed = true;
  }
  if (failed) process.exit(1);
  if (check) {
    for (const [name, m] of [['f2Position ', r.f2Position], ['resonanceV2', r.resonanceAbsoluteV2]]) {
      console.log(`${name} exercise ${m.exercise}  speech ${m.speech}  (${m.differencePct}% apart)   `
        + `hold-only ${m.holdOnly}  passage-only ${m.passageOnly}`);
    }
    console.log(`hold commands ${r.f2Position.holdShareOfExerciseWeight}% of exercise weight vs `
      + `${r.f2Position.holdShareOfSpeechNuclei}% of speech nuclei (1 of ${r.f2Position.nuclei}) — ratio ${ratio.toFixed(1)}`);
    console.log(`vowel named on ${r.classifiedPct}% of estimator frames (hold ${r.hold.classifiedPct}%, `
      + `passage ${r.passage.classifiedPct}%), abstained ${r.abstentionPct}%`);
    console.log('SUCCESS: the two aggregation modes are measurably different on the hold+speech clip.');
  }
}
