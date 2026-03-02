import { computeProsodyScore, pitchHzToPosition } from './dsp-utils.js';
import { PerformanceMonitor } from './performance-monitor.js';
import { CalibrationWizard } from './calibration-wizard.js';
import { getMicDiagnostics, ensureAudioContextRunning } from './reliability.js';
import { computeFrameReliability, normalizeAgainstPercentiles, normalizeAgainstRange } from './voice-analyzer-core.js';

function escapeHtml(text) {
  if (!text) return text;
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// VOICE ANALYZER
// ============================================================
export class VoiceAnalyzer {
  constructor() {
    this._buffers = {}; // Pre-allocated typed arrays for performance
    this.audioCtx = null;
    this.analyser = null;
    this.analyserFormant = null;
    this.analyserHF = null;
    this.analyserRec = null;     // dedicated small-FFT analyser for recording capture
    this.recTimeDomainData = null;
    this.source = null;
    this.stream = null;
    this.audioElement = null; // store audio element for cleanup
    this.isActive = false;

    this.timeDomainData = null;
    this.hfFrequencyData = null;
    this.frequencyData = null; // full-spectrum for formant/resonance analysis
    this.formantFreqData = null; // dedicated low-smoothing spectrum for formant peaks
    this.pitchBuf = null; // Downsampled buffer for optimized pitch detection

    // Pitch
    this.pitchHistory = [];
    this.pitchHistoryMax = 30;
    this.lastPitch = 0;
    this.smoothPitchHz = 160; // smoothed Hz for color mapping
    this._pitchMedianBuf = []; // for octave-jump suppression
    this.pitchConfidence = 0;  // 0=unreliable, 1=very confident (from YIN CMND)

    // Resonance — harmonic envelope formant estimation
    this.resonanceMethod = 'harmonic'; // 'harmonic' | 'cepstral' | 'lpc' | 'centroid'
    this.smoothResonance = 0.5; // 0=low/dark resonance, 1=high/bright resonance
    this.smoothF1 = 500;        // smoothed F1 estimate (Hz)
    this.smoothF2 = 1500;       // smoothed F2 estimate (Hz) — primary resonance correlate
    this.smoothF3 = 2700;       // smoothed F3 estimate (Hz) — secondary resonance cue
    this.formantConfidence = 0;  // how reliable current F1/F2/F3 estimates are
    this.vowelLikelihood = 0;   // 0=not vowel-like, 1=strong vowel formants

    // Spectral tilt diagnostic (light vs heavy vocal weight)
    this.spectralTiltRawDb = -14;
    this.spectralTiltSmoothedDb = -14;
    this.spectralWeight = 0.5; // 0=heavy, 1=light
    this.spectralTiltConfidence = 0;

    // Energy
    this.energyHistory = [];
    this.energyHistoryMax = 40;
    this.smoothEnergy = 0;
    this.energyBaselineWindow = [];
    this.energyBaselineWindowMax = 120;
    this.energyPercentiles = { p50: 0.002, p75: 0.004, p90: 0.008 };

    // Syllable detection
    this.syllableState = 'silent';
    this.syllableThreshold = 0.015;
    this.lastSyllableTime = 0;
    this.syllableImpulse = 0;

    // Vowel
    this.sustainedDuration = 0;
    this.sustainedThreshold = 0.02;
    this.defaultSustainedThreshold = 0.02;

    // Adaptive Pitch Range
    this.pitchProfile = {
      samples: [],
      min: 80,     // Default fallback
      max: 380,    // Default fallback
      isLearned: false,
      voicedTime: 0,
      learningDuration: 5.0
    };

    // Adaptive Spectral Tilt Range
    this.tiltProfile = {
      samples: [],
      min: -34,    // Default heavy fallback
      max: -4,     // Default light fallback
      isLearned: false,
      voicedTime: 0,
      learningDuration: 5.0
    };

    // Noise floor calibration
    this.noiseFloor = 0.015; // default, will be calibrated
    this.hfNoiseFloor = 0; // HF baseline for fans/AC
    this.noiseCalibrationSamples = [];
    this.hfCalibrationSamples = [];
    this.noiseCalibrationDuration = 1.0; // seconds — longer for steady noise like fans
    this.noiseCalibrationTimer = 0;
    this.isCalibrated = false;
    this.noiseAdaptRate = 0.002; // ongoing adaptation for changing environments

    this.metrics = {
      bounce: 0, tempo: 0, vowel: 0,
      articulation: 0, syllable: 0,
      pitch: 0, energy: 0, resonance: 0
    };
  }

  // Helper to reuse typed arrays to prevent garbage collection spikes in hot loops
  _getBuffer(name, ArrayType, size) {
    if (!this._buffers[name] || this._buffers[name].length < size) {
      this._buffers[name] = new ArrayType(size);
    }
    return this._buffers[name];
  }

  async start(audioFile = null) {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      if (audioFile) {
        // Handle audio file input
        this.audioElement = new Audio();
        this.audioElement.src = URL.createObjectURL(audioFile);
        this.audioElement.loop = false;

        // ensure AudioContext is running before playing
        if (this.audioCtx.state === 'suspended') {
          await this.audioCtx.resume();
        }

        this.source = this.audioCtx.createMediaElementSource(this.audioElement);
        // Connect to destination so user can hear it
        this.source.connect(this.audioCtx.destination);
      } else {
        // Handle microphone input
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        this.source = this.audioCtx.createMediaStreamSource(this.stream);
      }

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 4096; // Larger window → better low-freq pitch resolution
      this.analyser.smoothingTimeConstant = 0.8;
      this.source.connect(this.analyser);

      // Dedicated formant analyser — lower smoothing for crisper spectral peaks
      this.analyserFormant = this.audioCtx.createAnalyser();
      this.analyserFormant.fftSize = 4096;
      this.analyserFormant.smoothingTimeConstant = 0.5; // Less temporal blur than main analyser
      this.source.connect(this.analyserFormant);

      this.analyserHF = this.audioCtx.createAnalyser();
      this.analyserHF.fftSize = 1024;
      this.analyserHF.smoothingTimeConstant = 0.3; // Fast response for consonant transients
      const hfFilter = this.audioCtx.createBiquadFilter();
      hfFilter.type = 'highpass';
      hfFilter.frequency.value = 2000; // Captures consonant bursts (s, t, k, etc.)
      this.source.connect(hfFilter);
      hfFilter.connect(this.analyserHF);

      this.timeDomainData = new Float32Array(this.analyser.fftSize);
      this.pitchBuf = new Float32Array(this.analyser.fftSize / 2); // 2x downsampling buffer
      this.frequencyData = new Float32Array(this.analyser.frequencyBinCount);
      this.formantFreqData = new Float32Array(this.analyserFormant.frequencyBinCount);
      this.hfFrequencyData = new Uint8Array(this.analyserHF.frequencyBinCount);

      // Dedicated small-FFT analyser for recording — polls time-domain samples
      // fftSize=512 → 11.6ms window at 44.1kHz, polled at matched interval
      this.analyserRec = this.audioCtx.createAnalyser();
      this.analyserRec.fftSize = 512;
      this.source.connect(this.analyserRec);
      this.recTimeDomainData = new Float32Array(512);

      this.isActive = true;

      // We must play it to get logic processing
      if (this.audioElement) {
        try {
          await this.audioElement.play();
        } catch (playErr) {
          console.error("Autoplay prevented:", playErr);
          // Provide error response if play fails
          return { ok: false, error: "AutoPlayError", message: playErr.message };
        }
      }

      return { ok: true, audioElement: this.audioElement };
    } catch (e) {
      console.error('Mic/Audio access denied:', e);
      return { ok: false, error: e.name, message: e.message };
    }
  }

  stop() {
    this.isActive = false;

    if (this.audioElement) {
      this.audioElement.pause();
      URL.revokeObjectURL(this.audioElement.src);
      this.audioElement.src = "";
      this.audioElement = null;
    }

    if (this.source) { try { this.source.disconnect(); } catch (e) { } }
    // FIX: stop stream tracks so mic LED turns off
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => { });
    }
    this.audioCtx = null;
    this.analyser = null;
    this.analyserFormant = null;
    this.analyserHF = null;
    this.analyserRec = null;
    this.source = null;
    this.pitchBuf = null;
    this.pitchHistory = [];
    this.energyHistory = [];
    this.energyBaselineWindow = [];
    this.energyPercentiles = { p50: 0.002, p75: 0.004, p90: 0.008 };
    this.smoothPitchHz = 160;
    this._pitchMedianBuf = [];
    this.pitchConfidence = 0;
    this.smoothResonance = 0.5;
    this.smoothF1 = 500;
    this.smoothF2 = 1500;
    this.smoothF3 = 2700;
    this.formantConfidence = 0;
    this.vowelLikelihood = 0;
    this.spectralTiltRawDb = -14;
    this.spectralTiltSmoothedDb = -14;
    this.spectralWeight = 0.5;
    this.spectralTiltConfidence = 0;
    this.sustainedDuration = 0;
    this.syllableImpulse = 0;
    this.syllableState = 'silent';
    this.noiseCalibrationSamples = [];
    this.hfCalibrationSamples = [];
    this.noiseCalibrationTimer = 0;
    this.isCalibrated = false;
    this.noiseFloor = 0.015;
    this.hfNoiseFloor = 0;
    this.pitchProfile = { samples: [], min: 80, max: 380, isLearned: false, voicedTime: 0, learningDuration: 5.0 };
    this.tiltProfile = { samples: [], min: -34, max: -4, isLearned: false, voicedTime: 0, learningDuration: 5.0 };
    for (const k in this.metrics) this.metrics[k] = 0;
  }

  // ========================================================
  // YIN pitch detector — research-grade monophonic f0 estimation
  // Based on de Cheveigné & Kawahara (2002)
  // Steps: difference function → cumulative mean normalized
  //        difference → absolute threshold → parabolic interp
  // Plus median filter for octave-jump suppression
  // ========================================================
  _percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
    return sorted[idx];
  }

  detectPitch() {
    // timeDomainData already populated by update() — no need to re-read
    const buf = this.timeDomainData;
    const n = buf.length;
    const sampleRate = this.audioCtx.sampleRate;

    // RMS gate (calculated on full buffer for accuracy)
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    const silenceThreshold = this.isCalibrated ? this.noiseFloor * 2.5 : 0.015;
    if (rms < silenceThreshold) return 0;

    // OPTIMIZATION: Downsample by 2x for faster YIN calculation
    // Reduces complexity by ~4x (N^2 -> (N/2)^2)
    const dsRate = sampleRate / 2;
    const dsN = Math.floor(n / 2);
    const dsBuf = this._getBuffer('pitchBuf', Float32Array, dsN);

    // Simple 2x decimation with averaging (low-pass filter)
    for (let i = 0; i < dsN; i++) {
      dsBuf[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
    }

    // Adjust params for downsampled rate
    const minPeriod = Math.floor(dsRate / 500); // 500 Hz max
    const maxPeriod = Math.min(Math.floor(dsRate / 60), Math.floor(dsN / 2)); // 60 Hz min
    const W = maxPeriod; // integration window

    // Step 1 & 2: Difference function d(τ) and CMND d'(τ)
    // OPTIMIZATION: Use running sum of squares to avoid (a-b)^2 in inner loop
    const cmnd = this._getBuffer('cmnd', Float32Array, maxPeriod + 1);
    cmnd[0] = 1.0;
    let runningSum = 0;

    let sumSq0 = 0;
    for (let i = 0; i < W; i++) sumSq0 += dsBuf[i] * dsBuf[i];

    let currentSumSqTau = 0;
    for (let i = 0; i < W; i++) currentSumSqTau += dsBuf[i + 1] * dsBuf[i + 1];

    for (let tau = 1; tau <= maxPeriod; tau++) {
      let crossCorr = 0;
      for (let i = 0; i < W; i++) {
        crossCorr += dsBuf[i] * dsBuf[i + tau];
      }

      let diff = sumSq0 + currentSumSqTau - 2 * crossCorr;
      if (diff < 0) diff = 0; // Floating point noise

      runningSum += diff;
      cmnd[tau] = diff * tau / (runningSum || 1);

      if (tau < maxPeriod) {
        const removeVal = dsBuf[tau];
        const addVal = dsBuf[tau + W];
        currentSumSqTau = currentSumSqTau - removeVal * removeVal + addVal * addVal;
      }
    }

    // Step 3: Absolute threshold — find first dip below threshold
    // This is the key to YIN's octave-error resistance
    const yinThreshold = 0.15; // Stricter = more accurate, less sensitive
    let bestTau = -1;

    for (let tau = minPeriod; tau <= maxPeriod; tau++) {
      if (cmnd[tau] < yinThreshold) {
        // Walk to the local minimum
        while (tau + 1 <= maxPeriod && cmnd[tau + 1] < cmnd[tau]) {
          tau++;
        }
        bestTau = tau;
        break;
      }
    }

    // Fallback: if no dip below threshold, find global minimum
    if (bestTau < 0) {
      let minVal = Infinity;
      for (let tau = minPeriod; tau <= maxPeriod; tau++) {
        if (cmnd[tau] < minVal) {
          minVal = cmnd[tau];
          bestTau = tau;
        }
      }
      // Reject if global min is still high (likely unvoiced)
      if (minVal > 0.4) return 0;
    }

    // Step 4: Parabolic interpolation for sub-sample accuracy
    let period = bestTau;
    // Capture CMND value at bestTau for confidence scoring
    const cmndAtBest = cmnd[bestTau];
    if (bestTau > 0 && bestTau < maxPeriod) {
      const a = cmnd[bestTau - 1];
      const b = cmnd[bestTau];
      const c = cmnd[bestTau + 1];
      const denom = 2 * (2 * b - a - c);
      if (Math.abs(denom) > 1e-10) {
        period = bestTau + (a - c) / denom;
      }
    }

    const rawHz = dsRate / period;

    // Pitch confidence: CMND < 0.05 = very confident, > 0.3 = unreliable
    // Map inversely: low CMND → high confidence
    this.pitchConfidence = Math.max(0, Math.min(1, 1 - cmndAtBest * 3.3));

    // Step 5: Median filter — suppresses octave jumps
    // Keep a small buffer of recent raw detections
    this._pitchMedianBuf.push(rawHz);
    if (this._pitchMedianBuf.length > 5) this._pitchMedianBuf.shift();

    if (this._pitchMedianBuf.length >= 3) {
      const sorted = [...this._pitchMedianBuf].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
    return rawHz;
  }

  update(dt) {
    if (!this.isActive || !this.analyser) return;

    const now = performance.now() / 1000;

    // --- Raw energy first (needed for calibration) ---
    this.analyser.getFloatTimeDomainData(this.timeDomainData);
    let rms = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      rms += this.timeDomainData[i] * this.timeDomainData[i];
    }
    rms = Math.sqrt(rms / this.timeDomainData.length);

    // --- Noise floor calibration ---
    // Collect ambient noise samples for ~1s, then compute thresholds
    if (!this.isCalibrated) {
      this.noiseCalibrationTimer += dt;
      this.noiseCalibrationSamples.push(rms);
      // Also sample HF energy during calibration (for fan/AC baseline)
      this.analyserHF.getByteFrequencyData(this.hfFrequencyData);
      let hfSample = 0;
      for (let i = 0; i < this.hfFrequencyData.length; i++) hfSample += this.hfFrequencyData[i];
      this.hfCalibrationSamples.push(hfSample / (this.hfFrequencyData.length * 255));

      if (this.noiseCalibrationTimer >= this.noiseCalibrationDuration) {
        const samples = this.noiseCalibrationSamples;
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        const std = Math.sqrt(samples.reduce((a, v) => a + (v - mean) ** 2, 0) / samples.length);
        // Set floor at mean + 4*std — aggressively above ambient noise (fans, AC, etc)
        this.noiseFloor = Math.max(0.01, mean + std * 4);
        this.syllableThreshold = this.noiseFloor * 1.2;
        this.sustainedThreshold = this.noiseFloor * 1.5;
        // HF noise floor — mean + 2*std of HF energy during silence
        const hfMean = this.hfCalibrationSamples.reduce((a, b) => a + b, 0) / this.hfCalibrationSamples.length;
        const hfStd = Math.sqrt(this.hfCalibrationSamples.reduce((a, v) => a + (v - hfMean) ** 2, 0) / this.hfCalibrationSamples.length);
        this.hfNoiseFloor = hfMean + hfStd * 2;
        this.isCalibrated = true;
        console.log(`Noise calibrated: floor=${(this.noiseFloor * 1000).toFixed(1)}mRMS, hfFloor=${this.hfNoiseFloor.toFixed(4)} (ambient=${(mean * 1000).toFixed(1)}mRMS)`);
      }
      // During calibration, don't trigger any metrics
      return;
    }

    // --- Slow ongoing noise floor adaptation (for changing environments) ---
    if (rms < this.noiseFloor * 1.5 && rms > 0.001) {
      this.noiseFloor += (rms * 1.2 - this.noiseFloor) * this.noiseAdaptRate;
      this.noiseFloor = Math.max(0.005, this.noiseFloor);
      this.syllableThreshold = this.noiseFloor * 1.2;
      this.sustainedThreshold = this.noiseFloor * 1.5;
    }

    // --- Gate: subtract noise floor from RMS ---
    const gatedRms = Math.max(0, rms - this.noiseFloor);
    this.smoothEnergy += (gatedRms - this.smoothEnergy) * 0.15;

    this.energyHistory.push(gatedRms);
    if (this.energyHistory.length > this.energyHistoryMax) this.energyHistory.shift();
    this.energyBaselineWindow.push(gatedRms);
    if (this.energyBaselineWindow.length > this.energyBaselineWindowMax) this.energyBaselineWindow.shift();
    if (this.energyBaselineWindow.length >= 12) {
      this.energyPercentiles.p50 = this._percentile(this.energyBaselineWindow, 0.5);
      this.energyPercentiles.p75 = this._percentile(this.energyBaselineWindow, 0.75);
      this.energyPercentiles.p90 = this._percentile(this.energyBaselineWindow, 0.9);
    }

    // --- Pitch (only if above noise floor) ---
    let pitch = 0;
    if (rms > this.noiseFloor * 2) {
      pitch = this.detectPitch();
    }
    if (pitch > 0) {
      this.lastPitch = pitch;
      this.pitchHistory.push(pitch);
      if (this.pitchHistory.length > this.pitchHistoryMax) this.pitchHistory.shift();
      // Only update smooth Hz when confident — prevents flicker during breathy/whispered speech
      if (this.pitchConfidence > 0.4) {
        const lerpRate = 0.08 + this.pitchConfidence * 0.12; // faster lerp when more confident
        this.smoothPitchHz += (pitch - this.smoothPitchHz) * lerpRate;

        // --- ADAPTIVE PITCH RANGE LEARNING ---
        if (!this.pitchProfile.isLearned) {
          this.pitchProfile.samples.push(pitch);
          this.pitchProfile.voicedTime += dt;
          if (this.pitchProfile.voicedTime >= this.pitchProfile.learningDuration || this.pitchProfile.samples.length > 200) {
            const sorted = [...this.pitchProfile.samples].sort((a, b) => a - b);
            // Ignore lowest and highest 5% to remove potential octave errors
            const p05 = sorted[Math.floor(sorted.length * 0.05)];
            const p95 = sorted[Math.floor(sorted.length * 0.95)];

            this.pitchProfile.min = Math.max(50, p05 * 0.85);
            this.pitchProfile.max = Math.min(800, p95 * 1.25);
            this.pitchProfile.isLearned = true;
            console.log(`[VoxBall] Learned User Pitch Range: ${this.pitchProfile.min.toFixed(0)}Hz - ${this.pitchProfile.max.toFixed(0)}Hz`);
            console.log(`[ProsodyBall] Learned User Pitch Range: ${this.pitchProfile.min.toFixed(0)}Hz - ${this.pitchProfile.max.toFixed(0)}Hz`);
          }
        }
      }
    }

    // --- HF energy (articulation) — gated against both main noise floor and HF baseline ---
    this.analyserHF.getByteFrequencyData(this.hfFrequencyData);
    let hfEnergy = 0;
    for (let i = 0; i < this.hfFrequencyData.length; i++) {
      hfEnergy += this.hfFrequencyData[i];
    }
    hfEnergy = hfEnergy / (this.hfFrequencyData.length * 255);
    // Subtract HF baseline (fan/AC noise) — but keep it sensitive to speech consonants
    hfEnergy = Math.max(0, hfEnergy - this.hfNoiseFloor);
    // Only gate if WELL below speech level — consonants can be brief and quiet
    if (rms < this.noiseFloor * 1.3) hfEnergy = 0;

    this.analyser.getFloatFrequencyData(this.frequencyData);
    const fData = this.frequencyData;

    // ====== SPECTRAL TILT (dynamic pitch-aware band ratio) ======
    // Heavy band tracks lower harmonics around F0, light band samples 2.5k-5k breath/brightness.
    const fftBinHz = this.audioCtx.sampleRate / this.analyser.fftSize;
    const eps = 1e-12;
    const activeF0 = pitch > 0 ? pitch : (this.lastPitch > 0 ? this.lastPitch : this.smoothPitchHz || 160);
    const lowStartHz = Math.max(70, activeF0 * 0.5);
    const lowEndHz = Math.min(2200, activeF0 * 3.5);
    const highStartHz = 2500;
    const highEndHz = Math.min(5000, this.audioCtx.sampleRate * 0.5 - fftBinHz);

    const sumBandPower = (loHz, hiHz) => {
      if (hiHz <= loHz) return 0;
      const startBin = Math.max(0, Math.floor(loHz / fftBinHz));
      const endBin = Math.min(fData.length - 1, Math.ceil(hiHz / fftBinHz));
      if (endBin < startBin) return 0;
      let sum = 0;
      for (let i = startBin; i <= endBin; i++) {
        const mag = Math.pow(10, fData[i] / 20);
        sum += mag * mag;
      }
      return sum;
    };

    const eLowTilt = sumBandPower(lowStartHz, lowEndHz);
    const eHighTilt = sumBandPower(highStartHz, highEndHz);
    const rawTiltDb = 10 * Math.log10((eHighTilt + eps) / (eLowTilt + eps));
    this.spectralTiltRawDb = rawTiltDb;

    // EMA smoothing to reduce frame jitter while preserving control latency.
    const tiltAlpha = 0.16;
    this.spectralTiltSmoothedDb += (rawTiltDb - this.spectralTiltSmoothedDb) * tiltAlpha;

    // --- ADAPTIVE TILT RANGE LEARNING ---
    if (pitch > 0 && this.pitchConfidence > 0.4) {
      if (!this.tiltProfile.isLearned) {
        this.tiltProfile.samples.push(this.spectralTiltSmoothedDb);
        this.tiltProfile.voicedTime += dt;
        if (this.tiltProfile.voicedTime >= this.tiltProfile.learningDuration || this.tiltProfile.samples.length > 200) {
          const sorted = [...this.tiltProfile.samples].sort((a, b) => a - b);
          // Remove extreme outliers
          const p10 = sorted[Math.floor(sorted.length * 0.10)];
          const p90 = sorted[Math.floor(sorted.length * 0.90)];

          // Ensure a decent spread so control isn't overly twitchy
          const median = sorted[Math.floor(sorted.length * 0.5)];
          const spread = Math.max(16, p90 - p10); // Minimum 16dB range

          this.tiltProfile.min = median - spread * 0.55;
          this.tiltProfile.max = median + spread * 0.45;
          this.tiltProfile.isLearned = true;
          console.log(`[VoxBall] Learned User Tilt Range: ${this.tiltProfile.min.toFixed(1)}dB to ${this.tiltProfile.max.toFixed(1)}dB`);
          console.log(`[ProsodyBall] Learned User Tilt Range: ${this.tiltProfile.min.toFixed(1)}dB to ${this.tiltProfile.max.toFixed(1)}dB`);
        }
      }
    }

    // Typical speech tilt spans roughly -34dB (heavy) to -4dB (light) on mobile mics.
    const heavyAnchorDb = this.tiltProfile.isLearned ? this.tiltProfile.min : -34;
    const lightAnchorDb = this.tiltProfile.isLearned ? this.tiltProfile.max : -4;
    const normalized = normalizeAgainstRange(this.spectralTiltSmoothedDb, heavyAnchorDb, lightAnchorDb);
    const tiltConfidenceGate = rms > this.noiseFloor * 1.35 ? 1 : Math.max(0, (rms - this.noiseFloor) / Math.max(1e-6, this.noiseFloor * 0.5));
    this.spectralWeight += (normalized - this.spectralWeight) * (0.12 + tiltConfidenceGate * 0.2);
    this.spectralTiltConfidence += (tiltConfidenceGate - this.spectralTiltConfidence) * 0.2;

    // ====== FORMANT / RESONANCE ANALYSIS ======
    // Two-stage approach:
    //   Stage 1: Band energy ratios for vowel vs consonant detection (fast, always-on)
    //   Stage 2: Harmonic envelope peak-picking for F1/F2 estimation (only during voiced vowels)
    const binHz = this.audioCtx.sampleRate / this.analyser.fftSize;

    // --- Stage 1: Band energy for vowel detection ---
    const bandEnergy = (lo, hi) => {
      const startBin = Math.floor(lo / binHz);
      const endBin = Math.min(Math.ceil(hi / binHz), fData.length - 1);
      let sum = 0;
      for (let i = startBin; i <= endBin; i++) {
        sum += Math.pow(10, fData[i] / 20);
      }
      return sum / Math.max(1, endBin - startBin + 1);
    };

    const eLow = bandEnergy(250, 900);   // F1 region
    const eMid = bandEnergy(900, 2800);  // F2 region
    const eHigh = bandEnergy(2800, 6000); // Fricative region
    const eTotal = eLow + eMid + eHigh + 0.0001;

    const vowelRatio = (eLow + eMid) / eTotal;
    const fricativeRatio = eHigh / eTotal;
    const hasEnough = gatedRms > this.sustainedThreshold;
    const rawVowelLike = hasEnough ? Math.max(0, vowelRatio - fricativeRatio) : 0;
    this.vowelLikelihood += (rawVowelLike - this.vowelLikelihood) * 0.2;

    // --- Stage 2: Resonance estimation (method-selectable) ---
    // Only run during confident voiced vowels
    if (pitch > 0 && this.pitchConfidence > 0.4 && this.vowelLikelihood > 0.25) {
      this.analyserFormant.getFloatFrequencyData(this.formantFreqData);

      let f1Candidate = 0, f2Candidate = 0, f3Candidate = 0, conf = 0;

      switch (this.resonanceMethod) {
        case 'harmonic':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceHarmonicEnvelope(pitch));
          break;
        case 'cepstral':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceCepstral(pitch));
          break;
        case 'lpc':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceLPC());
          break;
        case 'centroid':
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceCentroid());
          break;
        default:
          ({ f1: f1Candidate, f2: f2Candidate, f3: f3Candidate, confidence: conf } =
            this._resonanceHarmonicEnvelope(pitch));
      }

      // --- Formant continuity constraint ---
      // Penalize large frame-to-frame jumps: if a candidate is very far from the
      // current smoothed value, reduce its lerp weight. This prevents a single
      // bad frame from pulling the estimate off track while still allowing
      // gradual real changes (e.g., vowel transitions over ~50-100ms).
      const maxJump = { f1: 300, f2: 500, f3: 600 }; // Hz: max "trusted" jump per frame
      const jumpPenalty = (candidate, current, maxJ) => {
        if (candidate <= 0) return 0;
        const dist = Math.abs(candidate - current);
        // Smooth sigmoid: full weight at 0 jump, ~0.15 weight at maxJump, ~0.02 at 2×maxJump
        return 1 / (1 + (dist / maxJ) * (dist / maxJ));
      };
      const f1Trust = jumpPenalty(f1Candidate, this.smoothF1, maxJump.f1);
      const f2Trust = jumpPenalty(f2Candidate, this.smoothF2, maxJump.f2);
      const f3Trust = jumpPenalty(f3Candidate || 0, this.smoothF3, maxJump.f3);

      // --- Method-specific base smoothing rates ---
      // LPC root-solving gives precise formants → fast lerp
      // Harmonic envelope is good but discrete (harmonic-resolution limited) → medium
      // Cepstral is smooth but broad → medium-slow
      // Centroid conflates pitch → slowest (most smoothing needed)
      const methodLerp = {
        lpc: { base: 0.10, confScale: 0.12 },  // fast: precise root-solved values
        harmonic: { base: 0.06, confScale: 0.10 },  // medium: harmonic-resolution limited
        cepstral: { base: 0.05, confScale: 0.08 },  // medium-slow: broad smoothing
        centroid: { base: 0.03, confScale: 0.06 }   // slow: inherently noisy
      };
      const ml = methodLerp[this.resonanceMethod] || methodLerp.harmonic;
      const baseLerp = ml.base + conf * ml.confScale;

      // Update smoothed formants with continuity-weighted lerp
      if (f1Candidate > 0) {
        this.smoothF1 += (f1Candidate - this.smoothF1) * baseLerp * f1Trust;
      }
      if (f2Candidate > 0) {
        this.smoothF2 += (f2Candidate - this.smoothF2) * baseLerp * f2Trust;
      }
      if (f3Candidate > 0) {
        this.smoothF3 += (f3Candidate - this.smoothF3) * baseLerp * f3Trust;
      }
      this.formantConfidence += (conf - this.formantConfidence) * 0.15;

      // --- Resonance score: F2-primary with F1 and F3 contributions ---
      // Clinical references:
      //   F2 < ~1400 Hz = clearly dark/masculine placement
      //   F2 > ~2400 Hz = clearly bright/feminine placement
      //   F1 higher = more open/forward resonance
      //   F3 > ~2800 Hz adds to perceived femininity (Hillenbrand 1995, Gelfer 2000)
      const f2Score = Math.max(0, Math.min(1, (this.smoothF2 - 1000) / 1800));
      const f1Score = Math.max(0, Math.min(1, (this.smoothF1 - 300) / 600));
      const f3Score = Math.max(0, Math.min(1, (this.smoothF3 - 2200) / 1200));
      const rawResonance = f2Score * 0.70 + f1Score * 0.15 + f3Score * 0.15;
      this.smoothResonance += (rawResonance - this.smoothResonance) * (0.05 + conf * 0.08);
    } else {
      // During silence/unvoiced: decay confidence, hold resonance steady
      this.formantConfidence *= 0.95;
    }

    // ====== METRICS ======

    // 1. BOUNCE — pitch variation
    if (this.pitchHistory.length > 3) {
      const mean = this.pitchHistory.reduce((a, b) => a + b, 0) / this.pitchHistory.length;
      const variance = this.pitchHistory.reduce((a, p) => a + (p - mean) ** 2, 0) / this.pitchHistory.length;
      this.metrics.bounce = Math.min(1, Math.sqrt(variance) / 70);
    } else {
      this.metrics.bounce *= 0.95;
    }

    // Pre-calculate robust baseline for dynamic thresholding across metrics
    const baseEnergyRange = Math.max(0.001, this.energyPercentiles.p90 - this.energyPercentiles.p50);

    // 2. TEMPO — energy transition rate (uses gated energy history)
    if (this.energyHistory.length > 5) {
      let transitions = 0;
      const thresh = this.energyPercentiles.p50 + baseEnergyRange * 0.5;
      for (let i = 1; i < this.energyHistory.length; i++) {
        if ((this.energyHistory[i - 1] > thresh) !== (this.energyHistory[i] > thresh)) transitions++;
      }
      this.metrics.tempo = Math.min(1, transitions / 12);
    }

    // 3. VOWEL ELONGATION — sustained voicing WITH vowel-like formants
    //    Uses vowelLikelihood to distinguish real vowels from "sss" or "mmm"
    const dynamicSustainThreshold = this.energyPercentiles.p50 + baseEnergyRange * 0.4;
    const isVowelSound = gatedRms > dynamicSustainThreshold && pitch > 0 && this.vowelLikelihood > 0.3;
    if (isVowelSound) {
      this.sustainedDuration += dt * (0.5 + this.vowelLikelihood * 0.5); // stronger vowels accumulate faster
    } else {
      this.sustainedDuration *= 0.85;
    }
    this.metrics.vowel = Math.min(1, Math.max(0, this.sustainedDuration - 0.15) / 0.6);

    // 4. ARTICULATION — HF bursts (boosted sensitivity for consonant detection)
    const articTarget = normalizeAgainstPercentiles(hfEnergy, this.hfNoiseFloor, Math.max(this.hfNoiseFloor + 0.02, this.hfNoiseFloor * 3.5), 1.2);
    this.metrics.articulation += (articTarget - this.metrics.articulation) * 0.3;

    // 5. SYLLABLE SEPARATION — energy onset detection (uses gated energy)
    const dynamicSyllableOn = this.energyPercentiles.p50 + baseEnergyRange * 0.6;
    const dynamicSyllableOff = this.energyPercentiles.p50 + baseEnergyRange * 0.15;
    const syllableOnThreshold = Math.max(0.005, dynamicSyllableOn);
    const syllableOffThreshold = Math.max(0.002, dynamicSyllableOff);
    if (gatedRms > syllableOnThreshold && this.syllableState === 'silent') {
      if (now - this.lastSyllableTime > 0.08) {
        this.lastSyllableTime = now;
        this.syllableImpulse = 1.0;
      }
      this.syllableState = 'voiced';
    } else if (gatedRms < syllableOffThreshold) {
      this.syllableState = 'silent';
    }
    this.syllableImpulse *= 0.88;
    this.metrics.syllable = this.syllableImpulse;

    const voicedStrength = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1);
    const pitchGate = pitch > 0 ? 1 : 0.35;
    const { confidenceGate, voicedGate, reliableFrame } = computeFrameReliability({
      pitchConfidence: this.pitchConfidence,
      formantConfidence: this.formantConfidence,
      voicedStrength,
      spectralTiltConfidence: this.spectralTiltConfidence
    });

    // Stricter confidence gating
    if (!reliableFrame && gatedRms < this.energyPercentiles.p75) {
      // Freeze/slow-decay updates when signal is muddy or user is breathing
      this.metrics.bounce *= 0.95;
      this.metrics.tempo *= 0.98;
    } else {
      this.metrics.bounce *= confidenceGate * pitchGate;
      this.metrics.tempo *= voicedGate;
    }

    this.metrics.articulation *= Math.max(0.25, voicedGate * 0.8 + confidenceGate * 0.2);
    this.metrics.syllable *= voicedGate;

    const pitchRange = Math.max(50, this.pitchProfile.max - this.pitchProfile.min);
    this.metrics.pitch = pitch > 0 ? Math.max(0, Math.min(1, (pitch - this.pitchProfile.min) / pitchRange)) : this.metrics.pitch * 0.95;
    this.metrics.energy = normalizeAgainstPercentiles(gatedRms, this.energyPercentiles.p50, this.energyPercentiles.p90, 1.1);
    this.metrics.resonance = this.smoothResonance;
  }

  // ============================================
  // RESONANCE METHOD A: Harmonic Envelope (Refined)
  // Samples FFT at harmonics of F0 to extract the vocal tract transfer function.
  // Improvements over v1:
  //  - 5-point Gaussian-weighted envelope smoothing (better noise rejection)
  //  - Parabolic interpolation of FREQUENCY at envelope peaks (sub-harmonic resolution)
  //  - Spectral tilt compensation (removes ~6 dB/octave glottal source rolloff)
  //  - F3 estimation for additional resonance information
  // ============================================
  _resonanceHarmonicEnvelope(pitch) {
    const fmtData = this.formantFreqData;
    const f0 = pitch;
    const binHz = this.audioCtx.sampleRate / this.analyserFormant.fftSize;
    const maxHarmonicHz = 5500;
    const numHarmonics = Math.min(40, Math.floor(maxHarmonicHz / f0));

    if (numHarmonics < 4) return { f1: 0, f2: 0, f3: 0, confidence: 0 };

    // Sample FFT at each harmonic with peak-search and parabolic amplitude interpolation
    const harmonicAmps = this._getBuffer('harmonicAmps', Float32Array, numHarmonics);
    for (let h = 0; h < numHarmonics; h++) {
      const hFreq = f0 * (h + 1);
      const bin = hFreq / binHz;
      const binInt = Math.floor(bin);
      if (binInt < 1 || binInt + 1 >= fmtData.length) continue;

      // Search ±30% of harmonic spacing for actual peak
      let peakBin = binInt, peakVal = fmtData[binInt];
      const searchRange = Math.max(1, Math.floor(f0 / binHz * 0.3));
      for (let s = -searchRange; s <= searchRange; s++) {
        const idx = binInt + s;
        if (idx >= 0 && idx < fmtData.length && fmtData[idx] > peakVal) {
          peakVal = fmtData[idx]; peakBin = idx;
        }
      }
      // Parabolic interpolation for sub-bin amplitude
      if (peakBin > 0 && peakBin < fmtData.length - 1) {
        const a = fmtData[peakBin - 1], b = fmtData[peakBin], c = fmtData[peakBin + 1];
        const denom = a - 2 * b + c;
        harmonicAmps[h] = Math.abs(denom) > 0.001 ? b - (a - c) * (a - c) / (8 * denom) : b;
      } else {
        harmonicAmps[h] = peakVal;
      }
    }

    // Spectral tilt compensation: +6 dB/octave to counteract glottal source rolloff
    // This prevents F1 from always dominating F2 in the envelope
    for (let h = 0; h < numHarmonics; h++) {
      const hFreq = f0 * (h + 1);
      harmonicAmps[h] += 6 * Math.log2(hFreq / f0); // +6 dB per octave
    }

    // 5-point Gaussian-weighted smoothing (σ ≈ 1.0 harmonics)
    const gWeights = [0.06, 0.24, 0.40, 0.24, 0.06];
    const env = this._getBuffer('env', Float32Array, numHarmonics);
    for (let i = 0; i < numHarmonics; i++) {
      let sum = 0, wSum = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j >= 0 && j < numHarmonics) {
          sum += harmonicAmps[j] * gWeights[k + 2];
          wSum += gWeights[k + 2];
        }
      }
      env[i] = sum / wSum;
    }

    return this._peakPickFormants(env, f0, numHarmonics);
  }

  // ============================================
  // RESONANCE METHOD B: Cepstral Smoothing (Refined)
  // True cepstral-style spectral envelope extraction.
  // Improvements over v1:
  //  - Window width = 1.5× harmonic spacing (fully suppresses harmonic ripple)
  //  - Spectral tilt pre-compensation (+6 dB/oct before smoothing)
  //  - Parabolic interpolation at spectral peaks for sub-bin accuracy
  //  - Proper triangular weighting kernel (better sidelobe rejection vs box filter)
  // ============================================
  _resonanceCepstral(pitch) {
    const fmtData = this.formantFreqData;
    const binHz = this.audioCtx.sampleRate / this.analyserFormant.fftSize;
    const numBins = fmtData.length;

    // 1.5× harmonic spacing fully fills gaps between harmonics
    const smoothWidth = Math.max(5, Math.round(1.5 * pitch / binHz));
    const halfW = Math.floor(smoothWidth / 2);

    // Pre-pass: spectral tilt compensation (+6 dB/octave relative to F0)
    // Applied BEFORE smoothing so it isn't diluted by the averaging kernel.
    // This counteracts the natural glottal source rolloff that makes F2/F3
    // peaks appear 6-12 dB weaker than F1 in the raw spectrum.
    const tiltComp = this._getBuffer('tiltComp', Float32Array, numBins);
    for (let i = 0; i < numBins; i++) {
      const freq = i * binHz;
      tiltComp[i] = fmtData[i] + (freq > pitch ? 6 * Math.log2(freq / pitch) : 0);
    }

    // Triangular kernel smoothing on tilt-compensated spectrum
    // Triangular shape: center-weighted, zero at edges — better sidelobe
    // rejection than a box filter, cleaner envelope extraction
    const smoothed = this._getBuffer('smoothed', Float32Array, numBins);
    for (let i = 0; i < numBins; i++) {
      let sum = 0, wSum = 0;
      for (let j = i - halfW; j <= i + halfW; j++) {
        if (j >= 0 && j < numBins) {
          const dist = Math.abs(j - i);
          const triWeight = 1 - dist / (halfW + 1);
          sum += tiltComp[j] * triWeight;
          wSum += triWeight;
        }
      }
      smoothed[i] = sum / wSum;
    }

    // Peak-pick with parabolic interpolation
    const minF1Hz = 200, maxF1Hz = 1100;
    const minF2Hz = 800, maxF2Hz = 3500;
    const minF3Hz = 2200, maxF3Hz = 4200;
    const minSepHz = 300;

    let f1 = 0, f1Amp = -Infinity;
    let f2 = 0, f2Amp = -Infinity;
    let f3 = 0, f3Amp = -Infinity;

    // Collect all peaks with parabolic refinement
    const peaks = [];
    const f1Start = Math.max(2, Math.floor(minF1Hz / binHz));
    const f3End = Math.min(Math.ceil(maxF3Hz / binHz), numBins - 2);
    for (let i = f1Start; i <= f3End; i++) {
      if (smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) {
        // Parabolic interpolation for sub-bin frequency
        const a = smoothed[i - 1], b = smoothed[i], c = smoothed[i + 1];
        const denom = a - 2 * b + c;
        let refinedBin = i;
        let refinedAmp = b;
        if (Math.abs(denom) > 0.001) {
          const delta = 0.5 * (a - c) / denom;
          refinedBin = i + Math.max(-0.5, Math.min(0.5, delta));
          refinedAmp = b - (a - c) * (a - c) / (8 * denom);
        }
        peaks.push({ freq: refinedBin * binHz, amp: refinedAmp });
      }
    }

    // Assign peaks to F1, F2, F3
    for (const p of peaks) {
      if (p.freq >= minF1Hz && p.freq <= maxF1Hz && p.amp > f1Amp) {
        f1Amp = p.amp; f1 = p.freq;
      }
    }
    const f2Floor = Math.max(minF2Hz, f1 + minSepHz);
    for (const p of peaks) {
      if (p.freq >= f2Floor && p.freq <= maxF2Hz && p.amp > f2Amp) {
        f2Amp = p.amp; f2 = p.freq;
      }
    }
    const f3Floor = Math.max(minF3Hz, f2 + minSepHz);
    for (const p of peaks) {
      if (p.freq >= f3Floor && p.freq <= maxF3Hz && p.amp > f3Amp) {
        f3Amp = p.amp; f3 = p.freq;
      }
    }

    // Confidence
    const specSlice = smoothed.subarray(f1Start, f3End + 1);
    const specMin = Math.min(...specSlice);
    const specRange = Math.max(...specSlice) - specMin;
    let conf = 0;
    if (specRange > 1) {
      const f1P = f1 > 0 ? Math.min(1, (f1Amp - specMin) / specRange) : 0.1;
      const f2P = f2 > 0 ? Math.min(1, (f2Amp - specMin) / specRange) : 0.1;
      conf = Math.min(1, ((f1P + f2P) / 2) * this.pitchConfidence * (this.vowelLikelihood + 0.3));
    }
    if (f1 === 0) f1 = 500;
    if (f2 === 0) f2 = 1500;

    return { f1, f2, f3, confidence: conf };
  }

  // ============================================
  // RESONANCE METHOD C: LPC with Root-Solving (Refined)
  // The Praat-style gold standard approach.
  // Improvements over v1:
  //  - Downsamples to ~11 kHz before LPC (proper Praat approach — concentrates
  //    modeling capacity on the formant region instead of wasting poles on > 5kHz)
  //  - Adaptive order = 2 + downsampledRate/1000 (≈ 13 for 11kHz → 6 pole pairs)
  //  - Root-solving on the LPC polynomial for direct formant extraction
  //    (gives exact frequency + bandwidth, not just spectral peak approx)
  //  - Formant bandwidth rejection (bandwidth > 500 Hz → likely not a real formant)
  // ============================================
  _resonanceLPC() {
    const td = this.timeDomainData;
    const N = td.length;
    const sampleRate = this.audioCtx.sampleRate;

    // --- Downsample to ~11 kHz for proper formant resolution ---
    // Factor = ceil(sampleRate / 11000)
    const dsFactor = Math.max(1, Math.round(sampleRate / 11000));
    const dsRate = sampleRate / dsFactor;
    const dsN = Math.floor(N / dsFactor);
    if (dsN < 50) return { f1: 0, f2: 0, f3: 0, confidence: 0 };

    // Anti-aliasing filter before decimation: 2nd-order Butterworth low-pass
    // Cutoff at dsRate/2 (Nyquist of target rate) to prevent spectral aliasing
    // This is critical — without it, energy above dsRate/2 folds back into
    // the formant region and corrupts F1/F2/F3 estimates
    const cutoffHz = dsRate * 0.45; // slightly below Nyquist to avoid ringing
    const wc = Math.tan(Math.PI * cutoffHz / sampleRate);
    const wc2 = wc * wc;
    const sqrt2 = Math.SQRT2;
    const k = 1 / (1 + sqrt2 * wc + wc2);
    const b0 = wc2 * k, b1 = 2 * b0, b2 = b0;
    const a1 = 2 * (wc2 - 1) * k;
    const a2 = (1 - sqrt2 * wc + wc2) * k;

    // Apply filter + decimate in one pass
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const filtered = this._getBuffer('filtered', Float32Array, dsN);
    let dsIdx = 0, sampleCount = 0;
    for (let i = 0; i < N; i++) {
      const x0 = td[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      sampleCount++;
      if (sampleCount >= dsFactor) {
        if (dsIdx < dsN) filtered[dsIdx++] = y0;
        sampleCount = 0;
      }
    }

    // Pre-emphasis on filtered/downsampled signal
    const preEmph = this._getBuffer('preEmph', Float32Array, dsN);
    preEmph[0] = filtered[0];
    for (let i = 1; i < dsN; i++) {
      preEmph[i] = filtered[i] - 0.97 * filtered[i - 1];
    }

    // Hamming window
    const windowed = this._getBuffer('windowed', Float32Array, dsN);
    for (let i = 0; i < dsN; i++) {
      windowed[i] = preEmph[i] * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (dsN - 1)));
    }

    // Adaptive LPC order: 2 + dsRate/1000 ≈ 13 for 11kHz
    const order = Math.min(20, Math.max(8, Math.round(2 + dsRate / 1000)));

    // Autocorrelation
    const R = this._getBuffer('R', Float64Array, order + 1);
    for (let k = 0; k <= order; k++) {
      let sum = 0;
      for (let i = 0; i < dsN - k; i++) sum += windowed[i] * windowed[i + k];
      R[k] = sum;
    }
    if (R[0] < 1e-10) return { f1: 0, f2: 0, f3: 0, confidence: 0 };

    // Levinson-Durbin
    const a = this._getBuffer('a', Float64Array, order + 1);
    const aTemp = this._getBuffer('aTemp', Float64Array, order + 1);
    let E = R[0];
    for (let i = 1; i <= order; i++) {
      let lambda = 0;
      for (let j = 1; j < i; j++) lambda += a[j] * R[i - j];
      lambda = (R[i] - lambda) / E;
      for (let j = 1; j < i; j++) aTemp[j] = a[j] - lambda * a[i - j];
      aTemp[i] = lambda;
      for (let j = 1; j <= i; j++) a[j] = aTemp[j];
      E *= (1 - lambda * lambda);
      if (E < 1e-20) break;
    }

    // --- Root-solving via companion matrix eigenvalues ---
    // Find roots of A(z) = 1 - a[1]z^-1 - a[2]z^-2 - ...
    // Equivalent polynomial: z^order - a[1]z^(order-1) - ... - a[order] = 0
    // We use Durand-Kerner iterative root finding (works well for moderate orders)
    const roots = this._findLPCRoots(a, order);

    // Extract formants from roots: each complex conjugate pair with positive
    // imaginary part gives a formant frequency and bandwidth
    const formants = [];
    for (const root of roots) {
      if (root.im <= 0) continue; // only positive-frequency roots
      const freq = Math.atan2(root.im, root.re) * dsRate / (2 * Math.PI);
      const mag = Math.sqrt(root.re * root.re + root.im * root.im);
      const bw = -dsRate * Math.log(mag) / Math.PI; // bandwidth in Hz

      // Reject: frequency out of range, bandwidth too wide (> 600 Hz), or too narrow
      if (freq >= 90 && freq <= 5000 && bw > 30 && bw < 600) {
        formants.push({ freq, bw });
      }
    }

    // Sort by frequency
    formants.sort((a, b) => a.freq - b.freq);

    // Assign formants with constraints, tracking bandwidths
    let f1 = 0, f2 = 0, f3 = 0;
    let f1Bw = 999, f2Bw = 999, f3Bw = 999;
    const minSep = 200; // minimum Hz between formants

    for (const fm of formants) {
      if (f1 === 0 && fm.freq >= 150 && fm.freq <= 1200) {
        f1 = fm.freq; f1Bw = fm.bw;
      } else if (f2 === 0 && fm.freq >= 600 && fm.freq <= 3500 && fm.freq > (f1 || 0) + minSep) {
        f2 = fm.freq; f2Bw = fm.bw;
      } else if (f3 === 0 && fm.freq >= 2000 && fm.freq <= 4500 && fm.freq > (f2 || 0) + minSep) {
        f3 = fm.freq; f3Bw = fm.bw;
      }
    }

    // Confidence: nFound × voicing × bandwidth sharpness
    // Narrower bandwidths = sharper formants = more reliable estimate
    // Typical speech formant bandwidths: F1~60-100 Hz, F2~80-120 Hz, F3~100-200 Hz
    const nFound = (f1 > 0 ? 1 : 0) + (f2 > 0 ? 1 : 0) + (f3 > 0 ? 1 : 0);
    let bwScore = 0;
    if (f1 > 0) bwScore += Math.max(0, 1 - f1Bw / 400); // 0 at 400+ Hz, 1 at 0 Hz
    if (f2 > 0) bwScore += Math.max(0, 1 - f2Bw / 400);
    bwScore = nFound > 0 ? bwScore / Math.min(2, nFound) : 0; // avg of found F1/F2 bw scores
    const conf = Math.min(1, (nFound / 3) * bwScore * this.pitchConfidence * (this.vowelLikelihood + 0.3) * 2.5);

    if (f1 === 0) f1 = 500;
    if (f2 === 0) f2 = 1500;

    return { f1, f2, f3, confidence: conf };
  }

  // Durand-Kerner root finding for LPC polynomial
  // Finds all roots of z^n - a[1]z^(n-1) - a[2]z^(n-2) - ... - a[n] = 0
  _findLPCRoots(a, order) {
    // Initial guesses: evenly distributed on unit circle
    const roots = [];
    for (let k = 0; k < order; k++) {
      const angle = 2 * Math.PI * (k + 0.5) / order;
      const r = 0.9 + 0.05 * Math.random(); // slightly inside unit circle
      roots.push({ re: r * Math.cos(angle), im: r * Math.sin(angle) });
    }

    // Evaluate polynomial at point z: z^order - a[1]*z^(order-1) - ... - a[order]
    const evalPoly = (z) => {
      // Horner's method: P(z) = ((..((z - a[1])*z - a[2])*z ... ) - a[order])
      let re = 1, im = 0; // leading coefficient
      for (let j = 1; j <= order; j++) {
        // Multiply by z
        const newRe = re * z.re - im * z.im;
        const newIm = re * z.im + im * z.re;
        // Subtract a[j]
        re = newRe - a[j];
        im = newIm;
      }
      return { re, im };
    };

    // Iterate
    const maxIter = 50;
    for (let iter = 0; iter < maxIter; iter++) {
      let maxDelta = 0;
      for (let k = 0; k < order; k++) {
        const z = roots[k];
        const pz = evalPoly(z);

        // Product of (z_k - z_j) for j ≠ k
        let prodRe = 1, prodIm = 0;
        for (let j = 0; j < order; j++) {
          if (j === k) continue;
          const dRe = z.re - roots[j].re;
          const dIm = z.im - roots[j].im;
          const newProdRe = prodRe * dRe - prodIm * dIm;
          const newProdIm = prodRe * dIm + prodIm * dRe;
          prodRe = newProdRe;
          prodIm = newProdIm;
        }

        // delta = P(z) / product
        const denom = prodRe * prodRe + prodIm * prodIm + 1e-30;
        const deltaRe = (pz.re * prodRe + pz.im * prodIm) / denom;
        const deltaIm = (pz.im * prodRe - pz.re * prodIm) / denom;

        roots[k] = { re: z.re - deltaRe, im: z.im - deltaIm };
        maxDelta = Math.max(maxDelta, Math.sqrt(deltaRe * deltaRe + deltaIm * deltaIm));
      }
      if (maxDelta < 1e-8) break; // converged
    }

    return roots;
  }

  // ============================================
  // RESONANCE METHOD D: Spectral Centroid (Refined Baseline)
  // Improved control/baseline for comparison.
  // Improvements:
  //  - Amplitude clamping prevents extreme dB values from dominating centroid
  //  - Spectral concentration (kurtosis) as proper confidence measure
  //  - Third-band centroid for F3 region
  //  - Noise floor subtraction from linear amplitudes
  // ============================================
  _resonanceCentroid() {
    const fmtData = this.formantFreqData;
    const binHz = this.audioCtx.sampleRate / this.analyserFormant.fftSize;
    const numBins = fmtData.length;

    // Convert dB to linear with floor clamping (prevents extreme values)
    const noiseFloorDb = -80;
    const linearAmp = (bin) => {
      const db = Math.max(noiseFloorDb, fmtData[bin]);
      return Math.pow(10, (db - noiseFloorDb) / 20); // normalized: 0 at noise floor
    };

    // Helper: weighted centroid + concentration for a band
    const bandAnalysis = (loHz, hiHz) => {
      const startBin = Math.max(0, Math.floor(loHz / binHz));
      const endBin = Math.min(numBins - 1, Math.ceil(hiHz / binHz));
      let wFreq = 0, wSum = 0, wFreqSq = 0;
      for (let i = startBin; i <= endBin; i++) {
        const amp = linearAmp(i);
        const freq = i * binHz;
        wFreq += freq * amp;
        wFreqSq += freq * freq * amp;
        wSum += amp;
      }
      if (wSum < 0.001) return { centroid: (loHz + hiHz) / 2, concentration: 0 };
      const centroid = wFreq / wSum;
      const variance = wFreqSq / wSum - centroid * centroid;
      const bandWidth = hiHz - loHz;
      // Concentration: 1 when perfectly focused, 0 when spread across band
      const concentration = Math.max(0, 1 - Math.sqrt(Math.max(0, variance)) / (bandWidth * 0.35));
      return { centroid, concentration };
    };

    const b1 = bandAnalysis(200, 1100);
    const b2 = bandAnalysis(900, 3500);
    const b3 = bandAnalysis(2200, 4200);

    // Confidence from concentration × voicing quality
    const avgConcentration = (b1.concentration + b2.concentration) / 2;
    const conf = Math.min(1, avgConcentration * this.pitchConfidence * (this.vowelLikelihood + 0.3));

    return { f1: b1.centroid, f2: b2.centroid, f3: b3.centroid, confidence: conf };
  }

  // Shared formant peak-picking for harmonic envelope methods (A)
  // Finds F1, F2, F3 with constraints, fallbacks, and confidence scoring
  _peakPickFormants(env, f0, numHarmonics) {
    const minF1Hz = 200, maxF1Hz = 1100;
    const minF2Hz = 800, maxF2Hz = 3500;
    const minF3Hz = 2200, maxF3Hz = 4200;
    const minSepHz = 300;

    // Collect all local maxima with parabolic frequency interpolation
    const peaks = [];
    for (let i = 1; i < numHarmonics - 1; i++) {
      if (env[i] > env[i - 1] && env[i] > env[i + 1]) {
        const a = env[i - 1], b = env[i], c = env[i + 1];
        const denom = a - 2 * b + c;
        let refinedIdx = i;
        let refinedAmp = b;
        if (Math.abs(denom) > 0.001) {
          const delta = 0.5 * (a - c) / denom;
          refinedIdx = i + Math.max(-0.5, Math.min(0.5, delta));
          refinedAmp = b - (a - c) * (a - c) / (8 * denom);
        }
        // Map harmonic index to frequency: H(i+1) = f0 * (i+1)
        // With fractional index: f0 * (refinedIdx + 1)
        peaks.push({ freq: f0 * (refinedIdx + 1), amp: refinedAmp });
      }
    }

    let f1 = 0, f1Amp = -Infinity;
    let f2 = 0, f2Amp = -Infinity;
    let f3 = 0, f3Amp = -Infinity;
    let usedF1Fallback = false, usedF2Fallback = false;

    // Assign F1
    for (const p of peaks) {
      if (p.freq >= minF1Hz && p.freq <= maxF1Hz && p.amp > f1Amp) {
        f1Amp = p.amp; f1 = p.freq;
      }
    }

    // Assign F2
    const f2FloorHz = Math.max(minF2Hz, f1 + minSepHz);
    for (const p of peaks) {
      if (p.freq >= f2FloorHz && p.freq <= maxF2Hz && p.amp > f2Amp) {
        f2Amp = p.amp; f2 = p.freq;
      }
    }

    // Assign F3
    const f3FloorHz = Math.max(minF3Hz, f2 + minSepHz);
    for (const p of peaks) {
      if (p.freq >= f3FloorHz && p.freq <= maxF3Hz && p.amp > f3Amp) {
        f3Amp = p.amp; f3 = p.freq;
      }
    }

    // Fallbacks: band-energy centroid (mark as lower confidence)
    if (f1 === 0) {
      usedF1Fallback = true;
      let w = 0, wS = 0;
      for (let i = 0; i < numHarmonics; i++) {
        const hFreq = f0 * (i + 1);
        if (hFreq >= minF1Hz && hFreq <= maxF1Hz) {
          const amp = Math.pow(10, env[i] / 20);
          w += hFreq * amp; wS += amp;
        }
      }
      f1 = wS > 0 ? w / wS : 500;
    }
    if (f2 === 0) {
      usedF2Fallback = true;
      let w = 0, wS = 0;
      for (let i = 0; i < numHarmonics; i++) {
        const hFreq = f0 * (i + 1);
        if (hFreq >= f2FloorHz && hFreq <= maxF2Hz) {
          const amp = Math.pow(10, env[i] / 20);
          w += hFreq * amp; wS += amp;
        }
      }
      f2 = wS > 0 ? w / wS : 1500;
    }

    const envMin = Math.min(...env);
    const envRange = Math.max(...env) - envMin;
    let prominence = 0;
    if (envRange > 0) {
      const f1P = usedF1Fallback ? 0.2 : Math.min(1, (f1Amp - envMin) / envRange);
      const f2P = usedF2Fallback ? 0.2 : Math.min(1, (f2Amp - envMin) / envRange);
      prominence = (f1P + f2P) / 2;
    }
    const confidence = Math.min(1, prominence * this.pitchConfidence * (this.vowelLikelihood + 0.3));

    return { f1, f2, f3, confidence };
  }
}

// ============================================================
// PARTICLE — uses RGB for proper alpha rendering
// ============================================================
class Particle {
  constructor(x, y, r, g, b, vx, vy, life, size) {
    this.x = x; this.y = y;
    this.r = r; this.g = g; this.b = b;
    this.vx = vx; this.vy = vy;
    this.life = life; this.maxLife = life;
    this.size = size;
  }
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += 120 * dt;
    this.life -= dt;
  }
  draw(ctx) {
    const alpha = Math.max(0, this.life / this.maxLife) * 0.8;
    ctx.fillStyle = `rgba(${this.r},${this.g},${this.b},${alpha})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * (this.life / this.maxLife), 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================================
// MAIN GAME
// ============================================================
class VoxBallGame {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.analyzer = new VoiceAnalyzer();
    this.isRunning = false;
    this.lastTime = 0;
    this.idleAnimId = null;

    // FIX: Store ball color as HSL components for proper HSLA compositing
    this.ballHue = 275;
    this.ballSat = 70;
    this.ballLit = 55;

    this.ball = {
      x: 0, y: 0, vy: 0,
      radius: 22, baseRadius: 22, targetRadius: 22,
      rotation: 0, squash: 1, onGround: true
    };

    this.groundY = 0;
    this.scrollX = 0;
    this.scrollSpeed = 120;
    this.targetScrollSpeed = 120;
    this.cameraY = 0;       // current camera vertical offset (negative = looking up)
    this.targetCameraY = 0; // smooth target
    this.cameraZoom = 1.4;  // current zoom level
    this.targetZoom = 1.4;  // target zoom (computed from ball height)
    this.prosodyScore = 0;  // smoothed composite prosody signal (0=monotone, 1=expressive)
    this.particles = [];
    this.trailPoints = [];
    this.sparkles = [];
    this.themeMode = 'highcontrast';
    this.colorblindMode = false;
    this.gameMode = 'ball'; // 'ball' | 'creature' | 'garden' | 'canvas' | 'keyboard' | 'pilot' | 'road'
    this.gameMode = 'ball'; // 'ball' | 'creature' | 'garden' | 'canvas' | 'keyboard' | 'pilot' | 'road' | 'ascent' | 'prism'

    // ====== CREATURE STATE ======
    this.creature = {
      points: [],       // 12 radial control points
      breath: 0,        // breathing phase
      floatY: 0,        // vertical float offset
      glow: 0,          // inner glow intensity (0-1)
      wingSpread: 0,    // transformation: wing unfurl (0-1)
      pulseRings: [],   // syllable pulse ring effects
      tendrils: [],     // active tendril state
      tendrilGrow: 0,   // vowel-driven tendril extension (0-1)
      auraParticles: [],// floating ambient particles
      morphTime: 0,     // organic wobble phase
      transformLevel: 0,// sustained prosody → transformation (0-1)
    };
    // Init 12 body points
    for (let i = 0; i < 12; i++) {
      this.creature.points.push({
        angle: (i / 12) * Math.PI * 2,
        baseR: 60,
        r: 60,
        targetR: 60,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.8 + Math.random() * 0.6,
      });
    }
    // Init 6 tendrils
    for (let i = 0; i < 6; i++) {
      this.creature.tendrils.push({
        angle: (i / 6) * Math.PI * 2 + Math.PI / 6,
        length: 0, targetLength: 0,
        curl: Math.random() * 0.5 - 0.25,
        phase: Math.random() * Math.PI * 2,
        width: 2 + Math.random() * 2,
      });
    }

    // ====== CREATURE STYLE ======
    this.creatureStyle = 'jellyfish';

    // Jellyfish state
    this._jelly = {
      bellW: 65, bellH: 55, floatY: 0, breath: 0, pulsePhase: 0,
      biolumFlash: 0, glow: 0.15, transformLevel: 0,
      bellEdge: [], tentacles: [], particles: [],
    };
    for (let i = 0; i < 20; i++) {
      this._jelly.bellEdge.push({ phase: Math.random() * Math.PI * 2, speed: 0.6 + Math.random() * 0.5 });
    }
    for (let i = 0; i < 8; i++) {
      this._jelly.tentacles.push({
        x: -0.35 + (i / 7) * 0.7, length: 30 + Math.random() * 20,
        targetLen: 30, phase: Math.random() * Math.PI * 2,
        curl: 0.08 + Math.random() * 0.12, width: 1.2 + Math.random() * 1.5,
      });
    }

    // Phoenix state
    this._phoenix = {
      wingAngle: 0, tailLen: 0, flameIntensity: 0.1, floatY: 0,
      transformLevel: 0, breath: 0, sparks: [], flames: [], embers: [],
    };

    // Nebula state
    this._nebula = {
      radius: 80, coreGlow: 0.1, spiralAngle: 0, spiralLen: 0,
      transformLevel: 0, breath: 0, compression: 1, flares: [],
      dustMotes: [], ringAlpha: 0,
    };
    for (let i = 0; i < 30; i++) {
      this._nebula.dustMotes.push({
        angle: Math.random() * Math.PI * 2, dist: 40 + Math.random() * 100,
        speed: 0.1 + Math.random() * 0.3, size: 0.5 + Math.random() * 1.5,
        phase: Math.random() * Math.PI * 2,
      });
    }

    // Spirit state
    this._spirit = {
      orbR: 20, floatY: 0, glow: 0.15, colorTemp: 0.5, breath: 0,
      transformLevel: 0, ribbons: [], lights: [], bokeh: [],
    };
    for (let i = 0; i < 5; i++) {
      this._spirit.ribbons.push({
        angle: (i / 5) * Math.PI * 2, length: 40, targetLen: 40,
        phase: Math.random() * Math.PI * 2, freq: 1.5 + Math.random(),
        amp: 8 + Math.random() * 6, width: 2 + Math.random() * 2,
      });
    }
    for (let i = 0; i < 12; i++) {
      this._spirit.bokeh.push({
        x: (Math.random() - 0.5) * 300, y: (Math.random() - 0.5) * 300,
        size: 3 + Math.random() * 8, phase: Math.random() * Math.PI * 2,
        speed: 0.2 + Math.random() * 0.4, alpha: 0.05 + Math.random() * 0.1,
      });
    }

    // Koi state
    this._koi = {
      swimPhase: 0, depth: 0, finExt: 0, tailAmp: 0.3, floatY: 0,
      transformLevel: 0, breath: 0, whiskerLen: 0, bodyLen: 1,
      iridescence: 0, ripples: [], scales: [],
    };

    // ====== GARDEN STATE ======
    this.garden = {
      plants: [],
      cursor: 60,
      pollen: [],
      fireflies: [],     // always-present ambient fireflies
      spawnCooldown: 0,
      globalGrowth: 0,
      time: 0,
      groundY: 0,
      smoothCamX: 0,     // smoothed camera position
    };
    // Seed idle garden with a few starter plants
    for (let i = 0; i < 10; i++) {
      const p = this._makeGardenPlant(
        30 + i * 55 + Math.random() * 25,
        ['mushroom', 'fern', 'flower', 'tree'][Math.floor(Math.random() * 4)],
        100 + Math.random() * 220, 45 + Math.random() * 25, 0.5 + Math.random() * 0.5
      );
      p.age = 5 + Math.random() * 10; // mature
      p.bloom = 0.3 + Math.random() * 0.5;
      this.garden.plants.push(p);
    }
    // Sort initial plants by depth for draw order
    this.garden.plants.sort((a, b) => a.depth - b.depth);

    // ====== VOICE CANVAS STATE ======
    this.voiceCanvas = {
      buffer: null,
      bufferCtx: null,
      bufferW: 6000,
      bufferH: 0,
      cursorX: 0,
      lastPaintY: 0.5,
      lastScreenY: 0,
      lastCtrlY: 0,
      time: 0,
      splatters: [],
      drips: [],
      articMarkers: [],
      motes: [],          // ambient floating paint particles
      isSpeaking: false,
      wasSpeaking: false,
      strokeHue: 240,
      strokeSat: 60,
      strokeLit: 50,
      smoothPitchY: 0.5,
      smoothViewX: 0,     // smoothed viewport position
      strokeCount: 0,     // number of separate strokes painted
      totalPaintX: 0,     // total horizontal distance painted
      lastPaintX: 0,
      vibrato: 0,         // bounce → waviness
      smoothEnergy: 0,    // smoothed energy for width
      idleWaves: [],
    };
    for (let i = 0; i < 5; i++) {
      this.voiceCanvas.idleWaves.push({
        phase: Math.random() * Math.PI * 2,
        freq: 0.2 + Math.random() * 0.5,
        amp: 0.06 + Math.random() * 0.14,
        hue: 190 + i * 35,
        yOff: 0.2 + i * 0.13,
        speed: 0.3 + Math.random() * 0.4,
        width: 1.5 + Math.random() * 2,
      });
    }

    this.voiceKeyboard = {
      minMidi: 41, // F2
      maxMidi: 96, // C7
      plasmaTrail: [],
      glowKey: -1,
      glowStrength: 0,
      targetMidi: 57,
      targetHold: 0,
      score: 0,
      heroTime: 0,
      heroSpawn: 0,
      heroNotes: [],
      successPulse: 0,
      missPulse: 0,
    };
    this.activePointerNotes = new Map(); // pointerId -> { oscillator, gain }

    this.pitchPilot = {
      sparkX: 0,
      sparkY: 0,
      sparkTargetY: 0,
      sparkRadius: 18,
      sparkGlow: 0.4,
      trail: [],
      barriers: [],
      score: 0,
      spawnTimer: 0,
      speed: 170,
      phase: 'warmup',
      calibrated: false,
      calibrationTimer: 0,
      calibrationDuration: 3.2,
      lowHz: 120,
      highHz: 420,
      observedMinHz: Infinity,
      observedMaxHz: 0,
      gameOver: false,
      ending: false,
      crashTimer: 0,
      selectedRangeLabel: 'Auto (Glide Calibration)',
      awaitingRestartChoice: false,
    };

    this.resonanceRoad = {
      targetTone: 'bright',
      passageMode: 'balcony',
      customText: '',
      centerX: 0,
      laneHalfWidth: 60,
      roadHalfWidth: 150,
      speed: 0,
      trail: [],
      score: 0,
      multiplier: 1,
      driftStrength: 0,
    };
    this.roadRiderAvatar = this._createRoadRiderAvatar();

    this.spectralAscent = {
      balloonX: 0,
      balloonY: 0,
      balloonVy: 0,
      centerY: 0,
      worldX: 0,
      markerY: 0,
      tetherLagY: 0,
      gates: [],
      gateSpeed: 190,
      score: 0,
      phase: 0,
      gateTimer: 0,
      diagnostics: {
        driftAccum: 0,
        driftSamples: 0,
        transitionLagAccum: 0,
        transitionCount: 0,
        prevWeight: 0.5,
        dynamicMin: 1,
        dynamicMax: 0,
      },
    };

    this.vowelValley = {
      x: 0.5, y: 0.5,
      smoothX: 0.5, smoothY: 0.5,
      f1Range: [250, 1000],
      f2Range: [600, 2600],
      targets: [
        { name: 'EE', f1: 300, f2: 2300, color: '#4d96ff', active: false, charge: 0 },
        { name: 'AH', f1: 850, f2: 1100, color: '#ff6b6b', active: false, charge: 0 },
        { name: 'OO', f1: 350, f2: 800, color: '#6bcb77', active: false, charge: 0 },
      ],
      particles: [],
      trail: [],
      popups: [],
      score: 0,
      flowMultiplier: 1,
      flowTimer: 0,
      lastTargetHit: null,
      gridAlpha: 0.1
    };

    // ====== PRISM READER STATE ======
    this.prismReader = {
      syllables: [],
      currentIndex: -1,
      isActive: false,
      manualMode: false,
      lastOnsetTime: 0,
      accumulationTimer: 0,
      silenceTimer: 0,
      completed: false,
      startTime: 0,
      firstOnsetTime: 0,
      wordsCompleted: 0,
      overlayBuilt: false,
      passageMode: 'rainbow',
      customText: '',
      processMode: 'realtime',
      mediaRecorder: null,
      audioChunks: [],
      audioBlob: null,
      audioPlayer: new Audio(),
      isRecording: false,
      isPlayingBack: false,
      playbackIndex: 0,
      freestyleTranscript: '',
      speechRecognition: null
    };

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.prismReader.speechRecognition = new SpeechRecognition();
      this.prismReader.speechRecognition.continuous = true;
      this.prismReader.speechRecognition.interimResults = true;
      this.prismReader.speechRecognition.onresult = this._onPrismSpeechResult.bind(this);
      this.prismReader.speechRecognition.onerror = (e) => console.log('Speech recognition error', e);
    }

    // Recording — AnalyserNode polling approach
    this.isRecording = false;
    this._recInterval = null;
    this._recBuffers = [];
    this._recSampleRate = 48000;
    this.recordings = []; // { blob, dataUrl, duration, timestamp, name }
    this.recordingStartTime = 0;
    this.currentPlayback = null;

    // Procedural infinite terrain — layered sine waves, no finite array
    this.terrainLayers = [];
    for (let i = 0; i < 5; i++) {
      this.terrainLayers.push({
        amplitude: 10 + Math.random() * 25,
        frequency: 0.002 + Math.random() * 0.005,
        phase: Math.random() * Math.PI * 2
      });
    }

    this.stars = [];

    // ====== VIBRATION ALERT STATE ======
    this.vibration = {
      enabled: false,
      rules: [],
      nextId: 1,
      shakeTimer: 0,
      hasHaptic: typeof navigator !== 'undefined' && 'vibrate' in navigator,
      globalCooldown: 0,
      flashAlpha: 0,       // on-canvas alert flash opacity
      flashMetric: '',     // which metric tripped (for display)
    };

    // ====== SESSION STATS ======
    this.session = {
      startTime: 0,
      duration: 0,
      pitchSum: 0,
      pitchCount: 0,
      pitchMin: Infinity,
      pitchMax: 0,
      resonanceSum: 0,
      resonanceCount: 0,
      prosodyHistory: [],  // sampled every ~0.5s for sparkline
      prosodySampleTimer: 0,
      plantsAtStart: 0,
      scrollAtStart: 0,
      canvasAtStart: 0,
    };

    // ====== ACCESSIBILITY ======
    this.userMotionPreference = localStorage.getItem('vox:motionPreference') || 'auto';
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.baseParticleScale = 1;
    this.particleScale = 1;
    this.dynamicQualityScale = 1;
    this._applyMotionPreferences();
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.reducedMotion = e.matches;
      this._applyMotionPreferences();
    });

    // ====== RUNTIME TOOLS ======
    this.perfMonitor = new PerformanceMonitor({ panelId: 'perfPanel' });
    this.calibrationWizard = new CalibrationWizard();
    this.hasCompletedCalibration = false;
    this.guidedStartTs = 0;
    this.guidedDurationSec = 5;
    this.guidedDismissed = false;
    this.guidedCloseHitbox = null;
    this.guidedPitchStable = 0;
    this.guidedChecklist = {
      roomReady: false,
      voiceDetected: false,
      pitchLocked: false,
    };
    this.voiceCanvasPaused = false;
    this.voiceCanvasVisualStyle = 'artistic';
    this.canvasMode = 'paint'; // 'paint' | 'keyboard'
    this.canvasModeTransition = 0;
    this.keyboardGameMode = 'mirror'; // 'mirror' | 'target' | 'hero'
    this.pitchGuideLabelMode = 'hz';
    this.pitchGridStrength = 'strong';
    this.teleprompterMode = 'off';
    this.voiceProfilePreset = 'auto';
    this.teleprompterCustomText = '';
    this.teleprompterRainbowText = (`When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. ` +
      `The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, ` +
      `with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end.`);

    // Additional Prism Reader passages
    this.prismPassages = {
      rainbow: this.teleprompterRainbowText,
      grandfather: (
        `You wish to know all about my grandfather. Well, he is nearly ninety-three years old. ` +
        `He dresses himself in an old black frock coat, usually minus several buttons; yet he still thinks as swiftly as ever. ` +
        `A long, flowing beard clings to his chin, giving those who observe him a pronounced feeling of the utmost respect. ` +
        `When he speaks, his voice is just a bit cracked and quivers a trifle. ` +
        `Twice each day he plays skillfully and with zest upon our small organ. ` +
        `Except in the winter when the ooze or snow or ice prevents, he slowly takes a short walk in the open air each day. ` +
        `We have often urged him to walk more and smoke less, but he always answers, "Banana oil!" ` +
        `Grandfather likes to be modern in his language.`
      ),
      caterpillar: (
        `Do you like amusement parks? Well, I sure do. To amuse myself, I went twice last spring. ` +
        `My most memorable moment was riding on the Caterpillar, which is a tremendous, undulating roller coaster. ` +
        `What a series of sensations! What a series of exhilarating and terrifying moments! ` +
        `As it raced round, I clung to the handrail with a grip of iron. My heart was pounding with delight and fear. ` +
        `It whipped around curves and seemed to swoop right off the track. ` +
        `I could barely keep from screaming at every turn, but I managed by simply gritting my teeth. ` +
        `Every other person on the ride was screaming without restraint. ` +
        `Some laughed, some cried, and quite a number merely looked petrified.`
      ),
      stella: (
        `Please call Stella. Ask her to bring these things with her from the store: ` +
        `six spoons of fresh snow peas, five thick slabs of blue cheese, and maybe a snack for her brother Bob. ` +
        `We also need a small plastic snake and a big toy frog for the kids. ` +
        `She can scoop these things into three red bags, and we will go meet her Wednesday at the train station.`
      ),
      northwind: (
        `The North Wind and the Sun were disputing which was the stronger, ` +
        `when a traveler came along wrapped in a warm cloak. ` +
        `They agreed that the one who first succeeded in making the traveler take his cloak off should be considered stronger than the other. ` +
        `Then the North Wind blew as hard as he could, but the more he blew, the more closely did the traveler fold his cloak around him; ` +
        `and at last the North Wind gave up the attempt. ` +
        `Then the Sun shined out warmly, and immediately the traveler took off his cloak. ` +
        `And so the North Wind was obliged to confess that the Sun was the stronger of the two.`
      ),
    };
    this.teleprompterIndex = 0;
    this.metricHighlightTimers = { bounce: 0, tempo: 0, vowel: 0, articulation: 0, syllable: 0 };
    this.metricExtremeLatch = { bounce: false, tempo: false, vowel: false, articulation: false, syllable: false };

    // ====== EXPANDED METRICS STATE ======
    this.metersExpanded = false;
    this.metricPopupOpen = null; // null or metric key string
    this._metricHistoryMax = 120; // ~2 seconds at 60fps (default)
    this._metricHistoryMaxLong = 600; // ~10 seconds at 60fps (pitch, bounce)
    this._metricHistory = {
      pitch: [],       // raw Hz values
      resonance: [],   // 0-1 resonance score
      bounce: [],      // 0-1
      tempo: [],       // 0-1
      vowels: [],      // 0-1
      artic: [],       // 0-1
      syllables: [],   // 0-1 impulse
    };
    this._syllableCountHistory = []; // per-second syllable counts for histogram
    this._syllableCountTimer = 0;
    this._syllableCountInWindow = 0;
    this._vowelPlotPoints = []; // {x, y} for F1/F2 scatter
    this._vowelPlotMax = 80;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.setupUI();
    this._updateHelpContent();
    this._setupMobile();
    this._setupInfoPopups();
    this.drawIdleScene();
  }

  _createRoadRiderAvatar() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" role="img" aria-label="Motorcycle avatar">
      <defs>
        <linearGradient id="bikeBody" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#88f5ff"/>
          <stop offset="100%" stop-color="#3c7dff"/>
        </linearGradient>
        <linearGradient id="wheelShine" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <circle cx="54" cy="84" r="28" fill="#10162f"/>
      <circle cx="54" cy="84" r="16" fill="#2d3b72"/>
      <circle cx="186" cy="84" r="28" fill="#10162f"/>
      <circle cx="186" cy="84" r="16" fill="#2d3b72"/>
      <rect x="36" y="52" width="58" height="12" rx="6" fill="url(#bikeBody)"/>
      <path d="M74 58 L122 44 Q138 40 154 48 L180 58 L168 68 L134 60 L104 74 L78 70 Z" fill="url(#bikeBody)"/>
      <path d="M106 43 Q117 28 137 26 Q149 25 155 32 Q143 33 136 39 Q124 49 116 57 Z" fill="#f6fbff" opacity="0.85"/>
      <rect x="94" y="37" width="18" height="7" rx="3.5" fill="#f6fbff"/>
      <path d="M166 48 L188 38 L192 43 L171 56 Z" fill="#f6fbff"/>
      <circle cx="54" cy="84" r="28" fill="url(#wheelShine)"/>
      <circle cx="186" cy="84" r="28" fill="url(#wheelShine)"/>
      <ellipse cx="118" cy="94" rx="86" ry="12" fill="#57c5ff" opacity="0.24"/>
    </svg>`;

    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return img;
  }


  /** Show/hide info-popup tooltips via JS (CSS-only approach was unreliable) */
  _setupInfoPopups() {
    document.querySelectorAll('.info-wrapper').forEach(wrapper => {
      const popup = wrapper.querySelector('.info-popup');
      const trigger = wrapper.querySelector('.info-trigger');
      if (!popup || !trigger) return;

      const show = () => {
        popup.removeAttribute('hidden');
        popup.style.display = '';
        popup.style.opacity = '1';
        popup.style.visibility = 'visible';
        popup.style.pointerEvents = 'auto';
      };
      const hide = () => {
        popup.style.display = 'none';
        popup.style.opacity = '0';
        popup.style.visibility = 'hidden';
        popup.style.pointerEvents = 'none';
        popup.setAttribute('hidden', '');
      };

      wrapper.addEventListener('mouseenter', show);
      wrapper.addEventListener('mouseleave', hide);
      trigger.addEventListener('focus', show);
      trigger.addEventListener('blur', hide);
    });
  }

  /** Mobile-only UX enhancements (no-op on desktop/tablet) */
  _setupMobile() {
    const mobileQuery = window.matchMedia('(max-width: 600px) and (pointer: coarse)');
    if (!mobileQuery.matches) return;

    // 1. Auto-scroll selected mode card into view
    const menuLeft = document.querySelector('.menu-left');
    if (menuLeft) {
      const scrollCardIntoView = (card) => {
        if (!card || !menuLeft) return;
        card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      };
      const observer = new MutationObserver(() => {
        const selected = menuLeft.querySelector('.mode-card.selected');
        if (selected) scrollCardIntoView(selected);
      });
      observer.observe(menuLeft, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    // 2. Close drawers/panels when tapping outside on mobile
    document.addEventListener('pointerdown', (e) => {
      if (!mobileQuery.matches) return;
      const vibPanel = document.getElementById('vibPanel');
      const vibToggle = document.getElementById('vibToggle');
      if (vibPanel?.classList.contains('show') && !vibPanel.contains(e.target) && e.target !== vibToggle) {
        vibPanel.classList.remove('show');
        vibToggle?.classList.remove('active');
      }
      const recDrawer = document.getElementById('recordingsDrawer');
      const recBtn = document.getElementById('recordingsBtn');
      if (recDrawer?.classList.contains('show') && !recDrawer.contains(e.target) && e.target !== recBtn && !recBtn?.contains(e.target)) {
        recDrawer.classList.remove('show');
      }
      const helpTooltip = document.getElementById('helpTooltip');
      const helpBtn = document.getElementById('helpBtn');
      if (helpTooltip?.classList.contains('show') && !helpTooltip.contains(e.target) && e.target !== helpBtn) {
        helpTooltip.classList.remove('show');
      }
    });

    // 3. Prevent rubber-band bounce on iOS when scrolling at boundaries
    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.style.overscrollBehavior = 'contain';
    }

    // 4. Add active state feedback for mobile tap (no hover on touch)
    document.querySelectorAll('.btn, .btn-big, .mode-card, .style-pill, .range-btn, .rec-btn, .help-tab').forEach(el => {
      el.addEventListener('touchstart', () => el.classList.add('mobile-active'), { passive: true });
      el.addEventListener('touchend', () => el.classList.remove('mobile-active'), { passive: true });
      el.addEventListener('touchcancel', () => el.classList.remove('mobile-active'), { passive: true });
    });

    // 5. Inject mobile active state CSS (visual feedback on tap)
    const mobileStyle = document.createElement('style');
    mobileStyle.textContent = `
      @media (max-width: 600px) and (pointer: coarse) {
        .mobile-active {
          opacity: 0.85;
          transform: scale(0.97) !important;
        }
        .mode-card.mobile-active {
          border-color: rgba(192, 132, 252, 0.5);
          background: rgba(255, 255, 255, 0.08);
        }
      }
    `;
    document.head.appendChild(mobileStyle);

    // 6. Scroll fade indicators on horizontally-scrollable areas
    this._initScrollFades();
  }

  /** Attach scroll-fade edge indicators to horizontal scroll containers */
  _initScrollFades() {
    const scrollables = [
      document.querySelector('.menu-left'),
      document.querySelector('.context-bar'),
      document.querySelector('.hud-secondary'),
    ].filter(Boolean);

    const updateFade = (el) => {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      const threshold = 4;
      const canScrollLeft = scrollLeft > threshold;
      const canScrollRight = scrollLeft + clientWidth < scrollWidth - threshold;
      el.classList.toggle('fade-left', canScrollLeft && !canScrollRight);
      el.classList.toggle('fade-right', canScrollRight && !canScrollLeft);
      el.classList.toggle('fade-both', canScrollLeft && canScrollRight);
      if (!canScrollLeft && !canScrollRight) {
        el.classList.remove('fade-left', 'fade-right', 'fade-both');
      }
    };

    scrollables.forEach(el => {
      el.classList.add('mobile-scroll-fade');
      // Initial check (deferred to ensure layout is computed)
      requestAnimationFrame(() => updateFade(el));
      el.addEventListener('scroll', () => updateFade(el), { passive: true });
      // Re-check when children change (e.g. mode cards appearing)
      const resizeObs = new ResizeObserver(() => updateFade(el));
      resizeObs.observe(el);
    });
  }


  _applyMotionPreferences() {
    const lowMotion = this.userMotionPreference === 'low' || (this.userMotionPreference === 'auto' && this.reducedMotion);
    this.baseParticleScale = lowMotion ? 0.15 : 1;
    this.particleScale = this.baseParticleScale * this.dynamicQualityScale;
    document.body.classList.toggle('low-motion', lowMotion);
  }

  _updateHelpContent() {
    const el = document.getElementById('helpHowTo');
    if (!el) return;
    const c = (color, label, desc) =>
      `<b style="color:var(--accent-${color})">${label}:</b> ${desc}`;
    const helpData = {
      ball: {
        title: 'Voice → Ball Mapping',
        items: [
          c('bounce', 'Bounciness', 'Pitch variation controls bounce height. Speak with intonation!'),
          c('tempo', 'Tempo', 'Changes in speech rate shift ball speed. Speed up and slow down.'),
          c('vowel', 'Vowel Elongation', 'Sustained sounds grow the ball and leave trails.'),
          c('artic', 'Articulation', 'Sharp consonants create sparkle bursts. Be crisp!'),
          c('syllable', 'Syllable Separation', 'Each distinct syllable triggers a separate bounce event.'),
        ],
      },
      creature: {
        title: 'Voice → Creature Mapping',
        items: [
          c('bounce', 'Pitch → Float', 'Higher pitch lifts the creature upward. It floats when your voice rises.'),
          c('tempo', 'Resonance → Form', 'Resonance shapes the body — dark/compact to bright/tall.'),
          c('vowel', 'Vowels → Tendrils', 'Sustained sounds grow flowing tendrils. Hold longer for more extension.'),
          c('artic', 'Articulation → Spark', 'Sharp consonants make the surface crackle with light.'),
          c('syllable', 'Prosody → Transform', 'Sustained expressiveness unlocks wings, glow, and luminous patterns.'),
        ],
      },
      garden: {
        title: 'Voice → Garden Mapping',
        items: [
          c('bounce', 'Pitch → Species', 'Low pitch grows mushrooms, mid grows flowers, high grows tall trees.'),
          c('tempo', 'Resonance → Color', 'Bright resonance makes vivid, warm plants. Dark resonance grows cool flora.'),
          c('vowel', 'Vowels → Sunlight', 'Sustained sounds accelerate growth. Hold vowels to watch plants surge.'),
          c('artic', 'Articulation → Pollen', 'Crisp consonants scatter pollen and fireflies through the garden.'),
          c('syllable', 'Syllables → Seeds', 'Each distinct syllable plants a new seed. More syllables = denser garden.'),
        ],
      },
      canvas: {
        title: 'Voice → Canvas Mapping',
        items: [
          c('bounce', 'Pitch → Y Position', 'Low voice paints at the bottom, high voice sweeps to the top.'),
          c('tempo', 'Resonance → Color', 'Dark resonance paints cool blues, bright resonance paints warm golds.'),
          c('vowel', 'Vowels → Flow', 'Sustained sounds create smooth, graceful flowing brushstrokes.'),
          c('artic', 'Articulation → Texture', 'Sharp consonants splatter paint and add texture to the canvas.'),
          c('syllable', 'Energy → Width', 'Louder speech creates wider, bolder strokes. Whisper for fine detail.'),
        ],
      },
      keyboard: {
        title: 'Voice → Keyboard Mapping',
        items: [
          c('bounce', 'Pitch Plasma', 'A neon plasma orb tracks exact pitch, including micro-slides between semitones.'),
          c('tempo', 'Mirror Mode', 'Real-time visual reflection of your voice over an expanded C2–C6 keyboard.'),
          c('vowel', 'Target Practice', 'Hold the highlighted key steadily for 1 second to score and trigger a success chime.'),
          c('syllable', 'Range Finding', 'Explore speaking/singing range and identify comfortable pitch zones by octave.'),
        ],
      },
      pilot: {
        title: 'Voice → Pitch Pilot Mapping',
        items: [
          c('bounce', 'Pitch → Altitude', 'Your spark moves to the note you sing. Hold a steady note to hold altitude.'),
          c('tempo', 'Calibration Glide', 'Start by gliding from low to high to map your personal vocal range to the cavern.'),
          c('vowel', 'Silence = Gravity', 'If your voice drops out, the spark slowly falls until you vocalize again.'),
          c('artic', 'Discord Barriers', 'Navigate glowing crystal gaps with smooth pitch jumps and controlled slides.'),
          c('syllable', 'Progressive Phases', 'Warm-up starts easy, then interval steps and slalom tunnels increase challenge.'),
        ],
      },
      road: {
        title: 'Voice → Resonance Road Mapping',
        items: [
          c('bounce', 'Timbre → Steering', 'Bright vs dark resonance steers the speeder left and right in real time.'),
          c('tempo', 'Energy → Speed', 'Speaking energy powers forward motion. Silence slows to a crawl.'),
          c('vowel', 'Target Lane', 'Stay near your selected target posture to remain on the glowing road centerline.'),
          c('artic', 'Hazard Shoulders', 'Drifting off target creates splattered hazard trails and heavy speed drag.'),
          c('syllable', 'Teleprompter Drill', 'Read flowing text while preserving resonance posture through difficult words.'),
        ],
      },
      ascent: {
        title: 'Voice → Spectral Ascent Mapping',
        items: [
          c('bounce', 'Spectral Weight → Altitude', 'Light/breathy tone rises. Heavy/buzzy tone sinks. The balloon tracks normalized tilt directly.'),
          c('tempo', 'Tilt Gauge', 'A live vertical gauge shows MAX LIGHT, NEUTRAL, and MAX HEAVY with a fast marker tied to the balloon.'),
          c('vowel', 'Diagnostic Vowel', 'Use a steady "Ah" or "Uh" so changes come from vocal weight, not vowel shape shifts.'),
          c('artic', 'Spectral Gates', 'Fly through high/low/neutral gate patterns to test extremes, stability, and agility.'),
          c('syllable', 'Session Diagnostics', 'Post-flight feedback reports latency, stability drift, and light-heavy dynamic range.'),
        ],
      },
      vowelvalley: {
        title: 'Voice → Vowel Valley Mapping',
        items: [
          c('bounce', 'F2 → Horizontal', 'Left/Right navigation. "EE" moves you right, "OO" moves you left.'),
          c('tempo', 'F1 → Vertical', 'Up/Down navigation. Jaw height (AH/EE) controls vertical position.'),
          c('vowel', 'Target Zones', 'Navigate to EE, AH, and OO zones to charge them and score.'),
          c('artic', 'Vocal Tract Feedback', 'Position reflects your actual vocal tract configuration in real-time.'),
          c('syllable', 'Flow Scoring', 'Smoothly transitioning between target vowels earns "Flow" bonuses.'),
        ],
      },
      prism: {
        title: 'Voice → Prism Reader Mapping',
        items: [
          c('bounce', 'Pitch → Color', 'Each syllable crystallizes with a hue from blue (low) to pink (high) based on your pitch.'),
          c('tempo', 'Resonance → Glow', 'Bright, forward resonance creates a luminous text glow. Dark resonance stays flat.'),
          c('vowel', 'Weight → Edge', 'Heavy vocal weight gives sharp text edges. Breathy voice creates soft, fuzzy syllables.'),
          c('artic', 'Onset Stepping', 'Each new syllable onset advances the reader. Speak naturally to progress through the text.'),
          c('syllable', 'Vowel Scoring', 'Vowel-specific resonance targets provide per-syllable scoring feedback via saturation.'),
        ],
      },
    };
    const data = helpData[this.gameMode] || helpData.ball;
    el.innerHTML = `<h3>${data.title}</h3><p>${data.items.join('<br><br>')}</p>`;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    // FIX: Reset transform before scaling — prevents compound scaling on multiple resizes
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.groundY = this.height * 0.75;
    this.ball.y = this.groundY - this.ball.radius;

    // Garden — keep groundY in sync with canvas height
    if (this.garden) {
      this.garden.groundY = this.height * 0.76;
    }

    // Voice Canvas — init or resize offscreen paint buffer
    const vc = this.voiceCanvas;
    if (vc) {
      const newH = Math.floor(this.height);
      if (!vc.buffer || vc.bufferH !== newH) {
        const oldBuffer = vc.buffer;
        const oldH = vc.bufferH;
        vc.bufferH = newH;
        vc.buffer = document.createElement('canvas');
        vc.buffer.width = vc.bufferW;
        vc.buffer.height = newH;
        vc.bufferCtx = vc.buffer.getContext('2d');
        // Preserve existing paint if resizing
        if (oldBuffer && oldH > 0) {
          vc.bufferCtx.drawImage(oldBuffer, 0, 0, vc.bufferW, oldH, 0, 0, vc.bufferW, newH);
        }
      }
    }

    // FIX: Generate stars sized to actual canvas dimensions
    this.stars = [];
    for (let i = 0; i < 80; i++) {
      this.stars.push({
        x: Math.random() * 3000,
        y: Math.random() * this.height * 0.55,
        size: Math.random() * 1.5 + 0.5,
        twinkle: Math.random() * Math.PI * 2
      });
    }

    // Generate mountain layers (procedural, infinite via sine sums)
    if (!this.mountainLayers) {
      this.mountainLayers = [
        // Far mountains — slow parallax, taller, lighter
        {
          parallax: 0.08, baseY: 0.52, layers: [
            { amp: 60, freq: 0.0008, phase: 0.0 },
            { amp: 30, freq: 0.002, phase: 1.2 },
            { amp: 15, freq: 0.005, phase: 3.7 },
          ]
        },
        // Mid mountains — medium parallax
        {
          parallax: 0.18, baseY: 0.58, layers: [
            { amp: 55, freq: 0.0012, phase: 2.1 },
            { amp: 25, freq: 0.003, phase: 0.5 },
            { amp: 12, freq: 0.007, phase: 4.2 },
          ]
        },
        // Near hills — faster parallax, smaller, darker
        {
          parallax: 0.35, baseY: 0.65, layers: [
            { amp: 35, freq: 0.002, phase: 4.5 },
            { amp: 18, freq: 0.005, phase: 1.8 },
            { amp: 8, freq: 0.012, phase: 0.3 },
          ]
        },
      ];
    }
    // Theme-aware mountain + ground colors
    const mtnColors = {
      highcontrast: ['#12122a', '#0e0e22', '#0a0a1a'],
    };
    const groundColors = {
      highcontrast: ['#14142a', '#101024', '#0c0c1e'],
    };
    const mc = mtnColors[this.themeMode] || mtnColors.highcontrast;
    this.mountainLayers[0].color = mc[0];
    this.mountainLayers[1].color = mc[1];
    this.mountainLayers[2].color = mc[2];
    this._groundColors = groundColors[this.themeMode] || groundColors.highcontrast;

    if (!this.isRunning) this.drawIdleScene();
  }

  // FIX: Infinite procedural terrain
  getGroundHeight(worldX) {
    let h = 0;
    for (const layer of this.terrainLayers) {
      h += layer.amplitude * Math.sin(worldX * layer.frequency + layer.phase);
    }
    return this.groundY + h * 0.4;
  }

  // FIX: Helper for proper HSLA color strings
  getBallColor(alpha) {
    if (alpha !== undefined) {
      return `hsla(${this.ballHue}, ${this.ballSat}%, ${this.ballLit}%, ${alpha})`;
    }
    return `hsl(${this.ballHue}, ${this.ballSat}%, ${this.ballLit}%)`;
  }

  // ============================================
  // RECORDING — AnalyserNode time-domain polling + WAV encoding
  // The ONLY reliable approach in sandboxed iframes:
  // - MediaRecorder: stream consumed by Web Audio → silence
  // - ScriptProcessorNode: needs ctx.destination → blocked in sandbox
  // - AnalyserNode.getFloatTimeDomainData: WORKS (proven — the ball moves!)
  // We poll a dedicated small-FFT analyser at matched intervals
  // to capture approximately non-overlapping sample windows.
  // ============================================
  startRecording() {
    const a = this.analyzer;
    if (!a.audioCtx || !a.analyserRec || this.isRecording) return;
    try {
      this._recSampleRate = a.audioCtx.sampleRate;
      this._recBuffers = [];
      const fftSize = a.analyserRec.fftSize; // 512

      // Poll interval = window duration in ms (e.g. 512/44100*1000 ≈ 11.6ms)
      const intervalMs = Math.round(1000 * fftSize / this._recSampleRate);

      this._recInterval = setInterval(() => {
        if (!this.isRecording || !a.analyserRec) return;
        a.analyserRec.getFloatTimeDomainData(a.recTimeDomainData);

        // Speech gate: compute local RMS and check against analyzer's noise floor
        // plus pitch confidence. Non-speech frames become silence (preserves timing).
        const data = a.recTimeDomainData;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const localRms = Math.sqrt(sum / data.length);
        const threshold = a.isCalibrated ? a.noiseFloor * 2.5 : 0.02;
        const isSpeech = localRms > threshold || a.pitchConfidence > 0.3;

        if (isSpeech) {
          this._recBuffers.push(new Float32Array(data));
        } else {
          // Push silence to keep timing intact (avoids clicks/jumps)
          this._recBuffers.push(new Float32Array(data.length));
        }
      }, intervalMs);

      this.recordingStartTime = performance.now();
      this.isRecording = true;
    } catch (e) {
      console.error('Recording failed:', e);
    }
  }

  stopRecording() {
    if (!this.isRecording) return Promise.resolve();
    this.isRecording = false;

    if (this._recInterval) {
      clearInterval(this._recInterval);
      this._recInterval = null;
    }

    return new Promise((resolve) => {
      try {
        if (this._recBuffers.length === 0) { resolve(); return; }

        // Merge all Float32 buffers
        const totalLen = this._recBuffers.reduce((sum, b) => sum + b.length, 0);
        const merged = new Float32Array(totalLen);
        let offset = 0;
        for (const buf of this._recBuffers) {
          merged.set(buf, offset);
          offset += buf.length;
        }
        this._recBuffers = [];

        // Encode as WAV (PCM 16-bit mono)
        const wavBlob = this._encodeWAV(merged, this._recSampleRate);
        const duration = (performance.now() - this.recordingStartTime) / 1000;
        const now = new Date();
        const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const fileTs = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

        // Convert to data URL for universal playback in sandbox
        const reader = new FileReader();
        reader.onloadend = () => {
          this.recordings.push({
            blob: wavBlob,
            dataUrl: reader.result,
            duration,
            timestamp: ts,
            name: `vox-ball-${fileTs}`,
            mimeType: 'audio/wav'
          });
          this.updateRecordingsUI();
          resolve();
        };
        reader.onerror = () => { resolve(); };
        reader.readAsDataURL(wavBlob);
      } catch (e) {
        console.error('Recording save error:', e);
        resolve();
      }
    });
  }

  _encodeWAV(samples, sampleRate) {
    // PCM 16-bit mono WAV
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataLength = samples.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // RIFF header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this._writeString(view, 8, 'WAVE');

    // fmt chunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // chunk size
    view.setUint16(20, 1, true);            // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Convert Float32 [-1,1] to Int16
    let p = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      p += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  _writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  playRecording(index) {
    const rec = this.recordings[index];
    if (!rec) return;
    this.stopPlayback();

    const audio = new Audio();
    audio.volume = 1.0;
    this.currentPlayback = { audio, index };
    this.updateRecItemState(index, true);

    audio.addEventListener('timeupdate', () => {
      const progress = audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0;
      const el = document.getElementById(`rec-progress-${index}`);
      if (el) el.style.width = progress + '%';
    });

    audio.addEventListener('ended', () => {
      this.updateRecItemState(index, false);
      const el = document.getElementById(`rec-progress-${index}`);
      if (el) el.style.width = '0%';
      this.currentPlayback = null;
    });

    audio.addEventListener('error', (e) => {
      console.error('Audio playback error:', audio.error?.message || e);
      this.updateRecItemState(index, false);
      this.currentPlayback = null;
    });

    // Wait for audio to be loadable before playing
    audio.addEventListener('canplay', () => {
      audio.play().catch(e => {
        console.error('Playback failed:', e);
        this.updateRecItemState(index, false);
        this.currentPlayback = null;
      });
    }, { once: true });

    // Use data URL (works in sandboxed iframes, unlike blob: URLs)
    audio.src = rec.dataUrl;
    audio.load();
  }

  stopPlayback() {
    if (this.currentPlayback) {
      this.currentPlayback.audio.pause();
      this.currentPlayback.audio.currentTime = 0;
      this.updateRecItemState(this.currentPlayback.index, false);
      const el = document.getElementById(`rec-progress-${this.currentPlayback.index}`);
      if (el) el.style.width = '0%';
      this.currentPlayback = null;
    }
  }

  updateRecItemState(index, isPlaying) {
    const btn = document.getElementById(`rec-play-${index}`);
    if (btn) {
      btn.textContent = isPlaying ? '⏸' : '▶';
      btn.classList.toggle('playing', isPlaying);
    }
  }

  downloadRecording(index) {
    const rec = this.recordings[index];
    if (!rec) return;
    const url = URL.createObjectURL(rec.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rec.name}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  deleteRecording(index) {
    if (this.currentPlayback && this.currentPlayback.index === index) {
      this.stopPlayback();
    }
    this.recordings.splice(index, 1);
    this.updateRecordingsUI();
  }

  clearAllRecordings() {
    this.stopPlayback();
    this.recordings = [];
    this.updateRecordingsUI();
  }

  formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  updateRecordingsUI() {
    const list = document.getElementById('recordingsList');
    const empty = document.getElementById('recsEmpty');
    const badge = document.getElementById('recBadge');
    const recBtn = document.getElementById('recordingsBtn');

    badge.textContent = this.recordings.length;
    recBtn.classList.toggle('visible', this.recordings.length > 0);

    if (this.recordings.length === 0) {
      list.innerHTML = '';
      list.appendChild(empty);
      empty.style.display = '';
      return;
    }

    list.innerHTML = '';
    for (let i = this.recordings.length - 1; i >= 0; i--) {
      const rec = this.recordings[i];
      const item = document.createElement('div');
      item.className = 'rec-item';
      item.innerHTML = `
        <div class="rec-item-info">
          <div class="rec-item-name">Recording ${i + 1}</div>
          <div class="rec-item-meta">${rec.timestamp} · ${this.formatDuration(rec.duration)}</div>
          <div class="rec-progress"><div class="rec-progress-fill" id="rec-progress-${i}"></div></div>
        </div>
        <div class="rec-item-actions">
          <button class="rec-btn" id="rec-play-${i}" title="Play" aria-label="Play Recording" data-action="play" data-index="${i}">▶</button>
          <button class="rec-btn" title="Download" aria-label="Download Recording" data-action="download" data-index="${i}">⬇</button>
          <button class="rec-btn delete" title="Delete" aria-label="Delete Recording" data-action="delete" data-index="${i}">✕</button>
        </div>
      `;
      list.appendChild(item);
    }

    list.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.index);
      if (action === 'play') {
        if (this.currentPlayback && this.currentPlayback.index === idx) {
          this.stopPlayback();
        } else {
          this.playRecording(idx);
        }
      } else if (action === 'download') {
        this.downloadRecording(idx);
      } else if (action === 'delete') {
        this.deleteRecording(idx);
      }
    };
  }

  _updatePrismRecBtnVisibility() {
    const recBtn = document.getElementById('recBtn');
    const clearBtn = document.getElementById('prismClearRecBtn');
    const saveBtn = document.getElementById('prismSaveRecBtn');
    const idlePrompt = document.getElementById('prismIdlePrompt');

    if (!recBtn) return;
    if (this.gameMode === 'prism' && this.prismReader.processMode === 'record') {
      recBtn.classList.add('show');

      const hasRecording = this.prismReader.audioBlob && !this.prismReader.isPlayingBack;

      if (clearBtn) {
        if (hasRecording) {
          clearBtn.style.display = 'inline-flex';
          setTimeout(() => { clearBtn.style.opacity = '1'; clearBtn.style.transform = 'scale(1)'; }, 10);
        } else {
          clearBtn.style.opacity = '0';
          clearBtn.style.transform = 'scale(0.95)';
          setTimeout(() => { if (clearBtn.style.opacity === '0') clearBtn.style.display = 'none'; }, 300);
        }
      }
      if (saveBtn) {
        if (hasRecording) {
          saveBtn.style.display = 'inline-flex';
          setTimeout(() => { saveBtn.style.opacity = '1'; saveBtn.style.transform = 'scale(1)'; }, 10);
        } else {
          saveBtn.style.opacity = '0';
          saveBtn.style.transform = 'scale(0.95)';
          setTimeout(() => { if (saveBtn.style.opacity === '0') saveBtn.style.display = 'none'; }, 300);
        }
      }

      if (idlePrompt) {
        idlePrompt.classList.toggle('show', !this.prismReader.isRecording && !this.prismReader.isPlayingBack && !this.prismReader.audioBlob);
      }
    } else {
      recBtn.classList.remove('show');
      recBtn.classList.remove('recording');
      const label = recBtn.querySelector('.rec-label');
      if (label) label.textContent = 'Rec';

      if (clearBtn) {
        clearBtn.style.opacity = '0';
        clearBtn.style.transform = 'scale(0.95)';
        setTimeout(() => { if (clearBtn.style.opacity === '0') clearBtn.style.display = 'none'; }, 300);
      }
      if (saveBtn) {
        saveBtn.style.opacity = '0';
        saveBtn.style.transform = 'scale(0.95)';
        setTimeout(() => { if (saveBtn.style.opacity === '0') saveBtn.style.display = 'none'; }, 300);
      }
      if (idlePrompt) idlePrompt.classList.remove('show');
    }
  }

  /** Play a subtle lo-fi synth blip for menu navigation feedback */
  _playMenuBlip() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
      osc.onended = () => ctx.close();
    } catch (_) { /* audio not available */ }
  }

  setupUI() {
    const startBtn = document.getElementById('startBtn');
    const playBtn = document.getElementById('playBtn');
    const helpBtn = document.getElementById('helpBtn');
    const recalibrateBtn = document.getElementById('recalibrateBtn');
    const recoverMicBtn = document.getElementById('recoverMicBtn');
    const homeBtn = document.getElementById('homeBtn');
    const welcomeOverlay = document.getElementById('welcomeOverlay');
    const helpTooltip = document.getElementById('helpTooltip');
    const helpTabs = Array.from(helpTooltip?.querySelectorAll('.help-tab') || []);
    const helpPanels = Array.from(helpTooltip?.querySelectorAll('.help-panel') || []);

    const visualStyleSelect = document.getElementById('visualStyleSelect');
    const canvasModeSelect = document.getElementById('canvasModeSelect');
    const keyboardGameSelect = document.getElementById('keyboardGameSelect');
    const pitchLabelsSelect = document.getElementById('pitchLabelsSelect');
    const canvasContextBar = document.getElementById('canvasContextBar');
    const contextToggleBtn = document.getElementById('contextToggleBtn');

    const teleprompterModeSelect = document.getElementById('teleprompterModeSelect');
    const voiceProfileSelect = document.getElementById('voiceProfileSelect');
    const motionToggle = document.getElementById('motionToggle');
    const cameraBtn = document.getElementById('cameraBtn');
    const cameraModal = document.getElementById('cameraModal');
    const cameraClose = document.getElementById('cameraClose');
    const cameraVideo = document.getElementById('cameraVideo');
    const cameraZoom = document.getElementById('cameraZoom');
    const cameraHeader = document.getElementById('cameraHeader');

    const roadTargetSelect = document.getElementById('roadTargetSelect');
    const roadPassageSelect = document.getElementById('roadPassageSelect');
    const roadCustomText = document.getElementById('roadCustomText');
    const prismPacingSelect = document.getElementById('prismPacingSelect');
    const prismPassageSelect = document.getElementById('prismPassageSelect');
    const prismCustomText = document.getElementById('prismCustomText');
    const teleprompterCustomBtn = document.getElementById('teleprompterCustomBtn');
    const hudRecBtn = document.getElementById('recBtn');
    const recordingsBtn = document.getElementById('recordingsBtn');
    const recordingsDrawer = document.getElementById('recordingsDrawer');
    const clearAllRecs = document.getElementById('clearAllRecs');
    const perfBtn = document.getElementById('perfBtn');
    const pauseCanvasBtn = document.getElementById('pauseCanvasBtn');
    const clearCanvasBtn = document.getElementById('clearCanvasBtn');
    const teleprompterOverlay = document.getElementById('teleprompterOverlay');
    const diagPanel = document.getElementById('diagPanel');

    const errorBanner = document.getElementById('errorBanner');
    const statusLiveRegion = document.getElementById('statusLiveRegion');
    const iframeNotice = document.getElementById('iframeNotice');
    const isInIframe = window.self !== window.top;

    // Detect iframe on load and show helpful notice
    if (isInIframe && iframeNotice) {
      // Build direct URL — HF Spaces has multiple URL patterns
      let directUrl = window.location.href;
      try {
        // Try to build the *.hf.space direct URL from the current location
        const url = new URL(window.location.href);
        // If we're already on a .hf.space domain, just use it directly
        if (!url.hostname.endsWith('.hf.space')) {
          directUrl = window.location.href;
        }
      } catch (e) { }
      iframeNotice.textContent = '';
      iframeNotice.appendChild(document.createTextNode('This app needs microphone access, which may be blocked when embedded.'));
      iframeNotice.appendChild(document.createElement('br'));
      const link = document.createElement('a');
      link.href = directUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open in new tab for full access ↗';
      iframeNotice.appendChild(link);
      iframeNotice.classList.add('show');
    }

    const showError = (msg) => {
      if (msg instanceof Node) {
        errorBanner.innerHTML = '';
        errorBanner.appendChild(msg);
        if (statusLiveRegion) statusLiveRegion.textContent = msg.textContent.trim();
      } else {
        errorBanner.innerHTML = msg;
        if (statusLiveRegion) statusLiveRegion.textContent = String(msg).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      errorBanner.classList.add('show');
    };
    const clearError = () => {
      errorBanner.classList.remove('show');
      if (statusLiveRegion) statusLiveRegion.textContent = '';
    };

    const setRecoverMicVisible = (visible) => {
      if (!recoverMicBtn) return;
      recoverMicBtn.style.display = visible ? '' : 'none';
      recoverMicBtn.classList.toggle('active', visible);
    };

    const showCalibrationOutcome = (calResult) => {
      if (!calResult) return;
      if (calResult.outcome === 'completed') {
        showError('✅ Calibration complete. Tip: you can run Recalibrate from the top bar anytime.');
      } else if (calResult.outcome === 'incomplete') {
        showError('⚠ Calibration timed out. You can continue, but tracking may be less accurate. Next action: tap Recalibrate when your room is quieter.');
      } else if (calResult.outcome === 'cancelled') {
        showError('ℹ Calibration cancelled. Next action: tap Recalibrate in the top bar when you are ready.');
      } else if (calResult.outcome === 'partial') {
        showError('ℹ Calibration partially completed. Next action: tap Recalibrate to finish vowel tuning for better accuracy.');
      } else if (calResult.outcome === 'skipped') {
        showError('ℹ Calibration skipped. Next action: tap Recalibrate in the top bar for more stable tracking.');
      }
    };


    const recoverMicSession = async () => {
      clearError();
      setRecoverMicVisible(false);
      const wasRunning = this.isRunning;
      if (wasRunning) await stopGame();
      await startGame();
      startBtn?.focus();
    };

    recoverMicBtn?.addEventListener('click', recoverMicSession);

    // Camera Mirror Logic
    let cameraStream = null;

    const stopCamera = () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
      }
      if (cameraVideo) {
        cameraVideo.srcObject = null;
      }
      cameraModal?.classList.remove('show');
      cameraBtn?.classList.remove('active');
    };

    const toggleCamera = async () => {
      if (cameraModal?.classList.contains('show')) {
        stopCamera();
        return;
      }

      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        if (cameraVideo) {
          cameraVideo.srcObject = cameraStream;
        }
        cameraModal?.classList.add('show');
        cameraBtn?.classList.add('active');
      } catch (e) {
        showError('📷 Camera access denied or not available.');
        console.error('Camera error:', e);
      }
    };

    cameraBtn?.addEventListener('click', toggleCamera);
    cameraClose?.addEventListener('click', stopCamera);

    // Zoom Logic
    cameraZoom?.addEventListener('input', (e) => {
      if (cameraVideo) {
        cameraVideo.style.transform = `scale(${e.target.value})`;
      }
    });

    // Draggable Window Logic
    let isDraggingCamera = false;
    let cameraDragStartX = 0;
    let cameraDragStartY = 0;
    let cameraModalStartX = 0;
    let cameraModalStartY = 0;

    cameraHeader?.addEventListener('pointerdown', (e) => {
      isDraggingCamera = true;
      cameraDragStartX = e.clientX;
      cameraDragStartY = e.clientY;

      const rect = cameraModal.getBoundingClientRect();
      cameraModalStartX = rect.left;
      cameraModalStartY = rect.top;

      cameraHeader.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    cameraHeader?.addEventListener('pointermove', (e) => {
      if (!isDraggingCamera || !cameraModal) return;

      const dx = e.clientX - cameraDragStartX;
      const dy = e.clientY - cameraDragStartY;

      // Keep it within window bounds approximately
      const newLeft = Math.max(0, Math.min(window.innerWidth - cameraModal.offsetWidth, cameraModalStartX + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, cameraModalStartY + dy));

      cameraModal.style.left = `${newLeft}px`;
      cameraModal.style.top = `${newTop}px`;
      cameraModal.style.right = 'auto'; // overriding initial right positioning
    });

    cameraHeader?.addEventListener('pointerup', (e) => {
      isDraggingCamera = false;
      cameraHeader.releasePointerCapture(e.pointerId);
    });

    // Audio file upload handling
    const audioUploadInput = document.getElementById('audioUploadInput');
    let selectedAudioFile = null;

    audioUploadInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        selectedAudioFile = e.target.files[0];

        // if a game is running, stop it and start again with file
        if (this.isRunning) {
          stopGame().then(() => startGame());
        } else {
          startGame();
        }
      }
    });

    // Show/hide HUD secondary controls (hidden on main menu, visible during play)
    const setHudSettingsVisible = (visible) => {
      document.querySelectorAll('.hud-setting').forEach(el => {
        if (visible) {
          el.removeAttribute('hidden');
          el.style.display = '';
        } else {
          el.setAttribute('hidden', '');
          el.style.display = 'none';
        }
      });
    };

    const startGame = async () => {
      this._resetKeyboardModeState();
      if (this.gameMode === 'keyboard') {
        this.canvasMode = 'keyboard';
      } else if (this.gameMode === 'canvas') {
        this.canvasMode = 'paint';
      }
      clearError();
      const initialDiag = await getMicDiagnostics(this.analyzer.audioCtx);
      if (diagPanel) {
        diagPanel.innerHTML = `Mic permission: <b>${initialDiag.permission}</b> · Audio: <b>${initialDiag.audioState}</b> · Secure: <b>${initialDiag.secureContext ? 'yes' : 'no'}</b>${initialDiag.inIframe ? ' · Embedded iframe: yes' : ''}`;
      }
      if (this.idleAnimId) {
        cancelAnimationFrame(this.idleAnimId);
        this.idleAnimId = null;
      }

      // Check if we have an audio file OR microphone
      if (!selectedAudioFile && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
        const errNode = document.createElement('div');
        errNode.innerHTML = '🎙 Microphone API not available and no audio file selected.<br>This requires HTTPS and a modern browser. ';
        if (isInIframe) {
          const link = document.createElement('a');
          link.href = window.location.href;
          link.target = '_blank';
          link.textContent = 'Try opening in a new tab ↗';
          errNode.appendChild(link);
        } else {
          errNode.appendChild(document.createTextNode('Please use Chrome, Firefox, Safari, or Edge.'));
        }
        showError(errNode);
        this.drawIdleScene();
        return;
      }

      const result = await this.analyzer.start(selectedAudioFile);

      // Clear the selected file after starting so it doesn't persistently start with the file
      // if the user later clicks the normal Start button.
      selectedAudioFile = null;
      if (audioUploadInput) audioUploadInput.value = "";

      if (!result.ok) {
        let msg = '';
        if (result.error === 'NotAllowedError') {
          if (isInIframe) {
            msg = document.createElement('div');
            msg.innerHTML = '🎙 Microphone blocked by browser — this usually happens inside iframes.<br>';
            const link = document.createElement('a');
            link.href = window.location.href;
            link.target = '_blank';
            link.textContent = 'Open in a new tab for full mic access ↗';
            msg.appendChild(link);
          } else {
            msg =
              '🎙 Microphone permission denied.<br>' +
              'Click the lock/camera icon in your address bar → Allow microphone → then try again.';
          }
        } else if (result.error === 'NotFoundError') {
          msg = '🎙 No microphone detected. Please connect a microphone and try again.';
        } else if (result.error === 'NotReadableError') {
          msg = '🎙 Microphone is in use by another app. Close other apps using the mic and try again.';
        } else {
          msg = document.createElement('div');
          msg.textContent = '🎙 Could not access microphone: ' + (result.message || result.error);
        }
        showError(msg);
        this.drawIdleScene();
        return;
      }

      const resumed = await ensureAudioContextRunning(this.analyzer.audioCtx);
      if (!resumed.ok) {
        showError('🔊 Audio context could not be resumed automatically. Tap Start again after interacting with the page.');
      }

      const audioTracks = this.analyzer.stream?.getAudioTracks?.() || [];
      audioTracks.forEach((track) => {
        track.onended = () => {
          showError('🎙 Microphone stream ended unexpectedly. Click Recover Mic to resume without losing your selected mode.');
          setRecoverMicVisible(true);
        };
      });

      setRecoverMicVisible(false);

      const activeDiag = await getMicDiagnostics(this.analyzer.audioCtx);
      if (diagPanel) {
        diagPanel.innerHTML = `Mic permission: <b>${activeDiag.permission}</b> · Audio: <b>${activeDiag.audioState}</b> · API: <b>${activeDiag.mediaDevices ? 'ok' : 'missing'}</b>`;
      }

      if (!this.hasCompletedCalibration) {
        let calResult = { outcome: 'incomplete', skipped: true, reason: 'timeout-guard' };
        try {
          // Global guard so calibration can never stall session start.
          const timeoutMs = 15000;
          calResult = await Promise.race([
            this.calibrationWizard.run(this.analyzer),
            new Promise((resolve) => setTimeout(() => resolve({ outcome: 'incomplete', skipped: true, reason: 'wizard-timeout' }), timeoutMs)),
          ]);
        } catch (err) {
          console.error('Calibration flow failed:', err);
          calResult = { outcome: 'incomplete', skipped: true, reason: 'wizard-exception' };
        }
        this.hasCompletedCalibration = true;
        showCalibrationOutcome(calResult);
      }

      this.scrollX = 0;
      this.cameraY = 0;
      this.targetCameraY = 0;
      this.cameraZoom = 1.4;
      this.targetZoom = 1.4;
      this.prosodyScore = 0;
      this.voiceCanvasPaused = false;
      if (pauseCanvasBtn) {
        pauseCanvasBtn.textContent = 'Pause';
        pauseCanvasBtn.classList.remove('active');
      }
      this.guidedStartTs = performance.now();
      this.guidedDismissed = false;
      this.guidedCloseHitbox = null;
      this.guidedPitchStable = 0;
      this.guidedChecklist = {
        roomReady: this.analyzer.isCalibrated,
        voiceDetected: false,
        pitchLocked: false,
      };
      this.particles = [];
      this.trailPoints = [];
      this.sparkles = [];
      this.ball.vy = 0;
      this.ball.onGround = true;
      this.ball.squash = 1;
      this.ball.radius = this.ball.baseRadius;
      this.ball.x = this.width * 0.45;
      this.ball.y = this.getGroundHeight(this.scrollX + this.ball.x) - this.ball.radius;

      // Reset voice canvas for new session
      if (this.gameMode === 'canvas' || this.gameMode === 'keyboard') {
        const vc = this.voiceCanvas;
        vc.cursorX = 30;
        vc.smoothPitchY = 0.5;
        vc.lastPaintY = 0.5;
        vc.lastScreenY = this.height * 0.5;
        vc.lastCtrlY = this.height * 0.5;
        vc.lastPaintX = 30;
        vc.splatters = [];
        vc.drips = [];
        vc.articMarkers = [];
        vc.motes = [];
        vc.isSpeaking = false;
        vc.wasSpeaking = false;
        vc.strokeCount = 0;
        vc.totalPaintX = 0;
        vc.smoothViewX = 0;
        vc.vibrato = 0;
        vc.smoothEnergy = 0;
        if (vc.bufferCtx) {
          vc.bufferCtx.clearRect(0, 0, vc.bufferW, vc.bufferH);
        }
      }

      // Reset creature ephemeral state (keep structural points)
      if (this.gameMode === 'creature') {
        const c = this.creature;
        c.glow = 0; c.wingSpread = 0; c.transformLevel = 0; c.floatY = 0;
        c.pulseRings = []; c.auraParticles = []; c.tendrilGrow = 0;
        for (const t of c.tendrils) { t.length = 0; t.targetLength = 0; }
        // Reset style-specific state
        const j = this._jelly; j.glow = 0.15; j.biolumFlash = 0; j.transformLevel = 0; j.floatY = 0; j.particles = [];
        for (const t of j.tentacles) t.length = t.targetLen = 30;
        const ph = this._phoenix; ph.flameIntensity = 0.1; ph.transformLevel = 0; ph.floatY = 0; ph.flames = []; ph.sparks = []; ph.embers = [];
        const nb = this._nebula; nb.coreGlow = 0.1; nb.transformLevel = 0; nb.ringAlpha = 0; nb.flares = [];
        const sp = this._spirit; sp.glow = 0.15; sp.transformLevel = 0; sp.floatY = 0; sp.lights = [];
        const ko = this._koi; ko.transformLevel = 0; ko.floatY = 0; ko.whiskerLen = 0; ko.ripples = [];
      }

      // Reset garden ephemeral state (keep plants — they accumulate)
      if (this.gameMode === 'garden') {
        const g = this.garden;
        g.pollen = [];
        g.fireflies = [];
        g.globalGrowth = 0;
        g.spawnCooldown = 0;
      }

      if (this.gameMode === 'pilot') {
        this._resetPitchPilotState();
        const choice = await this._offerPitchPilotRange({ allowContinueSame: false });
        this._applyPitchPilotRangeChoice(choice);
      }
      if (this.gameMode === 'road') {
        this._resetResonanceRoadState();
      }
      if (this.gameMode === 'ascent') {
        this._resetSpectralAscentState();
      }
      if (this.gameMode === 'prism') {
        this._resetPrismReaderState();
        if (this.prismReader.passageMode === 'freestyle' && this.prismReader.processMode === 'realtime') {
          if (this.prismReader.speechRecognition) {
            try { this.prismReader.speechRecognition.start(); } catch (e) { }
          }
        }
      }
      if (this.gameMode === 'vowelvalley') {
        this._resetVowelValleyState();
      }

      // Clear vibration alert tripped highlights
      for (const rule of this.vibration.rules) { rule.tripped = false; }
      this.vibration.flashAlpha = 0;
      if (this._renderVibRules) this._renderVibRules();

      // Initialize session stats
      this.session.startTime = Date.now();
      this.session.duration = 0;
      this.session.pitchSum = 0;
      this.session.pitchCount = 0;
      this.session.pitchMin = Infinity;
      this.session.pitchMax = 0;
      this.session.resonanceSum = 0;
      this.session.resonanceCount = 0;
      this.session.prosodyHistory = [];
      this.session.prosodySampleTimer = 0;
      this.session.plantsAtStart = this.garden.plants.length;
      this.session.scrollAtStart = this.scrollX;
      this.session.canvasAtStart = this.voiceCanvas.cursorX;

      // Show session timer
      const timerEl = document.getElementById('sessionTimer');
      timerEl.textContent = '0:00';
      timerEl.classList.add('active');

      // Hide summary if visible
      document.getElementById('summaryOverlay').classList.remove('show');

      welcomeOverlay.classList.add('hidden');
      document.getElementById('app').classList.add('playing');
      setHudSettingsVisible(true);
      if (iframeNotice) iframeNotice.classList.remove('show');
      helpTooltip.classList.remove('show');
      vibPanel.classList.remove('show');
      recordingsDrawer.classList.remove('show');
      const modeNames = { ball: 'Ball', creature: 'Creature', garden: 'Garden', canvas: 'Canvas', keyboard: 'Keyboard', pilot: 'Pitch Pilot', road: 'Resonance Road', ascent: 'Spectral Ascent', prism: 'Prism Reader', vowelvalley: 'Vowel Valley' };
      startBtn.textContent = `⏹ Stop ${modeNames[this.gameMode] || ''}`;
      startBtn.classList.add('active');
      recBtn.classList.add('visible');
      const hud = document.getElementById('creatureStyleHud');
      if (hud) hud.style.display = this.gameMode === 'creature' ? '' : 'none';
      this.isRunning = true;
      this.lastTime = performance.now();
      this.loop();
    };

    const stopGame = async () => {
      // Auto-stop recording if active — must await so recorder can
      // flush its final chunk before we kill the mic stream
      if (this.isRecording) {
        recBtn.classList.remove('recording');
        recBtn.querySelector('.rec-label').textContent = 'Rec';
        await this.stopRecording();
      }
      if (this.prismReader && this.prismReader.speechRecognition) {
        try { this.prismReader.speechRecognition.stop(); } catch (e) { }
      }
      this.isRunning = false;
      const hud = document.getElementById('creatureStyleHud');
      if (hud) hud.style.display = 'none';
      this.analyzer.stop();
      setRecoverMicVisible(false);
      // Hide prism overlay on stop
      const prismOvl = document.getElementById('prismOverlay');
      if (prismOvl) prismOvl.classList.remove('show');
      startBtn.textContent = '🎙 Start';
      startBtn.classList.remove('active');
      recBtn.classList.remove('visible');

      // Hide session timer
      document.getElementById('sessionTimer').classList.remove('active');

      // Clear vibration alert tripped highlights on stop
      for (const rule of this.vibration.rules) { rule.tripped = false; }
      this.vibration.flashAlpha = 0;
      if (this._renderVibRules) this._renderVibRules();
      if (this._gameArea) this._gameArea.classList.remove('vib-shake');

      // Show session summary if session was meaningful (> 3 seconds)
      if (this.session.duration > 3) {
        this._showSessionSummary();
        this.drawIdleScene(); // animate behind semi-transparent summary
      } else {
        welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
        this.drawIdleScene();
      }
    };

    startBtn?.addEventListener('click', () => {
      if (this.isRunning) stopGame(); else startGame();
    });

    playBtn?.addEventListener('click', startGame);

    perfBtn?.addEventListener('click', () => {
      this.perfMonitor.toggle();
      perfBtn.classList.toggle('active', this.perfMonitor.enabled);
    });

    homeBtn?.addEventListener('click', () => {
      // If a game is running, stop it and go directly to menu
      if (this.isRunning) {
        this.isRunning = false;
        const hud = document.getElementById('creatureStyleHud');
        if (hud) hud.style.display = 'none';
        this.analyzer.stop();
        setRecoverMicVisible(false);
        const prismOvl = document.getElementById('prismOverlay');
        if (prismOvl) prismOvl.classList.remove('show');
        startBtn.textContent = '🎙 Start';
        startBtn.classList.remove('active');
        const recBtn = document.getElementById('recBtn');
        if (recBtn) recBtn.classList.remove('visible');

        document.getElementById('sessionTimer').classList.remove('active');
        for (const rule of this.vibration.rules) { rule.tripped = false; }
        this.vibration.flashAlpha = 0;
        if (this._renderVibRules) this._renderVibRules();
        if (this._gameArea) this._gameArea.classList.remove('vib-shake');
      }

      // Show the menu directly
      welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
      document.getElementById('summaryOverlay').classList.remove('show');
      this.drawIdleScene();
    });

    // Session summary buttons
    document.getElementById('summaryBackBtn')?.addEventListener('click', () => {
      document.getElementById('summaryOverlay').classList.remove('show');
      welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
      // Reset mode selection so user can pick fresh
      modeDetails.classList.remove('show');
      modeCards.forEach(c => c.classList.remove('selected'));
      [ballDetails, creatureDetails, gardenDetails, canvasDetails, keyboardDetails, pilotDetails, roadDetails, ascentDetails, prismDetails]
        .forEach(p => p && p.classList.remove('show'));
      this.drawIdleScene();
    });
    document.getElementById('summaryAgainBtn')?.addEventListener('click', () => {
      document.getElementById('summaryOverlay').classList.remove('show');
      startGame();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Don't capture when typing in inputs
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (this.isRunning && this.gameMode === 'prism') {
          this._advancePrismManual();
          return;
        }
        if (document.getElementById('summaryOverlay').classList.contains('show')) {
          // From summary → start again
          document.getElementById('summaryOverlay').classList.remove('show');
          startGame();
        } else {
          startBtn.click();
        }
      }
      if (e.code === 'KeyP') {
        e.preventDefault();
        this.perfMonitor.toggle();
        perfBtn?.classList.toggle('active', this.perfMonitor.enabled);
      }
      if (e.code === 'KeyR' && this.isRunning) {
        e.preventDefault();
        recBtn.click();
      }
      if (e.code === 'Escape') {
        // Close metric popup first if open
        if (this.metricPopupOpen) {
          this._closeMetricPopup();
          return;
        }
        helpTooltip.classList.remove('show');
        vibPanel.classList.remove('show');
        recordingsDrawer.classList.remove('show');
        // If summary is showing, go to menu
        if (document.getElementById('summaryOverlay').classList.contains('show')) {
          document.getElementById('summaryOverlay').classList.remove('show');
          welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
          this.drawIdleScene();
        }
      }
    });

    // Mode picker
    const modePicker = document.getElementById('modePicker');
    const modeDetails = document.getElementById('modeDetails');
    const ballDetails = document.getElementById('ballDetails');
    const creatureDetails = document.getElementById('creatureDetails');
    const gardenDetails = document.getElementById('gardenDetails');
    const canvasDetails = document.getElementById('canvasDetails');
    const keyboardDetails = document.getElementById('keyboardDetails');
    const pilotDetails = document.getElementById('pilotDetails');
    const roadDetails = document.getElementById('roadDetails');
    const ascentDetails = document.getElementById('ascentDetails');
    const prismDetails = document.getElementById('prismDetails');
    const vowelvalleyDetails = document.getElementById('vowelvalleyDetails');
    const modeCards = modePicker ? modePicker.querySelectorAll('.mode-card') : [];

    document.querySelectorAll('.canvas-only').forEach(el => el.classList.toggle('show', this.gameMode === 'canvas' || this.gameMode === 'keyboard'));
    if (canvasContextBar) canvasContextBar.classList.remove('expanded');
    if (contextToggleBtn) {
      contextToggleBtn.setAttribute('aria-expanded', 'false');
      contextToggleBtn.textContent = 'Canvas Controls';
    }
    if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');

    const selectMode = (mode, card) => {
      if (this.gameMode !== mode) this._playMenuBlip();
      this.gameMode = mode;
      if (mode === 'keyboard') this.canvasMode = 'keyboard';
      if (mode === 'canvas') this.canvasMode = 'paint';

      modeCards.forEach(c => c.classList.toggle('selected', c === card));
      modeDetails?.classList.add('show');
      ballDetails?.classList.toggle('show', mode === 'ball');
      creatureDetails?.classList.toggle('show', mode === 'creature');
      gardenDetails?.classList.toggle('show', mode === 'garden');
      canvasDetails?.classList.toggle('show', mode === 'canvas');
      keyboardDetails?.classList.toggle('show', mode === 'keyboard');
      pilotDetails?.classList.toggle('show', mode === 'pilot');
      roadDetails?.classList.toggle('show', mode === 'road');
      ascentDetails?.classList.toggle('show', mode === 'ascent');
      prismDetails?.classList.toggle('show', mode === 'prism');
      vowelvalleyDetails?.classList.toggle('show', mode === 'vowelvalley');

      const titles = { ball: 'VOX ARCADE', creature: 'VOICE CREATURE', garden: 'VOICE GARDEN', canvas: 'VOICE CANVAS', keyboard: 'VOCAL KEYBOARD', pilot: 'PITCH PILOT', road: 'RESONANCE ROAD', ascent: 'SPECTRAL ASCENT', prism: 'PRISM READER', vowelvalley: 'VOWEL VALLEY' };
      document.querySelector('.hud-title').textContent = titles[mode] || 'VOX ARCADE';
      const canvasOnly = document.querySelectorAll('.canvas-only');
      canvasOnly.forEach(el => el.classList.toggle('show', mode === 'canvas' || mode === 'keyboard'));
      if (canvasContextBar && mode !== 'canvas' && mode !== 'keyboard') {
        canvasContextBar.classList.remove('expanded');
      }
      if (contextToggleBtn) {
        const expanded = canvasContextBar?.classList.contains('expanded');
        contextToggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        contextToggleBtn.textContent = expanded ? 'Hide Canvas Controls' : 'Canvas Controls';
      }
      if (canvasModeSelect) {
        canvasModeSelect.style.display = mode === 'canvas' ? '' : 'none';
        canvasModeSelect.value = this.canvasMode;
      }
      if (keyboardGameSelect) keyboardGameSelect.style.display = mode === 'keyboard' ? '' : 'none';
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', mode !== 'prism' && this.teleprompterMode !== 'off');
      this._updateHelpContent();
      this._updatePrismRecBtnVisibility();
      if (mode === 'pilot') this._resetPitchPilotState();
      if (mode === 'road') this._resetResonanceRoadState();
      if (mode === 'ascent') this._resetSpectralAscentState();
      if (mode === 'prism') this._resetPrismReaderState();
      if (mode === 'vowelvalley') this._resetVowelValleyState();
      if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
      if (!this.isRunning) this.drawIdleScene();
    };

    if (!modePicker) {
      console.error('Mode picker element not found; main menu selection is unavailable.');
      return;
    }

    const activateFromEvent = (event, preventDefault = false) => {
      const target = event.target instanceof Element
        ? event.target
        : event.target && event.target.parentElement;
      if (!target) return;
      const card = target.closest('.mode-card');
      if (!card || !modePicker.contains(card)) return;
      if (preventDefault) event.preventDefault();
      selectMode(card.dataset.mode, card);
    };

    modePicker?.addEventListener('click', (event) => activateFromEvent(event, false));
    modePicker?.addEventListener('touchend', (event) => activateFromEvent(event, true), { passive: false });

    contextToggleBtn?.addEventListener('click', () => {
      if (!canvasContextBar) return;
      const nextExpanded = !canvasContextBar.classList.contains('expanded');
      canvasContextBar.classList.toggle('expanded', nextExpanded);
      contextToggleBtn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      contextToggleBtn.textContent = nextExpanded ? 'Hide Canvas Controls' : 'Canvas Controls';
    });

    // Also bind directly on each card so mode selection still works even if delegated
    // events are disrupted by embedding layers / browser quirks.
    modeCards.forEach((card) => {
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('click', () => selectMode(card.dataset.mode, card));
      card.addEventListener('touchend', (event) => {
        event.preventDefault();
        selectMode(card.dataset.mode, card);
      }, { passive: false });
      card.addEventListener('keydown', (event) => {
        if (event.code === 'Enter' || event.code === 'Space') {
          event.preventDefault();
          selectMode(card.dataset.mode, card);
        }
      });
    });

    // Default a visible selection so mode tap/click state is always initialized.
    const initialCard = modePicker?.querySelector(`.mode-card[data-mode="${this.gameMode}"]`) || modeCards[0];
    if (initialCard) selectMode(initialCard.dataset.mode, initialCard);

    // Creature style picker (both menu + HUD versions)
    const syncStylePickers = (style) => {
      this.creatureStyle = style;
      document.querySelectorAll('#creatureStylePicker .style-pill, #creatureStyleHud .style-pill').forEach(b => {
        b.classList.toggle('selected', b.dataset.style === style);
      });
      if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
      if (!this.isRunning) this.drawIdleScene();
    };
    document.querySelectorAll('#creatureStylePicker .style-pill, #creatureStyleHud .style-pill').forEach(btn => {
      btn.addEventListener('click', () => syncStylePickers(btn.dataset.style));
    });



    visualStyleSelect?.addEventListener('change', (e) => {
      this.voiceCanvasVisualStyle = e.target.value;
    });


    const applyVoiceProfilePreset = (preset) => {
      this.voiceProfilePreset = preset;
      const profiles = {
        auto: { min: 80, max: 380, sustainMul: 1, tiltShift: 0 },
        deeper: { min: 60, max: 260, sustainMul: 0.95, tiltShift: -2 },
        lighter: { min: 120, max: 520, sustainMul: 1.05, tiltShift: 2 },
        expressive: { min: 70, max: 460, sustainMul: 1.15, tiltShift: 0 }
      };
      const cfg = profiles[preset] || profiles.auto;
      this.analyzer.pitchProfile.min = cfg.min;
      this.analyzer.pitchProfile.max = cfg.max;
      this.analyzer.pitchProfile.isLearned = false;
      this.analyzer.pitchProfile.samples = [];
      this.analyzer.tiltProfile.isLearned = false;
      this.analyzer.tiltProfile.samples = [];
      const baseSustain = this.analyzer.defaultSustainedThreshold || this.analyzer.sustainedThreshold || 0.02;
      this.analyzer.sustainedThreshold = Math.max(0.01, baseSustain * cfg.sustainMul);
      this.analyzer.spectralTiltSmoothedDb += cfg.tiltShift;
    };

    voiceProfileSelect?.addEventListener('change', (e) => {
      applyVoiceProfilePreset(e.target.value);
    });

    canvasModeSelect?.addEventListener('change', (e) => {
      this.canvasMode = e.target.value;
      if (canvasModeSelect) canvasModeSelect.style.display = this.gameMode === 'canvas' ? '' : 'none';
      if (keyboardGameSelect) keyboardGameSelect.style.display = this.canvasMode === 'keyboard' ? '' : 'none';
      if (!this.isRunning) this.drawIdleScene();
    });

    keyboardGameSelect?.addEventListener('change', (e) => {
      this.keyboardGameMode = e.target.value;
      this._resetKeyboardModeState();
      if (!this.isRunning) this.drawIdleScene();
    });
    if (canvasModeSelect) canvasModeSelect.style.display = this.gameMode === 'canvas' ? '' : 'none';
    if (keyboardGameSelect) keyboardGameSelect.style.display = this.canvasMode === 'keyboard' ? '' : 'none';

    pitchLabelsSelect?.addEventListener('change', (e) => {
      this.pitchGuideLabelMode = e.target.value;
    });



    roadTargetSelect?.addEventListener('change', (e) => {
      this.resonanceRoad.targetTone = e.target.value;
      if (!this.isRunning && this.gameMode === 'road') this.drawIdleScene();
    });

    roadPassageSelect?.addEventListener('change', (e) => {
      this.resonanceRoad.passageMode = e.target.value;
    });

    roadCustomText?.addEventListener('input', (e) => {
      this.resonanceRoad.customText = e.target.value;
    });

    prismPacingSelect?.addEventListener('change', (e) => {
      this.prismReader.manualMode = e.target.value === 'manual';
    });

    prismPassageSelect?.addEventListener('change', (e) => {
      this.prismReader.passageMode = e.target.value;
      this._updatePrismPassageMeta();
      if (!this.isRunning && this.gameMode === 'prism') this._resetPrismReaderState();
    });

    // Initialize passage metadata on load
    this._updatePrismPassageMeta();

    prismCustomText?.addEventListener('input', (e) => {
      this.prismReader.customText = e.target.value;
    });

    const prismModeSelect = document.getElementById('prismModeSelect');
    prismModeSelect?.addEventListener('change', (e) => {
      this.prismReader.processMode = e.target.value;
      this._updatePrismRecBtnVisibility();
      if (!this.isRunning && this.gameMode === 'prism') this._resetPrismReaderState();
    });

    hudRecBtn?.addEventListener('click', () => {
      if (this.gameMode === 'prism' && this.prismReader.processMode === 'record') {
        this._togglePrismRecording();
      }
    });

    const prismClearRecBtn = document.getElementById('prismClearRecBtn');
    prismClearRecBtn?.addEventListener('click', () => {
      if (this.gameMode === 'prism' && this.prismReader.processMode === 'record') {
        if (this.prismReader.isPlayingBack) this._stopPrismPlayback();
        if (this.prismReader.isRecording) this._stopPrismRecording();
        this.prismReader.audioBlob = null;
        if (this.prismReader.audioPlayer) {
          this.prismReader.audioPlayer.pause();
          this.prismReader.audioPlayer.src = '';
        }
        this.prismReader.audioChunks = [];
        this._updatePrismRecBtnVisibility();
        this._resetPrismReaderState();
      }
    });

    const prismSaveRecBtn = document.getElementById('prismSaveRecBtn');
    prismSaveRecBtn?.addEventListener('click', () => {
      const pr = this.prismReader;
      if (this.gameMode === 'prism' && pr.processMode === 'record' && pr.audioBlob) {
        const now = new Date();
        const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const fileTs = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const duration = pr.audioPlayer?.duration || 0;

        const reader = new FileReader();
        reader.onloadend = () => {
          this.recordings.push({
            blob: pr.audioBlob,
            dataUrl: reader.result,
            duration: duration,
            timestamp: ts,
            name: `prism-reading-${fileTs}`,
            mimeType: 'audio/webm'
          });
          this.updateRecordingsUI();

          const ogText = prismSaveRecBtn.textContent;
          prismSaveRecBtn.textContent = 'Saved!';
          setTimeout(() => { if (prismSaveRecBtn) prismSaveRecBtn.textContent = ogText; }, 2000);
        };
        reader.readAsDataURL(pr.audioBlob);
      }
    });

    // Tap-to-advance for prism reader (mobile + desktop click)
    const prismOverlayEl = document.getElementById('prismOverlay');
    if (prismOverlayEl) {
      prismOverlayEl.addEventListener('click', (e) => {
        // Don't advance if clicking the completion panel or restart button
        if (e.target.closest('.prism-completion')) return;
        if (this.isRunning && this.gameMode === 'prism') {
          this._advancePrismManual();
        }
      });
    }

    // Restart button for prism reader
    const prismRestartBtn = document.getElementById('prismRestartBtn');
    if (prismRestartBtn) {
      prismRestartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.gameMode === 'prism') {
          this._resetPrismReaderState();
        }
      });
    }

    teleprompterModeSelect?.addEventListener('change', (e) => {
      this.teleprompterMode = e.target.value;
      this.teleprompterIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
      teleprompterCustomBtn?.classList.toggle('active', this.teleprompterMode === 'custom');
    });

    teleprompterCustomBtn?.addEventListener('click', () => {
      const existing = this.teleprompterCustomText || '';
      const input = window.prompt('Paste or type your teleprompter text:', existing);
      if (input === null) return;
      this.teleprompterCustomText = input.trim();
      if (!this.teleprompterCustomText) {
        this.teleprompterMode = 'rainbow';
      } else {
        this.teleprompterMode = 'custom';
      }
      if (teleprompterModeSelect) teleprompterModeSelect.value = this.teleprompterMode;
      this.teleprompterIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
      teleprompterCustomBtn.classList.toggle('active', this.teleprompterMode === 'custom');
    });

    pauseCanvasBtn?.addEventListener('click', () => {
      this.voiceCanvasPaused = !this.voiceCanvasPaused;
      pauseCanvasBtn.textContent = this.voiceCanvasPaused ? 'Resume' : 'Pause';
      pauseCanvasBtn.classList.toggle('active', this.voiceCanvasPaused);
    });

    clearCanvasBtn?.addEventListener('click', () => {
      const vc = this.voiceCanvas;
      if (vc.bufferCtx) vc.bufferCtx.clearRect(0, 0, vc.bufferW, vc.bufferH);
      vc.splatters = [];
      vc.drips = [];
      vc.articMarkers = [];
      vc.motes = [];
      vc.strokeCount = 0;
      vc.totalPaintX = 0;
      showError('ℹ Canvas cleared.');
    });

    document.getElementById('resMethodSelect').addEventListener('change', (e) => {
      this.analyzer.resonanceMethod = e.target.value;
      // Reset smoothed values when switching methods for clean comparison
      this.analyzer.smoothF1 = 500;
      this.analyzer.smoothF2 = 1500;
      this.analyzer.smoothF3 = 2700;
      this.analyzer.smoothResonance = 0.5;
      this.analyzer.formantConfidence = 0;
    });

    // Colorblind mode toggle
    const cbBtn = document.getElementById('cbToggle');
    if (cbBtn) {
      cbBtn.addEventListener('click', () => {
        this.colorblindMode = !this.colorblindMode;
        document.documentElement.classList.toggle('colorblind', this.colorblindMode);
        cbBtn.classList.toggle('active', this.colorblindMode);
      });
    }


    // ====== EXPANDABLE METRICS PANEL ======
    const metersPanel = document.getElementById('metersPanel');
    const metersExpandToggle = document.getElementById('metersExpandToggle');
    const metersExpanded = document.getElementById('metersExpanded');
    const appEl = document.getElementById('app');
    metersExpandToggle?.addEventListener('click', () => {
      this.metersExpanded = !this.metersExpanded;
      metersPanel.classList.toggle('expanded', this.metersExpanded);
      appEl.classList.toggle('meters-open', this.metersExpanded);
      metersExpandToggle.setAttribute('aria-expanded', this.metersExpanded ? 'true' : 'false');
      // Reflow the game canvas after panel height changes so the ball/ground stay in view.
      requestAnimationFrame(() => this.resize());
      // Expansion animation shifts layout over ~300ms; run one more resize after it settles.
      setTimeout(() => this.resize(), 320);
      // Size canvases after layout settles
      if (this.metersExpanded) {
        requestAnimationFrame(() => this._sizeExpandedCanvases());
      }
    });

    // Metric card click → open popup
    metersExpanded?.querySelectorAll('.metric-card').forEach(card => {
      card.addEventListener('click', () => {
        const metric = card.dataset.metric;
        this._openMetricPopup(metric);
      });
    });

    // Popup close
    const popupBackdrop = document.getElementById('metricPopupBackdrop');
    const popupClose = document.getElementById('metricPopupClose');
    popupClose?.addEventListener('click', () => this._closeMetricPopup());
    popupBackdrop?.addEventListener('click', (e) => {
      if (e.target === popupBackdrop) this._closeMetricPopup();
    });

    const syncMotionToggleLabel = () => {
      if (!motionToggle) return;
      const next = this.userMotionPreference === 'auto' ? 'Auto' : this.userMotionPreference === 'low' ? 'Low' : 'Full';
      motionToggle.textContent = `Motion: ${next}`;
      motionToggle.classList.toggle('active', this.userMotionPreference === 'low');
    };
    syncMotionToggleLabel();
    motionToggle?.addEventListener('click', () => {
      const order = ['auto', 'low', 'full'];
      const idx = order.indexOf(this.userMotionPreference);
      this.userMotionPreference = order[(idx + 1) % order.length];
      localStorage.setItem('vox:motionPreference', this.userMotionPreference);
      this._applyMotionPreferences();
      syncMotionToggleLabel();
    });


    // ---- Vibration alert UI ----
    const vibBtn = document.getElementById('vibToggle');
    const vibPanel = document.getElementById('vibPanel');
    const vibMaster = document.getElementById('vibMasterToggle');
    const vibRulesList = document.getElementById('vibRulesList');
    const vibAddBtn = document.getElementById('vibAddRule');
    const gameArea = document.querySelector('.game-area');

    // ---- Settings Panel UI ----
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const modalBackdrop = document.getElementById('modalBackdrop');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');

    const toggleSettings = (show) => {
      const isVisible = show !== undefined ? show : !settingsPanel.classList.contains('show');
      settingsPanel.classList.toggle('show', isVisible);
      modalBackdrop.classList.toggle('show', isVisible);

      // Force DOM visibility (bypass any CSS specificity issues)
      if (isVisible) {
        settingsPanel.removeAttribute('hidden');
        settingsPanel.style.display = 'flex';
        settingsPanel.style.opacity = '1';
        settingsPanel.style.pointerEvents = 'auto';
        helpTooltip.classList.remove('show');
        recordingsDrawer.classList.remove('show');
        vibPanel.classList.remove('show');
      } else {
        settingsPanel.style.display = 'none';
        settingsPanel.style.opacity = '0';
        settingsPanel.style.pointerEvents = 'none';
        settingsPanel.setAttribute('hidden', '');
      }
    };

    settingsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettings();
    });

    closeSettingsBtn?.addEventListener('click', () => toggleSettings(false));
    modalBackdrop?.addEventListener('click', () => toggleSettings(false));

    // Global click-to-close for all overlays
    document.addEventListener('click', (e) => {
      // Settings panel (if clicking outside and not the gear)
      if (settingsPanel && !settingsPanel.contains(e.target) && e.target !== settingsBtn && !settingsBtn.contains(e.target)) {
        if (settingsPanel.classList.contains('show')) toggleSettings(false);
      }
      // Vibration panel
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || e.target !== vibBtn)) {
        vibPanel.classList.remove('show');
      }
    });

    if (vibBtn) {
      vibBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (vibPanel) vibPanel.classList.toggle('show');
        if (helpTooltip) helpTooltip.classList.remove('show');
        if (recordingsDrawer) recordingsDrawer.classList.remove('show');
        if (settingsPanel) settingsPanel.classList.remove('show');
      });
    }

    if (vibMaster) {
      vibMaster.addEventListener('change', () => {
        this.vibration.enabled = vibMaster.checked;
        if (vibBtn) vibBtn.classList.toggle('active', vibMaster.checked);
      });
    }

    const vibMetrics = [
      { value: 'pitch', label: 'Pitch (Hz)', unit: 'Hz', min: 50, max: 500, step: 5, defaultBelow: 150, defaultAbove: 250 },
      { value: 'resonance', label: 'Resonance', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 30, defaultAbove: 70 },
      { value: 'energy', label: 'Energy', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
      { value: 'bounce', label: 'Pitch Variation', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
      { value: 'tempo', label: 'Tempo Var.', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
      { value: 'vowel', label: 'Vowel Sustain', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 70 },
      { value: 'articulation', label: 'Articulation', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
    ];

    const getMetricInfo = (val) => vibMetrics.find(m => m.value === val) || vibMetrics[0];

    const renderVibRules = () => {
      vibRulesList.innerHTML = '';
      const hintEl = document.getElementById('vibEmptyHint');
      if (hintEl) hintEl.style.display = this.vibration.rules.length === 0 ? 'block' : 'none';
      for (const rule of this.vibration.rules) {
        const info = getMetricInfo(rule.metric);
        const el = document.createElement('div');
        el.className = 'vib-rule' + (rule.tripped ? ' tripped' : '');
        el.dataset.ruleId = rule.id;

        el.innerHTML = `
          <div class="vib-rule-config">
            <div class="vib-rule-top">
              <select class="vib-metric" aria-label="Metric">
                ${vibMetrics.map(m => `<option value="${m.value}" ${m.value === rule.metric ? 'selected' : ''}>${m.label}</option>`).join('')}
              </select>
              <select class="vib-dir" aria-label="Direction">
                <option value="below" ${rule.direction === 'below' ? 'selected' : ''}>drops below</option>
                <option value="above" ${rule.direction === 'above' ? 'selected' : ''}>goes above</option>
              </select>
            </div>
            <div class="vib-rule-top">
              <input type="number" class="vib-threshold" value="${rule.threshold}" min="${info.min}" max="${info.max}" step="${info.step}" aria-label="Threshold">
              <span class="vib-rule-unit">${info.unit}</span>
              <span class="vib-live-val" data-rule-id="${rule.id}" style="font-size:0.62rem;color:rgba(255,255,255,0.35);margin-left:4px;min-width:32px;text-align:right">—</span>
              <label class="toggle-switch" style="margin-left:4px">
                <input type="checkbox" class="vib-rule-toggle" ${rule.enabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
          <button class="vib-rule-del" title="Delete rule">✕</button>
        `;

        // Wire events
        el.querySelector('.vib-metric').addEventListener('change', (e) => {
          rule.metric = e.target.value;
          const newInfo = getMetricInfo(rule.metric);
          rule.threshold = rule.direction === 'below' ? newInfo.defaultBelow : newInfo.defaultAbove;
          renderVibRules();
        });
        el.querySelector('.vib-dir').addEventListener('change', (e) => {
          rule.direction = e.target.value;
        });
        el.querySelector('.vib-threshold').addEventListener('input', (e) => {
          rule.threshold = parseFloat(e.target.value) || 0;
        });
        el.querySelector('.vib-rule-toggle').addEventListener('change', (e) => {
          rule.enabled = e.target.checked;
        });
        el.querySelector('.vib-rule-del').addEventListener('click', () => {
          this.vibration.rules = this.vibration.rules.filter(r => r.id !== rule.id);
          renderVibRules();
        });

        vibRulesList.appendChild(el);
      }
    };

    vibAddBtn.addEventListener('click', () => {
      this.vibration.rules.push({
        id: this.vibration.nextId++,
        metric: 'pitch',
        direction: 'below',
        threshold: 150,
        enabled: true,
        cooldownTimer: 0,
        tripped: false,
      });
      renderVibRules();
    });

    // Store render function for external updates
    this._renderVibRules = renderVibRules;
    this._gameArea = gameArea;
    this._vibRulesList = vibRulesList;

    // Lightweight live-value updater (called from game loop, no DOM rebuild)
    this._updateVibLiveUI = () => {
      const m = this.analyzer.metrics;
      const hz = this.analyzer.smoothPitchHz;
      for (const rule of this.vibration.rules) {
        // Update live value readout
        const valEl = vibRulesList.querySelector(`.vib-live-val[data-rule-id="${rule.id}"]`);
        if (valEl) {
          let val;
          switch (rule.metric) {
            case 'pitch': val = Math.round(hz); break;
            case 'resonance': val = Math.round(this.analyzer.smoothResonance * 100); break;
            case 'energy': val = Math.round(m.energy * 100); break;
            case 'bounce': val = Math.round(m.bounce * 100); break;
            case 'tempo': val = Math.round(m.tempo * 100); break;
            case 'vowel': val = Math.round(m.vowel * 100); break;
            case 'articulation': val = Math.round(m.articulation * 100); break;
            default: val = 0;
          }
          const isActive = m.energy > 0.05;
          valEl.textContent = isActive ? `${val}` : '—';
          valEl.style.color = rule.tripped
            ? 'rgba(255,160,60,0.8)'
            : 'rgba(255,255,255,0.35)';
        }
        // Update tripped highlight on row (lightweight class toggle)
        const rowEl = vibRulesList.querySelector(`[data-rule-id="${rule.id}"]`);
        if (rowEl && rowEl.classList.contains('vib-rule')) {
          rowEl.classList.toggle('tripped', rule.tripped);
        }
      }
    };

    document.getElementById('vibTestBtn').addEventListener('click', () => {
      this._triggerVibration('Test');
    });

    // Preset configurations
    const addPresetRules = (rules) => {
      // Clear existing rules
      this.vibration.rules = [];
      for (const r of rules) {
        this.vibration.rules.push({
          id: this.vibration.nextId++,
          metric: r.metric,
          direction: r.direction,
          threshold: r.threshold,
          enabled: true,
          cooldownTimer: 0,
          tripped: false,
        });
      }
      // Enable master toggle
      this.vibration.enabled = true;
      vibMaster.checked = true;
      vibBtn.classList.add('active');
      renderVibRules();
    };

    document.getElementById('vibPresetFem').addEventListener('click', () => {
      addPresetRules([
        { metric: 'pitch', direction: 'below', threshold: 155 },
        { metric: 'pitch', direction: 'above', threshold: 280 },
        { metric: 'resonance', direction: 'below', threshold: 40 },
      ]);
    });

    document.getElementById('vibPresetMasc').addEventListener('click', () => {
      addPresetRules([
        { metric: 'pitch', direction: 'above', threshold: 140 },
        { metric: 'pitch', direction: 'below', threshold: 80 },
        { metric: 'resonance', direction: 'above', threshold: 60 },
      ]);
    });

    recalibrateBtn?.addEventListener('click', async () => {
      if (!this.analyzer.isActive) {
        showError('ℹ Start a session first, then tap Recalibrate.');
        return;
      }
      const calResult = await this.calibrationWizard.run(this.analyzer);
      this.hasCompletedCalibration = true;
      this.guidedStartTs = performance.now();
      this.guidedDismissed = false;
      this.guidedCloseHitbox = null;
      this.guidedPitchStable = 0;
      this.guidedChecklist.roomReady = this.analyzer.isCalibrated;
      this.guidedChecklist.voiceDetected = false;
      this.guidedChecklist.pitchLocked = false;
      showCalibrationOutcome(calResult);
    });

    this.canvas.addEventListener('click', (e) => {
      if (!this.isRunning || this.guidedDismissed || !this.guidedCloseHitbox) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this.guidedCloseHitbox;
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        this.guidedDismissed = true;
        this.guidedCloseHitbox = null;
      }
    });

    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._updateHelpContent();
      helpTooltip.classList.toggle('show');
      recordingsDrawer.classList.remove('show');
      vibPanel.classList.remove('show');
    });

    helpTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const selected = tab.dataset.tab;
        helpTabs.forEach((btn) => btn.classList.toggle('active', btn === tab));
        helpPanels.forEach((panel) => {
          panel.classList.toggle('active', panel.dataset.panel === selected);
        });
      });
    });

    document.addEventListener('click', (e) => {
      if (helpTooltip && !helpTooltip.contains(e.target) && e.target !== helpBtn) {
        helpTooltip.classList.remove('show');
      }
      if (recordingsDrawer && !recordingsDrawer.contains(e.target) && (!recordingsBtn || !recordingsBtn.contains(e.target))) {
        recordingsDrawer.classList.remove('show');
      }
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || !vibBtn.contains(e.target))) {
        vibPanel.classList.remove('show');
      }
    });

    // Recording controls
    if (typeof recBtn !== 'undefined' && recBtn) {
      recBtn.addEventListener('click', () => {
        if (this.isRecording) {
          this.stopRecording();
          recBtn.classList.remove('recording');
          recBtn.querySelector('.rec-label').textContent = 'Rec';
        } else {
          this.startRecording();
          recBtn.classList.add('recording');
          recBtn.querySelector('.rec-label').textContent = 'Stop';
        }
      });
    }


    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !this.isRunning) return;
      try {
        if (navigator.permissions?.query) {
          const mic = await navigator.permissions.query({ name: 'microphone' });
          if (mic.state === 'denied') {
            showError('🎙 Microphone permission changed to denied. Re-enable browser mic permission, then click Recover Mic.');
            setRecoverMicVisible(true);
          }
        }
      } catch (e) {
        // non-blocking permissions probe
      }
    });

    recordingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      recordingsDrawer.classList.toggle('show');
      helpTooltip.classList.remove('show');
      vibPanel.classList.remove('show');
    });

    clearAllRecs.addEventListener('click', () => {
      if (this.recordings.length === 0) return;
      this.clearAllRecordings();
    });

    this.canvas.addEventListener('pointerdown', (e) => this._handleKeyboardPointer(e));
    this.canvas.addEventListener('pointermove', (e) => this._handleKeyboardPointer(e));
    this.canvas.addEventListener('pointerup', (e) => this._stopPointerNote(e.pointerId));
    this.canvas.addEventListener('pointercancel', (e) => this._stopPointerNote(e.pointerId));
    this.canvas.addEventListener('contextmenu', (e) => {
      if (this.gameMode === 'keyboard' || (this.gameMode === 'canvas' && this.canvasMode === 'keyboard')) {
        e.preventDefault();
      }
    });

  }

  // FIX: Idle scene animation behind the overlay
  drawIdleScene() {
    const idleScroll = { x: this.scrollX || 0 };
    let idleTime = 0;
    const animate = () => {
      if (this.isRunning) return;
      idleTime += 0.016;
      if (this.gameMode === 'creature') {
        // Idle creature — dispatch to style-specific idle
        const dt = 0.016;
        switch (this.creatureStyle) {
          case 'blob': {
            const c = this.creature;
            c.breath += dt * 1.2; c.morphTime += dt * 0.5;
            c.glow = 0.15 + 0.05 * Math.sin(idleTime * 0.8);
            c.wingSpread *= 0.98; c.transformLevel *= 0.98; c.tendrilGrow *= 0.97; c.floatY *= 0.95;
            for (const t of c.tendrils) { t.length *= 0.97; t.targetLength = 0; }
            for (const p of c.points) {
              p.r += ((p.baseR * (1 + 0.06 * Math.sin(c.breath)) + 3 * Math.sin(c.morphTime * p.wobbleSpeed + p.wobblePhase)) - p.r) * 0.1;
            }
            for (let i = c.pulseRings.length - 1; i >= 0; i--) { c.pulseRings[i].life -= dt * 0.8; c.pulseRings[i].r += dt * 40; if (c.pulseRings[i].life <= 0) c.pulseRings.splice(i, 1); }
            for (let i = c.auraParticles.length - 1; i >= 0; i--) { c.auraParticles[i].life -= dt * 0.5; if (c.auraParticles[i].life <= 0) c.auraParticles.splice(i, 1); }
            break;
          }
          case 'jellyfish': {
            const j = this._jelly;
            j.breath += dt * 1.2; j.glow = 0.15 + 0.05 * Math.sin(idleTime * 0.8);
            j.transformLevel *= 0.98; j.biolumFlash *= 0.96; j.floatY *= 0.95;
            for (const t of j.tentacles) { t.length *= 0.97; }
            for (let i = j.particles.length - 1; i >= 0; i--) { j.particles[i].life -= dt * 0.5; if (j.particles[i].life <= 0) j.particles.splice(i, 1); }
            break;
          }
          case 'phoenix': {
            const p = this._phoenix;
            p.breath += dt * 1.5; p.flameIntensity *= 0.97; p.transformLevel *= 0.98; p.floatY *= 0.95;
            for (let i = p.flames.length - 1; i >= 0; i--) { p.flames[i].life -= dt; if (p.flames[i].life <= 0) p.flames.splice(i, 1); }
            for (let i = p.sparks.length - 1; i >= 0; i--) { p.sparks[i].life -= dt; if (p.sparks[i].life <= 0) p.sparks.splice(i, 1); }
            for (let i = p.embers.length - 1; i >= 0; i--) { p.embers[i].life -= dt * 0.5; if (p.embers[i].life <= 0) p.embers.splice(i, 1); }
            break;
          }
          case 'nebula': {
            const n = this._nebula; n.breath += dt * 0.6; n.coreGlow *= 0.98; n.transformLevel *= 0.98;
            n.spiralAngle += dt * 0.1; n.ringAlpha *= 0.97;
            for (const d of n.dustMotes) d.angle += d.speed * dt;
            for (let i = n.flares.length - 1; i >= 0; i--) { n.flares[i].life -= dt; if (n.flares[i].life <= 0) n.flares.splice(i, 1); }
            break;
          }
          case 'spirit': {
            const sp = this._spirit; sp.breath += dt; sp.glow = 0.15 + 0.05 * Math.sin(idleTime * 0.7);
            sp.transformLevel *= 0.98; sp.floatY *= 0.95;
            for (const r of sp.ribbons) { r.length *= 0.97; r.phase += dt * r.freq; }
            for (const b of sp.bokeh) { b.phase += dt * b.speed; b.x += Math.sin(b.phase) * b.speed * dt * 3; b.y += Math.cos(b.phase * 0.7) * b.speed * dt * 2; }
            for (let i = sp.lights.length - 1; i >= 0; i--) { sp.lights[i].life -= dt; if (sp.lights[i].life <= 0) sp.lights.splice(i, 1); }
            break;
          }
          case 'koi': {
            const k = this._koi; k.breath += dt; k.swimPhase += dt * 1.5;
            k.transformLevel *= 0.98; k.floatY *= 0.95; k.finExt *= 0.97; k.whiskerLen *= 0.97;
            for (let i = k.ripples.length - 1; i >= 0; i--) { k.ripples[i].life -= dt * 1.2; if (k.ripples[i].life <= 0) k.ripples.splice(i, 1); }
            break;
          }
        }
        this.drawCreatureScene(0);
      } else if (this.gameMode === 'garden') {
        // Idle garden: gentle sway, slow growth, ambient fireflies
        this.garden.time += 0.016;
        // Smooth camera in idle
        const rEdge = Math.max(this.garden.cursor, this.width * 0.5);
        const tCam = Math.max(0, rEdge - this.width * 0.65);
        this.garden.smoothCamX += (tCam - this.garden.smoothCamX) * 0.05;
        for (const p of this.garden.plants) {
          p.age += 0.016;
          p.growth = Math.min(1, p.growth + 0.0004);
          p.bloom = Math.min(1, p.bloom + 0.0002);
        }
        // Ambient fireflies in idle
        const idleMaxFireflies = this.reducedMotion ? 4 : 12;
        if (this.garden.fireflies.length < idleMaxFireflies && this.garden.plants.length > 2 && Math.random() < 0.02) {
          const fX = this.garden.smoothCamX + Math.random() * this.width;
          this.garden.fireflies.push({
            x: fX, y: this.garden.groundY - 30 - Math.random() * 100,
            baseX: fX, baseY: this.garden.groundY - 30 - Math.random() * 100,
            phase: Math.random() * Math.PI * 2, speed: 0.5 + Math.random(),
            size: 1 + Math.random() * 1.5, life: 1, maxLife: 8 + Math.random() * 6,
            hue: 50 + Math.random() * 80,
          });
        }
        for (let i = this.garden.fireflies.length - 1; i >= 0; i--) {
          const f = this.garden.fireflies[i];
          f.phase += 0.016 * f.speed;
          f.x = f.baseX + Math.sin(f.phase) * 25 + Math.cos(f.phase * 0.7) * 15;
          f.y = f.baseY + Math.cos(f.phase * 1.3) * 12;
          f.life -= 0.016 / f.maxLife;
          if (f.life <= 0) this.garden.fireflies.splice(i, 1);
        }
        this.drawGardenScene(0);
      } else if (this.gameMode === 'canvas') {
        // Idle canvas: animated demo brushstrokes
        this.updateCanvasModeTransition(0.016);
        this.voiceCanvas.time += 0.016;
        this.drawVoiceCanvasScene(0);
      } else if (this.gameMode === 'keyboard') {
        // Idle keyboard: start from fully keyboard view
        this.canvasMode = 'keyboard';
        this.updateCanvasModeTransition(0.016);
        this.voiceCanvas.time += 0.016;
        this.drawVoiceCanvasScene(0);
      } else if (this.gameMode === 'pilot') {
        this.updatePitchPilot(0.016);
        this.drawPitchPilotScene();
      } else if (this.gameMode === 'road') {
        this.updateResonanceRoad(0.016);
        this.drawResonanceRoadScene();
      } else if (this.gameMode === 'ascent') {
        this.updateSpectralAscent(0.016);
        this.drawSpectralAscentScene();
      } else if (this.gameMode === 'prism') {
        this.drawPrismReaderScene();
      } else {
        idleScroll.x += 0.5;
        this.scrollX = idleScroll.x;
        this.ball.x = this.width * 0.45;
        const ground = this.getGroundHeight(this.scrollX + this.ball.x);
        this.ball.y = ground - this.ball.radius;
        this.ball.rotation += 0.01;
        this.ballHue = 275;
        this.ballSat = 70;
        this.ballLit = 55;
        this.cameraY = 0;
        this.targetCameraY = 0;
        this.cameraZoom = 1.4;
        this.targetZoom = 1.4;
        this.drawSceneInternal(0);
      }
      this.idleAnimId = requestAnimationFrame(animate);
    };
    animate();
  }

  loop() {
    if (!this.isRunning) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.analyzer.update(dt);
    this.perfMonitor.sample(dt);

    const targetQualityScale = this.perfMonitor.fps > 0 && this.perfMonitor.fps < 30 ? 0.55 : this.perfMonitor.fps > 0 && this.perfMonitor.fps < 42 ? 0.75 : 1;
    this.dynamicQualityScale += (targetQualityScale - this.dynamicQualityScale) * 0.08;
    this.particleScale = this.baseParticleScale * this.dynamicQualityScale;

    if (this.gameMode === 'creature') {
      this.updateCreature(dt);
      this.drawCreatureScene(this.prosodyScore);
    } else if (this.gameMode === 'garden') {
      this.updateGarden(dt);
      this.drawGardenScene(this.prosodyScore);
    } else if (this.gameMode === 'canvas') {
      this.updateCanvasModeTransition(dt);
      this.updateVoiceCanvas(dt);
      this.drawVoiceCanvasScene(this.prosodyScore);
    } else if (this.gameMode === 'keyboard') {
      this.canvasMode = 'keyboard';
      this.updateCanvasModeTransition(dt);
      this.updateVoiceCanvas(dt);
      this.drawVoiceCanvasScene(this.prosodyScore);
    } else if (this.gameMode === 'pilot') {
      this.updatePitchPilot(dt);
      this.drawPitchPilotScene();
    } else if (this.gameMode === 'road') {
      this.updateResonanceRoad(dt);
      this.drawResonanceRoadScene();
    } else if (this.gameMode === 'ascent') {
      this.updateSpectralAscent(dt);
      this.drawSpectralAscentScene();
    } else if (this.gameMode === 'prism') {
      this.updatePrismReader(dt);
      this.drawPrismReaderScene();
    } else if (this.gameMode === 'vowelvalley') {
      this.updateVowelValley(dt);
      this.drawVowelValleyScene(this.prosodyScore);
    } else {
      this.update(dt);
      this.drawSceneInternal(this.prosodyScore);
    }
    this.updateMeters();
    this._updateExpandedMetrics();
    this.renderTeleprompter(dt);
    this.checkVibrationAlerts(dt);
    this.perfMonitor.render(`Particles: ${this.particles.length} · Trail: ${this.trailPoints.length}`);

    // ---- Session stats accumulation ----
    const sess = this.session;
    sess.duration = (Date.now() - sess.startTime) / 1000;

    // Update HUD timer
    const mins = Math.floor(sess.duration / 60);
    const secs = Math.floor(sess.duration % 60);
    const timerEl = document.getElementById('sessionTimer');
    if (timerEl) timerEl.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;

    // Sample pitch and resonance when speaking
    const sessM = this.analyzer.metrics;
    const sessHz = this.analyzer.smoothPitchHz;
    if (sessM.energy > 0.05 && this.analyzer.lastPitch > 0) {
      sess.pitchSum += sessHz;
      sess.pitchCount++;
      if (sessHz < sess.pitchMin) sess.pitchMin = sessHz;
      if (sessHz > sess.pitchMax) sess.pitchMax = sessHz;
      sess.resonanceSum += this.analyzer.smoothResonance;
      sess.resonanceCount++;
    }

    // Sample prosody score every 0.5s for sparkline
    sess.prosodySampleTimer += dt;
    if (sess.prosodySampleTimer >= 0.5) {
      sess.prosodySampleTimer = 0;
      sess.prosodyHistory.push(this.prosodyScore);
      // Cap at 240 samples (2 minutes)
      if (sess.prosodyHistory.length > 240) sess.prosodyHistory.shift();
    }

    // Show calibration notice during noise floor measurement
    if (!this.analyzer.isCalibrated && this.analyzer.isActive) {
      const ctx = this.ctx;
      const progress = Math.min(1, this.analyzer.noiseCalibrationTimer / this.analyzer.noiseCalibrationDuration);
      ctx.save();
      ctx.fillStyle = 'rgba(10,10,18,0.6)';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.fillStyle = '#e8e6f0';
      ctx.font = '600 16px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🎙 Calibrating to room noise...', this.width / 2, this.height / 2 - 12);
      ctx.font = '400 13px "Outfit", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('Stay quiet for a moment', this.width / 2, this.height / 2 + 14);
      // Progress bar
      const barW = 160, barH = 4;
      const barX = (this.width - barW) / 2;
      const barY = this.height / 2 + 34;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = this.colorblindMode ? '#56B4E9' : '#4d96ff';
      ctx.fillRect(barX, barY, barW * progress, barH);
      ctx.restore();
    }

    // Guided onboarding overlay for first 30 seconds
    const guidedElapsed = (performance.now() - this.guidedStartTs) / 1000;
    if (this.isRunning && this.guidedStartTs > 0 && !this.guidedDismissed && guidedElapsed < this.guidedDurationSec) {
      const hasVoice = this.analyzer.metrics.energy > 0.05 || this.analyzer.lastPitch > 0;
      this.guidedChecklist.voiceDetected = this.guidedChecklist.voiceDetected || hasVoice;
      if (this.analyzer.pitchConfidence > 0.65 && this.analyzer.lastPitch > 0) {
        this.guidedPitchStable += dt;
      } else {
        this.guidedPitchStable = Math.max(0, this.guidedPitchStable - dt * 0.5);
      }
      if (this.guidedPitchStable > 0.8) this.guidedChecklist.pitchLocked = true;
      this.guidedChecklist.roomReady = this.guidedChecklist.roomReady || this.analyzer.isCalibrated;

      const ctx = this.ctx;
      const x = 16;
      const y = 68;
      const w = Math.min(360, this.width - 32);
      const h = 120;
      const left = Math.max(8, Math.min(x, this.width - w - 8));
      ctx.save();
      ctx.fillStyle = 'rgba(9, 12, 22, 0.72)';
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(left, y, w, h, 10);
      ctx.fill();
      ctx.stroke();

      const closeSize = 18;
      const closeX = left + w - closeSize - 8;
      const closeY = y + 8;
      this.guidedCloseHitbox = { x: closeX, y: closeY, w: closeSize, h: closeSize };

      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.roundRect(closeX, closeY, closeSize, closeSize, 6);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '600 12px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✕', closeX + closeSize * 0.5, closeY + 13);

      const secsLeft = Math.max(0, Math.ceil(this.guidedDurationSec - guidedElapsed));
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e8e6f0';
      ctx.font = '600 14px "Outfit", sans-serif';
      ctx.fillText(`Quick setup guide · ${secsLeft}s`, left + 12, y + 22);
      ctx.font = '500 12px "Outfit", sans-serif';
      const rows = [
        ['Room calibrated', this.guidedChecklist.roomReady],
        ['Voice detected', this.guidedChecklist.voiceDetected],
        ['Pitch lock stable', this.guidedChecklist.pitchLocked],
      ];
      rows.forEach((row, i) => {
        ctx.fillStyle = row[1] ? '#6bcb77' : 'rgba(255,255,255,0.55)';
        ctx.fillText(`${row[1] ? '✅' : '⬜'} ${row[0]}`, left + 14, y + 48 + i * 22);
      });
      if (this.guidedChecklist.roomReady && this.guidedChecklist.voiceDetected && this.guidedChecklist.pitchLocked) {
        ctx.fillStyle = this.colorblindMode ? '#56B4E9' : '#4d96ff';
        ctx.fillText('Great! You are fully tracked.', left + 14, y + 112);
      }
      ctx.restore();
    } else {
      this.guidedCloseHitbox = null;
    }

    // Vibration alert flash overlay
    if (this.vibration.flashAlpha > 0.01) {
      const vib = this.vibration;
      const fa = vib.flashAlpha;
      const ctx = this.ctx;
      ctx.save();

      // Edge flash — orange border glow
      const edgeW = 4 + fa * 4;
      const grad = ctx.createLinearGradient(0, 0, edgeW * 3, 0);
      grad.addColorStop(0, `rgba(255,140,40,${fa * 0.4})`);
      grad.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, edgeW * 3, this.height); // left edge
      const grad2 = ctx.createLinearGradient(this.width, 0, this.width - edgeW * 3, 0);
      grad2.addColorStop(0, `rgba(255,140,40,${fa * 0.4})`);
      grad2.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = grad2;
      ctx.fillRect(this.width - edgeW * 3, 0, edgeW * 3, this.height); // right edge

      // Metric label badge at top center
      if (vib.flashMetric && fa > 0.3) {
        const badgeAlpha = Math.min(1, (fa - 0.3) * 2);
        ctx.font = '600 12px "Outfit", sans-serif';
        ctx.textAlign = 'center';
        const text = `⚠ ${vib.flashMetric}`;
        const tw = ctx.measureText(text).width;
        const bx = this.width / 2 - tw / 2 - 10;
        const by = 32;
        const bw = tw + 20;
        const bh = 22;
        const br = 6;
        ctx.fillStyle = `rgba(50,30,10,${badgeAlpha * 0.7})`;
        ctx.beginPath();
        ctx.moveTo(bx + br, by);
        ctx.lineTo(bx + bw - br, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + br, br);
        ctx.lineTo(bx + bw, by + bh - br);
        ctx.arcTo(bx + bw, by + bh, bx + bw - br, by + bh, br);
        ctx.lineTo(bx + br, by + bh);
        ctx.arcTo(bx, by + bh, bx, by + bh - br, br);
        ctx.lineTo(bx, by + br);
        ctx.arcTo(bx, by, bx + br, by, br);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(255,160,60,${badgeAlpha})`;
        ctx.fillText(text, this.width / 2, by + 15);
      }

      ctx.restore();
    }

    requestAnimationFrame(() => this.loop());
  }

  update(dt) {
    const m = this.analyzer.metrics;
    const gravity = 800;

    // ==========================================================
    // PROSODY SCORE — the core pedagogical signal
    // Monotone speech ≈ 0. Expressive prosody → 1.
    // Weighted toward variation metrics, NOT raw energy/volume.
    // ==========================================================
    this.prosodyScore = computeProsodyScore(this.prosodyScore, m, 0.12);
    const ps = this.prosodyScore;

    // ==========================================================
    // SCROLL SPEED — prosody + tempo drives movement
    // Monotone: sluggish crawl (20 px/s). High tempo: >300 px/s.
    // ==========================================================
    this.targetScrollSpeed = 20 + ps * 100 + m.tempo * 300;
    this.scrollSpeed += (this.targetScrollSpeed - this.scrollSpeed) * 0.06;
    this.scrollX += this.scrollSpeed * dt;

    this.ball.x = this.width * 0.45;
    const localGround = this.getGroundHeight(this.scrollX + this.ball.x);

    // ==========================================================
    // SYLLABLE BOUNCE — gated by prosody
    // Monotone syllables = tiny nudge. Prosodic = BIG bounce.
    // At ps=0.4 → ~120px height. At ps=0.8 → ~400px height.
    // ==========================================================
    if (m.syllable > 0.5) {
      const bouncePower = 120 + ps * 1800;
      if (this.ball.vy > -bouncePower * 0.5) {
        this.ball.vy = -bouncePower * m.syllable;
        this.ball.onGround = false;
        this.ball.squash = 0.7 - ps * 0.15;
        if (ps > 0.15) {
          const pY = Math.min(this.ball.y + this.ball.radius, localGround);
          const n = Math.floor((2 + ps * 6) * this.particleScale);
          for (let i = 0; i < n; i++) {
            const angle = Math.PI + Math.random() * Math.PI;
            const pr = this.colorblindMode ? 240 : 255;
            const pg = this.colorblindMode ? 200 + Math.floor(Math.random() * 55) : 120 + Math.floor(Math.random() * 100);
            const pb = this.colorblindMode ? 60 : 100;
            this.particles.push(new Particle(
              this.ball.x, pY,
              pr, pg, pb,
              Math.cos(angle) * (30 + ps * 60 + Math.random() * 50),
              Math.sin(angle) * (30 + ps * 70 + Math.random() * 60),
              0.4 + ps * 0.4,
              1.5 + ps * 3
            ));
          }
        }
      }
    }

    // ==========================================================
    // CONTINUOUS PITCH LIFT — requires real pitch variation
    // Stronger force so expressive speech sustains altitude
    // ==========================================================
    if (m.bounce > 0.2) {
      this.ball.vy -= m.bounce * ps * 1200 * dt;
    }

    if (!this.ball.onGround) {
      this.ball.vy += gravity * dt;
    }

    this.ball.y += this.ball.vy * dt;

    // Ground collision
    const groundContact = localGround - this.ball.radius;
    if (this.ball.y >= groundContact) {
      this.ball.y = groundContact;
      if (Math.abs(this.ball.vy) > 30 && ps > 0.1) {
        this.ball.squash = 0.7;
        const gParts = Math.max(1, Math.floor(3 * this.particleScale));
        for (let i = 0; i < gParts; i++) {
          this.particles.push(new Particle(
            this.ball.x + (Math.random() - 0.5) * 20, localGround,
            200, 200, 220,
            (Math.random() - 0.5) * 50, -Math.random() * 40,
            0.3, 1.5
          ));
        }
      }
      this.ball.vy *= -0.3;
      if (Math.abs(this.ball.vy) < 15) {
        this.ball.vy = 0;
        this.ball.onGround = true;
      }
    } else {
      this.ball.onGround = false;
    }

    this.ball.rotation += (this.scrollSpeed / (this.ball.radius * 2)) * dt;
    this.ball.squash += (1 - this.ball.squash) * 5 * dt;

    // Camera Y tracking
    const upperLimit = this.height * 0.3;
    const ballScreenY = this.ball.y;
    if (ballScreenY < upperLimit) {
      this.targetCameraY = ballScreenY - upperLimit;
    } else {
      this.targetCameraY = 0;
    }
    const camSpeed = this.targetCameraY < this.cameraY ? 0.18 : 0.06;
    this.cameraY += (this.targetCameraY - this.cameraY) * camSpeed;
    this.cameraY = Math.min(0, this.cameraY);
    const ballScreenY2 = this.ball.y - this.cameraY;
    if (ballScreenY2 < this.ball.radius * 2) {
      this.cameraY = this.ball.y - this.ball.radius * 2;
    }

    // Dynamic zoom — zoom in when grounded, zoom out when high
    // Also zoom out slightly at high speed for dramatic effect
    const heightAboveGround = Math.max(0, localGround - this.ball.radius - this.ball.y);
    const heightRatio = Math.min(1, heightAboveGround / (this.height * 0.5));
    const speedFactor = Math.min(1, this.scrollSpeed / 300);
    this.targetZoom = 1.48 - heightRatio * 0.3 - speedFactor * 0.08; // 1.48 → 1.10
    this.cameraZoom += (this.targetZoom - this.cameraZoom) * 0.04;

    // ==========================================================
    // BALL SIZE — monotone: small (16). Prosodic: 22-40.
    // ==========================================================
    const prosodyRadius = 16 + ps * 10;
    const vowelBonus = m.vowel * 14;
    this.ball.targetRadius = prosodyRadius + vowelBonus;
    this.ball.radius += (this.ball.targetRadius - this.ball.radius) * 0.1;

    // ==========================================================
    // VOWEL TRAIL — only with real prosody
    // ==========================================================
    if (m.vowel > 0.2 && ps > 0.1) {
      this.trailPoints.push({
        wx: this.ball.x + this.scrollX,
        sy: this.ball.y + this.ball.radius,
        size: this.ball.radius * 0.5 * m.vowel * Math.min(1, ps * 3),
        life: 1.0,
        hue: this.ballHue
      });
    }

    for (let i = this.trailPoints.length - 1; i >= 0; i--) {
      this.trailPoints[i].life -= dt * 1.5;
      if (this.trailPoints[i].life <= 0) this.trailPoints.splice(i, 1);
    }
    if (this.trailPoints.length > 60) this.trailPoints.splice(0, this.trailPoints.length - 60);

    // ==========================================================
    // SPARKLES — gated by prosody
    // ==========================================================
    if (m.articulation > 0.3 && ps > 0.1) {
      const sparkleCount = Math.floor(m.articulation * ps * 6 * this.particleScale);
      for (let i = 0; i < sparkleCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = this.ball.radius + Math.random() * 20;
        this.sparkles.push({
          x: this.ball.x + Math.cos(angle) * dist,
          y: this.ball.y + this.ball.radius * 0.5 + Math.sin(angle) * dist,
          life: 0.4 + Math.random() * 0.3,
          maxLife: 0.5,
          size: 1 + ps * 3
        });
      }
    }

    for (let i = this.sparkles.length - 1; i >= 0; i--) {
      this.sparkles[i].life -= dt;
      if (this.sparkles[i].life <= 0) this.sparkles.splice(i, 1);
    }
    if (this.sparkles.length > 100) this.sparkles.splice(0, this.sparkles.length - 100);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      this.particles[i].update(dt);
      if (this.particles[i].life <= 0) this.particles.splice(i, 1);
    }

    // ==========================================================
    // BALL COLOR — pitch drives hue (blue→purple→pink),
    // prosody drives saturation and brightness
    //
    // ≤100 Hz  → 210 (deep blue)
    // 145 Hz   → 250 (blue-purple)
    // 160 Hz   → 275 (true purple / androgynous center)
    // 175 Hz   → 310 (pink-purple)
    // ≥250 Hz  → 340 (hot pink)
    // ==========================================================
    const hz = this.analyzer.smoothPitchHz;
    let pitchHue;
    if (this.colorblindMode) {
      // Colorblind: blue(220)→cyan(190)→yellow(55) — luminance-mapped
      // Works for protanopia, deuteranopia, tritanopia, and grayscale
      if (hz <= 100) {
        pitchHue = 220;
      } else if (hz <= 160) {
        pitchHue = 220 - ((hz - 100) / 60) * 30;  // 220 → 190
      } else if (hz <= 220) {
        pitchHue = 190 - ((hz - 160) / 60) * 135; // 190 → 55
      } else {
        pitchHue = 55;
      }
    } else {
      if (hz <= 100) {
        pitchHue = 210;
      } else if (hz <= 145) {
        pitchHue = 210 + ((hz - 100) / 45) * 40;  // 210 → 250
      } else if (hz <= 175) {
        pitchHue = 250 + ((hz - 145) / 30) * 60;  // 250 → 310
      } else if (hz <= 250) {
        pitchHue = 310 + ((hz - 175) / 75) * 30;  // 310 → 340
      } else {
        pitchHue = 340;
      }
    }
    this.ballHue = pitchHue;
    this.ballSat = 25 + ps * 75;   // 25% (muted) → 100% (vivid)
    this.ballLit = this.colorblindMode
      ? (40 + ps * 30) + (pitchHue < 100 ? 10 : 0) // extra luminance boost at yellow end
      : 40 + ps * 30;
  }

  drawSceneInternal(prosodyGlow) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (!w || !h) return;

    // Background — theme-aware
    const themePresets = {
      highcontrast: ['#030305', '#080814', '#0c0c1f', '#12122a']
    };
    const colors = themePresets[this.themeMode] || themePresets.highcontrast;
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, colors[0]);
    bgGrad.addColorStop(0.4, colors[1]);
    bgGrad.addColorStop(0.7, colors[2]);
    bgGrad.addColorStop(1, colors[3]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Stars
    const time = performance.now() / 1000;
    for (const star of this.stars) {
      const sx = ((star.x - this.scrollX * 0.05) % (w + 100) + w + 100) % (w + 100);
      const twinkle = 0.4 + 0.6 * Math.sin(time * 2.2 + star.twinkle + prosodyGlow * 2);
      ctx.globalAlpha = twinkle * 0.6;
      ctx.fillStyle = '#e8e6f0';
      ctx.beginPath();
      ctx.arc(sx, star.y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Mountain ranges — parallax layers for speed perception
    if (this.mountainLayers) {
      for (const mtn of this.mountainLayers) {
        const baseY = h * mtn.baseY;
        const scrollOffset = this.scrollX * mtn.parallax;
        ctx.beginPath();
        ctx.moveTo(-20, h);
        for (let x = -20; x <= w + 20; x += 3) {
          const worldX = x + scrollOffset;
          let my = 0;
          for (const l of mtn.layers) {
            my += l.amp * Math.sin(worldX * l.freq + l.phase);
          }
          ctx.lineTo(x, baseY - Math.abs(my));
        }
        ctx.lineTo(w + 20, h);
        ctx.closePath();
        ctx.fillStyle = mtn.color;
        ctx.fill();
        // Subtle top edge highlight
        ctx.beginPath();
        for (let x = -20; x <= w + 20; x += 3) {
          const worldX = x + scrollOffset;
          let my = 0;
          for (const l of mtn.layers) {
            my += l.amp * Math.sin(worldX * l.freq + l.phase);
          }
          const gy = baseY - Math.abs(my);
          if (x === -20) ctx.moveTo(x, gy); else ctx.lineTo(x, gy);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // === Camera transform — zoom + vertical follow ===
    ctx.save();
    const zoomPivotX = this.ball.x;
    const zoomPivotY = this.groundY;
    ctx.translate(zoomPivotX, zoomPivotY);
    ctx.scale(this.cameraZoom, this.cameraZoom);
    ctx.translate(-zoomPivotX, -zoomPivotY);
    ctx.translate(0, -this.cameraY);

    // Ground fill — extend bottom well past viewport for camera shifts + zoom
    const groundFillBottom = h / this.cameraZoom + Math.abs(this.cameraY) + 200;
    // Ground fill with extended range for zoom
    const margin = w * 0.3; // extra margin for zoom edges
    ctx.beginPath();
    ctx.moveTo(-margin, groundFillBottom);
    for (let x = -margin; x <= w + margin; x += 4) {
      ctx.lineTo(x, this.getGroundHeight(this.scrollX + x));
    }
    ctx.lineTo(w + margin, groundFillBottom);
    ctx.closePath();
    const groundGrad = ctx.createLinearGradient(0, this.groundY - 40, 0, groundFillBottom);
    const gc = this._groundColors || ['#1e1e3a', '#191932', '#121228'];
    groundGrad.addColorStop(0, gc[0]);
    groundGrad.addColorStop(0.2, gc[1]);
    groundGrad.addColorStop(1, gc[2]);
    ctx.fillStyle = groundGrad;
    ctx.fill();

    // Ground line — brighter for visibility
    ctx.beginPath();
    for (let x = -margin; x <= w + margin; x += 4) {
      const gy = this.getGroundHeight(this.scrollX + x);
      if (x === -margin) ctx.moveTo(x, gy); else ctx.lineTo(x, gy);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Trail
    for (const tp of this.trailPoints) {
      const screenX = tp.wx - this.scrollX;
      if (screenX < -50 || screenX > w + 50) continue;
      ctx.globalAlpha = tp.life * 0.4;
      ctx.fillStyle = `hsl(${tp.hue}, 80%, 60%)`;
      ctx.beginPath();
      ctx.arc(screenX, tp.sy, tp.size * tp.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Speed lines — horizontal streaks when moving fast
    if (this.scrollSpeed > 150) {
      const speedIntensity = Math.min(1, (this.scrollSpeed - 150) / 200); // 0→1 from 150→350 px/s
      const lineCount = Math.floor(3 + speedIntensity * 8);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.04 + speedIntensity * 0.12})`;
      ctx.lineWidth = 1 + speedIntensity;
      for (let i = 0; i < lineCount; i++) {
        // Distribute lines around the ball with some randomness
        const seed = (i * 7919 + Math.floor(this.scrollX * 0.1)) % 1000 / 1000; // deterministic per frame
        const yOffset = (seed - 0.5) * this.height * 0.6;
        const lineY = this.ball.y + yOffset;
        const lineLen = 30 + speedIntensity * 80 + seed * 40;
        const lineX = this.ball.x - this.ball.radius * 2 - 20 - seed * 60;
        ctx.globalAlpha = (0.08 + speedIntensity * 0.2) * (1 - Math.abs(yOffset) / (this.height * 0.35));
        if (ctx.globalAlpha > 0.02) {
          ctx.beginPath();
          ctx.moveTo(lineX, lineY);
          ctx.lineTo(lineX - lineLen, lineY);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Particles
    for (const p of this.particles) p.draw(ctx);

    // Shadow
    const groundAtBall = this.getGroundHeight(this.scrollX + this.ball.x);
    const shadowDist = groundAtBall - (this.ball.y + this.ball.radius);
    const shadowAlpha = Math.max(0, 0.3 - shadowDist * 0.002);
    const shadowScale = Math.max(0.3, 1 - shadowDist * 0.003);
    if (shadowAlpha > 0.01) {
      ctx.globalAlpha = shadowAlpha;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(this.ball.x, groundAtBall, this.ball.radius * shadowScale * 1.2, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Ball
    ctx.save();
    ctx.translate(this.ball.x, this.ball.y + this.ball.radius * (1 - this.ball.squash) * 0.5);
    ctx.scale(1 + (1 - this.ball.squash) * 0.3, this.ball.squash);

    // Ball glow — boosted for visibility against dark scene
    const glowSize = this.ball.radius * (2.2 + prosodyGlow * 1.5);
    const glowGrad = ctx.createRadialGradient(0, 0, this.ball.radius * 0.2, 0, 0, glowSize);
    glowGrad.addColorStop(0, this.getBallColor(0.35));
    glowGrad.addColorStop(0.4, this.getBallColor(0.12));
    glowGrad.addColorStop(0.7, this.getBallColor(0.04));
    glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(0, 0, glowSize, 0, Math.PI * 2);
    ctx.fill();

    // Ball body — bright with rim light
    const ballGrad = ctx.createRadialGradient(
      -this.ball.radius * 0.25, -this.ball.radius * 0.25, 0,
      0, 0, this.ball.radius
    );
    ballGrad.addColorStop(0, '#fff');
    ballGrad.addColorStop(0.12, this.getBallColor());
    ballGrad.addColorStop(0.85, this.getBallColor());
    ballGrad.addColorStop(1, '#222');
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius, 0, Math.PI * 2);
    ctx.fill();

    // Rim light — subtle bright edge
    ctx.strokeStyle = this.getBallColor(0.4);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius - 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // Resonance ring — shows vocal tract resonance (F1/F2/F3)
    // Inner ring: F2-based (primary), Outer ring: F3-based (secondary)
    // Cool blue-violet = low/dark resonance → warm gold = high/bright resonance
    const res = this.analyzer.smoothResonance;
    const resConf = this.analyzer.formantConfidence;
    const resAlpha = (0.10 + res * 0.35 + prosodyGlow * 0.1) * (0.3 + resConf * 0.7);
    if (resAlpha > 0.04) {
      // F2 ring (primary): colorblind = blue(220)→yellow(55), normal = blue(240)→gold(45)
      let resHue, resSat, resLit;
      if (this.colorblindMode) {
        resHue = 220 - res * 165; // 220 (blue) → 55 (yellow)
        resSat = 70 + res * 30;
        resLit = 45 + res * 35;   // darker blue → brighter yellow (luminance-mapped)
      } else {
        resHue = 240 - res * 195;
        resSat = 60 + res * 40;
        resLit = 50 + res * 30;
      }
      const ringRadius = this.ball.radius + 4 + res * 6 + prosodyGlow * 3;
      ctx.strokeStyle = `hsla(${resHue}, ${resSat}%, ${resLit}%, ${resAlpha})`;
      ctx.lineWidth = 1.5 + res * 2;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      // F2 glow
      const ringGlow = ctx.createRadialGradient(0, 0, ringRadius - 2, 0, 0, ringRadius + 8 + res * 6);
      ringGlow.addColorStop(0, `hsla(${resHue}, ${resSat}%, ${resLit}%, ${resAlpha * 0.4})`);
      ringGlow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ringGlow;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius + 8 + res * 6, 0, Math.PI * 2);
      ctx.fill();

      // F3 outer ring — appears when F3 is high (> 2500 Hz) and confident
      // Separate visual from F2 ring: thinner, more cyan/white toned
      const f3Norm = Math.max(0, Math.min(1, (this.analyzer.smoothF3 - 2200) / 1200));
      const f3Alpha = f3Norm * resConf * 0.45;
      if (f3Alpha > 0.03) {
        const f3Radius = ringRadius + 6 + res * 6 + f3Norm * 4;
        const f3Hue = 200 - f3Norm * 30; // cyan → bright blue-white
        ctx.strokeStyle = `hsla(${f3Hue}, ${40 + f3Norm * 30}%, ${65 + f3Norm * 25}%, ${f3Alpha})`;
        ctx.lineWidth = 0.8 + f3Norm * 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, f3Radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Rotation stripe
    ctx.save();
    ctx.rotate(this.ball.rotation);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius * 0.7, -0.5, 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius * 0.7, Math.PI - 0.5, Math.PI + 0.5);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // Sparkles
    for (const s of this.sparkles) {
      const alpha = s.life / s.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff';
      const cx = s.x, cy = s.y, sz = s.size * alpha;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const r = i % 2 === 0 ? sz : sz * 0.3;
        ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // === End camera transform ===
    ctx.restore();

    // Distance (HUD — screen-fixed)
    const dist = Math.floor(this.scrollX / 50);
    ctx.font = '600 14px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.textAlign = 'right';
    ctx.fillText(`${dist}m`, w - 16, 28);
  }

  // ============================================================
  // VOICE CREATURE — Update (Dispatcher)
  // ============================================================
  updateCreature(dt) {
    const m = this.analyzer.metrics;
    const bounceW = 0.30, tempoW = 0.20, vowelW = 0.20, articW = 0.15, sylW = 0.15;
    const rawPS = m.bounce * bounceW + m.tempo * tempoW + m.vowel * vowelW +
      m.articulation * articW + m.syllable * sylW;
    this.prosodyScore += (rawPS - this.prosodyScore) * 2.0 * dt;
    const ps = this.prosodyScore;

    const hz = this.analyzer.smoothPitchHz;
    if (this.colorblindMode) {
      if (hz <= 100) this.ballHue = 220;
      else if (hz <= 160) this.ballHue = 220 - ((hz - 100) / 60) * 30;
      else if (hz <= 220) this.ballHue = 190 - ((hz - 160) / 60) * 135;
      else this.ballHue = 55;
    } else {
      if (hz <= 100) this.ballHue = 210;
      else if (hz <= 145) this.ballHue = 210 + ((hz - 100) / 45) * 40;
      else if (hz <= 175) this.ballHue = 250 + ((hz - 145) / 30) * 60;
      else if (hz <= 250) this.ballHue = 310 + ((hz - 175) / 75) * 30;
      else this.ballHue = 340;
    }
    this.ballSat = 25 + ps * 75;
    this.ballLit = 40 + ps * 30;

    const pitchNorm = this.analyzer.lastPitch > 0
      ? Math.max(0, Math.min(1, (this.analyzer.lastPitch - 80) / 250)) : 0;
    const S = {
      ps, m, hz, dt, pitchNorm,
      pitchConf: this.analyzer.pitchConfidence,
      res: this.analyzer.smoothResonance,
      hue: this.ballHue, sat: this.ballSat, lit: this.ballLit,
      time: performance.now() / 1000,
    };

    switch (this.creatureStyle) {
      case 'jellyfish': this._updateJellyfish(S); break;
      case 'phoenix': this._updatePhoenix(S); break;
      case 'nebula': this._updateNebula(S); break;
      case 'spirit': this._updateSpirit(S); break;
      case 'koi': this._updateKoi(S); break;
      default: this._updateBlob(S); break;
    }
  }

  // ---------- BLOB update (original) ----------
  _updateBlob(S) {
    const { ps, m, dt, pitchNorm, res, time } = S;
    const c = this.creature;
    c.breath += dt * (1.0 + ps * 0.5);
    c.morphTime += dt * (0.4 + ps * 0.3);
    const aspect = 0.7 + (res || 0.5) * 0.6;
    const baseSize = 50 + m.energy * 40 + ps * 20;
    for (const p of c.points) {
      const vertFactor = Math.abs(Math.cos(p.angle));
      const horizFactor = Math.abs(Math.sin(p.angle));
      const shapedR = baseSize * (vertFactor * aspect + horizFactor * (2 - aspect));
      const breathScale = 1 + 0.08 * Math.sin(c.breath) * (0.5 + m.energy);
      const wobble = (3 + ps * 8) * Math.sin(c.morphTime * p.wobbleSpeed + p.wobblePhase);
      const dance = m.bounce * 12 * Math.sin(c.morphTime * 3 + p.angle * 2);
      p.targetR = shapedR * breathScale + wobble + dance;
      p.r += (p.targetR - p.r) * (4 + ps * 4) * dt;
    }
    const targetFloat = -pitchNorm * 140 * (0.3 + (S.pitchConf || 0) * 0.7);
    c.floatY += (targetFloat - c.floatY) * 2.5 * dt;
    c.glow += ((0.15 + ps * 0.7 + m.energy * 0.3) - c.glow) * 3 * dt;
    if (ps > 0.45) { c.transformLevel += (ps - 0.45) * 0.8 * dt; }
    else { c.transformLevel -= 0.15 * dt; }
    c.transformLevel = Math.max(0, Math.min(1, c.transformLevel));
    c.wingSpread += (c.transformLevel * 1.5 - c.wingSpread) * 2 * dt;
    c.tendrilGrow += ((m.vowel * 1.2 + m.energy * 0.4) - c.tendrilGrow) * 3 * dt;
    for (const t of c.tendrils) {
      t.targetLength = c.tendrilGrow * (100 + ps * 120);
      t.length += (t.targetLength - t.length) * 3 * dt;
      t.phase += dt * (1.5 + ps);
    }
    if (m.syllable > 0.5 && ps > 0.1) {
      const bS = Math.max(...c.points.map(p => p.r)) * 0.8;
      c.pulseRings.push({ r: bS, maxR: bS * 3, life: 1 });
    }
    for (let i = c.pulseRings.length - 1; i >= 0; i--) {
      const ring = c.pulseRings[i];
      ring.r += (ring.maxR - ring.r) * 3 * dt; ring.life -= dt * 1.5;
      if (ring.life <= 0) c.pulseRings.splice(i, 1);
    }
    if (c.pulseRings.length > 8) c.pulseRings.splice(0, c.pulseRings.length - 8);
    const maxAura = this.reducedMotion ? 10 : 40;
    if (m.energy > 0.05 && c.auraParticles.length < maxAura) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 200 + Math.random() * 150;
      c.auraParticles.push({
        x: Math.cos(angle) * dist, y: Math.sin(angle) * dist,
        size: 1 + Math.random() * 2, speed: 30 + Math.random() * 50, life: 1, maxLife: 1.5 + Math.random()
      });
    }
    for (let i = c.auraParticles.length - 1; i >= 0; i--) {
      const ap = c.auraParticles[i];
      const dx = -ap.x, dy = -ap.y, dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
      ap.x += (dx / dist) * ap.speed * dt; ap.y += (dy / dist) * ap.speed * dt;
      ap.life -= dt / ap.maxLife;
      if (ap.life <= 0 || dist < 15) c.auraParticles.splice(i, 1);
    }
  }

  // ---------- JELLYFISH update ----------
  _updateJellyfish(S) {
    const { ps, m, dt, pitchNorm, res, pitchConf } = S;
    const j = this._jelly;
    j.breath += dt * (1.2 + ps * 0.6);
    j.pulsePhase += dt * (0.8 + ps * 0.4);
    // Float with pitch
    const targetFloat = -pitchNorm * 160 * (0.3 + (pitchConf || 0) * 0.7);
    j.floatY += (targetFloat - j.floatY) * 2.0 * dt;
    // Bell size — resonance shapes aspect, energy grows it
    j.bellW += ((65 + m.energy * 45 + ps * 25) * (1.3 - (res || 0.5) * 0.6) - j.bellW) * 3 * dt;
    j.bellH += ((55 + m.energy * 35 + ps * 20) * (0.7 + (res || 0.5) * 0.6) - j.bellH) * 3 * dt;
    // Glow & transform
    j.glow += ((0.15 + ps * 0.6 + m.energy * 0.3) - j.glow) * 3 * dt;
    j.biolumFlash = m.articulation > 0.4 ? Math.min(1, j.biolumFlash + dt * 8) : j.biolumFlash * (1 - dt * 4);
    if (ps > 0.4) j.transformLevel += (ps - 0.4) * 0.6 * dt;
    else j.transformLevel -= 0.1 * dt;
    j.transformLevel = Math.max(0, Math.min(1, j.transformLevel));
    // Tentacles — vowels extend them
    for (const t of j.tentacles) {
      t.targetLen = 45 + m.vowel * 120 + ps * 60 + j.transformLevel * 45;
      t.length += (t.targetLen - t.length) * 3 * dt;
      t.phase += dt * (1.0 + ps * 0.5);
    }
    // Particles
    const maxP = this.reducedMotion ? 5 : 20;
    if (m.energy > 0.05 && j.particles.length < maxP) {
      j.particles.push({
        x: (Math.random() - 0.5) * j.bellW, y: j.bellH * 0.3 + Math.random() * 30,
        vy: 10 + Math.random() * 20, size: 1 + Math.random() * 2, life: 1
      });
    }
    for (let i = j.particles.length - 1; i >= 0; i--) {
      j.particles[i].y += j.particles[i].vy * dt;
      j.particles[i].x += Math.sin(j.particles[i].life * 5) * dt * 10;
      j.particles[i].life -= dt * 0.5;
      if (j.particles[i].life <= 0) j.particles.splice(i, 1);
    }
  }

  // ---------- PHOENIX update ----------
  _updatePhoenix(S) {
    const { ps, m, dt, pitchNorm, res, pitchConf } = S;
    const p = this._phoenix;
    p.breath += dt * (1.5 + ps);
    const targetFloat = -pitchNorm * 150 * (0.3 + (pitchConf || 0) * 0.7);
    p.floatY += (targetFloat - p.floatY) * 2.5 * dt;
    // Wings lift with pitch
    p.wingAngle += ((0.15 + pitchNorm * 0.9 + ps * 0.4) * Math.PI * 0.5 - p.wingAngle) * 3 * dt;
    // Tail grows with vowels
    p.tailLen += ((30 + m.vowel * 150 + ps * 75) - p.tailLen) * 3 * dt;
    // Flame intensity
    p.flameIntensity += ((0.1 + ps * 0.7 + m.energy * 0.3) - p.flameIntensity) * 3 * dt;
    // Transform
    if (ps > 0.45) p.transformLevel += (ps - 0.45) * 0.7 * dt;
    else p.transformLevel -= 0.12 * dt;
    p.transformLevel = Math.max(0, Math.min(1, p.transformLevel));
    // Flames — rising particles
    const maxF = this.reducedMotion ? 15 : 60;
    if (p.flameIntensity > 0.05 && p.flames.length < maxF) {
      const spread = 25 + p.transformLevel * 30;
      p.flames.push({
        x: (Math.random() - 0.5) * spread, y: 0,
        vx: (Math.random() - 0.5) * 30, vy: -(40 + Math.random() * 60 + ps * 40),
        size: 3 + Math.random() * 5 + ps * 3, life: 0.4 + Math.random() * 0.5
      });
    }
    for (let i = p.flames.length - 1; i >= 0; i--) {
      const f = p.flames[i]; f.x += f.vx * dt; f.y += f.vy * dt;
      f.vx += (Math.random() - 0.5) * 80 * dt; f.life -= dt;
      if (f.life <= 0) p.flames.splice(i, 1);
    }
    // Sparks on articulation
    if (m.articulation > 0.4 && ps > 0.1) {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        p.sparks.push({
          x: Math.cos(a) * 20, y: Math.sin(a) * 20 - 10,
          vx: Math.cos(a) * (60 + Math.random() * 40), vy: Math.sin(a) * (60 + Math.random() * 40),
          life: 0.3 + Math.random() * 0.3, size: 1 + Math.random() * 2
        });
      }
    }
    for (let i = p.sparks.length - 1; i >= 0; i--) {
      const s = p.sparks[i]; s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      if (s.life <= 0) p.sparks.splice(i, 1);
    }
    if (p.sparks.length > 30) p.sparks.splice(0, p.sparks.length - 30);
    // Embers
    const maxE = this.reducedMotion ? 5 : 20;
    if (p.flameIntensity > 0.15 && p.embers.length < maxE) {
      p.embers.push({
        x: (Math.random() - 0.5) * 60, y: 10 + Math.random() * 30,
        vx: (Math.random() - 0.5) * 15, vy: -(5 + Math.random() * 15),
        life: 1 + Math.random(), size: 1 + Math.random()
      });
    }
    for (let i = p.embers.length - 1; i >= 0; i--) {
      const e = p.embers[i]; e.x += e.vx * dt; e.y += e.vy * dt;
      e.vx += (Math.random() - 0.5) * 10 * dt; e.life -= dt * 0.5;
      if (e.life <= 0) p.embers.splice(i, 1);
    }
  }

  // ---------- NEBULA update ----------
  _updateNebula(S) {
    const { ps, m, dt, pitchNorm, res } = S;
    const n = this._nebula;
    n.breath += dt * (0.6 + ps * 0.3);
    // Compression — pitch compresses the cloud
    n.compression += ((1.0 - pitchNorm * 0.5 + ps * 0.2) - n.compression) * 2 * dt;
    // Radius with energy
    n.radius += ((100 + m.energy * 60 + ps * 30) * n.compression - n.radius) * 2 * dt;
    // Spiral arms from vowels
    n.spiralLen += ((m.vowel * 180 + ps * 90) - n.spiralLen) * 2 * dt;
    n.spiralAngle += dt * (0.2 + ps * 0.3);
    // Core glow
    n.coreGlow += ((0.1 + ps * 0.6 + m.energy * 0.3) - n.coreGlow) * 3 * dt;
    // Transform — star collapse
    if (ps > 0.45) n.transformLevel += (ps - 0.45) * 0.6 * dt;
    else n.transformLevel -= 0.08 * dt;
    n.transformLevel = Math.max(0, Math.min(1, n.transformLevel));
    n.ringAlpha += ((n.transformLevel > 0.5 ? (n.transformLevel - 0.5) * 2 : 0) - n.ringAlpha) * 2 * dt;
    // Dust motes orbit
    for (const d of n.dustMotes) {
      d.angle += d.speed * dt * (1 + ps * 0.5);
      d.dist += ((40 + (1 - n.transformLevel) * 80) - d.dist) * 0.5 * dt;
    }
    // Flares on articulation
    if (m.articulation > 0.4 && ps > 0.1) {
      const a = Math.random() * Math.PI * 2;
      n.flares.push({ angle: a, length: 30 + Math.random() * 40, life: 0.5 + Math.random() * 0.3, width: 2 + Math.random() * 3 });
    }
    for (let i = n.flares.length - 1; i >= 0; i--) {
      n.flares[i].life -= dt; if (n.flares[i].life <= 0) n.flares.splice(i, 1);
    }
    if (n.flares.length > 10) n.flares.splice(0, n.flares.length - 10);
  }

  // ---------- SPIRIT update ----------
  _updateSpirit(S) {
    const { ps, m, dt, pitchNorm, res, pitchConf } = S;
    const sp = this._spirit;
    sp.breath += dt * (1.0 + ps * 0.5);
    const targetFloat = -pitchNorm * 140 * (0.3 + (pitchConf || 0) * 0.7);
    sp.floatY += (targetFloat - sp.floatY) * 2.5 * dt;
    // Orb size
    sp.orbR += ((25 + m.energy * 20 + ps * 12) - sp.orbR) * 3 * dt;
    // Glow
    sp.glow += ((0.15 + ps * 0.6 + m.energy * 0.3) - sp.glow) * 3 * dt;
    // Color temp — res warm/cool
    sp.colorTemp += (((res || 0.5)) - sp.colorTemp) * 2 * dt;
    // Transform
    if (ps > 0.4) sp.transformLevel += (ps - 0.4) * 0.7 * dt;
    else sp.transformLevel -= 0.1 * dt;
    sp.transformLevel = Math.max(0, Math.min(1, sp.transformLevel));
    // Ribbons — vowels extend
    for (const r of sp.ribbons) {
      r.targetLen = 45 + m.vowel * 135 + ps * 60 + sp.transformLevel * 60;
      r.length += (r.targetLen - r.length) * 3 * dt;
      r.phase += dt * (r.freq + ps * 0.5);
    }
    // Spirit lights on articulation
    if (m.articulation > 0.3 && ps > 0.05) {
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 50;
        sp.lights.push({
          x: Math.cos(a) * d, y: Math.sin(a) * d,
          vx: (Math.random() - 0.5) * 20, vy: -(10 + Math.random() * 20),
          life: 0.6 + Math.random() * 0.5, size: 2 + Math.random() * 3
        });
      }
    }
    for (let i = sp.lights.length - 1; i >= 0; i--) {
      const l = sp.lights[i]; l.x += l.vx * dt; l.y += l.vy * dt; l.life -= dt;
      if (l.life <= 0) sp.lights.splice(i, 1);
    }
    if (sp.lights.length > 25) sp.lights.splice(0, sp.lights.length - 25);
    // Bokeh drift
    for (const b of sp.bokeh) {
      b.x += Math.sin(b.phase) * b.speed * 10 * dt;
      b.y += Math.cos(b.phase * 0.7) * b.speed * 8 * dt;
      b.phase += dt * b.speed;
    }
  }

  // ---------- KOI update ----------
  _updateKoi(S) {
    const { ps, m, dt, pitchNorm, res, pitchConf } = S;
    const k = this._koi;
    k.breath += dt * (1.0 + ps * 0.5);
    k.swimPhase += dt * (2.0 + ps * 1.5);
    // Depth from pitch
    const targetFloat = -pitchNorm * 140 * (0.3 + (pitchConf || 0) * 0.7);
    k.floatY += (targetFloat - k.floatY) * 2.0 * dt;
    // Fin extension from vowels
    k.finExt += ((m.vowel * 1.2 + ps * 0.5) - k.finExt) * 3 * dt;
    // Tail amplitude from energy
    k.tailAmp += ((0.3 + m.energy * 0.5 + ps * 0.3) - k.tailAmp) * 3 * dt;
    // Iridescence from resonance
    k.iridescence += (((res || 0.5)) - k.iridescence) * 2 * dt;
    // Transform — dragon koi
    if (ps > 0.45) k.transformLevel += (ps - 0.45) * 0.6 * dt;
    else k.transformLevel -= 0.1 * dt;
    k.transformLevel = Math.max(0, Math.min(1, k.transformLevel));
    k.whiskerLen += (k.transformLevel * 80 - k.whiskerLen) * 2 * dt;
    k.bodyLen += ((1 + k.transformLevel * 0.8) - k.bodyLen) * 1.5 * dt;
    // Ripples on articulation
    if (m.articulation > 0.3 && ps > 0.05) {
      k.ripples.push({ r: 10, maxR: 60 + Math.random() * 40, life: 1, x: (Math.random() - 0.5) * 40, y: (Math.random() - 0.5) * 20 });
    }
    for (let i = k.ripples.length - 1; i >= 0; i--) {
      const rp = k.ripples[i]; rp.r += (rp.maxR - rp.r) * 3 * dt; rp.life -= dt * 1.2;
      if (rp.life <= 0) k.ripples.splice(i, 1);
    }
    if (k.ripples.length > 8) k.ripples.splice(0, k.ripples.length - 8);
  }

  // ============================================================
  // VOICE CREATURE — Draw (Dispatcher)
  // ============================================================
  drawCreatureScene(prosodyGlow) {
    const ctx = this.ctx, w = this.width, h = this.height;
    if (!w || !h) return;
    const ps = this.prosodyScore;
    const hue = this.ballHue, sat = this.ballSat, lit = this.ballLit;
    const time = performance.now() / 1000;
    // --- Shared background ---
    const tp = {
      highcontrast: ['#030305', '#080814', '#0c0c1f', '#12122a']
    };
    const cols = tp[this.themeMode] || tp.highcontrast;
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, cols[0]); bg.addColorStop(0.4, cols[1]); bg.addColorStop(0.7, cols[2]); bg.addColorStop(1, cols[3]);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    if (this.stars) {
      for (const s of this.stars) {
        ctx.globalAlpha = (0.3 + 0.4 * Math.sin(time * 1.5 + s.twinkle)) * 0.35;
        ctx.fillStyle = '#c8c6d8';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 0.8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // 1. Confusion Jitter setup (applied before dispatch)
    let cxJitter = 0, cyJitter = 0;
    const m = this.analyzer.metrics;
    if (ps < 0.15 && m.energy > 0.1) {
      cxJitter = (Math.random() - 0.5) * 15 * m.energy;
      cyJitter = (Math.random() - 0.5) * 15 * m.energy;
      ctx.save();
      ctx.translate(cxJitter, cyJitter);
    }

    // --- Dispatch ---
    const S = { ctx, w, h, ps, hue, sat, lit, time, res: this.analyzer.smoothResonance, m };
    switch (this.creatureStyle) {
      case 'jellyfish': this._drawJellyfish(S); break;
      case 'phoenix': this._drawPhoenix(S); break;
      case 'nebula': this._drawNebula(S); break;
      case 'spirit': this._drawSpirit(S); break;
      case 'koi': this._drawKoi(S); break;
      default: this._drawBlob(S); break;
    }

    // --- Global Exaggerations (Applied to all styles) ---

    // 1. Confusion Jitter (low prosody, high energy)
    let jitterX = 0; let jitterY = 0;
    if (ps < 0.15 && m.energy > 0.1) {
      jitterX = (Math.random() - 0.5) * 10 * m.energy;
      jitterY = (Math.random() - 0.5) * 10 * m.energy;
      ctx.translate(jitterX, jitterY); // Apply jitter to subsequent shared effects if desired, but mostly it would need to be applied *before* the creature is drawn.
      // Actually, to apply jitter to the creature itself, we need to pass it into S or apply it to the context before dispatching. Let's do a screen shake effect instead.
    }

    // 2. Super Voice Overdrive Aura
    if (ps > 0.7 && m.energy > 0.6) {
      const cx = w / 2, cy = h * 0.5;
      const auraPulse = 0.5 + 0.5 * Math.sin(time * 15);
      const intensity = (ps - 0.7) * (m.energy - 0.5) * 10;

      const aG = ctx.createRadialGradient(cx, cy, 50, cx, cy, 300 + auraPulse * 50);
      aG.addColorStop(0, `hsla(${hue + 40}, 90%, 70%, ${0.3 * intensity})`);
      aG.addColorStop(0.5, `hsla(${hue}, 100%, 60%, ${0.1 * intensity})`);
      aG.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = aG;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    // 3. Tempo Dashes (Speed Lines)
    if (m.tempo > 0.6 && ps > 0.2) {
      const lineCount = Math.floor(m.tempo * 15);
      ctx.strokeStyle = `hsla(${hue}, 80%, 80%, ${m.tempo * 0.3})`;
      ctx.lineWidth = 1 + m.tempo * 2;
      for (let i = 0; i < lineCount; i++) {
        const y = h * 0.2 + Math.random() * h * 0.6;
        const len = 50 + Math.random() * 200 * m.tempo;
        const x = w / 2 - 100 - Math.random() * 300; // Left side rushing in
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - len, y);
        ctx.stroke();

        const x2 = w / 2 + 100 + Math.random() * 300; // Right side rushing out
        ctx.beginPath();
        ctx.moveTo(x2, y);
        ctx.lineTo(x2 + len, y);
        ctx.stroke();
      }
    }

    // 4. Syllable Shockwaves
    if (!this._shockwaves) this._shockwaves = [];
    if (m.syllable > 0.6 && ps > 0.2) {
      this._shockwaves.push({ r: 50, life: 1.0, maxLife: 1.0, cx: w / 2, cy: h * 0.5, hue: hue });
    }

    // Draw and update shockwaves
    for (let i = this._shockwaves.length - 1; i >= 0; i--) {
      const sw = this._shockwaves[i];
      sw.r += 800 * (1 / 60); // fast expansion
      sw.life -= (1 / 60) * 2; // half second life

      if (sw.life > 0) {
        ctx.strokeStyle = `hsla(${sw.hue}, 100%, 80%, ${sw.life * 0.5})`;
        ctx.lineWidth = 2 + sw.life * 5;
        ctx.beginPath();
        ctx.arc(sw.cx, sw.cy, sw.r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        this._shockwaves.splice(i, 1);
      }
    }
    if (ps < 0.15 && m.energy > 0.1) {
      ctx.restore(); // remove jitter transform
    }

    // --- Shared HUD ---
    ctx.font = '600 14px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(ps * 100)}%`, w - 16, 28);
  }

  // ---------- BLOB draw (original) ----------
  _drawBlob(S) {
    const { ctx, w, h, ps, hue, sat, lit, time } = S;
    const c = this.creature, cx = w / 2, cy = h * 0.52 + c.floatY;
    // Aura particles
    for (const ap of c.auraParticles) {
      ctx.globalAlpha = ap.life * 0.4 * (0.3 + ps);
      ctx.fillStyle = `hsl(${hue}, ${sat * 0.6}%, ${lit + 20}%)`;
      ctx.beginPath(); ctx.arc(cx + ap.x, cy + ap.y, ap.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Outer aura
    if (c.glow > 0.05) {
      const aR = 120 + ps * 60 + c.wingSpread * 40;
      const aura = ctx.createRadialGradient(cx, cy, 10, cx, cy, aR);
      aura.addColorStop(0, `hsla(${hue},${sat}%,${lit}%,${c.glow * 0.3})`);
      aura.addColorStop(0.5, `hsla(${hue},${sat * 0.6}%,${lit * 0.7}%,${c.glow * 0.12})`);
      aura.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = aura; ctx.beginPath(); ctx.arc(cx, cy, aR, 0, Math.PI * 2); ctx.fill();
    }
    // Pulse rings
    for (const ring of c.pulseRings) {
      ctx.strokeStyle = `hsla(${hue},${sat}%,${lit + 15}%,${ring.life * 0.4})`;
      ctx.lineWidth = 1.5 + ring.life * 2;
      ctx.beginPath(); ctx.arc(cx, cy, ring.r, 0, Math.PI * 2); ctx.stroke();
    }
    // Wings
    if (c.wingSpread > 0.02) {
      const wA = c.wingSpread * (0.15 + ps * 0.2);
      for (let side = -1; side <= 1; side += 2) {
        ctx.save(); ctx.translate(cx, cy); ctx.globalAlpha = wA;
        const sp = c.wingSpread * 70, wO = 8 * Math.sin(time * 2 + side);
        ctx.beginPath(); ctx.moveTo(0, -10);
        ctx.bezierCurveTo(side * sp * 0.6, -40 + wO, side * sp * 1.2, -20 + wO * 0.5, side * sp * 1.5, 10 + wO);
        ctx.bezierCurveTo(side * sp * 1.1, 30 + wO * 0.3, side * sp * 0.5, 35, 0, 15);
        ctx.closePath();
        const wG = ctx.createLinearGradient(0, 0, side * sp * 1.5, 0);
        wG.addColorStop(0, `hsla(${hue},${sat}%,${lit}%,0.4)`);
        wG.addColorStop(0.6, `hsla(${hue + side * 20},${sat * 0.7}%,${lit + 10}%,0.2)`);
        wG.addColorStop(1, `hsla(${hue + side * 40},${sat * 0.4}%,${lit + 20}%,0)`);
        ctx.fillStyle = wG; ctx.fill(); ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    // Tendrils
    for (const t of c.tendrils) {
      if (t.length < 3) continue;
      ctx.save(); ctx.translate(cx, cy);
      const bA = t.angle + 0.2 * Math.sin(time * 0.7 + t.phase);
      const segs = 12, segLen = t.length / segs;
      ctx.beginPath();
      let px = Math.cos(bA) * (c.points[0]?.r || 50) * 0.85;
      let py = Math.sin(bA) * (c.points[0]?.r || 50) * 0.85;
      ctx.moveTo(px, py);
      let curAngle = bA;
      for (let s = 0; s < segs; s++) {
        const frac = s / segs;
        curAngle += t.curl * 0.3 + 0.15 * Math.sin(t.phase + time * 2 + frac * 4);
        px += Math.cos(curAngle) * segLen; py += Math.sin(curAngle) * segLen;
        ctx.lineTo(px, py);
      }
      ctx.strokeStyle = `hsla(${hue + 15},${sat * 0.7}%,${lit + 10}%,${0.2 + ps * 0.3})`;
      ctx.lineWidth = t.width; ctx.lineCap = 'round'; ctx.stroke(); ctx.restore();
    }
    // Body bezier blob
    ctx.save(); ctx.translate(cx, cy);
    const pts = c.points, n = pts.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      const x1 = Math.cos(p1.angle) * p1.r, y1 = Math.sin(p1.angle) * p1.r;
      const x2 = Math.cos(p2.angle) * p2.r, y2 = Math.sin(p2.angle) * p2.r;
      if (i === 0) ctx.moveTo(x1, y1);
      const x0 = Math.cos(p0.angle) * p0.r, y0 = Math.sin(p0.angle) * p0.r;
      const x3 = Math.cos(p3.angle) * p3.r, y3 = Math.sin(p3.angle) * p3.r;
      const T = 0.35;
      ctx.bezierCurveTo(x1 + (x2 - x0) * T, y1 + (y2 - y0) * T, x2 - (x3 - x1) * T, y2 - (y3 - y1) * T, x2, y2);
    }
    ctx.closePath();
    const bR = Math.max(...pts.map(p => p.r));
    const bG = ctx.createRadialGradient(0, 0, 0, 0, 0, bR);
    bG.addColorStop(0, `hsla(${hue},${sat}%,${Math.min(95, lit + 25)}%,${0.6 + c.glow * 0.35})`);
    bG.addColorStop(0.4, `hsla(${hue},${sat}%,${lit}%,${0.4 + c.glow * 0.3})`);
    bG.addColorStop(0.8, `hsla(${hue + 15},${sat * 0.7}%,${lit * 0.7}%,${0.2 + c.glow * 0.15})`);
    bG.addColorStop(1, `hsla(${hue + 30},${sat * 0.5}%,${lit * 0.5}%,0.05)`);
    ctx.fillStyle = bG; ctx.fill();
    ctx.strokeStyle = `hsla(${hue},${sat * 0.8}%,${lit + 15}%,${0.15 + c.glow * 0.25})`;
    ctx.lineWidth = 1.5; ctx.stroke();
    // Core light
    const cR = 6 + c.glow * 8 + ps * 4;
    const cG = ctx.createRadialGradient(0, -5, 0, 0, -5, cR);
    cG.addColorStop(0, `hsla(${hue},30%,95%,${0.5 + c.glow * 0.5})`);
    cG.addColorStop(0.5, `hsla(${hue},${sat}%,${lit + 20}%,${0.3 + c.glow * 0.3})`);
    cG.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = cG; ctx.beginPath(); ctx.arc(0, -5, cR, 0, Math.PI * 2); ctx.fill();
    // Transform veins
    if (c.transformLevel > 0.3) {
      const vA = (c.transformLevel - 0.3) * 1.4;
      ctx.globalAlpha = Math.min(0.5, vA);
      ctx.strokeStyle = `hsla(${hue + 60},70%,80%,1)`; ctx.lineWidth = 0.8;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const px = Math.cos(p.angle) * p.r * 0.4, py = Math.sin(p.angle) * p.r * 0.4;
        const ox = Math.cos(p.angle) * p.r * 0.85, oy = Math.sin(p.angle) * p.r * 0.85;
        const mO = 8 * Math.sin(time * 2 + p.angle * 3);
        ctx.beginPath(); ctx.moveTo(px, py);
        ctx.quadraticCurveTo((px + ox) / 2 + mO, (py + oy) / 2 - mO, ox, oy); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // Articulation sparkles
    if (this.analyzer.metrics.articulation > 0.3 && ps > 0.1) {
      const sC = Math.floor(this.analyzer.metrics.articulation * ps * 5);
      for (let i = 0; i < sC; i++) {
        const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * (bR + 20);
        const sx = cx + Math.cos(a) * d, sy = cy + Math.sin(a) * d, sz = 1.5 + Math.random() * 2;
        ctx.globalAlpha = 0.5 + Math.random() * 0.5; ctx.fillStyle = '#fff';
        ctx.beginPath();
        for (let j = 0; j < 8; j++) {
          const sa = (j / 8) * Math.PI * 2, sr = j % 2 === 0 ? sz : sz * 0.3;
          ctx.lineTo(sx + Math.cos(sa) * sr, sy + Math.sin(sa) * sr);
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---------- JELLYFISH draw ----------
  _drawJellyfish(S) {
    const { ctx, w, h, ps, hue, sat, lit, time } = S;
    const j = this._jelly, cx = w / 2, cy = h * 0.48 + j.floatY;
    const bW = j.bellW, bH = j.bellH;
    // Outer aura glow
    if (j.glow > 0.05) {
      const aR = bW * 2.5 + ps * 30;
      const ag = ctx.createRadialGradient(cx, cy, 5, cx, cy, aR);
      ag.addColorStop(0, `hsla(${hue},${sat}%,${lit}%,${j.glow * 0.2})`);
      ag.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(cx, cy, aR, 0, Math.PI * 2); ctx.fill();
    }
    // Bell dome
    ctx.save(); ctx.translate(cx, cy);
    const breathOff = Math.sin(j.breath) * 4;
    ctx.beginPath(); ctx.moveTo(-bW, 0);
    // Top dome arc
    ctx.bezierCurveTo(-bW, -bH * 1.2 + breathOff, bW, -bH * 1.2 + breathOff, bW, 0);
    // Bottom wavy edge
    const edgeN = j.bellEdge.length;
    for (let i = edgeN - 1; i >= 0; i--) {
      const t = i / (edgeN - 1); // 1 to 0
      const ex = bW * (1 - 2 * t);
      const ey = 5 + 6 * Math.sin(j.bellEdge[i].phase + time * j.bellEdge[i].speed) + breathOff * 0.3;
      ctx.lineTo(ex, ey);
    }
    ctx.closePath();
    // Translucent fill
    const bg = ctx.createRadialGradient(0, -bH * 0.4, 5, 0, 0, bW * 1.2);
    bg.addColorStop(0, `hsla(${hue},${sat}%,${Math.min(90, lit + 30)}%,${0.35 + j.glow * 0.3})`);
    bg.addColorStop(0.5, `hsla(${hue + 20},${sat * 0.8}%,${lit}%,${0.15 + j.glow * 0.15})`);
    bg.addColorStop(1, `hsla(${hue + 40},${sat * 0.5}%,${lit * 0.7}%,0.05)`);
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = `hsla(${hue},${sat}%,${lit + 20}%,${0.15 + j.glow * 0.2})`; ctx.lineWidth = 1.5; ctx.stroke();
    // Internal organs glow
    const oGlow = j.glow + j.biolumFlash * 0.5;
    for (let i = 0; i < 3; i++) {
      const ox = Math.sin(time * 0.5 + i * 2.1) * bW * 0.3;
      const oy = -bH * (0.2 + i * 0.2) + Math.cos(time * 0.7 + i) * 4;
      const oR = 6 + i * 3 + oGlow * 5;
      const og = ctx.createRadialGradient(ox, oy, 0, ox, oy, oR);
      og.addColorStop(0, `hsla(${hue + 40 + i * 20},70%,80%,${oGlow * 0.6})`);
      og.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = og; ctx.beginPath(); ctx.arc(ox, oy, oR, 0, Math.PI * 2); ctx.fill();
    }
    // Biolum flash
    if (j.biolumFlash > 0.05) {
      ctx.globalAlpha = j.biolumFlash * 0.4;
      const fg = ctx.createRadialGradient(0, -bH * 0.3, 0, 0, -bH * 0.3, bW);
      fg.addColorStop(0, `hsla(${hue + 60},80%,90%,0.8)`);
      fg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(0, -bH * 0.3, bW, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // Tentacles
    ctx.save(); ctx.translate(cx, cy);
    for (const t of j.tentacles) {
      if (t.length < 3) continue;
      const segs = 14, segLen = t.length / segs;
      ctx.beginPath();
      let px = t.x * bW, py = 3;
      ctx.moveTo(px, py);
      let ang = Math.PI / 2 + t.x * 0.3;
      for (let s = 0; s < segs; s++) {
        const frac = s / segs;
        ang += t.curl + 0.12 * Math.sin(t.phase + time * 1.5 + frac * 5);
        px += Math.cos(ang) * segLen; py += Math.sin(ang) * segLen;
        ctx.lineTo(px, py);
      }
      const alpha = 0.12 + ps * 0.2 + j.glow * 0.15;
      ctx.strokeStyle = `hsla(${hue + 15},${sat * 0.6}%,${lit + 15}%,${alpha})`;
      ctx.lineWidth = t.width * (1 + j.transformLevel * 0.5); ctx.lineCap = 'round'; ctx.stroke();
    }
    ctx.restore();
    // Particles drifting down
    for (const p of j.particles) {
      ctx.globalAlpha = p.life * 0.3;
      ctx.fillStyle = `hsl(${hue + 30},${sat * 0.5}%,${lit + 20}%)`;
      ctx.beginPath(); ctx.arc(cx + p.x, cy + p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- PHOENIX draw ----------
  _drawPhoenix(S) {
    const { ctx, w, h, ps, hue, sat, lit, time } = S;
    const p = this._phoenix, cx = w / 2, cy = h * 0.52 + p.floatY;
    // Warm hue override for fire
    const fHue = 15 + (1 - p.flameIntensity) * 30; // orange to yellow
    const fSat = 80 + p.flameIntensity * 20;
    const fLit = 45 + p.flameIntensity * 25;
    // Heat aura
    if (p.flameIntensity > 0.05) {
      const aR = 100 + p.transformLevel * 80 + ps * 30;
      const ag = ctx.createRadialGradient(cx, cy, 10, cx, cy, aR);
      ag.addColorStop(0, `hsla(${fHue},${fSat}%,${fLit}%,${p.flameIntensity * 0.2})`);
      ag.addColorStop(0.5, `hsla(${fHue + 20},${fSat * 0.6}%,30%,${p.flameIntensity * 0.08})`);
      ag.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(cx, cy, aR, 0, Math.PI * 2); ctx.fill();
    }
    // Embers (behind body)
    for (const e of p.embers) {
      ctx.globalAlpha = Math.max(0, e.life * 0.4);
      ctx.fillStyle = `hsl(${fHue + 20},90%,60%)`;
      ctx.beginPath(); ctx.arc(cx + e.x, cy + e.y, e.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Flames
    for (const f of p.flames) {
      const alpha = Math.max(0, f.life / 0.9) * p.flameIntensity;
      const fSize = f.size * (f.life + 0.3);
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = `hsl(${fHue + (1 - f.life) * 40},${fSat}%,${fLit + (1 - f.life) * 20}%)`;
      ctx.beginPath(); ctx.arc(cx + f.x, cy + f.y, fSize, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Body + Wings
    ctx.save(); ctx.translate(cx, cy);
    const bodyW = 20 + p.transformLevel * 10, bodyH = 25 + p.transformLevel * 8;
    // Wings
    const wSpan = 50 + p.wingAngle * 50 + p.transformLevel * 40;
    const wFlap = 5 * Math.sin(time * 3);
    for (let side = -1; side <= 1; side += 2) {
      ctx.beginPath(); ctx.moveTo(0, -5);
      ctx.bezierCurveTo(side * wSpan * 0.4, -35 + wFlap, side * wSpan * 0.8, -25 + wFlap * 0.5, side * wSpan, 5 + wFlap);
      ctx.bezierCurveTo(side * wSpan * 0.7, 15, side * wSpan * 0.3, 18, 0, 8);
      ctx.closePath();
      const wg = ctx.createLinearGradient(0, 0, side * wSpan, 0);
      wg.addColorStop(0, `hsla(${fHue},${fSat}%,${fLit}%,${0.5 + p.flameIntensity * 0.3})`);
      wg.addColorStop(0.5, `hsla(${fHue + 30},${fSat}%,${fLit + 10}%,${0.3 + p.flameIntensity * 0.2})`);
      wg.addColorStop(1, `hsla(${fHue + 50},${fSat * 0.5}%,${fLit + 20}%,0.05)`);
      ctx.fillStyle = wg; ctx.fill();
    }
    // Body core
    const bg = ctx.createRadialGradient(0, -3, 3, 0, 0, bodyW);
    bg.addColorStop(0, `hsla(${fHue},40%,95%,${0.6 + p.flameIntensity * 0.3})`);
    bg.addColorStop(0.5, `hsla(${fHue},${fSat}%,${fLit}%,${0.4 + p.flameIntensity * 0.2})`);
    bg.addColorStop(1, `hsla(${fHue + 20},${fSat * 0.6}%,30%,0.1)`);
    ctx.fillStyle = bg; ctx.beginPath(); ctx.ellipse(0, 0, bodyW, bodyH, 0, 0, Math.PI * 2); ctx.fill();
    // Tail feathers
    if (p.tailLen > 5) {
      for (let i = 0; i < 3; i++) {
        const tA = Math.PI / 2 + (i - 1) * 0.2 + 0.1 * Math.sin(time * 2 + i);
        ctx.beginPath(); ctx.moveTo(0, bodyH * 0.6);
        const tLen = p.tailLen * (0.7 + i * 0.15);
        const ctrlX = Math.cos(tA) * tLen * 0.5, ctrlY = bodyH * 0.6 + Math.sin(tA) * tLen * 0.5;
        ctx.quadraticCurveTo(ctrlX, ctrlY, Math.cos(tA) * tLen * 0.3, bodyH * 0.6 + tLen);
        ctx.strokeStyle = `hsla(${fHue + i * 15},${fSat}%,${fLit + 10}%,${0.3 + p.flameIntensity * 0.3})`;
        ctx.lineWidth = 2 + p.transformLevel * 2; ctx.lineCap = 'round'; ctx.stroke();
      }
    }
    ctx.restore();
    // Sparks
    for (const s of p.sparks) {
      ctx.globalAlpha = Math.max(0, s.life * 2);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx + s.x, cy + s.y, s.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- NEBULA draw ----------
  _drawNebula(S) {
    const { ctx, w, h, ps, hue, sat, lit, time } = S;
    const n = this._nebula, cx = w / 2, cy = h * 0.5;
    const R = n.radius;
    // Gas layers — stacked transparent ellipses
    for (let i = 3; i >= 0; i--) {
      const layerR = R * (1.2 - i * 0.15);
      const rotOff = n.breath + i * 0.5;
      const skewX = Math.sin(rotOff) * layerR * 0.15;
      const skewY = Math.cos(rotOff * 0.7) * layerR * 0.1;
      const lHue = hue + i * 25 - n.transformLevel * 30;
      ctx.globalAlpha = 0.08 + n.coreGlow * 0.08 + (3 - i) * 0.03;
      ctx.fillStyle = `hsl(${lHue},${sat * 0.7 + i * 5}%,${lit * 0.6 + i * 8}%)`;
      ctx.beginPath();
      ctx.ellipse(cx + skewX, cy + skewY, layerR * (1 + n.compression * 0.2), layerR * (0.7 + n.compression * 0.1), rotOff * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Spiral arms
    if (n.spiralLen > 5) {
      for (let arm = 0; arm < 2; arm++) {
        ctx.beginPath();
        const baseA = n.spiralAngle + arm * Math.PI;
        for (let s = 0; s < 30; s++) {
          const t = s / 30;
          const a = baseA + t * 3;
          const r = R * 0.3 + t * n.spiralLen;
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.6;
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${hue + arm * 40},${sat * 0.6}%,${lit + 15}%,${0.1 + ps * 0.15})`;
        ctx.lineWidth = 2 + ps * 2; ctx.lineCap = 'round'; ctx.stroke();
      }
    }
    // Dust motes
    for (const d of n.dustMotes) {
      const dx = cx + Math.cos(d.angle) * d.dist, dy = cy + Math.sin(d.angle) * d.dist * 0.6;
      ctx.globalAlpha = 0.2 + 0.15 * Math.sin(d.phase + time);
      ctx.fillStyle = `hsl(${hue + 30},${sat * 0.4}%,${lit + 25}%)`;
      ctx.beginPath(); ctx.arc(dx, dy, d.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Core glow
    const cR = 10 + n.coreGlow * 20 + n.transformLevel * 25;
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cR);
    cg.addColorStop(0, `hsla(${hue},30%,95%,${0.4 + n.coreGlow * 0.5 + n.transformLevel * 0.3})`);
    cg.addColorStop(0.4, `hsla(${hue},${sat}%,${lit + 20}%,${0.2 + n.coreGlow * 0.3})`);
    cg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, cR, 0, Math.PI * 2); ctx.fill();
    // Ring system (when transformed)
    if (n.ringAlpha > 0.02) {
      ctx.globalAlpha = n.ringAlpha * 0.4;
      for (let r = 0; r < 3; r++) {
        const rR = cR + 15 + r * 18;
        ctx.strokeStyle = `hsla(${hue + r * 30},${sat * 0.6}%,${lit + 15}%,0.6)`;
        ctx.lineWidth = 1 + (2 - r) * 0.5;
        ctx.beginPath(); ctx.ellipse(cx, cy, rR, rR * 0.25, 0.3 + r * 0.1, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // Flares
    for (const f of n.flares) {
      ctx.globalAlpha = f.life * 0.6;
      ctx.strokeStyle = `hsla(${hue + 60},80%,85%,1)`;
      ctx.lineWidth = f.width * f.life;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(f.angle) * f.length, cy + Math.sin(f.angle) * f.length * 0.6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- SPIRIT draw ----------
  _drawSpirit(S) {
    const { ctx, w, h, ps, hue, sat, lit, time } = S;
    const sp = this._spirit, cx = w / 2, cy = h * 0.5 + sp.floatY;
    const warmHue = 35, coolHue = 190;
    const sHue = warmHue + (coolHue - warmHue) * sp.colorTemp;
    // Bokeh particles
    for (const b of sp.bokeh) {
      ctx.globalAlpha = b.alpha * (0.5 + 0.5 * Math.sin(b.phase));
      const bH = sHue + Math.sin(b.phase * 2) * 30;
      ctx.fillStyle = `hsl(${bH},40%,70%)`;
      ctx.beginPath(); ctx.arc(cx + b.x, cy + b.y, b.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Outer aura
    if (sp.glow > 0.05) {
      const aR = sp.orbR * 5 + ps * 30;
      const ag = ctx.createRadialGradient(cx, cy, sp.orbR, cx, cy, aR);
      ag.addColorStop(0, `hsla(${sHue},${sat * 0.7}%,${lit}%,${sp.glow * 0.15})`);
      ag.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(cx, cy, aR, 0, Math.PI * 2); ctx.fill();
    }
    // Ribbons
    ctx.save(); ctx.translate(cx, cy);
    for (const r of sp.ribbons) {
      if (r.length < 5) continue;
      const segs = 20, segLen = r.length / segs;
      ctx.beginPath();
      let rx = Math.cos(r.angle) * sp.orbR * 0.9, ry = Math.sin(r.angle) * sp.orbR * 0.9;
      ctx.moveTo(rx, ry);
      let ang = r.angle;
      for (let s = 0; s < segs; s++) {
        const frac = s / segs;
        ang += 0.08 + r.amp * 0.01 * Math.sin(r.phase + frac * 6 + time * r.freq);
        rx += Math.cos(ang) * segLen; ry += Math.sin(ang) * segLen;
        ctx.lineTo(rx, ry);
      }
      const rAlpha = 0.1 + ps * 0.2 + sp.glow * 0.15;
      const rHue = sHue + Math.sin(r.phase) * 20;
      ctx.strokeStyle = `hsla(${rHue},50%,70%,${rAlpha})`;
      ctx.lineWidth = r.width * (1 + sp.transformLevel * 0.8); ctx.lineCap = 'round'; ctx.stroke();
    }
    ctx.restore();
    // Core orb
    const oR = sp.orbR;
    const og = ctx.createRadialGradient(cx, cy, 0, cx, cy, oR);
    og.addColorStop(0, `hsla(${sHue},30%,95%,${0.6 + sp.glow * 0.4})`);
    og.addColorStop(0.5, `hsla(${sHue},${sat * 0.6}%,${lit + 10}%,${0.3 + sp.glow * 0.3})`);
    og.addColorStop(1, `hsla(${sHue},${sat * 0.4}%,${lit}%,0.05)`);
    ctx.fillStyle = og; ctx.beginPath(); ctx.arc(cx, cy, oR, 0, Math.PI * 2); ctx.fill();
    // Spirit lights
    for (const l of sp.lights) {
      ctx.globalAlpha = Math.max(0, l.life) * 0.7;
      ctx.fillStyle = `hsl(${sHue + 40},60%,80%)`;
      ctx.beginPath(); ctx.arc(cx + l.x, cy + l.y, l.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Spectral bloom at high transform
    if (sp.transformLevel > 0.3) {
      const bA = (sp.transformLevel - 0.3) * 1.4;
      ctx.globalAlpha = Math.min(0.3, bA);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + time * 0.3;
        const bLen = oR + sp.transformLevel * 60;
        ctx.strokeStyle = `hsla(${sHue + i * 15},50%,75%,0.5)`;
        ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, cy);
        const bx = cx + Math.cos(a) * bLen, by = cy + Math.sin(a) * bLen;
        const mx = (cx + bx) / 2 + Math.sin(time * 2 + i) * 15;
        const my = (cy + by) / 2 + Math.cos(time * 1.5 + i) * 12;
        ctx.quadraticCurveTo(mx, my, bx, by); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---------- KOI draw ----------
  _drawKoi(S) {
    const { ctx, w, h, ps, hue, sat, lit, time } = S;
    const k = this._koi, cx = w / 2, cy = h * 0.5 + k.floatY;
    const bodyL = 50 * k.bodyLen, bodyW = 20 + k.transformLevel * 5;
    const swimOff = Math.sin(k.swimPhase) * 8 * k.tailAmp;
    // Water caustics overlay
    ctx.globalAlpha = 0.03 + ps * 0.02;
    for (let i = 0; i < 8; i++) {
      const cx2 = w * 0.1 + i * w * 0.1 + Math.sin(time * 0.3 + i) * 30;
      const cy2 = h * 0.3 + Math.cos(time * 0.4 + i * 1.3) * h * 0.2;
      ctx.fillStyle = `hsl(${190 + i * 5},40%,70%)`;
      ctx.beginPath(); ctx.ellipse(cx2, cy2, 40 + i * 5, 15, time * 0.1 + i, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Ripples
    for (const rp of k.ripples) {
      ctx.strokeStyle = `hsla(${hue},${sat * 0.4}%,${lit + 15}%,${rp.life * 0.25})`;
      ctx.lineWidth = 1; ctx.beginPath();
      ctx.ellipse(cx + rp.x, cy + rp.y, rp.r, rp.r * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // Body
    ctx.save(); ctx.translate(cx, cy);
    // Fish body bezier
    ctx.beginPath();
    ctx.moveTo(-bodyL, swimOff * 0.5);
    ctx.bezierCurveTo(-bodyL * 0.6, -bodyW + swimOff * 0.3, bodyL * 0.2, -bodyW * 0.8, bodyL * 0.5, swimOff * 0.3);
    ctx.bezierCurveTo(bodyL * 0.2, bodyW * 0.8, -bodyL * 0.6, bodyW + swimOff * 0.3, -bodyL, swimOff * 0.5);
    ctx.closePath();
    // Iridescent body fill
    const iHue = hue + k.iridescence * 60 + Math.sin(time * 0.5) * 15;
    const bg = ctx.createLinearGradient(-bodyL, -bodyW, bodyL, bodyW);
    bg.addColorStop(0, `hsla(${iHue},${sat * 0.8}%,${lit + 10}%,0.7)`);
    bg.addColorStop(0.5, `hsla(${iHue + 30},${sat}%,${lit + 15}%,0.6)`);
    bg.addColorStop(1, `hsla(${iHue + 60},${sat * 0.7}%,${lit}%,0.5)`);
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = `hsla(${iHue},${sat * 0.6}%,${lit + 20}%,0.3)`; ctx.lineWidth = 1; ctx.stroke();
    // Scale shimmer
    const scaleN = 8 + Math.floor(k.transformLevel * 4);
    for (let i = 0; i < scaleN; i++) {
      const sx = -bodyL * 0.7 + (i / scaleN) * bodyL * 1.2;
      for (let j = -1; j <= 1; j += 2) {
        const sy = j * bodyW * 0.3 * (1 - Math.abs(sx) / bodyL);
        const shimmer = 0.05 + 0.08 * Math.sin(time * 2 + i * 1.2 + j);
        ctx.globalAlpha = shimmer + k.transformLevel * 0.05;
        ctx.fillStyle = `hsl(${iHue + i * 5},60%,85%)`;
        ctx.beginPath(); ctx.arc(sx, sy + swimOff * (sx / bodyL) * 0.3, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    // Tail fin
    const tailX = -bodyL - 5, tailSpread = 15 + k.finExt * 20 + k.tailAmp * 10;
    const tailWave = swimOff * 1.5;
    ctx.beginPath(); ctx.moveTo(-bodyL + 5, swimOff * 0.3);
    ctx.bezierCurveTo(tailX, -tailSpread + tailWave, tailX - 15, -tailSpread * 0.5 + tailWave, tailX - 10, tailWave);
    ctx.bezierCurveTo(tailX - 15, tailSpread * 0.5 + tailWave, tailX, tailSpread + tailWave, -bodyL + 5, swimOff * 0.3);
    ctx.fillStyle = `hsla(${iHue + 20},${sat * 0.7}%,${lit + 5}%,${0.4 + k.finExt * 0.2})`;
    ctx.fill();
    // Dorsal fin
    const finH = 12 + k.finExt * 15;
    ctx.beginPath(); ctx.moveTo(-bodyL * 0.3, -bodyW * 0.7);
    ctx.quadraticCurveTo(0, -bodyW - finH + swimOff * 0.5, bodyL * 0.3, -bodyW * 0.5);
    ctx.strokeStyle = `hsla(${iHue},${sat * 0.6}%,${lit + 10}%,${0.3 + k.finExt * 0.2})`;
    ctx.lineWidth = 2; ctx.stroke();
    // Eye
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(bodyL * 0.3, -bodyW * 0.15 + swimOff * 0.2, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(bodyL * 0.32, -bodyW * 0.15 + swimOff * 0.2, 1.5, 0, Math.PI * 2); ctx.fill();
    // Dragon whiskers
    if (k.whiskerLen > 2) {
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(bodyL * 0.45, side * bodyW * 0.1 + swimOff * 0.2);
        const wEnd = bodyL * 0.45 + k.whiskerLen;
        const wCurve = side * 10 + Math.sin(time * 1.5) * 5;
        ctx.quadraticCurveTo(wEnd * 0.7, side * bodyW * 0.3 + wCurve, wEnd, side * bodyW * 0.5 + wCurve);
        ctx.strokeStyle = `hsla(${iHue + 40},50%,75%,${0.3 + k.transformLevel * 0.3})`;
        ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ============================================================
  // VOICE GARDEN — Plant factory
  // ============================================================
  _makeGardenPlant(x, type, hue, sat, initGrowth) {
    const depth = 0.3 + Math.random() * 0.7; // 0.3=far, 1.0=near
    const seed = Math.floor(Math.random() * 10000);
    // Deterministic random from seed
    const srand = (n) => { let s = seed * 9301 + n * 49297; return ((s * s) % 233280) / 233280; };
    return {
      x, type, hue, sat, depth,
      growth: initGrowth || 0,
      bloom: 0,
      age: 0,       // time since spawned
      maxH: (type === 'tree' ? 120 + srand(1) * 90
        : type === 'flower' ? 60 + srand(1) * 45
          : type === 'fern' ? 45 + srand(1) * 30
            : 27 + srand(1) * 21) * (0.6 + depth * 0.4),
      swayPhase: srand(2) * Math.PI * 2,
      variant: srand(3),
      seed,
      // Deterministic fruit/spot positions (computed once, not per-frame)
      fruitAngles: Array.from({ length: 6 }, (_, i) => srand(10 + i) * Math.PI * 2),
      fruitDists: Array.from({ length: 6 }, (_, i) => 0.3 + srand(20 + i) * 0.5),
      spotAngles: Array.from({ length: 4 }, (_, i) => -Math.PI + srand(30 + i) * Math.PI),
      // Effects states
      bouncePhase: 0,
      isBoomTree: false
    };
  }

  // ============================================================
  // VOICE GARDEN — Update
  // ============================================================
  updateGarden(dt) {
    const m = this.analyzer.metrics;
    const ps = this.prosodyScore;
    const g = this.garden;
    g.time += dt;

    // Prosody score
    const rawPS = m.bounce * 0.30 + m.tempo * 0.20 + m.vowel * 0.20 +
      m.articulation * 0.15 + m.syllable * 0.15;
    this.prosodyScore += (rawPS - this.prosodyScore) * 2.0 * dt;

    // Vowel → global growth multiplier (sunlight) - exaggerated 1.5x
    g.globalGrowth += ((m.vowel * 1.05 + m.energy * 0.45) - g.globalGrowth) * 3 * dt;

    // Syllable → spawn new plants
    g.spawnCooldown -= dt;
    if (m.syllable > 0.5 && g.spawnCooldown <= 0 && m.energy > 0.05) {
      const hz = this.analyzer.smoothPitchHz;
      let type;
      if (hz < 130) type = 'mushroom';
      else if (hz < 170) type = 'fern';
      else if (hz < 220) type = 'flower';
      else type = 'tree';

      const res = this.analyzer.smoothResonance;
      let hue;
      if (this.colorblindMode) {
        hue = 220 - res * 165;
      } else {
        hue = 240 - res * 200;
      }
      const sat = 40 + res * 50;

      g.cursor += 20 + Math.random() * 40;
      const newPlant = this._makeGardenPlant(g.cursor, type, hue, sat, 0.005);

      // Booming Tree effect
      if (type === 'tree' && m.energy > 0.7) {
        newPlant.isBoomTree = true;
        newPlant.growth = 0.5 + Math.random() * 0.3; // instant partial growth
        // Spawn dust cloud
        for (let d = 0; d < 15; d++) {
          g.pollen.push({
            x: g.cursor + (Math.random() - 0.5) * 40, y: h * 0.76 - 5,
            vx: (Math.random() - 0.5) * 80, vy: -20 - Math.random() * 40,
            size: 3 + Math.random() * 5, life: 1, maxLife: 1.5 + Math.random(),
            hue: 30, sat: 20, lit: 20, bright: false // dirt colors
          });
        }
      }
      // Bounce Mushroom setup
      if (type === 'mushroom') {
        newPlant.bounceAmp = 1.0 + m.syllable * 2.0;
      }

      g.plants.push(newPlant);
      g.spawnCooldown = 0.25 + Math.random() * 0.25;
      // Maintain depth sort (back-to-front) for draw order
      g.plants.sort((a, b) => a.depth - b.depth);
    }

    // Grow all plants + age tracking
    const growSpeed = 0.18 + g.globalGrowth * 1.05 + ps * 0.45; // 1.5x speed
    for (const p of g.plants) {
      p.age += dt;
      p.growth = Math.min(1, p.growth + growSpeed * dt * (0.4 + p.depth * 0.2));
      if (ps > 0.25 && p.growth > 0.3) {
        p.bloom = Math.min(1, p.bloom + (ps - 0.2) * 0.6 * dt); // bloom faster
      }

      // Super Bloom Force
      if (ps > 0.8 && m.energy > 0.8) {
        p.bloom = 1.0;
        p.growth = Math.min(1.0, p.growth + 2.0 * dt);
      }

      // Mushroom Bounce animation
      if (p.type === 'mushroom' && p.bounceAmp > 0) {
        p.bouncePhase += dt * 15;
        p.bounceAmp *= (1 - dt * 3);
        if (p.bounceAmp < 0.01) p.bounceAmp = 0;
      }
    }

    if (g.plants.length > 250) g.plants.splice(0, g.plants.length - 250);

    // Smooth camera
    const rightEdge = Math.max(g.cursor, this.width * 0.5);
    const targetCamX = Math.max(0, rightEdge - this.width * 0.65);
    g.smoothCamX += (targetCamX - g.smoothCamX) * 2.5 * dt;

    // Articulation → pollen bursts (Hyper-Vibe when tempo & ps are high)
    const pollenMult = (m.tempo > 0.7 && ps > 0.5) ? 5 : 1;
    if (m.articulation > 0.3 && ps > 0.1 && g.pollen.length < 60 * pollenMult) {
      const cnt = Math.floor(m.articulation * 3 * this.particleScale * pollenMult);
      for (let i = 0; i < cnt; i++) {
        const rp = g.plants.length > 0
          ? g.plants[Math.max(0, g.plants.length - 1 - Math.floor(Math.random() * Math.min(10, g.plants.length)))]
          : null;
        const px = rp ? rp.x + (Math.random() - 0.5) * 40 : g.cursor + (Math.random() - 0.5) * 100;
        g.pollen.push({
          x: px, y: g.groundY - 20 - Math.random() * 80,
          vx: (Math.random() - 0.5) * (20 * pollenMult),
          vy: -10 - Math.random() * (25 * pollenMult),
          size: 1.5 + Math.random() * 2.5,
          life: 1, maxLife: 2.5 + Math.random() * 2,
          hue: rp ? rp.hue + Math.random() * 40 : 60,
          sat: 65, lit: 78,
          bright: true,
        });
      }
    }

    // Shooting Stars (High Pitch + Vowels)
    if (this.analyzer.smoothPitchHz > 300 && m.vowel > 0.7 && Math.random() < 2 * dt) {
      if (!g.stars) g.stars = [];
      g.stars.push({
        x: g.smoothCamX - 100, y: Math.random() * h * 0.4,
        vx: 800 + Math.random() * 400, vy: (Math.random() - 0.5) * 200,
        life: 1.0, size: 2 + Math.random() * 3
      });
    }
    if (g.stars) {
      for (let i = g.stars.length - 1; i >= 0; i--) {
        const s = g.stars[i];
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= dt * 0.5;
        if (s.life <= 0 || s.x > g.smoothCamX + w + 100) g.stars.splice(i, 1);
      }
    }

    // Ambient fireflies — always present, gentle
    const maxFireflies = this.reducedMotion ? 6 : 20;
    if (g.fireflies.length < maxFireflies && g.plants.length > 3) {
      if (Math.random() < 0.3 * dt) {
        const fX = g.smoothCamX + Math.random() * this.width;
        g.fireflies.push({
          x: fX, y: g.groundY - 30 - Math.random() * 120,
          baseX: fX, baseY: g.groundY - 30 - Math.random() * 120,
          phase: Math.random() * Math.PI * 2,
          speed: 0.5 + Math.random() * 1.0,
          size: 1 + Math.random() * 1.5,
          life: 1, maxLife: 6 + Math.random() * 8,
          hue: 50 + Math.random() * 80,
        });
      }
    }

    // Update pollen
    for (let i = g.pollen.length - 1; i >= 0; i--) {
      const p = g.pollen[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 5 * dt;
      p.vx += (Math.random() - 0.5) * 30 * dt;
      p.life -= dt / p.maxLife;
      if (p.life <= 0) g.pollen.splice(i, 1);
    }

    // Update fireflies
    for (let i = g.fireflies.length - 1; i >= 0; i--) {
      const f = g.fireflies[i];
      f.phase += dt * f.speed;
      f.x = f.baseX + Math.sin(f.phase) * 25 + Math.cos(f.phase * 0.7) * 15;
      f.y = f.baseY + Math.cos(f.phase * 1.3) * 12 + Math.sin(f.phase * 0.5) * 8;
      f.life -= dt / f.maxLife;
      if (f.life <= 0) g.fireflies.splice(i, 1);
    }
  }

  // ============================================================
  // VOICE GARDEN — Draw
  // ============================================================
  drawGardenScene(prosodyGlow) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (!w || !h) return;

    const g = this.garden;
    const ps = this.prosodyScore;
    g.groundY = h * 0.76;
    const gy = g.groundY;
    const camX = g.smoothCamX;
    const time = g.time;

    // 1. Withering Glitch Jitter (low prosody, high energy)
    let jitterX = 0, jitterY = 0;
    const isGlitching = ps < 0.15 && this.analyzer.metrics.energy > 0.1;
    if (isGlitching) {
      jitterX = (Math.random() - 0.5) * 8 * this.analyzer.metrics.energy;
      jitterY = (Math.random() - 0.5) * 8 * this.analyzer.metrics.energy;
      ctx.save();
      ctx.translate(jitterX, jitterY);
    }

    // ---- Sky gradient — theme-aware with garden earth tones ----
    const gardenSkies = {
      highcontrast: ['#020206', '#04060a', '#080c10', '#101818', '#122020', '#08120a'],
    };
    const skyColors = gardenSkies[this.themeMode] || gardenSkies.highcontrast;
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
    skyGrad.addColorStop(0, skyColors[0]);
    skyGrad.addColorStop(0.35, skyColors[1]);
    skyGrad.addColorStop(0.55, skyColors[2]);
    skyGrad.addColorStop(0.7, skyColors[3]);
    skyGrad.addColorStop(0.76, skyColors[4]);
    skyGrad.addColorStop(1, skyColors[5]);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    // ---- Stars (warm-tinted, dim) ----
    if (this.stars) {
      for (const star of this.stars) {
        const twinkle = 0.3 + 0.3 * Math.sin(time * 1.2 + star.twinkle);
        ctx.globalAlpha = twinkle * 0.2;
        ctx.fillStyle = '#d8d0b8';
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // ---- Shooting Stars ----
    if (g.stars) {
      for (const s of g.stars) {
        ctx.globalAlpha = s.life;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        // A streaking star
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - 30 * s.life, s.y - 10 * s.life);
        ctx.lineTo(s.x, s.y + s.size);
        ctx.lineTo(s.x + 40 * s.life, s.y + 15 * s.life);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // ---- Moon ----
    const moonX = w * 0.82;
    const moonY = h * 0.12;
    const moonR = 22;
    const moonGlow = ctx.createRadialGradient(moonX, moonY, moonR * 0.3, moonX, moonY, moonR * 6);
    moonGlow.addColorStop(0, 'rgba(220,230,200,0.12)');
    moonGlow.addColorStop(0.3, 'rgba(180,200,160,0.04)');
    moonGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = moonGlow;
    ctx.beginPath();
    ctx.arc(moonX, moonY, moonR * 6, 0, Math.PI * 2);
    ctx.fill();
    // Moon disc
    ctx.fillStyle = 'rgba(220,230,210,0.25)';
    ctx.beginPath();
    ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
    ctx.fill();

    // ---- Moonbeams when vowels active ----
    if (g.globalGrowth > 0.15) {
      const beamAlpha = (g.globalGrowth - 0.15) * 0.1;
      for (let i = 0; i < 4; i++) {
        const baseAngle = -0.6 + i * 0.35 + Math.sin(time * 0.2 + i) * 0.05;
        const bx1 = moonX + Math.cos(baseAngle) * moonR;
        const by1 = moonY + Math.sin(baseAngle) * moonR;
        const bx2 = bx1 + Math.cos(baseAngle) * h;
        const by2 = by1 + Math.sin(baseAngle) * h;
        const beamGrad = ctx.createLinearGradient(bx1, by1, bx2, by2);
        beamGrad.addColorStop(0, `rgba(200,220,180,${beamAlpha})`);
        beamGrad.addColorStop(0.4, `rgba(200,220,180,${beamAlpha * 0.3})`);
        beamGrad.addColorStop(1, 'rgba(200,220,180,0)');
        ctx.fillStyle = beamGrad;
        ctx.beginPath();
        ctx.moveTo(bx1 - 8, by1);
        ctx.lineTo(bx1 + 8, by1);
        ctx.lineTo(bx2 + 50, by2);
        ctx.lineTo(bx2 - 50, by2);
        ctx.closePath();
        ctx.fill();
      }
    }

    // ---- Undulating terrain ----
    const getTerrainY = (worldX) => {
      return gy + Math.sin(worldX * 0.006) * 8
        + Math.sin(worldX * 0.015 + 2.1) * 4
        + Math.sin(worldX * 0.003 + 0.7) * 12;
    };

    // Ground fill
    const groundGrad = ctx.createLinearGradient(0, gy - 20, 0, h);
    groundGrad.addColorStop(0, '#1c2c1a');
    groundGrad.addColorStop(0.15, '#172417');
    groundGrad.addColorStop(0.5, '#121e12');
    groundGrad.addColorStop(1, '#0a140a');
    ctx.fillStyle = groundGrad;
    ctx.beginPath();
    ctx.moveTo(-5, h + 5);
    for (let x = -5; x <= w + 5; x += 4) {
      ctx.lineTo(x, getTerrainY(x + camX));
    }
    ctx.lineTo(w + 5, h + 5);
    ctx.closePath();
    ctx.fill();

    // Ground line highlight
    ctx.strokeStyle = 'rgba(80,160,80,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const ty = getTerrainY(x + camX);
      if (x === 0) ctx.moveTo(x, ty); else ctx.lineTo(x, ty);
    }
    ctx.stroke();

    // ---- Grass tufts on terrain ----
    for (let gx = 0; gx < w; gx += 5) {
      const worldX = gx + camX;
      const seedVal = Math.sin(worldX * 0.37) * Math.cos(worldX * 0.13);
      if (seedVal > 0.15) {
        const terrY = getTerrainY(worldX);
        const gh = 3 + seedVal * 9;
        const sway = Math.sin(time * 1.5 + worldX * 0.05) * (2 + ps * 2);
        ctx.strokeStyle = `rgba(50,130,50,${0.12 + seedVal * 0.12})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(gx, terrY);
        ctx.quadraticCurveTo(gx + sway, terrY - gh * 0.6, gx + sway * 1.5, terrY - gh);
        ctx.stroke();
      }
    }

    // ---- Draw plants (pre-sorted by depth, back-to-front) ----
    for (const plant of g.plants) {
      const sx = plant.x - camX;
      if (sx < -100 || sx > w + 100) continue;
      const gr = plant.growth;
      if (gr < 0.003) continue;

      const depthScale = 0.5 + plant.depth * 0.5; // far=0.5x, near=1x
      const depthDim = 0.4 + plant.depth * 0.6;   // far=dimmer

      // Withering Glitch effect on sway
      const glitchSway = isGlitching ? (Math.random() - 0.5) * 10 : 0;

      const terrainAtPlant = getTerrainY(plant.x);
      const sway = Math.sin(time * 1.2 + plant.swayPhase) * (2 + ps * 4) * gr * depthScale + glitchSway;
      let pH = plant.maxH * gr * depthScale;
      // Mushroom Bounce Y stretch
      let bounceScaleY = 1.0;
      if (plant.type === 'mushroom' && plant.bounceAmp > 0) {
        bounceScaleY = 1.0 + Math.sin(plant.bouncePhase) * plant.bounceAmp;
        pH *= bounceScaleY;
      }

      const hue = isGlitching ? plant.hue : plant.hue; // could grayscale, but jitter is enough
      const sat = isGlitching ? plant.sat * 0.5 : plant.sat;
      const bloom = plant.bloom;

      ctx.save();
      ctx.translate(sx, terrainAtPlant);

      // ---- Sprout phase (growth < 0.1) ----
      if (gr < 0.1) {
        const sproutH = pH * 0.8 + 4;
        const sproutAlpha = (gr / 0.1) * depthDim;
        ctx.strokeStyle = `hsla(${hue + 80}, ${sat * 0.5}%, 40%, ${sproutAlpha * 0.8})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(sway * 0.3, -sproutH);
        ctx.stroke();
        // Tiny seed glow
        if (plant.age < 1.5) {
          const sparkAlpha = Math.max(0, 1 - plant.age) * 0.5;
          ctx.fillStyle = `rgba(255,255,200,${sparkAlpha})`;
          ctx.beginPath();
          ctx.arc(0, 0, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        continue;
      }

      const baseAlpha = (0.6 + gr * 0.35) * depthDim;

      if (plant.type === 'mushroom') {
        const stipeW = (2.5 + plant.variant * 3) * depthScale;
        const stipeH = pH * 0.55;
        // Stipe
        ctx.fillStyle = `hsla(${hue + 20}, ${sat * 0.4}%, 50%, ${baseAlpha})`;
        ctx.beginPath();
        ctx.moveTo(-stipeW, 0);
        ctx.quadraticCurveTo(-stipeW * 0.7, -stipeH * 0.5, -stipeW * 0.4 + sway * 0.3, -stipeH);
        ctx.lineTo(stipeW * 0.4 + sway * 0.3, -stipeH);
        ctx.quadraticCurveTo(stipeW * 0.7, -stipeH * 0.5, stipeW, 0);
        ctx.closePath();
        ctx.fill();

        // Cap
        const capW = (7 + plant.variant * 8 + bloom * 5) * depthScale;
        const capH = (5 + plant.variant * 5 + bloom * 3) * depthScale;
        const capY = -stipeH;
        ctx.fillStyle = `hsla(${hue}, ${sat + bloom * 20}%, ${35 + bloom * 20}%, ${baseAlpha})`;
        ctx.beginPath();
        ctx.ellipse(sway * 0.3, capY - capH * 0.25, capW, capH, 0, Math.PI, 0);
        ctx.fill();

        // Bioluminescent underglow
        const bioGlow = 0.06 + bloom * 0.12 + ps * 0.06;
        const glowGrad = ctx.createRadialGradient(sway * 0.3, capY, 0, sway * 0.3, capY + capH * 0.5, capW * 1.5);
        glowGrad.addColorStop(0, `hsla(${hue + 30}, 80%, 65%, ${bioGlow * depthDim})`);
        glowGrad.addColorStop(0.5, `hsla(${hue + 30}, 60%, 50%, ${bioGlow * 0.3 * depthDim})`);
        glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(sway * 0.3, capY + capH * 0.3, capW * 1.5, 0, Math.PI * 2);
        ctx.fill();

        // Spots
        if (bloom > 0.25) {
          ctx.fillStyle = `hsla(${hue + 40}, ${sat}%, 75%, ${(bloom - 0.25) * 0.5 * depthDim})`;
          for (let s = 0; s < 3; s++) {
            const sa = plant.spotAngles[s];
            const sr = capW * 0.45;
            ctx.beginPath();
            ctx.arc(sway * 0.3 + Math.cos(sa) * sr, capY - capH * 0.25 + Math.sin(sa) * capH * 0.25,
              (1.5 + bloom) * depthScale, 0, Math.PI * 2);
            ctx.fill();
          }
        }

      } else if (plant.type === 'fern') {
        const stemH = pH;
        const tipX = sway;
        // Central stem
        ctx.strokeStyle = `hsla(${hue + 80}, ${sat + 10}%, 30%, ${baseAlpha})`;
        ctx.lineWidth = (1.5 + gr) * depthScale;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(sway * 0.5, -stemH * 0.5, tipX, -stemH);
        ctx.stroke();

        // Fronds — thicker, leafier
        const frondCount = 3 + Math.floor(gr * 6);
        for (let f = 0; f < frondCount; f++) {
          const t = (f + 1) / (frondCount + 1);
          const fx = sway * t * 0.5;
          const fy = -stemH * t;
          const side = f % 2 === 0 ? -1 : 1;
          const fLen = (8 + bloom * 10) * gr * (1 - t * 0.3) * depthScale;
          const leafSway = Math.sin(time * 2 + f + plant.swayPhase) * (2 + ps * 2);

          // Filled leaf shape
          ctx.fillStyle = `hsla(${hue + 85 + f * 3}, ${sat + 15}%, ${28 + bloom * 18}%, ${baseAlpha * 0.7})`;
          ctx.beginPath();
          ctx.moveTo(fx, fy);
          ctx.quadraticCurveTo(fx + side * fLen * 0.5 + leafSway, fy - fLen * 0.4,
            fx + side * fLen + leafSway, fy - fLen * 0.05);
          ctx.quadraticCurveTo(fx + side * fLen * 0.5 + leafSway, fy + fLen * 0.15,
            fx, fy);
          ctx.fill();
        }

        // Unfurling tip
        if (gr < 0.6) {
          ctx.strokeStyle = `hsla(${hue + 100}, ${sat}%, 40%, ${baseAlpha * 0.5})`;
          ctx.lineWidth = depthScale;
          ctx.beginPath();
          ctx.arc(tipX, -stemH, 4 * depthScale * (1 - gr), Math.PI * 0.5, Math.PI * 2.5, false);
          ctx.stroke();
        }

      } else if (plant.type === 'flower') {
        const stemH = pH * 0.7;
        // Stem
        ctx.strokeStyle = `hsla(${hue + 100}, ${sat * 0.5}%, 28%, ${baseAlpha})`;
        ctx.lineWidth = (1.5 + gr * 0.5) * depthScale;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(sway * 0.3, -stemH * 0.5, sway * 0.6, -stemH);
        ctx.stroke();

        // Leaves along stem
        if (gr > 0.25) {
          for (let lf = 0; lf < 2; lf++) {
            const leafY = -stemH * (0.3 + lf * 0.25);
            const leafSide = (lf + (plant.variant > 0.5 ? 1 : 0)) % 2 === 0 ? 1 : -1;
            const leafLen = (8 + bloom * 4) * depthScale;
            const leafSway = sway * (0.15 + lf * 0.1);
            ctx.fillStyle = `hsla(${hue + 90}, ${sat * 0.6}%, 30%, ${baseAlpha * 0.6})`;
            ctx.beginPath();
            ctx.moveTo(leafSway, leafY);
            ctx.quadraticCurveTo(leafSide * leafLen * 0.7 + leafSway, leafY - 5,
              leafSide * leafLen + leafSway, leafY + 2);
            ctx.quadraticCurveTo(leafSide * leafLen * 0.4 + leafSway, leafY + 4,
              leafSway, leafY);
            ctx.fill();
          }
        }

        // Flower head
        const flX = sway * 0.6;
        const flY = -stemH;
        const petalCount = 5 + Math.floor(plant.variant * 3);
        const petalR = (3 + bloom * 8) * gr * depthScale;

        if (bloom > 0.08) {
          // Petal glow
          if (bloom > 0.4) {
            const flGlow = ctx.createRadialGradient(flX, flY, 0, flX, flY, petalR * 3);
            flGlow.addColorStop(0, `hsla(${hue}, ${sat}%, 65%, ${(bloom - 0.3) * 0.06 * depthDim})`);
            flGlow.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = flGlow;
            ctx.beginPath();
            ctx.arc(flX, flY, petalR * 3, 0, Math.PI * 2);
            ctx.fill();
          }

          // Petals — teardrop shapes
          for (let p = 0; p < petalCount; p++) {
            const pa = (p / petalCount) * Math.PI * 2 + plant.seed * 0.001;
            const petalAlpha = bloom * 0.7 * depthDim;
            ctx.fillStyle = `hsla(${hue + p * 4}, ${sat + 20}%, ${45 + bloom * 25}%, ${petalAlpha})`;
            ctx.save();
            ctx.translate(flX, flY);
            ctx.rotate(pa);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.bezierCurveTo(petalR * 0.4, -petalR * 0.3,
              petalR * 0.4, -petalR * 0.8,
              0, -petalR);
            ctx.bezierCurveTo(-petalR * 0.4, -petalR * 0.8,
              -petalR * 0.4, -petalR * 0.3,
              0, 0);
            ctx.fill();
            ctx.restore();
          }

          // Center pistil (Hyper-vibe glow)
          const isHyper = ps > 0.8 && this.analyzer.metrics.tempo > 0.7;
          ctx.fillStyle = `hsla(${hue + 40}, ${isHyper ? 100 : sat}%, ${isHyper ? 90 : 70}%, ${bloom * 0.8 * depthDim})`;
          ctx.beginPath();
          ctx.arc(flX, flY, (2 + bloom * 2 + (isHyper ? 1.5 : 0)) * depthScale, 0, Math.PI * 2);
          ctx.fill();
        }

      } else if (plant.type === 'tree') {
        const trunkH = pH * 0.5;
        const trunkW = (2.5 + gr * 4) * depthScale;

        // Trunk with slight taper
        ctx.fillStyle = `hsla(${hue + 20}, ${sat * 0.3}%, 22%, ${baseAlpha})`;
        ctx.beginPath();
        ctx.moveTo(-trunkW, 0);
        ctx.quadraticCurveTo(-trunkW * 0.6 + sway * 0.1, -trunkH * 0.5, -trunkW * 0.3 + sway * 0.2, -trunkH);
        ctx.lineTo(trunkW * 0.3 + sway * 0.2, -trunkH);
        ctx.quadraticCurveTo(trunkW * 0.6 + sway * 0.1, -trunkH * 0.5, trunkW, 0);
        ctx.closePath();
        ctx.fill();

        // Branches
        if (gr > 0.4) {
          ctx.strokeStyle = `hsla(${hue + 20}, ${sat * 0.3}%, 22%, ${baseAlpha * 0.6})`;
          ctx.lineWidth = depthScale * 1.2;
          for (let b = 0; b < 3; b++) {
            const by = -trunkH * (0.5 + b * 0.15);
            const bSide = b % 2 === 0 ? -1 : 1;
            const bLen = (10 + gr * 12 + bloom * 5) * depthScale;
            const bSway = sway * 0.2 + Math.sin(time * 0.7 + b + plant.swayPhase) * 2;
            ctx.beginPath();
            ctx.moveTo(sway * 0.15 * (by / -trunkH), by);
            ctx.quadraticCurveTo(bSide * bLen * 0.5 + bSway, by - bLen * 0.3,
              bSide * bLen + bSway, by - bLen * 0.15);
            ctx.stroke();
          }
        }

        // Canopy — multi-layered, more organic
        const canopyY = -trunkH;
        const canopyR = (12 + plant.variant * 15 + bloom * 10) * gr * depthScale;
        for (let l = 0; l < 4; l++) {
          const ly = canopyY - l * canopyR * 0.28;
          const lr = canopyR * (1 - l * 0.12);
          const lSway = sway * 0.25 + Math.sin(time * 0.8 + l + plant.swayPhase) * 2.5;
          const lAlpha = (0.25 + gr * 0.25 + bloom * 0.1) * depthDim;
          ctx.fillStyle = `hsla(${hue + 75 + l * 8}, ${sat + 10}%, ${22 + bloom * 18 + l * 4}%, ${lAlpha})`;
          ctx.beginPath();
          ctx.ellipse(lSway, ly, lr, lr * 0.65, 0, 0, Math.PI * 2);
          ctx.fill();
        }

        // Fruit when blooming
        if (bloom > 0.45) {
          const fruitCount = 2 + Math.floor(bloom * 3);
          for (let f = 0; f < fruitCount; f++) {
            const fa = plant.fruitAngles[f];
            const fd = canopyR * plant.fruitDists[f];
            const fx = sway * 0.25 + Math.cos(fa) * fd;
            const fy = canopyY - canopyR * 0.2 + Math.sin(fa) * fd * 0.4;
            ctx.fillStyle = `hsla(${hue}, ${sat + 30}%, ${50 + bloom * 20}%, ${(bloom - 0.4) * depthDim})`;
            ctx.beginPath();
            ctx.arc(fx, fy, (2 + bloom) * depthScale, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      ctx.restore();
    }

    // ---- Ambient fireflies ----
    for (const f of g.fireflies) {
      const sx = f.x - camX;
      if (sx < -30 || sx > w + 30) continue;
      const pulse = 0.4 + 0.6 * Math.sin(f.phase * 3);
      const fadeEdge = Math.min(1, f.life * 4, (1 - f.life) * 4); // fade in/out
      ctx.globalAlpha = pulse * fadeEdge * 0.5;
      ctx.fillStyle = `hsl(${f.hue}, 50%, 70%)`;
      ctx.beginPath();
      ctx.arc(sx, f.y, f.size, 0, Math.PI * 2);
      ctx.fill();
      // Glow halo
      ctx.globalAlpha = pulse * fadeEdge * 0.1;
      ctx.beginPath();
      ctx.arc(sx, f.y, f.size * 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ---- Pollen bursts ----
    for (const p of g.pollen) {
      const sx = p.x - camX;
      if (sx < -20 || sx > w + 20) continue;
      const pulse = 0.4 + 0.6 * Math.sin(time * 5 + p.x);
      ctx.globalAlpha = p.life * pulse * 0.7;
      ctx.fillStyle = `hsl(${p.hue}, 65%, 78%)`;
      ctx.beginPath();
      ctx.arc(sx, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = p.life * pulse * 0.15;
      ctx.beginPath();
      ctx.arc(sx, p.y, p.size * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Super Bloom overlay
    if (ps > 0.8 && this.analyzer.metrics.energy > 0.8) {
      ctx.globalCompositeOperation = 'screen';
      const sbGrad = ctx.createLinearGradient(0, h, 0, 0);
      sbGrad.addColorStop(0, `hsla(120, 80%, 70%, ${(ps - 0.8) * 0.5})`);
      sbGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sbGrad;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    if (isGlitching) {
      ctx.restore(); // remove jitter
    }

    // HUD
    ctx.font = '600 14px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.textAlign = 'right';
    ctx.fillText(`${g.plants.length} 🌱`, w - 16, 28);
  }

  _pitchHzToNoteLabel(hz) {
    if (!hz || !Number.isFinite(hz)) return '—';
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const note = names[(midi + 1200) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${note}${octave}`;
  }

  _triggerMetricHighlight(metric, threshold = 0.75) {
    const val = this.analyzer.metrics[metric] || 0;
    const isExtreme = val >= threshold;
    if (isExtreme && !this.metricExtremeLatch[metric]) {
      this.metricHighlightTimers[metric] = 0.35;
    }
    this.metricExtremeLatch[metric] = isExtreme;
  }

  // ============================================================
  // VOICE CANVAS — Update
  // ============================================================
  updateVoiceCanvas(dt) {
    const m = this.analyzer.metrics;
    const vc = this.voiceCanvas;
    vc.time += dt;

    // Prosody score
    const rawPS = m.bounce * 0.30 + m.tempo * 0.20 + m.vowel * 0.20 +
      m.articulation * 0.15 + m.syllable * 0.15;
    this.prosodyScore += (rawPS - this.prosodyScore) * 2.0 * dt;
    const ps = this.prosodyScore;

    // Smooth energy for stroke width
    vc.smoothEnergy += (m.energy - vc.smoothEnergy) * 5 * dt;

    // Pitch → Y (inverted: high pitch = top)
    const hz = this.analyzer.smoothPitchHz;
    const pitchConf = this.analyzer.pitchConfidence;
    vc.wasSpeaking = vc.isSpeaking;
    vc.isSpeaking = m.energy > 0.05 && pitchConf > 0.2;

    if (vc.isSpeaking && hz > 50) {
      const pitchNorm = Math.max(0, Math.min(1, (hz - 70) / 300));
      vc.smoothPitchY += ((1 - pitchNorm) - vc.smoothPitchY) * 6 * dt;
    }

    // Bounce → vibrato (waviness perpendicular to stroke)
    vc.vibrato += (m.bounce - vc.vibrato) * 4 * dt;

    // Advance cursor — ONLY while speaking (slow drift in silence)
    const tempoMod = 0.6 + m.tempo * 0.8; // tempo modulates speed
    if (!this.voiceCanvasPaused) {
      if (this.canvasMode === 'freepaint') {
        const resNorm = this.analyzer.smoothResonance;
        const targetX = 30 + resNorm * (this.width - 60);
        const lerpSpeed = vc.isSpeaking ? 5 * dt : 2 * dt;
        vc.cursorX += (targetX - vc.cursorX) * lerpSpeed;
      } else {
        if (vc.isSpeaking) {
          vc.cursorX += (35 + ps * 25) * tempoMod * dt;
        } else {
          vc.cursorX += 4 * dt; // tiny drift so it's not totally frozen
        }
      }
    }

    // Wrap buffer
    if (this.canvasMode !== 'freepaint' && vc.cursorX >= vc.bufferW - 50) {
      vc.cursorX = 30;
      if (vc.bufferCtx) vc.bufferCtx.clearRect(0, 0, vc.bufferW, vc.bufferH);
    }

    // Resonance → color
    const res = this.analyzer.smoothResonance;
    let targetHue;
    if (this.colorblindMode) {
      targetHue = 220 - res * 165;
    } else {
      targetHue = 260 - res * 230;
    }
    vc.strokeHue += (targetHue - vc.strokeHue) * 4 * dt;
    vc.strokeSat = 45 + res * 45 + ps * 10;
    vc.strokeLit = 35 + ps * 25 + vc.smoothEnergy * 20;

    // ---- Paint onto offscreen buffer ----
    if (!vc.bufferCtx) return;
    const bCtx = vc.bufferCtx;
    const bH = vc.bufferH;

    if (vc.isSpeaking) {
      const baseY = 40 + vc.smoothPitchY * (bH - 80);
      // Vibrato waviness
      const vibratoOffset = vc.vibrato * 12 * Math.sin(vc.time * 14 + vc.cursorX * 0.15);
      const targetY = baseY + vibratoOffset;
      const x = vc.cursorX;

      // Stroke width: whisper thin → shout bold
      const strokeW = 1.5 + vc.smoothEnergy * 14 + ps * 3;

      // Opacity: whisper transparent → energetic opaque
      const alpha = 0.15 + vc.smoothEnergy * 0.4 + ps * 0.3 + m.vowel * 0.15;

      if (!vc.wasSpeaking) {
        vc.lastScreenY = targetY;
        vc.lastCtrlY = targetY;
        vc.lastPaintX = x;
        vc.strokeCount++;
      }

      // Smooth bezier curve segment
      const cpX = (vc.lastPaintX + x) / 2;
      const cpY = vc.lastCtrlY + (targetY - vc.lastCtrlY) * 0.5;

      // Main stroke with visibility outline
      const analysisMode = this.voiceCanvasVisualStyle === 'analysis';
      let mainAlpha = analysisMode ? Math.min(0.95, alpha + 0.1) : Math.min(0.85, alpha);
      let baseWidth = analysisMode ? Math.max(2, 1.5 + vc.smoothEnergy * 8) : strokeW;

      // Boost visibility for keyboard mode so it stands out against the keys
      if (this.canvasMode === 'keyboard') {
        mainAlpha = Math.min(1.0, mainAlpha + 0.35);
        baseWidth = Math.max(3, baseWidth * 1.2);
      }

      // Dark outline for visibility against grid/background
      bCtx.strokeStyle = `rgba(0,0,0,${mainAlpha * 0.75})`;
      bCtx.lineWidth = baseWidth + 2.5;
      bCtx.lineCap = 'round';
      bCtx.lineJoin = 'round';
      bCtx.beginPath();
      bCtx.moveTo(vc.lastPaintX, vc.lastScreenY);
      bCtx.quadraticCurveTo(cpX, cpY, x, targetY);
      bCtx.stroke();

      // Main color stroke
      bCtx.strokeStyle = `hsla(${vc.strokeHue}, ${vc.strokeSat}%, ${vc.strokeLit}%, ${mainAlpha})`;
      bCtx.lineWidth = baseWidth;
      bCtx.beginPath();
      bCtx.moveTo(vc.lastPaintX, vc.lastScreenY);
      bCtx.quadraticCurveTo(cpX, cpY, x, targetY);
      bCtx.stroke();

      // Glow layer (prosody-gated, artistic mode only)
      if (this.voiceCanvasVisualStyle === 'artistic' && ps > 0.15) {
        bCtx.strokeStyle = `hsla(${vc.strokeHue + 12}, ${vc.strokeSat * 0.5}%, ${Math.min(88, vc.strokeLit + 22)}%, ${alpha * 0.15})`;
        bCtx.lineWidth = strokeW * 2.8;
        bCtx.beginPath();
        bCtx.moveTo(vc.lastPaintX, vc.lastScreenY);
        bCtx.quadraticCurveTo(cpX, cpY, x, targetY);
        bCtx.stroke();
      }

      // Vowel shimmer — bright highlight core (subtle in analysis mode)
      if (m.vowel > 0.25) {
        const shimmerAlpha = (m.vowel - 0.25) * 0.5;
        bCtx.strokeStyle = `hsla(${vc.strokeHue + 5}, 25%, 92%, ${shimmerAlpha})`;
        bCtx.lineWidth = this.voiceCanvasVisualStyle === 'analysis' ? Math.max(0.8, strokeW * 0.14) : Math.max(0.8, strokeW * 0.25);
        bCtx.beginPath();
        bCtx.moveTo(vc.lastPaintX, vc.lastScreenY);
        bCtx.quadraticCurveTo(cpX, cpY, x, targetY);
        bCtx.stroke();
      }

      // Edge highlight (thin darker outline on thicker strokes, artistic mode only)
      if (this.voiceCanvasVisualStyle === 'artistic' && strokeW > 5) {
        bCtx.strokeStyle = `hsla(${vc.strokeHue - 10}, ${vc.strokeSat}%, ${Math.max(15, vc.strokeLit - 15)}%, ${alpha * 0.2})`;
        bCtx.lineWidth = strokeW + 2;
        bCtx.beginPath();
        bCtx.moveTo(vc.lastPaintX, vc.lastScreenY);
        bCtx.quadraticCurveTo(cpX, cpY, x, targetY);
        bCtx.stroke();
        // Re-draw main on top so edge is behind
        bCtx.strokeStyle = `hsla(${vc.strokeHue}, ${vc.strokeSat}%, ${vc.strokeLit}%, ${Math.min(0.85, alpha)})`;
        bCtx.lineWidth = strokeW;
        bCtx.beginPath();
        bCtx.moveTo(vc.lastPaintX, vc.lastScreenY);
        bCtx.quadraticCurveTo(cpX, cpY, x, targetY);
        bCtx.stroke();
      }

      vc.lastPaintX = x;
      vc.lastScreenY = targetY;
      vc.lastCtrlY = cpY;
      vc.totalPaintX = Math.max(vc.totalPaintX, x);

      // Articulation response
      if (m.articulation > 0.25) {
        if (this.voiceCanvasVisualStyle === 'analysis') {
          vc.articMarkers.push({
            x,
            y: targetY,
            life: 0.35,
            strength: m.articulation,
            hue: vc.strokeHue,
          });
        } else {
          const cnt = Math.floor(m.articulation * ps * 5 * this.particleScale);
          for (let i = 0; i < cnt; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 4 + Math.random() * 25 + m.articulation * 18;
            vc.splatters.push({
              x: x + Math.cos(angle) * dist,
              y: targetY + Math.sin(angle) * dist,
              w: 1 + Math.random() * 3 + m.articulation * 2.5,
              h: 0.5 + Math.random() * 1.5,
              angle: angle + (Math.random() - 0.5) * 0.5,
              hue: vc.strokeHue + (Math.random() - 0.5) * 35,
              sat: vc.strokeSat,
              lit: vc.strokeLit + Math.random() * 12,
              alpha: 0.25 + ps * 0.4,
            });
          }
        }
      }

      // Paint drips on thick strokes
      if (this.voiceCanvasVisualStyle === 'artistic' && strokeW > 6 && Math.random() < 0.12) {
        vc.drips.push({
          x, y: targetY,
          vy: 8 + Math.random() * 25,
          length: 0,
          maxLength: 10 + Math.random() * 35 + strokeW * 1.5,
          hue: vc.strokeHue, sat: vc.strokeSat, lit: vc.strokeLit,
          width: 0.8 + Math.random() * 1.5,
          alpha: alpha * 0.4,
        });
      }
    }

    // Render splatters to buffer (elongated ellipses)
    for (const s of vc.splatters) {
      bCtx.save();
      bCtx.translate(s.x, s.y);
      bCtx.rotate(s.angle);
      bCtx.fillStyle = `hsla(${s.hue}, ${s.sat}%, ${s.lit}%, ${s.alpha})`;
      bCtx.beginPath();
      bCtx.ellipse(0, 0, s.w, s.h, 0, 0, Math.PI * 2);
      bCtx.fill();
      bCtx.restore();
    }
    vc.splatters = [];

    // Analysis mode articulation markers (spike flashes)
    for (let i = vc.articMarkers.length - 1; i >= 0; i--) {
      const mk = vc.articMarkers[i];
      mk.life -= dt;
      const a = Math.max(0, mk.life / 0.35);
      bCtx.strokeStyle = `hsla(${mk.hue}, 90%, 78%, ${a * 0.85})`;
      bCtx.lineWidth = 1.5 + mk.strength * 3;
      bCtx.beginPath();
      bCtx.moveTo(mk.x, mk.y - (6 + mk.strength * 14));
      bCtx.lineTo(mk.x, mk.y + (6 + mk.strength * 14));
      bCtx.stroke();
      if (mk.life <= 0) vc.articMarkers.splice(i, 1);
    }

    // Animate drips
    for (let i = vc.drips.length - 1; i >= 0; i--) {
      const d = vc.drips[i];
      const prevLen = d.length;
      d.length = Math.min(d.maxLength, d.length + d.vy * dt);
      const dAlpha = d.alpha * (1 - d.length / d.maxLength);
      bCtx.strokeStyle = `hsla(${d.hue}, ${d.sat}%, ${d.lit}%, ${dAlpha})`;
      bCtx.lineWidth = d.width * (1 - d.length / d.maxLength * 0.6); // taper
      bCtx.lineCap = 'round';
      bCtx.beginPath();
      bCtx.moveTo(d.x, d.y + prevLen);
      bCtx.lineTo(d.x, d.y + d.length);
      bCtx.stroke();
      if (d.length >= d.maxLength) vc.drips.splice(i, 1);
    }

    // Ambient motes — tiny paint particles floating in viewport
    const maxMotes = this.voiceCanvasVisualStyle === 'analysis' ? 6 : (this.reducedMotion ? 8 : 25);
    if (this.voiceCanvasVisualStyle === 'artistic' && vc.motes.length < maxMotes && Math.random() < (vc.isSpeaking ? 2 : 0.3) * dt * this.particleScale) {
      vc.motes.push({
        x: vc.cursorX + (Math.random() - 0.5) * this.width * 0.8,
        y: Math.random() * (bH || this.height),
        vx: (Math.random() - 0.5) * 8,
        vy: -2 - Math.random() * 6,
        size: 0.8 + Math.random() * 2,
        life: 1,
        maxLife: 3 + Math.random() * 4,
        hue: vc.strokeHue + (Math.random() - 0.5) * 60,
      });
    }
    for (let i = vc.motes.length - 1; i >= 0; i--) {
      const mo = vc.motes[i];
      mo.x += mo.vx * dt;
      mo.y += mo.vy * dt;
      mo.vx += (Math.random() - 0.5) * 10 * dt;
      mo.life -= dt / mo.maxLife;
      if (mo.life <= 0) vc.motes.splice(i, 1);
    }
  }

  // ============================================================
  // VOICE CANVAS — Draw (render buffer to screen)
  // ============================================================
  drawVoiceCanvasScene(prosodyGlow) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (!w || !h) return;

    const vc = this.voiceCanvas;
    const ps = this.prosodyScore;
    const paintAlpha = Math.max(0.06, 1 - this.canvasModeTransition * 0.94);

    // ---- Background — very dark canvas surface ----
    ctx.fillStyle = '#0a0a10';
    ctx.fillRect(0, 0, w, h);

    // Subtle vignette
    const vig = ctx.createRadialGradient(w * 0.5, h * 0.5, w * 0.2, w * 0.5, h * 0.5, w * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    // Canvas frame inset
    const margin = 20;
    const frameR = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(margin, margin, w - margin * 2, h - margin * 2, frameR);
    ctx.stroke();

    // Inner canvas area — slightly lighter background
    const innerGrad = ctx.createLinearGradient(0, margin, 0, h - margin);
    innerGrad.addColorStop(0, 'rgba(255,255,255,0.008)');
    innerGrad.addColorStop(0.5, 'rgba(255,255,255,0.003)');
    innerGrad.addColorStop(1, 'rgba(255,255,255,0.006)');
    ctx.fillStyle = innerGrad;
    ctx.beginPath();
    ctx.roundRect(margin, margin, w - margin * 2, h - margin * 2, frameR);
    ctx.fill();

    // Horizontal grid lines with configurable contrast
    const gridAlpha = this.pitchGridStrength === 'strong' ? 0.08 : 0.03;
    ctx.strokeStyle = `rgba(255,255,255,${gridAlpha})`;
    ctx.lineWidth = this.pitchGridStrength === 'strong' ? 0.8 : 0.5;
    for (let y = margin + 30; y < h - margin - 10; y += 35) {
      ctx.beginPath();
      ctx.moveTo(margin + 5, y);
      ctx.lineTo(w - margin - 5, y);
      ctx.stroke();
    }

    // Pitch range guides + optional labels
    ctx.setLineDash([3, 7]);
    ctx.strokeStyle = this.pitchGridStrength === 'strong' ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.9;
    ctx.font = '500 10px "Space Mono", monospace';
    ctx.fillStyle = this.pitchGridStrength === 'strong' ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.48)';
    ctx.textAlign = 'left';
    const guides = [100, 150, 200, 250, 300].map((hz) => ({
      hz,
      norm: Math.max(0, Math.min(1, (hz - 80) / (300 - 80))),
    }));
    for (const guide of guides) {
      const gy = 40 + (1 - guide.norm) * (h - 80);
      ctx.beginPath();
      ctx.moveTo(margin + 5, gy);
      ctx.lineTo(w - margin - 5, gy);
      ctx.stroke();
      if (this.pitchGuideLabelMode !== 'off') {
        const label = this.pitchGuideLabelMode === 'notes'
          ? `${this._pitchHzToNoteLabel(guide.hz)} (${guide.hz}Hz)`
          : `${guide.hz}Hz`;
        ctx.fillText(label, margin + 10, gy - 4);
      }
    }
    ctx.setLineDash([]);

    // ---- Smooth viewport camera ----
    let viewX = 0;
    if (this.canvasMode === 'freepaint') {
      vc.smoothViewX = 0;
    } else {
      const targetViewX = Math.max(0, vc.cursorX - w * 0.7 + margin);
      vc.smoothViewX += (targetViewX - vc.smoothViewX) * (this.isRunning ? 4 : 1) * (1 / 60);
      viewX = Math.max(0, vc.smoothViewX);
    }

    // ---- Render offscreen buffer to screen ----
    if (this.canvasMode === 'keyboard') {
      this.drawVoiceKeyboardOverlay(prosodyGlow);
    }


    if (vc.buffer && vc.bufferH > 0) {
      ctx.save();
      ctx.globalAlpha = paintAlpha;
      ctx.beginPath();
      ctx.roundRect(margin + 1, margin + 1, w - margin * 2 - 2, h - margin * 2 - 2, frameR - 1);
      ctx.clip();

      ctx.drawImage(
        vc.buffer,
        viewX, 0, w - margin * 2, vc.bufferH,
        margin, 0, w - margin * 2, h
      );

      // Idle demo strokes
      if (!this.isRunning) {
        const t = vc.time;
        for (const wave of vc.idleWaves) {
          const hue = wave.hue + Math.sin(t * 0.3 + wave.phase) * 25;
          // Glow layer
          ctx.strokeStyle = `hsla(${hue}, 40%, 45%, 0.08)`;
          ctx.lineWidth = wave.width * 3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (let x = margin; x <= w - margin; x += 3) {
            const nx = (x - margin) / (w - margin * 2);
            const y = (wave.yOff + wave.amp * Math.sin(nx * Math.PI * 3 * wave.freq + t * wave.speed + wave.phase)
              + 0.02 * Math.sin(nx * 25 + t * 2.5 + wave.phase)) * h;
            if (x === margin) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          // Core stroke
          ctx.strokeStyle = `hsla(${hue}, 55%, 55%, 0.18)`;
          ctx.lineWidth = wave.width;
          ctx.beginPath();
          for (let x = margin; x <= w - margin; x += 3) {
            const nx = (x - margin) / (w - margin * 2);
            const y = (wave.yOff + wave.amp * Math.sin(nx * Math.PI * 3 * wave.freq + t * wave.speed + wave.phase)
              + 0.02 * Math.sin(nx * 25 + t * 2.5 + wave.phase)) * h;
            if (x === margin) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          // Bright shimmer core
          ctx.strokeStyle = `hsla(${hue}, 30%, 85%, 0.08)`;
          ctx.lineWidth = Math.max(0.5, wave.width * 0.3);
          ctx.beginPath();
          for (let x = margin; x <= w - margin; x += 4) {
            const nx = (x - margin) / (w - margin * 2);
            const y = (wave.yOff + wave.amp * Math.sin(nx * Math.PI * 3 * wave.freq + t * wave.speed + wave.phase)
              + 0.02 * Math.sin(nx * 25 + t * 2.5 + wave.phase)) * h;
            if (x === margin) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    // ---- Ambient motes (drawn on screen, not buffer) ----
    for (const mo of vc.motes) {
      const sx = mo.x - viewX + margin;
      if (sx < margin || sx > w - margin) continue;
      const fadeEdge = Math.min(1, mo.life * 3, (1 - mo.life) * 3) * paintAlpha;
      ctx.globalAlpha = fadeEdge * 0.25;
      ctx.fillStyle = `hsl(${mo.hue}, 50%, 65%)`;
      ctx.beginPath();
      ctx.arc(sx, mo.y, mo.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fadeEdge * 0.06;
      ctx.beginPath();
      ctx.arc(sx, mo.y, mo.size * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ---- Live cursor when running ----
    if (this.isRunning && paintAlpha > 0.1) {
      ctx.save();
      ctx.globalAlpha = paintAlpha;
      const screenCursorX = vc.cursorX - viewX + margin;
      const screenCursorY = 40 + vc.smoothPitchY * (h - 80);

      // Cursor position line (within frame)
      ctx.save();
      ctx.beginPath();
      ctx.rect(margin, margin, w - margin * 2, h - margin * 2);
      ctx.clip();

      ctx.strokeStyle = `rgba(255,255,255,${vc.isSpeaking ? 0.1 : 0.03})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(screenCursorX, margin);
      ctx.lineTo(screenCursorX, h - margin);
      ctx.stroke();
      ctx.setLineDash([]);

      // Brush preview dot (always visible, brighter when speaking)
      if (vc.isSpeaking) {
        // Active brush glow
        const glowR = 18 + ps * 14 + vc.smoothEnergy * 8;
        const cursorGlow = ctx.createRadialGradient(
          screenCursorX, screenCursorY, 0,
          screenCursorX, screenCursorY, glowR
        );
        cursorGlow.addColorStop(0, `hsla(${vc.strokeHue}, ${vc.strokeSat}%, ${vc.strokeLit + 20}%, 0.55)`);
        cursorGlow.addColorStop(0.35, `hsla(${vc.strokeHue}, ${vc.strokeSat * 0.5}%, ${vc.strokeLit + 10}%, 0.15)`);
        cursorGlow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = cursorGlow;
        ctx.beginPath();
        ctx.arc(screenCursorX, screenCursorY, glowR, 0, Math.PI * 2);
        ctx.fill();

        // Brush size preview ring
        const previewR = 1.5 + vc.smoothEnergy * 14 + ps * 3;
        ctx.strokeStyle = `hsla(${vc.strokeHue}, ${vc.strokeSat}%, 80%, 0.3)`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(screenCursorX, screenCursorY, previewR * 0.5, 0, Math.PI * 2);
        ctx.stroke();

        // White center dot
        ctx.fillStyle = `rgba(255,255,255,${0.6 + ps * 0.3})`;
        ctx.beginPath();
        ctx.arc(screenCursorX, screenCursorY, 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Silent: dim cursor dot showing pitch position
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.arc(screenCursorX, screenCursorY, 3, 0, Math.PI * 2);
        ctx.fill();
        // Outer ring
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.arc(screenCursorX, screenCursorY, 8, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
      ctx.restore();
    }

    // Keyboard overlay was moved to drawing BEFORE the canvas buffer in drawVoiceCanvasScene

    // ---- HUD ----
    ctx.font = '600 13px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.textAlign = 'right';
    const pct = Math.round((vc.cursorX / vc.bufferW) * 100);
    ctx.fillText(`${pct}%`, w - margin - 2, margin - 5);
    if (vc.strokeCount > 0) {
      ctx.textAlign = 'left';
      ctx.fillText(`${vc.strokeCount} stroke${vc.strokeCount !== 1 ? 's' : ''}`, margin + 2, margin - 5);
    }
  }

  updateCanvasModeTransition(dt) {
    const target = this.canvasMode === 'keyboard' ? 1 : 0;
    this.canvasModeTransition += (target - this.canvasModeTransition) * Math.min(1, dt * 8);

    const kb = this.voiceKeyboard;
    const m = this.analyzer.metrics;
    const hz = this.analyzer.smoothPitchHz;
    const conf = this.analyzer.pitchConfidence;
    const isVoiced = this.isRunning && m.energy > 0.04 && conf > 0.18 && hz > 50;
    const midi = isVoiced ? 69 + 12 * Math.log2(hz / 440) : NaN;

    kb.glowStrength = Math.max(0, kb.glowStrength - dt * 2.2);
    kb.successPulse = Math.max(0, kb.successPulse - dt * 2.8);
    kb.missPulse = Math.max(0, kb.missPulse - dt * 2.5);

    if (isVoiced && Number.isFinite(midi)) {
      const clamped = Math.max(kb.minMidi, Math.min(kb.maxMidi, midi));
      kb.plasmaTrail.push({ midi: clamped, life: 1 });
      kb.glowKey = Math.round(clamped);
      kb.glowStrength = Math.min(1, kb.glowStrength + dt * 5 + conf * 0.03);
    }

    for (let i = kb.plasmaTrail.length - 1; i >= 0; i--) {
      kb.plasmaTrail[i].life -= dt * 3.5;
      if (kb.plasmaTrail[i].life <= 0) kb.plasmaTrail.splice(i, 1);
    }

    if (!this.isRunning || this.canvasMode !== 'keyboard') return;

    if (this.keyboardGameMode === 'target') {
      if (isVoiced && Number.isFinite(midi) && Math.abs(midi - kb.targetMidi) < 0.22) {
        kb.targetHold += dt;
        if (kb.targetHold >= 1) {
          kb.score += 1;
          kb.targetHold = 0;
          kb.targetMidi = kb.minMidi + Math.floor(Math.random() * (kb.maxMidi - kb.minMidi + 1));
          kb.successPulse = 1;
          this._playKeyboardSuccessChime();
        }
      } else {
        kb.targetHold = Math.max(0, kb.targetHold - dt * 1.6);
      }
    }

    if (this.keyboardGameMode === 'hero') {
      kb.heroTime += dt;
      kb.heroSpawn += dt;
      if (kb.heroSpawn >= 0.75) {
        kb.heroSpawn = 0;
        const midiTarget = kb.minMidi + Math.floor(Math.random() * (kb.maxMidi - kb.minMidi + 1));
        kb.heroNotes.push({ midi: midiTarget, y: 0, hit: false });
      }
      const speed = this.height * 0.24;
      for (let i = kb.heroNotes.length - 1; i >= 0; i--) {
        const n = kb.heroNotes[i];
        n.y += speed * dt;
        if (!n.hit && n.y > this.height * 0.7 + 20) {
          kb.missPulse = 1;
          kb.heroNotes.splice(i, 1);
          continue;
        }
        if (isVoiced && Number.isFinite(midi) && !n.hit && Math.abs(midi - n.midi) < 0.3 && n.y >= this.height * 0.68 && n.y <= this.height * 0.74) {
          kb.score += 10;
          kb.successPulse = 1;
          this._playKeyboardSuccessChime();
          kb.heroNotes.splice(i, 1);
        }
      }
    }
  }

  _resetKeyboardModeState() {
    const kb = this.voiceKeyboard;
    kb.score = 0;
    kb.targetHold = 0;
    kb.heroTime = 0;
    kb.heroSpawn = 0;
    kb.heroNotes = [];
    kb.successPulse = 0;
    kb.missPulse = 0;
  }

  _getKeyboardLayout(left, keyboardTop, keyboardW, keyboardH) {
    const kb = this.voiceKeyboard;
    const isBlack = new Set([1, 3, 6, 8, 10]);
    const whiteKeys = [];
    const blackKeys = [];

    let whiteCount = 0;
    for (let midi = kb.minMidi; midi <= kb.maxMidi; midi++) {
      if (!isBlack.has(((midi % 12) + 12) % 12)) whiteCount++;
    }
    const whiteW = keyboardW / Math.max(1, whiteCount);
    const whiteH = keyboardH * 0.85;
    const blackW = whiteW * 0.62;
    const blackH = whiteH * 0.6;

    let wi = 0;
    const whiteIndexByMidi = new Map();
    for (let midi = kb.minMidi; midi <= kb.maxMidi; midi++) {
      const semi = ((midi % 12) + 12) % 12;
      if (!isBlack.has(semi)) {
        const x = left + wi * whiteW;
        whiteKeys.push({ midi, x, y: keyboardTop + keyboardH - whiteH, w: whiteW, h: whiteH });
        whiteIndexByMidi.set(midi, wi);
        wi++;
      }
    }

    for (let midi = kb.minMidi; midi <= kb.maxMidi; midi++) {
      const semi = ((midi % 12) + 12) % 12;
      if (!isBlack.has(semi)) continue;
      const leftWhite = midi - 1;
      const idx = whiteIndexByMidi.get(leftWhite);
      if (idx === undefined) continue;
      const x = left + (idx + 1) * whiteW;
      blackKeys.push({ midi, x, y: keyboardTop + keyboardH - whiteH - 4, w: blackW, h: blackH });
    }

    const keyCenterByMidi = new Map();
    for (const k of whiteKeys) keyCenterByMidi.set(k.midi, k.x + k.w * 0.5);
    for (const k of blackKeys) keyCenterByMidi.set(k.midi, k.x);

    return { whiteKeys, blackKeys, whiteW, whiteH, blackW, blackH, keyCenterByMidi };
  }

  _midiToX(midi, layout, fallbackLeft, fallbackWidth) {
    const center = layout?.keyCenterByMidi?.get(Math.round(midi));
    if (Number.isFinite(center)) return center;
    const kb = this.voiceKeyboard;
    const t = (midi - kb.minMidi) / (kb.maxMidi - kb.minMidi);
    return fallbackLeft + Math.max(0, Math.min(1, t)) * fallbackWidth;
  }

  _playKeyboardSuccessChime() {
    try {
      const ctx = this.analyzer?.audioCtx;
      if (!ctx) return;
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.05, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      gain.connect(ctx.destination);

      const oscA = ctx.createOscillator();
      oscA.type = 'sine';
      oscA.frequency.setValueAtTime(660, now);
      oscA.frequency.exponentialRampToValueAtTime(880, now + 0.12);
      oscA.connect(gain);
      oscA.start(now);
      oscA.stop(now + 0.18);

      const oscB = ctx.createOscillator();
      oscB.type = 'triangle';
      oscB.frequency.setValueAtTime(990, now + 0.03);
      oscB.connect(gain);
      oscB.start(now + 0.03);
      oscB.stop(now + 0.2);
    } catch (e) { }
  }

  drawVoiceKeyboardOverlay() {
    const t = this.canvasModeTransition;
    if (t < 0.01) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const kb = this.voiceKeyboard;
    const energy = this.analyzer.metrics.energy || 0;
    const hz = this.analyzer.smoothPitchHz;
    const conf = this.analyzer.pitchConfidence;
    const voiced = this.isRunning && hz > 50 && conf > 0.18 && energy > 0.04;
    const currentMidi = voiced ? Math.max(kb.minMidi, Math.min(kb.maxMidi, 69 + 12 * Math.log2(hz / 440))) : NaN;

    const keyboardTop = h * 0.52 + (1 - t) * (h * 0.2);
    const keyboardH = h * 0.38;
    const keyboardW = w * 0.92;
    const left = (w - keyboardW) * 0.5;

    ctx.save();
    ctx.globalAlpha = t;

    const panel = ctx.createLinearGradient(0, keyboardTop, 0, keyboardTop + keyboardH);
    panel.addColorStop(0, 'rgba(8,12,26,0.8)');
    panel.addColorStop(1, 'rgba(4,8,18,0.95)');
    ctx.fillStyle = panel;
    ctx.beginPath();
    ctx.roundRect(left - 10, keyboardTop - 18, keyboardW + 20, keyboardH + 32, 16);
    ctx.fill();

    if (kb.successPulse > 0.01) {
      ctx.fillStyle = `rgba(120,255,170,${0.16 * kb.successPulse})`;
      ctx.beginPath();
      ctx.roundRect(left - 6, keyboardTop - 14, keyboardW + 12, keyboardH + 24, 14);
      ctx.fill();
    }
    if (kb.missPulse > 0.01) {
      ctx.fillStyle = `rgba(255,90,120,${0.12 * kb.missPulse})`;
      ctx.beginPath();
      ctx.roundRect(left - 6, keyboardTop - 14, keyboardW + 12, keyboardH + 24, 14);
      ctx.fill();
    }

    const layout = this._getKeyboardLayout(left, keyboardTop, keyboardW, keyboardH);
    const { whiteKeys, blackKeys, whiteW, whiteH } = layout;

    for (const key of whiteKeys) {
      const { midi, x, y } = key;
      const active = kb.glowKey === midi && kb.glowStrength > 0.05;
      ctx.fillStyle = 'rgba(170,220,255,0.06)';
      ctx.strokeStyle = active
        ? `hsla(${this.colorblindMode ? 190 : 72}, 90%, 62%, ${0.55 + kb.glowStrength * 0.4})`
        : 'rgba(120,210,255,0.42)';
      ctx.lineWidth = active ? 2.3 : 1.2;
      ctx.beginPath();
      ctx.roundRect(x + 2, y + 2, key.w - 4, key.h - 4, 8);
      ctx.fill();
      ctx.stroke();

      // Labels for white keys
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const noteName = names[midi % 12];
      const octave = Math.floor(midi / 12) - 1;
      const isC = midi % 12 === 0;

      ctx.fillStyle = isC ? 'rgba(135,235,255,0.95)' : 'rgba(120,210,255,0.7)';
      ctx.font = isC ? '700 12px "Space Mono", monospace' : '500 11px "Space Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${noteName}${octave}`, x + key.w * 0.5, y + key.h - 14);
    }

    for (const key of blackKeys) {
      const { midi, x, y } = key;
      const active = kb.glowKey === midi && kb.glowStrength > 0.05;
      ctx.fillStyle = 'rgba(84,38,130,0.2)';
      ctx.strokeStyle = active
        ? `hsla(${this.colorblindMode ? 190 : 72}, 90%, 60%, ${0.6 + kb.glowStrength * 0.35})`
        : 'rgba(180,120,255,0.5)';
      ctx.lineWidth = active ? 2.1 : 1.1;
      ctx.beginPath();
      ctx.roundRect(x - key.w * 0.5, y, key.w, key.h, 7);
      ctx.fill();
      ctx.stroke();

      // Labels for black keys (small labels at the top of the key)
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const noteName = names[midi % 12];
      const octave = Math.floor(midi / 12) - 1;
      ctx.fillStyle = 'rgba(180,120,255,0.85)';
      ctx.font = '700 9px "Space Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${noteName}${octave}`, x, y + 16);
    }

    if (this.keyboardGameMode === 'target') {
      const x = this._midiToX(kb.targetMidi, layout, left, keyboardW);
      ctx.strokeStyle = 'rgba(255,75,75,0.9)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.roundRect(x - whiteW * 0.45, keyboardTop + keyboardH - whiteH + 2, whiteW * 0.9, whiteH - 6, 8);
      ctx.stroke();
      if (kb.targetHold > 0) {
        const p = Math.min(1, kb.targetHold);
        ctx.fillStyle = 'rgba(120,255,160,0.85)';
        ctx.fillRect(left, keyboardTop - 3, keyboardW * p, 2);
      }
    }

    if (this.keyboardGameMode === 'hero') {
      const hitLineY = h * 0.72;
      ctx.strokeStyle = 'rgba(135,235,255,0.38)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(left, hitLineY);
      ctx.lineTo(left + keyboardW, hitLineY);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const n of kb.heroNotes) {
        const nx = this._midiToX(n.midi, layout, left, keyboardW);
        const ny = Math.min(hitLineY, keyboardTop - 16 + n.y);
        const barH = 34;
        const grad = ctx.createLinearGradient(0, ny - barH, 0, ny);
        grad.addColorStop(0, 'rgba(102,225,255,0.88)');
        grad.addColorStop(1, 'rgba(102,225,255,0.18)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(nx - whiteW * 0.34, ny - barH, whiteW * 0.68, barH, 6);
        ctx.fill();
      }
    }

    for (const trail of kb.plasmaTrail) {
      const x = this._midiToX(trail.midi, layout, left, keyboardW);
      const y = keyboardTop - 12;
      const r = 12 * trail.life;
      ctx.fillStyle = `hsla(${this.colorblindMode ? 190 : 72}, 90%, 60%, ${0.18 * trail.life})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (Number.isFinite(currentMidi)) {
      const px = this._midiToX(currentMidi, layout, left, keyboardW);
      const py = keyboardTop - 12;
      const core = ctx.createRadialGradient(px, py, 0, px, py, 30);
      core.addColorStop(0, 'rgba(255,255,200,0.95)');
      core.addColorStop(0.35, this.colorblindMode ? 'rgba(100,240,255,0.88)' : 'rgba(190,255,90,0.88)');
      core.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(px, py, 30, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.font = '600 12px "Space Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(196,220,255,0.85)';
    const modeLabel = this.keyboardGameMode === 'mirror' ? 'Mirror Mode' : this.keyboardGameMode === 'target' ? 'Target Practice' : 'Vocal Hero';
    ctx.fillText(modeLabel, left, keyboardTop + keyboardH + 20);
    if (this.keyboardGameMode !== 'mirror') {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(190,240,255,0.9)';
      ctx.fillText(`Score ${kb.score}`, left + keyboardW, keyboardTop + keyboardH + 20);
    }

    ctx.restore();
  }

  _handleKeyboardPointer(e) {
    if (this.gameMode !== 'keyboard' && !(this.gameMode === 'canvas' && this.canvasMode === 'keyboard')) return;
    if (e.type === 'pointermove' && !this.activePointerNotes.has(e.pointerId)) return;

    const rect = this.canvas.getBoundingClientRect();
    const rx = (e.clientX - rect.left) * (this.width / rect.width);
    const ry = (e.clientY - rect.top) * (this.height / rect.height);

    const t = this.canvasModeTransition;
    const keyboardTop = this.height * 0.52 + (1 - t) * (this.height * 0.2);
    const keyboardH = this.height * 0.38;
    const keyboardW = this.width * 0.92;
    const left = (this.width - keyboardW) * 0.5;

    const layout = this._getKeyboardLayout(left, keyboardTop, keyboardW, keyboardH);

    let hitKey = null;
    // Check black keys first (they are on top)
    for (const k of layout.blackKeys) {
      if (rx >= k.x - k.w * 0.5 && rx <= k.x + k.w * 0.5 && ry >= k.y && ry <= k.y + k.h) {
        hitKey = k;
        break;
      }
    }
    if (!hitKey) {
      for (const k of layout.whiteKeys) {
        if (rx >= k.x && rx <= k.x + k.w && ry >= k.y && ry <= k.y + k.h) {
          hitKey = k;
          break;
        }
      }
    }

    const current = this.activePointerNotes.get(e.pointerId);
    if (hitKey) {
      if (current && current.midi === hitKey.midi) {
        return;
      }
      if (current) this._stopPointerNote(e.pointerId);

      const midi = hitKey.midi;
      const hz = 440 * Math.pow(2, (midi - 69) / 12);

      try {
        const audioCtx = this.analyzer.audioCtx;
        if (!audioCtx) return;

        const now = audioCtx.currentTime;
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
        gain.connect(audioCtx.destination);

        const osc = audioCtx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(hz, now);
        osc.connect(gain);
        osc.start(now);

        this.activePointerNotes.set(e.pointerId, { midi, osc, gain });

        this.voiceKeyboard.glowKey = midi;
        this.voiceKeyboard.glowStrength = 1.0;

      } catch (err) { console.error("Synthesis failed", err); }
    } else {
      if (current) this._stopPointerNote(e.pointerId);
    }
  }

  _stopPointerNote(pointerId) {
    const note = this.activePointerNotes.get(pointerId);
    if (!note) return;

    try {
      const audioCtx = this.analyzer.audioCtx;
      const now = audioCtx?.currentTime || 0;
      note.gain.gain.cancelScheduledValues(now);
      note.gain.gain.setValueAtTime(note.gain.gain.value, now);
      note.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
      note.osc.stop(now + 0.15);
    } catch (e) { }

    this.activePointerNotes.delete(pointerId);
    if (this.activePointerNotes.size === 0) {
      this.voiceKeyboard.glowKey = -1;
    }
  }


  _resetPitchPilotState() {
    const pp = this.pitchPilot;
    pp.sparkX = this.width * 0.24;
    pp.sparkY = this.height * 0.5;
    pp.sparkTargetY = pp.sparkY;
    pp.sparkGlow = 0.4;
    pp.trail = [];
    pp.barriers = [];
    pp.score = 0;
    pp.spawnTimer = 0;
    pp.speed = 165;
    pp.phase = 'warmup';
    pp.calibrated = false;
    pp.calibrationTimer = 0;
    pp.observedMinHz = Infinity;
    pp.observedMaxHz = 0;
    pp.lowHz = 120;
    pp.highHz = 420;
    pp.gameOver = false;
    pp.ending = false;
    pp.crashTimer = 0;
    pp.selectedRangeLabel = 'Auto (Glide Calibration)';
    pp.awaitingRestartChoice = false;
  }

  _resetVowelValleyState() {
    const s = this.vowelValley;
    s.x = s.smoothX = 0.5;
    s.y = s.smoothY = 0.5;
    s.score = 0;
    s.flowMultiplier = 1;
    s.flowTimer = 0;
    s.lastTargetHit = null;
    s.particles = [];
    s.trail = [];
    s.popups = [];
    for (const t of s.targets) t.charge = 0;
  }

  _pilotNoteForY(y) {
    const pp = this.pitchPilot;
    const top = this.height * 0.10;
    const bottom = this.height * 0.92;
    const ratio = Math.max(0, Math.min(1, 1 - (y - top) / Math.max(1, bottom - top)));
    const hz = pp.lowHz * Math.pow(pp.highHz / Math.max(pp.lowHz, 1), ratio);
    return this._pitchHzToNoteLabel(hz);
  }

  _pilotSpawnBarrier() {
    const pp = this.pitchPilot;
    const w = this.width;
    const h = this.height;
    const phaseIndex = pp.phase === 'warmup' ? 0 : pp.phase === 'steps' ? 1 : 2;
    const gap = phaseIndex === 0 ? h * 0.28 : phaseIndex === 1 ? h * 0.21 : h * 0.17;
    const midBase = h * 0.52;
    const swing = phaseIndex === 0 ? h * 0.09 : phaseIndex === 1 ? h * 0.2 : h * 0.26;
    const t = pp.score + pp.barriers.length * 0.7;
    let center = midBase + Math.sin(t * 0.9) * swing;
    if (phaseIndex === 1) {
      center += (Math.sin(t * 1.9) > 0 ? 1 : -1) * h * 0.08;
    }
    if (phaseIndex === 2) {
      center += Math.sin((pp.score + pp.barriers.length) * 1.8) * h * 0.1;
    }
    const pad = h * 0.16 + gap * 0.5;
    center = Math.max(pad, Math.min(h - pad, center));
    pp.barriers.push({ x: w + 90, width: 70, gapCenter: center, gapSize: gap, passed: false });
  }

  _drawCrystalCluster(x, y, width, height, upward = true) {
    const ctx = this.ctx;
    const cols = 8;
    for (let i = 0; i < cols; i++) {
      const frac = i / (cols - 1);
      const cx = x + frac * width;
      const spikeH = height * (0.5 + 0.5 * Math.sin(frac * Math.PI * 2 + x * 0.01));
      const dir = upward ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx - width * 0.065, y);
      ctx.lineTo(cx, y + dir * spikeH);
      ctx.lineTo(cx + width * 0.065, y);
      ctx.closePath();
      const grad = ctx.createLinearGradient(cx, y, cx, y + dir * spikeH);
      grad.addColorStop(0, 'rgba(98,132,180,0.55)');
      grad.addColorStop(1, 'rgba(24,28,52,0.8)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(170,220,255,0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }


  _applyPitchPilotRangeChoice(choice, fallbackRange = null) {
    const pp = this.pitchPilot;
    if (!choice) return;

    if (choice.type === 'same' && fallbackRange) {
      pp.lowHz = fallbackRange.lowHz;
      pp.highHz = fallbackRange.highHz;
      pp.calibrated = true;
      pp.selectedRangeLabel = `Same Range (${this._pitchHzToNoteLabel(pp.lowHz)}→${this._pitchHzToNoteLabel(pp.highHz)})`;
      return;
    }

    if (choice.type === 'auto') {
      pp.calibrated = false;
      pp.calibrationTimer = 0;
      pp.observedMinHz = Infinity;
      pp.observedMaxHz = 0;
      pp.selectedRangeLabel = 'Auto (Glide Calibration)';
      return;
    }

    if (choice.type === 'preset' && Number.isFinite(choice.lowHz) && Number.isFinite(choice.highHz)) {
      pp.lowHz = choice.lowHz;
      pp.highHz = Math.max(choice.lowHz + 60, choice.highHz);
      pp.calibrated = true;
      pp.selectedRangeLabel = `${choice.label} (${this._pitchHzToNoteLabel(pp.lowHz)}→${this._pitchHzToNoteLabel(pp.highHz)})`;
    }
  }

  async _offerPitchPilotRange(options = {}) {
    const { allowContinueSame = false } = options;
    const overlay = document.getElementById('pilotRangeOverlay');
    const title = document.getElementById('pilotRangeTitle');
    const desc = document.getElementById('pilotRangeDesc');
    const continueBtn = document.getElementById('pilotContinueBtn');

    if (!overlay) {
      return allowContinueSame ? { type: 'same' } : { type: 'auto' };
    }

    if (allowContinueSame) {
      title.textContent = 'Discord Collision';
      desc.textContent = 'Pitch Pilot crashed. Choose a range for the next run, or continue same range.';
      continueBtn.style.display = 'block';
    } else {
      title.textContent = 'Pitch Pilot Range';
      desc.textContent = 'Choose a pitch range before starting:';
      continueBtn.style.display = 'none';
    }

    overlay.classList.add('show');

    return new Promise((resolve) => {
      const handleClick = (e) => {
        const btn = e.target.closest('.range-btn');
        if (!btn) return;

        overlay.classList.remove('show');
        overlay.removeEventListener('click', handleClick);

        const type = btn.dataset.type;
        if (type === 'auto') {
          resolve({ type: 'auto' });
        } else if (type === 'same') {
          resolve({ type: 'same' });
        } else if (type === 'preset') {
          resolve({
            type: 'preset',
            label: btn.textContent.split('(')[0].trim().replace('✨ ', ''),
            lowHz: parseFloat(btn.dataset.low),
            highHz: parseFloat(btn.dataset.high)
          });
        }
      };
      overlay.addEventListener('click', handleClick);
    });
  }

  _handlePitchPilotLossChoice() {
    const pp = this.pitchPilot;
    if (!this.isRunning || this.gameMode !== 'pilot' || !pp.gameOver || pp.awaitingRestartChoice) return;

    pp.awaitingRestartChoice = true;
    const previousRange = { lowHz: pp.lowHz, highHz: pp.highHz, label: pp.selectedRangeLabel };

    setTimeout(async () => {
      if (!this.isRunning || this.gameMode !== 'pilot') {
        pp.awaitingRestartChoice = false;
        return;
      }
      const choice = await this._offerPitchPilotRange({ allowContinueSame: true });
      this._resetPitchPilotState();
      this._applyPitchPilotRangeChoice(choice, previousRange);
    }, 20);
  }

  updatePitchPilot(dt) {
    const pp = this.pitchPilot;
    if (!pp.sparkX) this._resetPitchPilotState();

    pp.sparkX = this.width * 0.24;

    if (!this.isRunning) {
      pp.spawnTimer += dt;
      if (pp.spawnTimer > 1.25) {
        pp.spawnTimer = 0;
        this._pilotSpawnBarrier();
      }
      for (const b of pp.barriers) b.x -= pp.speed * dt * 0.5;
      pp.barriers = pp.barriers.filter(b => b.x + b.width > -120);
      pp.sparkTargetY = this.height * (0.5 + Math.sin(performance.now() * 0.0018) * 0.12);
      pp.sparkY += (pp.sparkTargetY - pp.sparkY) * Math.min(1, dt * 4);
      pp.trail.push({ x: pp.sparkX, y: pp.sparkY, life: 0.6 });
      for (let i = pp.trail.length - 1; i >= 0; i--) {
        pp.trail[i].life -= dt;
        if (pp.trail[i].life <= 0) pp.trail.splice(i, 1);
      }
      return;
    }

    if (pp.gameOver) {
      pp.crashTimer += dt;
      pp.sparkGlow = Math.max(0, pp.sparkGlow - dt * 2.2);
      return;
    }

    const m = this.analyzer.metrics;
    const hz = this.analyzer.smoothPitchHz;
    const voiced = m.energy > 0.035 && this.analyzer.pitchConfidence > 0.15 && hz > 55;

    if (!pp.calibrated) {
      pp.calibrationTimer += dt;
      if (voiced) {
        pp.observedMinHz = Math.min(pp.observedMinHz, hz);
        pp.observedMaxHz = Math.max(pp.observedMaxHz, hz);
      }
      if (pp.calibrationTimer >= pp.calibrationDuration) {
        const minHz = Number.isFinite(pp.observedMinHz) ? pp.observedMinHz : 120;
        const maxHz = Number.isFinite(pp.observedMaxHz) ? pp.observedMaxHz : 400;
        pp.lowHz = Math.max(70, Math.min(minHz, maxHz * 0.82));
        pp.highHz = Math.max(pp.lowHz + 80, maxHz * 1.05);
        pp.calibrated = true;
      }
      return;
    }

    const top = this.height * 0.10;
    const bottom = this.height * 0.92;
    if (voiced) {
      const t = Math.log(hz / pp.lowHz) / Math.log(pp.highHz / pp.lowHz);
      const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
      pp.sparkTargetY = bottom - clamped * (bottom - top);
      pp.sparkGlow = Math.min(1, pp.sparkGlow + dt * 1.8 + m.energy * 0.4);
    } else {
      pp.sparkTargetY += dt * 140;
      pp.sparkGlow = Math.max(0.22, pp.sparkGlow - dt * 1.2);
    }
    pp.sparkTargetY = Math.max(top, Math.min(bottom, pp.sparkTargetY));
    pp.sparkY += (pp.sparkTargetY - pp.sparkY) * Math.min(1, dt * 9);

    pp.spawnTimer += dt;
    const spacing = pp.phase === 'warmup' ? 1.9 : pp.phase === 'steps' ? 1.5 : 1.2;
    if (pp.spawnTimer >= spacing) {
      pp.spawnTimer = 0;
      this._pilotSpawnBarrier();
    }

    const speedBoost = pp.phase === 'warmup' ? 0 : pp.phase === 'steps' ? 35 : 70;
    const speed = pp.speed + speedBoost;
    for (const b of pp.barriers) {
      b.x -= speed * dt;
      const gapTop = b.gapCenter - b.gapSize * 0.5;
      const gapBottom = b.gapCenter + b.gapSize * 0.5;
      const inX = pp.sparkX + pp.sparkRadius > b.x && pp.sparkX - pp.sparkRadius < b.x + b.width;
      if (inX && (pp.sparkY - pp.sparkRadius < gapTop || pp.sparkY + pp.sparkRadius > gapBottom)) {
        pp.gameOver = true;
        this._handlePitchPilotLossChoice();
        break;
      }
      if (!b.passed && b.x + b.width < pp.sparkX - pp.sparkRadius) {
        b.passed = true;
        pp.score += 1;
      }
    }
    pp.barriers = pp.barriers.filter(b => b.x + b.width > -120);

    if (pp.score >= 16) pp.phase = 'slalom';
    else if (pp.score >= 7) pp.phase = 'steps';

    pp.trail.push({ x: pp.sparkX, y: pp.sparkY, life: 0.75 });
    for (let i = pp.trail.length - 1; i >= 0; i--) {
      pp.trail[i].life -= dt;
      if (pp.trail[i].life <= 0) pp.trail.splice(i, 1);
    }
  }

  drawPitchPilotScene() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const pp = this.pitchPilot;

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#060912');
    bg.addColorStop(0.5, '#0a1225');
    bg.addColorStop(1, '#05070f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const gridAlpha = this.reducedMotion ? 0.06 : 0.11;
    ctx.strokeStyle = `rgba(120,190,255,${gridAlpha})`;
    ctx.lineWidth = 1;
    for (let y = h * 0.12; y < h; y += 36) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    for (let x = (-performance.now() * 0.04) % 40; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, h * 0.08);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    for (const b of pp.barriers) {
      const gapTop = b.gapCenter - b.gapSize * 0.5;
      const gapBottom = b.gapCenter + b.gapSize * 0.5;

      this._drawCrystalCluster(b.x, 0, b.width, gapTop, true);
      this._drawCrystalCluster(b.x, h, b.width, h - gapBottom, false);

      const safe = ctx.createLinearGradient(b.x, gapTop, b.x, gapBottom);
      safe.addColorStop(0, 'rgba(130,235,255,0.06)');
      safe.addColorStop(0.5, 'rgba(176,255,160,0.22)');
      safe.addColorStop(1, 'rgba(130,235,255,0.06)');
      ctx.fillStyle = safe;
      ctx.fillRect(b.x, gapTop, b.width, b.gapSize);

      const noteY = b.gapCenter;
      ctx.strokeStyle = 'rgba(190,235,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(b.x + 4, noteY);
      ctx.lineTo(b.x + b.width - 4, noteY);
      ctx.stroke();

      ctx.font = '500 12px "Space Mono", monospace';
      ctx.fillStyle = 'rgba(220,240,255,0.78)';
      ctx.textAlign = 'center';
      ctx.fillText(this._pilotNoteForY(noteY), b.x + b.width * 0.5, noteY - 8);
    }

    for (const t of pp.trail) {
      const alpha = Math.max(0, t.life) * 0.45;
      const r = pp.sparkRadius * (0.35 + t.life * 0.9);
      ctx.fillStyle = this.colorblindMode
        ? `rgba(90,235,255,${alpha})`
        : `rgba(205,255,110,${alpha})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const coreHue = this.colorblindMode ? 190 : 72;
    const orb = ctx.createRadialGradient(pp.sparkX, pp.sparkY, 1, pp.sparkX, pp.sparkY, 52);
    orb.addColorStop(0, 'rgba(255,255,220,0.98)');
    orb.addColorStop(0.25, `hsla(${coreHue}, 95%, 64%, ${0.65 + pp.sparkGlow * 0.25})`);
    orb.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = orb;
    ctx.beginPath();
    ctx.arc(pp.sparkX, pp.sparkY, 52, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,245,190,0.95)';
    ctx.beginPath();
    ctx.arc(pp.sparkX, pp.sparkY, pp.sparkRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(pp.sparkX - 4, pp.sparkY - 5, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '600 28px "Space Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(235,245,255,0.92)';
    ctx.fillText('RESONANCE CAVERN', 22, 42);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(245,250,255,0.96)';
    ctx.fillText(`SCORE: ${pp.score}`, w - 24, 42);

    ctx.font = '600 13px "Space Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(190,225,255,0.85)';
    if (!pp.calibrated && this.isRunning) {
      const remaining = Math.max(0, pp.calibrationDuration - pp.calibrationTimer);
      ctx.fillText('Calibration: sing low, then glide to your highest comfortable note', 24, h - 24);
      ctx.textAlign = 'right';
      ctx.fillText(`${remaining.toFixed(1)}s`, w - 24, h - 24);
    } else {
      const phaseLabel = pp.phase === 'warmup' ? 'Warm-up' : pp.phase === 'steps' ? 'Steps' : 'Slalom';
      ctx.fillText(`Phase: ${phaseLabel}`, 24, h - 24);
      ctx.fillText(`Range: ${pp.selectedRangeLabel}`, 24, h - 44);
      ctx.textAlign = 'right';
      ctx.fillText(`Range ${this._pitchHzToNoteLabel(pp.lowHz)} → ${this._pitchHzToNoteLabel(pp.highHz)}`, w - 24, h - 24);
    }

    if (pp.gameOver) {
      ctx.fillStyle = 'rgba(6,8,18,0.72)';
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = 'center';
      ctx.font = '700 40px "Space Mono", monospace';
      ctx.fillStyle = 'rgba(255,180,200,0.95)';
      ctx.fillText('DISCORD COLLISION', w * 0.5, h * 0.45);
      ctx.font = '600 18px "Space Mono", monospace';
      ctx.fillStyle = 'rgba(220,235,255,0.92)';
      ctx.fillText('Choose a new range or continue same to retry.', w * 0.5, h * 0.52);
    }
  }

  _getResonanceRoadPassageText() {
    const presets = {
      balcony: 'But soft! What light through yonder window breaks? It is the east, and Juliet is the sun. Arise, fair sun, and kill the envious moon.',
      news: "Good evening. In today's update, city leaders announced a major transit expansion focused on safer streets and faster commutes for local residents.",
    };
    if (this.resonanceRoad.passageMode === 'custom') {
      return this.resonanceRoad.customText || presets.balcony;
    }
    return presets[this.resonanceRoad.passageMode] || presets.balcony;
  }

  _resetResonanceRoadState() {
    const rr = this.resonanceRoad;
    rr.centerX = this.width * 0.5;
    rr.laneHalfWidth = this.width * 0.09;
    rr.roadHalfWidth = this.width * 0.22;
    rr.speed = 0;
    rr.score = 0;
    rr.multiplier = 1;
    rr.driftStrength = 0;
    rr.trail = [];
  }

  updateResonanceRoad(dt) {
    const rr = this.resonanceRoad;
    const m = this.analyzer.metrics;
    const targetRes = rr.targetTone === 'bright' ? 0.72 : 0.28;
    const diff = this.analyzer.smoothResonance - targetRes;

    // Keep the rider centered when the user is reasonably close to the selected tone.
    // This avoids constant side-drift from tiny resonance fluctuations.
    const deadZone = 0.12;
    const outsideDeadZone = Math.max(0, Math.abs(diff) - deadZone);
    const normalizedDrift = outsideDeadZone / Math.max(0.0001, 1 - deadZone);
    const drift = Math.sign(diff) * Math.min(1, normalizedDrift * 2.1);
    rr.driftStrength = drift;

    const speaking = m.energy > 0.028;
    const targetSpeed = speaking ? 70 + m.energy * 360 : 12;
    rr.speed += (targetSpeed - rr.speed) * Math.min(1, dt * 3.8);

    const steerPower = 260;
    rr.centerX += drift * steerPower * dt;

    // Gentle re-centering to keep the motorcycle on the lane when tone is on target.
    const centerPull = 4.2;
    rr.centerX += (this.width * 0.5 - rr.centerX) * Math.min(1, dt * centerPull);
    const pad = rr.roadHalfWidth * 0.5;
    rr.centerX = Math.max(pad, Math.min(this.width - pad, rr.centerX));

    const onRoad = Math.abs(rr.centerX - this.width * 0.5) <= rr.laneHalfWidth;
    if (!onRoad) {
      rr.speed *= 0.72;
      rr.multiplier = 1;
      if (this.isRunning && this.vibration.globalCooldown <= 0) {
        this._triggerVibration('Resonance Drift');
        this.vibration.globalCooldown = 0.25;
      }
    } else if (speaking) {
      rr.multiplier = Math.min(6, rr.multiplier + dt * 0.5);
      rr.score += rr.speed * dt * rr.multiplier * 0.08;
    }

    rr.trail.push({
      x: rr.centerX,
      y: this.height * 0.74,
      offroad: !onRoad,
      life: 1,
      w: 5 + m.energy * 12,
    });
    for (let i = rr.trail.length - 1; i >= 0; i--) {
      rr.trail[i].life -= dt * 0.35;
      rr.trail[i].y -= rr.speed * dt * 0.36;
      if (rr.trail[i].life <= 0 || rr.trail[i].y < -40) rr.trail.splice(i, 1);
    }
    if (rr.trail.length > 900) rr.trail.splice(0, rr.trail.length - 900);
  }

  drawResonanceRoadScene() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const rr = this.resonanceRoad;

    const bright = rr.targetTone === 'bright';
    const roadA = bright ? '#d8ff4f' : '#7f6bff';
    const roadB = bright ? '#52f2b8' : '#2942d7';
    const hazardA = bright ? '#30134f' : '#fff5a0';
    const hazardB = bright ? '#0d1130' : '#fff';

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, bright ? '#080b1f' : '#0b0b16');
    bg.addColorStop(1, bright ? '#120c30' : '#130e26');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const roadTopY = h * 0.18;
    const roadBottomY = h * 0.95;
    const topHalf = w * 0.06;
    const botHalf = rr.roadHalfWidth;

    const hazard = ctx.createLinearGradient(0, 0, w, h);
    hazard.addColorStop(0, hazardA);
    hazard.addColorStop(1, hazardB);
    ctx.fillStyle = hazard;
    ctx.beginPath();
    ctx.moveTo(0, roadBottomY);
    ctx.lineTo(w * 0.5 - botHalf, roadBottomY);
    ctx.lineTo(w * 0.5 - topHalf, roadTopY);
    ctx.lineTo(0, roadTopY);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w, roadBottomY);
    ctx.lineTo(w * 0.5 + botHalf, roadBottomY);
    ctx.lineTo(w * 0.5 + topHalf, roadTopY);
    ctx.lineTo(w, roadTopY);
    ctx.closePath();
    ctx.fill();

    const road = ctx.createLinearGradient(0, roadTopY, 0, roadBottomY);
    road.addColorStop(0, roadA);
    road.addColorStop(1, roadB);
    ctx.fillStyle = road;
    ctx.beginPath();
    ctx.moveTo(w * 0.5 - botHalf, roadBottomY);
    ctx.lineTo(w * 0.5 + botHalf, roadBottomY);
    ctx.lineTo(w * 0.5 + topHalf, roadTopY);
    ctx.lineTo(w * 0.5 - topHalf, roadTopY);
    ctx.closePath();
    ctx.fill();

    for (const t of rr.trail) {
      ctx.strokeStyle = t.offroad
        ? `rgba(${bright ? '165,95,255' : '255,250,180'},${Math.max(0.08, t.life)})`
        : `rgba(${bright ? '215,255,110' : '138,122,255'},${Math.max(0.12, t.life)})`;
      ctx.lineWidth = t.offroad ? t.w * 1.35 : t.w;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y + 8);
      ctx.lineTo(t.x + (Math.random() - 0.5) * (t.offroad ? 9 : 2), t.y - 6);
      ctx.stroke();
    }

    const riderW = 128;
    const riderH = 64;
    const riderX = rr.centerX - riderW * 0.5;
    const riderY = h * 0.78 - riderH * 0.62;
    const avatarReady = this.roadRiderAvatar && this.roadRiderAvatar.complete && this.roadRiderAvatar.naturalWidth > 0;
    if (avatarReady) {
      ctx.drawImage(this.roadRiderAvatar, riderX, riderY, riderW, riderH);
    } else {
      ctx.fillStyle = bright ? 'rgba(230,255,140,0.95)' : 'rgba(210,200,255,0.95)';
      ctx.beginPath();
      ctx.ellipse(rr.centerX, h * 0.78, 30, 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(245,248,255,0.95)';
    ctx.font = '600 30px "Space Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('RESONANCE ROAD', 22, 44);

    ctx.font = '600 14px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(190,225,255,0.88)';
    ctx.fillText(`TARGET: ${rr.targetTone.toUpperCase()}`, 24, 70);
    ctx.fillText(`MULTIPLIER: ${rr.multiplier.toFixed(1)}x`, 24, 92);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(245,250,255,0.95)';
    ctx.font = '600 24px "Space Mono", monospace';
    ctx.fillText(`SCORE: ${Math.round(rr.score)}`, w - 22, 44);
    ctx.font = '600 13px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(215,235,255,0.82)';
    ctx.fillText(`SPEED ${Math.round(rr.speed)}`, w - 22, 68);
  }


  _spectralAscentPhaseName(phase) {
    if (phase < 1) return 'TEST PHASE 1: EXTREMES';
    if (phase < 2) return 'TEST PHASE 2: STABILITY';
    return 'TEST PHASE 3: AGILITY';
  }

  _spawnSpectralGate(yNorm = 0.5) {
    const sa = this.spectralAscent;
    sa.gates.push({
      x: this.width + 70,
      y: Math.max(0.1, Math.min(0.9, yNorm)),
      r: 40,
      passed: false,
    });
  }

  _resetSpectralAscentState() {
    const sa = this.spectralAscent;
    sa.balloonX = this.width * 0.58;
    sa.centerY = this.height * 0.52;
    sa.balloonY = sa.centerY;
    sa.balloonVy = 0;
    sa.worldX = 0;
    sa.markerY = sa.centerY;
    sa.tetherLagY = sa.centerY;
    sa.gates = [];
    sa.gateTimer = 0;
    sa.phase = 0;
    sa.score = 0;
    sa.diagnostics = {
      driftAccum: 0,
      driftSamples: 0,
      transitionLagAccum: 0,
      transitionCount: 0,
      prevWeight: this.analyzer.spectralWeight || 0.5,
      dynamicMin: 1,
      dynamicMax: 0,
    };
  }

  updateSpectralAscent(dt) {
    const sa = this.spectralAscent;
    const weight = this.analyzer.spectralWeight;
    const confidence = this.analyzer.spectralTiltConfidence;
    const centerY = sa.centerY || this.height * 0.52;

    const riseForce = -640;
    const sinkForce = 640;
    const control = (weight - 0.5) * 2;
    const controlForce = control >= 0 ? control * (-riseForce) * -1 : -control * sinkForce;
    const gravityToCenter = (centerY - sa.balloonY) * 2.2;
    sa.balloonVy += (controlForce + gravityToCenter * 0.5) * dt;
    sa.balloonVy *= (0.98 - confidence * 0.01);
    sa.balloonY += sa.balloonVy * dt;
    sa.balloonY = Math.max(this.height * 0.15, Math.min(this.height * 0.88, sa.balloonY));

    const gaugeTop = this.height * 0.2;
    const gaugeBottom = this.height * 0.83;
    const markerTargetY = gaugeBottom - weight * (gaugeBottom - gaugeTop);
    sa.markerY += (markerTargetY - sa.markerY) * 0.35;
    sa.tetherLagY += (sa.balloonY - sa.tetherLagY) * 0.18;

    sa.worldX += sa.gateSpeed * dt;
    sa.gateTimer += dt;

    if (sa.gateTimer >= 1.15) {
      sa.gateTimer = 0;
      const elapsed = this.session && this.session.duration ? this.session.duration : 0;
      sa.phase = elapsed < 25 ? 0 : elapsed < 50 ? 1 : 2;
      if (sa.phase === 0) {
        this._spawnSpectralGate(sa.gates.length % 2 === 0 ? 0.2 : 0.82);
      } else if (sa.phase === 1) {
        this._spawnSpectralGate(0.5 + (Math.random() - 0.5) * 0.06);
      } else {
        const step = [0.22, 0.78, 0.3, 0.7, 0.4, 0.6];
        this._spawnSpectralGate(step[Math.floor(performance.now() / 350) % step.length]);
      }
    }

    for (let i = sa.gates.length - 1; i >= 0; i--) {
      const g = sa.gates[i];
      g.x -= sa.gateSpeed * dt;
      const gy = this.height * g.y;
      if (!g.passed && Math.abs(g.x - sa.balloonX) < 26) {
        const miss = Math.abs(gy - sa.balloonY);
        const hit = miss < 46;
        g.passed = true;
        if (hit) sa.score += 10 + Math.max(0, Math.round((46 - miss) * 0.2));
      }
      if (g.x < -90) sa.gates.splice(i, 1);
    }

    const d = sa.diagnostics;
    d.dynamicMin = Math.min(d.dynamicMin, weight);
    d.dynamicMax = Math.max(d.dynamicMax, weight);
    if (sa.phase === 1) {
      d.driftAccum += Math.abs(sa.balloonY - centerY) / this.height;
      d.driftSamples += 1;
    }
    const jump = Math.abs(weight - d.prevWeight);
    if (jump > 0.28) {
      const lag = Math.abs(sa.markerY - sa.balloonY) / this.height;
      d.transitionLagAccum += lag;
      d.transitionCount += 1;
    }
    d.prevWeight = weight;
  }

  drawSpectralAscentScene() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const sa = this.spectralAscent;
    const weight = this.analyzer.spectralWeight;

    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#1b3f7b');
    sky.addColorStop(0.6, '#3d71ad');
    sky.addColorStop(1, '#88b5db');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(200,230,255,0.22)';
    ctx.lineWidth = 1;
    for (let y = h * 0.14; y < h * 0.95; y += 52) {
      ctx.beginPath();
      ctx.moveTo(w * 0.14, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    for (const g of sa.gates) {
      const gy = h * g.y;
      const grad = ctx.createRadialGradient(g.x, gy, 8, g.x, gy, g.r + 8);
      grad.addColorStop(0, 'rgba(178,245,255,0.65)');
      grad.addColorStop(1, 'rgba(86,219,255,0.02)');
      ctx.strokeStyle = '#8be8ff';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(g.x, gy, g.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(g.x, gy, g.r + 8, 0, Math.PI * 2);
      ctx.fill();
    }

    const gaugeX = w * 0.08;
    const gaugeTop = h * 0.2;
    const gaugeBottom = h * 0.83;
    const gaugeW = 26;
    ctx.fillStyle = 'rgba(9,20,36,0.45)';
    ctx.fillRect(gaugeX, gaugeTop, gaugeW, gaugeBottom - gaugeTop);
    const gaugeGrad = ctx.createLinearGradient(0, gaugeTop, 0, gaugeBottom);
    gaugeGrad.addColorStop(0, '#93eeff');
    gaugeGrad.addColorStop(0.5, '#d8e3f0');
    gaugeGrad.addColorStop(1, '#74685f');
    ctx.fillStyle = gaugeGrad;
    ctx.fillRect(gaugeX + 5, gaugeTop + 5, gaugeW - 10, gaugeBottom - gaugeTop - 10);

    const midY = (gaugeTop + gaugeBottom) * 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gaugeX - 8, midY);
    ctx.lineTo(gaugeX + gaugeW + 8, midY);
    ctx.stroke();

    ctx.fillStyle = '#eaf6ff';
    ctx.font = '600 13px "Outfit", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('MAX LIGHT', gaugeX + gaugeW + 10, gaugeTop + 4);
    ctx.fillText('NEUTRAL', gaugeX + gaugeW + 10, midY + 4);
    ctx.fillText('MAX HEAVY', gaugeX + gaugeW + 10, gaugeBottom - 2);
    ctx.save();
    ctx.translate(gaugeX - 28, (gaugeTop + gaugeBottom) * 0.5);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('SPECTRAL TILT GAUGE', -70, 0);
    ctx.restore();

    ctx.strokeStyle = 'rgba(111,223,255,0.75)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(gaugeX + gaugeW + 2, sa.markerY);
    ctx.bezierCurveTo(w * 0.24, sa.markerY, w * 0.38, sa.tetherLagY, sa.balloonX - 30, sa.balloonY);
    ctx.stroke();

    ctx.fillStyle = '#8df4ff';
    ctx.beginPath();
    ctx.arc(gaugeX + gaugeW + 2, sa.markerY, 8, 0, Math.PI * 2);
    ctx.fill();

    const bodyLight = 'rgba(189,244,255,0.92)';
    const bodyHeavy = 'rgba(145,106,66,0.94)';
    const blend = Math.max(0, Math.min(1, 1 - weight));
    ctx.fillStyle = blend > 0.5 ? bodyHeavy : bodyLight;
    ctx.beginPath();
    ctx.ellipse(sa.balloonX, sa.balloonY - 8, 44, 58 - blend * 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#b1d1e8';
    ctx.fillRect(sa.balloonX - 10, sa.balloonY + 48, 20, 14);
    ctx.strokeStyle = 'rgba(20,40,60,0.4)';
    ctx.strokeRect(sa.balloonX - 10, sa.balloonY + 48, 20, 14);

    ctx.font = '700 30px "Outfit", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(234,248,255,0.94)';
    ctx.fillText('SPECTRAL ASCENT', 22, 42);
    ctx.font = '600 16px "Outfit", sans-serif';
    ctx.fillStyle = 'rgba(220,240,255,0.92)';
    ctx.fillText(this._spectralAscentPhaseName(sa.phase), w * 0.34, 42);

    ctx.textAlign = 'right';
    ctx.font = '600 22px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(245,250,255,0.95)';
    ctx.fillText(`SCORE: ${Math.round(sa.score)}`, w - 24, 40);

    const drift = sa.diagnostics.driftSamples > 0 ? sa.diagnostics.driftAccum / sa.diagnostics.driftSamples : 0;
    const latency = sa.diagnostics.transitionCount > 0 ? sa.diagnostics.transitionLagAccum / sa.diagnostics.transitionCount : 0;
    const dynamic = Math.max(0, sa.diagnostics.dynamicMax - sa.diagnostics.dynamicMin);
    const latencyLabel = latency < 0.02 ? 'Low' : latency < 0.04 ? 'Medium' : 'High';
    const stabilityLabel = drift < 0.05 ? 'High' : drift < 0.09 ? 'Medium' : 'Low';
    const dynamicLabel = dynamic > 0.55 ? 'Excellent' : dynamic > 0.35 ? 'Good' : 'Limited';

    ctx.textAlign = 'left';
    ctx.font = '500 13px "Outfit", sans-serif';
    ctx.fillStyle = 'rgba(236,248,255,0.92)';
    ctx.fillText(`Spectral Latency: ${latencyLabel}`, 24, h - 66);
    ctx.fillText(`Stability: ${stabilityLabel}`, 24, h - 46);
    ctx.fillText(`Dynamic Range: ${dynamicLabel}`, 24, h - 26);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(226,240,255,0.9)';
    ctx.fillText(`Tilt ${this.analyzer.spectralTiltSmoothedDb.toFixed(1)} dB · Weight ${(weight * 100).toFixed(0)}%`, w - 20, h - 24);
  }

  // ============================================================
  // PRISM READER
  // ============================================================

  _syllabify(word) {
    const clean = word.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (clean.length === 0) return [word];
    if (clean.length <= 2) return [word];

    const vowels = 'aeiouy';
    const isVowel = (ch) => vowels.includes(ch);

    const nuclei = [];
    let i = 0;
    while (i < clean.length) {
      if (isVowel(clean[i])) {
        const start = i;
        while (i < clean.length && isVowel(clean[i])) i++;
        nuclei.push({ start, end: i });
      } else {
        i++;
      }
    }

    // Handle silent-e: if last nucleus is just 'e' at word end and there are other nuclei, remove it
    if (nuclei.length > 1) {
      const last = nuclei[nuclei.length - 1];
      if (last.end === clean.length && clean.slice(last.start, last.end) === 'e') {
        // Keep the 'e' nucleus for "-le" endings (e.g., "ta-ble", "peo-ple")
        const beforeE = clean[last.start - 1];
        if (beforeE !== 'l') {
          nuclei.pop();
        }
      }
    }

    if (nuclei.length <= 1) return [word];

    // Map clean indices back to original word indices
    const cleanToOrig = [];
    let ci = 0;
    for (let oi = 0; oi < word.length; oi++) {
      if (/[a-zA-Z]/.test(word[oi]) && ci < clean.length) {
        cleanToOrig[ci] = oi;
        ci++;
      }
    }
    cleanToOrig[clean.length] = word.length;

    // Common consonant digraphs that shouldn't be split
    const digraphs = ['th', 'ch', 'sh', 'ph', 'wh', 'ck', 'ng', 'gh'];
    // Common onset clusters that prefer to stay together
    const onsetClusters = ['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr', 'tw', 'str', 'spr', 'scr', 'spl'];

    const syllables = [];
    let prevEnd = 0;

    for (let n = 0; n < nuclei.length - 1; n++) {
      const gapStart = nuclei[n].end;
      const gapEnd = nuclei[n + 1].start;
      const gapLen = gapEnd - gapStart;
      const consonants = clean.slice(gapStart, gapEnd);

      let splitClean;
      if (gapLen === 0) {
        // Adjacent vowel nuclei - split between them
        splitClean = gapStart;
      } else if (gapLen === 1) {
        // Single consonant goes with following vowel (open syllable preference)
        splitClean = gapStart;
      } else if (gapLen === 2) {
        // Two consonants: check if they form a valid onset cluster
        if (onsetClusters.includes(consonants) || digraphs.includes(consonants)) {
          splitClean = gapStart; // keep together with next syllable
        } else {
          splitClean = gapStart + 1; // split between them
        }
      } else {
        // 3+ consonants: find the longest valid onset cluster at the end
        let bestOnset = 1; // default: last consonant goes with next syllable
        for (let len = 2; len <= Math.min(3, gapLen); len++) {
          const candidate = consonants.slice(gapLen - len);
          if (onsetClusters.includes(candidate)) {
            bestOnset = len;
          }
        }
        splitClean = gapEnd - bestOnset;
      }

      const splitOrig = cleanToOrig[splitClean] || word.length;
      syllables.push(word.slice(prevEnd, splitOrig));
      prevEnd = splitOrig;
    }
    syllables.push(word.slice(prevEnd));

    return syllables.filter(s => s.length > 0);
  }

  _buildPrismSyllables(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const syllables = [];
    for (const word of words) {
      const parts = this._syllabify(word);
      for (let i = 0; i < parts.length; i++) {
        syllables.push({
          text: parts[i],
          isWordStart: i === 0,
          isWordEnd: i === parts.length - 1,
          pitchSamples: [],
          f2Samples: [],
          centroidSamples: [],
          weightSamples: [],
          vowelLikelihoodSamples: [],
          energySamples: [],
          durationMs: 0,
          startTime: 0,
          avgF0: 0,
          avgF2_vowelOnly: 0,
          avgCentroid: 0,
          avgWeight: 0,
          vowelType: null,
          vowelScore: 0,
          strainFlag: false,
          confidence: 0,
          state: 'pre-read',
          hue: 0,
          glowRadius: 0,
          strokeOrBlur: 'none',
          blurAmount: 0,
          strokeWidth: 0,
        });
      }
    }
    return syllables;
  }

  _resetPrismReaderState() {
    const pr = this.prismReader;
    let text;
    if (pr.passageMode === 'custom' && pr.customText.trim()) {
      text = pr.customText;
    } else if (pr.passageMode === 'freestyle') {
      text = pr.freestyleTranscript || '';
    } else {
      text = (this.prismPassages && this.prismPassages[pr.passageMode]) || this.teleprompterRainbowText;
    }

    pr.syllables = text ? this._buildPrismSyllables(text) : [];
    pr.currentIndex = -1;
    pr.isActive = false;
    pr.completed = false;
    pr.lastOnsetTime = 0;
    pr.accumulationTimer = 0;
    pr.silenceTimer = 0;
    pr.startTime = performance.now();
    pr.firstOnsetTime = 0;
    pr.wordsCompleted = 0;

    // Clear any existing recordings if not explicitly retained
    if (pr.isPlayingBack) this._stopPrismPlayback();
    if (pr.isRecording) this._stopPrismRecording();
    pr.audioBlob = null;
    if (pr.audioPlayer) {
      pr.audioPlayer.pause();
      pr.audioPlayer.src = '';
    }
    pr.audioChunks = [];
    this._updatePrismRecBtnVisibility();

    // Hide completion summary
    const comp = document.getElementById('prismCompletion');
    if (comp) comp.classList.remove('show');

    const container = document.getElementById('prismScrollContainer');
    if (container) {
      container.innerHTML = '';
      // Build DOM with sentence break markers
      let prevSentenceEnd = false;
      for (let i = 0; i < pr.syllables.length; i++) {
        const syl = pr.syllables[i];

        // Insert sentence break between sentences
        if (syl.isWordStart && prevSentenceEnd) {
          const br = document.createElement('span');
          br.className = 'prism-sentence-break';
          container.appendChild(br);
          prevSentenceEnd = false;
        }

        const span = document.createElement('span');
        span.className = 'prism-syl pre-read';
        span.dataset.sylIndex = String(i);
        span.textContent = syl.text;
        if (syl.isWordEnd) {
          span.style.marginRight = '0.3em';
        }
        container.appendChild(span);

        // Detect sentence-ending punctuation
        if (syl.isWordEnd && /[.!?]$/.test(syl.text)) {
          prevSentenceEnd = true;
        }
      }
      container.scrollTop = 0;
    }

    const fill = document.getElementById('prismProgressFill');
    if (fill) fill.style.width = '0%';

    const keepReading = document.getElementById('prismKeepReading');
    if (keepReading) keepReading.classList.remove('show');

    // Reset live stats, legend, and keyboard hints
    const liveStats = document.getElementById('prismLiveStats');
    if (liveStats) liveStats.classList.remove('show');
    const wpmEl = document.getElementById('prismWpm');
    if (wpmEl) wpmEl.textContent = '0 wpm';
    const elapsedEl = document.getElementById('prismElapsed');
    if (elapsedEl) elapsedEl.textContent = '0:00';
    const sylCountEl = document.getElementById('prismSylCount');
    if (sylCountEl) sylCountEl.textContent = `0 / ${pr.syllables.length}`;
    const legend = document.getElementById('prismLegend');
    if (legend) legend.classList.remove('show');
    const kbdHints = document.getElementById('prismKbdHints');
    if (kbdHints) kbdHints.classList.remove('show');

    // Reset progress bar gradient to default
    const progressFill2 = document.getElementById('prismProgressFill');
    if (progressFill2) {
      progressFill2.style.background = '';
    }

    const idlePrompt = document.getElementById('prismIdlePrompt');
    if (idlePrompt) {
      if (pr.passageMode === 'freestyle') {
        idlePrompt.textContent = "Speak freely to begin transcribing...";
        if (pr.processMode === 'realtime') {
          idlePrompt.classList.add('show');
        }
      } else if (pr.processMode === 'record') {
        idlePrompt.textContent = "Click Rec to start reading";
      } else {
        idlePrompt.textContent = "Start speaking to begin...";
        idlePrompt.classList.add('show');
      }
    }
  }

  // ---- Pitch → Hue (logarithmic for musical perception) ----
  _mapPitchToHue(hz) {
    if (hz <= 0) return 240;
    const minHz = 80;
    const maxHz = 400;
    const clamped = Math.max(minHz, Math.min(maxHz, hz));
    const t = Math.log(clamped / minHz) / Math.log(maxHz / minHz);
    return 240 + t * 80; // 240 (blue) → 320 (pink)
  }

  // ---- Resonance → Glow radius (quadratic with dead zone) ----
  _mapResonanceToGlow(centroidNormalized) {
    const t = Math.max(0, (centroidNormalized - 0.2) / 0.8);
    return t * t * 20;
  }

  // ---- Vocal Weight → Edge texture (threshold switch) ----
  _mapWeightToEdge(spectralWeight) {
    if (spectralWeight < 0.4) {
      const intensity = 1 - (spectralWeight / 0.4);
      return { type: 'stroke', strokeWidth: 0.5 + intensity * 1.5, blur: 0 };
    } else if (spectralWeight > 0.6) {
      const intensity = (spectralWeight - 0.6) / 0.4;
      return { type: 'blur', strokeWidth: 0, blur: 0.5 + intensity * 2.5 };
    }
    return { type: 'none', strokeWidth: 0, blur: 0 };
  }

  // ---- Vowel classification from F2 ----
  _classifyPrismVowel(avgF0, avgF2) {
    if (avgF2 <= 0) return null;
    const normFactor = avgF0 > 200 ? 0.85 : 1.0;
    const f2n = avgF2 * normFactor;
    if (f2n >= 2200) return 'IY';
    if (f2n >= 1800) return 'IH';
    if (f2n >= 1500) return 'EH';
    if (f2n >= 1100) return 'AH';
    if (f2n >= 750) return 'UW';
    return 'AH';
  }

  // ---- Vowel-specific F2 target scoring (Gaussian) ----
  _scorePrismVowelF2(vowelType, measuredF2) {
    if (!vowelType || measuredF2 <= 0) return 0.5;
    const targets = {
      'IY': { center: 2600, halfWidth: 400 },
      'IH': { center: 2000, halfWidth: 200 },
      'EH': { center: 1750, halfWidth: 150 },
      'AH': { center: 1400, halfWidth: 200 },
      'UW': { center: 950, halfWidth: 200 },
    };
    const t = targets[vowelType];
    if (!t) return 0.5;
    const distance = Math.abs(measuredF2 - t.center);
    const normalized = distance / t.halfWidth;
    return Math.max(0, Math.min(1, Math.exp(-0.5 * normalized * normalized)));
  }

  _applyPrismVisuals(index) {
    const syl = this.prismReader.syllables[index];
    syl.hue = this._mapPitchToHue(syl.avgF0);
    syl.glowRadius = this._mapResonanceToGlow(syl.avgCentroid);
    const edge = this._mapWeightToEdge(syl.avgWeight);
    syl.strokeOrBlur = edge.type;
    syl.strokeWidth = edge.strokeWidth;
    syl.blurAmount = edge.blur;
  }

  _crystallizePrismSyllable(index) {
    const syl = this.prismReader.syllables[index];
    if (!syl || syl.state === 'crystallized') return;

    const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const median = (arr) => {
      if (arr.length === 0) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };

    syl.avgF0 = median(syl.pitchSamples);
    syl.avgF2_vowelOnly = avg(syl.f2Samples);
    syl.avgCentroid = avg(syl.centroidSamples);
    syl.avgWeight = avg(syl.weightSamples);

    syl.vowelType = this._classifyPrismVowel(syl.avgF0, syl.avgF2_vowelOnly);
    syl.vowelScore = this._scorePrismVowelF2(syl.vowelType, syl.avgF2_vowelOnly);

    const avgEnergy = avg(syl.energySamples);
    const avgVowelLike = avg(syl.vowelLikelihoodSamples);
    syl.strainFlag = (syl.avgWeight < 0.25 && avgEnergy > 0.06);

    const pitchConf = syl.pitchSamples.length > 2 ? 1 : syl.pitchSamples.length / 2;
    const durationConf = Math.min(1, syl.durationMs / 300);
    const vowelConf = avgVowelLike;
    syl.confidence = Math.min(1, pitchConf * 0.3 + durationConf * 0.3 + vowelConf * 0.4);

    this._applyPrismVisuals(index);
    syl.state = 'crystallized';

    if (this.prismReader.processMode === 'record') {
      if (!this.prismReader.isPlayingBack) {
        // Sync timestamp to when they STARTED saying the word, not when the word ended.
        syl.playbackTimestamp = (syl.startTime / 1000) - this.prismReader.startTime;
        syl.playbackRevealed = false;
        return;
      }
    }

    this._updatePrismSylDOM(index);
  }

  _updatePrismSylDOM(index) {
    const container = document.getElementById('prismScrollContainer');
    if (!container) return;
    const span = container.querySelector(`.prism-syl[data-syl-index="${index}"]`);
    if (!span) return;

    const syl = this.prismReader.syllables[index];
    span.classList.remove('pre-read', 'active', 'crystallized', 'strain', 'pop');
    span.classList.add(syl.state);

    if (syl.state === 'crystallized') {
      // Vowel score modulates saturation: 30% (off-target) to 85% (on-target)
      const sat = Math.round(30 + syl.vowelScore * 55);
      const hsl = `hsl(${Math.round(syl.hue)}, ${sat}%, 65%)`;
      let shadow = 'none';
      if (syl.glowRadius > 0.5) {
        const r = Math.round(syl.glowRadius);
        shadow = `0 0 ${r}px hsla(${Math.round(syl.hue)}, 80%, 70%, 0.6), ` +
          `0 0 ${r * 2}px hsla(${Math.round(syl.hue)}, 60%, 50%, 0.25)`;
      }

      let filterStr = 'none';
      let strokeStr = '';
      if (syl.strokeOrBlur === 'stroke') {
        strokeStr = `${syl.strokeWidth.toFixed(1)}px hsla(${Math.round(syl.hue)}, 50%, 40%, 0.8)`;
      } else if (syl.strokeOrBlur === 'blur') {
        filterStr = `blur(${syl.blurAmount.toFixed(1)}px)`;
      }

      span.style.color = hsl;
      span.style.textShadow = shadow;
      span.style.filter = filterStr;
      span.style.webkitTextStroke = strokeStr;

      if (syl.strainFlag) {
        span.classList.add('strain');
      }

      // Trigger pop animation (skip during reduced motion)
      if (!this.reducedMotion) {
        // Force reflow to restart animation if re-applied
        void span.offsetWidth;
        span.classList.add('pop');
      }
    } else if (syl.state === 'active') {
      span.style.color = '';
      span.style.textShadow = '';
      span.style.filter = '';
      span.style.webkitTextStroke = '';
    }
  }

  _togglePrismRecording() {
    const pr = this.prismReader;
    if (pr.isRecording) {
      this._stopPrismRecording();
    } else if (pr.isPlayingBack) {
      this._stopPrismPlayback();
    } else if (pr.audioBlob) {
      this._startPrismPlayback();
    } else {
      this._startPrismRecording();
    }
  }

  _startPrismRecording() {
    const pr = this.prismReader;
    if (!this.analyzer || !this.analyzer.stream) return;

    this._resetPrismReaderState();

    pr.audioChunks = [];
    try {
      pr.mediaRecorder = new MediaRecorder(this.analyzer.stream);
      pr.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) pr.audioChunks.push(e.data);
      };
      pr.mediaRecorder.onstop = () => {
        pr.audioBlob = new Blob(pr.audioChunks, { type: 'audio/webm' });
        pr.audioPlayer.src = URL.createObjectURL(pr.audioBlob);
        this._updatePrismRecBtnVisibility();
      };

      pr.mediaRecorder.start();
      pr.isRecording = true;
      if (pr.passageMode === 'freestyle' && pr.speechRecognition) {
        pr.freestyleTranscript = '';
        try { pr.speechRecognition.start(); } catch (e) { }
      }
      pr.recordingStream = this.analyzer.stream;
      pr.startTime = performance.now() / 1000;

      const recBtn = document.getElementById('recBtn');
      if (recBtn) {
        recBtn.classList.add('recording');
        const label = recBtn.querySelector('.rec-label');
        if (label) label.textContent = 'Stop';
      }
    } catch (e) {
      console.error('Failed to start Prism MediaRecorder:', e);
    }
  }

  _stopPrismRecording() {
    const pr = this.prismReader;
    if (!pr.isRecording || !pr.mediaRecorder) return;

    // Auto-crystallize the last word if it's still active
    if (pr.isActive && pr.currentIndex >= 0 && pr.currentIndex < pr.syllables.length) {
      this._crystallizePrismSyllable(pr.currentIndex);
      pr.isActive = false;
    }

    pr.mediaRecorder.stop();
    pr.isRecording = false;
    if (pr.passageMode === 'freestyle' && pr.speechRecognition) {
      try { pr.speechRecognition.stop(); } catch (e) { }
      pr.customText = pr.freestyleTranscript;
      this._resetPrismReaderState();
    }

    const recBtn = document.getElementById('recBtn');
    if (recBtn) {
      recBtn.classList.remove('recording');
      const label = recBtn.querySelector('.rec-label');
      if (label) label.textContent = 'Play';
    }
  }

  _startPrismPlayback() {
    const pr = this.prismReader;
    if (!pr.audioBlob) return;

    document.querySelectorAll('.prism-syl').forEach(s => {
      s.className = 'prism-syl pre-read';
      s.style = '';
    });

    for (const syl of pr.syllables) {
      if (syl.state === 'crystallized' || syl.state === 'active') {
        syl.playbackRevealed = false;
      }
    }

    pr.playbackIndex = 0;
    pr.isPlayingBack = true;

    const container = document.getElementById('prismScrollContainer');
    if (container) container.scrollTop = 0;

    pr.audioPlayer.currentTime = 0;
    pr.audioPlayer.play().catch(e => console.error("Playback failed", e));

    pr.audioPlayer.onended = () => {
      this._stopPrismPlayback();
    };

    const recBtn = document.getElementById('recBtn');
    if (recBtn) {
      recBtn.classList.add('recording');
      const label = recBtn.querySelector('.rec-label');
      if (label) label.textContent = 'Stop';
    }

    this._updatePrismRecBtnVisibility();
  }

  _stopPrismPlayback() {
    const pr = this.prismReader;
    pr.isPlayingBack = false;
    pr.audioPlayer.pause();

    const recBtn = document.getElementById('recBtn');
    if (recBtn) {
      recBtn.classList.remove('recording');
      const label = recBtn.querySelector('.rec-label');
      if (label) label.textContent = 'Replay';
    }

    this._updatePrismRecBtnVisibility();
  }

  _onPrismSpeechResult(event) {
    if (!this.isRunning && !this.prismReader.isRecording) return;
    const pr = this.prismReader;
    if (pr.passageMode !== 'freestyle') return;

    let finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + ' ';
      }
    }

    if (finalTranscript.trim()) {
      pr.freestyleTranscript += finalTranscript;

      const idlePrompt = document.getElementById('prismIdlePrompt');
      if (idlePrompt) idlePrompt.classList.remove('show');

      if (pr.processMode === 'realtime') {
        const newSyllables = this._buildPrismSyllables(finalTranscript.trim());
        const startIndex = pr.syllables.length;
        pr.syllables = pr.syllables.concat(newSyllables);

        const container = document.getElementById('prismScrollContainer');
        if (container) {
          for (let i = 0; i < newSyllables.length; i++) {
            const globalIndex = startIndex + i;
            const syl = newSyllables[i];
            const span = document.createElement('span');
            span.className = 'prism-syl pre-read';
            span.dataset.sylIndex = String(globalIndex);
            span.textContent = syl.text;
            if (syl.isWordEnd) span.style.marginRight = '0.3em';
            container.appendChild(span);
            this._crystallizePrismSyllableImmediate(globalIndex);
          }
          container.scrollTop = container.scrollHeight;
        }
      }
    }
  }

  _crystallizePrismSyllableImmediate(index) {
    const syl = this.prismReader.syllables[index];
    if (!syl || syl.state === 'crystallized') return;
    const a = this.analyzer;
    syl.avgF0 = a.smoothPitchHz || 0;
    syl.avgF2_vowelOnly = a.smoothF2 || 0;
    syl.avgCentroid = a.smoothResonance || 0;
    syl.avgWeight = a.spectralWeight || 0;
    syl.vowelType = this._classifyPrismVowel(syl.avgF0, syl.avgF2_vowelOnly);
    syl.vowelScore = this._scorePrismVowelF2(syl.vowelType, syl.avgF2_vowelOnly);
    syl.strainFlag = false;
    syl.confidence = 1;

    this._applyPrismVisuals(index);
    syl.state = 'crystallized';
    this._updatePrismSylDOM(index);
  }

  updatePrismPlayback(dt) {
    const pr = this.prismReader;
    const ct = pr.audioPlayer.currentTime;

    // Smooth out early timestamps that might have slightly negative values 
    // due to DOM/audio init mismatches
    for (let i = 0; i < pr.syllables.length; i++) {
      const syl = pr.syllables[i];
      if (syl.state === 'crystallized' && !syl.playbackRevealed) {
        // Add a +60ms pad to slightly delay visual reveal, tightening the sync feel.
        const syncTime = Math.max(0, syl.playbackTimestamp + 0.06);
        if (ct >= syncTime) {
          syl.playbackRevealed = true;
          this._updatePrismSylDOM(i);
          pr.playbackIndex = Math.max(pr.playbackIndex || 0, i);
        }
      }
    }
  }

  updatePrismReader(dt) {
    const pr = this.prismReader;

    if (pr.processMode === 'record') {
      if (pr.isPlayingBack) {
        this.updatePrismPlayback(dt);
        return;
      }
      if (!pr.isRecording) {
        return;
      }
    }

    // Explicitly do not return if completed = true in record mode because we stop recording
    // playback when we are done, but we MIGHT crystallize early.
    if (pr.completed && pr.processMode !== 'record') return;

    const a = this.analyzer;
    const now = performance.now() / 1000;

    // Accumulate acoustic data for current syllable
    if (pr.isActive && pr.currentIndex >= 0 && pr.currentIndex < pr.syllables.length) {
      const syl = pr.syllables[pr.currentIndex];
      syl.durationMs += dt * 1000;
      pr.accumulationTimer += dt;

      if (a.metrics.energy > 0.02) {
        if (a.lastPitch > 0 && a.pitchConfidence > 0.4) {
          syl.pitchSamples.push(a.smoothPitchHz);
        }
        if (a.vowelLikelihood > 0.25) {
          syl.f2Samples.push(a.smoothF2);
          syl.centroidSamples.push(a.smoothResonance);
        }
        syl.weightSamples.push(a.spectralWeight);
        syl.energySamples.push(a.smoothEnergy);
        syl.vowelLikelihoodSamples.push(a.vowelLikelihood);
      }
    }

    // Track silence
    if (a.metrics.energy > 0.02) {
      pr.silenceTimer = 0;
    } else {
      if (!pr.isPlayingBack) pr.silenceTimer += dt;
    }

    // Show "keep reading" prompt on extended silence
    const keepReading = document.getElementById('prismKeepReading');
    if (keepReading) {
      keepReading.classList.toggle('show', pr.isActive && !pr.isPlayingBack && pr.silenceTimer > 3.0);
    }

    // Update live stats HUD
    this._updatePrismLiveStats();

    // Manual mode: onset stepping is disabled, spacebar advances instead
    if (pr.manualMode) return;

    // Detect syllable onset
    const onsetDetected = a.syllableImpulse > 0.85;
    const timeSinceLastOnset = now - pr.lastOnsetTime;
    const debounceOk = timeSinceLastOnset > 0.12;

    if (onsetDetected && debounceOk) {
      pr.lastOnsetTime = now;

      // Record the first onset time for WPM calculation
      if (pr.currentIndex < 0) {
        pr.firstOnsetTime = performance.now();
      }

      // Crystallize previous syllable
      if (pr.currentIndex >= 0 && pr.currentIndex < pr.syllables.length) {
        const prevSyl = pr.syllables[pr.currentIndex];
        this._crystallizePrismSyllable(pr.currentIndex);
        // Track word completions for WPM
        if (prevSyl.isWordEnd) {
          pr.wordsCompleted = (pr.wordsCompleted || 0) + 1;
        }
      }

      pr.currentIndex++;
      pr.accumulationTimer = 0;

      if (pr.currentIndex >= pr.syllables.length) {
        pr.completed = true;
        pr.isActive = false;
        this._showPrismCompletionSummary();
        return;
      }

      pr.isActive = true;
      pr.syllables[pr.currentIndex].state = 'active';
      pr.syllables[pr.currentIndex].startTime = performance.now();

      // Hide idle prompt once reading begins
      const idlePrompt = document.getElementById('prismIdlePrompt');
      if (idlePrompt) idlePrompt.classList.remove('show');

      if (pr.processMode !== 'record') {
        this._updatePrismSylDOM(pr.currentIndex);
      }
    }

    // Timeout: crystallize if stuck for > 2s during silence
    if (pr.isActive && pr.accumulationTimer > 2.0 && pr.silenceTimer > 0.5) {
      this._crystallizePrismSyllable(pr.currentIndex);
      pr.isActive = false;
    }
  }

  _updatePrismLiveStats() {
    const pr = this.prismReader;
    const liveStats = document.getElementById('prismLiveStats');
    if (!liveStats) return;

    const hasSyllables = pr.currentIndex >= 0;
    liveStats.classList.toggle('show', hasSyllables);
    if (!hasSyllables) return;

    // Elapsed time since first onset
    const elapsed = pr.firstOnsetTime > 0 ? (performance.now() - pr.firstOnsetTime) / 1000 : 0;
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    const elapsedEl = document.getElementById('prismElapsed');
    if (elapsedEl) elapsedEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;

    // WPM
    const wpmEl = document.getElementById('prismWpm');
    if (wpmEl && elapsed > 2) {
      const words = pr.wordsCompleted || 0;
      const wpm = Math.round(words / (elapsed / 60));
      wpmEl.textContent = `${wpm} wpm`;
    }

    // Syllable count
    const sylCountEl = document.getElementById('prismSylCount');
    if (sylCountEl) {
      const crystallized = pr.syllables.filter(s => s.state === 'crystallized').length;
      sylCountEl.textContent = `${crystallized} / ${pr.syllables.length}`;
    }
  }

  _updatePrismPassageMeta() {
    const metaEl = document.getElementById('prismPassageMeta');
    if (!metaEl) return;

    const mode = this.prismReader.passageMode;
    const text = (this.prismPassages && this.prismPassages[mode]) || '';

    if (!text || mode === 'custom' || mode === 'freestyle') {
      metaEl.innerHTML = '';
      return;
    }

    const words = text.trim().split(/\s+/).filter(Boolean);
    const syllables = this._buildPrismSyllables(text);
    const wordCount = words.length;
    const sylCount = syllables.length;
    // Estimate reading time at ~150 wpm average
    const estMinutes = wordCount / 150;
    const estStr = estMinutes < 1
      ? `~${Math.round(estMinutes * 60)}s`
      : `~${estMinutes.toFixed(1)}min`;

    metaEl.innerHTML = `
      <span class="prism-passage-meta-item">${wordCount} words</span>
      <span class="prism-passage-meta-item">${sylCount} syllables</span>
      <span class="prism-passage-meta-item">${estStr} est.</span>
    `;
  }

  _drawPrismPitchSparkline(canvasEl) {
    const pr = this.prismReader;
    const crystallized = pr.syllables.filter(s => s.state === 'crystallized' && s.avgF0 > 0);
    if (crystallized.length < 3 || !canvasEl) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    canvasEl.width = w * dpr;
    canvasEl.height = h * dpr;
    const ctx = canvasEl.getContext('2d');
    ctx.scale(dpr, dpr);

    const pitches = crystallized.map(s => s.avgF0);
    const minP = Math.min(...pitches);
    const maxP = Math.max(...pitches);
    const range = Math.max(1, maxP - minP);

    const padX = 4;
    const padY = 6;
    const plotW = w - padX * 2;
    const plotH = h - padY * 2;

    // Draw subtle grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 0.5;
    for (let g = 0; g <= 4; g++) {
      const y = padY + (g / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(w - padX, y);
      ctx.stroke();
    }

    // Draw pitch contour
    ctx.beginPath();
    for (let i = 0; i < crystallized.length; i++) {
      const x = padX + (i / (crystallized.length - 1)) * plotW;
      const y = padY + (1 - (crystallized[i].avgF0 - minP) / range) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(180, 160, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Fill under the line
    const lastX = padX + plotW;
    const lastY = padY + (1 - (crystallized[crystallized.length - 1].avgF0 - minP) / range) * plotH;
    ctx.lineTo(lastX, padY + plotH);
    ctx.lineTo(padX, padY + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padY, 0, padY + plotH);
    grad.addColorStop(0, 'rgba(180, 160, 255, 0.15)');
    grad.addColorStop(1, 'rgba(180, 160, 255, 0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw colored dots for each syllable
    for (let i = 0; i < crystallized.length; i++) {
      const s = crystallized[i];
      const x = padX + (i / (crystallized.length - 1)) * plotW;
      const y = padY + (1 - (s.avgF0 - minP) / range) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${Math.round(s.hue)}, 60%, 65%)`;
      ctx.fill();
    }

    // Labels: min and max Hz
    ctx.font = '9px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(maxP)} Hz`, padX + 2, padY + 9);
    ctx.fillText(`${Math.round(minP)} Hz`, padX + 2, h - padY - 1);
  }

  _advancePrismManual() {
    const pr = this.prismReader;
    if (pr.completed) return;

    // Record the first onset time for WPM calculation
    if (pr.currentIndex < 0) {
      pr.firstOnsetTime = performance.now();
    }

    if (pr.currentIndex >= 0) {
      const prevSyl = pr.syllables[pr.currentIndex];
      this._crystallizePrismSyllable(pr.currentIndex);
      if (prevSyl.isWordEnd) {
        pr.wordsCompleted = (pr.wordsCompleted || 0) + 1;
      }
    }

    pr.currentIndex++;
    pr.accumulationTimer = 0;

    if (pr.currentIndex >= pr.syllables.length) {
      pr.completed = true;
      pr.isActive = false;
      this._showPrismCompletionSummary();
      return;
    }

    pr.isActive = true;
    pr.syllables[pr.currentIndex].state = 'active';
    pr.syllables[pr.currentIndex].startTime = performance.now();

    // Hide idle prompt once reading begins
    const idlePrompt = document.getElementById('prismIdlePrompt');
    if (idlePrompt) idlePrompt.classList.remove('show');

    if (pr.processMode !== 'record') {
      this._updatePrismSylDOM(pr.currentIndex);
    }
  }

  _showPrismCompletionSummary() {
    const pr = this.prismReader;
    const crystallized = pr.syllables.filter(s => s.state === 'crystallized');
    if (crystallized.length === 0) return;

    const elapsed = pr.firstOnsetTime > 0 ? (performance.now() - pr.firstOnsetTime) / 1000 : 0;
    const words = pr.wordsCompleted || 0;
    const wpm = elapsed > 1 ? Math.round(words / (elapsed / 60)) : 0;

    // Aggregate pitch stats
    const pitches = crystallized.filter(s => s.avgF0 > 0).map(s => s.avgF0);
    const avgPitch = pitches.length > 0 ? Math.round(pitches.reduce((a, b) => a + b, 0) / pitches.length) : 0;
    const minPitch = pitches.length > 0 ? Math.round(Math.min(...pitches)) : 0;
    const maxPitch = pitches.length > 0 ? Math.round(Math.max(...pitches)) : 0;
    const pitchRange = maxPitch - minPitch;

    // Vowel score average
    const vowelScores = crystallized.filter(s => s.vowelScore > 0).map(s => s.vowelScore);
    const avgVowelScore = vowelScores.length > 0
      ? Math.round(vowelScores.reduce((a, b) => a + b, 0) / vowelScores.length * 100)
      : 0;

    // Strain count
    const strainCount = crystallized.filter(s => s.strainFlag).length;

    // Resonance average
    const centroids = crystallized.filter(s => s.avgCentroid > 0).map(s => s.avgCentroid);
    const avgResonance = centroids.length > 0
      ? Math.round(centroids.reduce((a, b) => a + b, 0) / centroids.length * 100)
      : 0;

    // Confidence average
    const avgConfidence = Math.round(
      crystallized.reduce((a, s) => a + s.confidence, 0) / crystallized.length * 100
    );

    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);

    const grid = document.getElementById('prismCompletionGrid');
    if (grid) {
      grid.innerHTML = `
        <div class="prism-comp-card">
          <div class="prism-comp-label">Reading Speed</div>
          <div class="prism-comp-value">${wpm} wpm</div>
          <div class="prism-comp-sub">${minutes}:${String(seconds).padStart(2, '0')} total</div>
        </div>
        <div class="prism-comp-card">
          <div class="prism-comp-label">Avg Pitch</div>
          <div class="prism-comp-value">${avgPitch} Hz</div>
          <div class="prism-comp-sub">Range: ${pitchRange} Hz (${minPitch}–${maxPitch})</div>
        </div>
        <div class="prism-comp-card">
          <div class="prism-comp-label">Vowel Accuracy</div>
          <div class="prism-comp-value">${avgVowelScore}%</div>
          <div class="prism-comp-sub">${vowelScores.length} vowels scored</div>
        </div>
        <div class="prism-comp-card">
          <div class="prism-comp-label">Resonance</div>
          <div class="prism-comp-value">${avgResonance}%</div>
          <div class="prism-comp-sub">Forward brightness</div>
        </div>
        <div class="prism-comp-card">
          <div class="prism-comp-label">Syllables</div>
          <div class="prism-comp-value">${crystallized.length} / ${pr.syllables.length}</div>
          <div class="prism-comp-sub">Confidence: ${avgConfidence}%</div>
        </div>
        <div class="prism-comp-card">
          <div class="prism-comp-label">Strain Alerts</div>
          <div class="prism-comp-value" style="color: ${strainCount > 0 ? 'rgba(255,120,100,0.9)' : 'rgba(120,255,160,0.9)'}">${strainCount}</div>
          <div class="prism-comp-sub">${strainCount === 0 ? 'No strain detected' : 'High energy + low weight'}</div>
        </div>
        ${pitches.length >= 3 ? `
        <div class="prism-sparkline-wrap">
          <div class="prism-comp-label">Pitch Contour</div>
          <canvas class="prism-sparkline-canvas" id="prismSparkline"></canvas>
        </div>` : ''}
      `;
    }

    const comp = document.getElementById('prismCompletion');
    if (comp) comp.classList.add('show');

    // Draw sparkline after DOM is updated
    requestAnimationFrame(() => {
      const sparkCanvas = document.getElementById('prismSparkline');
      if (sparkCanvas) this._drawPrismPitchSparkline(sparkCanvas);
    });

    // Hide keep-reading prompt and legend
    const keepReading = document.getElementById('prismKeepReading');
    if (keepReading) keepReading.classList.remove('show');
    const legend = document.getElementById('prismLegend');
    if (legend) legend.classList.remove('show');
  }

  drawPrismReaderScene() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const now = performance.now() / 1000;

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#080816');
    bg.addColorStop(0.5, '#0c0a1e');
    bg.addColorStop(1, '#0a0818');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const pr = this.prismReader;

    // Draw subtle star field
    ctx.save();
    for (const star of this.stars) {
      const flicker = 0.4 + 0.6 * Math.sin(now * 0.8 + star.twinkle);
      ctx.globalAlpha = flicker * 0.25;
      ctx.fillStyle = '#c8d0ff';
      ctx.beginPath();
      ctx.arc(star.x % w, star.y, star.size * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Prism light refraction effect at center
    if (pr.syllables.length > 0) {
      const crystallized = pr.syllables.filter(s => s.state === 'crystallized');
      const progress = crystallized.length / Math.max(1, pr.syllables.length);

      if (crystallized.length > 0) {
        const avgHue = crystallized.reduce((s, c) => s + c.hue, 0) / crystallized.length;
        const recentHue = crystallized.length > 0 ? crystallized[crystallized.length - 1].hue : avgHue;

        // Central ambient glow that shifts with reading progress
        const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.6);
        grad.addColorStop(0, `hsla(${avgHue}, 40%, 15%, ${0.08 + progress * 0.12})`);
        grad.addColorStop(0.5, `hsla(${recentHue}, 30%, 10%, ${0.04 + progress * 0.06})`);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Floating prism particles
        if (!this._prismParticles) this._prismParticles = [];

        // Spawn particles on new crystallizations
        const prevCrystCount = this._prevPrismCrystCount || 0;
        if (crystallized.length > prevCrystCount) {
          const newSyl = crystallized[crystallized.length - 1];
          for (let p = 0; p < 3; p++) {
            this._prismParticles.push({
              x: w * (0.3 + Math.random() * 0.4),
              y: h * (0.2 + Math.random() * 0.6),
              vx: (Math.random() - 0.5) * 20,
              vy: -10 - Math.random() * 25,
              hue: newSyl.hue + (Math.random() - 0.5) * 30,
              size: 1.5 + Math.random() * 2.5,
              life: 1,
              decay: 0.3 + Math.random() * 0.4,
              glow: newSyl.glowRadius > 2,
            });
          }
        }
        this._prevPrismCrystCount = crystallized.length;

        // Update and draw particles
        ctx.save();
        for (let i = this._prismParticles.length - 1; i >= 0; i--) {
          const p = this._prismParticles[i];
          p.x += p.vx * 0.016;
          p.y += p.vy * 0.016;
          p.vy += 5 * 0.016; // gentle gravity
          p.life -= p.decay * 0.016;
          if (p.life <= 0) {
            this._prismParticles.splice(i, 1);
            continue;
          }

          ctx.globalAlpha = p.life * 0.6;
          ctx.fillStyle = `hsl(${Math.round(p.hue)}, 60%, 65%)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
          ctx.fill();

          if (p.glow) {
            ctx.globalAlpha = p.life * 0.15;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life * 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();

        // Limit particle count
        if (this._prismParticles.length > 60) {
          this._prismParticles.splice(0, this._prismParticles.length - 60);
        }
      }

      // Refraction rainbow bands along left/right edges during active reading
      if (pr.isActive && !this.reducedMotion) {
        const a = this.analyzer;
        const energy = a ? a.smoothEnergy || 0 : 0;
        const bandAlpha = Math.min(0.12, energy * 0.8);
        if (bandAlpha > 0.005) {
          const colors = [
            `hsla(240, 70%, 55%, ${bandAlpha})`,
            `hsla(260, 60%, 55%, ${bandAlpha})`,
            `hsla(280, 55%, 55%, ${bandAlpha})`,
            `hsla(300, 50%, 55%, ${bandAlpha})`,
            `hsla(320, 60%, 55%, ${bandAlpha})`,
          ];
          const bandW = 3;
          for (let b = 0; b < colors.length; b++) {
            ctx.fillStyle = colors[b];
            ctx.fillRect(b * bandW, 0, bandW, h);
            ctx.fillRect(w - (b + 1) * bandW, 0, bandW, h);
          }
        }
      }
    }
  }

  renderPrismOverlay(dt) {
    const overlay = document.getElementById('prismOverlay');
    if (!overlay) return;

    const pr = this.prismReader;
    overlay.classList.toggle('show', true);

    // Update progress bar with dynamic hue gradient
    const progressFill = document.getElementById('prismProgressFill');
    if (progressFill && pr.syllables.length > 0) {
      let pct;
      if (pr.isPlayingBack && pr.audioPlayer && pr.audioPlayer.duration) {
        pct = Math.max(0, (pr.audioPlayer.currentTime / pr.audioPlayer.duration) * 100);
      } else {
        pct = Math.max(0, (pr.currentIndex + 1) / pr.syllables.length * 100);
      }
      progressFill.style.width = `${Math.min(100, pct)}%`;

      // Dynamic gradient from crystallized syllable hues
      const crystallized = pr.syllables.filter(s => s.state === 'crystallized');
      if (crystallized.length >= 2) {
        const stops = [];
        const step = Math.max(1, Math.floor(crystallized.length / 5));
        for (let i = 0; i < crystallized.length; i += step) {
          const s = crystallized[i];
          const pos = Math.round((i / (crystallized.length - 1)) * 100);
          stops.push(`hsl(${Math.round(s.hue)}, 65%, 60%) ${pos}%`);
        }
        // Always include the last one
        const last = crystallized[crystallized.length - 1];
        stops.push(`hsl(${Math.round(last.hue)}, 65%, 60%) 100%`);
        progressFill.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
      }
    }

    // Show/hide legend and keyboard hints based on reading state
    const legend = document.getElementById('prismLegend');
    if (legend) legend.classList.toggle('show', pr.currentIndex >= 0 && !pr.completed);

    const kbdHints = document.getElementById('prismKbdHints');
    if (kbdHints) {
      const showHints = pr.manualMode && pr.currentIndex >= -1 && !pr.completed && this.isRunning;
      kbdHints.classList.toggle('show', showHints);
    }

    // Smooth adaptive scroll to keep active syllable visible
    const activeIndex = pr.isPlayingBack ? pr.playbackIndex : pr.currentIndex;
    if (activeIndex >= 0) {
      const container = document.getElementById('prismScrollContainer');
      const activeSpan = container?.querySelector(`.prism-syl[data-syl-index="${activeIndex}"]`);
      if (activeSpan && container) {
        const spanTop = activeSpan.offsetTop;
        const spanH = activeSpan.offsetHeight;
        const containerH = container.clientHeight;
        const currentScroll = container.scrollTop;

        // Target: center the active syllable vertically (aim for 35% from top)
        const targetScroll = spanTop + spanH / 2 - containerH * 0.35;

        // Adaptive easing: faster when far away, slower when close
        const distance = Math.abs(targetScroll - currentScroll);
        const easeFactor = distance > containerH * 0.5
          ? 0.18  // fast catch-up when far
          : distance > 50
            ? 0.1  // medium ease
            : 0.06; // gentle when close

        container.scrollTop += (targetScroll - currentScroll) * easeFactor;
      }
    }
  }

  // ============================================================
  // VIBRATION ALERT ENGINE
  // ============================================================
  checkVibrationAlerts(dt) {
    const vib = this.vibration;

    // Decay flash alpha always (even when disabled, to fade out)
    vib.flashAlpha = Math.max(0, vib.flashAlpha - dt * 3);

    if (!vib.enabled || vib.rules.length === 0) return;

    vib.globalCooldown = Math.max(0, vib.globalCooldown - dt);

    if (vib.shakeTimer > 0) {
      vib.shakeTimer -= dt;
      if (vib.shakeTimer <= 0 && this._gameArea) {
        this._gameArea.classList.remove('vib-shake');
      }
    }

    const m = this.analyzer.metrics;
    const hz = this.analyzer.smoothPitchHz;
    const isSpeaking = m.energy > 0.05;
    let anyTrippedNow = false;
    let needsRender = false;
    let trippedLabel = '';

    for (const rule of vib.rules) {
      if (!rule.enabled) {
        if (rule.tripped) { rule.tripped = false; needsRender = true; }
        continue;
      }

      rule.cooldownTimer = Math.max(0, rule.cooldownTimer - dt);

      let currentVal;
      switch (rule.metric) {
        case 'pitch': currentVal = hz; break;
        case 'resonance': currentVal = this.analyzer.smoothResonance * 100; break;
        case 'energy': currentVal = m.energy * 100; break;
        case 'bounce': currentVal = m.bounce * 100; break;
        case 'tempo': currentVal = m.tempo * 100; break;
        case 'vowel': currentVal = m.vowel * 100; break;
        case 'articulation': currentVal = m.articulation * 100; break;
        default: currentVal = 0;
      }

      let conditionMet = false;
      if (isSpeaking) {
        conditionMet = rule.direction === 'below'
          ? currentVal < rule.threshold
          : currentVal > rule.threshold;
      }

      const wasTripped = rule.tripped;
      rule.tripped = conditionMet;
      if (wasTripped !== conditionMet) needsRender = true;

      if (conditionMet) {
        anyTrippedNow = true;
        const metricLabels = {
          pitch: 'Pitch', resonance: 'Resonance', energy: 'Energy',
          bounce: 'Pitch Var.', tempo: 'Tempo', vowel: 'Vowels', articulation: 'Articulation'
        };
        trippedLabel = metricLabels[rule.metric] || rule.metric;

        if (rule.cooldownTimer <= 0 && vib.globalCooldown <= 0) {
          this._triggerVibration(trippedLabel);
          rule.cooldownTimer = 0.5;
          vib.globalCooldown = 0.25;
        }
      }
    }

    // Update live values when vib panel is visible (throttled to ~10fps)
    if (this._updateVibLiveUI) {
      vib._liveUpdateTimer = (vib._liveUpdateTimer || 0) + dt;
      if (vib._liveUpdateTimer > 0.1) {
        vib._liveUpdateTimer = 0;
        const vibPanelEl = document.getElementById('vibPanel');
        if (vibPanelEl && vibPanelEl.classList.contains('show')) {
          this._updateVibLiveUI();
        } else if (needsRender) {
          // Even if panel closed, update tripped state for next open
          this._updateVibLiveUI();
        }
      }
    }
  }

  _triggerVibration(metricLabel) {
    const vib = this.vibration;

    if (vib.hasHaptic) {
      try { navigator.vibrate([40, 30, 40]); } catch (e) { }
    }

    // Screen shake (skip if reduced motion)
    if (this._gameArea && !this.reducedMotion) {
      this._gameArea.classList.remove('vib-shake');
      void this._gameArea.offsetWidth;
      this._gameArea.classList.add('vib-shake');
      vib.shakeTimer = 0.15;
    }

    // On-canvas flash (always show — it's a brief opacity change, not motion)
    vib.flashAlpha = 1;
    vib.flashMetric = metricLabel || '';
  }

  // ============================================================
  // SESSION SUMMARY
  // ============================================================
  _showSessionSummary() {
    const sess = this.session;
    const overlay = document.getElementById('summaryOverlay');
    const grid = document.getElementById('summaryGrid');
    const bar = document.getElementById('summaryProsodyBar');

    // Format duration
    const mins = Math.floor(sess.duration / 60);
    const secs = Math.floor(sess.duration % 60);
    document.getElementById('summaryDuration').textContent =
      mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    // Build stats grid based on mode
    const stats = [];

    // Pitch stats (all modes)
    if (sess.pitchCount > 0) {
      const avgPitch = Math.round(sess.pitchSum / sess.pitchCount);
      const minP = sess.pitchMin === Infinity ? 0 : Math.round(sess.pitchMin);
      const maxP = Math.round(sess.pitchMax);
      stats.push({ value: `${avgPitch} Hz`, label: 'Avg Pitch' });
      stats.push({ value: `${minP}–${maxP}`, label: 'Pitch Range (Hz)' });
    } else {
      stats.push({ value: '—', label: 'Avg Pitch' });
      stats.push({ value: '—', label: 'Pitch Range' });
    }

    // Resonance (all modes)
    if (sess.resonanceCount > 0) {
      const avgRes = Math.round((sess.resonanceSum / sess.resonanceCount) * 100);
      stats.push({ value: `${avgRes}%`, label: 'Avg Resonance' });
    } else {
      stats.push({ value: '—', label: 'Avg Resonance' });
    }

    // Average prosody
    if (sess.prosodyHistory.length > 0) {
      const avgProsody = Math.round(
        (sess.prosodyHistory.reduce((a, b) => a + b, 0) / sess.prosodyHistory.length) * 100
      );
      stats.push({ value: `${avgProsody}%`, label: 'Avg Prosody' });
    } else {
      stats.push({ value: '—', label: 'Avg Prosody' });
    }

    // Mode-specific stat
    if (this.gameMode === 'ball') {
      const dist = Math.floor(this.scrollX / 50);
      stats.push({ value: `${dist}m`, label: 'Distance', wide: true });
    } else if (this.gameMode === 'garden') {
      const grown = this.garden.plants.length - sess.plantsAtStart;
      stats.push({ value: `${Math.max(0, grown)}`, label: 'Plants Grown', wide: true });
    } else if (this.gameMode === 'canvas') {
      const pct = Math.round((this.voiceCanvas.cursorX / this.voiceCanvas.bufferW) * 100);
      const strokes = this.voiceCanvas.strokeCount;
      stats.push({ value: `${pct}%`, label: 'Canvas Filled' });
      stats.push({ value: `${strokes}`, label: 'Strokes' });
    } else if (this.gameMode === 'keyboard') {
      stats.push({ value: `${this.keyboardGameMode.toUpperCase()}`, label: 'Keyboard Mode' });
      stats.push({ value: `${this.voiceKeyboard.score}`, label: 'Score' });
    } else if (this.gameMode === 'pilot') {
      stats.push({ value: `${this.pitchPilot.phase.toUpperCase()}`, label: 'Pilot Phase' });
      stats.push({ value: `${this.pitchPilot.score}`, label: 'Score' });
    } else if (this.gameMode === 'road') {
      const rr = this.resonanceRoad;
      stats.push({ value: `${rr.targetTone.toUpperCase()}`, label: 'Target Tone' });
      stats.push({ value: `${Math.round(rr.score)}`, label: 'Score' });
    } else if (this.gameMode === 'ascent') {
      const sa = this.spectralAscent;
      const dyn = Math.round((sa.diagnostics.dynamicMax - sa.diagnostics.dynamicMin) * 100);
      stats.push({ value: `${Math.round(sa.score)}`, label: 'Score' });
      stats.push({ value: `${Math.max(0, dyn)}%`, label: 'Dynamic Range' });
    } else if (this.gameMode === 'prism') {
      const pr = this.prismReader;
      const crystallized = pr.syllables.filter(s => s.state === 'crystallized');
      const total = pr.syllables.length;
      const scored = crystallized.filter(s => s.vowelScore > 0);
      const avgScore = scored.length > 0
        ? scored.reduce((sum, s) => sum + s.vowelScore, 0) / scored.length : 0;
      const strainCount = crystallized.filter(s => s.strainFlag).length;
      const elapsed = pr.firstOnsetTime > 0 ? (performance.now() - pr.firstOnsetTime) / 1000 : 0;
      const wpm = elapsed > 1 ? Math.round((pr.wordsCompleted || 0) / (elapsed / 60)) : 0;
      stats.push({ value: `${crystallized.length}/${total}`, label: 'Syllables Read' });
      stats.push({ value: `${wpm} wpm`, label: 'Reading Speed' });
      stats.push({ value: `${Math.round(avgScore * 100)}%`, label: 'Avg Vowel Score' });
      if (strainCount > 0) {
        stats.push({ value: `${strainCount}`, label: 'Strain Flags' });
      }
    } else if (this.gameMode === 'creature') {
      const stateMap = { blob: this.creature, jellyfish: this._jelly, phoenix: this._phoenix, nebula: this._nebula, spirit: this._spirit, koi: this._koi };
      const st = stateMap[this.creatureStyle] || this.creature;
      const tLevel = Math.round((st.transformLevel || 0) * 100);
      const styleName = this.creatureStyle.charAt(0).toUpperCase() + this.creatureStyle.slice(1);
      stats.push({ value: `${tLevel}%`, label: 'Peak Transform' });
      stats.push({ value: styleName, label: 'Style' });
    } else if (this.gameMode === 'vowelvalley') {
      stats.push({ value: `${this.vowelValley.score}`, label: 'Score' });
    }

    // Render stats grid
    grid.innerHTML = stats.map(s =>
      `<div class="summary-stat${s.wide ? ' wide' : ''}">
        <div class="summary-stat-value">${s.value}</div>
        <div class="summary-stat-label">${s.label}</div>
      </div>`
    ).join('');

    // Render prosody sparkline
    const history = sess.prosodyHistory;
    if (history.length > 2) {
      document.getElementById('summaryProsodyWrap').style.display = '';
      // Downsample to ~60 bars max
      const maxBars = 60;
      const step = Math.max(1, Math.floor(history.length / maxBars));
      const bars = [];
      for (let i = 0; i < history.length; i += step) {
        const slice = history.slice(i, i + step);
        bars.push(slice.reduce((a, b) => a + b, 0) / slice.length);
      }
      bar.innerHTML = bars.map(v => {
        const h = Math.max(2, v * 30);
        const hue = 220 + v * 80; // blue → purple as prosody increases
        return `<div class="bar-seg" style="height:${h}px;background:hsl(${hue},60%,${45 + v * 20}%)"></div>`;
      }).join('');
    } else {
      document.getElementById('summaryProsodyWrap').style.display = 'none';
    }

    overlay.classList.add('show');
  }

  renderTeleprompter(dt) {
    const overlay = document.getElementById('teleprompterOverlay');
    if (!overlay) return;
    if (this.gameMode === 'prism') {
      overlay.classList.remove('show');
      this.renderPrismOverlay(dt);
      return;
    }
    const roadMode = this.gameMode === 'road';
    const enabled = roadMode || this.teleprompterMode !== 'off';
    overlay.classList.toggle('show', enabled);
    if (!enabled) return;

    const sourceText = roadMode
      ? this._getResonanceRoadPassageText()
      : (this.teleprompterMode === 'custom' ? this.teleprompterCustomText : this.teleprompterRainbowText);
    const words = sourceText.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    if (this.isRunning && this.analyzer.metrics.energy > 0.03) {
      const rate = 2.5 + this.analyzer.metrics.tempo * 3.5;
      this.teleprompterIndex += dt * rate;
      if (this.teleprompterIndex >= words.length) this.teleprompterIndex = 0;
    }
    const active = Math.floor(this.teleprompterIndex);
    const start = Math.max(0, active - 8);
    const end = Math.min(words.length, active + 14);
    const view = [];
    for (let i = start; i < end; i++) {
      const cls = i === active ? 'active-word' : '';
      view.push(`<span class="${cls}">${escapeHtml(words[i])}</span>`);
    }
    overlay.innerHTML = view.join(' ');
  }

  updateMeters() {
    const m = this.analyzer.metrics;
    this._triggerMetricHighlight('articulation', 0.72);
    this._triggerMetricHighlight('vowel', 0.7);
    this._triggerMetricHighlight('bounce', 0.75);

    const set = (id, val) => {
      document.getElementById(id).style.width = (val * 100) + '%';
    };
    set('meterBounce', m.bounce);
    set('meterTempo', m.tempo);
    set('meterVowel', m.vowel);
    set('meterArtic', m.articulation);
    set('meterSyllable', m.syllable);

    // Pitch meter — position-based indicator (not fill width)
    // Map 80-300 Hz to 0-100% position on the gradient bar
    const hz = this.analyzer.smoothPitchHz;
    const pitchPos = pitchHzToPosition(hz, 80, 300);
    const pitchEl = document.getElementById('meterPitch');
    pitchEl.style.left = (pitchPos * 100) + '%';
    pitchEl.style.width = '3px';
    document.getElementById('valPitch').textContent =
      this.analyzer.lastPitch > 0 ? Math.round(hz) + ' Hz' : '— Hz';

    // Resonance meter — position-based indicator like pitch
    const res = this.analyzer.smoothResonance;
    const resEl = document.getElementById('meterResonance');
    resEl.style.left = (res * 100) + '%';
    resEl.style.width = '3px';
    // Show F1/F2/F3 Hz during voiced speech for method comparison
    const resConf = this.analyzer.formantConfidence;
    if (resConf > 0.2 && this.analyzer.metrics.energy > 0.05) {
      const f1 = Math.round(this.analyzer.smoothF1);
      const f2 = Math.round(this.analyzer.smoothF2);
      const f3 = Math.round(this.analyzer.smoothF3);
      document.getElementById('valResonance').textContent = `${f1}/${f2}/${f3}`;
    } else {
      document.getElementById('valResonance').textContent = '—';
    }

    document.getElementById('valBounce').textContent = this._meterLabel(m.bounce, 'Flat', 'Varied', 'Wild');
    document.getElementById('valTempo').textContent = this._meterLabel(m.tempo, 'Steady', 'Varied', 'Dynamic');
    document.getElementById('valVowel').textContent = this._meterLabel(m.vowel, 'Short', 'Held', 'Sustained');
    document.getElementById('valArtic').textContent = this._meterLabel(m.articulation, 'Soft', 'Clear', 'Crisp');
    document.getElementById('valSyllable').textContent = this._meterLabel(m.syllable, 'Quiet', 'Active', 'Rapid');

    const highlightMap = {
      bounce: document.querySelector('.meter-bounce .meter-label'),
      tempo: document.querySelector('.meter-tempo .meter-label'),
      vowel: document.querySelector('.meter-vowel .meter-label'),
      articulation: document.querySelector('.meter-artic .meter-label'),
      syllable: document.querySelector('.meter-syllable .meter-label'),
    };
    for (const [k, el] of Object.entries(highlightMap)) {
      this.metricHighlightTimers[k] = Math.max(0, this.metricHighlightTimers[k] - 1 / 60);
      if (el) el.classList.toggle('active-ping', this.metricHighlightTimers[k] > 0);
    }
    const mapSplatter = document.getElementById('mapSplatter');
    if (mapSplatter) mapSplatter.classList.toggle('active-ping', this.metricHighlightTimers.articulation > 0);
  }

  _meterLabel(val, low, mid, high) {
    const pct = Math.round(val * 100);
    if (pct <= 15) return `${pct}% · ${low}`;
    if (pct <= 55) return `${pct}% · ${mid}`;
    return `${pct}% · ${high}`;
  }

  // ============================================================
  // EXPANDED METRICS — History tracking & rendering
  // ============================================================

  _pushMetricHistory() {
    const m = this.analyzer.metrics;
    const h = this._metricHistory;
    const max = this._metricHistoryMax;

    h.pitch.push(this.analyzer.smoothPitchHz);
    h.resonance.push(this.analyzer.smoothResonance);
    h.bounce.push(m.bounce);
    h.tempo.push(m.tempo);
    h.vowels.push(m.vowel);
    h.artic.push(m.articulation);
    h.syllables.push(m.syllable);

    for (const k of Object.keys(h)) {
      const limit = (k === 'pitch' || k === 'bounce') ? this._metricHistoryMaxLong : max;
      if (h[k].length > limit) h[k].shift();
    }

    // Vowel scatter plot: collect F1/F2 points during voiced speech
    if (m.energy > 0.05 && this.analyzer.formantConfidence > 0.25 && this.analyzer.lastPitch > 0) {
      const f1 = this.analyzer.smoothF1;
      const f2 = this.analyzer.smoothF2;
      this._vowelPlotPoints.push({ x: f2, y: f1 });
      if (this._vowelPlotPoints.length > this._vowelPlotMax) this._vowelPlotPoints.shift();
    }

    // Syllable count histogram: count syllable impulses per second
    this._syllableCountTimer += 1 / 60;
    if (m.syllable > 0.5) this._syllableCountInWindow++;
    if (this._syllableCountTimer >= 1.0) {
      this._syllableCountHistory.push(this._syllableCountInWindow);
      if (this._syllableCountHistory.length > 30) this._syllableCountHistory.shift();
      this._syllableCountInWindow = 0;
      this._syllableCountTimer = 0;
    }
  }

  _sizeExpandedCanvases() {
    const ids = ['expCanvasPitch', 'expCanvasResonance', 'expCanvasBounce', 'expCanvasTempo',
                 'expCanvasVowels', 'expCanvasArtic', 'expCanvasSyllables'];
    for (const id of ids) {
      const c = document.getElementById(id);
      if (c) {
        const r = c.getBoundingClientRect();
        c.width = Math.round(r.width * devicePixelRatio);
        c.height = Math.round(r.height * devicePixelRatio);
      }
    }
  }

  _sizePopupCanvas() {
    const c = document.getElementById('metricPopupCanvas');
    if (c) {
      const r = c.getBoundingClientRect();
      c.width = Math.round(r.width * devicePixelRatio);
      c.height = Math.round(r.height * devicePixelRatio);
    }
  }

  _updateExpandedMetrics() {
    if (!this.metersExpanded && !this.metricPopupOpen) return;
    this._pushMetricHistory();

    const m = this.analyzer.metrics;
    const hz = this.analyzer.smoothPitchHz;
    const resConf = this.analyzer.formantConfidence;

    if (this.metersExpanded) {
      // Update expanded card values
      const pEl = document.getElementById('expValPitch');
      if (pEl) pEl.textContent = this.analyzer.lastPitch > 0 ? Math.round(hz) + ' Hz' : '— Hz';
      const rEl = document.getElementById('expValResonance');
      if (rEl) {
        if (resConf > 0.2 && m.energy > 0.05) {
          rEl.textContent = `Q ${Math.round(resConf * 100)}%`;
        } else {
          rEl.textContent = '—';
        }
      }
      const bEl = document.getElementById('expValBounce');
      if (bEl) bEl.textContent = Math.round(m.bounce * 100) + '%';
      const tEl = document.getElementById('expValTempo');
      if (tEl) tEl.textContent = Math.round(m.tempo * 100) + '%';
      const vEl = document.getElementById('expValVowels');
      if (vEl) vEl.textContent = Math.round(m.vowel * 100) + '%';
      const aEl = document.getElementById('expValArtic');
      if (aEl) aEl.textContent = Math.round(m.articulation * 100) + '%';
      const sEl = document.getElementById('expValSyllables');
      if (sEl) {
        const recent = this._syllableCountHistory;
        const spm = recent.length > 0 ? Math.round(recent[recent.length - 1] * 60) : 0;
        sEl.textContent = spm + '/min';
      }

      // Render each card canvas
      this._drawLineGraph('expCanvasPitch', this._metricHistory.pitch, '#c084fc', 60, 400, true);
      this._drawSpectrogram('expCanvasResonance');
      this._drawLineGraph('expCanvasBounce', this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
      this._drawTempoGauge('expCanvasTempo', m.tempo);
      this._drawVowelPlot('expCanvasVowels');
      this._drawAttackDecay('expCanvasArtic', this._metricHistory.artic);
      this._drawSyllableHistogram('expCanvasSyllables');
    }

    // Render popup if open
    if (this.metricPopupOpen) {
      this._renderPopupCanvas(this.metricPopupOpen);
      this._updatePopupValue(this.metricPopupOpen);
    }
  }

  // ---- Drawing helpers for expanded cards ----

  _drawLineGraph(canvasId, data, color, minVal, maxVal, isHz) {
    const c = document.getElementById(canvasId);
    if (!c || !data.length) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Data line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const range = maxVal - minVal || 1;
    const xMax = Math.max(data.length, 2) - 1;
    for (let i = 0; i < data.length; i++) {
      const x = (i / xMax) * w;
      const val = Math.max(minVal, Math.min(maxVal, data[i]));
      const y = h - ((val - minVal) / range) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Glow effect
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 6 * devicePixelRatio;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Current value label
    if (data.length > 0) {
      const last = data[data.length - 1];
      const lastY = h - ((Math.max(minVal, Math.min(maxVal, last)) - minVal) / range) * (h - 4) - 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(w - 2, lastY, 3 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawSpectrogram(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;

    // Shift existing content left by 1 column
    const imgData = ctx.getImageData(1, 0, w - 1, h);
    ctx.putImageData(imgData, 0, 0);

    // Draw new column on the right using frequency data
    const fData = this.analyzer.frequencyData;
    if (!fData || fData.length === 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(w - 1, 0, 1, h);
      return;
    }

    // Map frequency bins to vertical pixels (low freq at bottom)
    const binsToShow = Math.min(fData.length, 256); // focus on lower frequencies
    for (let y = 0; y < h; y++) {
      const binIdx = Math.floor(((h - y) / h) * binsToShow);
      const dbVal = fData[binIdx] || -100;
      // Map dB (-100 to 0) to intensity
      const intensity = Math.max(0, Math.min(1, (dbVal + 100) / 80));
      // Warm color map: black → blue → orange → gold
      const r = Math.round(intensity * intensity * 255);
      const g = Math.round(Math.pow(intensity, 3) * 200);
      const b = Math.round(intensity * 180);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(w - 1, y, 1, 1);
    }
  }

  _drawTempoGauge(canvasId, tempoVal) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h * 0.85;
    const radius = Math.min(w * 0.4, h * 0.7);
    const startAngle = Math.PI * 0.8;
    const endAngle = Math.PI * 0.2;
    const totalArc = Math.PI * 1.4;

    // Background arc
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 6 * devicePixelRatio;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, Math.PI * 2 + endAngle);
    ctx.stroke();

    // Value arc with gradient
    const angle = startAngle + totalArc * tempoVal;
    const grad = ctx.createLinearGradient(cx - radius, cy, cx + radius, cy);
    grad.addColorStop(0, '#4d96ff');
    grad.addColorStop(0.5, '#ffd93d');
    grad.addColorStop(1, '#ff6b6b');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 6 * devicePixelRatio;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, angle);
    ctx.stroke();

    // Needle
    const needleAngle = startAngle + totalArc * tempoVal;
    const nx = cx + Math.cos(needleAngle) * (radius - 8 * devicePixelRatio);
    const ny = cy + Math.sin(needleAngle) * (radius - 8 * devicePixelRatio);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(nx, ny, 4 * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();

    // Labels
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = `${9 * devicePixelRatio}px "Space Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('SLOW', cx - radius * 0.6, cy + 12 * devicePixelRatio);
    ctx.fillText('FAST', cx + radius * 0.6, cy + 12 * devicePixelRatio);
  }

  _drawVowelPlot(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();

    // Reference vowel positions (approximate F2, F1 in Hz)
    const vowels = [
      { label: 'EE', f2: 2300, f1: 300 },
      { label: 'AH', f2: 1100, f1: 800 },
      { label: 'OO', f2: 800, f1: 350 },
      { label: 'EH', f2: 1800, f1: 550 },
      { label: 'AW', f2: 900, f1: 600 },
    ];

    // F2 range: 600-2600, F1 range: 200-1000
    const mapF2 = f2 => ((f2 - 600) / 2000) * w;
    const mapF1 = f1 => ((f1 - 200) / 800) * h;

    // Reference labels
    ctx.font = `${8 * devicePixelRatio}px "Space Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (const v of vowels) {
      const vx = mapF2(v.f2);
      const vy = mapF1(v.f1);
      ctx.fillText(v.label, vx, vy);
    }

    // Scatter points
    const pts = this._vowelPlotPoints;
    for (let i = 0; i < pts.length; i++) {
      const alpha = 0.2 + (i / pts.length) * 0.6;
      const size = 2 + (i / pts.length) * 2;
      ctx.fillStyle = `rgba(107, 203, 119, ${alpha})`;
      ctx.beginPath();
      ctx.arc(mapF2(pts[i].x), mapF1(pts[i].y), size * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawAttackDecay(canvasId, data) {
    const c = document.getElementById(canvasId);
    if (!c || !data.length) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Attack/decay filled area
    const xMax = Math.max(data.length, 2) - 1;
    ctx.fillStyle = 'rgba(77, 150, 255, 0.15)';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < data.length; i++) {
      const x = (i / xMax) * w;
      const val = Math.max(0, Math.min(1, data[i]));
      const y = h - val * (h - 4) - 2;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(((data.length - 1) / xMax) * w, h);
    ctx.closePath();
    ctx.fill();

    // Line on top
    ctx.strokeStyle = '#4d96ff';
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / xMax) * w;
      const val = Math.max(0, Math.min(1, data[i]));
      const y = h - val * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  _drawSyllableHistogram(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    const data = this._syllableCountHistory;
    if (!data.length) return;

    const maxCount = Math.max(1, ...data);
    const barW = Math.max(4, (w / 30) - 2);
    const gap = 2;

    for (let i = 0; i < data.length; i++) {
      const barH = (data[i] / maxCount) * (h - 8);
      const x = i * (barW + gap);
      const y = h - barH - 2;
      const alpha = 0.4 + (i / data.length) * 0.6;
      ctx.fillStyle = `rgba(192, 132, 252, ${alpha})`;
      ctx.beginPath();
      // Rounded top
      const radius = Math.min(2, barW / 2);
      ctx.moveTo(x, y + radius);
      ctx.arcTo(x, y, x + barW, y, radius);
      ctx.arcTo(x + barW, y, x + barW, y + barH, radius);
      ctx.lineTo(x + barW, h - 2);
      ctx.lineTo(x, h - 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---- Metric Popup ----

  _openMetricPopup(metric) {
    this.metricPopupOpen = metric;
    const backdrop = document.getElementById('metricPopupBackdrop');
    const title = document.getElementById('metricPopupTitle');
    const desc = document.getElementById('metricPopupDesc');

    const descriptions = {
      pitch: 'Displays the current fundamental frequency (F0). The color-coded slider shows your position in the pitch range. The line graph shows pitch stability and range over time.',
      resonance: 'Shows a real-time spectrogram tracking formant frequencies (F1, F2). The "Q" value indicates the sharpness of the resonance filter (Harmonic Envelope).',
      bounce: 'A stylized wave graph measuring prosodic inflection or "melody" in speech. Higher values suggest more dynamic pitch variation rather than monotonic delivery.',
      tempo: 'Features a speed gauge measuring the pace of speech. Faster speech shows higher readings on the gauge.',
      vowels: 'A vowel space plot (F1 vs F2) showing the brightness or darkness of vowel sounds like "EE" and "AH." Tracks resonance shifts during articulation.',
      artic: 'Articulation module uses an Attack and Decay graph to measure the precision of consonant onsets and vowel offsets.',
      syllables: 'A bar histogram tracking the number of syllables spoken per minute, providing a granular look at speech density and pauses.',
    };

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      tempo: '#ffd93d', vowels: '#6bcb77', artic: '#4d96ff', syllables: '#c084fc',
    };

    title.textContent = metric.toUpperCase();
    title.style.color = colors[metric] || '#fff';
    desc.textContent = descriptions[metric] || '';

    backdrop.classList.add('show');
    // Allow layout, then size canvas
    requestAnimationFrame(() => this._sizePopupCanvas());
  }

  _closeMetricPopup() {
    this.metricPopupOpen = null;
    const backdrop = document.getElementById('metricPopupBackdrop');
    backdrop.classList.remove('show');
  }

  _updatePopupValue(metric) {
    const el = document.getElementById('metricPopupValue');
    if (!el) return;
    const m = this.analyzer.metrics;

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      tempo: '#ffd93d', vowels: '#6bcb77', artic: '#4d96ff', syllables: '#c084fc',
    };
    el.style.color = colors[metric] || '#fff';

    switch (metric) {
      case 'pitch':
        el.textContent = this.analyzer.lastPitch > 0 ? Math.round(this.analyzer.smoothPitchHz) + ' Hz' : '— Hz';
        break;
      case 'resonance':
        if (this.analyzer.formantConfidence > 0.2 && m.energy > 0.05) {
          const f1 = Math.round(this.analyzer.smoothF1);
          const f2 = Math.round(this.analyzer.smoothF2);
          el.textContent = `F1: ${f1} Hz  F2: ${f2} Hz`;
        } else {
          el.textContent = '—';
        }
        break;
      case 'bounce': el.textContent = Math.round(m.bounce * 100) + '%'; break;
      case 'tempo': el.textContent = Math.round(m.tempo * 100) + '%'; break;
      case 'vowels': el.textContent = Math.round(m.vowel * 100) + '%'; break;
      case 'artic': el.textContent = Math.round(m.articulation * 100) + '%'; break;
      case 'syllables': {
        const recent = this._syllableCountHistory;
        const spm = recent.length > 0 ? Math.round(recent[recent.length - 1] * 60) : 0;
        el.textContent = spm + ' syl/min';
        break;
      }
    }
  }

  _renderPopupCanvas(metric) {
    const canvasId = 'metricPopupCanvas';
    switch (metric) {
      case 'pitch':
        this._drawLineGraph(canvasId, this._metricHistory.pitch, '#c084fc', 60, 400, true);
        break;
      case 'resonance':
        this._drawSpectrogram(canvasId);
        break;
      case 'bounce':
        this._drawLineGraph(canvasId, this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
        break;
      case 'tempo':
        this._drawTempoGauge(canvasId, this.analyzer.metrics.tempo);
        break;
      case 'vowels':
        this._drawVowelPlot(canvasId);
        break;
      case 'artic':
        this._drawAttackDecay(canvasId, this._metricHistory.artic);
        break;
      case 'syllables':
        this._drawSyllableHistogram(canvasId);
        break;
    }
  }

  // ============================================================
  // VOWEL VALLEY — Update
  // ============================================================
  updateVowelValley(dt) {
    const s = this.vowelValley;
    const f1 = this.analyzer.smoothF1;
    const f2 = this.analyzer.smoothF2;
    const energy = this.analyzer.metrics.energy;
    const conf = this.analyzer.formantConfidence;

    // 1. Map F1/F2 to normalized 0-1 coordinates with smoothing
    if (energy > 0.05 && conf > 0.2) {
      // Horizontal (F2): 600Hz (Left) to 2600Hz (Right)
      const targetX = Math.max(0, Math.min(1, (f2 - s.f2Range[0]) / (s.f2Range[1] - s.f2Range[0])));
      // Vertical (F1): 1000Hz (Bottom) to 250 Hz (Top) - Inverted for "natural" feel
      const targetY = Math.max(0, Math.min(1, 1 - (f1 - s.f1Range[0]) / (s.f1Range[1] - s.f1Range[0])));

      s.smoothX += (targetX - s.smoothX) * 0.15;
      s.smoothY += (targetY - s.smoothY) * 0.15;
    }

    s.x = s.smoothX;
    s.y = s.smoothY;

    // 2. Flow and Multiplier Logic
    s.flowTimer += dt;
    if (s.flowTimer > 3.0) {
      s.flowMultiplier = 1;
    }

    // 3. Check collisions with target zones
    let inAnyZone = false;
    for (const t of s.targets) {
      // Map target F1/F2 to normalized space
      const tx = (t.f2 - s.f2Range[0]) / (s.f2Range[1] - s.f2Range[0]);
      const ty = 1 - (t.f1 - s.f1Range[0]) / (s.f1Range[1] - s.f1Range[0]);

      const dx = s.x - tx;
      const dy = s.y - ty;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 0.15 && energy > 0.1 && conf > 0.3) {
        t.active = true;
        t.charge = Math.min(1, t.charge + dt * 1.5);
        inAnyZone = true;

        if (t.charge >= 1) {
          // Flow logic: Different target hit quickly
          if (s.lastTargetHit && s.lastTargetHit !== t.name && s.flowTimer < 2.0) {
            s.flowMultiplier = Math.min(4, s.flowMultiplier + 1);
            s.popups.push({
              x: tx * this.width, y: ty * this.height - 40,
              text: `FLOW x${s.flowMultiplier}`, life: 1.0, color: '#fff'
            });
          }

          s.score += 10 * s.flowMultiplier;
          t.charge = 0;
          s.lastTargetHit = t.name;
          s.flowTimer = 0;

          // Spawn "score" particles
          for (let i = 0; i < 8; i++) {
            const ang = Math.random() * Math.PI * 2;
            s.particles.push({
              x: tx * this.width, y: ty * this.height,
              vx: Math.cos(ang) * 150, vy: Math.sin(ang) * 150,
              life: 0.6, color: t.color, size: 4
            });
          }
        }
      } else {
        t.active = false;
        t.charge = Math.max(0, t.charge - dt * 0.5);
      }
    }

    // 4. Update Trail
    if (energy > 0.05) {
      s.trail.push({
        x: s.x * this.width, y: s.y * this.height,
        life: 1.0,
        flow: s.flowMultiplier
      });
    }
    for (let i = s.trail.length - 1; i >= 0; i--) {
      s.trail[i].life -= dt * 1.2;
      if (s.trail[i].life <= 0) s.trail.splice(i, 1);
    }

    // 5. Update Popups
    for (let i = s.popups.length - 1; i >= 0; i--) {
      const p = s.popups[i];
      p.y -= dt * 40;
      p.life -= dt;
      if (p.life <= 0) s.popups.splice(i, 1);
    }

    // 6. Update particles
    for (let i = s.particles.length - 1; i >= 0; i--) {
      const p = s.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) s.particles.splice(i, 1);
    }
  }

  // ============================================================
  // VOWEL VALLEY — Draw
  // ============================================================
  drawVowelValleyScene(prosodyGlow) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const s = this.vowelValley;

    // 1. Background
    ctx.fillStyle = '#050510';
    ctx.fillRect(0, 0, w, h);

    // 2. Grid
    ctx.strokeStyle = `rgba(255,255,255,${s.gridAlpha})`;
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      ctx.beginPath();
      ctx.moveTo(i * w / 10, 0); ctx.lineTo(i * w / 10, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * h / 10); ctx.lineTo(w, i * h / 10);
      ctx.stroke();
    }

    // 3. Draw Target Zones
    ctx.font = 'bold 16px "Space Mono", monospace';
    ctx.textAlign = 'center';
    for (const t of s.targets) {
      const tx = (t.f2 - s.f2Range[0]) / (s.f2Range[1] - s.f2Range[0]) * w;
      const ty = (1 - (t.f1 - s.f1Range[0]) / (s.f1Range[1] - s.f1Range[0])) * h;

      // Outer glow
      const grad = ctx.createRadialGradient(tx, ty, 20, tx, ty, 60);
      grad.addColorStop(0, t.color + (t.active ? '66' : '22'));
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(tx, ty, 60, 0, Math.PI * 2);
      ctx.fill();

      // Core
      ctx.fillStyle = t.color;
      ctx.globalAlpha = 0.3 + t.charge * 0.7;
      ctx.beginPath();
      ctx.arc(tx, ty, 15 + t.charge * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Label
      ctx.fillStyle = '#fff';
      ctx.fillText(t.name, tx, ty - 70);

      // Progress ring
      if (t.charge > 0) {
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(tx, ty, 25, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * t.charge));
        ctx.stroke();
      }
    }

    // 4. Draw Trail
    ctx.lineWidth = 2;
    for (let i = 1; i < s.trail.length; i++) {
      const p1 = s.trail[i - 1];
      const p2 = s.trail[i];
      const alpha = p2.life * 0.5;
      ctx.strokeStyle = `hsla(${200 + p2.flow * 40}, 80%, 70%, ${alpha})`;
      ctx.lineWidth = 2 + p2.flow * 1.5;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    // 5. Draw Particles
    for (const p of s.particles) {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life / 0.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 6. Draw Popups
    ctx.font = 'bold 20px "Outfit", sans-serif';
    for (const p of s.popups) {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    // 7. Draw Character (Vocal Spark)
    const cx = s.x * w;
    const cy = s.y * h;

    // Character glow
    const charGlow = ctx.createRadialGradient(cx, cy, 5, cx, cy, 30 + prosodyGlow * 20 + s.flowMultiplier * 10);
    charGlow.addColorStop(0, '#fff');
    charGlow.addColorStop(0.3, this.getBallColor(0.6));
    charGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = charGlow;
    ctx.beginPath();
    ctx.arc(cx, cy, 30 + prosodyGlow * 20 + s.flowMultiplier * 10, 0, Math.PI * 2);
    ctx.fill();

    // Character core
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();

    // 8. Score HUD
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '700 24px "Outfit", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`SCORE: ${s.score}`, 20, 40);

    if (s.flowMultiplier > 1) {
      ctx.fillStyle = '#6bcb77';
      ctx.fillText(`FLOW x${s.flowMultiplier}`, 20, 75);
    }
  }
}

// Initialize if in main UI, export for testing harness
export const game = document.getElementById('app') ? new VoxBallGame() : null;
