// Resonance measurement: validity and reliability.
//
// The rest of the suite checks that the resonance code runs and that its pure helpers return
// frozen values. Neither answers the question the app actually stakes itself on: *does the
// number mean what the UI says it means, and does it mean the same thing twice?* These tests
// do, by driving the real VoiceAnalyzer over synthetic vowels whose vocal-tract length is
// known by construction.
//
// Everything here runs at the LIVE frame rate. The app calls analyzer.update() from its
// requestAnimationFrame loop (~16.7 ms hop) with a 4096-sample analysis window; the golden
// harness in tools/run-eval-harness.mjs walks non-overlapping 4096-sample chunks, a 93 ms hop.
// That is a 5.6x difference, and every EMA rate, steady-state tolerance and profile-learning
// duration in the resonance stage is expressed per frame — so the harness was validating the
// pipeline at an operating point no user ever runs at. Measured at 93 ms the four estimators
// disagreed by 0.63 of the 0-1 scale on identical audio; at the live rate, by 0.11. Both the
// disagreement and the harness's inability to see it are why these tests exist.

import test from 'node:test';
import assert from 'node:assert/strict';

// Importing the harness installs the mock Web Audio globals (real-FFT AnalyserNode) that
// VoiceAnalyzer needs outside a browser. It must precede the app.js import.
import { MockAudioContext } from './tools/run-eval-harness.mjs';
const { VoiceAnalyzer } = await import('./app.js');

const SAMPLE_RATE = 44100;
const WINDOW = 4096;                              // analyser window
const HOP = Math.round(SAMPLE_RATE / 60);         // live requestAnimationFrame hop
const DT = HOP / SAMPLE_RATE;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs) => {
  const m = mean(xs);
  return xs.length ? Math.sqrt(mean(xs.map((v) => (v - m) ** 2))) : 0;
};

// ---------------------------------------------------------------------------
// Synthetic vowel: a glottal pulse train through a cascade of Klatt resonators, with known
// F1/F2/F3 so the resonance score has a ground truth to be right or wrong about.
//
// The generator moved to tools/synth-vowel.mjs when Phase 2's aggregation fixture needed the
// same held vowel; the arithmetic is unchanged, and sharing it is what keeps that fixture and
// this test measuring the same signal.
// ---------------------------------------------------------------------------
import { synthVowel } from './tools/synth-vowel.mjs';

async function analyze(signal, { method = 'lpc', sampleRate = SAMPLE_RATE } = {}) {
  const a = new VoiceAnalyzer();
  await a.start(null, { deviceId: 'mock' });
  a.audioCtx.sampleRate = sampleRate;
  // Pre-calibrate: the fixture starts phonating immediately, so there is no ambient lead-in
  // for the wizard to learn a floor from.
  a.isCalibrated = true;
  a.noiseFloor = 0.005;
  a.hfNoiseFloor = 0.001;
  a.micTiltBaselineDb = 0;
  a.resonanceMethod = method;

  const resonance = [], f1 = [], f2 = [], conf = [], dispersion = [];
  for (let i = 0; i + WINDOW <= signal.length; i += HOP) {
    a.audioCtx._currentChunk = signal.subarray(i, i + WINDOW);
    a.update(DT);
    if (a.formantConfidence > 0.2) {
      resonance.push(a.smoothResonance);
      f1.push(a.smoothF1); f2.push(a.smoothF2);
      dispersion.push(a.formantDispersionHz);
      conf.push(a.formantConfidence);
    }
  }
  // Settle on the back half: the front half is the EMAs converging off their initial values,
  // which is a property of startup, not of the voice.
  const back = (xs) => xs.slice(Math.floor(xs.length / 2));
  return {
    n: resonance.length,
    resonance: mean(back(resonance)),
    resonanceSd: sd(back(resonance)),
    f1: mean(back(f1)),
    f2: mean(back(f2)),
    dispersion: mean(back(dispersion)),
    confidence: mean(back(conf)),
    profileLearned: a.resonanceProfile.isLearned,
  };
}

// Uniform scaling of F1/F2/F3 is exactly what changing vocal-tract length does: a tract k times
// shorter puts every formant at 1/k times the frequency. So these three signals differ in the
// one property the resonance score claims to measure, and in nothing else — same F0, same
// vowel identity, same source, same level.
const BASE_FORMANTS = [570, 1710, 2850];   // ΔF = 1140 Hz -> apparent tract ≈ 15.4 cm
const SCALES = { long: 0.93, mid: 1.0, short: 1.07 };
const scaled = (k) => BASE_FORMANTS.map((f) => Math.round(f * k));

test('validity: resonance rises monotonically with vocal-tract shortening', async () => {
  const long = await analyze(synthVowel({ formants: scaled(SCALES.long) }));
  const mid = await analyze(synthVowel({ formants: scaled(SCALES.mid) }));
  const short = await analyze(synthVowel({ formants: scaled(SCALES.short) }));

  for (const [name, r] of [['long', long], ['mid', mid], ['short', short]]) {
    assert.ok(r.n > 20, `${name}: only ${r.n} usable frames — the estimator never engaged`);
  }
  assert.ok(long.resonance < mid.resonance,
    `a longer tract must read darker: long=${long.resonance.toFixed(3)} mid=${mid.resonance.toFixed(3)}`);
  assert.ok(mid.resonance < short.resonance,
    `a shorter tract must read brighter: mid=${mid.resonance.toFixed(3)} short=${short.resonance.toFixed(3)}`);

  // Monotonic but flat would still be useless as training feedback: the user has to be able to
  // see the change. A ±7% tract-length change is a large, deliberate resonance shift, and it
  // has to move the meter by more than a couple of points.
  const travel = short.resonance - long.resonance;
  assert.ok(travel > 0.10,
    `±7% tract change moved the score only ${(travel * 100).toFixed(1)} points — too flat to train against`);
});

test('validity: measured ΔF tracks the synthesized vocal-tract length', async () => {
  // ΔF is the score's largest term and is claimed to be an apparent-tract-length estimate, so
  // it should recover the tract length that was actually synthesized, not merely correlate.
  for (const [name, k] of Object.entries(SCALES)) {
    const r = await analyze(synthVowel({ formants: scaled(k) }));
    const trueDeltaF = 1140 * k;                       // ΔF scales with the formants
    const relErr = Math.abs(r.dispersion - trueDeltaF) / trueDeltaF;
    assert.ok(relErr < 0.15,
      `${name}: measured ΔF ${r.dispersion.toFixed(0)} Hz vs synthesized ${trueDeltaF.toFixed(0)} Hz (${(relErr * 100).toFixed(1)}% off)`);
  }
});

// Resonance the score SHOULD report for BASE_FORMANTS, computed by hand from the published
// weighting rather than from the code, so this is an external check and not a tautology:
//   ΔF = 1140 Hz -> aVTL = 35000/(2*1140) = 15.35 cm -> vtlScore = (17-15.35)/3 = 0.550
//   (the 17 cm -> 14 cm anchors are longer/darker -> shorter/brighter, not male -> female)
//   f1Score = (570-300)/600 = 0.450 ; f2Score = (1710-1000)/1400 = 0.507
//   0.550*0.55 + 0.450*0.25 + 0.507*0.20 = 0.516
const EXPECTED_RESONANCE = 0.516;

// Measured bias per estimator against that ground truth, in score points, at the live frame
// rate. These are not aspirations — they are what the code does today, recorded so a change
// that degrades an estimator is visible as a number rather than as a vague drift. The ranking
// is the useful part: the UI offers all four from one dropdown as if they were interchangeable,
// and they are not.
//
//   lpc       -0.3 pts   root-solved; the reference
//   cepstral  -1.7 pts
//   centroid  +5.0 pts   F1/F2 only — it cannot resolve F3 (see _resonanceCentroid)
//   harmonic -11.9 pts   envelope sampled at F0 spacing; quantises F2/F3 to the nearest
//                        harmonic, which at F0=150 Hz costs ~4% on ΔF
const METHOD_BIAS_TOLERANCE = { lpc: 4, cepstral: 5, centroid: 9, harmonic: 16 };

test('validity: each estimator recovers the synthesized resonance within its measured bias', async () => {
  const signal = synthVowel({ formants: BASE_FORMANTS });
  const report = [];
  for (const [method, tolPts] of Object.entries(METHOD_BIAS_TOLERANCE)) {
    const r = await analyze(signal, { method });
    const errPts = (r.resonance - EXPECTED_RESONANCE) * 100;
    report.push(`${method}=${r.resonance.toFixed(3)} (${errPts >= 0 ? '+' : ''}${errPts.toFixed(1)}pts)`);
    assert.ok(Math.abs(errPts) <= tolPts,
      `${method}: read ${r.resonance.toFixed(3)} for a vowel whose true resonance is ${EXPECTED_RESONANCE} — ` +
      `off by ${errPts.toFixed(1)} points, tolerance ${tolPts}. ${report.join(' ')}`);
  }
});

test('reliability: the four estimators agree on the same vowel', async () => {
  // They will never agree exactly — each trades precision against noise tolerance differently,
  // which is the entire reason 'auto' switches between them. But 'auto' switches MID-SESSION on
  // room noise, so whatever they disagree by lands on the user as an unexplained jump in a
  // number they are trying to train. This bounds that jump.
  //
  // The bound is tight because ΔF feeds a very high-gain mapping: vtlScore spans its whole
  // 0-1 range over ΔF in [1029, 1250] Hz, a 21% band, so a 1% error in ΔF moves the reported
  // score by about 5 points. Small formant disagreements are amplified, which is exactly why
  // this needs a test rather than an assumption.
  const signal = synthVowel({ formants: BASE_FORMANTS });
  const results = {};
  for (const method of ['harmonic', 'cepstral', 'lpc', 'centroid']) {
    results[method] = await analyze(signal, { method });
  }
  const scores = Object.values(results).map((r) => r.resonance);
  const spread = Math.max(...scores) - Math.min(...scores);
  const detail = Object.entries(results)
    .map(([m, r]) => `${m}=${r.resonance.toFixed(3)}`).join(' ');
  assert.ok(spread < 0.20, `estimators disagree by ${spread.toFixed(3)} of the 0-1 scale: ${detail}`);

  // The three estimators 'auto' can actually select must agree more tightly than that, since
  // switching between them is automatic and invisible to the user.
  const autoScores = ['lpc', 'cepstral', 'centroid'].map((m) => results[m].resonance);
  const autoSpread = Math.max(...autoScores) - Math.min(...autoScores);
  assert.ok(autoSpread < 0.12,
    `the SNR ladder swaps between estimators that disagree by ${autoSpread.toFixed(3)}: ${detail}`);
});

test('reliability: every estimator produces usable confidence on a clean vowel', async () => {
  // The failure this pins: an estimator whose confidence is scaled so low it cannot clear the
  // downstream gates. Such an estimator is not "conservative" — it is invisible. It contributes
  // nothing to the readout, nothing to the voice map, and never lets the personal-range learner
  // fire, while the UI still names it as the active method.
  const signal = synthVowel({ formants: BASE_FORMANTS });
  for (const method of ['harmonic', 'cepstral', 'lpc', 'centroid']) {
    const r = await analyze(signal, { method });
    assert.ok(r.confidence > 0.3,
      `${method}: mean formantConfidence ${r.confidence.toFixed(3)} — below the gates that admit a frame to the readout`);
  }
});

test('reliability: identical input gives byte-identical output across runs', async () => {
  // LPC root-solving used to seed Durand-Kerner with Math.random(), so the app's most precise
  // estimator was not reproducible. A voice-training app whose measurement moves when nothing
  // moved cannot support the comparison it asks users to make between takes.
  const signal = synthVowel({ formants: BASE_FORMANTS });
  const a = await analyze(signal, { method: 'lpc' });
  const b = await analyze(signal, { method: 'lpc' });
  assert.equal(a.resonance, b.resonance, 'resonance differs between identical runs');
  assert.equal(a.f1, b.f1, 'F1 differs between identical runs');
  assert.equal(a.f2, b.f2, 'F2 differs between identical runs');
  assert.equal(a.dispersion, b.dispersion, 'ΔF differs between identical runs');
});

test('reliability: a held vowel reads as a steady score, not a jittering one', async () => {
  // Test-retest stability on the one signal that has no reason to vary. Anything the user sees
  // moving here is measurement noise being presented as vocal change.
  const r = await analyze(synthVowel({ formants: BASE_FORMANTS, seconds: 3.0 }));
  assert.ok(r.resonanceSd < 0.05,
    `held vowel wobbles by ${(r.resonanceSd * 100).toFixed(1)} points sd — that is noise, not voice`);
});

test('validity: F0 changes do not move the resonance score on synthetic vowels', async () => {
  // What this test establishes, precisely: the resonance score is *designed* to measure the
  // filter independently of the source, and under controlled F0 manipulation on synthetic
  // vowels — same tract, same vowel, three pitches — it is close to invariant. That is the
  // claim, and it is worth pinning: a score that tracked F0 would be reporting pitch twice.
  //
  // What it does NOT establish is F0-independence in real speech. LPC formant estimation has
  // a known F0-dependent error: with sparse harmonic sampling the poles are attracted toward
  // individual harmonics rather than the underlying resonance ("harmonic attraction"), and the
  // error grows as F0 rises and the harmonics thin out — worst exactly in the 180–250 Hz band
  // transfeminine users are training into. These signals are also idealised: a Klatt cascade
  // with clean, well-separated formants, no breathiness, no nasality, no room. The bound below
  // (0.20 of the 0–1 scale) is a *loose* one; it is not evidence of a tight guarantee.
  //
  // So: designed to be independent of F0, synthetically shown invariant under controlled F0
  // manipulation, and known to carry F0-dependent estimator error on real voices. F0 belongs in
  // the confidence model rather than being claimed away — that is Phase 3 of
  // docs/RESONANCE_REDESIGN.md. The assertion is unchanged; only what it is said to prove is.
  const formants = BASE_FORMANTS;
  const low = await analyze(synthVowel({ f0: 110, formants }));
  const midF0 = await analyze(synthVowel({ f0: 165, formants }));
  const high = await analyze(synthVowel({ f0: 220, formants }));
  const scores = [low.resonance, midF0.resonance, high.resonance];
  const spread = Math.max(...scores) - Math.min(...scores);
  assert.ok(spread < 0.20,
    `doubling F0 moved resonance by ${spread.toFixed(3)} (110Hz=${low.resonance.toFixed(3)} 165Hz=${midF0.resonance.toFixed(3)} 220Hz=${high.resonance.toFixed(3)}) — on synthetic vowels with a fixed tract, the score is tracking pitch`);
});
