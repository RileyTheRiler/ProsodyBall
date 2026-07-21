// ============================================================
// PHRASE COACH
// The coaching layer on top of the phrase-take analysis engine in dsp-utils.js
// (segmentSpeechRuns → alignRunsToWords → summarizePhraseTake). The engine
// measures; this module judges and explains:
//   - PRACTICE_PHRASES: the structured practice curriculum (what each phrase
//     trains, expected phrase-final contour, coaching tip, weak function words)
//   - scorePhraseTake(): focus-driven 0–100 scores per word and for the take,
//     with short coaching notes and a one-line takeaway
//   - buildContourSeries(): downsampled pitch series for the results sparkline
// Pure functions, no DOM/WebAudio — unit-tested in phrase-coach.test.mjs.
// ============================================================

import { clamp01, estimateSyllables } from './dsp-utils.js';

// Focus-metric shaping constants. Bases map a raw measurement into [0,1]
// "how well did this word do what the phrase trains".
const INTONATION_FULL_RANGE_ST = 3.5;  // per-word pitch range (st) that earns a full intonation base
const ELONGATION_FULL_SEC_PER_SYL = 0.3; // seconds per syllable that earns a full elongation base
const CLARITY_FULL_VOICED_RATIO = 0.6; // voiced ratio that counts as fully clear
const EXPRESSIVE_FULL_RANGE_ST = 6;    // whole-take pitch range (st) that reads as fully expressive
const WEAK_WORD_FLOOR = 0.6;           // function words are graded leniently — they should be short
const NO_VOICE_CEILING = 0.35;         // a word slice with no usable voice can't score above this
const RUSHED_FRACTION = 0.45;          // 'rushed' when a content word gets under this share of its expected time
const CONTOUR_BONUS = 5;               // take-score bonus for matching the phrase's contour hint

// The guided-practice curriculum. `text` is what the user reads and exactly what
// the engine aligns against (it tokenizes the text itself — keep them in sync).
// `focus` picks the scoring base; `contourHint` uses the engine's contour
// vocabulary ('rising' | 'falling'); `weakWords` are function words graded
// leniently (lowercase, matched against tokenized words).
export const PRACTICE_PHRASES = [
  {
    text: 'Heat from fire, fire from heat.',
    focus: 'resonance',
    contourHint: 'falling',
    tip: 'Keep the sound bright and forward on every word.',
    weakWords: ['from'],
  },
  {
    text: 'We were away a year ago.',
    focus: 'elongation',
    contourHint: 'falling',
    tip: 'Let every vowel stretch — smooth and connected.',
    weakWords: ['were', 'a'],
  },
  {
    text: 'Where are you going on Wednesday?',
    focus: 'intonation',
    contourHint: 'rising',
    tip: 'Let the pitch lift toward the end of the question.',
    weakWords: ['are', 'on'],
  },
  {
    text: 'Hello! It is so nice to see you again.',
    focus: 'intonation',
    contourHint: 'falling',
    tip: 'Big friendly swoop on “Hello”, then land softly.',
    weakWords: ['it', 'is', 'to', 'you'],
  },
  {
    text: 'I really loved that little yellow umbrella.',
    focus: 'articulation',
    contourHint: 'falling',
    tip: 'Crisp consonants — keep the L’s and T’s clean and light.',
    weakWords: ['i', 'that'],
  },
  {
    text: 'Oh no — you are never going to believe this!',
    focus: 'intonation',
    tip: 'Go dramatic — swing the pitch as wide as feels fun.',
    weakWords: ['you', 'are', 'to'],
  },
];

const lc = (w) => String(w || '').toLowerCase();

const wordRangeSt = (m) => (m && m.pitchMinHz > 0 && m.pitchMaxHz > 0)
  ? 12 * Math.log2(m.pitchMaxHz / m.pitchMinHz)
  : 0;

// [0,1] "did this word do what the phrase trains". Word shape is the engine's
// summarizeWordMetrics output: { word, matched, durSec, metrics|null, relLoudness }.
function focusBase(w, focus) {
  const m = w.metrics;
  if (!m) return 0;
  switch (focus) {
    case 'resonance': return clamp01(m.resonanceAvg);
    case 'intonation': return clamp01(wordRangeSt(m) / INTONATION_FULL_RANGE_ST);
    case 'elongation': return clamp01((w.durSec / estimateSyllables(w.word)) / ELONGATION_FULL_SEC_PER_SYL);
    case 'articulation':
      // No per-word consonant metric in the snapshot stream, so articulation is
      // proxied by clean voicing inside a cleanly-detected boundary: estimated
      // (split) boundaries mean the consonant gaps weren't crisp enough to hear.
      return clamp01(m.voicedRatio / CLARITY_FULL_VOICED_RATIO) * (w.matched ? 1 : 0.75);
    default: return clamp01(wordRangeSt(m) / INTONATION_FULL_RANGE_ST);
  }
}

function wordNote(w, { weak, focus, score, expectedSec }) {
  if (!w.metrics || w.metrics.voicedRatio < 0.35) return 'unclear';
  if (!weak && expectedSec > 0 && w.durSec < RUSHED_FRACTION * expectedSec) return 'rushed';
  if (focus === 'intonation' && !weak && wordRangeSt(w.metrics) < 1) return 'flat';
  if (score >= 85) return 'nice';
  return '';
}

function buildTakeaway({ scoredWords, phraseDef, overall, segmentation }) {
  if (segmentation?.lowConfidence) {
    return 'Word grades are rough estimates this take — crisper gaps between words will sharpen them.';
  }
  const parts = [];
  const content = scoredWords.filter((w) => !w.weak && w.metrics);
  const pool = content.length ? content : scoredWords.filter((w) => w.metrics);
  if (pool.length) {
    let strong = pool[0], weakest = pool[0];
    for (const w of pool) {
      if (w.score > strong.score) strong = w;
      if (w.score < weakest.score) weakest = w;
    }
    parts.push(`Strongest: “${strong.word}”`);
    if (weakest !== strong && weakest.score < 75) parts.push(`work on “${weakest.word}”`);
  }
  if (phraseDef?.contourHint && overall.contour !== phraseDef.contourHint) {
    parts.push(phraseDef.contourHint === 'rising'
      ? 'let the pitch lift at the end'
      : 'let the pitch settle at the end');
  }
  return parts.join(' · ') || 'Solid take — press on!';
}

// Score one analyzed take. `analysis` is summarizePhraseTake() output;
// `phraseDef` is a PRACTICE_PHRASES entry (or any { focus, contourHint,
// weakWords }). Returns null when the take had no usable voice, otherwise:
//   { score, contourMatch, takeaway,
//     words: [{ word, score, note, weak }] }  // parallel to analysis.words
export function scorePhraseTake(analysis, phraseDef = {}) {
  if (!analysis || !analysis.overall) return null;
  const o = analysis.overall;
  const focus = phraseDef.focus;
  const weakSet = new Set((phraseDef.weakWords || []).map(lc));
  const words = Array.isArray(analysis.words) ? analysis.words : [];

  const sylTotal = words.reduce((a, w) => a + estimateSyllables(w.word), 0) || 1;
  const speechSec = Number.isFinite(o.speechSec) ? o.speechSec : 0;

  const scoredWords = words.map((w) => {
    const weak = weakSet.has(lc(w.word));
    const clarity = w.metrics ? clamp01(w.metrics.voicedRatio / CLARITY_FULL_VOICED_RATIO) : 0;
    let score01 = 0.7 * focusBase(w, focus) + 0.3 * clarity;
    // Function words *should* stay short and unstressed — grading them like
    // content words would coach robotic over-enunciation.
    if (weak) score01 = Math.max(score01, WEAK_WORD_FLOOR);
    if (!w.metrics) score01 = Math.min(score01, NO_VOICE_CEILING);
    const score = Math.round(clamp01(score01) * 100);
    const expectedSec = speechSec * (estimateSyllables(w.word) / sylTotal);
    return {
      word: w.word,
      weak,
      metrics: w.metrics,
      score,
      note: wordNote(w, { weak, focus, score, expectedSec }),
    };
  });

  const content = scoredWords.filter((w) => !w.weak);
  const pool = content.length ? content : scoredWords;
  const focusAvg = pool.length ? pool.reduce((a, w) => a + w.score, 0) / pool.length / 100 : 0;
  const clarity = clamp01(o.voicedRatio / CLARITY_FULL_VOICED_RATIO);
  const expressiveness = clamp01((o.pitchRangeSemitones || 0) / EXPRESSIVE_FULL_RANGE_ST);
  let score = Math.round(100 * (0.55 * focusAvg + 0.25 * expressiveness + 0.20 * clarity));
  const contourMatch = phraseDef.contourHint ? o.contour === phraseDef.contourHint : null;
  if (contourMatch) score += CONTOUR_BONUS;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    contourMatch,
    takeaway: buildTakeaway({ scoredWords, phraseDef, overall: o, segmentation: analysis.segmentation }),
    words: scoredWords.map(({ word, score: s, note, weak }) => ({ word, score: s, note, weak })),
  };
}

// Downsample the per-tick snapshots into a sparkline-ready pitch series:
// ≤ maxPoints of { t (sec), hz | null }, bucket-averaged over usable voiced
// frames; null buckets break the line so pauses render as gaps.
export function buildContourSeries(samples, { tickSec = 512 / 44100, maxPoints = 140, minConf = 0.35 } = {}) {
  const all = Array.isArray(samples) ? samples : [];
  if (all.length === 0) return [];
  const buckets = Math.min(maxPoints, all.length);
  const perBucket = all.length / buckets;
  const series = [];
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * perBucket);
    const hi = Math.max(lo + 1, Math.floor((b + 1) * perBucket));
    let sum = 0, n = 0;
    for (let i = lo; i < hi && i < all.length; i++) {
      const s = all[i];
      if (s && s.voiced && s.hz > 0 && s.conf >= minConf) { sum += s.hz; n++; }
    }
    series.push({ t: lo * tickSec, hz: n ? sum / n : null });
  }
  return series;
}
