import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHRASE_SEG_DEFAULTS,
  segmentSpeechRuns,
  estimateSyllables,
  alignRunsToWords,
  summarizeWordMetrics,
  summarizePhraseTake,
} from './dsp-utils.js';

// One snapshot per recorder tick (512-sample analyser window at 44.1 kHz).
const TICK = 512 / 44100;

const frame = (energy, hz = 0, extra = {}) => ({
  hz,
  conf: hz > 0 ? 0.9 : 0,
  voiced: hz > 0,
  res: 0.5,
  prosody: 0.5,
  energy,
  syl: 0,
  ...extra,
});
const speech = (n, hz = 150, energy = 0.08) => Array.from({ length: n }, () => frame(energy, hz));
const silence = (n, energy = 0.001) => Array.from({ length: n }, () => frame(energy));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// ---------- segmentSpeechRuns ----------

test('segmentSpeechRuns: empty and all-silent input produce no runs', () => {
  assert.deepEqual(segmentSpeechRuns([]), []);
  assert.deepEqual(segmentSpeechRuns(silence(50), { tickSec: TICK }), []);
});

test('segmentSpeechRuns: one clean run with exact frame-indexed timing', () => {
  const samples = [...silence(20), ...speech(30), ...silence(20)];
  const runs = segmentSpeechRuns(samples, { tickSec: TICK });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].startIdx, 20);
  assert.equal(runs[0].endIdx, 50);
  near(runs[0].startSec, 20 * TICK);
  near(runs[0].durSec, 30 * TICK);
  assert.equal(runs[0].voicedCount, 30);
  near(runs[0].peakEnergy, 0.08);
});

test('segmentSpeechRuns: a real pause (≥ minGapSec) separates two runs', () => {
  const samples = [...silence(20), ...speech(20), ...silence(15), ...speech(20), ...silence(20)];
  const runs = segmentSpeechRuns(samples, { tickSec: TICK });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].startIdx, 20);
  assert.equal(runs[1].startIdx, 55);
});

test('segmentSpeechRuns: sub-minGapSec gaps (intra-word stop closures) are merged', () => {
  // 6-frame gap ≈ 70 ms < minGapSec (120 ms) → one run spanning the closure.
  const samples = [...silence(20), ...speech(20), ...silence(6), ...speech(20), ...silence(20)];
  const runs = segmentSpeechRuns(samples, { tickSec: TICK });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].startIdx, 20);
  assert.equal(runs[0].endIdx, 66);
});

test('segmentSpeechRuns: short quiet unvoiced blips are pruned', () => {
  // Real speech sets the on-threshold ≈ 0.029; a 3-frame unvoiced blip at 0.03
  // clears it but is short, quiet (< on × 1.2), and unvoiced → dropped.
  const samples = [
    ...speech(30), ...silence(15),
    frame(0.03), frame(0.03), frame(0.03),
    ...silence(30),
  ];
  const runs = segmentSpeechRuns(samples, { tickSec: TICK });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].endIdx, 30);
});

test('segmentSpeechRuns: hysteresis keeps a run alive through mid-word energy dips', () => {
  // 12-frame dip at 0.02 sits between off (~0.010) and on (~0.029) — too long for the
  // merge pass to rescue, so only hysteresis explains a single run.
  const samples = [...speech(10), ...silence(12, 0.02), ...speech(10), ...silence(30)];
  const runs = segmentSpeechRuns(samples, { tickSec: TICK });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].startIdx, 0);
  assert.equal(runs[0].endIdx, 32);
});

test('segmentSpeechRuns: quiet but confidently voiced frames extend a run', () => {
  const samples = [...speech(15), ...speech(10, 150, 0.005), ...silence(30)];
  const runs = segmentSpeechRuns(samples, { tickSec: TICK });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].endIdx, 25);
});

test('segmentSpeechRuns: an explicit noiseFloor raises the thresholds', () => {
  const samples = [...silence(30, 0.02), ...silence(30)];
  assert.equal(segmentSpeechRuns(samples, { tickSec: TICK }).length, 1);
  assert.equal(segmentSpeechRuns(samples, { tickSec: TICK, noiseFloor: 0.05 }).length, 0);
});

// ---------- estimateSyllables ----------

test('estimateSyllables: pins the heuristic on the practice-phrase vocabulary', () => {
  // These are the heuristic's answers (vowel groups, silent-e adjustment), asserted
  // so any drift is visible. Known limitation: adjacent vowels count once ("going" → 1).
  assert.equal(estimateSyllables('a'), 1);
  assert.equal(estimateSyllables('year'), 1);
  assert.equal(estimateSyllables('ago'), 2);
  assert.equal(estimateSyllables('away'), 2);
  assert.equal(estimateSyllables('hello'), 2);
  assert.equal(estimateSyllables('believe'), 2);
  assert.equal(estimateSyllables('little'), 2);
  assert.equal(estimateSyllables('umbrella'), 3);
  assert.equal(estimateSyllables('Wednesday'), 3);
  assert.equal(estimateSyllables('going'), 1);
  assert.equal(estimateSyllables(''), 1);
});

// ---------- alignRunsToWords ----------

const span = (startIdx, endIdx) => ({ startIdx, endIdx });

test('alignRunsToWords: equal counts align 1:1 as exact', () => {
  const runs = [span(0, 10), span(20, 30), span(40, 50)];
  const { slots, status } = alignRunsToWords(runs, ['We', 'were', 'away'], { tickSec: TICK });
  assert.equal(status, 'exact');
  assert.equal(slots.length, 3);
  assert.ok(slots.every((s) => s.matched));
  assert.equal(slots[1].startIdx, 20);
  assert.equal(slots[1].endIdx, 30);
  near(slots[2].durSec, 10 * TICK);
});

test('alignRunsToWords: extra runs merge across the smallest gaps first', () => {
  const runs = [span(0, 10), span(12, 20), span(40, 50), span(52, 60), span(80, 90)];
  const { slots, status } = alignRunsToWords(runs, ['one', 'two', 'three'], { tickSec: TICK });
  assert.equal(status, 'merged');
  assert.deepEqual(slots.map((s) => [s.startIdx, s.endIdx]), [[0, 20], [40, 60], [80, 90]]);
  assert.ok(slots.every((s) => s.matched));
});

test('alignRunsToWords: fewer runs than words splits runs at energy minima', () => {
  const samples = Array.from({ length: 50 }, () => frame(0.08, 150));
  samples[10] = frame(0.01, 150); // planted boundary dips
  samples[41] = frame(0.01, 150);
  const runs = [span(0, 20), span(30, 50)];
  const { slots, status } = alignRunsToWords(runs, ['a', 'b', 'c', 'd'], { samples, tickSec: TICK });
  assert.equal(status, 'split');
  assert.deepEqual(slots.map((s) => [s.startIdx, s.endIdx]), [[0, 10], [10, 20], [30, 41], [41, 50]]);
  assert.ok(slots.every((s) => !s.matched));
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i].startIdx >= slots[i - 1].endIdx);
});

test('alignRunsToWords: splits prefer a syllable-onset frame over the energy minimum', () => {
  const samples = Array.from({ length: 20 }, () => frame(0.08, 150));
  samples[9] = frame(0.08, 150, { syl: 1.0 }); // fresh onset inside the search window
  samples[12] = frame(0.01, 150);              // energy minimum, further from target
  const { slots } = alignRunsToWords([span(0, 20)], ['a', 'b'], { samples, tickSec: TICK });
  assert.equal(slots[0].endIdx, 9);
  assert.equal(slots[1].startIdx, 9);
});

test('alignRunsToWords: no runs falls back to unmatched slots', () => {
  const { slots, status, lowConfidence } = alignRunsToWords([], ['a', 'b'], { tickSec: TICK });
  assert.equal(status, 'fallback');
  assert.ok(lowConfidence);
  assert.ok(slots.every((s) => !s.matched && s.startIdx === -1));
});

test('alignRunsToWords: large run/word mismatch sets lowConfidence', () => {
  const words = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'];
  const samples = Array.from({ length: 80 }, () => frame(0.08, 150));
  const { status, lowConfidence, slots } = alignRunsToWords([span(0, 80)], words, { samples, tickSec: TICK });
  assert.equal(status, 'split');
  assert.ok(lowConfidence);
  assert.equal(slots.length, 8);
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i].startIdx >= slots[i - 1].endIdx);
});

// ---------- summarizeWordMetrics ----------

test('summarizeWordMetrics: per-word pitch and relative loudness', () => {
  const samples = [...speech(20, 150, 0.08), ...silence(10), ...speech(20, 220, 0.04)];
  const slots = [
    { word: 'low', startIdx: 0, endIdx: 20, startSec: 0, endSec: 20 * TICK, durSec: 20 * TICK, matched: true },
    { word: 'high', startIdx: 30, endIdx: 50, startSec: 30 * TICK, endSec: 50 * TICK, durSec: 20 * TICK, matched: true },
  ];
  const words = summarizeWordMetrics(samples, slots, { tickSec: TICK });
  near(words[0].metrics.pitchAvgHz, 150);
  near(words[1].metrics.pitchAvgHz, 220);
  assert.ok(words[0].relLoudness > 1);
  assert.ok(words[1].relLoudness < 1);
  near(words[0].durSec, 20 * TICK);
});

test('summarizeWordMetrics: too few voiced frames → null metrics, duration preserved', () => {
  const samples = [...speech(20), ...silence(10)];
  const slots = [
    { word: 'said', startIdx: 0, endIdx: 20, startSec: 0, endSec: 20 * TICK, durSec: 20 * TICK, matched: true },
    { word: 'quiet', startIdx: 20, endIdx: 30, startSec: 20 * TICK, endSec: 30 * TICK, durSec: 10 * TICK, matched: true },
    { word: 'missing', startIdx: -1, endIdx: -1, startSec: 0, endSec: 0, durSec: 0, matched: false },
  ];
  const words = summarizeWordMetrics(samples, slots, { tickSec: TICK });
  assert.ok(words[0].metrics);
  assert.equal(words[1].metrics, null);
  near(words[1].durSec, 10 * TICK);
  assert.equal(words[2].metrics, null);
  assert.equal(words[2].durSec, 0);
});

// ---------- summarizePhraseTake ----------

test('summarizePhraseTake: clean three-word take — exact alignment, pauses, pace, contour', () => {
  const samples = [
    ...silence(20),
    ...speech(20, 150), ...silence(15),
    ...speech(20, 180), ...silence(15),
    ...speech(20, 210), ...silence(20),
  ];
  const out = summarizePhraseTake(samples, 'We were away.', { tickSec: TICK });
  assert.equal(out.segmentation.status, 'exact');
  assert.equal(out.segmentation.wordCount, 3);
  assert.equal(out.segmentation.runCount, 3);
  assert.equal(out.segmentation.lowConfidence, false);
  assert.deepEqual(out.words.map((w) => w.word), ['We', 'were', 'away']);
  near(out.words[0].metrics.pitchAvgHz, 150);
  near(out.words[1].metrics.pitchAvgHz, 180);
  near(out.words[2].metrics.pitchAvgHz, 210);

  const o = out.overall;
  near(o.pitchAvgHz, 180);
  assert.equal(o.pauseCount, 2);
  near(o.pauseTotalSec, 30 * TICK, 1e-9);
  near(o.speechSec, 60 * TICK, 1e-9);
  near(o.durationSec, samples.length * TICK, 1e-9);
  near(o.paceWps, 3 / (60 * TICK), 1e-6);
  near(o.pitchRangeSemitones, 12 * Math.log2(210 / 150), 1e-6);
  assert.equal(o.contour, 'rising');
  // Classic whole-clip fields are still present and consistent.
  assert.equal(typeof o.resonanceAvg, 'number');
  assert.equal(typeof o.voicedRatio, 'number');
  assert.equal(o.sampleCount, samples.length);
});

test('summarizePhraseTake: monotone take reads as flat contour', () => {
  const samples = [...silence(10), ...speech(60, 160), ...silence(10)];
  const out = summarizePhraseTake(samples, 'We were away.', { tickSec: TICK });
  assert.equal(out.overall.contour, 'flat');
});

test('summarizePhraseTake: tokenization strips punctuation and bare dash tokens', () => {
  const out = summarizePhraseTake([], 'Oh no — you are never going to believe this!', { tickSec: TICK });
  assert.equal(out.segmentation.wordCount, 9);
  assert.deepEqual(
    out.words.map((w) => w.word),
    ['Oh', 'no', 'you', 'are', 'never', 'going', 'to', 'believe', 'this']
  );
});

test('summarizePhraseTake: all-silent take degrades to nulls and fallback', () => {
  const out = summarizePhraseTake(silence(80), 'We were away.', { tickSec: TICK });
  assert.equal(out.overall, null);
  assert.equal(out.segmentation.status, 'fallback');
  assert.ok(out.words.every((w) => w.metrics === null && !w.matched));
});

test('PHRASE_SEG_DEFAULTS: exported and internally consistent', () => {
  assert.ok(PHRASE_SEG_DEFAULTS.offMult < PHRASE_SEG_DEFAULTS.onMult);
  assert.ok(PHRASE_SEG_DEFAULTS.minGapSec > 0);
  assert.ok(PHRASE_SEG_DEFAULTS.minRunSec > 0);
});
