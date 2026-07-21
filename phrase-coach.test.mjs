import test from 'node:test';
import assert from 'node:assert/strict';
import { PRACTICE_PHRASES, scorePhraseTake, buildContourSeries } from './phrase-coach.js';
import { summarizePhraseTake } from './dsp-utils.js';

// ---------- fixture builders (shapes mirror summarizePhraseTake output) ----------

function wordEntry(word, {
  matched = true, durSec = 0.3, pitchAvgHz = 180, pitchMinHz = 170, pitchMaxHz = 190,
  resonanceAvg = 0.5, voicedRatio = 0.7, metrics = undefined, relLoudness = 1,
} = {}) {
  const m = metrics === null ? null : {
    pitchAvgHz, pitchMinHz, pitchMaxHz,
    resonanceAvg, prosodyAvg: 0.5, voicedRatio, sampleCount: 20,
  };
  return { word, matched, startSec: 0, endSec: durSec, durSec, metrics: m, energyAvg: 0.05, relLoudness };
}

function analysisFixture(words, {
  contour = 'flat', pitchRangeSemitones = 4, voicedRatio = 0.7, speechSec = 1.5,
  status = 'exact', lowConfidence = false,
} = {}) {
  return {
    phrase: words.map((w) => w.word).join(' '),
    words,
    overall: {
      pitchAvgHz: 180, pitchMinHz: 150, pitchMaxHz: 220,
      resonanceAvg: 0.5, prosodyAvg: 0.5, voicedRatio, sampleCount: 200,
      durationSec: 2.5, speechSec, pauseCount: 1, pauseTotalSec: 0.4,
      paceWps: 2.5, paceSylPerSec: 3.5, pitchRangeSemitones, contour,
    },
    segmentation: { status, runCount: words.length, wordCount: words.length, lowConfidence },
  };
}

// ---------- practice curriculum consistency ----------

test('PRACTICE_PHRASES: entries are consistent with the engine tokenizer', () => {
  assert.ok(PRACTICE_PHRASES.length >= 6);
  const focuses = new Set(['resonance', 'intonation', 'elongation', 'articulation']);
  for (const p of PRACTICE_PHRASES) {
    assert.ok(p.text && typeof p.text === 'string');
    assert.ok(focuses.has(p.focus), `unknown focus ${p.focus} for "${p.text}"`);
    if (p.contourHint) assert.ok(['rising', 'falling'].includes(p.contourHint));
    assert.ok(typeof p.tip === 'string' && p.tip.length > 0);
    // Same tokenization as summarizePhraseTake — weak words must name real tokens.
    const tokens = new Set(
      p.text.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'’-]/gu, '').toLowerCase()).filter(Boolean)
    );
    for (const w of p.weakWords || []) {
      assert.ok(tokens.has(w), `weak word "${w}" not in tokens of "${p.text}"`);
    }
  }
});

test('PRACTICE_PHRASES: includes the "Heat from fire" resonance drill', () => {
  const heat = PRACTICE_PHRASES.find((p) => /heat from fire/i.test(p.text));
  assert.ok(heat);
  assert.equal(heat.focus, 'resonance');
});

// ---------- scorePhraseTake ----------

test('scorePhraseTake: null without usable overall stats', () => {
  assert.equal(scorePhraseTake(null, PRACTICE_PHRASES[0]), null);
  assert.equal(scorePhraseTake({ words: [], overall: null, segmentation: {} }, PRACTICE_PHRASES[0]), null);
});

test('scorePhraseTake: resonance focus rewards bright words', () => {
  const a = analysisFixture([
    wordEntry('heat', { resonanceAvg: 0.9 }),
    wordEntry('fire', { resonanceAvg: 0.1 }),
  ]);
  const r = scorePhraseTake(a, { focus: 'resonance' });
  assert.ok(r);
  assert.ok(r.words[0].score > r.words[1].score + 20,
    `expected clear gap: ${r.words[0].score} vs ${r.words[1].score}`);
});

test('scorePhraseTake: weak words are floored at 60', () => {
  const a = analysisFixture([
    wordEntry('heat', { resonanceAvg: 0.9 }),
    wordEntry('from', { resonanceAvg: 0.05, voicedRatio: 0.4, durSec: 0.08 }),
  ]);
  const r = scorePhraseTake(a, { focus: 'resonance', weakWords: ['from'] });
  assert.equal(r.words[1].weak, true);
  assert.ok(r.words[1].score >= 60, `weak floor: ${r.words[1].score}`);
});

test('scorePhraseTake: a word slice with no usable voice is capped low and marked unclear', () => {
  const a = analysisFixture([
    wordEntry('heat'),
    wordEntry('fire', { metrics: null }),
  ]);
  const r = scorePhraseTake(a, { focus: 'resonance' });
  assert.ok(r.words[1].score <= 35, `cap: ${r.words[1].score}`);
  assert.equal(r.words[1].note, 'unclear');
});

test('scorePhraseTake: flat content words get flagged under intonation focus', () => {
  const a = analysisFixture([
    wordEntry('Wednesday', { durSec: 1.4, pitchMinHz: 179, pitchMaxHz: 181, voicedRatio: 0.8 }),
  ], { speechSec: 1.5 });
  const r = scorePhraseTake(a, { focus: 'intonation' });
  assert.equal(r.words[0].note, 'flat');
});

test('scorePhraseTake: rushed content words get flagged', () => {
  // "really" (2 syllables) squeezed into 60ms of a 2s take.
  const a = analysisFixture([
    wordEntry('really', { durSec: 0.06, pitchMinHz: 150, pitchMaxHz: 220 }),
    wordEntry('slow', { durSec: 1.2, pitchMinHz: 150, pitchMaxHz: 220 }),
  ], { speechSec: 2 });
  const r = scorePhraseTake(a, { focus: 'intonation' });
  assert.equal(r.words[0].note, 'rushed');
});

test('scorePhraseTake: contour hint match earns a bonus; mismatch coaches the ending', () => {
  const words = [wordEntry('Wednesday', { pitchMinHz: 150, pitchMaxHz: 220 })];
  const rising = scorePhraseTake(analysisFixture(words, { contour: 'rising' }), { focus: 'intonation', contourHint: 'rising' });
  const flat = scorePhraseTake(analysisFixture(words, { contour: 'flat' }), { focus: 'intonation', contourHint: 'rising' });
  assert.equal(rising.contourMatch, true);
  assert.equal(flat.contourMatch, false);
  assert.ok(rising.score > flat.score, `${rising.score} > ${flat.score}`);
  assert.ok(/lift/.test(flat.takeaway), flat.takeaway);
});

test('scorePhraseTake: low-confidence segmentation dominates the takeaway', () => {
  const a = analysisFixture([wordEntry('heat')], { lowConfidence: true, status: 'split' });
  const r = scorePhraseTake(a, { focus: 'resonance' });
  assert.ok(/rough estimates/i.test(r.takeaway), r.takeaway);
});

test('scorePhraseTake: takeaway names the strongest and weakest content words', () => {
  const a = analysisFixture([
    wordEntry('heat', { resonanceAvg: 0.95, voicedRatio: 0.9 }),
    wordEntry('from', { resonanceAvg: 0.5 }),
    wordEntry('fire', { resonanceAvg: 0.05, voicedRatio: 0.4 }),
  ]);
  const r = scorePhraseTake(a, { focus: 'resonance', weakWords: ['from'] });
  assert.ok(r.takeaway.includes('“heat”'), r.takeaway);
  assert.ok(r.takeaway.includes('“fire”'), r.takeaway);
});

// ---------- buildContourSeries ----------

test('buildContourSeries: bounded, gap-aware, monotonic in time', () => {
  const tick = 512 / 44100;
  const frame = (hz) => ({ hz, conf: hz > 0 ? 0.9 : 0, voiced: hz > 0, energy: hz > 0 ? 0.1 : 0.001 });
  const samples = [
    ...Array.from({ length: 60 }, () => frame(180)),
    ...Array.from({ length: 40 }, () => frame(0)),     // pause → null gap
    ...Array.from({ length: 60 }, () => frame(220)),
  ];
  const series = buildContourSeries(samples, { tickSec: tick });
  assert.ok(series.length > 10 && series.length <= 140);
  assert.ok(series.some((p) => p.hz === null), 'expected null gap');
  assert.ok(series.some((p) => p.hz > 100), 'expected voiced points');
  for (let i = 1; i < series.length; i++) assert.ok(series[i].t >= series[i - 1].t);
  assert.deepEqual(buildContourSeries([]), []);
});

// ---------- integration with the dsp-utils engine ----------

test('integration: engine output scores end-to-end for the resonance drill', () => {
  const tick = 512 / 44100;
  const n = (sec) => Math.round(sec / tick);
  const speech = (sec, hz, res) => Array.from({ length: n(sec) }, () => (
    { hz, conf: 0.9, voiced: true, res, prosody: 0.5, energy: 0.1, syl: 0 }
  ));
  const silence = (sec) => Array.from({ length: n(sec) }, () => (
    { hz: 0, conf: 0, voiced: false, res: 0, prosody: 0, energy: 0.001, syl: 0 }
  ));
  const phrase = PRACTICE_PHRASES.find((p) => /heat from fire/i.test(p.text));
  const samples = [
    ...silence(0.25),
    ...speech(0.25, 220, 0.8), ...silence(0.2),   // Heat
    ...speech(0.15, 180, 0.5), ...silence(0.2),   // from
    ...speech(0.3, 170, 0.7), ...silence(0.2),    // fire
    ...speech(0.3, 170, 0.7), ...silence(0.2),    // fire
    ...speech(0.15, 180, 0.5), ...silence(0.2),   // from
    ...speech(0.3, 150, 0.8),                     // heat
    ...silence(0.25),
  ];
  const analysis = summarizePhraseTake(samples, phrase.text, { tickSec: tick });
  assert.ok(analysis.overall, 'expected usable overall stats');
  assert.equal(analysis.words.length, 6);
  const r = scorePhraseTake(analysis, phrase);
  assert.ok(r);
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.words.length, 6);
  for (const w of r.words) assert.ok(w.score >= 0 && w.score <= 100);
  assert.ok(typeof r.takeaway === 'string' && r.takeaway.length > 0);
});
