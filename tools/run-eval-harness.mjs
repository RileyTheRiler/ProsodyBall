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

// Mock Web Audio that serves the *real* magnitude spectrum of the current time-domain
// chunk, so the analyzer's frequency-domain features (centroid, tilt, SNR, the formant
// gate) get real data instead of a flat -100 dB spectrum. Size-aware: each analyser asks
// for fftSize/2 bins, and we FFT the matching number of trailing samples.
export class MockAudioContext {
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

// The app's loop runs on requestAnimationFrame; 60 fps at the fixture's 44.1 kHz is 735 samples.
const LIVE_HOP_SAMPLES = 735;

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

// `hopSamples` decouples how far the harness advances per update() from the 4096-sample
// analysis window. The app drives analyzer.update() from requestAnimationFrame — a ~16.7 ms
// hop over an overlapping window — while this harness historically walked non-overlapping
// 4096-sample chunks, a 93 ms hop. Every EMA rate, steady-state tolerance and profile-learning
// duration in the analyzer is expressed per frame, so those two operating points are not the
// same pipeline: measured at 93 ms the four resonance estimators disagreed by 0.63 of the 0-1
// scale on identical audio, and at the live rate by 0.11. The 93 ms pass is kept as the
// historical regression net; LIVE_GOLDEN below covers the rate users actually run at.
export async function runEval({ verbose = false, hopSamples = null } = {}) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const wavPath = path.join(__dirname, '..', 'fixtures', 'audio-eval', 'rainbow_passage.wav');
  const result = wav.decode(fs.readFileSync(wavPath));
  const audioData = result.channelData[0];
  const sampleRate = result.sampleRate;

  const { VoiceAnalyzer } = await import('../app.js');
  const analyzer = new VoiceAnalyzer();
  await analyzer.start(null, { deviceId: 'mock' });
  analyzer.audioCtx.sampleRate = sampleRate;

  // Pre-calibrate so the start of the file isn't treated as the noise floor.
  analyzer.isCalibrated = true;
  analyzer.noiseFloor = 0.01;
  analyzer.hfNoiseFloor = 0.001;
  analyzer.micTiltBaselineDb = 0;

  // Pin the estimator. The live default is 'auto' (SNR-driven method selection), which would
  // swap methods as this fixture's SNR drifts around the tier edges and make the golden
  // non-deterministic. The golden ranges below were calibrated against the harmonic envelope,
  // so the regression net tests that one estimator end-to-end; 'auto' selection is covered by
  // selectResonanceMethod's unit tests.
  analyzer.resonanceMethod = 'harmonic';

  // Run the optional speech gate alongside the normal pipeline so its behaviour
  // on real speech is measured, not assumed. It does not affect the other stats:
  // the gate only ever forces frames unreliable, and on this fixture it stays
  // open, so the golden ranges below are the same either way. Enabling it here
  // is what pins the "does not reject the user's own voice" property.
  analyzer.speechGateEnabled = true;
  analyzer.speechGate.reset();

  const chunkSize = 4096;                          // analysis window
  const hop = hopSamples || chunkSize;             // how far update() advances per frame
  const dt = hop / sampleRate;
  const voicedPitch = [], f1s = [], f2s = [], snrDbs = [], resonances = [];
  let frames = 0, voicedFrames = 0, formantFrames = 0;
  // Frame-to-frame F1/F2 jitter, accumulated only across *adjacent* formant frames so
  // segment gaps don't count as a jump. This is the steady-state-weighting validation
  // number: lower jitter == the live estimate chasing onsets/glides less.
  let prevF1 = 0, prevF2 = 0, prevWasFormant = false;
  let jitF1Sum = 0, jitF2Sum = 0, jitN = 0;
  let gateOpenFrames = 0, voicedFramesGated = 0;

  for (let i = 0; i + chunkSize <= audioData.length; i += hop) {
    analyzer.audioCtx._currentChunk = audioData.subarray(i, i + chunkSize);
    analyzer.update(dt);
    frames++;
    snrDbs.push(analyzer.snrDbSmoothed);
    if (analyzer.isSpeechFrame) gateOpenFrames++;
    if (analyzer.pitchConfidence > 0.5 && analyzer.lastPitch > 50) {
      voicedFrames++;
      voicedPitch.push(analyzer.lastPitch);
      resonances.push(analyzer.smoothResonance);
      if (!analyzer.isSpeechFrame) voicedFramesGated++;
    }
    const isFormant = analyzer.formantConfidence > 0.4 && analyzer.smoothF1 > 0 && analyzer.smoothF2 > 0;
    if (isFormant) {
      formantFrames++;
      f1s.push(analyzer.smoothF1);
      f2s.push(analyzer.smoothF2);
      if (prevWasFormant) {
        jitF1Sum += Math.abs(analyzer.smoothF1 - prevF1);
        jitF2Sum += Math.abs(analyzer.smoothF2 - prevF2);
        jitN++;
      }
      prevF1 = analyzer.smoothF1; prevF2 = analyzer.smoothF2;
    }
    prevWasFormant = isFormant;
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
    jitterF1: +(jitN ? jitF1Sum / jitN : 0).toFixed(1),
    jitterF2: +(jitN ? jitF2Sum / jitN : 0).toFixed(1),
    gateOpenFrames,
    voicedFramesGated,
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
  // Rebaselined when the uncalibrated fallback stopped measuring SNR as a broadband
  // rms/noiseFloor amplitude ratio and started measuring voice-band a-posteriori SNR like
  // the calibrated path. This harness pre-sets isCalibrated with no per-bin noise profile,
  // so it exercises exactly that fallback. The old [7.5, 12.5] band was the bug: clean
  // read-aloud speech scored in the red/yellow tier, so snrConfidence sat near zero. The
  // fixture's pauses are digitally silent, so the true SNR is very high and the measurement
  // is bounded by SNR_DB_CEIL on speech frames.
  avgSnrDb: [24, 34],
  avgResonance: [0.2, 0.45],
  // Speech gate on real speech. The failure that matters is the gate silencing
  // the user's own voice, so this is the tripwire for it.
  //
  // An earlier revision required spectral energy above 1 kHz to reject a tonal
  // hum. It scored well on synthetic vowels and threw away 4 of this fixture's
  // 31 voiced frames, because a ~104 Hz voice often has nothing measurable up
  // there. Synthetic spectra could not have caught that; this range does.
  //
  // The one frame allowed through is the gate's 2-frame attack delay at the very
  // start of the file, not a rejection of speech.
  gateOpenFrames: [50, 54],
  voicedFramesGated: [0, 1],
};

// Golden ranges for the SAME fixture driven at the app's real frame rate: a ~16.7 ms
// requestAnimationFrame hop over the same 4096-sample window, instead of one 93 ms
// non-overlapping chunk per update.
//
// This is not a re-scaling of the pass above — it is a different operating point, and the
// analyzer behaves measurably differently at it. Frames that clear the formant gate go from
// 20% of the pass to 64%; F1 reads 507 Hz here against 428 Hz there, F2 1764 against 2107.
// Every EMA rate and steady-state tolerance in the resonance stage is per frame, so at 93 ms
// they run 5.6x slower than they ever do in the app: the steady-state weight sat pinned at its
// 0.3 floor (making it a constant, not a weighting), the personal resonance-range learner could
// not reach its formantSteadiness > 0.5 gate at all, and the four estimators disagreed by 0.63
// of the 0-1 scale rather than 0.11. None of that was visible from the 93 ms pass alone.
const LIVE_GOLDEN = {
  frames: [298, 298],
  voicedFrames: [190, 230],
  formantFrames: [160, 220],
  avgPitch: [88, 104],
  avgF1: [440, 570],
  avgF2: [1620, 1900],
  avgSnrDb: [21, 29],
  avgResonance: [0.33, 0.51],
  gateOpenFrames: [280, 298],
  voicedFramesGated: [0, 5],
};

export function checkGolden(stats, ranges = GOLDEN) {
  const failures = [];
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    const v = stats[key];
    if (!(v >= lo && v <= hi)) failures.push(`${key}=${v} expected [${lo}, ${hi}]`);
  }
  return failures;
}

// CLI: run the pipeline at both operating points and assert each one's golden ranges
// (used by `npm run test:all` / CI).
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const passes = [
      { name: 'chunked (93 ms hop, historical net)', opts: {}, ranges: GOLDEN },
      { name: 'live (rAF hop, production rate)', opts: { hopSamples: LIVE_HOP_SAMPLES }, ranges: LIVE_GOLDEN },
    ];
    let failed = false;
    for (const pass of passes) {
      const stats = await runEval(pass.opts);
      console.log(`\n--- ${pass.name} ---`);
      console.log(JSON.stringify(stats, null, 2));
      const failures = checkGolden(stats, pass.ranges);
      if (failures.length) {
        console.error(`FAIL (${pass.name}):\n - ${failures.join('\n - ')}`);
        failed = true;
      }
    }
    if (failed) process.exit(1);
    console.log('\nSUCCESS: full-pipeline aggregates within golden ranges at both frame rates.');
  })().catch((e) => { console.error(e); process.exit(1); });
}
