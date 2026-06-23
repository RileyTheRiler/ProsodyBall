import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFormantDispersion, dispersionToVtlCm, computeSpectralCentroid,
  computeModalF0Femininity, dispersionToFemininity, computeSibilantFemininity,
  computeGenderScore, genderScoreToHue, computeCepstrum, computeCPP,
} from './dsp-utils.js';

// ====== CANONICAL FEATURE GOLDEN VECTORS ======
// Frozen input→output pairs for the pure feature math the Kotlin/C++ ports reimplement
// (docs/DSP_CONTRACT.md Layer A). This is the JS leg of the cross-port golden tests: it
// catches *semantic* drift in the reference implementation that constant codegen cannot.
// The SAME vectors are the target the ports must reproduce — within a documented tolerance
// (tight here for JS↔JS; the ports, esp. ESP32 fixed-point, use wider per-field tolerances).
// To intentionally change a canonical definition, recompute and update the golden below.

const TOL = 1e-5;
function near(actual, expected, tol = TOL) {
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected} ±${tol}, got ${actual}`);
}

test('golden: formant dispersion (ΔF) and apparent vocal-tract length', () => {
  near(computeFormantDispersion([500, 1500, 2500]), 1000);   // ~male spacing
  near(computeFormantDispersion([650, 1800, 2900]), 1125);   // wider → more feminine
  near(computeFormantDispersion([500]), 0);                  // <2 valid formants
  near(computeFormantDispersion([500, 0, 2500]), 2000);      // zeros filtered out
  near(dispersionToVtlCm(1000), 17.5);                       // male ≈ 17.5 cm
  near(dispersionToVtlCm(1250), 14.0);                       // female ≈ 14 cm
});

test('golden: spectral centroid (full band and band-limited)', () => {
  const mags = new Array(50).fill(0);
  mags[10] = 2; mags[20] = 1;                                // 1000 Hz (×2), 2000 Hz (×1)
  near(computeSpectralCentroid(mags, 100), 1333.333333, 1e-4);
  near(computeSpectralCentroid(mags, 100, 500, 1500), 1000); // only the 1000 Hz bin in band
});

test('golden: femininity cue mappings', () => {
  near(computeModalF0Femininity(165), 0.5);                  // androgynous midpoint
  near(dispersionToFemininity(1050), 0.5);                   // halfway 900..1200
  near(computeSibilantFemininity(6000), 0.444444, 1e-5);
});

test('golden: perceived-gender score collapses toward 0.5 when unconfident', () => {
  near(computeGenderScore({ pitchHz: 200, resonance: 0.7, pitchConfidence: 0.9, formantConfidence: 0.8 }), 0.732563, 1e-5);
  near(computeGenderScore({ pitchHz: 110, resonance: 0.2, pitchConfidence: 0.9, formantConfidence: 0.8 }), 0.141047, 1e-5);
  near(computeGenderScore({ pitchHz: 200, resonance: 0.7, pitchConfidence: 0.05, formantConfidence: 0.05 }), 0.512814, 1e-5);
  near(genderScoreToHue(0), 210);                            // blue (masc)
  near(genderScoreToHue(1), 340);                            // pink (fem)
});

test('golden: cepstrum + cepstral peak prominence', () => {
  const logMag = Array.from({ length: 64 }, (_, k) => 1 + 0.5 * Math.cos(2 * Math.PI * k / 8));
  const cep = computeCepstrum(logMag, 32);
  near(cep[1], 0.006803, 1e-5);
  near(cep[8], -0.009256, 1e-5);
  near(computeCPP(cep, 8), 0.001466, 1e-5);
});
