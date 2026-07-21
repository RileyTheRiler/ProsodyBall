import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withFrameTimes,
  segmentActiveChunks,
  alignWords,
  analyzePhraseTake,
} from './phrase-analysis.js';

// ---------- synthetic frame builders ----------
// Frames mimic the recording snapshot: { t, hz, conf, voiced, res, prosody, energy, artic }.
const FRAME_MS = 12;

function frames(ms, { hz = 0, hzEnd = null, energy = 0.001, res = 0.5, artic = 0.2, conf = 0.9, dip = false } = {}) {
  const n = Math.max(1, Math.round(ms / FRAME_MS));
  return Array.from({ length: n }, (_, i) => {
    const frac = n > 1 ? i / (n - 1) : 0;
    const pitch = hzEnd != null ? hz + (hzEnd - hz) * frac : hz;
    // Optional mid-segment energy dip (simulates an intra-chunk word boundary
    // in connected speech: energy sags but never falls to silence).
    let e = energy;
    if (dip) {
      const d = Math.abs(frac - 0.5) * 2; // 0 at center, 1 at edges
      e = energy * (0.35 + 0.65 * d);
    }
    return {
      hz: pitch, conf, voiced: pitch > 0, res, prosody: 0.5,
      energy: e, artic,
    };
  });
}

const speech = (ms, opts = {}) => frames(ms, { hz: 180, energy: 0.1, ...opts });
const silence = (ms) => frames(ms, { hz: 0, energy: 0.001, conf: 0 });

function take(...parts) {
  return withFrameTimes(parts.flat(), FRAME_MS);
}

const W = (w, syllables = 1, weak = false) => ({ w, syllables, weak });

const PHRASE_3 = {
  text: 'Heat from fire.',
  focus: 'resonance',
  words: [W('Heat'), W('from', 1, true), W('fire', 2)],
};

// ---------- segmentation ----------

test('segmentActiveChunks: finds two bursts separated by silence', () => {
  const samples = take(silence(200), speech(300), silence(300), speech(400), silence(200));
  const chunks = segmentActiveChunks(samples);
  assert.equal(chunks.length, 2);
  assert.ok(Math.abs(chunks[0].startMs - 200) < 60, `start ${chunks[0].startMs}`);
  assert.ok(Math.abs(chunks[0].durMs - 300) < 80, `dur ${chunks[0].durMs}`);
  assert.ok(chunks[1].startMs > chunks[0].endMs + 200);
});

test('segmentActiveChunks: merges chunks split by a very short dip', () => {
  const samples = take(silence(200), speech(200), silence(36), speech(200), silence(200));
  const chunks = segmentActiveChunks(samples);
  assert.equal(chunks.length, 1);
});

test('segmentActiveChunks: drops blips shorter than minChunkMs', () => {
  const samples = take(silence(300), speech(24), silence(300), speech(300), silence(200));
  const chunks = segmentActiveChunks(samples);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].durMs > 200);
});

test('segmentActiveChunks: returns [] for flat/empty envelopes', () => {
  assert.deepEqual(segmentActiveChunks([]), []);
  assert.deepEqual(segmentActiveChunks(take(silence(1000))), []);
  const constant = take(frames(1000, { hz: 180, energy: 0.05 }));
  // Constant energy has no floor/peak contrast → no segmentation signal…
  // but it must not throw.
  assert.ok(Array.isArray(segmentActiveChunks(constant)));
});

// ---------- alignment ----------

test('alignWords: one chunk per word maps 1:1', () => {
  const samples = take(silence(200), speech(250), silence(280), speech(200), silence(280), speech(400), silence(200));
  const chunks = segmentActiveChunks(samples);
  assert.equal(chunks.length, 3);
  const a = alignWords(samples, chunks, PHRASE_3.words);
  assert.ok(a);
  assert.equal(a.method, 'words');
  assert.equal(a.spans.length, 3);
  assert.ok(a.quality > 0.5, `quality ${a.quality}`);
});

test('alignWords: groups syllable-level chunks into words', () => {
  // 4 chunks for [Heat(1), from(1), fire(2)] → last two chunks group into "fire".
  const samples = take(
    silence(200), speech(250), silence(280), speech(200), silence(280),
    speech(200), silence(80), speech(200), silence(200)
  );
  const chunks = segmentActiveChunks(samples);
  assert.equal(chunks.length, 4);
  const a = alignWords(samples, chunks, PHRASE_3.words);
  assert.ok(a);
  assert.equal(a.method, 'syllables');
  assert.equal(a.spans.length, 3);
  // "fire" span covers both of the last chunks
  assert.equal(a.spans[2].startMs, chunks[2].startMs);
  assert.equal(a.spans[2].endMs, chunks[3].endMs);
});

test('alignWords: DP partitions extra chunks by duration share', () => {
  // 3 chunks for 2 one-syllable words (chunk count matches neither words nor
  // syllables). The two chunks separated by a small gap should group together
  // so both words get roughly their proportional share of the take.
  const words = [W('go'), W('on')];
  const samples = take(
    silence(200), speech(260), silence(300),
    speech(240), silence(90), speech(260), silence(200)
  );
  const chunks = segmentActiveChunks(samples);
  assert.equal(chunks.length, 3);
  const a = alignWords(samples, chunks, words);
  assert.ok(a);
  assert.equal(a.method, 'dp');
  assert.equal(a.spans.length, 2);
  assert.equal(a.spans[1].endMs, chunks[2].endMs);
  assert.ok(a.spans[1].startMs <= chunks[1].startMs);
});

test('alignWords: splits a merged chunk at its energy dip', () => {
  // Two words spoken connectedly: one chunk with a mid-energy sag.
  const words = [W('heat'), W('fire')];
  const samples = take(silence(250), frames(500, { hz: 180, energy: 0.1, dip: true }), silence(250));
  const chunks = segmentActiveChunks(samples);
  assert.equal(chunks.length, 1);
  const a = alignWords(samples, chunks, words);
  assert.ok(a, 'expected split alignment');
  assert.equal(a.method, 'split');
  assert.equal(a.spans.length, 2);
  assert.ok(a.spans[0].endMs <= a.spans[1].startMs);
});

test('alignWords: returns null when there is nothing plausible to map', () => {
  assert.equal(alignWords([], [], PHRASE_3.words), null);
  const samples = take(silence(200), speech(300), silence(200));
  const chunks = segmentActiveChunks(samples);
  // 1 chunk, 6 words, no internal dips → no plausible split.
  const sixWords = [W('a'), W('b'), W('c'), W('d'), W('e'), W('f')];
  assert.equal(alignWords(samples, chunks, sixWords), null);
});

// ---------- analyzePhraseTake ----------

test('analyzePhraseTake: aligned take reports per-word pitch and durations', () => {
  const samples = take(
    silence(200),
    speech(250, { hz: 220 }),          // Heat
    silence(280),
    speech(200, { hz: 170 }),          // from
    silence(280),
    speech(420, { hz: 150 }),          // fire
    silence(200)
  );
  const r = analyzePhraseTake(samples, PHRASE_3);
  assert.ok(r);
  assert.equal(r.aligned, true);
  assert.equal(r.words.length, 3);
  assert.ok(Math.abs(r.words[0].pitchAvgHz - 220) < 5);
  assert.ok(Math.abs(r.words[2].pitchAvgHz - 150) < 5);
  assert.ok(r.words[2].durationMs > r.words[1].durationMs);
  for (const w of r.words) {
    assert.ok(w.score >= 0 && w.score <= 100);
    assert.ok(Number.isFinite(w.tStartMs) && w.tEndMs > w.tStartMs);
  }
  assert.ok(typeof r.takeaway === 'string' && r.takeaway.length > 0);
});

test('analyzePhraseTake: detects rising contour on the final word', () => {
  const phrase = {
    text: 'Really? Wednesday?', focus: 'intonation', contourHint: 'rise',
    words: [W('Really', 2), W('Wednesday', 2)],
  };
  const samples = take(
    silence(200),
    speech(300, { hz: 180 }),
    silence(300),
    speech(400, { hz: 160, hzEnd: 260 }), // clear rise
    silence(200)
  );
  const r = analyzePhraseTake(samples, phrase);
  assert.ok(r);
  assert.equal(r.aligned, true);
  assert.equal(r.words[1].contour, 'rise');
  assert.equal(r.overall.contourDirection, 'rise');
});

test('analyzePhraseTake: weak words are graded leniently', () => {
  const samples = take(
    silence(200),
    speech(250, { hz: 220, res: 0.8 }),
    silence(280),
    speech(80, { hz: 170, res: 0.05 }),  // short, dull function word
    silence(280),
    speech(420, { hz: 150, res: 0.8 }),
    silence(200)
  );
  const r = analyzePhraseTake(samples, PHRASE_3);
  assert.ok(r && r.aligned);
  const from = r.words[1];
  assert.equal(from.weak, true);
  assert.ok(from.score >= 60, `weak word floor: ${from.score}`);
});

test('analyzePhraseTake: falls back to overall-only when words cannot be aligned', () => {
  // One continuous flat-energy burst for a 6-word phrase: alignment must give up,
  // but overall stats must survive.
  const phrase = {
    text: 'Heat from fire, fire from heat.', focus: 'resonance',
    words: [W('Heat'), W('from', 1, true), W('fire', 2), W('fire', 2), W('from', 1, true), W('heat')],
  };
  const samples = take(silence(200), speech(700, { hz: 190 }), silence(200));
  const r = analyzePhraseTake(samples, phrase);
  assert.ok(r);
  assert.equal(r.aligned, false);
  assert.deepEqual(r.words, []);
  assert.ok(r.overall.pitchAvgHz > 180 && r.overall.pitchAvgHz < 200);
  assert.ok(r.overall.score >= 0 && r.overall.score <= 100);
  assert.ok(/overall/i.test(r.takeaway));
});

test('analyzePhraseTake: overall stats include spread, rate, and pauses', () => {
  const samples = take(
    silence(200),
    speech(250, { hz: 140 }),
    silence(400),                        // long gap → the only pause
    speech(200, { hz: 200 }),
    silence(180),                        // normal inter-word gap, below pause threshold
    speech(400, { hz: 260 }),
    silence(200)
  );
  const r = analyzePhraseTake(samples, PHRASE_3);
  assert.ok(r);
  assert.ok(r.overall.intonationSpreadSt > 2, `spread ${r.overall.intonationSpreadSt}`);
  assert.ok(r.overall.speakingRateWps > 0);
  assert.equal(r.overall.pauseCount, 1);
  assert.ok(r.overall.avgPauseMs > 250);
  assert.ok(r.overall.durationMs > 1500);
});

test('analyzePhraseTake: contour series is bounded and gap-aware', () => {
  const samples = take(silence(200), speech(600, { hz: 180 }), silence(400), speech(300, { hz: 220 }), silence(200));
  const r = analyzePhraseTake(samples, { text: 'x y', focus: 'intonation', words: [W('x'), W('y')] });
  assert.ok(r);
  assert.ok(r.contourSeries.length > 10 && r.contourSeries.length <= 140);
  assert.ok(r.contourSeries.some((p) => p.hz === null), 'expected null gaps');
  assert.ok(r.contourSeries.some((p) => p.hz > 100), 'expected voiced points');
});

test('analyzePhraseTake: returns null with no usable voice (matches clip metrics)', () => {
  assert.equal(analyzePhraseTake(take(silence(1000)), PHRASE_3), null);
  assert.equal(analyzePhraseTake([], PHRASE_3), null);
});

test('analyzePhraseTake: legacy samples without t/energy still yield overall stats', () => {
  // Old clips only captured { hz, conf, voiced, res, prosody }.
  const legacy = Array.from({ length: 100 }, () => ({ hz: 185, conf: 0.9, voiced: true, res: 0.5, prosody: 0.5 }));
  const r = analyzePhraseTake(legacy, PHRASE_3);
  assert.ok(r);
  assert.equal(r.aligned, false);
  assert.ok(Math.abs(r.overall.pitchAvgHz - 185) < 1);
});
