// ============================================================
// PHRASE TAKE ANALYSIS
// Pure functions that turn the per-frame metric snapshots captured while
// recording a known practice phrase into an overall + word-by-word review.
//
// The word boundaries are inferred, not recognized: we already know which
// phrase the user was asked to read, so we segment the energy envelope into
// voiced chunks and map chunks onto the phrase's expected word/syllable
// structure. When the chunk pattern doesn't plausibly match the phrase
// (mumbled, slurred, noisy), we return `aligned: false` and the caller falls
// back to overall-only stats — a wrong per-word grade is worse than none.
//
// No DOM / WebAudio dependencies: unit-tested with synthetic frame sequences
// in phrase-analysis.test.mjs. See docs/ANALYZER_API.md for the frame fields.
// ============================================================

import { clamp01, summarizeClipMetrics } from './dsp-utils.js';

// Frame-quality + segmentation tuning. Mirrors the live analyzer's hysteresis
// approach (SYLLABLE_ON_MULT / SYLLABLE_OFF_MULT in app.js) but re-derives the
// floor/peak from the clip itself so it works offline on saved samples.
const MIN_CONF = 0.35;            // pitch-confidence gate, same as summarizeClipMetrics
const ENERGY_SMOOTH_FRAMES = 3;   // moving-average window for the energy envelope
const ENERGY_FLOOR_PCT = 0.15;    // clip-relative noise floor percentile
const ENERGY_PEAK_PCT = 0.97;     // clip-relative peak percentile (robust to spikes)
const CHUNK_ON_FRAC = 0.22;       // rise threshold as fraction of (peak−floor) above floor
const CHUNK_OFF_FRAC = 0.10;      // fall threshold (hysteresis)
const MIN_CHUNK_MS = 60;          // discard blips shorter than this
const MERGE_GAP_MS = 60;          // gaps shorter than this join adjacent chunks
const PAUSE_MS = 250;             // inter-chunk gaps longer than this count as pauses
const CONTOUR_DELTA_ST = 0.7;     // semitone move needed to call a contour rise/fall
const MIN_ALIGN_QUALITY = 0.35;   // below this duration-fit quality we report unaligned
const CONTOUR_SERIES_MAX_POINTS = 140;

// ---------- small numeric helpers ----------

function movingAverage(values, win) {
  const half = Math.floor(win / 2);
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j]; n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function percentileOfSorted(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[idx];
}

function median(values) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const hzToSt = (hz) => 12 * Math.log2(hz / 100); // 100 Hz reference; only deltas matter

// Attach frame times when the capture didn't include them (legacy samples):
// evenly spaced at frameMs. Returns the same array when every frame has t.
export function withFrameTimes(samples, frameMs = 12) {
  if (!Array.isArray(samples)) return [];
  if (samples.every((s) => s && Number.isFinite(s.t))) return samples;
  return samples.map((s, i) => ({ ...s, t: Number.isFinite(s?.t) ? s.t : i * frameMs }));
}

// ---------- segmentation ----------

// Segment the clip's energy envelope into voiced/active chunks using
// hysteresis thresholds derived from the clip's own floor/peak percentiles.
// Returns [{ startIdx, endIdx, startMs, endMs, durMs }] (indices inclusive).
export function segmentActiveChunks(samples, {
  minChunkMs = MIN_CHUNK_MS,
  mergeGapMs = MERGE_GAP_MS,
  onFrac = CHUNK_ON_FRAC,
  offFrac = CHUNK_OFF_FRAC,
} = {}) {
  if (!Array.isArray(samples) || samples.length < 4) return [];
  const energies = samples.map((s) => (s && Number.isFinite(s.energy) ? Math.max(0, s.energy) : 0));
  const sm = movingAverage(energies, ENERGY_SMOOTH_FRAMES);
  const sorted = [...sm].sort((a, b) => a - b);
  const floor = percentileOfSorted(sorted, ENERGY_FLOOR_PCT);
  const peak = percentileOfSorted(sorted, ENERGY_PEAK_PCT);
  const range = peak - floor;
  if (!(range > 1e-6)) return []; // flat envelope: nothing to segment

  const onTh = floor + range * onFrac;
  const offTh = floor + range * offFrac;
  const raw = [];
  let active = false, start = 0;
  for (let i = 0; i < sm.length; i++) {
    if (!active && sm[i] >= onTh) { active = true; start = i; }
    else if (active && sm[i] < offTh) { raw.push([start, i - 1]); active = false; }
  }
  if (active) raw.push([start, sm.length - 1]);

  const tOf = (i) => samples[i].t;
  // Merge chunks separated by very short dips (intra-word energy wobble).
  const merged = [];
  for (const span of raw) {
    const prev = merged[merged.length - 1];
    if (prev && tOf(span[0]) - tOf(prev[1]) < mergeGapMs) prev[1] = span[1];
    else merged.push([...span]);
  }
  return merged
    .filter(([s, e]) => tOf(e) - tOf(s) >= minChunkMs)
    .map(([s, e]) => ({ startIdx: s, endIdx: e, startMs: tOf(s), endMs: tOf(e), durMs: tOf(e) - tOf(s) }));
}

// Split one chunk into `parts` sub-spans at its deepest internal energy dips
// (used when connected speech merged several words into one chunk). Returns
// an array of [startIdx, endIdx] or null when there aren't enough real dips.
function splitChunkAtDips(samples, sm, chunk, parts, minPartMs) {
  if (parts <= 1) return [[chunk.startIdx, chunk.endIdx]];
  const { startIdx: s, endIdx: e } = chunk;
  // Candidate boundaries: interior local minima of the smoothed envelope.
  const valleys = [];
  for (let i = s + 1; i < e; i++) {
    if (sm[i] <= sm[i - 1] && sm[i] <= sm[i + 1]) valleys.push(i);
  }
  valleys.sort((a, b) => sm[a] - sm[b]); // deepest dips first
  const tOf = (i) => samples[i].t;
  const chosen = [];
  for (const v of valleys) {
    if (chosen.length >= parts - 1) break;
    const nearBoundary = [s, e, ...chosen].some((b) => Math.abs(tOf(v) - tOf(b)) < minPartMs);
    if (!nearBoundary) chosen.push(v);
  }
  if (chosen.length < parts - 1) return null;
  chosen.sort((a, b) => a - b);
  const spans = [];
  let cur = s;
  for (const v of chosen) { spans.push([cur, v]); cur = v + 1; }
  spans.push([cur, e]);
  return spans;
}

// ---------- alignment ----------

const totalSyllables = (words) => words.reduce((n, w) => n + (w.syllables || 1), 0);

// Partition `chunks` into words.length contiguous groups, minimizing the
// relative mismatch between each word's spanned duration and its
// syllable-proportional share of the take. Tiny DP: O(W · C²) with W,C ≤ ~20.
function dpPartition(chunks, words) {
  const C = chunks.length, W = words.length;
  const S = totalSyllables(words);
  const takeMs = chunks[C - 1].endMs - chunks[0].startMs;
  const expected = words.map((w) => takeMs * ((w.syllables || 1) / S));
  const spanMs = (j, k) => chunks[k].endMs - chunks[j].startMs;
  const cost = (i, j, k) => Math.abs(spanMs(j, k) - expected[i]) / Math.max(expected[i], 1);

  // dp[i][j]: best cost covering chunks j.. with words i.. ; choice[i][j]: end chunk for word i.
  const dp = Array.from({ length: W + 1 }, () => new Array(C + 1).fill(Infinity));
  const choice = Array.from({ length: W }, () => new Array(C).fill(-1));
  dp[W][C] = 0;
  for (let i = W - 1; i >= 0; i--) {
    for (let j = 0; j < C; j++) {
      // word i takes chunks j..k; leave at least (W-1-i) chunks for the rest
      for (let k = j; k <= C - 1 - (W - 1 - i); k++) {
        const c = cost(i, j, k) + dp[i + 1][k + 1];
        if (c < dp[i][j]) { dp[i][j] = c; choice[i][j] = k; }
      }
    }
  }
  if (!Number.isFinite(dp[0][0])) return null;
  const groups = [];
  let j = 0;
  for (let i = 0; i < W; i++) {
    const k = choice[i][j];
    if (k < 0) return null;
    groups.push(chunks.slice(j, k + 1));
    j = k + 1;
  }
  return groups;
}

// Duration-fit quality in [0,1]: 1 = every word's span matches its
// syllable-proportional expectation, 0 = mean relative error ≥ 100%.
function alignmentQuality(spans, words) {
  const S = totalSyllables(words);
  const takeMs = spans[spans.length - 1].endMs - spans[0].startMs;
  if (!(takeMs > 0)) return 0;
  let errSum = 0;
  for (let i = 0; i < words.length; i++) {
    const expected = takeMs * ((words[i].syllables || 1) / S);
    errSum += Math.abs((spans[i].endMs - spans[i].startMs) - expected) / Math.max(expected, 1);
  }
  return clamp01(1 - errSum / words.length);
}

// Map active chunks onto the phrase's words. Strategies, in order of trust:
// one chunk per word → group chunks by syllable counts → DP partition of
// extra chunks → split merged chunks at energy dips. Returns
// { spans, method, quality } or null when no plausible mapping exists.
export function alignWords(samples, chunks, words, { minPartMs = MIN_CHUNK_MS } = {}) {
  const W = Array.isArray(words) ? words.length : 0;
  if (!W || !Array.isArray(chunks) || chunks.length === 0) return null;
  const S = totalSyllables(words);
  let groups = null, method = null;

  if (chunks.length === W) {
    groups = chunks.map((c) => [c]);
    method = 'words';
  } else if (chunks.length === S) {
    groups = [];
    let ci = 0;
    for (const w of words) { groups.push(chunks.slice(ci, ci + (w.syllables || 1))); ci += (w.syllables || 1); }
    method = 'syllables';
  } else if (chunks.length > W && chunks.length < S * 2) {
    groups = dpPartition(chunks, words);
    method = 'dp';
  } else if (chunks.length < W) {
    // Connected speech: split the chunks that plausibly hold several words.
    const energies = samples.map((s) => (s && Number.isFinite(s.energy) ? Math.max(0, s.energy) : 0));
    const sm = movingAverage(energies, ENERGY_SMOOTH_FRAMES);
    const totalDur = chunks.reduce((n, c) => n + c.durMs, 0);
    // Distribute the word count over chunks proportional to duration (each ≥1).
    const alloc = chunks.map(() => 1);
    let remaining = W - chunks.length;
    while (remaining > 0) {
      let best = 0, bestLoad = -Infinity;
      for (let i = 0; i < chunks.length; i++) {
        const load = chunks[i].durMs / alloc[i];
        if (load > bestLoad) { bestLoad = load; best = i; }
      }
      alloc[best]++; remaining--;
    }
    if (totalDur > 0) {
      groups = [];
      for (let i = 0; i < chunks.length; i++) {
        const spans = splitChunkAtDips(samples, sm, chunks[i], alloc[i], minPartMs);
        if (!spans) { groups = null; break; }
        const tOf = (idx) => samples[idx].t;
        for (const [s2, e2] of spans) {
          groups.push([{ startIdx: s2, endIdx: e2, startMs: tOf(s2), endMs: tOf(e2), durMs: tOf(e2) - tOf(s2) }]);
        }
      }
      method = 'split';
    }
  }
  if (!groups || groups.length !== W) return null;

  const spans = groups.map((g) => ({
    startIdx: g[0].startIdx, endIdx: g[g.length - 1].endIdx,
    startMs: g[0].startMs, endMs: g[g.length - 1].endMs,
  }));
  const quality = alignmentQuality(spans, words);
  return { spans, method, quality };
}

// ---------- per-word + overall stats ----------

function contourOf(voicedFrames) {
  // First-third vs last-third median pitch, in semitones. Robust to octave
  // blips at word edges; needs a handful of voiced frames to say anything.
  if (voicedFrames.length < 4) return { contour: 'flat', deltaSt: 0 };
  const third = Math.max(1, Math.floor(voicedFrames.length / 3));
  const first = median(voicedFrames.slice(0, third).map((f) => f.hz));
  const last = median(voicedFrames.slice(-third).map((f) => f.hz));
  if (!first || !last) return { contour: 'flat', deltaSt: 0 };
  const deltaSt = hzToSt(last) - hzToSt(first);
  const contour = deltaSt > CONTOUR_DELTA_ST ? 'rise' : deltaSt < -CONTOUR_DELTA_ST ? 'fall' : 'flat';
  return { contour, deltaSt };
}

const isUsable = (s) => s && s.voiced && s.hz > 0 && s.conf >= MIN_CONF;

function wordStats(samples, span, word) {
  const frames = samples.slice(span.startIdx, span.endIdx + 1);
  const voiced = frames.filter(isUsable);
  const durationMs = span.endMs - span.startMs;
  const stats = {
    word: word.w,
    syllables: word.syllables || 1,
    weak: !!word.weak,
    tStartMs: Math.round(span.startMs),
    tEndMs: Math.round(span.endMs),
    durationMs: Math.round(durationMs),
    voicedRatio: frames.length ? voiced.length / frames.length : 0,
    pitchAvgHz: null, pitchRangeSt: 0, contour: 'flat', contourDeltaSt: 0,
    resonanceAvg: null, energyAvg: null, articAvg: null,
  };
  if (voiced.length > 0) {
    let hzSum = 0, hzMin = Infinity, hzMax = -Infinity, resSum = 0, articSum = 0, articN = 0;
    for (const f of voiced) {
      hzSum += f.hz;
      if (f.hz < hzMin) hzMin = f.hz;
      if (f.hz > hzMax) hzMax = f.hz;
      resSum += clamp01(Number.isFinite(f.res) ? f.res : 0);
      if (Number.isFinite(f.artic)) { articSum += clamp01(f.artic); articN++; }
    }
    stats.pitchAvgHz = hzSum / voiced.length;
    stats.pitchRangeSt = voiced.length >= 2 ? hzToSt(hzMax) - hzToSt(hzMin) : 0;
    stats.resonanceAvg = resSum / voiced.length;
    stats.articAvg = articN ? articSum / articN : null;
    const c = contourOf(voiced);
    stats.contour = c.contour;
    stats.contourDeltaSt = c.deltaSt;
  }
  let eSum = 0, eN = 0;
  for (const f of frames) {
    if (Number.isFinite(f.energy)) { eSum += f.energy; eN++; }
  }
  stats.energyAvg = eN ? eSum / eN : null;
  return stats;
}

// The [0,1] "did this word do what the phrase trains" metric.
function focusBase(stats, focus) {
  switch (focus) {
    case 'resonance': return stats.resonanceAvg ?? 0;
    case 'intonation': return clamp01(stats.pitchRangeSt / 3.5);
    case 'elongation': return clamp01((stats.durationMs / stats.syllables) / 300);
    case 'articulation': return stats.articAvg != null ? clamp01(stats.articAvg / 0.6) : clamp01(stats.voicedRatio);
    default: return clamp01(stats.pitchRangeSt / 3.5);
  }
}

function scoreWord(stats, word, phrase, expectedMs) {
  const clarity = clamp01(stats.voicedRatio / 0.6);
  let score01 = 0.7 * focusBase(stats, phrase.focus) + 0.3 * clarity;
  // Function words *should* be short and unstressed — grading them like
  // content words would coach robotic over-enunciation.
  if (word.weak) score01 = Math.max(score01, 0.6);
  const score = Math.round(clamp01(score01) * 100);

  let note = '';
  if (stats.voicedRatio < 0.35) note = 'unclear';
  else if (!word.weak && stats.durationMs < 0.45 * expectedMs) note = 'rushed';
  else if (phrase.focus === 'intonation' && !word.weak && stats.contour === 'flat' && stats.pitchRangeSt < 1) note = 'flat';
  else if (score >= 85) note = 'nice';
  return { score, note };
}

function buildContourSeries(samples, maxPoints = CONTOUR_SERIES_MAX_POINTS) {
  if (samples.length === 0) return [];
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const total = Math.max(1, t1 - t0);
  const buckets = Math.min(maxPoints, samples.length);
  const series = [];
  for (let b = 0; b < buckets; b++) {
    const lo = t0 + (total * b) / buckets;
    const hi = t0 + (total * (b + 1)) / buckets;
    let sum = 0, n = 0;
    for (const s of samples) {
      if (s.t >= lo && s.t < hi && isUsable(s)) { sum += s.hz; n++; }
    }
    series.push({ t: Math.round(lo), hz: n ? sum / n : null });
  }
  return series;
}

function buildTakeaway(aligned, words, phrase, contourDirection) {
  if (!aligned) {
    return 'Couldn’t line up the words — overall read below. Crisper gaps between words help.';
  }
  const parts = [];
  const content = words.filter((w) => !w.weak);
  const pool = content.length ? content : words;
  let strong = pool[0], weakest = pool[0];
  for (const w of pool) {
    if (w.score > strong.score) strong = w;
    if (w.score < weakest.score) weakest = w;
  }
  parts.push(`Strongest: “${strong.word}”`);
  if (weakest !== strong && weakest.score < 75) parts.push(`work on “${weakest.word}”`);
  if (phrase.contourHint && contourDirection !== phrase.contourHint) {
    parts.push(phrase.contourHint === 'rise'
      ? 'let the pitch lift at the end'
      : 'let the pitch settle at the end');
  }
  return parts.join(' · ');
}

// ---------- main entry ----------

// Analyze one recorded take of a known phrase.
//   samples: per-frame snapshots { t?, hz, conf, voiced, res, prosody, energy?, artic? }
//   phrase:  { text, words: [{ w, syllables, weak? }], focus, contourHint?, tip? }
// Returns null when the take has no usable voice (mirrors summarizeClipMetrics),
// otherwise { aligned, method, quality, overall, words, contourSeries, takeaway }.
export function analyzePhraseTake(samples, phrase, { frameMs = 12 } = {}) {
  const base = summarizeClipMetrics(samples);
  if (!base) return null;
  const timed = withFrameTimes(samples, frameMs);
  const durationMs = timed.length ? timed[timed.length - 1].t - timed[0].t : 0;

  // Whole-take intonation spread (semitone std-dev over usable frames).
  const stVals = timed.filter(isUsable).map((s) => hzToSt(s.hz));
  let intonationSpreadSt = 0;
  if (stVals.length >= 2) {
    const mean = stVals.reduce((a, b) => a + b, 0) / stVals.length;
    intonationSpreadSt = Math.sqrt(stVals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / stVals.length);
  }

  const chunks = segmentActiveChunks(timed);
  let pauseCount = 0, pauseSum = 0;
  for (let i = 1; i < chunks.length; i++) {
    const gap = chunks[i].startMs - chunks[i - 1].endMs;
    if (gap > PAUSE_MS) { pauseCount++; pauseSum += gap; }
  }

  const phraseWords = Array.isArray(phrase?.words) ? phrase.words : [];
  const alignment = phraseWords.length ? alignWords(timed, chunks, phraseWords) : null;
  const aligned = !!(alignment && alignment.quality >= MIN_ALIGN_QUALITY);

  let words = [];
  if (aligned) {
    const takeMs = alignment.spans[alignment.spans.length - 1].endMs - alignment.spans[0].startMs;
    const S = totalSyllables(phraseWords);
    words = alignment.spans.map((span, i) => {
      const stats = wordStats(timed, span, phraseWords[i]);
      const expectedMs = takeMs * ((phraseWords[i].syllables || 1) / S);
      const { score, note } = scoreWord(stats, phraseWords[i], phrase, expectedMs);
      return { ...stats, score, note };
    });
  }

  // Phrase-final direction: last word's contour when aligned, else the
  // contour of the final 30% of usable frames.
  let contourDirection = 'flat';
  if (aligned && words.length) {
    contourDirection = words[words.length - 1].contour;
  } else {
    const usable = timed.filter(isUsable);
    contourDirection = contourOf(usable.slice(Math.floor(usable.length * 0.7))).contour;
  }

  // Overall score: what the phrase trains (focus), how expressive, how clear.
  const clarity = clamp01(base.voicedRatio / 0.6);
  const expressiveness = clamp01(intonationSpreadSt / 3);
  let focusAvg;
  if (aligned && words.length) {
    const content = words.filter((w) => !w.weak);
    const pool = content.length ? content : words;
    focusAvg = pool.reduce((a, w) => a + w.score, 0) / pool.length / 100;
  } else {
    focusAvg = focusBase({
      resonanceAvg: base.resonanceAvg,
      pitchRangeSt: intonationSpreadSt * 2, // spread→range proxy for unaligned takes
      durationMs, syllables: Math.max(1, totalSyllables(phraseWords)),
      articAvg: null, voicedRatio: base.voicedRatio,
    }, phrase?.focus);
  }
  let score = Math.round(100 * (0.55 * focusAvg + 0.25 * expressiveness + 0.20 * clarity));
  if (phrase?.contourHint && contourDirection === phrase.contourHint) score += 5;
  score = Math.max(0, Math.min(100, score));

  const activeSec = chunks.reduce((n, c) => n + c.durMs, 0) / 1000;
  const overall = {
    ...base,
    durationMs: Math.round(durationMs),
    intonationSpreadSt,
    speakingRateWps: phraseWords.length && activeSec > 0 ? phraseWords.length / activeSec : null,
    pauseCount,
    avgPauseMs: pauseCount ? Math.round(pauseSum / pauseCount) : 0,
    contourDirection,
    score,
  };

  return {
    aligned,
    method: aligned ? alignment.method : null,
    quality: alignment ? alignment.quality : 0,
    overall,
    words,
    contourSeries: buildContourSeries(timed),
    takeaway: buildTakeaway(aligned, words, phrase || {}, contourDirection),
  };
}
