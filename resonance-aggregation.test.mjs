// The two aggregation modes (docs/RESONANCE_REDESIGN.md §5, §2.9) as pure arithmetic.
//
// tools/resonance-aggregation.mjs measures them end-to-end on a hold-plus-speech clip through
// the real VoiceAnalyzer; this pins the behaviour underneath that, where it can be stated
// exactly rather than measured. Two things it has to guarantee:
//
//   1. Exercise mode rewards duration and speech mode does not. That is the entire distinction
//      and it should be visible on four hand-written frames, not only on a 9-second clip.
//   2. The streaming aggregator a live session uses and the array functions a fixture report
//      uses produce THE SAME NUMBERS. A session summary and a benchmark disagreeing about the
//      same stream is exactly the semantic drift docs/DSP_CONTRACT.md exists to fence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateExercise, aggregateSpeech, aggregateBothModes, findVowelNuclei,
  nucleusFromRun, breaksNucleus, ResonanceAggregator,
} from './dsp-utils.js';

// A run of `n` frames of one vowel at one value, laid down consecutively.
function run(vowel, value, n, startIndex = 0, weight = 1) {
  return Array.from({ length: n }, (_, k) => ({ value, weight, vowel, index: startIndex + k }));
}

test('exercise mode rewards a long hold; speech mode gives it one vote', () => {
  // 100 frames of a held /i/ at 1.20, then five short /ʌ/ nuclei at 1.00. A speaker who holds
  // a bright target for 1.7 s and then talks normally.
  const hold = run('i', 1.20, 100, 0);
  const speech = [0, 1, 2, 3, 4].flatMap((k) => run('ʌ', 1.00, 5, 200 + k * 10));
  const samples = [...hold, ...speech];

  const { exercise, speech: sp } = aggregateBothModes(samples);
  // Exercise: 100 of 125 frames are the hold, so it dominates — which is correct, holding the
  // target IS the exercise.
  assert.ok(exercise.value > 1.15, `exercise = ${exercise.value.toFixed(4)}`);
  // Speech: six nuclei, one of them the hold. 1.20 once + 1.00 five times = 1.0333.
  assert.equal(sp.nuclei, 6);
  assert.ok(Math.abs(sp.value - (1.20 + 5 * 1.00) / 6) < 1e-9, `speech = ${sp.value.toFixed(4)}`);
  // The point: they disagree, and in the direction the design intends.
  assert.ok(exercise.value - sp.value > 0.1,
    `exercise ${exercise.value.toFixed(3)} vs speech ${sp.value.toFixed(3)}`);
  // And a hold twice as long moves exercise mode further while leaving speech mode alone.
  const longer = aggregateBothModes([...run('i', 1.20, 200, 0), ...speech]);
  assert.ok(longer.exercise.value > exercise.value);
  assert.ok(Math.abs(longer.speech.value - sp.value) < 1e-9, 'duration must not move speech mode');
});

test('a nucleus ends at a vowel change, at an abstention, or at a gap in the frame index', () => {
  // Vowel change.
  assert.deepEqual(findVowelNuclei([...run('i', 1, 5, 0), ...run('u', 2, 5, 5)]).map((n) => n.vowel),
    ['i', 'u']);
  // Abstention in the middle: two nuclei, not one.
  const withGap = [...run('i', 1, 4, 0), { value: 1, weight: 1, vowel: null, index: 4 }, ...run('i', 1, 4, 5)];
  assert.equal(findVowelNuclei(withGap).length, 2);
  // A gap in the index — frames the caller never submitted, i.e. frames with no vowel in them.
  assert.equal(findVowelNuclei([...run('i', 1, 4, 0), ...run('i', 1, 4, 50)]).length, 2);
  // Runs shorter than minFrames are dropped rather than admitted as noisy one-frame nuclei.
  // This is §6's actual defence: a single frame thrown onto a neighbouring vowel by estimator
  // noise never becomes a nucleus, it breaks the run.
  assert.equal(findVowelNuclei(run('i', 1, 2, 0)).length, 0);
  assert.equal(findVowelNuclei(run('i', 1, 3, 0)).length, 1);
  assert.equal(nucleusFromRun(run('i', 1, 2, 0)), null);
  assert.ok(breaksNucleus({ vowel: 'i', index: 3 }, { vowel: 'u', index: 4 }));
  assert.ok(breaksNucleus({ vowel: 'i', index: 3 }, { vowel: 'i', index: 9 }));
  assert.ok(!breaksNucleus({ vowel: 'i', index: 3 }, { vowel: 'i', index: 4 }));
  assert.ok(!breaksNucleus(null, { vowel: 'i', index: 0 }));
});

test('a nucleus takes the median, so its onset and offset frames cannot drag it', () => {
  // A vowel whose first and last frames are transitions at wildly wrong values.
  const nucleus = [
    { value: 5.0, weight: 1, vowel: 'i', index: 0 },
    ...run('i', 1.0, 7, 1),
    { value: 0.1, weight: 1, vowel: 'i', index: 8 },
  ];
  assert.equal(findVowelNuclei(nucleus)[0].value, 1.0);
  // A mean would have been dragged to ~1.4.
  assert.ok(aggregateExercise(nucleus).value > 1.3);
});

test('the streaming aggregator matches the array functions frame for frame', () => {
  // The guarantee that a live session summary and a fixture report describe the same stream.
  const stream = [
    ...run('i', 1.20, 40, 0, 0.9),
    { value: 0.8, weight: 0.4, vowel: null, index: 40 },     // an abstained frame
    ...run('ʌ', 0.95, 12, 41, 0.6),
    ...run('ɛ', 1.05, 3, 53, 0.5),
    ...run('u', 0.90, 2, 56, 0.5),                            // too short to be a nucleus
    ...run('ɪ', 1.10, 20, 100, 0.7),                          // after an index gap
  ];
  const agg = new ResonanceAggregator();
  for (const s of stream) agg.push(s);
  const arrayEx = aggregateExercise(stream);
  const arraySp = aggregateSpeech(stream);
  assert.ok(Math.abs(agg.exercise().value - arrayEx.value) < 1e-12,
    `streaming ${agg.exercise().value} vs array ${arrayEx.value}`);
  assert.equal(agg.exercise().n, arrayEx.n);
  assert.ok(Math.abs(agg.speech().value - arraySp.value) < 1e-12,
    `streaming ${agg.speech().value} vs array ${arraySp.value}`);
  assert.equal(agg.speech().nuclei, arraySp.nuclei);
  // Four nuclei: the hold, the /ʌ/, the /ɛ/, the /ɪ/. The two-frame /u/ is not one.
  assert.equal(arraySp.nuclei, 4);

  // Reading the speech value must not close the open nucleus, and must not double-count it on
  // a second read either — a session summary can be rendered mid-phonation, repeatedly.
  const first = agg.speech().value;
  assert.equal(agg.speech().value, first);
  agg.push({ value: 1.10, weight: 0.7, vowel: 'ɪ', index: 120 });
  assert.equal(agg.speech().nuclei, 4, 'a continuing nucleus is still one nucleus');
});

test('the aggregators refuse to invent a reading', () => {
  for (const empty of [[], null, undefined, [null, undefined]]) {
    assert.equal(aggregateExercise(empty).value, 0);
    assert.equal(aggregateSpeech(empty).value, 0);
  }
  // A frame with no reading (value 0 = "no f2Position this frame") contributes to neither, and
  // closes any open nucleus rather than being averaged in as a zero.
  const withHoles = [...run('i', 1.2, 4, 0), { value: 0, weight: 1, vowel: 'i', index: 4 }, ...run('i', 1.2, 4, 5)];
  assert.equal(aggregateExercise(withHoles).n, 8);
  assert.equal(aggregateSpeech(withHoles).nuclei, 2);
  // Zero-weight frames dilute nothing.
  assert.equal(aggregateExercise(run('i', 1.2, 4, 0, 0)).value, 0);

  const agg = new ResonanceAggregator();
  assert.equal(agg.exercise().value, 0);
  assert.equal(agg.speech().value, 0);
  agg.push(run('i', 1.2, 1, 0)[0]);
  agg.reset();
  assert.equal(agg.exercise().value, 0);
  assert.equal(agg.speech().nuclei, 0);
});
