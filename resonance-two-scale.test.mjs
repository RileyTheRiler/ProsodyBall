// Phase 4 — two scales and real calibration, at the analyzer level.
// docs/RESONANCE_REDESIGN.md §4 (three values, never collapsed), §3.5 (migration), §6 (the user
// still sees one ring), §7 (the product calls).
//
// What this pins, in one line each:
//   - the split is wired the right way round: the perception model reads ABSOLUTE, the ball and
//     the haptics read CONTROL, and neither can quietly become the other;
//   - a calibrated span moves control and does NOT move absolute;
//   - a frame with no reading has no value on either scale — null, never 0;
//   - a reading knows its version and its scale, and an aggregate refuses to mix them;
//   - the rhotic-capable formant assignment is measured, exposed, and OFF.
//
// The numbers behind all of it — the two speakers, the mis-fire rate, the yield and swing cost,
// the budget — live in tools/resonance-two-scale.mjs and tools/rhotic-assignment.mjs, because
// they take minutes and because a report that has to be READ is not the same artefact as a test
// that has to PASS. That separation is Phase 3's and is kept.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MockAudioContext } from './tools/run-eval-harness.mjs';
import { synthVowel } from './tools/synth-vowel.mjs';
import {
  RESONANCE_METRIC_VERSION, RESONANCE_SCALE_ABSOLUTE, RESONANCE_SCALE_CONTROL,
  RESONANCE_POPULATION_SPAN, resonanceControl, aggregateReadings,
} from './resonance-metric.js';

const { VoiceAnalyzer } = await import('./app.js');

const SAMPLE_RATE = 44100;
const WINDOW = 4096;
const HOP = Math.round(SAMPLE_RATE / 60);
const DT = HOP / SAMPLE_RATE;
const BASE_FORMANTS = [570, 1710, 2850, 3990];

async function newAnalyzer() {
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = SAMPLE_RATE;
  a.isCalibrated = true;
  a.noiseFloor = 0.005;
  a.hfNoiseFloor = 0.001;
  a.micTiltBaselineDb = 0;
  a.resonanceMethod = 'lpc';
  return a;
}

function drive(a, signal) {
  for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
    a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
    a.update(DT);
  }
}

// ---------------------------------------------------------------------------
// The split.
// ---------------------------------------------------------------------------

test('§4: an uncalibrated analyzer is on the published population span, and control is defined', async () => {
  const a = await newAnalyzer();
  assert.equal(a.resonanceProfileV2, null);
  assert.equal(a.resonanceSpan, RESONANCE_POPULATION_SPAN);
  drive(a, synthVowel({ formants: BASE_FORMANTS }));
  assert.ok(a.resonancePresent, 'a clean held vowel produced no reading');
  assert.ok(a.resonanceAbsolute > 0);
  // Control is DEFINED on frame one — the ball works out of the box — and it is exactly the
  // population mapping of absolute, not a second measurement.
  assert.equal(a.resonanceControl, resonanceControl(a.resonanceAbsolute, RESONANCE_POPULATION_SPAN));
});

test('§4: calibrating moves CONTROL and leaves ABSOLUTE frame-for-frame identical', async () => {
  // Two analyzers driven over the SAME frames, one of which is calibrated half way through.
  // Comparing an analyzer against its own earlier self would compare two different frames — the
  // pooling window and the Kalman filters are still evolving on a held vowel — so the claim
  // "the absolute axis did not move" needs a twin, not a memory.
  const signal = synthVowel({ formants: BASE_FORMANTS, seconds: 3 });
  const plain = await newAnalyzer();
  const calibrated = await newAnalyzer();

  const frames = [];
  for (let i = 0; i + WINDOW <= signal.length; i += HOP) frames.push(signal.subarray(i, i + WINDOW));
  const half = Math.floor(frames.length / 2);

  let applied = null;
  const absDiffs = [];
  const controlPairs = [];
  for (let k = 0; k < frames.length; k++) {
    for (const a of [plain, calibrated]) { a.audioCtx._currentChunk = frames[k]; a.update(DT); }
    if (k === half) {
      const abs = calibrated.resonanceAbsolute;
      assert.ok(abs > 0, 'no reading at the calibration point');
      applied = calibrated.applyVowelSetCalibration({
        postures: {
          habitual: Array(10).fill(abs),
          darker: Array(10).fill(abs - 0.10),
          brighter: Array(10).fill(abs + 0.02),
        },
      });
      assert.ok(applied.ok, `calibration declined: ${applied.reason}`);
      continue;
    }
    if (k <= half) continue;
    if (plain.resonanceAbsolute == null || calibrated.resonanceAbsolute == null) continue;
    absDiffs.push(Math.abs(plain.resonanceAbsolute - calibrated.resonanceAbsolute));
    controlPairs.push([plain.resonanceControl, calibrated.resonanceControl]);
  }

  assert.ok(absDiffs.length > 10, `only ${absDiffs.length} comparable frames after calibration`);
  assert.equal(Math.max(...absDiffs), 0,
    'the absolute axis moved when a personal span was applied — it is not absolute');
  const controlGap = Math.min(...controlPairs.map(([p, c]) => Math.abs(p - c)));
  assert.ok(controlGap > 0.05,
    `control barely moved on the calibrated twin (closest frame ${controlGap.toFixed(3)}) — it may not be reading the span`);
  assert.equal(calibrated.resonanceControl,
    resonanceControl(calibrated.resonanceAbsolute, calibrated.resonanceSpan));
});

test('§4: the ball reads control; metrics.resonance is the displayed number', async () => {
  const a = await newAnalyzer();
  drive(a, synthVowel({ formants: BASE_FORMANTS }));
  assert.equal(a.metrics.resonance, a.resonanceControl);
  // And it is not v1. If these ever coincide by accident the assertion below still holds,
  // because the point is that the field is not WIRED to v1.
  assert.notEqual(a.metrics.resonance, a.smoothResonance);
});

test('§3.5 + §4: v1 stays COMPUTABLE after retiring from the display', async () => {
  const a = await newAnalyzer();
  drive(a, synthVowel({ formants: BASE_FORMANTS }));
  // Migration has to be able to compare the two, so the arithmetic stays. What retires is the
  // display, and every display path is asserted above and in the app to read control.
  assert.ok(a.smoothResonance > 0 && a.smoothResonance <= 1);
  assert.ok(a.formantDispersionHz > 0, 'v1\'s ΔF stopped being computed');
});

// ---------------------------------------------------------------------------
// Absence.
// ---------------------------------------------------------------------------

test('§5: a frame with no reading is null on BOTH scales, and 0 survives as a real value', async () => {
  const a = await newAnalyzer();
  drive(a, synthVowel({ formants: BASE_FORMANTS }));
  assert.ok(a.resonancePresent);

  const quiet = new Float32Array(WINDOW);
  for (let k = 0; k < 200; k++) { a.audioCtx._currentChunk = quiet; a.update(DT); }
  assert.equal(a.resonanceAbsolute, null);
  assert.equal(a.resonanceControl, null);
  assert.equal(a.resonancePresent, false);
  assert.equal(a.metrics.resonance, null, 'the displayed bus reported 0 for a frame with no reading');

  // 0 is a real position on this axis — "as long a tract as the span goes" — and must not be
  // confusable with absence. This is the whole reason the API is nullable rather than zeroed.
  assert.equal(resonanceControl(0, { min: 0, max: 1 }), 0);
  assert.equal(resonanceControl(null, { min: 0, max: 1 }), null);
});

test('§5: currentResonanceReading is absent on a suppressed frame and versioned otherwise', async () => {
  const a = await newAnalyzer();
  drive(a, synthVowel({ formants: BASE_FORMANTS }));
  const control = a.currentResonanceReading(RESONANCE_SCALE_CONTROL);
  const absolute = a.currentResonanceReading(RESONANCE_SCALE_ABSOLUTE);
  assert.equal(control.metricVersion, RESONANCE_METRIC_VERSION);
  assert.equal(control.scale, RESONANCE_SCALE_CONTROL);
  assert.equal(control.spanId, a.resonanceSpanId);
  // An absolute reading carries no span, because it is not normalised against one — that is the
  // property that makes it comparable across speakers and sessions.
  assert.equal(absolute.spanId, null);
  assert.equal(absolute.scale, RESONANCE_SCALE_ABSOLUTE);

  const quiet = new Float32Array(WINDOW);
  for (let k = 0; k < 200; k++) { a.audioCtx._currentChunk = quiet; a.update(DT); }
  assert.equal(a.currentResonanceReading(RESONANCE_SCALE_CONTROL), null);
  assert.equal(a.currentResonanceReading(RESONANCE_SCALE_ABSOLUTE), null);
});

test('§3.5: readings from two spans do not average together', async () => {
  const a = await newAnalyzer();
  drive(a, synthVowel({ formants: BASE_FORMANTS }));
  const before = a.currentResonanceReading(RESONANCE_SCALE_CONTROL);
  a.applyVowelSetCalibration({
    postures: {
      habitual: Array(10).fill(a.resonanceAbsolute),
      darker: Array(10).fill(a.resonanceAbsolute - 0.10),
      brighter: Array(10).fill(a.resonanceAbsolute + 0.02),
    },
  });
  drive(a, synthVowel({ formants: BASE_FORMANTS }));
  const after = a.currentResonanceReading(RESONANCE_SCALE_CONTROL);
  assert.notEqual(before.spanId, after.spanId);

  const agg = aggregateReadings([before, after], { spanId: after.spanId });
  assert.equal(agg.n, 1);
  assert.equal(agg.rejected, 1);
  // Absolute readings, by contrast, are comparable across the recalibration — which is exactly
  // why session statistics read that axis.
  const absAgg = aggregateReadings(
    [a.currentResonanceReading(RESONANCE_SCALE_ABSOLUTE), a.currentResonanceReading(RESONANCE_SCALE_ABSOLUTE)],
    { scale: RESONANCE_SCALE_ABSOLUTE });
  assert.equal(absAgg.n, 2);
});

// ---------------------------------------------------------------------------
// The formant assignment (§5 Phase 4, item a).
// ---------------------------------------------------------------------------

test('the rhotic-capable assignment is measured, exposed, and OFF', async () => {
  const a = await newAnalyzer();
  assert.equal(a.canonicalAssignment, 'standard',
    'the widened F3 slot is shipping — tools/rhotic-assignment.mjs must show it clears its criteria first');
  drive(a, synthVowel({ formants: BASE_FORMANTS }));
  // Still computed on every frame, at no extra LPC solve, so the report can be re-run at any
  // time without a code change. Phase 3's pattern, kept.
  const canonical = a._lpcAtCeiling(a.lpcCeilingHz || 5512.5);
  assert.ok(Array.isArray(canonical.measuredRhotic) && canonical.measuredRhotic.length === 4);
});

test('the assignment switch changes the measurement and nothing else about the pipeline', async () => {
  // Not a claim that the widened slot is good — that is the report's job. This pins that the
  // switch is a real switch, so a future run of the report is measuring something.
  const signal = synthVowel({ f0: 110, formants: [490, 1350, 1690, 2457] });   // P&B male /ɝ/
  const run = async (assignment) => {
    const a = await newAnalyzer();
    a.canonicalAssignment = assignment;
    let frames = 0;
    for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
      a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
      a.update(DT);
      frames++;
    }
    return { f3: a.canonicalF3, solvesPerFrame: a._lpcSolveCount / frames };
  };
  const std = await run('standard');
  const rho = await run('rhotic');
  assert.ok(rho.f3 < std.f3 || std.f3 === 0,
    `the widened slot did not admit a lower F3 (${std.f3.toFixed(0)} -> ${rho.f3.toFixed(0)})`);
  // And it costs no extra solve: it is a second pass over poles the same solve already produced.
  assert.ok(rho.solvesPerFrame <= 1.001, `${rho.solvesPerFrame.toFixed(3)} solves/frame`);
});

// ---------------------------------------------------------------------------
// The across-vowel allowance — the bug a user hit by taking the app's own advice.
// ---------------------------------------------------------------------------
//
// Reported: after running the guided calibration, the voice-map firefly slammed into the left
// and right edges. Root cause: spanFromPostures sized the span from the POSTURE excursion and
// padded it 5%, while the value poured through it also carries the speaker's VOWEL excursion,
// which is the larger of the two. RESONANCE_POPULATION_SPAN had always carried an allowance for
// exactly that; the personal span had none, so calibrating made the display worse.

// The five holds the guided vowel set asks for, as frame arrays the calibration replays.
function vowelSetSegments(scale = 1, f0 = 120) {
  return [[270, 2290, 3010], [530, 1840, 2480], [730, 1090, 2440], [440, 1020, 2240], [300, 870, 2240]]
    .map((formants) => {
      const sig = synthVowel({ f0, formants: formants.map((x) => x * scale), seconds: 1.6, sampleRate: SAMPLE_RATE });
      const frames = [];
      for (let i = 0; i + WINDOW <= sig.length; i += HOP) frames.push(sig.subarray(i, i + WINDOW));
      return frames;
    });
}

test("the calibration measures the speaker's OWN across-vowel excursion from the holds it already takes", async () => {
  const a = await newAnalyzer();
  const segments = vowelSetSegments();
  a.calibrateLpcCeiling(segments);           // must come first: the excursion is measured at the chosen ceiling
  const ex = a.measureVowelSetExcursion(segments);
  assert.ok(ex, 'the excursion must be measurable from the guided vowel set');
  assert.equal(ex.vowels, 5, 'every hold should contribute');
  // ~14.5 points for this speaker. Asserted as a band, not a point: it is a measurement through
  // the real estimator, and pinning it exactly would make the test about the estimator's noise.
  assert.ok(ex.excursion > 0.10 && ex.excursion < 0.20,
    `across-vowel excursion = ${(100 * ex.excursion).toFixed(1)} pts`);
  // It is a property of the SPEAKER, so a different tract must give a different number.
  const b = await newAnalyzer();
  const bigger = vowelSetSegments(1.15);
  b.calibrateLpcCeiling(bigger);
  const exB = b.measureVowelSetExcursion(bigger);
  assert.ok(exB, 'a shorter tract must also measure');
  assert.ok(Math.abs(exB.excursion - ex.excursion) > 1e-6, 'a different tract, a different excursion');
});

test('THE REGRESSION, end to end: a calibrated span must not rail on the speaker\'s own vowels', async () => {
  const a = await newAnalyzer();
  const segments = vowelSetSegments();
  a.calibrateLpcCeiling(segments);
  const ex = a.measureVowelSetExcursion(segments);
  const mid = (Math.max(...ex.perVowel) + Math.min(...ex.perVowel)) / 2;
  const postureSpread = 0.06;                 // a GAVT-sized deliberate posture change
  const sample = (v) => new Array(10).fill(v);
  const applied = a.applyVowelSetCalibration({
    postures: {
      darker: sample(mid - postureSpread / 2),
      brighter: sample(mid + postureSpread / 2),
      habitual: sample(mid),
    },
    vowelExcursion: ex.excursion,
  });
  assert.ok(applied.ok, `calibration failed: ${applied.reason}`);
  assert.equal(applied.span.vowelAllowanceSource, 'measured');

  // Every vowel this speaker actually produced must land strictly inside the meter. Before the
  // allowance, three of these five read exactly 0.00 or 1.00.
  for (const [i, absolute] of ex.perVowel.entries()) {
    const c = resonanceControl(absolute, a.resonanceSpan);
    assert.ok(c > 0 && c < 1, `vowel ${i} railed at ${c.toFixed(2)}`);
  }
  // And the axis must not be flattened into uselessness by the fix, which is the opposite
  // failure: a deliberate posture change still has to move the ball visibly.
  const travel = resonanceControl(mid + postureSpread / 2, a.resonanceSpan)
    - resonanceControl(mid - postureSpread / 2, a.resonanceSpan);
  assert.ok(travel > 0.15, `a deliberate posture change moves only ${(100 * travel).toFixed(0)}% of the meter`);
});

test('a failed excursion measurement falls back to the published allowance, never to none', async () => {
  const a = await newAnalyzer();
  // Silence yields no valid frames, so there is nothing to measure.
  const silence = [new Array(20).fill(new Float32Array(WINDOW))];
  assert.equal(a.measureVowelSetExcursion(silence), null);
  assert.equal(a.measureVowelSetExcursion([]), null);
  assert.equal(a.measureVowelSetExcursion(null), null);
  // With no measurement the span still gets the population span's own allowance — the fallback
  // is a worse number than the speaker's own, but it is never zero, because zero is the bug.
  const sample = (v) => new Array(10).fill(v);
  const applied = a.applyVowelSetCalibration({
    postures: { darker: sample(0.44), brighter: sample(0.50), habitual: sample(0.47) },
    vowelExcursion: null,
  });
  assert.ok(applied.ok);
  assert.equal(applied.span.vowelAllowanceSource, 'published');
  assert.ok(applied.span.max - applied.span.min > 0.13, `width ${applied.span.max - applied.span.min}`);
});
