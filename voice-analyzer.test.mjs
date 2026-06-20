// Headless tests for the extracted VoiceAnalyzer DSP core.
// These drive the pure-math methods (no DOM / no real AudioContext) with
// synthetic buffers so the analysis pipeline has real ground-truth coverage,
// not just drift detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAnalyzer } from './voice-analyzer.js';

const SAMPLE_RATE = 44100;
const FRAME = 4096;

// Build an analyzer wired up just enough for detectPitch() to run in Node.
function makeAnalyzer() {
  const va = new VoiceAnalyzer();
  va.audioCtx = { sampleRate: SAMPLE_RATE };
  va.timeDomainData = new Float32Array(FRAME);
  return va;
}

// Fill the analyzer's time-domain buffer with a tone (optionally with harmonics
// to mimic a voiced glottal source, which stresses YIN's octave handling).
function fillTone(va, hz, { amp = 0.5, harmonics = 1 } = {}) {
  const buf = va.timeDomainData;
  for (let i = 0; i < buf.length; i++) {
    let s = 0;
    for (let h = 1; h <= harmonics; h++) {
      s += (amp / h) * Math.sin((2 * Math.PI * hz * h * i) / SAMPLE_RATE);
    }
    buf[i] = s;
  }
}

test('detectPitch recovers a pure sine within 1.5% across the voice range', () => {
  for (const hz of [110, 147, 196, 220, 294, 330, 392]) {
    const va = makeAnalyzer();
    fillTone(va, hz);
    const detected = va.detectPitch();
    const errPct = Math.abs(detected - hz) / hz;
    assert.ok(
      errPct < 0.015,
      `expected ~${hz}Hz, got ${detected.toFixed(2)}Hz (err ${(errPct * 100).toFixed(2)}%)`
    );
  }
});

test('detectPitch does not make octave errors on a harmonic-rich tone', () => {
  // A buzzy tone with many harmonics is where naive autocorrelation latches
  // onto 2x the fundamental. correctOctaveError() should keep us on F0.
  for (const hz of [98, 123, 165]) {
    const va = makeAnalyzer();
    fillTone(va, hz, { harmonics: 8 });
    const detected = va.detectPitch();
    const ratio = detected / hz;
    assert.ok(
      Math.abs(ratio - 1) < 0.05,
      `octave error at ${hz}Hz: detected ${detected.toFixed(2)}Hz (ratio ${ratio.toFixed(3)})`
    );
  }
});

test('detectPitch returns 0 on silence and sets low confidence', () => {
  const va = makeAnalyzer();
  // timeDomainData is all zeros → below the silence gate.
  const detected = va.detectPitch();
  assert.equal(detected, 0);
});

test('detectPitch reports high confidence on a clean tone', () => {
  const va = makeAnalyzer();
  fillTone(va, 220);
  va.detectPitch();
  assert.ok(
    va.pitchConfidence > 0.5,
    `clean tone should be confident, got ${va.pitchConfidence.toFixed(2)}`
  );
});
