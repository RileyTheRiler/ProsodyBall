// Headless tests for the extracted VoiceAnalyzer DSP core.
// These drive the pure-math methods (no DOM / no real AudioContext) with
// synthetic buffers so the analysis pipeline has real ground-truth coverage,
// not just drift detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAnalyzer } from './voice-analyzer.js';
import { synthVowel, magnitudeSpectrumDb, VOWELS } from './tools/audio-synth.mjs';

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

// Ground-truth formant accuracy for the default (LPC) method. Drives the real
// estimator with synthetic vowels whose F1/F2/F3 are known. This is what makes
// 'lpc' a defensible default (see tools/eval-formant-methods.mjs for the full
// cross-method comparison).
function makeVowelAnalyzer(vowel) {
  const time = synthVowel({ ...vowel, sampleRate: SAMPLE_RATE, length: FRAME });
  const va = new VoiceAnalyzer();
  va.audioCtx = { sampleRate: SAMPLE_RATE };
  va.analyserFormant = { fftSize: FRAME };
  va.timeDomainData = time;
  va.formantFreqData = magnitudeSpectrumDb(time, FRAME);
  va.pitchConfidence = 1;
  va.vowelLikelihood = 1;
  va.isCalibrated = false;
  va.noiseSpectralProfile = null;
  return va;
}

test('LPC recovers known F1/F2 for synthetic vowels within 80 Hz', () => {
  for (const [name, vowel] of Object.entries(VOWELS)) {
    const va = makeVowelAnalyzer(vowel);
    const { f1, f2 } = va._resonanceLPC();
    const trueF1 = vowel.formants[0].f;
    const trueF2 = vowel.formants[1].f;
    assert.ok(
      Math.abs(f1 - trueF1) < 80,
      `/${name}/ F1: expected ~${trueF1}Hz, got ${f1.toFixed(0)}Hz`
    );
    assert.ok(
      Math.abs(f2 - trueF2) < 80,
      `/${name}/ F2: expected ~${trueF2}Hz, got ${f2.toFixed(0)}Hz`
    );
  }
});

test('default resonance method is the empirically-best estimator (lpc)', () => {
  assert.equal(new VoiceAnalyzer().resonanceMethod, 'lpc');
});
