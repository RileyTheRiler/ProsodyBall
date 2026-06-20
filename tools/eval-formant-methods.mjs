// Evidence-based comparison of the four formant-estimation methods against
// synthetic vowels with KNOWN F1/F2/F3. Reports per-method accuracy and cost so
// the default `resonanceMethod` can be chosen from data rather than assumption.
//
// Run: node tools/eval-formant-methods.mjs
import { VoiceAnalyzer } from '../voice-analyzer.js';
import { synthVowel, magnitudeSpectrumDb, VOWELS } from './audio-synth.mjs';

const SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;
const METHODS = ['harmonic', 'cepstral', 'lpc', 'centroid'];

function makeAnalyzer(vowel) {
  const time = synthVowel({ ...vowel, sampleRate: SAMPLE_RATE, length: FFT_SIZE });
  const va = new VoiceAnalyzer();
  va.audioCtx = { sampleRate: SAMPLE_RATE };
  va.analyserFormant = { fftSize: FFT_SIZE };
  va.timeDomainData = time;
  va.formantFreqData = magnitudeSpectrumDb(time, FFT_SIZE);
  va.pitchConfidence = 1;
  va.vowelLikelihood = 1;
  va.isCalibrated = false;
  va.noiseSpectralProfile = null;
  return va;
}

function runMethod(va, method, f0) {
  switch (method) {
    case 'harmonic':
      return va._resonanceHarmonicEnvelope(f0);
    case 'cepstral':
      return va._resonanceCepstral(f0);
    case 'lpc':
      return va._resonanceLPC();
    case 'centroid':
      return va._resonanceCentroid();
    default:
      return { f1: 0, f2: 0, f3: 0, confidence: 0 };
  }
}

const errors = Object.fromEntries(METHODS.map((m) => [m, { f1: [], f2: [], ms: 0 }]));

console.log('Formant accuracy on synthetic vowels (|error| in Hz):\n');
for (const [name, vowel] of Object.entries(VOWELS)) {
  const trueF1 = vowel.formants[0].f;
  const trueF2 = vowel.formants[1].f;
  console.log(`/${name}/  true F1=${trueF1}  F2=${trueF2}`);
  for (const method of METHODS) {
    const va = makeAnalyzer(vowel);
    const r = runMethod(va, method, vowel.f0);
    const e1 = r.f1 > 0 ? Math.abs(r.f1 - trueF1) : NaN;
    const e2 = r.f2 > 0 ? Math.abs(r.f2 - trueF2) : NaN;
    if (Number.isFinite(e1)) errors[method].f1.push(e1);
    if (Number.isFinite(e2)) errors[method].f2.push(e2);

    // Timing: median of repeated calls on a fresh-but-warm analyzer.
    const warm = makeAnalyzer(vowel);
    const iters = 200;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) runMethod(warm, method, vowel.f0);
    errors[method].ms += (performance.now() - t0) / iters;

    console.log(
      `   ${method.padEnd(9)} F1=${(r.f1 || 0).toFixed(0).padStart(4)} (e=${(e1 || 0).toFixed(0).padStart(4)})` +
        `  F2=${(r.f2 || 0).toFixed(0).padStart(4)} (e=${(e2 || 0).toFixed(0).padStart(4)})`
    );
  }
  console.log('');
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
console.log('Summary (mean |error| over all vowels):');
const ranked = METHODS.map((m) => ({
  method: m,
  f1: mean(errors[m].f1),
  f2: mean(errors[m].f2),
  combined: (mean(errors[m].f1) + mean(errors[m].f2)) / 2,
  msPerCall: errors[m].ms / Object.keys(VOWELS).length
})).sort((a, b) => a.combined - b.combined);

for (const r of ranked) {
  console.log(
    `   ${r.method.padEnd(9)} F1=${r.f1.toFixed(0).padStart(4)}Hz  F2=${r.f2.toFixed(0).padStart(4)}Hz  ` +
      `combined=${r.combined.toFixed(0).padStart(4)}Hz  cost=${r.msPerCall.toFixed(3)}ms/call`
  );
}
console.log(`\nLowest combined error: ${ranked[0].method}`);
