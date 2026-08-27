import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFormantDispersion, fitFormantDispersion, dispersionToVtlCm, computeSpectralCentroid,
  computeModalF0Femininity, dispersionToFemininity, computeSibilantFemininity,
  computeGenderScore, genderScoreToHue, computeCepstrum, computeCPP,
  fitFormantScale, formantPatternResiduals, residualScaleFactor, resonanceAbsoluteV2,
  FORMANT_SCALE_WEIGHTS, FORMANT_SCALE_CV, FORMANT_SCALE_CENTRE_HZ,
  RESONANCE_V2_REFERENCE_DELTA_F_HZ, poolFormantScale,
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
  // Ideal uniform-tube series: the least-squares fit and the old mean-adjacent-spacing
  // definition agree exactly, so this anchor is unchanged.
  near(computeFormantDispersion([500, 1500, 2500]), 1000);   // ~male spacing
  // Rebaselined from 1125. The old estimator was (F3-F1)/2, which discards F2 entirely; the
  // fit uses all three, and these formants sit slightly above the tube series F2 implies.
  near(computeFormantDispersion([650, 1800, 2900]), 10275 / 8.75); // wider → more feminine
  near(computeFormantDispersion([500]), 0);                  // <2 measured formants → no fit
  // A missing formant is a missing SLOT, not a shorter list. Rebaselined from 2000, which was
  // the bug: compacting [F1, —, F3] treated F1 and F3 as adjacent and doubled ΔF, halving the
  // apparent tract length and pinning resonance at "maximally feminine" off one dropout.
  near(computeFormantDispersion([500, 0, 2500]), 1000);      // F2 dropped, F1/F3 keep their slots
  near(computeFormantDispersion([500, 1500, 0]), 1000);      // F3 dropped
  near(computeFormantDispersion([0, 1500, 2500]), 1000);     // F1 dropped
  near(dispersionToVtlCm(1000), 17.5);                       // 17.5 cm: longer tract, darker
  near(dispersionToVtlCm(1250), 14.0);                       // 14.0 cm: shorter tract, brighter
});

test('golden: dispersion fit quality separates a tube-like frame from a scrambled one', () => {
  const clean = fitFormantDispersion([500, 1500, 2500]);
  assert.equal(clean.n, 3);
  near(clean.residualHz, 0);
  near(clean.fitQuality, 1);
  // Formants that do not lie on any uniform-tube series: the ΔF they imply is meaningless,
  // and fitQuality is what lets callers discount it instead of trusting it equally.
  const scrambled = fitFormantDispersion([900, 1000, 3800]);
  assert.ok(scrambled.fitQuality < 0.5,
    `expected a poor fit, got ${scrambled.fitQuality} (residual ${scrambled.residualHz})`);
});

// ====== SCALE / PATTERN SPLIT — the Phase 6 cross-port vectors =========================
// docs/RESONANCE_REDESIGN.md. These are the vectors hardware/twatch_voxball/test/
// dsp_host_test.cpp asserts on the C++ side, number for number. Extending the golden set past
// ΔF to the full feature set is what Phase 6 is for: through Phases 1-5 the two ports agreed
// on formant dispersion and on nothing built above it, so the C++ leg could have drifted
// arbitrarily far from the split the web app actually displays and no test would have said so.

test('golden: the scale-fit weights are derived from the published CVs, not tabulated', () => {
  // w_i = 1/(CV_i·F̄_i)². The C++ port computes these the same way rather than hardcoding
  // them, so this pins the derivation both sides share.
  for (let i = 0; i < 4; i++) {
    const sigma = FORMANT_SCALE_CV[i] * FORMANT_SCALE_CENTRE_HZ[i];
    near(FORMANT_SCALE_WEIGHTS[i], 1 / (sigma * sigma), 1e-12);
  }
  near(FORMANT_SCALE_WEIGHTS[0], 3.906250e-5, 1e-11);
  near(FORMANT_SCALE_WEIGHTS[1], 3.077870e-6, 1e-11);
  near(FORMANT_SCALE_WEIGHTS[2], 2.500000e-5, 1e-11);
  near(FORMANT_SCALE_WEIGHTS[3], 1.275510e-5, 1e-11);
  // The whole point of the weighting: F3 outweighs F2 by ~8x per unit of x², and F1/F2 —
  // the two formants that define the vowel — carry almost none of a tract-SIZE estimate.
  assert.ok(FORMANT_SCALE_WEIGHTS[2] > FORMANT_SCALE_WEIGHTS[1] * 8);
});

test('golden: weighted formant scale (ΔF_scale) — the cross-port vectors', () => {
  const dF = (f) => fitFormantScale(f).deltaF;
  // An ideal uniform-tube series fits exactly, whatever the weights are.
  near(dF([500, 1500, 2500, 0]), 1000);
  near(dF([500, 1500, 2500, 3500]), 1000);       // F4 on the same series changes nothing
  // A real vowel does not lie on a tube, so the weights decide, and F3 dominates.
  near(dF([650, 1800, 2900, 0]), 1169.507274, 1e-5);
  // ARRAY SLOT IS THE FORMANT NUMBER. Each of these was a live bug class on the C++ port.
  near(dF([500, 0, 2500, 0]), 1000);             // F2 dropped, F1/F3 keep their slots
  near(dF([500, 1500, 0, 0]), 1000);             // F3 dropped
  near(dF([500, 0, 0, 0]), 0);                   // one formant cannot fix a tract length
  // Peterson & Barney adult-male means: the three vowels that anchor the redesign's argument.
  near(dF([270, 2290, 3010, 0]), 1179.426039, 1e-5);   // /i/  "heed"
  near(dF([730, 1090, 2440, 0]), 993.346264, 1e-5);    // /ɑ/  "hod"
  near(dF([490, 1350, 1690, 0]), 702.136086, 1e-5);    // /ɝ/  "heard" — the rhotic
});

test('golden: resonanceAbsolute maps ΔF_scale onto the population axis', () => {
  near(RESONANCE_V2_REFERENCE_DELTA_F_HZ, 1078);
  near(resonanceAbsoluteV2(1000), 0.463822, 1e-6);
  near(resonanceAbsoluteV2(1169.507274), 0.542443, 1e-6);
  near(resonanceAbsoluteV2(702.136086), 0.325666, 1e-6);
  near(resonanceAbsoluteV2(2 * RESONANCE_V2_REFERENCE_DELTA_F_HZ), 1);   // the top of the axis
  near(resonanceAbsoluteV2(0), 0);                                        // no reading, not 0 cm
  // It cannot rail on any human voice, which is the defect it exists to fix: v1's 17→14 cm
  // anchors put five of the seven P&B adult-male vowels on a rail.
  for (const f of [[270, 2290, 3010, 0], [730, 1090, 2440, 0], [490, 1350, 1690, 0]]) {
    const v = resonanceAbsoluteV2(fitFormantScale(f).deltaF);
    assert.ok(v > 0.05 && v < 0.95, `${f} → ${v}`);
  }
});

test('golden: formant pattern residuals, and the ρ identity the ports must both satisfy', () => {
  const r = (f) => formantPatternResiduals(f, fitFormantScale(f).deltaF).map((x) => (x == null ? 0 : x));
  // A tube reads as all-ones: every formant exactly where its own scale predicts.
  for (const x of r([500, 1500, 2500, 0]).slice(0, 3)) near(x, 1);
  // /i/: F1 far below where the tube would put it, F2 far above. That spread IS the vowel.
  const ri = r([270, 2290, 3010, 0]);
  near(ri[0], 0.457850, 1e-5);
  near(ri[1], 1.294415, 1e-5);
  near(ri[2], 1.020836, 1e-5);
  const ra = r([730, 1090, 2440, 0]);
  near(ra[0], 1.469780, 1e-5);
  near(ra[1], 0.731534, 1e-5);
  near(ra[2], 0.982538, 1e-5);
  // An unmeasured formant yields no residual — not a residual of zero.
  assert.equal(formantPatternResiduals([500, 0, 2500, 0], 1000)[1], null);

  // THE IDENTITY. Σ L_i·r_i ≡ 1 whenever ΔF was fitted to the same frame's formants, with
  // L_i = w_i x_i²/Σ(w_j x_j²). It is exact, not approximate, and it is why an n-formant
  // residual vector carries only n−1 free dimensions. Both ports must reproduce it: a port
  // that got the weights subtly wrong would still look plausible on the residuals above and
  // would fail here.
  for (const f of [[500, 1500, 2500, 0], [650, 1800, 2900, 0], [270, 2290, 3010, 0],
                   [730, 1090, 2440, 0], [490, 1350, 1690, 0]]) {
    near(residualScaleFactor(formantPatternResiduals(f, fitFormantScale(f).deltaF), undefined, 3), 1, 1e-9);
  }
  // And it departs from 1 exactly when ΔF came from somewhere else — which is the rhotic
  // signal. /ɝ/ against a scale pooled over a speaker's other vowels reads well below 1.
  const rhoRhotic = residualScaleFactor(formantPatternResiduals([490, 1350, 1690, 0], 968), undefined, 3);
  assert.ok(rhoRhotic < 0.8, `/ɝ/ ρ against a pooled scale = ${rhoRhotic}`);
});

test('golden: pooling the scale takes a weighted median, and refuses a short window', () => {
  const pool = (d, w) => poolFormantScale(d.map((x, i) => ({ deltaF: x, weight: w[i] }))).deltaF;
  const ones = (n) => new Array(n).fill(1);
  // Eight equally-trusted frames: the weighted median is the upper-middle entry.
  near(pool([900, 950, 1000, 1050, 1100, 1150, 1200, 1250], ones(8)), 1050);
  // THE REASON IT IS A MEDIAN. One frame whose F3 locked onto F4 doubles that frame's ΔF; a
  // mean would carry it into the pooled value in proportion to its size, a median does not.
  near(pool([900, 950, 1000, 1050, 1100, 1150, 1200, 2400], ones(8)), 1050);
  // Weights are the caller's per-frame confidence, so a heavily-trusted outlier CAN win. That
  // is the contract, not a defect: the pool trusts what the caller says to trust.
  near(pool([1000, 1000, 1000, 1000, 1000, 1000, 1000, 3000],
    [1, 1, 1, 1, 1, 1, 1, 9]), 3000);
  // Fewer than eight usable frames is not a speaker. 0 means "no scale yet" and callers must
  // not read it as a very short tract.
  near(pool([900, 950, 1000, 1050, 1100, 1150, 1200], ones(7)), 0);
  near(pool([], []), 0);
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
