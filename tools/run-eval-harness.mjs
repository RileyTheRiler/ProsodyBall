import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wav from 'node-wav';

// In-place iterative radix-2 Cooley–Tukey FFT (N a power of two).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlr = Math.cos(ang), wli = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = i + k + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const nwr = wr * wlr - wi * wli; wi = wr * wli + wi * wlr; wr = nwr;
      }
    }
  }
}

// Deterministic pseudo-noise (seeded LCG) so the comparative SNR assertions never flake.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function noiseChunk(n, amp, rng) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (rng() * 2 - 1) * amp;
  return a;
}

// Mock Web Audio that serves the *real* magnitude spectrum of the current time-domain
// chunk, so the analyzer's frequency-domain features (centroid, tilt, SNR, the formant
// gate) get real data instead of a flat -100 dB spectrum. Size-aware: each analyser asks
// for fftSize/2 bins, and we FFT the matching number of trailing samples.
class MockAudioContext {
  constructor() {
    this.sampleRate = 44100;
    this.state = 'running';
    this.destination = {};
  }
  createMediaStreamSource() { return { connect: () => {} }; }
  createMediaElementSource() { return { connect: () => {} }; }
  createBiquadFilter() { return { type: 'highpass', frequency: { value: 2000 }, connect: () => {} }; }
  _spectrumDb(arr) {
    const N = arr.length * 2; // fftSize
    const chunk = this._currentChunk;
    if (!chunk || chunk.length < N) { return null; }
    const re = new Float64Array(N), im = new Float64Array(N);
    const off = chunk.length - N;
    for (let i = 0; i < N; i++) {
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (N - 1));
      re[i] = chunk[off + i] * w;
    }
    fft(re, im);
    const db = new Float64Array(arr.length);
    for (let k = 0; k < arr.length; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N;
      db[k] = mag > 1e-10 ? 20 * Math.log10(mag) : -200;
    }
    return db;
  }
  createAnalyser() {
    const ctx = this;
    return {
      fftSize: 4096,
      smoothingTimeConstant: 0.8,
      get frequencyBinCount() { return this.fftSize / 2; },
      getFloatTimeDomainData: (arr) => {
        if (ctx._currentChunk) arr.set(ctx._currentChunk.subarray(0, Math.min(arr.length, ctx._currentChunk.length)));
        else arr.fill(0);
      },
      getFloatFrequencyData: (arr) => {
        const db = ctx._spectrumDb(arr);
        if (db) arr.set(db); else arr.fill(-100);
      },
      getByteFrequencyData: (arr) => {
        const db = ctx._spectrumDb(arr);
        if (!db) { arr.fill(0); return; }
        for (let k = 0; k < arr.length; k++) {
          // Map dB[-100,-30] → [0,255], like a default AnalyserNode.
          arr[k] = Math.max(0, Math.min(255, Math.round((db[k] + 100) / 70 * 255)));
        }
      },
    };
  }
}

global.document = { getElementById: () => null };
global.window = {
  AudioContext: MockAudioContext,
  webkitAudioContext: MockAudioContext,
  navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
};
Object.defineProperty(global, 'navigator', { value: global.window.navigator, writable: true, configurable: true });

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

export async function runEval({ verbose = false, calibrate = false, calNoiseAmp = 0.02, profileScale = 1 } = {}) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const wavPath = path.join(__dirname, '..', 'fixtures', 'audio-eval', 'rainbow_passage.wav');
  const result = wav.decode(fs.readFileSync(wavPath));
  const audioData = result.channelData[0];
  const sampleRate = result.sampleRate;

  const { VoiceAnalyzer } = await import('../app.js');
  const analyzer = new VoiceAnalyzer();
  await analyzer.start(null, { deviceId: 'mock' });
  analyzer.audioCtx.sampleRate = sampleRate;

  const chunkSize = 4096;
  const dt = chunkSize / sampleRate;
  const rng = makeRng(0x9e3779b9);

  if (calibrate) {
    // Build a *real* per-bin noise profile by running the analyzer's own calibration on
    // quiet noise frames — so the calibrated band-limited SNR path runs (not the broadband
    // fallback), exercising the production code in app.js end-to-end.
    analyzer.isCalibrated = false;
    analyzer.noiseCalibrationTimer = 0;
    let guard = 0;
    while (!analyzer.isCalibrated && guard++ < 60) {
      analyzer.audioCtx._currentChunk = noiseChunk(chunkSize, calNoiseAmp, rng);
      analyzer.update(dt);
    }
    // Scale the per-bin profile to simulate a louder room *without* touching the scalar
    // gate, isolating the band-limited SNR path's response to a higher noise estimate
    // (speech stays above the silence gate, so formants/pitch are unaffected).
    if (profileScale !== 1 && analyzer.noiseSpectralProfile) {
      for (let i = 0; i < analyzer.noiseSpectralProfile.length; i++) analyzer.noiseSpectralProfile[i] *= profileScale;
    }
  } else {
    // Shortcut calibration so the start of the file isn't treated as the noise floor;
    // leaves noiseSpectralProfile null → the broadband SNR fallback path.
    analyzer.isCalibrated = true;
    analyzer.noiseFloor = 0.01;
    analyzer.hfNoiseFloor = 0.001;
    analyzer.micTiltBaselineDb = 0;
  }

  const voicedPitch = [], f1s = [], f2s = [], snrDbs = [], resonances = [], overSubs = [];
  let frames = 0, voicedFrames = 0, formantFrames = 0;

  for (let i = 0; i + chunkSize <= audioData.length; i += chunkSize) {
    analyzer.audioCtx._currentChunk = audioData.subarray(i, i + chunkSize);
    analyzer.update(dt);
    frames++;
    snrDbs.push(analyzer.snrDbSmoothed);
    overSubs.push(analyzer.overSubFactor);
    if (analyzer.pitchConfidence > 0.5 && analyzer.lastPitch > 50) {
      voicedFrames++;
      voicedPitch.push(analyzer.lastPitch);
      resonances.push(analyzer.smoothResonance);
    }
    if (analyzer.formantConfidence > 0.4 && analyzer.smoothF1 > 0 && analyzer.smoothF2 > 0) {
      formantFrames++;
      f1s.push(analyzer.smoothF1);
      f2s.push(analyzer.smoothF2);
    }
  }

  const stats = {
    frames,
    voicedFrames,
    formantFrames,
    avgPitch: +mean(voicedPitch).toFixed(1),
    avgF1: +mean(f1s).toFixed(1),
    avgF2: +mean(f2s).toFixed(1),
    avgSnrDb: +mean(snrDbs).toFixed(2),
    avgResonance: +mean(resonances).toFixed(3),
    avgOverSub: +mean(overSubs).toFixed(3),
    usedBandPath: !!(analyzer.isCalibrated && analyzer.noiseSpectralProfile),
  };
  if (verbose) console.log(JSON.stringify(stats, null, 2));
  return stats;
}

// Golden ranges for the Rainbow Passage through the full analyzer pipeline. These are an
// end-to-end regression net: gross breakage (formants collapsing to the 500/1500 defaults,
// pitch detection failing, SNR going wrong) trips a range; the margins absorb LPC
// root-finder / smoothing numerical variation across environments. The fixture is a
// male-range reader (~104 Hz, F1 ~420, F2 ~2223, masculine resonance ~0.31).
const GOLDEN = {
  frames: [54, 54],
  voicedFrames: [27, 35],
  formantFrames: [6, 18],
  avgPitch: [95, 113],
  avgF1: [340, 500],
  avgF2: [2000, 2450],
  avgSnrDb: [7.5, 12.5],
  avgResonance: [0.2, 0.45],
};

export function checkGolden(stats) {
  const failures = [];
  for (const [key, [lo, hi]] of Object.entries(GOLDEN)) {
    const v = stats[key];
    if (!(v >= lo && v <= hi)) failures.push(`${key}=${v} expected [${lo}, ${hi}]`);
  }
  return failures;
}

// CLI: run the pipeline and assert (used by `npm run test:all` / CI). Three scenarios:
// baseline (broadband fallback), and two calibrated runs that exercise the production
// band-limited SNR path with a clean vs a 4× louder per-bin noise profile.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const base = await runEval();
    const clean = await runEval({ calibrate: true, profileScale: 1 });
    const loud = await runEval({ calibrate: true, profileScale: 4 });

    const fail = [];
    for (const f of checkGolden(base)) fail.push(`baseline ${f}`);
    if (!clean.usedBandPath) fail.push('calibClean did not use the band-limited SNR path');
    if (!loud.usedBandPath) fail.push('calibLoud did not use the band-limited SNR path');
    // A louder noise floor must drop trust and ramp over-subtraction up — the core
    // "noisier room → less trust, stronger scrubbing" behavior, through the real pipeline.
    if (!(clean.avgSnrDb - loud.avgSnrDb >= 5)) {
      fail.push(`SNR did not drop with a louder noise profile (clean ${clean.avgSnrDb} vs loud ${loud.avgSnrDb})`);
    }
    if (!(loud.avgOverSub > clean.avgOverSub)) {
      fail.push(`over-subtraction did not increase in noise (clean ${clean.avgOverSub} vs loud ${loud.avgOverSub})`);
    }

    console.log('baseline   ', JSON.stringify(base));
    console.log('calibClean ', JSON.stringify(clean));
    console.log('calibLoud  ', JSON.stringify(loud));
    if (fail.length) {
      console.error(`\nFAIL:\n - ${fail.join('\n - ')}`);
      process.exit(1);
    }
    console.log('\nSUCCESS: full-pipeline aggregates within golden ranges; band-limited SNR path responds to a louder noise floor.');
  })().catch((e) => { console.error(e); process.exit(1); });
}
