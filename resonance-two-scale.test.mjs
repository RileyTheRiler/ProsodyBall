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
