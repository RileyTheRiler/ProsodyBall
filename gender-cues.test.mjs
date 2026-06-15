import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeModalF0Femininity,
  computeSpectralCentroid,
  computeSibilantFemininity,
  computeFormantDispersion,
  dispersionToFemininity,
  dispersionToVtlCm,
  computeCepstrum,
  computeCPP,
  cppToFemininity,
  computeGenderScoreMulti,
  computeGenderScore,
  DEFAULT_GENDER_CUE_WEIGHTS,
} from './dsp-utils.js';

// ---------- Modal / median F0 ----------
test('modal F0: low median reads masculine, high reads feminine', () => {
  assert.ok(computeModalF0Femininity(115) < 0.2);
  assert.ok(computeModalF0Femininity(210) > 0.8);
  assert.ok(Math.abs(computeModalF0Femininity(165) - 0.5) < 0.1);
});
test('modal F0: invalid input is neutral', () => {
  assert.equal(computeModalF0Femininity(0), 0.5);
});

// ---------- Sibilant centroid ----------
test('spectral centroid finds the center of gravity of a band', () => {
  // magnitudes peaked at bin 100 (binHz 50 -> 5000 Hz)
  const mags = new Array(200).fill(0);
  mags[100] = 10;
  assert.equal(computeSpectralCentroid(mags, 50), 5000);
});
test('spectral centroid returns 0 for empty energy', () => {
  assert.equal(computeSpectralCentroid(new Array(50).fill(0), 50), 0);
});
test('sibilant femininity: high centroid -> feminine, low -> masculine', () => {
  assert.ok(computeSibilantFemininity(7500) > 0.7);
  assert.ok(computeSibilantFemininity(4500) < 0.2);
});

// ---------- Formant dispersion / VTL ----------
test('formant dispersion is mean adjacent spacing', () => {
  assert.equal(computeFormantDispersion([500, 1500, 2500]), 1000);
  assert.equal(computeFormantDispersion([700, 1700]), 1000);
});
test('dispersion ignores missing formants', () => {
  assert.equal(computeFormantDispersion([500, 0, 2500]), 2000);
  assert.equal(computeFormantDispersion([0]), 0);
});
test('wide dispersion (short VTL) reads feminine; narrow reads masculine', () => {
  assert.ok(dispersionToFemininity(1250) > 0.8); // short tract
  assert.ok(dispersionToFemininity(880) < 0.2);  // long tract
});
test('VTL estimate: wider spacing -> shorter tract', () => {
  const vtlFem = dispersionToVtlCm(1200);
  const vtlMasc = dispersionToVtlCm(900);
  assert.ok(vtlFem < vtlMasc);
  assert.ok(vtlFem > 10 && vtlFem < 20);
});

// ---------- CPP breathiness ----------
test('CPP: a periodic log-spectrum gives a higher peak than a flat one', () => {
  const M = 256;
  const q0 = 32; // quefrency of the imposed ripple
  const periodic = new Float64Array(M);
  const flat = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    // ripple whose cepstral energy lands near q0
    periodic[k] = Math.cos((Math.PI * k * q0) / (M - 1)) * 5;
    flat[k] = 0;
  }
  const cppPeriodic = computeCPP(computeCepstrum(periodic), q0);
  const cppFlat = computeCPP(computeCepstrum(flat), q0);
  assert.ok(cppPeriodic > cppFlat, `periodic ${cppPeriodic} should exceed flat ${cppFlat}`);
});
test('cppToFemininity inverts: low CPP (breathy) -> feminine', () => {
  assert.ok(cppToFemininity(6) > 0.9);   // breathy
  assert.ok(cppToFemininity(14) < 0.1);  // modal/pressed
});

// ---------- Multi-cue combiner ----------
test('disabled cues are excluded from the blend', () => {
  const { score } = computeGenderScoreMulti({
    cues: { resonance: { value: 1, confidence: 1 }, sibilant: { value: 0, confidence: 1 } },
    enabledMap: { resonance: true }, // sibilant absent => excluded
  });
  assert.ok(score > 0.7, `only resonance should count, got ${score}`);
});
test('empty enabled set returns neutral with max uncertainty', () => {
  const r = computeGenderScoreMulti({ cues: { pitch: { value: 1, confidence: 1 } }, enabledMap: {} });
  assert.equal(r.score, 0.5);
  assert.equal(r.uncertainty, 1);
});
test('cue disagreement raises uncertainty and pulls score toward center', () => {
  const agree = computeGenderScoreMulti({
    cues: { resonance: { value: 0.9, confidence: 1 }, pitchZone: { value: 0.9, confidence: 1 } },
    enabledMap: { resonance: true, pitchZone: true },
  });
  const disagree = computeGenderScoreMulti({
    cues: { resonance: { value: 0.9, confidence: 1 }, pitchZone: { value: 0.1, confidence: 1 } },
    enabledMap: { resonance: true, pitchZone: true },
  });
  assert.ok(disagree.uncertainty > agree.uncertainty);
  assert.ok(Math.abs(disagree.score - 0.5) < Math.abs(agree.score - 0.5));
});
test('low confidence collapses score toward 0.5', () => {
  const { score } = computeGenderScoreMulti({
    cues: { resonance: { value: 1, confidence: 0.05 }, modalF0: { value: 1, confidence: 0.05 } },
    enabledMap: { resonance: true, modalF0: true },
  });
  assert.ok(Math.abs(score - 0.5) < 0.15);
});
test('decisiveness: a confident, agreeing masculine voice leans clearly blue (not stuck near purple)', () => {
  // resonance + modalF0 both clearly masculine and confident -> should reach the blue end,
  // not stall in the purple band the way the pre-tuning conservative collapse did.
  const { score } = computeGenderScoreMulti({
    cues: { resonance: { value: 0.15, confidence: 0.9 }, modalF0: { value: 0.15, confidence: 0.9 } },
    enabledMap: { resonance: true, modalF0: true },
  });
  assert.ok(score < 0.15, `expected clearly masculine/blue, got ${score}`);
});

// ---------- Intonation opt-in behavior (combiner-level) ----------
test('intonation only counts when enabled', () => {
  const off = computeGenderScoreMulti({
    cues: { resonance: { value: 0.5, confidence: 1 }, intonation: { value: 1, confidence: 1 } },
    enabledMap: { resonance: true }, // intonation off
  });
  const on = computeGenderScoreMulti({
    cues: { resonance: { value: 0.5, confidence: 1 }, intonation: { value: 1, confidence: 1 } },
    enabledMap: { resonance: true, intonation: true },
  });
  assert.ok(on.score > off.score, 'enabling intonation should nudge feminine here');
});

// ---------- Backward-compat parity ----------
test('parity: multi (pitch+resonance) agrees in direction with computeGenderScore', () => {
  const masc = computeGenderScoreMulti({
    cues: { pitch: { value: 0.1, confidence: 0.9 }, resonance: { value: 0.15, confidence: 0.9 } },
    enabledMap: { pitch: true, resonance: true },
  });
  const fem = computeGenderScoreMulti({
    cues: { pitch: { value: 0.9, confidence: 0.9 }, resonance: { value: 0.9, confidence: 0.9 } },
    enabledMap: { pitch: true, resonance: true },
  });
  const mascLegacy = computeGenderScore({ pitchHz: 110, resonance: 0.15, pitchConfidence: 0.9, formantConfidence: 0.9 });
  const femLegacy = computeGenderScore({ pitchHz: 220, resonance: 0.9, pitchConfidence: 0.9, formantConfidence: 0.9 });
  assert.ok(masc.score < 0.5 && mascLegacy < 0.5);
  assert.ok(fem.score > 0.5 && femLegacy > 0.5);
});

// ---------- Johnny-Cash regression at the cue level ----------
test('modal F0 + dispersion keep a deep singer masculine despite high instantaneous pitch', () => {
  // High momentary pitch would mislead, but modal (habitual) pitch is low and the tract is long.
  const { score } = computeGenderScoreMulti({
    cues: {
      modalF0: { value: computeModalF0Femininity(120), confidence: 0.9 },
      dispersion: { value: dispersionToFemininity(880), confidence: 0.9 },
      resonance: { value: 0.2, confidence: 0.9 },
    },
    enabledMap: { modalF0: true, dispersion: true, resonance: true },
  });
  assert.ok(score < 0.4, `expected masculine, got ${score}`);
});

test('DEFAULT_GENDER_CUE_WEIGHTS has resonance and pitchZone as top cues', () => {
  const w = DEFAULT_GENDER_CUE_WEIGHTS;
  assert.ok(w.resonance >= w.pitchZone);
  assert.ok(w.pitchZone > w.weight);
});
